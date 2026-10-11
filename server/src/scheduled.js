import crypto from "node:crypto";
import { fetchWithTimeout } from "./utils/outbound.js";
import { watchedThresholdPercent, watchImportMode } from "./utils/tuning.js";
import { isRecentOutboundJellyfinNextUpNudge, lastOutboundPlayedMarkAt, recordOutboundPlayedMarks, recordOutboundUnplayedMarks, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "./utils/syncOrchestrator.js";
import { mediaIsUpNextRailSeed } from "./utils/upNextSeedLedger.js";
import { applyUnwatchedTransition } from "./utils/watchStateTransitions.js";
import { parsePlexMediaIds } from "./utils/parsers.js";
import { findPlexItem, resolvePlexAccountId } from "./utils/plexClient.js";
import { fetchPlexWithRefresh } from "./utils/plexFetch.js";
import { buildCacheRow, canInferLiveSessionCompletion, fetchLiveSessions, hydrateCachedSession, isStaleLiveSessionRow } from "./utils/liveSessions.js";
import { activeSyncOperation, appendSyncHistory, clearSyncOperation, claimSyncOperation, isAuthoritativeRestoreActive, loadMediaConfig, loadRuntimeState, releaseSyncOperation, setRuntimeState, touchSyncOperation, RESTORE_KIND_BACKUP, RESTORE_KIND_FULL_SYNC, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "./utils/configStore.js";
import { createLoopStore } from "./utils/loopStore.js";
import { getTrackerConnection } from "./utils/trackerConnectionRepo.js";
import { watchedPlayedSyncEnabled } from "./utils/syncFlags.js";
import { isCronSyncPaused, loadWatchBackupRuntime } from "./utils/watchHistoryBackups.js";
import { executeForceSyncPlan } from "./utils/forceSyncExecutor.js";
import { isEmbyLikePlayed, releaseDateForSourceItem, resolvePlexWatchDate, resolveWatchImportDate, runtimeMinutesForSourceItem, watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "./utils/watchDates.js";
import { remoteEpisodeImportError } from "./utils/episodeImportGuard.js";
import { isVerboseLogging } from "./utils/logVerbose.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "./utils/watchProvenance.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "./utils/watchAudit.js";
import { canReceiveState } from "./utils/syncRoles.js";
import { earliestTraktWatchedAt, loadTraktWatchedDateIndex } from "./utils/mediaForceSync.js";
import { startUpNextProviderFeed, completeUpNextProviderFeed, failUpNextProviderFeed, listUpNextProviderFeedStates, redactUpNextProviderError, withUpNextFeedSeriesIdentity } from "./utils/upNextRepository.js";
import { refreshUpNextProviderFeeds } from "./utils/upNextProviderSync.js";
import { reconcileAvailableWatchedItems } from "./utils/libraryAvailabilitySync.js";
import { brandEnv } from "./utils/brandEnv.js";

// A library-history endpoint exposes the server's current played snapshot; it
// does not prove another viewing occurred. A canonical Plembfin playstate can
// outlive the provider history row the user deliberately removed. Keep an
// explicit canonical unwatch sticky here: provider history is polled data and
// can repeat the old played flag after Plembfin has cleared it.
export function shouldSkipLibraryHistoryImport(existing, playstate) {
  return playstate?.state === "unwatched"
    || (!existing && playstate?.state === "watched");
}

// What a Plex/Emby/Jellyfin library-history row does, given Plembfin's own
// state. A review is never queued for an item Plembfin already has watched:
// its manual watch pushed to the server comes back as a played flag, and
// reviewing it again is noise (Marshals S01E02 on Emby, 23 September 2026).
// A locally unwatched item still goes to review (decision 32).
export function libraryHistoryDecision({ requiresReview = false, existing = null, playstate = null, now = Date.now() } = {}) {
  if (requiresReview) {
    const alreadyWatched = playstate?.state === "watched" || (Boolean(existing) && playstate?.state !== "unwatched");
    return alreadyWatched ? "skip_already_watched" : "review";
  }
  if (recentUnwatchBlocksLibraryImport(playstate, now)) return "skip_recent_unwatch";
  if (shouldSkipLibraryHistoryImport(existing, playstate)) return "skip_already_watched";
  return "import";
}
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
import {
  deleteLiveTrackingCacheRows,
  dispatchGroupsForRows,
  deletePlaybackProgress,
  deleteWatchRecordById,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  findWatchedByMediaKey,
  getCachedHistory,
  getPlaybackProgressForMedia,
  getPlaystateForMedia,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  listRecentTrackedWatchRows,
  listRecentlyUpdatedTrackedWatchRows,
  loadLiveTrackingCache,
  markLiveTrackingComplete,
  mediaKeyFor,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  purgeCompletedLiveTrackingCache,
  requireDb,
  updatePlaybackProgressTelemetry,
  updateWatchSyncRetry,
  updateWatchTelemetry,
  upsertLiveTrackingCache,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
} from "./utils/dataRepo.js";
import { librarySeriesItemId, withSeriesIdentity } from "./utils/seriesIdentity.js";
import { enqueueManualWatchReview } from "./utils/manualWatchReview.js";

const SCHEDULED_RECENT_WATCH_LIMIT = 50;
// Provider feed snapshots are complete; only canonical resume propagation is
// bounded so a large Continue Watching list cannot create an outbound burst.
const SCHEDULED_RESUME_SYNC_LIMIT = 50;
const RECENT_UNWATCH_IMPORT_GUARD_MS = 5 * 60 * 1000;

export function recentUnwatchBlocksLibraryImport(playstate = null, now = Date.now()) {
  return playstate?.state === "unwatched"
    && Number(playstate.updated_at || 0) > 0
    && now - Number(playstate.updated_at) <= RECENT_UNWATCH_IMPORT_GUARD_MS;
}

function scheduledMediaInScope(config, media) {
  const scope = config?.syncScope || {};
  if (Array.isArray(scope.servers) && scope.servers.length && !scope.servers.includes(String(media.source || "").replace(/_initial_sync$/, ""))) return false;
  if (Array.isArray(scope.mediaTypes) && scope.mediaTypes.length && !scope.mediaTypes.includes(media.type)) return false;
  const watchedAt = new Date(media.watched_at || media.timestamp || 0).getTime();
  if (scope.watchedAfter && (!watchedAt || watchedAt < new Date(scope.watchedAfter).getTime())) return false;
  if (scope.watchedBefore && (!watchedAt || watchedAt > new Date(scope.watchedBefore).getTime())) return false;
  return true;
}

function currentWatchImportMode() {
  return watchImportMode();
}

export function providerWatchFingerprint(item = {}, source = "", kind = "") {
  const userData = item.UserData || {};
  return [
    String(source || "").toLowerCase(),
    kind,
    item.ratingKey || item.key || item.Id || "",
    item.lastViewedAt ?? item.viewedAt ?? "",
    userData.LastPlayedDate ?? userData.PlayedDate ?? item.LastPlayedDate ?? item.PlayedDate ?? "",
    userData.PlayCount ?? item.PlayCount ?? "",
    userData.Played ?? userData.IsPlayed ?? item.Played ?? item.IsPlayed ?? "",
    item.viewCount ?? "",
  ].join("|");
}

function addTimingHistoryRow(historyRows, media, watchedAt) {
  if (!Array.isArray(historyRows) || !media || !watchedAt) return;
  historyRows.push({
    ...media,
    media_type: media.type,
    sync_action: "watched",
    watched_at: watchedAt,
    show_title: media.showTitle,
    runtime_minutes: media.runtimeMinutes,
  });
}

// Fallback cadence for the legacy Plex unwatch poll. Primary detection is the realtime
// notification listener; this poll only backstops events missed while the socket was down.
// Seeded to "now" rather than 0 so a process restart doesn't make the very next tick
// treat the interval as already elapsed and fire immediately.
const PLEX_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.PLEX_UNWATCHED_POLL_INTERVAL_MS || 60 * 1000);
let lastPlexUnwatchedPollAt = Date.now();

// Emby/Jellyfin webhooks natively report unwatch (unlike Plex), so this is a
// backstop for a missed/misconfigured webhook or a server that was offline
// when the change happened, not the primary detection path. Unlike Plex's
// single-lookup findPlexItem, Emby/Jellyfin's per-episode lookup (findEpisode:
// up to 3 provider-ID searches, a title-fallback search, and a full
// series-episode fetch) is expensive enough that an earlier, larger batch size
// (30 records, both platforms) piled up 100+ outbound requests in one tick.
// The batch is now capped at EMBY_LIKE_UNWATCHED_BATCH_SIZE and records are
// processed sequentially (not concurrently), and the "last checked" timestamp
// now seeds to Date.now() instead of 0 so a restart can't make the next tick
// fire immediately. Emby's fallback is controlled by EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED;
// Jellyfin's fallback is separately opt-in via JELLYFIN_UNWATCHED_POLL_ENABLED.
// Jellyfin's native webhook is the authoritative unwatch signal. Its generic
// Played=false library snapshot is ambiguous after outbound marks and library
// rescans, so the Jellyfin fallback stays opt-in until explicitly enabled.
const EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED = String(process.env.EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED ?? "true").toLowerCase() !== "false";
const EMBY_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.EMBY_UNWATCHED_POLL_INTERVAL_MS || 5 * 60 * 1000);
let lastEmbyUnwatchedPollAt = Date.now();
const JELLYFIN_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.JELLYFIN_UNWATCHED_POLL_INTERVAL_MS || 5 * 60 * 1000);
const JELLYFIN_UNWATCHED_POLL_ENABLED = String(process.env.JELLYFIN_UNWATCHED_POLL_ENABLED ?? "false").toLowerCase() !== "false";
const JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS = Number(process.env.JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS || 20 * 60 * 1000);
let lastJellyfinUnwatchedPollAt = Date.now();
const EMBY_LIKE_UNWATCHED_BATCH_SIZE = 5;

export function jellyfinUnwatchedConfirmationKey(media = {}) {
  return `jellyfin-unwatched-candidate:${mediaKeyFor(media)}`;
}

export function jellyfinMatchesContainWatched(items = []) {
  return (Array.isArray(items) ? items : []).some((item) => isEmbyLikePlayed(item));
}

// A single false Played flag is not enough to infer that a user deliberately
// marked an item unwatched. Require the same false observation again within a
// bounded window. Webhook-based unwatches do not use this helper and remain
// immediate.
export async function confirmJellyfinUnwatchedObservation(media, loopStore, { now = Date.now(), windowMs = JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS } = {}) {
  if (!loopStore?.get || !loopStore?.put) return false;
  const key = jellyfinUnwatchedConfirmationKey(media);
  const previous = Number(await Promise.resolve(loopStore.get(key)).catch(() => 0));
  if (previous > 0 && now >= previous && now - previous <= windowMs) return true;
  await Promise.resolve(loopStore.put(key, now, { expirationTtl: Math.max(1, Math.ceil(windowMs / 1000)) })).catch(() => null);
  return false;
}

async function clearJellyfinUnwatchedObservation(media, loopStore) {
  if (!loopStore?.put) return;
  await Promise.resolve(loopStore.put(jellyfinUnwatchedConfirmationKey(media), 0, { expirationTtl: 1 })).catch(() => null);
}

// Cadence for background catch-up library syncs (recently watched & continue watching lists).
// These serve as backstops for events missed by webhooks/live session tracking, so they
// do not need to run on every 1-minute tick.
const CATCHUP_SYNC_INTERVAL_MS = Number(process.env.CATCHUP_SYNC_INTERVAL_MS || process.env.CATCHUP_SYNC_INTERVAL || 15 * 60 * 1000);
// A failed provider feed is a connection-health signal. Retry only that
// provider on a short cadence instead of waiting for the full catch-up window
// or polling healthy media servers more often than necessary.
const UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.UP_NEXT_FAILED_FEED_RETRY_INTERVAL_MS || 2 * 60 * 1000),
);
let lastCatchupSyncAt = 0;

// Automatic re-dispatch backoff for records whose sync targets keep failing.
// Attempt N waits SYNC_RETRY_BACKOFF_MS[N-1] (last entry repeats) before the
// next try; after SYNC_RETRY_MAX_ATTEMPTS the record is left alone until the
// user triggers Retry Sync, which resets the counters. Without this, a single
// offline target would be re-dispatched every minute forever.
const SYNC_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const SYNC_RETRY_MAX_ATTEMPTS = 10;

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

export function syncRetryDelayMs(retryCount) {
  const index = Math.min(Math.max(Number(retryCount) || 1, 1), SYNC_RETRY_BACKOFF_MS.length) - 1;
  return SYNC_RETRY_BACKOFF_MS[index];
}

export function syncRetryEligible(row = {}, now = Date.now()) {
  if (Number(row.sync_retry_count || 0) >= SYNC_RETRY_MAX_ATTEMPTS) return false;
  return Number(row.sync_next_retry_at || 0) <= now;
}

function buildTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  return [
    `Origin: ${media.source}`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...targetStates.map((targetState) => `Target ${targetState.target} status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

function buildProgressTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  return [
    `Origin: ${media.source}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
    ...targetStates.map((targetState) => `Target ${targetState.target} progress status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
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

function normalizePlexIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function configuredPlexUsername(config = {}) {
  return normalizePlexIdentity(config.plex?.username);
}

function plexAccountIdFromItem(item = {}) {
  const value = item.accountID ?? item.accountId ?? item.account_id ?? item.userID ?? item.userId;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function plexUsernamesFromItem(item = {}) {
  const user = item.User || item.user || {};
  const account = item.Account || item.account || {};
  return [
    item.username,
    item.user,
    item.userName,
    item.account,
    item.accountName,
    item.accountTitle,
    user.title,
    user.name,
    account.title,
    account.name,
  ]
    .map(normalizePlexIdentity)
    .filter(Boolean);
}

// Condenses a repeated-skip list into one readable clause, so a run reports
// "skipped 14 item(s) (A, B, C and 11 more)" instead of 14 separate lines.
function summariseTitles(titles, max = 3) {
  const unique = [...new Set(titles.filter(Boolean))];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

function skipMalformedLibraryHistoryItem(media, source, logger, skipped = []) {
  const rejection = remoteEpisodeImportError(media, { context: "library_history" });
  if (!rejection) return false;
  const label = `${media.title || "unknown"} (${rejection.code})`;
  skipped.push(label);
  logger(`${source}: skipped malformed watched item ${media.title || "unknown"}: ${rejection.message}.`);
  return true;
}

// Delegates to the memoized resolver in plexClient.js so the per-minute
// scheduled sync and playstate operations share one cached /accounts lookup.
async function resolvePlexTargetAccountId(plexConfig, username, logger = console.log) {
  try {
    return await resolvePlexAccountId({ ...plexConfig, username });
  } catch (error) {
    logger(`Plex account mapping failed: ${error.message}`);
    return null;
  }
}

export function plexHistoryItemMatchesConfiguredUser(item = {}, { username = "", accountId = null, accountScoped = false } = {}) {
  if (!username) return true;

  const itemAccountId = plexAccountIdFromItem(item);
  if (itemAccountId != null && accountId != null) {
    return itemAccountId === accountId;
  }

  const itemUsernames = plexUsernamesFromItem(item);
  if (itemUsernames.length) {
    return itemUsernames.includes(username);
  }

  // Plex omits User/Account from library-section results, even when the
  // request is explicitly scoped with accountID. Preserve that request
  // provenance so a valid, server-filtered result is not discarded.
  return accountScoped && accountId != null;
}

async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  const timestamp = Date.now();
  const targetStates = Array.isArray(summary.targetStates) ? summary.targetStates : [];
  const auditBase = {
    timestamp,
    eventType: "sync_dispatch",
    action,
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    showTitle: media.showTitle || media.show_title,
    source: media.source || "unknown",
    sourceEvent: media.event,
    phase: media.phase,
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId || media.session_id,
    user: media.user,
    device: media.device || media.deviceName || media.client?.deviceName,
    deviceId: media.deviceId || media.device_id || media.client?.deviceId,
    client: media.clientName || media.client?.client || media.client?.product || media.client?.platform,
    clientVersion: media.clientVersion || media.client?.version,
    status: summary.status || "unknown",
    details: summary.details || "",
  };
  recordWatchAuditEvents([
    {
      ...auditBase,
      details: `Outbound ${action} dispatch ${summary.status || "unknown"}: ${summary.details || "No details"}`,
      payload: { targetStates, scheduled: true },
    },
    ...targetStates.map((targetState) => ({
      ...auditBase,
      eventType: "sync_target",
      target: targetState.target,
      status: targetState.status,
      details: targetState.detail || `Target ${targetState.target || "unknown"} reported ${targetState.status}.`,
      itemId: targetState.itemId || targetState.item_id || auditBase.itemId,
      payload: targetState,
    })),
  ]);
  await appendSyncHistory({
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action,
    targetStates,
    rawPayloadDebug: {
      sessionId: media.sessionId || media.id || "",
      ids: media.ids || {},
      mediaKey: mediaKeyFor(media),
      showTitle: media.showTitle || media.show_title || "",
      itemId: media.itemId || "",
      watchRecordId: media.watchRecordId || media.watch_record_id || media.recordId || media.record_id || "",
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
      provenance: media.watchProvenance || media.watch_provenance || null,
    },
  }).catch((error) => console.error("Failed to append scheduled sync history", error));
}

async function checkPlexUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.plex?.baseUrl || !config.plex?.token) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const plexWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("plex")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target plex status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentlyUpdatedTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && plexWasConfirmedWatched(record),
  ).slice(0, 30);

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "plex",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const plexItem = await findPlexItem(config.plex, media);
      if (plexItem) {
        const isWatched = Boolean(plexItem.viewCount && Number(plexItem.viewCount) > 0);
        if (!isWatched) {
          const plexMedia = { ...media, itemId: plexItem.ratingKey || plexItem.key || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(plexMedia, "plex", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Plex unplayed state after Plekt's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Plex item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(plexMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(plexMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches("checkPlexUnwatchedStatus").catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Plex unwatched status for '${record.title}':`, error);
    }
  }
}

// Emby/Jellyfin equivalent of checkPlexUnwatchedStatus above. Their webhooks
// natively report unwatch (Plex's cannot), so this only backstops a missed or
// misconfigured webhook, or a change made while the server was unreachable -
// not the primary detection path.
async function checkEmbyUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const embyWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("emby")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target emby status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && embyWasConfirmedWatched(record),
  ).slice(0, EMBY_LIKE_UNWATCHED_BATCH_SIZE);
  if (!records.length) return;

  const { findEmbyItems } = await import("./utils/embyClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "emby",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findEmbyItems(config.emby, media);
      const item = items?.[0];
      if (item) {
        const isWatched = isEmbyLikePlayed(item);
        if (!isWatched) {
          const embyMedia = { ...media, itemId: item.Id || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(embyMedia, "emby", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Emby unplayed state after Plekt's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Emby item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(embyMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(embyMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches("checkEmbyUnwatchedStatus").catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Emby unwatched status for '${record.title}':`, error);
    }
  }
}

async function checkJellyfinUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const jellyfinWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("jellyfin")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target jellyfin status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && jellyfinWasConfirmedWatched(record),
  ).slice(0, EMBY_LIKE_UNWATCHED_BATCH_SIZE);
  if (!records.length) return;

  const { findJellyfinItems } = await import("./utils/jellyfinClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "jellyfin",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findJellyfinItems(config.jellyfin, media);
      if (!items?.length) continue;

      // Provider/title matching can return duplicate library items. One
      // watched match is positive evidence; looking only at items[0] made a
      // stale duplicate capable of turning a real watched item unwatched.
      const watchedItems = items.filter((item) => isEmbyLikePlayed(item));
      if (jellyfinMatchesContainWatched(items)) {
        if (watchedItems.length !== items.length) {
          console.warn("Cron ignored mixed Jellyfin match state; at least one matching item is watched", {
            title: record.title,
            itemIds: items.map((item) => item.Id),
            watchedItemIds: watchedItems.map((item) => item.Id),
          });
        }
        await clearJellyfinUnwatchedObservation(media, loopStore);
        continue;
      }

      const ownPlayedMarkAt = Math.max(0, ...(await Promise.all(items.map((item) => (
        lastOutboundPlayedMarkAt({ ...media, itemId: item.Id || undefined }, "jellyfin", loopStore).catch(() => 0)
      )))));
      if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
        await clearJellyfinUnwatchedObservation(media, loopStore);
        console.log("Cron ignored Jellyfin unplayed state after Plekt's own played mark", { title: record.title });
        continue;
      }

      const confirmed = await confirmJellyfinUnwatchedObservation(media, loopStore);
      if (!confirmed) {
        console.log("Cron held Jellyfin unplayed state for a second confirmation", { title: record.title });
        continue;
      }

      const jellyfinMedia = { ...media, itemId: items[0].Id || undefined };
      console.log("Cron detected Jellyfin item marked unwatched after repeated confirmation; storing and propagating", { title: record.title });
      const result = await applyUnwatchedTransition(jellyfinMedia, config, loopStore, { recordId: record.id });
      if (!result.alreadyUnwatched) await recordSyncHistory(jellyfinMedia, result.summary, "unwatched");
      await clearJellyfinUnwatchedObservation(media, loopStore);
      await invalidateHistoryDerivedCaches("checkJellyfinUnwatchedStatus").catch(() => null);
    } catch (error) {
      console.error(`Error checking Jellyfin unwatched status for '${record.title}':`, error);
    }
  }
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
  media.watchProvenance = buildWatchProvenance(
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
  const watchRecord = mediaToWatchRecord(media, media.source);

  if (isAuthoritativeRestoreActive()) return null;
  // An unwatch can land during the awaits above; re-read it right before the write.
  const latestPlaystate = await getPlaystateForMedia(media).catch(() => null);
  if (resumeProgressBlockedByPlaystate(latestPlaystate, row.updated_at) === "item is unwatched") return null;
  const inserted = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
  if (isAuthoritativeRestoreActive()) return null;
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
  let syncSummary;
  try {
    syncSummary = await syncMediaPlaystate(media, config, loopStore);
  } catch (error) {
    console.error("Live tracking sync dispatch failed", { sessionId: row.session_id, error });
    syncSummary = {
      status: "error",
      details: String(error?.message || error || "Outbound sync failed"),
      skipped: false,
      targetStates: [],
    };
  }
  const telemetry = buildTelemetry(media, syncSummary);
  await updateWatchTelemetry(inserted.id, telemetry, { skipInvalidate: true });
  await recordSyncHistory(media, syncSummary, "watched");
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

async function syncRecentlyWatchedFromPlex(config, loopStore, logger = console.log, traktWatchedDateIndex = null) {
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Plex watched library sync is disabled.");
    return 0;
  }
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  const baseUrl = config.plex.baseUrl.replace(/\/+$/, "");
  const username = configuredPlexUsername(config);
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  let syncedCount = 0;
  const skippedMalformed = [];

  const targetAccountId = await resolvePlexTargetAccountId(config.plex, username, logger);
  if (username && targetAccountId == null) {
    logger(`Plex: configured user "${config.plex.username}" was not resolved to an account id; rows without a matching username will be skipped.`);
  }

  try {
    const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
    historyUrl.searchParams.set("X-Plex-Container-Start", "0");
    historyUrl.searchParams.set("X-Plex-Container-Size", "20");
    if (targetAccountId != null) {
      historyUrl.searchParams.set("accountID", String(targetAccountId));
    }

    const historyRes = await fetchPlexWithRefresh(config.plex, historyUrl);
    let items = [];
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      items = historyData?.MediaContainer?.Metadata || [];
    } else {
      logger(`Plex history fetch failed: HTTP ${historyRes.status}`);
    }

    let recentlyViewedItems = [];
    try {
      const sectionsUrl = new URL(`${baseUrl}/library/sections`);
      const sectionsRes = await fetchPlexWithRefresh(config.plex, sectionsUrl);
      if (sectionsRes.ok) {
        const sectionsData = await sectionsRes.json();
        const directories = sectionsData?.MediaContainer?.Directory || [];
        // Bound the per-tick sweep: this runs every minute inside a 50s budget,
        // and each section costs a serial round trip to Plex. Very large installs
        // still converge â€” the history endpoint above covers recent activity.
        const MAX_SECTIONS_PER_TICK = 6;
        let sectionsChecked = 0;
        for (const dir of directories) {
          const sectionId = dir.key;
          const type = dir.type;
          if (type !== "movie" && type !== "show") continue;
          if (sectionsChecked >= MAX_SECTIONS_PER_TICK) {
            logger(`Plex sections check capped at ${MAX_SECTIONS_PER_TICK} sections this tick.`);
            break;
          }
          sectionsChecked += 1;

          const sectionAllUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
          sectionAllUrl.searchParams.set("unwatched", "0");
          sectionAllUrl.searchParams.set("sort", "lastViewedAt:desc");
          sectionAllUrl.searchParams.set("X-Plex-Container-Start", "0");
          sectionAllUrl.searchParams.set("X-Plex-Container-Size", "50");
          // Without it Plex lists no <Guid> children, and the import (or a
          // manual watch review it queues) carries no ids at all.
          sectionAllUrl.searchParams.set("includeGuids", "1");
          if (targetAccountId != null) {
            sectionAllUrl.searchParams.set("accountID", String(targetAccountId));
          }
          if (type === "movie") {
            sectionAllUrl.searchParams.set("type", "1");
          } else {
            sectionAllUrl.searchParams.set("type", "4"); // Episode
          }

          const sectionRes = await fetchPlexWithRefresh(config.plex, sectionAllUrl);
          if (sectionRes.ok) {
            const sectionData = await sectionRes.json();
            const metadata = sectionData?.MediaContainer?.Metadata || [];
            recentlyViewedItems.push(...metadata.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "section" })));
          }
        }
      } else {
        logger(`Plex sections fetch failed: HTTP ${sectionsRes.status}`);
      }
    } catch (err) {
      logger(`Plex sections check failed: ${err.message}`);
    }

    // Combine and deduplicate
    const allItems = [
      ...items.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "history" })),
      ...recentlyViewedItems,
    ];
    const seenKeys = new Set();
    const uniqueItems = [];

    for (const candidate of allItems) {
      const { item, accountScoped, kind } = candidate;
      if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId, accountScoped })) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;
      if (kind === "section" && Number(item.viewCount || 0) <= 0) continue;

      // The history endpoint represents an actual Plex viewing-history entry.
      // Section listings only expose the watched flag/lastViewedAt, which can
      // also be produced by a manual "Mark watched" click. Treat the latter
      // as a manual flag unless the realtime notification path has already
      // established playback evidence.
      const watchDate = resolvePlexWatchDate(item, { hasPlaybackEvidence: kind === "history" });
      const watchedAt = watchDate.watchedAt;

      const dedupeKey = `${item.ratingKey || item.key}-${watchedAt}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      uniqueItems.push({ item, watchedAt, watchDate });
    }

    const orderedItems = importMode === "episode_timing"
      ? uniqueItems.slice().sort((left, right) => {
        const leftIsEpisode = left.item.type === "episode";
        const rightIsEpisode = right.item.type === "episode";
        if (leftIsEpisode !== rightIsEpisode) return leftIsEpisode ? -1 : 1;
        if (!leftIsEpisode) return 0;
        const leftShow = String(left.item.grandparentTitle || left.item.parentTitle || "").toLowerCase();
        const rightShow = String(right.item.grandparentTitle || right.item.parentTitle || "").toLowerCase();
        return leftShow.localeCompare(rightShow)
          || Number(left.item.parentIndex || 0) - Number(right.item.parentIndex || 0)
          || Number(left.item.index || 0) - Number(right.item.index || 0);
      })
      : uniqueItems;

    for (const { item, watchedAt, watchDate } of orderedItems) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      let media = {
        title: item.title,
        type: item.type,
        source: "plex",
        isValid: true,
        // Episodes carry their own tmdb/tvdb guid, distinct from the show's -
        // prefer the grandparent (series) guid so a library-history import
        // keys on the same show identity every other ingestion path resolves.
        ids: parsePlexMediaIds(item, item.type),
      };

      if (item.type === "episode") {
        media.showTitle = item.grandparentTitle || item.parentTitle || "";
        media.season = Number(item.parentIndex);
        media.episode = Number(item.index);
        media.title = `${media.showTitle || "Unknown Show"} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
        media.episodeTitle = item.title;
        // The modern Plex agent's grandparentGuid is plex://, so the parse
        // above can fall through to the episode's own ids.
        media.seriesItemId = librarySeriesItemId(item, "plex");
        media = await withSeriesIdentity(media, config);
      }

      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "plex");
      const releaseDate = releaseDateForSourceItem(item, "plex");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark: watchDate.manualMark,
        sourceTimestamp: watchDate.sourceTimestamp,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;
      media.watchProvenance = buildWatchProvenance(
        { source: "plex", event: "library_history", phase: "completed", itemId: item.ratingKey, user: username },
        { ingestPath: "plex_scheduled_library_history", sourceTimestamp: watchDate.sourceTimestamp, note: [watchDate.note, `Import policy: ${dateChoice.reason}.`].filter(Boolean).join(" ") },
      );
      if (skipMalformedLibraryHistoryItem(media, "Plex", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      // A library-history poll is a snapshot of the server's current played
      // flag, not evidence of another viewing. Plembfin may deliberately keep
      // an older local watch date after the user removes newer duplicates;
      // Plex cannot roll its lastViewedAt timestamp back when we reassert the
      // watched flag. In that case an identity-rematched Plex row can evade
      // the history lookup above, but the broader playstate lookup still says
      // the episode is canonically watched. Never let that stale snapshot
      // recreate the watch date the user just removed.
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Plex: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }
      if (libraryDecision === "skip_already_watched") {
        logger(`Plex: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchDate.sourceTimestamp,
          sourceFingerprint: providerWatchFingerprint(item, "plex", item.type === "episode" ? "section_or_history" : "item"),
          reason: watchDate.note || "Plex reported a watched library flag without playback evidence.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Plex: queued manual watch review: ${media.title}`);
        continue;
      }

      // Marking an item played on Plex bumps its lastViewedAt, so plembfin's own
      // outbound sync makes an already-recorded watch look freshly viewed on the
      // next poll. Only an item with no watch record at all counts as a new watch
      // here; when the record exists but the playstate has drifted, repair the
      // playstate rather than filing a second watch for the same play.
      if (existing && playstate?.state !== "watched") {
        logger(`Plex: repaired playstate for an already-recorded watch: ${media.title}`);
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", existing.watched_at, { skipInvalidate: true });
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Plex: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Plex: detected new watched item: ${media.title} (watched at ${media.watched_at}; ${dateChoice.reason})`);
        const traktWatchedAt = watchDate.manualMark ? null : earliestTraktWatchedAt(traktWatchedDateIndex, media);
        const effectiveWatchedAt = traktWatchedAt != null && traktWatchedAt < Date.parse(media.watched_at)
          ? new Date(traktWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Plex: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "plex");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Plex library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Plex library history; sync completed.`,
          ...summary.targetStates.map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Plex sync recently watched failed: ${error.message}`);
  }

  if (skippedMalformed.length) {
    logger(`Plex: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromPlex").catch(() => null);
  return syncedCount;
}

async function syncRecentlyWatchedFromEmby(config, loopStore, logger = console.log, traktWatchedDateIndex = null) {
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Emby watched library sync is disabled.");
    return 0;
  }
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;
  let syncedCount = 0;
  const skippedMalformed = [];
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  try {
    const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchEmbyWatchedItems(config.emby, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    for (const item of raw) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = await withSeriesIdentity({
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        showTitle: item.Type === "Episode" ? (item.SeriesName || "") : null,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "emby",
        seriesItemId: librarySeriesItemId(item, "emby"),
        isValid: true,
      }, config);
      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);
      const manualMark = !watchedAt && watchedAtReason === "marked without playback";
      if (!watchedAt && !manualMark) {
        logger(`Emby: skipped watched item without a reliable played date: ${media.title}`);
        continue;
      }
      const releaseDate = releaseDateForSourceItem(item, "emby");
      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "emby");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark,
        sourceTimestamp: watchedAt,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;

      media.watchProvenance = buildWatchProvenance(
        { source: "emby", event: "library_history", phase: "completed", itemId: item.Id, user: config.emby.userId },
        { ingestPath: "emby_scheduled_library_history", sourceTimestamp: watchedAt, note: `Import policy: ${dateChoice.reason}.` },
      );
      if (skipMalformedLibraryHistoryItem(media, "Emby", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Emby: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }

      if (libraryDecision === "skip_already_watched") {
        logger(`Emby: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchedAt,
          sourceFingerprint: providerWatchFingerprint(item, "emby", "watched_library"),
          reason: watchedAtReason === "marked without playback"
            ? "Emby reported an API-marked watched flag without playback evidence."
            : "Emby reported a watched flag without a usable playback timestamp.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Emby: queued manual watch review: ${media.title}`);
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Emby: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Emby: detected new watched item: ${media.title} (${dateChoice.reason} ${media.watched_at})`);
        const traktWatchedAt = !watchedAt ? null : earliestTraktWatchedAt(traktWatchedDateIndex, media);
        const effectiveWatchedAt = traktWatchedAt != null && traktWatchedAt < Date.parse(media.watched_at)
          ? new Date(traktWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Emby: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "emby");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Emby library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Emby library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Emby sync recently watched failed: ${error.message}`);
  }
  if (skippedMalformed.length) {
    logger(`Emby: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromEmby").catch(() => null);
  return syncedCount;
}

async function syncRecentlyWatchedFromJellyfin(config, loopStore, logger = console.log, traktWatchedDateIndex = null) {
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Jellyfin watched library sync is disabled.");
    return 0;
  }
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;
  let syncedCount = 0;
  const skippedMalformed = [];
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  try {
    const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
    const { normalizeProviderIds } = await import("./utils/parsers.js");
    const raw = await fetchJellyfinWatchedItems(config.jellyfin, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    for (const item of raw) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = await withSeriesIdentity({
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        showTitle: item.Type === "Episode" ? (item.SeriesName || "") : null,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "jellyfin",
        seriesItemId: librarySeriesItemId(item, "jellyfin"),
        isValid: true,
      }, config);
      if (await isRecentOutboundJellyfinNextUpNudge({ ...media, itemId: item.Id }, loopStore).catch(() => false)) {
        logger(`Jellyfin: ignored watched-library echo from a Next Up ordering nudge: ${media.title}`);
        continue;
      }
      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);
      const manualMark = !watchedAt && watchedAtReason === "marked without playback";
      if (!watchedAt && !manualMark) {
        logger(`Jellyfin: skipped watched item without a reliable played date: ${media.title}`);
        continue;
      }
      const releaseDate = releaseDateForSourceItem(item, "jellyfin");
      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "jellyfin");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark,
        sourceTimestamp: watchedAt,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;

      media.watchProvenance = buildWatchProvenance(
        { source: "jellyfin", event: "library_history", phase: "completed", itemId: item.Id, user: config.jellyfin.userId },
        { ingestPath: "jellyfin_scheduled_library_history", sourceTimestamp: watchedAt, note: `Import policy: ${dateChoice.reason}.` },
      );
      if (skipMalformedLibraryHistoryItem(media, "Jellyfin", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Jellyfin: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }

      if (libraryDecision === "skip_already_watched") {
        logger(`Jellyfin: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchedAt,
          sourceFingerprint: providerWatchFingerprint(item, "jellyfin", "watched_library"),
          reason: watchedAtReason === "marked without playback"
            ? "Jellyfin reported an API-marked watched flag without playback evidence."
            : "Jellyfin reported a watched flag without a usable playback timestamp.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Jellyfin: queued manual watch review: ${media.title}`);
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Jellyfin: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Jellyfin: detected new watched item: ${media.title} (${dateChoice.reason} ${media.watched_at})`);
        const traktWatchedAt = !watchedAt ? null : earliestTraktWatchedAt(traktWatchedDateIndex, media);
        const effectiveWatchedAt = traktWatchedAt != null && traktWatchedAt < Date.parse(media.watched_at)
          ? new Date(traktWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Jellyfin: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "jellyfin");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Jellyfin library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Jellyfin library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Jellyfin sync recently watched failed: ${error.message}`);
  }
  if (skippedMalformed.length) {
    logger(`Jellyfin: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromJellyfin").catch(() => null);
  return syncedCount;
}

export function getActiveTargetsForConfig(config) {
  const targets = [];
  if (!config?.plex?.disabled && config?.plex?.baseUrl && config?.plex?.token) targets.push("plex");
  if (!config?.emby?.disabled && config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId) targets.push("emby");
  if (!config?.jellyfin?.disabled && config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

function isTargetSynced(telemetry = "", target = "", source = "") {
  const src = String(source || "").toLowerCase();
  const tgt = String(target || "").toLowerCase();
  if (src === tgt || src.startsWith(`${tgt}_`)) return true;

  const text = String(telemetry || "").toLowerCase();
  if (text.includes("force sync resolved status to success")) return true;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes(`${tgt} status:`) || line.includes(`${tgt} progress status:`)) {
      if (line.includes("success")) return true;
      if (line.includes("loop")) return true;
      // "not found" means the item simply isn't in this platform's library â€” treat as terminal
      // so it doesn't get re-queued every minute forever. Only "error" is retryable.
      if (line.includes("skipped")) return true;
      return false;
    }
  }
  return false;
}

// Trakt joins the automatic retry only for failures that prove nothing
// permanent is wrong: a rate limit, a Trakt server error, a timeout or a
// connection failure. "Could not match" and other errors stay terminal until
// the user presses Retry. The trakt line is absent when Trakt was skipped
// (not connected, echo suppressed), which never counts as needing a retry.
const TRAKT_TRANSIENT_FAILURE = /failed with (?:429|5\d\d)\b|\(HTTP (?:429|5\d\d)\)|upstream request timed out|upstream request failed/i;

export function traktRetryActive() {
  return getTrackerConnection("trakt")?.status === "connected";
}

// Manual watch rows write "Plex status:" / "Trakt status:" without the
// "Target " prefix, so both spellings name a target's line.
function targetTelemetryLine(telemetry = "", target = "") {
  const pattern = new RegExp(`^(?:target\\s+)?${target}(?: progress)? status:`, "i");
  return String(telemetry || "").split("\n").find((line) => pattern.test(line.trim())) || "";
}

function traktTelemetryLine(telemetry = "") {
  return targetTelemetryLine(telemetry, "trakt");
}

export function traktNeedsRetry(telemetry = "", source = "") {
  if (String(source || "").toLowerCase().includes("trakt")) return false;
  const line = traktTelemetryLine(telemetry).trim();
  return /^(?:target\s+)?trakt status:\s*error\b/i.test(line) && TRAKT_TRANSIENT_FAILURE.test(line);
}

function dispatchSourceForPendingRow(row = {}, action = row.sync_action) {
  const normalizedAction = String(action || "").toLowerCase();
  const telemetry = String(row.sync_dispatch_telemetry || "");
  // Manual unwatches are recorded with the original provider as their row
  // source so inbound history remains attributable, but their outbound replay
  // must fan out to every destination, including that original provider.
  if (["unwatched", "unplayed"].includes(normalizedAction) && /^Origin:\s*manual\s*$/im.test(telemetry)) {
    return "manual";
  }
  return row.source;
}

export async function syncPendingManualDispatches(config, loopStore, logger = console.log) {
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Pending watched dispatch sync is disabled.");
    return 0;
  }
  let syncedCount = 0;
  try {
    // History is already cached in memory. Inspect the complete canonical set
    // so older imports are repaired too; the outbound batch limit below still
    // keeps each scheduler tick bounded.
    const rows = await getCachedHistory();

    const activeTargets = getActiveTargetsForConfig(config);
    const includeTrakt = traktRetryActive();
    const toRetry = [];
    const now = Date.now();

    for (const row of rows) {
      const action = String(row.sync_action || "watched").toLowerCase();
      if (!["watched", "unwatched", "unplayed"].includes(action)) continue;
      const dispatchSource = dispatchSourceForPendingRow(row, action);

      const telemetry = row.sync_dispatch_telemetry || "";
      const isPending = telemetry.includes("Dispatch status: pending");

      let needsSync = isPending;
      if (!isPending && activeTargets.length > 0) {
        const allSynced = activeTargets.every((target) =>
          isTargetSynced(telemetry, target, dispatchSource)
        );
        if (!allSynced) {
          needsSync = true;
        }
      }
      if (!isPending && includeTrakt && traktNeedsRetry(telemetry, dispatchSource)) needsSync = true;

      if (needsSync && syncRetryEligible(row, now)) {
        toRetry.push(row);
      }
    }

    // A bulk historical import (e.g. the onboarding Trakt reconcile) can queue
    // thousands of rows needing outbound dispatch at once, and this batch is
    // capped at 15/tick - a fresh edit made directly on Trakt (or any other
    // non-bulk change) would otherwise land at the back of that queue and
    // wait behind the whole backlog before it ever reaches Plex/Emby/Jellyfin.
    // Bulk-imported rows are the only ones tagged "Ingest path:
    // historical_import" in their own telemetry, so sort them after
    // everything else while keeping each group's original order stable.
    const isBulkHistoricalImport = (row) => (row.sync_dispatch_telemetry || "").includes("Ingest path: historical_import");
    toRetry.sort((a, b) => Number(isBulkHistoricalImport(a)) - Number(isBulkHistoricalImport(b)));

    const maxRetries = 15;
    const batchToRetry = toRetry.slice(0, maxRetries);

    // Keep the historical row cap: grouping only controls concurrency, so a
    // tick that contains many aliases still processes the same 15 rows it did
    // before. Identity is derived from the complete history, ensuring bridge
    // rows outside this selected batch cannot split one real item.
    const dispatchGroups = dispatchGroupsForRows(batchToRetry, rows);
    await runWithConcurrency(dispatchGroups, 6, async (group) => {
      for (const row of group.rows) {
        if (isAuthoritativeRestoreActive()) return;
        try {
      const id = row.id;
      const action = String(row.sync_action || "watched").toLowerCase();
      const isUnwatched = action === "unwatched" || action === "unplayed";
      const dispatchSource = dispatchSourceForPendingRow(row, action);
      const media = {
        title: row.title,
        type: row.media_type,
        source: dispatchSource,
        // Without this, a retried dispatch falls back to Date.now() in
        // traktClient.js's syncPayload, so a row that genuinely happened at
        // some earlier date reaches Trakt stamped as watched right now
        // instead - the same class of bug already fixed for manualWatchMediaFromRecord.
        watched_at: row.watched_at || undefined,
        watchProvenance: row.watch_provenance || null,
        isValid: true,
        ids: {
          imdb: row.imdb_id || undefined,
          tmdb: row.tmdb_id || undefined,
          tvdb: row.tvdb_id || undefined,
        },
        season: row.season == null ? undefined : Number(row.season),
        episode: row.episode == null ? undefined : Number(row.episode),
      };

      // A row lands in this batch because at least one active target isn't
      // confirmed synced yet, but that doesn't mean none of them are. Only
      // dispatch to the targets still missing confirmation instead of
      // re-sending mark-played to ones the telemetry already shows as
      // successful - fewer redundant outbound calls, faster backlog drain.
      const targetsStillNeeded = activeTargets.filter(
        (target) => !isTargetSynced(row.sync_dispatch_telemetry || "", target, dispatchSource)
      );
      const retryTrakt = includeTrakt && traktNeedsRetry(row.sync_dispatch_telemetry || "", dispatchSource);
      if (retryTrakt) {
        targetsStillNeeded.push("trakt");
        // The failed write may have reached Trakt before its response was
        // lost, so the dispatcher checks Trakt history before adding again.
        if (!isUnwatched) media.traktRetryHistoryCheck = true;
      }
      if (targetsStillNeeded.length) media.syncTargets = targetsStillNeeded;

      logger(`Background Queue: retrying/dispatching sync for ${media.title} (${id})...`);
      if (isAuthoritativeRestoreActive()) return;
      const stateMedia = { ...media, source: row.source || media.source };
      if (isUnwatched) {
        await upsertPlaystateForMedia(stateMedia, "unwatched", row.watched_at, { skipInvalidate: true });
      } else {
        await upsertPlaystateForMedia(stateMedia, "watched", row.watched_at, { skipInvalidate: true });
      }
      const summary = await (isUnwatched
        ? syncMediaUnplayedPlaystate(media, config, loopStore)
        : syncMediaPlaystate(media, config, loopStore)).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Outbound sync failed: ${error.message || String(error)}`,
        targetStates: [],
      }));

      // Targets skipped this round (already confirmed synced) had no dispatch
      // this time, so summary.targetStates has no line for them - carry their
      // prior confirmed line forward instead of letting it drop out of the
      // telemetry, which would otherwise make allSyncedNow below regress to
      // false and re-queue an already-finished target forever.
      // Trakt is carried forward too whenever an explicit target list left it
      // out, so a confirmed or terminal Trakt result survives a local retry.
      const carriedTargets = activeTargets.filter((target) => !targetsStillNeeded.includes(target));
      if (media.syncTargets && !targetsStillNeeded.includes("trakt")) carriedTargets.push("trakt");
      const carriedForwardLines = carriedTargets
        .map((target) => targetTelemetryLine(row.sync_dispatch_telemetry, target))
        .filter(Boolean);

      const telemetryLines = [
        `Origin: ${media.source}`,
        `Loop-check: Passed`,
        `Dispatch status: ${summary.status}`,
        `Details: ${summary.details || (isUnwatched ? "Manual unwatch state propagated; sync completed." : "Manual watch state propagated; sync completed.")}`,
        ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
        ...carriedForwardLines,
        ...(summary.targetStates || []).map(
          (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
        ),
      ];

      const previousRetryCount = Number(row.sync_retry_count || 0);
      const telemetryNow = telemetryLines.join("\n");
      const allSyncedNow = (activeTargets.length > 0 || includeTrakt)
        && activeTargets.every((target) => isTargetSynced(telemetryNow, target, dispatchSource))
        && !(includeTrakt && traktNeedsRetry(telemetryNow, dispatchSource));
      let terminal = false;
      if (allSyncedNow) {
        await updateWatchSyncRetry(id, 0, 0, { skipInvalidate: true });
      } else {
        const nextCount = previousRetryCount + 1;
        terminal = nextCount >= SYNC_RETRY_MAX_ATTEMPTS;
        await updateWatchSyncRetry(id, nextCount, Date.now() + syncRetryDelayMs(nextCount), { skipInvalidate: true });
        if (terminal) {
          telemetryLines.push(`Retry: automatic retries exhausted after ${SYNC_RETRY_MAX_ATTEMPTS} attempts; use Retry Sync to try again.`);
          logger(`Background Queue: giving up on ${media.title} (${id}) after ${SYNC_RETRY_MAX_ATTEMPTS} attempts.`);
        } else {
          telemetryLines.push(`Retry: attempt ${nextCount} of ${SYNC_RETRY_MAX_ATTEMPTS}; next automatic retry in ${Math.round(syncRetryDelayMs(nextCount) / 60_000)}m.`);
        }
      }

      await updateWatchTelemetry(id, telemetryLines.join("\n"), { skipInvalidate: true });
      // Only log a sync_history row when the outcome is new information: the
      // first failed attempt, a success, or giving up. Identical failures on
      // every backoff step would otherwise flood the table.
      if (allSyncedNow || previousRetryCount === 0 || terminal) {
        await recordSyncHistory(media, summary, action);
      }
      syncedCount++;
        } catch (error) {
          logger(`Background Queue: failed to process ${row.title} (${row.id}): ${error.message || String(error)}`);
        }
      }
    });
  } catch (error) {
    logger(`Pending Queue dispatcher failed: ${error.message}`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncPendingManualDispatches").catch(() => null);
  return syncedCount;
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

  // Plex unwatch detection is now primarily event-driven via the notification WebSocket
  // (see startPlexNotificationListener in index.js). This poll is kept as a safety net for
  // events missed while the socket was disconnected (and manual changes for which Plex
  // emits no timeline event), checked once a minute with confirmed-watched gating
  // (PLEX_UNWATCHED_POLL_INTERVAL_MS) so it never drives detection or re-scans every tick.
  if (plexActive && Date.now() - lastPlexUnwatchedPollAt >= PLEX_UNWATCHED_POLL_INTERVAL_MS) {
    lastPlexUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Plex unwatched status (fallback poll)...");
    await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkPlexUnwatchedStatus failed: ${error.message}`);
    });
  }

  // Emby/Jellyfin webhooks report unwatch natively, so these are a backstop
  // for a missed webhook - same fallback-poll role as the Plex check above.
  // See EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED above.
  if (EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED && embyActive && Date.now() - lastEmbyUnwatchedPollAt >= EMBY_UNWATCHED_POLL_INTERVAL_MS) {
    lastEmbyUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Emby unwatched status (fallback poll)...");
    await checkEmbyUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkEmbyUnwatchedStatus failed: ${error.message}`);
    });
  }

  if (EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED && JELLYFIN_UNWATCHED_POLL_ENABLED && jellyfinActive && Date.now() - lastJellyfinUnwatchedPollAt >= JELLYFIN_UNWATCHED_POLL_INTERVAL_MS) {
    lastJellyfinUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Jellyfin unwatched status (fallback poll)...");
    await checkJellyfinUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkJellyfinUnwatchedStatus failed: ${error.message}`);
    });
  }

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
    const traktWatchedDateIndex = await loadTraktWatchedDateIndex(logger).catch(() => null);

    if (plexActive) {
      try {
        trace("Scheduled Sync: checking Plex recently watched...");
        plexSynced = await syncRecentlyWatchedFromPlex(config, loopStore, logger, traktWatchedDateIndex);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Plex sync failed: ${error.message}`);
      }
    }

    if (embyActive) {
      try {
        trace("Scheduled Sync: checking Emby recently watched...");
        embySynced = await syncRecentlyWatchedFromEmby(config, loopStore, logger, traktWatchedDateIndex);
      } catch (error) {
        logger(`Scheduled Sync ERROR: Emby sync failed: ${error.message}`);
      }
    }

    if (jellyfinActive) {
      try {
        trace("Scheduled Sync: checking Jellyfin recently watched...");
        jellyfinSynced = await syncRecentlyWatchedFromJellyfin(config, loopStore, logger, traktWatchedDateIndex);
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

// Scheduled polling also participates in the shared operation lock. Without
// this boundary a Force Sync could claim the lock while a scheduler tick that
// started a moment earlier was still dispatching a watchstate write.
export async function runScheduledSync(logger = console.log, options = {}) {
  const ownerId = `scheduled:${brandEnv("INSTANCE_ID") || process.pid}:${Date.now()}`;
  const staleBefore = Date.now() - 3 * 60 * 1000;
  let runtime = await loadRuntimeState().catch(() => ({}));
  let existing = activeSyncOperation(runtime);
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
    const cleared = await clearSyncOperation({ kind: existing.kind, values: staleValues }).catch(() => ({ ok: false }));
    if (cleared.ok) {
      runtime = await loadRuntimeState().catch(() => ({}));
      existing = activeSyncOperation(runtime);
    }
  }

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

async function runWithConcurrency(items, concurrency, handler) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

export async function runForceSync(logger = console.log, {
  concurrency = 1,
  planId = "",
  operationOwnerId = "",
  isCancelled = async () => false,
} = {}) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Force Sync skipped because watched/played syncing is disabled.");
    return {
      success: true,
      skipped: true,
      reason: "Watched/played syncing is disabled.",
      activeTargets: [],
      stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 },
    };
  }

  const ownerId = String(operationOwnerId || crypto.randomUUID());
  const startedAt = Date.now();
  logger("Force Sync: claiming the shared sync-operation lock...");
  const claim = await claimSyncOperation({
    kind: SYNC_OPERATION_FORCE,
    ownerId,
    activeField: "forceSyncActive",
    startedAt,
    values: {
      forceSyncRunId: ownerId,
      forceSyncStartedAt: startedAt,
      forceSyncHeartbeat: startedAt,
      forceSyncCancelRequested: false,
      forceSyncResult: null,
    },
  });
  if (!claim?.ok) {
    const active = claim?.active;
    const label = active?.kind === SYNC_OPERATION_FORCE ? "another Force Sync" : `another sync operation (${active?.kind || "unknown"})`;
    logger(`Force Sync ERROR: ${label} is already active.`);
    throw new Error(`${label.charAt(0).toUpperCase()}${label.slice(1)} is already active.`);
  }

  const heartbeatTimer = setInterval(() => {
    touchSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: { forceSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30_000);
  heartbeatTimer.unref?.();

  try {
    logger("Force Sync: loading media configuration...");
    const config = await loadMediaConfig();
    if (planId) {
      return await executeForceSyncPlan(planId, config, logger, { shouldCancel: isCancelled });
    }
    const loopStore = createLoopStore();

  const hasPlex = !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  const hasEmby = !config.emby?.disabled && Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId);
  const hasJellyfin = !config.jellyfin?.disabled && Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId);

  const configuredServers = [
    hasPlex ? "plex" : "",
    hasEmby ? "emby" : "",
    hasJellyfin ? "jellyfin" : "",
  ].filter(Boolean);
  const watchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "watched"));
  const unwatchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "unwatched"));
  const activeTargets = [...new Set([...watchedTargets, ...unwatchedTargets])];

  if (configuredServers.length === 0) {
    logger("Force Sync: no active media servers are configured or enabled. Aborting.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  if (activeTargets.length === 0) {
    logger("Force Sync: all configured servers are source-only or disabled for receiving state; no remote writes are permitted.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  logger(`Force Sync: receiving targets resolved: ${activeTargets.join(", ")}`);
  const scanFailures = new Map();

  // 1. Fetch watched items in parallel
  logger("Force Sync: querying watched libraries from servers...");
  const fetchPromises = [];
  if (hasPlex) {
    fetchPromises.push(
      (async () => {
        logger("Plex: scanning library sections...");
        const { fetchPlexWatchedItems } = await import("./utils/plexClient.js");
        const raw = await fetchPlexWatchedItems(config.plex);
        logger(`Plex: fetched ${raw.length} watched library items.`);
        return raw.map((item) => {
          const { watchedAt } = watchedAtForPlexItem(item);
          const media = {
            title: item.title,
            type: item.type,
            season: item.parentIndex != null ? Number(item.parentIndex) : null,
            episode: item.index != null ? Number(item.index) : null,
            imdb: null,
            tmdb: null,
            tvdb: null,
            source: "plex",
            timestamp: watchedAt
              ? new Date(watchedAt)
              : null,
          };
          const guids = [item.guid, ...(item.Guid || []).map((g) => g.id || g)].filter(Boolean);
          for (const guid of guids) {
            const guidStr = String(guid);
            const value = guidStr.split(/:\/\/|\//).pop();
            if (guidStr.includes("imdb")) media.imdb = value;
            if (guidStr.includes("tmdb") || guidStr.includes("themoviedb")) media.tmdb = value;
            if (guidStr.includes("tvdb") || guidStr.includes("thetvdb")) media.tvdb = value;
          }
          if (item.type === "episode") {
            media.title = `${item.grandparentTitle} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
            media.episodeTitle = item.title;
          }
          return media;
        });
      })().catch((err) => {
        logger(`Plex ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("plex", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasEmby) {
    fetchPromises.push(
      (async () => {
        logger("Emby: querying played items...");
        const { fetchEmbyWatchedItems } = await import("./utils/embyClient.js");
        const { normalizeProviderIds } = await import("./utils/parsers.js");
        const raw = await fetchEmbyWatchedItems(config.emby);
        logger(`Emby: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "emby",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Emby ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("emby", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasJellyfin) {
    fetchPromises.push(
      (async () => {
        logger("Jellyfin: querying played items...");
        const { fetchJellyfinWatchedItems } = await import("./utils/jellyfinClient.js");
        const { normalizeProviderIds } = await import("./utils/parsers.js");
        const raw = await fetchJellyfinWatchedItems(config.jellyfin);
        logger(`Jellyfin: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "jellyfin",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Jellyfin ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("jellyfin", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  const [plexResults, embyResults, jellyfinResults] = await Promise.all(fetchPromises);
  const allWatchedItems = [...plexResults, ...embyResults, ...jellyfinResults];
  logger(`Force Sync: collected ${allWatchedItems.length} total watched items across all platforms.`);
  const healthyWatchedTargets = watchedTargets.filter((target) => !scanFailures.has(target));
  const healthyUnwatchedTargets = unwatchedTargets.filter((target) => !scanFailures.has(target));
  if (scanFailures.size) {
    logger(`Force Sync: ${scanFailures.size} server scan${scanFailures.size === 1 ? "" : "s"} failed; those servers are excluded from all remote writes.`);
  }

  // 2. Fetch Plembfin watchHistory to resolve conflicts
  logger("Database: loading Plekt watchHistory records...");
  const allWatchRows = await getCachedHistory();
  const rowById = new Map();
  const historyMap = new Map();
  for (const row of allWatchRows) {
    rowById.set(row.id, row);
    const mKey = row.media_key;
    if (!historyMap.has(mKey)) historyMap.set(mKey, []);
    historyMap.get(mKey).push({
      id: row.id,
      syncAction: row.sync_action || "watched",
      watchedAt: row.watched_at || new Date().toISOString()
    });
  }
  for (const [mKey, records] of historyMap.entries()) {
    records.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  }
  logger(`Database: loaded ${allWatchRows.length} historical sync records.`);

  function findLooseMatch(media, groups) {
    for (const group of groups) {
      if (media.type !== group.type) continue;
      if (media.imdb && group.imdb && media.imdb === group.imdb) return group;
      if (media.tmdb && group.tmdb && media.tmdb === group.tmdb) return group;
      if (media.tvdb && group.tvdb && media.tvdb === group.tvdb) return group;
      
      const cleanTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (media.type === "episode") {
        const getShowName = (t) => t.split(" - ")[0].trim();
        const mediaShow = getShowName(media.title);
        const groupShow = getShowName(group.title);
        if (cleanTitle(mediaShow) === cleanTitle(groupShow) && 
            Number(media.season) === Number(group.season) && 
            Number(media.episode) === Number(group.episode)) {
          return group;
        }
      } else {
        if (cleanTitle(media.title) === cleanTitle(group.title)) {
          return group;
        }
      }
    }
    return null;
  }

  // 3. Group watched items loose-matched
  logger("Force Sync: grouping and matching items across servers...");
  const groups = [];
  for (const media of allWatchedItems) {
    const group = findLooseMatch(media, groups);
    if (group) {
      group.watchedOn.add(media.source);
      if (media.timestamp && (!group.timestamp || media.timestamp > group.timestamp)) {
        group.timestamp = media.timestamp;
      }
      if (!group.imdb && media.imdb) group.imdb = media.imdb;
      if (!group.tmdb && media.tmdb) group.tmdb = media.tmdb;
      if (!group.tvdb && media.tvdb) group.tvdb = media.tvdb;
      if (!group.episodeTitle && media.episodeTitle) group.episodeTitle = media.episodeTitle;
    } else {
      groups.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        imdb: media.imdb,
        tmdb: media.tmdb,
        tvdb: media.tvdb,
        timestamp: media.timestamp,
        episodeTitle: media.episodeTitle || null,
        watchedOn: new Set([media.source])
      });
    }
  }

  // 4. Compute canonical media keys and watched state entries
  const watchedMap = new Map();
  for (const group of groups) {
    const mediaObj = {
      title: group.title,
      type: group.type,
      season: group.season,
      episode: group.episode,
      ids: {
        imdb: group.imdb || undefined,
        tmdb: group.tmdb || undefined,
        tvdb: group.tvdb || undefined
      },
      episodeTitle: group.episodeTitle || undefined
    };
    const key = mediaKeyFor(mediaObj);
    watchedMap.set(key, { media: mediaObj, group });
  }

  // 5. Plembfin history is the canonical set of items to consider. Remote-only
  // watched items are deliberately ignored; a platform cannot manufacture a
  // new canonical watch during Force Sync.
  const allConsideredKeys = new Set(historyMap.keys());
  logger(`Force Sync: resolving Plekt-canonical watched state for ${allConsideredKeys.size} distinct items...`);

  let propagatedCount = 0;
  let addedToHistoryCount = 0;
  let deletedFromHistoryCount = 0;

  // Ceiling of 8: force sync fires mark-played/unplayed calls at the user's own
  // media servers, and a home NAS handles a burst of 64 concurrent writes badly
  // (cascading timeouts that then feed the retry queue).
  const reconciliationConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 8));
  if (reconciliationConcurrency > 1) {
    logger(`Force Sync: local concurrency enabled (${reconciliationConcurrency} workers).`);
  }

  let processedCount = 0;
  let abortResult = null;
  const consideredKeys = [...allConsideredKeys];

  const abortSummary = () => ({
    success: true,
    activeTargets,
    aborted: true,
    cancelled: true,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  });

  const checkEvery = reconciliationConcurrency > 1 ? 20 : 5;
  let cancellationChecks = 0;
  async function shouldAbort() {
    if (abortResult) return true;
    cancellationChecks += 1;
    if (cancellationChecks !== 1 && cancellationChecks % checkEvery !== 0) return false;
    const currentRuntime = await loadRuntimeState();
    const requested = await isCancelled().catch(() => false);
    const restoreActive = isAuthoritativeRestoreActive(currentRuntime);
    if (requested || currentRuntime.forceSyncCancelRequested === true || restoreActive) {
      logger(restoreActive
        ? "Force Sync: authoritative restore detected. Aborting sync..."
        : "Force Sync: stop request detected. Aborting sync...");
      abortResult = abortSummary();
      return true;
    }
    return false;
  }

  function reportProgress() {
    const reportEvery = Math.max(checkEvery, Math.ceil(consideredKeys.length / 100));
    if (processedCount === 1 || processedCount === consideredKeys.length || processedCount % reportEvery === 0) {
      logger(`Force Sync progress: ${processedCount}/${consideredKeys.length} items.`);
    }
  }

  async function markPlayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexPlayed } = await import("./utils/plexClient.js");
      return markPlexPlayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyPlayed } = await import("./utils/embyClient.js");
      return markEmbyPlayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinPlayed } = await import("./utils/jellyfinClient.js");
      return markJellyfinPlayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function markUnplayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexUnplayed } = await import("./utils/plexClient.js");
      return markPlexUnplayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyUnplayed } = await import("./utils/embyClient.js");
      return markEmbyUnplayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinUnplayed } = await import("./utils/jellyfinClient.js");
      return markJellyfinUnplayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function processConsideredKey(key) {
    if (await shouldAbort()) return false;

    const serverWatchedEntry = watchedMap.get(key);
    const historyRecords = historyMap.get(key) || [];
    const lastHistoryRecord = historyRecords[0];

    // No local history row at all means Plembfin never recorded a decision for
    // this item - not that it was explicitly marked unwatched. Treating an
    // absent row as canonical-unwatched would push a false "mark unplayed" to
    // any server that genuinely has it watched (e.g. after a history row is
    // deleted by the phantom-watch repair tool). Only an explicit unwatched
    // record is canonical.
    let newestState = null;
    let newestTime = 0;

    if (lastHistoryRecord) {
      newestState = lastHistoryRecord.syncAction === "unwatched" ? "unwatched" : "watched";
      newestTime = new Date(lastHistoryRecord.watchedAt).getTime();
    }

    let serverWatchedOn = new Set();
    let mediaObj = serverWatchedEntry ? serverWatchedEntry.media : null;

    if (serverWatchedEntry) {
      serverWatchedOn = serverWatchedEntry.group.watchedOn;
    }

    if (!mediaObj && lastHistoryRecord) {
      const docData = rowById.get(lastHistoryRecord.id) || {};
      mediaObj = {
        title: docData.title,
        type: docData.media_type,
        season: docData.season != null ? Number(docData.season) : null,
        episode: docData.episode != null ? Number(docData.episode) : null,
        ids: {
          imdb: docData.imdb_id || undefined,
          tmdb: docData.tmdb_id || undefined,
          tvdb: docData.tvdb_id || undefined
        }
      };
    }

    if (!mediaObj) return true;

    if (newestState === "watched") {
      const inHistory = historyRecords.some(r => r.syncAction === "watched");
      if (!inHistory) {
        logger(`Skipping server-only watched state for "${mediaObj.title}" because no Plekt history row exists.`);
      } else if (lastHistoryRecord && lastHistoryRecord.syncAction === "unwatched") {
        logger(`Deleting outdated unwatched record for "${mediaObj.title}"`);
        const unwatchedDocs = historyRecords.filter(r => r.syncAction === "unwatched");
        for (const docRec of unwatchedDocs) {
          if (await shouldAbort()) return false;
          await deleteWatchRecordById(docRec.id, { skipInvalidate: true });
        }
      }

      for (const target of healthyWatchedTargets) {
        if (await shouldAbort()) return false;
        if (!serverWatchedOn.has(target)) {
          logger(`Propagating: marking played "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markPlayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundPlayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark played for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else if (newestState === "unwatched") {
      // The unwatched marker is already the canonical Plembfin decision. Do
      // not delete or recreate local history based on a remote discrepancy.
      logger(`Plekt is canonical for "${mediaObj.title}"; only repairing remote played flags.`);

      for (const target of healthyUnwatchedTargets) {
        if (await shouldAbort()) return false;
        if (serverWatchedOn.has(target)) {
          logger(`Propagating: marking unplayed "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markUnplayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundUnplayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark unwatched for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else {
      logger(`Skipping "${mediaObj.title}": server shows it watched but Plekt has no history record for it, so its unwatched/watched state cannot be determined safely.`);
    }
    return true;
  }

  if (reconciliationConcurrency > 1) {
    await runWithConcurrency(consideredKeys, reconciliationConcurrency, async (key) => {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
    });
  } else {
    for (const key of consideredKeys) {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
      if (abortResult) break;
    }
  }

  if (abortResult) return abortResult;

  logger("Force Sync: process complete.");
  return {
    success: true,
    activeTargets,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  };
  } finally {
    clearInterval(heartbeatTimer);
    await invalidateHistoryDerivedCaches("runForceSync").catch(() => null);
    await releaseSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: {
        forceSyncActive: false,
        forceSyncCancelRequested: false,
        forceSyncHeartbeat: Date.now(),
      },
    }).catch(() => null);
  }
}
