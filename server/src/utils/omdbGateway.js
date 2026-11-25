import { db, parseJson, toCompressedJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Non-OK HTTP responses (bad key, exhausted daily quota) are negative-cached
// briefly so a dead key degrades to silence instead of one request per
// detail-page view - OMDb's free tier is only 1,000 requests/day.
const ERROR_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const getStmt = db.prepare("SELECT data, updated_at_ms FROM omdb_cache WHERE id = ?");
const setStmt = db.prepare(
  `INSERT INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at_ms = excluded.updated_at_ms`,
);

export async function getOmdbRating(imdbId, apiKey) {
  if (!imdbId || !apiKey) return null;

  const cached = getStmt.get(imdbId);
  if (cached) {
    const data = parseJson(cached.data);
    const ttl = data?.httpError ? ERROR_TTL_MS : TTL_MS;
    if (Date.now() - cached.updated_at_ms < ttl) {
      return data?.httpError || data?.error ? null : data;
    }
  }

  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    setStmt.run(imdbId, toCompressedJson({ httpError: res.status }), Date.now());
    throw new Error(`OMDb API error: ${res.status}`);
  }
  const data = await res.json();

  if (data.Response === "False") {
    setStmt.run(imdbId, toCompressedJson({ error: data.Error }), Date.now());
    return null;
  }

  const result = {
    imdbRating: data.imdbRating !== "N/A" ? data.imdbRating : null,
    imdbVotes: data.imdbVotes !== "N/A" ? data.imdbVotes : null,
  };
  setStmt.run(imdbId, toCompressedJson(result), Date.now());
  return result;
}
