import { db } from "../db.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { invalidateHistoryDerivedCaches } from "./dataRepo.js";
import { cancelTrackerWriteIntent, correlateTrackerObservation, trackerIntentConnectionCurrent, trackerWriteAttentionItems } from "./trackerWriteIntents.js";
import { createPerUserState } from "./perUserState.js";
import { freshTrackerConnection } from "./trackers/connections.js";
import { recordTrackerPlay } from "./trackerConnectionRepo.js";
import { fetchTraktHistoryWindow, trackerMediaMatches } from "./trackers/traktClient.js";
import { recheckHeldSimklWrites } from "./trackers/simklHeldWrites.js";

const recheckState = createPerUserState(() => ({ work: null }));
const TRAKT_RECHECK_INTERVAL_MS = 6 * 3600_000;
const readIntent = db.prepare("SELECT * FROM tracker_write_intents WHERE id=? AND status='review' AND provider='trakt' AND action='watched'");
const listDueTrakt = db.prepare(`SELECT i.* FROM tracker_write_intents i
  WHERE i.provider='trakt' AND i.connection_id=? AND i.account_id=?
    AND i.action='watched' AND i.status='review'
    AND (i.attempts>0 OR i.last_error LIKE 'Ambiguous provider event %')
    AND COALESCE(i.last_error,'') NOT LIKE 'Not sent:%'
    AND ((? IS NULL AND i.due_at<=?) OR i.id IN (SELECT value FROM json_each(?)))
  ORDER BY i.due_at,i.created_at,i.id LIMIT ?`);
const deferTrakt = db.prepare("UPDATE tracker_write_intents SET due_at=? WHERE id=? AND status='review' AND due_at=?");
const readWatchIds = db.prepare("SELECT imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE id=?");
const settleDuplicate = db.prepare(`UPDATE tracker_write_intents AS i SET status='settled',last_error='',settled_at=?,updated_at=?
  WHERE i.id=? AND i.status='review' AND i.provider='trakt' AND i.action='watched'
    AND EXISTS (SELECT 1 FROM tracker_play_history p WHERE p.provider='trakt' AND p.history_id=?
      AND p.watch_record_id=i.watch_record_id AND unixepoch(p.watched_at)=unixepoch(i.watched_at) AND p.media_key=i.media_key)
    AND EXISTS (SELECT 1 FROM tracker_connections c WHERE c.provider=i.provider AND c.id=i.connection_id
      AND c.remote_user_id=i.account_id AND c.status='connected')`);

function hydrateIntentMediaIds(intent, media) {
  const existing = media.ids && typeof media.ids === "object" ? media.ids : {};
  if (existing.imdb || existing.tmdb || existing.tvdb || existing.trakt || !intent.watch_record_id) return media;
  const row = readWatchIds.get(intent.watch_record_id);
  if (!row || (!row.imdb_id && !row.tmdb_id && !row.tvdb_id)) return media;
  return {
    ...media,
    ids: {
      ...existing,
      ...(row.imdb_id ? { imdb: String(row.imdb_id) } : {}),
      ...(row.tmdb_id ? { tmdb: String(row.tmdb_id) } : {}),
      ...(row.tvdb_id ? { tvdb: String(row.tvdb_id) } : {}),
    },
  };
}

export function cancelSelectedTrackerWrites(ids) {
  const selected = new Set(ids);
  return db.transaction(() => trackerWriteAttentionItems()
    .filter((item) => item.source === "tracker_write" && selected.has(item.id))
    .filter((item) => cancelTrackerWriteIntent(item.intentId)).length).immediate();
}

async function recheckTraktIntents(intents, connection) {
  let confirmed = 0;
  const pending = [];
  const competingByEvent = new Map();
  for (const intent of intents) {
    if (!intent || !trackerIntentConnectionCurrent(intent)) continue;
    const eventId = /^Ambiguous provider event (\d+)/.exec(intent.last_error || "")?.[1];
    if (eventId) {
      const now = Date.now();
      const settled = settleDuplicate.run(now, now, intent.id, eventId).changes;
      confirmed += settled;
      if (!settled) {
        if (!competingByEvent.has(eventId)) competingByEvent.set(eventId, []);
        competingByEvent.get(eventId).push(intent);
      }
    } else if (!/^Ambiguous provider event /.test(intent.last_error || "")) {
      pending.push({ intent });
    }
  }
  for (const [eventId, competing] of competingByEvent) {
    const [first] = competing;
    if (!first.watch_record_id) continue;
    const involved = new Set(first.last_error.split("; competing intents: ")[1]?.split(", "));
    if (competing.length < 2 || involved.size !== competing.length || competing.some((intent) =>
      !involved.has(intent.id) || intent.watch_record_id !== first.watch_record_id
      || intent.media_key !== first.media_key || intent.watched_at !== first.watched_at)) continue;
    pending.push({ intent: first, eventId, duplicates: competing });
  }
  if (!pending.length) return confirmed;
  const fresh = connection || await freshTrackerConnection("trakt");
  if (fresh?.status !== "connected") return confirmed;
  for (const { intent, eventId, duplicates } of pending) {
    if (isAuthoritativeRestoreActive() || !trackerIntentConnectionCurrent(intent) || intent.connection_id !== fresh.id) continue;
    let media;
    try {
      media = hydrateIntentMediaIds(intent, JSON.parse(intent.media_json));
    } catch {
      continue;
    }
    const type = media.type || media.media_type;
    const time = Date.parse(intent.watched_at);
    if (!["movie", "episode"].includes(type) || !Number.isFinite(time)) continue;
    const plays = await fetchTraktHistoryWindow(fresh, type, {
      startAt: new Date(time - 1000).toISOString(), endAt: new Date(time + 1000).toISOString(),
    });
    if (isAuthoritativeRestoreActive() || !readIntent.get(intent.id) || !trackerIntentConnectionCurrent(intent)) continue;
    const matches = plays.filter((play) => Math.floor(play.watchedAt / 1000) === Math.floor(time / 1000)
      && trackerMediaMatches(media, play.media) && (!eventId || String(play.historyId) === eventId));
    if (matches.length !== 1) continue;
    if (duplicates) {
      confirmed += db.transaction(() => {
        if (duplicates.some((original) => {
          const current = readIntent.get(original.id);
          return !current || current.last_error !== original.last_error || current.watched_at !== original.watched_at
            || current.watch_record_id !== original.watch_record_id || current.media_key !== original.media_key
            || !trackerIntentConnectionCurrent(current);
        })) return 0;
        recordTrackerPlay("trakt", {
          historyId: eventId, mediaKey: intent.media_key, watchedAt: new Date(matches[0].watchedAt).toISOString(),
          watchRecordId: intent.watch_record_id,
        });
        const now = Date.now();
        return duplicates.reduce((count, duplicate) => count + settleDuplicate.run(now, now, duplicate.id, eventId).changes, 0);
      }).immediate();
      continue;
    }
    const result = correlateTrackerObservation("trakt", fresh, matches[0]);
    if (result.status === "acknowledged" && result.intentId === intent.id) confirmed++;
  }
  return confirmed;
}

export async function recheckHeldTraktWrites(logger = console.log, { ids = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { completed: 0, checked: 0 };
  const connection = await freshTrackerConnection("trakt");
  if (connection?.status !== "connected") return { completed: 0, checked: 0 };
  const now = Date.now();
  const nextCheck = now + TRAKT_RECHECK_INTERVAL_MS;
  const selected = ids == null ? null : JSON.stringify(ids);
  const limit = ids == null ? 20 : Math.max(ids.length, 1);
  const intents = db.transaction(() => listDueTrakt.all(connection.id, connection.remoteUserId || "", selected, now, selected, limit)
    .filter((intent) => deferTrakt.run(nextCheck, intent.id, intent.due_at).changes)).immediate();
  if (!intents.length) return { completed: 0, checked: 0 };
  try {
    const completed = await recheckTraktIntents(intents, connection);
    return { completed, checked: intents.length };
  } catch (error) {
    logger(`Held Trakt writes could not be verified: ${error.message}`);
    return { completed: 0, checked: intents.length };
  }
}

async function recheckTraktWrites(items) {
  const intents = items.map((item) => readIntent.get(item.intentId)).filter(Boolean);
  if (!intents.length) return 0;
  return recheckTraktIntents(intents, null);
}

async function recheckAll() {
  const items = trackerWriteAttentionItems().filter((item) => item.source === "tracker_write");
  let confirmed = 0;
  const errors = [];
  const trakt = items.filter((item) => item.provider === "trakt");
  try {
    confirmed += await recheckTraktWrites(trakt);
  } catch {
    errors.push("Trakt history could not be fully checked.");
  }
  const simkl = items.filter((item) => item.provider === "simkl" && !item.notSent).map((item) => item.intentId);
  let telemetryWritten = false;
  for (let index = 0; index < simkl.length && !isAuthoritativeRestoreActive(); index += 100) {
    const result = await recheckHeldSimklWrites(() => {
      if (!errors.includes("Simkl history could not be fully checked.")) errors.push("Simkl history could not be fully checked.");
    }, { ids: simkl.slice(index, index + 100) });
    confirmed += result.completed;
    telemetryWritten ||= result.telemetryWritten;
    if (result.deferred) {
      errors.push(result.deferred);
      break;
    }
  }
  if (telemetryWritten) await invalidateHistoryDerivedCaches("tracker-write-recheck", { skipUpNextAutoSync: true });
  const remaining = trackerWriteAttentionItems().filter((item) => item.source === "tracker_write").length;
  return { confirmed, remaining, errors };
}

export async function recheckAllTrackerWrites() {
  if (isAuthoritativeRestoreActive()) return {
    confirmed: 0,
    remaining: trackerWriteAttentionItems().filter((item) => item.source === "tracker_write").length,
    errors: ["Tracker rechecks are paused during the restore."],
  };
  const state = recheckState();
  state.work ||= recheckAll().finally(() => { state.work = null; });
  return state.work;
}
