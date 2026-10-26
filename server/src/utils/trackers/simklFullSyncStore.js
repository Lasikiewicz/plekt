import crypto from 'node:crypto';
import { db } from '../../db.js';

const RUN_STATUSES = new Set(['queued', 'running', 'waiting_quota', 'completed', 'review', 'cancelled']);
const ITEM_STATUSES = new Set(['pending', 'sending', 'completed', 'review', 'cancelled']);
const DEFAULT_LEASE_MS = 180_000;
const RUN_SELECT = `SELECT id, connection_id, account_id, status, next_run_at, lease_owner,
  lease_until, created_at, updated_at, state_json FROM simkl_full_sync_runs`;

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|secret|authorization|headers?)/i.test(key))
    .map(([key, entry]) => [key, withoutCredentials(entry)]));
}

const jsonForStorage = value => JSON.stringify(withoutCredentials(value));

function shapeRun(row, includeItems = true) {
  if (!row) return null;
  const state = parseJson(row.state_json, {});
  const items = includeItems ? db.prepare(`SELECT run_id, item_id, row_json, status, detail
    FROM simkl_full_sync_items WHERE run_id=? ORDER BY rowid`).all(row.id).map(item => ({
      runId: item.run_id,
      itemId: item.item_id,
      row: parseJson(item.row_json, null),
      status: item.status,
      detail: item.detail == null ? null : parseJson(item.detail, item.detail),
    })) : undefined;
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('pending','sending') THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review
    FROM simkl_full_sync_items WHERE run_id=?`).get(row.id);
  return {
    id: row.id,
    connectionId: row.connection_id,
    accountId: row.account_id,
    status: row.status,
    nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state,
    counts: { completed: counts.completed || 0, remaining: counts.remaining || 0, review: counts.review || 0 },
    ...(includeItems ? { items } : {}),
  };
}

function validPolicy(policy) {
  return policy !== null && typeof policy === 'object' && !Array.isArray(policy);
}

export function createSimklFullSyncRun({ connection, rows, initialJobId = null, backup = null,
  direction = 'push', imported = 0, propagationFailed = 0, policy, pacing = null } = {}) {
  if (!connection?.id) throw new TypeError('A Simkl connection with an id is required');
  const accountId = connection.accountId ?? connection.account_id ?? connection.remoteUserId ?? connection.remote_user_id;
  if (accountId == null || accountId === '') throw new TypeError('A Simkl account id is required');
  if (!Array.isArray(rows)) throw new TypeError('Selected sync rows are required');
  if (!validPolicy(policy)) throw new TypeError('An explicit full-sync policy object is required');
  const selected = rows.map(row => {
    if (!row?.id || !row?.media || typeof row.media !== 'object') throw new TypeError('Each selected row needs an id and media');
    return { itemId: String(row.id), row: { id: row.id, side:row.side||'tracker',targets:row.targets||[],media: row.media, watchedAt: row.watchedAt ?? null } };
  });
  if (new Set(selected.map(item => item.itemId)).size !== selected.length) throw new TypeError('Selected row ids must be unique');

  const now = Date.now();
  const id = crypto.randomUUID();
  const state = { initialJobId, backup, direction, imported, propagationFailed, policy, pacing, failures: 0 };
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO simkl_full_sync_runs
      (id, connection_id, account_id, status, next_run_at, lease_owner, lease_until, created_at, updated_at, state_json)
      VALUES (?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?)`)
      .run(id, String(connection.id), String(accountId), now, now, now, jsonForStorage(state));
    const insert = db.prepare(`INSERT INTO simkl_full_sync_items (run_id, item_id, row_json, status, detail)
      VALUES (?, ?, ?, 'pending', NULL)`);
    for (const item of selected) insert.run(id, item.itemId, jsonForStorage(item.row));
  });
  try { create.immediate(); }
  catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(new Error('An active Simkl full-sync run already exists for this connection and account'), {
        code: 'SIMKL_FULL_SYNC_ALREADY_ACTIVE', status: 409,
      });
    }
    throw error;
  }
  return getSimklFullSyncRun(id);
}

export function getSimklFullSyncRun(id, { items = true } = {}) {
  return shapeRun(db.prepare(`${RUN_SELECT} WHERE id=?`).get(id), items);
}

export function latestSimklFullSyncRun(connectionId) {
  const row = db.prepare(`${RUN_SELECT} WHERE connection_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(String(connectionId));
  return shapeRun(row);
}

// Light lookup for status overlays and start/compare refusal; no item rows.
export function activeSimklFullSyncRun(connectionId) {
  const row = db.prepare(`${RUN_SELECT} WHERE connection_id=? AND status IN ('queued','running','waiting_quota')
    ORDER BY created_at DESC LIMIT 1`).get(String(connectionId));
  return shapeRun(row, false);
}

export function claimSimklFullSyncRun(id, owner, { now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!owner) throw new TypeError('A lease owner is required');
  return db.transaction(() => {
    const run = db.prepare(`${RUN_SELECT} WHERE id=?`).get(id);
    if (!run) return null;
    if (run.lease_owner && run.lease_owner !== String(owner) && run.lease_until > now) return null;
    const staleRunning = run.status === 'running' && (run.lease_until == null || run.lease_until <= now);
    const dueQueued = ['queued', 'waiting_quota'].includes(run.status) && run.next_run_at <= now;
    if (!staleRunning && !dueQueued) return null;
    if (staleRunning) {
      db.prepare(`UPDATE simkl_full_sync_items SET status='review', detail=?
        WHERE run_id=? AND status='sending'`).run(JSON.stringify({
        reason: 'The previous worker lease expired while this item was sending; the remote outcome is uncertain and it was not replayed.',
        code: 'SIMKL_SEND_OUTCOME_UNCERTAIN',
      }), id);
    }
    const claimed = db.prepare(`UPDATE simkl_full_sync_runs SET status='running', lease_owner=?, lease_until=?, updated_at=?
      WHERE id=? AND ((status IN ('queued','waiting_quota') AND next_run_at<=?)
        OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
      .run(String(owner), now + leaseMs, now, id, now, now);
    return claimed.changes === 1 ? shapeRun(db.prepare(`${RUN_SELECT} WHERE id=?`).get(id)) : null;
  }).immediate();
}

const RESERVED_STATE_KEYS = new Set(['id', 'runId', 'connectionId', 'accountId', 'connection_id', 'account_id', 'items', 'rows']);

export function updateSimklFullSyncRun(id, owner, patch = {}) {
  const now = Date.now();
  return db.transaction(() => {
    const current = db.prepare(`${RUN_SELECT} WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?`).get(id, owner, now);
    if (!current) return null;
    const nextStatus = patch.status ?? current.status;
    if (!RUN_STATUSES.has(nextStatus)) throw new TypeError('Invalid Simkl full-sync run status');
    const statePatch = patch.state && typeof patch.state === 'object' && !Array.isArray(patch.state) ? patch.state : {};
    if (Object.keys(statePatch).some(key => RESERVED_STATE_KEYS.has(key))) throw new TypeError('Run state cannot replace primary ids or selected rows');
    const state = { ...parseJson(current.state_json, {}), ...statePatch };
    const nextRunAt = patch.nextRunAt == null ? current.next_run_at : Number(patch.nextRunAt);
    if (!Number.isFinite(nextRunAt)) throw new TypeError('nextRunAt must be a finite timestamp');
    const running = nextStatus === 'running';
    db.prepare(`UPDATE simkl_full_sync_runs SET status=?, next_run_at=?, lease_owner=?, lease_until=?, updated_at=?, state_json=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?`)
      .run(nextStatus, nextRunAt, running ? owner : null, running ? current.lease_until : null,
        now, jsonForStorage(state), id, owner, now);
    return shapeRun(db.prepare(`${RUN_SELECT} WHERE id=?`).get(id));
  }).immediate();
}

export function updateSimklFullSyncItems(id, owner, outcomes) {
  if (!Array.isArray(outcomes)) throw new TypeError('Item outcomes must be an array');
  const now = Date.now();
  return db.transaction(() => {
    const current = db.prepare(`SELECT id FROM simkl_full_sync_runs
      WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?`).get(id, owner, now);
    if (!current) return null;
    const get = db.prepare('SELECT status FROM simkl_full_sync_items WHERE run_id=? AND item_id=?');
    const update = db.prepare('UPDATE simkl_full_sync_items SET status=?, detail=? WHERE run_id=? AND item_id=?');
    for (const outcome of outcomes) {
      if (!outcome?.itemId || !ITEM_STATUSES.has(outcome.status)) throw new TypeError('Invalid Simkl full-sync item outcome');
      const previous = get.get(id, String(outcome.itemId));
      if (!previous) throw new Error(`Unknown Simkl full-sync item: ${outcome.itemId}`);
      if (['completed', 'review'].includes(previous.status) && outcome.status === 'pending') {
        throw Object.assign(new Error(`Cannot requeue a ${previous.status} Simkl full-sync item`), { code: 'SIMKL_ITEM_OUTCOME_FINAL' });
      }
      update.run(outcome.status, outcome.detail == null ? null : jsonForStorage(outcome.detail), id, String(outcome.itemId));
    }
    return shapeRun(db.prepare(`${RUN_SELECT} WHERE id=?`).get(id));
  }).immediate();
}

export function dueSimklFullSyncRuns(now = Date.now()) {
  return db.prepare(`SELECT id FROM simkl_full_sync_runs
    WHERE (status IN ('queued','waiting_quota') AND next_run_at<=?)
      OR (status='running' AND (lease_until IS NULL OR lease_until<=?))
    ORDER BY CASE WHEN status='running' THEN lease_until ELSE next_run_at END, created_at, id LIMIT 5`)
    .all(now, now).map(row => row.id);
}

export function cancelSimklFullSyncRun(id, reason) {
  const now = Date.now();
  return db.transaction(() => {
    const run = db.prepare(`${RUN_SELECT} WHERE id=?`).get(id);
    if (!run || run.status === 'cancelled') return shapeRun(run);
    db.prepare(`UPDATE simkl_full_sync_runs SET status='cancelled', lease_owner=NULL, lease_until=NULL,
      updated_at=?, state_json=? WHERE id=?`).run(now,
      jsonForStorage({ ...parseJson(run.state_json, {}), cancellationReason: reason ?? null }), id);
    db.prepare(`UPDATE simkl_full_sync_items SET status='cancelled', detail=? WHERE run_id=? AND status='pending'`)
      .run(reason == null ? null : JSON.stringify({ reason }), id);
    db.prepare(`UPDATE simkl_full_sync_items SET status='review', detail=? WHERE run_id=? AND status='sending'`)
      .run(JSON.stringify({ reason: 'Cancellation interrupted a sending item; its remote outcome is uncertain.',
        code: 'SIMKL_SEND_OUTCOME_UNCERTAIN', cancellationReason: reason ?? null }), id);
    return shapeRun(db.prepare(`${RUN_SELECT} WHERE id=?`).get(id));
  }).immediate();
}

export function heartbeatSimklFullSyncRun(id, owner, leaseMs = DEFAULT_LEASE_MS) {
  const now = Date.now();
  const result = db.prepare(`UPDATE simkl_full_sync_runs SET lease_until=?, updated_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?`)
    .run(now + leaseMs, now, id, owner, now);
  return result.changes === 1 ? getSimklFullSyncRun(id) : null;
}
