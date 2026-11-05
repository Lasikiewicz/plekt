import test from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "../server/src/utils/scheduledConcurrency.js";
import { findEmbyItems, __resetEmbySeriesCache, __setEmbySeriesCacheNow } from "../server/src/utils/embyClient.js";
import { collectServerWatchedItems } from "../server/src/utils/forceSyncPlanner.js";

test("cancelled Force Sync preview rejects instead of returning an executable collection", async () => {
  const config = { emby: { baseUrl: "https://emby-cancel.test", apiKey: "key", userId: "user" } };
  let cancelled = false;
  await assert.rejects(collectServerWatchedItems(config, {
    isCancelled: async () => cancelled,
    clients: { fetchEmbyWatchedItems: async (_config, options) => {
      cancelled = true;
      assert.equal(await options.isCancelled(), true);
      throw new Error("Emby scan cancelled.");
    } },
  }), /preview cancelled/);
});

test("Force Sync worker pool processes each key once with bounded parallelism", async () => {
  const keys = Array.from({ length: 31 }, (_, index) => `key-${index}`);
  const handled = [];
  let active = 0, peak = 0;
  await runWithConcurrency(keys, 4, async key => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    handled.push(key);
    active--;
  });
  assert.equal(peak, 4);
  assert.deepEqual(handled.sort(), keys.sort());
});

test("Emby movie misses expire quickly and do not cache failures", async t => {
  const originalFetch = globalThis.fetch;
  __resetEmbySeriesCache();
  t.after(() => { globalThis.fetch = originalFetch; __resetEmbySeriesCache(); });
  let now = 1000, calls = 0, fail = false;
  __setEmbySeriesCacheNow(() => now);
  globalThis.fetch = async () => {
    calls++;
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ Items: [] }), { status: 200 });
  };
  const config = { baseUrl: "https://emby-speed.test", apiKey: "key", userId: "user" };
  const media = { type: "movie", title: "Missing Film (2026)", ids: { imdb: "tt123" } };
  assert.deepEqual(await findEmbyItems(config, media), []);
  const firstCalls = calls;
  assert.deepEqual(await findEmbyItems(config, media), []);
  assert.equal(calls, firstCalls);
  now += 30_001;
  await findEmbyItems(config, media);
  assert.ok(calls > firstCalls);
  __resetEmbySeriesCache();
  fail = true;
  await assert.rejects(findEmbyItems(config, media), /Upstream request failed/);
  const failedCalls = calls;
  fail = false;
  await findEmbyItems(config, media);
  assert.ok(calls > failedCalls);
});

test("a partial Emby provider failure cannot become a cached movie miss", async t => {
  const originalFetch = globalThis.fetch;
  __resetEmbySeriesCache();
  t.after(() => { globalThis.fetch = originalFetch; __resetEmbySeriesCache(); });
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    const url = new URL(String(input));
    if (url.searchParams.get("AnyProviderIdEquals")?.startsWith("imdb.")) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200 });
  };
  const config = { baseUrl: "https://emby-partial.test", apiKey: "key", userId: "user" };
  const media = { type: "movie", title: "Partial Film", ids: { imdb: "tt123", tmdb: "4" } };
  await findEmbyItems(config, media);
  const first = calls;
  await findEmbyItems(config, media);
  assert.ok(calls > first);
});
