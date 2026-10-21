import {
  fetchPlexContinueWatchingItems,
  fetchPlexSeriesEpisodes,
  markPlexPlayed,
  markPlexUnplayed,
} from "./plexClient.js";
import {
  fetchEmbyNextUpItems,
  fetchEmbyResumableItems,
  fetchEmbySeriesEpisodes,
  markEmbyPlayed,
  markEmbyUnplayed,
  touchEmbyResumeRail,
} from "./embyClient.js";
import {
  fetchJellyfinNextUpItems,
  fetchJellyfinResumableItems,
  fetchJellyfinSeriesEpisodes,
  markJellyfinPlayed,
  markJellyfinUnplayed,
  updateJellyfinUserData,
} from "./jellyfinClient.js";
import {
  completeUpNextProviderFeed,
  failUpNextProviderFeed,
  isPlektPrimaryUpNextFeed,
  startUpNextProviderFeed,
  withUpNextFeedSeriesIdentity,
} from "./upNextRepository.js";
import { getPlaystateForMediaSync } from "./dataRepo.js";
import { normalizeUpNextCandidate, upNextIdentityAliases } from "./upNextIdentity.js";
import { createLoopStore } from "./loopStore.js";
import { recordOutboundPlayedMarks, recordOutboundProgressMarks, recordOutboundRailRefresh, recordOutboundUnplayedMarks, syncMediaProgress } from "./syncOrchestrator.js";
import { clearLegacyUpNextRailSeeds, clearLegacyUpNextRailSeed } from "./upNextRailSeed.js";
import { resolveUpNextProviderTargets, upNextLookupMedia } from "./upNextLibraryLookup.js";
import { isUpNextRailSeedPosition, listUpNextRailSeeds } from "./upNextSeedLedger.js";
import { plexHistoricalSyncAllowed } from "./watchSyncPolicy.js";

// All three media servers participate in Up Next. Jellyfin was briefly
// excluded; see docs/decisions.md entry 20 for why that was reversed.
const PROVIDERS = ["plex", "emby", "jellyfin"];
const PUSH_PROVIDERS = PROVIDERS;
const MAX_REQUEST_ITEMS = 100;

function text(value = "") {
  return String(value ?? "").trim();
}

function numeric(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coordinateFrom(item = {}) {
  const season = numeric(item.season ?? item.ParentIndexNumber ?? item.parentIndexNumber ?? item.parentIndex, NaN);
  const episode = numeric(item.episode ?? item.IndexNumber ?? item.indexNumber ?? item.index, NaN);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return null;
  return { season, episode };
}

function jellyfinEpisodePositionMs(item = {}) {
  const ticks = numeric(item.UserData?.PlaybackPositionTicks ?? item.PlaybackPositionTicks, 0);
  return ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function jellyfinItemPlayed(item = {}) {
  const value = item.UserData?.Played ?? item.Played ?? item.IsPlayed;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function requestedRailRefreshItem(item = {}) {
  const positionMs = numeric(item.position_ms ?? item.positionMs ?? item.offset_ms ?? item.offsetMs, 0);
  const progress = numeric(item.progress, 0);
  const mediaType = text(item.media_type || item.mediaType).toLowerCase();
  // Native calculated rails need a ready-to-watch episode, not a synthetic
  // resume position. Do not use queue_kind here: Plex and Emby call their
  // equivalent rail Resume/Continue Watching even when Plembfin describes the
  // same ready episode as Next Up, and an old browser snapshot may carry the
  // stale "resume" label from the former 6% seed implementation.
  return mediaType === "episode" && positionMs <= 0 && progress <= 0;
}

function providerRailLookupMedia(item = {}) {
  const media = upNextLookupMedia(item);
  const coordinate = coordinateFrom(item);
  const showTitle = text(item.show_title || item.showTitle);
  const title = showTitle && coordinate
    ? `${showTitle} - S${String(coordinate.season).padStart(2, "0")}E${String(coordinate.episode).padStart(2, "0")}`
    : media.title;
  return {
    ...media,
    title,
    show_title: showTitle || media.show_title,
    season: coordinate?.season ?? media.season,
    episode: coordinate?.episode ?? media.episode,
    type: "episode",
    media_type: "episode",
  };
}

function providerEpisodeId(provider, episode = {}) {
  return text(provider === "plex" ? episode.ratingKey : episode.Id || episode.id);
}

function providerEpisodePositionMs(provider, item = {}) {
  if (provider === "plex") return Math.max(0, Math.round(numeric(item.viewOffset, 0)));
  if (provider === "jellyfin") return jellyfinEpisodePositionMs(item);
  const ticks = numeric(item.UserData?.PlaybackPositionTicks ?? item.PlaybackPositionTicks, 0);
  return ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function providerItemPlayed(provider, item = {}) {
  if (provider === "plex") {
    return numeric(item.viewCount ?? item.ViewCount, 0) > 0 || item.isWatched === true;
  }
  if (provider === "jellyfin") return jellyfinItemPlayed(item);
  const value = item.UserData?.Played ?? item.Played ?? item.IsPlayed;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function providerEpisodeReleased(provider, item = {}, now = Date.now()) {
  const raw = provider === "plex"
    ? item.originallyAvailableAt || item.originallyAvailableAtUtc
    : item.PremiereDate || item.PremiereDateUtc || item.premiereDate || "";
  if (!raw) return true;
  const timestamp = Date.parse(String(raw));
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function providerPlayedDateIso(provider, item = {}) {
  const raw = provider === "plex"
    ? item.lastViewedAt ?? item.viewedAt
    : item.UserData?.LastPlayedDate ?? item.LastPlayedDate ?? item.UserData?.PlayedDate ?? item.PlayedDate;
  if (raw === null || raw === undefined || String(raw).trim() === "") return "";
  const numericValue = Number(raw);
  const timestamp = Number.isFinite(numericValue) && provider === "plex"
    ? numericValue * 1000
    : Number.isFinite(numericValue) ? numericValue : Date.parse(String(raw));
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function plexRailRefreshAllowed(config = {}) {
  const field = config?.tuning?.plexHistoricalWatchedSync;
  const configAllows = field === undefined || field === null
    ? true
    : typeof field === "object" ? field.value !== false : field !== false;
  return configAllows && plexHistoricalSyncAllowed() !== false;
}

async function markProviderPlayed(provider, config, media) {
  if (provider === "plex") return markPlexPlayed(config.plex, media);
  if (provider === "emby") return markEmbyPlayed(config.emby, media);
  return markJellyfinPlayed(config.jellyfin, media);
}

async function markProviderUnplayed(provider, config, media) {
  if (provider === "plex") return markPlexUnplayed(config.plex, media);
  if (provider === "emby") return markEmbyUnplayed(config.emby, media);
  return markJellyfinUnplayed(config.jellyfin, media);
}

function canonicalPredecessorUnwatched(media) {
  try {
    return getPlaystateForMediaSync(media)?.state === "unwatched";
  } catch {
    return false;
  }
}

function providerEpisodeSeriesIds(provider, episode = {}) {
  const ids = provider === "plex"
    ? (Array.isArray(episode.Guid) ? episode.Guid : [])
      .reduce((result, entry) => {
        const id = text(entry?.id || entry?.guid);
        const match = id.match(/^(imdb|tmdb|tvdb):\/\/(.+)$/i);
        if (match) result[match[1].toLowerCase()] = match[2];
        return result;
      }, {})
    : (episode.SeriesProviderIds || episode.ProviderIds || {});
  return {
    imdb: text(ids.Imdb || ids.imdb || ids.IMDB),
    tmdb: text(ids.Tmdb || ids.tmdb || ids.TMDB),
    tvdb: text(ids.Tvdb || ids.tvdb || ids.TVDB),
  };
}

function providerRailMedia(provider, item, episode, coordinate) {
  const showTitle = text(episode?.SeriesName || item?.show_title || item?.showTitle || "Untitled");
  const providerItemId = providerEpisodeId(provider, episode);
  const ids = providerEpisodeSeriesIds(provider, episode);
  return {
    title: `${showTitle} - S${String(coordinate.season).padStart(2, "0")}E${String(coordinate.episode).padStart(2, "0")}`,
    show_title: showTitle,
    showTitle,
    type: "episode",
    media_type: "episode",
    source: provider,
    provider: provider,
    provider_item_id: providerItemId,
    itemId: providerItemId,
    season: coordinate.season,
    episode: coordinate.episode,
    ids: {
      imdb: ids.imdb || text(item?.show_imdb_id || item?.showImdbId) || undefined,
      tmdb: ids.tmdb || text(item?.show_tmdb_id || item?.showTmdbId) || undefined,
      tvdb: ids.tvdb || text(item?.show_tvdb_id || item?.showTvdbId) || undefined,
    },
    provider_items: { [provider]: [providerItemId] },
    providerItems: { [provider]: [providerItemId] },
    isValid: Boolean(providerItemId),
  };
}

function providerSeriesEpisodes(provider, config, media) {
  if (provider === "plex") return fetchPlexSeriesEpisodes(config.plex, media);
  if (provider === "emby") return fetchEmbySeriesEpisodes(config.emby, media);
  return fetchJellyfinSeriesEpisodes(config.jellyfin, media);
}

function providerRailOrder(episodes = []) {
  return episodes
    .map((episode) => ({ episode, coordinate: coordinateFrom(episode) }))
    .filter(({ coordinate }) => coordinate && coordinate.season > 0)
    .sort((left, right) => left.coordinate.season - right.coordinate.season || left.coordinate.episode - right.coordinate.episode);
}
function providerIdValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => {
    if (entry && typeof entry === "object") {
      return text(entry.id || entry.Id || entry.ratingKey || entry.provider_item_id);
    }
    return text(entry);
  }).filter(Boolean);
}

function normalizedProviderItems(item = {}) {
  const result = {};
  const source = item.provider_items || item.providerItems || {};
  for (const provider of PROVIDERS) {
    const values = providerIdValues(source[provider]);
    if (values.length) result[provider] = [...new Set(values)];
  }

  const provider = text(item.source || item.provider).toLowerCase();
  const providerItemId = text(item.provider_item_id || item.providerItemId);
  if (PROVIDERS.includes(provider) && providerItemId) {
    result[provider] = [...new Set([...(result[provider] || []), providerItemId])];
  }
  return result;
}

function configuredProvider(config, provider) {
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && (section.apiKey || section.api_key || section.token) && section.userId);
}

function feedDefinitions(config = {}) {
  return [
    {
      provider: "plex",
      feedKind: "resume",
      configured: configuredProvider(config, "plex"),
      providerConfig: config.plex,
      fetch: () => fetchPlexContinueWatchingItems(config.plex, { limit: 0 }),
    },
    {
      provider: "emby",
      feedKind: "resume",
      configured: configuredProvider(config, "emby"),
      providerConfig: config.emby,
      fetch: () => fetchEmbyResumableItems(config.emby, { limit: 0 }),
    },
    {
      // Emby exposes this separately, but Plembfin's Emby equivalent is
      // Continue Watching/Resume. Keep the observation for diagnostics and
      // compatibility; it is deliberately ignored by queue reconciliation.
      provider: "emby",
      feedKind: "next_up",
      configured: configuredProvider(config, "emby"),
      providerConfig: config.emby,
      fetch: () => fetchEmbyNextUpItems(config.emby, { limit: 0 }),
    },
    {
      // Jellyfin Continue Watching is protected input for genuine
      // part-watches, not the native rail Plembfin reconciles.
      provider: "jellyfin",
      feedKind: "resume",
      configured: configuredProvider(config, "jellyfin"),
      providerConfig: config.jellyfin,
      fetch: () => fetchJellyfinResumableItems(config.jellyfin, { limit: 0 }),
    },
    {
      // Jellyfin's Next Up is a calculated GET feed with no per-item write.
      // The provider rail refresh below updates the watched predecessor so the
      // server recalculates the desired series entry naturally.
      provider: "jellyfin",
      feedKind: "next_up",
      configured: configuredProvider(config, "jellyfin"),
      providerConfig: config.jellyfin,
      fetch: () => fetchJellyfinNextUpItems(config.jellyfin, { limit: 0 }),
    },
  ];
}

function feedCandidates(provider, feedKind, items = []) {
  const seen = new Set();
  const candidates = [];
  for (const item of Array.isArray(items) ? items : []) {
    const candidate = normalizeUpNextCandidate({
      provider,
      feed_kind: feedKind,
      item,
    });
    const providerItemId = text(candidate.provider_item_id);
    if (!providerItemId || seen.has(providerItemId)) continue;
    seen.add(providerItemId);
    candidates.push(candidate);
  }
  return candidates;
}

function desiredProviderIds(items = []) {
  const ids = Object.fromEntries(PROVIDERS.map((provider) => [provider, new Set()]));
  for (const item of (Array.isArray(items) ? items : []).slice(0, MAX_REQUEST_ITEMS)) {
    const providerItems = normalizedProviderItems(item);
    for (const provider of PROVIDERS) {
      for (const providerItemId of providerIdValues(providerItems[provider])) {
        ids[provider].add(providerItemId);
      }
    }
  }
  return ids;
}

function normalizedDesiredCandidates(items = []) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_REQUEST_ITEMS)
    .filter((item) => item && typeof item === "object")
    .map((item) => normalizeUpNextCandidate(item));
}

function candidateAliases(candidate) {
  return new Set(upNextIdentityAliases(candidate));
}

function matchesDesiredCandidate(candidate, desiredAliases) {
  const aliases = candidateAliases(candidate);
  return desiredAliases.some((desired) => [...aliases].some((alias) => desired.has(alias)));
}

// Build a dry-run reconciliation plan without talking to a media server. Only
// a successful native feed is read; failed feeds must never be interpreted as
// an empty queue. A native rail item that is not in Plembfin's queue is
// retained, never hidden: absence from the queue is not evidence the user is
// done with it (docs/decisions.md entry 36). Removal is only ever the direct
// result of the user's own Clear progress or Remove action on that item.
export function planUpNextProviderSync({ desiredItems = [], feeds = [] } = {}) {
  const desiredIds = desiredProviderIds(desiredItems);
  const desiredAliases = normalizedDesiredCandidates(desiredItems).map(candidateAliases);
  const retained = [];

  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (feed?.status !== "succeeded") continue;
    const provider = text(feed.provider).toLowerCase();
    if (!PROVIDERS.includes(provider)) continue;
    const feedKind = text(feed.feed_kind || feed.feedKind).toLowerCase();
    // Continue Watching is not the desired Jellyfin rail, and native Emby
    // Next Up is not the desired Emby rail. Keep those feeds available for
    // observation/protection, but never reconcile or dismiss them here.
    if (!isPlektPrimaryUpNextFeed(provider, feedKind)) continue;
    const candidates = Array.isArray(feed.items) ? feed.items : [];
    const seen = new Set();
    for (const candidate of candidates) {
      const providerItemId = text(candidate?.provider_item_id || candidate?.providerItemId);
      if (!providerItemId || seen.has(providerItemId)) continue;
      seen.add(providerItemId);
      const isDesired = desiredIds[provider].has(providerItemId)
        || matchesDesiredCandidate({
          ...candidate,
          provider,
          feed_kind: feedKind,
        }, desiredAliases);
      if (isDesired) {
        desiredIds[provider].add(providerItemId);
        continue;
      }
      retained.push({
        provider,
        feed_kind: feedKind,
        provider_item_id: providerItemId,
        title: text(candidate?.title || candidate?.name) || "Untitled",
      });
    }
  }

  return {
    desiredProviderIds: Object.fromEntries(PROVIDERS.map((provider) => [provider, [...desiredIds[provider]]])),
    retained,
  };
}

function mediaFromRequestedItem(item = {}) {
  const type = text(item.media_type || item.mediaType).toLowerCase();
  const mediaType = type === "movie" ? "movie" : type === "episode" ? "episode" : "";
  const title = text(item.title || item.episode_title || item.show_title);
  const positionMs = Math.max(0, Math.round(Number(item.position_ms ?? item.positionMs ?? item.offset_ms ?? item.offsetMs ?? 0) || 0));
  const durationMs = Math.max(0, Math.round(Number(item.duration_ms ?? item.durationMs ?? 0) || 0));
  const progress = Math.max(0, Math.min(100, Number(item.progress || 0) || 0));
  const fallbackIds = {
    imdb: text(item.imdb_id || item.imdbId || item.imdb) || undefined,
    tmdb: text(item.tmdb_id || item.tmdbId || item.tmdb) || undefined,
    tvdb: text(item.tvdb_id || item.tvdbId || item.tvdb) || undefined,
  };
  const showIds = {
    imdb: text(item.show_imdb_id || item.showImdbId) || undefined,
    tmdb: text(item.show_tmdb_id || item.showTmdbId) || undefined,
    tvdb: text(item.show_tvdb_id || item.showTvdbId) || undefined,
  };
  const episodeIds = {
    imdb: text(item.episode_imdb_id || item.episodeImdbId) || undefined,
    tmdb: text(item.episode_tmdb_id || item.episodeTmdbId) || undefined,
    tvdb: text(item.episode_tvdb_id || item.episodeTvdbId) || undefined,
  };
  const providerItems = normalizedProviderItems(item);
  return {
    title,
    showTitle: text(item.show_title || item.showTitle) || undefined,
    type: mediaType,
    source: "manual",
    ids: mediaType === "episode"
      ? {
        imdb: showIds.imdb || fallbackIds.imdb,
        tmdb: showIds.tmdb || fallbackIds.tmdb,
        tvdb: showIds.tvdb || fallbackIds.tvdb,
      }
      : fallbackIds,
    show_imdb_id: showIds.imdb,
    show_tmdb_id: showIds.tmdb,
    show_tvdb_id: showIds.tvdb,
    episode_imdb_id: episodeIds.imdb || (mediaType === "episode" ? fallbackIds.imdb : undefined),
    episode_tmdb_id: episodeIds.tmdb || (mediaType === "episode" ? fallbackIds.tmdb : undefined),
    episode_tvdb_id: episodeIds.tvdb || (mediaType === "episode" ? fallbackIds.tvdb : undefined),
    season: item.season == null || item.season === "" ? undefined : Number(item.season),
    episode: item.episode == null || item.episode === "" ? undefined : Number(item.episode),
    media_key: text(item.media_key || item.mediaKey || item.id) || undefined,
    providerItems,
    providerItemId: text(item.provider_item_id || item.providerItemId) || undefined,
    positionMs,
    offsetMs: positionMs,
    durationMs,
    progress,
    isValid: Boolean(title && mediaType),
    syncTargets: PUSH_PROVIDERS,
  };
}

function actionableProgressItem(item = {}) {
  const media = mediaFromRequestedItem(item);
  const jellyfinSeeded = providerIdValues(media.providerItems?.jellyfin)
    .some((providerItemId) => isUpNextRailSeedPosition("jellyfin", providerItemId, media.positionMs));
  if (jellyfinSeeded) return null;
  return media.isValid && media.positionMs >= 1000 && media.progress < 95 ? media : null;
}

async function fetchAndRecordFeed(definition, { triggerOnRecovery = false } = {}) {
  const generation = startUpNextProviderFeed(definition.provider, definition.feedKind);
  try {
    const rawItems = await withUpNextFeedSeriesIdentity(
      definition.provider,
      await definition.fetch(),
      definition.providerConfig,
    );
    const items = feedCandidates(definition.provider, definition.feedKind, rawItems);
    // This feed read is part of an outbound reconciliation. The repository
    // normally schedules an automatic push when a feed changes, but allowing
    // this read to schedule another push would create a feedback loop.
    completeUpNextProviderFeed(definition.provider, definition.feedKind, generation, rawItems, { triggerAutoSync: false, triggerOnRecovery });
    return {
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: "succeeded",
      item_count: items.length,
      items,
    };
  } catch (error) {
    failUpNextProviderFeed(definition.provider, definition.feedKind, generation, error);
    return {
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: "failed",
      item_count: 0,
      items: [],
      error: text(error?.message || error) || "Provider feed refresh failed",
    };
  }
}

// Refresh provider observations without pushing to provider items.
// This is used by the dashboard's explicit refresh action to clear stale feed
// failures after a media server or network outage has recovered.
export async function refreshUpNextProviderFeeds({ config = {}, providers = null } = {}) {
  const definitions = feedDefinitions(config);
  const providerFilter = providers == null
    ? null
    : new Set((Array.isArray(providers) ? providers : [providers])
      .map((provider) => text(provider).toLowerCase())
      .filter(Boolean));
  const configuredDefinitions = definitions.filter((definition) => (
    definition.configured && (!providerFilter || providerFilter.has(definition.provider))
  ));
  // Not part of a push, so a provider found back after an outage queues the
  // push the outage skipped (the scheduler's failed-feed retry lands here).
  return Promise.all(configuredDefinitions.map((definition) => fetchAndRecordFeed(definition, { triggerOnRecovery: true })));
}

// A provider whose resume feed, read moments earlier in this push, already
// shows the position needs no write. Rewriting it anyway made Plex stamp a new
// lastViewedAt, which the next resume pass read as fresh playback and sent back
// to every server while queueing this push again: a 15-minute loop.
const RESUME_POSITION_MATCH_TOLERANCE_MS = 2_000;

function providersAlreadyAtPosition(item, media, feeds = []) {
  const aliases = candidateAliases(normalizeUpNextCandidate(item));
  const current = new Set();
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (feed?.status !== "succeeded" || feed.feed_kind !== "resume") continue;
    const holdsPosition = (feed.items || []).some((candidate) => (
      candidate.playback_position_known === true
      && Math.abs(Number(candidate.position_ms || 0) - media.positionMs) <= RESUME_POSITION_MATCH_TOLERANCE_MS
      && upNextIdentityAliases(candidate).some((alias) => aliases.has(alias))
    ));
    if (holdsPosition) current.add(feed.provider);
  }
  return current;
}

async function propagateKnownProgress(items, config, { isStale = null, feeds = [] } = {}) {
  const progressItems = (Array.isArray(items) ? items : [])
    .slice(0, MAX_REQUEST_ITEMS)
    .map((item) => {
      const media = actionableProgressItem(item);
      if (!media) return null;
      const current = providersAlreadyAtPosition(item, media, feeds);
      if (!current.size) return media;
      return {
        ...media,
        syncTargets: media.syncTargets.filter((provider) => configuredProvider(config, provider) && !current.has(provider)),
      };
    })
    .filter(Boolean);
  if (!progressItems.length) return [];
  // The automatic sync builds its projection seconds before this point. A
  // Clear progress in that window deleted the resume row, and writing the
  // projected position would put it straight back on every provider.
  if (isStale?.()) {
    return progressItems.map((media) => ({
      id: media.media_key || media.title,
      title: media.title,
      status: "skipped",
      targetStates: [],
      details: "Canonical state changed after the queue was built",
    }));
  }
  const loopStore = createLoopStore();
  return Promise.all(progressItems.map(async (media) => {
    if (!media.syncTargets.length) {
      return {
        id: media.media_key || media.title,
        title: media.title,
        status: "skipped",
        targetStates: [],
        details: "Every provider already holds this resume position",
      };
    }
    try {
      const summary = await syncMediaProgress(media, config, loopStore, { lane: "interactive" });
      return {
        id: media.media_key || media.title,
        title: media.title,
        status: summary.status || "skipped",
        targetStates: summary.targetStates || [],
        details: summary.details || "",
      };
    } catch (error) {
      return {
        id: media.media_key || media.title,
        title: media.title,
        status: "error",
        targetStates: [],
        details: text(error?.message || error) || "Resume propagation failed",
      };
    }
  }));
}

// Plex Continue Watching, Emby Continue Watching, and Jellyfin Next Up are
// calculated rails. They cannot accept an arbitrary queue write, but they can
// recalculate when the watched episode immediately before a ready episode is
// toggled. The predecessor is deliberately marked unplayed and then watched so
// the provider sees a real playstate transition. The original play date is
// carried back into providers that support it, and both synthetic callbacks are
// recorded in the outbound ledger so they never become Plembfin watch events.
// Plex has no historical-date setter; when its policy is enabled its server
// clock is therefore the only date it can retain. A genuine target resume
// position is always protected. The old ledger is consulted only to migrate
// positions written by pre-refresh builds; no new synthetic position is created
// here.
export async function refreshProviderRail({ provider, config, targets = [] } = {}) {
  const base = {
    provider,
    status: "skipped",
    refreshed_count: 0,
    // Kept as compatibility aliases for clients that consumed the original
    // Jellyfin-only summary before all providers used this path.
    promoted_count: 0,
    cleared_legacy_seed_count: 0,
    cleared_seed_count: 0,
    skipped_count: 0,
    failed_count: 0,
    results: [],
  };
  if (!configuredProvider(config, provider)) return { ...base, reason: `${provider} is not configured.` };
  if (provider === "plex" && !plexRailRefreshAllowed(config)) {
    return {
      ...base,
      reason: "Plex native rail refresh skipped because historical watched sync is disabled.",
    };
  }

  const seedById = new Map(listUpNextRailSeeds(provider).map((seed) => [seed.providerItemId, seed]));
  const outcomes = [];
  const candidates = [];
  const addSkipped = (title, reason) => outcomes.push({ title, status: "skipped", reason });

  for (const target of (Array.isArray(targets) ? targets : []).slice(0, MAX_REQUEST_ITEMS)) {
    const item = target?.item || {};
    const title = text(item.title || item.episode_title || item.show_title || "Untitled");
    const providerItemId = text(target?.providerItemId);
    if (!providerItemId) {
      addSkipped(title, `${provider} item was not resolved.`);
      continue;
    }
    // A native rail holds one episode per show, so beside a rewatch the newly
    // arrived episode stays a Plembfin-only card; the rail follows the rewatch
    // (user decision 30 September 2026, loose-ends step 20).
    if (item.up_next_lane === "new") {
      addSkipped(title, "This show's rewatch card drives the app's own rail; the new episode stays in Plekt's Up Next.");
      continue;
    }
    const legacySeed = seedById.get(providerItemId) || null;
    const requestedPositionMs = numeric(item.position_ms ?? item.positionMs ?? item.offset_ms ?? item.offsetMs, 0);
    const legacySeedPosition = legacySeed
      && requestedPositionMs > 0
      && isUpNextRailSeedPosition(provider, providerItemId, requestedPositionMs);
    if (!requestedRailRefreshItem(item) && !legacySeedPosition) {
      addSkipped(title, "The item has genuine resume progress or is not an episode ready for native rail refresh.");
      continue;
    }

    const coordinate = coordinateFrom(item);
    if (!coordinate) {
      addSkipped(title, "The item has no usable season and episode coordinates.");
      continue;
    }

    let episodes;
    try {
      episodes = await providerSeriesEpisodes(provider, config, providerRailLookupMedia(item));
    } catch (error) {
      addSkipped(title, `Could not verify ${provider}'s watched predecessor: ${text(error?.message || error) || "series lookup failed"}.`);
      continue;
    }

    const targetEpisode = (Array.isArray(episodes) ? episodes : [])
      .find((episode) => providerEpisodeId(provider, episode) === providerItemId);
    if (!targetEpisode) {
      addSkipped(title, `The resolved ${provider} episode was not returned by its series inventory.`);
      continue;
    }

    const targetPositionMs = providerEpisodePositionMs(provider, targetEpisode);
    const syntheticPosition = legacySeed
      && targetPositionMs > 0
      && isUpNextRailSeedPosition(provider, providerItemId, targetPositionMs);
    if (targetPositionMs > 0 && !syntheticPosition) {
      addSkipped(title, `${provider} reports a genuine resume position; it was left untouched.`);
      continue;
    }
    if (providerItemPlayed(provider, targetEpisode)) {
      addSkipped(title, `The target is already watched in ${provider}.`);
      continue;
    }
    if (!providerEpisodeReleased(provider, targetEpisode)) {
      addSkipped(title, "The target episode has not released yet.");
      continue;
    }

    const ordered = providerRailOrder(episodes);
    const targetIndex = ordered.findIndex(({ episode }) => providerEpisodeId(provider, episode) === providerItemId);
    if (targetIndex <= 0) {
      addSkipped(title, "The target has no watched episode immediately before it to order from.");
      continue;
    }

    const earlier = ordered.slice(0, targetIndex);
    const crossesSeasonBoundary = targetIndex > 0
      && coordinate.season > ordered[targetIndex - 1].coordinate.season
      && coordinate.episode === 1;
    if (!crossesSeasonBoundary && earlier.some(({ episode }) => !providerItemPlayed(provider, episode) && providerEpisodeReleased(provider, episode))) {
      addSkipped(title, `An earlier released episode is still unwatched, so ${provider} cannot calculate this as Up Next.`);
      continue;
    }
    const predecessor = earlier[earlier.length - 1];
    if (!predecessor || !providerItemPlayed(provider, predecessor.episode)) {
      addSkipped(title, `The immediately preceding episode is not watched in ${provider}.`);
      continue;
    }

    const resultIndex = outcomes.length;
    outcomes.push(null);
    candidates.push({
      item,
      title,
      providerItemId,
      targetEpisode,
      legacySeed: syntheticPosition ? legacySeed : null,
      predecessor: predecessor.episode,
      predecessorCoordinate: predecessor.coordinate,
      resultIndex,
    });
  }

  const loopStore = createLoopStore();
  // Native rails sort newest watched input first. Reverse the desired list so
  // the first Plembfin item receives the newest provider timestamp.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const predecessorMedia = providerRailMedia(provider, candidate.item, candidate.predecessor, candidate.predecessorCoordinate);
    const result = {
      title: candidate.title,
      status: "failed",
      provider_item_id: candidate.providerItemId,
      predecessor_item_id: providerEpisodeId(provider, candidate.predecessor),
    };
    let refreshed = false;
    let predecessorUnplayed = false;
    const originalPlayedAt = providerPlayedDateIso(provider, candidate.predecessor);
    const refreshMedia = {
      ...predecessorMedia,
      // A native rail refresh is a historical projection of an existing
      // watched state. This makes the Plex policy explicit while still letting
      // the setting-on path perform the requested toggle.
      syncIntent: "historical",
      watched_at: originalPlayedAt || undefined,
      // The preceding unplay makes the following Plex scrobble intentional;
      // do not let a briefly stale metadata read collapse it as idempotent.
      forcePlayedWrite: true,
    };
    // The candidate list comes from a queue built earlier and a provider
    // inventory read before any toggle. A Mark unwatched on the predecessor in
    // between must win: restamping it would re-mark it played on the provider
    // with its old date (defect O). Checked per predecessor, not by data
    // version, so unrelated playback ticks do not starve the refresh.
    if (canonicalPredecessorUnwatched(refreshMedia)) {
      outcomes[candidate.resultIndex] = {
        ...result,
        status: "skipped",
        reason: "Plekt has the preceding episode as unwatched; it was not re-marked watched.",
      };
      continue;
    }
    try {
      // The toggle's callbacks must never read as a user unwatch or a new
      // watch, whatever canonical row the webhook resolves (defect AG).
      await recordOutboundRailRefresh(refreshMedia, provider, loopStore);
      await recordOutboundUnplayedMarks(refreshMedia, [provider], loopStore);
      const unplayedOutcome = await markProviderUnplayed(provider, config, refreshMedia);
      if (unplayedOutcome?.status !== "fulfilled") throw new Error(`${provider} did not accept the unwatched predecessor mark.`);
      predecessorUnplayed = true;

      await recordOutboundPlayedMarks(refreshMedia, [provider], loopStore);
      const playedOutcome = await markProviderPlayed(provider, config, refreshMedia);
      if (playedOutcome?.status !== "fulfilled") throw new Error(`${provider} did not accept the watched predecessor mark.`);

      if (originalPlayedAt) result.original_played_at = originalPlayedAt;
      if (provider === "plex") {
        result.watch_date_restored = false;
        result.watch_date_note = originalPlayedAt
          ? "Plex has no supported historical-date setter; its server time was retained."
          : "Plex has no supported historical-date setter.";
      } else if (provider === "emby" && originalPlayedAt) {
        result.watch_date_restored = true;
      } else if (provider === "jellyfin" && originalPlayedAt) {
        const dateRestore = await updateJellyfinUserData(
          config.jellyfin,
          providerEpisodeId(provider, candidate.predecessor),
          { LastPlayedDate: originalPlayedAt },
          { lane: "interactive" },
        );
        if (dateRestore?.status !== "fulfilled") throw new Error("Jellyfin did not restore the watched predecessor date.");
        result.watch_date_restored = true;
      }
      if (provider === "emby") {
        const rail = await touchEmbyResumeRail(config.emby, candidate.providerItemId, { lane: "interactive" });
        if (rail?.status !== "fulfilled") throw new Error("Emby did not accept the native Continue Watching rail refresh.");
        result.resume_rail_touched = true;
      }
      refreshed = true;
      base.refreshed_count += 1;
      base.promoted_count += 1;
      result.status = "refreshed";
      result.reason = `${provider} native Up Next rail refreshed.`;
    } catch (error) {
      if (predecessorUnplayed) {
        try {
          await recordOutboundPlayedMarks(refreshMedia, [provider], loopStore);
          await markProviderPlayed(provider, config, refreshMedia);
          result.predecessor_restored_after_failure = true;
        } catch (restoreError) {
          result.predecessor_restore_error = text(restoreError?.message || restoreError) || "Could not restore the watched predecessor.";
        }
      }
      result.reason = text(error?.message || error) || `${provider} native Up Next refresh failed.`;
    }

    // An unwatch that landed while the pair was in flight may have been
    // overwritten by the played write; send the canonical unwatch again.
    if (refreshed && canonicalPredecessorUnwatched(refreshMedia)) {
      result.predecessor_unwatched_during_refresh = true;
      try {
        await recordOutboundUnplayedMarks(refreshMedia, [provider], loopStore);
        const restored = await markProviderUnplayed(provider, config, refreshMedia);
        if (restored?.status !== "fulfilled") throw new Error(`${provider} did not accept the unwatched predecessor restore.`);
        result.predecessor_unwatch_restored = true;
      } catch (error) {
        base.failed_count += 1;
        result.status = "partial";
        result.reason = text(error?.message || error) || "Could not restore the unwatched predecessor.";
      }
    }

    if (refreshed && candidate.legacySeed) {
      try {
        await recordOutboundProgressMarks(
          providerRailMedia(provider, candidate.item, candidate.targetEpisode, coordinateFrom(candidate.item)),
          [provider],
          loopStore,
        );
        const cleared = await clearLegacyUpNextRailSeed(config, candidate.legacySeed);
        if (cleared?.status !== "fulfilled") throw new Error(cleared?.detail || `${provider} legacy rail seed clear was not accepted.`);
        base.cleared_legacy_seed_count += 1;
        base.cleared_seed_count += 1;
        result.legacy_seed_cleared = true;
      } catch (error) {
        base.failed_count += 1;
        result.status = "partial";
        result.reason = text(error?.message || error) || `${provider} legacy rail seed cleanup failed.`;
      }
    }
    outcomes[candidate.resultIndex] = result;
  }

  base.skipped_count = outcomes.filter((entry) => entry?.status === "skipped").length;
  base.failed_count += outcomes.filter((entry) => entry?.status === "failed").length;
  base.status = base.failed_count ? (base.refreshed_count ? "partial" : "failed") : (base.refreshed_count ? "succeeded" : "skipped");
  base.results = outcomes.filter(Boolean);
  return base;
}

// Push Plembfin's authoritative Up Next snapshot to each connected media
// server: refresh the native rail and replay only known positive resume
// positions. The native target rail is Plex Continue Watching, Emby Continue
// Watching (Resume), and Jellyfin Next Up. Those feeds are calculated: their
// native APIs cannot add an arbitrary future episode, so a ready episode
// reaches the rail by restamping its watched predecessor. The push only adds;
// it never hides a native item because the queue lacks it (decisions entry 36).
export async function syncUpNextToProviders({ desiredItems = [], config = {}, isStale = null } = {}) {
  if (config?.upNextSync?.enabled === false) {
    return {
      ok: true,
      disabled: true,
      desired_count: 0,
      feeds: [],
      pushedProviders: [],
      railSeeds: [],
      legacyRailCleanup: [],
      providerRails: [],
      retained: [],
      progress: [],
      jellyfinRail: {
        provider: "jellyfin",
        status: "skipped",
        refreshed_count: 0,
        promoted_count: 0,
        cleared_legacy_seed_count: 0,
        cleared_seed_count: 0,
        skipped_count: 0,
        failed_count: 0,
        results: [],
        reason: "Up Next sync is disabled.",
      },
    };
  }
  const definitions = feedDefinitions(config);
  const configuredDefinitions = definitions.filter((definition) => definition.configured);
  const skippedFeeds = definitions
    .filter((definition) => !definition.configured)
    .map((definition) => ({
      provider: definition.provider,
      feed_kind: definition.feedKind,
      status: config?.[definition.provider]?.disabled ? "disabled" : "not_configured",
      item_count: 0,
      items: [],
    }));
  const feeds = await Promise.all(configuredDefinitions.map(fetchAndRecordFeed));
  const plan = planUpNextProviderSync({ desiredItems, feeds });
  const progress = await propagateKnownProgress(desiredItems, config, { isStale, feeds });
  const pushProviders = PUSH_PROVIDERS.filter((provider) => (
    configuredDefinitions.some((definition) => definition.provider === provider)
  ));
  // A provider whose every feed read just failed cannot be reached. Pushing to
  // it anyway resolved each queue item twice and walked the rail, which during
  // a Jellyfin outage was hundreds of failed requests per automatic run. Skip
  // it; the next run after it recovers pushes the whole queue again.
  const unreachableProviders = new Set(pushProviders.filter((provider) => {
    const providerFeeds = feeds.filter((feed) => feed.provider === provider);
    return providerFeeds.length > 0 && providerFeeds.every((feed) => feed.status === "failed");
  }));
  const reachableProviders = pushProviders.filter((provider) => !unreachableProviders.has(provider));
  // Resolve every desired item to its native id once per provider, so the
  // rail refresh and any later step work from the same answer.
  const targetsByProvider = Object.fromEntries(await Promise.all(reachableProviders.map(async (provider) => [
    provider,
    await resolveUpNextProviderTargets({
      provider,
      config: config[provider],
      items: desiredItems,
      limit: MAX_REQUEST_ITEMS,
    }).catch(() => ({ provider, resolved: [], unresolved: [] })),
  ])));

  const desiredIdsByProvider = Object.fromEntries(pushProviders.map((provider) => [
    provider,
    new Set((targetsByProvider[provider]?.resolved || []).map((target) => text(target.providerItemId)).filter(Boolean)),
  ]));
  // Older alpha builds may have left 6% positions tracked in the ledger. They
  // are cleared when stale; no new synthetic position is created here.
  const legacyRailCleanup = await clearLegacyUpNextRailSeeds({
    config,
    providers: reachableProviders,
    desiredIdsByProvider,
  });
  const providerRails = await Promise.all(pushProviders.map((provider) => (unreachableProviders.has(provider)
    ? {
      provider,
      status: "failed",
      refreshed_count: 0,
      promoted_count: 0,
      cleared_legacy_seed_count: 0,
      cleared_seed_count: 0,
      skipped_count: 0,
      failed_count: 0,
      results: [],
      reason: `${provider} could not be reached (every Up Next feed read failed), so its rail was not refreshed.`,
    }
    : refreshProviderRail({
      provider,
      config,
      targets: targetsByProvider[provider]?.resolved || [],
    }))));
  const jellyfinRail = providerRails.find((rail) => rail.provider === "jellyfin") || {
    provider: "jellyfin",
    status: "skipped",
    refreshed_count: 0,
    promoted_count: 0,
    cleared_legacy_seed_count: 0,
    cleared_seed_count: 0,
    skipped_count: 0,
    failed_count: 0,
    results: [],
  };
  // A provider counts as pushed when it was configured, contacted, and nothing
  // Plembfin attempted against it failed. There is no managed provider list to
  // measure completeness against any more; the native rail refresh is the
  // whole push.
  const pushedProviders = pushProviders.filter((provider) => (
    providerRails.find((entry) => entry.provider === provider)?.status !== "failed"
  ));

  return {
    ok: true,
    desired_count: Math.min(Array.isArray(desiredItems) ? desiredItems.length : 0, MAX_REQUEST_ITEMS),
    feeds: [...feeds, ...skippedFeeds].map((feed) => ({
      provider: feed.provider,
      feed_kind: feed.feed_kind,
      status: feed.status,
      item_count: feed.item_count,
      error: feed.error || null,
    })),
    pushedProviders,
    railSeeds: [],
    legacyRailCleanup,
    providerRails,
    retained: plan.retained.map((item) => ({
      provider: item.provider,
      feed_kind: item.feed_kind,
      title: item.title,
    })),
    progress,
    jellyfinRail,
  };
}
