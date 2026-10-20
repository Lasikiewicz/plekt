import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.6";
import {
  state, elements, explorerCardModeKey,
  EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS,
  EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS,
  HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS,
  HISTORY_VIEW_KEY, HISTORY_FILTER_KEY,
  HISTORY_VIEW_MODES, HISTORY_FILTERS,
} from "./state.js?v=2.1.1.0.6";
import {
  escapeHtml, escapeAttribute, slug, showTitleFrom, showName, tvShowBaseHrefFromEpisode,
  movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, platformBadge, sourceClass, sourceBadgeHtml, formatDate,
  computeProgress, sanitizeTitle, episodeTitle, episodeCode, appendRestInChunks,
} from "./utils.js?v=2.1.1.0.6";
import { posterMarkup, posterOverflowMenu, hydratePosters, bindPosterImageErrorHandler, tmdbPoster, tmdbProfile, proxiedArtworkUrl } from "./images.js?v=2.1.1.0.6";
import {
  historySyncPill, renderSyncStatusDot, renderMediaSyncPills,
  renderAvailabilityPills, renderShowAvailabilityPills, showAvailIssuePopup,
  isWatchedHistoryAction,
} from "./sync.js?v=2.1.1.0.6";
import { dedupeMediaRecords } from "./media-records.js?v=2.1.1.0.6";
import { isStaleExplorerPage } from "./explorer-page-cache.js?v=2.1.1.0.6";
import { renderMediaCard } from "./media-card.js?v=2.1.1.0.6";
import { renderDashboardHistoryPageCard } from "./dashboard.js?v=2.1.1.0.6";
import { cardArtAttribute } from "./card-art.js?v=2.1.1.0.6";
import { historyPosterOverlay } from "./history-poster-overlay.js?v=2.1.1.0.6";
import { nextAiringCell, nextAiringDateValue, mergeShowAiringMetadata, formatListDate, futureListDate } from "./stats.js?v=2.1.1.0.6";
// ---------------------------------------------------------------------------
// Callback injection - functions defined outside the 2636-4016 range in app.js
// ---------------------------------------------------------------------------
let _cb = {};
const searchResultsCache = new Map();
let searchRequestId = 0;
let searchPeopleRequestId = 0;
let searchCollectionRequestId = 0;
let historyViewLoadScrollElement = null;
let historyViewLoadScrollHandler = null;

function clearHistoryViewLoadWatchers() {
  state.historyViewLoadObserver?.disconnect();
  state.historyViewLoadObserver = undefined;
  if (historyViewLoadScrollElement && historyViewLoadScrollHandler) {
    historyViewLoadScrollElement.removeEventListener("scroll", historyViewLoadScrollHandler);
  }
  historyViewLoadScrollElement = null;
  historyViewLoadScrollHandler = null;
}
export function initExplorer(callbacks) {
  _cb = callbacks;
  initExplorerPosterScrollHydration();
  initExplorerEvents();
}

let explorerEventsInitialized = false;

function initExplorerEvents() {
  if (explorerEventsInitialized) return;
  explorerEventsInitialized = true;

  window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
    if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
  });

  elements.explorerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.explorerMode = button.dataset.explorerMode;
      renderExplorer();
      _cb.selectView?.("explorer");
    });
  });

  elements.explorerSort?.addEventListener("change", () => {
    setCurrentExplorerSort(elements.explorerSort.value || "title_asc");
    renderExplorer();
  });
  elements.explorerHideWatched?.addEventListener("change", () => {
    state.hideWatchedShows = elements.explorerHideWatched.checked;
    localStorage.setItem(HIDE_WATCHED_KEY_SHOWS, String(state.hideWatchedShows));
    renderExplorer();
  });
  elements.explorerHideEnded?.addEventListener("change", () => {
    state.hideEndedShows = elements.explorerHideEnded.checked;
    localStorage.setItem(HIDE_ENDED_KEY_SHOWS, String(state.hideEndedShows));
    renderExplorer();
  });
  elements.explorerSearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.explorerSearchTimer);
    state.explorerSearchTimer = window.setTimeout(() => {
      state.explorerSearch = elements.explorerSearchInput.value.trim();
      renderExplorer();
    }, 220);
  });
  elements.explorerPanel?.addEventListener("click", (event) => {
    const nextAirShowLink = event.target.closest(".next-air-card-view > a.explorer-list-show-card[data-show-href]");
    if (nextAirShowLink && elements.explorerPanel.contains(nextAirShowLink)) {
      // Next Airing cards are rendered on the Explorer route, where the
      // media-detail click delegate is not loaded. Keep the card a real link
      // for keyboard and modified-click behavior, and route plain clicks via
      // the SPA navigator.
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        _cb.navigateTo?.(nextAirShowLink.dataset.showHref || nextAirShowLink.href);
      }
      return;
    }
    const header = event.target.closest("[data-sort-key]");
    if (!header) return;
    applyListHeaderSort(header.dataset.sortKey);
  });
  elements.alphaFilterNav?.addEventListener("click", handleAlphaFilterClick);

  elements.historySearchInput?.addEventListener("input", () => {
    window.clearTimeout(state.historyViewSearchTimer);
    state.historyViewSearchTimer = window.setTimeout(() => {
      state.historyViewSearch = elements.historySearchInput.value.trim();
      renderHistoryView();
    }, 220);
  });
  const unlockHistorySearch = () => elements.historySearchInput?.removeAttribute("readonly");
  elements.historySearchInput?.addEventListener("pointerdown", unlockHistorySearch);
  elements.historySearchInput?.addEventListener("focus", unlockHistorySearch);

  for (const button of elements.historyFilterButtons || []) {
    button.addEventListener("click", () => {
      const filter = button.dataset.historyFilter || "all";
      if (!HISTORY_FILTERS.includes(filter) || filter === state.historyViewFilter) return;
      state.historyViewFilter = filter;
      localStorage.setItem(HISTORY_FILTER_KEY, filter);
      resetHistoryView([state.historyViewSearch, state.historyViewFilter].join("|"));
      renderHistoryView();
    });
  }

  for (const button of elements.historyViewButtons || []) {
    button.addEventListener("click", () => {
      const view = button.dataset.historyView || "grid";
      if (!HISTORY_VIEW_MODES.includes(view) || view === state.historyViewMode) return;
      state.historyViewMode = view;
      localStorage.setItem(HISTORY_VIEW_KEY, view);
      renderHistoryView();
    });
  }

  for (const button of elements.explorerViewButtons || []) {
    button.addEventListener("click", () => {
      const view = button.dataset.explorerView;
      if (!view || view === currentExplorerView()) return;
      if (state.explorerMode === "shows") {
        state.explorerViewShows = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_SHOWS, view);
        state.showsRaw = [];
        state.showsOffset = 0;
        state.showsHasMore = true;
        state.showsLoading = false;
      } else {
        state.explorerViewMovies = view;
        localStorage.setItem(EXPLORER_VIEW_KEY_MOVIES, view);
        state.moviesRaw = [];
        state.moviesOffset = 0;
        state.moviesHasMore = true;
        state.moviesLoading = false;
      }
      renderExplorer();
    });
  }
}

// hydratePosters() and observeExplorerTmdbPrefetch() both only look at the
// state of the DOM at render/pagination time, so a poster whose card was
// off-screen at that moment relies entirely on the TMDB-prefetch
// IntersectionObserver noticing it cross into view later. On a large,
// already-fully-rendered page that observer can miss cards during a fast or
// large scroll jump, leaving their poster stuck on the fallback placeholder
// indefinitely with no retry. A cheap debounced re-hydration pass on every
// scroll is a robust catch-all: hydratePosters() already skips anything not
// currently near the viewport and anything already resolved, so calling it
// repeatedly costs nothing beyond the DOM query when there's nothing to do.
let explorerScrollHydrationTimer = null;
function initExplorerPosterScrollHydration() {
  const scrollContainer = document.querySelector(".page-shell");
  if (!scrollContainer) return;
  scrollContainer.addEventListener("scroll", () => {
    if (explorerScrollHydrationTimer) return;
    explorerScrollHydrationTimer = window.setTimeout(() => {
      explorerScrollHydrationTimer = null;
      if (elements.explorerPanel?.isConnected) hydratePosters(elements.explorerPanel);
      if (elements.historyPanel?.isConnected) hydratePosters(elements.historyPanel);
    }, 150);
  }, { passive: true });
}
// ---------------------------------------------------------------------------
// Local auth helper
// ---------------------------------------------------------------------------
function authHeaders() {
  return buildAuthHeaders(state.token);
}
// ---------------------------------------------------------------------------
// Convenience wrappers that delegate to injected callbacks
// (keeps call-sites in this module identical to the original)
// ---------------------------------------------------------------------------
function setMessage(text, tone = "muted") {
  _cb.setMessage?.(text, tone);
}
function syncPageTopbar() {
  _cb.syncPageTopbar?.();
}
function cachedExplorerPage(key) {
  return _cb.cachedExplorerPage?.(key) ?? null;
}
function rememberExplorerPage(key, body) {
  _cb.rememberExplorerPage?.(key, body);
}
function fetchTmdbDetails(mediaType, tmdbId, title, ids, options) {
  return _cb.fetchTmdbDetails?.(mediaType, tmdbId, title, ids, options) ?? Promise.resolve(null);
}
function resolveEpisodeTitleFromTmdb(entry, el) {
  return _cb.resolveEpisodeTitleFromTmdb?.(entry, el);
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EXPLORER_PAGE_SIZE = 240;
const HISTORY_FIRST_PAINT_COUNT = 48; // more than a large screen shows at once
export const FILMOGRAPHY_PAGE_SIZE = 40;
// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------
let _explorerPrefetchObserver = null;
let _filmographyObserver = null;
let movieExplorerRenderKey = "";
let movieExplorerRenderedCount = 0;
let showExplorerRenderKey = "";
let showExplorerRenderedRecords = [];
export function getFilmographyObserver() { return _filmographyObserver; }
export function setFilmographyObserver(v) { _filmographyObserver = v; }
// ---------------------------------------------------------------------------
// syncExplorerControlsState / syncInlineMediaDetailHeading
// ---------------------------------------------------------------------------
export function syncExplorerControlsState() {
  const backBtn = document.querySelector("#explorerBackButton");
  const controls = elements.explorerTopbarControls || document.querySelector("#explorerTopbarControls");
  const heading = document.querySelector('[data-view-panel="explorer"] .explorer-heading-sticky');
  if (state.mediaDetailInline) {
    backBtn?.classList.remove("hidden");
    controls?.classList.add("hidden");
    heading?.classList.add("is-media-detail");
    syncInlineMediaDetailHeading(state.explorerMode);
  } else {
    backBtn?.classList.add("hidden");
    controls?.classList.remove("hidden");
    heading?.classList.remove("is-media-detail");
  }
}
export function syncInlineMediaDetailHeading(mode = state.explorerMode || "movies") {
  if (!state.mediaDetailInline) return;
  const normalized = mode === "shows" ? "shows" : "movies";
  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = normalized === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
  syncPageTopbar();
}
// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------
// Dedupe key for merging results from the local library, TMDB and TVDB. The
// three sources punctuate titles differently ("Star Trek: Picard" vs "Star Trek
// Picard"), so comparing raw lowercase strings lets the same show through twice.
function comparableTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTmdbSearchResult(item = {}, mediaTypeOverride = "") {
  const mediaType = mediaTypeOverride || item.media_type || (item.title ? "movie" : "tv");
  if (!item?.id || !["movie", "tv", "person", "collection"].includes(mediaType)) return null;
  if (mediaType === "collection") {
    const title = item.name || "Untitled collection";
    return {
      _type: "collection",
      id: item.id,
      title,
      poster: tmdbPoster(item.poster_path, item.id, "collection"),
      href: "",
      sub: `Collection${item.parts_count ? ` · ${item.parts_count} films` : ""} · TMDB`,
      overview: item.overview || "",
      isLocal: false,
      isCollection: true,
      source: "TMDB",
      mediaType: "collection",
    };
  }
  const title = item.title || item.name || "Unknown title";
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const overview = item.overview || (item.known_for
    ? `Known for: ${item.known_for.map((knownFor) => knownFor.title || knownFor.name).filter(Boolean).join(", ")}`
    : "");
  return {
    _type: mediaType === "person" ? "person" : (mediaType === "movie" ? "movie" : "show"),
    id: item.id,
    title,
    poster: mediaType === "person"
      ? (tmdbProfile(item.profile_path) || tmdbPoster(item.profile_path))
      : tmdbPoster(item.poster_path, item.id, mediaType),
    href: mediaType === "person" ? `/person/${item.id}` : (mediaType === "movie" ? movieTmdbHref(item.id, title) : tvShowTmdbHref(item.id, title)),
    sub: mediaType === "person" ? "Cast Member" : `${mediaType === "movie" ? "Movie" : "TV Show"}${year ? ` (${year})` : ""} - TMDB`,
    overview,
    isLocal: false,
    source: "TMDB",
    mediaType,
  };
}

function rememberSearchCache(query) {
  searchResultsCache.set(query, {
    results: state.searchResults,
    peoplePage: state.searchPeoplePage,
    peopleTotalPages: state.searchPeopleTotalPages,
    peopleTotalResults: state.searchPeopleTotalResults,
  });
}

export function triggerSearchPage(query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const requestId = ++searchRequestId;
  searchPeopleRequestId += 1;
  searchCollectionRequestId += 1;
  state.searchQuery = query;
  state.searchLoading = true;
  state.searchResults = [];
  state.searchPeoplePage = 1;
  state.searchPeopleTotalPages = 1;
  state.searchPeopleTotalResults = 0;
  state.searchPeopleLoading = false;
  state.searchPeopleError = "";
  state.searchCollectionDetails.clear();
  state.searchCollectionLoading.clear();
  syncPageTopbar();
  const loadingEl = document.getElementById("searchViewLoading");
  const emptyEl = document.getElementById("searchViewEmpty");
  const resultsEl = document.getElementById("searchViewResults");
  loadingEl?.classList.remove("hidden");
  emptyEl?.classList.add("hidden");
  if (resultsEl) resultsEl.innerHTML = "";
  const cachedResults = searchResultsCache.get(normalizedQuery);
  if (cachedResults) {
    const cached = Array.isArray(cachedResults) ? { results: cachedResults } : cachedResults;
    state.searchLoading = false;
    state.searchResults = cached.results || [];
    state.searchPeoplePage = Number(cached.peoplePage) || 1;
    state.searchPeopleTotalPages = Math.max(state.searchPeoplePage, Number(cached.peopleTotalPages) || 1);
    state.searchPeopleTotalResults = Number(cached.peopleTotalResults) || 0;
    renderSearchPage();
    return;
  }
  fetch(`/api/media-search?q=${encodeURIComponent(query)}&limit=100`, { headers: authHeaders() })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((body) => {
      if (requestId !== searchRequestId) return;
      state.searchLoading = false;
      const results = [];
      // Local Shows
      const localShows = body.local?.shows || [];
      for (const s of localShows) {
        const title = s.title || "";
        const slugTitle = slug(title);
        results.push({
          _type: "show",
          id: s.id,
          title,
          poster: s.poster_url || "",
          href: `/tvshow/${slugTitle}`,
          sub: "TV Show (Local)",
          overview: "",
          isLocal: true,
          mediaType: "tv"
        });
      }
      // Local Movies
      const localMovies = body.local?.movies || [];
      for (const m of localMovies) {
        const title = m.title || "";
        const slugTitle = slug(title);
        results.push({
          _type: "movie",
          id: m.id,
          title,
          poster: m.poster_url || "",
          href: movieHref(m),
          sub: "Movie (Local)",
          overview: "",
          isLocal: true,
          mediaType: "movie"
        });
      }
      // TMDB's mixed search only has 20 slots shared across movies, shows and
      // people. People are fetched separately from /search/person so they are
      // not limited to whichever few names happen to fit in that mixed page.
      const discovery = [
        ...(body.discovery?.results || []),
        ...(body.people?.results || []).map((item) => ({ ...item, media_type: "person" })),
      ];
      for (const item of discovery) {
        const normalized = normalizeTmdbSearchResult(item);
        if (!normalized) continue;
        const existing = results.find((result) => result.mediaType === normalized.mediaType && comparableTitle(result.title) === comparableTitle(normalized.title));
        if (existing) {
          if (!existing.overview && normalized.overview) {
            existing.overview = normalized.overview;
          }
          continue;
        }
        results.push(normalized);
      }
      for (const item of (body.collections?.results || [])) {
        const normalized = normalizeTmdbSearchResult(item, "collection");
        if (!normalized) continue;
        results.push(normalized);
      }
      // TVDB series results, searched alongside TMDB. Any series already listed
      // locally or by TMDB is dropped here so a show never appears twice.
      for (const item of (body.tvdb?.shows || [])) {
        const title = item.name || "";
        if (!title) continue;
        if (results.some((result) => result.mediaType === "tv" && comparableTitle(result.title) === comparableTitle(title))) continue;
        results.push({
          _type: "show",
          title,
          poster: proxiedArtworkUrl(item.image_url, "poster"),
          href: tvShowTvdbHref(item.tvdb_id, title),
          sub: `TV Show${item.year ? ` · ${item.year}` : ""} · TVDB`,
          overview: "",
          isLocal: false,
          source: "TVDB",
          mediaType: "tv"
        });
      }
      // Prioritize actor matching query at the top, then whatever is on a
      // connected media server ahead of TMDB/TVDB-only matches.
      const qLower = query.toLowerCase();
      results.sort((a, b) => {
        const aIsPersonMatch = a.mediaType === "person" && a.title.toLowerCase() === qLower;
        const bIsPersonMatch = b.mediaType === "person" && b.title.toLowerCase() === qLower;
        if (aIsPersonMatch && !bIsPersonMatch) return -1;
        if (!aIsPersonMatch && bIsPersonMatch) return 1;
        const aIsPersonPartial = a.mediaType === "person" && a.title.toLowerCase().includes(qLower);
        const bIsPersonPartial = b.mediaType === "person" && b.title.toLowerCase().includes(qLower);
        if (aIsPersonPartial && !bIsPersonPartial) return -1;
        if (!aIsPersonPartial && bIsPersonPartial) return 1;
        if (a.isLocal && !b.isLocal) return -1;
        if (!a.isLocal && b.isLocal) return 1;
        return 0; // Maintain original order
      });
      state.searchResults = results;
      state.searchPeoplePage = Number(body.people?.page) || 1;
      state.searchPeopleTotalPages = Math.max(state.searchPeoplePage, Number(body.people?.total_pages) || 1);
      state.searchPeopleTotalResults = Number(body.people?.total_results) || 0;
      rememberSearchCache(normalizedQuery);
      renderSearchPage();
    })
    .catch((error) => {
      if (requestId !== searchRequestId) return;
      state.searchLoading = false;
      console.error("Search failed", error);
      loadingEl?.classList.add("hidden");
      emptyEl?.classList.remove("hidden");
      if (emptyEl) emptyEl.textContent = `Search failed: ${error.message}`;
    });
}

export function loadMoreSearchPeople() {
  const query = String(state.searchQuery || "").trim();
  const normalizedQuery = query.toLowerCase();
  const nextPage = Number(state.searchPeoplePage || 1) + 1;
  if (!query || state.searchPeopleLoading || nextPage > Number(state.searchPeopleTotalPages || 1)) return;

  const requestId = ++searchPeopleRequestId;
  state.searchPeopleLoading = true;
  state.searchPeopleError = "";
  renderSearchPage();

  fetch(`/api/tmdb-search?query=${encodeURIComponent(query)}&mediaType=person&page=${nextPage}`, { headers: authHeaders() })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((body) => {
      if (requestId !== searchPeopleRequestId || normalizedQuery !== String(state.searchQuery || "").trim().toLowerCase()) return;
      const existingPeople = new Set(
        state.searchResults
          .filter((result) => result.mediaType === "person")
          .map((result) => result.id != null ? `id:${result.id}` : `title:${comparableTitle(result.title)}`),
      );
      for (const item of (body.results || [])) {
        const normalized = normalizeTmdbSearchResult(item, "person");
        if (!normalized) continue;
        const key = normalized.id != null ? `id:${normalized.id}` : `title:${comparableTitle(normalized.title)}`;
        if (existingPeople.has(key)) continue;
        existingPeople.add(key);
        state.searchResults.push(normalized);
      }
      state.searchPeoplePage = Number(body.page) || nextPage;
      state.searchPeopleTotalPages = Math.max(state.searchPeoplePage, Number(body.total_pages) || state.searchPeopleTotalPages);
      state.searchPeopleTotalResults = Number(body.total_results) || state.searchPeopleTotalResults;
      state.searchPeopleLoading = false;
      rememberSearchCache(normalizedQuery);
      renderSearchPage();
    })
    .catch((error) => {
      if (requestId !== searchPeopleRequestId) return;
      state.searchPeopleLoading = false;
      state.searchPeopleError = error.message || "Unable to load more people";
      renderSearchPage();
    });
}

export function loadSearchCollection(collectionId) {
  const id = String(collectionId || "").trim();
  if (!id || state.searchCollectionLoading.has(id)) return;
  if (state.searchCollectionDetails.has(id)) {
    state.searchCollectionDetails.delete(id);
    renderSearchPage();
    return;
  }

  state.searchCollectionLoading.add(id);
  const requestId = searchCollectionRequestId;
  renderSearchPage();
  fetch(`/api/tmdb-collection?id=${encodeURIComponent(id)}`, { headers: authHeaders() })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Collection load failed (${response.status})`);
      if (requestId !== searchCollectionRequestId) return;
      state.searchCollectionDetails.set(id, body);
    })
    .catch((error) => {
      if (requestId === searchCollectionRequestId) setMessage(error.message, "error");
    })
    .finally(() => {
      if (requestId !== searchCollectionRequestId) return;
      state.searchCollectionLoading.delete(id);
      renderSearchPage();
    });
}

function renderSearchPeoplePager() {
  const canLoadMore = Number(state.searchPeoplePage || 1) < Number(state.searchPeopleTotalPages || 1);
  if (!canLoadMore && !state.searchPeopleError) return "";
  const peopleShown = (state.searchResults || []).filter((result) => result.mediaType === "person").length;
  const totalLabel = state.searchPeopleTotalResults
    ? `<span class="search-people-count">Showing ${peopleShown.toLocaleString()} of ${Number(state.searchPeopleTotalResults).toLocaleString()} people</span>`
    : "";
  const errorLabel = state.searchPeopleError
    ? `<span class="search-people-error" role="status">${escapeHtml(state.searchPeopleError)}</span>`
    : "";
  return `
    <div class="search-people-pager">
      ${totalLabel}
      <button class="button-ghost search-load-more-people" type="button" data-search-load-more-people ${state.searchPeopleLoading ? "disabled" : ""}>
        ${state.searchPeopleLoading ? "Loading people…" : "Load more people"}
      </button>
      ${errorLabel}
    </div>
  `;
}

export function renderSearchPage() {
  syncPageTopbar();
  const loadingEl = document.getElementById("searchViewLoading");
  const emptyEl = document.getElementById("searchViewEmpty");
  const resultsEl = document.getElementById("searchViewResults");
  if (state.searchLoading) {
    loadingEl?.classList.remove("hidden");
    emptyEl?.classList.add("hidden");
    if (resultsEl) resultsEl.innerHTML = "";
    return;
  }
  loadingEl?.classList.add("hidden");
  const allResults = state.searchResults || [];
  if (!allResults.length) {
    emptyEl?.classList.remove("hidden");
    if (resultsEl) resultsEl.innerHTML = "";
    return;
  }
  emptyEl?.classList.add("hidden");
  const renderCard = (r) => {
    const posterHtml = r.isLocal
      ? posterMarkup({ id: r.id, poster_url: r.poster, title: r.title }, "overview-thumb-poster")
      : (r.poster
        ? `<img src="${escapeAttribute(r.poster)}" alt="${escapeAttribute(r.title)} poster" class="overview-thumb-poster poster-img search-result-poster" loading="lazy" decoding="async" fetchpriority="auto" referrerpolicy="no-referrer">`
        : `<span class="overview-thumb-poster poster-fallback" aria-hidden="true"></span>`);
    const badgesHtml = r.isLocal
      ? `<span class="status-pill status-success" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">Local</span>`
      : `<span class="status-pill status-muted" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">${escapeHtml(r.source || "TMDB")}</span>`;
    const collectionId = r.isCollection ? String(r.id) : "";
    const collectionDetail = collectionId ? state.searchCollectionDetails.get(collectionId) : null;
    const collectionLoading = collectionId && state.searchCollectionLoading.has(collectionId);
    const collectionParts = Array.isArray(collectionDetail?.parts) ? collectionDetail.parts : [];
    const collectionPartsHtml = collectionDetail
      ? `<div class="search-collection-parts">
          ${collectionParts.length
            ? collectionParts.map((part) => renderMediaCard({
              ...part,
              id: `tmdb:movie:${part.id}`,
              tmdb_id: part.id,
              media_type: "movie",
              source: "TMDB",
              title: part.title || part.name,
              poster_path: part.poster_path,
            }, {
              variant: "collection-part",
              compact: true,
              meta: String(part.release_date || "").slice(0, 4),
              description: part.overview || "",
              showSource: false,
              badge: part.is_watched || (state.history || []).some((history) => (
                history.media_type === "movie" && String(history.tmdb_id || "") === String(part.id)
              )) ? "Watched" : "Film",
            })).join("")
            : `<div class="gsd-column-empty">No films found in this collection.</div>`}
        </div>`
      : "";
    const collectionToggle = r.isCollection
      ? `<button class="button-ghost search-collection-toggle" type="button" data-search-collection="${escapeAttribute(collectionId)}" ${collectionLoading ? "disabled" : ""}>${collectionLoading ? "Loading films…" : (collectionDetail ? "Hide films" : "Show films")}</button>`
      : "";
    return `
      <article class="explorer-overview-card${r.isCollection ? " search-collection-card" : ""}" data-href="${escapeAttribute(r.href)}">
        <div class="search-card-art">
          ${posterHtml}
        </div>
        <div class="overview-card-meta">
          <div class="overview-card-header">
            <b style="font-size: 0.95rem; font-weight: 800;">${escapeHtml(r.title)}</b>
            <div class="overview-card-badges">
              ${badgesHtml}
            </div>
          </div>
          <div class="overview-card-attrs">${escapeHtml(r.sub)}</div>
          <div class="overview-card-text-wrap"><p class="overview-card-text" style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-top: 0.25rem;">${escapeHtml(r.overview || "No synopsis available.")}</p></div>
          ${collectionToggle}
          ${collectionPartsHtml}
        </div>
      </article>
    `;
  };
  if (state.searchFilter === "all") {
    const movies = allResults.filter(r => r.mediaType === "movie");
    const shows = allResults.filter(r => r.mediaType === "tv");
    const people = allResults.filter(r => r.mediaType === "person");
    const collections = allResults.filter(r => r.mediaType === "collection");
    if (resultsEl) {
      resultsEl.className = "search-results-view";
      resultsEl.innerHTML = `
        <div class="search-columns">
          <div class="search-column">
            <h3 class="search-column-title">Movies (${movies.length})</h3>
            <div class="search-column-grid">
              ${movies.length ? movies.map(renderCard).join("") : '<div class="gsd-column-empty">No matching movies</div>'}
            </div>
          </div>
          <div class="search-column">
            <h3 class="search-column-title">TV Shows (${shows.length})</h3>
            <div class="search-column-grid">
              ${shows.length ? shows.map(renderCard).join("") : '<div class="gsd-column-empty">No matching TV shows</div>'}
            </div>
          </div>
          <div class="search-column">
            <h3 class="search-column-title">People (${people.length})</h3>
            <div class="search-column-grid">
              ${people.length ? people.map(renderCard).join("") : '<div class="gsd-column-empty">No matching people</div>'}
              ${renderSearchPeoplePager()}
            </div>
          </div>
          <div class="search-column">
            <h3 class="search-column-title">Collections (${collections.length})</h3>
            <div class="search-column-grid">
              ${collections.length ? collections.map(renderCard).join("") : '<div class="gsd-column-empty">No matching collections</div>'}
            </div>
          </div>
        </div>
      `;
    }
  } else {
    let filtered = allResults;
    if (state.searchFilter === "movies") {
      filtered = allResults.filter((r) => r.mediaType === "movie");
    } else if (state.searchFilter === "shows") {
      filtered = allResults.filter((r) => r.mediaType === "tv");
    } else if (state.searchFilter === "people") {
      filtered = allResults.filter((r) => r.mediaType === "person");
    } else if (state.searchFilter === "collections") {
      filtered = allResults.filter((r) => r.mediaType === "collection");
    }
    if (!filtered.length) {
      emptyEl?.classList.remove("hidden");
      if (resultsEl) resultsEl.innerHTML = "";
      return;
    }
    if (resultsEl) {
      resultsEl.className = "search-results-view explorer-overview-view";
      resultsEl.innerHTML = `${filtered.map(renderCard).join("")}${state.searchFilter === "people" ? renderSearchPeoplePager() : ""}`;
    }
  }
  if (resultsEl) {
    hydratePosters(resultsEl);
    for (const image of resultsEl.querySelectorAll("img.search-result-poster")) {
      bindPosterImageErrorHandler(image);
    }
  }
}
// ---------------------------------------------------------------------------
// Explorer top-level render
// ---------------------------------------------------------------------------
// The posters-only toggle is remembered per library (Movies, TV Shows).
function syncExplorerCardMode() {
  const nextAirListLocked = state.explorerMode === "shows" && state.explorerSortShows === "next_air_asc";
  let compact = false;
  try { compact = localStorage.getItem(explorerCardModeKey(state.explorerMode)) === "1"; } catch { /* storage unavailable */ }
  compact = compact && !nextAirListLocked;
  document.querySelector('#explorer-view-root, [data-view-panel="explorer"]')?.classList.toggle("page-card-mode-compact", compact);
  document.querySelectorAll('[data-card-mode-toggle="explorer"]').forEach((button) => {
    const label = compact ? "Show full cards" : "Show poster view";
    button.setAttribute("aria-pressed", String(compact));
    button.setAttribute("aria-label", label);
    button.title = label;
    const labelNode = button.querySelector(".page-card-mode-label");
    if (labelNode) labelNode.textContent = label;
    button.classList.toggle("hidden", nextAirListLocked);
  });
  document.querySelectorAll('[data-card-mode-select="explorer"]').forEach((input) => {
    input.checked = input.dataset.cardMode === (compact ? "posters" : "full");
  });
  document.querySelectorAll(".mobile-card-mode-options").forEach((group) => {
    group.classList.toggle("hidden", nextAirListLocked);
  });
}

export function renderExplorer() {
  syncExplorerControlsState();
  if (state.mediaDetailInline) return;
  for (const button of elements.explorerButtons) {
    button.classList.toggle("active", button.dataset.explorerMode === state.explorerMode);
  }
  syncExplorerCardMode();
  const activeView = currentExplorerView();
  const lockNextAirList = state.explorerMode === "shows" && state.explorerSortShows === "next_air_asc";
  for (const button of elements.explorerViewButtons || []) {
    const isActive = button.dataset.explorerView === activeView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  const viewToggle = elements.explorerViewButtons?.[0]?.closest(".explorer-view-toggle");
  viewToggle?.classList.toggle("hidden", lockNextAirList);
  if (elements.explorerSort) {
    const sort = currentExplorerSort();
    elements.explorerSort.value = sort;
    // Only show "Next Airing" option for shows
    for (const opt of elements.explorerSort.options) {
      if (opt.value === "next_air_asc") opt.hidden = state.explorerMode !== "shows";
    }
  }
  const isShows = state.explorerMode === "shows";
  if (elements.explorerHideWatchedLabel) {
    elements.explorerHideWatchedLabel.style.display = isShows ? "" : "none";
  }
  if (elements.explorerHideEndedLabel) {
    elements.explorerHideEndedLabel.style.display = isShows ? "" : "none";
  }
  if (elements.explorerHideWatched) {
    elements.explorerHideWatched.checked = state.hideWatchedShows;
  }
  if (elements.explorerHideEnded) {
    elements.explorerHideEnded.checked = state.hideEndedShows;
  }
  if (elements.explorerTitle) {
    const mode = state.mediaDetailInline && state.activeShowModalKey ? "shows" : state.explorerMode;
    elements.explorerTitle.textContent = mode === "shows" ? "TV Shows" : "Movies";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = state.mediaDetailInline ? "" : (state.savedConfig?.plex?.username || "Watched history library");
  }
  syncPageTopbar();
  const search = elements.explorerSearchInput ? elements.explorerSearchInput.value.trim() : state.explorerSearch;
  state.explorerSearch = search;
  if (state.mediaDetailInline) {
    return;
  }
  if (state.explorerMode === "movies") {
    renderMovieExplorer();
    return;
  }
  renderShowExplorer();
}
export function explorerQueryKey(mode) {
  if (mode === "shows") {
    return [mode, currentExplorerSort(), state.explorerSearch, shouldHideWatchedShows(), state.hideEndedShows].join("|");
  }
  return [mode, currentExplorerSort(), state.explorerSearch].join("|");
}
export function shouldHideWatchedShows(search = state.explorerSearch, hideWatched = state.hideWatchedShows) {
  return Boolean(hideWatched && !String(search || "").trim());
}
// ---------------------------------------------------------------------------
// Alpha filter
// ---------------------------------------------------------------------------
function firstAlphaLetter(title) {
  if (!title) return "#";
  const stripped = String(title).replace(/^(the |a |an )/i, "").trim();
  const ch = stripped.charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}
const ALPHA_LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];
export function isAlphabeticalExplorerSort(sortMode = currentExplorerSort()) {
  return sortMode === "title_asc" || sortMode === "title_desc";
}
export function updateAlphaFilter() {
  const nav = elements.alphaFilterNav;
  if (!nav) return;
  if (state.mediaDetailInline || state.activeView !== "explorer" || !isAlphabeticalExplorerSort()) {
    nav.classList.add("hidden");
    return;
  }
  const items = state.explorerMode === "movies" ? state.moviesRaw : state.showsRaw;
  const hasItems = items.length > 0;
  nav.classList.toggle("hidden", !hasItems);
  if (!hasItems) return;
  const hasMore = state.explorerMode === "movies" ? state.moviesHasMore : state.showsHasMore;
  const loaded = new Set(items.map((it) => firstAlphaLetter(it.title)));
  nav.innerHTML = ALPHA_LETTERS.map((letter) => {
    const definitivelyEmpty = !hasMore && !loaded.has(letter);
    return `<button class="${definitivelyEmpty ? "alpha-empty" : ""}" data-alpha="${letter}" title="${letter === "#" ? "Numbers / symbols" : letter}" ${definitivelyEmpty ? "disabled" : ""}>${letter}</button>`;
  }).join("");
}
let alphaScrolling = false;
export async function handleAlphaFilterClick(e) {
  const btn = e.target.closest("[data-alpha]");
  if (!btn || btn.disabled || alphaScrolling) return;
  const letter = btn.dataset.alpha;
  const panel = elements.explorerPanel;
  const nav = elements.alphaFilterNav;
  if (!panel || !nav) return;
  for (const b of nav.querySelectorAll("[data-alpha]")) b.classList.remove("alpha-current");
  btn.classList.add("alpha-current");
  function scrollToTarget(el) {
    const pageShell = document.querySelector(".page-shell");
    if (!pageShell) return;
    const headingEl = elements.pageTopbar || document.querySelector(".page-topbar");
    const relativeTop = el.getBoundingClientRect().top - pageShell.getBoundingClientRect().top;
    const isSticky = headingEl ? window.getComputedStyle(headingEl).position === "sticky" : false;
    const headingHeight = (headingEl && isSticky) ? headingEl.offsetHeight : 0;
    const targetScrollTop = pageShell.scrollTop + relativeTop - headingHeight - 8;
    pageShell.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  }
  let target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
  if (target) {
    scrollToTarget(target);
    return;
  }
  alphaScrolling = true;
  try {
    const mode = state.explorerMode;
    const loadFn = mode === "movies" ? loadExplorerMovies : loadExplorerShows;
    const hasMore = () => (mode === "movies" ? state.moviesHasMore : state.showsHasMore);
    while (hasMore() && !panel.querySelector(`[data-alpha-letter="${letter}"]`)) {
      await loadFn();
    }
    target = panel.querySelector(`[data-alpha-letter="${letter}"]`);
    if (target) {
      scrollToTarget(target);
    } else {
      btn.classList.remove("alpha-current");
      btn.classList.add("alpha-empty");
      btn.disabled = true;
    }
  } finally {
    alphaScrolling = false;
  }
}
// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------
export function resetMovieExplorer(key = explorerQueryKey("movies")) {
  state.moviesRequestVersion += 1;
  state.moviesRaw = [];
  state.moviesOffset = 0;
  state.moviesHasMore = true;
  state.moviesLoading = false;
  state.moviesQueryKey = key;
  state.explorerScrollArmed = false;
  movieExplorerRenderKey = "";
  movieExplorerRenderedCount = 0;
}
export function resetShowExplorer(key = explorerQueryKey("shows")) {
  state.showsRequestVersion += 1;
  state.showsRaw = [];
  state.showsOffset = 0;
  state.showsHasMore = true;
  state.showsLoading = false;
  state.showsQueryKey = key;
  state.explorerScrollArmed = false;
  showExplorerRenderKey = "";
  showExplorerRenderedRecords = [];
}

function isCurrentExplorerRoute(mode) {
  return state.activeView === "explorer"
    && state.explorerMode === mode
    && !state.mediaDetailInline;
}
// ---------------------------------------------------------------------------
// Scroll sentinel
// ---------------------------------------------------------------------------
export function renderExplorerSentinel(mode, hasMore, loading) {
  if (!hasMore && !loading) return "";
  return `
    <div class="explorer-scroll-sentinel" data-explorer-sentinel="${mode}" aria-live="polite" role="status">
      <span>${loading ? '<span class="explorer-loading-indicator"><span class="empty-log-spinner empty-log-spinner--inline" aria-hidden="true"></span>Loading more…</span>' : ""}</span>
    </div>
  `;
}
export function observeExplorerSentinel(mode) {
  state.explorerLoadObserver?.disconnect();
  state.explorerLoadObserver = undefined;
  const sentinel = elements.explorerPanel?.querySelector(`[data-explorer-sentinel="${mode}"]`);
  if (!sentinel || !("IntersectionObserver" in window)) return;
  state.explorerLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!state.explorerScrollArmed) return;
      if (mode === "movies") loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
      if (mode === "shows") loadExplorerShows().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "1200px 0px 1200px 0px" },
  );
  state.explorerLoadObserver.observe(sentinel);
}
// ---------------------------------------------------------------------------
// TMDB prefetch observer
// ---------------------------------------------------------------------------
export function observeExplorerTmdbPrefetch(container) {
  _explorerPrefetchObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;
  _explorerPrefetchObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const mediaType = el.dataset.prefetchType;
        const tmdbId = el.dataset.prefetchTmdb;
        const title = el.dataset.prefetchTitle;
        // Every view needs the metadata: list (dates, runtime, eps), overview and
        // the default cards view (the summary), so each card makes one light,
        // cached request. The cards view's summary reuses [data-overview-text].
        const needsMeta = ["list", "overview", "posters"].includes(currentExplorerView());
        const needsPoster = !!el.querySelector(".poster-fallback[data-poster-id]");
        if (!needsMeta && !needsPoster) {
          _explorerPrefetchObserver?.unobserve(el);
          continue;
        }
        if (mediaType && title) {
          if (state.token) {
            // Grid prefetch is a "light" request: on cold items the server
            // skips next-airing/artwork enrichment (the scheduler completes
            // those later) so scrolling a large library stays cheap.
            fetchTmdbDetails(mediaType, tmdbId || undefined, title, undefined, { light: true }).then((data) => {
              if (!el.isConnected) return;
              if (data?.id && el.dataset.partWatchedMediaKey) {
                const progressEntry = state.partWatchedRaw.find((item) => item.media_key === el.dataset.partWatchedMediaKey);
                if (progressEntry && !progressEntry.tmdb_id) progressEntry.tmdb_id = String(data.id);
              }
              if (data?.poster_path) {
                const posterUrl = tmdbPoster(data.poster_path);
                if (posterUrl) {
                  const fallback = el.querySelector(".poster-fallback[data-poster-id]");
                  if (fallback) {
                    const posterId = fallback.dataset.posterId;
                    state.posterLookupCache.set(posterId, posterUrl);
                    const img = document.createElement("img");
                    img.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
                    img.src = posterUrl;
                    img.alt = title;
                    img.loading = "lazy";
                    img.decoding = "async";
                    img.referrerPolicy = "no-referrer";
                    img.dataset.posterId = posterId;
                    fallback.replaceWith(img);
                  }
                }
              }
              if (currentExplorerView() === "list" && data) {
                const isMovie = mediaType === "movie";
                const releaseEl = el.querySelector("[data-list-release]");
                if (releaseEl && !releaseEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) releaseEl.textContent = formatListDate(raw);
                }
                const yearEl = el.querySelector("[data-list-year]");
                if (yearEl && !yearEl.textContent.trim()) {
                  const raw = isMovie ? data.release_date : data.first_air_date;
                  if (raw) yearEl.textContent = raw.slice(0, 4);
                }
                if (isMovie) {
                  const runtimeEl = el.querySelector("[data-list-runtime]");
                  if (runtimeEl && !runtimeEl.textContent.trim() && data.runtime) {
                    runtimeEl.textContent = `${data.runtime} min`;
                  }
                } else {
                  const nextAirEl = el.querySelector("[data-list-next-air]");
                  if (nextAirEl && !nextAirEl.textContent.trim()) {
                    const nextAiring = nextAiringCell(data);
                    if (nextAiring.text) {
                      nextAirEl.textContent = nextAiring.text;
                      nextAirEl.classList.toggle("list-next-air-status", nextAiring.isStatus);
                    }
                  }
                  const epsEl = el.querySelector("[data-list-eps]");
                  if (epsEl && data.number_of_episodes) {
                    const watched = parseInt(epsEl.dataset.watched || "0") || 0;
                    const total = data.number_of_episodes;
                    const pct = Math.round((watched / total) * 100);
                    epsEl.dataset.total = String(total);
                    epsEl.outerHTML = `<div class="list-eps-progress" data-list-eps data-watched="${watched}" data-total="${total}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${watched} / ${total}</span></div>`;
                  }
                  const seasonCountEl = el.querySelector("[data-list-season-count]");
                  const seasonCount = regularTmdbSeasonCount(data);
                  if (seasonCountEl && seasonCount) seasonCountEl.textContent = String(seasonCount);
                }
              }
              const progressPill = el.querySelector(".show-progress-bar-attached");
              if (progressPill && data?.number_of_episodes) {
                const watched = parseInt(progressPill.dataset.watched || "0") || 0;
                const total = data.number_of_episodes;
                progressPill.dataset.total = String(total);
                progressPill.textContent = `${watched}/${total} Watched`;
              }
              if (state.explorerSortShows === "next_air_asc" && mediaType === "tv") {
                scheduleNextAirResort();
              }
              if ((currentExplorerView() === "overview" || currentExplorerView() === "posters") && data) {
                const attrsEl = el.querySelector("[data-overview-attrs]");
                const textEl = el.querySelector("[data-overview-text]");
                if (attrsEl && !attrsEl.textContent.trim()) {
                  const isMovie = mediaType === "movie";
                  const year = isMovie ? data.release_date?.slice(0, 4) : data.first_air_date?.slice(0, 4);
                  const genres = data.genres?.slice(0, 3).map((g) => g.name).join(" · ") || "";
                  const parts = [year, genres].filter(Boolean);
                  attrsEl.textContent = parts.join(" · ");
                }
                if (textEl && !textEl.textContent.trim() && data.overview) {
                  textEl.textContent = data.overview;
                }
              }
            }).catch(() => { });
            _explorerPrefetchObserver?.unobserve(el);
          }
        } else {
          _explorerPrefetchObserver?.unobserve(el);
        }
      }
    },
    { rootMargin: "200px 0px 200px 0px" },
  );
  for (const el of container.querySelectorAll("[data-prefetch-type]")) {
    _explorerPrefetchObserver.observe(el);
  }
}
// ---------------------------------------------------------------------------
// Next-air resort scheduler
// ---------------------------------------------------------------------------
let _nextAirResortTimer = null;
export function scheduleNextAirResort() {
  clearTimeout(_nextAirResortTimer);
  _nextAirResortTimer = setTimeout(() => {
    if (state.explorerSortShows === "next_air_asc" && state.explorerMode === "shows") renderShowExplorer();
  }, 600);
}
// ---------------------------------------------------------------------------
// View / sort helpers
// ---------------------------------------------------------------------------
export function currentExplorerView() {
  if (state.explorerMode === "shows" && state.explorerSortShows === "next_air_asc") return "list";
  if (window.matchMedia("(max-width: 760px)").matches) return "posters";
  return state.explorerMode === "shows" ? state.explorerViewShows : state.explorerViewMovies;
}
export function currentExplorerSort() {
  return state.explorerMode === "shows" ? state.explorerSortShows : state.explorerSortMovies;
}
export function setCurrentExplorerSort(value) {
  if (state.explorerMode === "shows") {
    state.explorerSortShows = value;
    localStorage.setItem(EXPLORER_SORT_KEY_SHOWS, value);
  } else {
    state.explorerSortMovies = value;
    localStorage.setItem(EXPLORER_SORT_KEY_MOVIES, value);
  }
}
function explorerGridClass(isShows = false) {
  const base = isShows ? "movie-grid explorer-show-grid" : "movie-grid";
  const view = currentExplorerView();
  if (view === "list") return `explorer-list-view ${isShows ? "shows-list" : "movies-list"}${isShows && state.explorerSortShows === "next_air_asc" ? " next-air-card-view" : ""}`;
  if (view === "overview") return "explorer-overview-view";
  return base;
}
function sortArrow(colKey) {
  const s = currentExplorerSort();
  if (s === `${colKey}_asc`) return `<span class="sort-arrow">↑</span>`;
  if (s === `${colKey}_desc`) return `<span class="sort-arrow">↓</span>`;
  return "";
}
export function applyListHeaderSort(key) {
  if (key === "next_air") {
    setCurrentExplorerSort("next_air_asc");
    if (elements.explorerSort) elements.explorerSort.value = currentExplorerSort();
    if (state.explorerMode === "shows") {
      state.showsRaw = []; state.showsOffset = 0; state.showsHasMore = true; state.showsLoading = false;
    }
    renderExplorer();
    return;
  }
  const asc = `${key}_asc`, desc = `${key}_desc`;
  setCurrentExplorerSort(currentExplorerSort() === asc ? desc : asc);
  if (elements.explorerSort) elements.explorerSort.value = currentExplorerSort();
  if (state.explorerMode === "shows") {
    state.showsRaw = []; state.showsOffset = 0; state.showsHasMore = true; state.showsLoading = false;
  } else {
    state.moviesRaw = []; state.moviesOffset = 0; state.moviesHasMore = true; state.moviesLoading = false;
  }
  renderExplorer();
}
export function resolvedTmdbCache(mediaType, tmdbId, title) {
  if (!tmdbId && !title) return null;
  const baseKey = `${mediaType}|${tmdbId || ""}|${String(title || "").toLowerCase()}`;
  const keys = [baseKey, `${baseKey}||`];
  for (const key of keys) {
    const cached = state.tmdbDetailsCache.get(key);
    if (cached && typeof cached.then !== "function") return cached;
  }
  return null;
}
function regularTmdbSeasonCount(details = {}) {
  const regularSeasons = Array.isArray(details?.seasons)
    ? details.seasons.filter((season) => Number(season.season_number ?? season.season) > 0).length
    : 0;
  const count = regularSeasons || Number(details?.number_of_seasons || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
// ---------------------------------------------------------------------------
// Rewatch badge - shown wherever a card/row has more than one actual watch.
// Dashboard preview rows carry watch_count rather than the full playHistory;
// detail/history rows carry the full list.
// ---------------------------------------------------------------------------
function actualWatchCount(entry = {}) {
  const explicit = Number(entry.watch_count ?? entry.total_watches);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const historyCount = Array.isArray(entry.playHistory) ? entry.playHistory.length : 0;
  return historyCount || (entry.watched_at ? 1 : 0);
}

function rewatchBadge(entry) {
  const count = actualWatchCount(entry);
  if (count < 2) return "";
  return `<span class="rewatch-badge" title="${count} actual watches">&#8635; &times;${count}</span>`;
}
// ---------------------------------------------------------------------------
// Movie cards
// ---------------------------------------------------------------------------
export function renderMovieCard(movie) {
  if (currentExplorerView() === "list") return renderMovieListCard(movie);
  if (currentExplorerView() === "overview") return renderMovieOverviewCard(movie);
  const attributes = ` data-alpha-letter="${escapeAttribute(firstAlphaLetter(movie.title))}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}"`;
  return renderDashboardHistoryPageCard({ ...movie, media_type: "movie" }, {
    explorer: true, explorerSummary: resolvedTmdbCache("movie", movie.tmdb_id, movie.title)?.overview || "",
    explorerClass: "movie-card",
    explorerAttributes: attributes,
    explorerHref: movieHref(movie),
  });
}

function commitMovieExplorerHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const nextGrid = template.content.firstElementChild;
  const currentGrid = elements.explorerPanel.firstElementChild;

  // Preserve mounted cards (and therefore decoded poster images) across data
  // refreshes. Replacing the entire panel made every visible poster disappear
  // briefly while the browser rebuilt and repainted an otherwise identical
  // grid. A different view/layout still takes the normal full-render path.
  if (
    nextGrid
    && currentGrid
    && nextGrid.className === currentGrid.className
    && (nextGrid.matches(".movie-grid, .explorer-list-view, .explorer-overview-view"))
  ) {
    const currentCards = new Map(
      [...currentGrid.querySelectorAll(":scope > .movie-card[data-history-id]")]
        .map((card) => [card.dataset.historyId, card]),
    );
    for (const nextCard of [...nextGrid.querySelectorAll(":scope > .movie-card[data-history-id]")]) {
      const currentCard = currentCards.get(nextCard.dataset.historyId);
      const currentPoster = currentCard?.querySelector("img");
      const nextPoster = nextCard.querySelector("img");
      if (currentPoster && nextPoster) nextPoster.replaceWith(currentPoster);
    }
    currentGrid.replaceChildren(...nextGrid.childNodes);
    nextGrid.remove();
    elements.explorerPanel.replaceChildren(currentGrid, ...template.content.childNodes);
    return;
  }

  elements.explorerPanel.replaceChildren(...template.content.childNodes);
}

function syncMovieExplorerSentinel() {
  const current = elements.explorerPanel.querySelector('[data-explorer-sentinel="movies"]');
  const html = renderExplorerSentinel("movies", state.moviesHasMore, state.moviesLoading);
  if (!html) {
    current?.remove();
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const next = template.content.firstElementChild;
  if (current) current.replaceWith(next);
  else elements.explorerPanel.append(next);
}

function movieExplorerCanAppend(viewKey) {
  if (movieExplorerRenderKey !== viewKey || !movieExplorerRenderedCount) return false;
  if (state.moviesRaw.length <= movieExplorerRenderedCount) return false;
  const currentGrid = elements.explorerPanel.firstElementChild;
  if (!currentGrid || currentGrid.className !== explorerGridClass()) return false;
  const currentCards = [...currentGrid.querySelectorAll(":scope > .movie-card[data-history-id]")];
  if (currentCards.length !== movieExplorerRenderedCount) return false;
  return currentCards.every((card, index) => String(card.dataset.historyId) === String(state.moviesRaw[index]?.id));
}

function appendMovieExplorerCards(viewKey) {
  if (!movieExplorerCanAppend(viewKey)) return false;
  const currentGrid = elements.explorerPanel.firstElementChild;
  const newCards = state.moviesRaw.slice(movieExplorerRenderedCount).map(renderMovieCard).join("");
  const currentSentinel = elements.explorerPanel.querySelector('[data-explorer-sentinel="movies"]');
  currentSentinel?.remove();
  if (newCards) currentGrid.insertAdjacentHTML("beforeend", newCards);
  movieExplorerRenderedCount = state.moviesRaw.length;
  syncMovieExplorerSentinel();
  return true;
}

function renderListHeader(isShows) {
  if (isShows) {
    return `
      <div class="explorer-list-header">
        <span></span>
        <span class="list-header-sortable" data-sort-key="title">Series Title${sortArrow("title")}</span>
        <span class="list-header-sortable" data-sort-key="next_air">Next Airing${sortArrow("next_air")}</span>
        <span>Episodes</span>
        <span>Seasons</span>
        <span class="list-header-sortable" data-sort-key="watched">Last Watched${sortArrow("watched")}</span>
        <span>Year</span>
      </div>
    `;
  }
  return `
    <div class="explorer-list-header">
      <span></span>
      <span class="list-header-sortable" data-sort-key="title">Title${sortArrow("title")}</span>
      <span>Source</span>
      <span>Release Date</span>
      <span class="list-header-sortable" data-sort-key="watched">Watched${sortArrow("watched")}</span>
      <span>Year</span>
      <span>Runtime</span>
      <span></span>
    </div>
  `;
}
function renderMovieListCard(movie) {
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}"><span>${escapeHtml(platformBadge(movie.source))}</span></span>` : "";
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const releaseDate = tmdb?.release_date ? formatListDate(tmdb.release_date) : "";
  const runtime = tmdb?.runtime ? `${tmdb.runtime} min` : "";
  const year = tmdb?.release_date?.slice(0, 4) || "";
  return `
    <a class="movie-card explorer-list-card" href="${escapeAttribute(movieHref(movie))}" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}" style="text-decoration: none; color: inherit;">
      ${posterMarkup(movie, "list-thumb-poster")}
      <span class="list-card-title" title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</span>
      <div class="list-card-col list-card-platform">${sourceBadge}</div>
      <span class="list-card-col list-card-release" data-list-release>${escapeHtml(releaseDate)}</span>
      <span class="list-card-col">${escapeHtml(formatDate(movie.watched_at))} ${rewatchBadge(movie)}</span>
      <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      <span class="list-card-col" data-list-runtime>${escapeHtml(runtime)}</span>
      <div class="list-card-col list-card-sync">${renderSyncStatusDot(movie)}</div>
    </a>
  `;
}
function renderMovieOverviewCard(movie) {
  const tmdb = resolvedTmdbCache("movie", movie.tmdb_id, movie.title);
  const year = tmdb?.release_date?.slice(0, 4) || "";
  const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
  const overview = tmdb?.overview || "";
  const sourceBadge = movie.source ? `<span class="source-badge ${sourceClass(movie.source)}"><span>${escapeHtml(platformBadge(movie.source))}</span></span>` : "";
  return `
    <a class="movie-card explorer-overview-card" href="${escapeAttribute(movieHref(movie))}" data-history-id="${movie.id}" data-alpha-letter="${firstAlphaLetter(movie.title)}" data-prefetch-type="movie" data-prefetch-tmdb="${escapeAttribute(movie.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(movie.title || "")}" style="text-decoration: none; color: inherit;">
      ${posterMarkup(movie, "overview-thumb-poster")}
      <div class="overview-card-meta">
        <div class="overview-card-header">
          <b title="${escapeAttribute(movie.title)}">${escapeHtml(movie.title)}</b>
          <div class="overview-card-badges">${sourceBadge}${renderSyncStatusDot(movie)}</div>
        </div>
        <div class="overview-card-attrs" data-overview-attrs>${[year, genres].filter(Boolean).join(" &middot; ")}</div>
        <div class="overview-card-text-wrap"><p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p></div>
        <span class="overview-card-date">${formatDate(movie.watched_at)} ${rewatchBadge(movie)}</span>
      </div>
    </a>
  `;
}
// ---------------------------------------------------------------------------
// Movie explorer
// ---------------------------------------------------------------------------
export function renderMovieExplorer() {
  if (!isCurrentExplorerRoute("movies")) return;
  const key = explorerQueryKey("movies");
  if (state.moviesQueryKey !== key) resetMovieExplorer(key);
  if (!state.moviesRaw.length && state.moviesHasMore && !state.moviesLoading && state.token) {
    loadExplorerMovies().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.moviesRaw.length && state.moviesLoading) {
    movieExplorerRenderKey = "";
    movieExplorerRenderedCount = 0;
    elements.explorerPanel.innerHTML = loadingExplorer("Loading movies...");
    return;
  }
  const viewKey = `${key}|${currentExplorerView()}|${currentExplorerSort()}`;
  // Pagination only changes the tail of the list. Keep the existing grid and
  // poster nodes mounted, append the new cards, and refresh the sentinel in
  // place. A loading-state render also lands here, so it never rebuilds the
  // already-visible page just to change "Loading...".
  if (state.moviesRaw.length && state.moviesLoading && movieExplorerRenderKey === viewKey) {
    syncMovieExplorerSentinel();
    return;
  }
  if (appendMovieExplorerCards(viewKey)) {
    hydratePosters(elements.explorerPanel);
    observeExplorerSentinel("movies");
    observeExplorerTmdbPrefetch(elements.explorerPanel);
    updateAlphaFilter();
    return;
  }
  const movieGrid = state.moviesRaw.length
    ? `<div class="${explorerGridClass()}">${currentExplorerView() === "list" ? renderListHeader(false) : ""}${state.moviesRaw.map(renderMovieCard).join("")}</div>${renderExplorerSentinel("movies", state.moviesHasMore, state.moviesLoading)}`
    : emptyExplorer("No movies logged yet");
  commitMovieExplorerHtml(movieGrid);
  movieExplorerRenderKey = viewKey;
  movieExplorerRenderedCount = state.moviesRaw.length;
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("movies");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}
export async function loadExplorerMovies() {
  if (state.moviesLoading || !state.moviesHasMore) return;
  const requestVersion = state.moviesRequestVersion;
  state.moviesLoading = true;
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.moviesOffset));
    url.searchParams.set("sort", currentExplorerSort());
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    const showingStaleCache = isStaleExplorerPage(body);
    if (showingStaleCache) {
      state.moviesRaw = dedupeMediaRecords(Array.isArray(body.movies) ? body.movies : [], "movies");
      state.moviesOffset = 0;
      state.moviesHasMore = true;
      renderMovieExplorer();
    }
    if (!body || showingStaleCache) {
      if (!showingStaleCache) renderMovieExplorer();
      // /api/movies is served with Cache-Control: max-age=60,
      // stale-while-revalidate=300 so routine pagination can reuse the
      // browser's HTTP cache. This fetch only runs once the app's own
      // explorerPageCache has already ruled out a fast-path hit - including
      // right after a mutation (unwatch, fix match, edit date) clears that
      // cache via clearDerivedUiCaches(). "reload" bypasses the HTTP cache so
      // that refresh can't still hand back a pre-mutation response for up to
      // 5 minutes; it also re-populates the cache with this fresh response.
      const res = await fetch(url, { headers: authHeaders(), cache: "reload" });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Movies load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }
    if (requestVersion !== state.moviesRequestVersion) return;
    const movies = Array.isArray(body.movies) ? body.movies : [];
    state.moviesRaw = dedupeMediaRecords(showingStaleCache ? movies : [...state.moviesRaw, ...movies], "movies");
    state.moviesOffset += movies.length;
    state.moviesHasMore = movies.length === EXPLORER_PAGE_SIZE;
    if (state.moviesHasMore) state.explorerScrollArmed = true;
  } finally {
    if (requestVersion !== state.moviesRequestVersion) return;
    state.moviesLoading = false;
    renderMovieExplorer();
  }
}

// Re-fetches every movie page already loaded and replaces state.moviesRaw in
// one shot, WITHOUT ever setting it to empty first - unlike resetMovieExplorer()
// + renderMovieExplorer(), which clears the array, briefly renders the
// "Loading movies..." placeholder while the refetch is in flight, and only
// then repopulates. That empty middle step collapses the grid's height, which
// clamps the scroll container back to the top and can never restore the
// original position afterward. Used for live updates (a remote watch/unwatch
// on Trakt or another device) where the on-screen list needs to reflect a
// change nobody local caused, so there is no specific card to animate out the
// way removeGridCards() does for a local action - but the refresh still
// shouldn't be more disruptive than it has to be. commitMovieExplorerHtml()'s
// existing <img> preservation keeps already-loaded posters from reloading for
// every id present in both the old and new list.
export async function refreshMovieExplorerInPlace() {
  if (!isCurrentExplorerRoute("movies") || state.moviesLoading) return;
  const requestVersion = state.moviesRequestVersion;
  const loadedCount = Math.max(state.moviesOffset, EXPLORER_PAGE_SIZE);
  const url = new URL("/api/movies", window.location.origin);
  url.searchParams.set("limit", String(loadedCount));
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", currentExplorerSort());
  if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
  let body;
  try {
    const res = await fetch(url, { headers: authHeaders(), cache: "reload" });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Movies load failed ${res.status}`);
  } catch {
    return; // Leave the current list showing rather than clobber it on a failed refresh.
  }
  if (requestVersion !== state.moviesRequestVersion || !isCurrentExplorerRoute("movies")) return;
  const movies = Array.isArray(body.movies) ? body.movies : [];
  state.moviesRaw = dedupeMediaRecords(movies, "movies");
  state.moviesOffset = movies.length;
  state.moviesHasMore = movies.length === loadedCount;
  renderMovieExplorer();
}

// Same in-place refresh as the movie explorer, for the TV Shows library. A
// live provider completion can arrive while the detail page is open and the
// user can then return to this list without a full reload. Refetch the pages
// already mounted, preserving the list shell while replacing its summaries.
export async function refreshShowExplorerInPlace() {
  if (!isCurrentExplorerRoute("shows") || state.showsLoading) return;
  const requestVersion = state.showsRequestVersion;
  const loadedCount = Math.max(state.showsOffset, EXPLORER_PAGE_SIZE);
  const url = new URL("/api/shows", window.location.origin);
  url.searchParams.set("limit", String(loadedCount));
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", state.explorerSortShows);
  if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
  if (shouldHideWatchedShows()) url.searchParams.set("hideWatched", "true");
  if (state.hideEndedShows) url.searchParams.set("hideEnded", "true");
  let body;
  try {
    const res = await fetch(url, { headers: authHeaders(), cache: "reload" });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Shows load failed ${res.status}`);
  } catch {
    return;
  }
  if (requestVersion !== state.showsRequestVersion || !isCurrentExplorerRoute("shows")) return;
  const shows = Array.isArray(body.shows) ? body.shows : [];
  state.showsRaw = dedupeMediaRecords(shows, "shows");
  state.showsOffset = shows.length;
  state.showsHasMore = shows.length === loadedCount;
  renderShowExplorer();
}

// Same idea as refreshMovieExplorerInPlace(), for the flat History page/grid.
export async function refreshHistoryViewInPlace() {
  if (state.historyViewLoading) return;
  const requestVersion = state.historyViewRequestVersion;
  const loadedCount = Math.max(state.historyViewOffset, EXPLORER_PAGE_SIZE);
  const url = new URL("/api/history", window.location.origin);
  url.searchParams.set("limit", String(loadedCount));
  url.searchParams.set("offset", "0");
  url.searchParams.set("stats", "0");
  url.searchParams.set("dedupe", "false");
  if (state.historyViewSearch) url.searchParams.set("search", state.historyViewSearch);
  const mediaType = historyMediaFilterParam();
  if (mediaType) url.searchParams.set("mediaType", mediaType);
  let body;
  try {
    const res = await fetch(url, { headers: authHeaders(), cache: "reload" });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `History load failed ${res.status}`);
  } catch {
    return;
  }
  if (requestVersion !== state.historyViewRequestVersion || state.activeView !== "history") return;
  const historyItems = Array.isArray(body.history) ? body.history : [];
  state.historyViewRaw = historyItems;
  state.historyViewOffset = historyItems.length;
  state.historyViewHasMore = typeof body.hasMore === "boolean" ? body.hasMore : historyItems.length === loadedCount;
  renderHistoryView();
}
// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------
export function resetHistoryView(key = "") {
  clearHistoryViewLoadWatchers();
  state.historyViewRequestVersion += 1;
  state.historyViewRaw = [];
  state.historyViewOffset = 0;
  state.historyViewHasMore = true;
  state.historyViewLoading = false;
  state.historyViewQueryKey = key;
  state.historyViewScrollArmed = false;
}
function historyMediaFilterParam() {
  if (state.historyViewFilter === "movies") return "movie";
  if (state.historyViewFilter === "shows") return "episode";
  return "";
}
function historyEntryDisplay(entry) {
  const isEpisode = entry.media_type === "episode";
  let displayTitle = entry.title;
  let epTitle = "";
  let href = "";
  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    epTitle = entry.episode_title;
    let needsResolve = false;
    if (!epTitle || /^Episode \d+$/i.test(String(epTitle).trim())) {
      const text = String(entry.title || "").trim();
      const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
      if (suffixMatch?.[1]) {
        epTitle = suffixMatch[1].trim();
      } else {
        if (!epTitle) {
          epTitle = `Episode ${entry.episode}`;
        }
        needsResolve = true;
      }
    }
    if (needsResolve) {
      setTimeout(() => {
        const els = document.querySelectorAll(`[data-history-id="${entry.id}"] :is(.history-card-episode, .history-poster-overlay-episode)`);
        resolveEpisodeTitleFromTmdb(entry, els);
      }, 50);
    }
    const canonicalShowName = entry.show_title || showName(entry.title);
    href = tvShowBaseHrefFromEpisode(entry, canonicalShowName);
  } else {
    href = entry.tmdb_id ? movieTmdbHref(entry.tmdb_id, entry.title) : movieHref(entry);
  }
  const sourceBadge = entry.source ? sourceBadgeHtml(entry.source) : "None";
  const mediaLabel = isEpisode ? "TV Show" : "Movie";
  const seasonEpisode = isEpisode ? episodeCode(entry.season, entry.episode) : "";
  return { isEpisode, displayTitle, epTitle, href, sourceBadge, mediaLabel, seasonEpisode };
}
function renderHistoryGridCard(entry) {
  const { isEpisode, displayTitle, epTitle, href, mediaLabel } = historyEntryDisplay(entry);
  return `
    <a class="history-grid-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(isEpisode ? (entry.show_tmdb_id || "") : (entry.tmdb_id || ""))}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      <div class="poster-media-wrap">
        ${posterMarkup(entry, "history-grid-poster")}${historyPosterOverlay(entry, isEpisode && epTitle)}
        ${posterOverflowMenu(entry, isEpisode ? { showTitle: displayTitle, label: displayTitle } : {})}
      </div>
      <div class="history-grid-copy">
        <b title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>
        <span>${escapeHtml(isEpisode ? epTitle : mediaLabel)}</span>
        <small>${formatDate(entry.watched_at)} ${rewatchBadge(entry)}</small>
      </div>
    </a>
  `;
}
function renderHistoryListRow(entry) {
  const { isEpisode, displayTitle, epTitle, href, sourceBadge, mediaLabel, seasonEpisode } = historyEntryDisplay(entry);
  return `
    <a class="history-list-row" data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(isEpisode ? (entry.show_tmdb_id || "") : (entry.tmdb_id || ""))}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      ${posterMarkup(entry, "history-list-poster")}${historyPosterOverlay(entry, isEpisode && epTitle)}
      <span class="history-list-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</span>
      <span class="history-list-col" title="${escapeAttribute(epTitle || mediaLabel)}">${escapeHtml(epTitle || mediaLabel)}</span>
      <span class="history-list-col">${escapeHtml(seasonEpisode || mediaLabel)}</span>
      <span class="history-list-col">${formatDate(entry.watched_at)} ${rewatchBadge(entry)}</span>
      <span class="history-list-source">${sourceBadge}</span>
    </a>
  `;
}
function renderHistoryListHeader() {
  return `
    <div class="history-list-header" aria-hidden="true">
      <span></span>
      <span>Title</span>
      <span>Episode</span>
      <span>Type</span>
      <span>Watched</span>
      <span>App</span>
    </div>
  `;
}
function renderHistoryPageCard(entry) {
  const { isEpisode, displayTitle, epTitle, href, sourceBadge } = historyEntryDisplay(entry);
  return `
    <a class="history-page-card"${cardArtAttribute(entry)} data-history-id="${entry.id}" href="${escapeAttribute(href)}" data-prefetch-type="${isEpisode ? "tv" : "movie"}" data-prefetch-tmdb="${escapeAttribute(isEpisode ? (entry.show_tmdb_id || "") : (entry.tmdb_id || ""))}" data-prefetch-title="${escapeAttribute(displayTitle || "")}">
      <div class="history-card-poster-wrapper">
        ${posterMarkup(entry, "history-page-poster")}${historyPosterOverlay(entry, isEpisode && epTitle)}
        ${posterOverflowMenu(entry, isEpisode ? { showTitle: displayTitle, label: displayTitle } : {})}
      </div>
      <div class="history-card-details">
        <div class="history-card-header">
          <b class="history-card-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>
          ${isEpisode ? `<span class="history-card-episode" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>` : ""}
        </div>
        <div class="history-card-meta">
          ${isEpisode ? `
            <div class="history-card-meta-row">
              <span class="meta-label">Season/Ep:</span>
              <span class="meta-value">${escapeHtml(episodeCode(entry.season, entry.episode))}</span>
            </div>
          ` : ""}
          <div class="history-card-meta-row">
            <span class="meta-label">Last Played:</span>
            <span class="meta-value">${formatDate(entry.watched_at)} ${rewatchBadge(entry)}</span>
          </div>
        </div>
        <div class="history-card-footer">
          <span class="meta-label">App Used:</span>
          ${sourceBadge}
        </div>
      </div>
    </a>
  `;
}
function historyItemLayout() {
  if (state.historyViewMode === "list") return { listClass: "history-table-view", head: renderHistoryListHeader(), renderItem: renderHistoryListRow };
  if (state.historyViewMode === "cards") return { listClass: "history-list", head: "", renderItem: renderHistoryPageCard };
  return { listClass: "history-grid-view", head: "", renderItem: renderHistoryGridCard };
}
export function renderHistoryItems(items = state.historyViewRaw) {
  if (!state.historyViewRaw.length) return emptyExplorer("No watch history items found");
  const sentinel = `<div class="explorer-scroll-sentinel" data-history-sentinel aria-live="polite"><span>${state.historyViewLoading ? "Loading..." : ""}</span></div>`;
  const { listClass, head, renderItem } = historyItemLayout();
  return `<div class="${listClass}">${head}${items.map(renderItem).join("")}</div>${sentinel}`;
}
export function renderHistoryView() {
  if (state.activeView !== "history" || state.mediaDetailInline) return;
  const key = [state.historyViewSearch, state.historyViewFilter].join("|");
  if (state.historyViewQueryKey !== key) resetHistoryView(key);
  if (!state.historyViewRaw.length && state.historyViewHasMore && !state.historyViewLoading && state.token) {
    loadHistoryView().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.historyViewRaw.length && state.historyViewLoading) {
    elements.historyPanel.innerHTML = emptyExplorer("Loading watch history...");
    return;
  }
  if (elements.historySearchInput && elements.historySearchInput.value !== state.historyViewSearch) {
    elements.historySearchInput.value = state.historyViewSearch;
  }
  for (const button of elements.historyFilterButtons || []) {
    const isActive = button.dataset.historyFilter === state.historyViewFilter;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  for (const button of elements.historyViewButtons || []) {
    const isActive = button.dataset.historyView === state.historyViewMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  // Scrolled to the start, only the first cards are on screen: draw those now and
  // the rest in idle time. Scrolled into the list (paging, in-place refresh), draw
  // it whole so the scroll position holds. The sentinel waits for the last chunk.
  const panel = elements.historyPanel;
  const atStart = panel.getBoundingClientRect().top >= 0 && !panel.querySelector(".history-list")?.scrollLeft;
  const firstCount = atStart ? HISTORY_FIRST_PAINT_COUNT : Infinity, { listClass, renderItem } = historyItemLayout();
  panel.innerHTML = renderHistoryItems(state.historyViewRaw.slice(0, firstCount));
  hydratePosters(panel);
  appendRestInChunks(panel, state.historyViewRaw.slice(firstCount), {
    append: (items) => {
      const list = panel.querySelector(`.${listClass}`);
      list?.insertAdjacentHTML("beforeend", items.map(renderItem).join(""));
      return Boolean(list);
    },
    onComplete: () => { observeHistorySentinel(); observeExplorerTmdbPrefetch(panel); },
  });
}
export async function loadHistoryView() {
  if (state.historyViewLoading || !state.historyViewHasMore) return;
  const requestVersion = state.historyViewRequestVersion;
  const historyRail = elements.historyPanel?.querySelector(".history-list");
  const preservedScrollLeft = historyRail?.scrollLeft || 0;
  state.historyViewLoading = true;
  if (elements.historyPanel) {
    const sentinel = elements.historyPanel.querySelector("[data-history-sentinel] span");
    if (sentinel) sentinel.textContent = "Loading...";
  }
  try {
    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.historyViewOffset));
    url.searchParams.set("stats", "0");
    url.searchParams.set("dedupe", "false");
    if (state.historyViewSearch) url.searchParams.set("search", state.historyViewSearch);
    const mediaType = historyMediaFilterParam();
    if (mediaType) url.searchParams.set("mediaType", mediaType);
    const res = await fetch(url, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `History load failed ${res.status}`);
    const historyItems = Array.isArray(body.history) ? body.history : [];
    if (requestVersion !== state.historyViewRequestVersion) return;
    state.historyViewRaw = [...state.historyViewRaw, ...historyItems];
    state.historyViewOffset += historyItems.length;
    state.historyViewHasMore = typeof body.hasMore === "boolean" ? body.hasMore : historyItems.length === EXPLORER_PAGE_SIZE;
  } finally {
    if (requestVersion !== state.historyViewRequestVersion) return;
    state.historyViewLoading = false;
    renderHistoryView();
    if (preservedScrollLeft) {
      elements.historyPanel?.querySelector(".history-list")?.scrollTo({ left: preservedScrollLeft, behavior: "auto" });
    }
  }
}
export function observeHistorySentinel() {
  clearHistoryViewLoadWatchers();
  const sentinel = elements.historyPanel?.querySelector("[data-history-sentinel]");
  if (!sentinel) return;
  const historyRail = elements.historyPanel?.querySelector(".history-list");
  if (historyRail && window.innerWidth <= 760) {
    const loadThreshold = Math.max(160, historyRail.clientWidth * 0.75);
    historyViewLoadScrollHandler = () => {
      if (state.historyViewLoading || !state.historyViewHasMore) return;
      if (historyRail.scrollLeft + historyRail.clientWidth < historyRail.scrollWidth - loadThreshold) return;
      loadHistoryView().catch((error) => setMessage(error.message, "error"));
    };
    historyViewLoadScrollElement = historyRail;
    historyRail.addEventListener("scroll", historyViewLoadScrollHandler, { passive: true });
    return;
  }
  if (!("IntersectionObserver" in window)) return;
  state.historyViewLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loadHistoryView().catch((error) => setMessage(error.message, "error"));
    },
    { rootMargin: "1200px 0px 1200px 0px" },
  );
  state.historyViewLoadObserver.observe(sentinel);
}
// ---------------------------------------------------------------------------
// Show explorer
// ---------------------------------------------------------------------------
function syncShowExplorerSentinel() {
  const current = elements.explorerPanel.querySelector('[data-explorer-sentinel="shows"]');
  const html = renderExplorerSentinel("shows", state.showsHasMore, state.showsLoading);
  if (!html) {
    current?.remove();
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const next = template.content.firstElementChild;
  if (current) current.replaceWith(next);
  else elements.explorerPanel.append(next);
}

function updateShowExplorerCards(viewKey, showsToRender) {
  const renderedCount = showExplorerRenderedRecords.length;
  const sortedByNextAir = state.explorerSortShows === "next_air_asc";
  if (showExplorerRenderKey !== viewKey || !renderedCount) return false;
  if (sortedByNextAir ? showsToRender.length < renderedCount : showsToRender.length <= renderedCount) return false;
  const currentGrid = elements.explorerPanel.firstElementChild;
  if (!currentGrid || currentGrid.className !== explorerGridClass(true)) return false;
  const renderedNodes = [...currentGrid.querySelectorAll(":scope > [data-show-key]")];
  if (renderedNodes.length !== renderedCount) return false;
  if (!sortedByNextAir && !showExplorerRenderedRecords.every((record, index) => record === showsToRender[index])) return false;

  if (sortedByNextAir) {
    const nodesByRecord = new Map(showExplorerRenderedRecords.map((record, index) => [record, renderedNodes[index]]));
    const nextRecords = new Set(showsToRender);
    if (nodesByRecord.size !== renderedCount || !showExplorerRenderedRecords.every((record) => nextRecords.has(record))) return false;
    const newRecords = showsToRender.filter((record) => !nodesByRecord.has(record));
    const template = document.createElement("template");
    template.innerHTML = newRecords.map(renderShowRecord).join("");
    if (template.content.children.length !== newRecords.length) return false;
    newRecords.forEach((record, index) => nodesByRecord.set(record, template.content.children[index]));
    // Move existing cards into the new order; only newly fetched records need markup.
    let cursor = currentGrid.firstElementChild?.classList.contains("explorer-list-header")
      ? currentGrid.firstElementChild.nextElementSibling
      : currentGrid.firstElementChild;
    for (const record of showsToRender) {
      const node = nodesByRecord.get(record);
      if (node !== cursor) currentGrid.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
      const nextAirEl = node.querySelector("[data-list-next-air]");
      if (nextAirEl) {
        const nextAiring = nextAiringCell(mergeShowAiringMetadata(record, resolvedTmdbCache("tv", record.tmdb_id, record.title)));
        if (nextAirEl.textContent !== nextAiring.text) nextAirEl.textContent = nextAiring.text;
        nextAirEl.classList.toggle("list-next-air-status", Boolean(nextAiring.text && nextAiring.isStatus));
      }
    }
  } else {
    const newCards = showsToRender.slice(renderedCount).map(renderShowRecord).join("");
    if (newCards) currentGrid.insertAdjacentHTML("beforeend", newCards);
  }

  elements.explorerPanel.querySelector('[data-explorer-sentinel="shows"]')?.remove();
  showExplorerRenderedRecords = showsToRender.slice();
  syncShowExplorerSentinel();
  return true;
}

export function renderShowExplorer() {
  if (!isCurrentExplorerRoute("shows")) return;
  const key = explorerQueryKey("shows");
  if (state.showsQueryKey !== key) resetShowExplorer(key);
  if (!state.showsRaw.length && state.showsHasMore && !state.showsLoading && state.token) {
    loadExplorerShows().catch((error) => setMessage(error.message, "error"));
  }
  if (!state.showsRaw.length && state.showsLoading) {
    showExplorerRenderKey = "";
    showExplorerRenderedRecords = [];
    elements.explorerPanel.innerHTML = loadingExplorer("Loading TV shows...");
    return;
  }
  const viewKey = `${key}|${currentExplorerView()}|${currentExplorerSort()}`;
  if (state.showsRaw.length && state.showsLoading && showExplorerRenderKey === viewKey) {
    syncShowExplorerSentinel();
    return;
  }
  const showsToRender = state.explorerSortShows === "next_air_asc"
    ? [...state.showsRaw].sort((a, b) => {
      const dateA = nextAiringDateValue(mergeShowAiringMetadata(a, resolvedTmdbCache("tv", a.tmdb_id, a.title)));
      const dateB = nextAiringDateValue(mergeShowAiringMetadata(b, resolvedTmdbCache("tv", b.tmdb_id, b.title)));
      if (dateA && dateB) return dateA.localeCompare(dateB);
      if (dateA) return -1;
      if (dateB) return 1;
      return String(a.title).localeCompare(String(b.title));
    })
    : state.showsRaw;
  const hasNewCards = showsToRender.length > showExplorerRenderedRecords.length;
  if (updateShowExplorerCards(viewKey, showsToRender)) {
    if (hasNewCards) {
      hydratePosters(elements.explorerPanel);
      observeExplorerTmdbPrefetch(elements.explorerPanel);
    }
    observeExplorerSentinel("shows");
    updateAlphaFilter();
    return;
  }
  elements.explorerPanel.innerHTML = showsToRender.length
    ? `<div class="${explorerGridClass(true)}">${currentExplorerView() === "list" ? renderListHeader(true) : ""}${showsToRender.map(renderShowRecord).join("")}</div>${renderExplorerSentinel("shows", state.showsHasMore, state.showsLoading)}`
    : emptyExplorer("No TV episodes logged yet");
  showExplorerRenderKey = viewKey;
  showExplorerRenderedRecords = showsToRender.slice();
  hydratePosters(elements.explorerPanel);
  observeExplorerSentinel("shows");
  observeExplorerTmdbPrefetch(elements.explorerPanel);
  updateAlphaFilter();
}
export async function loadExplorerShows() {
  if (state.showsLoading || !state.showsHasMore) return;
  const requestVersion = state.showsRequestVersion;
  state.showsLoading = true;
  try {
    const url = new URL("/api/shows", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.showsOffset));
    url.searchParams.set("sort", state.explorerSortShows);
    if (state.explorerSearch) url.searchParams.set("search", state.explorerSearch);
    if (shouldHideWatchedShows()) url.searchParams.set("hideWatched", "true");
    if (state.hideEndedShows) url.searchParams.set("hideEnded", "true");
    const cacheKey = url.toString();
    let body = cachedExplorerPage(cacheKey);
    const showingStaleCache = isStaleExplorerPage(body);
    if (showingStaleCache) {
      state.showsRaw = dedupeMediaRecords(Array.isArray(body.shows) ? body.shows : [], "shows");
      state.showsOffset = 0;
      state.showsHasMore = true;
      renderShowExplorer();
    }
    if (!body || showingStaleCache) {
      if (!showingStaleCache) renderShowExplorer();
      const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Shows load failed ${res.status}`);
      rememberExplorerPage(cacheKey, body);
    }
    if (requestVersion !== state.showsRequestVersion) return;
    const shows = Array.isArray(body.shows) ? body.shows : [];
    state.showsRaw = dedupeMediaRecords(showingStaleCache ? shows : [...state.showsRaw, ...shows], "shows");
    state.showsOffset += shows.length;
    state.showsHasMore = shows.length === EXPLORER_PAGE_SIZE;
    if (state.showsHasMore) state.explorerScrollArmed = true;
  } finally {
    if (requestVersion !== state.showsRequestVersion) return;
    state.showsLoading = false;
    renderShowExplorer();
  }
}
export function mergeShowDetail(show = {}) {
  if (!show?.title) return null;
  const showIds = providerIdentityTokens(show);
  const showKey = slug(show.title);
  let existingIndex = state.showsRaw.findIndex((item) => {
    const itemIds = providerIdentityTokens(item);
    if (showIds.length && itemIds.length) return showIds.some((id) => itemIds.includes(id));
    // A provider-identified record must not absorb a title-only record: doing
    // so would make two same-title series share the first record's history.
    if (showIds.length || itemIds.length) return false;
    return slug(item.title) === showKey;
  });
  // Two records can hold non-overlapping provider ids for the same series: a
  // Fix Match rematch moves a show off its TMDB id onto a TVDB one, so a list
  // record loaded before the rematch and the server record fetched after it
  // share no id at all. Appending a second record for the title rather than
  // replacing that one leaves the pre-rematch copy earlier in state.showsRaw,
  // and every reader that resolves a show by title slug - renderImmersiveShowModal
  // included - keeps finding the stale copy. That is what left a deleted watch
  // date on an open detail page until a reload rebuilt the list: the refetch
  // after the delete landed in a record nothing renders from. The server
  // resolves /api/show by title, so a slug collision is the same group.
  if (existingIndex < 0) {
    existingIndex = state.showsRaw.findIndex((item) => slug(item.title) === showKey);
  }
  if (existingIndex >= 0) {
    state.showsRaw[existingIndex] = { ...state.showsRaw[existingIndex], ...show };
    return state.showsRaw[existingIndex];
  }
  state.showsRaw.push(show);
  return show;
}

function providerIdentityTokens(show = {}) {
  const ids = [];
  const imdbId = show.show_imdb_id || show.imdb_id;
  const tmdbId = show.show_tmdb_id || show.tmdb_id;
  const tvdbId = show.show_tvdb_id || show.tvdb_id;
  if (imdbId) ids.push(`imdb:${String(imdbId).toLowerCase()}`);
  if (tmdbId) ids.push(`tmdb:${String(tmdbId).toLowerCase()}`);
  if (tvdbId) ids.push(`tvdb:${String(tvdbId).toLowerCase()}`);
  return ids;
}

// One episode-page load asked /api/show four times, through different code
// paths and with two different parameter shapes, and got the same 27,912-byte
// answer every time. In-flight dedupe alone could not collapse that: the calls
// are not all concurrent, and a URL key does not match across the shapes. These
// index a resolved show under every identifier that resolves to it, so a later
// lookup by any one of them hits the same entry.
//
// The window is deliberately short. /api/show carries authoritative watched
// rows and dates, so this exists to collapse one page's worth of duplicate
// lookups, not to hold state across a user's actions - and any mutation clears
// it through clearDerivedUiCaches().
const SHOW_DETAIL_CACHE_TTL_MS = 10_000;

function showLookupTokens(show = {}) {
  const tokens = providerIdentityTokens(show);
  const id = show.id || show.show_id;
  if (id) tokens.push(`id:${String(id).toLowerCase()}`);
  const title = show.title || show.show_title;
  if (title) tokens.push(`title:${slug(title)}`);
  return tokens;
}

export function cachedShowDetail(hints = {}) {
  for (const token of showLookupTokens(hints)) {
    const cacheKey = state.showDetailAliases.get(token);
    if (!cacheKey) continue;
    const entry = state.showDetailCache.get(cacheKey);
    if (!entry) continue;
    if (Date.now() - entry.ts > SHOW_DETAIL_CACHE_TTL_MS) {
      state.showDetailCache.delete(cacheKey);
      continue;
    }
    return entry.show;
  }
  return null;
}

export function rememberShowDetail(show) {
  if (!show) return show;
  const tokens = showLookupTokens(show);
  if (!tokens.length) return show;
  const cacheKey = tokens[0];
  state.showDetailCache.set(cacheKey, { show, ts: Date.now() });
  for (const token of tokens) state.showDetailAliases.set(token, cacheKey);
  return show;
}

// The cache above can only index a show that resolved, so a title that is not
// in the library was never remembered and every re-render re-asked for it. A
// detail page opened from a recommendation rail did this six times in one load
// - the same three lookup shapes twice over - and each one is a 404 in the
// browser console. Remember the miss too, under the same identity tokens, so
// one page load asks once.
//
// A miss is at least as perishable as a hit - importing or syncing a title
// turns it into a real record - so this matches, and never exceeds, the
// positive cache's window, and is cleared by clearDerivedUiCaches() on any
// mutation just as that one is. It cannot be much shorter than a page load: at
// 5s a detail page whose provider work took 5.4s outlived its own miss entries
// and asked again on the re-render.
const SHOW_DETAIL_MISS_TTL_MS = SHOW_DETAIL_CACHE_TTL_MS;

export function cachedShowDetailMiss(hints = {}) {
  for (const token of showLookupTokens(hints)) {
    const ts = state.showDetailMisses.get(token);
    if (ts === undefined) continue;
    if (Date.now() - ts > SHOW_DETAIL_MISS_TTL_MS) {
      state.showDetailMisses.delete(token);
      continue;
    }
    return true;
  }
  return false;
}

export function rememberShowDetailMiss(hints = {}) {
  const now = Date.now();
  for (const token of showLookupTokens(hints)) state.showDetailMisses.set(token, now);
}

export async function loadShowDetail(show = {}) {
  const showTitle = show.title || "";
  const showTmdbId = show.tmdb_id || show.show_tmdb_id || "";
  const showTvdbId = show.tvdb_id || show.show_tvdb_id || "";
  const showImdbId = show.imdb_id || show.show_imdb_id || "";
  const showKey = slug(showTitle);
  const identityKey = providerIdentityTokens(show)[0] || "";
  const cacheKey = identityKey || show.id || showKey || showTitle;
  if (!cacheKey) return null;
  const alreadyResolved = cachedShowDetail(show);
  if (alreadyResolved) return alreadyResolved;
  if (state.showDetailInflight.has(cacheKey)) return state.showDetailInflight.get(cacheKey);
  const request = (async () => {
    const url = new URL("/api/show", window.location.origin);
    if (show.id) url.searchParams.set("id", show.id);
    if (showTitle) url.searchParams.set("title", showTitle);
    if (showTmdbId) url.searchParams.set("tmdbId", showTmdbId);
    if (showTvdbId) url.searchParams.set("tvdbId", showTvdbId);
    if (showImdbId) url.searchParams.set("imdbId", showImdbId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      let response = await fetch(url, { headers: authHeaders(), cache: "no-store", signal: controller.signal });
      let body = await response.json().catch(() => ({}));
      // Episode rows can carry a provider id for the episode rather than the
      // series. If that stale identity cannot resolve, retry by the trusted
      // show title so the detail page can still receive its authoritative
      // watched rows and dates.
      if (!response.ok && response.status === 404 && showTitle && url.searchParams.get("title")) {
        const titleUrl = new URL("/api/show", window.location.origin);
        titleUrl.searchParams.set("title", showTitle);
        response = await fetch(titleUrl, { headers: authHeaders(), cache: "no-store", signal: controller.signal });
        body = await response.json().catch(() => ({}));
      }
      if (!response.ok) throw new Error(body.error || `Show detail failed ${response.status}`);
      return rememberShowDetail(mergeShowDetail(body.show || null));
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Show detail request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => state.showDetailInflight.delete(cacheKey));
  state.showDetailInflight.set(cacheKey, request);
  return request;
}
// ---------------------------------------------------------------------------
// Legacy in-memory explorer helpers (used by old show grouping path)
// ---------------------------------------------------------------------------
export function matchesExplorerSearch(entry = {}, search = "") {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.title,
    entry.imdb_id,
    entry.tmdb_id,
    entry.tvdb_id,
    entry.source,
    entry.season,
    entry.episode,
  ]
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).toLowerCase())
    .join(" ");
  return haystack.includes(needle);
}
export function sortExplorerItems(items, sortMode) {
  return [...items].sort((a, b) => {
    if (sortMode === "title_asc") return String(a.title).localeCompare(String(b.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "title_desc") return String(b.title).localeCompare(String(a.title)) || watchedTime(b) - watchedTime(a);
    if (sortMode === "watched_asc") return watchedTime(a) - watchedTime(b) || String(a.title).localeCompare(String(b.title));
    return watchedTime(b) - watchedTime(a) || String(a.title).localeCompare(String(b.title));
  });
}
function sortShowEntries(entries, sortMode) {
  return [...entries].sort(([titleA, seasonsA], [titleB, seasonsB]) => {
    if (sortMode === "title_asc") return titleA.localeCompare(titleB) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "title_desc") return titleB.localeCompare(titleA) || latestWatched(seasonsB) - latestWatched(seasonsA);
    if (sortMode === "watched_asc") return earliestWatched(seasonsA) - earliestWatched(seasonsB) || titleA.localeCompare(titleB);
    return latestWatched(seasonsB) - latestWatched(seasonsA) || titleA.localeCompare(titleB);
  });
}
function watchedTime(entry) {
  const time = new Date(entry?.watched_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}
function allSeasonEpisodes(seasons) {
  return [...seasons.values()].flat();
}
function latestWatched(seasons) {
  return Math.max(...allSeasonEpisodes(seasons).map(watchedTime), 0);
}
function earliestWatched(seasons) {
  const times = allSeasonEpisodes(seasons).map(watchedTime).filter(Boolean);
  return times.length ? Math.min(...times) : 0;
}
export function representativeEpisode(seasons) {
  return sortExplorerItems(allSeasonEpisodes(seasons), "watched_desc")[0] || {};
}
function groupShows(episodes) {
  const shows = new Map();
  for (const episode of episodes) {
    if (!isWatchedHistoryAction(episode)) continue;
    const title = showName(episode.title);
    if (!shows.has(title)) shows.set(title, new Map());
    const seasons = shows.get(title);
    const season = Number(episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return shows;
}
export function seasonsFromShowRecord(show = {}) {
  const seasons = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    const season = Number(episode.display_season ?? episode.season) || 0;
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push(episode);
  }
  return seasons;
}
function summaryEpisodeFromShow(show = {}) {
  const representative = show.representative_episode || show.representativeEpisode || {};
  return {
    ...representative,
    id: representative.id || show.id || show.title,
    title: sanitizeTitle(representative.title) || sanitizeTitle(show.title) || "Unknown Show",
    media_type: representative.media_type || "episode",
    watched_at: representative.watched_at || show.latest_watched_at || "",
    source: representative.source || show.source || "",
    imdb_id: representative.imdb_id || show.imdb_id || null,
    tmdb_id: representative.tmdb_id || show.tmdb_id || null,
    tvdb_id: representative.tvdb_id || show.tvdb_id || null,
    // A show card must use the show's canonical poster. The representative
    // episode poster can be a still and is reserved for episode rows.
    poster_url: show.show_poster_url || show.canonical_poster_url || show.poster_url || show.posterUrl || representative.poster_url || null,
  };
}
export function tmdbLookupIdsFromShow(show = {}, seasons = null) {
  const representative = show.representative_episode || show.representativeEpisode || representativeEpisode(seasons || seasonsFromShowRecord(show));
  // A flat episode tvdb_id is not safe to use as a show route identity, but it
  // is a deterministic hint for the metadata gateway's episode-to-series
  // resolver when no series-level TVDB id was stored locally.
  const tvdbId =
    show.tvdb_id ||
    show.show_tvdb_id ||
    representative?.show_tvdb_id ||
    representative?.tvdb_id ||
    "";
  return {
    // Do not use a flat episode id to build a /tvshow route. It is only passed
    // to the metadata resolver as a final fallback when no series identity is
    // available locally.
    imdbId: show.imdb_id || show.show_imdb_id || representative?.show_imdb_id || "",
    tvdbId,
  };
}
// ---------------------------------------------------------------------------
// Show record / folder rendering
// ---------------------------------------------------------------------------
function unresolvedShowTitle(value = "") {
  const raw = String(value || "").trim();
  return !raw || /^unknown show$/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
}

function showRecordDisplayTitle(show = {}) {
  const rawTitle = String(show.title || "").trim();
  if (!unresolvedShowTitle(rawTitle)) return sanitizeTitle(rawTitle) || "Unknown Show";

  const opaqueId = rawTitle.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]+\/)?([^/?#]+)/i)?.[1];
  if (opaqueId) {
    const provider = rawTitle.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] || "media";
    return `Unmatched ${provider.charAt(0).toUpperCase()}${provider.slice(1).toLowerCase()} show (${opaqueId})`;
  }

  const historyId = show.representative_episode?.id || show.representativeEpisode?.id || "";
  return historyId ? `Unmatched show (${String(historyId).slice(0, 8)})` : "Unknown Show";
}

function showLibraryPosterEntry(show = {}, latestEpisode = {}) {
  const showPoster = show.show_poster_url
    || show.canonical_poster_url
    || show.poster_url
    || "";
  const entry = { ...show, ...(latestEpisode || {}) };
  if (showPoster) {
    // The card represents the series, even when its representative episode
    // carries season artwork. Keep the episode id/title for the card identity,
    // but make the shared show artwork the explicit poster source.
    entry.poster_url = showPoster;
    entry.show_poster_url = show.show_poster_url || showPoster;
    entry.canonical_poster_url = show.canonical_poster_url || showPoster;
    entry.season_poster_url = "";
    entry.prefer_show_poster = true;
    entry.prefer_raw_poster = true;
  } else {
    // Do not let the latest episode's season poster replace the artwork of
    // this show-level library card when no shared poster has been resolved.
    entry.season_poster_url = "";
  }
  return entry;
}

export function renderShowRecord(show = {}) {
  const displayTitle = showRecordDisplayTitle(show);
  // Keep unresolved records on the existing history-linked shell. The label is
  // now distinct, but the history id remains the authoritative record that can
  // be inspected or repaired.
  const showKey = unresolvedShowTitle(show.title) ? "unknown-show" : slug(displayTitle);
  const representative = summaryEpisodeFromShow(show);
  const seasons = Array.isArray(show.episodes) && show.episodes.length ? seasonsFromShowRecord(show) : null;
  const isListView = currentExplorerView() === "list";
  const listTmdbShow = isListView ? resolvedTmdbCache("tv", show.tmdb_id || "", displayTitle) : null;
  const episodeCount = show.episode_count || (seasons ? allSeasonEpisodes(seasons).length : 0);
  const seasonCount = regularTmdbSeasonCount(listTmdbShow) || Number(show.season_count || 0) || (seasons ? seasons.size : 0);
  const totalWatches = Math.max(Number(show.total_watches || 0), Number(episodeCount || 0));
  const actualWatchText = totalWatches > episodeCount ? ` · ${totalWatches} actual watches` : "";
  const latestEpisode = seasons ? representativeEpisode(seasons) : representative;
  const tmdbId = show.tmdb_id || "";
  const historyId = latestEpisode?.id || "";
  const detailHref = showDetailHref(show, displayTitle, showKey, historyId);
  if (isListView) {
    const year = listTmdbShow?.first_air_date?.slice(0, 4) || "";
    const totalEps = show.total_episodes || listTmdbShow?.number_of_episodes || 0;
    const nextAiring = nextAiringCell(mergeShowAiringMetadata(show, listTmdbShow));
    const pct = totalEps ? Math.round((episodeCount / totalEps) * 100) : null;
    const episodeProgressHtml = totalEps
      ? `<div class="list-eps-progress" data-list-eps data-watched="${episodeCount}" data-total="${totalEps}"><div class="list-eps-bar-track"><div class="list-eps-bar-fill" style="width:${pct}%"></div></div><span class="list-eps-label">${episodeCount} / ${totalEps}${actualWatchText}</span></div>`
      : `<span class="list-card-col" data-list-eps data-watched="${episodeCount}" data-total="0">${episodeCount}${actualWatchText}</span>`;
    const sourceEl = latestEpisode?.source ? `<span class="source-badge ${sourceClass(latestEpisode.source)}"><span>${escapeHtml(platformBadge(latestEpisode.source))}</span></span>` : "";
    return `
      <a class="explorer-list-card explorer-list-show-card" href="${escapeAttribute(detailHref)}" aria-label="${escapeAttribute(`Open ${displayTitle} media page`)}" data-show-key="${escapeAttribute(showKey)}" data-show-href="${escapeAttribute(detailHref)}" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        ${posterMarkup(showLibraryPosterEntry(show, latestEpisode), "list-thumb-poster")}
        <span class="list-card-title">${escapeHtml(displayTitle)}</span>
        <span class="list-card-col${nextAiring.isStatus && nextAiring.text ? " list-next-air-status" : ""}" data-list-next-air>${escapeHtml(nextAiring.text)}</span>
        ${episodeProgressHtml}
        <span class="list-card-col" data-list-season-count>${escapeHtml(String(seasonCount || ""))}</span>
        <span class="list-card-col">${latestEpisode?.watched_at ? escapeHtml(formatDate(latestEpisode.watched_at)) : ""}</span>
        <span class="list-card-col list-card-year" data-list-year>${escapeHtml(year)}</span>
      </a>
    `;
  }
  if (currentExplorerView() === "overview") {
    const tmdb = resolvedTmdbCache("tv", tmdbId, displayTitle);
    const genres = tmdb?.genres?.slice(0, 3).map((g) => escapeHtml(g.name)).join(" &middot; ") || "";
    const overview = tmdb?.overview || "";
    const firstYear = tmdb?.first_air_date?.slice(0, 4) || "";
    return `
      <article class="explorer-overview-card explorer-overview-show-card" data-show-key="${escapeAttribute(showKey)}" data-show-href="${escapeAttribute(detailHref)}" data-alpha-letter="${firstAlphaLetter(displayTitle)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}">
        <button class="folder-trigger overview-show-poster-btn" type="button" data-show-key="${escapeAttribute(showKey)}" data-show-href="${escapeAttribute(detailHref)}" style="border:0;background:transparent;padding:0;display:block;">
          ${posterMarkup(showLibraryPosterEntry(show, latestEpisode), "overview-thumb-poster")}
        </button>
        <div class="overview-card-meta">
          <div class="overview-card-header">
            <button class="folder-trigger overview-show-title-btn" type="button" data-show-key="${escapeAttribute(showKey)}" data-show-href="${escapeAttribute(detailHref)}" style="border:0;background:transparent;padding:0;text-align:left;cursor:pointer;"><b>${escapeHtml(displayTitle)}</b></button>
          </div>
          <div class="overview-card-attrs" data-overview-attrs>${[firstYear, genres].filter(Boolean).join(" &middot; ")}${episodeCount ? `${firstYear || genres ? " &middot; " : ""}${episodeCount} ep${episodeCount !== 1 ? "s" : ""}` : ""}${actualWatchText}</div>
          <div class="overview-card-text-wrap"><p class="overview-card-text" data-overview-text>${escapeHtml(overview)}</p></div>
        </div>
      </article>
    `;
  }
  const tmdbShow = resolvedTmdbCache("tv", tmdbId, displayTitle);
  const latestWatchedAt = latestEpisode?.watched_at || show.latest_watched_at || "";
  const libraryPosterEntry = showLibraryPosterEntry(show, latestEpisode);
  const historyEntry = {
    ...latestEpisode,
    id: latestEpisode?.id || historyId || show.id || "",
    title: latestEpisode?.title || displayTitle,
    media_type: "episode",
    show_title: displayTitle,
    show_tmdb_id: show.show_tmdb_id || tmdbId || latestEpisode?.show_tmdb_id || "",
    show_tvdb_id: show.show_tvdb_id || show.tvdb_id || latestEpisode?.show_tvdb_id || "",
    show_imdb_id: show.show_imdb_id || show.imdb_id || latestEpisode?.show_imdb_id || "",
    poster_url: libraryPosterEntry.poster_url || "",
    show_poster_url: libraryPosterEntry.show_poster_url || libraryPosterEntry.poster_url || "",
    season_poster_url: "",
    prefer_show_poster: true,
    watched_at: latestWatchedAt,
  };
  const attributes = ` data-alpha-letter="${escapeAttribute(firstAlphaLetter(displayTitle))}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId)}" data-prefetch-title="${escapeAttribute(displayTitle)}" data-show-key="${escapeAttribute(showKey)}" data-show-href="${escapeAttribute(detailHref)}"${historyId ? ` data-show-record-id="${escapeAttribute(historyId)}"` : ""}`;
  return renderDashboardHistoryPageCard(historyEntry, {
    explorer: true, explorerSummary: tmdbShow?.overview || "",
    explorerClass: "folder-card",
    explorerAttributes: attributes,
    explorerHref: detailHref,
  });
}
function showDetailHref(show = {}, displayTitle = "", showKey = "", historyId = "") {
  if (show.tmdb_id) return tvShowTmdbHref(show.tmdb_id, displayTitle);
  if (show.tvdb_id) return tvShowTvdbHref(show.tvdb_id, displayTitle);
  return `/tvshow/${showKey}${historyId ? `?historyId=${encodeURIComponent(historyId)}` : ""}`;
}

export function renderShowFolder(showTitle, seasons, tmdbId, tvdbId = "") {
  const showKey = slug(showTitle);
  const latestEpisode = representativeEpisode(seasons);
  const detailHref = tmdbId
    ? tvShowTmdbHref(tmdbId, showTitle)
    : tvdbId
      ? tvShowTvdbHref(tvdbId, showTitle)
      : `/tvshow/${showKey}`;
  return `
    <article class="folder-card" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(tmdbId || "")}" data-prefetch-title="${escapeAttribute(showTitle)}">
      <button class="folder-trigger" type="button" data-show-key="${showKey}" data-show-href="${escapeAttribute(detailHref)}" style="border: 0; background: transparent; padding: 0; width: 100%; text-align: left; display: block;">
        ${posterMarkup(latestEpisode, "explorer-folder-poster")}
        <div class="movie-card-body" style="margin-top: 0.5rem;">
          <b>${escapeHtml(showTitle)}</b>
        </div>
      </button>
    </article>
  `;
}
export function renderSeasonFolder(showKey, season, episodes) {
  const seasonKey = `${showKey}:s${season}`;
  const expanded = state.expandedSeasons.has(seasonKey);
  const sortedEpisodes = sortExplorerItems(episodes, currentExplorerSort());
  const totalWatches = episodes.reduce((total, episode) => total + actualWatchCount(episode), 0);
  const actualWatchText = totalWatches > episodes.length ? ` · ${totalWatches} actual watches` : "";
  return `
    <article class="season-card">
      <button class="season-trigger" type="button" data-season-key="${seasonKey}" aria-expanded="${expanded}">
        <span class="accordion-chevron ${expanded ? "expanded" : ""}">▼</span>
        <b>Season ${String(season || "?").padStart(2, "0")}</b>
        <span>${episodes.length} watched episodes${actualWatchText}</span>
      </button>
      <div class="episode-list ${expanded ? "" : "hidden"}">
        ${sortedEpisodes
      .map((episode) => {
        return `
              <article class="episode-row" style="display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; padding: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                  ${posterMarkup(episode, "explorer-episode-poster")}
                  <span class="episode-code">[ E${String(episode.episode || "?").padStart(2, "0")} ]</span>
                  <b style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.35rem;">
                    [ ${escapeHtml(episodeTitle(episode.title, episode.episode))} ]
                    ${renderSyncStatusDot(episode)}
                  </b>
                  <button class="debug-badge" type="button" data-history-id="${episode.id}">${formatDate(episode.watched_at)}</button>
                  ${rewatchBadge(episode)}
                </div>
              </article>
            `;
      })
      .join("")}
      </div>
    </article>
  `;
}
// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function loadingExplorer(message) {
  return `<div class="empty-log empty-log--loading"><span class="empty-log-spinner" aria-hidden="true"></span><div><b>${escapeHtml(message)}</b><span>Fetching your saved library.</span></div></div>`;
}
export function emptyExplorer(message) {
  return `<div class="empty-log"><b>${escapeHtml(message)}</b><span>Import history or wait for webhook events.</span></div>`;
}
