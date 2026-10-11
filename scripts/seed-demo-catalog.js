import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const catalogPath = path.join(repoRoot, "public", "demo-assets", "catalog.json");
const sharedDataDir = path.join(repoRoot, "data");
const DISCOVERY_GENRES = {
  movie: [28, 12, 35, 80, 18, 14, 27, 9648, 10749, 878, 53, 10752],
  tv: [10759, 35, 80, 18, 10765, 9648, 10749, 10768, 37],
};
const DEMO_LISTS = [
  { id: "demo-list-favourites", name: "Demo Favourites" },
  { id: "demo-list-weekend", name: "Weekend Watch" },
  { id: "demo-list-sci-fi", name: "Science Fiction Picks" },
];

function fail(message) {
  throw new Error(message);
}

function isoAt(daysAgo, hourOffset = 0) {
  const timestamp = Date.now() - (daysAgo * 24 * 60 * 60 * 1000) - (hourOffset * 60 * 60 * 1000);
  return new Date(timestamp).toISOString();
}

function padEpisode(number) {
  return String(number).padStart(2, "0");
}

function fixtureTvdbId(item) {
  // Prefer the real TVDB identity from the downloaded metadata. The fallback is
  // only a local numeric alias for shows TMDB does not map to TVDB; it lets the
  // existing season route serve the bundled cache without a provider request.
  const sourceId = String(item.metadata?.external_ids?.tvdb_id || "").trim();
  return /^\d+$/.test(sourceId) ? sourceId : String(900000000 + Number(item.tmdbId));
}

function demoDetails(item, mediaType, episodeCount = 0) {
  const id = String(item.tmdbId);
  const isTv = mediaType === "tv";
  const source = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const sourceSeasons = Array.isArray(source.seasons) ? source.seasons : [];
  const seasons = isTv
    ? (sourceSeasons.length ? sourceSeasons : [{
      id: `demo-season-${id}-1`,
      name: "Season 1",
      season_number: 1,
      episode_count: episodeCount,
      air_date: item.releaseDate || "",
      poster_path: null,
      poster_url: item.poster.path,
    }]).map((season) => ({
      ...season,
      id: season.id || `demo-season-${id}-${season.season_number}`,
      season_number: Number(season.season_number),
      episode_count: Number(season.episode_count || 0),
      poster_url: season.poster_url || season.poster?.path || "",
    }))
    : undefined;
  const details = {
    ...source,
    id,
    name: isTv ? source.name || item.title : undefined,
    title: isTv ? undefined : item.title,
    overview: source.overview || item.overview || "",
    release_date: isTv ? undefined : item.releaseDate || "",
    first_air_date: isTv ? source.first_air_date || item.releaseDate || "" : undefined,
    vote_average: Number(source.vote_average || item.voteAverage || 0),
    vote_count: Number(source.vote_count || item.voteCount || 0),
    poster_path: source.poster_path || null,
    backdrop_path: source.backdrop_path || null,
    cached_poster_url: item.poster.path,
    cached_backdrop_url: item.backdrop.path,
    status: source.status || null,
    media_type: mediaType,
    external_ids: {
      ...(source.external_ids || {}),
      tmdb_id: id,
      tvdb_id: isTv ? fixtureTvdbId(item) : "",
    },
    seasons,
    number_of_seasons: isTv ? Number(source.number_of_seasons || seasons?.length || 1) : undefined,
    number_of_episodes: isTv ? Number(source.number_of_episodes || seasons?.reduce((sum, season) => sum + Number(season.episode_count || 0), 0) || episodeCount) : undefined,
    genres: Array.isArray(source.genres) ? source.genres : [],
    credits: source.credits && typeof source.credits === "object" ? source.credits : { cast: [], crew: [] },
    images: source.images && typeof source.images === "object" ? source.images : { backdrops: [], posters: [], logos: [] },
    videos: source.videos && typeof source.videos === "object" ? source.videos : { results: [] },
    reviews: source.reviews && typeof source.reviews === "object" ? source.reviews : { results: [] },
    similar: source.similar && typeof source.similar === "object" ? source.similar : { results: [] },
    recommendations: source.recommendations && typeof source.recommendations === "object" ? source.recommendations : { results: [] },
    "watch/providers": source["watch/providers"] && typeof source["watch/providers"] === "object" ? source["watch/providers"] : { results: {} },
    content_ratings: source.content_ratings && typeof source.content_ratings === "object" ? source.content_ratings : { results: [] },
    keywords: source.keywords && typeof source.keywords === "object" ? source.keywords : { keywords: [], results: [] },
    networks: Array.isArray(source.networks) ? source.networks : [],
    cached_poster_url: item.poster.path,
    cached_backdrop_url: item.backdrop.path,
    demo_fixture: true,
  };

  // JSON.stringify omits undefined values, keeping the fixture compatible
  // with the same compact details shape returned by the metadata gateway.
  return details;
}

function metadataFor(item) {
  return item.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function seasonFor(item, seasonNumber) {
  return (metadataFor(item).seasons || []).find((season) => Number(season.season_number) === Number(seasonNumber)) || null;
}

function episodeRowsFor(item, seasonNumber) {
  const season = seasonFor(item, seasonNumber);
  const bundled = item.seasonDetails?.[String(seasonNumber)];
  const episodes = Array.isArray(bundled?.episodes) ? bundled.episodes : [];
  if (episodes.length) {
    return episodes.map((episode, index) => ({
      id: episode.id || `demo-episode-${item.tmdbId}-${seasonNumber}-${episode.episode_number || index + 1}`,
      number: Number(episode.episode_number || index + 1),
      name: String(episode.name || `Preview episode ${index + 1}`),
      overview: String(episode.overview || "Bundled demo episode metadata."),
      aired: String(episode.air_date || ""),
      image: episode.still_path || episode.image || season?.poster_url || season?.poster?.path || item.poster.path,
      runtime: episode.runtime == null ? 45 : Number(episode.runtime),
    }));
  }
  const fallbackCount = Math.max(3, Math.min(Number(season?.episode_count || 0), 12));
  return Array.from({ length: fallbackCount }, (_, index) => ({
    id: `demo-episode-${item.tmdbId}-${seasonNumber}-${index + 1}`,
    number: index + 1,
    name: `Preview episode ${index + 1}`,
    overview: "Bundled demo episode metadata.",
    aired: season?.air_date || item.releaseDate || "",
    image: season?.poster_url || season?.poster?.path || item.poster.path,
    runtime: 45,
  }));
}

function regularSeasonNumbers(item) {
  const numbers = (metadataFor(item).seasons || [])
    .map((season) => Number(season.season_number))
    .filter((number) => Number.isInteger(number) && number > 0);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function personalMedia(item) {
  const type = item.mediaType === "tv" ? "tv" : "movie";
  const source = metadataFor(item);
  return {
    media_key: `${type}:tmdb:${item.tmdbId}`,
    media_type: type,
    title: item.title,
    tmdb_id: String(item.tmdbId),
    tvdb_id: type === "tv" ? fixtureTvdbId(item) : "",
    imdb_id: String(source.external_ids?.imdb_id || ""),
    poster_url: item.poster.path,
    overview: String(source.overview || item.overview || ""),
    release_date: String(source.first_air_date || item.releaseDate || ""),
  };
}

function discoveryHash(type, genre) {
  return crypto.createHash("sha1").update(`discover:v2|${type}|${genre}`).digest("hex");
}

function discoveryItem(item) {
  const source = metadataFor(item);
  const type = item.mediaType === "tv" ? "tv" : "movie";
  return {
    id: Number(item.tmdbId),
    media_type: type,
    title: type === "movie" ? item.title : undefined,
    name: type === "tv" ? item.title : undefined,
    overview: String(source.overview || item.overview || ""),
    release_date: type === "movie" ? String(item.releaseDate || "") : undefined,
    first_air_date: type === "tv" ? String(source.first_air_date || item.releaseDate || "") : undefined,
    poster_path: item.poster.path,
    backdrop_path: item.backdrop.path,
    poster_url: item.poster.path,
    backdrop_url: item.backdrop.path,
    vote_average: Number(source.vote_average || item.voteAverage || 0),
    vote_count: Number(source.vote_count || item.voteCount || 0),
    popularity: Number(source.popularity || item.popularity || 0),
  };
}

function discoveryFeeds(type, genre, movies, shows) {
  const movieItems = movies.map(discoveryItem);
  const showItems = shows.map(discoveryItem);
  const rotate = (items, offset = 0) => items.map((_, index) => items[(index + offset) % items.length]).slice(0, 30);
  const movieRail = rotate(movieItems, Number(genre || 0) % Math.max(1, movieItems.length));
  const showRail = rotate(showItems, Number(genre || 0) % Math.max(1, showItems.length));
  const feed = (results) => ({ page: 1, total_pages: 1, results });
  if (type === "all") {
    return genre
      ? { trending_movies: feed(movieRail), trending_shows: feed(showRail), genre_movies: feed(rotate(movieItems, 5)), genre_shows: feed(rotate(showItems, 5)) }
      : { trending_movies: feed(movieRail), trending_shows: feed(showRail), new_movies: feed(rotate(movieItems, 9)), new_shows: feed(rotate(showItems, 9)) };
  }
  if (type === "movie") {
    return {
      trending_movies: feed(movieRail),
      [genre ? "genre_movies" : "popular_movies"]: feed(rotate(movieItems, genre ? 5 : 2)),
      new_movies: feed(rotate(movieItems, 9)),
      upcoming_movies: feed(rotate(movieItems, 14)),
    };
  }
  return {
    trending_shows: feed(showRail),
    [genre ? "genre_shows" : "popular_shows"]: feed(rotate(showItems, genre ? 5 : 2)),
    new_shows: feed(rotate(showItems, 9)),
    on_air_shows: feed(rotate(showItems, 14)),
  };
}

function monthBounds(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}`, lastDay };
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function upcomingPayload(month, shows, direction = 0) {
  const { start, end, lastDay } = monthBounds(month);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const today = new Date().getUTCDate();
  const episodes = shows.slice(0, 30).map((item, index) => {
    const availableDays = direction === 0 && month === currentMonth ? Math.max(1, lastDay - today) : lastDay;
    const day = direction === 0 && month === currentMonth
      ? Math.min(lastDay, today + 1 + (index % availableDays))
      : 1 + (index % availableDays);
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const seasonNumber = regularSeasonNumbers(item)[0] || 1;
    const episode = episodeRowsFor(item, seasonNumber)[index % episodeRowsFor(item, seasonNumber).length];
    return {
      airDate: date,
      showTitle: item.title,
      showId: `tmdb:${item.tmdbId}`,
      tmdbId: String(item.tmdbId),
      tvdbId: fixtureTvdbId(item),
      posterUrl: item.poster.path,
      posterRecordId: `demo:poster:tv:${item.tmdbId}`,
      season: seasonNumber,
      episode: episode.number,
      episodeTitle: episode.name,
      status: String(metadataFor(item).status || ""),
    };
  });
  return { month, start, end, episodes };
}

function writeDerivedFixtureFiles(dataDir, movies, shows, now) {
  const months = {};
  for (const [month, direction] of [[addMonths(new Date().toISOString().slice(0, 7), -1), -1], [new Date().toISOString().slice(0, 7), 0], [addMonths(new Date().toISOString().slice(0, 7), 1), 1]]) {
    const payload = upcomingPayload(month, shows, direction);
    months[month] = {
      builtAt: now,
      showKeys: shows.map((item) => `tmdb:${item.tmdbId}`),
      payload,
    };
  }
  fs.writeFileSync(path.join(dataDir, "upcoming-calendar-cache.json"), JSON.stringify({ version: 1, updatedAt: now, months }, null, 2));

  const types = ["all", "movie", "tv"];
  const genresByType = {
    all: ["", ...new Set([...DISCOVERY_GENRES.movie, ...DISCOVERY_GENRES.tv].map(String))],
    movie: ["", ...DISCOVERY_GENRES.movie.map(String)],
    tv: ["", ...DISCOVERY_GENRES.tv.map(String)],
  };
  const rows = [];
  for (const type of types) {
    for (const genre of genresByType[type]) {
      const payload = { media_type: type, genre_id: genre, feeds: discoveryFeeds(type, genre, movies, shows) };
      rows.push({ id: discoveryHash(type, genre), query: genre, mediaType: `discover:${type}`, response: JSON.stringify(payload) });
    }
  }
  return rows;
}

function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.items) || catalog.items.length === 0) {
    fail(`Demo catalogue is missing or empty: ${catalogPath}`);
  }
  const seen = new Set();
  for (const item of catalog.items) {
    const id = `${item.mediaType}:${item.tmdbId}`;
    if (!/^\d+$/.test(String(item.tmdbId || ""))) fail(`Invalid TMDB id in demo catalogue: ${id}`);
    if (!item.title || !item.poster?.path || !item.backdrop?.path) fail(`Incomplete demo catalogue item: ${id}`);
    if (seen.has(id)) fail(`Duplicate demo catalogue item: ${id}`);
    seen.add(id);
    const assetPaths = [item.poster.path, item.backdrop.path];
    for (const image of [
      ...(item.metadata?.images?.backdrops || []),
      ...(item.metadata?.images?.posters || []),
      ...(item.metadata?.images?.logos || []),
    ]) {
      if (image?.file_path) assetPaths.push(image.file_path);
    }
    for (const person of item.metadata?.credits?.cast || []) {
      if (person?.profile_path) assetPaths.push(person.profile_path);
    }
    for (const video of item.metadata?.videos?.results || []) {
      if (video?.thumbnail_path) assetPaths.push(video.thumbnail_path);
    }
    for (const resource of [item.metadata?.similar, item.metadata?.recommendations]) {
      for (const related of resource?.results || []) {
        if (related?.poster_path) assetPaths.push(related.poster_path);
      }
    }
    for (const related of item.metadata?.belongs_to_collection?.parts || []) {
      if (related?.poster_path) assetPaths.push(related.poster_path);
    }
    for (const season of item.metadata?.seasons || []) {
      if (season.poster?.path) assetPaths.push(season.poster.path);
      if (season.poster_url) assetPaths.push(season.poster_url);
    }
    for (const season of Object.values(item.seasonDetails || {})) {
      if (season.poster_url) assetPaths.push(season.poster_url);
      for (const episode of season.episodes || []) {
        if (episode?.still_path) assetPaths.push(episode.still_path);
      }
    }
    for (const assetPath of [...new Set(assetPaths)]) {
      const absolutePath = path.join(repoRoot, "public", assetPath.replace(/^\/+/, ""));
      if (!fs.existsSync(absolutePath)) fail(`Missing bundled demo asset: ${absolutePath}`);
    }
  }
}

async function main() {
  const configuredDataDir = String(process.env.DATA_DIR || "").trim();
  if (!configuredDataDir) {
    fail("Refusing to seed the shared data directory. Set DATA_DIR to an isolated local demo directory.");
  }
  const resolvedDataDir = path.resolve(configuredDataDir);
  if (resolvedDataDir === path.resolve(sharedDataDir)) {
    fail(`Refusing to seed the normal Plekt data directory: ${resolvedDataDir}`);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  validateCatalog(catalog);

  // Import the database only after the safety guard above. db.js creates and
  // migrates the database as a module side effect.
  const { db, bumpDataVersion } = await import("../server/src/db.js");

  try {
    const historyRows = db.prepare("SELECT id, source, watch_provenance FROM watch_history").all();
    const isDemoFixtureRow = (row) => {
      if (String(row.source || "").trim().toLowerCase() === "demo") return true;
      if (!String(row.id || "").startsWith("demo:")) return false;
      try {
        return JSON.parse(String(row.watch_provenance || "{}")).source === "demo";
      } catch {
        return false;
      }
    };
    const demoHistoryRows = historyRows.filter(isDemoFixtureRow);
    const nonDemoRows = historyRows.length - demoHistoryRows.length;
    if (nonDemoRows > 0) {
      fail(`Refusing to seed a demo database containing ${nonDemoRows} non-demo watch-history row(s).`);
    }

    const clearDemo = db.transaction(() => {
      // Demo interactions can legitimately change the source label to
      // "manual" while retaining the fixture provenance. Remove those rows
      // too, but never touch a row that cannot be identified as demo data.
      const deleteHistoryById = db.prepare("DELETE FROM watch_history WHERE id = ?");
      for (const row of demoHistoryRows) deleteHistoryById.run(row.id);
      // This is an explicitly isolated demo database. Clear provider/cache
      // state wholesale so a previous local preview or provider experiment
      // cannot leak into the no-connections fixture.
      for (const table of [
        "playstate", "playback_progress", "active_sessions", "poster_cache",
        "tmdb_metadata_cache", "tmdb_search_cache", "tmdb_season_cache",
        "tvdb_metadata_cache", "tvdb_season_cache", "personal_ratings",
        "personal_watchlist", "personal_list_items", "personal_lists",
        "personal_watchlist_mutations", "personal_watchlist_activity",
        "personal_watchlist_provider_items", "personal_watchlist_sync_queue",
        "personal_watchlist_sync_runs", "personal_rating_sources",
        "personal_rating_sync_queue", "personal_rating_sync_runs",
      ]) db.prepare(`DELETE FROM ${table}`).run();
      db.prepare("UPDATE personal_watchlist_meta SET revision = 0, updated_at = 0 WHERE id = 1").run();
      db.prepare("DELETE FROM sync_history").run();
      db.prepare("DELETE FROM watch_audit_events").run();
    });
    clearDemo();

    const insertHistory = db.prepare(`
      INSERT INTO watch_history (
        id, title, title_lower, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id, season,
        episode, poster_url, backdrop_url, sync_action, sync_dispatch_telemetry,
        watch_provenance, media_key, show_title, show_title_lower, episode_title,
        created_at, updated_at
      ) VALUES (
        @id, @title, @titleLower, @mediaType, @watchedAt, 'demo', @imdbId, @tmdbId, @tvdbId, @season,
        @episode, @posterUrl, @backdropUrl, 'watched', @telemetry, @provenance,
        @mediaKey, @showTitle, @showTitleLower, @episodeTitle, @createdAt, @updatedAt
      )
    `);
    const insertPlaystate = db.prepare(`
      INSERT INTO playstate (
        media_key, title, title_lower, media_type, state, watched_at, last_source,
        sources, imdb_id, tmdb_id, tvdb_id, season, episode, poster_url, updated_at
      ) VALUES (
        @mediaKey, @title, @titleLower, @mediaType, 'watched', @watchedAt, 'demo',
        @sources, @imdbId, @tmdbId, @tvdbId, @season, @episode, @posterUrl, @updatedAt
      )
    `);
    const insertPoster = db.prepare(`
      INSERT INTO poster_cache (
        id, media_key, variant, status, source, detail, original_url,
        storage_path, content_type, size_bytes, url, updated_at_ms
      ) VALUES (
        @id, @mediaKey, @variant, 'cached', 'demo', 'Bundled TMDB demo artwork',
        @originalUrl, NULL, 'image/webp', @sizeBytes, @url, @updatedAt
      )
    `);
    const insertMetadata = db.prepare(`
      INSERT INTO tmdb_metadata_cache (
        id, tmdb_id, media_type, title, details, status, poster_path,
        cached_poster_url, backdrop_path, cached_backdrop_url, tvdb_poster_url,
        schema_version, updated_at_ms
      ) VALUES (
        @id, @tmdbId, @mediaType, @title, @details, @status, @posterPath,
        @posterUrl, @backdropPath, @backdropUrl, NULL, 15, @updatedAt
      )
    `);
    const insertSeason = db.prepare(`
      INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
      VALUES (@id, @tvdbId, @seasonNumber, @details, @updatedAt)
    `);

    const now = Date.now();
    const episodeCount = 3;
    const seededRows = [];
    const seededShows = catalog.items.filter((item) => item.mediaType === "tv");
    const seededMovies = catalog.items.filter((item) => item.mediaType === "movie");
    const discoveryRows = writeDerivedFixtureFiles(resolvedDataDir, seededMovies, seededShows, now);

    const insertPersonalRating = db.prepare(`
      INSERT INTO personal_ratings (
        media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview,
        release_date, show_title, season, episode, episode_tmdb_id, episode_tvdb_id,
        episode_imdb_id, rating, origin, canonical_updated_at, created_at, updated_at
      ) VALUES (
        @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview,
        @release_date, NULL, NULL, NULL, NULL, NULL, NULL, @rating, 'manual', @updated_at, @created_at, @updated_at
      )
    `);
    const insertWatchlist = db.prepare(`
      INSERT INTO personal_watchlist (
        media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview,
        release_date, created_at, updated_at
      ) VALUES (
        @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview,
        @release_date, @created_at, @updated_at
      )
    `);
    const insertList = db.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES (@id, @name, @created_at, @updated_at)");
    const insertListItem = db.prepare(`
      INSERT INTO personal_list_items (
        list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url,
        overview, release_date, position, created_at, updated_at
      ) VALUES (
        @list_id, @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url,
        @overview, @release_date, @position, @created_at, @updated_at
      )
    `);
    const insertDiscovery = db.prepare(`
      INSERT INTO tmdb_search_cache (id, query, media_type, page, response, missing, updated_at_ms)
      VALUES (@id, @query, @mediaType, 1, @response, 0, @updatedAt)
    `);

    const insertAll = db.transaction(() => {
      catalog.items.forEach((item, index) => {
        const mediaType = item.mediaType === "tv" ? "tv" : "movie";
        const showEpisodeCount = mediaType === "tv"
          ? Math.max(episodeCount, Number(metadataFor(item).number_of_episodes || 0))
          : 0;
        const metadataId = `${mediaType}_${item.tmdbId}`;
        const details = demoDetails(item, mediaType, showEpisodeCount);
        const metadataParams = {
          id: metadataId,
          tmdbId: String(item.tmdbId),
          mediaType,
          title: item.title,
          details: JSON.stringify(details),
          status: details.status || null,
          posterPath: details.poster_path || null,
          posterUrl: item.poster.path,
          backdropPath: details.backdrop_path || null,
          backdropUrl: item.backdrop.path,
          updatedAt: now,
        };
        insertMetadata.run(metadataParams);

        if (mediaType === "tv") {
          const tvdbFixtureId = fixtureTvdbId(item);
          // Keep the bundled TVDB identity aligned with the real metadata
          // gateway, which stores a TVDB alias when a show is resolved that
          // way from a media-server episode.
          insertMetadata.run({ ...metadataParams, id: `tv_tvdb_${tvdbFixtureId}` });
          const seasonNumbers = (details.seasons || [])
            .map((season) => Number(season.season_number))
            .filter((number) => Number.isInteger(number) && number >= 0);
          const uniqueSeasonNumbers = [...new Set(seasonNumbers.length ? seasonNumbers : [1])].sort((a, b) => a - b);
          const watchedSeasonNumber = uniqueSeasonNumbers.find((number) => number > 0) || 1;
          for (const seasonNumber of uniqueSeasonNumbers) {
            const season = seasonFor(item, seasonNumber);
            const seasonEpisodes = episodeRowsFor(item, seasonNumber);
            if (season?.poster?.path || season?.poster_url) {
              insertPoster.run({
                id: `demo:poster:season:${item.tmdbId}:${seasonNumber}`,
                mediaKey: `demo:season:${item.tmdbId}:s${seasonNumber}`,
                variant: "season",
                originalUrl: season.poster?.sourceUrl || "",
                sizeBytes: Number(season.poster?.bytes || 0),
                url: season.poster?.path || season.poster_url,
                updatedAt: now,
              });
            }
            insertSeason.run({
              id: `${tvdbFixtureId}_${seasonNumber}`,
              tvdbId: tvdbFixtureId,
              seasonNumber,
              details: JSON.stringify({ episodes: seasonEpisodes.map((episode) => ({
                number: episode.number,
                name: episode.name,
                overview: episode.overview,
                aired: episode.aired,
                image: episode.image,
                runtime: episode.runtime,
              })) }),
              updatedAt: now,
            });

            if (seasonNumber !== watchedSeasonNumber) continue;
            for (const [episodeIndex, episodeRecord] of seasonEpisodes.slice(0, episodeCount).entries()) {
              const episode = Number(episodeRecord.number || episodeIndex + 1);
              const watchedAt = isoAt((index * episodeCount) + episode, episode);
              const title = `${item.title} - S${String(seasonNumber).padStart(2, "0")}E${padEpisode(episode)} - ${episodeRecord.name}`;
              const mediaKey = `demo:episode:${item.tmdbId}:s${seasonNumber}e${episode}`;
              const id = mediaKey;
              insertHistory.run({
                id,
                title,
                titleLower: title.toLowerCase(),
                mediaType: "episode",
                watchedAt,
                imdbId: String(metadataFor(item).external_ids?.imdb_id || ""),
                tmdbId: String(item.tmdbId),
                tvdbId: tvdbFixtureId,
                season: seasonNumber,
                episode,
                posterUrl: episodeRecord.image || season?.poster_url || item.poster.path,
                backdropUrl: item.backdrop.path,
                telemetry: "Origin: bundled demo fixture\nDispatch status: simulated (no media apps connected)",
                provenance: JSON.stringify({ source: "demo", event: "bundled_fixture", phase: "local_preview", item_id: `tmdb:${item.tmdbId}:s${seasonNumber}e${episode}` }),
                mediaKey,
                showTitle: item.title,
                showTitleLower: item.title.toLowerCase(),
                episodeTitle: episodeRecord.name,
                createdAt: Date.parse(watchedAt),
                updatedAt: now,
              });
              insertPlaystate.run({
                mediaKey,
                title,
                titleLower: title.toLowerCase(),
                mediaType: "episode",
                watchedAt,
                sources: JSON.stringify({ demo: { state: "watched", watchedAt } }),
                imdbId: String(metadataFor(item).external_ids?.imdb_id || ""),
                tmdbId: String(item.tmdbId),
                tvdbId: tvdbFixtureId,
                season: seasonNumber,
                episode,
                posterUrl: episodeRecord.image || season?.poster_url || item.poster.path,
                updatedAt: now,
              });
              insertPoster.run({
                id: `demo:poster:tv:${item.tmdbId}:${seasonNumber}:${episode}`,
                mediaKey,
                variant: "poster",
                originalUrl: season?.poster?.sourceUrl || item.poster.sourceUrl,
                sizeBytes: Number(season?.poster?.bytes || item.poster.bytes || 0),
                url: episodeRecord.image || season?.poster_url || item.poster.path,
                updatedAt: now,
              });
              seededRows.push({ id, mediaKey, title, mediaType: "episode", tmdbId: String(item.tmdbId), season: seasonNumber, episode, posterUrl: episodeRecord.image || season?.poster_url || item.poster.path });
            }
          }
        } else {
          const watchedAt = isoAt(index + 1, index % 6);
          const mediaKey = `demo:movie:${item.tmdbId}`;
          insertHistory.run({
            id: mediaKey,
            title: item.title,
            titleLower: item.title.toLowerCase(),
            mediaType: "movie",
            watchedAt,
            imdbId: String(metadataFor(item).external_ids?.imdb_id || ""),
            tmdbId: String(item.tmdbId),
            tvdbId: "",
            season: null,
            episode: null,
            posterUrl: item.poster.path,
            backdropUrl: item.backdrop.path,
            telemetry: "Origin: bundled demo fixture\nDispatch status: simulated (no media apps connected)",
            provenance: JSON.stringify({ source: "demo", event: "bundled_fixture", phase: "local_preview", item_id: `tmdb:${item.tmdbId}` }),
            mediaKey,
            showTitle: null,
            showTitleLower: null,
            episodeTitle: null,
            createdAt: Date.parse(watchedAt),
            updatedAt: now,
          });
          insertPlaystate.run({
            mediaKey,
            title: item.title,
            titleLower: item.title.toLowerCase(),
            mediaType: "movie",
            watchedAt,
            sources: JSON.stringify({ demo: { state: "watched", watchedAt } }),
            imdbId: String(metadataFor(item).external_ids?.imdb_id || ""),
            tmdbId: String(item.tmdbId),
            tvdbId: "",
            season: null,
            episode: null,
            posterUrl: item.poster.path,
            updatedAt: now,
          });
            insertPoster.run({
              id: `demo:poster:movie:${item.tmdbId}`,
              mediaKey,
              variant: "poster",
              originalUrl: item.poster.sourceUrl,
            sizeBytes: Number(item.poster.bytes || 0),
            url: item.poster.path,
            updatedAt: now,
          });
          seededRows.push({ id: mediaKey, mediaKey, title: item.title, mediaType: "movie", tmdbId: String(item.tmdbId), season: null, episode: null, posterUrl: item.poster.path });
        }
      });

      const watchlistItems = [
        ...seededMovies.slice(0, 12),
        ...seededShows.slice(0, 8),
      ].map(personalMedia);
      for (const item of watchlistItems) insertWatchlist.run({ ...item, created_at: now, updated_at: now });

      const ratingItems = [
        ...seededMovies.slice(4, 14),
        ...seededShows.slice(8, 16),
      ].map(personalMedia);
      ratingItems.forEach((item, index) => insertPersonalRating.run({
        ...item,
        rating: 7 + (index % 4),
        created_at: now - ((index + 1) * 60 * 60 * 1000),
        updated_at: now - ((index + 1) * 30 * 60 * 1000),
      }));

      const listItems = [
        [DEMO_LISTS[0], [...seededMovies.slice(0, 4), ...seededShows.slice(0, 3)]],
        [DEMO_LISTS[1], [...seededMovies.slice(10, 15), ...seededShows.slice(10, 13)]],
        [DEMO_LISTS[2], [...seededMovies.slice(20, 26), ...seededShows.slice(20, 24)]],
      ];
      for (const list of DEMO_LISTS) insertList.run({ id: list.id, name: list.name, created_at: now, updated_at: now });
      for (const [list, items] of listItems) {
        items.map(personalMedia).forEach((item, position) => insertListItem.run({ list_id: list.id, ...item, position, created_at: now, updated_at: now }));
      }
      db.prepare("UPDATE personal_watchlist_meta SET revision = ?, updated_at = ? WHERE id = 1").run(watchlistItems.length, now);
      for (const row of discoveryRows) insertDiscovery.run({ ...row, updatedAt: now });

      // Give the dashboard two local-only resume examples and a synthetic
      // now-playing item. No provider or tracker connection is needed.
      const progressRows = [
        seededRows.find((row) => row.mediaType === "movie"),
        seededRows.find((row) => row.mediaType === "episode" && row.episode === 2),
      ].filter(Boolean);
      const progressValues = [46, 71];
      const insertProgress = db.prepare(`
        INSERT INTO playback_progress (
          media_key, title, media_type, source, tmdb_id, season, episode,
          position_ms, duration_ms, progress, updated_at, sync_dispatch_telemetry
        ) VALUES (
          @mediaKey, @title, @mediaType, 'demo', @tmdbId, @season, @episode,
          @positionMs, 3600000, @progress, @updatedAt, 'Origin: bundled demo fixture'
        )
      `);
      progressRows.forEach((row, index) => insertProgress.run({
        mediaKey: row.mediaKey,
        title: row.title,
        mediaType: row.mediaType,
        tmdbId: row.tmdbId,
        season: row.season,
        episode: row.episode,
        positionMs: Math.round(3600000 * progressValues[index] / 100),
        progress: progressValues[index],
        updatedAt: now - ((index + 1) * 60 * 60 * 1000),
      }));

      const active = seededRows.find((row) => row.mediaType === "episode" && row.episode === 3) || seededRows.find((row) => row.mediaType === "episode");
      if (active) {
        db.prepare(`
          INSERT INTO active_sessions (
            id, title, media_type, source, progress, offset_ms, duration_ms,
            season, episode, poster_url, ids, event, client, updated_at, expire_at
          ) VALUES (
            'demo:session:living-room', @title, @mediaType, 'demo', 38, 1368000,
            3600000, @season, @episode, @posterUrl, @ids, 'play', @client,
            @updatedAt, @expireAt
          )
        `).run({
          title: active.title,
          mediaType: active.mediaType,
          season: active.season,
          episode: active.episode,
          posterUrl: "/demo-assets/posters/tv-1396.webp",
          ids: JSON.stringify({ tmdb: active.tmdbId, mediaKey: active.mediaKey }),
          client: JSON.stringify({ name: "Demo Player", user: "Demo" }),
          updatedAt: now,
          expireAt: now + (2 * 60 * 60 * 1000),
        });
      }

      db.prepare(`
        INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, created_at)
        VALUES (@timestamp, 'library', @title, 'demo', 'success', @details, 'seed', @createdAt)
      `).run({
        timestamp: now,
        title: "Bundled demo catalogue",
        details: `Generated ${seededMovies.length} movies and ${seededShows.length} shows with local-only simulated activity`,
        createdAt: now,
      });
    });
    insertAll();
    bumpDataVersion();

    console.log(`Seeded ${seededMovies.length} movies and ${seededShows.length} shows from ${catalogPath}.`);
    console.log(`Demo data directory: ${resolvedDataDir}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Failed to seed bundled demo catalogue:", error.message || error);
  process.exitCode = 1;
});
