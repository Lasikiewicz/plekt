import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.js';

makeTempDataDir('plekt-simkl-full-sync-');
const { db } = await import('../server/src/db.js');
const store = await import('../server/src/utils/trackers/simklFullSyncStore.js');

const connection = (id = 'connection-a', accountId = 'account-a') => ({
  id, remoteUserId: accountId, accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token',
});
const row = (id = 'selected-a') => ({ id, media: { type: 'movie', title: 'Selected movie', ids: { tmdb: '123' } }, watchedAt: '2026-10-01T12:00:00Z',
  headers: { Authorization: 'Bearer row-secret' } });
const create = (options = {}) => store.createSimklFullSyncRun({
  connection: connection(), rows: [row()], policy: { mode: 'selected', confirmed: true }, ...options,
});
const reset = () => {
  db.prepare('DELETE FROM simkl_full_sync_items').run();
  db.prepare('DELETE FROM simkl_full_sync_runs').run();
};
test.beforeEach(reset);

test('requires explicit policy and prevents duplicate active approval for one connection/account', () => {
  assert.throws(() => store.createSimklFullSyncRun({ connection: connection(), rows: [row()] }), /explicit.*policy/i);
  const first = create();
  assert.equal(first.items[0].row.id, 'selected-a');
  assert.equal(first.items[0].row.watchedAt, '2026-10-01T12:00:00Z');
  assert.throws(() => create(), error => error.code === 'SIMKL_FULL_SYNC_ALREADY_ACTIVE' && error.status === 409);
  assert.equal(store.latestSimklFullSyncRun('connection-a').id, first.id);
});

test('queued and quota-paused runs appear when due and disappear before the next reset', () => {
  const run = create();
  assert.deepEqual(store.dueSimklFullSyncRuns(run.createdAt), [run.id]);
  const claimed = store.claimSimklFullSyncRun(run.id, 'worker-a', { now: run.createdAt, leaseMs: 60_000 });
  const now = Date.now;
  Date.now = () => run.createdAt;
  try {
    const paused = store.updateSimklFullSyncRun(run.id, 'worker-a', { status: 'waiting_quota', nextRunAt: run.createdAt + 86_400_000 });
    assert.equal(paused.status, 'waiting_quota');
    assert.deepEqual(store.dueSimklFullSyncRuns(run.createdAt + 86_399_999), []);
    assert.deepEqual(store.dueSimklFullSyncRuns(run.createdAt + 86_400_000), [run.id]);
  } finally { Date.now = now; }
  assert.equal(claimed.status, 'running');
});

test('claims are exclusive, heartbeat cannot resurrect an expired lease, and stale claims fence the old owner', () => {
  const run = create();
  const start = run.createdAt;
  assert.equal(store.claimSimklFullSyncRun(run.id, 'worker-a', { now: start, leaseMs: 1000 }).leaseOwner, 'worker-a');
  assert.equal(store.claimSimklFullSyncRun(run.id, 'worker-b', { now: start + 999 }), null);
  const realNow = Date.now;
  Date.now = () => start + 1000;
  try {
    assert.equal(store.heartbeatSimklFullSyncRun(run.id, 'worker-a', 1000), null);
    const next = store.claimSimklFullSyncRun(run.id, 'worker-b', { now: start + 1000, leaseMs: 1000 });
    assert.equal(next.leaseOwner, 'worker-b');
    assert.equal(store.updateSimklFullSyncRun(run.id, 'worker-a', { status: 'completed' }), null);
    assert.equal(store.updateSimklFullSyncItems(run.id, 'worker-a', [{ itemId: 'selected-a', status: 'completed' }]), null);
  } finally { Date.now = realNow; }
});

test('recovery turns interrupted sending into review and leaves unsent items eligible without replay', () => {
  const run = create({ rows: [row('sent'), row('pending')] });
  const start = run.createdAt;
  store.claimSimklFullSyncRun(run.id, 'worker-a', { now: start, leaseMs: 1000 });
  const realNow = Date.now;
  Date.now = () => start;
  try { store.updateSimklFullSyncItems(run.id, 'worker-a', [{ itemId: 'sent', status: 'sending' }]); }
  finally { Date.now = realNow; }
  const recovered = store.claimSimklFullSyncRun(run.id, 'worker-b', { now: start + 1000, leaseMs: 1000 });
  assert.equal(recovered.items.find(item => item.itemId === 'sent').status, 'review');
  assert.match(recovered.items.find(item => item.itemId === 'sent').detail.reason, /outcome is uncertain/i);
  assert.equal(recovered.items.find(item => item.itemId === 'pending').status, 'pending');
  assert.deepEqual(recovered.counts, { completed: 0, remaining: 1, review: 1 });
});

test('item outcomes are validated and completed or review items cannot return to pending', () => {
  const run = create({ rows: [row('done'), row('held')] });
  const start = run.createdAt;
  store.claimSimklFullSyncRun(run.id, 'worker', { now: start, leaseMs: 60_000 });
  const realNow = Date.now;
  Date.now = () => start;
  try {
    store.updateSimklFullSyncItems(run.id, 'worker', [
      { itemId: 'done', status: 'completed' }, { itemId: 'held', status: 'review', detail: { reason: 'Needs a decision' } },
    ]);
    assert.throws(() => store.updateSimklFullSyncItems(run.id, 'worker', [{ itemId: 'done', status: 'pending' }]), error => error.code === 'SIMKL_ITEM_OUTCOME_FINAL');
    assert.throws(() => store.updateSimklFullSyncItems(run.id, 'worker', [{ itemId: 'held', status: 'pending' }]), error => error.code === 'SIMKL_ITEM_OUTCOME_FINAL');
    assert.throws(() => store.updateSimklFullSyncItems(run.id, 'worker', [{ itemId: 'done', status: 'bogus' }]), /Invalid/);
    assert.deepEqual(store.getSimklFullSyncRun(run.id).counts, { completed: 1, remaining: 0, review: 1 });
  } finally { Date.now = realNow; }
});

test('run state patches persist fields without replacing ids or selected rows', () => {
  const run = create({ initialJobId: 'initial-job', backup: { id: 'backup-a' } });
  const start = run.createdAt;
  store.claimSimklFullSyncRun(run.id, 'worker', { now: start, leaseMs: 60_000 });
  const realNow = Date.now;
  Date.now = () => start;
  try {
    const updated = store.updateSimklFullSyncRun(run.id, 'worker', { state: { cursor: 2, imported: 1 } });
    assert.equal(updated.state.initialJobId, 'initial-job');
    assert.equal(updated.state.cursor, 2);
    assert.throws(() => store.updateSimklFullSyncRun(run.id, 'worker', { state: { accountId: 'other-account' } }), /cannot replace/i);
    assert.throws(() => store.updateSimklFullSyncRun(run.id, 'worker', { state: { rows: [] } }), /cannot replace/i);
    assert.equal(store.getSimklFullSyncRun(run.id).accountId, 'account-a');
    assert.equal(store.getSimklFullSyncRun(run.id).items[0].row.id, 'selected-a');
  } finally { Date.now = realNow; }
});

test('cancellation releases the lease, cancels pending items, and holds sending items for review', () => {
  const run = create({ rows: [row('sending'), row('waiting')] });
  const start = run.createdAt;
  store.claimSimklFullSyncRun(run.id, 'worker', { now: start, leaseMs: 60_000 });
  const realNow = Date.now;
  Date.now = () => start;
  try { store.updateSimklFullSyncItems(run.id, 'worker', [{ itemId: 'sending', status: 'sending' }]); }
  finally { Date.now = realNow; }
  const cancelled = store.cancelSimklFullSyncRun(run.id, 'User cancelled');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.leaseOwner, null);
  assert.equal(cancelled.items.find(item => item.itemId === 'sending').status, 'review');
  assert.equal(cancelled.items.find(item => item.itemId === 'waiting').status, 'cancelled');
  assert.deepEqual(store.dueSimklFullSyncRuns(Date.now() + 1000), []);
});

test('persisted run and selected item payloads contain no credential or header fields', () => {
  const run = create();
  const columns = db.pragma('table_info(simkl_full_sync_runs)').map(column => column.name);
  assert.equal(columns.some(name => /token|secret|header/i.test(name)), false);
  const storedRun = db.prepare('SELECT state_json FROM simkl_full_sync_runs WHERE id=?').get(run.id).state_json;
  const storedItem = db.prepare('SELECT row_json FROM simkl_full_sync_items WHERE run_id=?').get(run.id).row_json;
  assert.doesNotMatch(storedRun + storedItem, /secret-access-token|secret-refresh-token|row-secret|Authorization/i);
});
