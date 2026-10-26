import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { writeAuditLog } from "../db.js";
import {
  getOnboardingState,
  saveOnboardingState,
  completeOnboarding,
  restartOnboarding,
  CURRENT_ONBOARDING_VERSION,
  trackerImportState,
} from "../utils/onboardingStore.js";
import { countTrackerItemStates, getTrackerConnection } from "../utils/trackerConnectionRepo.js";
import { countWatchHistoryRows, countWatchHistoryRowsBySource } from "../utils/dataRepo.js";
import { loadMediaConfig, publicMediaConfig, activeSyncOperation, loadRuntimeState } from "../utils/configStore.js";
import { tvdbBuiltInAvailable } from "../utils/tvdbGateway.js";
import { fanartBuiltInAvailable } from "../utils/fanartGateway.js";
import { startServerImport, cancelServerImport, startTrackerImport, cancelTrackerImport } from "../utils/onboardingImportCoordinator.js";
import { getTrackerAdapter, trackerProviderIds } from "../utils/trackers/registry.js";
import { armInitialSync } from '../utils/initialOutwardSync.js';
import { assertInitialImportsOpen } from '../utils/initialSyncStore.js';

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];

function serverSummary(provider, config) {
  const section = config[provider] || {};
  const connection = section.connection || null;
  return {
    provider,
    connected: Boolean(connection),
    status: connection?.status || (section.configured ? "saved" : "not_configured"),
    serverName: connection?.serverName || "",
    baseUrl: section.baseUrl || "",
    remoteUsername: connection?.remoteUsername || "",
    tested: Boolean(connection?.lastValidatedAt),
  };
}

// The first-run tracker step lists only trackers whose sync is switched on
// (the registry); a gated tracker joins automatically once it is enabled.
function trackerSummary(provider) {
  const connection = getTrackerConnection(provider);
  return {
    provider,
    label: getTrackerAdapter(provider).label || provider,
    connected: Boolean(connection && connection.status === "connected"),
    username: connection?.username || "",
    baselineComplete: Boolean(connection?.baselineComplete),
    preferEarlierWatchedDate: connection?.preferEarlierWatchedDate !== false,
    initialSync: connection?.initialSync || null,
  };
}

function checklistItems(state, { servers, trackers, tmdbConfigured, seerrConfigured, hasBackup, webhookAckCount }) {
  const items = [];
  if (!tmdbConfigured) items.push({ id: "connect_tmdb", label: "Connect TMDB", href: "/settings/metadata" });
  for (const server of servers) {
    if (server.connected && server.provider !== "plex" && !state.acknowledgements.webhooks?.[server.provider]) {
      items.push({ id: `webhooks_${server.provider}`, label: `Set up webhooks for ${server.serverName || server.provider}`, href: "/settings/webhooks" });
    }
    if (server.connected && state.backgroundImports.servers?.[server.provider]?.enabled === false) {
      items.push({ id: `import_${server.provider}`, label: `Import watched status from ${server.serverName || server.provider}`, href: "/settings/sync-tools" });
    }
  }
  if (!trackers.some((tracker) => tracker.connected) && (state.acknowledgements.trackersSkipped || ["overview", "claim", "trackers"].includes(state.currentStep))) {
    items.push({ id: "connect_tracker", label: "Connect a watch tracker", href: "/settings/import" });
  }
  if (!seerrConfigured) items.push({ id: "configure_seerr", label: "Configure Seerr", href: "/settings/seerr" });
  if (!hasBackup) items.push({ id: "create_backup", label: "Create an encrypted backup", href: "/settings/backups" });
  items.push({ id: "store_credential_key", label: "Store your credential-vault key somewhere safe", href: "/settings/backups", dismissible: true });
  void webhookAckCount;
  return items;
}

export async function handleSetupStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const state = getOnboardingState();
  const config = publicMediaConfig(await loadMediaConfig({ resolveConnections: false }));
  const servers = MEDIA_SERVERS.map((provider) => serverSummary(provider, config));
  const trackers = trackerProviderIds().map(trackerSummary);
  const watchHistoryCount = await countWatchHistoryRows();
  const runtime = await loadRuntimeState();

  const items = checklistItems(state, {
    servers,
    trackers,
    tmdbConfigured: Boolean(config.tmdb?.configured),
    seerrConfigured: Boolean(config.seerr?.configured),
    hasBackup: false,
  });

  // A background import's itemCount is otherwise only as fresh as its last
  // in-process update - which for Trakt's reconcile pass can be long between
  // writes (see onboardingImportCoordinator.js), and even the per-item media-
  // server counter is an in-memory value a process restart would lose.
  // Report what's actually on file for anything still "importing" instead,
  // so the UI shows real, moving progress rather than a stale number.
  const serverImportStates = state.backgroundImports.servers || {};
  const liveServers = Object.fromEntries(
    Object.entries(serverImportStates).map(([provider, importState]) => [
      provider,
      importState?.status === "importing"
        ? { ...importState, itemCount: countWatchHistoryRowsBySource(provider) }
        : importState,
    ]),
  );
  const backgroundImports = {
    ...state.backgroundImports,
    servers: liveServers,
    trackers: Object.fromEntries(trackers.map(({ provider }) => {
      const importState = trackerImportState(state, provider);
      return [provider, importState.status === "importing"
        ? { ...importState, itemCount: countTrackerItemStates(provider) }
        : importState];
    })),
  };

  return sendJson(res, {
    onboarding: {
      version: state.version,
      currentOnboardingVersion: CURRENT_ONBOARDING_VERSION,
      runState: state.runState,
      currentStep: state.currentStep,
      accountClaimed: state.accountClaimed,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      acknowledgements: state.acknowledgements,
      backgroundImports,
      pushSync: state.pushSync,
      checklistDismissedAt: state.checklistDismissedAt,
      ctaDismissedAt: state.ctaDismissedAt,
    },
    servers,
    trackers,
    metadata: {
      tmdbConfigured: Boolean(config.tmdb?.configured),
      builtInAvailable: { tvdb: tvdbBuiltInAvailable(), fanart: fanartBuiltInAvailable() },
    },
    seerr: {
      configured: Boolean(config.seerr?.configured),
    },
    options: {
      watchImportMode: config.tuning?.watchImportMode || null,
      plexHistoricalWatchedSync: config.tuning?.plexHistoricalWatchedSync?.value !== false,
      fastLocalPacing: config.pacing?.profile === "fast",
      upNextSync: config.upNextSync?.enabled !== false,
    },
    watchHistoryCount,
    pushSyncAvailable: watchHistoryCount > 0 && servers.some((s) => s.tested),
    syncLocked: Boolean(activeSyncOperation(runtime)),
    checklist: state.checklistDismissedAt ? [] : items,
  });
}

export async function handleSetupStep(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req).catch(() => ({}));
  if(body.startInitialSync===true) {
    const state=getOnboardingState();
    if(state.currentStep!=='imports'||state.runState!=='in_progress')return sendJson(res,{error:'Initial sync starts from Import & sync during setup',code:'INITIAL_SYNC_NOT_AVAILABLE'},409);
    await armInitialSync();
  }
  const patch = {};
  if (body.currentStep) patch.currentStep = String(body.currentStep).slice(0, 64);
  if (body.webhookAck && typeof body.webhookAck === "object") {
    const state = getOnboardingState();
    const provider = String(body.webhookAck.provider || "").trim();
    const method = String(body.webhookAck.method || "").trim();
    if (provider) {
      const acknowledgement = { acknowledgedAt: Date.now() };
      if (method === "plugin" || method === "webhook") acknowledgement.method = method;
      patch.acknowledgements = {
        ...state.acknowledgements,
        webhooks: { ...state.acknowledgements.webhooks, [provider]: acknowledgement },
      };
    }
  }
  if (body.trackersSkipped !== undefined) {
    const state = getOnboardingState();
    patch.acknowledgements = { ...(patch.acknowledgements || state.acknowledgements), trackersSkipped: Boolean(body.trackersSkipped) };
  }
  const next = saveOnboardingState(patch);
  return sendJson(res, { ok: true, onboarding: next });
}

export async function handleSetupImport(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  const principal = await requireAdmin(req, res);
  if (!principal) return;

  const body = await readJson(req).catch(() => ({}));
  const target = String(body.target || "").trim();
  const action = String(body.action || "").trim();
  if (!["start", "cancel"].includes(action)) return sendJson(res, { error: "action must be start or cancel", code: "VALIDATION_FAILED" }, 400);
  if(action==='start') {
    try {assertInitialImportsOpen();}
    catch(error) {return sendJson(res,{error:error.message,code:error.code},error.status);}
  }
  if(['netflix','tautulli'].includes(target)&&action==='cancel') {
    const state=getOnboardingState(),oneTime=state.backgroundImports.oneTime||{};
    saveOnboardingState({backgroundImports:{...state.backgroundImports,oneTime:Object.fromEntries(
      Object.entries(oneTime).map(([key,entry])=>[key,entry.source===target&&entry.status==='failed'?{...entry,enabled:false,status:'cancelled'}:entry]))}});
    return sendJson(res,{ok:true,cancelled:true});
  }

  if (trackerProviderIds().includes(target)) {
    let result;
    try {result=action==='start'?await startTrackerImport(target,{planId:body.planId,selectedIds:body.selectedIds}):cancelTrackerImport(target);}
    catch(error) {return sendJson(res,{error:error.message,code:error.code||'TRACKER_IMPORT_FAILED'},error.status||409);}
    writeAuditLog(`onboarding.import.${target}.${action}`, { ip: req.ip || req.socket?.remoteAddress });
    if (result?.code === "SYNC_LOCKED") return sendJson(res, { error: "A sync operation is already running.", code: "SYNC_LOCKED", retryable: true }, 409);
    if(result?.code==='RESTORE_ACTIVE')return sendJson(res,{error:'A restore is active. Review the import after it finishes',code:result.code},409);
    return sendJson(res, { ok: true, ...result });
  }
  if (MEDIA_SERVERS.includes(target)) {
    const result = action === "start" ? await startServerImport(target) : cancelServerImport(target);
    writeAuditLog(`onboarding.import.${target}.${action}`, { ip: req.ip || req.socket?.remoteAddress });
    if (result?.code === "SYNC_LOCKED") return sendJson(res, { error: "A sync operation is already running.", code: "SYNC_LOCKED", retryable: true }, 409);
    return sendJson(res, { ok: true, ...result });
  }
  return sendJson(res, { error: "target must be a media server or a tracker that can sync", code: "VALIDATION_FAILED", targets: [...MEDIA_SERVERS, ...trackerProviderIds()] }, 400);
}

// No media server is actually required to finish setup - manually marking
// titles watched from their movie/show page (POST /api/manual-watch),
// reached via search, works without one, so onboarding can't hard-require a
// connected server here. The Review step still nudges toward connecting
// one, since automatic sync is what most of the app's other features depend
// on, but it can't block completion.
export async function handleSetupComplete(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = completeOnboarding();
  writeAuditLog("onboarding.completed", { ip: req.ip || req.socket?.remoteAddress });
  return sendJson(res, { ok: true, onboarding: next });
}


export async function handleSetupRestart(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = restartOnboarding();
  writeAuditLog("onboarding.restarted", { ip: req.ip || req.socket?.remoteAddress });
  return sendJson(res, { ok: true, onboarding: next });
}

export async function handleSetupChecklistDismiss(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = saveOnboardingState({ checklistDismissedAt: Date.now() });
  return sendJson(res, { ok: true, onboarding: next });
}

// Permanently dismisses the sidebar "Complete onboarding" entry point. Unlike
// the checklist dismiss above (which only hides the dashboard task card),
// this is the sidebar-wide reminder shown while setup isn't finished -
// restartOnboarding() clears this flag if onboarding is ever restarted.
export async function handleSetupCtaDismiss(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;

  const next = saveOnboardingState({ ctaDismissedAt: Date.now() });
  return sendJson(res, { ok: true, onboarding: next });
}
