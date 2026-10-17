import { db } from "../db.js";
import { readShowNumbering } from "./seasonSource.js";
import { getCachedTvdbSeasonEpisodes, getTvdbSeasonEpisodes } from "./tvdbGateway.js";

// Up Next reads the stored rows' numbering, not the selected display numbering.
// Warm only the two most recently active row seasons and their successors.
const recentSeasons = db.prepare(`
  SELECT season, MAX(activity_at) AS activity_at FROM (
    SELECT season, CASE WHEN watched_at GLOB '[0-9][0-9][0-9][0-9]-*'
      THEN unixepoch(watched_at) * 1000 ELSE CAST(watched_at AS REAL) END AS activity_at FROM watch_history
    WHERE media_type = 'episode' AND lower(show_title) = lower(?)
    UNION ALL
    SELECT season, updated_at AS activity_at FROM playback_progress
    WHERE media_type = 'episode' AND position_ms > 0 AND
      (lower(title) = lower(?) OR lower(title) LIKE lower(?) ESCAPE '\\')
  ) WHERE season >= 0 GROUP BY season ORDER BY activity_at DESC LIMIT 2
`);

export function translatedRowSeasons(details) {
  const tvdbId = String(details?.external_ids?.tvdb_id || "");
  const numbering = readShowNumbering(tvdbId);
  if (!tvdbId || !numbering.translate || numbering.rowNumbering !== "tvdb") return [];
  const title = String(details.name || details.original_name || "");
  if (!title) return [];
  const escaped = title.replace(/[\\%_]/g, "\\$&");
  return [...new Set(recentSeasons.all(title, title, `${escaped} - S%`).flatMap(({ season }) => [Number(season), Number(season) + 1]))];
}

export function needsTranslatedSeasonWarmup(details) {
  const tvdbId = String(details?.external_ids?.tvdb_id || "");
  return translatedRowSeasons(details).some((seasonNumber) => !getCachedTvdbSeasonEpisodes({ tvdbId, seasonNumber }));
}

export async function warmTranslatedRowSeasons(details, { fetchSeason = getTvdbSeasonEpisodes } = {}) {
  const tvdbId = String(details?.external_ids?.tvdb_id || "");
  for (const seasonNumber of translatedRowSeasons(details)) {
    await fetchSeason({ tvdbId, seasonNumber, lane: "enrichment" });
  }
}
