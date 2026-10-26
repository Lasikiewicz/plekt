import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DEFAULT_DATA_DIR, resolveDbPath } from "../paths.js";
import { ensureTenantDataDir } from "./tenancy.js";

// Opens (and caches) a per-tenant SQLite database for single-process multi-user
// mode. Fresh tenant folders get schema.sql plus any registered initializer
// (migrations and live-change triggers registered by db.js). Do not import this
// module solely to open the admin DB — use the existing `db` export from db.js
// for that. Intentionally does not import db.js (that module opens the admin DB
// at load).

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = fs.readFileSync(path.join(here, "..", "schema.sql"), "utf8");
const cache = new Map();
const initialized = new WeakSet();
let tenantInitializer = null;

function assertSafeTenantDataDir(dataDir) {
  const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes("--test");
  if (underTestRunner && path.resolve(dataDir) === path.resolve(DEFAULT_DATA_DIR)) {
    throw new Error(`Refusing to open the real data folder (${DEFAULT_DATA_DIR}) under the test runner; set DATA_DIR to a temp folder before opening a tenant database`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pragmaWithRetry(database, statement, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return database.pragma(statement);
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY" || attempt >= attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function applyInitializerIfNeeded(database) {
  if (!tenantInitializer || initialized.has(database)) return;
  initialized.add(database);
  tenantInitializer(database);
}

export function registerTenantDatabaseInitializer(fn) {
  tenantInitializer = typeof fn === "function" ? fn : null;
  for (const database of cache.values()) {
    applyInitializerIfNeeded(database);
  }
}

export function openTenantDatabase(dataDir, { cacheKey = path.resolve(dataDir) } = {}) {
  assertSafeTenantDataDir(dataDir);
  const resolved = path.resolve(dataDir);
  if (cache.has(cacheKey)) {
    const existing = cache.get(cacheKey);
    applyInitializerIfNeeded(existing);
    return existing;
  }

  fs.mkdirSync(resolved, { recursive: true });
  const dbPath = resolveDbPath(resolved);
  const database = new Database(dbPath);
  try { fs.chmodSync(dbPath, 0o600); } catch { /* non-POSIX */ }
  pragmaWithRetry(database, "busy_timeout = 5000");
  pragmaWithRetry(database, "journal_mode = WAL");
  pragmaWithRetry(database, "foreign_keys = ON");
  database.exec(schemaSql);
  applyInitializerIfNeeded(database);

  cache.set(cacheKey, database);
  return database;
}

export function getTenantDatabaseForUser(name, rootDataDir) {
  const dataDir = ensureTenantDataDir(name, rootDataDir);
  return openTenantDatabase(dataDir, { cacheKey: path.resolve(dataDir) });
}

export function closeTenantDatabase(dataDir) {
  const resolved = path.resolve(dataDir);
  const database = cache.get(resolved);
  if (database) {
    try { database.close(); } catch { /* already closed */ }
    cache.delete(resolved);
  }
}

export function closeAllTenantDatabases() {
  for (const database of cache.values()) {
    try { database.close(); } catch { /* already closed */ }
  }
  cache.clear();
}

export function tenantDatabaseCacheSize() {
  return cache.size;
}
