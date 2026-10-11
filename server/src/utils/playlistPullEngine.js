import { bumpDataVersion, db, transaction } from "../db.js";
import { loadMediaConfig } from "./configStore.js";
import { getCanonicalPosterUrl } from "./mediaArtwork.js";
import { normalizeProviderIds, parsePlexGuids } from "./parsers.js";
import { personalMediaKey } from "./personalMediaKey.js";
import { playlistAwaitsShowConversion, playlistLibraryDeps, relinkLedger, runPlaylistPush, withPlaylistLock } from "./playlistPushEngine.js";
import { providerPlaylistClient } from "./providerPlaylists.js";
import { configuredProvider } from "./upNextLibraryLookup.js";

// Pull half of the Plembfin playlist sync (plan/archive/custom-playlist-sync/plan.md,
// phase 4). For each app a playlist targets, it reads the app playlist and
// diffs it against the entry ledger (what Plembfin last wrote or saw), never
// against Plembfin's own items, so Plembfin's writes are not re-imported.
//
// Safety rules (accuracy over completeness):
// - A failed read skips the app for the pass. A ledger entry must be absent on
//   two consecutive reads before its removal is considered (Emby once returned
//   a short list with a 200). An emptied app playlist follows the same rule, so
//   a wipe of 3 or more entries is held by the mass-removal guard below.
// - A missing entry is a user removal only when the app's library still holds
//   the same item; if the media left the library, Plembfin keeps the item.
// - App-side deletion needs a definite not-found from fetchPlaylist on two
//   consecutive scheduled passes (the items read is a 500 on Emby, not a 404).
// - Many removals in one pass, or deletions seen on several playlists of one
//   app at once, are held for confirmation instead of applied.

const REMOVAL_CONFIRM_READS = 2;
const DELETE_CONFIRM_PASSES = 2;
const MASS_REMOVAL_MIN = 3;

function text(value = "") {
  return String(value ?? "").trim();
}

function errorText(error) {
  return text(error?.message || error) || "Unknown error";
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

// Describes the library item behind an app-added entry as a playlist item
// ({ media_type: "movie" | "episode", ... }), or null for anything else.
// Throws when the app could not answer.
async function identifyEntry(provider, config, entry) {
  const client = providerPlaylistClient(provider);
  const providerConfig = config[provider];
  const item = await client.fetchLibraryItem(providerConfig, entry.itemId);
  if (!item) return null;
  const plex = provider === "plex";
  const type = text(plex ? item.type : item.Type).toLowerCase();
  const ids = plex ? parsePlexGuids(item) : normalizeProviderIds(item.ProviderIds);
  const title = text(plex ? item.title : item.Name);
  const releaseDate = text(plex ? item.originallyAvailableAt : item.PremiereDate).slice(0, 10);
  if (type === "movie") {
    return { media_type: "movie", title, tmdb_id: ids.tmdb || "", tvdb_id: ids.tvdb || "", imdb_id: ids.imdb || "", release_date: releaseDate };
  }
  if (type !== "episode") return null;
  const season = integerOrNull(plex ? item.parentIndex : item.ParentIndexNumber);
  const episode = integerOrNull(plex ? item.index : item.IndexNumber);
  if (season === null || episode === null) return null;
  const seriesId = text(plex ? item.grandparentRatingKey : item.SeriesId);
  const series = seriesId ? await client.fetchLibraryItem(providerConfig, seriesId) : null;
  const showIds = series ? (plex ? parsePlexGuids(series) : normalizeProviderIds(series.ProviderIds)) : {};
  return {
    media_type: "episode",
    title,
    show_title: text(plex ? item.grandparentTitle : item.SeriesName) || text(plex ? series?.title : series?.Name),
    season,
    episode,
    show_tmdb_id: showIds.tmdb || "",
    show_tvdb_id: showIds.tvdb || "",
    show_imdb_id: showIds.imdb || "",
    episode_tmdb_id: ids.tmdb || "",
    episode_tvdb_id: ids.tvdb || "",
    episode_imdb_id: ids.imdb || "",
    release_date: releaseDate,
  };
}

export const playlistPullDeps = Object.freeze({
  ...playlistLibraryDeps,
  identifyEntry,
});

const selectListStmt = db.prepare("SELECT * FROM personal_lists WHERE id = ?");
const selectItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const selectTargetsStmt = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? ORDER BY provider ASC");
const selectLedgerStmt = db.prepare("SELECT * FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ?");
const selectHoldStmt = db.prepare("SELECT * FROM personal_list_held_changes WHERE list_id = ? AND provider = ? AND kind = ?");
// A deleted playlist stays in the pass while an app still holds its copy, so a
// failed app delete is retried.
const selectTargetedListsStmt = db.prepare(`
  SELECT DISTINCT t.list_id FROM personal_list_targets t
  JOIN personal_lists l ON l.id = t.list_id
  WHERE l.deleted_at IS NULL OR t.remote_playlist_id IS NOT NULL
  ORDER BY t.list_id ASC
`);
// Playlists of one app currently reading as not found, this one included.
const countNotFoundTargetsStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM personal_list_targets t
  JOIN personal_lists l ON l.id = t.list_id
  WHERE t.provider = ? AND t.desired_state = 'present' AND t.remote_playlist_id IS NOT NULL
    AND t.not_found_passes > 0 AND l.deleted_at IS NULL
`);
const selectNameClashStmt = db.prepare("SELECT id FROM personal_lists WHERE name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL");
const selectPositionStmt = db.prepare("SELECT position FROM personal_list_items WHERE list_id = ? AND media_key = ?");

const markNotFoundStmt = db.prepare(`
  UPDATE personal_list_targets
  SET not_found_passes = ?, missing_since = COALESCE(missing_since, ?), updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const clearNotFoundStmt = db.prepare(`
  UPDATE personal_list_targets SET not_found_passes = 0, missing_since = NULL, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const markPulledStmt = db.prepare(`
  UPDATE personal_list_targets SET last_error = NULL, last_error_at = NULL, unidentified_count = ?, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const markErrorStmt = db.prepare(`
  UPDATE personal_list_targets SET last_error = ?, last_error_at = ?, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const saveRemoteNameStmt = db.prepare("UPDATE personal_list_targets SET remote_name = ?, updated_at = ? WHERE list_id = ? AND provider = ?");
const renameListStmt = db.prepare("UPDATE personal_lists SET name = ?, updated_at = ? WHERE id = ? AND name = ?");
const orderListStmt = db.prepare("UPDATE personal_lists SET order_updated_at = ?, updated_at = ? WHERE id = ?");
const setPositionStmt = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
const touchListStmt = db.prepare("UPDATE personal_lists SET updated_at = ? WHERE id = ?");
const softDeleteListStmt = db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL");
const resetTargetStmt = db.prepare(`
  UPDATE personal_list_targets
  SET remote_playlist_id = NULL, remote_name = NULL, not_found_passes = 0, missing_since = NULL, unidentified_count = 0, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);

const seenLedgerStmt = db.prepare(`
  UPDATE personal_list_entry_ledger SET remote_position = ?, last_seen_at = ?, absent_reads = 0
  WHERE list_id = ? AND provider = ? AND remote_entry_id = ?
`);
const absentLedgerStmt = db.prepare(`
  UPDATE personal_list_entry_ledger SET absent_reads = ?
  WHERE list_id = ? AND provider = ? AND remote_entry_id = ?
`);
const deleteLedgerEntryStmt = db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ? AND remote_entry_id = ?");
const deleteLedgerStmt = db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ?");
const insertLedgerStmt = db.prepare(`
  INSERT INTO personal_list_entry_ledger
    (list_id, provider, remote_entry_id, provider_item_id, media_key, season, episode, remote_position, origin, first_seen_at, last_seen_at, absent_reads)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provider', ?, ?, 0)
  ON CONFLICT(list_id, provider, remote_entry_id) DO NOTHING
`);

const deleteItemStmt = db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?");
// An untyped playlist (empty before playlists had a type) takes the type of
// its first item. An app-side add of the other type imports anyway.
const setKindStmt = db.prepare("UPDATE personal_lists SET kind = ? WHERE id = ? AND kind IS NULL");
const shiftPositionsStmt = db.prepare("UPDATE personal_list_items SET position = position + 1 WHERE list_id = ? AND position >= ?");
const insertItemStmt = db.prepare(`
  INSERT INTO personal_list_items
    (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date,
     show_title, season, episode, episode_tmdb_id, episode_tvdb_id, episode_imdb_id, position, created_at, updated_at)
  VALUES (@list_id, @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, '', @release_date,
     @show_title, @season, @episode, @episode_tmdb_id, @episode_tvdb_id, @episode_imdb_id, @position, @now, @now)
  ON CONFLICT(list_id, media_key) DO NOTHING
`);

const upsertHoldStmt = db.prepare(`
  INSERT INTO personal_list_held_changes (list_id, provider, kind, entry_ids, change_count, reason, held_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_id, provider, kind) DO UPDATE SET
    entry_ids = excluded.entry_ids, change_count = excluded.change_count, reason = excluded.reason
`);
const deleteHoldStmt = db.prepare("DELETE FROM personal_list_held_changes WHERE list_id = ? AND provider = ? AND kind = ?");
const confirmHoldStmt = db.prepare("UPDATE personal_list_held_changes SET confirmed_at = ? WHERE list_id = ? AND provider = ? AND kind = ?");

// Finds the Plembfin item an app entry stands for.
function sameId(left, right) {
  return Boolean(text(left) && text(left) === text(right));
}

function matchItem(items, media) {
  if (media.media_type === "movie") {
    return items.find((row) => row.media_type === "movie"
      && (sameId(row.tmdb_id, media.tmdb_id) || sameId(row.imdb_id, media.imdb_id) || sameId(row.tvdb_id, media.tvdb_id))) || null;
  }
  const sameShow = (row) => sameId(row.tmdb_id, media.show_tmdb_id) || sameId(row.tvdb_id, media.show_tvdb_id) || sameId(row.imdb_id, media.show_imdb_id);
  return items.find((row) => row.media_type === "episode" && Number(row.season) === media.season && Number(row.episode) === media.episode
      && (sameShow(row) || (!row.tmdb_id && !row.tvdb_id && !row.imdb_id && text(row.show_title).toLowerCase() === text(media.show_title).toLowerCase())))
    || null;
}

function newItemRow(listId, media) {
  const isEpisode = media.media_type === "episode";
  const row = {
    list_id: listId,
    media_type: media.media_type,
    title: text(media.title) || text(media.show_title) || "Untitled",
    tmdb_id: isEpisode ? media.show_tmdb_id : media.tmdb_id,
    tvdb_id: isEpisode ? media.show_tvdb_id : media.tvdb_id,
    imdb_id: isEpisode ? media.show_imdb_id : media.imdb_id,
    release_date: media.release_date || "",
    show_title: isEpisode ? media.show_title : null,
    season: isEpisode ? media.season : null,
    episode: isEpisode ? media.episode : null,
    episode_tmdb_id: isEpisode ? media.episode_tmdb_id || null : null,
    episode_tvdb_id: isEpisode ? media.episode_tvdb_id || null : null,
    episode_imdb_id: isEpisode ? media.episode_imdb_id || null : null,
  };
  row.media_key = personalMediaKey(isEpisode ? media : row);
  let poster = "";
  if (!isEpisode) {
    try { poster = getCanonicalPosterUrl({ ...row }) || ""; } catch { poster = ""; }
  }
  row.poster_url = poster;
  return row;
}

// Decides each ledger entry that stayed absent long enough: "remove" (the
// library still holds it, so the user removed it), "left" (the media left the
// library: Plembfin keeps the item), "stale" (no Plembfin item behind it any
// more), or "unknown" (the library could not answer; decided on a later pass).
async function decideRemovals(provider, config, candidates, itemsByKey, deps) {
  const decisions = [];
  for (const ledgerRow of candidates) {
    const item = ledgerRow.media_key ? itemsByKey.get(ledgerRow.media_key) : null;
    if (!item) {
      decisions.push({ ledgerRow, action: "stale" });
      continue;
    }
    try {
      const providerItemId = text(await deps.resolveItemId(provider, config, item));
      decisions.push({ ledgerRow, item, action: providerItemId === ledgerRow.provider_item_id ? "remove" : "left" });
    } catch (error) {
      decisions.push({ ledgerRow, item, action: "unknown", reason: errorText(error) });
    }
  }
  return decisions;
}

function uniqueKeys(keys) {
  return [...new Set(keys.filter(Boolean))];
}

// The playlist's items in the app's current order, when that order differs
// from the one the ledger recorded; otherwise null. Only entries Plembfin
// already knows count, so additions and removals are not a reorder.
function appReorder(ledger, entries, positions) {
  const ledgerByEntry = new Map(ledger.map((row) => [row.remote_entry_id, row]));
  const recorded = uniqueKeys(ledger
    .filter((row) => positions.has(row.remote_entry_id))
    .sort((a, b) => (a.remote_position ?? Infinity) - (b.remote_position ?? Infinity))
    .map((row) => row.media_key));
  const current = uniqueKeys(entries.map((entry) => ledgerByEntry.get(entry.entryId)?.media_key));
  return current.length > 1 && current.some((key, index) => key !== recorded[index]) ? current : null;
}

// Moves the items the app holds into the app's order, using the slots those
// items already occupy, so items missing from the app keep their places.
function applyAppOrder(listId, appKeys) {
  const items = selectItemsStmt.all(listId).map((row) => row.media_key);
  const inApp = new Set(appKeys.filter((key) => items.includes(key)));
  const queue = appKeys.filter((key) => inApp.has(key));
  const next = items.map((key) => (inApp.has(key) ? queue.shift() : key));
  if (next.every((key, index) => key === items[index])) return false;
  next.forEach((key, index) => setPositionStmt.run(index, listId, key));
  return true;
}

// Returns { entry, media } per app entry the ledger does not know, or
// { entry, skip } when it cannot be identified.
async function identifyAdditions(provider, config, entries, deps) {
  const additions = [];
  for (const entry of entries) {
    try {
      const media = await deps.identifyEntry(provider, config, entry);
      additions.push(media ? { entry, media } : { entry, skip: "unsupported" });
    } catch (error) {
      additions.push({ entry, skip: errorText(error) });
    }
  }
  return additions;
}

async function pullTarget(list, target, config, deps, { countNotFound }) {
  const { provider } = target;
  const client = deps.client(provider);
  const providerConfig = config[provider];
  const playlistId = text(target.remote_playlist_id);
  if (!playlistId) return { provider, status: "skipped", reason: "No app playlist yet." };

  const playlist = await client.fetchPlaylist(providerConfig, playlistId);
  if (!playlist) {
    // Only scheduled passes count toward a deletion, so quick successive
    // syncs after Plembfin edits cannot reach the threshold in seconds.
    if (!countNotFound) return { provider, status: "skipped", reason: "The app playlist was not found." };
    const now = deps.now();
    const passes = Number(target.not_found_passes || 0) + 1;
    markNotFoundStmt.run(passes, now, now, list.id, provider);
    if (passes < DELETE_CONFIRM_PASSES) return { provider, status: "not_found", passes };
    const hold = selectHoldStmt.get(list.id, provider, "delete");
    const alsoMissing = countNotFoundTargetsStmt.get(provider).count;
    if (alsoMissing > 1 && !hold?.confirmed_at) {
      upsertHoldStmt.run(list.id, provider, "delete", null, 1, `${alsoMissing} ${provider} playlists read as not found in the same pass.`, now);
      return { provider, status: "held", kind: "delete", passes };
    }
    return { provider, status: "deleted_in_app", passes };
  }

  const now = deps.now();
  if (Number(target.not_found_passes || 0) > 0) clearNotFoundStmt.run(now, list.id, provider);
  deleteHoldStmt.run(list.id, provider, "delete");

  // Rename: the most recent rename wins. The apps report no rename time, so an
  // app rename counts from when Plembfin first sees it, which is always after
  // a Plembfin rename made since the last sync: the app name wins either way.
  // Only a clash with another Plembfin playlist's name keeps the Plembfin name
  // (the push renames the app back). The name guard skips the import when a
  // Plembfin rename landed while this pull ran.
  let renamed = false;
  const remoteTitle = text(playlist.title);
  const remoteName = target.remote_name ?? null;
  if (remoteTitle && remoteTitle !== remoteName) {
    transaction(() => {
      if (remoteTitle !== list.name && !selectNameClashStmt.get(remoteTitle, list.id)
        && renameListStmt.run(remoteTitle, now, list.id, list.name).changes) {
        list.name = remoteTitle;
        renamed = true;
      }
      saveRemoteNameStmt.run(remoteTitle, now, list.id, provider);
    });
  }

  // An automatic playlist is synced one way out (decision 40): app-side adds,
  // removals, and reorders are not imported; the push overwrites them. The
  // rename above (decision 44) and deletion detection (decision 10) still apply.
  if (list.rule_json) {
    markPulledStmt.run(0, now, list.id, provider);
    return { provider, status: "pulled", oneWay: true, renamed, changed: renamed };
  }

  const entries = await client.fetchPlaylistItems(providerConfig, playlistId);
  const ledger = relinkLedger(list.id, provider, selectLedgerStmt.all(list.id, provider), entries);
  const ledgerByEntry = new Map(ledger.map((row) => [row.remote_entry_id, row]));
  const positions = new Map(entries.map((entry, index) => [entry.entryId, index]));
  const items = selectItemsStmt.all(list.id);
  const itemsByKey = new Map(items.map((row) => [row.media_key, row]));

  // An emptied playlist counts like any other removal: two reads, then the
  // mass-removal guard holds a wipe of 3 or more entries.
  const emptyRead = entries.length === 0 && ledger.length > 0;
  const absent = ledger.filter((row) => !positions.has(row.remote_entry_id));
  // App order as the ledger last recorded it, read before this pass updates it.
  const reorder = appReorder(ledger, entries, positions);
  const candidates = absent.filter((row) => Number(row.absent_reads || 0) + 1 >= REMOVAL_CONFIRM_READS);
  const decisions = await decideRemovals(provider, config, candidates, itemsByKey, deps);
  const additions = await identifyAdditions(provider, config, entries.filter((entry) => !ledgerByEntry.has(entry.entryId)), deps);

  const userRemovals = decisions.filter((decision) => decision.action === "remove");
  const removalHold = selectHoldStmt.get(list.id, provider, "removals");
  const mass = userRemovals.length >= MASS_REMOVAL_MIN && userRemovals.length * 2 > ledger.length;
  const holdRemovals = mass && !removalHold?.confirmed_at;

  const result = {
    provider,
    status: "pulled",
    renamed,
    reordered: false,
    added: 0,
    linked: 0,
    removed: 0,
    leftLibrary: 0,
    pendingRemovals: absent.length - candidates.length,
    undecided: decisions.filter((decision) => decision.action === "unknown").length,
    unidentified: additions.filter((addition) => addition.skip).length,
    held: holdRemovals ? userRemovals.length : 0,
    emptyRead,
  };
  let changed = renamed;

  transaction(() => {
    const at = deps.now();
    for (const entry of entries) {
      if (ledgerByEntry.has(entry.entryId)) seenLedgerStmt.run(positions.get(entry.entryId), at, list.id, provider, entry.entryId);
    }
    const heldIds = new Set(holdRemovals ? userRemovals.map((decision) => decision.ledgerRow.remote_entry_id) : []);
    const decided = new Set(decisions.filter((decision) => decision.action !== "unknown" && !heldIds.has(decision.ledgerRow.remote_entry_id))
      .map((decision) => decision.ledgerRow.remote_entry_id));
    for (const row of absent) {
      if (!decided.has(row.remote_entry_id)) absentLedgerStmt.run(Number(row.absent_reads || 0) + 1, list.id, provider, row.remote_entry_id);
    }

    if (holdRemovals) {
      upsertHoldStmt.run(list.id, provider, "removals", JSON.stringify([...heldIds]), heldIds.size,
        `${heldIds.size} of ${ledger.length} entries were removed from the ${provider} playlist in one pass.`, at);
    } else if (removalHold) {
      deleteHoldStmt.run(list.id, provider, "removals");
    }

    for (const decision of decisions) {
      const { ledgerRow, action } = decision;
      if (action === "unknown" || heldIds.has(ledgerRow.remote_entry_id)) continue;
      deleteLedgerEntryStmt.run(list.id, provider, ledgerRow.remote_entry_id);
      if (action === "left") result.leftLibrary += 1;
      if (action === "remove" && itemsByKey.has(decision.item.media_key)) {
        deleteItemStmt.run(list.id, decision.item.media_key);
        itemsByKey.delete(decision.item.media_key);
        result.removed += 1;
        changed = true;
      }
    }

    // Additions, placed after the nearest preceding entry Plembfin knows so
    // the push does not have to move them.
    const additionByEntry = new Map(additions.map((addition) => [addition.entry.entryId, addition]));
    const keyByEntry = new Map(ledger.filter((row) => row.media_key).map((row) => [row.remote_entry_id, row.media_key]));
    let previousKey = null;
    for (const entry of entries) {
      const addition = additionByEntry.get(entry.entryId);
      if (addition?.media) {
        const { media } = addition;
        const current = [...itemsByKey.values()];
        const match = matchItem(current, media);
        let key;
        let season = null;
        let episode = null;
        if (match) {
          key = match.media_key;
          season = match.season ?? null;
          episode = match.episode ?? null;
          result.linked += 1;
        } else {
          const row = newItemRow(list.id, media);
          const previousPosition = previousKey ? selectPositionStmt.get(list.id, previousKey)?.position : null;
          const position = previousPosition === null || previousPosition === undefined ? 0 : Number(previousPosition) + 1;
          shiftPositionsStmt.run(list.id, position);
          insertItemStmt.run({ ...row, position, now: at });
          if (!list.kind && setKindStmt.run(row.media_type === "movie" ? "movie" : "tv", list.id).changes) {
            list.kind = row.media_type === "movie" ? "movie" : "tv";
          }
          itemsByKey.set(row.media_key, { ...row, position });
          key = row.media_key;
          season = row.season;
          episode = row.episode;
          result.added += 1;
          changed = true;
        }
        insertLedgerStmt.run(list.id, provider, entry.entryId, entry.itemId, key, season, episode, positions.get(entry.entryId), at, at);
        keyByEntry.set(entry.entryId, key);
      }
      const key = keyByEntry.get(entry.entryId);
      if (key && itemsByKey.has(key)) previousKey = key;
    }

    // An app reorder is imported only when Plembfin's order did not change
    // since the last successful push to this app; otherwise Plembfin's order
    // wins and the push moves the app entries back. Importing marks the order
    // changed, so a second app reordered in the same pass is moved back.
    const plektReordered = Number(list.order_updated_at || 0) > Number(target.last_synced_at || 0);
    if (reorder && !plektReordered && !target.last_error && applyAppOrder(list.id, reorder)) {
      orderListStmt.run(at, at, list.id);
      list.order_updated_at = at;
      result.reordered = true;
      changed = true;
    }

    if (changed) touchListStmt.run(at, list.id);
    markPulledStmt.run(result.unidentified, at, list.id, provider);
  });
  if (result.held) result.status = "held";
  result.changed = changed;
  return result;
}

// Unlocked: callers hold withPlaylistLock for the list.
export async function runPlaylistPull(listId, { config, deps, countNotFound = false }) {
  const list = selectListStmt.get(listId);
  if (!list || list.deleted_at) return { listId, providers: [] };
  if (playlistAwaitsShowConversion(list)) return { listId, providers: [], skipped: "show_conversion" };
  const providers = [];
  let changed = false;
  for (const target of selectTargetsStmt.all(listId)) {
    const { provider } = target;
    if (target.desired_state !== "present") continue;
    if (!configuredProvider(config, provider)) {
      providers.push({ provider, status: "skipped", reason: "not configured" });
      continue;
    }
    try {
      const result = await pullTarget(list, target, config, deps, { countNotFound });
      providers.push(result);
      if (result.changed) changed = true;
      if (result.status === "deleted_in_app") {
        // Recently deleted; the push that follows deletes the other apps' playlists.
        const now = deps.now();
        transaction(() => {
          softDeleteListStmt.run(now, provider, now, list.id);
          db.prepare("DELETE FROM personal_list_held_changes WHERE list_id = ?").run(list.id);
        });
        changed = true;
        break;
      }
    } catch (error) {
      const message = errorText(error);
      markErrorStmt.run(message, deps.now(), deps.now(), listId, provider);
      console.error(`[playlists] Pull of playlist ${listId} from ${provider} failed: ${message}`);
      providers.push({ provider, status: "error", error: message });
    }
  }
  if (changed) bumpDataVersion();
  return { listId, providers };
}

function resolveDeps(deps) {
  return { ...playlistPullDeps, ...deps };
}

export async function pullPlaylist(listId, { config = null, deps = {}, countNotFound = false } = {}) {
  return withPlaylistLock(listId, async (id) => runPlaylistPull(id, {
    config: config || await loadMediaConfig(),
    deps: resolveDeps(deps),
    countNotFound,
  }));
}

// Pull, then push, under one lock: app-side changes are imported before
// Plembfin's state is written back out. `countNotFound` is for scheduled passes.
export async function syncPlaylist(listId, { config = null, deps = {}, countNotFound = false } = {}) {
  return withPlaylistLock(listId, async (id) => {
    const resolvedConfig = config || await loadMediaConfig();
    const resolvedDeps = resolveDeps(deps);
    const pull = await runPlaylistPull(id, { config: resolvedConfig, deps: resolvedDeps, countNotFound });
    const push = await runPlaylistPush(id, { config: resolvedConfig, deps: resolvedDeps });
    return { listId: id, pull: pull.providers, push: push.providers };
  });
}

export async function syncAllPlaylists({ config = null, deps = {} } = {}) {
  const resolvedConfig = config || await loadMediaConfig();
  const results = [];
  for (const { list_id: listId } of selectTargetedListsStmt.all()) {
    results.push(await syncPlaylist(listId, { config: resolvedConfig, deps, countNotFound: true }));
  }
  return results;
}

// Applies a held change on the next pull. For a deletion, that pull counts
// as a scheduled pass so the confirmation can conclude it. `sync: false`
// leaves the work to the worker's next scheduled pass (web-only processes).
export async function confirmHeldPlaylistChange(listId, provider, kind, { sync = true, ...options } = {}) {
  const result = confirmHoldStmt.run(Date.now(), text(listId), text(provider), text(kind));
  if (!result.changes) return { listId, status: "not_found" };
  if (!sync) return { listId, status: "confirmed" };
  return syncPlaylist(listId, { ...options, countNotFound: kind === "delete" });
}

// Keeps Plembfin's state instead. Held removals are forgotten from the ledger
// so the push adds them back; a held deletion clears the remote id so the push
// recreates the app playlist.
export async function discardHeldPlaylistChange(listId, provider, kind, { sync = true, ...options } = {}) {
  const id = text(listId);
  const hold = selectHoldStmt.get(id, text(provider), text(kind));
  if (!hold) return { listId: id, status: "not_found" };
  const now = Date.now();
  transaction(() => {
    if (hold.kind === "removals") {
      let entryIds = [];
      try { entryIds = JSON.parse(hold.entry_ids || "[]"); } catch { entryIds = []; }
      for (const entryId of entryIds) deleteLedgerEntryStmt.run(id, hold.provider, entryId);
    } else {
      deleteLedgerStmt.run(id, hold.provider);
      resetTargetStmt.run(now, id, hold.provider);
    }
    deleteHoldStmt.run(id, hold.provider, hold.kind);
  });
  if (!sync) return { listId: id, status: "discarded" };
  return syncPlaylist(id, options);
}
