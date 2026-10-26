// The Settings Force Sync dialog operates on the whole library. It mirrors
// the explicit detail-page Push/Pull actions while keeping the title lookup
// out of the request: the library scan is performed once, then the
// resulting canonical state is replayed item by item.

import { appendSyncHistory, isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { runWithConcurrency } from "./concurrency.js";
import {
  collectServerWatchedItems,
  configuredSyncServers,
} from "./forceSyncPlanner.js";
import { earliestTrackerWatchedAt, loadTrackerWatchedDateIndex } from "./mediaForceSync.js";
import { syncCanonicalPlaystate, syncMediaProgress } from "./syncOrchestrator.js";
import {
  countWatchedPlaystateRows,
  findWatchedByAnyMediaKey,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  listPlaybackProgressRowsForReplay,
  listWatchedPlaystateRowsForReplay,
  progressRowToMedia,
  updatePlaybackProgressTelemetry,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
  watchRowToMedia,
} from "./dataRepo.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
// See the identical comment in mediaForceSync.js - per-item outbound calls
// already run in parallel across targets and are throttled per-host by the
// outbound governor, so this only shortens wall-clock time on a large library.
const FORCE_SYNC_ITEM_CONCURRENCY = 6;
const FORCE_SYNC_MODES = ["push", "pull"];
const CANONICAL_PAGE_SIZE = 100;

function clean(value) {
  return String(value ?? "").trim();
}

function modeLabel(mode = "push") {
  return mode === "pull" ? "Import Watched Status" : "Set Plekt as Source of Truth";
}

function modeFrom(input = {}) {
  const raw = clean(input.mode || input.action).toLowerCase();
  if (raw === "push_to") return "push";
  if (raw === "pull_from") return "pull";
  return raw;
}

export function normalizeLibraryForceSyncRequest(input = {}) {
  const mode = modeFrom(input);
  const sourceValue = clean(input.pull_from || input.pullFrom || input.source).toLowerCase();
  const targetValue = clean(input.push_to || input.pushTo || input.target).toLowerCase();
  const source = sourceValue === "all" ? "" : sourceValue;
  const target = targetValue === "all" ? "" : targetValue;

  if (!FORCE_SYNC_MODES.includes(mode)) throw new Error("mode must be push or pull");
  if (source && !MEDIA_SERVERS.includes(source)) throw new Error("source must be plex, emby, or jellyfin");
  if (target && ![...MEDIA_SERVERS, "trakt"].includes(target)) throw new Error("target must be plex, emby, jellyfin, or trakt");

  return { title: "All media", type: "library", mode, source, target };
}

function timestampValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

export function plannerMediaToSyncMedia(item = {}, _now = Date.now(), sourceOverride = "") {
  const source = sourceOverride || item.source || "force_sync";
  const type = item.type === "movie" ? "movie" : "episode";
  const watchedAt = timestampValue(item.timestamp);
  const inferredFromRelease = Boolean(item.timestampInferredFromRelease);
  // A historical played flag is not evidence that playback occurred when the
  // import ran. If a server cannot supply its original play time, leave the
  // item out instead of manufacturing a recent watch-history entry.
  if (!watchedAt) return null;
  return {
    title: clean(item.title),
    type,
    source,
    ids: {
      imdb: clean(item.imdb) || undefined,
      tmdb: clean(item.tmdb) || undefined,
      tvdb: clean(item.tvdb) || undefined,
    },
    season: item.season == null ? undefined : Number(item.season),
    episode: item.episode == null ? undefined : Number(item.episode),
    episode_title: clean(item.episodeTitle) || undefined,
    watched_at: watchedAt,
    isValid: Boolean(clean(item.title)),
    watchProvenance: {
      source,
      ingest_path: "force_sync",
      event: "library_force_sync",
      phase: "completed",
      source_timestamp: inferredFromRelease ? "" : watchedAt,
      confidence: inferredFromRelease ? "inferred" : "exact",
      note: inferredFromRelease
        ? "Watched state imported from a connected media server; the server supplied no played date, so the media release date was used."
        : "Watched state explicitly imported from a connected media server from Settings Force Sync.",
    },
  };
}

function canonicalRowToPlannerMedia(row = {}) {
  const media = watchRowToMedia(row, "manual");
  return {
    title: media.title,
    type: media.type,
    season: media.season,
    episode: media.episode,
    imdb: media.ids?.imdb || null,
    tmdb: media.ids?.tmdb || null,
    tvdb: media.ids?.tvdb || null,
    episodeTitle: row.episode_title || null,
    timestamp: media.watched_at ? new Date(media.watched_at) : null,
    source: "manual",
    canonicalState: row.state || "watched",
  };
}

async function listCanonicalWatchedItems(logger = () => {}, isCancelled = () => false) {
  const total = await countWatchedPlaystateRows();
  const items = [];
  for (let offset = 0; offset < total; offset += CANONICAL_PAGE_SIZE) {
    if (isCancelled()) break;
    const rows = await listWatchedPlaystateRowsForReplay({ limit: CANONICAL_PAGE_SIZE, offset });
    items.push(...rows.map(canonicalRowToPlannerMedia).filter((item) => item.type === "movie" || item.type === "episode"));
    if (rows.length < CANONICAL_PAGE_SIZE) break;
  }
  logger(`Plekt: loaded ${items.length} canonical watched item${items.length === 1 ? "" : "s"}.`);
  return items;
}

async function listCanonicalProgressItems(logger = () => {}, isCancelled = () => false) {
  const items = [];
  let offset = 0;
  while (!isCancelled()) {
    const rows = await listPlaybackProgressRowsForReplay({ limit: CANONICAL_PAGE_SIZE, offset });
    items.push(...rows
      .map((row) => progressRowToMedia(row, "manual"))
      .filter((item) => item.isValid && ["movie", "episode"].includes(item.type)));
    if (rows.length < CANONICAL_PAGE_SIZE) break;
    offset += rows.length;
  }
  logger(`Plekt: loaded ${items.length} canonical resume position${items.length === 1 ? "" : "s"}.`);
  return items;
}

function sourcePriority(sources = []) {
  return MEDIA_SERVERS.find((source) => sources.includes(source)) || "manual";
}

function titleKey(value = "") {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sameLibraryItem(media = {}, group = {}) {
  if (media.type !== group.type) return false;
  if (media.type === "episode" && (
    Number(media.season) !== Number(group.season)
    || Number(media.episode) !== Number(group.episode)
  )) return false;

  for (const key of ["imdb", "tmdb", "tvdb"]) {
    if (media[key] && group[key] && String(media[key]).toLowerCase() === String(group[key]).toLowerCase()) return true;
  }
  return titleKey(media.title) === titleKey(group.title);
}

function mergeLibraryItems(items = []) {
  const groups = [];
  for (const item of items) {
    const group = groups.find((candidate) => sameLibraryItem(item, candidate));
    if (!group) {
      groups.push({
        title: item.title,
        type: item.type,
        season: item.season,
        episode: item.episode,
        imdb: item.imdb || null,
        tmdb: item.tmdb || null,
        tvdb: item.tvdb || null,
        timestamp: item.timestamp || null,
        timestampInferredFromRelease: Boolean(item.timestampInferredFromRelease),
        episodeTitle: item.episodeTitle || null,
        watchedOn: new Set([item.source]),
      });
      continue;
    }
    group.watchedOn.add(item.source);
    if (item.timestamp && (!group.timestamp || item.timestamp > group.timestamp)) {
      group.timestamp = item.timestamp;
      group.timestampInferredFromRelease = Boolean(item.timestampInferredFromRelease);
    }
    if (!group.imdb && item.imdb) group.imdb = item.imdb;
    if (!group.tmdb && item.tmdb) group.tmdb = item.tmdb;
    if (!group.tvdb && item.tvdb) group.tvdb = item.tvdb;
    if (!group.episodeTitle && item.episodeTitle) group.episodeTitle = item.episodeTitle;
  }
  return groups;
}

function sourceResults(config, scan) {
  const configured = new Set(configuredSyncServers(config));
  const errors = new Map((scan.scopeErrors || []).map((entry) => [entry.server, entry.error || "Scan failed."]));
  return MEDIA_SERVERS.map((source) => {
    if (!configured.has(source)) return { source, status: "not_configured", watchedCount: 0 };
    if (errors.has(source)) return { source, status: "error", watchedCount: 0, error: errors.get(source) };
    const watchedCount = (scan.itemsByServer?.[source] || []).length;
    return { source, status: watchedCount ? "success" : "not_watched", watchedCount };
  });
}

async function collectLibraryItems(config, requested, now, logger) {
  const scope = requested.source ? { servers: [requested.source] } : {};
  const scan = await collectServerWatchedItems(config, { scope, logger });
  const remoteItems = MEDIA_SERVERS.flatMap((source) => scan.itemsByServer?.[source] || []);
  const groups = mergeLibraryItems(remoteItems);
  const items = groups.map((group) => plannerMediaToSyncMedia(
    group,
    now,
    sourcePriority([...group.watchedOn]),
  )).filter(Boolean);

  // See the identical comment in mediaForceSync.js - a media server's own
  // "last watched" date can be reset by a library rebuild/rescan; prefer an
  // earlier date already on file with a connected Trakt account.
  const trackerWatchedDateIndex = await loadTrackerWatchedDateIndex(logger);
  if (trackerWatchedDateIndex) {
    for (const media of items) {
      const trackerWatchedAt = earliestTrackerWatchedAt(trackerWatchedDateIndex, media);
      if (trackerWatchedAt != null && trackerWatchedAt < Date.parse(media.watched_at)) {
        logger(`[pull] ${media.title}: ${media.source} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        media.watched_at = new Date(trackerWatchedAt).toISOString();
      }
    }
  }

  return {
    items,
    sourceResults: sourceResults(config, scan),
    scanErrors: scan.scopeErrors || [],
  };
}

async function collectPushItems(logger, now, isCancelled = () => false) {
  const canonicalItems = await listCanonicalWatchedItems(logger, isCancelled);
  const progressItems = await listCanonicalProgressItems(logger, isCancelled);
  return {
    items: canonicalItems.map((item) => plannerMediaToSyncMedia(item, now, "manual")),
    progressItems,
    sourceResults: [{ source: "plembfin", status: canonicalItems.length ? "success" : "not_watched", watchedCount: canonicalItems.length }],
    scanErrors: [],
  };
}

function pendingTelemetry(media, requested) {
  return [
    `Origin: ${media.source}`,
    `Action: ${modeLabel(requested.mode)}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    "Details: Settings library Force Sync operation queued for this media item.",
  ].join("\n");
}

function completedTelemetry(media, summary, requested) {
  const lines = [
    `Origin: ${media.source}`,
    `Action: ${modeLabel(requested.mode)}`,
    `Media: ${media.title}`,
    "Loop-check: Passed",
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "Settings library Force Sync completed."}`,
  ];
  for (const target of summary.targetStates || []) {
    lines.push(`${String(target.target || "Target").replace(/^./, (char) => char.toUpperCase())} status: ${target.status}${target.detail ? ` - ${target.detail}` : ""}`);
  }
  return lines.join("\n");
}

function completedProgressTelemetry(media, summary, requested) {
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  const lines = [
    `Origin: ${media.source || "manual"}`,
    `Action: ${modeLabel(requested.mode)}`,
    `Media: ${media.title || "unknown"}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
  ];
  for (const state of summary.targetStates || []) {
    lines.push(`${String(state.target || "Target").replace(/^./, (char) => char.toUpperCase())} progress status: ${state.status}${state.detail ? ` - ${state.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function appendLibraryForceSyncHistory(media, summary, requested) {
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: summary.status || "unknown",
    details: `Settings ${modeLabel(requested.mode)}: ${summary.details || "completed"}`,
    action: "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "library_force_sync",
      phase: "completed",
      mode: requested.mode,
      target: requested.target || "all",
      pullFrom: requested.source || "all",
      season: media.season ?? null,
      episode: media.episode ?? null,
    },
  }).catch(() => null);
}

async function appendLibraryForceSyncProgressHistory(media, summary, requested) {
  await appendSyncHistory({
    mediaType: media.type,
    title: media.title,
    source: media.source,
    status: summary.status || "unknown",
    details: `Settings ${modeLabel(requested.mode)} resume progress: ${summary.details || "completed"}`,
    action: "progress",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "library_force_sync",
      phase: "progress",
      mode: requested.mode,
      target: requested.target || "all",
      positionMs: media.positionMs ?? media.offsetMs ?? null,
      durationMs: media.durationMs ?? null,
      progress: media.progress ?? null,
      season: media.season ?? null,
      episode: media.episode ?? null,
    },
  }).catch(() => null);
}

async function syncOneLibraryItem(media, requested, config, loopStore, logger) {
  const canonicalState = "watched";
  let record = await findWatchedByAnyMediaKey(media).catch(() => null);
  let inserted = false;

  if (requested.mode !== "push" && !record) {
    if (isAuthoritativeRestoreActive()) throw new Error("Authoritative watch-history restore is active");
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

  if (isAuthoritativeRestoreActive()) throw new Error("Authoritative watch-history restore is active");
  await upsertPlaystateForMedia(media, canonicalState, media.watched_at, { skipInvalidate: true });

  if (requested.mode === "pull") {
    const summary = {
      skipped: false,
      status: "success",
      details: "Watched state pulled into Plekt; no outbound targets selected.",
      targetStates: [],
    };
    logger(`[pull] ${media.title}: imported watched state into Plekt.`);
    return { record, inserted, summary };
  }

  // A library-wide push projects watch history Plembfin already holds onto the
  // servers, so it is a historical backfill rather than a change the user just
  // made. Stating that lets the provider matrix apply the Plex historical
  // policy here (see watchSyncPolicy.js) instead of letting one bulk run create
  // a whole library's worth of Plex activity dated today.
  const syncMedia = {
    ...media,
    syncIntent: "historical",
    ...(requested.target ? { syncTargets: [requested.target] } : {}),
  };
  logger(`[${requested.mode}] ${media.title}: sending watched state to ${requested.target || "all connected servers"}.`);
  const summary = await syncCanonicalPlaystate(syncMedia, config, loopStore, canonicalState);
  for (const target of summary.targetStates || []) {
    logger(`[${requested.mode}] ${media.title}: ${target.target || "target"} -> ${target.status}${target.detail ? ` (${target.detail})` : ""}.`);
  }
  return { record, inserted, summary };
}

async function syncOneLibraryProgressItem(media, requested, config, loopStore, logger) {
  if (requested.target === "trakt") {
    const detail = "Trakt is available for watched-state Push only; it does not accept resume positions.";
    logger(`[${requested.mode}] ${media.title}: ${detail}`);
    return { skipped: true, status: "skipped", details: detail, targetStates: [{ target: "trakt", status: "skipped", detail }] };
  }
  const syncMedia = requested.target ? { ...media, syncTargets: [requested.target] } : media;
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  logger(`[${requested.mode}] ${media.title}: sending resume position ${Math.round(positionMs / 1000)}s to ${requested.target || "all connected servers"}.`);
  const summary = await syncMediaProgress(syncMedia, config, loopStore);
  for (const target of summary.targetStates || []) {
    logger(`[${requested.mode}] ${media.title}: ${target.target || "target"} resume -> ${target.status}${target.detail ? ` (${target.detail})` : ""}.`);
  }
  return summary;
}

export async function forceSyncLibraryState(input, { config = null, now = Date.now(), logger = () => {}, isCancelled = () => false } = {}) {
  const requested = normalizeLibraryForceSyncRequest(input);
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
      progressFound: 0,
      processed: 0,
      imported: 0,
      existing: 0,
      pulled: 0,
      synced: 0,
      progressSynced: 0,
      errors: 0,
      cancelled: true,
      results: [],
      records: [],
    };
  }
  logger(`[${requested.mode}] ${modeLabel(requested.mode)} started for all media.`);

  const collection = requested.mode === "push"
    ? await collectPushItems(logger, now, isCancelled)
    : await collectLibraryItems(resolvedConfig, requested, now, logger);
  const loopStore = createLoopStore();
  const results = [];
  let cancelled = Boolean(isCancelled()) || isAuthoritativeRestoreActive();
  let itemsCancellationLogged = false;

  await runWithConcurrency(collection.items, async (media) => {
    if (isCancelled() || isAuthoritativeRestoreActive()) {
      cancelled = true;
      if (!itemsCancellationLogged) {
        itemsCancellationLogged = true;
        logger(`[${requested.mode}] Cancellation acknowledged; stopping before remaining items.`);
      }
      return;
    }
    try {
      const { record, inserted, summary } = await syncOneLibraryItem(media, requested, resolvedConfig, loopStore, logger);
      if (record?.id) {
        if (isAuthoritativeRestoreActive()) {
          cancelled = true;
          return;
        }
        await updateWatchTelemetry(record.id, completedTelemetry(media, summary, requested), { skipInvalidate: true });
        await appendLibraryForceSyncHistory(media, summary, requested);
      }
      const status = requested.mode === "pull" ? "pulled" : summary.status || "unknown";
      logger(`[${requested.mode}] ${media.title}: ${status} — ${summary.details || "complete"}`);
      results.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        source: media.source,
        id: record?.id || "",
        inserted,
        status,
        canonicalState: "watched",
        targetStates: summary.targetStates || [],
      });
    } catch (error) {
      const message = error.message || String(error);
      logger(`[${requested.mode}] ${media.title}: ERROR — ${message}`);
      results.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        source: media.source,
        status: "error",
        canonicalState: "watched",
        targetStates: [],
        error: message,
      });
    }
  }, FORCE_SYNC_ITEM_CONCURRENCY);

  if (requested.mode === "push" && !cancelled && !isAuthoritativeRestoreActive()) {
    let progressCancellationLogged = false;
    await runWithConcurrency(collection.progressItems || [], async (media) => {
      if (isCancelled() || isAuthoritativeRestoreActive()) {
        cancelled = true;
        if (!progressCancellationLogged) {
          progressCancellationLogged = true;
          logger(`[${requested.mode}] Cancellation acknowledged; stopping before remaining resume positions.`);
        }
        return;
      }
      try {
        const summary = await syncOneLibraryProgressItem(media, requested, resolvedConfig, loopStore, logger);
        if (isAuthoritativeRestoreActive()) {
          cancelled = true;
          return;
        }
        await updatePlaybackProgressTelemetry(media, completedProgressTelemetry(media, summary, requested));
        await appendLibraryForceSyncProgressHistory(media, summary, requested);
        results.push({
          title: media.title,
          type: media.type,
          season: media.season,
          episode: media.episode,
          source: media.source,
          id: media.media_key || "",
          action: "progress",
          positionMs: media.positionMs ?? media.offsetMs ?? 0,
          durationMs: media.durationMs ?? null,
          progress: media.progress ?? 0,
          status: summary.status || "unknown",
          targetStates: summary.targetStates || [],
        });
      } catch (error) {
        const message = error.message || String(error);
        logger(`[${requested.mode}] ${media.title}: RESUME ERROR — ${message}`);
        results.push({
          title: media.title,
          type: media.type,
          season: media.season,
          episode: media.episode,
          source: media.source,
          action: "progress",
          status: "error",
          targetStates: [],
          error: message,
        });
      }
    }, FORCE_SYNC_ITEM_CONCURRENCY);
  }

  cancelled = cancelled || Boolean(isCancelled()) || isAuthoritativeRestoreActive();
  await invalidateHistoryDerivedCaches("forceSyncLibraryState").catch(() => null);
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
    progressFound: collection.progressItems?.length || 0,
    processed: results.length,
    imported: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    pulled: results.filter((result) => result.status === "pulled").length,
    synced: requested.mode === "pull" ? 0 : results.filter((result) => ["success", "partial", "skipped"].includes(result.status)).length,
    progressSynced: results.filter((result) => result.action === "progress" && ["success", "partial", "skipped"].includes(result.status)).length,
    errors: results.filter((result) => result.status === "error").length,
    sourceResults: collection.sourceResults,
    scanErrors: collection.scanErrors,
    cancelled,
    results,
    records: [],
  };
}
