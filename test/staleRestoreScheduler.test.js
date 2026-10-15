import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-stale-restore-scheduler-");
const { runScheduledTick } = await import("../server/src/scheduler.js");
const { setRuntimeState, loadRuntimeState, isAuthoritativeRestoreActive, clearSyncOperation } = await import("../server/src/utils/configStore.js");

async function seedRestore(heartbeat, ownerId = "restore-old") {
  await setRuntimeState({
    restoreSyncActive: true,
    restoreSyncKind: "backup_restore",
    restoreSyncRunId: ownerId,
    restoreSyncStartedAt: heartbeat,
    restoreSyncHeartbeat: heartbeat,
    syncOperation: { kind: "backup_restore", ownerId, startedAt: heartbeat, heartbeat },
  });
}

test("scheduler recovers an orphaned restore before its restore admission gate", async () => {
  await seedRestore(Date.now() - 14 * 60 * 60 * 1000);
  let checks = 0;
  // Lose leadership at the next boundary so this tests admission/recovery
  // without running unrelated provider sync work.
  const result = await runScheduledTick({ isLeader: () => ++checks === 1 });
  assert.equal(result.reason, "lease-lost");
  assert.equal(isAuthoritativeRestoreActive(), false);
  const runtime = await loadRuntimeState();
  assert.equal(runtime.restoreSyncActive, false);
  assert.equal(runtime.restoreSyncRunId, "");
  assert.equal(runtime.syncOperation, null);
  assert.equal(runtime.restoreSyncResult.reset, true);
});

test("scheduler keeps a restore with a current heartbeat fenced", async () => {
  await seedRestore(Date.now());
  const result = await runScheduledTick();
  assert.equal(result.reason, "authoritative-restore-active");
  assert.equal(isAuthoritativeRestoreActive(), true);
});

test("stale recovery cannot clear a replacement owner or a renewed heartbeat", async () => {
  const old = Date.now() - 10 * 60 * 1000;
  const staleBefore = Date.now() - 3 * 60 * 1000;
  await seedRestore(old, "replacement");
  assert.equal((await clearSyncOperation({ kind: "backup_restore", expectedOwnerId: "restore-old", staleBefore })).ok, false);
  await seedRestore(Date.now(), "restore-old");
  assert.equal((await clearSyncOperation({ kind: "backup_restore", expectedOwnerId: "restore-old", staleBefore })).ok, false);
  assert.equal(isAuthoritativeRestoreActive(), true);
});
