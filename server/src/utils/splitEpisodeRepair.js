import crypto from "node:crypto";
import { db } from "../db.js";
import { invalidateHistoryDerivedCaches, mediaKeyFor } from "./dataRepo.js";
import { collectServerWatchedItems } from "./forceSyncPlanner.js";
import { resolveSeriesIds } from "./seriesIdentity.js";
import { createPlektBackup } from "./plektBackups.js";
import { runWithConcurrency } from "./concurrency.js";

// Repair Split Episode Shows (plan/active/emby-reporter-feedback/step6-split-episode-repair.md).
//
// Settings Force Sync Import Watched Status once stored an Emby/Jellyfin
// episode's own provider ids where the series ids belong, so every episode
// became its own "show". The automatic repairEpisodeSeriesIdentity() cannot
// recover these because no two rows share an id (decision 15). This repair
// asks the media server instead, and is deliberately narrow:
//
//   - A row is proven only when its stored ids exactly equal the ids Force
//     Sync reads for one watched Emby/Jellyfin episode, season and episode
//     match, and that episode's SeriesId resolves to series ids. No title
//     matching. Anything else is skipped and listed.
//   - Audit and repair are separate (decision 2); the repair re-proves every
//     row, takes a full Plekt backup first and records an undo log.
//   - Only watch_history and playback_progress are rekeyed. Rows that would
//     land on an existing key are skipped, never merged.
//   - Nothing is dispatched and sync_dispatch_telemetry is untouched
//     (decision 4). Earlier deliveries are listed for a manual check.

const SOURCES = ["emby", "jellyfin"];
const PROVIDERS = ["imdb", "tmdb", "tvdb"];
const LOOKUP_CONCURRENCY = 4;
const REKEYED_TABLES = new Set(["watch_history", "playback_progress", "split_episode_repair_log"]);

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function idsOf(source = {}, suffix = "") {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, clean(source[`${provider}${suffix}`])]));
}

function hasAnyId(ids = {}) {
  return PROVIDERS.some((provider) => ids[provider]);
}

function sameIds(left = {}, right = {}) {
  return PROVIDERS.every((provider) => (left[provider] || null) === (right[provider] || null));
}

function coordinate(season, episode) {
  if (season == null || episode == null || season === "" || episode === "") return "";
  const s = Number(season);
  const e = Number(episode);
  return Number.isFinite(s) && Number.isFinite(e) ? `${s}|${e}` : "";
}

function exactKey(season, episode, ids) {
  const coords = coordinate(season, episode);
  return coords ? `${coords}|${PROVIDERS.map((provider) => ids[provider] || "").join("|")}` : "";
}

function seriesTitleFromItem(item = {}) {
  return String(item.title || "").replace(/\s+-\s+S[\d?]+E[\d?]+$/i, "").trim();
}

function showKeyFor(ids) {
  return `ids:${PROVIDERS.map((provider) => ids[provider] || "").join("|")}`;
}

// Targets the row's dispatch telemetry records as delivered.
export function deliveredTargets(telemetry = "") {
  const targets = new Set();
  for (const line of String(telemetry || "").split(/\r?\n/)) {
    const match = line.match(/^(?:target\s+)?([a-z][a-z0-9_-]*)\s+status:\s*success\b/i);
    if (match && match[1].toLowerCase() !== "dispatch") targets.add(match[1].toLowerCase());
  }
  return [...targets];
}

function mediaKeyTables(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((row) => row.name)
    .filter((name) => !REKEYED_TABLES.has(name) && !name.startsWith("sqlite_"))
    .filter((name) => database.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().some((column) => column.name === "media_key"));
}

function otherTableCounts(database, tables, keys) {
  const counts = {};
  if (!keys.length) return counts;
  const placeholders = keys.map(() => "?").join(", ");
  for (const table of tables) {
    const count = database.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}" WHERE media_key IN (${placeholders})`).get(...keys)?.n || 0;
    if (count) counts[table] = count;
  }
  return counts;
}

// Read-only. Scans the watched Emby/Jellyfin episodes, resolves their series
// ids and lists every history row that is provably keyed on one episode's own
// ids, grouped by the show it belongs to.
export async function auditSplitEpisodeShows({
  config = {},
  database = db,
  scan = collectServerWatchedItems,
  resolveSeries = resolveSeriesIds,
} = {}) {
  const result = await scan(config, { scope: { servers: SOURCES } });
  const serverErrors = (result?.scopeErrors || []).map((entry) => ({ server: entry.server, error: entry.error || "library scope could not be verified" }));
  const scannedServers = SOURCES.filter((source) => (result?.itemsByServer?.[source] || []).length);

  const exactIndex = new Map();
  const partialIndex = new Map();
  const lookups = new Map();
  for (const source of SOURCES) {
    for (const item of result?.itemsByServer?.[source] || []) {
      if (item?.type !== "episode") continue;
      const ids = idsOf(item);
      const key = exactKey(item.season, item.episode, ids);
      if (!key || !hasAnyId(ids)) continue;
      const seriesItemId = clean(item.seriesItemId);
      const entry = { source, seriesItemId, title: seriesTitleFromItem(item), lookupKey: seriesItemId ? `${source}:${seriesItemId}` : "" };
      if (!exactIndex.has(key)) exactIndex.set(key, []);
      exactIndex.get(key).push(entry);
      for (const provider of PROVIDERS) {
        if (!ids[provider]) continue;
        const partialKey = `${coordinate(item.season, item.episode)}|${provider}:${ids[provider]}`;
        if (!partialIndex.has(partialKey)) partialIndex.set(partialKey, []);
        partialIndex.get(partialKey).push(entry);
      }
      if (entry.lookupKey && !lookups.has(entry.lookupKey)) lookups.set(entry.lookupKey, { source, seriesItemId, ids: null });
    }
  }

  await runWithConcurrency([...lookups.values()], async (lookup) => {
    lookup.ids = await resolveSeries(lookup.source, lookup.seriesItemId, config?.[lookup.source]).catch(() => null);
  }, LOOKUP_CONCURRENCY);

  const rows = database.prepare(
    "SELECT id, media_key, title, show_title, season, episode, imdb_id, tmdb_id, tvdb_id, watched_at, source, sync_dispatch_telemetry FROM watch_history WHERE media_type = 'episode'",
  ).all();

  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    const oldIds = idsOf(row, "_id");
    if (!hasAnyId(oldIds)) continue;
    const base = {
      rowId: row.id,
      title: row.show_title || row.title || "",
      season: row.season,
      episode: row.episode,
      oldIds,
      oldKey: row.media_key,
      source: row.source || "",
    };
    const matches = exactIndex.get(exactKey(row.season, row.episode, oldIds)) || [];
    if (!matches.length) {
      // Shares an id with a server episode at the same coordinates but is not
      // an exact match: listed, never repaired.
      const coords = coordinate(row.season, row.episode);
      const partial = coords && PROVIDERS.some((provider) => oldIds[provider]
        && (partialIndex.get(`${coords}|${provider}:${oldIds[provider]}`) || []).some((entry) => {
          const series = lookups.get(entry.lookupKey)?.ids;
          return !series || !sameIds(normalizeSeries(series), oldIds);
        }));
      if (partial) skipped.push({ ...base, reason: "ids-differ" });
      continue;
    }
    const resolved = matches.map((entry) => (entry.lookupKey ? lookups.get(entry.lookupKey)?.ids : null));
    if (resolved.some((ids) => !ids)) {
      skipped.push({ ...base, reason: "lookup-failed" });
      continue;
    }
    const distinct = new Map(resolved.map((ids) => [showKeyFor(normalizeSeries(ids)), normalizeSeries(ids)]));
    if (distinct.size !== 1) {
      skipped.push({ ...base, reason: "ambiguous" });
      continue;
    }
    const newIds = [...distinct.values()][0];
    if (sameIds(newIds, oldIds)) continue;
    const newKey = mediaKeyFor({ media_type: "episode", season: row.season, episode: row.episode, imdb_id: newIds.imdb, tmdb_id: newIds.tmdb, tvdb_id: newIds.tvdb, title: row.title });
    candidates.push({
      ...base,
      title: row.show_title || matches[0].title || row.title || "",
      seriesTitle: matches[0].title || row.show_title || "",
      newIds,
      newKey,
      watchedAt: row.watched_at || null,
      delivered: deliveredTargets(row.sync_dispatch_telemetry),
    });
  }

  // Never merge: an episode that already has a history row on the target key,
  // or on any key sharing one of the series ids (a tvdb-only row, say), or
  // that two different old keys would both move to, is skipped.
  const candidateIds = new Set(candidates.map((candidate) => candidate.rowId));
  const oldKeysByNewKey = new Map();
  for (const candidate of candidates) {
    if (!oldKeysByNewKey.has(candidate.newKey)) oldKeysByNewKey.set(candidate.newKey, new Set());
    oldKeysByNewKey.get(candidate.newKey).add(candidate.oldKey);
  }
  const occupiedStmt = database.prepare(`SELECT id FROM watch_history WHERE media_key = ?
    OR (media_type = 'episode' AND season = ? AND episode = ? AND (imdb_id = ? OR tmdb_id = ? OR tvdb_id = ?))`);
  const proven = [];
  for (const candidate of candidates) {
    const { imdb, tmdb, tvdb } = candidate.newIds;
    const occupied = occupiedStmt.all(candidate.newKey, candidate.season, candidate.episode, imdb, tmdb, tvdb).some((row) => !candidateIds.has(row.id));
    if (occupied || oldKeysByNewKey.get(candidate.newKey).size > 1) {
      skipped.push({ ...candidate, reason: "collision" });
      continue;
    }
    proven.push(candidate);
  }

  const tables = mediaKeyTables(database);
  const progressStmt = database.prepare("SELECT media_key FROM playback_progress WHERE media_key = ?");
  const shows = new Map();
  for (const row of proven) {
    const showKey = showKeyFor(row.newIds);
    if (!shows.has(showKey)) shows.set(showKey, { showKey, title: row.seriesTitle || row.title, newIds: row.newIds, rows: [], progress: [], otherTables: {}, delivered: [] });
    shows.get(showKey).rows.push({
      rowId: row.rowId,
      season: row.season,
      episode: row.episode,
      oldIds: row.oldIds,
      oldKey: row.oldKey,
      newKey: row.newKey,
      watchedAt: row.watchedAt,
      source: row.source,
      delivered: row.delivered,
    });
  }
  for (const show of shows.values()) {
    const moves = new Map(show.rows.map((row) => [row.oldKey, row.newKey]));
    for (const [oldKey, newKey] of moves) {
      if (!progressStmt.get(oldKey)) continue;
      show.progress.push({ oldKey, newKey, blocked: Boolean(progressStmt.get(newKey)) });
    }
    show.otherTables = otherTableCounts(database, tables, [...moves.keys()]);
    show.delivered = [...new Set(show.rows.flatMap((row) => row.delivered))].sort();
    show.rows.sort((left, right) => Number(left.season) - Number(right.season) || Number(left.episode) - Number(right.episode));
  }

  const showList = [...shows.values()].sort((left, right) => left.title.localeCompare(right.title));
  return {
    scannedServers,
    serverErrors,
    shows: showList,
    skipped,
    totals: {
      shows: showList.length,
      rows: showList.reduce((total, show) => total + show.rows.length, 0),
      skipped: skipped.length,
      delivered: showList.reduce((total, show) => total + show.rows.filter((row) => row.delivered.length).length, 0),
    },
  };
}

function normalizeSeries(ids = {}) {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, clean(ids[provider])]));
}

// Re-proves the selected shows, backs up, then rekeys only those rows.
// Throws before writing anything when the backup fails.
export async function applySplitEpisodeRepair({
  showKeys = [],
  config = {},
  database = db,
  scan,
  resolveSeries,
  backup = (options) => createPlektBackup(options),
  invalidate = (reason) => invalidateHistoryDerivedCaches(reason, { skipUpNextAutoSync: true }),
  now = Date.now(),
} = {}) {
  const selected = new Set((Array.isArray(showKeys) ? showKeys : []).map((key) => String(key || "")).filter(Boolean));
  if (!selected.size) {
    const error = new Error("Choose at least one show to repair.");
    error.status = 400;
    throw error;
  }
  const audit = await auditSplitEpisodeShows({ config, database, scan, resolveSeries });
  const shows = audit.shows.filter((show) => selected.has(show.showKey));
  const notProven = [...selected].filter((key) => !shows.some((show) => show.showKey === key));
  if (!shows.length) return { runId: null, backup: null, repaired: 0, progressRekeyed: 0, changed: 0, notProven };

  let backupResult;
  try {
    backupResult = await backup({ reason: "split-episode-repair" });
  } catch (error) {
    const wrapped = new Error(`Backup failed, so nothing was changed: ${error?.message || error}`);
    wrapped.status = 409;
    throw wrapped;
  }

  const runId = crypto.randomUUID();
  const backupName = backupResult?.name || null;
  const readRow = database.prepare("SELECT media_key, imdb_id, tmdb_id, tvdb_id FROM watch_history WHERE id = ?");
  const updateRow = database.prepare("UPDATE watch_history SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ?, updated_at = ? WHERE id = ? AND media_key = ?");
  const readProgress = database.prepare("SELECT media_key, imdb_id, tmdb_id, tvdb_id FROM playback_progress WHERE media_key = ?");
  const updateProgress = database.prepare("UPDATE playback_progress SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ? WHERE media_key = ?");
  const log = database.prepare(`INSERT INTO split_episode_repair_log
    (run_id, table_name, row_key, show_title, old_imdb_id, old_tmdb_id, old_tvdb_id, old_media_key, new_imdb_id, new_tmdb_id, new_tvdb_id, new_media_key, backup_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let repaired = 0;
  let progressRekeyed = 0;
  let changed = 0;
  database.transaction(() => {
    for (const show of shows) {
      const { imdb, tmdb, tvdb } = show.newIds;
      for (const row of show.rows) {
        const current = readRow.get(row.rowId);
        if (!current || current.media_key !== row.oldKey || !sameIds(idsOf(current, "_id"), row.oldIds)) {
          changed += 1;
          continue;
        }
        log.run(runId, "watch_history", row.rowId, show.title, row.oldIds.imdb, row.oldIds.tmdb, row.oldIds.tvdb, row.oldKey, imdb, tmdb, tvdb, row.newKey, backupName, now);
        repaired += updateRow.run(imdb, tmdb, tvdb, row.newKey, now, row.rowId, row.oldKey).changes;
      }
      for (const move of show.progress) {
        if (move.blocked || readProgress.get(move.newKey)) continue;
        const current = readProgress.get(move.oldKey);
        if (!current) continue;
        log.run(runId, "playback_progress", move.oldKey, show.title, clean(current.imdb_id), clean(current.tmdb_id), clean(current.tvdb_id), move.oldKey, imdb, tmdb, tvdb, move.newKey, backupName, now);
        progressRekeyed += updateProgress.run(imdb, tmdb, tvdb, move.newKey, move.oldKey).changes;
      }
    }
  })();

  if (repaired || progressRekeyed) await invalidate("splitEpisodeRepair");
  return { runId, backup: backupName, repaired, progressRekeyed, changed, notProven };
}

export function listSplitEpisodeRepairRuns({ database = db } = {}) {
  const runs = database.prepare(`SELECT run_id AS runId, MIN(created_at) AS createdAt, MAX(backup_name) AS backup,
      SUM(CASE WHEN table_name = 'watch_history' THEN 1 ELSE 0 END) AS rows,
      SUM(CASE WHEN table_name = 'playback_progress' THEN 1 ELSE 0 END) AS progress,
      SUM(CASE WHEN reverted_at IS NULL THEN 1 ELSE 0 END) AS active
    FROM split_episode_repair_log GROUP BY run_id ORDER BY createdAt DESC`).all();
  const showsStmt = database.prepare("SELECT DISTINCT show_title FROM split_episode_repair_log WHERE run_id = ? ORDER BY show_title");
  return runs.map((run) => ({
    ...run,
    shows: showsStmt.all(run.runId).map((row) => row.show_title).filter(Boolean),
    reverted: !run.active,
  }));
}

// Restores exactly the rows one run changed, and only where they still hold
// the value that run wrote.
export async function undoSplitEpisodeRepair(runId, {
  database = db,
  invalidate = (reason) => invalidateHistoryDerivedCaches(reason, { skipUpNextAutoSync: true }),
  now = Date.now(),
} = {}) {
  const id = String(runId || "").trim();
  const entries = id ? database.prepare("SELECT * FROM split_episode_repair_log WHERE run_id = ? AND reverted_at IS NULL").all(id) : [];
  if (!entries.length) {
    const error = new Error("No repair to undo for that run.");
    error.status = 404;
    throw error;
  }
  const restoreRow = database.prepare("UPDATE watch_history SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ?, updated_at = ? WHERE id = ? AND media_key = ?");
  const progressAt = database.prepare("SELECT 1 FROM playback_progress WHERE media_key = ?");
  const restoreProgress = database.prepare("UPDATE playback_progress SET imdb_id = ?, tmdb_id = ?, tvdb_id = ?, media_key = ? WHERE media_key = ?");
  const markReverted = database.prepare("UPDATE split_episode_repair_log SET reverted_at = ? WHERE run_id = ? AND table_name = ? AND row_key = ?");
  let restored = 0;
  let progressRestored = 0;
  let changed = 0;
  database.transaction(() => {
    for (const entry of entries) {
      let changes = 0;
      if (entry.table_name === "watch_history") {
        changes = restoreRow.run(entry.old_imdb_id, entry.old_tmdb_id, entry.old_tvdb_id, entry.old_media_key, now, entry.row_key, entry.new_media_key).changes;
        restored += changes;
      } else if (entry.table_name === "playback_progress" && !progressAt.get(entry.old_media_key)) {
        changes = restoreProgress.run(entry.old_imdb_id, entry.old_tmdb_id, entry.old_tvdb_id, entry.old_media_key, entry.new_media_key).changes;
        progressRestored += changes;
      }
      if (changes) markReverted.run(now, entry.run_id, entry.table_name, entry.row_key);
      else changed += 1;
    }
  })();
  if (restored || progressRestored) await invalidate("splitEpisodeRepairUndo");
  return { runId: id, restored, progressRestored, changed };
}
