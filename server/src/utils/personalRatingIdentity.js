// Shared identity and payload helpers for Plembfin's canonical personal
// ratings. Watched-state identity deliberately lives elsewhere: a rating
// sync must never silently reuse a watched-state alias or ledger.

const MEDIA_TYPES = new Set(["movie", "tv", "episode"]);
const MAX_TITLE_LENGTH = 300;

function clean(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function titleKey(value) {
  return clean(value, MAX_TITLE_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// A show title can carry its release year ("Ludwig (2024)") when one provider
// sends it and another does not. The year is not part of the show's identity,
// so it is dropped before the title key is built.
export function showTitleKey(value) {
  return titleKey(clean(value, MAX_TITLE_LENGTH).replace(/\s*\(\d{4}\)$/, ""));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function normalizePersonalRatingType(value) {
  const type = clean(value, 40).toLowerCase();
  if (["show", "series"].includes(type)) return "tv";
  return MEDIA_TYPES.has(type) ? type : "";
}

export function personalRatingMediaKey(item = {}) {
  const type = normalizePersonalRatingType(item.media_type || item.mediaType || item.type) || "movie";
  const tmdbId = clean(item.tmdb_id || item.tmdbId, 100);
  const tvdbId = clean(item.tvdb_id || item.tvdbId, 100);
  const imdbId = clean(item.imdb_id || item.imdbId, 100);
  if (type === "episode") {
    const showTitle = clean(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.title || item.name, MAX_TITLE_LENGTH);
    const season = numberOrNull(item.season ?? item.seasonNumber);
    const episode = numberOrNull(item.episode ?? item.episodeNumber);
    const coordinate = `s${Number.isInteger(season) ? season : "?"}e${Number.isInteger(episode) ? episode : "?"}`;
    // Episode ids identify the leaf episode and must not become the parent
    // identity. Only explicit show ids are eligible for an episode rating key.
    const showTmdbId = clean(item.show_tmdb_id || item.showTmdbId, 100);
    const showTvdbId = clean(item.show_tvdb_id || item.showTvdbId, 100);
    const showImdbId = clean(item.show_imdb_id || item.showImdbId, 100);
    if (showTmdbId) return `episode:tmdb:${showTmdbId}:${coordinate}`;
    if (showTvdbId) return `episode:tvdb:${showTvdbId}:${coordinate}`;
    if (showImdbId) return `episode:imdb:${showImdbId}:${coordinate}`;
    return `episode:title:${showTitleKey(showTitle)}:${coordinate}`;
  }
  if (tmdbId) return `${type}:tmdb:${tmdbId}`;
  if (tvdbId) return `${type}:tvdb:${tvdbId}`;
  if (imdbId) return `${type}:imdb:${imdbId}`;
  return `${type}:title:${titleKey(item.title || item.name)}`;
}

function providerIdsFrom(item, prefix = "") {
  const camelName = (name) => name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  const read = (name) => item[`${prefix}${name}`]
    ?? item[`${prefix}${camelName(name)}`]
    ?? item[`${prefix}${name[0].toUpperCase()}${name.slice(1)}`];
  return {
    tmdb: clean(read("tmdb_id") ?? read("tmdb"), 100),
    tvdb: clean(read("tvdb_id") ?? read("tvdb"), 100),
    imdb: clean(read("imdb_id") ?? read("imdb"), 100),
    trakt: clean(read("trakt_id") ?? read("trakt"), 100),
  };
}

export function normalizePersonalRatingMedia(item = {}, { mediaKey = "" } = {}) {
  const mediaType = normalizePersonalRatingType(item.media_type || item.mediaType || item.type);
  if (!MEDIA_TYPES.has(mediaType)) throw new Error("Rating media type must be movie, tv, or episode");
  const isEpisode = mediaType === "episode";
  const title = clean(item.title || item.episode_title || item.episodeTitle || item.name || "Untitled", MAX_TITLE_LENGTH);
  const showTitle = isEpisode
    ? clean(item.show_title || item.showTitle || item.series_title || item.seriesTitle || item.grandparentTitle || item.title || item.name, MAX_TITLE_LENGTH)
    : "";
  const season = isEpisode ? numberOrNull(item.season ?? item.seasonNumber) : null;
  const episode = isEpisode ? numberOrNull(item.episode ?? item.episodeNumber) : null;
  const showIds = isEpisode
    ? {
        tmdb: clean(item.show_tmdb_id || item.showTmdbId || item.tmdb_id || item.tmdbId, 100),
        tvdb: clean(item.show_tvdb_id || item.showTvdbId || item.tvdb_id || item.tvdbId, 100),
        imdb: clean(item.show_imdb_id || item.showImdbId || item.imdb_id || item.imdbId, 100),
        trakt: clean(item.show_trakt_id || item.showTraktId || item.trakt_id || item.traktId, 100),
      }
    : providerIdsFrom(item);
  const episodeIds = isEpisode
    ? {
        ...providerIdsFrom(item, "episode_"),
        ...(item.episode_provider_ids && typeof item.episode_provider_ids === "object" ? item.episode_provider_ids : {}),
        ...(item.episodeProviderIds && typeof item.episodeProviderIds === "object" ? item.episodeProviderIds : {}),
      }
    : {};
  const normalizedEpisodeIds = Object.fromEntries(
    Object.entries(episodeIds).map(([key, value]) => [key, clean(value, 100)]).filter(([, value]) => value),
  );
  const normalizedShowIds = Object.fromEntries(
    Object.entries(showIds).map(([key, value]) => [key, clean(value, 100)]).filter(([, value]) => value),
  );
  const normalized = {
    media_key: mediaKey || clean(item.media_key || item.mediaKey, 400) || personalRatingMediaKey({
      ...item,
      media_type: mediaType,
      title,
      show_title: showTitle,
      show_tmdb_id: normalizedShowIds.tmdb,
      show_tvdb_id: normalizedShowIds.tvdb,
      show_imdb_id: normalizedShowIds.imdb,
      tmdb_id: isEpisode ? normalizedShowIds.tmdb : normalizedShowIds.tmdb,
      tvdb_id: isEpisode ? normalizedShowIds.tvdb : normalizedShowIds.tvdb,
      imdb_id: isEpisode ? normalizedShowIds.imdb : normalizedShowIds.imdb,
      season,
      episode,
    }),
    media_type: mediaType,
    type: mediaType,
    title,
    tmdb_id: normalizedShowIds.tmdb || "",
    tvdb_id: normalizedShowIds.tvdb || "",
    imdb_id: normalizedShowIds.imdb || "",
    trakt_id: normalizedShowIds.trakt || "",
    show_title: showTitle,
    show_tmdb_id: isEpisode ? normalizedShowIds.tmdb || "" : "",
    show_tvdb_id: isEpisode ? normalizedShowIds.tvdb || "" : "",
    show_imdb_id: isEpisode ? normalizedShowIds.imdb || "" : "",
    show_trakt_id: isEpisode ? normalizedShowIds.trakt || "" : "",
    episode_tmdb_id: normalizedEpisodeIds.tmdb || "",
    episode_tvdb_id: normalizedEpisodeIds.tvdb || "",
    episode_imdb_id: normalizedEpisodeIds.imdb || "",
    episode_trakt_id: normalizedEpisodeIds.trakt || "",
    episode_provider_ids: normalizedEpisodeIds,
    provider_item_ids: item.provider_item_ids && typeof item.provider_item_ids === "object"
      ? Object.fromEntries(Object.entries(item.provider_item_ids).map(([key, value]) => [key, clean(value, 200)]).filter(([, value]) => value))
      : {},
    season,
    episode,
    year: numberOrNull(item.year || item.production_year || item.productionYear),
    poster_url: clean(item.poster_url || item.posterUrl || item.imageUrl, 2000),
    overview: clean(item.overview || item.description, 4000),
    release_date: clean(item.release_date || item.releaseDate || item.first_air_date, 40),
    episode_title: isEpisode ? clean(item.episode_title || item.episodeTitle || item.name || item.title, MAX_TITLE_LENGTH) : "",
  };
  return normalized;
}

export function personalRatingMediaAliases(media = {}) {
  const normalized = normalizePersonalRatingMedia(media);
  const ids = normalized.media_type === "episode"
    ? normalized.show_tmdb_id || normalized.show_tvdb_id || normalized.show_imdb_id || normalized.show_trakt_id
      ? {
          tmdb: normalized.show_tmdb_id,
          tvdb: normalized.show_tvdb_id,
          imdb: normalized.show_imdb_id,
          trakt: normalized.show_trakt_id,
        }
      : {}
    : {
        tmdb: normalized.tmdb_id,
        tvdb: normalized.tvdb_id,
        imdb: normalized.imdb_id,
        trakt: normalized.trakt_id,
      };
  const aliases = [];
  for (const [provider, value] of Object.entries(ids)) {
    if (!value) continue;
    aliases.push(normalized.media_type === "episode"
      ? `episode:${provider}:${value}:s${normalized.season ?? "?"}e${normalized.episode ?? "?"}`
      : `${normalized.media_type}:${provider}:${value}`);
  }
  if (!aliases.length || normalized.media_type === "episode") {
    aliases.push(personalRatingMediaKey(normalized));
  }
  return [...new Set(aliases)];
}

export function ratingMediaForStorage(media = {}) {
  const normalized = normalizePersonalRatingMedia(media);
  return {
    media_key: normalized.media_key,
    media_type: normalized.media_type,
    title: normalized.title,
    tmdb_id: normalized.tmdb_id || null,
    tvdb_id: normalized.tvdb_id || null,
    imdb_id: normalized.imdb_id || null,
    poster_url: normalized.poster_url || null,
    overview: normalized.overview || null,
    release_date: normalized.release_date || null,
    show_title: normalized.show_title || null,
    season: normalized.season,
    episode: normalized.episode,
    episode_tmdb_id: normalized.episode_tmdb_id || null,
    episode_tvdb_id: normalized.episode_tvdb_id || null,
    episode_imdb_id: normalized.episode_imdb_id || null,
    episode_title: normalized.episode_title || null,
    show_tmdb_id: normalized.show_tmdb_id || null,
    show_tvdb_id: normalized.show_tvdb_id || null,
    show_imdb_id: normalized.show_imdb_id || null,
    show_trakt_id: normalized.show_trakt_id || null,
    trakt_id: normalized.trakt_id || null,
    year: normalized.year,
  };
}
