import { db, parseJson, toJson } from "../db.js";
import { assertSafeOutboundUrl, normalizeHttpUrl, configureOutboundGovernor } from "./outbound.js";
import { applyTuningConfig, normalizePlexHistoricalWatchedSync, normalizeTuningSection, normalizeWatchImportMode, plexHistoricalWatchedSyncDefault, tuningClamps, tuningEnvDefaults, watchImportModeDefault, WATCH_IMPORT_MODES } from "./tuning.js";
import { normalizeSyncRoles, validateSyncRolesSection, normalizeAuthority } from "./syncRoles.js";
import { getMediaConnection, resolveConnectedProviderConfig } from "./mediaConnectionRepo.js";
import { getValidPlexServerToken, getValidPlexToken } from "./plexTokenManager.js";
import { activityGroupKeyFor, activityGroupMediaType, activityGroupTitleFromRecord, activityItemKeyFor } from "./syncActivityIdentity.js";
import { brandEnv } from "./brandEnv.js";

const SETTINGS_ID = "mediaConfig";
const RUNTIME_ID = "main";
export const RATING_SYNC_PROVIDERS = ["plex", "emby", "jellyfin", "trakt"];
export const RATING_SYNC_DIRECTIONS = ["off", "send", "receive", "bidirectional"];
export const DEFAULT_RATING_SYNC = Object.freeze({
  enabled: false,
  intervalMinutes: 5,
  initialSyncMode: "import",
  conflictPolicy: "local_wins",
  providers: Object.freeze({ plex: "bidirectional", emby: "bidirectional", jellyfin: "bidirectional", trakt: "bidirectional" }),
});
// Watchlist sync is Plex-only. Plex has a real account-level watchlist that can
// hold anything in its catalog, which is what a watchlist means: titles you do
// not own yet. Emby and Jellyfin have no watchlist concept, and the closest
// stand-ins - a playlist or Favorites - can only reference items already in the
// library, so an entry for something unowned has nowhere to go. Verified against
// both live APIs: adding an id the library does not hold is accepted and then
// silently ignored (`ItemAddedCount: 0`), and a playlist cannot hold a series
// as a series, only its episodes.
export const WATCHLIST_SYNC_PROVIDERS = ["plex"];
export const WATCHLIST_SYNC_REPRESENTATIONS = Object.freeze({
  plex: ["native", "rss"],
});
export const DEFAULT_WATCHLIST_SYNC = Object.freeze({
  enabled: false,
  intervalMinutes: 5,
  importRemoteAdditions: false,
  providers: Object.freeze({
    plex: Object.freeze({ enabled: false, representation: "native", writeEnabled: false, publishConfirmedAt: 0 }),
  }),
});
// Up Next provider sync predates this setting, so keep it enabled when the
// section is absent from an existing installation. Users can opt out without
// changing Plembfin's local Up Next view.
export const DEFAULT_UP_NEXT_SYNC = Object.freeze({ enabled: true });
// Dashboard Now Playing / Up Next panel: whether Up Next fills the panel while
// idle, whether it trails live sessions, and the total number of cards shown.
export const DEFAULT_NOW_PLAYING = Object.freeze({ allowPartWatched: true, allowUpNext: true, itemCount: 3 });
export const NOW_PLAYING_ITEM_COUNT_MAX = 3;
export const DEFAULT_TAUTULLI = Object.freeze({
  baseUrl: "http://127.0.0.1:8181",
  apiKey: "",
  userId: "",
  disabled: false,
});
export const BACKGROUND_SYNC_PROGRESS_STALE_MS = 90_000;
export const BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS = 30 * 60_000;
// Local owners normally remove themselves after the 2s UI settle window. Give
// that timer ample room before a reader repairs a completed owner left behind
// by a crash, otherwise a polling web process could prune it just before the
// owning process reopens the same burst.
const BACKGROUND_SYNC_PROGRESS_COMPLETED_TTL_MS = 10_000;

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

export function mediaAccountAuthEnabled() {
  return !new Set(["false", "0", "off", "no"]).has(String(brandEnv("MEDIA_AUTH_ENABLED") || "").trim().toLowerCase());
}

function envEnabled(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return undefined;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function normalizeSyncScope(scope = {}) {
  const allowedServers = ["plex", "emby", "jellyfin"];
  const servers = Array.isArray(scope.servers) ? scope.servers.map((value) => String(value).toLowerCase()).filter((value) => allowedServers.includes(value)) : [];
  const libraries = Array.isArray(scope.libraries) ? scope.libraries.filter((value) => value && allowedServers.includes(String(value.server).toLowerCase()) && String(value.id || "").trim()).map((value) => ({ server: String(value.server).toLowerCase(), id: String(value.id).trim(), name: String(value.name || "").trim() })) : [];
  const mediaTypes = Array.isArray(scope.mediaTypes) ? scope.mediaTypes.map((value) => String(value).toLowerCase()).filter((value) => ["movie", "episode"].includes(value)) : [];
  return { servers, libraries, mediaTypes, watchedAfter: String(scope.watchedAfter || ""), watchedBefore: String(scope.watchedBefore || ""), maxChanges: Math.max(0, Math.round(Number(scope.maxChanges) || 0)) };
}

export function normalizePacing(section = {}) {
  const profile = ["gentle", "standard", "fast"].includes(String(section.profile || "")) ? String(section.profile) : "standard";
  return { profile };
}

export function normalizeRatingSyncSection(section = {}) {
  const enabled = Boolean(section.enabled);
  // Rating sync is one policy: when it is on, every connected provider both
  // contributes observations and receives the canonical Plembfin value.
  // Keep the legacy fields in the stored shape for backwards compatibility,
  // but do not allow an old per-provider direction to weaken that contract.
  const providers = Object.fromEntries(RATING_SYNC_PROVIDERS.map((provider) => [
    provider,
    enabled ? "bidirectional" : "off",
  ]));
  return {
    enabled,
    intervalMinutes: DEFAULT_RATING_SYNC.intervalMinutes,
    initialSyncMode: "import",
    conflictPolicy: "local_wins",
    providers,
  };
}

export function normalizeWatchlistSyncSection(section = {}) {
  const enabled = Boolean(section.enabled);
  const providers = {};
  for (const provider of WATCHLIST_SYNC_PROVIDERS) {
    const raw = section.providers?.[provider] ?? section[provider] ?? {};
    const value = raw && typeof raw === "object" ? raw : {};
    const representation = DEFAULT_WATCHLIST_SYNC.providers[provider].representation;
    const confirmed = Number(value.publishConfirmedAt || value.publish_confirmed_at || 0);
    providers[provider] = {
      enabled,
      representation,
      // Enabling this domain is the user's authorization to keep every
      // connected provider in sync, including the Plex account watchlist.
      ...(provider === "plex" ? { writeEnabled: enabled } : {}),
      publishConfirmedAt: Number.isFinite(confirmed) && confirmed > 0 ? Math.round(confirmed) : 0,
    };
  }
  return {
    enabled,
    intervalMinutes: DEFAULT_WATCHLIST_SYNC.intervalMinutes,
    importRemoteAdditions: enabled,
    providers,
  };
}

export function normalizeUpNextSyncSection(section = {}) {
  const rawEnabled = section && typeof section === "object" ? section.enabled : undefined;
  return {
    enabled: rawEnabled === undefined ? DEFAULT_UP_NEXT_SYNC.enabled : rawEnabled === true,
  };
}

export function normalizeNowPlayingSection(section = {}) {
  const raw = section && typeof section === "object" ? section : {};
  const flag = (value, fallback) => (value === undefined ? fallback : value === true);
  const count = Math.round(Number(raw.itemCount));
  return {
    allowPartWatched: flag(raw.allowPartWatched, DEFAULT_NOW_PLAYING.allowPartWatched),
    allowUpNext: flag(raw.allowUpNext, DEFAULT_NOW_PLAYING.allowUpNext),
    itemCount: Number.isFinite(count) ? Math.min(NOW_PLAYING_ITEM_COUNT_MAX, Math.max(1, count)) : DEFAULT_NOW_PLAYING.itemCount,
  };
}

function envMediaConfig() {
  const plexEnabled = envEnabled("PLEX_ENABLED");
  const embyEnabled = envEnabled("EMBY_ENABLED");
  const jellyfinEnabled = envEnabled("JELLYFIN_ENABLED");

  return normalizeStoredConfig({
    plex: {
      baseUrl: envValue("PLEX_SERVER_URL", "PLEX_BASE_URL", "PLEX_URL"),
      token: envValue("PLEX_TOKEN", "PLEX_API_KEY"),
      username: envValue("PLEX_USERNAME"),
      disabled: plexEnabled === undefined ? false : !plexEnabled,
    },
    emby: {
      baseUrl: envValue("EMBY_SERVER_URL", "EMBY_BASE_URL", "EMBY_URL"),
      apiKey: envValue("EMBY_API_KEY"),
      userId: envValue("EMBY_USER_ID"),
      disabled: embyEnabled === undefined ? false : !embyEnabled,
    },
    jellyfin: {
      baseUrl: envValue("JELLYFIN_SERVER_URL", "JELLYFIN_BASE_URL", "JELLYFIN_URL"),
      apiKey: envValue("JELLYFIN_API_KEY"),
      userId: envValue("JELLYFIN_USER_ID"),
      disabled: jellyfinEnabled === undefined ? false : !jellyfinEnabled,
    },
    tmdb: {
      apiKey: envValue("TMDB_API_KEY", "TMDB_KEY"),
    },
    fanart: {
      apiKey: envValue("FANART_API_KEY"),
    },
    tvdb: {
      apiKey: envValue("TVDB_API_KEY"),
    },
    youtube: {
      apiKey: envValue("YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY"),
    },
    omdb: {
      apiKey: envValue("OMDB_API_KEY"),
    },
    tuning: tuningEnvDefaults(),
    syncScope: normalizeSyncScope({}),
    authority: normalizeAuthority({}),
    pacing: normalizePacing({ profile: envValue("OUTBOUND_PACING_PROFILE") }),
    ratingSync: normalizeRatingSyncSection({}),
    watchlistSync: normalizeWatchlistSyncSection({}),
    upNextSync: normalizeUpNextSyncSection({}),
    nowPlaying: normalizeNowPlayingSection({}),
  });
}

export function normalizePublicBaseUrl(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  const url = new URL(input);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("publicBaseUrl must use http or https");
  if (url.username || url.password) throw new Error("publicBaseUrl must not contain embedded credentials");
  if (url.search || url.hash) throw new Error("publicBaseUrl must not contain a query or fragment");
  if (url.pathname && url.pathname !== "/") throw new Error("publicBaseUrl must be an origin without a path");
  return url.origin;
}

function hasConfiguredFields(section = {}) {
  return Object.entries(section).some(([key, value]) => !["disabled", "sync"].includes(key) && String(value || "").trim() !== "");
}

export function mergeEnvDefaults(stored = {}) {
  const normalized = normalizeStoredConfig(stored);
  const defaults = envMediaConfig();
  const merged = { publicBaseUrl: normalized.publicBaseUrl };

  for (const section of ["plex", "emby", "jellyfin", "tmdb", "fanart", "tvdb", "youtube", "omdb"]) {
    merged[section] = { ...defaults[section], ...normalized[section] };
    for (const [key, value] of Object.entries(defaults[section])) {
      if (key === "disabled") continue;
      const credentialField = (section === "plex" && key === "token") || (["emby", "jellyfin"].includes(section) && key === "apiKey");
      if (!String(merged[section][key] || "").trim() && String(value || "").trim() && !(credentialField && normalized[section].legacyFallbackDisabled)) {
        merged[section][key] = value;
      }
    }
  }

  // Seerr and Tautulli have no env-var defaults - carry stored values through
  // as-is. Omitting either section here would make a saved connection appear
  // to reset on the next config read.
  merged.seerr = normalized.seerr;
  merged.tautulli = normalized.tautulli;

  // Tuning uses numbers-or-null (null = fall back to env/default) rather than
  // the blank-string check above, so it's carried through as-is; the
  // env/default fallback happens in applyTuningConfig()'s effective getters.
  merged.tuning = normalized.tuning;

  // syncScope and authority have no env-var defaults; pacing's
  // OUTBOUND_PACING_PROFILE env default only applies before anything has ever
  // been saved (see defaultMediaConfig()). All three are carried through
  // as-is here. Omitting any of them would make normalizeStoredConfig() below
  // see them as absent and silently reset them to their hardcoded defaults on
  // every load, wiping a saved value the moment anything reads config again.
  merged.syncScope = normalized.syncScope;
  merged.authority = normalized.authority;
  merged.pacing = normalized.pacing;
  merged.ratingSync = normalized.ratingSync;
  merged.watchlistSync = normalized.watchlistSync;
  merged.upNextSync = normalized.upNextSync;
  merged.nowPlaying = normalized.nowPlaying;

  for (const section of ["plex", "emby", "jellyfin"]) {
    if (hasConfiguredFields(normalized[section])) {
      merged[section].disabled = normalized[section].disabled;
    } else {
      merged[section].disabled = defaults[section].disabled;
    }
  }

  return normalizeStoredConfig(merged);
}

export function normalizeStoredConfig(stored = {}) {
  return {
    publicBaseUrl: normalizePublicBaseUrl(stored.publicBaseUrl || ""),
    plex: {
      baseUrl: trimTrailingSlash(stored.plex?.baseUrl || stored.plex?.url || ""),
      token: String(stored.plex?.token || stored.plex?.apiKey || "").trim(),
      username: String(stored.plex?.username || "").trim(),
      legacyFallbackDisabled: Boolean(stored.plex?.legacyFallbackDisabled),
      authMode: stored.plex?.authMode === "manual" ? "manual" : "account",
      disabled: Boolean(stored.plex?.disabled),
      sync: normalizeSyncRoles(stored.plex?.sync || {}),
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
      legacyFallbackDisabled: Boolean(stored.emby?.legacyFallbackDisabled),
      authMode: stored.emby?.authMode === "manual" || (!stored.emby?.authMode && Boolean(stored.emby?.apiKey || stored.emby?.api_key)) ? "manual" : "account",
      disabled: Boolean(stored.emby?.disabled),
      sync: normalizeSyncRoles(stored.emby?.sync || {}),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
      legacyFallbackDisabled: Boolean(stored.jellyfin?.legacyFallbackDisabled),
      authMode: stored.jellyfin?.authMode === "manual" || (!stored.jellyfin?.authMode && Boolean(stored.jellyfin?.apiKey || stored.jellyfin?.api_key)) ? "manual" : "account",
      disabled: Boolean(stored.jellyfin?.disabled),
      sync: normalizeSyncRoles(stored.jellyfin?.sync || {}),
    },
    seerr: {
      baseUrl: trimTrailingSlash(stored.seerr?.baseUrl || ""),
      apiKey: String(stored.seerr?.apiKey || "").trim(),
      disabled: Boolean(stored.seerr?.disabled),
    },
    tautulli: {
      baseUrl: trimTrailingSlash(stored.tautulli?.baseUrl || DEFAULT_TAUTULLI.baseUrl),
      apiKey: String(stored.tautulli?.apiKey || stored.tautulli?.api_key || "").trim(),
      userId: String(stored.tautulli?.userId || stored.tautulli?.user_id || "").trim(),
      disabled: Boolean(stored.tautulli?.disabled),
    },
    tmdb: {
      apiKey: String(stored.tmdb?.apiKey || stored.tmdbApiKey || "").trim(),
    },
    fanart: {
      apiKey: String(stored.fanart?.apiKey || "").trim(),
    },
    tvdb: {
      apiKey: String(stored.tvdb?.apiKey || "").trim(),
    },
    youtube: {
      apiKey: String(stored.youtube?.apiKey || "").trim(),
    },
    omdb: {
      apiKey: String(stored.omdb?.apiKey || "").trim(),
    },
    // Numeric tuning fields use null for "not overridden". The watch-import
    // mode follows the same contract but is normalized separately so the
    // existing numeric tuning API remains backwards-compatible.
    tuning: {
      ...normalizeTuningSection(stored.tuning || {}),
      watchImportMode: normalizeWatchImportMode(stored.tuning?.watchImportMode),
      plexHistoricalWatchedSync: normalizePlexHistoricalWatchedSync(stored.tuning?.plexHistoricalWatchedSync),
    },
    syncScope: normalizeSyncScope(stored.syncScope || {}),
    authority: normalizeAuthority(stored.authority || {}),
    pacing: normalizePacing(stored.pacing || {}),
    ratingSync: normalizeRatingSyncSection(stored.ratingSync || {}),
    watchlistSync: normalizeWatchlistSyncSection(stored.watchlistSync || {}),
    upNextSync: normalizeUpNextSyncSection(stored.upNextSync || {}),
    nowPlaying: normalizeNowPlayingSection(stored.nowPlaying || {}),
  };
}

const selectSettingsStmt = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertSettingsStmt = db.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export async function loadMediaConfig({ resolveConnections = true } = {}) {
  const row = selectSettingsStmt.get(SETTINGS_ID);
  const merged = mergeEnvDefaults(parseJson(row?.data, {}) || {});
  merged.publicBaseUrl = normalizePublicBaseUrl(envValue("PLEKT_PUBLIC_URL", "PLEMBFIN_PUBLIC_URL") || merged.publicBaseUrl);
  if (resolveConnections) {
    const plexConnection = getMediaConnection("plex");
    if (merged.plex.authMode === "account" && ["plex_jwt", "plex_managed_jwt"].includes(plexConnection?.authKind)) {
      // Proactive refresh and expired-token cold-start recovery happen before
      // the first caller receives a Plex client configuration.
      await getValidPlexToken();
      await getValidPlexServerToken();
    }
    for (const provider of ["plex", "emby", "jellyfin"]) {
      if (merged[provider].authMode === "manual") continue;
      merged[provider] = resolveConnectedProviderConfig(provider, merged[provider]);
    }
  }
  applyTuningConfig(merged.tuning);
  configureOutboundGovernor(merged.pacing.profile);
  return merged;
}

// The browser-facing config shape. Secrets (tokens/API keys) are never included -
// each section carries a `configured` boolean instead, plus the non-secret fields
// the settings form needs for repopulation (baseUrl, username, userId, disabled).
// TVDB also exposes which non-secret key source is active so the UI can explain
// whether it is using the shared built-in project key or a personal key.
export function publicMediaConfig(config = {}) {
  const normalized = normalizeStoredConfig(config);
  const plexConn = getMediaConnection("plex");
  const embyConn = getMediaConnection("emby");
  const jellyfinConn = getMediaConnection("jellyfin");
  return {
    mediaAuthEnabled: mediaAccountAuthEnabled(),
    publicBaseUrl: normalized.publicBaseUrl,
    plex: {
      configured: Boolean(normalized.plex.token || (plexConn && plexConn.status !== "disabled" && plexConn.baseUrl)),
      baseUrl: normalized.plex.baseUrl || plexConn?.baseUrl || "",
      username: normalized.plex.username || plexConn?.remoteUsername || "",
      authMode: normalized.plex.authMode || plexConn?.authKind || "manual",
      disabled: normalized.plex.disabled,
      sync: normalized.plex.sync,
      connection: plexConn,
    },
    emby: {
      configured: Boolean(normalized.emby.apiKey || (embyConn && embyConn.status !== "disabled" && embyConn.baseUrl)),
      baseUrl: normalized.emby.baseUrl || embyConn?.baseUrl || "",
      userId: normalized.emby.userId || embyConn?.remoteUserId || "",
      authMode: normalized.emby.authMode || embyConn?.authKind || "manual",
      disabled: normalized.emby.disabled,
      sync: normalized.emby.sync,
      connection: embyConn,
    },
    jellyfin: {
      configured: Boolean(normalized.jellyfin.apiKey || (jellyfinConn && jellyfinConn.status !== "disabled" && jellyfinConn.baseUrl)),
      baseUrl: normalized.jellyfin.baseUrl || jellyfinConn?.baseUrl || "",
      userId: normalized.jellyfin.userId || jellyfinConn?.remoteUserId || "",
      authMode: normalized.jellyfin.authMode || jellyfinConn?.authKind || "manual",
      disabled: normalized.jellyfin.disabled,
      sync: normalized.jellyfin.sync,
      connection: jellyfinConn,
    },
    seerr: {
      configured: Boolean(normalized.seerr.apiKey && normalized.seerr.baseUrl && !normalized.seerr.disabled),
      baseUrl: normalized.seerr.baseUrl,
      disabled: normalized.seerr.disabled,
    },
    tautulli: {
      configured: Boolean(normalized.tautulli.apiKey && normalized.tautulli.baseUrl && !normalized.tautulli.disabled),
      baseUrl: normalized.tautulli.baseUrl,
      userId: normalized.tautulli.userId,
      disabled: normalized.tautulli.disabled,
    },
    tmdb: { configured: Boolean(normalized.tmdb.apiKey) },
    fanart: { configured: Boolean(normalized.fanart.apiKey) },
    tvdb: {
      configured: Boolean(normalized.tvdb.apiKey),
      keySource: normalized.tvdb.apiKey ? "personal" : "built-in",
    },
    youtube: { configured: Boolean(normalized.youtube.apiKey) },
    omdb: { configured: Boolean(normalized.omdb.apiKey) },
    tuning: publicTuningConfig(normalized.tuning),
    syncScope: normalized.syncScope,
    authority: normalized.authority,
    pacing: normalized.pacing,
    ratingSync: normalized.ratingSync,
    watchlistSync: normalized.watchlistSync,
    upNextSync: normalized.upNextSync,
    nowPlaying: normalized.nowPlaying,
  };
}

// Effective value (stored override, else env/default) plus an `overridden`
// flag per field, so the settings UI can show the active value as a
// placeholder while leaving the input blank when nothing is stored.
function publicTuningConfig(storedTuning = {}) {
  const envDefaults = tuningEnvDefaults();
  const clamps = tuningClamps();
  const result = {};
  for (const key of Object.keys(envDefaults)) {
    const overrideValue = storedTuning[key];
    const overridden = overrideValue !== null && overrideValue !== undefined;
    result[key] = {
      value: overridden ? overrideValue : envDefaults[key],
      default: envDefaults[key],
      overridden,
      min: clamps[key][0],
      max: clamps[key][1],
    };
  }
  const modeOverride = normalizeWatchImportMode(storedTuning.watchImportMode);
  const modeDefault = watchImportModeDefault();
  result.watchImportMode = {
    value: modeOverride || modeDefault,
    default: modeDefault,
    overridden: Boolean(modeOverride),
    options: [...WATCH_IMPORT_MODES],
  };
  const historicalOverride = normalizePlexHistoricalWatchedSync(storedTuning.plexHistoricalWatchedSync);
  const historicalDefault = plexHistoricalWatchedSyncDefault();
  result.plexHistoricalWatchedSync = {
    value: historicalOverride === null ? historicalDefault : historicalOverride,
    default: historicalDefault,
    overridden: historicalOverride !== null,
  };
  return result;
}

// Merge an incoming section over the stored one. Secret fields (tokens/API keys)
// are kept from the stored config when the incoming value is blank or missing -
// the browser never receives secrets (publicMediaConfig), so a settings save with
// an empty key field means "keep the saved credential", not "clear it".
function mergeSection(existing = {}, incoming, secretFields = []) {
  if (!incoming) return existing;
  const merged = { ...existing, ...incoming };
  for (const field of secretFields) {
    if (!String(incoming[field] ?? "").trim()) merged[field] = existing[field];
  }
  return merged;
}

function mergeRatingSyncSection(existing = {}, incoming) {
  if (!incoming) return existing;
  return {
    ...existing,
    ...incoming,
    providers: {
      ...(existing.providers || {}),
      ...(incoming.providers || {}),
    },
  };
}

function mergeWatchlistSyncSection(existing = {}, incoming) {
  if (!incoming) return existing;
  const existingProviders = existing.providers || {};
  const incomingProviders = incoming.providers || {};
  const providers = { ...existingProviders };
  for (const provider of WATCHLIST_SYNC_PROVIDERS) {
    const previous = existingProviders[provider] || {};
    const next = incomingProviders[provider];
    if (!next || typeof next !== "object") continue;
    const representationChanged = next.representation && next.representation !== previous.representation;
    const newlyEnabled = next.enabled === true && previous.enabled !== true;
    providers[provider] = {
      ...previous,
      ...next,
      ...(representationChanged || newlyEnabled ? { publishConfirmedAt: 0 } : {}),
    };
  }
  return {
    ...existing,
    ...incoming,
    providers,
  };
}

// Returns the normalized result of merging `config` over the stored settings,
// without persisting. handleConfig validates this merged shape so a save that
// omits an already-stored credential still passes required-field checks.
export async function mergeIncomingConfig(config = {}) {
  // Never merge from the runtime adapter: it contains a decrypted connection
  // token and would copy that token back into the general settings JSON.
  const existing = await loadMediaConfig({ resolveConnections: false }).catch(() => normalizeStoredConfig({}));
  return normalizeStoredConfig({
    publicBaseUrl: config.publicBaseUrl ?? existing.publicBaseUrl,
    plex: { ...mergeSection(existing.plex, config.plex, ["token"]), ...(String(config.plex?.token || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    emby: { ...mergeSection(existing.emby, config.emby, ["apiKey"]), ...(String(config.emby?.apiKey || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    jellyfin: { ...mergeSection(existing.jellyfin, config.jellyfin, ["apiKey"]), ...(String(config.jellyfin?.apiKey || "").trim() ? { legacyFallbackDisabled: false } : {}) },
    seerr: mergeSection(existing.seerr, config.seerr, ["apiKey"]),
    tautulli: mergeSection(existing.tautulli, config.tautulli, ["apiKey"]),
    tmdb: mergeSection(existing.tmdb, config.tmdb, ["apiKey"]),
    fanart: mergeSection(existing.fanart, config.fanart, ["apiKey"]),
    tvdb: mergeSection(existing.tvdb, config.tvdb, ["apiKey"]),
    youtube: mergeSection(existing.youtube, config.youtube, ["apiKey"]),
    omdb: mergeSection(existing.omdb, config.omdb, ["apiKey"]),
    tuning: mergeSection(existing.tuning, config.tuning, []),
    syncScope: mergeSection(existing.syncScope, config.syncScope, []),
    authority: mergeSection(existing.authority, config.authority, []),
    pacing: mergeSection(existing.pacing, config.pacing, []),
    ratingSync: mergeRatingSyncSection(existing.ratingSync, config.ratingSync),
    watchlistSync: mergeWatchlistSyncSection(existing.watchlistSync, config.watchlistSync),
    upNextSync: mergeSection(existing.upNextSync, config.upNextSync, []),
    nowPlaying: mergeSection(existing.nowPlaying, config.nowPlaying, []),
  });
}

export async function saveMediaConfig(config) {
  const normalized = await mergeIncomingConfig(config);
  upsertSettingsStmt.run(SETTINGS_ID, toJson(normalized), Date.now());
  applyTuningConfig(normalized.tuning);
}

export function disableStoredLegacyCredential(provider, connectionId = "", { authMode = "account", activate = false } = {}) {
  if (!["plex", "emby", "jellyfin"].includes(provider)) throw new Error("Unsupported media provider");
  db.transaction(() => {
    const stored = parseJson(selectSettingsStmt.get(SETTINGS_ID)?.data, {}) || {};
    const section = { ...(stored[provider] || {}), legacyFallbackDisabled: true, connectionId: String(connectionId || ""), authMode, ...(activate ? { disabled: false } : {}) };
    if (provider === "plex") {
      delete section.token;
      delete section.apiKey;
    } else {
      delete section.apiKey;
      delete section.api_key;
    }
    upsertSettingsStmt.run(SETTINGS_ID, toJson({ ...stored, [provider]: section }), Date.now());
  }).immediate();
}

export function validateConfig(config = {}) {
  const errors = [];
  const connected = (provider) => {
    const connection = getMediaConnection(provider);
    return connection?.status === "connected" ? connection : null;
  };
  try { normalizePublicBaseUrl(config.publicBaseUrl || ""); } catch (error) { errors.push(error.message); }
  const validateBaseUrl = (value, label) => {
    if (!value) return;
    try {
      // normalizeHttpUrl enforces http/https and rejects embedded credentials;
      // assertSafeOutboundUrl blocks cloud-metadata endpoints - every configured
      // server URL is later fetched with credentials attached, so both apply.
      assertSafeOutboundUrl(normalizeHttpUrl(value, { label }), { label });
    } catch (error) {
      errors.push(error.message);
    }
  };

  if (config.plex) {
    const plexEnabled = !config.plex.disabled;
    if (plexEnabled) {
      const connection = config.plex.authMode === "manual" ? null : connected("plex");
      const baseUrl = config.plex.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("plex.baseUrl is required when Plex is enabled");
      validateBaseUrl(baseUrl, "plex.baseUrl");
      if (!config.plex.token && !connection) errors.push("plex.token is required when Plex is enabled");
      if (!config.plex.username && !connection?.remoteUsername) errors.push("plex.username is required when Plex is enabled");
    }
  }

  if (config.emby) {
    const embyEnabled = !config.emby.disabled;
    if (embyEnabled) {
      const connection = config.emby.authMode === "manual" ? null : connected("emby");
      const baseUrl = config.emby.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("emby.baseUrl is required when Emby is enabled");
      validateBaseUrl(baseUrl, "emby.baseUrl");
      if (!config.emby.apiKey && !connection) errors.push("emby.apiKey is required when Emby is enabled");
      if (!config.emby.userId && !connection?.remoteUserId) errors.push("emby.userId is required when Emby is enabled");
    }
  }

  if (config.jellyfin) {
    const jellyfinEnabled = !config.jellyfin.disabled;
    if (jellyfinEnabled) {
      const connection = config.jellyfin.authMode === "manual" ? null : connected("jellyfin");
      const baseUrl = config.jellyfin.baseUrl || connection?.baseUrl;
      if (!baseUrl) errors.push("jellyfin.baseUrl is required when Jellyfin is enabled");
      validateBaseUrl(baseUrl, "jellyfin.baseUrl");
      if (!config.jellyfin.apiKey && !connection) errors.push("jellyfin.apiKey is required when Jellyfin is enabled");
      if (!config.jellyfin.userId && !connection?.remoteUserId) errors.push("jellyfin.userId is required when Jellyfin is enabled");
    }
  }

  if (config.seerr && !config.seerr.disabled && config.seerr.baseUrl) {
    validateBaseUrl(config.seerr.baseUrl, "seerr.baseUrl");
  }

  if (config.tautulli) {
    if (!config.tautulli.disabled) {
      if (!config.tautulli.baseUrl) errors.push("tautulli.baseUrl is required when Tautulli is enabled");
      if (!config.tautulli.apiKey) errors.push("tautulli.apiKey is required when Tautulli is enabled");
      validateBaseUrl(config.tautulli.baseUrl, "tautulli.baseUrl");
    }
    if (config.tautulli.userId !== undefined && typeof config.tautulli.userId !== "string") {
      errors.push("tautulli.userId must be a string");
    }
  }

  if (config.tuning) {
    const clamps = tuningClamps();
    for (const [key, value] of Object.entries(normalizeTuningSection(config.tuning))) {
      if (value === null) continue;
      const [min, max] = clamps[key];
      if (value < min || value > max) errors.push(`tuning.${key} must be between ${min} and ${max}`);
    }
    const requestedPlexHistoricalWatchedSync = config.tuning.plexHistoricalWatchedSync;
    if (
      requestedPlexHistoricalWatchedSync !== null
      && requestedPlexHistoricalWatchedSync !== undefined
      && String(requestedPlexHistoricalWatchedSync).trim() !== ""
      && normalizePlexHistoricalWatchedSync(requestedPlexHistoricalWatchedSync) === null
    ) {
      errors.push("tuning.plexHistoricalWatchedSync must be a boolean");
    }
    const requestedWatchImportMode = config.tuning.watchImportMode;
    if (requestedWatchImportMode !== null && requestedWatchImportMode !== undefined && String(requestedWatchImportMode).trim() !== "") {
      const normalizedMode = String(requestedWatchImportMode).trim().toLowerCase();
      if (!WATCH_IMPORT_MODES.includes(normalizedMode)) {
        errors.push(`tuning.watchImportMode must be one of ${WATCH_IMPORT_MODES.join(", ")}`);
      }
    }
  }

  for (const section of ["plex", "emby", "jellyfin"]) {
    errors.push(...validateSyncRolesSection(config[section]?.sync || {}, `${section}.sync`));
  }
  if (config.authority?.conflictPolicy === "server" && !["plex", "emby", "jellyfin"].includes(config.authority.server)) {
    errors.push("authority.server is required when conflictPolicy is server");
  }
  if (config.pacing && !["gentle", "standard", "fast"].includes(config.pacing.profile)) {
    errors.push("pacing.profile must be gentle, standard, or fast");
  }
  if (config.upNextSync && config.upNextSync.enabled !== undefined && typeof config.upNextSync.enabled !== "boolean") {
    errors.push("upNextSync.enabled must be boolean");
  }
  if (config.nowPlaying) {
    for (const key of ["allowPartWatched", "allowUpNext"]) {
      if (config.nowPlaying[key] !== undefined && typeof config.nowPlaying[key] !== "boolean") errors.push(`nowPlaying.${key} must be boolean`);
    }
    const count = config.nowPlaying.itemCount;
    if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= NOW_PLAYING_ITEM_COUNT_MAX)) {
      errors.push(`nowPlaying.itemCount must be a whole number from 1 to ${NOW_PLAYING_ITEM_COUNT_MAX}`);
    }
  }

  if (config.ratingSync) {
    const interval = Number(config.ratingSync.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
      errors.push("ratingSync.intervalMinutes must be a whole number between 5 and 1440");
    }
    if (!["baseline", "import"].includes(config.ratingSync.initialSyncMode)) {
      errors.push("ratingSync.initialSyncMode must be baseline or import");
    }
    if (!["local_wins", "remote_wins"].includes(config.ratingSync.conflictPolicy)) {
      errors.push("ratingSync.conflictPolicy must be local_wins or remote_wins");
    }
    for (const provider of RATING_SYNC_PROVIDERS) {
      if (!RATING_SYNC_DIRECTIONS.includes(config.ratingSync.providers?.[provider])) {
        errors.push(`ratingSync.providers.${provider} must be off, send, receive, or bidirectional`);
      }
    }
  }

  if (config.watchlistSync) {
    const interval = Number(config.watchlistSync.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
      errors.push("watchlistSync.intervalMinutes must be a whole number between 5 and 1440");
    }
    for (const provider of WATCHLIST_SYNC_PROVIDERS) {
      const setting = config.watchlistSync.providers?.[provider] || {};
      if (!WATCHLIST_SYNC_REPRESENTATIONS[provider].includes(setting.representation)) {
        errors.push(`watchlistSync.providers.${provider}.representation is invalid`);
      }
      if (typeof setting.enabled !== "boolean") errors.push(`watchlistSync.providers.${provider}.enabled must be boolean`);
      if (provider === "plex" && typeof setting.writeEnabled !== "boolean") {
        errors.push("watchlistSync.providers.plex.writeEnabled must be boolean");
      }
    }
  }

  return errors;
}

const selectRuntimeStmt = db.prepare("SELECT data FROM runtime_state WHERE id = ?");
const upsertRuntimeStmt = db.prepare(
  `INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

export const RESTORE_KIND_FULL_SYNC = "full_sync_watchstates";
export const RESTORE_KIND_BACKUP = "backup_restore";
export const SYNC_OPERATION_FORCE = "force_sync";
export const SYNC_OPERATION_REBUILD = "rebuild";
export const SYNC_OPERATION_SCHEDULED = "scheduled_sync";

// A restore owns the canonical watch-state tables and every outbound projection
// until its replay has finished. Keep this classification in the shared runtime
// store so every process (web, worker, and split-role installs) uses the same
// fail-closed gate instead of maintaining separate in-memory flags.
const AUTHORITATIVE_RESTORE_KINDS = new Set([
  RESTORE_KIND_BACKUP,
  RESTORE_KIND_FULL_SYNC,
  "restore",
]);

export function isAuthoritativeRestoreKind(kind) {
  return AUTHORITATIVE_RESTORE_KINDS.has(String(kind || "").trim());
}

function operationMatches(runtime = {}) {
  // The legacy restore flag is itself a safety fence. If an older process
  // left it set while a newer process wrote an unrelated syncOperation, treat
  // the restore as the owner rather than allowing that newer marker to reopen
  // a write race.
  if (runtime.restoreSyncActive === true) {
    return {
      kind: String(runtime.restoreSyncKind || "restore"),
      ownerId: String(runtime.restoreSyncRunId || ""),
      startedAt: Number(runtime.restoreSyncStartedAt || 0),
      heartbeat: Number(runtime.restoreSyncHeartbeat || runtime.restoreSyncStartedAt || 0),
    };
  }

  const stored = runtime.syncOperation && typeof runtime.syncOperation === "object"
    ? runtime.syncOperation
    : null;
  if (stored?.kind && stored.active !== false) {
    return {
      kind: String(stored.kind),
      ownerId: String(stored.ownerId || ""),
      startedAt: Number(stored.startedAt || 0),
      heartbeat: Number(stored.heartbeat || 0),
    };
  }

  // Compatibility for locks written before the shared operation marker was
  // introduced. These fields remain in runtime_state because the UI and the
  // restore recovery path still expose them directly.
  if (runtime.forceSyncActive === true) {
    return {
      kind: SYNC_OPERATION_FORCE,
      ownerId: String(runtime.forceSyncRunId || ""),
      startedAt: Number(runtime.forceSyncStartedAt || 0),
      heartbeat: Number(runtime.forceSyncHeartbeat || runtime.forceSyncStartedAt || 0),
    };
  }
  if (runtime.rebuildActive === true) {
    return {
      kind: SYNC_OPERATION_REBUILD,
      ownerId: String(runtime.rebuildRunId || ""),
      startedAt: Number(runtime.rebuildStartedAt || 0),
      heartbeat: Number(runtime.rebuildHeartbeat || runtime.rebuildStartedAt || 0),
    };
  }
  if (runtime.scheduledSyncActive === true) {
    return {
      kind: SYNC_OPERATION_SCHEDULED,
      ownerId: String(runtime.scheduledSyncRunId || ""),
      startedAt: Number(runtime.scheduledSyncStartedAt || 0),
      heartbeat: Number(runtime.scheduledSyncHeartbeat || runtime.scheduledSyncStartedAt || 0),
    };
  }
  return null;
}

export function activeSyncOperation(runtime = {}) {
  return operationMatches(runtime);
}

// Synchronous by design: hot paths such as webhook admission and outbound
// dispatch must be able to check the cross-process restore fence immediately
// before touching local state or a remote service. Passing a runtime object is
// useful to callers that already loaded it; omitting it reads the authoritative
// SQLite value.
export function activeAuthoritativeRestore(runtime = null) {
  const current = runtime && typeof runtime === "object"
    ? runtime
    : parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
  const operation = operationMatches(current);
  if (operation && isAuthoritativeRestoreKind(operation.kind)) return operation;

  // Compatibility for old rows that only carried the legacy restore fields.
  if (current.restoreSyncActive === true && isAuthoritativeRestoreKind(current.restoreSyncKind || "restore")) {
    return {
      kind: String(current.restoreSyncKind || "restore"),
      ownerId: String(current.restoreSyncRunId || ""),
      startedAt: Number(current.restoreSyncStartedAt || 0),
      heartbeat: Number(current.restoreSyncHeartbeat || current.restoreSyncStartedAt || 0),
    };
  }
  return null;
}

export function isAuthoritativeRestoreActive(runtime = null) {
  return Boolean(activeAuthoritativeRestore(runtime));
}

export function syncOperationIsFresh(runtime = {}, now = Date.now(), staleMs = 3 * 60 * 1000) {
  const operation = operationMatches(runtime);
  return Boolean(operation?.heartbeat && operation.heartbeat >= now - staleMs);
}

function sameOperationOwner(active, kind, ownerId) {
  return Boolean(active)
    && active.kind === kind
    && String(active.ownerId || "") !== ""
    && String(ownerId || "") !== ""
    && active.ownerId === String(ownerId);
}

function isBackupRestoreKind(kind) {
  return String(kind || "").trim() === RESTORE_KIND_BACKUP;
}

function valuesForPreemptedOperation(active, now) {
  if (!active) return {};
  if (active.kind === SYNC_OPERATION_FORCE) {
    return {
      forceSyncActive: false,
      forceSyncCancelRequested: true,
      forceSyncHeartbeat: now,
      forceSyncResult: {
        success: false,
        aborted: true,
        cancelled: true,
        preempted: true,
        reason: "Force Sync was preempted by an authoritative restore.",
      },
    };
  }
  if (active.kind === SYNC_OPERATION_SCHEDULED) {
    return {
      scheduledSyncActive: false,
      scheduledSyncCancelRequested: true,
      scheduledSyncHeartbeat: now,
    };
  }
  if (active.kind === RESTORE_KIND_FULL_SYNC || active.kind === "restore") {
    return {
      restoreSyncCancelRequested: true,
      restoreSyncHeartbeat: now,
    };
  }
  if (active.kind === SYNC_OPERATION_REBUILD) {
    return {
      rebuildActive: false,
      rebuildCancelRequested: true,
      rebuildHeartbeat: now,
    };
  }
  return {};
}

// Runtime state is stored in SQLite, so claiming the shared operation marker
// in the same immediate transaction as the legacy active flag gives all web
// and worker processes one compare-and-set boundary. The owner id makes batch
// requests re-entrant while preventing a second operation of the same kind
// from stealing the first one's lock. An authoritative restore is the one
// deliberate exception: it preempts every non-restore operation, fences its
// owner, and marks cancellable background work for shutdown.
export async function claimSyncOperation({ kind, ownerId = "", activeField, startedAt = Date.now(), values = {}, preempt = false } = {}) {
  if (!kind || !activeField) throw new Error("kind and activeField are required to claim a sync operation");
  let result;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (active && !sameOperationOwner(active, kind, ownerId)) {
      // A second authoritative restore must still be rejected. A restore may,
      // however, take ownership from scheduled/Force Sync/rebuild, because
      // leaving any of those writers alive would let it race the canonical
      // restore.
      const canPreempt = preempt === true
        && isAuthoritativeRestoreKind(kind)
        && (isBackupRestoreKind(kind) || !isAuthoritativeRestoreKind(active.kind));
      if (!canPreempt) {
        result = { ok: false, active };
        return;
      }
    }
    const now = Date.now();
    const operation = {
      active: true,
      kind: String(kind),
      ownerId: String(ownerId || ""),
      startedAt: Number(startedAt || now),
      heartbeat: now,
    };
    const merged = {
      ...current,
      ...((active && !sameOperationOwner(active, kind, ownerId)) ? valuesForPreemptedOperation(active, now) : {}),
      ...values,
      [activeField]: true,
      syncOperation: operation,
      updatedAt: now,
    };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    result = {
      ok: true,
      operation,
      ...(active && !sameOperationOwner(active, kind, ownerId) ? { preempted: active } : {}),
    };
  }).immediate();
  return result;
}

export async function touchSyncOperation({ kind, ownerId = "", values = {} } = {}) {
  if (!kind) return false;
  let touched = false;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (!sameOperationOwner(active, kind, ownerId)) return;
    const now = Date.now();
    const operation = { ...current.syncOperation, active: true, heartbeat: now };
    const merged = { ...current, ...values, syncOperation: operation, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    touched = true;
  }).immediate();
  return touched;
}

export async function releaseSyncOperation({ kind, ownerId = "", values = {} } = {}) {
  if (!kind) return false;
  let released = false;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    if (active && !sameOperationOwner(active, kind, ownerId)) return;
    const now = Date.now();
    const merged = { ...current, ...values, syncOperation: null, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    released = true;
  }).immediate();
  return released;
}

// Used only by an administrator/recovery path after a heartbeat has gone cold.
// It is deliberately kind-scoped so resetting a stale Force Sync cannot clear
// an unrelated restore or rebuild operation that started in the meantime.
export async function clearSyncOperation({ kind = "", values = {} } = {}) {
  let result = { ok: false, active: null };
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const active = operationMatches(current);
    result = { ok: false, active };
    if (!active || (kind && active.kind !== kind)) return;
    const now = Date.now();
    const merged = { ...current, ...values, syncOperation: null, updatedAt: now };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
    result = { ok: true, active };
  }).immediate();
  return result;
}

export async function setRuntimeState(values = {}) {
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const merged = { ...current, ...values, updatedAt: Date.now() };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
  }).immediate();
}

// Record a user acknowledgement for a surfaced sync blocker without replacing
// any concurrent progress, heartbeat, or restore fields. Attention items are
// derived from runtime_state, so this small compare-and-set style helper keeps
// a skip click safe when a worker writes its final result at the same time.
export async function recordSyncAttentionSkip(id, details = {}) {
  const key = String(id || "").trim();
  if (!key) return null;
  let result = null;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = current.syncAttentionSkips && typeof current.syncAttentionSkips === "object"
      ? current.syncAttentionSkips
      : {};
    const skippedAt = Date.now();
    const next = {
      ...existing,
      [key]: {
        ...(existing[key] && typeof existing[key] === "object" ? existing[key] : {}),
        ...details,
        skippedAt,
      },
    };
    // Keep acknowledgements bounded. Old run ids must not make runtime_state
    // grow forever on an install that performs many restores.
    const bounded = Object.fromEntries(
      Object.entries(next)
        .sort(([, left], [, right]) => Number(left?.skippedAt || 0) - Number(right?.skippedAt || 0))
        .slice(-200),
    );
    const merged = { ...current, syncAttentionSkips: bounded, updatedAt: skippedAt };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), skippedAt);
    result = bounded[key];
  }).immediate();
  return result;
}

export async function loadRuntimeState() {
  return parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
}

function normalizedBackgroundSyncProgress(value = {}) {
  const progress = value && typeof value === "object" ? value : {};
  return {
    ...progress,
    total: Math.max(0, Number(progress.total) || 0),
    completed: Math.max(0, Number(progress.completed) || 0),
  };
}

function backgroundSyncProgressIsStale(progress, now, staleMs) {
  if (!(progress.total > 0 && progress.completed < progress.total)) return false;
  const heartbeatAt = Number(progress.heartbeatAt || progress.updatedAt || 0);
  return !heartbeatAt || heartbeatAt <= now - staleMs;
}

function normalizedBackgroundSyncProgressOwners(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const owners = {};
  for (const [ownerId, raw] of Object.entries(value)) {
    if (!ownerId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const total = Math.max(0, Number(raw.total) || 0);
    const completed = Math.max(0, Number(raw.completed) || 0);
    if (!(total > 0)) continue;
    owners[ownerId] = {
      total,
      completed,
      currentItemLabel: String(raw.currentItemLabel || ""),
      startedAt: Math.max(0, Number(raw.startedAt) || Number(raw.updatedAt) || 0),
      heartbeatAt: Math.max(0, Number(raw.heartbeatAt) || Number(raw.updatedAt) || 0),
      expiresAt: Math.max(0, Number(raw.expiresAt) || 0),
      updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    };
  }
  return owners;
}

function aggregateBackgroundSyncProgress(owners = {}, now = Date.now(), recoveredAt = 0) {
  const values = Object.values(owners);
  const currentOwner = values
    .filter((owner) => owner.completed < owner.total && owner.currentItemLabel)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
  return {
    total: values.reduce((sum, owner) => sum + owner.total, 0),
    completed: values.reduce((sum, owner) => sum + Math.min(owner.completed, owner.total), 0),
    ownerCount: values.length,
    updatedAt: values.reduce((latest, owner) => Math.max(latest, owner.updatedAt), now),
    ...(currentOwner?.currentItemLabel ? { currentItemLabel: currentOwner.currentItemLabel } : {}),
    ...(recoveredAt ? { recoveredAt } : {}),
  };
}

function backgroundSyncOwnerExpired(owner, now, staleMs, maxOwnerMs) {
  if (owner.completed >= owner.total) {
    return (owner.updatedAt || owner.heartbeatAt || 0) <= now - BACKGROUND_SYNC_PROGRESS_COMPLETED_TTL_MS;
  }
  const heartbeatExpired = !(owner.heartbeatAt > now - staleMs);
  const leaseExpiresAt = owner.expiresAt || ((owner.startedAt || 0) + maxOwnerMs);
  return heartbeatExpired || !(leaseExpiresAt > now);
}

function pruneBackgroundSyncOwners(owners, now, staleMs, maxOwnerMs) {
  const active = {};
  let changed = false;
  let recovered = false;
  for (const [ownerId, owner] of Object.entries(owners)) {
    if (backgroundSyncOwnerExpired(owner, now, staleMs, maxOwnerMs)) {
      changed = true;
      if (owner.completed < owner.total) recovered = true;
      continue;
    }
    active[ownerId] = owner;
  }
  return { owners: active, changed, recovered };
}

function writeBackgroundSyncOwners(current, owners, now, { recovered = false } = {}) {
  const progress = aggregateBackgroundSyncProgress(owners, now, recovered ? now : 0);
  const merged = {
    ...current,
    backgroundSyncProgressOwners: owners,
    backgroundSyncProgress: progress,
    updatedAt: now,
  };
  upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), now);
  return progress;
}

function legacyOwnerFromRuntime(runtime, now, staleMs, maxOwnerMs) {
  if (runtime.backgroundSyncProgressOwners && typeof runtime.backgroundSyncProgressOwners === "object") return {};
  const progress = normalizedBackgroundSyncProgress(runtime.backgroundSyncProgress);
  if (!(progress.total > 0 && progress.completed < progress.total)) return {};
  if (backgroundSyncProgressIsStale(progress, now, staleMs)) return {};
  const ownerId = String(progress.ownerId || `legacy:${progress.updatedAt || now}`);
  const startedAt = Number(progress.startedAt || progress.updatedAt || now);
  return {
    [ownerId]: {
      total: progress.total,
      completed: progress.completed,
      currentItemLabel: String(progress.currentItemLabel || ""),
      startedAt,
      heartbeatAt: Number(progress.heartbeatAt || progress.updatedAt || now),
      expiresAt: Number(progress.expiresAt || (startedAt + maxOwnerMs)),
      updatedAt: Number(progress.updatedAt || now),
    },
  };
}

function ownersForRuntime(runtime, now, staleMs, maxOwnerMs) {
  const stored = normalizedBackgroundSyncProgressOwners(runtime.backgroundSyncProgressOwners);
  return Object.keys(stored).length ? stored : legacyOwnerFromRuntime(runtime, now, staleMs, maxOwnerMs);
}

export async function startBackgroundSyncProgressOwner({
  ownerId,
  total,
  completed = 0,
  currentItemLabel = "",
  now = Date.now(),
  maxOwnerMs = BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS,
} = {}) {
  const key = String(ownerId || "").trim();
  if (!key) throw new Error("ownerId is required");
  let progress;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = ownersForRuntime(current, now, BACKGROUND_SYNC_PROGRESS_STALE_MS, maxOwnerMs);
    const pruned = pruneBackgroundSyncOwners(existing, now, BACKGROUND_SYNC_PROGRESS_STALE_MS, maxOwnerMs);
    const normalizedTotal = Math.max(0, Number(total) || 0);
    pruned.owners[key] = {
      total: normalizedTotal,
      completed: Math.max(0, Number(completed) || 0),
      currentItemLabel: String(currentItemLabel || ""),
      startedAt: now,
      heartbeatAt: now,
      expiresAt: now + Math.max(1, Number(maxOwnerMs) || BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS),
      updatedAt: now,
    };
    progress = writeBackgroundSyncOwners(current, pruned.owners, now, { recovered: pruned.recovered });
  }).immediate();
  return { updated: true, progress };
}

export async function updateBackgroundSyncProgressOwner({
  ownerId,
  total,
  completed,
  currentItemLabel,
  now = Date.now(),
  staleMs = BACKGROUND_SYNC_PROGRESS_STALE_MS,
  maxOwnerMs = BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS,
} = {}) {
  const key = String(ownerId || "").trim();
  if (!key) return { updated: false, progress: normalizedBackgroundSyncProgress({}) };
  let updated = false;
  let progress;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = ownersForRuntime(current, now, staleMs, maxOwnerMs);
    const pruned = pruneBackgroundSyncOwners(existing, now, staleMs, maxOwnerMs);
    const owner = pruned.owners[key];
    if (owner) {
      pruned.owners[key] = {
        ...owner,
        total: Math.max(0, Number(total) || 0),
        completed: Math.max(0, Number(completed) || 0),
        ...(currentItemLabel !== undefined ? { currentItemLabel: String(currentItemLabel || "") } : {}),
        heartbeatAt: now,
        updatedAt: now,
      };
      updated = true;
    }
    progress = writeBackgroundSyncOwners(current, pruned.owners, now, { recovered: pruned.recovered });
  }).immediate();
  return { updated, progress };
}

export async function releaseBackgroundSyncProgressOwner({
  ownerId,
  now = Date.now(),
  staleMs = BACKGROUND_SYNC_PROGRESS_STALE_MS,
  maxOwnerMs = BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS,
} = {}) {
  const key = String(ownerId || "").trim();
  if (!key) return { released: false, progress: normalizedBackgroundSyncProgress({}) };
  let released = false;
  let progress;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = ownersForRuntime(current, now, staleMs, maxOwnerMs);
    const pruned = pruneBackgroundSyncOwners(existing, now, staleMs, maxOwnerMs);
    if (pruned.owners[key]) {
      delete pruned.owners[key];
      released = true;
    }
    progress = writeBackgroundSyncOwners(current, pruned.owners, now, { recovered: pruned.recovered });
  }).immediate();
  return { released, progress };
}

// The sidebar progress burst is driven by in-process dispatch promises, while
// its latest counts live in SQLite so split web/worker deployments can see it.
// If the owning process exits mid-burst those promises cannot finish and reset
// the persisted counts. Recover that orphan only after its heartbeat expires;
// the second check inside the transaction avoids clearing a burst another
// process refreshed between the initial read and the write lock.
export async function loadBackgroundSyncProgress({
  now = Date.now(),
  staleMs = BACKGROUND_SYNC_PROGRESS_STALE_MS,
  maxOwnerMs = BACKGROUND_SYNC_PROGRESS_MAX_OWNER_MS,
} = {}) {
  const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
  const hasOwnerState = current.backgroundSyncProgressOwners && typeof current.backgroundSyncProgressOwners === "object";
  if (!hasOwnerState) {
    const legacy = normalizedBackgroundSyncProgress(current.backgroundSyncProgress);
    if (!backgroundSyncProgressIsStale(legacy, now, staleMs)) return legacy;
  }
  const initialOwners = ownersForRuntime(current, now, staleMs, maxOwnerMs);
  const initialPruned = pruneBackgroundSyncOwners(initialOwners, now, staleMs, maxOwnerMs);
  if (hasOwnerState && !initialPruned.changed) {
    return aggregateBackgroundSyncProgress(initialPruned.owners, now);
  }

  let resolved;
  db.transaction(() => {
    const latest = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const latestHasOwnerState = latest.backgroundSyncProgressOwners && typeof latest.backgroundSyncProgressOwners === "object";
    let legacyRecovered = false;
    if (!latestHasOwnerState) {
      const latestLegacy = normalizedBackgroundSyncProgress(latest.backgroundSyncProgress);
      if (!backgroundSyncProgressIsStale(latestLegacy, now, staleMs)) {
        resolved = latestLegacy;
        return;
      }
      legacyRecovered = latestLegacy.total > 0 && latestLegacy.completed < latestLegacy.total;
    }
    const latestOwners = ownersForRuntime(latest, now, staleMs, maxOwnerMs);
    const pruned = pruneBackgroundSyncOwners(latestOwners, now, staleMs, maxOwnerMs);
    if (latestHasOwnerState && !pruned.changed) {
      resolved = aggregateBackgroundSyncProgress(pruned.owners, now);
      return;
    }
    resolved = writeBackgroundSyncOwners(latest, pruned.owners, now, { recovered: legacyRecovered || pruned.recovered });
  }).immediate();
  return resolved;
}

// Clear a restore guard after the owning process has stopped or an administrator
// has explicitly confirmed that the persisted lock is orphaned. The cancellation
// flag lets an in-flight full-sync request finish its current remote call without
// accepting another batch under the old run id.
export async function clearRestoreSyncState({ reason = "Restore lock cleared.", expectedKind = "" } = {}) {
  const runtime = await loadRuntimeState();
  const operation = operationMatches(runtime);
  const kind = String(runtime.restoreSyncKind || operation?.kind || "");
  if (expectedKind && kind !== expectedKind) return { reset: false, skipped: true, kind, runId: String(runtime.restoreSyncRunId || "") };

  const runId = String(runtime.restoreSyncRunId || "");
  const wasActive = runtime.restoreSyncActive === true
    || Boolean(runId)
    || runtime.restoreSyncCancelRequested === true
    || Boolean(operation && (!expectedKind || operation.kind === expectedKind));
  if (!wasActive) return { reset: false, skipped: false, kind, runId };

  const finishedAt = Date.now();
  await setRuntimeState({
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    restoreSyncCancelRequested: true,
    restoreSyncHeartbeat: finishedAt,
    restoreSyncLog: [],
    restoreSyncReportId: "",
    restoreSyncSummary: null,
    syncOperation: null,
    restoreSyncResult: {
      success: false,
      cancelled: true,
      reset: true,
      reason,
      finishedAt,
    },
  });
  return { reset: true, skipped: false, kind, runId };
}

// Append items onto an array field in runtime_state.
export async function appendRuntimeLog(field, items = []) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  db.transaction(() => {
    const current = parseJson(selectRuntimeStmt.get(RUNTIME_ID)?.data, {}) || {};
    const existing = Array.isArray(current[field]) ? current[field] : [];
    const merged = { ...current, [field]: [...existing, ...list], updatedAt: Date.now() };
    upsertRuntimeStmt.run(RUNTIME_ID, toJson(merged), Date.now());
  }).immediate();
}

const insertSyncHistoryStmt = db.prepare(
  `INSERT INTO sync_history (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, activity_group_key, activity_item_key, created_at)
   VALUES (@timestamp, @media_type, @title, @source, @status, @details, @action, @target_states, @raw_payload_debug, @activity_group_key, @activity_item_key, @created_at)`,
);
const updateSyncHistoryStmt = db.prepare(
  `UPDATE sync_history SET timestamp=@timestamp, status=@status, details=@details, action=@action, target_states=@target_states, raw_payload_debug=@raw_payload_debug WHERE id=@id`,
);
const selectSyncHistoryPageStmt = db.prepare("SELECT * FROM sync_history ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?");
const selectSyncHistoryByIdStmt = db.prepare("SELECT * FROM sync_history WHERE id = ?");
const countSyncHistoryStmt = db.prepare("SELECT COUNT(*) AS count FROM sync_history");
const syncHistorySearchExpression = `LOWER(
  COALESCE(media_type, '') || ' ' ||
  COALESCE(title, '') || ' ' ||
  COALESCE(source, '') || ' ' ||
  CASE
    WHEN LOWER(COALESCE(source, '')) LIKE 'manual%' OR LOWER(COALESCE(source, '')) LIKE 'force_sync%' OR LOWER(COALESCE(source, '')) LIKE 'plembfin%' THEN 'plembfin '
    ELSE ''
  END ||
  COALESCE(status, '') || ' ' ||
  COALESCE(details, '') || ' ' ||
  COALESCE(action, '') || ' ' ||
  COALESCE(target_states, '') || ' ' ||
  COALESCE(raw_payload_debug, '')
) LIKE ? ESCAPE '\\'`;
const selectSyncHistorySearchPageStmt = db.prepare(`SELECT * FROM sync_history WHERE ${syncHistorySearchExpression} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`);
const countSyncHistorySearchStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncHistorySearchExpression}`);

const syncActivityGroupExpression = "COALESCE(NULLIF(activity_group_key, ''), LOWER(COALESCE(media_type, 'unknown')) || '|title:' || LOWER(TRIM(COALESCE(title, 'Unknown media'))))";
// A target that is not present in one of the connected libraries is an
// expected outcome, not a failed sync. Only an actual error/failed target (or
// an overall error with no target-level detail) should keep a current item in
// the attention count. `syncOrchestrator` deliberately normalizes not_found
// library lookups to skipped, so skipped/not_found must stay out of this
// expression even when the overall result is partial.
const syncActivityFailureTargetExpression = "LOWER(COALESCE(target_states, '')) LIKE '%\"status\":\"error\"%' OR LOWER(COALESCE(target_states, '')) LIKE '%\"status\":\"failed\"%'";
const syncActivityProblemExpression = `(
  LOWER(COALESCE(status, '')) IN ('error', 'failed')
  OR (
    LOWER(COALESCE(status, '')) = 'partial'
    AND (${syncActivityFailureTargetExpression})
  )
)`;
const syncActivityPendingExpression = "LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'in_progress', 'in progress')";
// Only the newest event for an activity item is live. Older rows remain in the
// audit trail but must not keep a resolved item looking broken.
const syncActivityLatestItemExpression = `NOT EXISTS (
  SELECT 1 FROM sync_history newer
  WHERE sync_history.activity_item_key IS NOT NULL
    AND sync_history.activity_item_key <> ''
    AND newer.activity_item_key = sync_history.activity_item_key
    AND (newer.timestamp > sync_history.timestamp OR (newer.timestamp = sync_history.timestamp AND newer.id > sync_history.id))
)`;
const countSyncActivityGroupsStmt = db.prepare(`SELECT COUNT(DISTINCT ${syncActivityGroupExpression}) AS count FROM sync_history`);
const countSyncActivityGroupsSearchStmt = db.prepare(`SELECT COUNT(DISTINCT ${syncActivityGroupExpression}) AS count FROM sync_history WHERE ${syncHistorySearchExpression}`);
const countSyncActivityIssueGroupsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM (
    SELECT ${syncActivityGroupExpression} AS activity_group_key
    FROM sync_history
    GROUP BY ${syncActivityGroupExpression}
    HAVING SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) > 0
  )`);
const countSyncActivityIssueGroupsSearchStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM (
    SELECT ${syncActivityGroupExpression} AS activity_group_key
    FROM sync_history
    WHERE ${syncHistorySearchExpression}
    GROUP BY ${syncActivityGroupExpression}
    HAVING SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) > 0
  )`);
const countSyncActivityIssuesStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression})`);
const countSyncActivityIssuesSearchStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncHistorySearchExpression} AND ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression})`);
// The bulk retry action only handles actual target failures. Missing library
// items are deliberately stored as skipped results, and an overall error with
// no failed target response has nothing safe for the action to retry.
const countSyncActivityRetryableStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncActivityLatestItemExpression} AND (${syncActivityFailureTargetExpression})`);
const countSyncActivityRetryableSearchStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncHistorySearchExpression} AND ${syncActivityLatestItemExpression} AND (${syncActivityFailureTargetExpression})`);
const selectSyncActivityGroupsStmt = db.prepare(`
  SELECT
    ${syncActivityGroupExpression} AS activity_group_key,
    COUNT(*) AS event_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END) AS current_item_count,
    MAX(timestamp) AS last_activity,
    MAX(id) AS latest_id,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) AS problem_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityPendingExpression}) THEN 1 ELSE 0 END) AS pending_count
  FROM sync_history
  GROUP BY ${syncActivityGroupExpression}
  ORDER BY last_activity DESC, latest_id DESC
  LIMIT ? OFFSET ?`);
const selectSyncActivityGroupsSearchStmt = db.prepare(`
  SELECT
    ${syncActivityGroupExpression} AS activity_group_key,
    COUNT(*) AS event_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END) AS current_item_count,
    MAX(timestamp) AS last_activity,
    MAX(id) AS latest_id,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) AS problem_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityPendingExpression}) THEN 1 ELSE 0 END) AS pending_count
  FROM sync_history
  WHERE ${syncHistorySearchExpression}
  GROUP BY ${syncActivityGroupExpression}
  ORDER BY last_activity DESC, latest_id DESC
  LIMIT ? OFFSET ?`);
const selectSyncActivityIssueGroupsStmt = db.prepare(`
  SELECT
    ${syncActivityGroupExpression} AS activity_group_key,
    COUNT(*) AS event_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END) AS current_item_count,
    MAX(timestamp) AS last_activity,
    MAX(id) AS latest_id,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) AS problem_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityPendingExpression}) THEN 1 ELSE 0 END) AS pending_count
  FROM sync_history
  GROUP BY ${syncActivityGroupExpression}
  HAVING SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) > 0
  ORDER BY last_activity DESC, latest_id DESC
  LIMIT ? OFFSET ?`);
const selectSyncActivityIssueGroupsSearchStmt = db.prepare(`
  SELECT
    ${syncActivityGroupExpression} AS activity_group_key,
    COUNT(*) AS event_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END) AS current_item_count,
    MAX(timestamp) AS last_activity,
    MAX(id) AS latest_id,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) AS problem_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityPendingExpression}) THEN 1 ELSE 0 END) AS pending_count
  FROM sync_history
  WHERE ${syncHistorySearchExpression}
  GROUP BY ${syncActivityGroupExpression}
  HAVING SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) > 0
  ORDER BY last_activity DESC, latest_id DESC
  LIMIT ? OFFSET ?`);
const selectSyncActivityLatestStmt = db.prepare(`SELECT * FROM sync_history WHERE ${syncActivityGroupExpression} = ? ORDER BY timestamp DESC, id DESC LIMIT 1`);
const selectSyncActivityEventsStmt = db.prepare(`
  SELECT *, CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END AS is_latest_for_item
  FROM sync_history
  WHERE ${syncActivityGroupExpression} = ?
  ORDER BY timestamp DESC, id DESC
  LIMIT ? OFFSET ?`);
const selectSyncActivityLatestEventsStmt = db.prepare(`
  SELECT *, CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END AS is_latest_for_item
  FROM sync_history
  WHERE ${syncActivityGroupExpression} = ?
    AND ${syncActivityLatestItemExpression}
  ORDER BY timestamp DESC, id DESC
  LIMIT ? OFFSET ?`);
const countSyncActivityEventsStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncActivityGroupExpression} = ?`);
const countSyncActivityLatestEventsStmt = db.prepare(`SELECT COUNT(*) AS count FROM sync_history WHERE ${syncActivityGroupExpression} = ? AND ${syncActivityLatestItemExpression}`);
const selectSyncActivityGroupSummaryStmt = db.prepare(`
  SELECT
    ${syncActivityGroupExpression} AS activity_group_key,
    COUNT(*) AS event_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} THEN 1 ELSE 0 END) AS current_item_count,
    MAX(timestamp) AS last_activity,
    MAX(id) AS latest_id,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityProblemExpression}) THEN 1 ELSE 0 END) AS problem_count,
    SUM(CASE WHEN ${syncActivityLatestItemExpression} AND (${syncActivityPendingExpression}) THEN 1 ELSE 0 END) AS pending_count
  FROM sync_history
  WHERE ${syncActivityGroupExpression} = ?
  GROUP BY ${syncActivityGroupExpression}`);
const selectSyncActivityLatestByItemStmt = db.prepare("SELECT * FROM sync_history WHERE activity_item_key = ? ORDER BY timestamp DESC, id DESC LIMIT 1");

const SYNC_HISTORY_MAX_PAGE_SIZE = 200;

function safeSyncHistoryPageSize(value, fallback = 50) {
  return Math.min(Math.max(Number(value) || fallback, 1), SYNC_HISTORY_MAX_PAGE_SIZE);
}

function safeSyncHistoryOffset(value) {
  return Math.max(Math.floor(Number(value) || 0), 0);
}

function syncHistorySearchPattern(value) {
  const normalized = String(value || "").trim().toLowerCase().slice(0, 120);
  if (!normalized) return "";
  return `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
}

function syncHistoryRow(row) {
  const rawPayloadDebug = parseJson(row.raw_payload_debug, {});
  return {
    id: String(row.id),
    timestamp: row.timestamp,
    mediaType: row.media_type,
    title: row.title,
    source: row.source,
    status: row.status,
    details: row.details,
    action: row.action,
    targetStates: parseJson(row.target_states, []),
    rawPayloadDebug,
    activityGroupKey: row.activity_group_key || activityGroupKeyFor({
      mediaType: row.media_type,
      title: row.title,
      source: row.source,
      action: row.action,
      rawPayloadDebug,
    }),
    activityItemKey: row.activity_item_key || activityItemKeyFor({
      mediaType: row.media_type,
      title: row.title,
      source: row.source,
      action: row.action,
      rawPayloadDebug,
    }),
    createdAt: row.created_at,
    ...(Object.prototype.hasOwnProperty.call(row, "is_latest_for_item") ? { isLatestForItem: Boolean(row.is_latest_for_item) } : {}),
  };
}

export async function appendSyncHistory(record) {
  const rawPayloadDebug = record.rawPayloadDebug || {};
  insertSyncHistoryStmt.run({
    timestamp: Date.now(),
    media_type: record.mediaType || "unknown",
    title: record.title || "Unknown media",
    source: record.source || "unknown",
    status: record.status || "unknown",
    details: record.details || "",
    action: record.action || "watched",
    target_states: toJson(Array.isArray(record.targetStates) ? record.targetStates : []),
    raw_payload_debug: toJson(rawPayloadDebug),
    activity_group_key: activityGroupKeyFor({ ...record, rawPayloadDebug }),
    activity_item_key: activityItemKeyFor({ ...record, rawPayloadDebug }),
    created_at: Date.now(),
  });
}

// Sync activity is an audit trail. It intentionally has no age or row-count
// retention policy; pagination keeps the browser response bounded instead.
export function pruneSyncHistory() {
  return false;
}

// Rewrites an existing sync_history row in place with the outcome of a retry,
// rather than appending a duplicate entry for the same action - a retried
// item should read as resolved (success/skipped) or still failing, not sit
// forever alongside a stale "error" row nobody ever clears. The row's prior
// outcome is folded into raw_payload_debug.retryHistory (capped) so it isn't
// lost, just no longer counted as a live failure.
export async function updateSyncHistoryStatus(id, { status, details, action, targetStates, rawPayloadDebug } = {}) {
  const existing = selectSyncHistoryByIdStmt.get(id);
  if (!existing) return false;
  const previousDebug = parseJson(existing.raw_payload_debug, {});
  const retryHistory = Array.isArray(previousDebug.retryHistory) ? previousDebug.retryHistory : [];
  retryHistory.push({ timestamp: Date.now(), previousStatus: existing.status, previousDetails: existing.details });
  updateSyncHistoryStmt.run({
    id,
    timestamp: Date.now(),
    status: status || existing.status,
    details: details != null ? details : existing.details,
    action: action || existing.action,
    target_states: toJson(Array.isArray(targetStates) ? targetStates : parseJson(existing.target_states, [])),
    raw_payload_debug: toJson({ ...previousDebug, ...(rawPayloadDebug || {}), retryHistory: retryHistory.slice(-10) }),
  });
  return true;
}

export async function getSyncHistoryPage({ limit = 50, offset = 0, search = "" } = {}) {
  const safeLimit = safeSyncHistoryPageSize(limit);
  const safeOffset = safeSyncHistoryOffset(offset);
  const searchPattern = syncHistorySearchPattern(search);
  const total = Number(searchPattern ? countSyncHistorySearchStmt.get(searchPattern)?.count : countSyncHistoryStmt.get()?.count) || 0;
  const history = (searchPattern
    ? selectSyncHistorySearchPageStmt.all(searchPattern, safeLimit, safeOffset)
    : selectSyncHistoryPageStmt.all(safeLimit, safeOffset)
  ).map(syncHistoryRow);
  return { history, total, limit: safeLimit, offset: safeOffset };
}

function syncActivityGroupFromRows(summary, latestRow) {
  if (!summary || !latestRow) return null;
  const latest = syncHistoryRow(latestRow);
  return {
    groupKey: String(summary.activity_group_key || latest.activityGroupKey || ""),
    title: activityGroupTitleFromRecord(latest),
    mediaType: activityGroupMediaType(latest),
    timestamp: Number(summary.last_activity || latest.timestamp || 0),
    eventCount: Number(summary.event_count || 0),
    currentItemCount: Number(summary.current_item_count || 0),
    problemCount: Number(summary.problem_count || 0),
    pendingCount: Number(summary.pending_count || 0),
    latest,
  };
}

export async function getSyncActivityGroupsPage({ limit = 50, offset = 0, search = "", failedOnly = false } = {}) {
  const safeLimit = safeSyncHistoryPageSize(limit);
  const safeOffset = safeSyncHistoryOffset(offset);
  const searchPattern = syncHistorySearchPattern(search);
  const onlyIssues = Boolean(failedOnly);
  const total = Number(searchPattern
    ? (onlyIssues ? countSyncActivityIssueGroupsSearchStmt.get(searchPattern)?.count : countSyncActivityGroupsSearchStmt.get(searchPattern)?.count)
    : (onlyIssues ? countSyncActivityIssueGroupsStmt.get()?.count : countSyncActivityGroupsStmt.get()?.count)) || 0;
  const summaries = searchPattern
    ? (onlyIssues
      ? selectSyncActivityIssueGroupsSearchStmt.all(searchPattern, safeLimit, safeOffset)
      : selectSyncActivityGroupsSearchStmt.all(searchPattern, safeLimit, safeOffset))
    : (onlyIssues
      ? selectSyncActivityIssueGroupsStmt.all(safeLimit, safeOffset)
      : selectSyncActivityGroupsStmt.all(safeLimit, safeOffset));
  const groups = summaries.map((summary) => syncActivityGroupFromRows(summary, selectSyncActivityLatestStmt.get(summary.activity_group_key))).filter(Boolean);
  const currentIssueGroupCount = Number(searchPattern
    ? countSyncActivityIssueGroupsSearchStmt.get(searchPattern)?.count
    : countSyncActivityIssueGroupsStmt.get()?.count) || 0;
  const currentIssueCount = Number(searchPattern
    ? countSyncActivityIssuesSearchStmt.get(searchPattern)?.count
    : countSyncActivityIssuesStmt.get()?.count) || 0;
  const retryableCount = Number(searchPattern
    ? countSyncActivityRetryableSearchStmt.get(searchPattern)?.count
    : countSyncActivityRetryableStmt.get()?.count) || 0;
  return { groups, total, currentIssueGroupCount, currentIssueCount, retryableCount, limit: safeLimit, offset: safeOffset };
}

export async function getSyncActivityGroupEvents({ groupKey = "", limit = 200, offset = 0, latestOnly = false } = {}) {
  const key = String(groupKey || "").trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const safeOffset = safeSyncHistoryOffset(offset);
  if (!key) return { group: null, events: [], total: 0, limit: safeLimit, offset: safeOffset };
  const summary = selectSyncActivityGroupSummaryStmt.get(key);
  if (!summary) return { group: null, events: [], total: 0, limit: safeLimit, offset: safeOffset };
  const latest = selectSyncActivityLatestStmt.get(key);
  const events = (latestOnly ? selectSyncActivityLatestEventsStmt : selectSyncActivityEventsStmt)
    .all(key, safeLimit, safeOffset)
    .map(syncHistoryRow);
  return {
    group: syncActivityGroupFromRows(summary, latest),
    events,
    total: Number((latestOnly ? countSyncActivityLatestEventsStmt : countSyncActivityEventsStmt).get(key)?.count) || 0,
    limit: safeLimit,
    offset: safeOffset,
    latestOnly: Boolean(latestOnly),
  };
}

export async function getSyncHistoryById(id) {
  const row = selectSyncHistoryByIdStmt.get(id);
  return row ? syncHistoryRow(row) : null;
}

export async function getLatestSyncActivityByItemKey(key) {
  const activityItemKey = String(key || "").trim();
  if (!activityItemKey) return null;
  const row = selectSyncActivityLatestByItemStmt.get(activityItemKey);
  return row ? syncHistoryRow(row) : null;
}

export async function getSyncHistoryCount() {
  return Number(countSyncHistoryStmt.get()?.count) || 0;
}

export async function getSyncHistory(limit = 50) {
  const page = await getSyncHistoryPage({ limit, offset: 0 });
  return page.history;
}
