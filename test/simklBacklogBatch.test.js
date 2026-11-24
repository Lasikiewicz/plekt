import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';

// Database-backed imports must follow private DATA_DIR setup.
makeTempDataDir('plekt-simkl-backlog-');
const { db } = await import('../server/src/db.js');
const repo = await import('../server/src/utils/trackerConnectionRepo.js');
const data = await import('../server/src/utils/dataRepo.js');
const { listDueTrackerWriteIntents, cancelTrackerWriteIntent } = await import('../server/src/utils/trackerWriteIntents.js');
const { appendSyncHistory } = await import('../server/src/utils/configStore.js');
const { syncPendingTrackerWriteIntents } = await import('../server/src/utils/trackerIntentWorker.js');
const { simklTransport } = await import('../server/src/utils/trackers/simklTransport.js');
const { recheckHeldSimklWrites } = await import('../server/src/utils/trackers/simklHeldWrites.js');

const watchedAt = '2026-10-22T12:34:56.000Z';
function reset() {
  for (const table of ['tracker_write_intents', 'tracker_observations', 'tracker_connections', 'watch_history', 'playstate', 'sync_history']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  repo.saveTrackerConnection({ provider: 'simkl', clientId: 'offline-client', remoteUserId: 'offline-account',
    accessToken: 'fake-access', refreshToken: 'fake-refresh', accessTokenExpiresAt: Date.now() + 3_600_000 });
  simklTransport.resetForTests();
}
function addWatch(i, source = 'manual') {
  const media = { type: 'movie', title: `Offline Backlog ${i}`, ids: { tmdb: i + 10000 }, tmdb_id: i + 10000,
    watched_at: watchedAt, source, sync_action: 'watched', sync_dispatch_telemetry: 'Target plex status: success\nTarget emby status: success\nTarget jellyfin status: success\nTarget simkl status: pending\nDispatch status: pending' };
  const inserted = data.insertWatchRecordSync(media);
  const intent = db.prepare('SELECT * FROM tracker_write_intents WHERE watch_record_id=? AND provider=?').get(inserted.id, 'simkl');
  assert.ok(intent, 'watch insert should capture the connected Simkl destination');
  // Worker tests cover intents that are already due after the coalesce window.
  db.prepare('UPDATE tracker_write_intents SET due_at=? WHERE id=?').run(Date.now(), intent.id);
  return { id: inserted.id, intent: db.prepare('SELECT * FROM tracker_write_intents WHERE id=?').get(intent.id) };
}
async function withFetch(work, { failPost = false, onPreflight, recheckDates = {} } = {}) {
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
      last_watched_at: sent.find(item => item.ids.tmdb === ids.tmdb)?.watched_at ?? recheckDates[ids.tmdb] })), { headers: { 'x-ratelimit-remaining': '400' } });
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

test('a queued Plex watch with no verified monitored library never reaches Simkl', async () => {
  reset();
  const fixture = addWatch(103, 'plex');
  await withFetch(async (calls) => {
    await syncPendingTrackerWriteIntents(() => {});
    assert.deepEqual(calls, []);
  });
  assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).status, 'pending');
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

test('an alternate-order policy skip closes the intent and a later pass writes nothing', async () => {
  const { getDataVersion } = await import('../server/src/db.js');
  reset(); const fixture = addWatch(3);
  const media = JSON.parse(fixture.intent.media_json);
  db.prepare('UPDATE tracker_write_intents SET media_json=? WHERE id=?')
    .run(JSON.stringify({ ...media, watch_provenance: { ...(media.watch_provenance || {}), episode_order: 'dvd' } }), fixture.intent.id);
  await withFetch(async calls => { await syncPendingTrackerWriteIntents(() => {}); assert.equal(calls.length, 0); });
  const intent = db.prepare('SELECT status,last_error FROM tracker_write_intents WHERE id=?').get(fixture.intent.id);
  assert.equal(intent.status, 'cancelled');
  assert.match(intent.last_error, /alternate episode orders/);
  assert.match(db.prepare('SELECT sync_dispatch_telemetry t FROM watch_history WHERE id=?').get(fixture.id).t, /Target simkl status: skipped/);
  // The closed intent is not due again, so a second pass changes no row and
  // leaves the data version (and every history cache) alone.
  const version = getDataVersion();
  await withFetch(async calls => { await syncPendingTrackerWriteIntents(() => {}); assert.equal(calls.length, 0); });
  assert.equal(getDataVersion(), version);
});

test('uncertain Simkl sends move to review and are never blindly resent', async () => {
  reset(); const fixture = addWatch(2);
  db.prepare("UPDATE tracker_write_intents SET status='uncertain',attempts=1 WHERE id=?").run(fixture.intent.id);
  await withFetch(async calls => { await syncPendingTrackerWriteIntents(message => console.log(message)); assert.equal(calls.length, 0); });
  assert.equal(db.prepare('SELECT status FROM tracker_write_intents WHERE id=?').get(fixture.intent.id).status, 'review');
});

test('the worker rechecks held Simkl writes in one read and settles only matching dates', async () => {
  reset();
  const [matching, different, unsent] = [2, 3, 4].map((index) => addWatch(index));
  const hold = db.prepare("UPDATE tracker_write_intents SET status='review',attempts=1,last_error=? WHERE id=?");
  hold.run("Interrupted send", matching.intent.id);
  hold.run("Interrupted send", different.intent.id);
  hold.run("Not sent: invalid identity", unsent.intent.id);
  const status = (fixture) => db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(fixture.intent.id).status;

  await withFetch(async (calls) => {
    assert.equal(await syncPendingTrackerWriteIntents(() => {}), 1);
    assert.deepEqual(calls.map((call) => call.path), ["/sync/watched"]);
    assert.deepEqual(calls[0].body.map(({ ids }) => ids.tmdb).sort(), ["10002", "10003"]);
    assert.equal(status(matching), "settled");
    assert.equal(status(different), "review");
    assert.equal(status(unsent), "review");
    assert.match(db.prepare("SELECT sync_dispatch_telemetry FROM watch_history WHERE id=?").get(matching.id).sync_dispatch_telemetry, /Watch date confirmed on Simkl/);
    await syncPendingTrackerWriteIntents(() => {});
    assert.equal(calls.length, 1, "inconclusive writes wait before the next read");
  }, { recheckDates: { 10002: watchedAt, 10003: "2026-10-22T12:35:56.000Z" } });
  await withFetch(async (calls) => {
    const result = await recheckHeldSimklWrites(() => {}, { ids: [different.intent.id] });
    assert.equal(result.completed, 1);
    assert.deepEqual(calls.map((call) => call.path), ["/sync/watched"]);
    assert.equal(status(different), "settled");
  }, { recheckDates: { 10003: watchedAt } });
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

test('queued Simkl outcomes update sync_history target_states on settle, review hold, recheck, and cancel', async () => {
  reset();
  const settledFixture = addWatch(201);
  const heldFixture = addWatch(202);
  const cancelFixture = addWatch(203);
  const seedActivity = async (index) => appendSyncHistory({
    mediaType: 'movie',
    title: `Offline Backlog ${index}`,
    source: 'plex',
    status: 'success',
    details: 'Successfully synced to Emby, Jellyfin & Trakt',
    action: 'watched',
    targetStates: [
      { target: 'emby', status: 'success', detail: '200 OK' },
      { target: 'jellyfin', status: 'success', detail: '200 OK' },
      { target: 'simkl', status: 'pending', detail: 'Queued for the next Simkl batch send' },
      { target: 'trakt', status: 'success', detail: 'Marked watched on Trakt' },
    ],
  });
  await seedActivity(201);
  await seedActivity(202);
  await seedActivity(203);

  const activityFor = (index) => {
    const row = db.prepare('SELECT status, details, target_states FROM sync_history WHERE title = ? ORDER BY id DESC LIMIT 1').get(`Offline Backlog ${index}`);
    return { ...row, targetStates: JSON.parse(row.target_states) };
  };

  // 201 confirms immediately; 202 and 203 are unconfirmed on readback and held for review.
  const previous = globalThis.fetch;
  simklTransport.resetForTests();
  let posted = false;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (parsed.pathname === '/sync/history' && init.method === 'POST') {
      posted = true;
      return Response.json({ added: { movies: 1, episodes: 0 }, not_found: {} }, { headers: { 'x-ratelimit-remaining': '400' } });
    }
    if (parsed.pathname === '/sync/activities') {
      return Response.json({ all: posted ? '2026-10-22T13:00:00.000Z' : '2026-10-22T12:00:00.000Z' }, { headers: { 'x-ratelimit-remaining': '400' } });
    }
    return Response.json(body.map(({ ids }) => ({
      ids,
      result: ids.tmdb === '10201',
      list: ids.tmdb === '10201' ? 'completed' : null,
      last_watched_at: ids.tmdb === '10201' ? watchedAt : null,
    })), { headers: { 'x-ratelimit-remaining': '400' } });
  };
  try {
    await syncPendingTrackerWriteIntents(() => {});
  } finally {
    globalThis.fetch = previous;
    simklTransport.resetForTests();
  }

  const settledRow = activityFor(201);
  assert.equal(settledRow.status, 'success');
  assert.equal(settledRow.targetStates.find((t) => t.target === 'simkl')?.status, 'success');
  assert.match(settledRow.details, /Simkl/);

  const heldRow = activityFor(202);
  assert.equal(heldRow.status, 'partial');
  assert.equal(heldRow.targetStates.find((t) => t.target === 'simkl')?.status, 'error');
  assert.match(heldRow.details, /failed Simkl/);

  // Recheck confirms 202 and flips its Sync Activity row from error -> success.
  await withFetch(async () => {
    const result = await recheckHeldSimklWrites(() => {}, { ids: [heldFixture.intent.id] });
    assert.equal(result.completed, 1);
  }, { recheckDates: { 10202: watchedAt } });
  const recheckedRow = activityFor(202);
  assert.equal(recheckedRow.status, 'success');
  assert.equal(recheckedRow.targetStates.find((t) => t.target === 'simkl')?.status, 'success');

  // Cancelling held write 203 clears the Simkl error pill to skipped.
  assert.equal(cancelTrackerWriteIntent(cancelFixture.intent.id), true);
  const cancelledRow = activityFor(203);
  assert.equal(cancelledRow.status, 'partial');
  assert.equal(cancelledRow.targetStates.find((t) => t.target === 'simkl')?.status, 'skipped');
  assert.match(cancelledRow.details, /Simkl cancelled/);

  // A superseded queued write cancelled by simklBacklogIntentCurrent also clears
  // its Sync Activity pending pill so no row stays stuck on "Simkl: pending".
  const supersededFixture = addWatch(204);
  await seedActivity(204);
  db.prepare('UPDATE watch_history SET watched_at = ? WHERE id = ?').run('2026-10-25T12:00:00.000Z', supersededFixture.id);
  await withFetch(async (calls) => {
    await syncPendingTrackerWriteIntents(() => {});
    assert.equal(calls.length, 0);
  });
  const supersededRow = activityFor(204);
  assert.equal(supersededRow.targetStates.find((t) => t.target === 'simkl')?.status, 'skipped');
  assert.match(supersededRow.targetStates.find((t) => t.target === 'simkl')?.detail || '', /Local watch changed/);
});

