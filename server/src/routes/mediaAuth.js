import crypto from "node:crypto";
import { isSameOriginBrowserRequest, requireAdmin } from "../utils/auth.js";
import { db, writeAuditLog } from "../db.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import { disableStoredLegacyCredential, loadMediaConfig, mediaAccountAuthEnabled } from "../utils/configStore.js";
import { assertSafeOutboundUrl, fetchWithTimeout } from "../utils/outbound.js";
import { authoriseAuthFlow, completeAuthFlow, createAuthFlow, disableMediaConnection, getActiveAuthDevice, getAuthFlow, getMediaConnection, getOrCreateAuthDevice, getOrCreatePlexAuthDevice, getPlexLegacyAuthDevice, getPlexPrivateKey, getReusableAuthorisedAuthFlow, saveMediaConnection } from "../utils/mediaConnectionRepo.js";
import { createPlexPin, plexAuthUrl, plexClientHeaders, plexTokenExpiresAt, pollPlexPin } from "../utils/plexAuth.js";
import { authenticateEmbyLike, initiateJellyfinQuickConnect, jellyfinQuickConnectEnabled, logoutEmbyLike, pollJellyfinQuickConnect } from "../utils/embyLikeAuth.js";

function requestFingerprint(req) {
  return crypto.createHash("sha256").update(String(req.cookies?.plembfin_session || "")).digest("base64url");
}

async function requireMediaAuthAdmin(req, res, principal) {
  if (!mediaAccountAuthEnabled()) { sendJson(res, { error: "Media account authentication is disabled" }, 404); return null; }
  if (principal.via !== "session") { sendJson(res, { error: "An administrator browser session is required" }, 403); return null; }
  if (!isSameOriginBrowserRequest(req)) { sendJson(res, { error: "Same-origin request required" }, 403); return null; }
  return principal;
}

async function plexAccount(device, token) {
  const response = await fetchWithTimeout("https://plex.tv/api/v2/user", { headers: plexClientHeaders(device, { token }) });
  if (!response.ok) throw Object.assign(new Error(`Plex account verification failed with HTTP ${response.status}`), { status: 502 });
  const body = await response.json();
  const id = String(body.id || body.uuid || "");
  if (!id) throw new Error("Plex account response did not contain a stable user ID");
  return { id, username: String(body.username || body.friendlyName || body.title || "") };
}

async function plexResources(device, token) {
  const response = await fetchWithTimeout("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", { headers: plexClientHeaders(device, { token }) });
  if (!response.ok) throw Object.assign(new Error(`Plex server discovery failed with HTTP ${response.status}`), { status: 502 });
  const body = await response.json();
  const resources = Array.isArray(body) ? body : body?.MediaContainer?.Device || [];
  return resources.filter((item) => item.product === "Plex Media Server" || String(item.provides || "").split(",").includes("server"));
}

function publicServers(resources) {
  return resources.map((server) => ({ machineIdentifier: String(server.clientIdentifier || server.machineIdentifier || ""), name: String(server.name || "Plex Media Server"), owned: Boolean(server.owned) })).filter((server) => server.machineIdentifier);
}

function connectionUris(server) {
  const connections = server.connections || server.Connection || [];
  return connections.map((item) => String(item.uri || "")).filter(Boolean).sort((a, b) => {
    const rank = (uri) => (uri.startsWith("https:") ? 0 : 1);
    return rank(a) - rank(b);
  });
}

async function verifyPlexServer(server, token) {
  const expected = String(server.clientIdentifier || server.machineIdentifier || "");
  let lastError = new Error("Plex server has no usable connection URI");
  for (const uri of connectionUris(server)) {
    try {
      const baseUrl = assertSafeOutboundUrl(uri, { label: "Plex server URL" }).toString().replace(/\/$/, "");
      const response = await fetchWithTimeout(`${baseUrl}/identity`, { headers: { Accept: "application/json", "X-Plex-Token": token } });
      if (!response.ok) { lastError = new Error(`Plex identity check failed with HTTP ${response.status}`); continue; }
      const body = await response.json();
      const actual = String(body?.MediaContainer?.machineIdentifier || body?.machineIdentifier || "");
      if (actual !== expected) { lastError = new Error("Plex server identity did not match the selected machine"); continue; }
      return { baseUrl, serverId: actual, serverName: String(server.name || "Plex Media Server") };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function handlePlexAuth(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !(await requireMediaAuthAdmin(req, res, principal))) return;
  const fingerprint = requestFingerprint(req);
  if (path === "media-auth/plex/start") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const reusable = getReusableAuthorisedAuthFlow("plex", fingerprint);
    if (reusable) {
      writeAuditLog("media-auth.plex.resumed", { ip: req.ip || req.socket?.remoteAddress, detail: { flowId: reusable.id } });
      return sendJson(res, { flowId: reusable.id, status: "authorised", resumed: true, expiresAt: reusable.expiresAt });
    }
    const config = await loadMediaConfig({ resolveConnections: false });
    // app.plex.tv/auth requires a strong, long-form PIN. Omitting the JWK keeps
    // the returned account credential in Plex's opaque-token format, which is
    // accepted by both older and newer Plex Media Server releases. A weak
    // four-character PIN is only valid for the manual plex.tv/link page and is
    // rejected by the hosted auth app after the user clicks Sign In.
    const device = getPlexLegacyAuthDevice();
    const pin = await createPlexPin(device, { strong: true, includeJwk: false, originUrl: config.publicBaseUrl });
    const flow = createAuthFlow({ provider: "plex", authDeviceId: device.id, remoteFlowId: pin.id, secret: pin.code, flowKind: "plex_legacy_pin", adminSessionFingerprint: fingerprint, expiresAt: pin.expiresAt });
    writeAuditLog("media-auth.plex.started", { ip: req.ip || req.socket?.remoteAddress, detail: { flowId: flow.id } });
    return sendJson(res, { flowId: flow.id, authUrl: plexAuthUrl({ device, code: pin.code, publicBaseUrl: config.publicBaseUrl }), expiresAt: pin.expiresAt });
  }

  const match = path.match(/^media-auth\/plex\/([a-f\d-]+)\/(status|server)$/i);
  if (!match) return sendJson(res, { error: "Not found" }, 404);
  const [, flowId, action] = match;
  const flow = getAuthFlow(flowId, fingerprint);
  if (!flow) return sendJson(res, { error: "Authentication flow not found" }, 404);
  if (flow.status === "expired") return sendJson(res, { status: "expired" }, 410);

  if (action === "status") {
    if (req.method !== "GET") return methodNotAllowed(res);
    const strong = flow.flowKind !== "plex_legacy_pin";
    const device = strong ? getOrCreatePlexAuthDevice() : getPlexLegacyAuthDevice();
    let token = flow.status === "authorised" ? flow.secret : "";
    if (!token) {
      const result = await pollPlexPin({ device, privateKey: strong ? getPlexPrivateKey() : null, pinId: flow.remoteFlowId, strong });
      if (!result.authorised) return sendJson(res, { status: "pending", expiresAt: flow.expiresAt });
      token = result.token;
      if (!authoriseAuthFlow(flow.id, fingerprint, token)) return sendJson(res, { error: "Authentication flow could not be authorised" }, 409);
    }
    const [account, resources] = await Promise.all([plexAccount(device, token), plexResources(device, token)]);
    return sendJson(res, { status: "authorised", account: { id: account.id, username: account.username }, servers: publicServers(resources) });
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  if (flow.status !== "authorised") return sendJson(res, { error: "Plex authentication is not complete" }, 409);
  const body = await readJson(req);
  const machineIdentifier = String(body.machineIdentifier || "");
  const device = flow.flowKind === "plex_legacy_pin" ? getPlexLegacyAuthDevice() : getOrCreatePlexAuthDevice();
  const [account, resources] = await Promise.all([plexAccount(device, flow.secret), plexResources(device, flow.secret)]);
  const selected = resources.find((server) => String(server.clientIdentifier || server.machineIdentifier || "") === machineIdentifier);
  if (!selected) return sendJson(res, { error: "Selected Plex server is not accessible to this account" }, 400);
  const serverCredential = String(selected.accessToken || selected.access_token || flow.secret);
  const verified = await verifyPlexServer(selected, serverCredential);
  const legacyConfig = await loadMediaConfig({ resolveConnections: false });
  let connection;
  db.transaction(() => {
    if (legacyConfig.plex?.token) {
      saveMediaConnection({ provider: "plex", baseUrl: legacyConfig.plex.baseUrl || verified.baseUrl, serverId: verified.serverId, serverName: verified.serverName, authDeviceId: flow.authDeviceId, remoteUserId: `unverified:${legacyConfig.plex.username || "legacy"}`, remoteUsername: legacyConfig.plex.username || "Legacy account", authKind: "legacy", credential: legacyConfig.plex.token, status: "disabled", lastValidatedAt: null });
    }
    const managedJwt = flow.secret.split(".").length === 3;
    connection = saveMediaConnection({ provider: "plex", ...verified, authDeviceId: flow.authDeviceId, remoteUserId: account.id, remoteUsername: account.username, authKind: managedJwt ? "plex_jwt" : "plex_legacy", credential: flow.secret, serverCredential, accessTokenExpiresAt: managedJwt ? plexTokenExpiresAt(flow.secret) : null, lastValidatedAt: Date.now() });
    disableStoredLegacyCredential("plex", connection.id, { authMode: "account", activate: true });
    completeAuthFlow(flow.id, fingerprint);
    writeAuditLog("media-auth.plex.connected", { ip: req.ip || req.socket?.remoteAddress, detail: { connectionId: connection.id, serverId: connection.serverId } });
  }).immediate();
  return sendJson(res, { ok: true, connection });
}

export async function handlePlexConnection(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !(await requireMediaAuthAdmin(req, res, principal))) return;
  if (req.method !== "DELETE") return methodNotAllowed(res);
  const removed = disableMediaConnection("plex");
  writeAuditLog("media-auth.plex.disconnected", { ip: req.ip || req.socket?.remoteAddress, detail: { removed } });
  return sendJson(res, {
    ok: true,
    removed,
    guidance: "If Plekt (or Plembfin, its earlier name) still appears in Plex Authorized Devices, remove it there to revoke the remote device registration.",
  });
}

function saveEmbyLikeAccount({ provider, authKind, verified, device, legacyConfig, req }) {
  let connection;
  db.transaction(() => {
    if (legacyConfig?.apiKey) {
      saveMediaConnection({
        provider,
        baseUrl: legacyConfig.baseUrl || verified.baseUrl,
        serverId: verified.serverId,
        serverName: verified.serverName,
        authDeviceId: device.id,
        remoteUserId: `unverified:${legacyConfig.userId || "legacy"}`,
        remoteUsername: "Legacy manual credential",
        authKind: "legacy",
        credential: legacyConfig.apiKey,
        status: "disabled",
        lastValidatedAt: null,
      });
    }
    connection = saveMediaConnection({
      provider,
      baseUrl: verified.baseUrl,
      serverId: verified.serverId,
      serverName: verified.serverName,
      authDeviceId: device.id,
      remoteUserId: verified.userId,
      remoteUsername: verified.username,
      authKind,
      credential: verified.token,
      lastValidatedAt: Date.now(),
    });
    disableStoredLegacyCredential(provider, connection.id, { authMode: "account", activate: true });
    writeAuditLog(`media-auth.${provider}.connected`, { ip: req.ip || req.socket?.remoteAddress, detail: { connectionId: connection.id, serverId: connection.serverId } });
  }).immediate();
  return connection;
}

export async function handleEmbyLikeAuth(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !(await requireMediaAuthAdmin(req, res, principal))) return;
  const fingerprint = requestFingerprint(req);

  if (path === "media-auth/emby/login" || path === "media-auth/jellyfin/login") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const provider = path.includes("/emby/") ? "emby" : "jellyfin";
    const body = await readJson(req);
    const device = getOrCreateAuthDevice(provider, { deviceName: "Plekt" });
    const verified = await authenticateEmbyLike({ provider, baseUrl: body.baseUrl, username: body.username, password: body.password, device });
    const stored = await loadMediaConfig({ resolveConnections: false });
    const connection = saveEmbyLikeAccount({ provider, authKind: `${provider}_user`, verified, device, legacyConfig: stored[provider], req });
    return sendJson(res, { ok: true, connection });
  }

  if (path === "media-auth/jellyfin/quick-connect/start") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    const device = getOrCreateAuthDevice("jellyfin", { deviceName: "Plekt" });
    if (!(await jellyfinQuickConnectEnabled(body.baseUrl, device))) {
      return sendJson(res, { error: "Quick Connect is disabled on this Jellyfin server", code: "quick_connect_disabled" }, 409);
    }
    const result = await initiateJellyfinQuickConnect(body.baseUrl, device);
    const flow = createAuthFlow({ provider: "jellyfin", authDeviceId: device.id, baseUrl: result.baseUrl, remoteFlowId: result.code, secret: result.secret, flowKind: "jellyfin_quick_connect", adminSessionFingerprint: fingerprint, expiresAt: result.expiresAt });
    writeAuditLog("media-auth.jellyfin.started", { ip: req.ip || req.socket?.remoteAddress, detail: { flowId: flow.id } });
    return sendJson(res, { flowId: flow.id, code: result.code, expiresAt: result.expiresAt });
  }

  const match = path.match(/^media-auth\/jellyfin\/quick-connect\/([a-f\d-]+)\/status$/i);
  if (!match) return sendJson(res, { error: "Not found" }, 404);
  if (req.method !== "GET") return methodNotAllowed(res);
  const flow = getAuthFlow(match[1], fingerprint);
  if (!flow || flow.provider !== "jellyfin") return sendJson(res, { error: "Authentication flow not found" }, 404);
  if (flow.status === "expired") return sendJson(res, { status: "expired" }, 410);
  if (flow.status !== "pending") return sendJson(res, { error: "Authentication flow is no longer pending" }, 409);
  const device = getActiveAuthDevice("jellyfin");
  const state = await pollJellyfinQuickConnect(flow.baseUrl, device, flow.secret);
  if (!state.authorised) return sendJson(res, { status: "pending", code: flow.remoteFlowId, expiresAt: flow.expiresAt });
  const verified = await authenticateEmbyLike({ provider: "jellyfin", baseUrl: flow.baseUrl, device, quickConnectSecret: flow.secret });
  if (!authoriseAuthFlow(flow.id, fingerprint, verified.token)) return sendJson(res, { error: "Quick Connect could not be completed" }, 409);
  const stored = await loadMediaConfig({ resolveConnections: false });
  const connection = saveEmbyLikeAccount({ provider: "jellyfin", authKind: "jellyfin_quick_connect", verified, device, legacyConfig: stored.jellyfin, req });
  completeAuthFlow(flow.id, fingerprint);
  return sendJson(res, { ok: true, status: "authorised", connection });
}

export async function handleEmbyLikeConnection(req, res, provider) {
  if (req.method === "OPTIONS") return sendOptions(res);
  const principal = await requireAdmin(req, res);
  if (!principal || !(await requireMediaAuthAdmin(req, res, principal))) return;
  if (req.method !== "DELETE") return methodNotAllowed(res);
  const connection = getMediaConnection(provider, { includeCredential: true });
  const revoked = await logoutEmbyLike(connection, getActiveAuthDevice(provider));
  const removed = disableMediaConnection(provider);
  writeAuditLog(`media-auth.${provider}.disconnected`, { ip: req.ip || req.socket?.remoteAddress, detail: { removed, remoteLogout: revoked } });
  return sendJson(res, { ok: true, removed, remoteLogout: revoked, guidance: revoked ? `${provider === "emby" ? "Emby" : "Jellyfin"} account disconnected and its session was revoked.` : `${provider === "emby" ? "Emby" : "Jellyfin"} account disconnected locally. Remove the Plekt (or Plembfin) device in the media server if it remains listed.` });
}
