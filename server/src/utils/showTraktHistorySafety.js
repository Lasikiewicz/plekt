import { db } from "../db.js";
import { mediaKeyFor } from "./dataRepo.js";

export function traktPlayKey(media, date = media.watched_at) {
  const time = Date.parse(String(date || ""));
  if (!Number.isFinite(time)) throw new Error("A valid historical play date is required before replacing Trakt history");
  return `${Number(media.season)}:${Number(media.episode)}:${time}`;
}

// Only a local play's old, date-matched history ids are eligible for removal.
// Unrelated plays, including plays at overlapping episode numbers, stay put.
export function safeTraktReplaceItems(moves, remote, makeMedia) {
  const desired = new Map();
  for (const move of moves) for (const date of move.dates) {
    const item = makeMedia(move.to.season, move.to.episode, date);
    desired.set(traktPlayKey(item), item);
  }
  const existing = new Set(remote.map((entry) => traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString())));
  const counts = new Map();
  for (const entry of remote) {
    const key = traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString());
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const remove = remote.filter((entry) => {
    const key = traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString());
    if (desired.has(key) || counts.get(key) !== 1) return false;
    return moves.some((move) => move.season === entry.media.season && move.episode === entry.media.episode
      && move.dates.some((date) => traktPlayKey(move, date) === key));
  });
  return { desired, add: [...desired].filter(([key]) => !existing.has(key)).map(([, media]) => media), remove };
}

// A proven pre-switch Trakt row uses canonical Trakt numbers, not media-server
// numbers. Move its local identity only after the provider snapshot confirms it.
export function normalizeImportedTraktRow(id, target) {
  const row = db.prepare("SELECT * FROM watch_history WHERE id = ?").get(id);
  if (!row || (row.season === target.season && row.episode === target.episode)) return;
  const title = row.title.replace(/S\d+E\d+/i, `S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}`);
  const key = mediaKeyFor({ ...row, season: target.season, episode: target.episode, title });
  db.prepare("UPDATE watch_history SET season=?, episode=?, title=?, title_lower=?, media_key=?, updated_at=? WHERE id=?")
    .run(target.season, target.episode, title, title.toLowerCase(), key, Date.now(), id);
  db.prepare("UPDATE tracker_play_history SET media_key=? WHERE watch_record_id=?").run(key, id);
  // Imported history has no provider playback progress. Rebuild its cached
  // watched identity without deleting an old key still held by another row.
  const state = db.prepare("SELECT * FROM playstate WHERE media_key=?").get(row.media_key);
  if (state?.state === "watched") {
    const columns = Object.keys(state);
    const moved = { ...state, media_key: key, season: target.season, episode: target.episode, title };
    db.prepare(`INSERT OR IGNORE INTO playstate (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => moved[column]));
    if (!db.prepare("SELECT 1 FROM watch_history WHERE media_key=?").get(row.media_key)) db.prepare("DELETE FROM playstate WHERE media_key=?").run(row.media_key);
  }
}
