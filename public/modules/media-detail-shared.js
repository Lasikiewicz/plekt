import { state } from "./state.js?v=2.1.1.0.9";
import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.9";
import { escapeHtml, escapeAttribute, slug, movieSlug, movieHref, showName, formatTmdbDate, tvShowTmdbHref, movieTmdbHref, platformIconUrl, isDemoMode } from "./utils.js?v=2.1.1.0.9";
import { tmdbImage, tmdbPoster, tmdbProfile } from "./images.js?v=2.1.1.0.9";
import { fetchTmdbDetails } from "./tmdb.js?v=2.1.1.0.9";
import { movieById, movieBySlugOrId, nowPlayingHref } from "./media-routing.js?v=2.1.1.0.9";
import { hydrateDeferredCastDisclosure, renderCastActor } from "./cast-disclosure.js?v=2.1.1.0.9";

export { movieById, movieBySlugOrId, nowPlayingHref, hydrateDeferredCastDisclosure };

// Performance milestone: the detail page shows its title, artwork, watch state,
// and primary actions from real data. Cast, images, trailers, and other
// enrichment may still be loading. Read by the application-speed benchmark
// (plan/active/application-speed-remediation/step5-phase-e-detail.md, Phase E); it has no runtime effect.
export function markDetailPrimaryReady(kind) {
  try {
    performance.mark("plembfin:detail-primary-ready", { detail: { kind, path: location.pathname } });
  } catch { /* mark() without detail support: timing is optional */ }
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// ── Persistent availability caches ─────────────────────────────────────────
// Seerr media status and media-app-link lookups are slow (the server has to
// ask Seerr and each media server), so the last known result of each is
// persisted in localStorage. Detail pages render instantly from the persisted
// copy, then a background refresh updates the page only when something
// actually changed since the last visit.

const SEERR_STATUS_CACHE_KEY = "plembfin:seerrStatusCache:v1";
const APP_LINKS_CACHE_KEY = "plembfin:appLinksCache:v1";
const AVAILABILITY_CACHE_LIMIT = 150;
const APP_LINKS_REFRESH_TTL_MS = 5 * 60 * 1000;
// A partial answer (a media server was down and skipped) is refreshed after
// the server's one-minute retry window, so that server's link returns soon
// after it is back up instead of up to five minutes later.
const APP_LINKS_PARTIAL_REFRESH_TTL_MS = 60 * 1000;
// Lookup key → when it was last refreshed over the network this session, so
// the repeated re-renders of one detail page don't each refetch app links.
const appLinksRefreshedAt = new Map();
// Lookup key → the in-flight request for it. The timestamp map above only
// suppresses a refresh once one has *completed*, so a detail page that renders
// its shell, then re-renders as metadata arrives, fired the whole lookup again
// before the first had returned. On a title that is not in the library that is
// the worst case: the lookup finds nothing to cache, so nothing suppresses the
// next one, and three concurrent 3-provider searches ran for one page - each
// measured at 2.4s directly and 8-9s under the page's own load. Sharing the
// in-flight promise collapses them to one.
const appLinksInflight = new Map();

(function seedSeerrStatusCacheFromStorage() {
  try {
    const stored = JSON.parse(localStorage.getItem(SEERR_STATUS_CACHE_KEY) || "{}");
    for (const [key, entry] of Object.entries(stored)) {
      if (!entry || typeof entry !== "object" || state.seerrMediaStatusCache.has(key)) continue;
      // `stale` marks the entry as rendered-from-storage: it still needs a
      // silent background refresh the next time its detail page renders.
      state.seerrMediaStatusCache.set(key, { ...entry, loading: false, stale: true });
    }
  } catch { /* persisted availability is best-effort */ }
})();

function persistSeerrStatusCache() {
  try {
    const entries = [...state.seerrMediaStatusCache.entries()]
      .filter(([, entry]) => entry?.ok)
      .sort(([, a], [, b]) => (b._cachedAt || 0) - (a._cachedAt || 0))
      .slice(0, AVAILABILITY_CACHE_LIMIT);
    const snapshot = {};
    for (const [key, entry] of entries) {
      const { loading, stale, ...data } = entry;
      snapshot[key] = data;
    }
    localStorage.setItem(SEERR_STATUS_CACHE_KEY, JSON.stringify(snapshot));
  } catch { /* persisted availability is best-effort */ }
}

function comparableSeerrStatus(entry) {
  if (!entry?.ok) return "";
  const { loading, stale, _cachedAt, ...data } = entry;
  return JSON.stringify(data);
}

function readAppLinksCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(APP_LINKS_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAppLinksCacheEntry(cacheKey, links, partial = false) {
  try {
    const cache = readAppLinksCache();
    cache[cacheKey] = partial ? { links, ts: Date.now(), partial: true } : { links, ts: Date.now() };
    const byRecency = Object.keys(cache).sort((a, b) => (cache[b]?.ts || 0) - (cache[a]?.ts || 0));
    for (const staleKey of byRecency.slice(AVAILABILITY_CACHE_LIMIT)) delete cache[staleKey];
    localStorage.setItem(APP_LINKS_CACHE_KEY, JSON.stringify(cache));
  } catch { /* persisted availability is best-effort */ }
}

export function renderCastSection(tmdbData) {
  const cast = tmdbData?.credits?.cast || [];
  if (!cast.length) return "";
  // The browser's lazy-image threshold still eagerly fetches a long cast row
  // when the detail page is tall. Keep the first visible credits available and
  // put the remainder behind an explicit card so opening a detail page does not
  // fan out into one profile request per actor.
  const visibleCast = cast.slice(0, 8);
  const deferredCast = cast.slice(8, 30);
  return `
    <section class="seasons-section cast-section">
      <div class="show-section-title"><h3>Cast</h3></div>
      <div class="cast-compact-row cast-scroll-row">
        ${visibleCast.map(renderCastActor).join("")}
        ${deferredCast.length ? `
          <button class="cast-more-card" type="button" data-cast-more-trigger data-cast-more="${escapeAttribute(JSON.stringify(deferredCast))}" aria-label="Show ${deferredCast.length} more cast members">
            <span class="cast-more-card-image" aria-hidden="true"><span class="cast-more-card-plus">+</span></span>
            <span class="cast-actor-name">Show more cast</span>
            <span class="cast-character-name">${deferredCast.length} more</span>
          </button>
        ` : ""}
      </div>
    </section>
  `;
}
export function renderTrailersSection(tmdbData) {
  if (!tmdbData) return "";
  const trailers = (tmdbData.videos?.results || []).filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
    // A demo trailer without a bundled thumbnail is not useful offline. Do
    // not render a tile that would fall back to img.youtube.com.
    .filter((v) => v.thumbnail_path || !isDemoMode());
  if (trailers.length === 0) return "";
  return `
    <section class="seasons-section trailers-section">
      <div class="show-section-title"><h3>Trailers & Clips</h3><span>${trailers.length} available</span></div>
      <div class="horizontal-scroll-row trailer-scroll-row" style="margin-top: 0.5rem;">
        ${trailers.map((video) => `
          <div class="trailer-card">
            <div class="trailer-thumb-container" data-video-key="${video.key}" data-video-name="${escapeAttribute(video.name)}" data-video-thumbnail="${escapeAttribute(video.thumbnail_path || "")}">
              <img class="trailer-thumb" src="${escapeAttribute(video.thumbnail_path || (isDemoMode() ? "/favicon.svg" : `https://img.youtube.com/vi/${video.key}/mqdefault.jpg`))}" alt="${escapeAttribute(video.name)}" loading="lazy" decoding="async" data-err="fav" />
              <div class="play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
            </div>
            <span class="trailer-title" title="${escapeAttribute(video.name)}">${escapeHtml(video.name)}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function reviewSourceLabel(review = {}) {
  const explicitSource = String(review.source || review.site || "").trim();
  if (explicitSource) {
    if (/^imdb(?:\.com)?$/i.test(explicitSource)) return "IMDb";
    return explicitSource;
  }

  const rawUrl = String(review.url || "").trim();
  if (!rawUrl) return "";
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    const knownSources = {
      "imdb.com": "IMDb",
      "letterboxd.com": "Letterboxd",
      "metacritic.com": "Metacritic",
      "rogerebert.com": "Roger Ebert",
      "rottentomatoes.com": "Rotten Tomatoes",
    };
    if (knownSources[hostname]) return knownSources[hostname];
    return hostname.split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return "";
  }
}

export function renderReviewsSection(tmdbData) {
  if (!tmdbData) return "";
  const reviews = tmdbData.reviews?.results || [];
  if (reviews.length === 0) return "";
  const reviewSources = [...new Set(reviews.map(reviewSourceLabel).filter(Boolean))];
  const reviewHeading = reviewSources.length ? `Reviews - ${reviewSources.join(", ")}` : "Reviews";
  return `
    <section class="seasons-section reviews-section">
      <div class="show-section-title"><h3>${escapeHtml(reviewHeading)}</h3><span>${reviews.length} reviews</span></div>
      <div class="review-list" style="margin-top: 0.5rem;">
        ${reviews.slice(0, 3).map((review) => {
    const hasLong = review.content?.length > 300;
    return `
            <div class="review-card">
              <div class="review-header">
                <span class="review-author">${escapeHtml(review.author)}</span>
                ${review.author_details?.rating ? `<span class="review-rating">★ ${review.author_details.rating}/10</span>` : ""}
              </div>
              <div class="review-content-wrapper"><p class="review-content">${escapeHtml(review.content)}</p></div>
              ${hasLong ? `<button class="action-pill review-toggle-btn" type="button">Read More</button>` : ""}
            </div>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

export function renderTrailersReviewsSection(tmdbData) {
  return `
    ${renderTrailersSection(tmdbData)}
    ${renderReviewsSection(tmdbData)}
  `;
}
// Rail artwork (Images, Related Shows, recommendations, Collection) renders
// with data-rail-src instead of src. Native loading="lazy" fetches anything
// within roughly 1,250 px of the viewport, including every card in a
// horizontally scrolling rail, so a detail page requested dozens of posters and
// backdrops nobody had scrolled to (application-speed plan, Phase E). A rail
// loads its images once it comes near the viewport, and only as far along the
// row as the user has scrolled plus one screen of lead.
const RAIL_VIEWPORT_MARGIN = "300px 0px";
const RAIL_HORIZONTAL_LEAD_PX = 600;
let railIntersectionObserver = null;
let railMutationObserver = null;
let railScanQueued = false;

function safeRailImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, document.baseURI);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function loadRailImage(image) {
  const src = image.getAttribute("data-rail-src");
  image.removeAttribute("data-rail-src");
  const safeSrc = safeRailImageUrl(src);
  if (safeSrc) image.src = safeSrc;
}

function loadVisibleRailImages(row) {
  const rowLeft = row.getBoundingClientRect().left;
  const limit = row.scrollLeft + row.clientWidth + RAIL_HORIZONTAL_LEAD_PX;
  for (const image of row.querySelectorAll("img[data-rail-src]")) {
    const offset = image.getBoundingClientRect().left - rowLeft + row.scrollLeft;
    if (offset <= limit) loadRailImage(image);
  }
  if (!row.querySelector("img[data-rail-src]")) {
    row.removeEventListener("scroll", onRailScroll);
    railIntersectionObserver?.unobserve(row);
  }
}

function onRailScroll(event) {
  const row = event.currentTarget;
  if (row._railFrame) return;
  row._railFrame = requestAnimationFrame(() => {
    row._railFrame = 0;
    loadVisibleRailImages(row);
  });
}

function observeDeferredRails() {
  railScanQueued = false;
  for (const row of document.querySelectorAll("[data-deferred-rail]:not([data-rail-observed])")) {
    row.setAttribute("data-rail-observed", "");
    if (typeof IntersectionObserver !== "function") {
      row.querySelectorAll("img[data-rail-src]").forEach(loadRailImage);
      continue;
    }
    railIntersectionObserver ||= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const rail = entry.target;
        if (!rail._railScrollBound) {
          rail._railScrollBound = true;
          rail.addEventListener("scroll", onRailScroll, { passive: true });
        }
        loadVisibleRailImages(rail);
      }
    }, { rootMargin: RAIL_VIEWPORT_MARGIN });
    railIntersectionObserver.observe(row);
  }
}

// Called by every rail template, so whichever render path inserts the markup
// (show, movie, person, TMDB-only pages, in-place patches) gets observed.
function deferredRailAttribute() {
  if (!railMutationObserver && typeof MutationObserver === "function" && typeof document !== "undefined") {
    railMutationObserver = new MutationObserver(() => {
      if (railScanQueued) return;
      railScanQueued = true;
      queueMicrotask(observeDeferredRails);
    });
    railMutationObserver.observe(document.body, { childList: true, subtree: true });
  }
  return "data-deferred-rail";
}

export function renderRelatedShowsSection(tmdbData) {
  const related = tmdbData?.similar?.results || [];
  if (!related.length) return "";
  return `
    <section class="seasons-section related-section">
      <div class="show-section-title"><h3>Related Shows</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;" ${deferredRailAttribute()}>
        ${related.slice(0, 20).map((item) => {
    const poster = tmdbPoster(item.poster_path) || "/favicon.svg";
    const year = (item.first_air_date || "").slice(0, 4);
    return `
            <a class="season-poster-card related-show-card" data-immersive-related-tmdb="${item.id}" href="${escapeAttribute(tvShowTmdbHref(item.id, item.name))}">
              <img class="season-poster-img" data-rail-src="${escapeAttribute(poster)}" alt="${escapeAttribute(item.name || "")}" loading="lazy" decoding="async" data-err="fav" />
              <span class="season-poster-name">${escapeHtml(item.name || "")}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
            </a>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function recommendationTitle(item = {}, mediaType = "movie") {
  if (!item) return "";
  return mediaType === "tv" ? (item.name || item.original_name || "") : (item.title || item.original_title || "");
}

function recommendationDate(item = {}, mediaType = "movie") {
  if (!item) return "";
  return mediaType === "tv" ? (item.first_air_date || "") : (item.release_date || "");
}

export function rankedRecommendations(tmdbData, mediaType = "movie", { includeSource = false } = {}) {
  const ranked = [];
  const add = (items = [], sourceRank = 0) => {
    items.forEach((item, index) => {
      if (!item?.id) return;
      ranked.push({ ...item, _sourceRank: sourceRank, _sourceIndex: index });
    });
  };

  if (includeSource && tmdbData?.id) add([tmdbData], 0);
  add(tmdbData?.similar?.results || [], includeSource ? 1 : 0);
  add(tmdbData?.recommendations?.results || [], includeSource ? 2 : 1);

  const byId = new Map();
  for (const item of ranked) {
    const key = String(item.id);
    const existing = byId.get(key);
    if (!existing || item._sourceRank < existing._sourceRank || (item._sourceRank === existing._sourceRank && item._sourceIndex < existing._sourceIndex)) {
      byId.set(key, item);
    }
  }

  return [...byId.values()]
    .sort((a, b) => a._sourceRank - b._sourceRank || a._sourceIndex - b._sourceIndex)
    .filter((item) => recommendationTitle(item, mediaType));
}

function titleCandidatesForTvRecommendations(movieTitle, tmdbData = null) {
  const candidates = [];
  const add = (title) => {
    const cleaned = String(title || "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !candidates.some((candidate) => slug(candidate) === slug(cleaned))) candidates.push(cleaned);
  };

  add(tmdbData?.title);
  add(tmdbData?.original_title);
  add(movieTitle);
  for (const title of [...candidates]) {
    const colonBase = title.split(":")[0]?.trim();
    if (colonBase && colonBase.length >= 4) add(colonBase);
  }
  return candidates.slice(0, 4);
}

function titlesLookRelated(movieTitle, tvTitle) {
  const movieSlug = slug(movieTitle || "");
  const tvSlug = slug(tvTitle || "");
  if (!movieSlug || !tvSlug) return false;
  return movieSlug === tvSlug || movieSlug.startsWith(`${tvSlug}-`) || tvSlug.startsWith(`${movieSlug}-`) || movieSlug.includes(tvSlug) || tvSlug.includes(movieSlug);
}

export async function recommendedTvShowsForMovie(movieTitle, tmdbData = null) {
  for (const candidate of titleCandidatesForTvRecommendations(movieTitle, tmdbData)) {
    const tvData = await fetchTmdbDetails("tv", null, candidate, {}, { relatedTvLookup: true }).catch(() => null);
    if (!tvData) continue;
    const tvTitle = recommendationTitle(tvData, "tv");
    if (!tvData.id || !titlesLookRelated(candidate, tvTitle)) continue;
    return rankedRecommendations(tvData, "tv", { includeSource: true }).slice(0, 15);
  }
  return [];
}

export function renderRecommendationSection({ title, items = [], mediaType = "movie" }) {
  if (!items.length) return "";
  const isTv = mediaType === "tv";
  return `
        <section class="seasons-section">
          <h3>${escapeHtml(title)}</h3>
          <div class="horizontal-scroll-row" ${deferredRailAttribute()}>
            ${items.slice(0, 15).map((item) => {
    const itemTitle = recommendationTitle(item, mediaType);
    const year = recommendationDate(item, mediaType).slice(0, 4);
    const poster = item.poster_path ? tmdbPoster(item.poster_path, item.id, mediaType) : "/favicon.svg";
    return `
                  <a class="season-poster-card" ${isTv ? `data-immersive-related-tmdb="${escapeAttribute(String(item.id))}" href="${escapeAttribute(tvShowTmdbHref(item.id, itemTitle))}"` : `data-immersive-movie-id="${escapeAttribute(String(item.id))}" href="${escapeAttribute(movieTmdbHref(item.id, itemTitle))}"`}>
                    <img class="season-poster-img" data-rail-src="${escapeAttribute(poster)}" alt="${escapeAttribute(itemTitle)}" loading="lazy" decoding="async" data-err="fav" />
                    <span class="season-poster-name">${escapeHtml(itemTitle)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
                  </a>
                `;
  }).join("")}
          </div>
        </section>
      `;
}
export function renderRichTmdbDetails(tmdbData) {
  return renderTrailersReviewsSection(tmdbData);
}
export function renderMediaImagesSection(tmdbData) {
  if (!tmdbData?.images) return "";
  const seen = new Set();
  const dedupe = (imgs) => imgs.filter((img) => {
    if (!img.file_path || seen.has(img.file_path)) return false;
    seen.add(img.file_path);
    return true;
  });
  // Prefer language-neutral backdrops (no text overlay); fall back to all if too few.
  const raw = tmdbData.images.backdrops || [];
  const clean = dedupe(raw.filter((img) => !img.iso_639_1));
  const backdrops = (clean.length >= 3 ? clean : dedupe(raw))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
    .slice(0, 20);
  if (!backdrops.length) return "";
  return `
    <section class="seasons-section media-images-section">
      <div class="show-section-title"><h3>Images</h3><span>${backdrops.length} available</span></div>
      <div class="media-images-scroll-row" ${deferredRailAttribute()}>
        ${backdrops.map((img, i) => {
    const thumb = tmdbImage(img.file_path, "w780");
    const full = tmdbImage(img.file_path, "original");
    return `<button class="media-image-card" type="button" data-lightbox-index="${i}" data-lightbox-src="${escapeAttribute(full)}">
            <img class="media-image-thumb" data-rail-src="${escapeAttribute(thumb)}" alt="Scene image" loading="lazy" decoding="async" data-err="hide-parent" />
          </button>`;
  }).join("")}
      </div>
    </section>
  `;
}
export function renderCollectionSection(tmdbData) {
  if (!tmdbData) return "";
  const collection = tmdbData.belongs_to_collection;
  if (!collection || !collection.id) return "";
  const movies = collection.parts || [];
  if (!movies.length) return "";
  return `
    <section class="seasons-section collection-section">
      <div class="show-section-title"><h3>${escapeHtml(collection.name)}</h3></div>
      <div class="horizontal-scroll-row" style="margin-top: 0.5rem;" ${deferredRailAttribute()}>
        ${movies.map((movie) => {
    const poster = movie.poster_path ? tmdbPoster(movie.poster_path, movie.id, "movie") : "/favicon.svg";
    const year = (movie.release_date || "").slice(0, 4);
    const title = movie.title || movie.original_title || "";
    return `
            <a class="season-poster-card collection-movie" data-immersive-movie-id="${escapeAttribute(String(movie.id))}" href="${escapeAttribute(movieTmdbHref(movie.id, title))}">
              <img class="season-poster-img" data-rail-src="${escapeAttribute(poster)}" alt="${escapeAttribute(title)}" loading="lazy" decoding="async" data-err="fav" />
              <span class="season-poster-name">${escapeHtml(title)}${year ? ` <small>(${escapeHtml(year)})</small>` : ""}</span>
            </a>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

export function initialMediaAppLinksContent({
  mediaType = "movie",
  tmdbId = "",
  imdbId = "",
  tvdbId = "",
  season = "",
  episode = "",
  title = "",
  providerItems = "",
  appLinkStyle = "",
  allApps = false,
  targets = null,
} = {}) {
  const targetList = appLinkTargetEntries(targets);
  const params = new URLSearchParams();
  params.set("mediaType", mediaType || "movie");
  for (const [param, val] of [
    ["tmdbId", tmdbId],
    ["imdbId", imdbId],
    ["tvdbId", tvdbId],
    ["season", season],
    ["episode", episode],
    ["title", title],
  ]) {
    if (val) params.set(param, String(val));
  }
  if (providerItems) {
    params.set("providerItems", typeof providerItems === "object" ? JSON.stringify(providerItems) : String(providerItems));
  }
  if (targetList.length < APP_LINK_TARGETS.length) params.set("targets", targetList.map(([target]) => target).join(","));

  const pillStyle = appLinkStyle === "source-badge" ? "source-badge" : "";
  const includeUnavailable = Boolean(allApps);
  const cacheKey = params.toString();
  const cachedEntry = readAppLinksCache()[cacheKey];
  const cachedLinks = Array.isArray(cachedEntry?.links) ? cachedEntry.links : null;
  if (cachedLinks) {
    return appLinkRowHtml(cachedLinks, { includeUnavailable, pillStyle, targetList });
  }

  if (includeUnavailable) {
    return pillStyle === "source-badge"
      ? appLinkRowHtml([], { includeUnavailable: true, checking: true, pillStyle, targetList })
      : "";
  }
  return "";
}

// The Plex/Emby/Jellyfin app-link pills, as a standalone hydratable container
// for the "Watch Now" row of the media facts panel.
export function mediaAppLinksHtml(tmdbData, mediaType = "movie") {
  if (!tmdbData) return "";
  const tmdbId = tmdbData.id || tmdbData.tmdb_id || "";
  const imdbId = tmdbData.imdb_id || tmdbData.external_ids?.imdb_id || "";
  const tvdbId = tmdbData.external_ids?.tvdb_id || "";
  const title = mediaType === "tv" ? (tmdbData.name || tmdbData.original_name || "") : (tmdbData.title || tmdbData.original_title || "");
  const initialContent = initialMediaAppLinksContent({
    mediaType,
    tmdbId,
    imdbId,
    tvdbId,
    title,
  });
  return `
    <div class="media-app-links" data-media-app-links
      data-media-type="${escapeAttribute(mediaType)}"
      data-tmdb-id="${escapeAttribute(String(tmdbId))}"
      data-imdb-id="${escapeAttribute(String(imdbId))}"
      data-tvdb-id="${escapeAttribute(String(tvdbId))}"
      data-title="${escapeAttribute(title)}">${initialContent}</div>
  `;
}

// Network/streaming provider chips - a small logo (when TMDB has one) next
// to the name, rather than a bare comma-joined list of text. Each chip links
// to TMDB's own "where to watch" page for this title (the JustWatch-powered
// link TMDB's terms require when displaying watch/provider data) when one is
// available, since TMDB doesn't give us a per-provider deep link to use instead.
function providerChipsHtml(items = [], watchLink = "") {
  if (!items.length) return "";
  return `
    <div class="media-provider-list media-fact-chip-row">
      ${items.map(({ name, logoPath }) => {
        const logoUrl = logoPath ? tmdbImage(logoPath, "w92") : "";
        const inner = logoUrl
          ? `<img class="media-provider-icon media-fact-chip-icon" src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(name)}" loading="lazy" />`
          : `<span class="media-provider-name">${escapeHtml(name)}</span>`;
        return watchLink
          ? `<a class="media-provider-tile media-fact-chip" href="${escapeAttribute(watchLink)}" target="_blank" rel="noopener noreferrer" title="Available on ${escapeAttribute(name)}">${inner}</a>`
          : `<span class="media-provider-tile media-fact-chip" title="${escapeAttribute(name)}">${inner}</span>`;
      }).join("")}
    </div>
  `;
}

// A network (e.g. "Prime Video") frequently has no logo of its own, but the
// exact same service often appears with one in the watch/providers list
// under a slightly different name (e.g. "Amazon Prime Video") - match
// loosely (either name containing the other) rather than requiring an exact
// match, so that still counts as the same service.
function normalizeProviderNameForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findProviderLogoForNetwork(networkName, providers) {
  const normalized = normalizeProviderNameForMatch(networkName);
  if (!normalized) return "";
  const match = providers.find((provider) => {
    const providerName = normalizeProviderNameForMatch(provider.provider_name);
    return providerName === normalized || providerName.includes(normalized) || normalized.includes(providerName);
  });
  return match?.logo_path || "";
}

export function renderMediaFacts(tmdbData, mediaType = "movie", placement = "sidebar", { ratingsHtml = "", appLinksHtml = "", openOnMobile = false } = {}) {
  if (!tmdbData && !ratingsHtml) return "";
  tmdbData = tmdbData || {};
  const watchProviders = tmdbData["watch/providers"]?.results?.GB || tmdbData["watch/providers"]?.results?.US;
  const providers = watchProviders?.flatrate || [];
  const watchLink = watchProviders?.link || "";
  const networks = tmdbData.networks || [];
  const runtime = mediaType === "movie"
    ? (tmdbData.runtime ? `${tmdbData.runtime} min` : "")
    : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min episodes` : "");

  // Table rows:
  // STATUS (incorporating release date), GENRES, NETWORK / STUDIO, LANGUAGE, RUNTIME
  const tableRows = [];

  // 1. Status (incorporating release / air date, e.g. "Released - 31 May 2023" or "Released - 14 Aug 2020 - Continuing")
  let statusText = tmdbData.status || (mediaType === "movie" ? "Released" : "");
  if (statusText === "Returning Series") statusText = "Continuing";
  const rawDate = mediaType === "movie" ? tmdbData.release_date : (tmdbData.first_air_date || tmdbData.release_date);
  const formattedDate = formatTmdbDate(rawDate);
  const isFuture = rawDate && !Number.isNaN(new Date(rawDate).getTime()) && new Date(rawDate).getTime() > Date.now();
  const releaseLabel = isFuture ? "Airing" : "Released";

  let combinedStatus = "";
  if (mediaType === "tv") {
    if (formattedDate && statusText && statusText.toLowerCase() !== "released") {
      combinedStatus = `${releaseLabel} - ${formattedDate} - ${statusText}`;
    } else if (formattedDate) {
      combinedStatus = `${releaseLabel} - ${formattedDate}`;
    } else if (statusText) {
      combinedStatus = statusText;
    }
  } else {
    if (statusText && formattedDate) {
      combinedStatus = statusText.toLowerCase() === "released"
        ? `${releaseLabel} - ${formattedDate}`
        : `${statusText} - ${formattedDate}`;
    } else if (statusText) {
      combinedStatus = statusText;
    } else if (formattedDate) {
      combinedStatus = `${releaseLabel} - ${formattedDate}`;
    }
  }

  if (combinedStatus) {
    tableRows.push({ label: "Status", text: combinedStatus });
  }

  // 3. Genres
  const genresText = (tmdbData.genres || []).map((g) => g.name).filter(Boolean).join(", ");
  if (genresText) {
    tableRows.push({ label: "Genres", text: genresText });
  }

  // 4. TV: Network | Movie: Runtime, Studio
  if (mediaType === "tv") {
    const networkNames = networks.map((n) => n.name).filter(Boolean).join(", ");
    if (networkNames) {
      tableRows.push({ label: "Network", text: networkNames });
    }
  } else {
    if (runtime) {
      tableRows.push({ label: "Runtime", text: runtime });
    }
    const studios = (tmdbData.production_companies || []).slice(0, 2).map((c) => c.name).filter(Boolean).join(", ");
    if (studios) {
      tableRows.push({ label: "Studio", text: studios });
    }
  }

  // 5. Language
  if (tmdbData.original_language) {
    tableRows.push({ label: "Language", text: String(tmdbData.original_language).toUpperCase() });
  }

  // 6. TV Runtime (if not already shown)
  if (mediaType === "tv" && runtime) {
    tableRows.push({ label: "Runtime", text: runtime });
  }

  // Available on
  const availableProvidersHtml = providers.length
    ? providerChipsHtml(providers.map((p) => ({ name: p.provider_name, logoPath: p.logo_path })), watchLink)
    : "";
  if (availableProvidersHtml) {
    tableRows.push({ label: "Available on", kind: "available", html: availableProvidersHtml });
  }

  // Watch Now
  if (appLinksHtml) {
    tableRows.push({ label: "Watch Now", kind: "watch-now", html: appLinksHtml });
  }

  // Ratings
  if (ratingsHtml) {
    tableRows.push({
      label: "Ratings",
      kind: "ratings",
      html: `<div class="media-ratings-row">${ratingsHtml}</div>`,
    });
  }

  const tableHtml = tableRows.length ? `
    <div class="media-fact-table">
      ${tableRows.map((row) => `
        <div class="media-fact-table-row${row.kind ? ` media-fact-table-row--${row.kind}` : ""}">
          <div class="media-fact-table-label">${escapeHtml(row.label)}</div>
          <div class="media-fact-table-value${row.html ? " media-fact-table-value--rich" : ""}">
            ${row.html ?? escapeHtml(row.text)}
          </div>
        </div>
      `).join("")}
    </div>
  ` : "";

  const openAttr = window.innerWidth <= 640 && !openOnMobile ? "" : " open";

  const topGroupHtml = tableHtml ? `
    <div class="media-facts-top-group">
      ${tableHtml}
    </div>
  ` : "";

  const contentHtml = `
    ${topGroupHtml}
  `;

  if (placement === "sidebar") {
    return `
      <div class="immersive-sidebar">
        <details class="media-facts-details"${openAttr}>
          <summary class="media-facts-summary">
            <span class="media-facts-expand-btn"></span>
          </summary>
          <div class="media-facts-panel" aria-label="Media facts">
            ${contentHtml}
          </div>
        </details>
      </div>
    `;
  }

  return `
    <details class="media-facts-details"${openAttr}>
      <summary class="media-facts-summary">
        <span class="media-facts-expand-btn"></span>
      </summary>
      <div class="media-facts-panel" aria-label="Media facts">
        ${contentHtml}
      </div>
    </details>
  `;
}

const APP_LINK_TARGETS = [
  ["plex", "Plex"],
  ["emby", "Emby"],
  ["jellyfin", "Jellyfin"],
];

function appLinkTargetEntries(targets = null) {
  const requested = Array.isArray(targets)
    ? targets
    : typeof targets === "string"
      ? targets.split(",")
      : [];
  const normalized = new Set(requested.map((target) => String(target || "").trim().toLowerCase()).filter(Boolean));
  return normalized.size
    ? APP_LINK_TARGETS.filter(([target]) => normalized.has(target))
    : APP_LINK_TARGETS;
}

function appLinkHtml(link, { disabled = false, checking = false, label = "", pillStyle = "" } = {}) {
  const target = link?.target || "";
  const displayLabel = link?.label || label || target;
  const useSourceBadgeStyle = pillStyle === "source-badge";
  const pillClasses = useSourceBadgeStyle
    ? ["source-badge", "source-badge--icon", disabled ? "source-badge--disabled" : "source-badge--link", checking ? "source-badge--checking" : ""]
    : ["media-app-link", disabled ? "media-app-link--disabled" : ""];
  pillClasses.push(`media-app-link--${target}`);
  const iconClass = useSourceBadgeStyle ? "source-badge-icon" : "media-app-link-logo";
  if (disabled) {
    const availabilityLabel = checking ? `Checking ${displayLabel}...` : `${displayLabel} unavailable`;
    return `
      <span class="${pillClasses.filter(Boolean).map(escapeAttribute).join(" ")}" title="${escapeAttribute(availabilityLabel)}" aria-label="${escapeAttribute(availabilityLabel)}" aria-disabled="true">
        <img class="${escapeAttribute(iconClass)}" src="${escapeAttribute(platformIconUrl(target))}" alt="" loading="eager" decoding="async" data-err="hide-show-next" />
        <span>${escapeHtml(displayLabel)}</span>
      </span>
    `;
  }
  return `
    <a class="${pillClasses.filter(Boolean).map(escapeAttribute).join(" ")}" href="${escapeAttribute(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(`Open in ${displayLabel}`)}" aria-label="${escapeAttribute(`Open in ${displayLabel}`)}">
      ${link.iconUrl ? `<img class="${escapeAttribute(iconClass)}" src="${escapeAttribute(platformIconUrl(target))}" alt="" loading="eager" decoding="async" data-err="hide-show-next" />` : ""}
      <span>${escapeHtml(displayLabel)}</span>
    </a>
  `;
}

function appLinkRowHtml(links = [], { includeUnavailable = false, checking = false, pillStyle = "", targetList = APP_LINK_TARGETS } = {}) {
  const allowedTargets = new Set(targetList.map(([target]) => target));
  const linkMap = new Map(links
    .filter((link) => allowedTargets.has(String(link?.target || "").toLowerCase()))
    .map((link) => [link.target, link]));
  const activeLinkHtml = includeUnavailable
    ? targetList.map(([target, label]) => linkMap.has(target)
      ? appLinkHtml(linkMap.get(target), { pillStyle })
      : appLinkHtml({ target, label }, { disabled: true, checking, pillStyle })).join("")
    : [...linkMap.values()].map((link) => appLinkHtml(link, { pillStyle })).join("");
  if (!activeLinkHtml) return "";
  return `
    <b class="media-app-link-row">
      ${activeLinkHtml}
    </b>
  `;
}

export async function hydrateMediaAppLinks(root = document, { allowNetwork = true } = {}) {
  const containers = [...root.querySelectorAll("[data-media-app-links]")];
  if (!containers.length) return;

  await Promise.all(containers.map(async (container) => {
    if (container.dataset.loaded === "true") return;
    container.dataset.loaded = "true";

    const params = new URLSearchParams();
    params.set("mediaType", container.dataset.mediaType || "movie");
    for (const [param, attr] of [["tmdbId", "tmdbId"], ["imdbId", "imdbId"], ["tvdbId", "tvdbId"], ["season", "season"], ["episode", "episode"], ["title", "title"]]) {
      const value = container.dataset[attr] || "";
      if (value) params.set(param, value);
    }
    const providerItems = container.dataset.providerItems || "";
    if (providerItems) params.set("providerItems", providerItems);
    const targetList = appLinkTargetEntries(container.dataset.targets || null);
    if (targetList.length < APP_LINK_TARGETS.length) params.set("targets", targetList.map(([target]) => target).join(","));

    const pillStyle = container.dataset.appLinkStyle === "source-badge" ? "source-badge" : "";
    const greyedOutHtml = pillStyle === "source-badge"
      ? appLinkRowHtml([], { includeUnavailable: true, checking: true, pillStyle })
      : `
        <b class="media-app-link-row">
          <a class="media-app-link media-app-link--plex media-app-link--disabled" title="Checking Plex..." aria-label="Checking Plex..." style="opacity: 0.4; cursor: not-allowed;">
            <img class="media-app-link-logo" src="/icons/plex.svg?v=2.1.1.0.9" alt="" loading="eager" decoding="async" data-err="hide-show-next" />
            <span>Plex</span>
          </a>
          <a class="media-app-link media-app-link--emby media-app-link--disabled" title="Checking Emby..." aria-label="Checking Emby..." style="opacity: 0.4; cursor: not-allowed;">
            <img class="media-app-link-logo" src="/icons/emby.svg?v=2.1.1.0.9" alt="" loading="eager" decoding="async" data-err="hide-show-next" />
            <span>Emby</span>
          </a>
          <a class="media-app-link media-app-link--jellyfin media-app-link--disabled" title="Checking Jellyfin..." aria-label="Checking Jellyfin..." style="opacity: 0.4; cursor: not-allowed;">
            <img class="media-app-link-logo" src="/icons/jellyfin.svg?v=2.1.1.0.9" alt="" loading="eager" decoding="async" data-err="hide-show-next" />
            <span>Jellyfin</span>
          </a>
        </b>
      `;

    // Render the last known links instantly; fall back to greyed placeholders
    // only when this lookup has never succeeded before.
    const cacheKey = params.toString();
    const cachedEntry = readAppLinksCache()[cacheKey];
    const cachedLinks = Array.isArray(cachedEntry?.links) ? cachedEntry.links : null;
    const includeUnavailable = container.dataset.allApps === "true";
    const cachedRowHtml = cachedLinks ? appLinkRowHtml(cachedLinks, { includeUnavailable, pillStyle, targetList }) : "";
    const targetInitialHtml = cachedRowHtml || greyedOutHtml;
    if (container.innerHTML !== targetInitialHtml) {
      container.innerHTML = targetInitialHtml;
    }

    // Detail pages and dashboard cards both refresh missing/stale links in the
    // background. The dashboard does not wait for the provider lookup because
    // this function is fired from its post-render hydration callback.
    if (!allowNetwork) return;

    // A detail page re-renders several times as metadata arrives; refresh a
    // known result over the network at most once per TTL window.
    //
    // The window has to come from the persisted entry's own timestamp, not just
    // the in-memory map: that map is empty again after every full page load, so
    // opening a media page by URL always re-ran the lookup. For a series that
    // lookup enumerates every episode from Plex, Emby and Jellyfin and measured
    // 2.9-4.3s directly, and 13.8s on a page that was competing with its own
    // other provider work. The links are rendered from cache either way, so
    // this only changes how often the background refresh runs.
    const lastRefreshedAt = Math.max(appLinksRefreshedAt.get(cacheKey) || 0, Number(cachedEntry?.ts) || 0);
    const refreshTtl = cachedEntry?.partial ? APP_LINKS_PARTIAL_REFRESH_TTL_MS : APP_LINKS_REFRESH_TTL_MS;
    if (cachedLinks && Date.now() - lastRefreshedAt < refreshTtl) return;

    try {
      // Share one request per lookup key across concurrent re-renders. Without
      // this, a title with no links never populates the cache the timestamp
      // guard reads, so every re-render started its own provider search.
      let request = appLinksInflight.get(cacheKey);
      if (!request) {
        request = fetch(`/api/media-app-links?${params.toString()}`, { headers: authHeaders(), cache: "no-store" })
          .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
          .finally(() => appLinksInflight.delete(cacheKey));
        appLinksInflight.set(cacheKey, request);
      }
      const { ok, body } = await request;
      if (!ok || !Array.isArray(body.links)) return;
      appLinksRefreshedAt.set(cacheKey, Date.now());
      // Persist the entry even when nothing changed. Its `ts` is what the
      // refresh window above reads after a page reload, and returning early on
      // an unchanged result used to leave that timestamp stuck at whenever the
      // links last *differed* - so a stable title re-ran this whole 3-provider
      // lookup on every single page load.
      const linksUnchanged = JSON.stringify(body.links) === JSON.stringify(cachedLinks);
      writeAppLinksCacheEntry(cacheKey, body.links, body.partial === true);
      if (linksUnchanged) return;
      const freshRowHtml = appLinkRowHtml(body.links, { includeUnavailable, pillStyle, targetList });
      if (freshRowHtml) {
        if (container.innerHTML !== freshRowHtml) container.innerHTML = freshRowHtml;
      } else if (cachedRowHtml && container.innerHTML !== greyedOutHtml) {
        container.innerHTML = greyedOutHtml;
      }
    } catch {
      // App links are optional; leave whatever is rendered if the lookup fails.
    }
  }));
}
export function tmdbTitleUrl(mediaType, tmdbId) {
  const id = String(tmdbId || "");
  if (!id) return "";
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encodeURIComponent(id)}`;
}

export function tvdbSeriesUrl(tvdbId) {
  const id = String(tvdbId || "").trim();
  if (!id) return "";
  return `https://thetvdb.com/dereferrer/series/${encodeURIComponent(id)}`;
}

const RATING_SOURCE_ICONS = { TMDB: "/icons/tmdb.svg?v=2.1.1.0.9", TVDB: "/icons/tvdb.svg?v=2.1.1.0.9", IMDb: "/icons/imdb.svg?v=2.1.1.0.9" };

export function ratingPillHtml({ label, value = "View", href = "", title = "" } = {}) {
  if (!label || !href) return "";
  const iconUrl = RATING_SOURCE_ICONS[label] || "";
  return `
    <a class="rating-pill rating-pill-link${iconUrl ? " rating-pill--brand" : ""}" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttribute(title || `${label} rating`)}">
      ${iconUrl ? `<img class="rating-pill-icon rating-pill-icon--${escapeAttribute(label.toLowerCase())}" src="${escapeAttribute(iconUrl)}" alt="${escapeAttribute(label)}" loading="lazy" />` : `<span>${escapeHtml(label)}</span>`}
      ${value ? `<span>${escapeHtml(value)}</span>` : ""}
    </a>
  `;
}
const KNOWN_RESOLUTIONS = new Set(["SD", "480p", "576p", "720p", "1080p", "4K"]);
// The per-episode resolution pills (episodeResolutionPillHtml) already show
// the exact truth for each episode - this aggregate only needs to avoid
// stating a resolution that isn't actually true for every available
// episode. A uniform season/show can say so; a mixed one drops the claim
// rather than quoting the best (overstating what's really there) or worst
// (understating it) resolution present.
function uniformEpisodeResolution(status = {}) {
  const resolutions = [...new Set(Object.values(status.episodeResolutions || {}).filter((r) => KNOWN_RESOLUTIONS.has(r)))];
  return resolutions.length === 1 ? resolutions[0] : "";
}
export function tvAvailabilityLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available = Number(status.availableEpisodes || 0);
  if (!total) return status.available ? "Available" : "";
  if (available <= 0) return "";
  const resolution = uniformEpisodeResolution(status);
  return `${available}/${total} Available${resolution ? ` in ${resolution}` : ""}`;
}
export function movieAvailabilityLabel(status = {}) {
  const resolution = KNOWN_RESOLUTIONS.has(status.resolution) ? status.resolution : "";
  return resolution ? `Available in ${resolution}` : "Available";
}
export function tvAvailability4kLabel(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available4k = Number(status.available4kEpisodes || 0);
  if (!total) return status.available4k ? "Available in 4K" : "";
  if (available4k >= total) return `${available4k}/${total} Available in 4K`;
  if (available4k > 0) return `${available4k}/${total} Available in 4K`;
  return "";
}
function tvAvailabilityCompactSummary(status = {}) {
  const total = Number(status.totalEpisodes || 0);
  const available = Number(status.availableEpisodes || 0);
  const available4k = Number(status.available4kEpisodes || 0);
  if (!total || available <= 0) return null;

  const standardAvailable = Math.max(available - available4k, 0);
  const standardResolutions = [...new Set(Object.values(status.episodeResolutions || {})
    .filter((resolution) => KNOWN_RESOLUTIONS.has(resolution) && resolution !== "4K"))];
  const standardResolution = standardResolutions.length === 1 ? standardResolutions[0] : standardResolutions.length > 1 ? "HD" : "1080p";
  const labels = [];
  const details = [];
  if (standardAvailable > 0) {
    labels.push(`${standardAvailable} ${standardResolution}`);
    details.push(`${standardAvailable} of ${total} episodes available at ${standardResolution}`);
  }
  if (available4k > 0) {
    labels.push(`${available4k} 4K`);
    details.push(`${available4k} of ${total} episodes available in 4K`);
  }

  return labels.length ? { label: labels.join(" · "), title: details.join("; ") } : null;
}
export function tvSeasonAvailability(status = {}, seasonNumber) {
  return (status.seasons || []).find((season) => Number(season.seasonNumber) === Number(seasonNumber)) || null;
}
export function episodeResolutionPillHtml(status = {}, seasonNumber, episodeNumber) {
  const label = status.episodeResolutions?.[`${seasonNumber}|${episodeNumber}`];
  if (!label) return "";
  return `<span class="season-availability-pill episode-resolution-pill ${label === "4K" ? "is-4k" : ""}">${escapeHtml(label)}</span>`;
}
export function tvSeasonAvailabilityHtml(status = {}, seasonNumber) {
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  if (!season || !Number(season.released || season.total || 0)) return "";
  const total = Number(season.released || season.total || 0);
  const available = Number(season.available || 0);
  const available4k = Number(season.available4k || 0);
  const availabilityText = available >= total ? `All ${total} available` : `${available}/${total} available`;
  const availabilityClass = available >= total ? "is-complete" : available > 0 ? "is-partial" : "is-missing";
  const fourKTitle = available4k >= total ? `All ${total} episodes available in 4K` : `${available4k}/${total} episodes available in 4K`;
  return `
    <span class="season-availability-pill ${availabilityClass}">
      ${escapeHtml(availabilityText)}
      ${available4k > 0 ? `<b class="season-pill-4k-tag ${available4k >= total ? "is-full" : ""}" title="${escapeAttribute(fourKTitle)}">4K</b>` : ""}
    </span>
  `;
}
export function renderSeasonSeerrControls(tmdbId, seasonNumber, status = {}) {
  if (!state.seerrConfigured || !tmdbId) return "";
  if (!Array.isArray(status.seasons)) return "";
  const season = tvSeasonAvailability(status, seasonNumber);
  const released = Number(season?.released || season?.total || 0);
  const missingStandard = !season || !released || Number(season.available || 0) < released;
  const missing4k = !season || !released || Number(season.available4k || 0) < released;
  const supports4k = state.seerrSupports4k.tv;
  return `
    <span class="season-request-controls">
      ${missingStandard ? `
        <button class="rating-pill seerr-request-btn season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}">
          <span>Request season</span>
        </button>
      ` : ""}
      ${supports4k && missing4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k season-seerr-request-btn" type="button"
          data-seerr-media-type="tv"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-season="${escapeAttribute(String(seasonNumber))}"
          data-seerr-request-4k="true">
          <span>Request 4K</span>
        </button>
      ` : ""}
    </span>
  `;
}
export function renderSeerrRequestPill(
  mediaType,
  tmdbId,
  localAvailable = false,
  { compactTvSummary = false } = {},
) {
  if (!state.seerrConfigured || !tmdbId) return "";
  const status = state.seerrMediaStatusCache.get(`${mediaType}:${tmdbId}`) || {};
  const isTv = mediaType === "tv";
  const isAvailable = Boolean(status.available);
  const supports4k = mediaType === "movie" ? state.seerrSupports4k.movie : state.seerrSupports4k.tv;
  const seerrBaseUrl = String(state.savedConfig?.seerr?.baseUrl || "").replace(/\/+$/, "");
  const seerrIconHtml = seerrBaseUrl
    ? `<img class="seerr-request-icon" src="${escapeAttribute(`${seerrBaseUrl}/favicon.ico`)}" alt="" loading="lazy" data-err="hide-show-next" />`
    : "";
  const iconAndFallback = `${seerrIconHtml}<span class="seerr-request-fallback" aria-hidden="true">S</span>`;
  const tvAvailableLabel = isTv ? tvAvailabilityLabel(status) : "";
  const tv4kLabel = isTv ? tvAvailability4kLabel(status) : "";
  const tvCompactSummary = isTv && compactTvSummary && Number(status.availableEpisodes || 0) > 0
    ? tvAvailabilityCompactSummary(status)
    : null;
  return `
    <span id="seerrRequestContainer" style="display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;" data-media-type="${escapeAttribute(mediaType)}" data-tmdb-id="${escapeAttribute(String(tmdbId))}" data-local-available="${localAvailable}" data-compact-tv-summary="${compactTvSummary ? "true" : "false"}">
      ${tvCompactSummary
        ? `<span class="rating-pill seerr-owned-pill tv-availability-summary" title="${escapeAttribute(tvCompactSummary.title)}">${escapeHtml(tvCompactSummary.label)}</span>`
        : isAvailable ? `<span class="rating-pill seerr-owned-pill">${escapeHtml(isTv ? tvAvailableLabel || "Available" : movieAvailabilityLabel(status))}</span>` : tvAvailableLabel ? `<span class="rating-pill seerr-owned-pill seerr-owned-pill-partial">${escapeHtml(tvAvailableLabel)}</span>` : `
        <button class="rating-pill seerr-request-btn" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}">
          ${iconAndFallback}
          <span>${status.pending ? "Requested on Seerr" : "Request on Seerr"}</span>
        </button>
      `}
      ${tvCompactSummary && tv4kLabel ? "" : tv4kLabel ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k ${status.available4k ? "" : "seerr-owned-pill-partial"}">${escapeHtml(tv4kLabel)}</span>
      ` : supports4k && !status.available4k ? `
        <button class="rating-pill seerr-request-btn seerr-request-btn-4k" type="button"
          data-seerr-media-type="${escapeAttribute(mediaType)}"
          data-seerr-media-id="${escapeAttribute(String(tmdbId))}"
          data-seerr-request-4k="true">
          ${iconAndFallback}
          <span>${status.pending4k ? "4K Requested" : "Request 4K"}</span>
        </button>
      ` : status.available4k ? `
        <span class="rating-pill seerr-owned-pill seerr-owned-pill-4k">${escapeHtml(isTv ? tv4kLabel || "Available in 4K" : "Available in 4K")}</span>
      ` : ""}
    </span>
  `;
}
export function fetchSeerrMediaStatus(mediaType, tmdbId) {
  if (!state.seerrConfigured || !tmdbId) return Promise.resolve(null);
  const cacheKey = `${mediaType}:${tmdbId}`;
  const previous = state.seerrMediaStatusCache.get(cacheKey);
  if (previous?.loading) return Promise.resolve(null);
  state.seerrMediaStatusCache.set(cacheKey, { ...(previous || {}), loading: true });
  return fetch(`/api/seerr/media-status?mediaType=${encodeURIComponent(mediaType)}&mediaId=${encodeURIComponent(tmdbId)}`, { headers: authHeaders() })
    .then((response) => response.json().then((body) => ({ response, body })).catch(() => ({ response, body: {} })))
    .then(({ response, body }) => {
      if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
      const fresh = { ...body, loading: false, _cachedAt: Date.now() };
      state.seerrMediaStatusCache.set(cacheKey, fresh);
      persistSeerrStatusCache();
      // Callers re-render when a status is returned, so resolve null when the
      // background refresh matches what the persisted cache already rendered.
      if (comparableSeerrStatus(previous) === comparableSeerrStatus(fresh)) return null;
      return body;
    })
    .catch(() => {
      // Keep the previously cached availability on a failed refresh; it stays
      // marked stale so the next render retries it.
      state.seerrMediaStatusCache.set(cacheKey, previous?.ok ? { ...previous, loading: false } : { loading: false });
      return null;
    });
}
export function refreshActiveMediaDetailAfterSeerrStatus(mediaType, tmdbId) {
  const container = document.getElementById("seerrRequestContainer");
  if (container && container.getAttribute("data-media-type") === mediaType && String(container.getAttribute("data-tmdb-id")) === String(tmdbId)) {
    const localAvailable = container.getAttribute("data-local-available") === "true";
    const compactTvSummary = container.getAttribute("data-compact-tv-summary") === "true";
    container.outerHTML = renderSeerrRequestPill(mediaType, tmdbId, localAvailable, { compactTvSummary });
  }
}
export function renderExternalRatingPills(mediaType, tmdbData, title, rating = "") {
  const tmdbId = tmdbData?.id || tmdbData?.tmdb_id || "";
  const tvdbId = tmdbData?.tvdb_id || tmdbData?.external_ids?.tvdb_id || tmdbData?.tvdbId || tmdbData?.show_tvdb_id || "";
  const pills = [];
  if (mediaType === "tv") {
    if (tvdbId) {
      pills.push(ratingPillHtml({
        label: "TVDB",
        value: rating || "",
        href: tvdbSeriesUrl(tvdbId),
        title: "Open this series on TheTVDB",
      }));
    } else if (tmdbId) {
      pills.push(ratingPillHtml({
        label: "TMDB",
        value: rating || "View",
        href: tmdbTitleUrl(mediaType, tmdbId),
        title: "Open this title on TMDB",
      }));
    }
  } else {
    if (tmdbId) {
      pills.push(ratingPillHtml({
        label: "TMDB",
        value: rating || "View",
        href: tmdbTitleUrl(mediaType, tmdbId),
        title: "Open this title on TMDB",
      }));
    }
  }
  return pills.join("");
}
