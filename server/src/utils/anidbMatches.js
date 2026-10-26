import { normalizeAnidbId } from "./anidbProtocol.js";

export function anidbMediaIdentity(input = {}) {
  const mediaType = input.mediaType;
  if (!["movie", "tv"].includes(mediaType)) throw new Error("Choose Movie or TV show");
  const id = (value) => value == null || value === "" ? "" : normalizeAnidbId(value);
  const tmdbId = id(input.tmdbId);
  const tvdbId = mediaType === "tv" ? id(input.tvdbId) : "";
  if (!tmdbId && !tvdbId) throw new Error("A TMDB ID or TVDB show ID is required");
  return { mediaType, tmdbId, tvdbId, key: `${mediaType}:${tmdbId ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}`}` };
}

export function createAnidbMatches(db) {
  const all = db.prepare("SELECT * FROM anidb_matches ORDER BY updated_at_ms DESC, media_key");
  const find = db.prepare(`SELECT * FROM anidb_matches WHERE media_type=? AND
    ((?<>'' AND tmdb_id=?) OR (?<>'' AND tvdb_id=?))`);
  const upsert = db.prepare(`INSERT INTO anidb_matches (media_key,media_type,tmdb_id,tvdb_id,aid,label,evidence,updated_at_ms)
    VALUES (@key,@mediaType,@tmdbId,@tvdbId,@aid,@label,@evidence,@now)
    ON CONFLICT(media_key) DO UPDATE SET tmdb_id=excluded.tmdb_id,tvdb_id=excluded.tvdb_id,aid=excluded.aid,
      label=excluded.label,evidence=excluded.evidence,updated_at_ms=excluded.updated_at_ms`);
  return {
    list: () => all.all(),
    resolve(input) {
      const identity = anidbMediaIdentity(input);
      const rows = find.all(identity.mediaType, identity.tmdbId, identity.tmdbId, identity.tvdbId, identity.tvdbId);
      // Conflicting aliases or stored canonical IDs remain unresolved.
      if (rows.some((row) => identity.tmdbId && row.tmdb_id && identity.tmdbId !== row.tmdb_id
        || identity.tvdbId && row.tvdb_id && identity.tvdbId !== row.tvdb_id)) return null;
      return new Set(rows.map((row) => row.aid)).size === 1 ? rows[0] : null;
    },
    save(input) {
      const identity = anidbMediaIdentity(input);
      const aid = normalizeAnidbId(input.aid);
      // Only the confirmation endpoint can create these records. All alias
      // matches are replaced together so a prior TVDB-only record cannot linger.
      db.transaction(() => {
        const rows = find.all(identity.mediaType, identity.tmdbId, identity.tmdbId, identity.tvdbId, identity.tvdbId);
        for (const row of rows) db.prepare("DELETE FROM anidb_matches WHERE media_key=?").run(row.media_key);
        upsert.run({ ...identity, aid, label: String(input.label || "").slice(0, 250), evidence: "confirmed", now: Date.now() });
      }).immediate();
      return identity;
    },
    remove(input) { return db.prepare("DELETE FROM anidb_matches WHERE media_key=?").run(anidbMediaIdentity(input).key).changes; },
  };
}

// Trusted provider IDs can be considered without shipping a third-party
// mapping dataset. Partial or conflicting provider links are never applied.
export function verifiedAnidbProviderCandidate(series, canonicalTvdbId, cachedAnime) {
  if (!series || String(series.id) !== String(canonicalTvdbId)) return null;
  const ids = new Set((series.remoteIds || []).filter((item) => /^anidb(?:\.net)?$/i.test(item.sourceName || ""))
    .map((item) => String(item.id || "")).filter((id) => /^[1-9]\d{0,9}$/.test(id)));
  if (ids.size !== 1) return null;
  const aid = [...ids][0];
  const anime = cachedAnime(aid);
  const episodes = (series.episodes || []).filter((episode) => Number(episode.seasonNumber) > 0);
  const normalAnime = (anime?.data?.episodes || []).filter((episode) => episode.type === "1");
  if (!episodes.length || !normalAnime.length || episodes.length !== normalAnime.length) return null;
  return aid;
}
