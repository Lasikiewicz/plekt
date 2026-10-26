import crypto from "node:crypto";
import { bumpDiscoverVersion, db, parseJson, toJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";
import { cacheBackdropFromUrl, cacheLogoFromUrl, cachePosterFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "./posterCache.js";
import { getFanartMovieArt, getFanartTvArt } from "./fanartGateway.js";
import { RELATED_TV_SEARCH_MISS_TTL_MS, resolveTvdbSeriesId, resolveTvdbSeriesIdFromEpisodeId, getTvdbSeriesExtended, getTvdbEnglishSeriesOverview, getTvdbSeasonEpisodes, getCachedTvdbSeasonEpisodes, shapeTvdbSeriesAsTmdb, tvdbSeriesTitleMatches } from "./tvdbGateway.js";
import { isDemoMode } from "./demoMode.js";
import { readShowNumbering, resolveAndRecordSeasonSource } from "./seasonSource.js";
import { buildEpisodeNumberMap, translateEpisode } from "./episodeNumberMap.js";
import { needsTranslatedSeasonWarmup, warmTranslatedRowSeasons } from "./translatedSeasonWarmup.js";
const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p";
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAILS_SCHEMA_VERSION = 15; // bumped: refetch structural-only TV rows so full metadata append data is restored
const TV_SYNOPSIS_LANGUAGE_VERSION = 1;
const TV_SYNOPSIS_LANGUAGE_RETRY_MS = 15 * 60 * 1000;
const PERSON_SCHEMA_VERSION = 5;
const SEARCH_TTL_MS = 15 * 60 * 1000;
const RECOMMENDATION_TTL_MS = 6 * 60 * 60 * 1000;
const DISCOVERY_REVALIDATE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MISSING_TTL_MS = DAY_MS;
const PERSON_TTL_MS = 7 * DAY_MS;
const MAX_RECOMMENDATION_SEEDS = 16;
const MAX_RECOMMENDATION_SEEDS_PER_TYPE = Math.ceil(MAX_RECOMMENDATION_SEEDS / 2);
const RECOMMENDATION_RESULTS_PER_SEED = 20;
const RECOMMENDATION_RESULT_LIMIT = 30;
const RECOMMENDATION_RECENCY_HALF_LIFE_DAYS = 180;
const PREWARM_INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
const discoveryRefreshes = new Map();
const discoveryRefreshRequestedAt = new Map();
const metadataWarmupQueue = [];
const metadataWarmupQueued = new Set();
const metadataWarmupAttemptedAt = new Map();
const METADATA_WARMUP_RETRY_MS = 15 * 60 * 1000;
const MAX_METADATA_WARMUP_QUEUE = 1000;
let metadataWarmupDrain = null;
let metadataWarmupEnabled = false;
let nextRequestAt = 0;
let throttleQueue = [];
let throttleTimer = null;
let throttleSequence = 0;
const THROTTLE_PRIORITY = { interactive: 0, sync: 1, enrichment: 2 };

// --- SQLite-backed cache helpers ---
const metaGetStmt = db.prepare("SELECT * FROM tmdb_metadata_cache WHERE id = ?");
const metaGetByTmdbIdStmt = db.prepare("SELECT * FROM tmdb_metadata_cache WHERE media_type = 'tv' AND tmdb_id = ? ORDER BY updated_at_ms DESC LIMIT 1");
// Demo fixture rows are written under their TMDB id. A show detail opened
// from a local episode can arrive with only the series TVDB id, so keep a
// cache-only lookup for that identity as well. JSON1 is already required by
// the metadata-column migration in db.js.
const metaGetByTvdbIdStmt = db.prepare(
  "SELECT * FROM tmdb_metadata_cache WHERE media_type = 'tv' AND json_valid(details) AND json_extract(details, '$.external_ids.tvdb_id') = ? ORDER BY updated_at_ms DESC LIMIT 1",
);
// `status`, `poster_path` and the backdrop/poster URLs are mirrored out of the
// details blob into their own columns so grid and card paths can read the two
// or three fields they need without parsing a blob that averages 64KB for a TV
// entry. They must be written on every cache write, not only backfilled by the
// migration, or a title refreshed after the upgrade would read back NULL and
// lose its poster and status.
const metaSetStmt = db.prepare(
  `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, status, poster_path, cached_poster_url,
     backdrop_path, cached_backdrop_url, tvdb_poster_url, original_language, schema_version, updated_at_ms)
   VALUES (@id, @tmdb_id, @media_type, @title, @details, @status, @poster_path, @cached_poster_url,
     @backdrop_path, @cached_backdrop_url, @tvdb_poster_url, @original_language, @schema_version, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tmdb_id=excluded.tmdb_id, media_type=excluded.media_type, title=excluded.title,
     details=excluded.details, status=excluded.status, poster_path=excluded.poster_path,
     cached_poster_url=excluded.cached_poster_url, backdrop_path=excluded.backdrop_path,
     cached_backdrop_url=excluded.cached_backdrop_url, tvdb_poster_url=excluded.tvdb_poster_url,
     original_language=excluded.original_language, schema_version=excluded.schema_version, updated_at_ms=excluded.updated_at_ms`,
);
function metaGet(id) {
  const row = metaGetStmt.get(id);
  if (!row) return null;
  return { tmdbId: row.tmdb_id, mediaType: row.media_type, title: row.title, details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms };
}
function metaGetByTmdbId(tmdbId) {
  const row = metaGetByTmdbIdStmt.get(String(tmdbId || ""));
  if (!row) return null;
  return { tmdbId: row.tmdb_id, mediaType: row.media_type, title: row.title, details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms };
}
function metaGetByTvdbId(tvdbId) {
  const row = metaGetByTvdbIdStmt.get(String(tvdbId || ""));
  if (!row) return null;
  return { tmdbId: row.tmdb_id, mediaType: row.media_type, title: row.title, details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms };
}
function metaSet(id, value) {
  const details = value.details != null && typeof value.details === "object" && !Array.isArray(value.details)
    ? value.details
    : {};
  metaSetStmt.run({
    id,
    tmdb_id: value.tmdbId != null ? String(value.tmdbId) : null,
    media_type: value.mediaType || null,
    title: value.title || null,
    details: value.details != null ? toJson(value.details) : null,
    status: details.status || null,
    poster_path: details.poster_path || null,
    cached_poster_url: details.cached_poster_url || details.cachedPosterUrl || null,
    backdrop_path: details.backdrop_path || null,
    cached_backdrop_url: details.cached_backdrop_url || details.cachedBackdropUrl || null,
    tvdb_poster_url: details.tvdb_poster_url || details.tvdbPosterUrl || null,
    original_language: typeof details.original_language === "string" && details.original_language ? details.original_language.toLowerCase() : null,
    schema_version: value.schemaVersion ?? null,
    updated_at_ms: value.updatedAtMs ?? Date.now(),
  });
}

const searchGetStmt = db.prepare("SELECT * FROM tmdb_search_cache WHERE id = ?");
const searchSetStmt = db.prepare(
  `INSERT INTO tmdb_search_cache (id, query, media_type, page, response, missing, updated_at_ms)
   VALUES (@id, @query, @media_type, @page, @response, @missing, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET query=excluded.query, media_type=excluded.media_type, page=excluded.page,
     response=excluded.response, missing=excluded.missing, updated_at_ms=excluded.updated_at_ms`,
);

const personGetStmt = db.prepare("SELECT * FROM tmdb_person_cache WHERE id = ?");
const personSetStmt = db.prepare(
  `INSERT INTO tmdb_person_cache (id, person_id, details, schema_version, updated_at_ms)
   VALUES (@id, @person_id, @details, @schema_version, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET person_id=excluded.person_id, details=excluded.details,
     schema_version=excluded.schema_version, updated_at_ms=excluded.updated_at_ms`,
);

const recentWatchStmt = db.prepare(`
  SELECT media_type, tmdb_id, tvdb_id, imdb_id, title, show_title
  FROM watch_history
  ORDER BY watched_at DESC
  LIMIT 2000
`);
const recentProgressStmt = db.prepare(`
  SELECT media_type, tmdb_id, tvdb_id, imdb_id, title, NULL AS show_title
  FROM playback_progress
  WHERE position_ms > 0
  ORDER BY COALESCE(updated_at, 0) DESC
  LIMIT 1000
`);

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function showTitleFromWarmupTitle(value = "") {
  return String(value || "")
    .replace(/\s*-\s*S\d{1,3}E\d{1,3}(?:\s*-\s*.*)?$/i, "")
    .trim();
}

function titleSearchParts(value = "") {
  const title = String(value || "").trim();
  // Match a trailing "(YYYY)" on the already-trimmed string. Anchoring tightly with no
  // leading/trailing \s* avoids the polynomial backtracking CodeQL flagged.
  const match = title.match(/\((\d{4})\)$/);
  if (!match) return { title, year: "" };
  return {
    title: title.slice(0, match.index).trim(),
    year: match[1],
  };
}

function mediaTypeFor(value) {
  return String(value).toLowerCase() === "movie" ? "movie" : "tv";
}

function warmupMediaType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "movie") return "movie";
  if (["tv", "episode", "series", "show", "season"].includes(normalized)) return "tv";
  return "";
}

function normalizeMetadataWarmupItem(item = {}, reason = "") {
  const rawType = String(item.mediaType || item.media_type || item.type || "").trim().toLowerCase();
  const mediaType = warmupMediaType(rawType);
  const isLeafType = rawType === "episode" || rawType === "season";
  if (!mediaType) return null;
  const sourceIds = item.ids || item.show_ids || item.showIds || {};
  const title = mediaType === "tv"
    ? String(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.title || item.name || "").trim()
    : String(item.title || item.name || "").trim();
  const tmdbId = String(
    mediaType === "tv"
      ? item.show_tmdb_id || item.showTmdbId || (!isLeafType && (item.tmdbId || item.tmdb_id || sourceIds.tmdbId || sourceIds.tmdb_id || sourceIds.tmdb)) || ""
      : item.tmdbId || item.tmdb_id || sourceIds.tmdbId || sourceIds.tmdb_id || sourceIds.tmdb || "",
  ).trim();
  const tvdbId = String(
    mediaType === "tv"
      ? item.show_tvdb_id || item.showTvdbId || item.tvdbId || item.tvdb_id || sourceIds.tvdbId || sourceIds.tvdb_id || sourceIds.tvdb || ""
      : item.tvdbId || item.tvdb_id || sourceIds.tvdbId || sourceIds.tvdb_id || sourceIds.tvdb || "",
  ).trim();
  const imdbId = String(
    mediaType === "tv"
      ? item.show_imdb_id || item.showImdbId || (!isLeafType && (item.imdbId || item.imdb_id || sourceIds.imdbId || sourceIds.imdb_id || sourceIds.imdb)) || ""
      : item.imdbId || item.imdb_id || sourceIds.imdbId || sourceIds.imdb_id || sourceIds.imdb || "",
  ).trim();
  if (!title && !tmdbId && !tvdbId && !imdbId) return null;
  return {
    mediaType,
    tmdbId,
    title,
    ids: { tvdbId, imdbId },
    verifyTvdbTitle: Boolean(item.verifyTvdbTitle),
    force: item.force === true,
    reason: String(reason || item.reason || "discovery"),
  };
}

function detailsTtl(details) {
  if (["Returning Series", "In Production", "Post Production", "Planned", "Pilot"].includes(details?.status)) return DAY_MS;
  if (["Ended", "Canceled", "Released"].includes(details?.status)) return 30 * DAY_MS;
  return 7 * DAY_MS;
}

function fresh(data, ttl) {
  return Boolean(data?.updatedAtMs && Date.now() - data.updatedAtMs < ttl);
}

// A cached row satisfies a caller when it is schema-current and inside its TTL -
// and, for full callers, was not produced by a light fetch (light rows skip
// next-airing derivation and artwork enrichment, so a full request must refetch).
function cacheSatisfies(cached, { light = false, requireEnglishTvSynopsis = false } = {}) {
  if (!cached?.details) return false;
  if (!light && cached.details.details_light) return false;
  if (requireEnglishTvSynopsis && cached.details.tv_synopsis_language_version !== TV_SYNOPSIS_LANGUAGE_VERSION) return false;
  if (requireEnglishTvSynopsis && cached.details.tv_synopsis_language_status === "error"
    && !fresh({ updatedAtMs: cached.details.tv_synopsis_language_checked_at_ms }, TV_SYNOPSIS_LANGUAGE_RETRY_MS)) return false;
  return cached.schemaVersion >= DETAILS_SCHEMA_VERSION && fresh(cached, detailsTtl(cached.details));
}

function metadataCacheIds(item = {}) {
  const ids = [];
  if (item.mediaType === "movie") {
    if (item.tmdbId) ids.push(`movie_${item.tmdbId}`);
  } else {
    if (item.tmdbId) ids.push(`tv_${item.tmdbId}`);
    if (item.ids?.tvdbId) ids.push(`tv_tvdb_${item.ids.tvdbId}`);
  }

  // A title lookup first stores a small title -> provider-id row. Follow that
  // pointer when it exists so cache-only consumers can still find details for
  // records that do not carry a provider id themselves.
  if (item.title) {
    const parts = titleSearchParts(item.title);
    const normalizedTitle = canonicalTitle(parts.title || item.title);
    if (normalizedTitle) {
      const titleKey = `title_${item.mediaType}_${hash(`${normalizedTitle}|${parts.year || ""}`)}`;
      const titleRow = metaGet(titleKey);
      if (titleRow?.tmdbId) ids.push(`${item.mediaType}_${titleRow.tmdbId}`);
    }
  }
  return [...new Set(ids)];
}

function metadataCacheRow(item = {}) {
  const requestedTvdbId = String(item.ids?.tvdbId || "").trim();
  for (const cacheId of metadataCacheIds(item)) {
    const cached = metaGet(cacheId);
    if (!cached?.details) continue;
    const cachedTvdbId = String(cached.details.external_ids?.tvdb_id || "").trim();
    // A TMDB slot can have been populated by an older, incorrect match. Do
    // not let a cache-only read turn that stale identity into another show.
    if (item.mediaType === "tv" && requestedTvdbId && cachedTvdbId !== requestedTvdbId) continue;
    return cached;
  }
  // A legacy or bundled row may not have the explicit TVDB alias yet. Match
  // the identity inside the cached details before declaring a demo title
  // missing; this keeps TVDB-routed detail pages cache-only and offline.
  if (item.mediaType === "tv" && requestedTvdbId) {
    const cached = metaGetByTvdbId(requestedTvdbId);
    if (cached?.details) return cached;
  }
  return null;
}

// Synchronous and deliberately cache-only. Interactive detail routes call
// getTmdbDetails when they need a fresh record; dashboard projections use this
// helper so a missing/stale provider row can never hold the HTTP request open.
export function getCachedTmdbDetails({ mediaType, tmdbId = "", title = "", ids = {} } = {}) {
  const item = normalizeMetadataWarmupItem({ mediaType, tmdbId, title, ids });
  return item ? metadataCacheRow(item)?.details || null : null;
}

function boundedResults(resource, limit) {
  if (!resource || typeof resource !== "object") return resource;
  return { ...resource, results: Array.isArray(resource.results) ? resource.results.slice(0, limit) : [] };
}

function imageGroups(details = {}) {
  const images = details?.images || {};
  return {
    backdrops: Array.isArray(images.backdrops) ? images.backdrops : [],
    posters: Array.isArray(images.posters) ? images.posters : [],
    logos: Array.isArray(images.logos) ? images.logos : [],
  };
}

function hasImageCandidates(images = {}) {
  return Boolean(images.backdrops?.length || images.posters?.length || images.logos?.length);
}

// TMDB's plain `/credits` endpoint for a TV show only reflects one season's
// top billing and can be missing long-running regular cast entirely (e.g. it
// omits The Office US's Michael Scott/Steve Carell). `aggregate_credits`
// covers the whole series but returns every guest/one-episode actor too
// (hundreds of rows) - shape it down to the regularly-billed cast TMDB orders
// first (guest appearances are ordered far afterward) so the show page shows
// the real main cast instead of whichever handful `/credits` happened to have.
function mainCastFromAggregate(aggregateCredits) {
  const cast = Array.isArray(aggregateCredits?.cast) ? aggregateCredits.cast : [];
  return [...cast]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 30)
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      profile_path: actor.profile_path,
      character: actor.roles?.[0]?.character || "",
      order: actor.order,
    }));
}

// The detail page's watch-provider row reads these regions and no others.
const WATCH_PROVIDER_REGIONS = ["GB", "US"];

function compactDetails(details = {}) {
  const compact = { ...details };
  const aggregateCast = mainCastFromAggregate(details.aggregate_credits);
  if (details.credits || aggregateCast.length) {
    compact.credits = {
      ...details.credits,
      cast: aggregateCast.length ? aggregateCast : (details.credits?.cast || []).slice(0, 60),
      crew: (details.credits?.crew || []).slice(0, 60),
    };
  }
  // Only the shaped main-cast list above is kept - the raw aggregate payload
  // (hundreds of guest-actor rows) isn't worth persisting.
  delete compact.aggregate_credits;
  if (details.videos) compact.videos = boundedResults(details.videos, 30);
  if (details.reviews) compact.reviews = boundedResults(details.reviews, 10);
  if (details.similar) compact.similar = boundedResults(details.similar, 24);
  if (details.recommendations) compact.recommendations = boundedResults(details.recommendations, 24);
  if (details.images) {
    compact.images = {
      backdrops: (details.images.backdrops || []).slice(0, 40),
      posters: (details.images.posters || []).slice(0, 40),
      logos: (details.images.logos || []).slice(0, 20),
    };
  }
  // TMDB returns streaming availability for every country it knows about, which
  // was 22KB of a 100KB movie detail payload - the single largest field. The
  // detail page reads exactly two of those regions (see the watch-provider row
  // in media-detail-shared.js), so the rest is stored and shipped to the browser
  // for nothing.
  if (details["watch/providers"]?.results) {
    const results = details["watch/providers"].results;
    const kept = {};
    for (const region of WATCH_PROVIDER_REGIONS) {
      if (results[region]) kept[region] = results[region];
    }
    compact["watch/providers"] = { ...details["watch/providers"], results: kept };
  }
  // Fetched as part of the appended response but read by nothing, in either the
  // server or the SPA. Keeping it only inflates the cached row and the detail
  // page's payload.
  delete compact.release_dates;
  return compact;
}

function collapse(key, task) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function drainThrottleQueue() {
  throttleTimer = null;
  if (!throttleQueue.length) return;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) {
    throttleTimer = setTimeout(drainThrottleQueue, delay);
    return;
  }
  throttleQueue.sort((a, b) => (
    THROTTLE_PRIORITY[a.lane] - THROTTLE_PRIORITY[b.lane] || a.sequence - b.sequence
  ));
  const next = throttleQueue.shift();
  nextRequestAt = Date.now() + 350;
  next.resolve();
  if (throttleQueue.length) drainThrottleQueue();
}

async function throttle({ lane = "enrichment" } = {}) {
  return new Promise((resolve) => {
    throttleQueue.push({
      lane: Object.prototype.hasOwnProperty.call(THROTTLE_PRIORITY, lane) ? lane : "enrichment",
      sequence: throttleSequence++,
      resolve,
    });
    drainThrottleQueue();
  });
}

async function apiKey() {
  const config = await loadMediaConfig();
  if (!config.tmdb?.apiKey) {
    const error = new Error("TMDB API key is not configured");
    error.status = 400;
    throw error;
  }
  return config.tmdb.apiKey;
}

async function upstream(path, params = {}, attempt = 0, { lane = "enrichment" } = {}) {
  await throttle({ lane });
  const key = await apiKey();
  const url = new URL(`${API_ROOT}/${String(path).replace(/^\/+/, "")}`);
  url.searchParams.set("api_key", key);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" }, lane });
  if (response.status === 429 && attempt < 2) {
    const retryAfter = Math.max(1, Number(response.headers.get("retry-after") || 1));
    await wait(retryAfter * 1000 + Math.floor(Math.random() * 250));
    return upstream(path, params, attempt + 1, { lane });
  }
  if (!response.ok) {
    const error = new Error(`TMDB request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchTmdbRaw(type, id, lane = "enrichment") {
  const appends = "credits,videos,reviews,similar,recommendations,watch/providers,keywords,external_ids,release_dates,content_ratings,images";
  return compactDetails(await upstream(`${type}/${id}`, {
    append_to_response: type === "tv" ? `${appends},aggregate_credits` : appends,
  }, 0, { lane }));
}

// The movie details response only stubs belongs_to_collection ({id, name, poster_path,
// backdrop_path}) - the member films (`parts`) require this separate collection call.
async function fetchCollectionParts(collectionId, lane = "enrichment") {
  const cacheId = `collection_${collectionId}`;
  const cached = metaGet(cacheId);
  if (cached?.details && fresh(cached, 7 * DAY_MS)) return cached.details;
  try {
    const collection = await upstream(`collection/${collectionId}`, {}, 0, { lane });
    const parts = (collection.parts || []).slice(0, 20);
    metaSet(cacheId, { tmdbId: collectionId, mediaType: "collection", details: parts, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
    return parts;
  } catch {
    return cached?.details || [];
  }
}

async function cacheCanonicalArtwork(mediaType, tmdbId, details) {
  const mediaKey = `tmdb:${mediaType}:${tmdbId}`;
  const [posterCache, backdropCache, logoCache] = await Promise.all([
    getPosterCache(mediaKey, "poster"),
    getPosterCache(mediaKey, "backdrop"),
    getPosterCache(mediaKey, "logo"),
  ]);
  const posterState = usableCachedPoster(posterCache);
  const backdropState = usableCachedPoster(backdropCache);
  const logoState = usableCachedPoster(logoCache);
  let poster = posterState?.url || null;
  let backdrop = backdropState?.url || null;
  let logo = logoState?.url || null;

  const hasTmdbLogos = (details.images?.logos || []).length > 0;

  const tmdbJobs = [];
  if (!posterState && details.tvdb_poster_url) {
    tmdbJobs.push(cachePosterFromUrl(mediaKey, details.tvdb_poster_url, "tvdb").then((v) => { poster = v?.url || poster; }));
  } else if (!posterState && details.poster_path) {
    tmdbJobs.push(cachePosterFromUrl(mediaKey, `${IMAGE_ROOT}/w500${details.poster_path}`, "tmdb").then((v) => { poster = v?.url || poster; }));
  }
  if (!backdropState && details.backdrop_path) {
    tmdbJobs.push(cacheBackdropFromUrl(mediaKey, `${IMAGE_ROOT}/original${details.backdrop_path}`, "tmdb").then((v) => { backdrop = v?.url || backdrop; }));
  }

  await Promise.all(tmdbJobs);

  const needsFanart = !poster || !backdrop || (!logo && !hasTmdbLogos && !logoState);
  if (needsFanart) {
    const tvdbId = String(details.external_ids?.tvdb_id || "");
    const fanartArt = await (mediaType === "movie" ? getFanartMovieArt(tmdbId) : getFanartTvArt(tvdbId)).catch(() => null);
    if (!fanartArt) {
      if (!logo && !hasTmdbLogos && !logoState) {
        await markPosterMissing(mediaKey, "fanart", "No fanart data", "logo");
      }
      return {
        cached_poster_url: poster,
        cached_backdrop_url: backdrop,
        ...(logo ? { cached_logo_url: logo } : {}),
      };
    }
    const fanartJobs = [];
    if (!poster && fanartArt.poster) {
      fanartJobs.push(cachePosterFromUrl(mediaKey, fanartArt.poster, "fanart").then((v) => { poster = v?.url || poster; }));
    }
    if (!backdrop && fanartArt.backdrop) {
      fanartJobs.push(cacheBackdropFromUrl(mediaKey, fanartArt.backdrop, "fanart").then((v) => { backdrop = v?.url || backdrop; }));
    }
    if (!logo && !hasTmdbLogos && fanartArt.logo) {
      fanartJobs.push(cacheLogoFromUrl(mediaKey, fanartArt.logo, "fanart").then((v) => { logo = v?.url || logo; }));
    }
    await Promise.all(fanartJobs);
    if (!logo && !hasTmdbLogos && !fanartArt.logo) {
      await markPosterMissing(mediaKey, "fanart", "No logo on fanart.tv", "logo");
    }
  }

  return {
    cached_poster_url: poster,
    cached_backdrop_url: backdrop,
    ...(logo ? { cached_logo_url: logo } : {}),
  };
}

async function resolveTmdbExternalId(type, source, externalId, lane = "enrichment") {
  const cleaned = String(externalId || "").trim();
  if (!cleaned) return "";
  const key = `external_${type}_${source}_${hash(cleaned.toLowerCase())}`;
  const cached = metaGet(key);
  if (cached?.tmdbId) return String(cached.tmdbId);

  try {
    const result = await upstream(`find/${encodeURIComponent(cleaned)}`, { external_source: source }, 0, { lane });
    const list = type === "movie" ? result.movie_results : result.tv_results;
    // The given id can belong to an episode rather than its series (TMDB
    // assigns episodes their own ids) - `find` still resolves it, just under
    // tv_episode_results instead of tv_results, with a show_id pointing at
    // the real parent series. Falling through to a title search instead
    // would risk landing on a different, wrongly-matched show entirely when
    // two real shows share a title.
    const resolved = String(list?.[0]?.id || (type === "tv" ? result.tv_episode_results?.[0]?.show_id : "") || "");
    if (resolved) {
      metaSet(key, { tmdbId: resolved, mediaType: type, title: cleaned, updatedAtMs: Date.now() });
    }
    return resolved;
  } catch {
    return "";
  }
}

// What an IMDb or TVDB id is to TMDB: a series, an episode (with its show and
// coordinate), or nothing. Cached apart from resolveTmdbExternalId, which keeps
// only the resolved show id. The playstate episode-id repair reads the cache
// only; lookupTmdbExternalIdKind runs from its background job.
const EXTERNAL_ID_KIND_TTL_MS = 30 * DAY_MS;

function externalIdKindKey(source, externalId) {
  return `external_kind_${source}_${hash(String(externalId).trim().toLowerCase())}`;
}

export function getCachedTmdbExternalIdKind(source, externalId) {
  if (!String(externalId || "").trim()) return null;
  const cached = metaGet(externalIdKindKey(source, externalId));
  if (!cached?.details?.kind) return null;
  if (Date.now() - Number(cached.updatedAtMs || 0) > EXTERNAL_ID_KIND_TTL_MS) return null;
  return cached.details;
}

// Throws on a failed request (nothing is cached, so the id is retried later).
export async function lookupTmdbExternalIdKind(source, externalId, { lane = "enrichment" } = {}) {
  const cleaned = String(externalId || "").trim();
  if (!cleaned) return null;
  const cached = getCachedTmdbExternalIdKind(source, cleaned);
  if (cached) return cached;
  const result = await upstream(`find/${encodeURIComponent(cleaned)}`, { external_source: source }, 0, { lane });
  const series = result?.tv_results?.[0];
  const episode = result?.tv_episode_results?.[0];
  const details = series
    ? { kind: "series", showId: String(series.id) }
    : episode
      ? { kind: "episode", showId: String(episode.show_id), season: Number(episode.season_number), episode: Number(episode.episode_number) }
      : { kind: "none" };
  metaSet(externalIdKindKey(source, cleaned), { tmdbId: null, mediaType: "external_id_kind", title: cleaned, details, updatedAtMs: Date.now() });
  return details;
}

async function resolveTmdbId(mediaType, tmdbId, title, ids = {}, { ignoreTmdbId = false, lane = "enrichment" } = {}) {
  if (tmdbId && !ignoreTmdbId) return String(tmdbId);
  const type = mediaTypeFor(mediaType);
  const imdbId = String(ids.imdbId || ids.imdb_id || ids.imdb || "").trim();
  const tvdbId = String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim();

  if (imdbId) {
    const resolved = await resolveTmdbExternalId(type, "imdb_id", imdbId, lane);
    if (resolved) return resolved;
  }
  if (type === "tv" && tvdbId) {
    const resolved = await resolveTmdbExternalId(type, "tvdb_id", tvdbId, lane);
    if (resolved) return resolved;
  }

  const searchParts = titleSearchParts(title);
  const searchTitle = searchParts.title || title;
  const normalizedTitle = canonicalTitle(searchTitle);
  if (!normalizedTitle) return "";
  const titleKey = `title_${type}_${hash(`${normalizedTitle}|${searchParts.year || ""}`)}`;
  const cached = metaGet(titleKey);
  if (cached?.tmdbId) return String(cached.tmdbId);
  const searchParams = { query: searchTitle, page: 1, include_adult: false };
  if (searchParts.year) {
    if (type === "tv") searchParams.first_air_date_year = searchParts.year;
    else searchParams.primary_release_year = searchParts.year;
  }
  const result = await upstream(`search/${type}`, searchParams, 0, { lane });
  const resolved = String(result.results?.[0]?.id || "");
  if (resolved) {
    metaSet(titleKey, { tmdbId: resolved, title: searchTitle, mediaType: type, updatedAtMs: Date.now() });
  }
  return resolved;
}

async function deriveNextAiring(details, tvdbId, lane = "enrichment") {
  const today = new Date().toISOString().slice(0, 10);
  const maxSeason = Math.max(0, ...(details.seasons || []).map((season) => Number(season.season_number) || 0));
  const candidates = new Set([maxSeason, maxSeason + 1].filter((value) => value > 0));
  let earliest = null;
  for (const seasonNumber of [...candidates].sort((a, b) => a - b)) {
    const season = await getTmdbSeason({ tmdbId: details.id, tvdbId, seasonNumber, lane }).catch(() => null);
    const dates = (season?.episodes || []).map((episode) => episode.air_date).filter((date) => date && date >= today).sort();
    if (dates[0] && (!earliest || dates[0] < earliest)) earliest = dates[0];
  }
  return earliest;
}

// `light: true` is the grid-prefetch mode: it serves any fresh cached row, and
// on a cache miss fetches the raw details but skips the enrichment that grids
// don't need (collection parts, next-airing derivation, artwork/fanart
// caching). Light-fetched rows are stamped `details_light` so the next full
// caller refetches and completes them.
export async function getTmdbDetails({ mediaType, tmdbId = "", title = "", ids = {}, force = false, forceTvdb = force, light = false, verifyTvdbTitle = false, relatedTvLookup = false, lane = "enrichment" }) {
  if (isDemoMode()) {
    const cached = getCachedTmdbDetails({ mediaType, tmdbId, title, ids });
    if (cached) return cached;
    const error = new Error("Demo metadata is not bundled for this title");
    error.status = 404;
    throw error;
  }
  const type = mediaTypeFor(mediaType);
  if (type === "tv") return getTvShowDetails({ tmdbId, title, ids, force, forceTvdb, light: light && !force, verifyTvdbTitle, relatedTvLookup, lane });
  return getMovieDetails({ tmdbId, title, ids, force, light: light && !force, lane });
}

// The merged show-details payload uses TVDB for its structural season list,
// including absolute TVDB artwork URLs. Fetch the provider's actual season
// endpoint when the Edit Images grid needs TMDB's own season poster.
export async function getTmdbSeasonArtwork({ tmdbId, seasonNumber, lane = "enrichment" } = {}) {
  const id = String(tmdbId || "").trim();
  const number = Number(seasonNumber);
  if (!/^\d+$/.test(id) || !Number.isInteger(number) || number < 0) {
    const error = new Error("A valid TMDB ID and season number are required");
    error.status = 400;
    throw error;
  }
  if (isDemoMode()) {
    const error = new Error("TMDB season artwork is not available in demo mode");
    error.status = 503;
    throw error;
  }
  return collapse(`tmdb-season-artwork:${id}:${number}`, () => upstream(`tv/${id}/season/${number}`, {}, 0, { lane }));
}

async function drainMetadataWarmupQueue() {
  let warmed = 0;
  let failed = 0;
  let firstError = "";
  while (metadataWarmupQueue.length) {
    const item = metadataWarmupQueue.shift();
    metadataWarmupQueued.delete(item.key);
    const attemptedAt = Number(metadataWarmupAttemptedAt.get(item.key) || 0);
    if (attemptedAt && Date.now() - attemptedAt < METADATA_WARMUP_RETRY_MS) continue;
    metadataWarmupAttemptedAt.set(item.key, Date.now());
    try {
      await warmTranslatedRowSeasons(await getTmdbDetails(item));
      warmed += 1;
    } catch (error) {
      failed += 1;
      if (!firstError) firstError = String(error?.message || error || "metadata request failed");
    }
  }
  if (warmed || failed) {
    console.log(`TMDB metadata warm-up complete: ${warmed} succeeded, ${failed} failed${firstError ? ` (first: ${firstError})` : ""}.`);
  }
}

function startMetadataWarmupDrain() {
  if (!metadataWarmupEnabled || metadataWarmupDrain || !metadataWarmupQueue.length) return;
  metadataWarmupDrain = drainMetadataWarmupQueue()
    .catch((error) => console.warn(`TMDB metadata warm-up failed: ${error?.message || error}`))
    .finally(() => {
      metadataWarmupDrain = null;
      startMetadataWarmupDrain();
    });
}

// Keep imported modules and direct repository tests side-effect free. The
// application entrypoint enables this worker once the real server process has
// initialized; discovery can still queue work before then, and it will drain
// as soon as the process is enabled.
export function enableTmdbMetadataWarmup() {
  metadataWarmupEnabled = true;
  startMetadataWarmupDrain();
}

// Queue provider work away from request handlers. New library events and
// provider-feed observations call this function, while the dashboard only
// reads the SQLite cache. A single worker preserves the gateway throttle and
// keeps a large first import from creating a provider/API or event-loop burst.
export function queueTmdbMetadataWarmup(items = [], { reason = "discovery" } = {}) {
  const input = Array.isArray(items) ? items : [items];
  const accepted = [];
  for (const raw of input) {
    const normalized = normalizeMetadataWarmupItem(raw, reason);
    if (!normalized) continue;
    const key = `${normalized.mediaType}:${normalized.mediaType === "movie"
      ? normalized.tmdbId || canonicalTitle(normalized.title)
      : normalized.tmdbId || normalized.ids.tvdbId || normalized.ids.imdbId || canonicalTitle(normalized.title)}`.toLowerCase();
    if (!key || metadataWarmupQueued.has(key)) continue;
    const cached = metadataCacheRow(normalized);
    const cachedArtwork = cached?.details && (
      cached.details.cached_poster_url
      || cached.details.poster_path
      || cached.details.tvdb_poster_url
    );
    if (cacheSatisfies(cached, { light: false, requireEnglishTvSynopsis: normalized.mediaType === "tv" }) && cachedArtwork && !needsTranslatedSeasonWarmup(cached.details)) continue;
    metadataWarmupQueued.add(key);
    accepted.push({ ...normalized, force: normalized.force || Boolean(cached), key });
  }
  // Put newly discovered media ahead of a broad backfill already in flight,
  // then cap retained work so an unusually large library cannot grow memory
  // without bound. Dropped entries are rediscovered by the next scheduler/feed
  // pass and are not treated as successfully warmed.
  for (const item of accepted.reverse()) metadataWarmupQueue.unshift(item);
  while (metadataWarmupQueue.length > MAX_METADATA_WARMUP_QUEUE) {
    const dropped = metadataWarmupQueue.pop();
    metadataWarmupQueued.delete(dropped.key);
  }
  if (accepted.length) startMetadataWarmupDrain();
  return { queued: accepted.length, pending: metadataWarmupQueue.length };
}

async function getMovieDetails({ tmdbId = "", title = "", ids = {}, force = false, light = false, lane = "enrichment" }) {
  const type = "movie";
  const resolvedId = await resolveTmdbId(type, tmdbId, title, ids, { lane });
  if (!resolvedId) {
    const error = new Error("Could not resolve TMDB ID");
    error.status = 404;
    throw error;
  }
  const key = `details:${type}:${resolvedId}:${force ? "force" : "cached"}:${light ? "light" : "full"}`;
  return collapse(key, async () => {
    const cacheId = `${type}_${resolvedId}`;
    const cached = metaGet(cacheId);
    if (!force && cacheSatisfies(cached, { light })) return cached.details;
    try {
      const fetched = await fetchTmdbRaw(type, resolvedId, lane);
      const details = { ...(cached?.details || {}), ...fetched };
      if (light) {
        details.details_light = true;
      } else {
        delete details.details_light;
        if (details.belongs_to_collection?.id) {
          details.belongs_to_collection = {
            ...details.belongs_to_collection,
            parts: await fetchCollectionParts(details.belongs_to_collection.id, lane),
          };
        }
        Object.assign(details, await cacheCanonicalArtwork(type, resolvedId, details));
      }
      metaSet(cacheId, { tmdbId: resolvedId, mediaType: type, details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      if (error.status === 404 && (title || ids.imdbId || ids.imdb_id || ids.imdb)) {
        const fallbackId = await resolveTmdbId(type, "", title, ids, { ignoreTmdbId: true, lane }).catch(() => "");
        if (fallbackId && String(fallbackId) !== String(resolvedId)) {
          return getMovieDetails({ tmdbId: fallbackId, title, ids, force, light, lane });
        }
      }
      throw error;
    }
  });
}

// TV shows: TVDB supplies the structural data (name, overview, air dates,
// artwork, seasons/episodes - the accurate episode ordering this feature
// exists for). TMDB is merged in only for what TVDB doesn't have (cast,
// trailers, reviews, similar/recommendations, watch providers) and to keep
// `id` = TMDB id, since Seerr requests and `/tvshow/tmdb/:id` routing are
// TMDB-keyed throughout the rest of the app.
async function getTvShowDetails({ tmdbId = "", title = "", ids = {}, force = false, forceTvdb = force, light = false, verifyTvdbTitle = false, relatedTvLookup = false, lane = "enrichment" }) {
  const requestedImdbId = String(ids.imdbId || ids.imdb_id || ids.imdb || "").trim();
  const requestedTvdbId = String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim();
  let tvdbId = String(ids.tvdbId || ids.tvdb_id || ids.tvdb || "").trim();
  // The cache below is keyed by TVDB id, so nothing can be served from it until
  // that id is known. When the caller has only a TMDB id, this used to resolve
  // it with `fetchTmdbRaw`, which is uncached and asks TMDB for the entire
  // appended payload (credits, videos, reviews, similar, images, aggregate
  // credits) purely to read `external_ids.tvdb_id` - about 300ms of upstream
  // work on *every* show and episode page load, even a fully cached one. The
  // mapping is already sitting in the cached details, so read it from there
  // first and only go upstream when it genuinely is not known yet.
  if (!tvdbId && tmdbId && !force) {
    const cachedMapping = metaGet(`tv_${tmdbId}`);
    tvdbId = String(cachedMapping?.details?.external_ids?.tvdb_id || "").trim();
  }
  if (!tvdbId && tmdbId) {
    const fallback = await fetchTmdbRaw("tv", tmdbId, lane).catch(() => null);
    tvdbId = String(fallback?.external_ids?.tvdb_id || "");
  }
  // A TMDB result is already an exact catalogue identity. Only fall back to a
  // title search when the provider did not expose a TVDB mapping; resolving by
  // title first can select the wrong same-named series (or reject a perfectly
  // valid TMDB result) before we ever inspect its own external ids.
  if (!tvdbId) {
    tvdbId = await resolveTvdbSeriesId({
      title,
      lane,
      ...(relatedTvLookup ? { missTtlMs: RELATED_TV_SEARCH_MISS_TTL_MS } : {}),
    });
  }
  if (!tvdbId) {
    const error = new Error("Could not resolve TVDB ID");
    error.status = 404;
    throw error;
  }

  const key = `tv-details:${tvdbId}:${force ? "force" : "cached"}:${light ? "light" : "full"}`;
  return collapse(key, async () => {
    // The caller's tmdbId may be empty (e.g. Fix Match clears it to force re-resolution
    // via the new tvdbId), so the cache row actually written might live under a
    // different key than this initial guess - re-derived below once resolvedTmdbId
    // is known, so lookups by the resolved tmdbId (getTmdbSeason, etc.) can find it.
    const initialCacheId = tmdbId ? `tv_${tmdbId}` : `tv_tvdb_${tvdbId}`;
    const cached = metaGet(initialCacheId);
    const cachedExternalIds = cached?.details?.external_ids || {};
    const cachedIdentityIsSafe = (!requestedTvdbId || !cachedExternalIds.tvdb_id || String(cachedExternalIds.tvdb_id) === requestedTvdbId)
      && (!requestedImdbId || !cachedExternalIds.imdb_id || String(cachedExternalIds.imdb_id).toLowerCase() === requestedImdbId.toLowerCase());
    const cachedTitleIsSafe = !verifyTvdbTitle || !title || tvdbSeriesTitleMatches(title, cached?.details);
    // A TMDB cache slot can be stale or can have been populated by a bad
    // cross-provider match. If the caller supplies a TVDB/IMDb identity,
    // never serve cached metadata for a different series merely because the
    // TMDB id matches. This is what otherwise allows same-title shows such as
    // The Assembly (UK) and The Assembly to render each other's watch rows.
    if (!force && cachedIdentityIsSafe && cachedTitleIsSafe && cacheSatisfies(cached, { light, requireEnglishTvSynopsis: true })) return cached.details;
    try {
      // Older library records can carry a TVDB episode ID rather than the
      // series ID. If that ID cannot be loaded as a series, first ask TVDB
      // what show that episode id actually belongs to (deterministic - no
      // guessing) before falling back to an ambiguous title search, which can
      // pick the wrong show entirely when two real shows share a title
      // (for example, Silo's stored episode IDs are 11751879+ while its
      // series ID is 403245).
      let seriesTvdbId = tvdbId;
      let extended;
      try {
        extended = await getTvdbSeriesExtended(seriesTvdbId, { force: forceTvdb, lane });
      } catch (error) {
        const fallbackSeriesId = await resolveTvdbSeriesIdFromEpisodeId(seriesTvdbId, { lane })
          || (title && await resolveTvdbSeriesId({ title, lane }));
        if (!fallbackSeriesId || fallbackSeriesId === seriesTvdbId) throw error;
        seriesTvdbId = fallbackSeriesId;
        extended = await getTvdbSeriesExtended(seriesTvdbId, { force: forceTvdb, lane });
      }

      if (verifyTvdbTitle && title && !tvdbSeriesTitleMatches(title, extended)) {
        const fallbackSeriesId = await resolveTvdbSeriesId({ title, lane });
        if (!fallbackSeriesId || fallbackSeriesId === seriesTvdbId) {
          const error = new Error("TVDB series match does not agree with the media-server title");
          error.code = "TVDB_TITLE_MISMATCH";
          error.status = 409;
          throw error;
        }
        seriesTvdbId = fallbackSeriesId;
        extended = await getTvdbSeriesExtended(seriesTvdbId, { force: forceTvdb, lane });
        if (!tvdbSeriesTitleMatches(title, extended)) {
          const error = new Error("TVDB title search did not produce a matching series");
          error.code = "TVDB_TITLE_MISMATCH";
          error.status = 409;
          throw error;
        }
      }
      const englishSynopsis = await getTvdbEnglishSeriesOverview(seriesTvdbId, { force: forceTvdb, lane });
      const shaped = shapeTvdbSeriesAsTmdb(extended, { englishOverview: englishSynopsis.overview });
      const tvdbTmdbId = String(shaped.external_ids.tmdb_id || "");
      // TVDB is the authoritative identity when it was supplied explicitly.
      // Prefer its remote TMDB id if the caller's TMDB id disagrees, otherwise
      // we would fetch TMDB artwork/extras for one series and combine them
      // with TVDB episodes from another.
      let resolvedTmdbId = String(
        tvdbTmdbId && tmdbId && tvdbTmdbId !== String(tmdbId)
          ? tvdbTmdbId
          : (tmdbId || tvdbTmdbId || ""),
      );

      let raw = resolvedTmdbId ? await fetchTmdbRaw("tv", resolvedTmdbId, lane).catch(() => null) : null;
      if (!raw && resolvedTmdbId && shaped.name) {
        // TVDB's remoteIds mapping is community-submitted and occasionally points at a
        // stale/incorrect TMDB id (the fetch above 404s) - fall back to a title search
        // rather than silently leaving cast/trailers/images empty for this show forever.
        const fallbackId = await resolveTmdbId("tv", "", shaped.name, {}, { ignoreTmdbId: true, lane }).catch(() => "");
        if (fallbackId && fallbackId !== resolvedTmdbId) {
          const fallbackRaw = await fetchTmdbRaw("tv", fallbackId, lane).catch(() => null);
          if (fallbackRaw) {
            raw = fallbackRaw;
            resolvedTmdbId = fallbackId;
          }
        }
      }

      const cacheId = resolvedTmdbId ? `tv_${resolvedTmdbId}` : `tv_tvdb_${seriesTvdbId}`;
      if (!force && cacheId !== initialCacheId) {
        const resolvedCached = metaGet(cacheId);
        // A tmdb_id cache slot can hold a doc for a *different* show than the one
        // we're resolving now (e.g. an older Fix Match hit a stale TVDB→TMDB
        // remoteIds mapping and cached its title-search fallback under this same
        // tmdb id). Only reuse it when it actually corresponds to this tvdbId,
        // or a show rematched away from that tmdb id would keep serving forever.
        if (cacheSatisfies(resolvedCached, { light, requireEnglishTvSynopsis: true })
          && String(resolvedCached.details?.external_ids?.tvdb_id || "") === seriesTvdbId
          && (!requestedImdbId || !resolvedCached.details?.external_ids?.imdb_id
            || String(resolvedCached.details.external_ids.imdb_id).toLowerCase() === requestedImdbId.toLowerCase())) {
          return resolvedCached.details;
        }
      }

      const extras = raw ? {
        credits: raw.credits,
        videos: raw.videos,
        reviews: raw.reviews,
        similar: raw.similar,
        recommendations: raw.recommendations,
        "watch/providers": raw["watch/providers"],
        content_ratings: raw.content_ratings,
        keywords: raw.keywords,
        vote_average: raw.vote_average,
        episode_run_time: raw.episode_run_time,
        original_language: raw.original_language,
        images: raw.images,
        poster_path: raw.poster_path,
        backdrop_path: raw.backdrop_path,
        // TVDB supplies the canonical network name, while TMDB supplies the
        // logo_path used by the detail-page network chips. Keep the TVDB
        // fallback when TMDB has no network data for the show.
        networks: Array.isArray(raw.networks) && raw.networks.length ? raw.networks : shaped.networks,
      } : {};

      const details = {
        ...shaped,
        ...extras,
        tv_synopsis_language_version: TV_SYNOPSIS_LANGUAGE_VERSION,
        tv_synopsis_language_status: englishSynopsis.status,
        tv_synopsis_language_checked_at_ms: englishSynopsis.checkedAtMs,
        id: resolvedTmdbId || undefined,
        external_ids: {
          ...shaped.external_ids,
          imdb_id: shaped.external_ids?.imdb_id || raw?.external_ids?.imdb_id || "",
          tmdb_id: resolvedTmdbId,
        },
      };

      if (light) {
        // Light mode carries over previously derived fields instead of
        // recomputing them; the details_light stamp makes the next full caller
        // refetch and complete the row.
        if (cached?.details?.next_airing_date) details.next_airing_date = cached.details.next_airing_date;
        for (const field of ["cached_poster_url", "cached_backdrop_url", "cached_logo_url"]) {
          if (cached?.details?.[field]) details[field] = cached.details[field];
        }
        details.details_light = true;
      } else {
        const nextAiring = await deriveNextAiring(details, seriesTvdbId, lane);
        if (nextAiring) details.next_airing_date = nextAiring;
        else delete details.next_airing_date;

        Object.assign(details, await cacheCanonicalArtwork("tv", resolvedTmdbId || `tvdb-${seriesTvdbId}`, details));
      }
      const cacheValue = { tmdbId: resolvedTmdbId, mediaType: "tv", details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() };
      metaSet(cacheId, cacheValue);
      // Keep a TVDB-keyed alias as well. A library row may only know the
      // series TVDB id, and cache-only Up Next must be able to find this fully
      // warmed record without repeating a title/provider lookup.
      if (resolvedTmdbId && seriesTvdbId) metaSet(`tv_tvdb_${seriesTvdbId}`, cacheValue);
      return details;
    } catch (error) {
      if (cached?.details && cachedIdentityIsSafe && cachedTitleIsSafe) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
}

export async function searchTmdb({ query, page = 1, mediaType = "multi" }) {
  const type = ["movie", "tv", "person"].includes(mediaType) ? mediaType : "multi";
  const safePage = Math.min(Math.max(Number(page) || 1, 1), 500);
  const cacheKey = hash(`${type}|${canonicalTitle(query)}|${safePage}`);
  return collapse(`search:${cacheKey}`, async () => {
    const row = searchGetStmt.get(cacheKey);
    const cached = row ? { response: parseJson(row.response), missing: Boolean(row.missing), updatedAtMs: row.updated_at_ms } : null;
    const ttl = cached?.missing ? MISSING_TTL_MS : SEARCH_TTL_MS;
    if (cached && fresh(cached, ttl)) return cached.response;
    try {
      const response = await upstream(`search/${type}`, { query, page: safePage, include_adult: false });
      const cleaned = { ...response, results: (response.results || []).filter((item) => ["movie", "tv", "person"].includes(item.media_type || type)) };
      searchSetStmt.run({ id: cacheKey, query, media_type: type, page: safePage, response: toJson(cleaned), missing: cleaned.results.length ? 0 : 1, updated_at_ms: Date.now() });
      return cleaned;
    } catch (error) {
      if (cached?.response) return { ...cached.response, cache_stale: true };
      throw error;
    }
  });
}

export async function searchTmdbCollections({ query, page = 1 }) {
  const safePage = Math.min(Math.max(Number(page) || 1, 1), 500);
  const cleanQuery = String(query || "").trim();
  const cacheKey = hash(`collection|${canonicalTitle(cleanQuery)}|${safePage}`);
  return collapse(`search:${cacheKey}`, async () => {
    const row = searchGetStmt.get(cacheKey);
    const cached = row ? { response: parseJson(row.response), missing: Boolean(row.missing), updatedAtMs: row.updated_at_ms } : null;
    const ttl = cached?.missing ? MISSING_TTL_MS : SEARCH_TTL_MS;
    if (cached && fresh(cached, ttl)) return cached.response;
    try {
      const response = await upstream("search/collection", { query: cleanQuery, page: safePage, include_adult: false });
      const cleaned = { ...response, results: (response.results || []).filter((item) => item?.id) };
      searchSetStmt.run({ id: cacheKey, query: cleanQuery, media_type: "collection", page: safePage, response: toJson(cleaned), missing: cleaned.results.length ? 0 : 1, updated_at_ms: Date.now() });
      return cleaned;
    } catch (error) {
      if (cached?.response) return { ...cached.response, cache_stale: true };
      throw error;
    }
  });
}

// Other names TMDB records for a title ("Mako Mermaids" for Mako: Island of Secrets).
export async function getTmdbAlternativeTitles({ mediaType, tmdbId, lane = "sync" } = {}) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const id = String(tmdbId || "").trim();
  if (!/^\d+$/.test(id)) return [];
  return collapse(`alternative_titles:${type}:${id}`, async () => {
    const cacheId = `${type}_alternative_titles_${id}`;
    const cached = metaGet(cacheId);
    if (cached?.details && fresh(cached, 30 * DAY_MS)) return cached.details.titles;
    try {
      const response = await upstream(`${type}/${id}/alternative_titles`, {}, 0, { lane });
      const titles = [...new Set((response.results || response.titles || [])
        .map((entry) => String(entry?.title || "").trim()).filter(Boolean))];
      // No tmdbId: lookups by TMDB id must keep finding the details row, not this one.
      metaSet(cacheId, { tmdbId: null, mediaType: `${type}_alternative_titles`, details: { titles }, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
      return titles;
    } catch (error) {
      if (cached?.details) return cached.details.titles;
      throw error;
    }
  });
}

export async function getTmdbCollection(collectionId) {
  const id = String(collectionId || "").trim();
  if (!/^\d+$/.test(id)) {
    const error = new Error("A valid TMDB collection id is required");
    error.status = 400;
    throw error;
  }
  return collapse(`collection:${id}`, async () => {
    const cacheId = `collection_details_${id}`;
    const cached = metaGet(cacheId);
    if (cached?.details && fresh(cached, 7 * DAY_MS)) return cached.details;
    try {
      const response = await upstream(`collection/${id}`, {});
      const details = {
        id: response.id,
        name: response.name || "",
        overview: response.overview || "",
        poster_path: response.poster_path || "",
        backdrop_path: response.backdrop_path || "",
        parts: (response.parts || []).filter((item) => item?.id).slice(0, 40),
      };
      metaSet(cacheId, { tmdbId: id, mediaType: "collection", title: details.name, details, schemaVersion: DETAILS_SCHEMA_VERSION, updatedAtMs: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
}

function recommendationCacheKey(type, tmdbId) {
  return hash(`recommendations:v2|${type}|${tmdbId}`);
}

async function getTmdbRecommendationsForId(type, tmdbId) {
  const cacheKey = recommendationCacheKey(type, tmdbId);
  return collapse(`recommendations:${cacheKey}`, async () => {
    const row = searchGetStmt.get(cacheKey);
    const cached = row ? { response: parseJson(row.response), missing: Boolean(row.missing), updatedAtMs: row.updated_at_ms } : null;
    if (cached && fresh(cached, cached.missing ? MISSING_TTL_MS : RECOMMENDATION_TTL_MS)) return cached.response;

    try {
      const response = await upstream(`${type}/${encodeURIComponent(tmdbId)}/recommendations`, { page: 1 });
      const cleaned = {
        page: response.page || 1,
        total_pages: response.total_pages || 1,
        results: (response.results || [])
          .filter((item) => item?.id)
          .slice(0, RECOMMENDATION_RESULTS_PER_SEED)
          .map((item) => ({ ...item, media_type: type })),
      };
      searchSetStmt.run({
        id: cacheKey,
        query: String(tmdbId),
        media_type: `recommendations:${type}`,
        page: 1,
        response: toJson(cleaned),
        missing: cleaned.results.length ? 0 : 1,
        updated_at_ms: Date.now(),
      });
      return cleaned;
    } catch (error) {
      if (cached?.response) return { ...cached.response, cache_stale: true };
      throw error;
    }
  });
}

async function recommendationsForSeed(seed = {}) {
  const type = mediaTypeFor(seed.mediaType || seed.media_type);
  const title = String(seed.title || seed.name || "").trim();
  const ids = seed.ids || {
    imdbId: seed.imdbId || seed.imdb_id || seed.imdb || "",
    tvdbId: seed.tvdbId || seed.tvdb_id || seed.tvdb || "",
  };
  let tmdbId = String(seed.tmdbId || seed.tmdb_id || "").trim();
  if (!/^\d+$/.test(tmdbId)) tmdbId = await resolveTmdbId(type, "", title, ids);
  if (!/^\d+$/.test(tmdbId)) return null;

  try {
    return { seed, tmdbId, response: await getTmdbRecommendationsForId(type, tmdbId) };
  } catch (error) {
    // Episode-level or stale provider ids can occasionally be stored on a show
    // row. Resolve by the stable title/provider ids before giving up on that seed.
    const fallbackId = await resolveTmdbId(type, "", title, ids, { ignoreTmdbId: true }).catch(() => "");
    if (!/^\d+$/.test(fallbackId) || fallbackId === tmdbId) throw error;
    return { seed, tmdbId: fallbackId, response: await getTmdbRecommendationsForId(type, fallbackId) };
  }
}

function recommendationSeedWeight(seed = {}, now = Date.now()) {
  const watchedAtMs = Date.parse(String(seed.watchedAt || seed.watched_at || ""));
  const ageDays = Number.isFinite(watchedAtMs)
    ? Math.max(0, (now - watchedAtMs) / DAY_MS)
    : RECOMMENDATION_RECENCY_HALF_LIFE_DAYS;
  // Watching something repeatedly is a useful preference signal, but a long
  // series should not outweigh every recent movie simply because it has more
  // episodes in the ledger.
  const repeatCount = Math.max(1, Number(seed.watchCount || seed.watch_count || 1));
  const repeatWeight = 1 + Math.min(1.25, Math.log2(repeatCount) * 0.35);
  const recencyWeight = 0.4 + 1.6 * (2 ** (-ageDays / RECOMMENDATION_RECENCY_HALF_LIFE_DAYS));
  return repeatWeight * recencyWeight;
}

function recommendationDateIsRecent(item = {}, now = Date.now()) {
  const dateValue = item.first_air_date || item.release_date || "";
  const releaseMs = Date.parse(String(dateValue));
  if (!Number.isFinite(releaseMs)) return false;
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
  return releaseMs >= cutoff.getTime();
}

function selectRecommendationSeeds(seeds = [], requestedType = "all") {
  const now = Date.now();
  const ranked = (Array.isArray(seeds) ? seeds : [])
    .filter(Boolean)
    .filter((seed) => requestedType === "all" || mediaTypeFor(seed.mediaType || seed.media_type) === requestedType)
    .map((seed) => ({ seed, weight: recommendationSeedWeight(seed, now) }))
    .sort((a, b) => (
      b.weight - a.weight
      || String(b.seed?.watchedAt || b.seed?.watched_at || "").localeCompare(String(a.seed?.watchedAt || a.seed?.watched_at || ""))
    ));

  if (requestedType !== "all") return ranked.slice(0, MAX_RECOMMENDATION_SEEDS).map(({ seed }) => seed);

  // In the combined rail, reserve half the seed budget for each medium when
  // both exist. This prevents a user's episode-heavy TV history from hiding
  // their movie taste (or vice versa), while still filling the remaining
  // slots from whichever medium has more useful history.
  const selected = [];
  const selectedSet = new Set();
  for (const type of ["movie", "tv"]) {
    for (const entry of ranked.filter(({ seed }) => mediaTypeFor(seed.mediaType || seed.media_type) === type).slice(0, MAX_RECOMMENDATION_SEEDS_PER_TYPE)) {
      selected.push(entry);
      selectedSet.add(entry.seed);
    }
  }
  for (const entry of ranked) {
    if (selected.length >= MAX_RECOMMENDATION_SEEDS || selectedSet.has(entry.seed)) continue;
    selected.push(entry);
    selectedSet.add(entry.seed);
  }
  return selected.slice(0, MAX_RECOMMENDATION_SEEDS).map(({ seed }) => seed);
}

export async function getTmdbRecommendations({ seeds = [], mediaType = "all", genreId = "" } = {}) {
  const requestedType = ["movie", "tv", "all"].includes(String(mediaType).toLowerCase())
    ? String(mediaType).toLowerCase()
    : "all";
  const genre = /^\d+$/.test(String(genreId || "")) ? String(genreId) : "";
  const selectedSeeds = selectRecommendationSeeds(seeds, requestedType);

  if (!selectedSeeds.length) {
    return { media_type: requestedType, genre_id: genre, page: 1, total_pages: 1, results: [] };
  }

  const settled = await Promise.allSettled(selectedSeeds.map((seed) => recommendationsForSeed(seed)));
  const sourceIds = new Set();
  const ranked = new Map();
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled" || !outcome.value?.response) continue;
    const seedType = mediaTypeFor(outcome.value.seed.mediaType || outcome.value.seed.media_type);
    sourceIds.add(`${seedType}:${outcome.value.tmdbId}`);
  }
  settled.forEach((outcome) => {
    if (outcome.status !== "fulfilled" || !outcome.value?.response) return;
    const { seed, response } = outcome.value;
    const seedType = mediaTypeFor(seed.mediaType || seed.media_type);
    const seedWeight = recommendationSeedWeight(seed);
    for (const [resultIndex, item] of (response.results || []).entries()) {
      const resultType = mediaTypeFor(item.media_type || seedType);
      if (requestedType !== "all" && resultType !== requestedType) continue;
      // Discover cards are poster-led, and a bare TMDB id cannot be resolved
      // by the generic poster lookup without the recommendation's media type
      // and title. Skip posterless candidates instead of showing a blank tile.
      if (!String(item.poster_path || "").trim()) continue;
      if (!recommendationDateIsRecent(item)) continue;
      if (genre && (!Array.isArray(item.genre_ids) || !item.genre_ids.includes(Number(genre)))) continue;
      const id = String(item.id || "").trim();
      if (!id || sourceIds.has(`${resultType}:${id}`)) continue;
      const key = `${resultType}:${id}`;
      const score = seedWeight * (RECOMMENDATION_RESULTS_PER_SEED - resultIndex);
      const existing = ranked.get(key);
      if (existing) {
        existing.score += score;
        existing.support += 1;
        continue;
      }
      ranked.set(key, { item: { ...item, media_type: resultType }, score, support: 1 });
    }
  });

  return {
    media_type: requestedType,
    genre_id: genre,
    page: 1,
    total_pages: 1,
    results: [...ranked.values()]
      .sort((a, b) => (
        b.score - a.score
        || b.support - a.support
        || Number(b.item.popularity || 0) - Number(a.item.popularity || 0)
        || String(a.item.title || a.item.name || "").localeCompare(String(b.item.title || b.item.name || ""))
      ))
      .slice(0, RECOMMENDATION_RESULT_LIMIT)
      .map(({ item }) => item),
  };
}

function discoveryCacheResponse(cacheKey) {
  const row = searchGetStmt.get(cacheKey);
  if (!row) return null;
  return { response: parseJson(row.response), missing: Boolean(row.missing), updatedAtMs: row.updated_at_ms };
}

function discoveryRequest({ mediaType = "all", genreId = "" } = {}) {
  const type = ["movie", "tv", "all"].includes(String(mediaType).toLowerCase())
    ? String(mediaType).toLowerCase()
    : "all";
  const genre = /^\d+$/.test(String(genreId || "")) ? String(genreId) : "";
  // Version the key when the rail shape changes so an older cached response
  // cannot restore rails that are no longer part of Discover.
  return { type, genre, cacheKey: hash(`discover:v4|${type}|${genre}`) };
}

function discoverySpecs(type, genre) {
  // Keep the Discover page focused: the type selector changes the rails to the
  // selected medium, while a genre swaps the secondary popularity rail for a
  // genre-specific one. Recommendations are appended separately by the route.
  const specs = [];
  if (type === "all") {
    specs.push(["trending_movies", "trending/movie/week", { include_adult: false }, "movie"]);
    specs.push(["trending_shows", "trending/tv/week", { include_adult: false }, "tv"]);
    if (genre) {
      specs.push(["genre_movies", "discover/movie", { page: 1, include_adult: false, with_genres: genre, sort_by: "popularity.desc" }, "movie"]);
      specs.push(["genre_shows", "discover/tv", { page: 1, include_adult: false, with_genres: genre, sort_by: "popularity.desc" }, "tv"]);
    } else {
      specs.push(["new_movies", "movie/now_playing", { page: 1, include_adult: false }, "movie"]);
    }
  } else if (type === "movie") {
    specs.push(["trending_movies", "trending/movie/week", { include_adult: false }, "movie"]);
    specs.push([genre ? "genre_movies" : "popular_movies", "discover/movie", {
      page: 1,
      include_adult: false,
      ...(genre ? { with_genres: genre } : {}),
      sort_by: "popularity.desc",
    }, "movie"]);
    specs.push(["new_movies", "movie/now_playing", { page: 1, include_adult: false }, "movie"]);
    specs.push(["upcoming_movies", "movie/upcoming", { page: 1, include_adult: false }, "movie"]);
  } else {
    specs.push(["trending_shows", "trending/tv/week", { include_adult: false }, "tv"]);
    specs.push([genre ? "genre_shows" : "popular_shows", "discover/tv", {
      page: 1,
      include_adult: false,
      ...(genre ? { with_genres: genre } : {}),
      sort_by: "popularity.desc",
    }, "tv"]);
    specs.push(["on_air_shows", "tv/on_the_air", { page: 1, include_adult: false }, "tv"]);
  }
  return specs;
}

async function refreshDiscoveryCache(request) {
  const entries = await Promise.all(discoverySpecs(request.type, request.genre).map(async ([key, path, params, itemType]) => {
    const response = await upstream(path, params);
    const results = (response.results || []).filter((item) => item?.id).slice(0, 30).map((item) => ({
      ...item,
      media_type: itemType,
    }));
    return [key, { page: response.page || 1, total_pages: response.total_pages || 1, results }];
  }));
  const payload = { media_type: request.type, genre_id: request.genre, feeds: Object.fromEntries(entries) };
  const hasResults = entries.some(([, feed]) => feed.results.length);
  const previous = discoveryCacheResponse(request.cacheKey)?.response || null;
  searchSetStmt.run({
    id: request.cacheKey,
    query: request.genre,
    media_type: `discover:${request.type}`,
    page: 1,
    response: toJson(payload),
    missing: hasResults ? 0 : 1,
    updated_at_ms: Date.now(),
  });
  if (JSON.stringify(previous) !== JSON.stringify(payload)) bumpDiscoverVersion();
  return payload;
}

function beginDiscoveryRefresh(request, { force = false } = {}) {
  const existing = discoveryRefreshes.get(request.cacheKey);
  if (existing) return existing;

  const lastRequestedAt = Number(discoveryRefreshRequestedAt.get(request.cacheKey) || 0);
  if (!force && Date.now() - lastRequestedAt < DISCOVERY_REVALIDATE_MIN_INTERVAL_MS) return null;
  discoveryRefreshRequestedAt.set(request.cacheKey, Date.now());

  const promise = refreshDiscoveryCache(request).finally(() => {
    discoveryRefreshes.delete(request.cacheKey);
  });
  discoveryRefreshes.set(request.cacheKey, promise);
  // Background revalidation is intentionally detached from the request. Mark
  // the rejection as handled while retaining the original promise for a
  // forced request that arrives before the refresh completes.
  promise.catch((error) => {
    console.warn(`Discover cache refresh failed for ${request.type}${request.genre ? ` / genre ${request.genre}` : ""}: ${error.message}`);
  });
  return promise;
}

export async function getTmdbDiscovery({ mediaType = "all", genreId = "", force = false, revalidate = false } = {}) {
  const request = discoveryRequest({ mediaType, genreId });
  return collapse(`discover:${request.cacheKey}`, async () => {
    const cached = discoveryCacheResponse(request.cacheKey);
    if (!force && cached?.response) {
      if (revalidate) {
        if (!fresh(cached, SEARCH_TTL_MS)) beginDiscoveryRefresh(request);
        return cached.response;
      }
      if (fresh(cached, SEARCH_TTL_MS)) return cached.response;
    }

    try {
      return await beginDiscoveryRefresh(request, { force: true });
    } catch (error) {
      if (cached?.response) return { ...cached.response, cache_stale: true };
      throw error;
    }
  });
}

// Seasons only exist for TV, so this is entirely TVDB-backed now - it resolves
// the TVDB ID off the show details already cached under tv_{tmdbId} (getTmdbDetails
// always runs first in every caller's flow) and fetches episodes from TVDB.
// One uncached page of TMDB Discover, for automatic playlists with the
// catalogue source (plan/archive/custom-playlist-sync step 8b). Throws on any failure.
export async function discoverTmdbPage({ mediaType = "movie", params = {}, lane = "enrichment" } = {}) {
  if (isDemoMode()) {
    const error = new Error("TMDB Discover is not available in demo mode");
    error.status = 503;
    throw error;
  }
  const type = mediaTypeFor(mediaType) === "tv" ? "tv" : "movie";
  return upstream(`discover/${type}`, { include_adult: false, ...params }, 0, { lane });
}

// One uncached page of TMDB's weekly trending list, for automatic playlists
// of the Trending type (step 8g). Throws on any failure.
export async function trendingTmdbPage({ mediaType = "movie", page = 1, lane = "enrichment" } = {}) {
  if (isDemoMode()) {
    const error = new Error("TMDB Trending is not available in demo mode");
    error.status = 503;
    throw error;
  }
  const type = mediaTypeFor(mediaType) === "tv" ? "tv" : "movie";
  return upstream(`trending/${type}/week`, { include_adult: false, page }, 0, { lane });
}

// TMDB season episode lists, used only when a show's season source is TMDB.
// Stored in tmdb_season_cache and shaped like getTvdbSeasonEpisodes' output so
// callers do not care which provider supplied the episodes.
const TMDB_SEASON_TTL_MS = 2 * DAY_MS;
const tmdbSeasonGetStmt = db.prepare("SELECT details, updated_at_ms FROM tmdb_season_cache WHERE id = ?");
const tmdbSeasonSetStmt = db.prepare(
  `INSERT INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms)
   VALUES (@id, @tmdb_id, @season_number, @show_status, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tmdb_id=excluded.tmdb_id, season_number=excluded.season_number,
     show_status=excluded.show_status, details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

function shapeTmdbSeason(details) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  return {
    episodes: episodes.map((episode) => ({
      id: episode.id,
      episode_number: episode.episode_number,
      name: episode.name || "",
      overview: episode.overview || "",
      air_date: episode.air_date || "",
      still_path: episode.still_path ? `${IMAGE_ROOT}/w300${episode.still_path}` : "",
      runtime: episode.runtime ?? null,
    })),
  };
}

function episodeDateValue(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

// Match the selected provider's episode rows to the complementary provider by
// the same air-date numbering map used by Fix Match. Keep a same-number match
// when one date is missing, but do not guess across a numbering difference.
function matchingEpisodeText(sourceEpisode, targetEpisodes, map, seasonNumber) {
  const match = translateEpisode(map, seasonNumber, sourceEpisode.episode_number);
  if (!match) return null;
  const target = targetEpisodes.find((episode) => Number(episode.episode_number) === Number(match.episode));
  if (!target) return null;
  const sourceDate = episodeDateValue(sourceEpisode.air_date);
  const targetDate = episodeDateValue(target.air_date);
  if (sourceDate === null || targetDate === null) {
    return Number(sourceEpisode.episode_number) === Number(target.episode_number) ? target : null;
  }
  return Math.abs(sourceDate - targetDate) <= DAY_MS ? target : null;
}

function mergeEpisodeText(primary, secondary, seasonNumber, { preferSecondary = false } = {}) {
  const primaryEpisodes = Array.isArray(primary?.episodes) ? primary.episodes : [];
  const secondaryEpisodes = Array.isArray(secondary?.episodes) ? secondary.episodes : [];
  if (!primaryEpisodes.length || !secondaryEpisodes.length) return primary;
  const map = buildEpisodeNumberMap({
    from: [{ season: seasonNumber, episodes: primaryEpisodes }],
    to: [{ season: seasonNumber, episodes: secondaryEpisodes }],
  });
  return {
    ...primary,
    episodes: primaryEpisodes.map((episode) => {
      const matched = matchingEpisodeText(episode, secondaryEpisodes, map, seasonNumber);
      if (!matched) return episode;
      const preferred = preferSecondary ? matched : episode;
      const fallback = preferSecondary ? episode : matched;
      return {
        ...episode,
        name: String(preferred?.name || "").trim() || String(fallback?.name || ""),
        overview: String(preferred?.overview || "").trim() || String(fallback?.overview || ""),
      };
    }),
  };
}

function needsEpisodeTextFallback(season = {}) {
  return (Array.isArray(season.episodes) ? season.episodes : []).some((episode) => (
    !String(episode?.name || "").trim() || !String(episode?.overview || "").trim()
  ));
}

export async function getTmdbSeasonEpisodes({ tmdbId, seasonNumber, lane = "enrichment" }) {
  const id = String(tmdbId || "");
  const number = Number(seasonNumber);
  const cacheId = `${id}_${number}`;
  const row = tmdbSeasonGetStmt.get(cacheId);
  if (row && Date.now() - Number(row.updated_at_ms || 0) < TMDB_SEASON_TTL_MS) return shapeTmdbSeason(parseJson(row.details));
  let season;
  try {
    season = await upstream(`tv/${id}/season/${number}`, { language: "en-US" }, 0, { lane });
  } catch (error) {
    // A season TMDB does not have is cached as empty, so every page load does not repeat the request.
    if (Number(error?.status) !== 404) throw error;
    season = { episodes: [] };
  }
  tmdbSeasonSetStmt.run({ id: cacheId, tmdb_id: id, season_number: number, show_status: null, details: toJson(season), updated_at_ms: Date.now() });
  return shapeTmdbSeason(season);
}

// Cache-only companion for Up Next and the dashboard: it returns stale rows and never calls TMDB.
export function getCachedTmdbSeasonEpisodes({ tmdbId, seasonNumber }) {
  const row = tmdbSeasonGetStmt.get(`${String(tmdbId || "")}_${Number(seasonNumber)}`);
  const details = row ? parseJson(row.details) : null;
  return details && typeof details === "object" ? shapeTmdbSeason(details) : null;
}

// Every TMDB season's episode list for one show, in the shape the season
// readers return. Season numbers come from TMDB's own show record, not the
// TVDB-shaped details. cachedOnly reads only seasons already in the cache.
const tmdbSeasonNumbersStmt = db.prepare("SELECT season_number FROM tmdb_season_cache WHERE tmdb_id = ? ORDER BY season_number");

export async function getTmdbShowSeasonLists({ tmdbId, cachedOnly = false, lane = "enrichment" }) {
  const id = String(tmdbId || "");
  if (!id) return [];
  if (cachedOnly) {
    return tmdbSeasonNumbersStmt.all(id)
      .map(({ season_number: season }) => ({ season, episodes: getCachedTmdbSeasonEpisodes({ tmdbId: id, seasonNumber: season })?.episodes || [] }));
  }
  // Offline or rate-limited: the seasons already cached are still a usable map.
  const show = await upstream(`tv/${id}`, {}, 0, { lane }).catch(() => null);
  if (!show) return getTmdbShowSeasonLists({ tmdbId: id, cachedOnly: true });
  const numbers = (Array.isArray(show?.seasons) ? show.seasons : [])
    .map((season) => Number(season.season_number))
    .filter((number) => Number.isInteger(number) && number >= 0);
  const lists = [];
  for (const season of numbers) {
    lists.push({ season, episodes: (await getTmdbSeasonEpisodes({ tmdbId: id, seasonNumber: season, lane })).episodes });
  }
  return lists;
}

export async function getTmdbSeason({ tmdbId, tvdbId: requestedTvdbId = "", seasonNumber, lane = "enrichment" }) {
  const id = String(tmdbId || "");
  const directTvdbId = String(requestedTvdbId || "");
  const number = Number(seasonNumber);
  if ((!id && !directTvdbId) || !Number.isInteger(number) || number < 0) {
    const error = new Error("A TMDB or TVDB ID and a valid seasonNumber are required");
    error.status = 400;
    throw error;
  }
  // Shows that only exist on TVDB are cached under `tv_tvdb_<id>` because they
  // have no TMDB id to key on, so accept the TVDB id directly as well.
  // TV metadata can be cached under the TVDB alias when the provider resolved
  // the show through TVDB first. Still accept a TMDB-id season request by
  // looking up that alias through the mirrored tmdb_id column; otherwise the
  // client receives a valid merged show but its episode list stays empty.
  const cached = id
    ? (metaGet(`tv_${id}`) || metaGet(`tv_tvdb_${id}`) || metaGetByTmdbId(id))
    : metaGetByTvdbId(directTvdbId);
  const tvdbId = directTvdbId || String(cached?.details?.external_ids?.tvdb_id || "");
  if (!tvdbId) {
    const error = new Error("TVDB ID not resolved for this show yet");
    error.status = 404;
    throw error;
  }
  if (isDemoMode()) {
    const bundled = getCachedTvdbSeasonEpisodes({ tvdbId, seasonNumber: number });
    if (bundled) return bundled;
    const error = new Error("Demo season metadata is not bundled for this title");
    error.status = 404;
    throw error;
  }
  // The show's season source is saved on its first read (write-once). Keep its
  // numbering and non-text metadata, while preferring English TMDB text where
  // the episode maps safely by air date. Missing text falls back per field.
  const seasonSource = resolveAndRecordSeasonSource(tvdbId);
  if (seasonSource === "tmdb") {
    const tmdbSeasonId = id || String(cached?.details?.id || metaGet(`tv_tvdb_${tvdbId}`)?.details?.id || "");
    const tmdbSeason = tmdbSeasonId
      ? await getTmdbSeasonEpisodes({ tmdbId: tmdbSeasonId, seasonNumber: number, lane }).catch(() => null)
      : null;
    if (tmdbSeason?.episodes?.length) {
      if (needsEpisodeTextFallback(tmdbSeason)) {
        const tvdbSeason = await getTvdbSeasonEpisodes({ tvdbId, seasonNumber: number, lane }).catch(() => null);
        return mergeEpisodeText(tmdbSeason, tvdbSeason, number);
      }
      return tmdbSeason;
    }
  }
  const tvdbSeason = await getTvdbSeasonEpisodes({ tvdbId, seasonNumber: number, lane });
  if (!tvdbSeason?.episodes?.length) return tvdbSeason;
  const originalLanguage = String(cached?.details?.original_language || "").trim().toLowerCase();
  if (originalLanguage === "en") return tvdbSeason;
  const tmdbSeasonId = id || String(cached?.details?.id || metaGet(`tv_tvdb_${tvdbId}`)?.details?.id || "");
  const englishSeason = tmdbSeasonId
    ? await getTmdbSeasonEpisodes({ tmdbId: tmdbSeasonId, seasonNumber: number, lane }).catch(() => null)
    : null;
  return mergeEpisodeText(tvdbSeason, englishSeason, number, { preferSecondary: true });
}

// Cache-only companion for Up Next. It deliberately accepts stale season rows:
// a background metadata warm-up will refresh them, but a dashboard request must
// never block on TVDB when a season is missing or past its freshness window.
export function getCachedTmdbSeason({ tmdbId = "", tvdbId: requestedTvdbId = "", seasonNumber } = {}) {
  const id = String(tmdbId || "");
  const directTvdbId = String(requestedTvdbId || "");
  const number = Number(seasonNumber);
  if ((!id && !directTvdbId) || !Number.isInteger(number) || number < 0) return null;
  const metadata = getCachedTmdbDetails({ mediaType: "tv", tmdbId: id, ids: { tvdbId: directTvdbId } });
  const tvdbId = directTvdbId || String(metadata?.external_ids?.tvdb_id || "");
  if (!tvdbId) return null;
  // Up Next is the only caller and resolves its result to media server items,
  // so it follows the numbering the show's stored rows use. That is the
  // season source unless Fix Match set a translated per-show choice.
  if (readShowNumbering(tvdbId).rowNumbering === "tmdb") {
    const tmdbSeason = getCachedTmdbSeasonEpisodes({ tmdbId: id || String(metadata?.id || ""), seasonNumber: number });
    if (tmdbSeason?.episodes?.length) return tmdbSeason;
  }
  return getCachedTvdbSeasonEpisodes({ tvdbId, seasonNumber: number });
}

export async function getTmdbPerson(personId, { lane = "enrichment" } = {}) {
  const id = String(personId || "");
  return collapse(`person:${id}`, async () => {
    const row = personGetStmt.get(`person_${id}`);
    const cached = row ? { details: parseJson(row.details), schemaVersion: row.schema_version, updatedAtMs: row.updated_at_ms } : null;
    if (cached?.details && cached.schemaVersion >= PERSON_SCHEMA_VERSION && fresh(cached, PERSON_TTL_MS)) return cached.details;
    try {
      const fetched = await upstream(`person/${id}`, { append_to_response: "combined_credits,images,tagged_images,external_ids" }, 0, { lane });
      const details = {
        ...fetched,
        combined_credits: {
          ...(fetched.combined_credits || {}),
          cast: fetched.combined_credits?.cast || [],
          crew: fetched.combined_credits?.crew || [],
        },
        images: { profiles: (fetched.images?.profiles || []).slice(0, 200) },
        tagged_images: boundedResults(fetched.tagged_images, 250) || { results: [] },
      };
      personSetStmt.run({ id: `person_${id}`, person_id: id, details: toJson(details), schema_version: PERSON_SCHEMA_VERSION, updated_at_ms: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return { ...cached.details, cache_stale: true };
      throw error;
    }
  });
}

export async function getTmdbImages({ mediaType, tmdbId, title = "", ids = {}, lane = "enrichment" }) {
  const details = await getTmdbDetails({ mediaType, tmdbId, title, ids, lane });
  const images = imageGroups(details);
  if (hasImageCandidates(images)) return images;

  try {
    const refreshed = await getTmdbDetails({ mediaType, tmdbId, title, ids, force: true, lane });
    return imageGroups(refreshed);
  } catch {
    return imageGroups(details);
  }
}

export async function prewarmTmdbLibrary({ limit = 0 } = {}) {
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (runtime.lastTmdbPrewarmAt && Date.now() - Number(runtime.lastTmdbPrewarmAt) < PREWARM_INTERVAL_MS) return { skipped: true };
  // Include active resume rows as well as completed history. The dashboard's
  // Part Watched rail is sourced from playback_progress, so a history-only
  // warm-up can leave a newly resumed episode without the show artwork even
  // though the rest of the library is fully warmed.
  const rows = [...recentProgressStmt.all(), ...recentWatchStmt.all()];
  const items = [];
  const seen = new Set();
  for (const data of rows) {
    const mediaType = data.media_type === "movie" ? "movie" : data.media_type === "episode" ? "tv" : "";
    // Episode rows commonly carry episode-level ids. Leave TMDB empty for TV
    // here so getTvShowDetails can resolve a TVDB episode id to its parent
    // series instead of caching an episode id as the show id.
    const tmdbId = String(mediaType === "tv" ? "" : data.tmdb_id || "");
    // watch_history stores the media-server's leaf identifiers on episode
    // rows. They are useful for watch identity, but are not safe show ids for
    // a scheduler backstop, so let the title resolve path find the parent
    // series. Library-added/provider-feed events supply explicit show ids when
    // they have them.
    const tvdbId = String(mediaType === "tv" ? "" : data.tvdb_id || "");
    const imdbId = String(mediaType === "tv" ? "" : data.imdb_id || "");
    const title = mediaType === "tv" ? data.show_title || showTitleFromWarmupTitle(data.title) : data.title;
    // Watched episode rows usually contain episode-level TVDB/IMDb ids, not
    // the parent show's identity. Deduplicate the title-only TV backstop so a
    // binge-watched series does not enqueue one provider lookup per episode.
    const key = mediaType === "tv"
      ? `${mediaType}:${canonicalTitle(title)}`
      : `${mediaType}:${tmdbId || tvdbId || imdbId || canonicalTitle(title)}`;
    if (!mediaType || seen.has(key)) continue;
    seen.add(key);
    items.push({ mediaType, tmdbId, title, ids: { tvdbId, imdbId } });
    if (Number(limit) > 0 && items.length >= Number(limit)) break;
  }
  const queued = queueTmdbMetadataWarmup(items, { reason: "scheduled-library-backstop" });
  await setRuntimeState({ lastTmdbPrewarmAt: Date.now() });
  return { queued: queued.queued, pending: queued.pending, scanned: items.length };
}

export function getCachedTvdbId(tmdbId) {
  if (!tmdbId) return "";
  const row = metaGetStmt.get(`tv_${tmdbId}`);
  if (!row?.details) return "";
  const details = parseJson(row.details);
  return String(details?.external_ids?.tvdb_id || "");
}

export async function getTmdbPosterUrl({ mediaType, tmdbId = "", title = "", ids = {} }) {
  const details = await getTmdbDetails({ mediaType, tmdbId, title, ids });
  return details.cached_poster_url || (details.poster_path ? `${IMAGE_ROOT}/w500${details.poster_path}` : null);
}
