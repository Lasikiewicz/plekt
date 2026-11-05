import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { DATA_DIR } from "../paths.js";
import { db, parseJson, toJson } from "../db.js";
import { isDemoMode } from "./demoMode.js";

const MAX_LOGS = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Ring-buffer ceiling for the diagnostic_log table. Pruned on flush so reads
// stay flat as the process runs.
const MAX_ROWS = 20000;
const EXPORT_SLACK = 1000;
// Writes are batched: entries collect here and flush in one transaction, so a
// burst of console output costs one disk sync instead of one per line.
const FLUSH_INTERVAL_MS = 1000;
const MAX_PENDING = 200;
// On-disk archive retention. The JSONL files are crash forensics only - the
// logs panel reads SQLite - so they can be pruned aggressively.
const ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LOGS_DIR = path.join(DATA_DIR, "logs");
const role = String(process.env.ROLE || "all");
const instance = `${role}:${process.pid}`;
const startedAt = Date.now();
const logFile = path.join(LOGS_DIR, `diagnostic-${role}-${process.pid}-${startedAt}.jsonl`);
const memoryLogs = [];
let isCapturing = false;

fs.mkdirSync(LOGS_DIR, { recursive: true });

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function redactSecrets(value = "") {
  let text = String(value || "");
  text = text.replace(/([?&](?:token|api[_-]?key|secret|password|authorization|cookie)=)[^&\s'"]+/gi, "$1[redacted]");
  text = text.replace(/\b(authorization|cookie|x-api-key|x-plex-token|api[_-]?key|token|password|secret)(['"]?\s*[:=]\s*['"]?)[^,'"\s}]+/gi, "$1$2[redacted]");
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(logFile).size < MAX_FILE_BYTES) return;
    const rotated = `${logFile}.1`;
    try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
    fs.renameSync(logFile, rotated);
  } catch { /* missing/new file */ }
}

export function categorizeLog(message = "") {
  const msg = String(message || "");
  if (/plex notification|websocket|parseplexnotification|activitynotification|timelineentry|probePlexNotificationSocket/i.test(msg)) {
    return "plex-notifications";
  }
  if (/sync playstate|sync unplayed|sync progress|outbound sync|applymanualunwatch|marked played|marked unplayed|loop-check|dispatch status|sync history|manual watch|manual unwatch/i.test(msg)) {
    return "sync";
  }
  if (/scheduled|syncRecently|cron|sections check|history fetch|background refresh|syncRecentlyWatched|syncRecentlyResumable/i.test(msg)) {
    return "scheduled-poll";
  }
  return "system";
}

let insertStatement = null;
let pruneStatement = null;

function statements() {
  if (!insertStatement) {
    insertStatement = db.prepare(
      "INSERT INTO diagnostic_log (ts, level, category, role, instance, message) VALUES (?,?,?,?,?,?)"
    );
    pruneStatement = db.prepare(
      `DELETE FROM diagnostic_log WHERE id <= (
         SELECT id FROM diagnostic_log ORDER BY id DESC LIMIT 1 OFFSET ?
       )`
    );
  }
  return { insertStatement, pruneStatement };
}

const pending = [];
let flushTimer = null;
let writesSincePrune = 0;

// Exported so the shutdown path can persist the final lines (including its own
// "shutting down" messages) before db.close() makes inserts impossible.
export function flushPending() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.length) return;
  const batch = pending.splice(0, pending.length);
  try {
    const { insertStatement: insert, pruneStatement: prune } = statements();
    db.transaction(() => {
      for (const entry of batch) {
        insert.run(entry.ts, entry.level, entry.category, entry.role, entry.instance, entry.message);
      }
      writesSincePrune += batch.length;
      // Amortise the ring-buffer trim rather than running it on every insert.
      if (writesSincePrune >= 500) {
        writesSincePrune = 0;
        prune.run(MAX_ROWS);
      }
    })();
  } catch { /* diagnostics must never break primary work */ }

  // Crash-forensics archive. Async and batched - the logs panel never reads it.
  try {
    rotateIfNeeded();
    const payload = batch.map((entry) => JSON.stringify(entry)).join("\n");
    fs.appendFile(logFile, `${payload}\n`, { encoding: "utf8", mode: 0o600 }, () => {});
  } catch { /* ignore */ }
}

function scheduleFlush() {
  if (pending.length >= MAX_PENDING) {
    flushPending();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

function addLog(level, args) {
  if (!isCapturing) return;
  const message = args.map((arg) => {
    // Diagnostic logs are exposed through the admin logs endpoint. Keep the
    // error message for troubleshooting, but never persist a stack trace that
    // could disclose server-side paths or implementation details to a client.
    if (arg instanceof Error) return redactSecrets(arg.message || String(arg));
    if (typeof arg === "object") return redactSecrets(util.inspect(arg, { depth: 6, breakLength: 120, compact: false }));
    return redactSecrets(arg);
  }).join(" ");
  // Drop known spam here rather than at read time, so it never costs disk or
  // query time. Previously this was filtered only on the way out.
  if (isSpamLog(message)) return;
  const category = categorizeLog(message);
  const entry = { timestamp: new Date().toISOString(), ts: Date.now(), level, category, role, instance, message };
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_LOGS) memoryLogs.shift();
  pending.push(entry);
  scheduleFlush();
}

// Delete archive files older than the retention window. Mirrors
// applyRetention() in watchHistoryBackups.js. Nothing pruned this directory
// before, so it grew one file per process start indefinitely.
export function pruneLogArchive() {
  let removed = 0;
  try {
    const cutoff = Date.now() - ARCHIVE_MAX_AGE_MS;
    const files = fs.readdirSync(LOGS_DIR)
      .filter((name) => /^diagnostic-.*\.jsonl(?:\.1)?$/.test(name))
      .filter((name) => name !== path.basename(logFile))
      .map((name) => {
        const full = path.join(LOGS_DIR, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* vanished */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const doomed = files.filter((file) => file.mtime < cutoff);
    for (const file of doomed) {
      try {
        fs.rmSync(file.full, { force: true });
        removed++;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

function clearTimestamp() {
  try {
    const row = db.prepare("SELECT data FROM runtime_state WHERE id='main'").get();
    return Number(parseJson(row?.data, {})?.diagnosticClearedAt || 0);
  } catch { return 0; }
}

// Reads every process's rows straight from the shared table. This replaced a
// full read + JSON.parse of every diagnostic-*.jsonl file in LOGS_DIR on each
// request, which grew without bound as archive files accumulated.
function querySharedLogs({ level, category, clearedAt, limit }) {
  const where = ["ts > ?"];
  const params = [clearedAt];
  if (level) {
    where.push("level = ?");
    params.push(level);
  }
  if (category && category !== "all") {
    where.push("category = ?");
    params.push(category);
  }
  const clause = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_log WHERE ${clause}`).get(...params)?.n || 0;
  // Newest N by index, then flip back to chronological order for display.
  const rows = db.prepare(
    `SELECT ts, level, category, role, instance, message FROM diagnostic_log
     WHERE ${clause} ORDER BY ts DESC, id DESC LIMIT ?`
  ).all(...params, limit);
  rows.reverse();
  return { total, rows };
}

export function startCapturing() {
  if (isCapturing) return;
  isCapturing = true;
  console.log = function(...args) { originalLog.apply(console, args); addLog("info", args); };
  console.error = function(...args) { originalError.apply(console, args); addLog("error", args); };
  console.warn = function(...args) { originalWarn.apply(console, args); addLog("warn", args); };
}

export function stopCapturing() {
  if (!isCapturing) return;
  flushPending();
  isCapturing = false;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
}

export function isSpamLog(message = "") {
  const msg = String(message || "");
  if (/no activity for \d+s, recycling the connection/i.test(msg)) return true;
  if (/Scheduled Sync complete! Synced Plex: 0, Emby: 0, Jellyfin: 0, Resume Plex: 0, Resume Emby: 0, Resume Jellyfin: 0, Manual: 0/i.test(msg)) return true;
  return false;
}

// `since` (epoch ms) limits the result to lines newer than that moment, which is
// how the Logs screen download offers "last 6 hours" and similar choices. The
// ceiling is the whole ring buffer so a download can cover its full retention.
export function getLogs({ level, category = "all", limit = 500, since = 0 } = {}) {
  const clearedAt = Math.max(clearTimestamp(), Number(since) || 0);
  const categoryMap = {
    "plex-notifications": "PLEX",
    "sync": "SYNC",
    "scheduled-poll": "POLL",
    "system": "SYSTEM"
  };

  // The table is only trimmed every ~500 writes, so it can briefly hold more
  // than MAX_ROWS; allow for that slack so a full export never drops the oldest lines.
  const bounded = Math.min(Math.max(Number(limit) || 500, 1), MAX_ROWS + EXPORT_SLACK);
  // Make this process's buffered lines visible immediately - the panel polls
  // faster than the flush interval.
  flushPending();

  let total = 0;
  let rows = [];
  try {
    ({ total, rows } = querySharedLogs({ level, category, clearedAt, limit: bounded }));
  } catch {
    // Fall back to this process's in-memory ring if the query fails.
    rows = memoryLogs.filter((entry) => Number(entry.ts) > clearedAt).slice(-bounded);
    total = rows.length;
  }

  return {
    total,
    logs: rows.map((entry) => {
      const rawCat = entry.category || categorizeLog(entry.message);
      const catTag = categoryMap[rawCat] || rawCat.toUpperCase();
      const isoTs = entry.timestamp || (entry.ts ? new Date(Number(entry.ts)).toISOString() : new Date().toISOString());
      return `[${isoTs}] [${catTag}] [${entry.instance}] ${entry.message}`;
    }),
  };
}

export function clearLogs() {
  const select = db.prepare("SELECT data FROM runtime_state WHERE id='main'");
  const upsert = db.prepare(`INSERT INTO runtime_state (id,data,updated_at) VALUES ('main',?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
  // Drop anything still buffered, so a clear cannot be immediately undone by a
  // pending flush writing pre-clear lines back in.
  pending.length = 0;
  memoryLogs.length = 0;
  db.transaction(() => {
    const current = parseJson(select.get()?.data, {}) || {};
    const now = Date.now();
    upsert.run(toJson({ ...current, diagnosticClearedAt: now, updatedAt: now }), now);
    // The clearedAt marker alone would hide rows but keep paying to store them.
    db.prepare("DELETE FROM diagnostic_log").run();
  }).immediate();
}

// The public demo deliberately keeps no diagnostic archive or request history.
// Its fixture data is public and immutable, so retaining process logs would
// only create unnecessary IP/browser metadata on the demo host.
if (!isDemoMode()) startCapturing();
pruneLogArchive();

// Don't lose the last second of buffered output on shutdown.
process.on("exit", flushPending);
