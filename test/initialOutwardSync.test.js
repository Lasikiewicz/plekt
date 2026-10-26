import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {makeTempDataDir} from './helpers.js';
makeTempDataDir('plekt-initial-outward-');
process.env.PLEKT_DISABLE_METADATA_PREFETCH='1';
const {db}=await import('../server/src/db.js');
const {saveOnboardingState,getOnboardingState}=await import('../server/src/utils/onboardingStore.js');
const store=await import('../server/src/utils/initialSyncStore.js');
const {initialSyncDestinations,armInitialSync,runInitialSync,runInitialDestination}=await import('../server/src/utils/initialOutwardSync.js');
const {saveMediaConfig}=await import('../server/src/utils/configStore.js');
const config={plex:{disabled:true},emby:{baseUrl:'https://emby.test',apiKey:'fake',userId:'u'},jellyfin:{disabled:true}};
const movie=(id=1)=>({type:'movie',title:`Movie ${id}`,ids:{tmdb:id},watched_at:'2020-01-01T00:00:00.000Z'});
const dest=()=>initialSyncDestinations(config,[])[0];
function seed(status='running',destination=dest()) {
  return store.saveInitialSync({id:'job',status,startedAt:1,destinations:[destination]});
}
const readDestination=()=>store.readInitialSync().destinations[0];
const options=()=>({configRead:async()=>config,localRead:()=>[movie()],scanServer:async()=>({scopeErrors:[],itemsByServer:{emby:[]}}),
  backup:async()=>({name:'verified'}),verifyBackup:()=>{},loopStore:()=>({})});
beforeEach(async()=>{
  for(const table of ['settings','initial_sync_items','watch_history','playstate','tracker_connections'])db.prepare(`DELETE FROM ${table}`).run();
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  saveOnboardingState({accountClaimed:true,runState:'in_progress',initialSyncEligible:true,currentStep:'imports',backgroundImports:{servers:{},trackers:{}}});
});

test('only writable media servers and connected registered trackers become destinations',()=>{
  const destinations=initialSyncDestinations({...config,emby:{...config.emby,sync:{preset:'source_only'}},jellyfin:{baseUrl:'https://jelly.test',apiKey:'fake',userId:'u'}},[
    {provider:'trakt',id:'t',remoteUserId:'a',status:'connected'},
    {provider:'simkl',id:'s',remoteUserId:'b',status:'reauth_required'},
    {provider:'netflix',status:'connected'},
  ]);
  assert.deepEqual(destinations.map(d=>d.provider),['jellyfin','trakt']);
  assert.equal(destinations[1].connectionId,'t');assert.equal(destinations[1].accountId,'a');
  assert.doesNotMatch(JSON.stringify(destinations),/apiKey|fake/);
});
test('arming is explicit, idempotent and unavailable on existing completed installs',async()=>{
  saveOnboardingState({runState:'completed'});assert.equal(await armInitialSync({launch:false}),null);
  saveOnboardingState({runState:'in_progress',initialSyncEligible:false});assert.equal(await armInitialSync({launch:false}),null);
  saveOnboardingState({runState:'in_progress',initialSyncEligible:true});
  const first=await armInitialSync({launch:false}),second=await armInitialSync({launch:false});
  assert.equal(first.id,second.id);assert.equal(first.status,'waiting');
});
test('all tracker, server and one-time imports are completion barriers, including failures',()=>{
  for(const group of ['trackers','servers','oneTime']) {
    for(const status of ['importing','running','failed','preview_required']) {
      assert.equal(store.initialImportsPending({backgroundImports:{[group]:{x:{enabled:true,status}}}}),true);
    }
    for(const status of ['complete','cancelled'])assert.equal(store.initialImportsPending({backgroundImports:{[group]:{x:{status}}}}),false);
  }
});
test('concurrent one-time commits stay pending until both finish, even after finishing the wizard',async()=>{
  seed('waiting');let releaseA,releaseB;
  const a=store.withInitialInboundImport('netflix',()=>new Promise(resolve=>releaseA=resolve));
  saveOnboardingState({runState:'completed'});
  const b=store.withInitialInboundImport('tautulli',()=>new Promise(resolve=>releaseB=resolve));
  releaseA({});await a;assert.equal(store.initialImportsPending(),true);
  releaseB({});await b;assert.equal(store.initialImportsPending(),false);assert.equal(store.initialImportsCompleted(),true);
});
test('a failed one-time import blocks until retried; successful retry clears the old failure',async()=>{
  await assert.rejects(store.withInitialInboundImport('netflix',async()=>{throw new Error('injected');}),/injected/);
  assert.equal(store.initialImportsPending(),true);
  await store.withInitialInboundImport('netflix',async()=>({}));
  assert.equal(store.initialImportsPending(),false);
  seed();await assert.rejects(store.withInitialInboundImport('netflix',async()=>assert.fail('must not start')),{code:'INITIAL_SYNC_STARTED'});
});
test('all-skipped imports skip outward work even with existing local history',async()=>{
  seed('waiting');let calls=0;
  await runInitialSync('job',{runTarget:async()=>calls++});
  assert.equal(calls,0);assert.equal(store.readInitialSync().status,'skipped');
});
test('active selected imports prevent the runner starting',async()=>{
  seed('waiting');saveOnboardingState({backgroundImports:{trackers:{trakt:{enabled:true,status:'importing'}}}});
  assert.equal(await runInitialSync('job',{runTarget:()=>assert.fail('pending import')}),false);
  assert.equal(store.readInitialSync().status,'waiting');
});
test('media sends are add-only, destination-scoped and backed up first',async()=>{
  seed();const calls=[];
  await runInitialDestination('job',dest(),{...options(),backup:async()=>{calls.push('backup');return {name:'b'};},verifyBackup:()=>calls.push('verified'),
    dispatchServer:async(media,_config,_loop,state,dispatchOptions)=>{
      calls.push('send');assert.equal(state,'watched');assert.deepEqual(media.syncTargets,['emby']);assert.equal(dispatchOptions.includeTrackers,false);
      assert.equal(media.watched_at,'2020-01-01T00:00:00.000Z');
      assert.equal(readDestination().items[0].status,'sending');
      return {targetStates:[{target:'emby',status:'success'}]};
    }});
  assert.deepEqual(calls,['backup','verified','send']);assert.equal(readDestination().status,'completed');
  assert.equal(store.initialSyncSummary().remaining,0);
});
test('already watched media never gets a duplicate send or backup',async()=>{
  seed();await runInitialDestination('job',dest(),{...options(),scanServer:async()=>({scopeErrors:[],itemsByServer:{emby:[{type:'movie',tmdb:1}]}}),
    backup:()=>assert.fail('nothing missing'),dispatchServer:()=>assert.fail('already watched')});
  assert.equal(readDestination().items.length,0);assert.equal(readDestination().status,'completed');
});
test('incomplete scans and changed destination identity fail closed',async()=>{
  seed();await runInitialDestination('job',dest(),{...options(),scanServer:async()=>({scopeErrors:[{server:'emby'}]}),dispatchServer:()=>assert.fail('incomplete scan')});
  assert.equal(readDestination().status,'failed');assert.match(readDestination().error,/read failed/);
  seed();await runInitialDestination('job',dest(),{...options(),configRead:async()=>({...config,emby:{...config.emby,userId:'other'}}),dispatchServer:()=>assert.fail('changed user')});
  assert.equal(readDestination().status,'failed');assert.match(readDestination().error,/connection/);
});
test('history changes while awaiting configuration stop before any write',async()=>{
  seed();let local=[movie()];
  await runInitialDestination('job',dest(),{...options(),localRead:()=>local,configRead:async()=>{local=[];return config;},dispatchServer:()=>assert.fail('newer unwatch')});
  assert.equal(readDestination().status,'failed');assert.match(readDestination().error,/History/);
});
test('tracker planning selects only add rows and preserves review holds and per-item outcomes',async()=>{
  const destination={provider:'simkl',kind:'tracker',label:'Simkl',connectionId:'c',accountId:'a',status:'waiting',items:[]};seed('running',destination);
  await runInitialDestination('job',destination,{...options(),connectionRead:()=>({id:'c',remoteUserId:'a',status:'connected'}),
    prepareTracker:async()=>({id:'plan',items:[{id:'add',side:'tracker',operation:'add',selectable:true,media:movie()},
      {id:'inbound',side:'plekt',operation:'add',selectable:true,media:movie(2)},
      {id:'date',side:'tracker',operation:'date_difference',selectable:false,media:movie(3)},
      {id:'hold',side:'tracker',operation:'skip',selectable:false,reason:'Coverage hold',media:movie(4)}]}),
    startTracker:async(provider,direction,{selectedIds,onItems,isCancelled})=>{
      assert.equal(provider,'simkl');assert.equal(direction,'push');assert.deepEqual(selectedIds,['add']);assert.equal(isCancelled(),false);
      onItems([{id:'add',status:'completed'}]);return {promise:Promise.resolve()};
    }});
  assert.equal(readDestination().status,'partial');assert.equal(store.initialSyncSummary().remaining,1);
  assert.equal(store.initialSyncSummary().items[0].detail,'Coverage hold');
});
test('replacement-account generation is rejected before planning a tracker write',async()=>{
  const destination={provider:'simkl',kind:'tracker',label:'Simkl',connectionId:'old',accountId:'a',items:[]};seed('running',destination);
  await runInitialDestination('job',destination,{...options(),connectionRead:()=>({id:'new',remoteUserId:'b',status:'connected'}),prepareTracker:()=>assert.fail('replacement account')});
  assert.equal(readDestination().status,'failed');
});
test('restart preserves completed rows and turns uncertain sends into review without replay',()=>{
  const destination=dest();destination.items=[{id:'one',title:'one',media:movie(),status:'completed'},{id:'two',title:'two',media:movie(2),status:'sending'}];seed('running',destination);
  store.recoverInitialSync();const recovered=store.readInitialSync();
  assert.equal(recovered.status,'interrupted');assert.deepEqual(recovered.destinations[0].items.map(i=>i.status),['completed','review']);
  assert.match(recovered.error,/restart/);assert.equal(store.initialSyncSummary().remaining,1);
  assert.equal('media' in store.initialSyncSummary().items[0],false);
  assert.equal(getOnboardingState().pushSync.status,'interrupted');
});

test('the real Trakt planner and dispatcher send only a missing movie and persist the acknowledged outcome',async()=>{
  const {saveTrackerConnection}=await import('../server/src/utils/trackerConnectionRepo.js');
  const connection=saveTrackerConnection({provider:'trakt',remoteUserId:'offline',clientId:'offline',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000,baselineComplete:true});
  const destination={provider:'trakt',kind:'tracker',label:'Trakt',connectionId:connection.id,accountId:'offline',status:'waiting',items:[]};
  for(const id of [1,2])db.prepare("INSERT INTO watch_history(id,title,media_type,watched_at,source,tmdb_id,sync_action,media_key,created_at,updated_at) VALUES(?,?,'movie','2020-01-01T00:00:00Z','plex',?,'watched',?,?,?)")
    .run(`movie-${id}`,`Movie ${id}`,String(id),`movie:tmdb:${id}`,Date.now(),Date.now());
  saveOnboardingState({backgroundImports:{trackers:{trakt:{status:'complete',enabled:true}}}});seed('waiting',destination);
  const previous=globalThis.fetch,writes=[];
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url);assert.equal(u.hostname,'api.trakt.tv');
    if(init.method==='POST') {
      assert.equal(u.pathname,'/sync/history');writes.push(JSON.parse(init.body));
      const {listWatchBackups}=await import('../server/src/utils/watchHistoryBackups.js');assert.ok(listWatchBackups().length);
      return Response.json({added:{movies:1},not_found:{movies:[],shows:[],episodes:[]}});
    }
    if(u.pathname==='/sync/watched/movies')return Response.json([{last_watched_at:'2020-01-01T00:00:00Z',movie:{title:'Movie 1',ids:{tmdb:1}}}],{headers:{'x-pagination-page-count':'1'}});
    if(u.pathname==='/sync/watched/shows')return Response.json([],{headers:{'x-pagination-page-count':'1'}});
    return Response.json([{type:'movie',movie:{title:'Movie 2',ids:{trakt:2,tmdb:2}}}]);
  };
  try {
    assert.equal(await runInitialSync('job'),true);
    assert.equal(writes.length,1);assert.deepEqual(writes[0].movies.map(m=>m.ids.tmdb),[2]);
    assert.equal(store.readInitialSync().status,'completed',JSON.stringify(store.readInitialSync()));
    assert.equal(store.initialSyncSummary().remaining,0);assert.equal(readDestination().items.length,1);
  } finally {globalThis.fetch=previous;}
});

test('missing tracker item outcomes stay held rather than being reported completed',async()=>{
  const destination={provider:'simkl',kind:'tracker',label:'Simkl',connectionId:'c',accountId:'a',items:[]};seed('running',destination);
  await runInitialDestination('job',destination,{...options(),connectionRead:()=>({id:'c',remoteUserId:'a',status:'connected'}),
    prepareTracker:async()=>({id:'p',items:[{id:'add',side:'tracker',operation:'add',selectable:true,media:movie()}]}),
    startTracker:async()=>({promise:Promise.resolve()})});
  assert.equal(readDestination().status,'partial');assert.equal(readDestination().items[0].status,'review');
});

test('backup round-trip keeps confirmed items and quarantines unfinished items and active headers',async()=>{
  const {exportCollectionPage,importCollectionBatch}=await import('../server/src/utils/backup.js');
  const destination=dest();destination.items=[{id:'done',media:movie(),status:'completed'},{id:'uncertain',media:movie(2),status:'sending'}];seed('running',destination);
  const items=exportCollectionPage('initialSyncItems').documents;
  const settings=exportCollectionPage('settings').documents.filter(row=>['initial-outward-sync','onboarding'].includes(row.id));
  importCollectionBatch('initialSyncItems',items,{reset:true});
  importCollectionBatch('settings',settings,{reset:true});
  assert.equal(store.readInitialSync().status,'interrupted');
  assert.deepEqual(readDestination().items.map(item=>item.status),['completed','review']);
  assert.equal(getOnboardingState().pushSync.status,'interrupted');
  assert.equal(await runInitialSync('job'),false);
});
