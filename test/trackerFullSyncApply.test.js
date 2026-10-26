import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTempDataDir} from './helpers.js';
makeTempDataDir('plekt-preview-apply-');
process.env.PLEKT_DISABLE_METADATA_PREFETCH='1';
const {db}=await import('../server/src/db.js');
const repo=await import('../server/src/utils/trackerConnectionRepo.js');
const {saveMediaConfig}=await import('../server/src/utils/configStore.js');
const {compareTrackerWithPlekt,startTrackerFullSync}=await import('../server/src/utils/trackers/fullSync.js');
const {listWatchBackups,verifyWatchBackup}=await import('../server/src/utils/watchHistoryBackups.js');

test('Simkl preview recovers audited rejection holds before offering sends without provider calls',async()=>{
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  const connection=repo.saveTrackerConnection({provider:'simkl',remoteUserId:'simkl-review',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000,baselineComplete:true});
  const media={type:'episode',title:'Audited episode',ids:{tvdb:'123'},season:1,episode:2,watched_at:'2020-01-01T00:00:00Z'};
  db.prepare("INSERT INTO watch_history(id,title,media_type,watched_at,source,tvdb_id,season,episode,sync_action,media_key,created_at,updated_at) VALUES('held-episode',?,'episode',?,'plex','123',1,2,'watched','episode:tvdb:123:1:2',?,?)")
    .run(media.title,media.watched_at,Date.now(),Date.now());
  const ledger=await import('../server/src/utils/trackerWriteIntents.js');
  const intent=ledger.createTrackerWriteIntent({provider:'simkl',connection,media,action:'watched'});
  ledger.finishTrackerWriteIntent(intent.id,'rejected','Not watched on Simkl current progress after full-apply audit (23 October); not resent');
  const previous=globalThis.fetch;globalThis.fetch=()=>assert.fail('Preview must not call a provider');
  try {
    const result=await compareTrackerWithPlekt('simkl');
    const row=result.preview.items.find(row=>row.title===media.title&&row.side==='tracker');
    assert.ok(row);assert.equal(row.selectable,false);assert.match(row.reason,/Sync Attention/);
    assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(intent.id).status,'review');
  } finally {globalThis.fetch=previous;}
});

test('selected push verifies a backup before the first write and never sends deselected items',async()=>{
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  repo.saveTrackerConnection({provider:'trakt',clientId:'offline',remoteUserId:'offline',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000,baselineComplete:true});
  for(const id of [1,2])db.prepare('INSERT INTO playstate(media_key,title,media_type,state,watched_at,tmdb_id,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(`movie:tmdb:${id}`,`Offline ${id}`,'movie','watched','2020-01-01T00:00:00Z',String(id),Date.now());
  for(const id of [1,2])db.prepare("INSERT INTO watch_history(id,title,media_type,watched_at,source,tmdb_id,sync_action,media_key,created_at,updated_at) VALUES(?,?,'movie','2020-01-01T00:00:00Z','plex',?,'watched',?,?,?)")
    .run(`offline-${id}`,`Offline ${id}`,String(id),`movie:tmdb:${id}`,Date.now(),Date.now());
  const previous=globalThis.fetch,writes=[];
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url);assert.equal(u.hostname,'api.trakt.tv');
    if(init.method==='POST') {
      assert.equal(u.pathname,'/sync/history');
      const backups=listWatchBackups();assert.ok(backups.length>0);verifyWatchBackup(backups[0].name);
      writes.push(JSON.parse(init.body));
      return Response.json({added:{movies:1},not_found:{movies:[],shows:[],episodes:[]}});
    }
    if(u.pathname.startsWith('/sync/watched/'))return Response.json([],{headers:{'x-pagination-page-count':'1'}});
    return Response.json([{type:'movie',movie:{title:'Offline 1',ids:{trakt:1,tmdb:1}}}]);
  };
  try {
    const state=await compareTrackerWithPlekt('trakt');
    const chosen=state.preview.items.find(r=>r.title==='Offline 1'&&r.selectable);
    const run=await startTrackerFullSync('trakt','push',{planId:state.preview.id,selectedIds:[chosen.id]});
    await run.promise;
    const result=repo.getTrackerConnection('trakt').fullSync;
    assert.equal(result.status,'completed',JSON.stringify(result));
    assert.equal(result.sent,1,JSON.stringify(result));assert.ok(result.backup.name);
    assert.equal(writes.length,1);assert.equal(writes[0].movies.length,1);
    assert.equal(String(writes[0].movies[0].ids.tmdb),'1');
    await assert.rejects(startTrackerFullSync('trakt','push',{planId:state.preview.id,selectedIds:[chosen.id]}),{code:'FULL_SYNC_PREVIEW_REQUIRED'});
  } finally {globalThis.fetch=previous;}
});

test('missing preview and unknown selections fail before provider calls',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=()=>assert.fail('Invalid approval must not fetch');
  try {
    await assert.rejects(startTrackerFullSync('trakt','push'),{code:'FULL_SYNC_PREVIEW_REQUIRED'});
    const state=await compareTrackerWithPlekt('trakt');
    await assert.rejects(startTrackerFullSync('trakt','push',{planId:state.preview.id,selectedIds:['unknown']}),{code:'FULL_SYNC_SELECTION_INVALID'});
  } finally {globalThis.fetch=previous;}
});

test('approved import propagates only to the listed missing LAN destination after backup',async()=>{
  for(const table of ['tracker_connections','tracker_write_intents','tracker_item_state','watch_history','playstate'])db.prepare(`DELETE FROM ${table}`).run();
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:false,baseUrl:'https://emby.test',apiKey:'fake',userId:'u'},jellyfin:{disabled:true}});
  repo.saveTrackerConnection({provider:'trakt',clientId:'offline',remoteUserId:'offline-import',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000,baselineComplete:true});
  const date='2020-01-01T00:00:00.000Z';
  const previous=globalThis.fetch,writes=[];
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url);
    if(u.hostname==='api.trakt.tv') {
      assert.notEqual(init.method,'POST','Import must not echo into a tracker');
      return Response.json(u.pathname==='/sync/watched/movies'?[{last_watched_at:date,movie:{title:'Import movie',year:2020,ids:{tmdb:3}}}]:[],{headers:{'x-pagination-page-count':'1'}});
    }
    assert.equal(u.hostname,'emby.test');
    if(init.method==='POST') {
      assert.equal(u.pathname,'/Users/u/PlayedItems/e3');assert.ok(listWatchBackups().length);
      writes.push(u.pathname);return new Response();
    }
    if(u.searchParams.get('Filters')==='IsPlayed')return Response.json({Items:[],TotalRecordCount:0});
    const item={Id:'e3',Name:'Import movie',Type:'Movie',ProviderIds:{Tmdb:'3'},UserData:{Played:false,PlayCount:0}};
    return Response.json(u.pathname==='/Users/u/Items'?{Items:[item],TotalRecordCount:1}:item);
  };
  try {
    let state=await compareTrackerWithPlekt('trakt');
    // Stored observations are initially empty: first fresh read replaces the
    // preview, without executing an unseen remote watch.
    const makeSelection=()=>state.preview.items.filter(r=>r.side==='plekt'&&r.selectable).map(r=>r.id);
    assert.equal(makeSelection().length,0);
    repo.replaceTrackerSnapshot('trakt',[{mediaKey:'movie:tmdb:3',media:{type:'movie',title:'Import movie',ids:{tmdb:'3'}},watchedAt:Date.parse(date)}]);
    state=await compareTrackerWithPlekt('trakt');
    try {await startTrackerFullSync('trakt','import',{planId:state.preview.id,selectedIds:makeSelection()});assert.fail('Fresh source differences must require review');}
    catch(error) {assert.equal(error.code,'FULL_SYNC_PLAN_STALE');}
    assert.equal(writes.length,0);state=repo.getTrackerConnection('trakt').fullSync;
    assert.deepEqual(state.preview.items.find(r=>r.side==='plekt'&&r.selectable).destinations,['plekt','emby']);
    const run=await startTrackerFullSync('trakt','import',{planId:state.preview.id,selectedIds:makeSelection()});await run.promise;
    const result=repo.getTrackerConnection('trakt').fullSync;
    assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.imported,1);
    assert.deepEqual(writes,['/Users/u/PlayedItems/e3']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM watch_history').get().n,1);
  } finally {globalThis.fetch=previous;}
});

test('the local watched set comes from history, not a bare or unwatched playstate flag',async()=>{
  for(const table of ['tracker_connections','tracker_write_intents','tracker_item_state','watch_history','playstate'])db.prepare(`DELETE FROM ${table}`).run();
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  repo.saveTrackerConnection({provider:'trakt',clientId:'offline',remoteUserId:'offline-local',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000,baselineComplete:true});
  const history=(id,tmdb,action,at)=>db.prepare("INSERT INTO watch_history(id,title,media_type,watched_at,source,tmdb_id,sync_action,media_key,created_at,updated_at) VALUES(?,?,'movie',?,'trakt_import',?,?,?,?,?)")
    .run(id,`Movie ${tmdb}`,at,String(tmdb),action,`movie:tmdb:${tmdb}`,Date.parse(at),Date.parse(at));
  const flag=(tmdb,state)=>db.prepare("INSERT INTO playstate(media_key,title,media_type,state,watched_at,tmdb_id,updated_at) VALUES(?,?,'movie',?,'2020-01-01T00:00:00Z',?,?)").run(`movie:tmdb:${tmdb}`,`Movie ${tmdb}`,state,String(tmdb),Date.now());
  history('h1',1,'watched','2020-01-01T00:00:00Z');                 // history only: watched
  flag(2,'watched');                                                  // flag only: not a play
  history('h3',3,'watched','2020-01-01T00:00:00Z');flag(3,'unwatched'); // unwatched under an alias
  history('h4a',4,'watched','2020-01-01T00:00:00Z');history('h4b',4,'unwatched','2021-01-01T00:00:00Z'); // latest is unwatch
  const state=await compareTrackerWithPlekt('trakt');
  assert.deepEqual(state.preview.items.filter(r=>r.side==='tracker'&&r.selectable).map(r=>r.title),['Movie 1']);
});
