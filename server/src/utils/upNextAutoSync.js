import { db, getDataVersion, getUpNextVersion } from "../db.js";
import {
  isAuthoritativeRestoreActive,
  loadMediaConfig,
  loadRuntimeState,
  setRuntimeState,
} from "./configStore.js";
import { enqueueBackgroundJob } from "./backgroundJobs.js";
import { buildUpNextProjection } from "./upNextService.js";
import { getUpNextCacheSnapshot } from "./upNextCache.js";
import { refreshUpNextProviderFeeds, syncUpNextToProviders } from "./upNextProviderSync.js";
import { listUpNextProviderFeedStates } from "./upNextRepository.js";
import { createUpNextDestinationCheck, previewUpNextMirror } from "./upNextMirror.js";

export const UP_NEXT_AUTO_SYNC_JOB = "up_next_sync";
// Media-detail actions are user intent and must be delivered before older
// queued background work. A separate job type lets one ordinary and one
// interactive request coexist without allowing the ordinary singleton to
// swallow the interactive change.
export const UP_NEXT_PRIORITY_SYNC_JOB = "up_next_priority_sync";

const FINGERPRINT_RUNTIME_KEY = "upNextAutoSyncFingerprint";
const LAST_SYNC_RUNTIME_KEY = "upNextAutoSyncAt";
const LAST_SYNC_STATUS_RUNTIME_KEY = "upNextAutoSyncStatus";
const RETRY_RUNTIME_KEY = "upNextAutoSyncRetry";
const RETRY_MIN_MS = 60_000;
const PROVIDERS = ["plex", "emby", "jellyfin"];

function text(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerItemsForFingerprint(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    (Array.isArray(source[provider]) ? source[provider] : source[provider] == null ? [] : [source[provider]])
      .map(text)
      .filter(Boolean)
      .sort(),
  ]));
}

function itemForFingerprint(item = {}) {
  return {
    id: text(item.id),
    media_key: text(item.media_key || item.mediaKey),
    media_type: text(item.media_type || item.mediaType),
    queue_kind: text(item.queue_kind || item.queueKind),
    up_next_lane: text(item.up_next_lane),
    title: text(item.title),
    show_title: text(item.show_title || item.showTitle),
    episode_title: text(item.episode_title || item.episodeTitle),
    season: finiteNumber(item.season),
    episode: finiteNumber(item.episode),
    year: finiteNumber(item.year),
    imdb_id: text(item.imdb_id || item.imdbId),
    tmdb_id: text(item.tmdb_id || item.tmdbId),
    tvdb_id: text(item.tvdb_id || item.tvdbId),
    show_imdb_id: text(item.show_imdb_id || item.showImdbId),
    show_tmdb_id: text(item.show_tmdb_id || item.showTmdbId),
    show_tvdb_id: text(item.show_tvdb_id || item.showTvdbId),
    position_ms: finiteNumber(item.position_ms ?? item.positionMs),
    duration_ms: finiteNumber(item.duration_ms ?? item.durationMs),
    progress: finiteNumber(item.progress),
    provider_items: providerItemsForFingerprint(item.provider_items || item.providerItems),
  };
}

// The fingerprint deliberately excludes observed_at, source_updated_at and
// other timestamps. A provider feed being re-read should not push the same
// queue again unless its user-visible content or ordering actually changed.
export function upNextQueueFingerprint(items = []) {
  return JSON.stringify((Array.isArray(items) ? items : []).slice(0, 100).map(itemForFingerprint));
}

export function configuredUpNextProviders(config = {}) {
  return PROVIDERS.filter((provider) => {
    const section = config?.[provider] || {};
    if (section.disabled === true) return false;
    if (provider === "plex") return Boolean(section.baseUrl && section.token);
    return Boolean(section.baseUrl && section.apiKey && section.userId);
  });
}

// Providers whose every Up Next feed read failed, from either the push summary
// or the stored feed state. The push skips them (see syncUpNextToProviders).
function unreachableProviders(providers, feeds = []) {
  return providers.filter((provider) => {
    const providerFeeds = (Array.isArray(feeds) ? feeds : []).filter((feed) => feed?.provider === provider);
    return providerFeeds.length > 0 && providerFeeds.every((feed) => feed?.status === "failed");
  }).sort();
}

// The remembered fingerprint names the providers that were unreachable when it
// was pushed. While one stays down the next run is "unchanged", and once its
// feed read succeeds again the marker differs and the queue is pushed to it.
function fingerprintForPush(items, config, unreachable = []) {
  const destinations = configuredUpNextProviders(config).map((provider) => {
    const section = config[provider];
    return [provider, section.baseUrl, section.connectionId, section.remoteUserId || section.userId];
  });
  return JSON.stringify([upNextQueueFingerprint(items), destinations, config.tuning?.plexHistoricalWatchedSync, config.upNextSync?.mirror, unreachable]);
}

export function upNextSyncCompleted(providers, summary = {}) {
  if (!providers.length) return false;
  if (summary?.disabled || summary?.ok === false) return false;
  const pushed = new Set(Array.isArray(summary.pushedProviders) ? summary.pushedProviders : []);
  if (providers.some((provider) => !pushed.has(provider))) return false;
  return !(Array.isArray(summary.feeds) && summary.feeds.some((feed) => (
    providers.includes(feed?.provider) && ["failed", "partial", "superseded"].includes(feed?.status)
  )));
}

export async function pushCurrentUpNextQueue(config, { previewMirror = "" } = {}) {
  const beforeDataVersion = getDataVersion();
  if (previewMirror && PROVIDERS.includes(previewMirror)) {
    await refreshUpNextProviderFeeds({ config, providers: [previewMirror], triggerOnRecovery: false });
  }
  const snapshot = await getUpNextCacheSnapshot(
    (context) => buildUpNextProjection({ mediaConfig: config, ...context }),
    { trigger: "manual provider sync" },
  );
  const items = snapshot.items;
  if (previewMirror) return { preview: await previewUpNextMirror(config, previewMirror, snapshot) };
  const summary = await syncUpNextToProviders({
    desiredItems: items,
    builtAt: snapshot.builtAt,
    config,
    destinationCurrent: createUpNextDestinationCheck(config),
    isStale: () => getDataVersion() !== beforeDataVersion,
  });
  return { items, summary };
}

function normalizedProviderList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((provider) => String(provider || "").trim().toLowerCase())
      .filter((provider) => PROVIDERS.includes(provider)),
  )].sort();
}

export function buildUpNextSyncStatusSummary({
  at = Date.now(),
  mode = "auto",
  providers = [],
  summary = {},
  unreachable = [],
  itemCount = 0,
} = {}) {
  const configuredProviders = normalizedProviderList(providers);
  const pushedProviders = normalizedProviderList(summary?.pushedProviders);
  const unreachableProvidersList = normalizedProviderList(unreachable);
  const failedFeedProviders = normalizedProviderList(
    (Array.isArray(summary?.feeds) ? summary.feeds : [])
      .filter((feed) => feed?.status === "failed")
      .map((feed) => feed?.provider),
  );
  const complete = upNextSyncCompleted(configuredProviders, summary);
  const status = summary?.disabled
    ? "disabled"
    : summary?.ok === false
      ? "failed"
      : complete
        ? "succeeded"
        : pushedProviders.length > 0
          ? "partial"
          : configuredProviders.length === 0
            ? "idle"
            : "failed";
  return {
    at: Number(at) || Date.now(),
    mode: mode === "manual" ? "manual" : "auto",
    status,
    itemCount: Math.max(0, Number(itemCount) || 0),
    configuredProviders,
    pushedProviders,
    unreachableProviders: unreachableProvidersList,
    failedFeedProviders,
    ...(summary.mirrorHides?.length ? { mirrorHides: summary.mirrorHides.slice(0, 100).map(({ provider, title, reason, status, at: hideAt }) => ({
      provider, title, reason, status, at: Number(hideAt) || Number(at) || Date.now(),
    })) } : {}),
  };
}

export async function recordUpNextSyncStatus(syncStatus) {
  if (!syncStatus || typeof syncStatus !== "object") return null;
  const previous = (await loadRuntimeState().catch(() => ({})))?.[LAST_SYNC_STATUS_RUNTIME_KEY];
  const priorLog = Array.isArray(previous?.recentMirrorHides)
    ? previous.recentMirrorHides
    : (Array.isArray(previous?.mirrorHides) ? previous.mirrorHides : []);
  const incoming = Array.isArray(syncStatus.mirrorHides) ? syncStatus.mirrorHides : [];
  const recentMirrorHides = [...incoming, ...priorLog].slice(0, 50);
  const stored = recentMirrorHides.length ? { ...syncStatus, recentMirrorHides } : syncStatus;
  await setRuntimeState({ [LAST_SYNC_STATUS_RUNTIME_KEY]: stored });
  return stored;
}

export async function readUpNextSyncStatus() {
  const runtime = await loadRuntimeState().catch(() => ({}));
  const stored = runtime?.[LAST_SYNC_STATUS_RUNTIME_KEY];
  if (stored && typeof stored === "object" && Number(stored.at) > 0) return stored;
  const legacyAt = Number(runtime?.[LAST_SYNC_RUNTIME_KEY] || 0);
  if (legacyAt > 0) {
    return {
      at: legacyAt,
      mode: "auto",
      status: "succeeded",
      itemCount: 0,
      configuredProviders: [],
      pushedProviders: [],
      unreachableProviders: [],
      failedFeedProviders: [],
    };
  }
  return null;
}

// Queueing is intentionally lightweight and durable. The worker builds the
// latest projection when it claims the job, so a burst of queue changes is
// represented by one job rather than a push per mutation.
export async function requestUpNextAutoSync(reason = "", { priority = false } = {}) {
  if (!db.open) return { queued: false, skipped: "database-closed" };
  const config = await loadMediaConfig({ resolveConnections: false }).catch(() => null);
  if (config?.upNextSync?.enabled === false) return { queued: false, skipped: "disabled" };
  try {
    const type = priority ? UP_NEXT_PRIORITY_SYNC_JOB : UP_NEXT_AUTO_SYNC_JOB;
    const job = enqueueBackgroundJob(type, { reason: text(reason) });
    return { queued: true, job };
  } catch (error) {
    if (error?.code === "JOB_ACTIVE") return { queued: false, coalesced: true };
    if (error?.code === "RESTORE_ACTIVE") return { queued: false, skipped: "restore" };
    throw error;
  }
}

export async function requestDueUpNextRetry() {
  const retry = (await loadRuntimeState())[RETRY_RUNTIME_KEY];
  if (retry?.dueAt && retry.dueAt <= Date.now()) return requestUpNextAutoSync("Retry incomplete Up Next provider writes");
  return null;
}

// Remember the reconciled snapshot and destination so unchanged pushes can coalesce.
export async function rememberUpNextSync(items = [], { at = Date.now(), unreachable = [], config = null } = {}) {
  const fingerprint = fingerprintForPush(items, config || await loadMediaConfig(), unreachable);
  await setRuntimeState({
    [FINGERPRINT_RUNTIME_KEY]: fingerprint,
    [LAST_SYNC_RUNTIME_KEY]: Number(at) || Date.now(),
    [RETRY_RUNTIME_KEY]: null,
  });
  return fingerprint;
}

export async function recordManualUpNextSyncResult(config = {}, desiredItems = [], summary = {}) {
  if (!summary || summary.disabled) return null;
  const providers = configuredUpNextProviders(config);
  const unreachable = unreachableProviders(providers, summary.feeds);
  const syncStatus = buildUpNextSyncStatusSummary({
    mode: "manual",
    providers,
    summary,
    unreachable,
    itemCount: Array.isArray(desiredItems) ? desiredItems.length : 0,
  });
  await recordUpNextSyncStatus(syncStatus);
  if (summary.ok && upNextSyncCompleted(providers, summary)) {
    await rememberUpNextSync(desiredItems, { at: syncStatus.at, config });
  }
  return syncStatus;
}

export async function runAutomaticUpNextSync({ logger = () => {}, isCancelled = async () => false } = {}) {
  const config = await loadMediaConfig();
  if (config?.upNextSync?.enabled === false) return { status: "skipped", reason: "disabled" };
  if (isAuthoritativeRestoreActive()) return { status: "skipped", reason: "restore" };
  if (await isCancelled()) return { status: "skipped", aborted: true, reason: "cancelled" };

  const providers = configuredUpNextProviders(config);
  if (!providers.length) return { status: "skipped", reason: "no-configured-providers" };

  const beforeDataVersion = getDataVersion();
  const beforeUpNextVersion = getUpNextVersion();
  // Read the shared snapshot rather than building a private projection: it is
  // served as is while current and waits for one deduplicated build when the
  // history or queue changed, so a queue change costs one build, not two.
  const build = (ctx) => buildUpNextProjection({ mediaConfig: config, limit: 100, ...ctx });
  const projection = await getUpNextCacheSnapshot(build, { trigger: "auto-sync before push" });
  const items = Array.isArray(projection?.items) ? projection.items.slice(0, 100) : [];
  const fingerprint = fingerprintForPush(
    items, config,
    unreachableProviders(providers, listUpNextProviderFeedStates()),
  );
  const runtime = await loadRuntimeState();
  const retry = runtime[RETRY_RUNTIME_KEY];
  const retryFingerprint = fingerprintForPush(items, config);
  const continuing = retry?.fingerprint === retryFingerprint;
  const priorComplete = continuing && Array.isArray(retry.completed) ? retry.completed : [];
  const pending = providers.filter((provider) => !priorComplete.includes(provider));

  if (runtime[FINGERPRINT_RUNTIME_KEY] === fingerprint) {
    return { status: "unchanged", itemCount: items.length };
  }
  if (continuing && retry.dueAt > Date.now()) return { status: "retry_pending", itemCount: items.length };

  if (await isCancelled() || isAuthoritativeRestoreActive()) {
    return { status: "skipped", aborted: true, reason: "cancelled" };
  }
  logger(`[up-next] automatic provider sync started (${items.length} item${items.length === 1 ? "" : "s"})`);
  let pushedStale = false;
  const summary = await syncUpNextToProviders({
    desiredItems: items,
    builtAt: projection.builtAt,
    config,
    destinationCurrent: createUpNextDestinationCheck(config),
    providers: pending,
    // A canonical write since the projection (a Clear progress, say) makes
    // its resume positions stale; the rerun below rebuilds from fresh state.
    isStale: () => (pushedStale = getDataVersion() !== beforeDataVersion),
  });
  const completed = [...priorComplete, ...pending.filter((provider) => upNextSyncCompleted([provider], summary))];
  summary.pushedProviders = [...new Set([...summary.pushedProviders, ...priorComplete])];
  const complete = upNextSyncCompleted(providers, summary);
  // A run with one provider unreachable is still remembered once every other
  // provider took the push. Otherwise nothing was ever "unchanged" during an
  // outage: each run's Emby rail restamp came back as a webhook, set rerun, and
  // pushed again (step 7 offline run: 9 runs and 72 Emby played marks a minute).
  const unreachable = unreachableProviders(providers, summary?.feeds);
  const reachable = providers.filter((provider) => !unreachable.includes(provider));
  const settled = complete || (reachable.length > 0 && upNextSyncCompleted(reachable, summary));
  const syncStatus = buildUpNextSyncStatusSummary({
    mode: "auto",
    providers,
    summary,
    unreachable,
    itemCount: items.length,
  });
  await recordUpNextSyncStatus(syncStatus);
  const retryAttempt = (continuing ? retry.attempt : 0) + 1;
  await setRuntimeState({
    [RETRY_RUNTIME_KEY]: settled || pushedStale ? null : {
      fingerprint: retryFingerprint,
      completed,
      attempt: retryAttempt,
      dueAt: Date.now() + RETRY_MIN_MS * Math.min(30, 2 ** Math.min(retryAttempt - 1, 5)),
    },
  });
  // Not remembered when skipped as stale, so an identical rebuilt queue is
  // still pushed rather than reported unchanged.
  if (settled && !pushedStale) await rememberUpNextSync(items, { at: syncStatus.at, unreachable: complete ? [] : unreachable, config });

  // The push's own rail restamps (unplay, then play) bump the versions, so a
  // version change alone is not a changed queue. Rebuild the queue and request
  // a follow-up only when its fingerprint differs from the one just pushed.
  let rerun = getDataVersion() !== beforeDataVersion || getUpNextVersion() !== beforeUpNextVersion;
  if (rerun) {
    const afterProjection = await getUpNextCacheSnapshot(build, { trigger: "auto-sync after push" });
    const afterItems = Array.isArray(afterProjection?.items) ? afterProjection.items.slice(0, 100) : [];
    const afterFingerprint = fingerprintForPush(
      afterItems, config,
      unreachableProviders(providers, summary?.feeds),
    );
    if (afterFingerprint === fingerprint) {
      rerun = false;
      // The queue rebuilt after the push is the one that was pushed, so the
      // push's own echoes were all that moved the versions. Remember it:
      // otherwise the "projection changed" run that follows pushes the same
      // queue again and pays another build (plan/archive/up-next-build-speed/summary.md).
      if (settled && pushedStale) {
        await rememberUpNextSync(items, { at: syncStatus.at, unreachable: complete ? [] : unreachable, config });
      }
    }
  }
  return {
    status: complete ? "succeeded" : "partial",
    itemCount: items.length,
    providers,
    summary,
    syncStatus,
    rerun,
  };
}
