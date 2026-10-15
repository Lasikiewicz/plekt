import { db, parseJson, toJson } from "../db.js";
import { loadMediaConfig } from "./configStore.js";
import { fetchWithTimeout } from "./outbound.js";

// Shared fanart.tv project key - intentionally public: fanart.tv issues these
// for apps to embed, and rate-limits them upstream. Operators can swap in their
// own via FANART_PROJECT_KEY (a personal key in Settings additionally raises the
// rate limit as client_key) if this one is revoked or exhausted.
//
// Because the project key's rate pool is shared by every Plembfin install,
// this gateway uses the same discipline as the TMDB/TVDB gateways: a 350 ms
// serialized throttle, in-flight request dedupe, and a SQLite response cache
// (7 days for hits, 24 hours for "fanart has nothing for this item").
const PROJECT_KEY = String(process.env.FANART_PROJECT_KEY || "").trim() || "bab936b0927ec594f22c16cef458f742";

// Never exposes the key itself - just whether a built-in one is available.
export function fanartBuiltInAvailable() {
  return Boolean(PROJECT_KEY);
}
const API_ROOT = "https://webservice.fanart.tv/v3";
const DAY_MS = 24 * 60 * 60 * 1000;
const HIT_TTL_MS = 7 * DAY_MS;
const MISS_TTL_MS = DAY_MS;
const inflight = new Map();
let nextRequestAt = 0;
let throttleTail = Promise.resolve();

const cacheGetStmt = db.prepare("SELECT data, missing, updated_at_ms FROM fanart_cache WHERE id = ?");
const cacheSetStmt = db.prepare(
  `INSERT INTO fanart_cache (id, data, missing, updated_at_ms) VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data=excluded.data, missing=excluded.missing, updated_at_ms=excluded.updated_at_ms`,
);

function collapse(key, task) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const previous = throttleTail;
  let release;
  throttleTail = new Promise((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) await wait(delay);
  nextRequestAt = Date.now() + 350;
  release();
}

async function userKey() {
  const config = await loadMediaConfig();
  return String(config.fanart?.apiKey || "").trim();
}

async function requestFanart(path, apiKey, extra = {}) {
  await throttle();
  const url = new URL(`${API_ROOT}/${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(extra)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetchWithTimeout(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) return { status: response.status, data: null };
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function fetchFanart(path) {
  return collapse(`fanart:${path}`, async () => {
    const row = cacheGetStmt.get(path);
    const cached = row ? { data: parseJson(row.data), missing: Boolean(row.missing), updatedAtMs: Number(row.updated_at_ms || 0) } : null;
    if (cached && Date.now() - cached.updatedAtMs < (cached.missing ? MISS_TTL_MS : HIT_TTL_MS)) {
      return cached.missing ? null : cached.data;
    }

    const clientKey = await userKey();
    try {
      let result = await requestFanart(path, PROJECT_KEY, clientKey ? { client_key: clientKey } : {});
      // A 404 from the project key means fanart.tv has nothing for this item -
      // the personal key would 404 too, so only fall back on other failures.
      if (!result.data && clientKey && result.status !== 404) {
        result = await requestFanart(path, clientKey);
      }
      if (result.data) {
        cacheSetStmt.run(path, toJson(result.data), 0, Date.now());
        return result.data;
      }
      if (result.status === 404) {
        cacheSetStmt.run(path, null, 1, Date.now());
        return null;
      }
      // Transient failure (5xx/429): serve the stale cache without overwriting it.
      return cached && !cached.missing ? cached.data : null;
    } catch {
      return cached && !cached.missing ? cached.data : null;
    }
  });
}

function bestImage(arr = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const sorted = [...arr].sort((a, b) => {
    const langScore = (x) => (x.lang === "en" ? 2 : x.lang === "" ? 1 : 0);
    return (Number(b.likes) || 0) + langScore(b) - ((Number(a.likes) || 0) + langScore(a));
  });
  return sorted[0]?.url || null;
}

export async function getFanartMovieArt(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await fetchFanart(`movies/${tmdbId}`);
    if (!data) return null;
    return {
      poster: bestImage(data.movieposter),
      backdrop: bestImage(data.moviebackground),
      logo: bestImage(data.hdmovielogo || data.movielogo),
    };
  } catch {
    return null;
  }
}

export async function getFanartTvArt(tvdbId) {
  if (!tvdbId) return null;
  try {
    const data = await fetchFanart(`tv/${tvdbId}`);
    if (!data) return null;
    return {
      poster: bestImage(data.tvposter),
      backdrop: bestImage(data.showbackground || data.tvbackground),
      logo: bestImage(data.hdtvlogo || data.clearlogo),
    };
  } catch {
    return null;
  }
}

function allImages(arr = []) {
  if (!Array.isArray(arr)) return [];
  return [...arr]
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
    .map(x => ({ url: x.url, lang: x.lang || "" }));
}

export async function getAllFanartMovieImages(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await fetchFanart(`movies/${tmdbId}`);
    if (!data) return null;
    return {
      posters: allImages(data.movieposter),
      logos: allImages([...(data.hdmovielogo || []), ...(data.movielogo || [])]),
      backdrops: allImages(data.moviebackground),
    };
  } catch {
    return null;
  }
}

// fanart.tv tags each season poster with its season number as a string.
export async function getFanartTvSeasonPosters(tvdbId, seasonNumber) {
  if (!tvdbId) return [];
  try {
    const data = await fetchFanart(`tv/${tvdbId}`);
    const wanted = String(seasonNumber);
    const matches = (Array.isArray(data?.seasonposter) ? data.seasonposter : []).filter((item) => String(item.season) === wanted);
    return allImages(matches);
  } catch {
    return [];
  }
}

export async function getAllFanartTvImages(tvdbId) {
  if (!tvdbId) return null;
  try {
    const data = await fetchFanart(`tv/${tvdbId}`);
    if (!data) return null;
    return {
      posters: allImages(data.tvposter),
      logos: allImages([...(data.hdtvlogo || []), ...(data.clearlogo || [])]),
      backdrops: allImages([...(data.showbackground || []), ...(data.tvbackground || [])]),
    };
  } catch {
    return null;
  }
}
