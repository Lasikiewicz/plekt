import { db, parseJson, toJson } from "../db.js";
import { activeSessionTtlMs } from "./tuning.js";
import { recordWatchAuditEvent } from "./watchAudit.js";
import { isDemoMode } from "./demoMode.js";
import { isUpNextSeedDeviceId } from "./embyClient.js";

function normalizePart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function sessionIdentity(media = {}) {
  const ids = media.ids || {};
  const providerParts = [
    ids.imdb ? `imdb:${ids.imdb}` : "",
    ids.tmdb ? `tmdb:${ids.tmdb}` : "",
    ids.tvdb ? `tvdb:${ids.tvdb}` : "",
  ].filter(Boolean);

  return [
    normalizePart(media.source),
    normalizePart(media.type),
    normalizePart(media.season),
    normalizePart(media.episode),
    providerParts.length ? providerParts.map(normalizePart).join(":") : normalizePart(media.title),
  ].join(":");
}

function fromRow(row) {
  return {
    key: row.id,
    title: row.title || "Unknown media",
    mediaType: row.media_type || "unknown",
    source: row.source || "unknown",
    progress: Number(row.progress || 0),
    offsetMs: Number(row.offset_ms || 0),
    durationMs: Number(row.duration_ms || 0),
    season: row.season ?? null,
    episode: row.episode ?? null,
    posterUrl: row.poster_url || "",
    ids: parseJson(row.ids, {}) || {},
    event: row.event || "",
    client: parseJson(row.client, { userName: "", deviceName: "" }) || { userName: "", deviceName: "" },
    updatedAt: Number(row.updated_at || 0),
  };
}

function isSyntheticUpNextSession(media = {}) {
  if (!["emby", "jellyfin"].includes(String(media.source || "").trim().toLowerCase())) return false;
  const client = media.client && typeof media.client === "object" ? media.client : {};
  return [media.deviceId, media.device_id, client.deviceId, client.device_id, client.DeviceId]
    .some(isUpNextSeedDeviceId);
}

const selectAllStmt = db.prepare("SELECT * FROM active_sessions ORDER BY updated_at DESC");
const deleteStaleStmt = db.prepare("DELETE FROM active_sessions WHERE updated_at < ?");
const selectDemoEpisodeStmt = db.prepare(`
  SELECT title, media_type, source, season, episode, poster_url, imdb_id, tmdb_id, tvdb_id, media_key
  FROM watch_history
  WHERE media_key = 'demo:episode:1396:s1e3'
  LIMIT 1
`);
const upsertDemoSessionStmt = db.prepare(
  `INSERT INTO active_sessions
     (id, title, media_type, source, progress, offset_ms, duration_ms, season, episode, poster_url, ids, event, client, updated_at, expire_at)
   VALUES (@id, @title, @media_type, @source, @progress, @offset_ms, @duration_ms, @season, @episode, @poster_url, @ids, @event, @client, @updated_at, @expire_at)
   ON CONFLICT(id) DO UPDATE SET
     title=excluded.title, media_type=excluded.media_type, source=excluded.source, progress=excluded.progress,
     offset_ms=excluded.offset_ms, duration_ms=excluded.duration_ms, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, ids=excluded.ids, event=excluded.event, client=excluded.client,
     updated_at=excluded.updated_at, expire_at=excluded.expire_at`,
);
const upsertStmt = db.prepare(
  `INSERT INTO active_sessions
     (id, title, media_type, source, progress, offset_ms, duration_ms, season, episode, poster_url, ids, event, client, updated_at, expire_at)
   VALUES (@id, @title, @media_type, @source, @progress, @offset_ms, @duration_ms, @season, @episode, @poster_url, @ids, @event, @client, @updated_at, @expire_at)
   ON CONFLICT(id) DO UPDATE SET
     title=excluded.title, media_type=excluded.media_type, source=excluded.source, progress=excluded.progress,
     offset_ms=excluded.offset_ms, duration_ms=excluded.duration_ms, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, ids=excluded.ids, event=excluded.event, client=excluded.client,
     updated_at=excluded.updated_at, expire_at=excluded.expire_at`,
);
const deleteOneStmt = db.prepare("DELETE FROM active_sessions WHERE id = ?");
const deleteEpisodeByCoordinatesStmt = db.prepare(
  `DELETE FROM active_sessions
   WHERE source = ?
     AND media_type = ?
     AND season = ?
     AND episode = ?
     AND lower(title) = lower(?)`,
);

function refreshDemoSession(now) {
  if (!isDemoMode()) return;
  const episode = selectDemoEpisodeStmt.get() || {};
  upsertDemoSessionStmt.run({
    id: "demo:session:living-room",
    title: episode.title || "Breaking Bad - S01E03 - ...And the Bag's in the River",
    media_type: episode.media_type || "episode",
    source: "demo",
    progress: 38,
    offset_ms: 1368000,
    duration_ms: 3600000,
    season: episode.season ?? 1,
    episode: episode.episode ?? 3,
    // Now Playing represents the show in the dashboard. Keep the demo's
    // canonical Breaking Bad poster here rather than the episode-specific
    // still stored on the watched episode row.
    poster_url: "/demo-assets/posters/tv-1396.webp",
    ids: toJson({
      imdb: episode.imdb_id || "tt0903747",
      tmdb: episode.tmdb_id || "1396",
      tvdb: episode.tvdb_id || "81189",
      mediaKey: episode.media_key || "demo:episode:1396:s1e3",
    }),
    event: "play",
    client: toJson({ name: "Demo Player", user: "Demo", deviceName: "Demo browser" }),
    updated_at: now,
    expire_at: now + (2 * 60 * 60 * 1000),
  });
}

export async function listActiveSessions() {
  const cutoff = Date.now() - activeSessionTtlMs();
  deleteStaleStmt.run(cutoff);
  // A normal active session expires when a connected player stops reporting.
  // The demo has no player, so keep its bundled “currently playing” example
  // alive while the isolated demo server is running.
  refreshDemoSession(Date.now());
  const rows = selectAllStmt.all();
  const visibleRows = [];
  for (const row of rows) {
    // Older alpha builds accepted the Up Next seed webhook as real playback.
    // Remove those rows at the projection boundary so a deployment of the
    // fix clears existing phantom cards immediately instead of waiting for TTL.
    if (isSyntheticUpNextSession({ source: row.source, client: parseJson(row.client, {}) || {} })) {
      deleteOneStmt.run(row.id);
      continue;
    }
    visibleRows.push(row);
  }
  return visibleRows.map(fromRow);
}

export async function upsertActiveSession(media) {
  if (!media) return [];
  if (isSyntheticUpNextSession(media)) {
    // Keep this invariant local to the storage boundary as well as the webhook
    // route: no caller can persist Plembfin's own synthetic Emby playback.
    deleteOneStmt.run(sessionIdentity(media));
    return listActiveSessions();
  }
  const now = Date.now();
  const id = sessionIdentity(media);
  const wasActive = Boolean(db.prepare("SELECT id FROM active_sessions WHERE id = ? LIMIT 1").get(id));
  upsertStmt.run({
    id,
    title: media.title || "Unknown media",
    media_type: media.type || "unknown",
    source: media.source || "unknown",
    progress: Number.isFinite(Number(media.progress)) ? Math.max(0, Math.min(100, Number(media.progress))) : 0,
    offset_ms: Number(media.offsetMs) || 0,
    duration_ms: Number(media.durationMs) || 0,
    season: media.season ?? null,
    episode: media.episode ?? null,
    poster_url: media.posterUrl || "",
    ids: toJson(media.ids || {}),
    event: media.event || "",
    client: toJson({
      userName: media.user || "",
      deviceName: media.device || media.deviceName || "",
      deviceId: media.deviceId || "",
      client: media.clientName || media.client?.client || media.client?.product || media.client?.platform || "",
      version: media.clientVersion || media.client?.version || "",
    }),
    updated_at: now,
    expire_at: now + activeSessionTtlMs(),
  });
  if (!wasActive || /start|resume|unpause/i.test(String(media.event || ""))) {
    const client = media.client && typeof media.client === "object" ? media.client : {};
    recordWatchAuditEvent({
      eventType: "playback_detected",
      timestamp: now,
      action: "playback",
      mediaType: media.type || media.mediaType,
      title: media.title,
      source: media.source,
      sourceEvent: media.event,
      phase: "active",
      watchProvenance: media.watchProvenance || media.watch_provenance,
      ids: media.ids,
      season: media.season,
      episode: media.episode,
      itemId: media.itemId,
      sessionId: media.sessionId || id,
      user: media.user || client.userName,
      device: media.device || media.deviceName || client.deviceName,
      deviceId: media.deviceId || client.deviceId,
      client: media.clientName || client.client || client.product || client.platform,
      clientVersion: media.clientVersion || client.version,
      details: wasActive ? "Playback resumed on a known active session." : "Playback detected and active session opened.",
      payload: {
        progress: media.progress,
        offsetMs: media.offsetMs,
        durationMs: media.durationMs,
      },
    });
  }
  return listActiveSessions();
}

export async function deleteActiveSession(media) {
  if (!media) return [];
  const deleted = deleteOneStmt.run(sessionIdentity(media));
  // Provider start/stop payloads can disagree about external ids (for
  // example, one event has an episode id while the other has a series id).
  // The active-session key intentionally includes those ids, so exact-key
  // deletion can miss the row and leave a finished card visible until TTL.
  // Episode coordinates plus the normalized display title identify the same
  // playback without conflating another same-numbered episode.
  if (
    !deleted.changes &&
    String(media.type || media.mediaType || "").toLowerCase() === "episode" &&
    media.season != null &&
    media.episode != null &&
    String(media.title || "").trim()
  ) {
    deleteEpisodeByCoordinatesStmt.run(
      media.source || "unknown",
      media.type || media.mediaType || "episode",
      media.season,
      media.episode,
      String(media.title).trim(),
    );
  }
  return listActiveSessions();
}
