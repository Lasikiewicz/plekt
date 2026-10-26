// Sync history rows and dispatch telemetry lines shared by the sync paths (split from scheduled.js).
import { appendSyncHistory } from "./configStore.js";
import { provenanceTelemetryLines } from "./watchProvenance.js";
import { recordWatchAuditEvents } from "./watchAudit.js";
import { mediaKeyFor } from "./dataRepo.js";
import { trackerProviderForSource } from "./trackers/registry.js";

export function addTimingHistoryRow(historyRows, media, watchedAt) {
  if (!Array.isArray(historyRows) || !media || !watchedAt) return;
  historyRows.push({
    ...media,
    media_type: media.type,
    sync_action: "watched",
    watched_at: watchedAt,
    show_title: media.showTitle,
    runtime_minutes: media.runtimeMinutes,
  });
}

export function buildTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  return [
    `Origin: ${media.source}`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...targetStates.map((targetState) => `Target ${targetState.target} status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

export function buildProgressTelemetry(media, summary) {
  const targetStates = summary?.targetStates || [];
  const positionMs = Number(media.positionMs ?? media.offsetMs ?? 0);
  return [
    `Origin: ${media.source}`,
    `Resume position: ${Math.round(positionMs / 1000)}s`,
    `Progress: ${Number(media.progress || 0).toFixed(1)}%`,
    `Loop-check: ${summary?.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary?.status || "unknown"}`,
    `Details: ${summary?.details || "No dispatch details returned"}`,
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
    ...targetStates.map((targetState) => `Target ${targetState.target} progress status: ${targetState.status}${targetState.detail ? ` - ${targetState.detail}` : ""}`),
  ].join("\n");
}

export async function recordSyncHistory(media = {}, summary = {}, action = "watched") {
  const timestamp = Date.now();
  const targetStates = Array.isArray(summary.targetStates) ? summary.targetStates : [];
  const auditBase = {
    timestamp,
    eventType: "sync_dispatch",
    action,
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    showTitle: media.showTitle || media.show_title,
    source: media.source || "unknown",
    sourceEvent: media.event,
    phase: media.phase,
    watchProvenance: media.watchProvenance || media.watch_provenance,
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
    itemId: media.itemId,
    sessionId: media.sessionId || media.session_id,
    user: media.user,
    device: media.device || media.deviceName || media.client?.deviceName,
    deviceId: media.deviceId || media.device_id || media.client?.deviceId,
    client: media.clientName || media.client?.client || media.client?.product || media.client?.platform,
    clientVersion: media.clientVersion || media.client?.version,
    status: summary.status || "unknown",
    details: summary.details || "",
  };
  recordWatchAuditEvents([
    {
      ...auditBase,
      details: `Outbound ${action} dispatch ${summary.status || "unknown"}: ${summary.details || "No details"}`,
      payload: { targetStates, scheduled: true },
    },
    ...targetStates.map((targetState) => ({
      ...auditBase,
      eventType: "sync_target",
      target: targetState.target,
      status: targetState.status,
      details: targetState.detail || `Target ${targetState.target || "unknown"} reported ${targetState.status}.`,
      itemId: targetState.itemId || targetState.item_id || auditBase.itemId,
      payload: targetState,
    })),
  ]);
  await appendSyncHistory({
    mediaType: media.type || media.mediaType || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action,
    targetStates,
    rawPayloadDebug: {
      sessionId: media.sessionId || media.id || "",
      ids: media.ids || {},
      mediaKey: mediaKeyFor(media),
      showTitle: media.showTitle || media.show_title || "",
      itemId: media.itemId || "",
      watchRecordId: media.watchRecordId || media.watch_record_id || media.recordId || media.record_id || "",
      season: media.season ?? null,
      episode: media.episode ?? null,
      progress: media.progress ?? null,
      offsetMs: media.offsetMs ?? media.positionMs ?? null,
      provenance: media.watchProvenance || media.watch_provenance || null,
    },
  }).catch((error) => console.error("Failed to append scheduled sync history", error));
}

export function isTargetSynced(telemetry = "", target = "", source = "") {
  const src = String(source || "").toLowerCase();
  const tgt = String(target || "").toLowerCase();
  if (src === tgt || src.startsWith(`${tgt}_`)) return true;
  if (trackerProviderForSource(src) === tgt) return true;

  const text = String(telemetry || "").toLowerCase();
  if (text.includes("force sync resolved status to success")) return true;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes(`${tgt} status:`) || line.includes(`${tgt} progress status:`)) {
      if (line.includes("success")) return true;
      if (line.includes("loop")) return true;
      // "not found" means the item simply isn't in this platform's library â€” treat as terminal
      // so it doesn't get re-queued every minute forever. Only "error" is retryable.
      if (line.includes("skipped")) return true;
      return false;
    }
  }
  return false;
}

// Manual watch rows write "Plex status:" / "Trakt status:" without the
// "Target " prefix, so both spellings name a target's line.
export function targetTelemetryLine(telemetry = "", target = "") {
  const pattern = new RegExp(`^(?:target\\s+)?${target}(?: progress)? status:`, "i");
  return String(telemetry || "").split("\n").find((line) => pattern.test(line.trim())) || "";
}

export function traktTelemetryLine(telemetry = "") {
  return targetTelemetryLine(telemetry, "trakt");
}
