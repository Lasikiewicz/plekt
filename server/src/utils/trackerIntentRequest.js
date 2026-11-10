import { db } from "../db.js";
import { claimTrackerWriteIntent, correlateTrackerObservation, finishTrackerWriteIntent, trackerIntentForDispatch, trackerIntentConnectionCurrent } from "./trackerWriteIntents.js";
import { partitionTraktNotFoundBatch } from "./traktNotFoundPartition.js";

const HISTORY_WINDOW_MS = 60_000;
const statusOf = (id) => db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(id)?.status;

// Network calls happen outside the short claim/ack transactions. The local ID
// is never sent as a substitute for a provider-supported idempotency key.
// A canonical replay (replay: true) removes the play and then adds it again.
// Its remove has just cleared Trakt, so a settled intent from the earlier send
// no longer describes Trakt: reopen it so both the remove and the add are sent.
export async function trackerIntentRequest(connection, items, action, send, fetchHistory, { replay = false } = {}) {
  // Standalone client consumers (including protocol tests) have no managed
  // connection. Application dispatch always supplies the persisted connection.
  if (!connection.id) return send(items);
  const pending = [];
  for (const media of items) {
    let intent = trackerIntentForDispatch("trakt", connection, media, action);
    if (!trackerIntentConnectionCurrent(intent)) throw new Error("Tracker connection changed before write");
    if (intent.status === "settled" && replay) {
      finishTrackerWriteIntent(intent.id, "retry", "Canonical replay sends this write again");
      intent = { ...intent, status: "retry" };
    }
    if (intent.status === "settled") continue;
    if (intent.status === "uncertain" && action === "watched") {
      // The previous send may have landed before its response was lost.
      // Correlate against provider history before another non-idempotent add.
      const watchedMs = Date.parse(intent.watched_at);
      const stored = JSON.parse(intent.media_json);
      const plays = await fetchHistory(connection, stored.type || stored.media_type, {
        startAt: new Date(watchedMs - HISTORY_WINDOW_MS).toISOString(), endAt: new Date(watchedMs + HISTORY_WINDOW_MS).toISOString(),
      });
      for (const play of plays) correlateTrackerObservation("trakt", connection, play);
      const status = statusOf(intent.id);
      if (status === "settled") continue;
      if (status !== "uncertain") throw new Error(`Tracker write is held for review: ${intent.last_error || status}`);
      // History was read and holds no matching play, so the write never landed.
      finishTrackerWriteIntent(intent.id, "retry", "Previous send not found in provider history");
    } else if (intent.status === "uncertain") {
      // History removal is idempotent; resending cannot duplicate anything.
      finishTrackerWriteIntent(intent.id, "retry", intent.last_error || "");
    } else if (!["pending", "retry", "rejected"].includes(intent.status)) {
      throw new Error(intent.status === "cancelled" ? "Tracker write was cancelled in Sync Attention" : `Tracker write is held for review: ${intent.last_error || intent.status}`);
    }
    pending.push({ intent, media });
  }
  // alreadySent tells the dispatcher nothing was sent: every item is settled.
  if (!pending.length) return { added: {}, deleted: {}, not_found: {}, alreadySent: true };
  // Claim the complete batch atomically; never strand half of it as sending.
  db.transaction(() => {
    for (const { intent } of pending) if (!claimTrackerWriteIntent(intent.id)) throw new Error("Tracker write already claimed");
  }).immediate();
  try {
    // Send what the caller resolved now (a title-derived id fallback can differ
    // from the first attempt), with the date the intent committed to.
    const result = await send(pending.map(({ intent, media }) => ({ ...media, watched_at: intent.watched_at })));
    const sent = pending.map(({ intent, media }) => ({ ...media, watched_at: intent.watched_at }));
    const partition = partitionTraktNotFoundBatch(sent, result);
    if (partition.unidentified || (partition.entries.length && !partition.rejected.length)) {
      // The provider reported failures but its response cannot identify which
      // request items failed. Keep every write visible for manual review.
      for (const { intent } of pending) finishTrackerWriteIntent(intent.id, "review", "Trakt reported not_found but the unmatched items could not be identified");
    } else {
      const rejected = new Set(partition.rejected);
      // A grouped response can contain successful and unmatched items. Settle
      // only the successful writes; only the unmatched ones may be retried.
      for (let index = 0; index < pending.length; index++) {
        const { intent } = pending[index];
        const item = sent[index];
        finishTrackerWriteIntent(intent.id, rejected.has(item) ? "rejected" : "settled", rejected.has(item) ? "Trakt did not match this item" : "");
      }
    }
    return result;
  } catch (error) {
    const rejected = [400, 401, 403, 404, 422, 429].includes(Number(error.status));
    for (const { intent } of pending) {
      const attempts = Number(intent.attempts || 0) + 1;
      finishTrackerWriteIntent(intent.id, rejected ? (attempts >= 10 ? "review" : "retry") : "uncertain", error.message || String(error));
    }
    throw error;
  }
}
