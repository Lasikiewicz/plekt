// External / mounted folder adapter - copies backups to a separate filesystem path
// such as a mounted NAS share (SMB/NFS), external drive, separate Docker volume, or
// desktop-synced cloud folder. Refuses Plekt's own built-in local backup directories
// so remote mirroring cannot overwrite or prune local backups. Settings: { path }
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, FULL_BACKUPS_DIR, LEGACY_FULL_BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR } from "../../paths.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;

function sameOrInside(candidate, base) {
  const normCandidate = path.resolve(candidate);
  const normBase = path.resolve(base);
  const rel = path.relative(
    process.platform === "win32" ? normBase.toLowerCase() : normBase,
    process.platform === "win32" ? normCandidate.toLowerCase() : normCandidate,
  );
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function targetDir(destination) {
  const dir = String(destination.settings?.path || "").trim();
  if (!dir) throw new Error("Folder path is required");
  if (!path.isAbsolute(dir)) {
    throw new Error("Folder path must be an absolute path (for example /mnt/nas/plekt-backups or D:\\Backups\\Plekt)");
  }
  const resolved = path.resolve(dir);
  for (const ownDir of [BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, FULL_BACKUPS_DIR, LEGACY_FULL_BACKUPS_DIR]) {
    if (sameOrInside(resolved, ownDir)) {
      throw new Error("Choose a folder outside Plekt's built-in local backups directory");
    }
  }
  return resolved;
}

export function createFolderAdapter(destination) {
  return {
    async testConnection() {
      const dir = targetDir(destination);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return { ok: true, detail: `Writable folder: ${dir}` };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const dir = targetDir(destination);
      fs.mkdirSync(dir, { recursive: true });
      const finalPath = path.join(dir, remoteName);
      const temporary = `${finalPath}.tmp-${process.pid}`;
      fs.copyFileSync(localPath, temporary);
      fs.renameSync(temporary, finalPath);
      return { bytes: fs.statSync(finalPath).size, durationMs: Date.now() - started };
    },

    async list() {
      const dir = targetDir(destination);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((name) => FILE_PATTERN.test(name))
        .map((name) => {
          const stat = fs.statSync(path.join(dir, name));
          return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async download(remoteName) {
      const target = path.join(targetDir(destination), remoteName);
      if (!fs.existsSync(target)) throw new Error(`Backup not found in folder: ${remoteName}`);
      return fs.readFileSync(target);
    },

    async delete(remoteName) {
      const target = path.join(targetDir(destination), remoteName);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    },
  };
}
