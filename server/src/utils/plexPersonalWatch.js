import { db } from "../db.js";
import { insertWatchRecordSync, invalidateHistoryDerivedCaches, mediaKeyFor, mediaToWatchRecord } from "./dataRepo.js";

const existingWatch = db.prepare("SELECT id FROM watch_history WHERE media_key = ? AND watched_at >= ? LIMIT 1");
const insertOnce = db.transaction((record) => {
  if (existingWatch.get(mediaKeyFor(record), record.watched_at)) return false;
  insertWatchRecordSync(record);
  return true;
});

export async function storePlexPersonalWatch(media, watchedAt) {
  if (!media.isValid || !media.itemId || !["movie", "episode"].includes(media.type)) return false;
  const record = mediaToWatchRecord({
    ...media,
    ids: {},
    watched_at: watchedAt,
    syncDispatchTelemetry: "Origin: plex\nDispatch status: skipped\nDetails: Plex Personal Media is stored only in Plekt.",
  }, "plex_personal_media");
  const inserted = insertOnce.immediate(record);
  if (inserted) await invalidateHistoryDerivedCaches("Plex Personal Media watch");
  return inserted;
}
