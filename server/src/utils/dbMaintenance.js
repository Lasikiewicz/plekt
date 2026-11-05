import { db } from "../db.js";
import { createPerUserState } from "./perUserState.js";
import { getSharedMetadataDb } from "./sharedMetadataStore.js";
import { ownsArtworkFiles } from "./userContext.js";
import { pruneLogArchive } from "./diagnosticLogger.js";
import { sweepOrphanArtwork } from "./diskMaintenance.js";

// SQLite's own planner statistics refresh. Cheap when there is little to do,
// and it keeps query plans current as tables grow, so it runs once a day.
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const optimizeCadence = createPerUserState(() => ({ lastOptimizeAt: 0 }));

export function runDatabaseMaintenance() {
  const checkpoints = [];
  for (const database of [db, ...(ownsArtworkFiles() ? [getSharedMetadataDb()] : [])]) {
    database.pragma("journal_size_limit = 16777216");
    database.pragma("optimize");
    checkpoints.push(database.pragma("wal_checkpoint(TRUNCATE)"));
  }
  return { checkpoints, ...(ownsArtworkFiles() ? { artwork: sweepOrphanArtwork(), logsRemoved: pruneLogArchive() } : {}) };
}

export function runDbOptimizeIfDue(now = Date.now(), runOptimize = runDatabaseMaintenance) {
  const cadence = optimizeCadence();
  if (cadence.lastOptimizeAt && now - cadence.lastOptimizeAt < DB_OPTIMIZE_INTERVAL_MS) return { ran: false };
  runOptimize();
  cadence.lastOptimizeAt = now;
  return { ran: true };
}
