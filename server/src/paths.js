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

export const DATA_DIR = path.resolve(usableConfiguredDataDir || path.join(repoRoot, "data"));
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const POSTERS_DIR = path.join(MEDIA_DIR, "posters");
export const BACKDROPS_DIR = path.join(MEDIA_DIR, "backdrops");
export const PROFILES_DIR = path.join(MEDIA_DIR, "profiles");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const WATCH_HISTORY_BACKUPS_DIR = path.join(BACKUPS_DIR, "watch-history");
export const FULL_BACKUPS_DIR = path.join(BACKUPS_DIR, "plembfin");
export const DB_PATH = resolveDbPath(DATA_DIR);
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const CREDENTIAL_KEY_PATH = path.join(DATA_DIR, "credential.key");
export const PUBLIC_DIR = path.join(repoRoot, "public");

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, MEDIA_DIR, POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR, BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, FULL_BACKUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
