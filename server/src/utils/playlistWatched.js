import { bumpDataVersion, db, transaction } from "../db.js";
import { isPlektTrackedWatchRow } from "./dataRepo.js";
import { withPlaylistLock } from "./playlistPushEngine.js";

// Watch state for playlists (plan/archive/custom-playlist-sync step 8e,
// decisions 53 to 57): the watch index the rule engine reads, and "Remove
// items once watched". Kept apart from the rule engine, which imports this.

function text(value = "") {
  return String(value ?? "").trim();
}

const selectWatchRowsStmt = db.prepare(`
  SELECT media_type, tmdb_id, tvdb_id, imdb_id, season, episode, sync_action, sync_dispatch_telemetry,
    watch_provenance, watched_at, updated_at
  FROM watch_history WHERE media_type IN ('movie', 'episode')
`);

// One key per id a title has, such as movie:tmdb:123 or show:tvdb:456.
export function idKeys(prefix, ids, suffix = "") {
  return ["tmdb", "tvdb", "imdb"].filter((name) => text(ids[name])).map((name) => `${prefix}:${name}:${text(ids[name]).toLowerCase()}${suffix}`);
}

// What Plembfin's watch history says is watched now: per title (and per show
// episode), the latest row decides, and only rows Plembfin trusts as watches
// count (an unwatched row, or an unscoped library scan row, is not a watch).
export function readWatchIndex() {
  const latest = new Map();
  for (const row of selectWatchRowsStmt.all()) {
    const at = Date.parse(text(row.watched_at)) || Number(row.updated_at || 0);
    const ids = { tmdb: row.tmdb_id, tvdb: row.tvdb_id, imdb: row.imdb_id };
    const keys = row.media_type === "movie"
      ? idKeys("movie", ids)
      : idKeys("show", ids, `:${Number(row.season)}:${Number(row.episode)}`);
    const watched = isPlektTrackedWatchRow(row);
    for (const key of keys) {
      const previous = latest.get(key);
      if (!previous || at >= previous.at) latest.set(key, { at, watched });
    }
  }
  const watchedAt = new Map();
  // Per show key, the episodes watched now (specials left out), for Up Next.
  const showEpisodes = new Map();
  for (const [key, value] of latest) {
    if (!value.watched) continue;
    watchedAt.set(key, value.at);
    if (!key.startsWith("show:")) continue;
    const parts = key.split(":");
    const season = Number(parts.at(-2));
    const episode = Number(parts.at(-1));
    if (!(season > 0) || !(episode > 0)) continue;
    const showKey = parts.slice(0, -2).join(":");
    if (!showEpisodes.has(showKey)) showEpisodes.set(showKey, []);
    showEpisodes.get(showKey).push({ season, episode });
  }
  const latestAt = (keys) => {
    const times = keys.filter((key) => watchedAt.has(key)).map((key) => watchedAt.get(key));
    return times.length ? Math.max(...times) : null;
  };
  const episodeKeys = (showIds, season, episode) => idKeys("show", showIds, `:${Number(season)}:${Number(episode)}`);
  return {
    movie: (ids) => latestAt(idKeys("movie", ids)) !== null,
    episode: (showIds, season, episode) => latestAt(episodeKeys(showIds, season, episode)) !== null,
    movieWatchedAt: (ids) => latestAt(idKeys("movie", ids)),
    episodeWatchedAt: (showIds, season, episode) => latestAt(episodeKeys(showIds, season, episode)),
    // The furthest episode watched now (earlier gaps ignored, as Up Next),
    // or null when none is.
    furthestEpisode: (showIds) => {
      let furthest = null;
      for (const key of idKeys("show", showIds)) {
        for (const entry of showEpisodes.get(key) || []) {
          if (!furthest || entry.season > furthest.season || (entry.season === furthest.season && entry.episode > furthest.episode)) furthest = entry;
        }
      }
      return furthest ? { ...furthest } : null;
    },
  };
}

// --- Hand-offs and Remove items once watched --------------------------------

const selectHandoffsStmt = db.prepare("SELECT identity FROM personal_list_handoffs WHERE list_id = ?");
const insertHandoffStmt = db.prepare("INSERT INTO personal_list_handoffs (list_id, identity, handed_off_at) VALUES (?, ?, ?) ON CONFLICT(list_id, identity) DO NOTHING");
const selectListStmt = db.prepare("SELECT * FROM personal_lists WHERE id = ?");
const selectItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const deleteItemStmt = db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?");
const touchOrderStmt = db.prepare("UPDATE personal_lists SET order_updated_at = ?, updated_at = ? WHERE id = ?");
const selectRemoveWatchedListsStmt = db.prepare("SELECT id FROM personal_lists WHERE remove_watched = 1 AND deleted_at IS NULL ORDER BY id ASC");

// The id keys of titles this automatic playlist never adds back (decision 56).
export function readHandoffKeys(listId) {
  return new Set(selectHandoffsStmt.all(text(listId)).map((row) => row.identity));
}

function itemIds(item) {
  return { tmdb: item.tmdb_id, tvdb: item.tvdb_id, imdb: item.imdb_id };
}

// Removes the movies and episodes watched after they were added (decision
// 57), the same as removing them by hand, so the next push removes them from
// the apps. In an automatic playlist the title is handed off for good: a movie
// by its movie keys, an episode by its show's keys, so the show goes to Up Next
// (decision 56). Unlocked: callers hold the playlist lock.
export function applyRemoveWatched(listId, { index, now = Date.now() } = {}) {
  return transaction(() => {
    const list = selectListStmt.get(listId);
    if (!list || list.deleted_at || !list.remove_watched) return { removed: 0 };
    let removed = 0;
    for (const item of selectItemsStmt.all(listId)) {
      const ids = itemIds(item);
      let at = null;
      if (item.media_type === "movie") at = index.movieWatchedAt(ids);
      else if (item.media_type === "episode") at = index.episodeWatchedAt(ids, item.season, item.episode);
      if (at === null || !(at > Number(item.created_at || 0))) continue;
      deleteItemStmt.run(listId, item.media_key);
      removed += 1;
      if (list.rule_json) {
        for (const key of idKeys(item.media_type === "movie" ? "movie" : "show", ids)) insertHandoffStmt.run(listId, key, now);
      }
    }
    if (removed) touchOrderStmt.run(now, now, listId);
    return { removed };
  });
}

// Removing a title by hand from an automatic playlist hands it off for good,
// like a watched one (decision 65): a movie by its keys, an episode by its
// show's keys, taking every episode of that show with it. A show card (a
// stack of its episodes) is matched by the show's ids. Returns how many items
// left. Runs inside the caller's transaction.
export function handOffAutomaticPlaylistItem(listId, media = {}, now = Date.now()) {
  const items = selectItemsStmt.all(listId);
  const showCardKeys = media.media_type === "tv" ? idKeys("show", itemIds(media)) : [];
  const item = items.find((row) => row.media_key === media.media_key)
    || (showCardKeys.length ? items.find((row) => row.media_type === "episode" && idKeys("show", itemIds(row)).some((key) => showCardKeys.includes(key))) : null);
  if (!item) return 0;
  const keys = idKeys(item.media_type === "movie" ? "movie" : "show", itemIds(item));
  for (const key of keys) insertHandoffStmt.run(listId, key, now);
  const leaving = item.media_type === "episode"
    ? items.filter((row) => row.media_type === "episode" && idKeys("show", itemIds(row)).some((key) => keys.includes(key)))
    : [item];
  if (!leaving.some((row) => row.media_key === item.media_key)) leaving.push(item);
  for (const row of leaving) deleteItemStmt.run(listId, row.media_key);
  return leaving.length;
}

// True when a rule's row is a title this playlist has handed off.
export function isHandedOff(row, handoffs) {
  if (!handoffs?.size) return false;
  return idKeys(row.media_type === "movie" ? "movie" : "show", itemIds(row)).some((key) => handoffs.has(key));
}

export async function removeWatchedFromPlaylist(listId, { index = null, now = Date.now() } = {}) {
  const id = text(listId);
  const result = await withPlaylistLock(id, async () => applyRemoveWatched(id, { index: index || readWatchIndex(), now }));
  if (result.removed) bumpDataVersion();
  return { listId: id, ...result };
}

const selectMoveOnListsStmt = db.prepare("SELECT id FROM personal_lists WHERE rule_json IS NOT NULL AND remove_watched = 0 AND deleted_at IS NULL ORDER BY id ASC");

// Automatic playlists with the switch off holding an episode at or before the
// furthest one watched of its show, so a rule check now moves that show on to
// its next episode (decision 68). With the switch on, the watch hands the show
// off instead (decision 56).
export function automaticPlaylistsToMoveOn({ index = null } = {}) {
  const lists = selectMoveOnListsStmt.all();
  if (!lists.length) return [];
  const watch = index || readWatchIndex();
  return lists.map((row) => row.id).filter((listId) => selectItemsStmt.all(listId).some((item) => {
    if (item.media_type !== "episode") return false;
    const furthest = watch.furthestEpisode(itemIds(item));
    const season = Number(item.season);
    return Boolean(furthest) && (furthest.season > season || (furthest.season === season && furthest.episode >= Number(item.episode)));
  }));
}

// Every playlist with the switch on, from the scheduled pass. The watch index
// is read once, and only when some playlist has the switch on.
export async function removeWatchedPlaylistItems({ now = Date.now() } = {}) {
  const lists = selectRemoveWatchedListsStmt.all();
  if (!lists.length) return [];
  const index = readWatchIndex();
  const results = [];
  for (const { id } of lists) results.push(await removeWatchedFromPlaylist(id, { index, now }));
  return results;
}
