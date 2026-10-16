import { traceLog } from "./logVerbose.js";
import { plexRatingSnapshotPage, ratingSnapshotArray } from "./ratingSnapshotSafety.js";
import { fetchPlexWithRefresh, plexRequestHeaders } from "./plexFetch.js";
import { compoundEpisodeForMedia, compoundEpisodeItemsForMedia } from "./compoundEpisode.js";
import { restoreLookupKey } from "./restoreLookupCache.js";
import { nativeProviderItemIds } from "./providerItemIds.js";
import {
  PLEX_ALREADY_MATCHING_DETAIL,
  PLEX_POLICY_SKIP_DETAIL,
  isHistoricalWatchIntent,
  plexHistoricalWatchedAllowed,
  resolveWatchSyncIntent,
} from "./watchSyncPolicy.js";
// Plex accepts the token as a header everywhere the query parameter works; the
// header keeps it out of Plex/reverse-proxy access logs and our own error logs.
export function plexAuthHeaders(tokenOrConfig, accept = "application/json") {
  return typeof tokenOrConfig === "object" ? plexRequestHeaders(tokenOrConfig, accept) : plexRequestHeaders({ token: tokenOrConfig }, accept);
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function requirePlexConfig(config = {}) {
  if (!config.baseUrl || !config.token) {
    throw new Error("Missing Plex baseUrl or token");
  }
}

function normalizePlexIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isOwnerPlexUsername(username = "") {
  return username === "admin" || username === "owner";
}

function accountMatchesUsername(account = {}, username = "") {
  return [
    account.name,
    account.title,
    account.username,
    account.accountName,
  ]
    .map(normalizePlexIdentity)
    .some((value) => value === username);
}

// Memoized username → accountID resolution. Without this every playstate
// operation re-fetches /accounts (an N+1 during full syncs). Failed/unmatched
// lookups are cached briefly so a misconfigured username doesn't hammer Plex.
const accountIdCache = new Map();
const ACCOUNT_ID_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_ID_NEGATIVE_TTL_MS = 60 * 1000;

export async function resolvePlexAccountId(config = {}, { lane = "sync" } = {}) {
  const username = normalizePlexIdentity(config.username);
  if (!username) return null;
  if (isOwnerPlexUsername(username)) return 1;

  const baseUrl = trimTrailingSlash(config.baseUrl);
  const cacheKey = `${baseUrl}|${username}`;
  const cached = accountIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const accountsUrl = new URL(`${baseUrl}/accounts`);

  let accountId = null;
  try {
    const response = await fetchPlexWithRefresh(config, accountsUrl, { lane });
    if (!response.ok) {
      console.warn(`Plex account mapping failed with HTTP ${response.status}`);
    } else {
      const body = await response.json();
      const accounts = body?.MediaContainer?.Account || [];
      const matchedAccount = accounts.find((account) => accountMatchesUsername(account, username));
      const parsed = Number(matchedAccount?.id);
      if (Number.isFinite(parsed)) accountId = parsed;
      else console.warn(`Plex account mapping did not find configured username "${config.username}"`);
    }
  } catch (error) {
    console.warn(`Plex account mapping failed: ${error.message}`);
  }

  accountIdCache.set(cacheKey, {
    value: accountId,
    expiresAt: Date.now() + (accountId != null ? ACCOUNT_ID_TTL_MS : ACCOUNT_ID_NEGATIVE_TTL_MS),
  });
  return accountId;
}

async function addConfiguredPlexAccountId(url, config = {}, { lane = "sync" } = {}) {
  const accountId = await resolvePlexAccountId(config, { lane });
  if (accountId != null) {
    url.searchParams.set("accountID", String(accountId));
  }
  return accountId;
}

function plexGuidCandidates(media) {
  const candidates = [];

  if (media.ids?.imdb) {
    candidates.push(`imdb://${media.ids.imdb}`);
    candidates.push(`com.plexapp.agents.imdb://${media.ids.imdb}`);
  }

  if (media.ids?.tmdb) {
    candidates.push(`tmdb://${media.ids.tmdb}`);
    candidates.push(`themoviedb://${media.ids.tmdb}`);
    candidates.push(`com.plexapp.agents.themoviedb://${media.ids.tmdb}`);
  }

  if (media.ids?.tvdb) {
    candidates.push(`tvdb://${media.ids.tvdb}`);
    candidates.push(`thetvdb://${media.ids.tvdb}`);
    candidates.push(`com.plexapp.agents.thetvdb://${media.ids.tvdb}`);
  }

  return [...new Set(candidates)];
}

function extractYear(title) {
  const match = String(title || "").match(/\((\d{4})\)/);
  return match ? Number(match[1]) : undefined;
}

function removeTrailingYear(title) {
  return String(title || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
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

function plexGuidIds(item = {}) {
  const ids = {};
  for (const guid of item.Guid || []) {
    const match = String(guid?.id || guid || "").match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?]+)/i);
    if (match) ids[match[1].toLowerCase().replace("themoviedb", "tmdb").replace("thetvdb", "tvdb")] = match[2].toLowerCase();
  }
  return ids;
}

// A year-less title such as "Scrubs" matches both "Scrubs" (2001) and
// "Scrubs (2026)", and /search results carry no Guids, so the first hit used to
// win: the reboot's Up Next card resolved to the 2001 show's episodes. When the
// request has ids, read each candidate's Guids and return the first one that
// shares an id with it. A differing id alone is not a conflict: watch records
// mix the episode's own imdb/tvdb ids with the show's tmdb id. With no shared
// id anywhere, keep the first title match as before. Explicit show ids are
// different: a candidate whose own TMDB or TVDB id differs from the request's
// show id is another show with the same name, even when it is the only title
// match (the Australian "The Assembly" must not resolve to the UK show).
function showIdsConflict(media = {}, ids = {}) {
  return ["tmdb", "tvdb"].some((provider) => {
    const wanted = String(media?.[`show_${provider}_id`] || "").trim().toLowerCase();
    return Boolean(wanted && ids[provider] && ids[provider] !== wanted);
  });
}

async function pickShowSearchResultByIds(config, media, candidates, { requireSharedId = false } = {}) {
  const requested = Object.fromEntries(["imdb", "tmdb", "tvdb"]
    .map((provider) => [provider, String(media?.ids?.[provider] || "").trim().toLowerCase()])
    .filter(([, value]) => value));
  const hasShowIds = ["tmdb", "tvdb"].some((provider) => String(media?.[`show_${provider}_id`] || "").trim());
  if (requireSharedId && !Object.keys(requested).length) return undefined;
  if (!candidates.length || !Object.keys(requested).length) return candidates[0];
  if (candidates.length < 2 && !hasShowIds && !requireSharedId) return candidates[0];
  let first;
  for (const candidate of candidates) {
    let item = candidate;
    if (!(item.Guid || []).length && item.ratingKey) {
      try {
        item = (await fetchPlexMetadataItem(config, item.ratingKey, { lane: media?.lane || "sync" })) || candidate;
      } catch (error) {
        console.warn(`Plex search fallback could not read Guids for ${candidate.ratingKey}`, error.message);
      }
    }
    const ids = plexGuidIds(item);
    if (showIdsConflict(media, ids)) continue;
    if (Object.keys(requested).some((provider) => ids[provider] === requested[provider])) return item;
    first ||= item;
  }
  return requireSharedId ? undefined : first;
}

// Plex names a show that shares its title with another country's version
// "The Assembly (UK)", while watch records and Up Next cards carry "The
// Assembly". The guid lookup cannot bridge the two: this server's
// /library/all?guid= matches only Plex's own plex:// guid, never an external
// id. So a show search also accepts a title that differs only by a trailing
// qualifier, but only on a candidate whose Guids share an id with the request.
function removeTrailingQualifier(title) {
  return String(title || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
}

async function searchPlexFallback(config, media, targetType) {
  const baseUrl = trimTrailingSlash(config.baseUrl);

  const parsed = parseShowTitle(media.title);
  const isShowSearch = targetType === "show" || targetType === "series";
  const primaryQueryTitle = isShowSearch ? parsed.title : media.title;
  const retryQueryTitle = isShowSearch ? removeTrailingYear(primaryQueryTitle) : primaryQueryTitle;
  const queryTitles = [...new Set([primaryQueryTitle, retryQueryTitle].map((title) => String(title || "").trim()).filter(Boolean))];

  for (const queryTitle of queryTitles) {
    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set("query", queryTitle);

    traceLog("Plex search fallback started", { query: queryTitle, targetType });
    const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });

    if (!response.ok) {
      console.error("Plex search fallback failed", { status: response.status });
      continue;
    }

    const body = await response.json();
    const results = body?.MediaContainer?.Metadata || [];

    const typeMatched = results.filter((item) => {
      const itemType = item.type === "series" ? "show" : item.type;
      const expectedType = targetType === "series" ? "show" : targetType;
      return itemType === expectedType && yearMatches(media.title, item.year);
    });
    const titleMatched = typeMatched.filter((item) => titleMatches(queryTitle, item.title));
    let matched = isShowSearch
      ? await pickShowSearchResultByIds(config, media, titleMatched)
      : titleMatched[0];
    if (!matched && isShowSearch) {
      const qualified = typeMatched.filter((item) => !titleMatches(queryTitle, item.title)
        && titleMatches(queryTitle, removeTrailingQualifier(item.title)));
      if (qualified.length) matched = await pickShowSearchResultByIds(config, media, qualified, { requireSharedId: true });
    }

    if (matched?.ratingKey) {
      traceLog("Plex search fallback matched item", { ratingKey: matched.ratingKey, title: matched.title, year: matched.year, query: queryTitle });
      return matched;
    }
  }

  return undefined;
}

// In-memory cache for resolved Plex rating keys to avoid repetitive slow queries/searches.
const plexRatingKeyCache = new Map();
const plexSeriesIdentityCache = new Map();
const plexSeriesInFlight = new Map();
const plexEpisodeSeriesMetadataCache = new Map();
const plexEpisodeSeriesMetadataInFlight = new Map();
const PLEX_IDENTITY_TTL_MS = 10 * 60 * 1000;
const PLEX_IDENTITY_MAX_ENTRIES = 100;
const PLEX_EPISODE_SERIES_METADATA_TTL_MS = 10 * 60 * 1000;
const PLEX_EPISODE_SERIES_METADATA_NEGATIVE_TTL_MS = 20 * 1000;
const PLEX_EPISODE_SERIES_METADATA_MAX_ENTRIES = 200;
let plexCacheNow = () => Date.now();

function mediaIdentitiesCompatible(left = {}, right = {}) {
  return ["imdb", "tmdb", "tvdb"].every((provider) => {
    const a = String(left?.ids?.[provider] || "").trim().toLowerCase();
    const b = String(right?.ids?.[provider] || "").trim().toLowerCase();
    return !a || !b || a === b;
  });
}

function plexConnectionScope(config = {}) {
  return `${trimTrailingSlash(config.baseUrl).toLowerCase()}|${normalizePlexIdentity(config.username || config.userId || "owner")}`;
}

function getCacheKey(media, config = {}, { series = false } = {}) {
  const type = String(media?.type || "").toLowerCase();
  const season = series ? "x" : (media?.season != null ? String(media.season) : "x");
  const episode = series ? "x" : (media?.episode != null ? String(media.episode) : "x");
  const imdb = media?.ids?.imdb || media?.imdb || "";
  const tmdb = media?.ids?.tmdb || media?.tmdb || "";
  const tvdb = media?.ids?.tvdb || media?.tvdb || "";
  const title = String(media?.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  
  const scope = plexConnectionScope(config);
  if (imdb) return `${scope}:${type}:${season}:${episode}:imdb:${imdb}`;
  if (tmdb) return `${scope}:${type}:${season}:${episode}:tmdb:${tmdb}`;
  if (tvdb) return `${scope}:${type}:${season}:${episode}:tvdb:${tvdb}`;
  return `${scope}:${type}:${season}:${episode}:title:${title}`;
}

function plexSeriesAliases(config, media) {
  const scope = plexConnectionScope(config);
  const aliases = [];
  for (const [provider, value] of Object.entries(media.ids || {})) {
    if (value) aliases.push(`${scope}|${provider}:${String(value).toLowerCase()}`);
  }
  const title = removeTrailingYear(parseShowTitle(media.title).title).toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = extractYear(media.title);
  if (title) aliases.push(`${scope}|title:${title}${year ? `|year:${year}` : ""}`);
  return [...new Set(aliases)];
}

function getRatingKeyCache(key) {
  const entry = plexRatingKeyCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= plexCacheNow()) { plexRatingKeyCache.delete(key); return null; }
  return entry.ratingKey;
}

function setRatingKeyCache(key, ratingKey) {
  plexRatingKeyCache.set(key, { ratingKey, expiresAt: plexCacheNow() + PLEX_IDENTITY_TTL_MS });
  while (plexRatingKeyCache.size > PLEX_IDENTITY_MAX_ENTRIES * 4) {
    plexRatingKeyCache.delete(plexRatingKeyCache.keys().next().value);
  }
}

export function __resetPlexIdentityCache() {
  plexRatingKeyCache.clear();
  plexSeriesIdentityCache.clear();
  plexSeriesInFlight.clear();
  plexEpisodeSeriesMetadataCache.clear();
  plexEpisodeSeriesMetadataInFlight.clear();
  plexCacheNow = () => Date.now();
}

export function __setPlexIdentityCacheNow(fn) {
  plexCacheNow = typeof fn === "function" ? fn : () => Date.now();
}

async function findPlexSeries(config, media) {
  // Namespaced separately from the item cache. For an episode both lookups derive
  // the same key from `media`, so a shared slot lets the episode's ratingKey
  // overwrite its series' - and a later series lookup then returns the episode,
  // whose /allLeaves is empty, so the episode stops matching.
  const cacheKey = `series:${getCacheKey(media, config, { series: true })}`;
  {
    const ratingKey = getRatingKeyCache(cacheKey);
    if (ratingKey) {
      try {
        const item = await fetchPlexMetadataItem(config, ratingKey, { lane: media?.lane || "sync" });
        if (item) {
          return item;
        }
      } catch (error) {
        console.warn(`Direct Plex series lookup by cached ratingKey ${ratingKey} failed, falling back to search`, error.message);
      }
      plexRatingKeyCache.delete(cacheKey);
    }
  }

  const baseUrl = trimTrailingSlash(config.baseUrl);
  const candidates = plexGuidCandidates(media);
  let series;

  if (candidates.length > 0) {
    // One line for the whole fan-out. Logging per candidate meant three or more
    // near-identical entries for every single lookup.
    traceLog("Plex series lookup started", { guids: candidates });
    const lookups = await Promise.allSettled(candidates.map(async (guid) => {
      const url = new URL(`${baseUrl}/library/all`);
      url.searchParams.set("guid", guid);
      url.searchParams.set("type", "2"); // 2 is Show/Series in Plex
      const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
      if (!response.ok) {
        console.error("Plex series lookup failed", { status: response.status, guid });
        return null;
      }
      const body = await response.json();
      return body?.MediaContainer?.Metadata?.find(
        (m) => m.type === "show" || m.type === "series"
      ) || body?.MediaContainer?.Metadata?.[0] || null;
    }));

    const match = lookups.find((r) => r.status === "fulfilled" && r.value?.ratingKey);
    if (match) {
      traceLog("Plex series lookup matched item", { ratingKey: match.value.ratingKey });
      series = match.value;
    }
  }

  if (!series) {
    series = await searchPlexFallback(config, media, "show");
  }

  if (series?.ratingKey) {
    setRatingKeyCache(cacheKey, series.ratingKey);
  }

  return series;
}

export { findPlexSeries };

export async function fetchPlexSeriesEpisodes(config, media, resolvedSeries = null) {
  requirePlexConfig(config);
  const series = resolvedSeries || await findPlexSeries(config, media);
  if (!series?.ratingKey) return [];

  const baseUrl = trimTrailingSlash(config.baseUrl);
  const url = new URL(`${baseUrl}/library/metadata/${series.ratingKey}/allLeaves`);
  url.searchParams.set("includeGuids", "1");
  url.searchParams.set("includeMedia", "1");

  const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
  if (!response.ok) {
    throw new Error(`Plex allLeaves lookup failed with status ${response.status} for series ${series.ratingKey}`);
  }

  const body = await response.json();
  return body?.MediaContainer?.Metadata || [];
}

async function findPlexMovie(config, media) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const candidates = plexGuidCandidates(media);

  if (candidates.length > 0) {
    const lookups = await Promise.allSettled(candidates.map(async (guid) => {
      const url = new URL(`${baseUrl}/library/all`);
      url.searchParams.set("guid", guid);
      url.searchParams.set("type", "1"); // 1 is Movie in Plex
      console.log("Plex movie lookup started", { guid });
      const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
      if (!response.ok) {
        console.error("Plex movie lookup failed", { status: response.status, guid });
        return null;
      }
      const body = await response.json();
      return body?.MediaContainer?.Metadata?.find((m) => m.type === "movie")
        || body?.MediaContainer?.Metadata?.[0] || null;
    }));

    const match = lookups.find((r) => r.status === "fulfilled" && r.value?.ratingKey);
    if (match) {
      console.log("Plex movie lookup matched item", { ratingKey: match.value.ratingKey });
      return match.value;
    }
  }

  return searchPlexFallback(config, media, "movie");
}

function plexProviderIdsFromSeries(series = {}, fallback = {}) {
  const ids = { ...fallback };
  for (const guid of series.Guid || []) {
    const value = String(guid?.id || guid || "");
    const match = value.match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?]+)/i);
    if (!match) continue;
    const provider = match[1].toLowerCase().replace("themoviedb", "tmdb").replace("thetvdb", "tvdb");
    ids[provider] = match[2];
  }
  return ids;
}

function plexSeriesEntryCompatible(entry, media) {
  const requested = media.ids || {};
  return ["imdb", "tmdb", "tvdb"].every((provider) =>
    !requested[provider] || !entry.providerIds[provider]
      || String(requested[provider]).toLowerCase() === String(entry.providerIds[provider]).toLowerCase());
}

function deletePlexSeriesEntry(entry) {
  for (const [alias, value] of plexSeriesIdentityCache) if (value === entry) plexSeriesIdentityCache.delete(alias);
}

function invalidatePlexSeriesIdentity(config, media) {
  for (const alias of plexSeriesAliases(config, media)) {
    const entry = plexSeriesIdentityCache.get(alias);
    if (entry) deletePlexSeriesEntry(entry);
  }
  plexRatingKeyCache.delete(getCacheKey(media, config));
  plexRatingKeyCache.delete(`series:${getCacheKey(media, config, { series: true })}`);
  media?.restoreLookupCache?.delete?.(restoreLookupKey("plex", config, media));
}

async function resolvePlexSeriesIdentity(config, media) {
  const aliases = plexSeriesAliases(config, media);
  // A provider-id lookup can legitimately fall back to a title search. Keep
  // that fallback in-flight across sibling episodes, while guarding against
  // sharing a pending lookup for two conflicting remakes.
  const inFlightAliases = aliases;
  for (const alias of aliases) {
    const entry = plexSeriesIdentityCache.get(alias);
    if (!entry) continue;
    if (entry.expiresAt <= plexCacheNow()) { deletePlexSeriesEntry(entry); continue; }
    if (plexSeriesEntryCompatible(entry, media)) return entry;
  }
  for (const alias of inFlightAliases) {
    const pending = plexSeriesInFlight.get(alias);
    if (pending && mediaIdentitiesCompatible(pending.media, media)) return pending.promise;
  }
  const promise = (async () => {
    const series = await findPlexSeries(config, media);
    const now = plexCacheNow();
    if (!series?.ratingKey) {
      const empty = { series: null, providerIds: media.ids || {}, episodesByCoordinate: new Map(), expiresAt: now + 20_000, createdAt: now };
      for (const alias of aliases) plexSeriesIdentityCache.set(alias, empty);
      return empty;
    }
    // Pass the already-resolved series so this cold lookup performs exactly
    // one series resolution and one allLeaves request.
    const children = await fetchPlexSeriesEpisodes(config, media, series);
    const episodesByCoordinate = new Map();
    for (const child of children) {
      const key = `${Number(child.parentIndex)}:${Number(child.index)}`;
      if (!episodesByCoordinate.has(key)) episodesByCoordinate.set(key, []);
      episodesByCoordinate.get(key).push(child);
    }
    const providerIds = plexProviderIdsFromSeries(series, media.ids || {});
    const entry = { series, providerIds, episodesByCoordinate, expiresAt: now + PLEX_IDENTITY_TTL_MS, createdAt: now };
    const discoveredAliases = [...aliases, ...plexSeriesAliases(config, { ...media, ids: providerIds })];
    for (const alias of new Set(discoveredAliases)) plexSeriesIdentityCache.set(alias, entry);
    const entries = [...new Set(plexSeriesIdentityCache.values())].sort((a, b) => a.createdAt - b.createdAt);
    while (entries.length > PLEX_IDENTITY_MAX_ENTRIES) deletePlexSeriesEntry(entries.shift());
    return entry;
  })();
  const pendingEntry = { media, promise };
  for (const alias of inFlightAliases) plexSeriesInFlight.set(alias, pendingEntry);
  try { return await promise; } finally {
    for (const [alias, pending] of plexSeriesInFlight) if (pending === pendingEntry) plexSeriesInFlight.delete(alias);
  }
}

async function findPlexEpisodeItems(config, media) {
  const parsed = parseShowTitle(media.title);
  const season = media.season ?? parsed.season;
  const episodeNum = media.episode ?? parsed.episode;
  // Personal-rating snapshots keep the leaf title in `title` and the series
  // title in `show_title`. Use the series title when the combined
  // "Show - S01E01" form is not available, otherwise the fallback search can
  // look for an episode title and miss a perfectly valid Plex series.
  const seriesMedia = parsed.season != null || parsed.episode != null || !media.show_title
    ? media
    : { ...media, title: media.show_title };
  const entry = await resolvePlexSeriesIdentity(config, seriesMedia);
  const episodes = compoundEpisodeItemsForMedia(entry.episodesByCoordinate, {
    ...media,
    season,
    episode: episodeNum,
  });
  const episode = episodes[0];

  if (episode?.ratingKey) {
    traceLog("Plex episode matched from series leaves", {
      seriesId: entry.series?.ratingKey,
      itemId: episode.ratingKey,
      itemIds: episodes.map((item) => item.ratingKey).filter(Boolean),
      season,
      episode: episodeNum,
    });
    return episodes;
  }

  return [];
}

async function findPlexEpisode(config, media) {
  return (await findPlexEpisodeItems(config, media))[0];
}

async function findPlexItemUncached(config, media) {
  const cacheKey = getCacheKey(media, config);
  const compoundEpisode = compoundEpisodeForMedia(media);
  // A combined source may need more than the one ratingKey cached for its
  // first local part. Resolve the series leaves so a split Plex catalogue can
  // receive both items instead of reusing only the cached first half.
  if (compoundEpisode?.sourceRepresentation !== "combined") {
    const ratingKey = getRatingKeyCache(cacheKey);
    if (ratingKey) {
      try {
        const item = await fetchPlexMetadataItem(config, ratingKey, { lane: media?.lane || "sync" });
        if (item) {
          return item;
        }
      } catch (error) {
        console.warn(`Direct Plex lookup by cached ratingKey ${ratingKey} failed, falling back to search`, error.message);
      }
      plexRatingKeyCache.delete(cacheKey);
    }
  }

  let item;
  if (media.type === "movie") {
    item = await findPlexMovie(config, media);
  } else if (media.type === "episode") {
    const episodes = await findPlexEpisodeItems(config, media);
    item = episodes[0];
    if (item && episodes.length > 1) item = { ...item, __compoundItems: episodes };
  } else if (media.type === "tv" || media.type === "series" || media.type === "show") {
    item = await findPlexSeries(config, media);
  }

  if (item?.ratingKey) {
    setRatingKeyCache(cacheKey, item.ratingKey);
  }

  return item;
}

export async function findPlexItem(config, media) {
  const [directRatingKey] = nativeProviderItemIds(media, "plex");
  if (directRatingKey) return { ratingKey: directRatingKey };

  const cache = media?.restoreLookupCache;
  if (cache && typeof cache.resolve === "function") {
    return cache.resolve(
      restoreLookupKey("plex", config, media),
      media,
      () => findPlexItemUncached(config, media),
    );
  }
  return findPlexItemUncached(config, media);
}

async function findPlexItemForMutation(config, media) {
  const item = await findPlexItem(config, media);
  if (item?.ratingKey || media.type !== "episode" || media.__identityRetry) return item;

  // The cached allLeaves list can predate an item added or reindexed in Plex.
  // Refresh once on an exact episode miss before reporting not_found.
  traceLog("Plex episode lookup missed; refreshing the cached series index", {
    title: media.title,
    season: media.season,
    episode: media.episode,
  });
  invalidatePlexSeriesIdentity(config, media);
  return findPlexItem(config, { ...media, __identityRetry: true });
}

function noMatchingPlexItem(media = {}) {
  return {
    platform: "plex",
    status: "not_found",
    detail: media.type === "episode"
      ? "No matching episode was found after refreshing the series episode list"
      : "No matching item found",
  };
}

// True only when every item Plex resolved for this media is already watched, so
// a mark-watched request would change nothing. Plex records `/:/scrobble` using
// its own clock, which means a redundant scrobble silently moves the item's
// activity date to today - exactly what a reconcile pass must not keep doing.
//
// The item Plex returned usually already carries `viewCount`. When it does not
// (a cached ratingKey resolved without metadata), one extra lookup is worth
// spending on a projection of state Plembfin already holds - a historical
// import, or a user's explicit mark-watched - but not on a live playback event,
// which is a new state change we intend to write regardless.
async function plexItemsAlreadyWatched(config, items, media) {
  const lane = media?.lane || "sync";
  const intent = resolveWatchSyncIntent(media);
  const compareBeforeWriting = isHistoricalWatchIntent(intent) || intent === "manual";
  const states = await Promise.all(items.map(async (targetItem) => {
    if (targetItem?.viewCount !== undefined && targetItem?.viewCount !== null) {
      return Number(targetItem.viewCount) > 0;
    }
    if (!compareBeforeWriting || !targetItem?.ratingKey) return null;
    const metadata = await fetchPlexMetadataItem(config, targetItem.ratingKey, { lane }).catch(() => null);
    if (!metadata) return null;
    return Number(metadata.viewCount || 0) > 0;
  }));
  return states.length > 0 && states.every((state) => state === true);
}

export async function markPlexPlayed(config, media) {
  try {
    requirePlexConfig(config);

    // Adapter-level enforcement of the provider matrix, deliberately redundant
    // with syncOrchestrator's target filtering: `/:/scrobble` is the only
    // supported watched-state write Plex offers and it always stamps the
    // server's current time, so a historical projection the user has disabled
    // must not be able to reach this client from any entry point.
    if (!plexHistoricalWatchedAllowed(media)) {
      console.log("Plex mark played skipped by historical sync policy", { title: media?.title });
      return { platform: "plex", status: "skipped_by_policy", detail: PLEX_POLICY_SKIP_DETAIL };
    }

    const item = await findPlexItemForMutation(config, media);
    if (!item?.ratingKey) {
      console.log(`[NOT FOUND] No matching item in Plex library for: "${media.title}"`);
      return noMatchingPlexItem(media);
    }

    const items = item.__compoundItems || [item];
    // Native Up Next refresh deliberately performs an unscrobble immediately
    // before this call. A stale Plex metadata response must not collapse the
    // second half of that transition into an idempotent no-op.
    if (!media?.forcePlayedWrite && await plexItemsAlreadyWatched(config, items, media)) {
      console.log("Plex item already watched; no mark-played request sent", { ratingKey: items[0].ratingKey });
      return {
        platform: "plex",
        status: "already_matching",
        detail: PLEX_ALREADY_MATCHING_DETAIL,
        itemId: items[0].ratingKey,
        itemIds: items.map((targetItem) => targetItem.ratingKey),
      };
    }
    let lastHttpStatus = 200;
    await Promise.all(items.map(async (targetItem) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/scrobble`);
      url.searchParams.set("key", targetItem.ratingKey);
      url.searchParams.set("identifier", "com.plexapp.plugins.library");
      await addConfiguredPlexAccountId(url, config, { lane: media?.lane || "sync" });

      const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
      if (!response.ok) {
        const error = new Error(`Plex scrobble failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      lastHttpStatus = response.status;
      console.log("Plex item marked played", { ratingKey: targetItem.ratingKey });
    }));
    return { platform: "plex", status: "fulfilled", itemId: items[0].ratingKey, itemIds: items.map((targetItem) => targetItem.ratingKey), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidatePlexSeriesIdentity(config, media);
      return markPlexPlayed(config, { ...media, __identityRetry: true });
    }
    console.error("Plex client failed", error);
    throw error;
  }
}

export async function markPlexUnplayed(config, media) {
  try {
    requirePlexConfig(config);

    const item = await findPlexItemForMutation(config, media);
    if (!item?.ratingKey) {
      console.log(`[NOT FOUND] No matching item in Plex library for: "${media.title}"`);
      return noMatchingPlexItem(media);
    }

    const items = item.__compoundItems || [item];
    let lastHttpStatus = 200;
    await Promise.all(items.map(async (targetItem) => {
      const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/unscrobble`);
      url.searchParams.set("key", targetItem.ratingKey);
      url.searchParams.set("identifier", "com.plexapp.plugins.library");
      await addConfiguredPlexAccountId(url, config, { lane: media?.lane || "sync" });

      const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
      if (!response.ok) {
        const error = new Error(`Plex unscrobble failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      lastHttpStatus = response.status;
      console.log("Plex item marked unplayed", { ratingKey: targetItem.ratingKey });
    }));
    return { platform: "plex", status: "fulfilled", itemId: items[0].ratingKey, itemIds: items.map((targetItem) => targetItem.ratingKey), httpStatus: lastHttpStatus };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidatePlexSeriesIdentity(config, media);
      return markPlexUnplayed(config, { ...media, __identityRetry: true });
    }
    console.error("Plex client failed", error);
    throw error;
  }
}

export async function setPlexProgress(config, media) {
  try {
    requirePlexConfig(config);

    const item = await findPlexItemForMutation(config, media);
    if (!item?.ratingKey) {
      console.log(`[NOT FOUND] No matching item in Plex library for: "${media.title}"`);
      return noMatchingPlexItem(media);
    }

    const positionMs = Math.max(0, Math.round(Number(media.positionMs ?? media.offsetMs ?? 0)));
    const hasPosition = media.positionMs !== undefined || media.offsetMs !== undefined;
    if (!hasPosition) {
      return { platform: "plex", status: "skipped", detail: "No resume position supplied" };
    }

    const unscrobbleUrl = new URL(`${trimTrailingSlash(config.baseUrl)}/:/unscrobble`);
    unscrobbleUrl.searchParams.set("key", item.ratingKey);
    unscrobbleUrl.searchParams.set("identifier", "com.plexapp.plugins.library");
    await addConfiguredPlexAccountId(unscrobbleUrl, config, { lane: media?.lane || "sync" });

    const unscrobbleResponse = await fetchPlexWithRefresh(config, unscrobbleUrl, { lane: media?.lane || "sync" });
    if (!unscrobbleResponse.ok) {
      const error = new Error(`Plex progress unscrobble failed with status ${unscrobbleResponse.status}`);
      error.status = unscrobbleResponse.status;
      throw error;
    }

    const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/progress`);
    url.searchParams.set("key", item.ratingKey);
    url.searchParams.set("identifier", "com.plexapp.plugins.library");
    url.searchParams.set("time", String(positionMs));
    url.searchParams.set("state", "stopped");
    await addConfiguredPlexAccountId(url, config, { lane: media?.lane || "sync" });

    const response = await fetchPlexWithRefresh(config, url, { lane: media?.lane || "sync" });
    if (!response.ok) {
      const error = new Error(`Plex progress update failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }

    console.log("Plex item resume progress updated", { ratingKey: item.ratingKey, positionMs });
    return { platform: "plex", status: "fulfilled", itemId: item.ratingKey, positionMs, httpStatus: response.status };
  } catch (error) {
    if (error?.status === 404 && media.type === "episode" && !media.__identityRetry) {
      invalidatePlexSeriesIdentity(config, media);
      return setPlexProgress(config, { ...media, __identityRetry: true });
    }
    console.error("Plex progress client failed", error);
    throw error;
  }
}

// Mark unplayed directly by ratingKey, skipping the search/match step. Used by the
// authoritative restore clear pass, which already has the native ratingKey from
// fetchPlexWatchedItems and doesn't need to re-resolve the item.
export async function markPlexUnplayedByRatingKey(config, ratingKey, { lane = "sync" } = {}) {
  requirePlexConfig(config);
  if (!ratingKey) return { platform: "plex", status: "not_found" };

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/unscrobble`);
  url.searchParams.set("key", String(ratingKey));
  url.searchParams.set("identifier", "com.plexapp.plugins.library");
  await addConfiguredPlexAccountId(url, config, { lane });

  const response = await fetchPlexWithRefresh(config, url, { lane });
  if (!response.ok) {
    throw new Error(`Plex unscrobble failed with status ${response.status} for ratingKey ${ratingKey}`);
  }
  return { platform: "plex", status: "fulfilled", itemId: ratingKey, httpStatus: response.status };
}

// Plex stores Continue Watching dismissal separately from playstate. Apply the
// native dismissal as well as Plembfin's canonical progress clear so the item
// disappears from both dashboards without pretending that one implies the other.
export async function hidePlexFromContinueWatching(config, ratingKey, { lane = "interactive" } = {}) {
  requirePlexConfig(config);
  if (!ratingKey) return { platform: "plex", status: "not_found" };
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/actions/removeFromContinueWatching`);
  url.searchParams.set("ratingKey", String(ratingKey));
  await addConfiguredPlexAccountId(url, config, { lane });
  const response = await fetchPlexWithRefresh(config, url, { method: "PUT", lane });
  if (!response.ok) throw new Error(`Plex Continue Watching removal failed with status ${response.status} for ratingKey ${ratingKey}`);
  return { platform: "plex", status: "fulfilled", itemId: String(ratingKey), httpStatus: response.status };
}

// Fetches a single library item by its native ratingKey, including provider GUIDs and
// the requesting token's user data (viewCount / viewOffset). Used by the notification
// listener to resolve a changed ratingKey into a media object and decide whether the
// item transitioned to unwatched. Returns null when the item no longer exists.
export async function fetchPlexMetadataItem(config, ratingKey, { lane = "sync" } = {}) {
  requirePlexConfig(config);
  if (!ratingKey) return null;

  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/library/metadata/${encodeURIComponent(ratingKey)}`);
  url.searchParams.set("includeGuids", "1");
  await addConfiguredPlexAccountId(url, config, { lane });

  const response = await fetchPlexWithRefresh(config, url, { lane });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Plex metadata lookup failed with status ${response.status} for ratingKey ${ratingKey}`);
  }
  const body = await response.json();
  return body?.MediaContainer?.Metadata?.[0] || null;
}

function plexRatingKeyFromReference(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/\/library\/metadata\/([^/?#]+)/i);
  if (!match) return raw.replace(/^\/+/, "").split(/[/?#]/, 1)[0];
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function plexEpisodeSeriesMetadataCacheKey(config, ratingKey) {
  return `${plexConnectionScope(config)}:${ratingKey}`;
}

function cachedPlexEpisodeSeriesMetadata(cacheKey) {
  const entry = plexEpisodeSeriesMetadataCache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= plexCacheNow()) {
    plexEpisodeSeriesMetadataCache.delete(cacheKey);
    return undefined;
  }
  return entry.series;
}

function cachePlexEpisodeSeriesMetadata(cacheKey, series) {
  const now = plexCacheNow();
  plexEpisodeSeriesMetadataCache.set(cacheKey, {
    series,
    expiresAt: now + (series ? PLEX_EPISODE_SERIES_METADATA_TTL_MS : PLEX_EPISODE_SERIES_METADATA_NEGATIVE_TTL_MS),
  });
  while (plexEpisodeSeriesMetadataCache.size > PLEX_EPISODE_SERIES_METADATA_MAX_ENTRIES) {
    plexEpisodeSeriesMetadataCache.delete(plexEpisodeSeriesMetadataCache.keys().next().value);
  }
}

function mergePlexEpisodeSeriesMetadata(metadata, series) {
  if (!series) return metadata;
  const merged = { ...metadata };
  if (!merged.grandparentTitle && series.title) merged.grandparentTitle = series.title;
  if (!merged.grandparentRatingKey && series.ratingKey) merged.grandparentRatingKey = series.ratingKey;
  if (!merged.grandparentGuid && !merged.grandparentGUID && series.guid) merged.grandparentGuid = series.guid;

  const seriesGuids = Array.isArray(series.Guid)
    ? series.Guid
    : series.Guid
      ? [series.Guid]
      : series.guid
        ? [{ id: series.guid }]
        : [];
  const existingSeriesGuids = merged.GrandparentGuid || merged.GrandparentGUID;
  if ((!Array.isArray(existingSeriesGuids) || existingSeriesGuids.length === 0) && seriesGuids.length) {
    merged.GrandparentGuid = seriesGuids;
  }
  return merged;
}

// Plex episode metadata sometimes contains the native grandparent key but omits
// grandparentGuid/GrandparentGuid from the response. Trakt and the other media
// servers need the series identity, not the episode's own provider ids. Resolve
// that parent by Plex's native key before normalizing the notification, then cache
// it so a bulk show change does not fetch the same series once per episode.
export async function hydratePlexEpisodeMetadata(config, metadata, { lane = "sync" } = {}) {
  if (String(metadata?.type || "").toLowerCase() !== "episode") return metadata;

  const parentReference = metadata.grandparentRatingKey
    || metadata.grandparentKey
    || metadata.grandparentId;
  const parentRatingKey = plexRatingKeyFromReference(parentReference);
  if (!parentRatingKey || parentRatingKey === String(metadata.ratingKey || "")) return metadata;

  const cacheKey = plexEpisodeSeriesMetadataCacheKey(config, parentRatingKey);
  const cached = cachedPlexEpisodeSeriesMetadata(cacheKey);
  if (cached !== undefined) return mergePlexEpisodeSeriesMetadata(metadata, cached);

  let pending = plexEpisodeSeriesMetadataInFlight.get(cacheKey);
  if (!pending) {
    pending = fetchPlexMetadataItem(config, parentRatingKey, { lane })
      .then((series) => {
        const type = String(series?.type || "").toLowerCase();
        const normalizedSeries = !series || !type || type === "show" || type === "series" ? series : null;
        cachePlexEpisodeSeriesMetadata(cacheKey, normalizedSeries);
        return normalizedSeries;
      });
    plexEpisodeSeriesMetadataInFlight.set(cacheKey, pending);
  }

  try {
    return mergePlexEpisodeSeriesMetadata(metadata, await pending);
  } finally {
    if (plexEpisodeSeriesMetadataInFlight.get(cacheKey) === pending) {
      plexEpisodeSeriesMetadataInFlight.delete(cacheKey);
    }
  }
}

// Adaptive history rows contain the current user watch state but can omit the
// provider Guid collection. Keep those state fields authoritative while
// retaining the richer identity returned by /library/metadata/{ratingKey}.
export function mergePlexMetadataItem(authoritative = null, stateOverride = null) {
  if (!authoritative) return stateOverride || null;
  if (!stateOverride) return authoritative;
  const merged = { ...authoritative, ...stateOverride };
  if (Array.isArray(authoritative.Guid) && authoritative.Guid.length) merged.Guid = authoritative.Guid;
  if (authoritative.guid) merged.guid = authoritative.guid;
  return merged;
}

// Expands a show/season notification into the episodes whose user state Plex changed.
// Plex emits container timeline entries for bulk "mark watched/unwatched" actions, so
// listening only for episode entries leaves those actions invisible until fallback polling.
export async function fetchPlexContainerEpisodes(config, ratingKey, containerType = "show", { lane = "sync" } = {}) {
  requirePlexConfig(config);
  if (!ratingKey) return [];

  const suffix = containerType === "season" ? "children" : "allLeaves";
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/library/metadata/${encodeURIComponent(ratingKey)}/${suffix}`);
  url.searchParams.set("includeGuids", "1");
  await addConfiguredPlexAccountId(url, config, { lane });

  const response = await fetchPlexWithRefresh(config, url, { lane });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Plex ${containerType} episode lookup failed with status ${response.status} for ratingKey ${ratingKey}`);
  }
  const body = await response.json();
  return (body?.MediaContainer?.Metadata || []).filter((item) => item?.type === "episode");
}

async function fetchPlexLibraryDirectories(config, ratingScan = false) {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const sectionsUrl = new URL(`${baseUrl}/library/sections`);
  const sectionsRes = await fetchPlexWithRefresh(config, sectionsUrl);
  if (!sectionsRes.ok) {
    throw new Error(`Plex failed to fetch library sections: ${sectionsRes.status}`);
  }
  const sectionsData = await sectionsRes.json();
  return ratingScan ? ratingSnapshotArray(sectionsData?.MediaContainer?.Directory, "Plex libraries", { empty: sectionsData?.MediaContainer?.size === 0 }) : sectionsData?.MediaContainer?.Directory || [];
}

// Movie/show library sections with their stable section keys, for sync scope
// selection. The section key is Plex's stable library identity.
export async function listPlexLibraries(config) {
  requirePlexConfig(config);
  const directories = await fetchPlexLibraryDirectories(config);
  return directories
    .filter((dir) => dir.type === "movie" || dir.type === "show")
    .map((dir) => ({ id: String(dir.key), name: String(dir.title || dir.key), type: dir.type === "movie" ? "movie" : "show" }));
}

function selectPlexSections(directories, libraryIds) {
  const wanted = Array.isArray(libraryIds) && libraryIds.length ? new Set(libraryIds.map(String)) : null;
  return directories.filter((dir) => {
    if (dir.type !== "movie" && dir.type !== "show") return false;
    return !wanted || wanted.has(String(dir.key));
  });
}

// Full, paginated library inventory used by the scheduled availability
// reconciliation. Unlike fetchPlexWatchedItems this intentionally includes
// unplayed items, because a newly added quality/library variant is normally
// unplayed on Plex even when Plembfin already knows the episode was watched.
export async function fetchPlexLibraryItems(config, { libraryIds } = {}) {
  requirePlexConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const accountId = await resolvePlexAccountId(config);
  const directories = await fetchPlexLibraryDirectories(config);
  const libraryItems = [];
  const pageSize = 200;

  for (const dir of selectPlexSections(directories, libraryIds)) {
    let start = 0;
    let totalSize = 0;
    const seen = new Set();
    while (start <= 10_000_000) {
      const allUrl = new URL(`${baseUrl}/library/sections/${dir.key}/all`);
      allUrl.searchParams.set("type", dir.type === "movie" ? "1" : "4");
      allUrl.searchParams.set("unwatched", "1");
      allUrl.searchParams.set("includeGuids", "1");
      allUrl.searchParams.set("includeMedia", "1");
      allUrl.searchParams.set("includeUserState", "1");
      allUrl.searchParams.set("X-Plex-Container-Start", String(start));
      allUrl.searchParams.set("X-Plex-Container-Size", String(pageSize));
      if (accountId != null) allUrl.searchParams.set("accountID", String(accountId));

      const response = await fetchPlexWithRefresh(config, allUrl, { lane: "sync" });
      if (!response.ok) {
        throw new Error(`Plex library inventory failed with status ${response.status} for section ${dir.key}`);
      }
      const body = await response.json();
      const container = body?.MediaContainer || {};
      const page = Array.isArray(container.Metadata) ? container.Metadata : [];
      let newItems = 0;
      for (const item of page) {
        const id = String(item?.ratingKey || item?.key || "").trim();
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        // Keep the evidence that this item came from the explicit
        // `unwatched=1` inventory. A few Plex versions omit viewCount when a
        // filtered library feed is requested, even with includeUserState=1.
        libraryItems.push({ ...item, __plembfinUnwatchedFeed: true });
        newItems += 1;
      }

      totalSize = Number(container.totalSize || 0);
      if (!page.length || !newItems || (totalSize > 0 && start + page.length >= totalSize) || (totalSize <= 0 && page.length < pageSize)) break;
      start += page.length;
    }
  }

  return libraryItems;
}

export async function fetchPlexWatchedItems(config, { libraryIds } = {}) {
  requirePlexConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const accountId = await resolvePlexAccountId(config);
  const directories = await fetchPlexLibraryDirectories(config);

  const watchedItems = [];

  for (const dir of selectPlexSections(directories, libraryIds)) {
    const sectionId = dir.key;
    const type = dir.type;

    const allUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
    allUrl.searchParams.set("unwatched", "0");
    if (accountId != null) {
      allUrl.searchParams.set("accountID", String(accountId));
    }

    if (type === "movie") {
      allUrl.searchParams.set("type", "1");
    } else {
      allUrl.searchParams.set("type", "4");
    }

    try {
      const allRes = await fetchPlexWithRefresh(config, allUrl);
      if (allRes.ok) {
        const allData = await allRes.json();
        const metadata = allData?.MediaContainer?.Metadata || [];
        watchedItems.push(...metadata.filter((item) => Number(item.viewCount || 0) > 0));
      }
    } catch (err) {
      console.error(`Plex failed to fetch watched items for section ${sectionId}`, err);
    }
  }

  return watchedItems;
}

// Cheap watched-item count (no metadata payload): asks each section for a
// zero-size container and reads totalSize. Used for plan staleness checks.
export async function countPlexWatchedItems(config, { libraryIds } = {}) {
  requirePlexConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const accountId = await resolvePlexAccountId(config);
  const directories = await fetchPlexLibraryDirectories(config);

  let total = 0;
  for (const dir of selectPlexSections(directories, libraryIds)) {
    const allUrl = new URL(`${baseUrl}/library/sections/${dir.key}/all`);
    allUrl.searchParams.set("unwatched", "0");
    allUrl.searchParams.set("type", dir.type === "movie" ? "1" : "4");
    if (accountId != null) allUrl.searchParams.set("accountID", String(accountId));
    allUrl.searchParams.set("X-Plex-Container-Start", "0");
    allUrl.searchParams.set("X-Plex-Container-Size", "0");

    const allRes = await fetchPlexWithRefresh(config, allUrl);
    if (!allRes.ok) throw new Error(`Plex watched count failed with status ${allRes.status} for section ${dir.key}`);
    const allData = await allRes.json();
    const container = allData?.MediaContainer || {};
    total += Number(container.totalSize ?? container.size ?? 0);
  }
  return total;
}

export async function fetchPlexResumableItems(config, { limit = 0 } = {}) {
  requirePlexConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const accountId = await resolvePlexAccountId(config);

  const sectionsUrl = new URL(`${baseUrl}/library/sections`);
  const sectionsRes = await fetchPlexWithRefresh(config, sectionsUrl);
  if (!sectionsRes.ok) {
    throw new Error(`Plex failed to fetch library sections: ${sectionsRes.status}`);
  }

  const sectionsData = await sectionsRes.json();
  const directories = sectionsData?.MediaContainer?.Directory || [];
  const resumableItems = [];
  const maxItems = Math.max(0, Math.round(Number(limit) || 0));

  for (const dir of directories) {
    const sectionId = dir.key;
    const type = dir.type;
    if (type !== "movie" && type !== "show") continue;

    const allUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
    if (accountId != null) allUrl.searchParams.set("accountID", String(accountId));
    allUrl.searchParams.set("sort", "lastViewedAt:desc");
    allUrl.searchParams.set("type", type === "movie" ? "1" : "4");
    allUrl.searchParams.set("includeGuids", "1");

    try {
      const allRes = await fetchPlexWithRefresh(config, allUrl);
      if (!allRes.ok) continue;
      const allData = await allRes.json();
      const metadata = allData?.MediaContainer?.Metadata || [];
      for (const item of metadata) {
        if (Number(item.viewOffset || 0) <= 0) continue;
        resumableItems.push(item);
        if (maxItems && resumableItems.length >= maxItems) return resumableItems;
      }
    } catch (err) {
      console.error(`Plex failed to fetch resumable items for section ${sectionId}`, err);
    }
  }

  return resumableItems;
}

function plexContinueWatchingItems(body) {
  const hubs = body?.MediaContainer?.Hub || body?.Hub || [];
  const normalizedHubs = Array.isArray(hubs) ? hubs : [hubs];
  // Continue Watching is already a provider-curated membership feed. Plex's
  // hub response does not consistently include viewOffset (the connected
  // Plex app's response omits it entirely), so filtering on that field would
  // discard every valid item from the native rail.
  return normalizedHubs.flatMap((hub) => Array.isArray(hub?.Metadata) ? hub.Metadata : [])
    .filter((item) => ["movie", "episode"].includes(String(item.type || "").toLowerCase()))
    .filter((item) => String(item.ratingKey || item.key || "").trim());
}

// Plex exposes Continue Watching as an account-scoped hub. Some older servers
// do not expose that hub, so the section scan remains the fallback.
export async function fetchPlexContinueWatchingItems(config, { limit = 0 } = {}) {
  requirePlexConfig(config);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const accountId = await resolvePlexAccountId(config);
  try {
    const requestedLimit = Number(limit) > 0 ? Math.max(1, Math.round(Number(limit))) : 0;
    const pageSize = requestedLimit ? Math.min(requestedLimit, 100) : 100;
    const collected = [];
    const seen = new Set();
    let foundHub = false;
    for (let start = 0; start <= 10_000_000; start += pageSize) {
      const url = new URL(`${baseUrl}/hubs/continueWatching`);
      url.searchParams.set("includeGuids", "1");
      url.searchParams.set("includeUserState", "1");
      url.searchParams.set("includeMeta", "1");
      url.searchParams.set("sort", "lastViewedAt:desc");
      url.searchParams.set("X-Plex-Container-Start", String(start));
      url.searchParams.set("X-Plex-Container-Size", String(pageSize));
      if (accountId != null) url.searchParams.set("accountID", String(accountId));

      const response = await fetchPlexWithRefresh(config, url);
      if (!response.ok) break;
      const body = await response.json();
      const hub = body?.MediaContainer?.Hub ?? body?.Hub;
      if (!(Array.isArray(hub) || (hub && typeof hub === "object"))) break;
      foundHub = true;
      const page = plexContinueWatchingItems(body);
      let newItems = 0;
      for (const item of page) {
        const id = String(item?.ratingKey || item?.key || "").trim();
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        collected.push(item);
        newItems++;
        if (requestedLimit && collected.length >= requestedLimit) return collected.slice(0, requestedLimit);
      }
      const total = Number(body?.MediaContainer?.totalSize || 0);
      if (!page.length || !newItems || (total > 0 && start + page.length >= total) || (total <= 0 && page.length < pageSize)) break;
    }
    if (foundHub) {
      return requestedLimit ? collected.slice(0, requestedLimit) : collected;
    }
  } catch (error) {
    console.warn(`Plex Continue Watching feed unavailable; using section fallback: ${error.message}`);
  }
  return fetchPlexResumableItems(config, { limit });
}

export const fetchPlexContinueWatching = fetchPlexContinueWatchingItems;

// ---------------------------------------------------------------------------
// Personal ratings
// ---------------------------------------------------------------------------

function plexRatingProviderIds(item = {}, parent = null) {
  const values = [];
  const add = (value) => {
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  };
  add(item.Guid);
  add(item.guid);
  add(parent?.Guid);
  add(parent?.guid);
  const ids = {};
  for (const raw of values) {
    const value = String(raw?.id || raw || "");
    const match = value.match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?]+)/i);
    if (!match) continue;
    const provider = match[1].toLowerCase().replace("themoviedb", "tmdb").replace("thetvdb", "tvdb");
    ids[provider] = match[2];
  }
  return ids;
}

function plexRatingParentProviderIds(item = {}) {
  const values = [];
  const add = (value) => {
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  };
  add(item.GrandparentGuid);
  add(item.GrandparentGUID);
  add(item.grandparentGuid);
  add(item.grandparentGUID);
  const ids = {};
  for (const raw of values) {
    const value = String(raw?.id || raw || "");
    const match = value.match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?]+)/i);
    if (!match) continue;
    const provider = match[1].toLowerCase().replace("themoviedb", "tmdb").replace("thetvdb", "tvdb");
    ids[provider] = match[2];
  }
  return ids;
}

async function fetchPlexRatingSectionItems(config, directory, type, accountId) {
  const items = [];
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const pageSize = 500;
  for (let start = 0; start <= 10_000_000; start += pageSize) {
    const url = new URL(`${baseUrl}/library/sections/${directory.key}/all`);
    url.searchParams.set("type", String(type));
    url.searchParams.set("includeGuids", "1");
    url.searchParams.set("includeUserState", "1");
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(pageSize));
    if (accountId != null) url.searchParams.set("accountID", String(accountId));
    const response = await fetchPlexWithRefresh(config, url, { lane: "sync" });
    if (!response.ok) {
      const error = new Error(`Plex rating scan failed with status ${response.status} for section ${directory.key}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const page = plexRatingSnapshotPage(body?.MediaContainer, start, pageSize);
    items.push(...page);
    const total = Number(body?.MediaContainer?.totalSize || 0);
    if (!page.length || page.length < pageSize || (total > 0 && start + page.length >= total)) return items;
  }
  throw new Error("Plex rating snapshot exceeded the pagination safety limit");
}

function plexRatingMedia(item, mediaType, parent = null) {
  const ids = plexRatingProviderIds(item, parent);
  const isEpisode = mediaType === "episode";
  const parentIds = isEpisode ? { ...plexRatingParentProviderIds(item), ...plexRatingProviderIds(parent || {}) } : {};
  return {
    media_type: isEpisode ? "episode" : mediaType === "show" ? "tv" : "movie",
    title: String(item.title || item.grandparentTitle || item.parentTitle || "Untitled"),
    tmdb_id: isEpisode ? parentIds.tmdb || "" : ids.tmdb || "",
    tvdb_id: isEpisode ? parentIds.tvdb || "" : ids.tvdb || "",
    imdb_id: isEpisode ? parentIds.imdb || "" : ids.imdb || "",
    show_title: isEpisode ? String(item.grandparentTitle || item.parentTitle || "") : "",
    show_tmdb_id: isEpisode ? parentIds.tmdb || "" : "",
    show_tvdb_id: isEpisode ? parentIds.tvdb || "" : "",
    show_imdb_id: isEpisode ? parentIds.imdb || "" : "",
    episode_tmdb_id: isEpisode ? ids.tmdb || "" : "",
    episode_tvdb_id: isEpisode ? ids.tvdb || "" : "",
    episode_imdb_id: isEpisode ? ids.imdb || "" : "",
    season: isEpisode ? Number(item.parentIndex) : null,
    episode: isEpisode ? Number(item.index) : null,
    year: Number(item.year || 0) || null,
    poster_url: "",
  };
}

export async function fetchPlexPersonalRatingSnapshot(config) {
  requirePlexConfig(config);
  const accountId = await resolvePlexAccountId(config);
  const directories = await fetchPlexLibraryDirectories(config, true);
  const records = [];
  for (const directory of selectPlexSections(directories)) {
    const types = directory.type === "movie" ? [{ type: 1, mediaType: "movie" }] : [
      { type: 2, mediaType: "show" },
      { type: 4, mediaType: "episode" },
    ];
    for (const entry of types) {
      const items = await fetchPlexRatingSectionItems(config, directory, entry.type, accountId);
      for (const item of items) {
        const rating = Number(item.userRating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 10) continue;
        records.push({
          media: plexRatingMedia(item, entry.mediaType, null),
          providerItemId: String(item.ratingKey || ""),
          providerIds: { plex: String(item.ratingKey || ""), ...plexRatingProviderIds(item) },
          rating,
          ratedAt: null,
        });
      }
    }
  }
  return records;
}

async function writePlexPersonalRating(config, media, rating, { lane = "sync" } = {}) {
  requirePlexConfig(config);
  const lookup = {
    ...media,
    type: media.media_type || media.mediaType || media.type,
    ids: {
      tmdb: media.show_tmdb_id || media.tmdb_id,
      tvdb: media.show_tvdb_id || media.tvdb_id,
      imdb: media.show_imdb_id || media.imdb_id,
    },
  };
  const item = await findPlexItem(config, lookup);
  if (!item?.ratingKey) return { platform: "plex", status: "not_found" };
  const url = new URL(`${trimTrailingSlash(config.baseUrl)}/:/rate`);
  url.searchParams.set("key", String(item.ratingKey));
  url.searchParams.set("rating", String(rating));
  url.searchParams.set("identifier", "com.plexapp.plugins.library");
  await addConfiguredPlexAccountId(url, config, { lane });
  const response = await fetchPlexWithRefresh(config, url, { method: "PUT", lane });
  if (response.status === 404) return { platform: "plex", status: "not_found", itemId: item.ratingKey };
  if (!response.ok) {
    const error = new Error(`Plex personal rating update failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { platform: "plex", status: "fulfilled", itemId: item.ratingKey, httpStatus: response.status };
}

export function setPlexPersonalRating(config, media, rating, options = {}) {
  return writePlexPersonalRating(config, media, Math.max(1, Math.min(10, Math.round(Number(rating)))), options);
}

export function clearPlexPersonalRating(config, media, options = {}) {
  // Plex clears a user rating through the same endpoint with rating=0.
  return writePlexPersonalRating(config, media, 0, options);
}
