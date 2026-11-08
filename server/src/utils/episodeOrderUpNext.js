import { readEpisodeOrder, episodeOrderRevision } from "./episodeOrder.js";
import { getCachedTvdbOrderCatalogue, getTvdbOrderCatalogue } from "./tvdbOrderGateway.js";
import { matchEpisodeOrderTarget } from "./episodeOrderTargets.js";
import { fetchPlexSeriesEpisodes } from "./plexClient.js";
import { fetchEmbySeriesEpisodes } from "./embyClient.js";
import { fetchJellyfinSeriesEpisodes } from "./jellyfinClient.js";
import { getCachedTmdbDetails as cachedDetails, getCachedTmdbSeason as cachedSeason } from "./tmdbGateway.js";

const idOf = item => String(item.show_tvdb_id || item.tvdb_id || item.ids?.tvdb || "");
function airedCatalogue(id) {
  return id && readEpisodeOrder(id).order !== "official" ? getCachedTvdbOrderCatalogue(id) : null;
}
export function orderDetails(options) {
  const details = cachedDetails(options);
  const catalogue = airedCatalogue(options.ids?.tvdbId || details?.external_ids?.tvdb_id);
  return catalogue ? { ...details, seasons: [...new Set(catalogue.orders.official.map(e => e.season))].map(season_number => ({ season_number })) } : details;
}
export function orderSeason(options) {
  const catalogue = airedCatalogue(options.tvdbId);
  return catalogue ? { episodes: catalogue.orders.official.filter(e => e.season === Number(options.seasonNumber)).map(e => ({ ...e, season_number: e.season, episode_number: e.episode })) } : cachedSeason(options);
}
export function orderRevision(item) {
  const id = idOf(item), saved = readEpisodeOrder(id);
  return saved.order === "official" ? "" : episodeOrderRevision(getCachedTvdbOrderCatalogue(id), saved);
}

// Native coordinates cannot identify an alternate-order episode. Inventory
// entries must carry the episode's exact TVDB ID and resolve to aired storage.
export function orderCoordinate(provider, episode, show, fallback) {
  const id = idOf(show);
  if (readEpisodeOrder(id).order === "official") return fallback;
  const catalogue = getCachedTvdbOrderCatalogue(id);
  const ids = provider === "plex"
    ? (episode.Guid || []).map(g => /^tvdb:\/\/(\d+)$/.exec(g.id || "")?.[1]).filter(Boolean)
    : [episode.ProviderIds?.Tvdb || episode.ProviderIds?.tvdb].filter(Boolean).map(String);
  if (ids.length !== 1 || !matchEpisodeOrderTarget([episode], { episodeId: ids[0], provider })) return null;
  const aired = catalogue?.orders.official.find(e => String(e.id) === ids[0]);
  return aired ? { season: aired.season, episode: aired.episode } : null;
}

export async function resolveOrderUpNextItem(provider, config, item) {
  const id = idOf(item);
  if (!id || readEpisodeOrder(id).order === "official" || (item.media_type || item.type) !== "episode") return null;
  const catalogue = await getTvdbOrderCatalogue(id);
  const aired = catalogue.orders.official.find(e => e.season === Number(item.season) && e.episode === Number(item.episode));
  if (!aired) return { providerItemId: "", reason: "No verified aired episode identity." };
  const media = { type: "episode", title: item.show_title || item.title, showTitle: item.show_title || item.title,
    ids: { tvdb: id, imdb: item.show_imdb_id, tmdb: item.show_tmdb_id } };
  const fetcher = { plex: fetchPlexSeriesEpisodes, emby: fetchEmbySeriesEpisodes, jellyfin: fetchJellyfinSeriesEpisodes }[provider];
  const rows = await fetcher(config, media);
  const target = matchEpisodeOrderTarget(rows, { episodeId: String(aired.id), provider });
  return { providerItemId: target?.id || "", direct: false, runtimeMs: 0 };
}
