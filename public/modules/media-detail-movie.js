import { state, elements } from "./state.js?v=2.2.2.0.0";
import { escapeHtml, escapeAttribute, formatDate, formatTmdbDate, isDemoMode } from "./utils.js?v=2.2.2.0.0";
import { posterUrlFor, tmdbImage, tmdbPoster, bestTmdbLogo, proxiedArtworkUrl, hydratePosters } from "./images.js?v=2.2.2.0.0";
import { isWatchedHistoryAction, isMediaSyncing, mediaSyncNoticeHtml } from "./sync.js?v=2.2.2.0.0";
import { fetchTmdbDetails, anidbDisplayTitle, anidbAttributionHtml } from "./tmdb.js?v=2.2.2.0.0";
import { renderWatchDatePrompt, isMovieSavingWatchAction } from "./watch-action.js?v=2.2.2.0.0";
import { authHeaders, mediaDetailRoot, mediaDetailLoaderHtml, setMediaDetailActions, mediaInfoActionHtml, mediaForceSyncActionHtml, mediaToolsActionHtml, setMediaInfoContext, bumpMediaRenderToken, currentMediaRenderToken } from "./media-detail-context.js?v=2.2.2.0.0";
import { personalRatingPillHtml, personalMediaActionsHtml } from "./personal-media.js?v=2.2.2.0.0";
import { droppedTitleActionHtml } from "./dropped-titles.js?v=2.2.2.0.0";
import {
  renderCastSection, renderTrailersSection, renderReviewsSection, renderMediaImagesSection, renderMediaFacts,
  renderExternalRatingPills, ratingPillHtml, renderSeerrRequestPill, fetchSeerrMediaStatus,
  refreshActiveMediaDetailAfterSeerrStatus, rankedRecommendations, recommendedTvShowsForMovie,
  renderRecommendationSection, hydrateMediaAppLinks, renderCollectionSection, mediaAppLinksHtml,
  markDetailPrimaryReady,
} from "./media-detail-shared.js?v=2.2.2.0.0";

// Watch history list - playHistory (every { id, watched_at, source } entry for
// this movie, collapsed server-side in dedupeMovies/collapseMovieCluster) has
// more than one entry once a genuine rewatch has been recorded.
function rewatchSummaryHtml(movie) {
  const history = Array.isArray(movie?.playHistory) ? movie.playHistory : [];
  if (history.length < 2) return "";
  const rows = [...history]
    .sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))
    .map((entry) => `
      <li class="episode-watch-history-row">
        <span class="episode-watch-history-date">${escapeHtml(formatDate(entry.watched_at))}</span>
      </li>
    `)
    .join("");
  return `
    <div class="episode-watch-history movie-rewatch-history">
      <div class="episode-watch-history-head">
        <span class="rewatch-badge" title="Watched ${history.length} times">&#8635; Watch History &times;${history.length}</span>
      </div>
      <ul class="episode-watch-history-list movie-watch-history-list">
        ${rows}
        <li class="watch-history-toggle-item" hidden>
          <button class="watch-history-toggle" type="button" data-watch-history-toggle aria-expanded="false">
            <span class="watch-history-toggle-icon" aria-hidden="true">&#9662;</span>
            <span class="watch-history-toggle-label">Show more</span>
          </button>
        </li>
      </ul>
    </div>
  `;
}

export function syncRewatchHistoryToggle(root) {
  for (const history of root.querySelectorAll(".movie-rewatch-history")) {
    const list = history.querySelector(".movie-watch-history-list");
    const toggle = history.querySelector("[data-watch-history-toggle]");
    const toggleItem = toggle?.closest(".watch-history-toggle-item") || toggle;
    if (!list || !toggle) continue;
    if (history.classList.contains("is-expanded")) {
      for (const row of list.querySelectorAll(".episode-watch-history-row")) row.hidden = false;
      toggleItem.hidden = false;
      continue;
    }
    const rows = [...list.querySelectorAll(".episode-watch-history-row")];
    for (const row of rows) row.hidden = false;
    toggleItem.hidden = true;
    if (list.scrollHeight > list.clientHeight + 1) {
      toggleItem.hidden = false;
      for (let index = rows.length - 1; index >= 0 && list.scrollHeight > list.clientHeight + 1; index -= 1) {
        rows[index].hidden = true;
      }
    }
    if (!list.dataset.watchHistoryObserved && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => syncRewatchHistoryToggle(root));
      observer.observe(list);
      list.dataset.watchHistoryObserved = "true";
    }
  }
}

// Authoritatively check whether a movie is already in watch history. state.history
// is only the dashboard preview, so fall back to the server (which holds the full
// history) to avoid showing a saved movie as unwatched after a refresh.
export async function fetchWatchedMovieByTmdb(tmdbId, title) {
  try {
    const url = new URL("/api/movies", window.location.origin);
    url.searchParams.set("search", title || "");
    url.searchParams.set("limit", "30");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    const movies = Array.isArray(body.movies) ? body.movies : [];
    const byTmdbId = tmdbId
      ? movies.find((movie) => String(movie.tmdb_id || "") === String(tmdbId))
      : null;
    if (byTmdbId) return byTmdbId;
    const normalizedTitle = String(title || "").trim().toLowerCase();
    return normalizedTitle
      ? movies.find((movie) => String(movie.title || "").trim().toLowerCase() === normalizedTitle) || null
      : null;
  } catch {
    return null;
  }
}

export async function renderMovieImmersiveModalContent(movie) {
  // Half of a two-token handshake with media-detail-show.js - capture this
  // before any rehydration request. If navigation clears the detail while the
  // request is in flight, its response must not become a new render by taking
  // a token after the user has already left the page.
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1; // invalidate any in-flight show hydrate
  state.activeMovieModalId = movie?.id || null;
  state.activeMovieTmdbId = movie?.tmdb_id ? String(movie.tmdb_id) : null;

  // Route state can contain the lightweight latest-play record rather than the
  // server's collapsed movie record. Rehydrate before the first paint so every
  // detail entry point shows the same complete watch history. A dashboard
  // preview row also has no sync or watch-source record, so it is always
  // swapped for the full record the Info panel reads them from.
  if (movie && (!Array.isArray(movie.playHistory) || movie.playHistory.length < 2)) {
    const lacksWatchRecord = !movie.sync_dispatch_telemetry && !movie.watch_provenance;
    const fullMovie = await fetchWatchedMovieByTmdb(movie.tmdb_id, movie.title);
    if (currentMediaRenderToken() !== renderToken) return false;
    if (fullMovie && (lacksWatchRecord || (Array.isArray(fullMovie.playHistory) && fullMovie.playHistory.length > (movie.playHistory?.length || 0)))) {
      movie = fullMovie;
    }
  }
  state.activeMovieModalId = movie.id;
  state.activeMovieTmdbId = movie.tmdb_id ? String(movie.tmdb_id) : null;
  if (!state.mediaDetailInline) {
    elements.debugModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const modalPanel = elements.debugModal.querySelector(".modal-panel");
    if (modalPanel) {
      modalPanel.classList.add("modal-panel--immersive");
    }
  }
  const root = mediaDetailRoot();
  const isSaving = isMovieSavingWatchAction(movie.tmdb_id);

  // Phase 1: Render immediately with all available local data - no blank screen.
  _renderWatchedMovieContent(root, movie, { tmdbData: null, loading: true, imdbPillHtml: "", tvRecommendations: [], isSaving });


  // Fetch TMDB details (primary enrichment).
  const tmdbData = await fetchTmdbDetails("movie", movie.tmdb_id, movie.title, {}, { immediate: true });
  if (currentMediaRenderToken() !== renderToken) return false; // navigated away while loading

  if (tmdbData && tmdbData.id) {
    state.activeMovieTmdbId = String(tmdbData.id);
  }

  // For YouTube-only content, fetch metadata from our backend.
  let youtubeMeta = null;
  if (!tmdbData && movie.youtube_url) {
    try {
      const ytRes = await fetch(`/api/youtube-meta?url=${encodeURIComponent(movie.youtube_url)}`, { headers: authHeaders() });
      const ytData = await ytRes.json();
      if (!ytData.error) youtubeMeta = ytData;
    } catch { /* non-fatal */ }
    if (currentMediaRenderToken() !== renderToken) return false; // navigated away while loading
  }

  // Phase 2: Render with TMDB data immediately - don't wait for OMDb/TV recs.
  _renderWatchedMovieContent(root, movie, { tmdbData, youtubeMeta, loading: false, imdbPillHtml: "", tvRecommendations: [], isSaving });

  // Phase 3: Fetch the OMDb rating. The "Recommended TV Shows" rail is started
  // here but deliberately NOT awaited: it asks TMDB "is there a series named
  // like this film?" for up to four title candidates, one after another, and a
  // cold candidate measured 241-380ms against the live API - up to about a
  // second of speculative lookups for a rail below the fold that usually ends
  // up empty. Awaiting it here held the IMDb rating pill back for that whole
  // time. It now patches itself in when it arrives, the same way the unwatched
  // path below already did.
  const imdbId = movie.imdb_id || tmdbData?.imdb_id || "";
  const tvRecommendationsPromise = tmdbData
    ? recommendedTvShowsForMovie(movie.title, tmdbData).catch(() => [])
    : Promise.resolve([]);
  const omdbRes = await (imdbId && state.savedConfig?.omdb?.configured
    ? fetch(`/api/omdb-rating?imdbId=${encodeURIComponent(imdbId)}`, { headers: authHeaders() }).catch(() => null)
    : Promise.resolve(null));
  if (currentMediaRenderToken() !== renderToken) return false;

  let imdbPillHtml = "";
  if (omdbRes?.ok) {
    const omdbData = await omdbRes.json().catch(() => null);
    if (omdbData?.imdbRating) {
      imdbPillHtml = ratingPillHtml({
        label: "IMDb",
        value: `${Math.round(parseFloat(omdbData.imdbRating) * 10)}%`,
        href: `https://www.imdb.com/title/${escapeAttribute(imdbId)}`,
        title: `IMDb rating: ${omdbData.imdbRating}/10`,
      });
    }
  }
  if (currentMediaRenderToken() !== renderToken) return false;

  // Phase 3 render: patch in the OMDb pill as soon as it is known.
  if (imdbPillHtml) {
    _renderWatchedMovieContent(root, movie, { tmdbData, youtubeMeta, loading: false, imdbPillHtml, tvRecommendations: [], isSaving });
  }

  // Phase 4: the speculative rail, whenever it finishes. Re-rendering only when
  // it actually found something keeps an empty result completely free.
  tvRecommendationsPromise.then((tvRecommendations) => {
    if (!tvRecommendations.length) return;
    if (currentMediaRenderToken() !== renderToken) return;
    _renderWatchedMovieContent(root, movie, { tmdbData, youtubeMeta, loading: false, imdbPillHtml, tvRecommendations, isSaving });
  }).catch(() => { /* non-fatal: the rail simply stays absent */ });

  const movieSeerrTmdbId = tmdbData?.id || movie.tmdb_id;
  if (movieSeerrTmdbId) {
    fetchSeerrMediaStatus("movie", movieSeerrTmdbId)
      .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", movieSeerrTmdbId); });
  }
  hydratePosters(root);
  return true;
}

// Shared renderer for a watched movie. Called up to three times per navigation:
// (1) immediately with local data only, (2) once TMDB resolves, (3) once OMDb +
// TV recs resolve. Only re-renders when there is new data to add.
function _renderWatchedMovieContent(root, movie, {
  tmdbData = null,
  youtubeMeta = null,
  loading = false,
  imdbPillHtml = "",
  tvRecommendations = [],
  isSaving = null,
} = {}) {
  const localPoster = posterUrlFor(movie) || "/favicon.svg";
  const isSyncing = isMediaSyncing(movie);
  let backdropUrl = proxiedArtworkUrl(movie.backdrop_url, "backdrop") || "";
  let posterUrl = posterUrlFor(movie);
  let overview = loading ? "Loading synopsis…" : "No synopsis available.";
  let released = "Unknown Release Date";
  let rating = "";
  let recommendations = [];

  if (tmdbData) {
    if (!backdropUrl && tmdbData.backdrop_path) {
      backdropUrl = tmdbData.cached_backdrop_url || tmdbImage(tmdbData.backdrop_path, "original");
    }
    if (tmdbData.poster_path && !posterUrl) {
      posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie");
    }
    overview = tmdbData.overview || "No synopsis available.";
    released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : released;
    rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "";
    recommendations = rankedRecommendations(tmdbData, "movie");
  } else if (youtubeMeta && !isDemoMode()) {
    if (youtubeMeta.thumbnails?.[0]) posterUrl = youtubeMeta.thumbnails[0];
    overview = youtubeMeta.description || "No synopsis available.";
    if (youtubeMeta.publishedAt) released = `Published ${formatTmdbDate(youtubeMeta.publishedAt.slice(0, 10))}`;
  }

  const movieTitle = movie.title;
  const logoUrl = proxiedArtworkUrl(movie.logo_url || bestTmdbLogo(tmdbData), "logo");
  const ratingBadgeHtml = rating ? renderExternalRatingPills("movie", tmdbData, movieTitle, rating) : "";
  const personalRatingHtml = personalRatingPillHtml({
    media_type: "movie",
    title: movieTitle,
    tmdb_id: tmdbData?.id || movie.tmdb_id || "",
    tvdb_id: movie.tvdb_id || "",
    imdb_id: tmdbData?.imdb_id || movie.imdb_id || "",
    poster_url: posterUrl || localPoster,
    overview,
    release_date: tmdbData?.release_date || movie.release_date || "",
  });
  const ratingsFactHtml = `${ratingBadgeHtml || (tmdbData ? renderExternalRatingPills("movie", tmdbData, movieTitle) : "")}${imdbPillHtml}${personalRatingHtml}`;
  const appLinksFactHtml = tmdbData ? mediaAppLinksHtml(tmdbData, "movie") : "";
  setMediaInfoContext({
    mediaType: "movie",
    media: movie,
    tmdbData,
    posterUrl: posterUrl || localPoster,
    overview,
    summary: { watchedCount: 1, totalCount: 1, progressPercent: 100 },
    records: [movie],
  });
  const eyeSlashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 4 8 4c2.12 0 3.879.668 5.168 1.957A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12 8 12c-2.12 0-3.879-.668-5.168-1.957A13.133 13.133 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>`;
  const youtubeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.58v-.075c.001-.194.01-1.108.082-2.06l.008-.105.009-.104c.05-.572.124-1.14.235-1.558a2.007 2.007 0 0 1 1.415-1.42c1.16-.312 5.569-.334 6.18-.335h.142z"/><path d="M6.168 10.302l3.24-1.62-3.24-1.62v3.24z"/></svg>`;

  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">
        ${youtubeIcon}
        <span>Trailer</span>
       </a>`
    : "";

  const personalMediaItem = {
    media_type: "movie",
    title: movieTitle,
    tmdb_id: tmdbData?.id || movie.tmdb_id || "",
    tvdb_id: movie.tvdb_id || "",
    imdb_id: tmdbData?.imdb_id || movie.imdb_id || "",
    poster_url: posterUrl || localPoster,
    overview,
    release_date: tmdbData?.release_date || movie.release_date || "",
  };

  setMediaDetailActions(`
    ${personalMediaActionsHtml(personalMediaItem)}${droppedTitleActionHtml(personalMediaItem)}
    ${ytWatchBtn}
    ${mediaToolsActionHtml(`
      <button class="action-pill action-pill-ghost" type="button" ${isSaving || isSyncing ? "disabled" : ""} data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-tmdb-id="${escapeAttribute(tmdbData?.id || movie.tmdb_id || "")}" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">
        ${eyeSlashIcon}
        <span>Mark unwatched</span>
      </button>
      ${mediaForceSyncActionHtml({
        type: "movie",
        title: movieTitle,
        tmdbId: tmdbData?.id || movie.tmdb_id || "",
        tvdbId: movie.tvdb_id || "",
        imdbId: tmdbData?.imdb_id || movie.imdb_id || "",
        disabled: isSaving || isSyncing,
      })}
      ${mediaInfoActionHtml()}
      <button class="action-pill media-edit-image-btn" type="button" ${isSaving ? "disabled" : ""} data-artwork-scope="movie" data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || movieTitle || "")}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}" data-backdrop-url="${escapeAttribute(movie.backdrop_url || "")}">
        ${imageIcon}
        <span>Edit Images</span>
      </button>
      <button class="action-pill media-fix-match-btn" type="button" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">
        ${searchIcon}
        <span>Fix Match</span>
      </button>
      <button class="action-pill action-pill-danger" type="button" ${isSaving ? "disabled" : ""} data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-type="movie" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">
        ${trashIcon}
        <span>Delete</span>
      </button>
    `)}
  `);

  root.innerHTML = `
      <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl || localPoster)}');"></div>
      <div class="immersive-container media-detail-page${loading ? " is-loading-metadata" : ""}">
        ${mediaSyncNoticeHtml([movie], "this movie")}
        <header class="immersive-header">
          <img class="immersive-poster-img" src="${escapeAttribute(posterUrl || localPoster)}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" data-lightbox-src="${escapeAttribute(posterUrl || localPoster)}" />
          <div class="immersive-meta">
            ${logoUrl && !tmdbData?.anidb ? `<img class="immersive-logo" data-err="logo-title" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(anidbDisplayTitle(tmdbData, movieTitle))}</h2>`}
            ${youtubeMeta?.channelName ? `<p class="immersive-subtitle">${escapeHtml(youtubeMeta.channelName)}</p>` : ""}
            <div class="media-detail-bottom-stack">
              ${renderSeerrRequestPill("movie", tmdbData?.id || movie.tmdb_id, true)}
              <p class="immersive-overview">${escapeHtml(overview)}</p>${anidbAttributionHtml(tmdbData)}
              <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
                <h3>Watch Status</h3>
                <div class="progress-label-row">
                  <span>Watched on ${formatDate(movie.watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" ${isSaving ? "disabled" : ""} data-edit-id="${escapeAttribute(movie.id)}" data-watched-at="${escapeAttribute(movie.watched_at || "")}">✎</button></span>
                  <span>100% complete</span>
                </div>
                <div class="progress-bar-track">
                  <div class="progress-bar-fill" style="width: 100%;"></div>
                </div>
                ${rewatchSummaryHtml(movie)}
              </section>
            </div>
          </div>
          ${renderMediaFacts(tmdbData, "movie", "sidebar", { ratingsHtml: ratingsFactHtml, appLinksHtml: appLinksFactHtml })}
        </header>
        ${tmdbData ? renderCastSection(tmdbData) : ""}
        ${tmdbData ? renderMediaImagesSection(tmdbData) : ""}
        ${tmdbData ? renderTrailersSection(tmdbData) : ""}
        ${tmdbData ? renderReviewsSection(tmdbData) : ""}
        ${tmdbData ? renderCollectionSection(tmdbData) : ""}
        ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
        ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
      </div>
      ${renderWatchDatePrompt(state.pendingWatchAction)}
    `;
  hydratePosters(root);
  hydrateMediaAppLinks(root);
  syncRewatchHistoryToggle(root);
  // Title, artwork, synopsis, watch state, and actions are all real once the
  // TMDB pass has rendered (loading=false).
  if (!loading) markDetailPrimaryReady("movie");
}

export function patchMovieWatchedState(movie) {
  if (!movie?.id) return false;
  const root = mediaDetailRoot();
  const page = root?.querySelector?.(".media-detail-page");
  if (!page) return false;

  state.activeMovieModalId = movie.id;
  state.activeMovieTmdbId = movie.tmdb_id ? String(movie.tmdb_id) : state.activeMovieTmdbId;

  if (state.activeMediaInfo?.mediaType === "movie") {
    setMediaInfoContext({
      ...state.activeMediaInfo,
      media: movie,
      records: [movie],
      summary: { watchedCount: 1, totalCount: 1, progressPercent: 100 },
    });
  }
  syncMovieWatchActionControls();

  const eyeSlashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 4 8 4c2.12 0 3.879.668 5.168 1.957A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12 8 12c-2.12 0-3.879-.668-5.168-1.957A13.133 13.133 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>`;
  const imageIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>`;
  const searchIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3h11V2h-11v1z"/></svg>`;
  const youtubeIcon = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.58v-.075c.001-.194.01-1.108.082-2.06l.008-.105.009-.104c.05-.572.124-1.14.235-1.558a2.007 2.007 0 0 1 1.415-1.42c1.16-.312 5.569-.334 6.18-.335h.142z"/><path d="M6.168 10.302l3.24-1.62-3.24-1.62v3.24z"/></svg>`;

  const ytWatchBtn = movie.youtube_url
    ? `<a class="action-pill" href="${escapeAttribute(movie.youtube_url)}" target="_blank" rel="noopener noreferrer">
        ${youtubeIcon}
        <span>Trailer</span>
       </a>`
    : "";

  const personalMediaItem = {
    media_type: "movie",
    title: movie.title,
    tmdb_id: movie.tmdb_id || "",
    tvdb_id: movie.tvdb_id || "",
    imdb_id: movie.imdb_id || "",
    poster_url: posterUrlFor(movie) || "/favicon.svg",
    overview: "",
    release_date: movie.release_date || "",
  };

  setMediaDetailActions(`
    ${personalMediaActionsHtml(personalMediaItem)}${droppedTitleActionHtml(personalMediaItem)}
    ${ytWatchBtn}
    ${mediaToolsActionHtml(`
      <button class="action-pill action-pill-ghost" type="button" data-unwatch-id="${escapeAttribute(movie.id)}" data-unwatch-kind="movie" data-unwatch-tmdb-id="${escapeAttribute(movie.tmdb_id || "")}" data-unwatch-label="${escapeAttribute(movie.title || "this movie")}">
        ${eyeSlashIcon}
        <span>Mark unwatched</span>
      </button>
      ${mediaForceSyncActionHtml({
        type: "movie",
        title: movie.title,
        tmdbId: movie.tmdb_id || "",
        tvdbId: movie.tvdb_id || "",
        imdbId: movie.imdb_id || "",
      })}
      ${mediaInfoActionHtml()}
      <button class="action-pill media-edit-image-btn" type="button" data-artwork-scope="movie" data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-poster-url="${escapeAttribute(movie.poster_url || "")}" data-logo-url="${escapeAttribute(movie.logo_url || "")}" data-backdrop-url="${escapeAttribute(movie.backdrop_url || "")}">
        ${imageIcon}
        <span>Edit Images</span>
      </button>
      <button class="action-pill media-fix-match-btn" type="button" data-edit-id="${escapeAttribute(movie.id)}" data-title="${escapeAttribute(movie.title || "")}" data-media-type="movie">
        ${searchIcon}
        <span>Fix Match</span>
      </button>
      <button class="action-pill action-pill-danger" type="button" data-delete-media-id="${escapeAttribute(movie.id)}" data-delete-media-type="movie" data-delete-media-title="${escapeAttribute(movie.title || "this movie")}">
        ${trashIcon}
        <span>Delete</span>
      </button>
    `)}
  `);

  const progressSection = page.querySelector(".progress-section");
  if (progressSection) {
    progressSection.innerHTML = `
            <h3>Watch Status</h3>
            <div class="progress-label-row">
              <span>Watched on ${formatDate(movie.watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(movie.id)}" data-watched-at="${escapeAttribute(movie.watched_at || "")}">✎</button></span>
              <span>100% complete</span>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: 100%;"></div>
            </div>
            ${rewatchSummaryHtml(movie)}
    `;
    syncRewatchHistoryToggle(page);
  }

  return true;
}

export function syncMovieWatchActionControls() {
  const root = mediaDetailRoot();
  const page = root?.querySelector?.(".media-detail-page");
  const actionRoot = typeof document?.getElementById === "function"
    ? document.getElementById("mediaDetailActions")
    : null;
  const movie = state.activeMediaInfo?.mediaType === "movie" ? state.activeMediaInfo.media : null;
  if (!page || !movie) return false;
  const syncing = isMediaSyncing(movie);
  const locallySaving = isMovieSavingWatchAction(movie.tmdb_id);
  const locallyUnwatching = Boolean(movie.id && state.savingUnwatchIds.has(movie.id));
  const controls = [
    ...Array.from(page.querySelectorAll?.('[data-movie-mark-watched]') || []),
    ...Array.from(actionRoot?.querySelectorAll?.('[data-unwatch-kind="movie"]') || []),
    ...Array.from(actionRoot?.querySelectorAll?.('[data-media-force-sync]') || []),
  ];
  for (const button of controls) {
    if (syncing) {
      button.disabled = true;
      button.title = "This movie is syncing; watch changes are paused until it completes.";
    } else if (button.dataset.syncDetailManaged === "true") {
      button.disabled = button.matches?.('[data-movie-mark-watched]')
        ? locallySaving
        : button.matches?.('[data-unwatch-kind="movie"]')
          ? locallyUnwatching
          : false;
      button.removeAttribute("title");
    }
    button.dataset.syncDetailManaged = "true";
  }
  const notice = page.querySelector("[data-media-detail-sync-notice]");
  if (syncing && !notice) page.insertAdjacentHTML("afterbegin", mediaSyncNoticeHtml([movie], "this movie"));
  else if (!syncing) notice?.remove();
  return true;
}

export async function openMovieImmersiveModalByTmdbId(tmdbId) {
  const renderToken = bumpMediaRenderToken();
  state.showModalRequestToken += 1;
  state.activeMovieTmdbId = String(tmdbId);
  // Fast path: if it's in the loaded preview, show its watched detail immediately.
  const existingWatched = state.history.find(
    (entry) => entry.media_type === "movie" && isWatchedHistoryAction(entry) && String(entry.tmdb_id || "") === String(tmdbId),
  );
  if (existingWatched) {
    // The history preview is intentionally lightweight and does not include
    // the deduped playHistory array. Paint it immediately, then replace it
    // with the authoritative movie record so rewatches are visible on first
    // open instead of only after editing/saving a watch date.
    const rendered = await renderMovieImmersiveModalContent(existingWatched);
    if (!rendered) return;
    const firstRenderToken = currentMediaRenderToken();
    const fullMovie = await fetchWatchedMovieByTmdb(tmdbId, existingWatched.title);
    if (currentMediaRenderToken() !== firstRenderToken || state.activeMovieTmdbId !== String(tmdbId)) return;
    if (fullMovie) {
      await renderMovieImmersiveModalContent(fullMovie);
    }
    return;
  }
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
    <div class="immersive-container">
      ${mediaDetailLoaderHtml("Loading movie details")}
    </div>
  `;
  const tmdbData = await fetchTmdbDetails("movie", tmdbId, null, {}, { immediate: true });
  if (currentMediaRenderToken() !== renderToken) return;
  if (!tmdbData) {
    root.innerHTML = `
      <div class="immersive-container">
        <div style="display: flex; justify-content: center; align-items: center; min-height: 200px; flex-direction: column; gap: var(--space-2);">
          <span style="color: var(--danger); font-size: 1.1rem; font-weight: bold;">Could not load movie details</span>
          <span style="color: var(--muted); font-size: 0.9rem;">Please check your TMDB API Key in Settings.</span>
        </div>
      </div>
    `;
    return;
  }
  const movieTitle = tmdbData.title;
  // state.history is only the dashboard preview; confirm against the server so a
  // movie marked watched (especially with an old release date) still shows watched.
  const persistedWatched = await fetchWatchedMovieByTmdb(tmdbId, movieTitle);
  if (currentMediaRenderToken() !== renderToken) return;
  if (persistedWatched) return renderMovieImmersiveModalContent(persistedWatched);
  const isSaving = isMovieSavingWatchAction(tmdbId);
  const isSyncing = isMediaSyncing({ media_type: "movie", title: movieTitle, tmdb_id: tmdbId });
  const backdropUrl = tmdbData.cached_backdrop_url || tmdbImage(tmdbData.backdrop_path, "original");
  const posterUrl = tmdbData.cached_poster_url || tmdbPoster(tmdbData.poster_path, tmdbData.id, "movie") || "/favicon.svg";
  const overview = tmdbData.overview || "No synopsis available.";
  const released = tmdbData.release_date ? `Released ${formatTmdbDate(tmdbData.release_date)}` : "Unknown Release Date";
  const rating = tmdbData.vote_average ? `${Math.round(tmdbData.vote_average * 10)}%` : "N/A";
  const recommendations = rankedRecommendations(tmdbData, "movie");
  const logoUrl = proxiedArtworkUrl(bestTmdbLogo(tmdbData), "logo");
  const ratingBadgeHtml = rating !== "N/A" ? `${renderExternalRatingPills("movie", tmdbData, movieTitle, rating)}` : "";
  const personalMediaItem = {
    media_type: "movie",
    title: movieTitle,
    tmdb_id: tmdbData.id,
    imdb_id: tmdbData.imdb_id || "",
    poster_url: posterUrl,
    overview,
    release_date: tmdbData.release_date || "",
  };
  const personalRatingHtml = personalRatingPillHtml(personalMediaItem);
  setMediaInfoContext({
    mediaType: "movie",
    media: { title: movieTitle, media_type: "movie", tmdb_id: tmdbData.id },
    tmdbData,
    posterUrl,
    overview,
    summary: { watchedCount: 0, totalCount: 1, progressPercent: 0 },
    records: [],
  });
  setMediaDetailActions(`${personalMediaActionsHtml(personalMediaItem)}${droppedTitleActionHtml(personalMediaItem)}${mediaToolsActionHtml(`
    ${mediaInfoActionHtml()}
    ${mediaForceSyncActionHtml({
      type: "movie",
      title: movieTitle,
      tmdbId: tmdbData.id,
    })}
  `)}`);

  const buildUnwatchedHtml = (tvRecommendations = []) => `
    <div class="modal-backdrop-image" style="background-image: url('${escapeAttribute(backdropUrl || posterUrl)}');"></div>
    <div class="immersive-container media-detail-page">
      ${mediaSyncNoticeHtml([{ media_type: "movie", title: movieTitle, tmdb_id: tmdbId }], "this movie")}
      <header class="immersive-header">
        <img class="immersive-poster-img" src="${escapeAttribute(posterUrl)}" alt="${escapeHtml(movieTitle)} poster" data-err="fav" data-lightbox-src="${escapeAttribute(posterUrl)}" />
        <div class="immersive-meta">
          ${logoUrl && !tmdbData?.anidb ? `<img class="immersive-logo" data-err="logo-title" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(movieTitle)}" /><h2 class="immersive-title sr-only">${escapeHtml(movieTitle)}</h2>` : `<h2 class="immersive-title">${escapeHtml(anidbDisplayTitle(tmdbData, movieTitle))}</h2>`}
          <div class="media-detail-bottom-stack">
            ${renderSeerrRequestPill("movie", tmdbId, false)}
            <p class="immersive-overview">${escapeHtml(overview)}</p>${anidbAttributionHtml(tmdbData)}
            <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">
              <h3>Watch Status</h3>
              <div class="progress-label-row">
                <span>Unwatched (local archive)</span>
                <span>0% complete</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width: 0%;"></div>
              </div>
              <div class="immersive-actions" style="margin-top: 0.75rem;">
                <button class="action-pill" type="button" ${isSaving || isSyncing ? "disabled" : ""}
                  data-movie-mark-watched="${escapeAttribute(String(tmdbId))}"
                  data-movie-title="${escapeAttribute(movieTitle)}"
                  data-movie-poster="${escapeAttribute(posterUrl)}"
                  data-movie-release="${escapeAttribute(tmdbData.release_date || "")}">${isSyncing ? "Syncing…" : isSaving ? "Saving watched state…" : "Mark watched"}</button>
              </div>
            </section>
          </div>
        </div>
        ${renderMediaFacts(tmdbData, "movie", "sidebar", {
          ratingsHtml: `${ratingBadgeHtml || renderExternalRatingPills("movie", tmdbData, movieTitle)}${personalRatingHtml}`,
          appLinksHtml: mediaAppLinksHtml(tmdbData, "movie"),
        })}
      </header>
      ${renderCastSection(tmdbData)}
      ${renderMediaImagesSection(tmdbData)}
      ${renderTrailersSection(tmdbData)}
      ${renderReviewsSection(tmdbData)}
      ${renderCollectionSection(tmdbData)}
      ${renderRecommendationSection({ title: "Recommended movies", items: recommendations, mediaType: "movie" })}
      ${renderRecommendationSection({ title: "Recommended TV Shows", items: tvRecommendations, mediaType: "tv" })}
    </div>
  `;

  // Render immediately with TMDB data - no waiting for TV recs.
  root.innerHTML = buildUnwatchedHtml([]);
  hydratePosters(root);
  hydrateMediaAppLinks(root);
  fetchSeerrMediaStatus("movie", tmdbId)
    .then((status) => { if (status) refreshActiveMediaDetailAfterSeerrStatus("movie", tmdbId); });

  // Fetch TV recommendations non-blocking and patch the page when ready.
  recommendedTvShowsForMovie(movieTitle, tmdbData).then((tvRecommendations) => {
    if (!tvRecommendations.length) return;
    // Only patch if still on this page.
    if (String(state.activeMovieTmdbId) !== String(tmdbId)) return;
    root.innerHTML = buildUnwatchedHtml(tvRecommendations);
    hydratePosters(root);
    hydrateMediaAppLinks(root);
  }).catch(() => {/* non-fatal */});
}
