import { fetchPlexWithRefresh } from "./plexFetch.js";
import { resolvePlexAccountId } from "./plexClient.js";
import { watchedAtForPlexItem } from "./watchDates.js";
import { isAuthoritativeRestoreActive } from "./configStore.js";
import { plexHistoryItemMatchesConfiguredUser } from "./recentWatchImport.js";

const DEFAULT_ACTIVE_INTERVAL_MS = 5000;
const DEFAULT_IDLE_INTERVAL_MS = 30000;
const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60 * 1000;
const DEFAULT_UNWATCH_INTERVAL_MS = 10000;

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

export function createPlexAdaptivePoller({
  getPlexConfig,
  onLibraryItemChange,
  checkUnwatched,
  logger = console.log,
  activeIntervalMs = DEFAULT_ACTIVE_INTERVAL_MS,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  unwatchIntervalMs = DEFAULT_UNWATCH_INTERVAL_MS,
} = {}) {
  let stopped = true;
  let timer = null;
  let running = false;
  let lastActivityAt = Date.now();
  let lastKnownViewedAt = null;
  let lastUnwatchCheckAt = 0;
  let errorBackoffMs = 0;
  let cachedSections = null;
  let cachedSectionsExpiresAt = 0;

  async function fetchSections(plexConfig) {
    const now = Date.now();
    if (cachedSections && now < cachedSectionsExpiresAt) return cachedSections;
    try {
      const baseUrl = trimTrailingSlash(plexConfig.baseUrl);
      const url = new URL(`${baseUrl}/library/sections`);
      const res = await fetchPlexWithRefresh(plexConfig, url);
      if (!res.ok) return [];
      const body = await res.json();
      const directories = (body?.MediaContainer?.Directory || []).filter(
        (dir) => dir.type === "movie" || dir.type === "show",
      );
      cachedSections = directories;
      cachedSectionsExpiresAt = now + 60 * 60 * 1000;
      return directories;
    } catch {
      return [];
    }
  }

  async function pollPlexWatchedItems(plexConfig, targetAccountId) {
    const baseUrl = trimTrailingSlash(plexConfig.baseUrl);
    const candidateItems = [];

    // 1. Check history head
    try {
      const historyUrl = new URL(`${baseUrl}/status/sessions/history/all`);
      historyUrl.searchParams.set("sort", "viewedAt:desc");
      historyUrl.searchParams.set("X-Plex-Container-Start", "0");
      historyUrl.searchParams.set("X-Plex-Container-Size", "4");
      if (targetAccountId != null) {
        historyUrl.searchParams.set("accountID", String(targetAccountId));
      }
      const historyRes = await fetchPlexWithRefresh(plexConfig, historyUrl);
      if (historyRes.ok) {
        const data = await historyRes.json();
        const items = data?.MediaContainer?.Metadata || [];
        for (const item of items) {
          candidateItems.push({ item, accountScoped: targetAccountId != null, kind: "history" });
        }
      }
    } catch {
      // transient network error handled by caller
    }

    // 2. Check sections head for recent lastViewedAt
    try {
      const sections = await fetchSections(plexConfig);
      for (const section of sections.slice(0, 4)) {
        const sectionUrl = new URL(`${baseUrl}/library/sections/${section.key}/all`);
        sectionUrl.searchParams.set("unwatched", "0");
        sectionUrl.searchParams.set("sort", "lastViewedAt:desc");
        sectionUrl.searchParams.set("X-Plex-Container-Start", "0");
        sectionUrl.searchParams.set("X-Plex-Container-Size", "2");
        sectionUrl.searchParams.set("type", section.type === "movie" ? "1" : "4");
        if (targetAccountId != null) {
          sectionUrl.searchParams.set("accountID", String(targetAccountId));
        }
        const sectionRes = await fetchPlexWithRefresh(plexConfig, sectionUrl);
        if (sectionRes.ok) {
          const data = await sectionRes.json();
          const items = data?.MediaContainer?.Metadata || [];
          for (const item of items) {
            candidateItems.push({ item, accountScoped: targetAccountId != null, kind: "section" });
          }
        }
      }
    } catch {
      // transient network error handled by caller
    }

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
      const unwatchInterval = isActive ? unwatchIntervalMs : idleIntervalMs;

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
      const nextDelay = Date.now() - lastActivityAt < idleThresholdMs ? activeIntervalMs : idleIntervalMs;
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
    start() {
      if (!stopped) return;
      stopped = false;
      lastActivityAt = Date.now();
      lastKnownViewedAt = null;
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
    restart() {
      this.stop();
      this.start();
    },
    poke() {
      lastActivityAt = Date.now();
      if (!stopped && !running) {
        scheduleNext(100);
      }
    },
  };
}
