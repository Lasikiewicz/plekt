import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { db } from "../db.js";
import { FULL_BACKUPS_DIR } from "../paths.js";
import { BACKUP_VERSION, BROWSER_BACKUP_COLLECTIONS, importCollectionBatch } from "./backup.js";
import { ENCRYPTED_BACKUP_FORMAT_FIELD_PATTERN, isBackupFormat, isEncryptedBackupFormat } from "./backupNames.js";
import { BackupStreamScanner } from "./backupStreamScanner.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { pauseCronSync, resumeCronSync } from "./watchHistoryBackups.js";

// Server-side restore of a full Plembfin backup file of any size. The file is
// read from disk in pieces: the base64 payload is decoded and decrypted as a
// stream and the backup document is scanned one collection document at a time.
// AES-GCM only authenticates at the end, so a first pass decrypts and checks the
// whole file (tag, format, every document) and nothing is written unless it
// passes; the second pass imports through importCollectionBatch, the same
// rules as the browser restore.

const ENCRYPTED_VERSION = 1;
const DEFAULT_ITERATIONS = 250000;
const HEADER_PEEK_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const BATCH_SIZE = 250;
const CRON_PAUSE_MS = 6 * 60 * 60 * 1000;
const UPLOAD_PREFIX = "plembfin-restore-upload-";
const UPLOAD_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const RESTORED_COLLECTIONS = new Set(BROWSER_BACKUP_COLLECTIONS);
const DECRYPT_ERROR = "Could not decrypt this Plekt backup. Check the passphrase and file.";
const DATABASE_RECOVERY_OPTIONS = Object.freeze([
  "Cancel the restore and keep the current database files for recovery.",
  "Preserve the database file (plekt.db, or plembfin.db on an older install) and its -wal/-shm sidecars, start Plekt with a clean database, then retry this backup. The backup replaces its supported collections and may not include the newest changes.",
  "Recover data from the current database with SQLite recovery tools before restoring, if you need changes newer than the backup.",
]);
const pbkdf2 = promisify(crypto.pbkdf2);

// Kept in memory, not runtime_state: restoring the runtimeState collection
// replaces that table, progress row included.
let currentJob = null;

function readHead(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_PEEK_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// The encrypted envelope is small apart from its payload string, which both the
// server and browser writers put last. Returns null for a plain backup.
export function readEncryptedEnvelope(filePath) {
  const head = readHead(filePath);
  const text = head.toString("latin1");
  if (!ENCRYPTED_BACKUP_FORMAT_FIELD_PATTERN.test(text)) return null;
  const match = /"payload"\s*:\s*"/.exec(text);
  if (!match) throw new Error("This is not a supported encrypted Plekt backup file.");
  let envelope;
  try {
    envelope = JSON.parse(`${text.slice(0, match.index).replace(/[\s,]*$/, "")}}`);
  } catch {
    throw new Error("This is not a supported encrypted Plekt backup file.");
  }
  const encryption = envelope.encryption || {};
  if (!isEncryptedBackupFormat(envelope.format) || Number(envelope.version) !== ENCRYPTED_VERSION) {
    throw new Error("This is not a supported encrypted Plekt backup file.");
  }
  if (encryption.algorithm !== "AES-256-GCM" || encryption.kdf !== "PBKDF2" || (encryption.hash && encryption.hash !== "SHA-256")) {
    throw new Error("This encrypted backup uses an unsupported encryption method.");
  }
  const iterations = Number(encryption.iterations);
  return {
    payloadOffset: match.index + match[0].length,
    salt: Buffer.from(String(encryption.salt || ""), "base64"),
    iv: Buffer.from(String(encryption.iv || ""), "base64"),
    iterations: Number.isInteger(iterations) && iterations >= 10000 && iterations <= 10000000 ? iterations : DEFAULT_ITERATIONS,
  };
}

async function* plainChunks(filePath, onBytes) {
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })) {
    onBytes(chunk.length);
    yield chunk;
  }
}

// Decodes the base64 payload on 4-character boundaries and holds back the last
// 16 decoded bytes, which are the GCM tag. Throws DECRYPT_ERROR at the end when
// the passphrase is wrong or the file was changed.
async function* decryptedChunks(filePath, envelope, key, onBytes) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.iv);
  let carry = "";
  let held = Buffer.alloc(0);
  let ended = false;
  onBytes(envelope.payloadOffset);
  const feed = (text) => {
    const combined = carry + text;
    const usable = combined.length - (combined.length % 4);
    carry = combined.slice(usable);
    if (!usable) return null;
    const bytes = Buffer.concat([held, Buffer.from(combined.slice(0, usable), "base64")]);
    held = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 16)));
    const body = bytes.subarray(0, Math.max(0, bytes.length - 16));
    return body.length ? decipher.update(body) : null;
  };
  for await (const chunk of fs.createReadStream(filePath, { start: envelope.payloadOffset, highWaterMark: READ_CHUNK_BYTES })) {
    onBytes(chunk.length);
    if (ended) continue;
    const quote = chunk.indexOf(0x22);
    const text = (quote >= 0 ? chunk.subarray(0, quote) : chunk).toString("latin1");
    if (quote >= 0) ended = true;
    const plain = feed(text);
    if (plain?.length) yield plain;
  }
  // Both writers pad their base64, so a complete payload leaves no carry.
  if (!ended || carry || held.length !== 16) throw new Error(DECRYPT_ERROR);
  let last;
  try {
    decipher.setAuthTag(held);
    last = decipher.final();
  } catch {
    throw new Error(DECRYPT_ERROR);
  }
  if (last.length) yield last;
}

// With drainOnError, a scan error still reads the rest of the stream, so a wrong
// passphrase (garbage plaintext) is reported by the auth tag check rather than
// as invalid JSON.
async function scan(chunks, handlers, { drainOnError = false } = {}) {
  const scanner = new BackupStreamScanner(handlers);
  const decoder = new StringDecoder("utf8");
  let failure = null;
  for await (const chunk of chunks) {
    if (failure) continue;
    try {
      const text = decoder.write(chunk);
      if (text) scanner.write(text);
    } catch (error) {
      if (!drainOnError) throw error;
      failure = error;
    }
  }
  if (failure) throw failure;
  const rest = decoder.end();
  if (rest) scanner.write(rest);
  scanner.end();
}

function validDocument(document) {
  return Boolean(document) && typeof document.id === "string" && document.id !== ""
    && typeof document.data === "object" && document.data !== null;
}

async function verifyBackup(open) {
  const header = {};
  const counts = new Map();
  await scan(open(), {
    onField: (key, value) => { header[key] = value; },
    wantsDocuments: (name) => RESTORED_COLLECTIONS.has(name),
    onCollectionStart: (name) => { if (RESTORED_COLLECTIONS.has(name)) counts.set(name, 0); },
    onDocument: (name, document) => {
      if (!validDocument(document)) throw new Error(`${name} contains an invalid document.`);
      counts.set(name, counts.get(name) + 1);
    },
  }, { drainOnError: true });
  if (!isBackupFormat(header.format) || Number(header.version) !== BACKUP_VERSION) {
    throw new Error("This is not a supported Plekt backup file.");
  }
  if (!counts.size) throw new Error("The backup contains no supported collections.");
  return { portable: header.portable === true, counts };
}

async function importBackup(open, { portable, job }) {
  let batch = [];
  let firstBatch = true;
  const flush = (name) => {
    importCollectionBatch(name, batch, { reset: firstBatch, portable });
    job.imported += batch.length;
    job.collectionImported += batch.length;
    firstBatch = false;
    batch = [];
  };
  await scan(open(), {
    wantsDocuments: (name) => RESTORED_COLLECTIONS.has(name),
    onCollectionStart: (name) => {
      if (!RESTORED_COLLECTIONS.has(name)) return;
      firstBatch = true;
      batch = [];
      job.collection = name;
      job.collectionImported = 0;
      job.collectionTotal = job.counts[name] || 0;
    },
    onDocument: (name, document) => {
      batch.push(document);
      if (batch.length >= BATCH_SIZE) flush(name);
    },
    onCollectionEnd: (name) => {
      if (!RESTORED_COLLECTIONS.has(name)) return;
      if (batch.length || firstBatch) flush(name);
      job.collectionsDone += 1;
      // Restoring runtimeState replaces the row that holds the cron pause.
      if (name === "runtimeState") pauseCronSync(CRON_PAUSE_MS);
    },
  });
}

function publicJob(job) {
  if (!job) return null;
  const { passphrase: _passphrase, filePath: _filePath, ...rest } = job;
  return { ...rest };
}

export function getPlektRestoreJob() {
  return publicJob(currentJob);
}

export function uploadedBackupPath(uploadId) {
  const id = String(uploadId || "").trim();
  if (!UPLOAD_PATTERN.test(id)) throw new Error("Invalid upload id");
  return path.join(FULL_BACKUPS_DIR, `${UPLOAD_PREFIX}${id}.json`);
}

function removeStaleUploads(now = Date.now()) {
  if (!fs.existsSync(FULL_BACKUPS_DIR)) return;
  for (const name of fs.readdirSync(FULL_BACKUPS_DIR)) {
    if (!name.startsWith(UPLOAD_PREFIX)) continue;
    const absolute = path.join(FULL_BACKUPS_DIR, name);
    try {
      if (now - fs.statSync(absolute).mtimeMs >= STALE_UPLOAD_MS) fs.unlinkSync(absolute);
    } catch (error) {
      console.error(`Failed to delete old restore upload ${name}:`, error);
    }
  }
}

// Streams an uploaded backup to disk. The file is kept (a day at most) so a
// wrong passphrase can be retried without uploading again.
export async function saveUploadedBackup(readable) {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  removeStaleUploads();
  const uploadId = crypto.randomUUID();
  const destination = uploadedBackupPath(uploadId);
  try {
    await pipeline(readable, fs.createWriteStream(destination));
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
  return { uploadId, sizeBytes: fs.statSync(destination).size };
}

// Runs the whole restore and resolves when it has finished (or failed); the
// route starts it without awaiting and the Restore page polls the job.
function assertCanStart(filePath) {
  if (currentJob && ["verifying", "importing"].includes(currentJob.status)) {
    throw Object.assign(new Error("A Plekt restore is already running."), { status: 409 });
  }
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; backup imports are paused until it completes."), { status: 409 });
  }
  if (!fs.existsSync(filePath)) throw Object.assign(new Error("Backup file not found"), { status: 404 });
  let check;
  try {
    check = db.pragma("quick_check");
  } catch {
    check = null;
  }
  if (!Array.isArray(check) || check.length !== 1 || check[0]?.quick_check !== "ok") {
    throw Object.assign(new Error("The current Plekt database failed its SQLite integrity check. The restore was not started and no data was changed."), {
      status: 409,
      code: "DATABASE_CORRUPT",
      recoveryOptions: DATABASE_RECOVERY_OPTIONS,
    });
  }
}

export async function runPlektRestore({ filePath, passphrase = "", label = "", removeAfter = false }, { prechecked = false } = {}) {
  if (!prechecked) assertCanStart(filePath);
  const stat = fs.statSync(filePath);
  const job = {
    id: crypto.randomUUID(),
    label,
    status: "verifying",
    startedAt: Date.now(),
    finishedAt: null,
    totalBytes: stat.size,
    bytesRead: 0,
    encrypted: false,
    counts: {},
    totalDocuments: 0,
    imported: 0,
    collection: "",
    collectionImported: 0,
    collectionTotal: 0,
    collectionsDone: 0,
    collectionsTotal: 0,
    error: "",
  };
  currentJob = job;
  let cronPaused = false;
  try {
    const envelope = readEncryptedEnvelope(filePath);
    job.encrypted = Boolean(envelope);
    let key = null;
    if (envelope) {
      if (!passphrase) throw new Error("Enter the passphrase used when this Plekt backup was exported.");
      key = await pbkdf2(passphrase, envelope.salt, envelope.iterations, 32, "sha256");
    }
    const open = () => {
      job.bytesRead = 0;
      const onBytes = (count) => { job.bytesRead += count; };
      return envelope ? decryptedChunks(filePath, envelope, key, onBytes) : plainChunks(filePath, onBytes);
    };

    const { portable, counts } = await verifyBackup(open);
    job.counts = Object.fromEntries(counts);
    job.totalDocuments = [...counts.values()].reduce((sum, count) => sum + count, 0);
    job.collectionsTotal = counts.size;

    const now = fs.statSync(filePath);
    if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      throw new Error("The backup file changed while it was being checked. Nothing was restored.");
    }
    job.status = "importing";
    pauseCronSync(CRON_PAUSE_MS);
    cronPaused = true;
    try {
      await importBackup(open, { portable, job });
    } catch (error) {
      throw new Error(`The restore stopped part way through and your data is incomplete: ${error.message}`);
    }
    job.status = "complete";
    if (removeAfter) fs.rmSync(filePath, { force: true });
  } catch (error) {
    job.status = "failed";
    job.error = error.message || String(error);
  } finally {
    if (cronPaused) resumeCronSync();
    job.finishedAt = Date.now();
  }
  return publicJob(job);
}

// Checks synchronously (so the route can answer 404/409), then leaves the
// restore running and returns its initial job status.
export function startPlektRestore(options) {
  assertCanStart(options.filePath);
  const running = runPlektRestore(options, { prechecked: true });
  running.catch((error) => console.error("Plekt restore failed to start:", error.message));
  return publicJob(currentJob);
}
