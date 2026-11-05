import { db, transaction } from "../db.js";
import { loadMediaConfig } from "./configStore.js";
import { runWithConcurrency } from "./concurrency.js";
import { providerPlaylistClient, reorderProviderPlaylist } from "./providerPlaylists.js";
import { configuredProvider, resolveUpNextProviderItemId } from "./upNextLibraryLookup.js";

// Push half of the Plembfin playlist sync (plan/archive/custom-playlist-sync/plan.md,
// phase 3). For each app a playlist targets, it resolves every item (a movie
// or a single episode) in that app's library and makes the app playlist match
// Plembfin's order, recording what it wrote in the entry ledger and each
// item's availability. A playlist still holding a show item waits until
// playlistShowConversion.js has turned it into episodes.
//
// Only Plembfin's own wishes remove anything. An entry is removed when its item
// left the Plembfin playlist or it duplicates
// another entry; never because a lookup failed or came back empty (accuracy
// over completeness). A remote entry the ledger does not know was added in the
// app and is left for the pull pass to import. A ledger entry that vanished
// from the app playlist is a possible app-side removal: its item is not
// re-added until the pull pass has decided. The push never reverts an app-side
// rename; it renames only when the Plembfin name changed since it last wrote.

const ITEM_LOOKUP_CONCURRENCY = 4;

function text(value = "") {
  return String(value ?? "").trim();
}

function errorText(error) {
  return text(error?.message || error) || "Unknown error";
}

// Episode items keep the show ids in tmdb_id/tvdb_id/imdb_id.
function itemLookup(row) {
  if (row.media_type === "episode") {
    return {
      media_type: "episode",
      title: row.show_title || row.title,
      show_title: row.show_title || row.title,
      show_tmdb_id: row.tmdb_id,
      show_tvdb_id: row.tvdb_id,
      show_imdb_id: row.imdb_id,
      season: row.season,
      episode: row.episode,
      episode_tmdb_id: row.episode_tmdb_id,
      episode_tvdb_id: row.episode_tvdb_id,
      episode_imdb_id: row.episode_imdb_id,
    };
  }
  return { media_type: "movie", title: row.title, tmdb_id: row.tmdb_id, tvdb_id: row.tvdb_id, imdb_id: row.imdb_id };
}

// Library reads shared with the pull pass (playlistPullEngine.js).
export const playlistLibraryDeps = Object.freeze({
  client: providerPlaylistClient,
  // Returns the provider item id, or "" when the library does not hold it.
  // Throws when the provider could not answer.
  async resolveItemId(provider, config, row) {
    const result = await resolveUpNextProviderItemId(provider, config[provider], itemLookup(row));
    return text(result?.providerItemId);
  },
  now: () => Date.now(),
});

const selectListStmt = db.prepare("SELECT * FROM personal_lists WHERE id = ?");
const selectItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const hasShowItemStmt = db.prepare("SELECT 1 FROM personal_list_items WHERE list_id = ? AND media_type = 'tv' LIMIT 1");

// A show item is waiting to become episodes; syncing before that would push
// nothing for it and, on the pull side, read its entries as unknown.
export function playlistAwaitsShowConversion(list) {
  return Boolean(list && !list.deleted_at && hasShowItemStmt.get(list.id));
}
const selectTargetsStmt = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? ORDER BY provider ASC");
const selectLedgerStmt = db.prepare("SELECT * FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ?");
const selectTargetedListsStmt = db.prepare("SELECT DISTINCT list_id FROM personal_list_targets ORDER BY list_id ASC");
const saveRemoteIdStmt = db.prepare(`
  UPDATE personal_list_targets SET remote_playlist_id = ?, remote_name = ?, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const markSyncedStmt = db.prepare(`
  UPDATE personal_list_targets
  SET remote_playlist_id = ?, remote_name = ?, last_synced_at = ?, last_error = NULL, last_error_at = NULL, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const markErrorStmt = db.prepare(`
  UPDATE personal_list_targets SET last_error = ?, last_error_at = ?, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const deleteTargetStmt = db.prepare("DELETE FROM personal_list_targets WHERE list_id = ? AND provider = ?");
const deleteLedgerEntryStmt = db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ? AND remote_entry_id = ?");
const deleteLedgerStmt = db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ?");
const upsertLedgerStmt = db.prepare(`
  INSERT INTO personal_list_entry_ledger
    (list_id, provider, remote_entry_id, provider_item_id, media_key, season, episode, remote_position, origin, first_seen_at, last_seen_at, absent_reads)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(list_id, provider, remote_entry_id) DO UPDATE SET
    provider_item_id = excluded.provider_item_id,
    media_key = excluded.media_key,
    season = excluded.season,
    episode = excluded.episode,
    remote_position = excluded.remote_position,
    last_seen_at = excluded.last_seen_at,
    absent_reads = 0
`);
const insertLedgerRowStmt = db.prepare(`
  INSERT INTO personal_list_entry_ledger
    (list_id, provider, remote_entry_id, provider_item_id, media_key, season, episode, remote_position, origin, first_seen_at, last_seen_at, absent_reads)
  VALUES (@list_id, @provider, @remote_entry_id, @provider_item_id, @media_key, @season, @episode, @remote_position, @origin, @first_seen_at, @last_seen_at, @absent_reads)
`);

// Emby renumbers playlist entry ids after some edits (phase 6, 2026-09-25: after
// a remove, an add, and a move, four entries came back as ids 21 to 24 in
// playlist order, so id 21 now held another film). An entry id therefore
// identifies an entry only while it still holds the same library item. Before
// either sync half diffs, each ledger row is re-keyed to the app entry holding
// its library item (the push keeps one entry per item). A row whose old id now
// belongs to another item gets an id no entry can have, so it reads as absent
// rather than as that other item. Returns the relinked ledger.
export function relinkLedger(listId, provider, ledger, entries) {
  const byEntry = new Map(ledger.map((row) => [row.remote_entry_id, row]));
  const assigned = new Map();
  const unmatched = [];
  for (const entry of entries) {
    const row = byEntry.get(entry.entryId);
    if (row && row.provider_item_id === entry.itemId) assigned.set(row, entry.entryId);
    else unmatched.push(entry);
  }
  for (const entry of unmatched) {
    const row = ledger.find((candidate) => !assigned.has(candidate) && candidate.provider_item_id === entry.itemId);
    if (row) assigned.set(row, entry.entryId);
  }
  const liveIds = new Set(entries.map((entry) => entry.entryId));
  const changed = [];
  const relinked = ledger.map((row) => {
    let entryId = assigned.get(row) ?? row.remote_entry_id;
    if (!assigned.has(row) && liveIds.has(entryId)) entryId = `gone:${row.remote_entry_id}:${row.provider_item_id}`;
    if (entryId === row.remote_entry_id) return row;
    const next = { ...row, remote_entry_id: entryId };
    changed.push({ from: row.remote_entry_id, row: next });
    return next;
  });
  if (changed.length) {
    transaction(() => {
      for (const { from } of changed) deleteLedgerEntryStmt.run(listId, provider, from);
      for (const { row } of changed) insertLedgerRowStmt.run({ ...row, list_id: listId, provider });
    });
  }
  return relinked;
}

const upsertAvailabilityStmt = db.prepare(`
  INSERT INTO personal_list_item_availability (list_id, media_key, provider, status, episode_count, reason, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_id, media_key, provider) DO UPDATE SET
    status = excluded.status,
    episode_count = excluded.episode_count,
    reason = excluded.reason,
    checked_at = excluded.checked_at
`);
const deleteAvailabilityStmt = db.prepare("DELETE FROM personal_list_item_availability WHERE list_id = ? AND provider = ?");

// Resolves every item in one provider library. Each group is { row, state,
// entries, reason } where state is "resolved", "missing" (a clean library
// answer), or "unknown" (the provider could not answer).
async function resolveGroups(provider, config, items, deps) {
  const groups = Array(items.length);
  await runWithConcurrency(items, async (row, index) => {
    try {
      const providerItemId = text(await deps.resolveItemId(provider, config, row));
      groups[index] = providerItemId
        ? { row, state: "resolved", entries: [{ providerItemId, season: row.season ?? null, episode: row.episode ?? null }] }
        : { row, state: "missing", entries: [], reason: "Not found in the library." };
    } catch (error) {
      groups[index] = { row, state: "unknown", entries: [], reason: errorText(error) };
    }
  }, ITEM_LOOKUP_CONCURRENCY);
  return groups;
}

// Builds the wanted entry sequence against the current remote entries.
// Returns { desired, removeEntryIds } where each desired entry is
// { group, providerItemId, season, episode, entryId?, origin? }; entries with
// no entryId must be added.
// `oneWay` (automatic playlists, decision 40): the app's own edits are
// overwritten, so a vanished entry is re-added at once and entries the ledger
// does not know are removed unless adopted as a wanted item.
function planEntries(groups, entries, ledger, { oneWay = false } = {}) {
  const ledgerByEntry = new Map(ledger.map((row) => [row.remote_entry_id, row]));
  const remoteEntryIds = new Set(entries.map((entry) => entry.entryId));
  const vanishedItemIds = new Set(ledger.filter((row) => !remoteEntryIds.has(row.remote_entry_id)).map((row) => row.provider_item_id));
  const knownByKey = new Map();
  for (const entry of entries) {
    const ledgerRow = ledgerByEntry.get(entry.entryId);
    if (!ledgerRow?.media_key) continue;
    if (!knownByKey.has(ledgerRow.media_key)) knownByKey.set(ledgerRow.media_key, []);
    knownByKey.get(ledgerRow.media_key).push({ entry, ledgerRow });
  }

  const claimed = new Set();
  const seenItemIds = new Set();
  const takeEntry = (providerItemId, known) => {
    const match = entries.find((entry) => !claimed.has(entry.entryId) && entry.itemId === providerItemId && known === ledgerByEntry.has(entry.entryId));
    if (match) claimed.add(match.entryId);
    return match || null;
  };

  const desired = [];
  for (const group of groups) {
    const { row } = group;
    const wanted = [...group.entries];
    // A known entry the lookup did not return stays: its presence in the app
    // playlist is better evidence than a failed or partial library read.
    for (const { entry, ledgerRow } of knownByKey.get(row.media_key) || []) {
      if (wanted.some((item) => item.providerItemId === entry.itemId)) continue;
      wanted.push({ providerItemId: entry.itemId, season: ledgerRow.season, episode: ledgerRow.episode, kept: true });
    }
    for (const item of wanted) {
      if (seenItemIds.has(item.providerItemId)) continue;
      seenItemIds.add(item.providerItemId);
      const known = takeEntry(item.providerItemId, true);
      if (known) {
        desired.push({ group, ...item, entryId: known.entryId, origin: ledgerByEntry.get(known.entryId).origin });
        continue;
      }
      // Added in the app as well: adopt that entry instead of adding a duplicate.
      const adopted = takeEntry(item.providerItemId, false);
      if (adopted) {
        desired.push({ group, ...item, entryId: adopted.entryId, origin: "provider" });
        continue;
      }
      if (!oneWay && vanishedItemIds.has(item.providerItemId)) {
        group.pendingPull = true;
        continue;
      }
      desired.push({ group, ...item });
    }
  }

  const removeEntryIds = entries
    .filter((entry) => (oneWay ? ledger.length > 0 : ledgerByEntry.has(entry.entryId)) && !claimed.has(entry.entryId))
    .map((entry) => entry.entryId);
  return { desired, removeEntryIds };
}

// Adds in one request, falling back to one request per item when the provider
// rejects the batch (Jellyfin 12 answers 400 for a whole batch holding one
// stale id). Returns the ids the provider rejected.
async function addItems(client, config, playlistId, itemIds) {
  if (!itemIds.length) return new Set();
  try {
    await client.addPlaylistItems(config, playlistId, itemIds);
    return new Set();
  } catch (error) {
    if (Number(error?.status) !== 400) throw error;
  }
  const rejected = new Set();
  for (const itemId of itemIds) {
    try {
      await client.addPlaylistItems(config, playlistId, [itemId]);
    } catch (error) {
      if (Number(error?.status) !== 400) throw error;
      rejected.add(itemId);
    }
  }
  return rejected;
}

function writeAvailability(listId, provider, groups, desired, now) {
  const inPlaylist = new Map();
  for (const item of desired || []) {
    if (!item.entryId) continue;
    inPlaylist.set(item.group.row.media_key, (inPlaylist.get(item.group.row.media_key) || 0) + 1);
  }
  for (const group of groups) {
    const key = group.row.media_key;
    const held = desired ? inPlaylist.get(key) || 0 : 0;
    if (group.state === "resolved") {
      // A resolved item the app did not keep (rejected, or dropped on the
      // confirming re-read) is missing from that app for the user's purposes.
      // An entry awaiting the pull pass's removal decision is not "not kept".
      const notKept = desired && group.entries.length > 0 && held === 0 && !group.pendingPull;
      upsertAvailabilityStmt.run(listId, key, provider, notKept ? "missing" : "available", null, notKept ? "The app did not keep the item." : null, now);
    } else if (held > 0) {
      upsertAvailabilityStmt.run(listId, key, provider, "available", null, `Kept in the app playlist; library lookup: ${group.reason}`, now);
    } else if (group.state === "missing") {
      upsertAvailabilityStmt.run(listId, key, provider, "missing", null, group.reason, now);
    }
    // "unknown" with nothing in the playlist keeps the previous answer.
  }
}

async function pushPresentTarget(list, target, items, config, deps) {
  const { provider } = target;
  const client = deps.client(provider);
  const providerConfig = config[provider];
  const groups = await resolveGroups(provider, config, items, deps);
  let playlistId = text(target.remote_playlist_id);
  // Without an app playlist any ledger rows are stale, and must not hold back adds.
  let ledger = playlistId ? selectLedgerStmt.all(list.id, provider) : [];
  let remoteName = target.remote_name ?? null;

  let entries = [];
  let remoteTitle = "";
  try {
    if (playlistId) {
      const playlist = await client.fetchPlaylist(providerConfig, playlistId);
      if (!playlist) {
        // Deletion is only concluded by the pull pass, after two definite
        // not-found reads. The push never recreates or cascades on one.
        writeAvailability(list.id, provider, groups, null, deps.now());
        return { provider, status: "skipped", reason: "The app playlist was not found." };
      }
      remoteTitle = text(playlist.title);
      entries = await client.fetchPlaylistItems(providerConfig, playlistId);
      ledger = relinkLedger(list.id, provider, ledger, entries);
    }
  } catch (error) {
    writeAvailability(list.id, provider, groups, null, deps.now());
    throw error;
  }

  const oneWay = Boolean(list.rule_json);
  const { desired, removeEntryIds } = planEntries(groups, entries, ledger, { oneWay });
  const toAdd = desired.filter((item) => !item.entryId);
  let wrote = false;
  let renamed = false;
  let rejected = new Set();

  if (!playlistId) {
    if (!toAdd.length) {
      // Every provider needs an initial item to create a playlist, so an
      // all-missing playlist has no app playlist yet.
      transaction(() => {
        writeAvailability(list.id, provider, groups, desired, deps.now());
        markSyncedStmt.run(null, null, deps.now(), deps.now(), list.id, provider);
      });
      return { provider, status: "synced", created: false, added: 0, removed: 0, moved: 0 };
    }
    const created = await client.createPlaylist(providerConfig, { title: list.name, itemIds: [toAdd[0].providerItemId] });
    playlistId = text(created?.id);
    if (!playlistId) throw new Error("The app did not return an id for the new playlist.");
    remoteName = list.name;
    // Saved before anything else can fail, so a retry never creates a second playlist.
    transaction(() => {
      deleteLedgerStmt.run(list.id, provider);
      saveRemoteIdStmt.run(playlistId, remoteName, deps.now(), list.id, provider);
    });
    wrote = true;
    rejected = await addItems(client, providerConfig, playlistId, toAdd.slice(1).map((item) => item.providerItemId));
  } else {
    if (removeEntryIds.length) {
      await client.removePlaylistItems(providerConfig, playlistId, removeEntryIds);
      wrote = true;
    }
    if (remoteTitle !== list.name && remoteName !== list.name) {
      await client.renamePlaylist(providerConfig, playlistId, list.name);
      remoteName = list.name;
      renamed = true;
    }
    if (toAdd.length) {
      rejected = await addItems(client, providerConfig, playlistId, toAdd.map((item) => item.providerItemId));
      wrote = true;
    }
  }

  // Re-read after writes: Plex reports unowned ids as added, so membership is
  // only what the app returns. Nothing is removed on the strength of this read.
  const finalEntries = wrote ? await client.fetchPlaylistItems(providerConfig, playlistId) : entries;
  const ledgerEntryIds = new Set(ledger.map((row) => row.remote_entry_id));
  const claimedIds = new Set(desired.filter((item) => item.entryId).map((item) => item.entryId));
  for (const item of toAdd) {
    if (rejected.has(item.providerItemId)) continue;
    const entry = finalEntries.find((candidate) => candidate.itemId === item.providerItemId
      && !ledgerEntryIds.has(candidate.entryId) && !claimedIds.has(candidate.entryId));
    if (!entry) continue;
    item.entryId = entry.entryId;
    item.origin = "plembfin";
    claimedIds.add(entry.entryId);
  }

  const finalIds = finalEntries.map((entry) => entry.entryId);
  const present = new Set(finalIds);
  const desiredIds = desired.filter((item) => item.entryId && present.has(item.entryId)).map((item) => item.entryId);
  let { moves, order } = await reorderProviderPlaylist(client, providerConfig, playlistId, finalIds, desiredIds);
  let orderMismatch = false;
  if (moves && provider === "plex") {
    // Plex can answer a move with success yet leave the entry in place, so its
    // order is re-read; a mismatch gets one rebuild, and the ledger stores what
    // the app holds so the next pass compares against the truth.
    const readOrder = async () => (await client.fetchPlaylistItems(providerConfig, playlistId)).map((entry) => entry.entryId);
    const landed = (ids) => desiredIds.every((entryId, index) => ids[index] === entryId);
    order = await readOrder();
    if (!landed(order)) {
      moves += (await reorderProviderPlaylist(client, providerConfig, playlistId, order, desiredIds, { rebuild: true })).moves;
      order = await readOrder();
      orderMismatch = !landed(order);
    }
  }
  const positions = new Map(order.map((entryId, index) => [entryId, index]));

  const now = deps.now();
  const added = toAdd.filter((item) => item.entryId).length;
  transaction(() => {
    for (const entryId of removeEntryIds) deleteLedgerEntryStmt.run(list.id, provider, entryId);
    // The pull pass does not decide removals for a one-way playlist, so rows
    // whose entries left the app are forgotten here.
    if (oneWay) {
      for (const row of ledger) if (!present.has(row.remote_entry_id)) deleteLedgerEntryStmt.run(list.id, provider, row.remote_entry_id);
    }
    for (const item of desired) {
      if (!item.entryId || !positions.has(item.entryId)) continue;
      upsertLedgerStmt.run(
        list.id, provider, item.entryId, item.providerItemId, item.group.row.media_key,
        item.season ?? null, item.episode ?? null, positions.get(item.entryId), item.origin || "plembfin", now, now,
      );
    }
    for (const item of desired) {
      if (item.entryId && !present.has(item.entryId)) item.entryId = undefined;
    }
    writeAvailability(list.id, provider, groups, desired, now);
    markSyncedStmt.run(playlistId, remoteName, now, now, list.id, provider);
  });
  return {
    provider,
    status: "synced",
    created: !text(target.remote_playlist_id),
    renamed,
    added,
    removed: removeEntryIds.length,
    moved: moves,
    ...(orderMismatch ? { orderMismatch } : {}),
    notKept: toAdd.filter((item) => !item.entryId).length,
  };
}

// A deselected app (desired_state 'absent') loses its playlist and its target
// row. A soft-deleted Plembfin playlist loses every app playlist but keeps the
// target rows, so a restore knows which apps to recreate it in.
async function removeRemoteTarget(list, target, config, deps, { keepTarget }) {
  const { provider } = target;
  const playlistId = text(target.remote_playlist_id);
  let status = "deleted";
  if (playlistId) {
    const result = await deps.client(provider).deletePlaylist(config[provider], playlistId);
    if (result?.status === "not_found") status = "already_gone";
  }
  const now = deps.now();
  transaction(() => {
    deleteLedgerStmt.run(list.id, provider);
    deleteAvailabilityStmt.run(list.id, provider);
    if (keepTarget) markSyncedStmt.run(null, null, now, now, list.id, provider);
    else deleteTargetStmt.run(list.id, provider);
  });
  return { provider, status };
}

// Unlocked: callers hold withPlaylistLock for the list.
export async function runPlaylistPush(listId, { config, deps }) {
  const list = selectListStmt.get(listId);
  if (!list) return { listId, providers: [] };
  const targets = selectTargetsStmt.all(listId);
  if (!targets.length) return { listId, providers: [] };
  if (playlistAwaitsShowConversion(list)) return { listId, providers: [], skipped: "show_conversion" };
  const items = list.deleted_at ? [] : selectItemsStmt.all(listId);

  const providers = [];
  // Only the apps this playlist targets are ever touched.
  for (const target of targets) {
    const { provider } = target;
    if (!configuredProvider(config, provider)) {
      markErrorStmt.run(`${provider} is not configured.`, deps.now(), deps.now(), listId, provider);
      providers.push({ provider, status: "skipped", reason: "not configured" });
      continue;
    }
    try {
      if (list.deleted_at) providers.push(await removeRemoteTarget(list, target, config, deps, { keepTarget: true }));
      else if (target.desired_state === "absent") providers.push(await removeRemoteTarget(list, target, config, deps, { keepTarget: false }));
      else providers.push(await pushPresentTarget(list, target, items, config, deps));
    } catch (error) {
      const message = errorText(error);
      markErrorStmt.run(message, deps.now(), deps.now(), listId, provider);
      console.error(`[playlists] Push of playlist ${listId} to ${provider} failed: ${message}`);
      providers.push({ provider, status: "error", error: message });
    }
  }
  return { listId, providers };
}

// One sync step per playlist at a time (push, pull, or both), so two passes
// cannot both create an app playlist or interleave their writes.
const running = new Map();

export async function withPlaylistLock(listId, fn) {
  const id = text(listId);
  const previous = running.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => fn(id));
  running.set(id, next);
  try {
    return await next;
  } finally {
    if (running.get(id) === next) running.delete(id);
  }
}

export async function pushPlaylist(listId, { config = null, deps = {} } = {}) {
  return withPlaylistLock(listId, async (id) => runPlaylistPush(id, {
    config: config || await loadMediaConfig(),
    deps: { ...playlistLibraryDeps, ...deps },
  }));
}

export async function pushAllPlaylists({ config = null, deps = {} } = {}) {
  const resolvedConfig = config || await loadMediaConfig();
  const results = [];
  for (const { list_id: listId } of selectTargetedListsStmt.all()) {
    results.push(await pushPlaylist(listId, { config: resolvedConfig, deps }));
  }
  return results;
}
