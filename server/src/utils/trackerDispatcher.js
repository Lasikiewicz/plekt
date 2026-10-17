import { getTrackerConnection, recordTrackerOutbound, recordTrackerOutboundBatch, replaceTrackerSnapshot, updateTrackerConnectionStatus, updateTrackerTokens } from "./trackerConnectionRepo.js";
import { fetchTraktHistoryWindow, fetchTraktPlayHistory, refreshTraktToken, setTraktWatchHistoryBatch, setTraktWatchState, trackerMediaIdentityKeys, trackerMediaKey, trackerMediaMatches } from "./traktClient.js";
import { hydrateTraktAppCredentials } from "./traktAppConfig.js";
import { getTmdbDetails } from "./tmdbGateway.js";
import { canonicalCompoundEpisodeMedia, canonicalizeCompoundEpisodeRows } from "./compoundEpisode.js";
import { DISMISSED_TRAKT_NOT_FOUND_DETAIL, isTraktNotFoundDismissed } from "./traktDismissals.js";
import { withSeasonSourceTraktOverride } from "./traktOutboundNumbering.js";

let traktRefreshInFlight = null;

const TRAKT_RATE_LIMIT_RETRIES = 3;
const TRAKT_WRITE_MIN_INTERVAL_MS = 200;
let traktWriteQueue = Promise.resolve();
let lastTraktWriteStartedAt = 0;

function waitForTraktRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
}

function traktRetryDelayMs(error, attempt) {
  const retryAfterSeconds = Number(error?.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(60_000, Math.max(10, retryAfterSeconds * 1000));
  }
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt)));
}

// The shared outbound governor prevents unbounded concurrency, but its normal
// 30ms host interval is still too bursty for a sequence of Trakt history
// writes. Serialize only Trakt writes and leave a short gap between request
// starts; this keeps grouped show actions fast while avoiding a remove/add
// burst that turns every episode in the batch into the same 429 error.
async function runTraktWrite(operation) {
  const waitMs = Math.max(0, lastTraktWriteStartedAt + TRAKT_WRITE_MIN_INTERVAL_MS - Date.now());
  if (waitMs) await waitForTraktRetry(waitMs);
  lastTraktWriteStartedAt = Date.now();
  return operation();
}

function enqueueTraktWrite(operation) {
  const run = async () => {
    return runTraktWrite(operation);
  };
  const result = traktWriteQueue.then(run, run);
  traktWriteQueue = result.catch(() => {});
  return result;
}

// Trakt's sync endpoints return 429 when several history writes arrive in a
// burst. The shared outbound governor cools the host after seeing that
// response, but the request that was rejected still needs a bounded retry or
// a large manual show mark is left partially propagated until the next
// scheduled retry. Keep this wrapper specific to Trakt writes so metadata and
// media-server traffic retain their existing retry semantics.
export async function withTraktRateLimitRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await enqueueTraktWrite(operation);
    } catch (error) {
      if (Number(error?.status) !== 429 || attempt >= TRAKT_RATE_LIMIT_RETRIES) throw error;
      await waitForTraktRetry(traktRetryDelayMs(error, attempt));
    }
  }
}

function trackerShowTitle(media = {}) {
  const explicit = String(media.showTitle || media.show_title || "").trim();
  if (explicit) return explicit;
  return String(media.title || "").replace(/\s+-\s+S\d{1,2}E\d{1,2}.*$/i, "").trim();
}

export function mediaWithTraktOverride(media = {}) {
  const override = media?.traktOverride || media?.providerOverrides?.trakt || media?.provider_overrides?.trakt;
  if ((media.type || media.mediaType) !== "episode" || !override?.tmdb_id) return media;
  return {
    ...media,
    ids: { tmdb: String(override.tmdb_id) },
    season: override.season == null ? media.season : Number(override.season),
    episode: override.episode == null ? media.episode : Number(override.episode),
  };
}

// A stored id on the episode itself (from the media server or an import)
// identifies this exact row and must win over a title-based guess - a short
// or common show title ("G'wed") can resolve TMDB's search to the wrong
// series, and overwriting an already-correct id with that wrong one sends
// every future Trakt dispatch for the show to a series Trakt has never heard
// of, which then can't be matched to clear or add anything (see the
// not_found handling in dispatchTrakt below). Existing ids are only filled
// in where the episode doesn't already have one, never replaced.
export function trackerMediaWithSeriesIds(media = {}, details = {}) {
  if ((media.type || media.mediaType) !== "episode") return media;
  const tmdb = String(details.id || details.external_ids?.tmdb_id || "").trim();
  const tvdb = String(details.external_ids?.tvdb_id || "").trim();
  const imdb = String(details.external_ids?.imdb_id || "").trim();
  if (!tmdb && !tvdb && !imdb) return media;
  const existingIds = media.ids || {};
  return {
    ...media,
    showTitle: trackerShowTitle(media),
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(tvdb ? { tvdb } : {}),
      ...(imdb ? { imdb } : {}),
      ...existingIds,
    },
  };
}

// Same backfill-only reasoning as trackerMediaWithSeriesIds above, for a
// movie instead of an episode: fills in ids the movie arrived without (e.g. a
// media server webhook for a very new release whose own metadata agent has not
// matched yet, like ids: {} straight from Plex), never
// replaces an id that's already there.
export function trackerMediaWithMovieIds(media = {}, details = {}) {
  if ((media.type || media.mediaType) !== "movie") return media;
  const tmdb = String(details.id || details.external_ids?.tmdb_id || "").trim();
  const tvdb = String(details.external_ids?.tvdb_id || "").trim();
  const imdb = String(details.external_ids?.imdb_id || "").trim();
  if (!tmdb && !tvdb && !imdb) return media;
  const existingIds = media.ids || {};
  return {
    ...media,
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(tvdb ? { tvdb } : {}),
      ...(imdb ? { imdb } : {}),
      ...existingIds,
    },
  };
}

function primaryHydrationCacheKey(media = {}) {
  const type = media.type || media.mediaType;
  const title = type === "episode" ? trackerShowTitle(media) : String(media.title || "").trim();
  return `${type}:${title.toLowerCase().replace(/\s+/g, " ").trim()}:${String(media.year || "")}`;
}

// Trakt accepts any one provider id, so a sparse item already has a reliable
// primary payload and does not need a series metadata lookup merely to enrich
// it. This is especially important for legacy shows with hundreds of episode
// rows. Title-only items still need hydration; callers can share their
// series-level details promise across the whole Force batch.
async function hydrateTrackerMedia(media, {
  primaryHydrationCache = null,
  detailsResolver = getTmdbDetails,
} = {}) {
  const type = media.type || media.mediaType;
  if (type !== "episode" && type !== "movie") return media;
  if (trackerMediaIdentityKeys(media).length) return media;
  const resolveDetails = (args) => {
    const resolve = () => Promise.resolve().then(() => detailsResolver(args));
    if (!primaryHydrationCache) return resolve();
    const key = primaryHydrationCacheKey(media);
    if (!primaryHydrationCache.has(key)) primaryHydrationCache.set(key, resolve());
    return primaryHydrationCache.get(key);
  };
  if (type === "episode") {
    const title = trackerShowTitle(media);
    if (!title) return media;
    try {
      const details = await resolveDetails({
        mediaType: "tv",
        tmdbId: "",
        title,
        ids: {},
        light: true,
      });
      return trackerMediaWithSeriesIds(media, details);
    } catch {
      return media;
    }
  }
  const title = String(media.title || "").trim();
  if (!title) return media;
  try {
    const details = await resolveDetails({
      mediaType: "movie",
      tmdbId: "",
      title,
      ids: {},
      light: true,
    });
    return trackerMediaWithMovieIds(media, details);
  } catch {
    return media;
  }
}

function tokenExpiry(tokens) {
  const created = Number(tokens.created_at || Math.floor(Date.now() / 1000));
  return (created + Number(tokens.expires_in || 604800)) * 1000;
}

export async function withFreshTraktConnection(force = false) {
  let connection = getTrackerConnection("trakt", { includeCredentials: true });
  if (!connection || connection.status !== "connected") return null;
  connection = hydrateTraktAppCredentials(connection);
  if (!force && Number(connection.accessTokenExpiresAt || 0) > Date.now() + 5 * 60_000) return connection;
  if (!traktRefreshInFlight) {
    traktRefreshInFlight = refreshTraktToken(connection)
      .then((tokens) => {
        updateTrackerTokens("trakt", { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessTokenExpiresAt: tokenExpiry(tokens) });
      })
      .catch((error) => {
        updateTrackerConnectionStatus("trakt", { status: error.status === 400 || error.status === 401 ? "reauth_required" : "connected", lastError: error.message });
        throw error;
      })
      .finally(() => { traktRefreshInFlight = null; });
  }
  await traktRefreshInFlight;
  connection = getTrackerConnection("trakt", { includeCredentials: true });
  return hydrateTraktAppCredentials(connection);
}

// Trakt's /sync/history and /sync/history/remove both return 200 with a
// summary body - {added|deleted: {movies, episodes}, not_found: {movies,
// shows, seasons, episodes}} - even when nothing actually matched. A
// non-empty not_found means Trakt could not resolve the ids/season/episode
// we sent to a real item, which is a real failure that an HTTP 200 alone
// hides; without reading the body, a canonical replay's "clear existing
// plays first" step can silently do nothing while still being reported as a
// success.
function traktNotFoundCount(result) {
  const notFound = result?.not_found || {};
  return Object.values(notFound).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

// Trakt's history is a play log, not a "watched" flag - POST /sync/history
// always adds a new play, it never corrects an existing one. A canonical
// replay (Force Sync, a watched-date correction - anything sourced as
// "manual") isn't a fresh watch event, so clear any existing plays for this
// item first; otherwise every replay silently piles up duplicate history
// entries at whatever time it happened to run. A genuine watch reported by a
// media server still just adds, since that really is a new play. Removing an
// item with no existing history is a no-op on Trakt's side, not an error.
async function performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane = "sync", isCancelled = () => false) {
  // Keep a canonical remove -> add replay together inside one queue slot.
  // Serializing each request separately lets another episode's remove slip
  // between this item's remove and add, which defeats the atomic cancellation
  // guarantee and can expose a temporary unwatched state to the poller.
  return withTraktRateLimitRetry(async () => {
    if (isCancelled()) return { cancelled: true };
    let removeResult = null;
    if (isCanonicalReplay) {
      removeResult = await runTraktWrite(() => setTraktWatchState(connection, trackerMedia, "unwatched", { lane }));
    }
    const result = await runTraktWrite(() => setTraktWatchState(connection, trackerMedia, state, { lane }));
    return { removeResult, result };
  });
}

// A stored provider id remains the primary payload. Movies may receive one
// title-derived retry when Trakt rejects that id, because a movie title maps
// directly to the payload Trakt expects. Episodes are different: Trakt expects
// a series id plus season/episode coordinates, and a title search can select
// the wrong series. An existing episode identity is therefore never retried
// with a guessed series id. Title-only episodes can still be hydrated once
// before their first dispatch because they have no identity to protect.
function titleRetryCacheKey(media = {}) {
  const type = media.type || media.mediaType;
  if (type !== "movie") return "";
  const title = String(media.title || "").trim();
  return `${type}:${title.toLowerCase().replace(/\s+/g, " ").trim()}:${String(media.year || "")}`;
}

async function titleIdsForRetry(media, cache = null, detailsResolver = getTmdbDetails) {
  const type = media.type || media.mediaType;
  if (type !== "movie") return null;
  const title = String(media.title || "").trim();
  if (!title) return null;
  const resolve = async () => {
    const details = await Promise.resolve()
      .then(() => detailsResolver({ mediaType: "movie", title, light: true }))
      .catch(() => null);
    const ids = {
      imdb: String(details?.external_ids?.imdb_id || "").trim(),
      tmdb: String(details?.id || details?.external_ids?.tmdb_id || "").trim(),
      tvdb: String(details?.external_ids?.tvdb_id || "").trim(),
    };
    return ids.imdb || ids.tmdb || ids.tvdb ? ids : null;
  };
  if (!cache) return resolve();
  const key = titleRetryCacheKey(media);
  if (!key) return null;
  if (!cache.has(key)) cache.set(key, resolve());
  return cache.get(key);
}

// Resolve the identities the real Trakt dispatch can use before it mutates
// anything remotely. `hydrateTrackerMedia` fills title-only Force items while
// raw sparse IDs remain authoritative primaries. Only movies receive a
// title-derived not_found retry; an existing episode identity is never replaced
// with a guessed series id. Force Sync asks for the same safe candidates up
// front, so its preflight marker covers the item during the earlier LAN phase.
export async function trackerDispatchMediaCandidates(media = {}, {
  includeTitleFallback = false,
  primaryHydrationCache = null,
  titleFallbackCache = null,
  detailsResolver = getTmdbDetails,
} = {}) {
  const hadPrimaryIdentity = trackerMediaIdentityKeys(media).length > 0;
  const primary = await hydrateTrackerMedia(media, { primaryHydrationCache, detailsResolver });
  const candidates = trackerMediaIdentityKeys(primary).length ? [primary] : [];
  // A title-only item's hydrated primary already *is* its title-derived
  // candidate. Only raw-ID primaries need the separate not_found retry.
  const type = primary.type || primary.mediaType;
  if (includeTitleFallback && hadPrimaryIdentity && type !== "episode") {
    const titleIds = await titleIdsForRetry(primary, titleFallbackCache, detailsResolver).catch(() => null);
    if (titleIds) {
      const fallback = { ...primary, ids: titleIds };
      const primaryIds = JSON.stringify(Object.entries(primary.ids || {}).filter(([, value]) => value != null && String(value) !== "").sort());
      const fallbackIds = JSON.stringify(Object.entries(titleIds).filter(([, value]) => value != null && String(value) !== "").sort());
      if (fallbackIds !== primaryIds && trackerMediaIdentityKeys(fallback).length) candidates.push(fallback);
    }
  }
  return candidates;
}

function restoreIdValue(...values) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
}

function restoreIdsFromRow(row = {}) {
  const nested = row.ids && typeof row.ids === "object" ? row.ids : {};
  return {
    imdb: restoreIdValue(row.show_imdb_id, row.showImdbId, nested.imdb, row.imdb_id, row.imdbId),
    tmdb: restoreIdValue(row.show_tmdb_id, row.showTmdbId, nested.tmdb, row.tmdb_id, row.tmdbId),
    tvdb: restoreIdValue(row.show_tvdb_id, row.showTvdbId, nested.tvdb, row.tvdb_id, row.tvdbId),
  };
}

function restoreSeriesKey(media = {}) {
  return trackerShowTitle(media)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function restoreEpisodeCoordinate(row = {}) {
  const season = Number(row.season);
  const episode = Number(row.episode);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

// A watch-history row normally stores provider ids in flattened columns, but
// those columns are not consistent across old imports: some rows contain the
// series id, while others contain the exact episode id, and some contain none.
// A Trakt episode payload needs the series id. Repeated ids across different
// season/episode coordinates are strong evidence of a series identity; a
// single-coordinate id is treated as an episode id and is not used as the
// fallback. Ties are deliberately left unresolved so a same-titled pair of
// shows cannot be silently merged during an authoritative restore.
export function buildRestoreSeriesIdentityIndex(rows = []) {
  const byShow = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = String(row?.media_type || row?.mediaType || row?.type || "").toLowerCase();
    if (type !== "episode") continue;
    const showKey = restoreSeriesKey(row);
    const coordinate = restoreEpisodeCoordinate(row);
    if (!showKey || !coordinate) continue;

    if (!byShow.has(showKey)) byShow.set(showKey, new Map());
    const providerStats = byShow.get(showKey);
    const ids = restoreIdsFromRow(row);
    for (const [provider, value] of Object.entries(ids)) {
      if (!value) continue;
      const valueKey = provider === "imdb" ? value.toLowerCase() : value;
      if (!providerStats.has(provider)) providerStats.set(provider, new Map());
      if (!providerStats.get(provider).has(valueKey)) {
        providerStats.get(provider).set(valueKey, { value, coordinates: new Set() });
      }
      providerStats.get(provider).get(valueKey).coordinates.add(coordinate);
    }
  }

  const result = new Map();
  for (const [showKey, providerStats] of byShow) {
    const ids = {};
    const repeated = new Map();
    for (const [provider, values] of providerStats) {
      const candidates = [...values.entries()]
        .filter(([, entry]) => entry.coordinates.size >= 2)
        .sort((left, right) => right[1].coordinates.size - left[1].coordinates.size || left[0].localeCompare(right[0]));
      if (!candidates.length) continue;
      repeated.set(provider, new Set(candidates.map(([valueKey]) => valueKey)));
      const bestCount = candidates[0][1].coordinates.size;
      const winners = candidates.filter(([, entry]) => entry.coordinates.size === bestCount);
      if (winners.length === 1) ids[provider] = winners[0][1].value;
    }
    if (Object.keys(ids).length) result.set(showKey, { ids, repeated });
  }
  return result;
}

// Normalize rows that have no usable identity, or that only carry one-off
// episode ids, to the unambiguous repeated series identity discovered above.
// Rows with a conflicting repeated identity are left untouched and will fail
// closed rather than being assigned to the wrong show.
export function restoreMediaWithSeriesIdentityFallback(media = {}, index = new Map()) {
  const type = media.type || media.mediaType;
  if (type !== "episode" || !index?.get) return media;
  const identity = index.get(restoreSeriesKey(media));
  if (!identity?.ids || !Object.keys(identity.ids).length) return media;

  const currentIds = Object.fromEntries(Object.entries(media.ids || {}).filter(([, value]) => String(value ?? "").trim()));
  const currentEntries = Object.entries(currentIds);
  const sharesSeriesIdentity = currentEntries.some(([provider, value]) => {
    const canonical = identity.ids[provider];
    return canonical && String(canonical).trim().toLowerCase() === String(value).trim().toLowerCase();
  });
  const allIdsLookOneOff = currentEntries.length > 0 && currentEntries.every(([provider, value]) => {
    const valueKey = provider === "imdb" ? String(value).trim().toLowerCase() : String(value).trim();
    return !identity.repeated?.get(provider)?.has(valueKey);
  });
  if (currentEntries.length && !sharesSeriesIdentity && !allIdsLookOneOff) return media;

  const nextIds = JSON.stringify(Object.entries(identity.ids).sort(([left], [right]) => left.localeCompare(right)));
  const previousIds = JSON.stringify(Object.entries(currentIds).sort(([left], [right]) => left.localeCompare(right)));
  if (nextIds === previousIds) return media;
  return {
    ...media,
    showTitle: trackerShowTitle(media),
    ids: { ...identity.ids },
  };
}

function buildRestoreCoordinateIdentityIndex(rows = []) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = String(row?.media_type || row?.mediaType || row?.type || "").toLowerCase();
    if (type !== "episode") continue;
    const showKey = restoreSeriesKey(row);
    const coordinate = restoreEpisodeCoordinate(row);
    const ids = restoreIdsFromRow(row);
    if (!showKey || !coordinate || !Object.values(ids).some(Boolean)) continue;
    const key = `${showKey}:${coordinate}`;
    if (!result.has(key)) result.set(key, []);
    const sources = result.get(key);
    const signature = JSON.stringify(Object.entries(ids).sort(([left], [right]) => left.localeCompare(right)));
    if (!sources.some((source) => source.signature === signature)) sources.push({ ids, signature });
  }
  return result;
}

function restoreCoordinateIdentitySources(media = {}, index = new Map()) {
  const coordinate = restoreEpisodeCoordinate(media);
  if (!coordinate) return [];
  return index.get(`${restoreSeriesKey(media)}:${coordinate}`) || [];
}

function restoreSeriesIdsFromDetails(details = {}) {
  const external = details?.external_ids || {};
  const ids = {
    imdb: restoreIdValue(external.imdb_id, external.imdb),
    tmdb: restoreIdValue(details.id, external.tmdb_id, external.tmdb),
    tvdb: restoreIdValue(external.tvdb_id, external.tvdb),
  };
  return Object.fromEntries(Object.entries(ids).filter(([, value]) => value));
}

function restoreDetailsMatchShow(media = {}, details = {}) {
  const actualTitle = restoreIdValue(details.name, details.title, details.original_name);
  return Boolean(actualTitle && restoreSeriesKey({ showTitle: actualTitle }) === restoreSeriesKey(media));
}

function restoreIdentitySourceSignature(ids = {}) {
  return JSON.stringify(Object.entries(ids)
    .filter(([, value]) => String(value ?? "").trim())
    .sort(([left], [right]) => left.localeCompare(right)));
}

// A watch-history import can contain a title-only duplicate next to an older
// row with episode-level ids. Resolve that sibling through TMDB/TVDB before
// handing it to Trakt. The resolver is deliberately title-checked: an id from
// a similarly named show must never become the canonical series identity.
async function resolveRestoreSeriesIds(media = {}, sources = [], {
  cache = null,
  detailsResolver = getTmdbDetails,
} = {}) {
  const showTitle = trackerShowTitle(media);
  if (!showTitle) return null;
  const uniqueSources = [];
  const seen = new Set();
  for (const source of sources) {
    const ids = Object.fromEntries(Object.entries(source || {}).filter(([, value]) => String(value ?? "").trim()));
    if (!Object.keys(ids).length) continue;
    const signature = restoreIdentitySourceSignature(ids);
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueSources.push(ids);
  }

  for (const ids of uniqueSources) {
    const key = `${restoreSeriesKey(media)}:${restoreIdentitySourceSignature(ids)}`;
    const resolve = async () => {
      const details = await Promise.resolve().then(() => detailsResolver({
        mediaType: "tv",
        tmdbId: ids.tmdb || "",
        title: showTitle,
        ids: {
          ...(ids.tvdb ? { tvdbId: ids.tvdb } : {}),
          ...(ids.imdb ? { imdbId: ids.imdb } : {}),
        },
        light: true,
        verifyTvdbTitle: true,
      })).catch(() => null);
      if (!restoreDetailsMatchShow(media, details)) return null;
      const resolved = restoreSeriesIdsFromDetails(details);
      return Object.keys(resolved).length ? resolved : null;
    };
    const resolved = cache
      ? (cache.has(key) ? await cache.get(key) : (cache.set(key, resolve()), await cache.get(key)))
      : await resolve();
    if (resolved) return resolved;
  }
  return null;
}

function restoreMediaFromWatchRow(row = {}) {
  const type = String(row.media_type || row.mediaType || row.type || "").toLowerCase();
  return {
    isValid: true,
    source: "restore_replay",
    type,
    mediaType: type,
    title: row.title || "",
    showTitle: row.show_title || "",
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    year: row.year == null ? undefined : Number(row.year),
    ids: restoreIdsFromRow(row),
    watched_at: row.watched_at || "",
    watch_provenance: row.watch_provenance,
    ...(row.compound_episode ? { compound_episode: row.compound_episode } : {}),
    ...(row.compound_source_episode != null ? { compound_source_episode: row.compound_source_episode } : {}),
    ...(row.episode_title || row.episodeTitle ? { episodeTitle: row.episode_title || row.episodeTitle } : {}),
  };
}

// Keep the durable restore blocker small and safe to expose to the admin UI.
// The full watch_history row is deliberately not persisted in runtime_state:
// it contains artwork, provenance, and provider-specific fields that are not
// needed to repair one Trakt play. The source row id is enough to re-read the
// latest local mapping after the user fixes it in Plembfin.
function restoreIssueText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, 400);
}

function restoreIssueIds(ids = {}) {
  return Object.fromEntries(Object.entries(ids || {})
    .filter(([provider, value]) => ["imdb", "tmdb", "tvdb", "trakt"].includes(provider) && String(value ?? "").trim())
    .map(([provider, value]) => [provider, String(value).trim().slice(0, 120)]));
}

function restoreIssueCoordinates(value = {}) {
  const season = Number(value.season);
  const episode = Number(value.episode);
  return {
    season: Number.isInteger(season) && season >= 0 ? season : null,
    episode: Number.isInteger(episode) && episode >= 0 ? episode : null,
  };
}

export function serializeRestoreIssue(media = {}, sourceRow = {}, reason = "", index = 0, { candidate = false } = {}) {
  const type = String(media.type || media.mediaType || sourceRow.media_type || "").toLowerCase();
  const coordinates = restoreIssueCoordinates(media);
  const sourceCoordinates = restoreIssueCoordinates({
    season: sourceRow.season,
    episode: sourceRow.episode,
  });
  const title = restoreIssueText(sourceRow.title || media.title, "Unknown media");
  const showTitle = restoreIssueText(sourceRow.show_title || media.showTitle || trackerShowTitle(media));
  const watchedAt = restoreIssueText(media.watched_at || sourceRow.watched_at);
  const sourceRowId = restoreIssueText(sourceRow.id);
  const identity = sourceRowId
    || `${type}|${sourceRow.media_key || media.media_key || ""}|${watchedAt}|${title}|${index}`;
  return {
    key: `restore-row:${identity}`.slice(0, 280),
    sourceRowId: sourceRowId.slice(0, 240),
    sourceMediaKey: restoreIssueText(sourceRow.media_key || media.media_key).slice(0, 240),
    title,
    showTitle,
    sourceTitle: title,
    type: type === "episode" || type === "movie" ? type : "unknown",
    season: coordinates.season,
    episode: coordinates.episode,
    sourceSeason: sourceCoordinates.season,
    sourceEpisode: sourceCoordinates.episode,
    watchedAt,
    ids: restoreIssueIds(media.ids),
    sourceIds: restoreIssueIds(restoreIdsFromRow(sourceRow)),
    ...(media.compound_episode ? {
      compoundEpisode: {
        canonicalSeason: restoreIssueCoordinates(media.compound_episode).season,
        canonicalEpisode: Number.isInteger(Number(media.compound_episode.canonicalEpisode))
          ? Number(media.compound_episode.canonicalEpisode)
          : coordinates.episode,
        sourceRepresentation: String(media.compound_episode.sourceRepresentation || "split").slice(0, 20),
      },
    } : {}),
    ...(candidate ? { candidate: true } : {}),
    ...(reason ? { reason: restoreIssueText(reason, "Trakt could not match this restored play.") } : {}),
  };
}

async function prepareRestoreMediaForTrakt(row, {
  seriesIdentityIndex,
  coordinateIdentityIndex,
  resolvedSeriesByShow,
  seriesResolutionCache,
  detailsResolver = getTmdbDetails,
  logger = () => {},
  loggedSeriesFallbacks,
} = {}) {
  const rawMedia = restoreMediaFromWatchRow(row);
  const showKey = restoreSeriesKey(rawMedia);
  const identity = seriesIdentityIndex?.get(showKey);
  if (!resolvedSeriesByShow.has(showKey) && identity?.ids && Object.keys(identity.ids).length) {
    // Repeated ids are already the fail-closed series evidence built by
    // buildRestoreSeriesIdentityIndex; no remote lookup is needed for them.
    resolvedSeriesByShow.set(showKey, identity.ids);
  }

  let media = restoreMediaWithSeriesIdentityFallback(rawMedia, seriesIdentityIndex);
  if (media !== rawMedia && !loggedSeriesFallbacks.has(showKey)) {
    loggedSeriesFallbacks.add(showKey);
    logger(`Trakt restore: recovered the series identity for "${trackerShowTitle(media)}" from repeated restore rows.`);
  }

  if ((media.type || media.mediaType) === "episode") {
    let canonicalIds = resolvedSeriesByShow.get(showKey) || null;
    if (!canonicalIds && !identity?.ids?.length) {
      const coordinateSources = restoreCoordinateIdentitySources(media, coordinateIdentityIndex)
        .map((source) => source.ids);
      canonicalIds = await resolveRestoreSeriesIds(media, [media.ids, ...coordinateSources], {
        cache: seriesResolutionCache,
        detailsResolver,
      });
      if (canonicalIds) {
        resolvedSeriesByShow.set(showKey, canonicalIds);
        logger(`Trakt restore: resolved the canonical series identity for "${trackerShowTitle(media)}" from imported metadata.`);
      }
    }
    if (canonicalIds && Object.keys(canonicalIds).length) {
      media = {
        ...media,
        showTitle: trackerShowTitle(media),
        ids: { ...canonicalIds },
      };
    }
  }
  return mediaWithTraktOverride(await withSeasonSourceTraktOverride(media));
}

function historyBatches(items = [], batchSize = 100) {
  const batches = [];
  let batch = [];
  const keys = new Set();
  const limit = Math.max(1, Number(batchSize) || 100);
  for (const item of items) {
    const key = trackerMediaKey(item);
    // Trakt's grouped show/season payload cannot safely contain the same
    // episode twice. Split repeated plays into separate requests; each request
    // still carries its original watched_at and therefore remains a distinct
    // history event on Trakt.
    if (batch.length >= limit || keys.has(key)) {
      if (batch.length) batches.push(batch);
      batch = [];
      keys.clear();
    }
    batch.push(item);
    keys.add(key);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function replayCancellationError() {
  return Object.assign(new Error("Authoritative watch-history restore was cancelled before Trakt replay completed"), { code: "restore_cancelled" });
}

function traktNotFoundEntries(result = {}) {
  return Object.entries(result?.not_found || {})
    .filter(([, entries]) => Array.isArray(entries))
    .flatMap(([category, entries]) => entries.map((entry) => ({ category, entry })));
}

function traktNotFoundEntryValue(entry = {}) {
  return entry?.episode || entry?.movie || entry?.show || entry?.season || entry;
}

function traktNotFoundEntryCoordinates(entry = {}) {
  const value = traktNotFoundEntryValue(entry);
  const coordinates = [];
  const add = (seasonValue, episodeValue) => {
    const season = Number(seasonValue);
    const episode = Number(episodeValue);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return;
    if (!coordinates.some((coordinate) => coordinate.season === season && coordinate.episode === episode)) {
      coordinates.push({ season, episode });
    }
  };

  // Trakt returns an episode rejection in the same grouped shape accepted by
  // /sync/history: { ids, seasons: [{ number, episodes: [{ number }] }] }.
  // Also accept the flatter shape used by older responses and our unit tests.
  add(
    value?.season ?? value?.season_number ?? value?.seasonNumber,
    value?.number ?? value?.episode ?? value?.episode_number ?? value?.episodeNumber,
  );
  for (const seasonEntry of Array.isArray(value?.seasons) ? value.seasons : []) {
    const season = seasonEntry?.number ?? seasonEntry?.season ?? seasonEntry?.season_number ?? seasonEntry?.seasonNumber;
    for (const episodeEntry of Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : []) {
      add(
        season,
        episodeEntry?.number ?? episodeEntry?.episode ?? episodeEntry?.episode_number ?? episodeEntry?.episodeNumber,
      );
    }
  }
  return coordinates;
}

function providerIdsOverlap(media = {}, entry = {}) {
  const value = traktNotFoundEntryValue(entry);
  const entryIds = value?.ids || entry?.ids || {};
  const mediaIds = media?.ids || {};
  return Object.entries(entryIds).some(([provider, value]) => (
    value != null
    && String(value) !== ""
    && mediaIds[provider] != null
    && String(mediaIds[provider]).trim().toLowerCase() === String(value).trim().toLowerCase()
  ));
}

function traktNotFoundMatchesMedia(media = {}, category = "", entry = {}) {
  if (!providerIdsOverlap(media, entry)) return false;
  const type = media.type || media.mediaType;
  if (type !== "episode") return category === "movies";
  if (category === "shows") return true;
  const entryCoordinates = traktNotFoundEntryCoordinates(entry);
  if (!entryCoordinates.length) return true;
  return entryCoordinates.some(({ season, episode }) => (
    Number(media.season) === season && Number(media.episode) === episode
  ));
}

export function partitionTraktNotFoundBatch(batch = [], result = {}) {
  const entries = traktNotFoundEntries(result);
  if (!entries.length) return { accepted: [], rejected: [], entries };
  const rejected = batch.filter((media) => entries.some(({ category, entry }) => traktNotFoundMatchesMedia(media, category, entry)));
  return {
    accepted: batch.filter((media) => !rejected.includes(media)),
    rejected,
    entries,
  };
}

function trackerHistoryEntryBatches(entries = [], batchSize = 100) {
  const batches = [];
  const keys = new Set();
  const limit = Math.max(1, Number(batchSize) || 100);
  let batch = [];
  for (const entry of entries) {
    const key = trackerMediaKey(entry.media);
    // The grouped Trakt payload cannot contain the same episode twice. Keep
    // duplicate local transition rows in separate requests rather than
    // silently dropping a legitimate rewatch.
    if (batch.length >= limit || keys.has(key)) {
      if (batch.length) batches.push(batch);
      batch = [];
      keys.clear();
    }
    batch.push(entry);
    keys.add(key);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function batchDispatchResult(index, media, status, detail) {
  return { index, media, mediaKey: media ? trackerMediaKey(media) : "", status, detail };
}

function batchDispatchSummary(results = []) {
  const values = results.filter(Boolean);
  const successful = values.filter((result) => result.status === "success").length;
  const failed = values.filter((result) => result.status === "failed").length;
  const skipped = values.length - successful - failed;
  return {
    skipped: successful === 0,
    status: failed ? (successful ? "partial" : "error") : skipped ? (successful ? "partial" : "skipped") : "success",
    results,
  };
}

// Dispatch a group of canonical manual watch transitions using Trakt's
// grouped /sync/history payload. A show with 300 episodes therefore needs a
// small number of requests instead of two requests per episode, while each
// episode still retains its own watched_at value. The caller owns the local
// media-server fan-out and uses the returned per-index results to append the
// Trakt target state to each local summary.
export async function dispatchTraktWatchStateBatch(items = [], state = "watched", {
  lane = "sync",
  batchSize = 100,
  canonicalReplay = state === "watched",
} = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const results = new Array(sourceItems.length);
  if (!sourceItems.length) return batchDispatchSummary(results);
  if (!["watched", "unwatched"].includes(String(state))) {
    const detail = `Unsupported Trakt batch state: ${state}`;
    sourceItems.forEach((media, index) => { results[index] = batchDispatchResult(index, media, "failed", detail); });
    return batchDispatchSummary(results);
  }

  const eligible = [];
  for (const [index, sourceMedia] of sourceItems.entries()) {
    const media = sourceMedia || {};
    if (String(media.source || "").toLowerCase().includes("trakt")) {
      results[index] = batchDispatchResult(index, media, "skipped", "Source tracker echo suppressed");
      continue;
    }
    eligible.push({ index, sourceMedia: media });
  }
  if (!eligible.length) return batchDispatchSummary(results);

  let connection;
  try {
    connection = await withFreshTraktConnection();
  } catch (error) {
    const detail = error.message || String(error);
    updateTrackerConnectionStatus("trakt", { lastError: detail });
    for (const { index, sourceMedia } of eligible) results[index] = batchDispatchResult(index, sourceMedia, "failed", detail);
    return batchDispatchSummary(results);
  }
  if (!connection) {
    for (const { index, sourceMedia } of eligible) results[index] = batchDispatchResult(index, sourceMedia, "skipped", "Trakt is not connected");
    return batchDispatchSummary(results);
  }

  const primaryHydrationCache = new Map();
  const titleFallbackCache = new Map();
  const resolved = [];
  for (const { index, sourceMedia } of eligible) {
    try {
      const canonicalMedia = mediaWithTraktOverride(await withSeasonSourceTraktOverride(canonicalCompoundEpisodeMedia(sourceMedia)));
      const [candidate] = await trackerDispatchMediaCandidates(canonicalMedia, {
        includeTitleFallback: true,
        primaryHydrationCache,
        titleFallbackCache,
      });
      if (!candidate) {
        throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item"), { code: "not_found" });
      }
      const media = {
        ...candidate,
        source: canonicalMedia.source || "manual",
        watched_at: canonicalMedia.watched_at,
      };
      resolved.push({ index, sourceMedia, media });
    } catch (error) {
      const status = error.code === "not_found" ? "not_found" : "failed";
      results[index] = batchDispatchResult(index, sourceMedia, status, error.message || String(error));
    }
  }
  if (!resolved.length) return batchDispatchSummary(results);

  // Publish every intent before the first remove call. This is the same race
  // barrier used by the single-item dispatcher, but written in one SQLite
  // transaction so a tracker poll cannot observe only the first part of a
  // large show.
  recordTrackerOutboundBatch("trakt", resolved.map(({ media }) => ({
    mediaKey: trackerMediaKey(media),
    media,
    state,
  })));

  let refreshedConnection = false;
  const callBatch = async (batch, batchState) => {
    const payload = batch.map((entry) => entry.media);
    try {
      return await withTraktRateLimitRetry(() => setTraktWatchHistoryBatch(connection, payload, batchState, { lane }));
    } catch (error) {
      if (Number(error?.status) !== 401 || refreshedConnection) throw error;
      refreshedConnection = true;
      connection = await withFreshTraktConnection(true);
      if (!connection) throw error;
      return withTraktRateLimitRetry(() => setTraktWatchHistoryBatch(connection, payload, batchState, { lane }));
    }
  };

  const batches = trackerHistoryEntryBatches(resolved, batchSize);
  const addable = [];
  const removeBeforeAdd = String(state) === "unwatched" || canonicalReplay;
  for (const batch of batches) {
    if (!removeBeforeAdd) {
      addable.push(batch);
      continue;
    }
    try {
      // Removing an already-absent play is intentionally harmless; the
      // remove endpoint reports that as not_found in its 200 response.
      await callBatch(batch, "unwatched");
      if (String(state) === "unwatched") {
        for (const entry of batch) results[entry.index] = batchDispatchResult(entry.index, entry.media, "success", "Marked unwatched on Trakt");
      } else {
        addable.push(batch);
      }
    } catch (error) {
      const detail = error.message || String(error);
      for (const entry of batch) results[entry.index] = batchDispatchResult(entry.index, entry.media, "failed", detail);
    }
  }

  for (const batch of addable) {
    try {
      const result = await callBatch(batch, "watched");
      const notFound = traktNotFoundCount(result);
      if (!notFound) {
        for (const entry of batch) results[entry.index] = batchDispatchResult(entry.index, entry.media, "success", "Marked watched on Trakt (batched)");
        recordTrackerOutboundBatch("trakt", batch.map(({ media }) => ({
          mediaKey: trackerMediaKey(media),
          media,
          state: "watched",
        })));
        continue;
      }

      const mediaBatch = batch.map((entry) => entry.media);
      const partition = partitionTraktNotFoundBatch(mediaBatch, result);
      const rejectedKeys = new Set(partition.rejected.map((media) => trackerMediaKey(media)));
      for (const entry of batch) {
        const key = trackerMediaKey(entry.media);
        if (!rejectedKeys.size || rejectedKeys.has(key)) {
          const dismissed = isTraktNotFoundDismissed(entry.media);
          results[entry.index] = dismissed
            ? {
              ...batchDispatchResult(
                entry.index,
                entry.media,
                "skipped",
                `${DISMISSED_TRAKT_NOT_FOUND_DETAIL} (retry still returned not_found)`,
              ),
              dismissed: true,
            }
            : batchDispatchResult(
              entry.index,
              entry.media,
              "not_found",
              "Trakt could not match this item to mark it watched",
            );
        } else {
          results[entry.index] = batchDispatchResult(entry.index, entry.media, "success", "Marked watched on Trakt (batched)");
        }
      }
      if (partition.accepted.length) {
        recordTrackerOutboundBatch("trakt", batch
          .filter((entry) => !rejectedKeys.has(trackerMediaKey(entry.media)))
          .map(({ media }) => ({ mediaKey: trackerMediaKey(media), media, state: "watched" })));
      }
    } catch (error) {
      const detail = error.message || String(error);
      for (const entry of batch) results[entry.index] = batchDispatchResult(entry.index, entry.media, "failed", detail);
    }
  }

  const successfulWatchedAt = resolved
    .filter(({ index }) => results[index]?.status === "success")
    .map(({ media }) => Date.parse(String(media.watched_at || "")))
    .filter(Number.isFinite);
  const hasFailure = results.some((result) => result?.status === "failed" || result?.status === "not_found");
  if (successfulWatchedAt.length && !hasFailure) {
    updateTrackerConnectionStatus("trakt", {
      lastError: "",
    });
  }
  if (hasFailure) {
    const firstFailure = results.find((result) => result?.status === "failed" || result?.status === "not_found");
    if (firstFailure?.detail) updateTrackerConnectionStatus("trakt", { lastError: firstFailure.detail });
  }
  return batchDispatchSummary(results);
}

// Replace Trakt's append-only play log with the restored Plembfin history.
// This is intentionally a clear-and-replay operation: POST /sync/history does
// not edit an existing play's timestamp, so simply adding the restored rows
// would leave the incorrect "today" plays in place forever.
export async function replayTraktWatchHistory(rows = [], {
  logger = () => {},
  shouldCancel = async () => false,
  batchSize = 100,
  detailsResolver = getTmdbDetails,
} = {}) {
  let connection = await withFreshTraktConnection();
  if (!connection) return { skipped: true, reason: "Trakt is not connected", cleared: 0, replayed: 0 };

  const rawSourceRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => !["unwatched", "unplayed"].includes(String(row.sync_action || row.syncAction || "watched").toLowerCase()))
    .sort((left, right) => String(left.watched_at || "").localeCompare(String(right.watched_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  const compoundProjection = canonicalizeCompoundEpisodeRows(rawSourceRows);
  const sourceRows = compoundProjection.rows;
  if (compoundProjection.mapped || compoundProjection.collapsed) {
    logger(`Trakt restore: projected ${compoundProjection.mapped} split/compound coordinate(s) to canonical episode(s); collapsed ${compoundProjection.collapsed} same-session split pair(s).`);
  }
  const primaryHydrationCache = new Map();
  const titleFallbackCache = new Map();
  // Build identity evidence from the raw coordinates. Canonicalizing S05E21 +
  // S05E22 to one Trakt coordinate must not erase the repeated-id evidence
  // needed to recover the show's series identity.
  const seriesIdentityIndex = buildRestoreSeriesIdentityIndex(rawSourceRows);
  const coordinateIdentityIndex = buildRestoreCoordinateIdentityIndex(rawSourceRows);
  const resolvedSeriesByShow = new Map();
  const seriesResolutionCache = new Map();
  const loggedSeriesFallbacks = new Set();
  const restoreSourceByMedia = new WeakMap();
  const resolved = new Array(sourceRows.length);
  let pending = [];

  const resolveRow = async (row, {
    rowPrimaryHydrationCache = primaryHydrationCache,
    rowTitleFallbackCache = titleFallbackCache,
    rowSeriesResolutionCache = seriesResolutionCache,
  } = {}) => {
    if (await shouldCancel()) throw replayCancellationError();
    const media = await prepareRestoreMediaForTrakt(row, {
      seriesIdentityIndex,
      coordinateIdentityIndex,
      resolvedSeriesByShow,
      seriesResolutionCache: rowSeriesResolutionCache,
      detailsResolver,
      logger,
      loggedSeriesFallbacks,
    });
    const candidates = await trackerDispatchMediaCandidates(media, {
      includeTitleFallback: true,
      primaryHydrationCache: rowPrimaryHydrationCache,
      titleFallbackCache: rowTitleFallbackCache,
    });
    const candidate = candidates[0];
    if (!candidate) return null;
    const resolvedCandidate = { ...candidate, source: "restore_replay", watched_at: media.watched_at };
    restoreSourceByMedia.set(resolvedCandidate, { row, media });
    return resolvedCandidate;
  };

  for (let index = 0; index < sourceRows.length; index += 1) {
    const candidate = await resolveRow(sourceRows[index]);
    if (candidate) resolved[index] = candidate;
    else pending.push({ index, row: sourceRows[index] });
  }

  const resolutionRetryCount = 3;
  for (let attempt = 1; pending.length && attempt <= resolutionRetryCount; attempt += 1) {
    if (await shouldCancel()) throw replayCancellationError();
    logger(`Trakt restore: retrying ${pending.length} unresolved item(s) (attempt ${attempt}/${resolutionRetryCount})...`);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const retryPrimaryHydrationCache = new Map();
    const retryTitleFallbackCache = new Map();
    const retrySeriesResolutionCache = new Map();
    const nextPending = [];
    for (const item of pending) {
      const candidate = await resolveRow(item.row, {
        rowPrimaryHydrationCache: retryPrimaryHydrationCache,
        rowTitleFallbackCache: retryTitleFallbackCache,
        rowSeriesResolutionCache: retrySeriesResolutionCache,
      });
      if (candidate) resolved[item.index] = candidate;
      else nextPending.push(item);
    }
    pending = nextPending;
  }

  if (pending.length) {
    const examples = pending.slice(0, 5).map(({ row }) => row.title || "unknown title").join(", ");
    const restoreIssues = pending.map(({ row }, index) => serializeRestoreIssue(
      restoreMediaFromWatchRow(row),
      row,
      "Trakt could not resolve this restored item to a provider identity.",
      index,
    ));
    throw Object.assign(
      new Error(`Trakt could not resolve ${pending.length} restored item(s) after ${resolutionRetryCount} retries (for example: ${examples})`),
      {
        code: "not_found",
        restoreIssues,
        restoreIssueCount: pending.length,
        restoreIssuesComplete: true,
      },
    );
  }

  const desired = resolved.filter(Boolean);

  if (await shouldCancel()) throw replayCancellationError();
  let existing = await fetchTraktPlayHistory(connection);
  const existingByKey = new Map();
  for (const entry of existing) {
    const key = trackerMediaKey(entry.media);
    if (key && !existingByKey.has(key)) existingByKey.set(key, entry.media);
  }

  const callBatch = async (items, state) => {
    if (await shouldCancel()) throw replayCancellationError();
    try {
      return await setTraktWatchHistoryBatch(connection, items, state, { lane: "sync" });
    } catch (error) {
      if (error.status !== 401) throw error;
      connection = await withFreshTraktConnection(true);
      if (!connection) throw error;
      return setTraktWatchHistoryBatch(connection, items, state, { lane: "sync" });
    }
  };

  const removeBatches = historyBatches([...existingByKey.values()], batchSize);
  let cleared = 0;
  for (const batch of removeBatches) {
    const result = await callBatch(batch, "unwatched");
    const notFound = traktNotFoundCount(result);
    if (notFound) throw new Error(`Trakt rejected ${notFound} item(s) while clearing existing history`);
    cleared += batch.length;
    logger(`Trakt restore: cleared ${cleared}/${existingByKey.size} existing item(s).`);
  }

  const addBatches = historyBatches(desired, batchSize);
  let replayed = 0;
  let replayRetryCalls = 0;
  let rejectedPlays = [];
  for (const batch of addBatches) {
    const result = await callBatch(batch, "watched");
    const notFound = traktNotFoundCount(result);
    if (notFound) {
      const partition = partitionTraktNotFoundBatch(batch, result);
      if (!partition.rejected.length) {
        logger(`Trakt restore: ${notFound} rejected play(s) could not be isolated from the batch response.`);
        const restoreIssues = batch.map((media, index) => {
          const source = restoreSourceByMedia.get(media);
          return serializeRestoreIssue(
            media,
            source?.row || {},
            "Trakt returned not_found but did not identify the affected play in its response.",
            index,
            { candidate: true },
          );
        });
        throw Object.assign(
          new Error(`Trakt rejected ${notFound} restored play(s) as not_found without identifying the affected item(s)`),
          {
            code: "not_found",
            restoreIssues,
            restoreIssueCount: notFound,
            restoreIssuesComplete: false,
          },
        );
      }
      rejectedPlays.push(...partition.rejected.map((media) => ({
        media,
        desiredIndex: desired.indexOf(media),
        sourceRow: restoreSourceByMedia.get(media)?.row || {},
      })));
      replayed += partition.accepted.length;
      logger(`Trakt restore: queued ${partition.rejected.length} rejected play(s) for retry; replayed ${replayed}/${desired.length} historical play(s) so far.`);
      continue;
    }
    replayed += batch.length;
    logger(`Trakt restore: replayed ${replayed}/${desired.length} historical play(s).`);
  }

  const rejectedRetryCount = 3;
  for (let attempt = 1; rejectedPlays.length && attempt <= rejectedRetryCount; attempt += 1) {
    if (await shouldCancel()) throw replayCancellationError();
    logger(`Trakt restore: retrying ${rejectedPlays.length} rejected play(s) (attempt ${attempt}/${rejectedRetryCount})...`);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const retrySeriesResolutionCache = new Map();
    const nextRejected = [];
    for (const original of rejectedPlays) {
      if (await shouldCancel()) throw replayCancellationError();
      let retryMedia = original.media;
      if ((retryMedia.type || retryMedia.mediaType) === "episode") {
        const refreshedIds = await resolveRestoreSeriesIds(retryMedia, [retryMedia.ids], {
          cache: retrySeriesResolutionCache,
          detailsResolver,
        });
        if (refreshedIds) retryMedia = { ...retryMedia, ids: refreshedIds };
      }
      replayRetryCalls += 1;
      try {
        const result = await callBatch([retryMedia], "watched");
        if (traktNotFoundCount(result)) {
          nextRejected.push({
            media: retryMedia,
            desiredIndex: original.desiredIndex,
            sourceRow: original.sourceRow || restoreSourceByMedia.get(original.media)?.row || {},
            reason: "Trakt returned not_found for this play after retrying its stored mapping.",
          });
          continue;
        }
        if (original.desiredIndex >= 0) desired[original.desiredIndex] = retryMedia;
        replayed += 1;
        logger(`Trakt restore: replayed ${replayed}/${desired.length} historical play(s).`);
      } catch (error) {
        nextRejected.push({
          media: retryMedia,
          desiredIndex: original.desiredIndex,
          sourceRow: original.sourceRow || restoreSourceByMedia.get(original.media)?.row || {},
          reason: error.message || String(error),
        });
      }
    }
    rejectedPlays = nextRejected;
  }

  if (rejectedPlays.length) {
    const examples = rejectedPlays.slice(0, 5).map(({ media }) => media.title || "unknown title").join(", ");
    const restoreIssues = rejectedPlays.map(({ media, sourceRow, reason }, index) => serializeRestoreIssue(
      media,
      sourceRow,
      reason || "Trakt could not match this restored play.",
      index,
    ));
    throw Object.assign(
      new Error(`Trakt rejected ${rejectedPlays.length} restored play(s) after ${rejectedRetryCount} retries (for example: ${examples})`),
      {
        code: "not_found",
        restoreIssues,
        restoreIssueCount: rejectedPlays.length,
        restoreIssuesComplete: true,
      },
    );
  }

  // Keep the local Trakt projection aligned with the remote replacement before
  // the next scheduled poll can interpret the old snapshot as an unwatch.
  const latestByKey = new Map();
  for (const media of desired) latestByKey.set(trackerMediaKey(media), media);
  const snapshot = [...latestByKey.entries()].map(([mediaKey, media]) => ({
    mediaKey,
    media,
    watchedAt: Date.parse(String(media.watched_at || "")) || Date.now(),
  }));
  replaceTrackerSnapshot("trakt", snapshot);
  recordTrackerOutboundBatch("trakt", snapshot.map(({ mediaKey, media }) => ({ mediaKey, media, state: "watched" })));
  updateTrackerConnectionStatus("trakt", { lastError: "" });
  existing = null;
  return {
    skipped: false,
    cleared,
    replayed,
    compoundMapped: compoundProjection.mapped,
    compoundCollapsed: compoundProjection.collapsed,
    clearBatches: removeBatches.length,
    replayBatches: addBatches.length + replayRetryCalls,
  };
}

// Retry one rejected restore play without clearing or replaying the rest of
// Trakt history. The route calls this only while the authoritative restore
// fence still belongs to the failed run. Re-read the source row so a user can
// open the item in Plembfin, fix its match, and then retry the corrected ids.
export async function retryTraktRestoreItem(row = {}, {
  rows = [],
  logger = () => {},
  detailsResolver = getTmdbDetails,
  shouldCancel = async () => false,
} = {}) {
  let connection;
  try {
    connection = await withFreshTraktConnection();
  } catch (error) {
    return { success: false, code: error.code || "connection", error: error.message || String(error) };
  }
  if (!connection) return { success: false, code: "not_connected", error: "Trakt is not connected." };

  const sourceRows = (Array.isArray(rows) && rows.length ? rows : [row])
    .filter((candidate) => !["unwatched", "unplayed"].includes(String(candidate?.sync_action || candidate?.syncAction || "watched").toLowerCase()))
    .sort((left, right) => String(left?.watched_at || "").localeCompare(String(right?.watched_at || "")) || String(left?.id || "").localeCompare(String(right?.id || "")));
  const projection = canonicalizeCompoundEpisodeRows(sourceRows);
  const rowId = String(row?.id || "").trim();
  const projectedRow = projection.rows.find((candidate) => rowId && String(candidate?.id || "") === rowId) || row;
  if (!projectedRow || !String(projectedRow.media_type || projectedRow.mediaType || projectedRow.type || "").trim()) {
    return { success: false, code: "not_found", error: "The restored Plekt watch-history row could not be found." };
  }

  const primaryHydrationCache = new Map();
  const titleFallbackCache = new Map();
  const seriesIdentityIndex = buildRestoreSeriesIdentityIndex(sourceRows);
  const coordinateIdentityIndex = buildRestoreCoordinateIdentityIndex(sourceRows);
  const resolvedSeriesByShow = new Map();
  const seriesResolutionCache = new Map();
  const loggedSeriesFallbacks = new Set();
  let media;
  try {
    media = await prepareRestoreMediaForTrakt(projectedRow, {
      seriesIdentityIndex,
      coordinateIdentityIndex,
      resolvedSeriesByShow,
      seriesResolutionCache,
      detailsResolver,
      logger,
      loggedSeriesFallbacks,
    });
  } catch (error) {
    return { success: false, code: error.code || "not_found", error: error.message || String(error) };
  }
  const candidates = await trackerDispatchMediaCandidates(media, {
    includeTitleFallback: true,
    primaryHydrationCache,
    titleFallbackCache,
    detailsResolver,
  });
  if (!candidates.length) {
    return { success: false, code: "not_found", error: "Plekt could not resolve this watch-history row to a Trakt identity." };
  }

  const callBatch = async (candidate) => {
    if (await shouldCancel()) {
      return { cancelled: true };
    }
    try {
      return await setTraktWatchHistoryBatch(connection, [candidate], "watched", { lane: "sync" });
    } catch (error) {
      if (error.status !== 401) throw error;
      connection = await withFreshTraktConnection(true);
      if (!connection) throw error;
      return setTraktWatchHistoryBatch(connection, [candidate], "watched", { lane: "sync" });
    }
  };

  let lastError = "Trakt could not match this restored play.";
  for (const candidate of candidates) {
    const mediaKey = trackerMediaKey(candidate);
    recordTrackerOutbound("trakt", mediaKey, candidate, "watched");
    try {
      const result = await callBatch(candidate);
      if (result?.cancelled) return { success: false, code: "restore_changed", error: "The restore changed or was cancelled before this play was repaired." };
      if (traktNotFoundCount(result)) {
        lastError = "Trakt returned not_found for this play using the current Plekt mapping.";
        continue;
      }
      recordTrackerOutbound("trakt", mediaKey, candidate, "watched");
      updateTrackerConnectionStatus("trakt", {
        lastError: "",
      });
      return { success: true, media: candidate, mediaKey };
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  return { success: false, code: "not_found", error: lastError };
}

// A background retry follows a timeout or 5xx, and Trakt may have written the
// play before the response was lost. Look for that play near the row's
// watched_at so the retry cannot add a second one (core-sync-health step 1).
const TRAKT_RETRY_HISTORY_WINDOW_MS = 60_000;

async function findExistingTraktPlay(connection, trackerMedia, watchedAt) {
  const watchedMs = Date.parse(String(watchedAt || ""));
  if (!Number.isFinite(watchedMs)) return null;
  const range = {
    startAt: new Date(watchedMs - TRAKT_RETRY_HISTORY_WINDOW_MS).toISOString(),
    endAt: new Date(watchedMs + TRAKT_RETRY_HISTORY_WINDOW_MS).toISOString(),
  };
  const type = trackerMedia.type || trackerMedia.mediaType;
  const plays = await fetchTraktHistoryWindow(connection, type, range);
  return plays.find((play) => trackerMediaMatches(trackerMedia, play.media)) || null;
}

async function dispatchTrakt(media, state, lane = "sync", isCancelled = () => false) {
  const checkHistoryFirst = state === "watched" && Boolean(media?.traktRetryHistoryCheck);
  const retryWatchedAt = media?.watched_at || media?.watchedAt || "";
  // Trakt has one canonical coordinate for some two-part episodes (a split part is normalized
  // here; the local row is untouched). A Fix Match replaced show maps new watches too.
  media = mediaWithTraktOverride(await withSeasonSourceTraktOverride(canonicalCompoundEpisodeMedia(media)));
  let connection = await withFreshTraktConnection();
  if (!connection) return { target: "trakt", status: "skipped", detail: "Trakt is not connected" };
  // Anything sourced from Trakt itself - the live poller ("trakt") or a bulk
  // history import ("trakt_import", used by both the CSV/JSON importer and
  // the play-history backfill) - already exists on Trakt. Echoing it back
  // via /sync/history would create a duplicate play there every time.
  if (String(media.source || "").toLowerCase().includes("trakt")) return { target: "trakt", status: "skipped", detail: "Source tracker echo suppressed" };
  let [trackerMedia] = await trackerDispatchMediaCandidates(media);
  if (!trackerMedia) {
    [trackerMedia] = await trackerDispatchMediaCandidates(media, { includeTitleFallback: true });
  }
  if (!trackerMedia) {
    throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item"), { code: "not_found" });
  }
  if (checkHistoryFirst) {
    let existing;
    try {
      existing = await findExistingTraktPlay(connection, trackerMedia, retryWatchedAt);
    } catch (error) {
      if (error.status !== 401) throw error;
      connection = await withFreshTraktConnection(true);
      existing = await findExistingTraktPlay(connection, trackerMedia, retryWatchedAt);
    }
    if (existing) {
      return {
        target: "trakt",
        status: "success",
        detail: `Already on Trakt (play found in Trakt history at ${new Date(existing.watchedAt).toISOString()}); not added again`,
      };
    }
  }
  const isCanonicalReplay = state === "watched" && String(media.source || "").toLowerCase() === "manual";
  const mediaKey = trackerMediaKey(trackerMedia);
  // Prime the persistent echo ledger before touching Trakt. A canonical
  // replay is a non-atomic remove -> add pair; without this intent marker a
  // concurrent watched-state poll can observe the temporary gap and fan a
  // false unwatch back out to Plex/Emby/Jellyfin before the add completes.
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);
  let dispatch;
  try {
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane, isCancelled);
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    dispatch = await performTraktDispatch(connection, trackerMedia, state, isCanonicalReplay, lane, isCancelled);
  }
  if (dispatch?.cancelled) {
    return { target: "trakt", status: "cancelled", detail: "Trakt dispatch was cancelled before its queued write started" };
  }
  // Refresh the marker on confirmed completion so the normal Trakt
  // read-after-write consistency window is protected as well.
  recordTrackerOutbound("trakt", mediaKey, trackerMedia, state);

  let addNotFound = traktNotFoundCount(dispatch.result);
  let usedTitleIdFallback = false;
  if (addNotFound > 0) {
    const candidates = await trackerDispatchMediaCandidates(trackerMedia, { includeTitleFallback: true });
    const retryMedia = candidates[1] || null;
    if (retryMedia) {
      recordTrackerOutbound("trakt", trackerMediaKey(retryMedia), retryMedia, state);
      const retryDispatch = await performTraktDispatch(connection, retryMedia, state, isCanonicalReplay, lane).catch(() => null);
      if (retryDispatch && traktNotFoundCount(retryDispatch.result) === 0) {
        dispatch = retryDispatch;
        addNotFound = 0;
        usedTitleIdFallback = true;
        recordTrackerOutbound("trakt", trackerMediaKey(retryMedia), retryMedia, state);
      }
    }
  }
  if (addNotFound > 0) {
    if (isTraktNotFoundDismissed(trackerMedia)) {
      return {
        target: "trakt",
        status: "skipped",
        dismissed: true,
        detail: `${DISMISSED_TRAKT_NOT_FOUND_DETAIL} (retry still returned not_found)`,
      };
    }
    return {
      target: "trakt",
      status: "error",
      detail: `Trakt could not match this item to mark it ${state} (not_found: ${JSON.stringify(dispatch.result.not_found)})`,
    };
  }

  let detail = usedTitleIdFallback
    ? trackerMedia.type === "episode"
      ? `Marked ${state} on Trakt (this episode's own stored id didn't match; used the show's series id instead)`
      : `Marked ${state} on Trakt (the stored movie id didn't match; used the title-derived movie id instead)`
    : `Marked ${state} on Trakt`;
  if (isCanonicalReplay && dispatch.removeResult) {
    const deleted = dispatch.removeResult.deleted || {};
    const deletedCount = Number(deleted.movies || 0) + Number(deleted.episodes || 0);
    const removeNotFound = traktNotFoundCount(dispatch.removeResult);
    detail += ` (cleared ${deletedCount} existing play${deletedCount === 1 ? "" : "s"} first`;
    detail += removeNotFound ? `, ${removeNotFound} not recognized: ${JSON.stringify(dispatch.removeResult.not_found)})` : ")";
  }
  return { target: "trakt", status: "success", detail };
}

// A multi-phase canonical replay may update Plembfin and the LAN media
// servers before its deliberately slower Trakt phase begins. Publish that
// final Trakt intent before the first local mutation so a poll that already
// fetched a stale snapshot can see it in its last-responsible-moment guard,
// rather than committing the opposite state in the gap between phases.
//
// The real dispatch records the same intent again immediately before and
// after its Trakt request. This early marker is therefore only a phase-order
// barrier; it does not replace the normal request-level echo protection.
export async function primeTrackerWatchStateIntents(entries = [], {
  detailsResolver = getTmdbDetails,
} = {}) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status !== "connected") return 0;
  const eligible = entries.filter(({ media }) => !String(media?.source || "").toLowerCase().includes("trakt"));
  // Resolve every item first, then publish the entire title under one SQLite
  // transaction. A poll in another process must never observe only the first
  // few hydrated markers while the remaining Force Sync items are still being
  // prepared.
  const primaryHydrationCache = new Map();
  const titleFallbackCache = new Map();
  const resolved = await Promise.all(eligible.map(async ({ media, state }) => {
    const canonicalMedia = canonicalCompoundEpisodeMedia(media);
    return {
      state,
      candidates: await trackerDispatchMediaCandidates(canonicalMedia, {
        includeTitleFallback: true,
        primaryHydrationCache,
        titleFallbackCache,
        detailsResolver,
      }),
    };
  }));
  const outboundByKey = new Map();
  for (const { state, candidates } of resolved) {
    for (const candidate of candidates) {
      const mediaKey = trackerMediaKey(candidate);
      // If primary and fallback prefer the same storage key, retain the
      // title-derived fallback (it is last) while still publishing both when
      // their IDs are wholly non-overlapping.
      outboundByKey.set(mediaKey, { mediaKey, media: candidate, state });
    }
  }
  const outbound = [...outboundByKey.values()];
  return recordTrackerOutboundBatch("trakt", outbound);
}

export async function dispatchTrackerWatchState(media, state, { lane = "sync", isCancelled = () => false } = {}) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status === "disabled") return [];
  if (isCancelled()) return [{ target: "trakt", status: "cancelled", detail: "Trakt dispatch was cancelled before it started" }];
  try {
    return [await dispatchTrakt(media, state, lane, isCancelled)];
  } catch (error) {
    updateTrackerConnectionStatus("trakt", { lastError: error.message });
    const status = error.code === "not_found" ? "not_found" : "failed";
    // Keep a rate-limit or server-error status in the detail even when Trakt
    // sent its own error text: the background retry queue reads the detail
    // to tell a transient failure from one that will never succeed.
    let detail = error.message || String(error);
    const httpStatus = Number(error?.status);
    const transientHttp = httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599);
    if (transientHttp && error.code !== "UPSTREAM_TIMEOUT" && !detail.includes(String(httpStatus))) detail += ` (HTTP ${httpStatus})`;
    return [{ target: "trakt", status, detail }];
  }
}

export function traktTokenExpiry(tokens) {
  return tokenExpiry(tokens);
}
