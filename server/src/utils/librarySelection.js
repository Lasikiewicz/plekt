// Explicit per-user, per-server library monitoring contract, discovery,
// root-membership resolution, and bounded positive/negative membership cache
// across Plex, Emby, and Jellyfin.
import { fetchWithTimeout } from "./outbound.js";
import { fetchPlexWithRefresh } from "./plexFetch.js";
import { jellyfinAuthHeaders, jellyfinCredential } from "./jellyfinAuth.js";
import { createPerUserState } from "./perUserState.js";
import { traceLog } from "./logVerbose.js";

export const LIBRARY_MONITORING_PROVIDERS = Object.freeze(["plex", "emby", "jellyfin"]);
export const PROVIDER_LABELS = Object.freeze({ plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" });

// Non-video types dropped before any external Ancestors or metadata API call.
const NON_VIDEO_MEDIA_TYPES = new Set([
  "audio",
  "track",
  "musicalbum",
  "musicartist",
  "artist",
  "album",
  "audiobook",
  "photo",
  "photoalbum",
  "picture",
  "book",
  "playlist",
  "boxset",
  "channel",
  "tvchannel",
  "program",
  "livetvchannel",
  "musicgenre",
  "person",
  "studio",
]);

// Emby/Jellyfin view collection types that never represent video libraries.
// Note: "movies", "tvshows", "homevideos", "musicvideos", and empty/unset
// (mixed) collection types are all retained for explicit per-library selection.
const EXCLUDED_EMBY_COLLECTION_TYPES = new Set([
  "music",
  "books",
  "audiobooks",
  "photos",
  "playlists",
  "livetv",
  "boxsets",
  "folders",
  "trailers",
]);

const AGGREGATE_ROOT_TYPES = new Set(["aggregatefolder", "userrootfolder"]);
const LIBRARY_ROOT_TYPES = new Set(["collectionfolder", "userview"]);

const POSITIVE_MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_MEMBERSHIP_TTL_MS = 2 * 60 * 1000;
const SERVER_IDENTITY_TTL_MS = 10 * 60 * 1000;
const MEMBERSHIP_CACHE_MAX_ENTRIES = 2000;

const membershipCacheByUser = createPerUserState(() => new Map());
const serverIdentityCache = new Map();
const selectionInvalidators = new Set();

export function registerLibrarySelectionInvalidator(fn) {
  if (typeof fn === "function") selectionInvalidators.add(fn);
}

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function normalizeProvider(value = "") {
  const provider = String(value || "").trim().toLowerCase();
  return LIBRARY_MONITORING_PROVIDERS.includes(provider) ? provider : "";
}

export function isNonVideoMediaType(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  return NON_VIDEO_MEDIA_TYPES.has(normalized);
}

function extractRawMediaType(itemOrMedia = {}) {
  return String(
    itemOrMedia?.rawType
      || itemOrMedia?.itemType
      || itemOrMedia?.ItemType
      || itemOrMedia?.MediaType
      || itemOrMedia?.mediaType
      || itemOrMedia?.Type
      || itemOrMedia?.type
      || "",
  ).trim();
}

export function normalizeStoredLibraryEntry(entry = {}) {
  const id = cleanId(entry?.id);
  if (!id) return null;
  const collectionType = String(entry?.collectionType || entry?.collection_type || entry?.type || "").trim().toLowerCase();
  const type = normalizeDisplayLibraryType(collectionType || entry?.type);
  return {
    id,
    name: String(entry?.name || id).trim().slice(0, 200),
    type,
    collectionType,
    ...(cleanId(entry?.uuid) ? { uuid: cleanId(entry.uuid) } : {}),
    ...(String(entry?.scanner || "").trim() ? { scanner: String(entry.scanner).trim().slice(0, 120) } : {}),
    ...(String(entry?.agent || "").trim() ? { agent: String(entry.agent).trim().slice(0, 120) } : {}),
    ...(entry?.isPersonalMedia ? { isPersonalMedia: true } : {}),
  };
}

function normalizeDisplayLibraryType(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "movie" || value === "movies") return "movie";
  if (value === "show" || value === "tvshows" || value === "series") return "show";
  if (value === "homevideos") return "homevideos";
  if (value === "musicvideos") return "musicvideos";
  if (!value || value === "mixed") return "mixed";
  return value;
}

export function normalizeLibraryMonitoringProvider(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const selectedIds = [...new Set(
    (Array.isArray(input.selectedIds) ? input.selectedIds : [])
      .map(cleanId)
      .filter(Boolean),
  )];
  const selectedIdSet = new Set(selectedIds);
  const rawLibraries = Array.isArray(input.selectedLibraries) ? input.selectedLibraries : [];
  const byId = new Map();
  for (const entry of rawLibraries) {
    const normalized = normalizeStoredLibraryEntry(entry);
    if (normalized && selectedIdSet.has(normalized.id)) {
      byId.set(normalized.id, normalized);
    }
  }
  const selectedLibraries = selectedIds.map((id) => byId.get(id) || {
    id,
    name: id,
    type: "mixed",
    collectionType: "",
  });
  const revision = Math.max(0, Math.round(Number(input.revision) || 0));
  const updatedAt = Math.max(0, Math.round(Number(input.updatedAt) || 0));
  return {
    serverId: cleanId(input.serverId),
    serverName: String(input.serverName || "").trim().slice(0, 200),
    revision,
    selectedIds,
    selectedLibraries,
    updatedAt,
  };
}

export function normalizeLibraryMonitoringSection(section = {}) {
  const raw = section && typeof section === "object" ? section : {};
  return {
    plex: normalizeLibraryMonitoringProvider(raw.plex),
    emby: normalizeLibraryMonitoringProvider(raw.emby),
    jellyfin: normalizeLibraryMonitoringProvider(raw.jellyfin),
  };
}

export const DEFAULT_LIBRARY_MONITORING = Object.freeze(normalizeLibraryMonitoringSection({}));

export function isProviderConnectedForMonitoring(config = {}, provider = "") {
  const normalized = normalizeProvider(provider);
  if (!normalized) return false;
  const section = config?.[normalized];
  if (!section || section.disabled) return false;
  if (normalized === "plex") {
    return Boolean(trimTrailingSlash(section.baseUrl) && String(section.token || "").trim());
  }
  if (normalized === "emby") {
    return Boolean(trimTrailingSlash(section.baseUrl) && String(section.apiKey || "").trim() && String(section.userId || "").trim());
  }
  return Boolean(trimTrailingSlash(section.baseUrl) && String(jellyfinCredential(section) || "").trim() && String(section.userId || "").trim());
}

export function getProviderLibrarySelection(config = {}, provider = "") {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    return {
      provider: "",
      connected: false,
      hasSelectedLibraries: false,
      selectedIds: [],
      selectedIdSet: new Set(),
      storedSelectedIds: [],
      selectedLibraries: [],
      serverId: "",
      connectionServerId: "",
      serverMismatch: false,
      revision: 0,
      reason: "unsupported_provider",
    };
  }

  // Support both full root config ({ plex, libraryMonitoring }) and a
  // provider-scoped config object carrying attached monitoring metadata.
  const isRootConfig = Boolean(config && (config.libraryMonitoring || config.plex || config.emby || config.jellyfin));
  const section = isRootConfig ? (config[normalized] || {}) : (config || {});
  const connected = isRootConfig
    ? isProviderConnectedForMonitoring(config, normalized)
    : isProviderConnectedForMonitoring({ [normalized]: section }, normalized);

  const stored = isRootConfig
    ? normalizeLibraryMonitoringProvider(config?.libraryMonitoring?.[normalized])
    : normalizeLibraryMonitoringProvider({
      serverId: section?.monitoredLibraryServerId || section?.libraryMonitoring?.serverId || "",
      serverName: section?.monitoredLibraryServerName || section?.libraryMonitoring?.serverName || "",
      revision: section?.monitoredLibraryRevision ?? section?.libraryMonitoring?.revision ?? 0,
      selectedIds: Array.isArray(section?.monitoredLibraryIds)
        ? section.monitoredLibraryIds
        : section?.libraryMonitoring?.selectedIds,
      selectedLibraries: section?.libraryMonitoring?.selectedLibraries,
      updatedAt: section?.libraryMonitoring?.updatedAt,
    });

  const connectionServerId = cleanId(section?.serverId);
  const serverMismatch = Boolean(stored.serverId && connectionServerId && stored.serverId !== connectionServerId);
  const effectiveSelectedIds = serverMismatch ? [] : stored.selectedIds;
  const hasSelectedLibraries = effectiveSelectedIds.length > 0;
  let reason = "";
  if (section?.disabled) reason = "provider_disabled";
  else if (serverMismatch) reason = "server_mismatch";
  else if (!hasSelectedLibraries) reason = "not_configured";

  return {
    provider: normalized,
    connected,
    hasSelectedLibraries,
    selectedIds: effectiveSelectedIds,
    selectedIdSet: new Set(effectiveSelectedIds),
    storedSelectedIds: stored.selectedIds,
    selectedLibraries: stored.selectedLibraries,
    serverId: stored.serverId,
    serverName: stored.serverName,
    connectionServerId,
    serverMismatch,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    reason,
  };
}

export function getUnselectedConnectedProviders(config = {}) {
  const unselected = [];
  for (const provider of LIBRARY_MONITORING_PROVIDERS) {
    const selection = getProviderLibrarySelection(config, provider);
    if (!selection.connected) continue;
    if (!selection.hasSelectedLibraries) {
      unselected.push({
        provider,
        label: PROVIDER_LABELS[provider],
        reason: selection.reason || "not_configured",
        serverId: selection.serverId,
        connectionServerId: selection.connectionServerId,
      });
    }
  }
  return unselected;
}

export function publicLibraryMonitoringConfig(config = {}) {
  const providers = {};
  for (const provider of LIBRARY_MONITORING_PROVIDERS) {
    const selection = getProviderLibrarySelection(config, provider);
    providers[provider] = {
      connected: selection.connected,
      hasSelectedLibraries: selection.hasSelectedLibraries,
      selectedIds: selection.selectedIds,
      storedSelectedIds: selection.storedSelectedIds,
      selectedLibraries: selection.selectedLibraries,
      serverId: selection.serverId,
      serverName: selection.serverName,
      connectionServerId: selection.connectionServerId,
      serverMismatch: selection.serverMismatch,
      revision: selection.revision,
      updatedAt: selection.updatedAt,
      reason: selection.reason,
    };
  }
  return {
    providers,
    unselectedConnectedProviders: getUnselectedConnectedProviders(config),
  };
}

export function attachProviderLibraryMonitoring(config = {}) {
  if (!config || typeof config !== "object") return config;
  const monitoring = normalizeLibraryMonitoringSection(config.libraryMonitoring);
  const next = { ...config, libraryMonitoring: monitoring };
  for (const provider of LIBRARY_MONITORING_PROVIDERS) {
    if (!next[provider] || typeof next[provider] !== "object") continue;
    const selection = getProviderLibrarySelection(next, provider);
    next[provider] = {
      ...next[provider],
      monitoredLibraryIds: [...selection.selectedIds],
      monitoredLibraryRevision: selection.revision,
      monitoredLibraryServerId: selection.serverId,
      monitoredLibraryServerName: selection.serverName,
      monitoredLibraryReason: selection.reason,
      libraryMonitoringEnforced: true,
    };
  }
  return next;
}

export function invalidateLibraryMembershipCache({ provider = "", serverId = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const targetServerId = cleanId(serverId);
  const cache = membershipCacheByUser();
  if (!normalizedProvider && !targetServerId) {
    cache.clear();
  } else {
    for (const [key, entry] of cache.entries()) {
      if (normalizedProvider && entry.provider !== normalizedProvider) continue;
      if (targetServerId && entry.serverId && entry.serverId !== targetServerId) continue;
      cache.delete(key);
    }
  }
  for (const fn of selectionInvalidators) {
    try { fn({ provider: normalizedProvider, serverId: targetServerId }); } catch { /* ignore */ }
  }
}

export function clearServerIdentityCache() {
  serverIdentityCache.clear();
}

function embyHeaders(config = {}) {
  return {
    Accept: "application/json",
    "X-Emby-Token": String(config.apiKey || ""),
  };
}

async function fetchEmbyLikeJson(url, provider, providerConfig, lane = "sync") {
  const headers = provider === "jellyfin" ? jellyfinAuthHeaders(providerConfig) : embyHeaders(providerConfig);
  const response = await fetchWithTimeout(url, { headers, lane });
  if (!response.ok) {
    const error = new Error(`${PROVIDER_LABELS[provider]} request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchProviderServerIdentity(provider, providerConfig = {}, { lane = "sync", forceRefresh = false } = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw new Error("Unsupported media provider");
  const baseUrl = trimTrailingSlash(providerConfig.baseUrl);
  if (!baseUrl) throw new Error(`Missing ${PROVIDER_LABELS[normalized]} baseUrl`);

  if (!forceRefresh && cleanId(providerConfig.serverId)) {
    return {
      serverId: cleanId(providerConfig.serverId),
      serverName: String(providerConfig.serverName || PROVIDER_LABELS[normalized]).trim(),
    };
  }

  const cacheKey = `${normalized}|${baseUrl}`;
  if (!forceRefresh) {
    const cached = serverIdentityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  let value = { serverId: "", serverName: PROVIDER_LABELS[normalized] };
  if (normalized === "plex") {
    const identityUrl = new URL(`${baseUrl}/identity`);
    const res = await fetchPlexWithRefresh(providerConfig, identityUrl, { lane });
    if (!res.ok) throw new Error(`Plex identity request failed with status ${res.status}`);
    const body = await res.json();
    const mc = body?.MediaContainer || {};
    const serverId = cleanId(mc.machineIdentifier || body?.machineIdentifier);
    if (!serverId) throw new Error("Plex identity response did not contain a machineIdentifier");
    value = {
      serverId,
      serverName: String(mc.friendlyName || providerConfig.serverName || "Plex Media Server").trim(),
    };
  } else {
    let body = null;
    const publicUrl = new URL(`${baseUrl}/System/Info/Public`);
    try {
      body = await fetchEmbyLikeJson(publicUrl, normalized, providerConfig, lane);
    } catch {
      const infoUrl = new URL(`${baseUrl}/System/Info`);
      if (normalized === "emby" && providerConfig.apiKey) infoUrl.searchParams.set("api_key", providerConfig.apiKey);
      body = await fetchEmbyLikeJson(infoUrl, normalized, providerConfig, lane);
    }
    const serverId = cleanId(body?.Id || body?.ServerId);
    if (!serverId) throw new Error(`${PROVIDER_LABELS[normalized]} system info response did not contain a server ID`);
    value = {
      serverId,
      serverName: String(body?.ServerName || body?.Name || providerConfig.serverName || PROVIDER_LABELS[normalized]).trim(),
    };
  }

  if (serverIdentityCache.size >= 100) serverIdentityCache.delete(serverIdentityCache.keys().next().value);
  serverIdentityCache.set(cacheKey, { value, expiresAt: Date.now() + SERVER_IDENTITY_TTL_MS });
  return value;
}

function annotateDuplicateLibraryNames(libraries = []) {
  const counts = new Map();
  for (const lib of libraries) {
    const key = String(lib.name || "").trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return libraries.map((lib) => {
    const key = String(lib.name || "").trim().toLowerCase();
    return {
      ...lib,
      duplicateName: (counts.get(key) || 0) > 1,
    };
  });
}

export async function discoverProviderLibraries(provider, providerConfig = {}, { lane = "interactive" } = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw new Error("Unsupported media provider");
  const baseUrl = trimTrailingSlash(providerConfig.baseUrl);
  if (!baseUrl) throw new Error(`Missing ${PROVIDER_LABELS[normalized]} server URL`);

  const identity = await fetchProviderServerIdentity(normalized, providerConfig, { lane });
  let libraries = [];

  if (normalized === "plex") {
    if (!String(providerConfig.token || "").trim()) throw new Error("Missing Plex token");
    const sectionsUrl = new URL(`${baseUrl}/library/sections`);
    const res = await fetchPlexWithRefresh(providerConfig, sectionsUrl, { lane });
    if (!res.ok) throw new Error(`Plex failed to fetch library sections: ${res.status}`);
    const body = await res.json();
    const directories = Array.isArray(body?.MediaContainer?.Directory) ? body.MediaContainer.Directory : [];
    libraries = directories
      .filter((dir) => {
        const type = String(dir?.type || "").trim().toLowerCase();
        return type === "movie" || type === "show";
      })
      .map((dir) => {
        const agent = String(dir?.agent || "").trim();
        const scanner = String(dir?.scanner || "").trim();
        const type = String(dir?.type || "").trim().toLowerCase();
        return {
          id: String(dir.key),
          uuid: cleanId(dir.uuid),
          name: String(dir.title || dir.key).trim(),
          type: type === "movie" ? "movie" : "show",
          collectionType: type,
          scanner,
          agent,
          isPersonalMedia: agent.toLowerCase() === "com.plexapp.agents.none",
          serverId: identity.serverId,
        };
      });
  } else {
    const userId = cleanId(providerConfig.userId);
    const token = normalized === "jellyfin" ? jellyfinCredential(providerConfig) : String(providerConfig.apiKey || "").trim();
    if (!userId || !token) throw new Error(`Missing ${PROVIDER_LABELS[normalized]} credentials or user ID`);

    // /Users/{userId}/Views works under both admin API keys and normal user account tokens.
    const viewsUrl = new URL(`${baseUrl}/Users/${encodeURIComponent(userId)}/Views`);
    if (normalized === "emby") viewsUrl.searchParams.set("api_key", token);
    const body = await fetchEmbyLikeJson(viewsUrl, normalized, providerConfig, lane);
    const items = Array.isArray(body?.Items) ? body.Items : [];
    libraries = items
      .filter((item) => {
        const id = cleanId(item?.Id);
        if (!id) return false;
        const collectionType = String(item?.CollectionType || "").trim().toLowerCase();
        if (collectionType && EXCLUDED_EMBY_COLLECTION_TYPES.has(collectionType)) return false;
        return true;
      })
      .map((item) => {
        const collectionType = String(item?.CollectionType || "").trim().toLowerCase();
        return {
          id: cleanId(item.Id),
          name: String(item.Name || item.Id).trim(),
          type: normalizeDisplayLibraryType(collectionType),
          collectionType,
          serverId: identity.serverId,
        };
      });
  }

  return {
    provider: normalized,
    serverId: identity.serverId,
    serverName: identity.serverName,
    libraries: annotateDuplicateLibraryNames(libraries),
  };
}

export async function validateLibrarySelectionSave({
  provider,
  providerConfig,
  requestedIds = [],
  currentMonitoring = {},
  expectedServerId = "",
  discover = discoverProviderLibraries,
} = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    throw Object.assign(new Error("Unsupported media provider"), { status: 400 });
  }
  if (!Array.isArray(requestedIds)) {
    throw Object.assign(new Error("selectedIds must be an array of library IDs"), { status: 400 });
  }
  const uniqueRequested = [...new Set(requestedIds.map(cleanId).filter(Boolean))];
  const discovered = await discover(normalized, providerConfig, { lane: "interactive" });
  const expected = cleanId(expectedServerId);
  if (expected && discovered.serverId && expected !== discovered.serverId) {
    throw Object.assign(
      new Error(`${PROVIDER_LABELS[normalized]} server identity changed while saving libraries. Refresh the library list and try again.`),
      { status: 409, code: "LIBRARY_SERVER_MISMATCH" },
    );
  }

  const byId = new Map(discovered.libraries.map((lib) => [lib.id, lib]));
  const invalidIds = uniqueRequested.filter((id) => !byId.has(id));
  if (invalidIds.length) {
    throw Object.assign(
      new Error(`One or more selected ${PROVIDER_LABELS[normalized]} libraries are not accessible on this server (${invalidIds.join(", ")}).`),
      { status: 400, code: "INVALID_LIBRARY_SELECTION", invalidIds },
    );
  }

  const previous = normalizeLibraryMonitoringProvider(currentMonitoring);
  const selectedLibraries = uniqueRequested.map((id) => normalizeStoredLibraryEntry(byId.get(id)));

  return {
    discovered,
    selection: {
      serverId: discovered.serverId,
      serverName: discovered.serverName,
      revision: previous.revision + 1,
      selectedIds: uniqueRequested,
      selectedLibraries,
      updatedAt: Date.now(),
    },
  };
}

function getMembershipCacheEntry(key) {
  const cache = membershipCacheByUser();
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setMembershipCacheEntry(key, { provider, serverId, result, ttlMs }) {
  if (!ttlMs || ttlMs <= 0) return;
  const cache = membershipCacheByUser();
  if (cache.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, {
    provider,
    serverId: cleanId(serverId),
    result,
    expiresAt: Date.now() + ttlMs,
  });
}

async function defaultFetchPlexMetadata(providerConfig, itemId, lane = "sync") {
  const baseUrl = trimTrailingSlash(providerConfig.baseUrl);
  if (!baseUrl || !providerConfig.token || !itemId) return null;
  const url = new URL(`${baseUrl}/library/metadata/${encodeURIComponent(itemId)}`);
  const res = await fetchPlexWithRefresh(providerConfig, url, { lane });
  if (!res.ok) {
    const error = new Error(`Plex metadata lookup failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const body = await res.json();
  return body?.MediaContainer?.Metadata?.[0] || null;
}

async function defaultFetchEmbyLikeAncestors(provider, providerConfig, itemId, lane = "sync") {
  const baseUrl = trimTrailingSlash(providerConfig.baseUrl);
  const userId = cleanId(providerConfig.userId);
  if (!baseUrl || !userId || !itemId) return [];
  const url = new URL(`${baseUrl}/Items/${encodeURIComponent(itemId)}/Ancestors`);
  url.searchParams.set("userId", userId);
  if (provider === "emby" && providerConfig.apiKey) url.searchParams.set("api_key", providerConfig.apiKey);
  const body = await fetchEmbyLikeJson(url, provider, providerConfig, lane);
  return Array.isArray(body) ? body : (Array.isArray(body?.Items) ? body.Items : []);
}

function extractNativeItemId(provider, itemOrMedia = {}) {
  if (!itemOrMedia || typeof itemOrMedia !== "object") return "";
  if (provider === "plex") {
    return cleanId(
      itemOrMedia.ratingKey
        ?? itemOrMedia.itemId
        ?? itemOrMedia.providerItemId
        ?? itemOrMedia.source_item_id
        ?? itemOrMedia.watchProvenance?.item_id
        ?? itemOrMedia.watch_provenance?.item_id,
    );
  }
  return cleanId(
    itemOrMedia.Id
      ?? itemOrMedia.id
      ?? itemOrMedia.itemId
      ?? itemOrMedia.providerItemId
      ?? itemOrMedia.source_item_id
      ?? itemOrMedia.watchProvenance?.item_id
      ?? itemOrMedia.watch_provenance?.item_id,
  );
}

function extractPlexSectionId(itemOrMedia = {}) {
  return cleanId(
    itemOrMedia.librarySectionID
      ?? itemOrMedia.librarySectionId
      ?? itemOrMedia.library_section_id
      ?? itemOrMedia.libraryId
      ?? itemOrMedia.watchProvenance?.library_id
      ?? itemOrMedia.watch_provenance?.library_id
      ?? itemOrMedia.libraryContext?.libraryId,
  );
}

function extractPayloadServerId(itemOrMedia = {}) {
  return cleanId(
    itemOrMedia.serverId
      ?? itemOrMedia.serverUuid
      ?? itemOrMedia.machineIdentifier
      ?? itemOrMedia.libraryContext?.serverId
      ?? itemOrMedia.watchProvenance?.server_id
      ?? itemOrMedia.watch_provenance?.server_id,
  );
}

export function normalizePluginLibraryContext(raw = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawVersion = Number(raw.version ?? raw.Version ?? 0);
  const version = Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : 0;
  const resolutionStatus = String(raw.resolutionStatus ?? raw.ResolutionStatus ?? "").trim().toLowerCase();
  const hasRawLibraryId = raw.libraryId !== undefined || raw.LibraryId !== undefined;
  const libraryId = cleanId(raw.libraryId ?? raw.LibraryId);
  const rawLibraryIds = raw.libraryIds ?? raw.LibraryIds;
  const hasRawLibraryIds = Array.isArray(rawLibraryIds);
  const libraryIds = [...new Set(
    (hasRawLibraryIds ? rawLibraryIds : (libraryId ? [libraryId] : []))
      .map(cleanId)
      .filter(Boolean),
  )];
  const serverId = cleanId(raw.serverId ?? raw.ServerId);
  const itemId = cleanId(raw.itemId ?? raw.ItemId);
  const libraryName = String(raw.libraryName ?? raw.LibraryName ?? "").trim();
  const collectionType = String(raw.collectionType ?? raw.CollectionType ?? "").trim().toLowerCase();
  if (!version && !resolutionStatus && !libraryId && !libraryIds.length && !serverId) return null;
  const resolvedStatus = resolutionStatus || (libraryIds.length ? "resolved" : "unresolved");
  const contradictory = Boolean(
    (hasRawLibraryId && libraryId && hasRawLibraryIds && !libraryIds.includes(libraryId))
    || (resolvedStatus === "resolved" && libraryIds.length !== 1)
    || (resolvedStatus === "resolved" && libraryId && libraryIds.length === 1 && libraryIds[0] !== libraryId),
  );
  return {
    version,
    resolutionStatus: resolvedStatus,
    libraryId: libraryId || libraryIds[0] || "",
    libraryIds,
    libraryName,
    collectionType,
    serverId,
    itemId,
    contradictory,
  };
}

function evaluateEmbyLikeAncestors(ancestors = [], selection) {
  if (!Array.isArray(ancestors) || ancestors.length === 0) {
    return {
      allowed: false,
      status: "unresolved",
      libraryId: "",
      libraryIds: [],
      reason: "Could not resolve library root from server ancestors",
    };
  }

  const normalized = ancestors
    .map((node) => ({
      id: cleanId(node?.Id ?? node?.id),
      type: String(node?.Type ?? node?.type ?? "").trim().toLowerCase(),
      collectionType: String(node?.CollectionType ?? node?.collectionType ?? "").trim().toLowerCase(),
      name: String(node?.Name ?? node?.name ?? "").trim(),
    }))
    .filter((node) => node.id && !AGGREGATE_ROOT_TYPES.has(node.type));

  const explicitRoots = normalized.filter((node) => LIBRARY_ROOT_TYPES.has(node.type));
  const candidateRoots = explicitRoots.length
    ? explicitRoots
    : normalized.filter((node) => selection.selectedIdSet.has(node.id));

  if (candidateRoots.length > 0) {
    const selectedRoots = candidateRoots.filter((node) => selection.selectedIdSet.has(node.id));
    const unselectedRoots = candidateRoots.filter((node) => !selection.selectedIdSet.has(node.id));
    if (selectedRoots.length > 0 && unselectedRoots.length > 0) {
      return {
        allowed: false,
        status: "ambiguous",
        libraryId: "",
        libraryIds: candidateRoots.map((node) => node.id),
        reason: "Item belongs to overlapping selected and unselected library roots",
      };
    }
    if (selectedRoots.length > 0) {
      return {
        allowed: true,
        status: "selected",
        libraryId: selectedRoots[0].id,
        libraryName: selectedRoots[0].name,
        libraryIds: selectedRoots.map((node) => node.id),
        reason: "",
      };
    }
    return {
      allowed: false,
      status: "unselected",
      libraryId: unselectedRoots[0].id,
      libraryName: unselectedRoots[0].name,
      libraryIds: unselectedRoots.map((node) => node.id),
      reason: "Item belongs to an unselected library",
    };
  }

  return {
    allowed: false,
    status: "unselected",
    libraryId: normalized[normalized.length - 1]?.id || "",
    libraryIds: [],
    reason: "Item ancestors do not match any selected library",
  };
}

export async function resolveItemLibraryMembership(provider, config, itemOrMedia = {}, options = {}) {
  const normalized = normalizeProvider(provider);
  const rawType = extractRawMediaType(itemOrMedia);

  // Step 0: drop non-video media types BEFORE making any external API call.
  if (isNonVideoMediaType(rawType)) {
    return {
      allowed: false,
      provider: normalized,
      status: "non_video",
      evidenceOrigin: "non_video_drop",
      libraryId: "",
      revision: 0,
      reason: `Unsupported non-video media type (${rawType})`,
    };
  }

  const selection = getProviderLibrarySelection(config, normalized);
  if (!selection.hasSelectedLibraries) {
    return {
      allowed: false,
      provider: normalized,
      status: selection.reason || "not_configured",
      evidenceOrigin: "selection_empty",
      libraryId: "",
      revision: selection.revision,
      reason: selection.reason === "server_mismatch"
        ? `${PROVIDER_LABELS[normalized]} server identity changed; re-select monitored libraries`
        : `No libraries selected for ${PROVIDER_LABELS[normalized]}`,
    };
  }

  const providerConfig = config?.[normalized] && typeof config[normalized] === "object"
    ? config[normalized]
    : (config || {});
  const itemId = extractNativeItemId(normalized, itemOrMedia);
  const payloadServerId = extractPayloadServerId(itemOrMedia);
  const pluginContext = normalizePluginLibraryContext(itemOrMedia.libraryContext || itemOrMedia.library_context);
  const expectedServerId = selection.serverId || selection.connectionServerId || "";

  // Reject cross-server claims immediately (including contradictory LibraryContext.ServerId)
  // BEFORE any membership cache hit.
  if (
    (payloadServerId && expectedServerId && payloadServerId !== expectedServerId)
    || (pluginContext?.serverId && expectedServerId && pluginContext.serverId !== expectedServerId)
  ) {
    return {
      allowed: false,
      provider: normalized,
      status: "server_mismatch",
      evidenceOrigin: "server_identity_check",
      libraryId: "",
      revision: selection.revision,
      reason: `Event server ID does not match configured ${PROVIDER_LABELS[normalized]} server`,
    };
  }

  // Query-scoped results (from an API query explicitly scoped to a single selected
  // library root) are already proven by that selected library ID.
  const queryLibraryId = cleanId(options.queryLibraryId);
  if (queryLibraryId) {
    const allowed = selection.selectedIdSet.has(queryLibraryId);
    return {
      allowed,
      provider: normalized,
      status: allowed ? "selected" : "unselected",
      evidenceOrigin: "query_scoped",
      libraryId: queryLibraryId,
      revision: selection.revision,
      reason: allowed ? "" : "Query library ID is not in the selected libraries",
    };
  }

  const cacheServerKey = expectedServerId || trimTrailingSlash(providerConfig.baseUrl) || normalized;
  const cacheKey = itemId
    ? `${normalized}|${cacheServerKey}|${itemId}|rev:${selection.revision}|sel:${selection.selectedIds.join(",")}`
    : "";
  if (cacheKey && !options.bypassCache) {
    const cached = getMembershipCacheEntry(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  const lane = options.lane || "sync";

  if (normalized === "plex") {
    let sectionId = extractPlexSectionId(itemOrMedia);
    let evidenceOrigin = "plex_section_id";

    if (!sectionId && itemId && !options.skipApiLookup) {
      const fetchMeta = options.fetchPlexMetadata || defaultFetchPlexMetadata;
      try {
        const meta = await fetchMeta(providerConfig, itemId, lane);
        sectionId = extractPlexSectionId(meta || {});
        evidenceOrigin = "plex_metadata_api";
      } catch (error) {
        traceLog("Plex library membership metadata lookup failed", { itemId, error: error.message });
        return {
          allowed: false,
          provider: normalized,
          status: error?.status === 401 || error?.status === 403 ? "permissions_denied" : "error",
          evidenceOrigin: "plex_metadata_api",
          libraryId: "",
          revision: selection.revision,
          reason: `Could not verify Plex library membership: ${error.message}`,
        };
      }
    }

    if (!sectionId) {
      const result = {
        allowed: false,
        provider: normalized,
        status: "unresolved",
        evidenceOrigin,
        libraryId: "",
        revision: selection.revision,
        reason: "Plex librarySectionID is missing and could not be resolved",
      };
      if (cacheKey) setMembershipCacheEntry(cacheKey, { provider: normalized, serverId: expectedServerId, result, ttlMs: NEGATIVE_MEMBERSHIP_TTL_MS });
      return result;
    }

    const allowed = selection.selectedIdSet.has(sectionId);
    const result = {
      allowed,
      provider: normalized,
      status: allowed ? "selected" : "unselected",
      evidenceOrigin,
      libraryId: sectionId,
      revision: selection.revision,
      reason: allowed ? "" : `Plex library ${sectionId} is not selected`,
    };
    if (cacheKey) {
      setMembershipCacheEntry(cacheKey, {
        provider: normalized,
        serverId: expectedServerId,
        result,
        ttlMs: allowed ? POSITIVE_MEMBERSHIP_TTL_MS : NEGATIVE_MEMBERSHIP_TTL_MS,
      });
    }
    return result;
  }

  // Emby / Jellyfin:
  // 1) Check optional versioned plugin libraryContext fast-path.
  //    Never trust ParentId on items; only trust pluginContext when it carries
  //    version 1, a verified matching serverId, a matching native itemId, and is
  //    explicitly marked "resolved" without ambiguity or contradictions.
  //    Cross-server context was already rejected above before any cache hit;
  //    untrusted, malformed, or contradictory assertions fall through to the
  //    server Ancestors API.
  if (
    pluginContext
    && pluginContext.version === 1
    && !pluginContext.contradictory
    && pluginContext.resolutionStatus === "resolved"
    && pluginContext.libraryIds.length === 1
    && pluginContext.serverId
    && expectedServerId
    && pluginContext.serverId === expectedServerId
    && Boolean(itemId)
    && (!pluginContext.itemId || pluginContext.itemId === itemId)
    && !options.forceApiVerification
  ) {
    const selectedRoots = pluginContext.libraryIds.filter((id) => selection.selectedIdSet.has(id));
    const unselectedRoots = pluginContext.libraryIds.filter((id) => !selection.selectedIdSet.has(id));
    if (selectedRoots.length > 0 && unselectedRoots.length > 0) {
      const result = {
        allowed: false,
        provider: normalized,
        status: "ambiguous",
        evidenceOrigin: "plugin_context_verified",
        libraryId: "",
        revision: selection.revision,
        reason: "Plugin reported overlapping selected and unselected library roots",
      };
      if (cacheKey) setMembershipCacheEntry(cacheKey, { provider: normalized, serverId: expectedServerId, result, ttlMs: NEGATIVE_MEMBERSHIP_TTL_MS });
      return result;
    }
    const allowed = selectedRoots.length > 0;
    const result = {
      allowed,
      provider: normalized,
      status: allowed ? "selected" : "unselected",
      evidenceOrigin: "plugin_context_verified",
      libraryId: allowed ? selectedRoots[0] : unselectedRoots[0],
      libraryName: pluginContext.libraryName || "",
      revision: selection.revision,
      reason: allowed ? "" : `${PROVIDER_LABELS[normalized]} library ${unselectedRoots[0]} is not selected`,
    };
    if (cacheKey) {
      setMembershipCacheEntry(cacheKey, {
        provider: normalized,
        serverId: expectedServerId,
        result,
        ttlMs: allowed ? POSITIVE_MEMBERSHIP_TTL_MS : NEGATIVE_MEMBERSHIP_TTL_MS,
      });
    }
    return result;
  }

  // 2) Authoritative API fallback via /Items/{itemId}/Ancestors?userId={userId}.
  if (!itemId || options.skipApiLookup) {
    return {
      allowed: false,
      provider: normalized,
      status: "unresolved",
      evidenceOrigin: `${normalized}_ancestors_api`,
      libraryId: "",
      revision: selection.revision,
      reason: `Cannot resolve ${PROVIDER_LABELS[normalized]} library membership without native item ID`,
    };
  }

  const fetchAncestors = options.fetchAncestors || defaultFetchEmbyLikeAncestors;
  try {
    const ancestors = await fetchAncestors(normalized, providerConfig, itemId, lane);
    const evaluated = evaluateEmbyLikeAncestors(ancestors, selection);
    const result = {
      ...evaluated,
      provider: normalized,
      evidenceOrigin: `${normalized}_ancestors_api`,
      revision: selection.revision,
    };
    if (cacheKey) {
      setMembershipCacheEntry(cacheKey, {
        provider: normalized,
        serverId: expectedServerId,
        result,
        ttlMs: result.allowed ? POSITIVE_MEMBERSHIP_TTL_MS : NEGATIVE_MEMBERSHIP_TTL_MS,
      });
    }
    return result;
  } catch (error) {
    traceLog(`${PROVIDER_LABELS[normalized]} ancestors lookup failed`, { itemId, error: error.message });
    return {
      allowed: false,
      provider: normalized,
      status: error?.status === 401 || error?.status === 403 ? "permissions_denied" : "error",
      evidenceOrigin: `${normalized}_ancestors_api`,
      libraryId: "",
      revision: selection.revision,
      reason: `Could not verify ${PROVIDER_LABELS[normalized]} library membership: ${error.message}`,
    };
  }
}

export async function filterAuthorizedTargetItems(provider, config, items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { allowed: [], blocked: [] };
  const normalized = normalizeProvider(provider);
  const selection = getProviderLibrarySelection(config, normalized);
  if (!selection.hasSelectedLibraries) {
    return {
      allowed: [],
      blocked: list.map((item) => ({
        item,
        decision: {
          allowed: false,
          provider: normalized,
          status: selection.reason || "not_configured",
          evidenceOrigin: "selection_empty",
          libraryId: "",
          revision: selection.revision,
          reason: `No libraries selected for ${PROVIDER_LABELS[normalized]}`,
        },
      })),
    };
  }

  const allowed = [];
  const blocked = [];
  for (const item of list) {
    const decision = await resolveItemLibraryMembership(normalized, config, item, options);
    if (decision.allowed) {
      allowed.push(item);
    } else {
      blocked.push({ item, decision });
    }
  }
  return { allowed, blocked };
}

export function buildLibrarySkipDiagnostic(provider, decision = {}, title = "") {
  const label = PROVIDER_LABELS[normalizeProvider(provider)] || String(provider || "Media server");
  const subject = title ? ` for "${title}"` : "";
  switch (decision?.status) {
    case "not_configured":
      return `Skipped ${label} activity${subject}: no monitored libraries selected.`;
    case "server_mismatch":
      return `Skipped ${label} activity${subject}: connected server identity changed; re-select libraries in Settings > Media Servers.`;
    case "non_video":
      return `Skipped ${label} activity${subject}: unsupported non-video media type.`;
    case "unselected":
      return `Skipped ${label} activity${subject}: library is not selected for monitoring.`;
    case "ambiguous":
      return `Skipped ${label} activity${subject}: library membership is ambiguous across selected and unselected roots.`;
    case "permissions_denied":
      return `Skipped ${label} activity${subject}: server denied permission while verifying library membership.`;
    case "unresolved":
    case "error":
    default:
      return `Skipped ${label} activity${subject}: library membership could not be verified.`;
  }
}
