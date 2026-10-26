import { db } from '../../db.js';
import { finishTrackerWriteIntent, trackerIntentConnectionCurrent } from '../trackerWriteIntents.js';
import { loadMediaConfig, isAuthoritativeRestoreActive } from '../configStore.js';
import { watchedPlayedSyncEnabled } from '../syncFlags.js';
import { updateWatchTelemetry } from '../dataRepo.js';
import { isTargetSynced } from '../syncHistoryTelemetry.js';
import { listTrackerConnections } from '../trackerConnectionRepo.js';

// Only existing captured intents gain this gather path; this does not discover
// old history or create new write eligibility. Superseded local state wins.
export function simklBacklogIntentCurrent(intent) {
  if(JSON.parse(intent.media_json||'{}').simklFullSyncRunId)return false;
  if(isAuthoritativeRestoreActive()||!watchedPlayedSyncEnabled())return false;
  if(intent.status==='uncertain')return true; // Adapter holds it for review; a local edit cannot resolve an unknown remote outcome.
  const row=db.prepare('SELECT media_key,watched_at,sync_action FROM watch_history WHERE id=?').get(intent.watch_record_id||'');
  if(!row)return true; // Orphan intents retain their existing worker contract.
  const state=db.prepare('SELECT state FROM playstate WHERE media_key=?').get(row.media_key);
  if(['unwatched','unplayed'].includes(row.sync_action)||state?.state==='unwatched'||Date.parse(row.watched_at)!==Date.parse(intent.watched_at)) {
    finishTrackerWriteIntent(intent.id,'cancelled','Local watch changed before queued Simkl delivery');
    return false;
  }
  return true;
}

export async function recordSimklBacklogResult(intent,results) {
  if(!intent.watch_record_id)return;
  const result=results.find(r=>r.target==='simkl');
  if(!result)return;
  const config=await loadMediaConfig();
  if(!trackerIntentConnectionCurrent(intent))return;
  const row=db.prepare('SELECT source,watched_at,sync_action,sync_dispatch_telemetry FROM watch_history WHERE id=?').get(intent.watch_record_id);
  if(!row||Date.parse(row.watched_at)!==Date.parse(intent.watched_at)||['unwatched','unplayed'].includes(row.sync_action))return;
  const status=result.status==='failed'?'error':result.status==='not_found'?'skipped':result.status;
  const lines=String(row.sync_dispatch_telemetry||'').split(/\r?\n/).filter(line=>! /^(?:Target\s+)?Simkl status:/i.test(line));
  lines.push(`Target simkl status: ${status}${result.detail?` - ${result.detail}`:''}`);
  const required=listTrackerConnections().filter(c=>c.status==='connected').map(c=>c.provider);
  if(!config.plex?.disabled&&config.plex?.baseUrl&&config.plex?.token)required.push('plex');
  for(const p of ['emby','jellyfin'])if(!config[p]?.disabled&&config[p]?.baseUrl&&config[p]?.apiKey&&config[p]?.userId)required.push(p);
  const telemetry=lines.join('\n');
  const overall=required.every(p=>isTargetSynced(telemetry,p,row.source))?'success':status==='error'?'error':'pending';
  const next=lines.filter(line=>!/^Dispatch status:/i.test(line));
  next.push(`Dispatch status: ${overall}`);
  await updateWatchTelemetry(intent.watch_record_id,next.join('\n'),{skipInvalidate:true});
}
