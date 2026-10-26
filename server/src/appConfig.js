import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_PATH, ensureDataDirs } from "./paths.js";
import { detectAndMarkPristineInstall, isAccountClaimed } from "./utils/onboardingStore.js";
import { getActiveDataDir, getUserContext, isNonAdminTenantContext } from "./utils/userContext.js";

ensureDataDirs();

function readConfigFile(filePath = CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfigFile(config, filePath = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch { /* non-POSIX FS (Windows, some Docker volumes) */ }
}

function hashPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

// Returns true when the stored hash matches the default "admin" password.
function isDefaultPasswordHash(hash = "") {
  const [scheme, salt, storedHash] = String(hash).split("$");
  if (scheme !== "scrypt" || !salt || !storedHash) return false;
  try {
    const candidate = crypto.scryptSync("admin", salt, 64).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(storedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const MIN_SECRET_LENGTH = 32;

// Auto-generated secrets are always long enough (hex-encoded randomBytes), so
// this only ever fires for a value pinned via env or hand-edited into
// data/config.json - fail fast at startup rather than merely warn.
function assertMinSecretLength(name, value) {
  const length = String(value || "").length;
  if (length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${length}). ` +
      `Set a longer ${name} via environment variable, or remove it from data/config.json to auto-generate one.`,
    );
  }
}

// Set when resolveAuthConfig generates a random password for a brand-new
// install, so logSecuritySummary can print it once. Never persisted in
// plaintext - only the scrypt hash goes into data/config.json.
let generatedInitialPassword = null;

// Resolve the auth config from data/config.json, applying env overrides and
// generating an API key / session secret on first boot. Persists any changes.
function resolveAuthConfig() {
  const stored = readConfigFile();
  let changed = false;
  const authManagedInApp = stored.authManagedInApp === true;

  // Existing/upgraded installs (a managed credential, a media connection, watch
  // history, or configured metadata keys) are marked as already-claimed so they
  // never see the pristine-install account-claim screen.
  const onboarding = detectAndMarkPristineInstall({ authManagedInApp });
  const claimRequired = !authManagedInApp && !process.env.ADMIN_PASSWORD && onboarding.accountClaimed !== true;

  const username = String(authManagedInApp ? stored.username || "admin" : process.env.ADMIN_USERNAME || stored.username || "admin");
  if (stored.username !== username) { stored.username = username; changed = true; }

  // Password: an env override (re)hashes; otherwise keep the stored hash. A
  // pristine, unclaimed install gets no password hash at all - the one-time
  // /api/auth/claim endpoint sets it once an administrator claims the account.
  if (!authManagedInApp && process.env.ADMIN_PASSWORD) {
    stored.passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
    changed = true;
  } else if (!stored.passwordHash && !claimRequired) {
    generatedInitialPassword = crypto.randomBytes(12).toString("base64url");
    stored.passwordHash = hashPassword(generatedInitialPassword);
    changed = true;
  }

  const apiKey = String(process.env.API_KEY || stored.apiKey || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("API_KEY", apiKey);
  if (stored.apiKey !== apiKey) { stored.apiKey = apiKey; changed = true; }

  const webhookSecret = String(process.env.WEBHOOK_SECRET || stored.webhookSecret || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("WEBHOOK_SECRET", webhookSecret);
  if (stored.webhookSecret !== webhookSecret) { stored.webhookSecret = webhookSecret; changed = true; }

  const sessionSecret = String(process.env.SESSION_SECRET || stored.sessionSecret || crypto.randomBytes(32).toString("hex"));
  assertMinSecretLength("SESSION_SECRET", sessionSecret);
  if (stored.sessionSecret !== sessionSecret) { stored.sessionSecret = sessionSecret; changed = true; }

  if (changed) writeConfigFile(stored);
  return stored;
}

const config = resolveAuthConfig();
const tenantConfigs = new Map();

function resolveTenantAuthConfig(dataDir, defaultUsername = "user") {
  const resolvedDir = path.resolve(dataDir);
  if (tenantConfigs.has(resolvedDir)) return tenantConfigs.get(resolvedDir);
  const configPath = path.join(resolvedDir, "config.json");
  const stored = readConfigFile(configPath);
  let changed = false;

  const username = String(stored.username || defaultUsername || "user");
  if (stored.username !== username) { stored.username = username; changed = true; }

  // Non-admin tenants never inherit the admin's API_KEY, WEBHOOK_SECRET,
  // SESSION_SECRET, ADMIN_USERNAME, or ADMIN_PASSWORD environment overrides.
  const apiKey = String(stored.apiKey || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("API_KEY", apiKey);
  if (stored.apiKey !== apiKey) { stored.apiKey = apiKey; changed = true; }

  const webhookSecret = String(stored.webhookSecret || crypto.randomBytes(24).toString("hex"));
  assertMinSecretLength("WEBHOOK_SECRET", webhookSecret);
  if (stored.webhookSecret !== webhookSecret) { stored.webhookSecret = webhookSecret; changed = true; }

  const sessionSecret = String(stored.sessionSecret || crypto.randomBytes(32).toString("hex"));
  assertMinSecretLength("SESSION_SECRET", sessionSecret);
  if (stored.sessionSecret !== sessionSecret) { stored.sessionSecret = sessionSecret; changed = true; }

  if (changed) writeConfigFile(stored, configPath);
  tenantConfigs.set(resolvedDir, stored);
  return stored;
}

export function clearTenantAuthConfigCache(dataDir) {
  if (!dataDir) {
    tenantConfigs.clear();
    return;
  }
  tenantConfigs.delete(path.resolve(dataDir));
}

function activeAuthConfig() {
  if (!isNonAdminTenantContext()) return config;
  const ctx = getUserContext();
  return resolveTenantAuthConfig(getActiveDataDir(), ctx?.name || "user");
}

function activeConfigPath() {
  if (!isNonAdminTenantContext()) return CONFIG_PATH;
  return path.join(getActiveDataDir(), "config.json");
}

// Runs once at startup to warn about insecure configuration.
function logSecuritySummary() {
  const warnings = [];

  if (isDefaultPasswordHash(config.passwordHash)) {
    warnings.push("ADMIN PASSWORD IS DEFAULT ('admin') - change it immediately in Settings \u2192 General");
  } else if (!config.authManagedInApp && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 8) {
    warnings.push("ADMIN_PASSWORD is shorter than 8 characters - use a stronger password");
  }

  const pinned = [];
  const generated = [];
  if (process.env.API_KEY) pinned.push("API_KEY"); else generated.push("API_KEY");
  if (process.env.WEBHOOK_SECRET) pinned.push("WEBHOOK_SECRET"); else generated.push("WEBHOOK_SECRET");
  if (process.env.SESSION_SECRET) pinned.push("SESSION_SECRET"); else generated.push("SESSION_SECRET");

  if (warnings.length > 0) {
    console.warn("\u26a0\ufe0f  Security warnings:");
    for (const w of warnings) console.warn(`   \u2022 ${w}`);
  }
  if (generated.length > 0) {
    console.log("[security] Auto-generated secrets are persisted in data/config.json.");
  }
  if (pinned.length > 0) {
    console.log("[security] Pinned secrets were loaded from the environment.");
  }
  if (config.authManagedInApp && (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD)) {
    console.warn("[security] Admin credentials are managed in-app; ADMIN_USERNAME/ADMIN_PASSWORD environment variables are ignored (remove authManagedInApp from data/config.json to restore env control).");
  }
  if (generatedInitialPassword) {
    console.warn("\u26a0\ufe0f  An initial admin password was generated. Set ADMIN_PASSWORD before first start or use the in-app recovery flow.");
  }
  if (isClaimRequired()) {
    console.log("[security] Pristine install detected - open the app to claim the administrator account. No password was generated.");
  }
}

logSecuritySummary();

export const AUTH = {
  get username() { return activeAuthConfig().username; },
  set username(value) { activeAuthConfig().username = value; },
  get apiKey() { return activeAuthConfig().apiKey; },
  set apiKey(value) { activeAuthConfig().apiKey = value; },
  get webhookSecret() { return activeAuthConfig().webhookSecret; },
  set webhookSecret(value) { activeAuthConfig().webhookSecret = value; },
  get sessionSecret() { return activeAuthConfig().sessionSecret; },
  set sessionSecret(value) { activeAuthConfig().sessionSecret = value; },
};

export function getRootSessionSecret() {
  return config.sessionSecret;
}

export function getRootAdminUsername() {
  return config.username;
}

function verifyPasswordAgainstHash(plain, stored = "") {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyRootAdminUsername(name) {
  if (!name || !config.username) return false;
  const a = Buffer.from(String(name));
  const b = Buffer.from(config.username);
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyRootAdminPassword(plain) {
  return verifyPasswordAgainstHash(plain, config.passwordHash);
}

// scrypt is ~45ms on the event loop and auth/status is polled, so the answer is
// memoized per stored hash; any credential change produces a new hash.
let defaultPasswordMemo = { hash: null, value: false };
export function isDefaultPassword() {
  if (isNonAdminTenantContext()) return false;
  const hash = activeAuthConfig().passwordHash;
  if (defaultPasswordMemo.hash !== hash) {
    defaultPasswordMemo = { hash, value: isDefaultPasswordHash(hash) };
  }
  return defaultPasswordMemo.value;
}

// True while a pristine install has no path to sign in yet: no in-app
// credentials have been claimed, and no ADMIN_PASSWORD env override exists.
// Non-admin tenants are created with a password in users.json, so they skip
// the administrator account-claim gate and go straight to guided setup.
export function isClaimRequired() {
  if (isNonAdminTenantContext()) return false;
  const active = activeAuthConfig();
  if (active.authManagedInApp === true) return false;
  if (process.env.ADMIN_PASSWORD) return false;
  return !isAccountClaimed();
}

export function verifyWebhookToken(token) {
  if (!token || !AUTH.webhookSecret) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(AUTH.webhookSecret);
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; }
}

export function rotateWebhookSecret() {
  const active = activeAuthConfig();
  const newSecret = crypto.randomBytes(24).toString("hex");
  const nextConfig = { ...active, webhookSecret: newSecret };
  writeConfigFile(nextConfig, activeConfigPath());
  Object.assign(active, nextConfig);
  return newSecret;
}

export function verifyPassword(plain) {
  return verifyPasswordAgainstHash(plain, activeAuthConfig().passwordHash);
}

export function verifyUsername(name) {
  const active = activeAuthConfig();
  if (!name || !active.username) return false;
  const a = Buffer.from(String(name));
  const b = Buffer.from(active.username);
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function resetAdminAccount() {
  if (isNonAdminTenantContext()) {
    const resolvedDir = path.resolve(getActiveDataDir());
    const configPath = path.join(resolvedDir, "config.json");
    writeConfigFile({}, configPath);
    tenantConfigs.delete(resolvedDir);
    const fresh = resolveTenantAuthConfig(resolvedDir, getUserContext()?.name || "user");
    return { username: fresh.username };
  }
  writeConfigFile({});
  const fresh = resolveAuthConfig();
  Object.assign(config, fresh);
  return { username: config.username };
}

export function updateRootAdminCredentials({ username, password = "" }) {
  const nextUsername = String(username || "").trim();
  if (!nextUsername) throw new Error("Username is required");

  const nextConfig = {
    ...config,
    username: nextUsername,
    authManagedInApp: true,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
  };
  if (password) nextConfig.passwordHash = hashPassword(password);
  writeConfigFile(nextConfig, CONFIG_PATH);
  Object.assign(config, nextConfig);

  return { username: config.username };
}

export function updateAdminCredentials({ username, password = "" }) {
  return updateRootAdminCredentials({ username, password });
}
