import { buildAuthHeaders } from "./auth.js?v=2.2.1.0.2";
import { state, elements } from "./state.js?v=2.2.1.0.2";
import { escapeAttribute, escapeHtml, formatTmdbDate, episodeCode } from "./utils.js?v=2.2.1.0.2";
import { hydratePosters } from "./images.js?v=2.2.1.0.2";
import { normalizeMediaCardRecord, renderMediaCard } from "./media-card.js?v=2.2.1.0.2";
import { hydratePersonalMetadata, personalMetadataItems, propagatePersonalMetadata } from "./personal-media-metadata.js?v=2.2.1.0.2";
import { bindPlaylistDragAndDrop, handlePlaylistClick, initPlaylists, openAddToListDialog, openCreateListDialog, openImportPlaylistsDialog, openShowEpisodePicker, recentlyDeletedButtonHtml, renderPlaylists, watchUncheckedPlaylistRules } from "./playlists.js?v=2.2.1.0.2";

export { openAddToListDialog, openCreateListDialog };

const PERSONAL_MEDIA_TTL_MS = 2 * 60 * 1000;
const PERSONAL_MEDIA_TIMEOUT_MS = 15000;
const PERSONAL_LIST_WHEEL_ARM_DELAY_MS = 240;
const PERSONAL_RATING_SECTIONS = [
  { type: "movie", label: "Movies" },
  { type: "tv", label: "TV Shows" },
  { type: "episode", label: "Episodes" },
];

let _cb = {};
let panelBound = false;
let loadPromise = null;
let dialogCleanup = null;
let personalSyncBusy = "";

function normalizeType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["tv", "show", "series"].includes(type)) return "tv";
  if (type === "episode") return "episode";
  return "movie";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function titleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function episodeRatingMatches(left = {}, right = {}) {
  if (normalizeType(left.media_type || left.mediaType || left.type) !== "episode"
    || normalizeType(right.media_type || right.mediaType || right.type) !== "episode") return false;
  const leftSeason = numberOrNull(left.season ?? left.seasonNumber);
  const rightSeason = numberOrNull(right.season ?? right.seasonNumber);
  const leftEpisode = numberOrNull(left.episode ?? left.episodeNumber);
  const rightEpisode = numberOrNull(right.episode ?? right.episodeNumber);
  if (leftSeason == null || rightSeason == null || leftSeason !== rightSeason
    || leftEpisode == null || rightEpisode == null || leftEpisode !== rightEpisode) return false;

  const leftShowTitle = titleKey(left.show_title || left.showTitle || left.series_title || left.seriesTitle);
  const rightShowTitle = titleKey(right.show_title || right.showTitle || right.series_title || right.seriesTitle);
  // Provider ids are not enough to compare episode ratings: one side may have
  // an episode-level id and the other a series-level id. The show title plus
  // season/episode coordinates is the stable identity shared by both routes.
  return Boolean(leftShowTitle && rightShowTitle && leftShowTitle === rightShowTitle);
}

function episodeRatingQuality(item = {}) {
  let score = 0;
  if (item.show_tmdb_id || item.show_tvdb_id || item.show_imdb_id) score += 10;
  if (item.overview) score += 4;
  if (item.release_date) score += 2;
  if (item.poster_url) score += 1;
  return score;
}

function collapsePersonalRatings(items = []) {
  const collapsed = [];
  for (const item of items) {
    const matchIndex = normalizeType(item.media_type) === "episode"
      ? collapsed.findIndex((existing) => episodeRatingMatches(existing, item))
      : -1;
    if (matchIndex < 0) {
      collapsed.push(item);
      continue;
    }
    const existing = collapsed[matchIndex];
    const winner = episodeRatingQuality(item) > episodeRatingQuality(existing) ? item : existing;
    const latest = Number(item.updated_at || 0) >= Number(existing.updated_at || 0) ? item : existing;
    collapsed[matchIndex] = {
      ...winner,
      rating: latest.rating,
      created_at: Math.min(Number(item.created_at || 0), Number(existing.created_at || 0)),
      updated_at: Math.max(Number(item.updated_at || 0), Number(existing.updated_at || 0)),
    };
  }
  return collapsed;
}

export function mediaKeyForPersonalItem(item = {}) {
  const type = normalizeType(item.media_type || item.mediaType || item.type);
  const tmdbId = String(item.tmdb_id || item.tmdbId || "").trim();
  const tvdbId = String(item.tvdb_id || item.tvdbId || "").trim();
  const imdbId = String(item.imdb_id || item.imdbId || "").trim();
  if (type === "episode") {
    const showTitle = String(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.title || item.name || "").trim();
    const season = numberOrNull(item.season ?? item.seasonNumber);
    const episode = numberOrNull(item.episode ?? item.episodeNumber);
    const coordinate = `s${Number.isInteger(season) ? season : "?"}e${Number.isInteger(episode) ? episode : "?"}`;
    const showTmdbId = String(item.show_tmdb_id || item.showTmdbId || "").trim();
    const showTvdbId = String(item.show_tvdb_id || item.showTvdbId || "").trim();
    const showImdbId = String(item.show_imdb_id || item.showImdbId || "").trim();
    if (showTmdbId) return `episode:tmdb:${showTmdbId}:${coordinate}`;
    if (showTvdbId) return `episode:tvdb:${showTvdbId}:${coordinate}`;
    if (showImdbId) return `episode:imdb:${showImdbId}:${coordinate}`;
    return `episode:title:${titleKey(showTitle)}:${coordinate}`;
  }
  if (tmdbId) return `${type}:tmdb:${tmdbId}`;
  if (tvdbId) return `${type}:tvdb:${tvdbId}`;
  if (imdbId) return `${type}:imdb:${imdbId}`;
  return `${type}:title:${titleKey(item.title || item.name)}`;
}

function normalizeItem(item = {}) {
  const type = normalizeType(item.media_type || item.mediaType || item.type);
  const explicitShowTmdbId = item.show_tmdb_id || item.showTmdbId || "";
  const explicitShowTvdbId = item.show_tvdb_id || item.showTvdbId || "";
  const explicitShowImdbId = item.show_imdb_id || item.showImdbId || "";
  const normalized = {
    ...item,
    id: item.id || item.media_key || "",
    media_type: type,
    title: item.title || item.episode_title || item.episodeTitle || item.name || "Untitled",
    tmdb_id: type === "episode" ? explicitShowTmdbId : (item.tmdb_id || item.tmdbId || ""),
    tvdb_id: type === "episode" ? explicitShowTvdbId : (item.tvdb_id || item.tvdbId || ""),
    imdb_id: type === "episode" ? explicitShowImdbId : (item.imdb_id || item.imdbId || ""),
    poster_url: item.poster_url || item.posterUrl || item.imageUrl || "",
    show_poster_url: item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "",
    overview: item.overview || item.description || "",
    release_date: item.release_date || item.releaseDate || item.first_air_date || "",
    show_title: item.show_title || item.showTitle || item.series_title || item.seriesTitle || "",
    show_tmdb_id: explicitShowTmdbId,
    show_tvdb_id: explicitShowTvdbId,
    show_imdb_id: explicitShowImdbId,
    episode_tmdb_id: item.episode_tmdb_id || item.episodeTmdbId || "",
    episode_tvdb_id: item.episode_tvdb_id || item.episodeTvdbId || "",
    episode_imdb_id: item.episode_imdb_id || item.episodeImdbId || "",
    season: item.season ?? item.seasonNumber ?? null,
    episode: item.episode ?? item.episodeNumber ?? null,
  };
  normalized.media_key = item.media_key || mediaKeyForPersonalItem(normalized);
  return normalized;
}

export function personalItemFromPosterMenuDataset(dataset = {}) {
  const value = (...keys) => keys.map((key) => dataset[key]).find((entry) => entry !== undefined && entry !== null && entry !== "") || "";
  const rawType = value("posterMenuRatingMediaType", "mediaRateMediaType", "posterMenuMediaType", "posterMenuUpNextMediaType") || "movie";
  const isEpisode = normalizeType(rawType) === "episode"
    || value("posterMenuKind") === "episode"
    || normalizeType(value("posterMenuUpNextMediaType")) === "episode";
  const showTitle = value(
    "posterMenuRatingShowTitle",
    "mediaRateShowTitle",
    "posterMenuShowTitle",
    "posterMenuUpNextShowTitle",
  );
  const tmdbId = value(
    "posterMenuRatingTmdbId",
    "mediaRateTmdbId",
    "posterMenuUpNextTmdbId",
  );
  const tvdbId = value(
    "posterMenuRatingTvdbId",
    "mediaRateTvdbId",
    "posterMenuUpNextTvdbId",
  );
  const showTmdbId = value(
    "posterMenuRatingShowTmdbId",
    "mediaRateShowTmdbId",
    "posterMenuUpNextTmdbId",
  );
  const showTvdbId = value(
    "posterMenuRatingShowTvdbId",
    "mediaRateShowTvdbId",
    "posterMenuUpNextTvdbId",
  );
  const showImdbId = value(
    "posterMenuRatingShowImdbId",
    "mediaRateShowImdbId",
  );
  const episodeTmdbId = value(
    "posterMenuRatingEpisodeTmdbId",
    "mediaRateEpisodeTmdbId",
    "posterMenuUpNextEpisodeTmdbId",
  );
  const episodeTvdbId = value(
    "posterMenuRatingEpisodeTvdbId",
    "mediaRateEpisodeTvdbId",
    "posterMenuUpNextEpisodeTvdbId",
  );
  const episodeImdbId = value(
    "posterMenuRatingEpisodeImdbId",
    "mediaRateEpisodeImdbId",
    "posterMenuUpNextEpisodeImdbId",
  );
  const title = value(
    "posterMenuRatingTitle",
    "mediaRateTitle",
    "posterMenuDiscoverTitle",
    "posterMenuTitle",
  ) || "Untitled";
  return normalizeItem({
    media_key: value("posterMenuPersonalKey"),
    media_type: isEpisode ? "tv" : normalizeType(rawType),
    title: isEpisode ? (showTitle || title) : title,
    tmdb_id: isEpisode ? showTmdbId : tmdbId,
    tvdb_id: isEpisode ? showTvdbId : tvdbId,
    imdb_id: isEpisode ? showImdbId : value("posterMenuRatingImdbId", "mediaRateImdbId", "posterMenuDiscoverImdbId"),
    poster_url: value("posterMenuRatingPosterUrl", "mediaRatePosterUrl", "posterMenuUpNextPosterUrl", "posterMenuDiscoverPosterUrl"),
    overview: value("posterMenuRatingOverview", "mediaRateOverview"),
    release_date: value("posterMenuRatingReleaseDate", "mediaRateReleaseDate", "posterMenuUpNextAirDate", "posterMenuDiscoverReleaseDate"),
    show_title: isEpisode ? showTitle : "",
    show_tmdb_id: isEpisode ? showTmdbId : "",
    show_tvdb_id: isEpisode ? showTvdbId : "",
    show_imdb_id: isEpisode ? showImdbId : "",
    episode_tmdb_id: isEpisode ? episodeTmdbId : "",
    episode_tvdb_id: isEpisode ? episodeTvdbId : "",
    episode_imdb_id: isEpisode ? episodeImdbId : "",
    season: isEpisode ? value("posterMenuRatingSeason", "mediaRateSeason", "posterMenuUpNextSeason") : null,
    episode: isEpisode ? value("posterMenuRatingEpisode", "mediaRateEpisode", "posterMenuUpNextEpisode") : null,
  });
}

export function personalItemFromDetailDataset(dataset = {}) {
  const value = (...keys) => keys
    .map((key) => dataset[key])
    .find((entry) => entry !== undefined && entry !== null && entry !== "") || "";
  return normalizeItem({
    media_type: value("mediaPersonalMediaType") || "movie",
    title: value("mediaPersonalTitle") || "Untitled",
    tmdb_id: value("mediaPersonalTmdbId"),
    tvdb_id: value("mediaPersonalTvdbId"),
    imdb_id: value("mediaPersonalImdbId"),
    poster_url: value("mediaPersonalPosterUrl"),
    overview: value("mediaPersonalOverview"),
    release_date: value("mediaPersonalReleaseDate"),
    show_title: value("mediaPersonalShowTitle"),
    show_tmdb_id: value("mediaPersonalShowTmdbId"),
    show_tvdb_id: value("mediaPersonalShowTvdbId"),
    show_imdb_id: value("mediaPersonalShowImdbId"),
    episode_tmdb_id: value("mediaPersonalEpisodeTmdbId"),
    episode_tvdb_id: value("mediaPersonalEpisodeTvdbId"),
    episode_imdb_id: value("mediaPersonalEpisodeImdbId"),
    season: value("mediaPersonalSeason"),
    episode: value("mediaPersonalEpisode"),
  });
}

function itemPayload(item = {}) {
  const normalized = normalizeItem(item);
  return {
    media_type: normalized.media_type,
    title: normalized.title,
    tmdb_id: normalized.tmdb_id,
    tvdb_id: normalized.tvdb_id,
    imdb_id: normalized.imdb_id,
    poster_url: normalized.poster_url,
    overview: normalized.overview,
    release_date: normalized.release_date,
    show_title: normalized.show_title,
    show_tmdb_id: normalized.show_tmdb_id,
    show_tvdb_id: normalized.show_tvdb_id,
    show_imdb_id: normalized.show_imdb_id,
    episode_tmdb_id: normalized.episode_tmdb_id,
    episode_tvdb_id: normalized.episode_tvdb_id,
    episode_imdb_id: normalized.episode_imdb_id,
    season: normalized.season == null || normalized.season === "" ? null : Number(normalized.season),
    episode: normalized.episode == null || normalized.episode === "" ? null : Number(normalized.episode),
  };
}

function allPersonalItems() {
  const items = [
    ...(state.personalRatings || []),
    ...(state.personalWatchlist || []),
  ];
  for (const list of state.personalLists || []) items.push(...(list.items || []));
  return items;
}

function findPersonalItem(mediaKey) {
  const key = String(mediaKey || "");
  return allPersonalItems().find((item) => String(item.media_key || mediaKeyForPersonalItem(item)) === key) || null;
}

const PERSONAL_PROVIDER_FIELDS = ["tmdb_id", "tvdb_id", "imdb_id"];

function personalItemsMatch(left = {}, right = {}) {
  const first = normalizeItem(left);
  const second = normalizeItem(right);
  if (first.media_type !== second.media_type) return false;
  if (first.media_type === "episode") return episodeRatingMatches(first, second);

  const sharedProviderId = PERSONAL_PROVIDER_FIELDS.some((field) => {
    const firstId = String(first[field] || "").trim();
    const secondId = String(second[field] || "").trim();
    return Boolean(firstId && secondId && firstId === secondId);
  });
  if (sharedProviderId) return true;

  const firstTitle = titleKey(first.title);
  const secondTitle = titleKey(second.title);
  if (!firstTitle || firstTitle !== secondTitle) return false;
  const firstYear = String(first.release_date || "").match(/^\d{4}/)?.[0] || "";
  const secondYear = String(second.release_date || "").match(/^\d{4}/)?.[0] || "";
  return !firstYear || !secondYear || Math.abs(Number(firstYear) - Number(secondYear)) <= 1;
}

export function isPersonalWatchlisted(item = {}) {
  return (state.personalWatchlist || []).some((entry) => personalItemsMatch(entry, item));
}

export function customListsForPersonalItem(item = {}) {
  return (state.personalLists || []).filter((list) => (list.items || []).some((entry) => personalItemsMatch(entry, item)));
}

export function getPersonalRating(item = {}) {
  const key = mediaKeyForPersonalItem(item);
  const ratings = state.personalRatings || [];
  const match = ratings.find((entry) => String(entry.media_key || mediaKeyForPersonalItem(entry)) === key)
    || ratings.find((entry) => episodeRatingMatches(entry, item));
  const rating = Number(match?.rating || 0);
  return Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : 0;
}

function personalRatingDataAttributes(item = {}) {
  const normalized = normalizeItem(item);
  const attributes = {
    "data-media-rate-media-type": normalized.media_type,
    "data-media-rate-tmdb-id": normalized.tmdb_id,
    "data-media-rate-tvdb-id": normalized.tvdb_id,
    "data-media-rate-imdb-id": normalized.imdb_id,
    "data-media-rate-show-tmdb-id": normalized.show_tmdb_id,
    "data-media-rate-show-tvdb-id": normalized.show_tvdb_id,
    "data-media-rate-show-imdb-id": normalized.show_imdb_id,
    "data-media-rate-episode-tmdb-id": normalized.episode_tmdb_id,
    "data-media-rate-episode-tvdb-id": normalized.episode_tvdb_id,
    "data-media-rate-episode-imdb-id": normalized.episode_imdb_id,
    "data-media-rate-title": normalized.title,
    "data-media-rate-show-title": normalized.show_title,
    "data-media-rate-season": normalized.season == null ? "" : normalized.season,
    "data-media-rate-episode": normalized.episode == null ? "" : normalized.episode,
    "data-media-rate-poster-url": normalized.poster_url,
    "data-media-rate-overview": normalized.overview,
    "data-media-rate-release-date": normalized.release_date,
  };
  return ["data-media-rate", ...Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttribute(value ?? "")}"`)]
    .join(" ");
}

function personalMediaDataAttributes(item = {}) {
  const normalized = normalizeItem(item);
  const attributes = {
    "data-media-personal-media-type": normalized.media_type,
    "data-media-personal-tmdb-id": normalized.tmdb_id,
    "data-media-personal-tvdb-id": normalized.tvdb_id,
    "data-media-personal-imdb-id": normalized.imdb_id,
    "data-media-personal-show-tmdb-id": normalized.show_tmdb_id,
    "data-media-personal-show-tvdb-id": normalized.show_tvdb_id,
    "data-media-personal-show-imdb-id": normalized.show_imdb_id,
    "data-media-personal-episode-tmdb-id": normalized.episode_tmdb_id,
    "data-media-personal-episode-tvdb-id": normalized.episode_tvdb_id,
    "data-media-personal-episode-imdb-id": normalized.episode_imdb_id,
    "data-media-personal-title": normalized.title,
    "data-media-personal-show-title": normalized.show_title,
    "data-media-personal-season": normalized.season == null ? "" : normalized.season,
    "data-media-personal-episode": normalized.episode == null ? "" : normalized.episode,
    "data-media-personal-poster-url": normalized.poster_url,
    "data-media-personal-overview": normalized.overview,
    "data-media-personal-release-date": normalized.release_date,
  };
  return Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttribute(value ?? "")}"`)
    .join(" ");
}

const personalWatchlistIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M2.5 1.5A1.5 1.5 0 0 1 4 0h8a1.5 1.5 0 0 1 1.5 1.5v13a.5.5 0 0 1-.8.4L8 11.75l-4.7 3.15a.5.5 0 0 1-.8-.4v-13zM4 1a.5.5 0 0 0-.5.5v11.07l4.22-2.83a.5.5 0 0 1 .56 0l4.22 2.83V1.5A.5.5 0 0 0 12 1H4z"/></svg>`;
const personalCustomListIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M2 1.5A1.5 1.5 0 0 1 3.5 0h9A1.5 1.5 0 0 1 14 1.5v13a.5.5 0 0 1-.8.4L8 11.75l-5.2 3.15a.5.5 0 0 1-.8-.4v-13zM3.5 1a.5.5 0 0 0-.5.5v11.07l4.74-2.87a.5.5 0 0 1 .52 0L13 12.57V1.5a.5.5 0 0 0-.5-.5h-9zM5 3h6v1H5V3zm0 2h6v1H5V5z"/></svg>`;

function personalWatchlistActionState(item) {
  const watchlisted = isPersonalWatchlisted(item);
  return {
    active: watchlisted,
    label: watchlisted ? "Remove from watch list" : "Add to watch list",
    description: watchlisted ? `Remove ${item.title} from your watch list` : `Add ${item.title} to your watch list`,
    mode: watchlisted ? "remove" : "add",
  };
}

function personalCustomListActionState(item) {
  const lists = customListsForPersonalItem(item);
  const names = lists.map((list) => list.name).filter(Boolean);
  return {
    active: names.length > 0,
    label: names.length ? "In playlist" : "Add to playlist",
    description: names.length
      ? `In playlist${names.length > 1 ? "s" : ""}: ${names.join(", ")}`
      : `Add ${item.title} to a playlist`,
    mode: names.length ? "manage" : "add",
  };
}

export function personalMediaActionsHtml(item = {}) {
  ensurePersonalMediaLoaded();
  const normalized = normalizeItem(item);
  const attributes = personalMediaDataAttributes(normalized);
  const watchlist = personalWatchlistActionState(normalized);
  const customList = personalCustomListActionState(normalized);
  return `
    <button class="action-pill personal-media-detail-action${watchlist.active ? " has-personal-state" : ""}" type="button" ${attributes} data-media-personal-action="watchlist" data-media-personal-mode="${watchlist.mode}" aria-label="${escapeAttribute(watchlist.description)}" aria-pressed="${watchlist.active}" title="${escapeAttribute(watchlist.description)}">
      ${personalWatchlistIcon}
      <span data-media-personal-label>${escapeHtml(watchlist.label)}</span>
    </button>
    <button class="action-pill personal-media-detail-action${customList.active ? " has-personal-state" : ""}" type="button" ${attributes} data-media-personal-action="custom-list" data-media-personal-mode="${customList.mode}" aria-label="${escapeAttribute(customList.description)}" title="${escapeAttribute(customList.description)}">
      ${personalCustomListIcon}
      <span data-media-personal-label>${escapeHtml(customList.label)}</span>
    </button>
  `;
}

export function refreshRenderedPersonalMediaControls() {
  for (const button of document.querySelectorAll("#mediaDetailActions [data-media-personal-action]")) {
    const item = personalItemFromDetailDataset(button.dataset);
    const action = button.dataset.mediaPersonalAction || "";
    const actionState = action === "watchlist"
      ? personalWatchlistActionState(item)
      : action === "custom-list"
        ? personalCustomListActionState(item)
        : null;
    if (!actionState) continue;
    button.classList.toggle("has-personal-state", actionState.active);
    button.dataset.mediaPersonalMode = actionState.mode;
    button.setAttribute("aria-label", actionState.description);
    button.setAttribute("title", actionState.description);
    if (action === "watchlist") button.setAttribute("aria-pressed", String(actionState.active));
    const label = button.querySelector("[data-media-personal-label]");
    if (label) label.textContent = actionState.label;
  }
}

// personalRatings/personalWatchlist/personalLists are only ever fetched by
// loadPersonalMedia(), and until this session-scoped fix that was only called
// when the Watchlist/Ratings/Playlists/Discover route itself was active.
// A movie/show/episode detail page opened directly - a deep link, a search
// result, a bookmark, a fresh tab - never triggered it, so the personal
// rating pill and the watchlist/list buttons silently rendered as "not yet
// rated"/"not on your list" even when the item already was, on the first
// paint of every session until one of those other routes happened to load
// it. Verified against a real rating during the personal-rating-sync manual
// provider matrix, 22 September 2026. Firing a background, deduped,
// TTL-respecting load from here - the same load every one of those routes
// already uses - self-heals every rendered pill/button in place via
// loadPersonalMedia()'s own refreshPersonalViews() call, regardless of which
// page happened to render first.
function ensurePersonalMediaLoaded() {
  if (state.personalMediaLoadedAt || state.personalMediaLoading) return;
  loadPersonalMedia().catch(() => { });
}

export function personalRatingPillHtml(item = {}) {
  ensurePersonalMediaLoaded();
  const normalized = normalizeItem(item);
  const rating = getPersonalRating(normalized);
  const label = rating ? `Your rating · ${rating}/10` : "Rate this";
  const actionLabel = rating ? `Change your rating for ${normalized.title}` : `Rate ${normalized.title}`;
  return `<button class="rating-pill rating-pill--personal${rating ? " has-rating" : ""}" type="button" ${personalRatingDataAttributes(normalized)} aria-label="${escapeAttribute(actionLabel)}" title="${escapeAttribute(actionLabel)}"><span class="personal-rating-star" aria-hidden="true">★</span><span>${escapeHtml(label)}</span></button>`;
}

export function personalEpisodeRatingButtonHtml(item = {}) {
  ensurePersonalMediaLoaded();
  const normalized = normalizeItem(item);
  const rating = getPersonalRating(normalized);
  const code = episodeCode(normalized.season, normalized.episode);
  const label = rating ? `${rating}/10` : "Rate";
  const actionLabel = rating ? `Change your rating for ${code} ${normalized.title}` : `Rate ${code} ${normalized.title}`;
  return `<button class="episode-personal-rating${rating ? " has-rating" : ""}" type="button" ${personalRatingDataAttributes(normalized)} aria-label="${escapeAttribute(actionLabel)}" title="${escapeAttribute(actionLabel)}"><span class="personal-rating-star" aria-hidden="true">★</span><span>${escapeHtml(label)}</span></button>`;
}

function refreshRenderedPersonalRatingControls() {
  for (const button of document.querySelectorAll(".rating-pill--personal[data-media-rate], .episode-personal-rating[data-media-rate]")) {
    const item = {
      media_type: button.dataset.mediaRateMediaType || "movie",
      tmdb_id: button.dataset.mediaRateTmdbId || "",
      tvdb_id: button.dataset.mediaRateTvdbId || "",
      imdb_id: button.dataset.mediaRateImdbId || "",
      show_tmdb_id: button.dataset.mediaRateShowTmdbId || "",
      show_tvdb_id: button.dataset.mediaRateShowTvdbId || "",
      show_imdb_id: button.dataset.mediaRateShowImdbId || "",
      episode_tmdb_id: button.dataset.mediaRateEpisodeTmdbId || "",
      episode_tvdb_id: button.dataset.mediaRateEpisodeTvdbId || "",
      episode_imdb_id: button.dataset.mediaRateEpisodeImdbId || "",
      title: button.dataset.mediaRateTitle || "Untitled",
      show_title: button.dataset.mediaRateShowTitle || "",
      season: button.dataset.mediaRateSeason || "",
      episode: button.dataset.mediaRateEpisode || "",
      poster_url: button.dataset.mediaRatePosterUrl || "",
      overview: button.dataset.mediaRateOverview || "",
      release_date: button.dataset.mediaRateReleaseDate || "",
    };
    button.outerHTML = button.classList.contains("episode-personal-rating")
      ? personalEpisodeRatingButtonHtml(item)
      : personalRatingPillHtml(item);
  }
}

function setPersonalMessage(message, tone = "success") {
  _cb.setMessage?.(message, tone);
}

async function personalRequest(payload) {
  const response = await fetch("/api/personal-media", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(state.token) },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error || `Personal media update failed (${response.status})`), { status: response.status, code: body.code || "" });
  }
  return body;
}

function personalErrorPresentation() {
  if (/(^|\s)not found($|\s)/i.test(state.personalMediaError)) {
    return "The personal media tables are not available yet. Restart Plekt, then try again.";
  }
  return state.personalMediaError || "Try again later.";
}

function personalCard(item, { section = "watchlist", rating = null, listId = "", removable = true, hideOverview = false, actionsHtml = "", noteHtml = "", posterBadgeHtml = "", attributesHtml = "" } = {}) {
  const normalized = normalizeItem(item);
  const sharedMetadata = personalMetadataItems().find((entry) => (
    String(entry.media_key || mediaKeyForPersonalItem(entry)) === String(normalized.media_key)
      && (entry.overview || entry.release_date)
  )) || {};
  // Playlist cards leave the summary out (the card itself still links to the full page).
  const overview = hideOverview ? "" : normalized.overview || sharedMetadata.overview || "Summary unavailable.";
  const releaseValue = normalized.release_date || sharedMetadata.release_date || "";
  const episodeMeta = normalized.media_type === "episode"
    ? `${episodeCode(normalized.season, normalized.episode)} · ${normalized.title}`
    : "";
  const record = normalizeMediaCardRecord(normalized, {
    meta: episodeMeta,
    description: overview,
  });
  const key = normalized.media_key;
  const releaseDate = releaseValue ? formatTmdbDate(releaseValue) : "Release date unavailable";
  const ratingLabel = rating ? `★${rating}/10` : "Rate";
  const ratingActionHtml = `<button class="shared-media-card-rating shared-media-card-rating--action" type="button" data-personal-action="rate" data-personal-key="${escapeAttribute(key)}" aria-label="${escapeAttribute(rating ? `Change your rating for ${normalized.title}` : `Rate ${normalized.title}`)}" title="${escapeAttribute(rating ? "Change rating" : "Rate this title")}">${ratingLabel}</button>`;
  const personalMenuAction = !removable ? "" : section === "ratings"
    ? "remove-rating"
    : section === "list"
      ? `remove-list:${listId}`
      : "remove-watchlist";
  const personalRemoveLabel = section === "ratings"
    ? "Remove rating"
    : section === "list"
      ? "Remove from this playlist"
      : "Remove from watchlist";
  return renderMediaCard({
    ...record,
    media_key: key,
  }, {
    variant: "personal",
    menuMode: "personal",
    personalKey: key,
    personalMenuAction,
    personalRemoveLabel,
    meta: record.meta,
    releaseDate,
    ratingActionHtml,
    showSource: false,
    description: overview,
    actionsHtml,
    noteHtml,
    posterBadgeHtml,
    attributesHtml,
  });
}

function emptyPersonalState(title, detail) {
  return `<div class="empty-log personal-media-empty"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`;
}

function refreshPersonalMetadata() {
  hydratePersonalMetadata({ normalizeItem })
    .then((changed) => {
      if (changed || propagatePersonalMetadata(mediaKeyForPersonalItem)) refreshPersonalViews();
    })
    .catch(() => { });
}

function renderPersonalRatingSections(ratings) {
  const canonicalRatings = collapsePersonalRatings(ratings);
  return PERSONAL_RATING_SECTIONS.map(({ type, label }) => {
    const items = canonicalRatings.filter((item) => normalizeType(item.media_type) === type);
    if (!items.length) return "";

    const headingId = `personal-ratings-${type}-title`;
    return `
      <section class="personal-media-rating-section" aria-labelledby="${headingId}">
        <div class="personal-media-list-heading">
          <b id="${headingId}">${escapeHtml(label)}</b>
          <span>${items.length} item${items.length === 1 ? "" : "s"}</span>
        </div>
        <div class="personal-media-card-grid">
          ${items.map((item) => personalCard(item, { section: "ratings", rating: item.rating })).join("")}
        </div>
      </section>
    `;
  }).join("");
}

function renderPersonalControls() {
  let compactCards = false;
  try { compactCards = localStorage.getItem("plembfin:card-mode:personal") === "1"; } catch { /* storage unavailable */ }
  const createListSource = state.personalMediaTab === "lists" ? "playlists" : "";
  const syncType = state.personalMediaTab === "ratings"
    ? "ratings"
    : state.personalMediaTab === "watchlist"
      ? "watchlist"
      : "";
  const syncLabel = syncType === "ratings" ? "personal ratings" : "personal watchlist";
  const syncButtonId = syncType === "ratings" ? "personalRatingSyncNow" : "personalWatchlistSyncNow";
  const syncBusy = personalSyncBusy === syncType;
  const action = syncType
    ? `<button id="${syncButtonId}" class="action-pill page-action-pill personal-media-sync-button" type="button" data-personal-sync="${syncType}" aria-label="Sync ${syncLabel} now" title="Run a full ${syncLabel} sync now"${syncBusy ? ' disabled aria-busy="true"' : ""}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M13.7 3.3A6.9 6.9 0 0 0 8 1a7 7 0 1 0 6.7 9h-1.6A5.5 5.5 0 1 1 8 2.5c1.3 0 2.5.45 3.45 1.2L9.5 5.65H15V.2l-1.3 1.3z"/></svg>
        <span>${syncBusy ? "Syncing…" : "Sync now"}</span>
      </button>`
    : createListSource
      ? `<button class="action-pill page-action-pill personal-media-create-list-button" type="button" data-personal-create-list="${createListSource}" title="Create a playlist">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1.5a.75.75 0 0 1 .75.75v5h5a.75.75 0 0 1 0 1h-5v5a.75.75 0 0 1-1.5 0v-5h-5a.75.75 0 0 1 0-1h5v-5A.75.75 0 0 1 8 1.5z"/></svg>
          <span>New playlist</span>
        </button>
        <button class="action-pill page-action-pill personal-media-import-lists-button" type="button" data-personal-import-lists title="Import playlists you made in Plex, Emby, or Jellyfin">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1.5a.75.75 0 0 1 .75.75v6.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5zM2.75 12a.75.75 0 0 1 .75.75v.75h9v-.75a.75.75 0 0 1 1.5 0v1.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75z"/></svg>
          <span>Import from apps</span>
        </button>
        ${recentlyDeletedButtonHtml()}`
      : "";
  return `
    <div class="page-action-bar personal-media-toolbar-actions">
      <div class="page-action-primary" role="toolbar" aria-label="Personal media actions">
        <button class="icon-button dashboard-compact-toggle page-card-mode-toggle" type="button" data-card-mode-toggle="personal" aria-pressed="${compactCards}" aria-label="Show personal media as posters only" title="${compactCards ? "Show full cards" : "Posters only"}">
          <svg class="dashboard-compact-icon-card" viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="3" width="21" height="18" rx="2"/><rect x="4" y="5.5" width="8" height="13" rx="1" fill="currentColor" stroke="none"/><path d="M14.5 8h5.5M14.5 12h5.5M14.5 16h4"/></svg>
          <svg class="dashboard-compact-icon-posters" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="1" width="16" height="22" rx="2"/><circle cx="9" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><path d="m6.5 17 3-4 2.5 2.25 3-3.75 2.5 5.5Z" fill="currentColor" stroke="none"/><path d="M6.5 19.5h11"/></svg>
        </button>
          <div class="mobile-card-mode-options" role="radiogroup" aria-label="Personal media card display">
            <label class="mobile-card-mode-option">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="3" width="21" height="18" rx="2"/><rect x="4" y="5.5" width="8" height="13" rx="1" fill="currentColor" stroke="none"/><path d="M14.5 8h5.5M14.5 12h5.5M14.5 16h4"/></svg>
              <span>Card view</span>
              <input type="radio" name="personalCardDisplay" value="full" data-card-mode-select="personal" data-card-mode="full"${compactCards ? "" : " checked"} />
            </label>
            <label class="mobile-card-mode-option">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="1" width="16" height="22" rx="2"/><circle cx="9" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><path d="m6.5 17 3-4 2.5 2.25 3-3.75 2.5 5.5Z" fill="currentColor" stroke="none"/><path d="M6.5 19.5h11"/></svg>
              <span>Poster view</span>
              <input type="radio" name="personalCardDisplay" value="posters" data-card-mode-select="personal" data-card-mode="posters"${compactCards ? " checked" : ""} />
            </label>
          </div>
        ${action}
      </div>
    </div>
  `;
}

function bindPersonalListWheelBehavior(panel) {
  for (const rail of panel.querySelectorAll("[data-personal-list-rail]")) {
    let pointerStationary = false;
    let stationaryTimer = 0;
    const clearStationary = () => {
      pointerStationary = false;
      window.clearTimeout(stationaryTimer);
      stationaryTimer = 0;
    };
    const armStationary = () => {
      pointerStationary = false;
      window.clearTimeout(stationaryTimer);
      stationaryTimer = window.setTimeout(() => {
        pointerStationary = true;
      }, PERSONAL_LIST_WHEEL_ARM_DELAY_MS);
    };

    rail.addEventListener("pointerenter", armStationary);
    rail.addEventListener("pointermove", armStationary);
    rail.addEventListener("pointerleave", clearStationary);
    rail.addEventListener("pointercancel", clearStationary);
    rail.addEventListener("wheel", (event) => {
      if (!pointerStationary || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * rail.clientWidth
          : event.deltaY;
      const maxScrollLeft = rail.scrollWidth - rail.clientWidth;
      if (!delta || maxScrollLeft <= 0) return;
      const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, rail.scrollLeft + delta));
      if (nextScrollLeft === rail.scrollLeft) return;
      event.preventDefault();
      rail.scrollLeft = nextScrollLeft;
    }, { passive: false });
  }
}

export function renderPersonalMedia() {
  const panel = elements.personalMediaPanel;
  if (!panel) return;
  if (elements.personalMediaTopbarControls) {
    elements.personalMediaTopbarControls.innerHTML = state.token ? renderPersonalControls() : "";
  }
  elements.personalMediaPanel?.closest('[data-view-panel="personal-media"]')?.classList.toggle("page-card-mode-compact", (() => {
    try { return localStorage.getItem("plembfin:card-mode:personal") === "1"; } catch { return false; }
  })());
  if (!state.token) {
    panel.innerHTML = "";
    return;
  }
  if (state.personalMediaLoading && !state.personalMediaLoadedAt) {
    panel.innerHTML = emptyPersonalState("Loading your personal media…", "");
    return;
  }
  if (state.personalMediaError && !state.personalMediaLoadedAt) {
    panel.innerHTML = `<div class="empty-log personal-media-empty" role="alert"><b>Personal media is unavailable</b><span>${escapeHtml(personalErrorPresentation())}</span><button class="button-ghost" type="button" data-personal-retry>Try again</button></div>`;
    return;
  }

  const tab = state.personalMediaTab;
  let content = "";
  if (tab === "ratings") {
    const ratings = state.personalRatings || [];
    content = ratings.length
      ? renderPersonalRatingSections(ratings)
      : emptyPersonalState("No ratings yet", "Use any media card's actions to keep your own score.");
  } else if (tab === "lists") {
    content = renderPlaylists(Array.isArray(state.personalLists) ? state.personalLists : []);
  } else {
    const watchlist = state.personalWatchlist || [];
    content = watchlist.length
      ? `<div class="personal-media-card-grid">${watchlist.map((item) => personalCard(item)).join("")}</div>`
      : emptyPersonalState("Your watchlist is empty", "Use a media card's menu to save something for later.");
  }
  panel.innerHTML = content;
  bindPersonalListWheelBehavior(panel);
  bindPlaylistDragAndDrop(panel);
  if (tab === "lists") watchUncheckedPlaylistRules(panel);
  hydratePosters(panel);
}

async function runPersonalSync(type) {
  if (personalSyncBusy || !["ratings", "watchlist"].includes(type)) return;
  const syncPersonalMedia = _cb.syncPersonalMedia;
  if (typeof syncPersonalMedia !== "function") return;
  personalSyncBusy = type;
  renderPersonalMedia();
  try {
    await syncPersonalMedia(type);
    await loadPersonalMedia({ force: true });
  } catch (error) {
    setPersonalMessage(error?.message || `Personal ${type} sync failed.`, "error");
  } finally {
    personalSyncBusy = "";
    renderPersonalMedia();
  }
}

async function refreshPersonalViews() {
  renderPersonalMedia();
  _cb.renderDiscover?.();
  refreshRenderedPersonalRatingControls();
  refreshRenderedPersonalMediaControls();
}

// maxAgeMs lets a page entry ask for fresh data without refetching a snapshot
// that another pass of the same navigation loaded moments ago.
export async function loadPersonalMedia({ force = false, maxAgeMs = PERSONAL_MEDIA_TTL_MS } = {}) {
  if (!state.token) return;
  if (loadPromise) return loadPromise;
  if (!force && state.personalMediaLoadedAt && Date.now() - state.personalMediaLoadedAt < maxAgeMs) {
    renderPersonalMedia();
    refreshPersonalMetadata();
    return;
  }

  state.personalMediaLoading = true;
  state.personalMediaError = "";
  renderPersonalMedia();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PERSONAL_MEDIA_TIMEOUT_MS);
  loadPromise = (async () => {
    try {
      const response = await fetch("/api/personal-media", {
        headers: buildAuthHeaders(state.token),
        cache: force ? "reload" : "default",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Personal media load failed (${response.status})`);
      state.personalRatings = Array.isArray(body.ratings)
        ? collapsePersonalRatings(body.ratings.map(normalizeItem))
        : [];
      state.personalWatchlist = Array.isArray(body.watchlist) ? body.watchlist.map(normalizeItem) : [];
      state.personalLists = Array.isArray(body.lists)
        ? body.lists.map((list) => ({ ...list, items: Array.isArray(list.items) ? list.items.map(normalizeItem) : [] }))
        : [];
      state.personalDeletedLists = Array.isArray(body.deleted_lists) ? body.deleted_lists : [];
      state.personalListsStamp = typeof body.playlists_stamp === "string" ? body.playlists_stamp : "";
      state.playlistProviders = Array.isArray(body.playlist_providers) ? body.playlist_providers : [];
      state.personalMediaLoadedAt = Date.now();
      await refreshPersonalViews();
      refreshPersonalMetadata();
    } catch (error) {
      state.personalMediaError = error?.name === "AbortError" ? "The request timed out." : (error.message || "Try again later.");
    } finally {
      clearTimeout(timeout);
      state.personalMediaLoading = false;
      loadPromise = null;
      renderPersonalMedia();
    }
  })();
  return loadPromise;
}

export function resetPersonalMedia() {
  state.personalMediaLoadedAt = 0;
  state.personalMediaLoading = false;
  state.personalMediaError = "";
  state.personalRatings = [];
  state.personalWatchlist = [];
  state.personalLists = [];
  state.personalDeletedLists = [];
  state.playlistProviders = [];
  closePersonalDialog();
  refreshRenderedPersonalMediaControls();
}

export async function addToWatchlist(item, { showMessage = true } = {}) {
  const normalized = normalizeItem(item);
  const body = await personalRequest({ action: "watchlist-add", ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  if (showMessage) setPersonalMessage(`${normalized.title} added to your watchlist.${watchlistQueueMessage(body)}`, "success");
}

export async function removeFromWatchlist(item, { showMessage = true } = {}) {
  const normalized = normalizeItem(item);
  const body = await personalRequest({ action: "watchlist-remove", ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  if (showMessage) setPersonalMessage(`${normalized.title} removed from your watchlist.${watchlistQueueMessage(body)}`, "success");
}

function watchlistQueueMessage(body = {}) {
  const sync = body.watchlist_sync || {};
  const providers = Array.isArray(sync.providers) ? sync.providers : [];
  if (!Number(sync.queued || 0) || !providers.length) return " Saved locally.";
  const labels = providers.map((provider) => String(provider).replace(/^./, (letter) => letter.toUpperCase())).join(", ");
  return ` Queued for ${labels}.`;
}

async function saveRating(item, rating) {
  const normalized = normalizeItem(item);
  const body = await personalRequest({ action: "rate", rating, ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  closePersonalDialog();
  const queued = Number(body?.rating_sync?.queued || 0);
  const suffix = queued ? ` Queued for ${body.rating_sync.providers.map((provider) => provider[0].toUpperCase() + provider.slice(1)).join(", ")} separately.` : "";
  setPersonalMessage(`${normalized.title} rated ${rating}/10.${suffix}`, "success");
}

async function removeRating(item) {
  const normalized = normalizeItem(item);
  const body = await personalRequest({ action: "remove-rating", ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  closePersonalDialog();
  const queued = Number(body?.rating_sync?.queued || 0);
  const suffix = queued ? ` Removal queued for ${body.rating_sync.providers.map((provider) => provider[0].toUpperCase() + provider.slice(1)).join(", ")} separately.` : "";
  setPersonalMessage(`Rating removed from ${normalized.title}.${suffix}`, "success");
}

async function confirmRatingRemoval(item) {
  const normalized = normalizeItem(item);
  return Boolean(await _cb.openConfirmDialog?.({
    title: "Remove rating?",
    body: `Remove "${normalized.title}" from your ratings?`,
    confirmLabel: "Remove",
    cancelLabel: "Keep",
    danger: true,
  }));
}

export async function addToCustomList(item, listId, { showMessage = true } = {}) {
  const normalized = normalizeItem(item);
  // A TV playlist holds separate episodes, so a show opens the episode picker
  // instead of being added; the picker adds and reports on its own.
  if (String(normalized.media_type || "").toLowerCase() === "tv") {
    openShowEpisodePicker(normalized, listId);
    return { picker: true };
  }
  await personalRequest({ action: "list-add", list_id: listId, ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  closePersonalDialog();
  const list = (state.personalLists || []).find((entry) => String(entry.id) === String(listId));
  if (showMessage) setPersonalMessage(`${normalized.title} added to ${list?.name || "your playlist"}.`, "success");
}

export async function removeFromCustomList(item, listId, { showMessage = true } = {}) {
  const normalized = normalizeItem(item);
  await personalRequest({ action: "list-remove", list_id: listId, ...itemPayload(normalized) });
  await loadPersonalMedia({ force: true });
  if (showMessage) setPersonalMessage(`${normalized.title} removed from the playlist.`, "success");
}

function dialogFrame(title, body) {
  closePersonalDialog();
  const overlay = document.createElement("div");
  overlay.className = "personal-media-dialog-overlay";
  overlay.innerHTML = `
    <section class="personal-media-dialog" role="dialog" aria-modal="true" aria-labelledby="personal-media-dialog-title">
      <div class="personal-media-dialog-head">
        <h2 id="personal-media-dialog-title">${escapeHtml(title)}</h2>
        <button class="icon-button personal-media-dialog-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="personal-media-dialog-body">${body}</div>
    </section>
  `;
  document.body.appendChild(overlay);
  const close = () => closePersonalDialog(overlay);
  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.target === overlay || target?.closest(".personal-media-dialog-close")) {
      event.preventDefault();
      close();
    }
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
  const cleanup = () => {
    overlay.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
    if (dialogCleanup === cleanup) dialogCleanup = null;
  };
  cleanup.overlay = overlay;
  dialogCleanup = cleanup;
  return overlay;
}

export function closePersonalDialog(expectedOverlay = null) {
  if (expectedOverlay && dialogCleanup?.overlay !== expectedOverlay) return;
  dialogCleanup?.();
}

export function openRatingDialog(item) {
  const normalized = normalizeItem(item);
  const current = getPersonalRating(normalized);
  const choices = Array.from({ length: 10 }, (_, index) => index + 1).map((rating) => `<button class="personal-rating-choice${Number(current) === rating ? " active" : ""}" type="button" data-dialog-rating="${rating}">${rating}</button>`).join("");
  const dialogTitle = normalized.media_type === "episode"
    ? `Rate ${episodeCode(normalized.season, normalized.episode)} ${normalized.title}`
    : `Rate ${normalized.title}`;
  const overlay = dialogFrame(dialogTitle, `
    <p class="personal-media-dialog-copy">Choose your personal rating out of ten.</p>
    <div class="personal-rating-grid" aria-label="Choose a rating">${choices}</div>
    <button class="button-ghost personal-rating-remove${current ? "" : " hidden"}" type="button" data-dialog-remove-rating>Remove</button>
  `);
  overlay.addEventListener("click", async (event) => {
    const choice = event.target.closest("[data-dialog-rating]");
    const remove = event.target.closest("[data-dialog-remove-rating]");
    if (!choice && !remove) return;
    event.preventDefault();
    const buttons = [...overlay.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      if (remove) {
        if (!await confirmRatingRemoval(normalized)) {
          buttons.forEach((button) => { button.disabled = false; });
          return;
        }
        await removeRating(normalized);
      } else {
        await saveRating(normalized, Number(choice.dataset.dialogRating));
      }
    } catch (error) {
      buttons.forEach((button) => { button.disabled = false; });
      setPersonalMessage(error.message, "error");
    }
  });
}

export async function handlePersonalAction(actionButtonElement) {
  if (!actionButtonElement) return;
  const item = findPersonalItem(actionButtonElement.dataset.personalKey);
  if (!item) return;
  const action = actionButtonElement.dataset.personalAction || "";
  if (action === "remove-watchlist") {
    const originalLabel = actionButtonElement.textContent || "Remove";
    actionButtonElement.disabled = true;
    const confirmed = await _cb.openConfirmDialog?.({
      title: "Remove from watchlist?",
      body: `Remove "${item.title}" from your watchlist?`,
      confirmLabel: "Remove",
      cancelLabel: "Keep",
      danger: true,
    });
    if (!confirmed) {
      if (actionButtonElement.isConnected) actionButtonElement.disabled = false;
      return;
    }
    actionButtonElement.disabled = true;
    actionButtonElement.textContent = "Removing…";
    actionButtonElement.setAttribute("aria-busy", "true");
    removeFromWatchlist(item, { showMessage: false })
      .then(() => {
        if (!actionButtonElement.isConnected) return;
        actionButtonElement.disabled = true;
        actionButtonElement.textContent = "Removed";
        actionButtonElement.removeAttribute("aria-busy");
        actionButtonElement.setAttribute("aria-label", "Removed");
        actionButtonElement.title = "Removed";
      })
      .catch((error) => {
        if (actionButtonElement.isConnected) {
          actionButtonElement.disabled = false;
          actionButtonElement.textContent = originalLabel;
          actionButtonElement.removeAttribute("aria-busy");
        }
        setPersonalMessage(error.message, "error");
      });
    return;
  }
  if (action === "rate") {
    openRatingDialog(item);
    return;
  }
  if (action === "remove-rating") {
    const originalLabel = actionButtonElement.textContent || "Remove";
    actionButtonElement.disabled = true;
    const confirmed = await confirmRatingRemoval(item);
    if (!confirmed) {
      if (actionButtonElement.isConnected) actionButtonElement.disabled = false;
      return;
    }
    actionButtonElement.textContent = "Removing…";
    actionButtonElement.setAttribute("aria-busy", "true");
    removeRating(item)
      .then(() => {
        if (!actionButtonElement.isConnected) return;
        actionButtonElement.disabled = true;
        actionButtonElement.textContent = "Removed";
        actionButtonElement.removeAttribute("aria-busy");
        actionButtonElement.setAttribute("aria-label", "Removed");
        actionButtonElement.title = "Removed";
      })
      .catch((error) => {
        if (actionButtonElement.isConnected) {
          actionButtonElement.disabled = false;
          actionButtonElement.textContent = originalLabel;
          actionButtonElement.removeAttribute("aria-busy");
        }
        setPersonalMessage(error.message, "error");
      });
    return;
  }
  if (action.startsWith("remove-list:")) {
    const listId = action.slice("remove-list:".length);
    const list = (state.personalLists || []).find((entry) => String(entry.id) === String(listId));
    const listName = list?.name || "Playlist";
    const originalLabel = actionButtonElement.textContent || "Remove";
    actionButtonElement.disabled = true;
    // An automatic playlist never adds the title back (decision 65).
    const automaticNote = list?.rule
      ? ` Its rule will not add ${item.media_type === "movie" ? "it" : "this show"} back.`
      : "";
    const confirmed = await _cb.openConfirmDialog?.({
      title: "Remove from playlist?",
      body: `Remove "${item.title}" from "${listName}"?${automaticNote}`,
      confirmLabel: "Remove",
      cancelLabel: "Keep",
      danger: true,
    });
    if (!confirmed) {
      if (actionButtonElement.isConnected) actionButtonElement.disabled = false;
      return;
    }
    actionButtonElement.textContent = `${listName} - Removing…`;
    actionButtonElement.setAttribute("aria-busy", "true");
    removeFromCustomList(item, listId, { showMessage: false })
      .then(() => {
        if (!actionButtonElement.isConnected) return;
        actionButtonElement.disabled = true;
        actionButtonElement.textContent = "Removed";
        actionButtonElement.removeAttribute("aria-busy");
        actionButtonElement.setAttribute("aria-label", "Removed");
        actionButtonElement.title = "Removed";
      })
      .catch((error) => {
        if (actionButtonElement.isConnected) {
          actionButtonElement.disabled = false;
          actionButtonElement.textContent = originalLabel;
          actionButtonElement.removeAttribute("aria-busy");
        }
        setPersonalMessage(error.message, "error");
      });
  }
}

async function handlePanelClick(event) {
  const syncButton = event.target.closest("[data-personal-sync]");
  if (syncButton) {
    event.preventDefault();
    runPersonalSync(syncButton.dataset.personalSync);
    return;
  }
  const retry = event.target.closest("[data-personal-retry]");
  if (retry) {
    event.preventDefault();
    loadPersonalMedia({ force: true }).catch(() => { });
    return;
  }
  const create = event.target.closest("[data-personal-create-list]");
  if (create) {
    event.preventDefault();
    if (create.dataset.personalCreateList !== "playlists") return;
    openCreateListDialog();
    return;
  }
  if (event.target.closest("[data-personal-import-lists]")) {
    event.preventDefault();
    openImportPlaylistsDialog();
    return;
  }
  if (handlePlaylistClick(event)) return;
  const rateButton = event.target.closest("[data-personal-rate]");
  if (rateButton) {
    event.preventDefault();
    openRatingDialog(findPersonalItem(rateButton.dataset.personalKey) || { title: rateButton.dataset.personalTitle });
    return;
  }
  const actionButtonElement = event.target.closest("[data-personal-action]");
  if (!actionButtonElement) return;
  event.preventDefault();
  await handlePersonalAction(actionButtonElement);
}

initPlaylists({
  normalizeItem,
  personalCard,
  emptyPersonalState,
  personalRequest,
  loadPersonalMedia,
  setMessage: setPersonalMessage,
  dialogFrame,
  closePersonalDialog,
  confirm: (options) => _cb.openConfirmDialog?.(options),
  addToCustomList,
  customListsForPersonalItem,
});

export function initPersonalMedia(callbacks = {}) {
  _cb = callbacks;
  if (panelBound || (!elements.personalMediaPanel && !elements.personalMediaTopbarControls)) return;
  panelBound = true;
  elements.personalMediaPanel?.addEventListener("click", handlePanelClick);
  elements.personalMediaTopbarControls?.addEventListener("click", handlePanelClick);
}
