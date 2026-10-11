#!/usr/bin/env node
// Server-side surface benchmarks.
//
// Records the phase 1 baseline for the five scriptable surfaces: dashboard
// payload, movies page N, shows page N, stats, and a full cache rebuild. These
// run in-process against the data layer rather than over HTTP, so what they
// measure is the server-side work rather than the network, and they are
// repeatable without a browser. The frontend first-paint baseline is test 1's
// browser protocol and deliberately is not here.
//
// This script makes no database writes of its own. The cache-rebuild surface
// exploits the fact that a fresh process starts with empty derived caches, so
// the first read of each one is a full rebuild; it never bumps a version to
// force a miss. Loading the data layer does start its usual background show
// progress cache, which writes its own file inside the data directory, which
// is one more reason to point this at a disposable library.
//
// Usage:
//   node scripts/benchmark-surfaces.js --data-dir <path> [--runs 5] [--output docs/benchmarks/<file>.json]
//
// --data-dir must hold a synthetic library (see generate-synthetic-library.js).
// Pass --allow-unmarked to benchmark a directory this project did not generate;
// it is read-only either way, but the marker is what proves the scale a number
// was taken at, and a number without its workload is not a measurement.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const EXPLORER_PAGE_SIZE = 240;
const DASHBOARD_PREVIEW_LIMIT = 120;
const SPREAD_RULE_FLOOR_MS = 50;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args[name] = true; continue; }
    args[name] = next;
    i += 1;
  }
  return args;
}

// Test 1's spread rule, applied per metric and only above a 50ms floor.
// Percentages of a 20ms quantity measure timer jitter, not instability, so a
// metric under the floor reports its numbers without a verdict.
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const round = (value) => Math.round(value * 1000) / 1000;
  const applies = median >= SPREAD_RULE_FLOOR_MS;
  const spreadPercent = median > 0 ? ((max - min) / median) * 100 : 0;
  return {
    runs: samples.length,
    medianMs: round(median),
    minMs: round(min),
    maxMs: round(max),
    spreadPercent: round(spreadPercent),
    spreadRule: applies ? (spreadPercent <= 20 ? "pass" : "fail") : "below-50ms-floor",
  };
}

async function measure(label, runs, task) {
  const samples = [];
  let payloadBytes = null;
  let items = null;
  let resultHash = null;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const result = await task();
    samples.push(performance.now() - started);
    if (run === runs - 1) {
      const serialized = JSON.stringify(result ?? null);
      payloadBytes = Buffer.byteLength(serialized);
      resultHash = createHash("sha256").update(serialized).digest("hex");
      items = Array.isArray(result) ? result.length
        : Array.isArray(result?.rows) ? result.rows.length
          : Array.isArray(result?.items) ? result.items.length
            : null;
    }
  }
  return { surface: label, ...summarize(samples), payloadBytes, items, resultHash };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDirArg = args["data-dir"];
  if (!dataDirArg || dataDirArg === true) {
    console.error("--data-dir <path> is required, and should point at a library from generate-synthetic-library.js.");
    process.exitCode = 1;
    return;
  }
  const dataDir = path.resolve(String(dataDirArg));
  const markerPath = path.join(dataDir, "synthetic-library.json");
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : null;
  if (!marker && !args["allow-unmarked"]) {
    console.error(`${dataDir} has no synthetic-library.json marker. Generate one, or pass --allow-unmarked to record a number without its scale.`);
    process.exitCode = 1;
    return;
  }
  const runs = Math.max(1, Number(args.runs === undefined || args.runs === true ? 5 : args.runs));

  process.env.DATA_DIR = dataDir;
  const { db } = await import("../server/src/db.js");
  const dataRepo = await import("../server/src/utils/dataRepo.js");
  const { cacheRebuildTelemetry, recordCacheRebuild, resetCacheRebuildTelemetry } = await import("../server/src/utils/cacheTelemetry.js");

  const startedAt = Date.now();

  // Surface 5 first, and once only: this process has never read a derived
  // cache, so each first read below is a genuine cold rebuild. Doing it later
  // would measure a cache hit.
  const coldRebuildStarted = performance.now();
  await dataRepo.getCachedHistory();
  await dataRepo.getCachedMovies();
  await dataRepo.getCachedShows();
  await dataRepo.getCachedShows({ includeScheduledLibraryHistory: true });
  await dataRepo.getWatchStats();
  const fullCacheRebuildMs = performance.now() - coldRebuildStarted;
  const rebuildTelemetry = cacheRebuildTelemetry();

  // Record the materialized history size so reports prove whether the fixture
  // crossed the old 25,000-row ceiling. The cache and Stats are both uncapped;
  // MAX_HISTORY_LIMIT remains only an API pagination safety bound.
  const historyCacheRows = (await dataRepo.getCachedHistory()).length;

  const surfaces = [];
  surfaces.push(await measure("dashboard-payload", runs, () => dataRepo.queryWatchHistoryPreview({ limit: DASHBOARD_PREVIEW_LIMIT })));
  // A warm read. The cold stats rebuild is in fullCacheRebuild.perCache; this
  // is what a second visitor pays while the generation has not moved.
  surfaces.push(await measure("stats-cached-read", runs, () => dataRepo.getWatchStats()));
  for (const page of [1, 5, 10]) {
    const offset = (page - 1) * EXPLORER_PAGE_SIZE;
    surfaces.push(await measure(`history-page-${page}`, runs, () => dataRepo.queryWatchHistory({
      limit: EXPLORER_PAGE_SIZE,
      offset,
      dedupe: false,
    })));
    surfaces.push(await measure(`movies-page-${page}`, runs, () => dataRepo.queryMovies({ limit: EXPLORER_PAGE_SIZE, offset })));
    surfaces.push(await measure(`shows-page-${page}`, runs, () => dataRepo.queryShows({ limit: EXPLORER_PAGE_SIZE, offset })));
  }

  // Instrumentation overhead. The counters cost one timestamp pair plus a map
  // update per rebuild, never per row, so the question is what that costs at
  // the highest churn rate anyone has measured. Test 5 part 1's worst window
  // was an import at 1,150 version bumps per minute; even if every one of those
  // forced a rebuild, the answer is this per-call cost times 1,150.
  const OVERHEAD_ITERATIONS = 200_000;
  const overheadStarted = performance.now();
  for (let i = 0; i < OVERHEAD_ITERATIONS; i += 1) {
    recordCacheRebuild("overhead-probe", { version: i, trigger: "overhead-probe", durationMs: 0.5 });
  }
  const overheadPerCallNs = ((performance.now() - overheadStarted) * 1e6) / OVERHEAD_ITERATIONS;
  resetCacheRebuildTelemetry();

  const counts = {
    watchHistoryRows: db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n,
    distinctMovies: db.prepare("SELECT COUNT(DISTINCT media_key) AS n FROM watch_history WHERE media_type = 'movie'").get().n,
    distinctEpisodes: db.prepare("SELECT COUNT(DISTINCT media_key) AS n FROM watch_history WHERE media_type = 'episode'").get().n,
    distinctShows: db.prepare("SELECT COUNT(DISTINCT show_title_lower) AS n FROM watch_history WHERE show_title_lower IS NOT NULL").get().n,
    tmdbCacheRows: db.prepare("SELECT COUNT(*) AS n FROM tmdb_metadata_cache").get().n,
  };

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    workload: {
      dataDir,
      runsPerSurface: runs,
      explorerPageSize: EXPLORER_PAGE_SIZE,
      dashboardPreviewLimit: DASHBOARD_PREVIEW_LIMIT,
      library: marker ? { generatedAt: marker.generatedAt, parameters: marker.parameters, counts: marker.counts } : null,
      observedCounts: counts,
      historyCache: {
        rows: historyCacheRows,
        capped: false,
        oldCeilingCrossed: historyCacheRows > 25000,
        note: "getCachedHistory() and Stats are uncapped. MAX_HISTORY_LIMIT remains an API pagination safety bound only.",
      },
      databaseBytes: ["plembfin.db", "plekt.db"].map((name) => path.join(dataDir, name)).filter((file) => fs.existsSync(file)).map((file) => fs.statSync(file).size)[0] ?? null,
    },
    hardware: {
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model || "unknown",
      cores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    fullCacheRebuild: {
      // One cold pass. Repeating it in this process would measure cache hits,
      // and forcing a miss would mean writing to the database.
      runs: 1,
      totalMs: Math.round(fullCacheRebuildMs * 1000) / 1000,
      perCache: rebuildTelemetry.caches.map((entry) => ({
        cache: entry.cache,
        rebuilds: entry.rebuilds,
        totalMs: entry.totalMs,
        trigger: entry.lastTrigger,
      })),
    },
    instrumentationOverhead: {
      probe: "recordCacheRebuild",
      iterations: OVERHEAD_ITERATIONS,
      perCallNs: Math.round(overheadPerCallNs * 1000) / 1000,
      atWorstMeasuredChurnMsPerMinute: Math.round((overheadPerCallNs * 1150) / 1e6 * 1000) / 1000,
      note: "1,150 rebuilds per minute is test 5 part 1's worst measured window (an import), used here as an upper bound.",
    },
    surfaces,
  };

  const output = String(args.output && args.output !== true ? args.output : "docs/benchmarks/surfaces.json");
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const surface of report.surfaces) {
    console.log(`${surface.surface.padEnd(20)} ${String(surface.medianMs).padStart(10)}ms  [${surface.minMs}-${surface.maxMs}]  ${surface.spreadPercent}%  ${surface.spreadRule}  ${surface.payloadBytes} bytes`);
  }
  console.log(`${"full-cache-rebuild".padEnd(20)} ${String(report.fullCacheRebuild.totalMs).padStart(10)}ms  (cold, one pass)`);
  console.log(`\nWrote ${outputPath}`);
  // The data layer keeps a background show-progress rebuild alive; exit rather
  // than close the database out from under it and log a spurious failure.
  process.exit(0);
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
