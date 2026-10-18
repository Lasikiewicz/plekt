import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-dismissals-");
const {
  recordUpNextDismissal,
  listUpNextDismissals,
  restoreUpNextDismissal,
  restoreAllUpNextDismissals,
  restoreUpNextDismissalsForMedia,
  restoreUpNextDismissalsSupersededByUnwatch,
  createUpNextDismissalFilter,
} = await import("../server/src/utils/upNextDismissals.js");
const { db } = await import("../server/src/db.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { buildUpNextProjection } = await import("../server/src/utils/upNextService.js");
const { handleUpNextDismissed } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");

const reacher = {
  media_key: "reacher-s04e07",
  media_type: "episode",
  title: "Reacher - S04E07",
  show_title: "Reacher",
  season: 4,
  episode: 7,
  show_ids: { tmdb: "108978" },
  provider_items: { plex: ["4774"] },
};

test("a dismissal matches the same episode under a different provider id", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal(reacher);
  const filter = createUpNextDismissalFilter();

  assert.ok(filter.isDismissed(reacher));
  // Same episode, re-matched to a different native id: the coordinate alias
  // keeps the dismissal attached.
  assert.ok(filter.isDismissed({ ...reacher, provider_items: { emby: ["99999"] }, media_key: "other-key" }));
  // Removing an episode dismisses the whole show, so a different episode with
  // its own native id is hidden as well.
  assert.equal(filter.isDismissed({
    ...reacher,
    episode: 8,
    media_key: "reacher-s04e08",
    provider_items: { plex: ["4775"] },
  }), true);
});

test("dismissing one same-title show leaves the other show's card, dismissal and restore alone", () => {
  restoreAllUpNextDismissals();
  const scrubs2001 = {
    media_key: "episode|series:imdb:tt0285403|s:1|e:6",
    media_type: "episode",
    title: "Scrubs - S01E06",
    show_title: "Scrubs",
    season: 1,
    episode: 6,
    show_imdb_id: "tt0285403",
    show_tmdb_id: "4556",
    show_tvdb_id: "76156",
    provider_items: { plex: ["3265"] },
  };
  const scrubsReboot = {
    media_key: "episode|series:imdb:tt40197357|s:1|e:6",
    media_type: "episode",
    title: "Scrubs - S01E06",
    show_title: "Scrubs",
    season: 1,
    episode: 6,
    show_imdb_id: "tt40197357",
    show_tmdb_id: "295778",
    show_tvdb_id: "465690",
    provider_items: { plex: ["3314"] },
  };
  recordUpNextDismissal(scrubs2001);
  // Same title and coordinate, so show:title and coordinate aliases collide.
  assert.equal(createUpNextDismissalFilter().isDismissed(scrubs2001), true);
  assert.equal(createUpNextDismissalFilter().isDismissed(scrubsReboot), false);

  // Dismissing the reboot adds its own row instead of replacing the 2001 one.
  recordUpNextDismissal(scrubsReboot);
  assert.equal(listUpNextDismissals().length, 2);

  // Unwatching the reboot restores only the reboot's dismissal.
  assert.equal(restoreUpNextDismissalsForMedia(scrubsReboot), 1);
  assert.equal(createUpNextDismissalFilter().isDismissed(scrubs2001), true);
  assert.equal(createUpNextDismissalFilter().isDismissed(scrubsReboot), false);
});

test("re-dismissing the same item replaces its row rather than adding one", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal(reacher);
  recordUpNextDismissal({ ...reacher, media_key: "reacher-s04e07-again" });
  assert.equal(listUpNextDismissals().length, 1);
});

test("restore removes the dismissal", () => {
  restoreAllUpNextDismissals();
  const id = recordUpNextDismissal(reacher);
  assert.equal(listUpNextDismissals().length, 1);
  assert.ok(restoreUpNextDismissal(id));
  assert.equal(listUpNextDismissals().length, 0);
  assert.equal(createUpNextDismissalFilter().isDismissed(reacher), false);
});

test("an explicit unwatch restores the matching show dismissal", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal({
    media_type: "episode",
    show_title: "The Assembly (UK)",
    show_ids: { tvdb: "453869" },
    season: 1,
    episode: 1,
    title: "The Assembly (UK) - S01E01",
  });

  assert.equal(restoreUpNextDismissalsForMedia({
    type: "episode",
    showTitle: "The Assembly (UK)",
    show_tvdb_id: "453869",
    season: 1,
    episode: 1,
  }), 1);
  assert.equal(listUpNextDismissals().length, 0);
});

test("an explicit media-page add restores the matching show dismissal", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal({
    media_type: "episode",
    show_title: "The Assembly (UK)",
    show_ids: { tvdb: "453869" },
    season: 1,
    episode: 1,
    title: "The Assembly (UK) - S01E01",
  });

  // This is the show-only identity sent by POST /api/up-next/show from a
  // media page; it intentionally has no episode coordinate yet.
  assert.equal(restoreUpNextDismissalsForMedia({
    media_type: "episode",
    show_title: "The Assembly (UK)",
    show_tvdb_id: "453869",
  }), 1);
  assert.equal(listUpNextDismissals().length, 0);
});

test("the dismissed list reconciliation removes an older row after an unwatch", () => {
  restoreAllUpNextDismissals();
  recordUpNextDismissal({
    media_type: "episode",
    show_title: "The Assembly",
    show_ids: { tvdb: "453869" },
    season: 1,
    episode: 1,
    title: "The Assembly - S01E01",
  });
  const inserted = insertWatchRecordSync({
    title: "The Assembly (UK) - S01E01",
    media_type: "episode",
    show_title: "The Assembly (UK)",
    tvdb_id: "453869",
    season: 1,
    episode: 1,
    watched_at: "2026-09-15T12:00:00.000Z",
    source: "manual",
    sync_action: "unwatched",
  });
  db.prepare("UPDATE watch_history SET updated_at = ? WHERE id = ?").run(Date.now() + 1, inserted.id);

  assert.equal(restoreUpNextDismissalsSupersededByUnwatch(), 1);
  assert.equal(listUpNextDismissals().length, 0);
});

test("the dismissed list reconciliation preserves a dismissal created after an unwatch", () => {
  restoreAllUpNextDismissals();
  const inserted = insertWatchRecordSync({
    title: "The Assembly (UK) - S01E01",
    media_type: "episode",
    show_title: "The Assembly (UK)",
    tvdb_id: "453869",
    season: 1,
    episode: 1,
    watched_at: "2026-09-15T12:00:00.000Z",
    source: "manual",
    sync_action: "unwatched",
  });
  const unwatchedAt = Date.now();
  db.prepare("UPDATE watch_history SET updated_at = ? WHERE id = ?").run(unwatchedAt, inserted.id);
  recordUpNextDismissal({
    media_type: "episode",
    show_title: "The Assembly (UK)",
    show_ids: { tvdb: "453869" },
    season: 1,
    episode: 1,
    title: "The Assembly (UK) - S01E01",
  }, { now: unwatchedAt + 1 });

  assert.equal(restoreUpNextDismissalsSupersededByUnwatch(), 0);
  assert.equal(listUpNextDismissals().length, 1);
});

test("a dismissal stays after later bookkeeping touches its unwatch row", () => {
  restoreAllUpNextDismissals();
  const inserted = insertWatchRecordSync({
    title: "American Horror Story - S11E03",
    media_type: "episode",
    show_title: "American Horror Story",
    tmdb_id: "1413",
    season: 11,
    episode: 3,
    watched_at: "2026-10-18T18:23:01.453Z",
    source: "manual",
    sync_action: "unwatched",
  });
  const { created_at: unwatchedAt } = db.prepare("SELECT created_at FROM watch_history WHERE id = ?").get(inserted.id);
  // Remove from Up Next records the dismissal just after its unwatch...
  recordUpNextDismissal({
    media_type: "episode",
    show_title: "American Horror Story",
    show_ids: { tmdb: "1413" },
    season: 11,
    episode: 3,
    title: "American Horror Story - S11E03",
  }, { now: unwatchedAt + 1 });
  // ...and dispatch telemetry rewrites the unwatch row minutes later.
  db.prepare("UPDATE watch_history SET updated_at = ? WHERE id = ?").run(unwatchedAt + 13 * 60 * 1000, inserted.id);

  assert.equal(restoreUpNextDismissalsSupersededByUnwatch(), 0);
  assert.equal(listUpNextDismissals().length, 1);
});

test("the projection hides a dismissed item from every device", async () => {
  restoreAllUpNextDismissals();
  const options = {
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    shows: [{ title: "Reacher", tmdb_id: "108978", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "4774",
      media_type: "episode",
      title: "Reacher - S04E07",
      show_title: "Reacher",
      season: 4,
      episode: 7,
      show_ids: { tmdb: "108978" },
      air_date: "2026-09-08",
    }, {
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "4775",
      media_type: "episode",
      title: "Reacher - S04E08",
      show_title: "Reacher",
      season: 4,
      episode: 8,
      show_ids: { tmdb: "108978" },
      air_date: "2026-09-09",
    }],
  };

  const before = await buildUpNextProjection(options);
  // The projection intentionally collapses a show's next-up observations to
  // one card; the show-scoped dismissal still hides that card completely.
  assert.equal(before.items.length, 1);

  recordUpNextDismissal(before.items[0]);
  const after = await buildUpNextProjection(options);
  assert.equal(after.items.length, 0);

  restoreAllUpNextDismissals();
  const restored = await buildUpNextProjection(options);
  assert.equal(restored.items.length, 1);
});

test("a dismissed item comes back once it is genuinely played again", async () => {
  restoreAllUpNextDismissals();
  const dismissedAt = Date.parse("2026-09-13T10:00:00.000Z");
  recordUpNextDismissal({
    media_key: "movie:tmdb:77",
    media_type: "movie",
    title: "A Dismissed Movie",
    ids: { tmdb: "77" },
  }, { now: dismissedAt });

  const rows = (updatedAt, positionMs) => ([{
    media_key: "movie:tmdb:77",
    media_type: "movie",
    title: "A Dismissed Movie",
    tmdb_id: "77",
    position_ms: positionMs,
    duration_ms: 1200000,
    progress: 25,
    updated_at: updatedAt,
    source: "local",
  }]);

  // Older progress than the dismissal stays hidden.
  const stale = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    localFallback: false,
    playstateRows: [],
    providerItems: [],
    progressRows: rows(dismissedAt - 60000, 300000),
  });
  assert.equal(stale.items.length, 0);

  // A newer real position outranks it.
  const fresh = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    localFallback: false,
    playstateRows: [],
    providerItems: [],
    progressRows: rows(dismissedAt + 60000, 300000),
  });
  assert.equal(fresh.items.length, 1);
});

test("dismissed title-only snapshots reuse the cached show poster", async () => {
  restoreAllUpNextDismissals();
  insertWatchRecordSync({
    title: "Poster Recovery Show - S01E01",
    show_title: "Poster Recovery Show",
    episode_title: "Pilot",
    media_type: "episode",
    season: 1,
    episode: 1,
    poster_url: "/media/posters/poster-recovery.webp",
    watched_at: "2026-09-15T12:00:00.000Z",
    source: "manual",
  });
  recordUpNextDismissal({
    media_key: "poster-recovery-show-s01e02",
    media_type: "episode",
    title: "Poster Recovery Show - S01E02",
    show_title: "Poster Recovery Show",
    season: 1,
    episode: 2,
  });

  let responseData = null;
  const response = {
    status() { return this; },
    set() { return this; },
    send(data) {
      responseData = JSON.parse(data);
      return this;
    },
  };
  const request = {
    method: "GET",
    headers: { authorization: `Bearer ${AUTH.apiKey}` },
    get(name) { return this.headers[name.toLowerCase()]; },
  };

  await handleUpNextDismissed(request, response);
  assert.equal(responseData?.items?.length, 1);
  assert.equal(responseData.items[0].item.show_poster_url, "/media/posters/poster-recovery.webp");
});
