import { db, parseJson, toJson } from "../db.js";
import { activityItemKeyFor } from "./syncActivityIdentity.js";
import { TARGET_DECISIONS } from "./watchSyncPolicy.js";

const TARGET_LABELS = {
  plex: "Plex",
  emby: "Emby",
  jellyfin: "Jellyfin",
  trakt: "Trakt",
  simkl: "Simkl",
};

const selectMatchingSyncHistoryStmt = db.prepare(`
  SELECT id, status, details, target_states
  FROM sync_history
  WHERE activity_item_key = ?
    AND action = ?
    AND timestamp >= ?
    AND LOWER(COALESCE(target_states, '')) LIKE ?
  ORDER BY timestamp DESC, id DESC
  LIMIT 1
`);

const updateSyncHistoryOutcomeStmt = db.prepare(`
  UPDATE sync_history
  SET status = ?, details = ?, target_states = ?
  WHERE id = ?
`);
const selectLatestWatchAction = db.prepare(`
  SELECT id, status, details, target_states FROM sync_history
  WHERE activity_item_key=? AND action IN ('watched','unwatched')
  ORDER BY timestamp DESC, id DESC LIMIT 1
`);

function formatTargetLabel(target) {
  const key = String(target || "").trim().toLowerCase();
  return TARGET_LABELS[key] || (key ? key.replace(/^./, (ch) => ch.toUpperCase()) : "Unknown");
}

function formatTargets(targets = []) {
  const labels = targets.map(formatTargetLabel);
  if (labels.length <= 1) return labels[0] || "";
  if (labels.length === 2) return `${labels[0]} & ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;
}

export function summarizeTargetStates(targetStates = []) {
  const successes = targetStates.filter((entry) => entry.status === "success").map((entry) => entry.target);
  const failures = targetStates.filter((entry) => ["error", "failed"].includes(entry.status)).map((entry) => entry.target);
  const skippedStates = targetStates.filter((entry) => entry.status === "skipped");
  const skipped = skippedStates.map((entry) => entry.target);
  const pending = targetStates.filter((entry) => entry.status === "pending").map((entry) => entry.target);
  const cancelled = targetStates.filter((entry) => entry.status === "cancelled").map((entry) => entry.target);
  const policySkipped = skippedStates
    .filter((entry) => entry.decision === TARGET_DECISIONS.SKIPPED_BY_POLICY)
    .map((entry) => entry.target);
  const cancelledSkipped = skippedStates
    .filter((entry) => entry.decision === "cancelled_by_user")
    .map((entry) => entry.target);
  const unmatched = skippedStates
    .filter((entry) => entry.decision !== TARGET_DECISIONS.SKIPPED_BY_POLICY && entry.decision !== "cancelled_by_user")
    .map((entry) => entry.target);

  const skipNotes = [
    unmatched.length ? `no match on ${formatTargets(unmatched)}` : "",
    policySkipped.length ? `${formatTargets(policySkipped)} skipped by the historical sync policy` : "",
    cancelledSkipped.length ? `${formatTargets(cancelledSkipped)} cancelled` : "",
  ].filter(Boolean).join("; ");

  if (cancelled.length) {
    return {
      status: "cancelled",
      details: successes.length
        ? `Synced to ${formatTargets(successes)}; ${formatTargets(cancelled)} dispatch cancelled`
        : `${formatTargets(cancelled)} dispatch cancelled`,
    };
  }
  if (failures.length) {
    return {
      status: successes.length ? "partial" : "error",
      details: successes.length
        ? `Synced to ${formatTargets(successes)}; failed ${formatTargets(failures)}`
        : `Failed ${formatTargets(failures)}`,
    };
  }
  if (skipped.length) {
    return {
      status: successes.length ? "partial" : "skipped",
      details: successes.length
        ? `Synced to ${formatTargets(successes)}; ${skipNotes}`
        : `Synced to no targets; ${skipNotes}`,
    };
  }
  if (successes.length) {
    return {
      status: "success",
      details: `Successfully synced to ${formatTargets(successes)}`,
    };
  }
  if (pending.length) {
    return {
      status: "pending",
      details: `Queued for ${formatTargets(pending)}`,
    };
  }
  return { status: "skipped", details: "No enabled sync destinations." };
}

/**
 * Update the matching Sync Activity row in place once a queued background
 * tracker write finishes, confirms on recheck, or is cancelled, so the UI does
 * not stay stuck on its original "pending" pill.
 */
export function updateSyncHistoryTargetOutcome(intent, {
  target = intent?.provider || "simkl",
  status = "",
  detail = "",
  decision = "",
  dismissed = false,
  watchRow = null,
} = {}) {
  const normalizedTarget = String(target || "").trim().toLowerCase();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!intent || !normalizedTarget || !normalizedStatus) return false;

  let media = {};
  try {
    media = JSON.parse(intent.media_json || "{}") || {};
  } catch {
    media = {};
  }

  const itemKey = activityItemKeyFor({
    mediaType: media.type || media.media_type || watchRow?.media_type,
    title: media.title || watchRow?.title,
    showTitle: media.showTitle || media.show_title || watchRow?.show_title,
    season: media.season ?? watchRow?.season,
    episode: media.episode ?? watchRow?.episode,
    action: intent.action || "watched",
    rawPayloadDebug: {
      mediaKey: watchRow?.media_key || intent.media_key,
      ids: media.ids,
    },
  });
  if (!itemKey) return false;

  const since = Math.max(0, Number(intent.created_at || 0) - 60_000);
  const approvedRecovery = normalizedTarget === "simkl" && normalizedStatus === "success"
    && media.simklFullSyncRunId && media.simklOrderMatch && Number.isSafeInteger(media.simklOrderActivityId);
  const row = approvedRecovery ? selectLatestWatchAction.get(itemKey) : selectMatchingSyncHistoryStmt.get(
    itemKey,
    intent.action || "watched",
    since,
    `%"target":"${normalizedTarget}"%`,
  );
  if (!row || (approvedRecovery && row.id !== media.simklOrderActivityId)) return false;

  const targetStates = parseJson(row.target_states, []);
  if (!Array.isArray(targetStates) || !targetStates.length) return false;
  const index = targetStates.findIndex((entry) => String(entry?.target || "").trim().toLowerCase() === normalizedTarget);
  if (index === -1) return false;

  const current = targetStates[index];
  const currentStatus = String(current?.status || "").trim().toLowerCase();
  // Never overwrite an already-succeeded entry with a stale outcome.
  if (approvedRecovery) {
    if (currentStatus !== "skipped" || !/^Simkl (does not support alternate episode orders|could not verify this episode's alternate numbering)/i.test(current.detail)) return false;
  } else if (!["pending", "error", "failed"].includes(currentStatus)) return false;

  const nextEntry = {
    ...current,
    target: normalizedTarget,
    status: normalizedStatus,
    ...(detail ? { detail } : {}),
  };
  if (normalizedStatus === "skipped") {
    if (decision) nextEntry.decision = decision;
    if (dismissed) nextEntry.dismissed = true;
  } else {
    delete nextEntry.decision;
    delete nextEntry.dismissed;
  }

  const nextTargetStates = targetStates.map((entry, idx) => (idx === index ? nextEntry : entry));
  const summary = summarizeTargetStates(nextTargetStates);
  const serializedTargets = toJson(nextTargetStates);
  if (
    row.status === summary.status
    && row.details === summary.details
    && row.target_states === serializedTargets
  ) {
    return false;
  }

  updateSyncHistoryOutcomeStmt.run(summary.status, summary.details, serializedTargets, row.id);
  return true;
}
