// Pending manual dispatch queue, Trakt retry checks and active target lookup (split from scheduled.js).
import { syncMediaPlaystate, syncMediaUnplayedPlaystate } from "./syncOrchestrator.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { getTrackerConnection } from "./trackerConnectionRepo.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { provenanceTelemetryLines } from "./watchProvenance.js";
import { dispatchGroupsForRows, getCachedHistory, invalidateHistoryDerivedCaches, updateWatchSyncRetry, updateWatchTelemetry, upsertPlaystateForMedia } from "./dataRepo.js";
import { recordSyncHistory, isTargetSynced, targetTelemetryLine, traktTelemetryLine } from "./syncHistoryTelemetry.js";
import { runWithConcurrency } from "./scheduledConcurrency.js";

// Automatic re-dispatch backoff for records whose sync targets keep failing.
// Attempt N waits SYNC_RETRY_BACKOFF_MS[N-1] (last entry repeats) before the
// next try; after SYNC_RETRY_MAX_ATTEMPTS the record is left alone until the
// user triggers Retry Sync, which resets the counters. Without this, a single
// offline target would be re-dispatched every minute forever.
const SYNC_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const SYNC_RETRY_MAX_ATTEMPTS = 10;

export function syncRetryDelayMs(retryCount) {
  const index = Math.min(Math.max(Number(retryCount) || 1, 1), SYNC_RETRY_BACKOFF_MS.length) - 1;
  return SYNC_RETRY_BACKOFF_MS[index];
}

export function syncRetryEligible(row = {}, now = Date.now()) {
  if (Number(row.sync_retry_count || 0) >= SYNC_RETRY_MAX_ATTEMPTS) return false;
  return Number(row.sync_next_retry_at || 0) <= now;
}

export function getActiveTargetsForConfig(config) {
  const targets = [];
  if (!config?.plex?.disabled && config?.plex?.baseUrl && config?.plex?.token) targets.push("plex");
  if (!config?.emby?.disabled && config?.emby?.baseUrl && config?.emby?.apiKey && config?.emby?.userId) targets.push("emby");
  if (!config?.jellyfin?.disabled && config?.jellyfin?.baseUrl && config?.jellyfin?.apiKey && config?.jellyfin?.userId) targets.push("jellyfin");
  return targets;
}

// Trakt joins the automatic retry only for failures that prove nothing
// permanent is wrong: a rate limit, a Trakt server error, a timeout or a
// connection failure. "Could not match" and other errors stay terminal until
// the user presses Retry. The trakt line is absent when Trakt was skipped
// (not connected, echo suppressed), which never counts as needing a retry.
const TRAKT_TRANSIENT_FAILURE = /failed with (?:429|5\d\d)\b|\(HTTP (?:429|5\d\d)\)|upstream request timed out|upstream request failed/i;

export function traktRetryActive() {
  return getTrackerConnection("trakt")?.status === "connected";
}

export function traktNeedsRetry(telemetry = "", source = "") {
  if (String(source || "").toLowerCase().includes("trakt")) return false;
  const line = traktTelemetryLine(telemetry).trim();
  return /^(?:target\s+)?trakt status:\s*error\b/i.test(line) && TRAKT_TRANSIENT_FAILURE.test(line);
}

function dispatchSourceForPendingRow(row = {}, action = row.sync_action) {
  const normalizedAction = String(action || "").toLowerCase();
  const telemetry = String(row.sync_dispatch_telemetry || "");
  // Manual unwatches are recorded with the original provider as their row
  // source so inbound history remains attributable, but their outbound replay
  // must fan out to every destination, including that original provider.
  if (["unwatched", "unplayed"].includes(normalizedAction) && /^Origin:\s*manual\s*$/im.test(telemetry)) {
    return "manual";
  }
  return row.source;
}

export async function syncPendingManualDispatches(config, loopStore, logger = console.log) {
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Pending watched dispatch sync is disabled.");
    return 0;
  }
  let syncedCount = 0;
  try {
    // History is already cached in memory. Inspect the complete canonical set
    // so older imports are repaired too; the outbound batch limit below still
    // keeps each scheduler tick bounded.
    const rows = await getCachedHistory();

    const activeTargets = getActiveTargetsForConfig(config);
    const includeTrakt = traktRetryActive();
    const toRetry = [];
    const now = Date.now();

    for (const row of rows) {
      const action = String(row.sync_action || "watched").toLowerCase();
      if (!["watched", "unwatched", "unplayed"].includes(action)) continue;
      const dispatchSource = dispatchSourceForPendingRow(row, action);

      const telemetry = row.sync_dispatch_telemetry || "";
      const isPending = telemetry.includes("Dispatch status: pending");

      let needsSync = isPending;
      if (!isPending && activeTargets.length > 0) {
        const allSynced = activeTargets.every((target) =>
          isTargetSynced(telemetry, target, dispatchSource)
        );
        if (!allSynced) {
          needsSync = true;
        }
      }
      if (!isPending && includeTrakt && traktNeedsRetry(telemetry, dispatchSource)) needsSync = true;

      if (needsSync && syncRetryEligible(row, now)) {
        toRetry.push(row);
      }
    }

    // A bulk historical import (e.g. the onboarding Trakt reconcile) can queue
    // thousands of rows needing outbound dispatch at once, and this batch is
    // capped at 15/tick - a fresh edit made directly on Trakt (or any other
    // non-bulk change) would otherwise land at the back of that queue and
    // wait behind the whole backlog before it ever reaches Plex/Emby/Jellyfin.
    // Bulk-imported rows are the only ones tagged "Ingest path:
    // historical_import" in their own telemetry, so sort them after
    // everything else while keeping each group's original order stable.
    const isBulkHistoricalImport = (row) => (row.sync_dispatch_telemetry || "").includes("Ingest path: historical_import");
    toRetry.sort((a, b) => Number(isBulkHistoricalImport(a)) - Number(isBulkHistoricalImport(b)));

    const maxRetries = 15;
    const batchToRetry = toRetry.slice(0, maxRetries);

    // Keep the historical row cap: grouping only controls concurrency, so a
    // tick that contains many aliases still processes the same 15 rows it did
    // before. Identity is derived from the complete history, ensuring bridge
    // rows outside this selected batch cannot split one real item.
    const dispatchGroups = dispatchGroupsForRows(batchToRetry, rows);
    await runWithConcurrency(dispatchGroups, 6, async (group) => {
      for (const row of group.rows) {
        if (isAuthoritativeRestoreActive()) return;
        try {
      const id = row.id;
      const action = String(row.sync_action || "watched").toLowerCase();
      const isUnwatched = action === "unwatched" || action === "unplayed";
      const dispatchSource = dispatchSourceForPendingRow(row, action);
      const media = {
        title: row.title,
        type: row.media_type,
        source: dispatchSource,
        // Without this, a retried dispatch falls back to Date.now() in
        // traktClient.js's syncPayload, so a row that genuinely happened at
        // some earlier date reaches Trakt stamped as watched right now
        // instead - the same class of bug already fixed for manualWatchMediaFromRecord.
        watched_at: row.watched_at || undefined,
        watchProvenance: row.watch_provenance || null,
        isValid: true,
        ids: {
          imdb: row.imdb_id || undefined,
          tmdb: row.tmdb_id || undefined,
          tvdb: row.tvdb_id || undefined,
        },
        season: row.season == null ? undefined : Number(row.season),
        episode: row.episode == null ? undefined : Number(row.episode),
      };

      // A row lands in this batch because at least one active target isn't
      // confirmed synced yet, but that doesn't mean none of them are. Only
      // dispatch to the targets still missing confirmation instead of
      // re-sending mark-played to ones the telemetry already shows as
      // successful - fewer redundant outbound calls, faster backlog drain.
      const targetsStillNeeded = activeTargets.filter(
        (target) => !isTargetSynced(row.sync_dispatch_telemetry || "", target, dispatchSource)
      );
      const retryTrakt = includeTrakt && traktNeedsRetry(row.sync_dispatch_telemetry || "", dispatchSource);
      if (retryTrakt) {
        targetsStillNeeded.push("trakt");
        // The failed write may have reached Trakt before its response was
        // lost, so the dispatcher checks Trakt history before adding again.
        if (!isUnwatched) media.traktRetryHistoryCheck = true;
      }
      if (targetsStillNeeded.length) media.syncTargets = targetsStillNeeded;

      logger(`Background Queue: retrying/dispatching sync for ${media.title} (${id})...`);
      if (isAuthoritativeRestoreActive()) return;
      const stateMedia = { ...media, source: row.source || media.source };
      if (isUnwatched) {
        await upsertPlaystateForMedia(stateMedia, "unwatched", row.watched_at, { skipInvalidate: true });
      } else {
        await upsertPlaystateForMedia(stateMedia, "watched", row.watched_at, { skipInvalidate: true });
      }
      const summary = await (isUnwatched
        ? syncMediaUnplayedPlaystate(media, config, loopStore)
        : syncMediaPlaystate(media, config, loopStore)).catch((error) => ({
        skipped: false,
        status: "error",
        details: `Outbound sync failed: ${error.message || String(error)}`,
        targetStates: [],
      }));

      // Targets skipped this round (already confirmed synced) had no dispatch
      // this time, so summary.targetStates has no line for them - carry their
      // prior confirmed line forward instead of letting it drop out of the
      // telemetry, which would otherwise make allSyncedNow below regress to
      // false and re-queue an already-finished target forever.
      // Trakt is carried forward too whenever an explicit target list left it
      // out, so a confirmed or terminal Trakt result survives a local retry.
      const carriedTargets = activeTargets.filter((target) => !targetsStillNeeded.includes(target));
      if (media.syncTargets && !targetsStillNeeded.includes("trakt")) carriedTargets.push("trakt");
      const carriedForwardLines = carriedTargets
        .map((target) => targetTelemetryLine(row.sync_dispatch_telemetry, target))
        .filter(Boolean);

      const telemetryLines = [
        `Origin: ${media.source}`,
        `Loop-check: Passed`,
        `Dispatch status: ${summary.status}`,
        `Details: ${summary.details || (isUnwatched ? "Manual unwatch state propagated; sync completed." : "Manual watch state propagated; sync completed.")}`,
        ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
        ...carriedForwardLines,
        ...(summary.targetStates || []).map(
          (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
        ),
      ];

      const previousRetryCount = Number(row.sync_retry_count || 0);
      const telemetryNow = telemetryLines.join("\n");
      const allSyncedNow = (activeTargets.length > 0 || includeTrakt)
        && activeTargets.every((target) => isTargetSynced(telemetryNow, target, dispatchSource))
        && !(includeTrakt && traktNeedsRetry(telemetryNow, dispatchSource));
      let terminal = false;
      if (allSyncedNow) {
        await updateWatchSyncRetry(id, 0, 0, { skipInvalidate: true });
      } else {
        const nextCount = previousRetryCount + 1;
        terminal = nextCount >= SYNC_RETRY_MAX_ATTEMPTS;
        await updateWatchSyncRetry(id, nextCount, Date.now() + syncRetryDelayMs(nextCount), { skipInvalidate: true });
        if (terminal) {
          telemetryLines.push(`Retry: automatic retries exhausted after ${SYNC_RETRY_MAX_ATTEMPTS} attempts; use Retry Sync to try again.`);
          logger(`Background Queue: giving up on ${media.title} (${id}) after ${SYNC_RETRY_MAX_ATTEMPTS} attempts.`);
        } else {
          telemetryLines.push(`Retry: attempt ${nextCount} of ${SYNC_RETRY_MAX_ATTEMPTS}; next automatic retry in ${Math.round(syncRetryDelayMs(nextCount) / 60_000)}m.`);
        }
      }

      await updateWatchTelemetry(id, telemetryLines.join("\n"), { skipInvalidate: true });
      // Only log a sync_history row when the outcome is new information: the
      // first failed attempt, a success, or giving up. Identical failures on
      // every backoff step would otherwise flood the table.
      if (allSyncedNow || previousRetryCount === 0 || terminal) {
        await recordSyncHistory(media, summary, action);
      }
      syncedCount++;
        } catch (error) {
          logger(`Background Queue: failed to process ${row.title} (${row.id}): ${error.message || String(error)}`);
        }
      }
    });
  } catch (error) {
    logger(`Pending Queue dispatcher failed: ${error.message}`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncPendingManualDispatches").catch(() => null);
  return syncedCount;
}
