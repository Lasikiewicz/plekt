import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin, resolveAdminPrincipal } from "../utils/auth.js";
import { readFormData, readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { fetchWithTimeout, assertSafeOutboundUrl } from "../utils/outbound.js";
import { AUTH, verifyWebhookToken } from "../appConfig.js";
import { db, parseJson, toJson, writeAuditLog } from "../db.js";
import { createLoopStore } from "../utils/loopStore.js";
import { listActiveSessions, deleteActiveSession, upsertActiveSession } from "../utils/activeSessions.js";
import { hydrateCachedSession, loadLiveTrackingCache } from "../utils/liveSessions.js";
import { runForceSync } from "../utils/forceSyncRun.js";
import { runScheduledSync } from "../scheduled.js";
import { appendSyncHistory, loadMediaConfig, mergeIncomingConfig, publicMediaConfig, saveMediaConfig, validateConfig, getSyncHistory, loadRuntimeState, setRuntimeState, appendRuntimeLog } from "../utils/configStore.js";
import { findPlexItem, markPlexPlayed, setPlexProgress, markPlexUnplayedByRatingKey, fetchPlexWatchedItems, fetchPlexMetadataItem, fetchPlexSeriesEpisodes } from "../utils/plexClient.js";
import { probePlexNotificationSocket } from "../utils/plexNotificationListener.js";
import { markEmbyPlayed, setEmbyProgress, markEmbyUnplayedById, fetchEmbyWatchedItems, findEmbyItems, fetchEmbySeriesEpisodes } from "../utils/embyClient.js";
import { markJellyfinPlayed, setJellyfinProgress, markJellyfinUnplayedById, fetchJellyfinWatchedItems, findJellyfinItems, fetchJellyfinSeriesEpisodes } from "../utils/jellyfinClient.js";
import { setJellyfinApiKey } from "../utils/jellyfinAuth.js";
import { normalizeProviderIds, parseCustomWebhook, parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } from "../utils/parsers.js";
import { getTargetsForSource, shouldSyncResumeProgress, syncMediaPlaystate, syncMediaProgress, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { watchedPlayedSyncEnabled } from "../utils/syncFlags.js";
import { fetchPosterFromTmdb } from "../utils/tmdbClient.js";
import { cacheBackdropFromUrl, cacheLogoFromUrl, cachePosterFromUrl, cacheProfileFromUrl, getPosterCache, markPosterMissing, usableCachedPoster } from "../utils/posterCache.js";
import { getTmdbDetails, getTmdbImages, getTmdbPerson, getTmdbSeason, searchTmdb, searchTmdbCollections, getTmdbCollection, getTmdbDiscovery, getTmdbRecommendations, getCachedTvdbId } from "../utils/tmdbGateway.js";
import { searchTvdbSeriesList, resolveTvdbSeriesId, getTvdbSeriesArtwork } from "../utils/tvdbGateway.js";
import { getUpcomingCalendarMonth } from "../utils/upcomingCalendarCache.js";
import { withDisplaySeasons } from "../utils/showSeasonTranslation.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";
import { getUpNextCacheSnapshot } from "../utils/upNextCache.js";
import { buildUpNextProjection } from "../utils/upNextService.js";
import { refreshUpNextProviderFeeds } from "../utils/upNextProviderSync.js";
import { getActiveUpNextProviderItemById } from "../utils/upNextRepository.js";
import { listManualUpNextShows, removeManualUpNextShow, upsertManualUpNextShow } from "../utils/upNextManual.js";
import { restoreUpNextDismissalsForMedia } from "../utils/upNextDismissals.js";
import { providerArtworkPathsForCandidate } from "../utils/upNextIdentity.js";
import { getManualWatchReview } from "../utils/manualWatchReview.js";
import { getFanartMovieArt, getFanartTvArt, getAllFanartMovieImages, getAllFanartTvImages } from "../utils/fanartGateway.js";
import { getOmdbRating } from "../utils/omdbGateway.js";
import { createRecommendationExclusion, filterExcludedRecommendations } from "../utils/recommendationExclusions.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, PUBLIC_DIR } from "../paths.js";
import {
  countPlaybackProgressRows,
  countWatchedPlaystateRows,
  deletePlaybackProgress,
  deleteWatchRecord,
  deleteWatchRecordById,
  updateWatchRecord,
  mergeShows,
  getWatchRecordById,
  getWatchRecordByIdLight,
  getWatchRecordByMediaKey,
  getHistoryCacheVersion,
  getWatchStats,
  invalidateHistoryDerivedCaches,
  insertWatchRecord,
  listLibraryItemsForRefresh,
  relatedPosterRows,
  setWatchPosterUrls,
  setWatchBackdropUrl,
  listPlaybackProgressRowsForReplay,
  listWatchedPlaystateRowsForReplay,
  mediaToPlaybackProgressRecord,
  mediaToWatchRecord,
  mediaKeyFor,
  progressRowToMedia,
  querySyncJobs,
  queryMovies,
  queryShows,
  queryWatchHistory,
  queryWatchHistoryPreview,
  requireDb,
  updateWatchPosterUrl,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaybackProgress,
  upsertPlaystateForMedia,
  normalizeWatchRecordForInsert,
  watchRowToMedia,
  getCachedMovies,
  getCachedShows,
  getCachedHistory,
  findExistingWatch,
  findWatchedByAnyMediaKey,
  getPlaystateForMedia,
  countMissingPosterTraktRows,
  listMissingPosterTraktRows,
  stampWatchPoster,
  setWatchMediaType,
  loadWatchKeyGroupsForDedup,
  deleteWatchRecordsByIds,
  deleteMovieByWatchId,
  deletePosterCacheByMediaKey,
  backfillUnknownShowTitles,
  clearWatchArtworkUrls,
  seriesIdsForShowTitle,
} from "../utils/dataRepo.js";

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";
  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function posterPathFromMedia(media = {}) {
  if (media.posterUrl) return media.posterUrl;
  if (media.source === "plex" && media.poster?.path) return imagePath(media.poster.path);
  if ((media.source === "emby" || media.source === "jellyfin") && media.poster?.itemId) {
    return imagePath(`/Items/${encodeURIComponent(media.poster.itemId)}/Images/Primary`, { tag: media.poster.tag });
  }
  return "";
}

function configForPosterSource(config = {}, source = "") {
  const key = String(source || "").toLowerCase();
  if (key.includes("plex")) return { ...config.plex, source: "plex" };
  if (key.includes("emby")) return { ...config.emby, source: "emby" };
  if (key.includes("jellyfin")) return { ...config.jellyfin, source: "jellyfin" };
  return {};
}

function configuredPosterUrl(path = "", source = "", config = {}) {
  const raw = String(path || "").trim();
  const server = configForPosterSource(config, source);
  const baseUrl = String(server.baseUrl || server.url || "").trim().replace(/\/+$/, "");
  if (!raw || !baseUrl) return "";

  try {
    const url = new URL(raw, `${baseUrl}/`);
    if (server.source === "plex" && (server.token || server.apiKey)) {
      url.searchParams.set("X-Plex-Token", server.token || server.apiKey);
    }
    if (server.source === "emby" && (server.apiKey || server.api_key)) {
      url.searchParams.set("api_key", server.apiKey || server.api_key);
    }
    if (server.source === "jellyfin") setJellyfinApiKey(url, server);
    return url.toString();
  } catch (error) {
    return "";
  }
}

function isHttpsUrl(value = "") {
  return /^https:\/\//i.test(String(value || "").trim());
}

function isHttpUrl(value = "") {
  return /^http:\/\//i.test(String(value || "").trim());
}

function isCachedStorageUrl(value = "") {
  const raw = String(value || "").trim();
  // Locally cached artwork is served from /media/posters or /media/backdrops.
  return raw.startsWith("/media/posters/") || raw.startsWith("/media/backdrops/");
}

const inflight = new Map();

async function findLiveSessionPosterRow(mediaKey) {
  if (!mediaKey) return null;
  const [cacheRows, activeRows] = await Promise.all([
    loadLiveTrackingCache({ includeCompleted: false }).catch(() => []),
    listActiveSessions().catch(() => []),
  ]);
  const sessions = [...cacheRows.map(hydrateCachedSession), ...activeRows];
  for (const session of sessions) {
    if (mediaKeyFor(session) !== mediaKey) continue;
    const ids = session.ids || {};
    return {
      id: mediaKey,
      media_key: mediaKey,
      title: session.title,
      media_type: session.mediaType || session.media_type,
      source: session.source,
      imdb_id: ids.imdb || null,
      tmdb_id: ids.tmdb || null,
      tvdb_id: ids.tvdb || null,
      season: session.season ?? null,
      episode: session.episode ?? null,
      poster_url: session.posterUrl || session.poster_url || null,
    };
  }
  return null;
}

// One poster lookup, independent of how the answer is delivered. `handlePoster`
// renders it as a single JSON body or an image redirect; `handlePosterBatch`
// collects a page's worth of them into one response. Both share this so the
// lookup order, the in-flight dedupe and the negative caching cannot drift
// apart between the two routes.
async function resolvePosterPayload({ rowId, provider = "", fallbackRequested = false, providerImageRequested = false }) {
  try {
    let manualReviewPoster = false;
    let row = provider ? getActiveUpNextProviderItemById(provider, rowId) : null;
    if (!row) {
      row = await getWatchRecordByIdLight(rowId);
    }
    if (!row) {
      row = await getWatchRecordByMediaKey(rowId).catch(() => null);
    }
    if (!row) {
      const review = getManualWatchReview(rowId);
      if (review) {
        const media = review.media || {};
        const ids = media.ids || {};
        const showIds = media.showIds || media.show_ids || {};
        const title = review.title || media.title || "Unknown media";
        const showTitle = review.show_title
          || media.showTitle
          || media.show_title
          || title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i)?.[1]
          || "";
        row = {
          id: review.id,
          media_key: review.media_key,
          title,
          media_type: review.media_type || media.type || media.media_type,
          source: review.source || media.source,
          imdb_id: ids.imdb || null,
          tmdb_id: ids.tmdb || null,
          tvdb_id: ids.tvdb || null,
          show_title: showTitle,
          show_imdb_id: showIds.imdb || media.showImdbId || media.show_imdb_id || null,
          show_tmdb_id: showIds.tmdb || media.showTmdbId || media.show_tmdb_id || null,
          show_tvdb_id: showIds.tvdb || media.showTvdbId || media.show_tvdb_id || null,
          season: review.season ?? media.season ?? null,
          episode: review.episode ?? media.episode ?? null,
          poster_url: media.posterUrl || media.poster_url || null,
          show_poster_url: media.showPosterUrl || media.show_poster_url || null,
          provider_item_id: review.source_item_id || media.itemId || media.item_id || media.providerItemId || media.provider_item_id || null,
          provider_items: media.providerItems || media.provider_items || {},
        };
        manualReviewPoster = true;
      }
    }
    if (!row) {
      const progressRow = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(rowId);
      if (progressRow) {
        // A resume position can carry the episode's own provider ids rather
        // than the series' (see utils/seriesIdentity.js). Artwork for an
        // episode is the show's artwork, and an episode id resolves to nothing
        // at TMDB/TVDB, so prefer the show's ids whenever they can be proven
        // from the watch history. repairEpisodeSeriesIdentity() rewrites these
        // rows properly; this keeps the card from rendering blank until it does.
        const seriesIds = progressRow.media_type === "episode" ? seriesIdsForShowTitle(progressRow.title) : null;
        row = {
          id: progressRow.media_key,
          media_key: progressRow.media_key,
          title: progressRow.title,
          media_type: progressRow.media_type,
          source: progressRow.source,
          imdb_id: seriesIds?.imdb || progressRow.imdb_id,
          tmdb_id: seriesIds?.tmdb || progressRow.tmdb_id,
          tvdb_id: seriesIds?.tvdb || progressRow.tvdb_id,
          show_imdb_id: seriesIds?.imdb || null,
          show_tmdb_id: seriesIds?.tmdb || null,
          show_tvdb_id: seriesIds?.tvdb || null,
          season: progressRow.season,
          episode: progressRow.episode,
          poster_url: null,
        };
      }
    }
    if (!row) {
      row = await findLiveSessionPosterRow(rowId).catch(() => null);
    }
    if (!row && rowId.includes("tmdb:")) {
      const tmdbIdMatch = rowId.match(/tmdb:(\d+)/i);
      if (tmdbIdMatch) {
        const tmdbId = tmdbIdMatch[1];
        const isMovie = !rowId.includes("episode") && !rowId.includes("tv");
        const progressRow = db.prepare("SELECT * FROM playback_progress WHERE tmdb_id = ? LIMIT 1").get(tmdbId);
        if (progressRow) {
          row = {
            id: rowId,
            media_key: progressRow.media_key,
            title: progressRow.title,
            media_type: progressRow.media_type,
            source: progressRow.source,
            imdb_id: progressRow.imdb_id,
            tmdb_id: progressRow.tmdb_id,
            tvdb_id: progressRow.tvdb_id,
            season: progressRow.season,
            episode: progressRow.episode,
            poster_url: null,
          };
        } else {
          row = {
            id: rowId,
            media_key: `tmdb:${isMovie ? "movie" : "tv"}:${tmdbId}`,
            title: "",
            media_type: isMovie ? "movie" : "episode",
            tmdb_id: tmdbId,
            poster_url: null,
          };
        }
      }
    }
    if (!row) return { payload: { error: "not found" }, status: 404 };

    const config = await loadMediaConfig().catch(() => ({}));
    const mediaKey = row.media_key || mediaKeyFor(row);
    const posterUpdateId = row.id || rowId;
    const persistResolvedPoster = async (url) => {
      if (manualReviewPoster) return;
      await updateWatchPosterUrl(posterUpdateId, url, { invalidate: false }).catch((error) => {
        console.error("Failed to persist cached poster URL", { id: row.id, title: row.title, error: error.message || String(error) });
      });
    };

    if (!fallbackRequested) {
      const canonicalPoster = getCanonicalPosterUrl(row);
      if (canonicalPoster) return { payload: { url: canonicalPoster, cached: true, source: "canonical" }, status: 200 };
    }

    // Check for fresh cached result first (before deduplication check).
    // However, ignore negative cache for items without poster_url - these should retry TMDB fallback.
    const cached = usableCachedPoster(await getPosterCache(mediaKey));
    if (cached?.url) return { payload: cached, status: 200 };
    // Provider image URLs are rendered directly by the browser. A previous
    // transient provider outage must not turn that image into a long-lived
    // blank placeholder; let the authenticated provider lookup retry it.
    if (cached?.cached && row.poster_url && !providerImageRequested) return { payload: cached, status: 200 };

    // If another request is already processing this mediaKey, wait for it to complete.
    if (inflight.has(mediaKey)) {
      await inflight.get(mediaKey);
      const recheck = usableCachedPoster(await getPosterCache(mediaKey));
      if (recheck?.url || recheck?.cached) return { payload: recheck, status: 200 };
      return { payload: { url: null, cached: true, source: "missing" }, status: 200 };
    }

    // Mark this mediaKey as inflight and process it.
    // Other concurrent requests will wait for this to complete.
    const processingPromise = (async () => {
      try {
        if (row.poster_url && !fallbackRequested && isCachedStorageUrl(row.poster_url)) {
          return { url: row.poster_url, cached: true, source: "storage" };
        }

        const candidates = [];
        if (row.poster_url && !fallbackRequested) {
          if (/^https?:\/\//i.test(row.poster_url)) candidates.push({ url: row.poster_url, source: "stored" });
          const configuredUrl = configuredPosterUrl(row.poster_url, row.source, config);
          if (configuredUrl) candidates.push({ url: configuredUrl, source: configForPosterSource(config, row.source).source || "configured" });
        }

        if (String(row.source || "").toLowerCase().includes("plex") && config.plex?.baseUrl && config.plex?.token) {
          const item = await findPlexItem(config.plex, {
            title: row.title,
            type: row.media_type,
            ids: { imdb: row.imdb_id || null, tmdb: row.tmdb_id || null, tvdb: row.tvdb_id || null },
            season: row.season ?? null,
            episode: row.episode ?? null,
          }).catch((error) => {
            console.error("Poster Plex lookup failed", { id: row.id, title: row.title, error: error.message || String(error) });
            return null;
          });
          const path = row.media_type === "episode"
            ? item?.grandparentThumb || item?.parentThumb || item?.thumb || item?.grandparentArt || item?.parentArt || item?.art || ""
            : item?.thumb || item?.parentThumb || item?.grandparentThumb || item?.art || item?.parentArt || item?.grandparentArt || "";
          if (path) {
            const configuredUrl = configuredPosterUrl(path, "plex", config);
            if (configuredUrl) candidates.push({ url: configuredUrl, source: "plex" });
          }
        }

        const rowSource = String(row.source || "").toLowerCase();
        if ((rowSource.includes("emby") || rowSource.includes("jellyfin"))
          && configForPosterSource(config, rowSource).baseUrl
          && configForPosterSource(config, rowSource).apiKey) {
          const providerConfig = rowSource.includes("jellyfin") ? config.jellyfin : config.emby;
          const providerClient = rowSource.includes("jellyfin") ? findJellyfinItems : findEmbyItems;
          const providerItems = await providerClient(providerConfig, {
            type: row.media_type,
            title: row.title,
            show_title: row.show_title,
            ids: {
              imdb: row.show_imdb_id || row.imdb_id || null,
              tmdb: row.show_tmdb_id || row.tmdb_id || null,
              tvdb: row.show_tvdb_id || row.tvdb_id || null,
            },
            season: row.season ?? null,
            episode: row.episode ?? null,
            provider_items: row.provider_items || {},
            provider_item_id: row.provider_item_id || null,
            series_provider_item_id: row.series_provider_item_id || null,
            parent_provider_item_id: row.parent_provider_item_id || null,
          }).catch((error) => {
            console.error("Poster provider lookup failed", { id: row.id, title: row.title, source: rowSource, error: error.message || String(error) });
            return [];
          });
          for (const providerItem of Array.isArray(providerItems) ? providerItems : []) {
            const paths = providerArtworkPathsForCandidate({
              provider: rowSource,
              media_type: row.media_type,
              provider_item_id: providerItem?.Id || providerItem?.id || row.provider_item_id,
              item: providerItem,
            });
            const path = paths.show_poster || paths.poster;
            const configuredUrl = configuredPosterUrl(path, rowSource, config);
            if (configuredUrl) {
              candidates.push({ url: configuredUrl, source: rowSource });
              break;
            }
          }
        }

        if (config.tmdb?.apiKey && (fallbackRequested || !row.poster_url || isHttpUrl(row.poster_url) || !/^https?:\/\//i.test(row.poster_url))) {
          const tmdbPoster = await fetchPosterFromTmdb(row, config.tmdb.apiKey).catch((error) => {
            console.error("Poster TMDB fallback failed", { id: row.id, title: row.title, error: error.message || String(error) });
            return null;
          });
          if (tmdbPoster) {
            candidates.push({ url: tmdbPoster, source: "tmdb" });
          }
        }

        const seen = new Set();
        for (const candidate of candidates) {
          if (!candidate.url || seen.has(candidate.url)) continue;
          seen.add(candidate.url);

          // If the URL is already a cached storage image, return it directly
          if (isCachedStorageUrl(candidate.url)) {
            await persistResolvedPoster(candidate.url);
            return { url: candidate.url, cached: true, source: candidate.source };
          }

          const cachedPoster = await cachePosterFromUrl(mediaKey, candidate.url, candidate.source);
          if (cachedPoster?.url) {
            await persistResolvedPoster(cachedPoster.url);
            return cachedPoster;
          }
        }
        await markPosterMissing(mediaKey, "poster", "No usable poster candidate").catch(() => null);
        return { url: null, cached: true, source: "missing" };
      } catch (error) {
        console.error("Poster processing failed", { id: rowId, mediaKey, error: error.message || String(error) });
        return null;
      }
    })();

    inflight.set(mediaKey, processingPromise);
    const result = await processingPromise;
    inflight.delete(mediaKey);

    if (result) {
      return { payload: result, status: 200 };
    }

    // If result is null (error occurred), try to return cached result or error response.
    const fallback = usableCachedPoster(await getPosterCache(mediaKey));
    if (fallback?.url || fallback?.cached) {
      return { payload: fallback, status: 200 };
    }
    return { payload: { url: null, cached: false, source: "error" }, status: 200 };
  } catch (error) {
    inflight.delete(rowId);
    console.error("Poster lookup failed", { id: rowId, error: error.message || String(error) });
    return { payload: { url: null, cached: false, source: "error" }, status: 200 };
  }
}

// A library page asks for one poster per card. Each of those was a separate
// request running requireAdmin, the full lookup chain and loadMediaConfig();
// a viewport's worth of cards therefore paid all of that N times over. This
// mirrors the existing tmdb-details-batch convention: bounded item list,
// bounded worker pool, one result per input position.
export async function handlePosterBatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, 240) : [];
  if (!items.length) return sendJson(res, { results: [] });

  const BATCH_CONCURRENCY = 6;
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      const rowId = String(item?.id ?? item ?? "").trim();
      if (!rowId) {
        results[index] = { id: "", payload: { url: null, cached: false, source: "invalid" } };
        continue;
      }
      try {
        const { payload } = await resolvePosterPayload({
          rowId,
          provider: String(item?.provider || "").trim().toLowerCase(),
          fallbackRequested: item?.fallback === true,
        });
        results[index] = { id: rowId, payload };
      } catch (error) {
        results[index] = { id: rowId, payload: { url: null, cached: false, source: "error" }, error: error.message || "failed" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));

  return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400", Vary: "Authorization" });
}

export async function handlePoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const cacheHeaders = { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400" };
  const imageRequested = String(req.query.format || "").trim().toLowerCase() === "image";
  const providerImageRequested = imageRequested && Boolean(String(req.query.provider || "").trim());
  const respondPoster = (payload, status = 200) => {
    if (!imageRequested) return sendJson(res, payload, status, cacheHeaders);
    if (payload?.url && isCachedStorageUrl(payload.url)) {
      return res.set(cacheHeaders).redirect(302, payload.url);
    }
    return res.status(status >= 400 ? status : 404).set(cacheHeaders).send("");
  };

  const { payload, status } = await resolvePosterPayload({
    rowId: String(req.query.id || ""),
    provider: String(req.query.provider || "").trim().toLowerCase(),
    fallbackRequested: ["1", "true", "yes"].includes(String(req.query.fallback || "").toLowerCase()),
    providerImageRequested,
  });
  return respondPoster(payload, status);
}

// Concurrency limiter for TMDB image downloads to avoid hitting rate limits.
// At most 8 downloads run simultaneously; extras queue until a slot frees.
const TMDB_POSTER_CONCURRENCY = 8;
// TMDB artwork can fail transiently even when the source image is available.
// Keep the favicon fallback brief so a later request can recover the poster.
const TMDB_POSTER_NEGATIVE_RETRY_MS = 60 * 1000;
let _tmdbPosterActive = 0;
const _tmdbPosterQueue = [];
const _tmdbPosterInflight = new Map();

function _acquireTmdbPosterSlot() {
  return new Promise((resolve) => {
    if (_tmdbPosterActive < TMDB_POSTER_CONCURRENCY) {
      _tmdbPosterActive++;
      resolve();
    } else {
      _tmdbPosterQueue.push(resolve);
    }
  });
}

function _releaseTmdbPosterSlot() {
  const next = _tmdbPosterQueue.shift();
  if (next) {
    next();
  } else {
    _tmdbPosterActive--;
  }
}

export async function handleTmdbPoster(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const posterPath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(posterPath)) {
    return sendJson(res, { error: "Invalid TMDB poster path" }, 400);
  }

  const tmdbId = String(req.query.tmdbId || "").trim();
  const mediaType = String(req.query.mediaType || "movie").toLowerCase() === "tv" ? "tv" : "movie";

  const mediaKey = `tmdb:poster:${posterPath}`;
  const posterCache = await getPosterCache(mediaKey);
  const cached = usableCachedPoster(posterCache);
  const negativeCacheStillCoolingDown = ["missing", "failed"].includes(posterCache?.status)
    && Date.now() - Number(posterCache?.updatedAtMs || 0) < TMDB_POSTER_NEGATIVE_RETRY_MS;
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached && negativeCacheStillCoolingDown) return res.redirect(302, "/favicon.svg");

  // Deduplicate concurrent requests for the same path.
  if (_tmdbPosterInflight.has(posterPath)) {
    await _tmdbPosterInflight.get(posterPath);
    const recheck = usableCachedPoster(await getPosterCache(mediaKey));
    if (recheck?.url) {
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return res.redirect(302, recheck.url);
    }
    return res.redirect(302, "/favicon.svg");
  }

  const remoteUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const downloadPromise = (async () => {
    await _acquireTmdbPosterSlot();
    try {
      const tmdbResult = await cachePosterFromUrl(mediaKey, remoteUrl, "tmdb");
      if (tmdbResult) return tmdbResult;
      if (!tmdbId) return null;
      const tvdbId = mediaType === "tv" ? getCachedTvdbId(tmdbId) : "";
      const fanartArt = await (mediaType === "tv"
        ? getFanartTvArt(tvdbId)
        : getFanartMovieArt(tmdbId)).catch(() => null);
      if (fanartArt?.poster) {
        return cachePosterFromUrl(mediaKey, fanartArt.poster, "fanart");
      }
      return null;
    } finally {
      _releaseTmdbPosterSlot();
    }
  })();

  _tmdbPosterInflight.set(posterPath, downloadPromise);
  const stored = await downloadPromise;
  _tmdbPosterInflight.delete(posterPath);

  if (!stored?.url) {
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

export async function handleTmdbProfile(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const profilePath = String(req.query.path || "").trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(profilePath)) {
    return sendJson(res, { error: "Invalid TMDB profile path" }, 400);
  }

  const mediaKey = `tmdb:profile:${profilePath}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey, "profile"));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  if (cached?.cached) return res.redirect(302, "/favicon.svg");

  const remoteUrl = `https://image.tmdb.org/t/p/original${profilePath}`;
  const stored = await cacheProfileFromUrl(mediaKey, remoteUrl, "tmdb");
  if (!stored?.url) {
    return res.redirect(302, "/favicon.svg");
  }

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

// Artwork hosts whose images may be downloaded on request. fanart.tv and TVDB
// hand back absolute CDN URLs rather than paths, so their art used to be
// hot-linked straight into the page - which breaks whenever a browser cannot
// reach that CDN (network filtering, an outage, a blocked region) even though
// the server can. Proxying puts every artwork source behind the same cached
// /media URL the poster pipeline already uses.
const REMOTE_ARTWORK_HOSTS = new Set([
  "assets.fanart.tv",
  "artworks.thetvdb.com",
  "artworks.thetvdb.com.",
  "image.tmdb.org",
]);

// Resolved by a switch rather than an object lookup on purpose. A caller-supplied
// key indexed into an object literal also reaches Object.prototype, so a variant
// of `constructor` or `toString` would find a function, pass a truthiness check,
// and get invoked.
function artworkCacherFor(variant) {
  switch (variant) {
    case "poster": return cachePosterFromUrl;
    case "logo": return cacheLogoFromUrl;
    case "backdrop": return cacheBackdropFromUrl;
    default: return null;
  }
}

// A short negative cache keeps a reload from re-requesting artwork the server
// already knows it cannot fetch, without stranding the miss for long once the
// upstream host recovers.
const ARTWORK_MISS_HEADERS = { "Cache-Control": "public, max-age=600" };

const _remoteArtworkInflight = new Map();

export async function handleRemoteArtwork(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const rawUrl = String(req.query.url || "").trim();
  const variant = String(req.query.variant || "poster").toLowerCase();
  const cacher = artworkCacherFor(variant);
  if (!cacher) return sendJson(res, { error: "Invalid artwork variant" }, 400);

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return sendJson(res, { error: "Invalid artwork URL" }, 400);
  }
  if (parsed.protocol !== "https:" || !REMOTE_ARTWORK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return sendJson(res, { error: "Artwork host is not allowed" }, 400);
  }

  const mediaKey = `remote:${variant}:${crypto.createHash("sha1").update(parsed.toString()).digest("hex")}`;
  const cached = usableCachedPoster(await getPosterCache(mediaKey, variant));
  if (cached?.url) {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return res.redirect(302, cached.url);
  }
  // Report a miss as 404 rather than a placeholder redirect: every caller is an
  // <img> with its own fallback (title text, hidden tile), and a successfully
  // loaded placeholder would suppress those.
  if (cached?.cached) return sendJson(res, { error: "Artwork unavailable" }, 404, ARTWORK_MISS_HEADERS);

  if (!_remoteArtworkInflight.has(mediaKey)) {
    _remoteArtworkInflight.set(mediaKey, cacher(mediaKey, parsed.toString(), "remote")
      .finally(() => _remoteArtworkInflight.delete(mediaKey)));
  }
  const stored = await _remoteArtworkInflight.get(mediaKey).catch(() => null);
  if (!stored?.url) return sendJson(res, { error: "Artwork unavailable" }, 404, ARTWORK_MISS_HEADERS);

  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  return res.redirect(302, stored.url);
}

export async function handleTmdbDetails(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const mediaType = String(req.query.mediaType || req.query.type || "").trim().toLowerCase();
  let tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
  const title = String(req.query.title || "").trim();
  const ids = {
    imdbId: String(req.query.imdbId || req.query.imdb_id || req.query.imdb || "").trim(),
    tvdbId: String(req.query.tvdbId || req.query.tvdb_id || req.query.tvdb || "").trim(),
  };

  if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) {
    return sendJson(res, { error: "mediaType and a TMDB ID, title, IMDb ID, or TVDB ID are required" }, 400);
  }

  try {
    const details = await withDisplaySeasons(await getTmdbDetails({ mediaType, tmdbId, title, ids, lane: "interactive" }));
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB details API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB details" }, error.status || 500);
  }
}

export async function handleTmdbDetailsBatch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, 240) : [];
  if (!items.length) return sendJson(res, { results: [] });

  // Bounded worker pool: upstream calls are serialized by the gateway throttles
  // anyway, so unbounded Promise.all only inflates the in-flight promise count
  // for a cold batch - 8 workers keeps cache hits fast without that.
  const BATCH_CONCURRENCY = 8;
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      const mediaType = String(item?.mediaType || item?.type || "").trim().toLowerCase();
      const tmdbId = String(item?.tmdbId || item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const ids = {
        imdbId: String(item?.imdbId || item?.imdb_id || item?.imdb || "").trim(),
        tvdbId: String(item?.tvdbId || item?.tvdb_id || item?.tvdb || "").trim(),
      };
      if (!mediaType || (!tmdbId && !title && !ids.imdbId && !ids.tvdbId)) {
        results[index] = { error: "invalid" };
        continue;
      }
      try {
        const details = await getTmdbDetails({
          mediaType,
          tmdbId,
          title,
          ids,
          light: item?.light === true,
          relatedTvLookup: item?.relatedTvLookup === true,
          // Explorer prefetch is lower priority; a full detail request jumps ahead.
          lane: item?.light === true ? "enrichment" : "interactive",
        });
        results[index] = { details: await withDisplaySeasons(details, { cachedOnly: item?.light === true }) };
      } catch (error) {
        results[index] = { error: error.message || "failed", status: error.status || 500 };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));

  return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
}

export async function handleTmdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const result = await searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || req.query.type || "multi" });
    return sendJson(res, result, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTvdbSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const results = await searchTvdbSeriesList(query);
    return sendJson(res, { results }, 200, { "Cache-Control": "private, max-age=60, stale-while-revalidate=900", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

// Fix Match needs a broader search than the normal provider-specific search
// controls. A title can be absent from one catalogue, have a stale identity in
// the local history, or be represented by a different provider id altogether.
// Keep each source independent so one unavailable provider does not hide the
// matches returned by the others.
export async function handleFixMatchSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const query = String(req.query.query || req.query.q || "").trim();
  const mediaType = String(req.query.mediaType || req.query.type || "").trim().toLowerCase();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  if (!["movie", "tv"].includes(mediaType)) return sendJson(res, { error: "mediaType must be movie or tv" }, 400);

  const sourceLabels = {
    local: "Local library",
    tmdb: "TMDB",
    tvdb: "TVDB",
  };
  const sourceTasks = [
    ["local", mediaType === "movie"
      ? queryMovies({ search: query, limit: 20 })
      : queryShows({ search: query, limit: 20 })],
    ["tmdb", searchTmdb({ query, page: req.query.page || 1, mediaType })],
  ];
  if (mediaType === "tv") sourceTasks.push(["tvdb", searchTvdbSeriesList(query)]);

  const settled = await Promise.allSettled(sourceTasks.map(([, task]) => task));
  const sourceStatus = {};
  const results = [];
  const resultByIdentity = new Map();

  // A TV result is rematched by its TVDB series id, so that is the identity a
  // show is deduplicated under; the TMDB id is only a second key so a result
  // that knows both ids links the TVDB-only and TMDB-only entries for the same
  // show into one card instead of listing it twice.
  const identityKeysFor = (candidate) => {
    const tmdbId = String(candidate.tmdb_id || "").trim();
    const tvdbId = String(candidate.tvdb_id || "").trim();
    const tmdbKey = tmdbId ? `tmdb:${tmdbId}` : "";
    const tvdbKey = tvdbId ? `tvdb:${tvdbId}` : "";
    const keys = mediaType === "tv" ? [tvdbKey, tmdbKey] : [tmdbKey, tvdbKey];
    return keys.filter(Boolean);
  };

  const addResult = (candidate) => {
    const keys = identityKeysFor(candidate);
    if (!keys.length || !candidate.title) return;

    const existing = keys.map((key) => resultByIdentity.get(key)).find(Boolean);
    if (existing) {
      const label = sourceLabels[candidate.source] || candidate.source;
      if (!existing.source_labels.includes(label)) existing.source_labels.push(label);
      if (!existing.poster_url && candidate.poster_url) existing.poster_url = candidate.poster_url;
      if (!existing.poster_path && candidate.poster_path) existing.poster_path = candidate.poster_path;
      if (!existing.image_url && candidate.image_url) existing.image_url = candidate.image_url;
      if (!existing.overview && (candidate.overview || candidate.summary)) existing.overview = candidate.overview || candidate.summary;
      if (!existing.year && candidate.year) existing.year = candidate.year;
      if (!existing.imdb_id && candidate.imdb_id) existing.imdb_id = candidate.imdb_id;
      // A later source can know an id the first one lacked - carry it onto the
      // merged card so a local row with no TVDB id of its own still rematches
      // directly by TVDB id, and register the key it arrived under.
      if (!existing.tmdb_id && candidate.tmdb_id) existing.tmdb_id = candidate.tmdb_id;
      if (!existing.tvdb_id && candidate.tvdb_id) existing.tvdb_id = candidate.tvdb_id;
      for (const key of keys) {
        if (!resultByIdentity.has(key)) resultByIdentity.set(key, existing);
      }
      return;
    }

    const result = {
      ...candidate,
      source_labels: [sourceLabels[candidate.source] || candidate.source],
      media_type: mediaType,
    };
    for (const key of keys) resultByIdentity.set(key, result);
    results.push(result);
  };

  for (let index = 0; index < sourceTasks.length; index += 1) {
    const [source] = sourceTasks[index];
    const outcome = settled[index];
    if (outcome.status === "rejected") {
      sourceStatus[source] = { ok: false, count: 0, error: outcome.reason?.message || "Unavailable" };
      continue;
    }

    const value = outcome.value;
    if (source === "local") {
      const items = Array.isArray(value) ? value : [];
      sourceStatus[source] = { ok: true, count: items.length };
      for (const item of items) {
        addResult({
          source,
          title: String(item.title || "").trim(),
          overview: item.overview || item.summary || "",
          year: "",
          poster_url: item.poster_url || "",
          poster_path: "",
          image_url: "",
          tmdb_id: item.tmdb_id || "",
          // A library row that only ever recorded a TMDB id still has a known
          // TVDB series id whenever its metadata has been fetched before, and
          // the TV rematch needs that id rather than the TMDB one.
          tvdb_id: item.tvdb_id || (mediaType === "tv" ? getCachedTvdbId(item.tmdb_id) : ""),
          imdb_id: item.imdb_id || "",
          local_id: item.id || "",
        });
      }
      continue;
    }

    if (source === "tmdb") {
      const items = (Array.isArray(value?.results) ? value.results : [])
        .filter((item) => (item.media_type || mediaType) === mediaType && item.id);
      sourceStatus[source] = { ok: true, count: items.length };
      for (const item of items.slice(0, 20)) {
        const tmdbId = String(item.id);
        addResult({
          source,
          title: String(item.title || item.name || "").trim(),
          overview: item.overview || item.summary || "",
          year: String(item.release_date || item.first_air_date || "").slice(0, 4),
          poster_url: "",
          poster_path: item.poster_path || "",
          image_url: "",
          tmdb_id: tmdbId,
          tvdb_id: mediaType === "tv" ? getCachedTvdbId(tmdbId) : "",
          imdb_id: "",
        });
      }
      continue;
    }

    const items = Array.isArray(value) ? value : [];
    sourceStatus[source] = { ok: true, count: items.length };
    for (const item of items.slice(0, 20)) {
      addResult({
        source,
        title: String(item.name || "").trim(),
        overview: item.overview || item.summary || "",
        year: String(item.year || "").trim(),
        poster_url: "",
        poster_path: "",
        image_url: item.image_url || "",
        tmdb_id: "",
        tvdb_id: item.tvdb_id || "",
        imdb_id: "",
      });
    }
  }

  return sendJson(res, { results, sources: sourceStatus }, 200, {
    "Cache-Control": "private, max-age=60, stale-while-revalidate=900",
    Vary: "Authorization",
  });
}

function searchableTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// TVDB is searched alongside TMDB rather than after it, because TMDB's TV
// catalogue has gaps TVDB does not (regional and factual series in particular)
// and a series missing from TMDB should appear as fast as any other result.
// Callers de-duplicate these against the local and TMDB show results by title.
export async function searchTvdbSeries(query) {
  const needle = searchableTitle(query);
  if (!needle) return [];
  try {
    const results = await searchTvdbSeriesList(query);
    return results.filter((item) => {
      const title = searchableTitle(item.name);
      return title && (title.includes(needle) || needle.includes(title));
    });
  } catch {
    // TVDB being unavailable or rate limited must never fail the whole search.
    return [];
  }
}

function discoveryTitleKeys(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return [];
  const withoutYear = normalized.replace(/\s+\d{4}$/, "").trim();
  return [...new Set([normalized, withoutYear].filter(Boolean))];
}

const RECOMMENDATION_HISTORY_MS = 365 * 24 * 60 * 60 * 1000;

async function localTmdbDiscoveryState() {
  const [movies, shows] = await Promise.all([
    getCachedMovies().catch(() => []),
    getCachedShows().catch(() => []),
  ]);

  const watchedIds = {
    movie: new Set(),
    tv: new Set(),
    movieTitles: new Set(),
    tvTitles: new Set(),
  };
  const seeds = [];
  const recommendationCutoff = Date.now() - RECOMMENDATION_HISTORY_MS;
  const watchedWithinRecommendationWindow = (watchedAt) => {
    const watchedAtMs = Date.parse(String(watchedAt || ""));
    return Number.isFinite(watchedAtMs) && watchedAtMs >= recommendationCutoff;
  };
  for (const item of movies) {
    if (item.tmdb_id) watchedIds.movie.add(String(item.tmdb_id));
    discoveryTitleKeys(item.title).forEach((key) => watchedIds.movieTitles.add(key));
    if (watchedWithinRecommendationWindow(item.watched_at)) {
      seeds.push({
        mediaType: "movie",
        tmdbId: item.tmdb_id || "",
        title: item.title || "",
        ids: { imdbId: item.imdb_id || "" },
        watchedAt: item.watched_at || "",
        watchCount: 1,
      });
    }
  }
  for (const item of shows.filter((show) => Number(show.episode_count || 0) > 0)) {
    if (item.tmdb_id) watchedIds.tv.add(String(item.tmdb_id));
    discoveryTitleKeys(item.title).forEach((key) => watchedIds.tvTitles.add(key));
    if (watchedWithinRecommendationWindow(item.latest_watched_at)) {
      seeds.push({
        mediaType: "tv",
        tmdbId: item.tmdb_id || "",
        title: item.title || "",
        ids: { imdbId: item.imdb_id || "", tvdbId: item.tvdb_id || "" },
        watchedAt: item.latest_watched_at || "",
        watchCount: Math.max(1, Number(item.total_watches || item.episode_count || 1)),
      });
    }
  }

  // Multiple watch dates should not consume the bounded recommendation seed
  // budget with the same title.
  const uniqueSeeds = new Map();
  for (const seed of seeds) {
    const identity = `${seed.mediaType}:${seed.tmdbId || seed.ids.imdbId || seed.ids.tvdbId || discoveryTitleKeys(seed.title)[0] || ""}`;
    const existing = uniqueSeeds.get(identity);
    if (!existing) {
      uniqueSeeds.set(identity, seed);
      continue;
    }
    const watchCount = Number(existing.watchCount || 1) + Number(seed.watchCount || 1);
    if (String(seed.watchedAt) > String(existing.watchedAt)) uniqueSeeds.set(identity, { ...seed, watchCount });
    else existing.watchCount = watchCount;
  }

  return { watchedIds, seeds: [...uniqueSeeds.values()] };
}

async function localTmdbWatchedIds() {
  return (await localTmdbDiscoveryState()).watchedIds;
}

function discoveryItemIsWatched(item = {}, watchedIds = {}) {
  const type = item.media_type === "tv" ? "tv" : "movie";
  const id = String(item.id || item.tmdb_id || "");
  if (id && watchedIds[type]?.has(id)) return true;
  return discoveryTitleKeys(item.title || item.name).some((key) => watchedIds[`${type}Titles`]?.has(key));
}

function annotateDiscoveryWatched(payload, watchedState) {
  const watchedIds = watchedState?.watchedIds || watchedState || {};
  const feeds = Object.fromEntries(Object.entries(payload?.feeds || {}).map(([key, feed]) => [
    key,
    {
      ...feed,
      results: (feed?.results || []).map((item) => ({
        ...item,
        is_watched: discoveryItemIsWatched(item, watchedIds),
      })).filter((item) => !item.is_watched),
    },
  ]));
  return { ...payload, feeds };
}

export async function handleMediaSearch(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const query = String(req.query.query || req.query.q || "").trim();
  if (query.length < 2) return sendJson(res, { error: "A search query of at least two characters is required" }, 400);
  try {
    const localLimit = Math.min(Math.max(Number(req.query.limit || req.query.localLimit || 50), 1), 250);
    const [movies, shows, discovery, people, collections, tvdbShows] = await Promise.all([
      queryMovies({ search: query, limit: localLimit }),
      queryShows({ search: query, limit: localLimit }),
      searchTmdb({ query, page: req.query.page, mediaType: req.query.mediaType || "multi" }),
      searchTmdb({ query, page: req.query.peoplePage || 1, mediaType: "person" }),
      searchTmdbCollections({ query, page: req.query.collectionPage || 1 }).catch(() => ({ results: [] })),
      searchTvdbSeries(query),
    ]);
    return sendJson(res, { local: { movies, shows }, discovery, people, collections, tvdb: { shows: tvdbShows } }, 200, {
      "Cache-Control": "private, max-age=60, stale-while-revalidate=900",
      Vary: "Authorization",
    });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTmdbCollection(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = String(req.query.id || req.query.collectionId || "").trim();
    const details = await getTmdbCollection(id);
    const watchedIds = await localTmdbWatchedIds();
    const response = {
      ...details,
      parts: (details.parts || []).map((part) => ({
        ...part,
        is_watched: watchedIds.movie.has(String(part.id)),
      })),
    };
    return sendJson(res, response, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleDiscover(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const refresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
    const payload = await getTmdbDiscovery({
      mediaType: req.query.mediaType || req.query.type || "all",
      genreId: req.query.genreId || req.query.genre || "",
      force: refresh,
      revalidate: !refresh,
    });
    const discoveryState = await localTmdbDiscoveryState();
    const recommendations = await getTmdbRecommendations({
      seeds: discoveryState.seeds,
      mediaType: req.query.mediaType || req.query.type || "all",
      genreId: req.query.genreId || req.query.genre || "",
    });
    const withRecommendations = {
      ...payload,
      feeds: { ...(payload.feeds || {}), recommended: filterExcludedRecommendations(recommendations) },
    };
    return sendJson(res, annotateDiscoveryWatched(withRecommendations, discoveryState), 200, { "Cache-Control": "private, max-age=600, stale-while-revalidate=1800", Vary: "Authorization" });
  } catch (error) {
    if (error?.message === "TMDB API key is not configured") {
      return sendJson(res, {
        error: error.message,
        code: "TMDB_NOT_CONFIGURED",
        retryable: false,
      }, 400);
    }
    if (Number(error?.status) === 401 || /TMDB request failed with 401/i.test(String(error?.message || ""))) {
      return sendJson(res, {
        error: "TMDB rejected the configured API key. Check Settings → Metadata.",
        code: "TMDB_AUTH_FAILED",
        retryable: false,
      }, 400);
    }
    if (Number(error?.status) === 429 || /429|rate limit/i.test(String(error?.message || ""))) {
      return sendJson(res, {
        error: "TMDB is rate-limiting requests. Wait a moment, then try again.",
        code: "TMDB_RATE_LIMITED",
        retryable: true,
      }, 429);
    }
    if (!error?.status || Number(error.status) >= 500 || /fetch failed|network|timeout/i.test(String(error?.message || ""))) {
      return sendJson(res, {
        error: "TMDB could not be reached. Check the network connection, then try again.",
        code: "TMDB_UNAVAILABLE",
        retryable: true,
      }, 424);
    }
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleDiscoverDismiss(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJson(req).catch(() => ({}));
    const exclusion = createRecommendationExclusion(body);
    if (!exclusion) {
      return sendJson(res, { error: "A valid movie or TV TMDB id is required" }, 400);
    }
    return sendJson(res, { ok: true, exclusion }, 200, {
      "Cache-Control": "no-store",
      Vary: "Authorization",
    });
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not update Discover recommendations" }, error.status || 500);
  }
}

export async function handleUpNext(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const refresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
  const revalidate = ["1", "true", "yes"].includes(String(req.query.revalidate || "").toLowerCase());
  const allowStale = ["1", "true", "yes"].includes(String(req.query.allowStale || "").toLowerCase());
  try {
    // An explicit dashboard refresh must re-check provider rails too.
    // Otherwise a persisted failure from an earlier outage can keep showing
    // after the same feed endpoints have recovered.
    let mediaConfig = null;
    if (refresh) {
      mediaConfig = await loadMediaConfig().catch(() => null);
      await refreshUpNextProviderFeeds({ config: mediaConfig || {} });
    }
    // The projection resolves an unwatched next episode against the real
    // libraries, so the build needs the media config. It is loaded lazily:
    // a warm cache hit never calls the build at all.
    const build = async () => buildUpNextProjection({
      mediaConfig: mediaConfig || await loadMediaConfig().catch(() => null),
    });
    const snapshot = await getUpNextCacheSnapshot(build, { refresh, revalidate, allowStale });
    // The body carries live provider feed status and the server keeps its own
    // snapshot cache, so an HTTP-cached copy would only hide an outage.
    return sendJson(res, {
      items: snapshot.items,
      builtAt: snapshot.builtAt,
      upNextVersion: snapshot.upNextVersion,
      sourceVersion: snapshot.sourceVersion,
      sourceStatus: snapshot.sourceStatus,
      cacheStale: snapshot.stale,
      manualShows: listManualUpNextShows(),
    }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
  } catch (error) {
    console.error("Up Next request failed", error);
    return sendJson(res, { error: error.message || "Up Next request failed" }, error.status || 500);
  }
}

export async function handleUpNextShow(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req).catch(() => ({}));
  const title = String(body.title || body.show_title || body.showTitle || "").trim();
  if (!title) return sendJson(res, { error: "A TV show title is required" }, 400);
  try {
    const show = {
      title,
      tmdb_id: body.tmdb_id || body.tmdbId || body.show_tmdb_id || body.showTmdbId || "",
      tvdb_id: body.tvdb_id || body.tvdbId || body.show_tvdb_id || body.showTvdbId || "",
      imdb_id: body.imdb_id || body.imdbId || body.show_imdb_id || body.showImdbId || "",
      poster_url: body.poster_url || body.posterUrl || body.show_poster_url || body.showPosterUrl || "",
    };
    if (body.remove === true || body.action === "remove") {
      const removed = removeManualUpNextShow({ id: body.id, ...show });
      return sendJson(res, { ok: true, removed, manualShows: listManualUpNextShows() }, 200, { "Cache-Control": "no-store" });
    }
    const saved = upsertManualUpNextShow(show);
    if (!saved) return sendJson(res, { error: "A valid TV show identity is required" }, 400);
    restoreUpNextDismissalsForMedia({
      media_type: "episode",
      show_title: saved.title,
      show_tmdb_id: saved.tmdb_id,
      show_tvdb_id: saved.tvdb_id,
      show_imdb_id: saved.imdb_id,
    });
    return sendJson(res, { ok: true, show: saved, manualShows: listManualUpNextShows() }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Manual Up Next show update failed", error);
    return sendJson(res, { error: "Could not update the manual Up Next show" }, 500);
  }
}

export async function handleTmdbSeason(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbSeason({
      tmdbId: req.query.tmdbId || req.query.id,
      tvdbId: req.query.tvdbId || req.query.tvdb_id,
      seasonNumber: req.query.seasonNumber || req.query.season,
      lane: "interactive",
    });
    return sendJson(res, details, 200, { "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTmdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const details = await getTmdbImages({
      mediaType: req.query.mediaType || req.query.type,
      tmdbId: req.query.tmdbId || req.query.id,
      title: req.query.title,
      ids: { tvdbId: req.query.tvdbId || req.query.tvdb_id },
      lane: "interactive",
    });
    return sendJson(res, details);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleTvdbImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const title = String(req.query.title || "").trim();
    let tvdbId = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    if (!tvdbId) tvdbId = await resolveTvdbSeriesId({ title }).catch(() => "");
    if (!tvdbId) {
      const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
      if (tmdbId) tvdbId = getCachedTvdbId(tmdbId);
    }
    if (!tvdbId) return sendJson(res, { posters: [], logos: [], backdrops: [] });
    const result = await getTvdbSeriesArtwork(tvdbId);
    return sendJson(res, result);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleFanartImages(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const mediaType = req.query.mediaType || req.query.type;
    const tmdbId = String(req.query.tmdbId || req.query.id || "").trim();
    const tvdbIdParam = String(req.query.tvdbId || req.query.tvdb_id || "").trim();
    let result = null;
    if (mediaType === "movie") {
      result = await getAllFanartMovieImages(tmdbId);
    } else {
      const tvdbIds = [];
      const addTvdbId = (value) => {
        const id = String(value || "").trim();
        if (id && !tvdbIds.includes(id)) tvdbIds.push(id);
      };

      addTvdbId(tvdbIdParam);
      addTvdbId(getCachedTvdbId(tmdbId));
      if (tmdbId) {
        const details = await getTmdbDetails({ mediaType: "tv", tmdbId }).catch(() => null);
        addTvdbId(details?.external_ids?.tvdb_id);
      }

      for (const tvdbId of tvdbIds) {
        const candidate = await getAllFanartTvImages(tvdbId);
        const hasImages = Boolean(candidate?.posters?.length || candidate?.logos?.length || candidate?.backdrops?.length);
        if (hasImages) {
          result = candidate;
          break;
        }
        if (!result) result = candidate;
      }
    }
    return sendJson(res, result || { posters: [], logos: [], backdrops: [] });
  } catch (error) {
    console.error("Failed to load Fanart images", error);
    return sendJson(res, { error: "Failed to load Fanart images" }, 500);
  }
}

export async function handleTmdbPerson(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const personId = String(req.query.id || "").trim();
  if (!personId) {
    return sendJson(res, { error: "Person ID is required" }, 400);
  }

  try {
    const personData = await getTmdbPerson(personId, { lane: "interactive" });
    
    // Deep clone the credits cast so we can enrich them without mutating the cached details
    const responseData = {
      ...personData,
      combined_credits: personData.combined_credits ? {
        ...personData.combined_credits,
        cast: (personData.combined_credits.cast || []).map(credit => ({ ...credit }))
      } : personData.combined_credits
    };

    if (responseData.combined_credits && Array.isArray(responseData.combined_credits.cast)) {
      const cast = responseData.combined_credits.cast;
      const creditTmdbIds = [];
      const creditTitles = [];
      for (const credit of cast) {
        if (credit.id) creditTmdbIds.push(String(credit.id));
        const title = credit.title || credit.name;
        if (title) creditTitles.push(title.toLowerCase());
      }

      if (creditTmdbIds.length > 0) {
        const dbInstance = requireDb();
        const placeholdersTmdb = creditTmdbIds.map(() => "?").join(",");
        const placeholdersTitle = creditTitles.map(() => "?").join(",");
        
        // Fetch all matching rows from watch_history
        const query = `
          SELECT id, tmdb_id, title, media_type, season, episode, show_title, title_lower, show_title_lower, source
          FROM watch_history
          WHERE (tmdb_id IS NOT NULL AND tmdb_id IN (${placeholdersTmdb}))
             OR (title_lower IN (${placeholdersTitle}))
             OR (show_title_lower IN (${placeholdersTitle}))
        `;
        const params = [...creditTmdbIds, ...creditTitles, ...creditTitles];
        const rows = dbInstance.prepare(query).all(params);

        // Sources that mean the item is physically on a connected media server.
        const isMediaServerSource = (src) => {
          const s = String(src || "").toLowerCase();
          return s.startsWith("plex") || s.startsWith("emby") || s.startsWith("jellyfin") || s.startsWith("webhook");
        };

        // Group rows by tmdb_id and show_title_lower for easy lookup
        const rowsByTmdbId = new Map();
        const rowsByTitleLower = new Map();
        
        for (const row of rows) {
          if (row.tmdb_id) {
            const key = String(row.tmdb_id);
            if (!rowsByTmdbId.has(key)) rowsByTmdbId.set(key, []);
            rowsByTmdbId.get(key).push(row);
          }
          if (row.title_lower) {
            const key = row.title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
          if (row.show_title_lower) {
            const key = row.show_title_lower;
            if (!rowsByTitleLower.has(key)) rowsByTitleLower.set(key, []);
            rowsByTitleLower.get(key).push(row);
          }
        }

        // Helper to slugify title
        const slug = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

        // Map over each credit to check watched status
        for (const credit of cast) {
          const tmdbIdStr = String(credit.id);
          const titleLower = (credit.title || credit.name || "").toLowerCase();
          
          let matchingRows = [];
          if (rowsByTmdbId.has(tmdbIdStr)) {
            matchingRows = rowsByTmdbId.get(tmdbIdStr);
          } else if (rowsByTitleLower.has(titleLower)) {
            matchingRows = rowsByTitleLower.get(titleLower);
          }

          if (matchingRows.length > 0) {
            // "In Library" = physically on a connected media server (Plex/Emby/Jellyfin).
            // Manually-watched or imported items are tracked but not "in library".
            const serverRows = matchingRows.filter(r => isMediaServerSource(r.source));
            
            if (credit.media_type === "tv") {
              const tvRows = matchingRows.filter(r => r.media_type === "episode");
              if (tvRows.length > 0) {
                // Count unique episodes
                const watchedKeys = new Set(tvRows.map(r => `${r.season}_${r.episode}`));
                credit.watched_count = watchedKeys.size;
                const representative = tvRows[0];
                const showTitle = representative.show_title || representative.title || credit.name || credit.title;
                credit.show_title = showTitle;
                credit.library_key = slug(showTitle);
                credit.library_id = representative.id;
                // Only mark in_library if there's a media-server source row
                const serverTvRows = serverRows.filter(r => r.media_type === "episode");
                credit.in_library = serverTvRows.length > 0;
                credit.in_watch_history = true;
              }
            } else {
              const movieRows = matchingRows.filter(r => r.media_type === "movie");
              if (movieRows.length > 0) {
                credit.library_id = movieRows[0].id;
                const serverMovieRows = serverRows.filter(r => r.media_type === "movie");
                credit.in_library = serverMovieRows.length > 0;
                credit.in_watch_history = true;
              }
            }
          }
        }
      }
    }

    return sendJson(res, responseData, 200, { "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", Vary: "Authorization" });
  } catch (error) {
    console.error("Failed handling TMDB person API", error);
    return sendJson(res, { error: error.message || "Failed to fetch TMDB person details" }, error.status || 500);
  }
}

// Ultra-cheap, no-auth endpoint that returns immediately â€” client calls this on
// page load so the server is warm by the time the user clicks into anything.

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com") return u.searchParams.get("v") || null;
  } catch { /* invalid URL */ }
  return null;
}

// Trailer metadata is immutable per video id, so responses are cached 30 days.
// A cached oEmbed-only entry is refetched once a Data API key appears, so the
// richer fields (description, duration) fill in without waiting out the TTL.
const YOUTUBE_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const youtubeMetaGetStmt = db.prepare("SELECT data, updated_at_ms FROM youtube_meta_cache WHERE id = ?");
const youtubeMetaSetStmt = db.prepare(
  `INSERT INTO youtube_meta_cache (id, data, updated_at_ms) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at_ms=excluded.updated_at_ms`,
);

export async function handleYoutubeMeta(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const url = String(req.query.url || "").trim();
  if (!url) return sendJson(res, { error: "url is required" }, 400);

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return sendJson(res, { error: "Could not extract YouTube video ID from URL" }, 400);

  const cachedRow = youtubeMetaGetStmt.get(videoId);
  if (cachedRow && Date.now() - Number(cachedRow.updated_at_ms || 0) < YOUTUBE_META_TTL_MS) {
    const cached = parseJson(cachedRow.data);
    const config = await loadMediaConfig();
    const wantsApiFields = Boolean(config.youtube?.apiKey);
    if (cached && (!wantsApiFields || cached.publishedAt || cached.description)) {
      return sendJson(res, cached);
    }
  }

  // oEmbed is free, no API key required
  let title = "";
  let channelName = "";
  try {
    const oembedRes = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {}, 8000);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || "";
      channelName = oembed.author_name || "";
    }
  } catch { /* non-fatal */ }

  // Optional: YouTube Data API for description, duration, publishedAt
  let description = "";
  let publishedAt = "";
  let duration = "";
  const config = await loadMediaConfig();
  const ytApiKey = config.youtube?.apiKey;
  if (ytApiKey) {
    try {
      const apiRes = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`, { headers: { "X-goog-api-key": ytApiKey } }, 8000);
      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const item = apiData.items?.[0];
        if (item) {
          title = title || item.snippet?.title || "";
          channelName = channelName || item.snippet?.channelTitle || "";
          description = item.snippet?.description || "";
          publishedAt = item.snippet?.publishedAt || "";
          duration = item.contentDetails?.duration || "";
        }
      }
    } catch { /* non-fatal */ }
  }

  // Thumbnail URLs from highest to lowest quality
  const thumbnails = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  ];

  const payload = { videoId, title, channelName, description, publishedAt, duration, thumbnails };
  // Only cache when at least the oEmbed call answered - an all-empty payload
  // usually means a transient failure, not an empty video.
  if (title || channelName) {
    youtubeMetaSetStmt.run(videoId, toJson(payload), Date.now());
  }
  return sendJson(res, payload);
}

export async function handleOmdbRating(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const imdbId = String(req.query.imdbId || "").trim();
  if (!imdbId) return sendJson(res, { error: "imdbId is required" }, 400);

  const config = await loadMediaConfig();
  if (!config.omdb?.apiKey) return sendJson(res, { error: "OMDb API key not configured" }, 503);

  try {
    const rating = await getOmdbRating(imdbId, config.omdb.apiKey);
    return sendJson(res, rating || {});
  } catch (err) {
    console.error("Failed to fetch OMDb rating", err);
    return sendJson(res, { error: "Failed to fetch OMDb rating" }, 500);
  }
}

// --- Upcoming episodes calendar ---------------------------------------------
export async function handleUpcoming(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const requested = String(req.query.month || "").trim();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : new Date().toISOString().slice(0, 7);
    const refresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
    // `revalidate` serves the cached month immediately and rebuilds behind the
    // response; `refresh` is the blocking rebuild, kept for explicit re-syncs.
    const revalidate = ["1", "true", "yes"].includes(String(req.query.revalidate || "").toLowerCase());
    const payload = await getUpcomingCalendarMonth(month, { refresh, revalidate });
    return sendJson(res, payload);
  } catch (error) {
    console.error("Upcoming calendar request failed", error);
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return sendJson(res, { error: error.message || "Upcoming calendar request failed" }, status);
    }
    return sendJson(res, { error: "Upcoming calendar request failed" }, 500);
  }
}
