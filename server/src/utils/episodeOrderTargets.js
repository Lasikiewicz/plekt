import { fetchWithTimeout } from "./outbound.js";
import { canReceiveState } from "./syncRoles.js";
import { getTrackerConnection, listTrackerConnections } from "./trackerConnectionRepo.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { hydrateTraktAppCredentials } from "./traktAppConfig.js";
import { watchTargetPolicy, resolveWatchSyncIntent } from "./watchSyncPolicy.js";
import { fetchPlexSeriesEpisodes } from "./plexClient.js";
import { fetchEmbySeriesEpisodes } from "./embyClient.js";
import { fetchJellyfinSeriesEpisodes } from "./jellyfinClient.js";

const API_BASE = "https://api.trakt.tv";
const API_VERSION = "2";
const USER_AGENT = "Plekt (https://github.com/Lasikiewicz/plekt)";

function normalizedId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function positiveInteger(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function episodeIdFromAired(aired = {}) {
  return String(aired.id ?? aired.episodeId ?? aired.episode_id ?? "").trim();
}

function spansMultipleEpisodes(item = {}) {
  const pairs = [
    [item.index, item.indexEnd],
    [item.IndexNumber, item.IndexNumberEnd],
    [item.IndexNumber, item.IndexNumberEnd ?? item.IndexNumberEndIncludingSpecials],
  ];
  return pairs.some(([start, end]) => end != null && Number(end) !== Number(start));
}

function plexTvdbIds(item = {}) {
  const ids = [];
  for (const entry of item.Guid || []) {
    const guid = String(entry?.id || entry || "");
    const match = guid.match(/(?:^|\.)tvdb:\/\/(\d+)(?:$|[/?#])/i);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function providerEpisodeId(item = {}, provider) {
  if (provider === "plex") {
    const ids = plexTvdbIds(item);
    return ids.length === 1 ? ids[0] : "";
  }
  const providerIds = item.ProviderIds || {};
  return String(providerIds.Tvdb ?? providerIds.tvdb ?? "").trim();
}

function nativeCoordinates(item = {}, provider) {
  const season = provider === "plex" ? item.parentIndex : item.ParentIndexNumber;
  const episode = provider === "plex" ? item.index : item.IndexNumber;
  const parsedSeason = positiveInteger(season);
  const parsedEpisode = Number(episode);
  if (parsedSeason === null || !Number.isInteger(parsedEpisode) || parsedEpisode < 1) return null;
  return { season: parsedSeason, episode: parsedEpisode };
}

function nativeItemId(item = {}, provider) {
  return String(provider === "plex" ? item.ratingKey || "" : item.Id || "").trim();
}

function sourceProvider(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return ["plex", "emby", "jellyfin"].find((provider) => normalized.startsWith(provider)) || "";
}

function sourceEpisodeId(media = {}) {
  let provenance = media.watchProvenance ?? media.watch_provenance ?? {};
  if (typeof provenance === "string") {
    try { provenance = JSON.parse(provenance); } catch { provenance = {}; }
  }
  const hinted = media.itemId ?? media.providerItemId ?? media.provider_item_id ?? media.item_id
    ?? provenance?.item_id;
  if (hinted != null && String(hinted).trim()) return String(hinted).trim();
  const provider = sourceProvider(media.source);
  const keyed = media.providerItems?.[provider] ?? media.provider_items?.[provider];
  const value = Array.isArray(keyed) ? keyed[0] : keyed;
  return value == null ? "" : String(value).trim();
}


function matchingSourceEpisode(items, { provider, season, episode, itemId }) {
  const list = Array.isArray(items) ? items : [];
  const targetSeason = positiveInteger(season);
  const targetEpisode = Number(episode);
  if (targetSeason === null || !Number.isInteger(targetEpisode) || targetEpisode < 1) return null;
  let matches;
  if (itemId) {
    matches = list.filter((item) => nativeItemId(item, provider) === itemId);
  } else {
    matches = list.filter((item) => {
      const coordinates = nativeCoordinates(item, provider);
      return coordinates?.season === targetSeason && coordinates?.episode === targetEpisode;
    });
  }
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (spansMultipleEpisodes(item)) return null;
  const coordinates = nativeCoordinates(item, provider);
  if (!coordinates || coordinates.season !== targetSeason || coordinates.episode !== targetEpisode) return null;
  const tvdbEpisodeId = providerEpisodeId(item, provider);
  if (!nativeItemId(item, provider) || !tvdbEpisodeId) return null;
  return { tvdbEpisodeId, ...coordinates };
}

/** Match only an exact, unique episode TVDB id in a result already scoped to the verified series. */
export function matchEpisodeOrderTarget(items, { episodeId, provider }) {
  const exactId = String(episodeId || "").trim();
  if (!exactId || !["plex", "emby", "jellyfin"].includes(provider)) return null;
  const matches = (Array.isArray(items) ? items : []).filter((item) => providerEpisodeId(item, provider) === exactId);
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (spansMultipleEpisodes(item)) return null;
  const id = nativeItemId(item, provider);
  const coordinates = nativeCoordinates(item, provider);
  if (!id || !coordinates) return null;
  return { id, ...coordinates, episodeId: exactId };
}

function mappingWarning(destination, aired, reason) {
  const season = aired.season == null ? "?" : aired.season;
  const episode = aired.episode == null ? "?" : aired.episode;
  return new Error(`DVD order mapping warning: ${destination} cannot safely match TVDB episode ${aired.id} (S${season}E${episode}): ${reason}`);
}

function isConfigured(config, provider) {
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && section.apiKey && section.userId);
}

function destinationAllowed(media, provider) {
  return !Array.isArray(media?.syncTargets) || media.syncTargets.includes(provider);
}

async function traktGet(path, connection) {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    lane: "interactive",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "trakt-api-version": API_VERSION,
      "trakt-api-key": connection.clientId,
      authorization: `Bearer ${connection.accessToken}`,
    },
  }, 20_000);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function fetchTraktEpisode(connection, aired) {
  const episodeId = episodeIdFromAired(aired);
  if (!episodeId) throw mappingWarning("Trakt", aired, "the aired-order TVDB episode id is missing");
  const { response, body: rows } = await traktGet(`/search/tvdb/${encodeURIComponent(episodeId)}?type=episode&extended=full&limit=10`, connection);
  if (!response.ok) throw mappingWarning("Trakt", aired, `the exact-id lookup returned HTTP ${response.status}`);
  if (Number(response.headers.get("x-pagination-item-count") || 0) > (Array.isArray(rows) ? rows.length : 0)) throw mappingWarning("Trakt",aired,"the episode lookup was truncated");
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => {
    const episode = row?.episode;
    return normalizedId(episode?.ids?.tvdb) === normalizedId(episodeId);
  });
  if (matches.length !== 1) throw mappingWarning("Trakt", aired, matches.length ? "the exact TVDB episode is ambiguous" : "Trakt did not return the exact TVDB episode");
  const { episode } = matches[0];
  let traktShowId = String(matches[0]?.show?.ids?.trakt || "").trim();
  if (!traktShowId) {
    const { response: showSearchResponse, body: showRows } = await traktGet(
      `/search/tvdb/${encodeURIComponent(String(aired.seriesId))}?type=show&extended=full&limit=10`,
      connection,
    );
    if (!showSearchResponse.ok) throw mappingWarning("Trakt", aired, `the parent series lookup returned HTTP ${showSearchResponse.status}`);
    if (Number(showSearchResponse.headers.get("x-pagination-item-count") || 0) > (Array.isArray(showRows) ? showRows.length : 0)) throw mappingWarning("Trakt",aired,"the series lookup was truncated");
    const exactShows = (Array.isArray(showRows) ? showRows : []).filter((row) => normalizedId(row?.show?.ids?.tvdb) === normalizedId(aired.seriesId));
    if (exactShows.length !== 1) throw mappingWarning("Trakt", aired, "the parent series TVDB id did not resolve uniquely");
    traktShowId = String(exactShows[0]?.show?.ids?.trakt || "").trim();
  }
  if (!traktShowId) throw mappingWarning("Trakt", aired, "the exact episode result did not identify its parent series");
  const { response: showResponse, body: showResult } = await traktGet(`/shows/${encodeURIComponent(traktShowId)}?extended=full`, connection);
  if (!showResponse.ok) throw mappingWarning("Trakt", aired, `the parent series verification returned HTTP ${showResponse.status}`);
  const show = showResult?.show || showResult;
  if (normalizedId(show?.ids?.trakt) !== normalizedId(traktShowId)
    || normalizedId(show?.ids?.tvdb) !== normalizedId(aired.seriesId)) {
    throw mappingWarning("Trakt", aired, "the Trakt parent series does not match the expected TVDB series id");
  }
  const season = positiveInteger(episode.season);
  const number = Number(episode.number);
  const traktEpisodeId = String(episode.ids?.trakt || "").trim();
  const tmdbId = String(show.ids?.tmdb || "").trim();
  if (season === null || !Number.isInteger(number) || number < 1 || !traktEpisodeId || !show.ids?.trakt || !tmdbId) {
    throw mappingWarning("Trakt", aired, "the exact episode result lacks verified Trakt ids or coordinates");
  }
  const {response:leafResponse,body:leaf} = await traktGet(`/shows/${encodeURIComponent(traktShowId)}/seasons/${season}/episodes/${number}?extended=full`,connection);
  if (!leafResponse.ok || normalizedId(leaf?.ids?.trakt) !== normalizedId(traktEpisodeId) || normalizedId(leaf?.ids?.tvdb) !== normalizedId(episodeId)) throw mappingWarning("Trakt",aired,"the episode does not belong to the verified parent series and native coordinates");
  return {
    id: traktEpisodeId,
    showId: traktShowId,
    episodeId,
    season,
    episode: number,
    traktOverride: { tmdb_id: tmdbId, season, episode: number, tvdb_episode_id: episodeId, trakt_episode_id: traktEpisodeId },
  };
}

/**
 * Read-only preflight for one aired-order episode. Provider series APIs scope
 * their returned episode lists to a series identity established from media.
 */
export async function resolveEpisodeOrderTargets({ aired = {}, media = {}, config = {}, stateType = "watched", dependencies = {} } = {}) {
  const episodeId = episodeIdFromAired(aired);
  const seriesId = String(aired.seriesId ?? aired.series_id ?? "").trim();
  if (!episodeId || !seriesId) throw mappingWarning("all destinations", aired, "an exact TVDB episode id and parent series id are required");

  const {
    provider_items: _providerItems,
    providerItems: _camelProviderItems,
    provider_item_id: _providerItemId,
    providerItemId: _camelProviderItemId,
    item_id: _itemId,
    itemId: _camelItemId,
    ...mediaForSeries
  } = media;
  const seriesMedia = {
    ...mediaForSeries,
    type: "episode",
    media_type: "episode",
    ids: {
      tvdb: seriesId,
      ...(media.show_tmdb_id || media.showTmdbId ? { tmdb: String(media.show_tmdb_id || media.showTmdbId) } : {}),
      ...(media.show_imdb_id || media.showImdbId ? { imdb: String(media.show_imdb_id || media.showImdbId) } : {}),
    },
    tvdb_id: seriesId,
    show_tvdb_id: seriesId,
    tvdb: seriesId,
    season: positiveInteger(aired.season),
    episode: Number(aired.episode),
    title: media.show_title || media.showTitle || media.title || aired.name || "",
  };
  const providerItems = {};
  const targets = {};

  const syncEnabled = dependencies.watchedPlayedSyncEnabled?.() ?? watchedPlayedSyncEnabled();
  const configured = ["plex", "emby", "jellyfin"].filter((provider) => (
    syncEnabled && isConfigured(config, provider)
    && canReceiveState(config, provider, stateType)
    && destinationAllowed(media, provider)
    && watchTargetPolicy({target:provider,intent:resolveWatchSyncIntent(media),state:stateType}).decision === "send"
  ));
  const fetchers = {
    plex: fetchPlexSeriesEpisodes,
    emby: fetchEmbySeriesEpisodes,
    jellyfin: fetchJellyfinSeriesEpisodes,
    ...(dependencies.fetchEpisodes || {}),
  };
  const fetched = await Promise.all(configured.map(async (provider) => {
    try {
      const rows = await fetchers[provider](config[provider], seriesMedia);
      const target = matchEpisodeOrderTarget(rows, { episodeId, provider });
      if (!target) throw mappingWarning(provider, aired, "no unique, single-episode exact TVDB-id match was found in the verified series");
      return [provider, target];
    } catch (error) {
      if (String(error?.message || "").startsWith("DVD order mapping warning:")) throw error;
      throw mappingWarning(provider, aired, error?.message || "the verified series episode list could not be read");
    }
  }));
  for (const [provider, target] of fetched) {
    providerItems[provider] = [target.id];
    targets[provider] = { id: target.id, season: target.season, episode: target.episode, episodeId };
  }

  const listConnections = dependencies.listTrackerConnections || listTrackerConnections;
  const trackerConnections = syncEnabled
    ? listConnections().filter((connection) => connection.status === "connected" && destinationAllowed(media, connection.provider))
    : [];
  for (const connection of trackerConnections) {
    // Simkl has no read API that proves a unique episode from its TVDB id, so
    // it is skipped for non-Aired orders (the dispatcher records the skip)
    // rather than blocking the watch for every other destination.
    if (connection.provider === "simkl") continue;
    if (connection.provider === "trakt") {
      const getConnection = dependencies.getTrackerConnection || getTrackerConnection;
      const storedConnection = getConnection("trakt", { includeCredentials: true });
      const authenticatedConnection = (dependencies.hydrateTraktAppCredentials || hydrateTraktAppCredentials)(storedConnection);
      if (!authenticatedConnection?.clientId || !authenticatedConnection?.accessToken) {
        throw mappingWarning("Trakt", aired, "connected account credentials are unavailable for a read-only exact-id lookup");
      }
      const target = await (dependencies.fetchTraktEpisode || fetchTraktEpisode)(authenticatedConnection, aired);
      targets.trakt = { id: target.id, showId: target.showId, season: target.season, episode: target.episode, episodeId };
      targets.traktOverride = target.traktOverride;
    }
  }

  return { providerItems, targets };
}

/** Resolve an inbound media-server episode's native coordinate to one exact TVDB episode. */
export async function resolveSourceOrderEpisode({ media = {}, config = {}, catalogue = {}, dependencies = {} } = {}) {
  const provider = sourceProvider(media.source);
  if (!provider) throw mappingWarning("source", media, "only Plex, Emby, and Jellyfin source events can be resolved");
  const seriesId = String(catalogue.tvdbId ?? catalogue.seriesId ?? media.show_tvdb_id ?? media.showTvdbId ?? "").trim();
  if (!seriesId) {
    throw mappingWarning(provider, media, "the verified TVDB series id is missing");
  }
  const explicitSeriesId = String(media.show_tvdb_id ?? media.showTvdbId ?? media.seriesId ?? media.series_id ?? "").trim();
  if (explicitSeriesId && normalizedId(explicitSeriesId) !== normalizedId(seriesId)) {
    throw mappingWarning(provider, media, "the source event parent series conflicts with the TVDB catalogue");
  }
  const { provider_items: _providerItems, providerItems: _camelProviderItems, provider_item_id: _providerItemId,
    providerItemId: _camelProviderItemId, item_id: _itemId, itemId: _camelItemId, ...mediaForSeries } = media;
  const seriesMedia = {
    ...mediaForSeries,
    type: "episode",
    media_type: "episode",
    ids: {
      tvdb: seriesId,
      ...(media.show_tmdb_id || media.showTmdbId ? { tmdb: String(media.show_tmdb_id || media.showTmdbId) } : {}),
      ...(media.show_imdb_id || media.showImdbId ? { imdb: String(media.show_imdb_id || media.showImdbId) } : {}),
    },
    tvdb_id: seriesId,
    show_tvdb_id: seriesId,
    season: media.season,
    episode: media.episode,
    title: media.show_title || media.showTitle || media.title || "",
  };
  const fetcher = (dependencies.fetchEpisodes || {})[provider] || {
    plex: fetchPlexSeriesEpisodes,
    emby: fetchEmbySeriesEpisodes,
    jellyfin: fetchJellyfinSeriesEpisodes,
  }[provider];
  let sourceItems;
  try {
    sourceItems = await fetcher(config?.[provider] || {}, seriesMedia);
  } catch (error) {
    throw mappingWarning(provider, media, error?.message || "the source series episode list could not be read");
  }
  const itemId = sourceEpisodeId(media);
  const sourceMatch = matchingSourceEpisode(sourceItems, {
    provider,
    season: media.season,
    episode: media.episode,
    itemId,
  });
  if (!sourceMatch) {
    throw mappingWarning(provider, media, itemId
      ? "the source item id was missing, ambiguous, multi-episode, or conflicted with its native coordinates"
      : "the native source coordinates did not identify one exact TVDB episode");
  }
  const official = catalogue?.orders?.official;
  if (!Array.isArray(official)) throw mappingWarning(provider, media, "the official-order catalogue is missing");
  const airedMatches = official.filter((episode) => normalizedId(episode?.id) === normalizedId(sourceMatch.tvdbEpisodeId)
    && normalizedId(episode?.seriesId ?? seriesId) === normalizedId(seriesId));
  if (airedMatches.length !== 1) {
    throw mappingWarning(provider, media, airedMatches.length ? "the TVDB episode occurs more than once in the official catalogue" : "the exact source TVDB episode is absent from the official catalogue");
  }
  return airedMatches[0];
}
