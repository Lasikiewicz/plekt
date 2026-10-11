import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, parseJson, toJson } from "../db.js";
import { FULL_BACKUPS_DIR } from "../paths.js";
import { fullBackupJsonChunks } from "./backup.js";
import { ENCRYPTED_BACKUP_FORMAT, FULL_BACKUP_FILE_PATTERN, FULL_BACKUP_TEMPORARY_FILE_PATTERN, fullBackupFilename, backupFileStamp } from "./backupNames.js";
import { pushBackupToRemotes } from "./watchHistoryBackups.js";

const CONFIG_ID = "plembfinBackups";
const RUNTIME_ID = "plembfinBackups";
const FILE_PATTERN = FULL_BACKUP_FILE_PATTERN;
const TEMPORARY_FILE_PATTERN = FULL_BACKUP_TEMPORARY_FILE_PATTERN;
const STALE_TEMPORARY_MS = 10 * 60 * 1000;
const WRITE_CHUNK_CHARS = 1024 * 1024;
const SCHEDULED_ATTEMPTS_PER_DAY = 3;
const SCHEDULED_RETRY_GAP_MS = 60 * 60 * 1000;

let scheduledBackupInFlight = false;

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

function safeConfig(value = {}, previous = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : "03:00";
  const passphrase = String(value.passphrase || "").trim();
  const remotePassphrase = String(value.remotePassphrase || "").trim();
  const rememberPassphrase = value.rememberPassphrase == null
    ? Boolean(passphrase || previous.passphrase)
    : Boolean(value.rememberPassphrase);
  const remoteRememberPassphrase = value.remoteRememberPassphrase == null
    ? Boolean(remotePassphrase || previous.remotePassphrase)
    : Boolean(value.remoteRememberPassphrase);
  return {
    enabled: Boolean(value.enabled),
    time,
    retention: Math.max(1, Math.min(Number(value.retention) || 7, 365)),
    // Preserve the previous shared retention value for existing installs, then
    // keep local and remote full-backup retention independent from this point on.
    remoteRetention: Math.max(1, Math.min(Number(value.remoteRetention ?? value.retention) || 7, 365)),
    rememberPassphrase,
    passphrase: rememberPassphrase ? passphrase || String(previous.passphrase || "").trim() : "",
    remoteEnabled: Boolean(value.remoteEnabled),
    remoteRememberPassphrase,
    remotePassphrase: remoteRememberPassphrase ? remotePassphrase || String(previous.remotePassphrase || "").trim() : "",
  };
}

export function loadPlektBackupConfig() {
  return safeConfig(parseJson(selectSetting.get(CONFIG_ID)?.data, {}) || {});
}

export function savePlektBackupConfig(value = {}) {
  const previous = loadPlektBackupConfig();
  const config = safeConfig(value, previous);
  const hasLocalPassphrase = config.rememberPassphrase && config.passphrase.length >= 12;
  const hasRemotePassphrase = config.remoteRememberPassphrase && config.remotePassphrase.length >= 12;
  if (config.enabled && !hasLocalPassphrase) {
    throw new Error("Remember the Plekt backup passphrase before enabling scheduled local backups.");
  }
  if (config.remoteEnabled && !hasLocalPassphrase && !hasRemotePassphrase) {
    throw new Error("Remember a Plekt backup passphrase before enabling scheduled remote backups.");
  }
  upsertSetting.run(CONFIG_ID, toJson(config), Date.now());
  return publicConfig(config);
}

function publicConfig(config = loadPlektBackupConfig()) {
  return {
    ...config,
    passphrase: "",
    remotePassphrase: "",
    passphraseStored: Boolean(config.passphrase),
    remotePassphraseStored: Boolean(config.remotePassphrase),
  };
}

export function loadPlektBackupRuntime() {
  return parseJson(selectRuntime.get(RUNTIME_ID)?.data, {}) || {};
}

function saveRuntime(values = {}) {
  const current = loadPlektBackupRuntime();
  const next = { ...current, ...values, updatedAt: Date.now() };
  upsertRuntime.run(RUNTIME_ID, toJson(next), Date.now());
  return next;
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return fullBackupFilename(`${yyyy}${mm}${dd}T${hh}${min}${ss}Z`);
}

function backupPath(filename) {
  const clean = path.basename(filename);
  if (!FILE_PATTERN.test(clean)) throw new Error("Invalid backup filename");
  return path.join(FULL_BACKUPS_DIR, clean);
}

export function listPlektBackups() {
  if (!fs.existsSync(FULL_BACKUPS_DIR)) return [];
  return fs.readdirSync(FULL_BACKUPS_DIR)
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const absolute = path.join(FULL_BACKUPS_DIR, name);
      const stat = fs.statSync(absolute);
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => backupFileStamp(b.name).localeCompare(backupFileStamp(a.name)));
}

function applyRetention(retention) {
  const files = listPlektBackups();
  for (const file of files.slice(Math.max(1, retention))) {
    try {
      fs.unlinkSync(backupPath(file.name));
    } catch (e) {
      console.error(`Failed to delete backup ${file.name}:`, e);
    }
  }
}

// Leftovers from a backup that was killed mid-write. Only files untouched for a
// while are removed, so a backup another process is writing right now is kept.
function removeStaleTemporaryFiles(now = Date.now()) {
  if (!fs.existsSync(FULL_BACKUPS_DIR)) return;
  for (const name of fs.readdirSync(FULL_BACKUPS_DIR)) {
    if (!TEMPORARY_FILE_PATTERN.test(name)) continue;
    const absolute = path.join(FULL_BACKUPS_DIR, name);
    try {
      if (now - fs.statSync(absolute).mtimeMs < STALE_TEMPORARY_MS) continue;
      fs.unlinkSync(absolute);
    } catch (e) {
      console.error(`Failed to delete leftover backup file ${name}:`, e);
    }
  }
}

// Writes the same file JSON.stringify(encryptedObject, null, 2) used to produce,
// but encrypts and base64-encodes the backup in chunks straight to disk. Building
// it in memory needed several copies of the whole backup (about 3 GB for a 490 MB
// file), which got the process killed. Everything here is synchronous so the
// backup's row iterators never overlap other queries on the shared connection.
export function writeEncryptedPlektBackup(filePath, passphrase, { chunks = fullBackupJsonChunks() } = {}) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encryptedAt = new Date().toISOString();
  const envelope = JSON.stringify({
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    encryptedAt,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: 100000,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
    },
    payload: "",
  }, null, 2);
  const payloadAt = envelope.lastIndexOf('"payload": ""') + '"payload": "'.length;

  const fd = fs.openSync(filePath, "w");
  let sizeBytes = 0;
  let carry = Buffer.alloc(0);
  const write = (text) => {
    sizeBytes += fs.writeSync(fd, text, null, "utf8");
  };
  // base64 must be cut on 3-byte boundaries to join up with the next chunk.
  const writeEncrypted = (bytes) => {
    const combined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const usable = combined.length - (combined.length % 3);
    if (usable) write(combined.subarray(0, usable).toString("base64"));
    carry = Buffer.from(combined.subarray(usable));
  };
  try {
    write(envelope.slice(0, payloadAt));
    let pending = [];
    let pendingLength = 0;
    for (const chunk of chunks) {
      pending.push(chunk);
      pendingLength += chunk.length;
      if (pendingLength >= WRITE_CHUNK_CHARS) {
        writeEncrypted(cipher.update(pending.join(""), "utf8"));
        pending = [];
        pendingLength = 0;
      }
    }
    if (pending.length) writeEncrypted(cipher.update(pending.join(""), "utf8"));
    writeEncrypted(cipher.final());
    writeEncrypted(cipher.getAuthTag());
    if (carry.length) write(carry.toString("base64"));
    write(envelope.slice(payloadAt));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { encryptedAt, sizeBytes };
}

export async function createPlektBackup({ reason = "manual", passphrase, forceRemote = false } = {}) {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  const config = loadPlektBackupConfig();
  const actualPassphrase = passphrase || (forceRemote
    ? config.remotePassphrase || config.passphrase
    : config.passphrase || config.remotePassphrase);
  if (!actualPassphrase || actualPassphrase.length < 12) {
    throw new Error("Enter an encryption passphrase of at least 12 characters.");
  }

  removeStaleTemporaryFiles();

  let createdAt = new Date();
  let filename = timestampName(createdAt);
  while (fs.existsSync(path.join(FULL_BACKUPS_DIR, filename))) {
    createdAt = new Date(createdAt.getTime() + 1000);
    filename = timestampName(createdAt);
  }

  const destination = backupPath(filename);
  const temporary = `${destination}.tmp-${process.pid}`;
  let written;
  try {
    written = writeEncryptedPlektBackup(temporary, actualPassphrase);
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  applyRetention(config.retention);

  const result = {
    name: filename,
    sizeBytes: written.sizeBytes,
    createdAt: written.encryptedAt,
    reason,
  };

  let remoteStatus = {};
  if (config.remoteEnabled || forceRemote) {
    try {
      const statuses = await pushBackupToRemotes(destination, filename, config.remoteRetention);
      result.remotes = statuses;
      if (statuses.length) {
        const succeeded = statuses.filter((s) => s.status === "success");
        const failed = statuses.filter((s) => s.status === "error");
        remoteStatus = {
          lastRemoteAttemptAt: Date.now(),
          ...(succeeded.length ? { lastRemoteSuccessAt: Date.now() } : {}),
          lastRemoteError: failed.length ? failed[0].lastError || "Remote upload failed" : "",
        };
      } else {
        remoteStatus = {
          lastRemoteAttemptAt: Date.now(),
          lastRemoteError: "No enabled remote destinations are configured.",
        };
        result.remotes = [];
      }
    } catch (e) {
      remoteStatus = {
        lastRemoteAttemptAt: Date.now(),
        lastRemoteError: e.message || String(e),
      };
    }
  }

  saveRuntime({
    lastSuccessAt: Date.now(),
    lastError: "",
    lastBackup: result,
    lastRunDate: localDateKey(),
    attemptInProgress: false,
    ...remoteStatus
  });
  return result;
}

// Callers stream the file: backups can pass V8's ~512 MB string limit.
export function plektBackupFilePath(filename) {
  const absolute = backupPath(filename);
  if (!fs.existsSync(absolute)) throw new Error("Backup file not found");
  return absolute;
}

export function deletePlektBackup(filename) {
  const absolute = backupPath(filename);
  if (fs.existsSync(absolute)) {
    fs.unlinkSync(absolute);
  }
  return { deleted: filename };
}

export function plektBackupStatus() {
  return {
    config: publicConfig(),
    runtime: loadPlektBackupRuntime(),
    files: listPlektBackups(),
  };
}

function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A scheduled backup is marked as attempted before it starts, so one that kills
// the process is not retried on every tick after the restart (it once looped
// every minute from 03:00 to midnight). A failed day is retried at most
// SCHEDULED_ATTEMPTS_PER_DAY times, at least an hour apart (user decision,
// 27 September 2026).
export async function runScheduledPlektBackup({ now = new Date() } = {}) {
  const config = loadPlektBackupConfig();
  if (!config.enabled && !config.remoteEnabled) return null;

  let runtime = loadPlektBackupRuntime();
  if (runtime.attemptInProgress && !scheduledBackupInFlight) {
    runtime = saveRuntime({
      attemptInProgress: false,
      lastError: "The last scheduled backup stopped before finishing (the server restarted or ran out of memory).",
      lastFailureAt: Number(runtime.lastAttemptAt) || Date.now(),
    });
  }

  const today = localDateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (runtime.lastRunDate === today || currentTime < config.time) return null;

  const attempts = runtime.attemptDate === today ? Number(runtime.attemptCount) || 0 : 0;
  if (attempts >= SCHEDULED_ATTEMPTS_PER_DAY) return null;
  if (attempts > 0 && now.getTime() - (Number(runtime.lastAttemptAt) || 0) < SCHEDULED_RETRY_GAP_MS) return null;

  saveRuntime({ attemptDate: today, attemptCount: attempts + 1, lastAttemptAt: now.getTime(), attemptInProgress: true });
  scheduledBackupInFlight = true;
  try {
    const passphrase = config.passphrase || config.remotePassphrase;
    return await createPlektBackup({ reason: "scheduled", passphrase });
  } catch (error) {
    saveRuntime({ lastError: error.message || String(error), lastFailureAt: Date.now(), attemptInProgress: false });
    throw error;
  } finally {
    scheduledBackupInFlight = false;
  }
}
