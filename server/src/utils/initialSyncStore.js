import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { getOnboardingState, saveOnboardingState } from './onboardingStore.js';

const ID='initial-outward-sync';
export function readInitialSyncHeader() {
  const raw=db.prepare('SELECT data FROM settings WHERE id=?').get(ID)?.data;
  return raw?JSON.parse(raw):null;
}
export function readInitialSync() {
  try {
    const job=readInitialSyncHeader();
    if(!job)return null;
    const rows=db.prepare('SELECT * FROM initial_sync_items WHERE job_id=? ORDER BY rowid').all(job.id);
    job.destinations=job.destinations.map(destination=>({...destination,
      items:rows.filter(row=>row.destination===destination.provider).map(row=>({...JSON.parse(row.item_json),status:row.status,detail:row.detail}))}));
    return job;
  }
  catch {return null;}
}
function saveHeader(job) {
  const header={...job,destinations:job.destinations.map(({items,...destination})=>destination)};
  db.prepare('INSERT INTO settings(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
    .run(ID,JSON.stringify(header),Date.now());
  saveOnboardingState({pushSync:{status:job.status,startedAt:job.startedAt,completedAt:job.completedAt||null,error:job.error||''}});
  return job;
}
export function replaceInitialSyncItems(id,destination,items) {
  db.transaction(()=>{
    db.prepare('DELETE FROM initial_sync_items WHERE job_id=? AND destination=?').run(id,destination);
    const insert=db.prepare('INSERT INTO initial_sync_items(job_id,destination,item_id,item_json,status,detail) VALUES(?,?,?,?,?,?)');
    for(const {status='pending',detail='',...item} of items)insert.run(id,destination,item.id,JSON.stringify(item),status,detail);
  }).immediate();
}
export function updateInitialSyncItems(id,destination,outcomes) {
  db.transaction(()=>{
    const update=db.prepare('UPDATE initial_sync_items SET status=?,detail=? WHERE job_id=? AND destination=? AND item_id=?');
    for(const item of outcomes)update.run(item.status,item.detail||'',id,destination,item.id);
  }).immediate();
}
export function saveInitialSync(job) {
  return db.transaction(()=>{
    for(const destination of job.destinations)replaceInitialSyncItems(job.id,destination.provider,destination.items||[]);
    return saveHeader(job);
  }).immediate();
}
export function patchInitialSync(id,patch) {
  return db.transaction(()=>{
    const job=readInitialSync();
    if(job?.id!==id)return null;
    return saveHeader({...job,...(typeof patch==='function'?patch(job):patch)});
  }).immediate();
}
export function initialImportsPending(state=getOnboardingState()) {
  return Object.values(state.backgroundImports||{}).flatMap(group=>Object.values(group||{}))
    .some(entry=>entry?.enabled!==false&&['importing','running','failed','preview_required'].includes(entry?.status));
}
export function initialImportsCompleted(state=getOnboardingState()) {
  return Object.values(state.backgroundImports||{}).flatMap(group=>Object.values(group||{}))
    .some(entry=>entry?.enabled!==false&&entry?.status==='complete');
}
export function assertInitialImportsOpen() {
  const job=readInitialSync();
  if(job&&['planning','running','waiting_quota'].includes(job.status))throw Object.assign(
    new Error('Initial sync has started. Finish setup before importing more history from Settings.'),{status:409,code:'INITIAL_SYNC_STARTED'});
}

// Count commits, not previews: a completed preview has not changed history. Continue
// leaves uncommitted previews skipped. An in-flight commit remains a hard barrier.
export async function withInitialInboundImport(source,work) {
  const state=getOnboardingState();
  const job=readInitialSync();
  if(!state.accountClaimed||(state.runState!=='in_progress'&&job?.status!=='waiting'))return work();
  assertInitialImportsOpen();
  const token=randomUUID();
  const old=state.backgroundImports.oneTime||{};
  const oneTime=Object.fromEntries(Object.entries(old).map(([key,entry])=>[key,
    entry.source===source&&entry.status==='failed'?{...entry,enabled:false,status:'cancelled'}:entry]));
  saveOnboardingState({backgroundImports:{...state.backgroundImports,oneTime}});
  const change=patch=>{
    const current=getOnboardingState(),imports=current.backgroundImports;
    saveOnboardingState({backgroundImports:{...imports,oneTime:{...imports.oneTime,[token]:{source,enabled:true,...patch}}}});
  };
  change({status:'importing'});
  try {const result=await work();change({status:'complete'});return result;}
  catch(error) {change({status:'failed',error:'One-time history import failed. Retry or cancel it before initial sync.'});throw error;}
}

// A destination handed to a durable paced run (Simkl) keeps going after a
// restart; its run worker owns its items and finishes the job.
const pacedActive=destination=>Boolean(destination.pacedRunId)&&['queued','running','waiting_quota'].includes(destination.status);
export function recoverInitialSync() {
  const job=readInitialSync();
  if(!job||!['waiting','planning','running','waiting_quota'].includes(job.status))return job;
  const destinations=job.destinations.map(destination=>pacedActive(destination)?destination:({...destination,status:['waiting','planning','running'].includes(destination.status)?'interrupted':destination.status,
    items:destination.items.map(item=>({...item,status:item.status==='sending'?'review':item.status}))}));
  if(destinations.some(pacedActive))return saveInitialSync({...job,destinations});
  return saveInitialSync({...job,status:'interrupted',completedAt:Date.now(),
    error:'Initial sync was interrupted by a server restart. Review remaining items in Settings before sending again.',destinations});
}

// Settle the job once no destination is still in progress. Called after the
// in-process destinations finish and again whenever a paced run publishes.
export function finalizeInitialSync(id) {
  const job=readInitialSync();
  if(job?.id!==id||!['running','waiting_quota'].includes(job.status))return job;
  // 'waiting' destinations never started (nothing to send); they are not active.
  if(job.destinations.some(d=>['planning','running','queued','waiting_quota'].includes(d.status))) {
    const status=job.destinations.some(d=>['planning','running','queued'].includes(d.status))?'running':'waiting_quota';
    return status===job.status?job:patchInitialSync(id,{status});
  }
  const incomplete=job.destinations.some(d=>['failed','partial','interrupted','cancelled'].includes(d.status));
  const hasItems=job.destinations.some(d=>d.items.length);
  const onlyCancelled=incomplete&&!job.destinations.some(d=>['failed','partial','interrupted'].includes(d.status));
  const cancelled=job.destinations.filter(d=>d.status==='cancelled').map(d=>d.label||d.provider).join(', ');
  return patchInitialSync(id,{status:incomplete?'partial':hasItems?'completed':'skipped',completedAt:Date.now(),
    error:onlyCancelled?`Sending to ${cancelled} was cancelled; its remaining items were not sent. Start a full sync from Settings to send them.`
      :incomplete?'Some destinations need review. Open Settings full sync or Sync Activity to resolve them.':''});
}

export function initialSyncSummary(job=readInitialSync()) {
  if(!job)return {status:'not_started',remaining:0,total:0,destinations:[],items:[]};
  const destinations=job.destinations.map(destination=>{
    const remaining=destination.items.filter(item=>item.status!=='completed').length;
    return {provider:destination.provider,label:destination.label,status:destination.status,total:destination.items.length,remaining,error:destination.error||'',
      nextRunAt:destination.nextRunAt||null,pacing:destination.pacing||null};
  });
  const items=job.destinations.flatMap(destination=>destination.items.filter(item=>item.status!=='completed')
    .map(({media,...item})=>({...item,destination:destination.label})));
  return {status:job.status,error:job.error||'',startedAt:job.startedAt,completedAt:job.completedAt,
    nextRunAt:destinations.find(d=>d.status==='waiting_quota')?.nextRunAt||null,
    total:destinations.reduce((sum,d)=>sum+d.total,0),remaining:items.length,destinations,items,truncated:false};
}
