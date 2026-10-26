import path from "node:path";
import { DATA_DIR } from "../paths.js";
import { writeAuditLog } from "../db.js";
import { isSameOrigin, requireAdmin, requireInstallAdmin, setSessionCookie } from "../utils/auth.js";
import { clearTenantAuthConfigCache, getRootAdminUsername, updateRootAdminCredentials, verifyRootAdminPassword } from "../appConfig.js";
import { getOnboardingState } from "../utils/onboardingStore.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson } from "../utils/http.js";
import { closeTenantDatabase } from "../utils/tenantDatabase.js";
import {
  ADMIN_KEY,
  ADMIN_ROLE,
  MIN_PASSWORD_LENGTH,
  addUserAccount,
  checkRename,
  findUser,
  isAdminUserName,
  listUserAccounts,
  multiUserEnabled,
  normalizeUserName,
  removeUserAccount,
  renameUserAccount,
  resolveActiveTenant,
  setUserDisabled,
  setUserAdministrator,
  setUserPasswordAccount,
  setUserStopped,
  signOutUser,
  tenantDataDir,
} from "../utils/tenancy.js";
import { runAsAdmin, runWithUserContext } from "../utils/userContext.js";

const PROCESS_STARTED_AT = Date.now();
const ADMIN_ACTIONS = new Set(["restart", "open"]);
const ACTIONS = new Set(["open", "restart", "stop", "start", "sign-out", "disable", "enable", "make-admin", "remove-admin", "rename", "remove"]);
const LEAVES_INSTANCE = new Set(["stop", "rename", "remove"]);

export { listUserAccounts };

function needsSetupForContext() {
  try {
    const state = getOnboardingState();
    return state.runState !== "completed" && !state.ctaDismissedAt;
  } catch {
    return true;
  }
}

export function resolveLandingPathForUser(name, rootDataDir = DATA_DIR) {
  const normalized = normalizeUserName(name);
  if (!normalized || normalized === ADMIN_KEY || isAdminUserName(normalized, rootDataDir)) {
    const needsSetup = runAsAdmin(() => needsSetupForContext());
    return needsSetup ? "/setup" : "/";
  }
  const tenant = resolveActiveTenant(normalized, rootDataDir);
  if (!tenant) return "/";
  const needsSetup = runWithUserContext(tenant, () => needsSetupForContext());
  return needsSetup ? "/setup" : "/";
}

function enrichUserAccounts(principal, rootDataDir = DATA_DIR) {
  const activeKey = principal?.activeUser || ADMIN_KEY;
  const rssBytes = process.memoryUsage?.().rss || null;
  return listUserAccounts(rootDataDir).map((user) => {
    const key = user.isInstallAdmin ? ADMIN_KEY : user.name;
    const isActive = activeKey === key || (user.isInstallAdmin && isAdminUserName(activeKey, rootDataDir));
    const state = user.stopped ? "stopped" : "running";
    return {
      ...user,
      key,
      active: isActive,
      instance: {
        state,
        startedAt: state === "running" ? PROCESS_STARTED_AT : null,
        restarts: 0,
        memoryBytes: state === "running" ? rssBytes : null,
      },
    };
  });
}

// GET lists the users (admin only); POST adds one (admin only).
export async function handleUsers(req, res) {
  const principal = await requireAdmin(req, res);
  if (!principal) return;
  if (!(await requireInstallAdmin(req, res))) return;

  if (req.method === "GET") {
    return sendJson(res, {
      supervised: multiUserEnabled(DATA_DIR),
      users: enrichUserAccounts(principal, DATA_DIR),
      process: {
        startedAt: PROCESS_STARTED_AT,
        memoryBytes: process.memoryUsage?.().rss || null,
      },
    });
  }
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED" }, 403);

  const body = await readJson(req).catch(() => ({}));
  const result = addUserAccount({ dataDir: DATA_DIR, name: body.name, password: body.password });
  if (result.status === 201) {
    runAsAdmin(() => writeAuditLog("users.added", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { name: result.body.user.name, by: principal.loginUsername || principal.username },
    }));
  }
  return sendJson(res, result.body, result.status);
}

// POST users/password sets a user's password. Only the install admin reaches it.
export async function handleUserPassword(req, res) {
  const principal = await requireAdmin(req, res);
  if (!principal) return;
  if (!(await requireInstallAdmin(req, res))) return;
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED" }, 403);

  const body = await readJson(req).catch(() => ({}));
  const targetName = normalizeUserName(body.name);
  if (isAdminUserName(targetName, DATA_DIR)) {
    const password = String(body.password || "");
    if (!verifyRootAdminPassword(String(body.current || ""))) {
      return sendJson(res, { error: "The current password is not right.", code: "CURRENT_PASSWORD_WRONG" }, 403);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return sendJson(res, { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`, code: "PASSWORD_TOO_SHORT" }, 400);
    }
    const adminUsername = getRootAdminUsername();
    updateRootAdminCredentials({ username: adminUsername, password });
    runAsAdmin(() => writeAuditLog("users.password.changed", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { name: adminUsername, by: principal.loginUsername || principal.username },
    }));
    setSessionCookie(res, adminUsername, { role: ADMIN_ROLE, activeUser: principal.activeUser || ADMIN_KEY });
    return sendJson(res, { ok: true, user: { name: adminUsername } });
  }

  const result = setUserPasswordAccount({ dataDir: DATA_DIR, name: targetName, password: body.password });
  if (result.status === 200) {
    runAsAdmin(() => writeAuditLog("users.password.changed", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { name: result.body.user.name, by: principal.loginUsername || principal.username },
    }));
  }
  return sendJson(res, result.body, result.status);
}

// POST users/manage: open (switch active user), start, stop, restart, disable,
// enable, sign-out, rename, or remove a user in-process.
export async function handleUserManage(req, res) {
  const principal = await requireAdmin(req, res);
  if (!principal) return;
  if (!(await requireInstallAdmin(req, res))) return;
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED" }, 403);

  const body = await readJson(req).catch(() => ({}));
  const action = String(body.action || "");
  const rawName = normalizeUserName(body.name);
  if (!ACTIONS.has(action)) {
    return sendJson(res, { error: "Unknown action.", code: "UNKNOWN_ACTION" }, 400);
  }

  const targetIsAdmin = isAdminUserName(rawName, DATA_DIR);
  const name = targetIsAdmin ? ADMIN_KEY : rawName;
  if (targetIsAdmin) {
    if (!ADMIN_ACTIONS.has(action)) {
      return sendJson(res, { error: "The administrator account cannot be stopped, disabled, renamed, or removed.", code: "ADMIN_PROTECTED" }, 400);
    }
  } else if (!findUser(name, DATA_DIR)) {
    return sendJson(res, { error: "No such user.", code: "NO_SUCH_USER" }, 404);
  }

  const callerIp = req.ip || req.socket?.remoteAddress;
  const adminUsername = getRootAdminUsername();

  if (action === "open") {
    if (!targetIsAdmin) {
      const user = findUser(name, DATA_DIR);
      if (!user || user.stopped) {
        return sendJson(res, { error: "That instance is stopped.", code: "NOT_STARTED" }, 409);
      }
      const tenant = resolveActiveTenant(name, DATA_DIR);
      if (!tenant) {
        return sendJson(res, { error: "That user cannot be opened while sign-in is disabled.", code: "USER_DISABLED" }, 409);
      }
      runWithUserContext(tenant, () => writeAuditLog("supervisor.switch", { ip: callerIp, detail: { by: "admin" } }));
    } else {
      runAsAdmin(() => writeAuditLog("supervisor.switch", { ip: callerIp, detail: { by: "admin" } }));
    }
    const landingPath = resolveLandingPathForUser(name, DATA_DIR);
    const loginUsername = principal.loginUsername || adminUsername;
    setSessionCookie(res, loginUsername, { role: ADMIN_ROLE, activeUser: name });
    return sendJson(res, { ok: true, reload: true, path: landingPath });
  }

  let result;
  if (action === "sign-out") {
    result = signOutUser({ dataDir: DATA_DIR, name });
  } else if (action === "disable" || action === "enable") {
    result = setUserDisabled({ dataDir: DATA_DIR, name, disabled: action === "disable" });
  } else if (action === "make-admin" || action === "remove-admin") {
    result = setUserAdministrator({ dataDir: DATA_DIR, name, administrator: action === "make-admin" });
  } else if (action === "stop") {
    result = setUserStopped({ dataDir: DATA_DIR, name, stopped: true });
    if (result.status === 200) {
      const dir = tenantDataDir(name, DATA_DIR);
      closeTenantDatabase(dir);
      clearTenantAuthConfigCache(dir);
    }
  } else if (action === "start" || action === "restart") {
    if (targetIsAdmin) {
      result = { status: 200, body: { ok: true, user: { name: adminUsername } } };
    } else {
      const dir = tenantDataDir(name, DATA_DIR);
      if (action === "restart") {
        closeTenantDatabase(dir);
        clearTenantAuthConfigCache(dir);
      }
      result = setUserStopped({ dataDir: DATA_DIR, name, stopped: false });
    }
  } else if (action === "rename") {
    const refused = checkRename({ dataDir: DATA_DIR, name, newName: body.newName });
    if (refused) return sendJson(res, refused.body, refused.status);
    result = renameUserAccount({
      dataDir: DATA_DIR,
      name,
      newName: body.newName,
      beforeFolderMove: (folder) => {
        closeTenantDatabase(folder);
        clearTenantAuthConfigCache(folder);
      },
    });
  } else if (action === "remove") {
    result = removeUserAccount({
      dataDir: DATA_DIR,
      name,
      deleteData: body.deleteData === true,
      beforeFolderRemove: (folder) => {
        closeTenantDatabase(folder);
        clearTenantAuthConfigCache(folder);
      },
    });
  }

  if (!result || result.status !== 200) {
    return sendJson(res, result?.body || { error: "Action failed" }, result?.status || 400);
  }

  runAsAdmin(() => writeAuditLog(`users.${action}`, {
    ip: callerIp,
    detail: {
      name,
      by: principal.loginUsername || principal.username,
      ...(action === "rename" ? { newName: result.body.user.name } : {}),
      ...(action === "remove" ? { dataDeleted: result.body.dataDeleted } : {}),
    },
  }));

  if (principal.activeUser === name && LEAVES_INSTANCE.has(action)) {
    setSessionCookie(res, adminUsername, { role: ADMIN_ROLE, activeUser: ADMIN_KEY });
    return sendJson(res, { ...result.body, reload: true });
  }
  return sendJson(res, result.body, result.status);
}
