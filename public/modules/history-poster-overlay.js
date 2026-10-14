import { escapeAttribute, escapeHtml, formatDate, sourceBadgeHtml } from "./utils.js?v=2.0.0.0.4";

// History poster overlay (plan/archive/theme-styles/plan.md, step 15). With
// Posters only on, every folded History poster (grid, list and cards views)
// carries its episode name (TV only), watched date and app along its bottom
// edge, over a blurred tint so the text reads on any poster. styles.css shows
// it only on folded posters: the full cards, and a poster opened in place by
// page-card-open.js, keep their own details. The episode line shares the
// resolved-title update in explorer.js (history-poster-overlay-episode).

function watchedDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function historyPosterOverlay(entry = {}, episodeTitle = "") {
  const episode = episodeTitle
    ? `<div class="history-poster-overlay-episode" title="${escapeAttribute(episodeTitle)}">${escapeHtml(episodeTitle)}</div>`
    : "";
  const watched = `<time class="history-poster-overlay-date" datetime="${escapeAttribute(entry.watched_at || "")}" title="${escapeAttribute(formatDate(entry.watched_at))}">${escapeHtml(watchedDay(entry.watched_at))}</time>`;
  return `<div class="history-poster-overlay">${episode}<div class="history-poster-overlay-meta">${watched}${sourceBadgeHtml(entry.source)}</div></div>`;
}
