import { setTimeout as delay } from "node:timers/promises";
import { fetchWithTimeout } from "./outbound.js";
import { normalizeAnidbId, parseAnidbAnime, readAnidbXml } from "./anidbProtocol.js";
import { createAnidbRepository, ANIDB_DAY_MS } from "./anidbRepository.js";

const ENDPOINT = "http://api.anidb.net:9001/httpapi";
const CLIENT = "plekt";
const CLIENT_VERSION = "1";
const result = (cached, status, error = "", retryAt = 0) => ({
  data: cached?.data || null, fetchedAt: cached?.fetchedAt || null, status, error, retryAt,
});

// Factory keeps clocks, isolated databases and mock transport injectable. Production
// requests always use the shared outbound boundary and its governor, in addition
// to AniDB's persistent cross-process pacing/lease.
export function createAnidbGateway({ repository, fetcher = fetchWithTimeout, now = Date.now, sleep = delay }) {
  const inflight = new Map();
  async function load(aid, { cacheOnly = false } = {}) {
    let cached = repository.read(aid);
    if (cached && now() - cached.fetchedAt < ANIDB_DAY_MS) return result(cached, "fresh");
    if (cacheOnly) return result(cached, cached ? "stale" : "missing");
    const waitDeadline = now() + 30_000;
    let slot;
    do {
      slot = repository.reserve(aid, now());
      if (slot.held) return result(repository.read(aid), "held", slot.error, slot.retryAt);
      if (!slot.waitMs) break;
      if (now() >= waitDeadline) return result(repository.read(aid), "held", "BUSY", now() + slot.waitMs);
      await sleep(slot.waitMs);
    } while (true);
    const signal = AbortSignal.timeout(20_000);
    try {
      const url = new URL(ENDPOINT);
      for (const [key, value] of Object.entries({ request: "anime", client: CLIENT, clientver: CLIENT_VERSION, protover: "1", aid })) url.searchParams.set(key, value);
      const response = await fetcher(url.toString(), { lane: "enrichment", signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error("AniDB HTTP error");
        error.code = response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
          if (Number.isFinite(duration) && duration > 0) error.cooldownMs = duration;
        }
        throw error;
      }
      const data = parseAnidbAnime(await readAnidbXml(response, signal), aid);
      const published = repository.finish(aid, slot.token, { now: now(), data });
      cached = repository.read(aid);
      return result(cached, published ? "fresh" : "held");
    } catch (error) {
      // Never expose provider text/URLs in an error. No automatic retry can
      // consume the same dataset twice inside its daily request guard.
      const code = /^[A-Z_]+$/.test(error?.code || "") ? error.code : "REQUEST_FAILED";
      const cooldownMs = Math.max(error?.cooldownMs || 0,
        ["BANNED", "CLIENT_REJECTED", "RATE_LIMITED"].includes(code) ? ANIDB_DAY_MS : 60_000);
      repository.finish(aid, slot.token, { now: now(), error: code, cooldownMs });
      return result(repository.read(aid), "error", code, now() + Math.max(ANIDB_DAY_MS, cooldownMs));
    }
  }
  return {
    getAnime(aid, { cacheOnly = false, signal } = {}) {
      const id = normalizeAnidbId(aid);
      signal?.throwIfAborted();
      // A subscriber cancelling must not abort another caller's shared request.
      if (cacheOnly) return load(id, { cacheOnly });
      if (!inflight.has(id)) {
        const pending = load(id).finally(() => inflight.delete(id));
        inflight.set(id, pending);
      }
      const pending = inflight.get(id);
      if (!signal) return pending;
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    },
    clearCache: repository.clearCache,
    stats: repository.stats,
  };
}

let gateway;
export async function getAnidbAnime(aid, options) {
  if (!gateway) {
    const { db } = await import("../db.js");
    gateway = createAnidbGateway({ repository: createAnidbRepository(db) });
  }
  return gateway.getAnime(aid, options);
}
