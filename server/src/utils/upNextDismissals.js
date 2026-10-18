import crypto from "node:crypto";
import { db, bumpUpNextVersion, parseJson, toJson } from "../db.js";
import { normalizeUpNextCandidate, upNextIdentityAliases } from "./upNextIdentity.js";

// Dismissals were browser-local until this module existed, which meant the
// server's queue and the user's queue were different lists. Anything pushing
// from outside that one browser session - the API, a second device, a
// scheduled job - sent the dismissed items straight back to every media
// server. See docs/decisions.md entry 23.
const MAX_DISMISSALS = 500;

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason))
    .catch((error) => console.error(`[up-next] Automatic sync request failed: ${error?.message || error}`));
}

const upsertStmt = db.prepare(`
  INSERT INTO up_next_dismissals
    (id, aliases_json, media_key, media_type, title, show_title, episode_title, season, episode, snapshot_json, dismissed_at)
  VALUES
    (@id, @aliases_json, @media_key, @media_type, @title, @show_title, @episode_title, @season, @episode, @snapshot_json, @dismissed_at)
  ON CONFLICT(id) DO UPDATE SET
    aliases_json = excluded.aliases_json,
    media_key = excluded.media_key,
    media_type = excluded.media_type,
    title = excluded.title,
    show_title = excluded.show_title,
    episode_title = excluded.episode_title,
    season = excluded.season,
    episode = excluded.episode,
    snapshot_json = excluded.snapshot_json,
    dismissed_at = excluded.dismissed_at
`);
const selectAllStmt = db.prepare("SELECT * FROM up_next_dismissals ORDER BY dismissed_at DESC");
const selectUnwatchedHistoryStmt = db.prepare(
  "SELECT * FROM watch_history WHERE sync_action IN ('unwatched', 'unplayed') AND updated_at > ? ORDER BY updated_at DESC",
);
const deleteStmt = db.prepare("DELETE FROM up_next_dismissals WHERE id = ?");
const deleteAllStmt = db.prepare("DELETE FROM up_next_dismissals");
const trimStmt = db.prepare(`
  DELETE FROM up_next_dismissals
   WHERE id IN (SELECT id FROM up_next_dismissals ORDER BY dismissed_at DESC LIMIT -1 OFFSET ?)
`);

function text(value = "") {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// An episode keeps its identity across re-matches and provider id changes, so
// the coordinate is stored alongside the provider aliases. Without it a
// dismissal would be lost the moment the item's native id changed.
function coordinateAlias(item = {}) {
  const showTitle = showTitleKey(item);
  const season = number(item.season);
  const episode = number(item.episode);
  if (!showTitle || season === null || episode === null) return "";
  return `coordinate:${showTitle}:s${season}:e${episode}`;
}

function showTitleKey(item = {}) {
  return text(item.show_title || item.showTitle)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/\([^)]*\)$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function showIdentityIds(item = {}) {
  const candidate = normalizeUpNextCandidate(item);
  const ids = {};
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const values = [
      candidate[`show_${provider}_id`],
      item[`show_${provider}_id`],
      item[`show${provider[0].toUpperCase()}${provider.slice(1)}Id`],
      // Older dismissal snapshots stored the series id in the episode id
      // field, so keep that value as a migration bridge too.
      item[`${provider}_id`],
    ].map((value) => text(value).toLowerCase()).filter(Boolean);
    if (values.length) ids[provider] = new Set(values);
  }
  return ids;
}

// Two shows can share a title (Scrubs 2001 and its reboot), and so share the
// show:title and coordinate aliases. A TMDB or TVDB show id that disagrees
// proves they are different shows, so one's dismissal never hides, replaces
// or restores the other's.
function provenDifferentShow(dismissal, item = {}) {
  const left = normalizeUpNextCandidate(dismissal.snapshot || dismissal);
  const right = normalizeUpNextCandidate(item);
  return ["tmdb", "tvdb"].some((provider) => {
    const leftId = text(left[`show_${provider}_id`]).toLowerCase();
    const rightId = text(right[`show_${provider}_id`]).toLowerCase();
    return Boolean(leftId && rightId && leftId !== rightId);
  });
}

function dismissalMatchesRematchedEpisode(dismissal, item = {}) {
  if (dismissal.media_type !== "episode") return false;
  const candidate = normalizeUpNextCandidate(item);
  if (candidate.media_type !== "episode") return false;
  if (number(dismissal.season) !== number(candidate.season) || number(dismissal.episode) !== number(candidate.episode)) return false;

  const dismissalIds = showIdentityIds(dismissal.snapshot || dismissal);
  const itemIds = showIdentityIds(item);
  if (Object.keys(itemIds).some((provider) => [...(itemIds[provider] || [])].some((id) => dismissalIds[provider]?.has(id)))) {
    return true;
  }

  // A title-only dismissal may predate a corrected provider match. Treat a
  // trailing disambiguator such as "(UK)" as presentation metadata when the
  // episode coordinate is identical, allowing the corrected watch record to
  // retire the stale row without relying on a media-server lookup.
  return Boolean(showTitleKey(dismissal) && showTitleKey(item) && showTitleKey(dismissal) === showTitleKey(item));
}

function showAliases(item = {}) {
  const candidate = normalizeUpNextCandidate(item);
  if (candidate.media_type !== "episode") return [];
  const aliases = [];
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const id = text(candidate[`show_${provider}_id`]);
    if (id) aliases.push(`show:${provider}:${id.toLowerCase()}`);
  }
  const nativeSeriesId = text(candidate.series_provider_item_id);
  const nativeProvider = text(candidate.provider || candidate.source).toLowerCase();
  if (nativeSeriesId && nativeProvider) aliases.push(`show:native:${nativeProvider}:${nativeSeriesId.toLowerCase()}`);
  const showTitle = text(candidate.show_title)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (showTitle) aliases.push(`show:title:${showTitle}`);
  return aliases;
}

// A show beside a rewatch has two cards, and Remove asks whether to hide that
// card's season or the whole show (loose-ends step 20). Every episode is
// looked up under both, so a season dismissal stores only its season aliases.
function seasonAliases(candidate, shows) {
  const season = number(candidate.season);
  if (season == null) return [];
  return shows.map((alias) => `season:${alias.slice("show:".length)}:s${season}`);
}

export function dismissalAliases(item = {}) {
  const candidate = normalizeUpNextCandidate(item);
  const aliases = new Set(upNextIdentityAliases(candidate));
  const shows = showAliases(candidate);
  const seasonScope = text(item.dismissal_scope).toLowerCase() === "season";
  for (const alias of seasonScope ? [] : shows) aliases.add(alias);
  for (const alias of seasonAliases(candidate, shows)) aliases.add(alias);
  for (const key of [item.id, item.media_key, item.mediaKey]) {
    const value = text(key);
    if (value) aliases.add(`key:${value.toLowerCase()}`);
  }
  const providerItems = item.provider_items || item.providerItems || {};
  for (const [provider, values] of Object.entries(providerItems)) {
    for (const value of (Array.isArray(values) ? values : [values])) {
      const id = text(value);
      if (id) aliases.add(`provider:${String(provider).toLowerCase()}:${id.toLowerCase()}`);
    }
  }
  const coordinate = coordinateAlias(item);
  if (coordinate) aliases.add(coordinate);
  return [...aliases].filter(Boolean);
}

export function recordUpNextDismissal(item = {}, { now = Date.now() } = {}) {
  const aliases = dismissalAliases(item);
  if (!aliases.length) return null;
  const id = text(item.dismissal_id) || crypto.randomUUID();
  const row = {
    id,
    aliases_json: toJson(aliases),
    media_key: text(item.media_key || item.mediaKey) || null,
    media_type: text(item.media_type || item.mediaType) || null,
    title: text(item.title) || null,
    show_title: text(item.show_title || item.showTitle) || null,
    episode_title: text(item.episode_title || item.episodeTitle) || null,
    season: number(item.season),
    episode: number(item.episode),
    snapshot_json: toJson(item),
    dismissed_at: Number(now) || Date.now(),
  };
  // One dismissal per identity: re-dismissing an item that already has a row
  // under an overlapping alias replaces it rather than accumulating rows that
  // all resolve to the same card.
  const existing = findDismissalByAliases(aliases, item);
  db.transaction(() => {
    if (existing && existing.id !== id) deleteStmt.run(existing.id);
    upsertStmt.run(row);
    trimStmt.run(MAX_DISMISSALS);
  }).immediate();
  bumpUpNextVersion();
  queueAutomaticUpNextSync("Up Next dismissal changed");
  return id;
}

function rowToDismissal(row) {
  return {
    id: row.id,
    aliases: parseJson(row.aliases_json, []) || [],
    media_key: row.media_key || "",
    media_type: row.media_type || "",
    title: row.title || "",
    show_title: row.show_title || "",
    episode_title: row.episode_title || "",
    season: row.season,
    episode: row.episode,
    snapshot: parseJson(row.snapshot_json, {}) || {},
    dismissed_at: Number(row.dismissed_at || 0),
  };
}

export function listUpNextDismissals() {
  return selectAllStmt.all().map(rowToDismissal);
}

function findDismissalByAliases(aliases = [], item = {}) {
  const wanted = new Set(aliases);
  if (!wanted.size) return null;
  for (const row of selectAllStmt.all()) {
    const stored = parseJson(row.aliases_json, []) || [];
    if (!stored.some((alias) => wanted.has(alias))) continue;
    const dismissal = rowToDismissal(row);
    if (!provenDifferentShow(dismissal, item)) return dismissal;
  }
  return null;
}

export function restoreUpNextDismissal(id) {
  const key = text(id);
  if (!key) return false;
  const removed = deleteStmt.run(key).changes > 0;
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Up Next dismissal restored");
  }
  return removed;
}

export function restoreAllUpNextDismissals() {
  const removed = deleteAllStmt.run().changes;
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("All Up Next dismissals restored");
  }
  return removed;
}

// An explicit local unwatch makes any matching dismissal stale: the item is
// eligible to enter Up Next again. Keep this server-side so the cleanup still
// happens when a provider is unavailable, the browser is stale, or the
// unwatch originated from another Plembfin client.
export function restoreUpNextDismissalsForMedia(item = {}, { after = 0 } = {}) {
  const wanted = new Set(dismissalAliases(item));
  if (!wanted.size) return 0;
  const threshold = Number(after) || 0;
  const matches = selectAllStmt.all()
    .map(rowToDismissal)
    .filter((dismissal) => threshold <= 0 || dismissal.dismissed_at <= threshold)
    .filter((dismissal) => !provenDifferentShow(dismissal, item))
    .filter((dismissal) => dismissal.aliases.some((alias) => wanted.has(alias)) || dismissalMatchesRematchedEpisode(dismissal, item));
  if (!matches.length) return 0;
  const removed = db.transaction(() => matches.reduce((count, dismissal) => (
    count + deleteStmt.run(dismissal.id).changes
  ), 0)).immediate();
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Up Next dismissal restored after unwatch");
  }
  return removed;
}

// Clean up rows written before the server-side unwatch hook existed. The
// dismissed popup is allowed to reconcile itself from canonical local history,
// so a stale browser or an older build cannot leave a permanently visible
// dismissal behind. The unwatch time is the row's created_at: later bookkeeping
// (dispatch telemetry, artwork, ids) bumps updated_at, and comparing against
// that deleted the dismissal Remove from Up Next records just after its unwatch.
export function restoreUpNextDismissalsSupersededByUnwatch() {
  let restored = 0;
  for (const row of selectUnwatchedHistoryStmt.all(0)) {
    restored += restoreUpNextDismissalsForMedia({
      ...row,
      media_type: row.media_type || "episode",
      show_title: row.show_title || "",
      show_tmdb_id: row.tmdb_id || "",
      show_tvdb_id: row.tvdb_id || "",
      show_imdb_id: row.imdb_id || "",
    }, { after: row.created_at || row.updated_at });
  }
  return restored;
}

// Returns a predicate rather than testing one item at a time: the projection
// checks every candidate, and re-reading and re-parsing the table for each one
// turns a cheap filter into a per-item table scan.
export function createUpNextDismissalFilter() {
  const dismissals = listUpNextDismissals();
  if (!dismissals.length) {
    return { isDismissed: () => false, dismissedAt: () => 0, count: 0 };
  }
  // An alias can belong to several dismissals (two same-title shows share
  // show:title), so keep them all, newest first, and skip a different show's.
  const byAlias = new Map();
  for (const dismissal of dismissals) {
    for (const alias of dismissal.aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias).push(dismissal);
    }
  }
  for (const list of byAlias.values()) list.sort((a, b) => b.dismissed_at - a.dismissed_at);
  const lookup = (candidate) => {
    for (const alias of dismissalAliases(candidate)) {
      const hit = byAlias.get(alias)?.find((dismissal) => !provenDifferentShow(dismissal, candidate));
      if (hit) return hit;
    }
    return null;
  };
  return {
    count: dismissals.length,
    dismissedAt: (candidate) => lookup(candidate)?.dismissed_at || 0,
    isDismissed: (candidate) => Boolean(lookup(candidate)),
    match: lookup,
  };
}
