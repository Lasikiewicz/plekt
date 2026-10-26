import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-onboarding-import-recovery-");

const { claimAccount, getOnboardingState, recoverInterruptedBackgroundImports, saveOnboardingState } = await import("../server/src/utils/onboardingStore.js");
const { cancelTrackerImport, pauseTrackerImportForRestore, reconcileTrackerUntilSettled, startServerImport, startTrackerImport, trackerGateDecision } = await import("../server/src/utils/onboardingImportCoordinator.js");
const { db } = await import("../server/src/db.js");

const originalState = getOnboardingState();

test("startup recovery cancels persisted background imports without touching completed imports", () => {
  const startedAt = Date.now() - 1_000;
  saveOnboardingState({
    runState: "completed",
    backgroundImports: {
      servers: {
        plex: { enabled: true, status: "importing", startedAt, itemCount: 12 },
        emby: { enabled: true, status: "complete", startedAt, completedAt: startedAt + 100, itemCount: 24 },
      },
      trackers: { trakt: { enabled: true, status: "importing", startedAt, itemCount: 7042 } },
    },
  });

  try {
    const result = recoverInterruptedBackgroundImports();
    assert.deepEqual(result.recovered.sort(), ["plex", "trakt"]);

    const state = getOnboardingState();
    for (const provider of ["plex", "trakt"]) {
      const entry = provider === "trakt" ? state.backgroundImports.trackers.trakt : state.backgroundImports.servers[provider];
      assert.equal(entry.enabled, false);
      assert.equal(entry.status, "cancelled");
      assert.equal(entry.itemCount, provider === "trakt" ? 7042 : 12);
      assert.match(entry.error, /server restart/);
    }
    assert.equal(state.backgroundImports.servers.emby.status, "complete");
    assert.deepEqual(recoverInterruptedBackgroundImports().recovered, []);
  } finally {
    saveOnboardingState(originalState);
  }
});

test("completed onboarding cannot start an onboarding background import", async () => {
  saveOnboardingState({ runState: "completed" });

  try {
    assert.deepEqual(await startTrackerImport("trakt"), { started: false, code: "ONBOARDING_COMPLETE" });
    assert.deepEqual(await startServerImport("plex"), { started: false, code: "ONBOARDING_COMPLETE" });
  } finally {
    saveOnboardingState(originalState);
  }
});

test("claiming the instance advances onboarding to the first post-claim step", () => {
  saveOnboardingState({ accountClaimed: false, runState: "not_started", currentStep: "overview" });

  try {
    assert.equal(claimAccount(), true);
    const state = getOnboardingState();
    assert.equal(state.accountClaimed, true);
    assert.equal(state.runState, "in_progress");
    assert.equal(state.currentStep, "trackers");
  } finally {
    saveOnboardingState(originalState);
  }
});

test("a version 1 onboarding state mid-import upgrades to the version 2 tracker map", () => {
  const startedAt = Date.now() - 5_000;
  db.prepare("INSERT INTO settings (id, data, updated_at) VALUES ('onboarding', ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .run(JSON.stringify({
      version: 1,
      accountClaimed: true,
      runState: "in_progress",
      currentStep: "trakt",
      acknowledgements: { webhooks: { emby: { acknowledgedAt: 1 } }, traktSkipped: true },
      backgroundImports: {
        servers: { emby: { enabled: true, status: "importing", startedAt } },
        trakt: { enabled: true, status: "importing", startedAt, itemCount: 120 },
      },
    }), Date.now());

  try {
    const state = getOnboardingState();
    assert.equal(state.currentStep, "trackers");
    assert.equal(state.acknowledgements.trackersSkipped, true);
    assert.equal("traktSkipped" in state.acknowledgements, false);
    assert.deepEqual(state.acknowledgements.webhooks, { emby: { acknowledgedAt: 1 } });
    assert.equal("trakt" in state.backgroundImports, false);
    assert.deepEqual(state.backgroundImports.trackers.trakt, { enabled: true, status: "importing", startedAt, itemCount: 120 });
    assert.equal(state.backgroundImports.servers.emby.status, "importing");

    // The folded shape is what gets written back, and recovery treats the
    // legacy Trakt import like any other tracker import.
    saveOnboardingState({});
    const stored = JSON.parse(db.prepare("SELECT data FROM settings WHERE id = 'onboarding'").get().data);
    assert.equal(stored.backgroundImports.trakt, undefined);
    assert.equal(stored.backgroundImports.trackers.trakt.itemCount, 120);
    assert.deepEqual(recoverInterruptedBackgroundImports().recovered.sort(), ["emby", "trakt"]);
  } finally {
    saveOnboardingState(originalState);
  }
});

test("a version 2 trackersSkipped answer wins over a stale legacy flag", () => {
  saveOnboardingState({ acknowledgements: { webhooks: {}, trackersSkipped: false, traktSkipped: true } });
  try {
    assert.equal(getOnboardingState().acknowledgements.trackersSkipped, false);
  } finally {
    saveOnboardingState(originalState);
  }
});

test("media-server pulls wait on every importing tracker under one shared cap", () => {
  const now = 10 * 60 * 60_000;
  const stateWith = (trackers) => ({ backgroundImports: { servers: {}, trackers } });

  const none = trackerGateDecision(stateWith({}), now, now);
  assert.deepEqual(none, { importing: [], wait: false });

  const one = trackerGateDecision(stateWith({ trakt: { enabled: true, status: "importing" } }), now - 60_000, now);
  assert.deepEqual(one, { importing: ["trakt"], wait: true });

  const three = stateWith({
    trakt: { enabled: true, status: "complete" },
    simkl: { enabled: true, status: "importing" },
    mal: { enabled: true, status: "importing" },
    skipped: { enabled: false, status: "importing" },
  });
  assert.deepEqual(trackerGateDecision(three, now - 29 * 60_000, now), { importing: ["simkl", "mal"], wait: true });
  // The cap is shared: thirty minutes after this pull began waiting it
  // proceeds, however many trackers are still importing.
  assert.deepEqual(trackerGateDecision(three, now - 30 * 60_000, now), { importing: ["simkl", "mal"], wait: false });
});

test("each tracker's reconcile loop counts and settles on its own provider", async () => {
  const calls = [];
  const watchedByPass = { trakt: [0, 40, 0], simkl: [0, 30, 20, 10, 0] };
  const poll = async ({ provider, reconcile }) => {
    calls.push({ provider, reconcile });
    return { watched: watchedByPass[provider].shift() ?? 0 };
  };
  const reported = { trakt: [], simkl: [] };
  const [trakt, simkl] = await Promise.all(["trakt", "simkl"].map((provider) => reconcileTrackerUntilSettled(provider, {
    poll,
    count: (counted) => `${counted}-count`,
    report: (itemCount) => reported[provider].push(itemCount),
  })));
  assert.equal(trakt.passes, 3);
  assert.equal(simkl.passes, 5);
  assert.ok(calls.every((call) => call.reconcile === true));
  assert.equal(calls.filter((call) => call.provider === "trakt").length, 3);
  assert.deepEqual(new Set(reported.trakt), new Set(["trakt-count"]));
  assert.deepEqual(new Set(reported.simkl), new Set(["simkl-count"]));
});

test("only registered trackers can start an onboarding import", async () => {
  saveOnboardingState({ runState: "in_progress" });
  try {
    await assert.rejects(startTrackerImport("letterboxd"), { code: "TRACKER_UNSUPPORTED_PROVIDER" });
    // Simkl passes the gate; a completed onboarding then stops before any request.
    saveOnboardingState({ runState: "completed" });
    assert.deepEqual(await startTrackerImport("simkl"), { started: false, code: "ONBOARDING_COMPLETE" });
  } finally {
    saveOnboardingState(originalState);
  }
});

test("a restore interruption pauses tracker import without scheduling an automatic retry", (t) => {
  saveOnboardingState({
    runState: "in_progress",
    backgroundImports: { servers: {}, trackers: { trakt: { enabled: true, status: "importing" } } },
  });
  const schedule = t.mock.method(globalThis, "setTimeout", () => ({}));
  try {
    // Restore pauses the selected import. The user can start it again after
    // the restore ends, but no timer silently approves/restarts it.
    assert.equal(pauseTrackerImportForRestore("trakt"), true);
    assert.equal(schedule.mock.callCount(), 0);

    // The running pass then encounters RESTORE_ACTIVE after the user opts out.
    cancelTrackerImport("trakt");
    assert.equal(pauseTrackerImportForRestore("trakt"), false);
    assert.equal(getOnboardingState().backgroundImports.trackers.trakt.enabled, false);
    assert.equal(schedule.mock.callCount(), 0);

    assert.equal(getOnboardingState().backgroundImports.trackers.trakt.enabled, false);
    assert.equal(schedule.mock.callCount(), 0);
  } finally {
    saveOnboardingState(originalState);
  }
});
