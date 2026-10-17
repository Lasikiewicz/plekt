// Fallback unwatched-status polls for Plex, Emby and Jellyfin, and Jellyfin unwatch confirmation (split from scheduled.js).
import { lastOutboundPlayedMarkAt } from "./syncOrchestrator.js";
import { applyUnwatchedTransition } from "./watchStateTransitions.js";
import { findPlexItem } from "./plexClient.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { isEmbyLikePlayed } from "./watchDates.js";
import { invalidateHistoryDerivedCaches, listRecentTrackedWatchRows, listRecentlyUpdatedTrackedWatchRows, mediaKeyFor } from "./dataRepo.js";
import { recordSyncHistory } from "./syncHistoryTelemetry.js";

// Fallback cadence for the legacy Plex unwatch poll. Primary detection is the realtime
// notification listener; this poll only backstops events missed while the socket was down.
// Seeded to "now" rather than 0 so a process restart doesn't make the very next tick
// treat the interval as already elapsed and fire immediately.
export const PLEX_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.PLEX_UNWATCHED_POLL_INTERVAL_MS || 60 * 1000);
export let lastPlexUnwatchedPollAt = Date.now();

// Emby/Jellyfin webhooks natively report unwatch (unlike Plex), so this is a
// backstop for a missed/misconfigured webhook or a server that was offline
// when the change happened, not the primary detection path. Unlike Plex's
// single-lookup findPlexItem, Emby/Jellyfin's per-episode lookup (findEpisode:
// up to 3 provider-ID searches, a title-fallback search, and a full
// series-episode fetch) is expensive enough that an earlier, larger batch size
// (30 records, both platforms) piled up 100+ outbound requests in one tick.
// The batch is now capped at EMBY_LIKE_UNWATCHED_BATCH_SIZE and records are
// processed sequentially (not concurrently), and the "last checked" timestamp
// now seeds to Date.now() instead of 0 so a restart can't make the next tick
// fire immediately. Emby's fallback is controlled by EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED;
// Jellyfin's fallback is separately opt-in via JELLYFIN_UNWATCHED_POLL_ENABLED.
// Jellyfin's native webhook is the authoritative unwatch signal. Its generic
// Played=false library snapshot is ambiguous after outbound marks and library
// rescans, so the Jellyfin fallback stays opt-in until explicitly enabled.
export const EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED = String(process.env.EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED ?? "true").toLowerCase() !== "false";
export const EMBY_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.EMBY_UNWATCHED_POLL_INTERVAL_MS || 5 * 60 * 1000);
export let lastEmbyUnwatchedPollAt = Date.now();
export const JELLYFIN_UNWATCHED_POLL_INTERVAL_MS = Number(process.env.JELLYFIN_UNWATCHED_POLL_INTERVAL_MS || 5 * 60 * 1000);
export const JELLYFIN_UNWATCHED_POLL_ENABLED = String(process.env.JELLYFIN_UNWATCHED_POLL_ENABLED ?? "false").toLowerCase() !== "false";
const JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS = Number(process.env.JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS || 20 * 60 * 1000);
export let lastJellyfinUnwatchedPollAt = Date.now();
const EMBY_LIKE_UNWATCHED_BATCH_SIZE = 5;

export function jellyfinUnwatchedConfirmationKey(media = {}) {
  return `jellyfin-unwatched-candidate:${mediaKeyFor(media)}`;
}

export function jellyfinMatchesContainWatched(items = []) {
  return (Array.isArray(items) ? items : []).some((item) => isEmbyLikePlayed(item));
}

// A single false Played flag is not enough to infer that a user deliberately
// marked an item unwatched. Require the same false observation again within a
// bounded window. Webhook-based unwatches do not use this helper and remain
// immediate.
export async function confirmJellyfinUnwatchedObservation(media, loopStore, { now = Date.now(), windowMs = JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS } = {}) {
  if (!loopStore?.get || !loopStore?.put) return false;
  const key = jellyfinUnwatchedConfirmationKey(media);
  const previous = Number(await Promise.resolve(loopStore.get(key)).catch(() => 0));
  if (previous > 0 && now >= previous && now - previous <= windowMs) return true;
  await Promise.resolve(loopStore.put(key, now, { expirationTtl: Math.max(1, Math.ceil(windowMs / 1000)) })).catch(() => null);
  return false;
}

async function clearJellyfinUnwatchedObservation(media, loopStore) {
  if (!loopStore?.put) return;
  await Promise.resolve(loopStore.put(jellyfinUnwatchedConfirmationKey(media), 0, { expirationTtl: 1 })).catch(() => null);
}

export async function checkPlexUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.plex?.baseUrl || !config.plex?.token) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const plexWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("plex")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target plex status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentlyUpdatedTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && plexWasConfirmedWatched(record),
  ).slice(0, 30);

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "plex",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const plexItem = await findPlexItem(config.plex, media);
      if (plexItem) {
        const isWatched = Boolean(plexItem.viewCount && Number(plexItem.viewCount) > 0);
        if (!isWatched) {
          const plexMedia = { ...media, itemId: plexItem.ratingKey || plexItem.key || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(plexMedia, "plex", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Plex unplayed state after Plekt's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Plex item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(plexMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(plexMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches("checkPlexUnwatchedStatus").catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Plex unwatched status for '${record.title}':`, error);
    }
  }
}

// Emby/Jellyfin equivalent of checkPlexUnwatchedStatus above. Their webhooks
// natively report unwatch (Plex's cannot), so this only backstops a missed or
// misconfigured webhook, or a change made while the server was unreachable -
// not the primary detection path.
export async function checkEmbyUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const embyWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("emby")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target emby status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && embyWasConfirmedWatched(record),
  ).slice(0, EMBY_LIKE_UNWATCHED_BATCH_SIZE);
  if (!records.length) return;

  const { findEmbyItems } = await import("./embyClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "emby",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findEmbyItems(config.emby, media);
      const item = items?.[0];
      if (item) {
        const isWatched = isEmbyLikePlayed(item);
        if (!isWatched) {
          const embyMedia = { ...media, itemId: item.Id || undefined };
          const ownPlayedMarkAt = await lastOutboundPlayedMarkAt(embyMedia, "emby", loopStore).catch(() => 0);
          if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
            console.log("Cron ignored Emby unplayed state after Plekt's own played mark", { title: record.title });
            continue;
          }

          console.log("Cron detected Emby item marked unwatched; storing and propagating", { title: record.title });
          const result = await applyUnwatchedTransition(embyMedia, config, loopStore, { recordId: record.id });
          if (!result.alreadyUnwatched) await recordSyncHistory(embyMedia, result.summary, "unwatched");
          await invalidateHistoryDerivedCaches("checkEmbyUnwatchedStatus").catch(() => null);
        }
      }
    } catch (error) {
      console.error(`Error checking Emby unwatched status for '${record.title}':`, error);
    }
  }
}

export async function checkJellyfinUnwatchedStatus(config, loopStore) {
  if (!watchedPlayedSyncEnabled()) return;
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return;

  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const jellyfinWasConfirmedWatched = (record) => {
    if (String(record.source || "").toLowerCase().startsWith("jellyfin")) return true;
    const telemetry = String(record.sync_dispatch_telemetry || "").toLowerCase();
    return /target jellyfin status:\s*(fulfilled|success)/.test(telemetry);
  };
  const records = (await listRecentTrackedWatchRows({ limit: 100, includeScheduled: true })).filter(
    (record) => record.watched_at < threeMinutesAgo && jellyfinWasConfirmedWatched(record),
  ).slice(0, EMBY_LIKE_UNWATCHED_BATCH_SIZE);
  if (!records.length) return;

  const { findJellyfinItems } = await import("./jellyfinClient.js");

  for (const record of records) {
    try {
      const media = {
        title: record.title,
        type: record.media_type,
        source: "jellyfin",
        isValid: true,
        ids: {
          imdb: record.imdb_id || undefined,
          tmdb: record.tmdb_id || undefined,
          tvdb: record.tvdb_id || undefined,
        },
        season: record.season,
        episode: record.episode,
        watchProvenance: record.watch_provenance || null,
      };

      const items = await findJellyfinItems(config.jellyfin, media);
      if (!items?.length) continue;

      // Provider/title matching can return duplicate library items. One
      // watched match is positive evidence; looking only at items[0] made a
      // stale duplicate capable of turning a real watched item unwatched.
      const watchedItems = items.filter((item) => isEmbyLikePlayed(item));
      if (jellyfinMatchesContainWatched(items)) {
        if (watchedItems.length !== items.length) {
          console.warn("Cron ignored mixed Jellyfin match state; at least one matching item is watched", {
            title: record.title,
            itemIds: items.map((item) => item.Id),
            watchedItemIds: watchedItems.map((item) => item.Id),
          });
        }
        await clearJellyfinUnwatchedObservation(media, loopStore);
        continue;
      }

      const ownPlayedMarkAt = Math.max(0, ...(await Promise.all(items.map((item) => (
        lastOutboundPlayedMarkAt({ ...media, itemId: item.Id || undefined }, "jellyfin", loopStore).catch(() => 0)
      )))));
      if (ownPlayedMarkAt > 0 && Date.now() - ownPlayedMarkAt <= 10 * 60 * 1000) {
        await clearJellyfinUnwatchedObservation(media, loopStore);
        console.log("Cron ignored Jellyfin unplayed state after Plekt's own played mark", { title: record.title });
        continue;
      }

      const confirmed = await confirmJellyfinUnwatchedObservation(media, loopStore);
      if (!confirmed) {
        console.log("Cron held Jellyfin unplayed state for a second confirmation", { title: record.title });
        continue;
      }

      const jellyfinMedia = { ...media, itemId: items[0].Id || undefined };
      console.log("Cron detected Jellyfin item marked unwatched after repeated confirmation; storing and propagating", { title: record.title });
      const result = await applyUnwatchedTransition(jellyfinMedia, config, loopStore, { recordId: record.id });
      if (!result.alreadyUnwatched) await recordSyncHistory(jellyfinMedia, result.summary, "unwatched");
      await clearJellyfinUnwatchedObservation(media, loopStore);
      await invalidateHistoryDerivedCaches("checkJellyfinUnwatchedStatus").catch(() => null);
    } catch (error) {
      console.error(`Error checking Jellyfin unwatched status for '${record.title}':`, error);
    }
  }
}

// Fallback polls for Plex, Emby and Jellyfin unwatched status. Each runs at most once per its
// interval. Plex is primarily event-driven via the notification WebSocket (see
// startPlexNotificationListener in index.js); the polls are safety nets for missed events, checked
// with confirmed-watched gating so they never drive detection or re-scan every tick. Emby/Jellyfin
// webhooks report unwatch natively, so these are a backstop for a missed webhook.
export async function runDueUnwatchedPolls({ config, loopStore, plexActive, embyActive, jellyfinActive, logger, trace }) {
  if (plexActive && Date.now() - lastPlexUnwatchedPollAt >= PLEX_UNWATCHED_POLL_INTERVAL_MS) {
    lastPlexUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Plex unwatched status (fallback poll)...");
    await checkPlexUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkPlexUnwatchedStatus failed: ${error.message}`);
    });
  }

  if (EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED && embyActive && Date.now() - lastEmbyUnwatchedPollAt >= EMBY_UNWATCHED_POLL_INTERVAL_MS) {
    lastEmbyUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Emby unwatched status (fallback poll)...");
    await checkEmbyUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkEmbyUnwatchedStatus failed: ${error.message}`);
    });
  }

  if (EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED && JELLYFIN_UNWATCHED_POLL_ENABLED && jellyfinActive && Date.now() - lastJellyfinUnwatchedPollAt >= JELLYFIN_UNWATCHED_POLL_INTERVAL_MS) {
    lastJellyfinUnwatchedPollAt = Date.now();
    trace("Scheduled Sync: checking Jellyfin unwatched status (fallback poll)...");
    await checkJellyfinUnwatchedStatus(config, loopStore).catch((error) => {
      logger(`Scheduled Sync ERROR: checkJellyfinUnwatchedStatus failed: ${error.message}`);
    });
  }
}
