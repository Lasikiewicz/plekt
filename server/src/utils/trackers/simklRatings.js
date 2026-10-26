import { db } from "../../db.js";
import { simklRequest } from "./simklClient.js";
import { assertTrackerGeneration, runInTrackerGeneration } from "./generation.js";

// Simkl rating sync (plan.md compatibility decision 2). Rating a title Simkl
// does not already hold can add it to watched history or a list, so a write or
// clear is sent only when Simkl already has the movie completed with a real
// watch date, or the show in one of its lists. Anything else is held with an
// explanation; a status or date that moves after the write is flagged.

const SHOW_LISTS = ["watching", "plantowatch", "hold", "completed", "dropped"];

function observedDate(value) {
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  // Simkl's unknown-date sentinel is 1970-01-01T00:00:01Z.
  return Number.isFinite(date) && date > 1000 ? date : null;
}

function ratingIds(media = {}) {
  const ids = {};
  const simkl = media.provider_item_ids?.simkl || media.simkl_id;
  if (/^\d+$/.test(String(simkl || "")) && Number(simkl) > 0) ids.simkl = Number(simkl);
  if (/^\d+$/.test(String(media.tmdb_id || "")) && Number(media.tmdb_id) > 0) ids.tmdb = Number(media.tmdb_id);
  if (media.media_type === "tv" && /^\d+$/.test(String(media.tvdb_id || "")) && Number(media.tvdb_id) > 0) ids.tvdb = Number(media.tvdb_id);
  if (/^tt\d+$/.test(String(media.imdb_id || ""))) ids.imdb = String(media.imdb_id);
  return ids;
}

// Ratings Simkl watched checks stored for this connection. The rating timer
// reads these and never contacts Simkl itself. A title whose rating Simkl
// explicitly cleared is stored unrated and is left out, which rating sync
// then treats as a clear.
export function storedSimklRatingSnapshot(connection) {
  const row = db.prepare("SELECT baseline_complete FROM tracker_connections WHERE provider='simkl' AND id=? AND remote_user_id=? AND status='connected'")
    .get(connection?.id, connection?.remoteUserId);
  if (!row) throw Object.assign(new Error("Simkl is not connected for personal rating sync"), { code: "not_configured" });
  if (!row.baseline_complete) throw new Error("Simkl has not finished its first library check; run Sync now for Simkl first");
  return db.prepare("SELECT observation_json FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND account_id=? AND kind='rating' AND status='observed' ORDER BY created_at,id")
    .all(connection.id, connection.remoteUserId)
    .map((entry) => JSON.parse(entry.observation_json))
    .filter((item) => Number.isInteger(item.rating))
    .map(({ media, providerItemId, providerIds, rating, ratedAt }) => ({ media, providerItemId, providerIds, rating, ratedAt }));
}

function storedAsAnime(connection, ids) {
  return db.prepare(`SELECT observation_json FROM tracker_observations WHERE provider='simkl' AND connection_id=?
    AND COALESCE(json_extract(observation_json,'$.media.simklType'), json_extract(observation_json,'$.media.simkl_type'))='anime'`)
    .all(connection.id).some(row => {
      const media = JSON.parse(row.observation_json).media;
      return Object.entries(ids).some(([key, value]) => String(media.ids?.[key] || media[`${key}_id`] || "") === String(value));
    });
}

// The documented read-only lookup: one item in, its list status and last
// watch date out.
async function lookupSimklTitle(connection, ids, lane) {
  const data = await simklRequest(connection, "/sync/watched", { body: [{ ids }], lane, arrayResponse: true });
  const item = data[0];
  if (!item || typeof item !== "object" || item.result === "not_found") return null;
  return {
    list: typeof item.list === "string" ? item.list : null,
    lastWatchedAt: typeof item.last_watched_at === "string" ? item.last_watched_at : null,
    anime: item.type === "anime" || item.anime_type != null,
  };
}

export function simklRatingHoldReason(mediaType, title, { anime = false } = {}) {
  if (anime || title.anime) return "Held: Simkl anime ratings can change list and episode state, which has not been verified.";
  if (mediaType === "movie") {
    return title.list === "completed" && observedDate(title.lastWatchedAt) ? ""
      : "Held: rating this movie on Simkl would add it to your Simkl watched history. Mark it watched on Simkl, then retry.";
  }
  if (mediaType === "tv") {
    return SHOW_LISTS.includes(title.list) ? ""
      : "Held: rating this show on Simkl would add it to one of your Simkl lists. Add it to a list on Simkl, then retry.";
  }
  return "Held: Simkl does not support episode ratings.";
}

async function writeSimklRating(connection, media, rating, { lane = "sync" } = {}) {
  const ids = ratingIds(media);
  if (!Object.keys(ids).length) return { status: "not_found" };
  return runInTrackerGeneration("simkl", connection.id, async () => {
    const before = await lookupSimklTitle(connection, ids, lane);
    if (!before) return { status: "not_found" };
    const hold = simklRatingHoldReason(media.media_type, before, { anime: media.simkl_type === "anime" || storedAsAnime(connection, ids) });
    if (hold) return { status: "held", reason: hold };
    assertTrackerGeneration("simkl");
    const key = media.media_type === "movie" ? "movies" : "shows";
    const entry = rating == null ? { ids } : { ids, rating };
    const result = await simklRequest(connection, rating == null ? "/sync/ratings/remove" : "/sync/ratings", { body: { [key]: [entry] }, lane });
    const notFound = result.not_found && typeof result.not_found === "object" ? Object.values(result.not_found) : [];
    if (notFound.some((list) => Array.isArray(list) && list.length)) return { status: "not_found" };
    let after;
    try { after = await lookupSimklTitle(connection, ids, lane); }
    catch { return { status: "succeeded", reviewReason: "The Simkl rating was sent but its readback failed; check this title's status on Simkl." }; }
    if (!after || after.list !== before.list || observedDate(after.lastWatchedAt) !== observedDate(before.lastWatchedAt)) {
      return { status: "succeeded", reviewReason: `Simkl changed this title's list or watch date after the rating write (${before.list || "none"} to ${after?.list || "none"}); check it on Simkl.` };
    }
    return { status: "succeeded" };
  });
}

export function setSimklPersonalRating(connection, media, rating, options) {
  return writeSimklRating(connection, media, rating, options);
}

export function clearSimklPersonalRating(connection, media, options) {
  return writeSimklRating(connection, media, null, options);
}
