import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, DEFAULT_DATA_DIR, SHARED_METADATA_DB_FILE } from "../paths.js";

// Install-wide SQLite store for provider metadata caches (TMDB, TVDB, Fanart,
// OMDb, YouTube) and shared provider API keys. One file under DATA_DIR, shared
// by every user in the process. Per-user databases keep poster_cache and
// media_artwork rows that point at shared artwork files; those tables stay per
// user.

const PROVIDER_CACHE_TABLES = [
  "tmdb_metadata_cache",
  "tmdb_search_cache",
  "tmdb_season_cache",
  "tmdb_person_cache",
  "tvdb_metadata_cache",
  "tvdb_season_cache",
  "omdb_cache",
  "fanart_cache",
  "youtube_meta_cache",
];

const PROVIDER_CACHE_TABLE_SET = new Set(PROVIDER_CACHE_TABLES);
const SHARED_PROVIDER_SQL_RE = new RegExp(`\\b(?:${PROVIDER_CACHE_TABLES.join("|")})\\b`, "i");

const SHARED_SCHEMA = `
CREATE TABLE IF NOT EXISTS tmdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  tvdb_id TEXT,
  media_type TEXT,
  title TEXT,
  details TEXT,
  poster_path TEXT,
  status TEXT,
  cached_poster_url TEXT,
  backdrop_path TEXT,
  cached_backdrop_url TEXT,
  tvdb_poster_url TEXT,
  season_posters TEXT,
  original_language TEXT,
  schema_version INTEGER,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tmdb_search_cache (
  id TEXT PRIMARY KEY,
  query TEXT,
  media_type TEXT,
  page INTEGER,
  response TEXT,
  missing INTEGER,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tmdb_season_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  season_number INTEGER,
  show_status TEXT,
  details TEXT,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tmdb_person_cache (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  details TEXT,
  schema_version INTEGER,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tvdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  title TEXT,
  details TEXT,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tvdb_season_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  season_number INTEGER,
  details TEXT,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS omdb_cache (
  id TEXT PRIMARY KEY,
  data TEXT,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS fanart_cache (
  id TEXT PRIMARY KEY,
  data TEXT,
  missing INTEGER DEFAULT 0,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS youtube_meta_cache (
  id TEXT PRIMARY KEY,
  data TEXT,
  updated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS shared_provider_keys (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const SHARED_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tmdb_metadata_cache_type_tmdb_id ON tmdb_metadata_cache(media_type, tmdb_id, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_tmdb_metadata_cache_tv_tvdb_id ON tmdb_metadata_cache(COALESCE(tvdb_id, CASE WHEN typeof(details) = 'text' AND json_valid(details) THEN CAST(json_extract(details, '$.external_ids.tvdb_id') AS TEXT) END), updated_at_ms) WHERE media_type = 'tv';
CREATE INDEX IF NOT EXISTS idx_tmdb_season_cache_show ON tmdb_season_cache(tmdb_id, season_number);
CREATE INDEX IF NOT EXISTS idx_tvdb_metadata_cache_tvdb_id ON tvdb_metadata_cache(tvdb_id, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_tvdb_season_cache_show ON tvdb_season_cache(tvdb_id, season_number);
`;

export function extractTmdbExternalTvdbId(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const external = details.external_ids;
  if (!external || typeof external !== "object") return null;
  const raw = external.tvdb_id ?? external.tvdbId;
  if (raw == null) return null;
  const clean = String(raw).trim();
  if (!clean || clean === "0") return null;
  return clean;
}

export function extractTmdbSeasonPosters(details) {
  if (!details || typeof details !== "object" || !Array.isArray(details.seasons)) return null;
  const entries = [];
  for (const season of details.seasons) {
    if (!season || typeof season !== "object") continue;
    const seasonNumber = Number(season.season_number);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) continue;
    const poster = [
      season.poster_url,
      season.posterUrl,
      season.cached_poster_url,
      season.cachedPosterUrl,
      season.poster_path,
      season.posterPath,
      season.image_url,
      season.imageUrl,
      season.image,
      season.poster?.path,
    ].map((v) => String(v ?? "").trim()).find(Boolean) || "";
    if (poster) entries.push([seasonNumber, poster]);
  }
  return entries.length ? JSON.stringify(entries) : null;
}

const PROVIDER_KEYS_ROW_ID = "providerKeys";
const TVDB_TOKEN_ROW_ID = "tvdbToken";
const cache = new Map();

function assertSafeSharedDir(dataDir) {
  const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes("--test");
  if (underTestRunner && path.resolve(dataDir) === path.resolve(DEFAULT_DATA_DIR)) {
    throw new Error(`Refusing to open shared metadata under the real data folder (${DEFAULT_DATA_DIR}) in tests`);
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

export function sharedMetadataDbPath(rootDataDir = DATA_DIR) {
  return path.join(rootDataDir, SHARED_METADATA_DB_FILE);
}

export function getSharedMetadataDb(rootDataDir = DATA_DIR) {
  const resolved = path.resolve(rootDataDir);
  assertSafeSharedDir(resolved);
  if (cache.has(resolved)) return cache.get(resolved);

  fs.mkdirSync(resolved, { recursive: true });
  const dbPath = path.join(resolved, SHARED_METADATA_DB_FILE);
  const database = new Database(dbPath);
  try { fs.chmodSync(dbPath, 0o600); } catch { /* non-POSIX */ }
  pragmaWithRetry(database, "busy_timeout = 5000");
  pragmaWithRetry(database, "journal_mode = WAL");
  pragmaWithRetry(database, "journal_size_limit = 16777216");
  pragmaWithRetry(database, "foreign_keys = ON");
  database.exec(SHARED_SCHEMA);

  const tmdbCols = new Set(database.pragma("table_info(tmdb_metadata_cache)").map((c) => c.name));
  if (!tmdbCols.has("original_language")) {
    database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN original_language TEXT");
  }
  if (!tmdbCols.has("status")) {
    database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN status TEXT");
  }
  if (!tmdbCols.has("tvdb_id")) {
    database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN tvdb_id TEXT");
  }
  if (!tmdbCols.has("season_posters")) {
    database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN season_posters TEXT");
  }
  const existingTvdbIdx = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tmdb_metadata_cache_tv_tvdb_id'")
    .get();
  if (existingTvdbIdx?.sql && !existingTvdbIdx.sql.includes("COALESCE(tvdb_id")) {
    database.exec("DROP INDEX IF EXISTS idx_tmdb_metadata_cache_tv_tvdb_id");
  }
  // Show-level lookups (every season of a show, a series' newest details) run
  // per show in loops such as the Trakt inbound numbering map. Without these
  // each one scanned the whole table, JSON included, and a pass over a real
  // library held the event loop for tens of seconds.
  database.exec(SHARED_INDEXES);

  cache.set(resolved, database);
  return database;
}

export function providerCacheTableNames() {
  return [...PROVIDER_CACHE_TABLES];
}

export function isSharedProviderCacheTable(table) {
  return PROVIDER_CACHE_TABLE_SET.has(String(table || "").trim().toLowerCase());
}

export function sqlTargetsSharedProviderCache(sql) {
  return SHARED_PROVIDER_SQL_RE.test(String(sql || ""));
}

export function readSharedProviderKeysRow(rootDataDir = DATA_DIR) {
  const shared = getSharedMetadataDb(rootDataDir);
  const row = shared.prepare("SELECT data, updated_at FROM shared_provider_keys WHERE id = ?").get(PROVIDER_KEYS_ROW_ID);
  if (!row) return null;
  try {
    return {
      data: JSON.parse(row.data || "{}") || {},
      updatedAt: Number(row.updated_at || 0),
    };
  } catch {
    return null;
  }
}

export function writeSharedProviderKeysRow(keys = {}, updatedAt = Date.now(), rootDataDir = DATA_DIR) {
  const shared = getSharedMetadataDb(rootDataDir);
  shared.prepare(
    `INSERT INTO shared_provider_keys (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(PROVIDER_KEYS_ROW_ID, JSON.stringify(keys || {}), Number(updatedAt || Date.now()));
}

export function readSharedTvdbToken(rootDataDir = DATA_DIR) {
  const shared = getSharedMetadataDb(rootDataDir);
  const row = shared.prepare("SELECT data FROM shared_provider_keys WHERE id = ?").get(TVDB_TOKEN_ROW_ID);
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function writeSharedTvdbToken(tokenState = {}, rootDataDir = DATA_DIR) {
  const shared = getSharedMetadataDb(rootDataDir);
  shared.prepare(
    `INSERT INTO shared_provider_keys (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(TVDB_TOKEN_ROW_ID, JSON.stringify(tokenState || {}), Date.now());
}

function tableRowCount(database, table) {
  try {
    return Number(database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);
  } catch {
    return 0;
  }
}

function sharedStoreIsEmpty(shared) {
  return PROVIDER_CACHE_TABLES.every((table) => tableRowCount(shared, table) === 0);
}

// One-time copy from the admin DB into the shared store so an existing install
// keeps warm caches after upgrading to shared metadata assets.
export function migrateProviderCachesFromAdmin(adminDb, rootDataDir = DATA_DIR) {
  if (!adminDb) return { migrated: false, reason: "no-admin-db" };
  const shared = getSharedMetadataDb(rootDataDir);
  if (!sharedStoreIsEmpty(shared)) return { migrated: false, reason: "shared-already-populated" };

  let copied = 0;
  const copyTable = shared.transaction((table) => {
    let columns;
    try {
      columns = adminDb.pragma(`table_info(${table})`).map((c) => c.name);
    } catch {
      return 0;
    }
    if (!columns.length) return 0;
    const sharedColumns = new Set(shared.pragma(`table_info(${table})`).map((c) => c.name));
    const useColumns = columns.filter((name) => sharedColumns.has(name));
    if (!useColumns.length) return 0;
    const rows = adminDb.prepare(`SELECT ${useColumns.join(", ")} FROM ${table}`).all();
    if (!rows.length) return 0;
    const placeholders = useColumns.map(() => "?").join(", ");
    const insert = shared.prepare(
      `INSERT OR IGNORE INTO ${table} (${useColumns.join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
      insert.run(...useColumns.map((name) => row[name]));
    }
    return rows.length;
  });

  for (const table of PROVIDER_CACHE_TABLES) {
    try {
      copied += copyTable(table);
    } catch (error) {
      console.warn(`shared-metadata migrate skipped ${table}:`, error?.message || error);
    }
  }
  return { migrated: copied > 0, copied };
}

// Once provider caches live in shared-metadata.db, all routed SQL reads and
// writes go there. Clearing the migrated copy from the admin DB eliminates
// hundreds of megabytes of dead duplicate rows. Only runs when shared-metadata
// already holds data so an unmigrated database is never cleared early.
export function purgeMigratedProviderCachesFromAdmin(adminDb, rootDataDir = DATA_DIR) {
  if (!adminDb) return { purged: false, deleted: 0, reason: "no-admin-db" };
  const shared = getSharedMetadataDb(rootDataDir);
  if (sharedStoreIsEmpty(shared)) return { purged: false, deleted: 0, reason: "shared-empty" };

  let deleted = 0;
  const clearAll = adminDb.transaction(() => {
    for (const table of PROVIDER_CACHE_TABLES) {
      try {
        deleted += adminDb.prepare(`DELETE FROM ${table}`).run().changes;
      } catch { /* table missing */ }
    }
  });
  clearAll();
  return { purged: deleted > 0, deleted };
}

export function clearSharedProviderCaches(rootDataDir = DATA_DIR) {
  const shared = getSharedMetadataDb(rootDataDir);
  shared.transaction(() => {
    for (const table of PROVIDER_CACHE_TABLES) {
      shared.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}

export function closeAllSharedMetadataDatabases() {
  for (const database of cache.values()) {
    try { database.close(); } catch { /* already closed */ }
  }
  cache.clear();
}
