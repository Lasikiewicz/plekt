import { buildAuthHeaders } from "./auth.js?v=2.1.0.0.5";
import { state, elements } from "./state.js?v=2.1.0.0.5";
import { escapeHtml, escapeAttribute, tvShowTmdbHref } from "./utils.js?v=2.1.0.0.5";
import { posterMarkup, hydratePosters } from "./images.js?v=2.1.0.0.5";

let _cb = {};

const UPCOMING_SEARCH_MIN_CHARS = 1;
const UPCOMING_SEARCH_WINDOW_MONTHS = 12;
const UPCOMING_SEARCH_DEBOUNCE_MS = 220;
// The calendar renders one block per month. A small buffer either side of the
// current month is loaded up front so the page opens with somewhere to scroll
// in both directions; scrolling near either end grows the range further.
const UPCOMING_INITIAL_PAST_MONTHS = 1;
const UPCOMING_INITIAL_FUTURE_MONTHS = 1;
// How close to either end of the scroll container the user must get before the
// next month is appended/prepended.
const UPCOMING_EXTEND_THRESHOLD_PX = 400;
// How long after a programmatic jump to keep ignoring scroll events, so the
// jump's own scrolling is never mistaken for the user browsing.
const UPCOMING_ANCHOR_HOLD_MS = 250;
// Most months a jump may append below its target to make room to raise it to
// the top of the page.
const UPCOMING_ANCHOR_FILL_PASSES = 6;

let upcomingSearchTimer = undefined;
let upcomingSearchRequestId = 0;
const upcomingBackgroundLoads = new Map();
// Selector of the element that must stay pinned to the top of the viewport
// across re-renders. Set while opening the page or jumping to a month, so the
// anchor survives the re-render that lands when episode data arrives.
let pendingAnchorSelector = "";
// Timestamp until which scroll events belong to a jump rather than the user.
let anchorHoldUntil = 0;
let upcomingScrollScheduled = false;

export function initUpcoming(callbacks) {
  _cb = callbacks;
  elements.upcomingPrevButton?.addEventListener("click", () => shiftUpcomingMonth(-1));
  elements.upcomingNextButton?.addEventListener("click", () => shiftUpcomingMonth(1));
  elements.upcomingTodayButton?.addEventListener("click", () => goToToday());
  elements.upcomingSearchInput?.addEventListener("input", () => {
    state.upcomingSearch = elements.upcomingSearchInput.value || "";
    renderUpcoming();
    scheduleUpcomingSearchWindow();
  });
  elements.upcomingCalendar?.addEventListener("click", (event) => {
    const entry = event.target.closest("[data-upcoming-tmdb], [data-upcoming-show]");
    if (!entry) return;
    const tmdbId = entry.dataset.upcomingTmdb || "";
    const showId = entry.dataset.upcomingShow || "";
    if (tmdbId) _cb.navigateTo?.(tvShowTmdbHref(tmdbId, entry.dataset.upcomingTitle));
    else if (showId) _cb.navigateTo?.(`/tvshow/${encodeURIComponent(showId)}`);
  });
  // The page-shell is the app's scroll container - body itself never scrolls.
  // One handler drives poster hydration, the visible-month title, and the
  // range growth in both directions.
  scrollContainerEl()?.addEventListener("scroll", handleUpcomingScroll, { passive: true });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function scrollContainerEl() {
  return document.querySelector(".page-shell");
}

function isoFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromIso(dayIso) {
  const [year, month, day] = dayIso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function todayIsoDate() {
  return isoFromDate(new Date());
}

function currentMonth() {
  return todayIsoDate().slice(0, 7);
}

function addDays(dayIso, delta) {
  const date = dateFromIso(dayIso);
  date.setDate(date.getDate() + delta);
  return isoFromDate(date);
}

// Monday of the week containing the given day.
function weekStartOf(dayIso) {
  const date = dateFromIso(dayIso);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return isoFromDate(date);
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

function startOfMonthIso(monthKey) {
  return `${monthKey}-01`;
}

function endOfMonthIso(monthKey) {
  const [year, monthNumber] = monthKey.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

function activeMonth() {
  if (!/^\d{4}-\d{2}$/.test(state.upcomingMonth || "")) state.upcomingMonth = currentMonth();
  return state.upcomingMonth;
}

function monthKeysInRange(startIso, endIso) {
  const keys = [];
  let [y, m] = startIso.slice(0, 7).split("-").map(Number);
  const [ey, em] = endIso.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return keys;
}

function resetUpcomingRange(monthKey) {
  state.upcomingRangeStart = startOfMonthIso(addMonths(monthKey, -UPCOMING_INITIAL_PAST_MONTHS));
  state.upcomingRangeEnd = endOfMonthIso(addMonths(monthKey, UPCOMING_INITIAL_FUTURE_MONTHS));
}

function ensureUpcomingRange() {
  const start = state.upcomingRangeStart;
  const end = state.upcomingRangeEnd;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start || "") && /^\d{4}-\d{2}-\d{2}$/.test(end || "") && start < end) return;
  resetUpcomingRange(currentMonth());
}

function extendRangePast() {
  const nextMonth = addMonths(state.upcomingRangeStart.slice(0, 7), -1);
  state.upcomingRangeStart = startOfMonthIso(nextMonth);
  return true;
}

function extendRangeFuture() {
  const nextMonth = addMonths(state.upcomingRangeEnd.slice(0, 7), 1);
  state.upcomingRangeEnd = endOfMonthIso(nextMonth);
  return true;
}

function ensureRangeCoversMonth(monthKey) {
  ensureUpcomingRange();
  while (monthKey < state.upcomingRangeStart.slice(0, 7)) extendRangePast();
  while (monthKey > state.upcomingRangeEnd.slice(0, 7)) extendRangeFuture();
}

// The Monday of every week a month's grid needs, including the partial weeks at
// each end that carry blank cells for the neighbouring months.
function weekStartsInMonth(monthKey) {
  const starts = [];
  let cursor = weekStartOf(startOfMonthIso(monthKey));
  const lastWeek = weekStartOf(endOfMonthIso(monthKey));
  while (cursor <= lastWeek) {
    starts.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return starts;
}

// A straddling week appears in both months' grids, so the week alone does not
// identify a row - the owning month is part of the key.
function weekRowSelector(dayIso) {
  return `[data-month="${dayIso.slice(0, 7)}"][data-week="${weekStartOf(dayIso)}"]`;
}

// Re-applies the pending scroll anchor after a render. Episode data arrives
// after the first paint, so without this the row the user asked for would
// drift as empty day cells fill in.
function applyPendingAnchor() {
  if (!pendingAnchorSelector) return;
  elements.upcomingCalendar?.querySelector(pendingAnchorSelector)
    ?.scrollIntoView({ block: "start", behavior: "auto" });
}

// `scrollIntoView` can only lift the anchor as far as the bottom of the scroll
// range allows. When the target is the last month loaded there is nothing below
// it to scroll against, so it comes to rest partway down the page instead of at
// the top. Add months underneath until the page is tall enough to raise it.
function fillBelowAnchor() {
  const root = scrollContainerEl();
  if (!root || !pendingAnchorSelector) return;
  // The search view has no calendar to anchor against, so there is nothing to
  // make room for - growing the range would just fetch months for nothing.
  if (normalizeUpcomingSearch(state.upcomingSearch)) return;
  for (let pass = 0; pass < UPCOMING_ANCHOR_FILL_PASSES; pass += 1) {
    if (root.scrollTop < root.scrollHeight - root.clientHeight - 1) return;
    if (!extendRangeFuture()) return;
    renderUpcoming();
  }
}

async function anchorTo(selector, { revalidateMonth = "" } = {}) {
  pendingAnchorSelector = selector;
  renderUpcoming();
  // The title normally tracks scrolling, but nothing has scrolled yet - name
  // the target month up front so it is correct while episode data loads.
  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = monthTitle(activeMonth());
  applyPendingAnchor();
  // Runs before loading so the months it adds are fetched by the same pass.
  fillBelowAnchor();
  try {
    await loadUpcoming({ revalidateMonth });
  } catch (error) {
    _cb.setMessage?.(error.message, "error");
  }
  applyPendingAnchor();
  pendingAnchorSelector = "";
  // Scroll events are delivered asynchronously, so the ones this jump just
  // generated are still queued. Ignore them for a beat, otherwise the first one
  // reads the month straight back off the viewport and undoes the step.
  anchorHoldUntil = Date.now() + UPCOMING_ANCHOR_HOLD_MS;
}

// Month stepping jumps straight to the target heading rather than animating -
// an animated scroll keeps firing scroll events after the jump is considered
// finished, and those would reset the active month to whatever it passed over.
function scrollToMonth(monthKey) {
  state.upcomingMonth = monthKey;
  ensureRangeCoversMonth(monthKey);
  return anchorTo(`[data-month-heading="${monthKey}"]`);
}

function scrollToWeekOf(dayIso, options = {}) {
  state.upcomingMonth = dayIso.slice(0, 7);
  ensureRangeCoversMonth(state.upcomingMonth);
  return anchorTo(weekRowSelector(dayIso), options);
}

function scrollToToday(options = {}) {
  const today = todayIsoDate();
  const isMobile = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 760px)").matches;
  if (isMobile) {
    state.upcomingMonth = today.slice(0, 7);
    ensureRangeCoversMonth(state.upcomingMonth);
    return anchorTo(`[data-day="${today}"]`, options);
  }
  return scrollToWeekOf(today, options);
}

function shiftUpcomingMonth(delta) {
  scrollToMonth(addMonths(activeMonth(), delta));
}

function goToToday() {
  scrollToToday();
}

// Called whenever the Upcoming page is navigated to, so it always opens with
// today visible rather than wherever a prior visit's scroll position landed.
// Desktop anchors the containing week; mobile anchors the actual day card so
// an empty today still appears first in the agenda.
export function openUpcomingToToday() {
  const month = currentMonth();
  state.upcomingMonth = month;
  resetUpcomingRange(month);
  return scrollToToday({ revalidateMonth: month });
}

function handleUpcomingScroll() {
  if (state.activeView !== "upcoming" || upcomingScrollScheduled) return;
  upcomingScrollScheduled = true;
  window.requestAnimationFrame(() => {
    upcomingScrollScheduled = false;
    hydratePosters(elements.upcomingCalendar);
    if (normalizeUpcomingSearch(state.upcomingSearch)) return;
    // This scroll came from a jump, not the user: either one is still mid-flight
    // or its queued scroll events are only now being delivered. The target month
    // is already in `state.upcomingMonth` - reading it back off the viewport here
    // would replace it with wherever the scroll sits and leave the arrows
    // stepping from that month instead of the one just selected.
    if (pendingAnchorSelector || Date.now() < anchorHoldUntil) return;
    syncVisibleMonthTitle();
    extendRangeForScrollPosition();
  });
}

function extendRangeForScrollPosition() {
  const root = scrollContainerEl();
  if (!root) return;
  const distanceFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;

  if (root.scrollTop < UPCOMING_EXTEND_THRESHOLD_PX) {
    const previousHeight = root.scrollHeight;
    const previousTop = root.scrollTop;
    if (!extendRangePast()) return;
    renderUpcoming();
    // Prepending a month pushes everything down; offset the scroll position by
    // the height that was inserted so the view stays where the user left it.
    root.scrollTop = previousTop + (root.scrollHeight - previousHeight);
    syncVisibleMonthTitle();
  } else if (distanceFromBottom < UPCOMING_EXTEND_THRESHOLD_PX) {
    if (!extendRangeFuture()) return;
    renderUpcoming();
  } else {
    return;
  }
  loadUpcoming().catch((error) => _cb.setMessage?.(error.message, "error"));
}

// Keeps the topbar title describing whichever month the user has scrolled to.
// The active month is the one whose heading is currently pinned, not the first
// row that still pokes above the fold: after jumping to a heading, the previous
// month's last row is left overlapping the top edge by the heading's offset, and
// treating that as the active month made the arrows step from the month behind
// the one on screen.
function syncVisibleMonthTitle() {
  const container = elements.upcomingCalendar;
  if (!container || !elements.upcomingMonthTitle) return;
  const topbar = document.querySelector(".page-topbar");
  const contentTop = topbar ? topbar.getBoundingClientRect().bottom : 0;

  const headings = container.querySelectorAll("[data-month-heading]");
  let visibleMonth = "";
  for (const heading of headings) {
    const rect = heading.getBoundingClientRect();
    // Headings run top to bottom, so the last one still pinned near the topbar
    // owns the viewport. Once a heading sits a full heading-height lower it
    // belongs to a month further down the page.
    if (rect.top > contentTop + rect.height) break;
    visibleMonth = heading.dataset.monthHeading || visibleMonth;
  }
  // Scrolled above the first heading - that month is the one on screen.
  if (!visibleMonth) visibleMonth = headings[0]?.dataset.monthHeading || "";
  if (!visibleMonth) return;

  state.upcomingMonth = visibleMonth;
  elements.upcomingMonthTitle.textContent = monthTitle(visibleMonth);
}

// `revalidateMonth` refetches a single month even when it is already held in
// client state, and asks the server to refresh that month in the background.
// Only the current month is worth revalidating on open - doing it for the whole
// range would turn every page visit into a burst of requests.
export async function loadUpcoming({ revalidateMonth = "" } = {}) {
  ensureUpcomingRange();
  if (state.upcomingLoadingMonth) return;

  let staleMonth = revalidateMonth;
  // The range can grow while a fetch is in flight, so keep going until every
  // month currently on screen has data.
  for (;;) {
    const monthsToFetch = monthKeysInRange(state.upcomingRangeStart, state.upcomingRangeEnd)
      .filter((m) => m === staleMonth || !state.upcomingByMonth.has(m));
    if (!monthsToFetch.length) break;

    state.upcomingLoadingMonth = monthsToFetch[0];
    renderUpcoming();
    try {
      // Fetched in parallel and rendered as each month lands, so the calendar
      // fills in as soon as the server answers instead of after the slowest
      // month in the batch.
      await Promise.all(monthsToFetch.map(async (month) => {
        // The current month is revalidated server-side in the background: the
        // response is the cached month, and the rebuild happens behind it.
        const query = month === staleMonth ? "&revalidate=1" : "";
        const response = await fetch(`/api/upcoming?month=${encodeURIComponent(month)}${query}`, { headers: authHeaders() });
        if (!response.ok) throw new Error("Failed to load upcoming episodes");
        const payload = await response.json();
        state.upcomingByMonth.set(month, Array.isArray(payload.episodes) ? payload.episodes : []);
        renderUpcoming();
      }));
    } finally {
      state.upcomingLoadingMonth = "";
      renderUpcoming();
    }
    staleMonth = "";
  }
}

async function fetchUpcomingMonth(month) {
  if (state.upcomingByMonth.has(month)) return;
  if (upcomingBackgroundLoads.has(month)) return upcomingBackgroundLoads.get(month);
  const promise = fetch(`/api/upcoming?month=${encodeURIComponent(month)}`, { headers: authHeaders() })
    .then((response) => {
      if (!response.ok) throw new Error("Failed to load upcoming episodes");
      return response.json();
    })
    .then((payload) => {
      state.upcomingByMonth.set(month, Array.isArray(payload.episodes) ? payload.episodes : []);
    })
    .finally(() => {
      upcomingBackgroundLoads.delete(month);
    });
  upcomingBackgroundLoads.set(month, promise);
  return promise;
}

function searchWindowMonths(anchorMonth) {
  return Array.from({ length: UPCOMING_SEARCH_WINDOW_MONTHS }, (_, index) => addMonths(anchorMonth, index));
}

function shouldLoadSearchWindow() {
  return normalizeUpcomingSearch(state.upcomingSearch).length >= UPCOMING_SEARCH_MIN_CHARS;
}

function scheduleUpcomingSearchWindow() {
  window.clearTimeout(upcomingSearchTimer);
  if (!shouldLoadSearchWindow()) {
    upcomingSearchRequestId += 1;
    state.upcomingSearchLoading = false;
    renderUpcoming();
    return;
  }
  upcomingSearchTimer = window.setTimeout(() => {
    loadUpcomingSearchWindow().catch((error) => {
      renderUpcoming();
      _cb.setMessage?.(error.message, "error");
    });
  }, UPCOMING_SEARCH_DEBOUNCE_MS);
}

async function loadUpcomingSearchWindow() {
  const requestId = upcomingSearchRequestId + 1;
  upcomingSearchRequestId = requestId;
  const months = searchWindowMonths(activeMonth());
  const missingMonths = months.filter((month) => !state.upcomingByMonth.has(month));
  if (!missingMonths.length) {
    state.upcomingSearchLoading = false;
    renderUpcoming();
    return;
  }
  state.upcomingSearchLoading = true;
  renderUpcoming();
  try {
    for (const month of missingMonths) {
      if (requestId !== upcomingSearchRequestId || !shouldLoadSearchWindow()) return;
      await fetchUpcomingMonth(month);
    }
  } finally {
    if (requestId === upcomingSearchRequestId) state.upcomingSearchLoading = false;
  }
  if (requestId !== upcomingSearchRequestId) return;
  renderUpcoming();
}

function monthTitle(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1, 1);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function normalizeUpcomingSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function episodeCode(episode) {
  return `S${episode.season}E${episode.episode}`;
}

function filterUpcomingEpisodes(episodes = [], query = "") {
  const normalizedQuery = normalizeUpcomingSearch(query);
  if (!normalizedQuery) return episodes;
  return episodes.filter((episode) => {
    const searchable = [
      episode.showTitle,
      episode.episodeTitle,
      episodeCode(episode),
      `season ${episode.season}`,
      `episode ${episode.episode}`,
    ].join(" ").toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

function entryMarkup(episode) {
  const code = episodeCode(episode);
  const tooltipParts = [episode.showTitle, code];
  if (episode.episodeTitle) tooltipParts.push(episode.episodeTitle);
  const posterItem = {
    media_type: "episode",
    season: episode.season,
    poster_url: episode.posterUrl || "",
    season_poster_url: episode.seasonPosterUrl || "",
    title: episode.showTitle || "",
  };
  // The representative episode's watch-record id lets the standard poster
  // pipeline (/api/poster + hydratePosters) resolve cached artwork.
  if (episode.posterRecordId) posterItem.id = episode.posterRecordId;
  return `
    <button class="upcoming-entry" type="button"
      data-upcoming-tmdb="${escapeAttribute(episode.tmdbId || "")}"
      data-upcoming-show="${escapeAttribute(episode.showId || "")}"
      data-upcoming-title="${escapeAttribute(episode.showTitle || "")}"
      title="${escapeAttribute(tooltipParts.join(" - "))}">
      <span class="upcoming-entry-poster-wrap">
        ${posterMarkup(posterItem, "upcoming-entry-poster")}
      </span>
      <span class="upcoming-entry-text">
        <span class="upcoming-entry-title">${escapeHtml(episode.showTitle || "Unknown show")}</span>
        <span class="upcoming-entry-meta">
          <span class="upcoming-entry-code">${escapeHtml(code)}</span>
          ${episode.episodeTitle ? `<span class="upcoming-entry-episode">${escapeHtml(episode.episodeTitle)}</span>` : ""}
        </span>
      </span>
    </button>`;
}

// Episodes are indexed by day once per render instead of re-scanning each
// month's list for every cell.
function episodesByDayInRange() {
  const byDay = new Map();
  for (const monthKey of monthKeysInRange(state.upcomingRangeStart, state.upcomingRangeEnd)) {
    for (const episode of state.upcomingByMonth.get(monthKey) || []) {
      const dayIso = String(episode.airDate || "").slice(0, 10);
      if (!dayIso) continue;
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso).push(episode);
    }
  }
  return byDay;
}

function dayCellMarkup(dayIso, episodes, todayIso) {
  const date = dateFromIso(dayIso);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);

  const classes = ["upcoming-week-day"];
  if (dayIso === todayIso) classes.push("is-today");
  if (dayIso < todayIso) classes.push("is-past");
  if (!episodes.length) classes.push("is-empty");

  return `
    <div class="${classes.join(" ")}" data-day="${dayIso}">
      <div class="upcoming-week-day-head">
        <span class="upcoming-week-day-weekday">${escapeHtml(weekday)}</span>
        <span class="upcoming-week-day-number">${date.getDate()}</span>
      </div>
      <div class="upcoming-week-day-entries">${episodes.map(entryMarkup).join("")}</div>
    </div>`;
}

function renderMonthGridView() {
  const container = elements.upcomingCalendar;
  if (!container) return;

  ensureUpcomingRange();

  const todayIso = todayIsoDate();
  const byDay = episodesByDayInRange();

  const blocks = monthKeysInRange(state.upcomingRangeStart, state.upcomingRangeEnd).map((monthKey) => {
    const rows = weekStartsInMonth(monthKey).map((weekStart) => {
      const cells = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const dayIso = addDays(weekStart, offset);
        // Days belonging to a neighbouring month stay blank here so they only
        // ever appear under their own month heading.
        if (dayIso.slice(0, 7) !== monthKey) {
          cells.push(`<div class="upcoming-week-day is-outside" aria-hidden="true"></div>`);
          continue;
        }
        cells.push(dayCellMarkup(dayIso, byDay.get(dayIso) || [], todayIso));
      }
      return `<div class="upcoming-week-row" data-week="${weekStart}" data-month="${monthKey}">${cells.join("")}</div>`;
    });

    return `
      <div class="upcoming-month-block">
        <div class="upcoming-month-heading" data-month-heading="${monthKey}">${escapeHtml(monthTitle(monthKey))}</div>
        <div class="upcoming-month-grid">${rows.join("")}</div>
      </div>`;
  });

  const root = scrollContainerEl();
  const previousTop = root ? root.scrollTop : 0;

  container.innerHTML = blocks.join("");

  // Replacing the calendar's markup empties the scroller for an instant, which
  // collapses its scroll position. Every render that is not about to reposition
  // deliberately has to put it back, or a background month load drops the user
  // back at the top of the range.
  if (root && !pendingAnchorSelector && root.scrollTop !== previousTop) root.scrollTop = previousTop;

  hydratePosters(container);
  applyPendingAnchor();
  if (!pendingAnchorSelector) syncVisibleMonthTitle();
}

function renderSearchResultsView(searchQuery) {
  const container = elements.upcomingCalendar;
  if (!container) return;

  if (elements.upcomingMonthTitle) elements.upcomingMonthTitle.textContent = "Search results";

  const todayIso = todayIsoDate();
  const monthKeys = Array.from(state.upcomingByMonth.keys()).sort();

  let lastMonthKey = "";
  let totalMatches = 0;
  const parts = [];
  for (const monthKey of monthKeys) {
    const monthEpisodes = state.upcomingByMonth.get(monthKey) || [];
    const matches = filterUpcomingEpisodes(monthEpisodes, searchQuery);
    if (!matches.length) continue;

    const byDay = new Map();
    for (const episode of matches) {
      const dayIso = String(episode.airDate || "").slice(0, 10);
      if (!dayIso) continue;
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso).push(episode);
    }
    const dayIsos = Array.from(byDay.keys()).sort();
    if (!dayIsos.length) continue;

    if (monthKey !== lastMonthKey) {
      lastMonthKey = monthKey;
      parts.push(`<div class="upcoming-month-heading">${escapeHtml(monthTitle(monthKey))}</div>`);
    }

    for (const dayIso of dayIsos) {
      const dayEpisodes = byDay.get(dayIso);
      totalMatches += dayEpisodes.length;
      parts.push(dayCellMarkup(dayIso, dayEpisodes, todayIso));
    }
  }

  const statusMessage = !totalMatches
    ? `<p class="upcoming-status">${state.upcomingSearchLoading
      ? "Searching upcoming episodes..."
      : `No episodes match "${escapeHtml(searchQuery.trim())}".`}</p>`
    : "";

  container.innerHTML = `
    <div class="upcoming-month-list">${parts.join("")}</div>
    ${statusMessage}`;

  hydratePosters(container);
}

export function renderUpcoming() {
  if (elements.upcomingSearchInput && elements.upcomingSearchInput.value !== state.upcomingSearch) {
    elements.upcomingSearchInput.value = state.upcomingSearch || "";
  }
  const searchQuery = state.upcomingSearch || "";
  if (normalizeUpcomingSearch(searchQuery)) {
    return renderSearchResultsView(searchQuery);
  }
  return renderMonthGridView();
}
