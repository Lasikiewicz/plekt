import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-provider-sync-");
const { planUpNextProviderSync, refreshProviderRail, syncUpNextToProviders } = await import("../server/src/utils/upNextProviderSync.js");
const { listUpNextRailSeeds, recordUpNextRailSeeds } = await import("../server/src/utils/upNextSeedLedger.js");

test("disabled Up Next provider sync returns without contacting media servers", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called when Up Next sync is disabled");
  };
  try {
    const summary = await syncUpNextToProviders({
      desiredItems: [{ id: "item-1", title: "Item 1" }],
      config: { upNextSync: { enabled: false } },
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.disabled, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Up Next provider reconciliation preserves visible ids and retains native items missing from the queue", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [
      { provider_items: { plex: ["plex-keep"], emby: ["emby-keep"], jellyfin: ["jelly-keep"] } },
    ],
    feeds: [
      {
        provider: "plex",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [
          { provider_item_id: "plex-keep", title: "Keep" },
          { provider_item_id: "plex-remove", title: "Remove" },
        ],
      },
      {
        provider: "emby",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [{ provider_item_id: "emby-keep", title: "Keep" }],
      },
    ],
  });

  assert.deepEqual(plan.desiredProviderIds, {
    plex: ["plex-keep"],
    emby: ["emby-keep"],
    jellyfin: ["jelly-keep"],
  });
  // Absence from Plembfin's queue is not evidence the user is done with an
  // item, so the plan never contains a dismissal (decisions entry 36).
  assert.equal("dismissals" in plan, false);
  assert.deepEqual(plan.retained, [{
    provider: "plex",
    feed_kind: "resume",
    provider_item_id: "plex-remove",
    title: "Remove",
  }]);
});

test("native Emby Next Up is observation-only when Emby Continue Watching is the target rail", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [{ provider_items: { emby: ["emby-keep"] } }],
    feeds: [{
      provider: "emby",
      feed_kind: "next_up",
      status: "succeeded",
      supportsDismissal: false,
      items: [
        { provider_item_id: "emby-keep", title: "Keep" },
        { provider_item_id: "emby-other", title: "Other" },
      ],
    }],
  });

  assert.deepEqual(plan.retained, []);
});

test("Jellyfin Continue Watching protects real progress while Jellyfin Next Up is reconciled", () => {
  const plan = planUpNextProviderSync({
    desiredItems: [{ provider_items: { jellyfin: ["jelly-next-keep"] } }],
    feeds: [
      {
        provider: "jellyfin",
        feed_kind: "resume",
        status: "succeeded",
        supportsDismissal: true,
        items: [{ provider_item_id: "jelly-real-resume", title: "Real part-watch" }],
      },
      {
        provider: "jellyfin",
        feed_kind: "next_up",
        status: "succeeded",
        supportsDismissal: false,
        items: [
          { provider_item_id: "jelly-next-keep", title: "Keep" },
          { provider_item_id: "jelly-next-extra", title: "Extra" },
        ],
      },
    ],
  });

  assert.deepEqual(plan.retained, [{
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: "jelly-next-extra",
    title: "Extra",
  }]);
});

test("pushing the merged Up Next rail never hides native entries missing from Plembfin's queue", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, options: { ...options, method } });
    if (method === "PUT" && url.pathname === "/actions/removeFromContinueWatching") {
      return new Response("", { status: 200 });
    }
    if (method === "POST" && url.pathname.endsWith("/HideFromResume")) {
      return new Response("", { status: 200 });
    }
    let body = { Items: [] };
    if (method === "GET" && url.pathname === "/hubs/continueWatching") {
      body = {
        MediaContainer: {
          Hub: [{ Metadata: [
            {
              ratingKey: "plex-keep",
              type: "episode",
              title: "Shared Show - S01E02",
              grandparentTitle: "Shared Show",
              parentIndex: 1,
              index: 2,
            },
            {
              ratingKey: "plex-stale",
              type: "episode",
              title: "Plex stale item",
            },
            {
              ratingKey: "plex-identity",
              type: "episode",
              title: "Identity Show - S01E03",
              grandparentTitle: "Identity Show",
              parentIndex: 1,
              index: 3,
            },
          ] }],
        },
      };
    } else if (method === "GET" && url.pathname.endsWith("/Items/Resume")) {
      body = {
        Items: [
          {
            Id: "emby-keep",
            Type: "Episode",
            Name: "Shared Show - S01E02",
            SeriesName: "Shared Show",
            ParentIndexNumber: 1,
            IndexNumber: 2,
          },
          { Id: "emby-stale", Type: "Episode", Name: "Emby stale item" },
          {
            Id: "emby-identity",
            Type: "Episode",
            Name: "Identity Show - S01E03",
            SeriesName: "Identity Show",
            ParentIndexNumber: 1,
            IndexNumber: 3,
          },
        ],
      };
    } else if (method === "GET" && url.pathname.endsWith("/Shows/NextUp")) {
      body = { Items: [{ Id: "emby-next-up", Type: "Episode", Name: "Emby calculated next up" }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "shared-show-s01e02",
      media_key: "shared-show-s01e02",
      media_type: "episode",
      title: "Shared Show - S01E02",
      show_title: "Shared Show",
      season: 1,
      episode: 2,
      provider_items: { plex: ["plex-keep"], emby: ["emby-keep"] },
    }, {
      id: "identity-show-s01e03",
      media_key: "identity-show-s01e03",
      media_type: "episode",
      title: "Identity Show - S01E03",
      show_title: "Identity Show",
      season: 1,
      episode: 3,
      provider_items: { plex: ["plex-identity"], emby: ["emby-identity"] },
    }],
    config: {
      plex: { baseUrl: "http://plex.test", token: "plex-token", serverId: "plex-server-id" },
      emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
    },
  });

  assert.deepEqual(summary.pushedProviders, ["plex", "emby"]);
  // The stale entries may be items the user just started in the app that
  // Plembfin has not ingested yet; the push leaves them in place.
  assert.equal("providerDismissals" in summary, false);
  assert.deepEqual(summary.retained, [
    { provider: "plex", feed_kind: "resume", title: "Plex stale item" },
    { provider: "emby", feed_kind: "resume", title: "Emby stale item" },
  ]);
  const mutations = calls.filter(({ options }) => options.method !== "GET");
  const mutationKeys = mutations.map(({ url, options }) => `${options.method} ${url.pathname}`);
  assert.deepEqual(mutationKeys.filter((key) => /removeFromContinueWatching|HideFromResume/.test(key)), []);
  // The push writes to the native feeds only; there is no managed provider list.
  assert.deepEqual(mutationKeys.filter((key) => /playlist/i.test(key)), []);
  assert.deepEqual(summary.feeds.map((feed) => [feed.provider, feed.feed_kind, feed.status]), [
    ["plex", "resume", "succeeded"],
    ["emby", "resume", "succeeded"],
    ["emby", "next_up", "succeeded"],
    ["jellyfin", "resume", "not_configured"],
    ["jellyfin", "next_up", "not_configured"],
  ]);
});

test("configured Jellyfin takes part in the Up Next push", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const summary = await syncUpNextToProviders({
      desiredItems: [],
      config: {
        jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
      },
    });
    assert.deepEqual(summary.feeds
      .filter((feed) => feed.provider === "jellyfin")
      .map((feed) => [feed.feed_kind, feed.status]), [
      ["resume", "succeeded"],
      ["next_up", "succeeded"],
    ]);
    assert.ok(calls.some((url) => url.hostname === "jellyfin.test"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Seen live in the step 7 offline run: with Jellyfin stopped, every automatic
// push still resolved each queue item against it (twice, as "request failed"
// is treated as transient) and walked its rail, hundreds of failed requests
// per run.
test("a provider whose every feed read failed is not pushed to in that run", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "jellyfin.test") return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const summary = await syncUpNextToProviders({
    desiredItems: [1, 2, 3].map((n) => ({
      id: `offline-${n}`,
      media_key: `offline-${n}`,
      media_type: "episode",
      title: `Offline Show ${n} - S01E02`,
      show_title: `Offline Show ${n}`,
      show_ids: { tvdb: String(9100 + n) },
      season: 1,
      episode: 2,
    })),
    config: {
      emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
      jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
    },
  });

  assert.deepEqual(summary.feeds
    .filter((feed) => feed.provider === "jellyfin")
    .map((feed) => feed.status), ["failed", "failed"]);
  const jellyfinRail = summary.providerRails.find((entry) => entry.provider === "jellyfin");
  assert.equal(jellyfinRail.status, "failed");
  assert.match(jellyfinRail.reason, /could not be reached/);
  assert.equal(summary.pushedProviders.includes("jellyfin"), false);
  // Only the feed reads reached Jellyfin: no item search or rail walk.
  assert.deepEqual(calls
    .filter((url) => url.hostname === "jellyfin.test")
    .filter((url) => url.searchParams.has("AnyProviderIdEquals") || url.searchParams.has("SearchTerm")), []);
  // Emby answered, so it is still resolved and pushed.
  assert.ok(calls.some((url) => url.hostname === "emby.test"
    && (url.searchParams.has("AnyProviderIdEquals") || url.searchParams.has("SearchTerm"))));
  assert.notEqual(summary.providerRails.find((entry) => entry.provider === "emby")?.reason, jellyfinRail.reason);
});

test("the Jellyfin push writes no synthetic resume position", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "POST") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "jelly-show-s01e02",
      media_key: "jelly-show-s01e02",
      media_type: "episode",
      title: "Jelly Show - S01E02",
      show_title: "Jelly Show",
      season: 1,
      episode: 2,
      duration_ms: 2700000,
      provider_items: { jellyfin: ["jelly-keep"] },
    }],
    config: {
      jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
    },
  });

  assert.deepEqual(summary.railSeeds, []);
  assert.deepEqual(calls.filter(({ url }) => /playlist/i.test(url.pathname)), []);
  assert.equal(summary.providerRails.find((entry) => entry.provider === "jellyfin")?.refreshed_count, 0);
  assert.equal(calls.some(({ url, method }) => method === "POST" && /\/Items\/jelly-keep\/UserData$/.test(url.pathname)), false);
});

// Verified live in the step 2 repeat: an automatic sync whose projection was
// built just before Clear progress wrote the cleared 245s back everywhere.
test("a stale automatic sync does not push resume positions built before a canonical change", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), method: String(options.method || "GET").toUpperCase() });
    if (options.method && options.method !== "GET") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const resume = {
    id: "scrubs-s01e04",
    media_key: "episode:1:4:imdb:tt0285403",
    media_type: "episode",
    queue_kind: "resume",
    title: "Scrubs - S01E04",
    show_title: "Scrubs",
    season: 1,
    episode: 4,
    position_ms: 245_000,
    duration_ms: 1_331_349,
    progress: 18.4,
    provider_items: { jellyfin: ["0f292f2c"] },
  };
  const summary = await syncUpNextToProviders({
    desiredItems: [resume],
    config: { jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" } },
    isStale: () => true,
  });

  assert.equal(summary.progress.length, 1);
  assert.equal(summary.progress[0].status, "skipped");
  assert.match(summary.progress[0].details, /changed after the queue was built/);
  assert.equal(calls.some(({ url }) => /0f292f2c/.test(url.pathname) && /UserData|Playing/.test(url.pathname)), false);
});

// Verified live in the Emby plugin step 3 audit: rewriting Plex's unchanged
// Evil S02E03 position every push restamped lastViewedAt, and the next resume
// pass pushed it back to Emby and Jellyfin every 15 minutes.
async function pushResumeAgainstJellyfinFeed(t, feedPositionMs) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") {
      writes.push(url);
      return new Response(null, { status: 204 });
    }
    const items = /resume/i.test(url.pathname) ? [{
      Id: "0f292f2c",
      Type: "Episode",
      Name: "My First Kill",
      SeriesName: "Scrubs",
      ParentIndexNumber: 1,
      IndexNumber: 4,
      RunTimeTicks: 1_331_349 * 10_000,
      UserData: { PlaybackPositionTicks: feedPositionMs * 10_000 },
    }] : [];
    return new Response(JSON.stringify({ Items: items }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "scrubs-s01e04",
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      queue_kind: "resume",
      title: "Scrubs - S01E04",
      show_title: "Scrubs",
      season: 1,
      episode: 4,
      position_ms: 245_000,
      duration_ms: 1_331_349,
      progress: 18.4,
      provider_items: { jellyfin: ["0f292f2c"] },
    }],
    config: { jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" } },
  });
  return { summary, progressWrites: writes.filter((url) => /0f292f2c/.test(url.pathname) && /UserData|Playing/.test(url.pathname)) };
}

test("the push does not rewrite a resume position the provider already holds", async (t) => {
  const { summary, progressWrites } = await pushResumeAgainstJellyfinFeed(t, 245_400);
  assert.equal(summary.progress.length, 1);
  assert.equal(summary.progress[0].status, "skipped");
  assert.match(summary.progress[0].details, /already holds this resume position/);
  assert.deepEqual(progressWrites, []);
});

test("the push still writes a resume position the provider does not hold", async (t) => {
  const { summary, progressWrites } = await pushResumeAgainstJellyfinFeed(t, 120_000);
  assert.equal(summary.progress.length, 1);
  assert.doesNotMatch(summary.progress[0].details, /already holds/);
  assert.ok(progressWrites.length > 0, "the differing position is written to Jellyfin");
});

test("a legacy Jellyfin rail seed is cleared while the watched predecessor refreshes Next Up", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const episodes = [
    {
      Id: "jelly-e1",
      Type: "Episode",
      Name: "Ted Lasso - S04E01",
      SeriesName: "Ted Lasso",
      ParentIndexNumber: 4,
      IndexNumber: 1,
      SeriesProviderIds: { Tmdb: "97546" },
      UserData: { Played: true, PlayCount: 2, PlaybackPositionTicks: 0, LastPlayedDate: "2026-08-01T10:00:00.000Z" },
    },
    {
      Id: "jelly-e2",
      Type: "Episode",
      Name: "Ted Lasso - S04E02",
      SeriesName: "Ted Lasso",
      ParentIndexNumber: 4,
      IndexNumber: 2,
      SeriesProviderIds: { Tmdb: "97546" },
      UserData: { Played: true, PlayCount: 7, PlaybackPositionTicks: 0, LastPlayedDate: "2026-08-02T10:00:00.000Z" },
    },
    {
      Id: "jelly-target",
      Type: "Episode",
      Name: "Richmond's Got Talent",
      SeriesName: "Ted Lasso",
      ParentIndexNumber: 4,
      IndexNumber: 3,
      SeriesProviderIds: { Tmdb: "97546" },
      RunTimeTicks: 27000000000,
      UserData: { Played: false, PlaybackPositionTicks: 1620000000 },
    },
  ];
  recordUpNextRailSeeds([{
    provider: "jellyfin",
    providerItemId: "jelly-target",
    positionMs: 162000,
    durationMs: 2700000,
    title: "Ted Lasso - S04E03",
  }]);

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    const body = String(options.body || "");
    calls.push({ url, method, body });

    if (method === "POST") return new Response(null, { status: 204 });

    let response = { Items: [] };
    if (url.pathname === "/Users/jelly-user/Items/Resume") {
      response = { Items: [{ ...episodes[2] }], TotalRecordCount: 1 };
    } else if (url.pathname === "/Shows/NextUp") {
      response = { Items: [{ ...episodes[2] }] };
    } else if (url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("IncludeItemTypes") === "Series") {
      response = { Items: [{ Id: "jelly-series", Name: "Ted Lasso", ProviderIds: { Tmdb: "97546" } }] };
    } else if (url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("ParentId") === "jelly-series") {
      response = { Items: episodes, TotalRecordCount: episodes.length };
    } else if (url.pathname === "/Users/jelly-user/Items/jelly-target") {
      response = { RunTimeTicks: episodes[2].RunTimeTicks };
    }
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const summary = await syncUpNextToProviders({
    desiredItems: [{
      id: "ted-lasso-s04e03",
      media_key: "ted-lasso-s04e03",
      media_type: "episode",
      // A stale browser snapshot can still describe Plembfin's synthetic
      // Jellyfin position as a resume row. The seed ledger must allow the
      // promotion to clean it up in the same push.
      queue_kind: "resume",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      season: 4,
      episode: 3,
      show_tmdb_id: "97546",
      position_ms: 162000,
      progress: 6,
      provider_items: { jellyfin: ["jelly-target"] },
    }],
    config: {
      jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user" },
    },
  });

  assert.equal(summary.jellyfinRail.promoted_count, 1);
  assert.equal(summary.jellyfinRail.cleared_seed_count, 1);
  assert.equal(summary.jellyfinRail.failed_count, 0);
  assert.equal(listUpNextRailSeeds("jellyfin").some((seed) => seed.providerItemId === "jelly-target"), false);

  const predecessorUnplayed = calls.find((call) => call.method === "DELETE" && call.url.pathname.endsWith("/PlayedItems/jelly-e2"));
  const predecessorPlayed = calls.find((call) => call.method === "POST" && call.url.pathname.endsWith("/PlayedItems/jelly-e2"));
  assert.ok(predecessorUnplayed, "the watched predecessor is first marked unwatched");
  assert.ok(predecessorPlayed, "the watched predecessor is then marked watched");
  assert.equal(predecessorPlayed.url.searchParams.get("datePlayed"), "2026-08-02T10:00:00.000Z");
  assert.ok(calls.indexOf(predecessorUnplayed) < calls.indexOf(predecessorPlayed), "the provider sees the unplayed-to-played transition in order");
  const predecessorDateRestore = calls.find((call) => call.method === "POST" && call.url.pathname.endsWith("/Items/jelly-e2/UserData"));
  assert.ok(predecessorDateRestore, "the watched predecessor date is explicitly restored");
  assert.deepEqual(JSON.parse(predecessorDateRestore.body), { LastPlayedDate: "2026-08-02T10:00:00.000Z" });

  const seedClear = calls.find((call) => {
    if (call.method !== "POST" || !call.url.pathname.endsWith("/Items/jelly-target/UserData")) return false;
    try { return JSON.parse(call.body).PlaybackPositionTicks === 0; } catch { return false; }
  });
  assert.ok(seedClear, "the synthetic seed position is cleared");
  assert.equal(JSON.parse(seedClear.body).PlaybackPositionTicks, 0);
  assert.equal(Object.keys(JSON.parse(seedClear.body)).length, 1, "seed cleanup does not toggle watched state");
});

test("the native rail refresh applies to Plex, Emby, and Jellyfin", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const episodes = {
    plex: [
      { ratingKey: "plex-prev", type: "episode", title: "Native Refresh - S01E01", parentIndex: 1, index: 1, viewCount: 4, viewOffset: 0, originallyAvailableAt: "2026-01-01" },
      { ratingKey: "plex-target", type: "episode", title: "Native Refresh - S01E02", parentIndex: 1, index: 2, viewCount: 0, viewOffset: 0, originallyAvailableAt: "2026-01-02" },
    ],
    emby: [
      { Id: "emby-prev", Type: "Episode", Name: "Native Refresh - S01E01", SeriesName: "Native Refresh", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2026-01-01", UserData: { Played: true, PlaybackPositionTicks: 0 } },
      { Id: "emby-target", Type: "Episode", Name: "Native Refresh - S01E02", SeriesName: "Native Refresh", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2026-01-02", UserData: { Played: false, PlaybackPositionTicks: 0 } },
    ],
    jellyfin: [
      { Id: "jelly-prev", Type: "Episode", Name: "Native Refresh - S01E01", SeriesName: "Native Refresh", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2026-01-01", UserData: { Played: true, PlaybackPositionTicks: 0 } },
      { Id: "jelly-target", Type: "Episode", Name: "Native Refresh - S01E02", SeriesName: "Native Refresh", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2026-01-02", UserData: { Played: false, PlaybackPositionTicks: 0 } },
    ],
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method, body: String(options.body || "") });
    if (method === "POST") return new Response(null, { status: 204 });

    let body = { Items: [] };
    if (url.hostname === "plex-native.test" && url.pathname === "/library/all") {
      body = { MediaContainer: { Metadata: [{ ratingKey: "plex-series", type: "show", title: "Native Refresh" }] } };
    } else if (url.hostname === "plex-native.test" && url.pathname === "/library/metadata/plex-series/allLeaves") {
      body = { MediaContainer: { Metadata: episodes.plex } };
    } else if (url.hostname === "emby-native.test" && url.pathname === "/Users/emby-user/Items" && url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: "emby-series", Type: "Series", Name: "Native Refresh", ProviderIds: { Tmdb: "native-refresh" } }] };
    } else if (url.hostname === "emby-native.test" && url.pathname === "/Users/emby-user/Items" && url.searchParams.get("ParentId") === "emby-series") {
      body = { Items: episodes.emby, TotalRecordCount: episodes.emby.length };
    } else if (url.hostname === "emby-native.test" && url.pathname === "/Users/emby-user/Items/emby-target") {
      body = { Id: "emby-target", UserData: { Played: false, PlayCount: 3, PlaybackPositionTicks: 0, LastPlayedDate: "2026-09-22T19:35:42.0000000Z" } };
    } else if (url.hostname === "jelly-native.test" && url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: "jelly-series", Type: "Series", Name: "Native Refresh", ProviderIds: { Tmdb: "native-refresh" } }] };
    } else if (url.hostname === "jelly-native.test" && url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("ParentId") === "jelly-series") {
      body = { Items: episodes.jellyfin, TotalRecordCount: episodes.jellyfin.length };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const item = {
    id: "native-refresh-s01e02",
    media_key: "native-refresh-s01e02",
    media_type: "episode",
    title: "Native Refresh - S01E02",
    show_title: "Native Refresh",
    season: 1,
    episode: 2,
    show_tmdb_id: "native-refresh",
    position_ms: 0,
    progress: 0,
  };
  const configs = {
    plex: { baseUrl: "http://plex-native.test", token: "plex-token" },
    emby: { baseUrl: "http://emby-native.test", apiKey: "emby-key", userId: "emby-user" },
    jellyfin: { baseUrl: "http://jelly-native.test", apiKey: "jelly-key", userId: "jelly-user" },
  };
  const results = await Promise.all(["plex", "emby", "jellyfin"].map((provider) => refreshProviderRail({
    provider,
    config: configs,
    targets: [{ item, providerItemId: `${provider === "plex" ? "plex" : provider === "emby" ? "emby" : "jelly"}-target` }],
  })));

  assert.deepEqual(results.map((result) => [result.provider, result.status, result.refreshed_count, result.failed_count]), [
    ["plex", "succeeded", 1, 0],
    ["emby", "succeeded", 1, 0],
    ["jellyfin", "succeeded", 1, 0],
  ]);
  assert.ok(calls.some((call) => call.method === "GET" && call.url.hostname === "plex-native.test" && call.url.pathname === "/library/metadata/plex-series/allLeaves"));
  assert.ok(calls.some((call) => call.method === "GET" && call.url.hostname === "plex-native.test" && call.url.pathname === "/:/scrobble" && call.url.searchParams.get("key") === "plex-prev"));
  assert.ok(calls.some((call) => call.method === "GET" && call.url.hostname === "plex-native.test" && call.url.pathname === "/:/unscrobble" && call.url.searchParams.get("key") === "plex-prev"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.hostname === "emby-native.test" && call.url.pathname.endsWith("/PlayedItems/emby-prev")));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.hostname === "emby-native.test" && call.url.pathname.endsWith("/PlayedItems/emby-prev")));
  const embyRailCalls = calls.filter((call) => call.method === "POST" && call.url.hostname === "emby-native.test" && ["/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"].includes(call.url.pathname));
  assert.deepEqual(embyRailCalls.map((call) => call.url.pathname), ["/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"]);
  assert.ok(embyRailCalls.every((call) => JSON.parse(call.body).PositionTicks === 0), "the Emby rail touch never writes resume progress");
  assert.ok(embyRailCalls.every((call) => call.body.includes("plembfin-up-next-refresh-emby-target")), "the Emby rail touch uses the reserved refresh session");
  // Each session raises Emby's PlayCount (docs/decisions.md, Emby rail seeding).
  // Verified live in matrix step 4: without the restore every automatic run
  // added a play to the next-up item (0 -> 1 -> 2 on 2001 Scrubs S01E06).
  const stopped = calls.find((call) => call.method === "POST" && call.url.pathname === "/Sessions/Playing/Stopped" && call.url.hostname === "emby-native.test");
  const restore = calls.find((call) => call.method === "POST" && call.url.hostname === "emby-native.test" && call.url.pathname === "/Users/emby-user/Items/emby-target/UserData");
  assert.ok(restore, "the Emby rail touch restores the item's UserData");
  assert.ok(calls.indexOf(stopped) < calls.indexOf(restore), "the restore follows the session");
  assert.deepEqual(JSON.parse(restore.body), { PlayCount: 3, Played: false, PlaybackPositionTicks: 0, LastPlayedDate: "2026-09-22T19:35:42.0000000Z" });
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.hostname === "jelly-native.test" && call.url.pathname.endsWith("/PlayedItems/jelly-prev")));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.hostname === "jelly-native.test" && call.url.pathname.endsWith("/PlayedItems/jelly-prev")));
});

test("a new season uses the watched final episode of the previous season as its rail predecessor", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const episodes = {
    plex: [
      { ratingKey: "plex-s1e1", type: "episode", title: "Season Boundary - S01E01", parentIndex: 1, index: 1, viewCount: 0, viewOffset: 0, originallyAvailableAt: "2025-01-01" },
      { ratingKey: "plex-s1e2", type: "episode", title: "Season Boundary - S01E02", parentIndex: 1, index: 2, viewCount: 4, viewOffset: 0, originallyAvailableAt: "2025-01-02" },
      { ratingKey: "plex-s2e1", type: "episode", title: "Season Boundary - S02E01", parentIndex: 2, index: 1, viewCount: 0, viewOffset: 0, originallyAvailableAt: "2026-01-01" },
    ],
    emby: [
      { Id: "emby-s1e1", Type: "Episode", Name: "Season Boundary - S01E01", SeriesName: "Season Boundary", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2025-01-01", UserData: { Played: false, PlaybackPositionTicks: 0 } },
      { Id: "emby-s1e2", Type: "Episode", Name: "Season Boundary - S01E02", SeriesName: "Season Boundary", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2025-01-02", UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: "2025-01-03T10:00:00.000Z" } },
      { Id: "emby-s2e1", Type: "Episode", Name: "Season Boundary - S02E01", SeriesName: "Season Boundary", ParentIndexNumber: 2, IndexNumber: 1, PremiereDate: "2026-01-01", UserData: { Played: false, PlaybackPositionTicks: 0 } },
    ],
    jellyfin: [
      { Id: "jelly-s1e1", Type: "Episode", Name: "Season Boundary - S01E01", SeriesName: "Season Boundary", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2025-01-01", UserData: { Played: false, PlaybackPositionTicks: 0 } },
      { Id: "jelly-s1e2", Type: "Episode", Name: "Season Boundary - S01E02", SeriesName: "Season Boundary", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2025-01-02", UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: "2025-01-03T10:00:00.000Z" } },
      { Id: "jelly-s2e1", Type: "Episode", Name: "Season Boundary - S02E01", SeriesName: "Season Boundary", ParentIndexNumber: 2, IndexNumber: 1, PremiereDate: "2026-01-01", UserData: { Played: false, PlaybackPositionTicks: 0 } },
    ],
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method, body: String(options.body || "") });
    if (method === "POST") return new Response(null, { status: 204 });

    let body = { Items: [] };
    if (url.hostname === "plex-boundary.test" && url.pathname === "/library/all") {
      body = { MediaContainer: { Metadata: [{ ratingKey: "plex-series", type: "show", title: "Season Boundary" }] } };
    } else if (url.hostname === "plex-boundary.test" && url.pathname === "/library/metadata/plex-series/allLeaves") {
      body = { MediaContainer: { Metadata: episodes.plex } };
    } else if (url.hostname === "emby-boundary.test" && url.pathname === "/Users/emby-user/Items" && url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: "emby-series", Type: "Series", Name: "Season Boundary", ProviderIds: { Tmdb: "season-boundary" } }] };
    } else if (url.hostname === "emby-boundary.test" && url.pathname === "/Users/emby-user/Items" && url.searchParams.get("ParentId") === "emby-series") {
      body = { Items: episodes.emby, TotalRecordCount: episodes.emby.length };
    } else if (url.hostname === "jelly-boundary.test" && url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: "jelly-series", Type: "Series", Name: "Season Boundary", ProviderIds: { Tmdb: "season-boundary" } }] };
    } else if (url.hostname === "jelly-boundary.test" && url.pathname === "/Users/jelly-user/Items" && url.searchParams.get("ParentId") === "jelly-series") {
      body = { Items: episodes.jellyfin, TotalRecordCount: episodes.jellyfin.length };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const item = {
    id: "season-boundary-s02e01",
    media_key: "season-boundary-s02e01",
    media_type: "episode",
    title: "Season Boundary - S02E01",
    show_title: "Season Boundary",
    season: 2,
    episode: 1,
    show_tmdb_id: "season-boundary",
    position_ms: 0,
    progress: 0,
  };
  const configs = {
    plex: { baseUrl: "http://plex-boundary.test", token: "plex-token" },
    emby: { baseUrl: "http://emby-boundary.test", apiKey: "emby-key", userId: "emby-user" },
    jellyfin: { baseUrl: "http://jelly-boundary.test", apiKey: "jelly-key", userId: "jelly-user" },
  };
  const results = await Promise.all(["plex", "emby", "jellyfin"].map((provider) => refreshProviderRail({
    provider,
    config: configs,
    targets: [{ item, providerItemId: `${provider === "plex" ? "plex" : provider === "emby" ? "emby" : "jelly"}-s2e1` }],
  })));

  assert.deepEqual(results.map((result) => [result.provider, result.status, result.refreshed_count, result.failed_count]), [
    ["plex", "succeeded", 1, 0],
    ["emby", "succeeded", 1, 0],
    ["jellyfin", "succeeded", 1, 0],
  ]);
  assert.ok(calls.some((call) => call.method === "GET" && call.url.hostname === "plex-boundary.test" && call.url.pathname === "/:/scrobble" && call.url.searchParams.get("key") === "plex-s1e2"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.hostname === "emby-boundary.test" && call.url.pathname.endsWith("/PlayedItems/emby-s1e2")));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.hostname === "jelly-boundary.test" && call.url.pathname.endsWith("/PlayedItems/jelly-s1e2")));
});

function unwatchRaceFixture(t, seriesTmdb, { onPlayedWrite = null } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const host = `jelly-${seriesTmdb}.test`;
  const episodes = [
    { Id: `${seriesTmdb}-e1`, Type: "Episode", Name: "E1", SeriesName: "Unwatch Race", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2025-01-01", UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: "2025-01-03T10:00:00.000Z" } },
    { Id: `${seriesTmdb}-e2`, Type: "Episode", Name: "E2", SeriesName: "Unwatch Race", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2025-01-02", UserData: { Played: false, PlaybackPositionTicks: 0 } },
  ];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "POST" && url.pathname.endsWith(`/PlayedItems/${seriesTmdb}-e1`)) await onPlayedWrite?.();
    if (method !== "GET") return new Response(null, { status: 204 });
    let body = { Items: [] };
    if (url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: `${seriesTmdb}-series`, Type: "Series", Name: "Unwatch Race", ProviderIds: { Tmdb: seriesTmdb } }] };
    } else if (url.searchParams.get("ParentId") === `${seriesTmdb}-series`) {
      body = { Items: episodes, TotalRecordCount: episodes.length };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return {
    calls,
    host,
    run: () => refreshProviderRail({
      provider: "jellyfin",
      config: { jellyfin: { baseUrl: `http://${host}`, apiKey: "jelly-key", userId: "jelly-user" } },
      targets: [{
        providerItemId: `${seriesTmdb}-e2`,
        item: { media_type: "episode", title: "Unwatch Race - S01E02", show_title: "Unwatch Race", season: 1, episode: 2, show_tmdb_id: seriesTmdb, position_ms: 0 },
      }],
    }),
  };
}

test("the native rail refresh never restamps a predecessor Plembfin has as unwatched", async (t) => {
  const { setPlaystateForMediaIdentitySync } = await import("../server/src/utils/dataRepo.js");
  // The queue still lists E02 as next up, but E01 was marked unwatched after
  // the queue was built and before Jellyfin's inventory caught up (defect O).
  setPlaystateForMediaIdentitySync({
    title: "Unwatch Race - S01E01", show_title: "Unwatch Race", type: "episode", media_type: "episode",
    season: 1, episode: 1, ids: { tmdb: "race-skip" }, source: "manual",
  }, "unwatched");
  const { calls, run } = unwatchRaceFixture(t, "race-skip");

  const result = await run();

  assert.equal(result.refreshed_count, 0);
  assert.equal(result.results[0].status, "skipped");
  assert.match(result.results[0].reason, /unwatched/);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "no played or unplayed write reaches Jellyfin");
});

test("an unwatch that lands during the rail restamp is sent to the provider again", async (t) => {
  const { setPlaystateForMediaIdentitySync } = await import("../server/src/utils/dataRepo.js");
  const media = {
    title: "Unwatch Race - S01E01", show_title: "Unwatch Race", type: "episode", media_type: "episode",
    season: 1, episode: 1, ids: { tmdb: "race-during" }, source: "manual",
  };
  setPlaystateForMediaIdentitySync(media, "watched", "2025-01-03T10:00:00.000Z");
  const { calls, run } = unwatchRaceFixture(t, "race-during", {
    onPlayedWrite: () => setPlaystateForMediaIdentitySync(media, "unwatched"),
  });

  const result = await run();

  const writes = calls
    .filter((call) => call.method !== "GET" && call.url.pathname.includes("/PlayedItems/"))
    .map((call) => call.method);
  assert.deepEqual(writes, ["DELETE", "POST", "DELETE"], "the restamp is followed by the canonical unwatch");
  assert.equal(result.results[0].predecessor_unwatched_during_refresh, true);
  assert.equal(result.results[0].predecessor_unwatch_restored, true);

  // The toggle's own callbacks are marked by item id so the webhook consumes
  // them (defect AG); the target and other items are not covered.
  const { isRecentOutboundRailRefresh } = await import("../server/src/utils/syncOrchestrator.js");
  const { createLoopStore } = await import("../server/src/utils/loopStore.js");
  assert.equal(await isRecentOutboundRailRefresh({ itemId: "race-during-e1" }, "jellyfin", createLoopStore()), true);
  assert.equal(await isRecentOutboundRailRefresh({ itemId: "race-during-e1" }, "emby", createLoopStore()), false);
  assert.equal(await isRecentOutboundRailRefresh({ itemId: "race-during-e2" }, "jellyfin", createLoopStore()), false);
});

test("Plex native rail refresh does not touch Plex when historical sync is disabled", async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("Plex must not be contacted for a policy-disabled rail toggle");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await refreshProviderRail({
    provider: "plex",
    config: {
      tuning: { plexHistoricalWatchedSync: false },
      plex: { baseUrl: "http://plex-policy.test", token: "plex-token" },
    },
    targets: [{
      providerItemId: "plex-target",
      item: { media_type: "episode", title: "Policy Show - S01E02", show_title: "Policy Show", season: 1, episode: 2 },
    }],
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /historical watched sync is disabled/i);
  assert.equal(called, false);
});

test("an empty Emby resume feed falls back to the legacy resumable query", async (t) => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    paths.push(url.pathname + (url.searchParams.get("Filters") ? `?Filters=${url.searchParams.get("Filters")}` : ""));
    let body = { Items: [] };
    // The native endpoint answers 200 with nothing, which on some servers is
    // true even while real part-watches exist.
    if (url.pathname.endsWith("/Items") && url.searchParams.get("Filters") === "IsResumable") {
      body = {
        Items: [{ Id: "emby-real-resume", Type: "Episode", Name: "A Genuine Part Watch", UserData: { PlaybackPositionTicks: 21851513750 } }],
        TotalRecordCount: 1,
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { fetchEmbyResumableItems } = await import("../server/src/utils/embyClient.js");
  const items = await fetchEmbyResumableItems({ baseUrl: "http://emby.test", apiKey: "k", userId: "emby-user" }, { limit: 0 });

  assert.deepEqual(items.map((item) => item.Id), ["emby-real-resume"]);
  assert.ok(paths.some((path) => path.endsWith("/Items/Resume")), "the native endpoint is still tried first");
  assert.ok(paths.some((path) => path.includes("Filters=IsResumable")), "and the legacy query is consulted when it comes back empty");
});
