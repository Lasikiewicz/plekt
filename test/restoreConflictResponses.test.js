import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-restore-conflict-");
process.env.API_KEY = "restore-conflict-test-key-1234567890";
const { db } = await import("../server/src/db.js");
const runtime = await import("../server/src/utils/configStore.js");
const { insertWatchRecord } = await import("../server/src/utils/dataRepo.js");
const { enqueueBackgroundJob } = await import("../server/src/utils/backgroundJobs.js");
const routes = await import("../server/src/routes/sync.js");
const backups = await import("../server/src/routes/backups.js");
const { sendApiError } = await import("../server/src/utils/http.js");
test.before(async () => {
  const heartbeat = Date.now();
  await runtime.setRuntimeState({ restoreSyncActive: true, restoreSyncKind: "backup_restore", restoreSyncRunId: "test-restore",
    restoreSyncHeartbeat: heartbeat, syncOperation: { kind: "backup_restore", ownerId: "test-restore", heartbeat } });
});
test.after(() => db.close());
function fixture(body = {}) {
  const capture = {};
  const req = { method: "POST", body, path: "/api/force-sync/plan", query: {}, headers: { "x-api-key": process.env.API_KEY },
    get(name) { return this.headers[name.toLowerCase()] || ""; } };
  const res = { status(code) { capture.status = code; return this; }, set() { return this; }, send(body) { capture.body = JSON.parse(body); return this; } };
  return { req, res, capture };
}
for (const name of ["handleForceSync", "handleForceSyncPlan", "handleRetrySyncHistory", "handleDismissSyncHistory", "handleRetrySyncActivityGroup", "handleCronSync"]) {
  test(`${name} exposes restore-specific conflict`, async () => {
    const f = fixture(); await routes[name](f.req, f.res);
    assert.equal(f.capture.status, 409);
    assert.equal(f.capture.body.code, "RESTORE_ACTIVE");
    assert.match(f.capture.body.error, /restore is active/);
  });
}
for (const name of ["handleImport", "handleBackupImport"]) {
  test(`${name} exposes restore-specific conflict`, async () => {
    const f = fixture(); await backups[name](f.req, f.res);
    assert.equal(f.capture.status, 409);
    assert.equal(f.capture.body.code, "RESTORE_ACTIVE");
  });
}
test("automated writes and queued work throw public 409 conflicts", async () => {
  await assert.rejects(insertWatchRecord({ title: "Automated", media_type: "movie", source: "plex", watched_at: new Date().toISOString() }),
    error => error.code === "RESTORE_ACTIVE" && error.status === 409);
  assert.throws(() => enqueueBackgroundJob("force_sync_plan"), error => error.code === "RESTORE_ACTIVE" && error.status === 409);
});
test("shared HTTP error response preserves restore code/message even through a generic catch", () => {
  const f = fixture();
  sendApiError(f.res, Object.assign(new Error("internal stack trace and filesystem path"), { code: "RESTORE_ACTIVE" }),
    { error: "internal stack trace and filesystem path" }, 500);
  assert.equal(f.capture.status, 409);
  assert.deepEqual(f.capture.body, {
    error: "An authoritative watch-history restore is active. Try again when it completes.",
    code: "RESTORE_ACTIVE",
  });
});
test("manual watch route remains available while a restore is active", async () => {
  const f = fixture({ records: [1, 2].map(n => ({ title: `Manual during restore ${n}`, media_type: "movie", source: "manual", watched_at: "2026-10-01T12:00:00.000Z" })) });
  await routes.handleManualWatch(f.req, f.res);
  assert.equal(f.capture.status, 200);
  assert.equal(f.capture.body.ok, true);
  assert.equal(f.capture.body.inserted, 2);
  assert.equal(f.capture.body.rejected, 0);
  const rows = db.prepare("SELECT sync_dispatch_telemetry FROM watch_history WHERE title LIKE 'Manual during restore%'").all();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row.sync_dispatch_telemetry, /pending|defer/i);
});
test("recovered failure remains in Backups until Clear Status, which preserves unrelated work", async () => {
  const heartbeat = Date.now() - 181_000;
  await runtime.setRuntimeState({ restoreSyncHeartbeat: heartbeat, restoreSyncSummary: { success: false, error: "Restore projection failed" },
    syncOperation: { kind: "backup_restore", ownerId: "test-restore", heartbeat } });
  const { recoverStaleSyncOperation } = await import("../server/src/scheduled.js");
  await recoverStaleSyncOperation(() => {});
  const read = fixture(); read.req.method = "GET";
  await backups.handleWatchBackups(read.req, read.res);
  assert.equal(read.capture.body.restoreSync.active, false);
  assert.equal(read.capture.body.restoreSync.result.error, "Restore projection failed");
  await runtime.claimSyncOperation({ kind: "scheduled_sync", ownerId: "new-owner", activeField: "scheduledSyncActive", values: { scheduledSyncActive: true } });
  const dismiss = fixture({ action: "clear-restore-status" });
  await backups.handleWatchBackups(dismiss.req, dismiss.res);
  const latest = await runtime.loadRuntimeState();
  assert.equal(latest.restoreSyncFailureNotice, null);
  assert.equal(latest.syncOperation.ownerId, "new-owner");
});
