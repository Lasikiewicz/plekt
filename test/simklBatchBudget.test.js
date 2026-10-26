import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createSimklBatchBudget} from '../server/src/utils/trackers/simklBatchBudget.js';
import {nextSimklDailyReset} from '../server/src/utils/trackers/simklTransport.js';

test('durable reservation fences recreated budgets, token rotation and reconnect until reset',()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE settings(id TEXT PRIMARY KEY,data TEXT,updated_at INTEGER)');
  let time=Date.parse('2026-10-23T12:00:00Z');
  const scope={id:'generation',clientId:'client',remoteUserId:'private-account',accessToken:'private-token'};
  try {
    const first=createSimklBatchBudget(db,()=>time),ticket=first.acquire(scope);
    const restarted=createSimklBatchBudget(db,()=>time);
    assert.throws(()=>restarted.acquire({...scope,id:'new-generation',accessToken:'rotated'}),{code:'SIMKL_QUOTA_RESERVE'});
    first.complete(ticket,55);
    assert.throws(()=>restarted.acquire(scope),{code:'SIMKL_QUOTA_RESERVE'});
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes('private-'),false);
    time=nextSimklDailyReset(time);
    const next=restarted.acquire(scope);
    // A delayed completion from yesterday cannot release today's reservation.
    first.complete(ticket,400);
    assert.throws(()=>restarted.acquire(scope),{code:'SIMKL_QUOTA_RESERVE'});
    restarted.complete(next,59);
    assert.doesNotThrow(()=>restarted.acquire(scope));
  } finally {db.close();}
});

test('unknown quota retains the hold; independent accounts do not block each other',()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE settings(id TEXT PRIMARY KEY,data TEXT,updated_at INTEGER)');
  const budget=createSimklBatchBudget(db),scope={clientId:'client',remoteUserId:'one'};
  try {
    const ticket=budget.acquire(scope);
    budget.complete(ticket,undefined);
    assert.throws(()=>budget.acquire(scope),{code:'SIMKL_QUOTA_RESERVE'});
    assert.doesNotThrow(()=>budget.acquire({...scope,remoteUserId:'two'}));
  } finally {db.close();}
});
