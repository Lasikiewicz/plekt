import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-automatic-unwatch-fan-out-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { applyUnwatchedTransition, applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");
const { getTargetsForSource } = await import("../server/src/utils/syncOrchestrator.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

// Media servers stay disabled so nothing leaves the process; their routing is
// checked through getTargetsForSource with them enabled.
const config = { plex: { disabled: true }, emby: { disabled: true }, jellyfin: { disabled: true } };
const enabled = { plex: {}, emby: {}, jellyfin: {} };
const movie = (tmdb, source) => ({ type: "movie", mediaType: "movie", title: `Fan-out ${tmdb}`, ids: { tmdb }, isValid: true, source });
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const unwatchIntents = () => db.prepare("SELECT * FROM tracker_write_intents WHERE action='unwatched'").all();

const realFetch = globalThis.fetch;
let outbound = [];
test.beforeEach(() => {
  for (const table of ["tracker_write_intents", "tracker_item_state", "tracker_play_history", "tracker_connections", "watch_history", "playstate", "loop_keys"]) db.prepare(`DELETE FROM ${table}`).run();
  outbound = [];
  globalThis.fetch = async (url) => { outbound.push(String(url)); throw new Error("offline test"); };
  repo.saveTrackerConnection({ provider: "trakt", remoteUserId: "account-a", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
});
test.after(() => { globalThis.fetch = realFetch; });

async function seedWatched(tmdb) {
  // Seeded from Trakt itself so no Trakt write is captured for the setup play.
  await applyWatchedTransition({ ...movie(tmdb, "trakt"), watched_at: "2026-10-01T12:00:00.000Z" }, config, createLoopStore(), { trackDispatch: false });
  assert.equal(unwatchIntents().length, 0);
}

test("a Trakt-inferred unwatch fans out to every media server, is burst-guarded, and never writes back to Trakt", async () => {
  await seedWatched("901");
  const result = await applyUnwatchedTransition(movie("901", "trakt"), config, createLoopStore(), { trackDispatch: false });
  assert.notEqual(result.heldBackSuspiciousBurst, true);
  assert.equal(db.prepare("SELECT sync_action, source FROM watch_history WHERE id=?").get(result.id).sync_action, "unwatched");
  assert.deepEqual(getTargetsForSource("trakt", enabled, "unwatched"), ["plex", "emby", "jellyfin"]);
  assert.equal(count("SELECT COUNT(*) AS n FROM loop_keys WHERE key LIKE 'auto-unwatch-burst:trakt:%'"), 1);
  assert.equal(unwatchIntents().length, 0, "the origin tracker is not written back to");

  // Each media server's echo of the unplayed write, and Trakt's next poll, end here.
  const rows = count("SELECT COUNT(*) AS n FROM watch_history");
  for (const source of ["plex", "emby", "jellyfin", "trakt"]) {
    const echo = await applyUnwatchedTransition(movie("901", source), config, createLoopStore(), { trackDispatch: false });
    assert.equal(echo.alreadyUnwatched, true, source);
    assert.equal(echo.summary.status, "skipped", source);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM watch_history"), rows);
  assert.equal(unwatchIntents().length, 0);
  assert.equal(outbound.filter((url) => /trakt/i.test(url)).length, 0);
});

test("a media-server automatic unwatch reaches Trakt once and Trakt's echo does not bounce back", async () => {
  await seedWatched("902");
  const result = await applyUnwatchedTransition(movie("902", "jellyfin"), config, createLoopStore(), { trackDispatch: false });
  assert.notEqual(result.heldBackSuspiciousBurst, true);
  assert.deepEqual(getTargetsForSource("jellyfin", enabled, "unwatched"), ["plex", "emby"]);
  const [intent, ...extra] = unwatchIntents();
  assert.equal(extra.length, 0);
  assert.equal(intent.provider, "trakt");
  assert.equal(intent.watch_record_id, result.id);

  const rows = count("SELECT COUNT(*) AS n FROM watch_history");
  for (const source of ["trakt", "plex", "emby", "jellyfin"]) {
    const echo = await applyUnwatchedTransition(movie("902", source), config, createLoopStore(), { trackDispatch: false });
    assert.equal(echo.alreadyUnwatched, true, source);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM watch_history"), rows);
  assert.deepEqual(unwatchIntents().map((row) => row.id), [intent.id], "no second Trakt write is queued");
});
