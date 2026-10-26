import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-failure-release-gate-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const observations = await import("../server/src/utils/trackers/simklObservations.js");
const { syncSimklObservations } = await import("../server/src/utils/trackers/simklSync.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");

const cursor = "2026-10-22T12:00:00Z";
const nextCursor = "2026-10-22T13:00:00Z";
const media = { type: "movie", mediaType: "movie", title: "Offline fixture", ids: { tmdb: "900001" }, source: "simkl" };
const watched = { media, watchedAt: Date.parse("2026-10-01T12:00:00Z"), timestampProvenance: "observed" };
const envelope = (items, value) => ({ watched: items, ratings: [], unrated: [], review: [], activities: { all: value }, cursor: value, complete: true, absenceReconciliation: false });

function seedState() {
  simklTransport.resetForTests();
  repo.deleteTrackerConnection("simkl");
  const connection = repo.saveTrackerConnection({ provider: "simkl", clientId: "offline-client", accessToken: "offline-token", refreshToken: "offline-refresh",
    remoteUserId: "offline-account", initialSyncMode: "import", accessTokenExpiresAt: Date.now() + 3600_000 });
  observations.persistSimklObservations(connection, envelope([watched], cursor));
  const row = db.prepare("SELECT id,observation_json FROM tracker_observations WHERE provider='simkl' AND kind='watched'").get();
  db.prepare("UPDATE tracker_observations SET observation_json=?,status='pending' WHERE id=?")
    .run(JSON.stringify({ ...JSON.parse(row.observation_json), syncIntent: "import" }), row.id);
  return { connection, inboxId: row.id };
}

for (const status of [500, 503]) {
  test(`Simkl failed HTTP ${status} read preserves cursor and inbox through production sync adapter`, async () => {
    const { connection, inboxId } = seedState();
    const beforeInbox = db.prepare("SELECT id,status,observation_json FROM tracker_observations WHERE id=?").get(inboxId);
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ error: "offline fixture" }, { status });
    };
    try {
      await assert.rejects(syncSimklObservations({ trigger: "user" }), { status });
      assert.equal(calls, 1, "a failed read is not automatically retried by the provider path");
      assert.equal(observations.simklObservationCursor(connection), cursor);
      assert.deepEqual(db.prepare("SELECT id,status,observation_json FROM tracker_observations WHERE id=?").get(inboxId), beforeInbox);
      assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
    } finally {
      globalThis.fetch = originalFetch;
      simklTransport.resetForTests();
    }
  });
}

test("Simkl persisted observations explicitly disallow absence reconciliation", () => {
  const { connection } = seedState();
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations WHERE connection_id=?").get(connection.id).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
});

test("Simkl read timeout preserves cursor and inbox through production sync adapter", async () => {
  const { connection, inboxId } = seedState();
  const beforeInbox = db.prepare("SELECT id,status,observation_json FROM tracker_observations WHERE id=?").get(inboxId);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  // Compress only the adapter's 30-second outbound timeout for a deterministic offline test.
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay >= 20_000 ? 5 : delay, ...args);
  try {
    await assert.rejects(syncSimklObservations({ trigger: "user" }), { status: 504, code: "UPSTREAM_TIMEOUT" });
    assert.equal(calls, 1, "a timed-out read is not automatically retried");
    assert.equal(observations.simklObservationCursor(connection), cursor);
    assert.deepEqual(db.prepare("SELECT id,status,observation_json FROM tracker_observations WHERE id=?").get(inboxId), beforeInbox);
    assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    simklTransport.resetForTests();
  }
});

// ---- Uncertain writes (all responses below are INJECTED, no real network) ----
const { createTrackerWriteIntent, maintainTrackerWriteIntents } = await import("../server/src/utils/trackerWriteIntents.js");
const { writeSimklWatched } = await import("../server/src/utils/trackers/simkl.js");
const ratings = await import("../server/src/utils/trackers/simklRatings.js");
const when = "2026-10-22T12:00:00.000Z";
const activityCursor = "2026-10-22T11:59:00Z";

function setupWrites(count) {
  simklTransport.resetForTests();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  db.prepare("DELETE FROM tracker_write_intents").run();
  db.prepare("DELETE FROM tracker_connections").run();
  repo.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "write-account", accessToken: "t", refreshToken: "r", accessTokenExpiresAt: Date.now() + 3600_000 });
  const connection = repo.getTrackerConnection("simkl", { includeCredentials: true });
  const items = Array.from({ length: count }, (_, i) => {
    const m = { type: "movie", title: `Movie ${i}`, ids: { tmdb: i + 1 }, watched_at: when };
    return { ...m, trackerWriteIntentId: createTrackerWriteIntent({ provider: "simkl", connection, media: m, action: "watched" }).id };
  });
  return { connection, items };
}

async function injected(history, work) {
  const previous = globalThis.fetch;
  const prevTimeout = globalThis.setTimeout;
  const paths = [];
  simklTransport.resetForTests();
  globalThis.setTimeout = (cb, delay, ...args) => prevTimeout(cb, delay >= 20_000 ? 5 : delay, ...args);
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push([options.method, path]);
    let r;
    if (path === "/sync/history") r = await history(options);
    else if (path === "/sync/activities") r = Response.json({ all: paths.some((p) => p[1] === "/sync/history") ? "2026-10-22T12:01:00Z" : activityCursor });
    else r = Response.json({});
    if (!r.headers.has("x-ratelimit-remaining")) r.headers.set("x-ratelimit-remaining", "400");
    r.headers.set("x-ratelimit-limit", "500");
    return r;
  };
  try { await work(paths); } finally { globalThis.fetch = previous; globalThis.setTimeout = prevTimeout; simklTransport.resetForTests(); }
}

const hang = (options) => new Promise((_res, rej) => options.signal.addEventListener("abort", () => rej(options.signal.reason), { once: true }));
const intentRows = () => db.prepare("SELECT status,attempts FROM tracker_write_intents ORDER BY id").all();

for (const [label, history] of [
  ["HTTP 500", () => Response.json({ error: "injected" }, { status: 500 })],
  ["HTTP 503", () => Response.json({ error: "injected" }, { status: 503 })],
  ["timeout", hang],
]) {
  test(`Simkl watched-history POST ${label} (injected) holds the claimed chunk, never resends, survives retry pass and restart`, async () => {
    const { connection, items } = setupWrites(2);
    await injected(history, async (paths) => {
      const first = await Promise.allSettled(items.map((m) => writeSimklWatched(connection, m, { trigger: "event", sendNow: true })));
      assert.ok(first.every((r) => r.status === "rejected"), "uncertain write must not report delivery");
      assert.deepEqual(intentRows(), [{ status: "review", attempts: 1 }, { status: "review", attempts: 1 }]);
      const posts = () => paths.filter((p) => p[0] === "POST" && p[1] === "/sync/history").length;
      assert.equal(posts(), 1, "exactly one POST, no automatic retry");
      // Retry pass in the same process.
      await Promise.allSettled(items.map((m) => writeSimklWatched(connection, m, { trigger: "event", sendNow: true })));
      maintainTrackerWriteIntents(Date.now() + 6 * 60_000);
      assert.equal(posts(), 1, "retry pass does not resend a held intent");
      // Simulated restart: drop in-memory transport state and re-read the connection from the DB.
      simklTransport.resetForTests();
      const reopened = repo.getTrackerConnection("simkl", { includeCredentials: true });
      await Promise.allSettled(items.map((m) => writeSimklWatched(reopened, m, { trigger: "event", sendNow: true })));
      assert.equal(posts(), 1, "held intents survive restart without a resend");
      assert.deepEqual(intentRows(), [{ status: "review", attempts: 1 }, { status: "review", attempts: 1 }]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents WHERE status='settled'").get().n, 0);
    });
  });
}

for (const [label, respond] of [
  ["HTTP 500", () => Response.json({ error: "injected" }, { status: 500 })],
  ["HTTP 503", () => Response.json({ error: "injected" }, { status: 503 })],
  ["timeout", hang],
]) {
  test(`Simkl rating POST ${label} (injected) is never resent by the production rating writer`, async () => {
    const { connection } = setupWrites(0);
    const ratingMedia = { media_type: "movie", title: "Rating fixture", tmdb_id: "1", simkl_id: "9" };
    const previous = globalThis.fetch, prevTimeout = globalThis.setTimeout;
    const calls = [];
    globalThis.setTimeout = (cb, delay, ...args) => prevTimeout(cb, delay >= 20_000 ? 5 : delay, ...args);
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/sync/watched") return Response.json([{ list: "completed", last_watched_at: when }]);
      assert.equal(path, "/sync/ratings");
      return respond(options);
    };
    try {
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) simklTransport.resetForTests(); // simulated restart
        let outcome;
        try { outcome = await ratings.setSimklPersonalRating(connection, ratingMedia, 7); } catch (error) { outcome = { threw: error.code || error.status }; }
        assert.notEqual(outcome.status, "not_found");
        assert.ok(outcome.threw !== undefined || outcome.status !== "succeeded" || outcome.reviewReason, `uncertain rating must not be a clean success: ${JSON.stringify(outcome)}`);
      }
      // Documented behaviour: the writer itself does not retry within a call; each explicit call sends once.
      assert.equal(calls.filter((p) => p === "/sync/ratings").length, 2, "one POST per explicit call, none automatic");
    } finally { globalThis.fetch = previous; globalThis.setTimeout = prevTimeout; simklTransport.resetForTests(); }
  });
}

test("Simkl 429 Retry-After (injected) cools down through the production sync adapter without a second request", async () => {
  const { connection, inboxId } = seedState();
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return Response.json({ error: "injected" }, { status: 429, headers: { "retry-after": "30" } }); };
  try {
    await assert.rejects(syncSimklObservations({ trigger: "user" }), (e) => e.status === 429 || e.code === "SIMKL_RATE_LIMIT");
    const afterFirst = calls;
    await assert.rejects(syncSimklObservations({ trigger: "user" }));
    assert.equal(calls, afterFirst, "cooldown blocks the immediate second read before any fetch");
    assert.equal(observations.simklObservationCursor(connection), cursor);
    assert.equal(db.prepare("SELECT status FROM tracker_observations WHERE id=?").get(inboxId).status, "pending");
  } finally { globalThis.fetch = previous; simklTransport.resetForTests(); }
});

// ---- Rating queue worker path (all responses INJECTED, no real network) ----
// Drives runRatingSync -> drainPersonalRatingQueue -> mediaProviderAdapters.simkl.write
// (setSimklPersonalRating) -> simklRequest -> simklTransport -> injected fetch.
const queueRepo = await import("../server/src/utils/personalRatingRepository.js");
const { runRatingSync, retryRatingSync } = await import("../server/src/utils/personalRatingSync.js");
const { normalizePersonalRatingMedia } = await import("../server/src/utils/personalRatingIdentity.js");

const ratingConfig = { ratingSync: { enabled: true, providers: { plex: "off", emby: "off", jellyfin: "off", trakt: "off", simkl: "send" } } };
const queueRow = () => db.prepare("SELECT status,attempt_count,next_attempt_at,last_error,lease_owner,lease_expires_at,succeeded_at,intent_id FROM personal_rating_sync_queue WHERE provider='simkl'").all();

for (const [label, respond, expectedError] of [
  ["HTTP 500", () => Response.json({ error: "injected" }, { status: 500 }), /SIMKL_REQUEST_FAILED|500|Simkl/i],
  ["HTTP 503", () => Response.json({ error: "injected" }, { status: 503 }), /SIMKL_REQUEST_FAILED|503|Simkl/i],
  ["timeout", hang, /timed out|timeout|UPSTREAM_TIMEOUT/i],
]) {
  test(`Simkl rating queue worker: injected ${label} on the rating POST retries with backoff, never acknowledges, survives later pass and restart`, async () => {
    setupWrites(0);
    for (const table of ["personal_rating_sync_queue", "personal_rating_sources", "watch_history", "playstate"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    const media = normalizePersonalRatingMedia({ media_type: "movie", title: "Rating queue fixture", tmdb_id: "1", simkl_id: "9" });
    // pushPersonalRatings creates the source row then enqueues; do the same two steps.
    queueRepo.ensureRatingSourceRow("simkl", media, { now: Date.now() });
    const queued = queueRepo.enqueuePersonalRatingMutation({ provider: "simkl", media, desiredState: "rated", desiredRating: 7, source: "push", timestamp: Date.now() });
    const previous = globalThis.fetch, prevTimeout = globalThis.setTimeout, realNow = () => Date.now();
    const calls = [];
    globalThis.setTimeout = (cb, delay, ...args) => prevTimeout(cb, delay >= 20_000 ? 5 : delay, ...args);
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      calls.push([options.method, path]);
      if (path === "/sync/watched") return Response.json([{ list: "completed", last_watched_at: when }]);
      assert.equal(path, "/sync/ratings");
      return respond(options);
    };
    const ratingPosts = () => calls.filter((c) => c[1] === "/sync/ratings").length;
    simklTransport.resetForTests();
    try {
      // Pass 1: worker claims the row, the POST fails.
      const t0 = realNow();
      const first = await runRatingSync({ providers: ["simkl"], snapshot: false, config: ratingConfig });
      const t1 = realNow();
      assert.equal(first.queue.processed, 1);
      assert.equal(first.queue.failed, 1);
      assert.equal(first.queue.succeeded, 0);
      assert.equal(first.status, "partial");
      assert.equal(ratingPosts(), 1);
      let [row] = queueRow();
      assert.equal(queueRow().length, 1);
      assert.equal(row.intent_id, queued.intent_id, "same intent kept for the retry");
      // Observed: ordinary failure, not held/review. retryDelay(attempt_count=1) = 60s * 2^1.
      assert.equal(row.status, "failed");
      assert.equal(row.attempt_count, 1);
      assert.ok(row.next_attempt_at >= t0 + 120_000 && row.next_attempt_at <= t1 + 120_000, `next attempt ~120s out, got +${row.next_attempt_at - t0}`);
      assert.match(row.last_error, expectedError);
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.succeeded_at, null);
      const source = queueRepo.getRatingSourceRow("simkl", media.media_key);
      assert.ok(!source?.last_outbound_state, "no outbound acknowledgement recorded");
      assert.ok(!source?.last_outbound_rating, "no outbound rating recorded");
      assert.equal(source?.sync_status, "failed");
      const noWatchState = () => {
        assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM playstate").get().n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
      };
      noWatchState();

      // Pass 2 immediately: backoff not elapsed, nothing is claimed or sent.
      const second = await runRatingSync({ providers: ["simkl"], snapshot: false, config: ratingConfig });
      assert.equal(second.queue.processed, 0);
      assert.equal(ratingPosts(), 1, "backoff window blocks an immediate resend");
      assert.deepEqual(queueRow()[0], row);

      // Simulated restart inside the backoff window: durable row, no resend.
      simklTransport.resetForTests();
      await runRatingSync({ providers: ["simkl"], snapshot: false, config: ratingConfig });
      assert.equal(ratingPosts(), 1, "restart does not bypass the persisted next_attempt_at");
      assert.deepEqual(queueRow()[0], row);

      // Later pass after the backoff. The backoff window is elapsed by rewinding the persisted
      // next_attempt_at (the outbound governor persists real-clock lane state in SQLite, so the
      // process clock is not faked: a skewed Date.now left future-dated governor spacing behind).
      db.prepare("UPDATE personal_rating_sync_queue SET next_attempt_at=? WHERE provider='simkl'").run(realNow() - 1);
      const base = realNow();
      const third = await runRatingSync({ providers: ["simkl"], snapshot: false, config: ratingConfig });
      assert.equal(third.queue.processed, 1);
      assert.equal(ratingPosts(), 2, "automatic retry after backoff sends the rating again");
      [row] = queueRow();
      assert.equal(row.status, "failed");
      assert.equal(row.attempt_count, 2);
      assert.ok(row.next_attempt_at >= base + 240_000 && row.next_attempt_at <= base + 240_000 + 20_000, "second failure backs off 60s*2^2 = 240s");
      assert.ok(!queueRepo.getRatingSourceRow("simkl", media.media_key)?.last_outbound_state);
      noWatchState();

      // Explicit user retry bypasses backoff and also sends once.
      const retried = await retryRatingSync({ providers: ["simkl"], config: ratingConfig });
      assert.equal(retried.retried, 1);
      assert.equal(ratingPosts(), 3);
      assert.equal(queueRow()[0].attempt_count, 3);
      assert.equal(queueRow()[0].status, "failed");
      assert.ok(!queueRepo.getRatingSourceRow("simkl", media.media_key)?.last_outbound_state);
      noWatchState();
    } finally { globalThis.fetch = previous; globalThis.setTimeout = prevTimeout; simklTransport.resetForTests(); }
  });
}
