import fs from "node:fs";
import path from "node:path";
import { adminDb, parseJson, toJson } from "../db.js";
import { DATA_DIR, FULL_BACKUPS_DIR, MEDIA_DIR } from "../paths.js";
import { getSharedMetadataDb, purgeMigratedProviderCachesFromAdmin } from "./sharedMetadataStore.js";
import { listNonAdminUsers, multiUserEnabled } from "./tenancy.js";
import { getTenantDatabaseForUser } from "./tenantDatabase.js";
import { sweepOrphanArtwork } from "./diskMaintenance.js";
import { pruneLogArchive } from "./diagnosticLogger.js";
import { loadPlektBackupConfig } from "./plektBackups.js";
import { readEncryptedEnvelope } from "./plektRestore.js";
import { FULL_BACKUP_FILE_PATTERN } from "./backupNames.js";
import { yieldToEventLoop } from "./eventLoop.js";
import {
  compactSharedMetadataStoreAsync,
  compactUserDatabaseAsync,
  countUncompactedSharedRows,
  countUncompactedUserRows,
  hasReclaimableFreelist,
  recompressLegacyPlektBackups,
  reoptimizeCachedArtwork,
  vacuumIfReclaimable,
} from "./storageCompaction.js";

const STORAGE_UPGRADE_STATE_ID = "storageUpgradeState";
const ARTWORK_OPTIMIZATION_VERSION = 1;

let stopped = false;
let startupUpgradePromise = null;
let artworkTaskPromise = null;
let backupTaskPromise = null;

const state = {
  db: {
    active: false,
    stage: "idle",
    label: "",
    percent: 0,
    processed: 0,
    total: 0,
    savedBytes: 0,
    startedAt: 0,
    finishedAt: 0,
    error: "",
  },
  artwork: {
    active: false,
    scanned: 0,
    total: 0,
    optimized: 0,
    savedBytes: 0,
    startedAt: 0,
    finishedAt: 0,
    error: "",
  },
  backups: {
    active: false,
    scanned: 0,
    recompressed: 0,
    skipped: 0,
    savedBytes: 0,
    startedAt: 0,
    finishedAt: 0,
    error: "",
  },
};

function allUserDatabases() {
  const list = [adminDb];
  if (multiUserEnabled()) {
    for (const user of listNonAdminUsers()) {
      try {
        list.push(getTenantDatabaseForUser(user.name));
      } catch { /* ignore inaccessible tenant */ }
    }
  }
  return list;
}

function readUpgradeMeta() {
  try {
    const row = adminDb.prepare("SELECT data FROM runtime_state WHERE id = ?").get(STORAGE_UPGRADE_STATE_ID);
    return parseJson(row?.data, {}) || {};
  } catch {
    return {};
  }
}

function writeUpgradeMeta(patch = {}) {
  try {
    const next = { ...readUpgradeMeta(), ...patch, updatedAt: Date.now() };
    adminDb
      .prepare("INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(STORAGE_UPGRADE_STATE_ID, toJson(next), Date.now());
  } catch { /* ignore */ }
}

export function markArtworkOptimizationComplete(timestamp = Date.now()) {
  writeUpgradeMeta({
    artworkOptimizationVersion: ARTWORK_OPTIMIZATION_VERSION,
    lastArtworkOptimizedAt: timestamp,
  });
}

function fileSize(targetPath) {
  try {
    return targetPath && fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
  } catch {
    return 0;
  }
}

function dirSize(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return 0;
  let total = 0;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.size;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      total += dirSize(path.join(targetPath, entry.name));
    }
  } catch { /* ignore */ }
  return total;
}

function countLegacyUncompressedBackups(backupsDir = FULL_BACKUPS_DIR) {
  if (!fs.existsSync(backupsDir)) return { count: 0, totalBytes: 0 };
  let count = 0;
  let totalBytes = 0;
  for (const name of fs.readdirSync(backupsDir)) {
    if (!FULL_BACKUP_FILE_PATTERN.test(name)) continue;
    const full = path.join(backupsDir, name);
    try {
      const env = readEncryptedEnvelope(full);
      if (env && !env.gzip) {
        count += 1;
        totalBytes += fs.statSync(full).size;
      }
    } catch { /* ignore unreadable file */ }
  }
  return { count, totalBytes };
}

export function isDatabaseUpgradeActive() {
  return state.db.active;
}

export function getPublicUpgradeStatus() {
  return {
    active: state.db.active,
    stage: state.db.stage,
    label: state.db.label,
    percent: state.db.percent,
    processed: state.db.processed,
    total: state.db.total,
    savedBytes: state.db.savedBytes,
    startedAt: state.db.startedAt,
    finishedAt: state.db.finishedAt,
    error: state.db.error,
  };
}

export function getStorageStatus() {
  const shared = getSharedMetadataDb(DATA_DIR);
  const userDbs = allUserDatabases();
  const userDbBytes = userDbs.reduce((sum, database) => sum + fileSize(database.name), 0);
  const sharedDbBytes = fileSize(shared.name);
  const mediaBytes = dirSize(MEDIA_DIR);
  const logsBytes = dirSize(path.join(DATA_DIR, "logs"));
  const backupsBytes = dirSize(path.join(DATA_DIR, "backups"));
  const legacyBackups = countLegacyUncompressedBackups(FULL_BACKUPS_DIR);
  const backupConfig = loadPlektBackupConfig();
  const meta = readUpgradeMeta();

  return {
    sizes: {
      databaseBytes: userDbBytes,
      sharedMetadataBytes: sharedDbBytes,
      mediaBytes,
      logsBytes,
      backupsBytes,
      totalBytes: userDbBytes + sharedDbBytes + mediaBytes + logsBytes + backupsBytes,
    },
    legacyBackups: {
      count: legacyBackups.count,
      bytes: legacyBackups.totalBytes,
      hasStoredPassphrase: Boolean(backupConfig.passphrase || backupConfig.remotePassphrase),
    },
    pendingDbRows: countUncompactedSharedRows(shared) + userDbs.reduce((sum, d) => sum + countUncompactedUserRows(d), 0),
    artworkOptimizedVersion: Number(meta.artworkOptimizationVersion || 0),
    db: { ...state.db },
    artwork: { ...state.artwork },
    backups: { ...state.backups },
  };
}

export function hasPendingDatabaseUpgrade() {
  const shared = getSharedMetadataDb(DATA_DIR);
  const userDbs = allUserDatabases();
  if (countUncompactedSharedRows(shared) > 0) return true;
  if (userDbs.some((database) => countUncompactedUserRows(database) > 0)) return true;
  if (hasReclaimableFreelist(shared)) return true;
  if (userDbs.some((database) => hasReclaimableFreelist(database))) return true;
  return false;
}

export async function runDatabaseCompactionTask({ showUpgradeScreen = false } = {}) {
  if (state.db.active && startupUpgradePromise) return startupUpgradePromise;

  const shared = getSharedMetadataDb(DATA_DIR);
  const userDbs = allUserDatabases();
  const sharedPending = countUncompactedSharedRows(shared);
  const userPending = userDbs.reduce((sum, d) => sum + countUncompactedUserRows(d), 0);
  const needsVacuum = hasReclaimableFreelist(shared) || userDbs.some((d) => hasReclaimableFreelist(d));

  if (showUpgradeScreen && sharedPending === 0 && userPending === 0 && !needsVacuum) {
    state.db.stage = "complete";
    state.db.percent = 100;
    return { skipped: true };
  }

  const totalWork = Math.max(1, sharedPending + userPending);
  state.db = {
    active: true,
    stage: "purging",
    label: "Preparing database storage optimization…",
    percent: 2,
    processed: 0,
    total: sharedPending + userPending,
    savedBytes: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
  };

  const task = (async () => {
    try {
      await yieldToEventLoop();
      purgeMigratedProviderCachesFromAdmin(adminDb, DATA_DIR);

      const onBatch = ({ rows = 0, savedBytes = 0 }) => {
        state.db.processed += rows;
        state.db.savedBytes += savedBytes;
        const pct = Math.min(88, Math.round(5 + (state.db.processed / totalWork) * 83));
        state.db.percent = Math.max(state.db.percent, pct);
      };

      if (sharedPending > 0 && !stopped) {
        state.db.stage = "shared-metadata";
        state.db.label = "Compressing metadata cache…";
        await yieldToEventLoop();
        await compactSharedMetadataStoreAsync(shared, {
          vacuum: false,
          batchSize: 150,
          onBatch,
          shouldStop: () => stopped,
        });
      }

      if (userPending > 0 && !stopped) {
        state.db.stage = "database";
        state.db.label = "Compressing audit history and sync reports…";
        await yieldToEventLoop();
        for (const userDb of userDbs) {
          if (stopped) break;
          await compactUserDatabaseAsync(userDb, {
            vacuum: false,
            batchSize: 400,
            onBatch,
            shouldStop: () => stopped,
          });
        }
      }

      if (!stopped) {
        state.db.stage = "vacuuming";
        state.db.label = "Reclaiming freed database space…";
        state.db.percent = Math.max(state.db.percent, 90);
        await yieldToEventLoop();
        const sharedVac = vacuumIfReclaimable(shared, { force: sharedPending > 0 || hasReclaimableFreelist(shared) });
        state.db.savedBytes = Math.max(state.db.savedBytes, sharedVac.reclaimedBytes);
        for (const userDb of userDbs) {
          if (stopped) break;
          await yieldToEventLoop();
          const vac = vacuumIfReclaimable(userDb, { force: userPending > 0 || hasReclaimableFreelist(userDb) });
          state.db.savedBytes += vac.reclaimedBytes;
        }
        pruneLogArchive();
      }

      state.db.stage = "complete";
      state.db.label = "Storage optimization complete.";
      state.db.percent = 100;
      state.db.finishedAt = Date.now();
      return { ok: true, savedBytes: state.db.savedBytes };
    } catch (error) {
      state.db.stage = "failed";
      state.db.error = error?.message || String(error);
      state.db.label = "Storage upgrade encountered an error; starting normally.";
      state.db.finishedAt = Date.now();
      console.error("Storage upgrade failed:", error);
      return { ok: false, error: state.db.error };
    } finally {
      state.db.active = false;
    }
  })();

  startupUpgradePromise = task;
  try {
    return await task;
  } finally {
    if (startupUpgradePromise === task) startupUpgradePromise = null;
  }
}

export function startStartupDatabaseUpgrade() {
  if (!hasPendingDatabaseUpgrade()) return null;
  return runDatabaseCompactionTask({ showUpgradeScreen: true });
}

export async function waitForStartupDatabaseUpgrade() {
  if (startupUpgradePromise) {
    await startupUpgradePromise.catch(() => null);
  }
}

export function startArtworkOptimizationTask({ throttleMs = 0, background = false } = {}) {
  if (state.artwork.active && artworkTaskPromise) return artworkTaskPromise;
  if (background) {
    const meta = readUpgradeMeta();
    if (Number(meta.artworkOptimizationVersion || 0) >= ARTWORK_OPTIMIZATION_VERSION) {
      return null;
    }
  }

  state.artwork = {
    active: true,
    scanned: 0,
    total: 0,
    optimized: 0,
    savedBytes: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
  };

  const task = (async () => {
    try {
      const userDbs = allUserDatabases();
      sweepOrphanArtwork({ mediaDir: MEDIA_DIR, databases: userDbs });
      const result = await reoptimizeCachedArtwork({
        mediaDir: MEDIA_DIR,
        databases: userDbs,
        throttleMs,
        shouldStop: () => stopped,
        onProgress: ({ scanned, total, optimized, savedBytes }) => {
          state.artwork.scanned = scanned;
          state.artwork.total = total;
          state.artwork.optimized = optimized;
          state.artwork.savedBytes = savedBytes;
        },
      });
      state.artwork.scanned = result.scanned;
      state.artwork.total = result.total;
      state.artwork.optimized = result.optimized;
      state.artwork.savedBytes = result.savedBytes;
      state.artwork.finishedAt = Date.now();
      if (!result.stopped) {
        writeUpgradeMeta({ artworkOptimizationVersion: ARTWORK_OPTIMIZATION_VERSION, lastArtworkOptimizedAt: Date.now() });
      }
      return result;
    } catch (error) {
      state.artwork.error = error?.message || String(error);
      state.artwork.finishedAt = Date.now();
      console.error("Artwork optimization failed:", error);
      return { ok: false, error: state.artwork.error };
    } finally {
      state.artwork.active = false;
    }
  })();

  artworkTaskPromise = task;
  task.finally(() => {
    if (artworkTaskPromise === task) artworkTaskPromise = null;
  });
  return task;
}

export function scheduleBackgroundArtworkOptimization({ delayMs = 15_000, throttleMs = 75 } = {}) {
  const meta = readUpgradeMeta();
  if (Number(meta.artworkOptimizationVersion || 0) >= ARTWORK_OPTIMIZATION_VERSION) return null;
  const timer = setTimeout(() => {
    if (stopped) return;
    startArtworkOptimizationTask({ throttleMs, background: true });
  }, delayMs);
  timer.unref?.();
  return timer;
}

export function startLegacyBackupRecompressionTask({ passphrase = "" } = {}) {
  if (state.backups.active && backupTaskPromise) return backupTaskPromise;

  const config = loadPlektBackupConfig();
  const effectivePassphrase = String(passphrase || config.passphrase || config.remotePassphrase || "").trim();
  if (!effectivePassphrase) {
    throw Object.assign(new Error("A backup encryption passphrase is required to recompress legacy backups."), { status: 400 });
  }

  state.backups = {
    active: true,
    scanned: 0,
    recompressed: 0,
    skipped: 0,
    savedBytes: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
  };

  const task = (async () => {
    try {
      const result = await recompressLegacyPlektBackups({
        backupsDir: FULL_BACKUPS_DIR,
        passphrase: effectivePassphrase,
        verify: true,
      });
      state.backups.scanned = result.scanned;
      state.backups.recompressed = result.recompressed;
      state.backups.skipped = result.skipped;
      state.backups.savedBytes = result.savedBytes;
      if (result.errors?.length) {
        state.backups.error = result.errors.map((e) => `${e.name}: ${e.error}`).join("; ");
      }
      state.backups.finishedAt = Date.now();
      return result;
    } catch (error) {
      state.backups.error = error?.message || String(error);
      state.backups.finishedAt = Date.now();
      return { ok: false, error: state.backups.error };
    } finally {
      state.backups.active = false;
    }
  })();

  backupTaskPromise = task;
  task.finally(() => {
    if (backupTaskPromise === task) backupTaskPromise = null;
  });
  return task;
}

export async function stopStorageUpgrade() {
  stopped = true;
  await Promise.allSettled([startupUpgradePromise, artworkTaskPromise, backupTaskPromise].filter(Boolean));
}

export function resetStorageUpgradeForTests() {
  stopped = false;
  state.db.active = false;
  state.db.stage = "idle";
  state.db.label = "";
  state.db.percent = 0;
  state.db.processed = 0;
  state.db.total = 0;
  state.db.savedBytes = 0;
  state.db.error = "";
  state.artwork.active = false;
  state.backups.active = false;
}
