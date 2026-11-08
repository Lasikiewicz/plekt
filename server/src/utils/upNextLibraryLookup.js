import {
  fetchPlexMetadataItem,
  fetchPlexSeriesEpisodes,
  findPlexItem,
} from "./plexClient.js";
import {
  fetchEmbyItemRuntimeMs,
  fetchEmbySeriesEpisodes,
  findEmbyItems,
} from "./embyClient.js";
import {
  fetchJellyfinItemRuntimeMs,
  fetchJellyfinSeriesEpisodes,
  findJellyfinItems,
} from "./jellyfinClient.js";
import { runWithConcurrency } from "./concurrency.js";
import { db } from "../db.js";
import { orderCoordinate as canonicalOrderCoordinate, resolveOrderUpNextItem, orderRevision as upNextOrderRevision } from "./episodeOrderUpNext.js";

const PROVIDERS = ["plex", "emby", "jellyfin"];
// A resolved library item is stable: the same episode keeps its ratingKey/Id
// until the library is rebuilt. A miss is more volatile - it is usually an
// episode that has not been downloaded yet - so it is retried sooner. It was 15
// minutes, but the projection asks about every eligible show (163 on a real
// library, about 486 keys over three providers) at 32 lookups per build, so
// misses expired faster than rebuilds could refill them and every rebuild paid
// 4-5s of provider round trips (speed finding AK). The user chose 2 hours:
// a newly added next episode can take that long to reach Up Next.
const RESOLVED_TTL_MS = 6 * 60 * 60 * 1000;
const MISSING_TTL_MS = 2 * 60 * 60 * 1000;
// Cap direct episode-item lookups so a cold cache cannot turn a dashboard
// refresh into a burst of provider searches. Full-series inventory lookups
// are separately cached and run through the projection's bounded worker pool.
const MAX_LOOKUPS_PER_BUILD = 32;
const MAX_CACHE_ENTRIES = 2000;
// Was 5 minutes: 26 inventories on a real library took 13-18s to refetch, so
// any rebuild after five idle minutes paid it (speed finding AK). The user
// chose 30 minutes: a new episode of a fully watched show can take that long.
const EPISODE_INVENTORY_TTL_MS = 30 * 60 * 1000;
// A failed lookup is not cached (it is not evidence the episode is absent), so
// without a backoff every projection rebuild during an outage re-ran every
// lookup against the unreachable server: about 2,800 failed Jellyfin requests,
// each logged with a stack trace, in a few minutes. Stand the provider down for
// about one scheduler tick after a failure; cached answers are still used.
const PROVIDER_OUTAGE_BACKOFF_MS = 60 * 1000;
// Library answers (found and missing) are also kept in SQLite, so a restart or
// another process starts from the last answers instead of an empty cache. A
// cold cache after a restart showed 20 cards that fell to 14 as the answers
// came back 32 per build (plan/archive/up-next-build-speed/summary.md step 1). Restarting
// during a Jellyfin outage also dropped every local next-up card only Jellyfin
// could prove (The Assembly S01E01, defect V). A remembered answer is the last
// thing the library itself said; a live answer replaces it. An answer past its
// TTL above is still used (the user's choice, step 3) while the background
// top-up asks again; only a key never answered stays unanswered.
const REMEMBERED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REMEMBERED_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastRememberedPrune = 0;

const lookupCache = new Map();
const episodeInventoryCache = new Map();
const providerOutages = new Map();
let outageNow = () => Date.now();

function outageKey(provider, config) {
  return `${provider}:${text(config?.[provider]?.baseUrl).toLowerCase()}`;
}

function providerInOutage(provider, config) {
  const key = outageKey(provider, config);
  const until = providerOutages.get(key);
  if (!until) return false;
  if (outageNow() < until) return true;
  providerOutages.delete(key);
  return false;
}

function recordProviderOutage(provider, config) {
  providerOutages.set(outageKey(provider, config), outageNow() + PROVIDER_OUTAGE_BACKOFF_MS);
}

function clearProviderOutage(provider, config) {
  providerOutages.delete(outageKey(provider, config));
}

export function __setUpNextLibraryLookupNow(fn) {
  outageNow = typeof fn === "function" ? fn : () => Date.now();
}

function text(value = "") {
  return String(value ?? "").trim();
}

function providerIdValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => {
    if (entry && typeof entry === "object") return text(entry.id || entry.Id || entry.ratingKey || entry.provider_item_id);
    return text(entry);
  }).filter(Boolean);
}

function requestedProviderIds(item = {}, provider) {
  const source = item.provider_items || item.providerItems || {};
  const direct = providerIdValues(source[provider]);
  const sourceProvider = text(item.provider || item.source).toLowerCase();
  const sourceId = text(item.provider_item_id || item.providerItemId);
  if (sourceProvider === provider && sourceId) direct.push(sourceId);
  return [...new Set(direct)];
}

// Build the media descriptor the Plex/Emby lookup helpers expect from an Up
// Next item. Shared by the authoritative playlist push and the projection's
// local fallback so both resolve an episode the same way.
export function upNextLookupMedia(item = {}) {
  const type = text(item.media_type || item.mediaType).toLowerCase();
  const mediaType = type === "movie" ? "movie" : type === "episode" ? "episode" : "";
  const isEpisode = mediaType === "episode";
  const showIds = {
    imdb: text(item.show_imdb_id || item.showImdbId),
    tmdb: text(item.show_tmdb_id || item.showTmdbId),
    tvdb: text(item.show_tvdb_id || item.showTvdbId),
  };
  const episodeIds = {
    imdb: text(item.episode_imdb_id || item.episodeImdbId),
    tmdb: text(item.episode_tmdb_id || item.episodeTmdbId),
    tvdb: text(item.episode_tvdb_id || item.episodeTvdbId),
  };
  const fallbackIds = {
    imdb: text(item.imdb_id || item.imdbId || item.imdb),
    tmdb: text(item.tmdb_id || item.tmdbId || item.tmdb),
    tvdb: text(item.tvdb_id || item.tvdbId || item.tvdb),
  };
  return {
    type: mediaType,
    media_type: mediaType,
    title: text(item.title || item.episode_title || item.show_title),
    show_title: text(item.show_title || item.showTitle),
    season: item.season === "" || item.season == null ? undefined : Number(item.season),
    episode: item.episode === "" || item.episode == null ? undefined : Number(item.episode),
    // Episode lookup needs the series identity. The episode ids remain on the
    // object as well for clients that can use them, but must not be promoted
    // to a series id when the show ids are available.
    ids: isEpisode
      ? {
        imdb: showIds.imdb || fallbackIds.imdb,
        tmdb: showIds.tmdb || fallbackIds.tmdb,
        tvdb: showIds.tvdb || fallbackIds.tvdb,
      }
      : fallbackIds,
    show_imdb_id: showIds.imdb,
    show_tmdb_id: showIds.tmdb,
    show_tvdb_id: showIds.tvdb,
    episode_imdb_id: episodeIds.imdb || (isEpisode ? fallbackIds.imdb : ""),
    episode_tmdb_id: episodeIds.tmdb || (isEpisode ? fallbackIds.tmdb : ""),
    episode_tvdb_id: episodeIds.tvdb || (isEpisode ? fallbackIds.tvdb : ""),
    provider_items: item.provider_items || item.providerItems || {},
    provider_item_id: text(item.provider_item_id || item.providerItemId),
  };
}

function runtimeMsOf(provider, result) {
  if (!result) return 0;
  if (provider === "plex") return Math.max(0, Math.round(Number(result.duration) || 0));
  const ticks = Number(result.RunTimeTicks ?? result.runTimeTicks ?? 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

export async function resolveUpNextProviderItemId(provider, config, item) {
  const ordered = await resolveOrderUpNextItem(provider, config, item);
  if (ordered) return ordered;
  const direct = requestedProviderIds(item, provider);
  if (direct.length) return { providerItemId: direct[0], direct: true, runtimeMs: 0 };

  const media = upNextLookupMedia(item);
  if (!media.type || !media.title) return { providerItemId: "", reason: "The Up Next item has no usable media identity." };
  const result = provider === "plex"
    ? await findPlexItem(config, media)
    : provider === "jellyfin"
      ? (await findJellyfinItems(config, media))[0]
      : (await findEmbyItems(config, media))[0];
  const providerItemId = provider === "plex"
    ? text(result?.ratingKey)
    : text(result?.Id || result?.id);
  if (!providerItemId) return { providerItemId: "", reason: "The item was not found in the provider library." };
  return { providerItemId, direct: false, runtimeMs: runtimeMsOf(provider, result) };
}

// An item resolved straight from a stored provider id never passes through a
// search result, so it arrives with no runtime. Fetch it for playlist and
// native-rail diagnostics that need the provider's confirmed item metadata.
// Cached for the process lifetime: an episode's runtime does not change.
const runtimeCache = new Map();

async function providerRuntimeMs(provider, config, providerItemId) {
  const key = `${provider}:${text(config?.baseUrl).toLowerCase()}:${providerItemId}`;
  if (runtimeCache.has(key)) return runtimeCache.get(key);
  let runtimeMs = 0;
  try {
    if (provider === "plex") {
      const item = await fetchPlexMetadataItem(config, providerItemId, { lane: "interactive" });
      runtimeMs = Math.max(0, Math.round(Number(item?.duration) || 0));
    } else if (provider === "jellyfin") {
      runtimeMs = await fetchJellyfinItemRuntimeMs(config, providerItemId);
    } else {
      runtimeMs = await fetchEmbyItemRuntimeMs(config, providerItemId);
    }
  } catch {
    // Without a runtime the seed reports the item as skipped, which is the
    // correct outcome; it must not fail the whole push.
    runtimeMs = 0;
  }
  if (runtimeMs > 0) runtimeCache.set(key, runtimeMs);
  return runtimeMs;
}

// One resolution pass per provider per push, shared by the playlist
// reconciliation and native calculated-rail refresh.
//
// They used to resolve independently, and the two passes disagreed: a lookup
// that timed out during the playlist pass succeeded seconds later for the
// seed, so the Plex playlist kept a stale entry and missed two items that the
// seed had no trouble finding. Resolving once removes the disagreement, the
// shared cache makes the retry cheap, and carrying the resolved item through
// gives the seed the runtime it needs to size a position the provider will
// actually keep.
export async function resolveUpNextProviderTargets({
  provider,
  config,
  items = [],
  limit = 100,
  concurrency = 4,
} = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, limit);
  const outcomes = Array(list.length);
  await runWithConcurrency(list, async (item, index) => {
    const attempt = async () => resolveUpNextProviderItemId(provider, config, item);
    let target = null;
    let failure = "";
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        target = await attempt();
        if (target.providerItemId) break;
        failure = target.reason || "Provider item was not resolved.";
        // A clean "not in this library" answer is final; only retry the
        // transient case, which is what a timeout looks like here.
        if (!/timed out|timeout|failed|reset|refused/i.test(failure)) break;
      } catch (error) {
        failure = text(error?.message || error) || "Provider item lookup failed.";
        if (!/timed out|timeout|fetch failed|reset|refused/i.test(failure)) break;
      }
    }
    if (!target?.providerItemId) {
      outcomes[index] = { title: text(item?.title || item?.show_title || "Untitled"), reason: failure || "Provider item was not resolved." };
      return;
    }
    let runtimeMs = Math.max(
      Number(target.runtimeMs || 0),
      Math.max(0, Math.round(Number(item?.duration_ms ?? item?.durationMs) || 0)),
    );
    if (runtimeMs <= 0) runtimeMs = await providerRuntimeMs(provider, config, target.providerItemId);
    outcomes[index] = { item, providerItemId: target.providerItemId, runtimeMs };
  }, concurrency);

  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (!outcome.providerItemId) {
      unresolved.push(outcome);
      continue;
    }
    if (seen.has(outcome.providerItemId)) continue;
    seen.add(outcome.providerItemId);
    resolved.push(outcome);
  }
  return { provider, resolved, unresolved };
}

export function configuredProvider(config, provider) {
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && (section.apiKey || section.api_key || section.token) && section.userId);
}

function cacheKey(provider, config, media) {
  const base = text(config?.[provider]?.baseUrl).toLowerCase();
  const ids = [media.show_imdb_id, media.show_tmdb_id, media.show_tvdb_id]
    .map((value) => text(value).toLowerCase())
    .join("|");
  const title = text(media.show_title || media.title).toLowerCase();
  const season = media.season == null ? "" : media.season;
  const episode = media.episode == null ? "" : media.episode;
  return `${provider}:${base}:${ids}:${title}:s${season}e${episode}${upNextOrderRevision(media) ? `:order:${upNextOrderRevision(media)}` : ""}`;
}

function entryExpired(entry) {
  const ttl = entry.providerItemId ? RESOLVED_TTL_MS : MISSING_TTL_MS;
  return outageNow() - entry.at >= ttl;
}

function storeInMemory(key, entry) {
  if (!lookupCache.has(key) && lookupCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest !== undefined) lookupCache.delete(oldest);
  }
  lookupCache.set(key, entry);
}

// The last answer for a key, from memory or else the saved answers, with
// `stale` set once it is past its TTL. A stale memory entry is checked against
// the saved answer, which another process may have refreshed since.
function readCache(key) {
  let entry = lookupCache.get(key) || null;
  if (!entry || entryExpired(entry)) {
    const saved = rememberedEntry(key);
    if (saved && (!entry || saved.at > entry.at)) {
      entry = saved;
      storeInMemory(key, entry);
    }
  }
  if (!entry) return null;
  return { ...entry, stale: entryExpired(entry) };
}

function writeCache(key, providerItemId) {
  storeInMemory(key, { at: outageNow(), providerItemId });
}

// An empty provider_item_id is a saved "not in this library" answer.
function rememberAnswer(key, provider, providerItemId) {
  const now = outageNow();
  try {
    db.prepare(`
      INSERT INTO up_next_library_items (lookup_key, provider, provider_item_id, resolved_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lookup_key) DO UPDATE SET
        provider_item_id = excluded.provider_item_id,
        resolved_at = excluded.resolved_at
    `).run(key, provider, text(providerItemId), now);
    if (now - lastRememberedPrune >= REMEMBERED_PRUNE_INTERVAL_MS) {
      lastRememberedPrune = now;
      db.prepare("DELETE FROM up_next_library_items WHERE resolved_at < ?").run(now - REMEMBERED_TTL_MS);
    }
  } catch (error) {
    console.error(`[up-next] Could not remember a library lookup: ${error?.message || error}`);
  }
}

function rememberedEntry(key) {
  try {
    const row = db.prepare(
      "SELECT provider_item_id, resolved_at FROM up_next_library_items WHERE lookup_key = ? AND resolved_at >= ?",
    ).get(key, outageNow() - REMEMBERED_TTL_MS);
    return row ? { at: Number(row.resolved_at) || 0, providerItemId: text(row.provider_item_id) } : null;
  } catch {
    return null;
  }
}

function rememberedAnswer(key) {
  return rememberedEntry(key)?.providerItemId || "";
}

// Clears this process's memory only (what a restart loses); the saved answers
// in up_next_library_items stay.
export function clearUpNextLibraryLookupCache() {
  lookupCache.clear();
  episodeInventoryCache.clear();
  runtimeCache.clear();
  providerOutages.clear();
}

export function providerEpisodeId(provider, episode = {}) {
  return text(provider === "plex" ? (episode.ratingKey || episode.key) : episode.Id || episode.id);
}

export function providerEpisodeCoordinate(provider, episode = {}) {
  const season = Number(provider === "plex" ? episode.parentIndex : episode.ParentIndexNumber);
  const number = Number(provider === "plex" ? episode.index : episode.IndexNumber);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(number) || number < 1) return null;
  return { season, episode: number };
}

function providerEpisodeTitle(provider, episode = {}) {
  return text(provider === "plex" ? episode.title : episode.Name || episode.name || episode.Title || episode.title);
}

function providerEpisodeAirDate(provider, episode = {}) {
  return text(provider === "plex"
    ? episode.originallyAvailableAt || episode.originallyAvailableAtUtc
    : episode.PremiereDate || episode.PremiereDateUtc || episode.premiereDate);
}

export function providerSeriesEpisodes(provider, config, media) {
  if (provider === "plex") return fetchPlexSeriesEpisodes(config.plex, media);
  if (provider === "emby") return fetchEmbySeriesEpisodes(config.emby, media);
  return fetchJellyfinSeriesEpisodes(config.jellyfin, media);
}

function providerInventoryKey(provider, config, show = {}) {
  const ids = [show.imdb_id, show.tmdb_id, show.tvdb_id].map((value) => text(value).toLowerCase()).join("|");
  return `${provider}:${text(config?.[provider]?.baseUrl).toLowerCase()}:${ids}:${text(show.title).toLowerCase()}${upNextOrderRevision(show) ? `:order:${upNextOrderRevision(show)}` : ""}`;
}

// A new episode can exist in a configured media-server library before the
// cached TMDB/TVDB season list knows about it. In that window an episode-level
// lookup has no coordinate to search for. Keep a short-lived series inventory
// snapshot so the Up Next projection can discover the first available episode
// after the user's canonical watched history without turning every dashboard
// refresh into a full provider scan.
//
// `stats`, when given, counts cache hits and live fetches for the build's
// summary log line.
export function createUpNextLibraryEpisodeLookup(config = {}, { stats = null } = {}) {
  const providers = PROVIDERS.filter((provider) => configuredProvider(config, provider));
  if (!providers.length) return null;

  return async function resolveProviderEpisodes(show = {}) {
    const media = upNextLookupMedia({
      media_type: "episode",
      title: show.title,
      show_title: show.title,
      show_imdb_id: show.imdb_id,
      show_tmdb_id: show.tmdb_id,
      show_tvdb_id: show.tvdb_id,
    });
    if (!media.title || !media.show_title) return [];

    const results = await Promise.all(providers.map(async (provider) => {
      const key = providerInventoryKey(provider, config, show);
      const cached = episodeInventoryCache.get(key);
      if (cached && outageNow() - cached.at < EPISODE_INVENTORY_TTL_MS) {
        if (stats) stats.inventoryCached = (stats.inventoryCached || 0) + 1;
        return cached.episodes;
      }
      if (providerInOutage(provider, config)) return [];
      if (stats) stats.inventoryFetched = (stats.inventoryFetched || 0) + 1;
      try {
        const rawEpisodes = await providerSeriesEpisodes(provider, config, media);
        clearProviderOutage(provider, config);
        const episodes = (Array.isArray(rawEpisodes) ? rawEpisodes : [])
          .map((episode) => {
            const coordinate = canonicalOrderCoordinate(provider, episode, show, providerEpisodeCoordinate(provider, episode));
            const providerItemId = providerEpisodeId(provider, episode);
            if (!coordinate || !providerItemId) return null;
            return {
              queue_kind: "next_up",
              media_type: "episode",
              title: `${show.title} - S${String(coordinate.season).padStart(2, "0")}E${String(coordinate.episode).padStart(2, "0")}`,
              show_title: show.title,
              episode_title: providerEpisodeTitle(provider, episode),
              season: coordinate.season,
              episode: coordinate.episode,
              show_ids: {
                imdb: text(show.imdb_id),
                tmdb: text(show.tmdb_id),
                tvdb: text(show.tvdb_id),
              },
              provider_items: { [provider]: [providerItemId] },
              provider: provider,
              source: provider,
              air_date: providerEpisodeAirDate(provider, episode),
            };
          })
          .filter(Boolean);
        if (episodeInventoryCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = episodeInventoryCache.keys().next().value;
          if (oldest !== undefined) episodeInventoryCache.delete(oldest);
        }
        episodeInventoryCache.set(key, { at: outageNow(), episodes });
        return episodes;
      } catch {
        // A failed inventory is not evidence that the show is absent. Do not
        // cache failures, so the next projection can retry after an outage.
        recordProviderOutage(provider, config);
        return [];
      }
    }));
    return results.flat();
  };
}

// Local history plus TMDB metadata is enough to know which episode comes next,
// but not enough to prove that episode exists in a configured library, and a
// card for an episode nobody can play is worse than no card. Watch history
// only carries a native item id once something has been played, so an
// unwatched next episode never has one - which is why Reacher S04E07 could be
// in Plex, Emby, and Plembfin's own show detail and still be missing from Up
// Next. Ask the library directly instead, with the same lookup the
// authoritative push already uses, and cache both answers.
//
// Returns null when no supported provider is configured, so the caller keeps
// its offline behavior instead of silently dropping every fallback candidate.
//
// With `{ detailed: true }` it returns `{ providerItems, unanswered }`, where
// `unanswered` lists the providers that were not asked (budget, outage) or
// failed. A missing id from a provider not in that list is a real "not in this
// library" answer.
//
// `stats`, when given, counts cache hits, live lookups, and lookups skipped
// for lack of budget, for the build's summary log line. `deferred`, when given,
// collects the `{ candidate, provider }` pairs skipped for lack of budget, and
// those answered from an expired answer, so the caller can hand them to
// topUpUpNextLibraryLookups. `recheck` (the top-up) asks the library again for
// an expired answer instead of using it.
export function createUpNextLibraryLookup(config = {}, { stats = null, deferred = null, recheck = false } = {}) {
  const providers = PROVIDERS.filter((provider) => configuredProvider(config, provider));
  if (!providers.length) return null;
  let budget = MAX_LOOKUPS_PER_BUILD;

  return async function resolveProviderItems(candidate, { detailed = false, only = null } = {}) {
    // `only` limits the lookup to named providers, so a caller filling a gap
    // does not spend the build budget re-asking providers it already has.
    const asked = Array.isArray(only) ? providers.filter((provider) => only.includes(provider)) : providers;
    const media = upNextLookupMedia(candidate);
    if (!media.type || !media.title) return detailed ? { providerItems: {}, unanswered: [...asked] } : {};
    const providerItems = {};
    const unanswered = [];
    for (const provider of asked) {
      const key = cacheKey(provider, config, media);
      const cached = readCache(key);
      if (cached && !cached.stale) {
        if (stats) stats.itemCached = (stats.itemCached || 0) + 1;
        if (cached.providerItemId) providerItems[provider] = [cached.providerItemId];
        continue;
      }
      // An unreachable provider still counts as unanswered, but its last
      // resolved id (from before a restart) keeps the card it proved.
      const useRemembered = () => {
        const remembered = rememberedAnswer(key);
        if (remembered) providerItems[provider] = [remembered];
        unanswered.push(provider);
      };
      if (providerInOutage(provider, config)) {
        useRemembered();
        continue;
      }
      // An expired answer keeps its card and is asked again in the background,
      // so the card set does not change while answers are refreshed.
      if (cached && !recheck) {
        if (stats) stats.itemCached = (stats.itemCached || 0) + 1;
        if (deferred) deferred.push({ candidate, provider });
        if (cached.providerItemId) providerItems[provider] = [cached.providerItemId];
        continue;
      }
      if (budget <= 0) {
        if (stats) stats.itemOverBudget = (stats.itemOverBudget || 0) + 1;
        if (deferred) deferred.push({ candidate, provider });
        unanswered.push(provider);
        continue;
      }
      budget -= 1;
      if (stats) stats.itemLive = (stats.itemLive || 0) + 1;
      try {
        const { providerItemId } = await resolveUpNextProviderItemId(provider, config[provider], candidate);
        clearProviderOutage(provider, config);
        writeCache(key, providerItemId);
        // A direct stored id is returned unverified; only a library answer
        // is worth remembering.
        if (!media.provider_item_id && !Object.keys(media.provider_items || {}).length) {
          rememberAnswer(key, provider, providerItemId);
        }
        if (providerItemId) providerItems[provider] = [providerItemId];
      } catch {
        // A provider that cannot answer right now is not evidence that the
        // episode is absent. Leave it uncached so the next build retries
        // rather than hiding a real episode for the whole miss window.
        recordProviderOutage(provider, config);
        useRemembered();
      }
    }
    return detailed ? { providerItems, unanswered } : providerItems;
  };
}

// The per-build budget keeps a dashboard refresh fast, but a real library has
// about 486 keys and the dashboard rebuilds only a few times an hour, so the
// cache never filled before the 2-hour miss window expired its oldest answers
// and every rebuild kept paying 4-5s (speed finding AK, measured on the running
// server 26 September). The user chose a background top-up: after a build, the
// lookups it skipped for budget are asked here, one batch of the same size at a
// time with a pause between batches, so the next rebuild finds them cached.
// One top-up at a time; a build that arrives while one runs adds nothing,
// because its skipped lookups are the ones already being asked.
const TOP_UP_BATCH_PAUSE_MS = 2000;
let topUpRunning = null;

export function topUpUpNextLibraryLookups(config = {}, deferred = [], {
  pauseMs = TOP_UP_BATCH_PAUSE_MS,
  log = (message) => console.log(message),
} = {}) {
  if (topUpRunning || !Array.isArray(deferred) || !deferred.length) return topUpRunning;
  const pending = new Map();
  for (const entry of deferred) {
    const media = upNextLookupMedia(entry?.candidate);
    if (!entry?.provider || !media.type || !media.title) continue;
    const key = cacheKey(entry.provider, config, media);
    if (!pending.has(key)) pending.set(key, entry);
  }
  if (!pending.size) return null;
  topUpRunning = (async () => {
    const startedAt = Date.now();
    const stats = {};
    const entries = [...pending.values()];
    try {
      for (let start = 0; start < entries.length; start += MAX_LOOKUPS_PER_BUILD) {
        if (start > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        const lookup = createUpNextLibraryLookup(config, { stats, recheck: true });
        if (!lookup) break;
        for (const { candidate, provider } of entries.slice(start, start + MAX_LOOKUPS_PER_BUILD)) {
          await lookup(candidate, { only: [provider] });
        }
      }
    } catch {
      // A lookup failure is already recorded as a provider outage; the next
      // build retries whatever is still uncached.
    } finally {
      const n = (value) => Number(value) || 0;
      log(`Up Next lookup top-up: ${entries.length} skipped lookups in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; `
        + `${n(stats.itemLive)} live, ${n(stats.itemCached)} already cached.`);
      topUpRunning = null;
    }
  })();
  return topUpRunning;
}
