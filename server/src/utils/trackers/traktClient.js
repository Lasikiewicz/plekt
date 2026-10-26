import { fetchWithTimeout } from "../outbound.js";
import { ratingSnapshotArray } from "../ratingSnapshotSafety.js";
const API_BASE = "https://api.trakt.tv";
const API_VERSION = "2";
const USER_AGENT = "Plekt (https://github.com/Lasikiewicz/plekt)";

async function request(url, { method = "GET", body, clientId, accessToken, timeoutMs = 20_000, includePagination = false, lane = "sync" } = {}) {
  const response = await fetchWithTimeout(url, {
    method,
    lane,
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "trakt-api-version": API_VERSION,
      ...(clientId ? { "trakt-api-key": clientId } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  }, timeoutMs);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error_description || data?.error || `Trakt request failed with ${response.status}`);
    error.status = response.status;
    error.retryAfter = Number(response.headers.get("retry-after") || 0);
    error.body = data;
    throw error;
  }
  if (includePagination) {
    return {
      data,
      page: Number(response.headers.get("x-pagination-page") || 0),
      pageCount: Number(response.headers.get("x-pagination-page-count") || 0),
      pageLimit: Number(response.headers.get("x-pagination-limit") || 0),
    };
  }
  return data;
}

export function startTraktDeviceAuth(clientId) {
  return request(`${API_BASE}/oauth/device/code`, { method: "POST", clientId, body: { client_id: clientId } });
}

export async function pollTraktDeviceAuth({ deviceCode, clientId, clientSecret }) {
  return request(`${API_BASE}/oauth/device/token`, {
    method: "POST", clientId, body: { code: deviceCode, client_id: clientId, client_secret: clientSecret },
  });
}

export function refreshTraktToken({ refreshToken, clientId, clientSecret }) {
  return request(`${API_BASE}/oauth/token`, {
    method: "POST", clientId,
    body: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", redirect_uri: "urn:ietf:wg:oauth:2.0:oob" },
  });
}

export function getTraktUser({ clientId, accessToken }) {
  return request(`${API_BASE}/users/settings`, { clientId, accessToken });
}

export function fetchTraktLastActivities(connection) {
  return request(`${API_BASE}/sync/last_activities`, connection);
}

export async function fetchTraktDroppedShows(connection) {
  const rows = [];
  const limit = 100;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await request(`${API_BASE}/users/hidden/dropped?page=${page}&limit=${limit}&extended=full`, { ...connection, includePagination: true });
    if (!Array.isArray(result.data) || result.data.length > limit) throw new Error("Trakt dropped-show response was incomplete");
    rows.push(...result.data);
    if (result.pageCount > 0 ? page >= result.pageCount : result.data.length < limit) return rows;
  }
  throw new Error("Trakt dropped-show snapshot exceeded the pagination safety limit");
}

export function addTraktDroppedShows(connection, shows) {
  return request(`${API_BASE}/users/hidden/dropped`, { ...connection, method: "POST", body: { shows } });
}

export function removeTraktDroppedShows(connection, shows) {
  return request(`${API_BASE}/users/hidden/dropped/remove`, { ...connection, method: "POST", body: { shows } });
}

export async function setTraktDroppedShow(connection, show, dropped) {
  const payload = { ids: show?.ids || {} };
  if (!Object.keys(payload.ids).length) throw new Error("Trakt dropped write needs a verified show id");
  const result = dropped
    ? await addTraktDroppedShows(connection, [payload])
    : await removeTraktDroppedShows(connection, [payload]);
  const notFound = result?.not_found?.shows;
  const count = dropped ? result?.added?.shows : result?.deleted?.shows;
  if (!Array.isArray(notFound) || notFound.length || !Number.isFinite(Number(count)) || Number(count) < 0) {
    throw new Error("Trakt did not return a complete dropped-show write result");
  }
  const snapshot = await fetchTraktDroppedShows(connection);
  const matches = snapshot.filter((entry) => {
    const remoteIds = entry?.show?.ids || {};
    const overlap = Object.entries(payload.ids).filter(([key]) => remoteIds[key] != null);
    return overlap.length > 0 && overlap.every(([key, value]) => String(remoteIds[key]) === String(value));
  });
  if (matches.length !== (dropped ? 1 : 0)) throw new Error("Trakt dropped-show state was not confirmed by readback");
  return { result, confirmed: true };
}

// Provider identity lookups are used by the background reconciliation pass.
// Keep them separate from watched/history snapshots: a show can be absent from
// the user's watched list while still being a perfectly valid Trakt catalogue
// match for an outbound episode update.
export async function fetchTraktShowByProviderId(connection, provider, id) {
  const providerName = String(provider || "").trim().toLowerCase();
  if (!new Set(["tmdb", "tvdb"]).has(providerName)) throw new Error("Trakt show lookup requires a TMDB or TVDB provider");
  const cleanId = String(id || "").trim();
  if (!cleanId) return null;
  const matches = await request(`${API_BASE}/search/${providerName}/${encodeURIComponent(cleanId)}?type=show&limit=1`, connection);
  const show = Array.isArray(matches) ? matches[0]?.show : null;
  if (!show || typeof show !== "object") return null;
  return { ...show, ids: cleanIds(show.ids || {}) };
}

export async function fetchTraktSeasonEpisodes(connection, traktShowId, season) {
  const showId = String(traktShowId || "").trim();
  const seasonNumber = Number(season);
  if (!showId || !Number.isInteger(seasonNumber) || seasonNumber < 0) return [];
  const episodes = await request(`${API_BASE}/shows/${encodeURIComponent(showId)}/seasons/${seasonNumber}?extended=full`, connection);
  return Array.isArray(episodes) ? episodes : [];
}

async function fetchAllWatchedPages(type, connection, { extended = "full" } = {}) {
  const limit = 250;
  const items = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/sync/watched/${type}?extended=${encodeURIComponent(extended)}&page=${page}&limit=${limit}`, {
      ...connection,
      includePagination: true,
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    items.push(...rows);
    if (result.pageCount > 0 ? page >= result.pageCount : rows.length < (result.pageLimit || limit)) return items;
  }
  throw new Error(`Trakt ${type} watched history exceeded the pagination safety limit`);
}

function cleanIds(ids = {}) {
  return Object.fromEntries(Object.entries(ids).filter(([key, value]) => ["trakt", "imdb", "tmdb", "tvdb"].includes(key) && value != null && String(value) !== ""));
}

function isShowWatchType(type) {
  return type === "tv" || type === "show" || type === "series";
}

function normalizedMediaKey(type, ids, season, episode) {
  const identity = ids.imdb ? `imdb:${ids.imdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : ids.tvdb ? `tvdb:${ids.tvdb}` : ids.trakt ? `trakt:${ids.trakt}` : "";
  if (type === "episode") return `episode:${identity}:s${Number(season)}e${Number(episode)}`;
  if (isShowWatchType(type)) return `show:${identity}`;
  return `movie:${identity}`;
}

// trackerMediaKey deliberately chooses one stable, preferred provider id for
// storage. The preferred id can still change when one side has richer metadata
// than the other (for example, a Trakt snapshot has IMDb+TMDB while an outbound
// item only had TMDB). Expose every safe provider-specific identity as well so
// the outbound echo ledger can recognise those two keys as the same real item.
export function trackerMediaIdentityKeys(media = {}) {
  const type = media.type || media.mediaType;
  if (type !== "episode" && type !== "movie" && !isShowWatchType(type)) return [];
  const ids = cleanIds(media.ids);
  return Object.entries(ids).map(([provider, value]) => normalizedMediaKey(
    type,
    { [provider]: value },
    media.season,
    media.episode,
  ));
}

function trackerEpisodeCoordinates(media = {}) {
  const titleMatch = String(media.title || "").match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  const season = Number(media.season ?? titleMatch?.[1]);
  const episode = Number(media.episode ?? titleMatch?.[2]);
  return {
    season: Number.isInteger(season) ? season : null,
    episode: Number.isInteger(episode) ? episode : null,
  };
}

function trackerEpisodeShowTitle(media = {}) {
  const explicit = media.showTitle || media.show_title || media.seriesTitle;
  const title = explicit || String(media.title || "").replace(/\s+-\s+S\d{1,3}E\d{1,3}.*$/i, "");
  return String(title || "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function trackerMediaMatches(left = {}, right = {}) {
  const leftType = left.type || left.mediaType;
  const rightType = right.type || right.mediaType;
  if (!leftType || leftType !== rightType) return false;
  if (leftType === "episode" && (
    Number(left.season) !== Number(right.season)
    || Number(left.episode) !== Number(right.episode)
  )) return false;
  const rightKeys = new Set(trackerMediaIdentityKeys(right));
  if (trackerMediaIdentityKeys(left).some((key) => rightKeys.has(key))) return true;

  // An authoritative Force Sync can carry a stale provider id while the
  // Trakt snapshot has the same episode under the corrected series id. This
  // fallback is only for matching the recent outbound echo ledger; it does not
  // create a Trakt payload or merge the underlying provider identities. Requiring
  // an id on both sides keeps title-only records from collapsing unrelated shows.
  if (leftType !== "episode" || !trackerMediaIdentityKeys(left).length || !rightKeys.size) return false;
  const leftCoordinates = trackerEpisodeCoordinates(left);
  const rightCoordinates = trackerEpisodeCoordinates(right);
  return leftCoordinates.season !== null
    && leftCoordinates.episode !== null
    && leftCoordinates.season === rightCoordinates.season
    && leftCoordinates.episode === rightCoordinates.episode
    && trackerEpisodeShowTitle(left) !== ""
    && trackerEpisodeShowTitle(left) === trackerEpisodeShowTitle(right);
}

function normalizeMovie(entry) {
  const movie = entry.movie || entry;
  const ids = cleanIds(movie.ids);
  const media = { isValid: true, source: "trakt", type: "movie", mediaType: "movie", title: movie.title || "Unknown movie", year: movie.year || null, ids };
  return { mediaKey: normalizedMediaKey("movie", ids), media, watchedAt: Date.parse(entry.last_watched_at || entry.watched_at || "") || Date.now() };
}

function normalizeEpisode(showEntry, episodeEntry) {
  const show = showEntry.show || {};
  const episode = episodeEntry.episode || episodeEntry;
  const ids = cleanIds(show.ids || {});
  const episodeIds = cleanIds(episode.ids || {});
  const season = Number(episode.season);
  const number = Number(episode.number);
  const displayTitle = `${show.title || "Unknown show"} - S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}${episode.title ? ` - ${episode.title}` : ""}`;
  const media = { isValid: true, source: "trakt", type: "episode", mediaType: "episode", title: displayTitle, showTitle: show.title || "", episodeTitle: episode.title || "", season, episode: number, year: show.year || null, ids, trackerEpisodeIds: episodeIds };
  return { mediaKey: normalizedMediaKey("episode", ids, season, number), media, watchedAt: Date.parse(episodeEntry.last_watched_at || episodeEntry.watched_at || "") || Date.now() };
}

export async function fetchTraktWatchedSnapshot({ clientId, accessToken }) {
  const [movies, shows] = await Promise.all([
    fetchAllWatchedPages("movies", { clientId, accessToken }),
    // Since July 2026 Trakt's default/full watched-show response deliberately
    // omits season progress. Request it explicitly or every episode silently
    // disappears from the snapshot and can be mistaken for an unwatch.
    fetchAllWatchedPages("shows", { clientId, accessToken }, { extended: "progress" }),
  ]);
  const malformedShow = shows.find((show) => !Array.isArray(show?.seasons));
  if (malformedShow) {
    throw new Error("Trakt watched-show response did not include season progress");
  }
  const result = [];
  for (const movie of movies || []) result.push(normalizeMovie(movie));
  for (const show of shows || []) for (const season of show.seasons || []) for (const episode of season.episodes || []) {
    result.push(normalizeEpisode(show, { ...episode, season: episode.season ?? season.number }));
  }
  return result.filter((item) => !item.mediaKey.endsWith(":"));
}

// ---------------------------------------------------------------------------
// Personal ratings
// ---------------------------------------------------------------------------

async function fetchAllRatingPages(type, connection) {
  const limit = 100;
  const rows = [];
  // Authenticated Trakt requests must use the special `me` subject. A
  // username-scoped request can return an empty list even for the same account
  // that just accepted a sync write.
  const username = connection.accessToken
    ? "me"
    : String(connection.username || connection.remoteUsername || "me").trim() || "me";
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/users/${encodeURIComponent(username)}/ratings/${type}?extended=full&page=${page}&limit=${limit}`, {
      ...connection,
      includePagination: true,
    });
    const values = ratingSnapshotArray(result.data, "Trakt");
    rows.push(...values);
    if (result.pageCount > 0 ? page >= result.pageCount : values.length < (result.pageLimit || limit)) return rows;
  }
  throw new Error(`Trakt ${type} rating snapshot exceeded the pagination safety limit`);
}

function traktRatingDate(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTraktRatingMovie(entry) {
  const movie = entry.movie || entry;
  const ids = cleanIds(movie.ids);
  return {
    media: {
      media_type: "movie",
      title: movie.title || "Unknown movie",
      year: movie.year || null,
      tmdb_id: ids.tmdb || "",
      tvdb_id: ids.tvdb || "",
      imdb_id: ids.imdb || "",
      trakt_id: ids.trakt || "",
      poster_url: "",
    },
    providerItemId: ids.trakt || ids.imdb || ids.tmdb || ids.tvdb || "",
    providerIds: ids,
    rating: Number(entry.rating),
    ratedAt: traktRatingDate(entry.rated_at),
  };
}

function normalizeTraktRatingShow(entry) {
  const show = entry.show || entry;
  const ids = cleanIds(show.ids);
  return {
    media: {
      media_type: "tv",
      title: show.title || "Unknown show",
      year: show.year || null,
      tmdb_id: ids.tmdb || "",
      tvdb_id: ids.tvdb || "",
      imdb_id: ids.imdb || "",
      trakt_id: ids.trakt || "",
      poster_url: "",
    },
    providerItemId: ids.trakt || ids.imdb || ids.tmdb || ids.tvdb || "",
    providerIds: ids,
    rating: Number(entry.rating),
    ratedAt: traktRatingDate(entry.rated_at),
  };
}

function normalizeTraktRatingEpisode(entry) {
  const show = entry.show || {};
  const episode = entry.episode || entry;
  const showIds = cleanIds(show.ids);
  const episodeIds = cleanIds(episode.ids);
  return {
    media: {
      media_type: "episode",
      title: `${show.title || "Unknown show"} - S${String(episode.season).padStart(2, "0")}E${String(episode.number).padStart(2, "0")}${episode.title ? ` - ${episode.title}` : ""}`,
      show_title: show.title || "",
      tmdb_id: showIds.tmdb || "",
      tvdb_id: showIds.tvdb || "",
      imdb_id: showIds.imdb || "",
      trakt_id: showIds.trakt || "",
      show_tmdb_id: showIds.tmdb || "",
      show_tvdb_id: showIds.tvdb || "",
      show_imdb_id: showIds.imdb || "",
      show_trakt_id: showIds.trakt || "",
      episode_tmdb_id: episodeIds.tmdb || "",
      episode_tvdb_id: episodeIds.tvdb || "",
      episode_imdb_id: episodeIds.imdb || "",
      episode_trakt_id: episodeIds.trakt || "",
      season: Number(episode.season),
      episode: Number(episode.number),
      year: show.year || null,
      poster_url: "",
    },
    providerItemId: episodeIds.trakt || episodeIds.imdb || episodeIds.tmdb || episodeIds.tvdb || "",
    providerIds: { ...episodeIds, show: showIds },
    rating: Number(entry.rating),
    ratedAt: traktRatingDate(entry.rated_at),
  };
}

export async function fetchTraktPersonalRatingSnapshot(connection) {
  const [movies, shows, episodes] = await Promise.all([
    fetchAllRatingPages("movies", connection),
    fetchAllRatingPages("shows", connection),
    fetchAllRatingPages("episodes", connection),
  ]);
  const records = [];
  for (const entry of movies) if (Number.isInteger(Number(entry.rating)) && Number(entry.rating) >= 1 && Number(entry.rating) <= 10) records.push(normalizeTraktRatingMovie(entry));
  for (const entry of shows) if (Number.isInteger(Number(entry.rating)) && Number(entry.rating) >= 1 && Number(entry.rating) <= 10) records.push(normalizeTraktRatingShow(entry));
  for (const entry of episodes) if (Number.isInteger(Number(entry.rating)) && Number(entry.rating) >= 1 && Number(entry.rating) <= 10) records.push(normalizeTraktRatingEpisode(entry));
  return records;
}

function missingTraktPersonalRatingIdError() {
  return Object.assign(new Error("Trakt needs a provider id for this personal rating"), { code: "not_found", status: 404 });
}

function personalRatingIds(media, type) {
  return cleanIds(type === "episode"
    ? {
        trakt: media.episode_trakt_id || media.episodeProviderIds?.trakt || media.trackerEpisodeIds?.trakt || media.provider_item_ids?.trakt,
        imdb: media.episode_imdb_id || media.episodeProviderIds?.imdb || media.trackerEpisodeIds?.imdb,
        tmdb: media.episode_tmdb_id || media.episodeProviderIds?.tmdb || media.trackerEpisodeIds?.tmdb,
        tvdb: media.episode_tvdb_id || media.episodeProviderIds?.tvdb || media.trackerEpisodeIds?.tvdb,
      }
    : {
        trakt: media.trakt_id || media.traktId || media.ids?.trakt,
        imdb: media.imdb_id || media.imdbId || media.ids?.imdb,
        tmdb: media.tmdb_id || media.tmdbId || media.ids?.tmdb,
        tvdb: media.tvdb_id || media.tvdbId || media.ids?.tvdb,
      });
}

async function resolveTraktEpisodeIds(connection, media, { force = false } = {}) {
  const existingIds = personalRatingIds(media, "episode");
  if (!force && Object.keys(existingIds).length) return existingIds;

  const coordinates = trackerEpisodeCoordinates(media);
  if (coordinates.season === null || coordinates.episode === null) throw missingTraktPersonalRatingIdError();

  const showIds = cleanIds({
    trakt: media.show_trakt_id || media.showTraktId || media.trakt_id || media.traktId,
    imdb: media.show_imdb_id || media.showImdbId || media.imdb_id || media.imdbId,
    tmdb: media.show_tmdb_id || media.showTmdbId || media.tmdb_id || media.tmdbId,
    tvdb: media.show_tvdb_id || media.showTvdbId || media.tvdb_id || media.tvdbId,
  });
  let traktShowId = showIds.trakt || "";
  if (!traktShowId) {
    for (const [idType, id] of [["tmdb", showIds.tmdb], ["tvdb", showIds.tvdb], ["imdb", showIds.imdb]]) {
      if (!id) continue;
      try {
        const matches = await request(`${API_BASE}/search/${idType}/${encodeURIComponent(id)}?type=show&limit=1`, connection);
        traktShowId = matches?.[0]?.show?.ids?.trakt || "";
      } catch (error) {
        if (Number(error?.status) !== 404) throw error;
      }
      if (traktShowId) break;
    }
  }
  if (!traktShowId) throw missingTraktPersonalRatingIdError();

  const episode = await request(
    `${API_BASE}/shows/${encodeURIComponent(traktShowId)}/seasons/${coordinates.season}/episodes/${coordinates.episode}?extended=full`,
    connection,
  );
  const ids = cleanIds(episode?.ids || episode?.episode?.ids || {});
  if (!Object.keys(ids).length) throw missingTraktPersonalRatingIdError();
  return ids;
}

function applyTraktEpisodeIds(media, ids) {
  media.episode_provider_ids = { ...(media.episode_provider_ids || {}), ...ids };
  for (const provider of ["trakt", "imdb", "tmdb", "tvdb"]) {
    if (ids[provider] && !media[`episode_${provider}_id`]) media[`episode_${provider}_id`] = String(ids[provider]);
  }
  return media;
}

function traktRatingNotFound(result, type) {
  const notFound = result?.not_found;
  if (!notFound || typeof notFound !== "object") return false;
  const bucketName = type === "episode" ? "episodes" : type === "movie" ? "movies" : "shows";
  const bucket = notFound[bucketName];
  if (Array.isArray(bucket)) return bucket.length > 0;
  if (bucket != null) return Boolean(bucket);
  return Object.values(notFound).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function assertTraktRatingResult(result, type) {
  if (traktRatingNotFound(result, type)) {
    throw Object.assign(new Error(`Trakt could not match this ${type} personal rating`), { code: "not_found", status: 404, body: result });
  }
  return result;
}

async function submitTraktPersonalRating(path, connection, media, rating, lane) {
  const type = media.type || media.media_type || media.mediaType;
  let body = await traktRatingPayload(connection, media, rating);
  let result = await request(`${API_BASE}${path}`, {
    method: "POST",
    clientId: connection.clientId,
    accessToken: connection.accessToken,
    body,
    lane,
  });

  // Trakt can return HTTP 201 with a `not_found` bucket instead of using an
  // HTTP error. If an external episode id was not accepted, resolve the
  // episode through Trakt and retry once with its canonical leaf id.
  if (type === "episode" && traktRatingNotFound(result, type)) {
    const originalTraktId = body.episodes?.[0]?.ids?.trakt;
    const resolvedIds = await resolveTraktEpisodeIds(connection, media, { force: true });
    if (resolvedIds.trakt && String(resolvedIds.trakt) !== String(originalTraktId || "")) {
      applyTraktEpisodeIds(media, resolvedIds);
      body = await traktRatingPayload(connection, media, rating);
      result = await request(`${API_BASE}${path}`, {
        method: "POST",
        clientId: connection.clientId,
        accessToken: connection.accessToken,
        body,
        lane,
      });
    }
  }
  return assertTraktRatingResult(result, type);
}

async function traktRatingPayload(connection, media, rating = null) {
  const type = media.type || media.media_type || media.mediaType;
  if (!["movie", "tv", "show", "series", "episode"].includes(type)) throw new Error("Unsupported Trakt rating media type");
  let ids = personalRatingIds(media, type);
  if (type === "episode" && !Object.keys(ids).length) {
    ids = await resolveTraktEpisodeIds(connection, media);
    // Keep the resolved leaf identity with the queue item so later updates do
    // not need another Trakt lookup (and so source metadata can be hydrated).
    applyTraktEpisodeIds(media, ids);
  }
  if (!Object.keys(ids).length) throw missingTraktPersonalRatingIdError();
  const item = { ids };
  if (rating != null) item.rating = Math.max(1, Math.min(10, Math.round(Number(rating))));
  if (type === "movie") return { movies: [item] };
  if (type === "tv" || type === "show" || type === "series") return { shows: [item] };
  if (type === "episode") return { episodes: [item] };
  throw new Error("Unsupported Trakt rating media type");
}

export async function setTraktPersonalRating(connection, media, rating, { lane = "sync" } = {}) {
  return submitTraktPersonalRating("/sync/ratings", connection, media, rating, lane);
}

export async function clearTraktPersonalRating(connection, media, { lane = "sync" } = {}) {
  return submitTraktPersonalRating("/sync/ratings/remove", connection, media, null, lane);
}

async function fetchAllHistoryPages(type, connection, { startAt, endAt } = {}) {
  const limit = 250;
  const items = [];
  const startParam = startAt ? `&start_at=${encodeURIComponent(startAt)}` : "";
  const endParam = endAt ? `&end_at=${encodeURIComponent(endAt)}` : "";
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/sync/history/${type}?page=${page}&limit=${limit}${startParam}${endParam}`, {
      ...connection,
      includePagination: true,
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    items.push(...rows);
    if (result.pageCount > 0 ? page >= result.pageCount : rows.length < (result.pageLimit || limit)) return items;
  }
  throw new Error(`Trakt ${type} history exceeded the pagination safety limit`);
}

function normalizeHistoryMovie(entry) {
  const { mediaKey, media, watchedAt } = normalizeMovie(entry);
  return { historyId: String(entry.id), mediaKey, media, watchedAt };
}

function normalizeHistoryEpisode(entry) {
  // The episode entry's own timestamp fields are missing on /sync/history
  // responses - watched_at lives on the outer history entry instead.
  const episodeEntry = { ...(entry.episode || {}), watched_at: entry.watched_at };
  const { mediaKey, media, watchedAt } = normalizeEpisode({ show: entry.show }, episodeEntry);
  return { historyId: String(entry.id), mediaKey, media, watchedAt };
}

// Unlike fetchTraktWatchedSnapshot (which returns Trakt's collapsed
// last-watched-per-item view), this reads Trakt's actual play-by-play
// history, so a rewatch shows up as its own entry with its own timestamp
// and history id instead of being folded into a single "last watched" row.
export async function fetchTraktPlayHistory({ clientId, accessToken }, { startAt } = {}) {
  const [movies, episodes] = await Promise.all([
    fetchAllHistoryPages("movies", { clientId, accessToken }, { startAt }),
    fetchAllHistoryPages("episodes", { clientId, accessToken }, { startAt }),
  ]);
  const result = [];
  for (const entry of movies || []) result.push(normalizeHistoryMovie(entry));
  for (const entry of episodes || []) result.push(normalizeHistoryEpisode(entry));
  return result.filter((item) => !item.mediaKey.endsWith(":"));
}

// A complete show-scoped snapshot is required before moving any history ids.
export async function fetchTraktShowPlayHistory(connection, traktId) {
  const entries = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await request(`${API_BASE}/users/me/history/shows/${encodeURIComponent(traktId)}?page=${page}&limit=250`, { ...connection, includePagination: true });
    if (!Array.isArray(result.data)) throw new Error("Trakt returned an invalid show history snapshot; nothing was removed.");
    entries.push(...result.data.map(normalizeHistoryEpisode));
    if (result.pageCount > 0 ? page >= result.pageCount : result.data.length < (result.pageLimit || 250)) return entries;
  }
  throw new Error("Trakt show history exceeded the pagination safety limit");
}

export async function removeTraktHistoryIds(connection, ids) {
  if (!ids.length || ids.some((id) => !/^\d+$/.test(String(id)))) throw new Error("Valid Trakt history ids are required");
  // Removal by history id is idempotent, so it needs no write intent.
  return request(`${API_BASE}/sync/history/remove`, { ...connection, method: "POST", body: { ids: ids.map(String) }, lane: "sync" });
}

// Plays of one media type whose watched_at falls inside [startAt, endAt]. The
// background retry reads this before re-adding a play, so a write Trakt
// accepted but whose response was lost (timeout, 5xx) is not added twice.
export async function fetchTraktHistoryWindow({ clientId, accessToken }, type, { startAt, endAt }) {
  const kind = type === "episode" ? "episodes" : "movies";
  const entries = await fetchAllHistoryPages(kind, { clientId, accessToken }, { startAt, endAt });
  return entries.map(kind === "episodes" ? normalizeHistoryEpisode : normalizeHistoryMovie);
}

function parsedTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  return text ? Date.parse(text) : NaN;
}

function watchedAtForPayload(media = {}) {
  const raw = media.watched_at ?? media.watchedAt;
  const parsed = parsedTimestamp(raw);
  const isRestore = String(media.source || "").toLowerCase().startsWith("restore");
  if (isRestore && !Number.isFinite(parsed)) {
    throw Object.assign(new Error("Authoritative restore requires a valid watched_at timestamp for every Trakt play"), { code: "invalid_restore_timestamp" });
  }
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function syncPayload(media, state) {
  const ids = cleanIds(media.ids);
  if (!Object.keys(ids).length) throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item"), { code: "not_found" });
  const watchedAt = state === "watched" ? watchedAtForPayload(media) : undefined;
  if (media.type === "episode" || media.mediaType === "episode") {
    const episode = { number: Number(media.episode) };
    if (watchedAt) episode.watched_at = watchedAt;
    return { shows: [{ ids, seasons: [{ number: Number(media.season), episodes: [episode] }] }] };
  }
  // A show-level watch (Netflix date with no episode numbers) expands on Trakt
  // to every episode of the series for that watched_at stamp.
  if (isShowWatchType(media.type || media.mediaType)) {
    const item = { ids };
    if (watchedAt) item.watched_at = watchedAt;
    return { shows: [item] };
  }
  const item = { ids };
  if (watchedAt) item.watched_at = watchedAt;
  return { movies: [item] };
}

function syncHistoryPayload(items = [], state = "watched") {
  const movies = [];
  const shows = new Map();
  const wholeShows = [];
  for (const media of items) {
    const ids = cleanIds(media?.ids);
    if (!Object.keys(ids).length) {
      throw Object.assign(new Error("Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for every restored play"), { code: "not_found" });
    }
    const watchedAt = state === "watched" ? watchedAtForPayload(media) : undefined;
    if (media.type === "episode" || media.mediaType === "episode") {
      const season = Number(media.season);
      const number = Number(media.episode);
      if (!Number.isInteger(season) || !Number.isInteger(number)) {
        throw Object.assign(new Error("Trakt requires valid season and episode numbers for every restored episode"), { code: "not_found" });
      }
      const showKey = JSON.stringify(Object.entries(ids).sort(([left], [right]) => left.localeCompare(right)));
      let show = shows.get(showKey);
      if (!show) {
        show = { ids, seasons: new Map() };
        shows.set(showKey, show);
      }
      let seasonEntry = show.seasons.get(season);
      if (!seasonEntry) {
        seasonEntry = { number: season, episodes: [] };
        show.seasons.set(season, seasonEntry);
      }
      const episode = { number };
      if (watchedAt) episode.watched_at = watchedAt;
      seasonEntry.episodes.push(episode);
    } else if (isShowWatchType(media.type || media.mediaType)) {
      const show = { ids };
      if (watchedAt) show.watched_at = watchedAt;
      wholeShows.push(show);
    } else {
      const movie = { ids };
      if (watchedAt) movie.watched_at = watchedAt;
      movies.push(movie);
    }
  }
  const payload = {};
  if (movies.length) payload.movies = movies;
  const showList = [
    ...wholeShows,
    ...[...shows.values()].map((show) => ({
      ids: show.ids,
      seasons: [...show.seasons.values()],
    })),
  ];
  if (showList.length) payload.shows = showList;
  return payload;
}

async function managedHistoryRequest(connection, items, action, send) {
  if (!connection.id) return send(items);
  const { trackerIntentRequest } = await import("../trackerIntentRequest.js");
  return trackerIntentRequest(connection, items, action, send, fetchTraktHistoryWindow);
}

export async function setTraktWatchState(connection, media, state, { lane = "sync" } = {}) {
  const { clientId, accessToken } = connection;
  const path = state === "unwatched" ? "/sync/history/remove" : "/sync/history";
  return managedHistoryRequest(connection, [media], state, ([item]) => request(`${API_BASE}${path}`, { method: "POST", clientId, accessToken, body: syncPayload(item, state), lane }));
}

// Trakt accepts multiple dated plays in one request. Restore uses this instead
// of one request per play so a large history cannot time out halfway through,
// and every event retains its source timestamp in the payload.
export function setTraktWatchHistoryBatch(connection, items, state, { lane = "sync" } = {}) {
  const { clientId, accessToken } = connection;
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return Promise.resolve({});
  // Validate synchronously so a restore fails closed before any intent exists.
  syncHistoryPayload(values, state);
  const path = state === "unwatched" ? "/sync/history/remove" : "/sync/history";
  return managedHistoryRequest(connection, values, state, (pending) => request(`${API_BASE}${path}`, {
    method: "POST",
    clientId,
    accessToken,
    body: syncHistoryPayload(pending, state),
    lane,
  }));
}

export function trackerMediaKey(media) {
  return normalizedMediaKey(media.type || media.mediaType, cleanIds(media.ids), media.season, media.episode);
}
