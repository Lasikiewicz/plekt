import { getValidPlexToken } from "./plexTokenManager.js";
import { normalizePersonalWatchlistMedia } from "./personalWatchlistIdentity.js";
import {
  clean,
  listItems,
  normalizeRemoteMedia,
  pageResult,
  providerIdsMatch,
  requestJson,
  sortRemoteTargets,
  titleAndYearMatch,
  trimTrailingSlash,
} from "./watchlistAdapterUtils.js";
import { fetchWithTimeout } from "./outbound.js";

const DEFAULT_PLEX_CLIENT_IDENTIFIER = "plembfin-watchlist";

function looksLikeJwt(value) {
  return String(value || "").split(".").length === 3;
}

async function accountToken(config = {}) {
  if (config.accountToken || config.watchlistToken) return String(config.accountToken || config.watchlistToken);
  // A connected Plex account may expose a server token on the resolved media
  // config. Never use that token for Universal Watchlist calls: ask the token
  // manager for the account JWT instead.
  if ((config.connectionId && config.connectionId !== "legacy") || config.authKind === "plex_jwt" || config.authKind === "plex_managed_jwt" || looksLikeJwt(config.token)) {
    return getValidPlexToken();
  }
  return String(config.token || "");
}

// `config.baseUrl` is the selected Plex Media Server URL. Universal Watchlist is
// account-scoped, so never silently send account requests to that server. A
// deployment may provide an explicitly validated private/account base; otherwise
// use Plex's account service hosts.
//
// The watchlist section, its add/remove actions, and catalog search all live on
// the discover host. Verified against the live account API: the metadata host
// answers `/library/sections/watchlist/all` with 404 "Section 'watchlist' not
// found!", while the discover host returns the account's watchlist. Both stay
// overridable so a deployment can point them elsewhere.
function baseUrl(config = {}) {
  return trimTrailingSlash(config.watchlistBaseUrl || "https://discover.provider.plex.tv");
}

function discoverUrl(config = {}) {
  return trimTrailingSlash(config.watchlistDiscoverUrl || config.watchlistBaseUrl || "https://discover.provider.plex.tv");
}

function urlFor(config, pathname, params = {}, host = baseUrl(config)) {
  const url = new URL(`${host}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function plexHeaders(config) {
  const token = await accountToken(config);
  if (!token) {
    const error = new Error("Plex watchlist needs an account token");
    error.code = "WATCHLIST_NOT_CONFIGURED";
    error.status = 424;
    throw error;
  }
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": String(config.clientIdentifier || DEFAULT_PLEX_CLIENT_IDENTIFIER),
  };
}

async function plexRequest(config, pathname, { method = "GET", params = {}, body, host } = {}) {
  const headers = await plexHeaders(config);
  return requestJson(urlFor(config, pathname, params, host || baseUrl(config)), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    lane: "sync",
  });
}

function parseGuid(value) {
  const text = String(value || "");
  const match = text.match(/(?:^|[|,\s])((?:imdb|tmdb|tvdb)):\/\/([^|,\s]+)/i);
  if (!match) return null;
  return { provider: match[1].toLowerCase(), value: clean(match[2], 100) };
}

function plexProviderIds(item = {}) {
  const ids = {
    tmdb: clean(item.tmdb_id || item.tmdb || "", 100),
    tvdb: clean(item.tvdb_id || item.tvdb || "", 100),
    imdb: clean(item.imdb_id || item.imdb || "", 100),
  };
  const raw = Array.isArray(item.Guid) ? item.Guid : Array.isArray(item.guid) ? item.guid : typeof item.guid === "string" ? item.guid.split(/[|,\s]+/) : [];
  for (const entry of raw) {
    const parsed = parseGuid(typeof entry === "object" ? entry.id || entry.guid : entry);
    if (parsed && parsed.provider in ids && !ids[parsed.provider]) ids[parsed.provider] = parsed.value;
  }
  const guid = parseGuid(item.guid || item.Guid);
  if (guid && guid.provider in ids && !ids[guid.provider]) ids[guid.provider] = guid.value;
  return ids;
}

function normalizePlexItem(item, itemId = "") {
  const ids = plexProviderIds(item);
  const normalized = normalizeRemoteMedia({
    ...item,
    type: String(item.type || item.Type || "").toLowerCase() === "show" ? "series" : item.type || item.Type,
    Name: item.title || item.title_sort || item.grandparentTitle || item.Name,
    ProviderIds: ids,
    ProductionYear: item.year || item.ProductionYear,
    PremiereDate: item.originallyAvailableAt || item.PremiereDate,
  }, { provider: "plex", itemId: itemId || item.ratingKey || item.rating_key || item.key });
  if (!normalized) return null;
  return {
    ...normalized,
    provider_ids: ids,
    provider_item_id: clean(itemId || item.ratingKey || item.rating_key || item.key, 300),
    rating_key: clean(item.ratingKey || item.rating_key || item.key, 300),
    managed: true,
    remote_item: item,
  };
}

export function capabilities(config = {}) {
  const configured = Boolean(config.accountToken || config.watchlistToken || config.token || config.connectionId || config.authMode === "account");
  const representation = config.watchlistRepresentation || config.representation || "native";
  const writeEnabled = Boolean(config.watchlistWriteEnabled || config.writeEnabled);
  const read = configured && representation !== "rss" ? true : Boolean(config.watchlistRssUrl || config.rssUrl);
  return {
    provider: "plex",
    representation: ["native", "rss"].includes(representation) ? representation : "native",
    configured,
    read,
    add: read && representation === "native" && writeEnabled,
    remove: read && representation === "native" && writeEnabled,
    capability: !configured ? "unavailable" : representation === "rss" ? "read_only" : writeEnabled ? "full" : "read_only",
    reason: !configured ? "Connect a Plex account before syncing watchlists." : representation === "rss" ? "Plex RSS is read-only." : writeEnabled ? "" : "Enable verified Plex account-level watchlist writes before publishing.",
  };
}

function plexItemsFromBody(body) {
  if (Array.isArray(body?.MediaContainer?.Metadata)) return body.MediaContainer.Metadata;
  if (Array.isArray(body?.Metadata)) return body.Metadata;
  if (Array.isArray(body?.MediaContainer?.Hub)) return body.MediaContainer.Hub.flatMap((hub) => hub.Metadata || []);
  // Discover search nests each hit one or two levels deep, as
  // SearchResults[].SearchResult[].Metadata. Some responses omit the outer
  // grouping and return SearchResult directly.
  const searchResults = body?.MediaContainer?.SearchResults || body?.SearchResults;
  if (Array.isArray(searchResults)) {
    return searchResults.flatMap((group) => (Array.isArray(group?.SearchResult) ? group.SearchResult : []))
      .map((result) => result?.Metadata || result)
      .filter(Boolean);
  }
  const searchResult = body?.MediaContainer?.SearchResult || body?.SearchResult;
  if (Array.isArray(searchResult)) return searchResult.map((result) => result?.Metadata || result).filter(Boolean);
  return listItems(body);
}

function isRecognisedPlexListBody(body) {
  if (Array.isArray(body)) return true;
  if (!body || typeof body !== "object") return false;
  return Array.isArray(body.MediaContainer?.Metadata)
    || Array.isArray(body.Metadata)
    || Boolean(body.MediaContainer && typeof body.MediaContainer === "object");
}

function unnormalizedPlexMarker(item) {
  const id = clean(item?.ratingKey || item?.rating_key || item?.key, 300);
  return id ? { provider_item_id: id, unnormalized: true } : null;
}

export async function listManagedItems(config, { cursor = null, pageSize = 100 } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation === "rss") return fetchPlexWatchlistRss(config);
  const startIndex = Number(cursor?.startIndex || 0);
  // The Universal Watchlist is an account-level section on the discover host,
  // not an item lookup: `/library/metadata` with no rating key is not a valid
  // endpoint there and answers 501, which silently failed every read, every
  // write that needed the snapshot fallback, and every import of an addition
  // made in Plex.
  // `includeExternalMedia` is required for entries whose title is not on any
  // server the account can reach, which is most of a watchlist. `includeGuids`
  // is equally load-bearing: without it the response carries no Guid array at
  // all, so every entry would arrive with no imdb/tmdb/tvdb id and could only
  // be matched on title and year.
  const body = await plexRequest(config, config.watchlistListPath || "/library/sections/watchlist/all", {
    params: {
      includeCollections: 1,
      includeExternalMedia: 1,
      includeGuids: 1,
      "X-Plex-Container-Start": startIndex,
      "X-Plex-Container-Size": pageSize,
      ...(config.watchlistListParams || {}),
    },
  });
  // A 200 body in no shape Plex uses must fail the read. Treating it as an empty
  // page made the watchlist sync remove every managed entry.
  if (!isRecognisedPlexListBody(body)) {
    const error = new Error("Plex watchlist response was unrecognised");
    error.code = "WATCHLIST_UNRECOGNISED_RESPONSE";
    throw error;
  }
  const rawItems = plexItemsFromBody(body);
  // A row that cannot be normalised is still a row Plex returned. It is kept as a
  // marker so the sync counts it as seen instead of as removed.
  const normalized = rawItems.map((item) => normalizePlexItem(item) || unnormalizedPlexMarker(item)).filter(Boolean);
  // `pageResult` reads the total from `MediaContainer.totalSize`, so it needs the
  // whole response: handing it the already-unwrapped container hid the total and
  // left pagination on the page-size heuristic.
  const page = pageResult(body, rawItems, startIndex, pageSize);
  return { ...page, complete: !page.nextCursor, items: normalized, container: null };
}

export async function fetchPlexWatchlistSnapshot(config, options = {}) {
  if ((config.watchlistRepresentation || config.representation || "native") === "rss") return fetchPlexWatchlistRss(config);
  const all = [];
  let cursor = options.cursor || null;
  for (let page = 0; page < 100; page += 1) {
    const result = await listManagedItems(config, { ...options, cursor });
    all.push(...result.items);
    if (!result.nextCursor) return { items: all, complete: true, container: null };
    cursor = result.nextCursor;
  }
  const error = new Error("Plex watchlist pagination exceeded the safety limit");
  error.code = "WATCHLIST_INCOMPLETE_SNAPSHOT";
  throw error;
}

function xmlEntity(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parsePlexRss(text) {
  const items = [];
  for (const match of String(text || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const read = (name) => xmlEntity(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
    const title = read("title");
    const guid = read("guid");
    if (title || guid) items.push(normalizePlexItem({ type: /show|series|tv/i.test(read("mediaType")) ? "show" : "movie", title, guid }, guid));
  }
  return { items: items.filter(Boolean), nextCursor: null, complete: true, container: null, rss: true };
}

export async function fetchPlexWatchlistRss(config) {
  const rssUrl = config.watchlistRssUrl || config.rssUrl;
  if (!rssUrl) {
    const error = new Error("Plex RSS watchlist URL is not configured");
    error.code = "WATCHLIST_RSS_NOT_CONFIGURED";
    error.status = 424;
    throw error;
  }
  const headers = await plexHeaders(config);
  const response = await fetchWithTimeout(rssUrl, { headers, lane: "sync" });
  if (!response.ok) {
    const error = new Error(`Plex RSS watchlist failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parsePlexRss(await response.text());
}

// `/hubs/search` is a Plex Media Server endpoint. Resolving a watchlist target
// has to search the Plex catalog instead, because the whole point is to add
// titles the account does not own; that search lives on the discover host and
// answers with SearchResults rather than a plain Metadata list.
async function searchPlex(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const body = await plexRequest(config, config.watchlistSearchPath || "/library/search", {
    host: discoverUrl(config),
    params: {
      query: normalized.title,
      searchTypes: normalized.media_type === "movie" ? "movies" : "tv",
      // Required: without it the endpoint answers 400 "Missing required param
      // searchProviders!". `discover` is the catalog that backs the watchlist.
      searchProviders: "discover",
      includeMetadata: 1,
      includeGuids: 1,
      limit: 30,
      ...(config.watchlistSearchParams || {}),
    },
  });
  return plexItemsFromBody(body);
}

function requestedIds(media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  return { tmdb: normalized.tmdb_id, tvdb: normalized.tvdb_id, imdb: normalized.imdb_id };
}

// Unlike Discover search, the full metadata response carries the external
// Guid array, so this is the only way to get a real tmdb/tvdb/imdb id for a
// candidate. Used only as a last resort, when title+year still leaves more
// than one candidate - which happens for a genuine same-title, same-year
// Plex catalog duplicate (verified live: two distinct "Arrival" (2016)
// entries) - so a normal add never pays for the extra request.
async function fetchPlexMetadataById(config, ratingKey) {
  try {
    const body = await plexRequest(config, `/library/metadata/${encodeURIComponent(ratingKey)}`, {
      host: discoverUrl(config),
      params: { includeGuids: 1 },
    });
    return plexItemsFromBody(body)[0] || null;
  } catch (error) {
    if ([404, 405].includes(Number(error.status))) return null;
    throw error;
  }
}

export async function resolveTargets(config, media) {
  const normalized = normalizePersonalWatchlistMedia(media);
  const candidates = [];
  try {
    candidates.push(...(await searchPlex(config, normalized)));
  } catch (error) {
    if (![404, 405].includes(Number(error.status))) throw error;
  }
  if (!candidates.length) {
    const snapshot = await fetchPlexWatchlistSnapshot(config);
    candidates.push(...snapshot.items.filter((item) => !item.unnormalized).map((item) => item.remote_item || item));
  }
  const ids = requestedIds(normalized);
  let targets = sortRemoteTargets([...new Map(candidates.map((item) => [String(item.ratingKey || item.rating_key || item.key || item.guid || item.title), item])).values()]
    .map((item) => {
      const remote = normalizePlexItem(item);
      return remote ? { id: remote.provider_item_id, item, providerIds: remote.provider_ids, media: remote } : null;
    })
    .filter((target) => target && target.media.media_type === normalized.media_type && (providerIdsMatch(ids, target.media) || titleAndYearMatch(normalized, target.media))));
  // Discover search never returns external provider ids, so a common title
  // routinely matches several catalog entries once titleAndYearMatch's
  // missing-year fallback lets a same-titled, undated entry ride along with
  // the real match. When we know the requested year, prefer whichever
  // candidates actually match it (or matched by provider id) over a same-title
  // guess with no year at all, instead of calling the whole set ambiguous.
  if (targets.length > 1 && normalized.year) {
    const exactYear = targets.filter((target) => providerIdsMatch(ids, target.media) || Number(target.media.year) === Number(normalized.year));
    if (exactYear.length) targets = exactYear;
  }
  // Title and year alone cannot separate a genuine same-title, same-year
  // catalog duplicate. Fetch full metadata (which does carry real provider
  // ids, unlike search) for just the remaining candidates and narrow to
  // whichever one actually matches the requested tmdb/tvdb/imdb id.
  if (targets.length > 1 && (ids.tmdb || ids.tvdb || ids.imdb)) {
    const detailed = await Promise.all(targets.map(async (target) => {
      const full = await fetchPlexMetadataById(config, target.id);
      if (!full) return target;
      const remote = normalizePlexItem(full, target.id);
      return remote ? { ...target, media: remote, providerIds: remote.provider_ids } : target;
    }));
    const idMatches = detailed.filter((target) => providerIdsMatch(ids, target.media));
    targets = idMatches.length ? idMatches : detailed;
  }
  return {
    targets,
    primaryTarget: targets.length === 1 ? targets[0] : null,
    ambiguous: targets.length > 1,
    unavailable: targets.length === 0,
    reason: targets.length > 1 ? "Multiple Plex items match this watchlist identity." : targets.length ? "" : "Plex has no matching item yet.",
  };
}

function pathWithId(template, id) {
  return String(template).replace(/\{id\}/g, encodeURIComponent(id));
}

// A watchlist rating key is the account catalog's key, which is also the last
// segment of a `plex://movie/<key>` guid. Prefer the resolved item id and fall
// back to the guid so a target carrying only a guid still resolves.
function watchlistRatingKey(target = {}) {
  const id = String(target.id || target.provider_item_id || target.rating_key || "");
  if (id) return id;
  const guid = String(target.media?.provider_ids?.plex || target.item?.guid || target.media?.guid || "");
  const match = guid.match(/^plex:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : "";
}

// Writes go through the account action endpoints. The older
// `/library/metadata/{id}/watchlist` form is kept working for a deployment that
// pins it: a configured path containing `{id}` is still substituted, while the
// action endpoints take the key as a query parameter instead.
//
// Verified against the live account API: the parameter is `ratingKey`, singular
// - `ratingKeys` is rejected with 400 "Invalid value provided for ratingKey!".
// Both actions are PUT on the discover host; POST answers 404, as does the
// metadata host.
async function writeWatchlistAction(config, { path, method, id }) {
  const usesPathId = path.includes("{id}");
  await plexRequest(config, usesPathId ? pathWithId(path, id) : path, {
    method,
    params: { ...(usesPathId ? {} : { ratingKey: id }), ...(config.watchlistWriteParams || {}) },
  });
}

export async function add(config, { target } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation !== "native") throw Object.assign(new Error("Plex RSS watchlists are read-only"), { code: "WATCHLIST_READ_ONLY", status: 405 });
  const id = watchlistRatingKey(target);
  if (!id) throw new Error("Plex watchlist add needs an item id");
  await writeWatchlistAction(config, {
    path: config.watchlistAddPath || "/actions/addToWatchlist",
    method: config.watchlistAddMethod || "PUT",
    id,
  });
  return { id, representation };
}

export async function remove(config, { target } = {}) {
  const representation = config.watchlistRepresentation || config.representation || "native";
  if (representation !== "native") throw Object.assign(new Error("Plex RSS watchlists are read-only"), { code: "WATCHLIST_READ_ONLY", status: 405 });
  const id = watchlistRatingKey(target);
  if (!id) return { removed: false, reason: "missing_provider_item_id" };
  await writeWatchlistAction(config, {
    path: config.watchlistRemovePath || "/actions/removeFromWatchlist",
    method: config.watchlistRemoveMethod || "PUT",
    id,
  });
  return { removed: true, id, representation };
}

export const plexWatchlistCapabilities = capabilities;
export const listPlexWatchlistItems = listManagedItems;
export const resolvePlexWatchlistTargets = resolveTargets;
export const addPlexWatchlistItem = add;
export const removePlexWatchlistItem = remove;
