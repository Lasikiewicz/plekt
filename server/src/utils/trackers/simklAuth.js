import { simklTransport } from "./simklTransport.js";

export const SIMKL_SCOPES = "media:read media:write";
const API_BASE = "https://api.simkl.com";
const USER_AGENT = "Plekt (https://github.com/Lasikiewicz/plekt)";
const OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "invalid_scope",
  "unsupported_grant_type", "expired_token", "authorization_pending", "slow_down", "server_error",
]);

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Simkl ${label} is required`);
  return value.trim();
}

function invalidResponse() {
  return Object.assign(new Error("Simkl returned an invalid authentication response"), { code: "SIMKL_INVALID_RESPONSE" });
}

// Never retain upstream bodies/descriptions: OAuth errors can echo credentials.
async function request(path, { clientId, accessToken, body, remoteUserId } = {}) {
  const { response, data, metadata, rateCode } = await simklTransport({ clientId, accessToken, remoteUserId }, `${API_BASE}${path}`, {
    method: body ? "POST" : "GET", lane: "interactive",
    headers: {
      "content-type": "application/json", "user-agent": USER_AGENT,
      "simkl-api-key": required(clientId, "Client ID"),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 20_000);
  if (!response.ok || rateCode) {
    const code = rateCode || (OAUTH_ERRORS.has(data?.error) ? data.error : "SIMKL_REQUEST_FAILED");
    const error = Object.assign(new Error(`Simkl authentication failed (${code}, HTTP ${response.status})`), {
      code, status: response.status,
      ...metadata,
    });
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidResponse();
  return data;
}

function positiveSeconds(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function verificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "simkl.com" && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  throw invalidResponse();
}

export async function startSimklDeviceAuth(clientId) {
  clientId = required(clientId, "Client ID");
  // The device endpoint schema and successful Phase 0 exchange use no PKCE
  // fields. PKCE belongs to authorization_code; never invent a device verifier.
  const data = await request("/oauth2/device", { clientId, body: { client_id: clientId, scope: SIMKL_SCOPES } });
  if (typeof data.device_code !== "string" || !data.device_code.trim()
      || typeof data.user_code !== "string" || !data.user_code.trim()
      || !positiveSeconds(data.expires_in) || !positiveSeconds(data.interval)) throw invalidResponse();
  return {
    device_code: data.device_code, user_code: data.user_code,
    verification_url: verificationUrl(data.verification_uri_complete || data.verification_uri),
    expires_in: data.expires_in, interval: data.interval,
  };
}

export function validateSimklTokens(data) {
  if (typeof data?.access_token !== "string" || !data.access_token.trim()
      || typeof data.refresh_token !== "string" || !data.refresh_token.trim()
      || String(data.token_type).toLowerCase() !== "bearer" || !positiveSeconds(data.expires_in)
      || typeof data.scope !== "string") throw invalidResponse();
  const scopes = new Set(data.scope.split(/\s+/));
  if (!["media:read", "media:write"].every((scope) => scopes.has(scope))) {
    throw Object.assign(new Error("Simkl requires read and write permission; reconnect and allow both"), { code: "SIMKL_SCOPE_REQUIRED" });
  }
  return {
    access_token: data.access_token, refresh_token: data.refresh_token,
    token_type: "Bearer", expires_in: data.expires_in, scope: SIMKL_SCOPES,
  };
}

export async function pollSimklDeviceAuth({ clientId, deviceCode }) {
  clientId = required(clientId, "Client ID");
  const data = await request("/oauth2/token", { clientId, body: {
    client_id: clientId, device_code: required(deviceCode, "device code"),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  } });
  return validateSimklTokens(data);
}

export async function refreshSimklToken({ clientId, refreshToken, accessToken, remoteUserId }) {
  clientId = required(clientId, "Client ID");
  const data = await request("/oauth2/token", { clientId, accessToken, remoteUserId, body: {
    client_id: clientId, refresh_token: required(refreshToken, "refresh token"), grant_type: "refresh_token",
  } });
  return validateSimklTokens(data);
}

export async function getSimklUser({ clientId, accessToken }) {
  const data = await request("/users/settings", { clientId, accessToken: required(accessToken, "access token") });
  const id = data.account?.id;
  if (!(typeof id === "string" && id.trim() || Number.isSafeInteger(id) && id > 0)) throw invalidResponse();
  return { remoteUserId: String(id), remoteUsername: String(data.user?.name || data.user?.username || `Simkl user ${id}`) };
}

// A declined device request has no denial signal. The caller must enforce the
// stored expiresAt deadline and persist slow_down's larger polling interval.
export function simklDevicePollOutcome(error, intervalSeconds = 5) {
  const interval = Math.max(5, Number(intervalSeconds) || 5);
  if (error?.status === 400 && error.code === "authorization_pending") return { status: "pending", intervalSeconds: interval };
  if (error?.status === 400 && error.code === "slow_down") return { status: "pending", intervalSeconds: interval + 5 };
  if (error?.status === 400 && error.code === "expired_token") return { status: "expired" };
  if (error?.status === 429) return { status: "pending", intervalSeconds: Math.max(interval, error.retryAfter || 0) };
  return null;
}
