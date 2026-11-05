import { db, parseJson, toJson } from "../db.js";
import { getTvdbSeriesExtended, requestTvdbOrderEndpoint } from "./tvdbGateway.js";
import { AIRED_ORDER, ORDER_TYPES } from "./tvdbOrderTypes.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 100;
const CACHE_VERSION = 4;
const cacheGet = db.prepare("SELECT details, updated_at_ms FROM tvdb_metadata_cache WHERE id = ?");
const cacheSet = db.prepare(`
  INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
  VALUES (@id, @tvdb_id, @title, @details, @updated_at_ms)
  ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, title=excluded.title,
    details=excluded.details, updated_at_ms=excluded.updated_at_ms
`);
const inflight = new Map();
const loaderIds = new WeakMap();
let nextLoaderId = 1;

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// A list TVDB sent that cannot be trusted (colliding or malformed episodes),
// as opposed to a failed request.
function invalidOrder(message) {
  return Object.assign(new Error(message), { code: "TVDB_ORDER_INVALID" });
}

function episodeIdentity(raw, seriesId) {
  const id = positiveInt(raw?.id);
  const rawSeriesId = raw?.seriesId ?? raw?.series_id ?? raw?.series?.id;
  const episodeSeriesId = positiveInt(rawSeriesId);
  const season = nonNegativeInt(raw?.seasonNumber ?? raw?.season);
  const episode = positiveInt(raw?.number ?? raw?.episodeNumber ?? raw?.episode);
  if (!id || !episodeSeriesId || episodeSeriesId !== seriesId || season == null || !episode) {
    throw invalidOrder("TVDB order contains an invalid episode identity");
  }
  return { id, seriesId: episodeSeriesId, season, episode };
}

export function normalizeTvdbOrderEpisodes(episodes, seriesId) {
  if (!Array.isArray(episodes)) throw new Error("TVDB order response did not contain an episode list");
  const ids = new Set();
  const coordinates = new Set();
  return episodes.map((raw) => {
    const identity = episodeIdentity(raw, seriesId);
    const coordinate = `${identity.season}:${identity.episode}`;
    if (ids.has(identity.id) || coordinates.has(coordinate)) {
      throw invalidOrder("TVDB order contains colliding episode identities");
    }
    ids.add(identity.id);
    coordinates.add(coordinate);
    return {
      ...identity,
      name: String(raw.name || raw.episodeName || ""),
      air_date: String(raw.aired ?? raw.airDate ?? raw.air_date ?? "").slice(0, 10),
      overview: String(raw.overview || ""),
      still_path: String(raw.image || raw.still_path || ""),
      runtime: nonNegativeInt(raw.runtime),
    };
  });
}

function listFrom(payload) {
  if (Array.isArray(payload?.data?.episodes)) return payload.data.episodes;
  throw new Error("TVDB order response did not contain an episode list");
}

function pageState(payload, page) {
  const links = payload?.links ?? payload?.data?.links;
  const meta = payload?.meta ?? payload?.data?.meta;
  if (!links || !Object.hasOwn(links, "next")) throw new Error("TVDB order response is missing pagination links");
  const totalItems = Number(meta?.totalItems ?? meta?.total_items);
  const totalPages = Number(meta?.totalPages ?? meta?.total_pages);
  if (Number.isFinite(totalPages) && totalPages > page + 1 && !links.next) {
    throw new Error("TVDB order pagination ended before the reported final page");
  }
  const next = Boolean(links.next);
  if (!next && Number.isFinite(totalPages) && totalPages !== page + 1) {
    throw new Error("TVDB order pagination did not reach the reported final page");
  }
  return { next, totalItems: Number.isFinite(totalItems) ? totalItems : null };
}

async function loadOrder(tvdbId, order, requestEndpoint) {
  const combined = [];
  let expectedItems = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await requestEndpoint(`/series/${tvdbId}/episodes/${order}/eng`, { page });
    combined.push(...listFrom(payload));
    const state = pageState(payload, page);
    if (state.totalItems != null) {
      if (expectedItems != null && expectedItems !== state.totalItems) throw new Error(`TVDB ${order} order item count changed during pagination`);
      expectedItems = state.totalItems;
    }
    if (!state.next) {
      if (expectedItems != null && expectedItems !== combined.length) {
        throw new Error(`TVDB ${order} order item count was incomplete`);
      }
      return normalizeTvdbOrderEpisodes(combined, Number(tvdbId));
    }
    if (expectedItems != null && combined.length >= expectedItems) {
      throw new Error(`TVDB ${order} order pagination links conflict with the reported item count`);
    }
  }
  throw new Error(`TVDB ${order} order exceeded the pagination limit`);
}

function orderTypeId(types, order) {
  const entries = Array.isArray(types) ? types : Array.isArray(types?.data) ? types.data : [];
  const match = entries.find((entry) => entry?.type === order);
  return positiveInt(match?.id);
}

function availableOrder(extended, order) {
  return (Array.isArray(extended?.seasons) ? extended.seasons : []).some((season) => season?.type?.type === order);
}

// TVDB's own name for the show's order, such as "Parts Order (Netflix)".
function orderLabel(extended, order) {
  const type = (Array.isArray(extended?.seasons) ? extended.seasons : []).find((season) => season?.type?.type === order)?.type;
  return String(type?.alternateName || type?.name || "").trim().slice(0, 100);
}

const emptyOrders = () => Object.fromEntries(ORDER_TYPES.map((order) => [order, []]));

function cacheId(tvdbId) {
  return `order_catalogue_v${CACHE_VERSION}_${tvdbId}`;
}

export function getCachedTvdbOrderCatalogue(tvdbId) {
  const id = positiveInt(tvdbId);
  return id ? validCachedCatalogue(parseJson(cacheGet.get(cacheId(id))?.details), id) : null;
}

function loaderId(loader) {
  if (!loaderIds.has(loader)) loaderIds.set(loader, nextLoaderId++);
  return loaderIds.get(loader);
}

function validCachedCatalogue(cached, id) {
  if (!cached || cached.tvdbId !== id || !Number.isFinite(cached.fetchedAt)
    || !cached.orders || !Array.isArray(cached.orders.official) || !Array.isArray(cached.orders.dvd)) return null;
  try {
    const orders = emptyOrders();
    for (const order of ORDER_TYPES) {
      if (Array.isArray(cached.orders[order])) orders[order] = normalizeTvdbOrderEpisodes(cached.orders[order], id);
    }
    const labels = {};
    for (const order of ORDER_TYPES) if (typeof cached.labels?.[order] === "string" && cached.labels[order]) labels[order] = cached.labels[order];
    return { tvdbId: id, orders, labels, fetchedAt: cached.fetchedAt };
  } catch {
    return null;
  }
}

async function loadSeasonTypes(loadEndpoint) {
  const key = "order_season_types_v1";
  const row = cacheGet.get(key);
  const cached = row ? parseJson(row.details) : null;
  if (cached?.types && cached.fetchedAt && Date.now() - cached.fetchedAt < DAY_MS) {
    return cached.types;
  }
  const payload = await loadEndpoint("/seasons/types", {});
  const types = Array.isArray(payload?.data) ? payload.data : null;
  if (!types) throw new Error("TVDB season types response is incomplete");
  const officialId = positiveInt(types.find((item) => item?.type === "official")?.id);
  const dvdId = positiveInt(types.find((item) => item?.type === "dvd")?.id);
  if (!officialId || !dvdId) throw new Error("TVDB season types response is missing an exact order type");
  const fetchedAt = Date.now();
  cacheSet.run({ id: key, tvdb_id: "", title: "", details: toJson({ types, fetchedAt }), updated_at_ms: fetchedAt });
  return types;
}

async function fetchCatalogue(id, { force, loadEndpoint, loadSeries }) {
  const key = cacheId(id);
  const cachedRow = cacheGet.get(key);
  const cached = validCachedCatalogue(cachedRow ? parseJson(cachedRow.details) : null, id);
  if (!force && cached && Date.now() - cached.fetchedAt < DAY_MS) return cached;

  const [extended, types] = await Promise.all([
    loadSeries(String(id), { force }),
    loadSeasonTypes(loadEndpoint),
  ]);
  if (!extended || positiveInt(extended.id) !== id) throw new Error("TVDB series response did not match the requested series");
  const orders = emptyOrders();
  const labels = {};
  for (const order of ORDER_TYPES) {
    const typeId = orderTypeId(types, order);
    // Aired and DVD must exist in TVDB's type list; a newer alternate type
    // that this response lacks is simply not offered.
    if (!typeId) {
      if (order === AIRED_ORDER || order === "dvd") throw new Error(`TVDB season types response is missing exact ${order} type`);
      continue;
    }
    if (!availableOrder(extended, order)) continue;
    try {
      orders[order] = await loadOrder(id, order, loadEndpoint);
    } catch (error) {
      // Aired and DVD stay required. A malformed optional order (absolute
      // lists often repeat coordinates) is not offered; it must not take the
      // show's other orders down with it. Request failures still reject.
      if (order === AIRED_ORDER || order === "dvd" || error?.code !== "TVDB_ORDER_INVALID") throw error;
      continue;
    }
    const label = orderLabel(extended, order);
    if (label) labels[order] = label;
  }
  const catalogue = { tvdbId: id, orders, labels, fetchedAt: Date.now() };
  cacheSet.run({
    id: key,
    tvdb_id: String(id),
    title: String(extended.name || ""),
    details: toJson(catalogue),
    updated_at_ms: catalogue.fetchedAt,
  });
  return catalogue;
}

export function getTvdbOrderCatalogue(tvdbId, { force = false, loadEndpoint = requestTvdbOrderEndpoint, loadSeries = getTvdbSeriesExtended } = {}) {
  const id = positiveInt(tvdbId);
  if (!id) return Promise.reject(new Error("A valid TVDB series id is required"));
  const flightKey = `${id}:${loaderId(loadEndpoint)}:${loaderId(loadSeries)}`;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const task = fetchCatalogue(id, { force, loadEndpoint, loadSeries }).finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, task);
  return task;
}
