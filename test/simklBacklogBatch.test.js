import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';

// Database-backed imports must follow private DATA_DIR setup.
makeTempDataDir('plekt-simkl-backlog-');
const { db } = await import('../server/src/db.js');
const repo = await import('../server/src/utils/trackerConnectionRepo.js');
const data = await import('../server/src/utils/dataRepo.js');
const { listDueTrackerWriteIntents } = await import('../server/src/utils/trackerWriteIntents.js');
const { syncPendingTrackerWriteIntents } = await import('../server/src/utils/trackerIntentWorker.js');
const { simklTransport } = await import('../server/src/utils/trackers/simklTransport.js');

const watchedAt = '2026-10-22T12:34:56.000Z';
function reset() {
  for (const table of ['tracker_write_intents', 'tracker_observations', 'tracker_connections', 'watch_history', 'playstate']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  repo.saveTrackerConnection({ provider: 'simkl', clientId: 'offline-client', remoteUserId: 'offline-account',
    accessToken: 'fake-access', refreshToken: 'fake-refresh', accessTokenExpiresAt: Date.now() + 3_600_000 });
  simklTransport.resetForTests();
}
function addWatch(i) {
  const media = { type: 'movie', title: `Offline Backlog ${i}`, ids: { tmdb: i + 10000 }, tmdb_id: i + 10000,
    watched_at: watchedAt, source: 'plex', sync_action: 'watched', sync_dispatch_telemetry: 'Target plex status: success\nTarget emby status: success\nTarget jellyfin status: success\nTarget simkl status: pending\nDispatch status: pending' };
  const inserted = data.insertWatchRecordSync(media);
  const intent = db.prepare('SELECT * FROM tracker_write_intents WHERE watch_record_id=? AND provider=?').get(inserted.id, 'simkl');
  assert.ok(intent, 'watch insert should capture the connected Simkl destination');
  // Worker tests cover intents that are already due after the coalesce window.
  db.prepare('UPDATE tracker_write_intents SET due_at=? WHERE id=?').run(Date.now(), intent.id);
  return { id: inserted.id, intent: db.prepare('SELECT * FROM tracker_write_intents WHERE id=?').get(intent.id) };
}
async function withFetch(work, { failPost = false, onPreflight } = {}) {
  const previous = globalThis.fetch;
  const calls = [];
  let posted = false;
  simklTransport.resetForTests();
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.simkl.com', 'offline test must not call another service');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: parsed.pathname, body, url: parsed });
    if (parsed.pathname === '/sync/history' && method === 'POST') {
      if (failPost) throw new Error('simulated lost response');
      posted = true;
      return Response.json({ added: { movies: body.movies.length, episodes: 0 }, not_found: {} }, { headers: { 'x-ratelimit-remaining': '400' } });
    }
    if (parsed.pathname === '/sync/activities') {if(!posted)onPreflight?.();return Response.json({ all: posted ? '2026-10-22T13:00:00.000Z' : '2026-10-22T12:00:00.000Z' }, { headers: { 'x-ratelimit-remaining': '400' } });}
    assert.equal(parsed.pathname, '/sync/watched');
    const sent = calls.findLast(call => call.path === '/sync/history')?.body.movies || [];
    return Response.json(body.map(({ ids }) => ({ ids, result: true, list: 'completed',
      last_watched_at: sent.find(item => item.ids.tmdb === ids.tmdb)?.watched_at })), { headers: { 'x-ratelimit-remaining': '400' } });
  };
  try { await work(calls); } finally { globalThis.fetch = previous; simklTransport.resetForTests(); }
}

test('100 linked due Simkl intents gather through the worker into one POST and retain per-row telemetry', async () => {
  reset();
  const fixtures = Array.from({ length: 100 }, (_, i) => addWatch(i));
  assert.equal(listDueTrackerWriteIntents(Date.now(), 100, 'simkl').length, 0);
  assert.equal(listDueTrackerWriteIntents(Date.now(), 100, 'simkl', { includeLinked: true }).length, 100);
  await withFetch(async calls => {
    await syncPendingTrackerWriteIntents(() => {});
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/sync/history').length, 1);
    assert.equal(calls.length, 4);
    assert.equal(calls.find(call => call.path === '/sync/history').body.movies.length, 100);
  });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='settled'").get().n, 100, JSON.stringify(db.prepare('SELECT status,last_error,attempts FROM tracker_write_intents LIMIT 1').get()));
  for (const { id } of fixtures) {
    const row = db.prepare('SELECT sync_dispatch_telemetry FROM watch_history WHERE id=?').get(id);
    assert.match(row.sync_dispatch_telemetry, /Target simkl status: success/);
    for (const provider of ['plex', 'emby', 'jellyfin']) assert.match(row.sync_dispatch_telemetry, new RegExp(`Target ${provider} status: success`));
    assert.match(row.sync_dispatch_telemetry, /Dispatch status: success/);
  }
});

test('changed watch date and unwatched playstate cancel linked backlog without sending', async () => {
  for (const change of ['date', 'playstate']) {
    reset(); const fixture = addWatch(1);
    if (change === 'date') db.prepare('UPDATE watch_history SET watched_at=? WHERE id=?').run('2026-10-23T12:00:00.000Z', fixture.id);
    else data.upsertPlaystateForMediaSync({ type: 'movie', title: `Offline Backlog 1`, ids: { tmdb: 10001 }, tmdb_id: 10001 }, 'unwatched', watchedAt);
    await withFetch(async calls => { await syncPendingTrackerWriteIntents(message => console.log(message)); assert.equal(calls.length, 0); });
    assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).status, 'cancelled');
  }
});

test('uncertain Simkl sends move to review and are never blindly resent', async () => {
  reset(); const fixture = addWatch(2);
  db.prepare("UPDATE tracker_write_intents SET status='uncertain',attempts=1 WHERE id=?").run(fixture.intent.id);
  await withFetch(async calls => { await syncPendingTrackerWriteIntents(message => console.log(message)); assert.equal(calls.length, 0); });
  assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).status, 'review');
});

test('disabled Simkl connection makes zero requests for linked backlog', async () => {
  reset(); const fixture = addWatch(3);
  db.prepare("UPDATE tracker_connections SET status='disabled' WHERE provider='simkl'").run();
  await withFetch(async calls => { await syncPendingTrackerWriteIntents(message => console.log(message)); assert.equal(calls.length, 0); });
  assert.equal(db.prepare('SELECT attempts FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).attempts, 0);
});

test('a local date edit does not cancel away an uncertain remote outcome',async()=>{
  reset();const fixture=addWatch(5);
  db.prepare("UPDATE tracker_write_intents SET status='uncertain',attempts=1 WHERE id=?").run(fixture.intent.id);
  db.prepare('UPDATE watch_history SET watched_at=? WHERE id=?').run('2026-10-23T12:00:00.000Z',fixture.id);
  await withFetch(async calls=>{await syncPendingTrackerWriteIntents(()=>{});assert.equal(calls.length,0);});
  assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).status,'review');
});

test('a watch changed during preflight stops the whole claim before any POST',async()=>{
  reset();const fixture=addWatch(4);
  await withFetch(async calls=>{
    await syncPendingTrackerWriteIntents(()=>{});
    assert.equal(calls.length,1);assert.ok(calls.every(c=>c.method==='GET'));
    assert.equal(db.prepare('SELECT attempts FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).attempts,0);
  },{onPreflight:()=>db.prepare('UPDATE watch_history SET watched_at=? WHERE id=?').run('2026-10-23T12:00:00.000Z',fixture.id)});
});

test('a backlog of 101 keeps the 100-per-run bound and finishes in two confirmed chunks',async()=>{
  reset();Array.from({length:101},(_,i)=>addWatch(i));
  await withFetch(async calls=>{
    await syncPendingTrackerWriteIntents(()=>{});
    assert.equal(calls.length,4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='pending'").get().n,1);
    await syncPendingTrackerWriteIntents(()=>{});
    assert.equal(calls.length,8);
    assert.deepEqual(calls.filter(c=>c.path==='/sync/history').map(c=>c.body.movies.length),[100,1]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tracker_write_intents WHERE status='settled'").get().n,101);
  });
});

