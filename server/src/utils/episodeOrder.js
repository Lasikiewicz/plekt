import crypto from "node:crypto";
import { db, parseJson, toJson } from "../db.js";
import { getTvdbOrderCatalogue, getCachedTvdbOrderCatalogue } from "./tvdbOrderGateway.js";
import { AIRED_ORDER, ALTERNATE_ORDERS, ORDER_NAMES, ORDER_TYPES, isAlternateOrder } from "./tvdbOrderTypes.js";
import { listTrackerConnections } from "./trackerConnectionRepo.js";

// Simkl cannot prove an episode from its TVDB id, so a show in a non-Aired
// order is never sent to it. Choosing such an order needs an acknowledgement.
export const simklConnected = () => listTrackerConnections().some(c => c.provider === "simkl" && c.status === "connected");

const keyFor = id => `episode-order:v1:${id}`;
export function episodeOrderError(message = "This episode cannot be safely matched in the selected order. No watched state was changed.") {  return Object.assign(new Error(message), { status: 409, code: "EPISODE_MAPPING_REQUIRED" });
}
// Links saved before alternate orders existed have no order and were DVD links.
export function readEpisodeOrder(tvdbId) {
  const saved = parseJson(db.prepare("SELECT data FROM settings WHERE id=?").get(keyFor(tvdbId))?.data) || {};
  return { order: ORDER_TYPES.includes(saved.order) ? saved.order : AIRED_ORDER, mappings: Array.isArray(saved.mappings) ? saved.mappings.filter(m=>m && Number.isSafeInteger(Number(m.dvdId)) && Number(m.dvdId)>0 && Number.isSafeInteger(Number(m.airedId)) && Number(m.airedId)>0 && typeof m.signature === "string").map(m=>({...m, order: isAlternateOrder(m.order) ? m.order : "dvd"})) : [] };
}
// The order a stored episode, or a request, belongs to. Unmarked provenance is DVD.
export const provenanceOrder = identity => isAlternateOrder(identity?.order) ? identity.order : "dvd";
export function orderLabel(catalogue, order) {
  return catalogue?.labels?.[order] || ORDER_NAMES[order] || "Episode order";
}
export function orderLinks(catalogue, saved = { mappings: [] }, order = "dvd") {
  const aired = catalogue.orders[AIRED_ORDER];
  const source = catalogue.orders[order] || [];
  const links = [];
  for (const item of source) {
    const manual = saved.mappings.find(m => m.order === order && Number(m.dvdId) === item.id);
    const targetId = manual ? Number(manual.airedId) : item.id;
    const target = aired.find(e => e.id === targetId);
    // Pin the confirmed identities and coordinates; changed provider records need review.
    if (target && (!manual || manual.signature === mappingSignature(item, target))) links.push({ dvdId: item.id, airedId: target.id, manual: Boolean(manual) });
  }
  const counts = new Map();
  for (const link of links) counts.set(link.airedId, (counts.get(link.airedId) || 0) + 1);
  return links.filter(link => counts.get(link.airedId) === 1);
}
function mappingSignature(source, aired) {
  return JSON.stringify([source.id, source.seriesId, source.season, source.episode, source.name, aired.id, aired.seriesId, aired.season, aired.episode, aired.name]);
}
export function episodeOrderRevision(catalogue, saved) {
  return crypto.createHash("sha256").update(toJson({ catalogue, saved })).digest("hex");
}
// The alternate order the link editor works on: the selected one, else the
// first the show has (DVD first).
function linkOrderFor(catalogue, saved) {
  if (isAlternateOrder(saved.order)) return saved.order;
  return ALTERNATE_ORDERS.find(order => catalogue.orders[order]?.length) || null;
}
export async function episodeOrderState(tvdbId) {
  const catalogue = await getTvdbOrderCatalogue(tvdbId);
  const saved = readEpisodeOrder(tvdbId);
  const linkOrder = linkOrderFor(catalogue, saved);
  return {
    tvdbId: String(tvdbId), order: saved.order, revision: episodeOrderRevision(catalogue, saved), simklConnected: simklConnected(),
    available: Object.fromEntries(ORDER_TYPES.map(order => [order, catalogue.orders[order].length > 0])),
    labels: Object.fromEntries(ORDER_TYPES.map(order => [order, orderLabel(catalogue, order)])),
    linkOrder, episodes: catalogue.orders,
    mappings: saved.mappings.filter(m => m.order === linkOrder),
    links: linkOrder ? orderLinks(catalogue, saved, linkOrder) : [],
    // What each available order's episodes become in aired order, so the dialog can preview an order before it is chosen.
    linksByOrder: Object.fromEntries(ALTERNATE_ORDERS.filter(order => catalogue.orders[order].length).map(order => [order, orderLinks(catalogue, saved, order)])),
  };
}
export async function changeEpisodeOrder(tvdbId, body, method) {
  const catalogue = await getTvdbOrderCatalogue(tvdbId);
  const saved = readEpisodeOrder(tvdbId);
  if (body.confirm !== true || body.revision !== episodeOrderRevision(catalogue, saved)) throw episodeOrderError("Episode metadata or mappings changed. Review the current preview before saving.");
  if (body.order != null) {
    if (!ORDER_TYPES.includes(body.order) || !catalogue.orders[body.order].length) throw episodeOrderError("That episode order is unavailable. The current order was kept.");
    if (body.order !== AIRED_ORDER && body.order !== saved.order && simklConnected() && body.acknowledgeSimkl !== true) throw episodeOrderError("Simkl does not support this order. Tick the box to confirm that this show's watches will not be sent to Simkl.");
    saved.order = body.order;
  } else {
    const order = isAlternateOrder(body.linkOrder) ? body.linkOrder : "dvd";
    const source = (catalogue.orders[order] || []).find(e => e.id === Number(body.dvdId));
    if (!source) throw episodeOrderError("The episode is no longer available in that order.");
    const remaining = saved.mappings.filter(m => !(m.order === order && Number(m.dvdId) === source.id));
    if (method !== "DELETE") {
      const aired = catalogue.orders[AIRED_ORDER].find(e => e.id === Number(body.airedId));
      if (!aired) throw episodeOrderError("Choose a verified aired episode from this show.");
      const other = orderLinks(catalogue, { mappings: remaining }, order).find(m => m.dvdId !== source.id && m.airedId === aired.id);
      if (other) throw episodeOrderError("Another episode already maps to that aired episode.");
      remaining.push({ order, dvdId: source.id, airedId: aired.id, signature: mappingSignature(source, aired), confirmedAt: Date.now() });
    }
    saved.mappings = remaining;
  }
  db.prepare("INSERT INTO settings(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at").run(keyFor(tvdbId), toJson(saved), Date.now());
  return episodeOrderState(tvdbId);
}
// Resolves a coordinate shown in an alternate order to its aired episode.
// `dvd` in the result is the episode in the alternate order, whichever it is.
export async function dvdToAired(tvdbId, season, episode, order = "dvd") {
  const catalogue = await getTvdbOrderCatalogue(tvdbId);
  const dvd = (catalogue.orders[order] || []).find(e => e.season === Number(season) && e.episode === Number(episode));
  const link = dvd && orderLinks(catalogue, readEpisodeOrder(tvdbId), order).find(m => m.dvdId === dvd.id);
  const aired = link && catalogue.orders[AIRED_ORDER].find(e => e.id === link.airedId);
  if (!aired) throw episodeOrderError();
  return { dvd, aired };
}
export async function episodeOrderSeason({ tvdbId, seasonNumber }) {
  const order = readEpisodeOrder(tvdbId).order;
  if (order === AIRED_ORDER) return null;
  const catalogue = await getTvdbOrderCatalogue(tvdbId);
  if (!catalogue.orders[order].length) throw episodeOrderError("That episode order's metadata is unavailable. Refresh metadata or choose Aired in Episode order.");
  return { episode_order: order, episodes: catalogue.orders[order].filter(e => e.season === Number(seasonNumber)).map(e => ({ ...e, tvdb_episode_id: e.id, episode_number: e.episode })) };
}
export async function episodeOrderDetails(details, {cachedOnly = false} = {}) {
  const id = String(details?.external_ids?.tvdb_id || "");
  const order = id ? readEpisodeOrder(id).order : AIRED_ORDER;
  if (order === AIRED_ORDER) return details;
  const catalogue = cachedOnly ? getCachedTvdbOrderCatalogue(id) : await getTvdbOrderCatalogue(id);
  if (!catalogue) return {...details,episode_order:order,seasons:[],number_of_episodes:0,number_of_seasons:0};
  const list = catalogue.orders[order];
  if (!list.length) throw episodeOrderError("That episode order's metadata is unavailable. Choose Aired in Episode order.");
  const seasons = new Map();
  for (const e of list) seasons.set(e.season, (seasons.get(e.season) || 0) + 1);
  return { ...details, episode_order: order, episode_order_label: orderLabel(catalogue, order), seasons: [...seasons].sort((a,b) => a[0]-b[0]).map(([n,count]) => ({ season_number:n, episode_count:count, name:n ? `Season ${n}` : "Specials", poster_path:null })), number_of_episodes: list.filter(e=>e.season>0).length, number_of_seasons:[...seasons.keys()].filter(n=>n>0).length };
}
// Presentation only: never replace the canonical action/progression coordinates.
export function episodeOrderDisplay(item) {
  if (item.media_type !== "episode") return item;
  const tvdbId = item.show_tvdb_id || item.tvdb_id;
  if (!tvdbId) return item;
  const saved = readEpisodeOrder(tvdbId);
  if (!isAlternateOrder(saved.order)) return item;
  const catalogue = getCachedTvdbOrderCatalogue(tvdbId);
  if (!catalogue) return item;
  const aired = catalogue.orders[AIRED_ORDER].find(e => e.season === Number(item.season) && e.episode === Number(item.episode));
  const links = aired && orderLinks(catalogue, saved, saved.order).filter(m => m.airedId === aired.id);
  const source = links?.length === 1 && catalogue.orders[saved.order]?.find(e => e.id === links[0].dvdId);
  return source ? { ...item, display_season: source.season, display_episode: source.episode,
    episode_order_label: orderLabel(catalogue, saved.order), watch_provenance: { episode_order: { tvdbId: String(tvdbId), dvdId: source.id, airedId: aired.id, order: saved.order } } } : item;
}

export async function annotateEpisodeOrder(show) {
  const id = String(show?.tvdb_id || "");
  const order = id ? readEpisodeOrder(id).order : AIRED_ORDER;
  if (order === AIRED_ORDER) return show;
  const catalogue = await getTvdbOrderCatalogue(id);
  const links = orderLinks(catalogue, readEpisodeOrder(id), order);
  const pairs = {};
  for (const row of show.episodes || []) {
    const provenance = typeof row.watch_provenance === "string" ? parseJson(row.watch_provenance) : row.watch_provenance;
    const identity = provenance?.episode_order;
    const link = identity && provenanceOrder(identity) === order && String(identity.tvdbId) === id && links.find(m=>m.airedId === Number(identity.airedId) && m.dvdId === Number(identity.dvdId));
    const target = link && catalogue.orders[order].find(e=>e.id === link.dvdId);
    delete row.display_season; delete row.display_episode;
    if (target) { delete row.numbering_review; row.display_season=target.season; row.display_episode=target.episode; pairs[`${row.season}:${row.episode}`] = {season:target.season,episode:target.episode}; }
    else row.numbering_review=true;
  }
  show.season_numbering = { source:order, translate:true, ready:true, pairs };
  show.episode_order = order;
  show.episode_order_label = orderLabel(catalogue, order);
  return show;
}

// Synchronous insertion guard: an unverified provider coordinate is not an
// aired episode identity. This path never starts metadata requests.
export function assertOrderInsert(record) {
  assertNoDvdContainer(record);
  if ((record.type || record.media_type || record.mediaType) !== "episode") return;
  const tvdbId = String(record.tvdb_id || record.ids?.tvdb || "");
  const raw = record.watch_provenance || record.watchProvenance || {};
  const identity = (typeof raw === "string" ? parseJson(raw) : raw)?.episode_order;
  if (identity && !tvdbId) throw episodeOrderError("A verified TVDB show identity is required. No watched state was changed.");
  if (!tvdbId || (!identity && readEpisodeOrder(tvdbId).order === AIRED_ORDER)) return;
  const catalogue = getCachedTvdbOrderCatalogue(tvdbId);
  const order = identity ? provenanceOrder(identity) : readEpisodeOrder(tvdbId).order;
  const link = catalogue && identity && String(identity.tvdbId) === tvdbId && orderLinks(catalogue, readEpisodeOrder(tvdbId), order).find(m=>m.dvdId === Number(identity.dvdId) && m.airedId === Number(identity.airedId));
  const aired = link && catalogue.orders[AIRED_ORDER].find(e=>e.id === link.airedId);
  if (!aired || aired.season !== Number(record.season) || aired.episode !== Number(record.episode)) throw episodeOrderError();
}

export function assertNoDvdContainer(record) {
  const type = String(record.media_type || record.mediaType || record.type || "").toLowerCase();
  const id = String(record.tvdb_id || record.tvdbId || record.tvdb || record.ids?.tvdb || "");
  if (["tv","show","series","season"].includes(type) && (isAlternateOrder(record.numbering_source) || readEpisodeOrder(id).order !== AIRED_ORDER)) throw episodeOrderError("Expand this show or season into verified episodes before changing watched state. No watched state was changed.");
}
