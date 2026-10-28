import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-tenant-scheduler-");
const tenancy = await import("../server/src/utils/tenancy.js");
const leaseStore = await import("../server/src/utils/schedulerLease.js");
const jobs = await import("../server/src/utils/backgroundJobs.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { runDbOptimizeIfDue } = await import("../server/src/utils/dbMaintenance.js");
const { runPlaylistSyncScheduler } = await import("../server/src/utils/playlistSyncTriggers.js");
const { createPerUserState } = await import("../server/src/utils/perUserState.js");

tenancy.saveUsersRegistry({
  version: 1,
  users: [
    { name: "bob", role: "user", passwordHash: "x" },
    { name: "carol", role: "user", passwordHash: "x" },
  ],
}, dataDir);
const bob = { name: "bob", role: "user", dataDir: tenancy.ensureTenantDataDir("bob", dataDir) };
const carol = { name: "carol", role: "user", dataDir: tenancy.ensureTenantDataDir("carol", dataDir) };
const asBob = (fn) => runWithUserContext(bob, fn);
const asCarol = (fn) => runWithUserContext(carol, fn);

test("the leader's lease is valid inside every added user's context", () => {
  const lease = leaseStore.claimSchedulerLease({ holderId: "tenant-worker", role: "worker", ttlMs: 60_000, now: Date.now() });
  assert.ok(lease);
  const token = { holderId: "tenant-worker", generation: lease.generation };
  assert.equal(leaseStore.validateSchedulerLease(token), true);
  assert.equal(asBob(() => leaseStore.validateSchedulerLease(token)), true);
  assert.equal(asCarol(() => leaseStore.validateSchedulerLease(token)), true);
  assert.equal(asBob(() => jobs.workerAvailable()), true);
  // A tenant claim must not take over the shared lease row.
  assert.equal(asBob(() => leaseStore.claimSchedulerLease({ holderId: "other-worker", role: "worker", ttlMs: 60_000 })), null);
  assert.equal(leaseStore.releaseSchedulerLease(token), true);
});

test("an added user's queued job is claimed by the leader and stays in that user's database", () => {
  const lease = leaseStore.claimSchedulerLease({ holderId: "job-leader", role: "worker", ttlMs: 60_000, now: Date.now() });
  const token = { holderId: "job-leader", generation: lease.generation };
  const queued = asBob(() => jobs.enqueueBackgroundJob("up_next_sync", {}));
  assert.equal(jobs.getBackgroundJob(queued.id), null, "the admin database does not hold bob's job");
  assert.equal(jobs.claimNextBackgroundJob(token), null, "the admin queue is empty");
  assert.equal(asCarol(() => jobs.claimNextBackgroundJob(token)), null, "carol's queue is empty");
  const claimed = asBob(() => jobs.claimNextBackgroundJob(token));
  assert.equal(claimed?.id, queued.id);
  assert.equal(claimed.status, "running");
  assert.equal(asBob(() => jobs.finishBackgroundJob({ id: claimed.id, ...token, status: "succeeded", result: { ok: true } })), true);
  assert.equal(asBob(() => jobs.getBackgroundJob(queued.id))?.status, "succeeded");
  // A stale holder is still fenced out inside the tenant context.
  asBob(() => jobs.enqueueBackgroundJob("up_next_sync", {}));
  assert.equal(asBob(() => jobs.claimNextBackgroundJob({ holderId: "stale-worker", generation: lease.generation })), null);
  leaseStore.releaseSchedulerLease(token);
});

test("scheduled cadence is tracked per user, so the admin's run does not use up an added user's turn", async () => {
  const now = 10_000_000;
  const runs = [];
  const optimize = (who) => () => runs.push(who);
  assert.equal(runDbOptimizeIfDue(now, optimize("admin")).ran, true);
  assert.equal(asBob(() => runDbOptimizeIfDue(now + 1, optimize("bob"))).ran, true);
  assert.equal(asCarol(() => runDbOptimizeIfDue(now + 2, optimize("carol"))).ran, true);
  assert.equal(runDbOptimizeIfDue(now + 3, optimize("admin")).ran, false);
  assert.equal(asBob(() => runDbOptimizeIfDue(now + 4, optimize("bob"))).ran, false);
  assert.deepEqual(runs, ["admin", "bob", "carol"]);

  const passes = [];
  const options = (who) => ({
    now,
    convertAll: async () => { passes.push(who); return 0; },
    removeWatched: async () => ({ removed: 0 }),
    checkRules: async () => ({ checked: 0 }),
    syncAll: async () => ({ synced: 0 }),
  });
  await runPlaylistSyncScheduler(options("admin"));
  const bobResult = await asBob(() => runPlaylistSyncScheduler(options("bob")));
  assert.notEqual(bobResult?.reason, "not_due");
  const again = await runPlaylistSyncScheduler({ ...options("admin"), now: now + 1 });
  assert.equal(again.reason, "not_due");
  assert.deepEqual(passes, ["admin", "bob"]);
});

test("per-user state keeps one object per data folder", () => {
  const state = createPerUserState(() => ({ value: 0 }));
  state().value = 1;
  asBob(() => { state().value = 2; });
  assert.equal(state().value, 1);
  assert.equal(asBob(() => state().value), 2);
  assert.equal(asCarol(() => state().value), 0);
  assert.equal(asBob(() => state()), asBob(() => state()));
});
