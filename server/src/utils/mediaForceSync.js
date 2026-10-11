// Scoped, detail-page Force Sync.
//
// Library-wide Force Sync deliberately treats Plembfin as canonical and does
// not import server-only watches. This module is the explicit, user-requested
// exception for one movie or show: inspect that title on connected servers,
// import the watched items found there, then replay the resulting canonical
// state to the configured destinations.

import { fetchPlexMetadataItem, fetchPlexSeriesEpisodes, findPlexItem } from "./plexClient.js";
import { fetchEmbySeriesEpisodes, fetchEmbyWatchedItems } from "./embyClient.js";
import { fetchJellyfinSeriesEpisodes, fetchJellyfinWatchedItems } from "./jellyfinClient.js";
import { normalizeProviderIds, parsePlexGuids } from "./parsers.js";
import { fetchTraktWatchedSnapshot, trackerMediaIdentityKeys } from "./traktClient.js";
import { withFreshTraktConnection } from "./trackerDispatcher.js";
import { isEmbyLikePlayed, releaseDateForItem, releaseDateForPlexItem, watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "./watchDates.js";
import { remoteEpisodeImportError } from "./episodeImportGuard.js";
import { appendSyncHistory, isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { runWithConcurrency } from "./concurrency.js";
import { appendCanonicalTrackerDispatch, primeCanonicalTrackerDispatchIntents, syncCanonicalPlaystate } from "./syncOrchestrator.js";
import {
  getCanonicalWatchState,
  findWatchedByAnyMediaKey,
  getWatchRecordById,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  queryShowDetail,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
  watchRowToMedia,
} from "./dataRepo.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const FORCE_SYNC_MODES = ["push", "pull"];
// Each item's outbound calls already run in parallel across targets
// (syncMediaPlaystate) and are throttled per-host by the outbound governor,
// so processing several episodes at once only shortens wall-clock time on a
// large show - it does not add outbound pressure beyond what's already safe.
const FORCE_SYNC_ITEM_CONCURRENCY = 6;
// Trakt is an internet service rather than a LAN destination. Keep its phase
// deliberately conservative even when Fast Local-Network Sync is enabled.
const TRACKER_FORCE_SYNC_ITEM_CONCURRENCY = 2;

function clean(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function idSet(ids = {}) {
  return new Set([ids.imdb, ids.tmdb, ids.tvdb].map(clean).filter(Boolean).map((id) => id.toLowerCase()));
}

function titleKey(value = "") {
  return clean(value)
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function sourceConfigured(config = {}, source) {
  if (source === "plex") return !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  return !config[source]?.disabled && Boolean(config[source]?.baseUrl && config[source]?.apiKey && config[source]?.userId);
}

export function normalizeMediaForceSyncRequest(input = {}) {
  const rawType = clean(input.type || input.media_type || input.mediaType).toLowerCase();
  const type = ["show", "series", "tv"].includes(rawType) ? "show" : rawType;
  const idsInput = input.ids || {};
  const ids = {
    imdb: clean(input.imdb_id || input.imdbId || input.imdb || idsInput.imdb),
    tmdb: clean(input.tmdb_id || input.tmdbId || input.tmdb || idsInput.tmdb),
    tvdb: clean(input.tvdb_id || input.tvdbId || input.tvdb || idsInput.tvdb),
  };
  const title = clean(input.title || input.name);
  const season = numberOrNull(input.season);
  const episode = numberOrNull(input.episode);
  // Optional subset of seasons for a show-scoped operation - lets the detail
  // page limit push/pull to the seasons the user picked instead of the whole
  // show. Empty/absent means "every season", the existing behavior.
  const rawSeasons = Array.isArray(input.seasons) ? input.seasons : clean(input.seasons).split(",");
  const seasons = [...new Set(rawSeasons.map(numberOrNull).filter((value) => value != null))].sort((a, b) => a - b);
  const rawMode = clean(input.mode || input.action).toLowerCase();
  const mode = rawMode === "push_to" ? "push" : rawMode === "pull_from" ? "pull" : rawMode;
  const sourceValue = clean(input.pull_from || input.pullFrom || input.source).toLowerCase();
  const targetValue = clean(input.push_to || input.pushTo || input.target).toLowerCase();
  const source = sourceValue === "all" ? "" : sourceValue;
  const target = targetValue === "all" ? "" : targetValue;

  if (!title) throw new Error("title is required");
  if (!["movie", "show", "episode"].includes(type)) throw new Error("type must be movie, show, or episode");
  if (!FORCE_SYNC_MODES.includes(mode)) throw new Error("mode must be push or pull");
  if (source && !MEDIA_SERVERS.includes(source)) throw new Error("source must be plex, emby, or jellyfin");
  if (target && ![...MEDIA_SERVERS, "trakt"].includes(target)) throw new Error("target must be plex, emby, jellyfin, or trakt");

  return { title, type, ids, season, episode, seasons, mode, source, target };
}

function sourceTitle(item = {}, source = "") {
  if (source === "plex") return clean(item.grandparentTitle || item.parentTitle || item.title);
  return clean(item.SeriesName || item.seriesName || item.ShowTitle || item.showTitle || item.GrandparentTitle || item.grandparentTitle || item.Name || item.name);
}

function itemTitle(item = {}, source = "") {
  if (source === "plex") return clean(item.title);
  return clean(item.Name || item.name || item.Title || item.title);
}

function itemType(item = {}, source = "") {
  if (source === "plex") return clean(item.type).toLowerCase() === "movie" ? "movie" : "episode";
  return clean(item.Type || item.type).toLowerCase() === "movie" ? "movie" : "episode";
}

function itemCoordinates(item = {}, source = "") {
  if (source === "plex") {
    return { season: numberOrNull(item.parentIndex), episode: numberOrNull(item.index) };
  }
  return { season: numberOrNull(item.ParentIndexNumber), episode: numberOrNull(item.IndexNumber) };
}

function itemIds(item = {}, source = "") {
  if (source === "plex") return parsePlexGuids(item);
  // For an episode, ProviderIds is the EPISODE's own tmdb/tvdb id (Emby/
  // Jellyfin assign episodes ids separate from their series), while
  // SeriesProviderIds is the show's - it must win when both carry the same
  // key, or the show/episode gets tagged with the wrong-scoped id (see the
  // showScopedKeys override below, and the identical Plex bug fixed in
  // forceSyncPlanner.js/scheduled.js via parsePlexMediaIds).
  return normalizeProviderIds({ ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) });
}

function itemNativeId(item = {}, source = "") {
  return source === "plex" ? clean(item.ratingKey) : clean(item.Id || item.id);
}

export function remoteItemIsWatched(item = {}, source = "") {
  if (source === "plex") {
    return Number(item.viewCount || 0) > 0 || Boolean(watchedAtForPlexItem(item).watchedAt);
  }
  return isEmbyLikePlayed(item);
}

// A played flag without a reliable played timestamp is historical state, not
// evidence of a watch happening right now (see the identical rule and
// rationale in watchDates.js) - background/scheduled sync still skips these
// entirely rather than invent a date, since fabricating "now" there once
// manufactured phantom watch-history rows for a whole rebuilt library at
// once. Detail-page Force Sync is different: it's one explicit, user-
// triggered action scoped to a single title (commonly hit when episodes were
// bulk-marked watched through a server's own library UI, which sets the
// played flag but not a played timestamp), so a missing date here falls back
// to the episode's own release date instead of discarding real evidence of a
// watch - anchored to a real, meaningful date rather than a fabricated
// "just watched" timestamp that would corrupt recency sorting.
export function remoteItemToMedia(item = {}, source = "", requested = {}, now = Date.now()) {
  const type = itemType(item, source);
  const coordinates = itemCoordinates(item, source);
  if (type === "episode" && (coordinates.season == null || coordinates.episode == null)) return null;

  const watchedAtResult = source === "plex" ? watchedAtForPlexItem(item) : watchedAtForEmbyLikeItem(item);
  const isPlayed = remoteItemIsWatched(item, source);
  let watchedAt = watchedAtResult.watchedAt || "";
  let watchedAtInferredFromRelease = false;
  if (isPlayed && !watchedAt) {
    const releaseDate = source === "plex" ? releaseDateForPlexItem(item) : releaseDateForItem(item);
    if (!releaseDate) return null;
    watchedAt = releaseDate;
    watchedAtInferredFromRelease = true;
  }

  const ids = itemIds(item, source);
  const requestedIds = requested.ids || {};
  // For an episode, tmdb_id/tvdb_id on the resulting watch record are the
  // SHOW's identity everywhere else in the app (grouping, routing, Fix
  // Match) - only imdb_id is meaningfully episode-scoped. But Plex/Emby/
  // Jellyfin's own per-item GUID/ProviderIds for an episode are the
  // EPISODE's own tmdb/tvdb ids (TVDB and TMDB both assign episodes their
  // own ids, separate from the series), so trusting them here tags every
  // freshly pulled episode with the wrong-scope id and fragments it into
  // its own show cluster instead of joining the real show's. The show-level
  // id this operation was explicitly requested against is always the more
  // trustworthy source for these two fields on an episode; imdb keeps the
  // item's own value since episode-level imdb ids don't cause this
  // mis-clustering (grouping unions on tmdb/tvdb, not imdb).
  const showScopedKeys = type === "episode" ? ["tmdb", "tvdb"] : [];
  for (const key of ["imdb", "tmdb", "tvdb"]) {
    if (showScopedKeys.includes(key) && requestedIds[key]) ids[key] = requestedIds[key];
    else if (!ids[key] && requestedIds[key]) ids[key] = requestedIds[key];
  }

  const showTitle = sourceTitle(item, source) || requested.title;
  const title = type === "episode"
    ? `${showTitle || "Unknown Show"} - S${String(coordinates.season).padStart(2, "0")}E${String(coordinates.episode).padStart(2, "0")}`
    : itemTitle(item, source) || requested.title;
  const itemId = itemNativeId(item, source);

  const media = {
    title,
    show_title: type === "episode" ? showTitle : undefined,
    episode_title: type === "episode" ? itemTitle(item, source) : undefined,
    type,
    ids,
    season: coordinates.season,
    episode: coordinates.episode,
    source,
    watched_at: watchedAt,
    itemId,
    isValid: true,
    watchProvenance: {
      source,
      ingest_path: "force_sync",
      event: "media_force_sync",
      phase: "completed",
      item_id: itemId,
      source_timestamp: watchedAtResult.watchedAt || "",
      note: watchedAtInferredFromRelease
        ? "Watched state explicitly imported from a connected media server from the media detail page; the server reported no watched date, so the episode's release date was used instead."
        : "Watched state explicitly imported from a connected media server from the media detail page.",
    },
  };

  if (remoteEpisodeImportError(media, { context: "library_scan" })) return null;
  return media;
}

function mediaMatchesRequest(media, requested) {
  if (!media) return false;
  if (requested.type === "movie" && media.type !== "movie") return false;
  if (requested.type !== "movie" && media.type !== "episode") return false;
  if (requested.season != null && Number(media.season) !== Number(requested.season)) return false;
  if (requested.episode != null && Number(media.episode) !== Number(requested.episode)) return false;
  if (requested.seasons?.length && !requested.seasons.includes(Number(media.season))) return false;

  const requestedIds = idSet(requested.ids);
  const mediaIds = idSet(media.ids);
  if (requestedIds.size && [...requestedIds].some((id) => mediaIds.has(id))) return true;

  if (requested.type === "movie") return titleKey(media.title) === titleKey(requested.title);
  const requestedShow = titleKey(requested.title);
  const mediaShow = titleKey(media.show_title || media.title.split(/\s+-\s+S\d/i)[0]);
  return Boolean(requestedShow && mediaShow && requestedShow === mediaShow);
}

function mediaIdentity(media) {
  if (media.type === "episode") {
    return `episode:${titleKey(media.show_title || media.title.split(/\s+-\s+S\d/i)[0])}:${media.season}:${media.episode}`;
  }
  const ids = media.ids || {};
  return `movie:${clean(ids.imdb || ids.tmdb || ids.tvdb).toLowerCase() || titleKey(media.title)}`;
}

function dedupeMedia(items = []) {
  const byIdentity = new Map();
  for (const item of items) {
    const key = mediaIdentity(item);
    const existing = byIdentity.get(key);
    if (!existing || Date.parse(item.watched_at || "") > Date.parse(existing.watched_at || "")) byIdentity.set(key, item);
  }
  return [...byIdentity.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)) || Number(a.season || 0) - Number(b.season || 0) || Number(a.episode || 0) - Number(b.episode || 0));
}

async function collectSourceItems(config, requested, source, now) {
  const sourceConfig = config[source];
  let rawItems = [];
  const lookup = { ...requested, type: requested.type === "movie" ? "movie" : "episode" };

  if (source === "plex") {
    if (requested.type === "movie") {
      const item = await findPlexItem(sourceConfig, lookup);
      const fullItem = item?.ratingKey ? await fetchPlexMetadataItem(sourceConfig, item.ratingKey) : null;
      rawItems = fullItem ? [fullItem] : item ? [item] : [];
    } else {
      rawItems = await fetchPlexSeriesEpisodes(sourceConfig, { ...lookup, type: "series" });
    }
  } else if (source === "emby") {
    rawItems = requested.type === "movie"
      ? await fetchEmbyWatchedItems(sourceConfig)
      : await fetchEmbySeriesEpisodes(sourceConfig, { ...lookup, type: "episode" });
  } else if (source === "jellyfin") {
    rawItems = requested.type === "movie"
      ? await fetchJellyfinWatchedItems(sourceConfig)
      : await fetchJellyfinSeriesEpisodes(sourceConfig, { ...lookup, type: "episode" });
  }

  return rawItems
    .filter((item) => remoteItemIsWatched(item, source))
    .map((item) => remoteItemToMedia(item, source, requested, now))
    .filter((media) => mediaMatchesRequest(media, requested));
}

function sourceLabel(source = "") {
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : "all connected servers";
}

function modeLabel(mode = "push") {
  return mode === "pull" ? "Import Watched Status" : "Set Plekt as Source of Truth";
}

export function canonicalStateForShowHistoryRow(row = {}) {
  const action = clean(row.sync_action || row.syncAction).toLowerCase();
  return ["unwatched", "unplayed"].includes(action) ? "unwatched" : "watched";
}

async function collectLocalCanonicalItems(requested, { logger = () => {} } = {}) {
  if (requested.type === "show") {
    logger(`[push] Plekt:loading canonical episode states for "${requested.title}".`);
    const show = await queryShowDetail({ title: requested.title });
    const items = (show?.episodes || [])
      .map((row) => ({
        ...watchRowToMedia(row, "manual"),
        show_title: row.show_title || undefined,
        episode_title: row.episode_title || undefined,
        canonicalRecordId: row.id || "",
        canonicalState: canonicalStateForShowHistoryRow(row),
        isValid: true,
      }))
      .filter((media) => mediaMatchesRequest(media, requested));
    const watchedCount = items.filter((item) => item.canonicalState === "watched").length;
    const unwatchedCount = items.length - watchedCount;
    logger(`[push] Plekt:found ${items.length} canonical episode state${items.length === 1 ? "" : "s"} (${watchedCount} watched, ${unwatchedCount} unwatched).`);
    return {
      items,
      sourceResults: [{ source: "plembfin", status: items.length ? "success" : "not_watched", watchedCount }],
    };
  }

  const probe = {
    title: requested.title,
    type: requested.type,
    ids: requested.ids,
    season: requested.season,
    episode: requested.episode,
    isValid: true,
  };
  const canonicalState = await getCanonicalWatchState(probe).catch(() => null);
  if (!canonicalState) {
    logger(`[push] Plekt:no canonical state exists for "${requested.title}".`);
    return { items: [], sourceResults: [{ source: "plembfin", status: "not_watched", watchedCount: 0 }] };
  }

  const row = await findWatchedByAnyMediaKey(probe).catch(() => null);
  const media = row
    ? { ...watchRowToMedia(row, "manual"), canonicalState, isValid: true }
    : { ...probe, source: "manual", canonicalState, watched_at: "" };
  logger(`[push] Plekt:canonical state for "${media.title}" is ${canonicalState}.`);
  return {
    items: [media],
    sourceResults: [{ source: "plembfin", status: "success", watchedCount: 1, state: canonicalState }],
  };
}

export async function collectMediaForceSyncItems(config = {}, requested, { now = Date.now(), logger = () => {} } = {}) {
  const sources = requested.source ? [requested.source] : MEDIA_SERVERS;
  const sourceResults = [];
  const collected = [];

  await Promise.all(sources.map(async (source) => {
    if (!sourceConfigured(config, source)) {
      logger(`[pull] ${source}: not configured; skipped.`);
      sourceResults.push({ source, status: "not_configured", watchedCount: 0 });
      return;
    }
    logger(`[pull] ${source}: looking for watched state for "${requested.title}".`);
    try {
      const items = await collectSourceItems(config, requested, source, now);
      collected.push(...items);
      logger(`[pull] ${source}: found ${items.length} watched item${items.length === 1 ? "" : "s"}.`);
      sourceResults.push({ source, status: items.length ? "success" : "not_watched", watchedCount: items.length });
    } catch (error) {
      logger(`Detail Force Sync: ${source} lookup failed: ${error.message || String(error)}`);
      sourceResults.push({ source, status: "error", watchedCount: 0, error: error.message || String(error) });
    }
  }));

  sourceResults.sort((a, b) => MEDIA_SERVERS.indexOf(a.source) - MEDIA_SERVERS.indexOf(b.source));
  return { items: dedupeMedia(collected), sourceResults };
}

function pendingTelemetry(media, requested) {
  const action = requested.mode === "pull" ? "Pulled Watched" : "Pushed Canonical State";
  return [
    `Origin: ${media.source}`,
    `Action: ${action}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    `Details: Detail-page ${modeLabel(requested.mode)} operation queued for this media item.`,
  ].join("\n");
}

function completedTelemetry(media, summary, requested) {
  const action = requested.mode === "pull" ? "Pulled Watched" : "Pushed Canonical State";
  const lines = [
    `Origin: ${media.source}`,
    `Action: ${action}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "Detail-page Force Sync completed."}`,
  ];
  for (const target of summary.targetStates || []) {
    lines.push(`${String(target.target || "Target").replace(/^./, (char) => char.toUpperCase())} status: ${target.status}${target.detail ? ` - ${target.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function appendForceSyncHistory(media, summary, requested) {
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: summary.status || "unknown",
    details: `Detail-page ${modeLabel(requested.mode)}: ${summary.details || "completed"}`,
    action: media.canonicalState === "unwatched" ? "unwatched" : "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "media_force_sync",
      phase: "completed",
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
      ids: media.ids || {},
      season: media.season ?? null,
      episode: media.episode ?? null,
    },
  }).catch(() => null);
}

function summaryWithDeferredTrackerState(summary, status, detail) {
  const trackerState = { target: "trakt", status, detail };
  const targetStates = [...(summary?.targetStates || []), trackerState];
  const hasSuccess = targetStates.some((target) => target.status === "success");
  return {
    ...(summary || {}),
    skipped: false,
    status: status === "cancelled" ? "cancelled" : hasSuccess ? "partial" : "error",
    details: [summary?.details, detail].filter(Boolean).join(" "),
    targetStates,
  };
}

// A media server's own "last watched" date can be wrong - rebuilt/re-added
// libraries, a fresh re-scan, or a bulk "mark watched" pass can all reset it
// to whenever that happened, discarding the real historical date. A connected
// Trakt account is a much more durable record of when something was actually
// watched, so a pulled item's date is corrected to Trakt's if Trakt already
// has an earlier one for the same item. Fetched once per Force Sync run
// (not per item) to avoid a Trakt API call per episode on a large show pull.
export async function loadTraktWatchedDateIndex(logger = () => {}) {
  let connection = await withFreshTraktConnection().catch(() => null);
  if (!connection || connection.preferEarlierWatchedDate === false) return null;
  let snapshot;
  try {
    snapshot = await fetchTraktWatchedSnapshot(connection);
  } catch (error) {
    if (error.status !== 401) {
      logger(`[pull] Trakt watched-date check skipped: ${error.message || String(error)}`);
      return null;
    }
    connection = await withFreshTraktConnection(true).catch(() => null);
    if (!connection) return null;
    try {
      snapshot = await fetchTraktWatchedSnapshot(connection);
    } catch (retryError) {
      logger(`[pull] Trakt watched-date check skipped: ${retryError.message || String(retryError)}`);
      return null;
    }
  }
  const index = new Map();
  for (const entry of snapshot) {
    for (const key of trackerMediaIdentityKeys(entry.media)) {
      const existing = index.get(key);
      if (existing == null || entry.watchedAt < existing) index.set(key, entry.watchedAt);
    }
  }
  return index;
}

function lookupTraktWatchedAt(index, media) {
  const keys = trackerMediaIdentityKeys({ type: media.type, ids: media.ids, season: media.season, episode: media.episode });
  let best = null;
  for (const key of keys) {
    const value = index.get(key);
    if (value != null && (best == null || value < best)) best = value;
  }
  return best;
}

export function earliestTraktWatchedAt(index, media) {
  if (!index) return null;
  const direct = lookupTraktWatchedAt(index, media);
  if (direct != null) return direct;
  // Trakt sometimes records a multi-part episode (e.g. a double-length
  // season finale) as a single entry under the first part's episode number,
  // while Plembfin (via TMDB/TVDB) keeps the parts as separate episodes. If
  // this exact episode has no Trakt entry of its own but the immediately
  // preceding episode in the same season does, treat it as the second half
  // of that combined watch and use its date too.
  const episode = Number(media.episode);
  if (media.type === "episode" && Number.isFinite(episode) && episode > 1) {
    return lookupTraktWatchedAt(index, { ...media, episode: episode - 1 });
  }
  return null;
}

export async function forceSyncMediaState(input, { config = null, now = Date.now(), logger = () => {}, isCancelled = () => false } = {}) {
  const requested = normalizeMediaForceSyncRequest(input);
  const resolvedConfig = config || await loadMediaConfig();
  if (isAuthoritativeRestoreActive()) {
    logger(`[${requested.mode}] paused because an authoritative watch-history restore is active.`);
    return {
      ok: true,
      title: requested.title,
      type: requested.type,
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
      found: 0,
      imported: 0,
      existing: 0,
      synced: 0,
      cancelled: true,
      results: [],
      records: [],
    };
  }
  logger(`[${requested.mode}] ${modeLabel(requested.mode)} started for "${requested.title}".`);
  const collection = requested.mode === "push"
    ? await collectLocalCanonicalItems(requested, { logger })
    : await collectMediaForceSyncItems(resolvedConfig, requested, { now, logger });

  const loopStore = createLoopStore();
  const results = [];
  const records = [];
  const preparedItems = new Array(collection.items.length);
  let cancelled = Boolean(isCancelled()) || isAuthoritativeRestoreActive();
  let cancellationLogged = false;

  // getCanonicalWatchState matches by provider id/media_key, but an incoming
  // Plex/Emby/Jellyfin item's ids are episode-scoped (its own imdb/tvdb id,
  // not the show's) and often don't match whatever identity the playstate
  // row happens to be keyed under - the lookup then falls through to
  // findWatchedByAnyMediaKey, which can still find an old dormant watched
  // row and wrongly report "already watched". For a show-scoped pull, build
  // a season+episode -> sync_action map from the show's own current detail
  // instead - the exact same data the display itself groups from - so
  // "does this episode currently show as watched" can't disagree with what
  // the page actually renders.
  let currentEpisodeStateByCoordinate = null;
  if (requested.mode === "pull" && requested.type === "show") {
    const currentShow = await queryShowDetail({ title: requested.title }).catch(() => null);
    if (currentShow) {
      currentEpisodeStateByCoordinate = new Map(
        (currentShow.episodes || []).map((row) => [`${row.season}:${row.episode}`, row.sync_action || "watched"]),
      );
    }
  }

  if (requested.mode === "pull") {
    const traktWatchedDateIndex = await loadTraktWatchedDateIndex(logger);
    if (traktWatchedDateIndex) {
      for (const media of collection.items) {
        if (!media.watched_at) continue;
        const traktWatchedAt = earliestTraktWatchedAt(traktWatchedDateIndex, media);
        if (traktWatchedAt != null && traktWatchedAt < Date.parse(media.watched_at)) {
          logger(`[pull] ${media.title}: ${media.source} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
          media.watched_at = new Date(traktWatchedAt).toISOString();
        }
      }
    }
  }

  // Detail Force Sync deliberately keeps slow Trakt calls out of the fast
  // local-server worker pool. Prime every eventual Trakt intent before any
  // local state or LAN destination is touched, though: otherwise a poll can
  // fetch an old Trakt snapshot during the local phase, commit its opposite
  // transition before the deferred tracker phase starts, and undo the Force
  // Sync that is still in progress. The poll worker's transactional guard
  // re-reads this persistent marker immediately before mutating local state.
  if (requested.mode === "push" && !requested.target && !cancelled) {
    const primedTrackerIntents = await primeCanonicalTrackerDispatchIntents(collection.items.map((media) => ({
      media,
      state: media.canonicalState || "watched",
    })));
    if (primedTrackerIntents) {
      logger(`[push] Primed ${primedTrackerIntents} Trakt intent${primedTrackerIntents === 1 ? "" : "s"} before local media-server sync.`);
    }
  }

  await runWithConcurrency(collection.items, async (media, index) => {
    if (isCancelled() || isAuthoritativeRestoreActive()) {
      cancelled = true;
      if (!cancellationLogged) {
        cancellationLogged = true;
        logger(`[${requested.mode}] Cancellation acknowledged; stopping before remaining items.`);
      }
      return;
    }
    const canonicalState = media.canonicalState || "watched";
    // A show push is built from queryShowDetail's representative rows, which
    // include explicit unwatched bookkeeping rows. Keep telemetry attached to
    // that exact representative: falling back to findWatchedByAnyMediaKey for
    // an unwatched item finds its older watched row and touching that row's
    // updated_at can make it outrank the unwatch in the next detail query.
    let record;
    if (requested.mode === "push" && media.canonicalRecordId) {
      record = await getWatchRecordById(media.canonicalRecordId).catch(() => null);
    } else if (requested.mode === "push" && canonicalState === "unwatched") {
      // A movie can have an unwatched canonical playstate without a matching
      // unwatched history row. Its only discoverable history row is then an
      // older watch; attaching this push's telemetry to that row would bump
      // its updated_at and let it supersede the unwatch. The operation still
      // runs and reports normally, but there is no safe history row to touch.
      record = null;
    } else {
      record = await findWatchedByAnyMediaKey(media).catch(() => null);
    }
    let inserted = false;
    if (requested.mode !== "push" && canonicalState !== "unwatched") {
      // A watched row can exist in history yet no longer be the episode's
      // current state - a later unwatch (even a stale one recorded while a
      // show's identity was mismatched) always wins the dedup tie-break by
      // recency, silently shadowing that old watched row from every display
      // and count. !record alone can't see that: it only asks "does any
      // watched row exist anywhere", not "is this episode currently showing
      // as watched". Prefer the season+episode map built from the show's own
      // current detail (matches the display exactly); fall back to the
      // canonical playstate pointer for movies and anything that map didn't
      // cover, so a source confirming "still watched" inserts a fresh,
      // current record and genuinely flips the display back, rather than
      // being treated as a no-op because *some* watched row is on file.
      const coordinateState = currentEpisodeStateByCoordinate?.get(`${media.season}:${media.episode}`);
      const currentCanonicalState = coordinateState ?? await getCanonicalWatchState(media).catch(() => null);
      if (currentCanonicalState !== "watched") {
        if (isCancelled() || isAuthoritativeRestoreActive()) {
          cancelled = true;
          return;
        }
        const insertedResult = await insertWatchRecord({
          ...media,
          sync_action: "watched",
          sync_dispatch_telemetry: pendingTelemetry(media, requested),
        }, { skipInvalidate: true, watchlistConfig: config });
        record = insertedResult.record;
        record.id = insertedResult.id;
        inserted = true;
        await insertedResult.assetPrefetch?.catch(() => null);
      }
    }

    if (isCancelled() || isAuthoritativeRestoreActive()) {
      cancelled = true;
      return;
    }
    await upsertPlaystateForMedia(media, canonicalState, media.watched_at, { skipInvalidate: true });

    let summary;
    let trackerEligible = false;
    if (requested.mode === "pull") {
      summary = {
        skipped: false,
        status: "success",
        details: "Watched state pulled into Plekt; no outbound targets selected.",
        targetStates: [],
      };
      logger(`[pull] ${media.title}: imported ${canonicalState} state into Plekt.`);
    } else {
      const localTargets = requested.target ? [requested.target] : MEDIA_SERVERS;
      const syncMedia = { ...media, syncTargets: localTargets };
      const destination = requested.target ? sourceLabel(requested.target) : "local media servers";
      logger(`[${requested.mode}] ${media.title}: sending ${canonicalState} state to ${destination}.`);
      try {
        if (isCancelled() || isAuthoritativeRestoreActive()) {
          cancelled = true;
          return;
        }
        summary = await syncCanonicalPlaystate(syncMedia, resolvedConfig, loopStore, canonicalState, { includeTrackers: requested.target === "trakt" });
        trackerEligible = !requested.target;
      } catch (error) {
        summary = {
          skipped: false,
          status: "error",
          details: `Canonical propagation failed: ${error.message || String(error)}`,
          targetStates: [],
        };
      }
    }

    for (const target of summary.targetStates || []) {
      logger(`[${requested.mode}] ${media.title}: ${target.target || "target"} -> ${target.status}${target.detail ? ` (${target.detail})` : ""}.`);
    }

    preparedItems[index] = { media, record, inserted, canonicalState, summary, trackerEligible };
  }, FORCE_SYNC_ITEM_CONCURRENCY);

  const completedLocalItems = preparedItems.filter(Boolean);
  const trackerItems = requested.mode === "push" && !requested.target
    ? completedLocalItems.filter((item) => item.trackerEligible)
    : [];
  if (trackerItems.length && !isAuthoritativeRestoreActive() && !isCancelled()) {
    logger(`[push] Local media-server phase complete for ${completedLocalItems.length} item${completedLocalItems.length === 1 ? "" : "s"}; syncing Trakt.`);
    let trackerCancellationLogged = false;
    await runWithConcurrency(trackerItems, async (item) => {
      if (cancelled || isCancelled() || isAuthoritativeRestoreActive()) {
        cancelled = true;
        item.summary = summaryWithDeferredTrackerState(
          item.summary,
          "cancelled",
          "Trakt dispatch was cancelled before it started.",
        );
        if (!trackerCancellationLogged) {
          trackerCancellationLogged = true;
          logger("[push] Cancellation acknowledged; stopping before remaining Trakt items.");
        }
        return;
      }
      try {
        item.summary = await appendCanonicalTrackerDispatch(item.summary, item.media, item.canonicalState, { isCancelled });
      } catch (error) {
        item.summary = summaryWithDeferredTrackerState(
          item.summary,
          "error",
          `Trakt dispatch failed: ${error.message || String(error)}`,
        );
      }
      if (isCancelled() || isAuthoritativeRestoreActive() || item.summary.targetStates?.some((target) => target.target === "trakt" && target.status === "cancelled")) {
        cancelled = true;
      }
      const trackerState = item.summary.targetStates?.find((target) => target.target === "trakt");
      if (trackerState) {
        logger(`[push] ${item.media.title}: trakt -> ${trackerState.status}${trackerState.detail ? ` (${trackerState.detail})` : ""}.`);
      }
    }, TRACKER_FORCE_SYNC_ITEM_CONCURRENCY);
  }

  // Persist one truthful, combined outcome per item only after both phases.
  // This also keeps the operation audit separate from history-row telemetry
  // for canonical unwatched movies that have no safe representative row.
  for (const item of completedLocalItems) {
    if (isAuthoritativeRestoreActive()) {
      cancelled = true;
      break;
    }
    const { media, record, inserted, canonicalState, summary } = item;
    if (record?.id) {
      await updateWatchTelemetry(record.id, completedTelemetry(media, summary, requested), { skipInvalidate: true });
    }
    await appendForceSyncHistory(media, summary, requested);

    const freshRecord = record?.id ? await getWatchRecordById(record.id).catch(() => null) : null;
    if (freshRecord) records.push(freshRecord);
    const operationStatus = requested.mode === "pull" ? "pulled" : summary.status || "unknown";
    logger(`[${requested.mode}] ${media.title}: ${operationStatus} — ${summary.details || "complete"}`);
    results.push({
      title: media.title,
      type: media.type,
      season: media.season,
      episode: media.episode,
      source: media.source,
      id: record?.id || "",
      inserted,
      status: operationStatus,
      canonicalState,
      targetStates: summary.targetStates || [],
    });
  }

  cancelled = cancelled || Boolean(isCancelled()) || isAuthoritativeRestoreActive();
  await invalidateHistoryDerivedCaches("forceSyncMediaState").catch(() => null);
  logger(cancelled
    ? `[${requested.mode}] ${modeLabel(requested.mode)} cancelled after ${results.length} item${results.length === 1 ? "" : "s"}.`
    : `[${requested.mode}] ${modeLabel(requested.mode)} finished: ${results.length} item${results.length === 1 ? "" : "s"}.`);
  return {
    ok: true,
    title: requested.title,
    type: requested.type,
    mode: requested.mode,
    target: requested.target || "all",
    pullFrom: requested.source || "all",
    found: collection.items.length,
    imported: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    pulled: results.filter((result) => result.status === "pulled").length,
    synced: requested.mode === "pull" ? 0 : results.filter((result) => ["success", "partial", "skipped"].includes(result.status)).length,
    sourceResults: collection.sourceResults,
    cancelled,
    results,
    records,
  };
}
