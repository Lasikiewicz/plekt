import { dispatchTrackerWatchState } from "./trackerDispatcher.js";
import { finishTrackerWriteIntent, listDueTrackerWriteIntents } from "./trackerWriteIntents.js";
import { simklBacklogIntentCurrent, recordSimklBacklogResult } from './trackers/simklBacklogDispatch.js';
import { invalidateHistoryDerivedCaches } from './dataRepo.js';
import { db } from '../db.js';
import { authorizeQueuedLibraryWatch } from "./queuedLibraryMonitoring.js";
import { recheckHeldSimklWrites } from "./trackers/simklHeldWrites.js";

const deferUnverifiedIntent = db.prepare(`UPDATE tracker_write_intents SET due_at = ?
  WHERE id = ? AND status = ? AND due_at = ?`);

export async function syncPendingTrackerWriteIntents(logger = console.log) {
  let completed = 0;
  let telemetryWritten = false;
  const dispatch = async (intent) => {
    try {
      if(intent.provider==='simkl'&&!simklBacklogIntentCurrent(intent))return;
      const media = { ...JSON.parse(intent.media_json), watched_at: intent.watched_at,
        watchRecordId: intent.watch_record_id, trackerWriteIntentId: intent.id, syncTargets: [intent.provider] };
      const isLibraryCurrent = await authorizeQueuedLibraryWatch(media);
      if (!isLibraryCurrent) {
        deferUnverifiedIntent.run(Date.now() + 5 * 60_000, intent.id, intent.status, intent.due_at);
        logger(`Tracker intent ${intent.id}: deferred (${intent.provider}) - library monitoring could not verify source item`);
        return;
      }
      const results = await dispatchTrackerWatchState(media, intent.action, { isCancelled: () => !isLibraryCurrent() });
      if(intent.provider==='simkl'&&await recordSimklBacklogResult(intent,results))telemetryWritten=true;
      // A deliberate policy skip (for example an alternate-order show for Simkl)
      // returns before the adapter, so nothing finished the intent and it was
      // dispatched again on every tick. Close it, as the adapter does for its
      // own terminal skips.
      const own = results.find((result) => result.target === intent.provider);
      if (own?.status === "skipped" && own.dismissed) finishTrackerWriteIntent(intent.id, "cancelled", own.detail || "Not sent by policy");
      if (results.some((result) => result.status === "success")) completed++;
      else logger(`Tracker intent ${intent.id}: ${results.map((result) => result.detail).join("; ")}`);
    } catch (error) {
      // The request layer already records retry/uncertain outcomes for
      // provider responses. Preserve those dispositions; only unexpected
      // failures that left the intent open are quarantined for review.
      const current = db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(intent.id);
      if (current && !["retry", "uncertain", "review", "settled", "cancelled", "rejected"].includes(current.status)) {
        finishTrackerWriteIntent(intent.id, "review", error.message || String(error));
      }
      logger(`Tracker intent ${intent.id}: dispatch failed (${current?.status || "missing"}): ${error.message || String(error)}`);
    }
  };
  for (const intent of listDueTrackerWriteIntents().filter(intent => intent.provider !== 'simkl')) await dispatch(intent);
  // Simkl's adapter coalesces concurrent eligible intents into one bounded
  // chunk. Retain sequential delivery for other trackers and their play logs.
  const simkl=listDueTrackerWriteIntents(Date.now(),100,'simkl',{includeLinked:true});
  await Promise.all(simkl.map(dispatch));
  const rechecked = await recheckHeldSimklWrites(logger);
  // Only a changed row moves the data version; an unchanged pass must not
  // make every history cache rebuild.
  if(telemetryWritten || rechecked.telemetryWritten)await invalidateHistoryDerivedCaches('simkl-backlog-dispatch');
  return completed + rechecked.completed;
}
