import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { runForceSync, runScheduledSync } from "../scheduled.js";
import { activeSyncOperation, appendSyncHistory, claimSyncOperation, clearRestoreSyncState, isAuthoritativeRestoreKind, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, releaseSyncOperation, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, RESTORE_KIND_FULL_SYNC, setRuntimeState, appendRuntimeLog, touchSyncOperation } from "../utils/configStore.js";
import { cancelSyncJobsForAuthoritativeRestore } from "../utils/backgroundJobs.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "../utils/jellyfinClient.js";
import { setJellyfinApiKey } from "../utils/jellyfinAuth.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, recordOutboundPlayedMarks, shouldSyncResumeProgress, syncCanonicalPlaystate, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, getCachedTvdbId } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { canonicalMediaArtworkCacheKey, saveCanonicalPoster } from "../utils/mediaArtwork.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import { formatDispatchTelemetry, recordSyncHistory } from "./sync.js";
import { statsPayloadForPeriod } from "../utils/statsPayload.js";
import {
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  coalesceWatchDateRemovals,
  dedupeHistory,
  deletePlaybackProgress,
  deleteWatchRecord,
  deleteWatchRecordById,
  updateWatchRecord,
  getWatchDatesForRecord,
  addWatchDate,
  deleteWatchDate,
  deleteWatchDates,
  updateWatchDates,
  mergeShows,
  listShowMerges,
  unmergeShow,
  getWatchRecordById,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  getPlaybackProgressForMedia,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listLibraryItemsForRefresh,
  relatedPosterRows,
  rematchShowWatchRecords,
  setTraktEpisodeMatch,
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
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  watchRowsToMedia,
  getCachedShows,
  getCachedMovies,
  getCachedHistory,
  isPlektTrackedWatchRow,
  normalizeMediaType,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deleteMediaByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearRelatedWatchArtworkUrls,
} from "../utils/dataRepo.js";
import { listWatchAuditEvents, watchAuditEventForLegacyRecord } from "../utils/watchAudit.js";

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

export async function handleHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const id = String(req.query.id || "");
  if (id) {
    const row = await getWatchRecordById(id);
    const progress = row?.media_key ? await getPlaybackProgressForMedia(row).catch(() => null) : null;
    return sendJson(res, { row, progress });
  }

  const mediaKeys = queryList(req.query.mediaKey || req.query.media_key || req.query.mediaKeys);
  if (mediaKeys.length) {
    const items = await Promise.all(mediaKeys.map(async (mediaKey) => {
      const latestRow = await getWatchRecordByMediaKey(mediaKey);
      // The media-key lookup intentionally stays lightweight for its many sync
      // callers. SSE uses this path for a single changed item, so hydrate the
      // full playHistory array before the browser patches that item's detail.
      const row = latestRow?.id ? await getWatchRecordById(latestRow.id) : latestRow;
      const progress = await getPlaybackProgressForMedia(row || { media_key: mediaKey }).catch(() => null);
      return { mediaKey, row, progress };
    }));
    return sendJson(res, { items });
  }

  const statsMode = String(req.query.stats || "").toLowerCase();
  if (statsMode === "only") {
    return sendJson(res, {
      stats: statsPayloadForPeriod(await getWatchStats(requireDb()), req.query.period || "all"),
    });
  }

  const previewMode = String(req.query.preview || "").toLowerCase();
  if (["1", "true", "dashboard"].includes(previewMode)) {
    const [history, historyVersion] = await Promise.all([
      queryWatchHistoryPreview({ limit: req.query.limit || 120 }),
      getHistoryCacheVersion(),
    ]);
    return sendJson(res, { history, historyVersion }, 200, { "Cache-Control": "private, max-age=30, stale-while-revalidate=120", Vary: "Authorization" });
  }

  const dedupe = !["0", "false", "no"].includes(String(req.query.dedupe || "").toLowerCase());
  const includeStats = !["0", "false", "no"].includes(statsMode);
  const requestedLimit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const historyPromise = queryWatchHistory({ search: req.query.search || "", mediaType: req.query.mediaType || "", limit: requestedLimit + 1, offset: req.query.offset || 0, dedupe });
  const historyVersionPromise = getHistoryCacheVersion();

  if (!includeStats) {
    const [historyRows, historyVersion] = await Promise.all([historyPromise, historyVersionPromise]);
    const hasMore = historyRows.length > requestedLimit;
    return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, historyVersion });
  }

  const [historyRows, stats, historyVersion] = await Promise.all([
    historyPromise,
    getWatchStats(requireDb()),
    historyVersionPromise,
  ]);
  const hasMore = historyRows.length > requestedLimit;
  return sendJson(res, { history: historyRows.slice(0, requestedLimit), hasMore, stats, historyVersion });
}

function queryList(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => String(entry || "").split(",")).map((entry) => entry.trim()).filter(Boolean))];
}

export async function handleHistoryAudit(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const recordIds = queryList(req.query.recordId || req.query.recordIds);
  const mediaKeys = queryList(req.query.mediaKey || req.query.mediaKeys);
  const title = String(req.query.title || "").trim();
  const showTitle = String(req.query.showTitle || req.query.show_title || "").trim();
  const ids = {
    imdb: String(req.query.imdbId || req.query.imdb_id || "").trim(),
    tmdb: String(req.query.tmdbId || req.query.tmdb_id || "").trim(),
    tvdb: String(req.query.tvdbId || req.query.tvdb_id || "").trim(),
  };

  const records = (await Promise.all(recordIds.map((id) => getWatchRecordByIdLight(id).catch(() => null)))).filter(Boolean);
  for (const record of records) watchAuditEventForLegacyRecord(record);

  const events = listWatchAuditEvents({
    recordIds,
    mediaKeys,
    titles: title ? [title] : [],
    showTitles: showTitle ? [showTitle] : [],
    ids,
    mediaType: req.query.mediaType || req.query.type || "",
    limit: req.query.limit || 2000,
  });

  const unique = (values) => [...new Set(values.filter(Boolean))];
  return sendJson(res, {
    events,
    coverage: {
      eventCount: events.length,
      exactEventCount: events.filter((event) => event.eventType !== "legacy_record").length,
      legacyEventCount: events.filter((event) => event.eventType === "legacy_record").length,
      sources: unique(events.map((event) => event.source)),
      targets: unique(events.map((event) => event.target)),
      devices: unique(events.map((event) => event.device)),
      users: unique(events.map((event) => event.user)),
      sessions: unique(events.map((event) => event.sessionId)),
    },
  }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

// Remove one orphaned history row when it cannot be matched to a show.
export async function handleDeleteHistoryRecord(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req).catch(() => ({}));
  const id = String(body.id || req.query.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);
  if (String(body.confirm || "") !== "DELETE") return sendJson(res, { error: "Confirmation required" }, 400);
  try {
    const row = await getWatchRecordById(id);
    if (!row) return sendJson(res, { error: "History entry not found" }, 404);
    await deleteWatchRecordById(id);
    writeAuditLog("history.record_deleted", { ip: req.ip || req.socket?.remoteAddress, detail: { id, title: row.title } });
    return sendJson(res, { ok: true, id }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Failed to delete history record", error);
    return sendJson(res, { error: "Failed to delete history record" }, 500);
  }
}

export async function handleClearMissingTelemetry(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const db = requireDb();
    const clearStmt = db.prepare(`
      UPDATE watch_history
      SET sync_dispatch_telemetry = 'Dispatch Status: success'
      WHERE sync_dispatch_telemetry IS NULL OR sync_dispatch_telemetry = ''
    `);
    const result = clearStmt.run();
    await invalidateHistoryDerivedCaches("handleClearMissingTelemetry");
    return sendJson(res, { cleared: result.changes });
  } catch (err) {
    console.error("[clearMissingTelemetry] Error:", err);
    return sendJson(res, { error: "Failed to clear telemetry" }, 500);
  }
}

export async function handleMovies(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const movies = await queryMovies({ search: req.query.search || "", sort: req.query.sort || "title_asc", limit: req.query.limit || 100, offset: req.query.offset || 0 });
  return sendJson(res, { movies }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

// Permanently delete a library item (all its plays + playstate + progress).
// Destructive and irreversible â€” the client must send confirm: "DELETE".
export async function handleDeleteMedia(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);
  if (String(body.confirm || "") !== "DELETE") {
    return sendJson(res, { error: "Confirmation required" }, 400);
  }

  try {
    const result = await deleteMediaByWatchId(id, { mediaType: body.media_type });
    if (!result.found) return sendJson(res, { error: "Media item not found" }, 404);
    writeAuditLog("media.deleted", { ip: req.ip || req.socket?.remoteAddress, detail: { id, title: result.title } });
    return sendJson(res, { ok: true, deleted: result.deleted, title: result.title }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Failed to delete media item", error);
    return sendJson(res, { error: "Failed to delete media item" }, 500);
  }
}

export async function handleShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const shows = await queryShows({
    search: req.query.search || "",
    sort: req.query.sort || "title_asc",
    limit: req.query.limit || 6,
    offset: req.query.offset || 0,
    hideWatched: req.query.hideWatched === "true",
    hideEnded: req.query.hideEnded === "true",
  });
  return sendJson(res, { shows }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", Vary: "Authorization" });
}

export async function handleShow(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const id = String(req.query.id || "").trim();
  const title = String(req.query.title || "").trim();
  const tmdbId = String(req.query.tmdbId || "").trim();
  const tvdbId = String(req.query.tvdbId || "").trim();
  const imdbId = String(req.query.imdbId || "").trim();
  if (!id && !title && !tmdbId && !tvdbId && !imdbId) return sendJson(res, { error: "id, title, or provider id is required" }, 400);
  const show = await queryShowDetail({ id, title, tmdbId, tvdbId, imdbId });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  // Unlike the show explorer summary, detail includes mutable per-episode
  // watched state. A cached response can overwrite a just-completed manual
  // watch on the next page reload, so detail must always be revalidated.
  return sendJson(res, { show }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
}

function configuredRestoreTargets(config = {}, stateType = "watched") {
  const targets = [];
  // This endpoint is an explicit restore/replay, not an ordinary directional
  // sync. Every connected, enabled app must receive the canonical state even
  // when its normal sync role is source-only.
  if (!config.plex?.disabled && config.plex?.baseUrl && config.plex?.token) targets.push("plex");
  if (!config.emby?.disabled && config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId) targets.push("emby");
  if (!config.jellyfin?.disabled && config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

const FULL_SYNC_ROW_CONCURRENCY = 4;
const FULL_SYNC_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

function validFullSyncRunId(value) {
  const runId = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,100}$/.test(runId) ? runId : "";
}

function restoreRuntimeIsFresh(runtime = {}, now = Date.now()) {
  if (runtime.restoreSyncActive !== true) return false;
  const heartbeat = Number(runtime.restoreSyncHeartbeat || runtime.restoreSyncStartedAt || 0);
  return heartbeat > 0 && heartbeat >= now - FULL_SYNC_HEARTBEAT_STALE_MS;
}

async function runWithConcurrency(items, concurrency, worker, shouldStop = async () => false) {
  let cursor = 0;
  let processed = 0;
  let stopped = false;
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      if (await shouldStop()) {
        stopped = true;
        return;
      }
      const index = cursor++;
      await worker(items[index], index);
      processed += 1;
    }
  }));
  return { processed, stopped };
}

async function fullSyncRestoreIsCancelled(runId) {
  const runtime = await loadRuntimeState().catch(() => null);
  if (!runtime) return false;
  return runtime.restoreSyncCancelRequested === true
    || runtime.restoreSyncActive !== true
    || validFullSyncRunId(runtime.restoreSyncRunId) !== runId;
}

async function beginFullSyncRestore(runId, phase, requestedSnapshotAt, phaseStart = false) {
  const now = Date.now();
  const runtime = await loadRuntimeState();
  const active = restoreRuntimeIsFresh(runtime, now);
  const activeRunId = validFullSyncRunId(runtime.restoreSyncRunId);
  const operation = activeSyncOperation(runtime);

  if (operation && isAuthoritativeRestoreKind(operation.kind)
    && !(operation.kind === RESTORE_KIND_FULL_SYNC && operation.ownerId === runId)) {
    // A different authoritative restore still owns the canonical tables and
    // must finish (or be explicitly reset) before this restore can start.
    return { conflict: true, active: operation };
  }

  if (active && activeRunId !== runId) {
    return { conflict: true };
  }

  if (!phaseStart && runtime.restoreSyncCancelRequested === true) {
    return { cancelled: true, snapshotAt: Number(runtime.restoreSyncSnapshotAt || requestedSnapshotAt || now) };
  }

  if (!active && runtime.restoreSyncActive === true) {
    await setRuntimeState({ restoreSyncActive: false, restoreSyncRunId: "", syncOperation: null }).catch(() => null);
  }

  const requested = Number(requestedSnapshotAt);
  const snapshotAt = phaseStart || !Number.isFinite(requested) || requested <= 0
    ? now
    : Math.min(requested, now);
  const startedAt = active && activeRunId === runId
    ? Number(runtime.restoreSyncStartedAt || now)
    : now;

  const claim = await claimSyncOperation({
    kind: RESTORE_KIND_FULL_SYNC,
    ownerId: runId,
    activeField: "restoreSyncActive",
    startedAt,
    values: {
      restoreSyncRunId: runId,
      restoreSyncKind: RESTORE_KIND_FULL_SYNC,
      restoreSyncCancelRequested: false,
      restoreSyncPhase: phase,
      restoreSyncStartedAt: startedAt,
      restoreSyncHeartbeat: now,
      restoreSyncSnapshotAt: snapshotAt,
      restoreSyncResult: null,
    },
    preempt: true,
  });
  if (!claim?.ok) return { conflict: true, active: claim?.active || null };

  // Full Sync is an authoritative restore too. Cancel queued sync jobs after
  // the shared marker is claimed so a worker that wakes on another process
  // cannot start a new watch-state batch while this restore is replaying.
  cancelSyncJobsForAuthoritativeRestore();

  return { conflict: false, snapshotAt };
}

async function finishFullSyncRestore(runId, result = {}) {
  const runtime = await loadRuntimeState();
  if (validFullSyncRunId(runtime.restoreSyncRunId) !== runId) return;
  const finishedAt = Date.now();
  await releaseSyncOperation({
    kind: RESTORE_KIND_FULL_SYNC,
    ownerId: runId,
    values: {
      restoreSyncActive: false,
      restoreSyncRunId: "",
      restoreSyncKind: "",
      restoreSyncCancelRequested: Boolean(result.cancelled),
      restoreSyncHeartbeat: finishedAt,
      restoreSyncResult: { ...result, runId, finishedAt },
    },
  }).catch(() => null);
}

async function touchFullSyncRestore(runId) {
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (runtime.restoreSyncActive !== true || validFullSyncRunId(runtime.restoreSyncRunId) !== runId) return;
  await touchSyncOperation({
    kind: RESTORE_KIND_FULL_SYNC,
    ownerId: runId,
    values: { restoreSyncHeartbeat: Date.now() },
  }).catch(() => null);
}

function emptyRestoreSummary(targets = []) {
  const summary = {};
  for (const target of targets) {
    summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  }
  return summary;
}

function restoreClientFor(target, phase, config, media) {
  if (phase === "progress") {
    if (target === "plex") return () => setPlexProgress(config.plex, media);
    if (target === "emby") return () => setEmbyProgress(config.emby, media);
    if (target === "jellyfin") return () => setJellyfinProgress(config.jellyfin, media);
  }
  if (target === "plex") return () => markPlexPlayed(config.plex, media);
  if (target === "emby") return () => markEmbyPlayed(config.emby, media);
  if (target === "jellyfin") return () => markJellyfinPlayed(config.jellyfin, media);
  throw new Error(`Unknown restore target: ${target}`);
}

function applyRestoreResult(summary, target, result) {
  if (!summary[target]) summary[target] = { success: 0, skipped: 0, notFound: 0, error: 0 };
  if (result?.status === "not_found") {
    summary[target].notFound += 1;
  } else if (result?.status === "skipped" || result?.status === "skipped_by_policy") {
    // A provider the historical sync policy deliberately left alone is a skip,
    // never a success - a restore must not claim it wrote to Plex when the
    // user turned historical Plex sync off.
    summary[target].skipped += 1;
  } else {
    summary[target].success += 1;
  }
}

export async function handleFullSyncWatchstates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = (await readJson(req).catch(() => ({}))) || {};
  const action = String(body.action || "").trim().toLowerCase();

  if (action === "reset") {
    const runtime = await loadRuntimeState();
    const restoreKind = String(runtime.restoreSyncKind || "");
    const operation = activeSyncOperation(runtime);
    const legacyFullSync = runtime.restoreSyncActive === true
      && !restoreKind
      && validFullSyncRunId(runtime.restoreSyncRunId);
    if ((restoreKind && restoreKind !== RESTORE_KIND_FULL_SYNC)
      || (operation && operation.kind !== RESTORE_KIND_FULL_SYNC && !legacyFullSync)) {
      return sendJson(res, { error: "Another restore is currently active. Stop it from its owning tool first." }, 409);
    }
    const result = await clearRestoreSyncState({
      reason: "Full Sync Watchstates was reset by an administrator.",
      expectedKind: legacyFullSync ? "" : RESTORE_KIND_FULL_SYNC,
    });
    const message = result.reset
      ? "Full Sync Watchstates was stopped and its restore lock was cleared."
      : "No Full Sync Watchstates restore lock was active.";
    return sendJson(res, { ok: true, reset: result.reset, active: false, previousRunId: result.runId || "", message });
  }

  const runId = validFullSyncRunId(body.runId);
  if (!runId) return sendJson(res, { error: "A valid full-sync runId is required." }, 400);

  if (action === "cancel") {
    const runtime = await loadRuntimeState();
    const activeRunId = validFullSyncRunId(runtime.restoreSyncRunId);
    if (restoreRuntimeIsFresh(runtime) && activeRunId && activeRunId !== runId) {
      return sendJson(res, { error: "Another restore is currently active." }, 409);
    }
    await finishFullSyncRestore(runId, { success: true, cancelled: true });
    return sendJson(res, { ok: true, cancelled: true });
  }

  const phase = String(body.phase || "watched") === "progress" ? "progress" : "watched";
  const offset = Math.max(Number(body.offset || 0), 0);
  const limit = Math.min(Math.max(Number(body.limit || 25), 1), 100);
  const phaseStart = body.start === true || String(body.start || "").toLowerCase() === "true";
  const config = await loadMediaConfig();
  const targets = configuredRestoreTargets(config, phase);
  const summary = emptyRestoreSummary(targets);
  const errors = [];
  const loopStore = createLoopStore();

  if (!targets.length) {
    return sendJson(res, { ok: true, phase, offset, limit, runId, total: 0, processed: 0, nextOffset: offset, hasMore: false, targets, summary, errors, note: "No configured restore targets." });
  }

  const restoreState = await beginFullSyncRestore(runId, phase, body.snapshotAt, phaseStart);
  if (restoreState.conflict) {
    const runtime = await loadRuntimeState();
    return sendJson(res, {
      error: "Another restore is currently active.",
      restore: {
        runId: validFullSyncRunId(runtime.restoreSyncRunId),
        kind: String(runtime.restoreSyncKind || restoreState.active?.kind || RESTORE_KIND_FULL_SYNC),
        phase: String(runtime.restoreSyncPhase || "watched"),
        startedAt: Number(runtime.restoreSyncStartedAt || 0),
        heartbeat: Number(runtime.restoreSyncHeartbeat || 0),
      },
    }, 409);
  }
  if (restoreState.cancelled) {
    return sendJson(res, {
      ok: true,
      phase,
      runId,
      snapshotAt: restoreState.snapshotAt,
      total: 0,
      processed: 0,
      nextOffset: offset,
      hasMore: false,
      cancelled: true,
      targets,
      summary,
      errors,
      note: "This restore was stopped by an administrator.",
    });
  }
  const snapshotAt = restoreState.snapshotAt;
  let total;
  let rows;
  try {
    total = phase === "progress"
      ? await countPlaybackProgressRows({ snapshotAt })
      : await countWatchedPlaystateRows({ snapshotAt });
    rows = phase === "progress"
      ? await listPlaybackProgressRowsForReplay({ limit, offset, snapshotAt })
      : await listWatchedPlaystateRowsForReplay({ limit, offset, snapshotAt });
  } catch (error) {
    await finishFullSyncRestore(runId, { success: false, error: error.message || String(error) });
    throw error;
  }

  const heartbeatTimer = setInterval(() => {
    touchFullSyncRestore(runId).catch(() => null);
  }, 30_000);
  let processedRows = 0;
  let restoreCancelled = false;
  try {
    const runResult = await runWithConcurrency(rows, FULL_SYNC_ROW_CONCURRENCY, async (row) => {
      const outcomes = await Promise.all(targets.map(async (target) => {
        const media = phase === "progress" ? progressRowToMedia(row, target) : watchRowToMedia(row, target);
        if (!media.isValid) return { target, result: { status: "skipped" } };

        try {
          if (await fullSyncRestoreIsCancelled(runId)) {
            return { target, result: { status: "skipped", detail: "Restore was cancelled before this target was written." } };
          }
          if (phase === "watched") {
            await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
          }
          if (await fullSyncRestoreIsCancelled(runId)) {
            return { target, result: { status: "skipped", detail: "Restore was cancelled before this target was written." } };
          }
          const result = await restoreClientFor(target, phase, config, media)();
          if (await fullSyncRestoreIsCancelled(runId)) {
            return { target, result: { status: "skipped", detail: "Restore was cancelled while this target was being written." } };
          }
          if (phase === "watched" && result?.status !== "not_found") {
            const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
              ? result.itemIds
              : result?.itemId
                ? [result.itemId]
                : [];
            if (itemIds.length) {
              await Promise.all(itemIds.map((itemId) => recordOutboundPlayedMarks({ ...media, itemId }, [target], loopStore).catch(() => null)));
            } else {
              await recordOutboundPlayedMarks(media, [target], loopStore).catch(() => null);
            }
          }
          return { target, result };
        } catch (error) {
          return {
            target,
            error,
            rowId: row.id || row.media_key || "",
            title: row.title || "",
          };
        }
      }));

      for (const outcome of outcomes) {
        if (outcome.error) {
          summary[outcome.target].error += 1;
          errors.push({
            target: outcome.target,
            rowId: outcome.rowId,
            title: outcome.title,
            detail: outcome.error?.message || String(outcome.error),
          });
        } else {
          applyRestoreResult(summary, outcome.target, outcome.result);
        }
      }
    }, () => fullSyncRestoreIsCancelled(runId));
    processedRows = runResult.processed;
    restoreCancelled = runResult.stopped || await fullSyncRestoreIsCancelled(runId);
  } catch (error) {
    await finishFullSyncRestore(runId, { success: false, error: error.message || String(error) });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (restoreCancelled) {
    await finishFullSyncRestore(runId, { success: true, cancelled: true });
    const nextOffset = offset + processedRows;
    return sendJson(res, {
      ok: true,
      phase,
      offset,
      limit,
      runId,
      snapshotAt,
      total,
      processed: processedRows,
      nextOffset,
      hasMore: false,
      cancelled: true,
      targets,
      summary,
      errors,
      note: "Restore stopped before the next batch.",
    });
  }

  const nextOffset = offset + rows.length;
  const hasMore = rows.length > 0 && nextOffset < total;
  if (!hasMore && (phase === "progress" || body.complete === true)) {
    await finishFullSyncRestore(runId, { success: true, cancelled: false });
  } else {
    await touchFullSyncRestore(runId);
  }
  return sendJson(res, {
    ok: true,
    phase,
    offset,
    limit,
    runId,
    snapshotAt,
    total,
    processed: rows.length,
    nextOffset,
    hasMore,
    targets,
    summary,
    errors,
    note: total ? "" : "No Plekt archive rows are available to restore.",
  });
}

function resolveCustomPosterFetchUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (value.startsWith("/api/tmdb-poster")) {
    try {
      const proxied = new URL(value, "http://localhost");
      const posterPath = proxied.searchParams.get("path") || "";
      return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : "";
    } catch {
      return "";
    }
  }
  return value;
}

// Lists every watch date recorded for the same movie/episode as `id`, for the
// "Edit Watch Date" dialog's per-date list.
export async function handleWatchDates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const id = String(req.query.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const result = await getWatchDatesForRecord(id);
  if (!result) return sendJson(res, { error: "Watch record not found" }, 404);
  return sendJson(res, result);
}

// A manually added or corrected watched date should also reach every
// connected platform, not just Plembfin's own database - the same replay
// Force Sync's "Set Plembfin as Source of Truth" already does for canonical state, so Trakt (which
// accepts a specific historical watched_at) and Plex/Emby/Jellyfin don't keep
// showing the old, missing, or a previously-fabricated date after a manual
// fix. Fire-and-forget: the edit itself must not wait on several outbound API
// calls to save, and a propagation failure must not undo the local edit.
function propagateCorrectedWatchDate(recordId, { lane = "interactive" } = {}) {
  getWatchRecordByIdLight(recordId)
    .then(async (row) => {
      if (!row) return;
      if (String(row.sync_action || "watched").toLowerCase() === "unwatched") return;
      const media = watchRowToMedia(row, "manual");
      if (!media?.isValid) return;
      const config = await loadMediaConfig();
      const summary = await syncCanonicalPlaystate(media, config, createLoopStore(), "watched", { lane });
      // Without this, the row's own telemetry stays whatever it was before this
      // replay - often "Dispatch status: pending" - so the scheduler's backlog
      // sweep (syncPendingManualDispatches in scheduled.js) keeps treating it as
      // needing a retry and re-dispatches it later with its own, less complete
      // media object, potentially overwriting this correct, dated replay.
      await updateWatchTelemetry(row.id, formatDispatchTelemetry(summary, media, "watched"));
    })
    .catch((error) => console.error("Failed to propagate corrected watch date for record", recordId, error?.message || error));
}

// Deleting a watch date changes what Plembfin considers canonical for that
// item - either a rolled-back watched date, or fully unwatched if nothing is
// left - and that correction has to reach every connected platform too. Every
// server this was already dispatched to (see the row's sync_dispatch_telemetry
// before the delete) still believes the old state; left alone, that stale
// state can come back as a brand-new phantom watch the next time that
// platform's own catch-up scan runs. Reuses the same loop-safe canonical
// replay as propagateCorrectedWatchDate and Force Sync's "Set Plembfin as
// Source of Truth". Fire-and-forget, same reasoning as above.
export function propagateWatchDateRemoval(remainingRow, deletedRow, { lane = "interactive", deletedRows = [] } = {}) {
  const allDeletedRows = [];
  const seenDeletedIds = new Set();
  for (const row of [...(deletedRows || []), deletedRow]) {
    if (!row) continue;
    const key = row.id || `${row.media_key || ""}|${row.watched_at || ""}|${row.title || ""}`;
    if (seenDeletedIds.has(key)) continue;
    seenDeletedIds.add(key);
    allDeletedRows.push(row);
  }
  const mediaRows = remainingRow
    ? [remainingRow, ...allDeletedRows]
    : allDeletedRows.slice().sort((left, right) => {
      const leftIds = [left.imdb_id, left.tmdb_id, left.tvdb_id].filter(Boolean).length;
      const rightIds = [right.imdb_id, right.tmdb_id, right.tvdb_id].filter(Boolean).length;
      return rightIds - leftIds;
    });
  const row = remainingRow || mediaRows[0];
  if (!row) return Promise.resolve(null);
  const media = watchRowsToMedia(mediaRows, "manual");
  if (!media?.isValid) return Promise.resolve(null);
  const action = remainingRow ? "watched" : "unwatched";
  const loopStore = createLoopStore();
  return loadMediaConfig()
    .then(async (config) => {
      // The surviving canonical row can predate a Fix Match and carry a
      // different provider identity. Preserve the deleted provider row's
      // native item id in the echo ledger before replaying the survivor so a
      // synchronous viewstate acknowledgement cannot recreate that date.
      for (const deleted of allDeletedRows) {
        const deletedSource = String(deleted.source || "").toLowerCase();
        if (!["plex", "emby", "jellyfin"].includes(deletedSource)) continue;
        const deletedMedia = watchRowToMedia(deleted, deletedSource);
        if (deletedMedia?.isValid) {
          await recordOutboundPlayedMarks(deletedMedia, [deletedSource], loopStore).catch(() => null);
        }
      }
      return syncCanonicalPlaystate(media, config, loopStore, action, { lane });
    })
    .then(async (summary) => {
      // Persist the real outcome (and the historical watched_at it was sent
      // with) onto the surviving row's own telemetry. Left at whatever it was
      // before - "Dispatch status: pending" for a row remainingWatchRowFor()
      // just promoted from unwatched - the scheduler's backlog sweep
      // (syncPendingManualDispatches in scheduled.js) treats it as still
      // needing a retry and re-dispatches it later with its own media object,
      // which does not carry this row's watched_at, sending Trakt today's
      // date instead of the real one this replay just correctly sent.
      if (remainingRow) await updateWatchTelemetry(remainingRow.id, formatDispatchTelemetry(summary, media, action));
      await recordSyncHistory(media, summary, action);
      return summary;
    })
    .catch((error) => {
      console.error("Failed to propagate watch date removal for record", row.id, error?.message || error);
      return null;
    });
}

// Adds another watch date for the same movie/episode as `id` (the "Add another
// watch date" control in the edit-date dialog).
export async function handleAddWatchDate(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  const watchedAt = body.watched_at;
  if (!id) return sendJson(res, { error: "id is required" }, 400);
  if (!watchedAt) return sendJson(res, { error: "watched_at is required" }, 400);

  const result = await addWatchDate(id, watchedAt);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);
  propagateCorrectedWatchDate(result.id);
  return sendJson(res, { ok: true, id: result.id });
}

// Removes a single watch date (the "Remove this watch date" control in the
// edit-date dialog) without affecting any other watch of the same item.
export async function handleDeleteWatchDate(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return sendJson(res, { error: "id is required" }, 400);

  const result = await deleteWatchDate(id);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);
  propagateWatchDateRemoval(result.remainingRow, result.deletedRow, { deletedRows: result.deletedRows });
  writeAuditLog("media.watch_date_deleted", { ip: req.ip || req.socket?.remoteAddress, detail: { id } });
  return sendJson(res, { ok: true });
}

// Bulk delete for the season/show "remove duplicate watches" cleanup - keeps
// each episode's oldest watch and removes the rest in one request instead of
// one round trip per row.
export async function handleDeleteWatchDates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return sendJson(res, { error: "ids is required" }, 400);
  if (ids.length > 500) return sendJson(res, { error: "Batch size must be 500 ids or fewer" }, 413);

  const { affectedMedia, ...result } = await deleteWatchDates(ids);
  for (const media of coalesceWatchDateRemovals(affectedMedia || [])) {
    propagateWatchDateRemoval(media.remainingRow, media.deletedRow, { lane: "sync", deletedRows: media.deletedRows });
  }
  writeAuditLog("media.watch_dates_bulk_deleted", {
    ip: req.ip || req.socket?.remoteAddress,
    detail: { requested: ids.length, deleted: result.deleted.length, notFound: result.notFound.length },
  });
  return sendJson(res, result);
}

// Library-wide version of the season "remove duplicate watches" cleanup - for
// every movie or episode with more than one recorded watch, everything after
// the oldest is a removable duplicate (a rewatch import, a sync echo, or the
// kind of wrong-id Trakt overwrite fixed in trackerDispatcher.js). Read-only:
// used to size the confirmation dialog before handleDuplicateWatchCleanup runs.
const DUPLICATE_WATCH_MEDIA_TYPES = new Set(["movie", "movies", "film", "episode", "episodes", "show", "shows", "tv", "series"]);

async function findDuplicateWatchGroups(mediaType) {
  const normalized = normalizeMediaType(mediaType);
  const allHistory = await getCachedHistory();
  if (normalized === "episode") {
    // isPlembfinTrackedWatchRow, not isPlembfinTrackedEpisodeRow: this feeds
    // "keep the oldest, delete the rest" duplicate-watch cleanup, which must
    // only ever compare rows that currently read as watched. The looser
    // episode-row filter (used elsewhere so a later explicit unwatch still
    // shows in play-history counts) let a stale sync_action='unwatched' row
    // count as a "duplicate" alongside a real watched row - and since it can
    // sort first (same or earlier timestamp), the cleanup deleted the actual
    // watched row and kept the unwatched marker, wrongly unwatching the item.
    const episodeRows = allHistory.filter((row) => row.media_type === "episode" && isPlektTrackedWatchRow(row));
    return dedupeHistory(episodeRows).filter((row) => Array.isArray(row.playHistory) && row.playHistory.length > 1);
  }
  if (normalized === "movie") {
    const movieRows = allHistory.filter((row) => row.media_type === "movie" && isPlektTrackedWatchRow(row));
    return dedupeHistory(movieRows).filter((row) => Array.isArray(row.playHistory) && row.playHistory.length > 1);
  }
  return [];
}

export async function handleDuplicateWatchScan(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const rawMediaType = String(req.query.mediaType || req.query.type || "").toLowerCase();
  const mediaType = normalizeMediaType(rawMediaType);
  if (!["movie", "episode"].includes(mediaType)) return sendJson(res, { error: "mediaType must be 'movie' or 'episode'" }, 400);

  const groups = await findDuplicateWatchGroups(mediaType);
  const removable = groups.reduce((sum, row) => sum + row.playHistory.length - 1, 0);
  return sendJson(res, {
    ok: true,
    mediaType,
    itemsWithDuplicates: groups.length,
    removable,
    samples: groups.slice(0, 20).map((row) => ({
      title: row.title,
      showTitle: row.show_title,
      season: row.season,
      episode: row.episode,
      watchCount: row.playHistory.length,
    })),
  }, 200, { "Cache-Control": "no-store" });
}

// Deletes every removable duplicate found by handleDuplicateWatchScan, in
// batches (deleteWatchDates itself is capped at 500 ids per call by
// handleDeleteWatchDates, but this calls the dataRepo function directly so
// the batch size here is just a self-imposed chunk size). Reuses the same
// keep-oldest, propagate-canonical-state path as the per-season cleanup.
const DUPLICATE_WATCH_BATCH_SIZE = 300;

export async function handleDuplicateWatchCleanup(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const rawMediaType = String(body.mediaType || body.type || "").toLowerCase();
  const mediaType = normalizeMediaType(rawMediaType);
  if (!["movie", "episode"].includes(mediaType)) return sendJson(res, { error: "mediaType must be 'movie' or 'episode'" }, 400);

  const groups = await findDuplicateWatchGroups(mediaType);
  const removableIds = groups.flatMap((row) => row.playHistory.slice(1).map((entry) => entry.id).filter(Boolean));

  let removed = 0;
  for (let i = 0; i < removableIds.length; i += DUPLICATE_WATCH_BATCH_SIZE) {
    const batch = removableIds.slice(i, i + DUPLICATE_WATCH_BATCH_SIZE);
    const { affectedMedia, deleted } = await deleteWatchDates(batch);
    removed += deleted.length;
    for (const media of coalesceWatchDateRemovals(affectedMedia || [])) {
      propagateWatchDateRemoval(media.remainingRow, media.deletedRow, { lane: "sync", deletedRows: media.deletedRows });
    }
  }

  writeAuditLog("media.duplicate_watches_bulk_removed", {
    ip: req.ip || req.socket?.remoteAddress,
    detail: { mediaType, itemsAffected: groups.length, removed },
  });
  return sendJson(res, { ok: true, mediaType, itemsAffected: groups.length, removed }, 200, { "Cache-Control": "no-store" });
}

// Updates existing watch rows only. Season/show date edits use this bulk path
// so each selected episode can receive its own release date without the
// single-row editor's same-day duplicate propagation or any history inserts.
export async function handleUpdateWatchDates(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST" && req.method !== "PATCH") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const result = await updateWatchDates(body.updates);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);
  for (const updatedId of result.updated_ids || []) propagateCorrectedWatchDate(updatedId, { lane: "sync" });
  return sendJson(res, result);
}

export async function handleUpdateWatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "PATCH" && req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const requestedId = String(body.id || "").trim();
  const mediaKey = String(body.media_key || "").trim();
  if (!requestedId && !mediaKey) return sendJson(res, { error: "id is required" }, 400);

  // A row can be replaced between the moment a caller reads its id and the
  // moment it saves - an unwatch event supersedes the record - so an optional
  // media key identifies the same media when the id no longer resolves.
  let id = requestedId;
  if (mediaKey && (!id || !(await getWatchRecordByIdLight(id).catch(() => null)))) {
    const byKey = await getWatchRecordByMediaKey(mediaKey).catch(() => null);
    if (byKey?.id) id = byKey.id;
  }
  if (!id) return sendJson(res, { error: "Watch record not found" }, 400);

  const rowBeforeUpdate = await getWatchRecordByIdLight(id).catch(() => null);
  const artworkScope = String(body.artwork_scope || body.artworkScope || "").trim().toLowerCase();
  const isShowArtworkEdit = artworkScope === "show" && rowBeforeUpdate?.media_type === "episode";
  const fields = {};
  if (body.watched_at !== undefined) fields.watched_at = body.watched_at;
  // A show poster is shared artwork, not the poster for the representative
  // episode used to open the edit dialog. Keep episode artwork independent.
  if (body.poster_url !== undefined && !isShowArtworkEdit) fields.poster_url = body.poster_url;
  if (body.logo_url !== undefined) fields.logo_url = body.logo_url;
  if (body.backdrop_url !== undefined) fields.backdrop_url = body.backdrop_url;
  if (body.imdb_id !== undefined) fields.imdb_id = body.imdb_id;
  if (body.tmdb_id !== undefined) fields.tmdb_id = body.tmdb_id;
  if (body.tvdb_id !== undefined) fields.tvdb_id = body.tvdb_id;
  if (body.title !== undefined) fields.title = body.title;
  if (body.youtube_url !== undefined) fields.youtube_url = body.youtube_url;

  // Captured before the update runs â€” needed below to invalidate the cache row
  // keyed by the *previous* tmdb_id when tvdb_id changes (Fix Match rematch).
  const preUpdateRow = body.tvdb_id !== undefined ? rowBeforeUpdate : null;

  // A show-poster edit intentionally has no watch_history field to update:
  // its value is persisted below in media_artwork so the representative
  // episode keeps its own poster. Treat that as a valid request; all other
  // empty updates should still receive the repository's validation error.
  const result = isShowArtworkEdit && !Object.keys(fields).length
    ? { ok: true }
    : await updateWatchRecord(id, fields);
  if (!result.ok) return sendJson(res, { error: result.error }, 400);

  // Callers may address a record by its media_key (the manual match queue does),
  // so resolve the real row id before any of the id-keyed follow-up work below.
  const recordId = (await getWatchRecordByIdLight(id).catch(() => null))?.id || id;

  if (fields.watched_at !== undefined) propagateCorrectedWatchDate(recordId);

  // If a custom poster was chosen, cache it once and make the correct scope
  // authoritative. Show edits write the shared show-artwork record only;
  // episode artwork is never overwritten by that operation. Movie edits retain
  // their existing same-media propagation because repeated movie plays do not
  // have an episode-image exception.
  let customPosterUrl;
  let customPosterIds;
  let customBackdropUrl;
  const chosenPoster = String(body.poster_url ?? "").trim();
  const chosenPosterFetchUrl = resolveCustomPosterFetchUrl(chosenPoster);
  if (chosenPosterFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const canonicalTarget = isShowArtworkEdit
        ? {
          media_type: "tv",
          title: String(body.show_title || body.showTitle || editedRow.show_title || editedRow.title || "").trim(),
          tmdb_id: String(body.show_tmdb_id || body.showTmdbId || "").trim(),
          tvdb_id: String(body.show_tvdb_id || body.showTvdbId || "").trim(),
          imdb_id: String(body.show_imdb_id || body.showImdbId || "").trim(),
        }
        : null;
      const cacheKey = canonicalTarget ? canonicalMediaArtworkCacheKey(canonicalTarget) : editedKey;
      const cached = isCachedStorageUrl(chosenPoster)
        ? { url: chosenPoster }
        : await cachePosterFromUrl(cacheKey, chosenPosterFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        // The storage path is derived from media_key, so re-saving a poster
        // overwrites the same file at the same URL â€” browsers and the client
        // poster cache would keep serving the previous image. Append a version
        // token so each change yields a fresh URL that busts those caches.
        const versionedUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        if (canonicalTarget) {
          const savedCanonical = saveCanonicalPoster(canonicalTarget, versionedUrl, { source: "manual" });
          if (savedCanonical.ok) {
            customPosterUrl = versionedUrl;
            customPosterIds = [];
            await invalidateHistoryDerivedCaches("handleUpdateWatch").catch(() => null);
          }
        } else {
          customPosterUrl = versionedUrl;
          // A movie can have several watch-history rows for the same media. An
          // episode-specific edit, if one is ever exposed, is intentionally
          // limited to that episode so it cannot overwrite sibling artwork.
          const related = editedRow.media_type === "movie"
            ? relatedPosterRows(recordId)
            : [{ id: editedRow.id, media_key: editedKey }];
          const seenKeys = new Set([editedKey]);
          for (const row of related) {
            if (row.media_key && !seenKeys.has(row.media_key)) {
              seenKeys.add(row.media_key);
              // Cheap upsert for an already-cached storage URL (no re-download).
              await cachePosterFromUrl(row.media_key, cached.url, "custom").catch(() => null);
            }
          }
          await setWatchPosterUrls(related.map((row) => ({ id: row.id, posterUrl: versionedUrl }))).catch(() => null);
          await invalidateHistoryDerivedCaches("handleUpdateWatch").catch(() => null);
          customPosterIds = related.map((row) => row.id);
        }
      }
    }
  }

  const chosenBackdrop = String(body.backdrop_url ?? "").trim();
  const chosenBackdropFetchUrl = resolveCustomPosterFetchUrl(chosenBackdrop);
  if (chosenBackdropFetchUrl) {
    const editedRow = await getWatchRecordByIdLight(id).catch(() => null);
    const editedKey = editedRow?.media_key || (editedRow ? mediaKeyFor(editedRow) : null);
    if (editedKey) {
      const cached = await cacheBackdropFromUrl(editedKey, chosenBackdropFetchUrl, "custom").catch(() => null);
      if (cached?.url) {
        customBackdropUrl = `${cached.url}${cached.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        await setWatchBackdropUrl(recordId, customBackdropUrl).catch(() => null);
      }
    }
  }

  // If TMDB ID changed, clear any cached TMDB data for this record
  if (body.tmdb_id !== undefined) {
    const row = await getWatchRecordByIdLight(id).catch(() => null);
    if (row) {
      const mediaType = row.media_type === "movie" ? "movie" : "tv";
      const docKey = `${mediaType}_${body.tmdb_id}`;
      if (body.tmdb_id) {
        db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?").run(docKey);
      }
      // Clear the poster cache so it re-fetches with the new TMDB ID.
      const mediaKey = row.media_key;
      if (mediaKey) {
        await deletePosterCacheByMediaKey(mediaKey).catch(() => null);
      }
      // The record's own poster_url/backdrop_url survive a rematch untouched, and
      // /api/poster serves a stored storage URL directly without consulting the
      // (now-cleared) poster cache â€” so the old show/movie's artwork would keep
      // being served forever unless this request is itself uploading new artwork.
      if (body.poster_url === undefined && body.backdrop_url === undefined) {
        await clearRelatedWatchArtworkUrls(recordId).catch(() => null);
      }
    }
  }

  // If TVDB ID changed (Fix Match rematch), the old cached tv_{tmdbId} details row
  // for this record's *previous* tmdb_id still points at the wrong show â€” force it
  // stale so the next detail fetch re-resolves via the new tvdb_id instead of
  // serving mismatched cached data until the TTL happens to expire.
  if (body.tvdb_id !== undefined && preUpdateRow) {
    if (preUpdateRow.tmdb_id) {
      db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?").run(`tv_${preUpdateRow.tmdb_id}`);
    }
    if (body.tvdb_id) {
      db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(`series_${body.tvdb_id}`);
    }
    if (preUpdateRow.media_key) {
      await deletePosterCacheByMediaKey(preUpdateRow.media_key).catch(() => null);
    }
  }

  return sendJson(res, {
    ok: true,
    poster_url: customPosterUrl,
    canonical_poster_url: isShowArtworkEdit ? customPosterUrl : undefined,
    show_poster_url: isShowArtworkEdit ? customPosterUrl : undefined,
    backdrop_url: customBackdropUrl,
    updated_ids: customPosterIds,
  });
}

export async function handleRematchShow(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req);
  const alternateTraktTmdbId = String(body.trakt_tmdb_id || body.traktTmdbId || "").trim();
  if (alternateTraktTmdbId) {
    const result = await setTraktEpisodeMatch({
      id: String(body.id || "").trim(),
      showTitle: String(body.show_title || "").trim(),
      traktTmdbId: alternateTraktTmdbId,
      sourceSeason: body.trakt_source_season
        ?? body.traktSourceSeason
        ?? body.source_season
        ?? body.sourceSeason,
      sourceEpisode: body.trakt_source_episode
        ?? body.traktSourceEpisode
        ?? body.source_episode
        ?? body.sourceEpisode,
      targetSeason: body.trakt_target_season
        ?? body.traktTargetSeason
        ?? body.target_season
        ?? body.targetSeason
        ?? 1,
      targetEpisode: body.trakt_target_episode
        ?? body.traktTargetEpisode
        ?? body.target_episode
        ?? body.targetEpisode,
    });
    if (!result.ok) return sendJson(res, { error: result.error }, 400);
    return sendJson(res, {
      ok: true,
      updated_rows: result.updatedRows,
      show_title: result.showTitle,
      renamed: false,
      tvdb_id: String(body.tvdb_id || body.tvdbId || "").trim(),
      trakt_tmdb_id: result.traktTmdbId,
      trakt_source_season: result.sourceSeason,
      trakt_target_season: result.targetSeason,
      metadata_refresh: "not_required",
    }, 202);
  }
  const result = await rematchShowWatchRecords({
    id: String(body.id || "").trim(),
    showTitle: String(body.show_title || "").trim(),
    tvdbId: String(body.tvdb_id || "").trim(),
    newShowTitle: String(body.new_show_title || "").trim(),
    posterUrl: String(body.poster_url || "").trim(),
  });
  if (!result.ok) return sendJson(res, { error: result.error }, 400);
  return sendJson(res, {
    ok: true,
    updated_rows: result.updatedRows,
    show_title: result.showTitle,
    previous_show_title: result.previousShowTitle,
    renamed: result.renamed,
    tvdb_id: result.tvdbId,
    metadata_refresh: "queued",
  }, 202);
}

export async function handleMergeShows(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    return sendJson(res, { merges: listShowMerges({ targetTitle: String(req.query.target_title || "").trim() }) });
  }
  if (req.method !== "POST") return methodNotAllowed(res);

  const body = await readJson(req);
  if (String(body.action || "").toLowerCase() === "unmerge") {
    try {
      const result = await unmergeShow(String(body.id || "").trim());
      return sendJson(res, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, { error: err.message }, 400);
    }
  }
  const sourceTitle = String(body.source_title || "").trim();
  const targetTitle = String(body.target_title || "").trim();
  if (!sourceTitle || !targetTitle) return sendJson(res, { error: "source_title and target_title are required" }, 400);

  try {
    const result = await mergeShows(sourceTitle, targetTitle);
    return sendJson(res, { ok: true, id: result.id, merged: result.merged });
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
}
