import { db } from "../db.js";
import { normalizeWatchProvenance } from "./watchProvenance.js";
import { readShowNumbering } from "./seasonSource.js";
import { showNumberMap } from "./showSeasonTranslation.js";

// Inbound Trakt numbering for a show with a Fix Match season choice whose
// plays were replaced on Trakt (showTraktReplace.js). Its plays live on Trakt
// under TMDB numbers: rows that existed at the replace record theirs in
// provider_overrides.trakt, and later watches are mapped the same way on the
// way out (traktOutboundNumbering.js). Stored rows keep the media server's
// numbers (decision 15), so a Trakt watch, unwatch or history play for that
// show is mapped back to the stored coordinates before it touches local data.
// Other shows, including older Trakt split overrides, pass through unchanged.

const selectOverrideRowsStmt = db.prepare(`
  SELECT season, episode, tvdb_id, tmdb_id, watch_provenance
  FROM watch_history
  WHERE media_type = 'episode' AND watch_provenance LIKE '%"trakt"%'
`);
const cachedShowsStmt = db.prepare(`
  SELECT DISTINCT CAST(json_extract(m.details, '$.external_ids.tvdb_id') AS TEXT) AS tvdb_id, m.tmdb_id
  FROM tmdb_metadata_cache m
  WHERE m.media_type='tv' AND json_valid(m.details) AND m.tmdb_id <> ''
    AND EXISTS (SELECT 1 FROM tvdb_metadata_cache v WHERE v.tvdb_id=CAST(json_extract(m.details, '$.external_ids.tvdb_id') AS TEXT))
`);

function episodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

// Builds the lookup once per poll. Resolves to a function that maps one Trakt
// media object to the stored numbering, or returns it unchanged.
export async function buildTraktInboundTranslator() {
  const index = new Map();
  const shows = new Map();
  // Cached catalogue identities also cover the first Trakt import, before
  // this show has a local watch or an explicit Fix Match choice.
  for (const row of cachedShowsStmt.all()) shows.set(String(row.tvdb_id), { numbering: readShowNumbering(row.tvdb_id), tmdbId: String(row.tmdb_id) });
  for (const row of selectOverrideRowsStmt.all()) {
    const tvdbId = String(row.tvdb_id || "");
    if (!tvdbId) continue;
    if (!shows.has(tvdbId)) {
      const numbering = readShowNumbering(tvdbId);
      shows.set(tvdbId, { numbering, tmdbId: String(row.tmdb_id || "") });
    }
    const show = shows.get(tvdbId);
    if (!show) continue;
    const override = normalizeWatchProvenance(row.watch_provenance)?.provider_overrides?.trakt;
    if (!override?.tmdb_id || override.season == null || override.episode == null) continue;
    show.tmdbId = String(override.tmdb_id);
    index.set(`${override.tmdb_id}:${Number(override.season)}:${Number(override.episode)}`, {
      season: Number(row.season),
      episode: Number(row.episode),
    });
  }
  // Episodes watched after the replace have no row override; the show's full
  // map (cached seasons) covers them. Row overrides win where both exist.
  for (const [tvdbId, show] of shows) {
    if (!show?.tmdbId || show.numbering.rowNumbering === "tmdb") continue;
    const built = await showNumberMap({ tvdbId, tmdbId: show.tmdbId, numbering: { ...show.numbering, source: "tmdb" }, cachedOnly: true }).catch(() => null);
    for (const [storedKey, target] of built?.map?.pairs || []) {
      const key = `${show.tmdbId}:${target.season}:${target.episode}`;
      if (index.has(key)) continue;
      const [season, episode] = storedKey.split(":").map(Number);
      index.set(key, { season, episode });
    }
  }
  return (media = {}) => {
    if (!index.size || (media.type || media.mediaType) !== "episode") return media;
    const target = index.get(`${String(media.ids?.tmdb || "")}:${Number(media.season)}:${Number(media.episode)}`);
    if (!target) return media;
    const from = episodeCode(media.season, media.episode);
    return {
      ...media,
      season: target.season,
      episode: target.episode,
      watchProvenance: { ...(media.watchProvenance || {}), source: media.source || "trakt", ingest_path: "trakt_import",
        provider_overrides: { trakt: { tmdb_id: String(media.ids.tmdb), season: Number(media.season), episode: Number(media.episode) } } },
      ...(typeof media.title === "string" ? { title: media.title.replace(from, episodeCode(target.season, target.episode)) } : {}),
    };
  };
}
