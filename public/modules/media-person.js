import { state, elements } from "./state.js?v=2.2.0.0.2";
import { escapeHtml, escapeAttribute, slug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showTitleFrom, showEpisodeKey } from "./utils.js?v=2.2.0.0.2";
import { tmdbProfile, tmdbPoster, hydratePosters } from "./images.js?v=2.2.0.0.2";
import { isWatchedHistoryAction } from "./sync.js?v=2.2.0.0.2";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=2.2.0.0.2";
import { movieBySlugOrId, clearMediaDetailState, mediaDetailRoot, mediaDetailLoaderHtml } from "./media-detail.js?v=2.2.0.0.2";
import { FILMOGRAPHY_PAGE_SIZE, resolvedTmdbCache } from "./explorer.js?v=2.2.0.0.2";

let _cb = {};
const PERSON_LIBRARY_CACHE_TTL_MS = 5 * 60 * 1000;
let personLibrarySnapshot = null;
let personLibrarySnapshotPromise = null;
let personRenderToken = 0;
export function initMediaPerson(callbacks = {}) { _cb = callbacks; }
function navigateTo(...args) { return _cb.navigateTo?.(...args); }
function setMessage(...args) { return _cb.setMessage?.(...args); }
function authHeaders(...args) { return _cb.authHeaders?.(...args); }
function applyActiveView(...args) { return _cb.applyActiveView?.(...args); }
function syncPageTopbar(...args) { return _cb.syncPageTopbar?.(...args); }

function personAge(birthday, endDate = null) {
  if (!birthday) return null;
  const born = new Date(birthday);
  const ended = endDate ? new Date(endDate) : new Date();
  if (Number.isNaN(born.getTime()) || Number.isNaN(ended.getTime()) || ended < born) return null;
  let age = ended.getFullYear() - born.getFullYear();
  const beforeBirthday =
    ended.getMonth() < born.getMonth() ||
    (ended.getMonth() === born.getMonth() && ended.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

function personSocialLinks(data = {}) {
  const ids = data.external_ids || {};
  return [
    ids.imdb_id ? { label: "IMDb", href: `https://www.imdb.com/name/${encodeURIComponent(ids.imdb_id)}` } : null,
    ids.instagram_id ? { label: "Instagram", href: `https://www.instagram.com/${encodeURIComponent(ids.instagram_id)}` } : null,
    ids.twitter_id ? { label: "X", href: `https://x.com/${encodeURIComponent(ids.twitter_id)}` } : null,
    ids.facebook_id ? { label: "Facebook", href: `https://www.facebook.com/${encodeURIComponent(ids.facebook_id)}` } : null,
    ids.tiktok_id ? { label: "TikTok", href: `https://www.tiktok.com/@${encodeURIComponent(ids.tiktok_id)}` } : null,
    ids.wikidata_id ? { label: "Wikidata", href: `https://www.wikidata.org/wiki/${encodeURIComponent(ids.wikidata_id)}` } : null,
  ].filter(Boolean);
}

function personSocialIcon(label) {
  if (label === "IMDb") {
    return `<svg class="person-social-icon person-social-icon--imdb" viewBox="0 0 32 16" aria-hidden="true"><rect width="32" height="16" rx="2" fill="#f5c518"/><text x="16" y="11.4" text-anchor="middle" fill="#111" font-family="Arial, sans-serif" font-size="9" font-weight="900">IMDb</text></svg>`;
  }
  if (label === "Instagram") {
    return `<svg class="person-social-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none"/></svg>`;
  }
  if (label === "X") {
    return `<svg class="person-social-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.966 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>`;
  }
  if (label === "Facebook") {
    return `<svg class="person-social-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.6 21v-8h2.8l.42-3.12H13.6v-2c0-.9.25-1.52 1.58-1.52H17V3.58c-.79-.08-1.58-.12-2.38-.12-2.36 0-4.02 1.44-4.02 4.1v2.32H7.9V13h2.7v8h3Z"/></svg>`;
  }
  if (label === "TikTok") {
    return `<svg class="person-social-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.7 3c.32 1.86 1.42 3.02 3.3 3.42v3.04a7.13 7.13 0 0 1-3.24-.82v6.18a6.18 6.18 0 1 1-5.34-6.12v3.1a3.12 3.12 0 1 0 2.24 3V3h3.04Z"/></svg>`;
  }
  if (label === "Wikidata") {
    return `<svg class="person-social-icon person-social-icon--wikidata" viewBox="0 0 30 18" aria-hidden="true"><path d="M2 2h2v14H2V2Zm4 0h1v14H6V2Zm3 0h3v14H9V2Z" fill="#900"/><path d="M14 2h1v14h-1V2Zm3 0h3v14h-3V2Zm5 0h1v14h-1V2Z" fill="#396"/><path d="M25 2h1v14h-1V2Zm3 0h2v14h-2V2Z" fill="#069"/></svg>`;
  }
  return "";
}

const PERSON_CREDIT_GENRES = new Map([
  [12, "Adventure"], [14, "Fantasy"], [16, "Animation"], [18, "Drama"],
  [27, "Horror"], [28, "Action"], [35, "Comedy"], [36, "History"],
  [37, "Western"], [53, "Thriller"], [80, "Crime"], [99, "Documentary"],
  [878, "Science Fiction"], [9648, "Mystery"], [10402, "Music"],
  [10749, "Romance"], [10751, "Family"], [10752, "War"],
  [10759, "Action & Adventure"], [10762, "Kids"], [10763, "News"],
  [10764, "Reality"], [10765, "Sci-Fi & Fantasy"], [10766, "Soap"],
  [10767, "Talk"], [10768, "War & Politics"], [10770, "TV Movie"],
]);

function personCreditYear(credit = {}) {
  const date = credit.release_date || credit.first_air_date || "";
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function personCreditLibraryHref(libItem, title) {
  if (libItem?.type === "show" || libItem?.type === "tvshow") {
    if (libItem.item?.tmdb_id) return tvShowTmdbHref(libItem.item.tmdb_id, libItem.item.title || title);
    if (libItem.item?.tvdb_id) return tvShowTvdbHref(libItem.item.tvdb_id, libItem.item.title || title);
    return `/tvshow/${encodeURIComponent(libItem.key)}`;
  }
  return movieHref(movieBySlugOrId(libItem?.id) || { id: libItem?.id, title });
}

export function closePersonProfile() {
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
  }
}

export async function loadCastMemberDetails(personId, personName = null) {
  const renderToken = ++personRenderToken;
  state.personProfileName = personName || "";
  if (elements.personModal) {
    elements.personModal.classList.add("hidden");
  }
  document.body.style.overflow = "";

  state.activeView = "explorer";
  state.mediaDetailInline = true;
  clearMediaDetailState();

  // Don't use prepareInlineMediaDetail() here: it calls selectView("explorer"),
  // which rebuilds the URL from activeMovieModalId/activeShowModalKey (still set
  // from the underlying movie/show) and overwrites the /person/<id> URL we're on.
  // That breaks closeMediaDetail()'s "return to the media item" branch below.
  applyActiveView();
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");
  // Hide the alphabet picker - it should only appear on the bare movie/show explorer.
  elements.alphaFilterNav?.classList.add("hidden");


  const root = mediaDetailRoot();

  if (elements.explorerTitle) {
    elements.explorerTitle.textContent = personName || "Cast Member Profile";
  }
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = "";
  }
  syncPageTopbar();

  root.innerHTML = mediaDetailLoaderHtml("Loading profile");

  try {
    const personCacheKey = String(personId);
    let res = state.tmdbPersonCache.get(personCacheKey);
    if (!res) {
      res = fetch(`/api/tmdb-person?id=${encodeURIComponent(personId)}`, { headers: authHeaders() })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
          return body;
        });
      state.tmdbPersonCache.set(personCacheKey, res);
      res.catch(() => state.tmdbPersonCache.delete(personCacheKey));
    }
    const data = await res;
    if (renderToken !== personRenderToken) return;

    // Build filmography-local lookups by tmdb_id and slug so findLibraryItem can
    // match even when the explorer hasn't been opened yet.
    let filmographyLookup = { allWatchedMovies: [], allWatchedShows: [] };

    if (elements.explorerTitle) {
      elements.explorerTitle.textContent = data.name || "Cast Member Profile";
    }
    state.personProfileName = data.name || "Cast Member Profile";
    syncPageTopbar();

    const castCredits = (data.combined_credits?.cast || []);
    const profileUrl = tmdbProfile(data.profile_path) || '/favicon.svg';

    const creditGenreIds = [...new Set(castCredits.flatMap((credit) => credit.genre_ids || []))]
      .filter((genreId) => PERSON_CREDIT_GENRES.has(genreId))
      .sort((a, b) => PERSON_CREDIT_GENRES.get(a).localeCompare(PERSON_CREDIT_GENRES.get(b)));

    // Keep selections when returning to the same profile, but never carry them
    // over to another person. Filmography options are profile-specific because
    // the available years and genres differ between people.
    const personKey = String(personId);
    if (state.personCreditsPersonId !== personKey) {
      state.personCreditsPersonId = personKey;
      state.personCreditsFilter = "movie";
      state.personCreditsYear = "all";
      state.personCreditsGenre = "all";
      state.personCreditsSort = "date_desc";
      state.personCreditsMovieSort = "date_desc";
      state.personCreditsTvSort = "date_desc";
    }
    state.personCreditsFilter = state.personCreditsFilter || "movie";
    state.personCreditsYear = state.personCreditsYear || "all";
    state.personCreditsGenre = state.personCreditsGenre || "all";
    state.personCreditsSort = state.personCreditsSort || "date_desc";
    if (!["movie", "tv"].includes(state.personCreditsFilter)) state.personCreditsFilter = "movie";
    if (state.personCreditsGenre !== "all" && !creditGenreIds.includes(Number(state.personCreditsGenre))) state.personCreditsGenre = "all";
    if (!["popularity", "date_desc", "date_asc", "title_asc", "title_desc"].includes(state.personCreditsSort)) state.personCreditsSort = "date_desc";
    state.personCreditsMovieSort = state.personCreditsMovieSort || state.personCreditsSort;
    state.personCreditsTvSort = state.personCreditsTvSort || state.personCreditsSort;
    if (!["popularity", "date_desc", "date_asc", "title_asc", "title_desc"].includes(state.personCreditsMovieSort)) state.personCreditsMovieSort = "date_desc";
    if (!["popularity", "date_desc", "date_asc", "title_asc", "title_desc"].includes(state.personCreditsTvSort)) state.personCreditsTvSort = "date_desc";

    const sortOptions = [
      ["popularity", "Popularity"],
      ["date_desc", "Newest"],
      ["date_asc", "Oldest"],
      ["title_asc", "A → Z"],
      ["title_desc", "Z → A"],
    ];
    const yearOptions = [...new Set(castCredits.map(personCreditYear).filter((year) => year !== null))]
      .sort((a, b) => b - a)
      .map((year) => [String(year), String(year)]);
    const renderFilterMenu = (id, label, current, options) => `
      <div class="person-filter-menu" data-menu-id="${id}">
        <span class="person-filter-group-label">${label}</span>
        <div class="person-filter-options" role="group" aria-label="${label}">
          ${options.map(([value, text]) => `<button class="person-filter-menu-option${String(value) === String(current) ? " active" : ""}" type="button" data-person-filter-option="${id}" data-value="${escapeAttribute(value)}">${escapeHtml(text)}</button>`).join("")}
        </div>
      </div>`;
    const renderSelectFilter = (id, label, current, options) => `
      <label class="person-credit-filter">
        <span>${label}</span>
        <select id="${id}">
          ${options.map(([value, text]) => `<option value="${escapeAttribute(value)}"${String(value) === String(current) ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}
        </select>
      </label>`;

    root.innerHTML = `
      <div class="person-profile-container">
        <div class="person-profile-sidebar">
          <img class="person-profile-img" src="${escapeAttribute(profileUrl)}" alt="${escapeAttribute(data.name)}" data-err="fav" />
          <h2 class="person-profile-name">${escapeHtml(data.name)}</h2>
          <section class="person-profile-meta">
            <div class="person-profile-meta-items">
            ${data.birthday ? `
            <div class="meta-item">
              <span class="meta-label">Born</span>
              <span class="meta-value">${escapeHtml(data.birthday)}${!data.deathday && personAge(data.birthday) !== null ? ` (age ${personAge(data.birthday)})` : ''}</span>
            </div>
            ` : ''}
            ${data.place_of_birth ? `
            <div class="meta-item">
              <span class="meta-label">From</span>
              <span class="meta-value">${escapeHtml(data.place_of_birth)}</span>
            </div>
            ` : ''}
            ${data.deathday ? `
            <div class="meta-item">
              <span class="meta-label">Died</span>
              <span class="meta-value">${escapeHtml(data.deathday)}${personAge(data.birthday, data.deathday) !== null ? ` (aged ${personAge(data.birthday, data.deathday)})` : ''}</span>
            </div>
            ` : ''}
            </div>
          </section>
          ${(() => {
            const socials = personSocialLinks(data);
            if (!socials.length) return '';
            return `
          <section class="person-socials-section">
            <div class="person-socials-links">
              ${socials.map((s) => `<a class="person-social-link" href="${escapeAttribute(s.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttribute(s.label)}" title="${escapeAttribute(s.label)}">${personSocialIcon(s.label)}<span class="sr-only">${escapeHtml(s.label)}</span></a>`).join('')}
            </div>
          </section>`;
          })()}
          ${data.biography ? `
          <div class="person-biography-section">
            <p class="person-biography-text">${escapeHtml(data.biography)}</p>
            <button class="person-biography-toggle hidden" type="button" aria-expanded="false" data-person-bio-toggle>Read more</button>
          </div>
          ` : '<p class="muted-copy">No biography available for this cast member.</p>'}
        </div>
        <div class="person-profile-content">
        ${(() => {
      const seen = new Set();
      const addUnique = (list) => list.filter((img) => {
        if (!img.file_path || seen.has(img.file_path)) return false;
        seen.add(img.file_path);
        return true;
      });
      const profiles = addUnique(data.images?.profiles || []);
      // tagged_images are photos TMDB has tagged as featuring this person
      // (drop title posters so the gallery stays photos OF the person).
      const tagged = addUnique(
        (data.tagged_images?.results || []).filter((img) => img.image_type !== "poster")
      );
      const gallery = [...profiles, ...tagged].slice(0, 250);
      if (!gallery.length) return '';
      window._personPhotos = gallery.map((img) => tmdbProfile(img.file_path));
      return `
          <div class="person-photos-section">
            <h3>Photos <span class="person-photos-count">${gallery.length}</span></h3>
            <div class="person-photos-grid">
              ${gallery.map((img, i) => `
                <img class="person-photo-thumb" src="${escapeAttribute(tmdbProfile(img.file_path))}" loading="lazy" alt="${escapeAttribute(data.name)}" data-photo-index="${i}" data-err="hide" />
              `).join('')}
            </div>
          </div>`;
    })()}

        <div class="person-credits-section">
          <div class="person-credits-header">
            <h3>Filmography</h3>
            <span class="person-credits-count"><span id="personCreditsCount">${castCredits.length}</span> matching titles</span>
          </div>
          <div class="person-media-filter-buttons" role="group" aria-label="Filmography type">
            <button class="person-filter-button${state.personCreditsFilter === "movie" ? " active" : ""}" type="button" data-person-media-type="movie" aria-pressed="${state.personCreditsFilter === "movie"}">Movies <span class="person-media-filter-count" id="personMoviesCount">0</span></button>
            <button class="person-filter-button${state.personCreditsFilter === "tv" ? " active" : ""}" type="button" data-person-media-type="tv" aria-pressed="${state.personCreditsFilter === "tv"}">TV Shows <span class="person-media-filter-count" id="personTvCount">0</span></button>
          </div>
          <div class="person-credits-controls" aria-label="Filmography filters">
            ${renderSelectFilter("personCreditsYearFilter", "Year", state.personCreditsYear, [["all", "All years"], ...yearOptions])}
            ${renderSelectFilter("personCreditsGenreFilter", "Genre", state.personCreditsGenre, [["all", "All genres"], ...creditGenreIds.map((genreId) => [String(genreId), PERSON_CREDIT_GENRES.get(genreId)])])}
          </div>
          <div class="person-credits-split">
            <section class="person-credits-pane${state.personCreditsFilter === "movie" ? " is-active" : ""}" data-person-media-pane="movie"${state.personCreditsFilter === "movie" ? "" : " hidden"}>
              <div class="person-credits-pane-header">
                <h4>Movies</h4>
                ${renderFilterMenu("movie-sort", "Sort", state.personCreditsMovieSort, sortOptions)}
              </div>
              <div class="person-credits-grid" id="personMoviesGrid"><div class="person-credits-loading"><span>Sorting movies...</span></div></div>
            </section>
            <section class="person-credits-pane${state.personCreditsFilter === "tv" ? " is-active" : ""}" data-person-media-pane="tv"${state.personCreditsFilter === "tv" ? "" : " hidden"}>
              <div class="person-credits-pane-header">
                <h4>TV Shows</h4>
                ${renderFilterMenu("tv-sort", "Sort", state.personCreditsTvSort, sortOptions)}
              </div>
              <div class="person-credits-grid" id="personTvGrid"><div class="person-credits-loading"><span>Sorting TV shows...</span></div></div>
            </section>
          </div>
        </div>
      </div>
    </div>
    `;

    const biography = root.querySelector(".person-biography-text");
    const biographyToggle = root.querySelector("[data-person-bio-toggle]");
    if (biography && biographyToggle) {
      requestAnimationFrame(() => {
        if (renderToken !== personRenderToken) return;
        biographyToggle.classList.toggle("hidden", biography.scrollHeight <= biography.clientHeight + 1);
      });
      biographyToggle.addEventListener("click", () => {
        const expanded = biography.classList.toggle("is-expanded");
        biographyToggle.setAttribute("aria-expanded", String(expanded));
        biographyToggle.textContent = expanded ? "Show less" : "Read more";
      });
    }

    const yearFilter = root.querySelector("#personCreditsYearFilter");
    const genreFilter = root.querySelector("#personCreditsGenreFilter");
    const movieGrid = root.querySelector("#personMoviesGrid");
    const tvGrid = root.querySelector("#personTvGrid");
    const movieCount = root.querySelector("#personMoviesCount");
    const tvCount = root.querySelector("#personTvCount");
    const mediaTypeButtons = [...root.querySelectorAll("[data-person-media-type]")];
    const mediaTypePanes = [...root.querySelectorAll("[data-person-media-pane]")];
    const photosGrid = root.querySelector(".person-photos-grid");
    const visibleCounts = { movie: FILMOGRAPHY_PAGE_SIZE, tv: FILMOGRAPHY_PAGE_SIZE };
    let movieObserver = null;
    let tvObserver = null;

    const renderCreditCards = (credits) => {
      const libraryTvCredits = [];
      const html = credits.map(credit => {
        const isTv = credit.media_type === "tv";
        const title = credit.title || credit.name || "Untitled";
        const character = credit.character || "Unknown Character";
        const posterUrl = tmdbPoster(credit.poster_path) || '/favicon.svg';
        const dateStr = credit.release_date || credit.first_air_date || "";
        const year = dateStr ? dateStr.split("-")[0] : "";

        let libItem = findLibraryItem(credit.media_type, credit.id, title, filmographyLookup);
        if (!libItem && credit.in_library) {
          if (isTv) {
            libItem = {
              type: "show",
              key: credit.library_key,
              item: {
                title: credit.show_title || title,
                episode_count: credit.watched_count,
              }
            };
          } else {
            libItem = {
              type: "movie",
              id: credit.library_id
            };
          }
        }

        const isInLibrary = !!credit.in_library;
        const isWatched = !!(credit.in_watch_history || credit.in_library ||
          (!isTv && filmographyLookup.allWatchedMovies.some(m => String(m.tmdb_id || "") === String(credit.id))) ||
          (isTv && filmographyLookup.allWatchedShows.some(s => String(s.tmdb_id || "") === String(credit.id))));

        if (libItem && isInLibrary) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = personCreditLibraryHref(libItem, title);
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <span class="person-credit-poster-wrap">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
                <span class="person-credit-badges">
                  <span class="library-badge">In Library</span>
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </span>
              <div class="person-credit-info">
                <span class="person-credit-title-row">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)}</span>
                  ${year ? `<span class="person-credit-year">${escapeHtml(year)}</span>` : ""}
                </span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
              </div>
            </a>
          `;
        } else if (libItem && isWatched) {
          const cachedTmdb = isTv ? resolvedTmdbCache("tv", credit.id, title) : null;
          const watchProgress = isTv ? libraryTvWatchProgress(libItem, cachedTmdb) : null;
          if (isTv) libraryTvCredits.push({ credit, libItem, title });
          const href = personCreditLibraryHref(libItem, title);
          return `
            <a class="person-credit-card in-library" href="${escapeAttribute(href)}" data-library-item-type="${libItem.type}" data-library-item-id="${escapeAttribute(libItem.id || libItem.key)}" data-library-item-title="${escapeAttribute(title)}">
              <span class="person-credit-poster-wrap">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
                <span class="person-credit-badges">
                  ${isTv ? personWatchBadgeMarkup(watchProgress, credit.id) : `<span class="watch-state-badge is-complete">Watched</span>`}
                </span>
              </span>
              <div class="person-credit-info">
                <span class="person-credit-title-row">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)}</span>
                  ${year ? `<span class="person-credit-year">${escapeHtml(year)}</span>` : ""}
                </span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
              </div>
            </a>
          `;
        } else {
          const href = isTv ? tvShowTmdbHref(credit.id, title) : movieTmdbHref(credit.id, title);
          return `
            <a class="person-credit-card" href="${escapeAttribute(href)}" data-tmdb-id="${credit.id}" data-tmdb-media-type="${credit.media_type}" data-tmdb-title="${escapeAttribute(title)}">
              <span class="person-credit-poster-wrap">
                <img class="person-credit-poster" src="${escapeAttribute(posterUrl)}" alt="${escapeAttribute(title)}" loading="lazy" data-err="fav" />
              </span>
              <div class="person-credit-info">
                <span class="person-credit-title-row">
                  <span class="person-credit-title" title="${escapeAttribute(title)}">${escapeHtml(title)}</span>
                  ${year ? `<span class="person-credit-year">${escapeHtml(year)}</span>` : ""}
                </span>
                <span class="person-credit-character" title="${escapeAttribute(character)}">as ${escapeHtml(character)}</span>
              </div>
            </a>
          `;
        }
      }).join("");
      return { html, libraryTvCredits };
    };

    const matchesGenreFilter = (credit) => (
      state.personCreditsGenre === "all" || (credit.genre_ids || []).includes(Number(state.personCreditsGenre))
    );

    const updateYearOptions = () => {
      if (!yearFilter) return;
      const yearCounts = new Map();
      castCredits.filter(matchesGenreFilter).forEach((credit) => {
        const year = personCreditYear(credit);
        if (year === null) return;
        yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
      });
      const years = [...yearCounts.keys()].sort((a, b) => b - a);
      if (state.personCreditsYear !== "all" && !yearCounts.has(Number(state.personCreditsYear))) {
        state.personCreditsYear = "all";
      }
      yearFilter.innerHTML = `
        <option value="all">All years</option>
        ${years.map((year) => `<option value="${year}">${year} (${yearCounts.get(year)})</option>`).join("")}
      `;
      yearFilter.value = String(state.personCreditsYear);
    };

    const sortCredits = (credits, sort) => {
      const sorted = [...credits];
      if (sort === "popularity") {
        sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      } else if (sort === "date_desc") {
        sorted.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateB.localeCompare(dateA);
        });
      } else if (sort === "date_asc") {
        sorted.sort((a, b) => {
          const dateA = a.release_date || a.first_air_date || "";
          const dateB = b.release_date || b.first_air_date || "";
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateA.localeCompare(dateB);
        });
      } else if (sort === "title_asc") {
        sorted.sort((a, b) => (a.title || a.name || "").localeCompare(b.title || b.name || ""));
      } else if (sort === "title_desc") {
        sorted.sort((a, b) => (b.title || b.name || "").localeCompare(a.title || a.name || ""));
      }
      return sorted;
    };

    const updateSection = (mediaType, gridEl, countEl, sort, resetVisible = true) => {
      if (!gridEl) return;
      if (resetVisible) visibleCounts[mediaType] = FILMOGRAPHY_PAGE_SIZE;
      updateYearOptions();
      let filtered = castCredits.filter((credit) => credit.media_type === mediaType).filter(matchesGenreFilter);
      if (state.personCreditsYear !== "all") {
        const selectedYear = Number.parseInt(state.personCreditsYear, 10);
        filtered = filtered.filter((credit) => personCreditYear(credit) === selectedYear);
      }
      filtered = sortCredits(filtered, sort);
      countEl.textContent = filtered.length;

      const observerKey = mediaType === "movie" ? "movie" : "tv";
      if (observerKey === "movie" && movieObserver) movieObserver.disconnect();
      if (observerKey === "tv" && tvObserver) tvObserver.disconnect();

      if (filtered.length === 0) {
        gridEl.innerHTML = `<p class="muted-copy" style="grid-column: 1 / -1; text-align: center; padding: 2rem 0;">No matching filmography items found.</p>`;
        return;
      }

      const visibleCount = Math.min(visibleCounts[mediaType], filtered.length);
      const page = filtered.slice(0, visibleCount);
      const hasMore = filtered.length > visibleCount;

      const { html, libraryTvCredits } = renderCreditCards(page);
      gridEl.innerHTML = html + (hasMore ? `<div class="filmography-load-sentinel" aria-hidden="true"></div>` : "");

      if (libraryTvCredits.length > 0) {
        hydratePersonFilmographyWatchStatuses(personId, libraryTvCredits);
      }

      if (hasMore) {
        const sentinel = gridEl.querySelector(".filmography-load-sentinel");
        if (sentinel) {
          const observer = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            visibleCounts[mediaType] += FILMOGRAPHY_PAGE_SIZE;
            updateSection(mediaType, gridEl, countEl, sort, false);
          }, { root: gridEl, rootMargin: "600px" });
          if (observerKey === "movie") movieObserver = observer;
          else tvObserver = observer;
          observer.observe(sentinel);
        }
      }
    };

    root.addEventListener("click", (event) => {
      const mediaTypeButton = event.target.closest("[data-person-media-type]");
      if (mediaTypeButton) {
        state.personCreditsFilter = mediaTypeButton.dataset.personMediaType;
        mediaTypeButtons.forEach((button) => {
          const selected = button.dataset.personMediaType === state.personCreditsFilter;
          button.classList.toggle("active", selected);
          button.setAttribute("aria-pressed", String(selected));
        });
        mediaTypePanes.forEach((pane) => {
          const selected = pane.dataset.personMediaPane === state.personCreditsFilter;
          pane.hidden = !selected;
          pane.classList.toggle("is-active", selected);
        });
        return;
      }
      const option = event.target.closest("[data-person-filter-option]");
      if (!option) return;
      const menu = option.closest("[data-menu-id]");
      const filter = option.dataset.personFilterOption;
      const value = option.dataset.value;
      if (filter === "year") state.personCreditsYear = value;
      if (filter === "genre") state.personCreditsGenre = value;
      if (filter === "movie-sort") state.personCreditsMovieSort = value;
      if (filter === "tv-sort") state.personCreditsTvSort = value;
      menu?.querySelectorAll("[data-person-filter-option]").forEach((item) => item.classList.toggle("active", item === option));
      if (filter === "year" || filter === "genre") {
        updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort);
        updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort);
      } else if (filter === "movie-sort") {
        updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort);
      } else if (filter === "tv-sort") {
        updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort);
      }
    });

    yearFilter?.addEventListener("change", () => {
      state.personCreditsYear = yearFilter.value;
      updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort);
      updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort);
    });

    genreFilter?.addEventListener("change", () => {
      state.personCreditsGenre = genreFilter.value;
      updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort);
      updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort);
    });

    photosGrid?.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const multiplier = event.deltaMode === 1 ? 32 : (event.deltaMode === 2 ? photosGrid.clientWidth : 1);
      const delta = event.deltaY * multiplier;
      const maxScroll = photosGrid.scrollWidth - photosGrid.clientWidth;
      const canMove = (delta < 0 && photosGrid.scrollLeft > 0) || (delta > 0 && photosGrid.scrollLeft < maxScroll - 1);
      if (!canMove) return;
      event.preventDefault();
      photosGrid.scrollLeft += delta;
    }, { passive: false });

    // Initial render of the grid
    updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort);
    updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort);

    // Watched-state decoration is useful, but it is not required for the profile
    // shell or filmography to become usable. Load the large local snapshots after
    // the first paint and reuse them briefly while navigating between profiles.
    const loadLibrarySnapshot = async () => {
      if (personLibrarySnapshot && Date.now() - personLibrarySnapshot.updatedAt < PERSON_LIBRARY_CACHE_TTL_MS) {
        return personLibrarySnapshot;
      }
      if (!personLibrarySnapshotPromise) {
        personLibrarySnapshotPromise = Promise.all([
          fetch(`/api/movies?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }).then((response) => response.json().catch(() => ({}))),
          fetch(`/api/shows?limit=5000&sort=title_asc`, { headers: authHeaders(), cache: "no-store" }).then((response) => response.json().catch(() => ({}))),
        ]).then(([moviesBody, showsBody]) => {
          personLibrarySnapshot = {
            allWatchedMovies: Array.isArray(moviesBody.movies) ? moviesBody.movies : [],
            allWatchedShows: Array.isArray(showsBody.shows) ? showsBody.shows : [],
            updatedAt: Date.now(),
          };
          return personLibrarySnapshot;
        }).finally(() => { personLibrarySnapshotPromise = null; });
      }
      return personLibrarySnapshotPromise;
    };
    loadLibrarySnapshot().then((snapshot) => {
      if (renderToken !== personRenderToken) return;
      filmographyLookup = snapshot;
      updateSection("movie", movieGrid, movieCount, state.personCreditsMovieSort, false);
      updateSection("tv", tvGrid, tvCount, state.personCreditsTvSort, false);
    }).catch(() => {});

  } catch (err) {
    if (renderToken !== personRenderToken) return;
    root.innerHTML = `
      <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 200px; gap: 1rem;">
        <span class="status-pill status-error" style="font-size: 1rem; padding: var(--space-2) var(--space-4);">Failed to load profile</span>
        <span style="color: var(--muted);">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

window.openLibraryItem = function (mediaType, idOrKey, title, isLibraryItem = true, tmdbId = null) {
  const modal = elements.personModal;
  if (modal) modal.classList.add("hidden");

  if (isLibraryItem) {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(`/tvshow/${idOrKey}`);
    } else if (mediaType === "movie") {
      navigateTo(movieHref(movieBySlugOrId(idOrKey) || { id: idOrKey, title }));
    }
  } else {
    if (mediaType === "show" || mediaType === "tv") {
      navigateTo(tvShowTmdbHref(tmdbId, title));
    } else if (mediaType === "movie") {
      navigateTo(movieTmdbHref(tmdbId, title));
    }
  }

  if (elements.debugModal && elements.debugModal.classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
};

export function findLibraryItem(mediaType, tmdbId, title, filmographyLookup = null) {
  const cleanTitle = slug(title);
  if (mediaType === "tv" || mediaType === "show") {
    // Check the full server-fetched list first (filmography page), then fall back
    // to the in-memory explorer state which may be only partially loaded.
    let found = (filmographyLookup?.allWatchedShows || []).find(s => String(s.tmdb_id || "") === String(tmdbId));
    if (!found) found = (filmographyLookup?.allWatchedShows || []).find(s => slug(s.title) === cleanTitle);
    if (!found) {
      found = state.showsRaw.find(s => String(s.tmdb_id || "") === String(tmdbId));
    }
    if (!found) {
      found = state.showsRaw.find(s => slug(s.title) === cleanTitle);
    }
    if (!found) {
      const matchingProviderRows = state.history.filter(h => h.media_type === "episode" && isWatchedHistoryAction(h) && String(h.tmdb_id || "") === String(tmdbId));
      const historyRows = matchingProviderRows.length
        ? matchingProviderRows
        : state.history.filter(h => h.media_type === "episode" && isWatchedHistoryAction(h) && slug(h.show_title || showTitleFrom(h.title)) === cleanTitle);
      if (historyRows.length) {
        const histRow = historyRows[0];
        found = {
          title: histRow.show_title || showTitleFrom(histRow.title),
          id: histRow.tvdb_id || histRow.tmdb_id || histRow.show_title,
          tmdb_id: histRow.tmdb_id || tmdbId,
          episodes: historyRows,
          episode_count: new Set(historyRows.map((row) => showEpisodeKey(row.season, row.episode))).size,
        };
      }
    }
    return found ? { type: "show", key: slug(found.title), item: found } : null;
  } else {
    // Check the full server-fetched movies list first, then the partially-loaded explorer.
    let found = (filmographyLookup?.allWatchedMovies || []).find(
      m => String(m.tmdb_id || "") === String(tmdbId) || slug(m.title) === cleanTitle
    );
    if (!found) {
      found = state.moviesRaw.find(m => String(m.tmdb_id) === String(tmdbId) || slug(m.title) === cleanTitle);
    }
    if (!found) {
      found = state.history.find(h => h.media_type === "movie" && (String(h.tmdb_id) === String(tmdbId) || slug(h.title) === cleanTitle));
    }
    return found ? { type: "movie", id: found.id } : null;
  }
}

export function libraryTvWatchProgress(libItem, tmdbData = null) {
  const show = libItem?.item || {};
  const watchedKeys = new Set();
  for (const episode of show.episodes || []) {
    if (!isWatchedHistoryAction(episode)) continue;
    if (Number(episode.season || 0) <= 0) continue;
    watchedKeys.add(showEpisodeKey(episode.season, episode.episode));
  }
  const watched = watchedKeys.size || Number(show.episode_count || 0);
  const total = show.total_episodes || Number(tmdbData?.number_of_episodes || 0);
  return {
    watched,
    total,
    complete: total > 0 && watched >= total,
  };
}

export function personWatchBadgeMarkup(progress, tmdbId) {
  if (!progress?.watched) return "";
  const label = progress.complete ? "Watched" : "Part watched";
  const count = progress.total > 0 ? `${Number(progress.watched)}/${Number(progress.total)}` : `${Number(progress.watched)} ep`;
  return `<span class="watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}" data-person-watch-status="${escapeAttribute(tmdbId)}">${escapeHtml(label)} <small>${escapeHtml(count)}</small></span>`;
}

export async function hydratePersonFilmographyWatchStatuses(personId, credits = []) {
  await Promise.all(credits.map(async ({ credit, libItem, title }) => {
    const tmdbData = await fetchTmdbDetails("tv", credit.id, title);
    if (window.location.pathname !== `/person/${personId}`) return;
    const progress = libraryTvWatchProgress(libItem, tmdbData);
    document.querySelectorAll(`[data-person-watch-status="${CSS.escape(String(credit.id))}"]`).forEach((badge) => {
      badge.className = `watch-state-badge ${progress.complete ? "is-complete" : "is-partial"}`;
      const label = progress.complete ? "Watched" : "Part watched";
      const count = progress.total > 0 ? `${Number(progress.watched)}/${Number(progress.total)}` : `${Number(progress.watched)} ep`;
      badge.innerHTML = `${escapeHtml(label)} <small>${escapeHtml(count)}</small>`;
    });
  }));
}
