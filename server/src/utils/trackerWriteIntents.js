import crypto from "node:crypto";
import { db } from "../db.js";
import { getTrackerProtocolAdapter as getTrackerAdapter, trackerProviderIds } from "./trackers/registry.js";
import { unknownTrackerProviderData } from "./trackerConnectionRepo.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";

export const TRACKER_INTENT_RETENTION_MS = 30 * 86400_000;
// Ordinary Simkl watched intents share one due time so the worker can send them
// as a single batch. Explicit bulk marks set simklSendNow and bypass this wait.
export const SIMKL_WATCHED_COALESCE_MS = 30 * 60_000;
const SEND_LEASE_MS = 5 * 60_000;
// A rejected write (provider match failure) sent nothing, so it can age out.
const terminal = new Set(["settled", "cancelled", "rejected"]);
// Rows for a tracker this version does not know (restore or downgrade) stay inert.
const KNOWN = "provider IN (SELECT value FROM json_each(?))";
const known = () => JSON.stringify(trackerProviderIds());
const read = (id) => db.prepare("SELECT * FROM tracker_write_intents WHERE id=?").get(id) || null;

export function trackerIntentConnectionCurrent(intent) {
  return Boolean(db.prepare("SELECT 1 FROM tracker_connections WHERE provider=? AND id=? AND remote_user_id=? AND status='connected'")
    .get(intent.provider, intent.connection_id, intent.account_id));
}

export function maintainTrackerWriteIntents(now = Date.now()) {
  // These audit rejections followed a POST, rather than a catalogue rejection.
  // Keep their uncertainty visible and durable instead of ageing them out and
  // allowing a later full-sync preview to create another send.
  db.prepare(`UPDATE tracker_write_intents SET status='review',settled_at=NULL,updated_at=?
    WHERE provider='simkl' AND action='watched' AND status='rejected'
    AND last_error LIKE 'Not watched on Simkl current progress after %audit%'
    AND EXISTS (SELECT 1 FROM tracker_connections c WHERE c.provider='simkl' AND c.id=connection_id AND c.remote_user_id=account_id)`)
    .run(now);
  // Simkl cannot recover an interrupted send by replaying it. Surface the
  // current account's uncertainty even while activation/retry discovery is off.
  // A live send keeps its lease; stale restored account data stays quarantined.
  db.prepare(`UPDATE tracker_write_intents SET status='review',last_error='Interrupted Simkl write needs review; it will not be sent again automatically',updated_at=?
    WHERE provider='simkl' AND (status='uncertain' OR (status='sending' AND due_at<=?))
    AND EXISTS (SELECT 1 FROM tracker_connections c WHERE c.provider='simkl' AND c.id=connection_id AND c.remote_user_id=account_id)`)
    .run(now, now);
  db.prepare(`DELETE FROM tracker_write_intents WHERE ${KNOWN} AND settled_at IS NOT NULL AND settled_at<? AND status IN ('settled','cancelled','rejected')`)
    .run(known(), now - TRACKER_INTENT_RETENTION_MS);
  db.prepare(`UPDATE tracker_write_intents SET status='uncertain',last_error='Interrupted send; correlate before retry',updated_at=? WHERE ${KNOWN} AND status='sending' AND due_at<=?`).run(now, known(), now);
  db.prepare(`UPDATE tracker_write_intents SET status='review',last_error='Unresolved tracker write is older than 30 days',updated_at=? WHERE ${KNOWN} AND settled_at IS NULL AND created_at<? AND status NOT IN ('review','sending')`)
    .run(now, known(), now - TRACKER_INTENT_RETENTION_MS);
}

function simklWatchedDueAt(connectionId, now) {
  const open = db.prepare(`SELECT MIN(due_at) AS due FROM tracker_write_intents
    WHERE provider='simkl' AND connection_id=? AND action='watched' AND status='pending' AND due_at>?`).get(connectionId, now);
  if (Number.isSafeInteger(open?.due) && open.due > now) return open.due;
  return now + SIMKL_WATCHED_COALESCE_MS;
}

export function createTrackerWriteIntent({ provider, connection, media, action, watchRecordId = "", logicalKey = "", eventType = "watch", now = Date.now(), status = "pending", dueAt = null } = {}) {
  const adapter = getTrackerAdapter(provider);
  const key = adapter.identity.key(media);
  const watchedAt = new Date(media.watched_at || media.watchedAt || now).toISOString();
  const due = Number.isSafeInteger(dueAt) ? dueAt
    : provider === "simkl" && action === "watched" ? simklWatchedDueAt(connection.id, now) : now;
  const row = {
    id: crypto.randomUUID(), provider, connection_id: connection.id, account_id: connection.remoteUserId || "",
    logical_key: logicalKey || (watchRecordId ? `${watchRecordId}:${action}:${media.trackerActionId || watchedAt}` : crypto.randomUUID()),
    watch_record_id: watchRecordId || null, media_key: key, media_json: JSON.stringify(media), action,
    watched_at: watchedAt, event_type: eventType,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify([provider, key, action, watchedAt, eventType])).digest("hex"),
    native_idempotency: Number(Boolean(adapter.correlation?.nativeIdempotency)), status,
    due_at: due, expires_at: now + TRACKER_INTENT_RETENTION_MS, created_at: now, updated_at: now,
  };
  db.prepare(`INSERT OR IGNORE INTO tracker_write_intents (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})`).run(row);
  const intent = db.prepare("SELECT * FROM tracker_write_intents WHERE provider=? AND connection_id=? AND logical_key=?").get(provider, connection.id, row.logical_key);
  db.prepare(`INSERT INTO tracker_item_state (provider,media_key,media_json,last_seen_at,last_outbound_intent_id) VALUES (?,?,?,?,?)
    ON CONFLICT(provider,media_key) DO UPDATE SET last_outbound_intent_id=excluded.last_outbound_intent_id`)
    .run(provider, key, row.media_json, now, intent.id);
  return intent;
}

export function captureTrackerDestinations(record, id) {
  if (!watchedPlayedSyncEnabled()) return [];
  // Settled historical imports and policy skips never gain eligibility.
  const telemetry = String(record.sync_dispatch_telemetry || "");
  if (telemetry && !/Dispatch status: pending/i.test(telemetry)) return [];
  const source = String(record.source || "");
  if (/import|restore/i.test(source)) return [];
  const media = { ...record, type: record.media_type || record.type, ids: record.ids || { imdb: record.imdb_id, tmdb: record.tmdb_id, tvdb: record.tvdb_id } };
  const action = /unwatch|unplayed/.test(record.sync_action || "") ? "unwatched" : "watched";
  return db.prepare(`SELECT id,provider,remote_user_id FROM tracker_connections WHERE status='connected' AND ${KNOWN}`).all(known()).flatMap((connection) => {
    const adapter = getTrackerAdapter(connection.provider);
    if (adapter.ownsSource(source)) return [];
    return [createTrackerWriteIntent({ provider: connection.provider, connection: { ...connection, remoteUserId: connection.remote_user_id }, media, action, watchRecordId: id })];
  });
}

const DUE_INTENTS = `FROM tracker_write_intents i JOIN tracker_connections c ON c.provider=i.provider AND c.id=i.connection_id AND c.remote_user_id=i.account_id
    WHERE c.status='connected' AND i.${KNOWN} AND i.due_at<=?`;

// Orphan intents by default. Simkl's explicit includeLinked gather also updates
// each surviving watch row's telemetry; other trackers retain the row retry path.
export function listDueTrackerWriteIntents(now = Date.now(), limit = 15, provider = "", { includeLinked = false } = {}) {
  maintainTrackerWriteIntents(now);
  // Paced Simkl full-sync intents belong to their run's quota policy only.
  return db.prepare(`SELECT i.* ${DUE_INTENTS} AND i.status IN ('pending','retry','uncertain')
    AND i.logical_key NOT LIKE 'simkl-full-sync:%'
    AND (? OR i.watch_record_id IS NULL OR NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.id=i.watch_record_id))
    AND (?='' OR i.provider=?) ORDER BY i.created_at,i.id LIMIT ?`).all(known(), now, Number(includeLinked), provider, provider, limit);
}

// Watch records whose failed or interrupted tracker write is due again.
export function trackerRetryRecordIds(now = Date.now()) {
  maintainTrackerWriteIntents(now);
  return new Set(db.prepare(`SELECT DISTINCT i.watch_record_id AS id ${DUE_INTENTS} AND i.status IN ('retry','uncertain') AND i.watch_record_id IS NOT NULL`)
    .all(known(), now).map((row) => String(row.id)));
}

export function cancelTrackerWriteIntent(id) {
  const now = Date.now();
  return db.prepare("UPDATE tracker_write_intents SET status='cancelled',settled_at=?,updated_at=? WHERE id=? AND status='review'").run(now, now, id).changes === 1;
}

export function trackerIntentForDispatch(provider, connection, media, action) {
  if (media.trackerWriteIntentId) {
    const intent = read(media.trackerWriteIntentId);
    if (!intent || intent.provider !== provider || !trackerIntentConnectionCurrent(intent)) throw new Error("Tracker write belongs to an expired connection");
    if (intent.action !== action) return createTrackerWriteIntent({ provider, connection, media, action, watchRecordId: intent.watch_record_id, logicalKey: `${intent.id}:${action}` });
    return intent;
  }
  const intent = createTrackerWriteIntent({ provider, connection, media, action, watchRecordId: media.watchRecordId || "" });
  if (intent.attempts === 0 && intent.status === "pending") {
    // Eligibility was captured with the local identity. Dispatch may now have
    // translated compound episodes or applied an explicit Fix Match override.
    db.prepare("UPDATE tracker_write_intents SET media_key=?,media_json=? WHERE id=?")
      .run(getTrackerAdapter(provider).identity.key(media), JSON.stringify(media), intent.id);
    return read(intent.id);
  }
  return intent;
}

export function claimTrackerWriteIntent(id, now = Date.now()) {
  return db.transaction(() => {
    const intent = read(id);
    if (!intent || !trackerIntentConnectionCurrent(intent) || !["pending", "retry", "rejected"].includes(intent.status)) return false;
    return db.prepare("UPDATE tracker_write_intents SET status='sending',attempts=attempts+1,due_at=?,updated_at=? WHERE id=? AND status=?")
      .run(now + SEND_LEASE_MS, now, id, intent.status).changes === 1;
  }).immediate();
}

export function finishTrackerWriteIntent(id, status, error = "", remoteEventId = null) {
  const now = Date.now();
  const intent = read(id);
  if (!intent || !trackerIntentConnectionCurrent(intent)) return;
  db.prepare("UPDATE tracker_write_intents SET status=?,last_error=?,remote_event_id=COALESCE(?,remote_event_id),settled_at=?,updated_at=?,due_at=? WHERE id=?")
    .run(status, error, remoteEventId == null ? null : String(remoteEventId), terminal.has(status) ? now : null, now, now + Math.min(6 * 3600_000, 60_000 * 5 ** Math.max(0, intent.attempts - 1)), id);
}

export function correlateTrackerObservation(provider, connection, entry) {
  return db.transaction(() => {
    const adapter = getTrackerAdapter(provider);
    if (!db.prepare("SELECT 1 FROM tracker_connections WHERE provider=? AND id=? AND remote_user_id=?").get(provider, connection.id, connection.remoteUserId || "")) return { status: "stale" };
    const eventId = String(entry.historyId);
    if (db.prepare("SELECT 1 FROM tracker_play_history WHERE provider=? AND history_id=?").get(provider, eventId)) return { status: "known" };
    const candidates = db.prepare("SELECT * FROM tracker_write_intents WHERE provider=? AND connection_id=? AND account_id=? AND action='watched' AND status<>'cancelled'")
      .all(provider, connection.id, connection.remoteUserId || "").filter((intent) => intent.remote_event_id === eventId || (!intent.remote_event_id
        && adapter.identity.matches(JSON.parse(intent.media_json), entry.media)
        && Math.abs(Date.parse(intent.watched_at) - Number(entry.watchedAt)) <= (adapter.correlation?.windowMs ?? 60_000)));
    const exact = candidates.filter((intent) => intent.remote_event_id === eventId);
    const matches = exact.length ? exact : candidates;
    if (!matches.length) return { status: "unmatched" };
    if (matches.length > 1) {
      for (const intent of matches) finishTrackerWriteIntent(intent.id, "review", `Ambiguous provider event ${eventId}; competing intents: ${matches.map((item) => item.id).join(", ")}`);
      return { status: "ambiguous", intentIds: matches.map((item) => item.id) };
    }
    const intent = matches[0];
    db.prepare("INSERT OR IGNORE INTO tracker_play_history (provider,history_id,media_key,watched_at,watch_record_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(provider, eventId, adapter.identity.key(entry.media), new Date(entry.watchedAt).toISOString(), intent.watch_record_id, Date.now());
    finishTrackerWriteIntent(intent.id, "settled", "", eventId);
    return { status: "acknowledged", intentId: intent.id };
  }).immediate();
}

export function trackerWriteAttentionItems() {
  maintainTrackerWriteIntents();
  return db.prepare(`SELECT * FROM tracker_write_intents WHERE status='review' AND (${KNOWN} OR (provider='simkl' AND EXISTS
    (SELECT 1 FROM tracker_connections c WHERE c.provider='simkl' AND c.id=connection_id AND c.remote_user_id=account_id))) ORDER BY created_at`).all(known()).map((intent) => {
    const knownUnsent = intent.provider === "simkl" && String(intent.last_error || "").startsWith("Not sent:");
    const explanation = knownUnsent
      ? "Plekt checked this write before contacting Simkl and stopped because the media identity or watch date could not be verified. It was not sent."
      : "Plekt cannot tell whether this write reached the tracker, so it will not send it again automatically. Another send could create a duplicate play.";
    const recommendations = knownUnsent
      ? ["Correct this title's identity or watch date in Plekt, then create a new sync write if it is still needed.", "Cancel this held write to remove the warning. Local watch history is not changed."]
      : [`Check this title's history on ${getTrackerAdapter(intent.provider).label}.`, "If the play is there, or you do not want it sent, cancel this write. Local watch history is not changed."];
    return {
      id: `tracker-intent-${intent.id}`, kind: "tracker_write_review", provider: intent.provider, severity: "warning",
      title: `${getTrackerAdapter(intent.provider).label}: ${JSON.parse(intent.media_json).title || intent.media_key}`,
      watchedAt: intent.watched_at,
      reason: intent.last_error || "Tracker write requires review", intentId: intent.id,
      source: "tracker_write", status: "review", createdAt: intent.created_at, canSkip: true, skipLabel: "Cancel this write",
      skipTitle: "Cancel this tracker write?", explanationHeading: "Why this write is held",
      skipNote: "Cancelling means Plekt will not send this write. Local watch history is not changed.",
      summary: intent.last_error || "Tracker write requires review", explanation, recommendations,
    };
  }).concat(unknownTrackerAttentionItems());
}

// When this process first saw each unrecognised tracker, for the card's date.
const unknownTrackerFirstSeen = new Map();

// One non-blocking warning per unrecognised tracker. Skip only hides it; the
// rows are never read, sent or deleted.
function unknownTrackerAttentionItems() {
  return unknownTrackerProviderData().map(({ provider, tables }) => {
    const name = provider.charAt(0).toUpperCase() + provider.slice(1);
    if (!unknownTrackerFirstSeen.has(provider)) unknownTrackerFirstSeen.set(provider, Date.now());
    return {
      id: `unknown-tracker:${provider}`, kind: "unknown_tracker_data", provider, severity: "warning", source: "unknown_tracker",
      title: `${name} isn't supported in this version`, status: "warning", createdAt: unknownTrackerFirstSeen.get(provider),
      summary: `Your restored data includes ${name}, but this version of Plekt can't sync with it.`,
      explanationHeading: "What this means",
      explanation: `Plekt leaves the ${name} data as it is and won't sync with ${name}. Your watch history and other connections are not affected.`,
      recommendations: [`Using ${name}? Update Plekt to the version that made the backup.`, `Not using ${name}? Hide this message.`],
      canSkip: true, skipLabel: "Hide this message", skipTitle: "Hide this message?",
      skipNote: "Hiding it doesn't delete anything.", context: { tables },
    };
  });
}
