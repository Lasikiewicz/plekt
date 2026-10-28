import { createLoopStore, pruneExpiredLoopKeys } from "./utils/loopStore.js";
import { readShowNumbering } from "./utils/seasonSource.js";
import { activeSyncOperation, appendSyncHistory, isAuthoritativeRestoreActive, loadBackgroundSyncProgress, loadMediaConfig, loadRuntimeState, setRuntimeState, SYNC_OPERATION_SCHEDULED } from "./utils/configStore.js";
import { createPlexNotificationListener } from "./utils/plexNotificationListener.js";
import { createPlexAdaptivePoller } from "./utils/plexAdaptivePoller.js";
import { createLiveSessionPoller } from "./utils/liveSessionPoller.js";
import { fetchPlexContainerEpisodes, fetchPlexMetadataItem, findPlexItem, hydratePlexEpisodeMetadata, mergePlexMetadataItem, syncPlexCachedEpisodeState } from "./utils/plexClient.js";
import { buildPlexMediaFromMetadata } from "./utils/parsers.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "./utils/watchProvenance.js";
import { listActiveSessions } from "./utils/activeSessions.js";
import { providerWatchFingerprint } from "./utils/recentWatchImport.js";
import { recoverStaleSyncOperation, runScheduledSync } from "./scheduled.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { watchedThresholdPercent, watchImportMode } from "./utils/tuning.js";
import { isRecentOutboundPlayedEcho, isRecentOutboundUnplayedFlagEcho, lastOutboundPlayedMarkAt, syncCanonicalPlaystate, syncMediaPlaystate } from "./utils/syncOrchestrator.js";
import { applyUnwatchedTransition } from "./utils/watchStateTransitions.js";
import { plexUnplayedHasWatchEvidence, shouldRepairRecentPlexUnwatch } from "./utils/plexWatchstate.js";
import { pollConnectedTrackers } from "./utils/trackerSync.js";
import { kickSimklFullSyncRuns } from "./utils/trackers/simklFullSyncRunner.js";
import { getTrackerConnection } from "./utils/trackerConnectionRepo.js";
import { withFreshTraktConnection } from "./utils/trackerDispatcher.js";
import { reconcileTraktProviderOverrides } from "./utils/traktProviderReconciliation.js";
import { getTmdbDetails, prewarmTmdbLibrary } from "./utils/tmdbGateway.js";
import { cachedNextAiringFor, mergeNextAiringCacheEntries, nextAiringCacheEntryStale, nextAiringCacheKey, readNextAiringCache } from "./utils/nextAiringCache.js";
import { refreshUpcomingCalendarCache } from "./utils/upcomingCalendarCache.js";
import { runScheduledWatchBackup, runScheduledRemoteWatchBackup } from "./utils/watchHistoryBackups.js";
import { runScheduledPlektBackup } from "./utils/plektBackups.js";
import { runRatingSyncScheduler } from "./utils/personalRatingSync.js";
import { runWatchlistSyncScheduler } from "./utils/personalWatchlistSync.js";
import { runPlaylistSyncScheduler } from "./utils/playlistSyncTriggers.js";
import { pruneSyncPlans } from "./utils/syncPlans.js";
import { runDbOptimizeIfDue } from "./utils/dbMaintenance.js";
import { pruneWatchAuditPayloads } from "./utils/watchAudit.js";
import { runScheduledPlaystateAliasRepair } from "./utils/playstateAliasRepair.js";
import {
  deletePlaybackProgress,
  findWatchedByAnyMediaKey,
  getCachedHistory,
  getCachedShows,
  getPlaystateForMedia,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  isDeletedWatchSuppressed,
  listRecentTrackedWatchRows,
  listRecentlyUpdatedTrackedWatchRows,
  mediaToWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
  loadLiveTrackingCache,
  repairEpisodeSeriesIdentity,
  clearTraktProviderOverrides,
} from "./utils/dataRepo.js";
import { resolvePlexWatchDate, resolveWatchImportDate, runtimeMinutesForSourceItem } from "./utils/watchDates.js";
import { enqueueManualWatchReview } from "./utils/manualWatchReview.js";
import { brandEnv } from "./utils/brandEnv.js";
import { createPerUserState } from "./utils/perUserState.js";

const NEXT_AIRING_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const EPISODE_IDENTITY_REPAIR_INTERVAL_MS = 15 * 60 * 1000;
const TRAKT_PROVIDER_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPCOMING_CALENDAR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NEXT_AIRING_REFRESH_LIMIT = 40;
const tickCadence = createPerUserState(() => ({
  lastNextAiringRefreshAt: 0,
  lastEpisodeIdentityRepairAt: 0,
  lastTraktProviderReconciliationAt: 0,
  nextAiringInitialBuildPending: true,
  lastUpcomingCalendarRefreshAt: 0,
}));
const LARGE_DISPATCH_PENDING_THRESHOLD = 8;
const PLEX_BULK_EPISODE_CONCURRENCY = 2;
const PLEX_NOTIFICATION_STATE_DEDUPE_MS = 60 * 1000;

export function shouldDeferScheduledOutbound(progress = {}) {
  return Math.max(0, Number(progress.total || 0) - Number(progress.completed || 0)) > LARGE_DISPATCH_PENDING_THRESHOLD;
}

function playbackTitleKey(value = "") {
  return String(value || "").toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "").trim();
}

function parseLivePayload(row = {}) {
  try {
    const payload = JSON.parse(row.payload_json || "{}");
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function livePlaybackMatchesMedia(row = {}, media = {}) {
  if (String(row.source_platform || row.source || "").toLowerCase() !== "plex") return false;
  const payload = parseLivePayload(row);
  const rowSeason = row.season ?? payload.season;
  const rowEpisode = row.episode ?? payload.episode;
  if (media.season != null && rowSeason != null && Number(media.season) !== Number(rowSeason)) return false;
  if (media.episode != null && rowEpisode != null && Number(media.episode) !== Number(rowEpisode)) return false;
  const title = row.title || payload.title || "";
  return playbackTitleKey(title) === playbackTitleKey(media.title);
}

async function hasRecentPlexThresholdPlayback(media) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const [activeRows, trackedRows] = await Promise.all([
    listActiveSessions().catch(() => []),
    loadLiveTrackingCache({ includeCompleted: true }).catch(() => []),
  ]);

  const activeEvidence = activeRows.some((row) =>
    livePlaybackMatchesMedia({
      source_platform: row.source,
      title: row.title,
      last_progress: row.progress,
      updated_at: row.updatedAt,
      payload_json: JSON.stringify(row),
    }, media)
    && Number(row.progress || 0) >= watchedThresholdPercent()
    && Number(row.updatedAt || 0) >= cutoff,
  );
  if (activeEvidence) return true;

  return trackedRows.some((row) =>
    livePlaybackMatchesMedia(row, media)
    && Number(row.last_progress || 0) >= watchedThresholdPercent()
    && Math.max(Number(row.updated_at || 0), Number(row.completed_at || 0)) >= cutoff,
  );
}

// Plex's library notification stream reports the resulting watched flag, but
// it does not say whether the user watched through the configured threshold or
// clicked "Mark watched". A recent threshold-reaching live session is the
// deciding evidence; without it, a server-supplied lastViewedAt is the time of
// the manual click and must not become the historical watch date.
export function resolvePlexNotificationWatchDate(metadata = {}, { hasPlaybackEvidence = false } = {}) {
  return resolvePlexWatchDate(metadata, { hasPlaybackEvidence });
}

async function refreshNextAiringCache({ limit = NEXT_AIRING_REFRESH_LIMIT, forceAll = false } = {}) {
  const cache = await readNextAiringCache();
  const shows = await getCachedShows();
  const candidates = shows
    .map((show) => {
      const key = nextAiringCacheKey(show.tmdb_id, show.title);
      const cached = cachedNextAiringFor(cache.entries, show.tmdb_id, show.title);
      const status = show.status || cached?.status || "";
      return { ...show, key, cached, status };
    })
    .filter((show) => show.key && show.tmdb_id && (forceAll || nextAiringCacheEntryStale(show.cached, show.status)))
    .sort((a, b) => Number(a.cached?.updatedAt || 0) - Number(b.cached?.updatedAt || 0))
    .slice(0, Math.max(1, Number(limit) || NEXT_AIRING_REFRESH_LIMIT));

  if (!candidates.length) return { checked: 0, written: 0 };
  console.log(`Next airing cache refresh: checking ${candidates.length} show${candidates.length === 1 ? "" : "s"}${forceAll ? " (full build)" : ""}...`);

  const updates = [];
  for (const show of candidates) {
    try {
      // Cache-honest on purpose: the TMDB/TVDB gateways already hold TV details
      // for at most a day (returning series), which is fresh enough for an
      // airing calendar - forcing a refetch here would bypass the entire cache
      // layer for up to 40 shows every 30 minutes. This refresh's own TTLs
      // (nextAiringCacheEntryStale) govern how often shows are rechecked.
      const details = await getTmdbDetails({ mediaType: "tv", tmdbId: show.tmdb_id, title: show.title });
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: details?.next_airing_date || details?.next_episode_to_air?.air_date || "",
        status: details?.status || show.status || "",
      });
    } catch (error) {
      console.error(`Failed to refresh next airing for ${show.title}`, error);
      updates.push({
        key: show.key,
        title: show.title,
        tmdbId: show.tmdb_id,
        nextAiringDate: show.cached?.nextAiringDate || "",
        status: show.status || "",
      });
    }
  }

  const result = await mergeNextAiringCacheEntries(updates);
  console.log(`Next airing cache refresh complete: checked ${candidates.length}, wrote ${result.written || 0}.`);
  return { checked: candidates.length, written: result.written || 0 };
}

const scheduledTasksInFlight = new Map();

// ---------------------------------------------------------------------------
// Per-step scheduler timing.
//
// The tick runs its steps one after another against a once-a-minute cadence,
// and each step carries its own time budget. Whether a later step is actually
// starved by an earlier one is a question about wall-clock offsets within a
// tick, so that is what this records: for every step, where in the tick it
// started, how long it took, whether it exhausted its budget, and whether it
// was skipped because the previous tick's copy was still running, and whether
// it actually had work to do. The tick itself records the achieved interval,
// which is the gap between consecutive tick starts rather than the nominal 60
// seconds. `didWork` is deliberately derived from the task result: a task that
// returns a skipped/no-provider/no-due result is not the same as a task that
// ran out of time.
//
// Set PLEKT_DEBUG_SCHEDULER=1 to log a line per step and a tick summary
// (visible in Settings → Logs), in the same style as PLEKT_DEBUG_OUTBOUND.
// The in-process history below is always collected: it is one timestamp pair
// per step, never per row.
// ---------------------------------------------------------------------------
const DEBUG_SCHEDULER = ["1", "true"].includes(String(brandEnv("DEBUG_SCHEDULER") || "").toLowerCase());
const SCHEDULER_TICK_HISTORY_LIMIT = 60;
const schedulerTickHistory = [];
let schedulerTickSeq = 0;
let schedulerTickStartedAt = 0;
let lastSchedulerTickStartedAtMs = 0;
let currentTickSteps = null;

function beginSchedulerTick() {
  const startedAtMs = Date.now();
  const achievedIntervalMs = lastSchedulerTickStartedAtMs ? startedAtMs - lastSchedulerTickStartedAtMs : null;
  lastSchedulerTickStartedAtMs = startedAtMs;
  schedulerTickSeq += 1;
  schedulerTickStartedAt = performance.now();
  currentTickSteps = [];
  return { tick: schedulerTickSeq, startedAtMs, achievedIntervalMs };
}

function endSchedulerTick(context, outcome) {
  const steps = currentTickSteps || [];
  currentTickSteps = null;
  const durationMs = Math.round((performance.now() - schedulerTickStartedAt) * 1000) / 1000;
  const entry = {
    tick: context.tick,
    startedAt: new Date(context.startedAtMs).toISOString(),
    achievedIntervalMs: context.achievedIntervalMs,
    durationMs,
    skipped: Boolean(outcome?.skipped),
    reason: outcome?.reason || null,
    steps,
  };
  schedulerTickHistory.push(entry);
  if (schedulerTickHistory.length > SCHEDULER_TICK_HISTORY_LIMIT) {
    schedulerTickHistory.splice(0, schedulerTickHistory.length - SCHEDULER_TICK_HISTORY_LIMIT);
  }
  if (DEBUG_SCHEDULER) {
    const interval = context.achievedIntervalMs === null ? "first" : `${context.achievedIntervalMs}ms`;
    const tail = entry.skipped ? ` skipped=${entry.reason || "yes"}` : "";
    console.log(`[scheduler] tick=${entry.tick} steps=${steps.length} duration=${durationMs.toFixed(1)}ms achievedInterval=${interval}${tail}`);
  }
  return entry;
}

function recordSchedulerStep(step) {
  if (currentTickSteps) currentTickSteps.push(step);
  if (DEBUG_SCHEDULER) {
    console.log(`[scheduler] tick=${schedulerTickSeq} step="${step.step}" startOffsetMs=${step.startOffsetMs.toFixed(1)}ms durationMs=${step.durationMs.toFixed(1)}ms budgetMs=${step.budgetMs}ms budgetExhausted=${step.budgetExhausted} didWork=${step.didWork}`);
  }
}

export function schedulerStepDidWork(result) {
  if (result == null) return false;
  if (typeof result === "boolean") return result;
  if (typeof result !== "object") return true;
  if (result.didWork !== undefined) return Boolean(result.didWork);
  if (result.skipped === true) return false;
  if (Array.isArray(result)) return result.length > 0;

  // Scheduler tasks return summaries rather than a shared result type. Count
  // only fields that represent observed or changed work, not configuration or
  // status fields. This keeps a no-provider/no-due return false while still
  // marking a provider scan or cache refresh that found records as work.
  const workKeys = [
    "sessions", "completions", "progressUpdates", "removed", "cached",
    "plexHistorySynced", "embyHistorySynced", "jellyfinHistorySynced",
    "availabilityRepairs", "plexResumeSynced", "embyResumeSynced",
    "jellyfinResumeSynced", "manualDispatchesSynced", "watched", "unwatched",
    "embyNextUpFetched", "jellyfinNextUpFetched",
    "remoteItems", "queued", "pending", "scanned", "changed", "written",
    "refreshed", "items", "results",
  ];
  return workKeys.some((key) => {
    const value = result[key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "boolean") return value;
    return Number.isFinite(Number(value)) && Number(value) > 0;
  });
}

// A snapshot of recent ticks, for the benchmark scripts and test 6.
export function schedulerTimingTelemetry() {
  const ticks = schedulerTickHistory.map((tick) => ({ ...tick, steps: tick.steps.map((step) => ({ ...step })) }));
  const byStep = new Map();
  for (const tick of ticks) {
    for (const step of tick.steps) {
      const entry = byStep.get(step.step) || { step: step.step, runs: 0, didWork: 0, skipped: 0, budgetExhausted: 0, failed: 0, totalMs: 0, maxMs: 0 };
      entry.runs += 1;
      if (step.didWork) entry.didWork += 1;
      if (step.skipped) entry.skipped += 1;
      if (step.budgetExhausted) entry.budgetExhausted += 1;
      if (step.failed) entry.failed += 1;
      entry.totalMs += step.durationMs;
      entry.maxMs = Math.max(entry.maxMs, step.durationMs);
      byStep.set(step.step, entry);
    }
  }
  const intervals = ticks.map((tick) => tick.achievedIntervalMs).filter((value) => Number.isFinite(value));
  return {
    debugEnabled: DEBUG_SCHEDULER,
    ticksObserved: ticks.length,
    achievedIntervalMs: intervals.length
      ? {
        min: Math.min(...intervals),
        max: Math.max(...intervals),
        mean: Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length),
      }
      : null,
    steps: [...byStep.values()]
      .map((entry) => ({
        ...entry,
        totalMs: Math.round(entry.totalMs * 1000) / 1000,
        maxMs: Math.round(entry.maxMs * 1000) / 1000,
        meanMs: entry.runs ? Math.round((entry.totalMs / entry.runs) * 1000) / 1000 : 0,
      }))
      .sort((a, b) => b.totalMs - a.totalMs),
    ticks,
  };
}

// The budget only stops the tick waiting; the task itself keeps running. So an
// exhausted budget is logged as "still running" (not "failed"), and the task's
// real outcome is logged when it settles.
export async function runWithTimeBudget(label, task, timeoutMs) {
  const startOffsetMs = schedulerTickStartedAt ? performance.now() - schedulerTickStartedAt : 0;
  if (scheduledTasksInFlight.has(label)) {
    console.warn(`${label} is still running from a previous tick; skipping this tick.`);
    recordSchedulerStep({ step: label, startOffsetMs, durationMs: 0, budgetMs: timeoutMs, skipped: true, budgetExhausted: false, failed: false, didWork: false });
    return;
  }
  let timeout;
  let budgetExhausted = false;
  let failed = false;
  let result;
  const startedAt = performance.now();
  const taskPromise = Promise.resolve()
    .then(task)
    .finally(() => scheduledTasksInFlight.delete(label));
  scheduledTasksInFlight.set(label, taskPromise);
  try {
    result = await Promise.race([
      taskPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          budgetExhausted = true;
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (budgetExhausted) {
      console.warn(`${label} is still running after ${timeoutMs}ms; the tick moves on and it finishes in the background.`);
      taskPromise.then(
        () => console.log(`${label} finished in the background after ${Math.round(performance.now() - startedAt)}ms.`),
        (lateError) => console.error(`${label} failed`, lateError),
      );
    } else {
      failed = true;
      console.error(`${label} failed`, error);
    }
  } finally {
    clearTimeout(timeout);
    recordSchedulerStep({
      step: label,
      startOffsetMs,
      durationMs: performance.now() - startedAt,
      budgetMs: timeoutMs,
      skipped: false,
      budgetExhausted,
      failed,
      didWork: !failed && !budgetExhausted && schedulerStepDidWork(result),
    });
  }
}

async function reconcileTraktProviderMappings() {
  // A show with a Fix Match season choice keeps its Trakt mapping:
  // Trakt can expose the stored (media server) numbering too, which would
  // otherwise clear the mapping and send its plays to the wrong episodes.
  const rows = (await getCachedHistory()).filter((row) => (
    row.media_type === "episode"
    && row.provider_overrides?.trakt?.tmdb_id
    && !readShowNumbering(row.tvdb_id).overriddenAt
  ));
  if (!rows.length) return { checked: 0, changed: 0 };

  const configured = getTrackerConnection("trakt");
  if (!configured || configured.status !== "connected") {
    return { skipped: true, reason: "trakt-not-connected", checked: 0, changed: 0 };
  }
  const connection = await withFreshTraktConnection();
  if (!connection) return { skipped: true, reason: "trakt-not-connected", checked: 0, changed: 0 };

  const result = await reconcileTraktProviderOverrides({
    connection,
    rows,
    clearOverrides: (groupRows) => clearTraktProviderOverrides(groupRows),
  });
  if (result.changed > 0) {
    console.log(`Trakt provider reconciliation: cleared ${result.changed} override${result.changed === 1 ? "" : "s"}; pending rows will be sent with canonical TVDB IDs and seasons.`);
  }
  if (result.errors > 0) {
    console.warn(`Trakt provider reconciliation: ${result.errors} mapping check${result.errors === 1 ? "" : "s"} could not be completed; local mappings were left unchanged.`);
  }
  return result;
}

// Invoked once per minute by the elected worker coordinator. The wrapper opens
// and closes the per-step timing window; every early return inside the tick
// body still lands in `finally`, so a lease-lost or restore-paused tick is
// recorded rather than silently missing from the history.
export async function runScheduledTick(options = {}) {
  const context = beginSchedulerTick();
  let outcome;
  try {
    outcome = await runScheduledTickSteps(options);
    return outcome;
  } finally {
    endSchedulerTick(context, outcome);
  }
}

async function runScheduledTickSteps({ isLeader = () => true } = {}) {
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) await recoverStaleSyncOperation();
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  pruneSyncPlans();
  const cadence = tickCadence();
  await runWithTimeBudget("Loop key prune", () => {
    const removed = pruneExpiredLoopKeys();
    if (removed > 0) console.log(`Loop key prune: removed ${removed} expired row${removed === 1 ? "" : "s"}.`);
    return { removed };
  }, 5_000);
  await runWithTimeBudget("Database optimize", () => runDbOptimizeIfDue(), 10_000);
  await runWithTimeBudget("Audit payload prune", () => ({ changed: pruneWatchAuditPayloads() }), 10_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  // A Trakt/TMDB-only split is deliberately an escape hatch for provider
  // numbering conflicts. Re-check it infrequently in the background; when
  // Trakt eventually adopts the canonical TVDB series and season numbers,
  // clear only that override before Scheduled sync runs in this same tick.
  if (Date.now() - cadence.lastTraktProviderReconciliationAt >= TRAKT_PROVIDER_RECONCILIATION_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    cadence.lastTraktProviderReconciliationAt = Date.now();
    await runWithTimeBudget("Trakt provider mapping reconciliation", () => reconcileTraktProviderMappings(), 45_000);
  }
  // A large outstanding backlog (checkUnwatched + recently-watched/resumable
  // polling across all three platforms, then up to 15 manual-dispatch
  // retries) can genuinely take longer than one minute to finish a full
  // pass. runWithTimeBudget's Promise.race does not cancel the underlying
  // task on timeout - it keeps running in the background and still reaches
  // its own cache-invalidation and completion logging - so a tight budget
  // here does not prevent progress, it only manufactures a misleading
  // recurring timeout error and delays when that progress becomes visible
  // (e.g. to /api/sync-jobs, which depends on the invalidation at the end of
  // the run). scheduledTasksInFlight already guards against two overlapping
  // runs, so a generous budget is safe even if a pass runs past one tick.
  const dispatchProgress = await loadBackgroundSyncProgress().catch(() => ({ total: 0, completed: 0 }));
  const pendingDispatches = Math.max(0, Number(dispatchProgress.total || 0) - Number(dispatchProgress.completed || 0));
  const deferOutbound = shouldDeferScheduledOutbound(dispatchProgress);
  if (deferOutbound) {
    console.log(`Scheduled sync: deferring outbound sync while a large dispatch is in progress (${pendingDispatches} pending).`);
  } else {
    await runWithTimeBudget("Scheduled sync", () => runScheduledSync(), 120_000);
  }
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  if (!deferOutbound) {
    await runWithTimeBudget("Tracker watched-state poll", () => pollConnectedTrackers(), 45_000);
  }
  // Approved paced Simkl full sync; due only after a reset or a short pause.
  await runWithTimeBudget("Simkl paced full sync", () => kickSimklFullSyncRuns(), 60_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  // Personal ratings have their own opt-in queue and provider snapshot
  // generations. Keep their cadence and failure budget independent from the
  // watched-state sync above: a ratings outage must not delay watch history,
  // and a large watched dispatch must not suppress a due rating run.
  await runWithTimeBudget("Personal rating sync", () => runRatingSyncScheduler(), 45_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  // Personal watchlists have their own durable queue and complete-snapshot
  // reconciliation. Keep this independent from ratings so a provider outage
  // or large watchlist does not delay watch history or the other personal sync.
  await runWithTimeBudget("Personal watchlist sync", () => runWatchlistSyncScheduler(), 45_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  // Two-way playlist sync; runs its own pass once per interval.
  await runWithTimeBudget("Playlist sync", () => runPlaylistSyncScheduler(), 60_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  await runWithTimeBudget("Scheduled watch-history backup", () => runScheduledWatchBackup(), 30_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  await runWithTimeBudget("Scheduled remote watch-history backup", () => runScheduledRemoteWatchBackup(), 60_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  await runWithTimeBudget("Scheduled Plekt backup", () => runScheduledPlektBackup(), 30_000);
  if (!isLeader()) return { skipped: true, reason: "lease-lost" };
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  // Repair identity aliases before the dashboard projection and metadata
  // warm-up run. The pass is idempotent and bounded by its cadence; it repairs
  // old episode-level ids and collapses progress aliases left by older feeds.
  if (Date.now() - cadence.lastEpisodeIdentityRepairAt >= EPISODE_IDENTITY_REPAIR_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    cadence.lastEpisodeIdentityRepairAt = Date.now();
    await runWithTimeBudget("Episode identity repair", () => repairEpisodeSeriesIdentity(), 30_000);
    // Cached TMDB answers only; uncached ids go to a background lookup job.
    if (!isAuthoritativeRestoreActive()) {
      await runWithTimeBudget("Playstate episode-id alias repair", () => runScheduledPlaystateAliasRepair(), 30_000);
    }
  }
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  // The gateway queues missing/stale library metadata on a single background
  // worker. Keep this broad scan as a restart/import backstop; it does not
  // hold the scheduler tick open on TMDB/TVDB requests.
  await runWithTimeBudget("TMDB metadata warm-up", () => prewarmTmdbLibrary(), 30_000);
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  if (Date.now() - cadence.lastNextAiringRefreshAt > NEXT_AIRING_REFRESH_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    cadence.lastNextAiringRefreshAt = Date.now();
    const forceAll = cadence.nextAiringInitialBuildPending;
    cadence.nextAiringInitialBuildPending = false;
    await runWithTimeBudget("Next airing cache refresh", () => refreshNextAiringCache({ forceAll }), 45_000);
  }
  if (Date.now() - cadence.lastUpcomingCalendarRefreshAt > UPCOMING_CALENDAR_REFRESH_INTERVAL_MS) {
    if (!isLeader()) return { skipped: true, reason: "lease-lost" };
    cadence.lastUpcomingCalendarRefreshAt = Date.now();
    await runWithTimeBudget("Upcoming calendar cache refresh", () => refreshUpcomingCalendarCache(), 50_000);
  }
  return { skipped: false };
}

// ---------------------------------------------------------------------------
// Plex real-time watch-state detection
//
// Plex never sends a webhook when an item is marked unwatched, so we listen on its
// notification WebSocket. When a movie/episode timeline event arrives, we resolve the
// ratingKey to its current metadata, confirm it actually went to unwatched, and (if we
// previously tracked it as watched) run the same propagation as a manual unwatch — which
// fans out to Emby and Jellyfin via the configured ID/title matching.
// ---------------------------------------------------------------------------

let plexNotificationListener = null;
const plexNotificationInFlight = new Map();
const recentPlexNotificationStates = new Map();

function plexNotificationStateKey(ratingKey, metadata = {}) {
  const type = String(metadata.type || "").trim().toLowerCase();
  const viewCount = Number(metadata.viewCount || 0);
  const state = viewCount > 0 ? "watched" : "unplayed";
  // Plex increments viewCount (and normally lastViewedAt) for a real rewatch.
  // Do not include viewOffset for watched items: timeline progress frames can
  // change it repeatedly while the same viewing is in progress.
  const lastViewedAt = state === "watched"
    ? String(metadata.lastViewedAt || metadata.last_viewed_at || metadata.viewedAt || "")
    : "";
  const viewOffset = state === "unplayed"
    ? Math.max(0, Math.floor(Number(metadata.viewOffset || 0)))
    : "";
  return `${String(ratingKey || "").trim()}:${type}:${state}:${viewCount}:${lastViewedAt}:${viewOffset}`;
}

function claimRecentPlexNotificationState(stateKey) {
  const now = Date.now();
  for (const [key, timestamp] of recentPlexNotificationStates) {
    if (now - timestamp >= PLEX_NOTIFICATION_STATE_DEDUPE_MS) recentPlexNotificationStates.delete(key);
  }
  const previousAt = recentPlexNotificationStates.get(stateKey);
  if (previousAt && now - previousAt < PLEX_NOTIFICATION_STATE_DEDUPE_MS) return false;
  recentPlexNotificationStates.set(stateKey, now);
  return true;
}

async function processPlexLibraryItemChange(ratingKey, metadataOverride = null) {
  if (!watchedPlayedSyncEnabled()) return;

  const restoreRuntime = await loadRuntimeState().catch(() => ({}));
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    console.log("Plex notifications: ignored library change during sync operation", { ratingKey, operation: activeOperation.kind });
    return;
  }

  const config = await loadMediaConfig().catch(() => null);
  if (!config?.plex?.baseUrl || !config.plex.token || config.plex.disabled) return;

  const authoritativeMetadata = await fetchPlexMetadataItem(config.plex, ratingKey).catch((error) => {
    console.error(`Plex notification: metadata lookup failed for ratingKey ${ratingKey}: ${error.message}`);
    return null;
  });
  let metadata = mergePlexMetadataItem(authoritativeMetadata, metadataOverride);
  if (!metadata) return;

  metadata = await hydratePlexEpisodeMetadata(config.plex, metadata).catch((error) => {
    console.warn(`Plex notification: series identity lookup failed for ratingKey ${ratingKey}: ${error.message}`);
    return metadata;
  });

  syncPlexCachedEpisodeState(config.plex, metadata);

  const notificationStateKey = plexNotificationStateKey(ratingKey, metadata);
  if (!claimRecentPlexNotificationState(notificationStateKey)) {
    console.log("Plex notifications: coalesced duplicate library state", {
      ratingKey,
      type: metadata.type,
    });
    return;
  }

  if (["show", "season"].includes(String(metadata.type || "").toLowerCase())) {
    let expansionFailed = false;
    const episodes = await fetchPlexContainerEpisodes(config.plex, ratingKey, metadata.type).catch((error) => {
      expansionFailed = true;
      console.error(`Plex notification: failed to expand ${metadata.type} ratingKey ${ratingKey}: ${error.message}`);
      return [];
    });
    console.log("Plex notifications: expanding bulk TV watch-state change", {
      ratingKey,
      type: metadata.type,
      episodes: episodes.length,
    });
    // A listener slot can receive a show/season container and recursively fan
    // it out. Keep this lower than the top-level listener limit so a burst of
    // containers cannot multiply into an unbounded provider/DB storm.
    const concurrency = PLEX_BULK_EPISODE_CONCURRENCY;
    for (let index = 0; index < episodes.length; index += concurrency) {
      const batch = episodes.slice(index, index + concurrency);
      await Promise.allSettled(batch.map((episode) =>
        handlePlexLibraryItemChange(String(episode.ratingKey || ""), episode)
      ));
    }
    if (expansionFailed) recentPlexNotificationStates.delete(notificationStateKey);
    return;
  }

  // Only movies and episodes carry a watch state we sync.
  const media = buildPlexMediaFromMetadata(metadata, { phase: Number(metadata.viewCount || 0) > 0 ? "completed" : "unplayed" });
  if (!media?.isValid || !["movie", "episode"].includes(media.type)) return;

  // Still watched or only partially watched → this isn't an unwatch event.
  const viewCount = Number(metadata.viewCount || 0);
  const viewOffset = Number(metadata.viewOffset || 0);
  if (viewCount > 0) {
    const playstate = await getPlaystateForMedia(media).catch(() => null);
    const watchDate = resolvePlexNotificationWatchDate(metadata, {
      hasPlaybackEvidence: await hasRecentPlexThresholdPlayback(media),
    });
    const importMode = watchImportMode();
    const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
    media.runtimeMinutes = runtimeMinutesForSourceItem(metadata, "plex");
    const dateChoice = resolveWatchImportDate({
      mode: importMode,
      manualMark: watchDate.manualMark,
      sourceTimestamp: watchDate.sourceTimestamp,
      releaseDate: media.releaseDate,
      fallbackDate: watchDate.watchedAt,
      media,
      historyRows: timingHistory,
    });
    const watchedAt = dateChoice.watchedAt;
    if (!watchedAt) {
      console.log("Plex notifications: skipped watched item without a playback timestamp or release date", {
        title: media.title,
        ratingKey,
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    media.watched_at = watchedAt;

    media.watchProvenance = buildWatchProvenance(
      { source: "plex", event: "notification.viewstate", phase: "completed", itemId: ratingKey },
      {
        ingestPath: "plex_notification",
        sourceTimestamp: watchDate.sourceTimestamp,
        note: [watchDate.note, `Import policy: ${dateChoice.reason}.`].filter(Boolean).join(" "),
      },
    );

    // Plembfin is authoritative when an administrator explicitly removes a
    // provider watch date. Plex library notifications bypass the HTTP webhook
    // route, so enforce the same durable deletion tombstone here before this
    // path can recreate the release-date fallback as a new history row.
    if (isDeletedWatchSuppressed(media, watchedAt)) {
      console.log("Plex notifications: skipped a watch date explicitly deleted in Plekt", {
        title: media.title,
        ratingKey,
        watchedAt,
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    const loopStore = createLoopStore();
    const isNewerWatch = playstate?.watched_at && new Date(watchedAt).getTime() > new Date(playstate.watched_at).getTime() + 10000;

    // Plex stamps lastViewedAt when *we* mark an item played, so every outbound
    // sync makes an already-recorded watch look freshly viewed here. A view time
    // that lines up with our own write is our echo, not a new play. The window
    // is wide enough to absorb clock skew between plembfin and the Plex server
    // while staying shorter than any real playthrough.
    //
    // watchedAt above is resolvePlexNotificationWatchDate()'s result, which for a
    // flag-only echo with no playback evidence deliberately falls back to the
    // release date rather than "now" - so it almost never lines up with ownMarkAt
    // when the outbound mark used a historical watched date (e.g. "Mark Watched"
    // with a specific date, or a bulk season backfill). isRecentOutboundPlayedEcho
    // also falls back to comparing this notification's *arrival* time against
    // ownMarkAt, which is what actually catches that case.
    const isOwnMarkEcho = await isRecentOutboundPlayedEcho(media, "plex", loopStore);

    if (isOwnMarkEcho || (playstate?.state === "watched" && !isNewerWatch)) {
      if (isOwnMarkEcho) {
        console.log("Plex notifications: ignored view timestamp from our own played mark", {
          title: media.title,
          ratingKey,
          watchedAt,
        });
      }
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    // A Plex library notification only reports the resulting played flag; by
    // itself it does not identify whether the user clicked Mark played or Plex
    // is replaying the old flag after Plembfin sent Mark unwatched. A recent
    // threshold-reaching playback whose Plex view time is newer than the
    // unwatched state is a real later watch, so it continues. A manual Plekt
    // unwatch stays held: only the exact live-session completion may revive it
    // (docs/decisions.md entry 31), and that path records it separately.
    const playbackOutranksUnwatch = playstate?.state === "unwatched"
      && !watchDate.manualMark
      && String(playstate.source || "").toLowerCase() !== "manual"
      && Date.parse(watchDate.sourceTimestamp || "") > Number(playstate.updated_at || 0);
    if (playstate?.state === "unwatched" && !playbackOutranksUnwatch) {
      if (dateChoice.requiresReview) {
        const queued = enqueueManualWatchReview(media, {
          releaseDate: media.releaseDate,
          observedWatchedAt: watchDate.sourceTimestamp,
          sourceFingerprint: providerWatchFingerprint(metadata, "plex", "notification"),
          reason: watchDate.note || "Plex reported a watched library flag without playback evidence.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) {
          console.log("Plex notifications: queued manual watch review while Plekt is unwatched", {
            title: media.title,
            ratingKey,
          });
        }
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return;
      }
      console.log("Plex notifications: ignored watched flag while Plekt is unwatched", {
        title: media.title,
        ratingKey,
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    // The playstate check above can miss an already-recorded watch when the
    // stored playstate row sits under a different media_key than this
    // notification resolves to (e.g. one source matched by imdb, another by
    // title fallback) - the exact mismatch behind today's Silo/Trying/Cape
    // Fear phantom watches. findWatchedByAnyMediaKey has the same
    // coordinate/provider-id fallback matching every other ingest path
    // relies on for this; treat a hit there as conclusive too, not just an
    // exact playstate match.
    const existingByAnyKey = await findWatchedByAnyMediaKey(media).catch(() => null);
    if (isAuthoritativeRestoreActive()) return;
    if (existingByAnyKey && !isNewerWatch) {
      console.log("Plex notifications: already recorded under a different key; repairing playstate instead of logging a new watch", {
        title: media.title,
        ratingKey,
      });
      await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }

    if (dateChoice.requiresReview) {
      const queued = enqueueManualWatchReview(media, {
        releaseDate: media.releaseDate,
        observedWatchedAt: watchDate.sourceTimestamp,
        sourceFingerprint: providerWatchFingerprint(metadata, "plex", "notification"),
        reason: watchDate.note || "Plex reported a watched library flag without playback evidence.",
      });
      if (queued.queued) {
        console.log("Plex notifications: queued manual watch review", {
          title: media.title,
          ratingKey,
        });
      }
      await deletePlaybackProgress(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return;
    }

    // The restore fence may have been claimed while the notification was
    // being hydrated. Do not admit a newly observed watched event after the
    // canonical restore has started; its app push will otherwise be based on
    // a row that the restore just replaced.
    if (isAuthoritativeRestoreActive()) return;

    const watchRecord = mediaToWatchRecord(media, "plex");
    watchRecord.watched_at = watchedAt;
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = [
      "Origin: plex",
      "Dispatch status: pending",
      "Details: Plex library watch-state notification received.",
      ...provenanceTelemetryLines(media.watchProvenance),
    ].join("\n");

    console.log("Plex notifications: item marked watched, storing and propagating", {
      title: media.title,
      ratingKey,
      type: media.type,
    });

    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
    await upsertPlaystateForMedia(media, "watched", watchedAt, { skipInvalidate: true });
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Plex watch-state propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    const telemetry = [
      "Origin: plex",
      `Dispatch status: ${summary.status || "unknown"}`,
      `Details: ${summary.details || "Plex library watch-state notification processed."}`,
      ...provenanceTelemetryLines(media.watchProvenance),
      ...(summary.targetStates || []).map((state) => `Target ${state.target} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`),
    ].join("\n");
    await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
    await appendSyncHistory({
      mediaType: media.type,
      title: media.title,
      source: "plex",
      status: summary.status,
      details: summary.details,
      action: "watched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: { ratingKey, ids: media.ids || {}, provenance: media.watchProvenance || null },
    }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);
    await result.assetPrefetch?.catch(() => null);
    await invalidateHistoryDerivedCaches("processPlexLibraryItemChange").catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return;
  }
  if (viewOffset > 0) {
    // Plex's "Mark Unwatched" clears viewCount but can leave a stale viewOffset
    // behind, so a lingering offset alone doesn't distinguish a genuine unwatch
    // from a fresh in-progress first watch. Only bail when we have no record of
    // this item ever being watched - otherwise treat it as a real unwatch.
    const priorPlaystate = await getPlaystateForMedia(media).catch(() => null);
    if (priorPlaystate?.state !== "watched") return;
    const hasPlaybackEvidence = await hasRecentPlexThresholdPlayback(media);
    if (shouldRepairRecentPlexUnwatch({ playstate: priorPlaystate, viewOffset, hasPlaybackEvidence })) {
      console.log("Plex notifications: held back transient unwatch after threshold playback; restoring watched state", {
        title: media.title,
        ratingKey,
        viewOffset,
      });
      const repairLoopStore = createLoopStore();
      await syncCanonicalPlaystate({ ...media, itemId: ratingKey }, config, repairLoopStore, "watched", {
        includeTrackers: false,
      }).catch((error) => {
        console.error("Plex notifications: failed to restore watched state after transient unwatch", {
          title: media.title,
          ratingKey,
          error,
        });
      });
      await deletePlaybackProgress(media).catch(() => null);
      return;
    }
    console.log("Plex notifications: unwatch detected despite lingering viewOffset", {
      title: media.title,
      ratingKey,
      viewOffset,
    });
  }

  // A never-watched item (for example one Plex just added to the library) also
  // arrives as unplayed. Recording it would write an unwatched history row and
  // push the unwatch to every target for something nobody watched.
  const unplayedPlaystate = await getPlaystateForMedia(media).catch(() => null);
  const unplayedWatchedRecord = unplayedPlaystate?.state === "watched"
    ? null
    : await findWatchedByAnyMediaKey(media).catch(() => null);
  if (!plexUnplayedHasWatchEvidence({ playstate: unplayedPlaystate, watchedRecord: unplayedWatchedRecord })) return;

  const loopStore = createLoopStore();
  if (viewCount === 0) {
    const ownUnplayedEcho = await isRecentOutboundUnplayedFlagEcho({ ...media, itemId: ratingKey }, "plex", loopStore).catch(() => false);
    if (ownUnplayedEcho) {
      console.log("Plex notifications: ignored outbound unplayed echo", { ratingKey, title: media.title });
      return;
    }
  }

  console.log("Plex notifications: item marked unwatched, storing and propagating", {
    title: media.title,
    ratingKey,
    type: media.type,
  });

  try {
    const result = await applyUnwatchedTransition({ ...media, itemId: ratingKey }, config, loopStore);
    if (result.alreadyUnwatched) return;
    const summary = result.summary;
    await appendSyncHistory({
      mediaType: media.type,
      title: media.title,
      source: media.source,
      status: summary.status,
      details: summary.details,
      action: "unwatched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: { ratingKey, ids: media.ids || {}, provenance: media.watchProvenance || null },
    }).catch(() => null);
  } catch (error) {
    console.error(`Plex notification unwatched-state propagation failed for "${media.title}"`, error);
  } finally {
    await invalidateHistoryDerivedCaches("processPlexLibraryItemChange").catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }
}

// Multiple Plex frames can describe the same item while the first handler is
// still waiting on provider requests. Join that work, but retain one trailing
// refresh so a genuine state change that arrives during it is not lost. The
// state fingerprint above then drops a repeated same-state refresh without
// repeating the provider fan-out.
async function handlePlexLibraryItemChange(ratingKey, metadataOverride = null) {
  const normalizedRatingKey = String(ratingKey || "").trim();
  if (!normalizedRatingKey) return;

  const active = plexNotificationInFlight.get(normalizedRatingKey);
  if (active) {
    active.needsRefresh = true;
    if (metadataOverride) active.latestMetadata = metadataOverride;
    return active.promise;
  }

  const entry = {
    latestMetadata: metadataOverride,
    needsRefresh: false,
    promise: null,
  };
  entry.promise = (async () => {
    let nextMetadataOverride = metadataOverride;
    while (true) {
      entry.needsRefresh = false;
      entry.latestMetadata = null;
      const result = await processPlexLibraryItemChange(normalizedRatingKey, nextMetadataOverride);
      if (!entry.needsRefresh) return result;
      nextMetadataOverride = entry.latestMetadata;
    }
  })();
  plexNotificationInFlight.set(normalizedRatingKey, entry);
  try {
    return await entry.promise;
  } finally {
    if (plexNotificationInFlight.get(normalizedRatingKey) === entry) {
      plexNotificationInFlight.delete(normalizedRatingKey);
    }
  }
}

export function startPlexNotificationListener() {
  if (!plexNotificationListener) {
    plexNotificationListener = createPlexNotificationListener({
      getPlexConfig: async () => {
        const config = await loadMediaConfig();
        return config?.plex || null;
      },
      onLibraryItemChange: handlePlexLibraryItemChange,
      // Plex pushes a "playing" notification over this same socket the instant a
      // session starts, pauses, resumes, or stops (and periodically while it plays).
      // Poking the live session poller here means Plex's Now Playing state updates
      // as soon as that arrives, instead of waiting for the poller's own timer.
      onPlaySessionActivity: pokeLiveSessionPoller,
      logger: console.log,
    });
  }
  plexNotificationListener.start();
}

export function restartPlexNotificationListener() {
  if (!plexNotificationListener) {
    startPlexNotificationListener();
    return;
  }
  plexNotificationListener.restart();
}

export function stopPlexNotificationListener() {
  plexNotificationListener?.stop();
}

async function checkPlexUnwatchedFast(plexConfig) {
  if (!watchedPlayedSyncEnabled()) return false;
  if (!plexConfig?.baseUrl || !plexConfig?.token || plexConfig.disabled) return false;

  const restoreRuntime = await loadRuntimeState().catch(() => ({}));
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) return false;

  const loopStore = createLoopStore();
  const plexWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("plex")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target plex status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentlyUpdatedTrackedWatchRows({ limit: 50, includeScheduled: true })).filter(
    (record) => plexWasConfirmedWatched(record),
  ).slice(0, 10);

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "plex",
        isValid: true,
        itemId: record.watch_provenance?.source === "plex"
          ? record.watch_provenance.item_id || undefined
          : undefined,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      let plexItem = media.itemId
        ? await fetchPlexMetadataItem(plexConfig, media.itemId).catch(() => null)
        : await findPlexItem(plexConfig, media);
      if (plexItem && !media.itemId && !(Number(plexItem.viewCount) > 0)) {
        const itemKey = plexItem.ratingKey || plexItem.key;
        if (itemKey) {
          plexItem = await fetchPlexMetadataItem(plexConfig, itemKey).catch(() => null);
        }
      }
      if (plexItem) {
        syncPlexCachedEpisodeState(plexConfig, plexItem);
        // A metadata lookup without account-scoped user data is not evidence
        // of an unwatch. Only an explicit numeric viewCount of zero can
        // trigger the unwatch repair; otherwise a provider response that
        // omitted viewCount would erase a freshly imported watch.
        const viewCount = Number(plexItem.viewCount);
        if (!Number.isFinite(viewCount)) continue;
        const isWatched = viewCount > 0;
        if (!isWatched) {
          const plexMedia = { ...media, itemId: plexItem.ratingKey || plexItem.key || undefined };
          const config = await loadMediaConfig().catch(() => null);
          const priorPlaystate = await getPlaystateForMedia(plexMedia).catch(() => null);
          const hasPlaybackEvidence = await hasRecentPlexThresholdPlayback(plexMedia);
          if (shouldRepairRecentPlexUnwatch({
            playstate: priorPlaystate,
            viewOffset: plexItem.viewOffset,
            hasPlaybackEvidence,
          })) {
            console.log("Plex adaptive poller: held back transient unwatch after threshold playback; restoring watched state", {
              title: record.title,
              ratingKey: plexMedia.itemId,
              viewOffset: Number(plexItem.viewOffset || 0),
            });
            // Explicitly live, not a historical replay: this restores a watch
            // that just happened with threshold playback evidence and that Plex
            // itself dropped. Letting it default to historical would leave Plex
            // stuck unwatched after its own glitch whenever the user has turned
            // historical Plex sync off.
            await syncCanonicalPlaystate({ ...plexMedia, syncIntent: "live" }, config, loopStore, "watched", { includeTrackers: false }).catch((error) => {
              console.error("Plex adaptive poller: failed to restore watched state after transient unwatch", {
                title: record.title,
                ratingKey: plexMedia.itemId,
                error,
              });
            });
            await deletePlaybackProgress(plexMedia).catch(() => null);
            continue;
          }
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(plexMedia, "plex", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            continue;
          }

          console.log("Plex adaptive poller: item marked unwatched, storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(plexMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) {
            await appendSyncHistory({
              mediaType: plexMedia.type,
              title: plexMedia.title,
              source: "plex",
              status: result.summary.status,
              details: result.summary.details,
              action: "unwatched",
              targetStates: result.summary.targetStates || [],
              rawPayloadDebug: { ratingKey: plexMedia.itemId, ids: plexMedia.ids || {} },
            }).catch(() => null);
          }
          await invalidateHistoryDerivedCaches("checkPlexUnwatchedFast").catch(() => null);
          await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
          return true;
        }
      }
    } catch {
      // quiet on individual lookup failures
    }
  }
  return false;
}

let plexAdaptivePoller = null;

export function startPlexAdaptivePoller() {
  if (!plexAdaptivePoller) {
    plexAdaptivePoller = createPlexAdaptivePoller({
      getPlexConfig: async () => {
        const config = await loadMediaConfig();
        return config?.plex || null;
      },
      onLibraryItemChange: handlePlexLibraryItemChange,
      checkUnwatched: checkPlexUnwatchedFast,
      logger: console.log,
    });
  }
  plexAdaptivePoller.start();
}

export function restartPlexAdaptivePoller() {
  if (!plexAdaptivePoller) {
    startPlexAdaptivePoller();
    return;
  }
  plexAdaptivePoller.restart();
}

export function stopPlexAdaptivePoller() {
  plexAdaptivePoller?.stop();
}

export function pokePlexAdaptivePoller() {
  plexAdaptivePoller?.poke();
}

// ---------------------------------------------------------------------------
// Now Playing: independent live-session poller
//
// live_tracking_cache used to be refreshed only once a minute, inside the same
// tick as backups/TMDB prewarm/catch-up sync (see docs/now-playing.md). This
// runs refreshLiveSessions() on its own faster, activity-adaptive timer instead,
// so a session starting or ending shows up in Now Playing in seconds rather than
// up to a minute later, without polling any faster than before while idle.
// ---------------------------------------------------------------------------

let liveSessionPoller = null;

export function startLiveSessionPoller() {
  if (!liveSessionPoller) {
    liveSessionPoller = createLiveSessionPoller({ logger: console.log });
  }
  liveSessionPoller.start();
}

export function stopLiveSessionPoller() {
  liveSessionPoller?.stop();
}

// Called by the Plex WebSocket listener on a "playing" notification, and by
// handleNowPlaying when a viewer shows up after a gap - both mean the cached
// live-session state is likely stale right now, so re-run the poll immediately.
export function pokeLiveSessionPoller() {
  liveSessionPoller?.poke();
}
