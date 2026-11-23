#!/usr/bin/env node
// Read-only rechecks for plan checks that can only pass after time has passed, so nobody
// has to remember the date and run them by hand. Opens every database read-only and never
// writes: the server's own scheduler does the pruning, this only confirms it happened.
//
//   node scripts/time-gated-checks.js                 retention checks, then exit
//   node scripts/time-gated-checks.js --idle-hour     also watch a running server for 60 min
//   options: --minutes N  --log <server log>  --json  --data-dir <dir>
//
// Exit code 0 = every check passed or is still waiting for its date; 1 = a check failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveDbPath } from "../server/src/paths.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * DAY; // AUDIT_PAYLOAD_RETENTION_MS and SYNC_ACTIVITY_PAYLOAD_RETENTION_MS
// The Sync Activity trim runs at most once a day per account, so an eligible row may wait
// that long before the scheduler reaches it; the audit prune runs every tick.
const SYNC_TRIM_GRACE_MS = DAY + 60 * 60 * 1000;
const AUDIT_GRACE_MS = 10 * 60 * 1000;
// Same payload paths syncActivityRetention.js removes.
const SYNC_PAYLOAD_PATHS = ["$.bodyPreview", "$.rawPayload", "$.payload", "$.requestBody", "$.responseBody"];
const hasSyncPayload = `CASE WHEN json_valid(raw_payload_debug) THEN (${SYNC_PAYLOAD_PATHS
  .map((p) => `json_type(raw_payload_debug, '${p}') IS NOT NULL`).join(" OR ")}) ELSE 0 END`;
const VERSION_IDS = ["history", "up_next", "progress"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const args = { idleHour: false, minutes: 60, log: "", json: false, dataDir: process.env.DATA_DIR || path.join(repoRoot, "data") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--idle-hour") args.idleHour = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--minutes") args.minutes = Math.max(1, Number(argv[++i]) || 60);
    else if (arg === "--log") args.log = argv[++i] || "";
    else if (arg === "--data-dir") args.dataDir = argv[++i] || args.dataDir;
    else throw new Error(`Unknown option ${arg}`);
  }
  return args;
}

export function listDatabases(dataDir) {
  const found = [];
  const adminFile = resolveDbPath(dataDir);
  if (fs.existsSync(adminFile)) found.push({ account: "admin", file: adminFile });
  const usersDir = path.join(dataDir, "users");
  if (fs.existsSync(usersDir)) {
    for (const user of fs.readdirSync(usersDir).sort()) {
      const file = path.join(usersDir, user, "plekt.db");
      if (fs.existsSync(file)) found.push({ account: user, file });
    }
  }
  return found;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

// Decide pass / waiting / fail from: oldest row, rows past the window still holding a
// payload (and how old the oldest of those is), and rows past the window already trimmed.
export function retentionVerdict({ now, oldest, remaining, oldestRemaining, trimmed, graceMs }) {
  if (!oldest) return { status: "waiting", detail: "no rows yet" };
  const dueAt = oldest + RETENTION_MS;
  if (now < dueAt) return { status: "waiting", dueOn: isoDay(dueAt), detail: `first row reaches 90 days on ${isoDay(dueAt)}` };
  if (remaining > 0) {
    const overdueBy = now - (oldestRemaining + RETENTION_MS);
    if (overdueBy <= graceMs) return { status: "waiting", detail: `${remaining} row(s) just became eligible; next scheduled prune will clear them` };
    return { status: "fail", detail: `${remaining} row(s) past 90 days still hold payloads (oldest due ${isoDay(oldestRemaining + RETENTION_MS)}); is the server running?` };
  }
  return { status: "pass", detail: `${trimmed} row(s) past 90 days trimmed, 0 left` };
}

export function auditPayloadCheck(db, now = Date.now()) {
  if (!hasTable(db, "watch_audit_events")) return { status: "waiting", detail: "no audit table" };
  const cutoff = now - RETENTION_MS;
  const row = db.prepare(`SELECT
      MIN(created_at) AS oldest,
      SUM(CASE WHEN created_at < @cutoff AND payload IS NOT NULL THEN 1 ELSE 0 END) AS remaining,
      MIN(CASE WHEN created_at < @cutoff AND payload IS NOT NULL THEN created_at END) AS oldestRemaining,
      SUM(CASE WHEN created_at < @cutoff AND payload IS NULL THEN 1 ELSE 0 END) AS trimmed
    FROM watch_audit_events WHERE event_type = 'source_event' AND created_at > 0`).get({ cutoff });
  return retentionVerdict({ now, oldest: row.oldest, remaining: Number(row.remaining || 0), oldestRemaining: row.oldestRemaining, trimmed: Number(row.trimmed || 0), graceMs: AUDIT_GRACE_MS });
}

export function syncActivityTrimCheck(db, now = Date.now()) {
  if (!hasTable(db, "sync_history")) return { status: "waiting", detail: "no sync_history table" };
  const cutoff = now - RETENTION_MS;
  const row = db.prepare(`SELECT
      MIN(created_at) AS oldest,
      SUM(CASE WHEN created_at < @cutoff AND ${hasSyncPayload} THEN 1 ELSE 0 END) AS remaining,
      MIN(CASE WHEN created_at < @cutoff AND ${hasSyncPayload} THEN created_at END) AS oldestRemaining,
      SUM(CASE WHEN created_at < @cutoff AND NOT ${hasSyncPayload} THEN 1 ELSE 0 END) AS trimmed
    FROM sync_history WHERE created_at > 0`).get({ cutoff });
  return retentionVerdict({ now, oldest: row.oldest, remaining: Number(row.remaining || 0), oldestRemaining: row.oldestRemaining, trimmed: Number(row.trimmed || 0), graceMs: SYNC_TRIM_GRACE_MS });
}

function snapshot(db) {
  const versions = {};
  if (hasTable(db, "cache_versions")) {
    for (const row of db.prepare("SELECT id, version FROM cache_versions").all()) versions[row.id] = Number(row.version);
  }
  const counts = {};
  for (const table of ["watch_history", "sync_history", "watch_audit_events"]) {
    counts[table] = hasTable(db, table) ? Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).get().n) : 0;
  }
  return { versions, counts };
}

export function countRebuildLines(text) {
  const byCache = {};
  for (const match of String(text).matchAll(/\[cache-rebuild\] cache=(\S+)/g)) byCache[match[1]] = (byCache[match[1]] || 0) + 1;
  return byCache;
}

// Data-version bumps are what force derived caches (Up Next, history, stats) to rebuild,
// and cache_versions keeps them in the database, so they can be counted from outside the
// server. With --log pointing at a server started with PLEKT_DEBUG_CACHE_REBUILDS=1, the
// actual rebuild lines are counted as well.
async function idleHour(databases, { minutes, log }) {
  const open = databases.map(({ account, file }) => ({ account, db: new Database(file, { readonly: true, fileMustExist: true }) }));
  const before = open.map(({ db }) => snapshot(db));
  const logStart = log && fs.existsSync(log) ? fs.statSync(log).size : null;
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, minutes * 60 * 1000));
  const results = open.map(({ account, db }, index) => {
    const after = snapshot(db);
    const bumps = Object.fromEntries(VERSION_IDS.map((id) => [id, (after.versions[id] ?? 0) - (before[index].versions[id] ?? 0)]));
    const newRows = Object.fromEntries(Object.keys(after.counts).map((t) => [t, after.counts[t] - before[index].counts[t]]));
    db.close();
    return { account, bumps, newRows, idle: newRows.watch_history === 0 };
  });
  let rebuilds = null;
  if (logStart !== null) {
    const fd = fs.openSync(log, "r");
    const length = Math.max(0, fs.statSync(log).size - logStart);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, logStart);
    fs.closeSync(fd);
    rebuilds = countRebuildLines(buffer.toString("utf8"));
  }
  return { startedAt: new Date(startedAt).toISOString(), minutes, accounts: results, rebuilds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databases = listDatabases(args.dataDir);
  if (!databases.length) throw new Error(`No database found in ${args.dataDir}`);
  const now = Date.now();
  const retention = databases.map(({ account, file }) => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return { account, auditPayloadPrune: auditPayloadCheck(db, now), syncActivityTrim: syncActivityTrimCheck(db, now) };
    } finally { db.close(); }
  });
  const report = { checkedAt: new Date(now).toISOString(), retention };
  if (args.idleHour) report.idleHour = await idleHour(databases, args);
  const failed = retention.some((r) => r.auditPayloadPrune.status === "fail" || r.syncActivityTrim.status === "fail");

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Time-gated checks, ${report.checkedAt}`);
    for (const r of retention) {
      console.log(`  ${r.account}: audit payload prune ${r.auditPayloadPrune.status} (${r.auditPayloadPrune.detail}); Sync Activity trim ${r.syncActivityTrim.status} (${r.syncActivityTrim.detail})`);
    }
    if (report.idleHour) {
      console.log(`Idle window: ${report.idleHour.minutes} min from ${report.idleHour.startedAt}`);
      for (const a of report.idleHour.accounts) {
        console.log(`  ${a.account}: version bumps ${JSON.stringify(a.bumps)}; new rows ${JSON.stringify(a.newRows)}${a.idle ? "" : " (not idle: watches arrived)"}`);
      }
      if (report.idleHour.rebuilds) console.log(`  cache rebuilds from log: ${JSON.stringify(report.idleHour.rebuilds)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message || error); process.exitCode = 2; });
}
