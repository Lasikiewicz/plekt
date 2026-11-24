// OneDrive adapter (Microsoft Graph). Auth is the device-code flow handled in the
// API layer; this adapter refreshes the stored refresh token and reads/writes
// the app folder (approot) so it never touches the rest of the user's drive.
// Files above 4 MiB stream through Graph resumable upload sessions in 10 MiB chunks
// (an exact multiple of Microsoft's required 320 KiB granularity).
// Settings: { clientId, tenant?, folder? }  Secrets: { refreshToken }
import fs from "node:fs";
import { fetchWithTimeout, uploadFileWithTimeout } from "../outbound.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;
const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // Microsoft Graph simple PUT cap
const DEFAULT_UPLOAD_CHUNK_BYTES = 32 * 320 * 1024;  // 10 MiB (multiple of 320 KiB)
const MAX_LIST_PAGES = 10;
export const ONEDRIVE_SCOPE = "offline_access Files.ReadWrite.AppFolder";

// access_token cache keyed by destination id (refresh tokens live in the DB).
const tokenCache = new Map();

export function tokenEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/token`;
}

export function deviceCodeEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/devicecode`;
}

function cleanSubfolder(destination) {
  return String(destination.settings?.folder || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function approotItemUrl(graphBase, destination, name) {
  const folder = cleanSubfolder(destination);
  const relPath = folder ? `${folder}/${encodeURIComponent(name)}` : encodeURIComponent(name);
  return `${graphBase}/me/drive/special/approot:/${relPath}:`;
}

function approotListUrl(graphBase, destination) {
  const folder = cleanSubfolder(destination);
  if (folder) {
    return `${graphBase}/me/drive/special/approot:/${folder}:/children?$select=name,size,createdDateTime&$top=200`;
  }
  return `${graphBase}/me/drive/special/approot/children?$select=name,size,createdDateTime&$top=200`;
}

async function ensureAccessToken(destination, persistSecrets, tokenUrlOverride = "") {
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
  const response = await fetchWithTimeout(tokenUrlOverride || tokenEndpoint(destination.settings?.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch((error) => {
    if (error?.code === "UPSTREAM_TIMEOUT" || error?.name === "AbortError") throw error;
    return {};
  });
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

export function createOneDriveAdapter(destination, hooks = {}) {
  const persistSecrets = typeof hooks.persistSecrets === "function" ? hooks.persistSecrets : () => {};
  const graphBase = String(hooks.graphBaseUrl || DEFAULT_GRAPH_BASE).replace(/\/+$/, "");
  const tokenUrlOverride = String(hooks.tokenUrl || "").trim();
  const simpleUploadLimit = Number(hooks.simpleUploadLimit) > 0 ? Number(hooks.simpleUploadLimit) : DEFAULT_SIMPLE_UPLOAD_LIMIT;
  const chunkSize = Number(hooks.chunkSize) > 0 ? Number(hooks.chunkSize) : DEFAULT_UPLOAD_CHUNK_BYTES;

  async function authHeader() {
    return { Authorization: `Bearer ${await ensureAccessToken(destination, persistSecrets, tokenUrlOverride)}` };
  }

  async function uploadWithSession(localPath, remoteName, size) {
    const headers = await authHeader();
    const sessionRes = await fetchWithTimeout(`${approotItemUrl(graphBase, destination, remoteName)}/createUploadSession`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    }, 30_000);
    const sessionData = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok || !sessionData.uploadUrl) {
      throw new Error(`OneDrive upload session failed (${sessionRes.status}): ${sessionData.error?.message || ""}`.trim());
    }

    // Microsoft Graph pre-authenticates uploadUrl; sending Authorization on chunk
    // PUTs is rejected by Graph. Stream each chunk directly from disk.
    for (let offset = 0; offset < size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, size) - 1;
      const chunkLen = end - offset + 1;
      const chunkRes = await uploadFileWithTimeout(sessionData.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunkLen),
          "Content-Range": `bytes ${offset}-${end}/${size}`,
        },
        filePath: localPath,
        start: offset,
        end,
      }, 60_000);
      if (!chunkRes.ok && chunkRes.status !== 202) {
        throw new Error(`OneDrive chunk upload failed (${chunkRes.status}): ${chunkRes.text.slice(0, 200)}`);
      }
    }
  }

  return {
    async testConnection() {
      const headers = await authHeader();
      const response = await fetchWithTimeout(`${graphBase}/me/drive/special/approot`, { headers });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OneDrive connection failed (${response.status}): ${text.slice(0, 160)}`);
      }
      return { ok: true, detail: "App folder reachable" };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const { size } = await fs.promises.stat(localPath);
      if (size > simpleUploadLimit) {
        await uploadWithSession(localPath, remoteName, size);
      } else {
        const headers = await authHeader();
        const contentType = remoteName.endsWith(".gz") ? "application/gzip" : "application/octet-stream";
        const response = await uploadFileWithTimeout(`${approotItemUrl(graphBase, destination, remoteName)}/content`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": contentType, "Content-Length": String(size) },
          filePath: localPath,
        }, 60_000);
        if (!response.ok) {
          throw new Error(`OneDrive upload failed (${response.status}): ${response.text.slice(0, 200)}`);
        }
      }
      return { bytes: size, durationMs: Date.now() - started };
    },

    async list() {
      const headers = await authHeader();
      const items = [];
      let nextUrl = approotListUrl(graphBase, destination);
      for (let page = 0; page < MAX_LIST_PAGES && nextUrl; page += 1) {
        const response = await fetchWithTimeout(nextUrl, { headers });
        if (response.status === 404 && page === 0) return [];
        if (!response.ok) throw new Error(`OneDrive list failed (${response.status})`);
        const data = await response.json().catch((error) => {
          if (error?.code === "UPSTREAM_TIMEOUT" || error?.name === "AbortError") throw error;
          return {};
        });
        for (const item of data.value || []) {
          if (!FILE_PATTERN.test(item.name || "")) continue;
          items.push({
            name: item.name,
            sizeBytes: Number(item.size) || 0,
            createdAt: item.createdDateTime || new Date().toISOString(),
          });
        }
        nextUrl = typeof data["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : "";
      }
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async download(remoteName) {
      const headers = await authHeader();
      const response = await fetchWithTimeout(`${approotItemUrl(graphBase, destination, remoteName)}/content`, { headers }, 60_000);
      if (!response.ok) throw new Error(`OneDrive download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(remoteName) {
      const headers = await authHeader();
      const response = await fetchWithTimeout(approotItemUrl(graphBase, destination, remoteName), { method: "DELETE", headers });
      if (!(response.ok || response.status === 204 || response.status === 404)) {
        throw new Error(`OneDrive delete failed (${response.status})`);
      }
    },
  };
}
