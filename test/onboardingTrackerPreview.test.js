import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTempDataDir} from './helpers.js';
makeTempDataDir('plekt-first-run-preview-');
process.env.PLEKT_DISABLE_METADATA_PREFETCH='1';
const {db}=await import('../server/src/db.js');
const repo=await import('../server/src/utils/trackerConnectionRepo.js');
const {saveMediaConfig}=await import('../server/src/utils/configStore.js');
const {getOnboardingState,saveOnboardingState}=await import('../server/src/utils/onboardingStore.js');
const {startTrackerImport}=await import('../server/src/utils/onboardingImportCoordinator.js');

test('first-run tracker import establishes a baseline then imports eligible history without a separate preview',async()=>{
  saveOnboardingState({runState:'in_progress',currentStep:'trackers',backgroundImports:{servers:{},trackers:{}}});
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  repo.saveTrackerConnection({provider:'trakt',clientId:'offline',remoteUserId:'offline',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600000,initialSyncMode:'import',baselineComplete:false});
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url);assert.equal(u.hostname,'api.trakt.tv');calls.push([init.method||'GET',u.pathname]);
    assert.notEqual(init.method,'POST','Import cannot echo history to its source');
    return Response.json(u.pathname==='/sync/watched/movies'?[{last_watched_at:'2020-01-01T00:00:00Z',movie:{title:'Offline first-run movie',ids:{tmdb:5}}}]:[],{headers:{'x-pagination-page-count':'1'}});
  };
  try {
    const started=await startTrackerImport('trakt');
    assert.equal(started.started,true);
    assert.equal(repo.getTrackerConnection('trakt').baselineComplete,true);
    assert.ok(calls.every(([,path])=>!path.includes('/sync/history/')),'Baseline must not backfill old plays');
    for(let turn=0;turn<10&&getOnboardingState().backgroundImports.trackers.trakt.status==='importing';turn++)await new Promise(setImmediate);
    const state=getOnboardingState().backgroundImports.trackers.trakt;
    assert.equal(state.status,'complete',JSON.stringify(state));assert.equal(state.itemCount,1);assert.ok(state.backup.name);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM watch_history').get().n,1);
    const nothing=await startTrackerImport('trakt');assert.equal(nothing.code,'NOTHING_TO_IMPORT');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM watch_history').get().n,1);
  } finally {globalThis.fetch=previous;}
});
