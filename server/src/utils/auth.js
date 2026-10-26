import crypto from "node:crypto";
import { DATA_DIR } from "../paths.js";
import {
  AUTH,
  getRootAdminUsername,
  getRootSessionSecret,
  isClaimRequired,
  isDefaultPassword,
  rotateWebhookSecret,
  updateAdminCredentials,
  verifyPassword,
  verifyRootAdminPassword,
  verifyRootAdminUsername,
  verifyUsername,
} from "../appConfig.js";
import { claimAccount } from "./onboardingStore.js";
import { writeAuditLog } from "../db.js";
import { readJson } from "./requestBody.js";
import { sendJson } from "./http.js";
import { checkRateLimit } from "./rateLimit.js";
import { isDemoMode } from "./demoMode.js";
import {
  ADMIN_KEY,
  ADMINISTRATOR_ROLE,
  ADMIN_ROLE,
  USER_ROLE,
  findUser,
  multiUserEnabled,
  normalizeUserName,
  resolveActiveTenant,
  setUserPasswordAccount,
  signOutUser,
  verifyUserPasswordHash,
} from "./tenancy.js";
import { getActiveUserName, isNonAdminTenantContext, runAsAdmin } from "./userContext.js";

const COOKIE_NAME = "plembfin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const AUTH_RATE_LIMIT = { max: 10, windowMs: 15 * 60_000 };

function callerIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// Rejects cross-site POSTs that carry an Origin header pointing elsewhere.
// Requests with no Origin header (same-origin form posts in older browsers,
// server-to-server API/webhook callers) are allowed through - this guards
// browser-driven CSRF, not general API access.
export function isSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.get("host");
    return Boolean(requestHost) && originHost === requestHost;
  } catch {
    return false;
  }
}

function sameHost(value, req) {
  try {
    const requestHost = String(req.get("host") || "");
    return Boolean(requestHost) && new URL(value).host === requestHost;
  } catch {
    return false;
  }
}

// Strict check for the interactive account and tracker authorization routes:
// a request must prove it came from this app's own pages.
export function isSameOriginBrowserRequest(req) {
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite) return fetchSite === "same-origin";
  const origin = req.get("origin");
  if (origin) return sameHost(origin, req);
  const referer = req.get("referer");
  if (referer) return sameHost(referer, req);
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Stateless signed session cookie --------------------------------------
export function signSession(username, { role = ADMIN_ROLE, activeUser = null } = {}) {
  const effectiveRole = role === USER_ROLE ? USER_ROLE : ADMIN_ROLE;
  const effectiveActive = effectiveRole === USER_ROLE
    ? normalizeUserName(username)
    : normalizeUserName(activeUser || ADMIN_KEY) || ADMIN_KEY;
  const payload = Buffer.from(JSON.stringify({
    u: username,
    role: effectiveRole,
    activeUser: effectiveActive,
    iat: Date.now(),
  })).toString("base64url");
  const secret = getRootSessionSecret();
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function setSessionCookie(res, username, options = {}) {
  res.cookie(COOKIE_NAME, signSession(username, options), {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function verifySession(token = "") {
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const secret = getRootSessionSecret();
  if (!secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.iat || Date.now() - data.iat > SESSION_TTL_MS) return null;
    const role = data.role === USER_ROLE ? USER_ROLE : ADMIN_ROLE;
    if (role === USER_ROLE) {
      const user = findUser(data.u, DATA_DIR);
      if (!user || user.role === ADMIN_ROLE || user.disabled || user.stopped) return null;
      if (user.sessionsValidAfter && data.iat <= user.sessionsValidAfter) return null;
      return {
        username: user.name,
        role: USER_ROLE,
        activeUser: user.name,
        iat: data.iat,
      };
    }
    const loginUsername = String(data.u || getRootAdminUsername()).trim();
    const loginKey = normalizeUserName(loginUsername);
    const delegatedAdmin = findUser(loginKey, DATA_DIR);
    if (delegatedAdmin?.role === ADMINISTRATOR_ROLE) {
      if (delegatedAdmin.disabled || delegatedAdmin.stopped) return null;
      if (delegatedAdmin.sessionsValidAfter && data.iat <= delegatedAdmin.sessionsValidAfter) return null;
    } else if (loginKey !== normalizeUserName(getRootAdminUsername())) {
      return null;
    }
    const activeUser = normalizeUserName(data.activeUser || ADMIN_KEY) || ADMIN_KEY;
    return {
      username: loginUsername,
      role: ADMIN_ROLE,
      activeUser,
      iat: data.iat,
    };
  } catch {
    return null;
  }
}

// Resolves which non-admin tenant context a browser session cookie should run
// in for unprefixed /api/* requests. Returns null when the request should stay
// in the root admin context.
export function resolveSessionTenantContext(req) {
  if (!multiUserEnabled(DATA_DIR)) return null;
  if (apiKeyFromRequest(req)) return null;
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (!cookieToken) return null;
  const session = verifySession(cookieToken);
  if (!session) return null;
  if (session.role === USER_ROLE) {
    return resolveActiveTenant(session.username, DATA_DIR);
  }
  if (session.role === ADMIN_ROLE && session.activeUser && session.activeUser !== ADMIN_KEY) {
    const tenant = resolveActiveTenant(session.activeUser, DATA_DIR);
    if (tenant && tenant.role !== ADMIN_ROLE) return tenant;
  }
  return null;
}

function apiKeyFromRequest(req) {
  const header = req.get("x-api-key") || req.get("X-Api-Key") || "";
  if (header) return header.trim();
  const auth = req.get("authorization") || req.get("Authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return "";
}

function matchesApiKey(value) {
  if (!value || !AUTH.apiKey) return false;
  const a = Buffer.from(String(value));
  const b = Buffer.from(AUTH.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolve the authenticated principal from either a valid session cookie or the
// active context's API key, without sending a response.
export function resolveAdminPrincipal(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const session = cookieToken ? verifySession(cookieToken) : null;
  if (session) {
    // When running on an explicit /u/<tenant>/api/* route, a non-admin user's
    // session cookie may only access their own tenant; the install admin may
    // access any tenant. Also prevent a non-admin user from calling /u/admin/*.
    const explicitTenant = req.plektTenant ? normalizeUserName(req.plektTenant) : "";
    if (session.role === USER_ROLE) {
      if (explicitTenant && explicitTenant !== session.username) return null;
      if (isNonAdminTenantContext(DATA_DIR) && getActiveUserName() !== session.username) return null;
    }
    const effectiveUsername = isNonAdminTenantContext(DATA_DIR)
      ? getActiveUserName()
      : session.username;
    return {
      username: effectiveUsername,
      loginUsername: session.username,
      role: session.role,
      activeUser: session.activeUser,
      via: "session",
    };
  }
  // An explicit /u/admin/* request when not authenticated as admin is only
  // reachable with the admin API key; non-admin tenants match their own AUTH.apiKey.
  if (matchesApiKey(apiKeyFromRequest(req))) {
    const role = isNonAdminTenantContext(DATA_DIR) ? USER_ROLE : ADMIN_ROLE;
    const activeUser = isNonAdminTenantContext(DATA_DIR) ? getActiveUserName() : ADMIN_KEY;
    return {
      username: AUTH.username,
      loginUsername: AUTH.username,
      role,
      activeUser,
      via: "apikey",
      apiKey: true,
    };
  }
  return null;
}

export async function requireAdmin(req, res) {
  const principal = resolveAdminPrincipal(req);
  if (!principal) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  return principal;
}

export async function requireInstallAdmin(req, res) {
  const principal = resolveAdminPrincipal(req);
  if (!principal) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  if (principal.role !== ADMIN_ROLE) {
    sendJson(res, { error: "Only the administrator can manage users.", code: "ADMIN_ONLY" }, 403);
    return null;
  }
  return principal;
}

// --- Auth routes -----------------------------------------------------------
export async function handleLogin(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED", retryable: false }, 403);
  const ip = isDemoMode() ? "" : callerIp(req);
  if (!checkRateLimit(`login:${ip}`, AUTH_RATE_LIMIT)) {
    return sendJson(res, { error: "Too many attempts. Try again later.", code: "RATE_LIMITED", retryable: true }, 429);
  }
  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || body.email || "").trim();
  const password = String(body.password || "");

  // 1. Check root admin credentials first.
  if (verifyRootAdminUsername(username) && verifyRootAdminPassword(password)) {
    const adminUsername = getRootAdminUsername();
    if (!isDemoMode()) runAsAdmin(() => writeAuditLog("login.success", { ip, detail: { username: adminUsername, role: ADMIN_ROLE } }));
    setSessionCookie(res, adminUsername, { role: ADMIN_ROLE, activeUser: ADMIN_KEY });
    return sendJson(res, { ok: true, username: adminUsername, role: ADMIN_ROLE, activeUser: ADMIN_KEY });
  }

  // 2. When multi-user mode is on, check non-admin accounts in users.json.
  if (multiUserEnabled(DATA_DIR)) {
    const user = findUser(username, DATA_DIR);
    if (user && user.role !== ADMIN_ROLE && !user.disabled && !user.stopped && verifyUserPasswordHash(password, user.passwordHash)) {
      const role = user.role === ADMINISTRATOR_ROLE ? ADMIN_ROLE : USER_ROLE;
      if (!isDemoMode()) {
        runAsAdmin(() => writeAuditLog("login.success", { ip, detail: { username: user.name, role } }));
      }
      setSessionCookie(res, user.name, { role, activeUser: user.name });
      return sendJson(res, { ok: true, username: user.name, role, activeUser: user.name });
    }
  }

  if (!isDemoMode()) runAsAdmin(() => writeAuditLog("login.failure", { ip, detail: { username } }));
  return sendJson(res, { error: "Invalid username or password" }, 401);
}

export async function handleLogout(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  return sendJson(res, { ok: true });
}

export async function handleAuthStatus(req, res) {
  const principal = resolveAdminPrincipal(req);
  if (!principal) return sendJson(res, { authenticated: false, claimRequired: isClaimRequired() });
  const inTenant = isNonAdminTenantContext(DATA_DIR);
  const activeTenantName = inTenant ? getActiveUserName() : "";
  const loginUsername = principal.loginUsername || principal.username;
  const supervisedView = principal.role === ADMIN_ROLE
    && inTenant
    && normalizeUserName(loginUsername) !== normalizeUserName(activeTenantName);
  const elevatedAdmin = principal.role === ADMIN_ROLE
    && !supervisedView
    && findUser(loginUsername, DATA_DIR)?.role === ADMINISTRATOR_ROLE;
  const webhookPath = inTenant ? `/u/${encodeURIComponent(activeTenantName)}/api/webhook` : "/api/webhook";
  return sendJson(res, {
    authenticated: true,
    username: principal.username,
    loginUsername,
    role: principal.role || ADMIN_ROLE,
    activeUser: inTenant ? activeTenantName : ADMIN_KEY,
    supervised: multiUserEnabled(DATA_DIR),
    nonAdminTenant: inTenant,
    supervisedView,
    elevatedAdmin,
    webhookPath,
    mustChangePassword: inTenant ? false : isDefaultPassword(),
    claimRequired: false,
  });
}

// One-time administrator account claim for a pristine install.
export async function handleAuthClaim(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-site request rejected", code: "ORIGIN_REJECTED", retryable: false }, 403);
  const ip = callerIp(req);
  if (!checkRateLimit(`claim:${ip}`, AUTH_RATE_LIMIT)) {
    return sendJson(res, { error: "Too many attempts. Try again later.", code: "RATE_LIMITED", retryable: true }, 429);
  }
  await sleep(150 + Math.floor(Math.random() * 150));

  if (!isClaimRequired()) {
    return sendJson(res, { error: "This instance has already been claimed", code: "CLAIM_CONFLICT", retryable: false }, 409);
  }

  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const confirmPassword = String(body.confirmPassword || "");

  if (!username) return sendJson(res, { error: "Username is required", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (username.length > 128) return sendJson(res, { error: "Username must be 128 characters or fewer", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password.length < 8) return sendJson(res, { error: "Password must be at least 8 characters", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password.length > 256) return sendJson(res, { error: "Password must be 256 characters or fewer", code: "VALIDATION_FAILED", retryable: false }, 400);
  if (password !== confirmPassword) return sendJson(res, { error: "Passwords do not match", code: "VALIDATION_FAILED", retryable: false }, 400);

  const won = claimAccount();
  if (!won) {
    writeAuditLog("account.claim_conflict", { ip, detail: { username } });
    return sendJson(res, { error: "This instance has already been claimed", code: "CLAIM_CONFLICT", retryable: false }, 409);
  }

  updateAdminCredentials({ username, password });
  writeAuditLog("account.claimed", { ip, detail: { username } });
  setSessionCookie(res, username, { role: ADMIN_ROLE, activeUser: ADMIN_KEY });
  return sendJson(res, { ok: true, username });
}

export async function handleAuthApiKey(req, res) {
  if (req.method !== "GET") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, { apiKey: AUTH.apiKey });
}

export async function handleAuthWebhookSecret(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "POST") {
    const newSecret = rotateWebhookSecret();
    writeAuditLog("webhook-secret.rotated", { ip: req.ip || req.socket?.remoteAddress });
    return sendJson(res, { webhookToken: newSecret });
  }
  return sendJson(res, { webhookToken: AUTH.webhookSecret });
}

export async function handleRevokeAllSessions(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const principal = await requireAdmin(req, res);
  if (!principal) return;
  if (principal.role === USER_ROLE) {
    signOutUser({ dataDir: DATA_DIR, name: principal.loginUsername });
    writeAuditLog("sessions.revoked", { ip: req.ip || req.socket?.remoteAddress, detail: { username: principal.loginUsername } });
    await sleep(5);
    setSessionCookie(res, principal.loginUsername, { role: USER_ROLE, activeUser: principal.loginUsername });
    return sendJson(res, { ok: true, message: "All other sessions have been revoked." });
  }
  if (isNonAdminTenantContext(DATA_DIR)) {
    return sendJson(res, { error: "Switch to the administrator account to revoke all install sessions, or use Settings → Users to sign out this user.", code: "SUPERVISED_ACCOUNT" }, 403);
  }
  const callerUsername = getRootAdminUsername();
  updateAdminCredentials({ username: callerUsername, password: "" });
  writeAuditLog("sessions.revoked", { ip: req.ip || req.socket?.remoteAddress, detail: { username: callerUsername } });
  setSessionCookie(res, callerUsername, { role: ADMIN_ROLE, activeUser: principal.activeUser || ADMIN_KEY });
  return sendJson(res, { ok: true, message: "All other sessions have been revoked." });
}

export async function handleAuthCredentials(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const principal = await requireAdmin(req, res);
  if (!principal) return;

  const body = await readJson(req).catch(() => ({}));
  const username = String(body.username || "").trim();
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  // When a non-admin user is signed in, allow them to change their own password
  // in users.json after verifying their current password, while refusing
  // username changes (which require folder rename by the administrator).
  const loginUser = findUser(principal.loginUsername, DATA_DIR);
  const isOwnTenantAccount = principal.role === USER_ROLE
    || (principal.role === ADMIN_ROLE
      && isNonAdminTenantContext(DATA_DIR)
      && normalizeUserName(getActiveUserName()) === normalizeUserName(principal.loginUsername)
      && loginUser?.role === ADMINISTRATOR_ROLE);
  if (isOwnTenantAccount) {
    const user = loginUser;
    if (!user || !verifyUserPasswordHash(currentPassword, user.passwordHash)) {
      return sendJson(res, { error: "Current password is incorrect" }, 401);
    }
    if (username && normalizeUserName(username) !== user.name) {
      return sendJson(res, { error: "Only the administrator can rename a user account.", code: "SUPERVISED_ACCOUNT" }, 403);
    }
    if (!newPassword || newPassword.length < 8) {
      return sendJson(res, { error: "New password must be at least 8 characters" }, 400);
    }
    if (newPassword.length > 256) {
      return sendJson(res, { error: "New password must be 256 characters or fewer" }, 400);
    }
    const updated = setUserPasswordAccount({ dataDir: DATA_DIR, name: user.name, password: newPassword });
    if (updated.status !== 200) {
      return sendJson(res, updated.body, updated.status);
    }
    signOutUser({ dataDir: DATA_DIR, name: user.name });
    await sleep(5);
    writeAuditLog("credentials.updated", { ip: req.ip || req.socket?.remoteAddress, detail: { username: user.name, by: "self" } });
    setSessionCookie(res, user.name, { role: principal.role, activeUser: user.name });
    return sendJson(res, { ok: true, username: user.name });
  }

  // If the admin is currently viewing a non-admin user's instance, block
  // Account credential changes here so they don't accidentally overwrite the
  // admin username/password with the tenant's name (Settings → Users has per-user password reset).
  if (isNonAdminTenantContext(DATA_DIR)) {
    return sendJson(res, { error: "Use Settings → Users to change this user's password or name.", code: "SUPERVISED_ACCOUNT" }, 403);
  }

  if (!verifyPassword(currentPassword)) {
    return sendJson(res, { error: "Current password is incorrect" }, 401);
  }
  if (!username) return sendJson(res, { error: "Username is required" }, 400);
  if (username.length > 128) return sendJson(res, { error: "Username must be 128 characters or fewer" }, 400);
  if (newPassword && newPassword.length < 8) {
    return sendJson(res, { error: "New password must be at least 8 characters" }, 400);
  }
  if (newPassword.length > 256) {
    return sendJson(res, { error: "New password must be 256 characters or fewer" }, 400);
  }

  updateAdminCredentials({ username, password: newPassword });
  writeAuditLog("credentials.updated", { ip: req.ip || req.socket?.remoteAddress, detail: { username } });
  setSessionCookie(res, username, { role: ADMIN_ROLE, activeUser: ADMIN_KEY });
  return sendJson(res, { ok: true, username });
}
