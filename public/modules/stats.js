import { buildAuthHeaders } from "./auth.js?v=2.0.0.4.0";
import { state, elements } from "./state.js?v=2.0.0.4.0";
import { escapeHtml, escapeAttribute, platformName, formatNumber, formatDate, formatListDate, shortMonthLabel, movieHref } from "./utils.js?v=2.0.0.4.0";
import { posterMarkup, hydratePosterFallbacks } from "./images.js?v=2.0.0.4.0";

let _cb = {};

export function initStats(callbacks) {
  _cb = callbacks;
  initStatsEvents();
}

let statsEventsInitialized = false;

function initStatsEvents() {
  if (statsEventsInitialized) return;
  statsEventsInitialized = true;

  elements.statsMediaFilter?.addEventListener("change", () => {
    state.statsMediaFilter = elements.statsMediaFilter.value || "all";
    renderStats();
  });
  elements.statsPeriodType?.addEventListener("change", () => {
    state.statsPeriodType = elements.statsPeriodType.value || "all";
    state.statsPeriodValue = state.statsPeriodType === "all" ? "all" : "";
    renderStats();
    loadStats({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
  });
  elements.statsPeriodValue?.addEventListener("change", () => {
    state.statsPeriodValue = elements.statsPeriodValue.value || "all";
    renderStats();
    loadStats({ force: true }).catch((error) => _cb.setMessage?.(error.message, "error"));
  });
  document.querySelector("#stats-view")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-stats-media-href]");
    if (card) _cb.navigateTo?.(card.dataset.statsMediaHref);
  });
  document.querySelector("#stats-view")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-stats-media-href]");
    if (!card) return;
    event.preventDefault();
    _cb.navigateTo?.(card.dataset.statsMediaHref);
  });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// --- Date helpers used by explorer.js as well ---

export { formatListDate };

export function futureListDate(isoString) {
  if (!isoString) return "";
  const today = new Date().toISOString().slice(0, 10);
  if (isoString < today) return "";
  return formatListDate(isoString);
}

// Friendlier labels for TMDB's `status` field.
export function showStatusLabel(status) {
  switch (status) {
    case "Returning Series": return "Returning";
    case "In Production": return "In production";
    case "Post Production": return "Post-production";
    case "Planned": return "Planned";
    case "Canceled": return "Canceled";
    case "Ended": return "Ended";
    case "Pilot": return "Pilot";
    default: return status || "";
  }
}

export function nextAiringDateValue(tmdb) {
  if (!tmdb) return "";
  // Prefer the backend-derived next_airing_date; fall back to TMDB's own next_episode_to_air.
  const raw = tmdb.next_airing_date || tmdb.next_episode_to_air?.air_date || "";
  const today = new Date().toISOString().slice(0, 10);
  return raw && raw >= today ? raw : "";
}

// Returns { text, isStatus } for the "Next Airing" column.
export function nextAiringCell(tmdb) {
  if (!tmdb) return { text: "", isStatus: false };
  const raw = nextAiringDateValue(tmdb);
  const date = raw ? futureListDate(raw) : "";
  if (date) return { text: date, isStatus: false };
  return { text: showStatusLabel(tmdb.status), isStatus: true };
}

// --- Stats data helpers ---

export function statsReports() {
  const reports = state.stats.reports || {};
  return {
    all: reports.all || null,
    years: Array.isArray(reports.years) ? reports.years : [],
    months: Array.isArray(reports.months) ? reports.months : [],
    selected: reports.selected || null,
  };
}

export function statsPeriodLabel(period = "") {
  if (period === "all") return "All time";
  if (/^\d{4}-\d{2}$/.test(period)) {
    const date = new Date(`${period}-01T00:00:00`);
    if (Number.isNaN(date.getTime())) return period;
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
  }
  return period || "All time";
}

export function syncStatsPeriodOptions() {
  const periodSelect = elements.statsPeriodValue;
  if (!periodSelect) return;
  const reports = statsReports();
  let options = [{ value: "all", label: "All time" }];
  if (state.statsPeriodType === "year") {
    options = reports.years.map((report) => ({ value: report.period, label: report.label || report.period }));
  } else if (state.statsPeriodType === "month") {
    options = reports.months.map((report) => ({ value: report.period, label: statsPeriodLabel(report.period) }));
  }
  if (!options.length) options = [{ value: "all", label: "No ranges" }];
  if (!options.some((option) => option.value === state.statsPeriodValue)) {
    state.statsPeriodValue = options[0].value;
  }
  periodSelect.disabled = state.statsPeriodType === "all";
  periodSelect.innerHTML = options
    .map((option) => `<option value="${escapeAttribute(option.value)}"${option.value === state.statsPeriodValue ? " selected" : ""}>${escapeHtml(option.label)}</option>`)
    .join("");
}

export function selectedStatsReport() {
  const reports = statsReports();
  if (state.statsPeriodType !== "all" && reports.selected?.period === state.statsPeriodValue) return reports.selected;
  if (state.statsPeriodType === "year") {
    return reports.years.find((report) => report.period === state.statsPeriodValue) || reports.years[0] || reports.all;
  }
  if (state.statsPeriodType === "month") {
    return reports.months.find((report) => report.period === state.statsPeriodValue) || reports.months[0] || reports.all;
  }
  return reports.all;
}

export function statsFilteredRows(report = selectedStatsReport()) {
  if (!report) return [];
  if (state.statsMediaFilter === "movie") return report.topMovies || [];
  if (state.statsMediaFilter === "episode") return report.topShows || [];
  return report.topMedia || [];
}

export function statsPeriodNoun() {
  if (state.statsPeriodType === "year") return "Year";
  if (state.statsPeriodType === "month") return "Month";
  return "All Time";
}

export function statsTrackingSpanText() {
  if (!state.stats.firstWatch || !state.stats.lastWatch) return "N/A";
  const first = new Date(state.stats.firstWatch);
  const last = new Date(state.stats.lastWatch);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return "N/A";
  const diffTime = Math.abs(last - first);
  return `${Math.ceil(diffTime / (1000 * 60 * 60 * 24))} days`;
}

export function statsPlatformLabel(source) {
  return source && source !== "none" ? platformName(source) : "None";
}

export function statsSelectedMediaLabel() {
  if (state.statsMediaFilter === "movie") return "Movies";
  if (state.statsMediaFilter === "episode") return "TV Shows";
  return "Movies & TV";
}

export function statsIntroCards(report = selectedStatsReport(), periodLabel = "All time") {
  const cards = [
    { label: "Media", value: statsSelectedMediaLabel() },
    { label: "Period", value: periodLabel },
  ];
  if (state.statsMediaFilter === "movie") {
    cards.push(
      { label: "Plays", value: formatNumber(report?.movieWatches || 0) },
      { label: "Movies", value: formatNumber(report?.uniqueMovies || 0) },
    );
  } else if (state.statsMediaFilter === "episode") {
    cards.push(
      { label: "Plays", value: formatNumber(report?.tvWatches || 0) },
      { label: "TV shows", value: formatNumber(report?.uniqueShows || 0) },
      { label: "Episodes watched", value: formatNumber(report?.tvWatches || 0) },
    );
  } else {
    cards.push(
      { label: "Plays", value: formatNumber(report?.total || 0) },
      { label: "Movies", value: formatNumber(report?.uniqueMovies || 0) },
      { label: "TV shows", value: formatNumber(report?.uniqueShows || 0) },
      { label: "Episodes watched", value: formatNumber(report?.tvWatches || 0) },
    );
  }
  if (state.statsPeriodType === "all") {
    cards.push(
      { label: "Most used platform", value: statsPlatformLabel(report?.topSource || state.stats.topSource || "none") },
      { label: "Tracking span", value: statsTrackingSpanText() },
    );
  }
  return cards;
}

function statsMediaHref(item = {}) {
  const title = item.title || "unknown";
  if (item.type === "movie") return movieHref({ title });
  return `/tvshow/${encodeURIComponent(_cb.slug?.(title) || title)}`;
}

export function renderStatsKpis(report = selectedStatsReport()) {
  const container = elements.statsKpiStrip;
  if (!container) return;

  if (!state.statsLoaded && state.statsLoading) {
    const labels = state.statsMediaFilter === "all"
      ? ["Plays", "Movies", "TV Shows", "Top platform", "Busiest month"]
      : ["Plays", state.statsMediaFilter === "movie" ? "Movies" : "TV Shows", "Top platform", "Busiest month"];
    container.innerHTML = labels.map((label) => `
      <div class="stats-kpi-card">
        <span>${escapeHtml(label)}</span>
        <b class="stats-kpi-loading">&hellip;</b>
        <small>Loading</small>
      </div>
    `).join("");
    return;
  }

  const peakMonth = busiestMonth(monthlyActivityForPeriod(state.stats.monthlyActivity || [], state.statsPeriodType, state.statsPeriodValue));

  const topSrc = report?.topSource || state.stats.topSource || "none";
  const topSrcCount = report?.sourceBreakdown?.[0]?.count || state.stats.topSourceCount || 0;
  const total = Number(report?.total || state.stats.totalWatches || 0) || 1;
  const topSrcShare = topSrcCount ? `${Math.round((topSrcCount / total) * 100)}% of plays` : "";

  const kpis = [];
  if (state.statsMediaFilter === "movie") {
    kpis.push(
      { label: "Plays", value: formatNumber(report?.movieWatches || 0), sub: "movie plays", color: "" },
      { label: "Movies", value: formatNumber(report?.uniqueMovies || 0), sub: `${formatNumber(report?.movieWatches || 0)} plays`, color: "" },
    );
  } else if (state.statsMediaFilter === "episode") {
    kpis.push(
      { label: "Plays", value: formatNumber(report?.tvWatches || 0), sub: "episode plays", color: "" },
      { label: "TV Shows", value: formatNumber(report?.uniqueShows || 0), sub: `${formatNumber(report?.tvWatches || 0)} episodes`, color: "" },
    );
  } else {
    kpis.push(
      { label: "Plays", value: formatNumber(report?.total || 0), sub: "all logged events", color: "" },
      { label: "Movies", value: formatNumber(report?.uniqueMovies || 0), sub: `${formatNumber(report?.movieWatches || 0)} plays`, color: "" },
      { label: "TV Shows", value: formatNumber(report?.uniqueShows || 0), sub: `${formatNumber(report?.tvWatches || 0)} episodes`, color: "" },
    );
  }
  kpis.push(
    { label: "Top platform", value: statsPlatformLabel(topSrc), sub: topSrcShare, color: "var(--blue)" },
    { label: "Busiest month", value: peakMonth ? formatNumber(peakMonth.count) : "-", sub: peakMonth ? shortMonthLabel(peakMonth.month) : "N/A", color: "var(--green)" },
  );

  container.innerHTML = kpis.map((k) => `
    <div class="stats-kpi-card">
      <span>${escapeHtml(k.label)}</span>
      <b${k.color ? ` style="color:${k.color}"` : ""}>${escapeHtml(k.value)}</b>
      <small>${escapeHtml(k.sub)}</small>
    </div>
  `).join("");
}

export function renderStatsLeaderboard(container, rows = [], { report = selectedStatsReport(), periodLabel = "All time" } = {}) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="empty-log"><b>No matching report data</b><span>Try another media type or period.</span></div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
  const leader = rows[0];
  const podium = rows.slice(1, 3);
  const ranked = rows.slice(3, 10);
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const leaderCount = Number(leader.count || 0);
  const leaderPct = total ? Math.round((leaderCount / total) * 100) : 0;
  const oneIn = leaderPct > 0 ? Math.round(100 / leaderPct) : 0;
  const renderFacts = (row, count) => `
    <div class="stats-review-facts">
      <b>${row.type === "movie" ? "Movie" : "TV show"}</b>
      <b>${formatNumber(count)} plays</b>
      <b>${total ? Math.round((count / total) * 100) : 0}% of plays</b>
    </div>
  `;

  container.innerHTML = `
    <div class="stats-lb-leader" data-stats-media-href="${escapeAttribute(statsMediaHref(leader))}" role="link" tabindex="0">
      <div class="stats-lb-leader-poster-wrap">
        ${posterMarkup(leader, "stats-lb-leader-poster")}
      </div>
      <span class="stats-lb-rank-badge">#1</span>
      <div class="stats-lb-leader-copy">
        <div class="stats-lb-main-copy">
          <h3>${escapeHtml(leader.title || "Unknown media")}</h3>
          <p>${formatNumber(leaderCount)} plays - your most-watched title for ${escapeHtml(periodLabel)}${oneIn > 1 ? `, just over 1 in ${oneIn} of every play logged` : ""}.</p>
        </div>
        <div class="stats-lb-card-bottom">
          ${renderFacts(leader, leaderCount)}
          <div class="stats-media-meter" aria-hidden="true"><span style="width:100%"></span></div>
        </div>
      </div>
    </div>
    ${podium.length ? `
      <div class="stats-lb-podium">
        ${podium.map((row, index) => {
    const rank = index + 2;
    const wpct = Math.round((Number(row.count || 0) / max) * 100);
    return `
          <div class="stats-lb-podium-card" data-stats-media-href="${escapeAttribute(statsMediaHref(row))}" role="link" tabindex="0">
            <div class="stats-lb-podium-poster-wrap">
              ${posterMarkup(row, "stats-lb-podium-poster")}
            </div>
            <span class="stats-lb-rank-badge">#${rank}</span>
            <div class="stats-lb-podium-body">
              <b class="stats-lb-podium-title">${escapeHtml(row.title || "Unknown media")}</b>
              <div class="stats-lb-card-bottom">
                ${renderFacts(row, Number(row.count || 0))}
                <div class="stats-media-meter" aria-hidden="true"><span style="width:${wpct}%"></span></div>
              </div>
            </div>
          </div>
        `;
  }).join("")}
      </div>
    ` : ""}
    <div class="stats-lb-rows">
      ${ranked.map((row, index) => {
    const wpct = Math.round((Number(row.count || 0) / max) * 100);
    return `
          <div class="stats-lb-row" data-stats-media-href="${escapeAttribute(statsMediaHref(row))}" role="link" tabindex="0">
            <div class="stats-lb-row-poster-wrap">
              ${posterMarkup(row, "stats-lb-row-poster")}
            </div>
            <span class="stats-lb-rank-badge">#${index + 4}</span>
            <div class="stats-lb-row-body">
              <span class="stats-lb-row-title">${escapeHtml(row.title || "Unknown media")}</span>
              <div class="stats-lb-card-bottom">
                ${renderFacts(row, Number(row.count || 0))}
                <div class="stats-media-meter" aria-hidden="true"><span style="width:${wpct}%"></span></div>
              </div>
            </div>
          </div>
        `;
  }).join("")}
    </div>
  `;
  hydratePosterFallbacks(container).catch(() => { });
}

export function renderStatsMoviesTvSplit(container, report = selectedStatsReport()) {
  if (!container) return;
  const moviePlays = Number(report?.movieWatches || 0);
  const tvPlays = Number(report?.tvWatches || 0);
  const totalPlays = moviePlays + tvPlays;
  const moviePct = totalPlays ? ((moviePlays / totalPlays) * 100).toFixed(1) : "0.0";
  const tvPct = totalPlays ? (100 - parseFloat(moviePct)).toFixed(1) : "0.0";

  container.innerHTML = `
    <h2 class="stats-split-title">Movies vs TV</h2>
    <div class="stats-split-bar">
      <div style="width:${moviePct}%;background:var(--blue)"></div>
      <div style="width:${tvPct}%;background:var(--green)"></div>
    </div>
    <div class="stats-split-labels">
      <div>
        <span><span class="stats-dot" style="background:var(--blue)"></span>Movie plays</span>
        <b>${escapeHtml(formatNumber(moviePlays))} <em>${moviePct}%</em></b>
      </div>
      <div style="text-align:right">
        <span style="justify-content:flex-end">TV episodes<span class="stats-dot" style="background:var(--green)"></span></span>
        <b>${escapeHtml(formatNumber(tvPlays))} <em>${tvPct}%</em></b>
      </div>
    </div>
  `;
}

export function renderStatsPlatformRows(container, rows = []) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="empty-log"><b>No data yet</b><span>Import history or wait for completed webhooks.</span></div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r.count || 0)), 1);
  const total = rows.reduce((sum, r) => sum + Number(r.count || 0), 0) || 1;
  container.innerHTML = rows.map((row) => {
    const count = Number(row.count || 0);
    const share = ((count / total) * 100).toFixed(count / total < 0.01 ? 1 : 0) + "%";
    const wpct = Math.round((count / max) * 100);
    return `
      <div class="stats-platform-row">
        <div class="stats-platform-row-head">
          <b>${escapeHtml(platformName(row.source))}</b>
          <em><b>${escapeHtml(formatNumber(count))}</b> - ${share}</em>
        </div>
        <div class="stats-media-meter" aria-hidden="true"><span style="width:${wpct}%;background:var(--blue)"></span></div>
      </div>
    `;
  }).join("");
}

export function renderStatsBookends(container, report = selectedStatsReport()) {
  if (!container) return;
  const first = report?.firstPlay;
  const last = report?.lastPlay;
  container.innerHTML = `
    <h2 class="stats-bookends-title">Bookends</h2>
    <div class="stats-bookends">
      <div>
        <span>First play</span>
        <b>${first ? escapeHtml(first.title || "Unknown") : "No play logged"}</b>
        ${first ? `<small>${escapeHtml(formatDate(first.latestWatch))}</small>` : ""}
      </div>
      <div>
        <span>Last play</span>
        <b>${last ? escapeHtml(last.title || "Unknown") : "No play logged"}</b>
        ${last ? `<small>${escapeHtml(formatDate(last.latestWatch))}</small>` : ""}
      </div>
    </div>
  `;
}

export function monthlyActivityForPeriod(activity = [], periodType = "all", periodValue = "") {
  if (periodType === "year" && periodValue) {
    return activity.filter((row) => String(row.month || "").startsWith(`${periodValue}-`));
  }
  if (periodType === "month" && periodValue) {
    return activity.filter((row) => row.month === periodValue);
  }
  return activity;
}

export function busiestMonth(activity = []) {
  if (!activity.length) return null;
  return activity.reduce((best, row) => Number(row.count) > Number(best.count) ? row : best, activity[0]);
}

export function renderMonthChart() {
  let rows = monthlyActivityForPeriod(state.stats.monthlyActivity || [], state.statsPeriodType, state.statsPeriodValue);
  if (state.statsPeriodType !== "year" && state.statsPeriodType !== "month") rows = rows.slice(-12);
  if (!rows.length) {
    elements.monthChart.innerHTML = `<div class="empty-log"><b>No monthly activity yet</b><span>Completed watches will appear here.</span></div>`;
    return;
  }

  const peakCount = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
  const BAR_MAX_PX = 110;
  elements.monthChart.innerHTML = rows.map((row) => {
    const count = Number(row.count || 0);
    const isPeak = count === peakCount;
    const barH = Math.max(3, Math.round((count / peakCount) * BAR_MAX_PX));
    return `
      <article class="month-column">
        <b${isPeak ? ` style="color:var(--green)"` : ""}>${formatNumber(count)}</b>
        <span style="height:${barH}px;${isPeak ? "background:var(--green);border-color:var(--green)" : ""}"></span>
        <small>${escapeHtml(shortMonthLabel(row.month))}</small>
      </article>
    `;
  }).join("");
}

export function renderStats() {
  if (elements.statsMediaFilter) elements.statsMediaFilter.value = state.statsMediaFilter;
  if (elements.statsPeriodType) elements.statsPeriodType.value = state.statsPeriodType;
  syncStatsPeriodOptions();
  const report = selectedStatsReport();
  const periodLabel = statsPeriodLabel(report?.period || "all");
  renderStatsKpis(report);
  renderStatsLeaderboard(elements.statsLeaderboard, statsFilteredRows(report), { report, periodLabel });
  renderStatsMoviesTvSplit(elements.statsMoviesTvSplit, report);
  renderStatsPlatformRows(elements.sourceRanking, report?.sourceBreakdown || state.stats.sourceBreakdown || []);
  renderStatsBookends(elements.statsBookends, report);
  if (elements.statsLeaderboardSubtitle) elements.statsLeaderboardSubtitle.textContent = `${periodLabel} - ${statsSelectedMediaLabel()} by plays`;
  if (elements.statsActivityTitle) elements.statsActivityTitle.textContent = state.statsPeriodType === "all" ? "Watch Activity" : "Range Activity";
  if (elements.statsActivitySubtitle) elements.statsActivitySubtitle.textContent = state.statsPeriodType === "all" ? "Monthly archive volume" : `${periodLabel} selection`;
  if (elements.monthChart) renderMonthChart();
}

export async function loadStats({ force = false } = {}) {
  if (!state.token || state.statsLoading || (state.statsLoaded && !force)) return state.stats;
  state.statsLoading = true;

  try {
    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("stats", "only");
    if (state.statsPeriodType !== "all" && state.statsPeriodValue) {
      url.searchParams.set("period", state.statsPeriodValue);
    }
    const response = await fetch(url, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stats load failed with ${response.status}`);

    state.stats = body.stats || state.stats;
    state.statsLoaded = true;
    renderStats();
    return state.stats;
  } finally {
    state.statsLoading = false;
  }
}

export function renderRankingTable(container, rows = [], labelKey) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="empty-log"><b>No data yet</b><span>Import history or wait for completed webhooks.</span></div>`;
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
  container.innerHTML = `
    <div class="ranking-table">
      <div class="ranking-head">
        <span>#</span>
        <span>${labelKey === "platform" ? "Platform" : labelKey === "movie" ? "Movie" : "Series"}</span>
        <span>Relative volume</span>
        <span>Watch count</span>
      </div>
      ${rows
      .map(
        (row, index) => `
            <article class="ranking-row">
              <span>${index + 1}</span>
              <b>${escapeHtml(labelKey === "platform" ? platformName(row.source) : row.title)}</b>
              <div class="mini-bar"><span style="width: ${(Number(row.count || 0) / max) * 100}%"></span></div>
              <em>${formatNumber(row.count)}</em>
            </article>
          `,
      )
      .join("")}
    </div>
  `;
}
