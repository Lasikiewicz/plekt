import { fetchWithTimeout } from "./outbound.js";
import { compoundEpisodeItemsForMedia } from "./compoundEpisode.js";
import { restoreLookupKey } from "./restoreLookupCache.js";
import { nativeProviderItemIds } from "./providerItemIds.js";
import { canonicalPlayedDateIso } from "./watchSyncPolicy.js";
import { traceLog } from "./logVerbose.js";
import { ratingSnapshotPage } from "./ratingSnapshotSafety.js";
function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requireEmbyConfig(config = {}) {
  if (!config.baseUrl || !config.apiKey || !config.userId) {
    throw new Error("Missing Emby baseUrl, apiKey, or userId");
  }
}

function authHeaders(config) {
  return {
    Accept: "application/json",
    "X-Emby-Token": config.apiKey,
  };
}

export function embyResumeLastPlayedDate(media = {}, now = Date.now()) {
  const sourceValue = media.updatedAt ?? media.updated_at ?? media.progressUpdatedAt ?? media.playedAt;
  const numericValue = sourceValue === "" || sourceValue == null ? NaN : Number(sourceValue);
  const sourceTime = Number.isFinite(numericValue)
    ? numericValue
    : Date.parse(String(sourceValue || ""));
  const fallbackTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return new Date(Number.isFinite(sourceTime) && sourceTime > 0 ? sourceTime : fallbackTime).toISOString();
}

// Emby's mark-played endpoint takes the play date as a `DatePlayed` query
// parameter in compact UTC form (yyyyMMddHHmmss). This is the only supported
// way to preserve an original play date through a watched-state write, so
// imports, restores, and backdated manual marks all travel through it - unlike
// Plex, Emby does not have to record an imported watch as happening today.
export function embyDatePlayedParam(media = {}) {
  const iso = canonicalPlayedDateIso(media);
  if (!iso) return "";
  return iso.slice(0, 19).replace(/[-:T]/g, "");
}

function providerTerms(ids = {}) {
  return [
    ids.imdb ? `imdb.${ids.imdb}` : undefined,
    ids.tmdb ? `tmdb.${ids.tmdb}` : undefined,
    ids.tvdb ? `tvdb.${ids.tvdb}` : undefined,
  ].filter(Boolean);
}

async function fetchJson(url, config, media = null) {
  const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane: media?.lane || "sync" });
  if (!response.ok) {
    const error = new Error(`Emby request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchPagedFeed(config, buildUrl, limit = 0, { pageSize: preferredPageSize = 100 } = {}) {
  const requestedLimit = Number(limit) > 0 ? Math.max(1, Math.round(Number(limit))) : 0;
  const maximumPageSize = Math.min(Math.max(1, Math.round(Number(preferredPageSize) || 100)), 500);
  const pageSize = requestedLimit ? Math.min(requestedLimit, maximumPageSize) : maximumPageSize;
  const items = [];
  const seen = new Set();
  for (let start = 0; start <= 10_000_000;) {
    const data = await fetchJson(buildUrl(start, pageSize), config);
    const page = Array.isArray(data?.Items) ? data.Items : [];
    let newItems = 0;
    for (const item of page) {
      const id = String(item?.Id || item?.id || "").trim();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      items.push(item);
      newItems++;
      if (requestedLimit && items.length >= requestedLimit) return items.slice(0, requestedLimit);
    }
    const total = Number(data?.TotalRecordCount || 0);
    if (!page.length || !newItems || (total > 0 && start + page.length >= total) || (total <= 0 && page.length < pageSize)) break;
    // Some Emby-compatible servers cap Limit below the requested size. Move
    // by the response length so a server-side cap cannot skip a range.
    start += page.length;
  }
  return requestedLimit ? items.slice(0, requestedLimit) : items;
}

function nativeEmbyItems(media = {}) {
  return nativeProviderItemIds(media, "emby").map((Id) => ({ Id }));
}

async function findEmbyItemsForMutation(config, media = {}) {
  const direct = nativeEmbyItems(media);
  if (direct.length) return direct;
  const cache = media?.restoreLookupCache;
  const items = cache && typeof cache.resolve === "function"
    ? await cache.resolve(
      restoreLookupKey("emby", config, media),
      media,
      () => findEmbyItems(config, media),
    )
    : await findEmbyItems(config, media);
  if (items?.length || media.type !== "episode" || media.__identityRetry) return items || [];

  // A cached series episode list can predate an item added or reindexed in
  // Emby. Refresh once on an exact episode miss before reporting not_found.
  traceLog("Emby episode lookup missed; refreshing the cached series index", {
    title: media.title,
    season: media.season,
    episode: media.episode,
  });
  invalidateEmbySeriesIdentity(config, media);
  return findEmbyItemsForMutation(config, { ...media, __identityRetry: true });
}

function noMatchingLibraryItem(platform, media = {}) {
  return {
    platform,
    status: "not_found",
    detail: media.type === "episode"
      ? "No matching episode was found after refreshing the series episode list"
      : "No matching item found",
  };
}

function extractYear(title) {
  const match = String(title || "").match(/\((\d{4})\)/);
  return match ? Number(match[1]) : undefined;
}

function titleMatches(a, b) {
  const clean = (s) => String(s || "").toLowerCase().replace(/\(\d{4}\)/g, "").trim().replace(/[^a-z0-9]/g, "");
  return clean(a) === clean(b);
}

function yearMatches(dbTitle, resultYear) {
  const dbYear = extractYear(dbTitle);
  if (!dbYear || !resultYear) return true;
  return Number(dbYear) === Number(resultYear);
}

// The title search runs only after no library series carried any requested id,
// so a title match whose own TMDB or TVDB id differs from the request's show
// id is a different show with the same name (the UK and Australian "The
// Assembly"). Only explicit show ids are compared: a watch record's plain ids
// can be the episode's own.
function seriesIdsConflict(media = {}, providerIds = {}) {
  return [["tmdb", "Tmdb"], ["tvdb", "Tvdb"]].some(([key, field]) => {
    const wanted = String(media?.[`show_${key}_id`] || "").trim().toLowerCase();
    const actual = String(providerIds?.[field] || "").trim().toLowerCase();
    return Boolean(wanted && actual && wanted !== actual);
  });
}

// Two title matches whose provider ids or years disagree are two different
// shows or films of the same name ("Scrubs" 2001 and its 2026 revival, which
// Emby names "Scrubs (2026)" and Jellyfin names plain "Scrubs"). With no year
// or show id to choose between them, writing to every match marked the other
// show too, so the title match is refused instead (decision 40). Matches that
// agree, such as one series in two libraries, still all count.
function titleMatchNamesSeveralItems(items = []) {
  const differ = (a, b) => Boolean(a && b && a !== b);
  const identity = (item) => {
    const ids = {};
    for (const [key, value] of Object.entries(item?.ProviderIds || {})) ids[key.toLowerCase()] = String(value || "").trim().toLowerCase();
    return { ids, year: Number(item?.ProductionYear) || 0 };
  };
  const identities = items.map(identity);
  return identities.some((left, index) => identities.slice(index + 1).some((right) =>
    differ(left.year, right.year) || ["imdb", "tmdb", "tvdb"].some((key) => differ(left.ids[key], right.ids[key]))
  ));
}

function parseShowTitle(title) {
  const str = String(title || "");
  const regex = /(?:\s*-\s*|\s+)S(\d+)E(\d+)/i;
  const match = str.match(regex);
  if (match) {
    const cleanTitle = str.slice(0, match.index).replace(/\s*-\s*$/, "").trim();
    return {
      title: cleanTitle,
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }
  const cleanTitle = str.replace(/\s*-\s*$/, "").trim();
  return {
    title: cleanTitle,
    season: undefined,
    episode: undefined
  };
}

const SERIES_CACHE_TTL_MS = 10 * 60 * 1000;
const SERIES_CACHE_MAX_ENTRIES = 100;
const embySeriesCache = new Map();
const embySeriesInFlight = new Map();
let embyCacheNow = () => Date.now();

function mediaIdentitiesCompatible(left = {}, right = {}) {
  return ["imdb", "tmdb", "tvdb"].every((provider) => {
    const a = String(left?.ids?.[provider] || "").trim().toLowerCase();
    const b = String(right?.ids?.[provider] || "").trim().toLowerCase();
    return !a || !b || a === b;
  });
}

function normalizedShowTitle(media = {}) {
  return parseShowTitle(media.title).title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function embySeriesAliases(config, media) {
  const scope = `emby|${trimTrailingSlash(config.baseUrl).toLowerCase()}|${String(config.userId).toLowerCase()}`;
  const aliases = providerTerms(media.ids).map((term) => `${scope}|${term.toLowerCase()}`);
  const year = extractYear(media.title);
  const title = normalizedShowTitle(media);
  if (title) aliases.push(`${scope}|title:${title}${year ? `|year:${year}` : ""}`);
  return [...new Set(aliases)];
}

function embyEntryCompatible(entry, media) {
  if (!entry.series.length) return true;
  const requested = media.ids || {};
  if (!requested.imdb && !requested.tmdb && !requested.tvdb) return true;
  return entry.series.some((item) => {
    const ids = item.ProviderIds || {};
    return (!requested.imdb || !ids.Imdb || String(requested.imdb).toLowerCase() === String(ids.Imdb).toLowerCase())
      && (!requested.tmdb || !ids.Tmdb || String(requested.tmdb).toLowerCase() === String(ids.Tmdb).toLowerCase())
      && (!requested.tvdb || !ids.Tvdb || String(requested.tvdb).toLowerCase() === String(ids.Tvdb).toLowerCase());
  });
}

function deleteEmbyEntry(entry) {
  for (const [alias, value] of embySeriesCache) if (value === entry) embySeriesCache.delete(alias);
}

function getCachedEmbyEntry(aliases, media) {
  const now = embyCacheNow();
  for (const alias of aliases) {
    const entry = embySeriesCache.get(alias);
    if (!entry) continue;
    if (entry.expiresAt <= now) { deleteEmbyEntry(entry); continue; }
    if (embyEntryCompatible(entry, media)) return entry;
  }
  return null;
}

function storeEmbyEntry(entry, aliases) {
  for (const alias of aliases) embySeriesCache.set(alias, entry);
  const entries = [...new Set(embySeriesCache.values())].sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length > SERIES_CACHE_MAX_ENTRIES) deleteEmbyEntry(entries.shift());
}

async function resolveEmbySeriesIdentity(config, media) {
  const aliases = embySeriesAliases(config, media);
  // Title fallback must participate in the in-flight map too. Provider IDs
  // are often present in imported history even when that server cannot resolve
  // them; excluding the title alias made every sibling episode launch its own
  // slow title search during a restore. Pending requests still carry their
  // media identity so two conflicting remakes do not share work.
  const inFlightAliases = aliases;
  const cached = getCachedEmbyEntry(aliases, media);
  if (cached) return cached;
  for (const alias of inFlightAliases) {
    const pending = embySeriesInFlight.get(alias);
    if (pending && mediaIdentitiesCompatible(pending.media, media)) return pending.promise;
  }

  const promise = (async () => {
    let series = [];
    try { series = await findByProviderIds(config, media, "Series"); } catch (error) {
      console.error("Emby provider discovery failed; trying title fallback", error);
    }
    if (!series.length) series = await searchEmbyFallback(config, media, "Series");
    if (!series.length) {
      const now = embyCacheNow();
      const empty = { series: [], episodesByCoordinate: new Map(), expiresAt: now + 20_000, createdAt: now };
      storeEmbyEntry(empty, aliases);
      return empty;
    }
    const settled = await Promise.allSettled(series.map((item) => fetchEmbyEpisodes(config, item.Id, media)));
    const episodes = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!episodes.length && settled.every((result) => result.status === "rejected")) throw settled[0].reason;
    const episodesByCoordinate = new Map();
    for (const item of episodes) {
      const key = `${Number(item.ParentIndexNumber)}:${Number(item.IndexNumber)}`;
      if (!episodesByCoordinate.has(key)) episodesByCoordinate.set(key, []);
      episodesByCoordinate.get(key).push(item);
    }
    const now = embyCacheNow();
    const entry = { series, episodesByCoordinate, expiresAt: now + SERIES_CACHE_TTL_MS, createdAt: now };
    const discoveredAliases = [...aliases];
    for (const item of series) {
      const ids = item.ProviderIds || {};
      discoveredAliases.push(...embySeriesAliases(config, { ...media, ids: { imdb: ids.Imdb, tmdb: ids.Tmdb, tvdb: ids.Tvdb } }));
    }
    storeEmbyEntry(entry, [...new Set(discoveredAliases)]);
    return entry;
  })();
  const pendingEntry = { media, promise };
  for (const alias of inFlightAliases) embySeriesInFlight.set(alias, pendingEntry);
  try { return await promise; } finally {
    for (const [alias, pending] of embySeriesInFlight) if (pending === pendingEntry) embySeriesInFlight.delete(alias);
  }
}

export function __resetEmbySeriesCache() {
  embySeriesCache.clear();
  embySeriesInFlight.clear();
  embyCacheNow = () => Date.now();
}

export function __setEmbySeriesCacheNow(fn) {
  embyCacheNow = typeof fn === "function" ? fn : () => Date.now();
}

function invalidateEmbySeriesIdentity(config, media) {
  for (const alias of embySeriesAliases(config, media)) {
    const entry = embySeriesCache.get(alias);
    if (entry) deleteEmbyEntry(entry);
  }
  media?.restoreLookupCache?.delete?.(restoreLookupKey("emby", config, media));
}

async function searchEmbyFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "Series" || targetType === "show") ? parsed.title : media.title;

  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", targetType);
  // The year is left out of the search and checked against ProductionYear
  // instead; without that field Emby omits the year, so "Scrubs (2026)" also
  // matched the 2001 series.
  url.searchParams.set("SearchTerm", queryTitle.replace(/\s*\(\d{4}\)\s*$/, ""));
  url.searchParams.set("Fields", "ProviderIds,UserData,ProductionYear");
  url.searchParams.set("api_key", config.apiKey);

  traceLog("Emby search fallback started", { query: queryTitle, targetType });
  try {
    const body = await fetchJson(url, config, media);
    const results = body?.Items || [];

    const matched = results.filter((item) => {
      if (!titleMatches(queryTitle, item.Name)) return false;
      if (!yearMatches(media.title, item.ProductionYear)) return false;
      if (targetType === "Series" && seriesIdsConflict(media, item.ProviderIds)) return false;
      return true;
    });

    if (titleMatchNamesSeveralItems(matched)) {
      traceLog("Emby search fallback refused an ambiguous title", { query: queryTitle, targetType, itemIds: matched.map(i => i.Id) });
      return [];
    }
    if (matched.length > 0) {
      traceLog("Emby search fallback matched items", { count: matched.length, itemIds: matched.map(i => i.Id) });
      return matched;
    }
  } catch (error) {
    console.error("Emby search fallback failed", error);
    throw error;
  }
  return [];
}

async function findByProviderIds(config, media, itemTypes) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const allMatched = new Map();
  const terms = providerTerms(media.ids);
  const lookups = terms.map(async (providerTerm) => {
    const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", itemTypes);
    url.searchParams.set("Fields", "ProviderIds,UserData");
    url.searchParams.set("AnyProviderIdEquals", providerTerm);
    url.searchParams.set("api_key", config.apiKey);

    traceLog("Emby lookup started", { itemTypes, providerTerm });
    const body = await fetchJson(url, config, media);
      const [prov, val] = providerTerm.split(".");
      const providerKey = prov.charAt(0).toUpperCase() + prov.slice(1);

      const items = body?.Items?.filter((it) => {
        const pIds = it.ProviderIds || {};
        return String(pIds[providerKey] || "").toLowerCase() === String(val).toLowerCase();
      }) || [];

    return { providerTerm, items };
  });
  const settled = await Promise.allSettled(lookups);
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("Emby lookup failed for providerTerm: %s", terms[index], result.reason);
      return;
    }
    for (const item of result.value.items) {
      if (item?.Id) allMatched.set(item.Id, item);
    }
  });
  if (terms.length && settled.every((result) => result.status === "rejected")) {
    throw settled[0].reason;
  }

  const results = Array.from(allMatched.values());
  if (results.length > 0) {
    traceLog("Emby lookup matched items", { count: results.length, itemIds: results.map(i => i.Id) });
    return results;
  }

  return [];
}

async function findEpisode(config, media) {
  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;
  const entry = await resolveEmbySeriesIdentity(config, media);
  return compoundEpisodeItemsForMedia(entry.episodesByCoordinate, {
    ...media,
    season,
    episode: episodeNum,
  });
}

export function embyEpisodeMatchesCoordinates(item = {}, season, episode) {
  return Number(item.ParentIndexNumber) === Number(season) && Number(item.IndexNumber) === Number(episode);
}

export async function findEmbyItems(config, media) {
  const direct = nativeEmbyItems(media);
  if (direct.length) return direct;
  if (media.type === "movie") {
    let movies = await findByProviderIds(config, media, "Movie");
    if (!movies || movies.length === 0) {
      movies = await searchEmbyFallback(config, media, "Movie");
    }
    return movies;
  }
  if (media.type === "tv" || media.type === "series" || media.type === "show") {
    let series = await findByProviderIds(config, media, "Series");
    if (!series || series.length === 0) {
      series = await searchEmbyFallback(config, media, "Series");
    }
    return series;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return [];
}

export async function markEmbyPlayed(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return noMatchingLibraryItem("emby", media);
    }

    const datePlayed = embyDatePlayedParam(media);
    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const buildUrl = (withDate) => {
        const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
        url.searchParams.set("api_key", config.apiKey);
        if (withDate && datePlayed) url.searchParams.set("DatePlayed", datePlayed);
        return url;
      };

      let response = await fetchWithTimeout(buildUrl(true), {
        method: "POST",
        headers: authHeaders(config),
        lane: media?.lane || "sync",
      });
      // Emby versions that predate DatePlayed, or parse it differently, answer
      // with a 4xx rather than ignoring the parameter. The watched state is the
      // part that must land, so fall back to the plain mark-played request
      // instead of failing the whole sync over the date. A 404 is left alone -
      // that is a missing item, and the caller's identity-retry owns it.
      if (!response.ok && datePlayed && response.status >= 400 && response.status < 500 && response.status !== 404) {
        console.log("Emby rejected DatePlayed; retrying mark played without the original date", { itemId: item.Id, status: response.status });
        response = await fetchWithTimeout(buildUrl(false), {
          method: "POST",
          headers: authHeaders(config),
          lane: media?.lane || "sync",
        });
      }
      if (!response.ok) {
        const error = new Error(`Emby mark played failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item marked played", { itemId: item.Id, datePlayed: datePlayed || "server time" });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return markEmbyPlayed(config, { ...media, __identityRetry: true });
    }
    console.error("Emby client failed", error);
    throw error;
  }
}

export async function markEmbyUnplayed(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return noMatchingLibraryItem("emby", media);
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
      url.searchParams.set("api_key", config.apiKey);

      const response = await fetchWithTimeout(url, {
        method: "DELETE",
        headers: authHeaders(config),
        lane: media?.lane || "sync",
      });
      if (!response.ok) {
        const error = new Error(`Emby mark unplayed failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item marked unplayed", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return markEmbyUnplayed(config, { ...media, __identityRetry: true });
    }
    console.error("Emby client failed", error);
    throw error;
  }
}

// Emby keeps a Hide from Resume flag through UserData writes, so a hidden item
// takes the position, stays resumable, and never returns to Continue Watching.
// The Up Next push then saw it missing from the Resume feed and rewrote it on
// every run. Hides are meant to last only until a new play (decisions.md entry
// 36), and a known resume position comes from one, so lift the flag. Best
// effort: a server without the endpoint keeps the plain position write.
async function showEmbyInResume(config, itemId, lane) {
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(itemId)}/HideFromResume`);
  url.searchParams.set("Hide", "false");
  try {
    const response = await fetchWithTimeout(url, { method: "POST", headers: authHeaders(config), lane });
    if (!response.ok) console.error("Emby resume unhide failed", { itemId, status: response.status });
  } catch (error) {
    console.error("Emby resume unhide failed", { itemId, error: error?.message || error });
  }
}

export async function setEmbyProgress(config, media) {
  try {
    requireEmbyConfig(config);

    const items = await findEmbyItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Emby library for: "${media.title}"`);
      return noMatchingLibraryItem("emby", media);
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    const hasPosition = media.positionMs !== undefined || media.offsetMs !== undefined;
    if (!hasPosition) {
      return { platform: "emby", status: "skipped", detail: "No resume position supplied" };
    }

    let lastHttpStatus = 200;
    const progressJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
      url.searchParams.set("api_key", config.apiKey);
      const userData = {
        PlaybackPositionTicks: positionMs * 10000,
        Played: false,
      };
      if (positionMs > 0) {
        // Emby's Resume feed is ordered by LastPlayedDate. A position without
        // that date works on the item detail page but can be absent from
        // Continue Watching, especially when the feed is limited to recent
        // items. Preserve the source progress time instead of making a replay
        // look like fresh playback; position clears deliberately omit it.
        userData.LastPlayedDate = embyResumeLastPlayedDate(media);
      }

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "Content-Type": "application/json",
        },
        lane: media?.lane || "sync",
        body: JSON.stringify(userData),
      });
      if (!response.ok) {
        const error = new Error(`Emby progress update failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Emby item resume progress updated", { itemId: item.Id, positionMs });
      if (positionMs > 0) await showEmbyInResume(config, item.Id, media?.lane || "sync");
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(progressJobs);
    return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), positionMs, httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateEmbySeriesIdentity(config, media);
      return setEmbyProgress(config, { ...media, __identityRetry: true });
    }
    console.error("Emby progress client failed", error);
    throw error;
  }
}

export async function fetchEmbyEpisodes(config, parentId, media = null) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("ParentId", parentId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  // UserDataLastPlayedDate: without it Emby omits UserData.LastPlayedDate, and
  // the native rail refresh re-marked each predecessor played with no date, so
  // Emby moved its watch date to the refresh time (defect K).
  url.searchParams.set("Fields", "ProviderIds,UserData,UserDataLastPlayedDate,PremiereDate,ProductionYear,MediaSources,MediaStreams,Width,Height");
  url.searchParams.set("api_key", config.apiKey);

  const data = await fetchJson(url, config, media);
  return data?.Items || [];
}

export async function fetchEmbySeriesEpisodes(config, media) {
  requireEmbyConfig(config);
  const { series } = await resolveEmbySeriesIdentity(config, media);
  if (!series.length) return [];

  // Callers use this API to inspect mutable UserData, so only the stable
  // native series identity is reused; episode state is always fetched fresh.
  const episodeGroups = await Promise.all(series.map((item) => fetchEmbyEpisodes(config, item.Id, media).catch(() => [])));
  return episodeGroups.flat();
}

// Mark unplayed directly by native item Id, skipping the search/match step. Used by the
// authoritative restore clear pass, which already has the Id from fetchEmbyWatchedItems.
export async function markEmbyUnplayedById(config, itemId, { lane = "sync" } = {}) {
  requireEmbyConfig(config);
  if (!itemId) return { platform: "emby", status: "not_found" };

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${itemId}`);
  url.searchParams.set("api_key", config.apiKey);

  const response = await fetchWithTimeout(url, { method: "DELETE", headers: authHeaders(config), lane });
  if (!response.ok) {
    throw new Error(`Emby mark unplayed failed with status ${response.status} for item ${itemId}`);
  }
  return { platform: "emby", status: "fulfilled", itemId, httpStatus: response.status };
}

export async function hideEmbyFromResume(config, itemId, { lane = "interactive" } = {}) {
  requireEmbyConfig(config);
  if (!itemId) return { platform: "emby", status: "not_found" };
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(itemId)}/HideFromResume`);
  url.searchParams.set("Hide", "true");
  const response = await fetchWithTimeout(url, { method: "POST", headers: authHeaders(config), lane });
  if (!response.ok) throw new Error(`Emby resume removal failed with status ${response.status} for item ${itemId}`);
  return { platform: "emby", status: "fulfilled", itemId: String(itemId), httpStatus: response.status };
}

function buildEmbyWatchedItemsUrl(config, { limit = 0, parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  url.searchParams.set("api_key", config.apiKey);
  return url;
}

export async function fetchEmbyWatchedItems(config, { limit = 0, libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    const data = await fetchJson(buildEmbyWatchedItemsUrl(config, { limit, parentId }), config);
    items.push(...(data?.Items || []));
  }
  return items;
}

function buildEmbyLibraryItemsUrl(config, { parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsUnplayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
  url.searchParams.set("EnableUserData", "true");
  url.searchParams.set("StartIndex", "0");
  url.searchParams.set("EnableTotalRecordCount", "true");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  url.searchParams.set("api_key", config.apiKey);
  return url;
}

// Full paginated unplayed inventory used by the scheduled availability
// reconciliation. A new duplicate/quality variant is normally unplayed on
// Emby even when Plembfin already knows that the same episode was watched.
export async function fetchEmbyLibraryItems(config, { limit = 0, libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    items.push(...await fetchPagedFeed(
      config,
      (start, pageSize) => {
        const url = buildEmbyLibraryItemsUrl(config, { parentId });
        url.searchParams.set("StartIndex", String(start));
        url.searchParams.set("Limit", String(pageSize));
        return url;
      },
      limit,
      { pageSize: 500 },
    ));
  }
  return items;
}

// User-visible libraries (views) with their stable ids, for sync scope selection.
export async function listEmbyLibraries(config) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Views`);
  url.searchParams.set("api_key", config.apiKey);
  const data = await fetchJson(url, config);
  return (data?.Items || [])
    .filter((item) => ["movies", "tvshows"].includes(String(item.CollectionType || "").toLowerCase()))
    .map((item) => ({
      id: String(item.Id),
      name: String(item.Name || item.Id),
      type: String(item.CollectionType || "").toLowerCase() === "movies" ? "movie" : "show",
    }));
}

// Cheap watched-item count via TotalRecordCount, for plan staleness checks.
export async function countEmbyWatchedItems(config, { libraryIds } = {}) {
  requireEmbyConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  let total = 0;
  for (const parentId of parents) {
    const url = buildEmbyWatchedItemsUrl(config, { limit: 1, parentId });
    const data = await fetchJson(url, config);
    total += Number(data?.TotalRecordCount ?? (data?.Items || []).length);
  }
  return total;
}

export async function fetchEmbyResumableItems(config, { limit = 0 } = {}) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const buildNativeResumeUrl = (start, pageSize) => {
    const url = new URL(`${baseUrl}/Users/${encodeURIComponent(config.userId)}/Items/Resume`);
    url.searchParams.set("Recursive", "true");
    // Emby exposes Continue Watching through the dedicated Resume endpoint.
    // The generic Items?Filters=IsResumable query returns an empty snapshot on
    // some Emby versions even while the native Continue Watching rail is full.
    url.searchParams.set("MediaTypes", "Video");
    // Emby omits UserData.LastPlayedDate here unless it is requested. Without
    // it the observation has no source time, so any explicit unwatch outranks
    // a genuinely newer part-watch (docs/decisions.md entry 35).
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,UserDataLastPlayedDate,PremiereDate,ProductionYear,RunTimeTicks");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("EnableTotalRecordCount", "true");
    url.searchParams.set("api_key", config.apiKey);
    return url;
  };

  const buildLegacyResumeUrl = (start, pageSize) => {
    const url = new URL(`${baseUrl}/Users/${encodeURIComponent(config.userId)}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("Filters", "IsResumable");
    url.searchParams.set("IncludeItemTypes", "Movie,Episode");
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,UserDataLastPlayedDate,PremiereDate,ProductionYear,RunTimeTicks");
    url.searchParams.set("SortBy", "DatePlayed");
    url.searchParams.set("SortOrder", "Descending");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("api_key", config.apiKey);
    return url;
  };

  try {
    const native = await fetchPagedFeed(config, buildNativeResumeUrl, limit);
    if (native.length) return native;
    // Both queries exist on modern Emby and either one can come back empty
    // depending on the server: the generic IsResumable filter returns nothing
    // on some versions while Continue Watching is full, and on others
    // /Items/Resume answers 200 with an empty list while IsResumable lists
    // every resumable item - including genuine part-watches with a position
    // over half an hour. An empty answer from one is therefore not evidence
    // that there is nothing to resume, so ask the other before believing it.
    return await fetchPagedFeed(config, buildLegacyResumeUrl, limit);
  } catch (error) {
    // A real auth/upstream failure must stay visible to the caller; only a
    // missing route falls through to the legacy query.
    if (Number(error?.status) !== 404) throw error;
    return fetchPagedFeed(config, buildLegacyResumeUrl, limit);
  }
}

export async function fetchEmbyNextUpItems(config, { limit = 0 } = {}) {
  requireEmbyConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  return fetchPagedFeed(config, (start, pageSize) => {
    const url = new URL(`${baseUrl}/Shows/NextUp`);
    url.searchParams.set("UserId", config.userId);
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear,RunTimeTicks,MediaSources");
    url.searchParams.set("EnableResumable", "true");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("api_key", config.apiKey);
    return url;
  }, limit);
}

// Keep the reserved device identity for the native rail refresh and for
// filtering callbacks during upgrades. Older builds used a short-lived
// synthetic playback session with a fake resume position; current pushes use
// the same client-facing index refresh at position zero, so no resume progress
// is created and the session is not treated as real playback.
export const UP_NEXT_SEED_DEVICE_ID = "plembfin-up-next-seed";
export function isUpNextSeedDeviceId(value = "") {
  return String(value ?? "").trim().toLowerCase() === UP_NEXT_SEED_DEVICE_ID;
}

const UP_NEXT_RAIL_AUTHORIZATION = `MediaBrowser Client="Plembfin", Device="Plembfin Up Next", DeviceId="${UP_NEXT_SEED_DEVICE_ID}", Version="1.0.0"`;

async function embyRailSessionReport(config, path, payload, { lane = "interactive" } = {}) {
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}${path}`);
  url.searchParams.set("api_key", config.apiKey);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "Content-Type": "application/json",
      "X-Emby-Authorization": UP_NEXT_RAIL_AUTHORIZATION,
    },
    lane,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = new Error(`Emby native rail refresh failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status;
}

// Emby's Continue Watching/Resume index is populated by its playback-session
// handlers, even when the item has no resume position. A zero-position,
// immediately stopped session makes that native index recalculate the ready
// episode after its predecessor is marked watched. The reserved device id is
// deliberately retained so the live-session poller and webhook path ignore
// this bookkeeping as playback. Each session raises Emby's PlayCount, so the
// item's play count, watched flag and position are written back afterwards,
// keeping the session's LastPlayedDate that places it on the rail.
async function fetchEmbyUserData(config, id, lane) {
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(id)}`);
  url.searchParams.set("Fields", "UserData");
  url.searchParams.set("api_key", config.apiKey);
  const item = await fetchJson(url, config, { lane });
  return item?.UserData || {};
}

export async function touchEmbyResumeRail(config, itemId, { lane = "interactive" } = {}) {
  requireEmbyConfig(config);
  const id = String(itemId || "").trim();
  if (!id) return { platform: "emby", status: "not_found" };

  const before = await fetchEmbyUserData(config, id, lane);
  const payload = {
    ItemId: id,
    MediaSourceId: id,
    PositionTicks: 0,
    IsPaused: true,
    CanSeek: true,
    PlayMethod: "DirectStream",
    PlaySessionId: `plembfin-up-next-refresh-${id}`,
  };
  await embyRailSessionReport(config, "/Sessions/Playing", payload, { lane });
  await embyRailSessionReport(config, "/Sessions/Playing/Progress", payload, { lane });
  await embyRailSessionReport(config, "/Sessions/Playing/Stopped", payload, { lane });
  const after = await fetchEmbyUserData(config, id, lane);
  const restoreUrl = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(id)}/UserData`);
  restoreUrl.searchParams.set("api_key", config.apiKey);
  const restored = await fetchWithTimeout(restoreUrl, {
    method: "POST",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    lane,
    body: JSON.stringify({
      PlayCount: Number(before.PlayCount || 0),
      Played: before.Played === true,
      PlaybackPositionTicks: Number(before.PlaybackPositionTicks || 0),
      ...(after.LastPlayedDate ? { LastPlayedDate: after.LastPlayedDate } : {}),
    }),
  });
  if (!restored.ok) {
    const error = new Error(`Emby rail refresh UserData restore failed with status ${restored.status}`);
    error.status = restored.status;
    throw error;
  }
  console.log("Emby native Continue Watching rail refreshed", { itemId: id });
  return { platform: "emby", status: "fulfilled", itemId: id, positionMs: 0 };
}

// Emby's Continue Watching index is populated by playback-session handlers,
// not by a UserData position alone. Report the short-lived, paused session and
// then restore the unplayed state at the exact seed position. The reserved
// device identity keeps this bookkeeping out of live-playback ingestion.
// Runtime for an item whose native id is already known. An item resolved
// straight from a stored provider id never passes through a search result that
// carries its runtime, so native-rail verification can fetch it here.
export async function fetchEmbyItemRuntimeMs(config, itemId) {
  requireEmbyConfig(config);
  const id = String(itemId || "").trim();
  if (!id) return 0;
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", config.apiKey);
  const item = await fetchJson(url, config);
  const ticks = Number(item?.RunTimeTicks || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

// ---------------------------------------------------------------------------
// Personal ratings
// ---------------------------------------------------------------------------

function embyProviderIds(item = {}) {
  const ids = item.ProviderIds || {};
  return {
    imdb: ids.Imdb || ids.imdb || "",
    tmdb: ids.Tmdb || ids.tmdb || "",
    tvdb: ids.Tvdb || ids.tvdb || "",
    emby: item.Id || "",
  };
}

function embyRatingRecord(item = {}) {
  const type = String(item.Type || item.type || "").toLowerCase();
  const isEpisode = type === "episode";
  const isShow = type === "series";
  const providerIds = embyProviderIds(item);
  const seriesIds = isEpisode ? {
    imdb: item.SeriesProviderIds?.Imdb || item.SeriesProviderIds?.imdb || "",
    tmdb: item.SeriesProviderIds?.Tmdb || item.SeriesProviderIds?.tmdb || "",
    tvdb: item.SeriesProviderIds?.Tvdb || item.SeriesProviderIds?.tvdb || "",
  } : providerIds;
  return {
    media: {
      media_type: isEpisode ? "episode" : isShow ? "tv" : "movie",
      title: String(item.Name || item.Title || "Untitled"),
      tmdb_id: seriesIds.tmdb || "",
      tvdb_id: seriesIds.tvdb || "",
      imdb_id: seriesIds.imdb || "",
      show_title: isEpisode ? String(item.SeriesName || item.SeriesName || "") : "",
      show_tmdb_id: isEpisode ? seriesIds.tmdb || "" : "",
      show_tvdb_id: isEpisode ? seriesIds.tvdb || "" : "",
      show_imdb_id: isEpisode ? seriesIds.imdb || "" : "",
      episode_tmdb_id: isEpisode ? providerIds.tmdb || "" : "",
      episode_tvdb_id: isEpisode ? providerIds.tvdb || "" : "",
      episode_imdb_id: isEpisode ? providerIds.imdb || "" : "",
      season: isEpisode ? Number(item.ParentIndexNumber) : null,
      episode: isEpisode ? Number(item.IndexNumber) : null,
      year: Number(item.ProductionYear || 0) || null,
      poster_url: "",
    },
    providerItemId: String(item.Id || ""),
    providerIds,
    rating: Number(item.UserData?.Rating),
    ratedAt: null,
  };
}

export async function fetchEmbyPersonalRatingSnapshot(config) {
  requireEmbyConfig(config);
  const records = [];
  const pageSize = 200;
  for (let start = 0; start <= 10_000_000; start += pageSize) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", "Movie,Series,Episode");
    url.searchParams.set("Fields", "ProviderIds,SeriesProviderIds,UserData,PremiereDate,ProductionYear");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    url.searchParams.set("api_key", config.apiKey);
    const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane: "sync" });
    if (!response.ok) {
      const error = new Error(`Emby rating scan failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const page = ratingSnapshotPage(data, start, pageSize, "Emby");
    for (const item of page) {
      const rating = Number(item.UserData?.Rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) continue;
      const record = embyRatingRecord(item);
      record.rating = Math.round(rating);
      if (Number.isInteger(record.rating) && record.rating >= 1 && record.rating <= 10) records.push(record);
    }
    const total = Number(data?.TotalRecordCount || 0);
    if (!page.length || page.length < pageSize || (total > 0 && start + page.length >= total)) return records;
  }
  throw new Error("Emby rating snapshot exceeded the pagination safety limit");
}

async function writeEmbyPersonalRating(config, media, rating, { lane = "sync" } = {}) {
  requireEmbyConfig(config);
  const lookup = {
    ...media,
    type: media.media_type || media.mediaType || media.type,
    ids: {
      tmdb: media.show_tmdb_id || media.tmdb_id,
      tvdb: media.show_tvdb_id || media.tvdb_id,
      imdb: media.show_imdb_id || media.imdb_id,
    },
  };
  const items = await findEmbyItems(config, lookup);
  if (!items?.length) return { platform: "emby", status: "not_found" };
  let lastHttpStatus = 200;
  for (const item of items) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
    url.searchParams.set("api_key", config.apiKey);
    const body = { Rating: rating == null ? null : Math.max(1, Math.min(10, Math.round(Number(rating)))) };
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      lane,
      body: JSON.stringify(body),
    });
    if (response.status === 404) return { platform: "emby", status: "not_found", itemId: item.Id };
    if (!response.ok) {
      const error = new Error(`Emby personal rating update failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    lastHttpStatus = response.status;
    await verifyEmbyPersonalRating(config, item.Id, body.Rating, lane);
  }
  return { platform: "emby", status: "fulfilled", itemId: items[0].Id, itemIds: items.map((item) => item.Id), httpStatus: lastHttpStatus };
}

// Emby 4.9.5.0 answers 204 to a UserData Rating write without storing it, so a
// successful response is not evidence of delivery. Read the item back and fail
// the write unless the stored rating matches what was sent.
async function verifyEmbyPersonalRating(config, itemId, expected, lane) {
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${itemId}`);
  url.searchParams.set("Fields", "UserData");
  url.searchParams.set("api_key", config.apiKey);
  const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane });
  if (!response.ok) {
    const error = new Error(`Emby personal rating read-back failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const item = await response.json();
  const raw = item?.UserData?.Rating;
  const stored = raw == null || raw === "" ? null : Number(raw);
  const matches = expected == null
    ? stored == null || !Number.isFinite(stored) || stored < 1
    : Number.isFinite(stored) && Math.round(stored) === expected;
  if (!matches) {
    throw new Error(expected == null
      ? `Emby accepted the rating clear but item ${itemId} still reports rating ${stored}`
      : `Emby accepted the rating write but did not store it (item ${itemId} reports ${stored == null ? "no rating" : `rating ${stored}`}, expected ${expected})`);
  }
}

export function setEmbyPersonalRating(config, media, rating, options = {}) {
  return writeEmbyPersonalRating(config, media, rating, options);
}

export function clearEmbyPersonalRating(config, media, options = {}) {
  return writeEmbyPersonalRating(config, media, null, options);
}
