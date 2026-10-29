import { buildAuthHeaders } from "./auth.js?v=2.2.1.0.2";
import { state, elements } from "./state.js?v=2.2.1.0.2";
import { escapeHtml, escapeAttribute, slug, tvShowTmdbHref, tvShowTvdbHref } from "./utils.js?v=2.2.1.0.2";
import { renderMediaCard } from "./media-card.js?v=2.2.1.0.2";
import { hydratePosters, posterOverflowMenu, proxiedArtworkUrl } from "./images.js?v=2.2.1.0.2";
import { droppedTitleActionHtml } from "./dropped-titles.js?v=2.2.1.0.2";
import { closePosterOverflowMenu } from "./poster-menu.js?v=2.2.1.0.2";
import { loadRouteModule } from "./route-modules.js?v=2.2.1.0.2";

// A separate panel includes dropped titles with no watch history. Filtering the
// paginated history/library rows would silently omit those titles.
const views = new Map();
let revision = 0;

export async function fetchDroppedTitles() {
  const response = await fetch("/api/dropped-titles", { headers: buildAuthHeaders(state.token) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load dropped titles");
  if (!Array.isArray(body.items)) throw new Error("Dropped title response was incomplete");
  return body.items;
}

export function filterDroppedTitles(rows, { type = "all", search = "" } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => (type === "all" || row.media_type === type)
    && (!query || String(row.title || "").toLocaleLowerCase().includes(query)));
}

// A dropped show uses the same card as the TV Shows library (renderShowRecord
// in explorer.js). The id stays empty: a dropped-title id is not a history id,
// so /api/poster could not resolve it, and the saved poster is used instead.
// The card renderer comes from the dashboard module, which the library route
// already loads; Stats imports this module and must not pull it in.
export function renderDroppedShowCard(row, renderDashboardHistoryPageCard) {
  const title = row.title || row.snapshot?.title || "Unknown Show";
  const href = row.tmdb_id ? tvShowTmdbHref(row.tmdb_id, title) : row.tvdb_id ? tvShowTvdbHref(row.tvdb_id, title) : `/tvshow/${slug(title)}`;
  const poster = proxiedArtworkUrl(row.snapshot?.show_poster_url || row.snapshot?.poster_url || "", "poster");
  const letter = /^[a-z]/i.test(title) ? title[0].toUpperCase() : "#";
  // The three-dot menu holds only Un-drop; its id is just a menu key, not a history id.
  const menuHtml = posterOverflowMenu({ id: `dropped-${row.id || slug(title)}`, media_type: "tv", title }, { menuMode: "dropped", title, label: title })
    + droppedTitleActionHtml({ media_type: "show", title, tmdb_id: row.tmdb_id || "", tvdb_id: row.tvdb_id || "", imdb_id: row.imdb_id || "", year: row.year || "", poster_url: poster }, { card: true, dropped: true });
  // The card's date row carries the drop date, so it is labelled Dropped.
  return renderDashboardHistoryPageCard({
    id: "", title, media_type: "episode", show_title: title,
    show_tmdb_id: row.tmdb_id || "", show_tvdb_id: row.tvdb_id || "", show_imdb_id: row.imdb_id || "",
    poster_url: poster, show_poster_url: poster, season_poster_url: "", prefer_show_poster: true,
    watched_at: row.dropped_at ? new Date(row.dropped_at).toISOString() : "",
  }, {
    explorer: true, explorerSummary: "", explorerClass: "folder-card",
    explorerAttributes: ` data-alpha-letter="${escapeAttribute(letter)}" data-prefetch-type="tv" data-prefetch-tmdb="${escapeAttribute(row.tmdb_id || "")}" data-prefetch-title="${escapeAttribute(title)}" data-show-href="${escapeAttribute(href)}"`,
    explorerHref: href,
    menuHtml,
  }).replace(">Last Played:<", ">Dropped:<");
}

export function renderDroppedView(surface) {
  if (typeof document === "undefined" || state.mediaDetailInline) return;
  const original = surface === "history" ? elements.historyPanel : elements.explorerPanel;
  const toolbar = document.getElementById(surface === "history" ? "historyTopbarControls" : "explorerTopbarControls");
  if (!original || !toolbar) return;
  let view = views.get(surface);
  if (!view) {
    const label = document.createElement("label");
    // The library toggle matches Hide Fully Watched / Hide Ended and sits after them.
    const hideEnded = surface === "history" ? null : document.getElementById("explorerHideEndedLabel");
    if (hideEnded) {
      label.id = "explorerDroppedOnlyLabel";
      label.className = "compact-field explorer-hide-toggle";
      label.innerHTML = '<span>Dropped only</span><input type="checkbox" class="explorer-hide-checkbox" />';
    } else {
      label.className = "action-pill";
      label.innerHTML = '<input type="checkbox" /> <span>Dropped only</span>';
    }
    const panel = document.createElement("div");
    // The library panel shares the #explorerPanel card styles (styles.css).
    if (surface !== "history") { panel.id = "explorerDroppedPanel"; panel.className = "explorer-panel"; }
    panel.hidden = true;
    original.after(panel);
    if (hideEnded) hideEnded.after(label);
    else toolbar.append(label);
    view = { input: label.querySelector("input"), panel, original, request: 0 };
    views.set(surface, view);
    view.input.addEventListener("change", () => { renderDroppedView(surface); });
  }
  // Drop is for shows only, so the control is hidden on movie views.
  const movieView = surface === "history" ? state.historyViewFilter === "movies" : state.explorerMode === "movies";
  const control = view.input.closest("label");
  if (control) control.style.display = movieView ? "none" : "";
  if (movieView) view.input.checked = false;
  const active = view.input.checked;
  view.original.hidden = active;
  view.panel.hidden = !active;
  if (surface === "library") elements.alphaFilterNav?.classList.toggle("hidden", active);
  const request = ++view.request;
  if (!active) return;
  const type = surface === "history"
    ? ({ movies: "movie", shows: "show" }[state.historyViewFilter] || "all")
    : state.explorerMode === "shows" ? "show" : "movie";
  const search = surface === "history" ? state.historyViewSearch : elements.explorerSearchInput?.value || state.explorerSearch;
  // A refresh replaces every card; close a menu that still points at a removed card.
  closePosterOverflowMenu();
  view.panel.innerHTML = '<div class="empty-log" role="status">Loading dropped titles…</div>';
  void Promise.all([fetchDroppedTitles(), surface === "history" ? null : loadRouteModule("dashboard")]).then(([rows, dashboard]) => {
    if (request !== view.request || !view.input.checked) return;
    const items = filterDroppedTitles(rows, { type, search: search || "" });
    const card = (row) => (surface !== "history" && row.media_type === "show"
      ? renderDroppedShowCard(row, dashboard.renderDashboardHistoryPageCard)
      : renderMediaCard({ ...row.snapshot, ...row, media_type: row.media_type === "show" ? "tv" : "movie" }, { variant: "personal", meta: "Dropped" }));
    view.panel.innerHTML = items.length
      ? `<div class="${surface === "history" ? "personal-media-card-grid" : "movie-grid explorer-show-grid"}">${items.map(card).join("")}</div>`
      : '<div class="empty-log"><b>No dropped titles</b><span>Drop a title from its detail page to keep it out of Up Next.</span></div>';
    hydratePosters(view.panel);
  }).catch((error) => {
    if (request === view.request) view.panel.innerHTML = `<div class="empty-log" role="alert">${escapeHtml(error.message)}</div>`;
  });
}

// A drop or un-drop elsewhere (for example this view's own menu) refreshes an open Dropped-only list.
// An un-dropped card dissolving in the list is left to finish first.
if (typeof document !== "undefined") {
  document.addEventListener?.("plekt:dropped-titles-changed", () => {
    for (const [surface, view] of views) {
      if (!view.input.checked) continue;
      if (view.panel.querySelector(".dropped-card-scrub")) view.refreshPending = true;
      else renderDroppedView(surface);
    }
  });
  document.addEventListener?.("plekt:dropped-card-dissolved", () => {
    for (const [surface, view] of views) {
      if (!view.refreshPending) continue;
      if (view.panel.querySelector(".dropped-card-scrub")) continue;
      view.refreshPending = false;
      if (view.input.checked) renderDroppedView(surface);
    }
  });
}

export function renderDroppedStats() {
  if (typeof document === "undefined" || !elements.statsKpiStrip || !state.token) return;
  const current = ++revision;
  void fetchDroppedTitles().then((rows) => {
    if (current !== revision) return;
    const count = filterDroppedTitles(rows, { type: "show" }).length;
    elements.statsKpiStrip.querySelector("[data-dropped-stat]")?.remove();
    elements.statsKpiStrip.insertAdjacentHTML("beforeend", `<div class="stats-kpi-card" data-dropped-stat><span>Dropped</span><b>${count}</b><small>Current titles · all time</small></div>`);
  }).catch(() => {
    if (current === revision) {
      elements.statsKpiStrip.querySelector("[data-dropped-stat]")?.remove();
      elements.statsKpiStrip.insertAdjacentHTML("beforeend", '<div class="stats-kpi-card" data-dropped-stat><span>Dropped</span><b>—</b><small>Could not load</small></div>');
    }
  });
}
