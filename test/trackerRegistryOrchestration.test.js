import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// The registry reaches db.js through the Simkl adapter: set the data dir first.
makeTempDataDir("plekt-tracker-registry-");
const { createTrackerPoller } = await import("../server/src/utils/trackers/polling.js");
const { assertTrackerEnabled, assertTrackerSafetyGate, getTrackerAdapter, isTrackerProvider, trackerProviderForSource, trackerProviderIds } = await import("../server/src/utils/trackers/registry.js");
const { mergeTrackerWatchedDates, earliestTrackerWatchedAt } = await import("../server/src/utils/trackers/watchedDates.js");
const { settledTrackerHistoryTelemetry } = await import("../server/src/utils/trackers/telemetry.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { db } = await import("../server/src/db.js");
const movie = { type: "movie", ids: { tmdb: "123", imdb: "tt123" } };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("registry classifies live, import and legacy tracker sources without claiming other providers", () => {
  for (const source of ["trakt", "TRAKT", "trakt_import", "legacy_trakt_source"]) assert.equal(trackerProviderForSource(source), "trakt");
  for (const source of ["simkl", "simkl_import"]) assert.equal(trackerProviderForSource(source), "simkl");
  for (const source of ["manual", "plex", "letterboxd", ""]) assert.equal(trackerProviderForSource(source), "");
  assert.equal(isTrackerProvider(" Trakt "), true);
  assert.equal(isTrackerProvider("simkl"), true);
  assert.equal(assertTrackerEnabled("trakt").id, "trakt");
  assert.equal(assertTrackerEnabled("simkl").id, "simkl");
});

test("an unknown tracker cannot save credentials or start authorization; look-alike adapters stay fenced", () => {
  assert.throws(() => assertTrackerSafetyGate({ ...getTrackerAdapter("trakt"), id: "future" }), { code: "TRACKER_SAFETY_GATE" });
  assert.throws(() => assertTrackerSafetyGate({ ...getTrackerAdapter("simkl") }), { code: "TRACKER_SAFETY_GATE" });
  assert.throws(() => assertTrackerEnabled("future"), { code: "TRACKER_UNSUPPORTED_PROVIDER" });
  assert.throws(() => repo.saveTrackerConnection({ provider: "future", accessToken: "never-persist" }), /Unsupported tracker/);
  assert.throws(() => repo.createTrackerAuthFlow({ provider: "future" }), /Unsupported tracker/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_connections").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_auth_flows").get().count, 0);
});

test("polling is single-flight per provider while another provider completes independently", async () => {
  const held = deferred();
  const calls = [];
  const poll = createTrackerPoller({
    connections: () => ["a", "b"].map((provider) => ({ provider, status: "connected" })),
    poll: async (provider) => { calls.push(provider); if (provider === "a") await held.promise; return { watched: 1, unwatched: 0 }; },
    onError: () => assert.fail("unexpected error"),
  });
  const first = poll({ provider: "a" });
  const second = poll({ provider: "a" });
  assert.equal((await poll({ provider: "b" })).watched, 1);
  assert.deepEqual(calls, ["a", "b"]);
  held.resolve();
  assert.equal((await first).watched, 1);
  assert.equal((await second).watched, 1);
  assert.deepEqual(calls, ["a", "b"]);
});

test("provider failures retain attribution and do not cancel a sibling result", async () => {
  const errors = [];
  const poll = createTrackerPoller({
    connections: () => ["a", "b"].map((provider) => ({ provider, status: "connected" })),
    poll: async (provider) => { if (provider === "a") throw new Error("a unavailable"); return { watched: 2, unwatched: 1 }; },
    onError: (provider, error) => errors.push([provider, error.message]),
  });
  const result = await poll();
  assert.equal(result.watched, 2);
  assert.equal(result.providers.a.error, "a unavailable");
  assert.equal(result.providers.b.unwatched, 1);
  assert.deepEqual(errors, [["a", "a unavailable"]]);
  await assert.rejects(poll({ provider: "a" }), /a unavailable/);
});

test("providers without the requested trigger are skipped before any poll or error stamp", async () => {
  const calls = [];
  const errors = [];
  const poll = createTrackerPoller({
    connections: () => ["a", "b"].map((provider) => ({ provider, status: "connected" })),
    poll: async (provider, options) => { calls.push([provider, options.trigger]); return { watched: 1, unwatched: 0 }; },
    onError: (provider) => errors.push(provider),
    eligible: (provider, { trigger = "scheduled" } = {}) => provider === "a" || trigger !== "scheduled",
  });
  const scheduled = await poll();
  assert.deepEqual(Object.keys(scheduled.providers), ["a"]);
  assert.deepEqual(await poll({ provider: "b" }), { skipped: true, reason: "trigger-unsupported", watched: 0, unwatched: 0 });
  assert.equal((await poll({ provider: "b", trigger: "event" })).watched, 1);
  assert.deepEqual(calls, [["a", undefined], ["b", "event"]]);
  assert.deepEqual(errors, []);
});

test("an explicit reconcile waits for a normal poll and shares its own provider flight", async () => {
  const held = deferred();
  const calls = [];
  const poll = createTrackerPoller({
    connections: () => [{ provider: "a", status: "connected" }],
    poll: async (provider, options) => { calls.push(Boolean(options.reconcile)); if (!options.reconcile) await held.promise; return { reconcile: Boolean(options.reconcile) }; },
    onError: () => {},
  });
  const normal = poll();
  const reconcile = poll({ reconcile: true });
  const alsoReconcile = poll({ reconcile: true });
  await Promise.resolve();
  assert.deepEqual(calls, [false]);
  held.resolve();
  await normal;
  assert.equal((await reconcile).reconcile, true);
  assert.equal((await alsoReconcile).reconcile, true);
  assert.deepEqual(calls, [false, true]);
});

test("date anchors merge aliases across providers and reject synthetic or invalid timestamps", () => {
  const adapter = getTrackerAdapter("trakt");
  const index = mergeTrackerWatchedDates([
    { provider: "a", snapshot: [{ media: movie, watchedAt: 3000 }] },
    { provider: "b", snapshot: [
      { media: movie, watchedAt: 2000 }, { media: movie, watchedAt: 1000, timestampProvenance: "rating" },
      { media: movie, watchedAt: 500, timestampProvenance: "unknown" },
      ...[null, 0, -1, NaN].map((watchedAt) => ({ media: movie, watchedAt })),
    ] },
  ], () => adapter);
  assert.equal(earliestTrackerWatchedAt(index, movie), 2000);
  assert.equal(index.get("movie:imdb:tt123"), 2000);
});

test("Trakt previous-episode date fallback stays scoped to its own observations", () => {
  const adapter = getTrackerAdapter("trakt");
  const media = { type: "episode", ids: { tmdb: "9" }, season: 1, episode: 1 };
  const index = mergeTrackerWatchedDates([
    { provider: "trakt", snapshot: [{ media, watchedAt: 3000 }] },
    { provider: "other", snapshot: [{ media, watchedAt: 1000 }] },
  ], (provider) => provider === "trakt" ? adapter : { ...adapter, policies: { defaultTimestampProvenance: "observed" } });
  assert.equal(earliestTrackerWatchedAt(index, media), 1000);
  assert.equal(earliestTrackerWatchedAt(index, { ...media, episode: 2 }), 3000);
});

test("historical-play telemetry settles every registered destination", () => {
  const telemetry = settledTrackerHistoryTelemetry("trakt_import", "Historical observation");
  for (const provider of ["plex", "emby", "jellyfin", ...trackerProviderIds()]) assert.ok(telemetry.includes(`Target ${provider} status: skipped`));
  assert.ok(!telemetry.includes("pending"));
});

test("unwatch grace periods are isolated even when providers share the same media key", async () => {
  const { partitionPendingTrackerUnwatches, TRAKT_UNWATCH_CONFIRMATION_MS } = await import("../server/src/utils/trackerSync.js");
  const item = { mediaKey: "movie:tmdb:isolated", media: movie };
  assert.equal(partitionPendingTrackerUnwatches("a", [item], new Map(), 1000).heldBack.length, 1);
  assert.equal(partitionPendingTrackerUnwatches("b", [item], new Map(), 1000 + TRAKT_UNWATCH_CONFIRMATION_MS).heldBack.length, 1);
  assert.equal(partitionPendingTrackerUnwatches("a", [item], new Map(), 1001 + TRAKT_UNWATCH_CONFIRMATION_MS).unwatched.length, 1);
  assert.equal(partitionPendingTrackerUnwatches("b", [], new Map([[item.mediaKey, item]]), 2000).unwatched.length, 0);
});

test("tracker dispatch honors explicit targets and normalizes their case", async () => {
  repo.saveTrackerConnection({ provider: "trakt", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
  const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
  const media = { ...movie, source: "trakt" };
  assert.deepEqual(await dispatchTrackerWatchState({ ...media, syncTargets: ["emby"] }, "watched"), []);
  const result = await dispatchTrackerWatchState({ ...media, syncTargets: [" TRAKT "] }, "watched");
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "trakt");
  assert.equal(result[0].detail, "Source tracker echo suppressed");
});

test("a Simkl-sourced change is never written back to Simkl", async () => {
  repo.saveTrackerConnection({ provider: "simkl", remoteUserId: "simkl-echo", clientId: "client", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not contact Simkl"); };
  try {
    const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
    for (const source of ["simkl", "simkl_import"]) {
      const result = await dispatchTrackerWatchState({ ...movie, source, watched_at: "2026-10-01T12:00:00.000Z", syncTargets: ["simkl"] }, "watched");
      assert.deepEqual(result.map(({ target, status, detail }) => ({ target, status, detail })), [{ target: "simkl", status: "skipped", detail: "Source tracker echo suppressed" }]);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents WHERE provider='simkl'").get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    repo.deleteTrackerConnection("simkl");
  }
});

test("scheduled polling skips Simkl without a request or error; media events check it at most once per window", async () => {
  const sync = await import("../server/src/utils/trackerSync.js");
  repo.deleteTrackerConnection("trakt");
  repo.saveTrackerConnection({ provider: "simkl", remoteUserId: "simkl-poll", clientId: "client", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not contact Simkl"); };
  try {
    assert.deepEqual(await sync.pollConnectedTrackers(), { skipped: true, reason: "trigger-unsupported", watched: 0, unwatched: 0 });
    assert.equal(repo.getTrackerConnection("simkl").lastError, "", "no per-minute error stamp");
    const polls = [];
    const poll = async (options) => { polls.push(options); return {}; };
    sync.resetTrackerEventCheckThrottle();
    const start = 1_000_000;
    await sync.checkTrackersAfterMediaEvent({ now: start, poll });
    assert.equal(sync.checkTrackersAfterMediaEvent({ now: start + sync.TRACKER_EVENT_CHECK_THROTTLE_MS - 1, poll }), null);
    await sync.checkTrackersAfterMediaEvent({ now: start + sync.TRACKER_EVENT_CHECK_THROTTLE_MS, poll });
    assert.deepEqual(polls, [{ provider: "simkl", trigger: "event" }, { provider: "simkl", trigger: "event" }]);
    // A failed check is logged, never thrown into the webhook path.
    const logged = [];
    sync.resetTrackerEventCheckThrottle();
    await sync.checkTrackersAfterMediaEvent({ now: start, poll: async () => { throw new Error("offline"); }, logger: (...args) => logged.push(args) });
    assert.equal(logged.length, 1);
    // Trakt already polls on the scheduler, so it never consumes the window.
    repo.deleteTrackerConnection("simkl");
    repo.saveTrackerConnection({ provider: "trakt", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
    sync.resetTrackerEventCheckThrottle();
    assert.equal(sync.checkTrackersAfterMediaEvent({ now: start, poll }), null);
    assert.equal(polls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    sync.resetTrackerEventCheckThrottle();
    repo.deleteTrackerConnection("simkl");
  }
});
