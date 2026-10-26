import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { isAuthoritativeRestoreActive } from '../configStore.js';
import { watchedPlayedSyncEnabled } from '../syncFlags.js';
import { getTrackerConnection, updateTrackerConnectionStatus } from '../trackerConnectionRepo.js';
import { createTrackerWriteIntent } from '../trackerWriteIntents.js';
import { dispatchTrackerWatchBatch } from '../trackerBulkDispatch.js';
import { readInitialSync, patchInitialSync, updateInitialSyncItems, finalizeInitialSync } from '../initialSyncStore.js';
import { readTrackerSnapshot } from './connections.js';
import { runInTrackerGeneration } from './generation.js';
import { trackerMediaIdentityKeys } from './traktClient.js';
import { localWatchedItems, currentWriteHolds } from './fullSync.js';
import { buildTrackerFullSyncItems } from './fullSyncPlans.js';
import { simklTransport, nextSimklDailyReset } from './simklTransport.js';
import { withSimklFullSyncContext } from './simklFullSyncContext.js';
import { estimateSimklFullSync, simklFullSyncProtectedQuota, SIMKL_FULL_SYNC_BATCH_SIZE, SIMKL_FULL_SYNC_BATCH_REQUESTS, SIMKL_FULL_SYNC_VERIFY_REQUESTS } from './simklFullSyncPolicy.js';
import * as store from './simklFullSyncStore.js';

// Durable, paced Simkl full sync (step 8c). Each slice sends only items the
// user approved, revalidated against fresh local and remote state, and stops at
// the normal-use + safety reserve. Waiting runs sleep until the daily reset; no
// quota probes are made meanwhile. Never discovers new historical work.
const OWNER = `simkl-full-sync:${process.pid}:${randomUUID()}`;
export const SIMKL_FULL_SYNC_PAUSE_MS = 15 * 60_000;
const RESET_MARGIN_MS = 2 * 60_000;
const MAX_FAILURES = 3;
const QUOTA_CODES = new Set(['SIMKL_QUOTA_RESERVE', 'SIMKL_DAILY_LIMIT', 'SIMKL_APP_LIMIT', 'SIMKL_QUOTA_UNKNOWN']);
const TERMINAL = new Set(['completed', 'review', 'cancelled']);
const intentPrefix = runId => `simkl-full-sync:${runId}:`;
const review = (itemId, reason) => ({ itemId, status: 'review', detail: { reason } });
const detailText = detail => (detail && typeof detail === 'object' ? detail.reason || '' : detail || '');

const leaseCurrent = id => Boolean(db.prepare(`SELECT 1 FROM simkl_full_sync_runs
  WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?`).get(id, OWNER, Date.now()));

async function defaultReadSnapshot(connection) {
  const read = await runInTrackerGeneration('simkl', connection.id, () => readTrackerSnapshot('simkl', { trigger: 'user' }));
  if (read.connection?.id !== connection.id) throw Object.assign(new Error('Simkl account changed during verification'), { code: 'FULL_SYNC_PLAN_STALE' });
  return read.snapshot;
}

function cancelRunIntents(runId, reason) {
  const now = Date.now();
  db.prepare(`UPDATE tracker_write_intents SET status='cancelled',last_error=?,settled_at=?,updated_at=?
    WHERE provider='simkl' AND logical_key LIKE ? AND status='pending'`).run(reason, now, now, `${intentPrefix(runId)}%`);
}

function remainingPacing(run, connection) {
  const quota = simklTransport.quotaFor(connection);
  const remaining = run.counts.remaining;
  return estimateSimklFullSync(remaining, { quotaLimit: quota.quotaLimit, quotaRemaining: quota.quotaRemaining, policy: run.state.policy });
}

function waitForQuota(run, connection, error = {}) {
  const now = Date.now();
  const reset = Math.max(nextSimklDailyReset(now), Number(error.resetAt) > now ? Number(error.resetAt) : 0);
  const unknown = error.code === 'SIMKL_QUOTA_UNKNOWN';
  return store.updateSimklFullSyncRun(run.id, OWNER, { status: 'waiting_quota', nextRunAt: reset + RESET_MARGIN_MS, state: {
    pacing: remainingPacing(store.getSimklFullSyncRun(run.id, { items: false }), connection),
    waitReason: unknown ? 'Simkl did not report its daily allowance; full sync waits for verified quota.' : 'Waiting for the next Simkl daily quota reset.',
  } });
}

function finish(run, status, reason = '') {
  if (status === 'review') {
    store.updateSimklFullSyncItems(run.id, OWNER, store.getSimklFullSyncRun(run.id).items
      .filter(item => item.status === 'pending').map(item => review(item.itemId, reason)));
  }
  cancelRunIntents(run.id, reason || 'Simkl full sync finished');
  return store.updateSimklFullSyncRun(run.id, OWNER, { status, state: { finishedAt: Date.now(), error: reason } });
}

function revalidate(run, pending, connection, snapshot) {
  const remote = (snapshot.watched || []).filter(item => Number(item.watchedAt) > 0)
    .map(item => ({ media: item.media, remoteWatchedAt: Number(item.watchedAt) }));
  const remoteKeys = new Set(remote.flatMap(item => trackerMediaIdentityKeys(item.media)));
  const index = (items, mediaOf = item => item) => {
    const map = new Map();
    for (const item of items) for (const key of trackerMediaIdentityKeys(mediaOf(item))) if (!map.has(key)) map.set(key, item);
    return keys => keys.map(key => map.get(key)).find(Boolean);
  };
  const localFor = index(localWatchedItems());
  const holdFor = index(currentWriteHolds('simkl', connection, { excludeRunId: run.id }), hold => hold.media);
  const outcomes = [], candidates = [];
  let deferred = 0;
  for (const item of pending) {
    const keys = trackerMediaIdentityKeys(item.row.media);
    if (keys.some(key => remoteKeys.has(key))) { outcomes.push({ itemId: item.itemId, status: 'completed', detail: { reason: 'Already on Simkl' } }); continue; }
    const current = localFor(keys);
    if (!current) { outcomes.push({ itemId: item.itemId, status: 'cancelled', detail: { reason: 'No longer watched in Plekt; not sent' } }); continue; }
    if (Date.parse(current.watched_at) !== Date.parse(item.row.watchedAt)) { outcomes.push(review(item.itemId, 'The first Plekt watch date changed after approval; review it before sending')); continue; }
    const hold = holdFor(keys);
    // An ordinary write in flight for the same title: wait for it to settle.
    if (hold) {
      if (['review', 'uncertain'].includes(hold.status)) outcomes.push(review(item.itemId, `An existing Simkl write is ${hold.status}; resolve it in Sync Attention`));
      else deferred++;
      continue;
    }
    candidates.push({ item, current });
  }
  // The approved preview's own rules (review observations, progress order,
  // identity conflicts) must still pass with the fresh remote state.
  const rows = buildTrackerFullSyncItems('simkl', candidates.map(c => c.current), remote, { review: snapshot.review || [], syncEnabled: true });
  const valid = new Set(rows.filter(row => row.side === 'tracker' && row.selectable).map(row => row.id));
  const sendable = [];
  for (const candidate of candidates) {
    if (valid.has(candidate.item.itemId)) { sendable.push(candidate); continue; }
    const keys = trackerMediaIdentityKeys(candidate.current);
    const row = rows.find(entry => entry.side === 'tracker' && trackerMediaIdentityKeys(entry.media).some(key => keys.includes(key)));
    outcomes.push(review(candidate.item.itemId, row?.reason || 'This item no longer matches the approved preview'));
  }
  return { outcomes, sendable, deferred };
}

async function sendChunk(run, connection, chunk, dispatch) {
  const now = Date.now();
  const prepared = [], outcomes = [];
  for (const { item, current } of chunk) {
    const media = { ...current, watched_at: item.row.watchedAt, syncIntent: 'historical', simklFullSyncRunId: run.id };
    // Stable logical key: a resumed run reuses its intent instead of creating a second play.
    const intent = createTrackerWriteIntent({ provider: 'simkl', connection, media, action: 'watched', logicalKey: `${intentPrefix(run.id)}${item.itemId}`, dueAt: now });
    if (intent.status === 'settled') outcomes.push({ itemId: item.itemId, status: 'completed', detail: null });
    else if (intent.status !== 'pending') outcomes.push(review(item.itemId, intent.last_error || `An earlier send for this item is ${intent.status}; it will not be sent again automatically`));
    else prepared.push({ item, intent, media: { ...media, watched_at: intent.watched_at, trackerWriteIntentId: intent.id, syncTargets: ['simkl'] } });
  }
  if (!store.updateSimklFullSyncItems(run.id, OWNER, [...outcomes, ...prepared.map(({ item }) => ({ itemId: item.itemId, status: 'sending', detail: null }))])) return null;
  if (prepared.length) {
    try {
      await withSimklFullSyncContext({ runId: run.id, isCurrent: () => leaseCurrent(run.id) }, () => simklTransport.withBudget({
        maxRequests: SIMKL_FULL_SYNC_BATCH_REQUESTS + 2, minimumRemaining: 56, normalReservePolicy: run.state.policy,
      }, () => dispatch(prepared.map(entry => entry.media), 'watched', { lane: 'sync' })));
    } catch { /* Outcomes come from each durable intent below. */ }
  }
  const read = db.prepare('SELECT status,last_error FROM tracker_write_intents WHERE id=?');
  const results = prepared.map(({ item, intent }) => {
    const live = read.get(intent.id);
    if (live?.status === 'settled') return { itemId: item.itemId, status: 'completed', detail: null };
    // Never claimed (quota stop before preflight finished): safe to try later.
    if (live?.status === 'pending') return { itemId: item.itemId, status: 'pending', detail: null };
    return review(item.itemId, live?.last_error || 'Simkl did not confirm this item; it will not be sent again automatically');
  });
  if (!store.updateSimklFullSyncItems(run.id, OWNER, results)) return null;
  return { progressed: outcomes.length + results.filter(r => r.status !== 'pending').length, stalled: results.some(r => r.status === 'pending') };
}

async function slice(run, { readSnapshot, dispatch }) {
  const connection = getTrackerConnection('simkl');
  if (!connection || connection.id !== run.connectionId || connection.remoteUserId !== run.accountId) {
    const reason = 'The Simkl connection or account changed; remaining items were not sent.';
    store.cancelSimklFullSyncRun(run.id, reason);
    cancelRunIntents(run.id, reason);
    return;
  }
  if (isAuthoritativeRestoreActive() || !watchedPlayedSyncEnabled() || connection.status !== 'connected') {
    store.updateSimklFullSyncRun(run.id, OWNER, { status: 'queued', nextRunAt: Date.now() + SIMKL_FULL_SYNC_PAUSE_MS,
      state: { waitReason: 'Paused while a restore runs, watched sync is off or Simkl needs attention.' } });
    return;
  }
  const pending = run.items.filter(item => item.status === 'pending');
  if (!pending.length) return finish(run, 'completed');
  const policy = run.state.policy;
  let snapshot;
  try {
    snapshot = await simklTransport.withBudget({ maxRequests: SIMKL_FULL_SYNC_VERIFY_REQUESTS, minimumRemaining: 56,
      allowUnknownFirst: true, normalReservePolicy: policy }, () => readSnapshot(connection));
  } catch (error) {
    if (QUOTA_CODES.has(error.code)) return waitForQuota(run, connection, error);
    throw error;
  }
  if (!snapshot?.complete) throw Object.assign(new Error('Simkl returned an incomplete library; nothing was sent'), { code: 'FULL_SYNC_INCOMPLETE' });
  const { outcomes, sendable, deferred } = revalidate(run, pending, connection, snapshot);
  if (!store.updateSimklFullSyncItems(run.id, OWNER, outcomes)) return;
  let progressed = outcomes.length, stalled = false;
  const quota = simklTransport.quotaFor(connection);
  const reserves = simklFullSyncProtectedQuota(quota.quotaLimit, policy);
  if (sendable.length) {
    if (!reserves || !Number.isSafeInteger(quota.quotaRemaining)) return waitForQuota(run, connection, { code: 'SIMKL_QUOTA_UNKNOWN' });
    // Whole batches only, keeping the normal-use and safety reserves intact.
    const batches = Math.floor((quota.quotaRemaining - reserves.protectedQuota) / SIMKL_FULL_SYNC_BATCH_REQUESTS);
    const toSend = sendable.slice(0, Math.max(0, batches) * SIMKL_FULL_SYNC_BATCH_SIZE);
    for (let start = 0; start < toSend.length; start += SIMKL_FULL_SYNC_BATCH_SIZE) {
      const live = getTrackerConnection('simkl');
      if (!leaseCurrent(run.id) || live?.id !== connection.id || live.status !== 'connected' || isAuthoritativeRestoreActive() || !watchedPlayedSyncEnabled()) return;
      const result = await sendChunk(run, connection, toSend.slice(start, start + SIMKL_FULL_SYNC_BATCH_SIZE), dispatch);
      if (!result) return;
      progressed += result.progressed;
      if (result.stalled) { stalled = true; break; }
    }
  }
  const latest = store.getSimklFullSyncRun(run.id, { items: false });
  if (!latest.counts.remaining) return finish(latest, 'completed');
  const after = simklTransport.quotaFor(connection);
  const lowQuota = !reserves || !Number.isSafeInteger(after.quotaRemaining)
    || after.quotaRemaining - reserves.protectedQuota < SIMKL_FULL_SYNC_BATCH_REQUESTS;
  if (lowQuota && (sendable.length || stalled)) return waitForQuota(latest, connection, Number.isSafeInteger(after.quotaRemaining) ? {} : { code: 'SIMKL_QUOTA_UNKNOWN' });
  if (stalled && !progressed) throw Object.assign(new Error('Simkl batch could not start; remaining items stay queued'), { code: 'SIMKL_BATCH_NOT_STARTED' });
  return store.updateSimklFullSyncRun(run.id, OWNER, { status: 'queued', nextRunAt: Date.now() + (deferred && !sendable.length ? SIMKL_FULL_SYNC_PAUSE_MS : 0),
    state: { failures: 0, waitReason: deferred ? 'Some items wait for an earlier Simkl write to settle.' : '' } });
}

function failed(id, error) {
  const run = store.getSimklFullSyncRun(id, { items: false });
  if (!run || run.status !== 'running' || run.leaseOwner !== OWNER) return;
  const message = String(error?.message || error).slice(0, 300);
  if (error?.code === 'SIMKL_RATE_LIMIT') {
    store.updateSimklFullSyncRun(id, OWNER, { status: 'queued', nextRunAt: Date.now() + RESET_MARGIN_MS });
    return;
  }
  const failures = Number(run.state.failures || 0) + 1;
  if (failures >= MAX_FAILURES) return finish(run, 'review', `Simkl full sync stopped after repeated failures: ${message}`);
  store.updateSimklFullSyncRun(id, OWNER, { status: 'queued', nextRunAt: Date.now() + SIMKL_FULL_SYNC_PAUSE_MS * failures,
    state: { failures, lastError: message } });
}

// Connection card and Initial sync destination mirror the durable run.
export function publishSimklFullSyncRun(id) {
  const run = store.getSimklFullSyncRun(id);
  if (!run) return null;
  const count = status => run.items.filter(item => item.status === status).length;
  const sent = count('completed'), held = count('review'), skipped = count('cancelled');
  const terminal = TERMINAL.has(run.status);
  const waiting = ['queued', 'waiting_quota'].includes(run.status);
  const status = run.status === 'completed' ? (held || skipped ? 'partial' : 'completed') : run.status === 'review' ? 'partial' : run.status;
  const error = run.state.error || run.state.cancellationReason || '';
  const connection = getTrackerConnection('simkl');
  if (connection?.id === run.connectionId && (!connection.fullSync?.runId || connection.fullSync.runId === run.id)) {
    const previous = connection.fullSync || {};
    const total = Math.max(Number(previous.total || 0), run.items.length);
    updateTrackerConnectionStatus('simkl', { connectionId: run.connectionId, fullSync: { ...previous, status, runId: run.id,
      phase: terminal ? '' : 'push', direction: run.state.direction || previous.direction, backup: previous.backup || run.state.backup || null,
      total, done: total - run.items.length + sent + held + skipped, sent, notSent: held + skipped,
      imported: run.state.imported || previous.imported || 0, propagationFailed: run.state.propagationFailed || previous.propagationFailed || 0,
      nextRunAt: waiting ? run.nextRunAt : null, pacing: run.state.pacing || null, waitReason: waiting ? run.state.waitReason || '' : '',
      finishedAt: terminal ? run.updatedAt : null, error, comparedAt: null } });
  }
  const jobId = run.state.initialJobId;
  if (jobId && readInitialSync()?.id === jobId) {
    updateInitialSyncItems(jobId, 'simkl', run.items.map(item => ({ id: item.itemId, status: item.status, detail: detailText(item.detail) })));
    const destinationStatus = run.status === 'completed' ? (held || skipped ? 'partial' : 'completed')
      : run.status === 'review' ? 'partial' : run.status === 'waiting_quota' ? 'waiting_quota' : run.status === 'cancelled' ? 'cancelled' : 'running';
    patchInitialSync(jobId, job => ({ destinations: job.destinations.map(destination => destination.provider !== 'simkl' ? destination
      : { ...destination, pacedRunId: run.id, status: destinationStatus, nextRunAt: waiting ? run.nextRunAt : null, pacing: run.state.pacing || null, error }) }));
    finalizeInitialSync(jobId);
  }
  return run;
}

export async function runSimklFullSyncSlice(id, { readSnapshot = defaultReadSnapshot, dispatch = dispatchTrackerWatchBatch } = {}) {
  const run = store.claimSimklFullSyncRun(id, OWNER);
  if (!run) return null;
  const heartbeat = setInterval(() => store.heartbeatSimklFullSyncRun(id, OWNER), 60_000);
  heartbeat.unref?.();
  try { await slice(run, { readSnapshot, dispatch }); }
  catch (error) { failed(id, error); }
  finally {
    clearInterval(heartbeat);
    // A slice that returned while still leased (an early stop) hands the run back.
    if (leaseCurrent(id)) store.updateSimklFullSyncRun(id, OWNER, { status: 'queued', nextRunAt: Date.now() + SIMKL_FULL_SYNC_PAUSE_MS });
    publishSimklFullSyncRun(id);
  }
  return store.getSimklFullSyncRun(id, { items: false });
}

let kicking = null;
// Scheduler tick, the full-sync route and initial sync call this; leases keep
// concurrent processes from running the same slice.
export function kickSimklFullSyncRuns(options) {
  if (kicking) return kicking;
  kicking = (async () => {
    let slices = 0;
    for (const id of store.dueSimklFullSyncRuns()) if (await runSimklFullSyncSlice(id, options)) slices++;
    return { slices };
  })().finally(() => { kicking = null; });
  return kicking;
}

export function cancelSimklFullSync(runId, reason = 'Cancelled from Settings') {
  const connection = getTrackerConnection('simkl');
  const active = connection?.id ? store.activeSimklFullSyncRun(connection.id) : null;
  if (!active || (runId && active.id !== runId)) throw Object.assign(new Error('No paced Simkl full sync is in progress'), { code: 'FULL_SYNC_NOT_RUNNING', status: 409 });
  store.cancelSimklFullSyncRun(active.id, reason);
  cancelRunIntents(active.id, reason);
  publishSimklFullSyncRun(active.id);
  return getTrackerConnection('simkl')?.fullSync || null;
}
