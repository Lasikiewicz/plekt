import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-live-poller-completion-");

const repo = await import("../server/src/utils/dataRepo.js");
const { refreshLiveSessions, __setCompletionAfterInsertHook } = await import("../server/src/utils/liveSessionCompletion.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { dropTitle, listDroppedTitles } = await import("../server/src/utils/droppedTitles.js");
const { db } = await import("../server/src/db.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");

test("interrupted completion settles its captured tracker intent without creating an orphan or resending", async () => {
  saveTrackerConnection({ provider: "trakt", clientId: "fixture", clientSecret: "fixture", remoteUserId: "fixture-user", accessToken: "fixture-token", refreshToken: "fixture-refresh", accessTokenExpiresAt: Date.now() + 86400_000 });
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://api.trakt.tv/sync/history") && options.method === "POST") {
      writes += 1;
      return new Response(JSON.stringify({ added: { movies: 1 }, not_found: { movies: [] } }), { status: 201 });
    }
    throw new Error(`Unexpected request: ${new URL(url).pathname}`);
  };
  try {
    __setCompletionAfterInsertHook(() => { throw new Error("fixture interruption after watch insert"); });
    await seedSession({ sessionId: "poller-tracker-intent", tmdb: "900008", progress: 96 });
    const loop = createLoopStore();
    await refreshLiveSessions(EMPTY_CONFIG, loop);
    await refreshLiveSessions(EMPTY_CONFIG, loop);
    assert.equal(writes, 0);
    assert.equal(db.prepare("SELECT status FROM tracker_write_intents WHERE media_key LIKE '%900008%'").get().status, "pending");
    __setCompletionAfterInsertHook(null);
    await refreshLiveSessions(EMPTY_CONFIG, loop);
    await refreshLiveSessions(EMPTY_CONFIG, loop);
    const rows = await watchRows("900008");
    assert.equal(rows.length, 1);
    const intents = db.prepare("SELECT watch_record_id,status FROM tracker_write_intents WHERE media_key LIKE '%900008%'").all();
    assert.deepEqual(intents, [{ watch_record_id: rows[0].id, status: "settled" }]);
    await refreshLiveSessions(EMPTY_CONFIG, loop);
    assert.equal(writes, 1);
  } finally {
    __setCompletionAfterInsertHook(null);
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM tracker_connections WHERE provider='trakt'").run();
  }
});

// End-to-end coverage of the poller's vanished-session promotion
// (core-sync-health step 2): a cached session that is no longer reported for
// two polls becomes a watch only when the row proves a finished play.
async function seedSession({ sessionId, tmdb, progress, paused = false, updatedAt = Date.now() - 10_000 }) {
  const payload = {
    title: `Poller Movie ${tmdb}`,
    mediaType: "movie",
    source: "jellyfin",
    ids: { tmdb },
    progress,
    offsetMs: progress * 60_000,
    durationMs: 100 * 60_000,
    paused,
    playbackState: paused ? "paused" : "playing",
  };
  await repo.upsertLiveTrackingCache([{
    session_id: sessionId,
    title: payload.title,
    source_platform: "jellyfin",
    last_progress: progress,
    updated_at: updatedAt,
    completed_at: null,
    payload_json: JSON.stringify(payload),
  }]);
}

async function watchRows(tmdb) {
  return (await repo.getCachedHistory()).filter((row) => String(row.tmdb_id) === String(tmdb) && row.sync_action !== "unwatched");
}

// Sections present but unconfigured: every resolver answers "no sessions".
const EMPTY_CONFIG = { plex: {}, emby: {}, jellyfin: {} };

async function pollUntilConfirmedGone() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`Unexpected fetch during test: ${url}`); };
  try {
    // A session must be missing from two consecutive polls before it counts as stopped.
    await refreshLiveSessions(EMPTY_CONFIG, createLoopStore());
    await refreshLiveSessions(EMPTY_CONFIG, createLoopStore());
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a playing session past the threshold that vanishes becomes one watch", async () => {
  dropTitle({ media_type: "movie", title: "Poller Movie 900001", tmdb_id: "900001" }, { now: Date.now() - 60_000 });
  await seedSession({ sessionId: "poller-playing", tmdb: "900001", progress: 95 });
  await pollUntilConfirmedGone();
  const rows = await watchRows("900001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "jellyfin");
  assert.equal(listDroppedTitles().length, 0, "a completed live session restores a dropped movie");
});

test("a session paused in the credits that vanishes becomes a watch", async () => {
  await seedSession({ sessionId: "poller-paused-credits", tmdb: "900002", progress: 95, paused: true });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows("900002")).length, 1);
});

test("a session paused below the threshold that vanishes is not a watch", async () => {
  await seedSession({ sessionId: "poller-paused-early", tmdb: "900003", progress: 60, paused: true });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows("900003")).length, 0);
});

test("a stale paused row is never promoted", async () => {
  await seedSession({ sessionId: "poller-paused-stale", tmdb: "900004", progress: 95, paused: true, updatedAt: Date.now() - 60 * 60_000 });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows("900004")).length, 0);
});

test("the poller records a rewatch when the last watch was on an earlier day", async () => {
  const media = { title: "Poller Movie 900005", type: "movie", source: "jellyfin", isValid: true, ids: { tmdb: "900005" } };
  const earlier = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await repo.insertWatchRecord({ title: media.title, media_type: "movie", tmdb_id: "900005", watched_at: earlier, source: "jellyfin", sync_action: "watched" });
  await repo.upsertPlaystateForMedia(media, "watched", earlier);

  await seedSession({ sessionId: "poller-rewatch", tmdb: "900005", progress: 96 });
  await pollUntilConfirmedGone();
  const rows = await watchRows("900005");
  assert.equal(rows.length, 2, "tonight's play is recorded as its own rewatch row");
  assert.ok(rows.some((row) => row.watched_at !== earlier));
});

test("the poller does not add a second watch on the same day", async () => {
  const media = { title: "Poller Movie 900006", type: "movie", source: "jellyfin", isValid: true, ids: { tmdb: "900006" } };
  const earlierToday = new Date(Date.now() - 60_000).toISOString();
  await repo.insertWatchRecord({ title: media.title, media_type: "movie", tmdb_id: "900006", watched_at: earlierToday, source: "jellyfin", sync_action: "watched" });
  await repo.upsertPlaystateForMedia(media, "watched", earlierToday);

  await seedSession({ sessionId: "poller-same-day", tmdb: "900006", progress: 96 });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows("900006")).length, 1);
});

test("a same-day completed play after dropping restores the title without adding a history row", async () => {
  const media = { title: "Poller Movie 900007", type: "movie", source: "jellyfin", isValid: true, ids: { tmdb: "900007" } };
  const earlierToday = new Date(Date.now() - 10_000).toISOString();
  await repo.insertWatchRecord({ title: media.title, media_type: "movie", tmdb_id: "900007", watched_at: earlierToday, source: "jellyfin", sync_action: "watched" });
  await repo.upsertPlaystateForMedia(media, "watched", earlierToday);

  const droppedAt = Date.now() - 5_000;
  dropTitle({ media_type: "movie", title: media.title, tmdb_id: "900007" }, { now: droppedAt });
  await seedSession({ sessionId: "poller-same-day-after-drop", tmdb: "900007", progress: 96, updatedAt: droppedAt + 1_000 });
  await pollUntilConfirmedGone();

  assert.equal((await watchRows("900007")).length, 1, "same-day history dedupe keeps one watch row");
  assert.equal(listDroppedTitles().length, 0, "completed playback after the drop restores the title");
});
