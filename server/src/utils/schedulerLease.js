import { adminDb as db } from "../db.js";

// One process runs every user's scheduler tick, so the lease is a single
// install-wide record in the admin database. The routed `db` would read an
// added user's own, never-claimed copy and report that the leader lost it.

const selectLease = db.prepare("SELECT * FROM scheduler_lease WHERE id = 'scheduler'");
const claimLease = db.prepare(`
  UPDATE scheduler_lease
     SET holder_id = @holderId,
         holder_role = @role,
         generation = CASE WHEN holder_id = @holderId THEN generation ELSE generation + 1 END,
         acquired_at = CASE WHEN holder_id = @holderId THEN acquired_at ELSE @now END,
         heartbeat_at = @now,
         expires_at = @expiresAt
   WHERE id = 'scheduler'
     AND (holder_id = @holderId OR holder_id IS NULL OR expires_at <= @now)
`);
const renewLease = db.prepare(`
  UPDATE scheduler_lease SET heartbeat_at = @now, expires_at = @expiresAt
   WHERE id = 'scheduler' AND holder_id = @holderId AND generation = @generation AND expires_at > @now
`);
const releaseLease = db.prepare(`
  UPDATE scheduler_lease SET holder_id = NULL, holder_role = NULL, heartbeat_at = @now, expires_at = @now
   WHERE id = 'scheduler' AND holder_id = @holderId AND generation = @generation
`);
const markTickStmt = db.prepare(`
  UPDATE scheduler_lease SET last_tick_at = @now
   WHERE id = 'scheduler' AND holder_id = @holderId AND generation = @generation AND expires_at > @now
`);

function shaped(row) {
  if (!row) return null;
  return {
    holderId: row.holder_id || "",
    role: row.holder_role || "",
    generation: Number(row.generation || 0),
    acquiredAt: Number(row.acquired_at || 0),
    heartbeatAt: Number(row.heartbeat_at || 0),
    expiresAt: Number(row.expires_at || 0),
    lastTickAt: Number(row.last_tick_at || 0),
  };
}

export function schedulerLeaseStatus(now = Date.now()) {
  const lease = shaped(selectLease.get());
  return { ...lease, available: Boolean(lease?.holderId && lease.expiresAt > now) };
}

export function claimSchedulerLease({ holderId, role, ttlMs = 60_000, now = Date.now() }) {
  return db.transaction(() => {
    claimLease.run({ holderId, role, now, expiresAt: now + ttlMs });
    const lease = shaped(selectLease.get());
    if (lease?.holderId !== holderId || lease.expiresAt <= now) return null;
    return lease;
  }).immediate();
}

export function renewSchedulerLease({ holderId, generation, ttlMs = 60_000, now = Date.now() }) {
  return renewLease.run({ holderId, generation, now, expiresAt: now + ttlMs }).changes === 1;
}

export function validateSchedulerLease({ holderId, generation, now = Date.now() }) {
  const lease = shaped(selectLease.get());
  return Boolean(lease?.holderId === holderId && lease.generation === Number(generation) && lease.expiresAt > now);
}

export function releaseSchedulerLease({ holderId, generation, now = Date.now() }) {
  return releaseLease.run({ holderId, generation, now }).changes === 1;
}

export function markSchedulerTick({ holderId, generation, now = Date.now() }) {
  return markTickStmt.run({ holderId, generation, now }).changes === 1;
}
