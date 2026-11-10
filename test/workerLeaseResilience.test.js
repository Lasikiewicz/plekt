import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-worker-lease-resilience-");
process.env.PLEKT_TEST_MODE = "1";
process.env.PLEKT_TEST_LEASE_ACQUIRE_MS = "50";
process.env.PLEKT_TEST_LEASE_RENEW_MS = "50";
process.env.PLEKT_TEST_LEASE_TTL_MS = "5000";
process.env.PLEKT_TEST_FIRST_TICK_MS = "60000";
process.env.PLEKT_PAUSE_SCHEDULED_WORKER = "1";

const { createWorkerCoordinator } = await import("../server/src/workerCoordinator.js");
const { adminDb } = await import("../server/src/db.js");

test("lease renewal retries after a database error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  t.mock.method(console, "error", () => {});
  const coordinator = createWorkerCoordinator({ holderId: "lease-retry-test", role: "all" });
  try {
    await coordinator.start();
    const heartbeat = () => adminDb.prepare("SELECT heartbeat_at FROM scheduler_lease WHERE id = 'scheduler'").get().heartbeat_at;
    const initial = heartbeat();
    adminDb.exec("CREATE TRIGGER fail_test_renewal BEFORE UPDATE OF heartbeat_at ON scheduler_lease BEGIN SELECT RAISE(ABORT, 'renewal failed'); END");
    t.mock.timers.tick(50);
    await Promise.resolve();
    assert.equal(heartbeat(), initial);
    adminDb.exec("DROP TRIGGER fail_test_renewal");
    t.mock.timers.tick(50);
    await Promise.resolve();
    assert.ok(heartbeat() > initial, "the next renewal must still run");
    assert.equal(coordinator.isLeader(), true);
  } finally {
    adminDb.exec("DROP TRIGGER IF EXISTS fail_test_renewal");
    await coordinator.stop();
  }
});

test("an initial lease error does not prevent a later acquisition", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 200_000 });
  t.mock.method(console, "error", () => {});
  const coordinator = createWorkerCoordinator({ holderId: "lease-start-retry-test", role: "all" });
  try {
    adminDb.exec("CREATE TRIGGER fail_test_acquire BEFORE UPDATE OF heartbeat_at ON scheduler_lease BEGIN SELECT RAISE(ABORT, 'acquisition failed'); END");
    await coordinator.start();
    assert.equal(coordinator.isLeader(), false);
    adminDb.exec("DROP TRIGGER fail_test_acquire");
    t.mock.timers.tick(50);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(coordinator.isLeader(), true);
  } finally {
    adminDb.exec("DROP TRIGGER IF EXISTS fail_test_acquire");
    await coordinator.stop();
  }
});
