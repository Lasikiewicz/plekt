import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-stats-show-identity-");
const { db } = await import("../server/src/db.js");
const { getWatchStats } = await import("../server/src/utils/dataRepo.js");

test("same-title shows retain separate Stats rankings and artwork across periods", async () => {
  const insert = db.prepare(`INSERT INTO watch_history
    (id, title, title_lower, show_title, media_type, season, episode, watched_at,
     source, tmdb_id, tvdb_id, poster_url, sync_action, media_key, created_at, updated_at)
    VALUES (?, ?, ?, 'Shared Title', 'episode', 1, ?, ?, 'emby', ?, ?, ?, 'watched', ?, 1, 1)`);
  for (const [id, episode, date, tmdb, tvdb, poster] of [
    ["a1", 1, "2026-01-01T12:00:00Z", "111", "211", "/a.webp"],
    ["a2", 2, "2026-01-02T12:00:00Z", "111", "211", "/a.webp"],
    ["b1", 1, "2026-01-03T12:00:00Z", "112", "212", "/b.webp"],
  ]) {
    const title = `Shared Title - S01E0${episode}`;
    insert.run(id, title, title.toLowerCase(), episode, date, tmdb, tvdb, poster, `episode:${tmdb}:1:${episode}`);
  }
  const stats = await getWatchStats();
  assert.equal(stats.topShows.length, 2);
  for (const report of [stats.reports.all, ...stats.reports.years, ...stats.reports.months]) {
    assert.equal(report.topShows.length, 2);
    assert.deepEqual(report.topShows.map((row) => row.count).sort(), [1, 2]);
    assert.equal(new Set(report.topShows.map((row) => row.key)).size, 2);
    assert.deepEqual(new Set(report.topShows.map((row) => row.poster_url)), new Set(["/a.webp", "/b.webp"]));
    // Same-title entries link by show id; a title route would open whichever comes first.
    assert.deepEqual(new Set(report.topShows.map((row) => row.show_tmdb_id)), new Set(["111", "112"]));
  }
});
