import { db } from "../../db.js";
import { resolveWatchSyncIntent } from "../watchSyncPolicy.js";

// Older Plekt history reaches a tracker only through its full sync or a tool
// the user runs (decision 21 October 2026). A watch record created before this
// connection, with no write intent captured for it, is backlog rather than a
// new watch, so a pending-dispatch replay must not send it silently.
//
// History imported from another tracker is backlog too, however new its local
// row is: forwarding it item by item bounced a whole Simkl import through Trakt
// and back on 22 October 2026. The caller passes the source's tracker id.
export function trackerBacklogSkipReason(connection = {}, media = {}, label = connection.provider, { sourceTracker = "" } = {}) {
  if (media.trackerWriteIntentId || Array.isArray(media.syncTargets)) return "";
  if (sourceTracker && sourceTracker !== connection.provider && resolveWatchSyncIntent(media) === "import") {
    return `Imported from another tracker's history; use ${label}'s full sync to send older history`;
  }
  const recordId = String(media.watchRecordId || "");
  if (!recordId) return "";
  if (["historical", "manual"].includes(String(media.syncIntent || ""))) return "";
  const connectedAt = Number(connection.connectedAt || 0);
  const record = db.prepare("SELECT created_at FROM watch_history WHERE id=?").get(recordId);
  if (!connectedAt || !record || Number(record.created_at || 0) >= connectedAt) return "";
  const captured = db.prepare("SELECT 1 FROM tracker_write_intents WHERE provider=? AND connection_id=? AND watch_record_id=? LIMIT 1")
    .get(connection.provider, connection.id, recordId);
  return captured ? "" : `Recorded before ${label} was connected; use its full sync to send older history`;
}
