import crypto from "node:crypto";
import { providerAppName } from "./brandEnv.js";
import { fetchWithTimeout } from "./outbound.js";

export const PLEX_CLIENTS_ORIGIN = "https://clients.plex.tv";
export const PLEX_TOKEN_REFRESH_SCOPE = "username,friendly_name,restricted,anonymous";

export function plexClientHeaders(device, { token = "" } = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Plex-Client-Identifier": device.deviceIdentifier,
    "X-Plex-Product": providerAppName(device),
    "X-Plex-Device": "Server",
  };
  if (token) headers["X-Plex-Token"] = token;
  return headers;
}

function encodePart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signPlexDeviceJwt({ device, privateKey, nonce = "", scope = PLEX_TOKEN_REFRESH_SCOPE, now = Date.now(), lifetimeSeconds = 300 }) {
  if (!device?.publicJwk?.kid) throw new Error("Plex device JWK is missing its key ID");
  const issuedAt = Math.floor(now / 1000);
  const header = { kid: device.publicJwk.kid, alg: "EdDSA", typ: "JWT" };
  const payload = {
    ...(nonce ? { nonce } : {}),
    ...(scope ? { scope } : {}),
    aud: "plex.tv",
    iss: device.deviceIdentifier,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
  };
  const signingInput = `${encodePart(header)}.${encodePart(payload)}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function decodeJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Plex token is not a JWT");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Plex token contains invalid JWT claims");
  }
}

export function plexTokenExpiresAt(token) {
  const exp = Number(decodeJwtClaims(token).exp);
  if (!Number.isFinite(exp) || exp <= 0) throw new Error("Plex JWT does not contain a valid expiry");
  return exp * 1000;
}

async function plexJson(response, operation) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${operation} failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function plexPinToken(payload) {
  const text = String(payload || "").trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const body = JSON.parse(text);
      return String(body.authToken || body.auth_token || body.accessToken || body.access_token || "");
    } catch {
      return "";
    }
  }
  const attribute = text.match(/\b(?:authToken|auth_token|accessToken|access_token)\s*=\s*["']([^"']*)["']/i);
  if (attribute) return decodeXml(attribute[1]);
  const element = text.match(/<(?:authToken|auth_token|accessToken|access_token)>\s*([^<]*)\s*<\//i);
  return element ? decodeXml(element[1]) : "";
}

export async function createPlexPin(device, { fetchImpl = fetchWithTimeout, strong = true, includeJwk = strong, originUrl = "" } = {}) {
  const headers = plexClientHeaders(device);
  // The hosted auth page (app.plex.tv/auth) validates that the PIN's `origin`
  // field matches forwardUrl's host; that field is only populated when the
  // PIN-creation request itself carries a matching Origin header. Without it
  // the page fails with "We were unable to complete this request" even
  // though the PIN and forwardUrl are both otherwise valid.
  if (originUrl) {
    try { headers.Origin = new URL(originUrl).origin; } catch { /* leave unset if publicBaseUrl is malformed */ }
  }
  const response = await fetchImpl(`${PLEX_CLIENTS_ORIGIN}/api/v2/pins`, {
    method: "POST",
    headers,
    body: JSON.stringify(strong
      ? { strong: true, ...(includeJwk ? { jwk: device.publicJwk } : {}) }
      : { strong: false }),
  });
  const body = await plexJson(response, "Plex PIN creation");
  const id = String(body.id || "");
  const code = String(body.code || "");
  if (!id || !code) throw new Error("Plex PIN response was missing its ID or code");
  const suppliedExpiry = Number(body.expiresAt) || Date.parse(body.expiresAt || "");
  const expiresAt = Number.isFinite(suppliedExpiry) ? (suppliedExpiry < 10_000_000_000 ? suppliedExpiry * 1000 : suppliedExpiry) : Date.now() + Number(body.expiresIn || 600) * 1000;
  return { id, code, expiresAt };
}

export function plexAuthUrl({ device, code, publicBaseUrl = "" }) {
  const params = new URLSearchParams({
    clientID: device.deviceIdentifier,
    code,
    "context[device][product]": providerAppName(device),
  });
  if (publicBaseUrl) params.set("forwardUrl", `${String(publicBaseUrl).replace(/\/$/, "")}/auth/plex/return`);
  return `https://app.plex.tv/auth#?${params}`;
}

export async function pollPlexPin({ device, privateKey, pinId, strong = true, fetchImpl = fetchWithTimeout }) {
  const url = new URL(`${PLEX_CLIENTS_ORIGIN}/api/v2/pins/${encodeURIComponent(pinId)}`);
  if (strong) url.searchParams.set("deviceJWT", signPlexDeviceJwt({ device, privateKey, scope: "" }));
  const headers = plexClientHeaders(device);
  if (strong) headers.Accept = "application/xml";
  const response = await fetchImpl(url, { headers });
  const payload = typeof response.text === "function"
    ? await response.text()
    : JSON.stringify(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = new Error(`Plex PIN poll failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const token = plexPinToken(payload);
  return { authorised: Boolean(token), token };
}

export async function refreshPlexJwt({ device, privateKey, fetchImpl = fetchWithTimeout, now = Date.now() }) {
  const nonceResponse = await fetchImpl(`${PLEX_CLIENTS_ORIGIN}/api/v2/auth/nonce`, { headers: plexClientHeaders(device) });
  const nonceBody = await plexJson(nonceResponse, "Plex nonce request");
  if (!nonceBody.nonce) throw new Error("Plex nonce response was missing its nonce");
  const jwt = signPlexDeviceJwt({ device, privateKey, nonce: String(nonceBody.nonce), now });
  const tokenResponse = await fetchImpl(`${PLEX_CLIENTS_ORIGIN}/api/v2/auth/token`, {
    method: "POST",
    headers: plexClientHeaders(device),
    body: JSON.stringify({ jwt }),
  });
  const tokenBody = await plexJson(tokenResponse, "Plex token exchange");
  const token = String(tokenBody.auth_token || tokenBody.authToken || "");
  if (!token) throw new Error("Plex token exchange response was missing its token");
  return { token, expiresAt: plexTokenExpiresAt(token) };
}
