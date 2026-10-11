// OneDrive adapter (Microsoft Graph). Auth is the device-code flow handled in the
// API layer; this adapter only refreshes the stored refresh token and reads/writes
// the app folder (approot) so it never touches the rest of the user's drive.
// Settings: { clientId, tenant?, folder? }  Secrets: { refreshToken }
import fs from "node:fs";
import { fetchWithTimeout } from "../outbound.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;
export const ONEDRIVE_SCOPE = "offline_access Files.ReadWrite.AppFolder";

// access_token cache keyed by destination id (refresh tokens live in the DB).
const tokenCache = new Map();

export function tokenEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/token`;
}

export function deviceCodeEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/devicecode`;
}

async function ensureAccessToken(destination, persistSecrets) {
  const cached = tokenCache.get(destination.id);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;
  if (cached) tokenCache.delete(destination.id); // expired - drop so stale destinations don't accumulate

  const clientId = destination.settings?.clientId;
  const refreshToken = destination.secrets?.refreshToken;
  if (!clientId) throw new Error("OneDrive client ID is required");
  if (!refreshToken) throw new Error("OneDrive is not connected - run Connect first");

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: ONEDRIVE_SCOPE,
  });
  const response = await fetchWithTimeout(tokenEndpoint(destination.settings?.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OneDrive token refresh failed: ${data.error_description || data.error || response.status}`);
  }
  tokenCache.set(destination.id, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
  // Microsoft rotates refresh tokens - persist the new one so we stay connected.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    destination.secrets.refreshToken = data.refresh_token;
    persistSecrets({ refreshToken: data.refresh_token });
  }
  return data.access_token;
}

function approotPath(name) {
  return `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(name)}:`;
}

export function createOneDriveAdapter(destination, { persistSecrets }) {
  async function authHeader() {
    return { Authorization: `Bearer ${await ensureAccessToken(destination, persistSecrets)}` };
  }

  return {
    async testConnection() {
      const headers = await authHeader();
      const response = await fetchWithTimeout("https://graph.microsoft.com/v1.0/me/drive/special/approot", { headers });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OneDrive connection failed (${response.status}): ${text.slice(0, 160)}`);
      }
      return { ok: true, detail: "App folder reachable" };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const body = fs.readFileSync(localPath);
      const headers = await authHeader();
      const response = await fetchWithTimeout(`${approotPath(remoteName)}/content`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/gzip" },
        body,
      }, 60_000);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OneDrive upload failed (${response.status}): ${text.slice(0, 200)}`);
      }
      return { bytes: body.length, durationMs: Date.now() - started };
    },

    async list() {
      const headers = await authHeader();
      const response = await fetchWithTimeout(
        "https://graph.microsoft.com/v1.0/me/drive/special/approot/children?$select=name,size,createdDateTime&$top=200",
        { headers },
      );
      if (!response.ok) throw new Error(`OneDrive list failed (${response.status})`);
      const data = await response.json().catch(() => ({}));
      return (data.value || [])
        .filter((item) => FILE_PATTERN.test(item.name || ""))
        .map((item) => ({
          name: item.name,
          sizeBytes: Number(item.size) || 0,
          createdAt: item.createdDateTime || new Date().toISOString(),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async download(remoteName) {
      const headers = await authHeader();
      const response = await fetchWithTimeout(`${approotPath(remoteName)}/content`, { headers }, 60_000);
      if (!response.ok) throw new Error(`OneDrive download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(remoteName) {
      const headers = await authHeader();
      const response = await fetchWithTimeout(approotPath(remoteName), { method: "DELETE", headers });
      if (!(response.ok || response.status === 204 || response.status === 404)) {
        throw new Error(`OneDrive delete failed (${response.status})`);
      }
    },
  };
}
