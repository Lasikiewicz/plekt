// Local-folder adapter - copies the backup to any filesystem path. Pointing this at
// a OneDrive/Dropbox/Nextcloud desktop-sync folder gives cloud backups with no API,
// OAuth, or app registration: the sync client uploads the file. Also handy for a
// mounted NAS share. Settings: { path }  Secrets: none
import fs from "node:fs";
import path from "node:path";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;

function targetDir(destination) {
  const dir = String(destination.settings?.path || "").trim();
  if (!dir) throw new Error("Folder path is required");
  return dir;
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
