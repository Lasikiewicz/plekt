// Make the final identity check and history insert one SQLite write transaction.
// The outer IMMEDIATE transaction serializes this check across application
// processes; the existing identity lookup remains the source of match rules.
import { db } from "../db.js";
import {
  findWatchedByAnyMediaKeySync,
  getPlaystateForMediaSync,
  insertWatchRecordSync,
  prefetchWatchRecordAssets,
} from "./dataRepo.js";

export function insertRecentWatchIfMissing(media, record, {
  watchlistConfig = null,
  shouldSkip = null,
  prefetch = true,
} = {}) {
  const outcome = db.transaction(() => {
    const existing = findWatchedByAnyMediaKeySync(media);
    const playstate = getPlaystateForMediaSync(media);
    const reason = shouldSkip?.({ existing, playstate }) || "";
    if (reason) return { inserted: false, reason, existing, playstate };
    if (existing) return { inserted: false, reason: "already_watched", existing, playstate };

    const result = insertWatchRecordSync(record, { watchlistConfig });
    return { inserted: true, reason: "", existing: null, playstate, result };
  }).immediate();

  if (!outcome.inserted) return outcome;
  const assetPrefetch = prefetch ? prefetchWatchRecordAssets(outcome.result) : null;
  return { ...outcome, result: { ...outcome.result, assetPrefetch } };
}
