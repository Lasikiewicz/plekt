import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandEnv } from "./utils/brandEnv.js";

// Resolve the writable data directory. Defaults to <repo>/data for bare-metal;
// the Docker image sets DATA_DIR=/data with a mounted volume.
const DB_FILE = "plekt.db";
const LEGACY_DB_FILE = "plembfin.db";

// The database was plembfin.db before the rename. An install that has one keeps
// using it: a second, empty database must never be created beside it.
export function legacyDbFileName() {
  return LEGACY_DB_FILE;
}

export function resolveDbPath(dataDir) {
  const legacyPath = path.join(dataDir, LEGACY_DB_FILE);
  return fs.existsSync(legacyPath) ? legacyPath : path.join(dataDir, DB_FILE);
}

// The Windows service kept its data in ProgramData\Plembfin before the rename.
// The installer moves that folder; until it has, or if the move failed, the old
// folder is still the one holding the database.
export function resolveWindowsServiceDataDir(programData) {
  const current = path.join(programData, "Plekt");
  const legacy = path.join(programData, "Plembfin");
  const hasDatabase = (dir) => [DB_FILE, LEGACY_DB_FILE].some((name) => fs.existsSync(path.join(dir, name)));
  return !hasDatabase(current) && fs.existsSync(legacy) ? legacy : current;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const configuredDataDir = String(process.env.DATA_DIR || "").trim();
const isWindowsService = process.platform === "win32" && brandEnv("WINDOWS_SERVICE") === "1";
const windowsServiceDataDir = isWindowsService
  ? resolveWindowsServiceDataDir(process.env.ProgramData || path.join(path.parse(repoRoot).root, "ProgramData"))
  : "";
const usableConfiguredDataDir = configuredDataDir && !/%[^%]+%/.test(configuredDataDir)
  ? configuredDataDir
  : windowsServiceDataDir;

export const DEFAULT_DATA_DIR = path.join(repoRoot, "data");
export const DATA_DIR = path.resolve(usableConfiguredDataDir || DEFAULT_DATA_DIR);
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const POSTERS_DIR = path.join(MEDIA_DIR, "posters");
export const BACKDROPS_DIR = path.join(MEDIA_DIR, "backdrops");
export const PROFILES_DIR = path.join(MEDIA_DIR, "profiles");
export const LOGOS_DIR = path.join(MEDIA_DIR, "logos");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const WATCH_HISTORY_BACKUPS_DIR = path.join(BACKUPS_DIR, "watch-history");
export const LEGACY_FULL_BACKUPS_DIR = path.join(BACKUPS_DIR, "plembfin");
export const FULL_BACKUPS_DIR = path.join(BACKUPS_DIR, "plekt");
export const DB_PATH = resolveDbPath(DATA_DIR);
// Install-wide provider metadata caches and (optionally) mirrored keys.
// Lives beside the admin DB so every user in one process shares one store.
export const SHARED_METADATA_DB_FILE = "shared-metadata.db";
export const SHARED_METADATA_DB_PATH = path.join(DATA_DIR, SHARED_METADATA_DB_FILE);
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const CREDENTIAL_KEY_PATH = path.join(DATA_DIR, "credential.key");
export const PUBLIC_DIR = path.join(repoRoot, "public");

// Migrates an existing pre-rename backups/plembfin folder into backups/plekt.
// Idempotent: a clean rename runs when backups/plekt does not exist yet, and
// otherwise individual files are moved without overwriting newer copies.
export function migrateLegacyFullBackupsDir(backupsDir = BACKUPS_DIR) {
  const legacyDir = path.join(backupsDir, "plembfin");
  const currentDir = path.join(backupsDir, "plekt");
  if (!fs.existsSync(legacyDir)) return { migrated: false, movedFiles: 0 };
  try {
    if (!fs.existsSync(currentDir)) {
      fs.renameSync(legacyDir, currentDir);
      return { migrated: true, renamed: true, movedFiles: 0 };
    }
    let movedFiles = 0;
    for (const entry of fs.readdirSync(legacyDir)) {
      const from = path.join(legacyDir, entry);
      const to = path.join(currentDir, entry);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      }
      movedFiles += 1;
    }
    if (fs.readdirSync(legacyDir).length === 0) {
      fs.rmdirSync(legacyDir);
    }
    return { migrated: movedFiles > 0, renamed: false, movedFiles };
  } catch (error) {
    console.warn(`Could not finish migrating legacy backups folder (${legacyDir} -> ${currentDir}): ${error.message}`);
    return { migrated: false, movedFiles: 0, error: error.message };
  }
}

export function ensureDataDirs() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  migrateLegacyFullBackupsDir(BACKUPS_DIR);
  for (const dir of [DATA_DIR, MEDIA_DIR, POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, LOGOS_DIR, BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, FULL_BACKUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
