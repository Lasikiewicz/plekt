import crypto from "node:crypto";
import { db } from "../db.js";
import { decryptCredential, encryptCredential } from "./credentialVault.js";
import { assertSafeOutboundUrl, normalizeHttpUrl } from "./outbound.js";

const PROVIDERS = new Set(["plex", "emby", "jellyfin"]);
const AUTH_KINDS = new Set(["plex_jwt", "plex_managed_jwt", "plex_legacy", "emby_user", "jellyfin_quick_connect", "jellyfin_user", "legacy"]);

function providerName(value) {
  const provider = String(value || "").toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported media provider");
  return provider;
}

function rowToDevice(row) {
  if (!row) return null;
  return { id: row.id, provider: row.provider, deviceIdentifier: row.device_identifier, legacyClientIdentifier: row.legacy_client_identifier || `${row.device_identifier}-pms`, deviceName: row.device_name, publicJwk: row.public_jwk ? JSON.parse(row.public_jwk) : null, keyVersion: row.key_version, retiredAt: row.retired_at, replacementDeviceId: row.replacement_device_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getActiveAuthDevice(provider) {
  return rowToDevice(db.prepare("SELECT * FROM media_auth_devices WHERE provider=? AND retired_at IS NULL").get(providerName(provider)));
}

export function getOrCreateAuthDevice(provider, { deviceName = "Plekt",publicJwk = null, encryptedPrivateKey = null } = {}) {
  const normalizedProvider = providerName(provider);
  const active = getActiveAuthDevice(normalizedProvider);
  if (active) return active;
  if (normalizedProvider === "plex" && (!publicJwk || !encryptedPrivateKey?.ciphertext || !encryptedPrivateKey?.iv || !encryptedPrivateKey?.tag)) {
    throw new Error("A new Plex device requires a public JWK and encrypted Ed25519 private key");
  }
  let result;
  db.transaction(() => {
    const current = db.prepare("SELECT * FROM media_auth_devices WHERE provider=? AND retired_at IS NULL").get(normalizedProvider);
    if (current) { result = rowToDevice(current); return; }
    const now = Date.now();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO media_auth_devices
      (id,provider,device_identifier,legacy_client_identifier,device_name,public_jwk,private_key_ciphertext,private_key_iv,private_key_tag,key_version,created_at,updated_at)
      VALUES (@id,@provider,@identifier,@legacyIdentifier,@name,@jwk,@ciphertext,@iv,@tag,@version,@now,@now)`).run({
      id, provider: normalizedProvider, identifier: crypto.randomUUID(), name: String(deviceName || "Plekt").trim(),
      legacyIdentifier: crypto.randomUUID(),
      jwk: publicJwk ? JSON.stringify(publicJwk) : null, ciphertext: encryptedPrivateKey?.ciphertext || null,
      iv: encryptedPrivateKey?.iv || null, tag: encryptedPrivateKey?.tag || null, version: encryptedPrivateKey?.version || 1, now,
    });
    result = getActiveAuthDevice(normalizedProvider);
  }).immediate();
  return result;
}

export function getOrCreatePlexAuthDevice({ deviceName = "Plekt",vaultOptions = {} } = {}) {
  const active = getActiveAuthDevice("plex");
  if (active) return active;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" });
  const thumbprint = crypto.createHash("sha256").update(JSON.stringify({ crv: exported.crv, kty: exported.kty, x: exported.x })).digest("base64url");
  const publicJwk = { ...exported, kid: thumbprint, use: "sig", alg: "EdDSA" };
  const encryptedPrivateKey = encryptCredential(privateKey.export({ format: "pem", type: "pkcs8" }), vaultOptions);
  return getOrCreateAuthDevice("plex", { deviceName, publicJwk, encryptedPrivateKey });
}

export function getPlexLegacyAuthDevice() {
  const device = getOrCreatePlexAuthDevice();
  return { ...device, deviceIdentifier: device.legacyClientIdentifier };
}

export function getPlexPrivateKey({ vaultOptions = {} } = {}) {
  const row = db.prepare("SELECT * FROM media_auth_devices WHERE provider='plex' AND retired_at IS NULL").get();
  if (!row?.private_key_ciphertext) throw new Error("Active Plex device key is unavailable");
  const pem = decryptCredential({ ciphertext: row.private_key_ciphertext, iv: row.private_key_iv, tag: row.private_key_tag, version: row.key_version }, vaultOptions);
  return crypto.createPrivateKey(pem);
}

function publicConnection(row) {
  if (!row) return null;
  return { id: row.id, provider: row.provider, baseUrl: row.base_url, serverId: row.server_id, serverName: row.server_name || "", authDeviceId: row.auth_device_id, remoteUserId: row.remote_user_id, remoteUsername: row.remote_username || "", authKind: row.auth_kind, serverOwned: row.server_owned == null ? null : Boolean(row.server_owned), accessTokenExpiresAt: row.access_token_expires_at, lastRefreshedAt: row.last_refreshed_at, refreshFailureCount: row.refresh_failure_count, status: row.status, lastValidatedAt: row.last_validated_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getMediaConnection(provider, { includeCredential = false, vaultOptions = {} } = {}) {
  const row = db.prepare("SELECT * FROM media_connections WHERE provider=? AND status IN ('connected','reauth_required','legacy') ORDER BY updated_at DESC LIMIT 1").get(providerName(provider));
  const connection = publicConnection(row);
  if (connection && includeCredential) {
    connection.credential = decryptCredential({ ciphertext: row.credential_ciphertext, iv: row.credential_iv, tag: row.credential_tag, version: row.token_version }, vaultOptions);
    connection.serverCredential = row.server_credential_ciphertext
      ? decryptCredential({ ciphertext: row.server_credential_ciphertext, iv: row.server_credential_iv, tag: row.server_credential_tag, version: row.server_token_version }, vaultOptions)
      : "";
  }
  return connection;
}

export function saveMediaConnection(input, { vaultOptions = {} } = {}) {
  const provider = providerName(input.provider);
  if (!AUTH_KINDS.has(input.authKind)) throw new Error("Unsupported media authentication kind");
  if (!new Set(["connected", "reauth_required", "disabled", "legacy"]).has(input.status || "connected")) throw new Error("Unsupported media connection status");
  if (!String(input.remoteUserId || "").trim()) throw new Error("Verified remote user ID is required");
  if (!String(input.serverId || "").trim()) throw new Error("Verified server ID is required");
  const device = getActiveAuthDevice(provider);
  if (!device || device.id !== input.authDeviceId) throw new Error("Connection must use the active device identity for its provider");
  const encrypted = encryptCredential(input.credential, vaultOptions);
  const encryptedServer = input.serverCredential ? encryptCredential(input.serverCredential, vaultOptions) : null;
  const baseUrl = normalizeHttpUrl(input.baseUrl, { label: `${provider} server URL` });
  assertSafeOutboundUrl(baseUrl, { label: `${provider} server URL` });
  const id = input.id || crypto.randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.prepare("UPDATE media_connections SET status='disabled', updated_at=? WHERE provider=? AND id<>? AND status IN ('connected','reauth_required','legacy')").run(now, provider, id);
    db.prepare(`INSERT INTO media_connections
      (id,provider,base_url,server_id,server_name,auth_device_id,remote_user_id,remote_username,auth_kind,credential_ciphertext,credential_iv,credential_tag,token_version,server_credential_ciphertext,server_credential_iv,server_credential_tag,server_token_version,access_token_expires_at,last_refreshed_at,refresh_failure_count,status,last_validated_at,server_owned,created_at,updated_at)
      VALUES (@id,@provider,@baseUrl,@serverId,@serverName,@deviceId,@userId,@username,@authKind,@ciphertext,@iv,@tag,@version,@serverCiphertext,@serverIv,@serverTag,@serverVersion,@expiresAt,@refreshedAt,0,@status,@validatedAt,@serverOwned,@now,@now)
      ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url,server_id=excluded.server_id,server_name=excluded.server_name,auth_device_id=excluded.auth_device_id,remote_user_id=excluded.remote_user_id,remote_username=excluded.remote_username,auth_kind=excluded.auth_kind,credential_ciphertext=excluded.credential_ciphertext,credential_iv=excluded.credential_iv,credential_tag=excluded.credential_tag,token_version=excluded.token_version,server_credential_ciphertext=excluded.server_credential_ciphertext,server_credential_iv=excluded.server_credential_iv,server_credential_tag=excluded.server_credential_tag,server_token_version=excluded.server_token_version,access_token_expires_at=excluded.access_token_expires_at,last_refreshed_at=excluded.last_refreshed_at,refresh_failure_count=0,status=excluded.status,last_validated_at=excluded.last_validated_at,server_owned=excluded.server_owned,updated_at=excluded.updated_at`).run({
      id, provider, baseUrl, serverId: String(input.serverId), serverName: String(input.serverName || ""), deviceId: device.id, userId: String(input.remoteUserId), username: String(input.remoteUsername || ""), authKind: input.authKind, ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, version: encrypted.version,
      serverCiphertext: encryptedServer?.ciphertext || null, serverIv: encryptedServer?.iv || null, serverTag: encryptedServer?.tag || null, serverVersion: encryptedServer?.version || 1,
      expiresAt: input.accessTokenExpiresAt ?? null, refreshedAt: input.lastRefreshedAt ?? null, status: input.status || "connected", validatedAt: input.lastValidatedAt ?? now, serverOwned: input.serverOwned == null ? null : (input.serverOwned ? 1 : 0), now,
    });
  }).immediate();
  return getMediaConnection(provider);
}

export function disableMediaConnection(provider) {
  const result = db.prepare("UPDATE media_connections SET status='disabled', credential_ciphertext='', credential_iv='', credential_tag='', server_credential_ciphertext=NULL, server_credential_iv=NULL, server_credential_tag=NULL, updated_at=? WHERE provider=? AND status IN ('connected','reauth_required','legacy')").run(Date.now(), providerName(provider));
  return result.changes > 0;
}

export function resolveConnectedProviderConfig(provider, legacyConfig = {}, options = {}) {
  const connection = getMediaConnection(provider, { includeCredential: true, vaultOptions: options.vaultOptions });
  if (!connection) return legacyConfig;
  const device = getActiveAuthDevice(provider);
  return provider === "plex"
    ? { ...legacyConfig, baseUrl: connection.baseUrl, token: connection.serverCredential || connection.credential, username: connection.remoteUsername, connectionId: connection.id, remoteUserId: connection.remoteUserId, authKind: connection.authKind, serverOwned: connection.serverOwned, clientIdentifier: device?.deviceIdentifier || "" }
    : { ...legacyConfig, baseUrl: connection.baseUrl, apiKey: connection.credential, userId: connection.remoteUserId, connectionId: connection.id, authKind: connection.authKind };
}

export function createAuthFlow(input, { vaultOptions = {} } = {}) {
  const provider = providerName(input.provider);
  if (!new Set(["plex", "jellyfin"]).has(provider)) throw new Error("Provider does not use a persisted auth flow");
  const device = getActiveAuthDevice(provider);
  if (!device || device.id !== input.authDeviceId) throw new Error("Auth flow must use the active provider device");
  const secret = input.secret ? encryptCredential(input.secret, vaultOptions) : null;
  const id = crypto.randomUUID();
  const now = Date.now();
  const fingerprint = String(input.adminSessionFingerprint || "");
  if (!fingerprint) throw new Error("Admin session fingerprint is required");
  const expiresAt = Number(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error("Auth flow expiry must be in the future");
  db.prepare(`INSERT INTO media_auth_flows
    (id,provider,auth_device_id,base_url,remote_flow_id,secret_ciphertext,secret_iv,secret_tag,key_version,flow_kind,status,admin_session_fingerprint,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, provider, device.id, input.baseUrl || null, input.remoteFlowId || null, secret?.ciphertext || null, secret?.iv || null, secret?.tag || null, secret?.version || 1, input.flowKind || null, "pending", fingerprint, expiresAt, now, now);
  return { id, provider, expiresAt, status: "pending" };
}

export function getAuthFlow(id, adminSessionFingerprint, { vaultOptions = {} } = {}) {
  const row = db.prepare("SELECT * FROM media_auth_flows WHERE id=?").get(String(id));
  if (!row || row.admin_session_fingerprint !== String(adminSessionFingerprint || "")) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare("UPDATE media_auth_flows SET status='expired',updated_at=? WHERE id=? AND status<>'completed'").run(Date.now(), row.id);
    return { id: row.id, provider: row.provider, status: "expired", expiresAt: row.expires_at };
  }
  return {
    id: row.id, provider: row.provider, authDeviceId: row.auth_device_id, baseUrl: row.base_url,
    remoteFlowId: row.remote_flow_id, flowKind: row.flow_kind || "", status: row.status, expiresAt: row.expires_at,
    secret: row.secret_ciphertext ? decryptCredential({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag, version: row.key_version }, vaultOptions) : "",
  };
}

export function getReusableAuthorisedAuthFlow(provider, adminSessionFingerprint, { vaultOptions = {} } = {}) {
  const normalizedProvider = providerName(provider);
  const fingerprint = String(adminSessionFingerprint || "");
  if (!fingerprint) return null;
  const row = db.prepare(`SELECT id FROM media_auth_flows
    WHERE provider=? AND admin_session_fingerprint=? AND status='authorised' AND expires_at>?
    ORDER BY updated_at DESC LIMIT 1`).get(normalizedProvider, fingerprint, Date.now());
  return row ? getAuthFlow(row.id, fingerprint, { vaultOptions }) : null;
}

export function authoriseAuthFlow(id, adminSessionFingerprint, secret, { vaultOptions = {} } = {}) {
  const encrypted = encryptCredential(secret, vaultOptions);
  const result = db.prepare(`UPDATE media_auth_flows SET secret_ciphertext=?,secret_iv=?,secret_tag=?,key_version=?,status='authorised',updated_at=?
    WHERE id=? AND admin_session_fingerprint=? AND status='pending' AND expires_at>?`).run(encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.version, Date.now(), String(id), String(adminSessionFingerprint || ""), Date.now());
  return result.changes === 1;
}

export function completeAuthFlow(id, adminSessionFingerprint) {
  return db.prepare("UPDATE media_auth_flows SET status='completed',secret_ciphertext=NULL,secret_iv=NULL,secret_tag=NULL,updated_at=? WHERE id=? AND admin_session_fingerprint=? AND status='authorised'").run(Date.now(), String(id), String(adminSessionFingerprint || "")).changes === 1;
}

export function consumeAuthFlow(id, adminSessionFingerprint, { vaultOptions = {} } = {}) {
  let result = null;
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM media_auth_flows WHERE id=?").get(String(id));
    if (!row || row.status !== "pending") return;
    if (row.expires_at <= Date.now()) {
      db.prepare("UPDATE media_auth_flows SET status='expired',updated_at=? WHERE id=?").run(Date.now(), row.id);
      return;
    }
    if (row.admin_session_fingerprint !== String(adminSessionFingerprint || "")) return;
    db.prepare("UPDATE media_auth_flows SET status='completed',updated_at=? WHERE id=? AND status='pending'").run(Date.now(), row.id);
    result = {
      id: row.id, provider: row.provider, authDeviceId: row.auth_device_id, baseUrl: row.base_url,
      remoteFlowId: row.remote_flow_id,
      secret: row.secret_ciphertext ? decryptCredential({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag, version: row.key_version }, vaultOptions) : "",
      status: "completed", expiresAt: row.expires_at,
    };
  }).immediate();
  return result;
}

export function deleteExpiredAuthFlows(now = Date.now()) {
  return db.prepare("DELETE FROM media_auth_flows WHERE expires_at<=? OR status IN ('completed','expired','rejected')").run(now).changes;
}
