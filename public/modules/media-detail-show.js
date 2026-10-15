import { state, elements } from "./state.js?v=2.0.0.3.0";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, slug, showTitleFrom, episodeTitle, formatDate, formatTmdbDate, formatLongAiringDate, formatEpisodeAirtime, toDateInputValue, showEpisodeKey, episodeCode, seasonLabel, formatSeasonTitle, sourceBadgeHtml, platformSourceValues, normalizePlatformSource, actualWatchHistory, tvShowTmdbHref, tvShowTvdbHref, isDemoMode } from "./utils.js?v=2.0.0.3.0";
import { posterUrlFor, tmdbImage, tmdbPoster, bestTmdbLogo, proxiedArtworkUrl, hydratePosters, isCachedStorageImageUrl } from "./images.js?v=2.0.0.3.0";
import { isWatchedHistoryAction, isMediaSyncing, mediaSyncNoticeHtml, renderSyncStatusDot } from "./sync.js?v=2.0.0.3.0";
import { mergeShowDetail, loadShowDetail, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, syncInlineMediaDetailHeading, cachedShowDetail, rememberShowDetail, cachedShowDetailMiss, rememberShowDetailMiss } from "./explorer.js?v=2.0.0.3.0";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=2.0.0.3.0";
import { renderWatchDatePrompt, seasonUnwatchButtonHtml, showUnwatchButtonHtml, savingEpisodeKeysForShow, markSavingEpisodeComplete, hasSavingWatchActionForShow } from "./watch-action.js?v=2.0.0.3.0";
import { authHeaders, setMessage, syncPageTopbar, mediaDetailRoot, mediaDetailLoaderHtml, setMediaDetailActions, mediaInfoActionHtml, mediaForceSyncActionHtml, mediaToolsActionHtml, setMediaInfoContext, prepareInlineMediaDetail, bumpMediaRenderToken, currentMediaRenderToken } from "./media-detail-context.js?v=2.0.0.3.0";
import { personalRatingPillHtml, personalEpisodeRatingButtonHtml, personalMediaActionsHtml } from "./personal-media.js?v=2.0.0.3.0";
import { upNextShowActionHtml } from "./up-next-shared.js?v=2.0.0.3.0";
import { watchSeasonCardSizes } from "./season-card-sizes.js?v=2.0.0.3.0";
import {
  renderCastSection, renderTrailersSection, renderReviewsSection, renderRelatedShowsSection,
  renderMediaFacts, renderMediaImagesSection, renderExternalRatingPills, ratingPillHtml,
  renderSeasonSeerrControls, renderSeerrRequestPill, fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus, episodeResolutionPillHtml,
  hydrateMediaAppLinks, mediaAppLinksHtml,
  markDetailPrimaryReady,
} from "./media-detail-shared.js?v=2.0.0.3.0";

let _playbackProgressRows = [];
let _playbackProgressLoaded = false;
let _playbackProgressLoadPromise = null;
const _seasonDetailsInflight = new Set();
const SEASON_HYDRATION_CONCURRENCY = 4;
// Season posters saved in Edit Images (season-posters-panel.js), keyed by show
// identity, so the season rows show the same poster the user picked.
const _savedSeasonPosters = new Map();

function savedSeasonPosterKey(tmdbId, tvdbId) {
  if (tmdbId) return `tmdb:${tmdbId}`;
  return tvdbId ? `tvdb:${tvdbId}` : "";
}

async function loadSavedSeasonPosters(tmdbId, tvdbId, title) {
  const key = savedSeasonPosterKey(tmdbId, tvdbId);
  if (!key || isDemoMode()) return;
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", String(tmdbId));
  if (tvdbId) params.set("tvdbId", String(tvdbId));
  if (title) params.set("title", title);
  try {
    const res = await fetch(`/api/season-posters?${params}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    _savedSeasonPosters.set(key, new Map(Object.entries(data?.seasons || {}).map(([number, url]) => [Number(number), url])));
  } catch {
    // Non-admin or offline: the rows fall back to TMDB season posters.
  }
}

function canonicalizeBareShowRoute(tmdbData, title = "", seasonNumber = null, episodeNumber = null, tvdbId = "") {
  if (typeof window === "undefined" || !/^\/tvshow\/(?!tmdb\/|tvdb\/)/i.test(window.location.pathname)) return;
  const resolvedTmdbId = String(tmdbData?.id || "").trim();
  const resolvedTvdbId = String(tvdbId || tmdbData?.external_ids?.tvdb_id || "").trim();
  const showTitle = String(title || tmdbData?.name || "").trim();
  const base = resolvedTmdbId
    ? tvShowTmdbHref(resolvedTmdbId, showTitle)
    : resolvedTvdbId
      ? tvShowTvdbHref(resolvedTvdbId, showTitle)
      : "";
  if (!base) return;

  const currentHash = String(window.location.hash || "");
  const season = Number(seasonNumber);
  const episode = Number(episodeNumber);
  const hash = currentHash || (Number.isInteger(season) && season >= 0
    ? `#season${season}${Number.isInteger(episode) && episode >= 1 ? `ep${episode}` : ""}`
    : "");
  const nextUrl = `${base}${hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) window.history.replaceState({}, document.title, nextUrl);
}

// The page's actual scrollable element is <main class="page-shell">
// (window/document never scroll - the app shell layout keeps the sidebar
// fixed and only page-shell has overflow). Walks up from the trigger to find
// whichever ancestor actually has the overflow, rather than assuming it's
// page-shell specifically.
function nearestScrollableAncestor(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

const SCROLL_ANIMATION_MS = 700;
// After the eased scroll ends, keep re-aiming for this long: a card above the
// target can still change height (a lazy poster loading, a season collapsing),
// which would otherwise leave the card short of its mark.
const SCROLL_SETTLE_MS = 600;
const SCROLL_CANCEL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// A hand-rolled eased scroll instead of scrollIntoView's native
// behavior:"smooth": the browser's own smooth scroll duration isn't
// configurable and reads as an abrupt snap over this kind of distance.
// getTargetTop is re-read every frame, so the destination follows the card if
// the layout moves mid-scroll. The user taking over (wheel, touch, key, click)
// cancels the correction.
function animateScrollTop(container, getTargetTop, duration) {
  const isWindowLevel = container === document.scrollingElement || container === document.documentElement;
  const readTop = () => (isWindowLevel ? window.scrollY : container.scrollTop);
  const writeTop = (top) => {
    if (isWindowLevel) window.scrollTo(0, top);
    else container.scrollTop = top;
  };
  const startTop = readTop();
  const startTime = performance.now();
  let animationEnd = 0;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const finish = () => SCROLL_CANCEL_EVENTS.forEach((name) => container.removeEventListener(name, cancel));
  SCROLL_CANCEL_EVENTS.forEach((name) => container.addEventListener(name, cancel, { passive: true }));
  function step(now) {
    if (cancelled) return finish();
    const top = Math.max(0, getTargetTop());
    if (!animationEnd) {
      const progress = Math.min((now - startTime) / duration, 1);
      writeTop(startTop + (top - startTop) * easeInOutCubic(progress));
      if (progress === 1) animationEnd = now;
    } else if (now - animationEnd >= SCROLL_SETTLE_MS) {
      return finish();
    } else if (Math.abs(readTop() - top) > 1) {
      writeTop(top);
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Scrolls the given season's card to the top of the view, eased over
// SCROLL_ANIMATION_MS. The scroll-margin-top on .season-accordion-trigger
// (styles.css) reserves space for the sticky .page-topbar, so the card lands
// visible just below it instead of hidden underneath. Shared by the
// season-click handler in media-detail-events.js and the initial-render
// scroll below, so both stay in sync.
export function scrollSeasonAccordionIntoView(seasonNum, { duration = SCROLL_ANIMATION_MS } = {}) {
  const selector = `.seasons-section.season-accordions [data-season-accordion="${seasonNum}"]`;
  const fallback = ".seasons-section.season-accordions";
  const initial = document.querySelector(selector) || document.querySelector(fallback);
  if (!initial) return;
  const container = nearestScrollableAncestor(initial);
  const isWindowLevel = container === document.scrollingElement || container === document.documentElement;
  // Re-queried each frame: a re-render during the scroll replaces the element.
  const getTargetTop = () => {
    const target = document.querySelector(selector) || document.querySelector(fallback) || initial;
    const containerTop = isWindowLevel ? 0 : container.getBoundingClientRect().top;
    const currentTop = isWindowLevel ? window.scrollY : container.scrollTop;
    const scrollMarginTop = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    // Rects are in zoomed pixels (the app shell's CSS zoom); scrollTop is not.
    const zoom = isWindowLevel ? 1 : container.currentCSSZoom || 1;
    return currentTop + (target.getBoundingClientRect().top - containerTop) / zoom - scrollMarginTop;
  };
  animateScrollTop(container, getTargetTop, duration);
}

// Desktop: an open season's episode box sits beside its card, level with the
// card's top edge. It is positioned absolutely (styles.css), so it doesn't take
// up row height and the other season cards stay where they are. The list is
// made tall enough to hold it. Mobile keeps the stacked layout and clears these.
export function positionSeasonDetails(root = document) {
  const isDesktop = window.matchMedia?.("(min-width: 761px)").matches;
  root.querySelectorAll?.(".season-accordion-list").forEach((list) => {
    const listRect = list.getBoundingClientRect();
    // Some window widths scale the app shell with CSS zoom: rects come back in
    // zoomed pixels, but left/top/width apply in the list's own pixels.
    const zoom = list.currentCSSZoom || 1;
    // A 1px border draws as whole screen pixels (at least one); the joining
    // lines in styles.css use this width so they meet the borders exactly.
    const screenScale = zoom * (window.devicePixelRatio || 1);
    list.style.setProperty("--season-hairline", `${Math.max(1, Math.floor(screenScale + 1e-6)) / screenScale}px`);
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    let listHeight = 0;
    list.querySelectorAll("[data-season-detail]").forEach((detail) => {
      const card = list.querySelector(`[data-season-accordion="${detail.dataset.seasonDetail}"]`)?.closest(".season-accordion");
      if (!isDesktop || !card) {
        detail.style.left = "";
        detail.style.top = "";
        detail.style.width = "";
        detail.style.removeProperty("--season-card-h");
        return;
      }
      detail.style.setProperty("--season-card-h", `${card.offsetHeight}px`);
      const cardRect = card.getBoundingClientRect();
      const left = (cardRect.right - listRect.left) / zoom + gap;
      const top = (cardRect.top - listRect.top) / zoom;
      detail.style.left = `${left}px`;
      detail.style.top = `${top}px`;
      detail.style.width = `${Math.max(0, listRect.width / zoom - left)}px`;
      listHeight = Math.max(listHeight, top + detail.offsetHeight);
    });
    list.style.minHeight = isDesktop && listHeight ? `${listHeight}px` : "";
    watchSeasonCardSizes(list, () => positionSeasonDetails(document));
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => positionSeasonDetails(document));
}

// Season episode lists are TVDB-backed. Prefer the show's resolved TVDB id even
// when the merged metadata also has a TMDB id: TVDB-only cache rows are a valid
// source of the merged show document, but a TMDB-id season lookup cannot find
// those rows and leaves the page stuck with only locally-watched episodes.
export function showSeasonLookupId(tmdbData) {
  const tvdbId = String(tmdbData?.external_ids?.tvdb_id || "");
  if (tvdbId) return `tvdb:${tvdbId}`;
  const tmdbId = String(tmdbData?.id || "");
  return tmdbId;
}

function identifiableShowTitleFromRow(row, historyId = "") {
  const parsed = showTitleFrom(row?.show_title || row?.grandparent_title || row?.series_title || row?.title || "");
  if (parsed && !/^plex:\/\//i.test(parsed) && !/^unknown show$/i.test(parsed)) return parsed;
  const raw = String(row?.show_title || row?.title || "").trim();
  const plexSeason = raw.match(/^plex:\/\/season\/([^/?#]+)/i);
  if (plexSeason) return `Unmatched Plex show (${plexSeason[1]})`;
  if (raw && !/^plex:\/\//i.test(raw) && !/^unknown show$/i.test(raw)) return raw;
  return historyId ? `Unmatched show (${historyId.slice(0, 8)})` : "Unmatched show";
}

function isUnmatchedShowTitle(title = "") {
  const value = String(title || "").trim();
  return !value || /^unknown show$/i.test(value) || /^unmatched(?:\s+plex)?\s+show\b/i.test(value);
}

// A history row only needs the orphan shell treatment when its own show
// identity cannot be resolved at all - not merely when it names a different
// show than the one requested. A stale/leftover historyId (e.g. carried over
// from whatever show was open before a link that doesn't specify its own,
// like a global search result) can point at a row for a perfectly real,
// different show; treating that mismatch as "unresolved" would swap the
// requested show out for that unrelated one instead of just ignoring the
// stale id and loading the requested show normally.
function historyRowShowIsUnresolved(row) {
  const parsed = showTitleFrom(row?.show_title || row?.grandparent_title || row?.series_title || row?.title || "");
  return isUnmatchedShowTitle(parsed) || /^plex:\/\//i.test(parsed);
}

function localShowSeedForTmdbId(tmdbId) {
  const requestedId = String(tmdbId || "");
  if (!requestedId) return null;
  const show = (state.showsRaw || []).find((entry) => String(entry.tmdb_id || "") === requestedId);
  if (show) return show;

  const rows = [
    ...(Array.isArray(state.upNextItems) ? state.upNextItems : []),
    ...(Array.isArray(state.history) ? state.history : []),
    ...(Array.isArray(state.partWatchedRaw) ? state.partWatchedRaw : []),
    ...(Array.isArray(state.historyViewRaw) ? state.historyViewRaw : []),
  ];
  const row = rows.find((entry) => (
    entry?.media_type === "episode"
      && String(entry.show_tmdb_id || "") === requestedId
  ));
  if (!row) return null;
  const title = row.show_title || showTitleFrom(row.title || "");
  return {
    title,
    tmdb_id: row.show_tmdb_id || "",
    tvdb_id: row.show_tvdb_id || "",
    imdb_id: row.show_imdb_id || "",
    episodes: [row],
    episode_count: 1,
    season_count: row.season == null ? 0 : 1,
  };
}

function localShowSeedForTvdbId(tvdbId) {
  const requestedId = String(tvdbId || "");
  if (!requestedId) return null;
  const show = (state.showsRaw || []).find((entry) => String(entry.tvdb_id || "") === requestedId);
  if (show) return show;

  const rows = [
    ...(Array.isArray(state.upNextItems) ? state.upNextItems : []),
    ...(Array.isArray(state.history) ? state.history : []),
    ...(Array.isArray(state.partWatchedRaw) ? state.partWatchedRaw : []),
    ...(Array.isArray(state.historyViewRaw) ? state.historyViewRaw : []),
  ];
  const row = rows.find((entry) => (
    entry?.media_type === "episode"
      && String(entry.show_tvdb_id || "") === requestedId
  ));
  if (!row) return null;
  const title = row.show_title || showTitleFrom(row.title || "");
  return {
    title,
    tvdb_id: row.show_tvdb_id || "",
    tmdb_id: row.show_tmdb_id || "",
    imdb_id: row.show_imdb_id || "",
    episodes: [row],
    episode_count: 1,
    season_count: row.season == null ? 0 : 1,
  };
}

async function fetchLocalShowByTmdbId(tmdbId) {
  const seed = localShowSeedForTmdbId(tmdbId);
  if (seed) return seed;
  const alreadyResolved = cachedShowDetail({ tmdb_id: tmdbId });
  if (alreadyResolved) return alreadyResolved;
  if (cachedShowDetailMiss({ tmdb_id: tmdbId })) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`/api/show?tmdbId=${encodeURIComponent(String(tmdbId || ""))}`, {
      headers: authHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) rememberShowDetailMiss({ tmdb_id: tmdbId });
      return null;
    }
    const body = await response.json().catch(() => ({}));
    if (!body.show) {
      rememberShowDetailMiss({ tmdb_id: tmdbId });
      return null;
    }
    return rememberShowDetail(body.show);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLocalShowByTvdbId(tvdbId) {
  const seed = localShowSeedForTvdbId(tvdbId);
  if (seed) return seed;
  const alreadyResolved = cachedShowDetail({ tvdb_id: tvdbId });
  if (alreadyResolved) return alreadyResolved;
  if (cachedShowDetailMiss({ tvdb_id: tvdbId })) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`/api/show?tvdbId=${encodeURIComponent(String(tvdbId || ""))}`, {
      headers: authHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) rememberShowDetailMiss({ tvdb_id: tvdbId });
      return null;
    }
    const body = await response.json().catch(() => ({}));
    if (!body.show) {
      rememberShowDetailMiss({ tvdb_id: tvdbId });
      return null;
    }
    return rememberShowDetail(body.show);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function openShowImmersiveModalByTitle(showTitle, seedEpisode = null, requestedSeason = null) {
  const normalizedTitle = showTitleFrom(showTitle);
  const showKey = slug(normalizedTitle);
  state.activeShowModalKey = showKey;
  state.activeShowModalSeason = requestedSeason;

  let show = state.showsRaw.find((entry) => slug(entry.title) === showKey);
  if (!show && seedEpisode) {
    show = {
      title: normalizedTitle,
      episode_count: 1,
      season_count: seedEpisode.season != null ? 1 : 0,
      latest_watched_at: seedEpisode.watched_at,
      earliest_watched_at: seedEpisode.watched_at,
      // Episode-level ids belong to the episode row, not the series route.
      tmdb_id: seedEpisode.show_tmdb_id || null,
      tvdb_id: seedEpisode.show_tvdb_id || null,
      imdb_id: seedEpisode.show_imdb_id || null,
      episodes: [{ ...seedEpisode, show_title: normalizedTitle }],
    };
    state.showsRaw.push(show);
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason);
    }
    return;
  }

  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }

  const root = mediaDetailRoot();
  root.innerHTML = `
    <div class="immersive-container">
      ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
      ${mediaDetailLoaderHtml("Loading show details")}
    </div>
  `;

  // Another path on this same page load may already have resolved this show
  // under a different identifier; reuse it rather than asking again.
  const resolvedFromCache = cachedShowDetail({ title: normalizedTitle });
  if (resolvedFromCache) {
    show = resolvedFromCache;
  } else if (!cachedShowDetailMiss({ title: normalizedTitle })) {
    try {
      const response = await fetch(`/api/show?title=${encodeURIComponent(normalizedTitle)}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.show) {
        mergeShowDetail(body.show);
        show = rememberShowDetail(body.show);
      } else if (response.status === 404 || !body.show) {
        rememberShowDetailMiss({ title: normalizedTitle });
      }
    } catch (error) {
      console.error("Failed to fetch show details by title", error);
    }
  }

  const isModalOpen = state.mediaDetailInline || !elements.debugModal.classList.contains("hidden");
  if (show && state.activeShowModalKey === showKey && isModalOpen) {
    if (state.mediaDetailInline) {
      await openShowInlineDetail(slug(show.title), requestedSeason || state.activeShowModalSeason);
    } else {
      await renderImmersiveShowModal(slug(show.title), requestedSeason || state.activeShowModalSeason);
    }
  } else if (!show && state.activeShowModalKey === showKey && isModalOpen) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">&larr; Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Show not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this TV series in the archive.</span>
        </div>
      </div>
    `;
  }
}

export async function openShowInlineDetail(showKey, activeSeasonNum = null, activeEpisodeNum = null, historyId = "") {
  prepareInlineMediaDetail("shows");
  await renderImmersiveShowModal(showKey, activeSeasonNum, activeEpisodeNum, historyId);
}

async function fetchShowImdbPillHtml(show = {}, tmdbData = null, requestStillCurrent = () => true) {
  const showImdbId = show.imdb_id || tmdbData?.external_ids?.imdb_id || "";
  if (!showImdbId) return "";
  const fallbackPill = () => ratingPillHtml({
    label: "IMDb",
    value: "",
    href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
    title: "Open this title on IMDb",
  });
  if (!state.savedConfig?.omdb?.configured) return fallbackPill();

  const omdbRes = await fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(showImdbId)}`, { headers: authHeaders() }).catch(() => null);
  if (!requestStillCurrent()) return "";
  if (!omdbRes?.ok) return fallbackPill();

  const omdbData = await omdbRes.json().catch(() => null);
  if (!requestStillCurrent()) return "";
  if (!omdbData?.imdbRating) return fallbackPill();

  return ratingPillHtml({
    label: "IMDb",
    value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
    href: `https://www.imdb.com/title/${escapeAttribute(showImdbId)}`,
    title: `IMDb rating: ${omdbData.imdbRating}/10`,
  });
}

export async function openShowImmersiveModalByTmdbId(tmdbId) {
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1;
  setMediaDetailActions("");
  state.activeShowTmdbId = String(tmdbId);
  const initialLocalSeed = localShowSeedForTmdbId(tmdbId);
  const lookupIds = tmdbLookupIdsFromShow(initialLocalSeed || {});
  // A TMDB URL can outlive a Fix Match rematch. When the local row has an
  // explicit TVDB identity, resolve through TVDB first instead of letting the
  // decorative/stale TMDB route select a same-title show. This also repairs
  // bookmarked legacy links without requiring the user to edit the URL
  // manually. The resolved metadata still supplies the TMDB id for artwork,
  // Seerr and external links, while the URL remains anchored to the
  // authoritative TVDB series id.
  if (lookupIds.tvdbId) {
    await openShowImmersiveModalByTvdbId(lookupIds.tvdbId);
    return;
  }
  const localDetailPromise = initialLocalSeed
    ? loadShowDetail(initialLocalSeed).catch(() => null)
    : fetchLocalShowByTmdbId(tmdbId);
  const localSeedPromise = initialLocalSeed ? Promise.resolve(initialLocalSeed) : localDetailPromise;
  state.activeShowTvdbId = null;
  syncInlineMediaDetailHeading("shows");
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const isAlreadyOpen = Boolean(state.activeShowRenderContext?.tmdbData?.id && String(state.activeShowRenderContext.tmdbData.id) === String(tmdbId));
  const root = mediaDetailRoot();
  if (!isAlreadyOpen) {
    root.innerHTML = `
      <div class="immersive-container">
        ${mediaDetailLoaderHtml("Loading TV show details")}
      </div>
    `;
  }

  // Library cards already carry the local watched record. Paint that record
  // before the canonical TMDB route asks the provider gateway for enrichment;
  // the metadata request must not be the first-paint gate.
  if (initialLocalSeed && currentMediaRenderToken() === renderToken) {
    state.activeShowModalKey = slug(initialLocalSeed.title);
    state.activeShowModalTitle = initialLocalSeed.title;
    renderShowModalContent(initialLocalSeed, {
      activeSeasonNum: state.activeShowModalSeason,
      tmdbData: null,
      seasonDetailsByNumber: new Map(),
      loading: true,
      watchHistoryLoading: true,
    });
  }

  state.activeShowTvdbId = lookupIds.tvdbId || null;
  let tmdbData = await fetchTmdbDetails("tv", tmdbId, initialLocalSeed?.title || "", lookupIds, { immediate: true });
  if (currentMediaRenderToken() !== renderToken) return;
  if (!tmdbData) {
    // The stored TMDB ID may not map to a valid show (e.g. episode-level ID from
    // Plex, or a show not yet indexed). Fall back to a title search using the
    // matching now-playing session title so first-watch shows still load.
    const matchingSession = state.activeSessions.find(
      (s) => String(s.ids?.tmdb || "") === String(tmdbId)
    );
    if (matchingSession) {
      const fallbackTitle = showTitleFrom(
        matchingSession.showTitle || matchingSession.show_title || matchingSession.title || ""
      );
      if (fallbackTitle) tmdbData = await fetchTmdbDetails("tv", null, fallbackTitle);
      if (currentMediaRenderToken() !== renderToken) return;
    }
  }
  if (!tmdbData) {
    // A legacy or incorrect TMDB id should not make a locally watched show
    // unreachable. Fall back to the local library record so the episode
    // history remains visible and the user can use Fix Match to repair the
    // identity that caused the lookup to fail.
    const localSeed = await localSeedPromise.catch(() => null);
    let fallbackShow = localSeed || state.showsRaw.find((show) => String(show.tmdb_id || "") === String(tmdbId));
    if (!fallbackShow) {
      const matchingRows = (state.history || []).filter((row) => (
        row.media_type === "episode" && String(row.tmdb_id || "") === String(tmdbId)
      ));
      const firstRow = matchingRows[0];
      if (firstRow) {
        const title = firstRow.show_title || showTitleFrom(firstRow.title) || "Unknown Show";
        fallbackShow = {
          title,
          tmdb_id: firstRow.show_tmdb_id || "",
          tvdb_id: firstRow.show_tvdb_id || "",
          imdb_id: firstRow.show_imdb_id || "",
          episodes: matchingRows,
          episode_count: matchingRows.length,
          season_count: new Set(matchingRows.map((row) => row.season).filter((value) => value != null)).size,
        };
      }
    }

    if (fallbackShow) {
      const detailedShow = await localDetailPromise.catch(() => null) || await loadShowDetail(fallbackShow).catch(() => null);
      const localShow = detailedShow || fallbackShow;
      const localShowKey = slug(localShow.title);
      state.activeShowModalKey = localShowKey;
      state.activeShowModalTitle = localShow.title;
      state.activeShowTmdbId = String(localShow.tmdb_id || tmdbId);
      renderShowModalContent(localShow, {
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData: null,
        seasonDetailsByNumber: new Map(),
        loading: false,
        watchHistoryLoading: false,
        patchExisting: Boolean(root.querySelector(".media-detail-page")),
      });
      return;
    }

    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load TV show details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }
  canonicalizeBareShowRoute(
    tmdbData,
    initialLocalSeed?.title || tmdbData.name || "",
    state.activeShowModalSeason,
    state.activeShowModalEpisode,
    tmdbData.external_ids?.tvdb_id,
  );
  await renderShowDetailFromMetadata(tmdbData, renderToken, localDetailPromise);
}

// Renders a show from a resolved metadata document. The document is TVDB-backed
// with TMDB merged in where available, so it renders the same whether it was
// reached by TMDB id or by TVDB id.
async function renderShowDetailFromMetadata(tmdbData, renderToken, localShowPromise = null) {
  if (tmdbData?.id) state.activeShowTmdbId = String(tmdbData.id);
  const showTitle = tmdbData.name || "Untitled TV Show";
  const tvdbIdCandidate = String(tmdbData.external_ids?.tvdb_id || state.activeShowTvdbId || "");
  state.activeShowModalTitle = showTitle;
  syncPageTopbar();
  const seasons = [...(tmdbData.seasons || [])]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));

  const seasonDetailsByNumber = new Map();
  const localShow = state.showsRaw.find((show) => (
    (tmdbData.id && String(show.tmdb_id || "") === String(tmdbData.id))
    || (tvdbIdCandidate && String(show.tvdb_id || "") === tvdbIdCandidate)
  ));
  // A show's own tmdb_id/tvdb_id can be temporarily unresolved right after a
  // Fix Match rematch (the identity fields are cleared and re-backfilled in
  // the background), and its display title can legitimately differ from the
  // provider's own name (preferredShowTitle() favors a title with no
  // trailing year, which the provider's name may still carry) - so neither
  // the tmdb_id nor the slug branch alone is reliable then. Matching on tvdb
  // id too, when the provider returned one, keeps this from silently falling
  // back to an empty placeholder (and rendering 0 watched episodes) right
  // when a repaired show's identity is still catching up.
  const existingShow = state.showsRaw.find((show) => (
    (tmdbData.id && String(show.tmdb_id || "") === String(tmdbData.id))
    || (tvdbIdCandidate && String(show.tvdb_id || "") === tvdbIdCandidate)
  )) || (!tmdbData.id && !tvdbIdCandidate
    ? state.showsRaw.find((show) => slug(show.title) === slug(showTitle))
    : null);
  const show = mergeShowWithLoadedHistory(existingShow || {
    title: showTitle,
    tmdb_id: tmdbData.id ? String(tmdbData.id) : "",
    tvdb_id: String(tmdbData.external_ids?.tvdb_id || ""),
    episodes: [],
    episode_count: 0,
    season_count: seasons.length,
  });
  // The detail request is deliberately still no-store: it contains mutable
  // per-episode watch state. It runs beside the first render, not before it.
  const detailLookup = {
    id: localShow?.id || "",
    title: showTitle,
    tmdb_id: tmdbData.id ? String(tmdbData.id) : "",
    tvdb_id: tvdbIdCandidate,
  };
  const detailPromise = (localShowPromise
    ? Promise.resolve(localShowPromise).catch(() => null)
    : Promise.resolve(null)
  ).then((resolvedShow) => {
    if (resolvedShow || currentMediaRenderToken() !== renderToken) return resolvedShow;
    return loadShowDetail(detailLookup).catch(() => null);
  });
  const playbackProgressPromise = ensurePlaybackProgressLoaded();
  const savedSeasonPostersPromise = loadSavedSeasonPosters(tmdbData.id ? String(tmdbData.id) : "", tvdbIdCandidate, showTitle);
  const imdbPillPromise = fetchShowImdbPillHtml(
    show,
    tmdbData,
    () => currentMediaRenderToken() === renderToken && String(state.activeShowTmdbId || "") === String(tmdbData.id || "")
  );

  // The canonical-id path now paints its metadata shell immediately. Watched
  // rows already in memory are visible now; a fresh page can show the shell
  // while its no-store local detail request catches up.
  renderShowModalContent(show, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: true,
    watchHistoryLoading: true,
    tmdbOnly: !existingShow,
    imdbPillHtml: "",
    patchExisting: Boolean(mediaDetailRoot().querySelector(".media-detail-page")),
  });
  if (currentMediaRenderToken() !== renderToken) return;

  const [detailedShow, imdbPillHtml] = await Promise.all([detailPromise, imdbPillPromise, savedSeasonPostersPromise]);
  await playbackProgressPromise;
  if (currentMediaRenderToken() !== renderToken) return;

  const hydratedShow = mergeShowWithLoadedHistory(detailedShow || show);
  state.activeShowModalTitle = hydratedShow.title || showTitle;
  renderShowModalContent(hydratedShow, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: false,
    watchHistoryLoading: false,
    tmdbOnly: !detailedShow && !existingShow,
    imdbPillHtml,
    patchExisting: true,
  });
}

// Series that TMDB has no record of are reached by TVDB id instead. If the
// resolved document turns out to carry a TMDB id after all, rendering it sets
// state.activeShowTmdbId, and the TMDB route wins from that point on.
export async function openShowImmersiveModalByTvdbId(tvdbId) {
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1;
  setMediaDetailActions("");
  state.activeShowTmdbId = null;
  state.activeShowTvdbId = String(tvdbId);
  syncInlineMediaDetailHeading("shows");
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const isAlreadyOpen = Boolean(state.activeShowRenderContext?.tmdbData?.external_ids?.tvdb_id && String(state.activeShowRenderContext.tmdbData.external_ids.tvdb_id) === String(tvdbId));
  const root = mediaDetailRoot();
  if (!isAlreadyOpen) {
    root.innerHTML = `
      <div class="immersive-container">
        ${mediaDetailLoaderHtml("Loading TV show details")}
      </div>
    `;
  }

  const initialLocalSeed = localShowSeedForTvdbId(tvdbId);
  const localDetailPromise = initialLocalSeed
    ? loadShowDetail(initialLocalSeed).catch(() => null)
    : fetchLocalShowByTvdbId(tvdbId);
  if (initialLocalSeed && currentMediaRenderToken() === renderToken) {
    state.activeShowModalKey = slug(initialLocalSeed.title);
    state.activeShowModalTitle = initialLocalSeed.title;
    renderShowModalContent(initialLocalSeed, {
      activeSeasonNum: state.activeShowModalSeason,
      tmdbData: null,
      seasonDetailsByNumber: new Map(),
      loading: true,
      watchHistoryLoading: true,
    });
  }

  const tmdbData = await fetchTmdbDetails("tv", null, initialLocalSeed?.title || "", { tvdbId }, { immediate: true });
  if (currentMediaRenderToken() !== renderToken) return;
  if (!tmdbData) {
    const localShow = await localDetailPromise.catch(() => null);
    if (localShow) {
      state.activeShowModalKey = slug(localShow.title);
      state.activeShowModalTitle = localShow.title;
      renderShowModalContent(localShow, {
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData: null,
        seasonDetailsByNumber: new Map(),
        loading: false,
        watchHistoryLoading: false,
        patchExisting: Boolean(root.querySelector(".media-detail-page")),
      });
      return;
    }
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load TV show details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">TVDB did not return a series for this ID.</span>
        </div>
      </div>
    `;
    return;
  }
  canonicalizeBareShowRoute(
    tmdbData,
    initialLocalSeed?.title || tmdbData.name || "",
    state.activeShowModalSeason,
    state.activeShowModalEpisode,
    tvdbId,
  );
  await renderShowDetailFromMetadata(tmdbData, renderToken, localDetailPromise);
}

function watchedEpisodesByKey(show = {}) {
  const map = new Map();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    map.set(showEpisodeKey(episode.season, episode.episode), episode);
  }
  return map;
}

function watchedEpisodeFor(watchedMap, seasonNumber, episodeNumber) {
  const exact = watchedMap.get(showEpisodeKey(seasonNumber, episodeNumber));
  if (exact) return exact;
  if (Number(seasonNumber) === 0) {
    return watchedMap.get(showEpisodeKey(null, episodeNumber)) || null;
  }
  return null;
}

function watchSummaryForRows(rows = []) {
  const watchedRows = rows.filter((row) => row?.watched);
  const totalWatches = watchedRows.reduce((total, row) => total + actualWatchHistory(row.watched).length, 0);
  const rewatchedEpisodes = watchedRows.filter((row) => actualWatchHistory(row.watched).length > 1).length;
  return { totalWatches, rewatchedEpisodes };
}

function playbackProgressTitle(row = {}) {
  return showTitleFrom(row.show_title || row.grandparent_title || row.series_title || row.title || "");
}

function playbackProgressMatchesShow(row = {}, showTitle = "", resolvedTmdbId = "") {
  if (String(row.media_type || "").toLowerCase() !== "episode") return false;
  if (row.season == null || row.episode == null) return false;
  if (resolvedTmdbId && String(row.tmdb_id || "") === String(resolvedTmdbId)) return true;
  return slug(playbackProgressTitle(row)) === slug(showTitle);
}

function playbackProgressByEpisode(show = {}, resolvedTmdbId = "") {
  const map = new Map();
  const showTitle = show.title || "";
  for (const row of [...(state.partWatchedRaw || []), ..._playbackProgressRows]) {
    if (!playbackProgressMatchesShow(row, showTitle, resolvedTmdbId || show.tmdb_id || "")) continue;
    const progress = Number(row.progress || 0);
    if (!Number.isFinite(progress) || progress <= 0) continue;
    const key = showEpisodeKey(row.season, row.episode);
    const existing = map.get(key);
    if (!existing || Number(row.updated_at || 0) >= Number(existing.updated_at || 0)) {
      map.set(key, { ...row, progress: Math.max(0, Math.min(100, progress)) });
    }
  }
  return map;
}

async function ensurePlaybackProgressLoaded() {
  if (_playbackProgressLoaded || _playbackProgressLoadPromise) return _playbackProgressLoadPromise;
  _playbackProgressLoadPromise = fetch("/api/playback-progress?limit=100", { headers: authHeaders(), cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      _playbackProgressRows = Array.isArray(body.progress) ? body.progress : [];
      _playbackProgressLoaded = true;
      return _playbackProgressRows;
    })
    .catch((error) => {
      console.error("Failed to load playback progress for media detail", error);
      return _playbackProgressRows;
    })
    .finally(() => {
      _playbackProgressLoadPromise = null;
    });
  return _playbackProgressLoadPromise;
}

function hydrateMissingSeasonDetails(show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading) {
  const lookupId = showSeasonLookupId(tmdbData);
  if (loading || !lookupId || activeSeasonNum == null) return;
  const seasonNumber = Number(activeSeasonNum);
  if (!Number.isFinite(seasonNumber) || seasonDetailsByNumber.has(seasonNumber)) return;
  const cacheKey = `${lookupId}|${seasonNumber}`;
  if (_seasonDetailsInflight.has(cacheKey)) return;

  _seasonDetailsInflight.add(cacheKey);
  fetchTmdbSeasonDetails(lookupId, seasonNumber)
    .catch((error) => {
      console.error("Failed to hydrate season episode thumbnails", error);
      return null;
    })
    .then((details) => {
      // Record the attempt either way - a failed/empty fetch still has to
      // clear the "loading" pending state below, or the season would show a
      // loading spinner forever instead of settling on "no episodes found".
      seasonDetailsByNumber.set(seasonNumber, details || { episodes: [] });
      const current = state.activeShowRenderContext;
      const currentLookupId = showSeasonLookupId(current?.tmdbData) || lookupId;
      if (Number(state.activeShowModalSeason) !== seasonNumber || currentLookupId !== lookupId) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: seasonNumber,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
        patchExisting: true,
      });
    })
    .finally(() => _seasonDetailsInflight.delete(cacheKey));
}

function hydrateAllSeasonEpisodeDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList = []) {
  const lookupId = showSeasonLookupId(tmdbData);
  if (loading || !lookupId || !seasonsList.length) return;
  const pending = [];
  const cacheKeys = [];

  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    if (!Number.isFinite(seasonNumber) || seasonDetailsByNumber.has(seasonNumber)) continue;

    const cacheKey = `${lookupId}|${seasonNumber}`;
    if (_seasonDetailsInflight.has(cacheKey)) continue;

    _seasonDetailsInflight.add(cacheKey);
    cacheKeys.push(cacheKey);
    pending.push({ seasonNumber, cacheKey });
  }

  if (!pending.length) return;

  const results = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const entry = pending[nextIndex++];
      try {
        results.push({ seasonNumber: entry.seasonNumber, details: await fetchTmdbSeasonDetails(lookupId, entry.seasonNumber) });
      } catch (error) {
        console.error(`Failed to hydrate season ${entry.seasonNumber} episodes`, error);
        results.push({ seasonNumber: entry.seasonNumber, details: null });
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(SEASON_HYDRATION_CONCURRENCY, pending.length) }, () => worker()))
    .then(() => {
      let changed = false;
      for (const { seasonNumber, details } of results) {
        if (!details) continue;
        seasonDetailsByNumber.set(Number(seasonNumber), details);
        changed = true;
      }
      const current = state.activeShowRenderContext;
      const currentLookupId = showSeasonLookupId(current?.tmdbData) || lookupId;
      if (!changed || !state.showModalAllSeasonsExpanded || currentLookupId !== lookupId) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
        patchExisting: true,
      });
    })
    .catch((error) => console.error("Failed to hydrate all season episodes", error))
    .finally(() => {
      for (const cacheKey of cacheKeys) _seasonDetailsInflight.delete(cacheKey);
    });
}

// A show-scope watch action must operate on every season, not just the season
// currently expanded in the accordion. The detail view intentionally hydrates
// seasons lazily for display, so finish that hydration synchronously before the
// watch-date prompt is opened.
export async function ensureAllShowEpisodeDetailsForWatch() {
  const current = state.activeShowRenderContext;
  const show = current?.show;
  const tmdbData = current?.tmdbData;
  const seasonDetailsByNumber = current?.seasonDetailsByNumber;
  const lookupId = showSeasonLookupId(tmdbData);
  if (!show || !tmdbData || !seasonDetailsByNumber || !lookupId) return false;

  const seasonsMap = seasonsFromShowRecord(show);
  const knownSeasonNums = new Set((tmdbData.seasons || []).map((season) => Number(season.season_number)));
  const extraSeasons = [];
  for (const [seasonNum, epList] of seasonsMap.entries()) {
    if (!knownSeasonNums.has(seasonNum)) {
      extraSeasons.push({ season_number: seasonNum, episode_count: epList?.length || 0 });
    }
  }
  const seasonsList = [...(tmdbData.seasons?.length ? [...tmdbData.seasons, ...extraSeasons] : fallbackSeasonList(seasonsMap))]
    .filter((season) => Number(season.season_number) > 0)
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const pending = seasonsList.filter((season) => {
    const seasonNumber = Number(season.season_number);
    return Number.isFinite(seasonNumber) && !seasonDetailsByNumber.has(seasonNumber);
  });
  if (!pending.length) return true;

  const results = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const season = pending[nextIndex++];
      const seasonNumber = Number(season.season_number);
      try {
        results.push({ seasonNumber, details: await fetchTmdbSeasonDetails(lookupId, seasonNumber) });
      } catch (error) {
        console.error(`Failed to load season ${seasonNumber} for show watch action`, error);
        results.push({ seasonNumber, details: null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEASON_HYDRATION_CONCURRENCY, pending.length) }, () => worker()));

  const failed = [];
  let changed = false;
  for (const { seasonNumber, details } of results) {
    if (!details) {
      failed.push(seasonNumber);
      continue;
    }
    seasonDetailsByNumber.set(seasonNumber, details);
    changed = true;
  }

  const activeContext = state.activeShowRenderContext;
  const activeLookupId = showSeasonLookupId(activeContext?.tmdbData);
  if (changed && activeContext?.show && activeLookupId === lookupId) {
    renderShowModalContent(activeContext.show, {
      ...activeContext,
      seasonDetailsByNumber,
      loading: false,
      patchExisting: true,
    });
  }

  if (failed.length) {
    throw new Error(`Could not load season details for season${failed.length === 1 ? "" : "s"} ${failed.join(", ")}. Try again before marking the whole show watched.`);
  }
  return true;
}

function hydrateUnknownSeasonSummaryDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList = []) {
  const lookupId = showSeasonLookupId(tmdbData);
  if (loading || !lookupId || !seasonsList.length) return;
  const pending = [];
  const cacheKeys = [];

  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    if (!Number.isFinite(seasonNumber) || seasonNumber <= 0) continue;
    if (Number(season.episode_count || 0) > 0 || seasonDetailsByNumber.has(seasonNumber)) continue;

    const cacheKey = `${lookupId}|${seasonNumber}`;
    if (_seasonDetailsInflight.has(cacheKey)) continue;

    _seasonDetailsInflight.add(cacheKey);
    cacheKeys.push(cacheKey);
    pending.push({ seasonNumber, cacheKey });
  }

  if (!pending.length) return;

  const results = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const entry = pending[nextIndex++];
      try {
        results.push({ seasonNumber: entry.seasonNumber, details: await fetchTmdbSeasonDetails(lookupId, entry.seasonNumber) });
      } catch (error) {
        console.error(`Failed to hydrate season ${entry.seasonNumber} summary`, error);
        results.push({ seasonNumber: entry.seasonNumber, details: null });
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(SEASON_HYDRATION_CONCURRENCY, pending.length) }, () => worker()))
    .then(() => {
      let changed = false;
      for (const { seasonNumber, details } of results) {
        if (!details) continue;
        seasonDetailsByNumber.set(Number(seasonNumber), details);
        changed = true;
      }
      const current = state.activeShowRenderContext;
      const currentLookupId = showSeasonLookupId(current?.tmdbData) || lookupId;
      if (!changed || currentLookupId !== lookupId) return;
      renderShowModalContent(current?.show || show, {
        ...current,
        activeSeasonNum: state.activeShowModalSeason,
        tmdbData,
        seasonDetailsByNumber,
        loading: false,
        patchExisting: true,
      });
    })
    .catch((error) => console.error("Failed to refresh season summaries", error))
    .finally(() => {
      for (const cacheKey of cacheKeys) _seasonDetailsInflight.delete(cacheKey);
    });
}

function buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, resolvedTmdbId = "", tmdbData = null) {
  const watchedMap = watchedEpisodesByKey(show);
  const progressMap = playbackProgressByEpisode(show, resolvedTmdbId);
  const localSeasons = seasonsFromShowRecord(show);
  const showTvdbId = tmdbData?.tvdb_id || tmdbData?.external_ids?.tvdb_id || show.tvdb_id || "";
  const showImdbId = tmdbData?.imdb_id || tmdbData?.external_ids?.imdb_id || show.imdb_id || "";
  const rows = [];

  const knownNextEpisodes = new Map();
  for (const ep of [tmdbData?.next_episode_to_air, tmdbData?.last_episode_to_air]) {
    if (ep?.season_number != null && ep?.episode_number != null) {
      knownNextEpisodes.set(showEpisodeKey(Number(ep.season_number), Number(ep.episode_number)), ep);
    }
  }

  // Specials (season 0) are excluded from progress totals further down (via the
  // `> 0` filters on regularSeasonsList/regularEpisodeRows), but still need their
  // own episode rows built here so the Specials accordion has something to show.
  for (const season of seasonsList) {
    const seasonNumber = Number(season.season_number);
    const tmdbSeason = seasonDetailsByNumber.get(seasonNumber);
    const tmdbEpisodes = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes : [];
    const bundledSeasonPoster = season.poster_url || season.cached_poster_url || season.poster?.path || "";
    const fallbackPosterUrl = proxiedArtworkUrl(bundledSeasonPoster, "poster")
      || (!isDemoMode() && /^https?:\/\//i.test(season.poster_path || "") ? season.poster_path : tmdbPoster(season.poster_path))
      || posterUrlFor(representativeEpisode(localSeasons));
    const knownEpNums = new Set();

    if (tmdbEpisodes.length) {
      for (const episode of tmdbEpisodes) {
        const episodeNumber = Number(episode.episode_number);
        knownEpNums.add(episodeNumber);
        const watched = watchedEpisodeFor(watchedMap, seasonNumber, episodeNumber);
        rows.push({
          key: showEpisodeKey(seasonNumber, episodeNumber),
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          showTvdbId,
          showImdbId,
          tmdbId: episode.id || "",
          seasonNumber,
          episodeNumber,
          title: episode.name || episodeTitle(watched?.title, episodeNumber),
          overview: episode.overview || "No synopsis available.",
          airDate: episode.air_date || "",
          airTime: episode.air_time || episode.airTime || episode.airtime || "",
          runtime: episode.runtime ?? null,
          stillUrl: tmdbImage(episode.still_path, "w300"),
          posterUrl: fallbackPosterUrl,
          watched,
          progress: progressMap.get(showEpisodeKey(seasonNumber, episodeNumber)) || null,
        });
      }

      const totalEpCount = Number(season.episode_count || 0);
      for (let epNum = 1; epNum <= totalEpCount; epNum++) {
        if (knownEpNums.has(epNum)) continue;
        knownEpNums.add(epNum);
        const key = showEpisodeKey(seasonNumber, epNum);
        const hint = knownNextEpisodes.get(key);
        const watched = watchedEpisodeFor(watchedMap, seasonNumber, epNum);
        rows.push({
          key,
          showTitle: show.title,
          showTmdbId: resolvedTmdbId || show.tmdb_id || "",
          showTvdbId,
          showImdbId,
          tmdbId: hint?.id || "",
          seasonNumber,
          episodeNumber: epNum,
          title: hint?.name || episodeTitle(watched?.title, epNum),
          overview: hint?.overview || "No synopsis available.",
          airDate: hint?.air_date || "",
          airTime: hint?.air_time || hint?.airTime || hint?.airtime || "",
          runtime: hint?.runtime ?? null,
          stillUrl: hint ? tmdbImage(hint.still_path, "w300") : "",
          posterUrl: fallbackPosterUrl,
          watched,
          progress: progressMap.get(key) || null,
        });
      }
    }

    for (const watched of localSeasons.get(seasonNumber) || []) {
      const episodeNumber = Number(watched.episode);
      if (knownEpNums.has(episodeNumber)) continue;
      knownEpNums.add(episodeNumber);
      rows.push({
        key: showEpisodeKey(seasonNumber, episodeNumber),
        showTitle: show.title,
        showTmdbId: resolvedTmdbId || show.tmdb_id || "",
        showTvdbId,
        showImdbId,
        tmdbId: watched.tmdb_id || "",
        seasonNumber,
        episodeNumber,
        title: episodeTitle(watched.title, episodeNumber),
        overview: tmdbEpisodes.length ? "Episode synopsis unavailable." : "TMDB metadata is still loading.",
        airDate: "",
        airTime: "",
        runtime: watched.runtime ?? null,
        stillUrl: "",
        posterUrl: fallbackPosterUrl,
        watched,
        progress: progressMap.get(showEpisodeKey(seasonNumber, episodeNumber)) || null,
      });
    }
  }

  return rows.sort((a, b) => b.seasonNumber - a.seasonNumber || b.episodeNumber - a.episodeNumber);
}

function episodeThumbMarkup(episode, hideSpoilers = false) {
  if (hideSpoilers && !episode.watched) {
    return `<img class="episode-thumb episode-spoiler-placeholder" src="/spoiler-placeholder.svg" alt="Episode artwork hidden" />`;
  }
  const stillUrl = isCachedStorageImageUrl(episode.stillUrl) ? episode.stillUrl : (isDemoMode() ? "" : safeImageUrl(episode.stillUrl));
  const posterUrl = isCachedStorageImageUrl(episode.posterUrl)
    ? episode.posterUrl
    : (isDemoMode() ? "" : safeImageUrl(episode.posterUrl) || episode.posterUrl || "");
  const url = stillUrl || posterUrl;
  if (!url) return `<span class="episode-thumb poster-fallback" aria-hidden="true"></span>`;
  const onerrorAttr = stillUrl && posterUrl && stillUrl !== posterUrl
    ? ` onerror="this.onerror=null;this.src=this.dataset.fallback" data-fallback="${escapeAttribute(posterUrl)}"`
    : "";
  return `<img class="episode-thumb" src="${escapeAttribute(url)}" alt="${escapeAttribute(episode.title)} thumbnail" loading="lazy" decoding="async" referrerpolicy="no-referrer"${onerrorAttr} />`;
}

function episodeReleaseLabel(airDate) {
  return airDate ? `Released ${formatTmdbDate(airDate)}` : "Release date unknown";
}

function episodeWatchHistoryLoadingHtml() {
  return `
    <div class="episode-watch-history episode-watch-history--loading" role="status" aria-label="Loading watch dates">
      <span class="episode-watch-history-skeleton episode-watch-history-skeleton--date" aria-hidden="true"></span>
      <span class="episode-watch-history-skeleton episode-watch-history-skeleton--source" aria-hidden="true"></span>
    </div>
  `;
}

// Full watch history list (each play's date + source app) shown below the
// release metadata for every watched episode - see playHistory
// ({ id, watched_at, source }[]) built server-side in dedupeHistory
// (server/src/utils/dataRepo.js).
function episodeWatchHistoryHtml(watched, { loading = false } = {}) {
  // playHistory also retains unwatched transition rows for audit/date-edit
  // purposes. They are not plays, so never render them as "Watched" entries in
  // the episode card when an older cached row still carries them.
  const history = actualWatchHistory(watched).filter(isWatchedHistoryAction);
  if (!history.length) return loading ? episodeWatchHistoryLoadingHtml() : "";
  const aggregateSources = platformSourceValues(watched);
  const rows = [...history]
    .sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))
    .map((entry, index) => `
      <li class="episode-watch-history-row">
        <span class="episode-watch-history-date">Watched - ${escapeHtml(formatDate(entry.watched_at))}</span>
        ${(index === 0 ? aggregateSources : platformSourceValues(entry)).map((source) => sourceBadgeHtml(source)).join(" ")}
        ${index === 0
        ? `<button class="edit-date-icon-btn episode-edit-date-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(entry.id || watched.id || "")}" data-watched-at="${escapeAttribute(entry.watched_at || "")}">✎</button>`
        : ""}
      </li>
    `)
    .join("");
  return `
    <div class="episode-watch-history">
      <ul class="episode-watch-history-list">${rows}</ul>
    </div>
  `;
}

function episodeProgressHtml(episode) {
  if (episode.watched || !episode.progress) return "";
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(episode.progress.progress || 0))));
  if (!progressPercent) return "";
  return `
    <span class="episode-progress-badge" title="${escapeAttribute(`${progressPercent}% watched`)}">
      <span>Part watched</span>
      <small>${progressPercent}%</small>
    </span>
  `;
}

function episodeProgressBarHtml(episode) {
  if (episode.watched || !episode.progress) return "";
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(episode.progress.progress || 0))));
  if (!progressPercent) return "";
  return `
    <div class="episode-progress-inline" aria-label="${escapeAttribute(`${progressPercent}% watched`)}">
      <div class="episode-progress-track">
        <div class="episode-progress-fill" style="width: ${progressPercent}%;"></div>
      </div>
      <span>${progressPercent}% watched</span>
    </div>
  `;
}

function showModalStatus(loading, hasTmdbData) {
  if (!loading && !hasTmdbData) return `<span class="show-load-pill muted">Season and episode metadata was unavailable.</span>`;
  return "";
}

function directChildWithClass(parent, className) {
  return [...(parent?.children || [])].find((child) => child.classList?.contains(className)) || null;
}

function cloneChildNodes(node) {
  return [...(node?.childNodes || [])].map((child) => child.cloneNode(true));
}

function syncPosterLoadingState(currentHeader, nextHeader) {
  const currentFrame = currentHeader?.querySelector(".immersive-poster-frame");
  const nextFrame = nextHeader?.querySelector(".immersive-poster-frame");
  if (!currentFrame || !nextFrame) return;

  const isLoading = nextFrame.classList.contains("is-loading");
  currentFrame.classList.toggle("is-loading", isLoading);
  if (isLoading) currentFrame.setAttribute("aria-busy", "true");
  else currentFrame.removeAttribute("aria-busy");

  const currentStatus = currentFrame.querySelector(".immersive-poster-loading");
  const nextStatus = nextFrame.querySelector(".immersive-poster-loading");
  if (nextStatus && !currentStatus) currentFrame.appendChild(nextStatus.cloneNode(true));
  else if (!nextStatus) currentStatus?.remove();
}

// The first show render can use a representative episode still while the
// canonical show metadata is loading. Keep the existing image node mounted so
// its layout/lightbox state survives enrichment, but do update its source when
// the authoritative show poster arrives.
function syncPosterImage(currentHeader, nextHeader) {
  const currentPoster = currentHeader?.querySelector(".immersive-poster-img");
  const nextPoster = nextHeader?.querySelector(".immersive-poster-img");
  if (!currentPoster || !nextPoster) return;

  const nextSrc = nextPoster.getAttribute("src") || "";
  const nextLightboxSrc = nextPoster.getAttribute("data-lightbox-src") || "";
  // A placeholder/fallback render must not overwrite a real poster that is
  // already mounted. Real poster markup always carries a lightbox source.
  if (!nextSrc || !nextLightboxSrc) return;

  const currentSrc = currentPoster.getAttribute("src") || "";
  const currentLightboxSrc = currentPoster.getAttribute("data-lightbox-src") || "";
  if (currentSrc === nextSrc && currentLightboxSrc === nextLightboxSrc) return;

  currentPoster.classList.remove("is-loaded");
  currentPoster.setAttribute("src", nextSrc);
  currentPoster.setAttribute("data-lightbox-src", nextLightboxSrc);
  currentPoster.setAttribute("alt", nextPoster.getAttribute("alt") || "Media poster");
}

// Metadata arrives after the local watched record. Replacing the complete
// detail subtree for every enrichment pass recreated posters, episode images,
// and the scrollable season list. Build the next markup off-DOM, then patch the
// independently hydratable regions in place. The first render still uses the
// normal full markup path; only later enrichment passes use this function.
function patchShowModalDom(root, nextMarkup) {
  const currentPage = directChildWithClass(root, "media-detail-page");
  if (!currentPage) {
    root.innerHTML = nextMarkup;
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = String(nextMarkup || "").trim();
  const nextPage = template.content.querySelector(".media-detail-page");
  if (!nextPage) {
    root.innerHTML = nextMarkup;
    return;
  }

  const scrollHost = nearestScrollableAncestor(currentPage);
  const scrollTop = scrollHost?.scrollTop;
  const currentBackdrop = directChildWithClass(root, "modal-backdrop-image");
  const nextBackdrop = directChildWithClass(template.content, "modal-backdrop-image");
  if (currentBackdrop && nextBackdrop) currentBackdrop.setAttribute("style", nextBackdrop.getAttribute("style") || "");

  const currentHeader = directChildWithClass(currentPage, "immersive-header");
  const nextHeader = directChildWithClass(nextPage, "immersive-header");
  if (currentHeader && nextHeader) {
    // Keep the poster image mounted across metadata passes, but update its
    // source and loading overlay when the authoritative detail request settles.
    syncPosterImage(currentHeader, nextHeader);
    syncPosterLoadingState(currentHeader, nextHeader);
    const currentMeta = currentHeader.querySelector(".immersive-meta");
    const nextMeta = nextHeader.querySelector(".immersive-meta");
    const currentBottom = currentMeta?.querySelector(".media-detail-bottom-stack");
    const nextBottom = nextMeta?.querySelector(".media-detail-bottom-stack");

    if (currentMeta && nextMeta && currentBottom && nextBottom) {
      // The title/logo is a small identity region. Replace only that region;
      // the poster itself stays mounted, so its request and lightbox state live.
      [...currentMeta.children]
        .filter((child) => child !== currentBottom)
        .forEach((child) => child.remove());
      const nextIdentity = [...nextMeta.children].filter((child) => child !== nextBottom);
      nextIdentity.forEach((child) => currentMeta.insertBefore(child.cloneNode(true), currentBottom));

      currentBottom.replaceChildren(...cloneChildNodes(nextBottom));
    }

    const currentSidebar = currentHeader.querySelector(".immersive-sidebar");
    const nextSidebar = nextHeader.querySelector(".immersive-sidebar");
    if (currentSidebar && nextSidebar) {
      const wasOpen = currentSidebar.querySelector(".media-facts-details")?.open;
      const replacement = nextSidebar.cloneNode(true);
      const replacementDetails = replacement.querySelector(".media-facts-details");
      if (wasOpen != null && replacementDetails) replacementDetails.open = wasOpen;
      currentSidebar.replaceWith(replacement);
    } else if (!currentSidebar && nextSidebar) {
      currentHeader.appendChild(nextSidebar.cloneNode(true));
    } else if (currentSidebar && !nextSidebar) {
      currentSidebar.remove();
    }
  }

  const sectionClasses = [
    "season-accordions",
    "cast-section",
    "media-images-section",
    "trailers-section",
    "reviews-section",
    "related-section",
  ];
  for (const className of sectionClasses) {
    const currentSection = directChildWithClass(currentPage, className);
    const nextSection = directChildWithClass(nextPage, className);
    if (currentSection && nextSection) {
      currentSection.replaceWith(nextSection.cloneNode(true));
    } else if (currentSection && !nextSection) {
      currentSection.remove();
    } else if (!currentSection && nextSection) {
      const nextIndex = sectionClasses.indexOf(className);
      const following = [...currentPage.children].find((child) => {
        const existingClass = sectionClasses.find((candidate) => child.classList?.contains(candidate));
        return existingClass && sectionClasses.indexOf(existingClass) > nextIndex;
      });
      currentPage.insertBefore(nextSection.cloneNode(true), following || null);
    }
  }

  if (scrollHost && Number.isFinite(scrollTop)) scrollHost.scrollTop = scrollTop;
  return true;
}

function seasonEpisodeTotal(seasonNumber, seasonEpisodes, season, seasonDetailsByNumber) {
  const tmdbSeason = seasonDetailsByNumber?.get(Number(seasonNumber));
  const tmdbEpisodeCount = Array.isArray(tmdbSeason?.episodes) ? tmdbSeason.episodes.length : 0;
  return Math.max(seasonEpisodes.length, tmdbEpisodeCount, Number(season.episode_count || 0));
}

function showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle = "", tmdbData = null, seasonDetailsByNumber = null) {
  const watchedInSeason = seasonEpisodes.filter((episode) => episode.watched).length;
  const watchSummary = watchSummaryForRows(seasonEpisodes);
  const seasonTotal = seasonEpisodeTotal(seasonNumber, seasonEpisodes, season, seasonDetailsByNumber);
  const today = toDateInputValue(new Date());
  let nextAiring = seasonEpisodes
    .filter((episode) => !episode.watched && episode.airDate && episode.airDate >= today)
    .sort((a, b) => a.airDate.localeCompare(b.airDate) || Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0))[0] || null;
  const tmdbNextEpisode = tmdbData?.next_episode_to_air;
  if (
    !nextAiring &&
    tmdbNextEpisode?.air_date &&
    tmdbNextEpisode.air_date >= today &&
    Number(tmdbNextEpisode.season_number) === Number(seasonNumber)
  ) {
    nextAiring = {
      airDate: tmdbNextEpisode.air_date,
      airTime: tmdbNextEpisode.air_time || tmdbNextEpisode.airTime || tmdbNextEpisode.airtime || "",
      episodeNumber: tmdbNextEpisode.episode_number,
    };
  }
  const nextAiringText = nextAiring
    ? `Next Airing ${formatLongAiringDate(nextAiring.airDate)} (${formatEpisodeAirtime(nextAiring, showTitle)})`
    : "";
  return { ...watchSummary, watchedInSeason, seasonTotal, nextAiring, nextAiringText };
}

function renderEpisodeRowHtml(episode, {
  showTitle = "",
  tvSeerrStatus = {},
  savingEpisodeKeys = new Set(),
  isUnreleased = () => false,
  loading = false,
  hideSpoilers = false,
  watchHistoryLoading = false,
  seasonDataPending = false,
} = {}) {
  const isHighlighted = (Number(episode.seasonNumber) === Number(state.activeShowModalSeason))
    && (Number(episode.episodeNumber) === Number(state.activeShowModalEpisode));
  const syncStatusDotHtml = episode.watched ? renderSyncStatusDot(episode.watched) : "";
  const episodeIsUnreleased = isUnreleased(episode);
  const playHistory = actualWatchHistory(episode.watched);
  const hasWatchHistory = playHistory.length > 0;
  const episodeWatchHistoryPending = Boolean(watchHistoryLoading && episode.watched && !hasWatchHistory);
  const episodeBusy = savingEpisodeKeys.has(episode.key);
  const episodeUnwatching = Boolean(episode.watched && state.savingUnwatchIds.has(episode.watched.id));
  const episodeSyncing = isMediaSyncing(episode.watched || episode);
  const episodeTilesLoading = Boolean(loading || watchHistoryLoading || seasonDataPending);
  const episodeAvailabilityPillsHtml = `${episodeProgressHtml(episode)}${episodeResolutionPillHtml(tvSeerrStatus, episode.seasonNumber, episode.episodeNumber)}`;
  const hasEpisodeAvailability = Boolean(`${syncStatusDotHtml}${episodeAvailabilityPillsHtml}`.trim());
  const personalEpisodeRatingHtml = personalEpisodeRatingButtonHtml({
    media_type: "episode",
    title: episode.title,
    show_title: episode.showTitle || showTitle,
    tmdb_id: episode.showTmdbId || "",
    tvdb_id: episode.showTvdbId || "",
    show_tmdb_id: episode.showTmdbId || "",
    show_tvdb_id: episode.showTvdbId || "",
    show_imdb_id: episode.showImdbId || "",
    episode_tmdb_id: episode.tmdbId || "",
    episode_tvdb_id: episode.tvdbId || "",
    episode_imdb_id: episode.imdbId || "",
    poster_url: episode.stillUrl || episode.posterUrl || "",
    overview: episode.overview,
    release_date: episode.airDate,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
  });
  const episodeActionMarkup = episodeIsUnreleased
    ? `<span class="unreleased-pill">Not yet released</span>`
    : !episode.watched
      ? episodeBusy || episodeSyncing
        ? `<button class="action-pill" type="button" disabled>${episodeSyncing ? "Syncing…" : "Saving…"}</button>`
        : `<button class="action-pill" type="button" data-watch-scope="episode" data-episode-key="${escapeAttribute(episode.key)}">Mark watched</button>`
      : episodeUnwatching || episodeSyncing
        ? `<button class="action-pill action-pill-ghost" type="button" disabled>${episodeSyncing ? "Syncing…" : "Unwatching…"}</button>`
        : `<button class="action-pill action-pill-ghost" type="button" ${episodeBusy ? "disabled" : ""} data-unwatch-id="${escapeAttribute(episode.watched.id)}" data-unwatch-kind="episode" data-unwatch-label="${escapeAttribute(`${episodeCode(episode.seasonNumber, episode.episodeNumber)} ${episode.title}`)}" data-show-title="${escapeAttribute(episode.showTitle || showTitle)}">Mark unwatched</button>`;
  return `
            <article class="immersive-episode-row ${episode.watched ? "is-watched" : ""} ${episodeIsUnreleased ? "is-unreleased" : ""} ${isHighlighted ? "is-highlighted" : ""} ${(episodeBusy || episodeUnwatching || episodeSyncing) ? "is-saving" : ""} ${episodeTilesLoading ? "is-loading-data" : ""}" ${isHighlighted ? 'id="highlightedEpisode"' : ""} ${episodeTilesLoading || episodeSyncing ? 'aria-busy="true"' : ""} data-immersive-episode-key="${escapeAttribute(episode.key)}" data-immersive-episode-num="${episode.episodeNumber}" data-immersive-season-num="${episode.seasonNumber}">
              <div class="episode-thumb-wrap">
                ${episodeThumbMarkup(episode, hideSpoilers)}
                ${(episodeBusy || episodeUnwatching || episodeSyncing) ? `<span class="episode-thumb-syncing">Syncing…</span>` : ""}
              </div>
              <div class="immersive-episode-copy">
                <div class="immersive-episode-title-row">
                  <b class="immersive-episode-heading">
                    ${escapeHtml(episodeCode(episode.seasonNumber, episode.episodeNumber))} ${escapeHtml(episode.title)}
                  </b>
                  <div class="immersive-episode-availability${hasEpisodeAvailability ? " has-availability" : ""}">
                    <span class="immersive-episode-availability-pills">${syncStatusDotHtml}${episodeAvailabilityPillsHtml}</span>
                    ${personalEpisodeRatingHtml}
                  </div>
                </div>
                <div class="immersive-episode-copy-wrap"><p>${escapeHtml(hideSpoilers && !episode.watched ? "Synopsis hidden to avoid spoilers." : episode.overview)}</p></div>
                ${episodeProgressBarHtml(episode)}
                <div class="immersive-episode-meta-row">
                  <span class="immersive-episode-dates">
                    <time datetime="${escapeAttribute(episode.airDate || "")}">${escapeHtml(episodeReleaseLabel(episode.airDate))}</time>
                  </span>
                  <span class="immersive-episode-actions">
                    ${episodeActionMarkup}
                  </span>
                </div>
                ${hasWatchHistory ? episodeWatchHistoryHtml(episode.watched) : episodeWatchHistoryPending ? episodeWatchHistoryLoadingHtml() : ""}
              </div>
            </article>
          `;
}

function renderSeasonPanelHtml(seasonNumber, seasonRecord, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, savingEpisodeKeys, isUnreleased, loading, hideSpoilers, watchHistoryLoading) {
  if (!seasonRecord) return "";
  // This season's own episode data hasn't come back yet (it's fetched lazily,
  // one season at a time, once expanded - see hydrateMissingSeasonDetails).
  // Distinguishing this from "loading" (the whole show is still bootstrapping)
  // matters for the empty-state message below: without it, a season with no
  // locally-watched episodes yet would wrongly claim to have none at all
  // while its real episode list is still in flight.
  const seasonDataPending = !loading && Boolean(showSeasonLookupId(tmdbData)) && !seasonDetailsByNumber?.has(Number(seasonNumber));
  const seasonEpisodes = episodeRows
    .filter((episode) => episode.seasonNumber === seasonNumber)
    .sort((a, b) => Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0));
  const seasonUnwatched = seasonEpisodes.filter((episode) => !episode.watched && !isUnreleased(episode));
  const seasonUnreleased = seasonEpisodes.filter((episode) => !episode.watched && isUnreleased(episode));
  const seasonSummary = showSeasonSummary(seasonNumber, seasonEpisodes, seasonRecord, showTitle, tmdbData, seasonDetailsByNumber);
  const seasonSeerrControls = renderSeasonSeerrControls(tvSeerrTmdbId, seasonNumber, tvSeerrStatus);
  const seasonWatchCount = seasonSummary.totalWatches > seasonSummary.watchedInSeason
    ? ` · ${seasonSummary.totalWatches} actual watches`
    : "";
  const seasonRemoving = seasonEpisodes.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
  // A season/show-scope action's episodes/resyncEpisodes cover every episode in
  // its scope, so "does any episode in this season overlap an in-flight
  // action" is enough to know the season (or the whole show) is mid-sync -
  // other seasons stay clickable in the meantime.
  const seasonBusy = hasSavingWatchActionForShow(showTitle, seasonNumber)
    || seasonEpisodes.some((episode) => savingEpisodeKeys.has(episode.key));
  const seasonSyncing = seasonEpisodes.some((episode) => isMediaSyncing(episode.watched || episode));
  const episodeTilesLoading = Boolean(loading || watchHistoryLoading || seasonDataPending);
  const seasonFullyWatched = !seasonRemoving
    && seasonSummary.seasonTotal > 0
    && seasonSummary.watchedInSeason >= seasonSummary.seasonTotal;
  const seasonActionControlsHtml = `
          ${seasonSeerrControls}
          ${seasonSummary.watchedInSeason ? `<button class="action-pill" type="button" data-edit-season-date="${seasonNumber}" ${(seasonBusy || seasonRemoving || seasonSyncing) ? "disabled" : ""}>Edit season date</button>` : ""}
          <button class="action-pill" type="button" data-watch-scope="season" data-season-number="${seasonNumber}" ${(seasonEpisodes.length && !seasonBusy && !seasonRemoving && !seasonSyncing) ? "" : "disabled"}
            title="${seasonUnreleased.length ? "Some episodes are unreleased and will require confirmation" : seasonUnwatched.length ? "" : "Re-push this season's watched state to Plex, Emby, Jellyfin & Trakt"}">
            ${seasonSyncing ? "Syncing…" : seasonBusy ? "Saving…" : seasonUnwatched.length || seasonUnreleased.length ? "Mark season watched" : "Resync season"}
          </button>${seasonUnwatchButtonHtml(seasonEpisodes.filter((episode) => episode.watched).map((episode) => episode.watched.id), seasonNumber, showTitle, seasonBusy || seasonSyncing, seasonRemoving)}`;
  return `
    <section class="show-season-block" id="showSeason${seasonNumber}">
      <div class="show-season-head">
        <div class="show-season-summary">
          <span class="show-season-label${seasonFullyWatched ? " is-complete" : ""}">${seasonRemoving ? "Removing…" : `${seasonSummary.watchedInSeason} of ${seasonSummary.seasonTotal || "?"} episodes watched${seasonWatchCount}`}</span>
          ${seasonDataPending && seasonEpisodes.length ? `<span class="show-load-pill"><span class="empty-log-spinner empty-log-spinner--inline" aria-hidden="true"></span>Loading more episodes...</span>` : ""}
          <details class="season-mobile-action-menu">
            <summary class="season-mobile-action-trigger">Season options</summary>
            <div class="season-mobile-action-controls">${seasonActionControlsHtml}</div>
          </details>
        </div>
        <div class="season-desktop-action-controls">${seasonActionControlsHtml}</div>
      </div>
      <div class="show-episode-list">
        ${seasonEpisodes.length ? seasonEpisodes.map((episode) => renderEpisodeRowHtml(episode, {
          showTitle,
          tvSeerrStatus,
          savingEpisodeKeys,
          isUnreleased,
          loading,
          hideSpoilers,
          watchHistoryLoading,
          seasonDataPending,
        })).join("") : (loading || seasonDataPending)
    ? `<div class="empty-log empty-log--loading"><span class="empty-log-spinner" aria-hidden="true"></span><div><b>Loading episodes…</b><span>Fetching this season's episode details.</span></div></div>`
    : `<div class="empty-log"><b>No episode rows yet</b><span>No local or TVDB episodes were found for this season.</span></div>`}
      </div>
    </section>
  `;
}

export function renderShowModalContent(show, {
  activeSeasonNum = null,
  tmdbData = null,
  seasonDetailsByNumber = new Map(),
  loading = false,
  watchHistoryLoading = false,
  tmdbOnly = false,
  imdbPillHtml = "",
  patchExisting = false,
} = {}) {
  const root = mediaDetailRoot();
  show = mergeShowWithLoadedHistory(show);
  const seasonsMap = seasonsFromShowRecord(show);
  const showTitle = sanitizeTitle(show.title) || "Unknown Show";
  // Any episode key covered by an in-flight watch action for this show - a
  // season/show-scope action's episodes/resyncEpisodes already cover every
  // episode in its scope. The action-level check below keeps the show/season
  // controls busy even after individual SSE rows have cleared their own
  // Saving state; per-episode buttons narrow it to the remaining keys.
  const savingEpisodeKeys = savingEpisodeKeysForShow(showTitle);
  const isShowBusy = savingEpisodeKeys.size > 0 || hasSavingWatchActionForShow(showTitle);
  const isUnmatchedShow = isUnmatchedShowTitle(showTitle);
  const orphanHistoryId = show.unmatched_history_id || "";
  // Specials (season 0) are kept in the list so they're still browsable, but
  // are excluded from the progress totals below - a "100 of 100" show isn't
  // meant to imply specials don't exist, just that they don't count toward it.
  const knownSeasonNums = new Set((tmdbData?.seasons || []).map((s) => Number(s.season_number)));
  const extraSeasons = [];
  for (const [seasonNum, epList] of seasonsMap.entries()) {
    if (!knownSeasonNums.has(seasonNum)) {
      extraSeasons.push({
        season_number: seasonNum,
        name: seasonLabel(seasonNum),
        episode_count: epList?.length || 0,
        poster_path: null,
      });
    }
  }
  const seasonsList = [...(tmdbData?.seasons?.length ? [...tmdbData.seasons, ...extraSeasons] : fallbackSeasonList(seasonsMap))]
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const regularSeasonsList = seasonsList.filter((season) => Number(season.season_number) > 0);
  const selectedSeason = activeSeasonNum == null ? null : Number(activeSeasonNum);
  const episodeRows = buildShowEpisodeRows(show, seasonsList, seasonDetailsByNumber, tmdbData?.id || show.tmdb_id || "", tmdbData);
  const regularEpisodeRows = episodeRows.filter((episode) => Number(episode.seasonNumber) > 0);
  const watchedRows = regularEpisodeRows.filter((episode) => episode.watched);
  const syncingEpisodeRows = regularEpisodeRows.filter((episode) => isMediaSyncing(episode.watched || episode));
  const showSyncing = syncingEpisodeRows.length > 0;
  const showWatchSummary = watchSummaryForRows(regularEpisodeRows);
  const metadataEpisodeCount = regularSeasonsList.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(regularEpisodeRows.length, metadataEpisodeCount, watchedRows.length, 1);
  const watchedCount = watchedRows.length || [...watchedEpisodesByKey(show).keys()].length;
  const totalWatches = Math.max(showWatchSummary.totalWatches, watchedCount);
  const watchHistoryLabel = totalWatches > watchedCount
    ? ` · ${totalWatches} actual watches`
    : "";
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const showRemoving = watchedRows.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
  const watchProgressLabel = showRemoving ? "Removing…" : `${watchedCount} of ${totalCount} episodes watched${watchHistoryLabel}`;
  const representative = representativeEpisode(seasonsMap);
  const backdropUrl = proxiedArtworkUrl(show.backdrop_url, "backdrop") || tmdbData?.cached_backdrop_url || tmdbImage(tmdbData?.backdrop_path, "original");
  const showPosterUrl = show.show_poster_url || show.canonical_poster_url || "";
  const posterUrl = posterUrlFor({ ...show, poster_url: showPosterUrl, prefer_raw_poster: true, prefer_show_poster: true })
    || proxiedArtworkUrl(tmdbData?.cached_poster_url, "poster")
    || tmdbPoster(tmdbData?.poster_path, tmdbData?.id, "tv")
    || posterUrlFor(representative)
    || posterUrlFor(show);
  const logoUrl = proxiedArtworkUrl(show.logo_url || bestTmdbLogo(tmdbData), "logo");
  const overview = tmdbData?.overview || "No synopsis available.";
  const localEvidence = !tmdbData && isUnmatchedShow
    ? (() => {
      const records = Array.isArray(show.episodes) && show.episodes.length
        ? show.episodes
        : [show.representative_episode || show.representativeEpisode, ...(state.history || [])
          .filter((record) => record.media_type === "episode" && (!record.show_title || slug(showTitleFrom(record.show_title || record.title)) === "unknown-show"))]
          .filter(Boolean);
      if (!records.length) return "";
      const recordRows = records.slice(0, 6).map((record) => {
        const episodeLabel = record.season != null && record.episode != null
          ? `S${String(record.season).padStart(2, "0")}E${String(record.episode).padStart(2, "0")}`
          : "Episode details unavailable";
        const recordedTitle = record.title && record.title !== showTitle ? record.title : "Recorded title unavailable";
        const watchedDate = record.watched_at ? formatDate(record.watched_at) : "Date unavailable";
        const source = record.source ? ` · ${record.source}` : "";
        return `<li><b>${escapeHtml(episodeLabel)}</b> ${escapeHtml(recordedTitle)}<span>${escapeHtml(`${watchedDate}${source}`)}</span></li>`;
      }).join("");
      return `<section class="unknown-show-evidence"><h3>Available local details</h3><p>This record has no matched metadata yet. These details can help identify it before matching:</p><ul>${recordRows}</ul></section>`;
    })()
    : "";
  const premiered = tmdbData?.first_air_date ? `Premiered ${formatTmdbDate(tmdbData.first_air_date)}` : "Release date unknown";
  const rating = tmdbData?.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
  const tvData = tmdbData ? { ...tmdbData, tvdb_id: tmdbData.tvdb_id || tmdbData.external_ids?.tvdb_id || show.tvdb_id || "" } : { tvdb_id: show.tvdb_id || "", id: show.tmdb_id || "" };
  const ratingPillsHtml = renderExternalRatingPills("tv", tvData, showTitle, rating);
  const personalMediaItem = {
    media_type: "tv",
    title: showTitle,
    tmdb_id: tmdbData?.id || show.tmdb_id || "",
    tvdb_id: tmdbData?.tvdb_id || tmdbData?.external_ids?.tvdb_id || show.tvdb_id || "",
    imdb_id: tmdbData?.imdb_id || tmdbData?.external_ids?.imdb_id || show.imdb_id || "",
    poster_url: posterUrl,
    overview,
    release_date: tmdbData?.first_air_date || show.first_air_date || "",
  };
  const personalRatingHtml = personalRatingPillHtml(personalMediaItem);
  const ratingsFactHtml = `${ratingPillsHtml}${imdbPillHtml}${personalRatingHtml}`;
  const appLinksFactHtml = tmdbData ? mediaAppLinksHtml(tmdbData, "tv") : "";
  const tvSeerrTmdbId = tmdbData?.id || show.tmdb_id || "";
  const tvSeerrCacheKey = `tv:${tvSeerrTmdbId}`;
  const hasTvSeerrStatus = Boolean(tvSeerrTmdbId && state.seerrMediaStatusCache.has(tvSeerrCacheKey));
  const tvSeerrStatus = state.seerrMediaStatusCache.get(tvSeerrCacheKey) || {};
  const showIsNowPlaying = state.activeSessions.some((s) => {
    if (tvSeerrTmdbId && String(s.ids?.tmdb || "") === String(tvSeerrTmdbId)) return true;
    const sessionShowTitle = showTitleFrom(s.showTitle || s.show_title || s.title || "");
    return Boolean(sessionShowTitle && slug(sessionShowTitle) === slug(showTitle));
  });

  state.showModalEpisodes = episodeRows;
  state.showModalEpisodeIndex = new Map(episodeRows.map((episode) => [episode.key, episode]));
  state.activeShowRenderContext = { show, activeSeasonNum, tmdbData, seasonDetailsByNumber, loading, watchHistoryLoading, imdbPillHtml };

  const allSeasonsExpanded = state.showModalAllSeasonsExpanded;
  const selectedSeasonRecord = selectedSeason == null
    ? null
    : seasonsList.find((season) => Number(season.season_number) === selectedSeason) || { season_number: selectedSeason };
  const selectedSeasonNumber = selectedSeasonRecord ? Number(selectedSeasonRecord.season_number) : null;
  const isUnreleased = (episode) => {
    if (episode.watched) return false;
    if (!episode.airDate) return false;
    const parts = episode.airDate.split("-");
    if (parts.length !== 3) return false;
    const air = new Date(parts[0], parts[1] - 1, parts[2]);
    return !Number.isNaN(air.getTime()) && air > new Date();
  };
  const unwatchedRows = episodeRows.filter((episode) => !episode.watched && !isUnreleased(episode));
  const unreleasedRows = episodeRows.filter((episode) => !episode.watched && isUnreleased(episode));
  // The visible rows are lazy-loaded by season. Metadata still tells us when
  // the show has episodes outside the active season, so keep the show-wide
  // action available until the full episode set has been hydrated.
  const hasPotentialUnwatchedEpisodes = unwatchedRows.length > 0 || unreleasedRows.length > 0 || watchedCount < metadataEpisodeCount;
  const canStartShowWatch = episodeRows.length > 0 || metadataEpisodeCount > 0;
  const hideSpoilers = state.hideEpisodeSpoilers;

  setMediaInfoContext({
    mediaType: "tv",
    media: show,
    tmdbData,
    posterUrl,
    overview,
    summary: { watchedCount, totalCount, progressPercent, totalWatches, rewatchedEpisodes: showWatchSummary.rewatchedEpisodes },
    records: episodeRows.map((episode) => episode.watched).filter(Boolean),
  });

  // Normally only the selected season's episode list is built/rendered - the
  // rest stay collapsed and unbuilt. "Expand all" (state.showModalAllSeasonsExpanded)
  // builds a panel for every season instead, so the accordion below can render
  // them all open at once.
  const seasonPanelsByNumber = new Map();
  if (allSeasonsExpanded) {
    for (const season of seasonsList) {
      const seasonNumber = Number(season.season_number);
      seasonPanelsByNumber.set(seasonNumber, renderSeasonPanelHtml(seasonNumber, season, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, savingEpisodeKeys, isUnreleased, loading, hideSpoilers, watchHistoryLoading));
    }
  } else if (selectedSeasonRecord) {
    seasonPanelsByNumber.set(selectedSeasonNumber, renderSeasonPanelHtml(selectedSeasonNumber, selectedSeasonRecord, episodeRows, showTitle, tmdbData, seasonDetailsByNumber, tvSeerrTmdbId, tvSeerrStatus, savingEpisodeKeys, isUnreleased, loading, hideSpoilers, watchHistoryLoading));
  }

  if (allSeasonsExpanded) {
    hydrateAllSeasonEpisodeDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList);
  } else {
    hydrateMissingSeasonDetails(show, selectedSeasonNumber, tmdbData, seasonDetailsByNumber, loading);
  }
  hydrateUnknownSeasonSummaryDetails(show, tmdbData, seasonDetailsByNumber, loading, seasonsList);

  // Season poster thumbnail in each row: a poster saved in Edit Images wins, then
  // TMDB's season poster; Specials fall back to the series poster.
  const savedSeasonPosters = _savedSeasonPosters.get(savedSeasonPosterKey(tmdbData?.id || show.tmdb_id, tmdbData?.external_ids?.tvdb_id || show.tvdb_id)) || new Map();
  const seasonRowPosterUrl = (season, seasonNumber) => {
    const saved = savedSeasonPosters.get(seasonNumber);
    if (saved) return proxiedArtworkUrl(saved, "poster");
    // Specials, and any season without its own poster, use the series poster.
    const rawPath = String(season.poster_path || "").trim();
    if (seasonNumber === 0 || !rawPath) return posterUrl || "";
    return /^https?:\/\//i.test(rawPath)
      ? proxiedArtworkUrl(rawPath, "poster")
      : tmdbPoster(rawPath, tmdbData?.id || show.tmdb_id, "tv");
  };

  const seasonsAccordionParts = seasonsList.map((season, index) => {
    const seasonNumber = Number(season.season_number);
    const rowPosterUrl = seasonRowPosterUrl(season, seasonNumber);
    const seasonEpisodes = episodeRows.filter((episode) => episode.seasonNumber === seasonNumber);
    const { watchedInSeason, seasonTotal, nextAiringText, totalWatches } = showSeasonSummary(seasonNumber, seasonEpisodes, season, showTitle, tmdbData, seasonDetailsByNumber);
    const isActive = allSeasonsExpanded || seasonNumber === selectedSeasonNumber;
    const panelId = `seasonAccordionPanel${seasonNumber}`;
    const episodeCountText = `${seasonTotal || "?"} episode${seasonTotal === 1 ? "" : "s"}`;
    // Mirrors seasonBusy in renderSeasonPanelHtml: a season/show-scope bulk
    // watch action can take a while for a season this size, so this collapsed
    // row should say so instead of showing a stale watched count until the
    // whole thing settles.
    const seasonSyncing = seasonEpisodes.some((episode) => isMediaSyncing(episode.watched || episode));
    const seasonSaving = hasSavingWatchActionForShow(showTitle, seasonNumber)
      || seasonEpisodes.some((episode) => savingEpisodeKeys.has(episode.key));
    const seasonUnwatching = seasonEpisodes.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
    const watchedText = seasonSyncing
      ? "Syncing…"
      : seasonSaving
      ? "Saving…"
      : seasonUnwatching
        ? "Removing…"
        : watchedInSeason
          ? `${watchedInSeason} watched${totalWatches > watchedInSeason ? ` · ${totalWatches} plays` : ""}`
          : "";
    const mobileSeasonSummaryText = [episodeCountText, watchedText].filter(Boolean).join(" · ");
    // Row lines: "Season N", then the season's own name when it has one.
    const fullSeasonTitle = formatSeasonTitle(seasonNumber, season.name);
    const seasonHeading = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
    const seasonSubtitle = fullSeasonTitle.startsWith(seasonHeading)
      ? fullSeasonTitle.slice(seasonHeading.length).replace(/^\s+-\s+/, "").trim()
      : fullSeasonTitle;
    const card = `
      <article class="season-accordion ${isActive ? "is-open" : ""} ${(!isActive && (seasonSaving || seasonUnwatching || seasonSyncing)) ? "is-saving" : ""}" style="order:${index * 2}">
        <button class="season-accordion-trigger${rowPosterUrl ? " has-row-poster" : ""}" type="button" data-season-accordion="${seasonNumber}" aria-expanded="${isActive}" aria-controls="${panelId}">
          <span class="season-row-title">${rowPosterUrl ? `<img class="season-row-poster" src="${escapeAttribute(rowPosterUrl)}" alt="" loading="lazy" decoding="async" data-err="hide" />` : ""}<span class="season-row-text"><strong>${escapeHtml(seasonHeading)}</strong>${seasonSubtitle ? `<span class="season-row-name">${escapeHtml(seasonSubtitle)}</span>` : ""}<span class="season-row-col season-row-episodes">${escapeHtml(episodeCountText)}</span><span class="season-row-col season-row-watched">${escapeHtml(watchedText)}</span><span class="season-row-col season-row-next">${escapeHtml(nextAiringText)}</span><span class="season-row-mobile-summary">${mobileSeasonSummaryText ? ` · ${escapeHtml(mobileSeasonSummaryText)}` : ""}</span></span></span>
          <span class="season-accordion-meta">
            <svg class="season-accordion-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
      </article>
    `;
    // The open season's episodes sit in their own column beside the season cards
    // (see .season-accordion-detail in styles.css); mobile places them after their card via order.
    const detail = isActive ? `<div class="season-accordion-detail" data-season-detail="${seasonNumber}" style="order:${index * 2 + 1}"><div class="season-accordion-panel" id="${panelId}">${seasonPanelsByNumber.get(seasonNumber) || ""}</div></div>` : "";
    return { card, detail };
  });
  const seasonsAccordionHtml = seasonsAccordionParts.map((part) => part.card).join("");
  const seasonDetailsHtml = seasonsAccordionParts.map((part) => part.detail).join("");

  const checkIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const mergeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M6.5 3a.5.5 0 0 1 .5.5V6h4a2.5 2.5 0 0 1 2.5 2.5v3.793a1.5 1.5 0 1 1-1 0V8.5A1.5 1.5 0 0 0 11 7H7v2.5a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zM2 13.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm10 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>`;
  const seasonsSectionHtml = seasonsList.length ? `
    <section class="seasons-section season-accordions">
      <div class="show-section-title season-section-title">
        <div class="season-section-heading">
          <h3>Seasons</h3>
          <span>${regularSeasonsList.length} season${regularSeasonsList.length === 1 ? "" : "s"}</span>
        </div>
        ${renderSeerrRequestPill("tv", tvSeerrTmdbId, showIsNowPlaying, { compactTvSummary: true })}
      </div>
      <div class="season-accordion-list"><div class="season-accordion-cards">${seasonsAccordionHtml}</div>${seasonDetailsHtml}</div>
    </section>
  ` : "";

  setMediaDetailActions(`
    ${personalMediaActionsHtml(personalMediaItem)}
    ${upNextShowActionHtml({
      title: showTitle,
      tmdb_id: tmdbData?.id || show.tmdb_id || "",
      tvdb_id: tmdbData?.external_ids?.tvdb_id || show.tvdb_id || "",
      imdb_id: tmdbData?.external_ids?.imdb_id || show.imdb_id || "",
      poster_url: showPosterUrl || show.poster_url || posterUrl || "",
    })}
    <label class="action-pill media-spoiler-toggle" title="Hide synopsis and artwork for unwatched episodes">
      <input type="checkbox" data-hide-episode-spoilers ${hideSpoilers ? "checked" : ""} />
      <span>Hide <br>Spoilers</span>
    </label>
    ${tmdbOnly ? "" : `
      ${orphanHistoryId ? `
        <button class="action-pill media-remove-history-btn action-pill--danger" type="button" data-delete-history-id="${escapeAttribute(orphanHistoryId)}">
          <span>Remove entry</span>
        </button>` : ""}
    `}
    ${mediaToolsActionHtml(`
      ${hasPotentialUnwatchedEpisodes ? `
        <button class="action-pill" type="button" data-watch-scope="show" ${(canStartShowWatch && !isShowBusy && !showRemoving && !showSyncing) ? "" : "disabled"}>
          ${checkIcon}
          <span>${showSyncing ? "Syncing…" : isShowBusy ? "Saving..." : "Mark watched"}</span>
        </button>` : ""}
      ${showUnwatchButtonHtml(watchedRows.map((episode) => episode.watched.id), showTitle, isShowBusy || showSyncing, showRemoving)}
      ${mediaForceSyncActionHtml({
        type: "show",
        title: showTitle,
        tmdbId: tmdbData?.id || show.tmdb_id || "",
        tvdbId: tmdbData?.external_ids?.tvdb_id || show.tvdb_id || "",
        imdbId: tmdbData?.external_ids?.imdb_id || show.imdb_id || "",
        disabled: isShowBusy || showSyncing,
        seasons: [...regularSeasonsList]
          .sort((a, b) => Number(a.season_number) - Number(b.season_number))
          .map((season) => ({ number: Number(season.season_number), episodeCount: Number(season.episode_count || 0) })),
      })}
      ${mediaInfoActionHtml()}
      ${tmdbOnly ? "" : `
      <button class="action-pill media-edit-image-btn" type="button" ${isShowBusy ? "disabled" : ""} data-artwork-scope="show" data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-poster-url="${escapeAttribute(showPosterUrl || show.poster_url || posterUrl || "")}" data-show-tmdb-id="${escapeAttribute(tmdbData?.id || show.tmdb_id || "")}" data-show-tvdb-id="${escapeAttribute(tmdbData?.external_ids?.tvdb_id || show.tvdb_id || "")}" data-show-imdb-id="${escapeAttribute(tmdbData?.external_ids?.imdb_id || show.imdb_id || "")}" data-logo-url="${escapeAttribute(show.logo_url || "")}" data-backdrop-url="${escapeAttribute(show.backdrop_url || "")}">
        ${imageIcon}
        <span>Edit Images</span>
      </button>
      <button class="action-pill media-fix-match-btn" type="button" ${isShowBusy ? "disabled" : ""} data-edit-id="${escapeAttribute(representativeEpisode(seasonsMap)?.id || show.id || "")}" data-title="${escapeAttribute(showTitle)}" data-media-type="tv">
        ${searchIcon}
        <span>Fix Match</span>
      </button>
      <button class="action-pill media-merge-show-btn" type="button" ${isShowBusy ? "disabled" : ""} data-show-title="${escapeAttribute(showTitle)}">
        ${mergeIcon}
        <span>Merge</span>
      </button>
      ${representative?.id || show.id ? `
        <button class="action-pill action-pill-danger" type="button" ${isShowBusy ? "disabled" : ""} data-delete-media-id="${escapeAttribute(representative?.id || show.id)}" data-delete-media-type="show" data-delete-media-title="${escapeAttribute(showTitle || "this TV show")}">
          ${trashIcon}
          <span>Delete</span>
        </button>` : ""}
      `}
    `)}
  `);

  const modalMarkup = `
      <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || "")}');"></div>
      <div class="immersive-container media-detail-page media-detail-show-page">
        ${mediaSyncNoticeHtml(syncingEpisodeRows.map((episode) => episode.watched || episode), "this show")}

        <header class="immersive-header">
          <div class="immersive-poster-frame${loading ? " is-loading" : ""}"${loading ? ' aria-busy="true"' : ""}>
            <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || "/favicon.svg")}" alt="${escapeAttribute(showTitle)} poster" data-err="fav" loading="eager" fetchpriority="high" decoding="async" ${posterUrl ? `data-lightbox-src="${escapeAttribute(posterUrl)}"` : ""} />
            ${loading ? `<span class="immersive-poster-loading" role="status" aria-label="Loading data"><span class="immersive-poster-loading-label"><span class="immersive-poster-loading-dot" aria-hidden="true"></span><span>Loading data</span></span></span>` : ""}
          </div>
          <div class="immersive-meta">
            ${logoUrl ? `<img class="immersive-logo" data-err="logo-title" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(showTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(showTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(showTitle)}</h2>`}
            <div class="media-detail-bottom-stack">
              <div class="ratings-row" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                ${showModalStatus(loading, Boolean(tmdbData))}
              </div>

              <p class="immersive-overview">${escapeHtml(overview)}</p>

              ${localEvidence}

              <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
                <div class="progress-label-row">
                  <span>${watchProgressLabel}</span>
                  <span>${progressPercent}% complete</span>
                </div>
                <div class="progress-bar-track">
                  <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
                </div>
              </section>
            </div>

           </div>
          ${renderMediaFacts(tmdbData, "tv", "sidebar", { ratingsHtml: ratingsFactHtml, appLinksHtml: appLinksFactHtml })}
        </header>

        ${seasonsSectionHtml}

        ${renderCastSection(tmdbData)}
        ${renderMediaImagesSection(tmdbData)}
        ${renderTrailersSection(tmdbData)}
        ${renderReviewsSection(tmdbData)}
        ${renderRelatedShowsSection(tmdbData)}
      </div>
      ${renderWatchDatePrompt(state.pendingWatchAction)}
    `;
  if (patchExisting) patchShowModalDom(root, modalMarkup);
  else root.innerHTML = modalMarkup;
  positionSeasonDetails(root);
  if (!loading && !watchHistoryLoading && !tmdbOnly) markDetailPrimaryReady("show");
  // A season named in the URL on navigation (path segment or #seasonN hash)
  // scrolls into view once, here - not via the click handler, since no click
  // happened. The flag is consumed and cleared immediately so a later
  // re-render of this same modal (e.g. toggling an episode watched) doesn't
  // scroll again.
  if (state.pendingSeasonScrollTarget != null && Number(state.pendingSeasonScrollTarget) === selectedSeason) {
    const targetSeason = state.pendingSeasonScrollTarget;
    state.pendingSeasonScrollTarget = null;
    requestAnimationFrame(() => scrollSeasonAccordionIntoView(targetSeason));
  }
  // Refresh when there's no status yet, or when the rendered status came from
  // the persisted cache (`stale`) - the fetch resolves null if nothing
  // changed, so an up-to-date page never re-renders.
  if (tvSeerrTmdbId && (!hasTvSeerrStatus || tvSeerrStatus.stale)) {
    fetchSeerrMediaStatus("tv", tvSeerrTmdbId)
      .then((status) => {
        // A show reached via /tvshow/tmdb/:id or /tvshow/tvdb/:id never sets
        // activeShowModalKey (only the plain /tvshow/:key route does) - a
        // slug-only check here always fails for those, so a background
        // Seerr refresh could never repaint the availability badge on them
        // even once the fetch resolved fresh, correct data.
        const stillOnThisShow = state.activeShowModalKey === slug(show.title)
          || (show.tmdb_id && String(state.activeShowTmdbId || "") === String(show.tmdb_id))
          || (show.tvdb_id && String(state.activeShowTvdbId || "") === String(show.tvdb_id));
        if (!status || !stillOnThisShow) return;
        const current = state.activeShowRenderContext;
        if (current?.tmdbData && !current.loading) {
          renderShowModalContent(current.show, {
            ...current,
            activeSeasonNum: current.activeSeasonNum,
            tmdbData: current.tmdbData,
            seasonDetailsByNumber: current.seasonDetailsByNumber,
            loading: current.loading,
            patchExisting: true,
          });
          return;
        }
        refreshActiveMediaDetailAfterSeerrStatus("tv", tvSeerrTmdbId);
      });
  }
  hydratePosters(root);
  hydrateMediaAppLinks(root);
}

function liveChangeField(change = {}, camelName, snakeName = camelName) {
  return change[camelName] ?? change[snakeName];
}

function liveEpisodeMatches(episode, { change = {}, row = null, progress = null } = {}) {
  const mediaKey = String(liveChangeField(change, "mediaKey", "media_key") || row?.media_key || progress?.media_key || "");
  const recordId = String(liveChangeField(change, "recordId", "record_id") || row?.id || "");
  if (mediaKey && [episode.watched?.media_key, episode.progress?.media_key].some((value) => String(value || "") === mediaKey)) return true;
  if (recordId && String(episode.watched?.id || "") === recordId) return true;

  const mediaType = String(liveChangeField(change, "mediaType", "media_type") || row?.media_type || progress?.media_type || "").toLowerCase();
  if (mediaType && mediaType !== "episode") return false;
  const season = liveChangeField(change, "season") ?? row?.season ?? progress?.season;
  const episodeNumber = liveChangeField(change, "episode") ?? row?.episode ?? progress?.episode;
  if (season == null || episodeNumber == null) return false;
  if (Number(episode.seasonNumber) !== Number(season) || Number(episode.episodeNumber) !== Number(episodeNumber)) return false;

  const incomingShowTitle = row?.show_title
    || liveChangeField(change, "showTitle", "show_title")
    || (progress?.title ? showTitleFrom(progress.title) : "");
  const activeShowTitle = state.activeShowRenderContext?.show?.title || "";
  return Boolean(incomingShowTitle && activeShowTitle && slug(showTitleFrom(incomingShowTitle)) === slug(showTitleFrom(activeShowTitle)));
}

function liveTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotEpisodeForLive(showEpisodes, target, change, row) {
  const mediaKey = String(
    target.watched?.media_key
      || liveChangeField(change, "mediaKey", "media_key")
      || row?.media_key
      || "",
  );
  const season = liveChangeField(change, "season") ?? row?.season ?? target.seasonNumber;
  const episode = liveChangeField(change, "episode") ?? row?.episode ?? target.episodeNumber;
  const candidates = showEpisodes.filter((candidate) => (
    (mediaKey && String(candidate.media_key || "") === mediaKey)
      || (Number(candidate.season) === Number(season) && Number(candidate.episode) === Number(episode))
  ));
  return candidates.find((candidate) => !isWatchedHistoryAction(candidate)) || candidates[0] || null;
}

function liveWatchedRowShouldBeIgnored(row, snapshot, currentWatched) {
  if (!row || !isWatchedHistoryAction(row) || normalizePlatformSource(row.source) === "plembfin") return false;

  // A provider watched row must not replace a newer unwatch tombstone. It also
  // must not replace a current Plekt watch with an older/same-date echo,
  // because that changes the displayed source and can move the watch date.
  const comparison = snapshot && !isWatchedHistoryAction(snapshot)
    ? snapshot
    : normalizePlatformSource(currentWatched?.source) === "plembfin"
      ? currentWatched
      : null;
  if (!comparison) return false;
  const incomingTime = liveTimestamp(row.watched_at);
  const comparisonTime = liveTimestamp(comparison.watched_at);
  return incomingTime == null || comparisonTime == null || incomingTime <= comparisonTime;
}

function updateLiveShowSummaryDom(root, current, changedSeasonNumber) {
  const show = current?.show || {};
  const tmdbData = current?.tmdbData || null;
  const seasonDetailsByNumber = current?.seasonDetailsByNumber || new Map();
  const showTitle = sanitizeTitle(show.title) || "Unknown Show";
  const seasonsMap = seasonsFromShowRecord(show);
  const tmdbSeasons = Array.isArray(tmdbData?.seasons) ? tmdbData.seasons : [];
  const seasonRecord = tmdbSeasons.find((season) => Number(season.season_number) === Number(changedSeasonNumber))
    || (seasonsMap.get(Number(changedSeasonNumber)) && {
      season_number: Number(changedSeasonNumber),
      episode_count: seasonsMap.get(Number(changedSeasonNumber)).length,
      name: seasonLabel(Number(changedSeasonNumber)),
    })
    || { season_number: Number(changedSeasonNumber), episode_count: 0 };
  const seasonEpisodes = state.showModalEpisodes.filter((episode) => Number(episode.seasonNumber) === Number(changedSeasonNumber));
  const summary = showSeasonSummary(Number(changedSeasonNumber), seasonEpisodes, seasonRecord, showTitle, tmdbData, seasonDetailsByNumber);
  const seasonBlock = root.querySelector(`#showSeason${Number(changedSeasonNumber)}`);
  const seasonRemoving = seasonEpisodes.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
  const seasonLabelElement = seasonBlock?.querySelector(".show-season-label");
  if (seasonLabelElement && !seasonRemoving) {
    const watchCount = summary.totalWatches > summary.watchedInSeason ? ` · ${summary.totalWatches} actual watches` : "";
    seasonLabelElement.textContent = `${summary.watchedInSeason} of ${summary.seasonTotal || "?"} episodes watched${watchCount}`;
  }

  const accordion = root.querySelector(`[data-season-accordion="${Number(changedSeasonNumber)}"]`)?.closest(".season-accordion");
  if (accordion) {
    const episodesCell = accordion.querySelector(".season-row-episodes");
    const watchedCell = accordion.querySelector(".season-row-watched");
    const nextCell = accordion.querySelector(".season-row-next");
    if (episodesCell) episodesCell.textContent = `${summary.seasonTotal || "?"} episode${summary.seasonTotal === 1 ? "" : "s"}`;
    if (watchedCell) watchedCell.textContent = summary.watchedInSeason
      ? `${summary.watchedInSeason} watched${summary.totalWatches > summary.watchedInSeason ? ` · ${summary.totalWatches} plays` : ""}`
      : "";
    if (nextCell) nextCell.textContent = summary.nextAiringText || "";
  }

  const regularEpisodes = state.showModalEpisodes.filter((episode) => Number(episode.seasonNumber) > 0);
  const regularSeasons = tmdbSeasons.filter((season) => Number(season.season_number) > 0);
  const watchedEpisodes = regularEpisodes.filter((episode) => episode.watched);
  const metadataEpisodeCount = regularSeasons.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const totalCount = Math.max(regularEpisodes.length, metadataEpisodeCount, watchedEpisodes.length, 1);
  const watchedCount = watchedEpisodes.length;
  const totalWatches = watchSummaryForRows(regularEpisodes).totalWatches;
  const watchHistoryLabel = totalWatches > watchedCount ? ` · ${totalWatches} actual watches` : "";
  const progressPercent = Math.max(0, Math.min(100, Math.round((watchedCount / totalCount) * 100)));
  const progressSection = root.querySelector(".immersive-meta .progress-section");
  const progressLabels = progressSection?.querySelectorAll(".progress-label-row > span");
  if (progressLabels?.[0]) progressLabels[0].textContent = `${watchedCount} of ${totalCount} episodes watched${watchHistoryLabel}`;
  if (progressLabels?.[1]) progressLabels[1].textContent = `${progressPercent}% complete`;
  const progressFill = progressSection?.querySelector(".progress-bar-fill");
  if (progressFill) progressFill.style.width = `${progressPercent}%`;
}

function episodeIsUnreleasedForWatchControl(episode) {
  if (episode?.watched || !episode?.airDate) return false;
  const parts = String(episode.airDate).split("-");
  if (parts.length !== 3) return false;
  const air = new Date(parts[0], parts[1] - 1, parts[2]);
  return !Number.isNaN(air.getTime()) && air > new Date();
}

// Keep the mounted action controls in step with the episode objects patched by
// SSE. This deliberately mutates only existing controls; it must not call
// renderShowModalContent, which would replace the season accordion and reset
// the user's scroll/artwork state while a bulk save is in flight.
export function syncShowModalWatchActionControls() {
  const current = state.activeShowRenderContext;
  const root = mediaDetailRoot();
  if (!current?.show || !root) return false;
  const actionRoot = typeof document?.getElementById === "function"
    ? document.getElementById("mediaDetailActions") || root
    : root;

  const episodes = Array.isArray(state.showModalEpisodes) ? state.showModalEpisodes : [];
  const showTitle = sanitizeTitle(current.show.title) || "Unknown Show";
  const savingEpisodeKeys = savingEpisodeKeysForShow(showTitle);
  const showBusy = savingEpisodeKeys.size > 0 || hasSavingWatchActionForShow(showTitle);
  const showRemoving = episodes.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
  const syncingEpisodeKeys = new Set(episodes
    .filter((episode) => isMediaSyncing(episode.watched || episode))
    .map((episode) => episode.key));
  const showSyncing = syncingEpisodeKeys.size > 0;
  const regularEpisodes = episodes.filter((episode) => Number(episode.seasonNumber) > 0);
  const regularSeasons = (Array.isArray(current.tmdbData?.seasons) ? current.tmdbData.seasons : [])
    .filter((season) => Number(season.season_number) > 0);
  const episodeByKey = new Map(episodes.map((episode) => [String(episode.key || ""), episode]));
  const episodesBySeason = new Map();
  for (const episode of episodes) {
    const seasonNumber = Number(episode.seasonNumber);
    const seasonEpisodes = episodesBySeason.get(seasonNumber) || [];
    seasonEpisodes.push(episode);
    episodesBySeason.set(seasonNumber, seasonEpisodes);
  }
  const metadataEpisodeCount = regularSeasons.reduce((total, season) => total + Number(season.episode_count || 0), 0);
  const watchedCount = regularEpisodes.filter((episode) => episode.watched).length;
  const hasPotentialUnwatchedEpisodes = regularEpisodes.some((episode) => (
    !episode.watched && !episodeIsUnreleasedForWatchControl(episode)
  )) || watchedCount < metadataEpisodeCount;
  const canStartShowWatch = episodes.length > 0 || metadataEpisodeCount > 0;

  const showButton = actionRoot.querySelector?.('[data-watch-scope="show"]');
  if (showButton) {
    showButton.disabled = !canStartShowWatch || showBusy || showRemoving || showSyncing || !hasPotentialUnwatchedEpisodes;
    showButton.hidden = !hasPotentialUnwatchedEpisodes;
    const label = showButton.querySelector?.("span");
    if (label) label.textContent = showSyncing ? "Syncing…" : showBusy ? "Saving..." : "Mark watched";
  }

  const showUnwatchButton = actionRoot.querySelector?.('[data-unwatch-kind="show"]');
  if (showUnwatchButton) {
    showUnwatchButton.disabled = showBusy || showRemoving || showSyncing;
    const label = showUnwatchButton.querySelector?.("span");
    if (label) label.textContent = showSyncing ? "Syncing…" : showRemoving ? "Unwatching…" : "Mark unwatched";
  }

  const seasonMetadataByNumber = new Map(
    (Array.isArray(current.tmdbData?.seasons) ? current.tmdbData.seasons : [])
      .map((season) => [Number(season.season_number), season]),
  );
  const seasonStateCache = new Map();
  const seasonDisplayState = (seasonNumber) => {
    if (seasonStateCache.has(seasonNumber)) return seasonStateCache.get(seasonNumber);
    const seasonEpisodes = episodesBySeason.get(seasonNumber) || [];
    const seasonUnwatched = seasonEpisodes.filter((episode) => (
      !episode.watched && !episodeIsUnreleasedForWatchControl(episode)
    ));
    const seasonUnreleased = seasonEpisodes.filter((episode) => (
      !episode.watched && episodeIsUnreleasedForWatchControl(episode)
    ));
    const seasonBusy = hasSavingWatchActionForShow(showTitle, seasonNumber)
      || seasonEpisodes.some((episode) => savingEpisodeKeys.has(episode.key));
    const seasonSyncing = seasonEpisodes.some((episode) => syncingEpisodeKeys.has(episode.key));
    const seasonRemoving = seasonEpisodes.some((episode) => episode.watched && state.savingUnwatchIds.has(episode.watched.id));
    const watchedInSeason = seasonEpisodes.filter((episode) => episode.watched).length;
    const totalWatches = watchSummaryForRows(seasonEpisodes).totalWatches;
    const metadataTotal = Number(seasonMetadataByNumber.get(seasonNumber)?.episode_count || 0);
    const seasonTotal = seasonEpisodes.length || metadataTotal;
    const normalLabel = `${watchedInSeason} of ${seasonTotal || "?"} episodes watched${totalWatches > watchedInSeason ? ` · ${totalWatches} actual watches` : ""}`;
    const collapsedLabel = watchedInSeason
      ? `${watchedInSeason} watched${totalWatches > watchedInSeason ? ` · ${totalWatches} plays` : ""}`
      : "";
    const result = { seasonEpisodes, seasonUnwatched, seasonUnreleased, seasonBusy, seasonRemoving, seasonSyncing, normalLabel, collapsedLabel };
    seasonStateCache.set(seasonNumber, result);
    return result;
  };

  // Update both the mounted season panel and collapsed season rows. The latter
  // have no season button until expanded, so relying only on the action button
  // left their stale watched count and omitted the saving pulse entirely.
  root.querySelectorAll?.("[data-season-accordion]").forEach((trigger) => {
    const seasonNumber = Number(trigger.dataset?.seasonAccordion);
    const season = seasonDisplayState(seasonNumber);
    const accordion = trigger.closest?.(".season-accordion");
    if (!accordion) return;
    const watchedCell = accordion.querySelector?.(".season-row-watched");
    if (watchedCell) {
      watchedCell.textContent = season.seasonSyncing ? "Syncing…" : season.seasonBusy ? "Saving…" : season.seasonRemoving ? "Removing…" : season.collapsedLabel;
    }
    accordion.classList.toggle("is-saving", season.seasonBusy || season.seasonRemoving || season.seasonSyncing);
    if (season.seasonBusy || season.seasonRemoving || season.seasonSyncing) accordion.setAttribute("aria-busy", "true");
    else accordion.removeAttribute("aria-busy");
  });

  root.querySelectorAll?.('[data-watch-scope="season"]').forEach((button) => {
    const seasonNumber = Number(button.dataset?.seasonNumber);
    const season = seasonDisplayState(seasonNumber);
    button.disabled = !season.seasonEpisodes.length || season.seasonBusy || season.seasonRemoving || season.seasonSyncing;
    button.textContent = season.seasonSyncing ? "Syncing…" : season.seasonBusy ? "Saving…" : season.seasonUnwatched.length || season.seasonUnreleased.length ? "Mark season watched" : "Resync season";
    button.title = season.seasonUnreleased.length
      ? "Some episodes are unreleased and will require confirmation"
      : season.seasonUnwatched.length ? "" : "Re-push this season's watched state to Plex, Emby, Jellyfin & Trakt";

    const seasonBlock = button.closest?.(".show-season-block");
    const seasonLabel = seasonBlock?.querySelector?.(".show-season-label");
    if (seasonLabel) seasonLabel.textContent = season.seasonSyncing ? "Syncing…" : season.seasonBusy ? "Saving…" : season.seasonRemoving ? "Removing…" : season.normalLabel;
    const accordion = seasonBlock?.closest?.(".season-accordion");
    if (accordion) {
      accordion.classList.toggle("is-saving", season.seasonBusy || season.seasonRemoving || season.seasonSyncing);
      if (season.seasonBusy || season.seasonRemoving || season.seasonSyncing) accordion.setAttribute("aria-busy", "true");
      else accordion.removeAttribute("aria-busy");
    }
  });

  root.querySelectorAll?.("[data-immersive-episode-key]").forEach((article) => {
    const episode = episodeByKey.get(String(article.dataset.immersiveEpisodeKey || ""));
    if (!episode) return;
    const syncing = syncingEpisodeKeys.has(episode.key);
    const episodeBusy = savingEpisodeKeys.has(episode.key);
    const episodeUnwatching = Boolean(episode.watched && state.savingUnwatchIds.has(episode.watched.id));
    article.classList.toggle("is-syncing", syncing);
    if (syncing) article.setAttribute("aria-busy", "true");
    else if (!episodeBusy && !episodeUnwatching) article.removeAttribute("aria-busy");
    article.querySelectorAll?.('[data-watch-scope="episode"], [data-unwatch-kind="episode"]').forEach((button) => {
      button.disabled = syncing || episodeBusy || episodeUnwatching;
      if (syncing) button.title = "This episode is syncing; watch changes are paused until it completes.";
      else button.removeAttribute("title");
    });
  });

  const notice = root.querySelector?.("[data-media-detail-sync-notice]");
  if (showSyncing && !notice) {
    const page = root.querySelector?.(".media-detail-page");
    page?.insertAdjacentHTML("afterbegin", mediaSyncNoticeHtml(episodes.map((episode) => episode.watched || episode), "this show"));
  } else if (!showSyncing) {
    notice?.remove();
  }

  return true;
}

function patchShowModalEpisodeNode(target, { savingEpisodeKeys = null } = {}) {
  const current = state.activeShowRenderContext;
  const root = mediaDetailRoot();
  if (!current?.show || !root || !target) return false;
  const currentNode = [...(root.querySelectorAll?.("[data-immersive-episode-key]") || [])]
    .find((node) => node.dataset.immersiveEpisodeKey === target.key);
  if (!currentNode) return false;

  const showTitle = sanitizeTitle(current.show.title) || "Unknown Show";
  const tvSeerrTmdbId = current.tmdbData?.id || current.show.tmdb_id || "";
  const tvSeerrStatus = state.seerrMediaStatusCache.get(`tv:${tvSeerrTmdbId}`) || {};
  const isUnreleased = (episode) => {
    if (episode.watched || !episode.airDate) return false;
    const parts = String(episode.airDate).split("-");
    if (parts.length !== 3) return false;
    const air = new Date(parts[0], parts[1] - 1, parts[2]);
    return !Number.isNaN(air.getTime()) && air > new Date();
  };
  const template = document.createElement("template");
  template.innerHTML = renderEpisodeRowHtml(target, {
    showTitle,
    tvSeerrStatus,
    savingEpisodeKeys: savingEpisodeKeys || savingEpisodeKeysForShow(showTitle),
    isUnreleased,
    loading: Boolean(current.loading),
    hideSpoilers: state.hideEpisodeSpoilers,
    watchHistoryLoading: Boolean(current.watchHistoryLoading),
  }).trim();
  const replacement = template.content.firstElementChild;
  if (!replacement) return false;

  // The live row contains the watch metadata and action controls, but most
  // SSE changes do not change the episode artwork. Keep the mounted image
  // node when its source is unchanged; replacing it would make the browser
  // reconsider lazy loading and can flash or re-request the poster while the
  // rest of the page is correctly staying in place.
  const currentArtwork = currentNode.querySelector?.(".episode-thumb");
  const replacementArtwork = replacement.querySelector?.(".episode-thumb");
  const sameArtwork = currentArtwork?.tagName === "IMG"
    && replacementArtwork?.tagName === "IMG"
    && String(currentArtwork.getAttribute("src") || "") === String(replacementArtwork.getAttribute("src") || "")
    && String(currentArtwork.getAttribute("data-fallback") || "") === String(replacementArtwork.getAttribute("data-fallback") || "");
  if (sameArtwork) replacementArtwork.replaceWith(currentArtwork);
  currentNode.replaceWith(replacement);
  if (!sameArtwork) hydratePosters(replacement);
  return true;
}

// Repaint only the episode articles covered by an in-flight manual action.
// This is intentionally separate from renderShowModalContent: replacing the
// full season accordion would discard every other mounted episode and its
// scroll/artwork state while the server-side sync is still in progress.
export function patchShowModalEpisodesSavingState({ episodes = [], saving = true } = {}) {
  const current = state.activeShowRenderContext;
  if (!current?.show || !Array.isArray(state.showModalEpisodes) || !episodes.length) {
    syncShowModalWatchActionControls();
    return false;
  }
  const requestedKeys = new Set(episodes.map((episode) => String(episode?.key || "")).filter(Boolean));
  const targets = state.showModalEpisodes.filter((target) => (
    requestedKeys.has(String(target.key || ""))
      || episodes.some((episode) => (
        Number(target.seasonNumber) === Number(episode?.seasonNumber)
          && Number(target.episodeNumber) === Number(episode?.episodeNumber)
      ))
  ));
  if (!targets.length) {
    syncShowModalWatchActionControls();
    return false;
  }

  const showTitle = sanitizeTitle(current.show.title) || "Unknown Show";
  const activeSavingKeys = savingEpisodeKeysForShow(showTitle);
  if (saving) targets.forEach((target) => activeSavingKeys.add(target.key));
  let patched = 0;
  for (const target of targets) {
    if (patchShowModalEpisodeNode(target, { savingEpisodeKeys: activeSavingKeys })) patched += 1;
  }
  syncShowModalWatchActionControls();
  return patched > 0;
}

// Apply a single SSE item update without calling renderShowModalContent. The
// episode object, its state-history entry, and the one mounted article are
// updated in place; all other episode nodes, artwork requests, and scroll
// positions remain mounted.
export function patchShowModalEpisodeFromLive({ change = {}, row = null, progress = null } = {}) {
  const current = state.activeShowRenderContext;
  if (!current?.show || !Array.isArray(state.showModalEpisodes) || !state.showModalEpisodes.length) return false;
  const target = state.showModalEpisodes.find((episode) => liveEpisodeMatches(episode, { change, row, progress }));
  if (!target) return false;

  const sourceTable = String(liveChangeField(change, "sourceTable", "source_table") || "");
  const progressOnly = sourceTable === "playback_progress";
  const activeShowTitle = sanitizeTitle(current.show.title) || "Unknown Show";
  const currentWatched = target.watched;
  const previousMediaKey = String(currentWatched?.media_key || liveChangeField(change, "mediaKey", "media_key") || row?.media_key || "");
  const showEpisodes = Array.isArray(current.show.episodes) ? [...current.show.episodes] : [];
  const snapshotEpisode = snapshotEpisodeForLive(showEpisodes, target, change, row);
  const ignoredWatchedRow = liveWatchedRowShouldBeIgnored(row, snapshotEpisode, currentWatched);
  const acceptedWatchedRow = row && isWatchedHistoryAction(row) && !ignoredWatchedRow
    ? row
    : ignoredWatchedRow && normalizePlatformSource(currentWatched?.source) === "plembfin"
      ? currentWatched
      : null;
  if (!progressOnly) target.watched = acceptedWatchedRow;
  if (progressOnly) {
    target.progress = progress && Number(progress.progress || 0) > 0 ? progress : null;
  } else if (target.watched) {
    target.progress = null;
  } else if (progress) {
    target.progress = Number(progress.progress || 0) > 0 ? progress : null;
  }

  const existingIndex = showEpisodes.findIndex((episode) => (
    (previousMediaKey && String(episode.media_key || "") === previousMediaKey)
      || (Number(episode.season) === Number(target.seasonNumber) && Number(episode.episode) === Number(target.episodeNumber))
  ));
  if (target.watched) {
    if (existingIndex >= 0) showEpisodes[existingIndex] = target.watched;
    else showEpisodes.push(target.watched);
  } else if (ignoredWatchedRow) {
    // Leave the current tombstone in place. If a rematch changed its media key
    // but the episode coordinates still identify it, preserve that tombstone
    // rather than allowing the provider row to reintroduce the episode.
    if (existingIndex < 0 && snapshotEpisode && !isWatchedHistoryAction(snapshotEpisode)) showEpisodes.push(snapshotEpisode);
  } else if (existingIndex >= 0 && sourceTable === "watch_history") {
    // Keep the unwatch transition in the local show snapshot. It is a
    // tombstone, not a visible watched episode, but mergeShowWithLoadedHistory
    // needs it to prevent the older watched row in state.history from being
    // reintroduced by the next silent refresh.
    showEpisodes[existingIndex] = row || {
      ...showEpisodes[existingIndex],
      sync_action: "unwatched",
      syncAction: "unwatched",
    };
  } else if (row && sourceTable === "watch_history") {
    // A provider can report the unwatch under a rematched media key. Match by
    // season/episode above when possible; if the current snapshot did not
    // contain the old row, retain the tombstone so a later history merge still
    // cannot resurrect a stale watched alias.
    showEpisodes.push(row);
  }
  current.show = { ...current.show, episodes: showEpisodes };

  if (!progressOnly && row && isWatchedHistoryAction(row) && !ignoredWatchedRow) {
    markSavingEpisodeComplete(activeShowTitle, target.key);
  }

  // Keep the lightweight show summary in step with the detail context. This
  // matters after a local unwatch: a later navigation can otherwise seed the
  // modal from state.showsRaw, re-introduce the stale watched episode, and then
  // merge the fresh history snapshot without ever seeing an unwatched row.
  if (sourceTable === "watch_history" && Array.isArray(state.showsRaw)) {
    const activeShowTitle = slug(showTitleFrom(current.show.title || ""));
    const showIndex = state.showsRaw.findIndex((show) => (
      (current.show.tmdb_id && String(show.tmdb_id || "") === String(current.show.tmdb_id))
        || (current.show.tvdb_id && String(show.tvdb_id || "") === String(current.show.tvdb_id))
        || (activeShowTitle && slug(showTitleFrom(show.title || "")) === activeShowTitle)
    ));
    if (showIndex >= 0) {
      const summaryShow = state.showsRaw[showIndex];
      const summaryEpisodes = Array.isArray(summaryShow.episodes) ? [...summaryShow.episodes] : [];
      const summaryIndex = summaryEpisodes.findIndex((episode) => (
        (previousMediaKey && String(episode.media_key || "") === previousMediaKey)
          || (Number(episode.season) === Number(target.seasonNumber) && Number(episode.episode) === Number(target.episodeNumber))
      ));
      if (target.watched) {
        if (summaryIndex >= 0) summaryEpisodes[summaryIndex] = target.watched;
        else summaryEpisodes.push(target.watched);
      } else if (ignoredWatchedRow) {
        if (summaryIndex < 0 && snapshotEpisode && !isWatchedHistoryAction(snapshotEpisode)) summaryEpisodes.push(snapshotEpisode);
      } else if (summaryIndex >= 0) {
        summaryEpisodes[summaryIndex] = row || {
          ...summaryEpisodes[summaryIndex],
          sync_action: "unwatched",
          syncAction: "unwatched",
        };
      } else if (row) {
        summaryEpisodes.push(row);
      }
      state.showsRaw[showIndex] = { ...summaryShow, episodes: summaryEpisodes };
    }
  }

  const root = mediaDetailRoot();
  patchShowModalEpisodeNode(target);
  updateLiveShowSummaryDom(root, current, target.seasonNumber);
  syncShowModalWatchActionControls();
  return true;
}

// Provider ids present on both sides, lowercased, prefixed by type so an
// imdb id never collides with a numeric tmdb id that happens to match.
function providerIdTokens(obj = {}) {
  const ids = [];
  if (obj.imdb_id) ids.push(`imdb:${String(obj.imdb_id).toLowerCase()}`);
  if (obj.tmdb_id) ids.push(`tmdb:${String(obj.tmdb_id).toLowerCase()}`);
  if (obj.tvdb_id) ids.push(`tvdb:${String(obj.tvdb_id).toLowerCase()}`);
  return ids;
}

function showProviderIdTokens(obj = {}) {
  const ids = [];
  const imdb = obj.show_imdb_id || (obj.media_type !== "episode" ? obj.imdb_id : "");
  const tmdb = obj.show_tmdb_id || (obj.media_type !== "episode" ? obj.tmdb_id : "");
  const tvdb = obj.show_tvdb_id || (obj.media_type !== "episode" ? obj.tvdb_id : "");
  if (imdb) ids.push(`imdb:${String(imdb).toLowerCase()}`);
  if (tmdb) ids.push(`tmdb:${String(tmdb).toLowerCase()}`);
  if (tvdb) ids.push(`tvdb:${String(tvdb).toLowerCase()}`);
  return ids;
}

export function mergeShowWithLoadedHistory(show = {}) {
  if (!show?.title) return show;
  const showKey = slug(show.title || "");
  const showIds = providerIdTokens(show);
  const byEpisode = new Map();
  const unwatchedEpisodeKeys = new Set();
  const matchingSummaryEpisodes = (state.showsRaw || [])
    .filter((candidate) => {
      if (slug(candidate?.title || "") !== showKey) return false;
      const candidateIds = providerIdTokens(candidate);
      if (showIds.length && candidateIds.length) return showIds.some((id) => candidateIds.includes(id));
      // A provider-identified show must not borrow a tombstone from an
      // unrelated title-only or same-title reboot record.
      if (showIds.length || candidateIds.length) return false;
      return true;
    })
    .flatMap((candidate) => candidate.episodes || []);
  const showEpisodeRows = [...(show.episodes || []), ...matchingSummaryEpisodes];
  for (const episode of showEpisodeRows) {
    if (episode.season == null || episode.episode == null) continue;
    const key = showEpisodeKey(episode.season, episode.episode);
    // The detail endpoint deliberately keeps the latest unwatched transition
    // as a tombstone so the show still resolves after its last watch is
    // removed. The dashboard history feed only contains watched rows, so an
    // older watch in state.history must not resurrect that episode here.
    if (!isWatchedHistoryAction(episode)) {
      unwatchedEpisodeKeys.add(key);
      byEpisode.delete(key);
      continue;
    }
    if (!unwatchedEpisodeKeys.has(key)) byEpisode.set(key, episode);
  }
  for (const row of state.history || []) {
    if (!isWatchedHistoryAction(row)) continue;
    if (row.media_type !== "episode") continue;
    if (row.season == null || row.episode == null) continue;
    const rowShowTitle = row.show_title || showTitleFrom(row.title);
    if (slug(rowShowTitle) !== showKey) continue;
    // A title match alone isn't enough when two distinct real shows share a
    // title (a reboot/revival, e.g. Scrubs 2001 vs Scrubs 2026) - exclude a
    // row whose own show provider id contradicts this show's, even though the
    // title matched, rather than blending a different show's episodes in.
    // Episode-level provider ids on history rows differ from show-level ids,
    // so only exclude when explicit show-level ids contradict.
    const rowIds = providerIdTokens(row);
    const hasMatchingId = rowIds.some((id) => showIds.includes(id));
    if (!hasMatchingId) {
      const rowShowIds = showProviderIdTokens(row);
      if (rowShowIds.length && showIds.length && !rowShowIds.some((id) => showIds.includes(id))) continue;
    }
    const key = showEpisodeKey(row.season, row.episode);
    if (unwatchedEpisodeKeys.has(key)) continue;
    const existing = byEpisode.get(key);
    const incomingIsManual = normalizePlatformSource(row.source) === "plembfin";
    const existingIsManual = normalizePlatformSource(existing?.source) === "plembfin";
    const incomingTime = String(row.watched_at || "");
    const existingTime = String(existing?.watched_at || "");
    const shouldUseIncoming = !existing
      || (incomingIsManual !== existingIsManual
        ? incomingIsManual && incomingTime >= existingTime
        : incomingTime >= existingTime);
    if (shouldUseIncoming) {
      // The dashboard/history preview is intentionally compact and does not
      // carry playHistory. Do not let that lightweight row replace the full
      // detail row and hide genuine repeated watches in the show modal.
      const existingHistory = Array.isArray(existing?.playHistory) ? existing.playHistory : [];
      const incomingHistory = Array.isArray(row.playHistory) ? row.playHistory : [];
      byEpisode.set(key, {
        ...row,
        show_title: rowShowTitle,
        ...(existingHistory.length > incomingHistory.length ? { playHistory: existingHistory } : {}),
      });
    }
  }
  const episodes = [...byEpisode.values()].sort((a, b) => Number(b.season || 0) - Number(a.season || 0) || Number(b.episode || 0) - Number(a.episode || 0));
  if (!episodes.length) return show;
  const seasonCount = new Set(episodes.map((ep) => ep.season).filter((s) => s != null)).size;
  const watchedDates = episodes.map((ep) => ep.watched_at).filter(Boolean).sort();
  return {
    ...show,
    episode_count: Math.max(Number(show.episode_count || 0), episodes.length),
    season_count: Math.max(Number(show.season_count || 0), seasonCount),
    latest_watched_at: watchedDates.at(-1) || show.latest_watched_at,
    earliest_watched_at: watchedDates[0] || show.earliest_watched_at,
    episodes,
  };
}

function fallbackSeasonList(seasonsMap) {
  return [...seasonsMap.keys()].sort((a, b) => b - a).map((seasonNumber) => ({
    season_number: seasonNumber,
    name: seasonLabel(seasonNumber),
    episode_count: seasonsMap.get(seasonNumber)?.length || 0,
    poster_path: null,
  }));
}

async function hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken) {
  const seededShow = state.showsRaw.find((s) => slug(s.title) === showKey);
  if (!seededShow) return;
  const show = mergeShowWithLoadedHistory(seededShow);
  if (!show?.title) return;
  const stillCurrent = () => requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey;
  // Detail views bypass the shared prefetch batch: that batch only answers once
  // its slowest item resolves. Load the mutable local record in parallel so
  // watch dates can replace a summary row as soon as the detail view settles.
  const detailPromise = loadShowDetail(show).catch((error) => {
    console.error("Failed to load show watch history", error);
    return null;
  });
  const tmdbData = await fetchTmdbDetails("tv", show.tmdb_id, show.title, tmdbLookupIdsFromShow(show), { immediate: true });
  if (!stillCurrent()) return;
  if (tmdbData?.id) state.activeShowTmdbId = String(tmdbData.id);

  // Paint now. Season episodes hydrate themselves through
  // hydrateMissingSeasonDetails, and the IMDb pill is folded in below, so
  // neither has to hold up the first complete render.
  const seasonDetailsByNumber = new Map();
  renderShowModalContent(show, {
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber,
    loading: true,
    watchHistoryLoading: true,
    imdbPillHtml: "",
    patchExisting: Boolean(mediaDetailRoot().querySelector(".media-detail-page")),
  });

  const [detailedShow, imdbPillHtml] = await Promise.all([
    detailPromise,
    fetchShowImdbPillHtml(show, tmdbData, stillCurrent),
  ]);
  if (!stillCurrent()) return;
  const current = state.activeShowRenderContext;
  const hydratedShow = mergeShowWithLoadedHistory(detailedShow || current?.show || show);
  renderShowModalContent(hydratedShow, {
    ...(current || {}),
    activeSeasonNum: state.activeShowModalSeason,
    tmdbData,
    seasonDetailsByNumber: current?.seasonDetailsByNumber || seasonDetailsByNumber,
    loading: false,
    watchHistoryLoading: false,
    imdbPillHtml: imdbPillHtml || "",
    patchExisting: true,
  });
}

export async function renderImmersiveShowModal(showKey, activeSeasonNum = null, activeEpisodeNum = null, historyId = "") {
  // Half of a two-token handshake with media-detail-movie.js - see the
  // bumpMediaRenderToken doc comment in media-detail-context.js before changing this.
  // Captured locally (unlike the tmdbId/tvdbId siblings' own bump further down,
  // which they check against their own token) so the local-library render path
  // below - which never delegates to those siblings - can tell whether it was
  // superseded by a later navigation (e.g. the user clicking away to the TV
  // Shows list) while one of its own awaited fetches was still in flight, and
  // bail out instead of overwriting whatever rendered in the meantime.
  const renderToken = bumpMediaRenderToken(); // invalidate any in-flight movie render
  syncInlineMediaDetailHeading("shows");
  state.activeShowModalKey = showKey;
  state.activeShowModalTitle = null;
  state.pendingWatchAction = null;
  state.activeShowModalEpisode = activeEpisodeNum;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();

  let show = state.showsRaw.find((s) => slug(s.title) === showKey);
  if (!show) {
    const rows = [
      ...(Array.isArray(state.upNextItems) ? state.upNextItems : []),
      ...(Array.isArray(state.history) ? state.history : []),
      ...(Array.isArray(state.partWatchedRaw) ? state.partWatchedRaw : []),
      ...(Array.isArray(state.historyViewRaw) ? state.historyViewRaw : []),
    ];
    const row = rows.find((entry) => (
      entry?.media_type === "episode"
        && slug(entry.show_title || showTitleFrom(entry.title || "")) === showKey
    ));
    if (row) {
      const title = row.show_title || showTitleFrom(row.title || showKey);
      const rowShow = {
        title,
        tmdb_id: row.show_tmdb_id || "",
        tvdb_id: row.show_tvdb_id || "",
        imdb_id: row.show_imdb_id || "",
        episodes: [{ ...row, show_title: title }],
        episode_count: 1,
        season_count: row.season == null ? 0 : 1,
      };
      show = mergeShowDetail(rowShow) || rowShow;
    }
  }
  // Set only when the history link points at a row with no resolvable series,
  // so the orphan shell below is what ends up on screen.
  let orphanShell = false;
  if (historyId) {
    try {
      const response = await fetch(`/api/history?id=${encodeURIComponent(historyId)}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      const row = response.ok ? body.row : null;
      if (row && historyRowShowIsUnresolved(row)) {
        orphanShell = true;
        const title = identifiableShowTitleFromRow(row, historyId);
        show = {
          title,
          id: row.id || historyId,
          episodes: [{ ...row, show_title: title }],
          episode_count: 1,
          season_count: row.season == null ? 0 : 1,
          latest_watched_at: row.watched_at || "",
          representative_episode: row,
          unmatched_history_id: historyId,
        };
        mergeShowDetail(show);
      }
    } catch (error) {
      console.error("Failed to load show history record", error);
    }
  }

  // A direct detail link can arrive before the history list has finished its
  // initial load. If the record endpoint was unavailable or returned no row,
  // still use the matching in-memory history item so the user can identify and
  // repair the orphaned show instead of seeing an empty placeholder page.
  if (historyId && (!show || sanitizeTitle(show.title) === "Unknown Show" || !Array.isArray(show.episodes) || !show.episodes.length)) {
    const localRow = (state.history || []).find((row) => String(row.id || "") === String(historyId));
    if (localRow && historyRowShowIsUnresolved(localRow)) {
      orphanShell = true;
      const title = identifiableShowTitleFromRow(localRow, historyId);
      show = {
        title,
        id: localRow.id || historyId,
        episodes: [{ ...localRow, show_title: title }],
        episode_count: 1,
        season_count: localRow.season == null ? 0 : 1,
          latest_watched_at: localRow.watched_at || "",
          representative_episode: localRow,
          unmatched_history_id: historyId,
      };
      mergeShowDetail(show);
    }
  }
  if (!show) {
    const isAlreadyOpen = Boolean(state.activeShowRenderContext?.show && slug(state.activeShowRenderContext.show.title) === showKey);
    if (!isAlreadyOpen) {
      root.innerHTML = `
        <div class="modal-backdrop-image"></div>
        <div class="immersive-container media-detail-page">
          ${mediaDetailLoaderHtml("Loading show details")}
        </div>
      `;
    }
    try {
      const response = await fetch(`/api/show?id=${encodeURIComponent(showKey)}`, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.show) {
        show = body.show;
        state.showsRaw.push(show);
      }
    } catch (error) {
      console.error("Failed to load show detail on direct link", error);
    }
  }

  // Explorer routes use a title slug (for example, `unknown-show`), not a
  // database id. If the summary is not already in memory, resolve that slug
  // through the title lookup so locally watched episodes can still render
  // when the show has no valid metadata identity yet.
  if (!show) {
    const titleGuess = showKey.replace(/-/g, " ").trim();
    if (titleGuess) {
      show = await loadShowDetail({ title: titleGuess }).catch((error) => {
        console.error("Failed to load show detail by title", error);
        return null;
      });
    }
  }

  // One real metadata path regardless of which URL got you here: once a show
  // has a known provider id, delegate to the same full TMDB/TVDB fetch +
  // render pipeline the tmdb/tvdb routes use (season-by-season episode
  // details, cast, images, trailers, IMDb rating) instead of the lighter
  // local-only render below, which never fetched season-level metadata at
  // all.
  // Skipped for an orphan history shell or the unknown-show placeholder -
  // neither has a real id to delegate with.
  if (show && !orphanShell && showKey !== "unknown-show") {
    if (show.tmdb_id) {
      await openShowImmersiveModalByTmdbId(show.tmdb_id);
      return;
    }
    if (show.tvdb_id) {
      await openShowImmersiveModalByTvdbId(show.tvdb_id);
      return;
    }

    // Older library rows can have a perfectly usable title and episode
    // history but no series-level provider id. Resolve those rows through the
    // full metadata path as well; otherwise the title route renders a local
    // shell with no cast, artwork rails, trailers, reviews, or related shows.
    const title = String(show.title || "").trim();
    if (title) {
      const localDetailPromise = loadShowDetail(show).catch((error) => {
        console.error("Failed to load title-only show detail", error);
        return null;
      });
      const titleMetadata = await fetchTmdbDetails(
        "tv",
        "",
        title,
        tmdbLookupIdsFromShow(show),
        { immediate: true },
      ).catch((error) => {
        console.error("Failed to resolve title-only show metadata", error);
        return null;
      });
      if (currentMediaRenderToken() !== renderToken) return;
      if (titleMetadata?.id || titleMetadata?.external_ids?.tvdb_id) {
        canonicalizeBareShowRoute(
          titleMetadata,
          title,
          activeSeasonNum ?? state.activeShowModalSeason,
          activeEpisodeNum ?? state.activeShowModalEpisode,
          titleMetadata.external_ids?.tvdb_id,
        );
        await renderShowDetailFromMetadata(titleMetadata, renderToken, localDetailPromise);
        return;
      }
    }
  }

  // Never send the placeholder title through a broad TMDB search. It can
  // resolve to an unrelated result or fail before the user gets any repair
  // controls. Keep a local shell instead; Fix Match can rematch by show title
  // even when there is no usable metadata id or episode payload.
  if (!show && showKey === "unknown-show") {
    const unknownRows = (state.history || []).filter((row) => (
      row.media_type === "episode" && slug(showTitleFrom(row.show_title || row.title)) === showKey
    ));
    show = {
      title: "Unknown Show",
      id: unknownRows[0]?.id || "",
      episodes: unknownRows,
      episode_count: unknownRows.length,
      season_count: new Set(unknownRows.map((row) => row.season).filter((value) => value != null)).size,
    };
    mergeShowDetail(show);
  }

  if (!show) {
    // Not in local library. If the now-playing session has a TMDB ID, delegate to
    // the TMDB-based loader (which has its own title fallback). Otherwise try a
    // TMDB title search using the slug as a title hint.
    const matchingSession = state.activeSessions.find((s) => {
      const t = showTitleFrom(s.showTitle || s.show_title || s.title || "");
      return slug(t) === showKey;
    });
    if (matchingSession?.ids?.tmdb) {
      await openShowImmersiveModalByTmdbId(matchingSession.ids.tmdb);
      return;
    }
    const sessionTitle = matchingSession
      ? showTitleFrom(matchingSession.showTitle || matchingSession.show_title || matchingSession.title || "")
      : "";
    const titleGuess = sessionTitle || showKey.replace(/-/g, " ");
    if (titleGuess) {
      state.activeShowTmdbId = null;
      const tmdbData = await fetchTmdbDetails("tv", null, titleGuess);
      if (tmdbData?.id) {
        await openShowImmersiveModalByTmdbId(tmdbData.id);
        return;
      }
      if (tmdbData?.external_ids?.tvdb_id) {
        await openShowImmersiveModalByTvdbId(tmdbData.external_ids.tvdb_id);
        return;
      }
    }
    if (currentMediaRenderToken() !== renderToken) return;
    root.innerHTML = `
      <div class="modal-backdrop-image"></div>
      <div class="immersive-container media-detail-page">
        <div class="empty-log">
          <b style="color: var(--danger);">TV Show Not Found</b>
          <span>Could not locate the series "${escapeHtml(showKey)}" in your archive.</span>
        </div>
      </div>
    `;
    return;
  }

  if (currentMediaRenderToken() !== renderToken) return;
  if (!Array.isArray(show.episodes) || !show.episodes.length) {
    state.activeShowModalSeason = activeSeasonNum;
    renderShowModalContent(show, {
      activeSeasonNum,
      tmdbData: null,
      seasonDetailsByNumber: new Map(),
      loading: true,
      watchHistoryLoading: true,
    });
    hydratePosters(root);
    const detailedShow = await loadShowDetail(show).catch((error) => {
      console.error("Failed to load show detail", error);
      setMessage(`Failed to load show details: ${error.message}`, "error");
      return null;
    });
    if (detailedShow) show = detailedShow;
    if (currentMediaRenderToken() !== renderToken) return;
    if (!Array.isArray(show.episodes) || !show.episodes.length) {
      if (showKey === "unknown-show" || sanitizeTitle(show.title) === "Unknown Show") {
        state.activeShowModalSeason = activeSeasonNum;
        renderShowModalContent(show, {
          activeSeasonNum,
          tmdbData: null,
          seasonDetailsByNumber: new Map(),
          loading: false,
          watchHistoryLoading: false,
        });
        hydratePosters(root);
        return;
      }
      root.innerHTML = `
        <div class="modal-backdrop-image"></div>
        <div class="immersive-container media-detail-page">
          <div class="empty-log">
            <b>No episode rows found</b>
            <span>No local episode history was available.</span>
          </div>
        </div>
      `;
      return;
    }
  }

  if (currentMediaRenderToken() !== renderToken) return;
  state.activeShowModalSeason = activeSeasonNum;
  const requestToken = ++state.showModalRequestToken;
  const playbackProgressPromise = ensurePlaybackProgressLoaded();
  renderShowModalContent(show, {
    activeSeasonNum,
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: true,
    watchHistoryLoading: true,
    patchExisting: Boolean(root.querySelector(".media-detail-page")),
  });
  // Progress is secondary to the first paint. Refresh it after the shell is
  // visible so a slow/no-store progress request cannot block artwork and
  // episode history from appearing.
  playbackProgressPromise.then(() => {
    if (requestToken !== state.showModalRequestToken || state.activeShowModalKey !== showKey) return;
    const current = state.activeShowRenderContext;
    if (!current) return;
    renderShowModalContent(current.show, { ...current, activeSeasonNum: state.activeShowModalSeason, patchExisting: true });
  }).catch(() => { });
  // A history-linked orphan has an intentionally identifiable local shell;
  // do not let the background title lookup replace it with the stale
  // `unknown-show` placeholder before Fix Match can be used.
  if (!orphanShell) hydrateImmersiveShowModal(showKey, activeSeasonNum, requestToken).catch((error) => {
    console.error("Failed to hydrate show modal", error);
    if (requestToken === state.showModalRequestToken && state.activeShowModalKey === showKey) {
      renderShowModalContent(show, { activeSeasonNum, tmdbData: null, seasonDetailsByNumber: new Map(), loading: false, patchExisting: true });
    }
  });
  hydratePosters(root);
}
