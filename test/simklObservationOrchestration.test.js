import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-orchestration-");
globalThis.simklTestSends = [];
const boundary = (target) => "data:text/javascript," + encodeURIComponent(
  ["Played", "Unplayed", "Progress"].map((action) =>
    `export async function ${action === "Progress" ? "set" : "mark"}${target[0].toUpperCase() + target.slice(1)}${action}(...args) { globalThis.simklTestSends.push({target:${JSON.stringify(target)},action:${JSON.stringify(action)},args}); return {status:'success'}; }`
  ).join("\n"));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/utils/syncOrchestrator.js")) {
    const target = /^\.\/(plex|emby|jellyfin)Client\.js$/.exec(specifier)?.[1];
    if (target) return { url: boundary(target), shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const inbox = await import("../server/src/utils/trackers/simklObservations.js");
const { syncSimklObservations } = await import("../server/src/utils/trackers/simklSync.js");
const { saveMediaConfig, loadMediaConfig } = await import("../server/src/utils/configStore.js");
const { applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { setPlaystateForMediaIdentitySync } = await import("../server/src/utils/dataRepo.js");
const registry = await import("../server/src/utils/trackers/registry.js");
const cursor = "2026-10-21T12:00:00Z";
const watchedAt = "2026-10-01T12:00:00.000Z";
const media = { type: "movie", mediaType: "movie", title: "Isolated import", ids: { tmdb: "991001" }, source: "simkl", isValid: true };
const rows = () => db.prepare("SELECT * FROM watch_history").all();
const queueLegacyImport = () => {
  const row = db.prepare("SELECT id,observation_json FROM tracker_observations WHERE provider='simkl' AND kind='watched'").get();
  const observation = { ...JSON.parse(row.observation_json), syncIntent: "import" };
  db.prepare("UPDATE tracker_observations SET status='pending',observation_json=? WHERE id=?").run(JSON.stringify(observation), row.id);
};
let connection, activityReads, activityCursor, beforeActivity;
const originalFetch = globalThis.fetch;

test.beforeEach(async () => {
  for (const table of ["tracker_observations", "tracker_observation_cursors", "tracker_write_intents", "tracker_item_state", "tracker_connections", "watch_history", "playstate", "loop_keys"]) db.prepare(`DELETE FROM ${table}`).run();
  globalThis.simklTestSends.length = 0;
  activityReads = 0;
  activityCursor = cursor;
  beforeActivity = () => {};
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(url).pathname, "/sync/activities", "no unexpected outbound request");
    assert.ok(!options.method || options.method === "GET");
    activityReads++;
    beforeActivity();
    return Response.json({ all: activityCursor });
  };
  await saveMediaConfig({
    plex: { disabled: true },
    emby: { disabled: false, baseUrl: "http://emby.invalid", apiKey: "test", userId: "test" },
    jellyfin: { disabled: false, baseUrl: "http://jellyfin.invalid", apiKey: "test", userId: "test" },
  });
  connection = repo.saveTrackerConnection({ provider: "simkl", clientId: "test", remoteUserId: "isolated", accessToken: "test", refreshToken: "test", initialSyncMode: "import", accessTokenExpiresAt: Date.now() + 3600000 });
  inbox.persistSimklObservations(connection, { watched: [{ media, watchedAt: Date.parse(watchedAt), timestampProvenance: "observed" }], ratings: [], review: [], activities: { all: cursor }, cursor, complete: true, absenceReconciliation: false });
});
test.after(() => { globalThis.fetch = originalFetch; });

test("the first Simkl snapshot is observed without importing its historical watches", async () => {
  beforeActivity = () => {
    assert.equal(rows().length, 0, "initial snapshot watches must not be imported");
    assert.equal(inbox.pendingSimklObservations(connection).length, 0);
  };
  const result = await syncSimklObservations({ trigger: "user" });
  assert.equal(result.watched, 0);
  assert.equal(result.pending, 0);
  assert.equal(activityReads, 1, "unchanged cursor must avoid history reads");
  assert.equal(rows().length, 0);
  assert.equal(db.prepare("SELECT status FROM tracker_observations WHERE kind='watched'").get().status, "observed");
  assert.equal(inbox.simklObservationCursor(connection), cursor);
});

for (const conflict of ["local", "outbound"]) test(`${conflict} conflict retains legacy historical work for preview`, async () => {
  queueLegacyImport();
  if (conflict === "local") setPlaystateForMediaIdentitySync(media, "unwatched", new Date().toISOString());
  else repo.recordTrackerOutbound("simkl", "movie:tmdb:991001", media, "unwatched");
  const held = await syncSimklObservations({ trigger: "user" });
  assert.equal(held.watched, 0);
  assert.equal(held.pending, 1);
  assert.equal(rows().length, 0);
  assert.equal(globalThis.simklTestSends.length, 0);
  // Clear the simulated conflict in the isolated fixture, preserving the inbox.
  db.prepare("DELETE FROM playstate").run();
  db.prepare("DELETE FROM tracker_item_state").run();
  const recovered = await syncSimklObservations({ trigger: "user" });
  assert.equal(recovered.watched, 0, "legacy historical imports remain unapplied until preview approval");
  assert.equal(recovered.pending, 1);
  assert.equal(rows().length, 0);
  assert.equal(globalThis.simklTestSends.length, 0);
});

test("a new Simkl delta fans out once to eligible destinations and provider echoes cannot bounce", async () => {
  // Simkl is registered, but only its own adapter object passes the gate.
  assert.equal(registry.isTrackerProvider("simkl"), true);
  assert.throws(() => registry.assertTrackerSafetyGate({ id: "simkl" }), { code: "TRACKER_SAFETY_GATE" });
  const eventMedia = { ...media, title: "New delta", ids: { tmdb: "991002" } };
  activityCursor = "2026-10-21T13:00:00Z";
  inbox.persistSimklObservations(connection, { watched: [{ media: eventMedia, watchedAt: Date.parse(watchedAt), timestampProvenance: "observed" }], ratings: [], review: [], activities: { all: activityCursor }, cursor: activityCursor, complete: false, absenceReconciliation: false }, { expectedCursor: cursor });
  await syncSimklObservations({ trigger: "user" });
  assert.deepEqual(globalThis.simklTestSends.map(({ target, action }) => [target, action]).sort(), [["emby", "Played"], ["jellyfin", "Played"]]);
  const config = await loadMediaConfig();
  for (const source of ["emby", "jellyfin", "simkl"]) {
    const echo = await applyWatchedTransition({ ...eventMedia, source, watched_at: watchedAt }, config, createLoopStore());
    assert.equal(echo.alreadyWatched, true, source);
  }
  await syncSimklObservations({ trigger: "user" });
  assert.equal(rows().length, 1);
  assert.equal(globalThis.simklTestSends.length, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents WHERE provider='simkl'").get().n, 0);
});

test("reconcile is rejected until a full-sync preview is approved and changes no local state", async () => {
  assert.equal((await syncSimklObservations({ trigger: "user" })).watched, 0);
  // The initial snapshot is retained as observed evidence, without a history write.
  assert.equal((await syncSimklObservations({ trigger: "user" })).watched, 0, "an ordinary check never re-imports");
  assert.equal(rows().length, 0);
  const before = db.prepare("SELECT id,status,observation_json FROM tracker_observations ORDER BY id").all();
  await assert.rejects(syncSimklObservations({ trigger: "user", reconcile: true }), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
  assert.deepEqual(db.prepare("SELECT id,status,observation_json FROM tracker_observations ORDER BY id").all(), before);
  assert.equal(rows().length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents WHERE provider='simkl'").get().n, 0);
});
