import { normalizeSeasonSource, readSeasonSource, readShowNumbering } from "./seasonSource.js";
import { db, parseJson } from "../db.js";
import { buildEpisodeNumberMap, detectRowNumbering, planShowTranslation, translateEpisode } from "./episodeNumberMap.js";
import { getTvdbSeriesExtended, tvdbSeasonListsFromExtended } from "./tvdbGateway.js";
import { getTmdbShowSeasonLists } from "./tmdbGateway.js";

// The Fix Match per-show TVDB/TMDB choice. Stored watch rows keep the media
// server's numbers; this module previews and saves the choice, and places a
// translated show's rows on the right episode for the show page.
// See plan/archive/metadata-provider-preference/step4-fix-match.md.

function isWatchedRow(row = {}) {
  const action = String(row.sync_action || "").toLowerCase();
  if (["unwatched", "unplayed"].includes(action)) return false;
  return !/^Action:.*(?:unwatched|unplayed)/im.test(String(row.sync_dispatch_telemetry || ""));
}

// Watched episode rows of a show detail record, with their play count.
export function watchedEpisodeRows(show = {}) {
  return (Array.isArray(show.episodes) ? show.episodes : [])
    .filter((row) => isWatchedRow(row) && Number.isInteger(Number(row.season)) && Number(row.episode) > 0)
    .map((row) => ({
      season: Number(row.season),
      episode: Number(row.episode),
      plays: Math.max(1, Array.isArray(row.playHistory) ? row.playHistory.length : 0),
    }));
}

async function loadSeasonLists({ tvdbId, tmdbId, cachedOnly = false, lane = "enrichment" }) {
  const [tvdb, tmdb] = await Promise.all([
    tvdbId ? (cachedOnly
      ? Promise.resolve(tvdbSeasonListsFromExtended(parseJson(db.prepare("SELECT details FROM tvdb_metadata_cache WHERE tvdb_id=? ORDER BY updated_at_ms DESC LIMIT 1").get(String(tvdbId))?.details) || {}))
      : getTvdbSeriesExtended(tvdbId, { lane }).then(tvdbSeasonListsFromExtended).catch(() => [])) : [],
    tmdbId ? getTmdbShowSeasonLists({ tmdbId, cachedOnly, lane }).catch(() => []) : [],
  ]);
  return { tvdb, tmdb };
}

function hasRegularEpisodes(lists = []) {
  return lists.some((season) => Number(season.season) > 0 && season.episodes?.length);
}

// The numbering the show's stored rows use. A tie keeps the numbering already
// on record, so a show whose episodes fit both structures is not flipped.
function rowNumberingFor(rows, lists, current) {
  const detected = detectRowNumbering(rows, lists);
  const numbering = detected.fitsTvdb === detected.fitsTmdb ? current : detected.numbering;
  return { ...detected, numbering };
}

// Read-only: what saving `source` for this show would do. Nothing is written.
export async function previewShowSeasonSource({ show, tvdbId, tmdbId, source }) {
  const target = normalizeSeasonSource(source);
  const current = readShowNumbering(tvdbId);
  const rows = watchedEpisodeRows(show);
  const lists = await loadSeasonLists({ tvdbId, tmdbId });
  const available = { tvdb: hasRegularEpisodes(lists.tvdb), tmdb: hasRegularEpisodes(lists.tmdb) };
  const detected = rowNumberingFor(rows, lists, current.rowNumbering);
  const rowNumbering = detected.numbering;
  const plan = rowNumbering === target
    ? { translated: [], review: [] }
    : planShowTranslation(rows, buildEpisodeNumberMap({ from: lists[rowNumbering], to: lists[target] }));
  const reviewKeys = new Set(plan.review.map((item) => `${item.season}:${item.episode}`));
  const watchRows = rows.reduce((total, row) => total + row.plays, 0);
  const reviewWatchRows = rows
    .filter((row) => reviewKeys.has(`${row.season}:${row.episode}`))
    .reduce((total, row) => total + row.plays, 0);
  return {
    tvdbId: String(tvdbId || ""),
    tmdbId: String(tmdbId || ""),
    currentSource: current.source,
    source: target,
    rowNumbering,
    unchanged: current.source === target && current.rowNumbering === rowNumbering,
    // Safety rule: a source with no data does not block the save; the season
    // readers fall back to TVDB for it.
    sourceAvailable: available[target],
    // Distinct watched episodes, specials included, so episodes = translated + review.
    episodes: new Set(rows.map((row) => `${row.season}:${row.episode}`)).size,
    watchRows,
    translatedEpisodes: plan.translated.length,
    review: plan.review,
    reviewWatchRows,
  };
}

// Show page: for a translated show, gives each watched row the episode it
// belongs to in the display structure (display_season / display_episode), or
// marks it numbering_review when it has no partner. Cache-only on the TMDB
// side, so a page load does not fetch every season. Rows are left as they are
// when the map cannot be built.
export async function annotateShowNumbering(show) {
  const tvdbId = String(show?.tvdb_id || "");
  if (!tvdbId || !Array.isArray(show?.episodes)) return show;
  const numbering = readShowNumbering(tvdbId);
  if (!numbering.translate) return show;
  const lists = await loadSeasonLists({ tvdbId, tmdbId: show.tmdb_id, cachedOnly: true });
  const from = lists[numbering.rowNumbering];
  const to = lists[numbering.source];
  if (!hasRegularEpisodes(from) || !hasRegularEpisodes(to)) {
    show.season_numbering = { ...numbering, ready: false };
    return show;
  }
  const map = buildEpisodeNumberMap({ from, to });
  for (const row of show.episodes) {
    if (!(Number(row.season) >= 0) || !(Number(row.episode) > 0)) continue;
    const target = translateEpisode(map, row.season, row.episode);
    if (target) {
      row.display_season = target.season;
      row.display_episode = target.episode;
    } else {
      row.numbering_review = true;
    }
  }
  // pairs: stored "season:episode" -> display { season, episode }, so the
  // client can place rows that are not watch rows (playback progress).
  show.season_numbering = { ...numbering, ready: true, pairs: Object.fromEntries(map.pairs) };
  return show;
}

// Show details for the show page. The cached details stay TVDB-shaped because
// the server readers depend on them; a show whose season source is TMDB gets
// TMDB's own season list here instead. The full list is read upstream at most
// once per window per show; light requests (Explorer prefetch) and an
// unreachable TMDB use the cached seasons, and no TMDB data keeps TVDB's list.
const DISPLAY_SEASONS_TTL_MS = 10 * 60 * 1000;
const displaySeasonsFetchedAt = new Map();

export async function withDisplaySeasons(details, { cachedOnly = false } = {}) {
  const tvdbId = String(details?.external_ids?.tvdb_id || "");
  const tmdbId = String(details?.id || details?.external_ids?.tmdb_id || "");
  if (!tvdbId || !tmdbId || !Array.isArray(details?.seasons)) return details;
  if (readSeasonSource(tvdbId) !== "tmdb") return details;
  const fresh = Date.now() - (displaySeasonsFetchedAt.get(tmdbId) || 0) < DISPLAY_SEASONS_TTL_MS;
  let lists = await getTmdbShowSeasonLists({ tmdbId, cachedOnly: true }).catch(() => []);
  if (!cachedOnly && (!fresh || !hasRegularEpisodes(lists))) {
    displaySeasonsFetchedAt.set(tmdbId, Date.now());
    lists = await getTmdbShowSeasonLists({ tmdbId, lane: "interactive" }).catch(() => lists);
  }
  if (!hasRegularEpisodes(lists)) return details;
  const seasons = lists
    .filter((season) => season.episodes?.length)
    .map((season) => ({
      season_number: season.season,
      episode_count: season.episodes.length,
      name: season.season === 0 ? "Specials" : `Season ${season.season}`,
      poster_path: null,
    }));
  const regular = seasons.filter((season) => season.season_number > 0);
  return {
    ...details,
    seasons,
    number_of_seasons: regular.length,
    number_of_episodes: regular.reduce((total, season) => total + season.episode_count, 0),
    season_source: "tmdb",
  };
}

// Progress for a translated show, counted the way its show page header counts:
// distinct regular episodes in the display structure, plus regular rows with
// no partner (they still show as watched "Unmatched" rows). Null when the
// show is not translated or its map cannot be built from cached seasons, so
// the caller keeps its own count.
export async function translatedWatchedCount({ tvdbId, tmdbId, rows = [] }) {
  const numbering = readShowNumbering(String(tvdbId || ""));
  if (!numbering.translate) return null;
  const lists = await loadSeasonLists({ tvdbId, tmdbId, cachedOnly: true });
  const from = lists[numbering.rowNumbering];
  const to = lists[numbering.source];
  if (!hasRegularEpisodes(from) || !hasRegularEpisodes(to)) return null;
  const map = buildEpisodeNumberMap({ from, to });
  const keys = new Set();
  for (const row of rows.filter((item) => Number(item.season) > 0)) {
    const target = translateEpisode(map, row.season, row.episode);
    keys.add(target ? `${target.season}:${target.episode}` : `review:${row.season}:${row.episode}`);
  }
  return keys.size;
}

function episodeCodeOf(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

// Show page watch actions send the display numbers they show, tagged with
// numbering_source. For a translated show those are turned back into the
// numbering its stored rows use, so a manual watch matches the rows the media
// server writes (decision 15: episodes are keyed on season + episode). Records
// without the tag (Up Next already uses the rows' numbering) pass through.
// `normalize` re-runs the caller's insert normalization on the translated
// record. Throws when the episode has no partner, so nothing is stored under
// the wrong numbers.
export async function inRowNumbering(normalized, pending = {}, normalize = (record) => ({ record })) {
  const source = normalizeSeasonSource(pending.numbering_source || "");
  const record = normalized?.record || {};
  if (!pending.numbering_source || record.media_type !== "episode" || !(Number(record.episode) > 0)) return normalized;
  const tvdbId = String(record.tvdb_id || "");
  const numbering = readShowNumbering(tvdbId);
  if (!tvdbId || !numbering.translate || numbering.source !== source) return normalized;
  const lists = await loadSeasonLists({ tvdbId, tmdbId: record.tmdb_id, cachedOnly: true });
  const map = buildEpisodeNumberMap({ from: lists[numbering.source], to: lists[numbering.rowNumbering] });
  const target = translateEpisode(map, record.season, record.episode);
  if (!target) {
    throw new Error(`${episodeCodeOf(record.season, record.episode)} has no matching episode in this show's ${numbering.rowNumbering.toUpperCase()} numbering, so it was not saved`);
  }
  const { numbering_source: _tag, ...rest } = pending;
  const from = episodeCodeOf(record.season, record.episode);
  return normalize({
    ...rest,
    tvdb_id: record.tvdb_id,
    tmdb_id: record.tmdb_id,
    imdb_id: record.imdb_id,
    season: target.season,
    episode: target.episode,
    title: String(rest.title || record.title || "").replace(from, episodeCodeOf(target.season, target.episode)),
  });
}

// The stored-to-display map for a translated show, built from fresh season
// lists (an explicit user action, so TMDB may be asked). Null when either
// side has no regular episodes.
export async function showNumberMap({ tvdbId, tmdbId, numbering = readShowNumbering(String(tvdbId || "")), cachedOnly = false }) {
  const lists = await loadSeasonLists({ tvdbId, tmdbId, cachedOnly });
  const from = lists[numbering.rowNumbering];
  const to = lists[numbering.source];
  if (!hasRegularEpisodes(from) || !hasRegularEpisodes(to)) return null;
  return { numbering, map: buildEpisodeNumberMap({ from, to }) };
}
