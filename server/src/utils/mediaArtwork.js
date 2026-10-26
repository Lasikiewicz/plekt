import { existsSync } from "node:fs";
import path from "node:path";
import { db, parseJson, transaction } from "../db.js";
import { MEDIA_DIR } from "../paths.js";

// Show and movie artwork is deliberately stored separately from watch_history.poster_url.
// The latter belongs to the recorded media item (and can be an episode still),
// while this table represents the poster chosen for the show or movie as a whole.
const selectArtworkByIdentityStmt = db.prepare(
  "SELECT poster_url FROM media_artwork WHERE identity_key = ? LIMIT 1",
);
const selectArtworkRecordByIdentityStmt = db.prepare(
  "SELECT poster_url, poster_source FROM media_artwork WHERE identity_key = ? LIMIT 1",
);
const selectTmdbMetadataStmt = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?");
const selectTmdbPosterFieldsStmt = db.prepare("SELECT poster_path, cached_poster_url, tvdb_poster_url FROM tmdb_metadata_cache WHERE id = ?");
const selectCachedTvSeasonPostersStmt = db.prepare(`
  WITH selected_metadata AS (
    SELECT id, details
    FROM tmdb_metadata_cache
    WHERE media_type = 'tv'
      AND (
        (
          @tmdb_id <> ''
          AND id = 'tv_' || @tmdb_id
          AND (@tvdb_id = '' OR CASE WHEN json_valid(details) THEN json_extract(details, '$.external_ids.tvdb_id') END = @tvdb_id)
        )
        OR (
          @tvdb_id <> ''
          AND id = 'tv_tvdb_' || @tvdb_id
          AND CASE WHEN json_valid(details) THEN json_extract(details, '$.external_ids.tvdb_id') END = @tvdb_id
        )
      )
    ORDER BY CASE WHEN id = 'tv_' || @tmdb_id THEN 0 ELSE 1 END
    LIMIT 1
  )
  SELECT
    CAST(json_extract(season.value, '$.season_number') AS INTEGER) AS season_number,
    COALESCE(
      NULLIF(json_extract(season.value, '$.poster_url'), ''),
      NULLIF(json_extract(season.value, '$.posterUrl'), ''),
      NULLIF(json_extract(season.value, '$.cached_poster_url'), ''),
      NULLIF(json_extract(season.value, '$.cachedPosterUrl'), ''),
      NULLIF(json_extract(season.value, '$.poster_path'), ''),
      NULLIF(json_extract(season.value, '$.posterPath'), ''),
      NULLIF(json_extract(season.value, '$.image_url'), ''),
      NULLIF(json_extract(season.value, '$.imageUrl'), ''),
      NULLIF(json_extract(season.value, '$.image'), ''),
      NULLIF(json_extract(season.value, '$.poster.path'), '')
    ) AS poster
  FROM selected_metadata AS metadata
  JOIN json_each(
    CASE WHEN json_valid(metadata.details) THEN metadata.details ELSE '{"seasons":[]}' END,
    '$.seasons'
  ) AS season
`);
const selectPosterCacheStmt = db.prepare(
  "SELECT url FROM poster_cache WHERE media_key = ? AND variant = 'poster' AND status = 'cached' LIMIT 1",
);
const selectTvdbMetadataStmt = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE id = ?");
// Only the tvdb id is needed to index every cached TV entry. Parsing each
// details blob in JavaScript to reach it blocked the event loop for about
// 350 ms on a real library; SQLite extracts it in about a third of that.
// Empty and zero ids fall through to tvdbId, as the JavaScript || chain did.
const selectCachedTvTvdbIdsStmt = db.prepare(`
  SELECT id, COALESCE(
    NULLIF(NULLIF(json_extract(details, '$.external_ids.tvdb_id'), ''), 0),
    json_extract(details, '$.external_ids.tvdbId')
  ) AS tvdb_id
  FROM tmdb_metadata_cache
  WHERE media_type = 'tv' AND details IS NOT NULL AND json_valid(details)
  ORDER BY rowid
`);
const selectSeasonArtworkByKeyStmt = db.prepare(
  "SELECT season_number, poster_url FROM season_artwork WHERE identity_key = ?",
);
const upsertSeasonArtworkStmt = db.prepare(`
  INSERT INTO season_artwork (identity_key, season_number, poster_url, poster_source, updated_at)
  VALUES (@identity_key, @season_number, @poster_url, @poster_source, @updated_at)
  ON CONFLICT(identity_key, season_number) DO UPDATE SET
    poster_url = excluded.poster_url,
    poster_source = excluded.poster_source,
    updated_at = excluded.updated_at
`);
const upsertArtworkStmt = db.prepare(`
  INSERT INTO media_artwork
    (identity_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, poster_source, updated_at)
  VALUES (@identity_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @poster_source, @updated_at)
  ON CONFLICT(identity_key) DO UPDATE SET
    media_type = excluded.media_type,
    title = excluded.title,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    imdb_id = excluded.imdb_id,
    poster_url = excluded.poster_url,
    poster_source = excluded.poster_source,
    updated_at = excluded.updated_at
`);

let cachedTvdbToTmdb = { expiresAt: 0, values: new Map() };

function clean(value) {
  return String(value ?? "").trim();
}

function posterUrlIsAvailable(value = "") {
  const url = clean(value);
  if (!url.startsWith("/media/")) return Boolean(url);

  const storagePath = url.slice("/media/".length).split(/[?#]/, 1)[0];
  if (!/^(?:posters|backdrops|profiles|logos)\/[\w.-]+$/.test(storagePath)) return false;
  return existsSync(path.join(MEDIA_DIR, storagePath));
}

function mediaTypeFor(item = {}) {
  const raw = clean(item.media_type || item.mediaType || item.type).toLowerCase();
  if (raw === "movie") return "movie";
  if (raw === "episode") return "episode";
  return "tv";
}

function titleFor(item = {}, mediaType = mediaTypeFor(item)) {
  if (mediaType === "episode") return clean(item.show_title || item.showTitle || item.series_title || item.seriesTitle || "");
  return clean(item.title || item.name || "");
}

function titleKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function firstId(...values) {
  return values.map(clean).find(Boolean) || "";
}

// Episode rows usually carry episode-level provider ids. Only use explicit
// show_* ids for them by default. Personal-media rows can opt into their
// stored ids because that endpoint normalizes episode identity to the series.
export function showArtworkIdentity(item = {}, { allowEpisodeProviderIds = false } = {}) {
  const mediaType = mediaTypeFor(item);
  const isEpisode = mediaType === "episode";
  return {
    media_type: mediaType === "movie" ? "movie" : "tv",
    title: titleFor(item, mediaType),
    tmdb_id: firstId(
      item.show_tmdb_id,
      item.showTmdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.tmdb_id || item.tmdbId : "",
    ),
    tvdb_id: firstId(
      item.show_tvdb_id,
      item.showTvdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.tvdb_id || item.tvdbId : "",
    ),
    imdb_id: firstId(
      item.show_imdb_id,
      item.showImdbId,
      (!isEpisode || allowEpisodeProviderIds) ? item.imdb_id || item.imdbId : "",
    ),
  };
}

export function mediaArtworkIdentityKeys(item = {}, { allowEpisodeProviderIds = false, includeTitle = true } = {}) {
  const identity = showArtworkIdentity(item, { allowEpisodeProviderIds });
  const type = identity.media_type === "movie" ? "movie" : "tv";
  const keys = [];
  if (identity.tmdb_id) keys.push(`${type}:tmdb:${identity.tmdb_id}`);
  if (identity.tvdb_id) keys.push(`${type}:tvdb:${identity.tvdb_id}`);
  if (identity.imdb_id) keys.push(`${type}:imdb:${identity.imdb_id.toLowerCase()}`);
  if (includeTitle && identity.title) {
    const key = titleKey(identity.title);
    if (key) keys.push(`${type}:title:${key}`);
  }
  return [...new Set(keys)];
}

export function canonicalMediaArtworkCacheKey(item = {}) {
  const identity = showArtworkIdentity(item);
  const prefix = identity.media_type === "movie" ? "movie" : "tv";
  return mediaArtworkIdentityKeys(item, { includeTitle: true })[0] || `${prefix}:title:unknown`;
}

function posterUrlFromTmdbDetails(details, tmdbId = "", mediaType = "tv") {
  if (!details) return "";
  const cached = clean(details.cached_poster_url || details.cachedPosterUrl);
  if (posterUrlIsAvailable(cached)) return cached;
  const path = clean(details.poster_path || details.posterPath);
  if (path) {
    return `/api/tmdb-poster?path=${encodeURIComponent(path)}&tmdbId=${encodeURIComponent(tmdbId)}&mediaType=${encodeURIComponent(mediaType)}`;
  }
  const tvdbPoster = clean(details.tvdb_poster_url || details.tvdbPosterUrl || details.image_url || details.imageUrl || details.image);
  if (tvdbPoster) return remoteArtworkUrl(tvdbPoster);
  return "";
}

function cachedSeasonPosterUrl(rawPoster, tmdbId = "") {
  const poster = clean(rawPoster);
  if (!poster) return "";
  if (/^\/(?:api\/|media\/|demo-assets\/)/i.test(poster)) return poster;

  let url = null;
  if (/^https?:\/\//i.test(poster)) {
    try {
      url = new URL(poster);
    } catch {
      return "";
    }
  } else if (/^\/banners\//i.test(poster)) {
    url = new URL(`https://artworks.thetvdb.com${poster}`);
  }

  if (url) {
    const host = url.hostname.toLowerCase();
    if (host === "image.tmdb.org") {
      const file = url.pathname.split("/").filter(Boolean).at(-1) || "";
      if (!/^[-A-Za-z0-9_]+\.(?:jpg|jpeg|png|webp)$/i.test(file)) return "";
      return `/api/tmdb-poster?path=${encodeURIComponent(`/${file}`)}${tmdbId ? `&tmdbId=${encodeURIComponent(tmdbId)}` : ""}&mediaType=tv`;
    }
    if (host === "artworks.thetvdb.com" || host === "assets.fanart.tv") {
      if (url.protocol !== "https:") url.protocol = "https:";
      return `/api/remote-artwork?variant=poster&url=${encodeURIComponent(url.toString())}`;
    }
    return "";
  }

  if (/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(poster)) {
    return `/api/tmdb-poster?path=${encodeURIComponent(poster)}${tmdbId ? `&tmdbId=${encodeURIComponent(tmdbId)}` : ""}&mediaType=tv`;
  }
  return "";
}

// Season art belongs to an episode's season, while getCanonicalPosterUrl
// continues to resolve the artwork shared by the show itself. Read only the
// compact season poster fields from cached metadata so episode-card rendering
// does not parse a full TV details blob for every show.
export function getCanonicalSeasonPosterUrls(item = {}) {
  const identity = showArtworkIdentity(item);
  const hasProviderIdentity = Boolean(identity.tmdb_id || identity.tvdb_id || identity.imdb_id);
  const rows = hasProviderIdentity
    ? selectCachedTvSeasonPostersStmt.all({
      tmdb_id: identity.tmdb_id,
      tvdb_id: identity.tvdb_id,
    })
    : [];
  const posters = new Map();
  for (const row of rows) {
    if (row.season_number == null) continue;
    const seasonNumber = Number(row.season_number);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) continue;
    const posterUrl = cachedSeasonPosterUrl(row.poster, identity.tmdb_id);
    if (posterUrl) posters.set(seasonNumber, posterUrl);
  }
  // A chosen season poster outranks the provider art cached above.
  const identityKeys = mediaArtworkIdentityKeys(item, { includeTitle: false });
  const lookupKeys = identityKeys.length
    ? identityKeys
    : mediaArtworkIdentityKeys(item, { includeTitle: true });
  for (const identityKey of lookupKeys) {
    for (const row of selectSeasonArtworkByKeyStmt.all(identityKey)) {
      if (row.poster_url) posters.set(Number(row.season_number), row.poster_url);
    }
  }
  return posters;
}

// Season posters follow the show poster's alias rule: one value is written to
// every known identity key, so a show found under TMDB, TVDB or IMDb converges.
export function saveCanonicalSeasonPoster(item = {}, seasonNumber, posterUrl = "", { source = "manual" } = {}) {
  const number = Number(seasonNumber);
  const url = clean(posterUrl);
  if (!url || !Number.isInteger(number) || number < 0) return { ok: false, identity_keys: [] };
  const keys = mediaArtworkIdentityKeys(item, { includeTitle: true });
  if (!keys.length) return { ok: false, identity_keys: [] };
  const timestamp = Date.now();
  transaction(() => {
    for (const identityKey of keys) {
      upsertSeasonArtworkStmt.run({
        identity_key: identityKey,
        season_number: number,
        poster_url: url,
        poster_source: clean(source) || "manual",
        updated_at: timestamp,
      });
    }
  });
  return { ok: true, poster_url: url, identity_keys: keys };
}

function remoteArtworkUrl(url) {
  if (!/^https:\/\//i.test(url)) return url;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host !== "assets.fanart.tv" && host !== "artworks.thetvdb.com" && host !== "artworks.thetvdb.com.") return url;
    return `/api/remote-artwork?variant=poster&url=${encodeURIComponent(url)}`;
  } catch {
    return "";
  }
}

function cachedTmdbDetails(tmdbId) {
  const id = clean(tmdbId);
  if (!id) return null;
  const row = selectTmdbMetadataStmt.get(`tv_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

// Resolving a poster needs three fields, but they live inside a details blob
// that averages 64KB for a TV entry, and a library page resolves one per row.
// The same three fields are mirrored into their own columns on every cache
// write, so read those and only parse the blob when the row predates them.
function cachedTmdbPosterFields(cacheId, blobLoader) {
  const row = selectTmdbPosterFieldsStmt.get(cacheId);
  if (row && (row.poster_path || row.cached_poster_url || row.tvdb_poster_url)) return row;
  return blobLoader();
}

function cachedTmdbMovieDetails(tmdbId) {
  const id = clean(tmdbId);
  if (!id) return null;
  const row = selectTmdbMetadataStmt.get(`movie_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function cachedTvdbDetails(tvdbId) {
  const id = clean(tvdbId);
  if (!id) return null;
  const row = selectTvdbMetadataStmt.get(`series_${id}`);
  return row?.details ? parseJson(row.details) : null;
}

function tmdbDetailsForTvdbId(tvdbId) {
  const id = clean(tvdbId);
  if (!id) return null;
  const now = Date.now();
  if (now >= cachedTvdbToTmdb.expiresAt) {
    const values = new Map();
    for (const row of selectCachedTvTvdbIdsStmt.all()) {
      const externalTvdbId = clean(row.tvdb_id);
      if (externalTvdbId) values.set(externalTvdbId, { cacheId: row.id, details: undefined });
    }
    cachedTvdbToTmdb = { expiresAt: now + 10000, values };
  }
  // Parse a show's details the first time it is looked up in this window.
  const entry = cachedTvdbToTmdb.values.get(id);
  if (!entry) return null;
  if (entry.details === undefined) {
    const row = selectTmdbMetadataStmt.get(entry.cacheId);
    entry.details = row?.details ? parseJson(row.details) : null;
  }
  return entry.details || null;
}

function metadataPosterForIdentity(identity) {
  if (identity.media_type === "movie") {
    const movieId = clean(identity.tmdb_id);
    const tmdbDetails = movieId
      ? cachedTmdbPosterFields(`movie_${movieId}`, () => cachedTmdbMovieDetails(movieId))
      : null;
    const tmdbPoster = posterUrlFromTmdbDetails(tmdbDetails, identity.tmdb_id, "movie");
    if (tmdbPoster) return tmdbPoster;

    if (identity.tmdb_id) {
      const cached = selectPosterCacheStmt.get(`tmdb:movie:${identity.tmdb_id}`);
      if (posterUrlIsAvailable(cached?.url)) return cached.url;
    }
    return "";
  }

  const showId = clean(identity.tmdb_id);
  const tmdbDetails = showId
    ? cachedTmdbPosterFields(`tv_${showId}`, () => cachedTmdbDetails(showId))
    : null;
  const tmdbPoster = posterUrlFromTmdbDetails(tmdbDetails, identity.tmdb_id, "tv");
  if (tmdbPoster) return tmdbPoster;

  const tvdbDetails = cachedTvdbDetails(identity.tvdb_id);
  const tvdbPoster = posterUrlFromTmdbDetails(tvdbDetails, identity.tmdb_id, "tv");
  if (tvdbPoster) return tvdbPoster;

  const mappedTmdbDetails = tmdbDetailsForTvdbId(identity.tvdb_id);
  return posterUrlFromTmdbDetails(mappedTmdbDetails, clean(mappedTmdbDetails?.id), "tv");
}

function storedPosterForKeys(keys = []) {
  for (const key of keys) {
    const row = selectArtworkByIdentityStmt.get(key);
    const poster = clean(row?.poster_url);
    if (posterUrlIsAvailable(poster)) return poster;
  }
  return "";
}

// Resolve the show or movie poster used by shared cards and detail pages. Manual artwork
// wins over provider metadata. A title key is used only when the caller has no
// trusted show-level provider identity, which is necessary for legacy episode
// rows that only know their show title.
export function getCanonicalPosterUrl(item = {}, options = {}) {
  const identity = showArtworkIdentity(item, options);
  const stableKeys = mediaArtworkIdentityKeys(identity, { includeTitle: false });
  const lookupKeys = stableKeys.length
    ? stableKeys
    : mediaArtworkIdentityKeys(identity, { includeTitle: true });
  const manual = storedPosterForKeys(lookupKeys);
  if (manual) return manual;
  return metadataPosterForIdentity(identity);
}

// Save all known aliases to the same canonical value. This lets a show or movie found
// via TMDB, TVDB, IMDb, or a legacy title-only personal row converge on the
// same edited poster without copying it into any episode record.
export function saveCanonicalPoster(item = {}, posterUrl = "", { source = "manual", preserveExisting = false } = {}) {
  const identity = showArtworkIdentity(item);
  const url = clean(posterUrl);
  if (!url) return { ok: false, identity_keys: [] };
  const keys = mediaArtworkIdentityKeys(identity, { includeTitle: true });
  if (!keys.length) return { ok: false, identity_keys: [] };
  const timestamp = Date.now();
  let changed = 0;
  transaction(() => {
    for (const identityKey of keys) {
      const existing = preserveExisting ? selectArtworkRecordByIdentityStmt.get(identityKey) : null;
      if (preserveExisting && existing?.poster_url) continue;
      upsertArtworkStmt.run({
        identity_key: identityKey,
        media_type: identity.media_type,
        title: identity.title || null,
        tmdb_id: identity.tmdb_id || null,
        tvdb_id: identity.tvdb_id || null,
        imdb_id: identity.imdb_id || null,
        poster_url: url,
        poster_source: clean(source) || "manual",
        updated_at: timestamp,
      });
      changed += 1;
    }
  });
  return { ok: true, changed, poster_url: url, identity_keys: keys };
}
