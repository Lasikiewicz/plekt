import { db } from "../db.js";
import { readShowNumbering } from "./seasonSource.js";
import { showNumberMap } from "./showSeasonTranslation.js";
import { translateEpisode } from "./episodeNumberMap.js";

// Saved per-row Trakt coordinates win. Later watches and restored rows use
// the explicit per-show choice and cached seasons to map stored TVDB numbers
// to TMDB numbers. Missing mappings fail closed before any remote write.

const replacedShowStmt = db.prepare(`
  SELECT 1 FROM watch_history
  WHERE tvdb_id = ? AND media_type = 'episode' AND watch_provenance LIKE '%"provider_overrides"%' AND watch_provenance LIKE '%"trakt"%'
  LIMIT 1
`);

export async function withSeasonSourceTraktOverride(media = {}) {
  if ((media.type || media.mediaType) !== "episode") return media;
  let provenance = media.watch_provenance || {};
  if (typeof provenance === "string") {
    try { provenance = JSON.parse(provenance); } catch { provenance = {}; }
  }
  const override = media.traktOverride || media.providerOverrides?.trakt || media.provider_overrides?.trakt || provenance?.provider_overrides?.trakt;
  if (override) {
    if (!override.tmdb_id || !Number.isInteger(Number(override.season)) || Number(override.season) < 0 || !Number.isInteger(Number(override.episode)) || Number(override.episode) < 1) {
      throw new Error("Trakt numbering override is invalid; fix the episode mapping before syncing");
    }
    return { ...media, traktOverride: override };
  }
  const tvdbId = String(media.tvdb_id || media.ids?.tvdb || "");
  const tmdbId = String(media.tmdb_id || media.ids?.tmdb || "");
  if (!tvdbId) return media;
  const numbering = readShowNumbering(tvdbId);
  if (!numbering.overriddenAt || numbering.rowNumbering === "tmdb") return media;
  if (numbering.source !== "tmdb" && !replacedShowStmt.get(tvdbId)) return media;
  const built = await showNumberMap({ tvdbId, tmdbId, numbering: { ...numbering, source: "tmdb" }, cachedOnly: true }).catch(() => null);
  const target = built ? translateEpisode(built.map, media.season, media.episode) : null;
  if (!tmdbId || !target) throw new Error(`Trakt numbering could not map S${media.season}E${media.episode}; fix the translated episode mapping before syncing`);
  return { ...media, traktOverride: { tmdb_id: tmdbId, season: target.season, episode: target.episode } };
}
