import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-review-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
const { applyManualUnwatch } = await import("../server/src/routes/sync.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { checkIncomingEpisodeSourceMismatch } = await import("../server/src/utils/sourceMismatch.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const {
  countPendingManualWatchReviews,
  dismissPendingManualWatchReviewsForMedia,
  enqueueManualWatchReview,
  enqueueSourceMismatchReview,
  getManualWatchReview,
  listPendingManualWatchReviews,
  listPendingManualWatchReviewsCached,
  manualWatchReviewWatchContext,
  setManualWatchReviewStatus,
} = await import("../server/src/utils/manualWatchReview.js");

test.after(() => db.close());

test("source mismatch review dismissals persist for the same show ids and re-flag when an id changes", () => {
  const mismatch = {
    title: "Naruto - S01E52", showTitle: "Naruto", type: "episode", season: 1, episode: 52,
    episodeTitle: "The title", source: "plex", ids: { tmdb: "100", tvdb: "200" },
    mismatch: { stored: { season: 1, episode: 35 }, incoming: { season: 1, episode: 52 }, otherSource: "tmdb" },
  };
  const first = enqueueSourceMismatchReview(mismatch, { fingerprint: "100:200" });
  assert.equal(first.queued, true);
  assert.equal(first.review.review_kind, "source_mismatch");
  const duplicate = enqueueSourceMismatchReview(mismatch, { fingerprint: "100:200" });
  assert.equal(duplicate.queued, true);
  assert.equal(duplicate.review.id, first.review.id);
  assert.equal(listPendingManualWatchReviews().filter((review) => review.review_kind === "source_mismatch").length, 1);
  setManualWatchReviewStatus(first.review.id, "dismissed", "source_mismatch");
  assert.equal(enqueueSourceMismatchReview(mismatch, { fingerprint: "100:200" }).status, "dismissed");
  const changed = enqueueSourceMismatchReview({ ...mismatch, ids: { tmdb: "101", tvdb: "200" } }, { fingerprint: "101:200" });
  assert.equal(changed.queued, true);
  assert.notEqual(changed.review.id, first.review.id);
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === changed.review.id), true);
  setManualWatchReviewStatus(changed.review.id, "dismissed", "source_mismatch");
  const singleId = { title: "Single Id Show - S01E01", showTitle: "Single Id Show", type: "episode", season: 1, episode: 1, episodeTitle: "Pilot", ids: { tmdb: "single-tmdb" } };
  const single = enqueueSourceMismatchReview(singleId, { fingerprint: "single-tmdb:" });
  setManualWatchReviewStatus(single.review.id, "dismissed", "source_mismatch");
  assert.equal(enqueueSourceMismatchReview(singleId, { fingerprint: "single-tmdb:" }).status, "dismissed");
  assert.equal(enqueueSourceMismatchReview({ ...singleId, ids: { tmdb: "changed-tmdb" } }, { fingerprint: "changed-tmdb:" }).queued, true, "changing the only source id clears the dismissal");
  assert.equal(enqueueSourceMismatchReview({ ...singleId, ids: { tmdb: "single-tmdb", tvdb: "new-tvdb" } }, { fingerprint: "single-tmdb:new-tvdb" }).queued, true, "adding the second source id clears the dismissal");
  db.prepare("DELETE FROM manual_watch_reviews WHERE media_key LIKE 'source-mismatch:%'").run();
});

test("dismissing a source mismatch review changes no watch history or playstate", async () => {
  const queued = enqueueSourceMismatchReview({
    title: "Review Safety Show - S01E05", showTitle: "Review Safety Show", type: "episode",
    season: 1, episode: 5, episodeTitle: "Example", source: "plex", ids: { tmdb: "safety-tmdb", tvdb: "safety-tvdb" },
    mismatch: { stored: { season: 1, episode: 8 }, incoming: { season: 1, episode: 5 }, otherSource: "tmdb" },
  }, { fingerprint: "safety-tmdb:safety-tvdb" });
  const beforeHistory = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  const beforePlaystate = db.prepare("SELECT COUNT(*) AS count FROM playstate").get().count;
  const request = {
    method: "POST", headers: { "x-api-key": AUTH.apiKey }, cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  const reply = { statusCode: 200, body: null };
  const response = {
    status(code) { reply.statusCode = code; return this; },
    set() { return this; },
    send(payload) { reply.body = JSON.parse(payload); return this; },
  };
  await handleManualWatchReview(request, response, `manual-watch-review/${encodeURIComponent(queued.review.id)}/dismiss`);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.body.status, "dismissed");
  assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, beforeHistory);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playstate").get().count, beforePlaystate);
  db.prepare("DELETE FROM manual_watch_reviews WHERE media_key LIKE 'source-mismatch:%'").run();
});

test("incoming mismatch checks flag alternate-source numbering, ignore matching-number title variants, and tolerate provider failures", async () => {
  const insertStored = (key, { title, episodeTitle, season, episode }) => db.prepare(`
    INSERT INTO watch_history (id, title, media_type, watched_at, source, tmdb_id, tvdb_id, season, episode, sync_action, show_title, episode_title)
    VALUES (?, ?, 'episode', '2025-01-01T00:00:00.000Z', 'manual', 'tmdb-${key}', 'tvdb-${key}', ?, ?, 'watched', 'Naruto', ?)
  `).run(`row-${key}`, `Naruto - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - ${episodeTitle}`, season, episode, episodeTitle);
  insertStored("mismatch", { season: 1, episode: 52, episodeTitle: "The Showdown" });
  setShowSeasonSource("tvdb-mismatch", "tmdb", { rowNumbering: "tmdb" });
  const incoming = { type: "episode", title: "Naruto - S01E35 - The Showdown", showTitle: "Naruto", season: 1, episode: 35, episodeTitle: "The Showdown", source: "plex", ids: { tmdb: "tmdb-mismatch", tvdb: "tvdb-mismatch" } };
  let lookupCount = 0;
  const match = await checkIncomingEpisodeSourceMismatch(incoming, {
    runKey: "mismatch-unit",
    loadTvdbSeasonEpisodes: async () => { lookupCount += 1; return { episodes: [{ season_number: 1, episode_number: 35, name: "The Showdown" }] }; },
  });
  assert.equal(match.status, "match");
  assert.equal(match.queued, true);
  await checkIncomingEpisodeSourceMismatch({ ...incoming, title: "Naruto - S01E36 - Another Episode", episode: 36 }, { runKey: "mismatch-unit" });
  assert.equal(lookupCount, 1, "one conflicting show spends at most one alternate-source lookup per run");

  insertStored("variation", { season: 1, episode: 35, episodeTitle: "The Showdown" });
  const titleVariation = await checkIncomingEpisodeSourceMismatch({ ...incoming, title: "Naruto - S01E35 - The Showdown (Extended)", season: 1, episode: 35, episodeTitle: "The Showdown (Extended)", ids: { tmdb: "tmdb-variation", tvdb: "tvdb-variation" } }, { runKey: "variation-unit" });
  assert.equal(titleVariation.status, "no_match");

  const bothDisagree = await checkIncomingEpisodeSourceMismatch(incoming, {
    runKey: "both-disagree-unit",
    loadTvdbSeasonEpisodes: async () => ({ episodes: [{ season_number: 1, episode_number: 99, name: "The Showdown" }] }),
  });
  assert.equal(bothDisagree.status, "no_match");

  insertStored("outage", { season: 1, episode: 52, episodeTitle: "The Outage" });
  setShowSeasonSource("tvdb-outage", "tmdb", { rowNumbering: "tmdb" });
  const outage = await checkIncomingEpisodeSourceMismatch({ ...incoming, title: "Naruto - S01E35 - The Outage", season: 1, episode: 35, episodeTitle: "The Outage", ids: { tmdb: "tmdb-outage", tvdb: "tvdb-outage" } }, {
    runKey: "outage-unit",
    loadTmdbSeasonEpisodes: async () => { throw new Error("offline"); },
  });
  assert.equal(outage.status, "unknown");
  setManualWatchReviewStatus(match.review.id, "dismissed", "source_mismatch");
  db.prepare("DELETE FROM manual_watch_reviews WHERE media_key LIKE 'source-mismatch:%'").run();
});

const media = {
  title: "Ted - S02E01",
  showTitle: "Ted",
  type: "episode",
  season: 2,
  episode: 1,
  episodeTitle: "The New Frontier",
  source: "plex",
  itemId: "plex-episode-201",
  ids: { tvdb: "404604", tmdb: "123456" },
  releaseDate: "2024-08-22",
  runtimeMinutes: 24,
  isValid: true,
};

test("manual watch reviews are durable, deduplicated, and re-open on a changed provider snapshot", () => {
  const first = enqueueManualWatchReview(media, {
    releaseDate: "2024-08-22T00:00:00.000Z",
    sourceFingerprint: "plex|episode|plex-episode-201|1",
    reason: "manual flag",
  });
  assert.equal(first.queued, true);
  assert.equal(first.status, "pending");
  assert.equal(countPendingManualWatchReviews(), 1);
  assert.equal(listPendingManualWatchReviews()[0].media.episodeTitle, "The New Frontier");

  const duplicate = enqueueManualWatchReview(media, {
    releaseDate: "2024-08-22T00:00:00.000Z",
    sourceFingerprint: "plex|episode|plex-episode-201|1",
  });
  assert.equal(duplicate.queued, true, "a pending review can be refreshed without creating another row");
  assert.equal(duplicate.review.id, first.review.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count, 1);

  setManualWatchReviewStatus(first.review.id, "dismissed");
  assert.equal(countPendingManualWatchReviews(), 0);
  const sameSnapshot = enqueueManualWatchReview(media, {
    sourceFingerprint: "plex|episode|plex-episode-201|1",
  });
  assert.equal(sameSnapshot.queued, false);
  assert.equal(sameSnapshot.status, "dismissed");

  const changedSnapshot = enqueueManualWatchReview(media, {
    sourceFingerprint: "plex|episode|plex-episode-201|2",
  });
  assert.equal(changedSnapshot.queued, true);
  assert.equal(changedSnapshot.status, "pending");
  assert.equal(countPendingManualWatchReviews(), 1);
  assert.equal(getManualWatchReview(first.review.id).status, "pending");
});

test("a pending review is hidden when an older watched record already exists", async () => {
  const reviewMedia = {
    title: "Existing Date Review Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-existing-date-review-movie",
    ids: { tmdb: "existing-date-review-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.insertWatchRecord({
    title: reviewMedia.title,
    media_type: "movie",
    tmdb_id: reviewMedia.ids.tmdb,
    watched_at: "2026-08-01T12:00:00.000Z",
    source: "plex",
    sync_action: "watched",
  });

  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|existing-date-review-movie|1",
  });

  assert.equal(queued.status, "already_watched");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("approved reviews stay closed when the same provider flag is seen again", () => {
  const review = listPendingManualWatchReviews()[0];
  setManualWatchReviewStatus(review.id, "approved", "now");
  const result = enqueueManualWatchReview(media, { sourceFingerprint: "plex|episode|plex-episode-201|2" });
  assert.equal(result.queued, false);
  assert.equal(result.status, "approved");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("pending reviews are hidden after the item becomes canonically watched", async () => {
  const reviewMedia = {
    title: "Stale Review Show - S04E02",
    showTitle: "Stale Review Show",
    type: "episode",
    season: 4,
    episode: 2,
    episodeTitle: "The Already Watched Episode",
    source: "plex",
    itemId: "plex-stale-review-402",
    ids: { tvdb: "stale-review-tvdb-402" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|stale-review-402|1",
  });
  assert.equal(queued.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), true);

  await repo.upsertPlaystateForMedia(reviewMedia, "watched", "2026-09-07T12:00:00.000Z", { skipInvalidate: true });

  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);
  assert.equal(countPendingManualWatchReviews(), 0);
  // Closed, not left pending out of sight (user decision, 24 September 2026).
  const closed = getManualWatchReview(queued.review.id);
  assert.equal(closed.status, "dismissed");
  assert.equal(closed.decision_mode ?? closed.decisionMode, "resolved_by_local_state");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews WHERE id = ? AND status = 'pending'").get(queued.review.id).count, 0);
  const repeat = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|stale-review-402|2",
  });
  assert.equal(repeat.queued, false);
  assert.equal(repeat.status, "already_watched");
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("a review is ignored when Plembfin already marked the whole show watched", () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count;
  const result = enqueueManualWatchReview({
    title: "Already Complete Show - S02E04",
    showTitle: "Already Complete Show",
    type: "episode",
    season: 2,
    episode: 4,
    source: "plex",
    itemId: "plex-already-complete-s02e04",
    ids: { tvdb: "already-complete-episode" },
    showWatchedEpisodes: 8,
    showTotalEpisodes: 8,
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|already-complete-s02e04|1",
  });

  assert.equal(result.queued, false);
  assert.equal(result.status, "already_watched");
  assert.equal(result.suppressed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_watch_reviews").get().count, before);
});

test("episode reviews expose the watched state of the surrounding episodes", async () => {
  const previous = {
    title: "Review Context Show - S01E01",
    showTitle: "Review Context Show",
    type: "episode",
    source: "manual",
    ids: { tmdb: "review-context-show" },
    season: 1,
    episode: 1,
    watched_at: "2026-09-01T19:00:00.000Z",
    isValid: true,
  };
  const following = {
    ...previous,
    title: "Review Context Show - S01E03",
    season: 1,
    episode: 3,
    watched_at: "2026-09-01T20:00:00.000Z",
  };
  await repo.upsertPlaystateForMedia(previous, "watched", previous.watched_at, { skipInvalidate: true });
  await repo.upsertPlaystateForMedia(following, "watched", following.watched_at, { skipInvalidate: true });

  const queued = enqueueManualWatchReview({
    title: "Review Context Show - S01E02",
    showTitle: "Review Context Show",
    type: "episode",
    source: "plex",
    itemId: "plex-review-context-s01e02",
    ids: { tvdb: "review-context-episode-2" },
    season: 1,
    episode: 2,
    isValid: true,
  }, {
    releaseDate: "2026-09-01T00:00:00.000Z",
    sourceFingerprint: "plex|review-context-s01e02|1",
  });

  assert.equal(queued.status, "pending");
  assert.deepEqual({
    before: queued.review.watch_context.before.watched,
    after: queued.review.watch_context.after.watched,
  }, { before: true, after: true });
  assert.deepEqual(manualWatchReviewWatchContext(queued.review).before, queued.review.watch_context.before);
  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("pending reviews are hidden and retired after an explicit unwatch", async () => {
  const reviewMedia = {
    title: "Unwatched Review Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-unwatched-review-movie",
    ids: { tmdb: "unwatched-review-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|unwatched-review-movie|1",
  });
  assert.equal(queued.status, "pending");

  const unwatch = await applyManualUnwatch(
    reviewMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );
  assert.equal(unwatch.alreadyUnwatched, false);
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === queued.review.id), false);

  assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "unwatched");
});

test("manual movie unwatch clears a provider-id alias when part numbers use words and roman numerals", async () => {
  const reviewMedia = {
    title: "Alias Guard Movie: Part One",
    type: "movie",
    source: "plex",
    isValid: true,
  };
  const importedMedia = {
    title: "Alias Guard Movie: Part I",
    media_type: "movie",
    imdb_id: "tt99123451",
    tmdb_id: "9912345",
    tvdb_id: "299123",
    watched_at: "2026-08-01T10:00:00.000Z",
    source: "trakt_import",
    sync_action: "watched",
  };
  await repo.insertWatchRecord(importedMedia);

  const queued = enqueueManualWatchReview(reviewMedia, {
    releaseDate: "2026-08-01",
    sourceFingerprint: "plex|alias-guard-movie-part-one|1",
  });
  assert.equal(queued.status, "pending");

  await applyManualUnwatch(
    reviewMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );

  const importedKey = repo.mediaKeyFor({
    type: "movie",
    title: reviewMedia.title,
    ids: {
      imdb: importedMedia.imdb_id,
      tmdb: importedMedia.tmdb_id,
      tvdb: importedMedia.tvdb_id,
    },
  });
  const watchedAlias = db.prepare(
    "SELECT id FROM watch_history WHERE media_key = ? AND sync_action = 'watched' LIMIT 1",
  ).get(importedKey);
  assert.equal(watchedAlias, undefined);

  const tombstone = db.prepare(
    "SELECT sync_action FROM watch_history WHERE media_key = ? ORDER BY id DESC LIMIT 1",
  ).get(importedKey);
  assert.equal(tombstone?.sync_action, "unwatched");

  const playstate = db.prepare(
    "SELECT state FROM playstate WHERE media_key = ? LIMIT 1",
  ).get(importedKey);
  assert.equal(playstate?.state, "unwatched");

  const review = getManualWatchReview(queued.review.id);
  assert.equal(review.status, "dismissed");
  assert.equal(review.decision_mode, "unwatched");
});

test("generic provider watched flags are suppressed while the canonical state is unwatched", async () => {
  const media = {
    title: "Suppressed Stale Flag Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-suppressed-stale-flag-movie",
    ids: { tmdb: "suppressed-stale-flag-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|suppressed-stale-flag-movie|1",
  });
  assert.equal(result.queued, false);
  assert.equal(result.status, "unwatched");
  assert.equal(result.suppressed, true);
  assert.equal(result.review, null);
});

test("review-required provider flags can be held for a decision while locally unwatched", async () => {
  const media = {
    title: "Held Provider Flag Movie",
    type: "movie",
    source: "jellyfin",
    itemId: "jellyfin-held-provider-flag-movie",
    ids: { tmdb: "held-provider-flag-movie" },
    releaseDate: "2026-08-01",
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "jellyfin|held-provider-flag-movie|1",
    allowWhenUnwatched: true,
  });
  assert.equal(result.queued, true);
  assert.equal(result.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === result.review.id), true);
  setManualWatchReviewStatus(result.review.id, "dismissed");
});

test("a manual unwatch tombstone suppresses a provider alias with a title-normalization mismatch", async () => {
  const localMedia = {
    title: "Alias Guard Movie:\u00a0Part II",
    type: "movie",
    source: "plex",
    itemId: "plex-alias-guard-movie",
    ids: { tmdb: "alias-guard-local" },
    isValid: true,
  };
  await applyManualUnwatch(
    localMedia,
    {
      plex: { disabled: true },
      emby: { disabled: true },
      jellyfin: { disabled: true },
    },
    createLoopStore(),
    "",
    { includeSourcePlatform: true, trackDispatch: false, force: true, lane: "interactive" },
  );

  const providerAlias = {
    ...localMedia,
    title: "Alias Guard Movie: Part II",
    source: "emby",
    itemId: "emby-alias-guard-movie",
    ids: { tmdb: "alias-guard-provider" },
  };
  const result = enqueueManualWatchReview(providerAlias, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|alias-guard-movie|1",
  });
  assert.equal(result.queued, false);
  assert.equal(result.status, "unwatched");
  assert.equal(result.suppressed, true);
});

test("explicit provider Mark played events can still open a review after an unwatch", async () => {
  const media = {
    title: "Explicit Provider Rewatch Movie",
    type: "movie",
    source: "emby",
    event: "item.markplayed",
    itemId: "emby-explicit-provider-rewatch-movie",
    ids: { tmdb: "explicit-provider-rewatch-movie" },
    releaseDate: "2026-08-01",
    watchProvenance: { source: "emby", event: "item.markplayed" },
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-09-08T16:48:00.000Z", { skipInvalidate: true });

  const result = enqueueManualWatchReview(media, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "emby|explicit-provider-rewatch-movie|1",
  });
  assert.equal(result.queued, true);
  assert.equal(result.status, "pending");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === result.review.id), true);
  setManualWatchReviewStatus(result.review.id, "dismissed");
});

test("mark watched now updates an existing cross-key watch instead of keeping its old date", async () => {
  const title = "Existing Review Show - S01E01 - Pilot";
  const showTitle = "Existing Review Show";
  const oldDate = "2026-08-01T10:00:00.000Z";
  const queued = enqueueManualWatchReview({
    title,
    showTitle,
    type: "episode",
    season: 1,
    episode: 1,
    source: "plex",
    itemId: "plex-review-existing",
    releaseDate: "2026-07-01",
    ids: {},
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "plex|review-existing|1",
  });
  assert.equal(queued.status, "pending");

  const existing = await repo.insertWatchRecord({
    title,
    show_title: showTitle,
    media_type: "episode",
    season: 1,
    episode: 1,
    imdb_id: "review-existing-imdb",
    watched_at: oldDate,
    source: "trakt_import",
    sync_action: "watched",
  });
  const request = {
    method: "POST",
    body: { mode: "now" },
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let responseBody = null;
  const response = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(payload) { responseBody = JSON.parse(payload); return this; },
  };
  const before = Date.now();
  await handleManualWatchReview(
    request,
    response,
    `manual-watch-review/${encodeURIComponent(queued.review.id)}/approve`,
  );
  const after = Date.now();

  assert.equal(statusCode, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.mode, "now");
  assert.equal(responseBody.existing, true);
  assert.equal(responseBody.watchRecordId, existing.id);
  assert.notEqual(responseBody.watchedAt, oldDate);
  assert.ok(Date.parse(responseBody.watchedAt) >= before - 1_000);
  assert.ok(Date.parse(responseBody.watchedAt) <= after + 1_000);

  const stored = db.prepare("SELECT watched_at FROM watch_history WHERE id = ?").get(existing.id);
  assert.equal(stored.watched_at, responseBody.watchedAt);
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "now");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("manual watch review accepts an explicit date and time", async () => {
  const queued = enqueueManualWatchReview({
    title: "Manual Date Movie",
    type: "movie",
    source: "emby",
    itemId: "emby-manual-date-movie",
    ids: { tmdb: "manual-date-movie" },
    releaseDate: "2026-07-01",
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "emby|manual-date-movie|1",
  });
  assert.equal(queued.status, "pending");

  const request = {
    method: "POST",
    body: { mode: "custom", watched_at: "2026-08-15T18:45:00.000Z" },
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let responseBody = null;
  const response = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(payload) { responseBody = JSON.parse(payload); return this; },
  };

  await handleManualWatchReview(
    request,
    response,
    `manual-watch-review/${encodeURIComponent(queued.review.id)}/approve`,
  );

  assert.equal(statusCode, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.mode, "custom");
  assert.equal(responseBody.watchedAt, "2026-08-15T18:45:00.000Z");
  assert.equal(getManualWatchReview(queued.review.id).decision_mode, "custom");
  assert.equal(countPendingManualWatchReviews(), 0);
});

test("dismissing a review marks it unwatched across connected media apps", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  await saveMediaConfig({
    plex: { baseUrl: "http://plex-review.test", token: "plex-token", disabled: false },
    emby: { baseUrl: "http://emby-review.test", apiKey: "emby-key", userId: "emby-user", disabled: false },
    jellyfin: { baseUrl: "http://jellyfin-review.test", apiKey: "jellyfin-key", userId: "jellyfin-user", disabled: false },
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({}) };
  };

  for (const source of ["plex", "emby", "jellyfin"]) {
    const queued = enqueueManualWatchReview({
      title: `Dismiss ${source} Movie`,
      type: "movie",
      source,
      itemId: `${source}-dismiss-item`,
      ids: { tmdb: `dismiss-${source}` },
      releaseDate: "2026-07-01",
      isValid: true,
    }, {
      releaseDate: "2026-07-01T00:00:00.000Z",
      sourceFingerprint: `${source}|dismiss|1`,
    });
    assert.equal(queued.status, "pending");

    const request = {
      method: "POST",
      headers: { "x-api-key": AUTH.apiKey },
      cookies: {},
      get(name) { return this.headers[String(name).toLowerCase()] || ""; },
    };
    let statusCode = 200;
    let responseBody = null;
    const response = {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(payload) { responseBody = JSON.parse(payload); return this; },
    };

    const beforeCalls = calls.length;
    await handleManualWatchReview(
      request,
      response,
      `manual-watch-review/${encodeURIComponent(queued.review.id)}/dismiss`,
    );

    assert.equal(statusCode, 200);
    assert.equal(responseBody.ok, true);
    assert.equal(responseBody.action, "unwatched");
    assert.equal(responseBody.source, source);
    assert.deepEqual(
      responseBody.targetStates.map((target) => target.target).sort(),
      ["emby", "jellyfin", "plex"],
    );
    assert.ok(responseBody.targetStates.every((target) => (
      target.status === "success"
      || (target.status === "skipped" && /no matching item found/i.test(target.detail || ""))
    )));
    assert.equal(getManualWatchReview(queued.review.id).status, "dismissed");

    const sourceCalls = calls.slice(beforeCalls);
    assert.ok(sourceCalls.length > 0);
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://plex-review.test/")));
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://emby-review.test/")));
    assert.ok(sourceCalls.some(({ url }) => url.startsWith("http://jellyfin-review.test/")));
  }

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return { ok: false, status: 503, headers: { get: () => "" }, json: async () => ({}) };
  };
  const failed = enqueueManualWatchReview({
    title: "Provider Failure Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-failure-item",
    ids: { tmdb: "dismiss-failure" },
    releaseDate: "2026-07-01",
    isValid: true,
  }, {
    releaseDate: "2026-07-01T00:00:00.000Z",
    sourceFingerprint: "plex|failure|1",
  });
  const failedRequest = {
    method: "POST",
    headers: { "x-api-key": AUTH.apiKey },
    cookies: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let failedStatusCode = 200;
  let failedResponseBody = null;
  const failedResponse = {
    status(code) { failedStatusCode = code; return this; },
    set() { return this; },
    send(payload) { failedResponseBody = JSON.parse(payload); return this; },
  };
  await handleManualWatchReview(
    failedRequest,
    failedResponse,
    `manual-watch-review/${encodeURIComponent(failed.review.id)}/dismiss`,
  );
  assert.equal(failedStatusCode, 409);
  assert.match(failedResponseBody.error, /Could not complete the unwatched correction/);
  assert.match(failedResponseBody.error, /Failed on (Plex|Emby|Jellyfin)/);
  assert.ok(Array.isArray(failedResponseBody.failureTargets));
  assert.ok(failedResponseBody.failureTargets.some((target) => target.provider === "Plex"));
  assert.ok(failedResponseBody.failureTargets.every((target) => target.target && target.status && target.detail));
  assert.match(failedResponseBody.error, /remains pending/i);
  assert.equal(getManualWatchReview(failed.review.id).status, "pending");
});

// Verified live (Up Next matrix defect AI): a Plex review for Scrubs 2001
// S01E04 was stored with no provider ids. Dismissing it applied the unwatch by
// title and coordinate, which also unmarked the 2026 reboot's S01E04 locally
// and on every provider.
test("dismissing an id-less episode review resolves its show from the reporting item", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await saveMediaConfig({
    plex: { baseUrl: "http://plex-ai.test", token: "plex-token", disabled: false },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  });
  const original = { imdb: "tt0285403", tmdb: "4556", tvdb: "76156" };
  const reboot = { imdb: "tt40197357", tmdb: "295778", tvdb: "465690" };
  const episodeMedia = (ids, episode) => ({
    title: `Scrubs - S01E0${episode}`, showTitle: "Scrubs", type: "episode", season: 1, episode, source: "manual", isValid: true, ids,
  });
  const seedWatches = async () => {
    for (const [ids, episode] of [[original, 3], [original, 4], [reboot, 3], [reboot, 4]]) {
      const result = await repo.insertWatchRecord({
        title: `Scrubs - S01E0${episode}`, show_title: "Scrubs", media_type: "episode", source: "manual",
        watched_at: `2026-09-0${episode}T01:00:00.000Z`, season: 1, episode,
        imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb, sync_dispatch_telemetry: "Dispatch status: success",
      });
      await result.assetPrefetch;
      await repo.upsertPlaystateForMedia(episodeMedia(ids, episode), "watched", `2026-09-0${episode}T01:00:00.000Z`);
    }
  };

  let plexItemReadable = true;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/library/metadata/3263") {
      if (!plexItemReadable) return { ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ MediaContainer: { Metadata: [{ ratingKey: "3263", grandparentRatingKey: "3200" }] } }) };
    }
    if (path === "/library/metadata/3200") {
      return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ MediaContainer: { Metadata: [{ ratingKey: "3200", Guid: [{ id: "imdb://tt0285403" }, { id: "tmdb://4556" }, { id: "tvdb://76156" }] }] } }) };
    }
    return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({}) };
  };

  const dismiss = async (reviewId) => {
    const request = {
      method: "POST",
      headers: { "x-api-key": AUTH.apiKey },
      cookies: {},
      get(name) { return this.headers[String(name).toLowerCase()] || ""; },
    };
    const reply = { statusCode: 200, body: null };
    const response = {
      status(code) { reply.statusCode = code; return this; },
      set() { return this; },
      send(payload) { reply.body = JSON.parse(payload); return this; },
    };
    await handleManualWatchReview(request, response, `manual-watch-review/${encodeURIComponent(reviewId)}/dismiss`);
    return reply;
  };
  const queue = (fingerprint) => enqueueManualWatchReview({
    title: "Scrubs - S01E04", showTitle: "Scrubs", type: "episode", season: 1, episode: 4, source: "plex",
    ids: {}, showIds: {}, isValid: true,
    watchProvenance: { version: 1, source: "plex", ingest_path: "plex_scheduled_library_history", item_id: "3263" },
  }, { releaseDate: "2001-10-16T00:00:00.000Z", sourceFingerprint: fingerprint, allowWhenUnwatched: true });

  plexItemReadable = false;
  // Queued before the watches exist, as live: the review was raised while the
  // episode read unwatched.
  const unreadable = queue("plex|ai|3263|1");
  assert.equal(unreadable.status, "pending");
  await seedWatches();
  const refused = await dismiss(unreadable.review.id);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body.error, /Could not confirm which show/);
  assert.equal(getManualWatchReview(unreadable.review.id).status, "pending");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(original, 4))?.state, "watched");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(reboot, 4))?.state, "watched");

  plexItemReadable = true;
  const reply = await dismiss(unreadable.review.id);
  assert.equal(reply.statusCode, 200);
  assert.equal(getManualWatchReview(unreadable.review.id).status, "dismissed");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(original, 4))?.state, "unwatched");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(reboot, 4))?.state, "watched");
});

test("an unwatch of one same-title show does not retire the other show's pending review by title", async () => {
  // Live: a manual unwatch of 2001 Scrubs S01E05 retired the reboot's S01E05
  // reviews as dismissed, matched only by title and coordinate.
  const first = { imdb: "tt91001", tmdb: "91001", tvdb: "91101" };
  const second = { imdb: "tt91002", tmdb: "91002", tvdb: "91102" };
  for (const [ids, episode] of [[first, 1], [first, 3], [second, 1], [second, 3]]) {
    const result = await repo.insertWatchRecord({
      title: `Twin Clinic - S01E0${episode}`, show_title: "Twin Clinic", media_type: "episode", source: "manual",
      watched_at: `2026-09-0${episode}T01:00:00.000Z`, season: 1, episode,
      imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb, sync_dispatch_telemetry: "Dispatch status: success",
    });
    await result.assetPrefetch;
  }
  const review = (ids, fingerprint) => enqueueManualWatchReview({
    title: "Twin Clinic - S01E02", showTitle: "Twin Clinic", type: "episode", season: 1, episode: 2, source: "plex",
    ids, isValid: true,
  }, { releaseDate: "2026-01-01T00:00:00.000Z", sourceFingerprint: fingerprint, allowWhenUnwatched: true });
  const idless = review({}, "plex|twin-clinic|idless");
  const own = review(first, "plex|twin-clinic|own");
  assert.equal(idless.status, "pending");
  assert.equal(own.status, "pending");

  const retired = dismissPendingManualWatchReviewsForMedia({
    title: "Twin Clinic - S01E02", showTitle: "Twin Clinic", type: "episode", season: 1, episode: 2, ids: first,
  });
  assert.equal(retired, 1);
  assert.equal(getManualWatchReview(own.review.id).status, "dismissed");
  assert.equal(getManualWatchReview(idless.review.id).status, "pending", "a title-only match must not retire it");
});

test("the cached pending listing is reused until a review changes or its ceiling passes", () => {
  const queued = enqueueManualWatchReview({
    title: "Cached Listing Movie",
    type: "movie",
    source: "plex",
    itemId: "plex-cached-listing-movie",
    ids: { tmdb: "cached-listing-movie" },
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|cached-listing-movie|1",
  });
  assert.equal(queued.status, "pending");

  const now = Date.now();
  const first = listPendingManualWatchReviewsCached({ now });
  assert.ok(first.some((review) => review.id === queued.review.id));
  assert.equal(listPendingManualWatchReviewsCached({ now: now + 1000 }), first, "an unchanged listing is served from the cache");
  assert.notEqual(listPendingManualWatchReviewsCached({ now: now + 16_000 }), first, "the ceiling forces a rebuild");

  // Deciding a review changes the pending set; the next read must not show it.
  const beforeDecision = listPendingManualWatchReviewsCached({ now: now + 16_500 });
  setManualWatchReviewStatus(queued.review.id, "dismissed");
  const afterDecision = listPendingManualWatchReviewsCached({ now: now + 17_000 });
  assert.notEqual(afterDecision, beforeDecision);
  assert.ok(!afterDecision.some((review) => review.id === queued.review.id));
});

test("the cached summary listing skips episode watch context while the full listing keeps it", () => {
  const queued = enqueueManualWatchReview({
    title: "Cached Listing Episode - S01E01",
    showTitle: "Cached Listing Episode",
    type: "episode",
    season: 1,
    episode: 1,
    source: "plex",
    itemId: "plex-cached-listing-episode",
    ids: { tmdb: "cached-listing-episode" },
    isValid: true,
  }, {
    releaseDate: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "plex|cached-listing-episode|1",
  });
  assert.equal(queued.status, "pending");

  const now = Date.now() + 30_000;
  const summary = listPendingManualWatchReviewsCached({ now, includeWatchContext: false });
  const full = listPendingManualWatchReviewsCached({ now: now + 1000, includeWatchContext: true });
  assert.equal(summary.find((review) => review.id === queued.review.id)?.watch_context, undefined);
  assert.ok(full.find((review) => review.id === queued.review.id)?.watch_context);

  setManualWatchReviewStatus(queued.review.id, "dismissed");
});

test("approving an episode-id review writes playstate under its history row's show key, not an alias", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("offline in test"); };

  const showTitle = "Alias Lane";
  const showIds = { imdb_id: "tt8000001", tvdb_id: "8001" };
  for (const episode of [1, 2, 3]) {
    await repo.insertWatchRecord({
      title: `${showTitle} - S01E0${episode}`,
      show_title: showTitle,
      media_type: "episode",
      season: 1,
      episode,
      ...showIds,
      watched_at: `2026-09-0${episode}T20:00:00.000Z`,
      source: "plex",
      sync_action: "watched",
    });
  }
  // The index behind the title profiles is memoized for 60 s.
  await repo.repairEpisodeSeriesIdentity();
  const historyRow = db.prepare("SELECT * FROM watch_history WHERE show_title = ? AND episode = 1").get(showTitle);
  // A stale show-keyed unwatch, as Slow Horses S06E01 had.
  repo.upsertPlaystateSync({
    title: `${showTitle} - S01E01`,
    media_type: "episode",
    season: 1,
    episode: 1,
    ...showIds,
    watched_at: "2026-09-01T20:00:00.000Z",
    source: "emby",
    sync_action: "unwatched",
  }, "unwatched");

  const queued = enqueueManualWatchReview({
    title: `${showTitle} - S01E01`,
    showTitle,
    type: "episode",
    season: 1,
    episode: 1,
    source: "emby",
    itemId: "emby-alias-lane-101",
    // The episode's own IMDb id, leaked into the series slot.
    ids: { imdb: "tt8100001" },
    isValid: true,
  }, {
    releaseDate: "2026-09-01T00:00:00.000Z",
    sourceFingerprint: "emby|alias-lane-101|1",
    allowWhenUnwatched: true,
  });
  // History already shows it watched, so the listing hides it; a review
  // listed before history caught up can still be approved.
  assert.equal(queued.status, "already_watched");

  let statusCode = 200;
  let responseBody = null;
  await handleManualWatchReview(
    {
      method: "POST",
      body: { mode: "now" },
      headers: { "x-api-key": AUTH.apiKey },
      cookies: {},
      get(name) { return this.headers[String(name).toLowerCase()] || ""; },
    },
    {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(payload) { responseBody = JSON.parse(payload); return this; },
    },
    `manual-watch-review/${encodeURIComponent(queued.review.id)}/approve`,
  );
  assert.equal(statusCode, 200, JSON.stringify(responseBody));
  assert.equal(responseBody.watchRecordId, historyRow.id);

  const rows = db.prepare("SELECT media_key, state FROM playstate WHERE title_lower LIKE ? AND season = 1 AND episode = 1")
    .all(`${showTitle.toLowerCase()} - s01e01%`);
  assert.deepEqual(rows, [{ media_key: historyRow.media_key, state: "watched" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE show_title = ? AND episode = 1").get(showTitle).c, 1);
});

test("a review is hidden when history shows the episode watched, even with a stale unwatched playstate", async () => {
  // Live: Slow Horses S06E01. A Plex unwatch, then a newer Emby watch in
  // history, but the show-keyed playstate stayed unwatched, so a
  // library-history review stayed listed although the show page read watched.
  const ids = { imdb: "tt92001", tmdb: "92001", tvdb: "92101" };
  const row = (episode, source, action) => ({
    title: `Stale Horses - S01E0${episode}`, show_title: "Stale Horses", media_type: "episode", source,
    watched_at: "2026-09-15T00:00:00.000Z", season: 1, episode, sync_action: action,
    imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb, sync_dispatch_telemetry: "Dispatch status: success",
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  const media = (episode) => ({
    title: `Stale Horses - S01E0${episode}`, showTitle: "Stale Horses", type: "episode", season: 1, episode,
    source: "emby", ids, isValid: true,
  });
  for (const [episode, actions] of [[1, ["unwatched", "watched"]], [2, ["watched", "unwatched"]]]) {
    for (const [index, action] of actions.entries()) {
      const result = await repo.insertWatchRecord(row(episode, index ? "emby" : "plex", action));
      await result.assetPrefetch;
      await pause();
    }
    repo.upsertPlaystateForMediaSync(media(episode), "unwatched", undefined, { skipInvalidate: true });
  }
  assert.equal(repo.historyShowsWatchedSync(media(1)), true);
  assert.equal(repo.historyShowsWatchedSync(media(2)), false);

  const queue = (episode) => enqueueManualWatchReview(media(episode), {
    releaseDate: "2026-09-15T00:00:00.000Z", sourceFingerprint: `emby|stale-horses|${episode}`, allowWhenUnwatched: true,
  });
  const watched = queue(1);
  assert.equal(watched.status, "already_watched");
  assert.equal(listPendingManualWatchReviews().some((review) => review.id === watched.review.id), false);
  const unwatched = queue(2);
  assert.equal(unwatched.status, "pending", "a newer media-server unwatch still leaves the review to decide");
  setManualWatchReviewStatus(unwatched.review.id, "dismissed");
});

test("the sidebar item count keeps same-title reboots apart, as the review page does", async () => {
  const { countPendingManualWatchReviewItems } = await import("../server/src/utils/manualWatchReview.js");
  const review = (id, showTitle, source) => ({
    id, title: `${showTitle} - S01E02`, show_title: showTitle, media_type: "episode", season: 1, episode: 2,
    media: { type: "episode", showTitle, season: 1, episode: 2, source, ids: {}, showIds: {} },
  });
  assert.equal(countPendingManualWatchReviewItems([
    review("a", "Scrubs", "emby"),
    review("b", "Scrubs (2026)", "emby"),
    review("c", "Scrubs (2026)", "plex"),
  ]), 2);
});

test("an episode-id review is hidden once cached TMDB find proves it is an episode history shows watched", async (t) => {
  // Live: The Walking Dead S07/S08. Emby's review carries only the episode's
  // own IMDb/TVDB ids, which share nothing with the show's ids, so the title match
  // could not reach the watched history (decision 34).
  const { lookupTmdbExternalIdKind } = await import("../server/src/utils/tmdbGateway.js");
  const { pendingManualWatchReviewAliasLookups } = await import("../server/src/utils/manualWatchReview.js");
  const show = { imdb_id: "tt93001", tmdb_id: "93001", tvdb_id: "93101" };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (const [episode, actions] of [[1, ["watched"]], [2, ["watched", "unwatched"]], [3, ["watched"]]]) {
    for (const action of actions) {
      const result = await repo.insertWatchRecord({
        title: `Walking Alias - S07E0${episode}`, show_title: "Walking Alias", media_type: "episode", source: "plex",
        watched_at: "2026-09-10T00:00:00.000Z", season: 7, episode, sync_action: action,
        ...show, sync_dispatch_telemetry: "Dispatch status: success",
      });
      await result.assetPrefetch;
      await pause();
    }
  }
  repo.invalidateSeriesIdentityIndex();
  const queue = (episode) => enqueueManualWatchReview({
    title: `Walking Alias - S07E0${episode}`, showTitle: "Walking Alias", type: "episode", season: 7, episode,
    source: "emby", ids: { imdb: `tt9310${episode}`, tvdb: `9320${episode}` }, isValid: true,
  }, { releaseDate: "2026-09-10T00:00:00.000Z", sourceFingerprint: `emby|walking-alias|${episode}` });
  const reviews = [1, 2, 3].map((episode) => queue(episode).review);
  const listed = () => new Set(listPendingManualWatchReviews().map((review) => review.id));
  assert.equal(reviews.every((review) => listed().has(review.id)), true, "uncached ids leave every review listed");
  const pending = pendingManualWatchReviewAliasLookups().pendingLookups.map(({ id }) => id);
  assert.equal(["tt93101", "93201", "tt93103", "93203"].every((id) => pending.includes(id)), true, "uncached ids are queued for lookup");

  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const id = decodeURIComponent(new URL(String(url)).pathname.split("/").pop());
    const episode = Number(id.slice(-1));
    const body = { tv_results: [], tv_episode_results: [{ show_id: 93001, season_number: 7, episode_number: episode === 3 ? 4 : episode }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  for (const episode of [1, 2, 3]) {
    await lookupTmdbExternalIdKind("imdb_id", `tt9310${episode}`);
    await lookupTmdbExternalIdKind("tvdb_id", `9320${episode}`);
  }

  const after = listed();
  assert.equal(after.has(reviews[0].id), false, "a proven episode history shows watched is hidden");
  assert.equal(after.has(reviews[1].id), true, "a proven episode history shows unwatched stays to decide");
  assert.equal(after.has(reviews[2].id), true, "a coordinate mismatch is not a proof");
  assert.equal(pendingManualWatchReviewAliasLookups().pendingLookups.some(({ id }) => /^(tt931|932)/.test(id)), false);
  for (const review of reviews) setManualWatchReviewStatus(review.id, "dismissed");
});

test("reviews of a title two shows share name their proven show and flag the title instead of trusting it", async (t) => {
  // Live: the 2001 Scrubs group drew the 2026 reboot's poster, because the page
  // looked the show up by title alone and the title resolved to the reboot.
  const { lookupTmdbExternalIdKind } = await import("../server/src/utils/tmdbGateway.js");
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  const original = { imdb_id: "tt94001", tmdb_id: "94001", tvdb_id: "94101" };
  const reboot = { imdb_id: "tt94002", tmdb_id: "94002", tvdb_id: "94102" };
  for (const [showTitle, ids] of [["Poster Twin", original], ["Poster Twin (2026)", reboot]]) {
    for (const episode of [1, 2]) {
      const result = await repo.insertWatchRecord({
        title: `${showTitle} - S01E0${episode}`, show_title: showTitle, media_type: "episode", source: "plex",
        watched_at: "2026-09-10T00:00:00.000Z", season: 1, episode, sync_action: "watched",
        ...ids, sync_dispatch_telemetry: "Dispatch status: success",
      });
      await result.assetPrefetch;
      await pause();
    }
  }
  repo.invalidateSeriesIdentityIndex();
  const queue = (showTitle, source, extra, key) => enqueueManualWatchReview({
    title: `${showTitle} - S01E05`, showTitle, type: "episode", season: 1, episode: 5, source, isValid: true, ...extra,
  }, { releaseDate: "2026-09-10T00:00:00.000Z", sourceFingerprint: `${source}|poster-twin|${key}` }).review;
  const emby = queue("Poster Twin", "emby", { ids: { imdb: "tt94105", tvdb: "94205" } }, "emby");
  const plex = queue("Poster Twin", "plex", { ids: {} }, "plex");
  const withShowIds = queue("Poster Twin (2026)", "jellyfin", { ids: {}, showIds: { tmdb: "94002" } }, "jellyfin");
  const find = (id) => listPendingManualWatchReviews().find((review) => review.id === id);

  assert.equal(find(emby.id).show_title_ambiguous, true);
  assert.equal(find(emby.id).proven_show_ids, undefined, "uncached episode ids prove nothing yet");
  assert.equal(find(plex.id).show_title_ambiguous, true);
  assert.equal(find(plex.id).proven_show_ids, undefined, "a title alone never picks one of the two shows");
  assert.deepEqual(find(withShowIds.id).proven_show_ids, { imdb: "tt94002", tmdb: "94002", tvdb: "94102" });

  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    tv_results: [], tv_episode_results: [{ show_id: 94001, season_number: 1, episode_number: 5 }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  await lookupTmdbExternalIdKind("imdb_id", "tt94105");
  await lookupTmdbExternalIdKind("tvdb_id", "94205");

  assert.deepEqual(find(emby.id).proven_show_ids, { imdb: "tt94001", tmdb: "94001", tvdb: "94101" },
    "cached TMDB find places the episode ids on the original show, not the reboot");
  for (const review of [emby, plex, withShowIds]) setManualWatchReviewStatus(review.id, "dismissed");
});
