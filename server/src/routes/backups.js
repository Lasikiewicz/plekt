import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout } from "../utils/outbound.js";
import { db, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions } from "../utils/activeSessions.js";
import { claimSyncOperation, clearRestoreSyncState, isAuthoritativeRestoreActive, loadMediaConfig, loadRuntimeState, releaseSyncOperation, RESTORE_KIND_BACKUP, setRuntimeState, appendRuntimeLog, touchSyncOperation } from "../utils/configStore.js";
import { markPlexUnplayedByRatingKey, fetchPlexWatchedItems } from "../utils/plexClient.js";
import { markEmbyUnplayedById, fetchEmbyWatchedItems } from "../utils/embyClient.js";
import { markJellyfinUnplayedById, fetchJellyfinWatchedItems } from "../utils/jellyfinClient.js";
import { recordOutboundUnplayedMarks, syncMediaPlaystate, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { replayTraktWatchHistory } from "../utils/trackerDispatcher.js";
import { buildCompoundEpisodeIndex, compoundEpisodeForRow } from "../utils/compoundEpisode.js";
import { createRestoreLookupCache } from "../utils/restoreLookupCache.js";
import { cancelSyncJobsForAuthoritativeRestore } from "../utils/backgroundJobs.js";
import { BACKUP_VERSION, backupManifest, exportCollectionPage, importCollectionBatch } from "../utils/backup.js";
import { isBackupFormat } from "../utils/backupNames.js";
import { brandEnv } from "../utils/brandEnv.js";
import { batchInsertWatchRecords, requireDb } from "../utils/dataRepo.js";
import {
  createWatchHistoryBackup,
  getBackupDestination,
  importWatchHistoryBackupFile,
  listRemoteBackups,
  listRemotePlektBackups,
  pullRemoteBackupToLocal,
  pullRemotePlektBackupToLocal,
  readWatchBackupFile,
  removeBackupDestination,
  clearRestoreStatus,
  pauseCronSync,
  resumeCronSync,
  setLastRestoreAt,
  loadWatchBackupRuntime,
  restoreWatchHistoryBackup,
  saveWatchBackupConfig,
  saveBackupDestination,
  testBackupDestination,
  updateDestinationSecrets,
  watchBackupStatus,
} from "../utils/watchHistoryBackups.js";
import {
  createPlektBackup,
  deletePlektBackup,
  plektBackupStatus,
  plektBackupFilePath,
  savePlektBackupConfig,
} from "../utils/plektBackups.js";
import { deviceCodeEndpoint, tokenEndpoint, ONEDRIVE_SCOPE } from "../utils/backupDestinations/onedrive.js";

const insertRestoreReportStmt = db.prepare(`
  INSERT INTO restore_reports (run_id, result_json, log_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    result_json = excluded.result_json,
    log_json = excluded.log_json,
    updated_at = excluded.updated_at
`);
const selectRestoreReportStmt = db.prepare("SELECT result_json, log_json, created_at, updated_at FROM restore_reports WHERE run_id = ?");
const pruneRestoreReportsStmt = db.prepare("DELETE FROM restore_reports WHERE run_id NOT IN (SELECT run_id FROM restore_reports ORDER BY updated_at DESC LIMIT 10)");

function summarizeRestoreResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    success: result.success !== false,
    runId: result.runId || null,
    finishedAt: result.finishedAt || null,
    ...(result.clearMode ? { clearMode: result.clearMode } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
    ...(result.restoreIssueCount != null ? { restoreIssueCount: Number(result.restoreIssueCount) || 0 } : {}),
    ...(result.cancelled ? { cancelled: true } : {}),
  };
}

function saveRestoreReport(runId, result, log = []) {
  const now = Date.now();
  db.transaction(() => {
    insertRestoreReportStmt.run(
      String(runId),
      JSON.stringify(result || null),
      JSON.stringify(Array.isArray(log) ? log : []),
      now,
      now,
    );
    pruneRestoreReportsStmt.run();
  }).immediate();
}

function loadRestoreReport(runId) {
  const row = selectRestoreReportStmt.get(String(runId || ""));
  if (!row) return null;
  let result = null;
  let log = [];
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* ignore corrupt report */ }
  try { log = row.log_json ? JSON.parse(row.log_json) : []; } catch { /* ignore corrupt report */ }
  return { result, log: Array.isArray(log) ? log : [], createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function handleImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; watch-history imports are paused until it completes." }, 409);
  }
  const body = await readJson(req);
  const records = Array.isArray(body) ? body : body.records;
  if (!Array.isArray(records)) return sendJson(res, { error: "Expected an array of records" }, 400);
  if (records.length > 100) return sendJson(res, { error: "Batch size must be 100 records or fewer" }, 413);
  return sendJson(res, { ok: true, ...(await batchInsertWatchRecords(records)) });
}

export async function handleBackupExport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const collection = String(req.query?.collection || "").trim();
  if (!collection) return sendJson(res, backupManifest(req.headers.origin || ""));

  try {
    return sendJson(res, exportCollectionPage(collection, {
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      browserSafe: true,
    }));
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

export async function handleBackupImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  if (isAuthoritativeRestoreActive()) {
    return sendJson(res, { ok: false, error: "An authoritative watch-history restore is active; backup imports are paused until it completes." }, 409);
  }

  const body = await readJson(req);
  if (!isBackupFormat(body.format) || Number(body.version) !== BACKUP_VERSION) {
    return sendJson(res, { error: "Unsupported Plekt backup format or version" }, 400);
  }

  try {
    return sendJson(res, {
      ok: true,
      ...importCollectionBatch(String(body.collection || ""), body.documents, { reset: body.reset === true, portable: body.portable === true }),
    });
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}

export async function handlePlektBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      return sendJson(res, plektBackupStatus());
    }
    let absolute;
    try {
      absolute = plektBackupFilePath(filename);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(absolute)}"`);
    res.setHeader("Content-Length", String(fs.statSync(absolute).size));
    return pipeline(fs.createReadStream(absolute), res).catch((error) => {
      console.error("Backup download failed", error.message);
    });
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: savePlektBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      const passphrase = String(body.passphrase || "").trim();
      const forceRemote = body.remote === true;
      return sendJson(res, { ok: true, backup: await createPlektBackup({ reason: "manual", passphrase, forceRemote }) });
    }
    if (action === "delete") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);
      return sendJson(res, { ok: true, ...deletePlektBackup(filename) });
    }
    if (action === "list-remote-backups") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, files: await listRemotePlektBackups(id) });
    }
    if (action === "pull-remote-backup") {
      const id = String(body.destinationId || "").trim();
      const filename = String(body.filename || "").trim();
      if (!id || !filename) return sendJson(res, { error: "destinationId and filename are required" }, 400);
      return sendJson(res, { ok: true, pulled: await pullRemotePlektBackupToLocal(id, filename) });
    }
    return sendJson(res, { error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    console.error("Backup action failed", error);
    return sendJson(res, { error: "Backup action failed" }, 500);
  }
}

// In-memory pending OneDrive device-code sessions (pendingId -> session). Short-lived
// and intentionally not persisted; a server restart simply cancels an in-flight login.
const deviceCodeSessions = new Map();

async function startOneDriveDeviceAuth(destination) {
  const clientId = destination.settings?.clientId;
  if (!clientId) throw new Error("Enter and save the OneDrive client ID first");
  const tenant = destination.settings?.tenant;
  const params = new URLSearchParams({ client_id: clientId, scope: ONEDRIVE_SCOPE });
  const response = await fetchWithTimeout(deviceCodeEndpoint(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Device code request failed (${response.status})`);

  // Drop expired sessions (otherwise they only leave the map when polled).
  for (const [id, session] of deviceCodeSessions) {
    if (session.expiresAt < Date.now()) deviceCodeSessions.delete(id);
  }
  const pendingId = crypto.randomUUID();
  deviceCodeSessions.set(pendingId, {
    destinationId: destination.id,
    clientId,
    tenant,
    deviceCode: data.device_code,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  });
  return {
    pendingId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 900,
    message: data.message,
  };
}

async function pollOneDriveDeviceAuth(pendingId) {
  const session = deviceCodeSessions.get(pendingId);
  if (!session) return { status: "error", error: "Login session expired - start again" };
  if (session.expiresAt < Date.now()) {
    deviceCodeSessions.delete(pendingId);
    return { status: "error", error: "Login code expired - start again" };
  }
  const params = new URLSearchParams({
    client_id: session.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: session.deviceCode,
  });
  const response = await fetchWithTimeout(tokenEndpoint(session.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.refresh_token) {
    updateDestinationSecrets(session.destinationId, { refreshToken: data.refresh_token });
    deviceCodeSessions.delete(pendingId);
    return { status: "authorized" };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") return { status: "pending" };
  deviceCodeSessions.delete(pendingId);
  return { status: "error", error: data.error_description || data.error || "Authorization failed" };
}

// Dropbox manual (no-redirect) OAuth: the authorize page shows a code the user pastes
// back, so no public callback URL is required for self-hosted installs.
function dropboxAuthorizeUrl(destination) {
  const appKey = destination.settings?.appKey;
  if (!appKey) throw new Error("Enter and save the Dropbox app key first");
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    token_access_type: "offline",
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeDropboxCode(destination, code) {
  const appKey = destination.settings?.appKey;
  const appSecret = destination.secrets?.appSecret;
  if (!appKey || !appSecret) throw new Error("Save the Dropbox app key and secret first");
  if (!code) throw new Error("Authorization code is required");
  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "authorization_code", code: String(code).trim() });
  const response = await fetchWithTimeout("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }, 15_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Dropbox authorization failed");
  }
  updateDestinationSecrets(destination.id, { refreshToken: data.refresh_token });
  return { status: "authorized" };
}

// Small forward cushion so an app-recorded "viewedAt" stamped a moment after our push
// can't land just past lastRestoreAt and get re-imported. See setLastRestoreAt().
const RESTORE_SKEW_BUFFER_MS = 5000;
const POST_RESTORE_WEBHOOK_GUARD_MS = 24 * 60 * 60 * 1000;
// How many items the restore push/clear processes at once, and the per-item timeout so a single
// hung app call can't stall the whole job. Keep the default conservative: each item fans out to
// every connected media server, so a value that looks modest here can otherwise create dozens
// of simultaneous requests against a home server.
const RESTORE_PUSH_CONCURRENCY = Math.min(Math.max(Number(brandEnv("RESTORE_CONCURRENCY") || 8), 1), 64);
const RESTORE_ITEM_TIMEOUT_MS = 30000;
const RESTORE_TARGET_FAILURE_THRESHOLD = Math.min(Math.max(Number(brandEnv("RESTORE_TARGET_FAILURE_THRESHOLD") || 3), 1), 10);
// Test-only, opt-in: a disposable fixture with no providers configured makes
// the whole push phase a no-op (no targets means no jobs), so a restore
// against it finishes in seconds and never exercises the poll/log UI over a
// realistic multi-minute window (see plan/active/speed/step1-phase0-quick-wins.md, Test 4). Setting this
// inserts a synthetic per-row wait, at the same concurrency the real push
// uses, so the live log and progress polling are measured honestly without
// contacting any provider. Zero (the default) is a no-op in every other case.
const DEBUG_RESTORE_PUSH_DELAY_MS = Math.max(Number(brandEnv("DEBUG_RESTORE_PUSH_DELAY_MS") || 0), 0);

function normalizedTitlePart(value = "") {
  return String(value || "").trim().toLowerCase();
}

function mediaIdsOverlap(a = {}, b = {}) {
  const idsA = a.ids || {};
  const idsB = b.ids || {};
  return Boolean(
    (idsA.imdb && idsB.imdb && String(idsA.imdb) === String(idsB.imdb)) ||
      (idsA.tmdb && idsB.tmdb && String(idsA.tmdb) === String(idsB.tmdb)) ||
      (idsA.tvdb && idsB.tvdb && String(idsA.tvdb) === String(idsB.tvdb)),
  );
}

function sameMediaCoordinates(a = {}, b = {}) {
  if (String(a.source || "") !== String(b.source || "")) return false;
  if (String(a.type || a.mediaType || "") !== String(b.type || b.mediaType || "")) return false;
  if (String(a.type || a.mediaType || "") === "episode") {
    if (Number(a.season ?? -1) !== Number(b.season ?? -1)) return false;
    if (Number(a.episode ?? -1) !== Number(b.episode ?? -1)) return false;
  }
  return mediaIdsOverlap(a, b) || normalizedTitlePart(a.title) === normalizedTitlePart(b.title);
}

export async function shouldSkipPostRestoreCompletedWebhook(media) {
  if (media?.phase !== "completed") return false;
  const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
  if (!lastRestoreAt || Date.now() - lastRestoreAt > POST_RESTORE_WEBHOOK_GUARD_MS) return false;

  const activeSessions = await listActiveSessions().catch(() => []);
  const matchingActiveSession = activeSessions.find((session) => (
    sameMediaCoordinates(media, {
      title: session.title,
      type: session.mediaType,
      source: session.source,
      ids: session.ids,
      season: session.season,
      episode: session.episode,
    }) && Number(session.updatedAt || 0) > lastRestoreAt
  ));

  return !matchingActiveSession;
}

function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  // If the timeout wins the race, the underlying promise may still reject later with nobody
  // awaiting it â€” absorb that so it doesn't surface as an unhandledRejection.
  p.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms${label ? `: ${label}` : ""}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Run `worker(item)` over `items` with at most `limit` in flight. The worker is expected to handle
// (count) its own errors; this resolves once every item has been processed.
async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

// Batched runtime-log writer (mirrors the Force-Sync pattern): collect lines in memory and
// flush to runtime_state every `intervalMs` so we don't write per line.
function createBatchedRuntimeLogger(field, { intervalMs = 2000 } = {}) {
  const buffer = [];
  let timer = null;
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, buffer.length);
    await appendRuntimeLog(field, batch).catch(() => null);
  };
  const log = (msg) => {
    console.log(msg);
    buffer.push(msg);
    if (!timer) {
      timer = setTimeout(async () => {
        timer = null;
        await flush();
      }, intervalMs);
    }
  };
  const stop = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
  };
  return { log, stop };
}

function mediaFromPlaystateRow(row, compoundIndex = null) {
  const media = {
    title: row.title,
    type: row.media_type,
    source: "restore",
    isValid: true,
    watched_at: row.watched_at || undefined,
    watchedAt: row.watched_at || undefined,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
  };
  if (String(row.media_type) === "episode") {
    media.season = row.season != null ? Number(row.season) : undefined;
    media.episode = row.episode != null ? Number(row.episode) : undefined;
    const compoundEpisode = compoundEpisodeForRow(row, compoundIndex);
    if (compoundEpisode) media.compound_episode = compoundEpisode;
  }
  return media;
}

function restoreTargetConfigured(config = {}, target) {
  const section = config?.[target] || {};
  if (section.disabled === true) return false;
  if (target === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && section.apiKey && section.userId);
}

function restoreOutcomeIsExpectedSkip(outcome = {}) {
  const state = outcome.targetState || {};
  const detail = String(
    outcome.error?.message
    || state.detail
    || outcome.summary?.details
    || "",
  ).trim();
  return state.status === "skipped" && /no matching item/i.test(detail);
}

function restoreProjectionIssue(row, outcome, historyRow = null) {
  const target = String(outcome.target || "").trim().toLowerCase();
  const state = outcome.targetState || {};
  const detail = String(
    outcome.error?.message
    || state.detail
    || outcome.summary?.details
    || "The connected app did not confirm the restored state.",
  ).trim();
  const isMissing = restoreOutcomeIsExpectedSkip(outcome);
  const sourceRowId = historyRow?.id ? String(historyRow.id) : "";
  const sourceMediaKey = row.media_key ? String(row.media_key) : "";
  const sourceTitle = String(row.title || "Unknown media");
  const type = String(row.media_type || "unknown").toLowerCase();
  return {
    key: `restore-target:${target}:${sourceMediaKey || sourceTitle}:${row.season ?? "x"}:${row.episode ?? "x"}`.slice(0, 280),
    provider: target,
    target,
    category: "media_server_projection",
    sourceRowId,
    sourceMediaKey,
    sourceTitle,
    title: sourceTitle,
    sourceShowTitle: row.show_title || historyRow?.show_title || "",
    showTitle: row.show_title || historyRow?.show_title || "",
    type,
    season: row.season != null ? Number(row.season) : undefined,
    episode: row.episode != null ? Number(row.episode) : undefined,
    sourceSeason: row.season != null ? Number(row.season) : undefined,
    sourceEpisode: row.episode != null ? Number(row.episode) : undefined,
    watchedAt: row.watched_at || undefined,
    sourceIds: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    state: String(row.state || "watched").toLowerCase() === "unwatched" ? "unwatched" : "watched",
    expectedSkip: isMissing,
    reason: isMissing
      ? `No matching item was found on ${target}; refresh or correct the library mapping, then retry.`
      : detail,
    lastError: detail,
    repairAttempts: 0,
    candidate: false,
  };
}

// Push the just-restored playstate to every connected app. Each target gets
// its own bounded operation, so a slow Emby lookup cannot make Plex,
// Jellyfin, or the Trakt replay wait for a second whole-row retry. The
// restore-scoped lookup cache is shared by all target jobs in this pass.
async function pushRestoredStateToApps(config, logLine, { shouldCancel = async () => false } = {}) {
  const loopStore = createLoopStore();
  const lookupCache = createRestoreLookupCache();
  const rows = requireDb().prepare("SELECT * FROM playstate").all();
  const historyRows = requireDb().prepare("SELECT * FROM watch_history").all();
  const compoundIndex = buildCompoundEpisodeIndex(historyRows);
  const targets = ["plex", "emby", "jellyfin"].filter((target) => restoreTargetConfigured(config, target));
  const historyByMediaKey = new Map();
  for (const row of historyRows) {
    const mediaKey = String(row.media_key || "").trim();
    if (mediaKey && !historyByMediaKey.has(mediaKey)) historyByMediaKey.set(mediaKey, row);
  }
  const indexedRows = rows.map((row, index) => ({ row, index }));
  const jobs = indexedRows.flatMap(({ row, index }) => targets.map((target) => ({ row, index, target })));
  logLine(`Pushing ${rows.length} restored item(s) to connected apps (target concurrency ${RESTORE_PUSH_CONCURRENCY}; ${targets.length || "no"} target${targets.length === 1 ? "" : "s"})...`);
  let done = 0;
  let cancelled = false;
  const outcomes = new Map();
  const targetHealth = new Map(targets.map((target) => [target, {
    transportFailures: 0,
    circuitOpen: false,
  }]));

  const isTransportFailure = (outcome) => {
    const detail = String(outcome.error?.message || outcome.targetState?.detail || "").toLowerCase();
    return !outcome.targetState
      || /timed out|timeout|network|refused|econn|eacces|fetch failed|socket|status 4(?:01|03)\b|status 5\d\d\b/.test(detail);
  };

  const pushOne = async (row, target) => {
    const media = {
      ...mediaFromPlaystateRow(row, compoundIndex),
      syncTargets: [target],
      restoreLookupCache: lookupCache,
    };
    const isWatched = String(row.state || "watched").toLowerCase() !== "unwatched";
    const health = targetHealth.get(target);
    if (health?.circuitOpen) {
      return {
        ok: false,
        isWatched,
        target,
        media,
        error: new Error(`${target} was marked unavailable after ${RESTORE_TARGET_FAILURE_THRESHOLD} consecutive connection failures; no further calls were made in this restore.`),
      };
    }
    try {
      const summary = isWatched
        ? await withTimeout(syncMediaPlaystate(media, config, loopStore, {
          includeTrackers: false,
          trackDispatch: false,
          shouldDefer: shouldCancel,
        }), RESTORE_ITEM_TIMEOUT_MS, `${target}: ${media.title}`)
        : await withTimeout(syncMediaUnplayedPlaystate(media, config, loopStore, {
          includeTrackers: false,
          trackDispatch: false,
          shouldDefer: shouldCancel,
        }), RESTORE_ITEM_TIMEOUT_MS, `${target}: ${media.title}`);
      const targetState = (summary?.targetStates || []).find((entry) => entry.target === target);
      const wasCancelled = Boolean(summary?.deferred || targetState?.status === "deferred" || await shouldCancel());
      const expectedSkip = !wasCancelled && restoreOutcomeIsExpectedSkip({ summary, targetState });
      const outcome = {
        // A media item that is absent from one connected library is an
        // expected availability skip during a restore, not a failed restore.
        ok: !wasCancelled && (targetState?.status === "success" || expectedSkip),
        expectedSkip,
        cancelled: wasCancelled,
        isWatched,
        target,
        media,
        summary,
        targetState,
      };
      if (!outcome.ok && !outcome.cancelled && isTransportFailure(outcome)) {
        health.transportFailures += 1;
        if (health.transportFailures >= RESTORE_TARGET_FAILURE_THRESHOLD) {
          health.circuitOpen = true;
          logLine(`  ! ${target} has reached ${RESTORE_TARGET_FAILURE_THRESHOLD} connection failures; remaining ${target} restore items will be recorded for attention without more remote calls.`);
        }
      } else if (outcome.ok) {
        health.transportFailures = 0;
      }
      return outcome;
    } catch (error) {
      const outcome = { ok: false, isWatched, target, media, error };
      if (isTransportFailure(outcome)) {
        health.transportFailures += 1;
        if (health.transportFailures >= RESTORE_TARGET_FAILURE_THRESHOLD) {
          health.circuitOpen = true;
          logLine(`  ! ${target} has reached ${RESTORE_TARGET_FAILURE_THRESHOLD} connection failures; remaining ${target} restore items will be recorded for attention without more remote calls.`);
        }
      }
      return outcome;
    }
  };

  const progress = () => {
    let watched = 0;
    let unwatched = 0;
    let failed = 0;
    let expectedSkipped = 0;
    let expectedSkipRows = 0;
    for (const { row, index } of indexedRows) {
      if (!targets.length) {
        if (String(row.state || "watched").toLowerCase() === "unwatched") unwatched++;
        else watched++;
        continue;
      }
      const rowOutcomes = targets.map((target) => outcomes.get(`${index}:${target}`));
      if (rowOutcomes.some((outcome) => outcome?.cancelled)) continue;
      if (rowOutcomes.length === targets.length && rowOutcomes.every((outcome) => outcome?.ok)) {
        const rowExpectedSkips = rowOutcomes.filter((outcome) => outcome?.expectedSkip).length;
        expectedSkipped += rowExpectedSkips;
        if (rowExpectedSkips) expectedSkipRows++;
        if (String(row.state || "watched").toLowerCase() === "unwatched") unwatched++;
        else watched++;
      } else if (rowOutcomes.some(Boolean)) {
        failed++;
      }
    }
    return { watched, unwatched, failed, expectedSkipped, expectedSkipRows };
  };

  await runWithConcurrency(jobs, RESTORE_PUSH_CONCURRENCY, async ({ row, index, target }) => {
    if (await shouldCancel()) {
      cancelled = true;
      outcomes.set(`${index}:${target}`, { ok: false, cancelled: true, target });
      return;
    }
    const outcome = await pushOne(row, target);
    outcomes.set(`${index}:${target}`, outcome);
    if (!outcome.ok && !outcome.cancelled) {
      logLine(`  ! Failed to push "${outcome.media.title}" to ${target}: ${outcome.error?.message || outcome.targetState?.detail || "target reported an error"}`);
    }
    if (outcome.cancelled) cancelled = true;
    done++;
    if (done % 25 === 0 || done === jobs.length) {
      const current = progress();
      logLine(`  Pushed ${done}/${jobs.length} target operation(s) (rows complete: watched ${current.watched}, unwatched ${current.unwatched}, failed ${current.failed})`);
    }
  });

  if (!targets.length && DEBUG_RESTORE_PUSH_DELAY_MS > 0) {
    logLine(`[debug] PLEKT_DEBUG_RESTORE_PUSH_DELAY_MS=${DEBUG_RESTORE_PUSH_DELAY_MS}: simulating provider push latency across ${rows.length} item(s) at concurrency ${RESTORE_PUSH_CONCURRENCY}. No provider is contacted.`);
    let simulated = 0;
    await runWithConcurrency(indexedRows, RESTORE_PUSH_CONCURRENCY, async () => {
      if (await shouldCancel()) {
        cancelled = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, DEBUG_RESTORE_PUSH_DELAY_MS));
      simulated++;
      if (simulated % 25 === 0 || simulated === indexedRows.length) {
        logLine(`  [debug] Simulated ${simulated}/${indexedRows.length} item(s)...`);
      }
    });
  }

  const issues = [];
  const expectedSkips = [];
  for (const { row, index, target } of jobs) {
    const outcome = outcomes.get(`${index}:${target}`);
    if (!outcome || outcome.cancelled) continue;
    if (outcome.expectedSkip) {
      expectedSkips.push(restoreProjectionIssue(row, outcome, historyByMediaKey.get(String(row.media_key || "").trim())));
    } else if (!outcome.ok) {
      issues.push(restoreProjectionIssue(row, outcome, historyByMediaKey.get(String(row.media_key || "").trim())));
    }
  }
  const final = progress();
  return {
    total: rows.length,
    ...final,
    issues,
    expectedSkips,
    expectedSkipCount: expectedSkips.length,
    targetOperations: jobs.length,
    cancelled,
  };
}

// Full-wipe clear pass: mark every item each app currently reports as watched as unwatched,
// so that the subsequent push re-marks only the backup's watched set and the apps end up
// matching the backup exactly. Operates on native item ids (no re-resolution).
async function clearAppWatchstates(config, logLine, { shouldCancel = async () => false } = {}) {
  const summary = { plex: 0, emby: 0, jellyfin: 0, failed: 0, cancelled: false };
  const loopStore = createLoopStore();
  const plexActive = !config?.plex?.disabled && Boolean(config?.plex?.baseUrl && config?.plex?.token);
  const embyActive = !config?.emby?.disabled && Boolean(config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId);
  const jellyfinActive = !config?.jellyfin?.disabled && Boolean(config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId);

  const mediaForClearedItem = (item, itemId) => ({
    source: "restore",
    title: item.title || item.Name || item.name || item.SeriesName || String(itemId || ""),
    type: String(item.type || item.Type || "").toLowerCase() === "episode" ? "episode" : "movie",
    itemId,
    ids: {
      imdb: item.imdb_id || item.imdb || item.ProviderIds?.Imdb || item.providerIds?.Imdb || undefined,
      tmdb: item.tmdb_id || item.tmdb || item.ProviderIds?.Tmdb || item.providerIds?.Tmdb || undefined,
      tvdb: item.tvdb_id || item.tvdb || item.ProviderIds?.Tvdb || item.providerIds?.Tvdb || undefined,
    },
  });

  // Mark one platform's watched items unplayed, in parallel with a per-item timeout.
  const clearPlatform = async (target, items, getId, unmark) => {
    let cleared = 0;
    let failed = 0;
    let cancelled = false;
    await runWithConcurrency(items, RESTORE_PUSH_CONCURRENCY, async (item) => {
      if (await shouldCancel()) {
        cancelled = true;
        return;
      }
      try {
        const itemId = getId(item);
        // The clear pass uses native-id endpoints rather than the normal
        // orchestrator, so explicitly prime the same outbound-unplayed ledger
        // before the request. A delayed callback from the wipe must not be
        // mistaken for a user's unwatch after the restore fence is released.
        const media = mediaForClearedItem(item, itemId);
        await recordOutboundUnplayedMarks(media, [target], loopStore).catch(() => null);
        const result = await withTimeout(unmark(itemId), RESTORE_ITEM_TIMEOUT_MS);
        if (result?.status !== "not_found") {
          await recordOutboundUnplayedMarks(mediaForClearedItem(item, result?.itemId || itemId), [target], loopStore).catch(() => null);
        }
        cleared++;
      } catch (error) {
        failed++;
      }
    });
    return { cleared, failed, cancelled };
  };

  if (plexActive) {
    try {
      const items = await fetchPlexWatchedItems(config.plex);
      if (await shouldCancel()) return { ...summary, cancelled: true };
      logLine(`Clearing ${items.length} watched item(s) on Plex...`);
      const r = await clearPlatform("plex", items, (i) => i.ratingKey || i.key, (id) => markPlexUnplayedByRatingKey(config.plex, id));
      summary.plex = r.cleared;
      summary.failed += r.failed;
      if (r.cancelled) return { ...summary, cancelled: true };
    } catch (error) {
      logLine(`  ! Plex clear failed: ${error.message}`);
      summary.failed += 1;
    }
  }
  if (embyActive) {
    try {
      const items = await fetchEmbyWatchedItems(config.emby);
      if (await shouldCancel()) return { ...summary, cancelled: true };
      logLine(`Clearing ${items.length} watched item(s) on Emby...`);
      const r = await clearPlatform("emby", items, (i) => i.Id, (id) => markEmbyUnplayedById(config.emby, id));
      summary.emby = r.cleared;
      summary.failed += r.failed;
      if (r.cancelled) return { ...summary, cancelled: true };
    } catch (error) {
      logLine(`  ! Emby clear failed: ${error.message}`);
      summary.failed += 1;
    }
  }
  if (jellyfinActive) {
    try {
      const items = await fetchJellyfinWatchedItems(config.jellyfin);
      if (await shouldCancel()) return { ...summary, cancelled: true };
      logLine(`Clearing ${items.length} watched item(s) on Jellyfin...`);
      const r = await clearPlatform("jellyfin", items, (i) => i.Id, (id) => markJellyfinUnplayedById(config.jellyfin, id));
      summary.jellyfin = r.cleared;
      summary.failed += r.failed;
      if (r.cancelled) return { ...summary, cancelled: true };
    } catch (error) {
      logLine(`  ! Jellyfin clear failed: ${error.message}`);
      summary.failed += 1;
    }
  }
  return summary;
}

function restoreIssueProvider(issue = {}) {
  return String(issue.provider || issue.target || "").trim().toLowerCase();
}

function restoreFailureMessage(issues = [], fallback = "One or more restored projections reported failures.") {
  const providers = [...new Set(issues.map(restoreIssueProvider).filter(Boolean))];
  if (!issues.length) return fallback;
  if (providers.length === 1 && providers[0] === "trakt") {
    return `Trakt rejected ${issues.length} restored play${issues.length === 1 ? "" : "s"}; item-level attention is required.`;
  }
  const providerText = providers.length ? ` on ${providers.join(", ")}` : "";
  return `${issues.length} restored item projection${issues.length === 1 ? "" : "s"} still need attention${providerText}.`;
}

// Background reconcile job, kicked off after the synchronous DB restore. Optionally wipes app
// watchstates, pushes the restored state to all apps, then stamps lastRestoreAt (AFTER the push
// so the pushes themselves fall under the cron's pre-restore filter) and clears the active flag.
async function runRestoreReconcileJob(clearMode, ownerId) {
  const { log, stop } = createBatchedRuntimeLogger("restoreSyncLog");
  // Keep the restore guard's heartbeat fresh for the entire job so the cron never treats a
  // long-but-alive restore as stale and un-blocks itself mid-push. Fires independently of where
  // the job is (even inside a long library fetch).
  await touchSyncOperation({
    kind: RESTORE_KIND_BACKUP,
    ownerId,
    values: { restoreSyncHeartbeat: Date.now() },
  }).catch(() => null);
  const heartbeat = setInterval(() => {
    touchSyncOperation({
      kind: RESTORE_KIND_BACKUP,
      ownerId,
      values: { restoreSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  let result;
  const restoreStillOwned = async () => {
    const runtime = await loadRuntimeState().catch(() => null);
    return runtime?.restoreSyncActive === true && String(runtime.restoreSyncRunId || "") === String(ownerId);
  };
  try {
    const config = await loadMediaConfig();
    if (!(await restoreStillOwned())) throw new Error("Authoritative restore was cancelled before app reconciliation started");
    let cleared = null;
    if (clearMode === "wipe") {
      log("Clear mode: full wipe - marking every watched item on each app as unwatched.");
      cleared = await clearAppWatchstates(config, log, { shouldCancel: async () => !(await restoreStillOwned()) });
      if (cleared.cancelled || !(await restoreStillOwned())) throw new Error("Authoritative restore was cancelled during app watch-state clearing");
      log(`Clear complete: Plex ${cleared.plex}, Emby ${cleared.emby}, Jellyfin ${cleared.jellyfin}, failed ${cleared.failed}.`);
    } else {
      log("Clear mode: reconcile - pushing only items tracked by the backup.");
    }
    const pushed = await pushRestoredStateToApps(config, log, { shouldCancel: async () => !(await restoreStillOwned()) });
    if (pushed.cancelled || !(await restoreStillOwned())) throw new Error("Authoritative restore was cancelled during app reconciliation");
    log(`Push complete: ${pushed.watched} watched, ${pushed.unwatched} unwatched, ${pushed.failed} failed row(s), ${pushed.issues.length} actionable target issue(s), ${pushed.expectedSkipCount || 0} expected availability skip(s).`);
    const historyRows = requireDb().prepare("SELECT * FROM watch_history WHERE sync_action IS NULL OR sync_action NOT IN ('unwatched', 'unplayed') ORDER BY watched_at ASC, id ASC").all();
    log(`Replaying ${historyRows.length} historical watched event(s) to Trakt...`);
    let trakt;
    try {
      trakt = await replayTraktWatchHistory(historyRows, {
        logger: log,
        shouldCancel: async () => !(await restoreStillOwned()),
      });
    } catch (error) {
      // A target-level app failure must not prevent the Trakt replacement from
      // running. Preserve both issue sets so the attention screen can repair
      // each target independently after the pass completes.
      trakt = {
        success: false,
        error: error.message || String(error),
        ...(Array.isArray(error.restoreIssues) ? { restoreIssues: error.restoreIssues } : {}),
        ...(error.restoreIssueCount != null ? { restoreIssueCount: Number(error.restoreIssueCount) || 0 } : {}),
        ...(error.restoreIssuesComplete !== undefined ? { restoreIssuesComplete: error.restoreIssuesComplete !== false } : {}),
      };
      log(`  ! Trakt replay ended with attention: ${trakt.error}`);
    }
    if (trakt?.skipped) log(`Trakt replay skipped: ${trakt.reason}.`);
    const pushedIssues = Array.isArray(pushed.issues) ? pushed.issues : [];
    const traktIssues = Array.isArray(trakt?.restoreIssues)
      ? trakt.restoreIssues.map((issue) => ({
        ...issue,
        provider: issue?.provider || "trakt",
        target: issue?.target || "trakt",
      }))
      : [];
    const restoreIssues = [...pushedIssues, ...traktIssues];
    const appSuccess = !cleared?.failed && !pushed.failed && pushedIssues.length === 0;
    const traktSuccess = Boolean(trakt && trakt.success !== false && !trakt.error);
    const success = appSuccess && traktSuccess && restoreIssues.length === 0;
    const traktIssueCount = Math.max(Number(trakt?.restoreIssueCount) || 0, traktIssues.length);
    const restoreIssuesComplete = !traktIssueCount
      || (traktIssues.length >= traktIssueCount && trakt?.restoreIssuesComplete !== false);
    result = {
      success,
      runId: ownerId,
      finishedAt: Date.now(),
      clearMode,
      cleared,
      pushed,
      trakt,
      ...(success ? {} : {
        error: restoreFailureMessage(restoreIssues, trakt?.error || "One or more restored projections reported failures."),
        ...(restoreIssues.length || traktIssueCount ? {
          restoreIssues,
          restoreIssueCount: Math.max(restoreIssues.length, traktIssueCount),
          restoreIssuesComplete,
        } : {}),
      }),
    };
  } catch (error) {
    log(`ERROR: Restore reconcile failed: ${error.message}`);
    const finishedAt = Date.now();
    const restoreIssues = Array.isArray(error.restoreIssues) ? error.restoreIssues : [];
    result = {
      success: false,
      runId: ownerId,
      finishedAt,
      error: error.message,
      ...(restoreIssues.length || error.restoreIssueCount != null ? {
        restoreIssues,
        restoreIssueCount: Number(error.restoreIssueCount) || restoreIssues.length,
        restoreIssuesComplete: error.restoreIssuesComplete !== false,
      } : {}),
    };
  } finally {
    clearInterval(heartbeat);
    if (result?.success) {
      // Only advance the watermark after every connected projection and the
      // Trakt play-log replacement have succeeded. A failed restore must keep
      // normal sync fenced so it cannot overwrite a partially repaired state.
      const stampedAt = Date.now() + RESTORE_SKEW_BUFFER_MS;
      setLastRestoreAt(stampedAt);
      log(`Stamped lastRestoreAt = ${new Date(stampedAt).toISOString()}; cron will skip app history up to this point.`);
      log("✓ Authoritative restore complete.");
      await stop();
      const completedRuntime = await loadRuntimeState().catch(() => ({}));
      try {
        saveRestoreReport(ownerId, result, completedRuntime.restoreSyncLog);
      } catch (error) {
        console.error("Failed to persist completed restore report", error);
      }
      await releaseSyncOperation({
        kind: RESTORE_KIND_BACKUP,
        ownerId,
        values: {
          restoreSyncActive: false,
          restoreSyncRunId: "",
          restoreSyncKind: "",
          restoreSyncCancelRequested: false,
          restoreSyncHeartbeat: Date.now(),
          restoreSyncResult: null,
          restoreSyncLog: [],
          restoreSyncReportId: ownerId,
          restoreSyncSummary: summarizeRestoreResult(result),
        },
      }).catch(() => null);
    } else {
      log("Restore remains paused after the failure. Retry the restore or clear its status before resuming normal sync.");
      await stop();
      const failedRuntime = await loadRuntimeState().catch(() => ({}));
      try {
        saveRestoreReport(ownerId, result || { success: false }, failedRuntime.restoreSyncLog);
      } catch (error) {
        console.error("Failed to persist failed restore report", error);
      }
      await touchSyncOperation({
        kind: RESTORE_KIND_BACKUP,
        ownerId,
        values: {
          restoreSyncResult: null,
          restoreSyncLog: [],
          restoreSyncReportId: ownerId,
          restoreSyncSummary: summarizeRestoreResult(result || { success: false }),
          restoreSyncHeartbeat: Date.now(),
        },
      }).catch(() => null);
    }
  }
  return result;
}

// Run the synchronous DB restore, then kick off the background clear/push job. Shared by the
// local "restore" and remote "restore-remote-backup" actions. Returns the response payload.
async function startAuthoritativeRestore(filename, clearMode) {
  const restoreRunId = crypto.randomUUID();
  const startedAt = Date.now();
  const claim = await claimSyncOperation({
    kind: RESTORE_KIND_BACKUP,
    ownerId: restoreRunId,
    activeField: "restoreSyncActive",
    startedAt,
    preempt: true,
    values: {
      restoreSyncRunId: restoreRunId,
      restoreSyncKind: RESTORE_KIND_BACKUP,
      restoreSyncCancelRequested: false,
      restoreSyncStartedAt: startedAt,
      restoreSyncHeartbeat: startedAt,
      restoreSyncResult: null,
      restoreSyncSummary: null,
      restoreSyncReportId: "",
      restoreSyncLog: [`Authoritative restore started (${clearMode}) from ${filename}...`],
    },
  });
  if (!claim?.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Another sync operation is already active.",
        operation: claim?.active || null,
      },
    };
  }

  let restore;
  try {
    // Cancel queued work and ask running workers to stop before the restored
    // tables are written. Their shared outbound gates also reject any later
    // batches that were already in flight when this claim was taken.
    cancelSyncJobsForAuthoritativeRestore();
    restore = restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: false });
    writeAuditLog("backup.restored", { detail: { filename, clearMode, records: restore?.imported } });
  } catch (error) {
    const finishedAt = Date.now();
    const failedResult = { success: false, runId: restoreRunId, finishedAt, error: error.message };
    try { saveRestoreReport(restoreRunId, failedResult, [`Authoritative restore started (${clearMode}) from ${filename}...`]); } catch { /* retain the small summary below */ }
    await releaseSyncOperation({
      kind: RESTORE_KIND_BACKUP,
      ownerId: restoreRunId,
      values: {
        restoreSyncActive: false,
        restoreSyncRunId: "",
        restoreSyncKind: "",
        restoreSyncCancelRequested: false,
        restoreSyncHeartbeat: finishedAt,
        restoreSyncResult: null,
        restoreSyncLog: [],
        restoreSyncReportId: restoreRunId,
        restoreSyncSummary: summarizeRestoreResult(failedResult),
      },
    }).catch(() => null);
    return { status: 400, body: { error: error.message } };
  }

  // Fire-and-forget â€” the job stamps lastRestoreAt and clears the flag when it finishes.
  void runRestoreReconcileJob(clearMode, restoreRunId).catch((error) => {
    console.error("Authoritative restore reconcile crashed", error);
  });

  return { status: 202, body: { ok: true, restore, clearMode, jobStarted: true } };
}

export async function handleWatchBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const filename = String(req.query?.download || "").trim();
    if (!filename) {
      const runtime = await loadRuntimeState();
      const since = Math.min(Math.max(Number(req.query?.since) || 0, 0), 1_000_000);
      const reportId = String(runtime.restoreSyncReportId || "");
      const includeReport = ["1", "true", "yes"].includes(String(req.query?.report || req.query?.includeReport || "").toLowerCase());
      const active = runtime.restoreSyncActive === true;
      let log = active && Array.isArray(runtime.restoreSyncLog)
        ? runtime.restoreSyncLog.slice(since)
        : [];
      let result = active ? null : (runtime.restoreSyncSummary || runtime.restoreSyncResult || null);
      if (includeReport && reportId) {
        const report = loadRestoreReport(reportId);
        if (report) {
          log = report.log.slice(since);
          result = report.result || result;
        }
      }
      return sendJson(res, {
        ...watchBackupStatus(),
        restoreSync: {
          active,
          log,
          result,
          reportId: reportId || null,
          startedAt: runtime.restoreSyncStartedAt || null,
        },
      });
    }
    try {
      const file = readWatchBackupFile(filename);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(file.compressed.length));
      res.setHeader("X-Content-SHA256", file.checksum);
      return res.end(file.compressed);
    } catch (error) {
      return sendJson(res, { error: error.message }, 404);
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  if (String(req.query?.upload || "") === "1") {
    try {
      const uploaded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const filename = String(req.query?.filename || "");
      return sendJson(res, { ok: true, file: importWatchHistoryBackupFile({ filename, buffer: uploaded }) });
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }

  const body = await readJson(req);
  const action = String(body.action || "").trim();
  try {
    if (action === "configure") {
      return sendJson(res, { ok: true, config: saveWatchBackupConfig(body.config || {}) });
    }
    if (action === "create") {
      return sendJson(res, { ok: true, backup: await createWatchHistoryBackup({ reason: "manual", mirrorRemote: body.remote === true }) });
    }
    if (action === "restore") {
      const filename = String(body.filename || "").trim();
      if (!filename) return sendJson(res, { error: "filename is required" }, 400);

      const dryRun = body.dryRun === true;
      if (dryRun) {
        // Replace-only: restore is always authoritative; merge is no longer offered.
        return sendJson(res, {
          ok: true,
          restore: restoreWatchHistoryBackup(filename, { mode: "replace", dryRun: true }),
        });
      }

      // An authoritative restore is source-of-truth by default. Reconcile is
      // still available as an explicit opt-in for users who intentionally want
      // to preserve watched items that are absent from the backup.
      const clearMode = body.clearMode === "reconcile" ? "reconcile" : "wipe";
      const { status, body: payload } = await startAuthoritativeRestore(filename, clearMode);
      return sendJson(res, payload, status);
    }
    if (action === "save-destination") {
      return sendJson(res, { ok: true, destination: saveBackupDestination(body.destination || {}) });
    }
    if (action === "remove-destination") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, ...removeBackupDestination(id) });
    }
    if (action === "list-remote-backups") {
      const id = String(body.destinationId || "").trim();
      if (!id) return sendJson(res, { error: "destinationId is required" }, 400);
      return sendJson(res, { ok: true, files: await listRemoteBackups(id) });
    }
    if (action === "restore-remote-backup") {
      const id = String(body.destinationId || "").trim();
      const filename = String(body.filename || "").trim();
      const remoteDryRun = body.dryRun === true;
      if (!id || !filename) return sendJson(res, { error: "destinationId and filename are required" }, 400);
      const pulled = await pullRemoteBackupToLocal(id, filename);
      if (remoteDryRun) {
        return sendJson(res, {
          ok: true,
          pulled,
          restore: restoreWatchHistoryBackup(pulled.name, { mode: "replace", dryRun: true }),
        });
      }
      const clearMode = body.clearMode === "reconcile" ? "reconcile" : "wipe";
      const { status, body: payload } = await startAuthoritativeRestore(pulled.name, clearMode);
      return sendJson(res, { ...payload, pulled }, status);
    }
    if (action === "clear-restore-status") {
      const cleared = clearRestoreStatus();
      const reset = await clearRestoreSyncState({
        reason: "Authoritative watch-history restore was cleared by an administrator.",
        expectedKind: RESTORE_KIND_BACKUP,
      });
      return sendJson(res, { ok: true, ...cleared, restoreSync: reset });
    }
    if (action === "pause-cron") {
      const hours = Math.max(1, Math.min(48, Number(body.hours) || 12));
      return sendJson(res, { ok: true, ...pauseCronSync(hours * 3600000) });
    }
    if (action === "resume-cron") {
      return sendJson(res, { ok: true, ...resumeCronSync() });
    }
    if (["test-destination", "device-start", "device-poll", "oauth-url", "oauth-exchange"].includes(action)) {
      if (action === "device-poll") {
        return sendJson(res, { ok: true, ...(await pollOneDriveDeviceAuth(String(body.pendingId || ""))) });
      }
      const destination = getBackupDestination(String(body.destinationId || "").trim());
      if (!destination) return sendJson(res, { error: "Destination not found" }, 404);
      if (action === "test-destination") {
        return sendJson(res, { ok: true, result: await testBackupDestination(destination) });
      }
      if (action === "device-start") {
        return sendJson(res, { ok: true, ...(await startOneDriveDeviceAuth(destination)) });
      }
      if (action === "oauth-url") {
        return sendJson(res, { ok: true, url: dropboxAuthorizeUrl(destination) });
      }
      if (action === "oauth-exchange") {
        return sendJson(res, { ok: true, ...(await exchangeDropboxCode(destination, body.code)) });
      }
    }
    return sendJson(res, { error: "Unknown watch backup action" }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message }, 400);
  }
}
