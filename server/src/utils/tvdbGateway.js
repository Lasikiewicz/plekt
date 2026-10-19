import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";

// Shared TVDB v4 project key - intentionally public: TVDB issues these for
// open-source apps to embed, and rate-limits them upstream. Operators can swap
// in their own via TVDB_PROJECT_KEY (or a personal key in Settings, which takes
// precedence over both) if this one is revoked or exhausted.
const PROJECT_KEY = String(process.env.TVDB_PROJECT_KEY || "").trim() || "94a93e8a-7ab8-4708-b6b7-a9fae1bc6ac2";

// Never exposes the key itself - just whether a built-in one is available.
export function tvdbBuiltInAvailable() {
  return Boolean(PROJECT_KEY);
}
const API_ROOT = "https://api4.thetvdb.com/v4";
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 180 * DAY_MS;
const SEARCH_MISS_TTL_MS = 60 * 60 * 1000;
const SERIES_ENGLISH_OVERVIEW_TTL_MS = 30 * DAY_MS;
const SERIES_ENGLISH_OVERVIEW_ERROR_TTL_MS = 15 * 60 * 1000;
// The movie page's "Recommended TV Shows" rail asks "is there a series named
// like this film?" on every view, and 9 in 10 answers are no. It reads a miss
// for a week instead of an hour; the TTL is applied on read, so sync's own
// title resolution still retries a miss after an hour and refreshes the row.
export const RELATED_TV_SEARCH_MISS_TTL_MS = 7 * DAY_MS;
const ACTIVE_SERIES_TTL_MS = 14 * DAY_MS;
const ARCHIVED_SERIES_TTL_MS = 180 * DAY_MS;
const UPCOMING_SEASON_TTL_MS = 2 * DAY_MS;
const ACTIVE_SEASON_TTL_MS = 7 * DAY_MS;
const ARCHIVED_SEASON_TTL_MS = 180 * DAY_MS;
const TOKEN_LIFETIME_MS = 25 * DAY_MS;
const TVDB_ID_PATTERN = /^\d+$/;
// Bump this when the title/alias matching rules change so a cached miss from
// an older resolver cannot keep a valid series invisible until its normal TTL
// expires.
const SEARCH_MATCH_SCHEMA_VERSION = 3;
const SEARCH_LIST_SCHEMA_VERSION = 2;
const inflight = new Map();
let nextRequestAt = 0;
let throttleQueue = [];
let throttleTimer = null;
let throttleSequence = 0;
const THROTTLE_PRIORITY = { interactive: 0, sync: 1, enrichment: 2 };

const seriesGetStmt = db.prepare("SELECT * FROM tvdb_metadata_cache WHERE id = ?");
const seriesSetStmt = db.prepare(
  `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
   VALUES (@id, @tvdb_id, @title, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, title=excluded.title,
     details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

const seasonGetStmt = db.prepare("SELECT * FROM tvdb_season_cache WHERE id = ?");
const seasonSetStmt = db.prepare(
  `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
   VALUES (@id, @tvdb_id, @season_number, @details, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, season_number=excluded.season_number,
     details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secretFingerprint(value) {
  return crypto.pbkdf2Sync(String(value), "plembfin-tvdb-token-cache-v1", 100000, 32, "sha256").toString("hex");
}

function canonicalTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleParts(value = "") {
  const trimmed = String(value || "").trim();
  const yearMatch = trimmed.match(/\((\d{4})\)$/);
  const text = yearMatch ? trimmed.slice(0, yearMatch.index).trim() : trimmed;
  return { title: text, year: yearMatch?.[1] || "" };
}

export function tvdbSeriesTitleKey(value = "") {
  const { title } = titleParts(value);
  return canonicalTitle(title);
}

function candidateYear(item = {}) {
  return String(item.year || item.first_air_time || item.firstAired || "").slice(0, 4);
}

function textFromTranslation(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return String(value.name || value.title || value.translation || value.value || "").trim();
}

function translationEntries(item = {}) {
  const translations = item && typeof item.translations === "object" ? item.translations : {};
  return Object.entries(translations)
    .map(([language, value]) => ({ language: String(language || ""), text: textFromTranslation(value) }))
    .filter((entry) => entry.text);
}

function searchNameCandidates(item = {}) {
  const names = [
    ...translationEntries(item)
      .filter(({ language }) => /^(?:eng|en|english)(?:[-_].*)?$/i.test(language))
      .map(({ text }) => text),
    item.name,
    item.title,
    item.englishName,
    item.english_name,
    item.originalName,
    item.original_name,
    ...translationEntries(item).map(({ text }) => text),
    // TVDB search can return a localized primary name while still exposing the
    // English series slug. This is especially common for Japanese Netflix
    // titles such as Last Samurai Standing / イクサガミ.
    String(item.slug || "").replace(/[-_]+/g, " "),
  ];
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
}

function preferredSearchName(item = {}) {
  return searchNameCandidates(item)[0] || "";
}

function normalizeSearchCandidate(item = {}) {
  const tvdbId = normalizeTvdbId(item.tvdb_id || item.tvdbId || item.id);
  const name = preferredSearchName(item);
  if (!tvdbId || !name) return null;
  return { tvdb_id: tvdbId, name, year: candidateYear(item) };
}

// TVDB search results are ranked, not guaranteed to be the requested series.
// A title-only lookup must therefore never accept the first result blindly:
// accept one exact match, use a year in the title when supplied, and otherwise
// fail closed so a reboot or same-title series cannot be silently misassigned.
export function selectTvdbSeriesMatch(results = [], title = "") {
  const requested = titleParts(title);
  const requestedKey = tvdbSeriesTitleKey(requested.title);
  if (!requestedKey) return null;

  const exact = (Array.isArray(results) ? results : [])
    .map((item) => {
      const candidate = normalizeSearchCandidate(item);
      return candidate ? { candidate, names: searchNameCandidates(item) } : null;
    })
    .filter((entry) => entry && entry.names.some((name) => tvdbSeriesTitleKey(name) === requestedKey))
    .map(({ candidate }) => candidate);
  if (!exact.length) return null;

  if (requested.year) {
    const sameYear = exact.filter((candidate) => candidate.year === requested.year);
    return sameYear.length === 1 ? sameYear[0] : null;
  }
  return exact.length === 1 ? exact[0] : null;
}

function seriesNameCandidates(details = {}) {
  const source = details && typeof details === "object" ? details : {};
  const names = [source.name, source.originalName, source.original_name];
  if (Array.isArray(source.aliases)) {
    names.push(...source.aliases.map((alias) => typeof alias === "string" ? alias : alias?.name));
  }
  if (source.translations && typeof source.translations === "object") {
    names.push(...Object.values(source.translations).flatMap((translation) => (
      typeof translation === "string" ? [translation] : [translation?.name, translation?.title]
    )));
  }
  return names.map((name) => String(name || "").trim()).filter(Boolean);
}

export function tvdbSeriesTitleMatches(title = "", details = {}) {
  const expected = tvdbSeriesTitleKey(title);
  if (!expected) return true;
  const candidates = seriesNameCandidates(details);
  return !candidates.length || candidates.some((candidate) => tvdbSeriesTitleKey(candidate) === expected);
}

function fresh(updatedAtMs, ttl) {
  return Boolean(updatedAtMs && Date.now() - updatedAtMs < ttl);
}

function isoDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function daysAgoIso(days) {
  const date = new Date(Date.now() - days * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function seriesCacheTtl(details) {
  const status = String(details?.status?.name || details?.status || "").toLowerCase();
  const nextAired = isoDate(details?.nextAired);
  const today = new Date().toISOString().slice(0, 10);
  if (nextAired && nextAired >= today) return ACTIVE_SERIES_TTL_MS;
  if (/(ended|cancelled|canceled|finale|completed)/.test(status)) return ARCHIVED_SERIES_TTL_MS;
  return ACTIVE_SERIES_TTL_MS;
}

function seasonCacheTtl(details) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  if (!episodes.length) return UPCOMING_SEASON_TTL_MS;
  const today = new Date().toISOString().slice(0, 10);
  const airedDates = episodes.map((episode) => isoDate(episode.aired)).filter(Boolean).sort();
  if (airedDates.some((date) => date >= today)) return UPCOMING_SEASON_TTL_MS;
  const lastAired = airedDates[airedDates.length - 1] || "";
  if (lastAired && lastAired < daysAgoIso(30)) return ARCHIVED_SEASON_TTL_MS;
  return ACTIVE_SEASON_TTL_MS;
}

function collapse(key, task) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function drainThrottleQueue() {
  throttleTimer = null;
  if (!throttleQueue.length) return;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) {
    throttleTimer = setTimeout(drainThrottleQueue, delay);
    return;
  }
  throttleQueue.sort((a, b) => (
    THROTTLE_PRIORITY[a.lane] - THROTTLE_PRIORITY[b.lane] || a.sequence - b.sequence
  ));
  const next = throttleQueue.shift();
  nextRequestAt = Date.now() + 350;
  next.resolve();
  if (throttleQueue.length) drainThrottleQueue();
}

async function throttle({ lane = "enrichment" } = {}) {
  return new Promise((resolve) => {
    throttleQueue.push({
      lane: Object.prototype.hasOwnProperty.call(THROTTLE_PRIORITY, lane) ? lane : "enrichment",
      sequence: throttleSequence++,
      resolve,
    });
    drainThrottleQueue();
  });
}

async function effectiveApiKey() {
  const config = await loadMediaConfig();
  return String(config.tvdb?.apiKey || "").trim() || PROJECT_KEY;
}

async function getToken({ forceRefresh = false, lane = "enrichment" } = {}) {
  const apiKey = await effectiveApiKey();
  const keyHash = secretFingerprint(apiKey);
  const runtime = await loadRuntimeState().catch(() => ({}));
  if (!forceRefresh && runtime.tvdbToken && runtime.tvdbTokenKeyHash === keyHash && fresh(runtime.tvdbTokenIssuedAtMs, TOKEN_LIFETIME_MS)) {
    return runtime.tvdbToken;
  }
  await throttle({ lane });
  const response = await fetchWithTimeout(`${API_ROOT}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
    lane,
  });
  if (!response.ok) {
    const error = new Error(`TVDB login failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  const token = body?.data?.token;
  if (!token) {
    const error = new Error("TVDB login did not return a token");
    error.status = 502;
    throw error;
  }
  await setRuntimeState({ tvdbToken: token, tvdbTokenKeyHash: keyHash, tvdbTokenIssuedAtMs: Date.now() });
  return token;
}

function normalizeTvdbId(value) {
  const id = String(value || "").trim().replace(/^series-/, "");
  return TVDB_ID_PATTERN.test(id) ? id : "";
}

function tvdbEndpointUrl(endpoint, params = {}) {
  const url = new URL(`${API_ROOT}/`);
  if (endpoint === "search") {
    url.pathname = "/v4/search";
  } else if (endpoint === "artwork-types") {
    url.pathname = "/v4/artwork/types";
  } else if (endpoint?.type === "series-extended") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB series id is required"), { status: 400 });
    url.pathname = `/v4/series/${id}/extended`;
  } else if (endpoint?.type === "series-translation") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB series id is required"), { status: 400 });
    const language = String(endpoint.language || "").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(language)) throw Object.assign(new Error("Valid TVDB language is required"), { status: 400 });
    url.pathname = `/v4/series/${id}/translations/${language}`;
  } else if (endpoint?.type === "series-artworks") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB series id is required"), { status: 400 });
    url.pathname = `/v4/series/${id}/artworks`;
  } else if (endpoint?.type === "season-extended") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB season id is required"), { status: 400 });
    url.pathname = `/v4/seasons/${id}/extended`;
  } else if (endpoint?.type === "episode") {
    const id = normalizeTvdbId(endpoint.id);
    if (!id) throw Object.assign(new Error("Valid TVDB episode id is required"), { status: 400 });
    url.pathname = `/v4/episodes/${id}`;
  } else {
    throw Object.assign(new Error("Unsupported TVDB endpoint"), { status: 500 });
  }
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  return url;
}

// After exhausted 429 retries the module cools down: the project key's rate
// pool is shared by every Plembfin install, so once it's exhausted, queueing
// more attempts only burns quota. During the cooldown, callers fail fast and
// fall back to their stale SQLite caches.
let rateLimitCooldownUntil = 0;

async function upstream(endpoint, params = {}, attempt = 0, { lane = "enrichment" } = {}) {
  if (Date.now() < rateLimitCooldownUntil) {
    const error = new Error("TVDB requests are cooling down after repeated 429 responses");
    error.status = 429;
    throw error;
  }
  await throttle({ lane });
  const token = await getToken({ lane });
  const url = tvdbEndpointUrl(endpoint, params);
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, lane });
  if (response.status === 401 && attempt < 1) {
    await getToken({ forceRefresh: true, lane });
    return upstream(endpoint, params, attempt + 1, { lane });
  }
  if (response.status === 429) {
    const retryAfterSec = Number(response.headers.get("retry-after"));
    const retryMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * (attempt + 1);
    if (attempt < 2 && retryMs <= 15_000) {
      await wait(retryMs + Math.floor(Math.random() * 250));
      return upstream(endpoint, params, attempt + 1);
    }
    rateLimitCooldownUntil = Date.now() + Math.max(60_000, Math.min(retryMs, 15 * 60_000));
  }
  if (!response.ok) {
    const error = new Error(`TVDB request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  return body?.data;
}

// A stored "series" id can actually be one of its own episode's ids - TVDB
// assigns episodes their own ids, separate from the series, and several
// ingestion paths (Plex/Emby/Jellyfin) can end up storing the episode's id
// instead of the show's. Rather than guess the right show from a title search
// (ambiguous when two real shows share a name - see getTvShowDetails), ask
// TVDB directly what show this id's episode actually belongs to. Safe to try
// on any id: if it genuinely is a series id, the episode lookup 404s quickly
// and the caller's existing series lookup already succeeded anyway.
export async function resolveTvdbSeriesIdFromEpisodeId(tvdbEpisodeId, { lane = "enrichment" } = {}) {
  const id = normalizeTvdbId(tvdbEpisodeId);
  if (!id) return "";
  try {
    const episode = await upstream({ type: "episode", id }, {}, 0, { lane });
    return episode?.seriesId ? String(episode.seriesId) : "";
  } catch {
    return "";
  }
}

// What a TVDB id is as an episode: its series and aired-order coordinate, or
// nothing (TVDB answers 404). Tier 2 of the playstate episode-id repair
// (plan/active/playstate-episode-id-repair/plan.md) reads the cache only; the lookup runs
// from its background job and throws on any other failure, so nothing is
// cached and the id is retried later.
const EPISODE_KIND_TTL_MS = 30 * DAY_MS;

export function getCachedTvdbEpisodeKind(tvdbEpisodeId) {
  const id = normalizeTvdbId(tvdbEpisodeId);
  if (!id) return null;
  const cached = seriesGetStmt.get(`episode_kind_${id}`);
  if (!cached || !fresh(cached.updated_at_ms, EPISODE_KIND_TTL_MS)) return null;
  const details = parseJson(cached.details);
  return details?.kind ? details : null;
}

export async function lookupTvdbEpisodeKind(tvdbEpisodeId, { lane = "enrichment" } = {}) {
  const id = normalizeTvdbId(tvdbEpisodeId);
  if (!id) return null;
  const cached = getCachedTvdbEpisodeKind(id);
  if (cached) return cached;
  let details;
  try {
    const episode = await upstream({ type: "episode", id }, {}, 0, { lane });
    details = episode?.seriesId
      ? { kind: "episode", seriesId: String(episode.seriesId), season: Number(episode.seasonNumber), episode: Number(episode.number) }
      : { kind: "none" };
  } catch (error) {
    if (error?.status !== 404) throw error;
    details = { kind: "none" };
  }
  seriesSetStmt.run({
    id: `episode_kind_${id}`,
    tvdb_id: details.seriesId || "",
    title: "",
    details: toJson(details),
    updated_at_ms: Date.now(),
  });
  return details;
}

export async function resolveTvdbSeriesId({ tvdbId = "", title = "", lane = "enrichment", missTtlMs = SEARCH_MISS_TTL_MS } = {}) {
  const cleanedId = normalizeTvdbId(tvdbId);
  if (cleanedId) return cleanedId;

  const cleanedTitle = String(title || "").trim();
  if (!cleanedTitle) return "";

  const cacheKey = `search_${hash(canonicalTitle(cleanedTitle))}`;
  const cached = seriesGetStmt.get(cacheKey);
  if (cached && fresh(cached.updated_at_ms, cached.tvdb_id ? SEARCH_TTL_MS : missTtlMs)) {
    const details = parseJson(cached.details);
    if (details?.match_schema_version === SEARCH_MATCH_SCHEMA_VERSION) {
      return details?.tvdb_id ? String(details.tvdb_id) : "";
    }
  }

  try {
    const results = await upstream("search", { query: cleanedTitle, type: "series" }, 0, { lane });
    const best = selectTvdbSeriesMatch(results, cleanedTitle);
    const resolvedId = best?.tvdb_id || "";
    seriesSetStmt.run({
      id: cacheKey,
      tvdb_id: resolvedId,
      title: cleanedTitle,
      details: toJson({
        tvdb_id: resolvedId,
        matched_name: best?.name || "",
        match_schema_version: SEARCH_MATCH_SCHEMA_VERSION,
      }),
      updated_at_ms: Date.now(),
    });
    return resolvedId;
  } catch {
    return "";
  }
}

// Search result lists are cached because search now runs on every query rather
// than only as a last resort, and the project key's rate pool is shared by every
// Plembfin install. The TTL is far shorter than the single-series search cache:
// a list has to pick up newly added series, where a resolved id does not change.
const SEARCH_LIST_TTL_MS = 7 * DAY_MS;
const SEARCH_LIST_MISS_TTL_MS = 60 * 60 * 1000;

export async function searchTvdbSeriesList(query) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return [];
  const cacheKey = `searchlist_v${SEARCH_LIST_SCHEMA_VERSION}_${hash(canonicalTitle(cleaned))}`;
  return collapse(cacheKey, async () => {
    const row = seriesGetStmt.get(cacheKey);
    const cachedResults = row ? parseJson(row.details)?.results : null;
    if (Array.isArray(cachedResults)) {
      const ttl = cachedResults.length ? SEARCH_LIST_TTL_MS : SEARCH_LIST_MISS_TTL_MS;
      if (fresh(row.updated_at_ms, ttl)) return cachedResults;
    }
    let results;
    try {
      results = await upstream("search", { query: cleaned, type: "series" });
    } catch (error) {
      // A rate limit or outage falls back to whatever was cached rather than
      // removing TVDB series from search results entirely.
      if (Array.isArray(cachedResults)) return cachedResults;
      throw error;
    }
    const shaped = (Array.isArray(results) ? results : []).slice(0, 10).map((item) => ({
      tvdb_id: normalizeTvdbId(item.tvdb_id || item.id),
      name: preferredSearchName(item) || "Unknown",
      year: item.year || (item.first_air_time || "").slice(0, 4) || "",
      image_url: item.image_url || item.thumbnail || "",
    })).filter((item) => item.tvdb_id);
    seriesSetStmt.run({ id: cacheKey, tvdb_id: "", title: cleaned, details: toJson({ results: shaped }), updated_at_ms: Date.now() });
    return shaped;
  });
}

const ARTWORK_TYPES_TTL_MS = 30 * DAY_MS;
let artworkTypesPromise = null;
let artworkTypesCachedAt = 0;

// Series artwork type ids aren't stable/documented constants - they're resolved
// dynamically from /artwork/types (cached in-memory) and matched by `name` (not
// `slug` - TVDB's slugs are inconsistently pluralized, e.g. "posters"/"backgrounds"
// vs singular "clearlogo"/"clearart", while `name` is a consistent singular label).
async function getSeriesArtworkTypeIds() {
  if (artworkTypesPromise && fresh(artworkTypesCachedAt, ARTWORK_TYPES_TTL_MS)) return artworkTypesPromise;
  artworkTypesCachedAt = Date.now();
  artworkTypesPromise = upstream("artwork-types", {})
    .then((types) => {
      const byName = {};
      for (const t of Array.isArray(types) ? types : []) {
        if (String(t.recordType || "").toLowerCase() !== "series") continue;
        const name = String(t.name || "").toLowerCase();
        if (name) byName[name] = Number(t.id);
      }
      return byName;
    })
    .catch(() => ({}));
  return artworkTypesPromise;
}

export async function getTvdbSeriesArtwork(tvdbId) {
  const id = normalizeTvdbId(tvdbId);
  if (!id) return { posters: [], logos: [], backdrops: [] };
  const byName = await getSeriesArtworkTypeIds();
  const typeIds = [byName.poster, byName.background, byName.clearlogo].filter((v) => Number.isFinite(v));
  try {
    const data = await upstream({ type: "series-artworks", id }, typeIds.length ? { type: typeIds.join(",") } : {});
    const posters = [], logos = [], backdrops = [];
    for (const art of Array.isArray(data?.artworks) ? data.artworks : []) {
      const url = String(art.image || "");
      if (!url) continue;
      const entry = { url, lang: art.language || "", source: "TVDB" };
      const type = Number(art.type);
      if (type === byName.poster) posters.push(entry);
      else if (type === byName.background) backdrops.push(entry);
      else if (type === byName.clearlogo) logos.push(entry);
    }
    return { posters, logos, backdrops };
  } catch {
    return { posters: [], logos: [], backdrops: [] };
  }
}

export async function getTvdbSeriesExtended(tvdbId, { force = false, lane = "enrichment" } = {}) {
  const id = normalizeTvdbId(tvdbId);
  if (!id) return null;
  return collapse(`series:${id}`, async () => {
    const cacheId = `series_${id}`;
    const row = seriesGetStmt.get(cacheId);
    const cached = row ? { details: parseJson(row.details), updatedAtMs: row.updated_at_ms } : null;
    // Require `episodes` in the cached payload so rows cached before the
    // meta switch below (which lacked per-season episode counts) are refetched.
    if (!force && cached?.details && Array.isArray(cached.details.episodes) && fresh(cached.updatedAtMs, seriesCacheTtl(cached.details))) return cached.details;
    try {
      const fetched = await upstream({ type: "series-extended", id }, { meta: "episodes" }, 0, { lane });
      // A forced refresh of the structural record should not discard a still
      // useful English synopsis cached beside it. The overview has its own TTL.
      const details = cached?.details?._plektEnglishOverview
        ? { ...fetched, _plektEnglishOverview: cached.details._plektEnglishOverview }
        : fetched;
      seriesSetStmt.run({ id: cacheId, tvdb_id: id, title: details?.name || "", details: toJson(details), updated_at_ms: Date.now() });
      return details;
    } catch (error) {
      if (cached?.details) return cached.details;
      throw error;
    }
  });
}

// TVDB's extended series request follows its default language. The dedicated
// translation endpoint supplies an English overview when one exists; store its
// small cache record in the series row so Fix Match and cache-clear paths keep
// their existing identity and invalidation behavior.
export async function getTvdbEnglishSeriesOverview(tvdbId, { force = false, lane = "enrichment" } = {}) {
  const id = normalizeTvdbId(tvdbId);
  if (!id) return "";
  return collapse(`series-english-overview:${id}`, async () => {
    const cacheId = `series_${id}`;
    const row = seriesGetStmt.get(cacheId);
    if (!row?.details) return { overview: "", status: "error", checkedAtMs: Date.now() };
    const details = parseJson(row.details) || {};
    const cached = details._plektEnglishOverview;
    const ttl = cached?.status === "error" ? SERIES_ENGLISH_OVERVIEW_ERROR_TTL_MS : SERIES_ENGLISH_OVERVIEW_TTL_MS;
    if (!force && cached && fresh(cached.checkedAtMs, ttl)) {
      return { overview: String(cached.overview || ""), status: cached.status, checkedAtMs: Number(cached.checkedAtMs) || 0 };
    }

    let next;
    try {
      const translation = await upstream({ type: "series-translation", id, language: "eng" }, {}, 0, { lane });
      const overview = String(translation?.overview || "").trim();
      next = { overview, status: overview ? "available" : "missing", checkedAtMs: Date.now() };
    } catch (error) {
      next = {
        // Keep a prior English synopsis usable during a temporary TVDB outage.
        overview: String(cached?.overview || "").trim(),
        status: Number(error?.status) === 404 ? "missing" : "error",
        checkedAtMs: Date.now(),
      };
    }

    seriesSetStmt.run({
      id: cacheId,
      tvdb_id: id,
      title: row.title || details.name || "",
      details: toJson({ ...details, _plektEnglishOverview: next }),
      // Translation refreshes must not make an old structural series row look
      // new; its normal 14/180-day TTL remains tied to the extended response.
      updated_at_ms: row.updated_at_ms,
    });
    return next;
  });
}

function pickSeasonId(extended, seasonNumber) {
  const seasons = Array.isArray(extended?.seasons) ? extended.seasons : [];
  const number = Number(seasonNumber);
  const official = seasons.find((season) => Number(season.number) === number && (season.type?.type === "official" || season.type?.name === "Aired Order"));
  return official || seasons.find((season) => Number(season.number) === number) || null;
}

function absoluteTvdbArtworkUrl(value) {
  const image = String(value || "");
  return image.startsWith("/") ? `https://artworks.thetvdb.com${image}` : image;
}

// The series payload (meta=episodes) already carries every season's episodes,
// so a cold show costs one throttled TVDB call instead of one per season. The
// derived row keeps the series fetch time so it is never fresher than its
// source; a series row older than the season's TTL is refetched once first.
// Seasons absent from the payload still use the season-extended endpoint.
function seasonFromSeriesEpisodes(id, extended, number) {
  const episodes = (Array.isArray(extended?.episodes) ? extended.episodes : [])
    .filter((episode) => Number(episode.seasonNumber) === number)
    .map((episode) => ({ ...episode, image: absoluteTvdbArtworkUrl(episode.image) }));
  if (!episodes.length) return null;
  const details = { episodes };
  const updatedAtMs = Number(seriesGetStmt.get(`series_${id}`)?.updated_at_ms) || 0;
  return { details, updatedAtMs, fresh: fresh(updatedAtMs, seasonCacheTtl(details)) };
}

export async function getTvdbSeasonEpisodes({ tvdbId, seasonNumber, lane = "enrichment" }) {
  const id = normalizeTvdbId(tvdbId);
  const number = Number(seasonNumber);
  if (!id || !Number.isInteger(number) || number < 0) {
    const error = new Error("tvdbId and a valid seasonNumber are required");
    error.status = 400;
    throw error;
  }
  return collapse(`season:${id}:${number}`, async () => {
    const cacheId = `${id}_${number}`;
    const row = seasonGetStmt.get(cacheId);
    const cached = row ? { details: parseJson(row.details), updatedAtMs: row.updated_at_ms } : null;
    if (cached?.details && fresh(cached.updatedAtMs, seasonCacheTtl(cached.details))) return shapeEpisodes(cached.details);
    try {
      let extended = await getTvdbSeriesExtended(id, { lane });
      let fromSeries = seasonFromSeriesEpisodes(id, extended, number);
      if (fromSeries && !fromSeries.fresh) {
        extended = await getTvdbSeriesExtended(id, { force: true, lane });
        fromSeries = seasonFromSeriesEpisodes(id, extended, number);
      }
      if (fromSeries?.fresh) {
        seasonSetStmt.run({ id: cacheId, tvdb_id: id, season_number: number, details: toJson(fromSeries.details), updated_at_ms: fromSeries.updatedAtMs });
        return shapeEpisodes(fromSeries.details);
      }
      const season = pickSeasonId(extended, number);
      if (!season?.id) {
        if (cached?.details) return shapeEpisodes(cached.details);
        return { episodes: [] };
      }
      const seasonDetails = await upstream({ type: "season-extended", id: season.id }, {}, 0, { lane });
      seasonSetStmt.run({ id: cacheId, tvdb_id: id, season_number: number, details: toJson(seasonDetails), updated_at_ms: Date.now() });
      return shapeEpisodes(seasonDetails);
    } catch (error) {
      if (cached?.details) return shapeEpisodes(cached.details);
      throw error;
    }
  });
}

// Up Next is a read path and must not turn a dashboard render into a provider
// fan-out. Return whatever season data is already in SQLite, including a stale
// row; the normal metadata warm-up path is responsible for refreshing it.
export function getCachedTvdbSeasonEpisodes({ tvdbId, seasonNumber }) {
  const id = normalizeTvdbId(tvdbId);
  const number = Number(seasonNumber);
  if (!id || !Number.isInteger(number) || number < 0) return null;
  const row = seasonGetStmt.get(`${id}_${number}`);
  const details = row ? parseJson(row.details) : null;
  return details && typeof details === "object" ? shapeEpisodes(details) : null;
}

// Every season's episode list from one series payload (meta=episodes), in the
// shape the season readers return. Used to pair TVDB and TMDB numbering.
export function tvdbSeasonListsFromExtended(extended) {
  const bySeason = new Map();
  for (const episode of Array.isArray(extended?.episodes) ? extended.episodes : []) {
    const season = Number(episode.seasonNumber);
    if (!Number.isInteger(season) || season < 0) continue;
    if (!bySeason.has(season)) bySeason.set(season, []);
    bySeason.get(season).push({ episode_number: episode.number, air_date: episode.aired || "" });
  }
  return [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, episodes }));
}

function shapeEpisodes(seasonDetails) {
  const episodes = Array.isArray(seasonDetails?.episodes) ? seasonDetails.episodes : [];
  return {
    episodes: episodes.map((episode) => ({
      episode_number: episode.number,
      name: episode.name || "",
      overview: episode.overview || "",
      air_date: episode.aired || "",
      still_path: episode.image || "",
      runtime: episode.runtime ?? null,
    })),
  };
}

function bestRemoteId(remoteIds, sourceNames) {
  const list = Array.isArray(remoteIds) ? remoteIds : [];
  // TVDB's actual sourceName values are inconsistent ("TheMovieDB.com", "IMDB", etc.)
  // and undocumented - match by prefix rather than exact string.
  const match = list.find((entry) => sourceNames.some((name) => String(entry.sourceName || "").toLowerCase().startsWith(name.toLowerCase())));
  return match ? String(match.id || "") : "";
}

export function shapeTvdbSeriesAsTmdb(extended, { englishOverview = "" } = {}) {
  if (!extended) return null;
  const episodeCounts = new Map();
  for (const episode of Array.isArray(extended.episodes) ? extended.episodes : []) {
    const seasonNumber = Number(episode.seasonNumber);
    if (!Number.isFinite(seasonNumber)) continue;
    episodeCounts.set(seasonNumber, (episodeCounts.get(seasonNumber) || 0) + 1);
  }
  const seasons = (Array.isArray(extended.seasons) ? extended.seasons : [])
    .filter((season) => (season.type?.type === "official" || season.type?.name === "Aired Order") && Number(season.number) >= 0)
    // TVDB sometimes carries an empty "Specials" placeholder (season 0) with no
    // episodes attached - unlike a not-yet-aired regular season, an empty Specials
    // entry has nothing to browse, so drop it rather than show a dead accordion row.
    .filter((season) => Number(season.number) > 0 || episodeCounts.has(0))
    .map((season) => ({
      season_number: season.number,
      episode_count: episodeCounts.get(Number(season.number)) ?? null,
      name: season.name || (season.number === 0 ? "Specials" : `Season ${season.number}`),
      poster_path: season.image || null,
    }));

  const tmdbId = bestRemoteId(extended.remoteIds, ["TheMovieDB"]);
  const imdbId = bestRemoteId(extended.remoteIds, ["IMDB"]);
  // Specials (season 0) stay in `seasons` so they're still browsable, but don't
  // count toward the show's episode/season totals used for watched-progress.
  const regularSeasons = seasons.filter((season) => Number(season.season_number) > 0);
  const numberOfEpisodes = regularSeasons.reduce((sum, season) => sum + (Number(season.episode_count) || 0), 0);

  return {
    name: extended.name || "",
    overview: String(englishOverview || "").trim() || extended.overview || "",
    first_air_date: extended.firstAired || "",
    status: extended.status?.name || "",
    genres: (extended.genres || []).map((genre) => ({ id: genre.id, name: genre.name })),
    networks: extended.originalNetwork ? [{ id: extended.originalNetwork.id, name: extended.originalNetwork.name }] : [],
    seasons,
    number_of_episodes: numberOfEpisodes,
    number_of_seasons: regularSeasons.length,
    tvdb_poster_url: extended.image || null,
    external_ids: {
      tvdb_id: String(extended.id || ""),
      imdb_id: imdbId,
      tmdb_id: tmdbId,
    },
  };
}
