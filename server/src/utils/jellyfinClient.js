import { fetchWithTimeout } from "./outbound.js";
import { compoundEpisodeItemsForMedia } from "./compoundEpisode.js";
import { restoreLookupKey } from "./restoreLookupCache.js";
import { nativeProviderItemIds } from "./providerItemIds.js";
import { jellyfinAuthHeaders, jellyfinCredential } from "./jellyfinAuth.js";
import { canonicalPlayedDateIso } from "./watchSyncPolicy.js";
import { traceLog } from "./logVerbose.js";
import { ratingSnapshotPage } from "./ratingSnapshotSafety.js";
function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requireJellyfinConfig(config = {}) {
  if (!config.baseUrl || !jellyfinApiKey(config) || !config.userId) {
    throw new Error("Missing Jellyfin baseUrl, apiKey, or userId");
  }
}

function jellyfinApiKey(config = {}) {
  return jellyfinCredential(config);
}

function authHeaders(config) {
  return jellyfinAuthHeaders(config);
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
    const error = new Error(`Jellyfin request failed with status ${response.status}`);
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
    // Some Jellyfin-compatible servers cap Limit below the requested size.
    // Advance by the response length so a server-side cap cannot skip items.
    start += page.length;
  }
  return requestedLimit ? items.slice(0, requestedLimit) : items;
}

function nativeJellyfinItems(media = {}) {
  return nativeProviderItemIds(media, "jellyfin").map((Id) => ({ Id }));
}

async function findJellyfinItemsForMutation(config, media = {}) {
  const direct = nativeJellyfinItems(media);
  if (direct.length) return direct;
  const cache = media?.restoreLookupCache;
  const items = cache && typeof cache.resolve === "function"
    ? await cache.resolve(
      restoreLookupKey("jellyfin", config, media),
      media,
      () => findJellyfinItems(config, media),
    )
    : await findJellyfinItems(config, media);
  if (items?.length || media.type !== "episode" || media.__identityRetry) return items || [];

  // A cached series episode list can predate an item added or reindexed in
  // Jellyfin. Refresh once on an exact episode miss before reporting not_found.
  traceLog("Jellyfin episode lookup missed; refreshing the cached series index", {
    title: media.title,
    season: media.season,
    episode: media.episode,
  });
  invalidateJellyfinSeriesIdentity(config, media);
  return findJellyfinItemsForMutation(config, { ...media, __identityRetry: true });
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
// id is a different show with the same name (live 23 September 2026: the
// Australian "The Assembly" card linked the UK show's S01E01). Only explicit
// show ids are compared: a watch record's plain ids can be the episode's own.
function seriesIdsConflict(media = {}, providerIds = {}) {
  return [["tmdb", "Tmdb"], ["tvdb", "Tvdb"]].some(([key, field]) => {
    const wanted = String(media?.[`show_${key}_id`] || "").trim().toLowerCase();
    const actual = String(providerIds?.[field] || "").trim().toLowerCase();
    return Boolean(wanted && actual && wanted !== actual);
  });
}

// Two title matches whose provider ids or years disagree are two different
// shows or films of the same name ("Scrubs" 2001 and its 2026 revival, both
// named plain "Scrubs" in Jellyfin). With no year or show id to choose between
// them, writing to every match marked the other show too, so the title match
// is refused instead (decision 40). Matches that agree still all count.
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
const jellyfinSeriesCache = new Map();
const jellyfinSeriesInFlight = new Map();
let jellyfinCacheNow = () => Date.now();

function mediaIdentitiesCompatible(left = {}, right = {}) {
  return ["imdb", "tmdb", "tvdb"].every((provider) => {
    const a = String(left?.ids?.[provider] || "").trim().toLowerCase();
    const b = String(right?.ids?.[provider] || "").trim().toLowerCase();
    return !a || !b || a === b;
  });
}

function jellyfinSeriesAliases(config, media) {
  const scope = `jellyfin|${trimTrailingSlash(config.baseUrl).toLowerCase()}|${String(config.userId).toLowerCase()}`;
  const aliases = providerTerms(media.ids).map((term) => `${scope}|${term.toLowerCase()}`);
  const title = parseShowTitle(media.title).title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = extractYear(media.title);
  if (title) aliases.push(`${scope}|title:${title}${year ? `|year:${year}` : ""}`);
  return [...new Set(aliases)];
}

function jellyfinEntryCompatible(entry, media) {
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

function deleteJellyfinEntry(entry) {
  for (const [alias, value] of jellyfinSeriesCache) if (value === entry) jellyfinSeriesCache.delete(alias);
}

function getCachedJellyfinEntry(aliases, media) {
  const now = jellyfinCacheNow();
  for (const alias of aliases) {
    const entry = jellyfinSeriesCache.get(alias);
    if (!entry) continue;
    if (entry.expiresAt <= now) { deleteJellyfinEntry(entry); continue; }
    if (jellyfinEntryCompatible(entry, media)) return entry;
  }
  return null;
}

function storeJellyfinEntry(entry, aliases) {
  for (const alias of aliases) jellyfinSeriesCache.set(alias, entry);
  const entries = [...new Set(jellyfinSeriesCache.values())].sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length > SERIES_CACHE_MAX_ENTRIES) deleteJellyfinEntry(entries.shift());
}

function isJellyfinEpisodeWithCoordinates(item) {
  if (!item || (item.Type && String(item.Type).toLowerCase() !== "episode")) return false;
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  if (season === null || season === undefined || season === "" || episode === null || episode === undefined || episode === "") return false;
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  return Number.isInteger(seasonNumber) && seasonNumber >= 0
    && Number.isInteger(episodeNumber) && episodeNumber > 0;
}

async function fetchJellyfinEpisodesBySeriesId(config, seriesId, media = null) {
  requireJellyfinConfig(config);
  const id = String(seriesId || "").trim();
  if (!id) return [];
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Shows/${encodeURIComponent(id)}/Episodes`);
  url.searchParams.set("UserId", config.userId);
  url.searchParams.set("Fields", "ProviderIds,MediaSources,MediaStreams,Width,Height");
  url.searchParams.set("EnableUserData", "true");
  const data = await fetchJson(url, config, media);
  return (data?.Items || []).filter(isJellyfinEpisodeWithCoordinates);
}

// Prefer the existing item-tree query when it returns real episode rows. Some
// Jellyfin-compatible libraries expose only a Season container there, while
// the dedicated Shows endpoint returns the episode items. Keep this separate
// from fetchJellyfinEpisodes because callers may pass a Season Id as parentId.
export async function fetchJellyfinEpisodesForSeries(config, seriesId, media = null) {
  requireJellyfinConfig(config);
  const id = String(seriesId || "").trim();
  if (!id) return [];
  let genericError = null;
  try {
    const items = await fetchJellyfinEpisodes(config, id, media);
    const episodes = items.filter(isJellyfinEpisodeWithCoordinates);
    if (episodes.length) return episodes;
  } catch (error) {
    genericError = error;
  }

  try {
    const episodes = await fetchJellyfinEpisodesBySeriesId(config, id, media);
    traceLog("Jellyfin series episode lookup used the dedicated Shows endpoint", { seriesId: id, episodeCount: episodes.length });
    return episodes;
  } catch (error) {
    if (!genericError) throw error;
    throw new Error(
      `Jellyfin episode lookup failed through both item-tree and Shows endpoints: ${genericError.message || genericError}; ${error.message || error}`,
      { cause: error },
    );
  }
}

async function resolveJellyfinSeriesIdentity(config, media) {
  const aliases = jellyfinSeriesAliases(config, media);
  // A provider-id lookup can legitimately fall back to a title search. Keep
  // that fallback in-flight across sibling episodes, while guarding against
  // sharing a pending lookup for two conflicting remakes.
  const inFlightAliases = aliases;
  const cached = getCachedJellyfinEntry(aliases, media);
  if (cached) return cached;
  for (const alias of inFlightAliases) {
    const pending = jellyfinSeriesInFlight.get(alias);
    if (pending && mediaIdentitiesCompatible(pending.media, media)) return pending.promise;
  }
  const promise = (async () => {
    let series = [];
    try { series = await findByProviderIds(config, media, "Series"); } catch (error) {
      console.error("Jellyfin provider discovery failed; trying title fallback", error);
    }
    if (!series.length) series = await searchJellyfinFallback(config, media, "Series");
    const now = jellyfinCacheNow();
    if (!series.length) {
      const empty = { series: [], episodesByCoordinate: new Map(), expiresAt: now + 20_000, createdAt: now };
      storeJellyfinEntry(empty, aliases);
      return empty;
    }
    const settled = await Promise.allSettled(series.map((item) => fetchJellyfinEpisodesForSeries(config, item.Id, media)));
    const episodes = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!episodes.length && settled.every((result) => result.status === "rejected")) throw settled[0].reason;
    const episodesByCoordinate = new Map();
    for (const item of episodes) {
      const key = `${Number(item.ParentIndexNumber)}:${Number(item.IndexNumber)}`;
      if (!episodesByCoordinate.has(key)) episodesByCoordinate.set(key, []);
      episodesByCoordinate.get(key).push(item);
    }
    const entry = { series, episodesByCoordinate, expiresAt: now + SERIES_CACHE_TTL_MS, createdAt: now };
    const discoveredAliases = [...aliases];
    for (const item of series) {
      const ids = item.ProviderIds || {};
      discoveredAliases.push(...jellyfinSeriesAliases(config, { ...media, ids: { imdb: ids.Imdb, tmdb: ids.Tmdb, tvdb: ids.Tvdb } }));
    }
    storeJellyfinEntry(entry, [...new Set(discoveredAliases)]);
    return entry;
  })();
  const pendingEntry = { media, promise };
  for (const alias of inFlightAliases) jellyfinSeriesInFlight.set(alias, pendingEntry);
  try { return await promise; } finally {
    for (const [alias, pending] of jellyfinSeriesInFlight) if (pending === pendingEntry) jellyfinSeriesInFlight.delete(alias);
  }
}

export function __resetJellyfinSeriesCache() {
  jellyfinSeriesCache.clear();
  jellyfinSeriesInFlight.clear();
  jellyfinCacheNow = () => Date.now();
}

export function __setJellyfinSeriesCacheNow(fn) {
  jellyfinCacheNow = typeof fn === "function" ? fn : () => Date.now();
}

function invalidateJellyfinSeriesIdentity(config, media) {
  for (const alias of jellyfinSeriesAliases(config, media)) {
    const entry = jellyfinSeriesCache.get(alias);
    if (entry) deleteJellyfinEntry(entry);
  }
  media?.restoreLookupCache?.delete?.(restoreLookupKey("jellyfin", config, media));
}

async function searchJellyfinFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);

  const parsed = parseShowTitle(media.title);
  const queryTitle = (targetType === "Series" || targetType === "show") ? parsed.title : media.title;

  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", targetType);
  // The year is left out of the search (Jellyfin finds nothing for "Scrubs
  // (2026)") and checked against ProductionYear instead.
  url.searchParams.set("SearchTerm", queryTitle.replace(/\s*\(\d{4}\)\s*$/, ""));
  // Jellyfin's Fields parameter accepts ItemFields enum values. UserData is
  // controlled separately by EnableUserData and is not an ItemFields value.
  url.searchParams.set("Fields", "ProviderIds");
  traceLog("Jellyfin search fallback started", { query: queryTitle, targetType });
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
      traceLog("Jellyfin search fallback refused an ambiguous title", { query: queryTitle, targetType, itemIds: matched.map(i => i.Id) });
      return [];
    }
    if (matched.length > 0) {
      traceLog("Jellyfin search fallback matched items", { count: matched.length, itemIds: matched.map(i => i.Id) });
      return matched;
    }
  } catch (error) {
    console.error("Jellyfin search fallback failed", error);
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
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("AnyProviderIdEquals", providerTerm);
    traceLog("Jellyfin lookup started", { itemTypes, providerTerm });
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
      console.error("Jellyfin lookup failed for providerTerm: %s", terms[index], result.reason);
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
    traceLog("Jellyfin lookup matched items", { count: results.length, itemIds: results.map(i => i.Id) });
    return results;
  }

  return [];
}

async function findEpisode(config, media) {
  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;
  const entry = await resolveJellyfinSeriesIdentity(config, media);
  return compoundEpisodeItemsForMedia(entry.episodesByCoordinate, {
    ...media,
    season,
    episode: episodeNum,
  });
}

export function jellyfinEpisodeMatchesCoordinates(item = {}, season, episode) {
  return Number(item.ParentIndexNumber) === Number(season) && Number(item.IndexNumber) === Number(episode);
}

export async function findJellyfinItems(config, media) {
  const direct = nativeJellyfinItems(media);
  if (direct.length) return direct;
  if (media.type === "movie") {
    let movies = await findByProviderIds(config, media, "Movie");
    if (!movies || movies.length === 0) {
      movies = await searchJellyfinFallback(config, media, "Movie");
    }
    return movies;
  }
  if (media.type === "tv" || media.type === "series" || media.type === "show") {
    let series = await findByProviderIds(config, media, "Series");
    if (!series || series.length === 0) {
      series = await searchJellyfinFallback(config, media, "Series");
    }
    return series;
  }
  if (media.type === "episode") return findEpisode(config, media);
  return [];
}

export async function markJellyfinPlayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Jellyfin library for: "${media.title}"`);
      return noMatchingLibraryItem("jellyfin", media);
    }

    // Jellyfin's mark-played request accepts the original play date as a
    // `datePlayed` query parameter, so an import or a backdated manual mark
    // keeps its real date instead of being recorded as watched today.
    const datePlayed = canonicalPlayedDateIso(media);
    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const buildUrl = (withDate) => {
        const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
        if (withDate && datePlayed) url.searchParams.set("datePlayed", datePlayed);
        return url;
      };
      const requestInit = {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "Content-Type": "application/json",
        },
        lane: media?.lane || "sync",
        body: JSON.stringify({}),
      };

      let response = await fetchWithTimeout(buildUrl(true), requestInit);
      // Server versions that do not accept datePlayed answer with a 4xx rather
      // than ignoring it. The watched state must still land, so retry without
      // the date. A 404 is left alone - that is a missing item, and the
      // caller's identity-retry below owns it.
      if (!response.ok && datePlayed && response.status >= 400 && response.status < 500 && response.status !== 404) {
        console.log("Jellyfin rejected datePlayed; retrying mark played without the original date", { itemId: item.Id, status: response.status });
        response = await fetchWithTimeout(buildUrl(false), requestInit);
      }
      if (!response.ok) {
        const error = new Error(`Jellyfin mark played failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Jellyfin item marked played", { itemId: item.Id, datePlayed: datePlayed || "server time" });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateJellyfinSeriesIdentity(config, media);
      return markJellyfinPlayed(config, { ...media, __identityRetry: true });
    }
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function markJellyfinUnplayed(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Jellyfin library for: "${media.title}"`);
      return noMatchingLibraryItem("jellyfin", media);
    }

    let lastHttpStatus = 200;
    const markJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${item.Id}`);
      const response = await fetchWithTimeout(url, {
        method: "DELETE",
        headers: {
          ...authHeaders(config),
          "Content-Type": "application/json",
        },
        lane: media?.lane || "sync",
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const error = new Error(`Jellyfin mark unplayed failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Jellyfin item marked unplayed", { itemId: item.Id });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(markJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateJellyfinSeriesIdentity(config, media);
      return markJellyfinUnplayed(config, { ...media, __identityRetry: true });
    }
    console.error("Jellyfin client failed", error);
    throw error;
  }
}

export async function setJellyfinProgress(config, media) {
  try {
    requireJellyfinConfig(config);

    const items = await findJellyfinItemsForMutation(config, media);
    if (!items || items.length === 0) {
      console.log(`[NOT FOUND] No matching item in Jellyfin library for: "${media.title}"`);
      return noMatchingLibraryItem("jellyfin", media);
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    const hasPosition = media.positionMs !== undefined || media.offsetMs !== undefined;
    if (!hasPosition) {
      return { platform: "jellyfin", status: "skipped", detail: "No resume position supplied" };
    }

    let lastHttpStatus = 200;
    const progressJobs = items.map(async (item) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "Content-Type": "application/json",
        },
        lane: media?.lane || "sync",
        body: JSON.stringify({
          PlaybackPositionTicks: positionMs * 10000,
          Played: false,
        }),
      });
      if (!response.ok) {
        const error = new Error(`Jellyfin progress update failed with status ${response.status} for item ${item.Id}`);
        error.status = response.status;
        throw error;
      }
      console.log("Jellyfin item resume progress updated", { itemId: item.Id, positionMs });
      lastHttpStatus = response.status;
      return response.status;
    });

    await Promise.all(progressJobs);
    return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map(i => i.Id), positionMs, httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidateJellyfinSeriesIdentity(config, media);
      return setJellyfinProgress(config, { ...media, __identityRetry: true });
    }
    console.error("Jellyfin progress client failed", error);
    throw error;
  }
}

// Jellyfin merges the fields present in a UserData update with the existing
// row. Keep this deliberately small: callers that only need to influence the
// calculated Next Up ordering can update LastPlayedDate without resetting the
// item's play count, watched flag, resume position, or any other user data.
export async function updateJellyfinUserData(config, itemId, userData = {}, { lane = "interactive" } = {}) {
  requireJellyfinConfig(config);
  const id = String(itemId || "").trim();
  if (!id) return { platform: "jellyfin", status: "not_found" };
  if (!userData || typeof userData !== "object" || Array.isArray(userData) || !Object.keys(userData).length) {
    return { platform: "jellyfin", status: "skipped", detail: "No Jellyfin user data fields supplied", itemId: id };
  }

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(id)}/UserData`);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "Content-Type": "application/json",
    },
    lane,
    body: JSON.stringify(userData),
  });
  if (!response.ok) {
    const error = new Error(`Jellyfin user data update failed with status ${response.status} for item ${id}`);
    error.status = response.status;
    throw error;
  }
  return {
    platform: "jellyfin",
    status: "fulfilled",
    itemId: id,
    fields: Object.keys(userData),
    httpStatus: response.status,
  };
}

export async function fetchJellyfinEpisodes(config, parentId, media = null) {
  requireJellyfinConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("ParentId", parentId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "ProviderIds,MediaSources,MediaStreams,Width,Height");
  url.searchParams.set("EnableUserData", "true");
  const data = await fetchJson(url, config, media);
  return data?.Items || [];
}

export async function fetchJellyfinSeriesEpisodes(config, media) {
  requireJellyfinConfig(config);
  const { series } = await resolveJellyfinSeriesIdentity(config, media);
  if (!series.length) return [];

  // Reuse stable native series identity but always read mutable UserData fresh.
  const episodeGroups = await Promise.all(series.map((item) => fetchJellyfinEpisodesForSeries(config, item.Id, media).catch(() => [])));
  return episodeGroups.flat();
}

// Mark unplayed directly by native item Id, skipping the search/match step. Used by the
// authoritative restore clear pass, which already has the Id from fetchJellyfinWatchedItems.
export async function markJellyfinUnplayedById(config, itemId, { lane = "sync" } = {}) {
  requireJellyfinConfig(config);
  if (!itemId) return { platform: "jellyfin", status: "not_found" };

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/PlayedItems/${itemId}`);
  const response = await fetchWithTimeout(url, {
    method: "DELETE",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    lane,
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Jellyfin mark unplayed failed with status ${response.status} for item ${itemId}`);
  }
  return { platform: "jellyfin", status: "fulfilled", itemId, httpStatus: response.status };
}

// Jellyfin has no resume dismissal: HideFromResume is Emby's, and Jellyfin
// 12.0.0 answers it with 404. An item leaves Jellyfin's Resume list when its
// position is zero or it is played, which the callers' unplayed/progress write
// has already done. This only confirms that, without writing anything.
export async function hideJellyfinFromResume(config, itemId, { lane = "interactive" } = {}) {
  requireJellyfinConfig(config);
  if (!itemId) return { platform: "jellyfin", status: "not_found" };
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(itemId)}`);
  const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane });
  if (response.status === 404) return { platform: "jellyfin", status: "not_found", itemId: String(itemId) };
  if (!response.ok) throw new Error(`Jellyfin resume check failed with status ${response.status} for item ${itemId}`);
  const userData = (await response.json())?.UserData || {};
  if (userData.Played || !Number(userData.PlaybackPositionTicks || 0)) {
    return { platform: "jellyfin", status: "fulfilled", itemId: String(itemId), httpStatus: response.status };
  }
  throw new Error(`Jellyfin item ${itemId} still has a resume position; Jellyfin has no separate resume dismissal`);
}

function buildJellyfinWatchedItemsUrl(config, { limit = 0, parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsPlayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds");
  url.searchParams.set("EnableUserData", "true");
  url.searchParams.set("SortBy", "DatePlayed");
  url.searchParams.set("SortOrder", "Descending");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  if (Number(limit) > 0) url.searchParams.set("Limit", String(Math.max(1, Math.round(Number(limit)))));
  return url;
}

export async function fetchJellyfinWatchedItems(config, { limit = 0, libraryIds } = {}) {
  requireJellyfinConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    const data = await fetchJson(buildJellyfinWatchedItemsUrl(config, { limit, parentId }), config);
    items.push(...(data?.Items || []));
  }
  return items;
}

function buildJellyfinLibraryItemsUrl(config, { parentId = "" } = {}) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("Filters", "IsUnplayed");
  url.searchParams.set("IncludeItemTypes", "Movie,Episode");
  url.searchParams.set("Fields", "ProviderIds");
  url.searchParams.set("EnableUserData", "true");
  url.searchParams.set("StartIndex", "0");
  url.searchParams.set("EnableTotalRecordCount", "true");
  if (parentId) url.searchParams.set("ParentId", String(parentId));
  return url;
}

// Full paginated unplayed inventory used by the scheduled availability
// reconciliation. A new duplicate/quality variant is normally unplayed on
// Jellyfin even when Plembfin already knows that the same episode was watched.
export async function fetchJellyfinLibraryItems(config, { limit = 0, libraryIds } = {}) {
  requireJellyfinConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  const items = [];
  for (const parentId of parents) {
    items.push(...await fetchPagedFeed(
      config,
      (start, pageSize) => {
        const url = buildJellyfinLibraryItemsUrl(config, { parentId });
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
export async function listJellyfinLibraries(config) {
  requireJellyfinConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/Users/${config.userId}/Views`);
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
export async function countJellyfinWatchedItems(config, { libraryIds } = {}) {
  requireJellyfinConfig(config);
  const parents = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : [""];
  let total = 0;
  for (const parentId of parents) {
    const url = buildJellyfinWatchedItemsUrl(config, { limit: 1, parentId });
    const data = await fetchJson(url, config);
    total += Number(data?.TotalRecordCount ?? (data?.Items || []).length);
  }
  return total;
}

export async function fetchJellyfinResumableItems(config, { limit = 0 } = {}) {
  requireJellyfinConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  // The Resume endpoint is what Jellyfin's own Continue Watching reads. The
  // generic Items?Filters=IsResumable query hides a merged episode's
  // non-primary version, so a part-watch of the 720p copy of a two-version
  // episode never reached Plembfin (Jellyfin 12.0).
  const buildResumeUrl = (start, pageSize) => {
    const url = new URL(`${baseUrl}/Users/${config.userId}/Items/Resume`);
    url.searchParams.set("IncludeItemTypes", "Movie,Episode");
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    return url;
  };
  const buildLegacyResumeUrl = (start, pageSize) => {
    const url = new URL(`${baseUrl}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("Filters", "IsResumable");
    url.searchParams.set("IncludeItemTypes", "Movie,Episode");
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("SortBy", "DatePlayed");
    url.searchParams.set("SortOrder", "Descending");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    return url;
  };
  try {
    const native = await fetchPagedFeed(config, buildResumeUrl, limit);
    if (native.length) return native;
    // Emby's Resume endpoint can answer an empty 200 while IsResumable lists
    // real part-watches (docs/decisions.md); do not trust an empty answer.
    return await fetchPagedFeed(config, buildLegacyResumeUrl, limit);
  } catch (error) {
    // Only a missing route falls back; a real failure stays visible.
    if (Number(error?.status) !== 404) throw error;
    return fetchPagedFeed(config, buildLegacyResumeUrl, limit);
  }
}

export async function fetchJellyfinNextUpItems(config, { limit = 0 } = {}) {
  requireJellyfinConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  return fetchPagedFeed(config, (start, pageSize) => {
    const url = new URL(`${baseUrl}/Shows/NextUp`);
    url.searchParams.set("UserId", config.userId);
    url.searchParams.set("Fields", "ProviderIds,MediaSources");
    url.searchParams.set("EnableResumable", "true");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    return url;
  }, limit);
}

// Runtime for an item whose native id is already known; see the Emby twin.
export async function fetchJellyfinItemRuntimeMs(config, itemId) {
  requireJellyfinConfig(config);
  const id = String(itemId || "").trim();
  if (!id) return 0;
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(id)}`);
  const item = await fetchJson(url, config);
  const ticks = Number(item?.RunTimeTicks || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

// ---------------------------------------------------------------------------
// Personal ratings
// ---------------------------------------------------------------------------

function jellyfinProviderIds(item = {}) {
  const ids = item.ProviderIds || {};
  return {
    imdb: ids.Imdb || ids.imdb || "",
    tmdb: ids.Tmdb || ids.tmdb || "",
    tvdb: ids.Tvdb || ids.tvdb || "",
    jellyfin: item.Id || "",
  };
}

function jellyfinRatingRecord(item = {}) {
  const type = String(item.Type || item.type || "").toLowerCase();
  const isEpisode = type === "episode";
  const isShow = type === "series";
  const providerIds = jellyfinProviderIds(item);
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
      show_title: isEpisode ? String(item.SeriesName || "") : "",
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

export async function fetchJellyfinPersonalRatingSnapshot(config) {
  requireJellyfinConfig(config);
  const records = [];
  const pageSize = 200;
  for (let start = 0; start <= 10_000_000; start += pageSize) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items`);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("IncludeItemTypes", "Movie,Series,Episode");
    url.searchParams.set("Fields", "ProviderIds");
    url.searchParams.set("EnableUserData", "true");
    url.searchParams.set("StartIndex", String(start));
    url.searchParams.set("Limit", String(pageSize));
    const response = await fetchWithTimeout(url, { headers: authHeaders(config), lane: "sync" });
    if (!response.ok) {
      const error = new Error(`Jellyfin rating scan failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const page = ratingSnapshotPage(data, start, pageSize, "Jellyfin");
    for (const item of page) {
      const rating = Number(item.UserData?.Rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) continue;
      const record = jellyfinRatingRecord(item);
      record.rating = Math.round(rating);
      if (Number.isInteger(record.rating) && record.rating >= 1 && record.rating <= 10) records.push(record);
    }
    const total = Number(data?.TotalRecordCount || 0);
    if (!page.length || page.length < pageSize || (total > 0 && start + page.length >= total)) return records;
  }
  throw new Error("Jellyfin rating snapshot exceeded the pagination safety limit");
}

async function writeJellyfinPersonalRating(config, media, rating, { lane = "sync" } = {}) {
  requireJellyfinConfig(config);
  const lookup = {
    ...media,
    type: media.media_type || media.mediaType || media.type,
    ids: {
      tmdb: media.show_tmdb_id || media.tmdb_id,
      tvdb: media.show_tvdb_id || media.tvdb_id,
      imdb: media.show_imdb_id || media.imdb_id,
    },
  };
  const items = await findJellyfinItems(config, lookup);
  if (!items?.length) return { platform: "jellyfin", status: "not_found" };
  let lastHttpStatus = 200;
  for (const item of items) {
    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/Users/${config.userId}/Items/${item.Id}/UserData`);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      lane,
      // Jellyfin treats a null field in this partial update as "leave
      // unchanged": `Rating: null` returned 200 but kept the old rating
      // (verified against Jellyfin 12.0.0, 22 September 2026). 0 is stored
      // and read back as 0, which every rating snapshot treats as unrated.
      body: JSON.stringify({ Rating: rating == null ? 0 : Math.max(1, Math.min(10, Math.round(Number(rating)))) }),
    });
    if (response.status === 404) return { platform: "jellyfin", status: "not_found", itemId: item.Id };
    if (!response.ok) {
      const error = new Error(`Jellyfin personal rating update failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    lastHttpStatus = response.status;
  }
  return { platform: "jellyfin", status: "fulfilled", itemId: items[0].Id, itemIds: items.map((item) => item.Id), httpStatus: lastHttpStatus };
}

export function setJellyfinPersonalRating(config, media, rating, options = {}) {
  return writeJellyfinPersonalRating(config, media, rating, options);
}

export function clearJellyfinPersonalRating(config, media, options = {}) {
  return writeJellyfinPersonalRating(config, media, null, options);
}
