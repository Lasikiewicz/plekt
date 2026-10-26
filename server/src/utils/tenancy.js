import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, FULL_BACKUPS_DIR } from "../paths.js";

// Multi-user registry, path helpers, and account management for a single Node process.
// users.json with at least one non-admin user turns multi-user mode on.
// The admin's data stays at DATA_DIR; other users live under DATA_DIR/users/<name>/.

export const USERS_REGISTRY_FILE = "users.json";
export const USERS_SUBDIR = "users";
export const ADMIN_ROLE = "admin";
export const ADMINISTRATOR_ROLE = "administrator";
export const USER_ROLE = "user";
export const ADMIN_KEY = "admin";
export const MIN_PASSWORD_LENGTH = 8;

// Lowercase, starts with a letter or digit, then letters/digits/_/-, max 32.
// Rejects path separators, dots-only, and Windows reserved device names.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Adding/renaming accounts from the UI requires 2-32 chars (matching the UI help).
export const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const INVALID_NAME_MESSAGE = "Use 2 to 32 letters, numbers, dashes, or underscores, starting with a letter or number.";

const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const FULL_BACKUPS_SUBDIR = path.basename(FULL_BACKUPS_DIR);

export function hashUserPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyUserPasswordHash(plain, storedHash = "") {
  const [scheme, salt, hash] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  try {
    const candidate = crypto.scryptSync(String(plain), salt, 64).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function usersRegistryPath(rootDataDir = DATA_DIR) {
  return path.join(rootDataDir, USERS_REGISTRY_FILE);
}

export function normalizeUserName(name) {
  return String(name || "").trim().toLowerCase();
}

export function validateUserName(name) {
  const normalized = normalizeUserName(name);
  if (!NAME_RE.test(normalized)) {
    return { ok: false, error: "User name must be 1-32 characters: letters, digits, _ or -" };
  }
  if (WINDOWS_RESERVED.has(normalized)) {
    return { ok: false, error: "That user name is reserved" };
  }
  return { ok: true, name: normalized };
}

export function validateAccountUserName(name) {
  const normalized = normalizeUserName(name);
  if (!ACCOUNT_NAME_PATTERN.test(normalized) || WINDOWS_RESERVED.has(normalized)) {
    return { ok: false, error: INVALID_NAME_MESSAGE };
  }
  return { ok: true, name: normalized };
}

function emptyRegistry() {
  return { version: 1, users: [] };
}

export function loadUsersRegistry(rootDataDir = DATA_DIR) {
  const filePath = usersRegistryPath(rootDataDir);
  if (!fs.existsSync(filePath)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    return {
      version: Number(parsed?.version) || 1,
      users: users
        .map((entry) => {
          const name = normalizeUserName(entry?.name);
          if (!name) return null;
          const role = [ADMIN_ROLE, ADMINISTRATOR_ROLE].includes(entry?.role) ? entry.role : USER_ROLE;
          return {
            name,
            role,
            disabled: Boolean(entry?.disabled),
            stopped: Boolean(entry?.stopped),
            sessionsValidAfter: Number(entry?.sessionsValidAfter) || 0,
            passwordHash: typeof entry?.passwordHash === "string" ? entry.passwordHash : null,
          };
        })
        .filter(Boolean),
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveUsersRegistry(registry, rootDataDir = DATA_DIR) {
  const filePath = usersRegistryPath(rootDataDir);
  const payload = {
    version: Number(registry?.version) || 1,
    users: Array.isArray(registry?.users) ? registry.users : [],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* non-POSIX */ }
  return payload;
}

export function listNonAdminUsers(rootDataDir = DATA_DIR) {
  return loadUsersRegistry(rootDataDir).users.filter((user) => user.role !== ADMIN_ROLE);
}

export function listActiveTenants(rootDataDir = DATA_DIR) {
  return listNonAdminUsers(rootDataDir)
    .filter((user) => !user.disabled && !user.stopped)
    .map((user) => ({
      name: user.name,
      role: USER_ROLE,
      dataDir: tenantDataDir(user.name, rootDataDir),
      stopped: false,
      disabled: false,
      sessionsValidAfter: Number(user.sessionsValidAfter) || 0,
    }));
}

export function multiUserEnabled(rootDataDir = DATA_DIR) {
  return listNonAdminUsers(rootDataDir).length > 0;
}

export function findUser(name, rootDataDir = DATA_DIR) {
  const normalized = normalizeUserName(name);
  return loadUsersRegistry(rootDataDir).users.find((user) => user.name === normalized) || null;
}

export function resolveAdminUserName(rootDataDir = DATA_DIR) {
  const listed = loadUsersRegistry(rootDataDir).users.find((user) => user.role === ADMIN_ROLE);
  if (listed?.name) return listed.name;
  try {
    const configPath = path.join(rootDataDir, "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const fromConfig = normalizeUserName(config?.username || config?.ADMIN_USERNAME || config?.adminUsername);
      if (fromConfig) return fromConfig;
    }
  } catch { /* ignore */ }
  return "admin";
}

export function isAdminUserName(name, rootDataDir = DATA_DIR) {
  const normalized = normalizeUserName(name);
  return normalized === ADMIN_KEY || normalized === resolveAdminUserName(rootDataDir);
}

// When multi-user mode is on, map a URL user segment (or session activeUser) to
// that user's data folder. Returns null when multi-user is off, the name is
// invalid, unknown, disabled, or stopped (unless allowStopped is true).
export function resolveActiveTenant(name, rootDataDir = DATA_DIR, { allowStopped = false } = {}) {
  if (!multiUserEnabled(rootDataDir)) return null;
  const validated = validateUserName(name);
  if (!validated.ok) return null;
  const adminName = resolveAdminUserName(rootDataDir);
  if (validated.name === adminName || validated.name === ADMIN_KEY) {
    return { name: adminName, role: ADMIN_ROLE, dataDir: rootDataDir, stopped: false, disabled: false };
  }
  const user = findUser(validated.name, rootDataDir);
  if (!user || user.role === ADMIN_ROLE || user.disabled) return null;
  if (user.stopped && !allowStopped) return null;
  return {
    name: user.name,
    role: USER_ROLE,
    dataDir: tenantDataDir(user.name, rootDataDir),
    stopped: Boolean(user.stopped),
    disabled: Boolean(user.disabled),
    sessionsValidAfter: Number(user.sessionsValidAfter) || 0,
  };
}

export function tenantDataDir(name, rootDataDir = DATA_DIR) {
  const normalized = normalizeUserName(name);
  if (!normalized) return rootDataDir;
  if (normalized === ADMIN_KEY || normalized === resolveAdminUserName(rootDataDir)) return rootDataDir;
  const listed = findUser(normalized, rootDataDir);
  if (listed?.role === ADMIN_ROLE) return rootDataDir;
  return path.join(rootDataDir, USERS_SUBDIR, normalized);
}

export function ensureTenantDataDir(name, rootDataDir = DATA_DIR) {
  const dir = tenantDataDir(name, rootDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "backups", "watch-history"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backups", FULL_BACKUPS_SUBDIR), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

export function resolveTenantFromRequestPath(pathname) {
  const match = /^\/u\/([^/]+)(\/api(?:\/.*)?)?$/i.exec(String(pathname || ""));
  if (!match) return null;
  const validated = validateUserName(match[1]);
  if (!validated.ok) return null;
  return {
    name: validated.name,
    apiPath: match[2] || "/api",
  };
}

// --- User account management helpers (Step 7) ------------------------------

function isNameTaken(rootDataDir, registry, name) {
  const normalized = normalizeUserName(name);
  if (normalized === ADMIN_KEY || normalized === resolveAdminUserName(rootDataDir)) return true;
  return registry.users.some((user) => user.name === normalized);
}

function safeUserFolder(rootDataDir, name) {
  const validated = validateAccountUserName(name);
  if (!validated.ok || validated.name === ADMIN_KEY) return null;
  const folder = path.resolve(rootDataDir, USERS_SUBDIR, validated.name);
  return path.dirname(folder) === path.resolve(rootDataDir, USERS_SUBDIR) ? folder : null;
}

export function listUserAccounts(rootDataDir = DATA_DIR) {
  const adminLabel = resolveAdminUserName(rootDataDir);
  const others = listNonAdminUsers(rootDataDir).map((user) => ({
    name: user.name,
    key: user.name,
    role: user.role,
    isAdmin: user.role === ADMINISTRATOR_ROLE,
    isInstallAdmin: false,
    disabled: Boolean(user.disabled),
    stopped: Boolean(user.stopped),
  }));
  return [
    { name: adminLabel, key: ADMIN_KEY, role: ADMIN_ROLE, isAdmin: true, isInstallAdmin: true, disabled: false, stopped: false },
    ...others,
  ];
}

export function addUserAccount({ dataDir = DATA_DIR, name: rawName, password }) {
  const validated = validateAccountUserName(rawName);
  if (!validated.ok) {
    return { status: 400, body: { error: validated.error, code: "INVALID_NAME" } };
  }
  const name = validated.name;
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    return {
      status: 400,
      body: { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the starting password.`, code: "PASSWORD_TOO_SHORT" },
    };
  }
  const registry = loadUsersRegistry(dataDir);
  if (isNameTaken(dataDir, registry, name)) {
    return { status: 409, body: { error: "That user name is already taken.", code: "NAME_TAKEN" } };
  }

  // Create the folder first: if it fails, users.json is left untouched. A
  // folder kept from a removed user of the same name is reused as-is.
  ensureTenantDataDir(name, dataDir);
  registry.users.push({
    name,
    role: USER_ROLE,
    disabled: false,
    stopped: false,
    sessionsValidAfter: 0,
    passwordHash: hashUserPassword(password),
  });
  saveUsersRegistry(registry, dataDir);
  return { status: 201, body: { ok: true, user: { name }, restartRequired: false } };
}

export function setUserPasswordAccount({ dataDir = DATA_DIR, name: rawName, password }) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    return {
      status: 400,
      body: { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`, code: "PASSWORD_TOO_SHORT" },
    };
  }
  const registry = loadUsersRegistry(dataDir);
  const normalized = normalizeUserName(rawName);
  const user = registry.users.find((entry) => entry.name === normalized && entry.role !== ADMIN_ROLE);
  if (!user) return { status: 404, body: { error: "No such user.", code: "NO_SUCH_USER" } };
  user.passwordHash = hashUserPassword(password);
  saveUsersRegistry(registry, dataDir);
  return { status: 200, body: { ok: true, user: { name: user.name } } };
}

function updateUserEntry(dataDir, rawName, mutator) {
  const registry = loadUsersRegistry(dataDir);
  const normalized = normalizeUserName(rawName);
  const user = registry.users.find((entry) => entry.name === normalized && entry.role !== ADMIN_ROLE);
  if (!user) return { status: 404, body: { error: "No such user.", code: "NO_SUCH_USER" } };
  mutator(user);
  saveUsersRegistry(registry, dataDir);
  return { status: 200, body: { ok: true, user: { name: user.name } } };
}

export function signOutUser({ dataDir = DATA_DIR, name }) {
  return updateUserEntry(dataDir, name, (user) => {
    user.sessionsValidAfter = Date.now();
  });
}

export function setUserDisabled({ dataDir = DATA_DIR, name, disabled }) {
  return updateUserEntry(dataDir, name, (user) => {
    user.disabled = Boolean(disabled);
    if (user.disabled) user.sessionsValidAfter = Date.now();
  });
}

export function setUserStopped({ dataDir = DATA_DIR, name, stopped }) {
  return updateUserEntry(dataDir, name, (user) => {
    user.stopped = Boolean(stopped);
  });
}

export function setUserAdministrator({ dataDir = DATA_DIR, name, administrator }) {
  return updateUserEntry(dataDir, name, (user) => {
    user.role = administrator ? ADMINISTRATOR_ROLE : USER_ROLE;
    user.sessionsValidAfter = Date.now();
  });
}

export function checkRename({ dataDir = DATA_DIR, name: rawName, newName: rawNewName }) {
  const name = normalizeUserName(rawName);
  const newName = normalizeUserName(rawNewName);
  const registry = loadUsersRegistry(dataDir);
  const existing = registry.users.find((entry) => entry.name === name && entry.role !== ADMIN_ROLE);
  if (!existing) return { status: 404, body: { error: "No such user.", code: "NO_SUCH_USER" } };
  const validated = validateAccountUserName(newName);
  if (!validated.ok) return { status: 400, body: { error: validated.error, code: "INVALID_NAME" } };
  if (newName === name) return { status: 400, body: { error: "That is already this user's name.", code: "SAME_NAME" } };
  if (isNameTaken(dataDir, registry, newName)) {
    return { status: 409, body: { error: "That user name is already taken.", code: "NAME_TAKEN" } };
  }
  const target = safeUserFolder(dataDir, newName);
  if (!target || fs.existsSync(target)) {
    return {
      status: 409,
      body: { error: `A folder named data/users/${newName} already exists. Remove it or choose another name.`, code: "FOLDER_EXISTS" },
    };
  }
  return null;
}

export function renameUserAccount({ dataDir = DATA_DIR, name: rawName, newName: rawNewName, beforeFolderMove = null }) {
  const refused = checkRename({ dataDir, name: rawName, newName: rawNewName });
  if (refused) return refused;
  const name = normalizeUserName(rawName);
  const newName = normalizeUserName(rawNewName);
  const source = safeUserFolder(dataDir, name);
  const target = safeUserFolder(dataDir, newName);
  if (typeof beforeFolderMove === "function" && source) {
    try { beforeFolderMove(source); } catch { /* ignore */ }
  }
  try {
    if (source && fs.existsSync(source)) fs.renameSync(source, target);
    else ensureTenantDataDir(newName, dataDir);
  } catch (error) {
    return {
      status: 500,
      body: { error: `The user's folder could not be moved (${error.code || error.message}). Nothing was changed.`, code: "FOLDER_MOVE_FAILED" },
    };
  }
  const registry = loadUsersRegistry(dataDir);
  const user = registry.users.find((entry) => entry.name === name && entry.role !== ADMIN_ROLE);
  user.name = newName;
  user.sessionsValidAfter = Date.now();
  saveUsersRegistry(registry, dataDir);
  return { status: 200, body: { ok: true, user: { name: newName }, previousName: name } };
}

export function removeUserAccount({ dataDir = DATA_DIR, name: rawName, deleteData = false, beforeFolderRemove = null }) {
  const name = normalizeUserName(rawName);
  const registry = loadUsersRegistry(dataDir);
  const existing = registry.users.find((entry) => entry.name === name && entry.role !== ADMIN_ROLE);
  if (!existing) return { status: 404, body: { error: "No such user.", code: "NO_SUCH_USER" } };
  registry.users = registry.users.filter((entry) => !(entry.role !== ADMIN_ROLE && entry.name === name));
  saveUsersRegistry(registry, dataDir);
  const folder = safeUserFolder(dataDir, name);
  if (typeof beforeFolderRemove === "function" && folder) {
    try { beforeFolderRemove(folder); } catch { /* ignore */ }
  }
  const body = { ok: true, user: { name }, dataDeleted: false };
  if (deleteData === true) {
    try {
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      body.dataDeleted = Boolean(folder);
    } catch (error) {
      body.warning = `The user was removed, but their folder could not be deleted (${error.code || error.message}).`;
    }
  }
  return { status: 200, body };
}
