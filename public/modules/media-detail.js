import { state, elements } from "./state.js?v=2.1.0.0.5";
import { slug, movieSlug, movieHref, movieTmdbHref, tvShowTmdbHref, showName, showTitleFrom } from "./utils.js?v=2.1.0.0.5";
import { dedupeMediaRecords } from "./media-records.js?v=2.1.0.0.5";
import { isWatchedHistoryAction } from "./sync.js?v=2.1.0.0.5";
import {
  initMediaDetail, authHeaders, mediaDetailRoot, mediaDetailLoaderHtml, setMediaDetailActions,
  prepareInlineMediaDetail, syncMediaActionsMenuState, syncTopbarControlsMenuState,
  openDebugModal, closeDebugModal, clearMediaDetailState, closeMediaDetail,
  openMediaInfoModal, closeMediaInfoModal,
  bumpMediaRenderToken, currentMediaRenderToken,
} from "./media-detail-context.js?v=2.1.0.0.5";
import {
  openShowImmersiveModalByTitle, openShowImmersiveModalByTmdbId, openShowImmersiveModalByTvdbId, openShowInlineDetail,
  renderImmersiveShowModal, renderShowModalContent, ensureAllShowEpisodeDetailsForWatch, patchShowModalEpisodeFromLive, patchShowModalEpisodesSavingState, syncShowModalWatchActionControls, scrollSeasonAccordionIntoView,
} from "./media-detail-show.js?v=2.1.0.0.5";
import {
  renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId, patchMovieWatchedState, syncMovieWatchActionControls,
} from "./media-detail-movie.js?v=2.1.0.0.5";
import { fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } from "./media-detail-shared.js?v=2.1.0.0.5";
import { movieById, movieBySlugOrId, nowPlayingHref } from "./media-routing.js?v=2.1.0.0.5";
// Lookup helpers live in the core graph so the dashboard (Now Playing links)
// can use them without loading media detail; re-exported for existing importers.
export { movieById, movieBySlugOrId, nowPlayingHref };
import { fetchTmdbDetails } from "./tmdb.js?v=2.1.0.0.5";

export {
  initMediaDetail,
  mediaDetailRoot,
  mediaDetailLoaderHtml,
  syncMediaActionsMenuState,
  syncTopbarControlsMenuState,
  closeDebugModal,
  openMediaInfoModal,
  closeMediaInfoModal,
  clearMediaDetailState,
  closeMediaDetail,
  openShowInlineDetail,
  renderImmersiveShowModal,
  renderShowModalContent,
  ensureAllShowEpisodeDetailsForWatch,
  patchShowModalEpisodeFromLive,
  patchShowModalEpisodesSavingState,
  syncShowModalWatchActionControls,
  scrollSeasonAccordionIntoView,
  openShowImmersiveModalByTmdbId,
  openShowImmersiveModalByTvdbId,
  renderMovieImmersiveModalContent,
  openMovieImmersiveModalByTmdbId,
  patchMovieWatchedState,
  syncMovieWatchActionControls,
  fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus,
};

export function syncActiveMediaDetailState() {
  const showUpdated = syncShowModalWatchActionControls();
  const movieUpdated = syncMovieWatchActionControls();
  return showUpdated || movieUpdated;
}

export function historyById(id) {
  return state.history.find((entry) => String(entry.id) === String(id));
}
export function movieSearchFromRouteValue(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/^tmdb\/\d+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function fetchMovieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  const search = movieSearchFromRouteValue(key);
  if (!search) return null;
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("search", search);
    url.searchParams.set("limit", "30");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    const movies = Array.isArray(body.movies) ? body.movies : [];
    const movie = movies.find((entry) => movieSlug(entry) === keySlug) || movies[0] || null;
    if (movie) {
      state.moviesRaw = dedupeMediaRecords([...state.moviesRaw, movie], "movies");
    }
    return movie;
  } catch {
    return null;
  }
}
export async function resolveMovieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  // Preserve direct watch-history URLs, including legacy stats links. Slug
  // routes must resolve through /api/movies so the page receives the server's
  // deduplicated record with the complete playHistory array.
  const directRecord = movieById(key);
  if (directRecord) return directRecord;
  return await fetchMovieBySlugOrId(value) || movieBySlugOrId(value);
}
export async function openImmersiveModal(id) {
  const renderToken = bumpMediaRenderToken();
  setMediaDetailActions("");
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
    <div class="immersive-container media-detail-page">
      ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
      ${mediaDetailLoaderHtml()}
    </div>
  `;
  let entry = movieById(id);
  if (!entry) {
    try {
      const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.row) {
        entry = body.row;
      }
    } catch (error) {
      console.error("Failed to fetch watch history item", error);
    }
  }
  if (currentMediaRenderToken() !== renderToken) return;
  if (!entry) {
    root.innerHTML = `
      <div class="immersive-container">
        ${!state.mediaDetailInline ? '<button class="immersive-back-button" type="button">← Back</button>' : ''}
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Content not found</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Could not locate this watch history record.</span>
        </div>
      </div>
    `;
    return;
  }
  if (!isWatchedHistoryAction(entry)) {
    openDebugModal(entry);
    return;
  }
  if (entry.media_type === "episode") {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    await openShowImmersiveModalByTitle(showTitle, entry);
  } else {
    await renderMovieImmersiveModalContent(entry);
  }
}
export async function openHistoryDebugModal(id) {
  const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `History detail failed with ${response.status}`);
  openDebugModal(body.row || historyById(id));
}

export async function openMovieImmersiveModal(id) {
  await openImmersiveModal(id);
}
export async function openMovieInlineDetail(id) {
  prepareInlineMediaDetail("movies");
  const renderToken = bumpMediaRenderToken();
  const requestStillCurrent = () => currentMediaRenderToken() === renderToken
    && state.mediaDetailInline
    && state.activeView === "explorer";
  const movie = await resolveMovieBySlugOrId(id);
  if (!requestStillCurrent()) return;
  if (movie) {
    await renderMovieImmersiveModalContent(movie);
    return;
  }

  // Title-only links predate canonical /movie/tmdb/:id routes. Once a movie
  // is marked unwatched it disappears from /api/movies and the in-memory
  // watched lists, but the old URL must remain useful. Resolve its slug via
  // metadata and render the same unwatched detail used by canonical routes.
  const legacyTitle = movieSearchFromRouteValue(id);
  if (legacyTitle) {
    const details = await fetchTmdbDetails("movie", null, legacyTitle, {}, { immediate: true }).catch(() => null);
    if (details?.id && requestStillCurrent()) {
      await openMovieImmersiveModalByTmdbId(details.id);
      return;
    }
  }
  if (!requestStillCurrent()) return;
  await openImmersiveModal(id);
}
export async function openRecommendedMovieInlineDetail(tmdbId) {
  prepareInlineMediaDetail("movies");
  await openMovieImmersiveModalByTmdbId(tmdbId);
}
