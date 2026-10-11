// Dropbox adapter (API v2). Auth is the OAuth refresh-token flow handled in the API
// layer; this adapter refreshes the access token and reads/writes an app-scoped
// folder. Settings: { appKey, folder? }  Secrets: { appSecret, refreshToken }
import fs from "node:fs";
import { fetchWithTimeout } from "../outbound.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;

// access_token cache keyed by destination id (refresh tokens live in the DB).
const tokenCache = new Map();

function folderPath(destination) {
  let folder = String(destination.settings?.folder || "/Plembfin Backups").trim();
  if (!folder.startsWith("/")) folder = `/${folder}`;
  return folder.replace(/\/+$/, "");
}

async function ensureAccessToken(destination) {
  const cached = tokenCache.get(destination.id);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;
  if (cached) tokenCache.delete(destination.id); // expired - drop so stale destinations don't accumulate

  const appKey = destination.settings?.appKey;
  const appSecret = destination.secrets?.appSecret;
  const refreshToken = destination.secrets?.refreshToken;
  if (!appKey || !appSecret) throw new Error("Dropbox app key and secret are required");
  if (!refreshToken) throw new Error("Dropbox is not connected - run Connect first");

  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const response = await fetchWithTimeout("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Dropbox token refresh failed: ${data.error_description || data.error || response.status}`);
  }
  tokenCache.set(destination.id, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 14400) * 1000,
  });
  return data.access_token;
}

export function createDropboxAdapter(destination) {
  async function bearer() {
    return `Bearer ${await ensureAccessToken(destination)}`;
  }

  return {
    async testConnection() {
      const response = await fetchWithTimeout("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: await bearer() },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Dropbox connection failed (${response.status}): ${text.slice(0, 160)}`);
      }
      return { ok: true, detail: "Account reachable" };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const body = fs.readFileSync(localPath);
      const arg = JSON.stringify({ path: `${folderPath(destination)}/${remoteName}`, mode: "overwrite", mute: true });
      const response = await fetchWithTimeout("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: await bearer(),
          "Dropbox-API-Arg": arg,
          "Content-Type": "application/octet-stream",
        },
        body,
      }, 60_000);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Dropbox upload failed (${response.status}): ${text.slice(0, 200)}`);
      }
      return { bytes: body.length, durationMs: Date.now() - started };
    },

    async list() {
      const response = await fetchWithTimeout("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: { Authorization: await bearer(), "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath(destination) }),
      });
      if (response.status === 409) return []; // folder not created yet
      if (!response.ok) throw new Error(`Dropbox list failed (${response.status})`);
      const data = await response.json().catch(() => ({}));
      return (data.entries || [])
        .filter((entry) => entry[".tag"] === "file" && FILE_PATTERN.test(entry.name || ""))
        .map((entry) => ({
          name: entry.name,
          sizeBytes: Number(entry.size) || 0,
          createdAt: entry.server_modified || new Date().toISOString(),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async download(remoteName) {
      const arg = JSON.stringify({ path: `${folderPath(destination)}/${remoteName}` });
      const response = await fetchWithTimeout("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: { Authorization: await bearer(), "Dropbox-API-Arg": arg },
      }, 60_000);
      if (!response.ok) throw new Error(`Dropbox download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(remoteName) {
      const response = await fetchWithTimeout("https://api.dropboxapi.com/2/files/delete_v2", {
        method: "POST",
        headers: { Authorization: await bearer(), "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${folderPath(destination)}/${remoteName}` }),
      });
      if (!response.ok && response.status !== 409) {
        throw new Error(`Dropbox delete failed (${response.status})`);
      }
    },
  };
}
