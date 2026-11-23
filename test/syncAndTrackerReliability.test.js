import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-sync-tracker-reliability-");

const { db, bumpDataVersion, getDataVersion } = await import("../server/src/db.js");
const { mediaKeyFor } = await import("../server/src/utils/dataRepo.js");
const { buildForceSyncPlan, findLooseMatch } = await import("../server/src/utils/forceSyncPlanner.js");
const { resolveWatchSyncIntent } = await import("../server/src/utils/watchSyncPolicy.js");
const { createTrackerWriteIntent, finishTrackerWriteIntent, settleLinkedTrackerWriteIntent, trackerRetryRecordIds } = await import("../server/src/utils/trackerWriteIntents.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { createSimklBatchQueue } = await import("../server/src/utils/trackers/simklBatchQueue.js");
const { findPlexItem, fetchPlexPersonalRatingSnapshot } = await import("../server/src/utils/plexClient.js");
const { fetchJellyfinPersonalRatingSnapshot } = await import("../server/src/utils/jellyfinClient.js");

test("Force Sync findLooseMatch keeps distinct episodes sharing series IDs separate and preserves source/syncIntent/watched_at", async () => {
  const groups = [];
  const ep1 = { type: "episode", title: "Severance - S01E01", season: 1, episode: 1, tvdb: "371980", tmdb: "95396", source: "plex", timestamp: new Date("2024-03-01T12:00:00.000Z") };
  const ep2 = { type: "episode", title: "Severance - S01E02", season: 1, episode: 2, tvdb: "371980", tmdb: "95396", source: "emby", timestamp: new Date("2024-03-02T12:00:00.000Z") };
  groups.push({ ...ep1, watchedOn: new Set(["plex"]) });
  assert.equal(findLooseMatch(ep2, groups), null);

  const key1 = mediaKeyFor({ title: ep1.title, type: "episode", season: 1, episode: 1, ids: { tvdb: "371980", tmdb: "95396" } });
  const key2 = mediaKeyFor({ title: ep2.title, type: "episode", season: 1, episode: 2, ids: { tvdb: "371980", tmdb: "95396" } });
  const plan = buildForceSyncPlan({
    itemsByServer: { plex: [ep1], emby: [ep2], jellyfin: [] },
    scannedServers: ["plex", "emby"],
    historyRows: [
      { id: "h1", media_key: key1, media_type: "episode", title: "Severance - S01E01", season: 1, episode: 1, tvdb_id: "371980", tmdb_id: "95396", sync_action: "watched", watched_at: "2024-03-01T12:00:00.000Z" },
      { id: "h2", media_key: key2, media_type: "episode", title: "Severance - S01E02", season: 1, episode: 2, tvdb_id: "371980", tmdb_id: "95396", sync_action: "watched", watched_at: "2024-03-02T12:00:00.000Z" },
    ],
  });

  const markPlayed = plan.actions.filter((a) => a.kind === "mark_played");
  assert.equal(markPlayed.length, 2);
  const embyS1E1 = markPlayed.find((a) => a.target === "emby" && a.media.episode === 1);
  const plexS1E2 = markPlayed.find((a) => a.target === "plex" && a.media.episode === 2);
  assert.ok(embyS1E1, "S01E01 must still be planned for Emby");
  assert.ok(plexS1E2, "S01E02 must still be planned for Plex");
  assert.equal(embyS1E1.media.source, "force_sync");
  assert.equal(embyS1E1.media.syncIntent, "historical");
  assert.equal(embyS1E1.media.watched_at, "2024-03-01T12:00:00.000Z");
  assert.equal(plexS1E2.media.syncIntent, "historical");
});

test("simkl_import resolves to import sync intent", () => {
  assert.equal(resolveWatchSyncIntent({ source: "simkl_import" }), "import");
});

test("settleLinkedTrackerWriteIntent settles an existing retry intent so trackerRetryRecordIds stops returning it", () => {
  const conn = saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "trakt-u1",
    remoteUsername: "u1",
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const media = {
    type: "movie",
    title: "Arrival",
    ids: { imdb: "tt2543164", tmdb: "329865" },
    watched_at: "2025-05-01T10:00:00.000Z",
    watchRecordId: "watch-retry-1",
  };
  const intent = createTrackerWriteIntent({
    provider: "trakt",
    connection: conn,
    media,
    action: "watched",
    watchRecordId: "watch-retry-1",
  });
  finishTrackerWriteIntent(intent.id, "retry", "HTTP 503");
  db.prepare("UPDATE tracker_write_intents SET due_at = ? WHERE id = ?").run(Date.now() - 1000, intent.id);
  assert.equal(trackerRetryRecordIds().has("watch-retry-1"), true);

  const settled = settleLinkedTrackerWriteIntent("trakt", conn, media, "watched", "hist-999");
  assert.equal(settled, true);
  assert.equal(trackerRetryRecordIds().has("watch-retry-1"), false);
});

test("createSimklBatchQueue invokes onBeforeSendAbort when local claim throws after prepare", async () => {
  let released = null;
  const enqueue = createSimklBatchQueue({
    current: () => {},
    matches: () => false,
    prepare: async () => ({ ticket: "t1", quotaRemaining: 120 }),
    claim: () => { throw new Error("Local watch changed before Simkl batch claim"); },
    send: async () => { throw new Error("should not send"); },
    finish: () => {},
    onBeforeSendAbort: (prepared) => { released = prepared; },
  });
  await assert.rejects(
    enqueue({ id: "c1", remoteUserId: "u1" }, { id: "i1" }, { title: "Test" }, "test"),
    /Local watch changed/,
  );
  assert.deepEqual(released, { ticket: "t1", quotaRemaining: 120 });
});

test("Plex movie search fallback checks external GUIDs and refuses wrong remake", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/library/all")) {
      return new Response(JSON.stringify({ MediaContainer: { Metadata: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("/search?")) {
      return new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            { ratingKey: "100", type: "movie", title: "Dune", year: 1984 },
            { ratingKey: "200", type: "movie", title: "Dune", year: 2021 },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("/library/metadata/100")) {
      return new Response(JSON.stringify({
        MediaContainer: { Metadata: [{ ratingKey: "100", type: "movie", title: "Dune", year: 1984, Guid: [{ id: "tmdb://841" }] }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("/library/metadata/200")) {
      return new Response(JSON.stringify({
        MediaContainer: { Metadata: [{ ratingKey: "200", type: "movie", title: "Dune", year: 2021, Guid: [{ id: "tmdb://438631" }] }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const cfg = { baseUrl: "http://plex-remake.test", token: "tok" };
    const matched = await findPlexItem(cfg, { type: "movie", title: "Dune", ids: { tmdb: "438631" } });
    assert.equal(matched?.ratingKey, "200");

    const wrongId = await findPlexItem(cfg, { type: "movie", title: "Dune", ids: { tmdb: "999999" } });
    assert.equal(wrongId, undefined);

    const ambiguousNoIds = await findPlexItem(cfg, { type: "movie", title: "Dune", ids: {} });
    assert.equal(ambiguousNoIds, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Plex and Jellyfin personal rating snapshots preserve series provider IDs on rated episodes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("plex-ratings.test/myplex/account")) {
      return new Response(JSON.stringify({ MyPlex: { id: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("plex-ratings.test/library/sections") && !href.includes("/all")) {
      return new Response(JSON.stringify({ MediaContainer: { Directory: [{ key: "2", type: "show" }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("plex-ratings.test/library/sections/2/all") && href.includes("type=2")) {
      return new Response(JSON.stringify({
        MediaContainer: {
          totalSize: 1,
          Metadata: [{ ratingKey: "show-10", type: "show", title: "Andor", Guid: [{ id: "tmdb://83867" }, { id: "tvdb://393189" }] }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("plex-ratings.test/library/sections/2/all") && href.includes("type=4")) {
      return new Response(JSON.stringify({
        MediaContainer: {
          totalSize: 1,
          Metadata: [{ ratingKey: "ep-11", grandparentRatingKey: "show-10", grandparentTitle: "Andor", type: "episode", title: "Kassa", parentIndex: 1, index: 1, userRating: 9 }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("jf-ratings.test/Users/u1/Items")) {
      assert.ok(href.includes("Fields=ProviderIds") && !href.includes("SeriesProviderIds"), "Jellyfin snapshot must request supported ProviderIds without unsupported SeriesProviderIds");
      assert.ok(href.includes("Series"), "Jellyfin snapshot must include Series items for episode show ID resolution");
      return new Response(JSON.stringify({
        TotalRecordCount: 2,
        Items: [
          { Id: "ser-1", Type: "Series", Name: "Andor", ProviderIds: { Tmdb: "83867", Tvdb: "393189" } },
          { Id: "ep-1", Type: "Episode", Name: "Kassa", SeriesId: "ser-1", SeriesName: "Andor", ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: { Tmdb: "300001" }, UserData: { Rating: 9 } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const plexRecords = await fetchPlexPersonalRatingSnapshot({ baseUrl: "http://plex-ratings.test", token: "tok" });
    assert.equal(plexRecords.length, 1);
    assert.equal(plexRecords[0].media.show_tmdb_id, "83867");
    assert.equal(plexRecords[0].media.show_tvdb_id, "393189");

    const jfRecords = await fetchJellyfinPersonalRatingSnapshot({ baseUrl: "http://jf-ratings.test", apiKey: "k", userId: "u1" });
    assert.equal(jfRecords.length, 1);
    assert.equal(jfRecords[0].media.show_tmdb_id, "83867");
    assert.equal(jfRecords[0].media.show_tvdb_id, "393189");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bumpDataVersion unconditionally increments SQLite even when in-memory version lags another process", () => {
  const before = getDataVersion();
  // Simulate another process advancing cache_versions in SQLite without updating this process's cached version.
  db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'history'").run(Date.now());
  const sharedAfterOtherProcess = db.prepare("SELECT version FROM cache_versions WHERE id = 'history'").get().version;
  assert.equal(sharedAfterOtherProcess, before + 1);

  const next = bumpDataVersion("non-triggered-write");
  assert.equal(next, sharedAfterOtherProcess + 1);
  const sharedAfterBump = db.prepare("SELECT version FROM cache_versions WHERE id = 'history'").get().version;
  assert.equal(sharedAfterBump, next);
});
