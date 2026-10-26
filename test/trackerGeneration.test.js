import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-tracker-generation-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const generation = await import("../server/src/utils/trackers/generation.js");
const { createTrackerPoller } = await import("../server/src/utils/trackers/polling.js");
const connect = (remoteUserId = "account-a", extra = {}) => repo.saveTrackerConnection({ provider: "trakt", remoteUserId, accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000, ...extra });
const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE provider='trakt'`).get().c;
const ACCOUNT_TABLES = ["tracker_item_state", "tracker_play_history", "personal_rating_sources", "personal_rating_sync_queue", "personal_rating_sync_runs"];
const seedAccountState = () => {
  const now = Date.now();
  repo.replaceTrackerSnapshot("trakt", [{ mediaKey: "movie:tmdb:1", media: { type: "movie", ids: { tmdb: "1" } }, watchedAt: now }]);
  repo.recordTrackerPlay("trakt", { historyId: "h1", mediaKey: "movie:tmdb:1", watchedAt: new Date(now).toISOString() });
  db.prepare("INSERT INTO personal_rating_sources (provider,media_key,media_json,remote_rating,remote_state) VALUES ('trakt','movie:tmdb:1','{}',8,'rated')").run();
  db.prepare("INSERT INTO personal_rating_sync_queue (provider,media_key,media_json,desired_state,desired_rating,source,intent_id,created_at,updated_at) VALUES ('trakt','movie:tmdb:1','{}','rated',8,'manual','i1',?,?)").run(now, now);
  db.prepare("INSERT INTO personal_rating_sync_runs (provider,baseline_complete,updated_at) VALUES ('trakt',1,?)").run(now);
};
const reset = () => {
  for (const table of [...ACCOUNT_TABLES, "tracker_write_intents", "tracker_connections", "tracker_auth_flows"]) db.prepare(`DELETE FROM ${table}`).run();
};
test.beforeEach(reset);

test("a different account replaces the generation and clears snapshot, plays and rating state", () => {
  const first = connect("account-a", { baselineComplete: true });
  seedAccountState();
  const refreshed = connect("account-a", { baselineComplete: true });
  assert.equal(refreshed.id, first.id, "same-account re-auth keeps the generation");
  for (const table of ACCOUNT_TABLES) assert.equal(count(table), 1, `${table} survives a same-account re-auth`);

  const replaced = connect("account-b", { baselineComplete: true });
  assert.notEqual(replaced.id, first.id);
  assert.equal(replaced.baselineComplete, false);
  for (const table of ACCOUNT_TABLES) assert.equal(count(table), 0, `${table} is cleared for the new account`);
});

test("disconnect clears rating state and a reconnect never reuses the generation", () => {
  const first = connect();
  seedAccountState();
  assert.equal(repo.deleteTrackerConnection("trakt"), true);
  for (const table of ACCOUNT_TABLES) assert.equal(count(table), 0, `${table} is cleared on disconnect`);
  assert.notEqual(connect().id, first.id);
});

test("work fenced to a replaced generation cannot mark, baseline or import into the new account", async () => {
  const old = connect("account-a");
  const replacement = connect("account-b");
  await generation.runInTrackerGeneration("trakt", old.id, async () => {
    assert.equal(generation.trackerGenerationCurrent("trakt"), false);
    assert.equal(repo.updateTrackerConnectionStatus("trakt", { baselineComplete: true, lastError: "old account failed" }), false);
    assert.equal(repo.updateTrackerTokens("trakt", { accessToken: "old", refreshToken: "old", accessTokenExpiresAt: 1 }), false);
    assert.throws(() => repo.replaceTrackerSnapshot("trakt", [{ mediaKey: "movie:tmdb:2", media: { type: "movie", ids: { tmdb: "2" } }, watchedAt: Date.now() }]), { code: "TRACKER_CONNECTION_STALE" });
    assert.throws(() => repo.recordTrackerPlay("trakt", { historyId: "old-play", mediaKey: "movie:tmdb:2", watchedAt: new Date().toISOString() }), { code: "TRACKER_CONNECTION_STALE" });
    assert.throws(() => repo.recordTrackerOutbound("trakt", "movie:tmdb:2", { type: "movie", ids: { tmdb: "2" } }, "watched"), { code: "TRACKER_CONNECTION_STALE" });
  });
  const current = repo.getTrackerConnection("trakt", { includeCredentials: true });
  assert.equal(current.id, replacement.id);
  assert.equal(current.baselineComplete, false);
  assert.equal(current.lastError, "");
  assert.equal(current.accessToken, "test");
  assert.equal(count("tracker_item_state") + count("tracker_play_history"), 0);
  // The current generation is unaffected by the fence.
  await generation.runInTrackerGeneration("trakt", replacement.id, async () => {
    assert.equal(repo.updateTrackerConnectionStatus("trakt", { lastError: "current" }), true);
  });
});

test("an auth flow cannot complete over a connection that appeared or changed after it began", () => {
  const flow = repo.createTrackerAuthFlow({ provider: "trakt", clientId: "c", deviceCode: "d", userCode: "u", verificationUrl: "https://example.test", expiresAt: Date.now() + 60_000 });
  assert.equal(repo.getTrackerAuthFlow(flow.id).expectedConnectionId, "");
  const winner = connect("account-a", { expectedConnectionId: "" });
  assert.throws(() => connect("account-b", { expectedConnectionId: "" }), { code: "TRACKER_CONNECTION_STALE" });
  assert.equal(repo.getTrackerConnection("trakt").remoteUserId, "account-a");
  const reauth = repo.createTrackerAuthFlow({ provider: "trakt", clientId: "c", deviceCode: "d", userCode: "u", verificationUrl: "https://example.test", expiresAt: Date.now() + 60_000 });
  assert.equal(repo.getTrackerAuthFlow(reauth.id).expectedConnectionId, winner.id);
  assert.equal(connect("account-a", { expectedConnectionId: winner.id }).id, winner.id);
});

test("poll single-flight is per generation and a stale poll error is not reported", async () => {
  let connections = [{ provider: "trakt", status: "connected", id: "gen-a" }];
  const releases = [];
  const polls = [];
  const errors = [];
  const poller = createTrackerPoller({
    connections: () => connections,
    poll: (provider) => new Promise((resolve, reject) => {
      polls.push(generation.trackerGenerationFence(provider));
      releases.push({ resolve, reject });
    }),
    onError: (provider, error) => errors.push(error.message),
  });
  const first = poller({});
  const shared = poller({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(polls, ["gen-a"], "same generation shares one flight");
  connections = [{ provider: "trakt", status: "connected", id: "gen-b" }];
  const replacement = poller({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(polls, ["gen-a", "gen-b"], "replacement account gets its own poll");
  releases[0].reject(new generation.StaleTrackerConnectionError("trakt"));
  releases[1].resolve({ watched: 1 });
  await assert.rejects(first, { code: "TRACKER_CONNECTION_STALE" });
  await assert.rejects(shared, { code: "TRACKER_CONNECTION_STALE" });
  assert.equal((await replacement).watched, 1);
  assert.deepEqual(errors, []);
});
