import crypto from "node:crypto"; import { captureTrackerDestinations } from "./trackerWriteIntents.js";
import { trackerImportSource, trackerProviderIds } from "./trackers/registry.js";
import { settledDestinationLines } from "./trackers/telemetry.js";
import { db, getDataVersion, getProgressVersion, bumpDataVersion, bumpUpNextVersion, dataVersionTrigger, parseJson, toJson, transaction } from "../db.js";
import { recordCacheRebuild, timeCacheRebuild, timeCacheRebuildAsync } from "./cacheTelemetry.js";
import { isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js";
import { fetchPosterFromTmdb } from "./tmdbClient.js";
import { getCachedTmdbDetails, getCachedTmdbExternalIdKind, getTmdbDetails, getTmdbSeason, queueTmdbMetadataWarmup } from "./tmdbGateway.js";
import { getCachedTvdbEpisodeKind } from "./tvdbGateway.js";
import { annotateShowNumbering } from "./showSeasonTranslation.js";
import { cachedNextAiringFor, readNextAiringCache } from "./nextAiringCache.js";
import { buildWatchProvenance, normalizeProviderOverrides, normalizeWatchProvenance } from "./watchProvenance.js";
import { recordWatchAuditEvent, recordWatchAuditEvents } from "./watchAudit.js";
import { remoteEpisodeImportError } from "./episodeImportGuard.js";
import { episodeNameFromSeason, isPlaceholderEpisodeTitleValue, resolvedEpisodeTitleForRecord } from "./episodeTitleRepair.js";
import { getCanonicalPosterUrl, getCanonicalSeasonPosterUrls, saveCanonicalPoster } from "./mediaArtwork.js";
import {
  initShowProgressCache,
  getCachedShowProgress,
  clearCachedShowProgress,
  queueShowProgressUpdate,
  flushShowProgressUpdates,
} from "./showProgressCache.js";
import { recordWatchlistMutation } from "./personalWatchlistRepository.js";
import {
  decodeStoredWatchTitle as decodeBasicHtmlEntities,
  episodeCoordinatesFromStoredTitle as episodeCoordinatesFromTitleWithLegacyRepair,
  persistedWatchDerivedFields,
  repairedStoredEpisodeTitle as repairedEpisodeTitle,
} from "./watchDerivedFields.js";
import { yieldToEventLoop } from "./eventLoop.js";
import { brandEnv } from "./brandEnv.js";

// Initialize TV show progress cache on startup
initShowProgressCache().catch((err) => {
  console.error("[dataRepo] Failed to initialize show progress cache", err);
});


const MAX_HISTORY_LIMIT = 25000;
const HISTORY_VISIBILITY_CACHE_VERSION = 4;
const HISTORY_PREVIEW_SCAN_LIMIT = 600;

let historyCache = { version: null, rows: [] };
// History pages return episode rows, but each row also needs the canonical
// artwork and series identity from its show. Build that lookup once per
// history generation instead of regrouping the entire episode library for
// every page, filter, or pagination request.
let historyArtworkCache = { version: null, byId: null, byMediaKey: null, byCoordinate: null };
const historyArtworkBuilds = new Map();
let showCache = { version: null, shows: [] };
let historyPreviewCache = { version: null, rows: new Map() };
const historyPreviewBuilds = new Map();
// Longest synchronous run a background-capable cache build does before
// letting other requests in (see groupShowRowsYielding).
const REBUILD_SLICE_MS = 25;
// The includeScheduledLibraryHistory variant returns a different show set, so it
// needs its own slot. Without one it was recomputed from the full watch history
// on every call - the Upcoming calendar asks for it once per month requested.
let scheduledShowCache = { version: null, shows: [] };
let movieCache = { version: null, rows: null };
let movieSummaryCache = { version: null, rows: null };
let statsCache = { version: null, stats: null };
// A cache invalidation can wake several API requests at once (for example while
// a Plex season notification is updating sibling episodes). Keep one rebuild in
// flight per show-set variant so those requests share the expensive synchronous
// per-show work instead of multiplying it and starving the HTTP health check.
const showCacheBuilds = new Map();

function assertRestoreWriteAllowed(source = "", { allowDuringRestore = false } = {}) {
  // An explicit manual unwatch is allowed to commit its local canonical marker
  // while a restore owns outbound projection. Its pending telemetry is then
  // picked up by the scheduler once the restore fence is released.
  if (allowDuringRestore) return;
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (normalizedSource.startsWith("restore")) return;
  // A user's own watched-status edit is never refused because a restore or sync
  // owns outbound projection; only automated writes wait behind the fence.
  if (normalizedSource === "manual") return;
  if (!isAuthoritativeRestoreActive()) return;
  const error = new Error("An authoritative watch-history restore is active; watch-state writes are paused until it completes.");
  error.code = "RESTORE_ACTIVE";
  throw Object.assign(error, { status: 409 });
}

// The browser's change contract, deliberately broader than the derived-cache
// generation. A resume-position write no longer invalidates any history-derived
// cache, but an open page still has to notice it, so this aggregates both
// generations: it advances for everything it advanced for before the split.
export async function getHistoryCacheVersion() {
  // A sum, not a dotted pair: the browser parses this with Number(), where
  // "5.10" and "5.1" are the same value. Both generations only ever increase,
  // so their sum increases on every bump of either and never collides in time.
  return getDataVersion() + getProgressVersion();
}

// Advance the browser-facing change contract without flushing expensive
// derived show metadata. Batch importers use this after each committed item so
// open pages can update immediately, then perform one full derived-cache flush
// when the batch is complete.
export function signalHistoryDataChanged() {
  return bumpDataVersion();
}

// --- Watch history row mapping --------------------------------------------
const WATCH_COLUMNS = [
  "id", "title", "title_lower", "media_type", "watched_at", "source",
  "imdb_id", "tmdb_id", "tvdb_id", "season", "episode", "poster_url", "logo_url",
  "backdrop_url", "youtube_url", "sync_action", "sync_dispatch_telemetry", "media_key",
  "watch_provenance", "sync_match_ignored_at", "show_title", "show_title_lower", "episode_title", "episode_title_status",
  "episode_title_checked_at", "episode_title_resolution_error", "created_at", "updated_at",
];

const insertWatchStmt = db.prepare(
  `INSERT INTO watch_history (${WATCH_COLUMNS.join(", ")})
   VALUES (${WATCH_COLUMNS.map((c) => "@" + c).join(", ")})`,
);
// Uncapped deliberately. This previously read only the newest 25,000 rows, and
// everything derived from it inherited that ceiling: above it a show whose
// episodes were all older simply vanished from the TV Shows list, with no
// error. `selectMoviesStmt` below has always been uncapped for the same
// reason. Stats deliberately reuses this same uncapped cache so its lifetime
// totals remain truthful above the API pagination safety limit.
const selectAllHistoryStmt = db.prepare("SELECT * FROM watch_history ORDER BY watched_at DESC");
const selectMoviesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'movie'");
const selectRecentStmt = db.prepare("SELECT * FROM watch_history ORDER BY watched_at DESC LIMIT ?");
const selectRecentlyUpdatedStmt = db.prepare("SELECT * FROM watch_history ORDER BY updated_at DESC, created_at DESC LIMIT ?");
const selectByIdStmt = db.prepare("SELECT * FROM watch_history WHERE id = ?");
const selectByMediaKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ?");
const selectEpisodesByShowLowerStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND show_title_lower = ?");
const selectAllEpisodesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode'");
db.exec(`CREATE TABLE IF NOT EXISTS show_merge_history (
  id TEXT PRIMARY KEY,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_show_merge_history_target ON show_merge_history(target_title, merged_at DESC);`);
db.exec(`CREATE TABLE IF NOT EXISTS deleted_watch_suppressions (
  source TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  watched_at TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (source, identity_key, watched_at)
);
CREATE INDEX IF NOT EXISTS idx_deleted_watch_suppressions_date ON deleted_watch_suppressions(watched_at);`);
const insertShowMergeStmt = db.prepare("INSERT INTO show_merge_history (id, source_title, target_title, rows_json, merged_at) VALUES (?, ?, ?, ?, ?)");
const listShowMergesStmt = db.prepare("SELECT id, source_title, target_title, merged_at, reverted_at FROM show_merge_history ORDER BY merged_at DESC");
const selectShowMergeStmt = db.prepare("SELECT * FROM show_merge_history WHERE id = ?");
const revertShowMergeStmt = db.prepare("UPDATE show_merge_history SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL");
const deleteByIdStmt = db.prepare("DELETE FROM watch_history WHERE id = ?");
const insertDeletedWatchSuppressionStmt = db.prepare("INSERT OR REPLACE INTO deleted_watch_suppressions (source, identity_key, watched_at, deleted_at) VALUES (?, ?, ?, ?)");
const selectDeletedWatchSuppressionStmt = db.prepare("SELECT 1 FROM deleted_watch_suppressions WHERE source = ? AND identity_key = ? AND watched_at = ? LIMIT 1");
const deleteByMediaKeyStmt = db.prepare("DELETE FROM watch_history WHERE media_key = ?");
const findExistingStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ? AND watched_at = ? LIMIT 1");
const findWatchedBySeasonEpisodeStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND season = ? AND episode = ? AND sync_action = 'watched'");
const selectHistoryByMediaKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ?");
const selectEpisodeHistoryByCoordinateStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND season = ? AND episode = ?");
const findWatchedByKeyStmt = db.prepare("SELECT * FROM watch_history WHERE media_key = ? AND sync_action = 'watched' LIMIT 1");
const findWatchedByCoordinatesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = ? AND (season IS ? OR season = ?) AND (episode IS ? OR episode = ?) AND title_lower = ? AND sync_action = 'watched'");
const findWatchedByShowCoordinatesStmt = db.prepare("SELECT * FROM watch_history WHERE media_type = 'episode' AND season = ? AND episode = ? AND show_title_lower = ? AND sync_action = 'watched'");
const getTmdbShowDetailsStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?");
const getTmdbShowSummaryStmt = db.prepare("SELECT status, poster_path FROM tmdb_metadata_cache WHERE id = ?");
const getTmdbShowByTvdbStmt = db.prepare("SELECT tmdb_id, details FROM tmdb_metadata_cache WHERE id = ?");
const recoverShowTitleByTmdbStmt = db.prepare("SELECT show_title FROM watch_history WHERE media_type = 'episode' AND tmdb_id = ? AND show_title IS NOT NULL AND show_title_lower != 'unknown show' LIMIT 1");
const recoverShowTitleByTvdbStmt = db.prepare("SELECT show_title FROM watch_history WHERE media_type = 'episode' AND tvdb_id = ? AND show_title IS NOT NULL AND show_title_lower != 'unknown show' LIMIT 1");
const selectUnknownShowRowsStmt = db.prepare("SELECT id, title, tmdb_id, tvdb_id, sync_dispatch_telemetry FROM watch_history WHERE media_type = 'episode' AND show_title_lower = 'unknown show'");
// Fix Match asserts these episodes belong to a different series, so every
// provider id carried over from the old match is wrong - imdb included, not just
// tmdb. Leaving imdb behind would also keep mediaKeyFor deriving the key from it.
const rematchShowEpisodeStmt = db.prepare(`
  UPDATE watch_history
  SET tvdb_id = ?, tmdb_id = '', imdb_id = '', poster_url = NULL, logo_url = NULL,
      backdrop_url = NULL, sync_dispatch_telemetry = 'Identity updated via Fix Match. Pending outbound sync.',
      sync_retry_count = 0, sync_next_retry_at = 0, updated_at = ?
  WHERE id = ?
`);
const updateWatchMediaKeyStmt = db.prepare("UPDATE watch_history SET media_key = ?, updated_at = ? WHERE id = ?");
const selectPlaystateKeyStmt = db.prepare("SELECT media_key FROM playstate WHERE media_key = ?");
const movePlaystateKeyStmt = db.prepare(
  `UPDATE playstate SET media_key = ?, tvdb_id = ?, tmdb_id = '', imdb_id = '', title = ?, title_lower = ?, updated_at = ?
   WHERE media_key = ?`,
);
const deleteTmdbMetadataStmt = db.prepare("DELETE FROM tmdb_metadata_cache WHERE id = ?");
const deleteTvdbMetadataStmt = db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?");

function cachedTmdbShowDetails(tmdbId) {
  const id = cleanString(tmdbId);
  if (!id) return null;
  const row = getTmdbShowDetailsStmt.get(`tv_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

// The TV Shows library needs exactly two fields per show, `status` and
// `poster_path`, but they live inside a details blob that averages 64KB for a
// TV entry in a real library. Parsing the whole blob once per show cost about
// 240ms of the shows rebuild at 1,200 shows. Both fields are mirrored into
// their own columns (migrations 27 and 29, backfilled from the stored blob
// without re-fetching anything), so the grid path reads those and only detail
// pages parse the blob.
function cachedTmdbShowSummary(tmdbId) {
  const id = cleanString(tmdbId);
  if (!id) return null;
  const summary = getTmdbShowSummaryStmt.get(`tv_${id}`);
  if (!summary) return null;
  // A row written before the columns existed, or by a build that predates them,
  // still has the fields only inside the blob. Falling back keeps the grid
  // correct during an upgrade; the row repopulates its columns the next time
  // the gateway refreshes it.
  if (summary.status == null && summary.poster_path == null) {
    const details = cachedTmdbShowDetails(id);
    if (details) return { status: details.status || null, poster_path: details.poster_path || null };
  }
  return summary;
}

function cachedShowTmdbId(...candidates) {
  for (const candidate of candidates) {
    const id = cleanString(candidate);
    if (id && cachedTmdbShowSummary(id)) return id;
  }
  return "";
}

function cachedTmdbShowIdForTvdb(tvdbId) {
  const id = cleanString(tvdbId);
  if (!id) return "";
  const row = getTmdbShowByTvdbStmt.get(`tv_tvdb_${id}`);
  const details = row?.details ? parseJson(row.details) : null;
  if (String(details?.external_ids?.tvdb_id || "") !== id) return "";
  return cleanString(row?.tmdb_id || details?.external_ids?.tmdb_id);
}

const getTvdbSeriesDetailsStmt = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE id = ?");

function cachedTvdbSeriesDetails(tvdbId) {
  const id = cleanString(tvdbId);
  if (!id) return null;
  const row = getTvdbSeriesDetailsStmt.get(`series_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

// A watch_history row's tvdb_id is whatever the ingest source tagged it with -
// for Plex/Emby/Jellyfin webhook rows that's the EPISODE's own TVDB id (TVDB
// assigns episodes their own numeric ids, separate from the series id), not
// the show's. Treating that as the show's series id and feeding it straight
// into a TVDB series lookup can land on a completely unrelated show whenever
// the numbers happen to collide. Only trust a candidate once it has already
// been resolved as a real series via getTvdbSeriesExtended (cached here) -
// from a search result, Fix Match, or a prior correct visit to this show -
// same tradeoff cachedShowTmdbId already makes for TMDB ids.
function cachedShowTvdbId(...candidates) {
  for (const candidate of candidates) {
    const id = cleanString(candidate);
    if (id && cachedTvdbSeriesDetails(id)) return id;
  }
  return "";
}

function cleanString(value) {
  return String(value || "").trim();
}

function emptyToNull(value) {
  const text = cleanString(value);
  return text || null;
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "");
}

export function normalizeMediaType(value) {
  const type = cleanString(value).toLowerCase();
  if (["movie", "movies", "film"].includes(type)) return "movie";
  if (["episode", "episodes", "show", "tv", "series"].includes(type)) return "episode";
  return type;
}

function normalizeWatchMediaType(value) {
  const type = cleanString(value).toLowerCase();
  if (["tv", "show", "series"].includes(type)) return "tv";
  return normalizeMediaType(type);
}

export function normalizePlatformSource(value) {
  const source = cleanString(value).toLowerCase();
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "plex";
}

function normalizeWatchedAt(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

// Title normalisation is pure, but show lookups run it for every history and
// playstate row: queryShowDetail once per show during an Up Next rebuild, and
// getPlaystateForMediaSync for every row at an episode's coordinates during the
// scheduled availability pass. Profiling showed those loops holding the event
// loop for several seconds at a time, stalling unrelated page loads. Memoize by
// the raw string; the bound stops a pathological library from growing it
// without limit (clearing only costs recomputation).
const TITLE_MEMO_LIMIT = 20000;
const canonicalTitleKeyMemo = new Map();
const showTitleFromMemo = new Map();
function rememberTitle(memo, value, result) {
  if (memo.size >= TITLE_MEMO_LIMIT) memo.clear();
  memo.set(value, result);
  return result;
}

export function canonicalTitleKey(value) {
  if (typeof value === "string") {
    const cached = canonicalTitleKeyMemo.get(value);
    if (cached !== undefined) return cached;
  }
  const key = decodeBasicHtmlEntities(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return typeof value === "string" ? rememberTitle(canonicalTitleKeyMemo, value, key) : key;
}

const MOVIE_PART_ORDINALS = new Map([
  ["zero", "0"],
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
  ["ten", "10"],
  ["viii", "8"],
  ["vii", "7"],
  ["vi", "6"],
  ["ix", "9"],
  ["iv", "4"],
  ["iii", "3"],
  ["ii", "2"],
  ["i", "1"],
]);

const MOVIE_PART_ORDINAL_PATTERN = /\b(part|pt|volume|vol)\s+(viii|vii|vi|ix|iv|iii|ii|i|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;

function canonicalMovieTitleKey(value) {
  const normalized = decodeBasicHtmlEntities(value)
    .trim()
    .replace(/\s+/g, " ");
  const normalizedParts = normalized.replace(MOVIE_PART_ORDINAL_PATTERN, (match, prefix, ordinal) => {
    const number = MOVIE_PART_ORDINALS.get(String(ordinal || "").toLowerCase());
    return number == null ? match : `${prefix} ${number}`;
  });
  return canonicalTitleKey(normalizedParts);
}

function stablePosterKey(value) {
  const poster = cleanString(value);
  if (!poster) return "";
  const lowered = poster.toLowerCase();
  if (lowered.includes("favicon") || lowered.includes("placeholder") || lowered.includes("no-poster")) return "";
  try {
    const url = new URL(poster);
    if (url.hostname.toLowerCase() === "image.tmdb.org") {
      return `tmdb-poster:${url.pathname.split("/").filter(Boolean).pop() || poster}`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Non-URL poster references are still useful when the exact value matches.
  }
  return poster;
}

function preferredShowTitle(current, candidate) {
  const existing = cleanString(current);
  const next = cleanString(candidate);
  if (!existing) return next || "Unknown Show";
  if (!next) return existing;
  if (/\(\d{4}\)\s*$/.test(existing) && !/\(\d{4}\)\s*$/.test(next)) return next;
  const existingIsAllCaps = existing === existing.toUpperCase() && /[A-Z]/.test(existing);
  const nextIsAllCaps = next === next.toUpperCase() && /[A-Z]/.test(next);
  if (existingIsAllCaps && !nextIsAllCaps) return next;
  return existing;
}

function removeTrailingYear(title) {
  return cleanString(title).replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

// A show identity that survives a media-server metadata rematch (which
// swaps every episode's provider ids and can toggle a trailing "(YYYY)" on
// or off the show title) or an inconsistent import. Deliberately looser than
// canonicalTitleKey alone - "Ludwig" and "Ludwig (2024)" must resolve to the
// same show, or the same real show ends up split into two in the app.
export function canonicalShowTitleKey(value) {
  return canonicalTitleKey(removeTrailingYear(value || ""));
}

export function showTitleFrom(title = "") {
  if (typeof title === "string") {
    const cached = showTitleFromMemo.get(title);
    if (cached !== undefined) return cached;
    return rememberTitle(showTitleFromMemo, title, computeShowTitleFrom(title));
  }
  return computeShowTitleFrom(title);
}

function computeShowTitleFrom(title = "") {
  const text = cleanString(decodeBasicHtmlEntities(title)) || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return removeTrailingYear(seasonMatch[1]) || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return removeTrailingYear(alternateMatch[1]) || "Unknown Show";
  return removeTrailingYear(text.split(" - ")[0]) || "Unknown Show";
}

function episodeCoordinatesFromTitle(title = "") {
  return episodeCoordinatesFromTitleWithLegacyRepair(title);
}

export function mediaKeyFor(record = {}) {
  const type = normalizeWatchMediaType(record.media_type || record.mediaType || record.type);
  const coordinates = [normalizeKeyPart(type), normalizeKeyPart(record.season), normalizeKeyPart(record.episode)].join(":");
  const ids = record.ids || {};
  if (record.imdb_id || record.imdb || ids.imdb) return `${coordinates}:imdb:${normalizeKeyPart(record.imdb_id || record.imdb || ids.imdb)}`;
  if (record.tmdb_id || record.tmdb || ids.tmdb) return `${coordinates}:tmdb:${normalizeKeyPart(record.tmdb_id || record.tmdb || ids.tmdb)}`;
  if (record.tvdb_id || record.tvdb || ids.tvdb) return `${coordinates}:tvdb:${normalizeKeyPart(record.tvdb_id || record.tvdb || ids.tvdb)}`;
  return `${coordinates}:title:${normalizeKeyPart(record.title)}`;
}

function playbackProgressKey(record = {}) {
  return mediaKeyFor(record);
}

function normalizeImportedTitle(record = {}, mediaType = "") {
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};

  if (mediaType === "episode") {
    // Live webhook media objects carry the resolved "Show - SxxExx" string on
    // `record.title` and the episode number on `record.episode` (not the
    // `show_title`/`episode_number` fields that Trakt/import records use), so
    // include those as fallbacks. Only rebuild when we actually have a real show
    // name â€” otherwise fall through to `record.title` so the stored title keeps
    // the correct episode coordinates and id-based recovery can still fix it.
    const showTitle = showTitleFrom(
      record.show_title ||
        show.title ||
        (typeof record.show === "string" ? record.show : "") ||
        record.title,
    );
    const season = firstPresent(record.season, episode.season);
    const episodeNumber =
      firstPresent(
        record.episode_number,
        episode.number,
        typeof record.episode === "object" ? "" : record.episode,
      );
    if (showTitle && showTitle !== "Unknown Show" && (season != null || episodeNumber != null)) {
      const seasonText = season == null ? "?" : season;
      const episodeText = episodeNumber == null ? "?" : episodeNumber;
      return `${showTitle} - S${String(seasonText).padStart(2, "0")}E${String(episodeText).padStart(2, "0")}`;
    }
  }

  return cleanString(decodeBasicHtmlEntities(
    record.title ||
      record.name ||
      record.movie_title ||
      record.show_title ||
      movie.title ||
      show.title ||
      episode.title ||
      (typeof record.show === "string" ? record.show : "") ||
      (typeof record.movie === "string" ? record.movie : "") ||
      record.Title ||
      "",
  ));
}

export function normalizeWatchRecord(record = {}, fallbackSource = "trakt_import") {
  const mediaType = normalizeWatchMediaType(record.media_type || record.mediaType || record.type);
  const ids = record.ids || record.movie?.ids || record.show?.ids || record.episode?.ids || {};
  const titleCoordinates = episodeCoordinatesFromTitleWithLegacyRepair(record.title);
  const title = normalizeImportedTitle(record, mediaType);
  const normalized = {
    title: mediaType === "episode" ? repairedEpisodeTitle(title) : title,
    media_type: mediaType,
    watched_at: normalizeWatchedAt(
      record.watched_at ||
        record.watchedAt ||
        record.watched_at_utc ||
        record.last_watched_at ||
        record.lastWatchedAt ||
        record.scrobbled_at ||
        record.collected_at ||
        record.date ||
        record.Date,
    ),
    source: cleanString(record.source || fallbackSource) || fallbackSource,
    imdb_id: emptyToNull(record.imdb_id || record.imdbId || record.imdb || ids.imdb),
    tmdb_id: emptyToNull(record.tmdb_id || record.tmdbId || record.tmdb || ids.tmdb),
    tvdb_id: emptyToNull(record.tvdb_id || record.tvdbId || record.tvdb || ids.tvdb),
    season: numberOrNull(firstPresent(record.season, record.episode?.season, titleCoordinates.season)),
    episode: numberOrNull(firstPresent(
      record.episode_number,
      record.episode?.number,
      typeof record.episode === "object" ? "" : record.episode,
      titleCoordinates.episode,
    )),
    poster_url: emptyToNull(record.poster_url || record.posterUrl),
    sync_action: cleanString(record.sync_action || record.syncAction || record.action) || "watched",
    sync_dispatch_telemetry: emptyToNull(record.sync_dispatch_telemetry || record.syncDispatchTelemetry),
    watch_provenance: normalizeWatchProvenance(
      record.watch_provenance || record.watchProvenance || record.provenance,
    ) || buildWatchProvenance({
      source: cleanString(record.source || fallbackSource) || fallbackSource,
      event: record.event,
      phase: record.phase,
      itemId: record.itemId,
      sessionId: record.sessionId,
      user: record.user,
      device: record.device || record.deviceName,
      deviceId: record.deviceId || record.device_id,
      client: record.client,
      clientVersion: record.clientVersion || record.client_version,
      playedAt: record.playedAt,
    }),
    episode_title: emptyToNull(record.episode_title || record.episodeTitle || record.episode?.title),
  };
  const providerOverrides = normalizeProviderOverrides(record.provider_overrides || record.providerOverrides);
  if (providerOverrides) {
    normalized.watch_provenance = normalizeWatchProvenance({
      ...(normalized.watch_provenance || {}),
      provider_overrides: providerOverrides,
    });
  }
  // A media server sometimes reports only the episode coordinate ("8",
  // "Episode 08") instead of the real episode name. Persisting that makes the
  // dashboard's TV "recently watched" row and /history show a coordinate
  // instead of the name shown on the media page. When the incoming value is
  // not a real name (a coordinate or synthesised "Episode N"), prefer whatever
  // real name is already stored (a sibling watch row or cached season metadata);
  // when none exists, store null so the UI falls back to a label from the
  // season/episode numbers and a later Database Repairs backfill can fill the
  // real name. A row that already carries a genuine name is left untouched so
  // these hot paths do not pay a sibling-row DB lookup.
  if (
    normalized.media_type === "episode"
    && (!normalized.episode_title || isPlaceholderEpisodeTitleValue(normalized.episode_title))
  ) {
    normalized.episode_title = resolvedEpisodeTitleForRecord(normalized);
  }
  return normalized;
}

export function mediaToWatchRecord(media, source = media?.source || "webhook") {
  return normalizeWatchRecord(
    {
      title: media?.title,
      media_type: media?.type,
      watched_at: media?.watched_at || new Date().toISOString(),
      source,
      imdb_id: media?.ids?.imdb,
      tmdb_id: media?.ids?.tmdb,
      tvdb_id: media?.ids?.tvdb,
      season: media?.season,
      episode: media?.episode,
      poster_url: media?.posterUrl || media?.poster_url,
      sync_action: media?.syncAction || media?.sync_action || "watched",
      sync_dispatch_telemetry: media?.syncDispatchTelemetry,
      watch_provenance: media?.watchProvenance || media?.watch_provenance || media?.provenance,
      event: media?.event,
      phase: media?.phase,
      itemId: media?.itemId || media?.item_id,
      sessionId: media?.sessionId || media?.session_id,
      user: media?.user,
      device: media?.device || media?.deviceName,
      deviceId: media?.deviceId || media?.device_id,
      client: media?.client,
      clientVersion: media?.clientVersion || media?.client_version,
      playedAt: media?.playedAt,
      episode_title: media?.episodeTitle || media?.episode_title,
    },
    source,
  );
}

function validateWatchRecord(record) {
  const errors = [];
  if (!record.title) errors.push("title is required");
  if (!["movie", "episode", "tv"].includes(record.media_type)) errors.push("media_type must be movie, TV show, or episode");
  if (!record.watched_at) errors.push("watched_at is required");
  if (!record.source) errors.push("source is required");
  const remoteEpisodeError = remoteEpisodeImportError(record);
  if (remoteEpisodeError) errors.push(remoteEpisodeError.message);
  return errors;
}

function recoverShowTitle(tmdbId, tvdbId) {
  if (tmdbId) {
    const row = recoverShowTitleByTmdbStmt.get(String(tmdbId));
    if (row?.show_title) return row.show_title;
  }
  if (tvdbId) {
    const row = recoverShowTitleByTvdbStmt.get(String(tvdbId));
    if (row?.show_title) return row.show_title;
  }
  return null;
}

// Last-resort recovery for episodes stored as "Unknown Show": the dispatch
// telemetry's `Media:` line holds the title that was resolved at sync time
// (e.g. "Aussie Gold Hunters - S10E12"), which is often correct even when the
// stored row lost the show name. Returns the resolved show title and the full
// "Show - SxxExx" string, or null when telemetry is absent/still unknown.
function recoverTitleFromTelemetry(telemetry) {
  if (!telemetry) return null;
  const line = String(telemetry).split("\n").find((l) => /^Media:/i.test(l));
  if (!line) return null;
  const fullTitle = line.replace(/^Media:\s*/i, "").trim();
  if (!fullTitle || /^unknown/i.test(fullTitle)) return null;
  const showTitle = showTitleFrom(fullTitle);
  if (!showTitle || showTitle === "Unknown Show") return null;
  return { showTitle, fullTitle };
}

// Build the column params for a watch_history row (excludes id/created_at).
function watchRowParams(record) {
  const derived = persistedWatchDerivedFields(record);
  let showTitle = record.media_type === "episode" ? showTitleFrom(record.show_title || record.title) : null;
  if (record.media_type === "episode" && (!showTitle || showTitle === "Unknown Show")) {
    const recovered = recoverShowTitle(record.tmdb_id, record.tvdb_id);
    if (recovered) showTitle = recovered;
  }
  return {
    title: derived.title,
    title_lower: derived.title_lower,
    media_type: record.media_type,
    watched_at: record.watched_at,
    source: record.source,
    imdb_id: record.imdb_id || null,
    tmdb_id: record.tmdb_id || null,
    tvdb_id: record.tvdb_id || null,
    season: derived.season,
    episode: derived.episode,
    poster_url: record.poster_url || null,
    logo_url: record.logo_url || null,
    backdrop_url: record.backdrop_url || null,
    youtube_url: null,
    sync_action: record.sync_action || "watched",
    sync_dispatch_telemetry: record.sync_dispatch_telemetry || null,
    sync_match_ignored_at: record.sync_match_ignored_at || null,
    watch_provenance: toJson(record.watch_provenance || buildWatchProvenance({ source: record.source })),
    media_key: mediaKeyFor(record),
    show_title: showTitle,
    show_title_lower: showTitle ? showTitle.toLowerCase() : null,
    episode_title: record.episode_title || null,
    episode_title_status: record.media_type === "episode" && (!record.episode_title || isPlaceholderEpisodeTitleValue(record.episode_title))
      ? "missing"
      : "resolved",
    episode_title_checked_at: null,
    episode_title_resolution_error: null,
  };
}

export function normalizeWatchRecordForInsert(record, fallbackSource = record?.source || "import") {
  const normalized = normalizeWatchRecord(record, fallbackSource);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));
  const data = watchRowParams(normalized);
  // Preserve the historical field names a couple of callers still read.
  data.mediaKey = data.media_key;
  data.watchedAt = data.watched_at;
  return { data, record: normalized };
}

function rowToWatch(row) {
  if (!row) return null;
  let tmdbId = row.tmdb_id || null;
  // An explicit TVDB match is authoritative. Do not resurrect an old TMDB id
  // from the progress cache while the new match is refreshing in background.
  if (row.media_type === "episode" && !tmdbId && !row.tvdb_id) {
    const showTitle = row.show_title || showTitleFrom(row.title);
    if (showTitle) {
      const showKey = canonicalTitleKey(showTitle) || normalizeKeyPart(showTitle);
      const cachedProgress = getCachedShowProgress(showKey);
      if (cachedProgress?.tmdb_id) {
        tmdbId = String(cachedProgress.tmdb_id);
      }
    }
  }
  const storedEpisodeTitle = row.episode_title ? decodeBasicHtmlEntities(row.episode_title) : null;
  const episodeTitleStatus = row.media_type !== "episode"
    ? "resolved"
    : storedEpisodeTitle && !isPlaceholderEpisodeTitleValue(storedEpisodeTitle)
      ? "resolved"
      : row.episode_title_status || "missing";
  return {
    id: row.id,
    title: row.title || "",
    media_type: row.media_type || "",
    watched_at: row.watched_at || "",
    source: row.source || "",
    imdb_id: row.imdb_id || null,
    tmdb_id: tmdbId,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    poster_url: row.poster_url || null,
    logo_url: row.logo_url || null,
    backdrop_url: row.backdrop_url || null,
    youtube_url: row.youtube_url || null,
    sync_action: row.sync_action || "watched",
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
    sync_match_ignored_at: Number(row.sync_match_ignored_at || 0) || null,
    watch_provenance: normalizeWatchProvenance(row.watch_provenance),
    provider_overrides: normalizeWatchProvenance(row.watch_provenance)?.provider_overrides || null,
    sync_retry_count: Number(row.sync_retry_count || 0),
    sync_next_retry_at: Number(row.sync_next_retry_at || 0),
    media_key: row.media_key || null,
    show_title: row.show_title ? decodeBasicHtmlEntities(row.show_title) : null,
    episode_title: storedEpisodeTitle,
    episode_title_status: episodeTitleStatus,
    episode_title_checked_at: Number(row.episode_title_checked_at || 0) || null,
    episode_title_resolution_error: row.episode_title_resolution_error || null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function isWatchedAction(row = {}) {
  return !["unwatched", "unplayed"].includes(String(row.sync_action || row.syncAction || "watched").toLowerCase());
}

function isScheduledLibraryHistoryRow(row = {}) {
  const telemetry = String(row.sync_dispatch_telemetry || row.syncDispatchTelemetry || "");
  return /Watch event fetched from (Plex|Emby|Jellyfin) library history/i.test(telemetry);
}

function isTrustedScheduledLibraryHistoryRow(row = {}) {
  if (!isScheduledLibraryHistoryRow(row)) return false;
  const provenance = normalizeWatchProvenance(row.watch_provenance || row.watchProvenance);
  return provenance?.event === "library_history"
    && Boolean(String(provenance.user || "").trim())
    && Boolean(String(provenance.source_timestamp || "").trim());
}

export function isPlektTrackedWatchRow(row = {}) {
  return isWatchedAction(row)
    && (!isScheduledLibraryHistoryRow(row) || isTrustedScheduledLibraryHistoryRow(row));
}

// Same trust check as isPlembfinTrackedWatchRow (an unscoped library scan row
// still isn't evidence of anything, watched or not) but without requiring the
// row's current state to be "watched" - used for grouping a show's episodes
// so a show doesn't disappear once every episode has been marked unwatched.
export function isPlektTrackedEpisodeRow(row = {}) {
  return !isScheduledLibraryHistoryRow(row) || isTrustedScheduledLibraryHistoryRow(row);
}

function createStatsPeriod(period, label) {
  return {
    period,
    label,
    total: 0,
    movies: 0,
    episodes: 0,
    firstPlay: null,
    lastPlay: null,
    movieKeys: new Set(),
    showKeys: new Set(),
    sourceMap: new Map(),
    movieMap: new Map(),
    showMap: new Map(),
    mediaMap: new Map(),
  };
}

function statsMovieKey(row = {}) {
  return row._statsMovieKey || row.imdb_id || row.tmdb_id || row.tvdb_id || canonicalTitleKey(row.title) || row.title || "unknown-movie";
}

function statsShowKey(row = {}) {
  return row._statsShowKey || canonicalTitleKey(row.show_title || showTitleFrom(row.title)) || "unknown-show";
}

function compactStatsMedia(row = {}, { key, type, title } = {}) {
  const isEpisode = row.media_type === "episode" || type === "episode";
  return {
    id: row.id,
    key,
    type,
    title,
    // Stats leaderboard entries represent the show, not one episode. Prefer
    // the enriched canonical show poster while keeping the episode poster as
    // a fallback for older rows that have no show artwork yet.
    poster_url: (isEpisode ? row.show_poster_url || row.poster_url : row.poster_url) || null,
    show_poster_url: isEpisode ? row.show_poster_url || null : null,
    media_key: row.media_key || null,
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    // The flat ids above are the episode's own; links need the library show's.
    show_tmdb_id: isEpisode ? row.show_tmdb_id || null : null,
    show_tvdb_id: isEpisode ? row.show_tvdb_id || null : null,
    latestWatch: row.watched_at || null,
  };
}

function bumpStatsMedia(map, key, item) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...item, count: 1 });
    return;
  }
  existing.count += 1;
  if (!existing.poster_url && item.poster_url) existing.poster_url = item.poster_url;
  if (!existing.id && item.id) existing.id = item.id;
  if (item.latestWatch && (!existing.latestWatch || item.latestWatch > existing.latestWatch)) {
    existing.latestWatch = item.latestWatch;
    if (item.id) existing.id = item.id;
    if (item.poster_url) existing.poster_url = item.poster_url;
    if (item.media_key) existing.media_key = item.media_key;
    if (item.show_tmdb_id) existing.show_tmdb_id = item.show_tmdb_id;
    if (item.show_tvdb_id) existing.show_tvdb_id = item.show_tvdb_id;
  }
  if (!existing.show_tmdb_id && item.show_tmdb_id) existing.show_tmdb_id = item.show_tmdb_id;
  if (!existing.show_tvdb_id && item.show_tvdb_id) existing.show_tvdb_id = item.show_tvdb_id;
}

function addRowToStatsPeriod(period, row = {}) {
  period.total += 1;
  if (!period.firstPlay || (row.watched_at && row.watched_at < period.firstPlay.latestWatch)) {
    period.firstPlay = compactStatsMedia(row, {
      key: row.media_type === "movie" ? `movie:${statsMovieKey(row)}` : `show:${statsShowKey(row)}`,
      type: row.media_type === "movie" ? "movie" : "episode",
      title: row.media_type === "movie" ? row.title || "Unknown movie" : row.show_title || showTitleFrom(row.title),
    });
  }
  if (!period.lastPlay || (row.watched_at && row.watched_at > period.lastPlay.latestWatch)) {
    period.lastPlay = compactStatsMedia(row, {
      key: row.media_type === "movie" ? `movie:${statsMovieKey(row)}` : `show:${statsShowKey(row)}`,
      type: row.media_type === "movie" ? "movie" : "episode",
      title: row.media_type === "movie" ? row.title || "Unknown movie" : row.show_title || showTitleFrom(row.title),
    });
  }
  const source = normalizePlatformSource(row.source);
  period.sourceMap.set(source, (period.sourceMap.get(source) || 0) + 1);
  if (row.media_type === "movie") {
    const key = `movie:${statsMovieKey(row)}`;
    const item = compactStatsMedia(row, { key, type: "movie", title: row.title || "Unknown movie" });
    period.movies += 1;
    period.movieKeys.add(key);
    bumpStatsMedia(period.movieMap, key, item);
    bumpStatsMedia(period.mediaMap, key, item);
    return;
  }

  if (row.media_type === "episode") {
    const showTitle = row.show_title || showTitleFrom(row.title);
    const key = `show:${statsShowKey(row)}`;
    const item = compactStatsMedia(row, { key, type: "episode", title: showTitle || "Unknown show" });
    period.episodes += 1;
    period.showKeys.add(key);
    bumpStatsMedia(period.showMap, key, item);
    bumpStatsMedia(period.mediaMap, key, item);
  }
}

// Stats must use the same identity rule as the movie list: rows with any shared
// provider ID belong to one film, and title-only rows join that film only when
// the title has exactly one provider-ID cluster. This prevents imported plays
// and initial-sync plays for the same film from becoming separate leaderboard
// entries, while keeping same-title remakes separate when their IDs differ.
function buildStatsMovieKeys(rows = []) {
  const movieRows = rows.filter((row) => row.media_type === "movie");
  const parent = new Map();
  const find = (value) => {
    while (parent.get(value) !== value) {
      parent.set(value, parent.get(parent.get(value)));
      value = parent.get(value);
    }
    return value;
  };
  const ensure = (value) => { if (!parent.has(value)) parent.set(value, value); };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(left, right);
  };
  const idNodesFor = (row) => [
    cleanString(row.imdb_id) ? `imdb:${cleanString(row.imdb_id)}` : "",
    cleanString(row.tmdb_id) ? `tmdb:${cleanString(row.tmdb_id)}` : "",
    cleanString(row.tvdb_id) ? `tvdb:${cleanString(row.tvdb_id)}` : "",
  ].filter(Boolean);

  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let index = 1; index < nodes.length; index += 1) union(nodes[0], nodes[index]);
  }

  const titleClusters = new Map();
  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const clusterKey = find(nodes[0]);
    const titleKey = canonicalTitleKey(row.title);
    if (!titleClusters.has(titleKey)) titleClusters.set(titleKey, new Set());
    titleClusters.get(titleKey).add(clusterKey);
  }

  const keys = new Map();
  for (const row of movieRows) {
    const nodes = idNodesFor(row);
    if (nodes.length) {
      keys.set(row, find(nodes[0]));
      continue;
    }
    const titleKey = canonicalTitleKey(row.title);
    const matches = titleClusters.get(titleKey);
    const clusterKey = matches?.size === 1 ? [...matches][0] : `title:${titleKey || "unknown-movie"}`;
    keys.set(row, clusterKey);
  }
  return keys;
}

function rankStatsItems(map, limit = 10) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || String(a.title || "").localeCompare(String(b.title || "")))
    .slice(0, limit);
}

function finalizeStatsPeriod(period) {
  return {
    period: period.period,
    label: period.label,
    total: period.total,
    movieWatches: period.movies,
    tvWatches: period.episodes,
    uniqueMovies: period.movieKeys.size,
    uniqueShows: period.showKeys.size,
    firstPlay: period.firstPlay,
    lastPlay: period.lastPlay,
    sourceBreakdown: [...period.sourceMap.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    topSource: [...period.sourceMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "none",
    topMovies: rankStatsItems(period.movieMap),
    topShows: rankStatsItems(period.showMap),
    topMedia: rankStatsItems(period.mediaMap),
  };
}

// --- History caches --------------------------------------------------------
// These derived caches intentionally trade memory for simple, fast reads in the
// single-process app. They load full history-derived result sets after each
// invalidation; before adding any more full-table caches, move hot paths that need
// pagination or large installations to indexed SQL with LIMIT/OFFSET.
export async function getCachedHistory() {
  const version = getDataVersion();
  if (historyCache.version === version) return historyCache.rows;
  const rows = timeCacheRebuild("history", version, dataVersionTrigger(version), () => (
    selectAllHistoryStmt.all().map(rowToWatch)
  ));
  historyCache = { version, rows };
  return rows;
}

export async function getCachedMovies() {
  const version = getDataVersion();
  if (movieCache.version === version && Array.isArray(movieCache.rows)) return movieCache.rows;
  const rows = timeCacheRebuild("movies", version, dataVersionTrigger(version), () => (
    selectMoviesStmt.all().map(rowToWatch).filter(isPlektTrackedWatchRow)
  ));
  movieCache = { version, rows };
  return rows;
}

// `/api/movies` repeatedly asks for different pages and sorts over the same
// immutable generation. Collapse the expensive identity clustering once, then
// let each request only filter/sort/slice that list.
async function getCachedMovieSummaries() {
  const version = getDataVersion();
  if (movieSummaryCache.version === version && Array.isArray(movieSummaryCache.rows)) return movieSummaryCache.rows;
  const rows = dedupeMovies(await getCachedMovies());
  movieSummaryCache = { version, rows };
  return rows;
}

export async function getCachedShows({ includeScheduledLibraryHistory = false } = {}) {
  const cacheKey = includeScheduledLibraryHistory ? "scheduled" : "default";
  while (true) {
    const version = getDataVersion();
    const memo = includeScheduledLibraryHistory ? scheduledShowCache : showCache;
    // Empty is a valid cached result. Rebuilding it on every read made a new or
    // fully-unwatched library repeatedly pay the same full-table cost.
    if (memo.version === version) return memo.shows;

    const pendingBuild = showCacheBuilds.get(cacheKey);
    if (pendingBuild) {
      // The build may have started at an older version. Re-check after it
      // completes so a write that landed during the build is never hidden.
      await pendingBuild;
      continue;
    }

    const buildPromise = timeCacheRebuildAsync(cacheKey === "scheduled" ? "scheduledShows" : "shows", version, dataVersionTrigger(version), async () => {
      // The default (non-scheduled) branch is not watched-state filtered: a show
      // whose every episode has been marked unwatched still needs its own group
      // here (with 0 watched) so it stays visible in the TV Shows grid/dashboard
      // instead of disappearing entirely.
      const episodeRows = (await getCachedHistory()).filter((r) => r.media_type === "episode"
        && (includeScheduledLibraryHistory ? isWatchedAction(r) : isPlektTrackedEpisodeRow(r)));
      const groups = await groupShowRowsYielding(dedupeHistory(episodeRows));
      // Each show needs its own SQLite lookup + JSON parse for cached TMDB details;
      // at library scale that's enough synchronous work in one pass to block the
      // event loop for a second or more. Yield frequently, and share this whole
      // rebuild with concurrent callers, so a burst cannot multiply the block.
      const YIELD_EVERY = 10;
      const shows = [];
      for (let i = 0; i < groups.length; i++) {
        if (i > 0 && i % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
        const group = groups[i];
        const showKey = canonicalTitleKey(group.title) || normalizeKeyPart(group.title);
        const rawShowKey = canonicalTitleKey(group.raw_title) || normalizeKeyPart(group.raw_title);
        const cachedProgress = getCachedShowProgress(showKey) || (rawShowKey !== showKey ? getCachedShowProgress(rawShowKey) : null);
        // group.tmdb_id, trusted unconditionally, comes from an actual recorded
        // watch_history row - Plembfin's own ground truth. cachedShowTmdbId's
        // gate (only return a candidate that already has cached metadata) exists
        // to protect the *weaker* fallback candidates below: the progress cache
        // can hold an id resolved from an earlier ambiguous title search that was
        // never written back onto any row (see the matching comment in
        // rematchShowWatchRecords below), and that gate is precisely what let a
        // bad cached resolution keep winning even after group.tmdb_id was put
        // first here - a real, correct id with no cache entry yet still lost to
        // a wrong id that happened to have one.
        const tmdbId = cleanString(group.tmdb_id) || cachedShowTmdbId(cachedProgress?.tmdb_id, group.representative_episode?.tmdb_id);
        // group.tvdb_id is already resolved through cachedShowTvdbId inside
        // groupShowRows - do not fall back to an ungated representative_episode
        // tvdb_id here, that's exactly the unverified episode-level id it exists
        // to filter out.
        const tvdbId = group.tvdb_id || "";
        const imdbId = cleanString(group.imdb_id);
        const canonicalPosterUrl = getCanonicalPosterUrl({
          media_type: "tv",
          title: group.title,
          tmdb_id: tmdbId,
          tvdb_id: tvdbId,
          imdb_id: imdbId,
        });
        let posterUrl = canonicalPosterUrl || group.poster_url || group.representative_episode?.poster_url || "";
        let status = "";
        if (tmdbId) {
          try {
            const summary = cachedTmdbShowSummary(tmdbId);
            if (summary) {
              status = summary.status || "";
              if (!posterUrl && summary.poster_path) posterUrl = `/api/tmdb-poster?path=${encodeURIComponent(summary.poster_path)}`;
            }
          } catch (err) {
            console.error(`Failed to get TV show details for tv_${tmdbId}`, err);
          }
        }
        shows.push({
          // Title-only ids were safe while the library collapsed every same-title
          // series into one row. Keep that fallback for metadata-less shows, but
          // use a provider identity whenever one is known so reboots such as The
          // Office (UK) and The Office (US) remain separate records and routes.
          id: showSummaryIdentityKey({ title: group.title, tmdb_id: tmdbId, tvdb_id: tvdbId, imdb_id: imdbId }),
          title: group.title,
          imdb_id: imdbId,
          tmdb_id: tmdbId,
          tvdb_id: tvdbId,
          status,
          poster_url: posterUrl || null,
          show_poster_url: canonicalPosterUrl || group.show_poster_url || null,
          canonical_poster_url: canonicalPosterUrl || group.canonical_poster_url || null,
          episode_count: group.episode_count,
          season_count: group.season_count,
          total_watches: group.total_watches,
          rewatched_episode_count: group.rewatched_episode_count,
          latest_watched_at: group.latest_watched_at,
          earliest_watched_at: group.earliest_watched_at,
          representative_episode: compactEpisode(group.representative_episode),
          total_episodes: cachedProgress?.total_episodes || 0,
        });
      }
      if (includeScheduledLibraryHistory) scheduledShowCache = { version, shows };
      else showCache = { version, shows };
      return shows;
    });

    showCacheBuilds.set(cacheKey, buildPromise);
    try {
      await buildPromise;
    } finally {
      if (showCacheBuilds.get(cacheKey) === buildPromise) showCacheBuilds.delete(cacheKey);
    }
  }
}


// --- Playstate -------------------------------------------------------------
const selectPlaystateStmt = db.prepare("SELECT * FROM playstate WHERE media_key = ?");
const selectPlaystateByTitleStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND title_lower = ?");
const selectPlaystateByImdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND imdb_id = ?");
const selectPlaystateByTmdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND tmdb_id = ?");
const selectPlaystateByTvdbStmt = db.prepare("SELECT * FROM playstate WHERE media_type = ? AND tvdb_id = ?");
const selectPlaystateBySeasonEpisodeStmt = db.prepare("SELECT * FROM playstate WHERE media_type = 'episode' AND season = ? AND episode = ?");
const upsertPlaystateStmt = db.prepare(
  `INSERT INTO playstate (media_key, title, title_lower, media_type, state, watched_at, last_source, sources, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, updated_at)
   VALUES (@media_key, @title, @title_lower, @media_type, @state, @watched_at, @last_source, @sources, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @poster_url, @updated_at)
   ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, title_lower=excluded.title_lower, media_type=excluded.media_type,
     state=excluded.state, watched_at=excluded.watched_at, last_source=excluded.last_source, sources=excluded.sources,
     imdb_id=excluded.imdb_id, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, updated_at=excluded.updated_at`,
);
const selectWatchedPlaystateStmt = db.prepare(
  "SELECT * FROM playstate WHERE state = 'watched' ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const selectWatchedPlaystateSnapshotStmt = db.prepare(
  "SELECT * FROM playstate WHERE state = 'watched' AND COALESCE(updated_at, 0) <= ? ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const countWatchedPlaystateStmt = db.prepare("SELECT COUNT(*) AS c FROM playstate WHERE state = 'watched'");
const countWatchedPlaystateSnapshotStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM playstate WHERE state = 'watched' AND COALESCE(updated_at, 0) <= ?",
);

function playstateFromRow(row) {
  return {
    id: row.media_key,
    media_key: row.media_key,
    title: decodeBasicHtmlEntities(row.title || ""),
    media_type: row.media_type || "",
    watched_at: row.watched_at || "",
    state: row.state || "watched",
    source: row.last_source || "",
    sources: parseJson(row.sources, []) || [],
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    poster_url: row.poster_url || null,
    updated_at: Number(row.updated_at || 0),
  };
}

function normalizePlaystateState(value = "watched") {
  const state = cleanString(value).toLowerCase();
  return ["unwatched", "unplayed"].includes(state) ? "unwatched" : "watched";
}

export function playstateRecordFromMedia(media = {}, state = media?.syncAction || "watched", watchedAt = undefined) {
  const record = mediaToWatchRecord(
    {
      ...media,
      syncAction: normalizePlaystateState(state) === "unwatched" ? "unwatched" : "watched",
    },
    media?.source || "webhook",
  );
  if (watchedAt) record.watched_at = normalizeWatchedAt(watchedAt);
  return record;
}

// `mediaKey` pins the write to one exact key instead of the newest row that
// shares any id: a caller that has just written a history row passes that row's
// key, so an episode-id alias cannot take the write (the 19 September Slow
// Horses review approval).
// A new episode row goes under the show's single proven profile (decision 34
// guard, as seriesIdsForEpisodeMedia applies it), not under the episode's own
// ids or its title: those made alias and title-keyed rows the identity repair
// then had to fold. Null when no profile applies; the row keeps its own key.
function playstateRecordOnProvenProfile(normalized = {}) {
  if (normalized.media_type !== "episode") return null;
  const seriesIds = seriesIdsForEpisodeMedia(normalized);
  if (!seriesIds || !(seriesIds.imdb || seriesIds.tmdb || seriesIds.tvdb)) return null;
  return {
    ...normalized,
    imdb_id: seriesIds.imdb || null,
    tmdb_id: seriesIds.tmdb || null,
    tvdb_id: seriesIds.tvdb || null,
  };
}

export function upsertPlaystateSync(record, stateOverride = undefined, { allowDuringRestore = false, mediaKey: pinnedKey = "" } = {}) {
  let normalized = normalizeWatchRecord(record, record.source || "webhook");
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));
  assertRestoreWriteAllowed(normalized.source, { allowDuringRestore });

  const state = normalizePlaystateState(stateOverride || normalized.sync_action);
  let identityMatches = pinnedKey ? [] : playstateRowsForIdentity(normalized);
  if (!pinnedKey && !identityMatches.length) {
    const keyed = playstateRecordOnProvenProfile(normalized);
    if (keyed) {
      normalized = keyed;
      identityMatches = playstateRowsForIdentity(normalized);
    }
  }
  const mediaKey = pinnedKey || identityMatches[0]?.media_key || mediaKeyFor(normalized);
  const existing = selectPlaystateStmt.get(mediaKey) || identityMatches[0];
  const sources = new Set(parseJson(existing?.sources, []) || []);
  if (normalized.source) sources.add(normalized.source);

  upsertPlaystateStmt.run({
    media_key: mediaKey,
    title: normalized.title,
    title_lower: normalized.title.toLowerCase(),
    media_type: normalized.media_type,
    state,
    watched_at: normalized.watched_at,
    last_source: normalized.source,
    sources: toJson([...sources].sort()),
    imdb_id: normalized.imdb_id || existing?.imdb_id || null,
    tmdb_id: normalized.tmdb_id || existing?.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || existing?.tvdb_id || null,
    season: normalized.season,
    episode: normalized.episode,
    poster_url: normalized.poster_url || existing?.poster_url || null,
    updated_at: Date.now(),
  });

  recordWatchAuditEvent({
    eventType: "playstate_updated",
    timestamp: Date.now(),
    action: state,
    mediaKey,
    mediaType: normalized.media_type,
    title: normalized.title,
    source: normalized.source,
    ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
    season: normalized.season,
    episode: normalized.episode,
    details: `Plekt playstate set to ${state}.`,
    payload: { state, watchedAt: normalized.watched_at, sources: [...sources].sort() },
  });

  return { mediaKey, state, record: normalized };
}

export async function upsertPlaystate(record, stateOverride = undefined, { skipInvalidate = false, allowDuringRestore = false, mediaKey = "" } = {}) {
  const result = upsertPlaystateSync(record, stateOverride, { allowDuringRestore, mediaKey });
  if (!skipInvalidate) await invalidateHistoryDerivedCaches("upsertPlaystate");
  return result;
}

export function upsertPlaystateForMediaSync(media, state = "watched", watchedAt = undefined, options = {}) {
  return upsertPlaystateSync(playstateRecordFromMedia(media, state, watchedAt), state, options);
}

export async function upsertPlaystateForMedia(media, state = "watched", watchedAt = undefined, options = {}) {
  return upsertPlaystate(playstateRecordFromMedia(media, state, watchedAt), state, options);
}

function sameEpisodeCoordinates(a = {}, b = {}) {
  if (normalizeMediaType(a.media_type || a.mediaType) !== "episode") return true;
  return Number(a.season ?? -1) === Number(b.season ?? -1) && Number(a.episode ?? -1) === Number(b.episode ?? -1);
}

function newestByUpdatedAt(rows = []) {
  return rows
    .filter(Boolean)
    .sort((a, b) => Number(b.updated_at || b.updatedAt || 0) - Number(a.updated_at || a.updatedAt || 0))[0] || null;
}

function identityRows(record = {}, selectors = {}) {
  const type = normalizeWatchMediaType(record.media_type || record.mediaType || record.type);
  const rows = [];
  const add = (row) => {
    if (row && sameEpisodeCoordinates(record, row) && !rows.some((item) => item.media_key === row.media_key)) rows.push(row);
  };
  if (record.imdb_id) selectors.imdb?.all(type, record.imdb_id).forEach(add);
  if (record.tmdb_id) selectors.tmdb?.all(type, record.tmdb_id).forEach(add);
  if (record.tvdb_id) selectors.tvdb?.all(type, record.tvdb_id).forEach(add);
  return rows.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}

function playstateRowsForIdentity(record = {}) {
  return identityRows(record, {
    imdb: selectPlaystateByImdbStmt,
    tmdb: selectPlaystateByTmdbStmt,
    tvdb: selectPlaystateByTvdbStmt,
  });
}

const updatePlaystateStateStmt = db.prepare(
  `UPDATE playstate
      SET state = ?, watched_at = ?, last_source = ?, sources = ?, updated_at = ?
    WHERE media_key = ?`,
);

function playstateRowsForMediaIdentity(record = {}) {
  const rows = [];
  const add = (row) => {
    if (row && !rows.some((existing) => existing.media_key === row.media_key)) rows.push(row);
  };
  add(selectPlaystateStmt.get(mediaKeyFor(record)));
  playstateRowsForIdentity(record).forEach(add);
  const sameShow = sameShowAs(record);
  selectPlaystateByTitleStmt
    .all(record.media_type, record.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(record, row) && sameShow(row))
    .forEach(add);
  if (record.media_type === "episode" && record.season != null && record.episode != null) {
    const showKey = canonicalShowTitleKey(showTitleFrom(record.title));
    selectPlaystateBySeasonEpisodeStmt
      .all(record.season, record.episode)
      .filter((row) => canonicalShowTitleKey(showTitleFrom(row.title)) === showKey && sameShow(row))
      .forEach(add);
  }
  return rows;
}

// Row filter for title-only movie matches: false only for a row whose IMDb or
// TMDB id differs from one this movie carries. Movie TVDB ids are too sparse
// and inconsistent across providers to prove a different film.
function sameFilmAs(media = {}) {
  const ids = media.ids || {};
  const imdb = cleanString(ids.imdb || media.imdb_id).toLowerCase();
  const tmdb = cleanString(ids.tmdb || media.tmdb_id);
  return (row) => !(imdb && cleanString(row.imdb_id) && cleanString(row.imdb_id).toLowerCase() !== imdb)
    && !(tmdb && cleanString(row.tmdb_id) && cleanString(row.tmdb_id) !== tmdb);
}

// Row filter for title/coordinate episode matches: false only for a row whose
// ids prove it belongs to another show of the same title.
function sameShowAs(reference = {}) {
  if (normalizeMediaType(reference.media_type || reference.mediaType || reference.type) !== "episode") return () => true;
  const showTitle = showTitleFrom(reference.show_title || reference.showTitle || reference.title || "");
  const referenceIds = mediaIdsForShowMatch(reference);
  return (row) => !episodeRecordsNameDifferentShows(showTitle, referenceIds, mediaIdsForShowMatch(row));
}

// A rematch can leave one playstate row per provider identity. Updating only
// the key selected by upsertPlaystateSync lets a newer alias win on the next
// lookup, which is why an episode that was just marked unwatched could appear
// watched again after an SSE refresh. Explicit state transitions converge all
// known aliases while preserving the historical watched_at on watch rows.
export function setPlaystateForMediaIdentitySync(
  media,
  state = "watched",
  watchedAt = undefined,
  options = {},
) {
  const normalized = playstateRecordFromMedia(media, state, watchedAt);
  const result = upsertPlaystateSync(normalized, state, options);
  const rows = playstateRowsForMediaIdentity(normalized);
  const keys = new Set(rows.map((row) => row.media_key).filter(Boolean));
  if (result.mediaKey) keys.add(result.mediaKey);
  const normalizedState = normalizePlaystateState(state);
  const timestamp = Date.now();
  const watchedStamp = normalized.watched_at;
  for (const row of rows) {
    const sources = new Set(parseJson(row.sources, []) || []);
    if (normalized.source) sources.add(normalized.source);
    updatePlaystateStateStmt.run(
      normalizedState,
      watchedStamp,
      normalized.source || row.last_source || "",
      toJson([...sources].sort()),
      timestamp,
      row.media_key,
    );
  }
  return { ...result, mediaKeys: [...keys] };
}

export async function setPlaystateForMediaIdentity(media, state = "watched", watchedAt = undefined, options = {}) {
  const result = setPlaystateForMediaIdentitySync(media, state, watchedAt, options);
  if (!options.skipInvalidate) await invalidateHistoryDerivedCaches("setPlaystateForMediaIdentity");
  return result;
}

export function getPlaystateForMediaSync(media) {
  const record = playstateRecordFromMedia(media, media?.syncAction || "watched");
  const exact = selectPlaystateStmt.get(mediaKeyFor(record));
  const sameShow = sameShowAs(record);
  const related = selectPlaystateByTitleStmt
    .all(record.media_type, record.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(record, row) && sameShow(row));
  // Same rematch/legacy-normalization gap as findWatchedByAnyMediaKey: none
  // of the exact matches above catch a show whose title changed (a trailing
  // "(YYYY)" only one side carries) alongside a provider-id rematch. Compare
  // every playstate row at this season+episode by normalized show title
  // before concluding there's no existing state for this episode.
  const byShowTitle = record.media_type === "episode" && record.season != null && record.episode != null
    ? selectPlaystateBySeasonEpisodeStmt.all(record.season, record.episode)
      .filter((row) => canonicalShowTitleKey(showTitleFrom(row.title)) === canonicalShowTitleKey(showTitleFrom(record.title)) && sameShow(row))
    : [];
  // A rematch can leave more than one playstate row for the same real item.
  // The exact key is not automatically canonical: it can be an older watched
  // pointer while a newer unwatched decision lives under a provider-id alias
  // (or the reverse). Compare it with every related identity and title row so
  // the latest transition wins across the whole item, not merely within the
  // key shape supplied by the current caller.
  const row = newestByUpdatedAt([exact, ...playstateRowsForIdentity(record), ...related, ...byShowTitle]);
  return row ? playstateFromRow(row) : null;
}

export async function getPlaystateForMedia(media) {
  return getPlaystateForMediaSync(media);
}

// The playstate table is the current canonical pointer.  The history fallback
// keeps older databases (including imports created before playstate rows were
// written) authoritative until their next dispatch repairs that pointer.
export async function getCanonicalWatchState(media) {
  const playstate = await getPlaystateForMedia(media);
  if (playstate?.state === "watched" || playstate?.state === "unwatched") return playstate.state;
  const watched = await findWatchedByAnyMediaKey(media).catch(() => null);
  return watched ? "watched" : null;
}

export async function listWatchedPlaystateRowsForReplay({ limit = 25, offset = 0, snapshotAt = undefined } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeSnapshotAt = Number(snapshotAt);
  const rows = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? selectWatchedPlaystateSnapshotStmt.all(safeSnapshotAt, safeLimit, safeOffset)
    : selectWatchedPlaystateStmt.all(safeLimit, safeOffset);
  return rows.map(playstateFromRow);
}

export async function countWatchedPlaystateRows({ snapshotAt = undefined } = {}) {
  const safeSnapshotAt = Number(snapshotAt);
  const row = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? countWatchedPlaystateSnapshotStmt.get(safeSnapshotAt)
    : countWatchedPlaystateStmt.get();
  return row.c || 0;
}

function queueProgressUpdateForRecord(record) {
  if (record && (record.media_type === "episode" || record.mediaType === "episode")) {
    const showTitle = record.show_title || record.showTitle || showTitleFrom(record.title);
    if (showTitle) {
      queueShowProgressUpdate(showTitle);
    }
  }
}

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason))
    .catch((error) => console.error(`[dataRepo] Automatic Up Next sync request failed: ${error?.message || error}`));
}

// `reason` labels the generation change for the rebuild telemetry in
// cacheTelemetry.js. It is optional: an unlabelled call is reported as
// "observed", exactly like a version a SQLite trigger or another process moved.
// Queue changes are pushed by the worker after this invalidation. Callers that
// have already performed the exact provider reconciliation can opt out of the
// follow-up job to avoid an immediate duplicate push.
export async function invalidateHistoryDerivedCaches(reason = "", { skipUpNextAutoSync = false } = {}) {
  await flushShowProgressUpdates().catch((err) => {
    console.error("[dataRepo] Failed to flush show progress updates", err);
  });
  bumpDataVersion(reason);
  if (!skipUpNextAutoSync) queueAutomaticUpNextSync(reason || "history-derived cache invalidated");
}

function patchCachedRow(rows, freshRow) {
  if (!Array.isArray(rows) || !freshRow?.id) return null;
  const index = rows.findIndex((row) => row.id === freshRow.id);
  if (index < 0) return null;
  const patched = rows.slice();
  patched[index] = rowToWatch(freshRow);
  return patched;
}

// Row-scoped metadata writes still advance the global history version (the SPA
// uses it as a refresh contract), but can carry forward derived caches whose
// result is provably unchanged. Leaving a cache at its old version is the safe
// fallback: its next reader performs the existing full rebuild.
async function invalidateAfterRowMetaWrite(id, oldRow, changed) {
  const previousVersion = getDataVersion();
  await flushShowProgressUpdates().catch((err) => {
    console.error("[dataRepo] Failed to flush show progress updates", err);
  });
  const version = bumpDataVersion();
  const freshRow = id ? selectByIdStmt.get(String(id)) : null;
  if (!oldRow || !freshRow || version !== previousVersion + 1) return;

  if (historyCache.version === previousVersion) {
    const rows = patchCachedRow(historyCache.rows, freshRow);
    if (rows) historyCache = { version, rows };
  }

  const trackedFlipped = isPlektTrackedWatchRow(oldRow) !== isPlektTrackedWatchRow(freshRow);
  if (movieCache.version === previousVersion && Array.isArray(movieCache.rows) && !trackedFlipped) {
    if (freshRow.media_type === "movie") {
      const rows = patchCachedRow(movieCache.rows, freshRow);
      if (rows) movieCache = { version, rows };
    } else {
      movieCache = { version, rows: movieCache.rows };
    }
  }

  if (trackedFlipped || changed === "artwork") return;

  if (statsCache.version === previousVersion && statsCache.stats) {
    statsCache = { version, stats: statsCache.stats };
  }

  const showCacheUnaffected = changed === "retry" || freshRow.media_type === "movie";
  if (showCacheUnaffected && showCache.version === previousVersion) {
    showCache = { version, shows: showCache.shows };
  }
  // Same reasoning for the scheduled-history show set: a retry counter or a
  // movie row cannot change which shows it contains.
  if (showCacheUnaffected && scheduledShowCache.version === previousVersion) {
    scheduledShowCache = { version, shows: scheduledShowCache.shows };
  }
}

// --- Watch history writes --------------------------------------------------
// `id` lets a caller that is replacing a row keep that row's identity - see
// applyManualUnwatch, where a superseding unwatched record stands in for the
// watched one it replaced. It must name a row that no longer exists.
export function insertWatchRecordSync(record, { id: presetId = "", watchlistConfig = null, allowDuringRestore = false } = {}) {
  const normalized = normalizeWatchRecord(record, record.source);
  const errors = validateWatchRecord(normalized);
  if (errors.length) throw new Error(errors.join(", "));
  assertRestoreWriteAllowed(normalized.source, { allowDuringRestore });

  // Queue show progress update
  queueProgressUpdateForRecord(normalized);

  const id = String(presetId || "").trim() || crypto.randomUUID();
  const params = watchRowParams(normalized);
  const storedAt = Date.now();
  db.transaction(() => { insertWatchStmt.run({ id, ...params, created_at: storedAt, updated_at: storedAt }); captureTrackerDestinations(normalized, id); })();
  // Keep the watchlist removal in the same SQLite transaction as the
  // completed watch. Callers with a resolved provider config can queue the
  // fanout immediately; older/import paths without one are repaired by the
  // durable watchlist worker on its next pass.
  if (isWatchedAction(normalized) && ["movie", "tv"].includes(normalized.media_type)) {
    recordWatchlistMutation({
      media: {
        type: normalized.media_type,
        title: normalized.title,
        tmdb_id: normalized.tmdb_id,
        tvdb_id: normalized.tvdb_id,
        imdb_id: normalized.imdb_id,
        poster_url: normalized.poster_url,
      },
      desiredState: "absent",
      origin: "watched",
      reason: "completed_watch",
      config: watchlistConfig,
      timestamp: storedAt,
      eventId: id,
      eventAt: normalized.watched_at,
      guardStale: true,
    });
  }
  recordWatchAuditEvent({
    eventType: isWatchedAction(normalized) ? "history_added" : "history_state_recorded",
    timestamp: storedAt,
    action: normalized.sync_action,
    watchRecordId: id,
    mediaKey: params.media_key,
    mediaType: normalized.media_type,
    title: normalized.title,
    showTitle: params.show_title,
    source: normalized.source,
    sourceEvent: normalized.watch_provenance?.event,
    phase: normalized.watch_provenance?.phase,
    watchProvenance: normalized.watch_provenance,
    ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
    season: normalized.season,
    episode: normalized.episode,
    itemId: normalized.watch_provenance?.item_id,
    sessionId: normalized.watch_provenance?.session_id,
    user: normalized.watch_provenance?.user,
    device: normalized.watch_provenance?.device,
    deviceId: normalized.watch_provenance?.device_id,
    client: normalized.watch_provenance?.client,
    clientVersion: normalized.watch_provenance?.client_version,
    details: isWatchedAction(normalized)
      ? "Watch record added to Plekt history;outbound sync is tracked separately."
      : `Watch history state recorded as ${normalized.sync_action}.`,
    payload: {
      record: normalized,
      provenance: normalized.watch_provenance,
      storedAt,
    },
  });
  if (!String(normalized.source || "").toLowerCase().includes("import")) {
    recordWatchAuditEvent({
      eventType: "sync_queued",
      timestamp: storedAt,
      action: normalized.sync_action,
      watchRecordId: id,
      mediaKey: params.media_key,
      mediaType: normalized.media_type,
      title: normalized.title,
      showTitle: params.show_title,
      source: normalized.source,
      sourceEvent: normalized.watch_provenance?.event,
      phase: normalized.watch_provenance?.phase,
      watchProvenance: normalized.watch_provenance,
      ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
      season: normalized.season,
      episode: normalized.episode,
      itemId: normalized.watch_provenance?.item_id,
      sessionId: normalized.watch_provenance?.session_id,
      user: normalized.watch_provenance?.user,
      device: normalized.watch_provenance?.device,
      deviceId: normalized.watch_provenance?.device_id,
      client: normalized.watch_provenance?.client,
      clientVersion: normalized.watch_provenance?.client_version,
      status: "queued",
      details: "Outbound synchronization queued after the Plekt history write.",
    });
  }
  return { id, record: normalized };
}

export function prefetchWatchRecordAssets({ id = "", record = null } = {}) {
  if (!record || !((record.media_type === "movie" || isWatchedAction(record)) && (record.tmdb_id || record.title))) {
    return Promise.resolve(null);
  }
  return prefetchTmdbMetadataBackground(record.media_type, record.tmdb_id, record.title, id, record).catch(() => null);
}

export async function insertWatchRecord(record, { skipInvalidate = false, id: presetId = "", watchlistConfig = null, allowDuringRestore = false, prefetch = true } = {}) {
  const result = insertWatchRecordSync(record, { id: presetId, watchlistConfig, allowDuringRestore });
  if (!skipInvalidate) await invalidateHistoryDerivedCaches("insertWatchRecord");

  // Eagerly pull + store TMDB metadata/artwork at ingest (fire-and-forget;
  // returned so the webhook can await it before responding if it wants to).
  const assetPrefetch = prefetch ? prefetchWatchRecordAssets(result) : null;
  return { ...result, assetPrefetch };
}

function defaultTelemetry(record) {
  const source = record?.source || "unknown";
  if (String(source).includes("import")) {
    return [
      `Origin: ${source}`,
      `Loop-check: Pending`,
      `Dispatch status: pending`,
      `Details: Historical import stored in Plekt and queued for canonical outbound sync`,
      ...trackerProviderIds().map((provider) => `Target ${provider} status: skipped - No tracker destination authorized by historical import`),
    ].join("\n");
  }
  return [`Origin: ${source}`, `Loop-check: Pending`, `Dispatch status: pending`, `Details: Awaiting outbound sync telemetry`].join("\n");
}

export async function batchInsertWatchRecords(records, {
  source = "trakt_import",
  telemetryForRecord = null,
  prefetch = true,
} = {}) {
  assertRestoreWriteAllowed(source);
  let inserted = 0;
  let skipped = 0;
  const rejected = [];
  const toInsert = [];

  const config = await loadMediaConfig().catch(() => ({}));
  const tmdbApiKey = config.tmdb?.apiKey;

  const prepareRecord = async (record, index) => {
    const normalized = normalizeWatchRecord({ ...record, source: record?.source || source }, source);
    const errors = validateWatchRecord(normalized);
    if (errors.length) return { action: "reject", index, errors };

    if (findExistingStmt.get(mediaKeyFor(normalized), normalized.watched_at)) return { action: "skip" };

    if (tmdbApiKey && !normalized.poster_url) {
      normalized.poster_url = await fetchPosterFromTmdb(normalized, tmdbApiKey);
    }
    return { action: "insert", normalized };
  };

  const CHUNK_SIZE = 10;
  for (let start = 0; start < records.length; start += CHUNK_SIZE) {
    const chunk = records.slice(start, start + CHUNK_SIZE);
    const outcomes = await Promise.all(chunk.map((record, offset) => prepareRecord(record, start + offset)));
    for (const outcome of outcomes) {
      if (outcome.action === "reject") {
        rejected.push({ index: outcome.index, errors: outcome.errors });
      } else if (outcome.action === "skip") {
        skipped += 1;
      } else {
        toInsert.push(outcome.normalized);
        inserted += 1;
      }
    }
  }

  if (toInsert.length) {
    const insertedAuditEvents = [];
    const insertedRecords = [];
    transaction(() => {
      for (const normalized of toInsert) {
        assertRestoreWriteAllowed(normalized.source);
        // Queue show progress update
        queueProgressUpdateForRecord(normalized);
        const id = crypto.randomUUID();
        const params = watchRowParams({
          ...normalized,
          sync_dispatch_telemetry: normalized.sync_dispatch_telemetry || telemetryForRecord?.(normalized) || defaultTelemetry(normalized),
        });
        const storedAt = Date.now();
        insertWatchStmt.run({ id, ...params, created_at: storedAt, updated_at: storedAt });
        if (isWatchedAction(normalized) && ["movie", "tv"].includes(normalized.media_type)) {
          recordWatchlistMutation({
            media: {
              type: normalized.media_type,
              title: normalized.title,
              tmdb_id: normalized.tmdb_id,
              tvdb_id: normalized.tvdb_id,
              imdb_id: normalized.imdb_id,
              poster_url: normalized.poster_url,
            },
            desiredState: "absent",
            origin: "watched",
            reason: "completed_watch",
            config,
            timestamp: storedAt,
            eventId: id,
            eventAt: normalized.watched_at,
            guardStale: true,
          });
        }
        insertedRecords.push({ id, ...normalized, watched_at: params.watched_at, media_key: params.media_key });
        insertedAuditEvents.push({
          eventType: isWatchedAction(normalized) ? "history_added" : "history_state_recorded",
          timestamp: storedAt,
          action: normalized.sync_action,
          watchRecordId: id,
          mediaKey: params.media_key,
          mediaType: normalized.media_type,
          title: normalized.title,
          showTitle: params.show_title,
          source: normalized.source,
          sourceEvent: normalized.watch_provenance?.event,
          phase: normalized.watch_provenance?.phase,
          watchProvenance: normalized.watch_provenance,
          ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
          season: normalized.season,
          episode: normalized.episode,
          itemId: normalized.watch_provenance?.item_id,
          sessionId: normalized.watch_provenance?.session_id,
          user: normalized.watch_provenance?.user,
          device: normalized.watch_provenance?.device,
          deviceId: normalized.watch_provenance?.device_id,
          client: normalized.watch_provenance?.client,
          clientVersion: normalized.watch_provenance?.client_version,
          details: "Watch record imported into Plekt history and queued for canonical outbound sync.",
          payload: { record: normalized, import: true, storedAt },
        });
      }
    });
    recordWatchAuditEvents(insertedAuditEvents);
    for (const normalized of insertedRecords) {
      if (isWatchedAction(normalized)) {
        await upsertPlaystateForMedia({
          title: normalized.title,
          type: normalized.media_type,
          source: normalized.source,
          ids: {
            imdb: normalized.imdb_id || undefined,
            tmdb: normalized.tmdb_id || undefined,
            tvdb: normalized.tvdb_id || undefined,
          },
          season: normalized.season,
          episode: normalized.episode,
          posterUrl: normalized.poster_url || undefined,
          isValid: true,
        }, "watched", normalized.watched_at, { skipInvalidate: true });
      }
    }
    for (const normalized of insertedRecords) {
      if (prefetch && isWatchedAction(normalized) && (normalized.media_type === "movie" || normalized.tmdb_id || normalized.title)) {
        prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title, normalized.id, normalized).catch(() => null);
      }
    }
    await invalidateHistoryDerivedCaches("batchInsertWatchRecords");
    return { inserted, updated: 0, skipped, rejected };
  }
  return { inserted, updated: 0, skipped, rejected };
}

const updateTelemetryStmt = db.prepare("UPDATE watch_history SET sync_dispatch_telemetry = ?, updated_at = ? WHERE id = ?");
const updatePlaystateWatchedAtStmt = db.prepare("UPDATE playstate SET watched_at = ?, updated_at = ? WHERE media_key = ?");
const updateWatchRowWatchedAtStmt = db.prepare("UPDATE watch_history SET watched_at = ?, updated_at = ? WHERE id = ?");
const promoteRowToWatchedStmt = db.prepare(
  `UPDATE watch_history
   SET sync_action = 'watched', sync_dispatch_telemetry = ?, sync_retry_count = 0, sync_next_retry_at = 0,
       created_at = ?, updated_at = ?
   WHERE id = ?`,
);
const reassertWatchRowAuthorityStmt = db.prepare(
  `UPDATE watch_history
   SET sync_action = 'watched', sync_retry_count = 0, sync_next_retry_at = 0,
       created_at = ?, updated_at = ?
   WHERE id = ?`,
);

// Move the exact row created by an explicit Plembfin Mark watched action to
// the end of the canonical transition timeline. Remote callbacks can be
// accepted while outbound dispatch is still running; merely promoting their
// sibling rows is not sufficient because an older manual row can then lose
// the deterministic latest-transition comparison. Returning the persisted
// DB shape also gives the sibling pass its derived show_title/media_key,
// rather than the slimmer normalized request object.
export function reassertWatchRecordAuthoritySync(id) {
  const recordId = String(id || "").trim();
  if (!recordId) return null;
  const existing = selectByIdStmt.get(recordId);
  if (!existing) return null;
  const now = Date.now();
  reassertWatchRowAuthorityStmt.run(now, now, recordId);
  return selectByIdStmt.get(recordId) || null;
}

// An explicit Plembfin "Mark watched" is the newest user decision for the
// whole real item, not just for whichever provider-id key the browser happens
// to send. Older rematches can leave unwatched markers under sibling keys; if
// even one remains unwatched, history dedupe can restore it on the next fresh
// show read despite the new watched row and canonical playstate. Retire every
// related marker instead of promoting it to a watched row: an unwatch marker is
// a state tombstone, not another viewing. Promoting it was the source of the
// duplicate watches and changed dates seen after a season-level Mark watched.
// The append-only audit log still retains the original unwatch event.
export function supersedeUnwatchedTransitionsForRecordSync(existing = {}) {
  if (!existing?.id) return 0;
  const related = [existing, ...siblingWatchRowsFor(existing)];
  const unwatched = related.filter((row) => ["unwatched", "unplayed"].includes(String(row?.sync_action || "").toLowerCase()));
  if (!unwatched.length) return 0;

  let retired = 0;
  for (const row of unwatched) {
    if (deleteWatchRecordByIdSync(row.id)) retired += 1;
  }
  return retired;
}

// All other tracked watch_history rows describing the same movie (by media_key)
// or the same episode (by show+season+episode), regardless of date. Used both
// to list every watch date for the edit-date dialog and, filtered further by
// relatedTrackedWatchRowsForDateEdit, to keep same-day duplicate rows in sync.
function siblingWatchRowsFor(existing = {}) {
  if (!existing.id) return [];
  if (existing.media_type !== "episode") {
    const allMovies = selectMoviesStmt.all().filter(isPlektTrackedWatchRow);
    const ids = [existing.imdb_id, existing.tmdb_id, existing.tvdb_id]
      .map(cleanString)
      .filter(Boolean);
    const titleKey = canonicalTitleKey(existing.title);
    const sameTitle = allMovies.filter((row) => canonicalTitleKey(row.title) === titleKey);
    const parent = new Map();
    const find = (key) => {
      while (parent.get(key) !== key) {
        parent.set(key, parent.get(parent.get(key)));
        key = parent.get(key);
      }
      return key;
    };
    const union = (left, right) => {
      if (left && right) parent.set(find(left), find(right));
    };
    for (const row of sameTitle) {
      const rowIds = [row.imdb_id, row.tmdb_id, row.tvdb_id]
        .map(cleanString)
        .filter(Boolean);
      rowIds.forEach((key) => { if (!parent.has(key)) parent.set(key, key); });
      for (let index = 1; index < rowIds.length; index += 1) union(rowIds[0], rowIds[index]);
    }
    const providerClusters = new Set([...parent.keys()].map(find));
    return allMovies.filter((row) => {
      if (row.id === existing.id) return false;
      const sharesMediaKey = existing.media_key && row.media_key === existing.media_key;
      const sharesProviderId = ids.some((id) => [row.imdb_id, row.tmdb_id, row.tvdb_id]
        .map(cleanString)
        .includes(id));
      const isUnambiguousTitleMatch = titleKey && canonicalTitleKey(row.title) === titleKey && providerClusters.size === 1;
      return sharesMediaKey || sharesProviderId || isUnambiguousTitleMatch;
    });
  }

  // showTitleFrom must wrap the whole show_title-or-title expression, not
  // just the title fallback - the same show's episode rows can carry
  // different exact show_title text over time (a trailing year present on
  // some inserts, absent on others; see the matching comment in
  // queryShowDetail), so normalizing only when show_title happens to be
  // missing silently split an episode's own watch dates into two groups
  // here whenever a duplicate play used a differently-formatted title.
  const showKey = canonicalTitleKey(showTitleFrom(existing.show_title || existing.title));
  const season = existing.season == null ? null : Number(existing.season);
  const episode = existing.episode == null ? null : Number(existing.episode);
  if (!showKey || season == null || episode == null) return [];

  // Include tracked state rows here so legacy databases containing an unwatch
  // marker can still be found and compacted. New explicit unwatches remove the
  // watched rows instead of retaining them as visible historical plays.
  const sameShow = sameShowAs(existing);
  return selectAllEpisodesStmt.all().filter((row) => {
    if (row.id === existing.id || !isPlektTrackedEpisodeRow(row)) return false;
    if (Number(row.season) !== season || Number(row.episode) !== episode) return false;
    return canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey && sameShow(row);
  });
}

// An unwatch is a destructive state change for the local watch history: the
// item must disappear from watched history, not leave old plays behind for the
// next Mark watched action to stack on top of. Keep the canonical playstate
// row and a single unwatch transition as the short-lived tombstone needed to
// reject delayed provider echoes; the append-only watch audit retains what was
// removed without making it user-visible history.
export function clearWatchHistoryForMediaIdentitySync(media = {}, {
  anchor = null,
  removeStateMarkers = false,
  allowDuringRestore = false,
} = {}) {
  assertRestoreWriteAllowed(media?.source || "manual", { allowDuringRestore });

  const candidates = new Map();
  const add = (row) => {
    if (row?.id) candidates.set(String(row.id), row);
  };
  const addByKey = (key) => {
    if (!key) return;
    selectByMediaKeyStmt.all(String(key)).forEach(add);
  };

  const ids = media.ids || {};
  addByKey(mediaKeyFor(media));
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    if (!ids[provider]) continue;
    addByKey(mediaKeyFor({ ...media, ids: { [provider]: ids[provider] } }));
  }

  const anchorRow = anchor?.id ? selectByIdStmt.get(String(anchor.id)) : null;
  if (anchorRow) {
    add(anchorRow);
    siblingWatchRowsFor(anchorRow).forEach(add);
  }

  // When all watched rows have already been removed, the only thing left may
  // be a tombstone. Use the stable show/season/episode identity to find any
  // legacy watched aliases that an exact provider key cannot reach.
  const type = normalizeMediaType(media.media_type || media.mediaType || media.type);
  const season = media.season == null ? null : Number(media.season);
  const episode = media.episode == null ? null : Number(media.episode);
  if (type === "movie") {
    safeMovieIdentityRowsForTitle({
      ...media,
      title: media.title || anchorRow?.title || "",
    }).forEach(add);
  }
  if (type === "episode" && season != null && episode != null) {
    const showTitle = media.show_title || media.showTitle || media.title || anchorRow?.show_title || anchorRow?.title || "";
    const showKey = canonicalTitleKey(showTitleFrom(showTitle));
    const sameShow = sameShowAs({ ...media, media_type: type, title: showTitle });
    if (showKey) {
      selectAllEpisodesStmt.all()
        .filter((row) => (
          Number(row.season) === season
          && Number(row.episode) === episode
          && canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey
          && isPlektTrackedEpisodeRow(row)
          && sameShow(row)
        ))
        .forEach(add);
    }
  }

  const rows = [...candidates.values()].filter((row) => removeStateMarkers || isWatchedAction(row));
  let deleted = 0;
  const deletedIds = [];
  for (const row of rows) {
    if (deleteWatchRecordByIdSync(row.id, { allowDuringRestore })) {
      deleted += 1;
      deletedIds.push(String(row.id));
    }
  }
  return { deleted, deletedIds };
}

// Same-UTC-day siblings are treated as duplicate rows describing the *same*
// watch event (e.g. echoed across sources) and are kept in sync when the date
// is edited. Siblings on a different day are independent rewatches and are
// left alone, so editing one watch date can't silently overwrite another.
function relatedTrackedWatchRowsForDateEdit(existing = {}) {
  // Movie history rows are independent rewatches. Updating one movie row
  // must not stamp every same-day sibling with the same time, otherwise the
  // per-watch editor can never preserve distinct watch times.
  if (existing.media_type !== "episode") return [];
  const day = String(existing.watched_at || "").slice(0, 10);
  if (!day) return [];
  return siblingWatchRowsFor(existing).filter((row) => String(row.watched_at || "").slice(0, 10) === day);
}

// Every watch date recorded for the same movie/episode as `id`, oldest first -
// powers the "Edit Watch Date" dialog's per-date list.
export async function getWatchDatesForRecord(id) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return null;
  const rows = filterSameEventDuplicateRows([existing, ...siblingWatchRowsFor(existing)])
    .map((row) => ({ id: row.id, watched_at: row.watched_at, source: row.source }))
    .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")));
  return {
    title: existing.title,
    media_type: existing.media_type,
    show_title: existing.show_title || null,
    season: existing.season,
    episode: existing.episode,
    rows,
  };
}

// Records an additional watch of the same movie/episode as `id` on a new date
// (e.g. from the "Add another watch date" control), cloning that row's
// identity fields rather than requiring the caller to resupply them.
export async function addWatchDate(id, watchedAtInput) {
  assertRestoreWriteAllowed("manual");
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return { ok: false, error: "Watch record not found" };
  const watchedAt = normalizeWatchedAt(watchedAtInput);
  if (!watchedAt) return { ok: false, error: "Invalid watched_at value" };

  const mediaKey = existing.media_key;
  const siblings = mediaKey ? selectByMediaKeyStmt.all(mediaKey) : [existing];
  if (siblings.some((row) => row.watched_at === watchedAt)) {
    return { ok: false, error: "A watch on that date already exists" };
  }

  const newId = crypto.randomUUID();
  const params = {};
  for (const column of WATCH_COLUMNS) {
    if (column === "id" || column === "watched_at" || column === "sync_dispatch_telemetry") continue;
    params[column] = existing[column];
  }
  params.watched_at = watchedAt;
  params.sync_dispatch_telemetry = ["Origin: manual\nLoop-check: Skipped propagation\nDispatch status: skipped\nDetails: Additional watch date added manually.", ...settledDestinationLines("Additional watch date; not re-propagated")].join("\n");
  const storedAt = Date.now();
  insertWatchStmt.run({ id: newId, ...params, created_at: storedAt, updated_at: storedAt });
  recordWatchAuditEvent({
    eventType: "history_added",
    timestamp: storedAt,
    action: "watched",
    watchRecordId: newId,
    mediaKey,
    mediaType: existing.media_type,
    title: existing.title,
    showTitle: existing.show_title,
    source: "manual",
    ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
    season: existing.season,
    episode: existing.episode,
    details: "Additional watch date added manually to Plekt history.",
    payload: { copiedFromRecordId: existing.id, watchedAt },
  });

  if (mediaKey) {
    const currentPlaystate = selectPlaystateStmt.get(mediaKey);
    if (!currentPlaystate || String(watchedAt) > String(currentPlaystate.watched_at || "")) {
      updatePlaystateWatchedAtStmt.run(watchedAt, Date.now(), mediaKey);
    }
  }

  await invalidateHistoryDerivedCaches("addWatchDate");
  return { ok: true, id: newId };
}

// After deleting a watch row, is there anything left to treat as "still
// watched"? An exact media_key match alone can miss a surviving row: two
// watch_history rows for the same real episode/movie can carry different
// media_keys (one from a provider-ID match, one from an older title-fallback
// insert - the same identity split fixed elsewhere for playstate lookups).
// Deleting the row under one key while a perfectly good watched row for the
// same episode sits under the other key must not report "nothing remains" -
// that false negative is what makes a duplicate-watch cleanup wrongly mark a
// still-watched episode unwatched. siblingWatchRowsFor already implements
// the broader same-show/season/episode (or provider-id/title-cluster for
// movies) identity match used to find which rows to delete together; reuse
// it here to find what survives, unioned with the exact-key match.
//
// Plembfin is the source of truth for what a user deliberately leaves behind:
// if a genuinely watched sibling still exists, it wins exactly as before (a
// real watch that predates a later, deliberate unwatch must not be revived by
// the unwatch marker sorting newer). But if every surviving row reads
// unwatched, the user's own action of deleting down to it - rather than that
// row too - is itself the statement "this is the watch I want kept", even
// though its own sync_action still says otherwise (e.g. a genuine watch whose
// unwatch marker predates today, or a stray marker from a past sync issue).
// Deleting the last real watched row and silently falling back to fully
// unwatched would contradict what the user just did. The survivor is promoted
// to 'watched' in place so it stops looking unwatched on the next read and
// so later duplicate/false-unwatch audits don't re-flag it.
function remainingWatchRowFor(deletedRow) {
  const byExactKey = deletedRow.media_key ? selectByMediaKeyStmt.all(deletedRow.media_key) : [];
  const bySameIdentity = [
    ...siblingWatchRowsFor(deletedRow),
    ...titleOnlyMovieSurvivorsFor(deletedRow),
  ];
  const byId = new Map();
  for (const row of [...byExactKey, ...bySameIdentity]) {
    if (row?.id) byId.set(row.id, row);
  }
  const trusted = [...byId.values()].filter(isPlektTrackedEpisodeRow);
  if (!trusted.length) return null;
  const watched = trusted.filter(isPlektTrackedWatchRow);
  const pool = watched.length ? watched : trusted;
  const newest = pool.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
  if (!watched.length) {
    const now = Date.now();
    const telemetry = [
      "Origin: manual",
      "Loop-check: Passed",
      "Dispatch status: pending",
      "Details: Promoted to watched - the last recorded watch left standing after a duplicate-watch removal.",
    ].join("\n");
    // This is a real canonical state transition performed in place. Advance
    // created_at as the transition clock as well as updated_at; ordinary
    // metadata/telemetry writes only advance updated_at and must not reorder
    // watched versus unwatched intent in dedupeHistory.
    promoteRowToWatchedStmt.run(telemetry, now, now, newest.id);
    newest.sync_action = "watched";
    newest.created_at = now;
    newest.updated_at = now;
  }
  return newest;
}

function providerIdentityTokens(row = {}) {
  return [
    cleanString(row.imdb_id) ? `imdb:${cleanString(row.imdb_id)}` : "",
    cleanString(row.tmdb_id) ? `tmdb:${cleanString(row.tmdb_id)}` : "",
    cleanString(row.tvdb_id) ? `tvdb:${cleanString(row.tvdb_id)}` : "",
  ].filter(Boolean);
}

function sameRemovalCoordinates(left = {}, right = {}) {
  const leftType = normalizeMediaType(left.media_type || left.mediaType || left.type);
  const rightType = normalizeMediaType(right.media_type || right.mediaType || right.type);
  if (!leftType || leftType !== rightType) return false;
  if (leftType !== "episode") return true;
  const leftShow = canonicalTitleKey(showTitleFrom(left.show_title || left.showTitle || left.title));
  const rightShow = canonicalTitleKey(showTitleFrom(right.show_title || right.showTitle || right.title));
  return Boolean(leftShow && leftShow === rightShow
    && Number(left.season ?? -1) === Number(right.season ?? -1)
    && Number(left.episode ?? -1) === Number(right.episode ?? -1));
}

function providerClusterCount(rows = []) {
  const parent = new Map();
  const find = (value) => {
    let current = value;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  const ensure = (value) => { if (!parent.has(value)) parent.set(value, value); };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  for (const row of rows) {
    const ids = providerIdentityTokens(row);
    ids.forEach(ensure);
    for (let index = 1; index < ids.length; index += 1) union(ids[0], ids[index]);
  }
  return new Set([...parent.keys()].map(find)).size;
}

// Plex review titles can spell a movie part as "Part One" while an imported
// watch record uses "Part I". Only use this alias when every matching watched
// row belongs to one provider-identity cluster, so same-title remakes remain
// distinct and are not cleared together.
function safeMovieIdentityRowsForTitle(media = {}) {
  const titleKey = canonicalMovieTitleKey(media.title || "");
  if (!titleKey) return [];

  const rows = selectMoviesStmt.all().filter((row) => (
    isPlektTrackedWatchRow(row)
      && canonicalMovieTitleKey(row.title || "") === titleKey
  ));
  return providerClusterCount(rows) <= 1 ? rows : [];
}

function providerClusterCountForTitle(rows = [], titleKey = "") {
  return providerClusterCount(rows.filter((row) => canonicalTitleKey(row.title) === titleKey));
}

function titleOnlyMovieSurvivorsFor(deletedRow = {}) {
  const type = normalizeMediaType(deletedRow.media_type || deletedRow.mediaType || deletedRow.type);
  if (type !== "movie") return [];
  const titleKey = canonicalTitleKey(deletedRow.title);
  if (!titleKey) return [];
  const titleRows = selectMoviesStmt.all().filter((row) => canonicalTitleKey(row.title) === titleKey);
  const providerClusters = providerClusterCountForTitle([deletedRow, ...titleRows], titleKey);
  if (providerClusters > 1) return [];
  return titleRows.filter((row) => !providerIdentityTokens(row).length);
}

function removalRowsHaveDirectIdentity(left = {}, right = {}) {
  if (!sameRemovalCoordinates(left, right)) return false;
  if (left.media_key && right.media_key && left.media_key === right.media_key) return true;
  const rightIds = new Set(providerIdentityTokens(right));
  return providerIdentityTokens(left).some((id) => rightIds.has(id));
}

function removalRowsHaveSafeMovieTitleIdentity(left = {}, right = {}, allRows = [], allMovieRows = []) {
  if (!sameRemovalCoordinates(left, right)) return false;
  const type = normalizeMediaType(left.media_type || left.mediaType || left.type);
  if (type !== "movie") return false;
  if (canonicalTitleKey(left.title) !== canonicalTitleKey(right.title)) return false;
  // A title-only row can safely join an ID cluster only when this removal
  // group contains one provider cluster. Two same-title films with unrelated
  // IDs remain separate rather than being guessed into one transition.
  const leftIds = providerIdentityTokens(left);
  const rightIds = providerIdentityTokens(right);
  const titleKey = canonicalTitleKey(left.title);
  const allTitleRows = [...allMovieRows, ...allRows];
  return (!leftIds.length || !rightIds.length) && providerClusterCountForTitle(allTitleRows, titleKey) <= 1;
}

function removalRowsForEntry(entry = {}) {
  const rows = [
    ...(Array.isArray(entry.deletedRows) ? entry.deletedRows : []),
    entry.deletedRow,
    entry.remainingRow,
  ].filter(Boolean);
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.id || `${row.media_key || ""}|${row.watched_at || ""}|${row.title || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removalGroupCanInclude(groupEntries = [], entry = {}, allMovieRows = []) {
  const groupRows = groupEntries.flatMap(removalRowsForEntry);
  const entryRows = removalRowsForEntry(entry);
  if (!groupRows.length || !entryRows.length) return false;

  for (const groupRow of groupRows) {
    for (const entryRow of entryRows) {
      if (removalRowsHaveDirectIdentity(groupRow, entryRow)) return true;
    }
  }

  const combinedRows = [...groupRows, ...entryRows];
  return groupRows.some((groupRow) => entryRows.some((entryRow) => (
    removalRowsHaveSafeMovieTitleIdentity(groupRow, entryRow, combinedRows, allMovieRows)
  )));
}

// Bulk deletion can touch several media_keys that are really one movie: for
// example, a provider-ID row and a title-only row can both be selected as
// duplicate watches. Each raw media_key calculation can see a different
// survivor and would otherwise dispatch contradictory watched/unwatched states.
// Keep ambiguous same-title remakes separate, but collapse rows that share a
// provider identity or have one unambiguous title-only side of the cluster.
export function coalesceWatchDateRemovals(entries = []) {
  const allMovieRows = selectMoviesStmt.all();
  const groups = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    const candidates = groups.filter((group) => removalGroupCanInclude(group.entries, entry, allMovieRows));
    const directCandidates = candidates.filter((group) => {
      const groupRows = group.entries.flatMap(removalRowsForEntry);
      const entryRows = removalRowsForEntry(entry);
      return groupRows.some((groupRow) => entryRows.some((entryRow) => removalRowsHaveDirectIdentity(groupRow, entryRow)));
    });
    const target = directCandidates.length === 1
      ? directCandidates[0]
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (target) target.entries.push(entry);
    else groups.push({ entries: [entry] });
  }

  return groups.map((group) => {
    const deletedRows = [];
    const deletedIds = new Set();
    for (const entry of group.entries) {
      for (const row of removalRowsForEntry({ deletedRows: entry.deletedRows, deletedRow: entry.deletedRow })) {
        if (deletedIds.has(row.id)) continue;
        deletedIds.add(row.id);
        deletedRows.push(row);
      }
    }
    const survivors = group.entries.map((entry) => entry.remainingRow).filter(Boolean);
    const remainingRow = survivors
      .slice()
      .sort((left, right) => String(right.watched_at || "").localeCompare(String(left.watched_at || "")))[0] || null;
    const deletedRow = deletedRows[0] || group.entries.find((entry) => entry.deletedRow)?.deletedRow || null;
    return {
      mediaKey: remainingRow?.media_key || deletedRow?.media_key || group.entries[0].mediaKey,
      remainingRow,
      deletedRow,
      deletedRows,
    };
  });
}

function mergedWatchRecordForRows(rows = [], watchedAt = undefined) {
  const validRows = rows.filter(Boolean);
  const primary = validRows.slice().sort((left, right) => {
    const leftIds = providerIdentityTokens(left).length;
    const rightIds = providerIdentityTokens(right).length;
    return rightIds - leftIds;
  })[0] || {};
  const firstValue = (field) => validRows.map((row) => cleanString(row[field])).find(Boolean) || null;
  return {
    title: primary.title,
    media_type: normalizeMediaType(primary.media_type || primary.mediaType || primary.type),
    watched_at: watchedAt || primary.watched_at,
    source: "manual",
    sync_action: "watched",
    imdb_id: firstValue("imdb_id"),
    tmdb_id: firstValue("tmdb_id"),
    tvdb_id: firstValue("tvdb_id"),
    season: primary.season == null ? null : Number(primary.season),
    episode: primary.episode == null ? null : Number(primary.episode),
    poster_url: firstValue("poster_url"),
  };
}

function clearPlaystateForWatchRows(rows = []) {
  const record = mergedWatchRecordForRows(rows);
  const keys = new Set(rows.map((row) => row?.media_key).filter(Boolean));
  if (record.title && record.media_type) keys.add(mediaKeyFor(record));
  for (const row of playstateRowsForIdentity(record)) keys.add(row.media_key);
  for (const key of keys) deletePlaystateByKeyStmt.run(key);
}

// Rebuild the playstate pointer after a watch-date removal from the complete
// identity set, not only the deleted row's media_key. This preserves a
// survivor's state when the deleted and remaining rows use IMDb/TMDB/title
// aliases, and removes all known aliases when the final watch is gone.
export function reconcilePlaystateAfterWatchDateRemovalSync(remainingRow, deletedRows = []) {
  const rows = [remainingRow, ...(deletedRows || [])].filter(Boolean);
  if (!rows.length) return null;
  if (!remainingRow) {
    clearPlaystateForWatchRows(rows);
    return null;
  }
  const record = mergedWatchRecordForRows(rows, remainingRow.watched_at);
  return upsertPlaystateSync(record, "watched");
}

function deletedWatchSuppressionKeys(row = {}) {
  const provenance = normalizeWatchProvenance(row.watch_provenance || row.watchProvenance);
  const keys = [];
  if (provenance?.item_id) keys.push(`item:${provenance.item_id}`);
  const mediaKey = row.media_key || row.mediaKey;
  if (mediaKey) keys.push(`media:${mediaKey}`);
  return [...new Set(keys)];
}

export function recordDeletedWatchSuppression(row = {}) {
  const source = String(row.source || "").toLowerCase();
  const watchedAt = normalizeDeletedWatchSuppressionDate(row.watched_at || row.watchedAt);
  if (!source || !watchedAt || !["plex", "emby", "jellyfin"].includes(source)) return 0;
  const keys = deletedWatchSuppressionKeys(row);
  for (const key of keys) insertDeletedWatchSuppressionStmt.run(source, key, watchedAt, Date.now());
  return keys.length;
}

export function isDeletedWatchSuppressed(media = {}, watchedAt = media.watched_at) {
  const source = String(media.source || "").toLowerCase();
  const stamp = normalizeDeletedWatchSuppressionDate(watchedAt);
  if (!source || !stamp) return false;
  const keys = [];
  const provenance = normalizeWatchProvenance(media.watch_provenance || media.watchProvenance);
  const itemId = media.itemId || media.item_id || provenance?.item_id;
  if (itemId) keys.push(`item:${itemId}`);
  const mediaKey = mediaKeyFor(media);
  if (mediaKey) keys.push(`media:${mediaKey}`);
  return [...new Set(keys)].some((key) => Boolean(selectDeletedWatchSuppressionStmt.get(source, key, stamp)));
}

function normalizeDeletedWatchSuppressionDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

// Removes a single watch date (one row) added via addWatchDate/the edit-date
// dialog, without touching any other watch of the same movie/episode. If the
// deleted row was the current playstate pointer, playstate is rolled back to
// whichever recorded watch is now the most recent one; if none remain, the
// item goes back to unwatched.
export async function deleteWatchDate(id) {
  assertRestoreWriteAllowed("manual");
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return { ok: false, error: "Watch record not found" };

  const candidateRows = [existing, ...siblingWatchRowsFor(existing)];
  const chainIds = sameEventChainIdsFor([existing.id], candidateRows);
  const rowsToDelete = chainIds
    .map((chainId) => (chainId === existing.id ? existing : candidateRows.find((row) => row.id === chainId)))
    .filter(Boolean);

  for (const row of rowsToDelete) {
    recordDeletedWatchSuppression(row);
    queueProgressUpdateForRecord(row);
    deleteByIdStmt.run(String(row.id));
    recordWatchAuditEvent({
      eventType: "history_deleted",
      timestamp: Date.now(),
      action: row.sync_action || "watched",
      watchRecordId: row.id,
      mediaKey: row.media_key,
      mediaType: row.media_type,
      title: row.title,
      showTitle: row.show_title,
      source: row.source,
      ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
      season: row.season,
      episode: row.episode,
      status: "deleted",
      details: row.id === existing.id
        ? "A single watch date was deleted from Plekt history."
        : "An echoed duplicate row chained to the deleted watch date was removed with it.",
      payload: { record: row, operation: "delete_watch_date" },
    });
  }
  const mediaKey = existing.media_key;
  let remainingRow = null;
  if (mediaKey) {
    remainingRow = remainingWatchRowFor(existing);
  }
  reconcilePlaystateAfterWatchDateRemovalSync(remainingRow, rowsToDelete);

  await invalidateHistoryDerivedCaches("deleteWatchDate");
  return { ok: true, remainingRow, deletedRow: existing, deletedRows: rowsToDelete };
}

// Bulk form of deleteWatchDate - used by the season/show "remove duplicate
// watches" cleanup, which can delete dozens of rows across many episodes in
// one action. Recomputes each affected media_key's playstate once at the end
// instead of once per deleted row.
//
// Deliberately does NOT chain-expand via sameEventChainIdsFor the way the
// singular deleteWatchDate does. That expansion exists so deleting one visible
// echo-chain representative also removes its hidden echo siblings - correct
// for "remove this watch date", where every row in the chain really is the
// same viewing event. It is wrong here: the caller (findDuplicateWatchGroups)
// has already decided exactly which ids are extras to remove and which one to
// keep, and the kept row can easily fall within the same chain window as one
// being removed (e.g. two genuinely separate watches recorded with the same
// or a nearby timestamp - "mark watched using the same time as the other").
// Expanding the delete set there silently swept the row meant to survive into
// the deletion too, leaving nothing behind and wrongly marking the item
// unwatched - real incident: removing a duplicate right after adding a watch
// date at another episode's exact time. Deleting exactly the given ids, no
// more, is the only behavior that matches what the caller actually decided.
export async function deleteWatchDates(ids = []) {
  assertRestoreWriteAllowed("manual");
  const uniqueIds = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const deleted = [];
  const notFound = [];
  const affectedMediaKeys = new Set();
  const representativeRowByMediaKey = new Map();
  const deletedRowsByMediaKey = new Map();

  for (const id of uniqueIds) {
    const existing = selectByIdStmt.get(id);
    if (!existing) {
      notFound.push(id);
      continue;
    }

    recordDeletedWatchSuppression(existing);
    queueProgressUpdateForRecord(existing);
    deleteByIdStmt.run(existing.id);
    recordWatchAuditEvent({
      eventType: "history_deleted",
      timestamp: Date.now(),
      action: existing.sync_action || "watched",
      watchRecordId: existing.id,
      mediaKey: existing.media_key,
      mediaType: existing.media_type,
      title: existing.title,
      showTitle: existing.show_title,
      source: existing.source,
      ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
      season: existing.season,
      episode: existing.episode,
      status: "deleted",
      details: "A watch date was removed as part of a bulk duplicate-watch cleanup.",
      payload: { record: existing, operation: "bulk_delete_watch_dates" },
    });
    deleted.push(existing.id);
    if (existing.media_key) {
      affectedMediaKeys.add(existing.media_key);
      if (!representativeRowByMediaKey.has(existing.media_key)) representativeRowByMediaKey.set(existing.media_key, existing);
      if (!deletedRowsByMediaKey.has(existing.media_key)) deletedRowsByMediaKey.set(existing.media_key, []);
      deletedRowsByMediaKey.get(existing.media_key).push(existing);
    }
  }

  const rawAffectedMedia = [];
  for (const mediaKey of affectedMediaKeys) {
    const remainingRow = remainingWatchRowFor(representativeRowByMediaKey.get(mediaKey));
    rawAffectedMedia.push({
      mediaKey,
      remainingRow,
      deletedRow: representativeRowByMediaKey.get(mediaKey),
      deletedRows: deletedRowsByMediaKey.get(mediaKey) || [],
    });
  }
  const affectedMedia = coalesceWatchDateRemovals(rawAffectedMedia);
  for (const media of affectedMedia) {
    reconcilePlaystateAfterWatchDateRemovalSync(media.remainingRow, media.deletedRows);
  }

  if (deleted.length) await invalidateHistoryDerivedCaches("deleteWatchDates");
  return { ok: true, deleted, notFound, affectedMedia };
}

export async function updateWatchTelemetry(id, telemetry, { skipInvalidate = false } = {}) {
  if (!id) return;
  const oldRow = selectByIdStmt.get(String(id));
  updateTelemetryStmt.run(String(telemetry || ""), Date.now(), String(id));
  if (!skipInvalidate) await invalidateAfterRowMetaWrite(id, oldRow, "telemetry");
}

const updateSyncRetryStmt = db.prepare("UPDATE watch_history SET sync_retry_count = ?, sync_next_retry_at = ? WHERE id = ?");

// Tracks the automatic-dispatch backoff state for a watch record. Deliberately
// does not touch updated_at: backoff bookkeeping is not a content change.
export async function updateWatchSyncRetry(id, retryCount, nextRetryAt, { skipInvalidate = false } = {}) {
  if (!id) return;
  const oldRow = selectByIdStmt.get(String(id));
  updateSyncRetryStmt.run(Math.max(0, Number(retryCount) || 0), Math.max(0, Number(nextRetryAt) || 0), String(id));
  if (!skipInvalidate) await invalidateAfterRowMetaWrite(id, oldRow, "retry");
}

// --- Playback progress -----------------------------------------------------
const upsertProgressStmt = db.prepare(
  `INSERT INTO playback_progress (media_key, title, media_type, source, imdb_id, tmdb_id, tvdb_id, season, episode, position_ms, duration_ms, progress, updated_at, sync_dispatch_telemetry)
   VALUES (@media_key, @title, @media_type, @source, @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @position_ms, @duration_ms, @progress, @updated_at, @sync_dispatch_telemetry)
   ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, media_type=excluded.media_type, source=excluded.source,
     imdb_id=excluded.imdb_id, tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, season=excluded.season, episode=excluded.episode,
     position_ms=excluded.position_ms, duration_ms=excluded.duration_ms, progress=excluded.progress, updated_at=excluded.updated_at,
     sync_dispatch_telemetry=excluded.sync_dispatch_telemetry`,
);
const updateProgressTelemetryStmt = db.prepare(
  "UPDATE playback_progress SET sync_dispatch_telemetry = ? WHERE media_key = ?",
);
const deleteProgressStmt = db.prepare("DELETE FROM playback_progress WHERE media_key = ?");
const selectProgressStmt = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?");
const selectProgressByTitleStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND LOWER(title) = ?");
const selectProgressByImdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND imdb_id = ?");
const selectProgressByTmdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND tmdb_id = ?");
const selectProgressByTvdbStmt = db.prepare("SELECT * FROM playback_progress WHERE media_type = ? AND tvdb_id = ?");
const selectProgressByEpisodeCoordinatesStmt = db.prepare(
  "SELECT * FROM playback_progress WHERE media_type = 'episode' AND season = ? AND episode = ?",
);
const selectProgressReplayStmt = db.prepare("SELECT * FROM playback_progress ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?");
const selectProgressSnapshotStmt = db.prepare(
  "SELECT * FROM playback_progress WHERE COALESCE(updated_at, 0) <= ? ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC LIMIT ? OFFSET ?",
);
const countProgressStmt = db.prepare("SELECT COUNT(*) AS c FROM playback_progress");
const countProgressSnapshotStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM playback_progress WHERE COALESCE(updated_at, 0) <= ?",
);

function playbackProgressFromRow(row) {
  const positionMs = Number(row.position_ms || 0);
  const durationMs = row.duration_ms == null ? null : Number(row.duration_ms);
  return {
    id: row.media_key,
    media_key: row.media_key,
    title: decodeBasicHtmlEntities(row.title || ""),
    media_type: row.media_type || "",
    source: row.source || "",
    imdb_id: row.imdb_id || null,
    tmdb_id: row.tmdb_id || null,
    tvdb_id: row.tvdb_id || null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    position_ms: positionMs,
    duration_ms: durationMs,
    progress: playbackProgressPercent(positionMs, durationMs, row.progress),
    updated_at: Number(row.updated_at || 0),
    sync_dispatch_telemetry: row.sync_dispatch_telemetry || null,
  };
}

function playbackProgressPercent(positionMs = 0, durationMs = 0, fallback = 0) {
  const position = Number(positionMs);
  const duration = Number(durationMs);
  if (Number.isFinite(position) && position >= 0 && Number.isFinite(duration) && duration > 0) {
    return Math.max(0, Math.min(100, (position / duration) * 100));
  }
  const value = Number(fallback);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function normalizePlaybackProgressRecord(record = {}, fallbackSource = "webhook") {
  const title = cleanString(record.title || record.name || "");
  const mediaType = normalizeMediaType(record.media_type || record.mediaType || record.type);
  const source = cleanString(record.source || fallbackSource) || fallbackSource;
  const positionMs = Math.max(0, Math.round(Number(record.position_ms ?? record.positionMs ?? record.offsetMs ?? 0)));
  const durationMsValue = Number(record.duration_ms ?? record.durationMs ?? 0);
  const durationMs = Number.isFinite(durationMsValue) && durationMsValue > 0 ? Math.round(durationMsValue) : null;
  const progressValue = playbackProgressPercent(positionMs, durationMs, record.progress);
  const normalized = {
    title,
    media_type: mediaType,
    source,
    imdb_id: emptyToNull(record.imdb_id || record.imdbId || record.imdb || record.ids?.imdb),
    tmdb_id: emptyToNull(record.tmdb_id || record.tmdbId || record.tmdb || record.ids?.tmdb),
    tvdb_id: emptyToNull(record.tvdb_id || record.tvdbId || record.tvdb || record.ids?.tvdb),
    season: numberOrNull(record.season),
    episode: numberOrNull(record.episode),
    position_ms: positionMs,
    duration_ms: durationMs,
    progress: progressValue,
    updated_at: Number(record.updated_at || record.updatedAt || Date.now()),
    sync_dispatch_telemetry: emptyToNull(record.sync_dispatch_telemetry || record.syncDispatchTelemetry),
  };
  return { ...normalized, media_key: record.media_key || record.mediaKey || playbackProgressKey(normalized) };
}

function progressShowTitle(record = {}) {
  return cleanString(record.show_title || record.showTitle || showTitleFrom(record.title || ""));
}

function progressShowKey(record = {}) {
  return canonicalShowTitleKey(progressShowTitle(record));
}

function progressProviderIds(record = {}) {
  return {
    imdb: cleanString(record.imdb_id),
    tmdb: cleanString(record.tmdb_id),
    tvdb: cleanString(record.tvdb_id),
  };
}

function progressEpisodeIdentityCompatible(left = {}, right = {}) {
  if (normalizeMediaType(left.media_type || left.mediaType) !== "episode"
    || normalizeMediaType(right.media_type || right.mediaType) !== "episode") return false;
  if (!sameEpisodeCoordinates(left, right)) return false;
  const leftShow = progressShowKey(left);
  const rightShow = progressShowKey(right);
  if (!leftShow || leftShow !== rightShow) return false;

  // Prefer the identity profiles proven by watch history. This keeps same-title
  // reboots separate while still allowing a provider's episode-level id to
  // join the series-level row for the same episode.
  const profiles = seriesIdentityProfilesForShowTitle(leftShow);
  const leftProfile = progressProfileForIds(progressProviderIds(left), profiles);
  const rightProfile = progressProfileForIds(progressProviderIds(right), profiles);
  if (leftProfile && rightProfile) return leftProfile === rightProfile;
  if (leftProfile || rightProfile) {
    // With multiple proven profiles for the same title, an episode-level id
    // cannot tell us which reboot it belongs to. Keep it separate until the
    // provider supplies a series identity; source equality is not enough.
    if (profiles.length !== 1) return false;
    return cleanString(left.source).toLowerCase() === cleanString(right.source).toLowerCase();
  }

  const leftIds = progressProviderIds(left);
  const rightIds = progressProviderIds(right);
  const sharedId = ["imdb", "tmdb", "tvdb"].some((provider) => (
    leftIds[provider] && rightIds[provider] && leftIds[provider].toLowerCase() === rightIds[provider].toLowerCase()
  ));
  if (sharedId || !Object.values(leftIds).some(Boolean) || !Object.values(rightIds).some(Boolean)) return true;
  // Without a proven series profile, only collapse conflicting identities when
  // they came from the same configured media server. A same-title episode from
  // a different server may be a reboot/rematch and must not be guessed.
  return cleanString(left.source).toLowerCase() === cleanString(right.source).toLowerCase();
}

// A title profile has no id for a provider its history never carried (Scot
// Squad history holds only a TVDB id). When a progress row already shares an id
// with the profile, keep the row's own id in those empty slots: blanking them
// keyed the row apart from the show's other rows, so a Jellyfin play became a
// second, id-less resume card. A row sharing nothing (an episode IMDb id leaked
// into the series slot) still takes only the profile's ids.
function profileIdsFilledFromRecord(profileIds = {}, recordIds = {}) {
  const sharesProfileId = ["imdb", "tmdb", "tvdb"].some((provider) => (
    recordIds[provider] && profileIds[provider] && recordIds[provider].toLowerCase() === profileIds[provider].toLowerCase()
  ));
  if (!sharesProfileId) return profileIds;
  return {
    imdb: profileIds.imdb || recordIds.imdb || "",
    tmdb: profileIds.tmdb || recordIds.tmdb || "",
    tvdb: profileIds.tvdb || recordIds.tvdb || "",
  };
}

function canonicalizePlaybackProgressRecord(record = {}) {
  if (normalizeMediaType(record.media_type || record.mediaType || record.type) !== "episode") return record;
  const showKey = progressShowKey(record);
  const profiles = seriesIdentityProfilesForShowTitle(showKey);
  const recordIds = progressProviderIds(record);
  let profile = profiles.length === 1
    ? profiles[0]
    : progressProfileForIds(recordIds, profiles);
  // The single-known-profile default exists so an id-less event still joins
  // the one show Plembfin has proven for this title. It must not override an
  // id a provider's own series lookup already resolved for this specific
  // event when the two actively disagree - otherwise one provider's
  // mismatched library match (verified live: a Jellyfin "Scrubs" mismatched
  // to "Scrubs (2026)") silently overwrites a different provider's correct
  // resolution for the same title. See docs/decisions.md entry 34.
  // An IMDb-only record is not treated as a series resolution: providers leak
  // the episode's own IMDb id into that slot when their series lookup misses
  // (Emby Ted Lasso S04E06), so only a disagreeing TMDB/TVDB id, which comes
  // from a series-level lookup, outranks the proven profile.
  if (profile && profiles.length === 1 && disagreesWithSoleProfile(recordIds, profile)) profile = null;
  if (!profile) return record;
  const filled = profileIdsFilledFromRecord(profile.ids, recordIds);
  const ids = { imdb_id: filled.imdb || null, tmdb_id: filled.tmdb || null, tvdb_id: filled.tvdb || null };
  return {
    ...record,
    ...ids,
    media_key: playbackProgressKey({ ...record, ...ids }),
  };
}

export function mediaToPlaybackProgressRecord(media, source = media?.source || "webhook") {
  return normalizePlaybackProgressRecord(
    {
      title: media?.title,
      media_type: media?.type || media?.mediaType,
      source,
      imdb_id: media?.ids?.imdb,
      tmdb_id: media?.ids?.tmdb,
      tvdb_id: media?.ids?.tvdb,
      season: media?.season,
      episode: media?.episode,
      position_ms: media?.positionMs ?? media?.offsetMs,
      duration_ms: media?.durationMs,
      progress: media?.progress,
      updated_at: media?.updatedAt,
      sync_dispatch_telemetry: media?.syncDispatchTelemetry,
    },
    source,
  );
}

export async function upsertPlaybackProgress(record) {
  const normalized = canonicalizePlaybackProgressRecord(normalizePlaybackProgressRecord(record, record.source));
  if (!normalized.title) throw new Error("title is required");
  if (!["movie", "episode"].includes(normalized.media_type)) throw new Error("media_type must be movie or episode");
  if (!normalized.position_ms) throw new Error("position_ms is required");
  assertRestoreWriteAllowed(normalized.source);

  const identityMatches = progressRowsForIdentity(normalized);
  const identityMatch = identityMatches[0];
  const mediaKey = normalized.media_type === "episode" && normalized.media_key
    ? normalized.media_key
    : identityMatch?.media_key || normalized.media_key;
  const storedIds = {
    imdb: normalized.imdb_id || identityMatch?.imdb_id || null,
    tmdb: normalized.tmdb_id || identityMatch?.tmdb_id || null,
    tvdb: normalized.tvdb_id || identityMatch?.tvdb_id || null,
  };
  upsertProgressStmt.run({
    media_key: mediaKey,
    title: normalized.title,
    media_type: normalized.media_type,
    source: normalized.source,
    imdb_id: storedIds.imdb,
    tmdb_id: storedIds.tmdb,
    tvdb_id: storedIds.tvdb,
    season: normalized.season,
    episode: normalized.episode,
    position_ms: normalized.position_ms,
    duration_ms: normalized.duration_ms,
    progress: normalized.progress,
    updated_at: normalized.updated_at,
    sync_dispatch_telemetry: normalized.sync_dispatch_telemetry,
  });
  // A provider can arrive with a different leaf id before its series lookup
  // completes. Once this write has a canonical key, remove any aliases that
  // describe the same episode so the dashboard can never render both rows.
  for (const alias of identityMatches) {
    if (alias.media_key && alias.media_key !== mediaKey) deleteProgressStmt.run(alias.media_key);
  }
  // The Up Next projection reads playback_progress, but a progress write does
  // not advance the history version. Without this bump the cached rail keeps
  // serving the old snapshot and no live event tells the dashboard to reload.
  const positionUnchanged = identityMatches.length === 1
    && identityMatch.media_key === mediaKey
    && Number(identityMatch.position_ms || 0) === Number(normalized.position_ms || 0);
  if (!positionUnchanged) bumpUpNextVersion();
  recordWatchAuditEvent({
    eventType: "resume_progress_stored",
    timestamp: normalized.updated_at || Date.now(),
    action: "progress",
    mediaKey,
    mediaType: normalized.media_type,
    title: normalized.title,
    source: normalized.source,
    ids: storedIds,
    season: normalized.season,
    episode: normalized.episode,
    details: "Resume progress stored in Plekt.",
    payload: {
      positionMs: normalized.position_ms,
      durationMs: normalized.duration_ms,
      progress: normalized.progress,
    },
  });
  if (normalized.tmdb_id || normalized.title) {
    prefetchTmdbMetadataBackground(normalized.media_type, normalized.tmdb_id, normalized.title).catch(() => null);
  }
  return { ...normalized, ...storedIds, media_key: mediaKey };
}

function progressRowsForIdentity(record = {}) {
  const rows = identityRows(record, {
    imdb: selectProgressByImdbStmt,
    tmdb: selectProgressByTmdbStmt,
    tvdb: selectProgressByTvdbStmt,
  });
  if (normalizeMediaType(record.media_type || record.mediaType || record.type) === "episode"
    && Number.isFinite(Number(record.season))
    && Number.isFinite(Number(record.episode))) {
    selectProgressByEpisodeCoordinatesStmt
      .all(record.season, record.episode)
      .filter((row) => progressEpisodeIdentityCompatible(record, row))
      .forEach((row) => {
        if (!rows.some((existing) => existing.media_key === row.media_key)) rows.push(row);
      });
  }
  return rows.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}

export async function updatePlaybackProgressTelemetry(mediaOrRecord, telemetry) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  const mediaKey = progressRowsForIdentity(normalized)[0]?.media_key || normalized.media_key;
  // `updated_at` is the source playback-progress timestamp. Replay ordering,
  // authority comparisons, backups, and Emby's LastPlayedDate all depend on
  // it remaining stable until the position itself changes. Dispatch telemetry
  // is metadata only and must not make old resume state look newly played.
  updateProgressTelemetryStmt.run(String(telemetry || ""), mediaKey);
}

export async function getPlaybackProgressForMedia(mediaOrRecord) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  const exact = selectProgressStmt.get(normalized.media_key);
  const related = selectProgressByTitleStmt
    .all(normalized.media_type, normalized.title.toLowerCase())
    .filter((row) => sameEpisodeCoordinates(normalized, row));
  const row = newestByUpdatedAt([exact, ...progressRowsForIdentity(normalized), ...related]);
  return row ? playbackProgressFromRow(row) : null;
}

export function deletePlaybackProgressSync(mediaOrRecord, { allowDuringRestore = false } = {}) {
  const normalized = normalizePlaybackProgressRecord(mediaOrRecord, mediaOrRecord?.source);
  assertRestoreWriteAllowed(normalized.source, { allowDuringRestore });
  if (!normalized.media_key) return false;
  const related = normalized.title
    ? selectProgressByTitleStmt
        .all(normalized.media_type, normalized.title.toLowerCase())
        .filter((row) => sameEpisodeCoordinates(normalized, row))
    : [];
  const keys = new Set([
    normalized.media_key,
    ...progressRowsForIdentity(normalized).map((row) => row.media_key).filter(Boolean),
    ...related.map((row) => row.media_key).filter(Boolean),
  ]);
  let removed = 0;
  for (const key of keys) {
    const deleted = Number(deleteProgressStmt.run(key).changes || 0);
    removed += deleted;
    if (!deleted) continue;
    recordWatchAuditEvent({
      eventType: "resume_progress_cleared",
      timestamp: Date.now(),
      action: "progress",
      mediaKey: key,
      mediaType: normalized.media_type,
      title: normalized.title,
      source: normalized.source,
      ids: { imdb: normalized.imdb_id, tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id },
      season: normalized.season,
      episode: normalized.episode,
      details: "Resume progress cleared from Plekt.",
    });
  }
  // Same contract as upsertPlaybackProgress: a cleared resume must leave the rail.
  if (removed) bumpUpNextVersion();
  return removed > 0;
}

export async function deletePlaybackProgress(mediaOrRecord, options = {}) {
  return deletePlaybackProgressSync(mediaOrRecord, options);
}

export async function listPlaybackProgressRowsForReplay({ limit = 25, offset = 0, snapshotAt = undefined } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeSnapshotAt = Number(snapshotAt);
  const rows = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? selectProgressSnapshotStmt.all(safeSnapshotAt, safeLimit, safeOffset)
    : selectProgressReplayStmt.all(safeLimit, safeOffset);
  return rows.map(playbackProgressFromRow);
}

export async function countPlaybackProgressRows({ snapshotAt = undefined } = {}) {
  const safeSnapshotAt = Number(snapshotAt);
  const row = Number.isFinite(safeSnapshotAt) && safeSnapshotAt > 0
    ? countProgressSnapshotStmt.get(safeSnapshotAt)
    : countProgressStmt.get();
  return row.c || 0;
}

// Data-quality counters for the Sync Health panel. These conditions were
// previously only observable by reading the server log.
// Two plays of the same item recorded within this window are one viewing written
// down twice: nobody finishes an episode and starts it again inside ten minutes.
// Matching on an identical timestamp is not enough - a watch propagated between
// media servers lands milliseconds to minutes apart, never on the same instant,
// so an exact-match test reports almost none of the duplicates that exist.
export const SAME_EVENT_WINDOW_MS = 10 * 60 * 1000;

const selectWatchedStampsStmt = db.prepare(
  `SELECT id, title, title_lower, media_type, watched_at, sync_action,
          sync_dispatch_telemetry, imdb_id, tmdb_id, tvdb_id, season, episode, media_key, show_title
     FROM watch_history
    WHERE watched_at IS NOT NULL
      AND (sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed'))`,
);

export function backfillWatchRecordIdsAndKeys() {
  const allRows = db.prepare(
    "SELECT id, title, title_lower, media_type, watched_at, sync_action, imdb_id, tmdb_id, tvdb_id, season, episode, media_key FROM watch_history"
  ).all();

  const idMap = new Map();
  for (const r of allRows) {
    if (r.imdb_id || r.tmdb_id || r.tvdb_id) {
      const type = (r.media_type || "").toLowerCase() === "series" ? "show" : (r.media_type || "").toLowerCase() || "movie";
      const key = `${r.title_lower}|${type}|${r.season || ""}|${r.episode || ""}`;
      if (!idMap.has(key)) {
        idMap.set(key, { imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, tvdb_id: r.tvdb_id });
      }
    }
  }

  const updateStmt = db.prepare(
    "UPDATE watch_history SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ?, updated_at = ? WHERE id = ?"
  );

  let updatedCount = 0;
  const now = Date.now();

  db.transaction(() => {
    for (const r of allRows) {
      if (!r.imdb_id && !r.tmdb_id && !r.tvdb_id) {
        const type = (r.media_type || "").toLowerCase() === "series" ? "show" : (r.media_type || "").toLowerCase() || "movie";
        const lookupKey = `${r.title_lower}|${type}|${r.season || ""}|${r.episode || ""}`;
        const match = idMap.get(lookupKey);
        if (match) {
          const updatedRow = { ...r, imdb_id: match.imdb_id, tmdb_id: match.tmdb_id, tvdb_id: match.tvdb_id };
          const canonicalKey = mediaKeyFor(updatedRow);
          updateStmt.run(match.imdb_id || null, match.tmdb_id || null, match.tvdb_id || null, canonicalKey, now, r.id);
          updatedCount++;
        }
      }
    }
  })();

  return updatedCount;
}

// Ids of rows that restate a viewing already recorded by an earlier row. Plays
// chain into one viewing while each is within the window of the one before it,
// and the earliest row of each chain is the one kept.
export function sameEventDuplicateIds(windowMs = SAME_EVENT_WINDOW_MS) {
  return sameEventDuplicateIdsForRows(selectWatchedStampsStmt.all().filter(isPlektTrackedWatchRow), windowMs);
}

function episodeProviderGroupKeys(rows = []) {
  return showGroupKeys(rows.filter((row) => normalizeWatchMediaType(row.media_type) === "episode"));
}

function sameEventKey(row = {}, providerGroupKey = "") {
  const type = normalizeWatchMediaType(row.media_type);
  // Episodes are the important cross-key case: Plex, Emby, Jellyfin, and
  // imports can use different provider IDs for the same show episode. The
  // show/season/episode identity is stable, while provider IDs are not.
  // Movies intentionally remain provider-ID-first so two films with the
  // same title are never collapsed merely because their titles match.
  if (type === "episode") {
    const show = providerGroupKey || canonicalTitleKey(row.show_title || showTitleFrom(row.title));
    const season = row.season ?? "unknown";
    const episode = row.episode ?? "unknown";
    return show && season !== "unknown" && episode !== "unknown"
      ? `episode|show:${show}|s:${season}|e:${episode}`
      : mediaKeyFor(row);
  }
  if (type === "movie") {
    return row.imdb_id
      ? `movie|imdb:${normalizeKeyPart(row.imdb_id)}`
      : row.tmdb_id
        ? `movie|tmdb:${normalizeKeyPart(row.tmdb_id)}`
        : row.tvdb_id
          ? `movie|tvdb:${normalizeKeyPart(row.tvdb_id)}`
          : `movie|title:${canonicalTitleKey(row.title)}`;
  }
  if (type === "tv") return `tv|${mediaKeyFor(row)}|${String(row.watched_at || "").slice(0, 10)}`;
  return mediaKeyFor(row);
}

function sameEventDuplicateIdsForRows(rows = [], windowMs = SAME_EVENT_WINDOW_MS, providerGroupKeys = null) {
  const allWatched = rows.filter((row) => row?.watched_at && isWatchedAction(row));
  const groupKeys = providerGroupKeys || episodeProviderGroupKeys(rows);
  const byKey = new Map();
  for (const row of allWatched) {
    const key = sameEventKey(row, groupKeys.get(row));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const duplicates = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (Date.parse(a.watched_at) || 0) - (Date.parse(b.watched_at) || 0));
    let previous = Date.parse(group[0].watched_at) || 0;
    for (let index = 1; index < group.length; index++) {
      const current = Date.parse(group[index].watched_at) || 0;
      if (current - previous <= windowMs) duplicates.push(group[index].id);
      previous = current;
    }
  }
  return duplicates;
}

// The Edit Watch Date dialog shows one row per real viewing event and hides
// any echoed duplicate chained to it within SAME_EVENT_WINDOW_MS (see
// filterSameEventDuplicateRows above). Deleting only the visible row leaves
// its hidden echo behind, and that echo resurfaces as a "new" watch date the
// next time the list is rebuilt. Expand each requested id to every id in its
// same-event chain so the whole event - visible row and hidden echoes alike -
// is removed together.
function sameEventChainIdsFor(targetIds, rows = [], windowMs = SAME_EVENT_WINDOW_MS) {
  const targets = new Set(targetIds);
  const allWatched = rows.filter((row) => row?.id && row.watched_at && isWatchedAction(row));
  const groupKeys = episodeProviderGroupKeys(rows);
  const byKey = new Map();
  for (const row of allWatched) {
    const key = sameEventKey(row, groupKeys.get(row));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const result = new Set(targetIds);
  for (const group of byKey.values()) {
    group.sort((a, b) => (Date.parse(a.watched_at) || 0) - (Date.parse(b.watched_at) || 0));
    let chain = [];
    let previous = null;
    const flushChain = () => {
      if (chain.length > 1 && chain.some((rowId) => targets.has(rowId))) {
        chain.forEach((rowId) => result.add(rowId));
      }
      chain = [];
    };
    for (const row of group) {
      const time = Date.parse(row.watched_at) || 0;
      if (chain.length && time - previous > windowMs) flushChain();
      chain.push(row.id);
      previous = time;
    }
    flushChain();
  }
  return [...result];
}

// Return only rows representing real viewing events. A webhook echo or a
// server-to-server propagation can produce several rows within the same
// viewing window; those rows must not become phantom rewatches in cards,
// details, or playHistory.
function filterSameEventDuplicateRows(rows = []) {
  const groupKeys = episodeProviderGroupKeys(rows);
  const duplicateIds = new Set(sameEventDuplicateIdsForRows(rows, SAME_EVENT_WINDOW_MS, groupKeys));
  return rows.filter((row) => !row?.id || !duplicateIds.has(row.id));
}
const countNullSeasonEpisodesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM watch_history WHERE media_type = 'episode' AND season IS NULL"
);
const countOpaqueShowTitlesStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM watch_history WHERE show_title LIKE '%://%'"
);

export function countRewatchedItems() {
  const rows = selectWatchedStampsStmt.all().filter(isPlektTrackedWatchRow);
  return dedupeHistory(rows).filter((row) => Array.isArray(row.playHistory) && row.playHistory.length > 1).length;
}

export function watchHistoryQualityCounts() {
  return {
    sameEventDuplicateRows: sameEventDuplicateIds().length,
    rewatchedItems: countRewatchedItems(),
    nullSeasonEpisodeRows: countNullSeasonEpisodesStmt.get().c || 0,
    opaqueShowTitleRows: countOpaqueShowTitlesStmt.get().c || 0,
  };
}

// --- Live tracking cache ---------------------------------------------------
const selectLiveStmt = db.prepare("SELECT * FROM live_tracking_cache ORDER BY updated_at DESC");
const upsertLiveStmt = db.prepare(
  `INSERT INTO live_tracking_cache (session_id, title, source_platform, last_progress, updated_at, completed_at, payload, expire_at)
   VALUES (@session_id, @title, @source_platform, @last_progress, @updated_at, @completed_at, @payload, @expire_at)
   ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, source_platform=excluded.source_platform,
     last_progress=excluded.last_progress, updated_at=excluded.updated_at, completed_at=excluded.completed_at,
     payload=excluded.payload, expire_at=excluded.expire_at`,
);
const markLiveCompleteStmt = db.prepare(
  `INSERT INTO live_tracking_cache (session_id, completed_at, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(session_id) DO UPDATE SET completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
);
const deleteLiveStmt = db.prepare("DELETE FROM live_tracking_cache WHERE session_id = ?");
const selectAllLiveStmt = db.prepare("SELECT * FROM live_tracking_cache");
const deleteLiveByIdStmt = db.prepare("DELETE FROM live_tracking_cache WHERE session_id = ?");

export async function loadLiveTrackingCache({ includeCompleted = false } = {}) {
  return selectLiveStmt.all()
    .map((row) => ({
      session_id: row.session_id,
      title: row.title || "",
      source_platform: row.source_platform || "",
      last_progress: Number(row.last_progress || 0),
      updated_at: Number(row.updated_at || 0),
      completed_at: row.completed_at ?? null,
      payload_json: row.payload || "{}",
    }))
    .filter((row) => includeCompleted || row.completed_at == null);
}

export async function upsertLiveTrackingCache(rows = []) {
  if (!rows.length) return;
  transaction(() => {
    for (const row of rows) {
      upsertLiveStmt.run({
        session_id: String(row.session_id),
        title: row.title,
        source_platform: row.source_platform,
        last_progress: Number(row.last_progress || 0),
        updated_at: Number(row.updated_at || Date.now()),
        completed_at: row.completed_at == null ? null : Number(row.completed_at),
        payload: row.payload_json || "{}",
        expire_at: Date.now() + 24 * 60 * 60 * 1000,
      });
    }
  });
}

export async function markLiveTrackingComplete(sessionId, completedAt = Date.now()) {
  if (!sessionId) return;
  markLiveCompleteStmt.run(String(sessionId), Number(completedAt), Number(completedAt));
}

export async function deleteLiveTrackingCacheRows(sessionIds = []) {
  const ids = sessionIds.map((sessionId) => cleanString(sessionId)).filter(Boolean);
  if (!ids.length) return;
  transaction(() => {
    for (const id of ids) deleteLiveStmt.run(id);
  });
}

export async function purgeCompletedLiveTrackingCache(olderThan = Date.now() - 24 * 60 * 60 * 1000) {
  const rows = selectAllLiveStmt.all();
  transaction(() => {
    for (const row of rows) {
      if (row.completed_at != null && Number(row.updated_at || 0) < olderThan) deleteLiveByIdStmt.run(row.session_id);
    }
  });
}

// --- History queries -------------------------------------------------------
async function loadHistoryRows({ limit = 50, offset = 0, fresh = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (fresh) {
    return selectAllHistoryStmt.all().map(rowToWatch).slice(safeOffset, safeOffset + safeLimit);
  }
  const allRows = await getCachedHistory();
  return allRows.slice(safeOffset, safeOffset + safeLimit);
}

async function loadHistoryRowsByType({ mediaType, limit = 50, offset = 0, sort = "watched_desc" } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const allRows = await getCachedHistory();
  const filtered = allRows.filter((row) => (mediaType === "episode"
    ? row.media_type === "episode" || row.media_type === "tv"
    : row.media_type === mediaType) && isPlektTrackedWatchRow(row));
  const sorted = [...filtered];
  if (sort === "watched_asc") {
    sorted.sort((a, b) => a.watched_at.localeCompare(b.watched_at));
  } else {
    sorted.sort((a, b) => b.watched_at.localeCompare(a.watched_at));
  }
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

function matchesSearch(row, search) {
  if (!search) return true;
  const haystack = [row.title, row.source, row.imdb_id, row.tmdb_id, row.tvdb_id, row.sync_dispatch_telemetry].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function normalizeForSearch(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleContainsSearch(title, search) {
  const needle = normalizeForSearch(search);
  if (!needle) return true;
  return normalizeForSearch(title).includes(needle);
}

function playHistoryEntry(row = {}) {
  return { id: row.id, watched_at: row.watched_at, source: row.source, syncAction: row.sync_action || "watched" };
}

function canonicalHistorySource(value) {
  const source = cleanString(value).toLowerCase();
  if (!source) return "";
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  if (source.startsWith("manual") || source.startsWith("force_sync") || source.startsWith("plembfin")) return "manual";
  return "plex";
}

function dedupeHistorySources(values = []) {
  return [...new Set(values.map(canonicalHistorySource).filter(Boolean))];
}

const MEDIA_SERVER_HISTORY_SOURCES = new Set(["plex", "emby", "jellyfin"]);

function isMediaServerHistorySource(value) {
  const source = cleanString(value).toLowerCase();
  return [...MEDIA_SERVER_HISTORY_SOURCES].some((platform) => source === platform || source.startsWith(`${platform}_`) || source.startsWith(`${platform}-`));
}

function watchSourcesFromRows(rows = []) {
  return dedupeHistorySources(rows.filter(isWatchedAction).map((row) => row.source));
}

function canonicalTransitionTime(row = {}) {
  const createdAt = Number(row.created_at ?? row.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  // Pre-created_at databases still need a stable best-effort order. Only
  // those legacy rows fall back to updated_at; for current rows updated_at is
  // deliberately metadata time and cannot express watched/unwatched intent.
  const updatedAt = Number(row.updated_at ?? row.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
}

function acceptedLiveWatchSourceTime(row = {}) {
  if (!isWatchedAction(row) || !isMediaServerHistorySource(row.source)) return 0;
  const provenance = normalizeWatchProvenance(row.watch_provenance || row.watchProvenance);
  if (provenance?.ingest_path !== "live_session"
    || provenance?.event !== "playback.complete"
    || provenance?.phase !== "completed"
    || provenance?.confidence !== "exact") return 0;
  const sourceTime = Date.parse(String(provenance.source_timestamp || ""));
  return Number.isFinite(sourceTime) ? sourceTime : 0;
}

// The provider's source_timestamp comes from the media server's clock and
// created_at from Plembfin's. Requiring both to be newer than the manual
// unwatch means neither a skewed provider clock nor a late-ingested replay of
// an older completion can revive the tombstone. See docs/decisions.md entry 31.
function acceptedLiveWatchIsNewerThanManual(liveRow = {}, manualRow = {}) {
  const manualTime = canonicalTransitionTime(manualRow);
  return acceptedLiveWatchSourceTime(liveRow) > manualTime
    && canonicalTransitionTime(liveRow) > manualTime;
}

function canonicalTransitionIsNewer(row = {}, existing = {}) {
  // Plembfin's explicit action is authoritative over a provider echo. A
  // media-server *unwatch* is the one opposite-state exception: it can be a
  // deliberate user action made directly in Plex/Emby/Jellyfin, so a newer
  // provider unwatch is allowed to clear an older manual watch. Tracker
  // unwatches remain subordinate to Plembfin because those callbacks are also
  // used for reconciliation/echoes. A manual unwatch can be revived only by
  // a newer exact live-session playback completion, which represents a real
  // later watch rather than a generic provider flag.
  const rowIsWatched = isWatchedAction(row);
  const existingIsWatched = isWatchedAction(existing);
  const rowTime = canonicalTransitionTime(row);
  const existingTime = canonicalTransitionTime(existing);
  const rowSource = canonicalHistorySource(row.source);
  const existingSource = canonicalHistorySource(existing.source);
  if (rowIsWatched !== existingIsWatched) {
    const rowIsMediaServerUnwatch = !rowIsWatched && isMediaServerHistorySource(row.source);
    const existingIsMediaServerUnwatch = !existingIsWatched && isMediaServerHistorySource(existing.source);
    const rowIsAcceptedLiveWatch = rowIsWatched && acceptedLiveWatchSourceTime(row) > 0;
    const existingIsAcceptedLiveWatch = existingIsWatched && acceptedLiveWatchSourceTime(existing) > 0;
    if (rowIsAcceptedLiveWatch && !existingIsWatched && existingSource === "manual") {
      return acceptedLiveWatchIsNewerThanManual(row, existing);
    }
    if (!rowIsWatched && existingIsAcceptedLiveWatch && rowSource === "manual") {
      return !acceptedLiveWatchIsNewerThanManual(existing, row);
    }
    if (rowSource === "manual" && existingSource === "manual") return rowTime > existingTime;
    if (rowIsMediaServerUnwatch && existingSource === "manual") return rowTime > existingTime;
    if (existingIsMediaServerUnwatch && rowSource === "manual") return rowTime > existingTime;
    if (rowSource === "manual" || existingSource === "manual") return rowSource === "manual";
    return rowTime > existingTime;
  }

  const rowIsManual = String(row.source || "").toLowerCase() === "manual";
  const existingIsManual = String(existing.source || "").toLowerCase() === "manual";
  if (rowIsManual !== existingIsManual) return rowIsManual;

  if (rowTime !== existingTime) return rowTime > existingTime;
  // Millisecond timestamps can tie during a rapid transition. Keep the result
  // independent of query/iteration order even when neither row is provably
  // newer; the id is only a deterministic final tie-breaker.
  return String(row.id || "").localeCompare(String(existing.id || "")) > 0;
}

export function dedupeHistory(rows) {
  const groupKeys = episodeProviderGroupKeys(rows);
  const transitionGroups = new Map();
  for (const row of rows) {
    const key = historyDedupeKey(row, groupKeys.get(row));
    if (!transitionGroups.has(key)) transitionGroups.set(key, []);
    transitionGroups.get(key).push(row);
  }
  const displayGroups = new Map();
  for (const row of filterSameEventDuplicateRows(rows)) {
    const key = historyDedupeKey(row, groupKeys.get(row));
    if (!displayGroups.has(key)) displayGroups.set(key, []);
    displayGroups.get(key).push(row);
  }

  const result = [];
  for (const [key, transitionRows] of transitionGroups) {
    // Resolve canonical watched/unwatched intent across the entire identity
    // group before choosing its display row. A pairwise fold is not safe here:
    // an older same-state row with a later historical watched_at can otherwise
    // hide the actual newest transition before an opposite-state row is seen.
    // Same-event filtering is display/count cleanup only: a rapid unwatch then
    // rewatch can produce a legitimate newer watched transition within ten
    // minutes of an earlier watch, and dropping it here would leave the
    // intervening unwatch falsely canonical.
    let latestTransition = transitionRows[0];
    for (const row of transitionRows.slice(1)) {
      if (canonicalTransitionIsNewer(row, latestTransition)) latestTransition = row;
    }
    const canonicalWatched = isWatchedAction(latestTransition);
    const displayRows = displayGroups.get(key) || transitionRows;
    const canonicalRows = displayRows.filter((row) => isWatchedAction(row) === canonicalWatched);

    // Within the winning state, retain the existing display behavior: the
    // latest historical watch date is the representative row.
    let representative = canonicalRows[0] || latestTransition;
    for (const row of canonicalRows.slice(1)) {
      if (String(row.watched_at || "") > String(representative.watched_at || "")) representative = row;
    }

    // Same-event display cleanup deliberately keeps the earliest copy of an
    // echoed watch. Its provider ids can be stale or incomplete, however: a
    // later explicit Plembfin transition may carry the corrected Fix Match
    // bridge while sharing the exact historical watch date. Preserve the
    // visible event but take identity from the canonical newest transition.
    representative = { ...representative };
    for (const field of ["imdb_id", "tmdb_id", "tvdb_id"]) {
      if (latestTransition?.[field]) representative[field] = latestTransition[field];
      if (!representative[field]) {
        representative[field] = transitionRows.find((row) => row?.[field])?.[field] || null;
      }
    }
    if (latestTransition?.media_key) representative.media_key = latestTransition.media_key;

    // A provider webhook can echo an explicit Plembfin watch within the
    // same-event display window. The provider copy remains useful for the
    // aggregate `sources`/playHistory data, but it must not become the
    // representative source shown to the user: the action was taken in
    // Plembfin. Carry the authoritative manual transition's source and
    // telemetry onto the compact representative row while keeping the
    // existing display-row id/date stability intact.
    if (canonicalHistorySource(latestTransition?.source) === "manual") {
      representative.source = latestTransition.source || representative.source;
      if (latestTransition?.sync_dispatch_telemetry) {
        representative.sync_dispatch_telemetry = latestTransition.sync_dispatch_telemetry;
      }
    }

    const playHistory = displayRows
      .map(playHistoryEntry)
      .sort((a, b) => String(a.watched_at).localeCompare(String(b.watched_at)));
    const posterUrl = representative.poster_url || displayRows.find((row) => row.poster_url)?.poster_url || null;
    const sources = watchSourcesFromRows(transitionRows);
    result.push({ ...representative, ...(posterUrl ? { poster_url: posterUrl } : {}), playHistory, sources });
  }
  return result;
}

function historyDedupeKey(row = {}, providerGroupKey = "") {
  const mediaType = normalizeWatchMediaType(row.media_type);
  const imdb = cleanString(row.imdb_id);
  const tmdb = cleanString(row.tmdb_id);
  const tvdb = cleanString(row.tvdb_id);

  if (mediaType === "episode") {
    const season = row.season ?? "unknown";
    const episode = row.episode ?? "unknown";
    const showTitle = providerGroupKey || canonicalTitleKey(row.show_title || showTitleFrom(row.title));
    if (showTitle && season !== "unknown" && episode !== "unknown") {
      return `episode|show:${showTitle}|s:${season}|e:${episode}`;
    }
    return `episode|id:${imdb || tmdb || tvdb || canonicalTitleKey(row.title)}|s:${season}|e:${episode}`;
  }

  if (mediaType === "movie") {
    const title = canonicalTitleKey(row.title);
    const poster = stablePosterKey(row.poster_url);
    // Prefer a stable content identifier so the same movie watched more than once
    // (and re-fetched with a different poster URL each time) collapses to one entry.
    // Poster/title are only a fallback when no external ID is present.
    return `movie|${imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : poster ? `poster:${poster}` : `title:${title}`}`;
  }

  if (mediaType === "tv") return `tv|${mediaKeyFor(row)}|${String(row.watched_at || "").slice(0, 10)}`;

  return `${mediaType || "unknown"}|${canonicalTitleKey(row.title)}|${row.watched_at || ""}`;
}

export async function listRecentTrackedWatchRows({ limit = 100, scanLimit = 400, includeScheduled = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeScanLimit = Math.min(Math.max(Number(scanLimit) || safeLimit * 4, safeLimit), 2000);
  const rows = selectRecentStmt
    .all(safeScanLimit)
    .map(rowToWatch)
    .filter((row) => isWatchedAction(row) && (includeScheduled || isPlektTrackedWatchRow(row)));
  return dedupeHistory(rows).slice(0, safeLimit);
}

// Unwatch detection must follow when Plembfin last learned about a record, not
// the media's watched_at value. Plex can legitimately report an old watch date
// (and sparse notifications have historically fallen back to release dates),
// which otherwise makes a newly received watched item invisible to the polling
// safety net immediately after it is inserted.
export async function listRecentlyUpdatedTrackedWatchRows({ limit = 100, scanLimit = 400, includeScheduled = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeScanLimit = Math.min(Math.max(Number(scanLimit) || safeLimit * 4, safeLimit), 2000);
  const rows = selectRecentlyUpdatedStmt
    .all(safeScanLimit)
    .map(rowToWatch)
    .filter((row) => isWatchedAction(row) && (includeScheduled || isPlektTrackedWatchRow(row)));
  return dedupeHistory(rows).slice(0, safeLimit);
}

function trackedHistoryWhereSql(alias = "") {
  const column = (name) => alias ? `${alias}.${name}` : name;
  return `
    (${column("sync_action")} IS NULL OR LOWER(${column("sync_action")}) NOT IN ('unwatched', 'unplayed'))
    AND (
      ${column("sync_dispatch_telemetry")} IS NULL
      OR (
        ${column("sync_dispatch_telemetry")} NOT LIKE '%Watch event fetched from Plex library history%'
        AND ${column("sync_dispatch_telemetry")} NOT LIKE '%Watch event fetched from Emby library history%'
        AND ${column("sync_dispatch_telemetry")} NOT LIKE '%Watch event fetched from Jellyfin library history%'
      )
      OR CASE
        WHEN json_valid(COALESCE(${column("watch_provenance")}, '')) THEN
          NULLIF(json_extract(${column("watch_provenance")}, '$.event'), '') = 'library_history'
          AND NULLIF(json_extract(${column("watch_provenance")}, '$.user'), '') IS NOT NULL
          AND NULLIF(json_extract(${column("watch_provenance")}, '$.source_timestamp'), '') IS NOT NULL
        ELSE 0
      END
    )
  `;
}

function historySearchWhereSql(alias = "") {
  const column = (name) => alias ? `${alias}.${name}` : name;
  return `LOWER(
    COALESCE(${column("title")}, '') || ' ' ||
    COALESCE(${column("source")}, '') || ' ' ||
    COALESCE(${column("imdb_id")}, '') || ' ' ||
    COALESCE(${column("tmdb_id")}, '') || ' ' ||
    COALESCE(${column("tvdb_id")}, '') || ' ' ||
    COALESCE(${column("sync_dispatch_telemetry")}, '')
  ) LIKE @search`;
}

export async function queryWatchHistory({ search = "", mediaType = "", limit = 50, offset = 0, dedupe = true } = {}) {
  const safeLimit = Math.min(Number(limit) || 50, MAX_HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const normalizedMediaType = ["movie", "episode", "tv"].includes(String(mediaType || "").toLowerCase()) ? String(mediaType).toLowerCase() : "";

  if (!dedupe) {
    const where = [trackedHistoryWhereSql("history_row")];
    const newerWhere = [trackedHistoryWhereSql("newer")];
    const params = {};

    if (normalizedMediaType) {
      const typeClause = normalizedMediaType === "episode" ? "media_type IN ('episode', 'tv')" : "media_type = @mediaType";
      where.push(typeClause.replaceAll("media_type", "history_row.media_type"));
      newerWhere.push(typeClause.replaceAll("media_type", "newer.media_type"));
      params.mediaType = normalizedMediaType;
    }

    const searchText = cleanString(search).toLowerCase();
    if (searchText) {
      where.push(historySearchWhereSql("history_row"));
      newerWhere.push(historySearchWhereSql("newer"));
      params.search = `%${searchText}%`;
    }

    const historyRows = db.prepare(`
      SELECT history_row.*
      FROM watch_history AS history_row
      WHERE ${where.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1
          FROM watch_history AS newer
          WHERE newer.history_day = history_row.history_day
            AND newer.history_daily_key = history_row.history_daily_key
            AND ${newerWhere.join(" AND ")}
            AND (
              COALESCE(newer.watched_at, '') > COALESCE(history_row.watched_at, '')
              OR (
                COALESCE(newer.watched_at, '') = COALESCE(history_row.watched_at, '')
                AND COALESCE(newer.updated_at, 0) > COALESCE(history_row.updated_at, 0)
              )
              OR (
                COALESCE(newer.watched_at, '') = COALESCE(history_row.watched_at, '')
                AND COALESCE(newer.updated_at, 0) = COALESCE(history_row.updated_at, 0)
                AND newer.rowid < history_row.rowid
              )
            )
        )
      ORDER BY history_row.watched_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: safeLimit, offset: safeOffset }).map(rowToWatch);
    return enrichHistoryRowsWithShowArtwork(historyRows);
  }

  const rows = await loadHistoryRows({ limit: MAX_HISTORY_LIMIT, offset: 0 });
  const filtered = rows.filter((row) => {
    if (!isPlektTrackedWatchRow(row)) return false;
    if (normalizedMediaType === "episode" && !["episode", "tv"].includes(row.media_type)) return false;
    if (normalizedMediaType && normalizedMediaType !== "episode" && row.media_type !== normalizedMediaType) return false;
    return matchesSearch(row, cleanString(search));
  });
  const processed = dedupe ? dedupeHistory(filtered) : filtered;
  return enrichHistoryRowsWithShowArtwork(processed.slice(safeOffset, safeOffset + safeLimit));
}

// The preview leaves out sync_dispatch_telemetry and watch_provenance: they
// were over half its bytes, and the readers that need them (the movie detail
// Info panel, the Tools health check) load the full record instead.
function compactHistoryPreviewRow(row = {}) {
  return {
    id: row.id,
    title: row.title,
    media_type: row.media_type,
    watched_at: row.watched_at,
    source: row.source,
    season: row.season,
    episode: row.episode,
    poster_url: row.poster_url,
    sync_action: row.sync_action,
    watch_count: Array.isArray(row.playHistory) && row.playHistory.length ? row.playHistory.length : 1,
    sources: dedupeHistorySources([
      ...(Array.isArray(row.sources) ? row.sources : []),
      row.source,
    ]),
    media_key: row.media_key,
    show_title: row.show_title,
    episode_title: row.episode_title,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    show_poster_url: row.show_poster_url || null,
  };
}

export async function queryWatchHistoryPreview({ limit = 120 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 300);
  // The preview builds its own lightweight show index from the history rows
  // below. Calling getCachedShows() here rebuilt the entire TV library even
  // though the result was never consumed, making the dashboard's first
  // /api/history request block the event loop behind a full show projection.
  const all = await getCachedHistory();
  // Regrouping every episode is the whole cost of this endpoint (~1 s on a real
  // library), and its inputs are fixed for a data generation, so reuse the
  // result until the version moves.
  const previewVersion = getDataVersion();
  if (historyPreviewCache.version === previewVersion && historyPreviewCache.rows.has(safeLimit)) {
    return withSeasonPosterArtwork(historyPreviewCache.rows.get(safeLimit));
  }
  // The build yields part-way, so share one build between concurrent callers
  // (the background warm-up and a dashboard request) instead of running two.
  const buildKey = `${previewVersion}|${safeLimit}`;
  let pending = historyPreviewBuilds.get(buildKey);
  if (!pending) {
    pending = buildHistoryPreview(all, safeLimit);
    historyPreviewBuilds.set(buildKey, pending);
  }
  try {
    const combined = await pending;
    // A write can land while the build is yielding: still answer this request
    // from the generation it started on, but never cache that under a newer one.
    if (getDataVersion() === previewVersion) {
      if (historyPreviewCache.version !== previewVersion) historyPreviewCache = { version: previewVersion, rows: new Map() };
      historyPreviewCache.rows.set(safeLimit, combined);
    }
    return withSeasonPosterArtwork(combined);
  } finally {
    if (historyPreviewBuilds.get(buildKey) === pending) historyPreviewBuilds.delete(buildKey);
  }
}

async function buildHistoryPreview(all, safeLimit) {
  // Same-title series must be enriched from the provider-aware episode group,
  // not a title map whose last entry wins. The resulting show_* fields let
  // dashboard history links use the same unambiguous route as the TV Shows
  // library cards.
  const showByEpisodeId = new Map();
  const showByAliasCoordinate = new Map();
  const previewShowRows = all.filter((row) => row.media_type === "episode" && isPlektTrackedWatchRow(row));
  for (const group of await groupShowRowsYielding(dedupeHistory(previewShowRows))) {
    const hasProviderIdentity = Boolean(group.tvdb_id || group.tmdb_id || group.imdb_id);
    for (const episode of group.episodes || []) {
      if (episode.id && hasProviderIdentity) showByEpisodeId.set(String(episode.id), group);
      if (episode.season == null || episode.episode == null) continue;
      if (!hasProviderIdentity) continue;
      const aliasKey = `${rematchTitleAliasKey(group.title)}|${episode.season}|${episode.episode}`;
      const existing = showByAliasCoordinate.get(aliasKey);
      showByAliasCoordinate.set(aliasKey, existing === undefined ? group : existing === group ? group : null);
    }
  }
  const tvRows = all.filter((row) => row.media_type === "episode" && isPlektTrackedWatchRow(row)).slice(0, HISTORY_PREVIEW_SCAN_LIMIT);
  const movieRows = all.filter((row) => row.media_type === "movie" && isPlektTrackedWatchRow(row)).slice(0, HISTORY_PREVIEW_SCAN_LIMIT);

  const tvDeduped = dedupeHistory(tvRows).slice(0, safeLimit).map((row) => {
    const compact = compactHistoryPreviewRow(row);
    const directShow = showByEpisodeId.get(String(row.id));
    const aliasKey = row.season == null || row.episode == null
      ? ""
      : `${rematchTitleAliasKey(row.show_title || row.title)}|${row.season}|${row.episode}`;
    const show = directShow || (aliasKey ? showByAliasCoordinate.get(aliasKey) : null);
    if (!show) return compact;
    return {
      ...compact,
      // Sparse episode rows can reuse series artwork without changing their
      // watch identity. Keep explicit show ids separate because an episode's
      // tmdb_id/tvdb_id may identify the episode rather than the series.
      poster_url: compact.poster_url || show.poster_url || null,
      show_poster_url: show.show_poster_url || null,
      show_imdb_id: show.imdb_id || null,
      show_tmdb_id: show.tmdb_id || null,
      show_tvdb_id: show.tvdb_id || null,
    };
  });
  const movieDeduped = dedupeHistory(movieRows).slice(0, safeLimit).map((row) => {
    const compact = compactHistoryPreviewRow(row);
    const canonicalPoster = getCanonicalPosterUrl({
      media_type: "movie",
      title: row.title,
      tmdb_id: row.tmdb_id,
      imdb_id: row.imdb_id,
    });
    return {
      ...compact,
      poster_url: compact.poster_url || canonicalPoster || null,
    };
  });

  const combined = [...tvDeduped, ...movieDeduped];
  combined.sort((a, b) => b.watched_at.localeCompare(a.watched_at));
  return combined;
}

function withSeasonPosterArtwork(rows = []) {
  const seasonPostersByShow = new Map();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (row?.media_type !== "episode" || row.season == null) return row;
    const identity = {
      media_type: "tv",
      title: row.show_title || showTitleFrom(row.title),
      tmdb_id: row.show_tmdb_id || "",
      tvdb_id: row.show_tvdb_id || "",
      imdb_id: row.show_imdb_id || "",
    };
    if (!identity.tmdb_id && !identity.tvdb_id) return row;
    const identityKey = `${identity.tmdb_id}|${identity.tvdb_id}|${identity.imdb_id}`;
    let seasonPosters = seasonPostersByShow.get(identityKey);
    if (!seasonPosters) {
      seasonPosters = getCanonicalSeasonPosterUrls(identity);
      seasonPostersByShow.set(identityKey, seasonPosters);
    }
    const poster = seasonPosters.get(Number(row.season));
    return poster ? { ...row, season_poster_url: poster } : row;
  });
}

function dispatchStatusFromTelemetry(value = "") {
  const text = String(value || "");
  if (text.includes("Force Sync resolved status to")) return "success";
  const line = text.split(/\r?\n/).find((item) => item.toLowerCase().startsWith("dispatch status:"));
  return line ? line.slice("dispatch status:".length).trim().toLowerCase() : "";
}

function telemetryLineValue(value = "", label = "") {
  const prefix = `${label}:`;
  const line = String(value || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function telemetryHasTargetStatus(value = "") {
  return String(value || "")
    .split(/\r?\n/)
    .some((line) => /^(plex|emby|jellyfin)\s+(?:progress\s+)?status:/i.test(line.trim()));
}

function isLegacyInitialSyncPlaceholder(row = {}) {
  const telemetry = row.sync_dispatch_telemetry || "";
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  return origin.endsWith("_initial_sync") && !telemetryHasTargetStatus(telemetry) && details.includes("awaiting outbound sync telemetry");
}

// Returns true when every non-successful target says "No matching item found" â€” meaning
// the content simply isn't in those libraries, not a fixable sync error.
function allNonSuccessTargetsNotFound(telemetry) {
  const lines = String(telemetry || "").split(/\r?\n/);
  const targetLines = lines.filter((l) => /^(plex|emby|jellyfin)\s+(?:progress\s+)?status:/i.test(l.trim()));
  if (!targetLines.length) return false;
  const nonSuccessLines = targetLines.filter((l) => !l.toLowerCase().includes("success"));
  if (!nonSuccessLines.length) return false;
  return nonSuccessLines.every((l) => l.toLowerCase().includes("no matching item found"));
}

export async function querySyncJobs({ limit = 100, offset = 0, status = "outstanding", fresh = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = await loadHistoryRows({
    limit: Math.min(Math.max(safeLimit * 5, safeLimit), MAX_HISTORY_LIMIT),
    offset: safeOffset,
    fresh,
  });

  const filtered = rows.filter((row) => {
    const dispatchStatus = dispatchStatusFromTelemetry(row.sync_dispatch_telemetry);
    if (status === "all") return true;
    if (status === "success") return dispatchStatus === "success";
    if (isLegacyInitialSyncPlaceholder(row)) return false;
    if (allNonSuccessTargetsNotFound(row.sync_dispatch_telemetry)) return false;
    if (dispatchStatus === "skipped") {
      const telemetry = row.sync_dispatch_telemetry || "";
      const hasTargetStatus = telemetryHasTargetStatus(telemetry);
      const isLoopOrImport = telemetry.includes("Echo loop caught") || telemetry.includes("Historical import");
      if (hasTargetStatus && !isLoopOrImport) return true;
      return false;
    }
    return dispatchStatus !== "success";
  });

  return filtered.slice(0, safeLimit);
}

export async function getWatchStats() {
  const version = getDataVersion();
  if (statsCache.version === version && statsCache.stats) return statsCache.stats;
  const statsRebuildStartedAt = performance.now();

  // Suppress same-event echoes consistently with the history views.
  // getCachedHistory is intentionally uncapped: the TV Shows library already
  // needs the complete identity context, and reusing it here preserves the
  // exact JS grouping/echo semantics instead of reimplementing them in SQL.
  const rows = await enrichHistoryRowsWithShowArtwork(filterSameEventDuplicateRows(
    (await getCachedHistory()).filter(isPlektTrackedWatchRow),
  ));
  const statsMovieKeys = buildStatsMovieKeys(rows);
  const statsShowKeys = showGroupKeys(rows.filter((row) => row.media_type === "episode"));
  const movieKeys = new Set();
  let episodes = 0;
  const bySource = new Map();
  const byShow = new Map();
  const byMonth = new Map();
  const byYear = new Map();
  const statsMonthPeriods = new Map();
  const allPeriod = createStatsPeriod("all", "All time");

  for (const sourceRow of rows) {
    const row = sourceRow.media_type === "movie"
      ? { ...sourceRow, _statsMovieKey: statsMovieKeys.get(sourceRow) }
      : { ...sourceRow, _statsShowKey: statsShowKeys.get(sourceRow) };
    const source = normalizePlatformSource(row.source);
    bySource.set(source, (bySource.get(source) || 0) + 1);
    const month = String(row.watched_at || "").slice(0, 7) || "unknown";
    const year = month.slice(0, 4) || "unknown";
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    addRowToStatsPeriod(allPeriod, row);
    if (!byYear.has(year)) byYear.set(year, createStatsPeriod(year, year));
    addRowToStatsPeriod(byYear.get(year), row);
    if (row.media_type === "movie") {
      movieKeys.add(row.imdb_id || row.tmdb_id || row.tvdb_id || row.title);
    } else if (row.media_type === "episode") {
      episodes += 1;
      const show = statsShowKey(row);
      byShow.set(show, { title: row.show_title || showTitleFrom(row.title), count: (byShow.get(show)?.count || 0) + 1 });
    }
    const monthPeriod = statsMonthPeriods.get(month) || createStatsPeriod(month, month);
    addRowToStatsPeriod(monthPeriod, row);
    statsMonthPeriods.set(month, monthPeriod);
  }

  const sourceBreakdown = [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
  const monthlyActivity = [...byMonth.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month));
  const topShows = [...byShow.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5);
  const yearlyReports = [...byYear.values()].map(finalizeStatsPeriod).sort((a, b) => b.period.localeCompare(a.period));
  const monthlyReports = [...statsMonthPeriods.values()].map(finalizeStatsPeriod).sort((a, b) => b.period.localeCompare(a.period));

  const stats = {
    total: rows.length,
    totalWatches: rows.length,
    movies: movieKeys.size,
    uniqueMoviesLogged: movieKeys.size,
    episodes,
    totalTvEpisodesTracked: episodes,
    topSource: sourceBreakdown[0]?.source || "none",
    topSourceCount: sourceBreakdown[0]?.count || 0,
    dbSizeBytes: 0,
    firstWatch: rows.at(-1)?.watched_at || null,
    lastWatch: rows[0]?.watched_at || null,
    sourceBreakdown,
    topShows,
    monthlyActivity,
    reports: {
      all: finalizeStatsPeriod(allPeriod),
      years: yearlyReports,
      months: monthlyReports,
    },
  };
  recordCacheRebuild("stats", {
    version,
    trigger: dataVersionTrigger(version),
    durationMs: performance.now() - statsRebuildStartedAt,
    items: stats?.reports?.months?.length ?? null,
  });
  statsCache = { version, stats };
  return stats;
}

export async function getWatchRecordByIdLight(id) {
  const row = selectByIdStmt.get(String(id)) || selectByMediaKeyStmt.all(String(id))[0];
  return rowToWatch(row);
}

const updatePosterStmt = db.prepare("UPDATE watch_history SET poster_url = ?, updated_at = ? WHERE id = ?");
const updateBackdropStmt = db.prepare("UPDATE watch_history SET backdrop_url = ?, updated_at = ? WHERE id = ?");
const clearArtworkStmt = db.prepare("UPDATE watch_history SET poster_url = NULL, logo_url = NULL, backdrop_url = NULL, updated_at = ? WHERE id = ?");

// Fix Match rematches a record to a new TMDB/TVDB id but leaves any previously
// stored poster/backdrop URL in place. /api/poster serves a row's stored URL
// directly when it already points at cached storage, so without clearing it
// here the old show/movie's artwork would keep being served forever instead
// of being re-resolved against the new match.
export async function clearWatchArtworkUrls(id) {
  if (!id) return false;
  const oldRow = selectByIdStmt.get(String(id));
  clearArtworkStmt.run(Date.now(), String(id));
  await invalidateAfterRowMetaWrite(id, oldRow, "artwork");
  return true;
}

// A movie can have several watch-history rows for the same media key. A
// rematch changes the identity used by the library query, so leaving artwork
// on a sibling row lets the old poster win when the library chooses its
// representative row.
export async function clearRelatedWatchArtworkUrls(id) {
  if (!id) return false;
  const rows = relatedPosterRows(id);
  if (!rows.length) return false;
  const now = Date.now();
  transaction(() => {
    for (const row of rows) clearArtworkStmt.run(now, String(row.id));
  });
  await invalidateHistoryDerivedCaches("clearRelatedWatchArtworkUrls");
  return true;
}

export async function updateWatchPosterUrl(id, posterUrl, { invalidate = true } = {}) {
  const cleanUrl = cleanString(posterUrl);
  if (!id || !cleanUrl) return false;
  const row = selectByIdStmt.get(String(id));
  if (!row) return false;
  if ((row.poster_url || "") === cleanUrl) return false;
  updatePosterStmt.run(cleanUrl, Date.now(), String(id));
  // Automatic poster hydration is a cache warm-up, not a watch-history
  // mutation. Let callers that make an intentional artwork change keep the
  // normal derived-cache invalidation, while background poster lookups can
  // persist their result without causing the live-update stream to reload
  // every open library view once per poster.
  if (invalidate) await invalidateAfterRowMetaWrite(id, row, "artwork");
  return true;
}

// Returns the sibling watch records that should share a custom poster with `id`:
// every other play of the same movie, or every episode of the same show. Each
// entry carries its `id` (for stamping `poster_url`) and `media_key` (which
// /api/poster reads from the poster cache before falling back to `poster_url`).
export function relatedPosterRows(id) {
  const existing = selectByIdStmt.get(String(id));
  if (!existing) return [];
  let rows;
  if (existing.media_type === "episode") {
    const showLower = existing.show_title_lower || showTitleFrom(existing.title || "").toLowerCase();
    rows = showLower ? selectEpisodesByShowLowerStmt.all(showLower) : [];
    if (!rows.length) {
      const showKey = canonicalTitleKey(existing.show_title || showTitleFrom(existing.title));
      rows = selectAllEpisodesStmt.all().filter((row) => canonicalTitleKey(row.show_title || showTitleFrom(row.title)) === showKey);
    }
  } else {
    rows = existing.media_key ? selectByMediaKeyStmt.all(existing.media_key) : [existing];
  }
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    result.push({ id: row.id, media_key: row.media_key || mediaKeyFor(row) });
  }
  return result;
}

// Bulk-stamp poster URLs (caller invalidates derived caches once afterwards).
export async function setWatchPosterUrls(updates = []) {
  let changed = 0;
  transaction(() => {
    for (const { id, posterUrl } of updates) {
      const url = cleanString(posterUrl);
      if (!id || !url) continue;
      updatePosterStmt.run(url, Date.now(), String(id));
      changed += 1;
    }
  });
  return changed;
}

export async function setWatchBackdropUrl(id, backdropUrl) {
  const url = cleanString(backdropUrl);
  if (!id || !url) return false;
  const oldRow = selectByIdStmt.get(String(id));
  updateBackdropStmt.run(url, Date.now(), String(id));
  await invalidateAfterRowMetaWrite(id, oldRow, "artwork");
  return true;
}

export async function listLibraryItemsForRefresh() {
  const movieMap = new Map();
  for (const row of (await getCachedMovies()).filter(isPlektTrackedWatchRow)) {
    const key = row.tmdb_id ? `tmdb:${row.tmdb_id}` : `title:${canonicalTitleKey(row.title)}`;
    let group = movieMap.get(key);
    if (!group) { group = { mediaType: "movie", tmdbId: row.tmdb_id || "", title: row.title, records: [] }; movieMap.set(key, group); }
    if (row.id) group.records.push({ id: row.id, poster: row.poster_url || "" });
    if (!group.tmdbId && row.tmdb_id) group.tmdbId = row.tmdb_id;
  }

  const showMap = new Map();
  for (const row of (await getCachedHistory()).filter((r) => r.media_type === "episode" && isPlektTrackedWatchRow(r))) {
    const title = showTitleFrom(row.title);
    const key = canonicalTitleKey(title) || title.toLowerCase();
    let group = showMap.get(key);
    if (!group) { group = { mediaType: "tv", tmdbId: cachedShowTmdbId(row.tmdb_id), title, records: [], _repAt: "" }; showMap.set(key, group); }
    if (row.id) group.records.push({ id: row.id, poster: row.poster_url || "" });
    if ((row.watched_at || "") >= group._repAt) {
      group._repAt = row.watched_at || "";
      group.tmdbId = cachedShowTmdbId(group.tmdbId, row.tmdb_id);
      group.title = title;
    }
  }

  return [
    ...movieMap.values(),
    ...[...showMap.values()].map(({ _repAt, ...rest }) => rest),
  ];
}

export async function getWatchRecordById(id) {
  let dbRow = selectByIdStmt.get(String(id));
  if (!dbRow && id) {
    const byKey = selectByMediaKeyStmt.all(String(id));
    if (byKey.length) dbRow = byKey[0];
  }
  const row = rowToWatch(dbRow);
  if (!row) return null;
  if (row.media_key) {
    const allRows = await getCachedHistory();
    const matches = filterSameEventDuplicateRows(allRows.filter((r) => r.media_key === row.media_key && isPlektTrackedWatchRow(r)));
    row.playHistory = matches.map(playHistoryEntry).filter((entry) => entry.watched_at);
    row.playHistory.sort((a, b) => a.watched_at.localeCompare(b.watched_at));
  } else {
    row.playHistory = [playHistoryEntry(row)].filter((entry) => entry.watched_at);
  }
  return row;
}

export async function getWatchRecordByMediaKey(mediaKey, minWatchedAt = null) {
  const rows = selectByMediaKeyStmt.all(mediaKey);
  if (!rows.length) return null;
  const sorted = rows.sort((a, b) => (b.watched_at || "").localeCompare(a.watched_at || ""));
  const recent = sorted[0];
  if (minWatchedAt && recent.watched_at < minWatchedAt) return null;
  return rowToWatch(recent);
}

export async function updateWatchRecord(id, fields = {}, { preserveDispatchState = false, auditSource = "manual" } = {}) {
  assertRestoreWriteAllowed(auditSource);
  if (!id) return { ok: false, error: "id is required" };
  const existing = selectByIdStmt.get(String(id)) || selectByMediaKeyStmt.all(String(id))[0];
  if (!existing) return { ok: false, error: "Watch record not found" };
  const targetId = existing.id;

  // Queue old show title
  queueProgressUpdateForRecord(existing);

  const sets = [];
  const params = [];
  let normalizedWatchedAt = "";
  if (fields.watched_at != null) {
    normalizedWatchedAt = normalizeWatchedAt(fields.watched_at);
    if (!normalizedWatchedAt) return { ok: false, error: "Invalid watched_at value" };
    sets.push("watched_at = ?"); params.push(normalizedWatchedAt);
  }
  if (fields.poster_url != null) { sets.push("poster_url = ?"); params.push(String(fields.poster_url).trim()); }
  if (fields.logo_url != null) { sets.push("logo_url = ?"); params.push(String(fields.logo_url).trim()); }
  if (fields.backdrop_url != null) { sets.push("backdrop_url = ?"); params.push(String(fields.backdrop_url).trim()); }
  if (fields.imdb_id != null) { sets.push("imdb_id = ?"); params.push(String(fields.imdb_id).trim()); }
  if (fields.tmdb_id != null) { sets.push("tmdb_id = ?"); params.push(String(fields.tmdb_id).trim()); }
  if (fields.tvdb_id != null) { sets.push("tvdb_id = ?"); params.push(String(fields.tvdb_id).trim()); }
  let providerOverridesChanged = false;
  if (fields.provider_overrides != null || fields.providerOverrides != null) {
    const nextOverrides = normalizeProviderOverrides(fields.provider_overrides || fields.providerOverrides);
    const currentProvenance = normalizeWatchProvenance(existing.watch_provenance) || {};
    const nextProvenance = normalizeWatchProvenance({
      ...currentProvenance,
      provider_overrides: nextOverrides || undefined,
    });
    sets.push("watch_provenance = ?");
    params.push(toJson(nextProvenance));
    providerOverridesChanged = true;
  }
  const identityChanged = fields.imdb_id != null || fields.tmdb_id != null || fields.tvdb_id != null;
  if (identityChanged || providerOverridesChanged) {
    sets.push("sync_match_ignored_at = NULL");
  }
  if ((identityChanged || providerOverridesChanged) && !preserveDispatchState) {
    sets.push("sync_dispatch_telemetry = ?", "sync_retry_count = ?", "sync_next_retry_at = ?");
    params.push("Identity updated via Fix Match. Pending outbound sync.", 0, 0);
  }
  if (fields.title != null) {
    const derivedTitle = persistedWatchDerivedFields({
      title: String(fields.title).trim(),
      media_type: existing.media_type,
      season: existing.season,
      episode: existing.episode,
    });
    const title = derivedTitle.title;
    if (title) { sets.push("title = ?", "title_lower = ?"); params.push(title, title.toLowerCase()); }
    // Queue new show title
    if (existing.media_type === "episode") {
      queueShowProgressUpdate(showTitleFrom(title));
    }
  }
  if (fields.youtube_url != null) { sets.push("youtube_url = ?"); params.push(String(fields.youtube_url).trim()); }
  if (!sets.length) return { ok: false, error: "No valid fields to update" };

  // Fix Match corrects a row's identity in place, and that must also move it
  // onto the media_key its new identity computes to - otherwise it stays
  // grouped under its old (often title-only) key forever, permanently split
  // from any other row for the same item, with the edit-date list, playstate,
  // and history-audit trail all still keyed by the stale identity.
  const oldMediaKey = existing.media_key;
  let newMediaKey = oldMediaKey;
  if (identityChanged) {
    newMediaKey = mediaKeyFor({
      ...existing,
      imdb_id: fields.imdb_id != null ? String(fields.imdb_id).trim() : existing.imdb_id,
      tmdb_id: fields.tmdb_id != null ? String(fields.tmdb_id).trim() : existing.tmdb_id,
      tvdb_id: fields.tvdb_id != null ? String(fields.tvdb_id).trim() : existing.tvdb_id,
    });
    if (newMediaKey !== oldMediaKey) { sets.push("media_key = ?"); params.push(newMediaKey); }
  }

  const updatedAt = Date.now();
  sets.push("updated_at = ?"); params.push(updatedAt);
  params.push(String(targetId));
  db.prepare(`UPDATE watch_history SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  recordWatchAuditEvent({
    eventType: "history_record_updated",
    timestamp: updatedAt,
    action: existing.sync_action || "watched",
    watchRecordId: targetId,
    mediaKey: existing.media_key,
    mediaType: existing.media_type,
    title: fields.title != null ? String(fields.title).trim() : existing.title,
    showTitle: existing.show_title,
    source: auditSource,
    ids: {
      imdb: existing.imdb_id,
      tmdb: fields.tmdb_id != null ? String(fields.tmdb_id).trim() : existing.tmdb_id,
      tvdb: fields.tvdb_id != null ? String(fields.tvdb_id).trim() : existing.tvdb_id,
    },
    season: existing.season,
    episode: existing.episode,
    status: "updated",
    details: preserveDispatchState
      ? "Provider IDs enriched from TMDB metadata without resetting outbound dispatch state."
      : "Stored watch history record updated in Plekt.",
    payload: { fields, previousRecord: existing, updatedAt, preserveDispatchState },
  });
  if (normalizedWatchedAt && existing.media_key) {
    const relatedRows = relatedTrackedWatchRowsForDateEdit(existing);
    transaction(() => {
      for (const row of relatedRows) {
        updateWatchRowWatchedAtStmt.run(normalizedWatchedAt, updatedAt, row.id);
      }
    });
    for (const mediaKey of new Set(relatedRows.map((row) => row.media_key).filter(Boolean))) {
      updatePlaystateWatchedAtStmt.run(normalizedWatchedAt, updatedAt, mediaKey);
    }
  }
  if (normalizedWatchedAt && existing.media_key) {
    updatePlaystateWatchedAtStmt.run(normalizedWatchedAt, updatedAt, existing.media_key);
  }

  // The row just moved to newMediaKey - roll the old key's playstate back to
  // whatever else still lives there (or drop it if nothing does), and fold
  // this row into whatever the new key's playstate already reflects, the same
  // reconciliation deleteWatchDate does when a row leaves a media_key. Both
  // writes below share the single `updatedAt` captured above rather than
  // taking fresh Date.now() calls: getPlaystateForMediaSync's title-based
  // fallback can surface either key's playstate row for a shared title, and
  // choosing between them by millisecond-resolution updated_at would make the
  // outcome depend on how much work happens between the two writes here.
  if (identityChanged && newMediaKey !== oldMediaKey) {
    if (oldMediaKey) {
      const oldRemaining = selectByMediaKeyStmt.all(oldMediaKey).filter(isPlektTrackedWatchRow);
      if (oldRemaining.length) {
        const oldLatest = oldRemaining.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
        updatePlaystateWatchedAtStmt.run(oldLatest.watched_at, updatedAt, oldMediaKey);
      } else {
        deletePlaystateByKeyStmt.run(oldMediaKey);
      }
    }
    const newSiblings = selectByMediaKeyStmt.all(newMediaKey).filter(isPlektTrackedWatchRow);
    if (newSiblings.length) {
      const newLatest = newSiblings.reduce((best, row) => (String(row.watched_at || "") > String(best.watched_at || "") ? row : best));
      const existingNewPlaystate = selectPlaystateStmt.get(newMediaKey);
      const sources = new Set(parseJson(existingNewPlaystate?.sources, []) || []);
      if (newLatest.source) sources.add(newLatest.source);
      upsertPlaystateStmt.run({
        media_key: newMediaKey,
        title: newLatest.title,
        title_lower: (newLatest.title || "").toLowerCase(),
        media_type: newLatest.media_type,
        state: "watched",
        watched_at: newLatest.watched_at,
        last_source: newLatest.source || existingNewPlaystate?.last_source || "manual",
        sources: toJson([...sources].sort()),
        imdb_id: newLatest.imdb_id || existingNewPlaystate?.imdb_id || null,
        tmdb_id: newLatest.tmdb_id || existingNewPlaystate?.tmdb_id || null,
        tvdb_id: newLatest.tvdb_id || existingNewPlaystate?.tvdb_id || null,
        season: newLatest.season,
        episode: newLatest.episode,
        poster_url: newLatest.poster_url || existingNewPlaystate?.poster_url || null,
        updated_at: updatedAt,
      });
    }
  }

  await invalidateHistoryDerivedCaches("updateWatchRecord");
  return { ok: true };
}

export async function dismissSyncMatchRecord(id) {
  assertRestoreWriteAllowed("manual");
  const requestedId = String(id || "").trim();
  if (!requestedId) return { ok: false, error: "id is required" };
  const existing = selectByIdStmt.get(requestedId);
  if (!existing) return { ok: false, error: "Watch record not found" };

  const ignoredAt = Date.now();
  db.prepare("UPDATE watch_history SET sync_match_ignored_at = ?, updated_at = ? WHERE id = ?")
    .run(ignoredAt, ignoredAt, existing.id);
  await invalidateHistoryDerivedCaches("dismissSyncMatchRecord");
  return { ok: true, id: String(existing.id), ignoredAt };
}

// Update a set of existing watch rows in one transaction. This is deliberately
// separate from updateWatchRecord: the single-row editor keeps same-day episode
// echo rows synchronized, while a season/show edit must stamp exactly the rows
// the caller selected. In particular, a release-date season edit can assign a
// different date to every episode without rewriting another genuine watch or
// creating a new history row.
export async function updateWatchDates(updates = []) {
  assertRestoreWriteAllowed("manual");
  if (!Array.isArray(updates) || !updates.length) {
    return { ok: false, error: "updates is required" };
  }
  if (updates.length > 500) {
    return { ok: false, error: "Too many watch dates in one update" };
  }

  const resolved = [];
  const seenIds = new Set();
  for (const update of updates) {
    const requestedId = String(update?.id || "").trim();
    const requestedMediaKey = String(update?.media_key || "").trim();
    const existing = requestedId
      ? selectByIdStmt.get(requestedId)
      : requestedMediaKey
        ? selectByMediaKeyStmt.all(requestedMediaKey)
          .filter(isPlektTrackedWatchRow)
          .sort((a, b) => String(b.watched_at || "").localeCompare(String(a.watched_at || "")))[0]
        : null;
    if (!existing) return { ok: false, error: `Watch record not found${requestedId ? `: ${requestedId}` : ""}` };
    if (!isPlektTrackedWatchRow(existing)) return { ok: false, error: "Only watched records can be date-edited" };
    if (seenIds.has(existing.id)) return { ok: false, error: `Duplicate watch record: ${existing.id}` };

    const date = new Date(update?.watched_at);
    if (!update?.watched_at || Number.isNaN(date.getTime())) {
      return { ok: false, error: `Invalid watched_at value for ${existing.id}` };
    }

    seenIds.add(existing.id);
    resolved.push({ existing, watchedAt: date.toISOString() });
  }

  const updatedAt = Date.now();
  const mediaKeys = new Set(resolved.map(({ existing }) => existing.media_key).filter(Boolean));
  for (const { existing } of resolved) queueProgressUpdateForRecord(existing);

  transaction(() => {
    for (const { existing, watchedAt } of resolved) {
      updateWatchRowWatchedAtStmt.run(watchedAt, updatedAt, existing.id);
      recordWatchAuditEvent({
        eventType: "history_record_updated",
        timestamp: updatedAt,
        action: existing.sync_action || "watched",
        watchRecordId: existing.id,
        mediaKey: existing.media_key,
        mediaType: existing.media_type,
        title: existing.title,
        showTitle: existing.show_title,
        source: "manual",
        ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
        season: existing.season,
        episode: existing.episode,
        status: "updated",
        details: "Stored watch history date updated by a season/show date edit.",
        payload: { previousWatchedAt: existing.watched_at, watchedAt, operation: "bulk_watch_date_update" },
      });
    }

    // Keep the canonical playstate pointer at the latest remaining real watch
    // for each media key, even when the edit moves the representative row
    // earlier than an older or repeated viewing.
    for (const mediaKey of mediaKeys) {
      const remaining = selectByMediaKeyStmt.all(mediaKey).filter(isPlektTrackedWatchRow);
      const latest = remaining.reduce((best, row) => (
        String(row.watched_at || "") > String(best?.watched_at || "") ? row : best
      ), null);
      if (latest) updatePlaystateWatchedAtStmt.run(latest.watched_at, updatedAt, mediaKey);
    }
  });

  await invalidateHistoryDerivedCaches("updateWatchDates");
  return { ok: true, updated_ids: resolved.map(({ existing }) => existing.id) };
}

// Fix Match operates at show scope. Performing one update-watch request per
// episode is especially expensive over a deployed connection because each
// request also invalidates derived caches. Stamp every episode in one SQLite
// transaction, invalidate once, then rebuild remote-derived progress metadata
// after the response path has completed.
// Swaps the show-name segment of an episode title, keeping the SxxEyy
// coordinates and any episode-name suffix. Replacing everything ahead of the
// coordinates also drops a stale trailing year from the old name.
function retitledEpisode(existingTitle = "", newShowTitle = "", season = null, episode = null) {
  const text = cleanString(decodeBasicHtmlEntities(existingTitle));
  const coordinateMatch = text.match(/^(.*?)(\s+-\s+S\d{1,3}E\d{1,3}\b.*)$/i);
  if (coordinateMatch) return `${newShowTitle}${coordinateMatch[2]}`;
  if (season != null && episode != null) {
    return `${newShowTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  return newShowTitle;
}

// A provider can omit the country/year qualifier from an episode title even
// when the matched series carries it (for example, "The Assembly" vs
// "The Assembly (UK)"). When Fix Match is explicitly applied to the
// qualified series, title-only rows with the same episode coordinates are safe
// to absorb into that match; rows that already have provider ids remain scoped
// to their own identity cluster.
function rematchTitleAliasKey(value = "") {
  return canonicalShowTitleKey(String(value || "").replace(/\s*\([^)]*\)\s*$/, ""));
}

export async function rematchShowWatchRecords({ id = "", showTitle = "", tvdbId = "", newShowTitle = "", posterUrl = "" } = {}) {
  const cleanTvdbId = cleanString(tvdbId);
  if (!cleanTvdbId) return { ok: false, error: "tvdb_id is required" };

  const anchor = id ? selectByIdStmt.get(String(id)) : null;
  if (id && !anchor) return { ok: false, error: "Watch record not found" };
  if (anchor && anchor.media_type !== "episode") return { ok: false, error: "Watch record is not a TV episode" };

  const resolvedTitle = cleanString(anchor?.show_title || (anchor?.title ? showTitleFrom(anchor.title) : showTitle));
  if (!resolvedTitle) return { ok: false, error: "show_title is required" };

  // The show the user picked. Fix Match corrects which series these episodes
  // belong to, so the stored name has to follow the new match - otherwise a
  // mismatched or "Unknown Show" group keeps its old name and stays parked on
  // the old route even though the ids now point somewhere else.
  const cleanNewShowTitle = cleanString(newShowTitle);
  const renameTo =
    cleanNewShowTitle && canonicalTitleKey(cleanNewShowTitle) !== canonicalTitleKey(resolvedTitle)
      ? cleanNewShowTitle
      : "";

  // Not just an exact show_title_lower match, and not only as a fallback
  // when that finds nothing: this show's own episode rows can carry
  // different exact show_title text over time (a trailing "(YYYY)" present
  // on some inserts, absent on others - see the matching comment in
  // queryShowDetail), so an exact match alone can silently repair only a
  // subset of the show's real episodes while leaving the rest - including,
  // confusingly, rows that still look wrong afterward - on their old,
  // mismatched identity. Scan by the same normalized key every row is
  // grouped by everywhere else instead, so Fix Match always repairs every
  // episode of the show in one pass.
  const showKey = canonicalTitleKey(showTitleFrom(resolvedTitle));
  const allEpisodeRows = selectAllEpisodesStmt.all();
  const exactRows = allEpisodeRows.filter((row) => (
    canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey
  ));
  const targetCoordinates = new Set(exactRows.map((row) => `${row.season ?? ""}:${row.episode ?? ""}`));
  const selectedTitle = cleanNewShowTitle || resolvedTitle;
  const aliasRows = cleanNewShowTitle && rematchTitleAliasKey(resolvedTitle) === rematchTitleAliasKey(selectedTitle)
    ? allEpisodeRows.filter((row) => {
      if (exactRows.includes(row)) return false;
      if (cleanString(row.imdb_id) || cleanString(row.tmdb_id) || cleanString(row.tvdb_id)) return false;
      if (rematchTitleAliasKey(row.show_title || row.title) !== rematchTitleAliasKey(selectedTitle)) return false;
      return targetCoordinates.has(`${row.season ?? ""}:${row.episode ?? ""}`);
    })
    : [];
  const rows = [...exactRows, ...aliasRows];
  if (!rows.length) return { ok: false, error: "No episodes found for show" };

  // Selecting the already-current result is a valid Fix Match action. It is
  // especially important for Trakt not-found issues: the local identity may
  // already be correct, but the user still needs this action to continue to
  // the normal metadata warm-up and failed-entry retry flow. The transaction
  // below is idempotent and also repairs any stale title-only aliases.

  const oldTmdbIds = new Set(rows.map((row) => cleanString(row.tmdb_id)).filter(Boolean));
  // The progress cache can hold a resolved tmdb_id that was never written back
  // onto any row (e.g. resolved from an earlier ambiguous title search), so it
  // wouldn't be caught by oldTmdbIds above - drop it too or queryShowDetail's
  // cachedShowTmdbId() keeps serving it as the "cached" candidate.
  const cachedProgressTmdbId = cleanString(getCachedShowProgress(showKey)?.tmdb_id);
  if (cachedProgressTmdbId) oldTmdbIds.add(cachedProgressTmdbId);
  const mediaKeys = new Set(rows.map((row) => cleanString(row.media_key)).filter(Boolean));
  // A restore can leave a watched playstate row without a corresponding
  // watch-history row (for example, when the failed projection retained only
  // the target's identity). Include those rows in the match migration when
  // their title and episode coordinates belong to this show, otherwise Fix
  // Match repairs the history while the stale target identity remains behind.
  const orphanPlaystateRows = db.prepare("SELECT * FROM playstate WHERE media_type = 'episode'").all().filter((playstate) => {
    if (canonicalShowTitleKey(showTitleFrom(playstate.title || "")) !== showKey) return false;
    const titleCoordinates = episodeCoordinatesFromTitle(playstate.title || "");
    const season = playstate.season ?? titleCoordinates.season;
    const episode = playstate.episode ?? titleCoordinates.episode;
    return rows.some((row) => Number(row.season) === Number(season) && Number(row.episode) === Number(episode));
  });
  const updatedAt = Date.now();

  // Old media_key -> new media_key, collected while the rows are rewritten so the
  // playstate rows keyed by the old value can follow in the same transaction.
  const keyMigrations = new Map();

  transaction(() => {
    for (const row of rows) {
      rematchShowEpisodeStmt.run(cleanTvdbId, updatedAt, row.id);

      const renameAliasRow = aliasRows.includes(row) && cleanNewShowTitle && canonicalTitleKey(row.show_title || row.title) !== canonicalTitleKey(cleanNewShowTitle);
      const nextShowTitle = renameTo || (renameAliasRow ? cleanNewShowTitle : "");
      const nextTitle = nextShowTitle ? retitledEpisode(row.title, nextShowTitle, row.season, row.episode) : row.title;
      if (nextShowTitle) {
        updateShowTitleStmt.run(
          nextTitle,
          nextTitle.toLowerCase(),
          nextShowTitle,
          nextShowTitle.toLowerCase(),
          updatedAt,
          row.id,
        );
      }

      // The key encodes the identity that just changed, so it has to be rebuilt
      // from what the row now holds - otherwise it keeps pointing at the old
      // show and playstate lookups miss.
      const previousKey = cleanString(row.media_key);
      const nextKey = mediaKeyFor({
        media_type: "episode",
        season: row.season,
        episode: row.episode,
        tvdb_id: cleanTvdbId,
        title: nextTitle,
      });
      if (nextKey && nextKey !== previousKey) {
        updateWatchMediaKeyStmt.run(nextKey, updatedAt, row.id);
        if (previousKey) keyMigrations.set(previousKey, { nextKey, title: nextTitle });
      }
    }

    for (const playstate of orphanPlaystateRows) {
      const titleCoordinates = episodeCoordinatesFromTitle(playstate.title || "");
      const season = playstate.season ?? titleCoordinates.season;
      const episode = playstate.episode ?? titleCoordinates.episode;
      const previousKey = cleanString(playstate.media_key);
      const nextTitle = renameTo
        ? retitledEpisode(playstate.title, renameTo, season, episode)
        : playstate.title;
      const nextKey = mediaKeyFor({
        media_type: "episode",
        season,
        episode,
        tvdb_id: cleanTvdbId,
        title: nextTitle,
      });
      if (previousKey && nextKey && nextKey !== previousKey) {
        keyMigrations.set(previousKey, { nextKey, title: nextTitle });
      }
    }

    for (const [previousKey, { nextKey, title }] of keyMigrations) {
      // A playstate row may already sit at the destination when only some of the
      // episodes were mis-keyed. The row already at the correct key is the
      // authoritative one, so drop the stale source rather than collide with it.
      if (selectPlaystateKeyStmt.get(nextKey)) deletePlaystateByKeyStmt.run(previousKey);
      else movePlaystateKeyStmt.run(nextKey, cleanTvdbId, title, title.toLowerCase(), updatedAt, previousKey);
    }

    for (const mediaKey of new Set([...mediaKeys, ...keyMigrations.keys()])) deletePosterByMediaKeyStmt.run(mediaKey);
    for (const tmdbId of oldTmdbIds) deleteTmdbMetadataStmt.run(`tv_${tmdbId}`);
    deleteTvdbMetadataStmt.run(`series_${cleanTvdbId}`);
  });

  // Drop the stale cached progress entry (and its cached tmdb_id) synchronously
  // so a request for this show between now and the background refresh below
  // can't have the old show's id served back to it via queryShowDetail(). After
  // a rename both names have to be cleared: the old entry would otherwise leave
  // a ghost of the previous show behind.
  clearCachedShowProgress(resolvedTitle);
  if (renameTo) clearCachedShowProgress(renameTo);

  const refreshedShowTitle = renameTo || resolvedTitle;
  const selectedPosterUrl = cleanString(posterUrl);
  if (selectedPosterUrl) {
    saveCanonicalPoster({
      media_type: "tv",
      title: refreshedShowTitle,
      tvdb_id: cleanTvdbId,
    }, selectedPosterUrl, { source: "fix-match" });
  }
  queueShowProgressUpdate(refreshedShowTitle);
  // Fix Match clears the old provider ids and artwork synchronously. Queue the
  // newly selected series identity separately so the homepage's cache-only
  // cards can use the corrected show poster/details without requiring the user
  // to visit the show page first. The progress refresh below also asks for
  // metadata, but this explicit queue keeps artwork warm even when that cache
  // update is delayed or is interrupted by a restart.
  try {
    queueTmdbMetadataWarmup([{
      mediaType: "tv",
      title: refreshedShowTitle,
      ids: { tvdbId: cleanTvdbId },
    }], { reason: "fix-match" });
  } catch (error) {
    // Metadata is an enrichment side effect. A successful identity rematch
    // must not be rolled back because the optional warm-up queue is unavailable.
    console.warn(`[dataRepo] Fix Match metadata warm-up queue failed for ${refreshedShowTitle}: ${error?.message || error}`);
  }
  bumpDataVersion();
  await invalidateHistoryDerivedCaches("rematchShowWatchRecords");
  setImmediate(() => {
    flushShowProgressUpdates().catch((error) => {
      console.error("[dataRepo] Background show progress refresh failed after Fix Match", error);
    });
  });

  return {
    ok: true,
    updatedRows: rows.length,
    showTitle: renameTo || resolvedTitle,
    previousShowTitle: resolvedTitle,
    renamed: Boolean(renameTo || aliasRows.some((row) => cleanNewShowTitle && canonicalTitleKey(row.show_title || row.title) !== canonicalTitleKey(cleanNewShowTitle))),
    tvdbId: cleanTvdbId,
  };
}

// Trakt/TMDB can publish a continuation as a new series while TVDB keeps it
// under the original series and season numbering. Store that provider-only
// mapping on the affected local episode rows; the canonical TVDB show and its
// local coordinates must remain untouched for metadata and media-server sync.
export async function setTraktEpisodeMatch({
  id = "",
  showTitle = "",
  traktTmdbId = "",
  sourceSeason = null,
  sourceEpisode = null,
  targetSeason = 1,
  targetEpisode = null,
} = {}) {
  const cleanTmdbId = cleanString(traktTmdbId);
  if (!cleanTmdbId) return { ok: false, error: "trakt_tmdb_id is required" };
  const cleanSourceSeason = Number(sourceSeason);
  const cleanSourceEpisode = sourceEpisode == null || sourceEpisode === "" ? null : Number(sourceEpisode);
  const cleanTargetSeason = Number(targetSeason);
  const cleanTargetEpisode = targetEpisode == null || targetEpisode === "" ? null : Number(targetEpisode);
  if (!Number.isInteger(cleanSourceSeason) || cleanSourceSeason < 0) return { ok: false, error: "source_season is required" };
  if (cleanSourceEpisode != null && (!Number.isInteger(cleanSourceEpisode) || cleanSourceEpisode < 1)) return { ok: false, error: "source_episode is invalid" };
  if (!Number.isInteger(cleanTargetSeason) || cleanTargetSeason < 0) return { ok: false, error: "target_season is invalid" };
  if (cleanTargetEpisode != null && (!Number.isInteger(cleanTargetEpisode) || cleanTargetEpisode < 1)) return { ok: false, error: "target_episode is invalid" };

  const anchor = id ? selectByIdStmt.get(String(id)) : null;
  if (id && !anchor) return { ok: false, error: "Watch record not found" };
  if (anchor && anchor.media_type !== "episode") return { ok: false, error: "Watch record is not a TV episode" };
  const resolvedTitle = cleanString(anchor?.show_title || (anchor?.title ? showTitleFrom(anchor.title) : showTitle));
  if (!resolvedTitle) return { ok: false, error: "show_title is required" };

  const showKey = canonicalTitleKey(showTitleFrom(resolvedTitle));
  const rows = selectAllEpisodesStmt.all().filter((row) => (
    canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === showKey
    && Number(row.season) === cleanSourceSeason
    && (cleanSourceEpisode == null || Number(row.episode) === cleanSourceEpisode)
  ));
  if (!rows.length) return { ok: false, error: "No episodes found for show and season" };

  const updatedAt = Date.now();
  transaction(() => {
    for (const row of rows) {
      const current = normalizeWatchProvenance(row.watch_provenance) || buildWatchProvenance({ source: row.source });
      const overrides = current.provider_overrides || {};
      const trakt = {
        ...(overrides.trakt || {}),
        tmdb_id: cleanTmdbId,
        season: cleanTargetSeason,
        episode: cleanTargetEpisode == null ? Number(row.episode) : cleanTargetEpisode,
      };
      const next = normalizeWatchProvenance({
        ...current,
        provider_overrides: { ...overrides, trakt },
      });
      db.prepare("UPDATE watch_history SET watch_provenance = ?, updated_at = ?, sync_retry_count = 0, sync_next_retry_at = 0 WHERE id = ?")
        .run(toJson(next), updatedAt, row.id);
    }
  });

  bumpDataVersion();
  await invalidateHistoryDerivedCaches("setTraktEpisodeMatch");
  return {
    ok: true,
    updatedRows: rows.length,
    showTitle: resolvedTitle,
    traktTmdbId: cleanTmdbId,
    sourceSeason: cleanSourceSeason,
    targetSeason: cleanTargetSeason,
  };
}

// Remove only the provider-specific Trakt mapping after a background identity
// check has proved that Trakt now uses the canonical TVDB series and season
// numbering. Local/media-server identity fields are intentionally untouched.
export async function clearTraktProviderOverrides(rows = []) {
  assertRestoreWriteAllowed("scheduled_trakt_reconciliation");
  const ids = [...new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.id || "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: true, updatedRows: 0 };

  const updatedAt = Date.now();
  let updatedRows = 0;
  transaction(() => {
    for (const id of ids) {
      const existing = selectByIdStmt.get(id);
      const current = normalizeWatchProvenance(existing?.watch_provenance);
      if (!existing || !current?.provider_overrides?.trakt) continue;
      const { trakt: _removed, ...remainingOverrides } = current.provider_overrides;
      const nextProvenance = normalizeWatchProvenance({
        ...current,
        provider_overrides: Object.keys(remainingOverrides).length ? remainingOverrides : undefined,
      });
      db.prepare(`UPDATE watch_history
        SET watch_provenance = ?, sync_dispatch_telemetry = ?, sync_retry_count = 0,
            sync_next_retry_at = 0, updated_at = ?
        WHERE id = ?`).run(
        toJson(nextProvenance),
        "Trakt provider mapping reconciled. Pending outbound sync.",
        updatedAt,
        id,
      );
      recordWatchAuditEvent({
        eventType: "history_record_updated",
        timestamp: updatedAt,
        action: existing.sync_action || "watched",
        watchRecordId: existing.id,
        mediaKey: existing.media_key,
        mediaType: existing.media_type,
        title: existing.title,
        showTitle: existing.show_title,
        source: "scheduled_trakt_reconciliation",
        ids: { imdb: existing.imdb_id, tmdb: existing.tmdb_id, tvdb: existing.tvdb_id },
        season: existing.season,
        episode: existing.episode,
        status: "updated",
        details: "Trakt now agrees with the canonical TVDB series and local season numbering; queued outbound sync.",
        payload: { previousProviderOverrides: current.provider_overrides, updatedAt },
      });
      updatedRows += 1;
    }
  });

  if (updatedRows) {
    bumpDataVersion();
    await invalidateHistoryDerivedCaches("clearTraktProviderOverrides");
  }
  return { ok: true, updatedRows };
}

const updateShowTitleStmt = db.prepare("UPDATE watch_history SET title = ?, title_lower = ?, show_title = ?, show_title_lower = ?, updated_at = ? WHERE id = ?");

export async function mergeShows(sourceTitle, targetTitle) {
  if (!sourceTitle || !targetTitle) throw new Error("source_title and target_title are required");
  const sourceKey = canonicalTitleKey(sourceTitle);
  const targetKey = canonicalTitleKey(targetTitle);
  if (sourceKey === targetKey) throw new Error("source and target are the same show");

  // Queue updates for both shows
  queueShowProgressUpdate(sourceTitle);
  queueShowProgressUpdate(targetTitle);

  let docs = selectEpisodesByShowLowerStmt.all(sourceTitle.toLowerCase());
  if (!docs.length) {
    docs = selectAllEpisodesStmt.all().filter((row) => {
      const raw = row.show_title || row.title || "";
      return canonicalTitleKey(showTitleFrom(raw)) === sourceKey;
    });
    if (!docs.length) throw new Error("No episodes found for source show");
  }

  const escaped = sourceTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mergeId = crypto.randomUUID();
  const mergedAt = Date.now();
  const snapshot = docs.map((row) => ({
    id: row.id,
    title: row.title,
    title_lower: row.title_lower,
    show_title: row.show_title,
    show_title_lower: row.show_title_lower,
  }));
  transaction(() => {
    insertShowMergeStmt.run(mergeId, sourceTitle, targetTitle, toJson(snapshot), mergedAt);
    for (const row of docs) {
      const oldTitle = row.title || "";
      const newTitle = oldTitle.replace(new RegExp(`^${escaped}`, "i"), targetTitle);
      updateShowTitleStmt.run(newTitle, newTitle.toLowerCase(), targetTitle, targetTitle.toLowerCase(), Date.now(), row.id);
    }
  });
  await invalidateHistoryDerivedCaches("mergeShows");
  return { id: mergeId, merged: docs.length };
}

export function listShowMerges({ targetTitle = "" } = {}) {
  const targetKey = canonicalTitleKey(targetTitle);
  return listShowMergesStmt.all()
    .filter((row) => !targetKey || canonicalTitleKey(row.target_title) === targetKey)
    .map((row) => ({
      id: row.id,
      sourceTitle: row.source_title,
      targetTitle: row.target_title,
      mergedAt: Number(row.merged_at || 0),
      revertedAt: Number(row.reverted_at || 0),
      active: !row.reverted_at,
    }));
}

export async function unmergeShow(mergeId = "") {
  const merge = selectShowMergeStmt.get(String(mergeId || ""));
  if (!merge) throw new Error("Merge record not found");
  if (merge.reverted_at) throw new Error("Merge has already been undone");
  const rows = parseJson(merge.rows_json, []);
  if (!Array.isArray(rows) || !rows.length) throw new Error("Merge record has no restorable rows");
  const restoreStmt = db.prepare(`UPDATE watch_history
    SET title = ?, title_lower = ?, show_title = ?, show_title_lower = ?, updated_at = ?
    WHERE id = ?`);
  const now = Date.now();
  let restored = 0;
  transaction(() => {
    for (const row of rows) {
      const result = restoreStmt.run(row.title, row.title_lower, row.show_title, row.show_title_lower, now, row.id);
      restored += Number(result.changes || 0);
    }
    revertShowMergeStmt.run(now, merge.id);
  });
  queueShowProgressUpdate(merge.source_title);
  queueShowProgressUpdate(merge.target_title);
  await invalidateHistoryDerivedCaches("unmergeShow");
  return { restored, sourceTitle: merge.source_title, targetTitle: merge.target_title };
}

const selectNullSeasonEpisodeRowsStmt = db.prepare(
  "SELECT id, title, media_key, season, episode, imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE media_type = 'episode' AND season IS NULL",
);
const updateWatchSeasonStmt = db.prepare("UPDATE watch_history SET season = ?, updated_at = ? WHERE id = ?");
const movePlaystateSeasonKeyStmt = db.prepare(
  "UPDATE playstate SET media_key = ?, season = ?, updated_at = ? WHERE media_key = ?",
);
const STARTUP_BACKFILL_BATCH_SIZE = 100;

// Episode rows with no season number cannot match reliably for sync and do not
// count toward show progress, but the season is still written in the title
// ("Show - S00E13"). Recovering it also changes what mediaKeyFor produces, so the
// key is rebuilt and the playstate row keyed by the old value follows in the same
// transaction - leaving those out of step would strand the watched state.
export async function backfillMissingEpisodeSeasons() {
  const rows = selectNullSeasonEpisodeRowsStmt.all();
  if (!rows.length) return 0;

  const updatedAt = Date.now();
  let fixed = 0;
  for (let offset = 0; offset < rows.length; offset += STARTUP_BACKFILL_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + STARTUP_BACKFILL_BATCH_SIZE);
    let batchFixed = 0;
    transaction(() => {
      const keyMigrations = new Map();
      for (const row of batch) {
        const { season } = episodeCoordinatesFromTitle(row.title);
        if (season == null || !Number.isFinite(Number(season))) continue;

        updateWatchSeasonStmt.run(Number(season), updatedAt, row.id);
        batchFixed++;

        const previousKey = cleanString(row.media_key);
        const nextKey = mediaKeyFor({
          media_type: "episode",
          season: Number(season),
          episode: row.episode,
          imdb_id: row.imdb_id,
          tmdb_id: row.tmdb_id,
          tvdb_id: row.tvdb_id,
          title: row.title,
        });
        if (nextKey && nextKey !== previousKey) {
          updateWatchMediaKeyStmt.run(nextKey, updatedAt, row.id);
          if (previousKey) keyMigrations.set(previousKey, { nextKey, season: Number(season) });
        }
      }

      for (const [previousKey, { nextKey, season }] of keyMigrations) {
        if (selectPlaystateKeyStmt.get(nextKey)) deletePlaystateByKeyStmt.run(previousKey);
        else movePlaystateSeasonKeyStmt.run(nextKey, season, updatedAt, previousKey);
      }
    });
    fixed += batchFixed;
    await yieldToEventLoop();
  }

  if (fixed) {
    await invalidateHistoryDerivedCaches("backfillMissingEpisodeSeasons");
    console.log(`[dataRepo] backfillMissingEpisodeSeasons: recovered ${fixed} of ${rows.length} season numbers`);
  }
  return fixed;
}

export async function backfillUnknownShowTitles() {
  const rows = selectUnknownShowRowsStmt.all();
  if (!rows.length) return 0;
  let fixed = 0;
  for (let offset = 0; offset < rows.length; offset += STARTUP_BACKFILL_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + STARTUP_BACKFILL_BATCH_SIZE);
    let batchFixed = 0;
    transaction(() => {
      for (const row of batch) {
        let recovered = recoverShowTitle(row.tmdb_id, row.tvdb_id);
        let newTitle = null;
        if (recovered) {
          const oldTitle = row.title || "";
          newTitle = oldTitle.replace(/^Unknown Show(\s+-\s+S\d)/i, `${recovered}$1`);
        } else {
          // No sibling record shares this episode's ids (e.g. Plex supplies only
          // episode-unique TMDB/IMDb ids). Fall back to the resolved title recorded
          // in the dispatch telemetry, which also restores the episode coordinate.
          const fromTelemetry = recoverTitleFromTelemetry(row.sync_dispatch_telemetry);
          if (fromTelemetry) {
            recovered = fromTelemetry.showTitle;
            newTitle = fromTelemetry.fullTitle;
          }
        }
        if (!recovered || !newTitle) continue;
        updateShowTitleStmt.run(newTitle, newTitle.toLowerCase(), recovered, recovered.toLowerCase(), Date.now(), row.id);
        batchFixed++;
      }
    });
    fixed += batchFixed;
    await yieldToEventLoop();
  }
  if (fixed) {
    await invalidateHistoryDerivedCaches("backfillUnknownShowTitles");
    console.log(`[dataRepo] backfillUnknownShowTitles: fixed ${fixed} of ${rows.length} records`);
  }
  return fixed;
}

const EPISODE_TITLE_PLACEHOLDER_SQL = `(
  episode_title IS NULL
  OR TRIM(episode_title) = ''
  OR (TRIM(episode_title) NOT GLOB '*[^0-9]*')
  OR LOWER(TRIM(episode_title)) = 'episode'
  OR (
    LOWER(TRIM(episode_title)) GLOB 'episode [0-9]*'
    AND SUBSTR(TRIM(episode_title), 9) <> ''
    AND SUBSTR(TRIM(episode_title), 9) NOT GLOB '*[^0-9]*'
  )
)`;
const EPISODE_TITLE_ACTIONABLE_SQL = `(episode_title_status IS NULL OR episode_title_status IN ('missing', 'retryable_error')) AND ${EPISODE_TITLE_PLACEHOLDER_SQL}`;
const selectEpisodeTitleGapRowsStmt = db.prepare(`
  SELECT id, title, media_type, watched_at, show_title, imdb_id, tmdb_id, tvdb_id, season, episode,
    episode_title, episode_title_status, sync_dispatch_telemetry
  FROM watch_history
  WHERE media_type = 'episode' AND ${EPISODE_TITLE_ACTIONABLE_SQL}
  ORDER BY watched_at DESC, id DESC
`);
const selectEpisodeTitleGapPreviewStmt = db.prepare(`
  SELECT id, title, media_type, watched_at, show_title, imdb_id, tmdb_id, tvdb_id, season, episode,
    episode_title, episode_title_status
  FROM watch_history
  WHERE media_type = 'episode' AND ${EPISODE_TITLE_ACTIONABLE_SQL}
  ORDER BY watched_at DESC, id DESC
  LIMIT ?
`);
const countEpisodeTitleGapsStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM watch_history
  WHERE media_type = 'episode' AND ${EPISODE_TITLE_ACTIONABLE_SQL}
`);
const countEpisodeTitleNoTitleStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM watch_history
  WHERE media_type = 'episode'
    AND episode_title_status = 'no_title_provided'
    AND ${EPISODE_TITLE_PLACEHOLDER_SQL}
`);
const countEpisodeTitleRetryableStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM watch_history
  WHERE media_type = 'episode'
    AND episode_title_status = 'retryable_error'
    AND ${EPISODE_TITLE_PLACEHOLDER_SQL}
`);
const updateEpisodeTitleResolvedStmt = db.prepare(`
  UPDATE watch_history
  SET episode_title = ?, episode_title_status = 'resolved', episode_title_checked_at = ?,
    episode_title_resolution_error = NULL, updated_at = ?
  WHERE id = ?
`);
const updateEpisodeTitleDispositionStmt = db.prepare(`
  UPDATE watch_history
  SET episode_title = NULL, episode_title_status = ?, episode_title_checked_at = ?,
    episode_title_resolution_error = ?, updated_at = ?
  WHERE id = ?
`);

// ---- backfill of placeholder episode titles (Settings → Database Repairs) ----

// Rows whose stored episode_title is absent or a coordinate placeholder ("8",
// "Episode 08") would show that in the dashboard's TV "recently watched" row
// instead of the episode name shown on the media page. The ingest path now
// avoids persisting placeholders, but rows recorded earlier still carry them.
// Audit is read-only (safe to show a count). The count is exact; only the
// newest `limit` actionable rows are returned as a preview. Rows that have
// already been checked and genuinely have no title are kept out of the repair
// list and reported separately.
export function auditEpisodeTitleGaps({ limit = 100 } = {}) {
  const numericLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = selectEpisodeTitleGapPreviewStmt.all(numericLimit);
  return {
    total: Number(countEpisodeTitleGapsStmt.get()?.total || 0),
    noTitleProvided: Number(countEpisodeTitleNoTitleStmt.get()?.total || 0),
    retryable: Number(countEpisodeTitleRetryableStmt.get()?.total || 0),
    rows: rows
      .filter((row) => !row.episode_title || isPlaceholderEpisodeTitleValue(row.episode_title))
      .map((row) => ({
        id: row.id,
        title: row.title,
        show_title: row.show_title || null,
        season: row.season ?? null,
        episode: row.episode ?? null,
        episode_title: isPlaceholderEpisodeTitleValue(row.episode_title) ? null : row.episode_title || null,
        episode_title_status: row.episode_title_status || "missing",
        watched_at: row.watched_at || null,
      })),
  };
}

// Rewrite every actionable gap in one operation. `limit` is now only the
// network/concurrency chunk size; it is never a scan cap. That makes the
// Settings action a genuine full-library repair instead of an eight-batch
// workflow that silently leaves older rows for the user to discover.
export async function backfillEpisodeTitleGaps({ limit = 200, allowFetch = false } = {}) {
  const chunkSize = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const candidates = selectEpisodeTitleGapRowsStmt.all();
  if (!candidates.length) {
    const audit = auditEpisodeTitleGaps({ limit: 20 });
    return {
      scanned: 0,
      backfilled: 0,
      unresolved: audit.total,
      remaining: audit.total,
      no_title_provided: audit.noTitleProvided,
      retryable: audit.retryable,
    };
  }

  const namesByRow = new Map();
  let unresolved = [];

  // Pass 1 (synchronous): resolve every row from stored data only. This never
  // blocks and handles the overwhelmingly common case where a sibling row or
  // cached season metadata already holds the real name.
  transaction(() => {
    for (const row of candidates) {
      const stored = resolvedEpisodeTitleForRecord(row);
      if (stored) namesByRow.set(row.id, stored);
      else unresolved.push(row);
    }
  });

  // Pass 2 (async): only when the caller opted in and only for rows the stored
  // pass could not name, do live provider season fetches. Each fetch may hit the
  // network, so it runs outside the synchronous transaction and is best-effort.
  const noTitleRows = new Set();
  const retryableRows = new Map();

  if (allowFetch && unresolved.length) {
    const fetchedNames = new Map();
    const seasonFetches = new Map();
    const fetchSeason = (row) => {
      const providerId = row.tmdb_id || row.tvdb_id || "";
      if (!providerId || row.season == null) return null;
      const key = `${row.tmdb_id || ""}:${row.tvdb_id || ""}:${Number(row.season)}`;
      if (!seasonFetches.has(key)) {
        seasonFetches.set(key, getTmdbSeason({
          tmdbId: row.tmdb_id || "",
          tvdbId: row.tvdb_id || "",
          seasonNumber: row.season,
        }));
      }
      return seasonFetches.get(key);
    };
    for (let start = 0; start < unresolved.length; start += chunkSize) {
      const chunk = unresolved.slice(start, start + chunkSize);
      await Promise.all(chunk.map(async (row) => {
        if (row.season == null || row.episode == null || !(row.tmdb_id || row.tvdb_id)) {
          noTitleRows.add(row.id);
          return;
        }
        try {
          const seasonDetails = await fetchSeason(row);
          const name = episodeNameFromSeason(seasonDetails, row.episode);
          if (name) fetchedNames.set(row.id, name);
          else noTitleRows.add(row.id);
        } catch (error) {
          retryableRows.set(row.id, String(error?.message || error || "Metadata lookup failed").slice(0, 240));
        }
      }));
    }
    // Merge, but do not let a stored resolution be replaced by a fetched one.
    for (const [id, name] of fetchedNames) {
      if (!namesByRow.has(id)) namesByRow.set(id, name);
    }
  }

  if (namesByRow.size || (allowFetch && (noTitleRows.size || retryableRows.size))) {
    const now = Date.now();
    transaction(() => {
      for (const [id, name] of namesByRow) updateEpisodeTitleResolvedStmt.run(name, now, now, id);
      if (allowFetch) {
        for (const id of noTitleRows) {
          if (!namesByRow.has(id)) updateEpisodeTitleDispositionStmt.run("no_title_provided", now, null, now, id);
        }
        for (const [id, error] of retryableRows) {
          if (!namesByRow.has(id) && !noTitleRows.has(id)) updateEpisodeTitleDispositionStmt.run("retryable_error", now, error, now, id);
        }
      }
    });
    await invalidateHistoryDerivedCaches("backfillEpisodeTitleGaps");
  }

  const allGaps = auditEpisodeTitleGaps({ limit: 20 });
  return {
    scanned: candidates.length,
    backfilled: namesByRow.size,
    unresolved: candidates.length - namesByRow.size,
    remaining: allGaps.total,
    no_title_provided: allGaps.noTitleProvided,
    retryable: allGaps.retryable,
  };
}

export function deleteWatchRecordByIdSync(id, { allowDuringRestore = false } = {}) {
  assertRestoreWriteAllowed("manual", { allowDuringRestore });
  if (!id) return false;
  const row = selectByIdStmt.get(String(id));
  if (row) {
    queueProgressUpdateForRecord(row);
    recordWatchAuditEvent({
      eventType: "history_deleted",
      timestamp: Date.now(),
      action: row.sync_action || "watched",
      watchRecordId: row.id,
      mediaKey: row.media_key,
      mediaType: row.media_type,
      title: row.title,
      showTitle: row.show_title,
      source: row.source,
      ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
      season: row.season,
      episode: row.episode,
      status: "deleted",
      details: "Watch history row deleted from Plekt.",
      payload: { record: row },
    });
  }
  deleteByIdStmt.run(String(id));
  // playstate is a separate cached snapshot of "is this watched" and must be
  // reconciled here, not left for the caller to remember - a caller that
  // deletes the last remaining watch_history row for a media_key and skips
  // this leaves playstate stuck reporting "watched" for an item Plembfin no
  // longer has any record of, which is exactly the drift that let Force Sync
  // and the Movies/TV Shows/History pages disagree with each other.
  if (row?.media_key) {
    const remaining = selectByMediaKeyStmt.all(row.media_key).filter(isPlektTrackedWatchRow);
    if (remaining.length) {
      const remainingRow = remaining.reduce((best, r) => (String(r.watched_at || "") > String(best.watched_at || "") ? r : best));
      updatePlaystateWatchedAtStmt.run(remainingRow.watched_at, Date.now(), row.media_key);
    } else {
      deletePlaystateByKeyStmt.run(row.media_key);
    }
  }
  return true;
}

export async function deleteWatchRecordById(id, { skipInvalidate = false, allowDuringRestore = false } = {}) {
  const deleted = deleteWatchRecordByIdSync(id, { allowDuringRestore });
  if (deleted && !skipInvalidate) await invalidateHistoryDerivedCaches("deleteWatchRecordById");
  return deleted;
}

export function deleteWatchRecordSync(media, { allowDuringRestore = false } = {}) {
  assertRestoreWriteAllowed(media?.source || "manual", { allowDuringRestore });
  const key = mediaKeyFor({
    title: media.title,
    type: media.type,
    imdb: media.ids?.imdb,
    tmdb: media.ids?.tmdb,
    tvdb: media.ids?.tvdb,
    season: media.season,
    episode: media.episode,
  });
  const rows = selectByMediaKeyStmt.all(key);
  if (!rows.length) return false;
  for (const row of rows) {
    queueProgressUpdateForRecord(row);
  }
  transaction(() => {
    for (const row of rows) {
      deleteByIdStmt.run(row.id);
      recordWatchAuditEvent({
        eventType: "history_deleted",
        timestamp: Date.now(),
        action: row.sync_action || "watched",
        watchRecordId: row.id,
        mediaKey: row.media_key,
        mediaType: row.media_type,
        title: row.title,
        showTitle: row.show_title,
        source: row.source,
        ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
        season: row.season,
        episode: row.episode,
        status: "deleted",
        details: "Watch history row deleted from Plekt.",
        payload: { record: row },
      });
    }
  });
  return true;
}

export async function deleteWatchRecord(media, { skipInvalidate = false, allowDuringRestore = false } = {}) {
  const deleted = deleteWatchRecordSync(media, { allowDuringRestore });
  if (deleted && !skipInvalidate) await invalidateHistoryDerivedCaches("deleteWatchRecord");
  return deleted;
}

export function requireDb() {
  return db;
}

// One-time repair for the Trakt play-history import incident (2026-08-19): the
// feature originally inserted "trakt_import" watch rows with no
// sync_dispatch_telemetry, so the scheduler's manual-dispatch retry sweep
// treated every one of them as pending work and kept re-sending them to
// every connected target, including back out to Trakt. The fix stops new
// rows from being created this way (they now always carry settled
// telemetry), but rows already inserted before the fix was deployed are
// still sitting there with telemetry = NULL and still get swept up on every
// scheduler tick. NULL telemetry on a "trakt_import" row uniquely identifies
// this: the CSV/JSON bulk importer always writes telemetry via
// defaultTelemetry(), and the play-history importer has written explicit
// "skipped" telemetry since the fix, so nothing legitimate should ever have
// a NULL value here.
const STALE_TRAKT_IMPORT_TELEMETRY = [
  "Origin: trakt_import",
  "Loop-check: Skipped propagation",
  "Dispatch status: skipped",
  "Details: Historical play imported before dispatch telemetry was recorded on import; repaired to stop repeated re-dispatch.",
  ...settledDestinationLines("Historical import; not re-propagated"),
].join("\n");
const selectStaleTraktImportRowsStmt = db.prepare(
  "SELECT id, title, watched_at, created_at FROM watch_history WHERE source = 'trakt_import' AND sync_action = 'watched' AND sync_dispatch_telemetry IS NULL ORDER BY created_at ASC",
);
const repairStaleTraktImportRowsStmt = db.prepare(
  "UPDATE watch_history SET sync_dispatch_telemetry = ?, sync_retry_count = 0, sync_next_retry_at = 0, updated_at = ? WHERE source = 'trakt_import' AND sync_action = 'watched' AND sync_dispatch_telemetry IS NULL",
);

export function auditStaleTraktImportRows({ sampleSize = 25 } = {}) {
  const rows = selectStaleTraktImportRowsStmt.all();
  return {
    count: rows.length,
    sample: rows.slice(0, sampleSize).map((row) => ({ id: row.id, title: row.title, watchedAt: row.watched_at, createdAt: row.created_at })),
  };
}

export function repairStaleTraktImportRows() {
  const result = repairStaleTraktImportRowsStmt.run(STALE_TRAKT_IMPORT_TELEMETRY, Date.now());
  return { repaired: result.changes };
}

// General-purpose version of the repair above, for any code path (not just
// the Trakt play-history importer) that pushes a canonical watched/unwatched
// replay without writing the result back onto the row it replayed - e.g.
// propagateWatchDateRemoval/propagateCorrectedWatchDate in routes/media.js,
// which call syncCanonicalPlaystate to re-dispatch an *existing* row's state
// but never call updateWatchTelemetry afterward. A row like that can be left
// with telemetry that never reflects a completed dispatch, which the
// scheduler's manual-dispatch retry sweep (syncPendingManualDispatches in
// scheduled.js) either sees as "pending" forever or eventually gives up on
// after SYNC_RETRY_MAX_ATTEMPTS - at which point nothing retries it again
// without a manual "Retry Sync" click.
//
// This targets exactly those two unambiguous signatures rather than a fuzzy
// "does this look synced" check: NULL/empty telemetry (nothing legitimate
// leaves it blank past the very first write) and a retry count that has
// already hit the scheduler's own give-up threshold (10 - see
// SYNC_RETRY_MAX_ATTEMPTS in scheduled.js; duplicated here rather than
// imported, since scheduled.js imports heavily from this module and importing
// back would create a cycle). The repair does not fabricate a "settled"
// telemetry the way the Trakt-specific repair above does - it only resets the
// retry bookkeeping so the row becomes eligible again, and lets the existing,
// already-tested manual-dispatch sweep perform a real dispatch and record
// what actually happened.
const STALE_PENDING_WATCH_RETRY_MAX_ATTEMPTS = 10;
const selectStalePendingWatchRowsStmt = db.prepare(
  `SELECT id, title, source, watched_at, sync_retry_count, sync_dispatch_telemetry, created_at FROM watch_history
   WHERE sync_action = 'watched'
     AND (sync_dispatch_telemetry IS NULL OR TRIM(sync_dispatch_telemetry) = '' OR sync_retry_count >= ?)
   ORDER BY created_at ASC`,
);
const repairStalePendingWatchRowsStmt = db.prepare(
  `UPDATE watch_history SET sync_retry_count = 0, sync_next_retry_at = 0, updated_at = ?
   WHERE sync_action = 'watched'
     AND (sync_dispatch_telemetry IS NULL OR TRIM(sync_dispatch_telemetry) = '' OR sync_retry_count >= ?)`,
);

export function auditStalePendingWatchRows({ sampleSize = 25 } = {}) {
  const rows = selectStalePendingWatchRowsStmt.all(STALE_PENDING_WATCH_RETRY_MAX_ATTEMPTS);
  return {
    count: rows.length,
    sample: rows.slice(0, sampleSize).map((row) => ({
      id: row.id,
      title: row.title,
      source: row.source,
      watchedAt: row.watched_at,
      retryCount: row.sync_retry_count,
      telemetry: row.sync_dispatch_telemetry || null,
      createdAt: row.created_at,
    })),
  };
}

export function repairStalePendingWatchRows() {
  const result = repairStalePendingWatchRowsStmt.run(Date.now(), STALE_PENDING_WATCH_RETRY_MAX_ATTEMPTS);
  return { repaired: result.changes };
}

// Read-only detector for a different aftermath of the same deleteWatchDates
// media_key-split bug: before that fix, deleting a "duplicate" could wrongly
// decide nothing remained for an episode and push a *real* mark-unplayed to
// Plex/Emby/Jellyfin, even though a genuine earlier watch (stored under a
// different media_key for the same show/season/episode) still existed. The
// automatic Emby/Jellyfin/Plex unwatched-fallback polls then correctly - by
// their own logic - observed that real external unplayed state and recorded
// it as Plembfin's own canonical unwatched row, faithfully copying the
// corruption back in rather than causing it.
//
// The fingerprint: for one show/season/episode, an older row exists with
// sync_action='watched' under media_key A, and a newer row exists with
// sync_action='unwatched' under a *different* media_key B. A genuine user
// unwatch would have found and superseded the existing watched row (via
// findWatchedByAnyMediaKey in applyUnwatchedTransition) rather than leaving
// it behind under its own key - so a split like this, with the unwatch
// strictly newer than the watch it shadows, is a strong signal of this
// specific chain of events rather than an intentional unwatch.
//
// Deliberately audit-only by default (see auditSplitIdentityUnwatches):
// reverting an unwatch that really was intentional would itself be a phantom
// watch. Shared by the audit and the (separately opt-in) repair below so both
// use the exact same fingerprint - returns full rows, not the trimmed shape
// the audit endpoint reports.
function findSplitIdentityUnwatchCandidates() {
  const rows = selectAllEpisodesStmt.all().filter(isPlektTrackedEpisodeRow);
  const groups = new Map();
  for (const row of rows) {
    const showKey = canonicalTitleKey(showTitleFrom(row.show_title || row.title));
    const season = row.season == null ? null : Number(row.season);
    const episode = row.episode == null ? null : Number(row.episode);
    if (!showKey || season == null || episode == null) continue;
    const groupKey = `${showKey}|s${season}e${episode}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }

  const candidates = [];
  for (const groupRows of groups.values()) {
    const distinctKeys = new Set(groupRows.map((row) => row.media_key).filter(Boolean));
    if (distinctKeys.size < 2) continue;

    const watchedRows = groupRows.filter((row) => (row.sync_action || "watched") === "watched");
    const unwatchedRows = groupRows.filter((row) => row.sync_action === "unwatched");
    if (!watchedRows.length || !unwatchedRows.length) continue;

    const newest = (list) => list.reduce((best, row) => (Number(row.updated_at || 0) > Number(best.updated_at || 0) ? row : best));
    const newestWatched = newest(watchedRows);
    const newestUnwatched = newest(unwatchedRows);
    if (newestWatched.media_key === newestUnwatched.media_key) continue;
    if (Number(newestUnwatched.updated_at || 0) <= Number(newestWatched.updated_at || 0)) continue;

    candidates.push({ show: groupRows[0].show_title || showTitleFrom(groupRows[0].title), watchedRow: newestWatched, unwatchedRow: newestUnwatched });
  }
  return candidates;
}

// Deliberately audit-only: reverting an unwatch that really was intentional
// would itself be a phantom watch, so this surfaces candidates for review
// rather than restoring anything automatically.
export function auditSplitIdentityUnwatches({ sampleSize = 50 } = {}) {
  const candidates = findSplitIdentityUnwatchCandidates();
  const findings = candidates.map(({ show, watchedRow, unwatchedRow }) => ({
    show,
    season: watchedRow.season,
    episode: watchedRow.episode,
    watchedRow: {
      id: watchedRow.id, mediaKey: watchedRow.media_key, watchedAt: watchedRow.watched_at,
      source: watchedRow.source, updatedAt: watchedRow.updated_at,
    },
    unwatchedRow: {
      id: unwatchedRow.id, mediaKey: unwatchedRow.media_key, watchedAt: unwatchedRow.watched_at,
      source: unwatchedRow.source, updatedAt: unwatchedRow.updated_at, telemetry: unwatchedRow.sync_dispatch_telemetry || null,
    },
  }));
  return { count: findings.length, sample: findings.slice(0, sampleSize) };
}

// Opt-in repair for the candidates auditSplitIdentityUnwatches finds. For
// each one: deletes the shadowing unwatched row and restores playstate to
// the shadowed watched row's own date. This only fixes Plembfin's own
// database - it deliberately does not import a syncOrchestrator dependency
// (see the backend module discipline rule against cycles back into modules
// dataRepo.js is itself imported by), so the caller is responsible for
// re-pushing the corrected "watched" state to Plex/Emby/Jellyfin/Trakt using
// the returned media-shaped objects, the same way propagateWatchDateRemoval
// in routes/media.js already does for the equivalent single-item case.
export async function repairSplitIdentityUnwatches() {
  const candidates = findSplitIdentityUnwatchCandidates();
  const restored = [];
  for (const { watchedRow, unwatchedRow } of candidates) {
    const media = {
      title: watchedRow.title,
      type: watchedRow.media_type,
      season: watchedRow.season,
      episode: watchedRow.episode,
      show_title: watchedRow.show_title,
      isValid: true,
      source: "manual",
      watched_at: watchedRow.watched_at,
      ids: { imdb: watchedRow.imdb_id || undefined, tmdb: watchedRow.tmdb_id || undefined, tvdb: watchedRow.tvdb_id || undefined },
    };
    await deleteWatchRecordById(unwatchedRow.id, { skipInvalidate: true });
    // Upsert, not a plain UPDATE: the original bug could have deleted the
    // playstate row entirely (not just left it stale), so there may be
    // nothing at watchedRow.media_key for an UPDATE to find.
    await upsertPlaystateForMedia(media, "watched", watchedRow.watched_at, { skipInvalidate: true });
    restored.push(media);
  }
  if (restored.length) await invalidateHistoryDerivedCaches("repairSplitIdentityUnwatches");
  return { repaired: restored.length, media: restored };
}

// Read-only detector for a broader aftermath of the same mass false-unwatch
// incident (2026-08-21) that auditSplitIdentityUnwatches targets, for
// episodes where the shadowed watched row didn't survive at all - every row
// left for the episode reads sync_action='unwatched', so there is nothing to
// "restore" a playstate to, only rows to consolidate into a fresh watched one.
//
// The fingerprint: no row in the group currently reads watched, but at least
// one of the unwatched rows came from an automatic source (plex/emby/jellyfin
// - never "manual", which only a person or an explicit replay produces). A
// genuine, intentional unwatch normally converges to one clean row via
// applyUnwatchedTransition's own supersede/reuse logic; multiple automatic-
// sourced unwatched rows (or even a single one with no surviving watched
// sibling anywhere) sitting for the same episode is the same automatic-source-
// cascade signature as the split-identity case, just missing its shadowed
// watched half. The row with the oldest watched_at across the whole group is
// treated as the best evidence of when the item was actually, genuinely
// watched.
//
// This is a broader, less certain heuristic than auditSplitIdentityUnwatches
// (there is no surviving watched row to confirm against), so it is even more
// important that this stays audit-only until a human has reviewed real
// candidates - an automatic source is also exactly what a genuine unwatch
// performed directly on a media server (not through Plembfin) looks like.
const AUTOMATIC_UNWATCH_ROW_SOURCES = new Set(["plex", "emby", "jellyfin"]);

function findLikelyFalseUnwatchCandidates() {
  const rows = selectAllEpisodesStmt.all().filter(isPlektTrackedEpisodeRow);
  const groups = new Map();
  for (const row of rows) {
    const showKey = canonicalTitleKey(showTitleFrom(row.show_title || row.title));
    const season = row.season == null ? null : Number(row.season);
    const episode = row.episode == null ? null : Number(row.episode);
    if (!showKey || season == null || episode == null) continue;
    const groupKey = `${showKey}|s${season}e${episode}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }

  const candidates = [];
  for (const groupRows of groups.values()) {
    const hasWatched = groupRows.some((row) => (row.sync_action || "watched") === "watched");
    if (hasWatched) continue;
    const automaticUnwatched = groupRows.filter(
      (row) => row.sync_action === "unwatched" && AUTOMATIC_UNWATCH_ROW_SOURCES.has(String(row.source || "").toLowerCase()),
    );
    if (!automaticUnwatched.length) continue;
    const bestEvidence = groupRows.reduce((best, row) => (String(row.watched_at || "") < String(best.watched_at || "") ? row : best));
    candidates.push({ show: groupRows[0].show_title || showTitleFrom(groupRows[0].title), rows: groupRows, bestEvidence });
  }
  return candidates;
}

export function auditLikelyFalseUnwatches({ sampleSize = 50 } = {}) {
  const candidates = findLikelyFalseUnwatchCandidates();
  const findings = candidates.map(({ show, rows, bestEvidence }) => ({
    show,
    season: bestEvidence.season,
    episode: bestEvidence.episode,
    restoreUsing: { id: bestEvidence.id, watchedAt: bestEvidence.watched_at, source: bestEvidence.source },
    rows: rows.map((row) => ({
      id: row.id, mediaKey: row.media_key, watchedAt: row.watched_at, source: row.source,
      updatedAt: row.updated_at, telemetry: row.sync_dispatch_telemetry || null,
    })),
  }));
  return { count: findings.length, sample: findings.slice(0, sampleSize) };
}

// Opt-in repair for the candidates above: deletes every stale row for the
// episode (none of them currently reads watched) and inserts one fresh
// canonical "watched" record using the oldest row's own date as the best
// evidence of when it was genuinely watched. Returns media-shaped objects for
// the caller to re-push to Plex/Emby/Jellyfin/Trakt, the same contract
// repairSplitIdentityUnwatches uses.
export async function repairLikelyFalseUnwatches() {
  const candidates = findLikelyFalseUnwatchCandidates();
  const watchlistConfig = await loadMediaConfig().catch(() => null);
  const restored = [];
  for (const { rows, bestEvidence } of candidates) {
    const media = {
      title: bestEvidence.title,
      type: bestEvidence.media_type,
      season: bestEvidence.season,
      episode: bestEvidence.episode,
      show_title: bestEvidence.show_title,
      isValid: true,
      source: "manual",
      watched_at: bestEvidence.watched_at,
      ids: { imdb: bestEvidence.imdb_id || undefined, tmdb: bestEvidence.tmdb_id || undefined, tvdb: bestEvidence.tvdb_id || undefined },
    };
    for (const row of rows) {
      await deleteWatchRecordById(row.id, { skipInvalidate: true });
    }
    const record = mediaToWatchRecord({ ...media, syncAction: "watched" }, "manual");
    record.sync_action = "watched";
    await insertWatchRecord(record, { skipInvalidate: true, watchlistConfig });
    await upsertPlaystateForMedia(media, "watched", bestEvidence.watched_at, { skipInvalidate: true });
    restored.push(media);
  }
  if (restored.length) await invalidateHistoryDerivedCaches("repairLikelyFalseUnwatches");
  return { repaired: restored.length, media: restored };
}

// --- Maintenance helpers (used by index.js admin endpoints) ----------------
export async function findExistingWatch(mediaKey, watchedAt) {
  return rowToWatch(findExistingStmt.get(mediaKey, watchedAt));
}

export async function findWatchedByMediaKey(mediaKey) {
  return rowToWatch(findWatchedByKeyStmt.get(mediaKey));
}

// Checks all possible key formats for the same media item (IMDB, TMDB, TVDB, title),
// then falls back to coordinate-based lookup (type+season+episode+title/show_title)
// to match records that were imported with a different ID type (e.g. Trakt IMDB keys
// vs Emby TVDB keys) or keyed by title.
//
// Keep a synchronous variant for read-only decisions that already run entirely
// against SQLite, such as filtering stale manual-review rows. The async wrapper
// below remains the public compatibility path for callers that use `.catch()`.
export function findWatchedByAnyMediaKeySync(media) {
  const ids = media.ids || {};
  const seen = new Set();
  const candidates = [
    mediaKeyFor(media),
    ids.imdb ? mediaKeyFor({ ...media, ids: { imdb: ids.imdb } }) : null,
    ids.tmdb ? mediaKeyFor({ ...media, ids: { tmdb: ids.tmdb } }) : null,
    ids.tvdb ? mediaKeyFor({ ...media, ids: { tvdb: ids.tvdb } }) : null,
  ];
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = findWatchedByKeyStmt.get(key);
    if (row) return rowToWatch(row);
  }

  // Coordinate fallback: match by season+episode+show_title or title when no ID matched.
  // Handles Trakt-imported records (IMDB-keyed) being looked up via Emby/Jellyfin (TVDB-keyed).
  const type = String(media.media_type || media.type || "").toLowerCase();
  const season = media.season ?? null;
  const episode = media.episode ?? null;
  if (type === "episode" && season != null && episode != null) {
    const rawShowTitle = media.show_title || media.showTitle || media.title?.split(" - S")[0] || "";
    const showTitleLower = rawShowTitle.trim().toLowerCase();
    // Two shows can share a title and coordinate (Scrubs 2001 and its reboot);
    // a row whose ids prove the other show is not this episode's watch.
    const sameShow = sameShowAs({ ...media, media_type: "episode" });
    if (showTitleLower) {
      const row = findWatchedByShowCoordinatesStmt.all(season, episode, showTitleLower).find(sameShow);
      if (row) return rowToWatch(row);
    }
    const titleLower = (media.title || "").trim().toLowerCase();
    if (titleLower) {
      const row = findWatchedByCoordinatesStmt.all("episode", season, season, episode, episode, titleLower).find(sameShow);
      if (row) return rowToWatch(row);
    }
    // Last resort: the exact-string matches above found nothing, but this
    // could still be the same real episode after a media-server metadata
    // rematch (every provider id changed) or a trailing "(YYYY)" that only
    // one side carries - e.g. "Ludwig" vs "Ludwig (2024)". Without this, a
    // rematch makes every affected episode look brand new and gets
    // duplicated instead of recognized on the next sync.
    if (rawShowTitle) {
      const targetKey = canonicalShowTitleKey(rawShowTitle);
      if (targetKey) {
        const match = findWatchedBySeasonEpisodeStmt.all(season, episode)
          .find((row) => canonicalShowTitleKey(row.show_title) === targetKey && sameShow(row));
        if (match) return rowToWatch(match);
      }
    }
  } else if (type === "movie") {
    // Remakes share a title; a row whose ids prove another film is not this
    // movie's watch (Beauty and the Beast 1991 vs 2017).
    const sameFilm = sameFilmAs(media);
    const titleLower = (media.title || "").trim().toLowerCase();
    if (titleLower) {
      const row = findWatchedByCoordinatesStmt.all("movie", null, null, null, null, titleLower).find(sameFilm);
      if (row) return rowToWatch(row);
    }
    // Last resort: an exact title_lower match can miss two rows for the same
    // movie that only differ by whitespace variant - e.g. Trakt imports often
    // carry a non-breaking space after a colon ("Title: Subtitle") where
    // Plex/Emby/Jellyfin report a plain space for the identical title. Without
    // this, that already-watched movie looks brand new on the next scheduled
    // sync and gets duplicated under a second, title-only media_key. Mirrors
    // the episode fallback above, using the same canonicalTitleKey normalizer
    // siblingWatchRowsFor already relies on to merge these rows for display.
    const targetKey = canonicalTitleKey(media.title || "");
    if (targetKey) {
      const match = selectMoviesStmt.all()
        .find((row) => row.sync_action === "watched" && canonicalTitleKey(row.title) === targetKey && sameFilm(row));
      if (match) return rowToWatch(match);
    }
  }

  return null;
}

// Whether history (and so the show and history pages) shows this item as
// watched: the newest trusted watched/unwatched transition, resolved like
// dedupeHistory does. Playstate can lag behind it; see
// plan/active/playstate-episode-id-repair/plan.md (Slow Horses S06E01).
export function historyShowsWatchedSync(media = {}) {
  const ids = media.ids || {};
  const rows = new Map();
  const add = (row) => {
    if (row?.id && isPlektTrackedEpisodeRow(row)) rows.set(row.id, row);
  };
  const keys = new Set([
    mediaKeyFor(media),
    ...["imdb", "tmdb", "tvdb"].map((kind) => (ids[kind] ? mediaKeyFor({ ...media, ids: { [kind]: ids[kind] } }) : null)),
  ]);
  for (const key of keys) if (key) selectHistoryByMediaKeyStmt.all(key).forEach(add);
  const type = normalizeMediaType(media.media_type || media.type);
  if (type === "episode" && media.season != null && media.episode != null) {
    const showKey = canonicalShowTitleKey(showTitleFrom(media.show_title || media.showTitle || media.title || ""));
    const sameShow = sameShowAs({ ...media, media_type: "episode" });
    if (showKey) {
      selectEpisodeHistoryByCoordinateStmt.all(media.season, media.episode)
        .filter((row) => canonicalShowTitleKey(showTitleFrom(row.show_title || row.title || "")) === showKey && sameShow(row))
        .forEach(add);
    }
  }
  let latest = null;
  for (const row of rows.values()) {
    if (!latest || canonicalTransitionIsNewer(row, latest)) latest = row;
  }
  return Boolean(latest && isWatchedAction(latest));
}

// Return the richest watched row for an episode identity. The first row found
// by the legacy lookup is not necessarily the best anchor: a media server can
// report the same episode with only its episode-level id while an older
// Plembfin row has the established show ids. Unwatch transitions use this
// richer anchor so a provider rematch cannot split the new tombstone into a
// second show cluster.
export function findLatestWatchedByAnyMediaKeySync(media) {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    if (!row || seen.has(row.id) || !isPlektTrackedWatchRow(row)) return;
    seen.add(row.id);
    rows.push(row);
  };

  const type = normalizeMediaType(media.media_type || media.mediaType || media.type);
  const sameShow = sameShowAs({ ...media, media_type: type });
  const direct = findWatchedByAnyMediaKeySync(media);
  const directRow = direct?.id ? selectByIdStmt.get(direct.id) : null;
  if (directRow && sameShow(directRow)) add(directRow);

  const season = media.season == null ? null : Number(media.season);
  const episode = media.episode == null ? null : Number(media.episode);
  if (type === "episode" && season != null && episode != null) {
    const showTitle = media.show_title || media.showTitle || media.title || "";
    const showKey = canonicalShowTitleKey(showTitleFrom(showTitle));
    selectAllEpisodesStmt.all()
      .filter((row) => (
        isPlektTrackedWatchRow(row)
          && Number(row.season) === season
          && Number(row.episode) === episode
          && canonicalShowTitleKey(showTitleFrom(row.show_title || row.title)) === showKey
          && sameShow(row)
      ))
      .forEach(add);
  }

  if (type === "movie") {
    safeMovieIdentityRowsForTitle(media).forEach(add);
  }

  if (!rows.length) return null;
  const identityCount = (row) => [row.imdb_id, row.tmdb_id, row.tvdb_id].filter((value) => cleanString(value)).length;
  rows.sort((left, right) => (
    identityCount(right) - identityCount(left)
      || String(right.watched_at || "").localeCompare(String(left.watched_at || ""))
      || Number(right.created_at || 0) - Number(left.created_at || 0)
  ));
  return rowToWatch(rows[0]);
}

export async function findWatchedByAnyMediaKey(media) {
  return findWatchedByAnyMediaKeySync(media);
}

const countMissingPosterStmt = db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE source = ? AND (poster_url IS NULL OR poster_url = '')");
const listMissingPosterStmt = db.prepare("SELECT * FROM watch_history WHERE source = ? AND (poster_url IS NULL OR poster_url = '') LIMIT ?");

export async function countMissingPosterTrackerRows(provider = "trakt") {
  return countMissingPosterStmt.get(trackerImportSource(provider)).c || 0;
}

export async function listMissingPosterTrackerRows(limit = 50, provider = "trakt") {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return listMissingPosterStmt.all(trackerImportSource(provider), safeLimit).map(rowToWatch);
}

export async function stampWatchPoster(id, posterUrl) {
  if (!id) return;
  updatePosterStmt.run(String(posterUrl || ""), Date.now(), String(id));
}

const updateMediaTypeStmt = db.prepare("UPDATE watch_history SET media_type = ?, updated_at = ? WHERE id = ?");
export async function setWatchMediaType(id, mediaType) {
  if (!id) return;
  updateMediaTypeStmt.run(mediaType, Date.now(), String(id));
}

const allKeyGroupsStmt = db.prepare("SELECT id, media_key, watched_at FROM watch_history");
export function loadWatchKeyGroupsForDedup() {
  const groups = new Map();
  for (const row of allKeyGroupsStmt.all()) {
    const key = row.media_key || row.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: row.id, watchedAt: row.watched_at || "" });
  }
  return groups;
}

const deletePlaystateByKeyStmt = db.prepare("DELETE FROM playstate WHERE media_key = ?");

// Permanently delete a single library item and every trace of its history:
// all watch_history plays that collapse into the same card, plus the matching
// playstate and playback_progress rows. Matching is by shared external ID
// (imdb/tmdb/tvdb); only when the anchor has no IDs do we fall back to title.
export async function deleteMovieByWatchId(id, { skipInvalidate = false } = {}) {
  assertRestoreWriteAllowed("manual");
  const anchor = selectByIdStmt.get(String(id || ""));
  if (!anchor) return { found: false, deleted: 0 };

  const imdb = cleanString(anchor.imdb_id);
  const tmdb = cleanString(anchor.tmdb_id);
  const tvdb = cleanString(anchor.tvdb_id);
  const titleKey = canonicalTitleKey(anchor.title);
  const hasId = Boolean(imdb || tmdb || tvdb);

  const matches = selectMoviesStmt.all().filter((row) => {
    if (hasId) {
      return (imdb && cleanString(row.imdb_id) === imdb)
        || (tmdb && cleanString(row.tmdb_id) === tmdb)
        || (tvdb && cleanString(row.tvdb_id) === tvdb);
    }
    return canonicalTitleKey(row.title) === titleKey;
  });
  if (!matches.some((row) => row.id === anchor.id)) matches.push(anchor);

  const mediaKeys = new Set();
  transaction(() => {
    for (const row of matches) {
      deleteByIdStmt.run(row.id);
      if (row.media_key) mediaKeys.add(row.media_key);
    }
    for (const key of mediaKeys) {
      deletePlaystateByKeyStmt.run(key);
      deleteProgressStmt.run(key);
    }
  });

  if (!skipInvalidate) await invalidateHistoryDerivedCaches("deleteMovieByWatchId");
  return { found: true, deleted: matches.length, title: anchor.title };
}

// Permanently delete a TV show and every stored episode row belonging to the
// same show cluster. The cluster logic keeps a reboot with the same title
// separate when provider identities are available, while still removing all
// plays for the selected show. Unmatched rows have no safe show identity, so
// only the selected media key is removed in that case.
export async function deleteShowByWatchId(id, { skipInvalidate = false } = {}) {
  assertRestoreWriteAllowed("manual");
  const anchor = selectByIdStmt.get(String(id || ""));
  if (!anchor || normalizeMediaType(anchor.media_type) !== "episode") return { found: false, deleted: 0 };

  const episodeRows = selectAllEpisodesStmt.all();
  const anchorRow = episodeRows.find((row) => String(row.id) === String(anchor.id)) || anchor;
  const showTitle = showTitleFrom(anchor.show_title || anchor.title);
  const isUnmatched = !showTitle || /^unknown show$/i.test(showTitle);
  let matches = [];

  if (isUnmatched) {
    matches = episodeRows.filter((row) => row.media_key && row.media_key === anchor.media_key);
  } else {
    const groupKeys = showGroupKeys(episodeRows);
    const anchorGroupKey = groupKeys.get(anchorRow);
    matches = anchorGroupKey == null
      ? episodeRows.filter((row) => canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === canonicalTitleKey(showTitle))
      : episodeRows.filter((row) => groupKeys.get(row) === anchorGroupKey);
  }
  if (!matches.some((row) => String(row.id) === String(anchor.id))) matches.push(anchor);

  const mediaKeys = new Set();
  transaction(() => {
    for (const row of matches) {
      deleteByIdStmt.run(row.id);
      if (row.media_key) mediaKeys.add(row.media_key);
    }
    for (const key of mediaKeys) {
      deletePlaystateByKeyStmt.run(key);
      deleteProgressStmt.run(key);
    }
  });

  if (!skipInvalidate) await invalidateHistoryDerivedCaches("deleteShowByWatchId");
  return { found: true, deleted: matches.length, title: showTitle || anchor.title };
}

export async function deleteMediaByWatchId(id, { mediaType = "", skipInvalidate = false } = {}) {
  const anchor = selectByIdStmt.get(String(id || ""));
  if (!anchor) return { found: false, deleted: 0 };
  const type = normalizeMediaType(anchor.media_type || mediaType);
  if (type === "movie") return deleteMovieByWatchId(id, { skipInvalidate });
  if (type === "episode") return deleteShowByWatchId(id, { skipInvalidate });
  return { found: false, deleted: 0 };
}

export function deleteWatchRecordsByIds(ids = []) {
  assertRestoreWriteAllowed("manual");
  let deleted = 0;
  transaction(() => {
    for (const id of ids) {
      if (!id) continue;
      const row = selectByIdStmt.get(String(id));
      if (row) {
        queueProgressUpdateForRecord(row);
      }
      deleteByIdStmt.run(String(id));
      deleted += 1;
    }
  });
  return deleted;
}

const deletePosterByMediaKeyStmt = db.prepare("DELETE FROM poster_cache WHERE media_key = ?");
export async function deletePosterCacheByMediaKey(mediaKey) {
  if (!mediaKey) return;
  deletePosterByMediaKeyStmt.run(mediaKey);
}

export async function countWatchHistoryRows() {
  return db.prepare("SELECT COUNT(*) AS c FROM watch_history").get().c || 0;
}

export function countWatchHistoryRowsBySource(source) {
  return db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE source = ?").get(String(source || "")).c || 0;
}

// A stable, monotonically-shrinking backlog figure for a large Trakt import's
// outbound propagation. Only work that has not run yet, is currently pending,
// or has a scheduled retry for a real failure belongs in `pending`.
// Partial/no-match, skipped, exhausted-error, and successful outcomes are
// terminal and must not leave the UI claiming that propagation is still active.
//
// importTraktPlayHistory (trackerSync.js) backfills every individual Trakt
// play - rewatches included - as its own row, explicitly marked "skipped -
// Historical import; not re-propagated": those are deliberately terminal,
// never meant to reach Plex/Emby/Jellyfin (only the current watched *state*
// needs pushing once, not every past play), and must be excluded from both
// sides of this count or a large play-history backfill reads as a stuck
// backlog when it's actually already finished. Echo-loop skips are the same
// kind of intentional terminal state.
const NOT_PENDING_TELEMETRY_SQL = `(sync_dispatch_telemetry NOT LIKE '%Historical import%' AND sync_dispatch_telemetry NOT LIKE '%Echo loop caught%')`;
const TRAKT_IMPORT_SYNC_RETRY_MAX_ATTEMPTS = 10;
// `not_found` is serialized as a skipped target by syncOrchestrator. A real
// retryable failure is explicitly represented by an error/failed status line;
// a no-match line must never keep a historical-import progress banner alive.
const TRAKT_IMPORT_REAL_FAILURE_TELEMETRY_SQL = `(
  LOWER(COALESCE(sync_dispatch_telemetry, '')) LIKE '%status: error%'
  OR LOWER(COALESCE(sync_dispatch_telemetry, '')) LIKE '%status: failed%'
)`;
export function countTrackerImportPendingDispatch(provider = "trakt") {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN sync_dispatch_telemetry IS NULL OR ${NOT_PENDING_TELEMETRY_SQL} THEN 1 ELSE 0 END) AS total,
       SUM(CASE WHEN (sync_dispatch_telemetry IS NULL
                       OR TRIM(sync_dispatch_telemetry) = ''
                       OR LOWER(sync_dispatch_telemetry) LIKE '%dispatch status: pending%'
                       OR (sync_next_retry_at > 0
                           AND COALESCE(sync_retry_count, 0) < ${TRAKT_IMPORT_SYNC_RETRY_MAX_ATTEMPTS}
                           AND ${TRAKT_IMPORT_REAL_FAILURE_TELEMETRY_SQL}))
                 AND (sync_dispatch_telemetry IS NULL OR ${NOT_PENDING_TELEMETRY_SQL})
            THEN 1 ELSE 0 END) AS pending
     FROM watch_history WHERE source = ?`,
  ).get(trackerImportSource(provider));
  return { total: row?.total || 0, pending: row?.pending || 0 };
}

// --- Movies / shows queries ------------------------------------------------
export { countMissingPosterTrackerRows as countMissingPosterTraktRows, listMissingPosterTrackerRows as listMissingPosterTraktRows, countTrackerImportPendingDispatch as countTraktImportPendingDispatch };
export async function queryMovies({ search = "", sort = "title_asc", limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Number(limit) || 100, 5000);
  const safeOffset = Number(offset) || 0;
  const movies = await getCachedMovieSummaries();
  const filtered = movies.filter((row) => titleContainsSearch(row.title, search));
  const sorted = sortRows(filtered, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

// Collapse a cluster of watch_history rows for one film into a single card:
// newest watched record as the base, every play date gathered into playHistory,
// and any missing id/poster backfilled from a sibling row.
function collapseMovieCluster(clusterRows = []) {
  const viewingRows = filterSameEventDuplicateRows(clusterRows);
  const playHistoryByDate = new Map();
  for (const row of viewingRows) {
    if (row.watched_at && !playHistoryByDate.has(row.watched_at)) {
      playHistoryByDate.set(row.watched_at, playHistoryEntry(row));
    }
  }
  const playHistory = [...playHistoryByDate.values()].sort((a, b) => String(a.watched_at).localeCompare(String(b.watched_at)));
  const newest = viewingRows
    .slice()
    .sort((a, b) => String(a.watched_at || "").localeCompare(String(b.watched_at || "")))
    .pop();
  const base = { ...(newest || clusterRows[0] || {}), playHistory };
  for (const row of clusterRows) {
    if (!base.imdb_id && row.imdb_id) base.imdb_id = row.imdb_id;
    if (!base.tmdb_id && row.tmdb_id) base.tmdb_id = row.tmdb_id;
    if (!base.tvdb_id && row.tvdb_id) base.tvdb_id = row.tvdb_id;
    if (!base.poster_url && row.poster_url) base.poster_url = row.poster_url;
  }
  if (!base.poster_url) {
    base.poster_url = getCanonicalPosterUrl({
      media_type: "movie",
      title: base.title,
      tmdb_id: base.tmdb_id,
      imdb_id: base.imdb_id,
    }) || null;
  }
  return base;
}

// Dedupe movies by clustering rows that refer to the same film. Rows are linked
// (union-find) when they share ANY external id (imdb/tmdb/tvdb) â€” this collapses
// records that carry different id subsets, e.g. one row with only tmdb and
// another with imdb+tmdb. Rows with no ids at all (e.g. plex_initial_sync title-
// only imports) fold into the unique id cluster sharing their canonical title;
// when two distinct films share a title (remakes), there is no unique target so
// the id-less row keeps its own cluster rather than guessing.
function movieGroupKeys(rows = []) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const idNodesFor = (row) => {
    const nodes = [];
    const imdb = cleanString(row.imdb_id); if (imdb) nodes.push(`imdb:${imdb}`);
    const tmdb = cleanString(row.tmdb_id); if (tmdb) nodes.push(`tmdb:${tmdb}`);
    const tvdb = cleanString(row.tvdb_id); if (tvdb) nodes.push(`tvdb:${tvdb}`);
    return nodes;
  };

  for (const row of rows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let i = 1; i < nodes.length; i += 1) union(nodes[0], nodes[i]);
  }

  const titleClusterKeys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const clusterKey = find(nodes[0]);
    const titleKey = canonicalTitleKey(row.title);
    if (titleKey) {
      if (!titleClusterKeys.has(titleKey)) titleClusterKeys.set(titleKey, new Set());
      titleClusterKeys.get(titleKey).add(clusterKey);
    }
  }

  const keys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (nodes.length) {
      keys.set(row, find(nodes[0]));
      continue;
    }
    const titleKey = canonicalTitleKey(row.title);
    const matches = titleClusterKeys.get(titleKey);
    keys.set(row, matches?.size === 1 ? [...matches][0] : `title:${titleKey || "unknown-movie"}`);
  }

  return keys;
}

function dedupeMovies(rows = []) {
  const groupKeys = movieGroupKeys(rows);
  const clusters = new Map();
  for (const row of rows) {
    const clusterKey = groupKeys.get(row);
    if (!clusters.has(clusterKey)) clusters.set(clusterKey, []);
    clusters.get(clusterKey).push(row);
  }

  return [...clusters.values()].map(collapseMovieCluster);
}

// Rows are linked (union-find) when they share ANY external id (imdb/tmdb/tvdb) -
// while single-use episode-level provider ids merge into the shared show series.
// When an established multi-episode show cluster exists, conflicting outlier rows
// (a single-row Trakt mismatch) and distinct multi-episode reboots keep their own
// cluster instead of being silently blended.
function showGroupKeys(rows = []) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const idNodesFor = (row) => {
    const nodes = [];
    const imdb = cleanString(row.show_imdb_id || row.imdb_id); if (imdb) nodes.push(`imdb:${imdb}`);
    const tmdb = cleanString(row.show_tmdb_id || row.tmdb_id); if (tmdb) nodes.push(`tmdb:${tmdb}`);
    const tvdb = cleanString(row.show_tvdb_id || row.tvdb_id); if (tvdb) nodes.push(`tvdb:${tvdb}`);
    return nodes;
  };

  for (const row of rows) {
    const nodes = idNodesFor(row);
    nodes.forEach(ensure);
    for (let i = 1; i < nodes.length; i += 1) union(nodes[0], nodes[i]);
  }

  const titleRoots = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    if (!titleRoots.has(titleKey)) titleRoots.set(titleKey, new Map());
    const counts = titleRoots.get(titleKey);
    const root = find(nodes[0]);
    counts.set(root, (counts.get(root) || 0) + 1);
  }

  // The fold below joins a lone row to its title's cluster (a single mismatched
  // Trakt row), but not one whose TMDB and TVDB ids both disagree and that
  // shares no id, the decision 34 rule: the 2001 Scrubs show's one watch
  // joined the reboot's cluster, took its IMDb id, and the Recently Watched
  // preview merged the two shows' S01E05 watches into one row.
  const rootIds = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const root = find(nodes[0]);
    if (!rootIds.has(root)) rootIds.set(root, new Set());
    for (const node of nodes) rootIds.get(root).add(node.toLowerCase());
  }
  const rootsConflict = (left, right) => {
    const leftIds = rootIds.get(left) || new Set();
    const rightIds = rootIds.get(right) || new Set();
    if ([...leftIds].some((node) => rightIds.has(node))) return false;
    return ["tmdb:", "tvdb:"].every((prefix) => [...leftIds].some((node) => node.startsWith(prefix))
      && [...rightIds].some((node) => node.startsWith(prefix)));
  };
  for (const [, counts] of titleRoots) {
    const roots = [...counts.keys()];
    const multiEpisodeRoots = roots.filter((r) => (counts.get(r) || 0) >= 2);
    if (multiEpisodeRoots.length <= 1 && roots.length > 1) {
      const target = multiEpisodeRoots[0] || roots[0];
      for (const root of roots) {
        if (root !== target && !rootsConflict(target, root)) union(target, root);
      }
    }
  }

  const titleClusterKeys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (!nodes.length) continue;
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    if (!titleClusterKeys.has(titleKey)) titleClusterKeys.set(titleKey, new Set());
    titleClusterKeys.get(titleKey).add(find(nodes[0]));
  }

  const keys = new Map();
  for (const row of rows) {
    const nodes = idNodesFor(row);
    if (nodes.length) {
      keys.set(row, find(nodes[0]));
      continue;
    }
    const title = showTitleFrom(row.show_title || row.title);
    const titleKey = canonicalTitleKey(title) || normalizeKeyPart(title);
    const matches = titleClusterKeys.get(titleKey);
    keys.set(row, matches?.size === 1 ? [...matches][0] : `title:${titleKey || "unknown-show"}`);
  }
  return keys;
}

// Classify retry candidates using the complete history as identity context.
// Rows describing one remote item share a dispatch group and must be serialized
// to preserve loop-detection semantics; distinct groups may run concurrently.
// Same-event subgroups retain the repository's existing chained ten-minute
// duplicate policy, but callers must not inherit outcomes for low-confidence
// title-only groups.
export function dispatchGroupsForRows(candidateRows = [], contextRows = candidateRows, windowMs = SAME_EVENT_WINDOW_MS) {
  const candidates = candidateRows.filter(Boolean);
  const context = contextRows.filter(Boolean);
  const episodeContext = context.filter((row) => normalizeMediaType(row.media_type) === "episode");
  const movieContext = context.filter((row) => normalizeMediaType(row.media_type) === "movie");
  const episodeKeys = showGroupKeys(episodeContext);
  const movieKeys = movieGroupKeys(movieContext);
  const groups = new Map();

  for (const row of candidates) {
    const type = normalizeMediaType(row.media_type);
    let identityKey;
    if (type === "episode") {
      const showKey = episodeKeys.get(row)
        || `title:${canonicalTitleKey(row.show_title || showTitleFrom(row.title)) || "unknown-show"}`;
      identityKey = `episode|${showKey}|s:${row.season ?? "unknown"}|e:${row.episode ?? "unknown"}`;
    } else if (type === "movie") {
      identityKey = `movie|${movieKeys.get(row) || `title:${canonicalTitleKey(row.title) || "unknown-movie"}`}`;
    } else {
      identityKey = `${type || "media"}|${mediaKeyFor(row)}`;
    }
    if (!groups.has(identityKey)) {
      groups.set(identityKey, {
        key: identityKey,
        confidence: identityKey.includes("|title:") ? "low" : "high",
        rows: [],
        sameEventGroups: [],
      });
    }
    groups.get(identityKey).rows.push(row);
  }

  for (const group of groups.values()) {
    const ordered = [...group.rows].sort((a, b) => (Date.parse(a.watched_at) || 0) - (Date.parse(b.watched_at) || 0));
    let event = [];
    let previous = null;
    for (const row of ordered) {
      const current = Date.parse(row.watched_at) || 0;
      if (event.length && current - previous > windowMs) {
        group.sameEventGroups.push(event);
        event = [];
      }
      event.push(row);
      previous = current;
    }
    if (event.length) group.sameEventGroups.push(event);
  }

  return [...groups.values()];
}

// Deterministic tie-break for callers that need a single show out of
// groupShowRows's results (queryShowDetail's title-only lookups have no
// provider id to disambiguate by) - most recently active first, rather than
// whichever cluster happened to form first.
function mostRecentShowFirst(shows = []) {
  return [...shows].sort((a, b) => {
    // A cluster with only a handful of watched episodes racing ahead of a far
    // larger, well-established one purely on recency is far more likely to be
    // a stray mismatched import (e.g. Trakt resolving an ambiguous title to
    // an unrelated show for one play) than a genuine distinct show sharing
    // the same title - prefer the substantially larger cluster in that case
    // rather than picking whichever was touched most recently.
    const aCount = Number(a.episode_count || 0);
    const bCount = Number(b.episode_count || 0);
    const larger = Math.max(aCount, bCount);
    const smaller = Math.min(aCount, bCount);
    const substantiallyLarger = larger >= 5 && larger >= smaller * 5;
    if (substantiallyLarger && aCount !== bCount) return bCount - aCount;
    return String(b.latest_watched_at || "").localeCompare(String(a.latest_watched_at || ""));
  });
}

export function groupShowRows(rows = []) {
  return [...collectShowGroups(rows).values()].map(finishShowGroup);
}

// The same result as groupShowRows, for cache builds that can run in the
// background. The per-show pass reads and parses cached metadata for every
// show (about 0.5 s on a real library), so it runs in short slices with the
// event loop free between them instead of stalling every other request.
export async function groupShowRowsYielding(rows = []) {
  await yieldToEventLoop();
  const groups = [...collectShowGroups(rows).values()];
  await yieldToEventLoop();
  const finished = [];
  let sliceStart = performance.now();
  for (const group of groups) {
    if (performance.now() - sliceStart >= REBUILD_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
    finished.push(finishShowGroup(group));
  }
  return finished;
}

function collectShowGroups(rows = []) {
  const groupKeys = showGroupKeys(rows);
  const groups = new Map();
  rows.forEach((row) => {
    const rawTitle = cleanString(row.show_title || showTitleFrom(row.title));
    const title = showTitleFrom(row.show_title || row.title);
    const key = groupKeys.get(row);
    const group = groups.get(key) || {
      title,
      raw_title: rawTitle,
      episode_count: 0,
      season_count: 0,
      latest_watched_at: "",
      earliest_watched_at: "",
      episodes: [],
      seasons: new Set(),
      representative_episode: null,
      poster_url: null,
      logo_url: null,
      backdrop_url: null,
      tmdb_id: null,
      tvdb_id: null,
      tmdbIdCounts: new Map(),
      imdbIdCounts: new Map(),
      tvdbIdCandidates: new Set(),
      tvdbIdsByTmdb: new Map(),
    };
    group.title = preferredShowTitle(group.title, title);
    group.episodes.push({ ...row, show_title: group.title });
    // Identity/artwork are watched-state agnostic - pull from any row so a
    // fully-unwatched show still has a poster and provider id.
    if (row.poster_url && !group.poster_url) {
      group.poster_url = row.poster_url;
    }
    if (row.logo_url && !group.logo_url) {
      group.logo_url = row.logo_url;
    }
    if (row.backdrop_url && !group.backdrop_url) {
      group.backdrop_url = row.backdrop_url;
    }
    if (row.tmdb_id) {
      const tmdb = String(row.tmdb_id);
      group.tmdbIdCounts.set(tmdb, (group.tmdbIdCounts.get(tmdb) || 0) + 1);
    }
    if (row.imdb_id) {
      const imdb = String(row.imdb_id);
      group.imdbIdCounts.set(imdb, (group.imdbIdCounts.get(imdb) || 0) + 1);
    }
    // Every distinct tvdb_id seen is only a *candidate* show identity here -
    // resolved for real (cachedShowTvdbId) below, since a row's tvdb_id is
    // often an episode-level id, not the show's.
    if (row.tvdb_id) {
      group.tvdbIdCandidates.add(String(row.tvdb_id));
      const tmdbKey = cleanString(row.tmdb_id);
      if (!group.tvdbIdsByTmdb.has(tmdbKey)) group.tvdbIdsByTmdb.set(tmdbKey, new Set());
      group.tvdbIdsByTmdb.get(tmdbKey).add(String(row.tvdb_id));
    }
    // Watched-progress aggregates (count, seasons, recency, representative
    // episode) only consider rows currently marked watched. Marking an
    // episode unwatched inserts a fresh row timestamped now - if that row
    // counted here, the show would look "just watched" (jumping to the top
    // of a Watched Newest sort) and its watched count would be inflated by
    // the very episode that was just removed from it.
    if (isWatchedAction(row)) {
      group.episode_count += 1;
      if (row.season != null) group.seasons.add(row.season);
      if (!group.latest_watched_at || row.watched_at > group.latest_watched_at) group.latest_watched_at = row.watched_at;
      if (!group.earliest_watched_at || row.watched_at < group.earliest_watched_at) group.earliest_watched_at = row.watched_at;
      if (!group.representative_episode || row.watched_at > group.representative_episode.watched_at) {
        group.representative_episode = { ...row, show_title: group.title };
      }
    }
    groups.set(key, group);
  });
  return groups;
}

function finishShowGroup(group) {
  const watchedEpisodes = group.episodes.filter(isWatchedAction);
  const totalWatches = watchedEpisodes.reduce((total, episode) => (
    total + (Array.isArray(episode.playHistory) && episode.playHistory.length ? episode.playHistory.length : 1)
  ), 0);
  const rewatchedEpisodeCount = watchedEpisodes.filter((episode) => (
    Array.isArray(episode.playHistory) && episode.playHistory.length > 1
  )).length;
  const topTmdbId = [...group.tmdbIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topImdbId = [...group.imdbIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // A lone same-title row can be folded into an established cluster (see
  // showGroupKeys). Its tvdb id belongs to its own TMDB show, so taking it
  // gave the group a mixed identity: the 2026 Scrubs reboot's TMDB/IMDb ids
  // plus the 2001 show's TVDB id, which Up Next then matched to both shows.
  // Only rows with no TMDB id or the group's TMDB id may supply the tvdb id.
  const tvdbCandidates = topTmdbId
    ? [...(group.tvdbIdsByTmdb.get(topTmdbId) || []), ...(group.tvdbIdsByTmdb.get("") || [])]
    : [...group.tvdbIdCandidates];
  const topTvdbId = cachedShowTvdbId(...tvdbCandidates) || null;
  const canonicalPosterUrl = getCanonicalPosterUrl({
    media_type: "tv",
    title: group.title,
    tmdb_id: topTmdbId || group.representative_episode?.tmdb_id || "",
    // Keep an unverified candidate available for artwork lookup. The
    // media-artwork resolver only accepts it when a cached TVDB/TMDB record
    // proves it is a series id, so episode-level ids remain harmless.
    tvdb_id: topTvdbId || tvdbCandidates[0] || "",
    imdb_id: topImdbId || group.representative_episode?.imdb_id || "",
  });
  return {
    ...group,
    season_count: group.seasons.size,
    seasons: undefined,
    total_watches: totalWatches,
    rewatched_episode_count: rewatchedEpisodeCount,
    // This is the show-level poster. Episode objects below retain their own
    // poster_url so episode-specific artwork is never replaced by the show
    // override.
    poster_url: canonicalPosterUrl || group.poster_url || group.representative_episode?.poster_url || null,
    show_poster_url: canonicalPosterUrl || null,
    canonical_poster_url: canonicalPosterUrl || null,
    logo_url: group.logo_url || group.representative_episode?.logo_url || null,
    backdrop_url: group.backdrop_url || group.representative_episode?.backdrop_url || null,
    tmdb_id: topTmdbId || group.representative_episode?.tmdb_id || null,
    imdb_id: topImdbId || group.representative_episode?.imdb_id || null,
    tvdb_id: topTvdbId,
    tvdbIdCandidates: undefined,
    tvdbIdsByTmdb: undefined,
    tmdbIdCounts: undefined,
    imdbIdCounts: undefined,
    representative_episode: group.representative_episode ? { ...group.representative_episode, show_title: group.title } : null,
    episodes: group.episodes
      .map((episode) => ({ ...episode, show_title: group.title }))
      .sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0)),
  };
}

async function getCachedHistoryArtworkIndex() {
  while (true) {
    const version = getDataVersion();
    if (historyArtworkCache.version === version) return historyArtworkCache;

    let pending = historyArtworkBuilds.get(version);
    if (!pending) {
      pending = timeCacheRebuildAsync("historyArtwork", version, dataVersionTrigger(version), async () => {
        const allEpisodeRows = (await getCachedHistory()).filter((row) => (
          row?.media_type === "episode" && isPlektTrackedEpisodeRow(row)
        ));
        const groups = await groupShowRowsYielding(dedupeHistory(allEpisodeRows));
        const byId = new Map();
        const byMediaKey = new Map();
        const byCoordinate = new Map();
        for (const group of groups) {
          for (const episode of group.episodes || []) {
            if (episode.id != null) byId.set(String(episode.id), group);
            if (episode.media_key) byMediaKey.set(String(episode.media_key), group);
            const titleKey = canonicalTitleKey(group.title || episode.show_title || showTitleFrom(episode.title));
            if (!titleKey || episode.season == null || episode.episode == null) continue;
            const coordinateKey = `${titleKey}|${episode.season}|${episode.episode}`;
            const existing = byCoordinate.get(coordinateKey);
            if (!existing) byCoordinate.set(coordinateKey, group);
            else if (existing !== group) byCoordinate.set(coordinateKey, null);
          }
        }
        return { version, byId, byMediaKey, byCoordinate };
      });
      historyArtworkBuilds.set(version, pending);
    }

    try {
      const index = await pending;
      // A write can land while the grouping work is yielding. Do not retain or
      // return an index built against an older generation.
      if (getDataVersion() === version) {
        historyArtworkCache = index;
        return index;
      }
    } finally {
      if (historyArtworkBuilds.get(version) === pending) historyArtworkBuilds.delete(version);
    }
  }
}

// History endpoints return episode rows rather than the grouped show objects
// used by the TV library. Attach the shared show artwork as a separate field
// so history cards can fall back to it without replacing an explicit episode
// still stored in poster_url. Matching by id/media key first keeps same-title
// reboots separate; the coordinate fallback covers duplicate watch rows that
// were deliberately left un-deduped for the History page.
async function enrichHistoryRowsWithShowArtwork(rows = []) {
  const input = Array.isArray(rows) ? rows : [];
  const movieEnriched = input.map((row) => {
    if (row?.media_type === "movie" && !row.poster_url) {
      const canonicalPoster = getCanonicalPosterUrl({
        media_type: "movie",
        title: row.title,
        tmdb_id: row.tmdb_id,
        imdb_id: row.imdb_id,
      });
      return canonicalPoster ? { ...row, poster_url: canonicalPoster } : row;
    }
    return row;
  });
  const episodeRows = movieEnriched.filter((row) => row?.media_type === "episode");
  if (!episodeRows.length) return movieEnriched;

  const { byId, byMediaKey, byCoordinate } = await getCachedHistoryArtworkIndex();
  const seasonPostersByGroup = new Map();

  return movieEnriched.map((row) => {
    if (row?.media_type !== "episode") return row;
    const titleKey = canonicalTitleKey(row.show_title || showTitleFrom(row.title));
    const coordinateKey = titleKey && row.season != null && row.episode != null
      ? `${titleKey}|${row.season}|${row.episode}`
      : "";
    const group = byId.get(String(row.id || ""))
      || (row.media_key ? byMediaKey.get(String(row.media_key)) : null)
      || (coordinateKey ? byCoordinate.get(coordinateKey) : null);
    if (!group) return row;
    const showPosterUrl = group.show_poster_url || group.poster_url || null;
    let seasonPosterUrl = row.season_poster_url || null;
    if (!seasonPosterUrl && row.season != null) {
      let seasonPosters = seasonPostersByGroup.get(group);
      if (!seasonPosters) {
        seasonPosters = getCanonicalSeasonPosterUrls({
          media_type: "tv",
          title: group.title,
          tmdb_id: group.tmdb_id,
          tvdb_id: group.tvdb_id,
          imdb_id: group.imdb_id,
        });
        seasonPostersByGroup.set(group, seasonPosters);
      }
      seasonPosterUrl = seasonPosters.get(Number(row.season)) || null;
    }
    return {
      ...row,
      season_poster_url: seasonPosterUrl,
      show_poster_url: row.show_poster_url || showPosterUrl,
      show_imdb_id: row.show_imdb_id || group.imdb_id || null,
      show_tmdb_id: row.show_tmdb_id || group.tmdb_id || null,
      show_tvdb_id: row.show_tvdb_id || group.tvdb_id || null,
    };
  });
}

function showSummaryIdentityKey(show = {}) {
  const tmdbId = cleanString(show.tmdb_id);
  if (tmdbId) return `tmdb:${tmdbId}`;
  const tvdbId = cleanString(show.tvdb_id);
  if (tvdbId) return `tvdb:${tvdbId}`;
  const imdbId = cleanString(show.imdb_id);
  if (imdbId) return `imdb:${imdbId.toLowerCase()}`;
  return canonicalTitleKey(show.title) || normalizeKeyPart(show.title) || "unknown-show";
}

function dedupeShowSummaries(shows = []) {
  const map = new Map();
  for (const show of shows) {
    const key = showSummaryIdentityKey(show);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, show);
      continue;
    }
    const latest = show.latest_watched_at || "";
    const existingLatest = existing.latest_watched_at || "";
    if (latest > existingLatest) {
      map.set(key, {
        ...existing,
        ...show,
        episode_count: Math.max(Number(existing.episode_count || 0), Number(show.episode_count || 0)),
        season_count: Math.max(Number(existing.season_count || 0), Number(show.season_count || 0)),
        total_watches: Math.max(Number(existing.total_watches || 0), Number(show.total_watches || 0)),
        rewatched_episode_count: Math.max(Number(existing.rewatched_episode_count || 0), Number(show.rewatched_episode_count || 0)),
      });
    }
  }
  return [...map.values()];
}

async function buildShowGroups(search = "") {
  const rows = dedupeHistory((await loadHistoryRowsByType({ mediaType: "episode", limit: MAX_HISTORY_LIMIT })).filter((row) => matchesSearch(row, search)));
  return groupShowRows(rows);
}

function compactEpisode(row = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title,
    media_type: row.media_type,
    watched_at: row.watched_at,
    source: row.source,
    imdb_id: row.imdb_id,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    season: row.season,
    episode: row.episode,
    poster_url: row.poster_url,
    sync_action: row.sync_action,
    sync_dispatch_telemetry: row.sync_dispatch_telemetry,
    media_key: row.media_key,
    show_title: row.show_title,
  };
}

export async function queryShows({ search = "", sort = "title_asc", limit = 6, offset = 0, hideWatched = false, hideEnded = false } = {}) {
  const safeLimit = Math.min(Number(limit) || 6, 5000);
  const safeOffset = Number(offset) || 0;

  const allShows = await getCachedShows();
  const nextAiringCache = await readNextAiringCache();
  const showsWithNextAiring = allShows.map((show) => {
    const cached = cachedNextAiringFor(nextAiringCache.entries, show.tmdb_id, show.title);
    if (!cached) return show;
    return {
      ...show,
      status: show.status || cached.status || "",
      next_airing_date: cached.nextAiringDate || "",
      next_airing_updated_at: cached.updatedAt || 0,
    };
  });
  const needle = cleanString(search).toLowerCase();
  const filtered = dedupeShowSummaries(showsWithNextAiring).filter((show) => {
    // The TV Shows page is a watched-history library, so a group with no
    // currently watched episodes has nothing to represent in this listing.
    // Keep those rows in getCachedShows/queryShowDetail: that preserves
    // canonical unwatch state and lets an already-open detail page refresh to
    // 0 watched without disappearing mid-action. Excluding them only at this
    // listing boundary also prevents metadata-less 0/? orphan groups from
    // producing title-only links that can resolve to an unrelated series.
    if (Number(show.episode_count || 0) <= 0) return false;
    if (needle && !titleContainsSearch(show.title, needle)) return false;
    if (hideWatched) {
      const isWatched = show.total_episodes > 0 && show.episode_count >= show.total_episodes;
      if (isWatched) return false;
    }
    if (hideEnded) {
      const isEnded = ["Ended", "Canceled"].includes(show.status);
      if (isEnded) return false;
    }
    return true;
  });
  const sorted = sortShowRows(filtered, sort);
  return sorted.slice(safeOffset, safeOffset + safeLimit);
}

// Reads and dedupes every tracked episode row. This is the shared prefix of
// queryShowDetail and does not depend on which show is being asked about, so a
// caller resolving many shows in one pass can compute it once and hand the same
// snapshot to each call instead of repeating a full-table read and dedupe per
// show. groupShowRows copies each row it keeps, so a shared snapshot is never
// mutated by the calls that consume it.
export function loadTrackedEpisodeRows() {
  return dedupeHistory(selectAllEpisodesStmt.all().map(rowToWatch).filter(isPlektTrackedEpisodeRow));
}

// Row positions by canonical show title and by each show id, built once per
// episode-row array. An Up Next build asks queryShowDetail about every show
// against one shared snapshot, and rescanning all rows per show (about 7,700
// rows on a real library) cost seconds per build (loose-ends step 1). Keyed by
// the array, so a snapshot's index lives only as long as the snapshot.
const episodeRowIndexes = new WeakMap();

function episodeRowIndex(rows) {
  let index = episodeRowIndexes.get(rows);
  if (index) return index;
  index = { title: new Map(), tmdb: new Map(), tvdb: new Map(), imdb: new Map() };
  const add = (map, key, position) => {
    if (!key) return;
    const positions = map.get(key);
    if (positions) positions.push(position);
    else map.set(key, [position]);
  };
  rows.forEach((row, position) => {
    add(index.title, canonicalTitleKey(showTitleFrom(row.show_title || row.title)), position);
    add(index.tmdb, String(row.show_tmdb_id || row.tmdb_id || ""), position);
    add(index.tvdb, String(row.show_tvdb_id || row.tvdb_id || ""), position);
    add(index.imdb, String(row.show_imdb_id || row.imdb_id || "").toLowerCase(), position);
  });
  episodeRowIndexes.set(rows, index);
  return index;
}

export async function queryShowDetail({ id = "", title = "", tmdbId = "", tvdbId = "", imdbId = "", episodeRows = null, displayNumbering = false } = {}) {
  const requestedId = cleanString(id);
  const requestedTmdbId = cleanString(tmdbId);
  const requestedTvdbId = cleanString(tvdbId);
  const requestedImdbId = cleanString(imdbId);
  const providerIdFromKey = requestedId.match(/^(tmdb|tvdb|imdb):(.+)$/i);
  const summaries = requestedId || requestedTmdbId || requestedTvdbId || requestedImdbId
    ? await getCachedShows()
    : [];
  const summary = summaries.find((show) => requestedId && String(show.id) === requestedId)
    || summaries.find((show) => (
      (requestedTmdbId && String(show.tmdb_id || "") === requestedTmdbId)
      || (requestedTvdbId && String(show.tvdb_id || "") === requestedTvdbId)
      || (requestedImdbId && String(show.imdb_id || "").toLowerCase() === requestedImdbId.toLowerCase())
      || (providerIdFromKey && String(show[`${providerIdFromKey[1].toLowerCase()}_id`] || "") === providerIdFromKey[2])
    ));
  const selectedTmdbId = requestedTmdbId || (providerIdFromKey?.[1].toLowerCase() === "tmdb" ? providerIdFromKey[2] : "") || cleanString(summary?.tmdb_id);
  const selectedTvdbId = requestedTvdbId || (providerIdFromKey?.[1].toLowerCase() === "tvdb" ? providerIdFromKey[2] : "") || cleanString(summary?.tvdb_id);
  const selectedImdbId = requestedImdbId || (providerIdFromKey?.[1].toLowerCase() === "imdb" ? providerIdFromKey[2] : "") || cleanString(summary?.imdb_id);
  const hasSelectedIdentity = Boolean(selectedTmdbId || selectedTvdbId || selectedImdbId);
  const requestedTitle = cleanString(title);
  let resolvedTitle = requestedTitle || cleanString(summary?.title);
  // Some legacy episode rows have no usable show_title; fall back to the
  // derived title even when the caller supplied a title.
  if (!resolvedTitle && requestedId && !hasSelectedIdentity) resolvedTitle = requestedId.replace(/-/g, " ");

  // A show's own episode rows can carry different exact show_title text over
  // time - Plex/Emby/Jellyfin's own title for a show is rarely year-suffixed
  // even when Plembfin's preferred display title is (or a Fix Match rename
  // only touched rows matching whichever text the anchor row happened to
  // have) - an exact show_title_lower match only ever sees whichever single
  // variant matches the query, silently missing the rest of the same show's
  // episodes (and, worse, can resolve a *different* variant to an entirely
  // unrelated show that happens to share that exact text). Normalize both
  // the query and every row's title the same way (showTitleFrom strips the
  // year) and scan by that canonical key instead, so every row for this show
  // is found regardless of which exact text it happens to carry.
  const key = resolvedTitle ? canonicalTitleKey(showTitleFrom(resolvedTitle)) : "";
  // Not loadHistoryRowsByType/isPlembfinTrackedWatchRow: a show whose every
  // episode is currently unwatched (e.g. right after "Mark unwatched" on its
  // last watched episode) still needs to resolve here with its real episode
  // rows (each carrying its own sync_action) - otherwise the show disappears
  // from lookup entirely instead of rendering as 0 watched. Untrusted scan
  // rows stay excluded via isPlembfinTrackedEpisodeRow.
  // Detail pages are the interactive source-of-truth surface. Read their
  // episode rows directly from SQLite instead of the process-wide full-history
  // cache: a manual watch can be committed and visible through /api/history
  // while another request still holds the previous aggregate generation,
  // making the button immediately revert despite the correct stored row.
  // A row matches on its canonical title or on any selected id, kept in the
  // snapshot's own order.
  const sourceRows = episodeRows || loadTrackedEpisodeRows();
  const rowIndex = episodeRowIndex(sourceRows);
  const positions = new Set(key ? rowIndex.title.get(key) : []);
  if (hasSelectedIdentity) {
    for (const [map, id] of [[rowIndex.tmdb, selectedTmdbId], [rowIndex.tvdb, selectedTvdbId], [rowIndex.imdb, selectedImdbId.toLowerCase()]]) {
      for (const position of (id && map.get(id)) || []) positions.add(position);
    }
  }
  const rows = [...positions].sort((a, b) => a - b).map((position) => sourceRows[position]);
  // A canonical-title match can still span two distinct real shows sharing a
  // title (a reboot/revival) now that groupShowRows splits them by provider
  // id instead of blending them - the most substantial (or, failing that,
  // most recently active) cluster is the more likely match for a lookup with
  // no id to disambiguate by.
  const candidateShows = groupShowRows(rows);
  const matchesSelectedIdentity = (candidate) => (
    (selectedTmdbId && String(candidate.tmdb_id || "") === selectedTmdbId)
    || (selectedTvdbId && String(candidate.tvdb_id || "") === selectedTvdbId)
    || (selectedImdbId && String(candidate.imdb_id || "").toLowerCase() === selectedImdbId.toLowerCase())
  );
  const [show] = hasSelectedIdentity
    ? [candidateShows.find(matchesSelectedIdentity)]
    : mostRecentShowFirst(candidateShows);
  if (show) {
    const showKey = canonicalTitleKey(show.title) || normalizeKeyPart(show.title);
    const rawShowKey = canonicalTitleKey(show.raw_title) || normalizeKeyPart(show.raw_title);
    const cachedProgress = getCachedShowProgress(showKey) || (rawShowKey !== showKey ? getCachedShowProgress(rawShowKey) : null);
    // show.tmdb_id trusted unconditionally - see the matching comment in
    // getCachedShows above.
    // When the caller supplied a TVDB identity, a TMDB id from the old title
    // cluster/progress cache is not authoritative: Fix Match deliberately
    // clears those row ids, but an already-warm cache can still contain the
    // previous same-title series. Prefer the TVDB-keyed metadata alias and do
    // not resurrect an unrelated cached TMDB id when that alias is absent.
    const tvdbCanonicalTmdbId = selectedTvdbId ? cachedTmdbShowIdForTvdb(selectedTvdbId) : "";
    show.tmdb_id = tvdbCanonicalTmdbId
      || (selectedTvdbId ? "" : cleanString(show.tmdb_id) || cachedShowTmdbId(cachedProgress?.tmdb_id, show.representative_episode?.tmdb_id))
      || null;
    show.total_episodes = cachedProgress?.total_episodes || 0;
    const canonicalPosterUrl = getCanonicalPosterUrl({
      media_type: "tv",
      title: show.title,
      tmdb_id: show.tmdb_id || "",
      tvdb_id: show.tvdb_id || "",
      imdb_id: show.imdb_id || "",
    });
    if (canonicalPosterUrl) {
      show.poster_url = canonicalPosterUrl;
      show.show_poster_url = canonicalPosterUrl;
      show.canonical_poster_url = canonicalPosterUrl;
    } else {
      show.show_poster_url = show.show_poster_url || null;
      show.canonical_poster_url = show.canonical_poster_url || null;
    }
    // Show page only: a Fix Match TVDB/TMDB choice places rows on the episode
    // they belong to in the chosen structure. Up Next stays cache-only and
    // keeps the stored numbers.
    if (displayNumbering) await annotateShowNumbering(show);
  }
  return show || null;
}

// Return the provider identities already established on this show's stored
// rows. Fix Match writes its chosen TVDB series id across those rows, making
// the most frequently stored value the durable local match even when a
// metadata cache cannot currently translate it.
export async function getKnownShowIdentityForTitle(title = "") {
  const key = canonicalTitleKey(showTitleFrom(title));
  if (!key) return { imdb_id: null, tmdb_id: null, tvdb_id: null };
  const rows = (await getCachedHistory()).filter((row) => (
    row.media_type === "episode"
    && canonicalTitleKey(showTitleFrom(row.show_title || row.title)) === key
  ));
  const mostCommon = (field) => {
    const counts = new Map();
    for (const row of rows) {
      const value = cleanString(row[field]);
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };
  return {
    imdb_id: mostCommon("imdb_id"),
    tmdb_id: mostCommon("tmdb_id"),
    tvdb_id: mostCommon("tvdb_id"),
  };
}

export async function listWatchRowsForReplay({ limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return loadHistoryRows({ limit: safeLimit, offset: Math.max(Number(offset) || 0, 0) });
}

function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    if (sort === "title_asc") return a.title.localeCompare(b.title) || b.watched_at.localeCompare(a.watched_at);
    if (sort === "title_desc") return b.title.localeCompare(a.title) || b.watched_at.localeCompare(a.watched_at);
    if (sort === "watched_asc") return a.watched_at.localeCompare(b.watched_at) || a.title.localeCompare(b.title);
    return b.watched_at.localeCompare(a.watched_at) || a.title.localeCompare(b.title);
  });
}

function sortShowRows(rows, sort) {
  return [...rows].sort((a, b) => {
    if (sort === "next_air_asc") {
      const dateA = a.next_airing_date || "";
      const dateB = b.next_airing_date || "";
      if (dateA && dateB) return dateA.localeCompare(dateB) || a.title.localeCompare(b.title);
      if (dateA) return -1;
      if (dateB) return 1;
      return a.title.localeCompare(b.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    }
    if (sort === "title_asc") return a.title.localeCompare(b.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    if (sort === "title_desc") return b.title.localeCompare(a.title) || b.latest_watched_at.localeCompare(a.latest_watched_at);
    if (sort === "watched_asc") return a.earliest_watched_at.localeCompare(b.earliest_watched_at) || a.title.localeCompare(b.title);
    return b.latest_watched_at.localeCompare(a.latest_watched_at) || a.title.localeCompare(b.title);
  });
}

export function watchRowToMedia(row = {}, source = "plex") {
  const provenance = normalizeWatchProvenance(row.watch_provenance || row.watchProvenance);
  return {
    title: row.title,
    showTitle: row.show_title || row.showTitle || undefined,
    type: row.media_type,
    source,
    itemId: provenance?.item_id || undefined,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    traktOverride: provenance?.provider_overrides?.trakt || undefined,
    posterUrl: row.poster_url || undefined,
    watched_at: row.watched_at || undefined,
    isValid: Boolean(row.title && ["movie", "episode", "tv"].includes(row.media_type)),
  };
}

// Build one outbound media object from a surviving row plus any deleted alias
// rows. A surviving title-only row must not discard provider IDs carried by a
// deleted IMDb/TMDB row: the replay needs those IDs to find the real library
// item on Plex, Emby, or Jellyfin.
export function watchRowsToMedia(rows = [], source = "manual") {
  const validRows = (rows || []).filter(Boolean);
  const primary = validRows[0] || {};
  const media = watchRowToMedia(primary, source);
  const ids = { ...media.ids };
  for (const row of validRows) {
    for (const field of ["imdb", "tmdb", "tvdb"]) {
      if (!ids[field] && row[`${field}_id`]) ids[field] = row[`${field}_id`];
    }
  }
  return {
    ...media,
    ids,
    watchRecordId: primary.id || undefined,
    watched_at: primary.watched_at || undefined,
  };
}

export function progressRowToMedia(row = {}, source = "plex") {
  return {
    ...watchRowToMedia(row, source),
    positionMs: Number(row.position_ms || 0),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    progress: playbackProgressPercent(row.position_ms, row.duration_ms, row.progress),
    updatedAt: Number(row.updated_at || 0),
  };
}

// --- TMDB helpers (pure; unchanged from the original) ----------------------
const TMDB_DAY_MS = 24 * 60 * 60 * 1000;
export const TMDB_DETAILS_SCHEMA_VERSION = 1;

export function tmdbCacheTtlMs(details) {
  switch (details?.status) {
    case "Returning Series":
    case "In Production":
    case "Post Production":
    case "Planned":
    case "Pilot":
      return TMDB_DAY_MS;
    case "Ended":
    case "Canceled":
    case "Released":
      return 30 * TMDB_DAY_MS;
    default:
      return 7 * TMDB_DAY_MS;
  }
}

export function mergeTmdbDetails(existing, fresh) {
  if (!existing || typeof existing !== "object") return fresh;
  if (!fresh || typeof fresh !== "object") return existing;
  return { ...existing, ...fresh };
}

export async function computeTvNextAiringDate(details, tmdbId) {
  try {
    if (!details || !tmdbId) return null;
    const today = new Date().toISOString().slice(0, 10);

    const direct = details.next_episode_to_air?.air_date;
    if (direct && direct >= today) return direct;

    const candidates = new Set();
    const lastSeason = details.last_episode_to_air?.season_number;
    if (Number.isInteger(lastSeason)) {
      candidates.add(lastSeason);
      candidates.add(lastSeason + 1);
    }
    const maxSeason = Math.max(0, ...(details.seasons || []).map((s) => Number(s.season_number) || 0));
    if (maxSeason > 0) candidates.add(maxSeason);

    let earliest = null;
    const seasonNums = [...candidates].filter((n) => n > 0).sort((a, b) => a - b);
    for (const n of seasonNums) {
      const season = await getTmdbSeason({ tmdbId, seasonNumber: n, showStatus: details.status }).catch(() => null);
      if (!season) continue;
      for (const ep of season.episodes || []) {
        const d = ep.air_date;
        if (d && d >= today && (!earliest || d < earliest)) earliest = d;
      }
    }
    return earliest;
  } catch (e) {
    console.error("Failed computing TV next airing date", e);
    return null;
  }
}

function movieProviderIdsFromTmdbDetails(details = {}) {
  return {
    imdb_id: cleanString(details.external_ids?.imdb_id),
    tmdb_id: cleanString(details.id || details.external_ids?.tmdb_id),
    tvdb_id: cleanString(details.external_ids?.tvdb_id),
  };
}

// TMDB is the metadata authority for movie identity in Plembfin. A media
// server can report a movie before its own agent has matched it, leaving the
// watch row with no ids (the exact shape that made Toy Story 5 skip Trakt).
// Fill only missing provider ids and preserve the row's current dispatch state:
// this is metadata enrichment, not a Fix Match action, so it must not create a
// fresh retry or turn a completed dispatch back into a queued one.
async function persistMovieProviderIds(recordId, record = {}, details = {}) {
  if (!recordId || String(record.media_type || "").toLowerCase() !== "movie") return null;
  const existing = selectByIdStmt.get(String(recordId));
  if (!existing) return null;

  const discovered = movieProviderIdsFromTmdbDetails(details);
  const fields = {};
  for (const field of ["imdb_id", "tmdb_id", "tvdb_id"]) {
    if (!cleanString(existing[field]) && discovered[field]) fields[field] = discovered[field];
  }
  if (!Object.keys(fields).length) return rowToWatch(existing);

  const result = await updateWatchRecord(String(recordId), fields, {
    preserveDispatchState: true,
    auditSource: "tmdb_metadata",
  });
  if (!result.ok) return null;

  for (const [field, value] of Object.entries(fields)) record[field] = value;
  const fresh = selectByIdStmt.get(String(recordId));
  if (fresh) {
    record.media_key = fresh.media_key;
    return rowToWatch(fresh);
  }
  return null;
}

async function prefetchTmdbMetadataBackground(mediaType, tmdbId, title, recordId = "", record = {}) {
  // Watch-record tests intentionally use synthetic titles and provider ids.
  // Their fire-and-forget enrichment must not open real TMDB/TVDB requests or
  // leave the Node test runner waiting on the gateway throttle after the
  // assertions have completed. Production processes never include --test;
  // the explicit env switch also lets isolated build/test harnesses opt out.
  const testRuntime = process.env.NODE_ENV === "test"
    || brandEnv("DISABLE_METADATA_PREFETCH") === "1"
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.execArgv.includes("--test")
    || process.argv.includes("--test");
  try {
    const lookupTitle = String(mediaType).toLowerCase() === "movie" ? title : showTitleFrom(title);
    const metadataRequest = {
      mediaType,
      tmdbId,
      title: lookupTitle,
      ids: {
        imdbId: record.imdb_id,
        tvdbId: record.tvdb_id,
      },
    };
    // Test workers may still need to hydrate provider ids from a deliberately
    // seeded metadata row. Keep that path synchronous and cache-only so the
    // test runtime never opens a real TMDB/TVDB request or leaves a throttle
    // timer behind.
    const details = testRuntime
      ? getCachedTmdbDetails(metadataRequest)
      : await getTmdbDetails({
        ...metadataRequest,
        // Automatic media-server imports should never trust a valid-but-wrong
        // TVDB id without checking it against the server's show title. Manual
        // title selections remain unchanged; they already represent an explicit
        // user choice.
        verifyTvdbTitle: ["plex", "emby", "jellyfin"].includes(String(record.source || "").toLowerCase()),
      });
    if (!details) return null;
    await persistMovieProviderIds(recordId, record, details).catch((error) => {
      console.error("Failed to persist TMDB movie ids", error);
    });
    if (record.media_type === "episode" && details?.cached_poster_url) {
      const savedShowArtwork = saveCanonicalPoster({
        media_type: "tv",
        title: details.name || lookupTitle || record.show_title || showTitleFrom(record.title),
        tmdb_id: details.id || details.external_ids?.tmdb_id || "",
        tvdb_id: details.external_ids?.tvdb_id || record.tvdb_id || "",
        imdb_id: details.external_ids?.imdb_id || record.imdb_id || "",
      }, details.cached_poster_url, { source: "metadata", preserveExisting: true });
      if (savedShowArtwork.changed) await invalidateHistoryDerivedCaches("prefetchTmdbMetadataBackground").catch(() => null);
    }
    // TV episode rows may carry episode-specific stills. The metadata cache
    // remains available to the shared show-poster resolver, but its series
    // poster must not overwrite the episode's own artwork at ingest time.
    if (recordId && record.media_type !== "episode" && details?.cached_poster_url) {
      await updateWatchPosterUrl(recordId, details.cached_poster_url).catch(() => null);
    }
    return details;
  } catch (e) {
    console.error("Failed to prefetch TMDB metadata in background", e);
    return null;
  }
}

// --- Episode series-identity repair ------------------------------------------
//
// Provider episode payloads sometimes contain the leaf episode ids where the
// rest of Plembfin expects the series ids. The repair below only promotes an id
// after it has appeared on two different episode coordinates for the same
// show. That proof is strong enough to repair old rows, but it deliberately
// refuses to guess between same-title reboots.

export function normalizeRepairShowTitle(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*\((?:19|20)\d\d\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function showTitleFromEpisodeTitle(value = "") {
  return String(value || "").replace(/\s*-\s*S\d+E\d+.*$/i, "");
}

export function seriesCoordinate(row = {}) {
  const season = Number(row.season);
  const episode = Number(row.episode);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

function seriesIdValue(row = {}, provider = "") {
  return cleanString(row[`${provider}_id`]);
}

function mergeSeriesProfile(target, source) {
  for (const entry of source.entries) target.entries.push(entry);
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const ids = new Map(target.idCounts[provider]);
    for (const [id, coordinates] of source.idCounts[provider]) {
      const existing = ids.get(id) || new Set();
      for (const coordinate of coordinates) existing.add(coordinate);
      ids.set(id, existing);
    }
    target.idCounts[provider] = ids;
  }
}

function buildSeriesIdentityProfiles() {
  const rows = db.prepare(
    "SELECT title, show_title, season, episode, imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE media_type = 'episode'",
  ).all();
  const byShow = new Map();
  for (const row of rows) {
    const showKey = normalizeRepairShowTitle(row.show_title || showTitleFromEpisodeTitle(row.title));
    const coordinate = seriesCoordinate(row);
    if (!showKey || !coordinate) continue;
    if (!byShow.has(showKey)) byShow.set(showKey, []);
    byShow.get(showKey).push({ row, showKey, coordinate });
  }

  const result = new Map();
  for (const [showKey, entries] of byShow) {
    const globalIdCounts = new Map();
    for (const entry of entries) {
      for (const provider of ["imdb", "tmdb", "tvdb"]) {
        const id = seriesIdValue(entry.row, provider);
        if (!id) continue;
        const key = `${provider}:${id.toLowerCase()}`;
        if (!globalIdCounts.has(key)) globalIdCounts.set(key, new Set());
        globalIdCounts.get(key).add(entry.coordinate);
      }
    }

    const profiles = [];
    for (const entry of entries) {
      const provenIds = ["imdb", "tmdb", "tvdb"]
        .map((provider) => {
          const id = seriesIdValue(entry.row, provider);
          const count = id ? globalIdCounts.get(`${provider}:${id.toLowerCase()}`)?.size || 0 : 0;
          return count > 1 ? { provider, id } : null;
        })
        .filter(Boolean);
      if (!provenIds.length) continue;

      const matching = profiles.filter((profile) => provenIds.some(({ provider, id }) => (
        profile.idCounts[provider].has(id)
      )));
      const profile = matching[0] || {
        entries: [],
        idCounts: { imdb: new Map(), tmdb: new Map(), tvdb: new Map() },
      };
      for (const other of matching.slice(1)) {
        mergeSeriesProfile(profile, other);
        const index = profiles.indexOf(other);
        if (index >= 0) profiles.splice(index, 1);
      }
      for (const { provider, id } of provenIds) {
        const coordinates = profile.idCounts[provider].get(id) || new Set();
        coordinates.add(entry.coordinate);
        profile.idCounts[provider].set(id, coordinates);
      }
      profile.entries.push(entry);
      if (!profiles.includes(profile)) profiles.push(profile);
    }

    const shaped = profiles.map((profile) => {
      const ids = {};
      for (const provider of ["imdb", "tmdb", "tvdb"]) {
        const candidates = [...profile.idCounts[provider].entries()]
          .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]));
        if (candidates.length && (candidates.length === 1 || candidates[0][1].size > candidates[1][1].size)) {
          ids[provider] = candidates[0][0];
        } else {
          ids[provider] = "";
        }
      }
      return {
        ids: { imdb: ids.imdb || "", tmdb: ids.tmdb || "", tvdb: ids.tvdb || "" },
        entries: profile.entries,
      };
    }).filter((profile) => Object.values(profile.ids).some(Boolean));
    if (shaped.length) result.set(showKey, shaped);
  }
  return result;
}

const SERIES_IDS_CACHE_TTL_MS = 60_000;
let seriesIdentityIndexCache = { expiresAt: 0, values: new Map() };
const IDENTITY_REPAIR_BATCH_SIZE = 100;
const IDENTITY_REPAIR_YIELD_EVERY = 100;

// True when stored history proves two or more shows share this title, so a
// title-and-coordinate match would be ambiguous. Built fresh, not from the
// 60 s index cache: it guards one explicit user action.
export function showTitleNamesSeveralShows(showTitle = "") {
  const key = normalizeRepairShowTitle(showTitle);
  if (!key) return false;
  return (buildSeriesIdentityProfiles().get(key) || []).length > 1;
}

export function seriesIdentityProfilesForShowTitle(showTitle = "") {
  const key = normalizeRepairShowTitle(showTitle);
  if (!key) return [];
  if (seriesIdentityIndexCache.expiresAt <= Date.now()) {
    seriesIdentityIndexCache = {
      expiresAt: Date.now() + SERIES_IDS_CACHE_TTL_MS,
      values: buildSeriesIdentityProfiles(),
    };
  }
  return seriesIdentityIndexCache.values.get(key) || [];
}

function progressProfileForIds(ids = {}, profiles = []) {
  const matches = profiles.filter((profile) => ["imdb", "tmdb", "tvdb"].some((provider) => (
    ids[provider] && profile.ids[provider] && ids[provider].toLowerCase() === profile.ids[provider].toLowerCase()
  )));
  return matches.length === 1 ? matches[0] : null;
}

// True when ids carry their own series-level resolution (TMDB/TVDB) that shares
// no id with the title's sole proven profile. Such a row keeps its identity
// instead of being folded onto that profile; see docs/decisions.md entry 34.
function disagreesWithSoleProfile(ids = {}, profile = null) {
  if (!profile || !(ids.tmdb || ids.tvdb)) return false;
  return !["imdb", "tmdb", "tvdb"].some((provider) => (
    ids[provider] && profile.ids[provider] && ids[provider].toLowerCase() === profile.ids[provider].toLowerCase()
  ));
}

// Two episode records under one show title describe different shows when their
// ids resolve to two different proven series profiles for that title ("Scrubs -
// S01E04" is both the 2001 show and the 2026 reboot), or when one matches the
// sole profile and the other disagrees with it (entry 34). Title and coordinate
// alias matching must not cross them: a clear or watch of one show wrote the
// other's playstate and deleted its history rows. When neither side resolves to
// a proven profile (a show watched only once has none), two records whose
// TMDB and TVDB ids both disagree and that share no id are two shows as well:
// a UK "The Assembly" unwatch otherwise superseded the Australian show's only
// watch. Missing ids, a single mismatched id, or an IMDb-only disagreement
// (the id providers leak from the episode) never split, so rematch aliases
// still converge.
function episodeRecordsNameDifferentShows(showTitle = "", leftIds = {}, rightIds = {}) {
  const profiles = seriesIdentityProfilesForShowTitle(showTitle);
  const left = progressProfileForIds(leftIds, profiles);
  const right = progressProfileForIds(rightIds, profiles);
  if (!left && !right) return unprovenSeriesIdsConflict(leftIds, rightIds);
  if (profiles.length === 1) {
    const [profile] = profiles;
    return Boolean((left && disagreesWithSoleProfile(rightIds, profile))
      || (right && disagreesWithSoleProfile(leftIds, profile)));
  }
  return Boolean(left && right && left !== right);
}

// Both sides must carry a full TMDB and TVDB series identity that disagrees on
// each: a row with one mismatched id (a wrong library match) still converges.
function unprovenSeriesIdsConflict(leftIds = {}, rightIds = {}) {
  const same = (provider) => leftIds[provider] && rightIds[provider]
    && leftIds[provider].toLowerCase() === rightIds[provider].toLowerCase();
  if (["imdb", "tmdb", "tvdb"].some(same)) return false;
  return ["tmdb", "tvdb"].every((provider) => leftIds[provider] && rightIds[provider]);
}

function mediaIdsForShowMatch(media = {}) {
  const ids = media.ids || {};
  return {
    imdb: cleanString(media.imdb_id || ids.imdb),
    tmdb: cleanString(media.tmdb_id || ids.tmdb),
    tvdb: cleanString(media.tvdb_id || ids.tvdb),
  };
}

function seriesIdsForRow(row = {}, profiles = []) {
  const ids = progressProviderIds(row);
  if (profiles.length === 1) return disagreesWithSoleProfile(ids, profiles[0]) ? null : profiles[0].ids;
  return progressProfileForIds(ids, profiles)?.ids || null;
}

function sameProgressGroupRows(rows = [], profiles = []) {
  if (!rows.length) return [];
  const groups = [];
  for (const row of rows) {
    const rowIds = progressProviderIds(row);
    const profile = progressProfileForIds(rowIds, profiles);
    const disagrees = profiles.length === 1 && disagreesWithSoleProfile(rowIds, profiles[0]);
    let group = profile ? groups.find((candidate) => candidate.profile === profile) : null;
    if (!group && !profile && disagrees) {
      group = groups.find((candidate) => candidate.disagrees && candidate.rows.some((other) => (
        ["tmdb", "tvdb"].some((provider) => rowIds[provider] && progressProviderIds(other)[provider] === rowIds[provider])
      )));
      if (!group) {
        group = { profile: null, disagrees: true, rows: [] };
        groups.push(group);
      }
    }
    if (!group && !profile && profiles.length === 1) {
      // A title with one proven series identity is safe to repair even when
      // every stored progress row contains only an episode-level id.
      group = groups.find((candidate) => candidate.profile === profiles[0]);
      if (!group) {
        group = { profile: profiles[0], rows: [] };
        groups.push(group);
      }
    }
    if (!group) {
      group = { profile: profile || null, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  if (profiles.length === 1) {
    const identified = groups.find((group) => group.profile === profiles[0]);
    const unresolved = groups.filter((group) => !group.profile && !group.disagrees);
    if (identified && unresolved.length) {
      for (const group of unresolved) identified.rows.push(...group.rows);
      return groups.filter((group) => !unresolved.includes(group));
    }
  }
  return groups;
}

export function invalidateSeriesIdentityIndex() {
  seriesIdentityIndexCache = { expiresAt: 0, values: new Map() };
}

export async function repairEpisodeSeriesIdentity() {
  invalidateSeriesIdentityIndex();
  const profilesByShow = new Map();
  const historyRows = db.prepare(
    "SELECT id, media_key, title, show_title, season, episode, imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE media_type = 'episode'",
  ).all();
  for (let index = 0; index < historyRows.length; index += 1) {
    const row = historyRows[index];
    const key = normalizeRepairShowTitle(row.show_title || showTitleFromEpisodeTitle(row.title));
    if (key && !profilesByShow.has(key)) profilesByShow.set(key, seriesIdentityProfilesForShowTitle(key));
    if ((index + 1) % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const historyUpdateStmt = db.prepare(
    "UPDATE watch_history SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ?, updated_at = ? WHERE id = ?",
  );
  const progressUpdateStmt = db.prepare(
    "UPDATE playback_progress SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ? WHERE media_key = ?",
  );
  const progressDeleteStmt = db.prepare("DELETE FROM playback_progress WHERE media_key = ?");
  const progressRows = db.prepare(
    "SELECT * FROM playback_progress WHERE media_type = 'episode' ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC",
  ).all();
  await yieldToEventLoop();
  const now = Date.now();
  const historyRepairs = [];
  for (let index = 0; index < historyRows.length; index += 1) {
    const row = historyRows[index];
    const key = normalizeRepairShowTitle(row.show_title || showTitleFromEpisodeTitle(row.title));
    const ids = seriesIdsForRow(row, profilesByShow.get(key) || []);
    if (ids) {
      const nextKey = mediaKeyFor({ ...row, media_type: "episode", ...ids, imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb });
      if (!(row.imdb_id === (ids.imdb || null) && row.tmdb_id === (ids.tmdb || null)
        && row.tvdb_id === (ids.tvdb || null) && row.media_key === nextKey)) {
        historyRepairs.push({
          ids,
          nextKey,
          id: row.id,
        });
      }
    }
    if ((index + 1) % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const buckets = new Map();
  for (let index = 0; index < progressRows.length; index += 1) {
    const row = progressRows[index];
    const key = `${normalizeRepairShowTitle(progressShowTitle(row))}|${seriesCoordinate(row)}`;
    if (!key.startsWith("|")) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    if ((index + 1) % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const progressRepairs = [];
  let progressDuplicatesRemoved = 0;
  for (const rows of buckets.values()) {
    const showKey = normalizeRepairShowTitle(progressShowTitle(rows[0]));
    const profiles = profilesByShow.get(showKey) || [];
    const groups = sameProgressGroupRows(rows, profiles);
    for (const group of groups) {
      if (!group.profile?.ids) continue;
      const winner = group.rows.slice().sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))[0];
      const ids = profileIdsFilledFromRecord(group.profile.ids, progressProviderIds(winner));
      const nextKey = mediaKeyFor({ ...winner, media_type: "episode", imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb });
      const deleteKeys = group.rows
        .filter((row) => row.media_key !== winner.media_key)
        .map((row) => row.media_key);
      progressDuplicatesRemoved += deleteKeys.length;
      const idsChanged = ["imdb", "tmdb", "tvdb"].some((provider) => (
        cleanString(winner[`${provider}_id`]) !== cleanString(ids[provider])
      ));
      const shouldUpdate = winner.media_key !== nextKey || idsChanged;
      progressRepairs.push({
        deleteKeys,
        deleteNextKey: shouldUpdate && nextKey !== winner.media_key ? nextKey : "",
        update: shouldUpdate ? {
          imdb: ids.imdb || null,
          tmdb: ids.tmdb || null,
          tvdb: ids.tvdb || null,
          nextKey,
          previousKey: winner.media_key,
        } : null,
      });
    }
    if (progressRepairs.length > 0 && progressRepairs.length % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  for (let offset = 0; offset < historyRepairs.length; offset += IDENTITY_REPAIR_BATCH_SIZE) {
    const batch = historyRepairs.slice(offset, offset + IDENTITY_REPAIR_BATCH_SIZE);
    transaction(() => {
      for (const repair of batch) {
        historyUpdateStmt.run(repair.ids.imdb || null, repair.ids.tmdb || null, repair.ids.tvdb || null, repair.nextKey, now, repair.id);
      }
    });
    await yieldToEventLoop();
  }

  for (let offset = 0; offset < progressRepairs.length; offset += IDENTITY_REPAIR_BATCH_SIZE) {
    const batch = progressRepairs.slice(offset, offset + IDENTITY_REPAIR_BATCH_SIZE);
    transaction(() => {
      for (const repair of batch) {
        for (const key of repair.deleteKeys) progressDeleteStmt.run(key);
        if (repair.deleteNextKey) progressDeleteStmt.run(repair.deleteNextKey);
        if (repair.update) {
          progressUpdateStmt.run(
            repair.update.imdb,
            repair.update.tmdb,
            repair.update.tvdb,
            repair.update.nextKey,
            repair.update.previousKey,
          );
        }
      }
    });
    await yieldToEventLoop();
  }

  const historyFixed = historyRepairs.length;
  const progressFixed = progressRepairs.filter((repair) => repair.update).length;

  invalidateSeriesIdentityIndex();
  if (historyFixed || progressFixed || progressDuplicatesRemoved) {
    await invalidateHistoryDerivedCaches("repairEpisodeSeriesIdentity");
    console.log(
      `[dataRepo] repairEpisodeSeriesIdentity: repaired ${historyFixed} watch record(s), rekeyed ${progressFixed} resume position(s), removed ${progressDuplicatesRemoved} duplicate resume alias(es)`,
    );
  }
  return historyFixed + progressFixed + progressDuplicatesRemoved;
}

// Read-side identity lookup used by artwork and progress routes. It returns an
// id set only when the title maps to one proven series; ambiguous same-title
// reboots intentionally fall back to title/provider artwork resolution.
export function seriesIdsForShowTitle(showTitle) {
  const rawTitle = cleanString(showTitle);
  const resolvedTitle = /\s+-\s+S\d{1,3}E\d{1,3}(?:\s+-\s+.*)?$/i.test(rawTitle)
    ? showTitleFrom(rawTitle)
    : rawTitle;
  const profiles = seriesIdentityProfilesForShowTitle(resolvedTitle);
  return profiles.length === 1 ? { ...profiles[0].ids } : null;
}

// The series ids an episode media object should carry, by the rule the
// scheduled repair applies to history (seriesIdsForRow): the title's proven
// profile, unless the object's own TMDB/TVDB ids disagree with a sole profile
// (decision 34). Null when no profile applies.
export function seriesIdsForEpisodeMedia(media = {}) {
  if (normalizeMediaType(media.media_type || media.mediaType || media.type) !== "episode") return null;
  const showTitle = media.show_title || media.showTitle || showTitleFromEpisodeTitle(media.title);
  const profiles = seriesIdentityProfilesForShowTitle(showTitle);
  const ids = mediaIdsForShowMatch(media);
  const profileIds = seriesIdsForRow({ imdb_id: ids.imdb, tmdb_id: ids.tmdb, tvdb_id: ids.tvdb }, profiles);
  return profileIds ? profileIdsFilledFromRecord(profileIds, ids) : null;
}

export function idsShareAny(left = {}, right = {}) {
  return ["imdb", "tmdb", "tvdb"].some((provider) => (
    left[provider] && right[provider] && left[provider].toLowerCase() === right[provider].toLowerCase()
  ));
}

// The one proven profile an episode-id playstate row belongs to, or null.
// Every IMDb/TVDB id on the row must have a cached TMDB `find` answer; the ids
// must resolve as episodes (a `tv_results` hit means the row really is keyed
// on a series), all of the same show, at the row's own coordinate, and that
// show's TMDB id must belong to exactly one proven profile for the title.
//
// Tier 2, for rows tier 1 cannot prove (TMDB `find` empty, a TMDB coordinate
// that differs from TVDB aired order, or a profile with no TMDB id): the row's
// TVDB id, looked up as a TVDB episode, must name exactly one profile's TVDB
// series id at the row's coordinate. It is consulted only once every TMDB
// answer is cached, never overrides a `series` answer, and never accepts a
// TMDB episode answer that names another show than the profile's TMDB id.
export function provenPlaystateAliasProfile(row, profiles, { findCached, tvdbCached, pendingLookups, pendingTvdbLookups }) {
  const answers = [];
  let missing = false;
  for (const [provider, source] of [["imdb", "imdb_id"], ["tvdb", "tvdb_id"]]) {
    const id = cleanString(row[`${provider}_id`]);
    if (!id) continue;
    const answer = findCached(source, id);
    if (answer) {
      answers.push(answer);
    } else {
      missing = true;
      pendingLookups.set(`${source}:${id.toLowerCase()}`, { source, id });
    }
  }
  if (missing || answers.some((answer) => answer.kind === "series")) return null;
  const episodes = answers.filter((answer) => answer.kind === "episode");
  const season = Number(row.season);
  const episode = Number(row.episode);
  const showIds = new Set(episodes.map((answer) => String(answer.showId || "")));
  if (episodes.length && showIds.size === 1
    && episodes.every((answer) => Number(answer.season) === season && Number(answer.episode) === episode)) {
    const [showId] = showIds;
    const matches = profiles.filter((profile) => profile.ids.tmdb && String(profile.ids.tmdb) === showId);
    if (matches.length === 1) return matches[0];
    if (!matches.length) {
      const bridged = bridgedPlaystateAliasProfile(showId, profiles, { findCached, pendingLookups });
      if (bridged) return bridged;
    }
  }

  const tvdbId = cleanString(row.tvdb_id);
  if (!tvdbId) return null;
  const tvdbAnswer = tvdbCached(tvdbId);
  if (!tvdbAnswer) {
    pendingTvdbLookups.set(tvdbId, { id: tvdbId });
    return null;
  }
  if (tvdbAnswer.kind !== "episode") return null;
  if (Number(tvdbAnswer.season) !== season || Number(tvdbAnswer.episode) !== episode) return null;
  const matches = profiles.filter((profile) => profile.ids.tvdb && String(profile.ids.tvdb) === String(tvdbAnswer.seriesId));
  if (matches.length !== 1) return null;
  const [profile] = matches;
  if (profile.ids.tmdb && episodes.some((answer) => String(answer.showId || "") !== String(profile.ids.tmdb))) return null;
  return profile;
}

// Tier 3, the profile id bridge: when TMDB names a show no profile's TMDB id
// matches, a profile with no TMDB id is that show when one of its own IMDb/TVDB
// series ids resolves under `tv_results` to the same show and none resolves to
// anything else. Exactly one profile must bridge, and every candidate's ids
// must be cached (uncached ones are queued). A profile that carries a TMDB id
// is never bridged: one that disagrees with `find` (the Kin case) is the user's
// call, not a proof.
function bridgedPlaystateAliasProfile(showId, profiles, { findCached, pendingLookups }) {
  let pending = false;
  const bridged = [];
  for (const profile of profiles) {
    if (profile.ids.tmdb) continue;
    const answers = [];
    for (const [provider, source] of [["imdb", "imdb_id"], ["tvdb", "tvdb_id"]]) {
      const id = cleanString(profile.ids[provider]);
      if (!id) continue;
      const answer = findCached(source, id);
      if (answer) {
        answers.push(answer);
      } else {
        pending = true;
        pendingLookups.set(`${source}:${id.toLowerCase()}`, { source, id });
      }
    }
    const sameShow = (answer) => answer.kind === "series" && String(answer.showId || "") === showId;
    if (answers.some(sameShow) && answers.every((answer) => answer.kind === "none" || sameShow(answer))) {
      bridged.push(profile);
    }
  }
  return !pending && bridged.length === 1 ? bridged[0] : null;
}

// Episode playstate rows keyed on the episode's own ids instead of its show's
// (plan/active/playstate-episode-id-repair/plan.md). Decision 34 rightly stops the local
// repair from folding them, so each alias is proven by an exact TMDB `find`
// lookup of its own ids (bridged by the profile's own ids when the profile has
// no TMDB id, tier 3), or failing that a TVDB episode lookup (tier 2), read
// from the gateway caches only (no outbound call; uncached ids are returned
// for the background lookup job). A proven alias is
// deleted when the show-keyed row is at least as new or agrees with it, and
// rekeyed onto the show when no show-keyed row exists. A newer alias whose
// state conflicts is never auto-resolved; it is returned for the user.
export async function repairPlaystateEpisodeIdAliases({
  findCached = getCachedTmdbExternalIdKind,
  tvdbCached = getCachedTvdbEpisodeKind,
  skipKeys = new Set(), // rows the user marked "Different show" (playstateAliasReview.js)
} = {}) {
  invalidateSeriesIdentityIndex();
  const rows = db.prepare("SELECT * FROM playstate WHERE media_type = 'episode'").all().filter((row) => !skipKeys.has(row.media_key));
  const byShowCoordinate = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const showKey = normalizeRepairShowTitle(showTitleFromEpisodeTitle(row.title));
    const coordinate = seriesCoordinate(row);
    if (showKey && coordinate) {
      const key = `${showKey}|${coordinate}`;
      if (!byShowCoordinate.has(key)) byShowCoordinate.set(key, { showKey, rows: [] });
      byShowCoordinate.get(key).rows.push(row);
    }
    if ((index + 1) % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const pendingLookups = new Map();
  const pendingTvdbLookups = new Map();
  const proof = { findCached, tvdbCached, pendingLookups, pendingTvdbLookups };
  const conflicts = [];
  const deleteKeys = [];
  const rekeys = [];
  // A rekey never lands on a key another row (another title spelling, a
  // dismissed row) already holds; such a row is left for the next pass.
  const takenKeys = new Set(db.prepare("SELECT media_key FROM playstate").pluck().all());
  let groupIndex = 0;
  for (const { showKey, rows: group } of byShowCoordinate.values()) {
    groupIndex += 1;
    if (groupIndex % IDENTITY_REPAIR_YIELD_EVERY === 0) await yieldToEventLoop();
    const profiles = seriesIdentityProfilesForShowTitle(showKey);
    if (!profiles.length) continue;
    const aliasesByProfile = new Map();
    for (const row of group) {
      const rowIds = progressProviderIds(row);
      if (profiles.some((profile) => idsShareAny(rowIds, profile.ids))) continue;
      // An id-less `episode:S:E:title:` row (phase 5 step 2) is proven by its
      // title alone when the title has exactly one profile; with several
      // (Scrubs and Scrubs (2026)) it is left for the Maintenance card.
      const idless = !rowIds.imdb && !rowIds.tmdb && !rowIds.tvdb;
      const profile = idless
        ? (profiles.length === 1 ? profiles[0] : null)
        : provenPlaystateAliasProfile(row, profiles, proof);
      if (!profile) continue;
      if (!aliasesByProfile.has(profile)) aliasesByProfile.set(profile, []);
      aliasesByProfile.get(profile).push(row);
    }
    for (const [profile, aliases] of aliasesByProfile) {
      const seriesKey = mediaKeyFor({
        media_type: "episode",
        season: aliases[0].season,
        episode: aliases[0].episode,
        imdb_id: profile.ids.imdb,
        tmdb_id: profile.ids.tmdb,
        tvdb_id: profile.ids.tvdb,
      });
      const siblings = group.filter((row) => idsShareAny(progressProviderIds(row), profile.ids));
      const ordered = aliases.slice().sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0));
      let series = siblings.find((row) => row.media_key === seriesKey) || newestByUpdatedAt(siblings);
      if (!series) {
        if (takenKeys.has(seriesKey)) continue;
        takenKeys.add(seriesKey);
        series = ordered.shift();
        rekeys.push({ previousKey: series.media_key, nextKey: seriesKey, ids: profile.ids });
      }
      for (const alias of ordered) {
        if (Number(alias.updated_at || 0) <= Number(series.updated_at || 0) || alias.state === series.state) {
          deleteKeys.push(alias.media_key);
        } else {
          conflicts.push({
            title: alias.title,
            aliasKey: alias.media_key,
            aliasState: alias.state,
            aliasUpdatedAt: Number(alias.updated_at || 0),
            seriesKey: series.media_key,
            seriesState: series.state,
            seriesUpdatedAt: Number(series.updated_at || 0),
          });
        }
      }
    }
  }

  if (deleteKeys.length || rekeys.length) {
    const deleteStmt = db.prepare("DELETE FROM playstate WHERE media_key = ?");
    const rekeyStmt = db.prepare("UPDATE playstate SET media_key = ?, imdb_id = ?, tmdb_id = ?, tvdb_id = ? WHERE media_key = ?");
    transaction(() => {
      for (const key of deleteKeys) deleteStmt.run(key);
      for (const rekey of rekeys) {
        rekeyStmt.run(rekey.nextKey, rekey.ids.imdb || null, rekey.ids.tmdb || null, rekey.ids.tvdb || null, rekey.previousKey);
      }
    });
    await invalidateHistoryDerivedCaches("repairPlaystateEpisodeIdAliases");
    console.log(
      `[dataRepo] repairPlaystateEpisodeIdAliases: removed ${deleteKeys.length} episode-id or title-keyed playstate alias(es), rekeyed ${rekeys.length}; ${conflicts.length} conflicting alias(es) left for review`,
    );
  }
  invalidateSeriesIdentityIndex();
  return {
    deleted: deleteKeys.length,
    rekeyed: rekeys.length,
    conflicts,
    pendingLookups: [...pendingLookups.values()],
    pendingTvdbLookups: [...pendingTvdbLookups.values()],
  };
}
