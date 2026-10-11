import crypto from "node:crypto";
import { db } from "../db.js";
import { brandEnv } from "./brandEnv.js";

const LEASE_TTL_MS = 60_000;
const LEASE_RENEW_MS = 15_000;
const LEASE_RETRY_MS = 10;
const LEASE_ACQUIRE_TIMEOUT_MS = 5 * 60_000;
const INSTANCE_ID = brandEnv("INSTANCE_ID")
  || `${process.env.ROLE || "process"}:${process.pid}:${Date.now()}`;

const claimLeaseStmt = db.prepare(`
  INSERT INTO outbound_state_leases (
    lease_key, owner_id, generation, state, acquired_at, expires_at
  ) VALUES (
    @leaseKey, @ownerId, 1, @state, @now, @expiresAt
  )
  ON CONFLICT(lease_key) DO UPDATE SET
    owner_id = excluded.owner_id,
    generation = outbound_state_leases.generation + 1,
    state = excluded.state,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at
  WHERE outbound_state_leases.owner_id IS NULL
     OR outbound_state_leases.expires_at <= @now
  RETURNING generation
`);
const renewLeaseStmt = db.prepare(`
  UPDATE outbound_state_leases
     SET expires_at = @expiresAt
   WHERE lease_key = @leaseKey
     AND owner_id = @ownerId
     AND generation = @generation
     AND expires_at > @now
`);
const ownsLeaseStmt = db.prepare(`
  SELECT 1
    FROM outbound_state_leases
   WHERE lease_key = @leaseKey
     AND owner_id = @ownerId
     AND generation = @generation
     AND expires_at > @now
`);
const releaseLeaseStmt = db.prepare(`
  DELETE FROM outbound_state_leases
   WHERE lease_key = @leaseKey
     AND owner_id = @ownerId
     AND generation = @generation
`);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferredResult() {
  return {
    status: "deferred",
    deferred: true,
    detail: "A newer local/outbound state took precedence while this dispatch was queued",
  };
}

// Serializes one media item's played-state writes to one destination across
// the split web/worker deployment. The lease covers the complete remote
// operation, not just admission: for an unwatch that means both clearing
// resume progress and marking unplayed. A later Force Sync therefore waits
// for an older poll and writes watched last; if it already finished first,
// the poll re-checks its generation guard after acquiring and does no write.
export async function runWithOutboundStateLease(
  leaseKey,
  state,
  work,
  { shouldDefer = null } = {},
) {
  const normalizedKey = String(leaseKey || "").trim();
  if (!normalizedKey) throw new Error("Outbound state lease key is required");
  const ownerId = `${INSTANCE_ID}:${crypto.randomUUID()}`;
  let generation = 0;
  let ownershipLost = false;
  const acquireStartedAt = performance.now();

  while (!generation) {
    const now = Date.now();
    try {
      generation = Number(claimLeaseStmt.get({
        leaseKey: normalizedKey,
        ownerId,
        state: String(state || "unknown"),
        now,
        expiresAt: now + LEASE_TTL_MS,
      })?.generation || 0);
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY") throw error;
    }
    // A claim that succeeds exactly on the boundary owns the lease and must
    // proceed (or release in finally). Timing out after a successful claim
    // would strand that row until its TTL elapsed.
    if (!generation && performance.now() - acquireStartedAt >= LEASE_ACQUIRE_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for outbound state lease after ${Math.round(LEASE_ACQUIRE_TIMEOUT_MS / 1000)}s`);
    }
    if (!generation) await wait(LEASE_RETRY_MS);
  }

  const renew = () => {
    if (ownershipLost) return;
    try {
      const now = Date.now();
      const renewed = renewLeaseStmt.run({
        leaseKey: normalizedKey,
        ownerId,
        generation,
        now,
        expiresAt: now + LEASE_TTL_MS,
      });
      if (renewed.changes === 0) {
        ownershipLost = true;
        console.warn("Outbound state lease ownership was lost before renewal", {
          leaseKey: normalizedKey,
          generation,
        });
      }
    } catch (error) {
      // A transient SQLite writer can briefly outlive busy_timeout. The next
      // heartbeat retries; never let a timer exception terminate the process.
      console.error("Failed to renew outbound state lease", error);
    }
  };

  // This is intentionally a live SQLite ownership probe rather than only an
  // in-memory heartbeat flag. A delayed event loop can wake after the TTL and
  // another process can claim a newer generation before our next heartbeat.
  // In that case this owner must be fenced before it sends another remote
  // mutation, even though its async work is still running locally.
  const hasLeaseOwnership = () => {
    if (ownershipLost) return false;
    try {
      const owned = Boolean(ownsLeaseStmt.get({
        leaseKey: normalizedKey,
        ownerId,
        generation,
        now: Date.now(),
      }));
      if (!owned) ownershipLost = true;
      return owned;
    } catch (error) {
      // Failing closed is safer than issuing an unfenced played-state write.
      ownershipLost = true;
      console.error("Failed to verify outbound state lease ownership", error);
      return false;
    }
  };
  // Deferral hooks may be synchronous (the normal local-state transition
  // path) or asynchronous (an authoritative restore also verifies that its
  // owner still holds the cross-process restore fence). Keep the probe live
  // and await the hook so an async callback is not treated as a truthy Promise
  // and used to defer every outbound write.
  const leaseShouldDefer = async () => {
    if (ownershipLost || !hasLeaseOwnership()) return true;
    if (!shouldDefer) return false;
    try {
      return Boolean(await shouldDefer());
    } catch {
      return true;
    }
  };
  const heartbeat = setInterval(renew, LEASE_RENEW_MS);
  heartbeat.unref?.();

  try {
    // This check must happen after admission. A newer operation may have held
    // the lease, completed its write, and released while this caller waited.
    if (await leaseShouldDefer()) return deferredResult();
    return await work({ shouldDefer: leaseShouldDefer });
  } finally {
    clearInterval(heartbeat);
    try {
      releaseLeaseStmt.run({
        leaseKey: normalizedKey,
        ownerId,
        generation,
      });
    } catch (error) {
      // Do not turn a successful remote write into an application failure.
      // The hard expiry remains the recovery path if SQLite stayed busy.
      console.error("Failed to release outbound state lease", error);
    }
  }
}
