import { randomUUID } from "node:crypto";
import { ANIDB_SCHEMA_VERSION } from "./anidbProtocol.js";

export const ANIDB_DAY_MS = 24 * 60 * 60 * 1000;
export const ANIDB_INTERVAL_MS = 2000;
const LEASE_MS = 60_000;

export function createAnidbRepository(db) {
  const readCache = db.prepare("SELECT * FROM anidb_metadata_cache WHERE aid = ?");
  const readRequest = db.prepare("SELECT * FROM anidb_request_state WHERE aid = ?");
  const readProvider = db.prepare("SELECT * FROM anidb_provider_state WHERE id = 1");
  const initProvider = db.prepare("INSERT OR IGNORE INTO anidb_provider_state (id) VALUES (1)");
  const writeRequest = db.prepare(`INSERT INTO anidb_request_state (aid, next_fetch_at_ms, error_code) VALUES (?, ?, ?)
    ON CONFLICT(aid) DO UPDATE SET next_fetch_at_ms=excluded.next_fetch_at_ms, error_code=excluded.error_code`);
  const reserve = db.transaction((aid, now) => {
    initProvider.run();
    const request = readRequest.get(aid);
    if (request?.next_fetch_at_ms > now) return { held: true, retryAt: request.next_fetch_at_ms, error: request.error_code };
    const state = readProvider.get();
    if (state.cooldown_until_ms > now) return { held: true, retryAt: state.cooldown_until_ms, error: "COOLDOWN" };
    const availableAt = Math.max(state.next_start_at_ms, state.lease_until_ms);
    if (availableAt > now) return { waitMs: Math.min(availableAt - now, 250) };
    const token = randomUUID();
    db.prepare("UPDATE anidb_provider_state SET lease_token=?, lease_until_ms=?, next_start_at_ms=? WHERE id=1")
      .run(token, now + LEASE_MS, now + ANIDB_INTERVAL_MS);
    // Reserve the daily budget before the request, including errors/crashes.
    // This ledger is intentionally not removed by clearCache().
    writeRequest.run(aid, now + ANIDB_DAY_MS, "REQUEST_INCOMPLETE");
    return { token };
  });
  const finish = db.transaction((aid, token, { now, data, error = "", cooldownMs = 0 }) => {
    // A lease that expired and was taken by another process cannot publish.
    if (readProvider.get()?.lease_token !== token) return false;
    if (data) db.prepare(`INSERT INTO anidb_metadata_cache (aid,data,schema_version,fetched_at_ms) VALUES (?,?,?,?)
      ON CONFLICT(aid) DO UPDATE SET data=excluded.data,schema_version=excluded.schema_version,fetched_at_ms=excluded.fetched_at_ms`)
      .run(aid, JSON.stringify(data), ANIDB_SCHEMA_VERSION, now);
    writeRequest.run(aid, now + ANIDB_DAY_MS, error);
    db.prepare(`UPDATE anidb_provider_state SET lease_token='',lease_until_ms=0,
      next_start_at_ms=MAX(next_start_at_ms,?),cooldown_until_ms=MAX(cooldown_until_ms,?) WHERE id=1`)
      .run(now + ANIDB_INTERVAL_MS, cooldownMs ? now + cooldownMs : 0);
    return true;
  });
  return {
    reserve: (aid, now) => reserve.immediate(aid, now),
    finish: (aid, token, result) => finish.immediate(aid, token, result),
    read(aid) {
      const row = readCache.get(aid);
      if (!row || row.schema_version !== ANIDB_SCHEMA_VERSION) return null;
      try {
        const data = JSON.parse(row.data);
        return data?.aid === aid ? { data, fetchedAt: row.fetched_at_ms } : null;
      } catch { return null; }
    },
    clearCache: () => db.prepare("DELETE FROM anidb_metadata_cache").run().changes,
    stats: () => db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM anidb_metadata_cache").get(),
  };
}
