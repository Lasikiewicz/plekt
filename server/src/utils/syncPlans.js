// Persistence for Force Sync plans (the `sync_plans` table).
//
// Status lifecycle:
//   draft → confirmed → executing → completed
// with terminal/side states: partial, failed, cancelled, superseded, expired, blocked_over_limit,
// blocked_scan_error, blocked_snapshot_failed. Plans are pruned after PLAN_RETENTION_MS; snapshot
// files referenced by unpruned plans are protected from backup retention
// (see watchHistoryBackups.js).

import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { PLAN_TTL_MS } from "./forceSyncPlanner.js";

export const PLAN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const insertPlan = db.prepare(`INSERT INTO sync_plans
  (id, created_at, status, scope_json, summary_json, actions_json, skipped_json, fingerprint_json, config_revision, snapshot_file, result_json, updated_at)
  VALUES (@id, @createdAt, @status, @scope, @summary, @actions, @skipped, @fingerprints, @configRevision, NULL, NULL, @createdAt)`);
const selectPlan = db.prepare("SELECT * FROM sync_plans WHERE id = ?");
const selectLatest = db.prepare("SELECT * FROM sync_plans ORDER BY created_at DESC LIMIT 1");
const updateStatusStmt = db.prepare("UPDATE sync_plans SET status = ?, updated_at = ? WHERE id = ?");
const updateSnapshotStmt = db.prepare("UPDATE sync_plans SET snapshot_file = ?, updated_at = ? WHERE id = ?");
const updateResultStmt = db.prepare("UPDATE sync_plans SET status = ?, result_json = ?, updated_at = ? WHERE id = ?");
const supersedeDraftsStmt = db.prepare(
  "UPDATE sync_plans SET status = 'superseded', updated_at = ? WHERE status IN ('draft', 'confirmed')",
);
const pruneStmt = db.prepare("DELETE FROM sync_plans WHERE created_at < ?");
const selectRecentSnapshotsStmt = db.prepare(
  "SELECT snapshot_file FROM sync_plans WHERE snapshot_file IS NOT NULL AND created_at >= ?",
);

function shapeSummaryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    scope: parseJson(row.scope_json, {}),
    summary: parseJson(row.summary_json, {}),
    fingerprints: parseJson(row.fingerprint_json, {}),
    configRevision: row.config_revision || "",
    snapshotFile: row.snapshot_file || "",
    result: parseJson(row.result_json, null),
    updatedAt: row.updated_at,
    expiresAt: Number(row.created_at) + PLAN_TTL_MS,
  };
}

export function createSyncPlanRecord(plan, { status } = {}) {
  const id = crypto.randomUUID();
  // A new plan supersedes any older unexecuted plan - there is exactly one
  // actionable plan at a time.
  const now = Date.now();
  db.transaction(() => {
    supersedeDraftsStmt.run(now);
    insertPlan.run({
      id,
      createdAt: plan.createdAt || now,
      status: status || (
        plan.summary?.overLimit
          ? "blocked_over_limit"
          : plan.summary?.scopeErrors?.length
            ? "blocked_scan_error"
            : "draft"
      ),
      scope: toJson(plan.scope || {}),
      summary: toJson(plan.summary || {}),
      actions: toJson(plan.actions || []),
      skipped: toJson(plan.skipped || []),
      fingerprints: toJson(plan.fingerprints || {}),
      configRevision: plan.configRevision || "",
    });
  }).immediate();
  return getSyncPlanSummary(id);
}

export function getSyncPlanSummary(id) {
  return shapeSummaryRow(selectPlan.get(String(id || "")));
}

export function getLatestSyncPlan() {
  return shapeSummaryRow(selectLatest.get());
}

// Full plan including actions - used by the executor, never by list views.
export function getSyncPlanFull(id) {
  const row = selectPlan.get(String(id || ""));
  if (!row) return null;
  return {
    ...shapeSummaryRow(row),
    actions: parseJson(row.actions_json, []),
    skipped: parseJson(row.skipped_json, []),
  };
}

export function getSyncPlanActionsPage(id, { page = 1, pageSize = 50, risk = "" } = {}) {
  const row = selectPlan.get(String(id || ""));
  if (!row) return null;
  let actions = parseJson(row.actions_json, []);
  if (risk === "additive" || risk === "destructive") {
    actions = actions.filter((action) => action.risk === risk);
  }
  const safeSize = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const totalPages = Math.max(1, Math.ceil(actions.length / safeSize));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const start = (safePage - 1) * safeSize;
  return {
    page: safePage,
    pageSize: safeSize,
    totalActions: actions.length,
    totalPages,
    actions: actions.slice(start, start + safeSize),
  };
}

export function confirmSyncPlan(id) {
  const plan = getSyncPlanSummary(id);
  if (!plan) return { ok: false, error: "Plan not found." };
  if (plan.status === "blocked_over_limit") {
    return { ok: false, error: "This plan exceeds its maximum-change limit and cannot be confirmed. Narrow the scope and plan again." };
  }
  if (plan.status === "blocked_scan_error") {
    return { ok: false, error: "This plan cannot be confirmed because one or more configured servers could not be scanned. Restore connectivity and create a fresh preview." };
  }
  if (!["draft", "confirmed"].includes(plan.status)) {
    return { ok: false, error: `Plan is ${plan.status} and can no longer be confirmed.` };
  }
  if (Date.now() > plan.expiresAt) {
    updateStatusStmt.run("expired", Date.now(), plan.id);
    return { ok: false, error: "Plan has expired. Create a fresh preview." };
  }
  updateStatusStmt.run("confirmed", Date.now(), plan.id);
  return { ok: true, plan: getSyncPlanSummary(id) };
}

export function setSyncPlanStatus(id, status) {
  updateStatusStmt.run(String(status), Date.now(), String(id || ""));
  return getSyncPlanSummary(id);
}

export function setSyncPlanSnapshot(id, snapshotFile) {
  updateSnapshotStmt.run(String(snapshotFile || ""), Date.now(), String(id || ""));
}

export function finishSyncPlan(id, status, result) {
  updateResultStmt.run(String(status), toJson(result || null), Date.now(), String(id || ""));
  return getSyncPlanSummary(id);
}

export function supersedeOpenSyncPlans() {
  supersedeDraftsStmt.run(Date.now());
}

export function pruneSyncPlans(now = Date.now()) {
  pruneStmt.run(now - PLAN_RETENTION_MS);
}

// Snapshot filenames still referenced by recent plans - backup retention must
// not delete these (see watchHistoryBackups.js).
export function protectedSnapshotFiles(now = Date.now()) {
  return new Set(
    selectRecentSnapshotsStmt
      .all(now - PLAN_RETENTION_MS)
      .map((row) => String(row.snapshot_file || ""))
      .filter(Boolean),
  );
}
