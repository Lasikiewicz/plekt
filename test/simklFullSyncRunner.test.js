import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';

// Offline only. "Next day" below is a simulated reset (fresh fake quota and a
// past next_run_at), not evidence of several real days passing.
makeTempDataDir('plekt-simkl-full-sync-runner-');
process.env.PLEKT_DISABLE_METADATA_PREFETCH = '1';
const { db } = await import('../server/src/db.js');
const repo = await import('../server/src/utils/trackerConnectionRepo.js');
const { saveMediaConfig, setRuntimeState, clearRestoreSyncState } = await import('../server/src/utils/configStore.js');
const { simklTransport } = await import('../server/src/utils/trackers/simklTransport.js');
const { simklRequest } = await import('../server/src/utils/trackers/simklClient.js');
const { freshSimklConnection } = await import('../server/src/utils/trackers/simklConnection.js');
const { localWatchedItems } = await import('../server/src/utils/trackers/fullSync.js');
const { buildTrackerFullSyncItems } = await import('../server/src/utils/trackers/fullSyncPlans.js');
const { SIMKL_FULL_SYNC_NORMAL_POLICY } = await import('../server/src/utils/trackers/simklFullSyncPolicy.js');
const store = await import('../server/src/utils/trackers/simklFullSyncStore.js');
const { kickSimklFullSyncRuns, cancelSimklFullSync } = await import('../server/src/utils/trackers/simklFullSyncRunner.js');
const { createTrackerWriteIntent, listDueTrackerWriteIntents } = await import('../server/src/utils/trackerWriteIntents.js');
const { syncPendingTrackerWriteIntents } = await import('../server/src/utils/trackerIntentWorker.js');
const { saveInitialSync, recoverInitialSync, readInitialSync, finalizeInitialSync } = await import('../server/src/utils/initialSyncStore.js');

const watchedAt = '2020-01-01T00:00:00.000Z';
let server;
function reset({ remaining = 500, limit = 500 } = {}) {
  for (const table of ['simkl_full_sync_items', 'simkl_full_sync_runs', 'tracker_write_intents', 'tracker_observations', 'tracker_connections', 'watch_history', 'playstate', 'initial_sync_items'])
    db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%' OR id='initial-outward-sync'").run();
  repo.saveTrackerConnection({ provider: 'simkl', clientId: 'offline-client', remoteUserId: 'offline-account',
    accessToken: 'fake-access', refreshToken: 'fake-refresh', accessTokenExpiresAt: Date.now() + 3_600_000, baselineComplete: true });
  simklTransport.resetForTests();
  server = { remaining, limit, watched: new Map(), calls: [] };
}
function addLocal(count, from = 1) {
  for (let i = from; i < from + count; i++) db.prepare(`INSERT INTO watch_history(id,title,media_type,watched_at,source,tmdb_id,sync_action,media_key,created_at,updated_at)
    VALUES(?,?,'movie',?,'plex',?,'watched',?,?,?)`).run(`local-${i}`, `Offline ${i}`, watchedAt, String(i), `movie:tmdb:${i}`, Date.now(), Date.now());
}
function createRun(extra = {}) {
  const rows = buildTrackerFullSyncItems('simkl', localWatchedItems(), [], { syncEnabled: true }).filter(row => row.side === 'tracker' && row.selectable);
  return store.createSimklFullSyncRun({ connection: repo.getTrackerConnection('simkl'), rows, policy: SIMKL_FULL_SYNC_NORMAL_POLICY, ...extra });
}
const headers = () => ({ 'x-ratelimit-limit': String(server.limit), 'x-ratelimit-remaining': String(server.remaining) });
async function withFakeSimkl(work) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.simkl.com', 'offline test must not call another service');
    const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    server.calls.push({ method, path: parsed.pathname, body });
    server.remaining--;
    if (parsed.pathname === '/sync/history' && method === 'POST') {
      for (const movie of body.movies) server.watched.set(String(movie.ids.tmdb), movie.watched_at);
      return Response.json({ added: { movies: body.movies.length, episodes: 0 }, not_found: {} }, { headers: headers() });
    }
    if (parsed.pathname === '/sync/activities') return Response.json({ all: new Date(Date.now() - 1000 + server.calls.length).toISOString() }, { headers: headers() });
    assert.equal(parsed.pathname, '/sync/watched');
    return Response.json(body.map(({ ids }) => ({ ids, result: server.watched.has(String(ids.tmdb)), list: 'completed',
      last_watched_at: server.watched.get(String(ids.tmdb)) })), { headers: headers() });
  };
  try { return await work(); } finally { globalThis.fetch = previous; }
}
// One real request observes quota headers; the library comes from the fake server.
const readSnapshot = async () => {
  await simklRequest(await freshSimklConnection(), '/sync/activities', {});
  return { complete: true, review: [], watched: [...server.watched].map(([tmdb, date]) => ({ media: { type: 'movie', ids: { tmdb: Number(tmdb) } }, watchedAt: Date.parse(date) })) };
};
const kick = () => kickSimklFullSyncRuns({ readSnapshot });
// Watched-history writes only; the /sync/watched readback is also a POST.
const posts = () => server.calls.filter(call => call.method === 'POST' && call.path === '/sync/history');
const itemStatuses = id => Object.fromEntries(store.getSimklFullSyncRun(id).items.map(item => [item.row.media.title, item.status]));

test.before(async () => { await saveMediaConfig({ plex: { disabled: true }, emby: { disabled: true }, jellyfin: { disabled: true } }); });

test('a paced run sends one chunk per partial day, waits without polling, then finishes after a simulated reset', async () => {
  reset({ remaining: 161 }); addLocal(250);
  const run = createRun();
  await withFakeSimkl(async () => {
    await kick();
    // 161 - 1 verification = 160; protected 100 + 55 leaves one 4-request batch.
    let state = store.getSimklFullSyncRun(run.id, { items: false });
    assert.equal(state.status, 'waiting_quota');
    assert.equal(state.counts.completed, 100);
    assert.equal(state.counts.remaining, 150);
    assert.equal(posts().length, 1);
    assert.ok(server.remaining >= 155, `normal-use + safety reserve kept, ${server.remaining} left`);
    assert.ok(state.nextRunAt > Date.now() + 60_000, 'resume is scheduled for the next reset');
    const fullSync = repo.getTrackerConnection('simkl').fullSync;
    assert.equal(fullSync.status, 'waiting_quota'); assert.equal(fullSync.runId, run.id); assert.equal(fullSync.sent, 100);
    const before = server.calls.length;
    await kick();
    assert.equal(server.calls.length, before, 'no quota probe before the reset');
    // Simulated reset: fresh allowance and the run is now due.
    server.remaining = 500; simklTransport.resetForTests();
    db.prepare('UPDATE simkl_full_sync_runs SET next_run_at=? WHERE id=?').run(Date.now() - 1, run.id);
    await kick();
    state = store.getSimklFullSyncRun(run.id, { items: false });
    assert.equal(state.status, 'completed');
    assert.equal(state.counts.completed, 250);
    assert.deepEqual(posts().map(call => call.body.movies.length), [100, 100, 50]);
    assert.equal(new Set(posts().flatMap(call => call.body.movies.map(movie => movie.ids.tmdb))).size, 250, 'no item is sent twice');
    assert.equal(repo.getTrackerConnection('simkl').fullSync.status, 'completed');
  });
});

test('unknown allowance waits honestly instead of assuming 500', async () => {
  reset(); addLocal(2);
  const run = createRun();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ all: new Date().toISOString() }, { headers: { 'x-ratelimit-remaining': '400' } });
  try { await kick(); } finally { globalThis.fetch = previous; }
  const state = store.getSimklFullSyncRun(run.id, { items: false });
  assert.equal(state.status, 'waiting_quota');
  assert.equal(state.counts.remaining, 2);
  assert.match(state.state.waitReason, /did not report its daily allowance/);
});

test('remaining items are revalidated: unwatched cancels, date edit reviews, already on Simkl completes, none are sent', async () => {
  reset(); addLocal(3);
  const run = createRun();
  db.prepare("UPDATE watch_history SET sync_action='unwatched' WHERE id='local-1'").run();
  db.prepare("UPDATE watch_history SET watched_at='2021-05-05T00:00:00.000Z' WHERE id='local-2'").run();
  server.watched.set('3', watchedAt);
  await withFakeSimkl(async () => { await kick(); });
  assert.deepEqual(itemStatuses(run.id), { 'Offline 1': 'cancelled', 'Offline 2': 'review', 'Offline 3': 'completed' });
  assert.equal(posts().length, 0);
  assert.equal(store.getSimklFullSyncRun(run.id, { items: false }).status, 'completed');
  assert.equal(repo.getTrackerConnection('simkl').fullSync.status, 'partial');
});

test('a crash during a send holds that item for review and never replays it; the rest continue', async () => {
  reset(); addLocal(3);
  const run = createRun();
  const [crashed] = run.items;
  store.claimSimklFullSyncRun(run.id, 'dead-worker', { leaseMs: 60_000 });
  store.updateSimklFullSyncItems(run.id, 'dead-worker', [{ itemId: crashed.itemId, status: 'sending' }]);
  db.prepare('UPDATE simkl_full_sync_runs SET lease_until=? WHERE id=?').run(Date.now() - 1, run.id);
  await withFakeSimkl(async () => { await kick(); });
  const statuses = itemStatuses(run.id);
  assert.equal(statuses[crashed.row.media.title], 'review');
  assert.equal(Object.values(statuses).filter(status => status === 'completed').length, 2);
  assert.equal(posts().length, 1, JSON.stringify(server.calls.map(call => `${call.method} ${call.path} ${call.body?.movies?.length ?? ''}`)));
  assert.ok(!posts()[0].body.movies.some(movie => movie.ids.tmdb === crashed.row.media.ids.tmdb), 'uncertain item not resent');
});

test('the ordinary intent worker cannot send a paced intent outside its run', async () => {
  reset(); addLocal(1);
  const run = createRun();
  const media = { ...localWatchedItems()[0], simklFullSyncRunId: run.id };
  createTrackerWriteIntent({ provider: 'simkl', connection: repo.getTrackerConnection('simkl'), media, action: 'watched',
    logicalKey: `simkl-full-sync:${run.id}:${run.items[0].itemId}`, dueAt: Date.now() - 1 });
  assert.equal(listDueTrackerWriteIntents(Date.now(), 100, 'simkl', { includeLinked: true }).length, 0);
  await withFakeSimkl(async () => { await syncPendingTrackerWriteIntents(() => {}); });
  assert.equal(server.calls.length, 0);
});

test('an account change cancels the run and a user cancel stops further sends, both without requests', async () => {
  reset(); addLocal(2);
  const first = createRun();
  db.prepare("UPDATE tracker_connections SET remote_user_id='other-account' WHERE provider='simkl'").run();
  await withFakeSimkl(async () => { await kick(); });
  assert.equal(store.getSimklFullSyncRun(first.id, { items: false }).status, 'cancelled');
  assert.equal(server.calls.length, 0);

  reset(); addLocal(2);
  const second = createRun();
  const fullSync = cancelSimklFullSync(second.id);
  assert.equal(store.getSimklFullSyncRun(second.id, { items: false }).status, 'cancelled');
  assert.deepEqual(Object.values(itemStatuses(second.id)), ['cancelled', 'cancelled']);
  assert.equal(fullSync.status, 'cancelled');
  await withFakeSimkl(async () => { await kick(); });
  assert.equal(server.calls.length, 0);
  assert.throws(() => cancelSimklFullSync(second.id), { code: 'FULL_SYNC_NOT_RUNNING' });
});

test('restart recovery keeps a paced initial-sync destination running and interrupts the in-process ones', () => {
  reset();
  saveInitialSync({ id: 'job-1', status: 'running', startedAt: Date.now(), completedAt: null, error: '', destinations: [
    { provider: 'simkl', label: 'Simkl', status: 'waiting_quota', pacedRunId: 'run-1', items: [{ id: 'a', title: 'A', status: 'pending' }] },
    { provider: 'emby', label: 'Emby', status: 'running', items: [{ id: 'b', title: 'B', status: 'sending' }] },
  ] });
  recoverInitialSync();
  const job = readInitialSync();
  assert.equal(job.status, 'running');
  assert.equal(job.destinations[0].status, 'waiting_quota');
  assert.equal(job.destinations[1].status, 'interrupted');
  assert.equal(job.destinations[1].items[0].status, 'review');
});

test('a cancelled paced destination settles the initial job with a cancellation message, not a review prompt', () => {
  reset();
  saveInitialSync({ id: 'job-2', status: 'waiting_quota', startedAt: Date.now(), completedAt: null, error: '', destinations: [
    { provider: 'simkl', label: 'Simkl', status: 'cancelled', pacedRunId: 'run-2', items: [{ id: 'a', title: 'A', status: 'cancelled' }] },
    { provider: 'emby', label: 'Emby', status: 'completed', items: [{ id: 'b', title: 'B', status: 'completed' }] },
  ] });
  finalizeInitialSync('job-2');
  const job = readInitialSync();
  assert.equal(job.status, 'partial');
  assert.match(job.error, /Sending to Simkl was cancelled/);
  assert.doesNotMatch(job.error, /need review/);
});

test('an active restore pauses a due run without any Simkl request; it resumes after the restore ends', async () => {
  reset(); addLocal(2);
  const run = createRun();
  const now = Date.now();
  await setRuntimeState({ restoreSyncActive: true, restoreSyncKind: 'backup_restore', restoreSyncRunId: 'restore-test',
    restoreSyncStartedAt: now, restoreSyncHeartbeat: now, syncOperation: { kind: 'backup_restore', ownerId: 'restore-test', startedAt: now, heartbeat: now } });
  try {
    await withFakeSimkl(async () => { await kick(); });
    assert.equal(server.calls.length, 0, 'no quota probe or send while a restore runs');
    const paused = store.getSimklFullSyncRun(run.id);
    assert.equal(paused.status, 'queued');
    assert.ok(paused.nextRunAt >= now + 14 * 60_000, 'paused for the restore window');
    assert.match(paused.state.waitReason, /restore/);
    assert.deepEqual(Object.values(itemStatuses(run.id)), ['pending', 'pending']);
  } finally {
    await clearRestoreSyncState({ reason: 'test end' });
  }
  db.prepare('UPDATE simkl_full_sync_runs SET next_run_at=? WHERE id=?').run(Date.now() - 1, run.id);
  await withFakeSimkl(async () => { await kick(); });
  assert.equal(posts().length, 1);
  assert.deepEqual(Object.values(itemStatuses(run.id)), ['completed', 'completed']);
});
