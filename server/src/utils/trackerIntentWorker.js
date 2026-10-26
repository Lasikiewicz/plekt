import { dispatchTrackerWatchState } from "./trackerDispatcher.js";
import { listDueTrackerWriteIntents } from "./trackerWriteIntents.js";
import { simklBacklogIntentCurrent, recordSimklBacklogResult } from './trackers/simklBacklogDispatch.js';
import { invalidateHistoryDerivedCaches } from './dataRepo.js';

export async function syncPendingTrackerWriteIntents(logger = console.log) {
  let completed = 0;
  const dispatch = async (intent) => {
    if(intent.provider==='simkl'&&!simklBacklogIntentCurrent(intent))return;
    const media = { ...JSON.parse(intent.media_json), watched_at: intent.watched_at,
      watchRecordId: intent.watch_record_id, trackerWriteIntentId: intent.id, syncTargets: [intent.provider] };
    const results = await dispatchTrackerWatchState(media, intent.action);
    if(intent.provider==='simkl')await recordSimklBacklogResult(intent,results);
    if (results.some((result) => result.status === "success")) completed++;
    else logger(`Tracker intent ${intent.id}: ${results.map((result) => result.detail).join("; ")}`);
  };
  for (const intent of listDueTrackerWriteIntents().filter(intent => intent.provider !== 'simkl')) await dispatch(intent);
  // Simkl's adapter coalesces concurrent eligible intents into one bounded
  // chunk. Retain sequential delivery for other trackers and their play logs.
  const simkl=listDueTrackerWriteIntents(Date.now(),100,'simkl',{includeLinked:true});
  await Promise.all(simkl.map(dispatch));
  if(simkl.some(i=>i.watch_record_id))await invalidateHistoryDerivedCaches('simkl-backlog-dispatch');
  return completed;
}
