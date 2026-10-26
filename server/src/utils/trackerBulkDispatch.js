import { dispatchTrackerWatchState, dispatchTraktWatchStateBatch } from './trackerDispatcher.js';
import { listTrackerConnections } from './trackerConnectionRepo.js';
import { runWithConcurrency } from './concurrency.js';
import { trackerBacklogSkipReason } from './trackers/backlogGate.js';
import { trackerProviderForSource } from './trackers/registry.js';
import { isAuthoritativeRestoreActive } from './configStore.js';
import { watchedPlayedSyncEnabled } from './syncFlags.js';
import { getCanonicalWatchState } from './dataRepo.js';

// Explicit producer boundary: all items in a Simkl chunk reach its queue before
// we await results. LAN work and ordinary one-item dispatch keep their own paths.
export async function dispatchTrackerWatchBatch(items = [], state = 'watched', options = {}) {
  const results=items.map((media,index)=>({index,media,targetStates:[]}));
  const connections=listTrackerConnections().filter(c=>c.status==='connected');
  for(const connection of connections) {
    const {provider}=connection;
    const eligible=results.filter(({media})=>!Array.isArray(media.syncTargets)||media.syncTargets.includes(provider));
    if(!eligible.length)continue;
    if(isAuthoritativeRestoreActive()||!watchedPlayedSyncEnabled()) {
      for(const row of eligible)row.targetStates.push({target:provider,status:'cancelled',detail:'Tracker dispatch is paused'});
      continue;
    }
    const superseded=new Set();
    await Promise.all(eligible.map(async row=>{
      if(row.media.bulkTrackerSkip||row.media.watchRecordId&&await getCanonicalWatchState(row.media)==='unwatched')superseded.add(row);
    }));
    const allowed=eligible.filter(row=>{
      if(superseded.has(row)) {row.targetStates.push({target:provider,status:'cancelled',detail:'A newer local state took precedence'});return false;}
      const detail=trackerBacklogSkipReason(connection,row.media,provider,{sourceTracker:trackerProviderForSource(row.media.source)});
      if(detail)row.targetStates.push({target:provider,status:'skipped',dismissed:true,detail});
      return !detail;
    });
    if(provider==='trakt'&&items.every(m=>(m.type||m.mediaType)==='episode')) {
      let batch;
      try {batch=await dispatchTraktWatchStateBatch(allowed.map(r=>r.media),state,options);}
      catch(error) {batch={results:allowed.map((r,index)=>({index,status:'failed',detail:error.message||'Tracker batch failed'}))};}
      for(const row of batch.results||[])if(allowed[row.index])allowed[row.index].targetStates.push({...row,target:provider});
      for(const row of allowed)if(!row.targetStates.some(t=>t.target===provider))row.targetStates.push({target:provider,status:'failed',detail:'Tracker batch returned no item outcome'});
      continue;
    }
    const dispatch=async row=>{
      if(isAuthoritativeRestoreActive()||!watchedPlayedSyncEnabled()) {row.targetStates.push({target:provider,status:'cancelled',detail:'Tracker dispatch is paused'});return;}
      // Explicit multi-item marks already form one Simkl chunk; do not wait for
      // the ordinary 30-minute coalesce window.
      const targets=await dispatchTrackerWatchState({
        ...row.media,
        syncTargets:[provider],
        ...(provider==='simkl'?{simklSendNow:true}:{}),
      },state,options);
      row.targetStates.push(...targets);
    };
    if(provider==='simkl') {
      for(let start=0;start<allowed.length;start+=100)await Promise.all(allowed.slice(start,start+100).map(dispatch));
    } else await runWithConcurrency(allowed,dispatch,6);
  }
  return {results};
}
