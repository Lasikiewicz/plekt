import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { dropTitle, isSameDroppedTitle, listDroppedTitles, publishDroppedTitleMutation, setDroppedTitleMutationHandler, undropTitle } from "./droppedTitles.js";
import { freshTrackerConnection } from "./trackers/connections.js";
import { assertTrackerGeneration, runInTrackerGeneration } from "./trackers/generation.js";
import {
  fetchTraktDroppedShows, fetchTraktLastActivities, setTraktDroppedShow,
} from "./trackers/traktClient.js";
import { fetchSimklDroppedTitleSnapshot, setSimklDroppedTitleStatus } from "./trackers/simklClient.js";

const selectRows = db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider=?");
const selectAllRows = db.prepare("SELECT * FROM dropped_title_tracker_state");
const selectCursor = db.prepare("SELECT * FROM dropped_title_tracker_cursors WHERE provider=?");
const upsertState = db.prepare(`INSERT INTO dropped_title_tracker_state
  (id,provider,connection_id,account_id,identity_key,media_json,desired_dropped,action_at,source,remote_changed_at,remote_present,previous_status,write_status,last_error,updated_at)
  VALUES (@id,@provider,@connection_id,@account_id,@identity_key,@media_json,@desired_dropped,@action_at,@source,@remote_changed_at,@remote_present,@previous_status,@write_status,@last_error,@updated_at)
  ON CONFLICT(provider,identity_key) DO UPDATE SET media_json=excluded.media_json,desired_dropped=excluded.desired_dropped,
  connection_id=excluded.connection_id,account_id=excluded.account_id,
  action_at=excluded.action_at,source=excluded.source,remote_changed_at=excluded.remote_changed_at,
  remote_present=excluded.remote_present,previous_status=COALESCE(excluded.previous_status,dropped_title_tracker_state.previous_status),
  write_status=excluded.write_status,last_error=excluded.last_error,updated_at=excluded.updated_at`);
const saveCursor = db.prepare(`INSERT INTO dropped_title_tracker_cursors(provider,connection_id,account_id,activities_json,updated_at)
  VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET connection_id=excluded.connection_id,account_id=excluded.account_id,activities_json=excluded.activities_json,updated_at=excluded.updated_at`);
const setWriteStatus = db.prepare("UPDATE dropped_title_tracker_state SET write_status=?,last_error=?,updated_at=? WHERE provider=? AND identity_key=? AND action_at=?");
const setSimklWriteStatus = db.prepare("UPDATE dropped_title_tracker_state SET write_status='done',last_error=NULL,remote_present=?,updated_at=? WHERE provider='simkl' AND identity_key=? AND action_at=?");
const currentAccountStmt = db.prepare("SELECT id,remote_user_id FROM tracker_connections WHERE provider=?");

function titleMedia(dropped) {
  const saved = dropped?.snapshot && typeof dropped.snapshot === "object" ? dropped.snapshot : {};
  const ids = {
    ...(dropped.tmdb_id ? { tmdb: String(dropped.tmdb_id) } : {}),
    ...(dropped.tvdb_id ? { tvdb: String(dropped.tvdb_id) } : {}),
    ...(dropped.imdb_id ? { imdb: String(dropped.imdb_id) } : {}),
    ...(saved.ids || {}),
  };
  return {
    ...saved, type: dropped.media_type, mediaType: dropped.media_type,
    title: dropped.title || saved.title || "", year: dropped.year ?? saved.year ?? null,
    ids, tmdb_id: ids.tmdb || "", tvdb_id: ids.tvdb || "", imdb_id: ids.imdb || "",
  };
}

function stableIdentity(media) {
  const keys = Object.entries(media.ids || {}).filter(([key, value]) => ["tmdb", "tvdb", "imdb", "simkl", "trakt"].includes(key) && value)
    .map(([key, value]) => `${key}:${String(value).toLowerCase()}`).sort();
  const canonical = keys[0] || `${media.type}:${String(media.title || "").toLowerCase()}:${media.year || ""}`;
  return crypto.createHash("sha256").update(`${media.type}:${canonical}`).digest("hex");
}

export function snapshotContainsDroppedIdentity(snapshot, media) {
  return (snapshot || []).some((item) => sameTrackerTitle(item.media || item, media));
}

export function pendingDroppedTitleRowsForConnection(rows, connection) {
  return (rows || []).filter((row) => row.write_status === "pending"
    && row.connection_id === connection?.id && row.account_id === connection?.remoteUserId);
}

function stateId(provider, identity) { return `${provider}:${identity}`; }

function persist(provider, media, patch, connection = null) {
  const account = connection || currentAccountStmt.get(provider) || {};
  const matches = matchingStates(provider, media);
  const old = matches[0];
  const identity = old?.identity_key || stableIdentity(media);
  const now = Date.now();
  const row = {
    id: old?.id || stateId(provider, identity), provider, connection_id: account.id || "", account_id: account.remoteUserId || account.remote_user_id || "", identity_key: identity,
    media_json: toJson(media), desired_dropped: patch.desired_dropped ?? old?.desired_dropped ?? 0,
    action_at: patch.action_at ?? old?.action_at ?? now, source: patch.source ?? old?.source ?? "local",
    remote_changed_at: patch.remote_changed_at ?? old?.remote_changed_at ?? null,
    remote_present: patch.remote_present ?? old?.remote_present ?? null,
    previous_status: patch.previous_status ?? matches.find(item => item.previous_status)?.previous_status ?? null,
    write_status: patch.write_status ?? old?.write_status ?? "done",
    last_error: patch.last_error ?? null, updated_at: now,
  };
  for (const duplicate of matches.slice(1)) db.prepare("DELETE FROM dropped_title_tracker_state WHERE id=?").run(duplicate.id);
  upsertState.run(row);
  return row;
}

// Local mutations enter a durable outbox before this callback returns. The
// tracker request is made only from a normal tracker poll/event/user pass.
setDroppedTitleMutationHandler((action, dropped, { source = "local", actionAt = Date.now() } = {}) => {
  if (source === "local") return; // droppedTitles.js records this synchronously, even before this module loads.
  const media = titleMedia(dropped);
  for (const provider of ["trakt", "simkl"]) {
    if (source === provider) continue; // Never echo an imported change to its source.
    if (provider === "trakt" && media.type !== "show") continue; // Trakt supports dropped shows only.
    const latest = latestCanonicalAction(media);
    if (latest > 0 && latest >= Number(actionAt || 0)) continue;
    const account = currentAccountStmt.get(provider);
    persist(provider, media, { desired_dropped: action === "drop" ? 1 : 0, action_at: Number(actionAt) || 0, source,
      write_status: account?.id && account?.remote_user_id ? "pending" : "unbound" }, account);
  }
});

const scheduledLocalDrains = new Map();
export function scheduleDroppedTitleTrackerDrain(trigger = "user") {
  if (!['event', 'user'].includes(trigger)) return;
  for (const provider of ["trakt", "simkl"]) {
    if (scheduledLocalDrains.has(provider)) continue;
    const timer = setTimeout(() => {
      scheduledLocalDrains.delete(provider);
      void syncDroppedTitleTracker(provider, { trigger })
        .catch((error) => console.error(`[dropped-titles] ${provider} background sync failed: ${error?.message || error}`));
    }, 0);
    scheduledLocalDrains.set(provider, timer);
  }
}

function time(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const number = Date.parse(String(value ?? ""));
  return Number.isFinite(number) ? number : 0;
}

function validActivity(value) { return typeof value === "string" && time(value) > 0; }

export function resolveSimklRestoreStatus(mediaType, previousStatus) {
  const status = String(previousStatus || "").toLowerCase();
  if (status === "completed") return null; // An add-to-list transition may create watched history.
  if (mediaType === "movie") return status === "plantowatch" ? status : "plantowatch";
  return ["watching", "plantowatch", "hold"].includes(status) ? status : "watching";
}

export function shouldApplyRemoteDroppedChange(localActionAt, remoteChangedAt) {
  return Number(remoteChangedAt) > 0 && Number(remoteChangedAt) > Number(localActionAt || 0);
}

function providerShow(showEntry) {
  const show = showEntry?.show;
  if (!show || typeof show !== "object" || typeof show.title !== "string" || !show.ids || typeof show.ids !== "object") throw new Error("Trakt dropped snapshot is malformed");
  const ids = Object.fromEntries(Object.entries(show.ids).filter(([key, value]) => ["imdb", "tmdb", "tvdb", "trakt"].includes(key) && value != null && String(value)));
  if (!Object.keys(ids).length) throw new Error("Trakt dropped snapshot has an item without a verified id");
  return { type: "show", mediaType: "show", title: show.title, year: show.year || null, ids, tmdb_id: ids.tmdb || "", tvdb_id: ids.tvdb || "", imdb_id: ids.imdb || "" };
}

function matchingStates(provider, media) {
  const account = currentAccountStmt.get(provider) || {};
  const rows = selectRows.all(provider).filter((row) => row.connection_id === (account.id || "") && row.account_id === (account.remote_user_id || ""));
  return rows.filter((row) => {
    try { return sameTrackerTitle(parseJson(row.media_json, {}), media); } catch { return false; }
  }).sort((a, b) => Number(b.action_at) - Number(a.action_at) || Number(b.updated_at) - Number(a.updated_at));
}

function matchingState(provider, media) {
  return matchingStates(provider, media)[0] || null;
}

function latestCanonicalAction(media) {
  return selectAllRows.all().reduce((latest, row) => {
    try {
      if (row.source !== "local") {
        const current = currentAccountStmt.get(row.provider) || {};
        if (row.connection_id !== (current.id || "") || row.account_id !== (current.remote_user_id || "")) return latest;
      }
      return sameTrackerTitle(parseJson(row.media_json, {}), media)
        ? Math.max(latest, Number(row.action_at || 0)) : latest;
    } catch { return latest; }
  }, 0);
}

// Imported provider changes may propagate to a different connected tracker,
// but the callback excludes their source. Snapshot omissions count only after
// an activity change and a fully validated snapshot.
function sameTrackerTitle(left = {}, right = {}) {
  const leftIds = left.ids || {};
  const rightIds = right.ids || {};
  for (const provider of ["trakt", "simkl", "tmdb", "tvdb", "imdb"]) {
    if (leftIds[provider] != null && rightIds[provider] != null
        && String(leftIds[provider]).toLowerCase() !== String(rightIds[provider]).toLowerCase()) return false;
  }
  return isSameDroppedTitle(left, right);
}

function applyRemoteSnapshot(provider, remoteDropped, remoteStatuses, activityAt, connection) {
  const beforeStates = selectRows.all(provider).filter((row) => row.connection_id === connection.id && row.account_id === connection.remoteUserId);
  const remoteByIdentity = remoteDropped.map((entry) => ({ ...entry, identity: stableIdentity(entry.media) }));
  const now = Date.now();
  for (const entry of remoteStatuses || []) {
    if (entry.status === "dropped") continue;
    const media = entry.media;
    const state = matchingState(provider, media);
    persist(provider, media, { previous_status: entry.status, remote_present: 0, remote_changed_at: entry.changedAt || null,
      action_at: state?.source === "local" ? state.action_at : entry.changedAt || state?.action_at || 0,
      source: state?.source === "local" ? "local" : provider,
      write_status: state?.write_status || "done" }, connection);
  }
  for (const remote of remoteByIdentity) {
    const media = remote.media;
    const state = matchingState(provider, media);
    // Simkl often omits item-level last_listed_at. Use activities.all only as
    // an ordering fence when the preceding complete snapshot confirmed this
    // title was absent from Dropped; otherwise there is no safe change time.
    const remoteAt = remote.changedAt || (provider === "simkl" && state?.remote_present === 0 && state.write_status === "done" ? activityAt : 0);
    // A drop this account already holds (our own push read back, or an earlier
    // import) is confirmed, never re-imported: its listed_at is later than the
    // local action and would relabel it as remote and queue the other tracker.
    if (state?.desired_dropped && state.write_status === "done") {
      persist(provider, media, { remote_present: 1, remote_changed_at: remoteAt || null }, connection);
      continue;
    }
    const latest = latestCanonicalAction(media);
    if (latest > 0 && !shouldApplyRemoteDroppedChange(latest, remoteAt)) {
      if (state?.source === "local" && !state.desired_dropped) persist(provider, media, { write_status: "pending" }, connection);
      continue;
    }
    const localDropped = listDroppedTitles().find((item) => sameTrackerTitle(titleMedia(item), media));
    if (!localDropped) dropTitle(media, { now: remoteAt || now, sync: true, source: provider, actionAt: remoteAt });
    else publishDroppedTitleMutation("drop", { ...localDropped, snapshot: media }, { source: provider, actionAt: remoteAt });
    const prior = state?.previous_status || (remoteStatuses || []).find((item) => sameTrackerTitle(item.media, media) && item.status !== "dropped")?.status || null;
    persist(provider, media, { desired_dropped: 1, action_at: remoteAt || 0, source: provider, remote_changed_at: remoteAt || null, remote_present: 1, previous_status: prior, write_status: "done" }, connection);
  }
  for (const row of beforeStates) {
    if (!row.remote_present) continue;
    const media = parseJson(row.media_json, {});
    if (matchingState(provider, media)?.identity_key !== row.identity_key) continue;
    if (snapshotContainsDroppedIdentity(remoteByIdentity, media)) continue;
    const movedTo = (remoteStatuses || []).find((entry) => sameTrackerTitle(entry.media, media));
    // Simkl's item-level last_listed_at can be absent. The changed activities
    // cursor is safe as an ordering fence here because we already confirmed
    // this account held this exact title as dropped and the complete snapshot
    // now finds it in another list. Do not use it to invent per-item dates.
    const removalAt = provider === "trakt" ? activityAt : movedTo ? Number(movedTo.changedAt || (row.write_status === "done" ? activityAt : 0)) : 0;
    if (!removalAt || !shouldApplyRemoteDroppedChange(latestCanonicalAction(media), removalAt)) {
      continue;
    }
    if (row.desired_dropped) {
      const local = listDroppedTitles().find((item) => sameTrackerTitle(titleMedia(item), media));
      if (local) undropTitle(local.id, { sync: true, source: provider, actionAt: removalAt });
      else publishDroppedTitleMutation("undrop", { ...media, media_type: media.type, snapshot: media }, { source: provider, actionAt: removalAt });
      persist(provider, media, { desired_dropped: 0, action_at: removalAt, source: provider, remote_changed_at: removalAt, remote_present: 0, write_status: "done" }, connection);
    }
  }
}

function validateTraktSnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error("Trakt dropped snapshot is incomplete");
  const normalized = rows.map((entry) => {
    const media = providerShow(entry);
    const changedAt = time(entry.listed_at);
    if (entry.listed_at != null && !changedAt) throw new Error("Trakt dropped snapshot has an invalid listed_at timestamp");
    return { media, changedAt };
  });
  return normalized;
}

async function syncTrakt(connection, trigger) {
  const activities = await fetchTraktLastActivities(connection);
  const droppedAt = activities?.shows?.dropped_at;
  if (droppedAt != null && !validActivity(droppedAt)) throw new Error("Trakt dropped activity timestamp is invalid");
  const cursor = selectCursor.get("trakt");
  const previous = parseJson(cursor?.activities_json, {});
  let rows = null;
  if (cursor?.connection_id !== connection.id || cursor?.account_id !== connection.remoteUserId || (droppedAt && previous.shows?.dropped_at !== droppedAt)) {
    rows = validateTraktSnapshot(await fetchTraktDroppedShows(connection));
    assertTrackerGeneration("trakt");
    applyRemoteSnapshot("trakt", rows, [], time(droppedAt), connection);
    saveCursor.run("trakt", connection.id, connection.remoteUserId, toJson({ shows: { dropped_at: droppedAt } }), Date.now());
  }
  await flushPending("trakt", connection, trigger);
  return { changed: rows !== null, remoteDropped: rows?.length || 0 };
}

async function syncSimkl(connection, trigger) {
  const cursor = selectCursor.get("simkl");
  const sameAccount = cursor?.connection_id === connection.id && cursor?.account_id === connection.remoteUserId;
  const previous = parseJson(cursor?.activities_json, {});
  const envelope = await fetchSimklDroppedTitleSnapshot(connection, { trigger, priorActivities: sameAccount ? previous : null });
  if (!envelope?.complete || !validActivity(envelope.activities?.all)
      || envelope.changed && (!Array.isArray(envelope.dropped) || !Array.isArray(envelope.previousStatuses))) {
    throw new Error("Simkl dropped snapshot is incomplete");
  }
  const activity = envelope.activities.all;
  if (envelope.changed || !sameAccount) {
    const dropped = envelope.dropped.map((item) => ({ media: item.media, changedAt: time(item.changedAt) }));
    const statuses = envelope.previousStatuses.map((item) => ({ media: item.media, status: item.status, changedAt: time(item.changedAt) }));
    applyRemoteSnapshot("simkl", dropped, statuses, time(activity), connection);
    saveCursor.run("simkl", connection.id, connection.remoteUserId, toJson({ all: activity }), Date.now());
  }
  await flushPending("simkl", connection, trigger);
  return { changed: Boolean(envelope.changed || !sameAccount), remoteDropped: envelope.dropped?.length || 0 };
}

async function flushPending(provider, connection, trigger) {
  // Old versions could give a re-dropped title a second outbox identity. Keep
  // its newest explicit action before selecting work, including after restart.
  for (const row of selectRows.all(provider)) {
    if (row.connection_id !== connection.id || row.account_id !== connection.remoteUserId) continue;
    const media = parseJson(row.media_json, {});
    if (matchingStates(provider, media).length > 1) persist(provider, media, {}, connection);
  }
  const candidates = pendingDroppedTitleRowsForConnection(selectRows.all(provider), connection).sort((a, b) => a.action_at - b.action_at);
  for (const row of candidates) {
    assertTrackerGeneration(provider);
    const media = parseJson(row.media_json, {});
    if (provider === "trakt" && media.type !== "show") {
      setWriteStatus.run("done", null, Date.now(), provider, row.identity_key, row.action_at);
      continue;
    }
    try {
      if (provider === "trakt") {
        const ids = Object.fromEntries(Object.entries(media.ids || {}).filter(([key, value]) => ["trakt", "tmdb", "tvdb", "imdb"].includes(key) && value));
        if (!Object.keys(ids).length) throw new Error("Trakt dropped write needs a verified show id");
        const show = { ids };
        await setTraktDroppedShow(connection, show, Boolean(row.desired_dropped));
      } else {
        let status = "dropped";
        if (!row.desired_dropped) {
          status = resolveSimklRestoreStatus(media.type, row.previous_status);
          if (!status) throw new Error("Simkl restore to completed is held because it may create watch history");
        }
        await setSimklDroppedTitleStatus(connection, media, status, { trigger });
      }
      assertTrackerGeneration(provider);
      if (provider === "simkl") setSimklWriteStatus.run(row.desired_dropped ? 1 : 0, Date.now(), row.identity_key, row.action_at);
      else setWriteStatus.run("done", null, Date.now(), provider, row.identity_key, row.action_at);
    } catch (error) {
      // Keep the local canonical state and durable pending intent. A provider
      // outage can never roll back a drop or un-drop.
      setWriteStatus.run("pending", String(error?.message || error).slice(0, 300), Date.now(), provider, row.identity_key, row.action_at);
      console.error(`[dropped-titles] ${provider} sync failed; local state kept`, error?.message || error);
    }
  }
}

export async function syncDroppedTitleTracker(provider, { trigger = "scheduled" } = {}) {
  if (!["trakt", "simkl"].includes(provider)) return { skipped: true };
  const connection = await freshTrackerConnection(provider);
  if (!connection || connection.status !== "connected") return { skipped: true, reason: "not-connected" };
  return runInTrackerGeneration(provider, connection.id, async () => {
    assertTrackerGeneration(provider);
    const fresh = await freshTrackerConnection(provider);
    if (!fresh || fresh.id !== connection.id) return { skipped: true, reason: "connection-changed" };
    return provider === "trakt" ? syncTrakt(fresh, trigger) : syncSimkl(fresh, trigger);
  });
}
