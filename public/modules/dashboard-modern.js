import { episodeCode, escapeAttribute, escapeHtml, showName } from "./utils.js?v=2.1.0.0.4";
import { state } from "./state.js?v=2.1.0.0.4";
import { artKey, requestArtKey } from "./card-art.js?v=2.1.0.0.4";
import { THEME_STYLE_EVENT, isModernStyle } from "./appearance.js?v=2.1.0.0.4";
import { nowPlayingOptions } from "./now-playing-options.js?v=2.1.0.0.4";
// The same folded-poster behaviour on the Library and History pages.
import "./page-card-open.js?v=2.1.0.0.4";

// Dashboard behaviour added with the Modern theme style (plan/archive/theme-styles/plan.md).
// Compact rows, collapsed TV runs and the featured Up Next cards apply under
// both styles; backdrop artwork is Modern-only.

// --- Compact rows (both styles) --------------------------------------------
// The toggle beside each "Recently watched" title folds every card in that
// row into its poster (the details slide closed behind it). Clicking a
// folded poster opens that card in place, closing whichever was open; a
// further click behaves as normal. Clicking a folded stack (a collapsed run)
// expands the run with every card in it open, and it folds back into a stack
// when another card opens. The toggle is remembered per browser, per row.

const COMPACT_KEY_PREFIX = "plembfin:dashboard-compact:";
const COMPACT_ROW_IDS = { tv: "tvHistoryRow", movie: "movieHistoryRow" };
const compactRows = { tv: readCompactRow("tv"), movie: readCompactRow("movie") };
// Card keys, or run keys that open every card of an expanded run.
const openCompactCards = new Set();
// Runs expanded by opening their folded stack.
const compactExpandedRuns = new Set();

function compactCardKey(card) {
  const data = card?.dataset || {};
  return String(data.historyId || data.collapsedRunKey || data.partWatchedCardId || "");
}

function isCompactCardOpen(card) {
  const runKey = card.dataset?.runKey;
  return openCompactCards.has(compactCardKey(card)) || Boolean(runKey && openCompactCards.has(runKey));
}

function closeCompactCards() {
  openCompactCards.clear();
  const runs = [...compactExpandedRuns];
  compactExpandedRuns.clear();
  for (const key of runs) expandedRunKeys.delete(key);
  if (runs.length) rerenderRuns();
}

let holdToken = 0;

// Keeps the clicked poster where it is on screen while other cards fold and it
// opens: on every frame of the width transition the row is scrolled by however
// far the poster's left edge moved. Layout offsets, not bounding boxes, so the
// entrance motion of new cards does not count as movement.
function holdInPlace(row, findAnchor, left) {
  const token = ++holdToken;
  const until = performance.now() + 340;
  const step = () => {
    if (token !== holdToken) return;
    const anchor = findAnchor();
    if (anchor?.isConnected) {
      const delta = anchor.offsetLeft - row.scrollLeft - left;
      if (Math.abs(delta) >= 0.5) row.scrollLeft += delta;
    }
    if (performance.now() < until) requestAnimationFrame(step);
  };
  step();
}

function openCompactCard(card) {
  const runKey = card.dataset.collapsedRunKey;
  const key = compactCardKey(card);
  const row = card.parentElement;
  const left = card.offsetLeft - row.scrollLeft;
  // An expanded run's first card takes the place of the stack it came from.
  const findAnchor = () => runKey
    ? [...row.querySelectorAll("[data-run-key]")].find((item) => item.dataset.runKey === runKey)
    : compactRowCards().find((item) => compactCardKey(item) === key);
  closeCompactCards();
  if (runKey) {
    openCompactCards.add(runKey);
    compactExpandedRuns.add(runKey);
    setDashboardRunExpanded(runKey, true);
  } else {
    openCompactCards.add(key);
  }
  syncCompactOpenCards();
  holdInPlace(row, findAnchor, left);
}

function compactRowCards() {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return [];
  const rows = Object.keys(COMPACT_ROW_IDS).filter(isDashboardRowCompact).map((kind) => `#${COMPACT_ROW_IDS[kind]} > .dashboard-history-page-card`);
  return rows.length ? [...document.querySelectorAll(rows.join(", "))] : [];
}

// Re-applies the open state to cards a row re-render replaced.
function syncCompactOpenCards() {
  for (const card of compactRowCards()) {
    const open = isCompactCardOpen(card);
    if (card.classList.contains("dashboard-card-open") !== open) card.classList.toggle("dashboard-card-open", open);
  }
}

function readCompactRow(kind) {
  try {
    return localStorage.getItem(COMPACT_KEY_PREFIX + kind) === "1";
  } catch {
    return false;
  }
}

export function isDashboardRowCompact(kind) {
  return Boolean(compactRows[kind]);
}

export function setDashboardRowCompact(kind, compact) {
  if (!(kind in compactRows)) return;
  compactRows[kind] = Boolean(compact);
  closeCompactCards();
  try {
    if (compact) localStorage.setItem(COMPACT_KEY_PREFIX + kind, "1");
    else localStorage.removeItem(COMPACT_KEY_PREFIX + kind);
  } catch { /* storage unavailable: the choice lasts for this page only */ }
  syncCompactControls();
  // Runs collapse only while the TV row is posters-only.
  if (kind === "tv") rerenderRuns();
  syncCompactOpenCards();
}

function syncCompactControls() {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  for (const button of document.querySelectorAll("[data-dashboard-compact]")) {
    const compact = isDashboardRowCompact(button.dataset.dashboardCompact);
    button.setAttribute("aria-pressed", String(compact));
    button.title = compact ? "Show full cards" : "Posters only";
    button.closest(".dashboard-history-panel")?.classList.toggle("dashboard-row-compact", compact);
  }
}

// --- Collapsed runs in the TV history row ---------------------------------
// While the TV row is posters-only, consecutive watches of the same show
// collapse into one poster for the newest episode, carrying an episode counter.
// Clicking it expands the run back into one card per episode, in place. With
// full cards on, every episode keeps its own card and nothing collapses.
// One run is open at a time: expanding another folds it back, and so does
// another card opening; otherwise it lasts until a reload.

const expandedRunKeys = new Set();
const runRerenders = new Set();

function rerenderRuns() {
  for (const rerender of runRerenders) rerender();
}

function runShowKey(entry = {}) {
  if (entry.isPartWatched || entry.part_watched || entry.up_next || entry.media_type === "movie") return "";
  const id = entry.show_tmdb_id || entry.show_tvdb_id;
  if (id) return `id:${id}`;
  const title = String(entry.show_title || showName(entry.title) || "").trim().toLowerCase();
  return title ? `title:${title}` : "";
}

// Returns the row as units, newest first. A collapsed run is one unit with a
// `key`; an expanded run gives one unit per entry, each carrying the run's
// key as `runKey`. Runs form under both styles, in posters-only mode only.
export function dashboardTvRowUnits(items = []) {
  if (!isDashboardRowCompact("tv")) return items.map((entry) => ({ entries: [entry] }));
  const runs = [];
  for (const entry of items) {
    const show = runShowKey(entry);
    const last = runs.at(-1);
    if (last && show && last.show === show) last.entries.push(entry);
    else runs.push({ show, entries: [entry] });
  }
  return runs.flatMap((run) => {
    if (run.entries.length < 2) return [{ entries: run.entries }];
    const key = `run:${run.show}:${run.entries.at(-1).id ?? ""}`;
    if (!expandedRunKeys.has(key)) return [{ key, entries: run.entries }];
    return run.entries.map((entry) => ({ entries: [entry], expanded: true, runKey: key }));
  });
}

// Only one run is open at a time: expanding a run folds any other back.
export function setDashboardRunExpanded(key, expanded) {
  if (!key) return;
  if (expanded) {
    expandedRunKeys.clear();
    expandedRunKeys.add(key);
  } else {
    expandedRunKeys.delete(key);
  }
  rerenderRuns();
}

function runTitle(entry) {
  return entry.show_title || showName(entry.title) || "this show";
}

function renderedCard(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

// renderCard renders one entry as the usual dashboard history card. A run
// reuses the newest entry's card, swapping its link wrapper for an expand
// control and showing the episode range and count.
export function renderDashboardTvRowUnit(unit, renderCard) {
  const html = renderCard(unit.entries[0]);
  if (!unit.key && !unit.expanded) return html;
  const source = renderedCard(html);
  if (!source) return html;

  if (unit.expanded) {
    source.classList.add("dashboard-run-expanded");
    if (unit.runKey) source.dataset.runKey = unit.runKey;
    return source.outerHTML;
  }

  const newest = unit.entries[0];
  const oldest = unit.entries.at(-1);
  const count = unit.entries.length;
  const card = document.createElement("article");
  card.className = `${source.className} dashboard-collapsed-run-card`;
  if (source.dataset.art) card.dataset.art = source.dataset.art;
  card.dataset.collapsedRunKey = unit.key;
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-expanded", "false");
  card.setAttribute("aria-label", `Show all ${count} episodes of ${runTitle(newest)}`);
  card.innerHTML = source.innerHTML;

  const range = card.querySelector(".history-card-meta-row .meta-value");
  if (range) range.textContent = `${episodeCode(oldest.season, oldest.episode)} - ${episodeCode(newest.season, newest.episode)}`;
  card.querySelector(".history-card-header")
    ?.insertAdjacentHTML("beforeend", `<span class="dashboard-run-count">${escapeHtml(`${count} episodes`)}</span>`);
  // A counter on the poster, so a folded (posters-only) card still shows it.
  card.querySelector(".history-card-poster-wrapper")
    ?.insertAdjacentHTML("beforeend", `<span class="dashboard-run-badge" aria-hidden="true">${count} eps</span>`);
  return card.outerHTML;
}

// Registers a view that renders runs, re-run when a run expands or collapses
// or the theme style changes.
export function bindDashboardRuns(rerender) {
  runRerenders.add(rerender);
}

const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";

if (hasDocument) {
  syncCompactControls();

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-dashboard-compact]");
    if (!button) return;
    const kind = button.dataset.dashboardCompact;
    setDashboardRowCompact(kind, !isDashboardRowCompact(kind));
  });

  // Capture phase: a folded card is a link (or holds one), so the first
  // click must open it before the router or the run handler sees it.
  document.addEventListener("click", (event) => {
    const card = event.target.closest?.(".dashboard-row-compact .dashboard-history-page-card:not(.dashboard-card-open)");
    if (!card || !compactRowCards().includes(card) || event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    openCompactCard(card);
  }, true);

  document.addEventListener("click", (event) => {
    const card = event.target.closest?.("[data-collapsed-run-key]");
    if (!card || event.target.closest("button, a")) return;
    event.preventDefault();
    setDashboardRunExpanded(card.dataset.collapsedRunKey, true);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.matches?.("[data-collapsed-run-key]") ? event.target : null;
    if (!card) return;
    event.preventDefault();
    setDashboardRunExpanded(card.dataset.collapsedRunKey, true);
  });

  // Arriving on a page, including a menu click on the page already open,
  // shows it fresh: open posters fold and expanded runs stack back up.
  document.addEventListener("plembfin:page-entry", () => {
    holdToken += 1;
    openCompactCards.clear();
    compactExpandedRuns.clear();
    if (expandedRunKeys.size) {
      expandedRunKeys.clear();
      rerenderRuns();
    }
    syncCompactOpenCards();
  });
}

// --- Backdrop artwork behind the cards -------------------------------------
// Card backdrops are loaded by modules/card-art.js on every page; live
// session cards get their key here, from the session they show.

function sessionArtKey(session = {}) {
  const isEpisode = session.mediaType === "episode" || (session.season != null && session.episode != null);
  const ids = session.ids || {};
  const idParts = {
    tmdb: ids.tmdb || session.tmdb_id || session.tmdbId,
    tvdb: ids.tvdb || session.tvdb_id || session.tvdbId,
    imdb: ids.imdb || session.imdb_id || session.imdbId,
  };
  if (!isEpisode) return artKey("movie", { ...idParts, title: session.title });
  const showTitle = session.showTitle || showName(session.title);
  // A playing episode takes its own still; card-art.js falls back to the show's
  // backdrop when the episode has none.
  const season = Number(session.season);
  const episode = Number(session.episode);
  if (session.season != null && session.episode != null && Number.isInteger(season) && Number.isInteger(episode)) {
    return artKey("episode", { ...idParts, title: `${season}x${episode} ${showTitle}` });
  }
  return artKey("tv", { ...idParts, title: showTitle });
}

// --- Now Playing -----------------------------------------------------------
// The section heading is hidden under Modern. While nothing plays, sync.js
// renders an .idle-state placeholder in #nowPlayingGrid; under both styles,
// features built from the first two Up Next cards are added beside it (CSS
// hides the placeholder and those cards in the Up Next rail; only the backdrop
// and shade are Modern's). sync.js removes every non-session
// child when playback starts, which drops the features and returns the cards
// to the rail; the live session cards take the same look, side by side.

const timelineView = hasDocument ? document.querySelector?.("#timeline-view") : null;
const nowPlayingGrid = hasDocument ? document.querySelector?.("#nowPlayingGrid") : null;
const upNextPanel = hasDocument ? document.querySelector?.("#upNextPanel") : null;
let featuredSourceHtml = "";
let syncFrame = 0;

// Rail cards copied into the panel carry data-featured-in-panel, which
// styles-modern.css hides in the rail. The attribute is outside the observer's
// filter, so marking cards does not schedule another pass.
function markFeaturedSources(sources = []) {
  const featured = new Set(sources);
  upNextPanel?.querySelectorAll(":scope > [data-featured-in-panel]").forEach((card) => {
    if (!featured.has(card)) card.removeAttribute("data-featured-in-panel");
  });
  for (const card of featured) {
    if (!card.hasAttribute("data-featured-in-panel")) card.setAttribute("data-featured-in-panel", "");
  }
}

function removeIdleFeature() {
  nowPlayingGrid?.querySelectorAll(".modern-idle-feature").forEach((feature) => feature.remove());
  featuredSourceHtml = "";
  markFeaturedSources();
}

// The feature is a copy of the Up Next card itself, in a card-row wrapper so
// the normal card styles apply; only its width and backdrop differ. Its
// buttons carry the card's own data attributes, so the document-level Up Next
// and poster-menu handlers act on it as they would in the rail.
function buildIdleFeature(source) {
  const feature = document.createElement("div");
  feature.className = "dashboard-history-card-row modern-idle-feature";
  feature.append(source.cloneNode(true));
  return feature;
}

// The Now Playing heading names what the panel holds: "Up Next" while it
// features Up Next cards (CSS then hides the rail's own title).
function syncNowPlayingHeading() {
  const heading = nowPlayingGrid?.closest(".live-panel")?.querySelector(".section-heading h2");
  const idleFeatured = nowPlayingGrid?.querySelector(".modern-idle-feature") && !nowPlayingGrid.querySelector("[data-now-playing-card-id]");
  const text = idleFeatured ? "Up Next" : "Now Playing";
  if (heading && heading.textContent !== text) heading.textContent = text;
}

function syncIdleFeature() {
  syncIdleFeatureCard();
  syncNowPlayingHeading();
}

function syncIdleFeatureCard() {
  if (!nowPlayingGrid) return;
  const options = nowPlayingOptions();
  const liveCount = nowPlayingGrid.querySelectorAll(":scope > [data-now-playing-card-id]").length;
  // Live sessions come first; the slots they leave take the rail's part
  // watched (resume) cards, then its Up Next cards, each only when allowed.
  // The same cards are hidden from the rail.
  const slots = Math.max(0, options.itemCount - liveCount);
  const railCards = [...(upNextPanel?.querySelectorAll(":scope > [data-up-next-card-id]") || [])];
  const isResume = (card) => card.getAttribute("data-up-next-queue-kind") === "resume";
  const sources = [
    ...(options.allowPartWatched ? railCards.filter(isResume) : []),
    ...(options.allowUpNext ? railCards.filter((card) => !isResume(card)) : []),
  ].slice(0, slots);
  if (!sources.length) {
    removeIdleFeature();
    return;
  }
  markFeaturedSources(sources);
  // Compare without the marker so marking a card does not rebuild the copies.
  const sourceHtml = sources.map((source) => source.outerHTML.replace(/ data-featured-in-panel=""/, "")).join("");
  if (nowPlayingGrid.querySelector(".modern-idle-feature") && featuredSourceHtml === sourceHtml) return;
  nowPlayingGrid.querySelectorAll(".modern-idle-feature").forEach((feature) => feature.remove());
  featuredSourceHtml = sourceHtml;
  nowPlayingGrid.append(...sources.map(buildIdleFeature));
  nowPlayingGrid.querySelectorAll(".modern-idle-feature [data-featured-in-panel]").forEach((copy) => copy.removeAttribute("data-featured-in-panel"));
}

// Live cards are rendered by sync.js in state.activeSessions order.
function tagLiveCards() {
  if (!nowPlayingGrid) return;
  const cards = nowPlayingGrid.querySelectorAll(":scope > [data-now-playing-card-id]");
  cards.forEach((card, index) => {
    const key = sessionArtKey(state.activeSessions?.[index]);
    if (key && card.getAttribute("data-art") !== key) card.setAttribute("data-art", key);
  });
}

// The main area takes the backdrop of the top item: the feature while idle,
// otherwise the first live session.
function syncPageArt() {
  const pageShell = timelineView?.closest(".page-shell");
  if (!pageShell) return;
  const key = isModernStyle() ? nowPlayingGrid?.querySelector("[data-art]")?.getAttribute("data-art") || "" : "";
  if (key) {
    // The featured backdrop spans the page, even when its source card is below view.
    requestArtKey(key);
    if (pageShell.getAttribute("data-page-art") !== key) pageShell.setAttribute("data-page-art", key);
  } else if (pageShell.hasAttribute("data-page-art")) {
    pageShell.removeAttribute("data-page-art");
  }
}

function syncModernDashboard() {
  syncFrame = 0;
  syncIdleFeature();
  syncCompactOpenCards();
  if (isModernStyle() && timelineView) {
    tagLiveCards();
  }
  syncPageArt();
}

function scheduleModernSync() {
  if (!syncFrame) syncFrame = requestAnimationFrame(syncModernDashboard);
}

if (timelineView) {
  // Every change is coalesced into one pass per frame, and that pass only
  // writes when something differs, so its own writes settle immediately.
  new MutationObserver(scheduleModernSync).observe(timelineView, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  scheduleModernSync();
}

if (hasDocument) {
  document.addEventListener("plembfin:config-changed", scheduleModernSync);
  document.addEventListener(THEME_STYLE_EVENT, () => {
    rerenderRuns();
    scheduleModernSync();
  });
}
