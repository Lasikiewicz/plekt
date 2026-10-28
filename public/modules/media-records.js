import { slug } from "./utils.js?v=2.2.1.0.0";

export function mediaRecordIdentity(record = {}, mode = "") {
  if (mode === "shows" || record.media_type === "episode") {
    const title = record.show_title || record.title || "";
    const tmdbId = record.show_tmdb_id || (mode === "shows" ? record.tmdb_id : "");
    const tvdbId = record.show_tvdb_id || (mode === "shows" ? record.tvdb_id : "");
    const imdbId = record.show_imdb_id || (mode === "shows" ? record.imdb_id : "");
    if (tmdbId) return `show:tmdb:${String(tmdbId).toLowerCase()}`;
    if (tvdbId) return `show:tvdb:${String(tvdbId).toLowerCase()}`;
    if (imdbId) return `show:imdb:${String(imdbId).toLowerCase()}`;
    return `show:${slug(title)}`;
  }
  // Artwork is presentation data, not a media identifier: different titles
  // can legitimately share a poster URL, especially when a provider uses a
  // generic or bundled image. Prefer stable provider IDs before title fallback.
  if (record.imdb_id) return `movie:imdb:${String(record.imdb_id).toLowerCase()}`;
  if (record.tmdb_id) return `movie:tmdb:${String(record.tmdb_id).toLowerCase()}`;
  if (record.tvdb_id) return `movie:tvdb:${String(record.tvdb_id).toLowerCase()}`;
  const title = slug(record.title);
  return title ? `movie:title:${title}` : `movie:id:${String(record.id || "unknown")}`;
}

export function dedupeMediaRecords(records = [], mode = "") {
  const map = new Map();
  for (const record of records) {
    const key = mediaRecordIdentity(record, mode);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, record);
      continue;
    }
    const existingDate = existing.latest_watched_at || existing.watched_at || "";
    const recordDate = record.latest_watched_at || record.watched_at || "";
    if (recordDate > existingDate) map.set(key, record);
  }
  return [...map.values()];
}
