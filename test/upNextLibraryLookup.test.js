import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-library-lookup-");

const {
  __setUpNextLibraryLookupNow,
  clearUpNextLibraryLookupCache,
  createUpNextLibraryEpisodeLookup,
  createUpNextLibraryLookup,
} = await import("../server/src/utils/upNextLibraryLookup.js");
const { __resetJellyfinSeriesCache } = await import("../server/src/utils/jellyfinClient.js");
const { db } = await import("../server/src/db.js");

// A clean slate: this process's memory and the saved answers. A restart loses
// only the memory, which clearUpNextLibraryLookupCache alone simulates.
function clearAllAnswers() {
  clearUpNextLibraryLookupCache();
  db.prepare("DELETE FROM up_next_library_items").run();
}

const config = {
  jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "api-key", userId: "jellyfin-user" },
};

const show = (n) => ({ title: `Offline Show ${n}`, tvdb_id: String(9000 + n) });
const episode = (n) => ({
  media_type: "episode",
  title: `Offline Show ${n} - S01E02`,
  show_title: `Offline Show ${n}`,
  season: 1,
  episode: 2,
  show_ids: { tvdb: String(9000 + n) },
});

function withOfflineJellyfin(run) {
  return async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let now = 1_000_000;
    let requests = 0;
    clearAllAnswers();
    __resetJellyfinSeriesCache();
    __setUpNextLibraryLookupNow(() => now);
    console.error = () => {};
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("Not Found", { status: 404 });
    };
    try {
      await run({ requests: () => requests, advance: (ms) => { now += ms; } });
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      __setUpNextLibraryLookupNow(null);
      clearAllAnswers();
      __resetJellyfinSeriesCache();
    }
  };
}

test("an unreachable provider stands down its series inventory lookups until the backoff ends", withOfflineJellyfin(async ({ requests, advance }) => {
  const lookup = createUpNextLibraryEpisodeLookup(config);
  assert.deepEqual(await lookup(show(1)), []);
  const afterFirst = requests();
  assert.ok(afterFirst > 0, "the first lookup reaches the provider");

  // A later rebuild in the same outage, for other shows, sends nothing.
  for (let n = 2; n <= 6; n += 1) assert.deepEqual(await createUpNextLibraryEpisodeLookup(config)(show(n)), []);
  assert.equal(requests(), afterFirst);

  advance(61_000);
  await createUpNextLibraryEpisodeLookup(config)(show(7));
  assert.ok(requests() > afterFirst, "the provider is retried once the backoff has passed");
}));

test("an unreachable provider stands down its episode item lookups and caches no miss", withOfflineJellyfin(async ({ requests, advance }) => {
  const lookup = createUpNextLibraryLookup(config);
  assert.deepEqual(await lookup(episode(1)), {});
  const afterFirst = requests();
  assert.ok(afterFirst > 0);

  for (let n = 2; n <= 6; n += 1) assert.deepEqual(await createUpNextLibraryLookup(config)(episode(n)), {});
  assert.equal(requests(), afterFirst);

  // The failed lookup was not cached as "absent": after the backoff the same
  // episode is asked again.
  advance(61_000);
  await createUpNextLibraryLookup(config)(episode(1));
  assert.ok(requests() > afterFirst);
}));

// Answers a Jellyfin library holding "Remembered Show" S01E02 as item jf-e2,
// or holding no episodes at all when `present` is false.
function jellyfinLibrary({ present }) {
  const series = { Id: "jf-series", Name: "Remembered Show", Type: "Series", ProviderIds: { Tvdb: "9100" } };
  const episodeItem = {
    Id: "jf-e2",
    Name: "Episode Two",
    Type: "Episode",
    SeriesId: "jf-series",
    SeriesName: "Remembered Show",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    ProviderIds: {},
  };
  return async (input) => {
    const url = new URL(String(input?.url || input));
    const types = `${url.searchParams.get("IncludeItemTypes") || ""}`.toLowerCase();
    const items = /\/episodes/i.test(url.pathname) || types.includes("episode")
      ? (present ? [episodeItem] : [])
      : [series];
    return Response.json({ Items: items, TotalRecordCount: items.length });
  };
}

const rememberedEpisode = {
  media_type: "episode",
  title: "Remembered Show - S01E02",
  show_title: "Remembered Show",
  season: 1,
  episode: 2,
  show_ids: { tvdb: "9100" },
};

test("a restart during an outage keeps the provider's last library-confirmed id, and a live miss replaces it", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let now = 7_000_000;
  const resetProcessState = () => {
    // What a Plembfin restart loses: every in-memory cache and stand-down.
    clearUpNextLibraryLookupCache();
    __resetJellyfinSeriesCache();
  };
  const offlineFetch = async () => new Response("Not Found", { status: 404 });
  // A failed lookup for another episode is how a build learns of the outage.
  const enterOutage = async () => {
    globalThis.fetch = offlineFetch;
    await createUpNextLibraryLookup(config)(episode(99));
  };
  console.error = () => {};
  __setUpNextLibraryLookupNow(() => now);
  try {
    clearAllAnswers();
    __resetJellyfinSeriesCache();
    globalThis.fetch = jellyfinLibrary({ present: true });
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), { jellyfin: ["jf-e2"] });

    // A current saved answer is used as is after a restart, outage or not.
    resetProcessState();
    await enterOutage();
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode, { detailed: true }),
      { providerItems: { jellyfin: ["jf-e2"] }, unanswered: [] });

    // An expired one during an outage follows the outage rule.
    resetProcessState();
    now += 6 * 60 * 60 * 1000;
    await enterOutage();
    const offline = await createUpNextLibraryLookup(config)(rememberedEpisode, { detailed: true });
    assert.deepEqual(offline.providerItems, { jellyfin: ["jf-e2"] }, "the card keeps the id Jellyfin last confirmed");
    assert.deepEqual(offline.unanswered, ["jellyfin"], "it is still reported as unanswered");
    // Later lookups in the same stand-down window use it too.
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), { jellyfin: ["jf-e2"] });

    // The background recheck of the expired answer asks the library again.
    resetProcessState();
    globalThis.fetch = jellyfinLibrary({ present: false });
    assert.deepEqual(await createUpNextLibraryLookup(config, { recheck: true })(rememberedEpisode), {}, "a live miss is final");

    resetProcessState();
    await enterOutage();
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {}, "the replaced id is not revived by a later outage");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    __setUpNextLibraryLookupNow(null);
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});

// Speed finding AK: with a 15-minute miss window, misses for the ~160 eligible
// shows expired faster than the 32-lookups-per-build budget refilled them, so
// every Up Next rebuild paid seconds of provider round trips. Step 3 of
// plan/archive/up-next-build-speed/summary.md: an expired miss still hides the card, and is
// asked again in the background rather than during the build.
test("a live miss is kept for two hours, then rechecked in the background while it still hides the card", async () => {
  const originalFetch = globalThis.fetch;
  let now = 5_000_000;
  let requests = 0;
  const library = jellyfinLibrary({ present: false });
  clearAllAnswers();
  __resetJellyfinSeriesCache();
  __setUpNextLibraryLookupNow(() => now);
  globalThis.fetch = async (input) => {
    requests += 1;
    return library(input);
  };
  try {
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {});
    const afterFirst = requests;
    assert.ok(afterFirst > 0, "the first lookup reaches the library");

    now += 2 * 60 * 60 * 1000 - 1;
    __resetJellyfinSeriesCache();
    const fresh = [];
    assert.deepEqual(await createUpNextLibraryLookup(config, { deferred: fresh })(rememberedEpisode), {});
    assert.equal(requests, afterFirst, "a later rebuild inside two hours reuses the miss");
    assert.equal(fresh.length, 0, "a current answer needs no recheck");

    now += 1;
    const stats = {};
    const deferred = [];
    const expired = await createUpNextLibraryLookup(config, { stats, deferred })(rememberedEpisode, { detailed: true });
    assert.deepEqual(expired, { providerItems: {}, unanswered: [] }, "the expired miss still hides the card");
    assert.equal(requests, afterFirst, "the build itself does not ask again");
    assert.deepEqual(stats, { itemCached: 1 });
    assert.deepEqual(deferred.map((entry) => entry.provider), ["jellyfin"], "the miss is queued for a recheck");

    await createUpNextLibraryLookup(config, { recheck: true })(rememberedEpisode);
    assert.ok(requests > afterFirst, "the recheck asks the library again");
  } finally {
    globalThis.fetch = originalFetch;
    __setUpNextLibraryLookupNow(null);
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});

// Step 3 of plan/archive/up-next-build-speed/summary.md: answers were kept only in memory, so a
// restart showed 20 cards that fell to 14 as the answers came back.
test("library answers survive a module reload, and a never-asked key stays unanswered", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const library = jellyfinLibrary({ present: false });
  clearAllAnswers();
  __resetJellyfinSeriesCache();
  globalThis.fetch = async (input) => {
    requests += 1;
    return library(input);
  };
  try {
    assert.deepEqual(await createUpNextLibraryLookup(config)(rememberedEpisode), {});
    const afterFirst = requests;

    // A fresh copy of the module has none of the first copy's memory, as in a
    // new process.
    const reloaded = await import(`../server/src/utils/upNextLibraryLookup.js?reload=${Date.now()}`);
    const stats = {};
    const lookup = reloaded.createUpNextLibraryLookup(config, { stats });
    assert.deepEqual(await lookup(rememberedEpisode, { detailed: true }), { providerItems: {}, unanswered: [] },
      "the saved miss still hides the card after a reload");
    assert.equal(requests, afterFirst, "the reloaded module asks nothing");
    assert.deepEqual(stats, { itemCached: 1 });

    // With the build budget spent, a key never answered keeps its card.
    for (let n = 1; n <= 32; n += 1) await lookup(episode(n));
    const unasked = await lookup(episode(33), { detailed: true });
    assert.deepEqual(unasked, { providerItems: {}, unanswered: ["jellyfin"] });
    reloaded.clearUpNextLibraryLookupCache();
  } finally {
    globalThis.fetch = originalFetch;
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});

// Speed finding AK: refetching 26 series inventories took 13-18s, and a
// 5-minute window made every rebuild after a short idle gap pay it.
test("a series episode inventory is kept for thirty minutes", async () => {
  const originalFetch = globalThis.fetch;
  let now = 5_000_000;
  let requests = 0;
  const library = jellyfinLibrary({ present: true });
  const series = { title: "Remembered Show", tvdb_id: "9100" };
  clearAllAnswers();
  __resetJellyfinSeriesCache();
  __setUpNextLibraryLookupNow(() => now);
  globalThis.fetch = async (input) => {
    requests += 1;
    return library(input);
  };
  try {
    const first = await createUpNextLibraryEpisodeLookup(config)(series);
    assert.deepEqual(first.map((item) => item.provider_items), [{ jellyfin: ["jf-e2"] }]);
    const afterFirst = requests;

    now += 30 * 60 * 1000 - 1;
    __resetJellyfinSeriesCache();
    assert.deepEqual(await createUpNextLibraryEpisodeLookup(config)(series), first);
    assert.equal(requests, afterFirst, "a rebuild inside thirty minutes reuses the inventory");

    now += 1;
    await createUpNextLibraryEpisodeLookup(config)(series);
    assert.ok(requests > afterFirst, "the inventory is refetched once thirty minutes have passed");
  } finally {
    globalThis.fetch = originalFetch;
    __setUpNextLibraryLookupNow(null);
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});

// Speed step 15b: the server logs one summary per Up Next build so the live
// lookups each rebuild pays can be counted from the diagnostic log.
test("build stats count live, cached, and over-budget lookups and inventories", async () => {
  const { formatUpNextBuildSummary } = await import("../server/src/utils/upNextService.js");
  const originalFetch = globalThis.fetch;
  clearAllAnswers();
  __resetJellyfinSeriesCache();
  globalThis.fetch = jellyfinLibrary({ present: false });
  try {
    const first = {};
    const lookup = createUpNextLibraryLookup(config, { stats: first });
    for (let n = 1; n <= 33; n += 1) await lookup(episode(n));
    assert.deepEqual(first, { itemLive: 32, itemOverBudget: 1 });

    const second = {};
    const nextLookup = createUpNextLibraryLookup(config, { stats: second });
    for (let n = 1; n <= 33; n += 1) await nextLookup(episode(n));
    assert.deepEqual(second, { itemCached: 32, itemLive: 1 }, "the next build reuses the cached misses");

    const inventory = {};
    const series = { title: "Remembered Show", tvdb_id: "9100" };
    await createUpNextLibraryEpisodeLookup(config, { stats: inventory })(series);
    await createUpNextLibraryEpisodeLookup(config, { stats: inventory })(series);
    assert.deepEqual(inventory, { inventoryFetched: 1, inventoryCached: 1 });

    assert.equal(
      formatUpNextBuildSummary({ ...second, ...inventory }, 9, 6840),
      "Up Next build: 9 items in 6.8s; library lookups 1 live, 32 cached, 0 over budget; series inventories 1 fetched, 1 cached.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});

// Speed step 15b: real dashboards rebuild too rarely to fill the cache 32
// lookups at a time before the miss window expires, so the lookups a build
// skips for budget are asked in the background (the user's choice).
test("a background top-up asks the lookups a build skipped, so the next build pays none", async () => {
  const { topUpUpNextLibraryLookups } = await import("../server/src/utils/upNextLibraryLookup.js");
  const originalFetch = globalThis.fetch;
  clearAllAnswers();
  __resetJellyfinSeriesCache();
  globalThis.fetch = jellyfinLibrary({ present: false });
  try {
    const build = {};
    const deferred = [];
    const lookup = createUpNextLibraryLookup(config, { stats: build, deferred });
    for (let n = 1; n <= 80; n += 1) await lookup(episode(n));
    assert.deepEqual(build, { itemLive: 32, itemOverBudget: 48 });
    assert.equal(deferred.length, 48);

    const logs = [];
    const running = topUpUpNextLibraryLookups(config, [...deferred, ...deferred], { pauseMs: 0, log: (line) => logs.push(line) });
    assert.equal(topUpUpNextLibraryLookups(config, deferred, { pauseMs: 0, log: () => {} }), running,
      "a second build while a top-up runs starts no second top-up");
    await running;
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Up Next lookup top-up: 48 skipped lookups in [\d.]+s; 48 live, 0 already cached\.$/);

    const next = {};
    const nextLookup = createUpNextLibraryLookup(config, { stats: next });
    for (let n = 1; n <= 80; n += 1) await nextLookup(episode(n));
    assert.deepEqual(next, { itemCached: 80 }, "the next build finds every answer cached");
    assert.equal(topUpUpNextLibraryLookups(config, [], { pauseMs: 0 }), null, "nothing skipped, nothing to top up");
  } finally {
    globalThis.fetch = originalFetch;
    clearAllAnswers();
    __resetJellyfinSeriesCache();
  }
});
