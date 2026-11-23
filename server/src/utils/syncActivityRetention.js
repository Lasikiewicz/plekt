import { db } from "../db.js";
import { createPerUserState } from "./perUserState.js";

export const SYNC_ACTIVITY_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 2000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const cadence = createPerUserState(() => ({ nextAt: 0 }));
// Keep IDs, retry history, dismissal decisions and other operational fields. Only
// remove raw request/response bodies; malformed or unrecognised JSON is left intact.
const payloadPaths = ["$.bodyPreview", "$.rawPayload", "$.payload", "$.requestBody", "$.responseBody"];
const removable = `CASE WHEN json_valid(raw_payload_debug) THEN (${payloadPaths.map((p) => `json_type(raw_payload_debug, '${p}') IS NOT NULL`).join(" OR ")}) ELSE 0 END`;
const countStatement = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(raw_payload_debug)), 0) AS bytes
  FROM sync_history WHERE created_at > 0 AND created_at < ? AND ${removable}`);
const pruneStatement = db.prepare(`UPDATE sync_history SET raw_payload_debug = json_remove(raw_payload_debug, ${payloadPaths.map((p) => `'${p}'`).join(", ")}) WHERE id IN (
  SELECT id FROM sync_history WHERE created_at > 0 AND created_at < ? AND ${removable} LIMIT ?
)`);

export function countPrunableSyncActivityPayloads(now = Date.now()) {
  const row = countStatement.get(now - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS);
  return { rows: Number(row.rows), bytes: Number(row.bytes) };
}

export function pruneSyncActivityPayloads(now = Date.now(), batchSize = PRUNE_BATCH) {
  return pruneStatement.run(now - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS, batchSize).changes;
}

export function pruneSyncActivityPayloadsIfDue(now = Date.now()) {
  const state = cadence();
  if (now < state.nextAt) return 0;
  const changed = pruneSyncActivityPayloads(now);
  state.nextAt = changed >= PRUNE_BATCH ? 0 : now + PRUNE_INTERVAL_MS;
  return changed;
}
