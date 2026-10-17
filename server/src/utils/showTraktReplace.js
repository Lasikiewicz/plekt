import { db, toJson, bumpDataVersion } from "../db.js";
import { readShowNumbering } from "./seasonSource.js";
import { showNumberMap } from "./showSeasonTranslation.js";
import { translateEpisode } from "./episodeNumberMap.js";
import { withFreshTraktConnection, withTraktRateLimitRetry } from "./trackerDispatcher.js";
import { fetchTraktSeasonEpisodes, fetchTraktShowByProviderId, fetchTraktShowPlayHistory, removeTraktHistoryIds, setTraktWatchHistoryBatch, trackerMediaKey } from "./traktClient.js";
import { getTrackerConnection, recordTrackerOutboundBatch, recordTrackerPlay } from "./trackerConnectionRepo.js";
import { buildWatchProvenance, normalizeWatchProvenance } from "./watchProvenance.js";
import { normalizeImportedTraktRow, safeTraktReplaceItems, traktPlayKey } from "./showTraktHistorySafety.js";
import { queueShowProgressUpdate, flushShowProgressUpdates } from "./showProgressCache.js";

// Fix Match second confirmation: replace one translated show's plays on Trakt.
// Add and verify missing target dates first, then remove only uniquely
// identified old history ids. Trakt-only plays stay on their canonical episode.
// Every intent goes into the outbound ledger before its write, so the next
// poll reads the removals and re-adds as Plekt's own (no echo). Then each
// translated row gets provider_overrides.trakt, so later watches go to the
// same Trakt episode and inbound Trakt events map back
// (traktInboundNumbering.js). Rows with no partner are left as they are.

const BATCH_SIZE = 100;

function showIdsOf(show = {}, { tvdbId, tmdbId }) {
  return {
    ...(show.imdb_id ? { imdb: String(show.imdb_id) } : {}),
    tmdb: String(tmdbId || show.tmdb_id || ""),
    tvdb: String(tvdbId || show.tvdb_id || ""),
  };
}

// Every play of every watched row, with the row ids that carry it.
function playsOf(show = {}) {
  const rows = (Array.isArray(show.episodes) ? show.episodes : []).filter((row) => {
    const action = String(row.sync_action || "watched").toLowerCase();
    return !["unwatched", "unplayed"].includes(action) && Number(row.episode) > 0 && Number(row.season) >= 0;
  });
  return rows.flatMap((row) => {
    const history = Array.isArray(row.playHistory) && row.playHistory.length ? row.playHistory : [{ id: row.id, watched_at: row.watched_at }];
    return history.map((play) => {
      const saved = db.prepare("SELECT source, watch_provenance FROM watch_history WHERE id=?").get(String(play.id || row.id || "")) || row;
      return {
      season: Number(row.season),
      episode: Number(row.episode),
      ids: [String(play.id || row.id || "")].filter(Boolean),
      dates: [play.watched_at].filter(Boolean),
      imported: String(saved.source || "").toLowerCase().includes("trakt") && !normalizeWatchProvenance(saved.watch_provenance)?.provider_overrides?.trakt,
    }; });
  });
}

// What the replace would do, without calling Trakt. Null when the show is not
// translated or its map cannot be built.
export async function planShowTraktReplace({ show, tvdbId, tmdbId, remoteHistory }) {
  const numbering = readShowNumbering(tvdbId);
  if (!numbering.translate) return null;
  const built = await showNumberMap({ tvdbId, tmdbId: tmdbId || show?.tmdb_id, numbering });
  if (!built) return null;
  const moves = [];
  const review = [];
  for (const play of playsOf(show)) {
    const canonicalImport = play.imported && (!remoteHistory || remoteHistory.some((entry) => play.dates.some((date) => traktPlayKey(play, date) === traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString()))));
    const mapped = translateEpisode(built.map, play.season, play.episode);
    const storedImport = mapped && remoteHistory?.some((entry) => play.dates.some((date) => traktPlayKey(mapped, date) === traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString())));
    if (play.imported && canonicalImport && storedImport && (mapped.season !== play.season || mapped.episode !== play.episode)) {
      review.push({ season: play.season, episode: play.episode }); continue;
    }
    if (play.imported && remoteHistory && !canonicalImport && !storedImport) {
      review.push({ season: play.season, episode: play.episode }); continue;
    }
    const inverse = canonicalImport ? [...built.map.pairs].filter(([, target]) => target.season === play.season && target.episode === play.episode) : [];
    const stored = inverse.length === 1 ? Object.fromEntries(["season", "episode"].map((key, index) => [key, Number(inverse[0][0].split(":")[index])])) : null;
    const target = canonicalImport ? (stored ? { season: play.season, episode: play.episode } : null) : translateEpisode(built.map, play.season, play.episode);
    if (target) {
      const grouped = moves.find((move) => move.season === play.season && move.episode === play.episode && move.to.season === target.season && move.to.episode === target.episode && JSON.stringify(move.stored || null) === JSON.stringify(stored));
      if (grouped) { grouped.ids.push(...play.ids); grouped.dates.push(...play.dates); }
      else moves.push({ ...play, to: target, ...(canonicalImport ? { stored } : {}) });
    }
    else review.push({ season: play.season, episode: play.episode });
  }
  return {
    source: numbering.source,
    rowNumbering: numbering.rowNumbering,
    episodes: new Set(moves.map((move) => `${move.season}:${move.episode}`)).size,
    plays: moves.reduce((total, move) => total + move.dates.length, 0),
    review,
    moves,
  };
}

function episodeMedia(ids, season, episode, showTitle, watchedAt) {
  return { type: "episode", ids, season, episode, showTitle, ...(watchedAt ? { watched_at: watchedAt } : {}) };
}

function batches(items) {
  const out = [];
  for (let index = 0; index < items.length; index += BATCH_SIZE) out.push(items.slice(index, index + BATCH_SIZE));
  return out;
}

function playBatches(items) {
  const result = [];
  for (const item of items) {
    let batch = result.find((group) => group.length < BATCH_SIZE && !group.some((other) => other.season === item.season && other.episode === item.episode));
    if (!batch) { batch = []; result.push(batch); }
    batch.push(item);
  }
  return result;
}

function notFoundCount(result = {}) {
  const notFound = result?.not_found || {};
  return Object.values(notFound).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
}

// Checks every new coordinate exists in Trakt's own seasons for this show, so
// nothing is removed when the re-add could not land.
async function missingTraktCoordinates(connection, ids, moves) {
  const show = await fetchTraktShowByProviderId(connection, "tmdb", ids.tmdb).catch(() => null)
    || await fetchTraktShowByProviderId(connection, "tvdb", ids.tvdb).catch(() => null);
  if (!show?.ids?.trakt) return { error: "Trakt could not find this show by its TMDB or TVDB id." };
  const seasons = new Map();
  for (const season of new Set(moves.map((move) => move.to.season))) {
    const episodes = await fetchTraktSeasonEpisodes(connection, show.ids.trakt, season);
    seasons.set(season, new Set(episodes.map((episode) => Number(episode?.number)).filter(Number.isInteger)));
  }
  const missing = moves.filter((move) => !seasons.get(move.to.season)?.has(move.to.episode)).map((move) => move.to);
  return { missing, traktId: show.ids.trakt };
}

const updateProvenanceStmt = db.prepare("UPDATE watch_history SET watch_provenance = ?, updated_at = ?, sync_retry_count = 0, sync_next_retry_at = 0 WHERE id = ?");
const selectProvenanceStmt = db.prepare("SELECT id, source, watch_provenance FROM watch_history WHERE id = ?");

// Telemetry is left as it is, so no row is re-dispatched (decision 4).
function writeTraktOverrides(moves, tmdbId, now) {
  let updated = 0;
  db.transaction(() => {
    for (const move of moves) {
      for (const id of move.ids) {
        const row = selectProvenanceStmt.get(id);
        if (!row) continue;
        const current = normalizeWatchProvenance(row.watch_provenance) || buildWatchProvenance({ source: row.source });
        const next = normalizeWatchProvenance({
          ...current,
          provider_overrides: { ...(current.provider_overrides || {}), trakt: { tmdb_id: String(tmdbId), season: move.to.season, episode: move.to.episode } },
        });
        updateProvenanceStmt.run(toJson(next), now, id);
        updated += 1;
      }
    }
  })();
  return updated;
}

export async function replaceShowOnTrakt({ show, tvdbId, tmdbId, logger = () => {} }) {
  const connectionState = getTrackerConnection("trakt");
  if (!connectionState || connectionState.status !== "connected") return { ok: false, error: "Trakt is not connected." };
  let plan = await planShowTraktReplace({ show, tvdbId, tmdbId });
  if (!plan) return { ok: false, error: "This show does not use a translated season choice, so there is nothing to replace on Trakt." };
  if (!plan.moves.length) return { ok: false, error: "No watched episode of this show has a match in the new numbering." };
  const connection = await withFreshTraktConnection();
  if (!connection) return { ok: false, error: "Trakt is not connected." };
  const ids = showIdsOf(show, { tvdbId, tmdbId });
  const showTitle = show.title || "";

  let check = await missingTraktCoordinates(connection, ids, plan.moves);
  if (check.error) return { ok: false, error: check.error };
  if (check.missing.length) {
    const listed = check.missing.slice(0, 8).map((to) => `S${String(to.season).padStart(2, "0")}E${String(to.episode).padStart(2, "0")}`).join(", ");
    return { ok: false, error: `Trakt does not have ${check.missing.length} of the new episode numbers (for example ${listed}), so nothing was changed on Trakt.` };
  }

  const before = await fetchTraktShowPlayHistory(connection, check.traktId);
  plan = await planShowTraktReplace({ show, tvdbId, tmdbId, remoteHistory: before });
  if (!plan.moves.length) return { ok: false, error: "No play has an unambiguous stored-to-Trakt match; review imported episode numbering first." };
  check = await missingTraktCoordinates(connection, ids, plan.moves);
  if (check.error || check.missing.length) return { ok: false, error: check.error || "A target episode is missing on Trakt; nothing was changed." };
  const safe = safeTraktReplaceItems(plan.moves, before, (season, episode, date) => episodeMedia(ids, season, episode, showTitle, date));
  const addItems = safe.add;
  // Trakt accounts can disable multiple plays. The API then replaces the
  // existing date even for an append request, and does not expose that setting.
  // Without proof that an append is safe, preserve remote history and refuse.
  if (addItems.some((item) => before.some((entry) => entry.media.season === item.season && entry.media.episode === item.episode))) {
    return { ok: false, error: "Trakt already holds another play at a target episode. Nothing was changed: this account may replace existing dates when multiple plays are disabled. Reconcile those plays before replacing this show." };
  }
  const addKeys = new Map([...safe.desired.values()].map((media) => [trackerMediaKey(media), media]));
  recordTrackerOutboundBatch("trakt", [...addKeys.entries()].map(([mediaKey, media]) => ({ mediaKey, media, state: "watched" })));
  let added = 0;
  let rejected = 0;
  for (const batch of playBatches(addItems)) {
    const result = await withTraktRateLimitRetry(() => setTraktWatchHistoryBatch(connection, batch, "watched", { lane: "sync" }));
    rejected += notFoundCount(result);
    added += batch.length;
    logger(`Trakt replace: re-added ${added}/${addItems.length} play(s).`);
  }

  if (rejected) throw new Error("Trakt rejected target plays; no old history was removed. Retry after fixing the match.");
  const confirmed = await fetchTraktShowPlayHistory(connection, check.traktId);
  const confirmedKeys = new Set(confirmed.map((entry) => traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString())));
  if ([...safe.desired.keys()].some((key) => !confirmedKeys.has(key))) throw new Error("Trakt has not confirmed every target play; no old history was removed. Retry later.");
  let cleared = 0;
  const removedIds = new Set(safe.remove.map((entry) => entry.historyId));
  const final = confirmed.filter((entry) => !removedIds.has(entry.historyId));
  recordTrackerOutboundBatch("trakt", safe.remove.map((entry) => ({ mediaKey: trackerMediaKey(entry.media), media: entry.media,
    state: final.some((kept) => trackerMediaKey(kept.media) === trackerMediaKey(entry.media)) ? "watched" : "unwatched" })));
  for (const batch of batches(safe.remove)) {
    await withTraktRateLimitRetry(() => removeTraktHistoryIds(connection, batch.map((entry) => entry.historyId)));
    cleared += batch.length;
  }
  for (const entry of final) {
    const key = traktPlayKey(entry.media, new Date(entry.watchedAt).toISOString());
    if (safe.desired.has(key)) recordTrackerPlay("trakt", { historyId: entry.historyId, mediaKey: trackerMediaKey(entry.media), watchedAt: new Date(entry.watchedAt).toISOString(), watchRecordId: "" });
  }

  const now = Date.now();
  const updatedRows = db.transaction(() => {
    for (const move of plan.moves) if (move.stored) for (const id of move.ids) normalizeImportedTraktRow(id, move.stored);
    return writeTraktOverrides(plan.moves, ids.tmdb, now);
  })();
  bumpDataVersion("show-trakt-replace");
  if (plan.moves.some((move) => move.stored)) { queueShowProgressUpdate(showTitle); await flushShowProgressUpdates(); }
  return { ok: true, episodes: plan.episodes, plays: plan.plays, added, preserved: before.length - cleared, cleared, rejected, updatedRows, review: plan.review };
}
