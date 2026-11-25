import { adminDb, db, getActiveUserDb } from "../db.js";
import { createPerUserState } from "./perUserState.js";
import { getSharedMetadataDb, purgeMigratedProviderCachesFromAdmin } from "./sharedMetadataStore.js";
import { ownsArtworkFiles } from "./userContext.js";
import { pruneLogArchive } from "./diagnosticLogger.js";
import { sweepOrphanArtwork } from "./diskMaintenance.js";
import { compactSharedMetadataStore, compactUserDatabase, vacuumIfReclaimable } from "./storageCompaction.js";
import { pruneExpiredWatchAuditEvents } from "./watchAudit.js";

// SQLite's own planner statistics refresh. Cheap when there is little to do,
// and it keeps query plans current as tables grow, so it runs once a day.
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const optimizeCadence = createPerUserState(() => ({ lastOptimizeAt: 0 }));

export function runDatabaseMaintenance() {
  const isOwner = ownsArtworkFiles();
  const shared = isOwner ? getSharedMetadataDb() : null;
  const activeDb = getActiveUserDb();

  let purgedAdminCaches = null;
  let sharedCompaction = null;
  if (isOwner) {
    purgedAdminCaches = purgeMigratedProviderCachesFromAdmin(adminDb);
    sharedCompaction = compactSharedMetadataStore(shared, { vacuum: false });
  }
  const userCompaction = compactUserDatabase(activeDb, { vacuum: false });
  const auditRowsPruned = pruneExpiredWatchAuditEvents();

  const checkpoints = [];
  const vacuums = [];
  for (const database of [db, ...(shared ? [shared] : [])]) {
    database.pragma("journal_size_limit = 16777216");
    database.pragma("optimize");
    const forceVacuum = (database === shared && sharedCompaction?.compressedRows > 0)
      || (database === db && (purgedAdminCaches?.deleted > 0 || userCompaction?.compressedRows > 0 || userCompaction?.prunedPlans > 0));
    vacuums.push(vacuumIfReclaimable(database, { force: forceVacuum }));
    checkpoints.push(database.pragma("wal_checkpoint(TRUNCATE)"));
  }
  return {
    checkpoints,
    vacuums,
    auditRowsPruned,
    compaction: { user: userCompaction, ...(sharedCompaction ? { shared: sharedCompaction } : {}) },
    ...(isOwner ? { artwork: sweepOrphanArtwork(), logsRemoved: pruneLogArchive() } : {}),
  };
}

export function runDbOptimizeIfDue(now = Date.now(), runOptimize = runDatabaseMaintenance) {
  const cadence = optimizeCadence();
  if (cadence.lastOptimizeAt && now - cadence.lastOptimizeAt < DB_OPTIMIZE_INTERVAL_MS) return { ran: false };
  cadence.lastOptimizeAt = now;
  runOptimize();
  return { ran: true };
}
