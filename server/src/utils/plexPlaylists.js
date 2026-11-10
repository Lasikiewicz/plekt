import { fetchPlexWithRefresh } from "./plexFetch.js";

// Plex playlist client for Plembfin playlist sync. Kept out of plexClient.js,
// which is near the module size limit. Every read failure throws with
// `error.status` set so the sync engine can tell a definite not-found (404)
// apart from a transient failure; only the former may ever count as a
// deletion (plan/archive/custom-playlist-sync/plan.md, "Safety rules").

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function text(value = "") {
  return String(value ?? "").trim();
}

function requirePlexConfig(config = {}) {
  if (!config.baseUrl || !config.token) {
    throw new Error("Missing Plex baseUrl or token");
  }
}

function playlistUrl(config, path = "") {
  return new URL(`${trimTrailingSlash(config.baseUrl)}/playlists${path}`);
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function metadataFromBody(body) {
  return body?.MediaContainer?.Metadata || body?.Metadata || [];
}

async function readJson(config, url, label) {
  const response = await fetchPlexWithRefresh(config, url, { lane: "sync" });
  if (!response.ok) throw statusError(`Plex ${label} failed with status ${response.status}`, response.status);
  // A 2xx body that is not JSON must fail the read. Returning {} made an unreadable
  // playlist look empty, and pull then removed its items.
  try { return await response.json(); } catch {
    const error = new Error(`Plex ${label} returned a body that is not JSON`);
    error.code = "PLEX_UNRECOGNISED_RESPONSE";
    throw error;
  }
}

function hasPlexContainer(body) {
  return Array.isArray(body?.MediaContainer?.Metadata)
    || Array.isArray(body?.Metadata)
    || Boolean(body?.MediaContainer && typeof body.MediaContainer === "object");
}

async function mutate(config, url, method, label) {
  const response = await fetchPlexWithRefresh(config, url, { method, lane: "interactive" });
  if (!response.ok) throw statusError(`Plex ${label} failed with status ${response.status}`, response.status);
  return response;
}

const serverIdentifierCache = new Map();

export function clearPlexServerIdentifierCache() {
  serverIdentifierCache.clear();
}

export async function getPlexServerIdentifier(config) {
  requirePlexConfig(config);
  const configured = text(config.serverId || config.machineIdentifier);
  if (configured) return configured;
  const cacheKey = trimTrailingSlash(config.baseUrl).toLowerCase();
  const cached = serverIdentifierCache.get(cacheKey);
  if (cached) return cached;
  const body = await readJson(config, new URL(`${trimTrailingSlash(config.baseUrl)}/identity`), "identity lookup");
  const identifier = text(
    body?.MediaContainer?.machineIdentifier
      || body?.MediaContainer?.MachineIdentifier
      || body?.machineIdentifier,
  );
  if (!identifier) throw new Error("Plex identity response did not include a machine identifier");
  serverIdentifierCache.set(cacheKey, identifier);
  return identifier;
}

function metadataUri(serverIdentifier, ratingKeys) {
  const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).map((key) => encodeURIComponent(text(key))).join(",");
  return `server://${serverIdentifier}/com.plexapp.plugins.library/library/metadata/${keys}`;
}

// Normalized shapes shared with the Emby/Jellyfin clients.
export function normalizePlexPlaylist(item = {}) {
  return {
    id: text(item.ratingKey || item.id),
    title: text(item.title),
    itemCount: Number(item.leafCount ?? item.size ?? 0) || 0,
    smart: item.smart === true || item.smart === 1 || item.smart === "1",
    raw: item,
  };
}

export function normalizePlexPlaylistEntry(item = {}) {
  return {
    entryId: text(item.playlistItemID ?? item.playlistItemId ?? item.PlaylistItemID ?? item.PlaylistItemId),
    itemId: text(item.ratingKey || item.id),
    type: text(item.type).toLowerCase(),
    title: text(item.title),
    raw: item,
  };
}

export async function fetchPlexPlaylists(config) {
  requirePlexConfig(config);
  const url = playlistUrl(config);
  url.searchParams.set("playlistType", "video");
  const body = await readJson(config, url, "playlist lookup");
  return metadataFromBody(body)
    .filter((item) => text(item?.type).toLowerCase() === "playlist")
    .map(normalizePlexPlaylist);
}

// Returns null only on a definite 404; any other failure throws.
export async function fetchPlexPlaylist(config, playlistId) {
  requirePlexConfig(config);
  if (!text(playlistId)) return null;
  try {
    const body = await readJson(config, playlistUrl(config, `/${encodeURIComponent(text(playlistId))}`), "playlist read");
    const item = metadataFromBody(body)[0];
    if (!item) throw statusError("Plex playlist read returned no metadata", 0);
    return normalizePlexPlaylist(item);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

// Entries in playlist order. Throws (status 404 included) on failure, never
// returns an empty list for an unreadable playlist.
export async function fetchPlexPlaylistItems(config, playlistId) {
  requirePlexConfig(config);
  if (!text(playlistId)) throw new Error("Plex playlist id is required");
  const url = playlistUrl(config, `/${encodeURIComponent(text(playlistId))}/items`);
  const body = await readJson(config, url, "playlist items lookup");
  if (!hasPlexContainer(body)) {
    const error = new Error("Plex playlist items response was unrecognised");
    error.code = "PLEX_UNRECOGNISED_RESPONSE";
    throw error;
  }
  return metadataFromBody(body).map(normalizePlexPlaylistEntry);
}

// Plex cannot create an empty non-smart video playlist through this endpoint,
// so the first item travels with the create request.
export async function createPlexPlaylist(config, { title, ratingKey } = {}) {
  requirePlexConfig(config);
  const name = text(title);
  if (!name) throw new Error("Plex playlist title is required");
  if (!text(ratingKey)) throw new Error("Plex playlists require an initial library item");
  const serverIdentifier = await getPlexServerIdentifier(config);
  const url = playlistUrl(config);
  url.searchParams.set("type", "video");
  url.searchParams.set("title", name);
  url.searchParams.set("smart", "0");
  url.searchParams.set("uri", metadataUri(serverIdentifier, ratingKey));
  const response = await mutate(config, url, "POST", "playlist create");
  let body = {};
  try { body = await response.json(); } catch { /* Plex may return an empty 201. */ }
  const created = metadataFromBody(body)[0];
  return { id: text(created?.ratingKey || body?.ratingKey || body?.id), body };
}

export async function addPlexPlaylistItems(config, playlistId, ratingKeys = []) {
  requirePlexConfig(config);
  const keys = [...new Set((Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).map(text).filter(Boolean))];
  if (!text(playlistId) || !keys.length) return { status: "not_found", added: 0 };
  const serverIdentifier = await getPlexServerIdentifier(config);
  const url = playlistUrl(config, `/${encodeURIComponent(text(playlistId))}/items`);
  url.searchParams.set("uri", metadataUri(serverIdentifier, keys));
  await mutate(config, url, "PUT", "playlist add");
  return { status: "fulfilled", added: keys.length };
}

export async function removePlexPlaylistItem(config, playlistId, entryId) {
  requirePlexConfig(config);
  if (!text(playlistId) || !text(entryId)) return { status: "not_found" };
  const url = playlistUrl(config, `/${encodeURIComponent(text(playlistId))}/items/${encodeURIComponent(text(entryId))}`);
  await mutate(config, url, "DELETE", "playlist remove");
  return { status: "fulfilled", entryId: text(entryId) };
}

// Moves one entry directly after `afterEntryId`, or to the top when it is empty.
export async function movePlexPlaylistItem(config, playlistId, entryId, afterEntryId = "") {
  requirePlexConfig(config);
  if (!text(playlistId) || !text(entryId)) return { status: "not_found" };
  const url = playlistUrl(config, `/${encodeURIComponent(text(playlistId))}/items/${encodeURIComponent(text(entryId))}/move`);
  if (text(afterEntryId)) url.searchParams.set("after", text(afterEntryId));
  await mutate(config, url, "PUT", "playlist move");
  return { status: "fulfilled", entryId: text(entryId) };
}

export async function renamePlexPlaylist(config, playlistId, title) {
  requirePlexConfig(config);
  const name = text(title);
  if (!text(playlistId)) return { status: "not_found" };
  if (!name) throw new Error("Plex playlist title is required");
  const url = playlistUrl(config, `/${encodeURIComponent(text(playlistId))}`);
  url.searchParams.set("title", name);
  await mutate(config, url, "PUT", "playlist rename");
  return { status: "fulfilled" };
}

// A 404 means the playlist is already gone, which is the requested end state.
export async function deletePlexPlaylist(config, playlistId) {
  requirePlexConfig(config);
  if (!text(playlistId)) return { status: "not_found" };
  try {
    await mutate(config, playlistUrl(config, `/${encodeURIComponent(text(playlistId))}`), "DELETE", "playlist delete");
    return { status: "fulfilled" };
  } catch (error) {
    if (error?.status === 404) return { status: "not_found" };
    throw error;
  }
}
