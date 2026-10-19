import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.2";
import { state, elements } from "./state.js?v=2.1.1.0.2";
import { escapeHtml, formatTmdbDate } from "./utils.js?v=2.1.1.0.2";
import { hydratePosters } from "./images.js?v=2.1.1.0.2";
import { renderMediaCard } from "./media-card.js?v=2.1.1.0.2";
import { mediaKeyForPersonalItem } from "./personal-media.js?v=2.1.1.0.2";

const DISCOVER_TTL_MS = 10 * 60 * 1000;
const DISCOVER_TIMEOUT_MS = 20000;
const DISCOVER_CACHE_KEY = "plembfin:discoverCache:v5";
const DISCOVER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVER_CACHE_MAX_ENTRIES = 24;

const MOVIE_GENRES = [
  [28, "Action"], [12, "Adventure"], [35, "Comedy"], [80, "Crime"],
  [18, "Drama"], [14, "Fantasy"], [27, "Horror"], [9648, "Mystery"],
  [10749, "Romance"], [878, "Science fiction"], [53, "Thriller"], [10752, "War"],
];
const TV_GENRES = [
  [10759, "Action & adventure"], [35, "Comedy"], [80, "Crime"], [18, "Drama"],
  [10765, "Science fiction & fantasy"], [9648, "Mystery"], [10749, "Romance"],
  [10768, "War & politics"], [37, "Western"],
];

const FEED_LABELS = {
  recommended: "Recommended for you",
  new_movies: "In theatres",
  trending_movies: "Trending movies",
  trending_shows: "Trending TV shows",
  popular_movies: "Popular movies",
  upcoming_movies: "Upcoming movies",
  popular_shows: "Popular TV shows",
  on_air_shows: "On the air",
  genre_movies: "Movies in this genre",
  genre_shows: "TV shows in this genre",
};

let _cb = {};
let controlsBound = false;
let actionsBound = false;

function discoverVariantKey() {
  return `${state.discoverMediaType || "all"}|${state.discoverGenreId || ""}`;
}

function readDiscoverCache() {
  try {
    const stored = JSON.parse(localStorage.getItem(DISCOVER_CACHE_KEY) || "null");
    return stored?.entries && typeof stored.entries === "object" && !Array.isArray(stored.entries)
      ? stored
      : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function hydrateDiscoverCache() {
  if (Object.keys(state.discoverFeeds || {}).length) return true;
  const entry = readDiscoverCache().entries[discoverVariantKey()];
  const savedAt = Number(entry?.savedAt || 0);
  if (!savedAt || Date.now() - savedAt > DISCOVER_CACHE_TTL_MS) return false;
  if (!entry.feeds || typeof entry.feeds !== "object" || Array.isArray(entry.feeds)) return false;
  state.discoverFeeds = entry.feeds;
  // Keep this at zero so the server still reconciles the browser cache. The
  // cached rails are only a first paint; the server cache and SSE update remain
  // authoritative once the request completes.
  state.discoverLoadedAt = 0;
  return true;
}

function persistDiscoverCache() {
  try {
    const stored = readDiscoverCache();
    const entries = {
      ...stored.entries,
      [discoverVariantKey()]: {
        savedAt: Date.now(),
        feeds: state.discoverFeeds,
      },
    };
    const boundedEntries = Object.fromEntries(Object.entries(entries)
      .sort(([, a], [, b]) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0))
      .slice(0, DISCOVER_CACHE_MAX_ENTRIES));
    localStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify({ version: 1, entries: boundedEntries }));
  } catch {
    // A full/private browser storage area must not make Discover fail.
  }
}

function isWatchlisted(item) {
  const key = mediaKeyForPersonalItem(item);
  return (state.personalWatchlist || []).some((entry) => String(entry.media_key || mediaKeyForPersonalItem(entry)) === key);
}

function discoverTitleKeys(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return [];
  const withoutYear = normalized.replace(/\s+\d{4}$/, "").trim();
  return [...new Set([normalized, withoutYear].filter(Boolean))];
}

function historyContainsDiscoverItem(item, mediaType) {
  const itemId = String(item.id || item.tmdb_id || "");
  const itemTitles = new Set(discoverTitleKeys(item.title || item.name));
  return (state.history || []).some((history) => {
    if (history.media_type !== (mediaType === "tv" ? "episode" : "movie")) return false;
    const historyId = String(history.tmdb_id || history.show_tmdb_id || "");
    if (itemId && historyId && itemId === historyId) return true;
    const historyTitle = history.media_type === "episode" ? history.show_title || history.title : history.title;
    return discoverTitleKeys(historyTitle).some((key) => itemTitles.has(key));
  });
}

function discoverItemIdentity(item = {}) {
  const mediaType = item.media_type === "tv" || item.first_air_date ? "tv" : "movie";
  const tmdbId = String(item.tmdb_id || item.tmdbId || item.id || "").trim();
  return tmdbId ? `${mediaType}:${tmdbId}` : "";
}

export async function dontRecommendDiscoverItem(item = {}) {
  const tmdbId = String(item.tmdb_id || item.tmdbId || item.id || "").trim();
  const mediaType = item.media_type === "tv" || item.media_type === "show" ? "tv" : "movie";
  if (!/^\d+$/.test(tmdbId)) throw new Error("This Discover item has no valid TMDB id.");
  const response = await fetch("/api/discover/dismiss", {
    method: "POST",
    headers: buildAuthHeaders(state.token),
    body: JSON.stringify({ media_type: mediaType, tmdb_id: tmdbId, title: item.title || item.name || "" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not update Discover recommendations");

  const identity = discoverItemIdentity({ ...item, media_type: mediaType, tmdb_id: tmdbId });
  if (identity) {
    state.discoverFeeds = Object.fromEntries(Object.entries(state.discoverFeeds || {}).map(([feedKey, feed]) => [
      feedKey,
      feedKey === "recommended"
        ? { ...feed, results: (feed.results || []).filter((candidate) => discoverItemIdentity(candidate) !== identity) }
        : feed,
    ]));
    persistDiscoverCache();
    renderDiscover();
  }
  return body.exclusion || { media_type: mediaType, tmdb_id: tmdbId, title: item.title || item.name || "" };
}

export function initDiscover(callbacks = {}) {
  _cb = callbacks;
  if (controlsBound) return;
  controlsBound = true;
  syncGenreOptions();
  hydrateDiscoverCache();
  if (!actionsBound && elements.discoverPanel) {
    actionsBound = true;
    elements.discoverPanel.addEventListener("click", (event) => {
      const settingsButton = event.target.closest("[data-discover-settings]");
      if (settingsButton) {
        event.preventDefault();
        _cb.navigateTo?.("/settings/metadata");
        return;
      }
      const retry = event.target.closest("[data-discover-retry]");
      if (!retry) return;
      event.preventDefault();
      loadDiscover({ force: true }).catch(() => { });
    });
  }
  elements.discoverMediaType?.addEventListener("change", () => {
    state.discoverMediaType = ["all", "movie", "tv"].includes(elements.discoverMediaType.value)
      ? elements.discoverMediaType.value
      : "all";
    state.discoverGenreId = "";
    syncGenreOptions();
    resetDiscover({ hydrate: true });
    renderDiscover();
    loadDiscover({ force: true }).catch(() => { });
  });
  elements.discoverGenre?.addEventListener("change", () => {
    state.discoverGenreId = String(elements.discoverGenre.value || "");
    resetDiscover({ hydrate: true });
    renderDiscover();
    loadDiscover({ force: true }).catch(() => { });
  });
  elements.discoverRefreshButton?.addEventListener("click", () => {
    loadDiscover({ force: true }).catch(() => { });
  });
}

function syncGenreOptions() {
  const select = elements.discoverGenre;
  if (!select) return;
  const genres = state.discoverMediaType === "movie"
    ? MOVIE_GENRES
    : state.discoverMediaType === "tv"
      ? TV_GENRES
      : [...MOVIE_GENRES, ...TV_GENRES].filter(([id], index, all) => all.findIndex(([candidate]) => candidate === id) === index);
  const current = state.discoverGenreId;
  select.innerHTML = `<option value="">All genres</option>${genres.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("")}`;
  select.value = genres.some(([id]) => String(id) === current) ? current : "";
  state.discoverGenreId = select.value;
  if (elements.discoverMediaType) elements.discoverMediaType.value = state.discoverMediaType;
}

export function resetDiscover({ preserveItems = false, hydrate = false } = {}) {
  state.discoverRequestVersion += 1;
  state.discoverAbortController?.abort();
  state.discoverAbortController = null;
  if (!preserveItems) state.discoverFeeds = {};
  state.discoverLoadedAt = 0;
  state.discoverLoading = false;
  state.discoverError = "";
  state.discoverErrorCode = "";
  state.discoverRefreshQueued = false;
  if (hydrate) hydrateDiscoverCache();
}

function discoverErrorPresentation() {
  if (state.discoverErrorCode === "TMDB_NOT_CONFIGURED" || /TMDB API key is not configured/i.test(state.discoverError)) {
    return {
      title: "Connect TMDB to use Discover",
      detail: "Add a TMDB API key in Settings → Metadata to browse current movies and TV shows.",
      action: `<button class="button-primary" type="button" data-discover-settings>Open metadata settings</button>`,
    };
  }
  if (state.discoverErrorCode === "TMDB_AUTH_FAILED") {
    return {
      title: "Check the TMDB API key",
      detail: state.discoverError,
      action: `<button class="button-primary" type="button" data-discover-settings>Open metadata settings</button>`,
    };
  }
  if (state.discoverErrorCode === "TMDB_RATE_LIMITED" || state.discoverErrorCode === "TMDB_UNAVAILABLE") {
    return {
      title: "TMDB is temporarily unavailable",
      detail: state.discoverError,
      action: `<button class="button-ghost" type="button" data-discover-retry>Try again</button>`,
    };
  }
  if (state.discoverErrorCode === "SERVER_ROUTE_MISSING" || /\bnot found\b/i.test(state.discoverError)) {
    return {
      title: "Restart Plekt to load Discover",
      detail: "The local server is running an older build. Restart it, then try again.",
      action: `<button class="button-ghost" type="button" data-discover-retry>Try again</button>`,
    };
  }
  return {
    title: "Discover is unavailable",
    detail: state.discoverError || "Try again later.",
    action: `<button class="button-ghost" type="button" data-discover-retry>Try again</button>`,
  };
}

function discoverItem(item = {}, feedKey = "") {
  const mediaType = item.media_type === "tv" || item.first_air_date ? "tv" : "movie";
  const title = item.title || item.name || "Untitled";
  const date = item.release_date || item.first_air_date || "";
  const watched = Boolean(item.is_watched) || historyContainsDiscoverItem(item, mediaType);
  return {
    ...item,
    id: item.id,
    tmdb_id: String(item.id),
    media_type: mediaType,
    title,
    poster_path: item.poster_path || "",
    // Discover cards use the date as their primary metadata. Avoid repeating
    // the media type/year string so the summary has room to breathe.
    meta: "",
    feedKey,
    watched,
  };
}

function renderFeed(feedKey, feed) {
  const items = Array.isArray(feed?.results)
    ? feed.results.map((item) => discoverItem(item, feedKey)).filter((item) => !item.watched && (item.poster_path || item.title))
    : [];
  const label = FEED_LABELS[feedKey] || "Discover";
  const emptyMessage = feedKey === "recommended"
    ? { title: "Watch a few titles to get recommendations", detail: "Plekt will use your watch history to build this rail." }
    : { title: "No results in this rail", detail: "Try another type or genre." };
  return `
    <section class="discover-feed" aria-labelledby="discover-${feedKey}-title">
      <div class="discover-feed-heading">
        <h3 id="discover-${feedKey}-title">${escapeHtml(label)}</h3>
        <span>${items.length} results</span>
      </div>
      <div class="discover-feed-row horizontal-scroll-row${items.length ? "" : " is-empty"}">
        ${items.length ? items.map((item) => renderMediaCard(item, {
          variant: "discover",
          compact: true,
          meta: "",
          releaseDate: item.release_date || item.first_air_date ? formatTmdbDate(item.release_date || item.first_air_date) : "",
          description: item.overview || "",
          showSource: false,
          menuMode: "discover",
          watchlisted: isWatchlisted(item),
        })).join("") : `<div class="empty-log discover-feed-empty"><b>${escapeHtml(emptyMessage.title)}</b><span>${escapeHtml(emptyMessage.detail)}</span></div>`}
      </div>
    </section>
  `;
}

export function renderDiscover() {
  const panel = elements.discoverPanel;
  if (!panel) return;
  syncGenreOptions();

  if (!state.token) {
    panel.innerHTML = "";
    return;
  }
  if (!Object.keys(state.discoverFeeds || {}).length) hydrateDiscoverCache();
  if (state.discoverLoading && !Object.keys(state.discoverFeeds || {}).length) {
    panel.innerHTML = `<div class="empty-log"><b>Loading Discover…</b></div>`;
    return;
  }
  if (state.discoverError && !Object.keys(state.discoverFeeds || {}).length) {
    const presentation = discoverErrorPresentation();
    panel.innerHTML = `<div class="empty-log" role="alert"><b>${escapeHtml(presentation.title)}</b><span>${escapeHtml(presentation.detail)}</span>${presentation.action}</div>`;
    return;
  }

  const feedEntries = Object.entries(state.discoverFeeds || {});
  feedEntries.sort(([a], [b]) => {
    if (a === "recommended") return -1;
    if (b === "recommended") return 1;
    return 0;
  });
  const feeds = feedEntries
    .map(([key, feed]) => renderFeed(key, feed))
    .filter(Boolean)
    .join("");
  panel.innerHTML = feeds || `<div class="empty-log"><b>No recommendations found</b><span>Try another type or genre.</span></div>`;
  hydratePosters(panel);
}

export async function loadDiscover({ force = false, fromSse = false } = {}) {
  if (!state.token) return;
  if (state.discoverLoading) {
    if (fromSse) state.discoverRefreshQueued = true;
    return;
  }
  if (!Object.keys(state.discoverFeeds || {}).length) hydrateDiscoverCache();
  if (!force && !fromSse && state.discoverLoadedAt && Date.now() - state.discoverLoadedAt < DISCOVER_TTL_MS && Object.keys(state.discoverFeeds || {}).length) {
    renderDiscover();
    return;
  }

  const requestVersion = state.discoverRequestVersion + 1;
  state.discoverRequestVersion = requestVersion;
  const controller = new AbortController();
  state.discoverAbortController = controller;
  state.discoverLoading = true;
  state.discoverError = "";
  state.discoverErrorCode = "";
  renderDiscover();
  const timeout = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({ mediaType: state.discoverMediaType || "all" });
    if (state.discoverGenreId) params.set("genre", state.discoverGenreId);
    if (force) params.set("refresh", "1");
    else params.set("revalidate", "1");
    const response = await fetch(`/api/discover?${params.toString()}`, {
      headers: buildAuthHeaders(state.token),
      cache: force ? "reload" : "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(body.error || `Discover load failed (${response.status})`);
      requestError.status = response.status;
      requestError.code = body.code || "";
      throw requestError;
    }
    if (requestVersion !== state.discoverRequestVersion) return;
    state.discoverFeeds = body.feeds && typeof body.feeds === "object" ? body.feeds : {};
    state.discoverLoadedAt = Date.now();
    persistDiscoverCache();
  } catch (error) {
    if (requestVersion !== state.discoverRequestVersion) return;
    state.discoverErrorCode = error?.name === "AbortError"
      ? "TIMEOUT"
      : error?.code || (Number(error?.status) === 404 ? "SERVER_ROUTE_MISSING" : "");
    state.discoverError = error?.name === "AbortError" ? "The request timed out." : (error.message || "Try again later.");
  } finally {
    clearTimeout(timeout);
    if (requestVersion === state.discoverRequestVersion) {
      state.discoverAbortController = null;
      state.discoverLoading = false;
      renderDiscover();
      const refreshQueued = state.discoverRefreshQueued;
      state.discoverRefreshQueued = false;
      if (refreshQueued && state.activeView === "discover") {
        Promise.resolve().then(() => loadDiscover({ fromSse: true })).catch(() => { });
      }
    }
  }
}
