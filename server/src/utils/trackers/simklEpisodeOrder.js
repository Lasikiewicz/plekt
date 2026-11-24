import { normalizeWatchProvenance } from "../watchProvenance.js";
import { parseJson } from "../../db.js";
import { getCachedTvdbOrderCatalogue } from "../tvdbOrderGateway.js";
import { simklRequest } from "./simklClient.js";

const catalogueCache = new Map();
const TTL = 60 * 60_000;
const id = (value) => /^[1-9]\d*$/.test(String(value ?? "")) ? String(value) : "";
const titleKey = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const day = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : "";
export const SIMKL_ORDER_SKIP = "Simkl could not verify this episode's alternate numbering";

export function simklEpisodeOrderIdentity(media) {
  const value = media.watch_provenance || media.watchProvenance;
  const provenance = typeof value === "string" ? parseJson(value) : value;
  return normalizeWatchProvenance(provenance)?.episode_order || provenance?.episode_order;
}

export function matchSimklAiredEpisode(aired, catalogue) {
  const title = titleKey(aired?.name);
  const airDate = day(aired?.air_date);
  if (!title || !airDate) return null;
  const matches = catalogue.filter((row) => row?.type === "episode" && row.aired === true
    && titleKey(row.title) === title && day(row.date) === airDate);
  // Other sync and readback paths use aired coordinates. If Simkl numbers
  // this episode differently, hold it until those paths can translate it too.
  if (matches.length !== 1 || matches[0].season !== aired.season || matches[0].episode !== aired.episode) return null;
  const rowsAtCoordinate = catalogue.filter((row) => row?.season === aired.season && row.episode === aired.episode);
  const episodeId = id(matches[0].ids?.simkl_id);
  return rowsAtCoordinate.length === 1 && episodeId
    && catalogue.filter((row) => id(row?.ids?.simkl_id) === episodeId).length === 1 ? episodeId : null;
}

async function fetchCatalogue(connection, tvdbId) {
  const options = { minimumRemaining: 59, allowUnknownQuota: true };
  const rows = await simklRequest(connection, "/search/id", { ...options, query: { tvdb: tvdbId }, arrayResponse: true });
  if (rows.length !== 1 || rows[0]?.type !== "tv") return null;
  const simklId = id(rows[0].ids?.simkl);
  if (!simklId) return null;
  const show = await simklRequest(connection, `/tv/${simklId}`, options);
  if (id(show.ids?.tvdb) !== tvdbId || id(show.ids?.simkl ?? show.ids?.simkl_id) !== simklId) return null;
  const episodes = await simklRequest(connection, `/tv/episodes/${simklId}`, { ...options, arrayResponse: true });
  return { simklId, episodes };
}

function readCatalogue(connection, tvdbId) {
  const key = JSON.stringify([connection.id, connection.remoteUserId, tvdbId]);
  const cached = catalogueCache.get(key);
  if (cached?.expires > Date.now()) return cached.work;
  catalogueCache.delete(key);
  if (catalogueCache.size >= 100) catalogueCache.delete(catalogueCache.keys().next().value);
  const work = fetchCatalogue(connection, tvdbId);
  catalogueCache.set(key, { work, expires: Date.now() + TTL });
  work.catch(() => { if (catalogueCache.get(key)?.work === work) catalogueCache.delete(key); });
  return work;
}

export async function verifySimklEpisodeOrder(connection, media) {
  const order = simklEpisodeOrderIdentity(media);
  const tvdbId = id(order?.tvdbId);
  if (!tvdbId || id(media.ids?.tvdb) !== tvdbId || (media.type || media.mediaType) !== "episode") return null;
  const aired = getCachedTvdbOrderCatalogue(tvdbId)?.orders.official
    .find((episode) => id(episode.id) === id(order.airedId));
  if (!aired || aired.season < 1 || aired.season !== media.season || aired.episode !== media.episode) return null;
  const catalogue = await readCatalogue(connection, tvdbId);
  const expectedSimklId = id(media.ids?.simkl);
  if (!catalogue || (expectedSimklId && catalogue.simklId !== expectedSimklId)) return null;
  const episodeId = matchSimklAiredEpisode(aired, catalogue.episodes);
  return episodeId ? { simklId: catalogue.simklId, episodeId, airedId: String(aired.id), title: aired.name } : null;
}
