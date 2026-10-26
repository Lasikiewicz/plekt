import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';
import { simklTransport } from '../server/src/utils/trackers/simklTransport.js';
makeTempDataDir('plekt-simkl-batch-');
const { db } = await import('../server/src/db.js');
const repo = await import('../server/src/utils/trackerConnectionRepo.js');
const { createTrackerWriteIntent, maintainTrackerWriteIntents } = await import('../server/src/utils/trackerWriteIntents.js');
const { writeSimklWatched } = await import('../server/src/utils/trackers/simkl.js');
const date='2026-10-22T12:00:00.000Z',cursor='2026-10-22T11:59:00Z';
function setup(count) {
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  db.prepare('DELETE FROM tracker_write_intents').run();
  db.prepare('DELETE FROM tracker_connections').run();
  repo.saveTrackerConnection({provider:'simkl',clientId:'client',remoteUserId:'batch-account',accessToken:'test-token',refreshToken:'test-refresh',accessTokenExpiresAt:Date.now()+3600_000});
  const connection=repo.getTrackerConnection('simkl',{includeCredentials:true});
  const items=Array.from({length:count},(_,i)=>{
    const media={type:'movie',title:`Movie ${i}`,ids:{tmdb:i+1},watched_at:date};
    const intent=createTrackerWriteIntent({provider:'simkl',connection,media,action:'watched'});
    return {...media,trackerWriteIntentId:intent.id};
  });
  return {connection,items};
}
async function withFetch(handler,work) {
  const previous=globalThis.fetch; simklTransport.resetForTests();
  globalThis.fetch=async(...args)=>{
    assert.equal(new URL(args[0]).hostname,'api.simkl.com');
    const r=await handler(...args);
    if(!r.headers.has('x-ratelimit-remaining'))r.headers.set('x-ratelimit-remaining','400');
    r.headers.set('x-ratelimit-limit','500');return r;
  };
  try {await work();}finally{globalThis.fetch=previous;}
}
test('100 durable writes claim the whole chunk and use four requests, one POST and one watched readback',async()=>{
  const {connection,items}=setup(100);const calls=[];let posts=0;
  await withFetch((url,options)=>{
    const u=new URL(url);calls.push([options.method,u.pathname]);
    if(new URL(url).pathname==='/sync/history'){
      posts++;assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='sending'").get().n,100);
      const body=JSON.parse(options.body);assert.equal(body.movies.length,100);
      assert.ok(body.movies.every(m=>m.watched_at===date));
      return Response.json({added:{movies:100,episodes:0},not_found:{}});
    }
    if(u.pathname==='/sync/activities')return Response.json({all:posts?'2026-10-22T12:01:00Z':cursor});
    assert.equal(u.pathname,'/sync/watched');assert.equal(u.searchParams.get('extended'),'episodes');
    return Response.json(JSON.parse(options.body).map(({ids})=>({ids,result:true,list:'completed',last_watched_at:date})));
  },async()=>{
    await Promise.all(items.map(m=>writeSimklWatched(connection,m,{trigger:'event',sendNow:true})));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='settled'").get().n,100);
  });
  assert.equal(calls.length,4);assert.equal(posts,1);
});
test('insufficient or missing quota leaves attempts at zero and does not repeat preflight',async()=>{
  for(const quota of ['57',null]){
    const {connection,items}=setup(2);let calls=0;
    await withFetch(()=>{calls++;return Response.json({all:cursor},{headers:quota===null?{'x-ratelimit-remaining':'unknown'}:{'x-ratelimit-remaining':quota}});},async()=>{
      const outcomes=await Promise.allSettled(items.map(m=>writeSimklWatched(connection,m,{trigger:'event',sendNow:true})));
      assert.ok(outcomes.every(r=>r.status==='rejected'&&r.reason.code==='SIMKL_QUOTA_RESERVE'));
      await assert.rejects(writeSimklWatched(connection,items[0],{trigger:'event',sendNow:true}),{code:'SIMKL_QUOTA_RESERVE'});
      assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='pending' AND attempts=0").get().n,2);
    });assert.equal(calls,1);
  }
});
test('lost batch response holds every claimed intent and a second call cannot resend',async()=>{
  const {connection,items}=setup(2);let posts=0;
  await withFetch((url,options)=>{
    if(new URL(url).pathname==='/sync/history'){posts++;throw new Error('lost');}
    if(new URL(url).pathname==='/sync/activities')return Response.json({all:posts?'2026-10-22T12:01:00Z':cursor});
    return Response.json({});
  },async()=>{
    await Promise.allSettled(items.map(m=>writeSimklWatched(connection,m,{trigger:'event',sendNow:true})));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='review' AND attempts=1").get().n,2);
    await Promise.allSettled(items.map(m=>writeSimklWatched(connection,m,{trigger:'event',sendNow:true})));
    assert.equal(posts,1);
  });
});
test('disabled Simkl cannot read, claim or send queued writes',async()=>{
  const {connection,items}=setup(1);
  db.prepare("UPDATE tracker_connections SET status='disabled' WHERE provider='simkl'").run();
  await withFetch(()=>assert.fail('disabled connection must not fetch'),async()=>{
    await assert.rejects(writeSimklWatched(connection,items[0],{trigger:'event',sendNow:true}));
    assert.equal(db.prepare('SELECT attempts FROM tracker_write_intents').get().attempts,0);
  });
});
test('disable during POST never acknowledges delivery and expired sending leases recover to review',async()=>{
  const {connection,items}=setup(1);
  await withFetch((url,options)=>{
    if(new URL(url).pathname==='/sync/history'){
      db.prepare("UPDATE tracker_connections SET status='disabled' WHERE provider='simkl'").run();
      return Response.json({added:{movies:1,episodes:0},not_found:{}});
    }
    if(new URL(url).pathname==='/sync/activities')return Response.json({all:cursor});
    return Response.json({});
  },async()=>{
    await assert.rejects(writeSimklWatched(connection,items[0],{trigger:'event',sendNow:true}));
    assert.equal(db.prepare('SELECT status FROM tracker_write_intents').get().status,'sending');
    // The durable lease, not an in-memory flight, governs restart recovery.
    maintainTrackerWriteIntents(Date.now()+6*60_000);
    assert.equal(db.prepare('SELECT status FROM tracker_write_intents').get().status,'review');
  });
});
