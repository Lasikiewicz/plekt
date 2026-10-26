import { getDataVersion, getProgressVersion, getDiscoverVersion, getUpNextVersion, latestLiveChangeId, liveChangesSince } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed } from "../utils/http.js";
import {
  activeSyncOperation,
  loadBackgroundSyncProgress,
  loadRuntimeState,
  syncOperationIsFresh,
} from "../utils/configStore.js";
import { getOnboardingState } from "../utils/onboardingStore.js";
import { syncAttentionState } from "../utils/syncAttention.js";
import { trackerWriteAttentionItems } from "../utils/trackerWriteIntents.js";
import { simklObservationAttentionItems } from "../utils/trackers/simklObservations.js";
import { getBackgroundJobLogs, getLatestBackgroundJob } from "../utils/backgroundJobs.js";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function onboardingImportIsActive() {
  const onboarding = getOnboardingState();
  const serverImports = Object.values(onboarding.backgroundImports?.servers || {});
  const imports = [...serverImports, ...Object.values(onboarding.backgroundImports?.trackers || {})];
  return imports.some((entry) => entry?.status === "importing" && entry?.enabled !== false);
}

function labelForSyncOperation(operation) {
  switch (operation?.kind) {
    case "scheduled_sync": return "Scanning";
    case "force_sync": return "Syncing";
    case "rebuild": return "Rebuilding";
    case "full_sync_watchstates":
    case "backup_restore":
    case "restore": return "Restoring";
    default: return operation ? "Working" : "";
  }
}

// Retry-all is a persisted background job rather than an in-process sync
// operation. Include its log-derived progress in the same snapshot that is
// already sent over SSE so Sync Activity can repaint after each completed
// item, including when the job was started in another tab or before a reload.
function retryAllSyncProgress() {
  const job = getLatestBackgroundJob("retry_all_sync_activity");
  if (!job || !["queued", "running"].includes(job.status)) return null;

  let total = 0;
  let completed = 0;
  for (const entry of getBackgroundJobLogs(job.id)) {
    const line = String(entry.message || "");
    const found = /^Found (\d+) failed(?: or skipped)?/.exec(line);
    if (found) total = Number(found[1]) || 0;
    const progress = /^\[(\d+)\/(\d+)\]/.exec(line);
    if (progress) {
      completed = Math.max(completed, Number(progress[1]) || 0);
      total = Number(progress[2]) || total;
    }
  }

  return {
    total,
    completed,
    active: true,
    label: "Retrying failed sync items",
  };
}

// The original progress counter tracks outbound dispatch bursts. Initial
// library imports and the scheduled library scan can be doing real work while
// that counter is empty, so the dashboard needs the broader operation state as
// well. Keep this snapshot read-only and sourced from the same shared stores as
// the existing SSE progress so split web/worker deployments agree.
async function loadSyncStatus() {
  const [progress, runtime] = await Promise.all([
    loadBackgroundSyncProgress(),
    loadRuntimeState(),
  ]);
  const retryAll = retryAllSyncProgress();
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const dispatchActive = total > 0 && completed < total;
  const operation = syncOperationIsFresh(runtime) ? activeSyncOperation(runtime) : null;
  const importing = onboardingImportIsActive();
  const startupScanActive = runtime.startupScanActive === true;
  const active = retryAll?.active || importing || startupScanActive || Boolean(operation) || dispatchActive;
  const attention = syncAttentionState({ ...runtime, trackerWriteAttention: [...trackerWriteAttentionItems(), ...simklObservationAttentionItems()] }, getOnboardingState());
  return {
    total: retryAll ? retryAll.total : total,
    completed: retryAll ? retryAll.completed : completed,
    active,
    label: retryAll?.label || (importing ? "Importing" : startupScanActive ? "Scanning" : labelForSyncOperation(operation) || (dispatchActive ? "Syncing" : "")),
    currentItemLabel: retryAll?.currentItemLabel || String(progress.currentItemLabel || ""),
    startupScanActive,
    attentionCount: attention.count,
    attentionStatus: attention.status,
  };
}

function syncEventFields(status) {
  return {
    syncTotal: status.total,
    syncCompleted: status.completed,
    syncActive: status.active,
    syncLabel: status.label,
    syncCurrentItemLabel: status.currentItemLabel,
    syncStartupScanActive: status.startupScanActive,
    syncAttentionCount: status.attentionCount,
    syncAttentionStatus: status.attentionStatus,
  };
}

function readLiveChangesSince(cursor) {
  const rows = [];
  let nextCursor = Math.max(Number(cursor) || 0, 0);
  // A busy sync can write many rows between two 250ms polls. Drain the journal
  // in bounded chunks so advancing the aggregate version never strands the
  // tail of a batch for a future version bump.
  for (let page = 0; page < 20; page += 1) {
    const batch = liveChangesSince(nextCursor, 10_000);
    if (!batch.length) break;
    rows.push(...batch);
    nextCursor = Number(batch[batch.length - 1].id) || nextCursor;
    if (batch.length < 10_000) break;
  }

  // Multiple canonical tables often describe one logical media mutation (for
  // example watch_history and playstate). The browser only needs the newest
  // signal for each media key; the item endpoint then reads the authoritative
  // current projection once.
  const latestByTarget = new Map();
  for (const row of rows) {
    const target = row.media_key
      ? `key:${row.media_key}`
      : row.record_id
        ? `record:${row.record_id}`
        : "";
    if (!target) continue;
    latestByTarget.set(target, {
      changeId: Number(row.id) || 0,
      sourceTable: row.source_table || "",
      changeKind: row.change_kind || "upsert",
      mediaKey: row.media_key || "",
      recordId: row.record_id || "",
      mediaType: row.media_type || "",
      title: row.title || "",
      showTitle: row.show_title || "",
      season: row.season ?? null,
      episode: row.episode ?? null,
      createdAt: Number(row.created_at) || 0,
    });
  }
  return { changes: [...latestByTarget.values()], cursor: nextCursor };
}

// Streams shared SQLite cache versions rather than relying on an in-process
// event emitter. This keeps browser updates working when Plembfin's web and
// scheduler roles run in separate processes.
// What an open page needs to be told about. Broader than the derived-cache
// generation on purpose: resume-position writes no longer invalidate any
// history-derived cache, but a page showing a progress bar still has to see
// them, so both generations are combined here.
function clientFacingVersion() {
  // A sum, not a dotted pair: the client parses this with Number(), where
  // "5.10" and "5.1" collapse to the same value. Both generations only ever
  // increase, so the sum advances on every bump of either.
  return getDataVersion() + getProgressVersion();
}

export async function handleLiveUpdates(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  // Send a complete progress snapshot in `ready`, before the browser is
  // allowed to react to a version change. This matters on reconnect: the tab
  // still holds its previous sync-busy flag until this new stream corrects it.
  let lastChangeId = latestLiveChangeId();
  const initialSyncStatus = await loadSyncStatus();
  const initialVersion = clientFacingVersion();
  const initialDiscoverVersion = getDiscoverVersion();
  const initialUpNextVersion = getUpNextVersion();

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let lastVersion = initialVersion;
  let lastDiscoverVersion = initialDiscoverVersion;
  let lastUpNextVersion = initialUpNextVersion;
  let lastWriteAt = Date.now();
  let lastSyncStatus = initialSyncStatus;
  let pollInFlight = false;
  writeEvent(res, {
    type: "ready",
    version: lastVersion,
    discoverVersion: lastDiscoverVersion,
    upNextVersion: lastUpNextVersion,
    ...syncEventFields(initialSyncStatus),
  });

  // Single poll loop: checks both history version and sync-progress every
  // POLL_MS in one pass. When a version bump is detected, the current
  // sync-progress is piggy-backed onto the history-version event (as
  // syncTotal/syncCompleted) so the client can update its sync-busy flag
  // *before* deciding whether to queue a dashboard refresh — closing the
  // race where a version bump fired a refresh before the sync-progress
  // poll interval had a chance to catch up.
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || pollInFlight) return;
    pollInFlight = true;
    loadSyncStatus()
      .then((syncStatus) => {
        if (res.writableEnded || res.destroyed) return;

        // --- Sync progress ---
        const syncProgressChanged =
          syncStatus.total !== lastSyncStatus.total
          || syncStatus.completed !== lastSyncStatus.completed
          || syncStatus.active !== lastSyncStatus.active
          || syncStatus.label !== lastSyncStatus.label
          || syncStatus.attentionCount !== lastSyncStatus.attentionCount
          || syncStatus.attentionStatus !== lastSyncStatus.attentionStatus;
        if (syncProgressChanged) lastSyncStatus = syncStatus;

        // --- History version ---
        const version = clientFacingVersion();
        const discoverVersion = getDiscoverVersion();
        const upNextVersion = getUpNextVersion();
        const discoverVersionChanged = discoverVersion !== lastDiscoverVersion;
        if (discoverVersionChanged) lastDiscoverVersion = discoverVersion;
        if (version !== lastVersion) {
          lastVersion = version;
          lastUpNextVersion = upNextVersion;
          lastWriteAt = Date.now();
          const liveChanges = readLiveChangesSince(lastChangeId);
          lastChangeId = Math.max(lastChangeId, liveChanges.cursor);
          // Include current sync state so the client knows whether a background
          // sync is active before it decides to act on the version change.
          writeEvent(res, { type: "history-version", version, discoverVersion, upNextVersion, changes: liveChanges.changes, ...syncEventFields(syncStatus) });
          return;
        }

        if (discoverVersionChanged) {
          lastWriteAt = Date.now();
          writeEvent(res, { type: "discover-version", discoverVersion, ...syncEventFields(syncStatus) });
          return;
        }

        if (upNextVersion !== lastUpNextVersion) {
          lastUpNextVersion = upNextVersion;
          lastWriteAt = Date.now();
          writeEvent(res, { type: "up-next-version", upNextVersion, ...syncEventFields(syncStatus) });
          return;
        }

        // No version bump — emit a sync-progress-only update if progress changed.
        if (syncProgressChanged) {
          writeEvent(res, {
            type: "sync-progress",
            total: syncStatus.total,
            completed: syncStatus.completed,
            active: syncStatus.active,
            label: syncStatus.label,
            ...syncEventFields(syncStatus),
          });
          return;
        }

        if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
          lastWriteAt = Date.now();
          res.write(": heartbeat\n\n");
        }
      })
      .catch(() => null)
      .finally(() => { pollInFlight = false; });
  }, POLL_MS);
  timer.unref?.();

  const close = () => clearInterval(timer);
  req.once("close", close);
  res.once("close", close);
}
