// Recently watched catch-up import from Plex, Emby and Jellyfin, with Plex user matching (split from scheduled.js).
import { watchImportMode } from "./tuning.js";
import { isRecentOutboundJellyfinNextUpNudge, syncMediaPlaystate } from "./syncOrchestrator.js";
import { parsePlexMediaIds } from "./parsers.js";
import { resolvePlexAccountId } from "./plexClient.js";
import { fetchPlexWithRefresh } from "./plexFetch.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { watchedPlayedSyncEnabled } from "./syncFlags.js";
import { loadWatchBackupRuntime } from "./watchHistoryBackups.js";
import { releaseDateForSourceItem, resolvePlexWatchDate, resolveWatchImportDate, runtimeMinutesForSourceItem, watchedAtForEmbyLikeItem } from "./watchDates.js";
import { remoteEpisodeImportError } from "./episodeImportGuard.js";
import { buildWatchProvenance } from "./watchProvenance.js";
import { earliestTrackerWatchedAt } from "./mediaForceSync.js";
import { findWatchedByAnyMediaKey, getCachedHistory, getPlaystateForMedia, insertWatchRecord, invalidateHistoryDerivedCaches, mediaToWatchRecord, updateWatchTelemetry, upsertPlaystateForMedia } from "./dataRepo.js";
import { librarySeriesItemId, withSeriesIdentity } from "./seriesIdentity.js";
import { enqueueManualWatchReview } from "./manualWatchReview.js";
import { addTimingHistoryRow, recordSyncHistory } from "./syncHistoryTelemetry.js";
import { checkIncomingEpisodeSourceMismatch } from "./sourceMismatch.js";

// A library-history endpoint exposes the server's current played snapshot; it
// does not prove another viewing occurred. A canonical Plembfin playstate can
// outlive the provider history row the user deliberately removed. Keep an
// explicit canonical unwatch sticky here: provider history is polled data and
// can repeat the old played flag after Plembfin has cleared it.
export function shouldSkipLibraryHistoryImport(existing, playstate) {
  return playstate?.state === "unwatched"
    || (!existing && playstate?.state === "watched");
}

// What a Plex/Emby/Jellyfin library-history row does, given Plembfin's own
// state. A review is never queued for an item Plembfin already has watched:
// its manual watch pushed to the server comes back as a played flag, and
// reviewing it again is noise (Marshals S01E02 on Emby, 23 September 2026).
// A locally unwatched item still goes to review (decision 32).
export function libraryHistoryDecision({ requiresReview = false, existing = null, playstate = null, now = Date.now() } = {}) {
  if (requiresReview) {
    const alreadyWatched = playstate?.state === "watched" || (Boolean(existing) && playstate?.state !== "unwatched");
    return alreadyWatched ? "skip_already_watched" : "review";
  }
  if (recentUnwatchBlocksLibraryImport(playstate, now)) return "skip_recent_unwatch";
  if (shouldSkipLibraryHistoryImport(existing, playstate)) return "skip_already_watched";
  return "import";
}
const SCHEDULED_RECENT_WATCH_LIMIT = 50;
const RECENT_UNWATCH_IMPORT_GUARD_MS = 5 * 60 * 1000;

export function recentUnwatchBlocksLibraryImport(playstate = null, now = Date.now()) {
  return playstate?.state === "unwatched"
    && Number(playstate.updated_at || 0) > 0
    && now - Number(playstate.updated_at) <= RECENT_UNWATCH_IMPORT_GUARD_MS;
}

function scheduledMediaInScope(config, media) {
  const scope = config?.syncScope || {};
  if (Array.isArray(scope.servers) && scope.servers.length && !scope.servers.includes(String(media.source || "").replace(/_initial_sync$/, ""))) return false;
  if (Array.isArray(scope.mediaTypes) && scope.mediaTypes.length && !scope.mediaTypes.includes(media.type)) return false;
  const watchedAt = new Date(media.watched_at || media.timestamp || 0).getTime();
  if (scope.watchedAfter && (!watchedAt || watchedAt < new Date(scope.watchedAfter).getTime())) return false;
  if (scope.watchedBefore && (!watchedAt || watchedAt > new Date(scope.watchedBefore).getTime())) return false;
  return true;
}

function currentWatchImportMode() {
  return watchImportMode();
}

export function providerWatchFingerprint(item = {}, source = "", kind = "") {
  const userData = item.UserData || {};
  return [
    String(source || "").toLowerCase(),
    kind,
    item.ratingKey || item.key || item.Id || "",
    item.lastViewedAt ?? item.viewedAt ?? "",
    userData.LastPlayedDate ?? userData.PlayedDate ?? item.LastPlayedDate ?? item.PlayedDate ?? "",
    userData.PlayCount ?? item.PlayCount ?? "",
    userData.Played ?? userData.IsPlayed ?? item.Played ?? item.IsPlayed ?? "",
    item.viewCount ?? "",
  ].join("|");
}

function normalizePlexIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function configuredPlexUsername(config = {}) {
  return normalizePlexIdentity(config.plex?.username);
}

function plexAccountIdFromItem(item = {}) {
  const value = item.accountID ?? item.accountId ?? item.account_id ?? item.userID ?? item.userId;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function plexUsernamesFromItem(item = {}) {
  const user = item.User || item.user || {};
  const account = item.Account || item.account || {};
  return [
    item.username,
    item.user,
    item.userName,
    item.account,
    item.accountName,
    item.accountTitle,
    user.title,
    user.name,
    account.title,
    account.name,
  ]
    .map(normalizePlexIdentity)
    .filter(Boolean);
}

// Condenses a repeated-skip list into one readable clause, so a run reports
// "skipped 14 item(s) (A, B, C and 11 more)" instead of 14 separate lines.
function summariseTitles(titles, max = 3) {
  const unique = [...new Set(titles.filter(Boolean))];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

function skipMalformedLibraryHistoryItem(media, source, logger, skipped = []) {
  const rejection = remoteEpisodeImportError(media, { context: "library_history" });
  if (!rejection) return false;
  const label = `${media.title || "unknown"} (${rejection.code})`;
  skipped.push(label);
  logger(`${source}: skipped malformed watched item ${media.title || "unknown"}: ${rejection.message}.`);
  return true;
}

// Delegates to the memoized resolver in plexClient.js so the per-minute
// scheduled sync and playstate operations share one cached /accounts lookup.
async function resolvePlexTargetAccountId(plexConfig, username, logger = console.log) {
  try {
    return await resolvePlexAccountId({ ...plexConfig, username });
  } catch (error) {
    logger(`Plex account mapping failed: ${error.message}`);
    return null;
  }
}

export function plexHistoryItemMatchesConfiguredUser(item = {}, { username = "", accountId = null, accountScoped = false } = {}) {
  if (!username) return true;

  const itemAccountId = plexAccountIdFromItem(item);
  if (itemAccountId != null && accountId != null) {
    return itemAccountId === accountId;
  }

  const itemUsernames = plexUsernamesFromItem(item);
  if (itemUsernames.length) {
    return itemUsernames.includes(username);
  }

  // Plex omits User/Account from library-section results, even when the
  // request is explicitly scoped with accountID. Preserve that request
  // provenance so a valid, server-filtered result is not discarded.
  return accountScoped && accountId != null;
}

export async function syncRecentlyWatchedFromPlex(config, loopStore, logger = console.log, trackerWatchedDateIndex = null) {
  const sourceMismatchRunKey = `plex:${Date.now()}`;
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Plex watched library sync is disabled.");
    return 0;
  }
  if (!config.plex?.baseUrl || !config.plex?.token) return 0;

  const baseUrl = config.plex.baseUrl.replace(/\/+$/, "");
  const username = configuredPlexUsername(config);
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  let syncedCount = 0;
  const skippedMalformed = [];

  const targetAccountId = await resolvePlexTargetAccountId(config.plex, username, logger);
  if (username && targetAccountId == null) {
    logger(`Plex: configured user "${config.plex.username}" was not resolved to an account id; rows without a matching username will be skipped.`);
  }

  try {
    const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
    historyUrl.searchParams.set("X-Plex-Container-Start", "0");
    historyUrl.searchParams.set("X-Plex-Container-Size", "20");
    if (targetAccountId != null) {
      historyUrl.searchParams.set("accountID", String(targetAccountId));
    }

    const historyRes = await fetchPlexWithRefresh(config.plex, historyUrl);
    let items = [];
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      items = historyData?.MediaContainer?.Metadata || [];
    } else {
      logger(`Plex history fetch failed: HTTP ${historyRes.status}`);
    }

    let recentlyViewedItems = [];
    try {
      const sectionsUrl = new URL(`${baseUrl}/library/sections`);
      const sectionsRes = await fetchPlexWithRefresh(config.plex, sectionsUrl);
      if (sectionsRes.ok) {
        const sectionsData = await sectionsRes.json();
        const directories = sectionsData?.MediaContainer?.Directory || [];
        // Bound the per-tick sweep: this runs every minute inside a 50s budget,
        // and each section costs a serial round trip to Plex. Very large installs
        // still converge â€” the history endpoint above covers recent activity.
        const MAX_SECTIONS_PER_TICK = 6;
        let sectionsChecked = 0;
        for (const dir of directories) {
          const sectionId = dir.key;
          const type = dir.type;
          if (type !== "movie" && type !== "show") continue;
          if (sectionsChecked >= MAX_SECTIONS_PER_TICK) {
            logger(`Plex sections check capped at ${MAX_SECTIONS_PER_TICK} sections this tick.`);
            break;
          }
          sectionsChecked += 1;

          const sectionAllUrl = new URL(`${baseUrl}/library/sections/${sectionId}/all`);
          sectionAllUrl.searchParams.set("unwatched", "0");
          sectionAllUrl.searchParams.set("sort", "lastViewedAt:desc");
          sectionAllUrl.searchParams.set("X-Plex-Container-Start", "0");
          sectionAllUrl.searchParams.set("X-Plex-Container-Size", "50");
          // Without it Plex lists no <Guid> children, and the import (or a
          // manual watch review it queues) carries no ids at all.
          sectionAllUrl.searchParams.set("includeGuids", "1");
          if (targetAccountId != null) {
            sectionAllUrl.searchParams.set("accountID", String(targetAccountId));
          }
          if (type === "movie") {
            sectionAllUrl.searchParams.set("type", "1");
          } else {
            sectionAllUrl.searchParams.set("type", "4"); // Episode
          }

          const sectionRes = await fetchPlexWithRefresh(config.plex, sectionAllUrl);
          if (sectionRes.ok) {
            const sectionData = await sectionRes.json();
            const metadata = sectionData?.MediaContainer?.Metadata || [];
            recentlyViewedItems.push(...metadata.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "section" })));
          }
        }
      } else {
        logger(`Plex sections fetch failed: HTTP ${sectionsRes.status}`);
      }
    } catch (err) {
      logger(`Plex sections check failed: ${err.message}`);
    }

    // Combine and deduplicate
    const allItems = [
      ...items.map((item) => ({ item, accountScoped: targetAccountId != null, kind: "history" })),
      ...recentlyViewedItems,
    ];
    const seenKeys = new Set();
    const uniqueItems = [];

    for (const candidate of allItems) {
      const { item, accountScoped, kind } = candidate;
      if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId, accountScoped })) continue;
      if (item.type !== "movie" && item.type !== "episode") continue;
      if (kind === "section" && Number(item.viewCount || 0) <= 0) continue;

      // The history endpoint represents an actual Plex viewing-history entry.
      // Section listings only expose the watched flag/lastViewedAt, which can
      // also be produced by a manual "Mark watched" click. Treat the latter
      // as a manual flag unless the realtime notification path has already
      // established playback evidence.
      const watchDate = resolvePlexWatchDate(item, { hasPlaybackEvidence: kind === "history" });
      const watchedAt = watchDate.watchedAt;

      const dedupeKey = `${item.ratingKey || item.key}-${watchedAt}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      uniqueItems.push({ item, watchedAt, watchDate });
    }

    const orderedItems = importMode === "episode_timing"
      ? uniqueItems.slice().sort((left, right) => {
        const leftIsEpisode = left.item.type === "episode";
        const rightIsEpisode = right.item.type === "episode";
        if (leftIsEpisode !== rightIsEpisode) return leftIsEpisode ? -1 : 1;
        if (!leftIsEpisode) return 0;
        const leftShow = String(left.item.grandparentTitle || left.item.parentTitle || "").toLowerCase();
        const rightShow = String(right.item.grandparentTitle || right.item.parentTitle || "").toLowerCase();
        return leftShow.localeCompare(rightShow)
          || Number(left.item.parentIndex || 0) - Number(right.item.parentIndex || 0)
          || Number(left.item.index || 0) - Number(right.item.index || 0);
      })
      : uniqueItems;

    for (const { item, watchedAt, watchDate } of orderedItems) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      let media = {
        title: item.title,
        type: item.type,
        source: "plex",
        isValid: true,
        // Episodes carry their own tmdb/tvdb guid, distinct from the show's -
        // prefer the grandparent (series) guid so a library-history import
        // keys on the same show identity every other ingestion path resolves.
        ids: parsePlexMediaIds(item, item.type),
      };

      if (item.type === "episode") {
        media.showTitle = item.grandparentTitle || item.parentTitle || "";
        media.season = Number(item.parentIndex);
        media.episode = Number(item.index);
        media.title = `${media.showTitle || "Unknown Show"} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
        media.episodeTitle = item.title;
        // The modern Plex agent's grandparentGuid is plex://, so the parse
        // above can fall through to the episode's own ids.
        media.seriesItemId = librarySeriesItemId(item, "plex");
        media = await withSeriesIdentity(media, config);
        await checkIncomingEpisodeSourceMismatch(media, { runKey: sourceMismatchRunKey }).catch(() => null);
      }

      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "plex");
      const releaseDate = releaseDateForSourceItem(item, "plex");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark: watchDate.manualMark,
        sourceTimestamp: watchDate.sourceTimestamp,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;
      media.watchProvenance = buildWatchProvenance(
        { source: "plex", event: "library_history", phase: "completed", itemId: item.ratingKey, user: username },
        { ingestPath: "plex_scheduled_library_history", sourceTimestamp: watchDate.sourceTimestamp, note: [watchDate.note, `Import policy: ${dateChoice.reason}.`].filter(Boolean).join(" ") },
      );
      if (skipMalformedLibraryHistoryItem(media, "Plex", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      // A library-history poll is a snapshot of the server's current played
      // flag, not evidence of another viewing. Plembfin may deliberately keep
      // an older local watch date after the user removes newer duplicates;
      // Plex cannot roll its lastViewedAt timestamp back when we reassert the
      // watched flag. In that case an identity-rematched Plex row can evade
      // the history lookup above, but the broader playstate lookup still says
      // the episode is canonically watched. Never let that stale snapshot
      // recreate the watch date the user just removed.
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Plex: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }
      if (libraryDecision === "skip_already_watched") {
        logger(`Plex: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchDate.sourceTimestamp,
          sourceFingerprint: providerWatchFingerprint(item, "plex", item.type === "episode" ? "section_or_history" : "item"),
          reason: watchDate.note || "Plex reported a watched library flag without playback evidence.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Plex: queued manual watch review: ${media.title}`);
        continue;
      }

      // Marking an item played on Plex bumps its lastViewedAt, so plembfin's own
      // outbound sync makes an already-recorded watch look freshly viewed on the
      // next poll. Only an item with no watch record at all counts as a new watch
      // here; when the record exists but the playstate has drifted, repair the
      // playstate rather than filing a second watch for the same play.
      if (existing && playstate?.state !== "watched") {
        logger(`Plex: repaired playstate for an already-recorded watch: ${media.title}`);
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", existing.watched_at, { skipInvalidate: true });
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Plex: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Plex: detected new watched item: ${media.title} (watched at ${media.watched_at}; ${dateChoice.reason})`);
        const trackerWatchedAt = watchDate.manualMark ? null : earliestTrackerWatchedAt(trackerWatchedDateIndex, media);
        const effectiveWatchedAt = trackerWatchedAt != null && trackerWatchedAt < Date.parse(media.watched_at)
          ? new Date(trackerWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Plex: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "plex");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Plex library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: plex`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Plex library history; sync completed.`,
          ...summary.targetStates.map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Plex sync recently watched failed: ${error.message}`);
  }

  if (skippedMalformed.length) {
    logger(`Plex: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromPlex").catch(() => null);
  return syncedCount;
}

export async function syncRecentlyWatchedFromEmby(config, loopStore, logger = console.log, trackerWatchedDateIndex = null) {
  const sourceMismatchRunKey = `emby:${Date.now()}`;
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Emby watched library sync is disabled.");
    return 0;
  }
  if (!config.emby?.baseUrl || !config.emby?.apiKey || !config.emby?.userId) return 0;
  let syncedCount = 0;
  const skippedMalformed = [];
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  try {
    const { fetchEmbyWatchedItems } = await import("./embyClient.js");
    const { normalizeProviderIds } = await import("./parsers.js");
    const raw = await fetchEmbyWatchedItems(config.emby, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    for (const item of raw) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = await withSeriesIdentity({
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        showTitle: item.Type === "Episode" ? (item.SeriesName || "") : null,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "emby",
        seriesItemId: librarySeriesItemId(item, "emby"),
        isValid: true,
      }, config);
      await checkIncomingEpisodeSourceMismatch(media, { runKey: sourceMismatchRunKey }).catch(() => null);
      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);
      const manualMark = !watchedAt && watchedAtReason === "marked without playback";
      if (!watchedAt && !manualMark) {
        logger(`Emby: skipped watched item without a reliable played date: ${media.title}`);
        continue;
      }
      const releaseDate = releaseDateForSourceItem(item, "emby");
      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "emby");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark,
        sourceTimestamp: watchedAt,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;

      media.watchProvenance = buildWatchProvenance(
        { source: "emby", event: "library_history", phase: "completed", itemId: item.Id, user: config.emby.userId },
        { ingestPath: "emby_scheduled_library_history", sourceTimestamp: watchedAt, note: `Import policy: ${dateChoice.reason}.` },
      );
      if (skipMalformedLibraryHistoryItem(media, "Emby", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Emby: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }

      if (libraryDecision === "skip_already_watched") {
        logger(`Emby: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchedAt,
          sourceFingerprint: providerWatchFingerprint(item, "emby", "watched_library"),
          reason: watchedAtReason === "marked without playback"
            ? "Emby reported an API-marked watched flag without playback evidence."
            : "Emby reported a watched flag without a usable playback timestamp.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Emby: queued manual watch review: ${media.title}`);
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Emby: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Emby: detected new watched item: ${media.title} (${dateChoice.reason} ${media.watched_at})`);
        const trackerWatchedAt = !watchedAt ? null : earliestTrackerWatchedAt(trackerWatchedDateIndex, media);
        const effectiveWatchedAt = trackerWatchedAt != null && trackerWatchedAt < Date.parse(media.watched_at)
          ? new Date(trackerWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Emby: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "emby");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Emby library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: emby`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Emby library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Emby sync recently watched failed: ${error.message}`);
  }
  if (skippedMalformed.length) {
    logger(`Emby: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromEmby").catch(() => null);
  return syncedCount;
}

export async function syncRecentlyWatchedFromJellyfin(config, loopStore, logger = console.log, trackerWatchedDateIndex = null) {
  const sourceMismatchRunKey = `jellyfin:${Date.now()}`;
  if (isAuthoritativeRestoreActive()) return 0;
  if (!watchedPlayedSyncEnabled()) {
    logger("Jellyfin watched library sync is disabled.");
    return 0;
  }
  if (!config.jellyfin?.baseUrl || !config.jellyfin?.apiKey || !config.jellyfin?.userId) return 0;
  let syncedCount = 0;
  const skippedMalformed = [];
  const importMode = currentWatchImportMode();
  const timingHistory = importMode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
  try {
    const { fetchJellyfinWatchedItems } = await import("./jellyfinClient.js");
    const { normalizeProviderIds } = await import("./parsers.js");
    const raw = await fetchJellyfinWatchedItems(config.jellyfin, { limit: SCHEDULED_RECENT_WATCH_LIMIT });
    for (const item of raw) {
      if (isAuthoritativeRestoreActive()) return syncedCount;
      // For episodes, prefer series-level provider IDs (SeriesProviderIds) so that Plex and
      // other targets can match by series GUID rather than failing on episode-level IDs.
      const rawIds = item.Type === "Episode"
        ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
        : (item.ProviderIds || {});
      const ids = normalizeProviderIds(rawIds);
      const media = await withSeriesIdentity({
        title: item.Type === "Episode" ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}` : item.Name,
        showTitle: item.Type === "Episode" ? (item.SeriesName || "") : null,
        type: item.Type === "Episode" ? "episode" : "movie",
        season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
        episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
        ids: {
          imdb: ids.imdb || undefined,
          tmdb: ids.tmdb || undefined,
          tvdb: ids.tvdb || undefined,
        },
        episodeTitle: item.Type === "Episode" ? item.Name : null,
        source: "jellyfin",
        seriesItemId: librarySeriesItemId(item, "jellyfin"),
        isValid: true,
      }, config);
      await checkIncomingEpisodeSourceMismatch(media, { runKey: sourceMismatchRunKey }).catch(() => null);
      if (await isRecentOutboundJellyfinNextUpNudge({ ...media, itemId: item.Id }, loopStore).catch(() => false)) {
        logger(`Jellyfin: ignored watched-library echo from a Next Up ordering nudge: ${media.title}`);
        continue;
      }
      const { watchedAt, reason: watchedAtReason } = watchedAtForEmbyLikeItem(item);
      const manualMark = !watchedAt && watchedAtReason === "marked without playback";
      if (!watchedAt && !manualMark) {
        logger(`Jellyfin: skipped watched item without a reliable played date: ${media.title}`);
        continue;
      }
      const releaseDate = releaseDateForSourceItem(item, "jellyfin");
      media.runtimeMinutes = runtimeMinutesForSourceItem(item, "jellyfin");
      const dateChoice = resolveWatchImportDate({
        mode: importMode,
        manualMark,
        sourceTimestamp: watchedAt,
        releaseDate,
        fallbackDate: watchedAt,
        media,
        historyRows: timingHistory,
      });
      media.watched_at = dateChoice.previewWatchedAt;

      media.watchProvenance = buildWatchProvenance(
        { source: "jellyfin", event: "library_history", phase: "completed", itemId: item.Id, user: config.jellyfin.userId },
        { ingestPath: "jellyfin_scheduled_library_history", sourceTimestamp: watchedAt, note: `Import policy: ${dateChoice.reason}.` },
      );
      if (skipMalformedLibraryHistoryItem(media, "Jellyfin", logger, skippedMalformed)) continue;
      if (!scheduledMediaInScope(config, media)) continue;

      const playstate = await getPlaystateForMedia(media).catch(() => null);
      const existing = await findWatchedByAnyMediaKey(media);
      const libraryDecision = libraryHistoryDecision({ requiresReview: dateChoice.requiresReview, existing, playstate });
      if (libraryDecision === "skip_recent_unwatch") {
        logger(`Jellyfin: ignored stale watched row immediately after unwatch: ${media.title}`);
        continue;
      }

      if (libraryDecision === "skip_already_watched") {
        logger(`Jellyfin: ignored library-history date for an item already watched in Plekt:${media.title}`);
        continue;
      }

      if (libraryDecision === "review") {
        const queued = enqueueManualWatchReview(media, {
          releaseDate,
          observedWatchedAt: watchedAt,
          sourceFingerprint: providerWatchFingerprint(item, "jellyfin", "watched_library"),
          reason: watchedAtReason === "marked without playback"
            ? "Jellyfin reported an API-marked watched flag without playback evidence."
            : "Jellyfin reported a watched flag without a usable playback timestamp.",
          allowWhenUnwatched: true,
        });
        if (queued.queued) logger(`Jellyfin: queued manual watch review: ${media.title}`);
        continue;
      }

      if (!existing) {
        if (isAuthoritativeRestoreActive()) return syncedCount;
        const lastRestoreAt = Number(loadWatchBackupRuntime().lastRestoreAt || 0);
        if (lastRestoreAt && new Date(media.watched_at).getTime() <= lastRestoreAt) {
          logger(`Jellyfin: skipped pre-restore item (played ${media.watched_at}): ${media.title}`);
          continue;
        }
        logger(`Jellyfin: detected new watched item: ${media.title} (${dateChoice.reason} ${media.watched_at})`);
        const trackerWatchedAt = !watchedAt ? null : earliestTrackerWatchedAt(trackerWatchedDateIndex, media);
        const effectiveWatchedAt = trackerWatchedAt != null && trackerWatchedAt < Date.parse(media.watched_at)
          ? new Date(trackerWatchedAt).toISOString()
          : media.watched_at;
        if (effectiveWatchedAt !== media.watched_at) {
          logger(`Jellyfin: ${media.title} reported ${media.watched_at}, but Trakt has an earlier watch - using Trakt's date instead.`);
        }
        media.watched_at = effectiveWatchedAt;
        const watchRecord = mediaToWatchRecord(media, "jellyfin");
        watchRecord.watched_at = effectiveWatchedAt;
        watchRecord.sync_action = "watched";
        watchRecord.sync_dispatch_telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: pending`,
          `Details: Watch event fetched from Jellyfin library history; queueing sync.`,
        ].join("\n");

        const result = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
        if (isAuthoritativeRestoreActive()) return syncedCount;
        await upsertPlaystateForMedia(media, "watched", result.record.watched_at, { skipInvalidate: true });
        const summary = await syncMediaPlaystate(media, config, loopStore).catch((error) => ({
          skipped: false,
          status: "error",
          details: `Outbound sync failed: ${error.message || String(error)}`,
          targetStates: [],
        }));

        const telemetry = [
          `Origin: jellyfin`,
          `Loop-check: Passed`,
          `Dispatch status: ${summary.status}`,
          `Details: Watch event fetched from Jellyfin library history; sync completed.`,
          ...(summary.targetStates || []).map(
            (t) => `Target ${t.target} status: ${t.status}${t.detail ? ` - ${t.detail}` : ""}`
          ),
        ].join("\n");

        await updateWatchTelemetry(result.id, telemetry, { skipInvalidate: true });
        await recordSyncHistory(media, summary, "watched");
        addTimingHistoryRow(timingHistory, media, effectiveWatchedAt);
        syncedCount++;
      }
    }
  } catch (error) {
    logger(`Jellyfin sync recently watched failed: ${error.message}`);
  }
  if (skippedMalformed.length) {
    logger(`Jellyfin: skipped ${skippedMalformed.length} malformed watched item(s) (${summariseTitles(skippedMalformed)}).`);
  }
  if (syncedCount) await invalidateHistoryDerivedCaches("syncRecentlyWatchedFromJellyfin").catch(() => null);
  return syncedCount;
}
