import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-split-episode-repair-");
const { mediaKeyFor } = await import("../server/src/utils/dataRepo.js");
const repair = await import("../server/src/utils/splitEpisodeRepair.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const SERIES = { imdb: "tt18699118", tmdb: "202308", tvdb: "420207" };
const SERIES_KEY = "ids:tt18699118|202308|420207";
const episodeIds = (n) => ({ imdb: `tt900000${n}`, tmdb: `900${n}`, tvdb: `700${n}` });
const keyFor = (episode, ids) => mediaKeyFor({ media_type: "episode", season: 1, episode, imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb });

const insertHistory = db.prepare(`
  INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title, show_title_lower, sync_action, sync_dispatch_telemetry, created_at, updated_at)
  VALUES (@id, @title, @title_lower, 'episode', '2026-10-28T03:27:00.000Z', 'emby', @imdb, @tmdb, @tvdb, 1, @episode, @media_key, @show, @show_lower, 'watched', @telemetry, 1, 1)
`);

function addRow(id, show, episode, ids, telemetry = null) {
  insertHistory.run({
    id,
    title: `${show} - S01E0${episode}`,
    title_lower: `${show} - s01e0${episode}`.toLowerCase(),
    imdb: ids.imdb || null,
    tmdb: ids.tmdb || null,
    tvdb: ids.tvdb || null,
    episode,
    media_key: keyFor(episode, ids),
    show,
    show_lower: show.toLowerCase(),
    telemetry,
  });
}

function item(series, episode, ids, seriesItemId) {
  return { type: "episode", title: `${series} - S01E0${episode}`, season: 1, episode, ...ids, seriesItemId, source: "emby" };
}

// Alert E1/E2: split, provable. E3: server reports an extra id, so not exact.
// E4: split, but a correctly keyed E4 already exists. Other E1: lookup fails.
// E5: already on series ids. E6: split, and a tvdb-only E6 row on the series
// already exists under a different key.
addRow("alert-1", "Alert", 1, episodeIds(1), "Origin: emby\nDispatch status: success\nTarget trakt status: success - added\nTarget plex status: failed - 404");
addRow("alert-2", "Alert", 2, episodeIds(2));
addRow("alert-3", "Alert", 3, { imdb: "tt9000003", tmdb: null, tvdb: null });
addRow("alert-4-split", "Alert", 4, episodeIds(4));
addRow("alert-4-good", "Alert", 4, SERIES);
addRow("alert-5", "Alert", 5, SERIES);
addRow("alert-6-split", "Alert", 6, episodeIds(6));
addRow("alert-6-tvdb", "Alert", 6, { tvdb: SERIES.tvdb });
addRow("other-1", "Other", 1, episodeIds(8));
db.prepare("INSERT INTO playback_progress (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, updated_at) VALUES (?, 'Alert - S01E02', 'episode', 'emby', ?, ?, ?, 1, 2, 60000, 1)")
  .run(keyFor(2, episodeIds(2)), "tt9000002", "9002", "7002");
db.prepare("INSERT INTO playstate (media_key, title, media_type, state, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at) VALUES (?, 'Alert - S01E01', 'episode', 'watched', ?, ?, ?, 1, 1, 1)")
  .run(keyFor(1, episodeIds(1)), "tt9000001", "9001", "7001");

const scanCalls = [];
const scan = async (config, options) => {
  scanCalls.push(options);
  return {
    itemsByServer: {
      plex: [],
      emby: [
        item("Alert", 1, episodeIds(1), "S1"),
        item("Alert", 2, episodeIds(2), "S1"),
        item("Alert", 3, { imdb: "tt9000003", tmdb: "9003", tvdb: null }, "S1"),
        item("Alert", 4, episodeIds(4), "S1"),
        item("Alert", 5, SERIES, "S1"),
        item("Alert", 6, episodeIds(6), "S1"),
        item("Other", 1, episodeIds(8), "S2"),
      ],
      jellyfin: [],
    },
    scopeErrors: [],
  };
};
const resolveSeries = async (source, seriesItemId) => (seriesItemId === "S1" ? { ...SERIES } : null);
const historySnapshot = () => db.prepare("SELECT id, media_key, imdb_id, tmdb_id, tvdb_id, sync_dispatch_telemetry FROM watch_history ORDER BY id").all();
const progressKeys = () => db.prepare("SELECT media_key FROM playback_progress").all().map((row) => row.media_key);
const noBackup = async () => ({ name: "test-backup.plekt" });
const invalidations = [];
const invalidate = async (reason) => { invalidations.push(reason); };

test("audit lists only provable split rows, explains the rest and writes nothing", async () => {
  const before = historySnapshot();
  const audit = await repair.auditSplitEpisodeShows({ config: { emby: {} }, scan, resolveSeries });
  assert.deepEqual(scanCalls.at(-1), { scope: { servers: ["emby", "jellyfin"] } });
  assert.equal(audit.shows.length, 1);
  const [show] = audit.shows;
  assert.equal(show.showKey, SERIES_KEY);
  assert.equal(show.title, "Alert");
  assert.deepEqual(show.newIds, SERIES);
  assert.deepEqual(show.rows.map((row) => row.rowId), ["alert-1", "alert-2"]);
  assert.deepEqual(show.rows[0].delivered, ["trakt"]);
  assert.deepEqual(show.delivered, ["trakt"]);
  assert.deepEqual(show.progress, [{ oldKey: keyFor(2, episodeIds(2)), newKey: keyFor(2, SERIES), blocked: false }]);
  assert.equal(show.otherTables.playstate, 1);
  const reasons = Object.fromEntries(audit.skipped.map((row) => [row.rowId, row.reason]));
  assert.deepEqual(reasons, { "alert-3": "ids-differ", "alert-4-split": "collision", "alert-6-split": "collision", "other-1": "lookup-failed" });
  assert.equal(audit.totals.rows, 2);
  assert.deepEqual(historySnapshot(), before);
});

test("repair refuses an empty selection and writes nothing when the backup fails", async () => {
  await assert.rejects(repair.applySplitEpisodeRepair({ showKeys: [], scan, resolveSeries, backup: noBackup, invalidate }), { status: 400 });
  const before = historySnapshot();
  await assert.rejects(
    repair.applySplitEpisodeRepair({ showKeys: [SERIES_KEY], scan, resolveSeries, invalidate, backup: async () => { throw new Error("no passphrase"); } }),
    (error) => error.status === 409 && /nothing was changed/.test(error.message),
  );
  assert.deepEqual(historySnapshot(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM split_episode_repair_log").get().n, 0);
});

test("repair rekeys only ticked, re-proved rows, keeps telemetry, is idempotent and undoes exactly", async () => {
  const before = historySnapshot();
  let backups = 0;
  const result = await repair.applySplitEpisodeRepair({
    showKeys: [SERIES_KEY, "ids:not|a|show"],
    config: { emby: {} },
    scan,
    resolveSeries,
    invalidate,
    backup: async (options) => { backups += 1; assert.equal(options.reason, "split-episode-repair"); return noBackup(); },
  });
  assert.equal(backups, 1);
  assert.equal(result.repaired, 2);
  assert.equal(result.progressRekeyed, 1);
  assert.equal(result.backup, "test-backup.plekt");
  assert.deepEqual(result.notProven, ["ids:not|a|show"]);
  assert.deepEqual(invalidations.at(-1), "splitEpisodeRepair");

  const after = Object.fromEntries(historySnapshot().map((row) => [row.id, row]));
  for (const [id, episode] of [["alert-1", 1], ["alert-2", 2]]) {
    assert.equal(after[id].media_key, keyFor(episode, SERIES));
    assert.deepEqual([after[id].imdb_id, after[id].tmdb_id, after[id].tvdb_id], [SERIES.imdb, SERIES.tmdb, SERIES.tvdb]);
  }
  const beforeById = Object.fromEntries(before.map((row) => [row.id, row]));
  for (const id of ["alert-3", "alert-4-split", "alert-4-good", "alert-5", "alert-6-split", "alert-6-tvdb", "other-1"]) assert.deepEqual(after[id], beforeById[id]);
  for (const id of Object.keys(after)) assert.equal(after[id].sync_dispatch_telemetry, beforeById[id].sync_dispatch_telemetry);
  assert.deepEqual(progressKeys(), [keyFor(2, SERIES)]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playstate WHERE media_key = ?").get(keyFor(1, episodeIds(1))).n, 1, "other tables are not rekeyed");

  const again = await repair.applySplitEpisodeRepair({ showKeys: [SERIES_KEY], scan, resolveSeries, invalidate, backup: async () => { throw new Error("must not back up"); } });
  assert.equal(again.repaired, 0);
  assert.deepEqual(again.notProven, [SERIES_KEY]);

  const [run] = repair.listSplitEpisodeRepairRuns();
  assert.equal(run.runId, result.runId);
  assert.equal(run.rows, 2);
  assert.equal(run.progress, 1);
  assert.deepEqual(run.shows, ["Alert"]);
  assert.equal(run.reverted, false);

  const undo = await repair.undoSplitEpisodeRepair(result.runId, { invalidate });
  assert.deepEqual([undo.restored, undo.progressRestored, undo.changed], [2, 1, 0]);
  const restored = historySnapshot().map(({ id, media_key, imdb_id, tmdb_id, tvdb_id, sync_dispatch_telemetry }) => ({ id, media_key, imdb_id, tmdb_id, tvdb_id, sync_dispatch_telemetry }));
  assert.deepEqual(restored, before);
  assert.deepEqual(progressKeys(), [keyFor(2, episodeIds(2))]);
  assert.equal(repair.listSplitEpisodeRepairRuns()[0].reverted, true);
  await assert.rejects(repair.undoSplitEpisodeRepair(result.runId, { invalidate }), { status: 404 });
});

test("undo leaves a row that changed after the repair alone", async () => {
  const result = await repair.applySplitEpisodeRepair({ showKeys: [SERIES_KEY], scan, resolveSeries, invalidate, backup: noBackup });
  assert.equal(result.repaired, 2);
  db.prepare("UPDATE watch_history SET media_key = 'episode:1:2:tvdb:other' WHERE id = 'alert-2'").run();
  const undo = await repair.undoSplitEpisodeRepair(result.runId, { invalidate });
  assert.equal(undo.restored, 1);
  assert.equal(undo.changed, 1);
  assert.equal(db.prepare("SELECT media_key FROM watch_history WHERE id = 'alert-2'").get().media_key, "episode:1:2:tvdb:other");
});

test("deliveredTargets reads only successful target lines", () => {
  assert.deepEqual(repair.deliveredTargets("Dispatch status: success\nTarget trakt status: success - ok\nTarget plex status: skipped\nJellyfin status: success"), ["trakt", "jellyfin"]);
  assert.deepEqual(repair.deliveredTargets(null), []);
});
