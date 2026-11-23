import { db } from "../db.js";
import { queryShowDetail } from "./dataRepo.js";
import { orderDetails, orderDisplayMap, orderSeason } from "./episodeOrderUpNext.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";
import { airDayOf, todayLocalDate } from "./watchDates.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function normalizedTitle(value = "") {
  return text(value)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function released(airDate, today) {
  const day = airDayOf(airDate);
  return !day || day <= today;
}

function playstateRowsForShow({ title = "", tmdbId = "", tvdbId = "", imdbId = "" } = {}) {
  const clauses = [];
  const params = [];
  if (tmdbId) {
    clauses.push("tmdb_id = ?");
    params.push(tmdbId);
  }
  if (tvdbId) {
    clauses.push("tvdb_id = ?");
    params.push(tvdbId);
  }
  if (imdbId) {
    clauses.push("LOWER(imdb_id) = LOWER(?)");
    params.push(imdbId);
  }
  if (!clauses.length && title) {
    const escaped = title.replace(/[\\%_]/g, "\\$&");
    clauses.push("LOWER(title) LIKE LOWER(?) ESCAPE '\\'");
    params.push(`${escaped}%`);
  }
  if (!clauses.length) return [];
  const rows = db.prepare(`
    SELECT title, tmdb_id, tvdb_id, imdb_id, season, episode, state
    FROM playstate
    WHERE media_type = 'episode' AND (${clauses.join(" OR ")})
    ORDER BY COALESCE(updated_at, 0) ASC, media_key ASC
  `).all(...params);
  const showTitleKey = normalizedTitle(title);
  return rows.filter((row) => {
    const rowTmdb = text(row.tmdb_id);
    const rowTvdb = text(row.tvdb_id);
    if (tmdbId && rowTmdb && rowTmdb !== tmdbId) return false;
    if (tvdbId && rowTvdb && rowTvdb !== tvdbId) return false;
    if (!tmdbId && !tvdbId && !imdbId && showTitleKey) {
      const candidateKey = normalizedTitle(row.title);
      return candidateKey === showTitleKey || candidateKey.startsWith(`${showTitleKey} `);
    }
    return true;
  });
}

export async function getUpNextShowOptions({
  title = "",
  tmdbId = "",
  tvdbId = "",
  imdbId = "",
  now = Date.now(),
} = {}) {
  const cleanTitle = text(title);
  let cleanTmdbId = text(tmdbId);
  let cleanTvdbId = text(tvdbId);
  let cleanImdbId = text(imdbId);

  let detailLookupFailed = false;
  let metadataLookupFailed = false;
  let seasonLookupFailed = false;

  const detail = await queryShowDetail({
    title: cleanTitle,
    tmdbId: cleanTmdbId,
    tvdbId: cleanTvdbId,
    imdbId: cleanImdbId,
  }).catch(() => {
    detailLookupFailed = true;
    return null;
  });

  if (!cleanTmdbId && detail?.tmdb_id) cleanTmdbId = text(detail.tmdb_id);
  if (!cleanTvdbId && detail?.tvdb_id) cleanTvdbId = text(detail.tvdb_id);
  if (!cleanImdbId && detail?.imdb_id) cleanImdbId = text(detail.imdb_id);

  let metadata = orderDetails({
    mediaType: "tv",
    tmdbId: cleanTmdbId,
    title: cleanTitle || detail?.title || "",
    ids: { tvdbId: cleanTvdbId, imdbId: cleanImdbId },
  });
  if (!metadata && (cleanTmdbId || cleanTvdbId)) {
    await getTmdbDetails({
      mediaType: "tv",
      tmdbId: cleanTmdbId,
      title: cleanTitle || detail?.title || "",
      ids: { tvdbId: cleanTvdbId, imdbId: cleanImdbId },
      lane: "interactive",
    }).catch(() => {
      metadataLookupFailed = true;
      return null;
    });
    metadata = orderDetails({
      mediaType: "tv",
      tmdbId: cleanTmdbId,
      title: cleanTitle || detail?.title || "",
      ids: { tvdbId: cleanTvdbId, imdbId: cleanImdbId },
    });
  }

  if (!cleanTmdbId && metadata?.id) cleanTmdbId = text(metadata.id);
  if (!cleanTvdbId && metadata?.external_ids?.tvdb_id) cleanTvdbId = text(metadata.external_ids.tvdb_id);

  const watched = new Set();
  const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];
  for (const row of episodes) {
    const season = Number(row.season);
    const episode = Number(row.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) continue;
    if (String(row.sync_action || "watched").toLowerCase() !== "unwatched") {
      watched.add(`${season}:${episode}`);
    }
  }
  for (const row of playstateRowsForShow({
    title: cleanTitle || detail?.title || "",
    tmdbId: cleanTmdbId,
    tvdbId: cleanTvdbId,
    imdbId: cleanImdbId,
  })) {
    const season = Number(row.season);
    const episode = Number(row.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) continue;
    const key = `${season}:${episode}`;
    if (String(row.state || "").toLowerCase() === "watched") watched.add(key);
    else if (String(row.state || "").toLowerCase() === "unwatched") watched.delete(key);
  }

  const today = todayLocalDate(now);
  const displayMap = orderDisplayMap(cleanTvdbId);
  const seasons = [];
  if (displayMap?.seasons?.length) {
    for (const season of displayMap.seasons) {
      const releasedEpisodes = season.episodes.filter((ep) => released(ep.air_date, today));
      const watchedInSeason = season.episodes.filter((ep) => watched.has(`${ep.season_number}:${ep.episode_number}`)).length;
      const nextEpisodeRaw = releasedEpisodes.find((ep) => !watched.has(`${ep.season_number}:${ep.episode_number}`)) || null;
      const episodeCount = releasedEpisodes.length || season.episodes.length;
      seasons.push({
        season_number: season.season_number,
        episode_count: episodeCount,
        watched_count: Math.min(watchedInSeason, episodeCount || watchedInSeason),
        has_unwatched: releasedEpisodes.length > 0 ? Boolean(nextEpisodeRaw) : false,
        next_episode: nextEpisodeRaw
          ? { season: season.season_number, episode: nextEpisodeRaw.display_episode, title: text(nextEpisodeRaw.name) }
          : null,
      });
    }
  } else {
    const metaSeasons = new Map();
    for (const season of Array.isArray(metadata?.seasons) ? metadata.seasons : []) {
      const num = Number(season?.season_number);
      if (Number.isInteger(num) && num > 0) metaSeasons.set(num, season);
    }
    for (const key of watched) {
      const seasonNum = Number(key.split(":")[0]);
      if (Number.isInteger(seasonNum) && seasonNum > 0 && !metaSeasons.has(seasonNum)) {
        metaSeasons.set(seasonNum, { season_number: seasonNum });
      }
    }

    const seasonNumbers = [...metaSeasons.keys()].sort((a, b) => a - b);
    for (const seasonNumber of seasonNumbers) {
      let seasonData = orderSeason({ tmdbId: cleanTmdbId, tvdbId: cleanTvdbId, seasonNumber });
      if (!seasonData && (cleanTmdbId || cleanTvdbId) && seasonNumbers.length <= 12) {
        seasonData = await getTmdbSeason({
          tmdbId: cleanTmdbId,
          tvdbId: cleanTvdbId,
          seasonNumber,
          lane: "interactive",
        }).catch(() => {
          seasonLookupFailed = true;
          return null;
        });
      }
      const seasonEpisodes = [...(Array.isArray(seasonData?.episodes) ? seasonData.episodes : [])]
        .filter((ep) => Number(ep?.episode_number) > 0)
        .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
      const releasedEpisodes = seasonEpisodes.filter((ep) => released(ep.air_date, today));
      const watchedInSeason = [...watched].filter((key) => Number(key.split(":")[0]) === seasonNumber).length;
      const nextEpisodeRaw = releasedEpisodes.find((ep) => !watched.has(`${seasonNumber}:${Number(ep.episode_number)}`)) || null;
      const metaCount = Number(metaSeasons.get(seasonNumber)?.episode_count || 0);
      const episodeCount = releasedEpisodes.length || seasonEpisodes.length || metaCount;
      const hasUnwatched = releasedEpisodes.length > 0
        ? Boolean(nextEpisodeRaw)
        : (seasonEpisodes.length > 0 ? false : (episodeCount === 0 || watchedInSeason < episodeCount));

      seasons.push({
        season_number: seasonNumber,
        episode_count: episodeCount,
        watched_count: Math.min(watchedInSeason, episodeCount || watchedInSeason),
        has_unwatched: hasUnwatched,
        next_episode: nextEpisodeRaw
          ? {
              season: seasonNumber,
              episode: Number(nextEpisodeRaw.episode_number),
              title: text(nextEpisodeRaw.name),
            }
          : null,
      });
    }
  }

  const earliestSeason = seasons.find((s) => s.has_unwatched) || null;
  const watchedSeasons = seasons.filter((s) => s.watched_count > 0).map((s) => s.season_number);
  const lookupFailed = detailLookupFailed || metadataLookupFailed || seasonLookupFailed;
  return {
    ok: true,
    title: cleanTitle || detail?.title || metadata?.name || "",
    tmdb_id: cleanTmdbId,
    tvdb_id: cleanTvdbId,
    imdb_id: cleanImdbId,
    earliestUnwatched: earliestSeason?.next_episode
      || (earliestSeason ? { season: earliestSeason.season_number, episode: null, title: "" } : null),
    watchedSeasons,
    watchedSeasonCount: watchedSeasons.length,
    seasons,
    ...(lookupFailed ? {
      seasonLookupFailed: true,
      warning: "Season options could not be loaded in full. You can still add from the earliest unwatched episode.",
    } : {}),
  };
}
