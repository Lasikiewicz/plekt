import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { bumpDataVersion, db, parseJson, toJson } from "../db.js";
import { FULL_BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR } from "../paths.js";
import { createAdapter, DESTINATION_TYPES } from "./backupDestinations/index.js";
import { protectedSnapshotFiles } from "./syncPlans.js";
import { persistedWatchDerivedFields } from "./watchDerivedFields.js";
import {
  FULL_BACKUP_FILE_PATTERN,
  WATCH_HISTORY_BACKUP_FORMAT,
  WATCH_HISTORY_FILE_PATTERN,
  backupFileStamp,
  isEncryptedBackupFormat,
  isWatchHistoryBackupFormat,
  watchHistoryBackupFilename,
} from "./backupNames.js";

const FORMAT = WATCH_HISTORY_BACKUP_FORMAT;
const VERSION = 1;
const CONFIG_ID = "watchHistoryBackups";
const RUNTIME_ID = "watchHistoryBackups";
const DESTINATIONS_ID = "watchBackupDestinations";
// Secret fields that must never be returned to the browser, per destination type.
const SECRET_FIELDS = ["password", "secretAccessKey", "appSecret", "refreshToken"];
const FILE_PATTERN = WATCH_HISTORY_FILE_PATTERN;
// Remote destinations hold watch-history and encrypted full backups (see plembfinBackups.js)
// side by side, so remote listing/retention must be able to tell them apart.

const selectSetting = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSetting = db.prepare(`
  INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const selectRuntime = db.prepare("SELECT data FROM runtime_state WHERE id = ?");
const upsertRuntime = db.prepare(`
  INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

function validTime(value, fallback = "03:00") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
}

function safeConfig(value = {}) {
  return {
    enabled: Boolean(value.enabled),
    time: validTime(value.time),
    retention: Math.max(1, Math.min(Number(value.retention) || 7, 365)),
    remoteEnabled: Boolean(value.remoteEnabled),
    remoteTime: validTime(value.remoteTime),
    remoteRetention: Math.max(1, Math.min(Number(value.remoteRetention) || 7, 365)),
  };
}

export function loadWatchBackupConfig() {
  return safeConfig(parseJson(selectSetting.get(CONFIG_ID)?.data, {}) || {});
}

export function saveWatchBackupConfig(value = {}) {
  const config = safeConfig(value);
  upsertSetting.run(CONFIG_ID, toJson(config), Date.now());
  return config;
}

export function loadWatchBackupRuntime() {
  return parseJson(selectRuntime.get(RUNTIME_ID)?.data, {}) || {};
}

function saveRuntime(values = {}) {
  const current = loadWatchBackupRuntime();
  const next = { ...current, ...values, updatedAt: Date.now() };
  upsertRuntime.run(RUNTIME_ID, toJson(next), Date.now());
  return next;
}

function writeRuntime(data = {}) {
  upsertRuntime.run(RUNTIME_ID, toJson({ ...data, updatedAt: Date.now() }), Date.now());
}

export function pauseCronSync(durationMs = 600000) {
  const pausedUntil = Date.now() + durationMs;
  saveRuntime({ cronSyncPausedUntil: pausedUntil });
  console.log(`Cron sync paused until ${new Date(pausedUntil).toISOString()}`);
  return { pausedUntil };
}

export function resumeCronSync() {
  const runtime = loadWatchBackupRuntime();
  delete runtime.cronSyncPausedUntil;
  writeRuntime(runtime);
  console.log("Cron sync resumed");
  return { resumed: true };
}

export function isCronSyncPaused() {
  const runtime = loadWatchBackupRuntime();
  if (!runtime.cronSyncPausedUntil) return false;
  if (Date.now() >= runtime.cronSyncPausedUntil) {
    resumeCronSync();
    return false;
  }
  return true;
}

// Stamp the restore watermark. The scheduled sync permanently skips any item whose
// app-side play timestamp is <= lastRestoreAt, so this MUST be set *after* the
// authoritative restore has finished pushing fresh state to the apps - otherwise the
// pushes (stamped "now" by the apps) would be re-imported as watched-today.
export function setLastRestoreAt(timestamp = Date.now()) {
  saveRuntime({ lastRestoreAt: timestamp });
  return { lastRestoreAt: timestamp };
}

// ---- Remote backup destinations --------------------------------------------

function safeDestination(value = {}) {
  if (!DESTINATION_TYPES.includes(value.type)) throw new Error(`Unsupported destination type: ${value.type}`);
  return {
    id: String(value.id || crypto.randomUUID()),
    type: value.type,
    label: String(value.label || value.type).slice(0, 120),
    enabled: Boolean(value.enabled),
    settings: value.settings && typeof value.settings === "object" ? { ...value.settings } : {},
    secrets: value.secrets && typeof value.secrets === "object" ? { ...value.secrets } : {},
  };
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function envBackblazeDestination() {
  const bucket = envValue("BACKBLAZE_BUCKET", "B2_BUCKET");
  const region = envValue("BACKBLAZE_REGION", "B2_REGION");
  const accessKeyId = envValue("BACKBLAZE_KEY_ID", "BACKBLAZE_ACCESS_KEY_ID", "B2_KEY_ID");
  const secretAccessKey = envValue("BACKBLAZE_APPLICATION_KEY", "BACKBLAZE_SECRET_ACCESS_KEY", "B2_APPLICATION_KEY");
  if (!bucket && !region && !accessKeyId && !secretAccessKey) return null;

  return safeDestination({
    id: "env-backblaze",
    type: "backblaze",
    label: "Backblaze B2",
    enabled: false,
    settings: {
      region,
      bucket,
      accessKeyId,
      prefix: envValue("BACKBLAZE_PREFIX", "B2_PREFIX"),
    },
    secrets: {
      secretAccessKey,
    },
  });
}

function mergeEnvBackupDestinations(list = []) {
  const envBackblaze = envBackblazeDestination();
  if (!envBackblaze) return list;

  const next = Array.isArray(list) ? [...list] : [];
  const index = next.findIndex((item) => item.type === "backblaze");
  if (index === -1) return [...next, envBackblaze];

  const existing = next[index];
  const settings = { ...envBackblaze.settings, ...(existing.settings || {}) };
  const secrets = { ...envBackblaze.secrets, ...(existing.secrets || {}) };
  for (const [key, value] of Object.entries(envBackblaze.settings || {})) {
    if (!String(settings[key] || "").trim() && String(value || "").trim()) settings[key] = value;
  }
  for (const [key, value] of Object.entries(envBackblaze.secrets || {})) {
    if (!String(secrets[key] || "").trim() && String(value || "").trim()) secrets[key] = value;
  }

  next[index] = {
    ...existing,
    settings,
    secrets,
  };
  return next;
}

export function loadBackupDestinations() {
  const list = parseJson(selectSetting.get(DESTINATIONS_ID)?.data, []) || [];
  const stored = Array.isArray(list) ? list.map((item) => ({ ...item, secrets: item.secrets || {}, settings: item.settings || {} })) : [];
  return mergeEnvBackupDestinations(stored);
}

function writeBackupDestinations(list) {
  upsertSetting.run(DESTINATIONS_ID, toJson(list), Date.now());
}

// Replace secrets with "is-set" boolean flags so the UI never receives credentials.
function redactDestination(destination) {
  const secretFlags = {};
  for (const field of SECRET_FIELDS) {
    if (destination.secrets?.[field]) secretFlags[field] = true;
  }
  return {
    id: destination.id,
    type: destination.type,
    label: destination.label,
    enabled: destination.enabled,
    settings: destination.settings || {},
    secretFlags,
  };
}

export function loadBackupDestinationsRedacted() {
  return loadBackupDestinations().map(redactDestination);
}

export function getBackupDestination(id) {
  return loadBackupDestinations().find((item) => item.id === id) || null;
}

// Upsert a destination. Incoming secret fields overwrite when a non-empty value is
// supplied, are removed when explicitly null, and are otherwise preserved - so the
// UI can save settings without re-sending stored credentials.
export function saveBackupDestination(input = {}) {
  const list = loadBackupDestinations();
  const index = list.findIndex((item) => item.id === input.id);
  const existing = index >= 0 ? list[index] : null;
  const next = safeDestination({ ...input, id: existing?.id || input.id });

  next.secrets = { ...(existing?.secrets || {}) };
  if (input.secrets && typeof input.secrets === "object") {
    for (const [key, value] of Object.entries(input.secrets)) {
      if (value === null) delete next.secrets[key];
      else if (value !== undefined && value !== "") next.secrets[key] = value;
    }
  }

  if (index >= 0) list[index] = next;
  else list.push(next);
  writeBackupDestinations(list);
  return redactDestination(next);
}

export function removeBackupDestination(id) {
  const list = loadBackupDestinations().filter((item) => item.id !== id);
  writeBackupDestinations(list);
  const runtime = loadWatchBackupRuntime();
  if (runtime.destinations?.[id]) {
    const destinations = { ...runtime.destinations };
    delete destinations[id];
    saveRuntime({ destinations });
  }
  return { ok: true };
}

// Merge rotated OAuth refresh tokens (or any secret) back into storage.
export function updateDestinationSecrets(id, partial = {}) {
  const list = loadBackupDestinations();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return;
  list[index].secrets = { ...(list[index].secrets || {}), ...partial };
  writeBackupDestinations(list);
}

function adapterFor(destination) {
  return createAdapter(destination, {
    persistSecrets: (partial) => updateDestinationSecrets(destination.id, partial),
  });
}

export async function testBackupDestination(destination) {
  return adapterFor(destination).testConnection();
}

export async function listRemoteBackups(id) {
  const destination = getBackupDestination(id);
  if (!destination) throw new Error("Destination not found");
  // Remote destinations also hold encrypted full Plembfin backups; this listing feeds the
  // watch-history restore flow, so only watch-history files belong here.
  const files = await adapterFor(destination).list();
  return files.filter((file) => FILE_PATTERN.test(file.name));
}

// Download a backup from a remote destination, verify it is an intact Plembfin
// backup, and place it in the local store so the normal restore flow can use it.
// This is what makes "restore from either local or cloud" work end to end.
export async function pullRemoteBackupToLocal(id, filename) {
  const destination = getBackupDestination(id);
  if (!destination) throw new Error("Destination not found");
  const name = path.basename(String(filename || ""));
  if (!FILE_PATTERN.test(name)) throw new Error("Invalid backup filename");

  const buffer = await adapterFor(destination).download(name);
  let document;
  try {
    document = JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  } catch {
    throw new Error("Downloaded file is not a valid gzip backup");
  }
  if (!isWatchHistoryBackupFormat(document?.format) ||Number(document?.version) !== VERSION) {
    throw new Error("Downloaded file is not a Plekt watch-history backup");
  }

  fs.mkdirSync(WATCH_HISTORY_BACKUPS_DIR, { recursive: true });
  const finalPath = backupPath(name);
  const temporary = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, buffer);
  fs.renameSync(temporary, finalPath);
  return { name, sizeBytes: buffer.length };
}

export async function listRemotePlektBackups(id) {
  const destination = getBackupDestination(id);
  if (!destination) throw new Error("Destination not found");
  const files = await adapterFor(destination).list();
  return files.filter((file) => FULL_BACKUP_FILE_PATTERN.test(file.name));
}

// Download an encrypted full Plembfin backup from a remote destination and place it in
// the local store, so the existing local-file restore flow (decrypt in the browser with
// the passphrase, then import) can use it without any changes.
export async function pullRemotePlektBackupToLocal(id, filename) {
  const destination = getBackupDestination(id);
  if (!destination) throw new Error("Destination not found");
  const name = path.basename(String(filename || ""));
  if (!FULL_BACKUP_FILE_PATTERN.test(name)) throw new Error("Invalid backup filename");

  const buffer = await adapterFor(destination).download(name);
  let document;
  try {
    document = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Downloaded file is not a valid Plekt backup");
  }
  if (!isEncryptedBackupFormat(document?.format) || Number(document?.version) !== 1) {
    throw new Error("Downloaded file is not an encrypted Plekt backup");
  }

  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  const finalPath = path.join(FULL_BACKUPS_DIR, name);
  const temporary = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, buffer);
  fs.renameSync(temporary, finalPath);
  return { name, sizeBytes: buffer.length };
}

export function importWatchHistoryBackupFile({ filename = "", buffer }) {
  const compressed = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!compressed.length) throw new Error("Backup file is empty");

  let document;
  try {
    document = JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
  } catch {
    throw new Error("Uploaded file is not a valid gzip backup");
  }
  if (!isWatchHistoryBackupFormat(document?.format) ||Number(document?.version) !== VERSION) {
    throw new Error("Uploaded file is not a Plekt watch-history backup");
  }
  for (const key of ["watchHistory", "playstate", "playbackProgress"]) {
    if (!Array.isArray(document.data?.[key])) throw new Error(`Uploaded backup is missing ${key}`);
  }
  const actualChecksum = checksum(Buffer.from(JSON.stringify(document.data), "utf8"));
  if (!document.dataChecksum || document.dataChecksum !== actualChecksum) {
    throw new Error("Uploaded backup data checksum verification failed");
  }

  fs.mkdirSync(WATCH_HISTORY_BACKUPS_DIR, { recursive: true });
  const uploadedName = path.basename(String(filename || ""));
  let name = FILE_PATTERN.test(uploadedName) ? uploadedName : timestampName(new Date());
  let collisionOffset = 1;
  while (fs.existsSync(path.join(WATCH_HISTORY_BACKUPS_DIR, name))) {
    name = timestampName(new Date(Date.now() + collisionOffset * 1000));
    collisionOffset += 1;
  }

  const finalPath = backupPath(name);
  const temporary = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, compressed);
  fs.renameSync(temporary, finalPath);
  const stat = fs.statSync(finalPath);
  return {
    name,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
  };
}

async function applyRemoteRetention(adapter, retention, pattern) {
  // Retention only counts and deletes files of the same backup type as the one just
  // uploaded - watch-history and full Plembfin backups keep independent retention.
  const files = (await adapter.list()).filter((file) => pattern.test(file.name));
  // Order by the name's embedded UTC timestamp, not remote-reported mtimes, so this
  // is newest-first regardless of how the remote reports dates. The stamp alone is
  // compared: by whole name, every older-prefixed file would sort as the newest.
  const newestFirst = [...files].sort((a, b) => backupFileStamp(b.name).localeCompare(backupFileStamp(a.name)));
  for (const file of newestFirst.slice(Math.max(1, retention))) {
    await adapter.delete(file.name);
  }
}

// Mirror a freshly written local backup to every enabled remote. A remote failure is
// recorded per-destination but never invalidates or deletes the local backup.
export async function pushBackupToRemotes(localAbsolutePath, filename, retention) {
  const destinations = loadBackupDestinations().filter((item) => item.enabled);
  if (!destinations.length) return [];

  const retentionPattern = FULL_BACKUP_FILE_PATTERN.test(filename) ? FULL_BACKUP_FILE_PATTERN : FILE_PATTERN;
  const statuses = [];
  for (const destination of destinations) {
    const lastAttemptAt = Date.now();
    try {
      const adapter = adapterFor(destination);
      const { bytes, durationMs } = await adapter.upload(localAbsolutePath, filename);
      await applyRemoteRetention(adapter, retention, retentionPattern).catch(() => null);
      statuses.push({ id: destination.id, status: "success", lastAttemptAt, lastSuccessAt: Date.now(), lastError: "", bytes, durationMs });
    } catch (error) {
      statuses.push({ id: destination.id, status: "error", lastAttemptAt, lastError: error.message || String(error) });
    }
  }

  const runtime = loadWatchBackupRuntime();
  const map = { ...(runtime.destinations || {}) };
  for (const { id, ...rest } of statuses) {
    map[id] = { ...(map[id] || {}), ...rest };
  }
  saveRuntime({ destinations: map });
  return statuses;
}

function essentialWatchHistory() {
  return db.prepare(`
    SELECT id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id,
      tvdb_id, season, episode, sync_action, sync_dispatch_telemetry, sync_match_ignored_at, watch_provenance, media_key, show_title,
      show_title_lower, episode_title, episode_title_status, episode_title_checked_at,
      episode_title_resolution_error, created_at, updated_at
    FROM watch_history ORDER BY id
  `).all();
}

function essentialPlaystate() {
  return db.prepare(`
    SELECT media_key, title, title_lower, media_type, state, watched_at, last_source,
      sources, imdb_id, tmdb_id, tvdb_id, season, episode, updated_at
    FROM playstate ORDER BY media_key
  `).all();
}

function essentialProgress() {
  return db.prepare(`
    SELECT media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season,
      episode, position_ms, duration_ms, progress, updated_at
    FROM playback_progress ORDER BY media_key
  `).all();
}

function timestampName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return watchHistoryBackupFilename(stamp);
}

function checksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function backupDocument() {
  const watchHistory = essentialWatchHistory();
  const playstate = essentialPlaystate();
  const playbackProgress = essentialProgress();
  const data = { watchHistory, playstate, playbackProgress };
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    counts: {
      watchHistory: watchHistory.length,
      playstate: playstate.length,
      playbackProgress: playbackProgress.length,
    },
    dataChecksum: checksum(Buffer.from(JSON.stringify(data), "utf8")),
    data,
  };
}

function backupPath(filename) {
  const name = path.basename(String(filename || ""));
  if (!FILE_PATTERN.test(name)) throw new Error("Invalid watch-history backup filename");
  return path.join(WATCH_HISTORY_BACKUPS_DIR, name);
}

export function listWatchBackups() {
  fs.mkdirSync(WATCH_HISTORY_BACKUPS_DIR, { recursive: true });
  return fs.readdirSync(WATCH_HISTORY_BACKUPS_DIR)
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const absolute = backupPath(name);
      const stat = fs.statSync(absolute);
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => backupFileStamp(b.name).localeCompare(backupFileStamp(a.name)));
}

function applyRetention(retention) {
  // Pre-force-sync recovery snapshots referenced by recent sync plans must
  // survive normal retention while their run is still recent (M2).
  let protectedFiles = new Set();
  try {
    protectedFiles = protectedSnapshotFiles();
  } catch {
    protectedFiles = new Set();
  }
  const files = listWatchBackups();
  for (const file of files.slice(Math.max(1, retention))) {
    if (protectedFiles.has(file.name)) continue;
    fs.unlinkSync(backupPath(file.name));
  }
}

export async function createWatchHistoryBackup({ reason = "manual", mirrorRemote = false } = {}) {
  fs.mkdirSync(WATCH_HISTORY_BACKUPS_DIR, { recursive: true });
  const document = backupDocument();
  const json = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const compressed = zlib.gzipSync(json, { level: 9 });
  let createdAt = new Date();
  let filename = timestampName(createdAt);
  while (fs.existsSync(path.join(WATCH_HISTORY_BACKUPS_DIR, filename))) {
    createdAt = new Date(createdAt.getTime() + 1000);
    filename = timestampName(createdAt);
  }
  const destination = backupPath(filename);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, compressed);
  fs.renameSync(temporary, destination);
  const config = loadWatchBackupConfig();
  applyRetention(config.retention);
  const result = {
    name: filename,
    sizeBytes: compressed.length,
    checksum: checksum(compressed),
    createdAt: document.createdAt,
    counts: document.counts,
    reason,
  };
  saveRuntime({ lastSuccessAt: Date.now(), lastError: "", lastBackup: result, lastRunDate: localDateKey() });
  // Mirroring runs on its own schedule (or on-demand via the remote Back Up Now), with its
  // own retention count on the remote. Local backup is verified and durable; remote
  // mirroring is best-effort and must not throw back into the caller.
  if (mirrorRemote) {
    result.remotes = await pushBackupToRemotes(destination, filename, config.remoteRetention).catch(() => []);
  }
  return result;
}

export function readWatchBackupFile(filename) {
  const absolute = backupPath(filename);
  const compressed = fs.readFileSync(absolute);
  return { absolute, compressed, checksum: checksum(compressed) };
}

function parseBackup(filename) {
  const { compressed } = readWatchBackupFile(filename);
  let document;
  try {
    document = JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
  } catch {
    throw new Error("Backup is not valid gzip JSON");
  }
  if (!isWatchHistoryBackupFormat(document?.format) ||Number(document?.version) !== VERSION) {
    throw new Error("Unsupported watch-history backup format or version");
  }
  for (const key of ["watchHistory", "playstate", "playbackProgress"]) {
    if (!Array.isArray(document.data?.[key])) throw new Error(`Backup is missing ${key}`);
  }
  const actualChecksum = checksum(Buffer.from(JSON.stringify(document.data), "utf8"));
  if (!document.dataChecksum || document.dataChecksum !== actualChecksum) {
    throw new Error("Backup data checksum verification failed");
  }
  return document;
}

export function verifyWatchBackup(filename) {
  const document = parseBackup(filename);
  return { name: filename, checksum: readWatchBackupFile(filename).checksum, counts: document.counts, createdAt: document.createdAt };
}

function restoreSummary(document, mode) {
  return {
    mode,
    watchHistory: document.data.watchHistory.length,
    playstate: document.data.playstate.length,
    playbackProgress: document.data.playbackProgress.length,
  };
}

const insertWatch = db.prepare(`
  INSERT INTO watch_history (
    id,title,title_lower,media_type,watched_at,source,imdb_id,tmdb_id,tvdb_id,
    season,episode,sync_action,sync_dispatch_telemetry,sync_match_ignored_at,watch_provenance,media_key,show_title,show_title_lower,episode_title,
    episode_title_status,episode_title_checked_at,episode_title_resolution_error,created_at,updated_at
  ) VALUES (
    @id,@title,@title_lower,@media_type,@watched_at,@source,@imdb_id,@tmdb_id,@tvdb_id,
    @season,@episode,@sync_action,@sync_dispatch_telemetry,@sync_match_ignored_at,@watch_provenance,@media_key,@show_title,@show_title_lower,@episode_title,
    @episode_title_status,@episode_title_checked_at,@episode_title_resolution_error,@created_at,@updated_at
  ) ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,title_lower=excluded.title_lower,media_type=excluded.media_type,
    watched_at=excluded.watched_at,source=excluded.source,imdb_id=excluded.imdb_id,
    tmdb_id=excluded.tmdb_id,tvdb_id=excluded.tvdb_id,season=excluded.season,
    episode=excluded.episode,sync_action=excluded.sync_action,media_key=excluded.media_key,
    show_title=excluded.show_title,show_title_lower=excluded.show_title_lower,
    episode_title=excluded.episode_title,sync_dispatch_telemetry=excluded.sync_dispatch_telemetry,
    sync_match_ignored_at=excluded.sync_match_ignored_at,
    watch_provenance=excluded.watch_provenance,episode_title_status=excluded.episode_title_status,
    episode_title_checked_at=excluded.episode_title_checked_at,
    episode_title_resolution_error=excluded.episode_title_resolution_error,
    created_at=excluded.created_at,updated_at=excluded.updated_at
  WHERE COALESCE(excluded.updated_at,0) >= COALESCE(watch_history.updated_at,0)
`);
const insertPlaystate = db.prepare(`
  INSERT INTO playstate (
    media_key,title,title_lower,media_type,state,watched_at,last_source,sources,
    imdb_id,tmdb_id,tvdb_id,season,episode,updated_at
  ) VALUES (
    @media_key,@title,@title_lower,@media_type,@state,@watched_at,@last_source,@sources,
    @imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@updated_at
  ) ON CONFLICT(media_key) DO UPDATE SET
    title=excluded.title,title_lower=excluded.title_lower,media_type=excluded.media_type,
    state=excluded.state,watched_at=excluded.watched_at,last_source=excluded.last_source,
    sources=excluded.sources,imdb_id=excluded.imdb_id,tmdb_id=excluded.tmdb_id,
    tvdb_id=excluded.tvdb_id,season=excluded.season,episode=excluded.episode,
    updated_at=excluded.updated_at
  WHERE COALESCE(excluded.updated_at,0) >= COALESCE(playstate.updated_at,0)
`);
const insertProgress = db.prepare(`
  INSERT INTO playback_progress (
    media_key,title,media_type,source,imdb_id,tmdb_id,tvdb_id,season,episode,
    position_ms,duration_ms,progress,updated_at
  ) VALUES (
    @media_key,@title,@media_type,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,
    @position_ms,@duration_ms,@progress,@updated_at
  ) ON CONFLICT(media_key) DO UPDATE SET
    title=excluded.title,media_type=excluded.media_type,source=excluded.source,
    imdb_id=excluded.imdb_id,tmdb_id=excluded.tmdb_id,tvdb_id=excluded.tvdb_id,
    season=excluded.season,episode=excluded.episode,position_ms=excluded.position_ms,
    duration_ms=excluded.duration_ms,progress=excluded.progress,updated_at=excluded.updated_at
  WHERE COALESCE(excluded.updated_at,0) >= COALESCE(playback_progress.updated_at,0)
`);

export function restoreWatchHistoryBackup(filename, { mode = "merge", dryRun = false } = {}) {
  if (!["merge", "replace"].includes(mode)) throw new Error("Restore mode must be merge or replace");
  const document = parseBackup(filename);
  const summary = restoreSummary(document, mode);
  if (dryRun) return { ...summary, dryRun: true };

  db.transaction(() => {
    if (mode === "replace") {
      db.prepare("DELETE FROM watch_history").run();
      db.prepare("DELETE FROM playstate").run();
      db.prepare("DELETE FROM playback_progress").run();
    }
    for (const row of document.data.watchHistory) {
      const derived = persistedWatchDerivedFields(row);
      insertWatch.run({
        ...row,
        ...derived,
        sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
        sync_match_ignored_at: row.sync_match_ignored_at || null,
        watch_provenance: row.watch_provenance || null,
        episode_title_status: row.episode_title_status || (
          row.media_type === "episode" && (!row.episode_title || /^Episode\s+\d+$/i.test(String(row.episode_title)) || /^\d+$/.test(String(row.episode_title)))
            ? "missing"
            : "resolved"
        ),
        episode_title_checked_at: row.episode_title_checked_at || null,
        episode_title_resolution_error: row.episode_title_resolution_error || null,
      });
    }
    for (const row of document.data.playstate) insertPlaystate.run(row);
    for (const row of document.data.playbackProgress) insertProgress.run(row);
  })();
  bumpDataVersion();
  // NOTE: lastRestoreAt is intentionally NOT set here. The authoritative restore job
  // (handleWatchBackups in index.js) stamps it via setLastRestoreAt() only *after* it has
  // finished pushing the restored state to the connected apps. See setLastRestoreAt above.
  saveRuntime({ lastRestore: { filename, ...summary } });
  return { ...summary, dryRun: false };
}

export function watchBackupStatus() {
  return {
    config: loadWatchBackupConfig(),
    runtime: loadWatchBackupRuntime(),
    files: listWatchBackups(),
    destinations: loadBackupDestinationsRedacted(),
    backupsDir: WATCH_HISTORY_BACKUPS_DIR,
  };
}

export async function runScheduledWatchBackup() {
  const config = loadWatchBackupConfig();
  if (!config.enabled) return null;
  const now = new Date();
  const today = localDateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const runtime = loadWatchBackupRuntime();
  if (runtime.lastRunDate === today || currentTime < config.time) return null;
  try {
    return await createWatchHistoryBackup({ reason: "scheduled" });
  } catch (error) {
    saveRuntime({ lastError: error.message || String(error), lastFailureAt: Date.now(), lastRunDate: today });
    throw error;
  }
}

// Independent daily schedule for remote mirroring: creates a fresh backup and uploads it
// to every enabled destination, applying the remote retention count on the remote side.
export async function runScheduledRemoteWatchBackup() {
  const config = loadWatchBackupConfig();
  if (!config.remoteEnabled) return null;
  const now = new Date();
  const today = localDateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const runtime = loadWatchBackupRuntime();
  if (runtime.lastRemoteRunDate === today || currentTime < config.remoteTime) return null;
  try {
    const result = await createWatchHistoryBackup({ reason: "scheduled-remote", mirrorRemote: true });
    saveRuntime({ lastRemoteRunDate: today });
    return result;
  } catch (error) {
    saveRuntime({ lastError: error.message || String(error), lastFailureAt: Date.now(), lastRemoteRunDate: today });
    throw error;
  }
}

export function clearRestoreStatus() {
  const runtime = loadWatchBackupRuntime();
  delete runtime.lastRestore;
  delete runtime.lastRestoreAt;
  writeRuntime(runtime);
  return { cleared: true };
}
