import { escapeAttribute, escapeHtml } from "./utils.js?v=2.1.1.0.8";
import { tmdbPoster, proxiedArtworkUrl } from "./images.js?v=2.1.1.0.8";

// Season Posters tab for the Edit Images dialog. The first view lists the
// show's seasons with their current posters. Choosing a season shows the same
// provider grid and upload as the Poster tab, scoped to that season.
// getIdentity is read on every call, so a show changed by the match search applies here too.
// The season list is read from TMDB for the current identity when the list opens: the
// dialog's own show data may have no seasons (a TMDB cache miss) or be for the show before a re-match.
export function createSeasonPostersPanel({ gridEl, status, getIdentity, seasons = [], demo = false, authHeaders, renderOptions, setPickedUrl }) {
  let selectedSeason = null;
  let savedPosters = new Map();
  let backBar = null;
  let listRequestVersion = 0;

  const normalizeSeasons = (list) => (Array.isArray(list) ? list : [])
    .map((season) => ({ ...season, season_number: Number(season.season_number) }))
    .filter((season) => Number.isInteger(season.season_number) && season.season_number >= 0)
    .sort((a, b) => a.season_number - b.season_number);

  let seasonList = normalizeSeasons(seasons);

  const identityQuery = (extra = {}) => {
    const identity = getIdentity();
    const params = new URLSearchParams();
    if (identity.tmdb_id) params.set("tmdbId", identity.tmdb_id);
    if (identity.tvdb_id) params.set("tvdbId", identity.tvdb_id);
    if (identity.title) params.set("title", identity.title);
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return params.toString();
  };

  const seasonLabel = (number) => (number === 0 ? "Specials" : `Season ${number}`);

  const seasonPosterUrl = (path) => {
    const raw = String(path || "").trim();
    if (!raw) return "";
    return /^https?:\/\//i.test(raw)
      ? proxiedArtworkUrl(raw, "poster")
      : tmdbPoster(raw, getIdentity().tmdb_id, "tv");
  };

  const ensureBackBar = () => {
    if (backBar) return backBar;
    backBar = document.createElement("div");
    backBar.className = "season-posters-back";
    backBar.hidden = true;
    backBar.innerHTML = `<button class="button-ghost season-posters-all" type="button">All seasons</button>`;
    backBar.querySelector("button").addEventListener("click", showSeasonList);
    gridEl.before(backBar);
    return backBar;
  };

  // Returns null when TMDB could not be read, so the list shows an error instead of a stale show's seasons.
  const loadSeasonList = async () => {
    if (demo) return seasonList;
    try {
      const res = await fetch(`/api/tmdb-details?${identityQuery({ mediaType: "tv" })}`, { headers: authHeaders() });
      if (!res.ok) return null;
      const data = await res.json();
      return normalizeSeasons(data?.seasons);
    } catch {
      return null;
    }
  };

  const fetchSavedPosters = async () => {
    if (demo) return new Map();
    try {
      const res = await fetch(`/api/season-posters?${identityQuery()}`, { headers: authHeaders() });
      const data = await res.json();
      return new Map(Object.entries(data?.seasons || {}).map(([key, url]) => [Number(key), url]));
    } catch {
      return new Map();
    }
  };

  const fetchOptions = async (number) => {
    if (demo) {
      const season = seasonList.find((item) => item.season_number === number);
      const url = seasonPosterUrl(season?.poster_path);
      return url ? [{ url, source: "TMDB" }] : [];
    }
    try {
      const res = await fetch(`/api/season-poster-options?${identityQuery({ seasonNumber: number })}`, { headers: authHeaders() });
      const data = await res.json();
      return Array.isArray(data?.posters) ? data.posters : [];
    } catch {
      return [];
    }
  };

  async function showSeasonList() {
    const requestVersion = ++listRequestVersion;
    selectedSeason = null;
    setPickedUrl("");
    ensureBackBar().hidden = true;
    status.textContent = "Loading seasons…";
    gridEl.innerHTML = "";
    gridEl.classList.remove("edit-image-grid--logo", "edit-image-grid--backdrop");
    const loaded = await loadSeasonList();
    if (requestVersion !== listRequestVersion || selectedSeason !== null) return;
    if (loaded === null) {
      status.textContent = "Could not load the seasons for this show.";
      return;
    }
    seasonList = loaded;
    if (!seasonList.length) {
      status.textContent = "No seasons found for this show.";
      return;
    }
    status.textContent = "";
    savedPosters = await fetchSavedPosters();
    if (requestVersion !== listRequestVersion || selectedSeason !== null) return;
    gridEl.innerHTML = seasonList.map((season) => {
      const number = season.season_number;
      const url = savedPosters.get(number) || seasonPosterUrl(season.poster_path);
      const previewUrl = url ? proxiedArtworkUrl(url, "poster") : "";
      const image = previewUrl
        ? `<img src="${escapeAttribute(previewUrl)}" alt="" loading="lazy" data-err="hide" />`
        : "";
      return `
        <button class="edit-image-option season-option" type="button" data-season="${number}">
          ${image}
          <span class="season-option-label">${escapeHtml(seasonLabel(number))}</span>
        </button>
      `;
    }).join("");
    gridEl.querySelectorAll(".season-option").forEach((btn) => {
      btn.addEventListener("click", () => openSeason(Number(btn.dataset.season)));
    });
  }

  async function openSeason(number) {
    selectedSeason = number;
    ensureBackBar().hidden = false;
    setPickedUrl("");
    status.textContent = `Loading ${seasonLabel(number)} posters…`;
    const items = await fetchOptions(number);
    if (selectedSeason !== number) return;
    const saved = savedPosters.get(number);
    if (saved && !items.some((item) => item.url === saved)) items.unshift({ url: saved, source: "Saved" });
    if (items.length) {
      status.textContent = "";
      renderOptions(items);
      return;
    }
    status.textContent = "No posters found for this season.";
    gridEl.innerHTML = "";
  }

  return {
    show: showSeasonList,
    hide() {
      listRequestVersion += 1;
      selectedSeason = null;
      if (backBar) backBar.hidden = true;
    },
    selectedSeason: () => selectedSeason,
    savePayload(url) {
      const identity = getIdentity();
      return {
        poster_url: url,
        artwork_scope: "season",
        season_number: selectedSeason,
        show_title: identity.title,
        show_tmdb_id: identity.tmdb_id,
        show_tvdb_id: identity.tvdb_id,
        show_imdb_id: identity.imdb_id,
      };
    },
    recordSaved(saved) {
      if (selectedSeason === null || !saved?.season_poster_url) return;
      savedPosters.set(selectedSeason, saved.season_poster_url);
    },
  };
}
