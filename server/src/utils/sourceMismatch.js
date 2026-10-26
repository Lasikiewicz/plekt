import { db } from "../db.js";
import { getTmdbSeasonEpisodes } from "./tmdbGateway.js";
import { getTvdbSeasonEpisodes } from "./tvdbGateway.js";
import { enqueueSourceMismatchReview } from "./manualWatchReview.js";
import { readShowNumbering } from "./seasonSource.js";

const seenInRun = new Map();
const showRowsStmt = db.prepare(`
  SELECT id, title, show_title, episode_title, season, episode, imdb_id, tmdb_id, tvdb_id, watched_at
  FROM watch_history
  WHERE media_type='episode' AND sync_action='watched'
    AND ((@tmdb <> '' AND tmdb_id=@tmdb) OR (@tvdb <> '' AND tvdb_id=@tvdb))
  ORDER BY watched_at DESC LIMIT 500
`);

function clean(value) { return String(value ?? "").trim(); }
function idsOf(media = {}) {
  const ids = media.ids || {};
  return { tmdb: clean(media.showIds?.tmdb || ids.tmdb || media.tmdb_id), tvdb: clean(media.showIds?.tvdb || ids.tvdb || media.tvdb_id) };
}
function episodeNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
function normalizeEpisodes(result) {
  return (Array.isArray(result?.episodes) ? result.episodes : []).map((item) => ({
    season: episodeNumber(item.season_number ?? item.seasonNumber),
    episode: episodeNumber(item.episode_number ?? item.number),
    title: clean(item.name),
    airDate: clean(item.air_date ?? item.aired),
  })).filter((item) => item.season !== null && item.episode !== null);
}
function titleKey(value) { return clean(value).toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "").trim(); }

// Only called at inbound episode boundaries. Same-number title differences are
// deliberately ignored: episode titles vary between providers routinely.
export async function checkIncomingEpisodeSourceMismatch(media = {}, {
  runKey = "default",
  loadTmdbSeasonEpisodes = getTmdbSeasonEpisodes,
  loadTvdbSeasonEpisodes = getTvdbSeasonEpisodes,
} = {}) {
  if (String(media.type || media.media_type).toLowerCase() !== "episode") return { status: "no_match" };
  const season = episodeNumber(media.season);
  const episode = episodeNumber(media.episode);
  const ids = idsOf(media);
  if (season === null || episode === null || (!ids.tmdb && !ids.tvdb)) return { status: "unknown" };
  const showKey = `${ids.tmdb}:${ids.tvdb}`;
  if (seenInRun.has(`${runKey}:${showKey}`)) return seenInRun.get(`${runKey}:${showKey}`);
  const records = showRowsStmt.all({ tmdb: ids.tmdb, tvdb: ids.tvdb });
  const incomingTitle = clean(media.episodeTitle || media.episode_title);
  if (!incomingTitle) return { status: "unknown" };
  const stored = records.find((row) => titleKey(row.episode_title) === titleKey(incomingTitle));
  if (!stored || (Number(stored.season) === season && Number(stored.episode) === episode)) return { status: "no_match" };
  const rowNumbering = readShowNumbering(ids.tvdb || ids.tmdb).rowNumbering;
  const alternate = rowNumbering === "tmdb" ? "tvdb" : "tmdb";
  if ((alternate === "tmdb" && !ids.tmdb) || (alternate === "tvdb" && !ids.tvdb)) {
    const result = { status: "unknown" };
    seenInRun.set(`${runKey}:${showKey}`, result);
    return result;
  }
  const lookup = alternate === "tmdb"
    ? loadTmdbSeasonEpisodes({ tmdbId: ids.tmdb, seasonNumber: season, lane: "sync" })
    : loadTvdbSeasonEpisodes({ tvdbId: ids.tvdb, seasonNumber: season, lane: "sync" });
  try {
    const otherEpisodes = normalizeEpisodes(await lookup);
    const other = otherEpisodes.find((item) => titleKey(item.title) === titleKey(incomingTitle));
    if (!other || other.season !== season || other.episode !== episode) {
      const result = { status: "no_match" };
      seenInRun.set(`${runKey}:${showKey}`, result);
      return result;
    }
    const signature = JSON.stringify(ids);
    const reviewMedia = {
      ...media,
      type: "episode",
      showTitle: media.showTitle || media.show_title || "",
      ids,
      mismatch: { stored: { season: stored.season, episode: stored.episode }, incoming: { season, episode }, otherSource: alternate, other, ids },
      reviewKind: "source_mismatch",
      reviewSourceIds: signature,
    };
    const queued = enqueueSourceMismatchReview(reviewMedia, { fingerprint: signature });
    const result = { status: "match", queued: Boolean(queued.queued), review: queued.review };
    seenInRun.set(`${runKey}:${showKey}`, result);
    return result;
  } catch (error) {
    const result = { status: "unknown", error: error.message || String(error) };
    seenInRun.set(`${runKey}:${showKey}`, result);
    return result;
  }
}

export function clearSourceMismatchRunCache(runKey = "default") {
  for (const key of seenInRun.keys()) if (key.startsWith(`${runKey}:`)) seenInRun.delete(key);
}
