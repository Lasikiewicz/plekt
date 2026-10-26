import { shouldSyncResumeProgress, syncMediaProgress } from "./utils/syncOrchestrator.js";
import { mediaIsUpNextRailSeed } from "./utils/upNextSeedLedger.js";
import { parsePlexMediaIds } from "./utils/parsers.js";
import { activeSyncOperation, clearSyncOperation, claimSyncOperation, isAuthoritativeRestoreActive, loadMediaConfig, loadRuntimeState, releaseSyncOperation, setRuntimeState, touchSyncOperation, RESTORE_KIND_BACKUP, RESTORE_KIND_FULL_SYNC, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { isCronSyncPaused, loadWatchBackupRuntime } from "./utils/watchHistoryBackups.js";
import { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
import { isVerboseLogging } from "./utils/logVerbose.js";
import { loadTrackerWatchedDateIndex } from "./utils/mediaForceSync.js";
import { startUpNextProviderFeed, completeUpNextProviderFeed, failUpNextProviderFeed, listUpNextProviderFeedStates, redactUpNextProviderError, withUpNextFeedSeriesIdentity } from "./utils/upNextRepository.js";
import { refreshUpNextProviderFeeds } from "./utils/upNextProviderSync.js";
import { reconcileAvailableWatchedItems } from "./utils/libraryAvailabilitySync.js";
import { brandEnv } from "./utils/brandEnv.js";
import { runDueUnwatchedPolls } from "./utils/unwatchedStatusPoll.js";
import { UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS } from "./utils/liveSessionCompletion.js";
import { buildProgressTelemetry, recordSyncHistory } from "./utils/syncHistoryTelemetry.js";
import { syncRecentlyWatchedFromPlex, syncRecentlyWatchedFromEmby, syncRecentlyWatchedFromJellyfin } from "./utils/recentWatchImport.js";
import { syncPendingManualDispatches } from "./utils/syncDispatchQueue.js";
import {
  playstateBlocksStoredResumeProgress,
  resumePositionUnchanged,
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
} from "./utils/resumeAuthority.js";
export { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
export {
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
} from "./utils/resumeAuthority.js";
import { deletePlaybackProgress, getPlaybackProgressForMedia, getPlaystateForMedia, loadLiveTrackingCache, mediaToPlaybackProgressRecord, updatePlaybackProgressTelemetry, upsertPlaybackProgress } from "./utils/dataRepo.js";
import { withSeriesIdentity } from "./utils/seriesIdentity.js";
// Provider feed snapshots are complete; only canonical resume propagation is
// bounded so a large Continue Watching list cannot create an outbound burst.
const SCHEDULED_RESUME_SYNC_LIMIT = 50;
// Cadence for background catch-up library syncs (recently watched & continue watching lists).
// These serve as backstops for events missed by webhooks/live session tracking, so they
// do not need to run on every 1-minute tick.
const CATCHUP_SYNC_INTERVAL_MS = Number(process.env.CATCHUP_SYNC_INTERVAL_MS || process.env.CATCHUP_SYNC_INTERVAL || 15 * 60 * 1000);
let lastCatchupSyncAt = 0;

function failedUpNextProvidersDue(now = Date.now()) {
  const providers = new Set();
  for (const feed of listUpNextProviderFeedStates()) {
    if (!["failed", "partial"].includes(String(feed?.status || "").toLowerCase())) continue;
    const updatedAt = Number(feed?.updated_at || 0);
    if (!updatedAt || now - updatedAt < UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS) continue;
    const provider = String(feed?.provider || "").trim().toLowerCase();
    if (["plex", "emby", "jellyfin"].includes(provider)) providers.add(provider);
  }
  return [...providers];
}

async function retryFailedUpNextProviderFeeds(config, logger = console.log) {
  const providers = failedUpNextProvidersDue().filter((provider) => {
    const section = config?.[provider] || {};
    if (section.disabled || !section.baseUrl) return false;
    if (provider === "plex") return Boolean(section.token);
    return Boolean((section.apiKey || section.api_key || section.token) && section.userId);
  });
  if (!providers.length) return 0;
  logger(`Scheduled Sync: retrying failed Up Next connection(s): ${providers.join(", ")} (interval: ${UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS / 60000}m)...`);
  const results = await refreshUpNextProviderFeeds({ config, providers });
  const failed = results.filter((result) => result?.status === "failed").length;
  logger(`Scheduled Sync: retried ${results.length} Up Next feed(s); ${failed} still unavailable.`);
  return results.length;
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function epochMsFromSeconds(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) : 0;
}

function timestampMsFromDate(value = "") {
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function progressPercent(positionMs = 0, durationMs = 0) {
  if (!durationMs) return 0;
  return Math.max(0, Math.min(100, (Number(positionMs || 0) / Number(durationMs || 1)) * 100));
}

export function mediaFromPlexResumableItem(item = {}) {
  const type = item.type === "episode" ? "episode" : "movie";
  const positionMs = millisecondsFrom(item.viewOffset);
  const durationMs = millisecondsFrom(item.duration);
  const season = item.parentIndex != null ? Number(item.parentIndex) : null;
  const episode = item.index != null ? Number(item.index) : null;
  return {
    title: type === "episode"
      ? `${item.grandparentTitle || item.title || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.title || "Unknown Movie",
    type,
    source: "plex",
    season,
    episode,
    // Episodes carry their own tmdb/tvdb guid, distinct from the show's -
    // prefer the grandparent (series) guid so resume progress keys on the
    // same show identity every other ingestion path resolves.
    ids: parsePlexMediaIds(item, type),
    episodeTitle: type === "episode" ? item.title : null,
    providerItemId: item.ratingKey || null,
    providerItems: { plex: item.ratingKey ? [String(item.ratingKey)] : [] },
    seriesItemId: item.grandparentRatingKey || item.parentRatingKey || null,
    seriesProviderItemId: item.grandparentRatingKey || item.parentRatingKey || null,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress: progressPercent(positionMs, durationMs),
    updatedAt: epochMsFromSeconds(item.lastViewedAt || item.viewedAt || item.updatedAt),
    isValid: true,
  };
}

function embyLikeResumeUpdatedAt(item = {}) {
  return timestampMsFromDate(
    item.UserData?.LastPlayedDate ||
      item.UserData?.PlayedDate ||
      item.UserData?.DatePlayed ||
      item.LastPlayedDate ||
      item.PlayedDate ||
      item.DatePlayed,
  );
}

export function mediaFromEmbyLikeResumableItem(item = {}, source = "emby", normalizeProviderIds = (ids) => ids || {}) {
  // Episode provider IDs are often episode-scoped. Cross-server lookup first
  // resolves the series and then selects SxxExx, so retain the series IDs too.
  const ids = normalizeProviderIds(
    item.Type === "Episode"
      ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
      : (item.ProviderIds || {}),
  );
  const type = item.Type === "Episode" ? "episode" : "movie";
  const season = item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null;
  const episode = item.IndexNumber != null ? Number(item.IndexNumber) : null;
  const positionMs = ticksToMilliseconds(item.UserData?.PlaybackPositionTicks || item.PlaybackPositionTicks || item.PositionTicks);
  const durationMs = ticksToMilliseconds(item.RunTimeTicks || item.DurationTicks);
  return {
    title: type === "episode"
      ? `${item.SeriesName || item.ParentName || item.Name || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`
      : item.Name || item.Title || "Unknown Movie",
    type,
    source,
    season,
    episode,
    ids: {
      imdb: ids.imdb || undefined,
      tmdb: ids.tmdb || undefined,
      tvdb: ids.tvdb || undefined,
    },
    episodeTitle: type === "episode" ? item.Name : null,
    providerItemId: item.Id || null,
    providerItems: { [source]: item.Id ? [String(item.Id)] : [] },
    seriesItemId: item.SeriesId || item.ParentId || null,
    seriesProviderItemId: item.SeriesId || item.ParentId || null,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress: progressPercent(positionMs, durationMs),
    updatedAt: embyLikeResumeUpdatedAt(item),
    isValid: true,
  };
}

// Resume progress is re-evaluated on every tick, so an item that is correctly
// skipped repeats the same line every minute indefinitely. Remember the last
// outcome per item and only log when it actually changes.
const lastResumeOutcome = new Map();
const LAST_RESUME_OUTCOME_MAX = 500;

function logResumeSkip(logger, media, outcome) {
  const key = `${media.source}|${media.title}|${media.season ?? ""}|${media.episode ?? ""}`;
  if (lastResumeOutcome.get(key) === outcome) return;
  if (lastResumeOutcome.size >= LAST_RESUME_OUTCOME_MAX) lastResumeOutcome.clear();
  lastResumeOutcome.set(key, outcome);
  logger(`Resume Sync: ${media.title} from ${media.source} -> skipped (${outcome})`);
}

function clearResumeOutcome(media) {
  lastResumeOutcome.delete(`${media.source}|${media.title}|${media.season ?? ""}|${media.episode ?? ""}`);
}

async function fetchAndRecordUpNextFeed(provider, feedKind, fetchItems, logger = console.log, providerConfig = null) {
  if (isAuthoritativeRestoreActive()) return [];
  const generation = startUpNextProviderFeed(provider, feedKind);
  try {
    const items = await fetchItems();
    const storedItems = await withUpNextFeedSeriesIdentity(provider, items, providerConfig);
    if (isAuthoritativeRestoreActive()) return [];
    completeUpNextProviderFeed(provider, feedKind, generation, storedItems);
    return items;
  } catch (error) {
    failUpNextProviderFeed(provider, feedKind, generation, error);
    logger(`${provider} ${feedKind} feed failed: ${redactUpNextProviderError(error)}`);
    throw error;
  }
}

async function syncResumableMedia(media, config, loopStore, logger = console.log) {
  // Resolve the media server's native series handle before checking or writing
  // progress. Without this, an episode-level IMDb/TVDB id can create a second
  // row for the same SxxExx item before the scheduled feed has a chance to
  // reconcile it.
  media = await withSeriesIdentity(media, config);
  if (isAuthoritativeRestoreActive()) return false;
  // A position Plembfin itself wrote to put this item on the provider's
  // Continue Watching rail is not something the user watched. It is above the
  // resume threshold by design, so only the ledger can tell them apart.
  if (mediaIsUpNextRailSeed(media)) {
    logResumeSkip(logger, media, "Legacy Up Next rail seed, not real playback");
    return false;
  }
  if (!shouldSyncResumeProgress(media)) {
    logResumeSkip(logger, media, "not actionable");
    return false;
  }

  const [existingPlaystate, existingProgress] = await Promise.all([
    getPlaystateForMedia(media).catch(() => null),
    getPlaybackProgressForMedia(media).catch(() => null),
  ]);
  const incomingResumeUpdatedAt = Number(media.updatedAt || 0);
  const resumeUpdatedAt = resumeProgressAuthorityTimestamp(existingProgress, media);

  // After an authoritative restore, ignore resume positions whose app-side timestamp predates
  // the restore â€” they are pre-restore state the backup has already superseded.
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (lastRestoreAt && incomingResumeUpdatedAt > 0 && incomingResumeUpdatedAt <= lastRestoreAt) {
    logResumeSkip(logger, media, "pre-restore resume position");
    return false;
  }

  const playstateBlockReason = resumeProgressBlockedByPlaystate(existingPlaystate, resumeUpdatedAt);
  if (playstateBlockReason) {
    // Reject this stale candidate, but do not let it erase a newer position
    // already stored in Plembfin. Only canonical state that also outranks the
    // stored row is allowed to clear that row.
    if (isAuthoritativeRestoreActive()) return false;
    if (playstateBlocksStoredResumeProgress(existingPlaystate, existingProgress)) {
      await deletePlaybackProgress(media).catch(() => null);
    }
    logResumeSkip(logger, media, playstateBlockReason);
    return false;
  }

  const progressUpdatedAt = Number(existingProgress?.updated_at || 0);

  if (existingProgress && incomingResumeUpdatedAt <= 0 && resumePositionUnchanged(existingProgress, media)) {
    logResumeSkip(logger, media, "unchanged resume progress without timestamp");
    return false;
  }

  if (existingProgress && incomingResumeUpdatedAt > 0 && progressUpdatedAt >= incomingResumeUpdatedAt) {
    logResumeSkip(logger, media, "stale resume progress");
    return false;
  }

  const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
  if (isAuthoritativeRestoreActive()) return false;
  await upsertPlaybackProgress({
    ...progressRecord,
    sync_dispatch_telemetry: buildProgressTelemetry(media, {
      skipped: false,
      status: "pending",
      details: "Resume propagation queued from server continue-watching list",
      targetStates: [],
    }),
  }).catch((error) => {
    logger(`Resume Sync: failed to store progress for ${media.title}: ${error.message}`);
  });

  let summary;
  try {
    summary = await syncMediaProgress(media, config, loopStore);
  } catch (error) {
    summary = {
      status: "error",
      details: `Resume propagation failed: ${error.message || String(error)}`,
      skipped: false,
      targetStates: [],
    };
  }

  await updatePlaybackProgressTelemetry(progressRecord, buildProgressTelemetry(media, summary)).catch(() => null);
  await recordSyncHistory(media, summary, "progress");
  clearResumeOutcome(media);
  logger(`Resume Sync: ${media.title} from ${media.source} -> ${summary.status}`);
  return summary.status === "success" || summary.status === "partial";
}

async function syncRecentlyResumableFromPlex(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Plex resume library sync is disabled.");
    return 0;
  }
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  let syncedCount = 0;
  try {
    const { fetchPlexContinueWatchingItems } = await import("./utils/plexClient.js");
    const raw = await fetchAndRecordUpNextFeed(
      "plex",
      "resume",
      () => fetchPlexContinueWatchingItems(config.plex, { limit: 0 }),
      logger,
      config.plex,
    );
    const propagationItems = raw.slice(0, SCHEDULED_RESUME_SYNC_LIMIT);
    logger(`Plex: fetched ${raw.length} Continue Watching item(s); propagating the newest ${propagationItems.length}.`);
    for (const item of propagationItems) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      if (await syncResumableMedia(mediaFromPlexResumableItem(item), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Plex resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyResumableFromEmby(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Emby resume library sync is disabled.");
    return 0;
  }
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;

  let syncedCount = 0;
  try {
    const { fetchEmbyResumableItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchAndRecordUpNextFeed(
      "emby",
      "resume",
      () => fetchEmbyResumableItems(config.emby, { limit: 0 }),
      logger,
      config.emby,
    );
    const propagationItems = raw.slice(0, SCHEDULED_RESUME_SYNC_LIMIT);
    logger(`Emby: fetched ${raw.length} Continue Watching item(s); propagating the newest ${propagationItems.length}.`);
    for (const item of propagationItems) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      if (await syncResumableMedia(mediaFromEmbyLikeResumableItem(item, "emby", normalizeProviderIds), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Emby resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyResumableFromJellyfin(config, loopStore, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Jellyfin resume library sync is disabled.");
    return 0;
  }
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;

  let syncedCount = 0;
  try {
    const { fetchJellyfinResumableItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    // Jellyfin Continue Watching is not Plembfin's target rail, but the feed
    // is still recorded so genuine part-watches can protect their positions
    // while Jellyfin Next Up is reconciled separately.
    const raw = await fetchAndRecordUpNextFeed(
      "jellyfin",
      "resume",
      () => fetchJellyfinResumableItems(config.jellyfin, { limit: 0 }),
      logger,
      config.jellyfin,
    );
    const propagationItems = raw.slice(0, SCHEDULED_RESUME_SYNC_LIMIT);
    logger(`Jellyfin: fetched ${raw.length} Continue Watching item(s); propagating the newest ${propagationItems.length}.`);
    for (const item of propagationItems) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      if (await syncResumableMedia(mediaFromEmbyLikeResumableItem(item, "jellyfin", normalizeProviderIds), config, loopStore, logger)) syncedCount++;
    }
  } catch (error) {
    logger(`Jellyfin resume sync failed: ${error.message}`);
  }
  return syncedCount;
}

async function syncRecentlyNextUpFromEmby(config, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) return 0;
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;
  try {
    const { fetchEmbyNextUpItems } = await import("./utils/embyClient.js");
    const raw = await fetchAndRecordUpNextFeed(
      "emby",
      "next_up",
      () => fetchEmbyNextUpItems(config.emby, { limit: 0 }),
      logger,
      config.emby,
    );
    // This remains an observation for compatibility; Emby's target native
    // rail is Continue Watching/Resume.
    logger(`Emby: fetched ${raw.length} next-up observation(s).`);
    return raw.length;
  } catch (error) {
    logger(`Emby next-up sync failed: ${error.message}`);
    return 0;
  }
}

async function syncRecentlyNextUpFromJellyfin(config, logger = console.log) {
  if (!watchedPlayedSyncEnabled()) return 0;
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;
  try {
    const { fetchJellyfinNextUpItems } = await import("./utils/jellyfinClient.js");
    const raw = await fetchAndRecordUpNextFeed(
      "jellyfin",
      "next_up",
      () => fetchJellyfinNextUpItems(config.jellyfin, { limit: 0 }),
      logger,
      config.jellyfin,
    );
    logger(`Jellyfin: fetched ${raw.length} Next Up item(s).`);
    return raw.length;
  } catch (error) {
    logger(`Jellyfin Next Up sync failed: ${error.message}`);
    return 0;
  }
}

async function runScheduledSyncCore(logger = console.log, { forceCatchup = false } = {}) {
  if (isAuthoritativeRestoreActive()) {
    logger("Scheduled Sync: skipped because an authoritative watch-history restore is active.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }
  if (isCronSyncPaused()) {
    logger("Scheduled Sync: skipped because cron sync is paused (likely due to restore in progress).");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  // Per-phase narration is worth showing when a user explicitly triggered a
  // catch-up run (workerCoordinator passes forceCatchup and surfaces the job
  // log), but on the per-minute background tick it was ~9 lines every minute
  // whether or not anything happened. The end-of-run summary still logs, and
  // is itself suppressed when the run was a complete no-op.
  const trace = forceCatchup || isVerboseLogging() ? logger : () => {};

  trace("Scheduled Sync: starting background sync workflow...");
  const runtime = await loadRuntimeState();

  // Stale operation recovery happens before the scheduler claims this lock.
  // Once this wrapper owns the scheduled marker, the core must not clear
  // another operation's state directly.
  // so it is NEVER un-blocked here â€” that prevents the cron from running mid-push and re-importing
  const operation = activeSyncOperation(runtime);
  const blockingOperation = operation && operation.kind !== SYNC_OPERATION_SCHEDULED;
  if (runtime.rebuildActive === true || runtime.forceSyncActive === true || runtime.restoreSyncActive === true || blockingOperation) {
    logger("Scheduled Sync: skipped because a database rebuild, force sync, or authoritative restore is currently active.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }
  await setRuntimeState({ lastCronExecution: Date.now() }).catch(() => null);
  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  const plexActive = !config?.plex?.disabled && Boolean(config?.plex?.baseUrl && config?.plex?.token);
  const embyActive = !config?.emby?.disabled && Boolean(config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId);
  const jellyfinActive = !config?.jellyfin?.disabled && Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId);

  const hasConfiguredSources = plexActive || embyActive || jellyfinActive;

  if (!hasConfiguredSources) {
    logger("Scheduled Sync: skipped; no active configured media servers were found.");
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true };
  }

  await runDueUnwatchedPolls({ config, loopStore, plexActive, embyActive, jellyfinActive, logger, trace });

  let plexSynced = 0;
  let embySynced = 0;
  let jellyfinSynced = 0;
  let plexResumeSynced = 0;
  let embyResumeSynced = 0;
  let jellyfinResumeSynced = 0;
  let embyNextUpFetched = 0;
  let jellyfinNextUpFetched = 0;
  let availabilityRepairs = 0;
  let manualSynced = 0;

  const shouldRunCatchup = forceCatchup || !lastCatchupSyncAt || (Date.now() - lastCatchupSyncAt >= CATCHUP_SYNC_INTERVAL_MS);
  let upNextFailedFeedsRetried = 0;
  if (!shouldRunCatchup) {
    // The normal 15-minute catch-up already polls every active provider. On
    // intervening ticks, only retry providers whose last Up Next feed failed.
    upNextFailedFeedsRetried = await retryFailedUpNextProviderFeeds(config, logger).catch((error) => {
      logger(`Scheduled Sync ERROR: failed Up Next connection retry: ${error.message}`);
      return 0;
    });
  }
  if (shouldRunCatchup) {
    lastCatchupSyncAt = Date.now();
    if (forceCatchup) logger("Scheduled Sync: running requested recent-item repair...");
    else trace(`Scheduled Sync: running catch-up library checks (interval: ${CATCHUP_SYNC_INTERVAL_MS / 60000}m)...`);

    // A media server's own "last watched" date can be wrong (see the identical
    // comment in mediaForceSync.js) - fetched once per catch-up pass, not per
    // item, and shared across all three servers below.
    const trackerWatchedDateIndex = await loadTrackerWatchedDateIndex(logger, { trigger: "scheduled" }).catch(() => null);

    if (plexActive) {
      try {
        trace("Scheduled Sync: checking Plex recently watched...");
        plexSynced = await syncRecentlyWatchedFromPlex(config, loopStore, logger, trackerWatchedDateIndex);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby recently watched...");
        embySynced = await syncRecentlyWatchedFromEmby(config, loopStore, logger, trackerWatchedDateIndex);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin recently watched...");
        jellyfinSynced = await syncRecentlyWatchedFromJellyfin(config, loopStore, logger, trackerWatchedDateIndex);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin sync failed: ${error.message}`);
      }
    }

    // A bulk library refresh usually creates provider items with an unplayed
    // user flag. Watched-only history feeds cannot see those items, so run a
    // full, paginated availability pass after watched imports. It is
    // intentionally positive-only: an item must be present in the provider's
    // own successful inventory and already watched in Plembfin before we send
    // a played mark. No provider absence is ever converted into an unwatch.
    if (watchedPlayedSyncEnabled()) {
      try {
        trace("Scheduled Sync: reconciling watched state on newly available library items...");
        const availability = await reconcileAvailableWatchedItems(config, {
          loopStore,
          logger: trace,
          shouldStop: async () => isAuthoritativeRestoreActive(),
          onMarked: (media, summary) => recordSyncHistory(media, summary, "watched"),
        });
        availabilityRepairs = availability.marked;
      } catch (error) {
        logger(`Scheduled Sync ERROR: library availability reconciliation failed: ${error.message}`);
      }
    }

    if (plexActive) {
      try {
        trace("Scheduled Sync: checking Plex continue watching...");
        plexResumeSynced = await syncRecentlyResumableFromPlex(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex resume sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby continue watching...");
        embyResumeSynced = await syncRecentlyResumableFromEmby(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby resume sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin continue watching...");
        jellyfinResumeSynced = await syncRecentlyResumableFromJellyfin(config, loopStore, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin resume sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby next up...");
        embyNextUpFetched = await syncRecentlyNextUpFromEmby(config, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby next-up sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin Next Up...");
        jellyfinNextUpFetched = await syncRecentlyNextUpFromJellyfin(config, logger);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Jellyfin Next Up sync failed: ${error.message}`);
      }
    }

  }

  try {
    manualSynced = await syncPendingManualDispatches(config, loopStore, logger);
  } catch (error) {
    logger(`Scheduled Sync ERROR: Manual queue sync failed: ${error.message}`);
  }

  // Live-session polling itself (fetch Plex/Emby/Jellyfin sessions, reconcile against
  // live_tracking_cache, process any session that dropped out) now runs continuously on
  // its own faster, activity-adaptive timer - liveSessionPoller.js, started alongside
  // this same scheduler's leadership. Calling refreshLiveSessions() again here on top of
  // that would just poll the same session endpoints a second time every minute for no
  // benefit, so this tick only reads the cache it already keeps current for bookkeeping.
  const liveSessionSnapshot = await loadLiveTrackingCache({ includeCompleted: false }).catch(() => []);

  const totalSynced = plexSynced + embySynced + jellyfinSynced + availabilityRepairs + plexResumeSynced + embyResumeSynced + jellyfinResumeSynced + embyNextUpFetched + jellyfinNextUpFetched + manualSynced;
  const hasActivity = totalSynced > 0 || liveSessionSnapshot.length > 0 || shouldRunCatchup || upNextFailedFeedsRetried > 0;

  if (totalSynced > 0) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  if (hasActivity) {
    logger(`Scheduled Sync complete! Synced Plex: ${plexSynced}, Emby: ${embySynced}, Jellyfin: ${jellyfinSynced}, Library availability repairs: ${availabilityRepairs}, Resume Plex: ${plexResumeSynced}, Resume Emby: ${embyResumeSynced}, Resume Jellyfin: ${jellyfinResumeSynced}, Next Up Emby: ${embyNextUpFetched}, Next Up Jellyfin: ${jellyfinNextUpFetched}, Failed Up Next feeds retried: ${upNextFailedFeedsRetried}, Manual: ${manualSynced}`);
  }
  return {
    didWork: hasActivity,
    sessions: liveSessionSnapshot.length,
    completions: 0,
    progressUpdates: 0,
    removed: 0,
    cached: liveSessionSnapshot.length,
    plexHistorySynced: plexSynced,
    embyHistorySynced: embySynced,
    jellyfinHistorySynced: jellyfinSynced,
    availabilityRepairs,
    plexResumeSynced,
    embyResumeSynced,
    jellyfinResumeSynced,
    embyNextUpFetched,
    jellyfinNextUpFetched,
    upNextFailedFeedsRetried,
    manualDispatchesSynced: manualSynced,
  };
}

// Run before the scheduler's restore admission check: an orphaned restore must
// not prevent the scheduler from reaching its own stale-operation recovery.
export async function recoverStaleSyncOperation(logger = console.log) {
  const staleBefore = Date.now() - 3 * 60 * 1000;
  const runtime = await loadRuntimeState();
  const existing = activeSyncOperation(runtime);
  if (existing && existing.heartbeat < staleBefore) {
    const staleValues = existing.kind === SYNC_OPERATION_FORCE
      ? {
        forceSyncActive: false,
        forceSyncCancelRequested: true,
        forceSyncHeartbeat: Date.now(),
        forceSyncResult: { success: false, aborted: true, cancelled: true, reset: true, reason: "Stale Force Sync was recovered by the scheduler." },
      }
      : [RESTORE_KIND_FULL_SYNC, RESTORE_KIND_BACKUP, "restore"].includes(existing.kind)
        ? {
          restoreSyncActive: false,
          restoreSyncRunId: "",
          restoreSyncKind: "",
          restoreSyncCancelRequested: true,
          restoreSyncHeartbeat: Date.now(),
          restoreSyncResult: { success: false, aborted: true, cancelled: true, reset: true, reason: "Stale restore was recovered by the scheduler." },
        }
        : { scheduledSyncActive: false, scheduledSyncHeartbeat: Date.now() };
    logger(`Scheduled Sync: clearing stale ${existing.kind} operation marker...`);
    return clearSyncOperation({
      kind: existing.kind,
      expectedOwnerId: existing.ownerId,
      staleBefore,
      values: staleValues,
    });
  }
  return { ok: false, active: existing };
}

// Scheduled polling also participates in the shared operation lock. Without
// this boundary a Force Sync could claim the lock while a scheduler tick that
// started a moment earlier was still dispatching a watchstate write.
export async function runScheduledSync(logger = console.log, options = {}) {
  const ownerId = `scheduled:${brandEnv("INSTANCE_ID") || process.pid}:${Date.now()}`;
  await recoverStaleSyncOperation(logger);

  const claim = await claimSyncOperation({
    kind: SYNC_OPERATION_SCHEDULED,
    ownerId,
    activeField: "scheduledSyncActive",
    startedAt: Date.now(),
    values: {
      scheduledSyncRunId: ownerId,
      scheduledSyncStartedAt: Date.now(),
      scheduledSyncHeartbeat: Date.now(),
    },
  });
  if (!claim?.ok) {
    logger(`Scheduled Sync: skipped because ${claim?.active?.kind || "another sync operation"} is active.`);
    return { sessions: 0, completions: 0, removed: 0, cached: 0, skipped: true, reason: "sync-operation-active" };
  }

  const heartbeat = setInterval(() => {
    touchSyncOperation({
      kind: SYNC_OPERATION_SCHEDULED,
      ownerId,
      values: { scheduledSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30_000);
  heartbeat.unref?.();
  try {
    return await runScheduledSyncCore(logger, options);
  } finally {
    clearInterval(heartbeat);
    await releaseSyncOperation({
      kind: SYNC_OPERATION_SCHEDULED,
      ownerId,
      values: { scheduledSyncActive: false, scheduledSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }
}
