import { buildAuthHeaders } from "./auth.js?v=2.0.0.0.6";
import { state } from "./state.js?v=2.0.0.0.6";
import { safeImageUrl, escapeAttribute, isDemoMode } from "./utils.js?v=2.0.0.0.6";

// /api/poster resolves most requests from an already-cached DB row or webp
// file (no outbound API call); the actual TMDB fallback downloads are
// throttled server-side (TMDB_POSTER_CONCURRENCY = 8 in server/src/index.js),
// so this only needs to stay under the browser's per-origin connection cap -
// it doesn't need to additionally protect TMDB itself.
const POSTER_LOOKUP_CONCURRENCY = 6;
// v4 drops persisted negative lookups created before dashboard/review surfaces
// could resolve their record ids through the server poster pipeline.
const POSTER_LOOKUP_PERSISTED_CACHE_KEY = "plembfin:posterLookupCache:v4";
const POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const POSTER_LOOKUP_PERSISTED_CACHE_LIMIT = 800;
const TMDB_POSTER_SIZE = "w342";

export function isCachedStorageImageUrl(value = "") {
  const raw = String(value || "").trim();
  return /^\/(?:media|demo-assets)\//i.test(raw);
}

// These same-origin endpoints already return safe artwork (usually by
// redirecting to a cached file). Keep them usable in posterMarkup() without
// trying to resolve them against a media-server base URL.
export function isLocalArtworkUrl(value = "") {
  const raw = String(value || "").trim();
  if (isDemoMode()) return isCachedStorageImageUrl(raw);
  return isCachedStorageImageUrl(raw)
    || raw.startsWith("/api/poster")
    || raw.startsWith("/api/tmdb-poster")
    || raw.startsWith("/api/remote-artwork")
    || compactPosterUrl(raw) !== "";
}

export function compactPosterUrl(value) {
  const raw = String(value || "").trim();
  if (isCachedStorageImageUrl(raw)) return raw;
  if (isDemoMode()) return "";
  const url = safeImageUrl(raw);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "image.tmdb.org") return "";
  } catch (error) {
    return "";
  }
  return url.replace(/(https:\/\/image\.tmdb\.org\/t\/p\/)original\//i, `$1${TMDB_POSTER_SIZE}/`);
}

// Poster responses are untrusted data. Keep the DOM image sink limited to
// local cached media and TMDB artwork, which are the only sources this module
// is expected to hydrate.
export function safePosterElementUrl(value) {
  const raw = String(value || "").trim();
  if (isCachedStorageImageUrl(raw)) return raw;
  return compactPosterUrl(raw);
}

function persistentPosterCacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${POSTER_LOOKUP_PERSISTED_CACHE_KEY}:${userKey}`;
}

function readPersistentPosterCache() {
  try {
    const raw = localStorage.getItem(persistentPosterCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    return [];
  }
}

// In-memory mirror of the persisted poster cache so each poster resolution
// doesn't pay a full localStorage JSON parse/stringify round trip. Writes are
// debounced and flushed when the page is hidden or unloaded.
let posterCacheMirror = null;
let posterCacheFlushTimer = null;

function flushPosterCacheMirror() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  if (!posterCacheMirror) return;
  try {
    localStorage.setItem(posterCacheMirror.key, JSON.stringify({ entries: posterCacheMirror.entries }));
  } catch (error) {
    // Poster storage is best-effort; missing entries can still resolve through the API.
  }
}

function schedulePosterCacheFlush() {
  if (posterCacheFlushTimer) return;
  posterCacheFlushTimer = setTimeout(() => {
    posterCacheFlushTimer = null;
    flushPosterCacheMirror();
  }, 500);
}

function posterCacheEntries() {
  const key = persistentPosterCacheKey();
  if (!posterCacheMirror || posterCacheMirror.key !== key) {
    flushPosterCacheMirror();
    posterCacheMirror = { key, entries: readPersistentPosterCache() };
  }
  return posterCacheMirror.entries;
}

window.addEventListener("pagehide", flushPosterCacheMirror);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPosterCacheMirror();
});

export function clearPersistentPosterLookupCache() {
  if (posterCacheFlushTimer) {
    clearTimeout(posterCacheFlushTimer);
    posterCacheFlushTimer = null;
  }
  posterCacheMirror = null;
  try {
    localStorage.removeItem(persistentPosterCacheKey());
  } catch (error) { }
}

export function cachedPosterLookup(posterId) {
  if (!posterId) return undefined;
  if (state.posterLookupCache.has(posterId)) return state.posterLookupCache.get(posterId) || "";

  const now = Date.now();
  const allEntries = posterCacheEntries();
  const entries = allEntries.filter((entry) => now - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS);
  if (entries.length !== allEntries.length) {
    posterCacheMirror.entries = entries;
    schedulePosterCacheFlush();
  }
  const cached = entries.find((entry) => entry.id === posterId);
  if (!cached) return undefined;

  const url = typeof cached.url === "string" && isCachedStorageImageUrl(cached.url) ? cached.url : "";
  if (cached.url && !url) {
    posterCacheMirror.entries = entries.filter((entry) => entry.id !== posterId);
    schedulePosterCacheFlush();
    return undefined;
  }
  state.posterLookupCache.set(posterId, url);
  return url;
}

export function rememberPosterLookup(posterId, posterUrl) {
  if (!posterId) return;
  const url = isCachedStorageImageUrl(posterUrl) ? posterUrl : "";
  const savedAt = Date.now();
  state.posterLookupCache.set(posterId, url);

  const entries = posterCacheEntries()
    .filter((entry) => entry.id !== posterId && savedAt - Number(entry.savedAt || 0) <= POSTER_LOOKUP_PERSISTED_CACHE_TTL_MS)
    .concat({ id: posterId, url, savedAt });
  if (entries.length > POSTER_LOOKUP_PERSISTED_CACHE_LIMIT) {
    entries.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    entries.length = POSTER_LOOKUP_PERSISTED_CACHE_LIMIT;
  }
  posterCacheMirror.entries = entries;
  schedulePosterCacheFlush();
}

export function posterServerConfig(source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...state.savedConfig.plex, source: "plex" };
  if (key.includes("emby")) return { ...state.savedConfig.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...state.savedConfig.jellyfin, source: "jellyfin" };
  return {};
}

export function configuredImageUrl(path, item = {}) {
  const raw = String(path || "").trim();
  const server = posterServerConfig(item.source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";
  if (isDemoMode()) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    // Credentials never reach the browser (/api/config is redacted), so direct
    // server-image URLs can't carry a token. Plex rejects unauthenticated image
    // requests - bail out so callers use the /api/poster pipeline (which fetches
    // and caches server artwork with the stored token) instead of a 401 <img>.
    // Emby/Jellyfin image endpoints serve without an api_key.
    if (server.source === "plex" && !url.searchParams.has("X-Plex-Token")) return "";
    if (window.location.protocol === "https:" && url.protocol === "http:") return "";
    return url.toString();
  } catch (error) {
    return "";
  }
}

export function posterUrlFor(item = {}) {
  const idValue = item.id != null ? item.id : item.media_key;
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.thumb || "";
  const showRaw = item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "";
  const mediaType = String(item.media_type || item.mediaType || item.type || "").trim().toLowerCase();
  const isEpisode = mediaType === "episode";
  const seasonRaw = isEpisode ? (item.season_poster_url || item.seasonPosterUrl || "") : "";
  const cacheOnly = Boolean(item.cache_only_artwork || item.cacheOnlyArtwork);
  if (cacheOnly) {
    // Cache-first surfaces must not turn a stored TMDB path or remote CDN URL
    // into a new request while they render. The app's own authenticated proxy
    // is already a safe, same-origin image source though, and is how provider
    // feeds publish artwork before a local webp has been written. Rejecting
    // that URL here made a valid poster response look like a missing poster.
    const cacheSafeArtwork = (value) => {
      const candidate = String(value || "").trim();
      if (isDemoMode()) return isCachedStorageImageUrl(candidate);
      return isCachedStorageImageUrl(candidate)
        || /^\/api\/(?:poster|tmdb-poster|remote-artwork)(?:[/?]|$)/i.test(candidate);
    };
    return [seasonRaw, raw, showRaw].find(cacheSafeArtwork) || "";
  }
  // A same-origin poster supplied by the API is a deliberate source of truth,
  // not another candidate for an older negative lookup. This is especially
  // important after a show poster is edited: the old id-keyed miss must not
  // hide the new shared artwork.
  const resolvedRaw = proxiedArtworkUrl(raw, "poster");
  const resolvedShow = proxiedArtworkUrl(showRaw, "poster");
  if (item.prefer_show_poster || item.preferShowPoster) {
    // Some episode records carry a provider still in poster_url. Surfaces that
    // represent the parent show can opt out of both that raw image and any
    // id-keyed cache entry created for the episode, leaving the authenticated
    // poster fallback to resolve canonical show artwork instead.
    if (isLocalArtworkUrl(resolvedShow)) return resolvedShow;
    return configuredImageUrl(resolvedShow, item);
  }
  // Episode cards use the poster for their own season when it is available.
  // The series poster remains available separately for show-level surfaces.
  const resolvedSeason = proxiedArtworkUrl(seasonRaw, "poster");
  if (resolvedSeason) return isLocalArtworkUrl(resolvedSeason)
    ? resolvedSeason
    : configuredImageUrl(resolvedSeason, item);
  const preferLocalArtwork = isLocalArtworkUrl(resolvedRaw) || (!resolvedRaw && isLocalArtworkUrl(resolvedShow));
  if (idValue != null) {
    const cached = cachedPosterLookup(String(idValue));
    // A shared card may carry a fresh same-origin TMDB proxy URL while an old
    // poster lookup for the numeric provider id is cached as missing. In that
    // case the explicit local URL is the better source of truth.
    if (cached !== undefined && !preferLocalArtwork) return cached || "";
  }
  if (isLocalArtworkUrl(resolvedRaw)) return resolvedRaw;
  // A history/personal row may not carry its own poster, but still know the
  // canonical poster for its parent show. Use it as a fallback without
  // replacing an explicit episode image above.
  if (!resolvedRaw && isLocalArtworkUrl(resolvedShow)) return resolvedShow;
  if (!isDemoMode() && resolvedRaw.startsWith("https://img.youtube.com/")) return resolvedRaw;
  if (idValue != null && !item.prefer_raw_poster && !isLocalArtworkUrl(resolvedShow)) return "";
  if (resolvedRaw) {
    return configuredImageUrl(resolvedRaw, item) || configuredImageUrl(resolvedShow, item);
  }
  return configuredImageUrl(resolvedShow, item);
}

export function posterMarkup(item = {}, className = "media-poster") {
  const url = posterUrlFor(item);
  const label = item.title || "Media poster";
  const idValue = item.id != null ? item.id : item.media_key;
  const posterId = idValue != null ? ` data-poster-id="${escapeAttribute(String(idValue))}"` : "";
  if (!url) return `<span class="${className} poster-fallback"${posterId} aria-hidden="true"></span>`;
  const loading = item.eager_poster ? "eager" : "lazy";
  // `poster-img` carries the loading skeleton; app-events swaps in `is-loaded`
  // once the bitmap is there. The fallback span above deliberately omits it -
  // a card with no artwork is finished, not loading.
  return `<img class="${className} poster-img"${posterId} src="${escapeAttribute(url)}" alt="${escapeAttribute(label)} poster" loading="${loading}" decoding="async" fetchpriority="${item.eager_poster ? "high" : "auto"}" referrerpolicy="no-referrer" />`;
}

// Three-dot overflow button rendered on hover over a poster card outside the
// media detail pages, offering Mark Unwatched / Edit watch date / Fix match /
// Rate.
// It carries the item's identity as data-poster-menu-* attributes only - the
// dropdown itself is built and positioned on demand by poster-menu.js and
// portaled to <body>, because several poster wrappers this renders inside
// (e.g. `.history-mini-card-poster-wrapper`) use `overflow: hidden` and are
// far narrower than the menu. The dropdown's buttons reuse the same classes
// the media detail modal's delegated handlers already act on
// (`.media-edit-date-btn`, `.media-fix-match-btn`, `[data-unwatch-id]` in
// media-detail-events.js / watch-action.js). Rating is carried as a generic
// media payload for app-events.js, while the watch handlers already fall back
// to `document.body` for their container and refresh the active view afterward.
export function posterOverflowMenu(item = {}, options = {}) {
  const id = item.id;
  if (!id) return "";
  const isEpisode = item.media_type === "episode";
  const menuMode = options.menuMode || (options.upNext ? "up-next" : "");
  const personalAction = options.personalAction || "";
  const personalKey = options.personalKey || item.media_key || "";
  const personalRemoveLabel = options.personalRemoveLabel || "Remove";
  const mediaType = options.mediaType || (isEpisode ? "tv" : "movie");
  const kind = options.kind || (isEpisode ? "episode" : "movie");
  const showTitle = options.showTitle || (isEpisode ? (item.show_title || "") : "");
  // Fix Match rematches the whole show, not one episode, so an episode card's
  // default title (used to prefill the search box and to scope the rematch)
  // must be the show title, not the episode's own title/label.
  const title = options.title || (isEpisode ? (showTitle || item.title || "") : (item.title || ""));
  const label = options.label || (isEpisode ? (showTitle || title) : title);
  const isEpisodeRating = isEpisode || kind === "episode";
  const ratingTitle = options.ratingTitle || (isEpisodeRating
    ? (item.episode_title || item.episodeTitle || item.title || title)
    : title);
  const ratingShowTitle = options.ratingShowTitle || (isEpisodeRating
    ? (showTitle || item.show_title || item.showTitle || title)
    : "");
  const ratingSeason = options.ratingSeason ?? (isEpisodeRating ? (item.season ?? item.seasonNumber ?? "") : "");
  const ratingEpisode = options.ratingEpisode ?? (isEpisodeRating ? (item.episode ?? item.episodeNumber ?? "") : "");
  // Episode watch-history and Up Next rows can carry the provider's episode id
  // in `tmdb_id`/`tvdb_id`, while the media detail page rates the episode using
  // the show's series id. Prefer the explicit show identity for episode
  // ratings and leave it blank when no trusted series id exists.
  const ratingTmdbId = options.ratingTmdbId || (isEpisodeRating
    ? (item.show_tmdb_id || item.showTmdbId || "")
    : (item.tmdb_id || item.tmdbId || item.show_tmdb_id || item.showTmdbId || ""));
  const ratingTvdbId = options.ratingTvdbId || (isEpisodeRating
    ? (item.show_tvdb_id || item.showTvdbId || "")
    : (item.tvdb_id || item.tvdbId || item.show_tvdb_id || item.showTvdbId || ""));
  const ratingImdbId = options.ratingImdbId || (isEpisodeRating
    ? (item.show_imdb_id || item.showImdbId || "")
    : (item.imdb_id || item.imdbId || ""));
  const ratingShowTmdbId = options.ratingShowTmdbId || (isEpisodeRating
    ? (item.show_tmdb_id || item.showTmdbId || "")
    : "");
  const ratingShowTvdbId = options.ratingShowTvdbId || (isEpisodeRating
    ? (item.show_tvdb_id || item.showTvdbId || "")
    : "");
  const ratingShowImdbId = options.ratingShowImdbId || (isEpisodeRating
    ? (item.show_imdb_id || item.showImdbId || "")
    : "");
  const ratingEpisodeTmdbId = options.ratingEpisodeTmdbId || item.episode_tmdb_id || item.episodeTmdbId || "";
  const ratingEpisodeTvdbId = options.ratingEpisodeTvdbId || item.episode_tvdb_id || item.episodeTvdbId || "";
  const ratingEpisodeImdbId = options.ratingEpisodeImdbId || item.episode_imdb_id || item.episodeImdbId || "";
  // Deliberately no movie tmdb id attribute here: confirmAndMarkUnwatched()
  // in watch-action.js treats a present unwatch-tmdb-id as proof the movie's
  // detail page was already open and re-opens it after unwatching. These
  // menus live on grid/list cards where no detail page is open, so omitting
  // it keeps that action on the "just refresh the current view" branch.
  //
  // data-poster-menu-grid marks the unwatch action as grid-triggered so
  // confirmAndMarkUnwatched can skip its "was a detail modal open?" checks
  // outright, rather than trust state flags that can go stale (e.g. after a
  // browser back-navigation away from a detail page that didn't fully reset
  // them) and misroute a grid unwatch into a no-op "reopen the modal" branch.
  const showTitleAttr = showTitle ? ` data-poster-menu-show-title="${escapeAttribute(showTitle)}"` : "";
  const menuModeAttr = menuMode ? ` data-poster-menu-mode="${escapeAttribute(menuMode)}"` : "";
  const showUpNextTitle = showTitle || (mediaType === "tv" ? title : "");
  const showUpNextTmdbId = isEpisode ? (item.show_tmdb_id || item.showTmdbId || "") : (item.tmdb_id || item.tmdbId || "");
  const showUpNextTvdbId = isEpisode ? (item.show_tvdb_id || item.showTvdbId || "") : (item.tvdb_id || item.tvdbId || "");
  const showUpNextImdbId = isEpisode ? (item.show_imdb_id || item.showImdbId || "") : (item.imdb_id || item.imdbId || "");
  const showUpNextAttrs = mediaType === "tv" ? `
      data-poster-menu-up-next-show-title="${escapeAttribute(showUpNextTitle)}"
      data-poster-menu-up-next-show-tmdb-id="${escapeAttribute(showUpNextTmdbId)}"
      data-poster-menu-up-next-show-tvdb-id="${escapeAttribute(showUpNextTvdbId)}"
      data-poster-menu-up-next-show-imdb-id="${escapeAttribute(showUpNextImdbId)}"
      data-poster-menu-up-next-show-poster-url="${escapeAttribute(item.show_poster_url || item.showPosterUrl || item.poster_url || item.posterUrl || "")}"` : "";
  const personalActionAttrs = menuMode === "personal" && personalAction
    ? ` data-poster-menu-personal-action="${escapeAttribute(personalAction)}" data-poster-menu-personal-key="${escapeAttribute(personalKey)}" data-poster-menu-personal-remove-label="${escapeAttribute(personalRemoveLabel)}"`
    : "";
  const ratingAttrs = `
      data-poster-menu-rating-media-type="${escapeAttribute(isEpisodeRating ? "episode" : mediaType)}"
      data-poster-menu-rating-tmdb-id="${escapeAttribute(ratingTmdbId)}"
      data-poster-menu-rating-tvdb-id="${escapeAttribute(ratingTvdbId)}"
      data-poster-menu-rating-imdb-id="${escapeAttribute(ratingImdbId)}"
      data-poster-menu-rating-show-tmdb-id="${escapeAttribute(ratingShowTmdbId)}"
      data-poster-menu-rating-show-tvdb-id="${escapeAttribute(ratingShowTvdbId)}"
      data-poster-menu-rating-show-imdb-id="${escapeAttribute(ratingShowImdbId)}"
      data-poster-menu-rating-episode-tmdb-id="${escapeAttribute(ratingEpisodeTmdbId)}"
      data-poster-menu-rating-episode-tvdb-id="${escapeAttribute(ratingEpisodeTvdbId)}"
      data-poster-menu-rating-episode-imdb-id="${escapeAttribute(ratingEpisodeImdbId)}"
      data-poster-menu-rating-title="${escapeAttribute(ratingTitle)}"
      data-poster-menu-rating-show-title="${escapeAttribute(ratingShowTitle)}"
      data-poster-menu-rating-season="${escapeAttribute(ratingSeason)}"
      data-poster-menu-rating-episode="${escapeAttribute(ratingEpisode)}"
      data-poster-menu-rating-poster-url="${escapeAttribute(item.poster_url || item.posterUrl || "")}"
      data-poster-menu-rating-overview="${escapeAttribute(item.overview || item.description || "")}"
      data-poster-menu-rating-release-date="${escapeAttribute(item.release_date || item.first_air_date || item.releaseDate || item.air_date || item.airDate || "")}"`;
  const upNextAttrs = menuMode === "up-next" ? `
      data-poster-menu-up-next-watch="${escapeAttribute(id)}"
      data-poster-menu-up-next-media-type="${escapeAttribute(item.media_type || (isEpisode ? "episode" : "movie"))}"
      data-poster-menu-up-next-queue-kind="${escapeAttribute(options.queueKind || item.queue_kind || "next_up")}"
      data-poster-menu-up-next-title="${escapeAttribute(item.title || title)}"
      data-poster-menu-up-next-show-title="${escapeAttribute(showTitle || title)}"
      data-poster-menu-up-next-tmdb-id="${escapeAttribute(isEpisode ? (item.show_tmdb_id || "") : (item.tmdb_id || ""))}"
      data-poster-menu-up-next-tvdb-id="${escapeAttribute(isEpisode ? (item.show_tvdb_id || "") : (item.tvdb_id || ""))}"
      data-poster-menu-up-next-imdb-id="${escapeAttribute(isEpisode ? (item.show_imdb_id || "") : (item.imdb_id || ""))}"
      data-poster-menu-up-next-episode-tmdb-id="${escapeAttribute(ratingEpisodeTmdbId)}"
      data-poster-menu-up-next-episode-tvdb-id="${escapeAttribute(ratingEpisodeTvdbId)}"
      data-poster-menu-up-next-episode-imdb-id="${escapeAttribute(ratingEpisodeImdbId)}"
      data-poster-menu-up-next-season="${escapeAttribute(item.season ?? "")}"
      data-poster-menu-up-next-episode="${escapeAttribute(item.episode ?? "")}"
      data-poster-menu-up-next-episode-title="${escapeAttribute(item.episode_title || item.episodeTitle || "")}"
      data-poster-menu-up-next-air-date="${escapeAttribute(item.air_date || item.airDate || "")}" 
      data-poster-menu-up-next-has-progress="${Number(item.position_ms ?? item.positionMs ?? 0) > 0 || Number(item.progress ?? 0) > 0 ? "true" : "false"}"
      data-poster-menu-up-next-poster-url="${escapeAttribute(item.poster_url || item.posterUrl || "")}" 
      data-poster-menu-up-next-provider-items="${escapeAttribute(JSON.stringify(item.provider_items || item.providerItems || {}))}"` : "";
  const discoverAttrs = menuMode === "discover" ? `
      data-poster-menu-discover-media-type="${escapeAttribute(mediaType)}"
      data-poster-menu-discover-tmdb-id="${escapeAttribute(item.tmdb_id || item.tmdbId || "")}" 
      data-poster-menu-discover-tvdb-id="${escapeAttribute(item.tvdb_id || item.tvdbId || "")}" 
      data-poster-menu-discover-imdb-id="${escapeAttribute(item.imdb_id || item.imdbId || "")}" 
      data-poster-menu-discover-title="${escapeAttribute(item.title || "")}" 
      data-poster-menu-discover-poster-url="${escapeAttribute(item.poster_url || item.posterUrl || "")}" 
      data-poster-menu-discover-overview="${escapeAttribute(item.overview || item.description || "")}"
      data-poster-menu-discover-release-date="${escapeAttribute(item.release_date || item.first_air_date || item.releaseDate || "")}" 
      data-poster-menu-discover-watchlisted="${options.watchlisted ? "true" : "false"}"` : "";
  return `
    <button
      type="button"
      class="poster-overflow-btn"
      aria-haspopup="true"
      aria-expanded="false"
      aria-label="More options"
      title="More options"
      data-poster-menu-id="${escapeAttribute(id)}"
      data-poster-menu-watched-at="${escapeAttribute(item.watched_at || "")}"
      data-poster-menu-title="${escapeAttribute(title)}"
      data-poster-menu-media-type="${escapeAttribute(mediaType)}"
      data-poster-menu-kind="${escapeAttribute(kind)}"
      data-poster-menu-label="${escapeAttribute(label)}"
      data-poster-menu-grid="1"${showTitleAttr}${menuModeAttr}${personalActionAttrs}${ratingAttrs}${upNextAttrs}${showUpNextAttrs}${discoverAttrs}
    >&#8942;</button>
  `;
}

export function posterFallbackElement(className = "media-poster", posterId = "") {
  const fallback = document.createElement("span");
  fallback.className = `${className} poster-fallback`.trim();
  fallback.setAttribute("aria-hidden", "true");
  if (posterId) fallback.dataset.posterId = posterId;
  return fallback;
}

export async function lookupPosterUrl(posterId, { fallback = false, allowNetwork = true } = {}) {
  if (!posterId) return "";
  // The public demo is a closed fixture. Never turn a missing local image
  // into a poster lookup that could make the server contact a provider.
  if (isDemoMode()) return "";
  if (!fallback) {
    const cached = cachedPosterLookup(posterId);
    if (cached !== undefined) return cached || "";
  }
  // Some surfaces, notably the dashboard, are intentionally cache-only. A
  // missing poster there should stay a cheap placeholder rather than starting
  // a provider lookup while the page is rendering.
  if (!allowNetwork) return "";
  if (!state.token) {
    return "";
  }

  const cacheKey = fallback ? `${posterId}:fallback` : posterId;
  let lookup = state.posterLookupInflight.get(cacheKey);
  if (!lookup) {
    const url = new URL("/api/poster", window.location.origin);
    url.searchParams.set("id", posterId);
    if (fallback) url.searchParams.set("fallback", "1");
    lookup = fetch(url, { headers: buildAuthHeaders(state.token) })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (response.status === 404) {
          return "MISSING";
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!body.url) {
          return "MISSING";
        }
        const usableUrl = compactPosterUrl(body.url);
        if (usableUrl || fallback) return usableUrl;
        return lookupPosterUrl(posterId, { fallback: true, allowNetwork });
      })
      .catch((error) => {
        console.warn("Poster lookup failed", error);
        return "ERROR";
      })
      .finally(() => state.posterLookupInflight.delete(cacheKey));
    state.posterLookupInflight.set(cacheKey, lookup);
  }

  const posterUrl = await lookup;
  if (posterUrl === "ERROR") {
    return "";
  }
  const finalUrl = posterUrl === "MISSING" ? "" : posterUrl;
  rememberPosterLookup(posterId, finalUrl || "");
  return finalUrl || "";
}

function shouldHydratePosterElement(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  return rect.bottom >= -120 && rect.right >= -120 && rect.top <= viewportHeight + 360 && rect.left <= viewportWidth + 120;
}

async function prefillPosterLookups(fallbacks, { allowNetwork = true } = {}) {
  if (isDemoMode() || !allowNetwork || !state.token) return;
  const ids = [];
  const seen = new Set();
  for (const fallback of fallbacks) {
    const posterId = fallback.dataset.posterId;
    if (!posterId || seen.has(posterId)) continue;
    if (cachedPosterLookup(posterId) !== undefined) continue;
    if (state.posterLookupInflight.has(posterId)) continue;
    seen.add(posterId);
    ids.push(posterId);
  }
  if (ids.length < 2) return;

  try {
    const response = await fetch("/api/poster-batch", {
      method: "POST",
      headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
      body: JSON.stringify({ items: ids.map((id) => ({ id })) }),
    });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    for (const result of Array.isArray(body.results) ? body.results : []) {
      const id = String(result?.id || "");
      if (!id) continue;
      // Only a resolved URL is cached here. A miss is left alone so the
      // per-card path can still try its fallback lookup, exactly as before.
      const usableUrl = compactPosterUrl(result?.payload?.url || "");
      if (usableUrl) rememberPosterLookup(id, usableUrl);
    }
  } catch (error) {
    // A failed batch is not an error state: every card falls back to its own
    // lookup, which is the behaviour that existed before this optimization.
    console.warn("Poster batch lookup failed", error);
  }
}

export async function hydratePosterFallbacks(container = document.body, { allowNetwork = true } = {}) {
  if (!container) return;
  const fallbacks = [...container.querySelectorAll("[data-poster-id].poster-fallback")].filter((fallback) => {
    const posterId = fallback.dataset.posterId;
    return posterId && shouldHydratePosterElement(fallback);
  });
  if (!fallbacks.length) return;

  // One request for the whole viewport instead of one per card. Each
  // individual /api/poster call re-ran requireAdmin, the full lookup chain and
  // the media config load, so a grid paid all of that once per visible poster.
  // The results are written into the same lookup cache the per-card path
  // already consults, so everything below is unchanged and simply hits it.
  await prefillPosterLookups(fallbacks, { allowNetwork });

  const hydrateOne = async (fallback) => {
    const posterId = fallback.dataset.posterId;
    if (!posterId) return;

    const cached = cachedPosterLookup(posterId);
    if (cached === "") return;
    const posterUrl = cached !== undefined
      ? cached
      : await lookupPosterUrl(posterId, { allowNetwork });
    const safeUrl = safePosterElementUrl(posterUrl);
    if (!safeUrl || !fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

    const image = document.createElement("img");
    image.className = `${fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className} poster-img`;
    bindPosterImageErrorHandler(image, { allowNetwork });
    image.src = encodeURI(safeUrl);
    image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
    image.loading = "eager";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.dataset.posterId = posterId;
    fallback.replaceWith(image);
  };

  const workers = Array.from({ length: Math.min(POSTER_LOOKUP_CONCURRENCY, fallbacks.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < fallbacks.length; index += POSTER_LOOKUP_CONCURRENCY) {
      await hydrateOne(fallbacks[index]);
    }
  });

  await Promise.allSettled(workers);
}

// Grid images that fail to load arrive one error event at a time, and each used
// to start its own fallback lookup. Collect them briefly and resolve them with
// one poster-batch request instead. Anything the batch cannot answer (a failed
// request, a lone poster) takes the per-poster fallback path exactly as before.
const POSTER_FALLBACK_BATCH_DELAY_MS = 100;
const POSTER_FALLBACK_BATCH_MAX = 240;
const posterFallbackBatchQueue = new Map();
let posterFallbackBatchTimer = null;

export function batchedFallbackPosterUrl(posterId, { allowNetwork = true } = {}) {
  if (!posterId || isDemoMode() || !allowNetwork || !state.token) return lookupPosterUrl(posterId, { fallback: true, allowNetwork });
  return new Promise((resolve) => {
    const waiters = posterFallbackBatchQueue.get(posterId) || [];
    waiters.push(resolve);
    posterFallbackBatchQueue.set(posterId, waiters);
    if (!posterFallbackBatchTimer) posterFallbackBatchTimer = setTimeout(flushPosterFallbackBatch, POSTER_FALLBACK_BATCH_DELAY_MS);
  });
}

async function flushPosterFallbackBatch() {
  posterFallbackBatchTimer = null;
  const queued = [...posterFallbackBatchQueue.entries()].slice(0, POSTER_FALLBACK_BATCH_MAX);
  for (const [posterId] of queued) posterFallbackBatchQueue.delete(posterId);
  if (posterFallbackBatchQueue.size) posterFallbackBatchTimer = setTimeout(flushPosterFallbackBatch, 0);

  const answered = new Map();
  if (queued.length > 1) {
    try {
      const response = await fetch("/api/poster-batch", {
        method: "POST",
        headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
        body: JSON.stringify({ items: queued.map(([id]) => ({ id, fallback: true })) }),
      });
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      for (const result of Array.isArray(body.results) ? body.results : []) {
        const id = String(result?.id || "");
        if (id) answered.set(id, compactPosterUrl(result?.payload?.url || ""));
      }
    } catch (error) {
      console.warn("Poster fallback batch lookup failed", error);
    }
  }

  await Promise.all(queued.map(async ([posterId, waiters]) => {
    let posterUrl;
    if (answered.has(posterId)) {
      posterUrl = answered.get(posterId);
      rememberPosterLookup(posterId, posterUrl);
    } else {
      posterUrl = await lookupPosterUrl(posterId, { fallback: true });
    }
    for (const resolve of waiters) resolve(posterUrl);
  }));
}

export function bindPosterImageErrorHandler(image, { allowNetwork = true } = {}) {
  if (image.dataset.posterErrorBound) return;
  image.dataset.posterErrorBound = "1";
  image.addEventListener("error", async () => {
    const posterId = image.dataset.posterId;
    if (!posterId || image.dataset.posterFallbackAttempted === "1") {
      if (posterId) state.posterLookupCache.set(posterId, "");
      image.replaceWith(posterFallbackElement(image.className, posterId));
      return;
    }

    image.dataset.posterFallbackAttempted = "1";
    const brokenUrl = image.currentSrc || image.src;
    const fallbackUrl = await batchedFallbackPosterUrl(posterId, { allowNetwork });
    const safeFallbackUrl = safePosterElementUrl(fallbackUrl);
    if (safeFallbackUrl && safeFallbackUrl !== brokenUrl && image.isConnected) {
      image.src = encodeURI(safeFallbackUrl);
      return;
    }

    state.posterLookupCache.set(posterId, "");
    if (image.isConnected) image.replaceWith(posterFallbackElement(image.className, posterId));
  });
}

export function hydratePosterImages(container = document.body, { allowNetwork = true } = {}) {
  if (!container) return;
  for (const image of container.querySelectorAll("img[data-poster-id]")) {
    bindPosterImageErrorHandler(image, { allowNetwork });
    // A rerender can insert an image whose response is already in the browser
    // cache before the delegated document-level load listener sees it. Keep
    // those cards from remaining in the loading state until a full reload.
    if (image.complete && image.naturalWidth > 0) image.classList.add("is-loaded");
  }
}

export function hydrateMediaDetailImages(container = document.body) {
  if (!container) return;
  const images = [];
  if (container.matches?.(".media-detail-page")) images.push(...container.querySelectorAll("img"));
  images.push(...container.querySelectorAll(".media-detail-page img"));
  for (const image of images) {
    // A rerender can insert an image whose response is already in the browser
    // cache before the delegated document-level load listener sees it.
    if (image.complete && image.naturalWidth > 0) image.classList.add("is-loaded");
  }
}

export function hydratePosters(container = document.body, { allowNetwork = true } = {}) {
  hydratePosterImages(container, { allowNetwork });
  hydrateMediaDetailImages(container);
  hydratePosterFallbacks(container, { allowNetwork }).catch(() => { });
}

export function tmdbImage(path, size = "w300") {
  if (!path) return "";
  if (/^\/(?:demo-assets|media)\//i.test(path)) return path;
  if (isDemoMode()) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function tmdbPoster(path, tmdbId = "", mediaType = "") {
  if (!path) return "";
  if (/^\/(?:demo-assets|media)\//i.test(path)) return path;
  if (isDemoMode()) return "";
  let url = `/api/tmdb-poster?path=${encodeURIComponent(path)}`;
  if (tmdbId) url += `&tmdbId=${encodeURIComponent(tmdbId)}`;
  if (mediaType) url += `&mediaType=${encodeURIComponent(mediaType)}`;
  return url;
}

// fanart.tv and TVDB return absolute CDN URLs. Those hosts are not always
// reachable from the browser even when the server can fetch them, so route
// them through the caching proxy instead of hot-linking. Local /media artwork
// and data/blob URLs are already served by this app and pass through.
const PROXIED_ARTWORK_HOSTS = new Set(["assets.fanart.tv", "artworks.thetvdb.com"]);

// Artwork the proxy could not fetch this session. A detail page renders more
// than once as its parts arrive, so without this every render would request a
// known-dead image again and log another failure.
const _unavailableArtwork = new Set();

export function markArtworkUnavailable(src) {
  if (!src) return;
  try {
    const parsed = new URL(String(src), window.location.origin);
    if (parsed.pathname === "/api/remote-artwork") _unavailableArtwork.add(parsed.pathname + parsed.search);
  } catch {
    // A src the URL parser rejects cannot match a proxy URL either.
  }
}

// Returns "" for artwork already known to be unavailable, so callers fall
// straight through to their own alternative (the title heading, or dropping a
// gallery tile) without another request.
export function proxiedArtworkUrl(url, variant = "poster") {
  const raw = String(url || "").trim();
  if (isDemoMode() && /^https?:\/\//i.test(raw)) return "";
  if (!raw || !/^https:\/\//i.test(raw)) return raw;
  if (isDemoMode()) return "";
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return raw;
  }
  if (!PROXIED_ARTWORK_HOSTS.has(host)) return raw;
  const proxied = `/api/remote-artwork?variant=${encodeURIComponent(variant)}&url=${encodeURIComponent(raw)}`;
  return _unavailableArtwork.has(proxied) ? "" : proxied;
}

// English and language-neutral logos only. A logo in another language reads as
// a different title to anyone using this app, so titles that have neither fall
// back to their text heading rather than showing foreign wordmark art.
export function bestTmdbLogo(tmdbData) {
  const logos = tmdbData?.images?.logos || [];
  const logo = logos.find(l => l.iso_639_1 === "en") || logos.find(l => !l.iso_639_1);
  if (logo) return tmdbImage(logo.file_path, "original");
  const cached = tmdbData?.cached_logo_url || "";
  return isDemoMode() && !isCachedStorageImageUrl(cached) ? null : cached || null;
}

export function tmdbProfile(path) {
  if (!path) return "";
  if (/^\/(?:demo-assets|media)\//i.test(path)) return path;
  if (isDemoMode()) return "";
  return `/api/tmdb-profile?path=${encodeURIComponent(path)}`;
}
