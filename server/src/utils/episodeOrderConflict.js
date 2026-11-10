import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { getManualWatchReview, setManualWatchReviewStatus } from "./manualWatchReview.js";
import { episodeOrderRevision, orderLinks, readEpisodeOrder } from "./episodeOrder.js";
import { getTvdbOrderCatalogue } from "./tvdbOrderGateway.js";
import { createWatchHistoryBackup, verifyWatchBackup } from "./watchHistoryBackups.js";
import { invalidateHistoryDerivedCaches, mediaKeyFor } from "./dataRepo.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { getTvdbSeriesExtended, shapeTvdbSeriesAsTmdb } from "./tvdbGateway.js";

const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = message => Object.assign(new Error(message), { status: 409 });
function keyedSnapshot(keys) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(item => item.name)
    .filter(name => !name.startsWith("sqlite_") && !["manual_watch_reviews", "live_change_events", "watch_audit_events"].includes(name));
  return tables.flatMap(table => {
    const safe = table.replace(/"/g, '""');
    if (!db.prepare(`PRAGMA table_info("${safe}")`).all().some(column => column.name === "media_key")) return [];
    const rows = db.prepare(`SELECT * FROM "${safe}" WHERE media_key IN (?,?)`).all(...keys);
    return rows.length ? [[table, rows]] : [];
  });
}

export async function previewEpisodeOrderConflict(id) {
  const review = getManualWatchReview(id);
  if (!review || review.status !== "pending" || review.review_kind !== "episode_order_conflict") throw fail("This conflict is no longer pending.");
  const row = db.prepare("SELECT * FROM watch_history WHERE id=?").get(review.media.rowId);
  if (!row || (parseJson(row.watch_provenance) || {}).episode_order) throw fail("This history changed. Retry sync to review the current conflict.");
  const catalogue = await getTvdbOrderCatalogue(row.tvdb_id);
  const saved = readEpisodeOrder(row.tvdb_id);
  const links = orderLinks(catalogue, saved, saved.order);
  const options = links.map(link => {
    const displayed = catalogue.orders[saved.order]?.find(item => item.id === link.dvdId);
    const aired = catalogue.orders.official?.find(item => item.id === link.airedId);
    return displayed && aired ? { dvdId: link.dvdId, airedId: link.airedId, displayed, aired } : null;
  }).filter(option => option && ((option.aired.season === row.season && option.aired.episode === row.episode)
    || (option.displayed.season === row.season && option.displayed.episode === row.episode)));
  let seriesIds = null;
  if (row.imdb_id || row.tmdb_id) {
    const extended = await getTvdbSeriesExtended(row.tvdb_id).catch(() => null);
    if (String(extended?.id || "") === String(row.tvdb_id)) seriesIds = shapeTvdbSeriesAsTmdb(extended).external_ids;
  }
  const related = options.map(option => keyedSnapshot([row.media_key, mediaKeyFor({ ...row, season:option.aired.season, episode:option.aired.episode })]));
  const revision = digest([row, episodeOrderRevision(catalogue, saved), related, seriesIds]);
  return { revision, row: { id: row.id, title: row.title, watchedAt: row.watched_at, source: row.source, season: row.season, episode: row.episode },
    incoming: review.media.incoming, order: saved.order, options, seriesIds };
}

export async function repairEpisodeOrderConflict(id, { revision, airedId, dvdId, confirm } = {}, dependencies = {}) {
  if (confirm !== true) throw fail("Confirm the episode identity before repairing history.");
  if (isAuthoritativeRestoreActive()) throw fail("A restore is in progress. Nothing was changed.");
  const preview = await previewEpisodeOrderConflict(id);
  if (revision !== preview.revision) throw fail("History or episode mappings changed. Review the current preview again.");
  const option = preview.options.find(item => item.airedId === Number(airedId) && item.dvdId === Number(dvdId));
  if (!option) throw fail("Choose one of the episodes in the current preview.");
  const row = db.prepare("SELECT * FROM watch_history WHERE id=?").get(preview.row.id);
  const next = { ...row, season: option.aired.season, episode: option.aired.episode };
  const newKey = mediaKeyFor(next);
  const moving = row.media_key !== newKey;
  const relatedRevision = digest(keyedSnapshot([row.media_key, newKey]));
  if (moving) {
    if ((row.imdb_id && String(row.imdb_id).toLowerCase() !== String(preview.seriesIds?.imdb_id || "").toLowerCase())
      || (row.tmdb_id && String(row.tmdb_id) !== String(preview.seriesIds?.tmdb_id || ""))) throw fail("The earlier watch has IMDb or TMDB IDs that could not be verified as this series. Nothing was changed.");
    const count = db.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE media_key=? AND id<>?").get(row.media_key, row.id).n;
    if (count || db.prepare("SELECT 1 FROM watch_history WHERE media_key=? LIMIT 1").get(newKey)) throw fail("Other history shares a coordinate. Nothing was changed; this conflict needs separate review.");
    for (const table of ["playstate", "playback_progress"]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE media_key=?`).get(newKey)) throw fail("The destination already has watched or progress state. Nothing was changed.");
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name)
      .filter(name => !["watch_history", "playstate", "playback_progress", "watch_audit_events", "manual_watch_reviews", "live_change_events"].includes(name) && !name.startsWith("sqlite_"));
    for (const table of tables) {
      const safe = table.replace(/"/g, '""');
      if (db.prepare(`PRAGMA table_info("${safe}")`).all().some(column => column.name === "media_key")
        && db.prepare(`SELECT 1 FROM "${safe}" WHERE media_key IN (?,?) LIMIT 1`).get(row.media_key, newKey)) throw fail(`Other stored data (${table}) uses these coordinates. Nothing was changed; this conflict needs separate review.`);
    }
  }
  const backup = await (dependencies.backup || (async options => {
    const result = await createWatchHistoryBackup(options);
    verifyWatchBackup(result.name);
    return result;
  }))({ reason: "pre-episode-order-repair", mirrorRemote: false });
  const current = await previewEpisodeOrderConflict(id);
  if (current.revision !== revision) throw fail("History or episode mappings changed during backup. Nothing was changed.");
  const provenance = parseJson(row.watch_provenance) || {};
  provenance.episode_order = { tvdbId: row.tvdb_id, dvdId: option.dvdId, airedId: option.airedId, order: preview.order };
  const episodeCode = `S${String(next.season).padStart(2,"0")}E${String(next.episode).padStart(2,"0")}`;
  const title = row.show_title && option.aired.name ? `${row.show_title} - ${episodeCode} - ${option.aired.name}`
    : String(row.title || "").replace(/\bS\d+E\d+\b/i, episodeCode);
  db.transaction(() => {
    if (isAuthoritativeRestoreActive()) throw fail("A restore is in progress. Nothing was changed.");
    if (digest(keyedSnapshot([row.media_key, newKey])) !== relatedRevision) throw fail("Related history or watched state changed during backup. Nothing was changed.");
    if (moving) {
      db.prepare("UPDATE playstate SET media_key=?,season=?,episode=?,title=?,title_lower=? WHERE media_key=?").run(newKey, next.season, next.episode, title, title.toLowerCase(), row.media_key);
      db.prepare("UPDATE playback_progress SET media_key=?,season=?,episode=?,title=? WHERE media_key=?").run(newKey, next.season, next.episode, title, row.media_key);
    }
    db.prepare("UPDATE watch_history SET season=?,episode=?,media_key=?,title=?,title_lower=?,episode_title=?,episode_title_status=?,episode_title_checked_at=?,episode_title_resolution_error=NULL,watch_provenance=?,updated_at=? WHERE id=?")
      .run(next.season, next.episode, newKey, title, title.toLowerCase(), option.aired.name || null, option.aired.name ? "resolved" : "missing", Date.now(), toJson(provenance), Date.now(), row.id);
    setManualWatchReviewStatus(id, "approved", "episode_order_repair");
  })();
  await invalidateHistoryDerivedCaches("episode-order-repair", { skipUpNextAutoSync: true });
  return { ok: true, backup: backup.name };
}
