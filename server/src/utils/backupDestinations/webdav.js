// WebDAV adapter - covers Nextcloud, ownCloud, Hetzner Storage Box, Apache mod_dav, and most NAS units.
// Settings: { url, username?, directory? }  Secrets: { password? }
import fs from "node:fs";
import { fetchWithTimeout, uploadFileWithTimeout } from "../outbound.js";
import path from "node:path";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;

function baseUrl(destination) {
  let url = String(destination.settings?.url || "").trim();
  if (!url) throw new Error("WebDAV URL is required");
  if (!/^https?:\/\//i.test(url)) throw new Error("WebDAV URL must start with http:// or https://");
  if (!url.endsWith("/")) url += "/";
  const directory = String(destination.settings?.directory || "").trim().replace(/^\/+|\/+$/g, "");
  if (!directory) return url;
  const encoded = directory.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${url}${encoded}/`;
}

function authHeaders(destination) {
  const username = destination.settings?.username || "";
  const password = destination.secrets?.password || "";
  if (!username && !password) return {};
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function remoteUrl(destination, name) {
  return new URL(encodeURIComponent(name), baseUrl(destination)).toString();
}

async function ensureCollection(destination) {
  // MKCOL is a no-op (405/301) when the collection already exists; some servers
  // also return 403 on an existing root collection. Create nested directory
  // segments one level at a time when a subdirectory is configured.
  const directory = String(destination.settings?.directory || "").trim().replace(/^\/+|\/+$/g, "");
  const root = String(destination.settings?.url || "").trim().replace(/\/+$/, "") + "/";
  const targets = [];
  if (directory) {
    let cursor = root;
    for (const segment of directory.split("/").filter(Boolean)) {
      cursor = `${cursor}${encodeURIComponent(segment)}/`;
      targets.push(cursor);
    }
  } else {
    targets.push(baseUrl(destination));
  }
  for (const target of targets) {
    const response = await fetchWithTimeout(target, { method: "MKCOL", headers: authHeaders(destination) });
    if (![200, 201, 204, 301, 405].includes(response.status)) {
      // If no subdirectory was specified and the server refuses MKCOL on its
      // existing root (common on Nextcloud/Synology shares), let PUT decide.
      if (!directory && (response.status === 403 || response.status === 409)) continue;
      const body = await response.text().catch(() => "");
      throw new Error(`WebDAV MKCOL failed (${response.status}): ${body.slice(0, 200)}`);
    }
  }
}

export function createWebdavAdapter(destination) {
  return {
    async testConnection() {
      const response = await fetchWithTimeout(baseUrl(destination), {
        method: "PROPFIND",
        headers: { ...authHeaders(destination), Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      });
      if (response.status === 401) throw new Error("WebDAV authentication failed (401)");
      if (response.status === 404) throw new Error("WebDAV path not found (404)");
      if (!(response.status === 207 || response.ok)) {
        throw new Error(`WebDAV connection failed (${response.status})`);
      }
      return { ok: true, detail: "Reachable" };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      await ensureCollection(destination);
      const { size } = await fs.promises.stat(localPath);
      const contentType = remoteName.endsWith(".gz") ? "application/gzip" : "application/octet-stream";
      const response = await uploadFileWithTimeout(remoteUrl(destination, remoteName), {
        method: "PUT",
        headers: { ...authHeaders(destination), "Content-Type": contentType, "Content-Length": String(size) },
        filePath: localPath,
      }, 60_000);
      if (!(response.ok || response.status === 201 || response.status === 204)) {
        throw new Error(`WebDAV upload failed (${response.status}): ${response.text.slice(0, 200)}`);
      }
      return { bytes: size, durationMs: Date.now() - started };
    },

    async list() {
      const response = await fetchWithTimeout(baseUrl(destination), {
        method: "PROPFIND",
        headers: { ...authHeaders(destination), Depth: "1", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
      });
      if (!(response.status === 207 || response.ok)) {
        throw new Error(`WebDAV list failed (${response.status})`);
      }
      const xml = await response.text();
      return parsePropfind(xml);
    },

    async download(remoteName) {
      const response = await fetchWithTimeout(remoteUrl(destination, remoteName), { headers: authHeaders(destination) }, 60_000);
      if (!response.ok) throw new Error(`WebDAV download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(remoteName) {
      const response = await fetchWithTimeout(remoteUrl(destination, remoteName), {
        method: "DELETE",
        headers: authHeaders(destination),
      });
      if (!(response.ok || response.status === 204 || response.status === 404)) {
        throw new Error(`WebDAV delete failed (${response.status})`);
      }
    },
  };
}

// Tolerant PROPFIND parser: namespace prefixes vary (d:, D:, lp1:), so match by
// local element name and only keep entries whose basename looks like our backups.
function parsePropfind(xml) {
  const out = [];
  const blocks = xml.match(/<[^>]*response[^>]*>[\s\S]*?<\/[^>]*response>/gi) || [];
  for (const block of blocks) {
    const href = (block.match(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i) || [])[1];
    if (!href) continue;
    let name = "";
    try {
      name = decodeURIComponent(path.posix.basename(href.trim().replace(/\/+$/, "")));
    } catch {
      name = path.posix.basename(href.trim().replace(/\/+$/, ""));
    }
    if (!FILE_PATTERN.test(name)) continue;
    const sizeRaw = (block.match(/<[^>]*getcontentlength[^>]*>([\s\S]*?)<\/[^>]*getcontentlength>/i) || [])[1];
    const modRaw = (block.match(/<[^>]*getlastmodified[^>]*>([\s\S]*?)<\/[^>]*getlastmodified>/i) || [])[1];
    out.push({
      name,
      sizeBytes: Number(sizeRaw) || 0,
      createdAt: modRaw ? new Date(modRaw.trim()).toISOString() : new Date().toISOString(),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
