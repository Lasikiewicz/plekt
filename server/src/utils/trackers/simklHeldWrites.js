import { db } from "../../db.js";
import { isAuthoritativeRestoreActive } from "../configStore.js";
import { getTrackerConnection } from "../trackerConnectionRepo.js";
import { trackerIntentConnectionCurrent } from "../trackerWriteIntents.js";
import { recheckSimklWatchedDates } from "./simklBatchClient.js";
import { createSimklBatchBudget } from "./simklBatchBudget.js";
import { freshSimklConnection } from "./simklConnection.js";
import { recordSimklBacklogResult } from "./simklBacklogDispatch.js";

const budget = createSimklBatchBudget(db);
const listDue = db.prepare(`SELECT i.* FROM tracker_write_intents i
  WHERE i.provider='simkl' AND i.connection_id=? AND i.account_id=?
    AND i.action='watched' AND i.status='review'
    AND (i.attempts>0 OR i.last_error LIKE 'Not watched on Simkl current progress after %audit%')
    AND ((? IS NULL AND i.due_at<=?) OR i.id IN (SELECT value FROM json_each(?)))
    AND COALESCE(i.last_error,'') NOT LIKE 'Not sent:%'
    AND NOT EXISTS (SELECT 1 FROM tracker_write_intents other
      WHERE other.provider=i.provider AND other.connection_id=i.connection_id AND other.account_id=i.account_id
        AND other.fingerprint=i.fingerprint AND other.id<>i.id AND other.status NOT IN ('cancelled','rejected'))
  ORDER BY i.due_at,i.created_at,i.id LIMIT 100`);
const defer = db.prepare("UPDATE tracker_write_intents SET due_at=? WHERE id=? AND status='review' AND due_at=?");
const settle = db.prepare(`UPDATE tracker_write_intents SET status='settled',last_error='',settled_at=?,updated_at=?
  WHERE id=? AND status='review' AND due_at=? AND watched_at=? AND media_json=?`);

export async function recheckHeldSimklWrites(logger = console.log, { ids = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { completed: 0, telemetryWritten: false };
  const connection = getTrackerConnection("simkl", { includeCredentials: true });
  if (connection?.status !== "connected") return { completed: 0, telemetryWritten: false, deferred: "Simkl is disconnected." };
  if (budget.isHeld(connection)) return { completed: 0, telemetryWritten: false, deferred: "Simkl recheck is waiting for its quota reset." };
  const now = Date.now();
  const nextCheck = now + 6 * 3600_000;
  const selected = ids == null ? null : JSON.stringify(ids);
  const intents = db.transaction(() => listDue.all(connection.id, connection.remoteUserId, selected, now, selected)
    .filter((intent) => defer.run(nextCheck, intent.id, intent.due_at).changes)).immediate();
  if (!intents.length) return { completed: 0, telemetryWritten: false };

  try {
    const fresh = await freshSimklConnection();
    if (fresh?.id !== connection.id || fresh.remoteUserId !== connection.remoteUserId || budget.isHeld(fresh)) {
      return { completed: 0, telemetryWritten: false };
    }
    const media = intents.flatMap((intent) => {
      try {
        return [{ ...JSON.parse(intent.media_json), watched_at: intent.watched_at, trackerWriteIntentId: intent.id }];
      } catch {
        return [];
      }
    });
    const earliestAt = intents.reduce((min, intent) => {
      const stamp = Number(intent.created_at);
      return Number.isFinite(stamp) && stamp > 1000 ? Math.min(min, stamp) : min;
    }, Infinity);
    const confirmed = new Set((await recheckSimklWatchedDates(fresh, media, {
      earliestAt: Number.isFinite(earliestAt) ? Math.max(2000, earliestAt - 60_000) : null,
    })).map((item) => item.trackerWriteIntentId));
    let completed = 0;
    let telemetryWritten = false;
    for (const intent of intents) {
      if (!confirmed.has(intent.id) || isAuthoritativeRestoreActive() || !trackerIntentConnectionCurrent(intent)) continue;
      const checkedAt = Date.now();
      if (!settle.run(checkedAt, checkedAt, intent.id, nextCheck, intent.watched_at, intent.media_json).changes) continue;
      completed++;
      try {
        if (await recordSimklBacklogResult(intent, [{
          target: "simkl", status: "success", detail: "Watch date confirmed on Simkl",
        }])) telemetryWritten = true;
      } catch (error) {
        logger(`Simkl watch was confirmed but telemetry could not be updated: ${error.message}`);
      }
    }
    return { completed, telemetryWritten, checked: media.length };
  } catch (error) {
    logger(`Held Simkl writes could not be verified: ${error.message}`);
    return { completed: 0, telemetryWritten: false };
  }
}
