import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sortAndDedupeEpisodes } from "../server/src/utils/upcomingCalendarCache.js";

const upcomingSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "public/modules/upcoming.js"), "utf8");

function episode(overrides = {}) {
  return {
    airDate: "2026-08-05",
    showTitle: "Sterling Point",
    showId: "tmdb:283297",
    tmdbId: "283297",
    tvdbId: "459552",
    posterUrl: "",
    posterRecordId: "",
    season: 1,
    episode: 1,
    ...overrides,
  };
}

test("one series tracked as a tmdb-keyed and a tvdb-keyed show lists each episode once", () => {
  const result = sortAndDedupeEpisodes([
    episode({ showId: "tvdb:459552" }),
    episode({ showId: "tmdb:283297" }),
    episode({ showId: "tvdb:459552", episode: 2 }),
    episode({ showId: "tmdb:283297", episode: 2 }),
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.episode), [1, 2]);
  assert.ok(result.every((item) => item.showId === "tmdb:283297"));
});

test("one TVDB series tracked under two different tmdb ids lists each episode once", () => {
  const result = sortAndDedupeEpisodes([
    episode({ showId: "tmdb:7204102", tmdbId: "7204102" }),
    episode({ showId: "tmdb:283297", tmdbId: "283297" }),
    episode({ showId: "tmdb:7204102", tmdbId: "7204102", episode: 2 }),
    episode({ showId: "tmdb:283297", tmdbId: "283297", episode: 2 }),
  ]);
  assert.equal(result.length, 2);
});

test("different TVDB series with the same title and date stay separate", () => {
  const result = sortAndDedupeEpisodes([
    episode({ tvdbId: "1", tmdbId: "10", showId: "tmdb:10" }),
    episode({ tvdbId: "2", tmdbId: "20", showId: "tmdb:20" }),
  ]);
  assert.equal(result.length, 2);
});

test("the duplicate that carries artwork wins when neither show is tmdb-keyed", () => {
  const result = sortAndDedupeEpisodes([
    episode({ showId: "tvdb:1" }),
    episode({ showId: "tvdb:2", posterUrl: "/poster.jpg" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].showId, "tvdb:2");
});

test("different shows or episodes that merely share a date stay separate", () => {
  const result = sortAndDedupeEpisodes([
    episode(),
    episode({ tmdbId: "999", tvdbId: "777", showId: "tmdb:999", showTitle: "Other" }),
    episode({ season: 2 }),
    episode({ airDate: "2026-08-06" }),
  ]);
  assert.equal(result.length, 4);
});

test("episodes with neither a TVDB nor a tmdb id are only merged within the same show id", () => {
  const result = sortAndDedupeEpisodes([
    episode({ tmdbId: "", tvdbId: "", showId: "tvdb:1" }),
    episode({ tmdbId: "", tvdbId: "", showId: "tvdb:1" }),
    episode({ tmdbId: "", tvdbId: "", showId: "tvdb:2" }),
  ]);
  assert.equal(result.length, 2);
});

test("the Upcoming month range stops 24 months from the current month", () => {
  assert.match(upcomingSource, /const UPCOMING_MAX_MONTHS_FROM_CURRENT = 24;/);
  const past = upcomingSource.match(/function extendRangePast\(\) \{[\s\S]*?\n\}/)[0];
  const future = upcomingSource.match(/function extendRangeFuture\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(past, /UPCOMING_MAX_MONTHS_FROM_CURRENT\)\) return false;/);
  assert.match(future, /UPCOMING_MAX_MONTHS_FROM_CURRENT\)\) return false;/);
  // A capped extend returns false, so a loop that retries it must stop on false.
  assert.match(upcomingSource, /&& extendRangePast\(\)\);/);
  assert.match(upcomingSource, /&& extendRangeFuture\(\)\);/);
});
