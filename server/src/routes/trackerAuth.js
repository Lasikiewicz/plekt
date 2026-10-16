import { isSameOriginBrowserRequest, requireAdmin } from "../utils/auth.js";
import { writeAuditLog } from "../db.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import { createTrackerAuthFlow, deleteTrackerConnection, getTrackerAuthFlow, getTrackerConnection, listTrackerConnections, markTrackerAuthFlow, saveTrackerConnection } from "../utils/trackerConnectionRepo.js";
import { getTraktUser, pollTraktDeviceAuth, startTraktDeviceAuth } from "../utils/traktClient.js";
import { pollConnectedTrackers } from "../utils/trackerSync.js";
import { traktTokenExpiry, withFreshTraktConnection } from "../utils/trackerDispatcher.js";
import { getTraktAppConfig, hydrateTraktAppCredentials, resolveTraktAppCredentials } from "../utils/traktAppConfig.js";
import { isAuthoritativeRestoreActive } from "../utils/configStore.js";

function requireBrowserAdmin(req, res, principal) {
  if (principal.via !== "session") { sendJson(res, { error: "An administrator browser session is required" }, 403); return null; }
  if (!isSameOriginBrowserRequest(req)) { sendJson(res, { error: "Same-origin request required" }, 403); return null; }
  return principal;
}

export async function handleTrackerAuth(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !requireBrowserAdmin(req, res, principal)) return;
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
  if (!flow) return sendJson(res, { error: "Authentication flow not found" }, 404);
  if (flow.expiresAt <= Date.now() || flow.status === "expired") {
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
  const connection = saveTrackerConnection({
    provider: "trakt", clientId: flow.clientId, clientSecret: flow.clientSecret,
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessTokenExpiresAt: traktTokenExpiry(tokens),
    remoteUserId: user.ids?.slug || user.ids?.uuid || user.username || "trakt-user", remoteUsername: user.username || user.name || "Trakt user",
    initialSyncMode: flow.initialSyncMode, preferEarlierWatchedDate: flow.preferEarlierWatchedDate, baselineComplete: false, lastValidatedAt: Date.now(),
  });
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
      providers: { trakt: { appConfigured: app.configured, configurationIncomplete: app.incomplete, personalAppSupported: true } },
    });
  }
  if (path !== "tracker-connections/trakt") return sendJson(res, { error: "Not found" }, 404);
  if (req.method === "DELETE") {
    const removed = deleteTrackerConnection("trakt");
    writeAuditLog("tracker-auth.trakt.disconnected", { ip: req.ip || req.socket?.remoteAddress, detail: { removed } });
    return sendJson(res, { ok: true, removed, guidance: "Plekt deleted its encrypted Trakt credentials. You can also revoke the app in Trakt's connected-app settings." });
  }
  if (req.method === "POST") {
    if (isAuthoritativeRestoreActive()) {
      return sendJson(res, { ok: false, code: "RESTORE_ACTIVE", error: "An authoritative watch-history restore is active; Trakt import is paused until it completes." }, 409);
    }
    const connection = await withFreshTraktConnection();
    if (!connection) return sendJson(res, { error: "Trakt is not connected" }, 409);
    const result = await pollConnectedTrackers({ reconcile: true });
    return sendJson(res, { ok: true, result, connection: getTrackerConnection("trakt") });
  }
  return methodNotAllowed(res);
}
