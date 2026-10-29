import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalStateForShowHistoryRow,
  normalizeMediaForceSyncRequest,
  remoteItemIsWatched,
  remoteItemToMedia,
} from "../server/src/utils/mediaForceSync.js";
import { normalizeLibraryForceSyncRequest, plannerMediaToSyncMedia, withLibrarySeriesIds } from "../server/src/utils/libraryForceSync.js";
import { createMediaForceSyncActivity, finishMediaForceSyncActivity, getMediaForceSyncActivity, isMediaForceSyncCancellationRequested, requestMediaForceSyncCancellation } from "../server/src/utils/mediaForceSyncActivity.js";
import { embyEpisodeMatchesCoordinates } from "../server/src/utils/embyClient.js";
import { jellyfinEpisodeMatchesCoordinates } from "../server/src/utils/jellyfinClient.js";

test("normalizes a show detail Force Sync request and provider ids", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({
      media_type: "tv",
      name: "The Acolyte",
      tmdbId: 4194,
      tvdb_id: "41077",
      mode: "push",
    }),
    {
      title: "The Acolyte",
      type: "show",
      ids: { imdb: "", tmdb: "4194", tvdb: "41077" },
      season: null,
      episode: null,
      seasons: [],
      mode: "push",
      source: "",
      target: "",
    },
  );
});

test("rejects a Force Sync request with no mode or an unrecognized mode", () => {
  assert.throws(
    () => normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show" }),
    /mode must be push or pull/,
  );
  assert.throws(
    () => normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "full" }),
    /mode must be push or pull/,
  );
});

test("Jellyfin episode matching keeps duplicate quality copies", () => {
  const candidates = [
    { Id: "1080p-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "4k-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "other-episode", ParentIndexNumber: 1, IndexNumber: 3 },
  ];
  assert.deepEqual(
    candidates.filter((item) => jellyfinEpisodeMatchesCoordinates(item, 1, 2)).map((item) => item.Id),
    ["1080p-copy", "4k-copy"],
  );
});

test("Emby episode matching keeps duplicate quality copies", () => {
  const candidates = [
    { Id: "1080p-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "4k-copy", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "other-episode", ParentIndexNumber: 1, IndexNumber: 3 },
  ];
  assert.deepEqual(
    candidates.filter((item) => embyEpisodeMatchesCoordinates(item, 1, 2)).map((item) => item.Id),
    ["1080p-copy", "4k-copy"],
  );
});

test("normalizes target-specific push and pull operations", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push_to", push_to: "jellyfin" }),
    {
      title: "The Acolyte",
      type: "show",
      ids: { imdb: "", tmdb: "", tvdb: "" },
      season: null,
      episode: null,
      seasons: [],
      mode: "push",
      source: "",
      target: "jellyfin",
    },
  );
  assert.equal(normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "pull_from", pull_from: "plex" }).mode, "pull");
  assert.equal(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push_to", push_to: "trakt" }).target,
    "trakt",
  );
  assert.throws(
    () => normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "pull_from", pull_from: "trakt" }),
    /source must be plex, emby, or jellyfin/,
  );
});

test("normalizes a season subset for a show detail Force Sync request", () => {
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push", seasons: [2, 1, 1, "3"] }).seasons,
    [1, 2, 3],
  );
  assert.deepEqual(
    normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push", seasons: "2,1" }).seasons,
    [1, 2],
  );
  assert.deepEqual(normalizeMediaForceSyncRequest({ title: "The Acolyte", type: "show", mode: "push" }).seasons, []);
});

test("show source-of-truth push preserves each episode's canonical watched state", () => {
  assert.equal(canonicalStateForShowHistoryRow({ sync_action: "watched" }), "watched");
  assert.equal(canonicalStateForShowHistoryRow({ sync_action: "unwatched" }), "unwatched");
  assert.equal(canonicalStateForShowHistoryRow({ sync_action: "unplayed" }), "unwatched");
  assert.equal(canonicalStateForShowHistoryRow({}), "watched");
});

test("normalizes the Settings library Force Sync options", () => {
  assert.equal(
    normalizeLibraryForceSyncRequest({ mode: "pull_from", pull_from: "jellyfin" }).source,
    "jellyfin",
  );
  assert.equal(
    normalizeLibraryForceSyncRequest({ mode: "push_to", push_to: "emby" }).target,
    "emby",
  );
  assert.equal(normalizeLibraryForceSyncRequest({ mode: "push_to", push_to: "trakt" }).target, "trakt");
  assert.throws(() => normalizeLibraryForceSyncRequest({ mode: "pull_from", pull_from: "trakt" }), /source must be plex, emby, or jellyfin/);
  assert.throws(() => normalizeLibraryForceSyncRequest({ mode: "full_sync" }), /mode must be push or pull/);
});

test("Force Sync activity records a user cancellation", () => {
  const operationId = createMediaForceSyncActivity({ mode: "full", type: "library" });
  assert.equal(requestMediaForceSyncCancellation(operationId).status, "cancellation_requested");
  assert.equal(isMediaForceSyncCancellationRequested(operationId), true);
  finishMediaForceSyncActivity(operationId, { cancelled: true, results: [] });
  assert.equal(getMediaForceSyncActivity(operationId).status, "cancelled");
});

test("maps a watched Plex episode into a canonical Plembfin record", () => {
  const item = {
    type: "episode",
    title: "Lost / Found",
    grandparentTitle: "The Acolyte",
    parentIndex: 1,
    index: 2,
    ratingKey: "41077-ep-2",
    lastViewedAt: 1783379340,
    Guid: [
      { id: "tmdb://4194" },
      { id: "tvdb://41077" },
    ],
  };
  const requested = {
    title: "The Acolyte",
    type: "show",
    ids: { imdb: "", tmdb: "4194", tvdb: "41077" },
  };

  assert.equal(remoteItemIsWatched(item, "plex"), true);
  const media = remoteItemToMedia(item, "plex", requested);
  assert.equal(media.title, "The Acolyte - S01E02");
  assert.equal(media.show_title, "The Acolyte");
  assert.equal(media.season, 1);
  assert.equal(media.episode, 2);
  assert.equal(media.watched_at, "2026-07-06T23:09:00.000Z");
  assert.equal(media.ids.tmdb, "4194");
  assert.equal(media.ids.tvdb, "41077");
  assert.equal(media.watchProvenance.ingest_path, "force_sync");
});

test("an episode's own tmdb/tvdb ids never override the show's requested ids", () => {
  // Plex/Emby/Jellyfin tag an episode with its OWN tmdb/tvdb id (TMDB and
  // TVDB both assign episodes ids separate from their series) - trusting
  // that over the show this operation was actually requested against tags
  // the inserted row with the wrong identity and fragments it into its own
  // show cluster instead of the real show's. imdb stays episode-sourced.
  const item = {
    type: "episode",
    title: "Mean Ghouls",
    grandparentTitle: "School Spirits",
    parentIndex: 3,
    index: 2,
    ratingKey: "school-spirits-s3e2",
    lastViewedAt: 1783379340,
    Guid: [
      { id: "imdb://tt39125564" },
      { id: "tmdb://6746320" },
      { id: "tvdb://11498362" },
    ],
  };
  const requested = {
    title: "School Spirits (2023)",
    type: "show",
    ids: { imdb: "", tmdb: "208397", tvdb: "421636" },
  };

  const media = remoteItemToMedia(item, "plex", requested);
  assert.equal(media.ids.tmdb, "208397", "must use the show's requested tmdb id, not the episode's own");
  assert.equal(media.ids.tvdb, "421636", "must use the show's requested tvdb id, not the episode's own");
  assert.equal(media.ids.imdb, "tt39125564", "imdb stays episode-scoped");
});

test("maps an Emby played item and ignores an unplayed remote item", () => {
  const item = {
    Type: "Episode",
    Name: "Revenge / Justice",
    SeriesName: "The Acolyte",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    Id: "emby-episode-1",
    ProviderIds: { Tvdb: "41076" },
    UserData: { Played: true, LastPlayedDate: "2026-07-07T18:30:00Z" },
  };
  const requested = { title: "The Acolyte", type: "show", ids: {} };

  assert.equal(remoteItemIsWatched(item, "emby"), true);
  const media = remoteItemToMedia(item, "emby", requested);
  assert.equal(media.title, "The Acolyte - S01E01");
  assert.equal(media.watched_at, "2026-07-07T18:30:00.000Z");
  assert.equal(media.itemId, "emby-episode-1");
  assert.equal(remoteItemIsWatched({ Type: "Episode", UserData: { Played: false } }, "emby"), false);
});

test("a Plex episode marked watched with no viewed date falls back to its release date", () => {
  // Bulk-marking watched through Plex's own library UI sets viewCount without
  // lastViewedAt - Force Sync must still import it (the user explicitly asked
  // for this title), anchored to a real date rather than inventing "now".
  const item = {
    type: "episode",
    title: "Mean Ghouls",
    grandparentTitle: "School Spirits",
    parentIndex: 3,
    index: 2,
    ratingKey: "school-spirits-s3e2",
    viewCount: 1,
    originallyAvailableAt: "2025-11-14",
  };
  const requested = { title: "School Spirits", type: "show", ids: {} };

  assert.equal(remoteItemIsWatched(item, "plex"), true);
  const media = remoteItemToMedia(item, "plex", requested);
  assert.ok(media, "episode must still be imported, not dropped");
  assert.equal(media.watched_at, "2025-11-14T00:00:00.000Z");
  assert.match(media.watchProvenance.note, /release date was used instead/);
});

test("a played item with neither a viewed date nor a release date is dropped, not fabricated", () => {
  const item = {
    Type: "Episode",
    Name: "Untitled",
    SeriesName: "No Dates Show",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    Id: "no-date-episode",
    UserData: { Played: true },
  };
  const requested = { title: "No Dates Show", type: "show", ids: {} };
  assert.equal(remoteItemToMedia(item, "emby", requested), null);
});

test("onboarding library import preserves the provider's historical played time", () => {
  const media = plannerMediaToSyncMedia({
    title: "Arrival",
    type: "movie",
    source: "plex",
    timestamp: new Date("2021-04-03T19:42:17.000Z"),
  }, Date.parse("2026-08-25T12:39:02.807Z"));

  assert.equal(media.watched_at, "2021-04-03T19:42:17.000Z");
  assert.equal(media.watchProvenance.source_timestamp, "2021-04-03T19:42:17.000Z");
});

test("onboarding library import never replaces a missing played time with the import time", () => {
  const media = plannerMediaToSyncMedia({
    title: "Undated historical item",
    type: "movie",
    source: "emby",
    timestamp: null,
  }, Date.parse("2026-08-25T12:39:02.807Z"));

  assert.equal(media, null);
});

test("Settings Force Sync stores series ids, not each episode's own ids", async () => {
  const calls = [];
  const resolve = async (media) => {
    calls.push(media.seriesItemId);
    return { ...media, ids: { imdb: "tt18699118", tmdb: "202308", tvdb: "420207" } };
  };
  const items = await withLibrarySeriesIds([
    { type: "episode", source: "emby", title: "Alert - S01E01", seriesItemId: "77", imdb: "tt22043908", tmdb: "3729699", tvdb: "9168790" },
    { type: "episode", source: "emby", title: "Alert - S01E02", seriesItemId: null, tmdb: "4044535" },
    { type: "movie", source: "emby", title: "Heat", tmdb: "949" },
  ], { emby: {} }, resolve);
  assert.deepEqual(calls, ["77"]);
  assert.deepEqual([items[0].imdb, items[0].tmdb, items[0].tvdb], ["tt18699118", "202308", "420207"]);
  assert.equal(items[1].tmdb, "4044535");
  assert.equal(items[2].tmdb, "949");
});

test("a failed series lookup leaves the Force Sync item unchanged", async () => {
  const item = { type: "episode", source: "emby", title: "Alert - S01E01", seriesItemId: "77", tmdb: "3729699" };
  const [result] = await withLibrarySeriesIds([item], {}, async () => { throw new Error("timeout"); });
  assert.equal(result.tmdb, "3729699");
});
