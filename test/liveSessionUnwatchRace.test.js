import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-live-unwatch-race-");

const repo = await import("../server/src/utils/dataRepo.js");
const { refreshLiveSessions } = await import("../server/src/scheduled.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

// Functional audit finding F1: a cached session that reached the watched threshold
// before a manual unwatch must not be promoted to watched when it finally vanishes.
const EMPTY_CONFIG = { plex: {}, emby: {}, jellyfin: {} };

function movieMedia(tmdb) {
  return {
    title: `Unwatch Race Movie ${tmdb}`,
    type: "movie",
    source: "jellyfin",
    ids: { tmdb },
  };
}

async function seedSession({ sessionId, tmdb, progress = 95, updatedAt }) {
  const payload = {
    ...movieMedia(tmdb),
    mediaType: "movie",
    progress,
    offsetMs: progress * 60_000,
    durationMs: 100 * 60_000,
    paused: false,
    playbackState: "playing",
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

async function pollUntilConfirmedGone() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`Unexpected fetch during test: ${url}`); };
  try {
    await refreshLiveSessions(EMPTY_CONFIG, createLoopStore());
    await refreshLiveSessions(EMPTY_CONFIG, createLoopStore());
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a session last seen before a manual unwatch does not become a watch", async () => {
  const tmdb = "910001";
  await seedSession({ sessionId: "unwatch-race-before", tmdb, updatedAt: Date.now() - 2_000 });
  await repo.upsertPlaystateForMedia(movieMedia(tmdb), "unwatched", undefined, { skipInvalidate: true });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows(tmdb)).length, 0);
  const playstate = await repo.getPlaystateForMedia(movieMedia(tmdb));
  assert.equal(playstate?.state, "unwatched");
});

test("a session still seen after an earlier unwatch is recorded as real playback", async () => {
  const tmdb = "910002";
  await repo.upsertPlaystateForMedia(movieMedia(tmdb), "unwatched", undefined, { skipInvalidate: true });
  await seedSession({ sessionId: "unwatch-race-after", tmdb, updatedAt: Date.now() + 60_000 });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows(tmdb)).length, 1);
});

test("a retried completion after a half-finished write adds no second watch", async () => {
  const tmdb = "910003";
  const watchedAt = new Date(Date.now() - 1_000).toISOString();
  await repo.upsertPlaystateForMedia(movieMedia(tmdb), "watched", watchedAt, { skipInvalidate: true });
  await seedSession({ sessionId: "unwatch-race-retry", tmdb, updatedAt: Date.now() - 2_000 });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows(tmdb)).length, 0);
});
