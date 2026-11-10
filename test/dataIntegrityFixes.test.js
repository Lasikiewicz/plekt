import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

// Second app audit, step 9: smaller data integrity fixes.
const dataDir = makeTempDataDir("plekt-data-integrity-fixes-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { importCollectionBatch } = await import("../server/src/utils/backup.js");
const { getCachedShowProgress } = await import("../server/src/utils/showProgressCache.js");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Item 1: a restore rebuilds the show progress cache.
test("restoring watch history rebuilds the show progress cache", async () => {
  const cacheFile = `${dataDir}/tv_progress_cache.json`;
  const staleKey = "ghost show";
  await repo.insertWatchRecord({
    title: "Restored Show - S01E01", show_title: "Restored Show", media_type: "episode", season: 1, episode: 1,
    tmdb_id: "restore-1", watched_at: "2024-01-01T00:00:00.000Z", source: "plex",
  });
  await wait(1500); // let the insert's own progress update finish writing the file
  // A deleted show that is still cached, as after a restore that replaced history.
  fs.writeFileSync(cacheFile, JSON.stringify({
    [staleKey]: { title: "Ghost Show", tmdb_id: "", episode_count: 3, total_episodes: 3, schema_version: 3 },
  }));

  // A restore batch of watchHistory documents (empty here) schedules the rebuild.
  importCollectionBatch("watchHistory", [], { reset: false });
  await wait(2500);

  const rebuilt = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(rebuilt[staleKey], undefined, "a show with no watch rows leaves the cache");
  assert.ok(Object.values(rebuilt).some((entry) => entry.title === "Restored Show" && entry.episode_count === 1), "a restored show is counted");
});

// Item 2: deduped history reads past the 25,000-row mark.
test("deduped history includes watches older than the newest 25,000 rows", async () => {
  const old = await repo.insertWatchRecord({
    title: "Very Old Movie", media_type: "movie", tmdb_id: "old-movie", watched_at: "1999-01-01T00:00:00.000Z", source: "plex",
  });
  const template = await repo.insertWatchRecord({
    title: "Template Movie", media_type: "movie", tmdb_id: "template-movie", watched_at: "2020-01-01T00:00:00.000Z", source: "plex",
  });
  const columns = db.prepare("PRAGMA table_xinfo(watch_history)").all().filter((column) => !column.hidden).map((column) => column.name);
  const copied = columns.filter((name) => !["id", "title", "media_key", "tmdb_id", "watched_at"].includes(name));
  db.prepare(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000)
    INSERT INTO watch_history (id, title, media_key, tmdb_id, watched_at, ${copied.join(", ")})
    SELECT 'filler-' || n.i, 'Filler ' || n.i, 'filler-key-' || n.i, 'filler-' || n.i, '2021-01-01T00:00:00.000Z',
           ${copied.map((name) => `t.${name}`).join(", ")}
    FROM n, watch_history AS t WHERE t.id = ?
  `).run(template.id);
  repo.invalidateHistoryDerivedCaches("test");

  const page = await repo.queryWatchHistory({ limit: 50, offset: 25000, dedupe: true });
  assert.ok(page.some((row) => row.id === old.id), "the oldest watch is reachable past the 25,000th row");
});

// Item 3: bulk watch deletes are all-or-nothing.
function failPlaystateDeletes() {
  db.exec("DROP TRIGGER IF EXISTS fail_playstate_delete");
  db.exec("CREATE TRIGGER fail_playstate_delete BEFORE DELETE ON playstate BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
}
function allowPlaystateDeletes() {
  db.exec("DROP TRIGGER IF EXISTS fail_playstate_delete");
}

test("deleteWatchDates rolls everything back when the playstate step fails", async (t) => {
  const media = { title: "Atomic Show - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "atomic-1" }, isValid: true };
  const row = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "atomic-1", watched_at: "2020-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", row.record.watched_at);
  failPlaystateDeletes();
  t.after(allowPlaystateDeletes);

  await assert.rejects(repo.deleteWatchDates([row.id]), /forced failure/);
  const stillThere = db.prepare("SELECT id FROM watch_history WHERE id = ?").get(row.id);
  assert.ok(stillThere, "the watch row is not deleted when a later step fails");
});

test("deleteWatchDate rolls everything back when the playstate step fails", async (t) => {
  const media = { title: "Atomic Single - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "atomic-2" }, isValid: true };
  const row = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "atomic-2", watched_at: "2020-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", row.record.watched_at);
  failPlaystateDeletes();
  t.after(allowPlaystateDeletes);

  await assert.rejects(repo.deleteWatchDate(row.id), /forced failure/);
  assert.ok(db.prepare("SELECT id FROM watch_history WHERE id = ?").get(row.id));
});

test("deleteWatchRecordByIdSync rolls everything back when the playstate step fails", async (t) => {
  const media = { title: "Atomic By Id - S01E01", type: "episode", season: 1, episode: 1, ids: { tmdb: "atomic-3" }, isValid: true };
  const row = await repo.insertWatchRecord({ title: media.title, media_type: "episode", season: 1, episode: 1, tmdb_id: "atomic-3", watched_at: "2020-06-01T00:00:00.000Z", source: "plex" });
  await repo.upsertPlaystateForMedia(media, "watched", row.record.watched_at);
  failPlaystateDeletes();
  t.after(allowPlaystateDeletes);

  assert.throws(() => repo.deleteWatchRecordByIdSync(row.id), /forced failure/);
  assert.ok(db.prepare("SELECT id FROM watch_history WHERE id = ?").get(row.id));
});
