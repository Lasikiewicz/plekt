import { fetchWithTimeout } from "./outbound.js";
import { anidbMediaIdentity } from "./anidbMatches.js";

// Wikidata structured identifiers are CC0. Query only the movie namespace;
// multiple entities or multiple AniDB identifiers never authorize enrichment.
export function createAnidbMovieLookup({ fetcher = fetchWithTimeout, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let cooldownUntil = 0;
  return async function lookup(input, { cacheOnly = false } = {}) {
    const identity = anidbMediaIdentity(input);
    if (identity.mediaType !== "movie" || !identity.tmdbId) return null;
    const key = identity.tmdbId;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (cacheOnly || cooldownUntil > now()) return null;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        const query = `SELECT DISTINCT ?item ?aid WHERE { ?item wdt:P4947 "${key}"; wdt:P5646 ?aid. } LIMIT 3`;
        const url = new URL("https://query.wikidata.org/sparql");
        url.searchParams.set("query", query);
        url.searchParams.set("format", "json");
        const response = await fetcher(url.href, { signal: AbortSignal.timeout(8000), lane: "enrichment", headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "Plekt/1 (https://github.com/Lasikiewicz/plekt; movie metadata matching)",
        } }, 8000);
        if (!response.ok) {
          const retry = response.headers.get("retry-after");
          const retryAt = /^\d+$/.test(retry || "") ? now() + Number(retry) * 1000 : Date.parse(retry || "");
          if (Number.isFinite(retryAt)) cooldownUntil = Math.max(cooldownUntil, retryAt);
          throw new Error("Wikidata unavailable");
        }
        // Bound the response even if the upstream ignores LIMIT.
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024) throw new Error("Wikidata response too large");
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel(); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const rows = body?.results?.bindings;
        if (!Array.isArray(rows)) throw new Error("Invalid Wikidata response");
        const row = rows.length === 1 ? rows[0] : null;
        const value = row?.aid?.type === "literal" && /^[1-9]\d{0,9}$/.test(row.aid.value)
          && row?.item?.type === "uri" && /^https?:\/\/www\.wikidata\.org\/entity\/Q[1-9]\d*$/.test(row.item.value)
          ? { aid: row.aid.value, evidence: "wikidata", url: row.item.value.replace(/^http:/, "https:") } : null;
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: now() + 86400_000 });
        return value;
      } catch {
        cooldownUntil = Math.max(cooldownUntil, now() + 15 * 60_000);
        return null;
      } finally { pending.delete(key); }
    })();
    pending.set(key, request);
    return request;
  };
}

export const lookupAnidbMovie = createAnidbMovieLookup();
