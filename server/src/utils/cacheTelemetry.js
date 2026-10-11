// Derived-cache rebuild telemetry.
//
// The five history-derived caches in dataRepo.js (history, movies, shows,
// scheduled shows, stats) rebuild whenever the shared data version moves. A
// version bump on its own is free; what costs is a bump that invalidates a
// cache which is then read, forcing a full rebuild. Counting bumps therefore
// cannot tell an expensive invalidation from a free one, which is why this
// records the rebuild itself: which cache, how long it took, and which
// generation change it was for.
//
// Set PLEKT_DEBUG_CACHE_REBUILDS=1 to log one line per rebuild (visible in
// Settings → Logs via the diagnostic logger), in the same style as
// PLEKT_DEBUG_OUTBOUND. The counters below are always collected: they cost
// one timestamp pair per rebuild, never per row.

import { brandEnv } from "./brandEnv.js";

const DEBUG_CACHE_REBUILDS = ["1", "true"].includes(String(brandEnv("DEBUG_CACHE_REBUILDS") || "").toLowerCase());

const RECENT_REBUILD_LIMIT = 200;

const counters = new Map();
const recent = [];
let startedAt = Date.now();

function counterFor(cache) {
  let entry = counters.get(cache);
  if (!entry) {
    entry = { cache, rebuilds: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastVersion: null, lastTrigger: null, byTrigger: new Map() };
    counters.set(cache, entry);
  }
  return entry;
}

export function recordCacheRebuild(cache, { version = null, trigger = "observed", durationMs = 0, items = null } = {}) {
  const entry = counterFor(String(cache));
  const ms = Math.max(0, Number(durationMs) || 0);
  entry.rebuilds += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  entry.lastMs = ms;
  entry.lastVersion = version;
  entry.lastTrigger = trigger;
  const perTrigger = entry.byTrigger.get(trigger) || { rebuilds: 0, totalMs: 0 };
  perTrigger.rebuilds += 1;
  perTrigger.totalMs += ms;
  entry.byTrigger.set(trigger, perTrigger);

  recent.push({ at: Date.now(), cache: entry.cache, version, trigger, durationMs: Math.round(ms * 1000) / 1000, items });
  if (recent.length > RECENT_REBUILD_LIMIT) recent.splice(0, recent.length - RECENT_REBUILD_LIMIT);

  if (DEBUG_CACHE_REBUILDS) {
    const itemNote = Number.isFinite(items) ? ` items=${items}` : "";
    console.log(`[cache-rebuild] cache=${entry.cache} version=${version ?? "?"} trigger=${trigger} ms=${ms.toFixed(2)}${itemNote}`);
  }
  return entry;
}

// Wrap a synchronous rebuild. The timer is around the rebuild only, so a cache
// hit costs nothing at all.
export function timeCacheRebuild(cache, version, trigger, build) {
  const started = performance.now();
  const result = build();
  recordCacheRebuild(cache, {
    version,
    trigger,
    durationMs: performance.now() - started,
    items: Array.isArray(result) ? result.length : null,
  });
  return result;
}

export async function timeCacheRebuildAsync(cache, version, trigger, build) {
  const started = performance.now();
  const result = await build();
  recordCacheRebuild(cache, {
    version,
    trigger,
    durationMs: performance.now() - started,
    items: Array.isArray(result) ? result.length : null,
  });
  return result;
}

export function cacheRebuildTelemetry() {
  const caches = [...counters.values()]
    .map((entry) => ({
      cache: entry.cache,
      rebuilds: entry.rebuilds,
      totalMs: Math.round(entry.totalMs * 1000) / 1000,
      maxMs: Math.round(entry.maxMs * 1000) / 1000,
      meanMs: entry.rebuilds ? Math.round((entry.totalMs / entry.rebuilds) * 1000) / 1000 : 0,
      lastMs: Math.round(entry.lastMs * 1000) / 1000,
      lastVersion: entry.lastVersion,
      lastTrigger: entry.lastTrigger,
      byTrigger: [...entry.byTrigger.entries()]
        .map(([trigger, value]) => ({ trigger, rebuilds: value.rebuilds, totalMs: Math.round(value.totalMs * 1000) / 1000 }))
        .sort((a, b) => b.totalMs - a.totalMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  return {
    since: new Date(startedAt).toISOString(),
    observedForMs: Date.now() - startedAt,
    totalRebuilds: caches.reduce((sum, entry) => sum + entry.rebuilds, 0),
    totalRebuildMs: Math.round(caches.reduce((sum, entry) => sum + entry.totalMs, 0) * 1000) / 1000,
    caches,
    recent: [...recent],
  };
}

export function resetCacheRebuildTelemetry() {
  counters.clear();
  recent.length = 0;
  startedAt = Date.now();
}

export function cacheRebuildDebugEnabled() {
  return DEBUG_CACHE_REBUILDS;
}
