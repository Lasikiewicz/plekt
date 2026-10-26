import crypto from "node:crypto";
import { db, getDataVersion, parseJson, toJson } from "../db.js";
import {
  canonicalShowTitleKey,
  canonicalTitleKey,
  findWatchedByAnyMediaKeySync,
  getPlaystateForMediaSync,
  historyShowsWatchedSync,
  idsShareAny,
  mediaKeyFor,
  provenPlaystateAliasProfile,
  seriesIdentityProfilesForShowTitle,
  showTitleNamesSeveralShows,
} from "./dataRepo.js";
import { getCachedShowProgress } from "./showProgressCache.js";
import { getCachedTmdbExternalIdKind } from "./tmdbGateway.js";
import { getCachedTvdbEpisodeKind } from "./tvdbGateway.js";

const EXPLICIT_PLAYED_EVENT_KEYS = new Set([
  "itemmarkplayed",
  "itemmarkedplayed",
  "itemmarkedasplayed",
  "itemplayed",
]);

const selectPendingReviewsStmt = db.prepare(`
  SELECT * FROM manual_watch_reviews
  WHERE status = 'pending'
  ORDER BY created_at DESC, id DESC
`);
const selectManualUnwatchRowsStmt = db.prepare(`
  SELECT title, media_type, show_title, season, episode, imdb_id, tmdb_id, tvdb_id
  FROM watch_history
  WHERE source = 'manual'
    AND sync_action IN ('unwatched', 'unplayed')
`);
const selectReviewByIdStmt = db.prepare("SELECT * FROM manual_watch_reviews WHERE id = ?");
const selectReviewByMediaKeyStmt = db.prepare("SELECT * FROM manual_watch_reviews WHERE media_key = ?");
const insertReviewStmt = db.prepare(`
  INSERT INTO manual_watch_reviews (
    id, media_key, source, source_item_id, title, media_type, show_title,
    episode_title, season, episode, release_date, observed_watched_at,
    source_fingerprint, media_json, status, decision_mode, created_at,
    updated_at, reviewed_at
  ) VALUES (
    @id, @media_key, @source, @source_item_id, @title, @media_type, @show_title,
    @episode_title, @season, @episode, @release_date, @observed_watched_at,
    @source_fingerprint, @media_json, 'pending', NULL, @created_at,
    @updated_at, NULL
  )
`);
const updateReviewStmt = db.prepare(`
  UPDATE manual_watch_reviews
  SET source = @source,
      source_item_id = @source_item_id,
      title = @title,
      media_type = @media_type,
      show_title = @show_title,
      episode_title = @episode_title,
      season = @season,
      episode = @episode,
      release_date = @release_date,
      observed_watched_at = @observed_watched_at,
      source_fingerprint = @source_fingerprint,
      media_json = @media_json,
      status = 'pending',
      decision_mode = NULL,
      updated_at = @updated_at,
      reviewed_at = NULL
  WHERE id = @id
`);
const updateStatusStmt = db.prepare(`
  UPDATE manual_watch_reviews
  SET status = @status, decision_mode = @decision_mode,
      updated_at = @updated_at, reviewed_at = @reviewed_at
  WHERE id = @id
`);

function text(value = "") {
  return String(value ?? "").trim();
}

function compactEventKey(value = "") {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isExplicitPlayedMedia(media = {}) {
  const provenance = media.watchProvenance || media.watch_provenance || {};
  return [media.event, provenance.event, provenance.source_event, provenance.sourceEvent]
    .some((event) => EXPLICIT_PLAYED_EVENT_KEYS.has(compactEventKey(event)));
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function showTitleFromMedia(media = {}) {
  const explicit = text(media.showTitle || media.show_title);
  if (explicit) return explicit;
  const title = text(media.title);
  return title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i)?.[1]?.trim() || "";
}

function reviewShowProgress(media = {}) {
  const showTitle = showTitleFromMedia(media);
  if (!showTitle) return null;
  const keys = [...new Set([
    canonicalTitleKey(showTitle),
    canonicalShowTitleKey(showTitle),
  ].filter(Boolean))];
  for (const key of keys) {
    const progress = getCachedShowProgress(key);
    if (progress) return progress;
  }
  return null;
}

function truthyReviewFlag(value) {
  return value === true || ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function reviewShowMarkedWatched(media = {}) {
  if (text(media.type || media.media_type).toLowerCase() !== "episode") return false;

  // Keep this compatible with callers that already carry a show-level result
  // (for example a detail-page or container action), while treating the local
  // progress cache as the normal source of truth for provider callbacks.
  const explicitShowFlag = [
    media.showWatched,
    media.show_watched,
    media.showCompleted,
    media.show_completed,
    media.completedShow,
    media.completed_show,
    media.showAlreadyWatched,
    media.show_already_watched,
  ].some(truthyReviewFlag);
  if (explicitShowFlag) return true;

  const explicitWatchedCount = Number(
    media.showWatchedEpisodes
      ?? media.show_watched_episodes
      ?? media.watchedEpisodes
      ?? media.watched_episodes,
  );
  const explicitTotal = Number(
    media.showTotalEpisodes
      ?? media.show_total_episodes
      ?? media.totalEpisodes
      ?? media.total_episodes,
  );
  if (Number.isFinite(explicitWatchedCount) && Number.isFinite(explicitTotal) && explicitTotal > 0) {
    return explicitWatchedCount >= explicitTotal;
  }

  const progress = reviewShowProgress(media);
  const watchedCount = Number(progress?.episode_count || 0);
  const totalEpisodes = Number(progress?.total_episodes || 0);
  return totalEpisodes > 0 && watchedCount >= totalEpisodes;
}

function reviewShowWatchState(media = {}) {
  const progress = reviewShowProgress(media);
  const watchedCount = Number(
    media.showWatchedEpisodes
      ?? media.show_watched_episodes
      ?? media.watchedEpisodes
      ?? media.watched_episodes
      ?? progress?.episode_count
      ?? 0,
  );
  const totalEpisodes = Number(
    media.showTotalEpisodes
      ?? media.show_total_episodes
      ?? media.totalEpisodes
      ?? media.total_episodes
      ?? progress?.total_episodes
      ?? 0,
  );
  const watched = reviewShowMarkedWatched(media);
  return {
    watched,
    status: watched ? "watched" : totalEpisodes > 0 && watchedCount > 0 ? "partial" : "unknown",
    watched_count: Number.isFinite(watchedCount) ? watchedCount : 0,
    total_episodes: Number.isFinite(totalEpisodes) ? totalEpisodes : 0,
  };
}

function reviewEpisodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function reviewSiblingMedia(media = {}, season, episode) {
  const showTitle = showTitleFromMedia(media) || "Unknown show";
  // Webhook parsers put the resolved series identity in `ids`, while a few
  // callers pass it in the explicit `showIds` fields. Preserve either shape
  // so a sibling lookup can use provider identity before falling back to its
  // show title and coordinates.
  const showIds = media.showIds || media.show_ids || media.ids || {};
  return {
    title: `${showTitle} - ${reviewEpisodeCode(season, episode)}`,
    showTitle,
    show_title: showTitle,
    type: "episode",
    media_type: "episode",
    ids: {
      imdb: text(showIds.imdb || media.showImdbId || media.show_imdb_id) || undefined,
      tmdb: text(showIds.tmdb || media.showTmdbId || media.show_tmdb_id) || undefined,
      tvdb: text(showIds.tvdb || media.showTvdbId || media.show_tvdb_id) || undefined,
    },
    season,
    episode,
    isValid: true,
  };
}

function reviewSiblingWatchState(media = {}, season, episode) {
  const sibling = reviewSiblingMedia(media, season, episode);
  let playstate = null;
  try {
    playstate = getPlaystateForMediaSync(sibling);
  } catch {
    playstate = null;
  }
  let watched = null;
  if (playstate?.state === "watched") watched = playstate;
  if (!playstate) {
    try {
      watched = findWatchedByAnyMediaKeySync(sibling);
    } catch {
      watched = null;
    }
  }
  const state = playstate?.state === "unwatched"
    ? "unwatched"
    : watched
      ? "watched"
      : "unknown";
  return {
    season,
    episode,
    code: reviewEpisodeCode(season, episode),
    state,
    watched: state === "watched",
    known: state !== "unknown",
    watched_at: watched?.watched_at || null,
  };
}

export function manualWatchReviewWatchContext(review = {}) {
  const media = manualWatchReviewMedia(review);
  if (text(media.type || media.media_type).toLowerCase() !== "episode") return null;
  const season = integerOrNull(review.season ?? media.season);
  const episode = integerOrNull(review.episode ?? media.episode);
  if (season === null || episode === null) return null;
  return {
    show: reviewShowWatchState(media),
    before: episode > 1 ? reviewSiblingWatchState(media, season, episode - 1) : null,
    after: reviewSiblingWatchState(media, season, episode + 1),
  };
}

function serializableMedia(media = {}) {
  const showIds = media.showIds || media.show_ids || {};
  const normalized = {
    title: text(media.title),
    showTitle: showTitleFromMedia(media),
    type: text(media.type || media.media_type).toLowerCase(),
    source: text(media.source),
    ids: {
      imdb: text(media.ids?.imdb || media.imdb_id) || undefined,
      tmdb: text(media.ids?.tmdb || media.tmdb_id) || undefined,
      tvdb: text(media.ids?.tvdb || media.tvdb_id) || undefined,
    },
    showIds: {
      imdb: text(showIds.imdb || media.showImdbId || media.show_imdb_id) || undefined,
      tmdb: text(showIds.tmdb || media.showTmdbId || media.show_tmdb_id) || undefined,
      tvdb: text(showIds.tvdb || media.showTvdbId || media.show_tvdb_id) || undefined,
    },
    season: integerOrNull(media.season),
    episode: integerOrNull(media.episode),
    episodeTitle: text(media.episodeTitle || media.episode_title) || undefined,
    itemId: text(media.itemId || media.item_id) || undefined,
    posterUrl: text(media.posterUrl || media.poster_url) || undefined,
    showPosterUrl: text(media.showPosterUrl || media.show_poster_url) || undefined,
    providerItemId: text(media.providerItemId || media.provider_item_id) || undefined,
    providerItems: media.providerItems || media.provider_items || undefined,
    event: text(media.event) || undefined,
    playedFlagOnly: Boolean(media.playedFlagOnly),
    showWatched: [
      media.showWatched,
      media.show_watched,
      media.showCompleted,
      media.show_completed,
      media.completedShow,
      media.completed_show,
      media.showAlreadyWatched,
      media.show_already_watched,
    ].some(truthyReviewFlag),
    showWatchedEpisodes: Number.isFinite(Number(
      media.showWatchedEpisodes
        ?? media.show_watched_episodes
        ?? media.watchedEpisodes
        ?? media.watched_episodes,
    ))
      ? Number(media.showWatchedEpisodes
        ?? media.show_watched_episodes
        ?? media.watchedEpisodes
        ?? media.watched_episodes)
      : undefined,
    showTotalEpisodes: Number.isFinite(Number(
      media.showTotalEpisodes
        ?? media.show_total_episodes
        ?? media.totalEpisodes
        ?? media.total_episodes,
    ))
      ? Number(media.showTotalEpisodes
        ?? media.show_total_episodes
        ?? media.totalEpisodes
        ?? media.total_episodes)
      : undefined,
    releaseDate: text(media.releaseDate || media.release_date) || undefined,
    runtimeMinutes: Number.isFinite(Number(media.runtimeMinutes ?? media.runtime_minutes))
      ? Number(media.runtimeMinutes ?? media.runtime_minutes)
      : undefined,
    watched_at: text(media.watched_at),
    watchProvenance: media.watchProvenance || media.watch_provenance || null,
    manualReviewAllowWhenUnwatched: Boolean(media.manualReviewAllowWhenUnwatched),
    isValid: true,
  };
  return normalized;
}

function rowToReview(row, { includeWatchContext = true } = {}) {
  if (!row) return null;
  const media = parseJson(row.media_json, {}) || {};
  const review = {
    id: row.id,
    media_key: row.media_key,
    source: row.source,
    source_item_id: row.source_item_id || null,
    title: row.title,
    media_type: row.media_type,
    show_title: row.show_title || null,
    episode_title: row.episode_title || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    release_date: row.release_date || null,
    observed_watched_at: row.observed_watched_at || null,
    source_fingerprint: row.source_fingerprint,
    status: row.status,
    decision_mode: row.decision_mode || null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    reviewed_at: Number(row.reviewed_at || 0) || null,
    media,
    review_kind: media.reviewKind === "source_mismatch" ? "source_mismatch" : "manual_watch",
    reason: text(media.reason),
  };
  if (review.review_kind !== "source_mismatch" && includeWatchContext && review.media_type === "episode") {
    review.watch_context = manualWatchReviewWatchContext(review);
    Object.assign(review, reviewShowIdentity(review));
  }
  return review;
}

// The page looks each show group's poster and episode catalog up by title
// when a review carries no show ids, and a title shared by two shows resolved
// the 2001 Scrubs group to the 2026 reboot. Name the proven profile the review
// belongs to (its own ids, or the playstate alias proof for Emby's episode
// ids), and flag a title history proves is shared so the page never trusts a
// title-only lookup for it (decision 15).
function reviewShowIdentity(review = {}) {
  const media = manualWatchReviewMedia(review);
  const profiles = seriesIdentityProfilesForShowTitle(media.showTitle);
  if (!profiles.length) return {};
  const ambiguous = profiles.length > 1;
  const showIds = { imdb: text(media.showIds?.imdb), tmdb: text(media.showIds?.tmdb), tvdb: text(media.showIds?.tvdb) };
  const ids = { imdb: text(media.ids?.imdb), tmdb: text(media.ids?.tmdb), tvdb: text(media.ids?.tvdb) };
  let matches = profiles.filter((candidate) => idsShareAny(showIds, candidate.ids));
  if (!matches.length) matches = profiles.filter((candidate) => idsShareAny(ids, candidate.ids));
  let profile = matches.length === 1 ? matches[0] : null;
  if (!matches.length && (ids.imdb || ids.tvdb) && media.season != null && media.episode != null) {
    profile = provenPlaystateAliasProfile({
      imdb_id: ids.imdb,
      tvdb_id: ids.tvdb,
      season: media.season,
      episode: media.episode,
    }, profiles, reviewAliasProof());
  }
  if (!profile && !matches.length && !ambiguous) [profile] = profiles;
  const provenIds = profile
    ? Object.fromEntries(Object.entries(profile.ids).filter(([, value]) => value))
    : null;
  return {
    ...(provenIds && Object.keys(provenIds).length ? { proven_show_ids: provenIds } : {}),
    ...(ambiguous ? { show_title_ambiguous: true } : {}),
  };
}

// A review that Plembfin's own state already answers is closed rather than
// hidden, so the queue never holds invisible pending rows (user decision,
// 24 September 2026). Status only: nothing is written to history or sent. The
// same provider snapshot stays suppressed (dismissed + same fingerprint); a
// changed snapshot can queue a fresh review.
export const RESOLVED_BY_LOCAL_STATE = "resolved_by_local_state";

export function listPendingManualWatchReviews({ includeWatchContext = true } = {}) {
  const pending = [];
  for (const row of selectPendingReviewsStmt.all()) {
    const review = rowToReview(row, { includeWatchContext });
    if (review.review_kind === "source_mismatch") { pending.push(review); continue; }
    if (reviewIsAlreadyWatched(review)) setManualWatchReviewStatus(review.id, "dismissed", RESOLVED_BY_LOCAL_STATE);
    else pending.push(review);
  }
  return pending;
}

// The GET listing (sidebar badge on every page load, a 30 s poll, and the
// review page) rebuilt every review's watch context synchronously - about
// 400 ms of blocked event loop per request on a real library. The result only
// changes when watch history/playstate moves (the shared data version) or a
// pending review is added, edited, or decided (the signature below). The
// short ceiling covers inputs neither tracks, such as show episode totals.
// Decision paths keep calling listPendingManualWatchReviews() directly.
const selectPendingSignatureStmt = db.prepare(`
  SELECT COUNT(*) AS count, MAX(updated_at) AS updated, MAX(created_at) AS created
  FROM manual_watch_reviews
  WHERE status = 'pending'
`);
const PENDING_LIST_CACHE_MS = 15_000;
let pendingListCache = null;

export function listPendingManualWatchReviewsCached({ now = Date.now(), includeWatchContext = true } = {}) {
  const signature = selectPendingSignatureStmt.get() || {};
  const key = `${getDataVersion()}|${signature.count}|${signature.updated}|${signature.created}|context:${includeWatchContext ? "full" : "summary"}`;
  if (pendingListCache && pendingListCache.key === key && now - pendingListCache.builtAt < PENDING_LIST_CACHE_MS) {
    return pendingListCache.reviews;
  }
  const reviews = listPendingManualWatchReviews({ includeWatchContext });
  pendingListCache = { key, builtAt: now, reviews };
  return reviews;
}

export function countPendingManualWatchReviews() {
  return listPendingManualWatchReviews().length;
}

function reviewDisplayKey(review = {}) {
  if (review.review_kind === "source_mismatch") {
    const media = review.media || {};
    const ids = media.showIds || media.show_ids || media.ids || {};
    const identity = text(ids.tmdb || ids.tvdb || ids.imdb)
      || canonicalTitleKey(review.show_title || media.showTitle || media.show_title || review.id);
    return `source-mismatch:${identity}`;
  }
  const type = text(review.media_type || review.media?.type || review.media?.media_type).toLowerCase();
  if (type !== "episode") return `review:${review.id || review.media_key || canonicalTitleKey(review.title || "unknown")}`;

  const media = review.media || {};
  const showIds = media.showIds || media.show_ids || {};
  const showIdentity = text(
    showIds.tvdb
      || showIds.tmdb
      || showIds.imdb
      || media.showTvdbId
      || media.show_tvdb_id
      || media.showTmdbId
      || media.show_tmdb_id
      || media.showImdbId
      || media.show_imdb_id,
  // Keep the year, as the review page does: Scrubs and Scrubs (2026) at the
  // same coordinate are two items, not one.
  ) || canonicalTitleKey(review.show_title || media.showTitle || media.show_title || showTitleFromMedia(review));
  const season = integerOrNull(review.season ?? media.season);
  const episode = integerOrNull(review.episode ?? media.episode);
  if (showIdentity && season != null && episode != null) return `episode:${showIdentity}:s${season}:e${episode}`;
  return `episode:${canonicalTitleKey(review.title || media.title || review.id || "unknown")}`;
}

export function countPendingManualWatchReviewItems(reviews = null) {
  const pending = Array.isArray(reviews) ? reviews : listPendingManualWatchReviews();
  return new Set(pending.map(reviewDisplayKey)).size;
}

export function getManualWatchReview(id) {
  return rowToReview(selectReviewByIdStmt.get(text(id)));
}

export function enqueueManualWatchReview(media = {}, {
  releaseDate = "",
  observedWatchedAt = "",
  sourceFingerprint = "",
  reason = "",
  allowWhenUnwatched = false,
} = {}) {
  const normalizedMedia = serializableMedia({
    ...media,
    ...(allowWhenUnwatched ? { manualReviewAllowWhenUnwatched: true } : {}),
  });
  const mediaKey = mediaKeyFor(normalizedMedia);
  const source = text(normalizedMedia.source) || "unknown";
  const existing = selectReviewByMediaKeyStmt.get(mediaKey);

  // A whole-show mark from Plembfin writes the episode history and can race a
  // provider's flag-only callback. The callback is not a new watch decision;
  // do not create (or refresh) a review for a show that is already complete
  // locally. The per-episode guard below still handles identity matches when
  // the show is only partially watched.
  if (reviewShowMarkedWatched(normalizedMedia)) {
    return {
      queued: false,
      status: "already_watched",
      suppressed: true,
      review: existing ? rowToReview(existing) : null,
    };
  }

  // A generic provider flag arriving after an explicit local unwatch is almost
  // always the provider acknowledging the old watched state. Do not turn that
  // acknowledgement into a new manual decision. Explicit provider "Mark
  // played" events remain eligible because they carry a distinct user action.
  let currentPlaystate = null;
  try {
    currentPlaystate = getPlaystateForMediaSync(normalizedMedia);
  } catch {
    currentPlaystate = null;
  }
  const manuallyUnwatched = currentPlaystate?.state === "unwatched"
    || (!currentPlaystate && hasManualUnwatchForMedia(normalizedMedia));
  if (
    manuallyUnwatched
    && !allowWhenUnwatched
    && !isExplicitPlayedMedia(normalizedMedia)
  ) {
    return {
      queued: false,
      status: "unwatched",
      suppressed: true,
      review: existing ? rowToReview(existing) : null,
    };
  }

  const fingerprint = text(sourceFingerprint)
    || `${source}:${text(normalizedMedia.itemId)}:${text(observedWatchedAt)}:${text(releaseDate)}:${text(reason)}`;
  const now = Date.now();

  // A dismissed flag should not come back every minute while the provider's
  // snapshot is unchanged. A changed provider fingerprint is a new decision.
  if (existing?.status === "approved") return { queued: false, status: "approved", review: rowToReview(existing) };
  if (existing?.status === "dismissed" && existing.source_fingerprint === fingerprint) {
    return { queued: false, status: "dismissed", review: rowToReview(existing) };
  }
  if (existing?.status === "pending") {
    const existingReview = rowToReview(existing);
    if (reviewIsAlreadyWatched(existingReview)) {
      return { queued: false, status: "already_watched", review: existingReview };
    }
  }

  const values = {
    id: existing?.id || crypto.randomUUID(),
    media_key: mediaKey,
    source,
    source_item_id: text(normalizedMedia.itemId || normalizedMedia.providerItemId) || null,
    title: normalizedMedia.title || "Unknown media",
    media_type: normalizedMedia.type,
    show_title: normalizedMedia.showTitle || null,
    episode_title: normalizedMedia.episodeTitle || null,
    season: normalizedMedia.season,
    episode: normalizedMedia.episode,
    release_date: text(releaseDate || normalizedMedia.releaseDate) || null,
    observed_watched_at: text(observedWatchedAt) || null,
    source_fingerprint: fingerprint,
    media_json: toJson(normalizedMedia),
    updated_at: now,
  };
  if (existing) updateReviewStmt.run(values);
  else insertReviewStmt.run({ ...values, created_at: now });
  const review = getManualWatchReview(values.id);
  if (reviewIsAlreadyWatched(review)) {
    return { queued: false, status: "already_watched", review };
  }
  return { queued: true, status: "pending", review };
}

// Source mismatch notifications share the inbox table and sidebar count, but
// never enter the watched/unwatched decision guards above.
const sourceMismatchByKeyStmt = db.prepare("SELECT * FROM manual_watch_reviews WHERE media_key = ?");
export function enqueueSourceMismatchReview(media = {}, { fingerprint = "" } = {}) {
  const ids = media.ids || {};
  const tmdb = text(ids.tmdb || ids.tmdbId);
  const tvdb = text(ids.tvdb || ids.tvdbId);
  const mediaKey = `source-mismatch:${tmdb}:${tvdb}`;
  const existing = sourceMismatchByKeyStmt.get(mediaKey);
  const currentFingerprint = text(fingerprint) || `${tmdb}:${tvdb}`;
  if (existing?.status === "dismissed" && existing.source_fingerprint === currentFingerprint) {
    return { queued: false, status: "dismissed", review: rowToReview(existing) };
  }
  const now = Date.now();
  const values = {
    id: existing?.id || crypto.randomUUID(), media_key: mediaKey,
    source: text(media.source) || "metadata", source_item_id: text(media.itemId) || null,
    title: text(media.title) || "Episode source mismatch", media_type: "episode",
    show_title: text(media.showTitle || media.show_title) || null,
    episode_title: text(media.episodeTitle || media.episode_title) || null,
    season: integerOrNull(media.season), episode: integerOrNull(media.episode),
    release_date: null, observed_watched_at: null, source_fingerprint: currentFingerprint,
    media_json: toJson({ ...serializableMedia(media), reviewKind: "source_mismatch", reason: "source_mismatch", mismatch: media.mismatch, showIds: media.showIds || ids }), updated_at: now,
  };
  if (existing) updateReviewStmt.run(values);
  else insertReviewStmt.run({ ...values, created_at: now });
  return { queued: true, status: "pending", review: getManualWatchReview(values.id) };
}

export function setManualWatchReviewStatus(id, status, decisionMode = null) {
  const normalizedStatus = ["pending", "approved", "dismissed"].includes(String(status || ""))
    ? String(status)
    : "pending";
  const now = Date.now();
  updateStatusStmt.run({
    id: text(id),
    status: normalizedStatus,
    decision_mode: text(decisionMode) || null,
    updated_at: now,
    reviewed_at: normalizedStatus === "pending" ? null : now,
  });
  return getManualWatchReview(id);
}

export function manualWatchReviewMedia(review = {}) {
  return serializableMedia(review.media || review);
}

function mediaProviderIds(media = {}) {
  const ids = media.ids || {};
  return [
    ids.imdb || media.imdb_id,
    ids.tmdb || media.tmdb_id,
    ids.tvdb || media.tvdb_id,
  ].map((value) => text(value)).filter(Boolean);
}

function mediaMatchesReviewByIdentity(left = {}, right = {}) {
  if (mediaKeyFor(left) === mediaKeyFor(right)) return true;
  const rightIds = new Set(mediaProviderIds(right));
  return mediaProviderIds(left).some((id) => rightIds.has(id));
}

function mediaMatchesReview(left = {}, right = {}) {
  const leftType = text(left.type || left.media_type).toLowerCase();
  const rightType = text(right.type || right.media_type).toLowerCase();
  if (!leftType || leftType !== rightType) return false;

  if (mediaMatchesReviewByIdentity(left, right)) return true;

  if (leftType === "episode") {
    const sameCoordinates = Number(left.season) === Number(right.season)
      && Number(left.episode) === Number(right.episode);
    if (!sameCoordinates) return false;
    const leftShow = canonicalShowTitleKey(showTitleFromMedia(left));
    const rightShow = canonicalShowTitleKey(showTitleFromMedia(right));
    return Boolean(leftShow && rightShow && leftShow === rightShow);
  }

  return leftType === "movie"
    && canonicalTitleKey(left.title) === canonicalTitleKey(right.title)
    && Boolean(canonicalTitleKey(left.title));
}

function watchRowMedia(row = {}) {
  return {
    title: row.title,
    showTitle: row.show_title,
    type: row.media_type,
    ids: {
      imdb: row.imdb_id,
      tmdb: row.tmdb_id,
      tvdb: row.tvdb_id,
    },
    season: row.season,
    episode: row.episode,
  };
}

function hasManualUnwatchForMedia(media = {}) {
  return selectManualUnwatchRowsStmt.all().some((row) => mediaMatchesReview(media, watchRowMedia(row)));
}

// Explicit manual unwatches should retire any review rows that refer to the
// same item. `before` keeps a provider callback that races after the click from
// being mistaken for an older pending decision; the queue guard above handles
// that callback separately.
export function dismissPendingManualWatchReviewsForMedia(media = {}, { before = Number.POSITIVE_INFINITY } = {}) {
  const normalizedMedia = serializableMedia(media);
  const now = Date.now();
  let dismissed = 0;
  for (const row of selectPendingReviewsStmt.all()) {
    const review = rowToReview(row);
    if (Number(review.updated_at || 0) > Number(before)) continue;
    if (!mediaMatchesReview(normalizedMedia, review.media)) continue;
    // A title and coordinate match cannot tell two same-title shows apart: a
    // 2001 Scrubs S01E05 unwatch retired the reboot's S01E05 reviews. Leave
    // such a review pending when history proves the title names two shows.
    if (text(review.media?.type || review.media?.media_type).toLowerCase() === "episode"
      && !mediaMatchesReviewByIdentity(normalizedMedia, review.media)
      && showTitleNamesSeveralShows(showTitleFromMedia(review.media) || showTitleFromMedia(normalizedMedia))) continue;
    updateStatusStmt.run({
      id: review.id,
      status: "dismissed",
      decision_mode: "unwatched",
      updated_at: now,
      reviewed_at: now,
    });
    dismissed += 1;
  }
  return dismissed;
}

function reviewAliasProof() {
  return {
    findCached: getCachedTmdbExternalIdKind,
    tvdbCached: getCachedTvdbEpisodeKind,
    pendingLookups: new Map(),
    pendingTvdbLookups: new Map(),
  };
}

// Emby's episode review carries only the episode's own IMDb/TVDB ids, which
// share nothing with the show's ids, so the title match above cannot reach the
// show's rows (decision 34). The playstate alias repair's cached proof places
// those ids on one profile; the watched checks then run under its ids. Hides
// only. Uncached ids are collected for the repair's lookup job.
function provenProfileShowsWatched(media, proof) {
  if (media.type !== "episode" || media.season == null || media.episode == null) return false;
  const ids = { imdb: text(media.ids?.imdb), tmdb: text(media.ids?.tmdb), tvdb: text(media.ids?.tvdb) };
  if (!ids.imdb && !ids.tvdb) return false;
  const profiles = seriesIdentityProfilesForShowTitle(media.showTitle);
  if (!profiles.length || profiles.some((profile) => idsShareAny(ids, profile.ids))) return false;
  const profile = provenPlaystateAliasProfile({
    imdb_id: ids.imdb,
    tvdb_id: ids.tvdb,
    season: media.season,
    episode: media.episode,
  }, profiles, proof);
  if (!profile) return false;
  const showIds = Object.fromEntries(Object.entries(profile.ids).filter(([, value]) => value));
  const showMedia = { ...media, ids: showIds, showIds };
  // No legacy any-watched-row fallback here: it ignores a newer unwatch, and
  // history's newest transition already answers under the proven ids.
  return historyShowsWatchedSync(showMedia) || getPlaystateForMediaSync(showMedia)?.state === "watched";
}

// Ids pending reviews need looked up before provenProfileShowsWatched can
// place them; the playstate alias repair job looks them up with its own.
export function pendingManualWatchReviewAliasLookups() {
  const proof = reviewAliasProof();
  for (const row of selectPendingReviewsStmt.all()) {
    reviewIsAlreadyWatched(rowToReview(row, { includeWatchContext: false }), proof);
  }
  return {
    pendingLookups: [...proof.pendingLookups.values()],
    pendingTvdbLookups: [...proof.pendingTvdbLookups.values()],
  };
}

function reviewIsAlreadyWatched(review = {}, proof = reviewAliasProof()) {
  try {
    const media = manualWatchReviewMedia(review);
    if (reviewShowMarkedWatched(media)) return true;
    // An episode the show page shows as watched is not a decision to make,
    // even when its playstate row is a stale unwatched.
    if (historyShowsWatchedSync(media)) return true;
    const playstate = getPlaystateForMediaSync(media);
    // Plembfin's canonical watched state is authoritative for this queue. A
    // provider flag is not a new manual decision when the item is already
    // marked watched locally, even if the review row predates that state.
    if (playstate?.state === "watched") return true;
    // A generic/stale provider review is resolved by a local unwatch and must
    // not suddenly become visible merely because the canonical state changed
    // from watched to unwatched. Explicit provider Mark played events are the
    // exception: they represent a new user decision and may remain reviewable.
    if (playstate?.state === "unwatched") {
      if (!isExplicitPlayedMedia(media) && !media.manualReviewAllowWhenUnwatched) return true;
      return provenProfileShowsWatched(media, proof);
    }
    if (!playstate && hasManualUnwatchForMedia(media) && !isExplicitPlayedMedia(media)) {
      if (!media.manualReviewAllowWhenUnwatched) return true;
      return provenProfileShowsWatched(media, proof);
    }

    // Keep legacy databases safe too: a watched history row is still a local
    // Plembfin watch even when its playstate pointer has not been rebuilt yet.
    if (findWatchedByAnyMediaKeySync(media)) return true;
    return provenProfileShowsWatched(media, proof);
  } catch {
    // A malformed legacy review should remain visible so it can be corrected
    // manually instead of disappearing because a read-only filter failed.
    return false;
  }
}
