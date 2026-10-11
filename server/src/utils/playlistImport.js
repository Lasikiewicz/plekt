import crypto from "node:crypto";
import { bumpDataVersion, db, transaction, writeAuditLog } from "../db.js";
import { PLAYLIST_PROVIDERS, providerPlaylistClient } from "./providerPlaylists.js";
import { configuredProvider } from "./upNextLibraryLookup.js";

// Import of playlists made directly in Plex, Emby, or Jellyfin
// (plan/archive/custom-playlist-sync/plan.md, decisions 21 to 28).
//
// listPlaylistImportCandidates reads each connected app's playlists and
// returns the ones no Plembfin playlist is linked to yet (a soft-deleted
// playlist still counts as linked while its target row holds the id). Smart
// playlists are left out and counted (decision 27). A failing app is reported
// with its error, never as an empty list. Reads only; nothing is written.
//
// importAppPlaylists links picked app playlists to new or existing Plembfin
// playlists with an empty ledger, so the first sync's pull takes every app
// entry as an app addition and its push only adds: the push removes ledgered
// entries only, and nothing is ledgered yet.

const PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const MAX_NAME_LENGTH = 100;
const MAX_PICKS = 50;

const selectLinkedStmt = db.prepare("SELECT list_id, provider, remote_playlist_id FROM personal_list_targets WHERE remote_playlist_id IS NOT NULL");
const selectLiveListsStmt = db.prepare("SELECT id, name, kind FROM personal_lists WHERE deleted_at IS NULL");
const selectLiveListStmt = db.prepare("SELECT id, name, kind FROM personal_lists WHERE id = ? AND deleted_at IS NULL");
const selectTargetStmt = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? AND provider = ?");
const insertListStmt = db.prepare("INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
const setUntypedKindStmt = db.prepare("UPDATE personal_lists SET kind = ?, updated_at = ? WHERE id = ? AND kind IS NULL");
const touchListStmt = db.prepare("UPDATE personal_lists SET updated_at = ? WHERE id = ?");
const insertSourceTargetStmt = db.prepare(`
  INSERT INTO personal_list_targets (list_id, provider, desired_state, remote_playlist_id, remote_name, created_at, updated_at)
  VALUES (?, ?, 'present', ?, ?, ?, ?)
`);
const linkSourceTargetStmt = db.prepare(`
  UPDATE personal_list_targets
  SET desired_state = 'present', remote_playlist_id = ?, remote_name = ?, last_error = NULL, last_error_at = NULL,
      not_found_passes = 0, missing_since = NULL, updated_at = ?
  WHERE list_id = ? AND provider = ?
`);
const clearLedgerStmt = db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ? AND provider = ?");
const addOtherTargetStmt = db.prepare(`
  INSERT INTO personal_list_targets (list_id, provider, desired_state, created_at, updated_at) VALUES (?, ?, 'present', ?, ?)
  ON CONFLICT(list_id, provider) DO UPDATE SET desired_state = 'present', updated_at = excluded.updated_at
`);

function text(value = "") {
  return String(value ?? "").trim();
}

export function playlistNameKey(name) {
  return text(name).toLowerCase();
}

// movie / tv / mixed from the entry types; "empty" when the playlist holds no
// movie or episode (it imports untyped, decision 28).
export function guessPlaylistKind(entries = []) {
  const types = new Set(entries.map((entry) => text(entry?.type).toLowerCase()));
  const movies = types.has("movie");
  const episodes = types.has("episode");
  if (movies && episodes) return "mixed";
  if (movies) return "movie";
  if (episodes) return "tv";
  return "empty";
}

// Merge is offered only into a playlist of the same type, a Mixed one, or an
// untyped one; an empty app playlist fits any (decision 28).
export function playlistKindsCompatible(listKind, guess) {
  if (!listKind || listKind === "mixed" || guess === "empty") return true;
  return listKind === guess;
}

async function readApp(provider, config, clientFor, linked) {
  const client = clientFor(provider);
  const providerConfig = config[provider];
  let playlists;
  try {
    playlists = await client.fetchPlaylists(providerConfig);
  } catch (error) {
    return { provider, status: "error", error: text(error?.message || error) || "Unknown error", smart_skipped: 0, playlists: [] };
  }
  let smartSkipped = 0;
  const candidates = [];
  for (const playlist of playlists || []) {
    const id = text(playlist?.id);
    if (!id || linked.has(`${provider}:${id}`)) continue;
    if (playlist.smart) {
      smartSkipped += 1;
      continue;
    }
    const candidate = { provider, id, title: text(playlist.title), item_count: Number(playlist.itemCount) || 0, kind_guess: null, other_count: 0, error: "" };
    try {
      const entries = await client.fetchPlaylistItems(providerConfig, id);
      candidate.item_count = entries.length;
      candidate.kind_guess = guessPlaylistKind(entries);
      candidate.other_count = entries.filter((entry) => !["movie", "episode"].includes(text(entry?.type).toLowerCase())).length;
    } catch (error) {
      candidate.error = text(error?.message || error) || "Unknown error";
    }
    candidates.push(candidate);
  }
  return { provider, status: "ok", error: "", smart_skipped: smartSkipped, playlists: candidates };
}

export async function listPlaylistImportCandidates({ config, clientFor = providerPlaylistClient } = {}) {
  const linkedRows = selectLinkedStmt.all();
  const linked = new Set(linkedRows.map((row) => `${row.provider}:${text(row.remote_playlist_id)}`));
  // A playlist holds one app playlist per app, so one already linked on this
  // app cannot take a merge from it.
  const appTaken = new Set(linkedRows.map((row) => `${row.list_id}:${row.provider}`));
  const providers = PLAYLIST_PROVIDERS.filter((provider) => configuredProvider(config, provider));
  const apps = await Promise.all(providers.map((provider) => readApp(provider, config, clientFor, linked)));

  // Name clash hints (decision 22): a live Plembfin playlist with the same
  // name, whether it can take a merge, and same-name candidates in other apps.
  const listsByName = new Map(selectLiveListsStmt.all().map((list) => [playlistNameKey(list.name), list]));
  const appsByName = new Map();
  for (const candidate of apps.flatMap((app) => app.playlists)) {
    const key = playlistNameKey(candidate.title);
    if (!appsByName.has(key)) appsByName.set(key, []);
    appsByName.get(key).push(candidate);
  }
  for (const candidate of apps.flatMap((app) => app.playlists)) {
    const key = playlistNameKey(candidate.title);
    const list = listsByName.get(key) || null;
    const compatible = Boolean(list && candidate.kind_guess && playlistKindsCompatible(list.kind, candidate.kind_guess)
      && !appTaken.has(`${list.id}:${candidate.provider}`));
    candidate.clash = {
      name_taken: Boolean(list),
      merge_into: compatible ? { id: list.id, name: list.name, kind: list.kind || null } : null,
      same_name: appsByName.get(key)
        .filter((other) => other !== candidate)
        .map((other) => ({ provider: other.provider, id: other.id })),
    };
  }
  return { apps };
}

function importError(message, status, code) {
  return Object.assign(new Error(message), { status, publicCode: code });
}

// Type of the new playlist that app playlists merged together make: their one
// type, Mixed when a mixed one is among them, null (untyped) when all are
// empty. Movies and TV alone do not merge (decision 28): undefined.
export function mergedPlaylistKind(guesses = []) {
  const kinds = new Set(guesses.filter((guess) => guess && guess !== "empty"));
  if (!kinds.size) return null;
  if (kinds.size === 1) return [...kinds][0];
  return kinds.has("mixed") ? "mixed" : undefined;
}

// "Name (Plex)", then "Name (Plex 2)" and so on while the name is taken.
export function importedPlaylistName(title, provider, taken = new Set()) {
  for (let number = 1; ; number += 1) {
    const suffix = ` (${PROVIDER_LABELS[provider] || provider}${number === 1 ? "" : ` ${number}`})`;
    const name = `${title.slice(0, MAX_NAME_LENGTH - suffix.length).trim()}${suffix}`;
    if (!taken.has(playlistNameKey(name))) return name;
  }
}

function normalizePicks(picks, config) {
  if (!Array.isArray(picks) || !picks.length) throw importError("Choose at least one app playlist to import", 400, "no_picks");
  if (picks.length > MAX_PICKS) throw importError(`Import at most ${MAX_PICKS} playlists at a time`, 400, "too_many");
  const seen = new Set();
  return picks.map((pick) => {
    const provider = text(pick?.provider).toLowerCase();
    const remoteId = text(pick?.remote_playlist_id);
    const mode = text(pick?.mode).toLowerCase() || "separate";
    if (!PLAYLIST_PROVIDERS.includes(provider) || !remoteId) throw importError("Each import needs an app and an app playlist", 400, "bad_pick");
    if (!["merge", "separate"].includes(mode)) throw importError("Choose Merge or Import separately", 400, "bad_mode");
    if (seen.has(`${provider}:${remoteId}`)) throw importError("The same app playlist was picked twice", 400, "duplicate_pick");
    seen.add(`${provider}:${remoteId}`);
    const requested = (Array.isArray(pick.targets) ? pick.targets : []).map((value) => text(value).toLowerCase());
    const unknown = requested.filter((value) => !PLAYLIST_PROVIDERS.includes(value));
    if (unknown.length) throw importError(`Unknown app: ${unknown.join(", ")}`, 400, "bad_target");
    // The source app is always a target: the import links its playlist.
    const targets = PLAYLIST_PROVIDERS.filter((value) => value === provider || requested.includes(value));
    const unavailable = targets.filter((value) => !configuredProvider(config, value));
    if (unavailable.length) {
      throw importError(`${unavailable.map((value) => PROVIDER_LABELS[value]).join(", ")} is not connected`, 400, "not_connected");
    }
    return { provider, remoteId, mode, mergeInto: text(pick.merge_into) || null, targets };
  });
}

async function readPick(pick, config, clientFor) {
  const client = clientFor(pick.provider);
  const label = PROVIDER_LABELS[pick.provider];
  const playlist = await client.fetchPlaylist(config[pick.provider], pick.remoteId);
  if (!playlist) throw importError(`That ${label} playlist no longer exists. Reload the list and try again.`, 404, "not_found");
  if (playlist.smart) throw importError(`Smart ${label} playlists cannot be imported`, 400, "smart");
  const entries = await client.fetchPlaylistItems(config[pick.provider], pick.remoteId);
  return { ...pick, title: text(playlist.title), guess: guessPlaylistKind(entries) };
}

// Links each picked app playlist, in one transaction so a failed pick changes
// nothing. Separate: a new playlist of the guessed type, named "Name (App)"
// when the name is taken or another pick shares it. Merge: into merge_into,
// or with the other merge picks of the same name (the first creates the
// playlist). Only the ticked apps are added as targets.
function linkPicks(picks, now) {
  const linked = new Set(selectLinkedStmt.all().map((row) => `${row.provider}:${text(row.remote_playlist_id)}`));
  const taken = new Set(selectLiveListsStmt.all().map((list) => playlistNameKey(list.name)));
  const pickNames = new Map();
  const mergeGroups = new Map();
  for (const pick of picks) {
    const key = playlistNameKey(pick.title);
    pickNames.set(key, (pickNames.get(key) || 0) + 1);
    if (pick.mode !== "merge" || pick.mergeInto) continue;
    if (!mergeGroups.has(key)) mergeGroups.set(key, { picks: [], listId: null, name: "" });
    mergeGroups.get(key).picks.push(pick);
  }
  for (const group of mergeGroups.values()) {
    const providers = group.picks.map((pick) => pick.provider);
    if (new Set(providers).size !== providers.length) {
      throw importError(`Two ${PROVIDER_LABELS[providers[0]]} playlists named "${group.picks[0].title}" cannot merge; import one separately`, 400, "same_app");
    }
    group.kind = mergedPlaylistKind(group.picks.map((pick) => pick.guess));
    if (group.kind === undefined) {
      throw importError(`The playlists named "${group.picks[0].title}" hold movies and TV; import them separately`, 400, "kinds_differ");
    }
  }

  const createList = (name, kind) => {
    const id = crypto.randomUUID();
    insertListStmt.run(id, name, kind, now, now);
    taken.add(playlistNameKey(name));
    return id;
  };

  const results = [];
  for (const pick of picks) {
    const label = PROVIDER_LABELS[pick.provider];
    if (linked.has(`${pick.provider}:${pick.remoteId}`)) {
      throw importError(`"${pick.title}" in ${label} is already linked to a Plekt playlist. Reload the list and try again.`, 409, "already_linked");
    }
    const title = pick.title.slice(0, MAX_NAME_LENGTH).trim() || "Imported playlist";
    let listId;
    let name;
    let created = false;
    if (pick.mode === "merge" && pick.mergeInto) {
      const list = selectLiveListStmt.get(pick.mergeInto);
      if (!list) throw importError("The playlist to merge into no longer exists. Reload the list and try again.", 404, "merge_target_missing");
      if (!playlistKindsCompatible(list.kind, pick.guess)) {
        throw importError(`"${pick.title}" in ${label} cannot merge into ${list.name}: the playlist types differ`, 400, "wrong_type");
      }
      if (!list.kind && pick.guess !== "empty") setUntypedKindStmt.run(pick.guess, now, list.id);
      listId = list.id;
      name = list.name;
    } else if (pick.mode === "merge") {
      const group = mergeGroups.get(playlistNameKey(pick.title));
      if (!group.listId) {
        if (taken.has(playlistNameKey(title))) {
          throw importError(`A playlist named "${title}" already exists. Reload the list and try again.`, 409, "name_taken");
        }
        group.name = title;
        group.listId = createList(title, group.kind);
        created = true;
      }
      listId = group.listId;
      name = group.name;
    } else {
      const key = playlistNameKey(title);
      name = taken.has(key) || pickNames.get(playlistNameKey(pick.title)) > 1 ? importedPlaylistName(title, pick.provider, taken) : title;
      listId = createList(name, pick.guess === "empty" ? null : pick.guess);
      created = true;
    }

    const existing = selectTargetStmt.get(listId, pick.provider);
    if (existing?.remote_playlist_id) {
      throw importError(`${name} already has a ${label} playlist; import "${pick.title}" separately`, 409, "app_taken");
    }
    if (existing) linkSourceTargetStmt.run(pick.remoteId, pick.title, now, listId, pick.provider);
    else insertSourceTargetStmt.run(listId, pick.provider, pick.remoteId, pick.title, now, now);
    clearLedgerStmt.run(listId, pick.provider);
    linked.add(`${pick.provider}:${pick.remoteId}`);
    for (const provider of pick.targets) {
      if (provider !== pick.provider) addOtherTargetStmt.run(listId, provider, now, now);
    }
    touchListStmt.run(now, listId);
    results.push({ provider: pick.provider, remote_playlist_id: pick.remoteId, list_id: listId, name, mode: pick.mode, created });
  }
  return results;
}

// `syncList` runs the first sync of each playlist the import touched; null
// leaves it to the worker's scheduled pass (web-only processes). The remote
// name is stored as the app title, so the first pull does not take it as an
// app rename: the Plembfin name wins and the push renames the app playlist.
export async function importAppPlaylists(picks, { config, clientFor = providerPlaylistClient, syncList = null, now = () => Date.now() } = {}) {
  const normalized = normalizePicks(picks, config);
  const read = [];
  for (const pick of normalized) read.push(await readPick(pick, config, clientFor));
  const imported = transaction(() => linkPicks(read, now()));
  bumpDataVersion();
  writeAuditLog("personal.list-import", { detail: { imported: imported.map(({ provider, list_id: listId, mode }) => ({ provider, listId, mode })) } });

  const lists = [];
  for (const listId of [...new Set(imported.map((entry) => entry.list_id))]) {
    const sources = new Set(imported.filter((entry) => entry.list_id === listId).map((entry) => entry.provider));
    const summary = { list_id: listId, name: imported.find((entry) => entry.list_id === listId).name, added: 0, unidentified: 0, errors: [] };
    if (syncList) {
      try {
        const result = await syncList(listId);
        for (const row of result?.pull || []) {
          if (!sources.has(row.provider)) continue;
          summary.added += Number(row.added || 0) + Number(row.linked || 0);
          summary.unidentified += Number(row.unidentified || 0);
          if (row.status === "error") summary.errors.push(`${PROVIDER_LABELS[row.provider]}: ${row.error}`);
        }
      } catch (error) {
        summary.errors.push(text(error?.message || error));
      }
    }
    lists.push(summary);
  }
  return { imported, lists, synced: Boolean(syncList) };
}
