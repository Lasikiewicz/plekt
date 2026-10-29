import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForceSyncPlan,
  dropOpposingWrites,
  collectServerWatchedItems,
  mapEmbyLikeWatchedItem,
  mapPlexWatchedItem,
  normalizeScope,
  planStaleness,
  summarizePlan,
} from "../server/src/utils/forceSyncPlanner.js";
import { mediaKeyFor } from "../server/src/utils/dataRepo.js";

function movie(title, source, timestamp = "2026-07-19T12:00:00.000Z") {
  return { title, type: "movie", source, imdb: null, tmdb: null, tvdb: null, timestamp: new Date(timestamp) };
}

test("force-sync planner produces typed actions and summary without writes", () => {
  const media = movie("Arrival", "plex");
  const key = mediaKeyFor({ title: media.title, type: media.type });
  const plan = buildForceSyncPlan({
    itemsByServer: { plex: [media], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby"],
    historyRows: [{ id: "history-1", media_key: key, title: "Arrival", media_type: "movie", sync_action: "watched", watched_at: "2026-07-18T12:00:00.000Z" }],
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, "mark_played");
  assert.equal(plan.actions[0].target, "emby");
  assert.equal(plan.actions[0].risk, "additive");
  assert.equal(plan.actions[0].matchBasis, "title");
  assert.equal(plan.summary.additive, 1);
  assert.equal(plan.summary.destructive, 0);
  assert.equal(plan.summary.outboundWrites, 1);
});

test("scope filters media types and blocks plans over maxChanges", () => {
  const scope = normalizeScope({ mediaTypes: ["movie"], maxChanges: 1 });
  const arrival = movie("Arrival", "plex");
  const dune = movie("Dune", "plex");
  const rows = [arrival, dune].map((item, index) => ({
    id: `history-${index}`,
    media_key: mediaKeyFor({ title: item.title, type: item.type }),
    title: item.title,
    media_type: item.type,
    sync_action: "watched",
    watched_at: "2026-07-18T12:00:00.000Z",
  }));
  const plan = buildForceSyncPlan({
    scope,
    itemsByServer: { plex: [arrival, dune], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby"],
    historyRows: rows,
  });

  assert.equal(plan.summary.overLimit, true);
  assert.equal(plan.summary.maxChanges, 1);
  assert.equal(plan.actions.length, 2);
});

test("Force Sync treats Plembfin history as canonical when servers disagree", () => {
  const local = movie("Fallout", "plex");
  const localKey = mediaKeyFor({ title: local.title, type: local.type });
  const remoteOnly = movie("Only on Plex", "plex");
  const plan = buildForceSyncPlan({
    itemsByServer: { plex: [local, remoteOnly], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby", "jellyfin"],
    historyRows: [{
      id: "fallout-history",
      media_key: localKey,
      title: local.title,
      media_type: local.type,
      sync_action: "watched",
      watched_at: "2026-07-18T12:00:00.000Z",
    }],
  });

  assert.deepEqual(plan.actions.filter((action) => action.kind === "mark_played").map((action) => action.target), ["emby", "jellyfin"]);
  assert.equal(plan.actions.some((action) => action.media.title === remoteOnly.title), false);
  assert.equal(plan.summary.conflictPolicy, "plembfin");
});

test("Force Sync repairs a remote played flag without deleting Plembfin history", () => {
  const local = movie("Canonical Unwatched", "plex");
  const key = mediaKeyFor({ title: local.title, type: local.type });
  const plan = buildForceSyncPlan({
    itemsByServer: { plex: [local], emby: [], jellyfin: [] },
    scannedServers: ["plex"],
    historyRows: [
      { id: "watched-history", media_key: key, title: local.title, media_type: local.type, sync_action: "watched", watched_at: "2026-07-17T12:00:00.000Z" },
      { id: "unwatched-marker", media_key: key, title: local.title, media_type: local.type, sync_action: "unwatched", watched_at: "2026-07-18T12:00:00.000Z" },
    ],
  });

  assert.deepEqual(plan.actions.map((action) => action.kind), ["mark_unplayed"]);
  assert.equal(plan.actions[0].target, "plex");
  assert.equal(plan.actions.some((action) => ["delete_history_rows", "insert_unwatched_record"].includes(action.kind)), false);
});

test("staleness detects TTL and changed watched counts", () => {
  const createdAt = 1_000_000;
  const plan = { createdAt, fingerprints: { plex: { rawCount: 4 } } };
  const changed = planStaleness(plan, { counts: { plex: 5 }, config: {}, now: createdAt + 1 });
  assert.equal(changed.stale, true);
  assert.deepEqual(changed.reasons, ["plex watched-item count changed (4 → 5)."]);
  assert.equal(planStaleness(plan, { counts: { plex: 4 }, config: {}, now: createdAt + 15 * 60 * 1000 + 1 }).stale, true);
});

test("summary classifies large destructive plans for strong confirmation", () => {
  const summary = summarizePlan({
    actions: Array.from({ length: 26 }, (_, index) => ({ mediaKey: String(index), kind: "mark_unplayed", target: "plex", risk: "destructive", matchBasis: "provider-id" })),
    historyRowCount: 26,
  });
  assert.equal(summary.requiresStrongConfirmation, true);
  assert.equal(summary.snapshotRequired, true);
});

test("a failed server scan is not treated as an empty library or write target", async () => {
  const config = {
    plex: { baseUrl: "http://plex", token: "token", disabled: false },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  };
  const collected = await collectServerWatchedItems(config, {
    clients: {
      fetchPlexWatchedItems: async () => { throw new Error("Plex unavailable"); },
    },
  });

  assert.deepEqual(collected.scannedServers, []);
  assert.equal(collected.scopeErrors[0].server, "plex");
  assert.match(collected.scopeErrors[0].error, /Plex unavailable/);

  const plan = buildForceSyncPlan({
    ...collected,
    config,
    historyRows: [{
      id: "arrival-history",
      media_key: mediaKeyFor({ title: "Arrival", type: "movie" }),
      title: "Arrival",
      media_type: "movie",
      sync_action: "watched",
      watched_at: "2026-07-18T12:00:00.000Z",
    }],
  });
  assert.equal(plan.summary.scopeErrors.length, 1);
  assert.equal(plan.actions.length, 0);
});

test("Force Sync target generation respects receive roles", () => {
  const local = movie("Arrival", "plex");
  const key = mediaKeyFor({ title: local.title, type: local.type });
  const config = {
    plex: { sync: { preset: "source_only" } },
    emby: { sync: { preset: "destination_only" } },
    jellyfin: { sync: { preset: "monitor" } },
  };
  const plan = buildForceSyncPlan({
    config,
    itemsByServer: { plex: [local], emby: [], jellyfin: [] },
    scannedServers: ["plex", "emby", "jellyfin"],
    historyRows: [{ id: "arrival-history", media_key: key, title: local.title, media_type: local.type, sync_action: "watched", watched_at: "2026-07-18T12:00:00.000Z" }],
  });

  assert.deepEqual(plan.actions.map((action) => action.target), ["emby"]);
});

test("onboarding scan uses release date when Plex has no played timestamp", () => {
  const media = mapPlexWatchedItem({
    title: "Arrival",
    type: "movie",
    viewCount: 1,
    originallyAvailableAt: "2016-11-11",
  });
  assert.equal(media.timestamp.toISOString(), "2016-11-11T00:00:00.000Z");
  assert.equal(media.timestampInferredFromRelease, true);
});

test("mapPlexWatchedItem prefers the show's tmdb/tvdb guid over the episode's own guid", () => {
  const media = mapPlexWatchedItem({
    title: "Pilot",
    type: "episode",
    grandparentTitle: "Arrival Show",
    parentIndex: 1,
    index: 1,
    viewCount: 1,
    // Episode-level guid: TMDB/TVDB assign episodes their own ids, separate
    // from the series - these must not end up as the record's tmdb/tvdb id.
    guid: "plex://episode/deadbeef",
    Guid: [{ id: "tmdb://999999" }, { id: "tvdb://888888" }],
    grandparentGuid: "plex://show/cafebabe",
    GrandparentGuid: [{ id: "tmdb://12345" }, { id: "tvdb://54321" }],
  });
  assert.equal(media.tmdb, "12345");
  assert.equal(media.tvdb, "54321");
});

test("onboarding scan uses release date when Emby has no played timestamp", () => {
  const media = mapEmbyLikeWatchedItem({
    Name: "Arrival",
    Type: "Movie",
    PremiereDate: "2016-11-11T00:00:00.000Z",
    UserData: { Played: true },
  });
  assert.equal(media.timestamp.toISOString(), "2016-11-11T00:00:00.000Z");
  assert.equal(media.timestampInferredFromRelease, true);
});

test("opposing played and unplayed writes for one server item are both dropped and flagged", () => {
  const episode = (ids) => ({ title: "Alert: Missing Persons Unit - S01E02", type: "episode", season: 1, episode: 2, ids });
  const skipped = [];
  const actions = [
    { seq: 1, kind: "mark_unplayed", target: "emby", mediaKey: "episode-ids", media: episode({ tmdb: "4044535" }) },
    { seq: 2, kind: "mark_played", target: "emby", mediaKey: "series-ids", media: episode({ tmdb: "202308" }) },
    { seq: 3, kind: "mark_played", target: "jellyfin", mediaKey: "series-ids", media: episode({ tmdb: "202308" }) },
    { seq: 4, kind: "mark_played", target: "emby", mediaKey: "other", media: { ...episode({}), episode: 3 } },
  ];
  const kept = dropOpposingWrites(actions, skipped);
  assert.deepEqual(kept.map((action) => action.seq), [3, 4]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].target, "emby");
  assert.match(skipped[0].reason, /both watched and unwatched/);
  // Same-direction writes are left alone.
  assert.equal(dropOpposingWrites([actions[1], actions[3]], []).length, 2);
});

// Found on local data: Moana (2016, watched) and Moana (2026, unwatched) are two
// films, so both writes must go through. Ids that cannot tell two movies apart
// still clash.
test("same-titled movies with differing ids are not treated as one split item", () => {
  const movie = (ids) => ({ title: "Moana", type: "movie", season: null, episode: null, ids });
  const films = [
    { seq: 1, kind: "mark_played", target: "plex", mediaKey: "m2016", media: movie({ imdb: "tt3521164", tmdb: "277834" }) },
    { seq: 2, kind: "mark_unplayed", target: "plex", mediaKey: "m2026", media: movie({ imdb: "tt27419466", tmdb: "1108427" }) },
  ];
  const skipped = [];
  assert.deepEqual(dropOpposingWrites(films, skipped).map((action) => action.seq), [1, 2]);
  assert.equal(skipped.length, 0);

  const split = [
    { seq: 1, kind: "mark_played", target: "plex", mediaKey: "imdb-only", media: movie({ imdb: "tt3521164" }) },
    { seq: 2, kind: "mark_unplayed", target: "plex", mediaKey: "tmdb-only", media: movie({ tmdb: "277834" }) },
  ];
  assert.equal(dropOpposingWrites(split, skipped).length, 0);
  assert.equal(skipped.length, 1);
});

test("Emby episode mapping keeps the series item id for series-id resolution", () => {
  const media = mapEmbyLikeWatchedItem({ Type: "Episode", SeriesName: "Alert", SeriesId: "77", ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: { Tmdb: "4044535" } });
  assert.equal(media.seriesItemId, "77");
  assert.equal(mapEmbyLikeWatchedItem({ Type: "Movie", Name: "Heat", SeriesId: "77" }).seriesItemId, null);
});
