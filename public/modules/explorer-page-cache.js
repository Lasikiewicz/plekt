import { state } from "./state.js?v=2.1.1.0.4";

const MEMORY_TTL_MS = 30 * 60 * 1000;
const PERSISTED_KEY = "plekt:explorerPageCache:v3";
const PERSISTED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PERSISTED_LIMIT = 24;
const STALE_MARKER = "__plektStaleExplorerCache";

export function historyVersionFromRows(rows = []) {
  const newest = rows.reduce((latest, row) => {
    const watchedAt = String(row?.watched_at || "");
    return watchedAt > latest ? watchedAt : latest;
  }, "");
  return newest ? `rows:${newest}:${rows.length}` : "empty";
}

function cacheVersion() {
  return String(state.historyVersion || historyVersionFromRows(state.history));
}

function cacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${PERSISTED_KEY}:${userKey}`;
}

function readPersistentCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writePersistentCache(entries) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ entries }));
  } catch {
    // Storage is best-effort; the in-memory cache and API remain available.
  }
}

function isShowsPage(key) {
  return /\/api\/shows(?:\?|$)/.test(String(key || ""));
}

function persistedTtl(key) {
  // Show pages include independently refreshed next-airing dates.
  return isShowsPage(key) ? MEMORY_TTL_MS : PERSISTED_TTL_MS;
}

function markedStale(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, [STALE_MARKER]: true };
}

function isFirstPage(key) {
  try {
    return new URL(key, window.location.origin).searchParams.get("offset") === "0";
  } catch {
    return false;
  }
}

export function cachedExplorerPage(key) {
  const version = cacheVersion();
  const cached = state.explorerPageCache.get(key);
  if (cached && Date.now() - cached.savedAt <= MEMORY_TTL_MS) {
    if (cached.version === version) return cached.body;
    return isFirstPage(key) ? markedStale(cached.body) : null;
  }
  if (cached) state.explorerPageCache.delete(key);

  const now = Date.now();
  const entries = readPersistentCache().filter((entry) => now - Number(entry.savedAt || 0) <= persistedTtl(entry.key));
  const persisted = entries.find((entry) => entry.key === key);
  if (!persisted) {
    if (entries.length) writePersistentCache(entries);
    return null;
  }

  if (persisted.version === version) {
    const savedAt = isShowsPage(key) ? Number(persisted.savedAt || now) : now;
    state.explorerPageCache.set(key, { savedAt, version, body: persisted.body });
    return persisted.body;
  }
  return isFirstPage(key) ? markedStale(persisted.body) : null;
}

export function rememberExplorerPage(key, body) {
  const savedAt = Date.now();
  const version = cacheVersion();
  state.explorerPageCache.set(key, { savedAt, version, body });
  if (state.explorerPageCache.size > 40) {
    state.explorerPageCache.delete(state.explorerPageCache.keys().next().value);
  }

  const entries = readPersistentCache()
    .filter((entry) => entry.key !== key && savedAt - Number(entry.savedAt || 0) <= persistedTtl(entry.key))
    .concat({ key, version, savedAt, body })
    .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))
    .slice(0, PERSISTED_LIMIT);
  writePersistentCache(entries);
}

export function isStaleExplorerPage(body) {
  return body?.[STALE_MARKER] === true;
}

export function clearPersistentExplorerPageCache() {
  try {
    localStorage.removeItem(cacheKey());
  } catch {
    // Storage is best-effort.
  }
}
