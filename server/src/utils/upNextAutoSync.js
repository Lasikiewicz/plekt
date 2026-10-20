import { db, getDataVersion, getUpNextVersion } from "../db.js";
import {
  isAuthoritativeRestoreActive,
  loadMediaConfig,
  loadRuntimeState,
  setRuntimeState,
} from "./configStore.js";
import { enqueueBackgroundJob } from "./backgroundJobs.js";
import { buildUpNextProjection } from "./upNextService.js";
import { syncUpNextToProviders } from "./upNextProviderSync.js";
import { listUpNextProviderFeedStates } from "./upNextRepository.js";

export const UP_NEXT_AUTO_SYNC_JOB = "up_next_sync";
// Media-detail actions are user intent and must be delivered before older
// queued background work. A separate job type lets one ordinary and one
// interactive request coexist without allowing the ordinary singleton to
// swallow the interactive change.
export const UP_NEXT_PRIORITY_SYNC_JOB = "up_next_priority_sync";

const FINGERPRINT_RUNTIME_KEY = "upNextAutoSyncFingerprint";
const LAST_SYNC_RUNTIME_KEY = "upNextAutoSyncAt";
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
function fingerprintWithOutages(fingerprint, unreachable = []) {
  return unreachable.length ? `${fingerprint}|unreachable:${unreachable.join(",")}` : fingerprint;
}

export function upNextSyncCompleted(providers, summary = {}) {
  if (!providers.length) return false;
  if (summary?.disabled || summary?.ok === false) return false;
  const pushed = new Set(Array.isArray(summary.pushedProviders) ? summary.pushedProviders : []);
  if (providers.some((provider) => !pushed.has(provider))) return false;
  return !(Array.isArray(summary.feeds) && summary.feeds.some((feed) => (
    providers.includes(feed?.provider) && feed?.status === "failed"
  )));
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

// A manual header sync has already reconciled the exact list supplied by the
// browser. Remember it so the invalidation that follows that request does not
// immediately enqueue an identical automatic push.
export async function rememberUpNextSync(items = [], { at = Date.now(), unreachable = [] } = {}) {
  const fingerprint = fingerprintWithOutages(upNextQueueFingerprint(items), unreachable);
  await setRuntimeState({
    [FINGERPRINT_RUNTIME_KEY]: fingerprint,
    [LAST_SYNC_RUNTIME_KEY]: Number(at) || Date.now(),
  });
  return fingerprint;
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
  const projection = await buildUpNextProjection({ mediaConfig: config, limit: 100 });
  const items = Array.isArray(projection?.items) ? projection.items.slice(0, 100) : [];
  const fingerprint = fingerprintWithOutages(
    upNextQueueFingerprint(items),
    unreachableProviders(providers, listUpNextProviderFeedStates()),
  );
  const runtime = await loadRuntimeState();

  if (runtime[FINGERPRINT_RUNTIME_KEY] === fingerprint) {
    return { status: "unchanged", itemCount: items.length };
  }

  if (await isCancelled() || isAuthoritativeRestoreActive()) {
    return { status: "skipped", aborted: true, reason: "cancelled" };
  }
  logger(`[up-next] automatic provider sync started (${items.length} item${items.length === 1 ? "" : "s"})`);
  let pushedStale = false;
  const summary = await syncUpNextToProviders({
    desiredItems: items,
    config,
    // A canonical write since the projection (a Clear progress, say) makes
    // its resume positions stale; the rerun below rebuilds from fresh state.
    isStale: () => (pushedStale = getDataVersion() !== beforeDataVersion),
  });
  const complete = upNextSyncCompleted(providers, summary);
  // A run with one provider unreachable is still remembered once every other
  // provider took the push. Otherwise nothing was ever "unchanged" during an
  // outage: each run's Emby rail restamp came back as a webhook, set rerun, and
  // pushed again (step 7 offline run: 9 runs and 72 Emby played marks a minute).
  const unreachable = unreachableProviders(providers, summary?.feeds);
  const reachable = providers.filter((provider) => !unreachable.includes(provider));
  const settled = complete || (reachable.length > 0 && upNextSyncCompleted(reachable, summary));
  // Not remembered when skipped as stale, so an identical rebuilt queue is
  // still pushed rather than reported unchanged.
  if (settled && !pushedStale) await rememberUpNextSync(items, { unreachable: complete ? [] : unreachable });

  // The push's own rail restamps (unplay, then play) bump the versions, so a
  // version change alone is not a changed queue. Rebuild the queue and request
  // a follow-up only when its fingerprint differs from the one just pushed.
  let rerun = getDataVersion() !== beforeDataVersion || getUpNextVersion() !== beforeUpNextVersion;
  if (rerun) {
    const afterProjection = await buildUpNextProjection({ mediaConfig: config, limit: 100 });
    const afterItems = Array.isArray(afterProjection?.items) ? afterProjection.items.slice(0, 100) : [];
    const afterFingerprint = fingerprintWithOutages(
      upNextQueueFingerprint(afterItems),
      unreachableProviders(providers, summary?.feeds),
    );
    if (afterFingerprint === fingerprint) rerun = false;
  }
  return {
    status: complete ? "succeeded" : "partial",
    itemCount: items.length,
    providers,
    summary,
    rerun,
  };
}
