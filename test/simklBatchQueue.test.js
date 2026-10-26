import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimklBatchQueue } from '../server/src/utils/trackers/simklBatchQueue.js';

function fixture(overrides = {}) {
  const chunks = [], finished = [], claims = [];
  const enqueue = createSimklBatchQueue({ current() {}, matches:(a,b)=>a.id===b.id,
    prepare:async()=>({preSendCursor:'cursor'}), claim:c=>claims.push(c.map(i=>i.intent.id)),
    send:async(c,media)=>{chunks.push(media);return media.map(()=>({status:'settled'}));},
    finish:(item,status)=>finished.push([item.intent.id,status]), ...overrides });
  const connection = {id:'generation',remoteUserId:'account'};
  const push = id => enqueue(connection,{id},{id},'event');
  return {push,enqueue,connection,chunks,finished,claims};
}
test('101 concurrent intents form two bounded chunks and duplicate callers share a flight',async()=>{
  const f=fixture();
  const first=f.push('0');
  assert.equal(f.push('0'),first);
  await Promise.all([first,...Array.from({length:100},(_,i)=>f.push(String(i+1)))]);
  assert.deepEqual(f.chunks.map(c=>c.length),[100,1]);
  assert.equal(f.finished.length,101);
});
test('quota refusal leaves the entire chunk unclaimed and unsent',async()=>{
  const f=fixture({prepare:async()=>{throw new Error('reserve');}});
  const results=await Promise.allSettled([f.push('a'),f.push('b')]);
  assert.ok(results.every(r=>r.status==='rejected'));
  assert.equal(f.claims.length,0); assert.equal(f.chunks.length,0); assert.equal(f.finished.length,0);
});
test('lost response holds the whole claimed chunk and never resends',async()=>{
  let posts=0;
  const f=fixture({send:async()=>{posts++;throw new Error('lost');}});
  await Promise.allSettled([f.push('a'),f.push('b')]);
  assert.equal(posts,1); assert.deepEqual(f.finished,[['a','review'],['b','review']]);
});
test('partial not-found outcomes settle and reject independently',async()=>{
  const f=fixture({send:async()=>[{status:'settled'},{status:'rejected',detail:'no match'}]});
  const results=await Promise.allSettled([f.push('a'),f.push('b')]);
  assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);
  assert.deepEqual(f.finished,[['a','settled'],['b','rejected']]);
});
test('a generation change after readback does not report delivery success',async()=>{
  let calls=0;
  const f=fixture({current(){if(++calls===3)throw new Error('stale');}});
  await assert.rejects(f.push('a'),/stale/);
  assert.deepEqual(f.finished,[['a','review']]);
});
test('failed atomic claim never sends or settles any item',async()=>{
  const f=fixture({claim(){throw new Error('claim conflict');}});
  await assert.rejects(f.push('a'),/claim conflict/);
  assert.equal(f.chunks.length,0); assert.equal(f.finished.length,0);
});
test('user and event dispatches share one account queue rather than competing quota preflights',async()=>{
  const f=fixture();
  await Promise.all([
    f.enqueue(f.connection,{id:'u'},{id:'u'},'user'),
    f.enqueue(f.connection,{id:'e'},{id:'e'},'event'),
  ]);
  assert.deepEqual(f.chunks.map(c=>c.length),[2]);
});
