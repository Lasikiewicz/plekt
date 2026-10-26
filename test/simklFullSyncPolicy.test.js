import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateSimklFullSync,simklFullSyncProtectedQuota} from '../server/src/utils/trackers/simklFullSyncPolicy.js';
const policy={mode:'percent',value:0.2};
const now=Date.parse('2026-10-24T12:00:00Z');
test('large libraries forecast daily slices with independent normal and safety reserves',()=>{
  const estimate=estimateSimklFullSync(20000,{quotaLimit:500,quotaRemaining:500,policy,now});
  assert.equal(estimate.normalReserve,100);assert.equal(estimate.safetyReserve,55);
  assert.equal(estimate.batchRequests,800);assert.equal(estimate.itemsToday,8100);
  assert.equal(estimate.estimatedDays,3);assert.equal(estimate.pacingRequired,true);
});
test('small selections fit today while a spent allowance waits for a new quota window',()=>{
  const small=estimateSimklFullSync(148,{quotaLimit:500,quotaRemaining:400,policy,now});
  assert.equal(small.totalRequests,26);assert.equal(small.estimatedDays,1);assert.equal(small.pacingRequired,false);
  const low=estimateSimklFullSync(148,{quotaLimit:500,quotaRemaining:160,policy,now});
  assert.equal(low.itemsToday,0);assert.equal(low.estimatedDays,2);assert.equal(low.pacingRequired,true);
});
test('unknown quota and reserve policy never fabricate an allowance or a completion date',()=>{
  for(const metadata of [{},{quotaLimit:500},{quotaRemaining:400},{quotaLimit:500,quotaRemaining:501}]) {
    const result=estimateSimklFullSync(9000,{...metadata,policy,now});
    assert.equal(result.quotaKnown,false);assert.equal(result.estimatedDays,null);
  }
  assert.equal(simklFullSyncProtectedQuota(500,null),null);
  assert.equal(estimateSimklFullSync(0,{now}).estimatedDays,0);
});
test('alternate explicit policies scale to the observed account allowance',()=>{
  assert.equal(simklFullSyncProtectedQuota(1000,{mode:'percent',value:0.1}).protectedQuota,155);
  assert.equal(simklFullSyncProtectedQuota(500,{mode:'fixed',value:50}).protectedQuota,105);
});
