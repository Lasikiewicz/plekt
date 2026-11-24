// Dropbox adapter (API v2). Auth uses OAuth 2.0 PKCE with Plekt's bundled public
// App Key (no client secret needed), or an optional user-supplied custom Dropbox app.
// Files above the chunk size stream through upload_session/start, append_v2, and
// finish so large encrypted backups bypass Dropbox's 150 MB single-upload cap.
// Settings: { appKey?, folder? }  Secrets: { appSecret?, refreshToken }
import fs from "node:fs";
import { fetchWithTimeout, uploadFileWithTimeout } from "../outbound.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";
import { resolveDropboxAppKey } from "../dropboxAppConfig.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;
const DEFAULT_API_BASE = "https://api.dropboxapi.com";
const DEFAULT_CONTENT_BASE = "https://content.dropboxapi.com";
const DEFAULT_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB per chunk (well below Dropbox's 150 MB single-call limit)
const MAX_LIST_PAGES = 10;

// access_token cache keyed by destination id (refresh tokens live in the DB).
const tokenCache = new Map();

function folderPath(destination) {
  let folder = String(destination.settings?.folder || "/Plekt Backups").trim();
  if (!folder) folder = "/Plekt Backups";
  if (!folder.startsWith("/")) folder = `/${folder}`;
  return folder.replace(/\/+$/, "");
}

// Dropbox requires ASCII-only JSON in Dropbox-API-Arg HTTP headers.
function dropboxHeaderJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function ensureAccessToken(destination, tokenUrl = DEFAULT_TOKEN_URL) {
  const cached = tokenCache.get(destination.id);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;
  if (cached) tokenCache.delete(destination.id); // expired - drop so stale destinations don't accumulate

  const customAppKey = String(destination.settings?.appKey || "").trim();
  const appKey = customAppKey || resolveDropboxAppKey();
  const appSecret = customAppKey ? String(destination.secrets?.appSecret || "").trim() : "";
  const refreshToken = destination.secrets?.refreshToken;
  if (!appKey) throw new Error("Dropbox app key is required");
  if (!refreshToken) throw new Error("Dropbox is not connected - click Connect Dropbox first");

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (appSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`;
  } else {
    // Public PKCE client: authenticate refresh with client_id and no client_secret.
    params.set("client_id", appKey);
  }
  const response = await fetchWithTimeout(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const data = await response.json().catch((error) => {
    if (error?.code === "UPSTREAM_TIMEOUT" || error?.name === "AbortError") throw error;
    return {};
  });
  if (!response.ok) {
    throw new Error(`Dropbox token refresh failed: ${data.error_description || data.error || response.status}`);
  }
  tokenCache.set(destination.id, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 14400) * 1000,
  });
  return data.access_token;
}

export function createDropboxAdapter(destination, hooks = {}) {
  const apiBase = String(hooks.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, "");
  const contentBase = String(hooks.contentBaseUrl || DEFAULT_CONTENT_BASE).replace(/\/+$/, "");
  const tokenUrl = String(hooks.tokenUrl || DEFAULT_TOKEN_URL).trim();
  const chunkSize = Number(hooks.chunkSize) > 0 ? Number(hooks.chunkSize) : DEFAULT_CHUNK_BYTES;

  async function bearer() {
    return `Bearer ${await ensureAccessToken(destination, tokenUrl)}`;
  }

  async function uploadChunked(localPath, remotePath, size) {
    const firstEnd = Math.min(chunkSize, size) - 1;
    const startRes = await uploadFileWithTimeout(`${contentBase}/2/files/upload_session/start`, {
      method: "POST",
      headers: {
        Authorization: await bearer(),
        "Dropbox-API-Arg": dropboxHeaderJson({ close: false }),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(firstEnd + 1),
      },
      filePath: localPath,
      start: 0,
      end: firstEnd,
    }, 60_000);
    if (!startRes.ok) {
      throw new Error(`Dropbox upload session start failed (${startRes.status}): ${startRes.text.slice(0, 200)}`);
    }
    let sessionId = "";
    try {
      sessionId = JSON.parse(startRes.text)?.session_id || "";
    } catch {
      sessionId = "";
    }
    if (!sessionId) throw new Error("Dropbox upload session did not return a session_id");

    let offset = firstEnd + 1;
    while (offset < size) {
      const end = Math.min(offset + chunkSize, size) - 1;
      const chunkLen = end - offset + 1;
      const isLast = end === size - 1;
      if (isLast) {
        const finishRes = await uploadFileWithTimeout(`${contentBase}/2/files/upload_session/finish`, {
          method: "POST",
          headers: {
            Authorization: await bearer(),
            "Dropbox-API-Arg": dropboxHeaderJson({
              cursor: { session_id: sessionId, offset },
              commit: { path: remotePath, mode: "overwrite", mute: true },
            }),
            "Content-Type": "application/octet-stream",
            "Content-Length": String(chunkLen),
          },
          filePath: localPath,
          start: offset,
          end,
        }, 60_000);
        if (!finishRes.ok) {
          throw new Error(`Dropbox upload finish failed (${finishRes.status}): ${finishRes.text.slice(0, 200)}`);
        }
      } else {
        const appendRes = await uploadFileWithTimeout(`${contentBase}/2/files/upload_session/append_v2`, {
          method: "POST",
          headers: {
            Authorization: await bearer(),
            "Dropbox-API-Arg": dropboxHeaderJson({ cursor: { session_id: sessionId, offset }, close: false }),
            "Content-Type": "application/octet-stream",
            "Content-Length": String(chunkLen),
          },
          filePath: localPath,
          start: offset,
          end,
        }, 60_000);
        if (!appendRes.ok) {
          throw new Error(`Dropbox upload append failed (${appendRes.status}): ${appendRes.text.slice(0, 200)}`);
        }
      }
      offset = end + 1;
    }
  }

  return {
    async testConnection() {
      // Listing the app-folder root verifies token validity and files.metadata.read
      // without needing the extra account_info.read permission.
      const response = await fetchWithTimeout(`${apiBase}/2/files/list_folder`, {
        method: "POST",
        headers: { Authorization: await bearer(), "Content-Type": "application/json" },
        body: JSON.stringify({ path: "", limit: 1 }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Dropbox connection failed (${response.status}): ${text.slice(0, 160)}`);
      }
      return { ok: true, detail: "Dropbox app folder reachable" };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const { size } = await fs.promises.stat(localPath);
      const remotePath = `${folderPath(destination)}/${remoteName}`;
      if (size > chunkSize) {
        await uploadChunked(localPath, remotePath, size);
      } else {
        const arg = dropboxHeaderJson({ path: remotePath, mode: "overwrite", mute: true });
        const response = await uploadFileWithTimeout(`${contentBase}/2/files/upload`, {
          method: "POST",
          headers: {
            Authorization: await bearer(),
            "Dropbox-API-Arg": arg,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
          },
          filePath: localPath,
        }, 60_000);
        if (!response.ok) {
          throw new Error(`Dropbox upload failed (${response.status}): ${response.text.slice(0, 200)}`);
        }
      }
      return { bytes: size, durationMs: Date.now() - started };
    },

    async list() {
      const entries = [];
      let cursor = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const endpoint = cursor ? `${apiBase}/2/files/list_folder/continue` : `${apiBase}/2/files/list_folder`;
        const payload = cursor ? { cursor } : { path: folderPath(destination) };
        const response = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: { Authorization: await bearer(), "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.status === 409 && page === 0) return []; // folder not created yet
        if (!response.ok) throw new Error(`Dropbox list failed (${response.status})`);
        const data = await response.json().catch((error) => {
          if (error?.code === "UPSTREAM_TIMEOUT" || error?.name === "AbortError") throw error;
          return {};
        });
        for (const entry of data.entries || []) {
          if (entry[".tag"] !== "file" || !FILE_PATTERN.test(entry.name || "")) continue;
          entries.push({
            name: entry.name,
            sizeBytes: Number(entry.size) || 0,
            createdAt: entry.server_modified || new Date().toISOString(),
          });
        }
        if (!data.has_more || !data.cursor) break;
        cursor = data.cursor;
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async download(remoteName) {
      const arg = dropboxHeaderJson({ path: `${folderPath(destination)}/${remoteName}` });
      const response = await fetchWithTimeout(`${contentBase}/2/files/download`, {
        method: "POST",
        headers: { Authorization: await bearer(), "Dropbox-API-Arg": arg },
      }, 60_000);
      if (!response.ok) throw new Error(`Dropbox download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(remoteName) {
      const response = await fetchWithTimeout(`${apiBase}/2/files/delete_v2`, {
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
