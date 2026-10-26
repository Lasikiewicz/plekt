import crypto from 'node:crypto';
import { db } from '../../db.js';
import { trackerMediaIdentityKeys } from './traktClient.js';
import { simklHistoryPayload } from './simklClient.js';
import { SIMKL_FULL_SYNC_NORMAL_POLICY, estimateSimklFullSync } from './simklFullSyncPolicy.js';

export const TRACKER_PREVIEW_TTL_MS=60*60_000;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const keys=media=>trackerMediaIdentityKeys(media);
const overlaps=(a,b)=>keys(a).some(k=>keys(b).includes(k));
const contradictory=(a,b)=>overlaps(a,b)&&Object.keys(a.ids||{}).some(p=>a.ids[p]&&b.ids?.[p]&&String(a.ids[p]).toLowerCase()!==String(b.ids[p]).toLowerCase());
const stamp=value=>typeof value==='number'?value:Date.parse(value);
const iso=value=>Number.isFinite(stamp(value))&&stamp(value)>1000?new Date(stamp(value)).toISOString():null;
const sorted=value=>[...value].sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));

// Resolve aliases once per collection instead of rebuilding every item's keys
// for every pair in a library-wide comparison. Preserve source order when an
// item has several matching aliases.
function identityLookup(items, mediaOf=item=>item) {
  const index=new Map();
  items.forEach((item,position)=>{for(const key of keys(mediaOf(item))) {
    if(!index.has(key))index.set(key,[]);
    index.get(key).push(position);
  }});
  return media=>[...new Set(keys(media).flatMap(key=>index.get(key)||[]))].sort((a,b)=>a-b).map(position=>items[position]);
}

// Explicitly identify conflicting aliases rather than dropping an inconvenient
// ID or letting one bad title make an otherwise valid batch fail after claiming.
function conflictingAliases(items) {
  const held=new Set(),index=new Map();
  for(const media of items) {
    const type=media.type||media.mediaType,ids=media.ids||{};
    for(const [provider,id] of Object.entries(ids)) {
      if(!id||Number(id)===0)continue;
      const key=`${type}:${provider}:${String(id).toLowerCase()}`,previous=index.get(key)||[];
      for(const other of previous)if(Object.keys(ids).some(p=>ids[p]&&other.ids?.[p]&&String(ids[p]).toLowerCase()!==String(other.ids[p]).toLowerCase())) {
        held.add(media);held.add(other);
      }
      previous.push(media);index.set(key,previous);
    }
  }
  return held;
}

const idKeys=media=>Object.entries(media?.ids||{}).filter(([,id])=>id&&Number(id)!==0).map(([p,id])=>`${p}:${String(id).toLowerCase()}`);

// A tracker review observation can mean the tracker already counts the item
// watched without a usable date (a rating's implied watch, or a show with no
// episode detail). Sending over it would rewrite that state, so hold the send:
// movies by identity, show coverage reviews for the whole show, episode
// mapping reviews for that episode only.
function reviewHoldLookup(review) {
  const ids=idKeys;
  const movies=new Set(),shows=new Set(),episodes=new Set();
  for(const entry of review) {
    const media=entry?.media;if(!media)continue;
    if((media.type||media.mediaType)==='movie')ids(media).forEach(key=>movies.add(key));
    else if(entry.season!=null&&entry.episode!=null)ids(media).forEach(key=>episodes.add(`${key}:${entry.season}:${entry.episode}`));
    else ids(media).forEach(key=>shows.add(key));
  }
  return media=>(media.type||media.mediaType)==='movie'?ids(media).some(key=>movies.has(key))
    :ids(media).some(key=>shows.has(key)||episodes.has(`${key}:${media.season}:${media.episode}`));
}

// Simkl files an episode dated before a show's newest watched episode into a
// separate past watch-through, not the show's progress (live, 23 October), so
// such a send is held rather than landing outside progress and re-sending.
function simklProgressLookup(remote) {
  const latest=new Map();
  for(const {media,remoteWatchedAt} of remote) {
    if((media?.type||media?.mediaType)!=='episode'||!iso(remoteWatchedAt))continue;
    for(const key of idKeys(media))latest.set(key,Math.max(latest.get(key)??0,stamp(remoteWatchedAt)));
  }
  return media=>(media.type||media.mediaType)==='episode'&&Boolean(iso(media.watched_at))&&idKeys(media).some(key=>latest.get(key)>stamp(media.watched_at));
}

export function buildTrackerFullSyncItems(provider,local,remote,{pushSupported=true,review=[],lan={},lanTargets=[],syncEnabled=true,writeHolds=[]}={}) {
  const rows=[],remoteMedia=remote.map(r=>r.media),reviewHeld=reviewHoldLookup(review),olderThanProgress=provider==='simkl'?simklProgressLookup(remote):()=>false;
  const remoteMatches=identityLookup(remote,item=>item.media),localMatches=identityLookup(local),holdMatches=identityLookup(writeHolds,item=>item.media);
  const lanMatches=Object.fromEntries(lanTargets.map(target=>[target,identityLookup(lan[target]||[])]));
  const conflicts=provider==='simkl'?conflictingAliases([...local,...remoteMedia]):new Set();
  const append=(media,side,operation,watchedAt,reason='',existingWatchedAt=null)=>{
    const row={side,operation,title:media.title||'Untitled item',showTitle:media.showTitle||media.show_title||'',
      type:media.type||media.mediaType,season:media.season??null,episode:media.episode??null,
      watchedAt:iso(watchedAt),existingWatchedAt:iso(existingWatchedAt),reason,
      selectable:operation==='add',media};
    row.id=hash([side,operation,keys(media).sort(),row.watchedAt,reason]);rows.push(row);
  };
  for(const media of local) {
    const matches=remoteMatches(media);
    const heldWrite=holdMatches(media)[0];
    if(heldWrite) {append(media,'tracker','skip',media.watched_at,heldWrite.status==='settled'?'Recent delivery is waiting for remote state to settle':`An existing watched write is ${heldWrite.status}; resolve it in Sync Attention`);continue;}
    if(conflicts.has(media)) {append(media,'tracker','skip',media.watched_at,'Conflicting provider identifiers need review');continue;}
    if(!keys(media).length) {append(media,'tracker','skip',media.watched_at,'No supported provider identifiers');continue;}
    if(matches.length) {
      const existing=matches[0].remoteWatchedAt;
      if(iso(media.watched_at)&&iso(existing)&&stamp(media.watched_at)!==stamp(existing))append(media,'tracker','date_difference',media.watched_at,'Existing watched date is preserved by add-only sync',existing);
      continue;
    }
    if(reviewHeld(media)) {append(media,'tracker','skip',media.watched_at,'The tracker may already count this watched; resolve its review in Sync Attention');continue;}
    if(olderThanProgress(media)) {append(media,'tracker','skip',media.watched_at,'Simkl has newer progress on this show and would file this older episode as a past watch-through');continue;}
    if(!pushSupported) {append(media,'tracker','skip',media.watched_at,'Sending to this tracker is not supported');continue;}
    if(!syncEnabled) {append(media,'tracker','skip',media.watched_at,'Watched synchronization is disabled');continue;}
    if(!iso(media.watched_at)) {append(media,'tracker','skip',null,'No observed watch date');continue;}
    if(provider==='simkl')try {simklHistoryPayload(media);}catch(error) {append(media,'tracker','skip',media.watched_at,error.message);continue;}
    append(media,'tracker','add',media.watched_at);
  }
  for(const entry of remote) {
    const {media,remoteWatchedAt}=entry;
    if(conflicts.has(media)) {append(media,'plekt','skip',remoteWatchedAt,'Conflicting provider identifiers need review');continue;}
    if(localMatches(media).length)continue;
    if(!keys(media).length||!iso(remoteWatchedAt)) {append(media,'plekt','skip',remoteWatchedAt,'Missing verified identity or observed watch date');continue;}
    append(media,'plekt','add',remoteWatchedAt);
    const imported=rows.at(-1),missing=[];
    for(const target of lanTargets) {
      const matches=lanMatches[target](media);
      if(matches.some(item=>contradictory(item,media)))append(media,target,'skip',remoteWatchedAt,`Conflicting identifiers on ${target}; no update planned`);
      else if(!matches.length)missing.push(target);
      else if(iso(matches[0].watched_at)&&iso(matches[0].watched_at)!==iso(remoteWatchedAt))append(media,target,'date_difference',remoteWatchedAt,`Existing ${target} watched date is preserved`,matches[0].watched_at);
    }
    imported.destinations=['plekt',...missing];imported.targets=missing;
    if(missing.includes('plex'))imported.notes=['Plex records watched time using its server clock; the historical date cannot be set'];
  }
  for(const entry of review)if(entry.media)append(entry.media,'plekt','skip',entry.watchedAt,entry.reason||'Tracker observation requires review');
  const accepted=new Set();
  for(const row of rows.filter(r=>r.selectable)) {
    const aliases=keys(row.media).map(key=>`${row.side}:${key}`);
    if(aliases.some(key=>accepted.has(key))) {
      row.operation='skip';row.selectable=false;row.reason='Duplicate identity represented by another preview item';
      row.id=hash([row.side,row.operation,keys(row.media).sort(),row.watchedAt,row.reason]);
    } else aliases.forEach(key=>accepted.add(key));
  }
  // Identical aliases can appear more than once in stored snapshots.
  return [...new Map(rows.map(row=>[row.id,row])).values()];
}

export const trackerFullSyncFingerprint=state=>hash({connection:state.connection,local:sorted(state.local),remote:sorted(state.remote),
  review:sorted(state.review||[]),writeHolds:sorted(state.writeHolds||[]),localGuard:state.localGuard,identityGuard:state.identityGuard,
  lan:Object.fromEntries(Object.entries(state.lan||{}).map(([target,items])=>[target,sorted(items)]))});

export function storeTrackerFullSyncPlan(provider,state,{pushSupported=true,outboundOnly=false}={}) {
  const items=buildTrackerFullSyncItems(provider,state.local,state.remote,{pushSupported,review:state.review,lan:state.lan,lanTargets:state.lanTargets,syncEnabled:state.syncEnabled,writeHolds:state.writeHolds});
  const id=crypto.randomUUID(),createdAt=Date.now(),expiresAt=createdAt+TRACKER_PREVIEW_TTL_MS;
  const publicItems=items.map(({media,...row})=>row);
  const counts={add:items.filter(r=>r.operation==='add').length,update:0,remove:0,dateDifferences:items.filter(r=>r.operation==='date_difference').length,skip:items.filter(r=>r.operation!=='add').length};
  const sends=items.filter(r=>r.side==='tracker'&&r.selectable).length;
  const preview={id,createdAt,expiresAt,items:publicItems,counts,requestEstimate:{batchRequests:provider==='simkl'?4*Math.ceil(sends/100):null,verificationMaxRequests:provider==='simkl'?18:null,remainingQuota:state.quotaRemaining??null,
    // Unknown allowance stays unknown in the estimate; it is never assumed.
    ...(provider==='simkl'?{pacing:estimateSimklFullSync(sends,{quotaLimit:state.quotaLimit,quotaRemaining:state.quotaRemaining,policy:SIMKL_FULL_SYNC_NORMAL_POLICY})}:{})}};
  const plan={id,provider,createdAt,expiresAt,status:'ready',fingerprint:trackerFullSyncFingerprint(state),connection:state.connection,items,preview,outboundOnly};
  db.prepare('INSERT INTO settings(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
    .run(`tracker-full-sync-plan:${provider}`,JSON.stringify(plan),createdAt);
  return plan;
}

export function readTrackerFullSyncPlan(provider,id) {
  const row=db.prepare('SELECT data FROM settings WHERE id=?').get(`tracker-full-sync-plan:${provider}`);
  let plan;try {plan=JSON.parse(row?.data||'null');}catch {plan=null;}
  if(!plan||plan.id!==id||plan.status!=='ready')throw Object.assign(new Error('Build a new full-sync preview before applying'),{code:'FULL_SYNC_PREVIEW_REQUIRED',status:409});
  if(plan.expiresAt<=Date.now())throw Object.assign(new Error('This preview expired; build a new preview'),{code:'FULL_SYNC_PLAN_EXPIRED',status:409});
  return plan;
}

export function claimTrackerFullSyncPlan(provider,id) {
  return db.transaction(()=>{
    const plan=readTrackerFullSyncPlan(provider,id);plan.status='applying';
    db.prepare('UPDATE settings SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(plan),Date.now(),`tracker-full-sync-plan:${provider}`);
    return plan;
  }).immediate();
}
