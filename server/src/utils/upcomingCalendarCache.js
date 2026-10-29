import fs from "node:fs/promises";
import path from "node:path";
import { getActiveDataDir } from "./userContext.js";
import { getCachedShows } from "./dataRepo.js";
import { getTmdbDetails, getTmdbSeason } from "./tmdbGateway.js";
import { getCanonicalSeasonPosterUrls } from "./mediaArtwork.js";
import { cachedNextAiringFor, readNextAiringCache } from "./nextAiringCache.js";

const CACHE_VERSION = 2;
const FUTURE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Floor between background rebuilds triggered by opening the page, so repeatedly
// refreshing the browser cannot queue a rebuild storm against TMDB/TVDB.
const REVALIDATE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const CACHE_MAX_MONTHS = 60;
const BACKGROUND_HISTORY_MONTHS = 24;
const BACKGROUND_FUTURE_MONTHS = 12;
const UPCOMING_CONCURRENCY = 4;

const cacheStates = new Map();

function cacheState(dataDir = getActiveDataDir()) {
  const directory = path.resolve(dataDir);
  let state = cacheStates.get(directory);
  if (!state) {
    state = {
      directory,
      memoryCache: null,
      memoryMtimeMs: 0,
      writeChain: Promise.resolve(),
      buildsInFlight: new Map(),
      checkedAtByMonth: new Map(),
      preferHistoricalBuild: true,
    };
    cacheStates.set(directory, state);
  }
  return state;
}

function emptyCache() {
  return { version: CACHE_VERSION, updatedAt: 0, months: {} };
}

async function readCache(state = cacheState()) {
  const cacheFile = path.join(state.directory, "upcoming-calendar-cache.json");
  try {
    const stat = await fs.stat(cacheFile);
    if (state.memoryCache && state.memoryMtimeMs === stat.mtimeMs) return state.memoryCache;
    const parsed = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    state.memoryCache = {
      version: CACHE_VERSION,
      updatedAt: Number(parsed?.updatedAt || 0),
      months: parsed?.months && typeof parsed.months === "object" ? parsed.months : {},
    };
    state.memoryMtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to read upcoming calendar cache", error);
    state.memoryCache = emptyCache();
    state.memoryMtimeMs = 0;
  }
  return state.memoryCache;
}

function trimMonths(months) {
  const entries = Object.entries(months);
  if (entries.length <= CACHE_MAX_MONTHS) return months;
  entries.sort((a, b) => Number(b[1]?.builtAt || 0) - Number(a[1]?.builtAt || 0));
  return Object.fromEntries(entries.slice(0, CACHE_MAX_MONTHS));
}

async function storeMonth(month, payload, showKeys, state = cacheState()) {
  let changed = false;
  state.writeChain = state.writeChain.catch(() => {}).then(async () => {
    const cache = await readCache(state);
    const existing = cache.months[month];
    const normalizedKeys = [...new Set(showKeys)].sort();
    if (JSON.stringify(existing?.payload) === JSON.stringify(payload)
      && JSON.stringify(existing?.showKeys || []) === JSON.stringify(normalizedKeys)) return;
    const now = Date.now();
    const next = {
      version: CACHE_VERSION,
      updatedAt: now,
      months: trimMonths({ ...cache.months, [month]: { builtAt: now, showKeys: normalizedKeys, payload } }),
    };
    const cacheFile = path.join(state.directory, "upcoming-calendar-cache.json");
    const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.mkdir(state.directory, { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(next), "utf8");
    await fs.rename(tempFile, cacheFile);
    state.memoryCache = next;
    state.memoryMtimeMs = await fs.stat(cacheFile).then((stat) => stat.mtimeMs, () => 0);
    changed = true;
  });
  await state.writeChain;
  return changed;
}

function monthBounds(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function showKey(show) {
  const tmdbId = String(show?.tmdb_id || "").trim();
  if (tmdbId) return `tmdb:${tmdbId}`;
  const title = String(show?.title || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return title ? `title:${title}` : "";
}

function uniqueTrackedShows(shows) {
  const seen = new Set();
  return shows.filter((show) => {
    const key = showKey(show);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// One series can be tracked as two shows (one grouped by tmdb id, one by tvdb id
// with no tmdb id recorded) that both resolve to the same tmdb id. They carry
// different showIds, so keying on showId alone listed every episode twice. An
// episode is therefore identified by its TVDB series id (unique per series, and
// two tracked shows can carry different tmdb ids for one series), then its tmdb
// id; only episodes with neither fall back to their show id.
function episodeIdentityKey(episode) {
  const owner = episode.tvdbId ? `tvdb:${episode.tvdbId}`
    : episode.tmdbId ? `tmdb:${episode.tmdbId}`
      : `show:${episode.showId}`;
  return [episode.airDate, owner, episode.season, episode.episode].join("|");
}

// When two entries are the same episode, keep the one from the tmdb-keyed show
// and the one that carries artwork.
function episodeEntryRank(episode) {
  return (String(episode.showId || "").startsWith("tmdb:") ? 2 : 0)
    + (episode.posterUrl || episode.posterRecordId ? 1 : 0);
}

export function sortAndDedupeEpisodes(episodes) {
  const chosen = new Map();
  for (const episode of episodes) {
    const key = episodeIdentityKey(episode);
    const current = chosen.get(key);
    if (!current || episodeEntryRank(episode) > episodeEntryRank(current)) chosen.set(key, episode);
  }
  return [...chosen.values()].sort((a, b) => a.airDate.localeCompare(b.airDate)
    || a.showTitle.localeCompare(b.showTitle)
    || a.season - b.season
    || a.episode - b.episode);
}

async function collectMonth(month, { shows: suppliedShows = null, prefilterFuture = true } = {}) {
  const { start, end } = monthBounds(month);
  const thisMonth = currentMonth();
  const isHistoricalMonth = month < thisMonth;
  const includesHistory = month <= thisMonth;
  const [allShows, airingCache] = await Promise.all([
    suppliedShows || getCachedShows({ includeScheduledLibraryHistory: true }),
    readNextAiringCache(),
  ]);
  const trackedShows = uniqueTrackedShows(allShows);
  const queue = trackedShows.filter((show) => {
    if (!includesHistory && prefilterFuture) {
      const entry = cachedNextAiringFor(airingCache.entries, show.tmdb_id, show.title);
      if (!entry?.nextAiringDate || entry.nextAiringDate > end) return false;
    }
    return true;
  });

  const episodes = [];
  async function worker() {
    for (let show = queue.shift(); show; show = queue.shift()) {
      const details = await getTmdbDetails({ mediaType: "tv", tmdbId: show.tmdb_id, title: show.title, ids: { tvdbId: show.tvdb_id } }).catch(() => null);
      const tvdbId = String(details?.external_ids?.tvdb_id || show.tvdb_id || "");
      if (!tvdbId) continue;
      const seasonPosterUrls = getCanonicalSeasonPosterUrls({
        media_type: "tv",
        title: show.title,
        tmdb_id: show.tmdb_id || details?.id,
        tvdb_id: tvdbId,
      });
      const maxSeason = Math.max(0, ...(details?.seasons || []).map((season) => Number(season.season_number) || 0));
      const seasonNumbers = isHistoricalMonth
        ? [...new Set((details?.seasons || []).map((season) => Number(season.season_number) || 0))].filter((value) => value > 0)
        // Metadata can contain an empty placeholder for the next season while
        // the currently airing episodes still belong to maxSeason - 1 (Silo
        // has an empty Season 4 while Season 3 airs in July/August 2026).
        : [...new Set([maxSeason - 1, maxSeason, maxSeason + 1])].filter((value) => value > 0);
      for (const seasonNumber of seasonNumbers) {
        const season = await getTmdbSeason({ tmdbId: show.tmdb_id || details?.id, tvdbId, seasonNumber }).catch(() => null);
        for (const episode of season?.episodes || []) {
          const airDate = String(episode.air_date || "");
          if (!airDate || airDate < start || airDate > end) continue;
          episodes.push({
            airDate,
            showTitle: show.title,
            showId: show.id,
            // Prefer the id Plembfin already has recorded for this show over a
            // freshly re-resolved one: getTmdbDetails falls back to a title
            // search when the direct fetch fails, which can land on a
            // different (wrong) show entirely for an ambiguous or generic
            // title - the already-confirmed local id doesn't have that risk.
            tmdbId: String(show.tmdb_id || details?.id || ""),
            tvdbId,
            posterUrl: show.poster_url || "",
            seasonPosterUrl: seasonPosterUrls.get(seasonNumber) || "",
            posterRecordId: show.representative_episode?.id || "",
            season: seasonNumber,
            episode: Number(episode.episode_number) || 0,
            episodeTitle: episode.name || "",
            status: details?.status || show.status || "",
          });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(UPCOMING_CONCURRENCY, queue.length)) }, worker));

  return {
    payload: { month, start, end, episodes: sortAndDedupeEpisodes(episodes) },
    showKeys: trackedShows.map(showKey),
  };
}

async function buildAndStoreMonth(month, state = cacheState()) {
  if (state.buildsInFlight.has(month)) return state.buildsInFlight.get(month);
  const promise = collectMonth(month)
    .then(async ({ payload, showKeys }) => {
      const changed = await storeMonth(month, payload, showKeys, state);
      return { payload, changed };
    })
    .finally(() => state.buildsInFlight.delete(month));
  state.buildsInFlight.set(month, promise);
  return promise;
}

// Rebuild without making the caller wait. Builds are deduped by month via
// buildsInFlight, and throttled so a burst of page opens triggers at most one.
function queueBackgroundRebuild(month, builtAt, state = cacheState()) {
  const lastBuild = Number(state.checkedAtByMonth.get(month) || builtAt || 0);
  if (Date.now() - lastBuild < REVALIDATE_MIN_INTERVAL_MS) return false;
  state.checkedAtByMonth.set(month, Date.now());
  console.log(`Upcoming calendar: serving ${month} from cache, rebuilding in the background...`);
  buildAndStoreMonth(month, state)
    .then((result) => {
      console.log(`Upcoming calendar background rebuild complete: ${month}, ${result.payload.episodes.length} episode${result.payload.episodes.length === 1 ? "" : "s"}${result.changed ? ", cache updated" : ", unchanged"}.`);
    })
    .catch((error) => {
      console.warn(`Upcoming calendar background rebuild failed for ${month}: ${error.message}`);
    });
  return true;
}

export async function getUpcomingCalendarMonth(month, { refresh = false, revalidate = false } = {}) {
  const state = cacheState();
  if (refresh) return (await buildAndStoreMonth(month, state)).payload;

  const cache = await readCache(state);
  const entry = cache.months[month];
  if (!entry?.payload) return (await buildAndStoreMonth(month, state)).payload;

  // Opening the page refreshes the month behind the request rather than in
  // front of it. Rebuilding takes several seconds, so doing it inline left the
  // calendar blank on every visit even though usable data was already on disk.
  // The cheap newly-tracked-show merge below still runs, so a show added a
  // moment ago appears immediately instead of waiting for the rebuild.
  if (revalidate) queueBackgroundRebuild(month, entry.builtAt, state);

  // Library-derived shows can change at any time. Add only newly tracked shows
  // to an existing month so the calendar updates immediately without rebuilding
  // every show and season already represented in the local cache.
  const trackedShows = uniqueTrackedShows(await getCachedShows({ includeScheduledLibraryHistory: true }));
  const covered = new Set(entry.showKeys || []);
  const missingShows = trackedShows.filter((show) => !covered.has(showKey(show)));
  // Cached months built before the identity dedupe may still hold both copies.
  if (!missingShows.length) return { ...entry.payload, episodes: sortAndDedupeEpisodes(entry.payload.episodes || []) };
  const addition = await collectMonth(month, { shows: missingShows, prefilterFuture: false });
  const payload = {
    ...entry.payload,
    episodes: sortAndDedupeEpisodes([...(entry.payload.episodes || []), ...addition.payload.episodes]),
  };
  await storeMonth(month, payload, [...covered, ...trackedShows.map(showKey)], state);
  return payload;
}

export async function refreshUpcomingCalendarCache({ forceCurrent = false } = {}) {
  const state = cacheState();
  const cache = await readCache(state);
  const anchor = currentMonth();
  const historicalMonths = Array.from({ length: BACKGROUND_HISTORY_MONTHS }, (_, index) => addMonths(anchor, -(index + 1)));
  const futureMonths = Array.from({ length: BACKGROUND_FUTURE_MONTHS + 1 }, (_, index) => addMonths(anchor, index));
  const missingHistorical = historicalMonths.find((month) => !cache.months[month]);
  const missingFuture = futureMonths.find((month) => !cache.months[month]);
  let month;
  if (!cache.months[anchor]) month = anchor;
  else if (missingHistorical && missingFuture) {
    month = state.preferHistoricalBuild ? missingHistorical : missingFuture;
    state.preferHistoricalBuild = !state.preferHistoricalBuild;
  } else {
    month = missingHistorical || missingFuture;
  }
  if (forceCurrent) {
    // A restart is a useful freshness boundary: refresh the month users land
    // on immediately, even when its normal six-hour check has not elapsed.
    // The persisted payload is still served while this rebuild is in flight.
    month = anchor;
  } else if (!month) {
    month = futureMonths
      .filter((candidate) => Date.now() - Number(state.checkedAtByMonth.get(candidate) || cache.months[candidate]?.builtAt || 0) >= FUTURE_CHECK_INTERVAL_MS)
      .sort((a, b) => Number(state.checkedAtByMonth.get(a) || cache.months[a]?.builtAt || 0)
        - Number(state.checkedAtByMonth.get(b) || cache.months[b]?.builtAt || 0))[0];
  }
  if (!month) return { refreshed: 0 };
  console.log(`Upcoming calendar cache refresh: checking ${month}...`);
  const result = await buildAndStoreMonth(month, state);
  state.checkedAtByMonth.set(month, Date.now());
  console.log(`Upcoming calendar cache refresh complete: ${month}, ${result.payload.episodes.length} episode${result.payload.episodes.length === 1 ? "" : "s"}${result.changed ? ", cache updated" : ", unchanged"}.`);
  return { refreshed: 1, changed: result.changed, month, episodes: result.payload.episodes.length };
}
