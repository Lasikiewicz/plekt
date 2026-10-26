import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';

// Keep every dispatch-related import behind this private database setup.
makeTempDataDir('plekt-tracker-bulk-dispatch-');
const { db } = await import('../server/src/db.js');
const repo = await import('../server/src/utils/trackerConnectionRepo.js');
const { dispatchTrackerWatchBatch } = await import('../server/src/utils/trackerBulkDispatch.js');
const { dispatchTrackerWatchState } = await import('../server/src/utils/trackerDispatcher.js');
const { simklTransport } = await import('../server/src/utils/trackers/simklTransport.js');

const date = '2026-10-22T12:34:56.000Z';
function reset() {
  db.prepare('DELETE FROM tracker_write_intents').run();
  db.prepare('DELETE FROM tracker_observations').run();
  db.prepare('DELETE FROM tracker_connections').run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  repo.saveTrackerConnection({ provider: 'simkl', clientId: 'offline-client', remoteUserId: 'offline-account',
    accessToken: 'fake-access', refreshToken: 'fake-refresh', accessTokenExpiresAt: Date.now() + 3_600_000 });
  simklTransport.resetForTests();
}
function movies(count) {
  return Array.from({ length: count }, (_, i) => ({ type: 'movie', source: 'manual', title: `Offline Movie ${i}`,
    ids: { tmdb: i + 1000 }, watched_at: new Date(Date.parse(date) + i * 1000).toISOString(), syncTargets: ['simkl'] }));
}
async function mockSimkl(work, { omitReadback = -1 } = {}) {
  const previous = globalThis.fetch;
  const requests = [];
  simklTransport.resetForTests();
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.simkl.com');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, path: parsed.pathname, body, url: parsed });
    let payload;
    if (parsed.pathname === '/sync/history' && method === 'POST') {
      const payloadMovies = body.movies || [];
      payload = { added: { movies: payloadMovies.length, episodes: 0 }, not_found: {} };
    } else if (parsed.pathname === '/sync/activities') {
      payload = { all: '2026-10-22T13:00:00.000Z' };
    } else {
      assert.equal(parsed.pathname, '/sync/watched');
      const posted = requests.filter(r => r.path === '/sync/history').flatMap(r => r.body.movies || []);
      payload = body.map(({ ids }) => {
        const i = posted.findIndex(item => String(item.ids.tmdb) === String(ids.tmdb));
        return i === omitReadback ? { ids, result: false } : { ids, result: true, list: 'completed', last_watched_at: posted[i].watched_at };
      });
    }
    return Response.json(payload, { headers: { 'x-ratelimit-remaining': '400', 'x-ratelimit-limit': '500' } });
  };
  try { return await work(requests); }
  finally { globalThis.fetch = previous; simklTransport.resetForTests(); }
}

test('100 unique movies gather into one confirmed Simkl POST and four total requests', async () => {
  reset();
  await mockSimkl(async requests => {
    const { results } = await dispatchTrackerWatchBatch(movies(100), 'watched');
    assert.equal(requests.filter(r => r.path === '/sync/history' && r.method === 'POST').length, 1);
    assert.equal(requests.length, 4);
    assert.equal(requests.filter(r => r.path === '/sync/watched')[0].body.length, 100);
    const sent = requests.find(r => r.path === '/sync/history').body.movies;
    assert.equal(sent.length, 100);
    assert.deepEqual(sent.map(m => m.watched_at), movies(100).map(m => m.watched_at));
    assert.ok(results.every(row => row.targetStates.length === 1 && row.targetStates[0].status === 'success'));
  });
});

test('101 unique movies form 100 and 1 chunks with eight requests and exact confirmed dates', async () => {
  reset();
  await mockSimkl(async requests => {
    const items = movies(101);
    const { results } = await dispatchTrackerWatchBatch(items, 'watched');
    const posts = requests.filter(r => r.path === '/sync/history' && r.method === 'POST');
    assert.deepEqual(posts.map(r => r.body.movies.length), [100, 1]);
    assert.equal(requests.length, 8);
    assert.deepEqual(posts.flatMap(r => r.body.movies.map(m => m.watched_at)), items.map(m => m.watched_at));
    assert.ok(results.every(row => row.targetStates.length === 1 && row.targetStates[0].status === 'success'));
  });
});

test('disabled Simkl connection makes no requests and exposes no success state', async () => {
  reset();
  db.prepare("UPDATE tracker_connections SET status='disabled' WHERE provider='simkl'").run();
  const results = await mockSimkl(async requests => (await dispatchTrackerWatchBatch(movies(2), 'watched')).results);
  assert.equal(results.length, 2);
  assert.equal(results.flatMap(row => row.targetStates).length, 0);
});

test('ordinary one-item dispatch queues into the Simkl coalesce window without networking', async () => {
  reset();
  await mockSimkl(async requests => {
    const outcome = await Promise.race([
      dispatchTrackerWatchState(movies(1)[0], 'watched'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('single dispatch timed out')), 2000)),
    ]);
    assert.equal(outcome[0].status, 'pending');
    assert.equal(requests.length, 0);
    assert.ok(db.prepare("SELECT due_at FROM tracker_write_intents WHERE provider='simkl'").get().due_at > Date.now());
  });
});

test('an item missing readback confirmation is failed while confirmed siblings succeed', async () => {
  reset();
  await mockSimkl(async requests => {
    const { results } = await dispatchTrackerWatchBatch(movies(3), 'watched');
    assert.equal(requests.filter(r => r.path === '/sync/history').length, 1);
    assert.deepEqual(results.map(row => row.targetStates[0]?.status), ['success', 'success', 'failed']);
  }, { omitReadback: 2 });
});
