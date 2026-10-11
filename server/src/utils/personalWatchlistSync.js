import crypto from "node:crypto";
import { isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js";
import { getMediaConnection } from "./mediaConnectionRepo.js";
import { brandEnv } from "./brandEnv.js";
import * as plexAdapter from "./plexWatchlistClient.js";
import {
  WATCHLIST_PROVIDERS,
  applyWatchlistMutation,
  beginWatchlistSyncRun,
  enabledWatchlistProviderScopes,
  watchlistProviderScopes,
  failWatchlistQueue,
  getLatestWatchlistMutation,
  getWatchlistQueueRow,
  getWatchlistSyncRun,
  getWatchlistRevision,
  listCanonicalWatchlist,
  listWatchlistProviderItems,
  markWatchlistProviderOutbound,
  recordProviderWatchlistRemoval,
  recordWatchlistActivity,
  reconcileWatchlistQueueForConfig,
  queueWatchlistMutationForProvider,
  acknowledgeWatchlistQueue,
  claimWatchlistQueue,
  releaseWatchlistQueue,
  updateWatchlistSyncRun,
  upsertProviderWatchlistItem,
  watchlistQueueCounts,
  watchlistQueueIssues,
  listWatchlistSyncRuns,
  watchlistProviderScope,
  retryWatchlistQueue,
  clearWatchlistRemoteProjection,
  getWatchlistRestoreState,
  clearWatchlistRestorePending,
} from "./personalWatchlistRepository.js";
import { personalWatchlistMediaAliases, normalizePersonalWatchlistMedia } from "./personalWatchlistIdentity.js";

const ADAPTERS = { plex: plexAdapter };
const SNAPSHOT_FUNCTIONS = { plex: plexAdapter.fetchPlexWatchlistSnapshot };
const WORKER_OWNER = `${brandEnv("INSTANCE_ID") || process.pid}:watchlist:${crypto.randomUUID()}`;
const DEFAULT_BUDGET_MS = 45_000;

function clean(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function nowValue(value = Date.now()) { return Number.isFinite(Number(value)) ? Number(value) : Date.now(); }
function providerSetting(config, provider) { return config?.watchlistSync?.providers?.[provider] || {}; }
function effectiveProviderConfig(scope, config) {
  const setting = scope.setting || providerSetting(config, scope.provider);
  const connection = getMediaConnection(scope.provider, { includeCredential: true });
  const configured = config?.[scope.provider] || {};
  const resolved = {
    ...configured,
    connectionId: scope.connectionId,
    remoteScopeKey: scope.remoteScopeKey,
    remoteUserId: configured.remoteUserId || connection?.remoteUserId || configured.userId || "",
    userId: configured.userId || connection?.remoteUserId || "",
    watchlistRepresentation: scope.representation,
    representation: scope.representation,
    watchlistWriteEnabled: scope.provider === "plex" ? Boolean(setting.writeEnabled) : true,
    writeEnabled: scope.provider === "plex" ? Boolean(setting.writeEnabled) : true,
  };
  // Resolved connections are the preferred source for secrets. Keep this
  // object private to the worker; it never crosses an API response.
  if (connection) {
    if (scope.provider === "plex") {
      resolved.accountToken = connection.authKind?.includes("plex_jwt") ? "" : connection.credential;
      resolved.authKind = connection.authKind;
      resolved.baseUrl = resolved.baseUrl || connection.baseUrl;
      resolved.serverId = resolved.serverId || connection.serverId;
      resolved.clientIdentifier = resolved.clientIdentifier || connection.deviceIdentifier;
    } else {
      resolved.apiKey = connection.credential || resolved.apiKey;
      resolved.baseUrl = resolved.baseUrl || connection.baseUrl;
      resolved.serverId = resolved.serverId || connection.serverId;
      resolved.userId = resolved.userId || connection.remoteUserId;
    }
  }
  return resolved;
}

function adapterFor(provider) { return ADAPTERS[provider]; }

function capabilityFor(scope, config) {
  const adapter = adapterFor(scope.provider);
  const providerConfig = effectiveProviderConfig(scope, config);
  const capability = adapter.capabilities(providerConfig);
  return { ...capability, providerConfig };
}

function queueStatusForError(error) {
  const status = Number(error?.status || 0);
  if ([401, 403].includes(status)) return "reauth_required";
  if ([404, 410, 422].includes(status) || error?.code === "WATCHLIST_NOT_AVAILABLE") return "not_available";
  return "failed";
}

function retryAtForError(error, now = Date.now()) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return now + Math.min(6 * 60 * 60 * 1000, retryAfter * 1000);
  return null;
}

function aliasMap(canonical) {
  const map = new Map();
  for (const media of canonical) for (const alias of personalWatchlistMediaAliases(media)) if (!map.has(alias)) map.set(alias, media);
  return map;
}

function matchingCanonical(remote, map) {
  let normalized;
  try { normalized = normalizePersonalWatchlistMedia(remote); } catch { return null; }
  for (const alias of personalWatchlistMediaAliases(normalized)) {
    const match = map.get(alias);
    if (match) return match;
  }
  return null;
}

function remoteMedia(remote) {
  try { return normalizePersonalWatchlistMedia(remote); } catch { return null; }
}

function snapshotHash(items = []) {
  const stable = items.map((item) => `${item.provider_item_id || ""}:${item.media_key || ""}`).sort().join("|");
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) hash = Math.imul(hash ^ stable.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

async function fetchSnapshot(scope, config) {
  const providerConfig = effectiveProviderConfig(scope, config);
  const fetcher = SNAPSHOT_FUNCTIONS[scope.provider];
  if (!fetcher) throw new Error(`No watchlist adapter for ${scope.provider}`);
  return fetcher(providerConfig);
}

function previousRemoteRows(scope) {
  return listWatchlistProviderItems({
    provider: scope.provider,
    connectionId: scope.connectionId,
    remoteScopeKey: scope.remoteScopeKey,
    representation: scope.representation,
  });
}

async function recordProviderSnapshot(scope, config, run, snapshot, { destructive = false, previousRun = null } = {}) {
  const canonical = listCanonicalWatchlist();
  const aliases = aliasMap(canonical);
  const previousRows = previousRemoteRows(scope);
  const seenProviderItems = new Set();
  const seenCanonicalKeys = new Set();
  let presentCount = 0;
  let addedCount = 0;

  for (const item of snapshot.items || []) {
    const normalizedRemote = remoteMedia(item);
    if (!normalizedRemote) continue;
    let canonicalMedia = matchingCanonical(normalizedRemote, aliases);
    let media = canonicalMedia || normalizedRemote;
    const existing = canonicalMedia
      ? previousRows.find((row) => row.media_key === canonicalMedia.media_key)
      : null;
    const isFavorites = scope.representation === "favorites";
    let managed = isFavorites ? Boolean(existing?.managed_by_plembfin) : item.managed !== false;
    const providerItemId = clean(item.provider_item_id || item.providerItemId || item.rating_key || item.id, 300);
    const providerIds = {
      ...(item.provider_ids || item.providerIds || {}),
      ...(item.playlist_entry_id ? { playlist_entry_id: item.playlist_entry_id } : {}),
    };
    if (providerItemId) seenProviderItems.add(providerItemId);
    if (canonicalMedia) seenCanonicalKeys.add(canonicalMedia.media_key);
    if (!canonicalMedia) {
      const latest = getLatestWatchlistMutation(media.media_key);
      const newerLocalRemoval = latest?.desired_state === "absent"
        && latest.canonical_revision > Number(previousRun?.canonical_revision || 0);
      if (!newerLocalRemoval) {
        const addition = applyWatchlistMutation(media, "present", {
          config,
          origin: scope.provider,
          reason: "provider_added",
          eventFingerprint: `snapshot:${run.run_id}:present:${providerItemId || media.media_key}`,
          eventAt: item.added_at || item.addedAt || item.updated_at || item.updatedAt || Date.now(),
          timestamp: Date.now(),
          guardStale: true,
        });
        if (!addition.stale && !addition.duplicate) {
          addedCount += 1;
          canonicalMedia = addition.media;
          media = addition.media;
          managed = true;
          seenCanonicalKeys.add(media.media_key);
          for (const alias of personalWatchlistMediaAliases(media)) aliases.set(alias, media);
        }
      }
    }
    upsertProviderWatchlistItem({
      provider: scope.provider,
      connectionId: scope.connectionId,
      remoteScopeKey: scope.remoteScopeKey,
      representation: scope.representation,
      media,
      providerItemId,
      providerIds,
      remoteState: managed ? "present" : "unmanaged",
      managedByPlembfin: managed,
      primaryTarget: true,
      containerId: item.container_id || item.containerId || snapshot.container?.id || "",
      containerName: item.container_name || item.containerName || snapshot.container?.name || "",
      generation: run.generation,
      syncStatus: managed ? "synced" : "needs_review",
    });
    presentCount += 1;
  }

  let removedCount = 0;
  // Absence has meaning only after an earlier complete snapshot. An in-flight,
  // truncated, unauthorized, or empty-after-error response never reaches this
  // branch because fetchSnapshot must resolve with complete=true first.
  // Inert while Plex is the only provider - the account watchlist has no
  // container, so both sides of this comparison are always empty. It is kept
  // because it encodes an invariant that a container-backed provider would
  // need again, and because getting it wrong once deleted real entries:
  //
  // An item is only "missing" relative to the container it was recorded in.
  // When the managed container changes identity - it was deleted and recreated,
  // or a broken create left the ledger pointing at an id that no longer exists -
  // every previously present row is absent from the new container without the
  // user having removed anything. Comparing across that boundary once deleted a
  // real watchlist entry from the canonical list and fanned the deletion out to
  // every other provider, which is exactly what this whole snapshot path exists
  // to prevent. Absence is therefore only evidence of removal within the same
  // container; a container change means republish, not delete.
  const scannedContainerId = clean(snapshot.container?.id || "", 300);
  if (previousRun?.complete_snapshot && previousRun.status === "succeeded") {
    for (const row of previousRows.filter((candidate) => candidate.remote_state === "present" && candidate.managed_by_plembfin && candidate.provider_item_id)) {
      if (seenProviderItems.has(row.provider_item_id)) continue;
      if (clean(row.container_id || "", 300) !== scannedContainerId) continue;
      const latest = getLatestWatchlistMutation(row.media_key);
      if (latest?.desired_state === "present" && latest.canonical_revision > Number(previousRun.canonical_revision || 0)) continue;
      const removal = recordProviderWatchlistRemoval(row.media, {
        provider: scope.provider,
        config,
        connectionId: scope.connectionId,
        remoteScopeKey: scope.remoteScopeKey,
        representation: scope.representation,
        eventFingerprint: `snapshot:${run.run_id}:${row.provider_item_id}`,
        reason: "provider_removed",
        eventAt: Date.now(),
      });
      if (removal.removed) removedCount += 1;
      // Keep the missing observation in the provider ledger. This prevents a
      // later complete snapshot from repeatedly treating the same already
      // absent item as a fresh removal event, while retaining the provider
      // target needed for an explicit local re-add.
      if (!removal.stale) upsertProviderWatchlistItem({
        provider: scope.provider,
        connectionId: scope.connectionId,
        remoteScopeKey: scope.remoteScopeKey,
        representation: scope.representation,
        media: row.media,
        providerItemId: row.provider_item_id,
        providerIds: row.provider_ids || {},
        remoteState: "absent",
        managedByPlembfin: row.managed_by_plembfin,
        primaryTarget: row.primary_target,
        containerId: row.container_id,
        containerName: row.container_name,
        generation: run.generation,
        syncStatus: "synced",
      });
    }
  }

  const complete = updateWatchlistSyncRun({
    ...scope,
    status: "succeeded",
    completedAt: Date.now(),
    scannedCount: presentCount,
    presentCount,
    removedCount,
    unavailableCount: 0,
    completeSnapshot: true,
    snapshotHash: snapshotHash(snapshot.items || []),
    cursor: null,
  });
  return { run: complete, scannedCount: presentCount, presentCount, addedCount, removedCount, queuedExtras: 0, seenCanonicalKeys };
}

async function runProviderSnapshot(scope, config, { mode = "reconcile", destructive = false } = {}) {
  const previousRun = getWatchlistSyncRun(scope);
  const run = beginWatchlistSyncRun({ ...scope, mode, canonicalRevision: getWatchlistRevision() });
  try {
    const capability = capabilityFor(scope, config);
    if (!capability.read) {
      const error = new Error(capability.reason || "Provider watchlist is not readable");
      error.status = 424;
      throw error;
    }
    const snapshot = await fetchSnapshot(scope, config);
    if (!snapshot?.complete) {
      const error = new Error("Provider returned an incomplete watchlist snapshot");
      error.code = "WATCHLIST_INCOMPLETE_SNAPSHOT";
      throw error;
    }
    return await recordProviderSnapshot(scope, config, run, snapshot, { destructive, previousRun });
  } catch (error) {
    const failed = updateWatchlistSyncRun({ ...scope, status: "failed", completedAt: null, completeSnapshot: false, lastError: redactError(error) });
    recordWatchlistActivity({ provider: scope.provider, connectionId: scope.connectionId, remoteScopeKey: scope.remoteScopeKey, representation: scope.representation, action: "snapshot", origin: "reconcile", reason: mode, status: "failed", details: redactError(error) });
    return { run: failed, error, scannedCount: 0, presentCount: 0, removedCount: 0, queuedExtras: 0 };
  }
}

function redactError(error) {
  return clean(error?.message || error || "Unknown provider watchlist error", 1000)
    .replace(/([?&](?:token|api[_-]?key|apikey|password|secret|authorization)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b(?:bearer|token|api[_-]?key|apikey|password|secret)([=: ]+)[^\s,;]+/gi, "$1<redacted>");
}

function scopeFromQueueRow(row, config) {
  return {
    provider: row.provider,
    connectionId: row.connection_id,
    remoteScopeKey: row.remote_scope_key,
    representation: row.representation,
    setting: providerSetting(config, row.provider),
  };
}

async function processQueueRow(row, config) {
  if (isAuthoritativeRestoreActive()) return { status: "paused" };
  const scope = scopeFromQueueRow(row, config);
  const adapter = adapterFor(scope.provider);
  const providerConfig = effectiveProviderConfig(scope, config);
  const capability = adapter?.capabilities(providerConfig);
  const canWrite = row.desired_state === "present" ? capability?.add : capability?.remove;
  if (!adapter || !canWrite) {
    failWatchlistQueue({
      ...scope,
      mediaKey: row.media_key,
      intentId: row.intent_id,
      status: capability?.capability === "unavailable" ? "reauth_required" : "failed",
      error: capability?.reason || "Provider watchlist writes are not available.",
    });
    return { status: "blocked" };
  }

  try {
    if (row.desired_state === "present") {
      const alreadyPresent = listWatchlistProviderItems({
        provider: scope.provider,
        connectionId: scope.connectionId,
        remoteScopeKey: scope.remoteScopeKey,
        representation: scope.representation,
        mediaKey: row.media_key,
      }).find((item) => item.managed_by_plembfin && item.remote_state === "present" && item.provider_item_id);
      if (alreadyPresent) {
        acknowledgeWatchlistQueue({
          ...scope,
          mediaKey: row.media_key,
          intentId: row.intent_id,
          desiredState: "present",
          details: "Provider watchlist item was already present; no duplicate was added.",
        });
        return { status: "succeeded", alreadyPresent: true };
      }
      const resolved = await adapter.resolveTargets(providerConfig, row.media);
      if (resolved.ambiguous || resolved.unavailable || !resolved.primaryTarget) {
        upsertProviderWatchlistItem({
          ...scope,
          media: row.media,
          providerItemId: "",
          providerIds: {},
          remoteState: "unavailable",
          managedByPlembfin: true,
          syncStatus: "not_available",
          lastError: resolved.reason || "Provider item is not available.",
        });
        failWatchlistQueue({ ...scope, mediaKey: row.media_key, intentId: row.intent_id, status: "not_available", error: resolved.reason || "Provider item is not available." });
        return { status: "not_available" };
      }
      if (isAuthoritativeRestoreActive()) return { status: "paused" };
      const added = await adapter.add(providerConfig, { target: resolved.primaryTarget });
      upsertProviderWatchlistItem({
        ...scope,
        media: row.media,
        providerItemId: added.id || resolved.primaryTarget.id,
        providerIds: resolved.primaryTarget.providerIds || {},
        remoteState: "present",
        managedByPlembfin: true,
        primaryTarget: true,
        containerId: added.container?.id || "",
        containerName: added.container?.name || "",
        syncStatus: "synced",
      });
      acknowledgeWatchlistQueue({ ...scope, mediaKey: row.media_key, intentId: row.intent_id, desiredState: "present", details: "Provider watchlist item added." });
      return { status: "succeeded" };
    }

    // Only owned provider rows may be removed. This is the ownership guard
    // that keeps unrelated Emby/Jellyfin favorites outside Plembfin's scope.
    const ledgerRows = listWatchlistProviderItems({
      provider: scope.provider,
      connectionId: scope.connectionId,
      remoteScopeKey: scope.remoteScopeKey,
      representation: scope.representation,
      mediaKey: row.media_key,
    }).filter(
      (item) =>
        item.managed_by_plembfin &&
        item.provider_item_id &&
        item.remote_state === "present",
    );
    for (const ledger of ledgerRows) {
      if (isAuthoritativeRestoreActive()) return { status: "paused" };
      await adapter.remove(providerConfig, {
        target: {
          id: ledger.provider_item_id,
          provider_item_id: ledger.provider_item_id,
          playlist_entry_id: ledger.provider_ids?.playlist_entry_id || ledger.provider_item_id,
        },
        container: ledger.container_id ? { id: ledger.container_id, name: ledger.container_name } : null,
      });
    }
    acknowledgeWatchlistQueue({ ...scope, mediaKey: row.media_key, intentId: row.intent_id, desiredState: "absent", details: ledgerRows.length ? "Owned provider watchlist item removed." : "No owned provider item remained; removal is already satisfied." });
    return { status: "succeeded" };
  } catch (error) {
    const status = queueStatusForError(error);
    failWatchlistQueue({ ...scope, mediaKey: row.media_key, intentId: row.intent_id, status, error, retryAt: retryAtForError(error) });
    return { status };
  }
}

export async function processWatchlistQueue({ config = null, provider = "", limit = 25, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  if (isAuthoritativeRestoreActive()) return { claimed: 0, counts: {}, skipped: "authoritative-restore-active" };
  const effectiveConfig = config || await loadMediaConfig();
  const allowedScopes = watchlistProviderScopes(effectiveConfig)
    .filter((scope) => !provider || scope.provider === provider);
  if (!allowedScopes.length) return { claimed: 0, counts: {}, skipped: "no-enabled-provider" };
  const allowedKeys = new Set(allowedScopes.map((scope) => `${scope.provider}:${scope.connectionId}:${scope.remoteScopeKey}:${scope.representation}`));
  const startedAt = Date.now();
  const claimed = claimWatchlistQueue({ provider, owner: WORKER_OWNER, limit });
  const counts = {};
  for (const row of claimed.rows) {
    if (isAuthoritativeRestoreActive()) break;
    if (Date.now() - startedAt >= budgetMs) break;
    const key = `${row.provider}:${row.connection_id}:${row.remote_scope_key}:${row.representation}`;
    if (!allowedKeys.has(key)) {
      releaseWatchlistQueue(row);
      counts.skipped = (counts.skipped || 0) + 1;
      continue;
    }
    const result = await processQueueRow(row, effectiveConfig);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return { claimed: claimed.rows.length, counts };
}

function scopesForRequest(config, providers = [], { publishedOnly = false } = {}) {
  const requested = new Set((Array.isArray(providers) ? providers : [providers]).map((value) => clean(value, 30).toLowerCase()).filter(Boolean));
  return watchlistProviderScopes(config, { publishedOnly }).filter((scope) => !requested.size || requested.has(scope.provider));
}

function publicCapability(scope, config) {
  const capability = capabilityFor(scope, config);
  const connection = getMediaConnection(scope.provider);
  return {
    provider: scope.provider,
    enabled: true,
    representation: scope.representation,
    capability: capability.capability,
    configured: Boolean(capability.configured),
    read: Boolean(capability.read),
    add: Boolean(capability.add),
    remove: Boolean(capability.remove),
    reason: capability.reason || "",
    connection: connection ? {
      id: connection.id,
      serverName: connection.serverName,
      remoteUserId: connection.remoteUserId,
      remoteUsername: connection.remoteUsername,
      status: connection.status,
      lastValidatedAt: connection.lastValidatedAt,
    } : null,
  };
}

export function getWatchlistSyncStatus(config = {}) {
  const normalized = config.watchlistSync || {};
  const providers = WATCHLIST_PROVIDERS.map((provider) => {
    const setting = providerSetting(config, provider);
    const scope = { ...watchlistProviderScope(provider, config, setting), setting };
    const capability = publicCapability(scope, config);
    const run = getWatchlistSyncRun(scope);
    const items = listWatchlistProviderItems(scope);
    const queue = watchlistQueueCounts({ provider });
    return {
      ...capability,
      enabled: Boolean(setting.enabled),
      publishConfirmedAt: Number(setting.publishConfirmedAt || 0),
      awaitingPublish: false,
      queue,
      pending: Number(queue.pending || 0) + Number(queue.processing || 0),
      unavailable: items.filter((item) => item.remote_state === "unavailable" || item.sync_status === "not_available").length,
      issues: watchlistQueueIssues({ provider }),
      lastRun: run,
    };
  });
  return {
    enabled: Boolean(normalized.enabled),
    restorePending: getWatchlistRestoreState().pending,
    intervalMinutes: Number(normalized.intervalMinutes || 5),
    importRemoteAdditions: Boolean(normalized.importRemoteAdditions),
    revision: getWatchlistRevision(),
    canonicalCount: listCanonicalWatchlist().length,
    queue: watchlistQueueCounts(),
    issues: watchlistQueueIssues(),
    providers,
    runs: listWatchlistSyncRuns(),
  };
}

export async function previewWatchlistSync({ config = null, providers = [] } = {}) {
  const effectiveConfig = config || await loadMediaConfig();
  const canonical = listCanonicalWatchlist();
  const aliases = aliasMap(canonical);
  const results = [];
  for (const scope of scopesForRequest(effectiveConfig, providers)) {
    const capability = publicCapability(scope, effectiveConfig);
    const result = { ...capability, localMissing: [], remoteAdditions: [], snapshot: null };
    if (!capability.read) {
      result.error = capability.reason || "Provider watchlist is not readable.";
      results.push(result);
      continue;
    }
    try {
      const snapshot = await fetchSnapshot(scope, effectiveConfig);
      const matched = new Set();
      for (const remote of snapshot.items || []) {
        const normalizedRemote = remoteMedia(remote);
        if (!normalizedRemote) continue;
        const local = matchingCanonical(normalizedRemote, aliases);
        if (local) matched.add(local.media_key);
        else if (remote.managed !== false || scope.representation === "playlist") {
          result.remoteAdditions.push({ media: normalizedRemote, managed: remote.managed !== false, providerItemId: remote.provider_item_id || "" });
        }
      }
      for (const media of canonical) {
        if (matched.has(media.media_key)) continue;
        let resolution = null;
        try { resolution = await adapterFor(scope.provider).resolveTargets(effectiveProviderConfig(scope, effectiveConfig), media); } catch (error) { resolution = { unavailable: true, reason: redactError(error) }; }
        result.localMissing.push({ media, available: Boolean(resolution?.primaryTarget), ambiguous: Boolean(resolution?.ambiguous), reason: resolution?.reason || "Provider has not confirmed this item." });
      }
      result.snapshot = { count: (snapshot.items || []).length, complete: Boolean(snapshot.complete) };
    } catch (error) {
      result.error = redactError(error);
    }
    results.push(result);
  }
  return { canonicalCount: canonical.length, providers: results, generatedAt: Date.now() };
}

export async function runWatchlistSync({ mode = "reconcile", confirm = false, providers = [], config = null, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  if (isAuthoritativeRestoreActive()) return { ok: true, skipped: true, reason: "authoritative-restore-active", mode, results: [], elapsedMs: 0 };
  const normalizedMode = mode === "publish" ? "publish" : mode === "retry" ? "retry" : "reconcile";
  const effectiveConfig = config || await loadMediaConfig();
  const restorePending = getWatchlistRestoreState().pending;
  // A restored canonical list performs the same non-destructive union as a
  // first activation. Clearing stale observations prevents an old absence
  // from being mistaken for a new provider removal.
  if (restorePending) clearWatchlistRemoteProjection();
  const startedAt = Date.now();
  const results = [];
  if (normalizedMode === "retry") retryWatchlistQueue({ timestamp: startedAt });
  else reconcileWatchlistQueueForConfig(effectiveConfig, { timestamp: startedAt });
  for (const scope of scopesForRequest(effectiveConfig, providers)) {
    if (Date.now() - startedAt >= budgetMs) break;
    const capability = capabilityFor(scope, effectiveConfig);
    if (!capability.read || !capability.add || !capability.remove) {
      const reason = capability.reason || "This provider representation cannot publish watchlist changes.";
      recordWatchlistActivity({
        provider: scope.provider,
        connectionId: scope.connectionId,
        remoteScopeKey: scope.remoteScopeKey,
        representation: scope.representation,
        action: "sync",
        origin: "system",
        reason: "capability",
        status: "not_available",
        details: reason,
      });
      results.push({
        provider: scope.provider,
        representation: scope.representation,
        snapshot: { status: "blocked", scanned: 0, removed: 0, queuedExtras: 0, error: reason },
        processed: { claimed: 0, counts: { not_available: 0 }, skipped: "capability" },
      });
      continue;
    }
    let snapshotResult = null;
    if (normalizedMode !== "retry") {
      snapshotResult = await runProviderSnapshot(scope, effectiveConfig, { mode: "reconcile", destructive: false });
    }
    const processed = await processWatchlistQueue({ config: effectiveConfig, provider: scope.provider, limit: 50, budgetMs: Math.max(1000, budgetMs - (Date.now() - startedAt)) });
    results.push({ provider: scope.provider, representation: scope.representation, snapshot: snapshotResult ? { status: snapshotResult.run?.status || "failed", scanned: snapshotResult.scannedCount, added: snapshotResult.addedCount, removed: snapshotResult.removedCount, error: snapshotResult.error ? redactError(snapshotResult.error) : "" } : null, processed });
  }
  if (restorePending && results.length && results.every((result) => !result.snapshot?.error && result.snapshot?.status === "succeeded")) {
    clearWatchlistRestorePending();
  }
  return { ok: results.every((result) => !result.snapshot?.error), mode: normalizedMode, results, elapsedMs: Date.now() - startedAt };
}

export async function runWatchlistSyncScheduler({ budgetMs = DEFAULT_BUDGET_MS } = {}) {
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  const config = await loadMediaConfig();
  if (config.watchlistSync?.enabled !== true) return { skipped: true, reason: "disabled" };
  const startedAt = Date.now();
  reconcileWatchlistQueueForConfig(config, { timestamp: startedAt });
  const results = [];
  const intervalMs = Math.max(5, Number(config.watchlistSync.intervalMinutes || 5)) * 60_000;
  const restorePending = getWatchlistRestoreState().pending;
  if (restorePending) clearWatchlistRemoteProjection();
  for (const scope of watchlistProviderScopes(config)) {
    if (Date.now() - startedAt >= budgetMs) break;
    const lastRun = getWatchlistSyncRun(scope);
    let snapshot = null;
    if (!lastRun?.completed_at || Date.now() - Number(lastRun.completed_at) >= intervalMs || lastRun.status !== "succeeded") {
      snapshot = await runProviderSnapshot(scope, config, { mode: "reconcile", destructive: false });
    }
    const processed = await processWatchlistQueue({ config, provider: scope.provider, limit: 25, budgetMs: Math.max(1000, budgetMs - (Date.now() - startedAt)) });
    results.push({ provider: scope.provider, snapshot: snapshot ? snapshot.run?.status || "failed" : "not_due", processed });
  }
  if (restorePending && results.length && results.every((result) => result.snapshot === "succeeded" || result.snapshot === "not_due")) {
    clearWatchlistRestorePending();
  }
  const didWork = results.some((result) => (
    result.snapshot !== "not_due"
    || Number(result.processed?.claimed || 0) > 0
  ));
  return { skipped: false, didWork, results, elapsedMs: Date.now() - startedAt };
}
