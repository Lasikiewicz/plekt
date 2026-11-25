// Configurable sync heuristics. This module imports nothing else in the repo
// (env-only reads) so configStore.js - which already imports outbound.js -
// can import this module too without creating an import cycle.
//
// Each value has an env var, a default equal to the previous hardcoded
// literal, and a clamp range. `applyTuningConfig` lets configStore.js layer
// stored settings over the env/default without this module reading the
// settings table itself.

const DEFAULTS = {
  watchedThresholdPercent: 90,
  minResumePositionSec: 60,
  activeSessionTtlMin: 5,
  outboundTimeoutSec: 10,
};

const CLAMPS = {
  watchedThresholdPercent: [50, 100],
  minResumePositionSec: [0, 3600],
  activeSessionTtlMin: [1, 120],
  outboundTimeoutSec: [2, 120],
};

const ENV_VARS = {
  watchedThresholdPercent: "WATCHED_THRESHOLD_PERCENT",
  minResumePositionSec: "MIN_RESUME_POSITION_SEC",
  activeSessionTtlMin: "ACTIVE_SESSION_TTL_MIN",
  outboundTimeoutSec: "OUTBOUND_TIMEOUT_SEC",
};

// A watched flag coming from a media app is not always accompanied by a
// trustworthy playback timestamp. Keep the import policy separate from the
// numeric tuning values above so existing callers/tests that consume those
// maps keep their original shape.
export const WATCH_IMPORT_MODES = Object.freeze([
  "now",
  "release_day",
  "episode_timing",
  "review",
]);
export const DEFAULT_WATCH_IMPORT_MODE = "review";
const WATCH_IMPORT_MODE_ENV = "WATCH_IMPORT_MODE";

function readWatchImportModeEnv() {
  const value = String(process.env[WATCH_IMPORT_MODE_ENV] || "").trim().toLowerCase();
  return WATCH_IMPORT_MODES.includes(value) ? value : DEFAULT_WATCH_IMPORT_MODE;
}

// Plex's server API has no supported way to set a historical play date: a
// scrobble is always recorded using the server's current time. Emby, Jellyfin,
// and Trakt can all carry the original date, so this policy is scoped to Plex
// alone and only to *historical* watched projections (imports, restores,
// backdated manual marks, backfills). Live and mark-watched-now actions are
// never routed through it, and unwatch is never gated by it at all. Default on,
// because a Plex library that silently disagrees with Plembfin is the worse
// surprise; turning it off is the opt-out for users who do not want an import
// to create Plex activity dated today.
export const DEFAULT_PLEX_HISTORICAL_WATCHED_SYNC = true;
const PLEX_HISTORICAL_WATCHED_SYNC_ENV = "PLEX_HISTORICAL_WATCHED_SYNC";

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const AUDIT_RETENTION_DAYS_RANGE = Object.freeze([0, 3650]);
const AUDIT_RETENTION_DAYS_ENV = "AUDIT_RETENTION_DAYS";

function readAuditRetentionDaysEnv() {
  const raw = process.env[AUDIT_RETENTION_DAYS_ENV];
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_AUDIT_RETENTION_DAYS;
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.min(AUDIT_RETENTION_DAYS_RANGE[1], Math.max(AUDIT_RETENTION_DAYS_RANGE[0], Math.round(num)));
}

function readPlexHistoricalWatchedSyncEnv() {
  const raw = String(process.env[PLEX_HISTORICAL_WATCHED_SYNC_ENV] ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_PLEX_HISTORICAL_WATCHED_SYNC;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return DEFAULT_PLEX_HISTORICAL_WATCHED_SYNC;
}

function clamp(key, value) {
  const [min, max] = CLAMPS[key];
  return Math.min(max, Math.max(min, value));
}

function readEnvValue(key) {
  const raw = process.env[ENV_VARS[key]];
  if (raw === undefined || String(raw).trim() === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return clamp(key, num);
}

function envOrDefault(key) {
  const envValue = readEnvValue(key);
  return envValue === null ? DEFAULTS[key] : envValue;
}

// Effective values, refreshed by applyTuningConfig() on boot and on every
// settings save. Start out env/default so a getter call before the config
// store has loaded still returns a safe value.
let effective = {
  watchedThresholdPercent: envOrDefault("watchedThresholdPercent"),
  minResumePositionSec: envOrDefault("minResumePositionSec"),
  activeSessionTtlMin: envOrDefault("activeSessionTtlMin"),
  outboundTimeoutSec: envOrDefault("outboundTimeoutSec"),
};
let effectiveWatchImportMode = readWatchImportModeEnv();
let effectivePlexHistoricalWatchedSync = readPlexHistoricalWatchedSyncEnv();
let effectiveAuditRetentionDays = readAuditRetentionDaysEnv();

// Stored settings use null for "use the environment/default". Invalid values
// are normalized to null here and rejected by configStore.validateConfig when
// they arrive through the settings API.
export function normalizeWatchImportMode(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  return WATCH_IMPORT_MODES.includes(normalized) ? normalized : null;
}

// Same null-means-not-overridden contract as the fields above. Accepts the
// string forms a JSON settings payload or a hand-edited config can carry.
export function normalizePlexHistoricalWatchedSync(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return null;
}

export function normalizeAuditRetentionDays(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

// Normalizes a raw stored/incoming tuning section (numbers-or-null/blank) into
// { key: number|null } - null means "not overridden, fall back to env/default".
// Deliberately does NOT clamp: out-of-range values are rejected by
// validateConfig() in configStore.js rather than silently corrected here, so
// bad input via the settings API produces a validation error instead of a
// value that quietly differs from what the admin typed.
export function normalizeTuningSection(raw = {}) {
  const normalized = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw?.[key];
    if (value === null || value === undefined || String(value).trim() === "") {
      normalized[key] = null;
      continue;
    }
    const num = Number(value);
    normalized[key] = Number.isFinite(num) ? num : null;
  }
  return normalized;
}

// Applies a normalized (or raw) tuning section as the current effective
// values: an explicit non-null field overrides env/default; null/missing
// falls back to env/default. Call on boot and after every settings save.
// Clamps as a safety net for out-of-range values that reach storage some
// other way (hand-edited config.json, older data) - normal saves are already
// range-checked by validateConfig() before they ever get here.
export function applyTuningConfig(section = {}) {
  const normalized = normalizeTuningSection(section);
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    next[key] = normalized[key] === null ? envOrDefault(key) : clamp(key, normalized[key]);
  }
  effective = next;
  effectiveWatchImportMode = normalizeWatchImportMode(section?.watchImportMode) || readWatchImportModeEnv();
  const historicalOverride = normalizePlexHistoricalWatchedSync(section?.plexHistoricalWatchedSync);
  effectivePlexHistoricalWatchedSync = historicalOverride === null ? readPlexHistoricalWatchedSyncEnv() : historicalOverride;
  const auditOverride = normalizeAuditRetentionDays(section?.auditRetentionDays);
  effectiveAuditRetentionDays = auditOverride === null
    ? readAuditRetentionDaysEnv()
    : Math.min(AUDIT_RETENTION_DAYS_RANGE[1], Math.max(AUDIT_RETENTION_DAYS_RANGE[0], auditOverride));
  return effective;
}

// Test-only: restores the module to its env/default state, undoing any
// applyTuningConfig() call. Re-reads env vars so tests that set/unset env
// vars between calls see the change.
export function resetTuningForTests() {
  effective = {
    watchedThresholdPercent: envOrDefault("watchedThresholdPercent"),
    minResumePositionSec: envOrDefault("minResumePositionSec"),
    activeSessionTtlMin: envOrDefault("activeSessionTtlMin"),
    outboundTimeoutSec: envOrDefault("outboundTimeoutSec"),
  };
  effectiveWatchImportMode = readWatchImportModeEnv();
  effectivePlexHistoricalWatchedSync = readPlexHistoricalWatchedSyncEnv();
  effectiveAuditRetentionDays = readAuditRetentionDaysEnv();
}

export function watchedThresholdPercent() {
  return effective.watchedThresholdPercent;
}

export function minResumePositionMs() {
  return effective.minResumePositionSec * 1000;
}

export function activeSessionTtlMs() {
  return effective.activeSessionTtlMin * 60 * 1000;
}

export function outboundTimeoutMs() {
  return effective.outboundTimeoutSec * 1000;
}

export function watchImportMode() {
  return effectiveWatchImportMode;
}

export function watchImportModeDefault() {
  return readWatchImportModeEnv();
}

export function plexHistoricalWatchedSyncEnabled() {
  return effectivePlexHistoricalWatchedSync;
}

export function plexHistoricalWatchedSyncDefault() {
  return readPlexHistoricalWatchedSyncEnv();
}

export function auditRetentionDays() {
  return effectiveAuditRetentionDays;
}

export function auditRetentionDaysDefault() {
  return readAuditRetentionDaysEnv();
}

export function tuningDefaults() {
  return { ...DEFAULTS };
}

export function tuningClamps() {
  return { ...CLAMPS };
}

// Env-or-hardcoded-default per key, ignoring any stored config override.
// Used by configStore.js to show the effective placeholder when a field is
// unset, and as the base for envMediaConfig().
export function tuningEnvDefaults() {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) result[key] = envOrDefault(key);
  return result;
}
