import { db } from "../../db.js";
import { isAuthoritativeRestoreActive } from "../configStore.js";
import { getTrackerConnection, listTrackerItemStates, updateTrackerConnectionStatus } from "../trackerConnectionRepo.js";
import { dispatchTraktWatchStateBatch } from "../trackerDispatcher.js";
import { trackerMediaIdentityKeys, trackerMediaKey } from "./traktClient.js";
import { assertTrackerEnabled } from "./registry.js";
import { runInTrackerGeneration } from "./generation.js";
import { buildTraktInboundTranslator } from "../traktInboundNumbering.js";
import { settledSimklWatchedObservations } from "./simklObservations.js";
import { readTrackerSnapshot } from './connections.js';
import { collectServerWatchedItems } from '../forceSyncPlanner.js';
import { loadMediaConfig } from '../configStore.js';
import { canReceiveState } from '../syncRoles.js';
import { storeTrackerFullSyncPlan, readTrackerFullSyncPlan, claimTrackerFullSyncPlan, trackerFullSyncFingerprint } from './fullSyncPlans.js';
import { createWatchHistoryBackup, verifyWatchBackup } from '../watchHistoryBackups.js';
import { applyWatchedTransition } from '../watchStateTransitions.js';
import { createLoopStore } from '../loopStore.js';
import { dispatchTrackerWatchBatch } from '../trackerBulkDispatch.js';
import { invalidateHistoryDerivedCaches } from '../dataRepo.js';
import { assertTrackerGeneration } from './generation.js';
import crypto from 'node:crypto';
import { simklTransport } from './simklTransport.js';
import { watchTargetPolicy, TARGET_DECISIONS } from '../watchSyncPolicy.js';
import { watchedPlayedSyncEnabled } from '../syncFlags.js';
import { maintainTrackerWriteIntents } from '../trackerWriteIntents.js';
import { activeSimklFullSyncRun, createSimklFullSyncRun } from './simklFullSyncStore.js';
import { SIMKL_FULL_SYNC_NORMAL_POLICY, estimateSimklFullSync } from './simklFullSyncPolicy.js';

// Optional compare-then-confirm full sync for a connected tracker (decision
// 21 October 2026). It only adds missing watches, never removes one, and sends
// one play per missing item dated with its earliest Plekt watch.
export const FULL_SYNC_DIRECTIONS = Object.freeze(["both", "import", "push"]);
const PUSH_CHUNK = 100;
const running = new Map();
// Simkl bulk sending is enabled only through the mandatory selected preview.
const pushers = new Map([["trakt", (items, alreadyOnTracker) =>
  dispatchTraktWatchStateBatch(items, "watched", { canonicalReplay: false, alreadyOnTracker })],
  ['simkl',items=>dispatchTrackerWatchBatch(items.map(media=>({...media,syncTargets:['simkl']})),'watched',{lane:'sync'})]]);
export const trackerFullSyncDirections = (provider) => (pushers.has(provider) ? FULL_SYNC_DIRECTIONS : ["import"]);

// A Fix Match translated show's tracker plays use the tracker's numbering;
// Plekt's watched set uses the stored numbering.
const inboundTranslators = new Map([["trakt", buildTraktInboundTranslator]]);
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const numericId = (value) => (/^\d+$/.test(String(value ?? "")) ? Number(value) : value);

// Plekt's watched set is its watch history, not the playstate sync cache: most
// imported history has no playstate row, and a played flag cached under an
// episode-level id is not evidence of a play (23 October 2026 Simkl canary).
// An item counts when its latest transition is watched and its playstate is not
// explicitly unwatched (an unwatch can be recorded under an alias key).
export function localWatchedItems() {
  return db.prepare(`WITH ranked AS (
      SELECT w.*, ROW_NUMBER() OVER (PARTITION BY w.media_key ORDER BY w.watched_at DESC, w.created_at DESC) AS rn
      FROM watch_history w WHERE w.media_type IN ('movie','episode') AND COALESCE(w.media_key,'')<>'')
    SELECT r.media_key, r.title, r.media_type, r.imdb_id, r.tmdb_id, r.tvdb_id, r.season, r.episode,
      (SELECT w.show_title FROM watch_history w WHERE w.media_key=r.media_key AND w.show_title IS NOT NULL ORDER BY w.created_at DESC LIMIT 1) AS show_title,
      (SELECT MIN(w.watched_at) FROM watch_history w WHERE w.media_key=r.media_key
        AND COALESCE(w.sync_action,'watched') NOT IN ('unwatched','unplayed')) AS first_watched_at
    FROM ranked r LEFT JOIN playstate p ON p.media_key=r.media_key
    WHERE r.rn=1 AND COALESCE(r.sync_action,'watched') NOT IN ('unwatched','unplayed') AND COALESCE(p.state,'')<>'unwatched'`).all().map((row) => ({
    type: row.media_type, mediaType: row.media_type, title: row.title || "", showTitle: row.show_title || "",
    season: row.season, episode: row.episode, imdb_id: row.imdb_id, tmdb_id: row.tmdb_id, tvdb_id: row.tvdb_id,
    // Trakt documents TMDB and TVDB ids as integers; playstate stores text.
    ids: Object.fromEntries([["imdb", row.imdb_id], ["tmdb", numericId(row.tmdb_id)], ["tvdb", numericId(row.tvdb_id)]].filter(([, value]) => value)),
    watched_at: row.first_watched_at, source: "full_sync", syncIntent: "historical",
  }));
}

function readyConnection(provider) {
  const adapter = assertTrackerEnabled(provider);
  const connection = getTrackerConnection(provider);
  if (connection?.status !== "connected") throw fail(`${adapter.label} is not connected`, "NOT_CONNECTED");
  if (!connection.baselineComplete) throw fail(`Wait for the first ${adapter.label} check to finish, then compare`, "BASELINE_PENDING");
  return { adapter, connection };
}

// Pure comparison over the stored tracker snapshot and Plekt's watched set.
// Rows kept only to protect an outbound write are not proof of a remote watch.
// Counts compare in the stored numbering; remoteKeys stay in the tracker's
// numbering because the push checks its already-translated outbound items.
export function compareTrackerItems(remoteItems = [], localItems = [], toStoredNumbering = (media) => media) {
  const remote = remoteItems.filter((item) => Number(item.remoteWatchedAt || 0) > 0);
  const remoteKeys = new Set(remote.flatMap((item) => [item.mediaKey, ...trackerMediaIdentityKeys(item.media)]));
  const storedKeysOf = (item) => {
    const stored = toStoredNumbering(item.media);
    return stored === item.media
      ? [item.mediaKey, ...trackerMediaIdentityKeys(item.media)]
      : [trackerMediaKey(stored), ...trackerMediaIdentityKeys(stored)];
  };
  const remoteStored = remote.map((item) => ({ item, keys: storedKeysOf(item) }));
  const remoteStoredKeys = new Set(remoteStored.flatMap(({ keys }) => keys));
  const identified = localItems.filter((item) => trackerMediaIdentityKeys(item).length);
  const localKeys = new Set(identified.flatMap((item) => trackerMediaIdentityKeys(item)));
  return {
    remoteKeys,
    plektOnly: identified.filter((item) => !trackerMediaIdentityKeys(item).some((key) => remoteStoredKeys.has(key))),
    trackerOnly: remoteStored.filter(({ keys }) => !keys.some((key) => localKeys.has(key))).map(({ item }) => item),
    unidentified: localItems.length - identified.length,
  };
}

// Simkl's remote watched set is its settled observations (deltas never remove).
const remoteItemReaders = new Map([["simkl", () => settledSimklWatchedObservations(getTrackerConnection("simkl"))
  .map(({ observation }) => ({ mediaKey: trackerMediaKey(observation.media), media: observation.media, remoteWatchedAt: observation.watchedAt }))]]);

async function comparison(provider) {
  const toStoredNumbering = await (inboundTranslators.get(provider)?.() ?? ((media) => media));
  const remote = remoteItemReaders.get(provider)?.() ?? listTrackerItemStates(provider);
  return compareTrackerItems(remote, localWatchedItems(), toStoredNumbering);
}
const titles = (items, read) => items.slice(0, 5).map(read).filter(Boolean);

const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const localGuard=()=>digest(db.prepare('SELECT * FROM playstate ORDER BY media_key').all());
const identityGuard=config=>digest({config,syncEnabled:watchedPlayedSyncEnabled(),plexPolicy:watchTargetPolicy({target:'plex',intent:'import',state:'watched'}),overrides:db.prepare('SELECT * FROM show_season_source ORDER BY show_key').all(),history:db.prepare('SELECT id,media_key,watched_at,watch_provenance FROM watch_history ORDER BY id').all()});
// A paced run's own intents are not holds against its remaining items.
export const currentWriteHolds=(provider,connection,{excludeRunId=''}={})=>db.prepare("SELECT id,status,media_json FROM tracker_write_intents WHERE provider=? AND connection_id=? AND account_id=? AND action='watched' AND (status NOT IN ('settled','cancelled','rejected') OR status='settled' AND settled_at>?) AND (?='' OR logical_key NOT LIKE ?) ORDER BY id")
  .all(provider,connection.id,connection.remoteUserId,Date.now()-30*60_000,excludeRunId,`simkl-full-sync:${excludeRunId}:%`).map(row=>({id:row.id,status:row.status,media:JSON.parse(row.media_json)}));
async function collectPreviewState(provider,{fresh=false,includeLan=true}={}) {
  const {connection}=readyConnection(provider);
  maintainTrackerWriteIntents();
  const config=await loadMediaConfig();
  const translate=await(inboundTranslators.get(provider)?.()??(media=>media));
  let remote=remoteItemReaders.get(provider)?.()??listTrackerItemStates(provider),review=[];
  if(fresh) {
    const read=await readTrackerSnapshot(provider,{trigger:'user'});
    if(read.connection?.id!==connection.id)throw fail('Tracker account changed; build a new preview','FULL_SYNC_PLAN_STALE');
    if(provider==='simkl') {
      if(!read.snapshot.complete)throw fail('A complete Simkl snapshot is required','FULL_SYNC_INCOMPLETE');
      remote=read.snapshot.watched.map(item=>({media:item.media,remoteWatchedAt:item.watchedAt}));review=read.snapshot.review||[];
    } else remote=read.snapshot.map(item=>({media:item.media,remoteWatchedAt:item.watchedAt}));
  } else if(provider==='simkl')review=db.prepare("SELECT observation_json FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND status='review'").all(connection.id).map(row=>JSON.parse(row.observation_json));
  const lanRead=includeLan?await collectServerWatchedItems(config):{scopeErrors:[],itemsByServer:{},configuredServers:[]};
  if(lanRead.scopeErrors.length)throw fail('A media-server read was incomplete; preview cannot be approved','FULL_SYNC_INCOMPLETE');
  const lan=Object.fromEntries(Object.entries(lanRead.itemsByServer).map(([target,items])=>[target,items.map(item=>({type:item.type,ids:{imdb:item.imdb,tmdb:item.tmdb,tvdb:item.tvdb},season:item.season,episode:item.episode,watched_at:item.timestamp?new Date(item.timestamp).toISOString():null}))]));
  return {connection:{id:connection.id,account:connection.remoteUserId,preferEarlier:connection.preferEarlierWatchedDate},local:localWatchedItems(),
    writeHolds:currentWriteHolds(provider,connection),
    remote:remote.filter(item=>Number(item.remoteWatchedAt)>0).map(item=>({media:translate(item.media),remoteWatchedAt:Number(item.remoteWatchedAt)})),review,
    lan,lanTargets:lanRead.configuredServers.filter(target=>watchedPlayedSyncEnabled()&&canReceiveState(config,target,'watched')&&watchTargetPolicy({target,intent:'import',state:'watched'}).decision===TARGET_DECISIONS.SEND),config,syncEnabled:watchedPlayedSyncEnabled(),
    quotaRemaining:provider==='simkl'?simklTransport.quotaFor(connection).quotaRemaining:null,
    quotaLimit:provider==='simkl'?simklTransport.quotaFor(connection).quotaLimit:null,
    localGuard:localGuard(),identityGuard:identityGuard(config)};
}

function savePreview(provider,snapshot) {
  const plan=storeTrackerFullSyncPlan(provider,snapshot,{pushSupported:pushers.has(provider)});
  const imports=plan.items.filter(r=>r.side==='plekt'&&r.selectable),sends=plan.items.filter(r=>r.side==='tracker'&&r.selectable);
  const state={status:'compared',comparedAt:Date.now(),trackerOnly:imports.length,plektOnly:sends.length,
    unidentified:plan.items.filter(r=>r.reason==='No supported provider identifiers').length,
    examples:{trackerOnly:imports.slice(0,5).map(r=>r.title),plektOnly:sends.slice(0,5).map(r=>r.title)},preview:plan.preview};
  updateTrackerConnectionStatus(provider,{fullSync:state,connectionId:snapshot.connection.id});
  return state;
}

const pacedRun=(provider,connection)=>provider==='simkl'&&connection?.id?activeSimklFullSyncRun(connection.id):null;
export function getTrackerFullSync(provider) {
  const connection = getTrackerConnection(provider);
  const state = connection?.fullSync || null;
  // A durable paced run continues across restarts; it is never "interrupted".
  if (state?.status === "running" && !running.has(provider) && !pacedRun(provider,connection)) return { ...state, status: "interrupted" };
  return state;
}

function assertNoPacedRun(provider,connection) {
  if(pacedRun(provider,connection))throw fail('A paced Simkl full sync is in progress; cancel it or wait for it to finish','FULL_SYNC_RUNNING');
}

export async function compareTrackerWithPlekt(provider) {
  const { connection } = readyConnection(provider);
  if (running.has(provider)) throw fail("A full sync is already running", "FULL_SYNC_RUNNING");
  assertNoPacedRun(provider,connection);
  return savePreview(provider,await collectPreviewState(provider));
}

async function runSelectedFullSync(provider,rows,snapshot,write,isCancelled,onItems=()=>{}) {
  const imports=rows.filter(r=>r.side==='plekt'),sends=rows.filter(r=>r.side==='tracker');
  const loopStore=createLoopStore();let imported=0,sent=0,notSent=0,propagationFailed=0,done=0;
  const current=()=>{assertTrackerGeneration(provider);if(isCancelled()||isAuthoritativeRestoreActive()||getTrackerConnection(provider)?.status!=='connected')throw fail('Full sync paused because it was cancelled or its connection/restore state changed','FULL_SYNC_PAUSED');};
  write({phase:'import',total:rows.length});
  for(const row of imports) {
    current();
    const result=await applyWatchedTransition({...row.media,isValid:true,source:`${provider}_import`,syncIntent:'import',
      watched_at:row.watchedAt,syncTargets:row.targets||[]},snapshot.config,loopStore,{shouldDefer:()=>{current();return false;}});
    if(result.deferred)throw fail('A selected import was superseded; build a new preview','FULL_SYNC_PLAN_STALE');
    if(result.inserted)imported++;
    if((result.summary?.targetStates||[]).some(target=>target.status!=='success'))propagationFailed++;
    write({imported,propagationFailed,done:++done});
  }
  write({phase:'push'});
  const remoteKeys=new Set(snapshot.remote.flatMap(r=>trackerMediaIdentityKeys(r.media)));
  for(let start=0;start<sends.length;start+=PUSH_CHUNK) {
    current();
    const planned=sends.slice(start,start+PUSH_CHUNK);
    const heldKeys=new Set(currentWriteHolds(provider,getTrackerConnection(provider)).flatMap(item=>trackerMediaIdentityKeys(item.media)));
    const chunk=planned.filter(row=>!trackerMediaIdentityKeys(row.media).some(key=>heldKeys.has(key)));
    onItems(planned.filter(row=>!chunk.includes(row)).map(row=>({id:row.id,status:'review',detail:'A tracker write is already pending or held'})));
    notSent+=planned.length-chunk.length;
    if(!chunk.length) {done+=planned.length;write({notSent,done});continue;}
    onItems(chunk.map(row=>({id:row.id,status:'sending',detail:''})));
    const summary=await pushers.get(provider)(chunk.map(row=>({...row.media,watched_at:row.watchedAt,syncIntent:'historical'})),
      media=>trackerMediaIdentityKeys(media).some(key=>remoteKeys.has(key)));
    let successful=0;const outcomes=[];
    for(const [index,result] of (summary.results||[]).entries()) {
      const status=result.targetStates?.find(t=>t.target===provider)?.status||result.status;
      if(status==='success') {sent++;successful++;} else notSent++;
      const row=chunk[result.index??index];
      if(row)outcomes.push({id:row.id,status:status==='success'?'completed':'review',detail:status==='success'?'':result.targetStates?.find(t=>t.target===provider)?.detail||result.detail||'Tracker did not confirm this item'});
    }
    onItems(outcomes);
    done+=planned.length;write({sent,notSent,done});
    if(!successful&&chunk.length) {notSent+=sends.length-start-planned.length;write({notSent});break;}
  }
  await invalidateHistoryDerivedCaches('tracker-full-sync-selected');
}

export async function startTrackerFullSync(provider, direction, {planId,selectedIds,isCancelled=()=>false,onItems=()=>{},initialJobId=null}={}) {
  if (!FULL_SYNC_DIRECTIONS.includes(direction)) throw fail("Choose both, import or push", "INVALID_DIRECTION", 400);
  const { adapter, connection } = readyConnection(provider);
  if (!trackerFullSyncDirections(provider).includes(direction)) throw fail(`Sending to ${adapter.label} is not supported yet; import is available`, "TRACKER_PUSH_UNSUPPORTED");
  if (running.has(provider)) throw fail("A full sync is already running", "FULL_SYNC_RUNNING");
  assertNoPacedRun(provider,connection);
  if (isAuthoritativeRestoreActive()) throw fail("An authoritative watch-history restore is active; full sync waits until it completes", "RESTORE_ACTIVE");
  const plan=readTrackerFullSyncPlan(provider,planId);
  if(plan.outboundOnly&&direction!=='push')throw fail('This initial-sync plan only permits missing outbound additions','INVALID_DIRECTION');
  if(!Array.isArray(selectedIds)||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!plan.items.some(row=>row.id===id&&row.selectable)))throw fail('Choose items from this preview','FULL_SYNC_SELECTION_INVALID',400);
  const chosen=new Set(selectedIds);
  const rows=plan.items.filter(row=>chosen.has(row.id)&&row.selectable&&(direction==='both'||row.side===(direction==='import'?'plekt':'tracker')));
  if(!rows.length)throw fail('Select at least one item for this direction','FULL_SYNC_SELECTION_EMPTY',400);
  // Reserve this provider before awaiting fresh reads; simultaneous approvals
  // cannot start two independent sends from the same preview.
  running.set(provider,Promise.resolve());
  let snapshot,backup;
  try {
    // Backup first, then take the final remote snapshot. A slow backup cannot
    // leave an otherwise fresh approval using stale LAN state, and no second
    // tracker scan is needed just to close that gap.
    backup=await createWatchHistoryBackup({reason:'pre-tracker-full-sync',mirrorRemote:false});verifyWatchBackup(backup.name);
    const verify=()=>runInTrackerGeneration(provider,connection.id,()=>collectPreviewState(provider,{fresh:true,includeLan:!plan.outboundOnly}));
    // Simkl sends no longer need to fit today's quota: they become a durable
    // paced run that continues after each daily reset (step 8c).
    snapshot=await(provider==='simkl'?simklTransport.withBudget({maxRequests:18,minimumRemaining:56,allowUnknownFirst:true},verify):verify());
    if(plan.fingerprint!==trackerFullSyncFingerprint(snapshot)) {
      savePreview(provider,snapshot);
      throw fail('State changed. Review the updated preview before applying','FULL_SYNC_PLAN_STALE');
    }
    if(isCancelled()||isAuthoritativeRestoreActive())throw fail('Full sync was cancelled or a restore is active','FULL_SYNC_PAUSED');
    claimTrackerFullSyncPlan(provider,planId);
    const currentConfig=await loadMediaConfig();
    const now=readyConnection(provider).connection;
    if(now.id!==connection.id||now.remoteUserId!==connection.remoteUserId||localGuard()!==snapshot.localGuard||identityGuard(currentConfig)!==snapshot.identityGuard||isCancelled()||isAuthoritativeRestoreActive())throw fail('Local state changed after backup; rebuild the preview','FULL_SYNC_PLAN_STALE');
  } catch(error) {running.delete(provider);throw error;}
  // Simkl sends are persisted as one approved run; only imports stay in-process.
  const sendRows=provider==='simkl'?rows.filter(row=>row.side==='tracker'):[];
  const inProcessRows=provider==='simkl'?rows.filter(row=>row.side!=='tracker'):rows;
  let state = {
    ...(connection.fullSync || {}), status: "running", direction, phase: "", startedAt: Date.now(), finishedAt: null,
    error: "", imported: 0, sent: 0, alreadyThere: 0, notSent: 0, propagationFailed:0,done: 0, total: rows.length,backup,runId:null,nextRunAt:null,pacing:null,
  };
  const write = (patch) => {
    state = { ...state, ...patch };
    updateTrackerConnectionStatus(provider, { fullSync: state, connectionId: connection.id });
  };
  const pace=()=>{
    const quota=simklTransport.quotaFor(connection);
    const pacing=estimateSimklFullSync(sendRows.length,{quotaLimit:quota.quotaLimit,quotaRemaining:quota.quotaRemaining,policy:SIMKL_FULL_SYNC_NORMAL_POLICY});
    const run=createSimklFullSyncRun({connection,rows:sendRows,initialJobId,backup,direction,imported:state.imported,
      propagationFailed:state.propagationFailed,policy:SIMKL_FULL_SYNC_NORMAL_POLICY,pacing});
    write({status:'queued',phase:'push',runId:run.id,nextRunAt:run.nextRunAt,pacing,done:inProcessRows.length,comparedAt:null});
    return run.id;
  };
  if(!inProcessRows.length) {
    try {
      const pacedRunId=pace();
      return {state,promise:Promise.resolve(),pacedRunId};
    } finally {running.delete(provider);}
  }
  write({});
  let pacedRunId=null;
  const promise = runInTrackerGeneration(provider, connection.id, () => runSelectedFullSync(provider, inProcessRows, snapshot, write,isCancelled,onItems))
    .then(() => {
      if(sendRows.length) {pacedRunId=pace();return;}
      // The counts are stale once anything moved; the card asks for a fresh compare.
      write({ status: state.notSent||state.propagationFailed?'partial':'completed', phase: "", finishedAt: Date.now(), comparedAt: null });
    })
    .catch((error) => { if (!error.stale) write({ status: "failed", finishedAt: Date.now(), error: String(error.message || error).slice(0, 300) }); })
    .finally(() => running.delete(provider));
  running.set(provider, promise);
  return { state, promise, get pacedRunId() {return pacedRunId;} };
}

// First-run consent is the Import & sync Continue action. Build the same guarded
// plan as Settings, but select only missing outbound additions, never date changes
// or inbound propagation. The normal backup, fresh recheck, holds and quota reserve
// remain mandatory when this plan is executed.
export async function prepareInitialTrackerPush(provider) {
  const {connection}=readyConnection(provider);
  const read=()=>runInTrackerGeneration(provider,connection.id,()=>collectPreviewState(provider,{fresh:true,includeLan:false}));
  const snapshot=await(provider==='simkl'
    ?simklTransport.withBudget({maxRequests:18,minimumRemaining:56,allowUnknownFirst:true},read):read());
  return storeTrackerFullSyncPlan(provider,snapshot,{pushSupported:pushers.has(provider),outboundOnly:true});
}
