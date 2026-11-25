import { db, parseJson } from "../db.js";
import { getTmdbDetails } from "./tmdbGateway.js";
import { runWithConcurrency } from "./concurrency.js";

// Original languages for the Language choice of automatic playlists
// (plan/archive/custom-playlist-sync decisions 60 to 62). The language comes
// from the TMDB details Plembfin imports when media is added, read from the
// metadata cache's original_language column. Only a title with no cached
// details at all is looked up, through the gateway (which caches it). A title
// TMDB cannot match, or whose details list no language, reads as "" and is
// left out of a playlist that has languages ticked; any other failed lookup
// throws, so the check fails and leaves the items as they are.

const LOOKUP_CONCURRENCY = 4;
const SQL_CHUNK = 400;

function text(value = "") {
  return String(value ?? "").trim();
}

// ISO 639-1 as TMDB writes it (two lower-case letters, e.g. "en", "ko").
export function normalizeLanguageCode(value) {
  const code = text(value).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : "";
}

function cacheIds(mediaType, ids) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const out = [];
  if (text(ids.tmdb)) out.push(`${type}_${text(ids.tmdb)}`);
  if (type === "tv" && text(ids.tvdb)) out.push(`tv_tvdb_${text(ids.tvdb)}`);
  return out;
}

// { id: language or null } for the cache rows that exist. The column is
// written on every cache write; rows restored from an old backup fall back to
// the details blob.
function readCachedLanguages(ids) {
  const found = new Map();
  for (let start = 0; start < ids.length; start += SQL_CHUNK) {
    const chunk = ids.slice(start, start + SQL_CHUNK);
    const rows = db.prepare(`
      SELECT id, original_language, CASE WHEN original_language IS NULL THEN details ELSE NULL END AS fallback_details
      FROM tmdb_metadata_cache WHERE id IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk);
    for (const row of rows) {
      const lang = row.original_language ?? parseJson(row.fallback_details)?.original_language;
      found.set(row.id, normalizeLanguageCode(lang) || null);
    }
  }
  return found;
}

export const titleLanguageDeps = Object.freeze({
  getDetails: getTmdbDetails,
});

// The original language of each title, in the same order ("" when unknown).
// `titles` are { title, ids: { tmdb, tvdb, imdb } }.
export async function readTitleLanguages(mediaType, titles, deps = titleLanguageDeps) {
  const idLists = titles.map((title) => cacheIds(mediaType, title.ids || {}));
  const cached = readCachedLanguages([...new Set(idLists.flat())]);
  const languages = Array(titles.length).fill("");
  const lookups = [];
  titles.forEach((title, index) => {
    const hit = idLists[index].find((id) => cached.has(id));
    if (hit) languages[index] = cached.get(hit) || "";
    else lookups.push(index);
  });
  await runWithConcurrency(lookups, async (index) => {
    const title = titles[index];
    try {
      const details = await deps.getDetails({
        mediaType: mediaType === "tv" ? "tv" : "movie",
        tmdbId: text(title.ids?.tmdb),
        title: text(title.title),
        ids: { tvdbId: text(title.ids?.tvdb), imdbId: text(title.ids?.imdb) },
        light: true,
        lane: "sync",
      });
      languages[index] = normalizeLanguageCode(details?.original_language);
    } catch (error) {
      if (Number(error?.status) === 404) return;
      throw error;
    }
  }, LOOKUP_CONCURRENCY);
  return languages;
}
