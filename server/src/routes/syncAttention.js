import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { writeAuditLog } from "../db.js";
import {
  activeSyncOperation,
  isAuthoritativeRestoreKind,
  loadMediaConfig,
  loadRuntimeState,
  recordSyncAttentionSkip,
  releaseSyncOperation,
  setRuntimeState,
  touchSyncOperation,
} from "../utils/configStore.js";
import { getOnboardingState, saveOnboardingState } from "../utils/onboardingStore.js";
import {
  canonicalShowTitleKey,
  canonicalTitleKey,
  getWatchRecordById,
  requireDb,
  showTitleFrom,
} from "../utils/dataRepo.js";
import { retryTraktRestoreItem } from "../utils/trackerDispatcher.js";
import { createLoopStore } from "../utils/loopStore.js";
import { syncMediaPlaystate, syncMediaUnplayedPlaystate } from "../utils/syncOrchestrator.js";
import { buildCompoundEpisodeIndex, compoundEpisodeForRow } from "../utils/compoundEpisode.js";
import { createRestoreLookupCache } from "../utils/restoreLookupCache.js";
import {
  syncAttentionItemIsAuthoritativeRestore,
  syncAttentionState,
} from "../utils/syncAttention.js";

const RESTORE_WATERMARK_BUFFER_MS = 5_000;

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function itemRunMatches(item = {}, runtime = {}) {
  const expected = String(item.context?.runId || "").trim();
  if (!expected || expected === "latest") return true;
  const actual = String(
    runtime.restoreSyncRunId
    || runtime.restoreSyncResult?.runId
    || runtime.forceSyncResult?.jobId
    || runtime.forceSyncResult?.runId
    || "",
  ).trim();
  return !actual || actual === expected || actual.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100) === expected;
}

function resultWithSkip(previous = {}, item = {}, skippedAt = Date.now()) {
  const old = objectValue(previous);
  const previousItems = Array.isArray(old.skippedAttention) ? old.skippedAttention : [];
  const skippedAttention = [
    ...previousItems,
    {
      id: item.id,
      title: item.title,
      skippedAt,
    },
  ].filter((entry, index, list) => list.findIndex((candidate) => candidate.id === entry.id) === index);
  return {
    ...old,
    success: true,
    completedWithSkippedIssues: true,
    skipped: true,
    skippedAt,
    finishedAt: skippedAt,
    skippedAttention,
  };
}

function rawPersistedRestoreIssues(result = {}) {
  const value = objectValue(result);
  if (Array.isArray(value.restoreIssues)) return value.restoreIssues;
  if (Array.isArray(value.restoreItems)) return value.restoreItems;
  if (Array.isArray(value.rejectedItems)) return value.rejectedItems;
  if (Array.isArray(value.trakt?.rejectedItems)) return value.trakt.rejectedItems;
  return [];
}

function restoreIssueKey(issue = {}) {
  return String(issue.key || issue.sourceRowId || "").trim();
}

function restoreIssueProvider(issue = {}) {
  return String(issue.provider || issue.target || "").trim().toLowerCase();
}

function restoreIssueCanRepair(issue = {}) {
  const provider = restoreIssueProvider(issue);
  if (!["trakt", "plex", "emby", "jellyfin"].includes(provider) || issue.candidate === true) return false;
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  if (!["episode", "movie"].includes(type)) return false;
  const sourceRowId = String(issue.sourceRowId || "").trim();
  const sourcePlaystateKey = String(issue.sourcePlaystateKey || issue.mediaKey || "").trim();
  const sourceMediaKey = String(issue.sourceMediaKey || "").trim();
  return provider === "trakt"
    ? Boolean(sourceRowId)
    : Boolean(sourceRowId || sourcePlaystateKey || sourceMediaKey);
}

function isExpectedRestoreAvailabilitySkip(issue = {}) {
  const provider = restoreIssueProvider(issue);
  if (provider === "trakt") return false;
  if (issue.expectedSkip === true) return true;
  const detail = [issue.reason, issue.lastError, issue.detail]
    .map((value) => String(value || ""))
    .join(" ");
  return /no matching item/i.test(detail);
}

function persistedRestoreIssues(result = {}) {
  return rawPersistedRestoreIssues(result).filter((issue) => !isExpectedRestoreAvailabilitySkip(issue));
}

function restoreRetryCount(result = {}) {
  const match = String(result.error || "").match(/after (\d+) retries/i);
  return Math.max(Number(match?.[1]) || Number(result.trakt?.retryCount) || 3, 1);
}

function restoreResultWithRemainingIssues(previous = {}, remaining = [], {
  repaired = [],
  skipped = [],
  failedIssueKey = "",
  failureReason = "",
  finishedAt = Date.now(),
} = {}) {
  const old = objectValue(previous);
  const next = {
    ...old,
    success: remaining.length === 0,
    restoreIssues: remaining,
    restoreIssueCount: remaining.length,
    restoreIssuesComplete: true,
    ...(repaired.length ? { repairedItems: [...(Array.isArray(old.repairedItems) ? old.repairedItems : []), ...repaired].slice(-5_000) } : {}),
    ...(skipped.length ? { skippedItems: [...(Array.isArray(old.skippedItems) ? old.skippedItems : []), ...skipped].slice(-5_000) } : {}),
    ...(failedIssueKey ? { lastRestoreIssueError: failureReason, lastRestoreIssueKey: failedIssueKey, lastRestoreIssueAttemptAt: finishedAt } : {}),
  };
  if (remaining.length) {
    const oldWasTraktFailure = /trakt rejected/i.test(String(old.error || ""))
      || (old.trakt && typeof old.trakt === "object");
    const traktIssues = remaining.filter((candidate) => {
      const provider = restoreIssueProvider(candidate);
      return provider === "trakt" || (!provider && oldWasTraktFailure);
    });
    const projectionIssues = remaining.filter((candidate) => !traktIssues.includes(candidate));
    if (traktIssues.length && !projectionIssues.length) {
      next.error = `Trakt rejected ${traktIssues.length} restored play${traktIssues.length === 1 ? "" : "s"} after ${restoreRetryCount(old)} retries`;
    } else {
      next.error = `${remaining.length} restored item projection${remaining.length === 1 ? "" : "s"} still need attention`;
    }
    if (old.trakt && typeof old.trakt === "object") {
      next.trakt = {
        ...old.trakt,
        rejectedCount: traktIssues.length,
        rejectedItems: traktIssues,
      };
    }
  } else {
    next.error = "";
    next.finishedAt = finishedAt;
    if (repaired.length) next.completedWithManualRepairs = true;
    if (skipped.length) {
      next.completedWithSkippedIssues = true;
      next.skipped = true;
      next.skippedAt = finishedAt;
    }
  }
  return next;
}

function restoreOwner(runtime = {}, item = {}) {
  const kind = String(runtime.restoreSyncKind || item.context?.restoreKind || "").trim();
  const ownerId = String(runtime.restoreSyncRunId || item.context?.runId || "").trim();
  const active = activeSyncOperation(runtime);
  const owns = runtime.restoreSyncActive === true
    && isAuthoritativeRestoreKind(kind)
    && active?.kind === kind
    && active?.ownerId === ownerId
    && ownerId !== "";
  return { kind, ownerId, active, owns };
}

async function persistRestoreIssueResult(item, runtime, nextResult, finishedAt) {
  const owner = restoreOwner(runtime, item);
  if (owner.owns) {
    const activeValues = {
      restoreSyncResult: nextResult,
      restoreSyncHeartbeat: finishedAt,
    };
    if (nextResult.success) {
      activeValues.restoreSyncActive = false;
      activeValues.restoreSyncRunId = "";
      activeValues.restoreSyncKind = "";
      activeValues.restoreSyncCancelRequested = false;
      if (owner.kind === "backup_restore") activeValues.lastRestoreAt = finishedAt + RESTORE_WATERMARK_BUFFER_MS;
      const released = await releaseSyncOperation({ kind: owner.kind, ownerId: owner.ownerId, values: activeValues });
      return { persisted: released, released };
    }
    const touched = await touchSyncOperation({ kind: owner.kind, ownerId: owner.ownerId, values: activeValues });
    return { persisted: touched, released: false };
  }

  if (!itemRunMatches(item, runtime)) return { persisted: false, released: false };
  await setRuntimeState({ restoreSyncResult: nextResult });
  return { persisted: true, released: false };
}

function mediaFromRestoreRepairRow(row = {}, compoundIndex = null) {
  const type = String(row.media_type || row.mediaType || row.type || "").toLowerCase();
  const media = {
    title: row.title || row.source_title || "Unknown media",
    type,
    source: "restore",
    isValid: true,
    watched_at: row.watched_at || row.watchedAt || undefined,
    watchedAt: row.watched_at || row.watchedAt || undefined,
    ids: {
      imdb: row.imdb_id || row.imdb || undefined,
      tmdb: row.tmdb_id || row.tmdb || undefined,
      tvdb: row.tvdb_id || row.tvdb || undefined,
    },
  };
  if (type === "episode") {
    media.season = row.season != null ? Number(row.season) : undefined;
    media.episode = row.episode != null ? Number(row.episode) : undefined;
    const compoundEpisode = compoundEpisodeForRow(row, compoundIndex);
    if (compoundEpisode) media.compound_episode = compoundEpisode;
  }
  return media;
}

function restoreIssueType(issue = {}) {
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  return ["episode", "movie"].includes(type) ? type : "";
}

function restoreIssueShowTitle(issue = {}) {
  return String(
    issue.showTitle
      || issue.sourceShowTitle
      || showTitleFrom(issue.sourceTitle || issue.title || ""),
  ).trim();
}

function restoreHistoryRowForIssue(issue = {}) {
  const type = restoreIssueType(issue);
  if (!type) return null;
  const rows = requireDb().prepare(`
    SELECT * FROM watch_history
    WHERE sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed')
  `).all();
  const candidates = rows.filter((row) => String(row.media_type || "").toLowerCase() === type);
  const sourceRowId = String(issue.sourceRowId || "").trim();
  const bySourceRowId = sourceRowId && candidates.find((row) => String(row.id || "").trim() === sourceRowId);
  if (bySourceRowId) return bySourceRowId;
  const sourceKey = String(issue.sourceMediaKey || issue.sourcePlaystateKey || issue.mediaKey || "").trim();
  const bySourceKey = sourceKey && candidates.find((row) => String(row.media_key || "").trim() === sourceKey);
  if (bySourceKey) return bySourceKey;

  const sourceIds = issue.sourceIds && typeof issue.sourceIds === "object" ? issue.sourceIds : issue.ids || {};
  const byProviderId = candidates.find((row) => ["imdb", "tmdb", "tvdb"].some((name) => (
    sourceIds?.[name]
    && String(row[`${name}_id`] || "").trim() === String(sourceIds[name]).trim()
  )));

  if (type === "episode") {
    const season = Number(issue.sourceSeason ?? issue.season);
    const episode = Number(issue.sourceEpisode ?? issue.episode);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return byProviderId || null;
    const coordinateRows = candidates.filter((row) => (
      Number(row.season) === season && Number(row.episode) === episode
    ));
    const showKey = canonicalShowTitleKey(restoreIssueShowTitle(issue));
    const byShow = showKey && coordinateRows.find((row) => (
      canonicalShowTitleKey(row.show_title || showTitleFrom(row.title || "")) === showKey
    ));
    return byShow || coordinateRows[0] || byProviderId || null;
  }

  const titleKey = canonicalTitleKey(issue.sourceTitle || issue.title || "");
  return candidates.find((row) => canonicalTitleKey(row.title || "") === titleKey)
    || byProviderId
    || null;
}

async function retryRestoreProjectionItem(row, target, state, ownerId = "") {
  const config = await loadMediaConfig();
  if (!["plex", "emby", "jellyfin"].includes(target)) {
    return { success: false, error: "This restore issue does not identify a supported media-server target." };
  }
  if (config?.[target]?.disabled === true) {
    return { success: false, error: `${target} is disabled; enable the connection before retrying this item.` };
  }
  const historyRows = requireDb().prepare("SELECT * FROM watch_history").all();
  const media = {
    ...mediaFromRestoreRepairRow(row, buildCompoundEpisodeIndex(historyRows)),
    syncTargets: [target],
  };
  const loopStore = createLoopStore();
  const lookupCache = createRestoreLookupCache({ maxEntries: 100 });
  media.restoreLookupCache = lookupCache;
  const restoreStillOwned = async () => {
    const runtime = await loadRuntimeState().catch(() => null);
    return runtime?.restoreSyncActive === true
      && (!ownerId || String(runtime.restoreSyncRunId || "") === String(ownerId));
  };
  try {
    const summary = String(state || "watched").toLowerCase() === "unwatched"
      ? await syncMediaUnplayedPlaystate(media, config, loopStore, {
        includeTrackers: false,
        trackDispatch: false,
        shouldDefer: async () => !(await restoreStillOwned()),
      })
      : await syncMediaPlaystate(media, config, loopStore, {
        includeTrackers: false,
        trackDispatch: false,
        shouldDefer: async () => !(await restoreStillOwned()),
      });
    const targetState = (summary?.targetStates || []).find((entry) => entry.target === target);
    if (targetState?.status === "success") return { success: true, media, summary };
    return {
      success: false,
      media,
      summary,
      error: targetState?.detail || summary?.details || `The ${target} target did not confirm the restored state.`,
    };
  } catch (error) {
    return { success: false, media, error: error.message || String(error) };
  }
}

async function updateRestoreIssue(item, issue, runtime, resolution) {
  if (!syncAttentionItemIsAuthoritativeRestore(item) || !itemRunMatches(item, runtime)) {
    return { status: 409, error: "The restore changed before this issue could be updated." };
  }
  const previous = objectValue(runtime.restoreSyncResult);
  const storedIssues = persistedRestoreIssues(previous);
  const key = restoreIssueKey(issue);
  const storedIssue = storedIssues.find((candidate) => restoreIssueKey(candidate) === key);
  if (!storedIssue) return { status: 404, error: "That restore issue is no longer outstanding." };

  const now = Date.now();
  if (resolution === "skipped") {
    const remaining = storedIssues.filter((candidate) => restoreIssueKey(candidate) !== key);
    const nextResult = restoreResultWithRemainingIssues(previous, remaining, {
      skipped: [{ key, title: storedIssue.title || issue.title || "Unknown media", skippedAt: now }],
      finishedAt: now,
    });
    const persisted = await persistRestoreIssueResult(item, runtime, nextResult, now);
    if (!persisted.persisted) return { status: 409, error: "The restore owner changed before this issue could be skipped." };
    return {
      ok: true,
      resolved: "skipped",
      released: persisted.released,
      message: persisted.released ? "The last restore issue was skipped and sync has resumed." : "The restore issue was skipped; the remaining restore issues are still blocking sync.",
    };
  }

  const provider = restoreIssueProvider(storedIssue)
    || (item.kind === "restore_trakt_rejections" || /trakt rejected/i.test(String(previous.error || "")) ? "trakt" : "");
  if (!restoreIssueCanRepair(storedIssue) && !restoreIssueCanRepair(issue)) {
    return {
      status: 409,
      requiresMatch: true,
      error: "This restore item could not be retried because the failed run did not retain enough row data. Use Fix match to correct the local title or provider IDs, then retry this item with the corrected identity.",
    };
  }

  let row = null;
  let repair;
  if (provider === "trakt") {
    if (!storedIssue.sourceRowId) {
      return { status: 409, error: "This Trakt issue does not retain its source watch-history row." };
    }
    row = await getWatchRecordById(storedIssue.sourceRowId).catch(() => null);
    if (!row) return { status: 404, error: "The Plektwatch-history row for this issue no longer exists." };
    if (["unwatched", "unplayed"].includes(String(row.sync_action || "").toLowerCase())) {
      return { status: 409, error: "This Plektwatch-history row is no longer watched, so it cannot be repaired as part of the restore." };
    }
    const rows = requireDb().prepare("SELECT * FROM watch_history WHERE sync_action IS NULL OR sync_action NOT IN ('unwatched', 'unplayed')").all();
    repair = await retryTraktRestoreItem(row, { rows });
  } else if (["plex", "emby", "jellyfin"].includes(provider)) {
    const sourceKey = String(storedIssue.sourcePlaystateKey || storedIssue.sourceMediaKey || "").trim();
    const historyRow = restoreHistoryRowForIssue(storedIssue);
    const currentMediaKey = String(historyRow?.media_key || "").trim();
    if (currentMediaKey) row = requireDb().prepare("SELECT * FROM playstate WHERE media_key = ?").get(currentMediaKey) || null;
    if (!row && historyRow) row = historyRow;
    if (!row && sourceKey) row = requireDb().prepare("SELECT * FROM playstate WHERE media_key = ?").get(sourceKey) || null;
    if (!row && storedIssue.sourceRowId) row = await getWatchRecordById(storedIssue.sourceRowId).catch(() => null);
    if (!row) return { status: 404, error: "The Plektplaystate row for this issue no longer exists." };
    if (historyRow) {
      row = {
        ...row,
        title: historyRow.title || row.title,
        show_title: historyRow.show_title || row.show_title,
        episode_title: historyRow.episode_title || row.episode_title,
        season: historyRow.season ?? row.season,
        episode: historyRow.episode ?? row.episode,
        watched_at: row.watched_at || historyRow.watched_at,
        // A Fix Match can intentionally clear the old provider identity.
        // Preserve that explicit correction instead of retrying with stale
        // ids from the failed playstate row.
        ...(historyRow.imdb_id !== undefined ? { imdb_id: historyRow.imdb_id } : {}),
        ...(historyRow.tmdb_id !== undefined ? { tmdb_id: historyRow.tmdb_id } : {}),
        ...(historyRow.tvdb_id !== undefined ? { tvdb_id: historyRow.tvdb_id } : {}),
      };
    }
    const state = String(row.state || row.sync_action || storedIssue.state || "watched").toLowerCase() === "unwatched" ? "unwatched" : "watched";
    repair = await retryRestoreProjectionItem(row, provider, state, String(runtime.restoreSyncRunId || item.context?.runId || ""));
  } else {
    return { status: 409, error: "This restore issue does not identify a supported repair target." };
  }
  if (!repair.success) {
    const reason = repair.error || (provider === "trakt" ? "Trakt could not accept this restored play." : `${provider} did not confirm the restored state.`);
    const nextIssues = storedIssues.map((candidate) => restoreIssueKey(candidate) === key
      ? {
        ...candidate,
        lastError: reason,
        reason,
        repairAttempts: Math.max(Number(candidate.repairAttempts) || 0, 0) + 1,
        lastAttemptAt: now,
      }
      : candidate);
    const nextResult = restoreResultWithRemainingIssues(previous, nextIssues, {
      failedIssueKey: key,
      failureReason: reason,
      finishedAt: now,
    });
    const persisted = await persistRestoreIssueResult(item, runtime, nextResult, now);
    if (!persisted.persisted) return { status: 409, error: "The restore owner changed while this item was being repaired." };
    return { status: 409, error: reason, repaired: false };
  }

  const remaining = storedIssues.filter((candidate) => restoreIssueKey(candidate) !== key);
  const nextResult = restoreResultWithRemainingIssues(previous, remaining, {
    repaired: [{
      key,
      title: storedIssue.title || issue.title || "Unknown media",
      repairedAt: now,
    }],
    finishedAt: now,
  });
  const persisted = await persistRestoreIssueResult(item, runtime, nextResult, now);
  if (!persisted.persisted) return { status: 409, error: "The restore owner changed after Trakt accepted this item. Refresh the sync page before taking another action." };
  return {
    ok: true,
    resolved: "repaired",
    released: persisted.released,
    message: persisted.released
      ? "The last restore issue was repaired and sync has resumed."
      : `The item was repaired on ${provider === "trakt" ? "Trakt" : provider}; the remaining restore issues are still blocking sync.`,
    media: repair.media,
  };
}

async function updateRestoreIssueKeys(item, itemKeys, runtime, resolution) {
  if (!syncAttentionItemIsAuthoritativeRestore(item) || !itemRunMatches(item, runtime)) {
    return { status: 409, error: "The restore changed before these issues could be updated." };
  }
  const previous = objectValue(runtime.restoreSyncResult);
  const storedIssues = persistedRestoreIssues(previous);
  const keySet = new Set((Array.isArray(itemKeys) ? itemKeys : [itemKeys]).map((k) => String(k).trim()).filter(Boolean));
  const matched = storedIssues.filter((candidate) => keySet.has(restoreIssueKey(candidate)));
  if (!matched.length) return { status: 404, error: "None of the specified restore issues are outstanding." };

  const now = Date.now();
  if (resolution === "skipped") {
    const remaining = storedIssues.filter((candidate) => !keySet.has(restoreIssueKey(candidate)));
    const skippedItems = matched.map((candidate) => ({
      key: restoreIssueKey(candidate),
      title: candidate.title || "Unknown media",
      skippedAt: now,
    }));
    const nextResult = restoreResultWithRemainingIssues(previous, remaining, {
      skipped: skippedItems,
      finishedAt: now,
    });
    const persisted = await persistRestoreIssueResult(item, runtime, nextResult, now);
    if (!persisted.persisted) return { status: 409, error: "The restore owner changed before these issues could be skipped." };
    return {
      ok: true,
      resolved: "skipped",
      released: persisted.released,
      message: persisted.released
        ? `The remaining restore issues were skipped and sync has resumed.`
        : `${matched.length} restore issues were skipped; the remaining restore issues are still blocking sync.`,
    };
  }
  return { status: 400, error: "Unsupported multi-issue action." };
}

async function skipRestoreAttention(item, runtime) {
  if (!syncAttentionItemIsAuthoritativeRestore(item) || !itemRunMatches(item, runtime)) {
    return { released: false, reason: "The restore changed before this issue was skipped." };
  }

  const skippedAt = Date.now();
  const nextResult = resultWithSkip(runtime.restoreSyncResult, item, skippedAt);
  const active = activeSyncOperation(runtime);
  const kind = String(runtime.restoreSyncKind || active?.kind || item.context?.restoreKind || "").trim();
  const ownerId = String(runtime.restoreSyncRunId || active?.ownerId || item.context?.runId || "").trim();
  const ownsRestore = runtime.restoreSyncActive === true
    && isAuthoritativeRestoreKind(kind)
    && active?.kind === kind
    && active?.ownerId === ownerId
    && ownerId !== "";

  if (ownsRestore) {
    const values = {
      restoreSyncActive: false,
      restoreSyncRunId: "",
      restoreSyncKind: "",
      restoreSyncCancelRequested: false,
      restoreSyncHeartbeat: skippedAt,
      restoreSyncResult: nextResult,
    };
    // The media-server portion has already completed. Stamp the same
    // post-restore watermark used by a successful backup restore so a normal
    // poll cannot re-import the app-side marks that were just written.
    if (kind === "backup_restore") values.lastRestoreAt = skippedAt + RESTORE_WATERMARK_BUFFER_MS;
    const released = await releaseSyncOperation({ kind, ownerId, values });
    return {
      released,
      reason: released ? "The restore was marked complete with this issue skipped." : "The restore owner changed before the lock could be released.",
    };
  }

  // Full Sync Watchstates normally releases its operation lock when a batch
  // fails. Keep its durable failure result visible as acknowledged without
  // reopening or clearing any newer restore that may have started since then.
  if (runtime.restoreSyncResult && itemRunMatches(item, runtime)) {
    await setRuntimeState({ restoreSyncResult: nextResult });
  }
  return { released: false, reason: "The issue was acknowledged; no active restore lock needed releasing." };
}

async function skipForceSyncAttention(item, runtime) {
  const result = objectValue(runtime.forceSyncResult);
  if (!result || !itemRunMatches(item, runtime)) return { released: false };
  const nextResult = resultWithSkip(result, item);
  const active = activeSyncOperation(runtime);
  const ownerId = String(active?.ownerId || result.jobId || result.runId || "").trim();
  if (active?.kind === "force_sync" && ownerId) {
    const released = await releaseSyncOperation({
      kind: "force_sync",
      ownerId,
      values: {
        forceSyncActive: false,
        forceSyncCancelRequested: false,
        forceSyncHeartbeat: Date.now(),
        forceSyncResult: nextResult,
      },
    });
    return { released, reason: released ? "Force Sync was marked complete with this issue skipped." : "The Force Sync owner changed before the lock could be released." };
  }
  await setRuntimeState({ forceSyncResult: nextResult });
  return { released: false, reason: "The Force Sync issue was acknowledged." };
}

function skipOnboardingAttention(item) {
  const context = objectValue(item.context);
  const scope = String(context.scope || "");
  const provider = String(context.provider || "").trim();
  const onboarding = getOnboardingState();
  if (scope === "initial_import" && provider) {
    const servers = { ...onboarding.backgroundImports.servers };
    if (provider === "trakt") {
      saveOnboardingState({
        backgroundImports: {
          ...onboarding.backgroundImports,
          trakt: { ...onboarding.backgroundImports.trakt, enabled: false, status: "skipped", completedAt: Date.now() },
        },
      });
    } else {
      servers[provider] = { ...(servers[provider] || {}), enabled: false, status: "skipped", completedAt: Date.now() };
      saveOnboardingState({ backgroundImports: { ...onboarding.backgroundImports, servers } });
    }
    return { released: false, reason: `The ${provider} initial import was skipped.` };
  }
  if (scope === "initial_push") {
    saveOnboardingState({ pushSync: { ...onboarding.pushSync, status: "skipped", completedAt: Date.now() } });
    return { released: false, reason: "The initial push was skipped." };
  }
  return { released: false, reason: "The issue was acknowledged." };
}

async function skipAttentionItem(item, runtime) {
  if (item.source === "restore") return skipRestoreAttention(item, runtime);
  if (item.source === "force_sync") return skipForceSyncAttention(item, runtime);
  if (item.source === "initial_import") return skipOnboardingAttention(item);
  return { released: false, reason: "The issue was acknowledged." };
}

async function currentAttention() {
  const runtime = await loadRuntimeState();
  return { runtime, ...syncAttentionState(runtime, getOnboardingState()) };
}

export async function handleSyncAttention(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (req.method === "GET") {
    const snapshot = await currentAttention();
    return sendJson(res, {
      attention: snapshot.attention,
      count: snapshot.count,
      status: snapshot.status,
    }, 200, { "Cache-Control": "private, no-store", Vary: "Authorization" });
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req).catch(() => ({}));
  const id = String(body.id || body.attentionId || "").trim();
  if (!id || id.length > 240) return sendJson(res, { error: "A valid sync attention id is required." }, 400);

  const before = await currentAttention();
  const item = before.attention.find((candidate) => candidate.id === id);
  if (!item) return sendJson(res, { error: "That sync issue is no longer outstanding." }, 404);

  const requestedAction = String(body.action || "skip").trim().toLowerCase();
  if (!["skip", "skip-item", "skip-items", "repair"].includes(requestedAction)) {
    return sendJson(res, { error: "Unsupported sync attention action." }, 400);
  }

  if (requestedAction === "skip-items") {
    if (!syncAttentionItemIsAuthoritativeRestore(item)) {
      return sendJson(res, { error: "Only individual authoritative restore issues can be repaired or skipped." }, 409);
    }
    const itemKeys = Array.isArray(body.itemKeys) ? body.itemKeys.map(String).filter(Boolean) : [];
    if (!itemKeys.length) return sendJson(res, { error: "A list of restore issue keys is required." }, 400);

    let issueAction;
    try {
      issueAction = await updateRestoreIssueKeys(item, itemKeys, before.runtime, "skipped");
    } catch (error) {
      issueAction = { status: 500, error: error.message || String(error) };
    }
    const after = await currentAttention();
    if (!issueAction.ok) {
      return sendJson(res, {
        ok: false,
        error: issueAction.error || "The restore issues could not be updated.",
        attention: after.attention,
        count: after.count,
        status: after.status,
      }, issueAction.status || 409);
    }
    writeAuditLog("sync.attention.skipped", {
      detail: {
        id: item.id,
        itemKeys,
        source: item.source,
        kind: item.kind,
        count: itemKeys.length,
        released: issueAction.released === true,
      },
    });
    return sendJson(res, {
      ok: true,
      resolved: { id: item.id, itemKeys, action: "skipped", resolvedAt: Date.now() },
      released: issueAction.released === true,
      message: issueAction.message,
      attention: after.attention,
      count: after.count,
      status: after.status,
    });
  }

  if (requestedAction === "repair" || requestedAction === "skip-item") {
    if (!syncAttentionItemIsAuthoritativeRestore(item)) {
      return sendJson(res, { error: "Only individual authoritative restore issues can be repaired or skipped." }, 409);
    }
    const issueKey = String(body.itemKey || body.issueKey || "").trim();
    if (!issueKey || issueKey.length > 300) return sendJson(res, { error: "A valid restore issue key is required." }, 400);
    const issue = (Array.isArray(item.context?.issueItems) ? item.context.issueItems : [])
      .find((candidate) => restoreIssueKey(candidate) === issueKey);
    if (!issue) return sendJson(res, { error: "That restore issue is no longer outstanding." }, 404);

    let issueAction;
    try {
      issueAction = await updateRestoreIssue(item, issue, before.runtime, requestedAction === "repair" ? "repaired" : "skipped");
    } catch (error) {
      issueAction = { status: 500, error: error.message || String(error) };
    }
    const after = await currentAttention();
    if (!issueAction.ok) {
      return sendJson(res, {
        ok: false,
        ...(issueAction.requiresMatch ? { requiresMatch: true } : {}),
        error: issueAction.error || "The restore issue could not be updated.",
        attention: after.attention,
        count: after.count,
        status: after.status,
      }, issueAction.status || 409);
    }
    writeAuditLog(`sync.attention.${issueAction.resolved}`, {
      detail: {
        id: item.id,
        itemKey: issueKey,
        source: item.source,
        kind: item.kind,
        title: issue.title || item.title,
        released: issueAction.released === true,
      },
    });
    return sendJson(res, {
      ok: true,
      resolved: { id: item.id, itemKey: issueKey, action: issueAction.resolved, resolvedAt: Date.now() },
      released: issueAction.released === true,
      message: issueAction.message,
      attention: after.attention,
      count: after.count,
      status: after.status,
    });
  }

  if (item.canSkip !== true) return sendJson(res, { error: "This sync issue cannot be skipped." }, 409);

  const marker = await recordSyncAttentionSkip(item.id, {
    source: item.source,
    kind: item.kind,
    runId: item.context?.runId || item.context?.restoreKind || "",
  });
  const action = await skipAttentionItem(item, before.runtime);
  writeAuditLog("sync.attention.skipped", {
    detail: { id: item.id, source: item.source, kind: item.kind, title: item.title, released: action.released === true },
  });

  const after = await currentAttention();
  return sendJson(res, {
    ok: true,
    skipped: { id: item.id, skippedAt: marker?.skippedAt || Date.now() },
    released: action.released === true,
    message: action.reason,
    attention: after.attention,
    count: after.count,
    status: after.status,
  });
}
