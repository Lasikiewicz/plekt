import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { busiestMonth, monthlyActivityForPeriod } = await import("../public/modules/stats.js");

const activity = [
  { month: "2021-05", count: 586 },
  { month: "2025-02", count: 40 },
  { month: "2025-07", count: 95 },
  { month: "2026-01", count: 12 },
  { month: "2026-09", count: 30 },
];

test("busiest month follows the selected year", () => {
  assert.deepEqual(busiestMonth(monthlyActivityForPeriod(activity, "year", "2025")), { month: "2025-07", count: 95 });
  assert.deepEqual(busiestMonth(monthlyActivityForPeriod(activity, "year", "2026")), { month: "2026-09", count: 30 });
});

test("busiest month for a selected month is that month", () => {
  assert.deepEqual(busiestMonth(monthlyActivityForPeriod(activity, "month", "2026-01")), { month: "2026-01", count: 12 });
});

test("busiest month for all time uses every month", () => {
  assert.deepEqual(busiestMonth(monthlyActivityForPeriod(activity, "all", "all")), { month: "2021-05", count: 586 });
});

test("busiest month is empty when the period has no plays", () => {
  assert.equal(busiestMonth(monthlyActivityForPeriod(activity, "year", "1999")), null);
  assert.equal(busiestMonth([]), null);
});

test("Stats show entries link by show id, falling back to the title route", async () => {
  const { statsMediaHref } = await import("../public/modules/stats.js");
  assert.equal(statsMediaHref({ type: "episode", title: "Kin", show_tmdb_id: "236621" }), "/tvshow/tmdb/236621-kin");
  assert.equal(statsMediaHref({ type: "episode", title: "Kin", show_tmdb_id: "112693", show_tvdb_id: "403485" }), "/tvshow/tvdb/403485-kin");
  // Episode-level flat ids are never series identity.
  assert.equal(statsMediaHref({ type: "episode", title: "Kin", tmdb_id: "999" }), "/tvshow/Kin");
});
