import { normalizeAnidbId, ANIDB_SCHEMA_VERSION, ANIDB_MAX_BYTES } from "./anidbProtocol.js";
import { anidbMediaIdentity } from "./anidbMatches.js";
import { ANIDB_DAY_MS } from "./anidbRepository.js";

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid AniDB backup timestamp");
  return value;
}

export function anidbBackupCollections(db) {
  const guard = db.prepare(`INSERT INTO anidb_request_state (aid,next_fetch_at_ms,error_code) VALUES (@aid,@next_fetch_at_ms,@error_code)
    ON CONFLICT(aid) DO UPDATE SET next_fetch_at_ms=MAX(next_fetch_at_ms,excluded.next_fetch_at_ms),
    error_code=CASE WHEN excluded.next_fetch_at_ms>next_fetch_at_ms THEN excluded.error_code ELSE error_code END`);
  const cache = db.prepare(`INSERT OR REPLACE INTO anidb_metadata_cache (aid,data,schema_version,fetched_at_ms)
    VALUES (@aid,@data,@schema_version,@fetched_at_ms)`);
  return {
    anidbMetadata: {
      table: "anidb_metadata_cache", key: "aid",
      rowToData: (row) => ({ data: JSON.parse(row.data), schemaVersion: row.schema_version, fetchedAt: row.fetched_at_ms }),
      dataToRow(id, value) {
        const aid = normalizeAnidbId(id);
        if (value.schemaVersion !== ANIDB_SCHEMA_VERSION || value.data?.aid !== aid
          || typeof value.data.title !== "string" || typeof value.data.overview !== "string") throw new Error("Invalid AniDB metadata backup");
        const data = JSON.stringify({ ...value.data, source: { name: "AniDB", url: `https://anidb.net/anime/${aid}`, license: "CC-BY-NC-SA-4.0" } });
        if (Buffer.byteLength(data) > ANIDB_MAX_BYTES) throw new Error("AniDB metadata backup is too large");
        return { aid, data, schema_version: value.schemaVersion, fetched_at_ms: timestamp(value.fetchedAt) };
      },
      insert: { run(row) {
        cache.run(row);
        guard.run({ aid: row.aid, next_fetch_at_ms: row.fetched_at_ms + ANIDB_DAY_MS, error_code: "" });
      } },
    },
    anidbRequests: {
      table: "anidb_request_state", key: "aid", preserveOnRestore: true,
      rowToData: (row) => ({ nextFetchAt: row.next_fetch_at_ms, errorCode: row.error_code }),
      dataToRow: (id, value) => ({ aid: normalizeAnidbId(id), next_fetch_at_ms: timestamp(value.nextFetchAt), error_code: /^[A-Z_]*$/.test(value.errorCode || "") ? value.errorCode || "" : "REQUEST_FAILED" }),
      insert: guard,
    },
    anidbProvider: {
      table: "anidb_provider_state", key: "id", preserveOnRestore: true,
      // Active leases belong to the running process, never the backup.
      rowToData: (row) => ({ nextStartAt: row.next_start_at_ms, cooldownUntil: row.cooldown_until_ms }),
      dataToRow(id, value) {
        if (String(id) !== "1") throw new Error("Invalid AniDB provider state");
        return { nextStartAt: timestamp(value.nextStartAt), cooldownUntil: timestamp(value.cooldownUntil) };
      },
      insert: db.prepare(`INSERT INTO anidb_provider_state (id,next_start_at_ms,cooldown_until_ms) VALUES (1,@nextStartAt,@cooldownUntil)
        ON CONFLICT(id) DO UPDATE SET next_start_at_ms=MAX(next_start_at_ms,excluded.next_start_at_ms),
          cooldown_until_ms=MAX(cooldown_until_ms,excluded.cooldown_until_ms)`),
    },
    anidbMatches: {
      table: "anidb_matches", key: "media_key",
      rowToData: (row) => ({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id, aid: row.aid, label: row.label, evidence: row.evidence, updatedAt: row.updated_at_ms }),
      dataToRow(id, value) {
        const identity = anidbMediaIdentity(value);
        if (identity.key !== id || value.evidence !== "confirmed") throw new Error("Invalid AniDB match backup");
        return { ...identity, aid: normalizeAnidbId(value.aid), label: String(value.label || "").slice(0, 250), updatedAt: timestamp(value.updatedAt) };
      },
      insert: db.prepare(`INSERT OR REPLACE INTO anidb_matches (media_key,media_type,tmdb_id,tvdb_id,aid,label,evidence,updated_at_ms)
        VALUES (@key,@mediaType,@tmdbId,@tvdbId,@aid,@label,'confirmed',@updatedAt)`),
    },
  };
}
