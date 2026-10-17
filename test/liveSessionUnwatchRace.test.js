import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-live-unwatch-race-");

const repo = await import("../server/src/utils/dataRepo.js");
const {
  refreshLiveSessions,
  __setCompletionBeforeRecheckHook,
  __setCompletionAfterInsertHook,
  __setStoppedProgressBeforeWriteHook,
} = await import("../server/src/utils/liveSessionCompletion.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { bumpDataVersion } = await import("../server/src/db.js");
const { LIVE_SESSION_COMPLETION_MAX_AGE_MS } = await import("../server/src/utils/liveSessions.js");

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

test("an unwatch landing between the first check and the insert keeps the item unwatched", async () => {
  const tmdb = "910004";
  await seedSession({ sessionId: "unwatch-race-midway", tmdb, updatedAt: Date.now() - 2_000 });
  // The first playstate read sees nothing; the unwatch is written during the awaits before the recheck.
  __setCompletionBeforeRecheckHook(async (media) => {
    __setCompletionBeforeRecheckHook(null);
    await repo.upsertPlaystateForMedia(media, "unwatched", undefined, { skipInvalidate: true });
  });
  try {
    await pollUntilConfirmedGone();
  } finally {
    __setCompletionBeforeRecheckHook(null);
  }
  assert.equal((await watchRows(tmdb)).length, 0);
  assert.equal((await repo.getPlaystateForMedia(movieMedia(tmdb)))?.state, "unwatched");
});

test("a history insert that fails once is retried into one watch", async () => {
  const tmdb = "910005";
  await seedSession({ sessionId: "live-fail-insert", tmdb, updatedAt: Date.now() - 2_000 });
  let attempts = 0;
  __setCompletionBeforeRecheckHook(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("simulated history insert failure");
  });
  try {
    await pollUntilConfirmedGone();
    await pollUntilConfirmedGone();
  } finally {
    __setCompletionBeforeRecheckHook(null);
  }
  assert.equal((await watchRows(tmdb)).length, 1);
  assert.equal((await repo.getPlaystateForMedia(movieMedia(tmdb)))?.state, "watched");
});

test("a playstate write that fails after the history insert is repaired and dispatched once", async () => {
  const tmdb = "910006";
  await seedSession({ sessionId: "live-fail-playstate", tmdb, updatedAt: Date.now() - 2_000 });
  let failed = false;
  __setCompletionAfterInsertHook(() => {
    if (failed) return;
    failed = true;
    throw new Error("simulated playstate failure");
  });
  try {
    await pollUntilConfirmedGone();
    await pollUntilConfirmedGone();
  } finally {
    __setCompletionAfterInsertHook(null);
  }
  const rows = await watchRows(tmdb);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].sync_dispatch_telemetry, "retry must record dispatch telemetry for the existing row");
  assert.equal((await repo.getPlaystateForMedia(movieMedia(tmdb)))?.state, "watched");
});

test("a retried completion after a half-finished write adds no second watch", async () => {
  const tmdb = "910003";
  const watchedAt = new Date(Date.now() - 1_000).toISOString();
  await repo.upsertPlaystateForMedia(movieMedia(tmdb), "watched", watchedAt, { skipInvalidate: true });
  await seedSession({ sessionId: "unwatch-race-retry", tmdb, updatedAt: Date.now() - 2_000 });
  await pollUntilConfirmedGone();
  assert.equal((await watchRows(tmdb)).length, 0);
});

async function cachedSessionIds() {
  return (await repo.loadLiveTrackingCache({ includeCompleted: true })).map((row) => row.session_id);
}

test("a resume-progress write that fails once is retried into a stored resume position", async () => {
  const tmdb = "910007";
  await seedSession({ sessionId: "live-fail-progress", tmdb, progress: 60, updatedAt: Date.now() - 2_000 });
  let attempts = 0;
  __setStoppedProgressBeforeWriteHook(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("simulated progress failure");
  });
  try {
    await pollUntilConfirmedGone();
    await pollUntilConfirmedGone();
  } finally {
    __setStoppedProgressBeforeWriteHook(null);
  }
  assert.equal(attempts, 2);
  assert.ok(await repo.getPlaybackProgressForMedia(movieMedia(tmdb)), "resume row exists after recovery");
});

test("a resume-progress write that keeps failing drops the row at the staleness cap with a log line", async () => {
  const tmdb = "910008";
  const base = Date.now();
  const sessionId = "live-fail-persistent";
  await seedSession({ sessionId, tmdb, progress: 60, updatedAt: base });
  let fakeNow = base + 1_000;
  const nowMock = mock.method(Date, "now", () => fakeNow);
  const lines = [];
  const logger = (line) => lines.push(String(line));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`Unexpected fetch during test: ${url}`); };
  __setStoppedProgressBeforeWriteHook(() => { throw new Error("simulated persistent progress failure"); });
  try {
    for (let poll = 0; poll < 4; poll += 1) {
      await refreshLiveSessions(EMPTY_CONFIG, createLoopStore(), { logger });
    }
    assert.ok((await cachedSessionIds()).includes(sessionId), "row is kept while the write keeps failing");
    fakeNow = base + LIVE_SESSION_COMPLETION_MAX_AGE_MS + 1_000;
    await refreshLiveSessions(EMPTY_CONFIG, createLoopStore(), { logger });
  } finally {
    __setStoppedProgressBeforeWriteHook(null);
    nowMock.mock.restore();
    globalThis.fetch = originalFetch;
  }
  assert.equal((await cachedSessionIds()).includes(sessionId), false);
  assert.ok(lines.some((line) => line.includes("too old to infer a stop") && line.includes(sessionId)));
});

async function freshWatchRows(tmdb) {
  bumpDataVersion("restart test read");
  return watchRows(tmdb);
}

test("a restart between a half-finished completion and its retry adds no second watch", async () => {
  const tmdb = "910009";
  const sessionId = "live-fail-restart";
  await seedSession({ sessionId, tmdb, updatedAt: Date.now() - 2_000 });
  // First process: the history insert lands, then the playstate write fails and the process dies before the retry.
  let crashed = false;
  __setCompletionAfterInsertHook(() => {
    if (crashed) return;
    crashed = true;
    throw new Error("simulated crash after history insert");
  });
  try {
    for (let poll = 0; poll < 4 && !crashed; poll += 1) await pollUntilConfirmedGone();
  } finally {
    __setCompletionAfterInsertHook(null);
  }
  assert.equal(crashed, true, "the completion must reach the insert before the crash");
  assert.equal((await freshWatchRows(tmdb)).length, 1, "the insert survived the failed write");
  assert.equal((await cachedSessionIds()).includes(sessionId), true, "the cached session survives the failed write");

  // Restarted process: a fresh liveSessionCompletion.js instance (it owns the live-session state)
  // over the same database and cache.
  const restarted = await import(`../server/src/utils/liveSessionCompletion.js?restart=${Date.now()}`);
  assert.notEqual(restarted.refreshLiveSessions, refreshLiveSessions, "the restart must load a fresh module instance");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`Unexpected fetch during test: ${url}`); };
  try {
    for (let poll = 0; poll < 4 && (await cachedSessionIds()).includes(sessionId); poll += 1) {
      await restarted.refreshLiveSessions(EMPTY_CONFIG, createLoopStore());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = await freshWatchRows(tmdb);
  assert.equal(rows.length, 1, "the retry after restart must reuse the existing watch");
  assert.ok(rows[0].sync_dispatch_telemetry, "the retry records dispatch telemetry for that row");
  assert.equal((await repo.getPlaystateForMedia(movieMedia(tmdb)))?.state, "watched");
  assert.equal((await cachedSessionIds()).includes(sessionId), false);
});
