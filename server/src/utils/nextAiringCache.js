import fs from "node:fs/promises";
import path from "node:path";
import { getActiveDataDir } from "./userContext.js";

const CACHE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const INACTIVE_TTL_MS = 7 * DAY_MS;

const cacheStates = new Map();

function cacheState(dataDir = getActiveDataDir()) {
  const directory = path.resolve(dataDir);
  let state = cacheStates.get(directory);
  if (!state) {
    state = { directory, memoryCache: null, memoryMtimeMs: 0 };
    cacheStates.set(directory, state);
  }
  return state;
}

function normalizeTitle(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function nextAiringCacheKey(tmdbId = "", title = "") {
  const id = String(tmdbId || "").trim();
  if (id) return `tv_${id}`;
  const titleKey = normalizeTitle(title);
  return titleKey ? `title_${titleKey}` : "";
}

function emptyCache() {
  return { version: CACHE_VERSION, updatedAt: 0, entries: {} };
}

async function readFileCache() {
  const state = cacheState();
  const cacheFile = path.join(state.directory, "next-airing-cache.json");
  try {
    const [stat, raw] = await Promise.all([fs.stat(cacheFile), fs.readFile(cacheFile, "utf8")]);
    if (state.memoryCache && state.memoryMtimeMs === stat.mtimeMs) return state.memoryCache;
    const parsed = JSON.parse(raw);
    const cache = {
      version: CACHE_VERSION,
      updatedAt: Number(parsed?.updatedAt || 0),
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
    state.memoryCache = cache;
    state.memoryMtimeMs = stat.mtimeMs;
    return cache;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to read next airing cache", error);
    state.memoryCache = emptyCache();
    state.memoryMtimeMs = 0;
    return state.memoryCache;
  }
}

async function writeFileCache(cache) {
  const state = cacheState();
  const cacheFile = path.join(state.directory, "next-airing-cache.json");
  const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.mkdir(state.directory, { recursive: true });
  const payload = JSON.stringify({ ...cache, version: CACHE_VERSION, updatedAt: Date.now() }, null, 2);
  await fs.writeFile(tempFile, payload, "utf8");
  await fs.rename(tempFile, cacheFile);
  state.memoryCache = { ...cache, version: CACHE_VERSION, updatedAt: Date.now() };
  state.memoryMtimeMs = 0;
}

export async function readNextAiringCache() {
  return readFileCache();
}

export function cachedNextAiringFor(entries = {}, tmdbId = "", title = "") {
  const key = nextAiringCacheKey(tmdbId, title);
  if (!key) return null;
  const entry = entries[key];
  if (!entry) return null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...entry,
    nextAiringDate: entry.nextAiringDate && entry.nextAiringDate >= today ? entry.nextAiringDate : "",
  };
}

export async function mergeNextAiringCacheEntries(updates = []) {
  const filtered = updates.filter((entry) => entry?.key);
  if (!filtered.length) return { written: 0 };
  const cache = await readFileCache();
  const entries = { ...cache.entries };
  const now = Date.now();
  for (const update of filtered) {
    entries[update.key] = {
      title: update.title || entries[update.key]?.title || "",
      tmdbId: update.tmdbId ? String(update.tmdbId) : entries[update.key]?.tmdbId || "",
      nextAiringDate: update.nextAiringDate || "",
      status: update.status || "",
      updatedAt: now,
    };
  }
  await writeFileCache({ ...cache, entries });
  return { written: filtered.length };
}

export function nextAiringCacheEntryStale(entry = null, status = "") {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const updatedAt = Number(safeEntry.updatedAt || 0);
  if (!updatedAt) return true;
  const ttl = ["Ended", "Canceled"].includes(status || safeEntry.status) ? INACTIVE_TTL_MS : ACTIVE_TTL_MS;
  return Date.now() - updatedAt > ttl;
}
