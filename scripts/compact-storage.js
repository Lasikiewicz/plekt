#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "../server/src/env.js";

loadLocalEnv();

const { DATA_DIR, FULL_BACKUPS_DIR, MEDIA_DIR } = await import("../server/src/paths.js");
const { adminDb, closeAllDatabases } = await import("../server/src/db.js");
const { getSharedMetadataDb, purgeMigratedProviderCachesFromAdmin, closeAllSharedMetadataDatabases } = await import("../server/src/utils/sharedMetadataStore.js");
const { listNonAdminUsers, multiUserEnabled } = await import("../server/src/utils/tenancy.js");
const { getTenantDatabaseForUser, closeAllTenantDatabases } = await import("../server/src/utils/tenantDatabase.js");
const { pruneLogArchive } = await import("../server/src/utils/diagnosticLogger.js");
const { sweepOrphanArtwork } = await import("../server/src/utils/diskMaintenance.js");
const { loadPlektBackupConfig } = await import("../server/src/utils/plektBackups.js");
const {
  compactSharedMetadataStore,
  compactUserDatabase,
  reoptimizeCachedArtwork,
  recompressLegacyPlektBackups,
  vacuumIfReclaimable,
} = await import("../server/src/utils/storageCompaction.js");
const { markArtworkOptimizationComplete } = await import("../server/src/utils/storageUpgrade.js");

const args = new Set(process.argv.slice(2));
const includeArtwork = !args.has("--skip-artwork");
const includeBackups = !args.has("--skip-backups");

function dirSize(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    total += dirSize(path.join(target, entry.name));
  }
  return total;
}

const fmtMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

async function main() {
  const beforeTotal = dirSize(DATA_DIR);
  const shared = getSharedMetadataDb(DATA_DIR);

  const purged = purgeMigratedProviderCachesFromAdmin(adminDb, DATA_DIR);
  const sharedResult = compactSharedMetadataStore(shared, { vacuum: true });

  const userDbs = [adminDb, ...(multiUserEnabled() ? listNonAdminUsers().map((u) => getTenantDatabaseForUser(u.name)) : [])];
  const userResults = [];
  for (const userDb of userDbs) {
    const compacted = compactUserDatabase(userDb, { vacuum: false });
    const vacuumed = vacuumIfReclaimable(userDb, { force: true });
    userResults.push({ db: path.basename(userDb.name), ...compacted, vacuum: vacuumed });
  }

  const orphanArtwork = sweepOrphanArtwork({ mediaDir: MEDIA_DIR, databases: userDbs });
  const artworkResult = includeArtwork
    ? await reoptimizeCachedArtwork({ mediaDir: MEDIA_DIR, databases: userDbs })
    : { skipped: true };
  if (!artworkResult.skipped && !artworkResult.stopped) {
    markArtworkOptimizationComplete();
  }

  const logsRemoved = pruneLogArchive();

  let backupsResult = { skipped: true };
  if (includeBackups) {
    const config = loadPlektBackupConfig();
    const passphrase = config.passphrase || config.remotePassphrase || "";
    if (passphrase) {
      backupsResult = await recompressLegacyPlektBackups({ backupsDir: FULL_BACKUPS_DIR, passphrase, verify: true });
    } else {
      backupsResult = { skipped: true, reason: "no-stored-passphrase" };
    }
  }

  const afterTotal = dirSize(DATA_DIR);
  console.log(JSON.stringify({
    dataDir: DATA_DIR,
    before: fmtMB(beforeTotal),
    after: fmtMB(afterTotal),
    saved: fmtMB(Math.max(0, beforeTotal - afterTotal)),
    purgedAdminCaches: purged,
    sharedMetadata: {
      compressedRows: sharedResult.compressedRows,
      before: fmtMB(sharedResult.vacuum?.beforeBytes || 0),
      after: fmtMB(sharedResult.vacuum?.afterBytes || 0),
    },
    userDatabases: userResults.map((r) => ({
      db: r.db,
      compressedRows: r.compressedRows,
      prunedPlans: r.prunedPlans,
      before: fmtMB(r.vacuum?.beforeBytes || 0),
      after: fmtMB(r.vacuum?.afterBytes || 0),
    })),
    orphanArtwork,
    artwork: artworkResult.skipped
      ? artworkResult
      : {
        scanned: artworkResult.scanned,
        optimized: artworkResult.optimized,
        before: fmtMB(artworkResult.bytesBefore),
        after: fmtMB(artworkResult.bytesAfter),
        saved: fmtMB(artworkResult.savedBytes),
      },
    logsRemoved,
    backups: backupsResult.skipped
      ? backupsResult
      : {
        scanned: backupsResult.scanned,
        recompressed: backupsResult.recompressed,
        skipped: backupsResult.skipped,
        before: fmtMB(backupsResult.bytesBefore),
        after: fmtMB(backupsResult.bytesAfter),
        saved: fmtMB(backupsResult.savedBytes),
        errors: backupsResult.errors,
      },
  }, null, 2));

  try { closeAllTenantDatabases(); } catch { /* ignore */ }
  try { closeAllSharedMetadataDatabases(); } catch { /* ignore */ }
  try { closeAllDatabases?.(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((error) => {
  console.error("Storage compaction failed:", error);
  process.exit(1);
});
