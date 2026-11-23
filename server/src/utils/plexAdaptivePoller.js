import { fetchPlexWithRefresh } from "./plexFetch.js";
import { resolvePlexAccountId } from "./plexClient.js";
import { watchedAtForPlexItem } from "./watchDates.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { plexHistoryItemMatchesConfiguredUser } from "./recentWatchImport.js";
import { getProviderLibrarySelection } from "./librarySelection.js";

const DEFAULT_ACTIVE_INTERVAL_MS = 5000;
const DEFAULT_IDLE_INTERVAL_MS = 30000;
const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60 * 1000;
const DEFAULT_UNWATCH_INTERVAL_MS = 10000;
const DEFAULT_CONNECTED_INTERVAL_MS = 60000;
// Keep steady-state requests small. A burst can span multiple pages.
const POLL_WINDOW_SIZE = 10;

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

// The cursor belongs to one Plex server. Manual setups may have no server ID,
// so the server URL stands in for it.
function plexServerIdentity(config) {
  const serverId = String(config?.serverId || "").trim();
  return serverId ? `id:${serverId}` : `url:${trimTrailingSlash(config?.baseUrl).toLowerCase()}`;
}

export function createPlexAdaptivePoller({
  getPlexConfig,
  onLibraryItemChange,
  checkUnwatched,
  isNotificationConnected = () => false,
  logger = console.log,
  activeIntervalMs = DEFAULT_ACTIVE_INTERVAL_MS,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  unwatchIntervalMs = DEFAULT_UNWATCH_INTERVAL_MS,
  connectedIntervalMs = DEFAULT_CONNECTED_INTERVAL_MS,
} = {}) {
  let stopped = true;
  let timer = null;
  let running = false;
  let lastActivityAt = Date.now();
  let lastKnownViewedAt = null;
  let cursorServerIdentity = null;
  let lastUnwatchCheckAt = 0;
  let errorBackoffMs = 0;
  let cachedSections = null;
  let cachedSectionsExpiresAt = 0;
  let cachedSectionsRevision = null;

  async function fetchSections(plexConfig) {
    const selection = getProviderLibrarySelection(plexConfig, "plex");
    const enforced = Boolean(plexConfig?.libraryMonitoringEnforced || Array.isArray(plexConfig?.monitoredLibraryIds));
    if (enforced && !selection.hasSelectedLibraries) return [];
    const now = Date.now();
    // A saved library selection bumps the revision; reload so a library added
    // and selected mid-run is polled now, not when the hourly cache expires.
    if (cachedSectionsRevision !== selection.revision) cachedSections = null;
    let directories = cachedSections && now < cachedSectionsExpiresAt ? cachedSections : null;
    if (!directories) {
      const baseUrl = trimTrailingSlash(plexConfig.baseUrl);
      const url = new URL(`${baseUrl}/library/sections`);
      const res = await fetchPlexWithRefresh(plexConfig, url);
      if (!res.ok) throw new Error(`Plex sections request failed with status ${res.status}`);
      const body = await res.json();
      directories = (body?.MediaContainer?.Directory || []).filter(
        (dir) => dir.type === "movie" || dir.type === "show",
      );
      cachedSections = directories;
      cachedSectionsRevision = selection.revision;
      cachedSectionsExpiresAt = now + 60 * 60 * 1000;
    }
    if (!enforced) return directories;
    return directories.filter((dir) => selection.selectedIdSet.has(String(dir.key)));
  }

  async function pollPlexWatchedItems(plexConfig, targetAccountId) {
    const selection = getProviderLibrarySelection(plexConfig, "plex");
    const enforced = Boolean(plexConfig?.libraryMonitoringEnforced || Array.isArray(plexConfig?.monitoredLibraryIds));
    if (enforced && !selection.hasSelectedLibraries) return [];
    const baseUrl = trimTrailingSlash(plexConfig.baseUrl);
    const candidateItems = [];
    let anySucceeded = false;
    let lastError = null;
    let incompletePage = false;
    const cutoff = lastKnownViewedAt === null ? null : Date.parse(lastKnownViewedAt);

    async function readRecentPages(url) {
      const results = [];
      const pageEnds = new Set();
      for (let start = 0; ; start += POLL_WINDOW_SIZE) {
        try {
          url.searchParams.set("X-Plex-Container-Start", String(start));
          url.searchParams.set("X-Plex-Container-Size", String(POLL_WINDOW_SIZE));
          const response = await fetchPlexWithRefresh(plexConfig, url);
          if (!response.ok) throw new Error(`Plex watched query failed with status ${response.status}`);
          const items = (await response.json())?.MediaContainer?.Metadata || [];
          results.push(...items);
          if (cutoff === null || items.length < POLL_WINDOW_SIZE) return results;
          const last = items.at(-1);
          const time = Date.parse(watchedAtForPlexItem(last).watchedAt);
          if (time <= cutoff) return results;
          const pageEnd = JSON.stringify([last.historyKey, last.ratingKey, last.key, time]);
          if (pageEnds.has(pageEnd)) throw new Error("Plex repeated a watched results page");
          pageEnds.add(pageEnd);
        } catch (error) {
          if (start > 0) incompletePage = true;
          throw error;
        }
      }
    }

    // 1. Check recent playback history.
    try {
      const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
      historyUrl.searchParams.set("sort", "viewedAt:desc");
      if (targetAccountId != null) {
        historyUrl.searchParams.set("accountID", String(targetAccountId));
      }
      const items = await readRecentPages(historyUrl);
      anySucceeded = true;
      for (const item of items) {
        if (enforced) {
          const sectionId = String(item?.librarySectionID ?? item?.librarySectionId ?? "").trim();
          if (sectionId && !selection.selectedIdSet.has(sectionId)) continue;
        }
        candidateItems.push({ item, accountScoped: targetAccountId != null, kind: "history" });
      }
    } catch (error) {
      lastError = error;
    }

    // 2. Check sections for manual marks, which are absent from playback history.
    try {
      const sections = await fetchSections(plexConfig);
      for (const section of sections.slice(0, 4)) {
        const sectionUrl = new URL(`${baseUrl}/library/sections/${section.key}/all`);
        sectionUrl.searchParams.set("unwatched", "0");
        sectionUrl.searchParams.set("sort", "lastViewedAt:desc");
        sectionUrl.searchParams.set("type", section.type === "movie" ? "1" : "4");
        if (targetAccountId != null) {
          sectionUrl.searchParams.set("accountID", String(targetAccountId));
        }
        const items = await readRecentPages(sectionUrl);
        anySucceeded = true;
        for (const item of items) {
          candidateItems.push({ item: { ...item, librarySectionID: item?.librarySectionID ?? section.key }, accountScoped: targetAccountId != null, kind: "section" });
        }
      }
    } catch (error) {
      lastError = error;
    }

    if (incompletePage || (!anySucceeded && lastError)) throw lastError;
    return candidateItems;
  }

  async function tick() {
    if (stopped) return;
    if (running) return;
    running = true;

    try {
      if (isAuthoritativeRestoreActive()) {
        scheduleNext(idleIntervalMs);
        return;
      }
      const config = await getPlexConfig();
      if (!config?.baseUrl || !config?.token || config.disabled) {
        scheduleNext(idleIntervalMs);
        return;
      }

      // A switch to a different Plex server reseeds the cursor; the same
      // server keeps it, so a settings-save restart does not skip new marks.
      const serverIdentity = plexServerIdentity(config);
      if (lastKnownViewedAt !== null && serverIdentity !== cursorServerIdentity) {
        lastKnownViewedAt = null;
      }

      const username = String(config.username || "").trim().toLowerCase();
      let targetAccountId = null;
      if (username) {
        targetAccountId = await resolvePlexAccountId(config).catch(() => null);
      }

      const candidates = await pollPlexWatchedItems(config, targetAccountId);
      if (isAuthoritativeRestoreActive()) {
        scheduleNext(idleIntervalMs);
        return;
      }
      const uniqueWatched = [];
      const seen = new Set();

      for (const { item, accountScoped, kind } of candidates) {
        if (!item || (!item.ratingKey && !item.key)) continue;
        if (!plexHistoryItemMatchesConfiguredUser(item, { username, accountId: targetAccountId, accountScoped })) continue;
        if (kind === "section" && Number(item.viewCount || 0) <= 0) continue;

        const { watchedAt } = watchedAtForPlexItem(item);
        if (!watchedAt) continue;

        const ratingKey = String(item.ratingKey || item.key || "").trim();
        const dedupeKey = `${ratingKey}-${watchedAt}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        uniqueWatched.push({ item, ratingKey, watchedAt, timeMs: new Date(watchedAt).getTime() });
      }

      uniqueWatched.sort((a, b) => b.timeMs - a.timeMs);

      if (lastKnownViewedAt === null) {
        // Initial seed on startup: take the newest timestamp without triggering historical bulk sync
        lastKnownViewedAt = uniqueWatched[0]?.watchedAt || new Date().toISOString();
        cursorServerIdentity = serverIdentity;
      } else {
        const lastKnownTime = new Date(lastKnownViewedAt).getTime();
        let maxNewTime = lastKnownTime;
        const newWatches = uniqueWatched.filter((w) => w.timeMs > lastKnownTime);

        for (const { item, ratingKey, watchedAt, timeMs } of newWatches.reverse()) {
          if (isAuthoritativeRestoreActive()) break;
          if (timeMs > maxNewTime) maxNewTime = timeMs;
          lastActivityAt = Date.now();
          if (onLibraryItemChange) {
            await onLibraryItemChange(ratingKey, item).catch((err) =>
              logger(`Plex adaptive poller: handler failed for ${ratingKey}: ${err?.message || err}`),
            );
          }
        }

        if (maxNewTime > lastKnownTime) {
          lastKnownViewedAt = new Date(maxNewTime).toISOString();
        }
      }

      // Fast unwatch check
      const now = Date.now();
      const isActive = now - lastActivityAt < idleThresholdMs;
      const connected = isNotificationConnected();
      const unwatchInterval = Math.max(
        isActive ? unwatchIntervalMs : idleIntervalMs,
        connected ? connectedIntervalMs : 0,
      );

      if (now - lastUnwatchCheckAt >= unwatchInterval) {
        lastUnwatchCheckAt = now;
        if (!isAuthoritativeRestoreActive() && typeof checkUnwatched === "function") {
          const foundUnwatch = await checkUnwatched(config).catch(() => false);
          if (foundUnwatch) {
            lastActivityAt = Date.now();
          }
        }
      }

      errorBackoffMs = 0;
      const nextDelay = Math.max(
        Date.now() - lastActivityAt < idleThresholdMs ? activeIntervalMs : idleIntervalMs,
        connected ? connectedIntervalMs : 0,
      );
      scheduleNext(nextDelay);
    } catch (error) {
      errorBackoffMs = Math.min(errorBackoffMs ? errorBackoffMs * 2 : 5000, 60000);
      scheduleNext(errorBackoffMs);
    } finally {
      running = false;
    }
  }

  function scheduleNext(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  }

  return {
    start({ keepCursor = false } = {}) {
      if (!stopped) return;
      stopped = false;
      lastActivityAt = Date.now();
      if (!keepCursor) lastKnownViewedAt = null;
      lastUnwatchCheckAt = 0;
      errorBackoffMs = 0;
      scheduleNext(Math.min(1000, activeIntervalMs));
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    // Settings saves restart the poller. Keep the cursor so a manual mark made
    // just before the restart is still handled; the next tick reseeds only if
    // the connection now points at a different Plex server.
    restart() {
      this.stop();
      this.start({ keepCursor: true });
    },
    poke() {
      lastActivityAt = Date.now();
      if (!stopped && !running) {
        scheduleNext(100);
      }
    },
  };
}
