import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-up-next-build-attribution-");

const { bumpDataVersion, bumpUpNextVersion, db, getDataVersion } = await import("../server/src/db.js");
const { saveMediaConfig, loadMediaConfig } = await import("../server/src/utils/configStore.js");
const { getUpNextCacheSnapshot, refreshUpNextAfterMutation } = await import("../server/src/utils/upNextCache.js");
const { runAutomaticUpNextSync } = await import("../server/src/utils/upNextAutoSync.js");
const { formatUpNextBuildSummary } = await import("../server/src/utils/upNextService.js");

// Step 2 of plan/archive/up-next-build-speed/summary.md: every build decision is logged with the
// caller that asked for it, so a second build near a queue change can be
// attributed (dashboard read, auto-sync, provider echo) instead of guessed at.
function captureLog(t) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.error = () => {};
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });
  return lines;
}

const count = (lines, kind) => lines.filter((line) => line.startsWith(`Up Next build ${kind}:`)).length;
const cardItem = { id: "movie:attr-1", media_key: "movie:attr-1", media_type: "movie", title: "Attribution", provider_items: {} };

test("the build summary line names its trigger and keeps the old format without one", () => {
  const stats = { itemLive: 1, itemCached: 2, itemOverBudget: 0, inventoryFetched: 0, inventoryCached: 3 };
  assert.equal(
    formatUpNextBuildSummary(stats, 1, 1500, "auto-sync after push; snapshot out of date"),
    "Up Next build [auto-sync after push; snapshot out of date]: 1 item in 1.5s; library lookups 1 live, 2 cached, 0 over budget; series inventories 0 fetched, 3 cached.",
  );
  assert.match(formatUpNextBuildSummary(stats, 2, 0), /^Up Next build: 2 items in 0\.0s;/);
});

test("simultaneous readers of one generation share a single attributed build", async (t) => {
  const lines = captureLog(t);
  bumpDataVersion("test: webhook echo");
  let builds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const build = async (ctx) => {
    builds += 1;
    assert.match(ctx.trigger, /^dashboard/, "the build receives the label of the caller that started it");
    await gate;
    return { items: [cardItem], sourceStatus: [] };
  };
  const dashboard = getUpNextCacheSnapshot(build, { trigger: "dashboard", refresh: true });
  const autoSync = getUpNextCacheSnapshot(build, { trigger: "auto-sync before push", refresh: true });
  const mutation = getUpNextCacheSnapshot(build, { trigger: "mutation x", refresh: true });
  release();
  await Promise.all([dashboard, autoSync, mutation]);
  assert.equal(builds, 1, "three readers of one generation cost one build");
  assert.equal(count(lines, "started"), 1);
  assert.equal(count(lines, "joined"), 2);
  assert.ok(lines.some((line) => line.includes("started: dashboard; explicit refresh")));
  assert.ok(lines.some((line) => line.includes("joined: auto-sync before push; explicit refresh; shares dashboard")));
});

test("a write during a build is chained as one follow-up build and attributed to the write", async (t) => {
  const lines = captureLog(t);
  let builds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const build = async () => {
    builds += 1;
    if (builds === 1) {
      signalStarted();
      await gate;
    }
    return { items: [cardItem], sourceStatus: [] };
  };
  await getUpNextCacheSnapshot(async () => ({ items: [cardItem], sourceStatus: [] }), { trigger: "seed", refresh: true });
  lines.length = 0;

  bumpDataVersion("test: provider echo");
  const first = getUpNextCacheSnapshot(build, { trigger: "dashboard" });
  await started;
  bumpUpNextVersion();
  const second = getUpNextCacheSnapshot(build, { trigger: "auto-sync after push" });
  release();
  await Promise.all([first, second]);

  assert.equal(builds, 2, "one build for the first generation and one follow-up for the second");
  assert.equal(count(lines, "started"), 2);
  assert.equal(count(lines, "chained"), 1);
  assert.ok(
    lines.some((line) => line.includes("started: dashboard; snapshot out of date; history v") && line.includes("(test: provider echo)")),
    "the history generation names the write that moved it",
  );
  assert.ok(lines.some((line) => line.includes("chained: auto-sync after push")));
  builds = 0;
  await getUpNextCacheSnapshot(build, { trigger: "dashboard" });
  assert.equal(builds, 0, "once both generations are stored the snapshot is current");
});

test("a queue mutation followed by the automatic sync costs exactly one build", async (t) => {
  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const lines = captureLog(t);
  const config = await loadMediaConfig();

  await refreshUpNextAfterMutation(config, "Remove from Up Next");
  assert.equal(count(lines, "started"), 1);
  assert.equal(lines.filter((line) => line.startsWith("Up Next build [mutation Remove from Up Next]:")).length, 1, "the production summary names the mutation");

  const sync = await runAutomaticUpNextSync();
  assert.ok(["unchanged", "succeeded", "partial"].includes(sync.status), `unexpected status ${sync.status}`);
  assert.equal(count(lines, "started"), 1, "the automatic sync that follows the mutation reads the stored snapshot and does not build");
  assert.equal(lines.filter((line) => line.startsWith("Up Next build [")).length, 1, "one summary line for the whole sequence");
});

// Live finding (5 November 2026): a canonical write just before a removal's
// build was read by the build but not yet adopted by the lagging in-process
// version poll, so the snapshot was stamped older than the data it held and the
// auto-sync built it again about a second later.
test("a write just before a build does not make the stored snapshot look out of date", async (t) => {
  const lines = captureLog(t);
  getDataVersion();
  // What a database trigger does for a playstate write from the Emby echo.
  db.prepare("UPDATE cache_versions SET version = version + 1 WHERE id = 'history'").run();
  let builds = 0;
  const build = async () => {
    builds += 1;
    return { items: [cardItem], sourceStatus: [] };
  };
  await getUpNextCacheSnapshot(build, { trigger: "mutation x", refresh: true });
  assert.equal(builds, 1);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const reader = await getUpNextCacheSnapshot(build, { trigger: "auto-sync before push" });
  assert.equal(builds, 1, "the reader after the poll window finds the snapshot current and builds nothing");
  assert.equal(reader.stale, false);
  assert.equal(count(lines, "started"), 1);
});

// Live finding (5 November 2026): a push whose own provider echoes moved the
// history generation was never remembered ("stale"), so the identical queue was
// pushed a second time and cost a second build after that push. When the
// rebuilt queue matches the one just pushed the push was not stale after all.
test("a push disturbed only by its own echo is remembered, so the identical queue is not pushed again", async (t) => {
  const { rememberUpNextSync } = await import("../server/src/utils/upNextAutoSync.js");
  const { upsertPlaybackProgress } = await import("../server/src/utils/dataRepo.js");
  const originalFetch = globalThis.fetch;
  let pushCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("emby.test") && !String(input).includes("/Items?")) pushCalls += 1;
    return new Response(JSON.stringify({ Items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  captureLog(t);
  upsertPlaybackProgress({
    media_key: "movie:tmdb:880001", media_type: "movie", title: "Echo Movie",
    position_ms: 300000, duration_ms: 1200000, progress: 25,
  });
  await rememberUpNextSync([{ id: "movie:something-else", media_type: "movie", title: "Something Else" }]);

  // The echo of an earlier write lands between the queue read and the push.
  let cancelChecks = 0;
  const first = await runAutomaticUpNextSync({
    isCancelled: async () => {
      cancelChecks += 1;
      if (cancelChecks === 2) bumpDataVersion("test: provider echo before push");
      return false;
    },
  });
  assert.equal(first.itemCount, 1, "the queue holds the resume card");
  assert.equal(first.rerun, false, "the rebuilt queue matches the pushed one");
  const second = await runAutomaticUpNextSync();
  assert.equal(second.status, "unchanged", "the identical queue is not pushed a second time");
});
