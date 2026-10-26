// Local authentication client. Calls the self-hosted /api/login, /api/logout,
// and /api/auth/status endpoints. The browser holds an HttpOnly session cookie
// (sent automatically on same-origin requests); the API key is fetched from
// /api/auth/apikey after login and kept in memory only for display/copy flows.
// Normal browser API calls use the HttpOnly same-origin session cookie.

let cachedToken = "";
let cachedWebhookToken = "";
let cachedWebhookPath = "/api/webhook";
let cachedUser = null;

function userFrom(username) {
  const name = username || "admin";
  return { email: name, uid: name, username: name };
}

function setSession(username) {
  cachedUser = userFrom(username);
}

function clearSession() {
  cachedUser = null;
  cachedToken = "";
  cachedWebhookToken = "";
  cachedWebhookPath = "/api/webhook";
}

function applyTenantStatusFlags(data = {}) {
  const isAdminSession = data.role === "admin";
  const isAdminOnNonAdminTenant = isAdminSession && data.supervisedView === true;
  const isNonAdminUser = data.role === "user" || isAdminOnNonAdminTenant;
  const isElevatedAdmin = isAdminSession && data.elevatedAdmin === true;
  document.documentElement.classList.toggle("admin-session", isAdminSession);
  document.documentElement.classList.toggle("supervised-child", isAdminOnNonAdminTenant);
  document.documentElement.classList.toggle("non-admin-user", isNonAdminUser);
  document.documentElement.classList.toggle("elevated-admin", isElevatedAdmin);
  const selfServicePasswordForm = document.querySelector("#userPasswordForm");
  if (selfServicePasswordForm) selfServicePasswordForm.hidden = !(isNonAdminUser || isElevatedAdmin);
  if (typeof data.webhookPath === "string" && data.webhookPath.startsWith("/")) {
    cachedWebhookPath = data.webhookPath;
  } else {
    cachedWebhookPath = "/api/webhook";
  }
}

// Fetches the admin API key from the server and caches it. Called after any
// successful authentication so buildAuthHeaders() always has a key to use.
async function fetchAndCacheApiKey() {
  try {
    const res = await fetch("/api/auth/apikey", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.apiKey) {
      cachedToken = data.apiKey;
    }
  } catch { /* network error - session cookie covers same-origin requests */ }
}

async function fetchAndCacheWebhookToken() {
  try {
    const res = await fetch("/api/auth/webhook-secret", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.webhookToken) cachedWebhookToken = data.webhookToken;
  } catch { /* best-effort */ }
}

export function readStoredAdminToken(_keys, fallback = "") {
  return cachedToken || fallback || "";
}

export function currentUser() {
  return cachedUser;
}

export function getWebhookToken() {
  return cachedWebhookToken;
}

export function getWebhookPath() {
  return cachedWebhookPath || "/api/webhook";
}

// Called once at startup. Resolves the current auth state from the session
// cookie and invokes the callback with (user, token) or (null, "").
export function onAuthChange(callback) {
  (async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      applyTenantStatusFlags(data);
      if (data.authenticated) {
        setSession(data.username);
        await Promise.all([fetchAndCacheApiKey(), fetchAndCacheWebhookToken()]);
        callback(cachedUser, "session", data.mustChangePassword === true, false);
      } else {
        clearSession();
        callback(null, "", false, data.claimRequired === true);
      }
    } catch {
      clearSession();
      callback(null, "", false, false);
    }
  })();
  return () => {};
}

export async function signInAdmin(username, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: String(username || "").trim(), password: String(password || "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Invalid username or password");
  }
  setSession(data.username);
  try {
    const statusRes = await fetch("/api/auth/status", { credentials: "same-origin" });
    const statusData = await statusRes.json().catch(() => ({}));
    applyTenantStatusFlags(statusData);
  } catch { /* best-effort */ }
  await Promise.all([fetchAndCacheApiKey(), fetchAndCacheWebhookToken()]);
  return { user: cachedUser, token: "session" };
}

// One-time administrator account claim for a pristine install. Reuses the
// session established by /api/auth/claim exactly like signInAdmin does.
export async function claimAdminAccount(username, password, confirmPassword) {
  const res = await fetch("/api/auth/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: String(username || "").trim(), password: String(password || ""), confirmPassword: String(confirmPassword || "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Could not claim this instance");
    error.code = data.code || "";
    throw error;
  }
  setSession(data.username);
  await Promise.all([fetchAndCacheApiKey(), fetchAndCacheWebhookToken()]);
  return { user: cachedUser, token: "session" };
}

export async function signOutAdmin() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    /* best-effort */
  }
  clearSession();
}

export async function updateAdminCredentials({ username, currentPassword, newPassword }) {
  const res = await fetch("/api/auth/credentials", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, currentPassword, newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Login update failed");
  setSession(data.username);
  await fetchAndCacheApiKey();
  return { user: cachedUser, token: "session" };
}

export async function rotateWebhookSecret() {
  const res = await fetch("/api/auth/webhook-secret", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to rotate webhook secret");
  if (data.webhookToken) cachedWebhookToken = data.webhookToken;
  return data.webhookToken || "";
}

export function buildAuthHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  const key = token && token !== "session" ? token : "";
  if (key) headers["X-Api-Key"] = key;
  return headers;
}

export function buildNowPlayingUrl(origin) {
  return new URL("/api/now-playing", origin);
}

export function scrubTokenFromLocation() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token|api_key)=)|(?:^#(?:adminToken|username|token|api_key)=)/i.test(`${search}${hash}`);

  if (hasAuthParams) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}
