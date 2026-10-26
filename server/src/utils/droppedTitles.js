import crypto from "node:crypto";
import { db, bumpUpNextVersion, parseJson, toJson } from "../db.js";
import { normalizeUpNextCandidate } from "./upNextIdentity.js";

// A dropped show or movie is hidden from Up Next for good (issue #47). This is
// deliberately separate from up_next_dismissals: dismissals are capped at the
// newest 500 and come back on a newer play, so an old whole-show Remove could
// fall off the end and the show returned. Dropping never writes watched or
// unwatched state anywhere; it is queue state only.

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason))
    .catch((error) => console.error(`[up-next] Automatic sync request failed: ${error?.message || error}`));
}

const insertStmt = db.prepare(`
  INSERT INTO dropped_titles
    (id, media_type, aliases_json, title, year, tmdb_id, tvdb_id, imdb_id, snapshot_json, dropped_at, updated_at)
  VALUES
    (@id, @media_type, @aliases_json, @title, @year, @tmdb_id, @tvdb_id, @imdb_id, @snapshot_json, @dropped_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    media_type = excluded.media_type,
    aliases_json = excluded.aliases_json,
    title = excluded.title,
    year = excluded.year,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    imdb_id = excluded.imdb_id,
    snapshot_json = excluded.snapshot_json,
    dropped_at = excluded.dropped_at,
    updated_at = excluded.updated_at
`);
const selectAllStmt = db.prepare("SELECT * FROM dropped_titles ORDER BY dropped_at DESC");
const deleteStmt = db.prepare("DELETE FROM dropped_titles WHERE id = ?");
let mutationHandler = null;

const recordLocalTrackerMutation = db.prepare(`INSERT INTO dropped_title_tracker_state
  (id,provider,connection_id,account_id,identity_key,media_json,desired_dropped,action_at,source,remote_changed_at,remote_present,previous_status,write_status,last_error,updated_at)
  VALUES (@id,@provider,@connection_id,@account_id,@identity_key,@media_json,@desired_dropped,@action_at,'local',NULL,@remote_present,@previous_status,@write_status,NULL,@updated_at)
  ON CONFLICT(provider,identity_key) DO UPDATE SET connection_id=excluded.connection_id,account_id=excluded.account_id,
  media_json=excluded.media_json,desired_dropped=excluded.desired_dropped,action_at=excluded.action_at,source='local',
  previous_status=COALESCE(excluded.previous_status,dropped_title_tracker_state.previous_status),
  write_status=excluded.write_status,last_error=NULL,updated_at=excluded.updated_at`);

// Tracker sync registers only the imported-change fanout here. Local mutation
// intents are written by this storage module in the same SQLite transaction.
export function setDroppedTitleMutationHandler(handler) {
  mutationHandler = typeof handler === "function" ? handler : null;
}

function queueLocalMutation(action, dropped, actionAt) {
  const saved = dropped.snapshot || {};
  const media = {
    ...saved, type: dropped.media_type, mediaType: dropped.media_type,
    title: dropped.title || saved.title || "", year: dropped.year ?? saved.year ?? null,
    ids: {
      ...(dropped.tmdb_id ? { tmdb: String(dropped.tmdb_id) } : {}),
      ...(dropped.tvdb_id ? { tvdb: String(dropped.tvdb_id) } : {}),
      ...(dropped.imdb_id ? { imdb: String(dropped.imdb_id) } : {}),
      ...(saved.ids || {}),
    },
  };
  const connections = db.prepare("SELECT provider,id,remote_user_id FROM tracker_connections WHERE provider IN ('trakt','simkl')").all();
  for (const provider of ["trakt", "simkl"]) {
    if (provider === "trakt" && dropped.media_type !== "show") continue;
    const connection = connections.find((item) => item.provider === provider);
    const bound = Boolean(connection?.id && connection?.remote_user_id);
    const matches = db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider=? AND connection_id=? AND account_id=?")
      .all(provider, connection?.id || "", connection?.remote_user_id || "").filter(row => {
        const previous = parseJson(row.media_json, {});
        const conflictingId = ["tmdb", "tvdb", "imdb", "simkl", "trakt"].some(key => previous.ids?.[key] && media.ids?.[key]
          && String(previous.ids[key]).toLowerCase() !== String(media.ids[key]).toLowerCase());
        return !conflictingId && isSameDroppedTitle(previous, media);
      }).sort((a, b) => Number(b.action_at) - Number(a.action_at) || Number(b.updated_at) - Number(a.updated_at));
    const previous = matches[0];
    for (const duplicate of matches.slice(1)) db.prepare("DELETE FROM dropped_title_tracker_state WHERE id=?").run(duplicate.id);
    recordLocalTrackerMutation.run({
      id: previous?.id || `${provider}:${dropped.id}`, provider,
      connection_id: connection?.id || "", account_id: connection?.remote_user_id || "",
      identity_key: previous?.identity_key || dropped.id, media_json: toJson(media), desired_dropped: action === "drop" ? 1 : 0,
      remote_present: previous?.remote_present ?? null,
      previous_status: matches.find(row => row.previous_status)?.previous_status || null,
      action_at: Number(actionAt) || Date.now(), write_status: bound ? "pending" : "unbound", updated_at: Date.now(),
    });
  }
}

function notifyMutation(action, dropped, { sync = true, source = "local", actionAt = Date.now(), trigger = "user" } = {}) {
  if (!sync || !dropped) return;
  if (source === "local") {
    // Mutation/outbox writes have committed before this post-commit transport
    // request is queued. A dynamic import also covers calls made before the
    // tracker sync module has registered its imported-change handler.
    void import("./droppedTitleTrackerSync.js")
      .then(({ scheduleDroppedTitleTrackerDrain }) => scheduleDroppedTitleTrackerDrain(trigger))
      .catch((error) => console.error(`[dropped-titles] Could not schedule tracker sync: ${error?.message || error}`));
  }
  if (!mutationHandler) return;
  try { mutationHandler(action, dropped, { source, actionAt, trigger }); }
  catch (error) { console.error(`[dropped-titles] Could not queue tracker ${action}: ${error?.message || error}`); }
}

export function publishDroppedTitleMutation(action, item = {}, { source, actionAt } = {}) {
  notifyMutation(action, item, { source, actionAt });
}

const SHOW_TYPES = new Set(["episode", "show", "tv", "series"]);
const ID_PROVIDERS = ["imdb", "tmdb", "tvdb"];

function text(value = "") {
  return String(value ?? "").trim();
}

function lower(value = "") {
  return text(value).toLowerCase();
}

function yearOf(...values) {
  for (const value of values) {
    const match = text(value).match(/^(\d{4})/);
    if (match) return Number(match[1]);
  }
  return null;
}

// Same title slug as the dismissal show:title alias, so a year in brackets
// ("Scrubs (2001)") does not split one show into two titles.
function titleSlug(value = "") {
  return lower(value)
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mediaKind(item = {}) {
  const type = lower(item.media_type || item.mediaType || item.type);
  if (SHOW_TYPES.has(type)) return "show";
  if (type === "movie") return "movie";
  return text(item.show_title || item.showTitle) || item.season != null ? "show" : "movie";
}

// An episode card carries the show's ids in show_* fields (its plain ids are
// the episode's); a show record or a movie carries them in the plain fields.
function titleIdentity(item = {}) {
  const kind = mediaKind(item);
  const type = lower(item.media_type || item.mediaType || item.type);
  const isEpisode = kind === "show" && (type === "episode" || item.season != null || item.episode != null);
  const ids = {};
  let title = "";
  let year = null;
  let nativeAlias = "";
  if (isEpisode) {
    const candidate = normalizeUpNextCandidate({ ...item, media_type: "episode" });
    for (const provider of ID_PROVIDERS) ids[provider] = lower(candidate[`show_${provider}_id`]);
    title = text(candidate.show_title || item.show_title || item.showTitle);
    const nativeSeriesId = lower(candidate.series_provider_item_id);
    const nativeProvider = lower(candidate.provider || candidate.source);
    if (nativeSeriesId && nativeProvider) nativeAlias = `show:native:${nativeProvider}:${nativeSeriesId}`;
  } else {
    for (const provider of ID_PROVIDERS) {
      ids[provider] = lower(item[`${provider}_id`] || item[`${provider}Id`] || item[`show_${provider}_id`] || item.ids?.[provider]);
    }
    title = text(kind === "show" ? (item.title || item.show_title || item.showTitle) : item.title);
    year = yearOf(item.year, item.release_date, item.releaseDate, item.first_air_date, item.firstAirDate);
  }
  const aliases = [];
  for (const provider of ID_PROVIDERS) {
    if (ids[provider]) aliases.push(`${kind}:${provider}:${ids[provider]}`);
  }
  if (nativeAlias) aliases.push(nativeAlias);
  const slug = titleSlug(title);
  if (slug) aliases.push(`${kind}:title:${slug}`);
  return { kind, ids, title, year, aliases };
}

// Two titles can share a name (Scrubs 2001 and its reboot, a movie and its
// remake), and so share the title alias. An id or year that disagrees proves
// they are different, so dropping one never hides or un-drops the other.
function provenDifferent(left, right) {
  if (left.kind !== right.kind) return true;
  const providers = left.kind === "movie" ? ID_PROVIDERS : ["tmdb", "tvdb"];
  if (providers.some((provider) => left.ids[provider] && right.ids[provider] && left.ids[provider] !== right.ids[provider])) return true;
  return Boolean(left.year && right.year && left.year !== right.year);
}

function rowToDropped(row) {
  return {
    id: row.id,
    media_type: row.media_type,
    aliases: parseJson(row.aliases_json, []) || [],
    title: row.title || "",
    year: row.year ?? null,
    tmdb_id: row.tmdb_id || "",
    tvdb_id: row.tvdb_id || "",
    imdb_id: row.imdb_id || "",
    snapshot: parseJson(row.snapshot_json, {}) || {},
    dropped_at: Number(row.dropped_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function rowIdentity(dropped) {
  return {
    kind: dropped.media_type,
    ids: { imdb: lower(dropped.imdb_id), tmdb: lower(dropped.tmdb_id), tvdb: lower(dropped.tvdb_id) },
    year: dropped.year,
  };
}

function matchingRows(identity, rows = listDroppedTitles()) {
  const wanted = new Set(identity.aliases);
  return rows.filter((dropped) => (
    dropped.aliases.some((alias) => wanted.has(alias)) && !provenDifferent(rowIdentity(dropped), identity)
  ));
}

// Shared identity comparison for operations that must affect the exact same
// title as drop/undrop. Aliases identify possible matches; contradictory IDs
// or release years always win over a shared title alias.
export function isSameDroppedTitle(left = {}, right = {}) {
  const leftIdentity = titleIdentity(left);
  const rightIdentity = titleIdentity(right);
  const aliases = new Set(leftIdentity.aliases);
  return rightIdentity.aliases.some((alias) => aliases.has(alias))
    && !provenDifferent(leftIdentity, rightIdentity);
}

export function listDroppedTitles() {
  return selectAllStmt.all().map(rowToDropped);
}

// Dropping an already dropped title keeps its original drop time and folds in
// any new aliases, so a show dropped from an episode card and again from its
// show page stays one row.
export function dropTitle(item = {}, { now = Date.now(), sync = true, source = "local", actionAt = now } = {}) {
  const identity = titleIdentity(item);
  if (!identity.aliases.length) return null;
  const timestamp = Number(now) || Date.now();
  const existing = matchingRows(identity);
  const keep = existing[0] || null;
  const aliases = new Set(identity.aliases);
  for (const dropped of existing) for (const alias of dropped.aliases) aliases.add(alias);
  const pick = (provider) => identity.ids[provider] || existing.map((dropped) => dropped[`${provider}_id`]).find(Boolean) || null;
  const row = {
    id: keep?.id || crypto.randomUUID(),
    media_type: identity.kind,
    aliases_json: toJson([...aliases]),
    title: identity.title || keep?.title || "",
    year: identity.year ?? keep?.year ?? null,
    tmdb_id: pick("tmdb"),
    tvdb_id: pick("tvdb"),
    imdb_id: pick("imdb"),
    snapshot_json: toJson(item),
    dropped_at: existing.length ? Math.min(...existing.map((dropped) => dropped.dropped_at)) : timestamp,
    updated_at: timestamp,
  };
  db.transaction(() => {
    for (const dropped of existing.slice(1)) deleteStmt.run(dropped.id);
    insertStmt.run(row);
    if (sync && source === "local") queueLocalMutation("drop", rowToDropped({ ...row, snapshot_json: row.snapshot_json }), Number(actionAt) || Date.now());
  }).immediate();
  bumpUpNextVersion();
  queueAutomaticUpNextSync("Dropped title changed");
  notifyMutation("drop", { ...rowToDropped({ ...row, snapshot_json: row.snapshot_json }), snapshot: item }, { sync, source, actionAt: Number(actionAt) || 0 });
  return { id: row.id, created: !keep, dropped_at: row.dropped_at };
}

export function undropTitle(id, { sync = true, source = "local", actionAt = Date.now(), trigger = "user" } = {}) {
  const key = text(id);
  if (!key) return false;
  const dropped = selectAllStmt.all().find((row) => row.id === key);
  const removed = db.transaction(() => {
    const changed = deleteStmt.run(key).changes > 0;
    if (changed && sync && source === "local" && dropped) queueLocalMutation("undrop", rowToDropped(dropped), actionAt);
    return changed;
  }).immediate();
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Dropped title restored");
    if (dropped) notifyMutation("undrop", rowToDropped(dropped), { sync, source, actionAt, trigger });
  }
  return removed;
}

// `before` limits the un-drop to rows dropped before that time, so a play
// that happened before the drop cannot undo it.
export function undropTitleForMedia(item = {}, { before = 0, sync = true, source = "local", actionAt = Date.now(), trigger = "user" } = {}) {
  const identity = titleIdentity(item);
  if (!identity.aliases.length) return 0;
  const threshold = Number(before) || 0;
  const matches = matchingRows(identity).filter((dropped) => threshold <= 0 || dropped.dropped_at < threshold);
  if (!matches.length) return 0;
  const removed = db.transaction(() => matches.reduce((count, dropped) => {
    const changed = deleteStmt.run(dropped.id).changes;
    if (changed && sync && source === "local") queueLocalMutation("undrop", dropped, actionAt);
    return count + changed;
  }, 0)).immediate();
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Dropped title restored");
    for (const dropped of matches) notifyMutation("undrop", dropped, { sync, source, actionAt, trigger });
  }
  return removed;
}

// A live play (webhook playback, plugin event or finished session) dated after
// the drop returns the title to normal (issue #47). Imports, backfills, played
// flags and tracker pulls never call this, so an old play arriving late cannot
// un-drop. Takes a watch_history row, whose episode ids are the show's.
export function undropTitleForLivePlay(record = {}) {
  const watchedAt = Date.parse(text(record.watched_at)) || 0;
  if (!watchedAt) return 0;
  const item = lower(record.media_type) === "episode"
    ? { ...record, show_tmdb_id: record.tmdb_id, show_tvdb_id: record.tvdb_id, show_imdb_id: record.imdb_id }
    : record;
  return undropTitleForMedia(item, { before: watchedAt, trigger: "event", actionAt: watchedAt });
}

// Returns a predicate rather than testing one item at a time, for the same
// reason as createUpNextDismissalFilter: the projection checks every candidate.
export function createDroppedTitleFilter() {
  const dropped = listDroppedTitles();
  if (!dropped.length) {
    return { isDropped: () => false, droppedAt: () => 0, match: () => null, count: 0 };
  }
  const byAlias = new Map();
  for (const entry of dropped) {
    for (const alias of entry.aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias).push(entry);
    }
  }
  const lookup = (candidate) => {
    const identity = titleIdentity(candidate);
    for (const alias of identity.aliases) {
      const hit = byAlias.get(alias)?.find((entry) => !provenDifferent(rowIdentity(entry), identity));
      if (hit) return hit;
    }
    return null;
  };
  return {
    count: dropped.length,
    droppedAt: (candidate) => lookup(candidate)?.dropped_at || 0,
    isDropped: (candidate) => Boolean(lookup(candidate)),
    match: lookup,
  };
}
