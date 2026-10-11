import { runForceSync, runScheduledSync } from "./scheduled.js";
import { runTmdbMetadataRefreshJob, runTvdbMetadataRefreshJob } from "./routes/maintenance.js";
import { PLAYSTATE_ALIAS_REPAIR_JOB, runPlaystateAliasRepairJob } from "./utils/playstateAliasRepair.js";
import { runRetryAllSyncActivityJob } from "./routes/sync.js";
import { collectServerWatchedItems, buildForceSyncPlan } from "./utils/forceSyncPlanner.js";
import { createSyncPlanRecord } from "./utils/syncPlans.js";
import { getCachedHistory } from "./utils/dataRepo.js";
import { loadMediaConfig } from "./utils/configStore.js";
import {
  runScheduledTick,
  startPlexNotificationListener,
  stopPlexNotificationListener,
  restartPlexNotificationListener,
  startPlexAdaptivePoller,
  stopPlexAdaptivePoller,
  restartPlexAdaptivePoller,
  startLiveSessionPoller,
  stopLiveSessionPoller,
} from "./scheduler.js";
import { refreshUpcomingCalendarCache } from "./utils/upcomingCalendarCache.js";
import { backfillUnknownShowTitles, backfillMissingEpisodeSeasons } from "./utils/dataRepo.js";
import { UP_NEXT_AUTO_SYNC_JOB, UP_NEXT_PRIORITY_SYNC_JOB, requestUpNextAutoSync, runAutomaticUpNextSync } from "./utils/upNextAutoSync.js";
import { db } from "./db.js";
import { setRuntimeState } from "./utils/configStore.js";
import { yieldToEventLoop } from "./utils/eventLoop.js";
import { brandEnv } from "./utils/brandEnv.js";
import {
  claimSchedulerLease,
  markSchedulerTick,
  releaseSchedulerLease,
  renewSchedulerLease,
  validateSchedulerLease,
} from "./utils/schedulerLease.js";
import {
  appendBackgroundJobLog,
  claimNextBackgroundJob,
  finishBackgroundJob,
  getBackgroundJob,
  heartbeatBackgroundJob,
  pruneBackgroundJobs,
} from "./utils/backgroundJobs.js";

function timing(name, fallback) {
  if (brandEnv("TEST_MODE") !== "1") return fallback;
  const value = Number(brandEnv(name));
  return Number.isFinite(value) && value >= 25 ? value : fallback;
}

const ACQUIRE_MS = timing("TEST_LEASE_ACQUIRE_MS", 5_000);
const RENEW_MS = timing("TEST_LEASE_RENEW_MS", 10_000);
const LEASE_TTL_MS = timing("TEST_LEASE_TTL_MS", 60_000);
const TICK_MS = timing("TEST_TICK_MS", 60_000);
const FIRST_TICK_MS = timing("TEST_FIRST_TICK_MS", 10_000);
const JOB_POLL_MS = timing("TEST_JOB_POLL_MS", 1_000);
// Useful for diagnostics that need the real-time provider listeners without
// letting an existing scheduled/backlog pass compete with the event under
// test. The default remains the normal combined worker behavior.
const SCHEDULED_WORKER_PAUSED = ["1", "true", "yes", "on"].includes(
  String(brandEnv("PAUSE_SCHEDULED_WORKER") || "").trim().toLowerCase(),
);

// How long to wait before the next tick, given how long the current one has
// already taken. Timing from the tick's start keeps the period at `tickMs`
// whatever the tick costs; waiting `tickMs` after it *finishes* makes the real
// period `tickMs + tick duration`, which compounds - a 60-tick provider-backed
// run drifted to 68.19 minutes of wall clock instead of 59, a 15.6% shortfall
// in how often everything scheduled runs (finding AH).
//
// A tick that overruns its period skips the periods it consumed rather than
// firing a catch-up burst, and an exact multiple returns a whole period rather
// than 0 so the timer can never schedule a same-instant re-entry.
export function nextTickDelayMs(elapsedMs, tickMs) {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (elapsed < tickMs) return tickMs - elapsed;
  return tickMs - (elapsed % tickMs);
}

export function createWorkerCoordinator({ holderId, role }) {
  let lease = null;
  let stopped = false;
  let tickRunning = false;
  let jobRunning = false;
  let activeTickPromise = null;
  let activeJobPromise = null;
  let activeStartupScanPromise = null;
  let lastSettingsUpdatedAt = null;
  let startupScanGeneration = null;
  const timers = new Set();

  const isLeader = () => Boolean(lease && validateSchedulerLease({ holderId, generation: lease.generation }));
  const later = (fn, ms) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopped) return;
      try { await fn(); } catch (error) { console.error("Worker coordinator task failed", error); }
    }, ms);
    timers.add(timer);
  };

  async function finishStartupScan(generation) {
    if (startupScanGeneration !== generation) return;
    startupScanGeneration = null;
    await setRuntimeState({
      startupScanActive: false,
      startupScanCompletedAt: Date.now(),
    }).catch(() => null);
  }

  async function runStartupMaintenance(generation) {
    try {
      // Keep leadership acquisition and the first authenticated HTTP requests
      // cheap. The historical-title/season backfills are synchronous SQLite
      // work and can monopolize the event loop for seconds on a large library,
      // so they are scheduled below after the initial startup window.
      await yieldToEventLoop();
    } finally {
      if (startupScanGeneration !== generation || stopped || !isLeader()) return;
      // Deferred startup work belongs to this leadership term only. A timer
      // left over from a lost term must not start pollers or scans under a
      // later lease.
      const stillCurrentLeader = () => !stopped && lease?.generation === generation && isLeader();
      // Give the web process one clean startup window before opening the
      // provider sockets/pollers. This is tied to the first scheduled tick,
      // rather than an independent arbitrary timeout, and keeps a provider
      // outage from competing with the initial authenticated page load.
      const startProviderPollers = () => {
        if (!stillCurrentLeader()) return;
        startPlexNotificationListener();
        startPlexAdaptivePoller();
        startLiveSessionPoller();
      };
      later(startProviderPollers, FIRST_TICK_MS);
      // The startup scan stays "active" (the sidebar's Scanning label and the
      // Sync Activity notice) until these backfills have actually run. The
      // flag does not block requests, so keeping it truthful costs nothing.
      later(async () => {
        const backfills = (async () => {
          try {
            if (!stillCurrentLeader()) return;
            await backfillUnknownShowTitles().catch((error) => console.error("backfillUnknownShowTitles failed", error));
            await yieldToEventLoop();
            if (!stillCurrentLeader()) return;
            await backfillMissingEpisodeSeasons().catch((error) => console.error("backfillMissingEpisodeSeasons failed", error));
          } finally {
            await finishStartupScan(generation);
          }
        })();
        // stop() waits on this promise, so shutdown cannot interrupt a
        // backfill part-way through its writes.
        activeStartupScanPromise = backfills;
        try {
          await backfills;
        } finally {
          if (activeStartupScanPromise === backfills) activeStartupScanPromise = null;
        }
      }, FIRST_TICK_MS + 1_000);
      // Episode identity repair is already a scheduled tick step. Keeping it
      // out of the leadership-acquisition path avoids running the same large
      // synchronous repair twice during a restart loop.
      if (!SCHEDULED_WORKER_PAUSED) {
        later(() => refreshUpcomingCalendarCache({ forceCurrent: true }), 0);
        later(async () => {
          await runTick();
        }, FIRST_TICK_MS);
      } else {
        console.log("[worker] scheduled sync and background jobs paused by PLEKT_PAUSE_SCHEDULED_WORKER");
      }
    }
  }

  function queueStartupMaintenance(generation) {
    const promise = runStartupMaintenance(generation).catch((error) => {
      console.error("Startup maintenance failed", error);
    });
    activeStartupScanPromise = promise;
    promise.then(() => {
      if (activeStartupScanPromise === promise) activeStartupScanPromise = null;
    });
  }

  async function becomeLeader(nextLease) {
    const changed = !lease || lease.generation !== nextLease.generation;
    lease = nextLease;
    if (!changed) return;
    console.log(`[worker] scheduler leadership acquired (generation ${lease.generation})`);
    const startupGeneration = lease.generation;
    startupScanGeneration = startupGeneration;
    await setRuntimeState({
      startupScanActive: true,
      startupScanStartedAt: Date.now(),
      startupScanCompletedAt: 0,
    }).catch(() => null);
    queueStartupMaintenance(startupGeneration);
  }

  function loseLeadership(reason) {
    if (!lease) return;
    console.warn(`[worker] scheduler leadership lost: ${reason}`);
    const lostStartupGeneration = startupScanGeneration;
    startupScanGeneration = null;
    if (lostStartupGeneration !== null) {
      setRuntimeState({ startupScanActive: false, startupScanCompletedAt: Date.now() }).catch(() => null);
    }
    lease = null;
    stopPlexNotificationListener();
    stopPlexAdaptivePoller();
    stopLiveSessionPoller();
  }

  async function maintainLease() {
    if (stopped) return;
    if (lease) {
      const renewed = renewSchedulerLease({ holderId, generation: lease.generation, ttlMs: LEASE_TTL_MS });
      if (!renewed) loseLeadership("renewal rejected");
      else lease.expiresAt = Date.now() + LEASE_TTL_MS;
    }
    if (!lease) {
      const claimed = claimSchedulerLease({ holderId, role, ttlMs: LEASE_TTL_MS });
      if (claimed) await becomeLeader(claimed);
    }
    if (lease) {
      const settingsUpdatedAt = Number(db.prepare("SELECT updated_at FROM settings WHERE id='mediaConfig'").get()?.updated_at || 0);
      if (lastSettingsUpdatedAt !== null && settingsUpdatedAt !== lastSettingsUpdatedAt) {
        restartPlexNotificationListener();
        restartPlexAdaptivePoller();
      }
      lastSettingsUpdatedAt = settingsUpdatedAt;
    }
    later(maintainLease, lease ? RENEW_MS : ACQUIRE_MS);
  }

  // The next tick is timed from this tick's START, not from when it finishes.
  // Waiting a full TICK_MS after completion makes the real period
  // `TICK_MS + tick duration`, so every slow tick permanently delays every
  // later one and the drift compounds: a 60-tick provider-backed run took
  // 68.19 minutes of wall clock instead of 59, a 15.6% shortfall in how often
  // everything scheduled actually runs.
  //
  // A tick that overruns its own period does not fire a catch-up burst. The
  // whole periods it consumed are skipped and the next tick lands on the
  // following boundary, so a slow tick costs the ticks it overran and nothing
  // more. An exact multiple returns a full period rather than 0, so the timer
  // never schedules a same-instant re-entry.
  async function runTick() {
    if (stopped) return;
    const startedAt = Date.now();
    if (!tickRunning && isLeader()) {
      tickRunning = true;
      try {
        markSchedulerTick({ holderId, generation: lease.generation });
        activeTickPromise = runScheduledTick({ isLeader });
        await activeTickPromise;
      } catch (error) {
        console.error("Scheduled tick failed", error);
      } finally {
        tickRunning = false;
        activeTickPromise = null;
      }
    }
    later(runTick, nextTickDelayMs(Date.now() - startedAt, TICK_MS));
  }

  async function executeJob(job) {
    const token = { id: job.id, holderId, generation: lease.generation };
    const log = (message) => {
      console.log(message);
      appendBackgroundJobLog(job.id, message);
    };
    const heartbeat = setInterval(() => {
      heartbeatBackgroundJob(token);
    }, Math.min(30_000, Math.max(1_000, Math.floor(LEASE_TTL_MS / 3))));
    heartbeat.unref?.();
    try {
      let result;
      if (job.type === "cron_sync") {
        log("Cron Sync started...");
        result = await runScheduledSync(log, { forceCatchup: true });
      } else if (job.type === UP_NEXT_AUTO_SYNC_JOB || job.type === UP_NEXT_PRIORITY_SYNC_JOB) {
        log("Automatic Up Next provider sync started...");
        result = await runAutomaticUpNextSync({
          logger: log,
          isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
        });
      } else if (job.type === "force_sync_plan") {
        log("Force Sync preview started...");
        const config = await loadMediaConfig();
        const collected = await collectServerWatchedItems(config, { scope: job.payload?.scope, logger: log });
        const plan = buildForceSyncPlan({ ...collected, historyRows: await getCachedHistory(), config });
        const record = createSyncPlanRecord(plan);
        result = { success: true, planId: record.id, summary: record.summary, status: record.status };
        log(`Force Sync preview complete: ${record.id}`);
      } else if (job.type === "refresh_tmdb_metadata") {
        log("Refresh All TMDB Metadata started...");
        result = await runTmdbMetadataRefreshJob(log, {
          isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
        });
      } else if (job.type === "refresh_tvdb_metadata") {
        log("Refresh All TVDB Metadata started...");
        result = await runTvdbMetadataRefreshJob(log, {
          isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
        });
      } else if (job.type === PLAYSTATE_ALIAS_REPAIR_JOB) {
        log("Playstate episode-id alias repair started...");
        result = await runPlaystateAliasRepairJob(log, {
          isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
        });
      } else if (job.type === "retry_all_sync_activity") {
        log("Retry all failed sync activity started...");
        result = await runRetryAllSyncActivityJob(log, {
          isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
        });
      } else {
        const cancelledBeforeStart = getBackgroundJob(job.id)?.cancelRequested === true;
        if (cancelledBeforeStart) {
          result = { success: false, aborted: true, cancelled: true, error: "Force Sync was cancelled before it started." };
          log("Force Sync cancelled before it started.");
        } else {
          log("Force Sync started...");
          result = await runForceSync(log, {
            operationOwnerId: job.id,
            planId: job.payload?.planId || "",
            isCancelled: async () => getBackgroundJob(job.id)?.cancelRequested === true,
          });
        }
      }
      const current = getBackgroundJob(job.id);
      const cancelled = current?.cancelRequested || result?.aborted;
      appendBackgroundJobLog(job.id, `RESULT: ${JSON.stringify(result)}`);
      finishBackgroundJob({ ...token, status: cancelled ? "cancelled" : "succeeded", result });
      if ((job.type === UP_NEXT_AUTO_SYNC_JOB || job.type === UP_NEXT_PRIORITY_SYNC_JOB) && result?.rerun && !cancelled) {
        await requestUpNextAutoSync("Up Next changed while the previous automatic sync was running", {
          priority: job.type === UP_NEXT_PRIORITY_SYNC_JOB,
        }).catch((error) => {
          console.error(`[worker] Failed to requeue automatic Up Next sync: ${error?.message || error}`);
        });
      }
      if (job.type === "cron_sync") await setRuntimeState({ lastCronResult: { ok: !cancelled, result, finishedAt: Date.now() } });
      if (job.type === "force_sync") await setRuntimeState({ forceSyncResult: { ...result, jobId: job.id, finishedAt: Date.now() }, forceSyncHeartbeat: Date.now() });
    } catch (error) {
      const current = getBackgroundJob(job.id);
      const cancelled = current?.cancelRequested === true;
      const result = { success: false, ...(cancelled ? { aborted: true, cancelled: true } : {}), error: error.message };
      appendBackgroundJobLog(job.id, `ERROR: ${error.message}`);
      finishBackgroundJob({ ...token, status: cancelled ? "cancelled" : "failed", error: error.message, result });
      if (job.type === "force_sync") await setRuntimeState({ forceSyncResult: { ...result, jobId: job.id, finishedAt: Date.now() }, forceSyncHeartbeat: Date.now() }).catch(() => null);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function pollJobs() {
    if (stopped) return;
    // Keep the durable job queue separate from the scheduled tick. In
    // particular, an event-triggered Up Next push must not race the catch-up
    // feed refresh that is discovering the queue it is about to send.
    if (!jobRunning && !tickRunning && isLeader()) {
      const job = claimNextBackgroundJob({ holderId, generation: lease.generation });
      if (job) {
        jobRunning = true;
        try {
          activeJobPromise = executeJob(job);
          await activeJobPromise;
        } finally {
          activeJobPromise = null;
          jobRunning = false;
        }
      }
      pruneBackgroundJobs();
    }
    later(pollJobs, JOB_POLL_MS);
  }

  return {
    async start() {
      stopped = false;
      await maintainLease();
      // Durable jobs can contain provider-backed syncs. Keep the queue asleep
      // through the same first-request window as scheduled work so a stale
      // backlog cannot turn startup into a multi-second event-loop stall.
      if (!SCHEDULED_WORKER_PAUSED) later(pollJobs, FIRST_TICK_MS + 1_000);
    },
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const stoppingStartupGeneration = startupScanGeneration;
      startupScanGeneration = null;
      if (stoppingStartupGeneration !== null) {
        await setRuntimeState({ startupScanActive: false, startupScanCompletedAt: Date.now() }).catch(() => null);
      }
      stopPlexNotificationListener();
      const closingLease = lease;
      await Promise.allSettled([activeTickPromise, activeJobPromise, activeStartupScanPromise].filter(Boolean));
      if (closingLease) releaseSchedulerLease({ holderId, generation: closingLease.generation });
      lease = null;
    },
    isLeader,
  };
}
