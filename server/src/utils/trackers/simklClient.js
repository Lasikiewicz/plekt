import { simklTransport } from "./simklTransport.js";
import packageJson from "../../../../package.json" with { type: "json" };

const TYPES = ["movies", "shows", "anime"];
const STATUSES = { movies: ["plantowatch", "completed", "dropped"], shows: ["watching", "plantowatch", "hold", "completed", "dropped"], anime: ["watching", "plantowatch", "hold", "completed", "dropped"] };
const invalid = () => Object.assign(new Error("Simkl returned an incomplete or invalid snapshot"), { code: "SIMKL_INCOMPLETE_SNAPSHOT" });
export const simklReviewRequired = (reason) => Object.assign(new Error(reason), { code: "TRACKER_REVIEW_REQUIRED", provider: "simkl" });

export function assertSimklTrigger(trigger) {
  if (!["event", "user"].includes(trigger)) throw Object.assign(new Error("Simkl requires a user or media-server event trigger"), { code: "TRACKER_UNSUPPORTED_OPERATION" });
}

// Errors retain only status, allowlisted codes and backoff, never provider bodies.
export async function simklRequest(connection, path, { body, query = {}, lane = "sync", arrayResponse = false, withMetadata = false, minimumRemaining = 0, allowUnknownQuota = false, reserveCheckpoint = false } = {}) {
  if (!connection?.clientId || !connection.accessToken) throw new Error("Simkl authentication is required");
  const url = new URL(`https://api.simkl.com${path}`);
  url.search = new URLSearchParams({ ...query, client_id: connection.clientId, "app-name": "plekt", "app-version": packageJson.version });
  const { response, data, metadata, rateCode } = await simklTransport(connection, url.href, {
    method: body ? "POST" : "GET", lane, minimumRemaining, allowUnknownQuota, reserveCheckpoint,
    headers: { "content-type": "application/json", "user-agent": `Plekt/${packageJson.version} (https://github.com/Lasikiewicz/plekt)`, "simkl-api-key": connection.clientId, authorization: `Bearer ${connection.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  }, 30_000);
  if (!response.ok || rateCode) {
    throw Object.assign(new Error(`Simkl request failed (HTTP ${response.status})`), {
      status: response.status, code: rateCode || (data?.error === "max_items" ? "SIMKL_MAX_ITEMS" : "SIMKL_REQUEST_FAILED"),
      ...metadata,
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data) !== arrayResponse || data.error) throw invalid();
  return withMetadata ? { data, metadata } : data;
}

function idsOf(ids = {}) {
  return Object.fromEntries(["tmdb", "tvdb", "imdb", "simkl", "mal"].flatMap((key) => {
    const value = ids[key];
    if (key === "imdb") return typeof value === "string" && /^tt\d+$/.test(value) ? [[key, value]] : [];
    return /^\d+$/.test(String(value)) && Number(value) > 0 ? [[key, String(value)]] : [];
  }));
}

function simklWatchType(media = {}) {
  const type = media.type || media.mediaType;
  if (type === "tv" || type === "series") return "show";
  return type;
}

export function simklIdentityKeys(media = {}) {
  const type = simklWatchType(media);
  if (!["movie", "episode", "show"].includes(type)) return [];
  if (type === "episode" && (!Number.isInteger(media.season) || media.season < 0 || !Number.isInteger(media.episode) || media.episode < 1)) return [];
  return Object.entries(idsOf(media.ids)).map(([key, value]) => `${type}:${key}:${value}${type === "episode" ? `:s${media.season}e${media.episode}` : ""}`);
}
export const simklMediaKey = (media) => simklIdentityKeys(media)[0] || "";
export function simklMediaMatches(left, right) {
  const keys = new Set(simklIdentityKeys(right));
  const matches = simklIdentityKeys(left).some((key) => keys.has(key));
  if (matches) {
    const leftIds = idsOf(left.ids), rightIds = idsOf(right.ids);
    if (Object.keys(leftIds).some((key) => rightIds[key] && rightIds[key] !== leftIds[key])) throw simklReviewRequired("Simkl media identifiers conflict and need review");
  }
  return matches;
}

function observedDate(value) {
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  // Simkl's unknown-date sentinel is 1970-01-01T00:00:01Z.
  return Number.isFinite(date) && date > 1000 ? date : null;
}

function observation(media, date) {
  const watchedAt = observedDate(date);
  return { mediaKey: simklMediaKey(media), media, watchedAt, timestampProvenance: watchedAt === null ? "unknown" : "observed" };
}

function titleMedia(type, entry) {
  // Anime rows carry their title under `show`; accept `anime` as well.
  const title = type === "movies" ? entry.movie : type === "anime" ? entry.anime || entry.show : entry.show;
  if (!title || !title.ids || typeof title.title !== "string") throw invalid();
  const ids = idsOf(title.ids);
  if (!Object.keys(ids).length) throw invalid();
  return { isValid: true, source: "simkl", type: type === "movies" ? "movie" : "show", mediaType: type === "movies" ? "movie" : "show", title: title.title, year: title.year || null, ids, simklType: type };
}

export function normalizeSimklRows(partitions, { ratingsOnly = false } = {}) {
  const watched = [], ratings = [], unrated = [], review = [];
  for (const type of TYPES) {
    if (!Array.isArray(partitions[type])) throw invalid();
    const seen = new Set();
    for (const entry of partitions[type]) {
      const media = titleMedia(type, entry);
      const key = simklMediaKey(media);
      if (seen.has(key)) throw invalid();
      seen.add(key);
      if ((!ratingsOnly || entry.status != null) && !STATUSES[type].includes(entry.status)) throw invalid();
      const ratingMedia = { media_type: type === "movies" ? "movie" : "tv", title: media.title, year: media.year, simkl_type: type,
        tmdb_id: media.ids.tmdb || "", tvdb_id: media.ids.tvdb || "", imdb_id: media.ids.imdb || "", simkl_id: media.ids.simkl || "", poster_url: "" };
      const providerItemId = media.ids.simkl || Object.values(media.ids)[0];
      if (entry.user_rating != null) {
        if (!Number.isInteger(entry.user_rating) || entry.user_rating < 1 || entry.user_rating > 10) throw invalid();
        ratings.push({ media: ratingMedia, providerItemId, providerIds: media.ids, rating: entry.user_rating, ratedAt: observedDate(entry.user_rated_at) });
      } else if (Object.hasOwn(entry, "user_rating")) {
        // An explicit null rating on a returned row. A missing field or a
        // missing row says nothing and is never a clear.
        unrated.push({ media: ratingMedia, providerItemId, providerIds: media.ids });
      }
      if (ratingsOnly) continue;
      if (type === "movies") {
        // A rating can manufacture movie history. Keep this observation held;
        // a timestamp alone cannot prove it was a real play.
        if (entry.status === "completed") {
          if (entry.user_rating != null) review.push({ media, reason: "rating_watch_ambiguity" });
          else watched.push(observation(media, entry.last_watched_at));
        }
        continue;
      }
      if (!Number.isSafeInteger(entry.watched_episodes_count) || entry.watched_episodes_count < 0) throw invalid();
      if (entry.seasons != null && !Array.isArray(entry.seasons)) throw invalid();
      const episodes = new Set();
      let count = 0;
      for (const season of entry.seasons || []) {
        if (!Number.isInteger(season.number) || season.number < 0 || !Array.isArray(season.episodes)) throw invalid();
        for (const episode of season.episodes) {
          if (!Number.isInteger(episode.number) || episode.number < 1) throw invalid();
          const coordinate = `${season.number}:${episode.number}`;
          if (episodes.has(coordinate)) throw invalid();
          episodes.add(coordinate);
          // Simkl's watched_episodes_count excludes specials even when
          // include_all_episodes=original returns their recorded rows.
          if (season.number > 0) count += 1;
          // Native anime/special numbering is not canonical media-server proof.
          if (type === "anime" || season.number === 0) {
            review.push({ media, reason: "episode_mapping_required", season: season.number, episode: episode.number });
            continue;
          }
          const item = { ...media, type: "episode", mediaType: "episode", showTitle: media.title, season: season.number, episode: episode.number, episodeIds: idsOf(episode.ids) };
          watched.push(observation(item, episode.watched_at));
        }
      }
      if (count > entry.watched_episodes_count) throw invalid();
      if (count < entry.watched_episodes_count) review.push({ media, reason: "incomplete_episode_coverage" });
    }
  }
  return { watched, ratings, unrated, review };
}

async function partition(connection, type, status, query) {
  const data = await simklRequest(connection, `/sync/all-items/${type}${status ? `/${status}` : ""}`, { query });
  // Filtered empty results are documented as {}, including date_from deltas.
  // Missing keys in any nonempty response remain an invalid partition.
  if (Object.keys(data).length === 0) return [];
  if (!Array.isArray(data[type]) || data[type].length >= 20_000) throw invalid();
  return data[type];
}

// Caller owns persisted cursor/state. Deltas are observations, never complete
// snapshots. No omission here authorizes an automatic unwatch or rating clear.
export async function fetchSimklSnapshot(connection, { trigger, dateFrom } = {}) {
  assertSimklTrigger(trigger);
  const activities = await simklRequest(connection, "/sync/activities");
  if (!observedDate(activities.all)) throw invalid();
  if (dateFrom != null && !observedDate(dateFrom)) throw invalid();
  if (dateFrom === activities.all) return { watched: [], ratings: [], unrated: [], review: [], activities, cursor: activities.all, complete: false, absenceReconciliation: false };
  const query = { extended: "full", include_all_episodes: "original", episode_watched_at: "yes", ...(dateFrom ? { date_from: dateFrom } : {}) };
  let normalized;
  if (dateFrom) {
    try {
      const data = await simklRequest(connection, "/sync/all-items", { query });
      if (Object.keys(data).some(key => !TYPES.includes(key))) throw invalid();
      const delta = {};
      for (const type of TYPES) {
        const rows = Object.hasOwn(data, type) ? data[type] : [];
        if (!Array.isArray(rows) || rows.length >= 20_000) throw invalid();
        delta[type] = rows;
      }
      normalized = normalizeSimklRows(delta);
    } catch (error) {
      // Only the explicit size limit permits splitting; malformed deltas fail closed.
      if (error.code !== "SIMKL_MAX_ITEMS") throw error;
    }
  }
  if (!normalized) {
    const partitions = {};
    for (const type of TYPES) {
      try { partitions[type] = await partition(connection, type, "", query); }
      catch (error) {
        if (error.code !== "SIMKL_MAX_ITEMS") throw error;
        const rows = [];
        for (const status of STATUSES[type]) rows.push(...await partition(connection, type, status, query));
        partitions[type] = rows;
      }
    }
    normalized = normalizeSimklRows(partitions);
  }
  // Rating-only changes need not appear in the watched-library delta (verified
  // live). Read the rating delta only when its activity moved; never infer a
  // clear from an absent row or treat this feed as watched-episode evidence.
  if (dateFrom && [activities.movies, activities.tv_shows, activities.anime].some(bucket => observedDate(bucket?.rated_at) > observedDate(dateFrom))) {
    const data = await simklRequest(connection, '/sync/ratings', { query: { date_from: dateFrom } });
    if (Object.keys(data).some(key => !TYPES.includes(key))) throw invalid();
    const partitions = Object.fromEntries(TYPES.map(type => {
      const rows = Object.hasOwn(data, type) ? data[type] : [];
      if (!Array.isArray(rows) || rows.length >= 20_000) throw invalid();
      return [type, rows];
    }));
    const ratings = normalizeSimklRows(partitions, { ratingsOnly: true });
    const key = item => `${item.media.simkl_type}:${item.providerItemId}`;
    const changed = new Set([...ratings.ratings, ...ratings.unrated].map(key));
    normalized.ratings = normalized.ratings.filter(item => !changed.has(key(item))).concat(ratings.ratings);
    normalized.unrated = normalized.unrated.filter(item => !changed.has(key(item))).concat(ratings.unrated);
  }
  return { ...normalized, activities, cursor: activities.all, complete: !dateFrom, absenceReconciliation: false };
}

// Dropped-title reconciliation uses status-only all-items reads. It never
// calls history, watched, or unwatched endpoints. The envelope is accepted
// only when every status partition is a valid bounded array.
export async function fetchSimklDroppedTitleSnapshot(connection, { trigger, priorActivities = null } = {}) {
  assertSimklTrigger(trigger);
  const activities = await simklRequest(connection, "/sync/activities");
  if (!observedDate(activities.all)) throw invalid();
  if (priorActivities?.all === activities.all) {
    return { activities, dropped: null, previousStatuses: null, complete: true, changed: false };
  }
  const rows = [];
  const previousStatuses = [];
  for (const type of ["movies", "shows", "anime"]) {
    for (const status of STATUSES[type]) {
      const data = await simklRequest(connection, `/sync/all-items/${type}/${status}`, { query: { extended: "full" } });
      // Simkl documents exactly {} as an empty filtered partition. Any other
      // missing or unexpected key is malformed and cannot authorize omissions.
      if (Object.keys(data).length === 0) continue;
      if (Object.keys(data).length !== 1 || !Array.isArray(data[type]) || data[type].length >= 20_000) throw invalid();
      const seen = new Set();
      for (const entry of data[type]) {
        if (!entry || entry.status !== status) throw invalid();
        const media = titleMedia(type, entry);
        const key = simklMediaKey(media);
        if (seen.has(key)) throw invalid();
        seen.add(key);
        const changedAt = entry.last_listed_at == null ? null : observedDate(entry.last_listed_at);
        if (entry.last_listed_at != null && !changedAt) throw invalid();
        previousStatuses.push({ media, status, changedAt });
        if (status === "dropped") rows.push({ media, status, changedAt });
      }
    }
  }
  return { activities, dropped: rows, previousStatuses, complete: true, changed: true };
}

export async function setSimklDroppedTitleStatus(connection, media, status, { trigger } = {}) {
  assertSimklTrigger(trigger);
  if (!["dropped", "watching", "plantowatch", "hold"].includes(status)) {
    throw simklReviewRequired("Simkl restore status could affect watch history and needs review");
  }
  if (media.type === "movie" && ["watching", "hold"].includes(status)) {
    throw simklReviewRequired("Simkl movie status cannot be restored to watching or hold safely");
  }
  const type = media.type === "movie" ? "movies" : media.type === "show" ? (media.simklType === "anime" ? "anime" : "shows") : "";
  if (!type || !media.ids || !Object.keys(idsOf(media.ids)).length) throw simklReviewRequired("Simkl dropped-title write needs a verified show or movie identity");
  const result = await simklRequest(connection, "/sync/add-to-list", { body: { [type]: [{ ids: idsOf(media.ids), to: status }] } });
  if (!result.added || !result.not_found || !Array.isArray(result.not_found[type]) || !Array.isArray(result.added[type])) throw invalid();
  if (result.not_found[type].length) throw Object.assign(new Error("Simkl did not match the dropped title"), { code: "not_found", status: 404 });
  const requested = idsOf(media.ids);
  const matches = result.added[type].filter((entry) => {
    const itemType = type === "movies" ? "movie" : type === "anime" ? "anime" : "show";
    const returned = idsOf(entry?.[itemType]?.ids || entry?.[type]?.ids || entry?.ids || {});
    const overlaps = Object.entries(requested).filter(([key]) => returned[key]);
    return overlaps.length > 0 && overlaps.every(([key, value]) => String(returned[key]) === String(value)) && entry?.to === status;
  });
  if (matches.length !== 1) throw simklReviewRequired("Simkl did not confirm the requested title and list status");
  return result;
}

export function simklHistoryPayload(media) {
  const type = simklWatchType(media);
  const ids = idsOf(media.ids);
  if (!["movie", "episode", "show"].includes(type) || !Object.keys(ids).length) throw simklReviewRequired("Simkl needs a verified media identity");
  if (media.simklType === "anime" || !ids.tmdb && !ids.tvdb && !ids.imdb) throw simklReviewRequired("Simkl native/anime identity needs canonical mapping and readback validation");
  if (!observedDate(media.watched_at)) throw simklReviewRequired("Simkl needs an observed watch date");
  if (type === "movie") return { movies: [{ ids, watched_at: media.watched_at }] };
  // A show-level watch expands on Simkl to aired episodes for that date.
  if (type === "show") return { shows: [{ ids, watched_at: media.watched_at }] };
  if (!Number.isInteger(media.season) || media.season < 1 || !Number.isInteger(media.episode) || media.episode < 1) throw simklReviewRequired("Simkl episode numbering needs review");
  return { shows: [{ ids, seasons: [{ number: media.season, episodes: [{ number: media.episode, watched_at: media.watched_at }] }] }] };
}

// No automatic transport retry: a lost write response must be read back or held.
export async function sendSimklWatched(connection, media, { trigger } = {}) {
  assertSimklTrigger(trigger);
  const body = simklHistoryPayload(media);
  const result = await simklRequest(connection, "/sync/history", { body, query: { skip_auto_watching: "yes" } });
  if (!result.added || !result.not_found || Object.values(result.not_found).some((list) => !Array.isArray(list))) throw simklReviewRequired("Simkl write response cannot establish the outcome");
  if (Object.values(result.not_found).some((list) => list.length)) throw Object.assign(new Error("Simkl did not match the requested item"), {
    code: "not_found", status: 404, uncertainOutcome: Object.values(result.added).some((count) => Number(count) > 0),
  });
  // Even zero-add results can be already-satisfied. HTTP success is not proof.
  try {
    const snapshot = await fetchSimklSnapshot(connection, { trigger });
    const matched = snapshot.watched.some((entry) => simklMediaMatches(entry.media, media));
    // Whole-show writes expand to aired episodes; confirm by matching show ids
    // against any returned episode of that series.
    const showConfirmed = !matched && simklWatchType(media) === "show" && snapshot.watched.some((entry) => {
      const entryType = entry.media?.type || entry.media?.mediaType;
      if (entryType !== "episode") return false;
      return simklMediaMatches({ type: "show", mediaType: "show", ids: entry.media.ids }, { type: "show", mediaType: "show", ids: media.ids });
    });
    if (!matched && !showConfirmed) throw simklReviewRequired("Simkl watched state was not confirmed by readback");
  } catch (error) {
    // A status on readback says nothing about whether the preceding POST landed.
    // In particular, a readback 401/429 must never authorize another POST.
    error.uncertainOutcome = true;
    throw error;
  }
  return result;
}
