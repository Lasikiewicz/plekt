// Coordinates the safe, additive background pulls onboarding offers per
// connected server and per connected tracker. Deliberately reuses already-
// tested sync code rather than any new watched-item ingestion path:
//   - Per-server pulls call forceSyncLibraryState({ mode: "pull", source })
//     (server/src/utils/libraryForceSync.js) - the same "Import Watched
//     Status" pull already offered from Settings -> Sync -> Force Sync.
//   - Each tracker's baseline snapshot calls pollConnectedTrackers({
//     reconcile, provider }) (server/src/utils/trackerSync.js) - the same
//     first-sync path the regular poll cycle uses once a connection's
//     baselineComplete is false.
// Both are read-only pulls into Plembfin's local watch_history - neither
// pushes anything outward - so, unlike the global "force_sync" operation
// lock, running several of these at once (e.g. Plex and Jellyfin together)
// is safe. Each import still checks activeSyncOperation() first and refuses
// to start while an unrelated push/scheduled sync is actively running, since
// forceSyncLibraryState() shares the same outbound client/rate-limit state.
import { forceSyncLibraryState } from "./libraryForceSync.js";
import { pollConnectedTrackers } from "./trackerSync.js";
import { activeSyncOperation, isAuthoritativeRestoreActive, loadRuntimeState, SYNC_OPERATION_SCHEDULED } from "./configStore.js";
import { countTrackerItemStates, getTrackerConnection } from "./trackerConnectionRepo.js";
import { compareTrackerWithPlekt, startTrackerFullSync } from './trackers/fullSync.js';
import { getOnboardingState, saveOnboardingState, trackerImportState } from "./onboardingStore.js";
import { assertTrackerEnabled } from "./trackers/registry.js";

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const cancelTokens = new Map();

function patchServerImport(provider, patch) {
  const state = getOnboardingState();
  const servers = { ...state.backgroundImports.servers, [provider]: { ...(state.backgroundImports.servers[provider] || {}), ...patch } };
  return saveOnboardingState({ backgroundImports: { ...state.backgroundImports, servers } });
}

function patchTrackerImport(provider, patch) {
  const state = getOnboardingState();
  const trackers = { ...state.backgroundImports.trackers, [provider]: { ...trackerImportState(state, provider), ...patch } };
  return saveOnboardingState({ backgroundImports: { ...state.backgroundImports, trackers } });
}

// Media-server pulls wait while any tracker the user chose to import is still
// importing, up to one shared cap measured from when that pull first waited.
export function trackerGateDecision(state, waitStartedAt, now = Date.now()) {
  const importing = Object.entries(state.backgroundImports.trackers || {})
    .filter(([, entry]) => entry?.enabled !== false && entry?.status === "importing")
    .map(([provider]) => provider);
  return { importing, wait: importing.length > 0 && now - waitStartedAt < TRACKER_WAIT_MAX_MS };
}

// The routine per-minute scheduled sync tick shares outbound client/rate-
// limit state with forceSyncLibraryState (see the module comment), so a pull
// intentionally refuses to start while one is actively running - unlike the
// Trakt reconcile above, that guard cannot simply be exempted here. A tick is
// budgeted at 45s and recurs every ~60s, so it clears on its own quickly.
const SCHEDULED_LOCK_RETRY_DELAY_MS = 5_000;
const SCHEDULED_LOCK_MAX_WAIT_MS = 120_000;
// Trackers connect (and their reconcile passes run) before the media servers
// specifically so their watch dates can take priority once the servers pull -
// see loadTraktWatchedDateIndex in mediaForceSync.js. A reconcile can
// legitimately run for many minutes on a large account, far longer than the
// scheduled-sync wait above covers, so it gets its own much longer cap. All
// connected trackers import in parallel and share this one cap (docs/
// decisions.md): per-tracker caps would leave a three-tracker first run
// showing "Importing" for 90 minutes.
const TRACKER_WAIT_RETRY_DELAY_MS = 5_000;
const TRACKER_WAIT_MAX_MS = 30 * 60_000;
const RESTORE_RETRY_DELAY_MS = 5_000;

// This wait is deliberately server-side, not something the caller polls for
// and re-triggers itself: onboarding previously queued this from the browser
// tab's own JS timer, which silently evaporated on any page reload or
// navigation, leaving the UI showing "Importing" with nothing actually
// running behind it. Retrying via a real server-side timer survives that.
export async function startServerImport(provider, { lockWaitStartedAt = Date.now(), trackerWaitStartedAt = Date.now() } = {}) {
  if (!MEDIA_SERVERS.includes(provider)) throw new Error("Unsupported provider");
  if (getOnboardingState().runState === "completed") return { started: false, code: "ONBOARDING_COMPLETE" };
  const waitToken = cancelTokens.get(`server:${provider}`) || { cancelled: false };
  cancelTokens.set(`server:${provider}`, waitToken);
  if (waitToken.cancelled) return { started: false, code: "CANCELLED" };

  if (isAuthoritativeRestoreActive()) {
    patchServerImport(provider, { enabled: true, status: "importing", error: null });
    setTimeout(() => {
      if (waitToken.cancelled) return;
      startServerImport(provider, { lockWaitStartedAt, trackerWaitStartedAt }).catch(() => {});
    }, RESTORE_RETRY_DELAY_MS);
    return { started: false, code: "RESTORE_ACTIVE_RETRYING" };
  }

  const trackerGate = trackerGateDecision(getOnboardingState(), trackerWaitStartedAt);
  if (trackerGate.importing.length) {
    if (trackerGate.wait) {
      patchServerImport(provider, { enabled: true, status: "importing", error: null });
      setTimeout(() => {
        if (waitToken.cancelled) return;
        startServerImport(provider, { lockWaitStartedAt, trackerWaitStartedAt }).catch(() => {});
      }, TRACKER_WAIT_RETRY_DELAY_MS);
      return { started: false, code: "TRACKER_IMPORTING_RETRYING" };
    }
    // After 30 minutes in total, however many trackers are still importing,
    // stop waiting and proceed anyway - each tracker's own poll cycle
    // continues its reconcile regardless, and this server's watched dates are
    // still better than none.
  }

  const runtime = await loadRuntimeState();
  if (activeSyncOperation(runtime)) {
    if (Date.now() - lockWaitStartedAt < SCHEDULED_LOCK_MAX_WAIT_MS) {
      patchServerImport(provider, { enabled: true, status: "importing", error: null });
      setTimeout(() => {
        if (waitToken.cancelled) return;
        startServerImport(provider, { lockWaitStartedAt, trackerWaitStartedAt }).catch(() => {});
      }, SCHEDULED_LOCK_RETRY_DELAY_MS);
      return { started: false, code: "SYNC_LOCKED_RETRYING" };
    }
    cancelTokens.delete(`server:${provider}`);
    patchServerImport(provider, { enabled: true, status: "failed", error: "A sync operation is already running. Retry once it finishes." });
    return { started: false, code: "SYNC_LOCKED" };
  }

  const token = waitToken;
  patchServerImport(provider, { enabled: true, status: "importing", startedAt: Date.now(), completedAt: null, itemCount: 0, error: null });

  let itemCount = 0;
  forceSyncLibraryState(
    { mode: "pull", source: provider },
    {
      logger: (message) => {
        if (message.includes("started for all media") || message.includes("Cancellation acknowledged")) return;
        itemCount += 1;
        patchServerImport(provider, { itemCount });
      },
      isCancelled: () => token.cancelled,
    },
  )
    .then((result) => {
      if (token.cancelled) {
        patchServerImport(provider, {
          status: "cancelled",
          completedAt: Date.now(),
          itemCount: Array.isArray(result?.results) ? result.results.length : itemCount,
        });
        return;
      }
      if (result?.cancelled === true || isAuthoritativeRestoreActive()) {
        patchServerImport(provider, { enabled: true, status: "importing", completedAt: null, error: null });
        setTimeout(() => {
          if (token.cancelled) return;
          startServerImport(provider, { lockWaitStartedAt, trackerWaitStartedAt }).catch(() => {});
        }, RESTORE_RETRY_DELAY_MS);
        return;
      }
      patchServerImport(provider, {
        status: "complete",
        completedAt: Date.now(),
        itemCount: Array.isArray(result?.results) ? result.results.length : itemCount,
      });
    })
    .catch((error) => {
      patchServerImport(provider, { status: "failed", completedAt: Date.now(), error: error.message || String(error) });
    })
    .finally(() => {
      cancelTokens.delete(`server:${provider}`);
    });

  return { started: true };
}

export function cancelServerImport(provider) {
  const token = cancelTokens.get(`server:${provider}`);
  if (token) token.cancelled = true;
  patchServerImport(provider, { enabled: false, status: "cancelled", completedAt: Date.now() });
  return { cancelled: true };
}

// A connection's very first poll only establishes a baseline reference point
// - the reconcile pass inside pollTrackerPass (trackerSync.js) is gated
// behind the connection's baselineComplete flag already being true *before*
// that call starts, so the very first call always imports nothing no matter
// what options it's given, then flips the flag true at the end. A real watch-
// history backfill needs at least one more pass after that, now genuinely
// walking the full snapshot against local state. Loop until a pass applies
// zero further watched transitions so "complete" means the backlog is
// actually caught up, not just that the fast baseline handshake finished -
// a large account's snapshot can need several passes. The loop, its pass
// counter and its item count are per provider: one tracker settling must not
// end another's import, and a settled tracker must not keep re-polling.
const MAX_TRACKER_RECONCILE_PASSES = 25;
export async function reconcileTrackerUntilSettled(provider, {
  poll = pollConnectedTrackers,
  count = countTrackerItemStates,
  report = (itemCount) => patchTrackerImport(provider, { itemCount }),
} = {}) {
  let passes = 0;
  for (let pass = 0; pass < MAX_TRACKER_RECONCILE_PASSES; pass++) {
    if (isAuthoritativeRestoreActive()) {
      throw Object.assign(new Error("An authoritative watch-history restore is active; the tracker import is paused."), { code: "RESTORE_ACTIVE" });
    }
    const result = await poll({ reconcile: true, provider });
    passes += 1;
    // See the identical note where this is called - report what's actually
    // on file, not an in-memory accumulator a restart could lose.
    report(count(provider));
    if (pass > 0 && !result?.watched) break;
  }
  return { passes };
}

export function pauseTrackerImportForRestore(provider) {
  // An in-flight pass can encounter the restore after the user opted out.
  // Preserve that newer choice instead of re-enabling its onboarding gate.
  const entry = trackerImportState(getOnboardingState(), provider);
  if (entry.enabled === false) return false;
  patchTrackerImport(provider, { enabled: true, status: "preview_required", error: 'Restore interrupted the import; review a fresh preview before continuing' });
  return true;
}

export async function startTrackerImport(provider, {planId,selectedIds}={}) {
  // Only trackers whose sync is switched on can import; a gated tracker
  // throws here and is rejected as unsupported.
  assertTrackerEnabled(provider);
  if (getOnboardingState().runState === "completed") return { started: false, code: "ONBOARDING_COMPLETE" };
  if (isAuthoritativeRestoreActive()) {
    return { started: false, code: "RESTORE_ACTIVE" };
  }
  const runtime = await loadRuntimeState();
  const activeOperation = activeSyncOperation(runtime);
  // Unlike the per-server pulls above, pollConnectedTrackers only talks to
  // the tracker's own API - it shares no outbound client/rate-limit state
  // with Plex/Emby/Jellyfin (or with other trackers), and already coalesces
  // concurrent calls per provider itself (trackers/polling.js). So the
  // routine per-minute scheduled sync tick - which reliably recurs every 60s
  // and can otherwise permanently starve this of a clear window - isn't
  // treated as a conflict; only a genuinely unrelated operation (force sync,
  // rebuild, restore) still blocks.
  if (activeOperation && activeOperation.kind !== SYNC_OPERATION_SCHEDULED) {
    patchTrackerImport(provider, { enabled: true, status: "failed", error: "A sync operation is already running. Retry once it finishes." });
    return { started: false, code: "SYNC_LOCKED" };
  }
  if(!getTrackerConnection(provider)?.baselineComplete)await pollConnectedTrackers({provider,reconcile:false,trigger:'user'});
  if(!planId) {
    // Setup's explicit "Import watch history" choice authorizes the initial
    // import. Keep the comparison plan and all freshness/backup guards, while
    // selecting every eligible missing watch automatically for this first run.
    const fullSync=await compareTrackerWithPlekt(provider);
    selectedIds=fullSync.preview.items.filter(row=>row.selectable&&row.side==='plekt').map(row=>row.id);
    planId=fullSync.preview.id;
    if(!selectedIds.length) {
      patchTrackerImport(provider,{enabled:true,status:'complete',itemCount:0,completedAt:Date.now(),error:null});
      return {started:false,code:'NOTHING_TO_IMPORT',fullSync};
    }
  }
  const run=await startTrackerFullSync(provider,'import',{planId,selectedIds,isCancelled:()=>trackerImportState(getOnboardingState(),provider).enabled===false});
  patchTrackerImport(provider, { enabled: true, status: "importing", startedAt: Date.now(), completedAt: null, itemCount: null, error: null });
  run.promise
    .then(() => {
      // Report the count actually on file rather than the in-memory total
      // accumulated across this run's passes - a dev-server restart (or any
      // process restart) mid-import abandons that in-flight promise before
      // it ever reaches here, and whatever value a *previous*, unrelated
      // completion left behind would otherwise stand uncorrected forever.
      const state=getTrackerConnection(provider)?.fullSync;
      patchTrackerImport(provider, { status: ['failed','partial'].includes(state?.status)?'failed':'complete', completedAt: Date.now(), itemCount: state?.imported||0,error:state?.error||(state?.status==='partial'?'Some destinations were not confirmed. Review Sync Activity':null),backup:state?.backup||null });
    })
    .catch((error) => {
      if (error?.code === "RESTORE_ACTIVE" || isAuthoritativeRestoreActive()) {
        pauseTrackerImportForRestore(provider);
        return;
      }
      patchTrackerImport(provider, { status: "failed", completedAt: Date.now(), error: error.message || String(error) });
    });

  return { started: true,fullSync:run.state };
}

export function cancelTrackerImport(provider) {
  assertTrackerEnabled(provider);
  // The baseline snapshot has no mid-flight cancel hook; unchecking the box
  // just stops onboarding from waiting on/reporting it. The tracker's regular
  // poll cycle still owns baselineComplete and continues in the background.
  patchTrackerImport(provider, { enabled: false });
  return { cancelled: true };
}
