import { isSameOriginBrowserRequest, requireAdmin } from "../utils/auth.js";
import { writeAuditLog } from "../db.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import { createTrackerAuthFlow, deleteTrackerConnection, getTrackerAuthFlow, getTrackerConnection, listTrackerConnections, markTrackerAuthFlow, saveTrackerConnection, updateTrackerConnectionStatus } from "../utils/trackerConnectionRepo.js";
import { getTraktUser, pollTraktDeviceAuth, startTraktDeviceAuth } from "../utils/traktClient.js";
import { pollConnectedTrackers } from "../utils/trackerSync.js";
import { traktTokenExpiry } from "../utils/trackerDispatcher.js";
import { getTraktAppConfig, hydrateTraktAppCredentials, resolveTraktAppCredentials } from "../utils/traktAppConfig.js";
import { isAuthoritativeRestoreActive } from "../utils/configStore.js";
import { assertTrackerEnabled, getTrackerAdapter, isTrackerProvider, trackerProviderIds } from "../utils/trackers/registry.js";
import { freshTrackerConnection } from "../utils/trackers/connections.js";
import { handleSimklAuth } from "./simklAuth.js";
import { compareTrackerWithPlekt, getTrackerFullSync, startTrackerFullSync, trackerFullSyncDirections } from "../utils/trackers/fullSync.js";
import { isTrackerAuthProvider } from "../utils/trackers/authProviders.js";
import { cancelSimklFullSync, kickSimklFullSyncRuns } from "../utils/trackers/simklFullSyncRunner.js";

const fullSyncError = (res, error) => {
  if (!error.code) throw error;
  return sendJson(res, { error: error.message, code: error.code }, error.status || 409);
};

async function handleFullSync(req, res, provider, compare) {
  try {
    if (compare) {
      if (req.method !== "POST") return methodNotAllowed(res);
      return sendJson(res, { fullSync: await compareTrackerWithPlekt(provider) });
    }
    if (req.method === "GET") return sendJson(res, { fullSync: getTrackerFullSync(provider) });
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    if (body.action === "cancel") {
      if (provider !== "simkl") return sendJson(res, { error: "Only a paced Simkl full sync can be cancelled", code: "FULL_SYNC_NOT_RUNNING" }, 409);
      const fullSync = cancelSimklFullSync(body.runId ? String(body.runId) : "");
      writeAuditLog(`tracker-full-sync.${provider}.cancelled`, { ip: req.ip || req.socket?.remoteAddress, detail: { runId: fullSync?.runId || null } });
      return sendJson(res, { fullSync });
    }
    const { state, pacedRunId } = await startTrackerFullSync(provider, String(body.direction || ""),{planId:body.planId,selectedIds:body.selectedIds});
    writeAuditLog(`tracker-full-sync.${provider}.started`, { ip: req.ip || req.socket?.remoteAddress, detail: { direction: state.direction, pacedRunId: pacedRunId || null } });
    if (pacedRunId) void kickSimklFullSyncRuns().catch((error) => console.warn("Simkl paced full sync failed to start", error.message));
    return sendJson(res, { fullSync: getTrackerFullSync(provider) || state }, 202);
  } catch (error) { return fullSyncError(res, error); }
}

// The date preference is a per-connection setting, editable at any time.
async function updateConnectionSettings(req, res, provider) {
  const body = await readJson(req);
  if (typeof body.preferEarlierWatchedDate !== "boolean") return sendJson(res, { error: "preferEarlierWatchedDate must be true or false" }, 400);
  if (!updateTrackerConnectionStatus(provider, { preferEarlierWatchedDate: body.preferEarlierWatchedDate })) return sendJson(res, { error: "Tracker is not connected" }, 409);
  return sendJson(res, { ok: true, connection: getTrackerConnection(provider) });
}

function requireBrowserAdmin(req, res, principal) {
  if (principal.via !== "session") { sendJson(res, { error: "An administrator browser session is required" }, 403); return null; }
  if (!isSameOriginBrowserRequest(req)) { sendJson(res, { error: "Same-origin request required" }, 403); return null; }
  return principal;
}

export async function handleTrackerAuth(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !requireBrowserAdmin(req, res, principal)) return;
  const provider = path.split("/")[1]?.toLowerCase();
  if (provider === "simkl") return handleSimklAuth(req, res, path);
  if (!isTrackerProvider(provider)) return sendJson(res, { error: "Unsupported tracker provider" }, 404);
  try { assertTrackerEnabled(provider); }
  catch (error) { return sendJson(res, { error: error.message, code: error.code }, 409); }
  if (path === "tracker-auth/trakt/start") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    let credentials;
    try { credentials = resolveTraktAppCredentials(body); }
    catch (error) { return sendJson(res, { error: error.message }, 400); }
    const { clientId, clientSecret, source } = credentials;
    const device = await startTraktDeviceAuth(clientId);
    const flow = createTrackerAuthFlow({
      provider: "trakt", clientId: source === "server" ? "" : clientId, clientSecret: source === "server" ? "" : clientSecret,
      deviceCode: device.device_code, userCode: device.user_code,
      verificationUrl: device.verification_url || "https://auth.trakt.tv/activate", intervalSeconds: device.interval,
      expiresAt: Date.now() + Number(device.expires_in || 600) * 1000, initialSyncMode: body.initialSyncMode,
      preferEarlierWatchedDate: body.preferEarlierWatchedDate,
    });
    writeAuditLog("tracker-auth.trakt.started", { ip: req.ip || req.socket?.remoteAddress, detail: { flowId: flow.id } });
    return sendJson(res, { flowId: flow.id, userCode: flow.userCode, verificationUrl: flow.verificationUrl, intervalSeconds: flow.intervalSeconds, expiresAt: flow.expiresAt });
  }

  const match = path.match(/^tracker-auth\/trakt\/([a-f\d-]+)\/status$/i);
  if (!match) return sendJson(res, { error: "Not found" }, 404);
  if (req.method !== "GET") return methodNotAllowed(res);
  const flow = getTrackerAuthFlow(match[1], { includeCredentials: true });
  if (!flow || flow.provider !== provider) return sendJson(res, { error: "Authentication flow not found" }, 404);
  if (flow.expiresAt <= Date.now() || flow.status === "expired" || (flow.status === "pending" && flow.expectedConnectionId == null)) {
    markTrackerAuthFlow(flow.id, "expired");
    return sendJson(res, { status: "expired" }, 410);
  }
  if (flow.status === "completed") return sendJson(res, { status: "completed", connection: getTrackerConnection("trakt") });
  if (flow.lastPolledAt && Date.now() - flow.lastPolledAt < flow.intervalSeconds * 1000 - 250) return sendJson(res, { status: "pending", retryAfter: flow.intervalSeconds }, 202);
  markTrackerAuthFlow(flow.id, "pending");
  let tokens;
  try {
    tokens = await pollTraktDeviceAuth(hydrateTraktAppCredentials(flow));
  } catch (error) {
    if (error.status === 400 || error.status === 429) return sendJson(res, { status: "pending", retryAfter: Math.max(flow.intervalSeconds, error.retryAfter || 0) }, 202);
    if (error.status === 410) { markTrackerAuthFlow(flow.id, "expired"); return sendJson(res, { status: "expired" }, 410); }
    if (error.status === 418) { markTrackerAuthFlow(flow.id, "denied"); return sendJson(res, { status: "denied" }, 403); }
    throw error;
  }
  const appCredentials = hydrateTraktAppCredentials(flow);
  const tokenRecord = { clientId: appCredentials.clientId, accessToken: tokens.access_token };
  const settings = await getTraktUser(tokenRecord);
  const user = settings.user || settings;
  let connection;
  try {
    connection = saveTrackerConnection({
    provider: "trakt", expectedConnectionId: flow.expectedConnectionId, clientId: flow.clientId, clientSecret: flow.clientSecret,
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessTokenExpiresAt: traktTokenExpiry(tokens),
    remoteUserId: user.ids?.slug || user.ids?.uuid || user.username || "trakt-user", remoteUsername: user.username || user.name || "Trakt user",
    initialSyncMode: 'baseline', preferEarlierWatchedDate: flow.preferEarlierWatchedDate, baselineComplete: false, lastValidatedAt: Date.now(),
    });
  } catch (error) {
    if (!error.stale) throw error;
    // The connection changed after this sign-in began; never overwrite it.
    markTrackerAuthFlow(flow.id, "expired");
    return sendJson(res, { status: "expired", error: "The Trakt connection changed while this sign-in was waiting. Start the sign-in again." }, 409);
  }
  markTrackerAuthFlow(flow.id, "completed");
  writeAuditLog("tracker-auth.trakt.connected", { ip: req.ip || req.socket?.remoteAddress, detail: { connectionId: connection.id, remoteUserId: connection.remoteUserId } });
  return sendJson(res, { status: "completed", connection });
}

export async function handleTrackerConnections(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !requireBrowserAdmin(req, res, principal)) return;
  if (path === "tracker-connections") {
    if (req.method !== "GET") return methodNotAllowed(res);
    const app = getTraktAppConfig();
    return sendJson(res, {
      connections: listTrackerConnections(),
      providers: Object.fromEntries(trackerProviderIds().map((provider) => [provider, {
        label: getTrackerAdapter(provider).label, fullSyncDirections: trackerFullSyncDirections(provider),
        ...(provider === "trakt" ? { appConfigured: app.configured, configurationIncomplete: app.incomplete, personalAppSupported: true } : { appConfigured: false, personalAppSupported: false }),
      }])),
    });
  }
  const [, rawProvider, section, action] = path.split("/");
  const provider = rawProvider?.toLowerCase();
  if (!isTrackerAuthProvider(provider)) return sendJson(res, { error: "Unsupported tracker provider" }, 404);
  if (section === "full-sync") return handleFullSync(req, res, provider, action === "compare");
  if (req.method === "PATCH") return updateConnectionSettings(req, res, provider);
  if (!isTrackerProvider(provider)) return sendJson(res, { error: "Unsupported tracker provider" }, 404);
  try { assertTrackerEnabled(provider); }
  catch (error) { return sendJson(res, { error: error.message, code: error.code }, 409); }
  const label = getTrackerAdapter(provider).label;
  if (req.method === "GET") return sendJson(res, { connection: getTrackerConnection(provider) });
  if (req.method === "DELETE") {
    const removed = deleteTrackerConnection(provider);
    writeAuditLog(`tracker-auth.${provider}.disconnected`, { ip: req.ip || req.socket?.remoteAddress, detail: { removed } });
    return sendJson(res, { ok: true, removed, guidance: `Plekt deleted its encrypted ${label} credentials. You can also revoke the app in ${label}'s connected-app settings.` });
  }
  if (req.method === "POST") {
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: `An authoritative watch-history restore is active; ${label} import is paused until it completes.` }, 409);
    }
    const connection = await freshTrackerConnection(provider);
    if (!connection) return sendJson(res, { error: `${label} is not connected` }, 409);
    // Simkl's Check now fetches remote changes only. Importing its whole
    // history is the confirmed full sync's job, never a side effect of a check.
    const result = await pollConnectedTrackers({ provider, reconcile: false, trigger: "user" });
    return sendJson(res, { ok: true, result, connection: getTrackerConnection(provider) });
  }
  return methodNotAllowed(res);
}
