import test from "node:test";
import assert from "node:assert/strict";

// Watch History day view: one box per local calendar day, newest day first and
// newest entry first inside each box (public/modules/history-day-view.js).

const { renderHistoryDayGroups } = await import("../public/modules/history-day-view.js");

const renderItem = (entry) => `<i data-id="${entry.id}"></i>`;
const dayBoxes = (html) => [...html.matchAll(/data-history-day="([^"]+)"/g)].map((match) => match[1]);
const ids = (html) => [...html.matchAll(/data-id="(\d+)"/g)].map((match) => Number(match[1]));

test("entries group into one box per local day, newest day first", () => {
  const items = [
    { id: 1, watched_at: new Date(2026, 9, 18, 9, 0).toISOString() },
    { id: 2, watched_at: new Date(2026, 9, 20, 21, 0).toISOString() },
    { id: 3, watched_at: new Date(2026, 9, 20, 8, 0).toISOString() },
  ];
  const html = renderHistoryDayGroups(items, renderItem);
  assert.deepEqual(dayBoxes(html), ["2026-10-20", "2026-10-18"]);
  assert.deepEqual(ids(html), [2, 3, 1]);
});

test("entries inside a day are newest first even when the input is not sorted", () => {
  const items = [
    { id: 10, watched_at: new Date(2026, 9, 20, 7, 0).toISOString() },
    { id: 11, watched_at: new Date(2026, 9, 20, 23, 0).toISOString() },
    { id: 12, watched_at: new Date(2026, 9, 20, 12, 0).toISOString() },
  ];
  assert.deepEqual(ids(renderHistoryDayGroups(items, renderItem)), [11, 12, 10]);
});

test("each box carries its item count with the right singular or plural word", () => {
  const items = [
    { id: 1, watched_at: new Date(2026, 9, 20, 9, 0).toISOString() },
    { id: 2, watched_at: new Date(2026, 9, 20, 10, 0).toISOString() },
    { id: 3, watched_at: new Date(2026, 9, 19, 10, 0).toISOString() },
  ];
  const html = renderHistoryDayGroups(items, renderItem);
  assert.match(html, /<span class="history-day-count">2 items<\/span>/);
  assert.match(html, /<span class="history-day-count">1 item<\/span>/);
});

test("entries without a usable date land in one Unknown date box", () => {
  const html = renderHistoryDayGroups([{ id: 1, watched_at: "not a date" }, { id: 2, watched_at: null }], renderItem);
  assert.deepEqual(dayBoxes(html), ["unknown"]);
  assert.match(html, /Unknown date/);
});

test("no items renders no boxes", () => {
  assert.equal(renderHistoryDayGroups([], renderItem), '<div class="history-day-list"></div>');
});
