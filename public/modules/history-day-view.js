import { escapeHtml } from "./utils.js?v=2.2.1.0.2";

// Watch history grouped by local calendar day: one box per day, newest day first,
// newest entry first inside each box. Cards come from the caller so the explorer
// keeps ownership of the poster markup.

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function watchedTime(entry) {
  return parseDate(entry.watched_at)?.getTime() || 0;
}

function dayKey(value) {
  const date = parseDate(value);
  if (!date) return "unknown";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayLabel(value) {
  const date = parseDate(value);
  if (!date) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}

export function renderHistoryDayGroups(items, renderItem) {
  const days = new Map();
  const newestFirst = [...items].sort((a, b) => watchedTime(b) - watchedTime(a));
  for (const entry of newestFirst) {
    const key = dayKey(entry.watched_at);
    if (!days.has(key)) days.set(key, { label: dayLabel(entry.watched_at), entries: [] });
    days.get(key).entries.push(entry);
  }
  const boxes = [...days.entries()].map(([key, day]) => `
    <section class="history-day-box" data-history-day="${key}">
      <header class="history-day-header">
        <h3 class="history-day-title">${escapeHtml(day.label)}</h3>
        <span class="history-day-count">${day.entries.length} ${day.entries.length === 1 ? "item" : "items"}</span>
      </header>
      <div class="history-list history-day-cards">${day.entries.map(renderItem).join("")}</div>
    </section>
  `);
  return `<div class="history-day-list">${boxes.join("")}</div>`;
}
