// Live-session refresh, completed and stopped session handling, and session watch dispatch (split from scheduled.js).
import { watchedThresholdPercent } from "./tuning.js";
import { shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress } from "./syncOrchestrator.js";
import { buildCacheRow, canInferLiveSessionCompletion, fetchLiveSessions, hydrateCachedSession, isStaleLiveSessionRow } from "./liveSessions.js";
import { isAuthoritativeRestoreActive, setRuntimeState } from "./configStore.js";
import { loadWatchBackupRuntime } from "./watchHistoryBackups.js";
import { buildWatchProvenance } from "./watchProvenance.js";
import { recordWatchAuditEvent } from "./watchAudit.js";
import { listUpNextProviderFeedStates } from "./upNextRepository.js";
import { refreshUpNextProviderFeeds } from "./upNextProviderSync.js";
import { playstateBlocksStoredResumeProgress, resumeProgressBlockedByPlaystate } from "./resumeAuthority.js";
import { deleteLiveTrackingCacheRows, deletePlaybackProgress, findWatchedByAnyMediaKey, getPlaybackProgressForMedia, getPlaystateForMedia, insertWatchRecord, invalidateHistoryDerivedCaches, loadLiveTrackingCache, markLiveTrackingComplete, mediaKeyFor, mediaToPlaybackProgressRecord, mediaToWatchRecord, purgeCompletedLiveTrackingCache, updatePlaybackProgressTelemetry, updateWatchTelemetry, upsertLiveTrackingCache, upsertPlaybackProgress, upsertPlaystateForMedia } from "./dataRepo.js";
import { withSeriesIdentity } from "./seriesIdentity.js";
import { buildTelemetry, buildProgressTelemetry, recordSyncHistory } from "./syncHistoryTelemetry.js";

// A failed provider feed is a connection-health signal. Retry only that
// provider on a short cadence instead of waiting for the full catch-up window
// or polling healthy media servers more often than necessary.
export const UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS || 2 * 60 * 1000),
);
// The automatic push returns "unchanged" before reading any feed, and the retry
// above covers only feeds already failed, so an outage used to stay invisible
// (feeds "succeeded", no status line) until the queue changed (defect AA). The
// live-session poll already asks every provider each tick; when one of those
// calls fails, re-read that provider's Up Next feeds so the failure is recorded.
// Throttled per provider so a flaky sessions endpoint cannot hammer the feeds.
const upNextOutageProbeAt = new Map();
const upNextOutageProbesInFlight = new Set();

export function upNextProvidersToProbeForOutage(failedSources, config, { now = Date.now(), feeds = listUpNextProviderFeedStates() } = {}) {
  return [...(failedSources || [])].map((source) => String(source || "").trim().toLowerCase()).filter((provider) => {
    if (!["plex", "emby", "jellyfin"].includes(provider)) return false;
    const section = config?.[provider] || {};
    if (section.disabled || !section.baseUrl) return false;
    if (provider === "plex" ? !section.token : !((section.apiKey || section.api_key || section.token) && section.userId)) return false;
    if (upNextOutageProbesInFlight.has(provider)) return false;
    if (now - (upNextOutageProbeAt.get(provider) || 0) < UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS) return false;
    const providerFeeds = (Array.isArray(feeds) ? feeds : []).filter((feed) => String(feed?.provider || "").toLowerCase() === provider);
    // Already recorded as failed: the scheduler's retry owns it from here.
    return !(providerFeeds.length && providerFeeds.every((feed) => ["failed", "partial"].includes(String(feed?.status || "").toLowerCase())));
  });
}

function probeUpNextFeedsAfterSessionFailure(failedSources, config, logger) {
  if (!failedSources?.size) return;
  const providers = upNextProvidersToProbeForOutage(failedSources, config);
  if (!providers.length) return;
  const now = Date.now();
  for (const provider of providers) {
    upNextOutageProbeAt.set(provider, now);
    upNextOutageProbesInFlight.add(provider);
  }
  logger(`Live Sessions: ${providers.join(", ")} did not answer; re-reading its Up Next feeds.`);
  refreshUpNextProviderFeeds({ config, providers })
    .catch((error) => logger(`Up Next outage probe failed: ${error?.message || error}`))
    .finally(() => { for (const provider of providers) upNextOutageProbesInFlight.delete(provider); });
}

function cachedRowToMedia(row) {
  const session = hydrateCachedSession(row);
  const client = session.client && typeof session.client === "object" ? session.client : {};
  return {
    ...session,
    type: session.mediaType,
    source: session.source || row.source_platform,
    device: session.device || session.deviceName || client.deviceName || "",
    deviceId: session.deviceId || client.deviceId || "",
    clientName: session.clientName || client.client || client.product || client.platform || "",
    clientVersion: session.clientVersion || client.version || "",
    user: session.user || client.userName || "",
    isValid: Boolean(session.title && (session.mediaType === "movie" || session.mediaType === "episode") && session.source),
  };
}

// Test seam: lets a test land an unwatch between the first playstate read and the write.
let completionBeforeRecheckHook = null;
export function __setCompletionBeforeRecheckHook(fn) {
  completionBeforeRecheckHook = typeof fn === "function" ? fn : null;
}
// Test seam: lets a test fail the playstate write that follows the history insert.
let completionAfterInsertHook = null;
export function __setCompletionAfterInsertHook(fn) {
  completionAfterInsertHook = typeof fn === "function" ? fn : null;
}
// Test seam: lets a test fail the resume-progress write for a stopped session.
let stoppedProgressBeforeWriteHook = null;
export function __setStoppedProgressBeforeWriteHook(fn) {
  stoppedProgressBeforeWriteHook = typeof fn === "function" ? fn : null;
}

function sessionWatchProvenance(media, row, watchedAt) {
  return buildWatchProvenance(
    {
      source: media.source,
      event: media.event || "playback.complete",
      phase: "completed",
      sessionId: row.session_id,
      user: media.user,
      device: media.device,
      deviceId: media.deviceId,
      client: media.clientName,
      clientVersion: media.clientVersion,
    },
    {
      ingestPath: "live_session",
      sourceTimestamp: watchedAt,
    },
  );
}

// Outbound dispatch for one watch row, recorded on that row. Shared by the first
// completion and by a retry that finds the row an earlier attempt left undispatched.
async function dispatchSessionWatch(media, config, loopStore, sessionId, watchId) {
  let syncSummary;
  try {
    syncSummary = await syncMediaPlaystate(media, config, loopStore);
  } catch (error) {
    console.error("Live tracking sync dispatch failed", { sessionId, error });
    syncSummary = {
      status: "error",
      details: String(error?.message || error || "Outbound sync failed"),
      skipped: false,
      targetStates: [],
    };
  }
  const telemetry = buildTelemetry(media, syncSummary);
  await updateWatchTelemetry(watchId, telemetry, { skipInvalidate: true });
  await recordSyncHistory(media, syncSummary, "watched");
  return telemetry;
}

async function processCompletedSession(row, config, loopStore) {
  if (isAuthoritativeRestoreActive()) return null;
  let media = cachedRowToMedia(row);
  if (!media.isValid || Number(media.progress || 0) < watchedThresholdPercent()) return null;
  // Same series resolution as webhooks and Continue Watching; without it an id-less
  // live session folds onto whichever show profile history already holds for the title.
  media = await withSeriesIdentity(media, config);

  // After an authoritative restore, drop stale cached sessions whose last update predates the
  // restore â€” they would otherwise post a watch record dated today. Sessions still genuinely
  // active get re-cached with a fresh timestamp each tick, so real playback still completes.
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (lastRestoreAt && Number(row.updated_at || 0) <= lastRestoreAt) {
    return null;
  }

  // Invariant: never re-date an already-watched item to today. An item already
  // held as watched is recorded again only as a rewatch, by the same rule the
  // webhook path uses: its last watch fell on an earlier UTC day than this
  // session. A session crossing the threshold is playback evidence, so unlike a
  // played-flag event it can open a rewatch (core-sync-health step 2).
  const lastSeenDay = Number(row.updated_at || 0) > 0 ? new Date(Number(row.updated_at)).toISOString().slice(0, 10) : "";
  const knownPlaystate = await getPlaystateForMedia(media).catch(() => null);
  // A manual unwatch made after this session was last seen wins: the play ended before it.
  if (resumeProgressBlockedByPlaystate(knownPlaystate, row.updated_at) === "item is unwatched") return null;
  let isRewatchOnNewDay = false;
  if (knownPlaystate?.state === "watched") {
    const lastWatchedDay = String(knownPlaystate.watched_at || "").slice(0, 10);
    if (!lastWatchedDay || !lastSeenDay || lastWatchedDay >= lastSeenDay) return null;
    isRewatchOnNewDay = true;
  }
  // getPlaystateForMedia can still miss an already-recorded watch stored
  // under a media_key from a different source - see the matching comment on
  // the webhook handlers. A real session crossing the watched threshold is
  // trustworthy evidence a play happened, but it still should not create a
  // second row for an episode already recorded under a different key. An
  // approved rewatch skips it: it would re-find the old watch just compared.
  const existingByAnyKey = isRewatchOnNewDay ? null : await findWatchedByAnyMediaKey(media).catch(() => null);
  if (isAuthoritativeRestoreActive()) return null;
  if (existingByAnyKey) {
    await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
    // An earlier attempt wrote this session's history row but failed before recording its dispatch:
    // dispatch that one row. The created_at check keeps older rows with no telemetry (imports) out.
    const lastSeenMs = Number(row.updated_at || 0);
    if (!existingByAnyKey.sync_dispatch_telemetry && lastSeenMs > 0 && Number(existingByAnyKey.created_at || 0) >= lastSeenMs) {
      media.watched_at = existingByAnyKey.watched_at || undefined;
      media.watchProvenance = sessionWatchProvenance(media, row, new Date(lastSeenMs).toISOString());
      await dispatchSessionWatch(media, config, loopStore, row.session_id, existingByAnyKey.id);
      await invalidateHistoryDerivedCaches("processCompletedSession").catch(() => null);
    }
    return null;
  }

  if (isAuthoritativeRestoreActive()) return null;

  // Date the watch from when the session was last seen playing, not from when
  // this tick noticed it disappeared. For a session completing normally the two
  // are within a minute of each other; for one that lingered in the cache
  // (server restart, a tick that could not reach the media server) the last-seen
  // time is the real watch time and the current time would be wrong.
  const lastSeenAt = Number(row.updated_at || 0);
  const watchedAt = lastSeenAt > 0 ? new Date(lastSeenAt).toISOString() : "";
  media.watched_at = watchedAt || undefined;
  media.watchProvenance = sessionWatchProvenance(media, row, watchedAt);
  const watchRecord = mediaToWatchRecord(media, media.source);

  if (isAuthoritativeRestoreActive()) return null;
  // An unwatch can land during the awaits above; re-read it right before the write.
  if (completionBeforeRecheckHook) await completionBeforeRecheckHook(media);
  const latestPlaystate = await getPlaystateForMedia(media).catch(() => null);
  if (resumeProgressBlockedByPlaystate(latestPlaystate, row.updated_at) === "item is unwatched") return null;
  const inserted = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
  if (isAuthoritativeRestoreActive()) return null;
  if (completionAfterInsertHook) await completionAfterInsertHook(media);
  await upsertPlaystateForMedia(media, "watched", inserted.record.watched_at, { skipInvalidate: true });
  // Marked only after both writes: a failed insert or upsert leaves the cached row for a retry.
  await markLiveTrackingComplete(row.session_id, Date.now());
  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: lastSeenAt > 0 ? lastSeenAt : Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    watchProvenance: media.watchProvenance,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: row.session_id,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.clientName,
    clientVersion: media.clientVersion,
    status: "completed",
    details: "Live playback session ended after reaching the watched threshold.",
    payload: { progress: media.progress, offsetMs: media.offsetMs, durationMs: media.durationMs },
  });
  const telemetry = await dispatchSessionWatch(media, config, loopStore, row.session_id, inserted.id);
  await deletePlaybackProgress(media).catch((error) => {
    console.error("Failed to clear completed resume progress", { sessionId: row.session_id, error });
  });
  await invalidateHistoryDerivedCaches("processCompletedSession").catch(() => null);

  return { ...inserted, telemetry };
}

async function processStoppedSessionProgress(row, config, loopStore) {
  if (isAuthoritativeRestoreActive()) return null;
  let media = cachedRowToMedia(row);
  if (!shouldSyncResumeProgress(media)) return null;
  media = await withSeriesIdentity(media, config);

  const [existingPlaystate, existingProgress] = await Promise.all([
    getPlaystateForMedia(media).catch(() => null),
    getPlaybackProgressForMedia(media).catch(() => null),
  ]);
  const playstateBlockReason = resumeProgressBlockedByPlaystate(existingPlaystate, row.updated_at);
  if (playstateBlockReason) {
    if (playstateBlocksStoredResumeProgress(existingPlaystate, existingProgress)) {
      await deletePlaybackProgress(media).catch(() => null);
    }
    console.log("Live tracking resume skipped because playstate is authoritative", {
      title: media.title,
      source: media.source,
      playstateState: existingPlaystate.state,
      playstateUpdatedAt: existingPlaystate.updated_at,
      liveUpdatedAt: row.updated_at,
      reason: playstateBlockReason,
    });
    return null;
  }
  // A webhook stop can land between the last poll that saw this session and the poll that
  // finds it gone. Its position is newer than this cached one, so writing the cache would
  // move every target's resume point backwards.
  const existingProgressUpdatedAt = Number(existingProgress?.updated_at || 0);
  if (existingProgressUpdatedAt > Number(row.updated_at || 0)) {
    console.log("Live tracking resume skipped because newer progress is stored", {
      title: media.title,
      source: media.source,
      storedSource: existingProgress.source,
      storedUpdatedAt: existingProgressUpdatedAt,
      liveUpdatedAt: row.updated_at,
    });
    return null;
  }

  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: Number(row.updated_at || 0) || Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: row.session_id,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.clientName,
    clientVersion: media.clientVersion,
    status: "stopped",
    details: "Live playback session ended before the watched threshold; resume progress was retained.",
    payload: { progress: media.progress, offsetMs: media.offsetMs, durationMs: media.durationMs },
  });

  const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
  if (isAuthoritativeRestoreActive()) return null;
  if (stoppedProgressBeforeWriteHook) await stoppedProgressBeforeWriteHook(media);
  // Not caught here: a failed write must reach refreshLiveSessions so the cached row is kept for a retry.
  await upsertPlaybackProgress({
    ...progressRecord,
    sync_dispatch_telemetry: buildProgressTelemetry(media, {
      skipped: false,
      status: "pending",
      details: "Resume propagation queued",
      targetStates: [],
    }),
  });

  let syncSummary;
  try {
    if (isAuthoritativeRestoreActive()) return null;
    syncSummary = await syncMediaProgress(media, config, loopStore);
  } catch (error) {
    console.error("Live tracking resume progress dispatch failed", { sessionId: row.session_id, error });
    syncSummary = {
      status: "error",
      details: String(error?.message || error || "Resume progress sync failed"),
      skipped: false,
      targetStates: [],
    };
  }

  const telemetry = buildProgressTelemetry(media, syncSummary);
  await updatePlaybackProgressTelemetry(progressRecord, telemetry).catch((error) => {
    console.error("Failed to update stopped session resume telemetry", { sessionId: row.session_id, error });
  });
  await recordSyncHistory(media, syncSummary, "progress");

  return { media, telemetry, status: syncSummary.status };
}

// A session missing from one successful poll isn't trusted as "stopped" on its own - it
// takes two consecutive successful polls of that platform with the session still absent.
// This absorbs a one-off Plex session-key change (e.g. a transcode/quality switch assigns
// a new session id to the same still-playing item) without needing to fix the id matching
// itself. Keyed by session_id; cleared as soon as a session is seen again or acted on.
const missingLiveSessionStreaks = new Map();
const MISSING_LIVE_SESSION_CONFIRMATION_POLLS = 2;

// Fetches current Plex/Emby/Jellyfin sessions, reconciles them against
// live_tracking_cache, and processes any session that dropped out (completed
// or stopped/paused) since the last call. Shared by the once-a-minute
// scheduled-sync tick and the independent, faster live-session poller
// (liveSessionPoller.js) so both drive the exact same completion/propagation
// logic instead of maintaining two copies of it.
export async function refreshLiveSessions(config, loopStore, { logger = () => {}, trace = () => {} } = {}) {
  if (isAuthoritativeRestoreActive()) return { currentRows: [], completions: [], progressUpdates: [], staleIds: [], cachedCount: 0, pendingConfirmations: 0, skipped: true };
  const { sessions: currentSessions, failedSources } = await fetchLiveSessions(config);
  probeUpNextFeedsAfterSessionFailure(failedSources, config, logger);
  const currentRows = currentSessions.map(buildCacheRow);
  const currentIds = new Set(currentRows.map((row) => row.session_id));
  const cachedRows = await loadLiveTrackingCache({ includeCompleted: true });
  const completions = [];
  const progressUpdates = [];
  const staleIds = [];
  const now = Date.now();

  if (isAuthoritativeRestoreActive()) return { currentRows: [], completions: [], progressUpdates: [], staleIds: [], cachedCount: cachedRows.length, pendingConfirmations: 0, skipped: true };

  if (currentRows.length || cachedRows.length) {
    trace(`Live sessions: ${currentRows.length}, cached sessions in tracking: ${cachedRows.length}`);
  }
  await upsertLiveTrackingCache(currentRows);

  for (const row of cachedRows) {
    if (isAuthoritativeRestoreActive()) return { currentRows, completions, progressUpdates, staleIds, cachedCount: cachedRows.length, pendingConfirmations: missingLiveSessionStreaks.size, skipped: true };
    if (currentIds.has(row.session_id)) {
      missingLiveSessionStreaks.delete(row.session_id);
      continue;
    }
    if (row.completed_at) continue;

    // This platform's poll just failed, so an empty result is not evidence anything
    // stopped - it's evidence we couldn't ask. Leave the cached row untouched and try
    // again next tick rather than counting this as a missed appearance.
    if (failedSources.has(String(row.source_platform || "").toLowerCase())) continue;

    if (isStaleLiveSessionRow(row, now)) {
      missingLiveSessionStreaks.delete(row.session_id);
      staleIds.push(row.session_id);
      logger(`Live session cache row was too old to infer a stop: ${row.title} (${row.session_id})`);
      continue;
    }

    const missCount = (missingLiveSessionStreaks.get(row.session_id) || 0) + 1;
    if (missCount < MISSING_LIVE_SESSION_CONFIRMATION_POLLS) {
      missingLiveSessionStreaks.set(row.session_id, missCount);
      continue;
    }
    missingLiveSessionStreaks.delete(row.session_id);

    if (Number(row.last_progress || 0) >= watchedThresholdPercent()) {
      if (!canInferLiveSessionCompletion(row, now)) {
        staleIds.push(row.session_id);
        logger(`Live session disappeared but its row cannot prove a completed watch; not inferring one: ${row.title} (${row.session_id})`);
        continue;
      }
      logger(`Live session completed playback: ${row.title} (${row.session_id})`);
      let completion;
      try {
        completion = await processCompletedSession(row, config, loopStore);
      } catch (error) {
        // Keep the cached row: a later tick retries it until isStaleLiveSessionRow drops it.
        logger(`ERROR: processCompletedSession failed for ${row.title}: ${error.message}`);
        continue;
      }
      if (completion) completions.push(completion);
      else staleIds.push(row.session_id);
      continue;
    }

    logger(`Live session stopped/paused playback: ${row.title} (${row.session_id})`);
    let progressUpdate;
    try {
      progressUpdate = await processStoppedSessionProgress(row, config, loopStore);
    } catch (error) {
      // Keep the cached row for the same bounded retry as a failed completion.
      logger(`ERROR: processStoppedSessionProgress failed for ${row.title}: ${error.message}`);
      continue;
    }
    if (progressUpdate) progressUpdates.push(progressUpdate);
    staleIds.push(row.session_id);
  }

  await deleteLiveTrackingCacheRows(staleIds);
  await purgeCompletedLiveTrackingCache();

  if (currentRows.length || completions.length || progressUpdates.length || staleIds.length) {
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
  }

  return {
    currentRows,
    completions,
    progressUpdates,
    staleIds,
    cachedCount: cachedRows.length,
    pendingConfirmations: missingLiveSessionStreaks.size,
  };
}
