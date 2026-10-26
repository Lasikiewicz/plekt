import { createHash, randomUUID } from 'node:crypto';
import { loadMediaConfig, loadRuntimeState, activeSyncOperation, isAuthoritativeRestoreActive } from './configStore.js';
import { getOnboardingState } from './onboardingStore.js';
import { readInitialSync, readInitialSyncHeader, saveInitialSync, patchInitialSync, initialImportsPending, initialImportsCompleted, replaceInitialSyncItems, updateInitialSyncItems, finalizeInitialSync } from './initialSyncStore.js';
import { kickSimklFullSyncRuns } from './trackers/simklFullSyncRunner.js';
import { refreshDataVersion } from '../db.js';
import { configuredSyncServers, collectServerWatchedItems } from './forceSyncPlanner.js';
import { canReceiveState } from './syncRoles.js';
import { watchTargetPolicy, TARGET_DECISIONS } from './watchSyncPolicy.js';
import { watchedPlayedSyncEnabled } from './syncFlags.js';
import { listTrackerConnections, getTrackerConnection } from './trackerConnectionRepo.js';
import { trackerProviderIds } from './trackers/registry.js';
import { localWatchedItems, compareTrackerItems, prepareInitialTrackerPush, startTrackerFullSync } from './trackers/fullSync.js';
import { trackerMediaIdentityKeys } from './trackers/traktClient.js';
import { syncCanonicalPlaystate } from './syncOrchestrator.js';
import { createLoopStore } from './loopStore.js';
import { createWatchHistoryBackup, verifyWatchBackup } from './watchHistoryBackups.js';

const labels={plex:'Plex',emby:'Emby',jellyfin:'Jellyfin',trakt:'Trakt',simkl:'Simkl'};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active=new Map();
const mediaRevision=(config,provider)=>digest(config[provider]);
const localRevision=(read=localWatchedItems)=>digest(read());
const writable=(config,provider)=>watchedPlayedSyncEnabled()&&canReceiveState(config,provider,'watched')&&
  watchTargetPolicy({target:provider,intent:'historical',state:'watched'}).decision===TARGET_DECISIONS.SEND;

export function initialSyncDestinations(config,connections) {
  if(!watchedPlayedSyncEnabled())return [];
  return [
    ...configuredSyncServers(config).filter(provider=>writable(config,provider)).map(provider=>({provider,kind:'server',revision:mediaRevision(config,provider)})),
    ...connections.filter(c=>c.status==='connected'&&trackerProviderIds().includes(c.provider)).map(c=>({provider:c.provider,kind:'tracker',connectionId:c.id,accountId:c.remoteUserId})),
  ].map(destination=>({...destination,label:labels[destination.provider]||destination.provider,status:'waiting',items:[]}));
}

// Called only by the wizard's explicit Continue on Import & sync. Existing installs
// and later Settings connections never arm this job. No work is inferred from history.
export async function armInitialSync({launch=true}={}) {
  const state=getOnboardingState();
  if(state.runState!=='in_progress'||!state.initialSyncEligible)return null;
  const existing=readInitialSync();
  if(existing)return existing;
  const config=await loadMediaConfig();
  // Recheck after awaiting configuration: simultaneous Continue requests share one job.
  if(readInitialSync())return readInitialSync();
  if(getOnboardingState().runState!=='in_progress'||!getOnboardingState().initialSyncEligible)return null;
  const job=saveInitialSync({id:randomUUID(),status:'waiting',startedAt:Date.now(),completedAt:null,
    destinations:initialSyncDestinations(config,listTrackerConnections()),error:''});
  if(launch)launchInitialSync(job.id);
  return job;
}

function updateDestination(id,provider,patch) {
  return patchInitialSync(id,job=>({destinations:job.destinations.map(destination=>{
    if(destination.provider!==provider)return destination;
    const next=typeof patch==='function'?patch(destination):patch;
    if(next.items)replaceInitialSyncItems(id,provider,next.items);
    return {...destination,...next};
  })}));
}
const itemRow=(media,destination,id)=>({id:id||digest([destination,trackerMediaIdentityKeys(media)]),
  title:media.title,showTitle:media.showTitle||'',type:media.type,season:media.season,episode:media.episode,
  media,status:'pending',detail:''});

export async function runInitialDestination(id,destination,{
  configRead=loadMediaConfig,localRead=localWatchedItems,connectionRead=getTrackerConnection,
  prepareTracker=prepareInitialTrackerPush,startTracker=startTrackerFullSync,
  scanServer=collectServerWatchedItems,dispatchServer=syncCanonicalPlaystate,
  backup=createWatchHistoryBackup,verifyBackup=verifyWatchBackup,loopStore=createLoopStore,kickRuns=kickSimklFullSyncRuns,
}={}) {
  const provider=destination.provider;
  const originalLocal=localRevision(localRead);
  let cachedLocal=originalLocal,cachedVersion=refreshDataVersion();
  const unchangedLocal=()=>{
    const version=refreshDataVersion();
    if(localRead!==localWatchedItems||version!==cachedVersion) {cachedLocal=localRevision(localRead);cachedVersion=version;}
    return cachedLocal===originalLocal;
  };
  const current=async()=>{
    const job=readInitialSyncHeader();
    if(job?.id!==id||job.status!=='running'||isAuthoritativeRestoreActive()||!watchedPlayedSyncEnabled()||!unchangedLocal())throw new Error('History or sync state changed; review remaining items before sending again.');
    const config=await configRead();
    const latest=readInitialSyncHeader();
    if(latest?.id!==id||latest.status!=='running'||isAuthoritativeRestoreActive()||!unchangedLocal())throw new Error('History or sync state changed while preparing the destination.');
    if(destination.kind==='tracker') {
      const connection=connectionRead(provider);
      if(connection?.id!==destination.connectionId||connection.remoteUserId!==destination.accountId||connection.status!=='connected')throw new Error('Tracker connection changed; remaining items were not sent.');
    } else if(mediaRevision(config,provider)!==destination.revision||!writable(config,provider))throw new Error('Media-server connection or sync policy changed; remaining items were not sent.');
    return config;
  };
  try {
    updateDestination(id,provider,{status:'planning'});
    const config=await current();
    if(destination.kind==='tracker') {
      const plan=await prepareTracker(provider);
      await current();
      const rows=plan.items.filter(row=>row.side==='tracker'&&row.operation==='add'&&row.selectable);
      const held=plan.items.filter(row=>row.side==='tracker'&&row.operation==='skip');
      updateDestination(id,provider,{status:'running',items:[...rows.map(row=>itemRow(row.media,provider,row.id)),
        ...held.map(row=>({...itemRow(row.media,provider,row.id),status:'review',detail:row.reason}))]});
      if(rows.length) {
        const result=await startTracker(provider,'push',{planId:plan.id,selectedIds:rows.map(row=>row.id),initialJobId:id,
          isCancelled:()=>isAuthoritativeRestoreActive()||readInitialSyncHeader()?.id!==id||readInitialSyncHeader()?.status!=='running'||!unchangedLocal(),
          onItems:outcomes=>updateInitialSyncItems(id,provider,outcomes)});
        await result.promise;
        // Simkl sends became a durable paced run; its worker reports progress
        // into this destination and finishes the job across quota resets.
        if(result.pacedRunId) {
          updateDestination(id,provider,{status:'running',pacedRunId:result.pacedRunId});
          void kickRuns().catch(error=>console.warn('Simkl paced initial sync failed to start',error.message));
          return;
        }
        const unfinished=readInitialSync()?.destinations.find(d=>d.provider===provider)?.items
          .filter(item=>['pending','sending'].includes(item.status))||[];
        updateInitialSyncItems(id,provider,unfinished.map(item=>({id:item.id,status:'review',detail:'Initial sync stopped before this item was confirmed. Review it before sending again.'})));
      }
    } else {
      const scan=await scanServer(config,{scope:{servers:[provider]}});
      if(scan.scopeErrors.length)throw new Error('Media-server watched-state read failed; no items sent.');
      await current();
      const remote=(scan.itemsByServer[provider]||[]).map(item=>({remoteWatchedAt:1,media:{type:item.type,ids:{imdb:item.imdb,tmdb:item.tmdb,tvdb:item.tvdb},season:item.season,episode:item.episode}}));
      const missing=compareTrackerItems(remote,localRead()).plektOnly;
      updateDestination(id,provider,{status:'running',items:missing.map(media=>itemRow(media,provider))});
      if(missing.length) {
        const snapshot=await backup({reason:'pre-initial-sync',mirrorRemote:false});verifyBackup(snapshot.name);
        const loop=loopStore();
        // One row at a time per server; each server's independent queue runs in
        // parallel with the others and uses the existing outbound governor.
        for(const media of missing) {
          const latest=await current(),row=itemRow(media,provider);
          updateInitialSyncItems(id,provider,[{id:row.id,status:'sending'}]);
          const result=await dispatchServer({...media,syncTargets:[provider]},latest,loop,'watched',{includeTrackers:false});
          const target=result.targetStates?.find(target=>target.target===provider);
          updateInitialSyncItems(id,provider,[{id:row.id,status:target?.status==='success'?'completed':'review',detail:target?.status==='success'?'':target?.detail||'Destination did not confirm this item'}]);
        }
      }
    }
    updateDestination(id,provider,d=>({status:d.items.some(item=>item.status!=='completed')?'partial':'completed'}));
  } catch(error) {
    updateDestination(id,provider,{status:'failed',error:String(error.message||error).slice(0,300)});
  }
}

export async function runInitialSync(id,{runTarget=runInitialDestination}={}) {
  const job=readInitialSync();
  if(job?.id!==id||job.status!=='waiting')return false;
  const runtime=await loadRuntimeState();
  if(initialImportsPending()||isAuthoritativeRestoreActive()||activeSyncOperation(runtime))return false;
  patchInitialSync(id,{status:'running'});
  if(initialImportsCompleted()&&localWatchedItems().length)await Promise.all(job.destinations.map(destination=>runTarget(id,destination)));
  // A paced destination keeps the job open until its run finishes.
  finalizeInitialSync(id);
  return true;
}

function launchInitialSync(id) {
  if(active.has(id))return;
  const poll=async()=>{
    try {
      if(readInitialSync()?.id!==id||readInitialSync()?.status!=='waiting'||await runInitialSync(id)) {active.delete(id);return;}
      const timer=setTimeout(poll,2000);timer.unref?.();active.set(id,timer);
    } catch(error) {
      patchInitialSync(id,{status:'failed',error:String(error.message||error).slice(0,300),completedAt:Date.now()});active.delete(id);
    }
  };
  active.set(id,true);queueMicrotask(poll);
}
