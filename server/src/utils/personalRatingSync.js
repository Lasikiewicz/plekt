import crypto from "node:crypto";
import { bumpDataVersion, db, transaction, writeAuditLog } from "../db.js";
import {
  DEFAULT_RATING_SYNC,
  RATING_SYNC_DIRECTIONS,
  RATING_SYNC_PROVIDERS,
  isAuthoritativeRestoreActive,
  loadMediaConfig,
  normalizeRatingSyncSection,
} from "./configStore.js";
import {
  fetchPlexPersonalRatingSnapshot,
  setPlexPersonalRating,
  clearPlexPersonalRating,
} from "./plexClient.js";
import {
  fetchEmbyPersonalRatingSnapshot,
  setEmbyPersonalRating,
  clearEmbyPersonalRating,
} from "./embyClient.js";
import {
  fetchJellyfinPersonalRatingSnapshot,
  setJellyfinPersonalRating,
  clearJellyfinPersonalRating,
} from "./jellyfinClient.js";
import { fetchTraktPersonalRatingSnapshot, setTraktPersonalRating, clearTraktPersonalRating } from "./traktClient.js";
import { withFreshTraktConnection } from "./trackerDispatcher.js";
import { getTrackerConnection } from "./trackerConnectionRepo.js";
import { getMediaConnection } from "./mediaConnectionRepo.js";
import {
  PERSONAL_RATING_PROVIDERS,
  acknowledgePersonalRatingQueue,
  claimPersonalRatingQueue,
  enqueuePersonalRatingMutation,
  ensureRatingSourceRow,
  failPersonalRatingQueue,
  findCanonicalPersonalRating,
  finishPersonalRatingSyncRun,
  getCanonicalPersonalRating,
  getOutstandingPersonalRatingIntent,
  getPersonalRatingSyncRun,
  getRatingSourceRow,
  listCanonicalPersonalRatings,
  listPersonalRatingQueue,
  listRatingSourceRows,
  markRatingSourceSnapshotComplete,
  personalRatingRepositoryStatus,
  ratingQueueCounts,
  retryPersonalRatingQueue,
  startPersonalRatingSyncRun,
  supersedePersonalRatingIntent,
  updatePersonalRatingSyncRun,
  updateRatingSourceSyncStatus,
  upsertCanonicalPersonalRating,
  upsertRatingSourceObservation,
} from "./personalRatingRepository.js";
import {
  normalizePersonalRatingMedia,
  personalRatingMediaAliases,
} from "./personalRatingIdentity.js";

const MAX_QUEUE_BATCH = 50;
const QUEUE_LEASE_MS = 120_000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;
const RUN_STALE_MS = 30 * 60_000;
const mediaProviderAdapters = {
  plex: {
    snapshot: fetchPlexPersonalRatingSnapshot,
    write: setPlexPersonalRating,
    clear: clearPlexPersonalRating,
  },
  emby: {
    snapshot: fetchEmbyPersonalRatingSnapshot,
    write: setEmbyPersonalRating,
    clear: clearEmbyPersonalRating,
  },
  jellyfin: {
    snapshot: fetchJellyfinPersonalRatingSnapshot,
    write: setJellyfinPersonalRating,
    clear: clearJellyfinPersonalRating,
  },
  trakt: {
    snapshot: fetchTraktPersonalRatingSnapshot,
    write: setTraktPersonalRating,
    clear: clearTraktPersonalRating,
  },
};

let activeSyncPromise = null;

function providerName(value) {
  const provider = String(value || "").trim().toLowerCase();
  return RATING_SYNC_PROVIDERS.includes(provider) ? provider : "";
}

function normalizeProviders(values) {
  const requested = Array.isArray(values) && values.length ? values : RATING_SYNC_PROVIDERS;
  return [...new Set(requested.map(providerName).filter(Boolean))];
}

function directionAllows(direction, operation) {
  const value = String(direction || "off").toLowerCase();
  return operation === "send"
    ? value === "send" || value === "bidirectional"
    : value === "receive" || value === "bidirectional";
}

function configForRating(config = {}) {
  return {
    ...config,
    ratingSync: normalizeRatingSyncSection(config.ratingSync || DEFAULT_RATING_SYNC),
  };
}

function providerConfigured(config, provider) {
  if (provider === "trakt") return Boolean(getTrackerConnection("trakt")?.status === "connected");
  const section = config?.[provider] || {};
  if (section.disabled) return false;
  if (provider === "plex" && section.baseUrl && section.token) return true;
  if (provider !== "plex" && section.baseUrl && section.apiKey && section.userId) return true;
  return ["connected", "reauth_required", "legacy"].includes(getMediaConnection(provider)?.status);
}

function providerConnectionStatus(config, provider) {
  if (provider === "trakt") return getTrackerConnection("trakt")?.status || "not_connected";
  if (config?.[provider]?.disabled) return "disabled";
  const connectionStatus = getMediaConnection(provider)?.status;
  if (connectionStatus) return connectionStatus;
  if (!providerConfigured(config, provider)) return "not_configured";
  const connection = config?.[provider]?.connection;
  return connection?.status || "configured";
}

function providerConfig(config, provider) {
  if (provider === "trakt") return withFreshTraktConnection();
  return Promise.resolve(config?.[provider] || null);
}

function safeError(error) {
  return String(error?.message || error || "Rating sync failed").trim().slice(0, 1000);
}

function retryDelay(attemptCount = 0, error = null) {
  const retryAfterSeconds = Number(error?.retryAfter || 0);
  if (retryAfterSeconds > 0) return Math.min(MAX_RETRY_MS, retryAfterSeconds * 1000);
  const attempt = Math.max(0, Number(attemptCount) || 0);
  return Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * (2 ** Math.min(5, attempt)));
}

function isUnauthorized(error) {
  return [401, 403].includes(Number(error?.status));
}

function isNotFound(error) {
  return Number(error?.status) === 404 || error?.code === "not_found";
}

function queueIssueCount(queue = {}) {
  return Number(queue.failed || 0)
    + Number(queue.not_found ?? queue.notFound ?? 0)
    + Number(queue.reauth_required ?? queue.reauthRequired ?? 0);
}

function ratingSyncHasIssues(queue = {}) {
  return queueIssueCount(queue) > 0;
}

function isSourceRowSame(previous, state, rating) {
  return Boolean(previous
    && previous.remote_state === state
    && (state !== "rated" || Number(previous.remote_rating) === Number(rating)));
}

function canonicalMediaFromRow(row) {
  if (!row) return null;
  return normalizePersonalRatingMedia({
    ...row,
    type: row.media_type,
    media_type: row.media_type,
    media_key: row.media_key,
    show_tmdb_id: row.media_type === "episode" ? row.tmdb_id : "",
    show_tvdb_id: row.media_type === "episode" ? row.tvdb_id : "",
    show_imdb_id: row.media_type === "episode" ? row.imdb_id : "",
    episode_tmdb_id: row.episode_tmdb_id || "",
    episode_tvdb_id: row.episode_tvdb_id || "",
    episode_imdb_id: row.episode_imdb_id || "",
  }, { mediaKey: row.media_key });
}

function sourceRowsMatch(left, right) {
  const leftMedia = left?.media || left || {};
  const rightMedia = right?.media || right || {};
  const leftAliases = new Set(personalRatingMediaAliases(leftMedia));
  if (personalRatingMediaAliases(rightMedia).some((alias) => leftAliases.has(alias))) return true;
  if (leftMedia.media_type !== "episode" || rightMedia.media_type !== "episode") return false;
  return String(leftMedia.show_title || "").trim().toLowerCase() === String(rightMedia.show_title || "").trim().toLowerCase()
    && Number(leftMedia.season) === Number(rightMedia.season)
    && Number(leftMedia.episode) === Number(rightMedia.episode);
}

function sourceRowForMedia(provider, media) {
  return getRatingSourceRow(provider, media.media_key)
    || listRatingSourceRows(provider).find((row) => sourceRowsMatch(row, media))
    || null;
}

function enrichTraktEpisodeMedia(media, mediaKey) {
  if (media.media_type !== "episode") return media;
  const episodeProviderIds = { ...(media.episode_provider_ids || {}) };
  const sourceProviders = PERSONAL_RATING_PROVIDERS.filter((provider) => provider !== "trakt");
  for (const sourceProvider of sourceProviders) {
    const source = sourceRowForMedia(sourceProvider, { ...media, media_key: mediaKey });
    if (!source) continue;
    const sourceMedia = source.media || {};
    const sourceIds = source.provider_ids || {};
    const candidates = {
      tmdb: sourceMedia.episode_tmdb_id || sourceIds.episode_tmdb_id || sourceIds.episode_tmdb || sourceIds.tmdb,
      tvdb: sourceMedia.episode_tvdb_id || sourceIds.episode_tvdb_id || sourceIds.episode_tvdb || sourceIds.tvdb,
      imdb: sourceMedia.episode_imdb_id || sourceIds.episode_imdb_id || sourceIds.episode_imdb || sourceIds.imdb,
      trakt: sourceMedia.episode_trakt_id || sourceIds.episode_trakt_id || sourceIds.episode_trakt || sourceIds.trakt,
    };
    for (const [provider, value] of Object.entries(candidates)) {
      if (!episodeProviderIds[provider] && value != null && String(value).trim()) episodeProviderIds[provider] = String(value).trim();
    }
  }
  if (!Object.keys(episodeProviderIds).length) return media;
  return normalizePersonalRatingMedia({ ...media, episode_provider_ids: episodeProviderIds }, { mediaKey });
}

function findPreviousSourceRow(previousRows, media) {
  return previousRows.find((row) => sourceRowsMatch(row, media)) || null;
}

function currentLocalTimestamp(row) {
  return Number(row?.canonical_updated_at || row?.updated_at || 0);
}

function desiredStateForRating(rating) {
  return rating == null ? "unrated" : "rated";
}

function providerDirections(config) {
  return configForRating(config).ratingSync.providers;
}

// Called by the personal-media route inside its existing SQLite transaction.
// The queue is intentionally the only remote side effect of a local rating
// write; no provider request is made on the request path.
export function queuePersonalRatingMutation(media, rating, { config = {}, source = "manual", timestamp = Date.now(), providers = null } = {}) {
  const normalized = normalizePersonalRatingMedia(media);
  const settings = configForRating(config);
  if (!settings.ratingSync.enabled) return { queued: 0, providers: [] };
  const state = desiredStateForRating(rating);
  const queuedProviders = [];
  const canonicalVersion = Number(timestamp) || Date.now();
  for (const provider of PERSONAL_RATING_PROVIDERS) {
    if (Array.isArray(providers) && !providers.includes(provider)) continue;
    if (!directionAllows(settings.ratingSync.providers[provider], "send")) continue;
    if (!providerConfigured(settings, provider)) continue;
    ensureRatingSourceRow(provider, normalized, { now: canonicalVersion });
    enqueuePersonalRatingMutation({
      provider,
      media: normalized,
      desiredState: state,
      desiredRating: rating,
      source,
      canonicalVersion,
      timestamp: canonicalVersion,
    });
    queuedProviders.push(provider);
  }
  return { queued: queuedProviders.length, providers: queuedProviders };
}

function queueImportedFanout(media, rating, sourceProvider, config, timestamp) {
  const settings = configForRating(config);
  if (!settings.ratingSync.enabled) return [];
  const queued = [];
  for (const provider of PERSONAL_RATING_PROVIDERS) {
    if (provider === sourceProvider || !directionAllows(settings.ratingSync.providers[provider], "send")) continue;
    if (!providerConfigured(settings, provider)) continue;
    ensureRatingSourceRow(provider, media, { now: timestamp });
    enqueuePersonalRatingMutation({
      provider,
      media,
      desiredState: desiredStateForRating(rating),
      desiredRating: rating,
      source: "reconcile",
      canonicalVersion: timestamp,
      timestamp,
    });
    queued.push(provider);
  }
  return queued;
}

function applyRemoteObservation({ provider, media, rating, previous, config, mode, now, remoteChangedAt }) {
  const settings = configForRating(config);
  if (mode !== "import" || !directionAllows(settings.ratingSync.providers[provider], "receive")) {
    return { changed: false, imported: false, cleared: false, conflict: false, queued: [] };
  }

  const remoteState = desiredStateForRating(rating);
  if (isSourceRowSame(previous, remoteState, rating)) {
    return { changed: false, imported: false, cleared: false, conflict: false, queued: [] };
  }

  const existing = findCanonicalPersonalRating(media);
  const canonicalMedia = existing ? canonicalMediaFromRow(existing) : null;
  const remoteMedia = existing
    ? normalizePersonalRatingMedia({
        ...media,
        ...canonicalMedia,
        media_key: existing.media_key,
        title: existing.title || media.title,
        poster_url: existing.poster_url || media.poster_url,
        overview: existing.overview || media.overview,
        release_date: existing.release_date || media.release_date,
        // Canonical rows created before an episode was resolved can have
        // blank leaf ids. Keep any richer ids from the provider observation.
        episode_tmdb_id: canonicalMedia.episode_tmdb_id || media.episode_tmdb_id || "",
        episode_tvdb_id: canonicalMedia.episode_tvdb_id || media.episode_tvdb_id || "",
        episode_imdb_id: canonicalMedia.episode_imdb_id || media.episode_imdb_id || "",
        episode_trakt_id: canonicalMedia.episode_trakt_id || media.episode_trakt_id || "",
        episode_provider_ids: {
          ...(media.episode_provider_ids || {}),
          ...(canonicalMedia.episode_provider_ids || {}),
        },
      }, { mediaKey: existing.media_key })
    : media;
  // The provider is reporting the value Plembfin itself last delivered to it,
  // and nothing different has been observed from it since that delivery. It
  // acknowledges our write; it is not a new remote change, so it must not
  // restamp the canonical row or fan out again (manual provider matrix step 5,
  // 22 September 2026: every delivery was re-imported on the next scan and
  // re-queued to every other provider, resetting their retry backoff).
  const echo = Boolean(previous
    && previous.last_outbound_state === remoteState
    && Number(previous.last_outbound_rating ?? 0) === Number(rating ?? 0)
    && Number(previous.last_outbound_at || 0) >= Number(previous.last_inbound_at || 0));
  if (echo) return { changed: false, imported: false, cleared: false, conflict: false, queued: [] };
  if (existing && remoteState === "rated" && Number(existing.rating) === Number(rating)) {
    return { changed: false, imported: false, cleared: false, conflict: false, queued: [] };
  }

  // A change detected on any connected app becomes canonical and fans out to
  // every other one (maintainer decision, 22 September 2026) unless the local
  // value is genuinely newer. Trakt exposes a real modified-time (see
  // traktClient.js's `ratedAt`), so compare against it. Plex, Emby, and
  // Jellyfin do not (docs/decisions.md): for those the local value is newer
  // exactly when a local edit for this provider has not been delivered yet.
  // Using the scan time as a stand-in timestamp made every local edit made
  // before a scan lose to any older provider value, and the provider then got
  // the stale local write anyway - leaving Plembfin and that provider diverged.
  const remoteTimestamp = Number(remoteChangedAt) || 0;
  const candidateKeys = [existing?.media_key, media.media_key];
  const localIsNewer = Boolean(existing && (remoteTimestamp
    ? currentLocalTimestamp(existing) > remoteTimestamp
    : getOutstandingPersonalRatingIntent(provider, candidateKeys)));
  if (settings.ratingSync.conflictPolicy === "local_wins" && localIsNewer) {
    updateRatingSourceSyncStatus(provider, media.media_key, "conflict", "Local rating retained over an older remote observation");
    const localRating = Number(existing.rating);
    const queued = queuePersonalRatingMutation(remoteMedia, Number.isInteger(localRating) ? localRating : null, {
      config: settings,
      source: "reconcile",
      timestamp: currentLocalTimestamp(existing),
      providers: [provider],
    }).providers;
    return { changed: true, imported: false, cleared: false, conflict: true, queued };
  }

  // The provider's value is now canonical; an older undelivered local intent
  // for that same provider must not be written back over it.
  supersedePersonalRatingIntent(provider, candidateKeys);

  if (remoteState === "rated") {
    upsertCanonicalPersonalRating(remoteMedia, rating, { origin: "reconcile", timestamp: now });
    return {
      changed: true,
      imported: !existing,
      cleared: false,
      conflict: false,
      queued: queueImportedFanout(remoteMedia, rating, provider, settings, now),
    };
  }

  if (!existing) return { changed: true, imported: false, cleared: false, conflict: false, queued: [] };
  db.prepare("DELETE FROM personal_ratings WHERE media_key = ?").run(existing.media_key);
  return {
    changed: true,
    imported: false,
    cleared: true,
    conflict: false,
    queued: queueImportedFanout(remoteMedia, null, provider, settings, now),
  };
}

async function fetchProviderSnapshot(provider, config) {
  const connection = await providerConfig(config, provider);
  if (!connection || (provider !== "trakt" && !providerConfigured({ [provider]: connection }, provider))) {
    const error = new Error(`${provider} is not connected for personal rating sync`);
    error.code = "not_configured";
    throw error;
  }
  return mediaProviderAdapters[provider].snapshot(connection);
}

async function runProviderSnapshot(provider, { config, mode, logger = () => {}, approvedHold = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { provider, status: "skipped", skipped: "authoritative-restore-active" };
  const admission = transaction(() => {
    const previousRun = getPersonalRatingSyncRun(provider);
    const hold = previousRun?.cursor?.ratingHold;
    if (previousRun?.status === "running" && Date.now() - Number(previousRun.started_at) < RUN_STALE_MS) {
      return { skip: { provider, status: "running", cleared: 0 } };
    }
    if (hold && approvedHold !== previousRun.run_id) return { skip: { provider, status: "held", hold, cleared: 0 } };
    const previousRows = listRatingSourceRows(provider);
    const run = startPersonalRatingSyncRun(provider, mode);
    // Keep the warning visible while an approved scan is being revalidated.
    if (hold) updatePersonalRatingSyncRun(provider, { cursor_json: { ratingHold: hold } });
    return { previousRun, previousRows, run };
  });
  if (admission.skip) return admission.skip;
  const { previousRun, previousRows, run } = admission;
  const held = previousRun?.cursor?.ratingHold;
  const now = Date.now();
  let records;
  try {
    records = await fetchProviderSnapshot(provider, config);
    if (!Array.isArray(records)) throw new Error("Rating snapshot must be an array");
  } catch (error) {
    finishPersonalRatingSyncRun(provider, { status: "failed", cursor_json: held ? { ratingHold: held } : null, last_error: safeError(error) });
    throw error;
  }
  if (isAuthoritativeRestoreActive()) {
    finishPersonalRatingSyncRun(provider, { status: "cancelled", last_error: "Authoritative watch-history restore is active" });
    return { provider, status: "skipped", skipped: "authoritative-restore-active" };
  }

  const seenPrevious = new Set();
  let changedCount = 0;
  let importedCount = 0;
  let clearedCount = 0;
  let queuedCount = 0;
  let processingErrors = 0;

  // Review the removal set before changing any observations or their baseline.
  const observed = new Set();
  let preflightErrors = 0;
  for (const record of records) {
    try {
      const media = normalizePersonalRatingMedia(record.media || record);
      const rating = Number(record.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) throw new Error("Invalid rating observation");
      const previous = findPreviousSourceRow(previousRows, media);
      if (previous) observed.add(previous.media_key);
    } catch { preflightErrors += 1; }
  }
  const baseline = previousRows.filter(row => row.remote_state === "rated");
  const missing = baseline.filter(row => !observed.has(row.media_key));
  const removalKeys = missing.map(row => row.media_key).sort();
  const approved = held && approvedHold && JSON.stringify(removalKeys) === JSON.stringify(held.keys);
  if (!preflightErrors && previousRun?.baseline_complete && !approved && missing.length
      && (held || (missing.length >= 2 && missing.length / baseline.length > 0.2))) {
    const hold = { keys: removalKeys, baselineCount: baseline.length, missingCount: missing.length,
      items: missing.map(row => ({ mediaKey: row.media_key, title: row.media?.title || row.media_key })) };
    finishPersonalRatingSyncRun(provider, { status: "partial", scanned_count: records.length,
      cursor_json: { ratingHold: hold }, last_error: `${missing.length} of ${baseline.length} ratings missing; review required` });
    return { provider, status: "held", hold, cleared: 0, complete: false };
  }

  for (const record of Array.isArray(records) ? records : []) {
    if (isAuthoritativeRestoreActive()) {
      finishPersonalRatingSyncRun(provider, { status: "cancelled", last_error: "Authoritative watch-history restore is active" });
      return { provider, status: "skipped", skipped: "authoritative-restore-active" };
    }
    try {
      const rawMedia = normalizePersonalRatingMedia(record.media || record);
      const previous = findPreviousSourceRow(previousRows, rawMedia);
      if (previous) seenPrevious.add(previous.media_key);
      const media = normalizePersonalRatingMedia({
        ...rawMedia,
        media_key: previous?.media_key || rawMedia.media_key,
        provider_item_ids: {
          ...(rawMedia.provider_item_ids || {}),
          [provider]: record.providerItemId || rawMedia.provider_item_ids?.[provider] || "",
        },
      }, { mediaKey: previous?.media_key || rawMedia.media_key });
      const remoteRating = Number(record.rating);
      if (!Number.isInteger(remoteRating) || remoteRating < 1 || remoteRating > 10) throw new Error("Invalid rating observation");
      const observation = {
        provider,
        media,
        providerItemId: record.providerItemId || media.provider_item_ids?.[provider] || null,
        providerIds: record.providerIds || {},
        remoteRating,
        remoteState: "rated",
        remoteRatedAt: record.ratedAt || null,
        generation: run.generation,
        lastSeenAt: now,
        lastInboundAt: isSourceRowSame(previous, "rated", remoteRating) ? null : now,
        syncStatus: "synced",
      };
      const result = transaction(() => {
        const reconciliation = applyRemoteObservation({ provider, media, rating: remoteRating, previous, config, mode, now, remoteChangedAt: observation.remoteRatedAt });
        upsertRatingSourceObservation({ ...observation, syncStatus: reconciliation.conflict ? "conflict" : "synced" });
        if (reconciliation.conflict) updateRatingSourceSyncStatus(provider, media.media_key, "conflict", "Local rating retained over an older remote observation");
        return reconciliation;
      });
      if (result.changed) changedCount += 1;
      if (result.imported) importedCount += 1;
      if (result.cleared) clearedCount += 1;
      queuedCount += result.queued.length;
    } catch (error) {
      processingErrors += 1;
      logger(`[ratings] ${provider}: could not process one remote rating: ${safeError(error)}`);
    }
  }

  // A rated-only provider snapshot represents the complete set of rated
  // records. Missing rows are treated as explicit clears only after a prior
  // complete generation; an interrupted/partial scan never removes a local
  // rating.
  const canUseMissingRows = Boolean(previousRun?.baseline_complete) && processingErrors === 0;
  if (canUseMissingRows) {
    for (const previous of previousRows) {
      if (isAuthoritativeRestoreActive()) {
        finishPersonalRatingSyncRun(provider, { status: "cancelled", last_error: "Authoritative watch-history restore is active" });
        return { provider, status: "skipped", skipped: "authoritative-restore-active" };
      }
      if (previous.remote_state !== "rated" || seenPrevious.has(previous.media_key)) continue;
      try {
        const media = normalizePersonalRatingMedia(previous.media || {}, { mediaKey: previous.media_key });
        const result = transaction(() => {
          const reconciliation = applyRemoteObservation({ provider, media, rating: null, previous, config, mode, now });
          upsertRatingSourceObservation({
            provider,
            media,
            providerItemId: previous.provider_item_id,
            providerIds: previous.provider_ids,
            remoteRating: null,
            remoteState: "unrated",
            remoteRatedAt: null,
            generation: run.generation,
            lastSeenAt: now,
            lastInboundAt: now,
            syncStatus: reconciliation.conflict ? "conflict" : "synced",
          });
          if (reconciliation.conflict) updateRatingSourceSyncStatus(provider, media.media_key, "conflict", "Local rating retained over an older remote clear");
          return reconciliation;
        });
        if (result.changed) changedCount += 1;
        if (result.cleared) clearedCount += 1;
        queuedCount += result.queued.length;
      } catch (error) {
        processingErrors += 1;
        logger(`[ratings] ${provider}: could not process a remote clear: ${safeError(error)}`);
      }
    }
  }

  const complete = processingErrors === 0;
  if (complete) markRatingSourceSnapshotComplete(provider, run.generation, Date.now());
  finishPersonalRatingSyncRun(provider, {
    status: complete ? "succeeded" : "partial",
    scanned_count: Array.isArray(records) ? records.length : 0,
    changed_count: changedCount,
    imported_count: importedCount,
    cleared_count: clearedCount,
    queued_count: queuedCount,
    baseline_complete: complete || previousRun?.baseline_complete ? 1 : 0,
    cursor_json: complete ? null : held ? { ratingHold: held } : null,
    last_error: complete ? null : `${processingErrors} rating observation${processingErrors === 1 ? "" : "s"} could not be processed`,
  });
  return {
    provider,
    status: complete ? "succeeded" : "partial",
    generation: run.generation,
    scanned: Array.isArray(records) ? records.length : 0,
    changed: changedCount,
    imported: importedCount,
    cleared: clearedCount,
    queued: queuedCount,
    complete,
  };
}

async function drainPersonalRatingQueue({ config, providers = RATING_SYNC_PROVIDERS, limit = MAX_QUEUE_BATCH, logger = () => {} } = {}) {
  const settings = configForRating(config);
  if (isAuthoritativeRestoreActive()) return { processed: 0, succeeded: 0, failed: 0, notFound: 0, reauthRequired: 0, skipped: "authoritative-restore-active" };
  if (!settings.ratingSync.enabled) return { processed: 0, succeeded: 0, failed: 0, notFound: 0, reauthRequired: 0, skipped: "disabled" };
  const owner = `ratings:${process.pid}:${crypto.randomUUID()}`;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let notFound = 0;
  let reauthRequired = 0;
  for (const provider of normalizeProviders(providers)) {
    if (isAuthoritativeRestoreActive()) return { processed, succeeded, failed, notFound, reauthRequired, skipped: "authoritative-restore-active" };
    if (!directionAllows(settings.ratingSync.providers[provider], "send")) continue;
    const claimed = claimPersonalRatingQueue({ provider, limit, owner, leaseMs: QUEUE_LEASE_MS });
    for (const item of claimed.rows) {
      if (isAuthoritativeRestoreActive()) return { processed, succeeded, failed, notFound, reauthRequired, skipped: "authoritative-restore-active" };
      processed += 1;
      try {
        const connection = await providerConfig(settings, provider);
        if (!connection || (provider !== "trakt" && !providerConfigured({ [provider]: connection }, provider))) {
          const error = new Error(`${provider} is not connected`);
          error.code = "not_configured";
          throw error;
        }
        const media = provider === "trakt"
          ? enrichTraktEpisodeMedia(normalizePersonalRatingMedia(item.media, { mediaKey: item.media_key }), item.media_key)
          : normalizePersonalRatingMedia(item.media, { mediaKey: item.media_key });
        media.provider_item_ids = item.media.provider_item_ids || {};
        const result = item.desired_state === "rated"
          ? await mediaProviderAdapters[provider].write(connection, media, item.desired_rating, { lane: "sync" })
          : await mediaProviderAdapters[provider].clear(connection, media, { lane: "sync" });
        if (result?.status === "not_found") {
          failPersonalRatingQueue({ provider, mediaKey: item.media_key, intentId: item.intent_id, status: "not_found", error: "No matching item was found on the provider" });
          notFound += 1;
          logger(`[ratings] ${provider}: ${item.media.title || item.media_key} -> not_found: No matching item was found on the provider`);
          continue;
        }
        const acknowledged = acknowledgePersonalRatingQueue({
          provider,
          mediaKey: item.media_key,
          media,
          intentId: item.intent_id,
          desiredState: item.desired_state,
          desiredRating: item.desired_rating,
        });
        if (acknowledged) succeeded += 1;
      } catch (error) {
        const status = isUnauthorized(error) ? "reauth_required" : isNotFound(error) ? "not_found" : "failed";
        if (status === "reauth_required") reauthRequired += 1;
        else if (status === "not_found") notFound += 1;
        else failed += 1;
        const retryAt = Date.now() + retryDelay(item.attempt_count, error);
        failPersonalRatingQueue({
          provider,
          mediaKey: item.media_key,
          intentId: item.intent_id,
          status,
          error: safeError(error),
          nextAttemptAt: retryAt,
        });
        logger(`[ratings] ${provider}: ${item.media.title || item.media_key} -> ${status}: ${safeError(error)}`);
      }
    }
  }
  return { processed, succeeded, failed, notFound, reauthRequired };
}

function snapshotModeFor(provider, config, explicitMode = "") {
  if (explicitMode === "baseline" || explicitMode === "import") return explicitMode;
  const run = getPersonalRatingSyncRun(provider);
  return run?.baseline_complete ? "import" : config.ratingSync.initialSyncMode;
}

export async function runRatingSync({ providers = [], mode = "", snapshot = true, drain = true, logger = () => {}, config = null, approvedHold = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { ok: true, status: "skipped", reason: "authoritative-restore-active", providers: [], queue: ratingQueueCounts() };
  if (activeSyncPromise) return activeSyncPromise;
  activeSyncPromise = (async () => {
    const settings = configForRating(config || await loadMediaConfig());
    if (!settings.ratingSync.enabled) {
      return { ok: true, status: "disabled", providers: [], queue: ratingQueueCounts() };
    }
    const targets = normalizeProviders(providers);
    const results = [];
    for (const provider of targets) {
      const direction = settings.ratingSync.providers[provider];
      if (snapshot && directionAllows(direction, "receive")) {
        try {
          results.push(await runProviderSnapshot(provider, { config: settings, mode: snapshotModeFor(provider, settings, mode), logger, approvedHold }));
        } catch (error) {
          results.push({ provider, status: isUnauthorized(error) ? "reauth_required" : "failed", error: safeError(error) });
        }
      } else {
        results.push({ provider, status: directionAllows(direction, "send") ? "queue_only" : "disabled" });
      }
    }
    const queueResult = drain ? await drainPersonalRatingQueue({ config: settings, providers: targets, logger }) : null;
    bumpDataVersion();
    writeAuditLog("rating-sync.run", { detail: { providers: targets, results: results.map(({ provider, status }) => ({ provider, status })), queue: queueResult } });
    const queue = queueResult || ratingQueueCounts();
    const status = results.some((result) => ["running", "held", "failed", "partial", "reauth_required", "not_found"].includes(result.status)) || ratingSyncHasIssues(queue)
      ? "partial"
      : "completed";
    return { ok: true, status, providers: results, queue };
  })().finally(() => { activeSyncPromise = null; });
  return activeSyncPromise;
}

export async function resolveRatingScanHold({ provider, runId, decision, config = null, logger = () => {} } = {}) {
  if (!["approve", "dismiss"].includes(decision)) throw Object.assign(new Error("Choose approve or dismiss"), { status: 400 });
  if (activeSyncPromise || isAuthoritativeRestoreActive()) throw Object.assign(new Error("Rating sync or restore is active; try again"), { status: 409 });
  const run = transaction(() => {
    const current = getPersonalRatingSyncRun(provider);
    if (!current?.cursor?.ratingHold || current.run_id !== runId || (current.status === "running" && Date.now() - Number(current.started_at) < RUN_STALE_MS)) {
      throw Object.assign(new Error("Held scan changed or is running; refresh before reviewing"), { status: 409 });
    }
    if (decision === "dismiss") finishPersonalRatingSyncRun(provider, { status: "partial", cursor_json: null, last_error: "Held scan dismissed; ratings kept" });
    return current;
  });
  if (decision === "dismiss") {
    writeAuditLog("rating-sync.hold-dismissed", { detail: { provider, runId } });
    return { ok: true, status: "dismissed", ratingsKept: true };
  }
  const settings = configForRating(config || await loadMediaConfig());
  if (activeSyncPromise || isAuthoritativeRestoreActive() || getPersonalRatingSyncRun(provider)?.run_id !== run.run_id) {
    throw Object.assign(new Error("Held scan changed or rating sync is active; refresh before reviewing"), { status: 409 });
  }
  if (!settings.ratingSync.enabled || !directionAllows(settings.ratingSync.providers[provider], "receive")) {
    throw Object.assign(new Error("Enable rating sync before approving a held scan"), { status: 409 });
  }
  writeAuditLog("rating-sync.hold-approved", { detail: { provider, runId } });
  return runRatingSync({ providers: [provider], config: settings, drain: false, logger, approvedHold: runId });
}

export async function pushPersonalRatings({ providers = [], items = [], logger = () => {}, config = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { ok: true, status: "skipped", reason: "authoritative-restore-active", queued: 0, queue: ratingQueueCounts() };
  const settings = configForRating(config || await loadMediaConfig());
  if (!settings.ratingSync.enabled) return { ok: true, status: "disabled", queued: 0, queue: ratingQueueCounts() };
  const targets = normalizeProviders(providers);
  const canonicalItems = Array.isArray(items) && items.length
    ? items
      .map((item) => findCanonicalPersonalRating(item))
      .filter(Boolean)
      .map((row) => canonicalMediaFromRow(row))
    : listCanonicalPersonalRatings().map((row) => canonicalMediaFromRow(row));
  let queued = 0;
  transaction(() => {
    for (const media of canonicalItems) {
      for (const provider of targets) {
        if (!directionAllows(settings.ratingSync.providers[provider], "send")) continue;
        ensureRatingSourceRow(provider, media, { now: Date.now() });
        const canonical = getCanonicalPersonalRating(media.media_key);
        if (!canonical) continue;
        enqueuePersonalRatingMutation({
          provider,
          media,
          desiredState: "rated",
          desiredRating: Number(canonical.rating),
          source: "push",
          canonicalVersion: Date.now(),
        });
        queued += 1;
      }
    }
  });
  const queue = await drainPersonalRatingQueue({ config: settings, providers: targets, logger });
  bumpDataVersion();
  writeAuditLog("rating-sync.push", { detail: { providers: targets, queued, items: canonicalItems.length } });
  return { ok: true, status: ratingSyncHasIssues(queue) ? "partial" : "completed", queued, items: canonicalItems.length, queue, counts: ratingQueueCounts() };
}

export async function retryRatingSync({ providers = [], drain = true, logger = () => {}, config = null } = {}) {
  if (isAuthoritativeRestoreActive()) return { ok: true, status: "skipped", reason: "authoritative-restore-active", retried: 0, queue: ratingQueueCounts() };
  const targets = normalizeProviders(providers);
  const retried = retryPersonalRatingQueue({ provider: targets.length === 1 ? targets[0] : "" });
  const settings = configForRating(config || await loadMediaConfig());
  const queue = drain ? await drainPersonalRatingQueue({ config: settings, providers: targets, logger }) : null;
  const resultQueue = queue || ratingQueueCounts();
  return { ok: true, status: ratingSyncHasIssues(resultQueue) ? "partial" : "completed", retried, queue: resultQueue };
}

export async function getRatingSyncStatus({ config = null } = {}) {
  const settings = configForRating(config || await loadMediaConfig({ resolveConnections: false }));
  const providers = RATING_SYNC_PROVIDERS.map((provider) => ({
    provider,
    direction: settings.ratingSync.providers[provider],
    configured: providerConfigured(settings, provider),
    connectionStatus: providerConnectionStatus(settings, provider),
    queue: ratingQueueCounts(provider),
    run: getPersonalRatingSyncRun(provider),
  }));
  const queue = personalRatingRepositoryStatus().queue;
  const running = providers.some((entry) => entry.run?.status === "running" && Date.now() - Number(entry.run.started_at || 0) < RUN_STALE_MS);
  return {
    ok: true,
    isolatedFromWatchedSync: true,
    config: settings.ratingSync,
    providers,
    queue,
    canonicalCount: personalRatingRepositoryStatus().canonicalCount,
    running,
    lastUpdatedAt: Date.now(),
  };
}

export async function runRatingSyncScheduler({ logger = () => {} } = {}) {
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  const config = await loadMediaConfig();
  if (!config.ratingSync?.enabled) return { skipped: true, reason: "disabled" };
  const providers = RATING_SYNC_PROVIDERS.filter((provider) => (
    config.ratingSync.providers[provider] !== "off" && providerConfigured(config, provider)
  ));
  if (!providers.length) return { skipped: true, reason: "no-providers" };
  const status = await getRatingSyncStatus({ config });
  const dueAt = providers.some((provider) => {
    const run = status.providers.find((entry) => entry.provider === provider)?.run;
    return !run?.completed_at || Date.now() - Number(run.completed_at) >= Number(config.ratingSync.intervalMinutes || 15) * 60_000;
  });
  if (!dueAt) return { skipped: true, reason: "not-due" };
  return runRatingSync({ providers, config, logger });
}

export function ratingSyncIsRunning() {
  return Boolean(activeSyncPromise);
}
