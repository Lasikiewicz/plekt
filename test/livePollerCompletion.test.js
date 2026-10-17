import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-live-poller-completion-");

const repo = await import("../server/src/utils/dataRepo.js");
const { refreshLiveSessions } = await import("../server/src/utils/liveSessionCompletion.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

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
  await seedSession({ sessionId: "poller-playing", tmdb: "900001", progress: 95 });
  await pollUntilConfirmedGone();
  const rows = await watchRows("900001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "jellyfin");
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
