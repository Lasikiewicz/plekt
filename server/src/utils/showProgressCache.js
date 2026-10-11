import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths.js";
import { db, bumpDataVersion } from "../db.js";
import { getTmdbDetails } from "./tmdbGateway.js";

const CACHE_FILE_PATH = path.join(DATA_DIR, "tv_progress_cache.json");

let progressCache = {};
const pendingShowUpdates = new Set();
let progressFlushPromise = null;
// Bump whenever progress classification or total episode calculation changes,
// so existing shows are rebuilt instead of retaining stale counts indefinitely.
const PROGRESS_CACHE_SCHEMA_VERSION = 3; // trusted user-scoped library-history rows now count as watched
// How long to wait before retrying a show whose episode total could not be resolved.
const MISSING_TOTAL_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const BURST_TOTAL_REUSE_MS = 60 * 1000;

// True for values like "plex://season/602e6a1b66dfdb002c0a6aa8" or "tvdb://12345"
// that ended up in a show_title column instead of an actual show name.
function isOpaqueProviderRef(value) {
  return /^[a-z][a-z0-9.+-]*:\/\//i.test(String(value || "").trim());
}

// Pure helper functions decoupled from dataRepo.js to avoid circular dependency issues
function decodeBasicHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

function canonicalTitleKey(value) {
  return decodeBasicHtmlEntities(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const stripYear = (value) => String(value || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return stripYear(seasonMatch[1]) || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return stripYear(alternateMatch[1]) || "Unknown Show";
  return stripYear(text.split(" - ")[0]) || "Unknown Show";
}

function isWatchedAction(row = {}) {
  return !["unwatched", "unplayed"].includes(String(row.sync_action || "watched").toLowerCase());
}

function isScheduledLibraryHistoryRow(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || "");
  return /Watch event fetched from (Plex|Emby|Jellyfin) library history/i.test(telemetry);
}

function parsedProvenance(value) {
  if (value && typeof value === "object") return value;
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function isPlektTrackedWatchRow(row = {}) {
  if (!isWatchedAction(row)) return false;
  if (!isScheduledLibraryHistoryRow(row)) return true;
  const provenance = parsedProvenance(row.watch_provenance);
  return provenance?.event === "library_history"
    && Boolean(String(provenance.user || "").trim())
    && Boolean(String(provenance.source_timestamp || "").trim());
}

/**
 * Titles of shows present in watch history that have no progress cache entry
 * at all yet - e.g. shows watched before this cache existed, or added outside
 * the incremental queueShowProgressUpdate() call sites.
 */
function findUncachedShowTitles() {
  const rows = db.prepare(`
    SELECT show_title, title, sync_action, sync_dispatch_telemetry, watch_provenance
    FROM watch_history
    WHERE media_type = 'episode'
  `).all();
  const titles = new Set();
  for (const row of rows.filter(isPlektTrackedWatchRow)) {
    const showTitle = showTitleFrom(row.show_title || row.title);
    const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
    if (!progressCache[showKey]) titles.add(showTitle);
  }
  return titles;
}

export async function initShowProgressCache() {
  if (fs.existsSync(CACHE_FILE_PATH)) {
    try {
      const data = fs.readFileSync(CACHE_FILE_PATH, "utf8");
      progressCache = JSON.parse(data);
      const total = Object.keys(progressCache).length;
      // Some shows have no resolvable episode total at all (a provider URI where
      // the title should be, or metadata that simply lacks one). Retrying those
      // on every boot re-spent the same failing lookups forever, so a show whose
      // total was checked recently waits for the retry interval.
      const totalsRetryCutoff = Date.now() - MISSING_TOTAL_RETRY_MS;
      const missingTotals = Object.values(progressCache)
        .filter((s) => !s.total_episodes && Number(s.total_checked_at || 0) <= totalsRetryCutoff)
        .map((s) => s.title);
      const staleSchema = Object.values(progressCache).filter((s) => (s.schema_version || 1) < PROGRESS_CACHE_SCHEMA_VERSION).map((s) => s.title);
      const uncached = findUncachedShowTitles();
      const toQueue = new Set([...missingTotals, ...staleSchema, ...uncached]);
      console.log(`[ShowProgressCache] Loaded ${total} shows from cache file.`);
      if (toQueue.size) {
        console.log(`[ShowProgressCache] Scheduling background refresh for ${toQueue.size} shows (missing total episode count, stale calculation, or never cached).`);
        setImmediate(() => {
          for (const title of toQueue) queueShowProgressUpdate(title);
          flushShowProgressUpdates().catch((e) => console.error("[ShowProgressCache] Background refresh error:", e));
        });
      }
      return;
    } catch (e) {
      console.error("[ShowProgressCache] Failed to load cache file, rebuilding...", e);
    }
  }
  await rebuildShowProgressCache();
}

/**
 * Gets cached progress details for a show key.
 */
export function getCachedShowProgress(showKey) {
  return progressCache[showKey] || null;
}

/**
 * Drops a show's cached progress entry (including its cached tmdb_id) so a
 * stale/incorrect id can't be served between a rematch and the next
 * background recalculation.
 */
export function clearCachedShowProgress(showTitle) {
  const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
  delete progressCache[showKey];
}

/**
 * Queues a show title for progress update.
 */
export function queueShowProgressUpdate(showTitle) {
  const title = String(showTitle || "").trim();
  if (title) {
    pendingShowUpdates.add(title);
  }
}

/**
 * Calculates show progress for a single show and updates cache in-place.
 */
async function calculateAndSetShowProgress(showTitle) {
  const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);

  // Titles reach this function already run through showTitleFrom(), which strips
  // a trailing "(year)". Matching show_title_lower exactly therefore missed rows
  // stored as "Robin Hood (2025)" - the show was never cached, so it was
  // rediscovered as uncached and requeued on every boot. Prefilter on the exact
  // title plus the "(year)" form, then confirm by canonical key so only rows
  // that really belong to this show are counted.
  const lowerTitle = showTitle.toLowerCase();
  const rows = db.prepare(`
    SELECT season, episode, tmdb_id, tvdb_id, sync_action, sync_dispatch_telemetry, show_title, title
    FROM watch_history
    WHERE media_type = 'episode' AND (show_title_lower = ? OR show_title_lower LIKE ?)
  `).all(lowerTitle, `${lowerTitle} (%`)
    .filter((row) => {
      const derived = showTitleFrom(row.show_title || row.title);
      return (canonicalTitleKey(derived) || normalizeKeyPart(derived)) === showKey;
    });

  const trackedRows = rows.filter(isPlektTrackedWatchRow);
  
  if (trackedRows.length === 0) {
    // If no watched episodes remain, delete from cache
    delete progressCache[showKey];
    return;
  }
  
  // Deduplicate watched episodes by season and episode number
  const uniqueEpisodes = new Set();
  let tmdbId = "";
  let tvdbId = "";
  
  for (const row of trackedRows) {
    if (row.season != null && row.episode != null) {
      uniqueEpisodes.add(`${row.season}_${row.episode}`);
    }
    if (!tmdbId && row.tmdb_id) {
      tmdbId = row.tmdb_id;
    }
    if (!tvdbId && row.tvdb_id) {
      tvdbId = row.tvdb_id;
    }
  }
  
  const watchedCount = uniqueEpisodes.size;
  
  // Retrieve total episodes count from TMDB (utilizing cached details when possible)
  const previous = progressCache[showKey];
  let totalEpisodes = Number(previous?.total_episodes || 0);
  // A handful of rows carry an opaque provider URI in show_title instead of a
  // real name. Neither TVDB nor TMDB can ever resolve one, so attempting it just
  // spends two outbound requests per boot to produce the same failure.
  const titleIsResolvable = Boolean(showTitle) && !isOpaqueProviderRef(showTitle);
  const reuseRecentTotal = previous
    && Date.now() - Number(previous.total_checked_at || 0) <= BURST_TOTAL_REUSE_MS
    && (!tmdbId || !previous.tmdb_id || String(previous.tmdb_id) === String(tmdbId));
  if (!reuseRecentTotal && (tmdbId || titleIsResolvable)) {
    try {
      const tmdbShow = await getTmdbDetails({
        mediaType: "tv",
        tmdbId,
        title: titleIsResolvable ? showTitle : "",
        ids: { tvdbId },
      });
      totalEpisodes = tmdbShow?.number_of_episodes || 0;
    } catch (e) {
      // An unresolvable ID is an expected data gap, not a failure of this run.
      console.warn(`[ShowProgressCache] No episode total for ${showTitle}: ${e.message}`);
    }
  }
  
  progressCache[showKey] = {
    title: showTitle,
    tmdb_id: tmdbId || "",
    episode_count: watchedCount,
    total_episodes: totalEpisodes,
    // Stamped so a show whose total cannot be resolved is retried on a schedule
    // rather than on every single boot.
    total_checked_at: Date.now(),
    schema_version: PROGRESS_CACHE_SCHEMA_VERSION
  };
}

/**
 * Flushes all pending queued updates to the cache and writes the cache file.
 */
export async function flushShowProgressUpdates() {
  if (progressFlushPromise) return progressFlushPromise;
  if (pendingShowUpdates.size === 0) return;
  // The database handle can close before the deferred startup refresh runs
  // (e.g. the test suite's throwaway DB) - drop the queue instead of crashing.
  if (!db.open) {
    pendingShowUpdates.clear();
    return;
  }

  progressFlushPromise = (async () => {
    const calculationStartedAt = performance.now();
    const processedTitles = new Set();
    // Drain again when an update arrives while an earlier title is awaiting
    // metadata. Concurrent callers join this promise, so no update is lost and
    // each caller retains the durable-await contract.
    while (pendingShowUpdates.size) {
      const titles = [...pendingShowUpdates];
      pendingShowUpdates.clear();
      titles.forEach((title) => processedTitles.add(title));
      console.log(`[ShowProgressCache] Updating progress for ${titles.length} shows: ${titles.join(", ")}`);
      for (const title of titles) {
        if (!db.open) return;
        await calculateAndSetShowProgress(title);
      }
    }

    const calculationMs = performance.now() - calculationStartedAt;
    try {
      const serializationStartedAt = performance.now();
      const serialized = JSON.stringify(progressCache, null, 2);
      const serializationMs = performance.now() - serializationStartedAt;
      const writeStartedAt = performance.now();
      const tempPath = `${CACHE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, serialized, "utf8");
      fs.renameSync(tempPath, CACHE_FILE_PATH);
      const writeMs = performance.now() - writeStartedAt;
      console.log(`[ShowProgressCache] Saved updated progress cache to file (${processedTitles.size} shows; calculate ${calculationMs.toFixed(1)}ms, serialize ${serializationMs.toFixed(1)}ms, write ${writeMs.toFixed(1)}ms).`);
    } catch (e) {
      console.error("[ShowProgressCache] Failed to save updated progress cache:", e);
    }
    // The show list is memoized by data version - bump it so refreshed totals
    // are visible without waiting for an unrelated watch event.
    bumpDataVersion();
  })();
  try {
    await progressFlushPromise;
  } finally {
    progressFlushPromise = null;
  }
}

/**
 * Full rebuild of the cache file from database.
 */
export async function rebuildShowProgressCache() {
  if (progressFlushPromise) await progressFlushPromise;
  console.log("[ShowProgressCache] Rebuilding TV show progress cache from scratch...");
  const tempCache = {};
  
  // Get all episode rows in watch history
  const rows = db.prepare(`
    SELECT show_title, title, season, episode, tmdb_id, sync_action, sync_dispatch_telemetry
    FROM watch_history
    WHERE media_type = 'episode'
  `).all();
  
  const trackedRows = rows.filter(isPlektTrackedWatchRow);
  
  // Group rows by show key
  const groups = new Map();
  for (const row of trackedRows) {
    const showTitle = showTitleFrom(row.show_title || row.title);
    const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
    
    if (!groups.has(showKey)) {
      groups.set(showKey, {
        title: showTitle,
        episodes: new Set(),
        tmdbId: ""
      });
    }
    
    const group = groups.get(showKey);
    if (row.season != null && row.episode != null) {
      group.episodes.add(`${row.season}_${row.episode}`);
    }
    if (!group.tmdbId && row.tmdb_id) {
      group.tmdbId = row.tmdb_id;
    }
  }
  
  // Process groups and query TMDB
  for (const [showKey, group] of groups.entries()) {
    let totalEpisodes = 0;
    if (group.tmdbId || group.title) {
      try {
        const tmdbShow = await getTmdbDetails({ mediaType: "tv", tmdbId: group.tmdbId, title: group.title });
        totalEpisodes = tmdbShow?.number_of_episodes || 0;
      } catch (e) {
        console.error(`[ShowProgressCache] Rebuild failed fetching TMDB total episodes for ${group.title}:`, e.message);
      }
    }
    
    tempCache[showKey] = {
      title: group.title,
      tmdb_id: group.tmdbId || "",
      episode_count: group.episodes.size,
      total_episodes: totalEpisodes,
      schema_version: PROGRESS_CACHE_SCHEMA_VERSION
    };
  }
  
  progressCache = tempCache;
  try {
    const dir = path.dirname(CACHE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(progressCache, null, 2), "utf8");
    console.log(`[ShowProgressCache] Rebuilt and saved ${Object.keys(progressCache).length} shows to cache file.`);
  } catch (e) {
    console.error("[ShowProgressCache] Failed to save rebuilt progress cache:", e);
  }
}
