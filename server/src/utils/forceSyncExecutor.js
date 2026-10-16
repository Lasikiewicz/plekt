import { getCachedHistory, deleteWatchRecordById, insertWatchRecord, mediaToWatchRecord, upsertPlaystateForMedia } from "./dataRepo.js";
import { markPlexPlayed, markPlexUnplayed } from "./plexClient.js";
import { markEmbyPlayed, markEmbyUnplayed } from "./embyClient.js";
import { markJellyfinPlayed, markJellyfinUnplayed } from "./jellyfinClient.js";
import { recordOutboundPlayedMarks, recordOutboundUnplayedMarks } from "./syncOrchestrator.js";
import { createLoopStore } from "./loopStore.js";
import { collectServerFingerprintCounts, planStaleness } from "./forceSyncPlanner.js";
import { finishSyncPlan, getSyncPlanFull, setSyncPlanSnapshot, setSyncPlanStatus } from "./syncPlans.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { createWatchHistoryBackup, verifyWatchBackup } from "./watchHistoryBackups.js";
import { runWithConcurrency } from "./concurrency.js";

const played = { plex: markPlexPlayed, emby: markEmbyPlayed, jellyfin: markJellyfinPlayed };
const unplayed = { plex: markPlexUnplayed, emby: markEmbyUnplayed, jellyfin: markJellyfinUnplayed };

// Each plan action targets a distinct media key (see forceSyncPlanner.js),
// so actions carry no ordering dependency on one another and are safe to run
// concurrently. The outbound governor already caps actual concurrent
// requests per target host, so this only shortens wall-clock time for a
// large plan - it does not send more simultaneous requests to any one
// server than the governor's profile already allows.
const FORCE_SYNC_CONCURRENCY = 6;

function finishResult(result) {
  result.success = !result.error && result.failedActions === 0 && result.missingActions === 0;
  result.status = result.success ? "completed" : result.completedActions > 0 ? "partial" : "failed";
  const labels = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
  const missing = Object.entries(result.missingItems.reduce((counts, item) => {
    counts[item.target] = (counts[item.target] || 0) + 1;
    return counts;
  }, {})).map(([target, count]) => `${count} not found on ${labels[target] || target}`);
  result.message = `${result.success ? "Applied" : result.completedActions > 0 ? "Partially applied" : "Not applied"}: ${result.completedActions} of ${result.plannedActions} actions applied${missing.length ? `; ${missing.join("; ")}` : ""}${result.failedActions ? `; ${result.failedActions} failed` : ""}.`;
  if (result.missingItems.length) result.message += ` Missing titles: ${result.missingItems.map(item => `${item.title} (${labels[item.target] || item.target})`).join(", ")}.`;
  if (result.error) result.message += ` ${result.error}`;
  return result;
}

async function remoteWrite(action, config) {
  const fn = action.kind === "mark_played" ? played[action.target] : unplayed[action.target];
  if (!fn) throw new Error(`Unsupported Force Sync target ${action.target}`);
  return fn(config[action.target], action.media);
}

export async function executeForceSyncPlan(id, config, logger = () => {}, { signal, shouldCancel = async () => false } = {}) {
  const plan = getSyncPlanFull(id);
  if (!plan) return { success: false, error: "Plan not found.", planId: id };
  if (plan.status !== "confirmed") return { success: false, error: `Plan is ${plan.status} and is not confirmed.`, planId: id };
  if (plan.summary?.scopeErrors?.length) {
    setSyncPlanStatus(id, "blocked_scan_error");
    return {
      success: false,
      planId: id,
      error: "The plan cannot execute because one or more configured servers were not scanned successfully.",
      scopeErrors: plan.summary.scopeErrors,
    };
  }
  const fingerprintErrors = [];
  const counts = await collectServerFingerprintCounts(config, {
    scope: plan.scope,
    onError: (server, error) => fingerprintErrors.push({ server, error: error?.message || String(error) }),
  });
  if (fingerprintErrors.length) {
    setSyncPlanStatus(id, "blocked_scan_error");
    return {
      success: false,
      planId: id,
      error: "The plan could not verify every configured server before execution; no remote writes were sent.",
      scopeErrors: fingerprintErrors,
    };
  }
  const freshness = planStaleness(plan, { counts, config });
  if (freshness.stale) {
    setSyncPlanStatus(id, "expired");
    return { success: false, planId: id, code: "plan_stale", error: freshness.reasons.join(" "), reasons: freshness.reasons };
  }
  if (plan.summary?.overLimit) {
    setSyncPlanStatus(id, "blocked_over_limit");
    return { success: false, planId: id, error: "Plan exceeds its maximum-change limit." };
  }
  setSyncPlanStatus(id, "executing");
  const loopStore = createLoopStore();
  let snapshot = null;
  const result = { success: true, planId: id, snapshot, plannedActions: plan.actions.length, completedActions: 0, failedActions: 0, missingActions: 0, missingItems: [], scope: plan.scope };
  try {
    if (plan.summary?.destructive > 0) {
      logger("Force Sync: creating verified pre-run recovery snapshot...");
      snapshot = await createWatchHistoryBackup({ reason: "pre-force-sync" });
      result.snapshot = snapshot;
      verifyWatchBackup(snapshot.name);
      setSyncPlanSnapshot(id, snapshot.name);
      logger(`Force Sync: recovery snapshot verified (${snapshot.name}).`);
    }
    let cancelled = false;
    await runWithConcurrency(plan.actions, async (action) => {
      if (cancelled) return;
      if (signal?.aborted || isAuthoritativeRestoreActive() || await shouldCancel()) {
        cancelled = true;
        return;
      }
      try {
        if (action.kind === "mark_played" || action.kind === "mark_unplayed") {
          const marker = action.kind === "mark_played" ? recordOutboundPlayedMarks : recordOutboundUnplayedMarks;
          await marker(action.media, [action.target], loopStore).catch(() => null);
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          const remoteResult = await remoteWrite(action, config);
          if (remoteResult?.status === "not_found") {
            result.missingActions += 1;
            result.missingItems.push({ title: action.media?.title || "Unknown title", target: action.target });
            return;
          }
          if (remoteResult?.status !== "not_found") {
            const itemIds = Array.isArray(remoteResult?.itemIds) && remoteResult.itemIds.length
              ? remoteResult.itemIds
              : remoteResult?.itemId
                ? [remoteResult.itemId]
                : [];
            if (itemIds.length) {
              await Promise.all(itemIds.map((itemId) => marker({ ...action.media, itemId }, [action.target], loopStore).catch(() => null)));
            } else {
              await marker(action.media, [action.target], loopStore).catch(() => null);
            }
          }
        }
        else if (["remove_unwatched_marker", "delete_history_rows"].includes(action.kind)) for (const rowId of action.historyRowIds || []) {
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          await deleteWatchRecordById(rowId, { skipInvalidate: true });
        }
        else if (action.kind === "insert_unwatched_record") {
          if (isAuthoritativeRestoreActive() || await shouldCancel()) {
            cancelled = true;
            return;
          }
          const record = mediaToWatchRecord({ ...action.media, source: "force_sync", watched_at: action.resolvedAt || new Date().toISOString() }, "force_sync");
          record.sync_action = "unwatched";
          const inserted = await insertWatchRecord(record, { skipInvalidate: true });
          await upsertPlaystateForMedia({ ...action.media, source: "force_sync", isValid: true }, "unwatched", inserted.record.watched_at, { skipInvalidate: true });
        }
        result.completedActions += 1;
      } catch (error) {
        result.failedActions += 1;
        logger(`Force Sync action ${action.seq || ""} failed: ${error.message}`);
      }
    }, FORCE_SYNC_CONCURRENCY);

    if (cancelled) {
      result.success = false;
      result.aborted = true;
      result.cancelled = true;
      result.error = "Force Sync cancelled";
      finishSyncPlan(id, "cancelled", result);
      return result;
    }
    finishResult(result);
    finishSyncPlan(id, result.status, result);
    return result;
  } catch (error) {
    finishResult(Object.assign(result, { error: error.message }));
    result.status = snapshot ? "failed" : "blocked_snapshot_failed";
    finishSyncPlan(id, result.status, result);
    return result;
  }
}
