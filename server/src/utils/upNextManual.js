import { db, bumpUpNextVersion } from "../db.js";

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason, { priority: true }))
    .catch((error) => console.error(`[up-next] Manual queue sync request failed: ${error?.message || error}`));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function normalizedTitle(value = "") {
  return text(value)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function manualUpNextShowKey(show = {}) {
  const tmdbId = text(show.tmdb_id || show.tmdbId || show.show_tmdb_id || show.showTmdbId);
  const tvdbId = text(show.tvdb_id || show.tvdbId || show.show_tvdb_id || show.showTvdbId);
  const imdbId = text(show.imdb_id || show.imdbId || show.show_imdb_id || show.showImdbId);
  const title = normalizedTitle(show.title || show.show_title || show.showTitle);
  if (tmdbId) return `tmdb:${tmdbId.toLowerCase()}`;
  if (tvdbId) return `tvdb:${tvdbId.toLowerCase()}`;
  if (imdbId) return `imdb:${imdbId.toLowerCase()}`;
  return title ? `title:${title}` : "";
}

function parseTargetSeason(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

const selectAllStmt = db.prepare("SELECT * FROM up_next_manual_shows ORDER BY added_at ASC, id ASC");
const selectByIdStmt = db.prepare("SELECT * FROM up_next_manual_shows WHERE id = ?");
const upsertStmt = db.prepare(`
  INSERT INTO up_next_manual_shows
    (id, title, tmdb_id, tvdb_id, imdb_id, poster_url, target_season, added_at, updated_at)
  VALUES (@id, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @target_season, @added_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    imdb_id = excluded.imdb_id,
    poster_url = excluded.poster_url,
    target_season = excluded.target_season,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare("DELETE FROM up_next_manual_shows WHERE id = ?");

function rowToManualShow(row) {
  return {
    id: row.id,
    title: row.title || "",
    tmdb_id: row.tmdb_id || "",
    tvdb_id: row.tvdb_id || "",
    imdb_id: row.imdb_id || "",
    poster_url: row.poster_url || "",
    target_season: parseTargetSeason(row.target_season),
    added_at: Number(row.added_at || 0),
    updated_at: Number(row.updated_at || 0),
    episode_count: 1,
    source: "manual",
  };
}

export function listManualUpNextShows() {
  return selectAllStmt.all().map(rowToManualShow);
}

export function upsertManualUpNextShow(show = {}, { now = Date.now() } = {}) {
  const title = text(show.title || show.show_title || show.showTitle);
  const id = manualUpNextShowKey(show);
  if (!title || !id) return null;
  const existing = selectByIdStmt.get(id);
  const timestamp = Number(now) || Date.now();
  upsertStmt.run({
    id,
    title,
    tmdb_id: text(show.tmdb_id || show.tmdbId || show.show_tmdb_id || show.showTmdbId) || null,
    tvdb_id: text(show.tvdb_id || show.tvdbId || show.show_tvdb_id || show.showTvdbId) || null,
    imdb_id: text(show.imdb_id || show.imdbId || show.show_imdb_id || show.showImdbId) || null,
    poster_url: text(show.poster_url || show.posterUrl || show.show_poster_url || show.showPosterUrl) || null,
    target_season: parseTargetSeason(show.target_season ?? show.targetSeason ?? show.season),
    added_at: Number(existing?.added_at) || timestamp,
    updated_at: timestamp,
  });
  bumpUpNextVersion();
  queueAutomaticUpNextSync("Manual Up Next show changed");
  return rowToManualShow(selectByIdStmt.get(id));
}

export function removeManualUpNextShow(show = {}) {
  const id = text(show.id) || manualUpNextShowKey(show);
  if (!id) return false;
  const removed = deleteStmt.run(id).changes > 0;
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("Manual Up Next show removed");
  }
  return removed;
}
