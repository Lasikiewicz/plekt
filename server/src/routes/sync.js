import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson, readRawText } from "../utils/requestBody.js";
import { sendJson, sendApiError, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, isUpNextSeedSession, isTerminalLiveSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { activeSyncOperation, appendSyncHistory, clearSyncOperation, isAuthoritativeRestoreActive, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistoryById, getSyncHistoryPage, getSyncActivityGroupsPage, getSyncActivityGroupEvents, getLatestSyncActivityByItemKey, updateSyncHistoryStatus, loadRuntimeState, setRuntimeState, appendRuntimeLog, SYNC_OPERATION_FORCE, SYNC_OPERATION_SCHEDULED } from "../utils/configStore.js";
import { forceSyncStopAction } from "../utils/forceSyncControl.js";
import { getSyncPlanActionsPage, getSyncPlanSummary, confirmSyncPlan } from "../utils/syncPlans.js";
import {
  enqueueBackgroundJob,
  getBackgroundJob,
  getBackgroundJobLogs,
  getLatestBackgroundJob,
  requestBackgroundJobCancellation,
  workerAvailable,
  BACKGROUND_JOB_STALE_MS,
} from "../utils/backgroundJobs.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, hidePlexFromContinueWatching, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes, listPlexLibraries } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { pokeLiveSessionPoller } from "../scheduler.js";
import { withSeriesIdentity } from "../utils/seriesIdentity.js";
import { isUpNextSeedDeviceId, markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, hideEmbyFromResume, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes, listEmbyLibraries } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, fetchJellyfinSeriesEpisodes, listJellyfinLibraries, findJellyfinItems, hideJellyfinFromResume } from "../utils/jellyfinClient.js";
import { setJellyfinApiKey } from "../utils/jellyfinAuth.js";
import { buildPlexMediaFromMetadata, normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexMediaIds, parsePlexWebhook } from "../utils/parsers.js";
import { clearOutboundPlayedMarks, completeDispatchTracking, dispatchProgressKey, finishDispatchTracking, getTargetsForSource, isRecentOutboundJellyfinNextUpNudge, isRecentOutboundRailRefresh,isRecentOutboundPlayedEcho, isRecentOutboundPlayedFlagEcho, isRecentOutboundProgressEcho, isRecentOutboundUnplayedFlagEcho, markReservedDispatchStarted, recordOutboundPlayedMarks, reserveDispatchBatch, shouldSyncResumeProgress, syncCanonicalPlaystate, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { canReceiveState } from "../utils/syncRoles.js";
import {
  playstateBlocksStoredResumeProgress,
  resumePositionUnchanged,
  resumeProgressAuthorityTimestamp,
  resumeProgressBlockedByPlaystate,
  resumeProgressEventTimestamp,
  resumeWebhookPhaseForPlaystate,
} from "../utils/resumeAuthority.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { forceSyncMediaState, normalizeMediaForceSyncRequest } from "../utils/mediaForceSync.js";
import { forceSyncLibraryState, normalizeLibraryForceSyncRequest } from "../utils/libraryForceSync.js";
import { appendMediaForceSyncActivity, createMediaForceSyncActivity, finishMediaForceSyncActivity, getMediaForceSyncActivity, isMediaForceSyncCancellationRequested, requestMediaForceSyncCancellation } from "../utils/mediaForceSyncActivity.js";
import { dispatchTraktWatchStateBatch } from "../utils/trackerDispatcher.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "../utils/watchProvenance.js";
import { releaseDateForItem, resolveWatchImportDate, runtimeMinutesForSourceItem } from "../utils/watchDates.js";
import { watchImportMode } from "../utils/tuning.js";
import { formatProviderOutcomeSummary, normalizeWatchSyncIntent, summarizeProviderOutcomes } from "../utils/watchSyncPolicy.js";
import {
  dismissPendingManualWatchReviewsForMedia,
  enqueueManualWatchReview,
} from "../utils/manualWatchReview.js";
import { applyUnwatchedTransition } from "../utils/watchStateTransitions.js";
import { auditSourceEventPayload, recordWatchAuditEvent, recordWatchAuditEvents } from "../utils/watchAudit.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId, queueTmdbMetadataWarmup } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";
import { syncUpNextToProviders } from "../utils/upNextProviderSync.js";
import { mediaIsUpNextRailSeed } from "../utils/upNextSeedLedger.js";
import { DISMISSED_TRAKT_NOT_FOUND_DETAIL } from "../utils/traktDismissals.js";
import { traceLog } from "../utils/logVerbose.js";
import { buildSyncMatchReport, unresolvedSyncMatchReport } from "../utils/syncMatchReport.js";
import { inRowNumbering } from "../utils/showSeasonTranslation.js";
import {
  listUpNextDismissals,
  recordUpNextDismissal,
  restoreAllUpNextDismissals,
  restoreUpNextDismissalsForMedia,
  restoreUpNextDismissalsSupersededByUnwatch,
  restoreUpNextDismissal,
} from "../utils/upNextDismissals.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import {
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  deletePlaybackProgress,
  deleteWatchRecord,
  deleteWatchRecordById,
  dismissSyncMatchRecord,
  updateWatchRecord,
  mergeShows,
  getWatchRecordById,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listLibraryItemsForRefresh,
  relatedPosterRows,
  setWatchPosterUrls,
  setWatchBackdropUrl,
  listPlaybackProgressRowsForReplay,
  listWatchedPlaystateRowsForReplay,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  mediaKeyFor,
  progressRowToMedia,
  querySyncJobs,
  queryMovies,
  queryShowDetail,
  queryShows,
  queryWatchHistory,
  queryWatchHistoryPreview,
  showTitleFrom,
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchSyncRetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  setPlaystateForMediaIdentity,
  supersedeUnwatchedTransitionsForRecordSync,
  reassertWatchRecordAuthoritySync,
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  getCachedShows,
  getCachedMovies,
  getCachedHistory,
  getKnownShowIdentityForTitle,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  isDeletedWatchSuppressed,
  getCanonicalWatchState,
  getPlaybackProgressForMedia,
  getPlaystateForMedia,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deleteMovieByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearWatchArtworkUrls,
  countTraktImportPendingDispatch,
} from "../utils/dataRepo.js";

import { shouldSkipPostRestoreCompletedWebhook } from "./backups.js";
import { activityItemKeyFor } from "../utils/syncActivityIdentity.js";

const SYNC_ACTIVITY_MATCH_REPORT_TTL_MS = 3000;
let syncActivityMatchReportCache = { expiresAt: 0, value: null };
let syncActivityMatchReportPromise = null;

async function currentSyncActivityMatchReport() {
  const now = Date.now();
  if (syncActivityMatchReportCache.value && syncActivityMatchReportCache.expiresAt > now) {
    return syncActivityMatchReportCache.value;
  }
  if (syncActivityMatchReportPromise) return syncActivityMatchReportPromise;
  syncActivityMatchReportPromise = (async () => {
    const value = unresolvedSyncMatchReport(buildSyncMatchReport(await getCachedHistory().catch(() => [])));
    syncActivityMatchReportCache = { expiresAt: Date.now() + SYNC_ACTIVITY_MATCH_REPORT_TTL_MS, value };
    return value;
  })();
  try {
    return await syncActivityMatchReportPromise;
  } finally {
    syncActivityMatchReportPromise = null;
  }
}

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";
  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function posterPathFromMedia(media = {}) {
  if (media.posterUrl) return media.posterUrl;
  if (media.source === "plex" && media.poster?.path) return imagePath(media.poster.path);
  if ((media.source === "emby" || media.source === "jellyfin") && media.poster?.itemId) {
    return imagePath(`/Items/${encodeURIComponent(media.poster.itemId)}/Images/Primary`, { tag: media.poster.tag });
  }
  return "";
}

function configForPosterSource(config = {}, source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...config.plex, source: "plex" };
  if (key.includes("emby")) return { ...config.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...config.jellyfin, source: "jellyfin" };
  return {};
}

function configuredPosterUrl(path = "", source = "", config = {}) {
  const raw = String(path || "").trim();
  const server = configForPosterSource(config, source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    if (server.source === "plex" && (server.token || server.apiKey)) {
      url.searchParams.set("X-Plex-Token", server.token || server.apiKey);
    }
    if (server.source === "emby" && (server.apiKey || server.api_key)) {
      url.searchParams.set("api_key", server.apiKey || server.api_key);
    }
    if (server.source === "jellyfin") setJellyfinApiKey(url, server);
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isHttpsUrl(value = "") {
  return /^https:\/\//i.test(String(value || "").trim());
}

function isHttpUrl(value = "") {
  return /^http:\/\//i.test(String(value || "").trim());
}

function isCachedStorageUrl(value = "") {
  const raw = String(value || "").trim();
  // Locally cached artwork is served from /media/posters or /media/backdrops.
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
}

function parseJsonWebhookBody(json) {
  const customPayload = parseCustomWebhook(json);
  if (customPayload.isValid) return customPayload;
  const embyPayload = parseEmbyWebhook(json);
  if (embyPayload.isValid || json?.Event) return embyPayload;
  return parseJellyfinWebhook(json);
}

export async function normalizeWebhook(req) {
  const contentType = req.get("content-type") || "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    return parsePlexWebhook(await readFormData(req));
  }
  // A body that claims to be JSON and isn't is a real client error, so let
  // readJson's 400 through rather than quietly treating it as unrecognised.
  if (contentType.includes("application/json")) {
    return parseJsonWebhookBody(await readJson(req));
  }

  // Otherwise judge the body, not the header. Jellyfin's webhook plugin posts
  // valid JSON labelled `text/plain`, so trusting the declared content type
  // silently drops every event it sends - including the mark-played and
  // mark-unplayed events that unwatch propagation depends on.
  let sniffed = null;
  try {
    sniffed = await readJson(req);
  } catch {
    sniffed = null;
  }
  if (sniffed && typeof sniffed === "object" && Object.keys(sniffed).length) {
    return parseJsonWebhookBody(sniffed);
  }

  // The body is not JSON either, so capture enough to identify the sender. A
  // rejected webhook is otherwise anonymous, and "some server keeps posting
  // something" is not a diagnosable report.
  return {
    isValid: false,
    source: "unknown",
    ids: {},
    title: "Unsupported webhook content type",
    rawPayloadDebug: {
      contentType: contentType || "(none)",
      userAgent: req.get("user-agent") || "(none)",
      bodyPreview: readRawText(req),
    },
  };
}

function isSyntheticUpNextWebhook(media = {}) {
  if (!["emby", "jellyfin"].includes(String(media.source || "").trim().toLowerCase())) return false;
  const client = media.client && typeof media.client === "object" ? media.client : {};
  return [media.deviceId, media.device_id, client.deviceId, client.device_id, client.DeviceId]
    .some(isUpNextSeedDeviceId);
}

export function formatDispatchTelemetry(summary, media, action = "watched") {
  const actionLabel = action === "unwatched" || action === "unplayed" ? "Marked Unwatched" : "Marked Watched";
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Action: ${actionLabel}`,
    `Media: ${media.title || "unknown"}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.deferred && /authoritative watch-history restore/i.test(summary.details || "") ? "pending" : summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

function formatProgressTelemetry(summary, media) {
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  const lines = [
    `Origin: ${media.source || "unknown"}`,
    `Media: ${media.title || "unknown"}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${platformLabel(state.target)} progress status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

function recordPlaybackEndedAudit(media = {}, { status = "completed", details = "Playback ended." } = {}) {
  const playedAt = Date.parse(String(media.playedAt || media.watched_at || ""));
  recordWatchAuditEvent({
    eventType: "playback_ended",
    timestamp: Number.isFinite(playedAt) ? playedAt : Date.now(),
    action: "playback",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType,
    title: media.title,
    showTitle: media.showTitle || media.show_title,
    source: media.source,
    sourceEvent: media.event,
    phase: "ended",
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId || media.session_id,
    user: media.user,
    device: media.device || media.deviceName || media.client?.deviceName,
    deviceId: media.deviceId || media.device_id || media.client?.deviceId,
    client: media.clientName || media.client?.client || media.client?.product || media.client?.platform,
    clientVersion: media.clientVersion || media.client?.version,
    status,
    details,
    payload: {
      progress: media.progress,
      offsetMs: media.offsetMs ?? media.positionMs,
      durationMs: media.durationMs,
      playedAt: media.playedAt || media.watched_at || "",
    },
  });
}

export async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  const timestamp = Date.now();
  const targetStates = Array.isArray(summary.targetStates) ? summary.targetStates : [];
  const auditBase = {
    timestamp,
    eventType: action === "progress" ? "sync_dispatch" : "sync_dispatch",
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
      payload: {
        targetStates,
        loopSkipped: Boolean(summary.skipped),
        rawPayloadDebug: media.rawPayloadDebug || null,
      },
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
      event: media.event || "",
      phase: media.phase || "",
      ids: media.ids || {},
      showTitle: media.showTitle || media.show_title || "",
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
      provenance: media.watchProvenance || media.watch_provenance || null,
      watchRecordId: media.watchRecordId || media.watch_record_id || media.recordId || media.record_id || null,
      mediaKey: mediaKeyFor(media),
      // Keep whatever the parser worked out about an unrecognised request. For a
      // rejected webhook this is the only record of which server sent it and in
      // what format, and without it the entry is an unattributable dead end.
      ...(media.isValid ? {} : media.rawPayloadDebug || {}),
    },
  }).catch((error) => console.error("Failed to append sync history", error));
}

function platformLabel(value) {
  const text = String(value || "unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function webhookWatchFingerprint(media = {}, releaseDate = "") {
  return [
    media.source,
    media.event,
    media.itemId,
    media.type,
    media.season,
    media.episode,
    releaseDate,
  ].map((value) => String(value ?? "").trim()).join(":");
}

function isExplicitPlayedFlagEvent(media = {}) {
  const eventKey = String(media.event || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["itemmarkplayed", "itemmarkedplayed", "itemmarkedasplayed", "itemplayed"].includes(eventKey);
}

async function resolveWebhookFlagWatchDate(media = {}) {
  const mode = watchImportMode();
  const historyRows = mode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  const dateChoice = resolveWatchImportDate({
    mode,
    manualMark: true,
    releaseDate: media.releaseDate || "",
    fallbackDate: "",
    media: {
      ...media,
      runtimeMinutes: media.runtimeMinutes || runtimeMinutesForSourceItem(media, media.source),
    },
    historyRows,
  });
  return { mode, dateChoice };
}

function normalizedIdentity(value = "") {
  const text = String(value || "").trim().toLowerCase();
  // Jellyfin's webhook sends user GUIDs with dashes, but the stored id has none.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text.replace(/-/g, "") : text;
}

function looksLikeServerUserId(value = "") {
  const text = normalizedIdentity(value);
  return /^[0-9a-f-]{16,}$/i.test(text) || /^[a-z0-9_-]{20,}$/i.test(text);
}

function shouldIgnoreWebhookUser(mediaUser = "", configuredUser = "", { strictName = false } = {}) {
  const incoming = normalizedIdentity(mediaUser);
  const configured = normalizedIdentity(configuredUser);
  if (!configured || !incoming) return false;
  if (incoming === configured) return false;
  if (strictName) return true;
  return looksLikeServerUserId(incoming);
}

export function manualWatchMediaFromRecord(record = {}) {
  return {
    watchRecordId: record.id || record.watchRecordId || record.watch_record_id || undefined,
    title: record.title,
    type: record.media_type,
    source: "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    // Without this, outbound dispatch (traktClient.js syncPayload) falls
    // back to Date.now() for the watched_at it sends to Trakt, so a manual
    // watch with an explicit historical date (e.g. "watched on release day")
    // reached Trakt stamped as watched right now instead.
    watched_at: record.watched_at || undefined,
    // The client says whether this was "watched now" or a backdated mark. The
    // date alone cannot decide it - a user can pick today from the calendar -
    // so the intent travels with the record. Absent/unknown values fall back to
    // a current manual action, which no policy gates.
    syncIntent: normalizeWatchSyncIntent(record.sync_intent ?? record.syncIntent) || "manual",
    posterUrl: record.poster_url || undefined,
    traktOverride: record.provider_overrides?.trakt || undefined,
    watchProvenance: record.watch_provenance || null,
    providerItems: record.provider_items || record.providerItems || {},
    providerItemId: record.provider_item_id || record.providerItemId || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

function showTitleFromProgressTitle(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

async function enrichProgressWatchRecordWithTmdb(record = {}, body = {}) {
  const mediaType = record.media_type === "episode" ? "tv" : record.media_type;
  if (!["movie", "tv"].includes(mediaType)) return record;

  const ids = {
    imdbId: body.imdb_id || body.imdbId || body.imdb || record.imdb_id,
    tvdbId: body.tvdb_id || body.tvdbId || body.tvdb || record.tvdb_id,
  };
  const title = mediaType === "tv" ? showTitleFromProgressTitle(record.title) : record.title;
  const tmdbId = body.tmdb_id || body.tmdbId || body.tmdb || record.tmdb_id;

  if (tmdbId && record.tmdb_id) return record;

  try {
    const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
    if (details?.id && !record.tmdb_id) record.tmdb_id = String(details.id);
    const externalIds = details?.external_ids || {};
    if (!record.imdb_id && externalIds.imdb_id) record.imdb_id = externalIds.imdb_id;
    if (!record.tvdb_id && externalIds.tvdb_id) record.tvdb_id = String(externalIds.tvdb_id);
  } catch (error) {
    console.warn("Progress watch TMDB enrichment skipped", {
      title: record.title,
      mediaType: record.media_type,
      reason: error.message || String(error),
    });
  }

  return record;
}

function mediaFromWatchRecord(record) {
  return {
    watchRecordId: record.id || record.watchRecordId || record.watch_record_id || undefined,
    title: record.title,
    type: record.media_type,
    source: record.source || "manual",
    ids: {
      imdb: record.imdb_id || undefined,
      tmdb: record.tmdb_id || undefined,
      tvdb: record.tvdb_id || undefined,
    },
    season: record.season == null ? undefined : Number(record.season),
    episode: record.episode == null ? undefined : Number(record.episode),
    posterUrl: record.poster_url || undefined,
    watchProvenance: record.watch_provenance || null,
    providerItems: record.provider_items || record.providerItems || {},
    providerItemId: record.provider_item_id || record.providerItemId || undefined,
    isValid: Boolean(record.title && ["movie", "episode"].includes(record.media_type)),
  };
}

function syncActivityIdentityKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function syncActivityCoordinate(value, { minimum = 0 } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : null;
}

function syncActivityEpisodeCoordinates(entry = {}, debug = {}) {
  let season = syncActivityCoordinate(debug.season ?? debug.media?.season, { minimum: 0 });
  let episode = syncActivityCoordinate(debug.episode ?? debug.media?.episode, { minimum: 1 });
  const titleMatch = String(entry.title || "").match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  if (season == null && titleMatch) season = syncActivityCoordinate(titleMatch[1], { minimum: 0 });
  if (episode == null && titleMatch) episode = syncActivityCoordinate(titleMatch[2], { minimum: 1 });
  return { season, episode };
}

// Older sync-history rows may not retain watchRecordId, and their raw ids can
// be stale episode-level ids from the original webhook. Once the user fixes a
// show match, retry must read the current watch_history row for that show's
// coordinate so it sends the newly rematched series identity to Trakt.
function currentWatchRecordForSyncActivity(entry = {}, debug = {}, identity = {}) {
  const mediaType = String(entry.mediaType || "").trim().toLowerCase();
  if (!["episode", "movie"].includes(mediaType)) return null;

  const rows = requireDb().prepare("SELECT * FROM watch_history WHERE media_type = ?").all(mediaType);
  const title = mediaType === "episode"
    ? String(identity.showTitle || identity.show_title || "").trim() || showTitleFrom(entry.title || "")
    : String(entry.title || "").trim();
  const titleKey = syncActivityIdentityKey(title);
  if (!titleKey) return null;

  const coordinates = mediaType === "episode" ? syncActivityEpisodeCoordinates(entry, debug) : null;
  if (mediaType === "episode" && (coordinates.season == null || coordinates.episode == null)) return null;

  const candidates = rows.filter((row) => {
    const rowTitle = mediaType === "episode" ? showTitleFrom(row.show_title || row.title || "") : String(row.title || "").trim();
    if (syncActivityIdentityKey(rowTitle) !== titleKey) return false;
    if (mediaType !== "episode") return true;
    return Number(row.season) === coordinates.season && Number(row.episode) === coordinates.episode;
  });
  if (!candidates.length) return null;

  const selectedTvdbId = String(identity.tvdbId || identity.tvdb_id || "").trim();
  const identityCandidates = selectedTvdbId
    ? candidates.filter((row) => String(row.tvdb_id || "").trim() === selectedTvdbId)
    : candidates;
  const candidatePool = identityCandidates.length ? identityCandidates : candidates;

  const action = String(entry.action || "watched").trim().toLowerCase();
  const unwatch = ["unwatched", "unplayed"].includes(action);
  const preferred = candidatePool.filter((row) => {
    const rowAction = String(row.sync_action || "watched").trim().toLowerCase();
    return unwatch ? ["unwatched", "unplayed"].includes(rowAction) : !["unwatched", "unplayed"].includes(rowAction);
  });
  const pool = preferred.length ? preferred : candidatePool;
  const rowTimestamp = (row) => {
    const numeric = Number(row.updated_at);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(row.updated_at || row.watched_at || ""));
    return Number.isFinite(parsed) ? parsed : Number(row.id) || 0;
  };
  return [...pool].sort((left, right) => rowTimestamp(right) - rowTimestamp(left) || Number(right.id) - Number(left.id))[0] || null;
}

// Core of "mark unwatched": delete the watched record, write a superseding
// unwatched record, flip the playstate cache, and propagate unplayed to the other
// platforms. Shared by the webhook `unplayed` phase and the manual-unwatch handler.
export async function applyManualUnwatch(media, config, loopStore, recordId = "", { includeSourcePlatform = false, trackDispatch = true, force = false, lane = "sync" } = {}) {
  const manualActionStartedAt = includeSourcePlatform ? Date.now() : 0;
  const result = await applyUnwatchedTransition(media, config, loopStore, {
    recordId,
    includeSourcePlatform,
    trackDispatch,
    force,
    lane,
    allowLocalDuringRestore: includeSourcePlatform,
  });
  if (includeSourcePlatform) {
    dismissPendingManualWatchReviewsForMedia(media, { before: manualActionStartedAt });
    if (!result.deferred) {
      restoreUpNextDismissalsForMedia({
        ...media,
        media_type: media.media_type || media.type || "episode",
        show_title: media.show_title || media.showTitle || "",
        show_tmdb_id: media.show_tmdb_id || media.showTmdbId || media.ids?.tmdb || "",
        show_tvdb_id: media.show_tvdb_id || media.showTvdbId || media.ids?.tvdb || "",
        show_imdb_id: media.show_imdb_id || media.showImdbId || media.ids?.imdb || "",
      });
    }
  }
  // includeSourcePlatform means this is an explicit manual action, not an inbound
  // event from `media.source` - applyUnwatchedTransition dispatches under "manual"
  // for the same reason (see its includeSourcePlatform handling), so the recorded
  // history must say "manual" too rather than echoing the target's original watch
  // provenance (e.g. a record originally captured from Trakt) as if that platform
  // had requested this unwatch.
  const historyMedia = {
    ...media,
    ...(result.id ? { watchRecordId: result.id } : {}),
    ...(includeSourcePlatform ? { source: "manual" } : {}),
  };
  // The force path still dispatches (and returns alreadyUnwatched: true purely
  // to signal "no new watch_history row"), so it needs recording too.
  if (!result.alreadyUnwatched || force) await recordSyncHistory(historyMedia, result.summary, "unwatched");
  return result;
}

// Fans a newly added show or season out to its episodes on the server that
// announced it. Only episodes that server currently reports as unplayed are
// considered, so nothing is re-marked, and each one still has to have a watched
// record in Plembfin before anything is written.
async function applyWatchedStateToNewContainer(media, config, target) {
  let episodes = [];
  try {
    if (target === "jellyfin") {
      const { fetchJellyfinEpisodes, fetchJellyfinEpisodesForSeries } = await import("../utils/jellyfinClient.js");
      episodes = media.type === "series"
        ? await fetchJellyfinEpisodesForSeries(config.jellyfin, media.itemId)
        : await fetchJellyfinEpisodes(config.jellyfin, media.itemId);
    } else if (target === "emby") {
      const { fetchEmbyEpisodes } = await import("../utils/embyClient.js");
      episodes = await fetchEmbyEpisodes(config.emby, media.itemId);
    } else if (target === "plex") {
      episodes = await fetchPlexSeriesEpisodes(config.plex, media);
    }
  } catch (error) {
    return { applied: false, reason: `Could not read episodes of the new ${media.type}: ${error.message || String(error)}` };
  }

  const pending = episodes.filter((ep) => {
    if (target === "plex") {
      return Object.prototype.hasOwnProperty.call(ep || {}, "viewCount") && Number(ep.viewCount || 0) <= 0;
    }
    return Boolean(ep?.UserData && typeof ep.UserData === "object")
      && ep.UserData.Played !== true
      && Number(ep.UserData.PlayCount || 0) <= 0;
  });
  let applied = 0;
  for (const ep of pending) {
    const season = ep.ParentIndexNumber ?? ep.parentIndex;
    const episodeNumber = ep.IndexNumber ?? ep.index;
    const showTitle = ep.SeriesName || ep.grandparentTitle || media.title || "Unknown Show";
    const itemId = ep.Id || ep.ratingKey;
    const rawIds = target === "plex"
      ? parsePlexMediaIds(ep, "episode")
      : { ...(ep.ProviderIds || {}), ...(ep.SeriesProviderIds || {}) };
    const episodeMedia = {
      title: `${showTitle} - S${String(season ?? "?").padStart(2, "0")}E${String(episodeNumber ?? "?").padStart(2, "0")}`,
      show_title: showTitle,
      showTitle,
      type: "episode",
      source: target,
      ids: target === "plex" ? rawIds : normalizeProviderIds(rawIds),
      season,
      episode: episodeNumber,
      episodeTitle: ep.Name || ep.name || ep.title || null,
      itemId,
      provider_item_id: itemId,
      provider_items: { [target]: itemId ? [String(itemId)] : [] },
      providerItems: { [target]: itemId ? [String(itemId)] : [] },
      isValid: true,
    };
    const result = await applyWatchedStateToNewItem(episodeMedia, config).catch(() => ({ applied: false }));
    if (result.applied) applied += 1;
  }

  return {
    applied: applied > 0,
    status: applied > 0 ? "success" : "skipped",
    reason: `Newly added ${media.type}: ${applied} of ${pending.length} unplayed episode(s) marked watched from existing history.`,
  };
}

// Applies an existing watched record to the single server that just reported
// the item as newly added. Deliberately narrow: it marks played on that one
// server and writes no watch history, so a library scan can never manufacture a
// play. The outbound mark is recorded in the loop ledger, which is what stops
// the resulting played webhook from coming back as a fresh watch or a rewatch.
export async function applyWatchedStateToNewItem(media, loadedConfig = null) {
  const target = String(media.source || "").toLowerCase();
  if (!["plex", "emby", "jellyfin"].includes(target)) {
    return { applied: false, reason: "Unknown source platform" };
  }

  const config = loadedConfig || await loadMediaConfig();
  if (!canReceiveState(config, target, "watched")) {
    return { applied: false, reason: `${platformLabel(target)} is not configured to receive watched state` };
  }

  // Adding a show or a season announces the container, not the episodes. Walk
  // its children so a series you have already watched arrives watched, and
  // apply each one through this same function so every guard below still holds.
  if (media.type === "series" || media.type === "season") {
    return applyWatchedStateToNewContainer(media, config, target);
  }

  // Current playstate is authoritative over historical watch rows. This keeps
  // a delayed library-added event from reviving an older watch after the user
  // explicitly marked the item unwatched.
  const canonicalState = await getCanonicalWatchState(media).catch(() => null);
  if (canonicalState !== "watched") {
    return {
      applied: false,
      reason: canonicalState === "unwatched"
        ? "Current canonical state is unwatched"
        : "No watched record for this item",
    };
  }

  // Keep the matching history row for its original watched timestamp, which is
  // included in the sync telemetry below.
  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (!existing) {
    return { applied: false, reason: "No watched record for this item" };
  }

  const loopStore = createLoopStore();
  let summary;
  try {
    // Prime the durable echo ledger before the media-server request. Jellyfin
    // can deliver UserDataSaved synchronously while the mark-played request is
    // still in flight; writing only after the request leaves a race where the
    // callback is recorded as a fresh watch.
    await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
    // This projects a watch Plembfin already recorded onto a library item that
    // has only just appeared - a historical backfill, not a new event. Naming
    // the intent lets the provider matrix apply the Plex historical policy, and
    // carrying the original watched_at is what lets Emby and Jellyfin record
    // the real date rather than today.
    const outboundMedia = { ...media, syncIntent: "historical", watched_at: existing.watched_at || media.watched_at };
    let targetResult = null;
    if (target === "plex") targetResult = await markPlexPlayed(config.plex, outboundMedia);
    if (target === "emby") targetResult = await markEmbyPlayed(config.emby, outboundMedia);
    if (target === "jellyfin") targetResult = await markJellyfinPlayed(config.jellyfin, outboundMedia);
    await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
    if (targetResult?.status === "skipped_by_policy") {
      return { applied: false, reason: targetResult.detail || "Skipped by the historical sync policy" };
    }
    if (targetResult?.status === "already_matching") {
      return { applied: false, reason: `${platformLabel(target)} already has this item watched` };
    }
    summary = {
      skipped: false,
      status: "success",
      details: `Newly added item marked watched on ${platformLabel(target)} from existing history (watched ${existing.watched_at}).`,
      targetStates: [{ target, status: "success", detail: "Marked watched on add", itemId: targetResult?.itemId || "", itemIds: targetResult?.itemIds || undefined, httpStatus: targetResult?.httpStatus || null }],
    };
  } catch (error) {
    summary = {
      skipped: false,
      status: "error",
      details: `Could not mark newly added item watched on ${platformLabel(target)}: ${error.message || String(error)}`,
      targetStates: [{ target, status: "error", detail: error.message || "Mark failed" }],
    };
  }

  await recordSyncHistory(media, summary, "watched").catch(() => null);
  console.log("New item caught up from history", {
    source: target,
    title: media.title,
    status: summary.status,
  });
  return { applied: summary.status === "success", status: summary.status, reason: summary.details };
}

export async function handleSyncJobs(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const jobs = await querySyncJobs({
    limit: req.query.limit || 100,
    offset: req.query.offset || 0,
    status: req.query.status || "outstanding",
  });
  return sendJson(res, { jobs }, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

export async function handleSyncLibraries(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const config = await loadMediaConfig();
  const libraries = [];
  const failures = [];
  const jobs = [["plex", config.plex, listPlexLibraries], ["emby", config.emby, listEmbyLibraries], ["jellyfin", config.jellyfin, listJellyfinLibraries]].filter(([, section]) => section && !section.disabled);
  await Promise.all(jobs.map(async ([server, section, list]) => {
    try { libraries.push(...(await list(section)).map((library) => ({ ...library, server }))); }
    catch (error) { failures.push({ server, error: error.message }); }
  }));
  return sendJson(res, { libraries, errors: failures }, 200, { "Cache-Control": "no-store" });
}

function syncTelemetryLineValue(telemetry = "", label = "") {
  const prefix = `${label}:`;
  const line = String(telemetry || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function syncTelemetryTargetStates(telemetry = "") {
  return String(telemetry || "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(?:target\s+)?(plex|emby|jellyfin|trakt)\s+(?:progress\s+)?status:\s*(.+)$/i))
    .filter(Boolean)
    .map(([, target, result]) => {
      const separator = result.indexOf(" - ");
      const status = (separator < 0 ? result : result.slice(0, separator)).trim().toLowerCase() || "unknown";
      const detail = separator < 0 ? "" : result.slice(separator + 3).trim();
      return { target: target.toLowerCase(), status, ...(detail ? { detail } : {}) };
    });
}

export function queuedWatchRecordToSyncActivity(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || "");
  const timestamp = Number(row.updated_at || row.created_at) || Date.parse(String(row.watched_at || "")) || Date.now();
  const status = syncTelemetryLineValue(telemetry, "Dispatch status").toLowerCase() || "queued";
  const details = syncTelemetryLineValue(telemetry, "Details") || "Outbound synchronization queued after the Plekt history write.";
  const ids = {
    imdb: row.imdb_id || "",
    tmdb: row.tmdb_id || "",
    tvdb: row.tvdb_id || "",
  };
  return {
    id: `queued:${row.id}`,
    timestamp,
    mediaType: row.media_type || "unknown",
    title: row.title || "Unknown media",
    source: row.source || "unknown",
    status,
    details,
    action: row.sync_action || "watched",
    activityItemKey: activityItemKeyFor({
      mediaType: row.media_type || "unknown",
      title: row.title || "Unknown media",
      source: row.source || "unknown",
      action: row.sync_action || "watched",
      rawPayloadDebug: {
        ids,
        season: row.season ?? null,
        episode: row.episode ?? null,
        mediaKey: row.media_key || "",
      },
    }),
    targetStates: syncTelemetryTargetStates(telemetry),
    rawPayloadDebug: {
      event: row.watch_provenance?.event || "",
      phase: row.watch_provenance?.phase || "",
      ids,
      season: row.season ?? null,
      episode: row.episode ?? null,
      provenance: row.watch_provenance || null,
      watchRecordId: row.id != null ? String(row.id) : "",
      mediaKey: row.media_key || "",
    },
    createdAt: Number(row.created_at || 0),
  };
}

function normalizedSyncActivityTitle(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function queuedActivityAlreadyRecorded(row, history = []) {
  const recordId = row.id != null ? String(row.id) : "";
  const title = normalizedSyncActivityTitle(row.title);
  const mediaType = String(row.media_type || "").toLowerCase();
  const action = String(row.sync_action || "watched").toLowerCase();
  const queuedAt = Number(row.updated_at || row.created_at) || Date.parse(String(row.watched_at || "")) || 0;
  return history.some((entry) => {
    const debug = entry.rawPayloadDebug || {};
    if (recordId && String(debug.watchRecordId || debug.watch_record_id || "") === recordId) return true;
    if (mediaType !== String(entry.mediaType || "").toLowerCase()) return false;
    if (action !== String(entry.action || "watched").toLowerCase()) return false;
    if (title !== normalizedSyncActivityTitle(entry.title)) return false;
    const historyAt = Number(entry.timestamp || 0);
    return queuedAt > 0 && historyAt > 0 && Math.abs(historyAt - queuedAt) <= 15 * 60 * 1000;
  });
}

// The actual page-building logic behind GET /api/sync-history (queued
// watch_history rows merged as a prefix ahead of the durable sync_history
// store - see the comment below), factored out so a caller that isn't an
// HTTP request - the "retry all failed" background job's own discovery pass
// - can walk it directly instead of the job calling back into its own HTTP
// server. requestedLimit is not capped here the way the route handler caps
// it for response size; a background caller can ask for a much larger page.
async function getMergedSyncActivityPage({ limit = 100, page = 1, search = "" } = {}) {
  const requestedLimit = Math.max(Math.floor(Number(limit) || 100), 1);
  const requestedPage = Math.max(Math.floor(Number(page) || 1), 1);
  const cleanedSearch = String(search || "").trim().slice(0, 120);
  const [historyHead, queuedRows, searchedHistory] = await Promise.all([
    // Keep the queue de-duplication probe bounded. The durable page query
    // below is the only query whose size is controlled by the requested page.
    getSyncHistoryPage({ limit: 200, offset: 0 }),
    // This endpoint is deliberately fresh: most ingest paths defer their
    // derived-cache invalidation until after outbound dispatch, while the
    // Activity page should show the queue during that dispatch window.
    querySyncJobs({ limit: 500, status: "outstanding", fresh: true }),
    cleanedSearch ? getSyncHistoryPage({ limit: 1, offset: 0, search: cleanedSearch }) : Promise.resolve(null),
  ]);
  const queued = queuedRows
    .filter((row) => !queuedActivityAlreadyRecorded(row, historyHead.history))
    .map(queuedWatchRecordToSyncActivity)
    .filter((entry) => {
      if (!cleanedSearch) return true;
      const source = String(entry.source || "").toLowerCase();
      const sourceLabel = source.startsWith("manual") || source.startsWith("force_sync") || source.startsWith("plembfin") ? "Plekt" : source;
      const haystack = [
        entry.mediaType,
        entry.title,
        entry.source,
        sourceLabel,
        entry.status,
        entry.details,
        entry.action,
        JSON.stringify(entry.targetStates || []),
        JSON.stringify(entry.rawPayloadDebug || {}),
      ].join(" ").toLowerCase();
      return haystack.includes(cleanedSearch.toLowerCase());
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0) || String(b.id).localeCompare(String(a.id)));

  // Pending queue entries are treated as a short-lived prefix of the feed.
  // This keeps them visible without changing the offsets of the durable rows
  // every time a dispatch finishes. The durable store remains the source for
  // every subsequent page.
  const total = (searchedHistory?.total ?? historyHead.total) + queued.length;
  const totalPages = Math.max(1, Math.ceil(total / requestedLimit));
  const resolvedPage = Math.min(requestedPage, totalPages);
  const pageOffset = (resolvedPage - 1) * requestedLimit;
  const queuedStart = Math.min(pageOffset, queued.length);
  const queuedPage = queued.slice(queuedStart, queuedStart + requestedLimit);
  const storedOffset = Math.max(0, pageOffset - queued.length);
  const storedLimit = Math.max(0, requestedLimit - queuedPage.length);
  const storedPage = storedLimit
    ? await getSyncHistoryPage({ limit: storedLimit, offset: storedOffset, search: cleanedSearch })
    : { history: [] };
  const merged = [...queuedPage, ...storedPage.history];
  const from = total ? pageOffset + 1 : 0;
  const to = total ? Math.min(pageOffset + merged.length, total) : 0;

  // A stable, whole-backlog figure for a large Trakt import's outbound
  // propagation - see countTraktImportPendingDispatch in dataRepo.js for why
  // this exists alongside the live per-burst "Sync - X of Y" indicator.
  const traktDispatchProgress = countTraktImportPendingDispatch();

  return {
    history: merged,
    pagination: {
      page: resolvedPage,
      limit: requestedLimit,
      total,
      totalPages,
      from,
      to,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
    ...(traktDispatchProgress.pending > 0 ? { traktDispatchProgress } : {}),
  };
}

export async function handleSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const requestedLimit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const requestedPage = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const search = String(req.query.search || "").trim().slice(0, 120);
  const body = await getMergedSyncActivityPage({ limit: requestedLimit, page: requestedPage, search });
  return sendJson(res, body, 200, { "Cache-Control": "private, max-age=15, stale-while-revalidate=60", Vary: "Authorization" });
}

// Stable, user-facing view of the audit trail. The legacy /api/sync-history
// endpoint remains event-shaped for retry tooling and compatibility; this
// endpoint groups events before pagination so a busy movie cannot consume a
// page by itself.
export async function handleSyncActivity(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
  const page = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const search = String(req.query.search || "").trim().slice(0, 120);
  const failedOnly = ["1", "true", "failed"].includes(String(req.query.failedOnly || "").trim().toLowerCase());
  const offset = (page - 1) * limit;
  const result = await getSyncActivityGroupsPage({ limit, offset, search, failedOnly });
  const matchReport = await currentSyncActivityMatchReport();
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit));
  const resolvedPage = Math.min(page, totalPages);
  // A new event can move a group onto page one between requests. Re-read the
  // requested page when the supplied page was beyond the current end so the
  // response never advertises an empty page that cannot exist.
  const resolved = resolvedPage === page
    ? result
    : await getSyncActivityGroupsPage({ limit, offset: (resolvedPage - 1) * limit, search, failedOnly });
  const from = resolved.total ? (resolvedPage - 1) * limit + 1 : 0;
  const to = resolved.total ? Math.min(from + resolved.groups.length - 1, resolved.total) : 0;
  const traktDispatchProgress = countTraktImportPendingDispatch();
  return sendJson(res, {
    groups: resolved.groups,
    failedOnly,
    currentIssueGroupCount: Number(resolved.currentIssueGroupCount) || 0,
    currentIssueCount: Number(resolved.currentIssueCount) || 0,
    retryableCount: Number(resolved.retryableCount) || 0,
    matchReport,
    pagination: {
      page: resolvedPage,
      limit: resolved.limit,
      total: resolved.total,
      totalPages,
      from,
      to,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
    ...(traktDispatchProgress.pending > 0 ? { traktDispatchProgress } : {}),
  }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

export async function handleDismissSyncMatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Sync Activity changes are paused until it completes." }, 409);
  }

  const body = await readJson(req);
  const ids = Array.isArray(body.ids)
    ? body.ids.map((value) => String(value || "").trim()).filter(Boolean)
    : String(body.id || "").trim() ? [String(body.id).trim()] : [];
  if (!ids.length) return sendJson(res, { error: "id or ids is required" }, 400);
  if (ids.length > 500) return sendJson(res, { error: "Batch size must be 500 records or fewer" }, 413);

  const results = [];
  let dismissed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const result = await dismissSyncMatchRecord(id);
      if (!result.ok) {
        const error = new Error(result.error || "Could not remove match issue");
        error.status = result.error === "Watch record not found" ? 404 : 400;
        throw error;
      }
      dismissed += 1;
      results.push({ id, status: "removed", ...result });
    } catch (error) {
      failed += 1;
      const code = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      console.error("Remove sync match issue failed", error);
      results.push({ id, status: "error", error: code === 404 ? "Watch record not found" : "Could not remove match issue", code });
    }
  }

  if (ids.length === 1) {
    const only = results[0];
    if (only.status === "error") return sendJson(res, { ok: false, error: only.error }, only.code || 500);
    return sendJson(res, { ok: true, ...only });
  }
  return sendJson(res, { ok: true, dismissed, failed, results });
}

export async function handleSyncActivityGroup(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const groupKey = String(req.query.key || "").trim();
  if (!groupKey) return sendJson(res, { error: "Activity group key is required" }, 400);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const page = Math.max(Math.floor(Number(req.query.page) || 1), 1);
  const latestOnly = ["1", "true", "latest"].includes(String(req.query.latest || req.query.latestOnly || "").trim().toLowerCase());
  const result = await getSyncActivityGroupEvents({ groupKey, limit, offset: (page - 1) * limit, latestOnly });
  if (!result.group) return sendJson(res, { error: "Sync activity group not found" }, 404);
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit));
  const resolvedPage = Math.min(page, totalPages);
  const resolved = resolvedPage === page
    ? result
    : await getSyncActivityGroupEvents({ groupKey, limit, offset: (resolvedPage - 1) * limit, latestOnly });
  return sendJson(res, {
    group: resolved.group,
    events: resolved.events,
    latestOnly: resolved.latestOnly,
    pagination: {
      page: resolvedPage,
      limit: resolved.limit,
      total: resolved.total,
      totalPages,
      from: resolved.total ? (resolvedPage - 1) * limit + 1 : 0,
      to: resolved.total ? Math.min(resolvedPage * limit, resolved.total) : 0,
      hasPrevious: resolvedPage > 1,
      hasNext: resolvedPage < totalPages,
    },
  }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

function isRetryableSyncActivityEntry(entry = {}) {
  return retryableSyncActivityTargets(entry).length > 0;
}

// A Trakt not_found for an episode means the stored show identity does not
// resolve to a real Trakt series. It is safe to dismiss that target without
// changing the local watched state, while other target failures (if present)
// remain actionable.
export function isTraktNotFoundSyncActivityEntry(entry = {}) {
  if (String(entry.mediaType || "").trim().toLowerCase() !== "episode") return false;
  return (entry.targetStates || []).some((target) => {
    const targetName = String(target?.target || "").trim().toLowerCase();
    const status = String(target?.status || "").trim().toLowerCase();
    const detail = `${target?.detail || ""} ${entry.details || ""}`;
    return targetName === "trakt"
      && ["error", "failed"].includes(status)
      && /not[_ -]?found/i.test(detail);
  });
}

function syncActivityEntryTimestamp(entry = {}) {
  return Number(entry.timestamp || entry.createdAt || 0) || 0;
}

function syncActivityEntryIdNumber(entry = {}) {
  const value = Number(entry.id);
  return Number.isFinite(value) ? value : 0;
}

function syncActivityEntryIsNewer(candidate, current) {
  const candidateTimestamp = syncActivityEntryTimestamp(candidate);
  const currentTimestamp = syncActivityEntryTimestamp(current);
  if (candidateTimestamp !== currentTimestamp) return candidateTimestamp > currentTimestamp;
  const candidateId = syncActivityEntryIdNumber(candidate);
  const currentId = syncActivityEntryIdNumber(current);
  if (candidateId !== currentId) return candidateId > currentId;
  return String(candidate?.id || "") > String(current?.id || "");
}

// Walks every page of getMergedSyncActivityPage (not just what the HTTP
// route's own response-size cap would allow) collecting every retryable
// entry's id, for the "retry all failed" background job's own discovery
// pass - no HTTP round trip to itself, and no cap on page size since nothing
// here goes back over the wire.
async function listAllRetryableSyncActivityIds() {
  const latestByItem = new Map();
  const limit = 500;
  let page = 1;
  for (;;) {
    const body = await getMergedSyncActivityPage({ limit, page });
    for (const entry of body.history) {
      const itemKey = String(entry.activityItemKey || activityItemKeyFor(entry) || "").trim();
      if (!itemKey) continue;
      const current = latestByItem.get(itemKey);
      if (!current || syncActivityEntryIsNewer(entry, current)) latestByItem.set(itemKey, entry);
    }
    const totalPages = Math.max(Number(body.pagination?.totalPages) || 1, 1);
    if (!body.history.length || page >= totalPages) break;
    page += 1;
  }
  return [...latestByItem.values()]
    .filter(isRetryableSyncActivityEntry)
    .sort((left, right) => syncActivityEntryTimestamp(right) - syncActivityEntryTimestamp(left) || syncActivityEntryIdNumber(right) - syncActivityEntryIdNumber(left))
    .map((entry) => String(entry.id));
}

function retryableSyncActivityTargets(entry = {}) {
  return [...new Set((entry.targetStates || [])
    .filter((target) => ["error", "failed"].includes(String(target.status || "").toLowerCase()))
    .map((target) => String(target.target || "").trim().toLowerCase())
    .filter((target) => ["plex", "emby", "jellyfin", "trakt"].includes(target)))];
}

// Recomputes an entry's overall status from its per-target results, the same
// success/partial/error/skipped rules syncOrchestrator.js itself uses - kept
// here in miniature because this is recomputing a MERGED array (original
// targets untouched by a retry, mixed with the retry's own results), not the
// single dispatch summary syncOrchestrator already scores.
function statusFromTargetStates(targetStates = []) {
  if (!targetStates.length) return "skipped";
  const successCount = targetStates.filter((t) => String(t.status || "").toLowerCase() === "success").length;
  const failureCount = targetStates.filter((t) => ["error", "failed"].includes(String(t.status || "").toLowerCase())).length;
  if (successCount === targetStates.length) return "success";
  if (failureCount) return successCount ? "partial" : "error";
  return successCount ? "partial" : "skipped";
}

function rewriteDismissedTraktTelemetry(telemetry = "") {
  const lines = String(telemetry || "").split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    const match = line.match(/^(Target\s+)?Trakt(?:\s+progress)?\s+status:\s*([^-]+)(?:\s+-\s*(.*))?$/i);
    if (!match || !["error", "failed"].includes(String(match[2] || "").trim().toLowerCase())) return line;
    const detail = `${match[3] || ""} ${line}`;
    if (!/not[_ -]?found/i.test(detail)) return line;
    replaced = true;
    const targetPrefix = match[1] ? "Target " : "";
    const progressSuffix = /\bprogress\s+status:/i.test(line) ? " progress" : "";
    return `${targetPrefix}Trakt${progressSuffix} status: skipped - ${DISMISSED_TRAKT_NOT_FOUND_DETAIL} (retry still returned not_found)`;
  });
  if (!replaced) return "";

  const targetStatuses = nextLines
    .map((line) => line.match(/^(?:Target\s+)?(Plex|Emby|Jellyfin|Trakt)(?:\s+progress)?\s+status:\s*([^-]+)/i))
    .filter(Boolean)
    .map((match) => String(match[2] || "").trim().toLowerCase());
  const failures = targetStatuses.filter((status) => ["error", "failed"].includes(status));
  const pending = targetStatuses.filter((status) => ["pending", "queued", "in_progress", "in progress"].includes(status));
  const successes = targetStatuses.filter((status) => status === "success");
  const nextStatus = failures.length
    ? (successes.length ? "partial" : "error")
    : pending.length ? "pending" : successes.length ? "success" : "skipped";
  const dispatchIndex = nextLines.findIndex((line) => /^Dispatch status:/i.test(line));
  if (dispatchIndex >= 0) nextLines[dispatchIndex] = `Dispatch status: ${nextStatus}`;
  const detailLine = `Details: ${DISMISSED_TRAKT_NOT_FOUND_DETAIL}; a later retry still returned not_found.`;
  const detailsIndex = nextLines.findIndex((line) => /^Details:/i.test(line));
  if (detailsIndex >= 0) nextLines[detailsIndex] = detailLine;
  else nextLines.push(detailLine);
  return nextLines.join("\n");
}

async function persistDismissedTraktTelemetry(entry = {}) {
  const debug = entry.rawPayloadDebug || {};
  const recordId = debug.watchRecordId || debug.watch_record_id;
  let record = recordId ? await getWatchRecordById(recordId) : null;
  if (!record) {
    const mediaKey = debug.mediaKey || debug.media_key;
    if (mediaKey) record = await getWatchRecordByMediaKey(mediaKey);
  }
  if (!record) record = currentWatchRecordForSyncActivity(entry, debug);
  if (!record?.id || !record.sync_dispatch_telemetry) return;
  const rewritten = rewriteDismissedTraktTelemetry(record.sync_dispatch_telemetry);
  if (!rewritten || rewritten === record.sync_dispatch_telemetry) return;
  await updateWatchTelemetry(record.id, rewritten);
}

// Mark only the Trakt not_found target as intentionally skipped. This keeps
// the audit row and any unrelated target failures intact, but removes the
// permanent Trakt mismatch from the current-issue count.
export async function dismissSyncActivityEntry(rawId, { scope = "item" } = {}) {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; sync activity changes are paused until it completes."), { status: 409, code: "RESTORE_ACTIVE" });
  }
  const id = String(rawId == null ? "" : rawId).trim();
  if (!id) throw Object.assign(new Error("Missing required field: id"), { status: 400 });
  if (id.startsWith("queued:")) {
    throw Object.assign(new Error("Queued sync activity has no durable Trakt error to dismiss"), { status: 409 });
  }

  const entry = await getSyncHistoryById(id);
  if (!entry) throw Object.assign(new Error("Sync activity entry not found"), { status: 404 });
  const latest = await getLatestSyncActivityByItemKey(entry.activityItemKey);
  if (latest && String(latest.id) !== String(entry.id)) {
    throw Object.assign(new Error("This sync activity entry has been superseded by a newer result for the same item"), { status: 409 });
  }
  if (!isTraktNotFoundSyncActivityEntry(entry)) {
    throw Object.assign(new Error("This entry does not contain a dismissible Trakt not-found error"), { status: 409 });
  }

  const dismissedAt = Date.now();
  const dismissalScope = String(scope || "").trim().toLowerCase() === "show" ? "show" : "item";
  const targetStates = (entry.targetStates || []).map((target) => {
    const targetName = String(target?.target || "").trim().toLowerCase();
    const status = String(target?.status || "").trim().toLowerCase();
    const detail = `${target?.detail || ""} ${entry.details || ""}`;
    if (targetName !== "trakt" || !["error", "failed"].includes(status) || !/not[_ -]?found/i.test(detail)) {
      return target;
    }
    return { ...target, target: "trakt", status: "skipped", detail: DISMISSED_TRAKT_NOT_FOUND_DETAIL };
  });
  const remainingFailures = targetStates
    .filter((target) => ["error", "failed"].includes(String(target?.status || "").trim().toLowerCase()))
    .map((target) => String(target?.target || "").trim().toLowerCase())
    .filter(Boolean);
  const details = `Trakt match error dismissed: Trakt does not have this show.${remainingFailures.length ? ` Remaining failed targets: ${[...new Set(remainingFailures)].join(", ")}.` : ""}`;
  const previousDismissals = Array.isArray(entry.rawPayloadDebug?.dismissalHistory)
    ? entry.rawPayloadDebug.dismissalHistory
    : [];

  await updateSyncHistoryStatus(entry.id, {
    status: statusFromTargetStates(targetStates),
    details,
    action: entry.action,
    targetStates,
    rawPayloadDebug: {
      ...entry.rawPayloadDebug,
      dismissalHistory: [
        ...previousDismissals,
        { timestamp: dismissedAt, target: "trakt", reason: "not_found", scope: dismissalScope },
      ].slice(-10),
    },
  });
  await persistDismissedTraktTelemetry(entry).catch((error) => {
    console.error("Failed to update watch telemetry after dismissing Trakt error", error);
  });

  return {
    id: String(entry.id),
    title: entry.title,
    status: statusFromTargetStates(targetStates),
    details,
    dismissedTarget: "trakt",
  };
}

// Folds a retry's own target-level results back into the entry's original
// target list: a target the retry actually reported on takes its new result;
// a target that was retried (in retriedTargets) but the retry summary never
// mentioned - because there was nothing to dispatch to at all, e.g. "No
// enabled sync destinations" - is downgraded from its old "error" to
// "skipped" rather than left showing a stale error. A target that wasn't
// part of this retry (already succeeding, or a platform outside
// plex/emby/jellyfin/trakt) is carried over unchanged.
function mergeTargetStates(originalTargetStates = [], retrySummaryTargetStates = [], retriedTargets = [], retryDetail = "") {
  const retriedSet = new Set(retriedTargets);
  const byTarget = new Map(retrySummaryTargetStates.map((t) => [String(t.target || "").trim().toLowerCase(), t]));
  return originalTargetStates.map((t) => {
    const key = String(t.target || "").trim().toLowerCase();
    if (byTarget.has(key)) return byTarget.get(key);
    if (retriedSet.has(key)) return { target: key, status: "skipped", detail: retryDetail || "No destination currently configured" };
    return t;
  });
}

async function mediaFromSyncActivity(entry, config, identity = {}) {
  const debug = entry.rawPayloadDebug || {};
  const hasIdentity = Boolean(
    String(identity.showTitle || identity.show_title || "").trim()
      || String(identity.tvdbId || identity.tvdb_id || "").trim(),
  );
  if (hasIdentity) {
    const rematchedRecord = currentWatchRecordForSyncActivity(entry, debug, identity);
    if (rematchedRecord) return mediaFromWatchRecord(rematchedRecord);
  }
  const recordId = debug.watchRecordId || debug.watch_record_id;
  const record = recordId ? await getWatchRecordById(recordId) : null;
  if (record) return mediaFromWatchRecord(record);

  const currentRecord = currentWatchRecordForSyncActivity(entry, debug);
  if (currentRecord) return mediaFromWatchRecord(currentRecord);

  const ratingKey = debug.ratingKey || debug.rating_key;
  if (String(entry.source || "").toLowerCase().startsWith("plex") && ratingKey && config?.plex) {
    const metadata = await fetchPlexMetadataItem(config.plex, ratingKey).catch(() => null);
    if (metadata) return buildPlexMediaFromMetadata(metadata, { phase: String(entry.action || "watched").toLowerCase().startsWith("un") ? "unplayed" : "completed" });
  }

  const ids = debug.ids || debug.media?.ids || {};
  return {
    title: entry.title,
    type: String(entry.mediaType || "").toLowerCase(),
    source: entry.source || "manual",
    ids: {
      imdb: ids.imdb || ids.imdb_id || undefined,
      tmdb: ids.tmdb || ids.tmdb_id || undefined,
      tvdb: ids.tvdb || ids.tvdb_id || undefined,
    },
    season: debug.season ?? debug.media?.season,
    episode: debug.episode ?? debug.media?.episode,
    isValid: Boolean(entry.title && ["movie", "episode"].includes(String(entry.mediaType || "").toLowerCase())),
  };
}

// A "queued:<watch_history id>" activity entry (queuedWatchRecordToSyncActivity
// below) represents a watch that's been recorded locally but has no
// sync_history row of its own yet - that's the whole reason it reads
// "queued" rather than "error"/"partial". There's nothing for
// getSyncHistoryById to find, so retrying one means dispatching the
// underlying watch_history row directly, the same way the original write's
// own deferred dispatch would have, rather than replaying a prior attempt.
// The appended sync_history record's rawPayloadDebug.watchRecordId lets
// queuedActivityAlreadyRecorded (below) recognize this queued entry as
// resolved and stop showing it once the activity list next refreshes.
async function retryQueuedWatchRecord(watchRecordId) {
  const id = String(watchRecordId || "").trim();
  if (!id) throw Object.assign(new Error("Missing watch record id"), { status: 400 });
  const record = await getWatchRecordById(id);
  if (!record) throw Object.assign(new Error("The original watch record for this queued item could not be found"), { status: 404 });

  const config = await loadMediaConfig();
  const media = mediaFromWatchRecord(record);
  media.watched_at = record.watched_at || undefined;
  if (!media?.isValid) throw Object.assign(new Error("The media identity for this watch record could not be resolved"), { status: 422 });

  const originalTargetStates = syncTelemetryTargetStates(record.sync_dispatch_telemetry);
  const retriedTargets = retryableSyncActivityTargets({ targetStates: originalTargetStates });
  const action = String(record.sync_action || "watched").toLowerCase();
  const loopStore = createLoopStore();
  let summary;
  try {
    summary = action === "unwatched" || action === "unplayed"
      ? await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" })
      : await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
  } catch (error) {
    summary = { skipped: false, status: "error", details: `Retry failed: ${error.message || String(error)}`, targetStates: [] };
  }
  const mergedTargetStates = mergeTargetStates(originalTargetStates, summary.targetStates || [], retriedTargets, summary.details);
  const mergedStatus = statusFromTargetStates(mergedTargetStates);

  // The "queued:<id>" pseudo-entry the Activity list renders for this item is
  // read straight off this row's own telemetry (queuedWatchRecordToSyncActivity
  // below), not from a durable sync_history row - so unless this write happens,
  // the pseudo-entry keeps showing the retry's stale pre-retry outcome no
  // matter how many sync_history rows get appended elsewhere. Rewriting it here
  // is what actually makes the retry visible, independent of whatever durable
  // row also gets appended for the audit trail.
  await updateWatchTelemetry(id, formatDispatchTelemetry({ skipped: mergedStatus === "skipped", status: mergedStatus, details: summary.details, targetStates: mergedTargetStates }, media, action));
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: mergedStatus,
    details: `Retry of queued watch ${id}: ${summary.details || "Sync retry completed"}`,
    action,
    targetStates: mergedTargetStates,
    rawPayloadDebug: { watchRecordId: id, ids: media.ids || {} },
  });
  return { status: mergedStatus, details: summary.details, targetStates: mergedTargetStates, title: media.title };
}

// Core retry logic for a single sync-activity id - a real sync_history row
// or a "queued:<watch_history id>" pseudo-entry - shared by the interactive
// HTTP endpoint below and the "retry all failed" background job, so there is
// exactly one place that knows how to retry one item. Throws an Error with a
// `.status` for the HTTP wrapper to translate into a response code; the
// background job just logs the message and moves on to the next id.
async function retrySyncActivityEntry(rawId, retryContext = {}) {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; retry sync is paused until it completes."), { status: 409, code: "RESTORE_ACTIVE" });
  }
  const id = String(rawId == null ? "" : rawId).trim();
  if (!id) throw Object.assign(new Error("Missing required field: id"), { status: 400 });
  if (id.startsWith("queued:")) return retryQueuedWatchRecord(id.slice("queued:".length));

  const entry = await getSyncHistoryById(id);
  if (!entry) throw Object.assign(new Error("Sync activity entry not found"), { status: 404 });
  const latest = await getLatestSyncActivityByItemKey(entry.activityItemKey);
  if (latest && String(latest.id) !== String(entry.id)) {
    throw Object.assign(new Error("A newer sync result already exists for this item"), {
      status: 409,
      code: "SYNC_ACTIVITY_SUPERSEDED",
    });
  }
  const targets = retryableSyncActivityTargets(entry);
  if (!targets.length) throw Object.assign(new Error("This sync activity entry has no failed targets to retry"), { status: 409 });

  const config = await loadMediaConfig();
  const media = await mediaFromSyncActivity(entry, config, retryContext);
  if (!media?.isValid) throw Object.assign(new Error("The media identity for this activity entry could not be resolved"), { status: 422 });
  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (existing?.watched_at) media.watched_at = existing.watched_at;
  media.syncTargets = targets;

  const action = String(entry.action || "watched").toLowerCase();
  const loopStore = createLoopStore();
  let summary;
  try {
    summary = action === "unwatched" || action === "unplayed"
      ? await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" })
      : await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
  } catch (error) {
    summary = { skipped: false, status: "error", details: `Retry failed: ${error.message || String(error)}`, targetStates: [] };
  }
  const mergedTargetStates = mergeTargetStates(entry.targetStates || [], summary.targetStates || [], targets, summary.details);
  const mergedStatus = statusFromTargetStates(mergedTargetStates);
  await updateSyncHistoryStatus(entry.id, {
    status: mergedStatus,
    details: summary.details || entry.details,
    action,
    targetStates: mergedTargetStates,
    rawPayloadDebug: { ...entry.rawPayloadDebug, ids: media.ids || {} },
  });
  return { status: mergedStatus, details: summary.details, targetStates: mergedTargetStates, title: media.title };
}

async function listCurrentSyncActivityGroupRetryableEntries(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) throw Object.assign(new Error("Activity group key is required"), { status: 400 });

  const entries = [];
  const limit = 500;
  let page = 1;
  let group = null;
  for (;;) {
    const result = await getSyncActivityGroupEvents({
      groupKey: key,
      limit,
      offset: (page - 1) * limit,
      latestOnly: true,
    });
    group = result.group || group;
    if (!group && page === 1) throw Object.assign(new Error("Sync activity group not found"), { status: 404 });
    entries.push(...(Array.isArray(result.events) ? result.events : []));
    const totalPages = Math.max(Math.ceil((Number(result.total) || 0) / limit), 1);
    if (!result.events?.length || page >= totalPages) break;
    page += 1;
  }
  return {
    group,
    entries: entries.filter(isRetryableSyncActivityEntry),
  };
}

// Retry every current failed item in one show group after the group's stored
// identity has been corrected. The loop is deliberately sequential so a
// show-wide repair does not create a burst of Trakt requests.
export async function retrySyncActivityGroup(groupKey, retryContext = {}) {
  const { group, entries } = await listCurrentSyncActivityGroupRetryableEntries(groupKey);
  let succeeded = 0;
  let stillFailed = 0;
  let skipped = 0;
  let errored = 0;
  const results = [];

  for (const entry of entries) {
    try {
      const result = await retrySyncActivityEntry(entry.id, retryContext);
      if (result.status === "success") succeeded += 1;
      else if (result.status === "skipped") skipped += 1;
      else stillFailed += 1;
      results.push({ id: String(entry.id), title: result.title || entry.title, status: result.status, details: result.details || "" });
    } catch (error) {
      errored += 1;
      results.push({ id: String(entry.id), title: entry.title, status: "error", details: error.message || String(error) });
    }
  }

  return {
    success: true,
    groupKey: String(groupKey || ""),
    title: group?.title || entries[0]?.title || "this show",
    total: entries.length,
    processed: entries.length,
    succeeded,
    stillFailed,
    skipped,
    errored,
    results,
  };
}

export async function handleRetrySyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }

  const body = await readJson(req);
  const retryContext = {
    tvdbId: String(body.tvdbId || body.tvdb_id || "").trim(),
    showTitle: String(body.showTitle || body.show_title || "").trim(),
  };
  try {
    const result = await retrySyncActivityEntry(body.id, retryContext);
    return sendJson(res, { ok: true, ...result });
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (error?.code === "SYNC_ACTIVITY_SUPERSEDED") {
      console.info("Skipped stale sync-activity retry because a newer result already exists.");
      return sendJson(res, {
        code: error.code,
        error: "A newer sync result already exists for this item. The activity list was refreshed; retry the latest result if it still shows a failure.",
      }, 409);
    }
    console.error("Retry sync activity failed", error);
    return sendApiError(res, error, { error: status === 404 ? "Sync activity item not found" : "Retry sync activity failed" }, status);
  }
}

export async function handleDismissSyncHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; sync activity changes are paused until it completes." }, 409);
  }

  const body = await readJson(req);
  const dismissalScope = String(body.scope || "").trim().toLowerCase() === "show" ? "show" : "item";
  const ids = Array.isArray(body.ids)
    ? body.ids.map((value) => String(value || "").trim()).filter(Boolean)
    : String(body.id || "").trim() ? [String(body.id).trim()] : [];
  if (!ids.length) return sendJson(res, { error: "id or ids is required" }, 400);
  if (ids.length > 500) return sendJson(res, { error: "Batch size must be 500 records or fewer" }, 413);

  const results = [];
  let dismissed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const result = await dismissSyncActivityEntry(id, { scope: dismissalScope });
      dismissed += 1;
      results.push({ id, status: "dismissed", ...result });
    } catch (error) {
      failed += 1;
      const code = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (error?.code === "RESTORE_ACTIVE") return sendApiError(res, error, { ok: false }, 409);
      console.error("Dismiss sync activity failed", error);
      results.push({ id, status: "error", error: code === 404 ? "Sync activity item not found" : "Dismiss sync activity failed", code });
    }
  }

  if (ids.length === 1) {
    const only = results[0];
    if (only.status === "error") return sendJson(res, { ok: false, error: only.error }, only.code || 500);
    return sendJson(res, { ok: true, ...only });
  }
  return sendJson(res, { ok: true, dismissed, failed, results });
}

export async function handleRetrySyncActivityGroup(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }

  const body = await readJson(req);
  const groupKey = String(body.groupKey || body.group_key || "").trim();
  if (!groupKey) return sendJson(res, { error: "groupKey is required" }, 400);
  const retryContext = {
    tvdbId: String(body.tvdbId || body.tvdb_id || "").trim(),
    showTitle: String(body.showTitle || body.show_title || "").trim(),
  };
  try {
    const result = await retrySyncActivityGroup(groupKey, retryContext);
    return sendJson(res, { ok: true, ...result });
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    console.error("Retry sync activity group failed", error);
    return sendApiError(res, error, { ok: false, error: status === 404 ? "Sync activity group not found" : "Retry sync activity group failed" }, status);
  }
}

// Runs "retry all failed" to completion as a background job (see
// workerCoordinator.js's executeJob) so it survives the requesting browser
// tab closing, reloading, or navigating away - the same reasoning as
// runTmdbMetadataRefreshJob in maintenance.js. Discovery selects only the
// newest event for each movie/episode identity; older duplicate rows and rows
// already superseded by a later success are never retried.
export async function runRetryAllSyncActivityJob(log, { isCancelled } = {}) {
  const ids = await listAllRetryableSyncActivityIds();
  const total = ids.length;
  log(`Found ${total} failed item${total === 1 ? "" : "s"} to retry.`);

  let succeeded = 0;
  let stillFailed = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < ids.length; i++) {
    if (isAuthoritativeRestoreActive() || (isCancelled && await isCancelled())) {
      return {
        success: true, aborted: true, cancelled: true,
        total, processed: i, succeeded, stillFailed, skipped, errored,
        reason: "Retry all was cancelled.",
      };
    }
    const id = ids[i];
    try {
      const result = await retrySyncActivityEntry(id);
      if (result.status === "success") succeeded += 1;
      else if (result.status === "skipped") skipped += 1;
      else stillFailed += 1;
      log(`[${i + 1}/${total}] ${result.title || id}: ${result.status}${result.details ? ` - ${result.details}` : ""} [activityId=${id}]`);
    } catch (error) {
      errored += 1;
      log(`[${i + 1}/${total}] ${id}: error - ${error.message} [activityId=${id}]`);
    }
  }

  log(`Retry all complete: ${succeeded} succeeded, ${stillFailed} still failed, ${skipped} skipped, ${errored} error${errored === 1 ? "" : "s"}, out of ${total}.`);
  return { success: true, total, processed: total, succeeded, stillFailed, skipped, errored };
}

export async function handleRetryAllSyncActivity(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  // GET: poll for current status and log lines, same shape as /api/force-sync.
  if (req.method === "GET") {
    const job = getLatestBackgroundJob("retry_all_sync_activity");
    if (!job) {
      return sendJson(res, { active: false, log: [], result: null, status: "idle", jobId: null, workerAvailable: workerAvailable() }, 200, { "Cache-Control": "no-store" });
    }
    return sendJson(res, {
      active: ["queued", "running"].includes(job.status),
      log: getBackgroundJobLogs(job.id).map((entry) => entry.message),
      result: job.result || (job.error ? { success: false, error: job.error } : null),
      startedAt: job.startedAt || job.requestedAt,
      jobId: job.id,
      status: job.status,
      workerAvailable: workerAvailable(),
    }, 200, { "Cache-Control": "no-store" });
  }

  // POST: fire-and-forget - return 202 immediately, run in background.
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }
  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const existingJob = getLatestBackgroundJob("retry_all_sync_activity");
  if (existingJob && ["queued", "running"].includes(existingJob.status)) {
    return sendJson(res, { ok: false, error: "A retry-all run is already in progress.", jobId: existingJob.id }, 409);
  }
  let queuedJob;
  try {
    queuedJob = enqueueBackgroundJob("retry_all_sync_activity", {});
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    throw error;
  }
  return sendJson(res, {
    ok: true,
    started: true,
    jobId: queuedJob.id,
    status: queuedJob.status,
    message: "Retry all queued. Poll GET /api/sync-history/retry-all for status.",
  }, 202);
}

// Explicit detail-page repair. This is intentionally separate from the
// library-wide /api/force-sync route: the latter is a canonical replay and
// must continue to ignore server-only watches, while this user-requested
// title-scoped action is allowed to import watched state for the selected item.
export async function handleMediaForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const body = await readJson(req);
    const requested = normalizeMediaForceSyncRequest(body);
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
    }
    const operationId = createMediaForceSyncActivity({
      title: requested.title,
      type: requested.type,
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
    });
    void (async () => {
      try {
        const result = await forceSyncMediaState(requested, {
          config: await loadMediaConfig(),
          isCancelled: () => isMediaForceSyncCancellationRequested(operationId),
          logger: (message) => {
            appendMediaForceSyncActivity(operationId, message, "info");
            console.log(`[Media Force Sync ${operationId}] ${message}`);
          },
        });
        finishMediaForceSyncActivity(operationId, result);
      } catch (error) {
        console.error("Detail-page Force Sync failed", error);
        finishMediaForceSyncActivity(operationId, null, error.message || "Detail-page Force Sync failed");
      }
    })();
    return sendJson(res, { ok: true, operationId, status: "running", ...requested, title: requested.title }, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Detail-page Force Sync failed", error);
    return sendApiError(res, error, { ok: false, error: error.message || "Detail-page Force Sync failed" }, 400);
  }
}

export async function handleMediaForceSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const operationId = String(req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);
  const activity = getMediaForceSyncActivity(operationId);
  if (!activity) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...activity }, 200, { "Cache-Control": "no-store" });
}

// Settings uses the same push/pull activity surface as the detail page, but
// its operation is library-wide rather than title-scoped.
export async function handleLibraryForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  try {
    const body = await readJson(req);
    const requested = normalizeLibraryForceSyncRequest(body);
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
    }
    const operationId = createMediaForceSyncActivity({
      title: requested.title,
      type: requested.type,
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
    });
    void (async () => {
      try {
        const result = await forceSyncLibraryState(requested, {
          config: await loadMediaConfig(),
          isCancelled: () => isMediaForceSyncCancellationRequested(operationId),
          logger: (message) => {
            appendMediaForceSyncActivity(operationId, message, "info");
            console.log(`[Library Force Sync ${operationId}] ${message}`);
          },
        });
        finishMediaForceSyncActivity(operationId, result);
      } catch (error) {
        console.error("Library Force Sync failed", error);
        finishMediaForceSyncActivity(operationId, null, error.message || "Library Force Sync failed");
      }
    })();
    return sendJson(res, { ok: true, operationId, status: "running", ...requested }, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Library Force Sync failed", error);
    return sendApiError(res, error, { ok: false, error: error.message || "Library Force Sync failed" }, 400);
  }
}

export async function handleLibraryForceSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const operationId = String(req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);
  const activity = getMediaForceSyncActivity(operationId);
  if (!activity) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...activity }, 200, { "Cache-Control": "no-store" });
}

export async function handleForceSyncCancellation(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  let body = {};
  try { body = await readJson(req); } catch { body = {}; }
  const operationId = String(body.id || req.query.id || "").trim();
  if (!operationId) return sendJson(res, { ok: false, error: "id is required" }, 400);

  const result = requestMediaForceSyncCancellation(operationId);
  if (!result.found) return sendJson(res, { ok: false, error: "Force Sync operation not found" }, 404);
  return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
}

// Bounded item-level concurrency for bulk manual watch/unwatch dispatch, matching
// the concurrency already used for Force Sync (mediaForceSync.js, libraryForceSync.js).
// Outbound HTTP calls are still throttled per-host by the outbound governor, so this
// only shortens wall-clock time for a large batch - it does not add pressure on
// Plex/Emby/Jellyfin beyond what the governor already allows.
const MANUAL_SYNC_ITEM_CONCURRENCY = 6;

export async function handleManualUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const ids = Array.isArray(body.ids)
    ? body.ids.map((value) => String(value || "").trim()).filter(Boolean)
    : String(body.id || "").trim() ? [String(body.id).trim()] : [];
  if (!ids.length) return sendJson(res, { error: "id or ids is required" }, 400);
  if (ids.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const results = new Array(ids.length);
  let succeeded = 0;
  let failed = 0;
  let queued = 0;

  const trackingReservation = reserveDispatchBatch(ids.length);
  try {
    await runWithConcurrency(ids, async (id, index) => {
      try {
        const record = await getWatchRecordById(id);
        if (!record) throw new Error("Watch record not found");
        const media = mediaFromWatchRecord(record);
        markReservedDispatchStarted(trackingReservation, media);
        const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, id, {
          includeSourcePlatform: true,
          trackDispatch: false,
          force: true,
          lane: ids.length === 1 ? "interactive" : "sync",
        });
        succeeded += 1;
        const wasQueued = Boolean(summary.deferred);
        if (wasQueued) queued += 1;
        results[index] = { id, unwatchedId, status: summary.status, queued: wasQueued, targetStates: summary.targetStates || [] };
      } catch (error) {
        failed += 1;
        results[index] = { id, error: error.message || String(error) };
      } finally {
        completeDispatchTracking(trackingReservation);
      }
    }, MANUAL_SYNC_ITEM_CONCURRENCY);
  } finally {
    finishDispatchTracking(trackingReservation);
    await invalidateHistoryDerivedCaches("handleManualUnwatch").catch(() => null);
  }

  if (ids.length === 1) {
    const only = results[0];
    if (only.error) return sendJson(res, { error: "Manual unwatch failed" }, 500);
    return sendJson(res, { ok: true, id: only.unwatchedId, status: only.status, queued: Boolean(only.queued), targetStates: only.targetStates });
  }
  return sendJson(res, { ok: true, succeeded, failed, queued, results });
}

function mergeManualTrackerSummary(summary = {}, trackerResult = null) {
  if (!trackerResult || (trackerResult.status === "skipped" && !trackerResult.dismissed)) return summary;

  const trackerStatus = trackerResult.status === "failed" ? "error" : trackerResult.status === "not_found" ? "skipped" : trackerResult.status;
  const targetStates = [
    ...(Array.isArray(summary.targetStates) ? summary.targetStates : []),
    { target: "trakt", status: trackerStatus, detail: trackerResult.detail || "" },
  ];
  const localStatus = summary.status || "unknown";
  let status = localStatus;
  if (trackerStatus === "success") {
    status = localStatus === "error" ? "partial" : "success";
  } else if (trackerStatus === "error") {
    status = ["success", "partial"].includes(localStatus) ? "partial" : "error";
  } else if (trackerStatus === "skipped") {
    status = localStatus === "success" ? "partial" : localStatus;
  }

  const trackerDetails = trackerStatus === "success"
    ? "Trakt marked watched in a grouped history request."
    : trackerResult.detail || "Trakt did not accept this item.";
  const details = localStatus === "skipped" && trackerStatus === "success"
    ? trackerDetails
    : [summary.details, trackerDetails].filter(Boolean).join("; ");
  return { ...summary, skipped: status === "skipped", status, details, targetStates };
}

export async function handleManualWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();
  const results = [];
  const syncTasks = [];
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  const canonicalShowByTitle = new Map();

  for (const [index, rawRecord] of records.entries()) {
    try {
      let pending = {
        ...rawRecord,
        source: rawRecord.source || "manual",
        sync_action: "watched",
        sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
      };
      let normalized = normalizeWatchRecordForInsert(pending, "manual");

      // The detail page can know a show's TMDB id while older history rows
      // carry only its TVDB id. A manual episode inserted with just the TMDB
      // id then forms a second same-title identity cluster; once that cluster
      // contains several episodes, the conservative show grouper keeps it
      // separate and the larger legacy cluster hides the user's new watch.
      // Bridge the two known series identities on the authoritative manual
      // row. Existing ids from the request are never replaced.
      if (normalized.record.media_type === "episode") {
        const showTitle = showTitleFrom(normalized.record.title);
        if (showTitle) {
          let canonicalIdentity = canonicalShowByTitle.get(showTitle);
          if (canonicalIdentity === undefined) {
            const [canonicalShow, knownIdentity] = await Promise.all([
              queryShowDetail({ title: showTitle }).catch(() => null),
              getKnownShowIdentityForTitle(showTitle).catch(() => null),
            ]);
            canonicalIdentity = {
              imdb_id: knownIdentity?.imdb_id || canonicalShow?.imdb_id || null,
              tmdb_id: knownIdentity?.tmdb_id || canonicalShow?.tmdb_id || null,
              tvdb_id: knownIdentity?.tvdb_id || canonicalShow?.tvdb_id || null,
            };
            canonicalShowByTitle.set(showTitle, canonicalIdentity);
          }
          if (canonicalIdentity) {
            pending = {
              ...pending,
              imdb_id: normalized.record.imdb_id || canonicalIdentity.imdb_id || undefined,
              tmdb_id: normalized.record.tmdb_id || canonicalIdentity.tmdb_id || undefined,
              tvdb_id: normalized.record.tvdb_id || canonicalIdentity.tvdb_id || undefined,
            };
            normalized = normalizeWatchRecordForInsert(pending, "manual");
          }
        }
      }

      const { data, record } = await inRowNumbering(normalized, pending, (next) => normalizeWatchRecordForInsert(next, "manual")); // show page display numbers -> stored numbering
      const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(record), data.watchedAt);
      const media = manualWatchMediaFromRecord({
        ...record,
        provider_items: rawRecord.provider_items || rawRecord.providerItems || {},
        provider_item_id: rawRecord.provider_item_id || rawRecord.providerItemId,
        // normalizeWatchRecordForInsert keeps only watch-history columns; read the intent off the request body.
        sync_intent: rawRecord.sync_intent || rawRecord.syncIntent,
      });

      const exactExistingWatched = existing?.sync_action === "watched";
      const resyncOnly = rawRecord.resync_only === true;
      // A row sent from an unwatched episode's "Mark watched" button is an
      // explicit new canonical transition even when its chosen release date
      // matches an older watch. The show-detail resolver can know that a later
      // unwatch wins while legacy playstate/history aliases disagree about
      // which exact row is current, so trying to infer intent here caused the
      // click to be mistaken for a duplicate. Only records explicitly tagged
      // by the client as resync-only may reuse an existing history row.
      let id = "";
      let storedRecord = existing || record;
      let insertedTransition = false;
      if (exactExistingWatched && resyncOnly) {
        id = existing.id;
        skipped += 1;
      } else {
        // Clear any prior row (e.g. an unwatched placeholder) at this slot before inserting
        // but retain an older watched row for an explicit watched transition.
        // Its new sibling records the transition order while same-event
        // display dedupe keeps the history UI tidy.
        const replaceExisting = existing && !exactExistingWatched;
        if (replaceExisting) await deleteWatchRecordById(existing.id, { skipInvalidate: true }).catch(() => null);
        const insertResult = await insertWatchRecord(record, {
          skipInvalidate: true,
          id: replaceExisting ? existing.id : "",
          watchlistConfig: config,
          // A show-level action can contain hundreds of episodes. The detail
          // page already has the show metadata, and fetching TMDB assets once
          // per inserted episode needlessly competes with the live sync and
          // makes the page appear stalled. Keep the eager enrichment for a
          // single-item action where it is useful.
          prefetch: records.length <= 1,
        });
        id = insertResult.id;
        storedRecord = insertResult.record;
        await insertResult.assetPrefetch?.catch(() => null);
        inserted += 1;
        insertedTransition = true;
      }

      // An explicit manual watch supersedes stale unwatched rows left under
      // any rematched provider-id alias. Resync-only records deliberately do
      // not rewrite history state.
      if (!resyncOnly) supersedeUnwatchedTransitionsForRecordSync({ ...storedRecord, id });

      media.watchRecordId = id;
      media.ids = {
        imdb: storedRecord.imdb_id || undefined,
        tmdb: storedRecord.tmdb_id || undefined,
        tvdb: storedRecord.tvdb_id || undefined,
      };
      await deletePlaybackProgress({
        ...media,
        media_key: rawRecord.media_key || rawRecord.mediaKey || data.mediaKey || undefined,
      }).catch(() => null);
      await setPlaystateForMediaIdentity(media, "watched", storedRecord.watched_at || record.watched_at, { skipInvalidate: true });
      syncTasks.push({ media, id, record: { ...storedRecord, id } });

      results.push({ index, id, title: record.title, inserted: insertedTransition, status: "pending", targetStates: [] });
    } catch (error) {
      rejected += 1;
      results.push({ index, rejected: true, error: error.message || String(error) });
    }
  }

  await invalidateHistoryDerivedCaches("handleManualWatch").catch(() => null);

  // Awaited rather than backgrounded: the UI shows a "Syncing..." state and
  // only flips a row to watched once this response comes back, so the client
  // needs the real per-target outcome, not just "a watch record was queued".
  let propagated = 0;
  let providerSummary = [];
  let providerOutcomes = [];
  if (syncTasks.length > 0) {
    // A show-level mark can contain dozens or hundreds of episodes. Trakt's
    // history endpoint accepts grouped season/episode payloads, so keep the
    // media-server fan-out concurrent but move the tracker phase to one
    // bounded batch. Single-item actions retain the normal per-item path.
    const batchTraktWatch = watchedPlayedSyncEnabled() && !isAuthoritativeRestoreActive()
      && syncTasks.length > 1
      && syncTasks.every(({ media }) => String(media?.type || media?.mediaType || "").toLowerCase() === "episode");
    const taskSummaries = new Array(syncTasks.length);
    // Every per-item target outcome, rolled up into one per-provider summary
    // for the response. A bulk mark-watched must be able to say "Plex: 12 sent,
    // 3 already matching, 40 skipped by policy" rather than a single generic
    // success that hides a deliberate policy skip.
    const providerTargetStates = [];
    const trackingReservation = reserveDispatchBatch(syncTasks.length, {
      progressKeys: syncTasks.map(({ media }) => dispatchProgressKey(media)),
    });
    try {
      await runWithConcurrency(syncTasks, async (task, index) => {
        try {
          markReservedDispatchStarted(trackingReservation, task.media);
          const summary = await syncMediaPlaystate(task.media, config, loopStore, {
            trackDispatch: false,
            lane: records.length === 1 ? "interactive" : "sync",
            includeTrackers: !batchTraktWatch,
          }).catch((error) => ({
            skipped: false,
            status: "error",
            details: `Manual watch propagation failed: ${error.message || String(error)}`,
            targetStates: [],
          }));

          if (batchTraktWatch) {
            taskSummaries[index] = summary;
            return;
          }

          providerTargetStates.push(...(summary.targetStates || []));
          if (summary.status === "success" || summary.status === "partial") propagated += 1;

          // Remote watched-state APIs can synchronously echo a temporary
          // unwatch while replacing their existing play (Trakt in
          // particular removes the old history entry before adding the new
          // one).  That echo is newer than the row inserted above and used
          // to win the next /api/show canonical-state read, so the UI said
          // success and immediately rendered "Mark watched" again.  Reassert
          // the explicit Plembfin decision only after every remote call has
          // settled: Plembfin is the authority, and transport side effects
          // must never overrule the user's click.
          const authoritativeRecord = reassertWatchRecordAuthoritySync(task.id) || task.record;
          supersedeUnwatchedTransitionsForRecordSync(authoritativeRecord);
          await setPlaystateForMediaIdentity(task.media, "watched", task.record.watched_at, { skipInvalidate: true });

          await updateWatchTelemetry(task.id, formatDispatchTelemetry(summary, task.media, "watched"), { skipInvalidate: true });
          await recordSyncHistory(task.media, summary, "watched");
        } catch (error) {
          console.error("Manual watch sync failed:", error);
          if (batchTraktWatch) {
            taskSummaries[index] = {
              skipped: false,
              status: "error",
              details: `Manual watch propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            };
          }
        } finally {
          if (!batchTraktWatch) completeDispatchTracking(trackingReservation, task.media);
        }
      }, MANUAL_SYNC_ITEM_CONCURRENCY);

      if (batchTraktWatch) {
        const trackerBatch = await dispatchTraktWatchStateBatch(
          syncTasks.map(({ media }) => media),
          "watched",
          { lane: "sync", canonicalReplay: true },
        ).catch((error) => ({
          results: syncTasks.map((task, index) => ({
            index,
            media: task.media,
            status: "failed",
            detail: error.message || String(error),
          })),
        }));

        for (const [index, task] of syncTasks.entries()) {
          const trackerResult = trackerBatch.results?.find((result) => result?.index === index) || null;
          const summary = mergeManualTrackerSummary(taskSummaries[index] || {
            skipped: false,
            status: "error",
            details: "Manual watch propagation did not return a result.",
            targetStates: [],
          }, trackerResult);
          providerTargetStates.push(...(summary.targetStates || []));
          if (summary.status === "success" || summary.status === "partial") propagated += 1;

          // Remote watched-state APIs can synchronously echo a temporary
          // unwatch while replacing their existing play. Reassert the
          // explicit Plembfin decision after the grouped tracker write has
          // settled; Plembfin remains the authority.
          const authoritativeRecord = reassertWatchRecordAuthoritySync(task.id) || task.record;
          supersedeUnwatchedTransitionsForRecordSync(authoritativeRecord);
          await setPlaystateForMediaIdentity(task.media, "watched", task.record.watched_at, { skipInvalidate: true });
          await updateWatchTelemetry(task.id, formatDispatchTelemetry(summary, task.media, "watched"), { skipInvalidate: true });
          await recordSyncHistory(task.media, summary, "watched");
          completeDispatchTracking(trackingReservation, task.media);
        }
      }
    } finally {
      finishDispatchTracking(trackingReservation);
    }
    providerSummary = formatProviderOutcomeSummary(providerTargetStates);
    providerOutcomes = summarizeProviderOutcomes(providerTargetStates);
    await invalidateHistoryDerivedCaches("handleManualWatch").catch(() => null);
  }

  return sendJson(res, { ok: true, inserted, skipped, rejected, propagated, syncQueued: syncTasks.length, providerSummary, providerOutcomes, results });
}

export async function handlePlaybackProgressList(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const rows = await listPlaybackProgressRowsForReplay({ limit, offset });
    const total = await countPlaybackProgressRows();

    const decoratedRows = await Promise.all(rows.map(async (row) => {
      const mediaKey = row.media_key;
      let posterUrl = null;
      try {
        const cached = await getPosterCache(mediaKey);
        if (cached && (cached.url || cached.cached)) {
          posterUrl = cached.url || "/favicon.svg";
        }
      } catch (err) {
        // ignore
      }

      // Playback-progress rows can be title-only episode identities. They do
      // not have the watched-row artwork enrichment used by the History API,
      // so resolve the parent show poster here as well. Keep poster_url tied
      // to the episode/progress row; the dashboard consumes show_poster_url
      // for this card so episode artwork remains independent elsewhere.
      if (row.media_type === "episode") {
        const showTitle = row.show_title || showTitleFrom(row.title);
        const knownIdentity = showTitle
          ? await getKnownShowIdentityForTitle(showTitle).catch(() => ({}))
          : {};
        // Prefer the row's own resolved ids over a title-only "known show for
        // this title" guess. Episodes are keyed on the show's ids, so
        // row.tmdb_id/tvdb_id/imdb_id already identify the correct show; a
        // title match can point at the wrong same-titled show (e.g. a reboot)
        // when a different provider's library has that title mismatched.
        const showIdentity = {
          media_type: "tv",
          title: showTitle,
          tmdb_id: row.show_tmdb_id || row.tmdb_id || knownIdentity.tmdb_id || "",
          tvdb_id: row.show_tvdb_id || row.tvdb_id || knownIdentity.tvdb_id || "",
          imdb_id: row.show_imdb_id || row.imdb_id || knownIdentity.imdb_id || "",
        };
        const showPosterUrl = getCanonicalPosterUrl(showIdentity);
        return {
          ...row,
          poster_url: posterUrl,
          show_title: showTitle || row.show_title || null,
          show_poster_url: showPosterUrl || null,
          show_tmdb_id: showIdentity.tmdb_id || null,
          show_tvdb_id: showIdentity.tvdb_id || null,
          show_imdb_id: showIdentity.imdb_id || null,
        };
      }

      return { ...row, poster_url: posterUrl };
    }));

    return sendJson(res, { progress: decoratedRows, total });
  } catch (error) {
    console.error("Failed to list playback progress", error);
    return sendJson(res, { error: "Failed to list playback progress" }, 500);
  }
}

export async function handlePlaybackProgressWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    if (!progressRow) return sendJson(res, { error: "Playback progress item not found" }, 404);

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const record = {
      title: progressRow.title,
      media_type: progressRow.media_type,
      source: "manual",
      imdb_id: body.imdb_id || body.imdbId || body.imdb || progressRow.imdb_id || null,
      tmdb_id: body.tmdb_id || body.tmdbId || body.tmdb || progressRow.tmdb_id || null,
      tvdb_id: body.tvdb_id || body.tvdbId || body.tvdb || progressRow.tvdb_id || null,
      season: progressRow.season ?? null,
      episode: progressRow.episode ?? null,
      watched_at: body.watched_at || Date.now(),
      sync_action: "watched",
      sync_dispatch_telemetry: "Origin: progress_resolve\nLoop-check: Passed\nDispatch status: pending\nDetails: Manual watch propagation queued.",
    };
    await enrichProgressWatchRecordWithTmdb(record, body);

    const { data, record: normalizedRecord } = normalizeWatchRecordForInsert(record, "manual");
    const existing = await findExistingWatch(data.mediaKey || mediaKeyFor(normalizedRecord), data.watchedAt);
    const media = manualWatchMediaFromRecord(normalizedRecord);
    const exactExistingWatched = existing?.sync_action === "watched";
    let id = "";
    if (exactExistingWatched) {
      id = existing.id;
    } else {
      if (existing) await deleteWatchRecordById(existing.id, { skipInvalidate: true }).catch(() => null);
      const insertResult = await insertWatchRecord(normalizedRecord, { skipInvalidate: true, id: existing?.id || "", watchlistConfig: config });
      id = insertResult.id;
      await insertResult.assetPrefetch?.catch(() => null);
      media.ids = {
        imdb: insertResult.record.imdb_id || undefined,
        tmdb: insertResult.record.tmdb_id || undefined,
        tvdb: insertResult.record.tvdb_id || undefined,
      };
    }

    media.watchRecordId = id;
    await upsertPlaystateForMedia(media, "watched", record.watched_at, { skipInvalidate: true });

    await deletePlaybackProgress({ ...progressRow, media_key: mediaKey }).catch(() => null);
    await deletePlaybackProgress(media).catch(() => null);

    const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Watch propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    try {
      await updateWatchTelemetry(id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
      await recordSyncHistory(media, summary, "watched");
    } catch (error) {
      console.error("Progress watch sync bookkeeping failed:", error);
    } finally {
      await invalidateHistoryDerivedCaches("handlePlaybackProgressWatch").catch(() => null);
    }

    return sendJson(res, {
      ok: true,
      id,
      propagated: summary.status === "success" || summary.status === "partial",
      status: summary.status,
      targetStates: summary.targetStates || [],
    });
  } catch (error) {
    console.error("Mark watch from progress failed", error);
    return sendJson(res, { error: "Mark watch from progress failed" }, 500);
  }
}

function requestProviderItems(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === "object" ? value : {};
}

export function mediaFromProgressRequest(progressRow, body = {}, mediaKey = "") {
  const mediaType = String(body.media_type || body.mediaType || progressRow?.media_type || "").toLowerCase() === "movie"
    ? "movie"
    : "episode";
  const title = String(body.title || progressRow?.title || body.show_title || body.showTitle || "").trim();
  const seasonValue = body.season ?? progressRow?.season;
  const episodeValue = body.episode ?? progressRow?.episode;
  // An episode's media ids are its show's ids (the Trakt payload nests the
  // season/episode under the show). Up Next cards carry the episode's own ids
  // in tmdb_id/imdb_id/tvdb_id, so when any show id is sent use only those;
  // mixing in an episode id would send Trakt a show it cannot find.
  const showIds = mediaType === "episode" && ["imdb", "tmdb", "tvdb"].some((key) => body[`show_${key}_id`])
    ? {
        imdb: body.show_imdb_id || undefined,
        tmdb: body.show_tmdb_id || undefined,
        tvdb: body.show_tvdb_id || undefined,
      }
    : null;
  return {
    title,
    showTitle: String(body.show_title || body.showTitle || progressRow?.show_title || "").trim() || undefined,
    type: mediaType,
    source: "manual",
    media_key: mediaKey || progressRow?.media_key || undefined,
    ids: showIds || {
      imdb: body.imdb_id || body.imdbId || body.imdb || progressRow?.imdb_id || undefined,
      tmdb: body.tmdb_id || body.tmdbId || body.tmdb || progressRow?.tmdb_id || undefined,
      tvdb: body.tvdb_id || body.tvdbId || body.tvdb || progressRow?.tvdb_id || undefined,
    },
    season: seasonValue == null || seasonValue === "" ? undefined : Number(seasonValue),
    episode: episodeValue == null || episodeValue === "" ? undefined : Number(episodeValue),
    providerItems: requestProviderItems(body.provider_items || body.providerItems),
    providerItemId: body.provider_item_id || body.providerItemId || undefined,
    positionMs: 0,
    offsetMs: 0,
    progress: 0,
    isValid: Boolean(title && ["movie", "episode"].includes(mediaType)),
  };
}

export async function handlePlaybackProgressUnwatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const mediaKey = String(body.media_key || "").trim();
  if (!mediaKey) return sendJson(res, { error: "media_key is required" }, 400);

  try {
    const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
    const media = mediaFromProgressRequest(progressRow, body, mediaKey);
    if (!media.isValid) return sendJson(res, { error: "A valid media item is required" }, 400);

    const config = await loadMediaConfig();
    const loopStore = createLoopStore();

    const { id: unwatchedId, summary } = await applyManualUnwatch(media, config, loopStore, "", { includeSourcePlatform: true, force: true, lane: "interactive" });
    // Clearing a resume point must also dismiss the native resume rail. The
    // unplayed transition above resets provider playback state, but Plex and
    // the other providers can retain the item in Continue Watching/Resume
    // until their separate rail-dismissal action is applied.
    const providerDismissals = await hideUpNextAcrossProviders(config, media, body, { lane: "interactive" });
    await import("../utils/upNextCache.js").then(({ refreshUpNextAfterMutation }) => refreshUpNextAfterMutation(config, "handlePlaybackProgressUnwatch"));
    return sendJson(res, {
      ok: true,
      id: unwatchedId,
      clearedResume: true,
      status: summary.status,
      queued: Boolean(summary.deferred),
      targetStates: summary.targetStates || [],
      providerDismissals,
    });
  } catch (error) {
    console.error("Playback progress unwatch failed", error);
    return sendJson(res, { error: "Playback progress unwatch failed" }, 500);
  }
}

function directUpNextProviderIds(body = {}, provider) {
  const raw = body.provider_items?.[provider] ?? body.providerItems?.[provider];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveUpNextProviderIds(provider, config, media, body, { lane = "sync" } = {}) {
  const direct = directUpNextProviderIds(body, provider);
  if (direct.length) return direct;
  const lookupMedia = { ...media, lane };
  if (provider === "plex") {
    const item = await findPlexItem(config.plex, lookupMedia);
    return item?.ratingKey ? [String(item.ratingKey)] : [];
  }
  if (provider !== "emby" && provider !== "jellyfin") return [];
  const items = await (provider === "emby" ? findEmbyItems : findJellyfinItems)(config[provider], lookupMedia);
  return [...new Set((items || []).map((item) => String(item?.Id || "").trim()).filter(Boolean))];
}

async function hideUpNextAcrossProviders(config, media, body, { lane = "sync" } = {}) {
  const definitions = [
    { provider: "plex", configured: Boolean(config.plex?.baseUrl && config.plex?.token), hide: (id) => hidePlexFromContinueWatching(config.plex, id, { lane }) },
    { provider: "emby", configured: Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId), hide: (id) => hideEmbyFromResume(config.emby, id, { lane }) },
    { provider: "jellyfin", configured: Boolean(config.jellyfin?.baseUrl && (config.jellyfin?.apiKey || config.jellyfin?.api_key || config.jellyfin?.token) && config.jellyfin?.userId), hide: (id) => hideJellyfinFromResume(config.jellyfin, id, { lane }) },
  ].filter((entry) => entry.configured);

  return Promise.all(definitions.map(async ({ provider, hide }) => {
    try {
      const ids = await resolveUpNextProviderIds(provider, config, media, body, { lane });
      if (!ids.length) return { target: provider, status: "not_found", details: "No matching provider item was found" };
      const results = await Promise.allSettled(ids.map((id) => hide(id)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) return { target: provider, status: "failed", details: failed.reason?.message || "Provider removal failed" };
      return { target: provider, status: "fulfilled", details: `Removed from ${provider === "plex" ? "Continue Watching" : "Resume"}` };
    } catch (error) {
      return { target: provider, status: "failed", details: error?.message || "Provider removal failed" };
    }
  }));
}

// Up Next removal combines Plembfin's canonical progress clear with Plex and
// Emby's native Continue Watching / Resume dismissal.
export async function handleUpNextRemove(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const mediaKey = String(body.media_key || body.id || "").trim();
  try {
    const config = await loadMediaConfig();
    const progressRow = mediaKey ? db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey) : null;
    const media = mediaFromProgressRequest(progressRow, body, mediaKey);
    if (!media.isValid) return sendJson(res, { error: "A valid media item is required" }, 400);
    const loopStore = createLoopStore();
    const interactiveMedia = { ...media, lane: "interactive" };
    const { id: unwatchedId, summary } = await applyManualUnwatch(
      interactiveMedia,
      config,
      loopStore,
      "",
      { includeSourcePlatform: true, force: true, lane: "interactive" },
    );
    // Marking an episode unplayed can recreate a native "next up" entry from
    // its watched predecessor. Hide it only after the canonical unwatch has
    // propagated, otherwise the unplayed transition immediately undoes the
    // provider dismissal.
    const providerDismissals = await hideUpNextAcrossProviders(config, interactiveMedia, body, { lane: "interactive" });
    // Record the dismissal after the unwatch and provider callbacks have
    // settled. Those callbacks can echo the old resume position; recording
    // earlier lets that echo look like a genuinely newer playback event and
    // briefly resurrect the card during the next projection.
    recordUpNextDismissal({ ...body, media_key: mediaKey || body.media_key });
    await import("../utils/upNextCache.js").then(({ refreshUpNextAfterMutation }) => refreshUpNextAfterMutation(config, "handleUpNextRemove"));
    return sendJson(res, {
      ok: true,
      id: unwatchedId,
      clearedResume: true,
      status: summary.status,
      queued: Boolean(summary.deferred),
      targetStates: summary.targetStates || [],
      providerDismissals,
    });
  } catch (error) {
    console.error("Up Next clear failed", error);
    return sendJson(res, { error: "Up Next clear failed" }, 500);
  }
}

// Push Plembfin's authoritative Up Next snapshot to every configured media
// server. The native target rails are Plex Continue Watching, Emby Continue
// Watching/Resume, and Jellyfin Next Up; each calculated rail is refreshed
// from a verified watched predecessor, while the managed provider playlist
// remains the exact writable mirror.
// Intentional provider removal is also handled by handleUpNextRemove after
// confirmation.
// Dismissed items that Plembfin still considers unwatched, so they can be put
// back into the queue. The stored snapshot is what the card looked like when
// it was removed; it is enough to render the list without a second lookup.
export async function handleUpNextDismissed(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    restoreUpNextDismissalsSupersededByUnwatch();
    // Older dismissal snapshots can be title-only and therefore have no
    // artwork or trusted provider id of their own. The cached TV library has
    // already resolved those shows from watch history, so use it as the same
    // source of truth as the main TV grid before falling back to direct
    // canonical-artwork lookup.
    const cachedShows = await getCachedShows();
    const showByTitle = new Map(cachedShows.map((show) => [
      showTitleFrom(show.title || "").toLowerCase(),
      show,
    ]));
    const items = listUpNextDismissals().map((dismissal) => {
      const snapshot = dismissal.snapshot && typeof dismissal.snapshot === "object"
        ? dismissal.snapshot
        : {};
      const showTitle = dismissal.show_title || snapshot.show_title || snapshot.showTitle || "";
      // Older dismissal snapshots were intentionally small and did not carry
      // artwork. Resolve the canonical show poster while projecting the list
      // so the dismissed-card view can use the same cached artwork as the
      // rest of the app without mutating the stored dismissal.
      const isEpisode = dismissal.media_type === "episode";
      const cachedShow = isEpisode
        ? showByTitle.get(showTitleFrom(showTitle).toLowerCase())
        : null;
      const showIdentity = {
        media_type: isEpisode ? "tv" : "movie",
        title: isEpisode ? showTitle : (snapshot.title || dismissal.title || ""),
        tmdb_id: isEpisode
          ? (snapshot.show_tmdb_id || snapshot.showTmdbId || cachedShow?.tmdb_id || "")
          : (snapshot.tmdb_id || snapshot.tmdbId || ""),
        tvdb_id: isEpisode
          ? (snapshot.show_tvdb_id || snapshot.showTvdbId || cachedShow?.tvdb_id || "")
          : (snapshot.tvdb_id || snapshot.tvdbId || ""),
        imdb_id: isEpisode
          ? (snapshot.show_imdb_id || snapshot.showImdbId || cachedShow?.imdb_id || "")
          : (snapshot.imdb_id || snapshot.imdbId || ""),
      };
      const poster = getCanonicalPosterUrl(showIdentity)
        || (isEpisode
          ? (cachedShow?.show_poster_url || cachedShow?.canonical_poster_url || cachedShow?.poster_url || "")
          : "");
      const item = {
        ...snapshot,
        ...(showTitle ? { show_title: showTitle } : {}),
        ...(poster && !snapshot.poster_url ? { poster_url: poster } : {}),
        ...(isEpisode && poster && !snapshot.show_poster_url ? {
          show_poster_url: poster,
          canonical_poster_url: poster,
        } : {}),
      };
      return {
        id: dismissal.id,
        media_key: dismissal.media_key,
        media_type: dismissal.media_type,
        title: dismissal.title,
        show_title: showTitle,
        episode_title: dismissal.episode_title,
        season: dismissal.season,
        episode: dismissal.episode,
        dismissed_at: dismissal.dismissed_at,
        item,
      };
    });
    return sendJson(res, { items });
  } catch (error) {
    console.error("Up Next dismissed listing failed", error);
    return sendJson(res, { error: "Up Next dismissed listing failed" }, 500);
  }
}

export async function handleUpNextRestore(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req).catch(() => ({}));
  try {
    const restored = body.all === true
      ? restoreAllUpNextDismissals()
      : (restoreUpNextDismissal(body.id) ? 1 : 0);
    return sendJson(res, { ok: true, restored });
  } catch (error) {
    console.error("Up Next restore failed", error);
    return sendJson(res, { error: "Up Next restore failed" }, 500);
  } finally {
    await invalidateHistoryDerivedCaches("handleUpNextRestore").catch(() => null);
  }
}

export async function handleUpNextSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  if (!Array.isArray(body.items)) return sendJson(res, { error: "Up Next items are required" }, 400);

  const desiredItems = body.items.slice(0, 100);
  let summary = null;
  try {
    const config = await loadMediaConfig();
    summary = await syncUpNextToProviders({
      desiredItems,
      config,
    });
    if (summary?.ok && !summary.disabled) {
      await import("../utils/upNextAutoSync.js")
        .then(({ configuredUpNextProviders, rememberUpNextSync, upNextSyncCompleted }) => {
          if (upNextSyncCompleted(configuredUpNextProviders(config), summary)) return rememberUpNextSync(desiredItems);
          return null;
        })
        .catch((error) => console.error(`[up-next] Failed to remember manual sync: ${error?.message || error}`));
    }
    return sendJson(res, summary);
  } catch (error) {
    console.error("Up Next provider sync failed", error);
    return sendJson(res, { error: "Up Next provider sync failed" }, 500);
  } finally {
    await invalidateHistoryDerivedCaches("handleUpNextSync", { skipUpNextAutoSync: true }).catch(() => null);
  }
}

export async function handleRetrySync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; retry sync is paused until it completes." }, 409);
  }

  const body = await readJson(req);
  const id = body.id;
  if (!id) return sendJson(res, { error: "Missing required field: id" }, 400);

  // An id can name a row that was superseded since the caller read it, so fall
  // back to the media key: either one supplied alongside the id, or the id
  // itself for callers that only hold a key.
  let record = await getWatchRecordById(id);
  if (!record && body.media_key) {
    record = await getWatchRecordByMediaKey(String(body.media_key));
  }
  if (!record) {
    record = await getWatchRecordByMediaKey(id);
  }
  if (!record) return sendJson(res, { error: "Watch record not found" }, 404);

  const config = await loadMediaConfig();
  const loopStore = createLoopStore();

  const media = mediaFromWatchRecord(record);

  const action = record.sync_action || "watched";
  let summary;
  try {
    if (action === "unwatched" || action === "unplayed") {
      summary = await syncMediaUnplayedPlaystate(media, config, loopStore, { lane: "interactive" });
    } else {
      summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" });
    }
  } catch (error) {
    console.error("Retry sync failed", error);
    summary = {
      skipped: false,
      status: "error",
      details: `Retry sync failed: ${error.message || String(error)}`,
      targetStates: [],
    };
  }

  // A manual retry resets the automatic backoff so the scheduled dispatcher
  // picks the record back up even after it exhausted its retry budget.
  await updateWatchSyncRetry(record.id, 0, 0, { skipInvalidate: true });
  await updateWatchTelemetry(record.id, formatDispatchTelemetry(summary, media, action));
  await recordSyncHistory(media, summary, action);

  return sendJson(res, { ok: true, status: summary.status, targetStates: summary.targetStates || [] });
}

// If nobody has requested Now Playing in a while, the underlying poller may be sitting
// on its slow idle interval (or waiting out a normal active-interval wait) with data
// that's a beat stale. Poking it here means the first request after a page opens - or a
// backgrounded tab becomes visible again - kicks off a fresh poll immediately instead of
// waiting for the poller's own timer; the response below still serves current cache data
// right away, so this never adds latency to the request itself.
let lastNowPlayingViewerAt = 0;
const NOW_PLAYING_VIEWER_GAP_MS = 20_000;

export async function handleNowPlaying(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const now = Date.now();
  if (now - lastNowPlayingViewerAt > NOW_PLAYING_VIEWER_GAP_MS) {
    pokeLiveSessionPoller();
  }
  lastNowPlayingViewerAt = now;

  const [cacheRows, activeRows, runtime] = await Promise.all([
    loadLiveTrackingCache({ includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
    loadRuntimeState(),
  ]);

  const withMediaKey = (session = {}) => {
    const mediaKey = session.media_key || session.mediaKey || mediaKeyFor(session);
    return { ...session, media_key: mediaKey, mediaKey };
  };

  const sessions = cacheRows
    .map(hydrateCachedSession)
    .filter((session) => !isUpNextSeedSession(session))
    .filter((session) => !session.completedAt && !isTerminalLiveSession(session))
    .map(withMediaKey);
  const merged = [...sessions];
  for (const active of activeRows) {
    if (isTerminalLiveSession(active)) continue;
    const isDuplicate = merged.some(
      (s) =>
        s.source === active.source &&
        s.title.toLowerCase().trim() === active.title.toLowerCase().trim() &&
        (s.season == null ? null : Number(s.season)) === (active.season == null ? null : Number(active.season)) &&
        (s.episode == null ? null : Number(s.episode)) === (active.episode == null ? null : Number(active.episode))
    );
    if (!isDuplicate) {
      merged.push(withMediaKey({
        sessionId: active.key,
        source: active.source,
        title: active.title,
        mediaType: active.mediaType,
        progress: active.progress,
        offsetMs: active.offsetMs || 0,
        durationMs: active.durationMs || 0,
        season: active.season,
        episode: active.episode,
        posterUrl: active.posterUrl,
        ids: active.ids,
        client: active.client,
        updatedAt: active.updatedAt,
        completedAt: null,
      }));
    }
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);

  return sendJson(res, merged, 200, runtime.nowPlayingRefresh ? { "X-Now-Playing-Refresh": String(runtime.nowPlayingRefresh) } : {});
}

export async function handleActiveSessions(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { sessions: await listActiveSessions() });
}

export async function handleCronSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; scheduled sync is paused until it completes." }, 409);
  }

  if (!workerAvailable()) return sendJson(res, { error: "No background worker is available." }, 503);
  const job = enqueueBackgroundJob("cron_sync", { forceCatchup: true });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("Cron Sync queued...\n");

  let closed = false;
  res.on("close", () => { closed = true; });
  let seen = 0;
  while (!closed) {
    const logs = getBackgroundJobLogs(job.id);
    for (const entry of logs.slice(seen)) res.write(`${entry.message}\n`);
    seen = logs.length;
    const current = getBackgroundJob(job.id);
    if (["succeeded", "failed", "cancelled"].includes(current?.status)) {
      if (!logs.some((entry) => entry.message.startsWith("RESULT:"))) {
        res.write(`RESULT: ${JSON.stringify(current.result || { success: false, error: current.error || current.status })}\n`);
      }
      res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return;
}

export async function handleCronSyncStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const runtime = await loadRuntimeState();
  return sendJson(res, {
    lastCron: runtime.lastCronExecution || null,
    lastResult: runtime.lastCronResult || null,
  }, 200, { "Cache-Control": "no-store" });
}

export async function handleForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);

  // GET: poll for current status and log lines stored in runtimeState
  if (req.method === "GET") {
    if (!(await requireAdmin(req, res))) return;
    const job = getLatestBackgroundJob("force_sync");
    if (job) {
      const runtime = await loadRuntimeState();
      return sendJson(res, {
        active: ["queued", "running"].includes(job.status),
        log: getBackgroundJobLogs(job.id).map((entry) => entry.message),
        result: job.result || (job.error ? { success: false, error: job.error } : null),
        startedAt: job.startedAt || job.requestedAt,
        jobId: job.id,
        status: job.status,
        workerAvailable: workerAvailable(),
        operation: activeSyncOperation(runtime),
      });
    }
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      active: runtime.forceSyncActive === true,
      log: Array.isArray(runtime.forceSyncLog) ? runtime.forceSyncLog : [],
      result: runtime.forceSyncResult || null,
      startedAt: runtime.forceSyncStartedAt || null,
      jobId: null,
      status: runtime.forceSyncActive === true ? "running" : "idle",
      workerAvailable: workerAvailable(),
      operation: activeSyncOperation(runtime),
    });
  }

  // POST: fire-and-forget â€” return 202 immediately, run in background
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Force Sync is paused until it completes." }, 409);
  }

  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const body = await readJson(req).catch(() => ({}));
  const planId = String(body.planId || "").trim();
  if (planId) {
    const plan = getSyncPlanSummary(planId);
    if (!plan) return sendJson(res, { ok: false, error: "Plan not found." }, 404);
    if (plan.status !== "confirmed") return sendJson(res, { ok: false, error: `Plan is ${plan.status}; confirm it before execution.` }, 409);
  }
  const runtime = await loadRuntimeState();
  const operation = activeSyncOperation(runtime);
  if (operation) {
    const operationLabel = operation.kind === SYNC_OPERATION_FORCE ? "another Force Sync" : `another sync operation (${operation.kind})`;
    return sendJson(res, {
      ok: false,
      error: `${operationLabel} is already active. Stop/reset it before starting Force Sync.`,
      operation,
    }, 409);
  }
  const existingJob = getLatestBackgroundJob("force_sync");
  if (["queued", "running"].includes(existingJob?.status)) {
    return sendJson(res, { ok: false, error: "Another force sync job is already running." }, 409);
  }
  let queuedJob;
  try {
    queuedJob = enqueueBackgroundJob("force_sync", planId ? { planId } : {});
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    throw error;
  }
  return sendJson(res, {
    ok: true,
    started: true,
    jobId: queuedJob.id,
    status: queuedJob.status,
    message: "Force Sync queued. Poll GET /api/force-sync for status.",
  }, 202);

}

// Force Sync preview lifecycle. Planning is a read-only background job; the
// durable plan record is intentionally separate from the ordinary force-sync
// job so polling a preview never exposes or mutates the execution lock.
export async function handleForceSyncPlan(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  const path = String(req.path || "");
  const match = path.match(/\/force-sync\/plan\/([^/]+)$/);
  const id = decodeURIComponent(match?.[1] || "");

  if (req.method === "GET" && id) {
    const plan = getSyncPlanSummary(id);
    if (!plan) return sendJson(res, { error: "Plan not found." }, 404);
    const page = getSyncPlanActionsPage(id, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      risk: req.query.risk,
    });
    return sendJson(res, { plan, actions: page }, 200, { "Cache-Control": "no-store" });
  }

  if (req.method === "POST" && id) {
    const result = confirmSyncPlan(id);
    return sendJson(res, result, result.ok ? 200 : 409);
  }

  if (req.method !== "POST" || id) return methodNotAllowed(res);
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Force Sync planning is paused until it completes." }, 409);
  }
  if (!workerAvailable()) return sendJson(res, { ok: false, error: "No background worker is available." }, 503);
  const body = await readJson(req).catch(() => ({}));
  try {
    const job = enqueueBackgroundJob("force_sync_plan", { scope: body.scope || {} });
    return sendJson(res, { ok: true, jobId: job.id, status: job.status, message: "Force Sync preview queued." }, 202);
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return sendJson(res, { ok: false, error: error.message }, 409);
    console.error("Force Sync preview enqueue failed", error);
    return sendApiError(res, error, { ok: false, error: "Force Sync preview failed" }, 500);
  }
}



export async function handleStopForceSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const job = getLatestBackgroundJob("force_sync");
  if (job && ["queued", "running"].includes(job.status)) {
    const updated = requestBackgroundJobCancellation(job.id);
    const runtime = await loadRuntimeState();
    const stale = job.status === "running"
      && Number(job.heartbeatAt || 0) > 0
      && Number(job.heartbeatAt) < Date.now() - BACKGROUND_JOB_STALE_MS;
    if (job.status === "running" && !stale && activeSyncOperation(runtime)?.kind === SYNC_OPERATION_FORCE) {
      await setRuntimeState({ forceSyncCancelRequested: true });
    }
    if (stale) {
      const cleared = await clearSyncOperation({
        kind: SYNC_OPERATION_FORCE,
        values: {
          forceSyncActive: false,
          forceSyncCancelRequested: true,
          forceSyncHeartbeat: Date.now(),
          forceSyncResult: { success: true, aborted: true, cancelled: true, reset: true, reason: "Stale Force Sync was stopped by an administrator." },
        },
      });
      const message = cleared.ok
        ? "Stale Force Sync cancelled and its operation lock was cleared."
        : "The stale Force Sync job was marked cancelled; no matching active lock was found.";
      await appendRuntimeLog("forceSyncLog", [`RESET: ${message}`]).catch(() => null);
      return sendJson(res, { ok: true, active: false, reset: true, jobId: job.id, message });
    }
    return sendJson(res, {
      ok: true,
      active: updated?.status === "running",
      reset: false,
      jobId: job.id,
      message: job.status === "queued" ? "Queued force sync cancelled." : "Cancellation request sent to the running force sync.",
    });
  }

  try {
    const runtime = await loadRuntimeState();
    const operation = activeSyncOperation(runtime);
    const action = forceSyncStopAction({
      workerRunning: false,
      runtimeActive: runtime.forceSyncActive === true || operation?.kind === SYNC_OPERATION_FORCE,
      cancelRequested: runtime.forceSyncCancelRequested === true,
    });

    if (action === "cancel") {
      if (operation?.kind === SYNC_OPERATION_FORCE || runtime.forceSyncActive === true) {
        await setRuntimeState({ forceSyncCancelRequested: true });
      }
      return sendJson(res, { ok: true, active: true, reset: false, message: "Cancellation request sent to the running force sync." });
    }

    const reset = action === "reset";
    const message = reset
      ? "Orphaned force-sync lock cleared. Recent-item repair can run now."
      : "No force sync was active. The sync lock is already clear.";

    if (reset) {
      await appendRuntimeLog("forceSyncLog", [`RESET: ${message}`]).catch(() => null);
      await clearSyncOperation({
        kind: SYNC_OPERATION_FORCE,
        values: {
          forceSyncActive: false,
          forceSyncCancelRequested: false,
          forceSyncHeartbeat: Date.now(),
          forceSyncResult: { success: true, aborted: true, reset: true, reason: message },
        },
      });
    }
    return sendJson(res, { ok: true, active: false, reset, message });
  } catch (error) {
    console.error("Force sync stop failed", error);
    return sendJson(res, { ok: false, error: "Force sync stop failed" }, 500);
  }
}




export async function handleWebhook(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  // The header was named for Plembfin before the rename; webhooks set up then still send it.
  const headerToken = String(req.get("x-plekt-webhook-secret") || "").trim();
  const legacyHeaderToken = String(req.get("x-plembfin-webhook-secret") || "").trim();
  const authToken = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const queryToken = String(req.query?.token || "").trim();
  if (![headerToken, legacyHeaderToken, authToken, queryToken].some((token) => verifyWebhookToken(token))) {
    return sendJson(res, { error: "Unauthorized" }, 401);
  }
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, {
      ok: true,
      inserted: false,
      skipped: true,
      reason: "Authoritative watch-history restore is active; inbound watch events are paused until it completes.",
    }, 202);
  }

  let media;
  try {
    media = await normalizeWebhook(req);
    console.log("Webhook received", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      type: media.type,
      isValid: media.isValid,
      ids: media.ids,
    });
  } catch (error) {
    console.error("Webhook body parsing failed", error);
    return sendJson(res, { error: "Invalid webhook body", details: error.message }, 400);
  }

  const config = await loadMediaConfig();

  // An episode payload can carry the episode's own provider ids rather than the
  // series', which would key this record to something the rest of the app never
  // joins to - no artwork, no metadata, and no match against the other watches
  // of the same show. This has to run before the first mediaKeyFor() below, so
  // the audit trail and the stored record agree on one identity.
  // See utils/seriesIdentity.js.
  media = await withSeriesIdentity(media, config);

  recordWatchAuditEvent({
    eventType: "source_event",
    timestamp: Date.now(),
    action: media.phase === "unplayed" ? "unwatched" : media.phase,
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType,
    title: media.title,
    source: media.source,
    sourceEvent: media.event,
    phase: media.phase,
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids,
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId,
    user: media.user,
    device: media.device,
    deviceId: media.deviceId,
    client: media.client,
    clientVersion: media.clientVersion,
    status: media.isValid ? "received" : "ignored",
    details: media.isValid
      ? `Received ${media.event || "source event"} from ${media.source || "unknown source"}.`
      : `Received source event but did not process it: ${media.phase === "ignored" ? "unsupported event" : "missing required media fields"}.`,
    payload: auditSourceEventPayload({
      rawPayloadDebug: media.rawPayloadDebug || null,
      watchProvenance: media.watchProvenance || media.watch_provenance || null,
      request: {
        userAgent: req.get("user-agent") || "",
        remoteAddress: req.ip || req.socket?.remoteAddress || "",
      },
    }, media.isValid),
  });

  await setRuntimeState({
    lastWebhookReceived: {
      timestamp: Date.now(),
      source: media.source || "unknown",
      title: media.title || "unknown",
      event: media.event || "unknown",
      phase: media.phase || "unknown",
      isValid: Boolean(media.isValid),
    },
  }).catch(() => null);

  if (!media.isValid) {
    console.log("Webhook skipped: invalid media", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      reason: media.phase === "ignored" ? "unsupported event" : "missing required media fields",
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: `Webhook ignored: ${media.phase === "ignored" ? "unsupported event" : "missing required media fields"}`,
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, {
      ok: true,
      inserted: false,
      skipped: true,
      reason: "Unsupported event or missing provider IDs",
    });
  }

  // While an authoritative restore is pushing fresh state to the apps, ignore inbound
  // webhooks â€” they are the apps echoing our own marks back and would re-record as
  // watched-today. Real user plays resume the moment the restore job finishes.
  const restoreRuntime = await loadRuntimeState();
  const activeOperation = activeSyncOperation(restoreRuntime);
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    console.log("Webhook ignored: sync operation in progress (suppressing app echo)", {
      source: media.source,
      title: media.title,
      phase: media.phase,
      operation: activeOperation.kind,
    });
    await recordSyncHistory(media, {
      status: "skipped",
      details: `Webhook ignored: ${activeOperation.kind} in progress`,
      targetStates: [],
    }, media.phase || "webhook").catch(() => null);
    return sendJson(res, { ok: true, inserted: false, skipped: true, reason: "Sync operation in progress" });
  }

  const loopStore = createLoopStore();
  media.posterUrl = posterPathFromMedia(media);

  if (config) {
    if (config[media.source]?.disabled) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because source platform is disabled",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "Source platform is disabled" });
    }
    if (media.source === "plex" && shouldIgnoreWebhookUser(media.user, config.plex?.username, { strictName: true })) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Plex user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "emby" && shouldIgnoreWebhookUser(media.user, config.emby?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Emby user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
    if (media.source === "jellyfin" && shouldIgnoreWebhookUser(media.user, config.jellyfin?.userId)) {
      await recordSyncHistory(media, {
        status: "skipped",
        details: "Webhook ignored because Jellyfin user did not match configured user",
        targetStates: [],
      }, media.phase || "webhook").catch(() => null);
      return sendJson(res, { ok: true, ignored: true, reason: "User mismatch" });
    }
  }

  if (isSyntheticUpNextWebhook(media)) {
    console.log("Webhook: ignored synthetic Up Next rail seed playback", {
      source: media.source,
      title: media.title,
      event: media.event,
      phase: media.phase,
      deviceId: media.deviceId,
    });
    await deleteActiveSession(media).catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, {
      ok: true,
      active: false,
      inserted: false,
      propagated: false,
      skipped: true,
      reason: "Legacy Up Next rail seed playback is synthetic, not user playback",
    });
  }

  // A Next Up promotion updates only the predecessor's LastPlayedDate so
  // Jellyfin can sort the series. Jellyfin emits the same UserDataSaved/
  // played-flag callback for that write as it does for a real Mark played
  // action. It is ordering metadata, not a watch, so consume the callback
  // before the normal canonical replay path gets a chance to run.
  if (
    media.source === "jellyfin"
    && media.playedFlagOnly === true
    && await isRecentOutboundJellyfinNextUpNudge(media, loopStore).catch(() => false)
  ) {
    console.log("Webhook: ignored Jellyfin Next Up ordering nudge", {
      title: media.title,
      event: media.event,
      itemId: media.itemId,
    });
    await deletePlaybackProgress(media).catch(() => null);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, {
      ok: true,
      inserted: false,
      propagated: false,
      skipped: true,
      reason: "Jellyfin Next Up ordering nudge, not a watch",
    });
  }

  // The native rail refresh's unplayed/played toggle of a watched predecessor
  // echoes back as flag events. Consume them before any canonical lookup: the
  // generic unplayed-echo check defers to the playstate row it resolves, which
  // can be an older series-keyed unwatch while the watch sits under other ids,
  // and the echo then deleted real watch history (defect AG).
  if (
    ["emby", "jellyfin"].includes(String(media.source || "").toLowerCase())
    && (media.phase === "unplayed" || media.playedFlagOnly === true)
    && await isRecentOutboundRailRefresh(media, media.source, loopStore).catch(() => false)
  ) {
    console.log("Webhook: ignored native Up Next rail refresh callback", {
      source: media.source,
      title: media.title,
      event: media.event,
      phase: media.phase,
      itemId: media.itemId,
    });
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, {
      ok: true,
      inserted: false,
      propagated: false,
      skipped: true,
      reason: "Native Up Next rail refresh callback, not a user action",
    });
  }

  const embyLikeUserDataState = (
    ["emby", "jellyfin"].includes(String(media.source || "").toLowerCase())
    && ["ended", "unplayed"].includes(media.phase)
    && media.playedFlagOnly === true
  );
  if (
    embyLikeUserDataState
  ) {
    // An outbound progress acknowledgement can arrive after a completed
    // webhook has already made the item watched. Suppress that known echo
    // before consulting the newer canonical state, or the stale Played=false
    // payload would be reinterpreted as a fresh watched -> unwatched action.
    const ownProgressEcho = await isRecentOutboundProgressEcho(media, media.source, loopStore).catch(() => false);
    if (ownProgressEcho) {
      console.log("Webhook: skipped callback caused by outbound resume update", {
        source: media.source,
        title: media.title,
        event: media.event,
        phase: media.phase,
      });
      await deleteActiveSession(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Callback followed Plekt outbound resume update",
      });
    }
  }

  if (embyLikeUserDataState && media.phase === "ended") {
    const currentPlaystate = await getPlaystateForMedia(media).catch(() => null);
    media.phase = resumeWebhookPhaseForPlaystate(media, currentPlaystate);
  }

  if (media.phase === "unplayed") {
    let ownUnplayedEcho = await isRecentOutboundUnplayedFlagEcho(media, media.source, loopStore).catch(() => false);
    if (ownUnplayedEcho) {
      // If Plembfin still considers the item watched, this is our outbound
      // unwatch acknowledgement and can be ignored. Once the local state is
      // already unwatched (or only a review is pending), let the provider
      // transition through so a real user action is not swallowed by an old
      // marker left by a previous sync.
      const currentPlaystate = await getPlaystateForMedia(media).catch(() => null);
      if (currentPlaystate?.state !== "watched") ownUnplayedEcho = false;
    }
    if (ownUnplayedEcho) {
      console.log("Webhook: skipped outbound unplayed echo", {
        source: media.source,
        title: media.title,
        event: media.event,
      });
      await deleteActiveSession(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Unplayed callback followed Plekt outbound mark",
      });
    }
    if (!ownUnplayedEcho) {
      await clearOutboundPlayedMarks(media, media.source, loopStore).catch(() => null);
    }
  }

  // A server announcing new content is the moment a watch Plembfin already
  // holds can finally be applied there. Until the file exists, an outbound sync
  // has nothing to mark; this catches the item up without waiting for a manual
  // Force Sync. It never creates history - only an existing watched record is
  // ever applied, and only to the server that just added the item.
  //
  // This runs ahead of the season/series branch below on purpose. That branch
  // reads any non-`unplayed` phase as a play event and would file watches for
  // every episode of a newly added show.
  if (media.phase === "added") {
    const isMovie = media.type === "movie";
    const isEpisode = media.type === "episode";
    // Season notifications often carry a season-level id and a label such as
    // "Season 1", neither of which is a safe show identity. Episode/series
    // notifications and movies have enough context; the scheduler/provider
    // backstop will discover a season-only event later.
    if (isMovie || isEpisode || media.type === "series") {
      try {
        queueTmdbMetadataWarmup([{
          mediaType: isMovie ? "movie" : "tv",
          // Episode notifications can carry an episode-level TMDB id. Let the
          // TVDB/show identity resolve the parent series instead of trusting that
          // leaf id as a series cache key.
          tmdbId: isMovie ? media.ids?.tmdb || "" : media.type === "series" ? media.ids?.tmdb || "" : "",
          title: isEpisode ? showTitleFrom(media.title) : media.title,
          ids: {
            imdbId: media.ids?.imdb || "",
            tvdbId: media.ids?.tvdb || "",
          },
          verifyTvdbTitle: !isMovie,
        }], { reason: "library-added-webhook" });
      } catch (error) {
        // Metadata is an enrichment side effect. Do not reject a valid library
        // webhook or skip its watched-state handling when the cache is busy.
        console.warn(`Library-added metadata warm-up queue failed: ${error?.message || error}`);
      }
    }
    const applied = await applyWatchedStateToNewItem(media, config).catch((error) => {
      console.error("New-item watched-state apply failed", error);
      return { applied: false, reason: error.message || "apply failed" };
    });
    return sendJson(res, { ok: true, added: true, inserted: false, ...applied });
  }

  if (media.type === "season" || media.type === "series") {
    console.log(`Processing ${media.type} webhook sync from ${media.source}`, {
      title: media.title,
      itemId: media.itemId,
      phase: media.phase,
    });

    let episodes = [];
    try {
      if (media.source === "jellyfin") {
        const { fetchJellyfinEpisodes, fetchJellyfinEpisodesForSeries } = await import("../utils/jellyfinClient.js");
        episodes = media.type === "series"
          ? await fetchJellyfinEpisodesForSeries(config.jellyfin, media.itemId)
          : await fetchJellyfinEpisodes(config.jellyfin, media.itemId);
      } else if (media.source === "emby") {
        const { fetchEmbyEpisodes } = await import("../utils/embyClient.js");
        episodes = await fetchEmbyEpisodes(config.emby, media.itemId);
      }
    } catch (error) {
      console.error("Failed to fetch child episodes for %s %s", media.type, media.itemId, error);
      return sendJson(res, { error: `Failed to fetch episodes for ${media.type}` }, 500);
    }

    console.log("Found %d episodes under %s %s", episodes.length, media.type, media.itemId);

    const results = [];
    const targetPlayed = media.phase === "completed";
    const flagImportMode = targetPlayed && media.playedFlagOnly ? watchImportMode() : "";
    const flagTimingHistory = flagImportMode === "episode_timing"
      ? await getCachedHistory().catch(() => [])
      : [];

    const filteredEpisodes = episodes.filter((ep) => {
      const isPlayed = ep.UserData?.Played === true;
      return targetPlayed ? isPlayed : !isPlayed;
    });

    console.log(`Syncing ${filteredEpisodes.length} episodes with target played state: ${targetPlayed}`);

    await Promise.all(
      filteredEpisodes.map(async (ep) => {
        try {
          const episodeMedia = {
            title: `${ep.SeriesName || media.title || "Unknown Show"} - S${String(ep.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(ep.IndexNumber ?? "?").padStart(2, "0")}`,
            type: "episode",
            source: media.source,
            ids: normalizeProviderIds(ep.ProviderIds),
            season: ep.ParentIndexNumber,
            episode: ep.IndexNumber,
            event: media.event,
            phase: media.phase,
            user: media.user,
            watchProvenance: media.watchProvenance || media.watch_provenance
              ? { ...(media.watchProvenance || media.watch_provenance), item_id: ep.Id || (media.watchProvenance || media.watch_provenance).item_id }
              : null,
            playedFlagOnly: Boolean(media.playedFlagOnly),
            releaseDate: media.playedFlagOnly ? releaseDateForItem(ep) : "",
            runtimeMinutes: runtimeMinutesForSourceItem(ep, media.source),
            isValid: true,
          };
          episodeMedia.posterUrl = posterPathFromMedia(episodeMedia);

          const flagDateChoice = episodeMedia.playedFlagOnly
            ? resolveWatchImportDate({
              mode: flagImportMode,
              manualMark: true,
              releaseDate: episodeMedia.releaseDate,
              media: episodeMedia,
              historyRows: flagTimingHistory,
            })
            : null;
          if (flagDateChoice) {
            episodeMedia.watched_at = flagDateChoice.previewWatchedAt;
            const existingProvenance = episodeMedia.watchProvenance || {};
            episodeMedia.watchProvenance = buildWatchProvenance(
              { ...episodeMedia, playedAt: "" },
              {
                ingestPath: existingProvenance.ingest_path || `${media.source || "source"}_webhook`,
                sourceTimestamp: "",
                note: [existingProvenance.note, `Import policy: ${flagDateChoice.reason}.`].filter(Boolean).join(" "),
              },
            );
          }

          if (media.phase === "unplayed") {
            await deleteActiveSession(episodeMedia).catch(() => null);
            const result = await applyManualUnwatch(episodeMedia, config, loopStore);
            results.push({
              episodeId: ep.Id,
              title: episodeMedia.title,
              success: result.alreadyUnwatched || result.summary.status === "success" || result.summary.status === "partial",
              skipped: Boolean(result.alreadyUnwatched),
            });
          } else {
            await deleteActiveSession(episodeMedia).catch(() => null);
            const existingPlaystate = await getPlaystateForMedia(episodeMedia).catch(() => null);
            if (
              episodeMedia.playedFlagOnly
              && existingPlaystate?.state === "unwatched"
              && !isExplicitPlayedFlagEvent(media)
            ) {
              // A season/series UserData callback carries no playback
              // evidence. Keep it out of canonical state, but surface it for
              // the same manual decision as an item-level provider callback.
              if (flagDateChoice?.requiresReview) {
                const queued = enqueueManualWatchReview(episodeMedia, {
                  releaseDate: episodeMedia.releaseDate,
                  observedWatchedAt: "",
                  sourceFingerprint: webhookWatchFingerprint(episodeMedia, episodeMedia.releaseDate),
                  reason: "The app reported a watched flag for this episode while Plekt is unwatched.",
                  allowWhenUnwatched: true,
                });
                await deletePlaybackProgress(episodeMedia).catch(() => null);
                results.push({
                  episodeId: ep.Id,
                  title: episodeMedia.title,
                  success: true,
                  skipped: true,
                  queued: Boolean(queued.queued),
                  reason: "Manual watch review required",
                });
                return;
              }
              results.push({
                episodeId: ep.Id,
                title: episodeMedia.title,
                success: true,
                skipped: true,
                reason: "Played flag ignored because Plekt is unwatched",
              });
              return;
            }
            if (existingPlaystate?.state === "watched") {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Already marked watched" });
              return;
            }
            // getPlaystateForMedia can still miss an already-recorded watch
            // stored under a media_key from a different source - see the
            // matching comment on the main webhook handler above.
            const existingByAnyKey = existingPlaystate?.state === "unwatched"
              ? null
              : await findWatchedByAnyMediaKey(episodeMedia).catch(() => null);
            if (existingByAnyKey) {
              await upsertPlaystateForMedia(episodeMedia, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Already recorded under a different media key" });
              return;
            }
            if (await shouldSkipPostRestoreCompletedWebhook(episodeMedia)) {
              results.push({ episodeId: ep.Id, title: episodeMedia.title, success: true, skipped: true, reason: "Post-restore completed webhook without active playback evidence" });
              return;
            }
            if (flagDateChoice?.requiresReview) {
              const queued = enqueueManualWatchReview(episodeMedia, {
                releaseDate: episodeMedia.releaseDate,
                observedWatchedAt: "",
                sourceFingerprint: webhookWatchFingerprint(episodeMedia, episodeMedia.releaseDate),
                reason: "The app reported a watched flag for this episode without playback evidence.",
              });
              await deletePlaybackProgress(episodeMedia).catch(() => null);
              results.push({
                episodeId: ep.Id,
                title: episodeMedia.title,
                success: true,
                skipped: true,
                queued: Boolean(queued.queued),
                reason: "Manual watch review required",
              });
              return;
            }
            const watchRecord = mediaToWatchRecord(episodeMedia, episodeMedia.source);
            watchRecord.sync_action = "watched";
            watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, episodeMedia, "watched");
            const dbResult = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
            await upsertPlaystateForMedia(episodeMedia, "watched", dbResult.record.watched_at, { skipInvalidate: true });
            const summary = await syncMediaPlaystate(episodeMedia, config, loopStore).catch((error) => ({
              skipped: false,
              status: "error",
              details: `Propagation failed: ${error.message || String(error)}`,
              targetStates: [],
            }));
            await updateWatchTelemetry(dbResult.id, formatDispatchTelemetry(summary, episodeMedia, "watched"), { skipInvalidate: true });
            await recordSyncHistory(episodeMedia, summary, "watched");
            await deletePlaybackProgress(episodeMedia).catch(() => null);
            await dbResult.assetPrefetch?.catch(() => null);
            results.push({ episodeId: ep.Id, title: episodeMedia.title, success: summary.status === "success" || summary.status === "partial" });
          }
        } catch (err) {
          console.error(`Failed to sync episode ${ep.Id} / ${ep.Name}`, err);
          results.push({ episodeId: ep.Id, success: false, error: err.message });
        }
      })
    );

    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);

    return sendJson(res, {
      ok: true,
      batch: true,
      total: filteredEpisodes.length,
      results,
    });
  }

  if (media.phase === "active") {
    await upsertActiveSession(media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    return sendJson(res, { ok: true, active: true, inserted: false, propagated: false, title: media.title, source: media.source });
  }

  if (media.phase === "ended") {
    recordPlaybackEndedAudit(media, {
      status: "stopped",
      details: "Playback ended before the watched threshold; resume progress was retained when available.",
    });
    await deleteActiveSession(media);
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    let progressSummary = { skipped: true, status: "skipped", details: "Resume progress is not actionable", targetStates: [] };
    // A provider callback echoing back the position Plembfin wrote to place
    // this item on a Continue Watching rail is not a play. It sits above the
    // resume threshold by design, so only the seed ledger can reject it.
    if (mediaIsUpNextRailSeed(media)) {
      progressSummary = {
        skipped: true,
        status: "skipped",
        details: "Resume progress matched an Up Next rail seed rather than real playback",
        targetStates: [],
      };
    } else if (shouldSyncResumeProgress(media)) {
      const [existingPlaystate, existingProgress] = await Promise.all([
        getPlaystateForMedia(media).catch(() => null),
        getPlaybackProgressForMedia(media).catch(() => null),
      ]);
      const incomingUpdatedAt = resumeProgressEventTimestamp(media, Date.now());
      const progressUpdatedAt = resumeProgressAuthorityTimestamp(existingProgress, {
        ...media,
        updatedAt: incomingUpdatedAt,
      });
      const playstateBlockReason = resumeProgressBlockedByPlaystate(existingPlaystate, progressUpdatedAt);
      const unchangedWithoutTimestamp = Boolean(
        existingProgress
        && incomingUpdatedAt <= 0
        && resumePositionUnchanged(existingProgress, media),
      );
      const staleDatedCandidate = Boolean(
        existingProgress
        && incomingUpdatedAt > 0
        && Number(existingProgress.updated_at || 0) >= incomingUpdatedAt,
      );
      const missingAuthority = incomingUpdatedAt <= 0;

      if (playstateBlockReason) {
        if (playstateBlocksStoredResumeProgress(existingPlaystate, existingProgress)) {
          await deletePlaybackProgress(media).catch(() => null);
        }
        progressSummary = {
          skipped: true,
          status: "skipped",
          details: `Resume progress ignored because ${playstateBlockReason}`,
          targetStates: [],
        };
      } else if (unchangedWithoutTimestamp || staleDatedCandidate || missingAuthority) {
        progressSummary = {
          skipped: true,
          status: "skipped",
          details: unchangedWithoutTimestamp
            ? "Resume progress acknowledgement was unchanged and had no source timestamp"
            : staleDatedCandidate
              ? "Resume progress acknowledgement was older than Plekt's stored position"
              : "Resume progress callback had no authoritative source timestamp",
          targetStates: [],
        };
      } else {
        // Use one authority timestamp for persistence and every outbound write.
        // Direct stop events without a source date use their receipt time;
        // delayed generic UserData callbacks never receive fresh authority.
        media.updatedAt = progressUpdatedAt;
        const progressRecord = mediaToPlaybackProgressRecord(media, media.source);
        await upsertPlaybackProgress({
          ...progressRecord,
          sync_dispatch_telemetry: formatProgressTelemetry({ skipped: false, status: "pending", details: "Resume propagation queued", targetStates: [] }, media),
        }).catch((error) => console.error("Failed to store resume progress", error));
        progressSummary = await syncMediaProgress(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Resume propagation failed: ${error.message || String(error)}`,
          targetStates: [],
        }));
        await updatePlaybackProgressTelemetry(progressRecord, formatProgressTelemetry(progressSummary, media)).catch(() => null);
        await recordSyncHistory(media, progressSummary, "progress");
      }
    }
    return sendJson(res, {
      ok: true,
      active: false,
      inserted: false,
      propagated: progressSummary.status === "success" || progressSummary.status === "partial",
      reason: "Playback ended below watched threshold",
      resumeProgress: { status: progressSummary.status, details: progressSummary.details },
    });
  }

  if (media.phase === "unplayed") {
    try {
      console.log("Webhook: marking as unwatched", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await deleteActiveSession(media);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      const { wasDeleted, id, alreadyUnwatched } = await applyManualUnwatch(media, config, loopStore);
      console.log("Webhook: unwatched sync completed", {
        source: media.source,
        title: media.title,
        wasDeleted,
        alreadyUnwatched: Boolean(alreadyUnwatched),
        id,
      });
      if (alreadyUnwatched) {
        return sendJson(res, { ok: true, deleted: false, unplayed: true, inserted: false, id, reason: "Already unwatched; no change to propagate" });
      }
      return sendJson(res, { ok: true, deleted: wasDeleted, unplayed: true, inserted: true, id, ...(wasDeleted ? {} : { reason: "No previous watched record found to delete" }) });
    } finally {
      await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
    }
  }

  try {
    console.log("Webhook: marking as watched", {
      source: media.source,
      title: media.title,
      type: media.type,
      progress: media.progress,
      positionMs: media.positionMs,
    });
    await deleteActiveSession(media);

    // Re-adding a library item causes Plembfin to mark it watched from its
    // existing history. Jellyfin then emits a played-flag webhook for that
    // write. The item may have no provider IDs and its LastPlayedDate may be
    // stale, so the normal playstate lookup is not sufficient to identify the
    // callback as our own outbound action.
    if (["plex", "emby", "jellyfin"].includes(String(media.source || "").toLowerCase())) {
      const source = String(media.source || "").toLowerCase();
      // Plex reports Plembfin's own mark-played API call as a completed
      // scrobble rather than a flag-only event. Detect that persisted outbound
      // marker before inserting history; the downstream loop detector is too
      // late because the deleted provider date has already been recreated by
      // then. Emby/Jellyfin retain the stricter flag-only check so genuine
      // completed playback remains a rewatch.
      const echoCheck = source === "plex" ? isRecentOutboundPlayedEcho : isRecentOutboundPlayedFlagEcho;
      const ownPlayedEcho = await echoCheck(media, media.source, loopStore).catch(() => false);
      if (ownPlayedEcho) {
        // A provider callback caused by Plembfin's own watched write is an
        // acknowledgement, even when the local item is still watched. Do not
        // enter the canonical-repair branch: that branch writes to every
        // provider and can turn one callback into an endless fan-out loop.
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Played flag callback followed Plekt outbound mark",
        });
      }
    }

    // A played-flag event says that the source's watched bit changed, not that
    // playback crossed the configured threshold. Servers commonly update
    // LastPlayedDate to the moment of a manual "Mark watched" click, so that
    // value must not become the historical watch date. Apply the configured
    // watch-import policy here, just as the scheduled scanner does.
    if (media.playedFlagOnly) {
      const { mode, dateChoice } = await resolveWebhookFlagWatchDate(media);
      media.watched_at = dateChoice.previewWatchedAt;
      const existingProvenance = media.watchProvenance || media.watch_provenance || {};
      media.watchProvenance = buildWatchProvenance(
        { ...media, playedAt: "" },
        {
          ingestPath: existingProvenance.ingest_path || `${media.source || "source"}_webhook`,
          sourceTimestamp: "",
          note: [
            existingProvenance.note,
            `Import policy: ${dateChoice.reason}.`,
          ].filter(Boolean).join(" "),
        },
      );

      // An explicit provider "Mark played" event is a new user decision even
      // when the same item has a local delete tombstone. The tombstone still
      // protects us from stale UserData/library echoes; the outbound-echo
      // guard above protects this explicit path from Plembfin's own mark.
      if (isDeletedWatchSuppressed(media, media.watched_at) && !isExplicitPlayedFlagEvent(media)) {
        console.log("Webhook: skipped a provider watch date explicitly deleted in Plekt", {
          source: media.source,
          title: media.title,
          event: media.event,
          itemId: media.itemId,
          watchedAt: media.watched_at,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Provider watch date was explicitly deleted in Plekt",
        });
      }

      // A viewstate/played-flag notification contains no playback evidence.
      // If Plembfin already has any watched history for this real item, the
      // notification is only acknowledging a played bit (often our own
      // canonical replay after the user deleted a newer provider date). The
      // ordinary recent-record check below intentionally looks at a one-hour
      // watch window and therefore cannot catch an older retained watch date.
      // Use the full identity-aware history lookup before persistence so the
      // removed provider date cannot be recreated from its release date.
      const existingWatchedHistory = await findWatchedByAnyMediaKey(media).catch(() => null);
      const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
      const existingCanonicalState = existingPlaystate?.state
        || (existingWatchedHistory ? "watched" : null);
      if (existingCanonicalState === "unwatched" && !isExplicitPlayedFlagEvent(media)) {
        // Generic UserData/played-flag callbacks do not contain playback
        // evidence, so they must never be accepted directly. Surface them for
        // a user decision instead: a real provider-side mark belongs in Manual
        // Watch review, while a stale acknowledgement can be dismissed there.
        if (dateChoice.requiresReview) {
          const queued = enqueueManualWatchReview(media, {
            releaseDate: media.releaseDate,
            observedWatchedAt: "",
            sourceFingerprint: webhookWatchFingerprint(media, media.releaseDate),
            reason: existingProvenance.note || `${media.source || "The app"} reported a watched flag without playback evidence while Plekt is unwatched.`,
            allowWhenUnwatched: true,
          });
          await deletePlaybackProgress(media).catch(() => null);
          await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
          return sendJson(res, {
            ok: true,
            inserted: false,
            queued: Boolean(queued.queued),
            reviewId: queued.review?.id || null,
            reason: "Manual watch review required",
          });
        }
        console.log("Webhook: skipped a played flag while Plekt is unwatched", {
          source: media.source,
          title: media.title,
          event: media.event,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          skipped: true,
          reason: "Played flag ignored because Plekt is unwatched",
        });
      }
      if (existingCanonicalState === "watched") {
        // The local watch is authoritative, but the reporting app may be
        // ahead of another connected app. Reconcile the canonical watched
        // state to every configured destination, including the reporter, so
        // an already-watched item cannot leave the other apps mismatched.
        const canonicalMedia = {
          ...media,
          watched_at: existingPlaystate?.watched_at || existingWatchedHistory?.watched_at || media.watched_at,
        };
        const reconciliation = await syncCanonicalPlaystate(canonicalMedia, config, loopStore, "watched", { lane: "sync" }).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Canonical watch reconciliation failed: ${error.message || String(error)}`,
          targetStates: [],
        }));
        console.log("Webhook: reconciled an already-watched item across connected apps", {
          source: media.source,
          title: media.title,
          event: media.event,
          existingWatchId: existingWatchedHistory?.id || null,
          canonicalState: existingCanonicalState,
          status: reconciliation.status,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          id: existingWatchedHistory?.id || null,
          reconciled: true,
          syncStatus: reconciliation.status || "unknown",
          targetStates: reconciliation.targetStates || [],
          reason: "Already marked watched; reconciled to connected apps",
        });
      }

      if (dateChoice.requiresReview) {
        const queued = enqueueManualWatchReview(media, {
          releaseDate: media.releaseDate,
          observedWatchedAt: "",
          sourceFingerprint: webhookWatchFingerprint(media, media.releaseDate),
          reason: existingProvenance.note || `${media.source || "The app"} reported a watched flag without playback evidence.`,
        });
        if (queued.queued) {
          console.log("Webhook: queued manual watch review", {
            source: media.source,
            title: media.title,
            mode,
          });
        }
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          queued: Boolean(queued.queued),
          reviewId: queued.review?.id || null,
          reason: "Manual watch review required",
        });
      }
    }

    // Check if a recent watch record already exists (e.g., from full sync)
    // to avoid creating duplicates. Look for records watched in the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const existingRecord = await getWatchRecordByMediaKey(mediaKeyFor(media), oneHourAgo).catch(() => null);
    // An unwatch is retained as a tombstone so the state transition can be
    // audited. It must not block a later real watch for the same provider key.
    if (existingRecord?.sync_action === "watched") {
      console.log("Webhook: skipped duplicate watch record", {
        source: media.source,
        title: media.title,
        existingWatchedAt: existingRecord.watched_at,
      });
      return sendJson(res, { ok: true, inserted: false, id: existingRecord.id, reason: "Watch record already exists from recent full sync" });
    }

    let isRewatchOnNewDay = false;
    const existingPlaystate = await getPlaystateForMedia(media).catch(() => null);
    if (existingPlaystate?.state === "watched") {
      // Emby and Jellyfin emit a played-flag event whenever anything sets the
      // flag, including plembfin's own outbound sync, and they can deliver it
      // hours after the fact. For an item already held as watched such an event
      // carries no evidence that a new play happened, so it never opens a
      // rewatch - the calendar day it happens to land on is meaningless. Real
      // rewatches arrive as playback events (media.scrobble, playback.stop) and
      // fall through to be recorded below.
      const lastWatchedDay = String(existingPlaystate.watched_at || "").slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const isPlayedFlagEcho = Boolean(media.playedFlagOnly);
      if (isPlayedFlagEcho || !lastWatchedDay || lastWatchedDay === today) {
        console.log("Webhook: skipped watched echo", {
          source: media.source,
          title: media.title,
          event: media.event,
          reason: isPlayedFlagEcho
            ? "played-flag event for an item already marked watched"
            : "already marked watched today",
          playstateUpdatedAt: existingPlaystate.updated_at,
        });
        await deletePlaybackProgress(media).catch(() => null);
        await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
        return sendJson(res, {
          ok: true,
          inserted: false,
          id: existingPlaystate.id,
          reason: isPlayedFlagEcho
            ? "Played flag event for an item already marked watched"
            : "Already marked watched today",
        });
      }
      console.log("Webhook: recording rewatch on a new day", {
        source: media.source,
        title: media.title,
        lastWatchedDay,
        today,
      });
      isRewatchOnNewDay = true;
    }

    if (await shouldSkipPostRestoreCompletedWebhook(media)) {
      console.log("Webhook: skipped post-restore completed event without active playback evidence", {
        source: media.source,
        title: media.title,
        type: media.type,
      });
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, {
        ok: true,
        inserted: false,
        skipped: true,
        reason: "Post-restore completed webhook without active playback evidence",
      });
    }

    // getWatchRecordByMediaKey and getPlaystateForMedia above both key off
    // this notification's own computed media_key/playstate lookup, which can
    // still miss an already-recorded watch stored under a different key from
    // another source (e.g. one keyed by imdb, another by title fallback) -
    // the exact mismatch behind the Silo/Trying/Cape Fear phantom watches.
    // findWatchedByAnyMediaKey has the broader coordinate/provider-id
    // fallback matching every other ingest path relies on for this; treat a
    // hit there as conclusive too instead of only trusting the exact checks.
    // Skip this when the block above already approved a rewatch on a new day:
    // findWatchedByAnyMediaKey's first candidate is this notification's own
    // media_key, so it re-finds the very record that "watched on <old day>"
    // was compared against, and would otherwise repair playstate back to that
    // stale date instead of recording tonight's real rewatch.
    const existingByAnyKey = isRewatchOnNewDay || existingPlaystate?.state === "unwatched"
      ? null
      : await findWatchedByAnyMediaKey(media).catch(() => null);
    if (existingByAnyKey) {
      console.log("Webhook: already recorded under a different key; repairing playstate instead of logging a new watch", {
        source: media.source,
        title: media.title,
        existingWatchedAt: existingByAnyKey.watched_at,
      });
      await upsertPlaystateForMedia(media, "watched", existingByAnyKey.watched_at, { skipInvalidate: true });
      await deletePlaybackProgress(media).catch(() => null);
      await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
      return sendJson(res, { ok: true, inserted: false, id: existingByAnyKey.id, reason: "Watch record already exists under a different media key" });
    }

    if (!media.playedFlagOnly) {
      recordPlaybackEndedAudit(media, {
        status: "completed",
        details: "Playback ended after the source reported a completed play.",
      });
    }

    const watchRecord = mediaToWatchRecord(media, media.source);
    watchRecord.sync_action = "watched";
    watchRecord.sync_dispatch_telemetry = formatDispatchTelemetry({ skipped: false, status: "pending", details: "Propagation queued", targetStates: [] }, media, "watched");
    const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
    // Resolve a movie's provider ids before its first outbound dispatch. The
    // prefetch still runs in the background for episodes and for callers that
    // do not need the result synchronously, but a movie with no identity must
    // give Trakt the same complete metadata that is persisted on the row.
    if (media.type === "movie") await result.assetPrefetch?.catch(() => null);
    media.watchRecordId = result.id;
    media.ids = {
      imdb: result.record.imdb_id || undefined,
      tmdb: result.record.tmdb_id || undefined,
      tvdb: result.record.tvdb_id || undefined,
    };
    console.log("Webhook: inserted watch record", {
      source: media.source,
      title: media.title,
      recordId: result.id,
      watchedAt: result.record.watched_at,
    });
    await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
    await setRuntimeState({ nowPlayingRefresh: Date.now() }).catch(() => null);
    const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    console.log("Webhook: sync result", {
      source: media.source,
      title: media.title,
      status: summary.status,
      details: summary.details,
      targetStates: summary.targetStates,
    });
    await updateWatchTelemetry(result.id, formatDispatchTelemetry(summary, media, "watched"), { skipInvalidate: true });
    await recordSyncHistory(media, summary, "watched");
    await deletePlaybackProgress(media).catch(() => null);
    // Ensure TMDB metadata + artwork finish caching before the instance freezes,
    // so the detail page is instant on first click. Overlaps with the sync above.
    await result.assetPrefetch?.catch(() => null);
    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
    return sendJson(res, { ok: true, inserted: true, id: result.id, record: result.record });
  } catch (error) {
    console.error("Webhook insert failed", error);
    await invalidateHistoryDerivedCaches("embyLikeUserDataState").catch(() => null);
    return sendJson(res, { error: "Webhook insert failed" }, 500);
  }
}
