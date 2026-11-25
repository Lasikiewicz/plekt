import { state } from "./state.js?v=2.3.0.0.8"; import { renderEpisodeOrderConflict } from "./episode-order-conflict.js?v=2.3.0.0.8";
import { buildAuthHeaders } from "./auth.js?v=2.3.0.0.8";
import { posterMarkup, hydratePosters, tmdbPoster } from "./images.js?v=2.3.0.0.8";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=2.3.0.0.8";
import { escapeAttribute, escapeHtml, formatDate, formatTmdbDate, movieHref, movieTmdbHref, platformSourceValues, slug, sourceBadgeHtml, tvShowTmdbHref, tvShowTvdbHref } from "./utils.js?v=2.3.0.0.8";
import {
  clearBulkReviewSelection, executeBulkSelectionAction,
  getInlineReviewDecisionItem, handleBulkSelectionChange, handleBulkSelectionClick,
  pruneBulkReviewSelection, renderBulkReviewBar, renderInlineReviewDecisionBarHtml,
  reviewSelectCheckboxHtml, runSequentialReviewBatch, syncIndeterminateCheckboxes,
  syncInlineReviewItems, triggerBulkSelectionWorkflow, validateInlineDecision,
} from "./manual-watch-review-bulk.js?v=2.3.0.0.8";

let _cb = {};
let _openConfirmDialog = async () => false;
let reviewPollTimer = null;
let manualWatchReviewGroupOrder = [];
let manualWatchReviewRequestSerial = 0;
let latestManualWatchReviewCountRequest = 0;
let latestManualWatchReviewFullRequest = 0;
let manualWatchReviewLastRefreshCount = null;
let manualWatchReviewCatalogTimer = null;
let manualWatchReviewCatalogRequestSerial = 0;
const manualWatchReviewEpisodeCatalogs = new Map();
const manualWatchReviewShowPosterUrls = new Map();
const manualWatchReviewCatalogLoads = new Map();
const manualWatchReviewShowMetadata = new Map();
const pendingManualWatchReviewConfirmations = new Set();
const pendingManualWatchReviewActions = new Map();
const suppressedManualWatchReviewIds = new Map();
const expandedReviewSeasonKeys = new Set();
const collapsedReviewSeasonKeys = new Set();

function currentManualWatchReviews() {
  return Array.isArray(state.manualWatchReviews) ? state.manualWatchReviews : [];
}

function mediaTypeForReview(review = {}) {
  return String(review.media_type || review.media?.type || review.media?.media_type || "").toLowerCase();
}

export function isEpisodeReview(review = {}) {
  return mediaTypeForReview(review) === "episode";
}

function reviewShowIds(review = {}) {
  const media = review.media || {};
  const explicit = review.showIds || review.show_ids || media.showIds || media.show_ids || {};
  return {
    imdb: explicit.imdb || review.showImdbId || review.show_imdb_id || media.showImdbId || media.show_imdb_id || "",
    tmdb: explicit.tmdb || review.showTmdbId || review.show_tmdb_id || media.showTmdbId || media.show_tmdb_id || "",
    tvdb: explicit.tvdb || review.showTvdbId || review.show_tvdb_id || media.showTvdbId || media.show_tvdb_id || "",
  };
}

function reviewShowTitle(review = {}) {
  const media = review.media || {};
  const explicit = String(review.show_title || media.showTitle || media.show_title || "").trim();
  if (explicit) return explicit;
  const title = String(review.title || media.title || "").trim();
  const match = title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  return (match?.[1] || title.split(" - ")[0] || "Unknown show").trim() || "Unknown show";
}

function reviewSeason(review = {}) {
  const value = review.season ?? review.media?.season;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function reviewEpisode(review = {}) {
  const value = review.episode ?? review.media?.episode;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function reviewEpisodeCode(review = {}) {
  const season = reviewSeason(review);
  const episode = reviewEpisode(review);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return "Episode";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function reviewEpisodeTitle(review = {}) {
  return String(review.episode_title || review.media?.episodeTitle || review.media?.episode_title || "").trim();
}

function reviewSource(review = {}) {
  const source = String(review.source || review.media?.source || "app").trim();
  return source ? source.replace(/^./, (value) => value.toUpperCase()) : "App";
}

function reviewStableShowId(review = {}) {
  const ids = reviewShowIds(review);
  return ids.tvdb || ids.tmdb || ids.imdb || "";
}

function reviewShowHref(review = {}) {
  const ids = reviewShowIds(review);
  const title = reviewShowTitle(review);
  if (ids.tmdb) return tvShowTmdbHref(ids.tmdb, title);
  if (ids.tvdb) return tvShowTvdbHref(ids.tvdb, title);
  return `/tvshow/${slug(title)}`;
}

function reviewMediaIds(review = {}) {
  const media = review.media || {};
  const ids = media.ids || {};
  return {
    imdb: ids.imdb || media.imdb_id || review.imdb_id || "",
    tmdb: ids.tmdb || media.tmdb_id || review.tmdb_id || "",
    tvdb: ids.tvdb || media.tvdb_id || review.tvdb_id || "",
  };
}

function reviewMovieHref(review = {}) {
  const ids = reviewMediaIds(review);
  const title = String(review.title || review.media?.title || "Unknown movie").trim();
  if (ids.tmdb) return movieTmdbHref(ids.tmdb, title);
  return movieHref({ id: review.id, title });
}

export function reviewGroupKey(review = {}) {
  if (!isEpisodeReview(review)) return `movie:${String(review.id || review.media_key || slug(review.title || "movie"))}`;
  const stableId = reviewStableShowId(review);
  return `show:${stableId ? String(stableId).toLowerCase() : slug(reviewShowTitle(review))}`;
}

function reviewSearchText(review = {}) {
  const media = review.media || {};
  const ids = media.ids || {};
  const showIds = reviewShowIds(review);
  return [
    review.title,
    review.show_title,
    review.episode_title,
    review.source,
    review.media_type,
    review.media_key,
    media.title,
    media.showTitle,
    media.episodeTitle,
    ...Object.values(ids),
    ...Object.values(showIds),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function filterManualWatchReviews(reviews = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return Array.isArray(reviews) ? reviews : [];
  return (Array.isArray(reviews) ? reviews : []).filter((review) => reviewSearchText(review).includes(needle));
}

function compareReviewValues(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareEpisodeReviews(left, right) {
  const leftSeason = reviewSeason(left);
  const rightSeason = reviewSeason(right);
  const seasonOrder = (Number.isInteger(leftSeason) ? leftSeason : Number.MAX_SAFE_INTEGER)
    - (Number.isInteger(rightSeason) ? rightSeason : Number.MAX_SAFE_INTEGER);
  if (seasonOrder) return seasonOrder;

  const leftEpisode = reviewEpisode(left);
  const rightEpisode = reviewEpisode(right);
  const episodeOrder = (Number.isInteger(leftEpisode) ? leftEpisode : Number.MAX_SAFE_INTEGER)
    - (Number.isInteger(rightEpisode) ? rightEpisode : Number.MAX_SAFE_INTEGER);
  if (episodeOrder) return episodeOrder;

  return compareReviewValues(reviewEpisodeTitle(left), reviewEpisodeTitle(right))
    || compareReviewValues(left.id, right.id);
}

export function groupManualWatchReviews(reviews = []) {
  const groups = [];
  const byKey = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (review.review_kind === "source_mismatch" || review.review_kind === "episode_order_conflict") {
      groups.push({ kind: "mismatch", key: `mismatch:${review.id}`, title: reviewShowTitle(review), reviews: [review] });
      continue;
    }
    if (!isEpisodeReview(review)) {
      groups.push({ kind: "movie", key: reviewGroupKey(review), title: review.title || "Unknown movie", reviews: [review] });
      continue;
    }
    const key = reviewGroupKey(review);
    let group = byKey.get(key);
    if (!group) {
      group = { kind: "show", key, title: reviewShowTitle(review), reviews: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.reviews.push(review);
  }

  // The API naturally returns newly detected flags first. Keep that group
  // order, while making the episodes inside each show predictable.
  for (const group of groups) {
    if (group.kind === "show") group.reviews.sort(compareEpisodeReviews);
  }
  return groups;
}

function manualWatchReviewDisplayCount(reviews = []) {
  return groupManualWatchReviews(reviews).reduce((total, group) => (
    total + (group.kind === "show" ? groupReviewsByEpisode(group.reviews).length : group.reviews.length)
  ), 0);
}

export function orderManualWatchReviewGroups(groups = [], previousOrder = []) {
  const groupList = Array.isArray(groups) ? groups : [];
  const currentKeys = new Set(groupList.map((group) => group.key));
  const orderedKeys = [];
  const seen = new Set();
  for (const key of Array.isArray(previousOrder) ? previousOrder : []) {
    if (currentKeys.has(key) && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const group of groupList) {
    if (!seen.has(group.key)) {
      orderedKeys.push(group.key);
      seen.add(group.key);
    }
  }
  const positions = new Map(orderedKeys.map((key, index) => [key, index]));
  return [...groupList].sort((left, right) => (
    (positions.get(left.key) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function reviewGroupsForDisplay(groups = []) {
  const ordered = orderManualWatchReviewGroups(groups, manualWatchReviewGroupOrder);
  manualWatchReviewGroupOrder = ordered.map((group) => group.key);
  return ordered;
}

function dateLabel(value, fallback = "Not supplied") {
  if (!value) return fallback;
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : formatDate(date.toISOString());
  } catch {
    return fallback;
  }
}

function reviewTitle(review) {
  if (!isEpisodeReview(review)) return review.title || "Unknown movie";
  return `${reviewShowTitle(review)} - ${reviewEpisodeCode(review)}`;
}

function manualReviewProviderLabel(value = "") {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  if (provider === "jellyfin") return "Jellyfin";
  if (provider === "trakt") return "Trakt";
  return provider ? provider.replace(/^./, (character) => character.toUpperCase()) : "Unknown app";
}

function manualReviewFailureTargets(error = {}) {
  const candidates = [
    ...(Array.isArray(error?.failureTargets) ? error.failureTargets : []),
    ...(Array.isArray(error?.response?.failureTargets) ? error.response.failureTargets : []),
    ...(Array.isArray(error?.targetStates) ? error.targetStates : []),
    ...(Array.isArray(error?.response?.targetStates) ? error.response.targetStates : []),
  ];
  const seen = new Set();
  return candidates
    .map((target) => {
      const name = String(target?.provider || target?.target || target?.source || "").trim().toLowerCase();
      const status = String(target?.status || "unknown").trim().toLowerCase();
      const detail = String(target?.detail || "").replace(/\s+/g, " ").trim().slice(0, 320);
      return {
        target: name,
        provider: manualReviewProviderLabel(name),
        status,
        detail,
      };
    })
    .filter((target) => {
      if (!target.target || target.status === "success") return false;
      if (target.status === "skipped" && /no matching item found|skipped by the configured sync policy/i.test(target.detail)) return false;
      const key = `${target.target}|${target.status}|${target.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function manualReviewFailureProviders(error = {}) {
  const fromTargets = [...new Set(manualReviewFailureTargets(error).map((target) => target.provider))];
  if (fromTargets.length) return fromTargets;
  const message = String(error?.message || error || "").toLowerCase();
  return ["Plex", "Emby", "Jellyfin", "Trakt"].filter((provider) => message.includes(provider.toLowerCase()));
}

function manualReviewFailureReason(error = {}) {
  const targets = manualReviewFailureTargets(error);
  if (targets.length) {
    return targets.map((target) => `${target.provider}: ${target.detail || "did not confirm the request"}`).join("; ");
  }
  return String(error?.message || error || "The server did not confirm the request.").replace(/\s+/g, " ").trim();
}

function manualReviewActionVerb(action = "approve") {
  return action === "dismiss" ? "mark unwatched" : "mark watched";
}

function manualReviewAffectedMedia(details = {}, reviews = []) {
  const explicit = String(details.affectedMedia || "").trim();
  if (explicit) return explicit;
  const first = reviews[0] || {};
  const scope = String(details.scope || "item").trim().toLowerCase();
  if (scope === "show") {
    const count = groupReviewsByEpisode(reviews).length;
    return `${reviewShowTitle(first)}${count ? ` · ${count} episode${count === 1 ? "" : "s"}` : ""}`;
  }
  if (scope === "season") return `${reviewShowTitle(first)} · ${reviewSeasonLabel(details.seasonKey)}`;
  return first.id || first.title || first.media_key ? reviewTitle(first) : "the selected media";
}

export function manualWatchReviewFailureOptions(details = {}, error = null) {
  const reviews = Array.isArray(details.reviews) ? details.reviews.filter(Boolean) : [];
  const sourceError = details.cause || error || {};
  const action = String(details.action || "approve").trim().toLowerCase();
  const verb = manualReviewActionVerb(action);
  const affectedMedia = manualReviewAffectedMedia(details, reviews);
  const providers = manualReviewFailureProviders(sourceError);
  const failureReason = manualReviewFailureReason(sourceError);
  const sourceApps = String(details.sourceApps || (reviews.length ? groupSourceLabel(reviews) : "Connected apps")).trim();
  const retryReview = reviews[0];
  const retryBody = {};
  if (details.mode) retryBody.mode = details.mode;
  if (details.watchedAt) retryBody.watched_at = details.watchedAt;
  const progress = String(details.progress || "").trim();
  const connectionLabel = providers.length ? providers.join(" and ") : "each connected media app";

  return {
    title: action === "dismiss" ? "Unwatch correction failed" : "Watch decision failed",
    summary: `${progress ? `${progress} ` : ""}Could not ${verb} ${affectedMedia}. ${failureReason}`,
    explanation: `The review remains pending because ${providers.length ? `${providers.join(" and ")} did not confirm` : "the connected media apps did not confirm"} the request to ${verb} ${affectedMedia}. The reported provider response is shown below; fix it and retry the pending review.`,
    route: "/manual-watch-review",
    context: {
      actionLabel: action === "dismiss" ? "Manual unwatch correction" : "Manual watch decision",
      affectedMedia,
      sourceApps,
      provider: providers.join(", "),
      failureReason,
      routeLabel: "Open Manual Watch review",
      operation: verb,
      scope: String(details.scope || "item"),
      pendingReviewIds: reviews.map((review) => String(review.id || "")).filter(Boolean),
      failureTargets: manualReviewFailureTargets(sourceError),
    },
    ...(retryReview?.id ? {
      retry: {
        endpoint: `/api/manual-watch-review/${encodeURIComponent(String(retryReview.id))}/${action}`,
        method: "POST",
        body: retryBody,
        label: action === "dismiss" ? "Retry unwatch correction" : "Retry watch decision",
      },
    } : {}),
    recommendations: [
      `Open Settings → Connections and test ${connectionLabel}.`,
      "Confirm the app is reachable from the Plekt server, then retry the pending review.",
      "Open Settings → Logs to inspect the provider response if the retry fails again.",
    ],
  };
}

function attachManualWatchReviewFailure(error, details = {}) {
  const failure = error instanceof Error ? error : new Error(String(error || "Manual watch review failed."));
  failure.manualWatchReviewFailure = details;
  return failure;
}

function wrapManualWatchReviewFailure(message, details = {}, cause = null) {
  const failure = new Error(message);
  if (cause?.status != null) failure.status = cause.status;
  if (Array.isArray(cause?.failureTargets)) failure.failureTargets = cause.failureTargets;
  if (cause?.response && typeof cause.response === "object") failure.response = cause.response;
  return attachManualWatchReviewFailure(failure, { ...details, cause });
}

function reportManualWatchReviewFailure(error, fallback = "Manual watch review failed.") {
  const message = error?.message || fallback;
  const details = error?.manualWatchReviewFailure;
  if (details) {
    _cb.setMessage?.(message, "error", manualWatchReviewFailureOptions(details, error));
    return;
  }
  _cb.setMessage?.(message, "error");
}

function reviewPosterItem(review, title, { showPosterUrl = "", eagerPoster = true } = {}) {
  const media = review.media || {};
  const showIds = reviewShowIds(review);
  const mediaType = mediaTypeForReview(review);
  const isEpisode = mediaType === "episode";
  const storedPoster = review.posterUrl || review.poster_url || media.posterUrl || media.poster_url || "";
  const resolvedShowPoster = showPosterUrl
    || review.showPosterUrl
    || review.show_poster_url
    || media.showPosterUrl
    || media.show_poster_url
    || "";
  return {
    ...media,
    id: review.id,
    media_key: review.media_key,
    title,
    show_title: reviewShowTitle(review),
    media_type: mediaType,
    source: review.source || media.source,
    season: reviewSeason(review),
    episode: reviewEpisode(review),
    show_imdb_id: showIds.imdb || null,
    show_tmdb_id: showIds.tmdb || null,
    show_tvdb_id: showIds.tvdb || null,
    // The image form of the same authenticated resolver is a reliable first
    // paint for pending reviews. It also works when a review has no watch
    // history row yet, while hydratePosters still handles cached/local art and
    // broken-image fallback behaviour.
    // Episode artwork is usually a still/thumb. The review surface represents
    // the show, so never let that episode image win over the canonical show
    // poster (or the authenticated show-level resolver fallback).
    poster_url: isEpisode ? "" : (storedPoster || `/api/poster?format=image&id=${encodeURIComponent(String(review.id))}`),
    show_poster_url: resolvedShowPoster,
    prefer_show_poster: isEpisode,
    prefer_raw_poster: !isEpisode,
    // Keep the first review group eager; later groups can use the browser's
    // lazy-image viewport heuristics without delaying the initial decision
    // surface.
    eager_poster: eagerPoster,
  };
}

function reviewPosterHtml(review, title, options = {}) {
  return posterMarkup(reviewPosterItem(review, title, options), "manual-watch-review-poster");
}

function reviewSeasonKey(review = {}) {
  const season = reviewSeason(review);
  return Number.isInteger(season) ? String(season) : "unknown";
}

function reviewSeasonLabel(seasonKey) {
  if (String(seasonKey) === "0") return "Specials";
  if (String(seasonKey) === "unknown") return "Season unknown";
  return `Season ${seasonKey}`;
}

function reviewSeasonStateKey(groupKey, seasonKey) {
  return `${groupKey}:${seasonKey}`;
}

function reviewEpisodeStateKey(review = {}) {
  const season = reviewSeason(review);
  const episode = reviewEpisode(review);
  if (Number.isInteger(season) && Number.isInteger(episode)) return `${season}:${episode}`;
  return `title:${String(reviewEpisodeTitle(review) || reviewTitle(review)).trim().toLowerCase()}`;
}

export function groupReviewsByEpisode(reviews = []) {
  const byKey = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const key = reviewEpisodeStateKey(review);
    let group = byKey.get(key);
    if (!group) {
      group = { ...review, key, reviews: [], sources: [] };
      byKey.set(key, group);
    }
    group.reviews.push(review);
    const source = reviewSource(review);
    if (!group.sources.includes(source)) group.sources.push(source);
  }
  return [...byKey.values()].sort((left, right) => compareEpisodeReviews(left, right));
}

function groupReviewsBySeason(reviews = []) {
  const byKey = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const key = reviewSeasonKey(review);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(review);
  }
  return [...byKey.entries()]
    .map(([key, seasonReviews]) => ({
      key,
      title: reviewSeasonLabel(key),
      reviews: seasonReviews,
      episodes: groupReviewsByEpisode(seasonReviews),
    }))
    .sort((left, right) => {
      const leftNumber = left.key === "unknown" ? -1 : Number(left.key);
      const rightNumber = right.key === "unknown" ? -1 : Number(right.key);
      return rightNumber - leftNumber;
    });
}

export { groupReviewsBySeason };

function manualReviewEpisodeCoordinateKey(season, episode) {
  return `${season === null || season === undefined ? "unknown" : Number(season)}:${Number(episode)}`;
}

function manualReviewInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function episodeTitleFromRecord(record = {}, fallback = "") {
  const explicit = String(record.episode_title || record.episodeTitle || "").trim();
  if (explicit) return explicit;
  const rawTitle = String(record.title || record.name || "").trim();
  const match = rawTitle.match(/S\d{1,2}E\d{1,2}(?:\s+-\s+(.+))?$/i);
  return String(match?.[1] || fallback).trim();
}

function episodeReleaseDateFromRecord(record = {}) {
  return String(record.release_date || record.releaseDate || record.air_date || record.airDate || "").trim();
}

function episodeWatchedAtFromRecord(record = {}) {
  return String(record.watched_at || record.watchedAt || "").trim();
}

function episodeStateFromRecord(record = {}) {
  const action = String(record.sync_action || record.syncAction || "watched").trim().toLowerCase();
  return action === "unwatched" || action === "unplayed" ? "unwatched" : "watched";
}

function latestEpisodeDate(left = "", right = "") {
  if (!left) return right;
  if (!right) return left;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isNaN(leftTime)) return right;
  if (Number.isNaN(rightTime)) return left;
  return rightTime > leftTime ? right : left;
}

// Build the display catalog separately from the pending review records. A
// review is only created for a provider flag, while this catalog also includes
// every episode in the affected season plus the local watched/unwatched state.
// Keeping this pure makes the fallback useful while metadata is loading and
// keeps the provider decision records attached only to the rows that need them.
export function buildManualWatchReviewEpisodeCatalog({
  seasonNumber = null,
  showTitle = "",
  pendingReviews = [],
  metadataEpisodes = [],
  localEpisodes = [],
} = {}) {
  const normalizedSeason = manualReviewInteger(seasonNumber);
  const entries = new Map();
  const ensure = (episodeNumber) => {
    const episode = manualReviewInteger(episodeNumber);
    if (episode === null || episode < 1) return null;
    const key = manualReviewEpisodeCoordinateKey(normalizedSeason, episode);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        media_type: "episode",
        show_title: showTitle,
        season: normalizedSeason,
        episode,
        title: "",
        release_date: "",
        watched_at: "",
        state_at: "",
        source: "",
        sources: [],
        playHistory: [],
        state: "unknown",
        pendingReview: null,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  for (const metadata of Array.isArray(metadataEpisodes) ? metadataEpisodes : []) {
    const metadataSeason = manualReviewInteger(metadata.season_number ?? metadata.seasonNumber ?? metadata.season);
    if (normalizedSeason !== null && metadataSeason !== null && metadataSeason !== normalizedSeason) continue;
    const entry = ensure(metadata.episode_number ?? metadata.episodeNumber ?? metadata.episode);
    if (!entry) continue;
    const title = String(metadata.name || metadata.title || "").trim();
    if (title) entry.title = title;
    const releaseDate = episodeReleaseDateFromRecord(metadata);
    if (releaseDate) entry.release_date = releaseDate;
  }

  for (const local of Array.isArray(localEpisodes) ? localEpisodes : []) {
    const localSeason = manualReviewInteger(local.season ?? local.seasonNumber);
    if (normalizedSeason !== null && localSeason !== normalizedSeason) continue;
    const entry = ensure(local.episode ?? local.episodeNumber);
    if (!entry) continue;
    if (!entry.title) entry.title = episodeTitleFromRecord(local);
    if (!entry.release_date) entry.release_date = episodeReleaseDateFromRecord(local);
    const watchedAt = episodeWatchedAtFromRecord(local);
    if (watchedAt && episodeStateFromRecord(local) === "watched") {
      entry.watched_at = latestEpisodeDate(entry.watched_at, watchedAt);
    }
    if (watchedAt) entry.state_at = latestEpisodeDate(entry.state_at, watchedAt);
    const sourceValues = [
      ...(Array.isArray(local.sources) ? local.sources : local.sources ? [local.sources] : []),
      local.source,
      ...(Array.isArray(local.playHistory) ? local.playHistory.map((play) => play?.source) : []),
    ].filter(Boolean).map((source) => String(source).trim());
    for (const source of sourceValues) {
      if (!entry.sources.includes(source)) entry.sources.push(source);
    }
    if (!entry.source && local.source) entry.source = String(local.source).trim();
    if (Array.isArray(local.playHistory)) entry.playHistory.push(...local.playHistory);
    entry.state = episodeStateFromRecord(local);
  }

  for (const pending of groupReviewsByEpisode(pendingReviews)) {
    const pendingSeason = reviewSeason(pending);
    if (normalizedSeason !== null && pendingSeason !== null && pendingSeason !== normalizedSeason) continue;
    const entry = ensure(reviewEpisode(pending));
    if (!entry) continue;
    const title = reviewEpisodeTitle(pending);
    if (title) entry.title = title;
    const releaseDate = String(pending.release_date || "").trim();
    if (releaseDate) entry.release_date = releaseDate;
    entry.pendingReview = pending;
    entry.state = "pending";
  }

  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      title: entry.title || `Episode ${entry.episode}`,
    }))
    .sort((left, right) => left.episode - right.episode);
}

export function manualWatchReviewEpisodeStatusLabel(episode = {}) {
  const pendingReviews = episode.pendingReview?.reviews || [];
  if (pendingReviews.length) {
    const sources = [...new Set(pendingReviews.map(reviewSource))];
    const observedAt = pendingReviews
      .map((review) => review.observed_watched_at || review.media?.watched_at || review.updated_at)
      .filter(Boolean)
      .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
      .at(-1);
    return `Marked watched on ${sources.join(", ") || "a connected app"}${observedAt ? ` - ${dateLabel(observedAt)}` : ""}`;
  }
  if (episode.state === "watched") {
    return episode.watched_at
      ? `Watched - ${dateLabel(episode.watched_at)}`
      : "Watched - date unavailable";
  }
  if (episode.state === "unwatched") {
    return episode.state_at || episode.watched_at
      ? `Unwatched - ${dateLabel(episode.state_at || episode.watched_at)}`
      : "Unwatched - date unavailable";
  }
  return "Not watched";
}

function manualWatchReviewPendingSources(episode = {}) {
  return [...new Set(
    (episode.pendingReview?.reviews || [])
      .map((review) => review.source || review.media?.source || "")
      .filter(Boolean),
  )];
}

function manualWatchReviewEventHtml(episode = {}) {
  const pendingReviews = episode.pendingReview?.reviews || [];
  const isPending = pendingReviews.length > 0;
  const state = isPending ? "pending" : String(episode.state || "unknown");
  if (!isPending && state === "unknown") {
    return `<span class="manual-watch-review-episode-event manual-watch-review-episode-event--unknown">Not watched</span>`;
  }

  if (isPending) {
    const sources = manualWatchReviewPendingSources(episode);
    const detectedAt = pendingReviews
      .map((review) => {
        const numeric = Number(review.updated_at || review.created_at || 0);
        if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
        return review.observed_watched_at || review.media?.watched_at || "";
      })
      .filter(Boolean)
      .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
      .at(-1);
    const detectedLabel = detectedAt ? ` · Detected ${dateLabel(detectedAt)}` : "";
    return `
      <span class="manual-watch-review-episode-event manual-watch-review-episode-event--pending">
        <span class="manual-watch-review-episode-event-date">${escapeHtml(`Marked watched${detectedLabel}`)}</span>
        ${sources.map((source) => sourceBadgeHtml(source)).join("")}
      </span>
    `;
  }

  const label = state === "unwatched" ? "Unwatched" : "Watched";
  const timestamp = state === "unwatched"
    ? episode.state_at || episode.watched_at
    : episode.watched_at || episode.state_at;
  const sources = platformSourceValues(episode);
  const timestampLabel = timestamp ? ` - ${dateLabel(timestamp)}` : "";
  return `
    <span class="manual-watch-review-episode-event manual-watch-review-episode-event--${escapeAttribute(state)}">
      <span class="manual-watch-review-episode-event-date">${escapeHtml(`${label}${timestampLabel}`)}</span>
      ${sources.map((source) => sourceBadgeHtml(source)).join("")}
    </span>
  `;
}

export function reviewActionScopeLabel(scope, action, source = "", seasonLabel = "the season") {
  // Season and show actions only change the episodes waiting for review.
  if (scope === "show") {
    if (action === "dismiss") return "Dismiss reviewed episodes";
    if (action === "release_day") return "Confirm reviewed episodes on air date";
    if (action === "episode_timing") return "Confirm reviewed episodes with episode timing";
    return "Confirm reviewed episodes…";
  }
  if (action === "dismiss") return `Dismiss ${seasonLabel}`;
  if (action === "release_day") return `Confirm ${seasonLabel} on air date`;
  if (action === "episode_timing") return `Confirm ${seasonLabel} with episode timing`;
  return `Confirm ${seasonLabel}…`;
}

function reviewFactHtml(label, valueHtml, { rawValue = false } = {}) {
  return `
    <div class="manual-watch-review-fact">
      <span class="manual-watch-review-fact-label">${escapeHtml(label)}</span>
      <span class="manual-watch-review-fact-value">${rawValue ? valueHtml : escapeHtml(valueHtml)}</span>
    </div>
  `;
}

function pendingDetectedLabel(reviews = []) {
  const timestamp = (Array.isArray(reviews) ? reviews : [])
    .map((review) => {
      const numeric = Number(review.updated_at || review.created_at || 0);
      if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
      return review.observed_watched_at || review.media?.watched_at || "";
    })
    .filter(Boolean)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
    .at(-1);
  return timestamp ? dateLabel(timestamp) : "Not supplied";
}

function renderReviewCard(review, { eagerPoster = true } = {}) {
  const title = reviewTitle(review);
  const episodeTitle = reviewEpisodeTitle(review);
  const href = reviewMovieHref(review);
  const releaseDay = review.release_date ? formatTmdbDate(String(review.release_date).slice(0, 10)) : "Unknown";
  const detected = review.updated_at ? dateLabel(new Date(review.updated_at).toISOString()) : "Not supplied";
  return `
    <article class="manual-watch-review-card" data-manual-watch-review-id="${escapeAttribute(review.id)}">
      <div class="manual-watch-review-poster-wrap">
        <a class="manual-watch-review-poster-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(title)}">
          ${reviewPosterHtml(review, title, { eagerPoster })}
        </a>
      </div>
      <div class="manual-watch-review-main">
        <div class="manual-watch-review-heading">
          <div class="manual-watch-review-heading-title">
            ${reviewSelectCheckboxHtml({ ids: [review.id], label: `Select ${title}` })}
            <div>
              <h3><a class="manual-watch-review-title-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}">${escapeHtml(title)}</a></h3>
              ${episodeTitle ? `<p class="manual-watch-review-episode">${escapeHtml(episodeTitle)}</p>` : ""}
            </div>
          </div>
          <div class="manual-watch-review-top-action manual-watch-review-actions">
            <button class="button-danger" type="button" data-manual-watch-review-action="dismiss">Dismiss (mark unwatched)</button>
          </div>
        </div>
        ${renderInlineReviewDecisionBarHtml([review], `
          ${reviewFactHtml("Marked watched", sourceBadgeHtml(review.source || review.media?.source || "app"), { rawValue: true })}
          ${reviewFactHtml("Detected", detected)}
          ${reviewFactHtml("Released", releaseDay)}
          ${review.observed_watched_at ? reviewFactHtml("Source date", dateLabel(review.observed_watched_at)) : ""}
        `)}
      </div>
    </article>
  `;
}

function renderSourceMismatchCard(review) {
  const mismatch = review.media?.mismatch || {};
  const otherSource = String(mismatch.otherSource || "other metadata source").toUpperCase();
  const stored = mismatch.stored || {};
  const incoming = mismatch.incoming || {};
  const href = reviewShowHref(review);
  return `
    <article class="manual-watch-review-card source-mismatch-review-card" data-manual-watch-review-id="${escapeAttribute(review.id)}">
      <div class="manual-watch-review-main">
        <div class="manual-watch-review-heading"><div><h3>${escapeHtml(reviewShowTitle(review))}</h3><p class="manual-watch-review-episode">${escapeHtml(reviewEpisodeCode(review))} · ${escapeHtml(reviewEpisodeTitle(review))}</p></div><span class="status-pill status-warning">Fix Match Issue</span></div>
        <p class="manual-watch-review-copy">Incoming episode numbering differs from the stored episode. ${escapeHtml(otherSource)} matches the incoming episode.</p>
        <div class="manual-watch-review-meta"><span>Stored: S${String(stored.season ?? "?").padStart(2, "0")}E${String(stored.episode ?? "?").padStart(2, "0")}</span><span>Incoming: S${String(incoming.season ?? "?").padStart(2, "0")}E${String(incoming.episode ?? "?").padStart(2, "0")}</span></div>
        <div class="manual-watch-review-actions"><a class="button-primary" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}">Fix Match</a><button class="button-danger" type="button" data-manual-watch-review-action="dismiss">Dismiss</button></div>
      </div>
    </article>`;
}

export function manualWatchReviewNearbyLabel(direction, episode = null) {
  const label = direction === "before" ? "Before" : "After";
  if (!episode) return direction === "before" ? "Before: no earlier episode" : "After: episode details unavailable";
  const code = episode.code || reviewEpisodeCode(episode);
  const state = episode.watched
    ? "watched"
    : episode.state === "unwatched"
      ? "unwatched"
      : "not marked watched";
  return `${label} ${code}: ${state}`;
}

function renderReviewEpisodeContext(review) {
  const context = review.watch_context || review.watchContext;
  if (!context) return "";
  const items = [
    ["before", context.before],
    ["after", context.after],
  ];
  return items.map(([direction, episode]) => `
    <span class="status-pill ${episode?.watched ? "status-success" : "status-muted"}">${escapeHtml(manualWatchReviewNearbyLabel(direction, episode))}</span>
  `).join("");
}

function manualWatchReviewReleaseLabel(value = "") {
  return value ? `Released ${formatTmdbDate(value)}` : "Release date unknown";
}

function renderReviewEpisodeRow(review = null, episode = null) {
  const pendingReview = review && Array.isArray(review.reviews) ? review : null;
  const reviews = pendingReview?.reviews || [];
  const displayEpisode = episode || {
    key: pendingReview?.key || reviewEpisodeStateKey(pendingReview || review || {}),
    media_type: "episode",
    season: reviewSeason(pendingReview || review || {}),
    episode: reviewEpisode(pendingReview || review || {}),
    title: reviewEpisodeTitle(pendingReview || review || {}),
    release_date: pendingReview?.release_date || "",
    state: "pending",
    pendingReview,
  };
  const isPending = Boolean(pendingReview && reviews.length);
  const displayTitle = String(
    displayEpisode.title
      || reviewEpisodeTitle(pendingReview || {})
      || `Episode ${displayEpisode.episode ?? ""}`,
  ).trim();
  const releaseDate = displayEpisode.release_date || pendingReview?.release_date || "";
  const releaseDay = releaseDate ? formatTmdbDate(String(releaseDate).slice(0, 10)) : "Unknown";
  const ids = reviews.map((item) => String(item.id || "")).filter(Boolean).join(",");
  const pendingAttributes = isPending
    ? `data-manual-watch-review-ids="${escapeAttribute(ids)}"`
    : "";
  const pendingSources = isPending ? manualWatchReviewPendingSources({ ...displayEpisode, pendingReview }) : [];
  const pendingSourceBadges = pendingSources.length
    ? pendingSources.map((source) => sourceBadgeHtml(source)).join("")
    : escapeHtml(groupSourceLabel(reviews));
  return `
    <article class="manual-watch-review-episode-row${isPending ? " is-pending" : ""}" ${pendingAttributes} data-manual-watch-review-episode-key="${escapeAttribute(displayEpisode.key || reviewEpisodeStateKey(displayEpisode))}">
      <div class="manual-watch-review-episode-copy">
        <div class="manual-watch-review-episode-heading">
          <div class="manual-watch-review-episode-heading-main">
            ${isPending ? reviewSelectCheckboxHtml({ ids: reviews.map((item) => item.id), label: `Select ${reviewEpisodeCode(displayEpisode)}` }) : ""}
            <span class="manual-watch-review-episode-code">${escapeHtml(reviewEpisodeCode(displayEpisode))}</span>
            <h4>${escapeHtml(displayTitle || "Episode")}</h4>
            ${!isPending ? `<span class="manual-watch-review-episode-release">${escapeHtml(manualWatchReviewReleaseLabel(releaseDate))}</span>` : ""}
          </div>
          ${isPending ? `<div class="manual-watch-review-top-action manual-watch-review-actions"><button class="button-danger" type="button" data-manual-watch-review-action="dismiss">Dismiss (mark unwatched)</button></div>` : ""}
        </div>
        ${isPending ? renderInlineReviewDecisionBarHtml(reviews, `
          ${reviewFactHtml("Marked watched", pendingSourceBadges, { rawValue: true })}
          ${reviewFactHtml("Detected", pendingDetectedLabel(reviews))}
          ${reviewFactHtml("Released", releaseDay)}
        `) : `
          <div class="manual-watch-review-episode-meta">
            ${manualWatchReviewEventHtml({
              ...displayEpisode,
              pendingReview: null,
            })}
          </div>
        `}
      </div>
    </article>
  `;
}

function groupSourceLabel(reviews) {
  const sources = [...new Set(reviews.map(reviewSource))];
  return sources.length ? sources.join(", ") : "Connected apps";
}

function manualWatchReviewCatalogKey(groupKey, seasonKey) {
  return `${groupKey}:${seasonKey}`;
}

// The show a group's poster and episode catalog come from. The server names
// each review's proven show (proven_show_ids) and flags a title that history
// proves two shows share; a title-only lookup for such a title picked the
// 2026 Scrubs reboot for the 2001 group, so it gets no lookup at all.
export function manualWatchReviewGroupShowIdentity(group) {
  const reviews = group?.reviews || [];
  const proven = [...new Set(reviews
    .map((review) => review.proven_show_ids)
    .filter((ids) => ids && Object.keys(ids).length)
    .map((ids) => JSON.stringify({ imdb: ids.imdb || "", tmdb: ids.tmdb || "", tvdb: ids.tvdb || "" })))];
  const ambiguous = reviews.some((review) => review.show_title_ambiguous);
  if (proven.length === 1) return { ids: JSON.parse(proven[0]), ambiguous, proven: true };
  // Reviews proven to different shows share no answer to trust.
  if (proven.length > 1) return { ids: { imdb: "", tmdb: "", tvdb: "" }, ambiguous, proven: false };
  return { ids: reviewShowIds(reviews[0] || {}), ambiguous, proven: false };
}

function manualWatchReviewGroupHasShowIds(identity) {
  return Boolean(identity.ids.imdb || identity.ids.tmdb || identity.ids.tvdb);
}

export function manualWatchReviewShowLookupUrl(group) {
  const identity = manualWatchReviewGroupShowIdentity(group);
  const { ids } = identity;
  const params = new URLSearchParams();
  // Ids alone decide the show when the title names several.
  if (group?.title && !(identity.ambiguous && manualWatchReviewGroupHasShowIds(identity))) params.set("title", group.title);
  if (ids.tmdb) params.set("tmdbId", ids.tmdb);
  if (ids.tvdb) params.set("tvdbId", ids.tvdb);
  if (ids.imdb) params.set("imdbId", ids.imdb);
  return `/api/show?${params.toString()}`;
}

async function fetchManualWatchReviewShow(group) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const response = await fetch(manualWatchReviewShowLookupUrl(group), {
      headers: authHeaders(),
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => ({}));
    return body.show || null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function scheduleManualWatchReviewCatalogHydration(reviews, requestId) {
  if (manualWatchReviewCatalogTimer) clearTimeout(manualWatchReviewCatalogTimer);
  const catalogRequestId = ++manualWatchReviewCatalogRequestSerial;
  if (!Array.isArray(reviews) || !reviews.some(isEpisodeReview)) return;
  const groups = reviewGroupsForDisplay(groupManualWatchReviews(reviews));
  const showGroups = groups.filter((group) => group.kind === "show");
  if (!showGroups.length) return;
  manualWatchReviewCatalogTimer = setTimeout(() => {
    manualWatchReviewCatalogTimer = null;
    hydrateManualWatchReviewShowPosters(showGroups, reviews, requestId, catalogRequestId).catch(() => null);
  }, 0);
}

function manualWatchReviewSeasonEpisodes(group, season) {
  const catalog = manualWatchReviewEpisodeCatalogs.get(manualWatchReviewCatalogKey(group.key, season.key));
  const pendingByKey = new Map(
    groupReviewsByEpisode(season.reviews).map((review) => [review.key, review]),
  );
  const episodes = catalog || buildManualWatchReviewEpisodeCatalog({
      seasonNumber: season.key,
      showTitle: group.title,
      pendingReviews: season.reviews,
    });
  return episodes.map((episode) => {
    const pendingReview = pendingByKey.get(episode.key) || null;
    return {
      ...episode,
      pendingReview,
      state: pendingReview
        ? "pending"
        : episode.state === "pending"
          ? "unknown"
          : episode.state,
    };
  });
}

function manualWatchReviewSeasonCatalogLoaded(group, season) {
  return manualWatchReviewEpisodeCatalogs.has(manualWatchReviewCatalogKey(group.key, season.key));
}

async function fetchManualWatchReviewShowMetadata(group) {
  const metadataKey = String(group?.key || "");
  const cached = metadataKey ? manualWatchReviewShowMetadata.get(metadataKey) : null;
  if (cached) return cached;

  const first = group?.reviews?.[0] || {};
  const request = (async () => {
    const identity = manualWatchReviewGroupShowIdentity(group);
    const { ids } = identity;
    // A shared title with no ids would resolve to whichever show the title
    // search favours; leave the group without show artwork or a catalog.
    if (identity.ambiguous && !manualWatchReviewGroupHasShowIds(identity)) {
      return { show: null, tmdbData: null, seasonLookupId: "", showPosterUrl: "" };
    }
    const show = await fetchManualWatchReviewShow(group);
    const showTmdbId = String(show?.tmdb_id || ids.tmdb || "").trim();
    const showTvdbId = String(show?.tvdb_id || ids.tvdb || "").trim();
    const showImdbId = String(show?.imdb_id || ids.imdb || "").trim();
    const tmdbData = await fetchTmdbDetails(
      "tv",
      showTmdbId,
      identity.ambiguous ? "" : group.title,
      { imdbId: showImdbId, tvdbId: showTvdbId },
      { immediate: true },
    ).catch(() => null);
    const resolvedTmdbId = String(tmdbData?.id || showTmdbId || "").trim();
    const resolvedTvdbId = String(
      tmdbData?.tvdb_id
        || tmdbData?.external_ids?.tvdb_id
        || showTvdbId,
    ).trim();
    const seasonLookupId = resolvedTmdbId || (resolvedTvdbId ? "tvdb:" + resolvedTvdbId : "");
    const reviewMedia = first.media || {};
    const showPosterUrl = String(
      first.showPosterUrl
        || first.show_poster_url
        || reviewMedia.showPosterUrl
        || reviewMedia.show_poster_url
        || show?.show_poster_url
        || show?.canonical_poster_url
        || tmdbPoster(tmdbData?.poster_path, tmdbData?.id, "tv")
        || "",
    ).trim();
    return { show, tmdbData, seasonLookupId, showPosterUrl };
  })();

  if (metadataKey) {
    manualWatchReviewShowMetadata.set(metadataKey, request);
    request.catch(() => {
      if (manualWatchReviewShowMetadata.get(metadataKey) === request) {
        manualWatchReviewShowMetadata.delete(metadataKey);
      }
    });
  }
  return request;
}

async function hydrateManualWatchReviewShowPosters(groups, reviews, requestId, catalogRequestId) {
  await Promise.allSettled(groups.map(async (group) => {
    const metadata = await fetchManualWatchReviewShowMetadata(group);
    if (metadata?.showPosterUrl) {
      manualWatchReviewShowPosterUrls.set(group.key, metadata.showPosterUrl);
    }
  }));
  if (
    requestId !== latestManualWatchReviewFullRequest
    || catalogRequestId !== manualWatchReviewCatalogRequestSerial
    || state.manualWatchReviews !== reviews
  ) return;
  if (state.activeView === "manualWatchReview") renderManualWatchReviewPage();
}

async function fetchManualWatchReviewSeasonCatalog(group, season) {
  const metadata = await fetchManualWatchReviewShowMetadata(group);
  const seasonNumber = manualReviewInteger(season.key);
  const details = seasonNumber !== null && metadata.seasonLookupId
    ? await fetchTmdbSeasonDetails(metadata.seasonLookupId, seasonNumber, { displayOrder: false }).catch(() => null)
    : null;
  return {
    catalog: buildManualWatchReviewEpisodeCatalog({
      seasonNumber,
      showTitle: group.title,
      pendingReviews: season.reviews,
      metadataEpisodes: details?.episodes || [],
      localEpisodes: metadata.show?.episodes || [],
    }),
    showPosterUrl: metadata.showPosterUrl,
  };
}

async function hydrateManualWatchReviewSeason(group, season, reviews, requestId, catalogRequestId) {
  const catalogKey = manualWatchReviewCatalogKey(group.key, season.key);
  if (manualWatchReviewEpisodeCatalogs.has(catalogKey)) {
    return manualWatchReviewEpisodeCatalogs.get(catalogKey);
  }
  const activeLoad = manualWatchReviewCatalogLoads.get(catalogKey);
  if (activeLoad) return activeLoad;

  const load = fetchManualWatchReviewSeasonCatalog(group, season)
    .then((result) => {
      if (
        !result
        || requestId !== latestManualWatchReviewFullRequest
        || catalogRequestId !== manualWatchReviewCatalogRequestSerial
        || state.manualWatchReviews !== reviews
      ) return null;
      manualWatchReviewEpisodeCatalogs.set(catalogKey, result.catalog);
      if (result.showPosterUrl) manualWatchReviewShowPosterUrls.set(group.key, result.showPosterUrl);
      if (state.activeView === "manualWatchReview") renderManualWatchReviewPage();
      return result.catalog;
    })
    .catch(() => null)
    .finally(() => {
      if (manualWatchReviewCatalogLoads.get(catalogKey) === load) {
        manualWatchReviewCatalogLoads.delete(catalogKey);
      }
    });
  manualWatchReviewCatalogLoads.set(catalogKey, load);
  return load;
}

function hydrateManualWatchReviewSeasonFromDetails(details) {
  if (!details?.open) return;
  const groupKey = String(details.dataset.manualWatchReviewGroupKey || "");
  const seasonKey = String(details.dataset.manualWatchReviewSeasonKey || "");
  const reviews = state.manualWatchReviews;
  if (!groupKey || !seasonKey || !Array.isArray(reviews)) return;
  const group = groupManualWatchReviews(reviews)
    .find((item) => item.kind === "show" && item.key === groupKey);
  const season = group
    ? groupReviewsBySeason(group.reviews).find((item) => String(item.key) === seasonKey)
    : null;
  if (!group || !season) return;
  hydrateManualWatchReviewSeason(
    group,
    season,
    reviews,
    latestManualWatchReviewFullRequest,
    manualWatchReviewCatalogRequestSerial,
  ).catch(() => null);
}

function renderReviewShowGroup(group, query = "", { isTopmost = false } = {}) {
  const count = groupReviewsByEpisode(group.reviews).length;
  const source = groupSourceLabel(group.reviews);
  const seasons = groupReviewsBySeason(group.reviews);
  const latestSeasonKey = seasons[0]?.key || "";
  const href = reviewShowHref(group.reviews[0]);
  return `
    <article class="manual-watch-review-show" data-manual-watch-review-show-key="${escapeAttribute(group.key)}">
      <div class="manual-watch-review-poster-wrap manual-watch-review-show-poster-wrap">
        <a class="manual-watch-review-poster-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(group.title)}">
          ${reviewPosterHtml(group.reviews[0], group.title, { showPosterUrl: manualWatchReviewShowPosterUrls.get(group.key) || "", eagerPoster: true })}
        </a>
      </div>
      <div class="manual-watch-review-show-content">
        <div class="manual-watch-review-show-header">
          <div class="manual-watch-review-show-copy">
            <div class="manual-watch-review-heading-title">
              ${reviewSelectCheckboxHtml({ ids: group.reviews.map((item) => item.id), scope: "show", groupKey: group.key, label: `Select all reviewed episodes in ${group.title}` })}
              <h3><a class="manual-watch-review-title-link" href="${escapeAttribute(href)}" data-manual-watch-review-link="${escapeAttribute(href)}">${escapeHtml(group.title)}</a></h3>
            </div>
            <div class="manual-watch-review-meta">
              <span>${count} episode${count === 1 ? "" : "s"} waiting${group.reviews.some(r => (r.media?.watchProvenance || r.media?.watch_provenance)?.episode_order) ? " · Aired episode numbers" : ""}</span>
              <span>Marked watched on ${escapeHtml(source)}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="manual-watch-review-episodes" data-manual-watch-review-show-key="${escapeAttribute(group.key)}">
        <div class="manual-watch-review-season-list">${seasons.map((season) => {
            const seasonStateKey = reviewSeasonStateKey(group.key, season.key);
            const catalogEpisodes = manualWatchReviewSeasonEpisodes(group, season);
            const catalogLoaded = manualWatchReviewSeasonCatalogLoaded(group, season);
            const seasonOpen = expandedReviewSeasonKeys.has(seasonStateKey) || Boolean(query);
            return `
            <section class="manual-watch-review-season" data-manual-watch-review-season-key="${escapeAttribute(season.key)}">
              <details class="manual-watch-review-season-details" data-manual-watch-review-season-details-key="${escapeAttribute(seasonStateKey)}" data-manual-watch-review-group-key="${escapeAttribute(group.key)}" data-manual-watch-review-season-key="${escapeAttribute(season.key)}"${seasonOpen ? " open" : ""}>
                <summary class="manual-watch-review-season-header">
                  <div class="manual-watch-review-season-heading">
                    ${reviewSelectCheckboxHtml({ ids: season.reviews.map((item) => item.id), scope: "season", groupKey: group.key, seasonKey: season.key, label: `Select all reviewed episodes in ${season.title}` })}
                    <strong>${escapeHtml(season.title)}</strong>
                    <span>${season.episodes.length} waiting${catalogLoaded ? " · " + catalogEpisodes.length + " episode" + (catalogEpisodes.length === 1 ? "" : "s") : ""}</span>
                  </div>
                </summary>
                <div class="manual-watch-review-season-content">
                  <div class="manual-watch-review-episode-list">${catalogEpisodes.map((episode) => renderReviewEpisodeRow(episode.pendingReview, episode)).join("")}</div>
                </div>
              </details>
            </section>
          `;
        }).join("")}</div>
      </div>
    </article>
  `;
}

function reviewRecordsForCard(card) {
  if (!card) return [];
  const reviews = Array.isArray(state.manualWatchReviews) ? state.manualWatchReviews : [];
  const ids = String(card.dataset.manualWatchReviewIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length) {
    const wanted = new Set(ids);
    return reviews.filter((review) => wanted.has(String(review.id)));
  }
  const id = card.dataset.manualWatchReviewId;
  const review = reviews.find((item) => String(item.id) === String(id));
  return review ? [review] : [];
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function logManualWatchReviewError(error) {
  if (typeof console !== "undefined") console.warn("Manual Watch review refresh failed", error);
}

function setSummaryVisibility() {
  const button = document.querySelector("#manualWatchReviewButton");
  const count = document.querySelector("#manualWatchReviewCount");
  const pending = Number(state.manualWatchReviewCount || 0);
  const title = Number(state.manualWatchSourceMismatchCount || 0) > 0 ? "Fix Match Issue" : "Manual Watch review";
  const label = `${pending} item${pending === 1 ? "" : "s"} waiting`;
  if (count) {
    count.textContent = pending > 99 ? "99+" : String(pending);
    count.setAttribute("aria-label", label);
  }
  if (button) {
    button.classList.toggle("hidden", !state.token || pending <= 0);
    const labelElement = button.querySelector(".manual-watch-review-nav-label");
    if (labelElement) labelElement.textContent = title;
    button.setAttribute("aria-label", pending > 0
      ? `${title} - ${label}`
      : title);
    button.title = title;
  }
}

function bindRenderedReviewDetails(container) {
  for (const details of container.querySelectorAll(".manual-watch-review-season-details[data-manual-watch-review-season-details-key]")) {
    details.addEventListener("toggle", () => {
      const key = details.dataset.manualWatchReviewSeasonDetailsKey;
      if (!key) return;
      if (details.open) {
        expandedReviewSeasonKeys.add(key);
        collapsedReviewSeasonKeys.delete(key);
        hydrateManualWatchReviewSeasonFromDetails(details);
      } else {
        expandedReviewSeasonKeys.delete(key);
        collapsedReviewSeasonKeys.add(key);
      }
    });
  }
}

function bindManualWatchReviewRefresh() {
  const refreshButton = document.querySelector("#manualWatchReviewRefresh");
  if (!refreshButton || refreshButton.dataset.bound) return;
  refreshButton.dataset.bound = "true";
  refreshButton.addEventListener("click", async () => {
    if (refreshButton.disabled) return;
    const label = refreshButton.textContent;
    refreshButton.disabled = true;
    refreshButton.setAttribute("aria-busy", "true");
    refreshButton.textContent = "Rechecking…";
    try {
      await loadManualWatchReview({ refresh: true });
      _cb.setMessage?.("Manual Watch review status rechecked.", "success");
    } catch (error) {
      reportManualWatchReviewFailure(error, "Manual Watch review could not be rechecked.");
    } finally {
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
      refreshButton.textContent = label || "Recheck status";
    }
  });
}

export function initManualWatchReview(callbacks = {}) {
  _cb = callbacks;
  if (typeof callbacks.openConfirmDialog === "function") _openConfirmDialog = callbacks.openConfirmDialog;
  const container = document.querySelector("#manualWatchReviewRows");
  if (!container) return;
  bindManualWatchReviewRefresh();

  if (!container.dataset.bound) {
    container.dataset.bound = "true";
    container.addEventListener("change", (event) => {
      handleBulkSelectionChange(event, {
        getFilteredReviews: () => filterManualWatchReviews(currentManualWatchReviews(), String(state.manualWatchReviewSearch || "").trim()),
        getAllReviews: currentManualWatchReviews,
        onRender: renderManualWatchReviewPage,
        container,
      });
    });
    container.addEventListener("click", (event) => {
      if (event.target.closest?.(".manual-watch-review-select-box")) { event.stopPropagation(); return; }
      if (handleBulkSelectionClick(event, {
        getFilteredReviews: () => filterManualWatchReviews(currentManualWatchReviews(), String(state.manualWatchReviewSearch || "").trim()),
        getAllReviews: currentManualWatchReviews,
        onRender: renderManualWatchReviewPage,
        container,
      })) return;
      if (event.target.closest?.("[data-manual-watch-review-bulk-clear]:not(:disabled)")) { clearBulkReviewSelection(); renderManualWatchReviewPage(); return; }
      const bulkButton = event.target.closest?.("[data-manual-watch-review-bulk-action]");
      if (bulkButton && !bulkButton.disabled) {
        triggerBulkSelectionWorkflow(bulkButton.dataset.manualWatchReviewBulkAction || "approve", {
          getAllReviews: currentManualWatchReviews, openConfirmDialog: _openConfirmDialog,
          runSelectionAction: handleBulkSelectionAction, setMessage: _cb.setMessage, container,
        }).catch((error) => reportManualWatchReviewFailure(error));
        return;
      }
      const link = event.target.closest?.("[data-manual-watch-review-link]");
      if (link && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0) {
        const href = link.dataset.manualWatchReviewLink;
        if (href && typeof _cb.navigateTo === "function") {
          event.preventDefault();
          _cb.navigateTo(href);
          return;
        }
      }

      const confirmButton = event.target.closest?.("[data-manual-watch-review-confirm]");
      if (confirmButton && !confirmButton.disabled) {
        const card = confirmButton.closest("[data-manual-watch-review-id], [data-manual-watch-review-ids]");
        const reviews = reviewRecordsForCard(card);
        if (!reviews.length) return;
        const item = getInlineReviewDecisionItem(reviews);
        const validation = validateInlineDecision(item);
        if (!validation.ok) {
          _cb.setMessage?.(validation.error, "error");
          if (validation.selector) card?.querySelector?.(validation.selector)?.focus?.();
          return;
        }
        const { decision } = validation;
        if (decision.action === "dismiss") {
          confirmManualWatchReviewAction({
            key: `review:${reviews.map((entry) => entry.id).join(",")}:dismiss:`,
            action: "dismiss",
            mode: "",
            title: reviewTitle(reviews[0]),
            source: groupSourceLabel(reviews),
          }).then((confirmed) => {
            if (!confirmed) return;
            if (reviews.length > 1 || card?.dataset.manualWatchReviewIds) {
              return handleEpisodeAction(reviews, "dismiss", "", card);
            }
            return handleReviewAction(reviews[0].id, "dismiss", "", card);
          }).catch((error) => reportManualWatchReviewFailure(error));
          return;
        }
        const save = reviews.length > 1 || card?.dataset.manualWatchReviewIds
          ? handleEpisodeAction(reviews, "approve", decision.mode, card, decision.watchedAt)
          : handleReviewAction(reviews[0].id, "approve", decision.mode, card, decision.watchedAt);
        save.catch((error) => reportManualWatchReviewFailure(error));
        return;
      }

      const button = event.target.closest?.("[data-manual-watch-review-action]");
      if (!button || button.disabled) return;
      const card = button.closest("[data-manual-watch-review-id], [data-manual-watch-review-ids]");
      const reviews = reviewRecordsForCard(card);
      if (!reviews.length) return;
      const action = button.dataset.manualWatchReviewAction;
      const mode = button.dataset.manualWatchReviewMode || "";
      const review = reviews[0];
      if (review.review_kind === "source_mismatch") {
        handleReviewAction(review.id, action, mode, card)
          .catch((error) => reportManualWatchReviewFailure(error));
        return;
      }
      confirmManualWatchReviewAction({
        key: `review:${reviews.map((item) => item.id).join(",")}:${action}:${mode}`,
        action,
        mode,
        title: reviewTitle(review),
        source: groupSourceLabel(reviews),
      }).then((confirmed) => {
        if (!confirmed) return;
        if (reviews.length > 1 || card?.dataset.manualWatchReviewIds) {
          return handleEpisodeAction(reviews, action, mode, card);
        }
        return handleReviewAction(review.id, action, mode, card);
      }).catch((error) => {
        reportManualWatchReviewFailure(error);
      });
    });
  }

  const search = document.querySelector("#manualWatchReviewSearch");
  if (search && !search.dataset.bound) {
    search.dataset.bound = "true";
    search.value = state.manualWatchReviewSearch || "";
    search.addEventListener("input", () => {
      state.manualWatchReviewSearch = search.value;
      renderManualWatchReviewPage();
    });
  }

  startManualWatchReviewPolling();
}

export function renderManualWatchReviewSummary() {
  setSummaryVisibility();
}

export function renderManualWatchReviewPage() {
  const container = document.querySelector("#manualWatchReviewRows");
  const status = document.querySelector("#manualWatchReviewStatus");
  const filterStatus = document.querySelector("#manualWatchReviewFilterStatus");
  if (!container) return;
  if (state.manualWatchReviewLoading && !state.manualWatchReviewLoaded) {
    container.innerHTML = `<div class="idle-state"><b>Loading Manual Watch review...</b></div>`;
    return;
  }
  if (state.manualWatchReviewError) {
    container.innerHTML = `<div class="idle-state"><b>Manual Watch review is unavailable.</b><span>${escapeHtml(state.manualWatchReviewError)}</span></div>`;
    return;
  }

  const query = String(state.manualWatchReviewSearch || "").trim();
  const reviews = Array.isArray(state.manualWatchReviews) ? state.manualWatchReviews : [];
  pruneBulkReviewSelection(reviews);
  syncInlineReviewItems(reviews);
  const filtered = filterManualWatchReviews(reviews, query);
  const displayCount = manualWatchReviewDisplayCount(reviews);
  const filteredDisplayCount = manualWatchReviewDisplayCount(filtered);
  const orderedGroups = reviewGroupsForDisplay(groupManualWatchReviews(reviews));

  if (!reviews.length) {
    container.innerHTML = `<div class="idle-state"><b>No manual watch decisions are waiting.</b><span>Items detected under Require review will appear here.</span></div>`;
  } else if (!filtered.length) {
    container.innerHTML = `<div class="idle-state"><b>No review items match “${escapeHtml(query)}”.</b><span>Try a show, episode, or connected app.</span></div>`;
  } else {
    const filteredGroups = groupManualWatchReviews(filtered);
    const filteredOrderedGroups = orderManualWatchReviewGroups(
      filteredGroups,
      orderedGroups.map((group) => group.key),
    );
    const topGroupKey = filteredOrderedGroups[0]?.key || "";
    const bulkBar = renderBulkReviewBar({ visibleReviews: filtered, allReviews: reviews });
    container.innerHTML = bulkBar + filteredOrderedGroups
      .map((group) => group.kind === "show"
        ? renderReviewShowGroup(group, query, { isTopmost: group.key === topGroupKey })
        : group.kind === "mismatch"
          ? (group.reviews[0].review_kind === "episode_order_conflict" ? renderEpisodeOrderConflict(group.reviews[0]) : renderSourceMismatchCard(group.reviews[0]))
          : renderReviewCard(group.reviews[0], { eagerPoster: group.key === topGroupKey }))
      .join("");
    syncIndeterminateCheckboxes(container);
    bindRenderedReviewDetails(container);
    hydratePosters(container, { allowNetwork: true });
  }

  if (status) {
    status.textContent = displayCount
      ? query
        ? `${filteredDisplayCount} of ${displayCount} item${displayCount === 1 ? "" : "s"} waiting for a decision.`
        : `${displayCount} item${displayCount === 1 ? "" : "s"} waiting for a decision.`
      : "Nothing is waiting for review.";
    status.className = "message muted";
  }
  if (filterStatus) {
    filterStatus.textContent = query && displayCount
      ? `${filteredDisplayCount} match${filteredDisplayCount === 1 ? "" : "es"}`
      : "";
  }
  setSummaryVisibility();
}

export async function loadManualWatchReview({ summaryOnly = false, refresh = false } = {}) {
  if (!state.token) {
    state.manualWatchReviews = [];
    state.manualWatchReviewCount = 0;
    state.manualWatchSourceMismatchCount = 0;
    if (manualWatchReviewCatalogTimer) clearTimeout(manualWatchReviewCatalogTimer);
    manualWatchReviewCatalogTimer = null;
    manualWatchReviewCatalogRequestSerial += 1;
    manualWatchReviewEpisodeCatalogs.clear();
    manualWatchReviewShowPosterUrls.clear();
    manualWatchReviewCatalogLoads.clear();
    manualWatchReviewShowMetadata.clear();
    pendingManualWatchReviewActions.clear();
    suppressedManualWatchReviewIds.clear();
    clearBulkReviewSelection({ clearDecisions: true });
    state.manualWatchReviewLoaded = false;
    manualWatchReviewGroupOrder = [];
    renderManualWatchReviewSummary();
    return [];
  }
  const requestId = ++manualWatchReviewRequestSerial;
  if (summaryOnly) {
    latestManualWatchReviewCountRequest = Math.max(latestManualWatchReviewCountRequest, requestId);
  } else {
    latestManualWatchReviewFullRequest = requestId;
  }
  if (!summaryOnly) {
    state.manualWatchReviewLoading = true;
    state.manualWatchReviewError = "";
    renderManualWatchReviewPage();
  }
  try {
    const params = new URLSearchParams();
    if (summaryOnly) params.set("summary", "1");
    if (refresh) params.set("refresh", "1");
    const query = params.toString();
    const response = await fetch(`/api/manual-watch-review${query ? `?${query}` : ""}`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `Manual Watch review failed with ${response.status}`);
    const serverCount = Number(body.count || 0);
    const responseReviews = Array.isArray(body.reviews) ? body.reviews : [];
    const summaryIds = summaryOnly && Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    const responseIds = summaryIds || new Set(responseReviews.map((review) => String(review.id)));
    const isLatestFullRequest = !summaryOnly && requestId === latestManualWatchReviewFullRequest;
    // An older full response can be missing an item that a newer response
    // still contains (for example when the action and provider refresh race).
    // Only the newest full snapshot may retire the suppression; otherwise that
    // older response can let a stale newer response repaint the item once.
    if (isLatestFullRequest) {
      for (const id of suppressedManualWatchReviewIds.keys()) {
        if (!responseIds.has(id)) suppressedManualWatchReviewIds.delete(id);
      }
    }
    // Subtract only hidden reviews the server still counts. A decided review
    // the server has already dropped would otherwise cancel out a newly
    // flagged one and hide the sidebar notice until a reload.
    const hiddenReviews = [
      ...pendingManualWatchReviewActions.values(),
      ...suppressedManualWatchReviewIds.values(),
    ].filter((review) => !summaryIds || summaryIds.has(String(review.id)));
    const hiddenCount = manualWatchReviewDisplayCount(hiddenReviews);
    const visibleServerCount = Math.max(0, serverCount - hiddenCount);
    // Summary and full-page requests can overlap during navigation or while a
    // provider event is arriving. Never let an older response put the page
    // back into a state that disagrees with the newer sidebar count.
    if (requestId >= latestManualWatchReviewCountRequest) {
      latestManualWatchReviewCountRequest = requestId;
      state.manualWatchReviewCount = summaryOnly
        ? visibleServerCount
        : manualWatchReviewDisplayCount(responseReviews.filter((review) => (
          !pendingManualWatchReviewActions.has(String(review.id))
          && !suppressedManualWatchReviewIds.has(String(review.id))
        )));
      state.manualWatchSourceMismatchCount = Math.max(Number(body.sourceMismatchCount) || 0, 0);
    }
    if (isLatestFullRequest) {
      state.manualWatchReviews = responseReviews.filter((review) => (
        !pendingManualWatchReviewActions.has(String(review.id))
        && !suppressedManualWatchReviewIds.has(String(review.id))
      ));
      // A fresh server snapshot establishes the preferred newest-first order.
      // Single-item decisions keep any remaining show at its current position.
      manualWatchReviewGroupOrder = [];
      manualWatchReviewEpisodeCatalogs.clear();
      manualWatchReviewShowPosterUrls.clear();
      manualWatchReviewCatalogLoads.clear();
      manualWatchReviewShowMetadata.clear();
      state.manualWatchReviewLoaded = true;
      // Compare with the server's own count, not state.manualWatchReviewCount
      // (set from this same response above, so always equal). If the server
      // and page ever group reviews differently, resetting here would let
      // every summary poll start another full reload.
      if (manualWatchReviewDisplayCount(state.manualWatchReviews) === visibleServerCount) manualWatchReviewLastRefreshCount = null;
    }
    renderManualWatchReviewSummary();
    if (state.activeView === "manualWatchReview" && isLatestFullRequest) renderManualWatchReviewPage();
    if (isLatestFullRequest) scheduleManualWatchReviewCatalogHydration(state.manualWatchReviews, requestId);
    if (
      summaryOnly
      && state.activeView === "manualWatchReview"
      && visibleServerCount !== manualWatchReviewDisplayCount(state.manualWatchReviews)
      && manualWatchReviewLastRefreshCount !== visibleServerCount
    ) {
      // A summary response can win the race with the full page request that
      // was already in flight when the provider flag arrived. Start one newer
      // full request for this count so the stale response cannot hide the new
      // review row. The request serial above makes the older full response a
      // no-op when it eventually completes.
      manualWatchReviewLastRefreshCount = visibleServerCount;
      loadManualWatchReview().catch((error) => {
        logManualWatchReviewError(error);
      });
    }
    return state.manualWatchReviews;
  } catch (error) {
    if (!summaryOnly && requestId === latestManualWatchReviewFullRequest) {
      state.manualWatchReviewError = error.message || "Manual Watch review failed.";
      state.manualWatchReviewLoaded = true;
      renderManualWatchReviewPage();
    }
    throw error;
  } finally {
    if (!summaryOnly && requestId === latestManualWatchReviewFullRequest) {
      state.manualWatchReviewLoading = false;
      if (state.activeView === "manualWatchReview") renderManualWatchReviewPage();
    }
  }
}

async function postReviewAction(id, action, mode = "", watchedAt = "") {
  const payload = {};
  if (mode) payload.mode = mode;
  if (watchedAt) payload.watched_at = watchedAt;
  if (action === "approve") payload.background_sync = true;
  const response = await fetch(`/api/manual-watch-review/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    const error = new Error(body.error || `Manual watch review ${action} failed with ${response.status}`);
    error.status = response.status;
    error.response = body;
    if (Array.isArray(body.failureTargets)) error.failureTargets = body.failureTargets;
    if (Array.isArray(body.targetStates)) error.targetStates = body.targetStates;
    throw error;
  }
  if (["approve", "dismiss"].includes(action)) _cb.clearDerivedUiCaches?.();
  return body;
}

function optimisticallyRemoveReviews(reviews = []) {
  const ids = new Set();
  const removed = [];
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const id = String(review?.id || "");
    if (!id || ids.has(id)) continue;
    ids.add(id);
    pendingManualWatchReviewActions.set(id, review);
    removed.push(review);
  }
  if (!removed.length) return removed;
  state.manualWatchReviews = currentManualWatchReviews().filter((review) => !ids.has(String(review.id)));
  state.manualWatchReviewCount = manualWatchReviewDisplayCount(state.manualWatchReviews);
  return removed;
}

function completeOptimisticReview(id) {
  const key = String(id);
  const review = pendingManualWatchReviewActions.get(key);
  pendingManualWatchReviewActions.delete(key);
  if (review) suppressedManualWatchReviewIds.set(key, review);
  state.manualWatchReviewCount = manualWatchReviewDisplayCount(state.manualWatchReviews);
}

function restoreOptimisticReviews(reviews = []) {
  const existingIds = new Set(state.manualWatchReviews.map((review) => String(review.id)));
  const restored = reviews.filter((review) => {
    const id = String(review?.id || "");
    pendingManualWatchReviewActions.delete(id);
    suppressedManualWatchReviewIds.delete(id);
    return id && !existingIds.has(id);
  });
  if (!restored.length) return;
  state.manualWatchReviews = [...state.manualWatchReviews, ...restored];
  state.manualWatchReviewCount = manualWatchReviewDisplayCount(state.manualWatchReviews);
}

function policyLabel(mode) {
  if (mode === "detected") return "detection time";
  if (mode === "release_day") return "release day";
  if (mode === "episode_timing") return "episode timing";
  if (mode === "custom") return "manual date & time";
  return "now";
}

function policyConfirmationPhrase(mode) {
  if (mode === "detected") return "at the time it was detected";
  if (mode === "release_day") return "on the release day";
  if (mode === "episode_timing") return "using episode timing";
  if (mode === "custom") return "using the selected date and time";
  return "now";
}

export function manualWatchReviewConfirmation({ action = "approve", mode = "detected", title = "this item", count = 1, source = "the reporting app" } = {}) {
  const itemCount = Number(count) || 1;
  const subject = itemCount === 1
    ? `“${title}”`
    : `${itemCount} episodes from “${title}”`;
  if (action === "dismiss") {
    // Worded like the media page's "Mark unwatched" dialog (watch-action.js).
    return {
      title: "Mark unwatched",
      body: `Keep ${subject} unwatched and mark ${itemCount === 1 ? "it" : "them"} unplayed on Plex, Emby, and Jellyfin?${itemCount === 1 ? "" : " Episodes not waiting for review are not changed."}`,
      confirmLabel: "Mark unwatched",
      danger: true,
    };
  }
  return {
    title: itemCount === 1 ? "Confirm manual watch decision" : "Confirm manual watch decisions",
    body: `Mark ${subject} watched ${policyConfirmationPhrase(mode)}? This will save the decision and queue it for sync to connected apps.`,
    confirmLabel: itemCount === 1 ? "Confirm watch decision" : "Confirm all decisions",
    danger: false,
  };
}

async function confirmManualWatchReviewAction({ key, action, mode, title, count = 1, source } = {}) {
  const confirmationKey = String(key || `${action}:${mode}:${title}:${count}`);
  if (pendingManualWatchReviewConfirmations.has(confirmationKey)) return false;
  pendingManualWatchReviewConfirmations.add(confirmationKey);
  try {
    return Boolean(await _openConfirmDialog(manualWatchReviewConfirmation({ action, mode, title, count, source })));
  } finally {
    pendingManualWatchReviewConfirmations.delete(confirmationKey);
  }
}

function setReviewBusy(element, busy) {
  if (!element) return;
  element.classList.toggle("is-busy", busy);
  if (busy) element.setAttribute("aria-busy", "true");
  else element.removeAttribute("aria-busy");
}

async function handleReviewAction(id, action, mode, card, watchedAt = "") {
  const buttons = [...(card?.querySelectorAll("button") || [])];
  buttons.forEach((button) => { button.disabled = true; });
  setReviewBusy(card, true);
  const review = currentManualWatchReviews().find((item) => String(item.id) === String(id));
  const optimistic = action === "defer" || !review ? [] : optimisticallyRemoveReviews([review]);
  if (optimistic.length) {
    renderManualWatchReviewPage();
    _cb.setMessage?.(review?.review_kind === "source_mismatch"
      ? "Fix Match issue dismissed. Watch state was not changed."
      : "Decision removed from review; syncing in the background.", "muted");
  }
  try {
    const body = await postReviewAction(id, action, mode, watchedAt);
    if (action !== "defer") {
      completeOptimisticReview(id);
    }
    _cb.setMessage?.(
      action === "dismiss"
        ? review?.review_kind === "source_mismatch"
          ? "Fix Match issue dismissed. No watch state was changed."
          : "Manual watch review dismissed; marked unwatched across connected media apps."
        : action === "defer"
          ? "Manual watch review left pending."
          : `Watch decision saved (${policyLabel(mode)}) and sync queued.`,
      "success",
    );
  } catch (error) {
    if (optimistic.length) {
      restoreOptimisticReviews(optimistic);
      renderManualWatchReviewPage();
    }
    throw attachManualWatchReviewFailure(error, {
      reviews: review ? [review] : [],
      action,
      mode,
      watchedAt,
      scope: "item",
      affectedMedia: review ? reviewTitle(review) : "the selected media",
    });
  } finally {
    setReviewBusy(card, false);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function runScopedReviewBatch(reviews, { action, mode, element, watchedAt = "", optimisticText, scope, affectedMedia, seasonKey = "", sourceApps, failPrefix, successMessage }) {
  const records = Array.isArray(reviews) ? reviews : [];
  if (!records.length) return;
  const buttons = [...(element?.querySelectorAll("button") || [])];
  buttons.forEach((button) => { button.disabled = true; });
  setReviewBusy(element, true);
  let result;
  try {
    result = await runSequentialReviewBatch(records, {
      action,
      mode,
      watchedAt,
      continueOnError: false,
      postAction: postReviewAction,
      onOptimisticRemove: (items) => {
        const removed = optimisticallyRemoveReviews(items);
        if (removed.length) {
          renderManualWatchReviewPage();
          _cb.setMessage?.(optimisticText(removed.length), "muted");
        }
        return removed;
      },
      onItemComplete: completeOptimisticReview,
      onRestoreFailed: (unresolved) => { restoreOptimisticReviews(unresolved); renderManualWatchReviewPage(); },
    });
  } finally {
    setReviewBusy(element, false);
    buttons.forEach((button) => { button.disabled = false; });
  }
  if (result.failed.length) {
    const failure = result.failed[0].error;
    const unresolved = result.unresolved.length ? result.unresolved : records;
    throw wrapManualWatchReviewFailure(`${result.completed} of ${records.length} ${failPrefix}. ${failure.message}`, {
      reviews: unresolved, action, mode, watchedAt, scope,
      ...(seasonKey ? { seasonKey } : {}),
      affectedMedia: typeof affectedMedia === "function" ? affectedMedia(unresolved[0] || records[0]) : affectedMedia,
      ...(sourceApps ? { sourceApps } : {}),
      progress: `${result.completed} of ${records.length} ${failPrefix}.`,
    }, failure);
  }
  _cb.setMessage?.(successMessage, "success");
}

async function handleEpisodeAction(reviews, action, mode, card, watchedAt = "") {
  return runScopedReviewBatch(reviews, {
    action, mode, element: card, watchedAt, scope: "episode", failPrefix: "provider records updated",
    optimisticText: () => "Episode removed from review; syncing in the background.",
    affectedMedia: (item) => (item ? reviewTitle(item) : "the selected episode"),
    successMessage: action === "dismiss" ? "Episode dismissed and marked unwatched across connected media apps." : `Episode watch decision saved (${policyLabel(mode)}); sync queued.`,
  });
}

async function postBulkReviewAction(action, items = []) {
  const response = await fetch("/api/manual-watch-review/bulk", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ action, items }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    const error = new Error(body.error || `Manual watch review bulk ${action} failed with ${response.status}`);
    error.status = response.status;
    error.response = body;
    throw error;
  }
  _cb.clearDerivedUiCaches?.();
  return body;
}

async function handleBulkSelectionAction(reviews, action, mode, watchedAt = "", itemDecisions = null) {
  return executeBulkSelectionAction(reviews, {
    action, mode, watchedAt, itemDecisions, postAction: postReviewAction, postBulkAction: postBulkReviewAction,
    optimisticallyRemove: optimisticallyRemoveReviews, completeOptimistic: completeOptimisticReview,
    restoreOptimistic: restoreOptimisticReviews, onRender: renderManualWatchReviewPage,
    setMessage: _cb.setMessage, policyLabel,
  });
}

export function startManualWatchReviewPolling() {
  if (reviewPollTimer) return;
  reviewPollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden" || !state.token) return;
    loadManualWatchReview({ summaryOnly: true }).catch(() => null);
  }, 30_000);
}

export function stopManualWatchReviewPolling() {
  if (reviewPollTimer) window.clearInterval(reviewPollTimer);
  reviewPollTimer = null;
}
