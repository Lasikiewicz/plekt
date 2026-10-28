import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { schedulerLeaseStatus, validateSchedulerLease } from "./schedulerLease.js";

const selectJob = db.prepare("SELECT * FROM background_jobs WHERE id = ?");
const selectLatestType = db.prepare("SELECT * FROM background_jobs WHERE type = ? ORDER BY requested_at DESC LIMIT 1");
const selectLogs = db.prepare("SELECT seq, timestamp, message FROM background_job_logs WHERE job_id = ? ORDER BY seq");
const insertJob = db.prepare(`INSERT INTO background_jobs
  (id,type,status,requested_at,cancel_requested,payload) VALUES (@id,@type,'queued',@requestedAt,0,@payload)`);

export const BACKGROUND_JOB_STALE_MS = 90_000;
const RESTORE_PAUSED_JOB_TYPES = new Set(["cron_sync", "force_sync", "force_sync_plan", "up_next_sync", "up_next_priority_sync", "retry_all_sync_activity", "repair_playstate_episode_ids"]);

function cancelSyncJobsForRestoreInTransaction(now = Date.now()) {
  const placeholders = [...RESTORE_PAUSED_JOB_TYPES].map(() => "?").join(",");
  const queued = db.prepare(`UPDATE background_jobs
    SET status='cancelled', cancel_requested=1, finished_at=?, heartbeat_at=?,
        result=?, error=NULL
    WHERE status='queued' AND type IN (${placeholders})`).run(
    now,
    now,
    toJson({ success: false, aborted: true, cancelled: true, reason: "Job cancelled because an authoritative watch-history restore started." }),
    ...RESTORE_PAUSED_JOB_TYPES,
  ).changes;
  const running = db.prepare(`UPDATE background_jobs
    SET cancel_requested=1, heartbeat_at=?
    WHERE status='running' AND type IN (${placeholders})`).run(
    now,
    ...RESTORE_PAUSED_JOB_TYPES,
  ).changes;
  return { queued, running, total: queued + running };
}

// Restore takes precedence over queued and running sync jobs. Queued work is
// made terminal immediately; running workers see cancel_requested and the
// shared restore fence, so they stop accepting further batches/writes.
export function cancelSyncJobsForAuthoritativeRestore(now = Date.now()) {
  return db.transaction(() => cancelSyncJobsForRestoreInTransaction(now)).immediate();
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    claimedBy: row.claimed_by || "",
    claimGeneration: Number(row.claim_generation || 0),
    cancelRequested: Boolean(row.cancel_requested),
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null),
    error: row.error || "",
  };
}

export function workerAvailable(now = Date.now()) {
  return schedulerLeaseStatus(now).available;
}

const SUPPORTED_JOB_TYPES = ["cron_sync", "force_sync", "force_sync_plan", "up_next_sync", "up_next_priority_sync", "refresh_tmdb_metadata", "refresh_tvdb_metadata", "retry_all_sync_activity", "repair_playstate_episode_ids"];
// Job types that may only have one queued/running instance at a time - a
// second enqueue attempt is rejected with JOB_ACTIVE rather than piling up
// duplicate work against the same library scan.
const SINGLETON_JOB_TYPES = new Set(["force_sync", "force_sync_plan", "up_next_sync", "up_next_priority_sync", "refresh_tmdb_metadata", "refresh_tvdb_metadata", "retry_all_sync_activity", "repair_playstate_episode_ids"]);

export function enqueueBackgroundJob(type, payload = {}, now = Date.now()) {
  if (!SUPPORTED_JOB_TYPES.includes(type)) throw new Error(`Unsupported background job type: ${type}`);
  if (RESTORE_PAUSED_JOB_TYPES.has(type) && isAuthoritativeRestoreActive()) {
    const error = new Error("An authoritative watch-history restore is active; sync jobs are paused until it completes.");
    error.code = "RESTORE_ACTIVE";
    throw Object.assign(error, { status: 409 });
  }
  const job = { id: crypto.randomUUID(), type, requestedAt: now, payload: toJson(payload || {}) };
  return db.transaction(() => {
    if (SINGLETON_JOB_TYPES.has(type)) {
      const active = db.prepare("SELECT id FROM background_jobs WHERE type=? AND status IN ('queued','running') LIMIT 1").get(type);
      if (active) {
        const error = new Error("Another job of this type is already running.");
        error.code = "JOB_ACTIVE";
        throw error;
      }
    }
    insertJob.run(job);
    return shape(selectJob.get(job.id));
  }).immediate();
}

export function getBackgroundJob(id) {
  return shape(selectJob.get(String(id || "")));
}

export function getLatestBackgroundJob(type) {
  return shape(selectLatestType.get(type));
}

export function getBackgroundJobLogs(id) {
  return selectLogs.all(String(id || "")).map((row) => ({ seq: row.seq, timestamp: row.timestamp, message: row.message }));
}

export function appendBackgroundJobLog(id, message, now = Date.now()) {
  return db.transaction(() => {
    const seq = Number(db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM background_job_logs WHERE job_id = ?").get(id)?.seq || 1);
    db.prepare("INSERT INTO background_job_logs (job_id,seq,timestamp,message) VALUES (?,?,?,?)").run(id, seq, now, String(message));
    return seq;
  }).immediate();
}

export function claimNextBackgroundJob({ holderId, generation, staleAfterMs = BACKGROUND_JOB_STALE_MS, now = Date.now() }) {
  return db.transaction(() => {
  if (!validateSchedulerLease({ holderId, generation, now })) return null;

    if (isAuthoritativeRestoreActive()) {
      cancelSyncJobsForRestoreInTransaction(now);
      return null;
    }

    // A worker can die after an administrator presses Stop. Mark that job
    // terminal before looking for work so a replacement worker cannot revive
    // the cancelled operation through the stale-job reclaim path.
    const staleBefore = now - staleAfterMs;
    db.prepare(`UPDATE background_jobs
      SET status='cancelled', finished_at=@now, heartbeat_at=@now,
          result=@result, error=NULL
      WHERE status='running' AND cancel_requested=1 AND heartbeat_at < @staleBefore`).run({
      now,
      staleBefore,
      result: toJson({ success: false, aborted: true, cancelled: true, reason: "Cancellation requested while the previous worker was unavailable." }),
    });

    const row = db.prepare(`SELECT * FROM background_jobs
      WHERE (status = 'queued' AND cancel_requested = 0)
        OR (status = 'running' AND cancel_requested = 0 AND heartbeat_at < ?)
      ORDER BY CASE WHEN type = 'up_next_priority_sync' THEN 0 ELSE 1 END, requested_at LIMIT 1`).get(now - staleAfterMs);
    if (!row) return null;
    const changed = db.prepare(`UPDATE background_jobs
      SET status='running', started_at=COALESCE(started_at, @now), heartbeat_at=@now,
          claimed_by=@holderId, claim_generation=@generation, error=NULL
      WHERE id=@id AND cancel_requested=0
        AND (status='queued' OR (status='running' AND heartbeat_at < @staleBefore))`).run({
      id: row.id, holderId, generation, now, staleBefore: now - staleAfterMs,
    }).changes;
    return changed === 1 ? shape(selectJob.get(row.id)) : null;
  }).immediate();
}

export function heartbeatBackgroundJob({ id, holderId, generation, now = Date.now() }) {
  return db.prepare(`UPDATE background_jobs SET heartbeat_at=?
    WHERE id=? AND status='running' AND claimed_by=? AND claim_generation=?`).run(now, id, holderId, generation).changes === 1;
}

export function finishBackgroundJob({ id, holderId, generation, status = "succeeded", result = null, error = "", now = Date.now() }) {
  if (!["succeeded", "failed", "cancelled"].includes(status)) throw new Error(`Invalid terminal job status: ${status}`);
  return db.prepare(`UPDATE background_jobs SET status=@status, result=@result, error=@error,
      finished_at=@now, heartbeat_at=@now
    WHERE id=@id AND status='running' AND claimed_by=@holderId AND claim_generation=@generation`).run({
      id, holderId, generation, status, result: toJson(result), error: error || null, now,
    }).changes === 1;
}

export function requestBackgroundJobCancellation(id, now = Date.now()) {
  return db.transaction(() => {
    const job = shape(selectJob.get(id));
    if (!job) return null;
    if (job.status === "queued") {
      db.prepare(`UPDATE background_jobs
        SET status='cancelled', cancel_requested=1, finished_at=?, heartbeat_at=?,
            result=?, error=NULL
        WHERE id=? AND status='queued'`).run(
        now,
        now,
        toJson({ success: false, aborted: true, cancelled: true, reason: "Queued force sync cancelled." }),
        id,
      );
    } else if (job.status === "running") {
      db.prepare("UPDATE background_jobs SET cancel_requested=1, heartbeat_at=? WHERE id=? AND status='running'").run(now, id);
    }
    return shape(selectJob.get(id));
  }).immediate();
}

export function pruneBackgroundJobs(now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM background_jobs WHERE finished_at IS NOT NULL AND finished_at < ?").run(cutoff);
  db.prepare(`DELETE FROM background_jobs WHERE id IN (
    SELECT id FROM background_jobs WHERE finished_at IS NOT NULL ORDER BY requested_at DESC LIMIT -1 OFFSET 200
  )`).run();
}
