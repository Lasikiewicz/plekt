import fs from "node:fs";
import { getTmdbDetails as gatewayGetTmdbDetails } from "./tmdbGateway.js";
import { getTvdbSeriesExtended as gatewayGetTvdbSeriesExtended } from "./tvdbGateway.js";

const MAX_SEASONS = 200;
const MAX_EPISODES = 5000;
let verifiedEpisodeAliases;
let verifiedRows = [];

function bundledEpisodeAliases() {
  if (!verifiedEpisodeAliases) {
    try {
      const saved = JSON.parse(fs.readFileSync(new URL("../../resources/netflix-episode-title-aliases.json", import.meta.url), "utf8"));
      verifiedEpisodeAliases = saved.schemaVersion === 1 && Array.isArray(saved.entries) ? saved.entries : [];
      verifiedRows = saved.schemaVersion === 1 && Array.isArray(saved.rows) ? saved.rows : [];
    } catch { verifiedEpisodeAliases = []; }
  }
  return verifiedEpisodeAliases;
}

// Full Netflix rows with separately verified episode identities (specials, spin-offs
// and known release-order differences). Every target must validate or none is used.
export async function resolveNetflixVerifiedRow(title, { getSeasonLists, watchedAt = "", entries } = {}) {
  bundledEpisodeAliases();
  const matches = (entries || verifiedRows).filter((entry) => nameKey(entry.sourceTitle) === nameKey(title));
  if (matches.length !== 1) return null;
  const [entry] = matches;
  if (!cleanId(entry.showTmdbId) || !entry.showTitle || !Array.isArray(entry.targets)
    || !entry.targets.length || entry.targets.length > 20 || !Array.isArray(entry.sources)
    || !entry.sources.length || !entry.sources.every((source) => /^https:\/\//.test(source))) return null;
  if (entry.watchedBefore && (!exactDate(entry.watchedBefore) || watchedAt.slice(0, 10) >= entry.watchedBefore)) return null;
  try {
    const episodes = flattenTmdbLists(await getSeasonLists({ tmdbId: String(entry.showTmdbId), lane: "sync" }));
    const found = [];
    for (const target of entry.targets) {
      const hits = episodes.filter(({ episode }) => cleanId(episode.id) === cleanId(target.episodeTmdbId));
      if (!cleanId(target.episodeTmdbId) || hits.length !== 1) return null;
      const { episode, seasonNumber } = hits[0];
      if (!nameKey(target.expectedTitle) || nameKey(episode.name) !== nameKey(target.expectedTitle)
        || !exactDate(target.airDate) || exactDate(episode.air_date) !== target.airDate
        || !exactDate(watchedAt.slice(0, 10)) || watchedAt.slice(0, 10) < target.airDate
        || !Number.isInteger(Number(episode.episode_number)) || Number(episode.episode_number) < 1) return null;
      found.push({ mediaType: "episode", tmdbId: String(entry.showTmdbId), showTitle: entry.showTitle,
        episodeTitle: episode.name, season: seasonNumber, episode: Number(episode.episode_number) });
    }
    return new Set(found.map((episode) => `${episode.season}:${episode.episode}`)).size === found.length ? found : null;
  } catch { return null; }
}

function nameKey(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Verified title variants are pinned to both provider identities and the current
// canonical episode title. They never supply or replace episode coordinates.
function withVerifiedAliases(id, lists, entries) {
  const episodes = flattenTmdbLists(lists);
  const additions = new Map();
  for (const entry of entries) {
    if (cleanId(entry.showTmdbId) !== id || !entry.expectedTitle || !Array.isArray(entry.titles)
      || !Array.isArray(entry.sources) || !entry.sources.length
      || !entry.sources.every((source) => /^https:\/\//.test(source))) continue;
    const targets = episodes.filter(({ episode }) => cleanId(episode.id) === cleanId(entry.episodeTmdbId));
    if (targets.length !== 1 || !cleanId(entry.episodeTmdbId)) continue;
    const { episode } = targets[0];
    if (nameKey(episode.name) !== nameKey(entry.expectedTitle)) continue;
    if (entry.airDate && exactDate(episode.air_date) !== entry.airDate) continue;
    const titles = entry.titles.filter((title) => typeof title === "string" && nameKey(title)
      && !episodes.some((other) => other.episode !== episode
        && [other.episode.name, ...(other.episode.alternateTitles || [])].some((name) => nameKey(name) === nameKey(title))));
    if (titles.length) additions.set(episode, [...(additions.get(episode) || episode.alternateTitles || []), ...titles]);
  }
  if (!additions.size) return lists;
  return lists.map((season) => ({ ...season, episodes: (season.episodes || []).map((episode) => additions.has(episode)
    ? { ...episode, alternateTitles: [...new Set(additions.get(episode))] } : episode) }));
}

function cleanId(value) {
  return String(value ?? "").trim();
}

function validCoordinate(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function tmdbEpisodeId(episode) {
  return cleanId(episode?.id);
}

function tvdbTmdbEpisodeId(episode) {
  const remoteIds = Array.isArray(episode?.remoteIds) ? episode.remoteIds : [];
  const match = remoteIds.find((item) => /(?:the)?movie.?db|tmdb/i.test(String(item?.sourceName || "")));
  return cleanId(match?.id);
}

function exactDate(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function countValues(items, valueOf) {
  const counts = new Map();
  for (const item of items) {
    const value = valueOf(item);
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function flattenTmdbLists(lists) {
  const result = [];
  for (const season of lists) {
    const seasonNumber = validCoordinate(season?.season ?? season?.season_number);
    if (seasonNumber === null) continue;
    for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
      result.push({ season, episode, seasonNumber });
    }
  }
  return result;
}

/**
 * Add TVDB episode names as alternateTitles to TMDB episodes when a verified
 * TMDB-to-TVDB show link and a unique episode ID or air-date match exist.
 * Inject `getTmdbDetails` and `getTvdbSeriesExtended` in `dependencies` for tests.
 */
export async function getNetflixEpisodeAliases({
  tmdbId,
  tmdbLists,
  dependencies = {},
} = {}) {
  let original = Array.isArray(tmdbLists) ? tmdbLists : [];
  const id = cleanId(tmdbId);
  if (!id || original.length > MAX_SEASONS) return original;

  const count = flattenTmdbLists(original).length;
  if (count > MAX_EPISODES || !count) return original;
  original = withVerifiedAliases(id, original, dependencies.verifiedEpisodeAliases || bundledEpisodeAliases());
  const tmdbEpisodes = flattenTmdbLists(original);

  const getTmdbDetails = dependencies.getTmdbDetails || gatewayGetTmdbDetails;
  const getTvdbSeriesExtended = dependencies.getTvdbSeriesExtended || gatewayGetTvdbSeriesExtended;
  try {
    // The TMDB document must be keyed by the requested TMDB show and supply
    // its own external TVDB ID; title matching is never used for identity.
    const details = await getTmdbDetails({ mediaType: "tv", tmdbId: id, light: true });
    if (cleanId(details?.id) !== id) return original;
    const tvdbId = cleanId(details?.external_ids?.tvdb_id);
    if (!tvdbId) return original;

    const series = await getTvdbSeriesExtended(tvdbId);
    if (cleanId(series?.id) !== tvdbId) return original;

    const tvdbEpisodes = Array.isArray(series?.episodes) ? series.episodes : [];
    if (tvdbEpisodes.length > MAX_EPISODES) return original;
    const tmdbById = new Map();
    for (const item of tmdbEpisodes) {
      const episodeId = tmdbEpisodeId(item.episode);
      if (episodeId) tmdbById.set(episodeId, [...(tmdbById.get(episodeId) || []), item]);
    }
    const tvdbByTmdbId = new Map();
    for (const episode of tvdbEpisodes) {
      const episodeId = tvdbTmdbEpisodeId(episode);
      if (episodeId) tvdbByTmdbId.set(episodeId, [...(tvdbByTmdbId.get(episodeId) || []), episode]);
    }

    const tmdbDateCounts = countValues(tmdbEpisodes, (item) => exactDate(item.episode?.air_date));
    const tvdbDateCounts = countValues(tvdbEpisodes, (episode) => exactDate(episode.aired));
    const tvdbByDate = new Map();
    for (const episode of tvdbEpisodes) {
      const date = exactDate(episode.aired);
      if (date) tvdbByDate.set(date, [...(tvdbByDate.get(date) || []), episode]);
    }

    const aliasesByEpisode = new Map();
    for (const item of tmdbEpisodes) {
      const tmdbIdForEpisode = tmdbEpisodeId(item.episode);
      let match = null;
      const idCandidates = tmdbIdForEpisode ? tvdbByTmdbId.get(tmdbIdForEpisode) : null;
      const reverseCandidates = tmdbIdForEpisode ? tmdbById.get(tmdbIdForEpisode) : null;
      if (idCandidates?.length === 1 && reverseCandidates?.length === 1) {
        match = idCandidates[0];
      } else {
        const date = exactDate(item.episode?.air_date);
        const dateCandidates = date ? tvdbByDate.get(date) : null;
        if (date && tmdbDateCounts.get(date) === 1 && tvdbDateCounts.get(date) === 1 && dateCandidates?.length === 1) {
          // A conflicting explicit TMDB episode identity is evidence against
          // an air-date fallback, so leave that episode unresolved.
          const hasConflictingRemoteId = tvdbEpisodes.some((episode) => (
            tvdbTmdbEpisodeId(episode) === tmdbIdForEpisode && episode.aired !== date
          ));
          const dateCandidateId = tvdbTmdbEpisodeId(dateCandidates[0]);
          if (!hasConflictingRemoteId && (!dateCandidateId || !tmdbIdForEpisode || dateCandidateId === tmdbIdForEpisode)) {
            match = dateCandidates[0];
          }
        }
      }
      const title = String(match?.name || "").trim();
      if (!title) continue;
      const aliases = Array.isArray(item.episode.alternateTitles) ? item.episode.alternateTitles : [];
      const normalized = new Set(aliases.map((value) => String(value).trim().toLocaleLowerCase()).filter(Boolean));
      if (!normalized.has(title.toLocaleLowerCase()) && title !== String(item.episode.name || "").trim()) {
        aliasesByEpisode.set(item.episode, [...aliases, title]);
      }
    }

    if (!aliasesByEpisode.size) return original;
    return original.map((season) => ({
      ...season,
      episodes: (Array.isArray(season?.episodes) ? season.episodes : []).map((episode) => (
        aliasesByEpisode.has(episode)
          ? { ...episode, alternateTitles: aliasesByEpisode.get(episode) }
          : episode
      )),
    }));
  } catch {
    // Metadata enrichment must not block Netflix imports or discard TMDB data.
    return original;
  }
}
