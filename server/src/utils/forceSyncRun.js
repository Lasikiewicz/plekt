// Force sync run orchestration (split from scheduled.js).
import crypto from "node:crypto";
import { recordOutboundPlayedMarks, recordOutboundUnplayedMarks } from "./syncOrchestrator.js";
import { claimSyncOperation, isAuthoritativeRestoreActive, loadMediaConfig, loadRuntimeState, releaseSyncOperation, touchSyncOperation, SYNC_OPERATION_FORCE } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { executeForceSyncPlan } from "./forceSyncExecutor.js";
import { watchedAtForEmbyLikeItem, watchedAtForPlexItem } from "./watchDates.js";
import { canReceiveState } from "./syncRoles.js";
import { deleteWatchRecordById, getCachedHistory, invalidateHistoryDerivedCaches, mediaKeyFor } from "./dataRepo.js";
import { runWithConcurrency } from "./scheduledConcurrency.js";

export async function runForceSync(logger = console.log, {
  concurrency = 1,
  planId = "",
  operationOwnerId = "",
  isCancelled = async () => false,
} = {}) {
  if (!watchedPlayedSyncEnabled()) {
    logger("Force Sync skipped because watched/played syncing is disabled.");
    return {
      success: true,
      skipped: true,
      reason: "Watched/played syncing is disabled.",
      activeTargets: [],
      stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 },
    };
  }

  const ownerId = String(operationOwnerId || crypto.randomUUID());
  const startedAt = Date.now();
  logger("Force Sync: claiming the shared sync-operation lock...");
  const claim = await claimSyncOperation({
    kind: SYNC_OPERATION_FORCE,
    ownerId,
    activeField: "forceSyncActive",
    startedAt,
    values: {
      forceSyncRunId: ownerId,
      forceSyncStartedAt: startedAt,
      forceSyncHeartbeat: startedAt,
      forceSyncCancelRequested: false,
      forceSyncResult: null,
    },
  });
  if (!claim?.ok) {
    const active = claim?.active;
    const label = active?.kind === SYNC_OPERATION_FORCE ? "another Force Sync" : `another sync operation (${active?.kind || "unknown"})`;
    logger(`Force Sync ERROR: ${label} is already active.`);
    throw new Error(`${label.charAt(0).toUpperCase()}${label.slice(1)} is already active.`);
  }

  const heartbeatTimer = setInterval(() => {
    touchSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: { forceSyncHeartbeat: Date.now() },
    }).catch(() => null);
  }, 30_000);
  heartbeatTimer.unref?.();

  try {
    logger("Force Sync: loading media configuration...");
    const config = await loadMediaConfig();
    if (planId) {
      return await executeForceSyncPlan(planId, config, logger, { shouldCancel: isCancelled });
    }
    const loopStore = createLoopStore();

  const hasPlex = !config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token);
  const hasEmby = !config.emby?.disabled && Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId);
  const hasJellyfin = !config.jellyfin?.disabled && Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId);

  const configuredServers = [
    hasPlex ? "plex" : "",
    hasEmby ? "emby" : "",
    hasJellyfin ? "jellyfin" : "",
  ].filter(Boolean);
  const watchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "watched"));
  const unwatchedTargets = configuredServers.filter((server) => canReceiveState(config, server, "unwatched"));
  const activeTargets = [...new Set([...watchedTargets, ...unwatchedTargets])];

  if (configuredServers.length === 0) {
    logger("Force Sync: no active media servers are configured or enabled. Aborting.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  if (activeTargets.length === 0) {
    logger("Force Sync: all configured servers are source-only or disabled for receiving state; no remote writes are permitted.");
    return { success: true, activeTargets, stats: { totalWatchedFoundAcrossServers: 0, addedToHistory: 0, deletedFromHistory: 0, propagatedUpdates: 0 } };
  }

  logger(`Force Sync: receiving targets resolved: ${activeTargets.join(", ")}`);
  const scanFailures = new Map();

  // 1. Fetch watched items in parallel
  logger("Force Sync: querying watched libraries from servers...");
  const fetchPromises = [];
  if (hasPlex) {
    fetchPromises.push(
      (async () => {
        logger("Plex: scanning library sections...");
        const { fetchPlexWatchedItems } = await import("./plexClient.js");
        const raw = await fetchPlexWatchedItems(config.plex);
        logger(`Plex: fetched ${raw.length} watched library items.`);
        return raw.map((item) => {
          const { watchedAt } = watchedAtForPlexItem(item);
          const media = {
            title: item.title,
            type: item.type,
            season: item.parentIndex != null ? Number(item.parentIndex) : null,
            episode: item.index != null ? Number(item.index) : null,
            imdb: null,
            tmdb: null,
            tvdb: null,
            source: "plex",
            timestamp: watchedAt
              ? new Date(watchedAt)
              : null,
          };
          const guids = [item.guid, ...(item.Guid || []).map((g) => g.id || g)].filter(Boolean);
          for (const guid of guids) {
            const guidStr = String(guid);
            const value = guidStr.split(/:\/\/|\//).pop();
            if (guidStr.includes("imdb")) media.imdb = value;
            if (guidStr.includes("tmdb") || guidStr.includes("themoviedb")) media.tmdb = value;
            if (guidStr.includes("tvdb") || guidStr.includes("thetvdb")) media.tvdb = value;
          }
          if (item.type === "episode") {
            media.title = `${item.grandparentTitle} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
            media.episodeTitle = item.title;
          }
          return media;
        });
      })().catch((err) => {
        logger(`Plex ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("plex", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasEmby) {
    fetchPromises.push(
      (async () => {
        logger("Emby: querying played items...");
        const { fetchEmbyWatchedItems } = await import("./embyClient.js");
        const { normalizeProviderIds } = await import("./parsers.js");
        const raw = await fetchEmbyWatchedItems(config.emby);
        logger(`Emby: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "emby",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Emby ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("emby", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  if (hasJellyfin) {
    fetchPromises.push(
      (async () => {
        logger("Jellyfin: querying played items...");
        const { fetchJellyfinWatchedItems } = await import("./jellyfinClient.js");
        const { normalizeProviderIds } = await import("./parsers.js");
        const raw = await fetchJellyfinWatchedItems(config.jellyfin);
        logger(`Jellyfin: fetched ${raw.length} played library items.`);
        return raw.map((item) => {
          const ids = normalizeProviderIds(item.ProviderIds);
          const { watchedAt } = watchedAtForEmbyLikeItem(item);
          return {
            title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
            type: item.Type === "Episode" ? "episode" : "movie",
            season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
            episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
            imdb: ids.imdb || null,
            tmdb: ids.tmdb || null,
            tvdb: ids.tvdb || null,
            episodeTitle: item.Type === "Episode" ? item.Name : null,
            source: "jellyfin",
            timestamp: watchedAt ? new Date(watchedAt) : null,
          };
        });
      })().catch((err) => {
        logger(`Jellyfin ERROR: failed to fetch watched items: ${err.message}`);
        scanFailures.set("jellyfin", err.message || String(err));
        return [];
      })
    );
  } else {
    fetchPromises.push(Promise.resolve([]));
  }

  const [plexResults, embyResults, jellyfinResults] = await Promise.all(fetchPromises);
  const allWatchedItems = [...plexResults, ...embyResults, ...jellyfinResults];
  logger(`Force Sync: collected ${allWatchedItems.length} total watched items across all platforms.`);
  const healthyWatchedTargets = watchedTargets.filter((target) => !scanFailures.has(target));
  const healthyUnwatchedTargets = unwatchedTargets.filter((target) => !scanFailures.has(target));
  if (scanFailures.size) {
    logger(`Force Sync: ${scanFailures.size} server scan${scanFailures.size === 1 ? "" : "s"} failed; those servers are excluded from all remote writes.`);
  }

  // 2. Fetch Plembfin watchHistory to resolve conflicts
  logger("Database: loading Plekt watchHistory records...");
  const allWatchRows = await getCachedHistory();
  const rowById = new Map();
  const historyMap = new Map();
  for (const row of allWatchRows) {
    rowById.set(row.id, row);
    const mKey = row.media_key;
    if (!historyMap.has(mKey)) historyMap.set(mKey, []);
    historyMap.get(mKey).push({
      id: row.id,
      syncAction: row.sync_action || "watched",
      watchedAt: row.watched_at || new Date().toISOString()
    });
  }
  for (const [mKey, records] of historyMap.entries()) {
    records.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  }
  logger(`Database: loaded ${allWatchRows.length} historical sync records.`);

  function findLooseMatch(media, groups) {
    for (const group of groups) {
      if (media.type !== group.type) continue;
      if (media.imdb && group.imdb && media.imdb === group.imdb) return group;
      if (media.tmdb && group.tmdb && media.tmdb === group.tmdb) return group;
      if (media.tvdb && group.tvdb && media.tvdb === group.tvdb) return group;

      const cleanTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (media.type === "episode") {
        const getShowName = (t) => t.split(" - ")[0].trim();
        const mediaShow = getShowName(media.title);
        const groupShow = getShowName(group.title);
        if (cleanTitle(mediaShow) === cleanTitle(groupShow) &&
            Number(media.season) === Number(group.season) &&
            Number(media.episode) === Number(group.episode)) {
          return group;
        }
      } else {
        if (cleanTitle(media.title) === cleanTitle(group.title)) {
          return group;
        }
      }
    }
    return null;
  }

  // 3. Group watched items loose-matched
  logger("Force Sync: grouping and matching items across servers...");
  const groups = [];
  for (const media of allWatchedItems) {
    const group = findLooseMatch(media, groups);
    if (group) {
      group.watchedOn.add(media.source);
      if (media.timestamp && (!group.timestamp || media.timestamp > group.timestamp)) {
        group.timestamp = media.timestamp;
      }
      if (!group.imdb && media.imdb) group.imdb = media.imdb;
      if (!group.tmdb && media.tmdb) group.tmdb = media.tmdb;
      if (!group.tvdb && media.tvdb) group.tvdb = media.tvdb;
      if (!group.episodeTitle && media.episodeTitle) group.episodeTitle = media.episodeTitle;
    } else {
      groups.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        imdb: media.imdb,
        tmdb: media.tmdb,
        tvdb: media.tvdb,
        timestamp: media.timestamp,
        episodeTitle: media.episodeTitle || null,
        watchedOn: new Set([media.source])
      });
    }
  }

  // 4. Compute canonical media keys and watched state entries
  const watchedMap = new Map();
  for (const group of groups) {
    const mediaObj = {
      title: group.title,
      type: group.type,
      season: group.season,
      episode: group.episode,
      ids: {
        imdb: group.imdb || undefined,
        tmdb: group.tmdb || undefined,
        tvdb: group.tvdb || undefined
      },
      episodeTitle: group.episodeTitle || undefined
    };
    const key = mediaKeyFor(mediaObj);
    watchedMap.set(key, { media: mediaObj, group });
  }

  // 5. Plembfin history is the canonical set of items to consider. Remote-only
  // watched items are deliberately ignored; a platform cannot manufacture a
  // new canonical watch during Force Sync.
  const allConsideredKeys = new Set(historyMap.keys());
  logger(`Force Sync: resolving Plekt-canonical watched state for ${allConsideredKeys.size} distinct items...`);

  let propagatedCount = 0;
  let addedToHistoryCount = 0;
  let deletedFromHistoryCount = 0;

  // Ceiling of 8: force sync fires mark-played/unplayed calls at the user's own
  // media servers, and a home NAS handles a burst of 64 concurrent writes badly
  // (cascading timeouts that then feed the retry queue).
  const reconciliationConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 8));
  if (reconciliationConcurrency > 1) {
    logger(`Force Sync: local concurrency enabled (${reconciliationConcurrency} workers).`);
  }

  let processedCount = 0;
  let abortResult = null;
  const consideredKeys = [...allConsideredKeys];

  const abortSummary = () => ({
    success: true,
    activeTargets,
    aborted: true,
    cancelled: true,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  });

  const checkEvery = reconciliationConcurrency > 1 ? 20 : 5;
  let cancellationChecks = 0;
  async function shouldAbort() {
    if (abortResult) return true;
    cancellationChecks += 1;
    if (cancellationChecks !== 1 && cancellationChecks % checkEvery !== 0) return false;
    const currentRuntime = await loadRuntimeState();
    const requested = await isCancelled().catch(() => false);
    const restoreActive = isAuthoritativeRestoreActive(currentRuntime);
    if (requested || currentRuntime.forceSyncCancelRequested === true || restoreActive) {
      logger(restoreActive
        ? "Force Sync: authoritative restore detected. Aborting sync..."
        : "Force Sync: stop request detected. Aborting sync...");
      abortResult = abortSummary();
      return true;
    }
    return false;
  }

  function reportProgress() {
    const reportEvery = Math.max(checkEvery, Math.ceil(consideredKeys.length / 100));
    if (processedCount === 1 || processedCount === consideredKeys.length || processedCount % reportEvery === 0) {
      logger(`Force Sync progress: ${processedCount}/${consideredKeys.length} items.`);
    }
  }

  async function markPlayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexPlayed } = await import("./plexClient.js");
      return markPlexPlayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyPlayed } = await import("./embyClient.js");
      return markEmbyPlayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinPlayed } = await import("./jellyfinClient.js");
      return markJellyfinPlayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function markUnplayedTarget(target, mediaObj) {
    if (target === "plex") {
      const { markPlexUnplayed } = await import("./plexClient.js");
      return markPlexUnplayed(config.plex, mediaObj);
    } else if (target === "emby") {
      const { markEmbyUnplayed } = await import("./embyClient.js");
      return markEmbyUnplayed(config.emby, mediaObj);
    } else if (target === "jellyfin") {
      const { markJellyfinUnplayed } = await import("./jellyfinClient.js");
      return markJellyfinUnplayed(config.jellyfin, mediaObj);
    }
    return null;
  }

  async function processConsideredKey(key) {
    if (await shouldAbort()) return false;

    const serverWatchedEntry = watchedMap.get(key);
    const historyRecords = historyMap.get(key) || [];
    const lastHistoryRecord = historyRecords[0];

    // No local history row at all means Plembfin never recorded a decision for
    // this item - not that it was explicitly marked unwatched. Treating an
    // absent row as canonical-unwatched would push a false "mark unplayed" to
    // any server that genuinely has it watched (e.g. after a history row is
    // deleted by the phantom-watch repair tool). Only an explicit unwatched
    // record is canonical.
    let newestState = null;
    let newestTime = 0;

    if (lastHistoryRecord) {
      newestState = lastHistoryRecord.syncAction === "unwatched" ? "unwatched" : "watched";
      newestTime = new Date(lastHistoryRecord.watchedAt).getTime();
    }

    let serverWatchedOn = new Set();
    let mediaObj = serverWatchedEntry ? serverWatchedEntry.media : null;

    if (serverWatchedEntry) {
      serverWatchedOn = serverWatchedEntry.group.watchedOn;
    }

    if (!mediaObj && lastHistoryRecord) {
      const docData = rowById.get(lastHistoryRecord.id) || {};
      mediaObj = {
        title: docData.title,
        type: docData.media_type,
        season: docData.season != null ? Number(docData.season) : null,
        episode: docData.episode != null ? Number(docData.episode) : null,
        ids: {
          imdb: docData.imdb_id || undefined,
          tmdb: docData.tmdb_id || undefined,
          tvdb: docData.tvdb_id || undefined
        }
      };
    }

    if (!mediaObj) return true;

    if (newestState === "watched") {
      const inHistory = historyRecords.some(r => r.syncAction === "watched");
      if (!inHistory) {
        logger(`Skipping server-only watched state for "${mediaObj.title}" because no Plekt history row exists.`);
      } else if (lastHistoryRecord && lastHistoryRecord.syncAction === "unwatched") {
        logger(`Deleting outdated unwatched record for "${mediaObj.title}"`);
        const unwatchedDocs = historyRecords.filter(r => r.syncAction === "unwatched");
        for (const docRec of unwatchedDocs) {
          if (await shouldAbort()) return false;
          await deleteWatchRecordById(docRec.id, { skipInvalidate: true });
        }
      }

      for (const target of healthyWatchedTargets) {
        if (await shouldAbort()) return false;
        if (!serverWatchedOn.has(target)) {
          logger(`Propagating: marking played "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markPlayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundPlayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundPlayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark played for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else if (newestState === "unwatched") {
      // The unwatched marker is already the canonical Plembfin decision. Do
      // not delete or recreate local history based on a remote discrepancy.
      logger(`Plekt is canonical for "${mediaObj.title}"; only repairing remote played flags.`);

      for (const target of healthyUnwatchedTargets) {
        if (await shouldAbort()) return false;
        if (serverWatchedOn.has(target)) {
          logger(`Propagating: marking unplayed "${mediaObj.title}" on ${target}`);
          try {
            await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
            const result = await markUnplayedTarget(target, mediaObj);
            if (result?.status !== "not_found") {
              const itemIds = Array.isArray(result?.itemIds) && result.itemIds.length
                ? result.itemIds
                : result?.itemId
                  ? [result.itemId]
                  : [];
              if (itemIds.length) {
                await Promise.all(itemIds.map((itemId) => recordOutboundUnplayedMarks({ ...mediaObj, itemId }, [target], loopStore).catch(() => null)));
              } else {
                await recordOutboundUnplayedMarks(mediaObj, [target], loopStore).catch(() => null);
              }
            }
            if (result?.status !== "not_found") propagatedCount++;
          } catch (err) {
            logger(`Error: failed to mark unwatched for "${mediaObj.title}" on ${target}: ${err.message}`);
          }
        }
      }
    } else {
      logger(`Skipping "${mediaObj.title}": server shows it watched but Plekt has no history record for it, so its unwatched/watched state cannot be determined safely.`);
    }
    return true;
  }

  if (reconciliationConcurrency > 1) {
    await runWithConcurrency(consideredKeys, reconciliationConcurrency, async (key) => {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
    });
  } else {
    for (const key of consideredKeys) {
      const completed = await processConsideredKey(key);
      if (completed) {
        processedCount += 1;
        reportProgress();
      }
      if (abortResult) break;
    }
  }

  if (abortResult) return abortResult;

  logger("Force Sync: process complete.");
  return {
    success: true,
    activeTargets,
    stats: {
      totalWatchedFoundAcrossServers: watchedMap.size,
      addedToHistory: addedToHistoryCount,
      deletedFromHistory: deletedFromHistoryCount,
      propagatedUpdates: propagatedCount,
      processed: processedCount,
      scanErrors: Object.fromEntries(scanFailures),
    }
  };
  } finally {
    clearInterval(heartbeatTimer);
    await invalidateHistoryDerivedCaches("runForceSync").catch(() => null);
    await releaseSyncOperation({
      kind: SYNC_OPERATION_FORCE,
      ownerId,
      values: {
        forceSyncActive: false,
        forceSyncCancelRequested: false,
        forceSyncHeartbeat: Date.now(),
      },
    }).catch(() => null);
  }
}
