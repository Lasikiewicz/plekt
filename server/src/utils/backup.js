import crypto from "node:crypto";
import { bumpDataVersion, db, parseJson, toJson } from "../db.js";
import { clearWatchlistRemoteProjection, getWatchlistRestoreState, markWatchlistRestorePending } from "./personalWatchlistRepository.js";
import { BACKUP_FORMAT, LEGACY_REDACTED_SECRETS_FIELD, REDACTED_SECRETS_FIELD, TYPE_FIELD, backupValueType } from "./backupNames.js";

export { BACKUP_FORMAT };
export const BACKUP_VERSION = 1;
export const BACKUP_COLLECTIONS = [
  "watchHistory",
  "playstate",
  "manualWatchReviews",
  "playbackProgress",
  "activeSessions",
  "liveTrackingCache",
  "syncHistory",
  "watchAuditEvents",
  "mediaAuthDevices",
  "mediaConnections",
  "trackerConnections",
  "trackerItemState",
  "settings",
  "runtimeState",
  "loopKeys",
  "mediaArtwork",
  "personalWatchlist",
  "personalWatchlistMutations",
  "personalWatchlistProviderItems",
  "personalWatchlistSyncQueue",
  "personalWatchlistSyncRuns",
  "personalWatchlistActivity",
];
const BROWSER_EXCLUDED_COLLECTIONS = new Set(["mediaAuthDevices", "mediaConnections", "trackerConnections"]);
export const BROWSER_BACKUP_COLLECTIONS = BACKUP_COLLECTIONS.filter((name) => !BROWSER_EXCLUDED_COLLECTIONS.has(name));
const WATCHLIST_BACKUP_COLLECTIONS = new Set(BACKUP_COLLECTIONS.filter((name) => name.startsWith("personalWatchlist")));
const BROWSER_REDACTED_SECRETS_FIELD = REDACTED_SECRETS_FIELD;
const SECRET_SETTING_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|credential|pass(?:word|phrase)?|private[_-]?key|refresh[_-]?token|session[_-]?secret|webhook[_-]?secret|secret|^token$)/i;

function portableValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return { [TYPE_FIELD]: "timestamp", value: value.getTime() };
  if (Array.isArray(value)) return value.map(portableValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableValue(item)]));
}

function reviveValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (backupValueType(value) === "timestamp") return Number(value.value);
  if (Array.isArray(value)) return value.map(reviveValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveValue(item)]));
}

function redactBrowserSettings(value) {
  let redacted = false;
  const visit = (current) => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const result = {};
    for (const [key, item] of Object.entries(current)) {
      if (SECRET_SETTING_KEY_PATTERN.test(key)) {
        redacted = true;
        continue;
      }
      result[key] = visit(item);
    }
    return result;
  };
  const result = visit(value);
  if (!redacted || !result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, [BROWSER_REDACTED_SECRETS_FIELD]: true };
}

function mergeRedactedSettings(existing, incoming) {
  const merge = (current, next) => {
    if (Array.isArray(next)) return next;
    if (!next || typeof next !== "object") return next;
    const result = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    for (const [key, value] of Object.entries(next)) {
      if (key === BROWSER_REDACTED_SECRETS_FIELD || key === LEGACY_REDACTED_SECRETS_FIELD) continue;
      result[key] = merge(result[key], value);
    }
    return result;
  };
  return merge(existing, incoming);
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    if (backupValueType(value) === "timestamp") return toMs(value.value);
    if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function ids(row) {
  return {
    imdb: row.imdb_id || null,
    tmdb: row.tmdb_id || null,
    tvdb: row.tvdb_id || null,
  };
}

const collections = {
  watchHistory: {
    table: "watch_history",
    key: "id",
    rowToData: (row) => ({
      title: row.title || "",
      titleLower: row.title_lower || "",
      mediaType: row.media_type || "",
      watchedAt: row.watched_at || "",
      source: row.source || "",
      ids: ids(row),
      season: row.season,
      episode: row.episode,
      posterUrl: row.poster_url,
      logoUrl: row.logo_url,
      backdropUrl: row.backdrop_url,
      youtubeUrl: row.youtube_url,
      syncAction: row.sync_action,
      syncDispatchTelemetry: row.sync_dispatch_telemetry,
      syncMatchIgnoredAt: row.sync_match_ignored_at,
      watchProvenance: row.watch_provenance,
      mediaKey: row.media_key,
      showTitle: row.show_title,
      showTitleLower: row.show_title_lower,
      episodeTitle: row.episode_title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    insert: db.prepare(`INSERT OR REPLACE INTO watch_history
      (id,title,title_lower,media_type,watched_at,source,imdb_id,tmdb_id,tvdb_id,season,episode,poster_url,logo_url,backdrop_url,youtube_url,sync_action,sync_dispatch_telemetry,sync_match_ignored_at,watch_provenance,media_key,show_title,show_title_lower,episode_title,created_at,updated_at)
      VALUES (@id,@title,@title_lower,@media_type,@watched_at,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@logo_url,@backdrop_url,@youtube_url,@sync_action,@sync_dispatch_telemetry,@sync_match_ignored_at,@watch_provenance,@media_key,@show_title,@show_title_lower,@episode_title,@created_at,@updated_at)`),
    dataToRow: (id, d) => ({
      id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(),
      media_type: d.mediaType || "", watched_at: d.watchedAt || "", source: d.source || "",
      imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || d.tmdbId || null, tvdb_id: d.ids?.tvdb || null,
      season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, logo_url: d.logoUrl || null, backdrop_url: d.backdropUrl || null, youtube_url: d.youtubeUrl || null,
      sync_action: d.syncAction || "watched", sync_dispatch_telemetry: d.syncDispatchTelemetry || null, sync_match_ignored_at: d.syncMatchIgnoredAt || null, watch_provenance: d.watchProvenance || null,
      media_key: d.mediaKey || null, show_title: d.showTitle || null, show_title_lower: d.showTitleLower || null,
      episode_title: d.episodeTitle || null, created_at: toMs(d.createdAt), updated_at: toMs(d.updatedAt),
    }),
  },
  playstate: {
    table: "playstate", key: "media_key",
    rowToData: (r) => ({ mediaKey: r.media_key, title: r.title || "", titleLower: r.title_lower || "", mediaType: r.media_type || "", state: r.state || "watched", watchedAt: r.watched_at || "", lastSource: r.last_source || "", sources: parseJson(r.sources, []), ids: ids(r), season: r.season, episode: r.episode, posterUrl: r.poster_url, updatedAt: r.updated_at }),
    insert: db.prepare("INSERT OR REPLACE INTO playstate (media_key,title,title_lower,media_type,state,watched_at,last_source,sources,imdb_id,tmdb_id,tvdb_id,season,episode,poster_url,updated_at) VALUES (@media_key,@title,@title_lower,@media_type,@state,@watched_at,@last_source,@sources,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@poster_url,@updated_at)"),
    dataToRow: (id, d) => ({ media_key: d.mediaKey || id, title: d.title || "", title_lower: d.titleLower || String(d.title || "").toLowerCase(), media_type: d.mediaType || "", state: d.state || "watched", watched_at: d.watchedAt || "", last_source: d.lastSource || d.source || "", sources: toJson(Array.isArray(d.sources) ? d.sources : []), imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null, season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, updated_at: toMs(d.updatedAt) }),
  },
  manualWatchReviews: rawCollection("manual_watch_reviews", "id", ["media_key", "source", "source_item_id", "title", "media_type", "show_title", "episode_title", "season", "episode", "release_date", "observed_watched_at", "source_fingerprint", "media_json", "status", "decision_mode", "created_at", "updated_at", "reviewed_at"]),
  playbackProgress: {
    table: "playback_progress", key: "media_key",
    rowToData: (r) => ({ mediaKey: r.media_key, title: r.title || "", mediaType: r.media_type || "", source: r.source || "", ids: ids(r), season: r.season, episode: r.episode, positionMs: r.position_ms, durationMs: r.duration_ms, progress: r.progress, updatedAt: r.updated_at, syncDispatchTelemetry: r.sync_dispatch_telemetry }),
    insert: db.prepare("INSERT OR REPLACE INTO playback_progress (media_key,title,media_type,source,imdb_id,tmdb_id,tvdb_id,season,episode,position_ms,duration_ms,progress,updated_at,sync_dispatch_telemetry) VALUES (@media_key,@title,@media_type,@source,@imdb_id,@tmdb_id,@tvdb_id,@season,@episode,@position_ms,@duration_ms,@progress,@updated_at,@sync_dispatch_telemetry)"),
    dataToRow: (id, d) => ({ media_key: d.mediaKey || id, title: d.title || "", media_type: d.mediaType || "", source: d.source || "", imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null, season: d.season ?? null, episode: d.episode ?? null, position_ms: d.positionMs ?? 0, duration_ms: d.durationMs ?? null, progress: d.progress ?? 0, updated_at: toMs(d.updatedAt) ?? Date.now(), sync_dispatch_telemetry: d.syncDispatchTelemetry || null }),
  },
  activeSessions: {
    table: "active_sessions", key: "id",
    rowToData: (r) => ({ title: r.title || "", mediaType: r.media_type || "", source: r.source || "", progress: r.progress, offsetMs: r.offset_ms, durationMs: r.duration_ms, season: r.season, episode: r.episode, posterUrl: r.poster_url, ids: parseJson(r.ids, {}), event: r.event, client: parseJson(r.client, {}), updatedAt: r.updated_at, expireAt: r.expire_at }),
    insert: db.prepare("INSERT OR REPLACE INTO active_sessions (id,title,media_type,source,progress,offset_ms,duration_ms,season,episode,poster_url,ids,event,client,updated_at,expire_at) VALUES (@id,@title,@media_type,@source,@progress,@offset_ms,@duration_ms,@season,@episode,@poster_url,@ids,@event,@client,@updated_at,@expire_at)"),
    dataToRow: (id, d) => ({ id, title: d.title || "", media_type: d.mediaType || "", source: d.source || "", progress: d.progress ?? 0, offset_ms: d.offsetMs ?? 0, duration_ms: d.durationMs ?? null, season: d.season ?? null, episode: d.episode ?? null, poster_url: d.posterUrl || null, ids: toJson(d.ids || {}), event: d.event || null, client: toJson(d.client || {}), updated_at: toMs(d.updatedAt) ?? Date.now(), expire_at: toMs(d.expireAt) }),
  },
  liveTrackingCache: {
    table: "live_tracking_cache", key: "session_id",
    rowToData: (r) => ({ title: r.title || "", sourcePlatform: r.source_platform || "", lastProgress: r.last_progress, updatedAt: r.updated_at, completedAt: r.completed_at, payload: parseJson(r.payload, {}), expireAt: r.expire_at }),
    insert: db.prepare("INSERT OR REPLACE INTO live_tracking_cache (session_id,title,source_platform,last_progress,updated_at,completed_at,payload,expire_at) VALUES (@session_id,@title,@source_platform,@last_progress,@updated_at,@completed_at,@payload,@expire_at)"),
    dataToRow: (id, d) => ({ session_id: id, title: d.title || "", source_platform: d.sourcePlatform || "", last_progress: d.lastProgress ?? 0, updated_at: toMs(d.updatedAt) ?? Date.now(), completed_at: toMs(d.completedAt), payload: toJson(d.payload || {}), expire_at: toMs(d.expireAt) }),
  },
  syncHistory: {
    table: "sync_history", key: "id", numericKey: true,
    rowToData: (r) => ({ timestamp: r.timestamp, mediaType: r.media_type || "unknown", title: r.title || "", source: r.source || "unknown", status: r.status || "unknown", details: r.details || "", action: r.action || "watched", targetStates: parseJson(r.target_states, []), rawPayloadDebug: parseJson(r.raw_payload_debug, {}), createdAt: r.created_at }),
    insert: db.prepare("INSERT INTO sync_history (timestamp,media_type,title,source,status,details,action,target_states,raw_payload_debug,created_at) VALUES (@timestamp,@media_type,@title,@source,@status,@details,@action,@target_states,@raw_payload_debug,@created_at)"),
    dataToRow: (_id, d) => ({ timestamp: toMs(d.timestamp) ?? Date.now(), media_type: d.mediaType || "unknown", title: d.title || "", source: d.source || "unknown", status: d.status || "unknown", details: d.details || "", action: d.action || "watched", target_states: toJson(Array.isArray(d.targetStates) ? d.targetStates : []), raw_payload_debug: toJson(d.rawPayloadDebug || {}), created_at: toMs(d.createdAt) ?? Date.now() }),
  },
  watchAuditEvents: {
    table: "watch_audit_events", key: "id", numericKey: true,
    rowToData: (r) => ({
      timestamp: r.timestamp,
      eventType: r.event_type || "unknown",
      action: r.action || "",
      watchRecordId: r.watch_record_id || "",
      mediaKey: r.media_key || "",
      mediaType: r.media_type || "",
      title: r.title || "",
      showTitle: r.show_title || "",
      source: r.source || "",
      sourceEvent: r.source_event || "",
      phase: r.phase || "",
      sourceTimestamp: r.source_timestamp || "",
      capturedAt: r.captured_at || "",
      target: r.target || "",
      status: r.status || "",
      details: r.details || "",
      device: r.device || "",
      deviceId: r.device_id || "",
      client: r.client || "",
      clientVersion: r.client_version || "",
      user: r.user_name || "",
      sessionId: r.session_id || "",
      itemId: r.item_id || "",
      ids: ids(r),
      season: r.season,
      episode: r.episode,
      payload: parseJson(r.payload, null),
      createdAt: r.created_at,
    }),
    insert: db.prepare(`INSERT OR REPLACE INTO watch_audit_events (
      id, timestamp, event_type, action, watch_record_id, media_key, media_type, title, title_lower,
      show_title, show_title_lower, source, source_event, phase, source_timestamp, captured_at, target, status, details,
      device, device_id, client, client_version, user_name, session_id, item_id,
      imdb_id, tmdb_id, tvdb_id, season, episode, payload, created_at
    ) VALUES (
      @id, @timestamp, @event_type, @action, @watch_record_id, @media_key, @media_type, @title, @title_lower,
      @show_title, @show_title_lower, @source, @source_event, @phase, @source_timestamp, @captured_at, @target, @status, @details,
      @device, @device_id, @client, @client_version, @user_name, @session_id, @item_id,
      @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @payload, @created_at
    )`),
    dataToRow: (id, d) => {
      const title = d.title || "";
      const showTitle = d.showTitle || "";
      return {
        id: Number(id), timestamp: toMs(d.timestamp) ?? Date.now(), event_type: d.eventType || "unknown", action: d.action || null,
        watch_record_id: d.watchRecordId || null, media_key: d.mediaKey || null, media_type: d.mediaType || null,
        title, title_lower: title.toLowerCase(), show_title: showTitle || null, show_title_lower: showTitle ? showTitle.toLowerCase() : null,
        source: d.source || null, source_event: d.sourceEvent || null, phase: d.phase || null, source_timestamp: d.sourceTimestamp || null, captured_at: d.capturedAt || null, target: d.target || null,
        status: d.status || "recorded", details: d.details || null, device: d.device || null, device_id: d.deviceId || null,
        client: d.client || null, client_version: d.clientVersion || null, user_name: d.user || null, session_id: d.sessionId || null,
        item_id: d.itemId || null, imdb_id: d.ids?.imdb || null, tmdb_id: d.ids?.tmdb || null, tvdb_id: d.ids?.tvdb || null,
        season: d.season ?? null, episode: d.episode ?? null, payload: d.payload == null ? null : toJson(d.payload), created_at: toMs(d.createdAt) ?? Date.now(),
      };
    },
  },
  mediaAuthDevices: simpleCollection("media_auth_devices", "id", (r) => ({ provider: r.provider, deviceIdentifier: r.device_identifier, deviceName: r.device_name, publicJwk: parseJson(r.public_jwk), privateKeyCiphertext: r.private_key_ciphertext, privateKeyIv: r.private_key_iv, privateKeyTag: r.private_key_tag, keyVersion: r.key_version, retiredAt: r.retired_at, replacementDeviceId: r.replacement_device_id, createdAt: r.created_at, updatedAt: r.updated_at }), "INSERT OR REPLACE INTO media_auth_devices (id,provider,device_identifier,device_name,public_jwk,private_key_ciphertext,private_key_iv,private_key_tag,key_version,retired_at,replacement_device_id,created_at,updated_at) VALUES (@id,@provider,@device_identifier,@device_name,@public_jwk,@private_key_ciphertext,@private_key_iv,@private_key_tag,@key_version,@retired_at,@replacement_device_id,@created_at,@updated_at)", (id, d) => ({ id, provider: d.provider, device_identifier: d.deviceIdentifier, device_name: d.deviceName, public_jwk: toJson(d.publicJwk), private_key_ciphertext: d.privateKeyCiphertext || null, private_key_iv: d.privateKeyIv || null, private_key_tag: d.privateKeyTag || null, key_version: d.keyVersion || 1, retired_at: toMs(d.retiredAt), replacement_device_id: d.replacementDeviceId || null, created_at: toMs(d.createdAt), updated_at: toMs(d.updatedAt) })),
  mediaConnections: simpleCollection("media_connections", "id", (r) => ({ provider: r.provider, baseUrl: r.base_url, serverId: r.server_id, serverName: r.server_name, authDeviceId: r.auth_device_id, remoteUserId: r.remote_user_id, remoteUsername: r.remote_username, authKind: r.auth_kind, credentialCiphertext: r.credential_ciphertext, credentialIv: r.credential_iv, credentialTag: r.credential_tag, tokenVersion: r.token_version, serverCredentialCiphertext: r.server_credential_ciphertext, serverCredentialIv: r.server_credential_iv, serverCredentialTag: r.server_credential_tag, serverTokenVersion: r.server_token_version, accessTokenExpiresAt: r.access_token_expires_at, lastRefreshedAt: r.last_refreshed_at, refreshFailureCount: r.refresh_failure_count, status: r.status, lastValidatedAt: r.last_validated_at, createdAt: r.created_at, updatedAt: r.updated_at }), "INSERT OR REPLACE INTO media_connections (id,provider,base_url,server_id,server_name,auth_device_id,remote_user_id,remote_username,auth_kind,credential_ciphertext,credential_iv,credential_tag,token_version,server_credential_ciphertext,server_credential_iv,server_credential_tag,server_token_version,access_token_expires_at,last_refreshed_at,refresh_failure_count,status,last_validated_at,created_at,updated_at) VALUES (@id,@provider,@base_url,@server_id,@server_name,@auth_device_id,@remote_user_id,@remote_username,@auth_kind,@credential_ciphertext,@credential_iv,@credential_tag,@token_version,@server_credential_ciphertext,@server_credential_iv,@server_credential_tag,@server_token_version,@access_token_expires_at,@last_refreshed_at,@refresh_failure_count,@status,@last_validated_at,@created_at,@updated_at)", (id, d) => ({ id, provider: d.provider, base_url: d.baseUrl, server_id: d.serverId, server_name: d.serverName || null, auth_device_id: d.authDeviceId, remote_user_id: d.remoteUserId, remote_username: d.remoteUsername || null, auth_kind: d.authKind, credential_ciphertext: d.credentialCiphertext, credential_iv: d.credentialIv, credential_tag: d.credentialTag, token_version: d.tokenVersion || 1, server_credential_ciphertext: d.serverCredentialCiphertext || null, server_credential_iv: d.serverCredentialIv || null, server_credential_tag: d.serverCredentialTag || null, server_token_version: d.serverTokenVersion || 1, access_token_expires_at: toMs(d.accessTokenExpiresAt), last_refreshed_at: toMs(d.lastRefreshedAt), refresh_failure_count: d.refreshFailureCount || 0, status: d.status, last_validated_at: toMs(d.lastValidatedAt), created_at: toMs(d.createdAt), updated_at: toMs(d.updatedAt) })),
  trackerConnections: rawCollection("tracker_connections", "id", ["provider","status","remote_user_id","remote_username","client_id","client_secret_ciphertext","client_secret_iv","client_secret_tag","access_token_ciphertext","access_token_iv","access_token_tag","refresh_token_ciphertext","refresh_token_iv","refresh_token_tag","token_version","access_token_expires_at","initial_sync_mode","baseline_complete","last_polled_at","last_validated_at","last_error","created_at","updated_at"]),
  trackerItemState: rawCollection("tracker_item_state", "media_key", ["provider","media_json","remote_watched_at","last_seen_at","last_outbound_state","last_outbound_at"]),
  settings: browserSettingsCollection(),
  runtimeState: jsonCollection("runtime_state"),
  loopKeys: simpleCollection("loop_keys", "id", (r) => ({ key: r.key || "", value: r.value || "", createdAt: r.created_at, expireAt: r.expire_at }), "INSERT OR REPLACE INTO loop_keys (id,key,value,created_at,expire_at) VALUES (@id,@key,@value,@created_at,@expire_at)", (id, d) => ({ id, key: d.key || "", value: d.value || "", created_at: toMs(d.createdAt), expire_at: toMs(d.expireAt) })),
  mediaArtwork: simpleCollection("media_artwork", "identity_key", (r) => ({ mediaType: r.media_type, title: r.title, tmdbId: r.tmdb_id, tvdbId: r.tvdb_id, imdbId: r.imdb_id, posterUrl: r.poster_url, posterSource: r.poster_source, updatedAt: r.updated_at }), "INSERT OR REPLACE INTO media_artwork (identity_key,media_type,title,tmdb_id,tvdb_id,imdb_id,poster_url,poster_source,updated_at) VALUES (@identity_key,@media_type,@title,@tmdb_id,@tvdb_id,@imdb_id,@poster_url,@poster_source,@updated_at)", (id, d) => ({ identity_key: id, media_type: d.mediaType || "tv", title: d.title || null, tmdb_id: d.tmdbId || null, tvdb_id: d.tvdbId || null, imdb_id: d.imdbId || null, poster_url: d.posterUrl || null, poster_source: d.posterSource || "manual", updated_at: toMs(d.updatedAt) ?? Date.now() })),
  posterCache: simpleCollection("poster_cache", "id", (r) => ({ mediaKey: r.media_key, variant: r.variant, status: r.status, source: r.source, detail: r.detail, originalUrl: r.original_url, storagePath: r.storage_path, contentType: r.content_type, sizeBytes: r.size_bytes, url: r.url, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO poster_cache (id,media_key,variant,status,source,detail,original_url,storage_path,content_type,size_bytes,url,updated_at_ms) VALUES (@id,@media_key,@variant,@status,@source,@detail,@original_url,@storage_path,@content_type,@size_bytes,@url,@updated_at_ms)", (id, d) => ({ id, media_key: d.mediaKey || null, variant: d.variant || "poster", status: d.status || "missing", source: d.source || "unknown", detail: d.detail || null, original_url: d.originalUrl || null, storage_path: d.storagePath || null, content_type: d.contentType || null, size_bytes: d.sizeBytes ?? null, url: d.url || null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbMetadataCache: simpleCollection("tmdb_metadata_cache", "id", (r) => ({ tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, details: parseJson(r.details), schemaVersion: r.schema_version, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_metadata_cache (id,tmdb_id,media_type,title,details,schema_version,updated_at_ms) VALUES (@id,@tmdb_id,@media_type,@title,@details,@schema_version,@updated_at_ms)", (id, d) => ({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, media_type: d.mediaType || null, title: d.title || null, details: d.details == null ? null : toJson(d.details), schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbSearchCache: simpleCollection("tmdb_search_cache", "id", (r) => ({ query: r.query, mediaType: r.media_type, page: r.page, response: parseJson(r.response), missing: Boolean(r.missing), updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_search_cache (id,query,media_type,page,response,missing,updated_at_ms) VALUES (@id,@query,@media_type,@page,@response,@missing,@updated_at_ms)", (id, d) => ({ id, query: d.query || "", media_type: d.mediaType || null, page: d.page ?? 1, response: toJson(d.response), missing: d.missing ? 1 : 0, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbSeasonCache: simpleCollection("tmdb_season_cache", "id", (r) => ({ tmdbId: r.tmdb_id, seasonNumber: r.season_number, showStatus: r.show_status, details: parseJson(r.details), updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_season_cache (id,tmdb_id,season_number,show_status,details,updated_at_ms) VALUES (@id,@tmdb_id,@season_number,@show_status,@details,@updated_at_ms)", (id, d) => ({ id, tmdb_id: d.tmdbId != null ? String(d.tmdbId) : null, season_number: d.seasonNumber ?? null, show_status: d.showStatus || null, details: toJson(d.details), updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  tmdbPersonCache: simpleCollection("tmdb_person_cache", "id", (r) => ({ personId: r.person_id, details: parseJson(r.details), schemaVersion: r.schema_version, updatedAtMs: r.updated_at_ms }), "INSERT OR REPLACE INTO tmdb_person_cache (id,person_id,details,schema_version,updated_at_ms) VALUES (@id,@person_id,@details,@schema_version,@updated_at_ms)", (id, d) => ({ id, person_id: d.personId != null ? String(d.personId) : null, details: toJson(d.details), schema_version: d.schemaVersion ?? null, updated_at_ms: d.updatedAtMs ?? toMs(d.updatedAt) })),
  personalWatchlist: rawCollection("personal_watchlist", "media_key", ["media_type", "title", "tmdb_id", "tvdb_id", "imdb_id", "poster_url", "overview", "release_date", "created_at", "updated_at"]),
  personalWatchlistMutations: rawCollection("personal_watchlist_mutations", "id", ["media_key", "media_json", "desired_state", "origin", "reason", "canonical_revision", "event_fingerprint", "source_timestamp", "created_at", "superseded_at", "applied_at", "tombstone"]),
  personalWatchlistProviderItems: watchlistRawCollection("personal_watchlist_provider_items", ["provider", "connection_id", "remote_scope_key", "representation", "media_key", "media_json", "provider_item_id", "provider_ids_json", "remote_state", "managed_by_plembfin", "primary_target", "container_id", "container_name", "last_confirmed_present_at", "last_seen_at", "last_complete_generation", "last_outbound_state", "last_outbound_intent_id", "last_outbound_at", "sync_status", "last_error", "updated_at"]),
  personalWatchlistSyncQueue: watchlistRawCollection("personal_watchlist_sync_queue", ["provider", "connection_id", "remote_scope_key", "representation", "media_key", "media_json", "desired_state", "operation", "source_mutation_id", "intent_id", "canonical_revision", "provider_item_id", "status", "attempt_count", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error", "created_at", "updated_at", "succeeded_at"]),
  personalWatchlistSyncRuns: watchlistRawCollection("personal_watchlist_sync_runs", ["provider", "connection_id", "remote_scope_key", "representation", "run_id", "generation", "mode", "status", "canonical_revision", "scanned_count", "present_count", "removed_count", "unavailable_count", "started_at", "completed_at", "cursor_json", "complete_snapshot", "snapshot_hash", "last_error", "updated_at"]),
  personalWatchlistActivity: rawCollection("personal_watchlist_activity", "id", ["provider", "connection_id", "remote_scope_key", "representation", "media_key", "media_json", "action", "origin", "reason", "status", "details", "created_at"]),
};

function simpleCollection(table, key, rowToData, sql, dataToRow) {
  return { table, key, rowToData, insert: db.prepare(sql), dataToRow };
}

function rawCollection(table, key, columns) {
  const all = [key, ...columns];
  return simpleCollection(
    table,
    key,
    (row) => Object.fromEntries(columns.map((column) => [column, row[column]])),
    `INSERT OR REPLACE INTO ${table} (${all.join(",")}) VALUES (${all.map((column) => `@${column}`).join(",")})`,
    (id, data) => ({ [key]: id, ...Object.fromEntries(columns.map((column) => [column, data[column] ?? null])) }),
  );
}

function watchlistRawCollection(table, columns) {
  const collection = rawCollection(table, "rowid", columns);
  collection.numericKey = true;
  const dataToRow = collection.dataToRow;
  collection.dataToRow = (id, data) => {
    const rowid = Number(id);
    if (!Number.isSafeInteger(rowid) || rowid < 1) {
      throw new Error(`A ${table} backup document has an invalid rowid`);
    }
    return dataToRow(rowid, data);
  };
  return collection;
}

function jsonCollection(table) {
  return {
    table, key: "id",
    rowToData: (row) => parseJson(row.data, {}),
    insert: db.prepare(`INSERT OR REPLACE INTO ${table} (id,data,updated_at) VALUES (@id,@data,@updated_at)`),
    dataToRow: (id, data) => ({ id, data: toJson(data), updated_at: Date.now() }),
  };
}

function browserSettingsCollection() {
  const collection = jsonCollection("settings");
  collection.browserRowToData = (row) => redactBrowserSettings(parseJson(row.data, {}));
  return collection;
}

export function backupManifest(origin = "") {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    portable: true,
    exportedAt: new Date().toISOString(),
    source: { app: "plekt", storage: "sqlite", origin },
    collections: BROWSER_BACKUP_COLLECTIONS,
    notes: [
      "Browser portable exports omit credential-bearing collections and redact secret-bearing settings. Encrypted full backups retain encrypted media credentials; restoring encrypted connections requires the original credential.key or PLEKT_CREDENTIAL_KEY (PLEMBFIN_CREDENTIAL_KEY on older installs).",
      "Artwork binaries, poster cache rows, and TMDB metadata cache rows are not included.",
    ],
  };
}

export function getFullBackup(origin = "") {
  const backup = backupManifest(origin);
  backup.portable = false;
  backup.collections = {};
  for (const name of BACKUP_COLLECTIONS) {
    const config = collections[name];
    if (!config) continue;
    const select = config.numericKey ? `${config.key}, *` : "*";
    const rows = db.prepare(`SELECT ${select} FROM ${config.table} ORDER BY ${config.key}`).all();
    backup.collections[name] = rows.map((row) => ({
      id: String(row[config.key]),
      data: portableValue(config.rowToData(row)),
    }));
  }
  return backup;
}

// The same document as JSON.stringify(getFullBackup()), produced in pieces so a
// large library never holds the whole backup in memory at once. Rows are read
// with a synchronous iterator, so callers must consume it without awaiting.
export function* fullBackupJsonChunks(origin = "") {
  const placeholder = "__plembfinCollectionsPlaceholder__";
  const manifest = backupManifest(origin);
  manifest.portable = false;
  manifest.collections = placeholder;
  const [head, tail] = JSON.stringify(manifest).split(JSON.stringify(placeholder));
  yield `${head}{`;
  let firstCollection = true;
  for (const name of BACKUP_COLLECTIONS) {
    const config = collections[name];
    if (!config) continue;
    yield `${firstCollection ? "" : ","}${JSON.stringify(name)}:[`;
    firstCollection = false;
    const select = config.numericKey ? `${config.key}, *` : "*";
    let firstRow = true;
    for (const row of db.prepare(`SELECT ${select} FROM ${config.table} ORDER BY ${config.key}`).iterate()) {
      const document = { id: String(row[config.key]), data: portableValue(config.rowToData(row)) };
      yield `${firstRow ? "" : ","}${JSON.stringify(document)}`;
      firstRow = false;
    }
    yield "]";
  }
  yield `}${tail}`;
}

export function exportCollectionPage(name, { cursor = "", limit = 250, browserSafe = true } = {}) {
  const config = collections[name];
  if (!config) throw new Error(`Unknown backup collection: ${name}`);
  if (browserSafe && !BROWSER_BACKUP_COLLECTIONS.includes(name)) {
    throw new Error(`Collection is not available in browser portable exports: ${name}`);
  }
  const pageLimit = Math.max(1, Math.min(Number(limit) || 250, 500));
  const comparator = config.numericKey ? Number(cursor) || 0 : String(cursor || "");
  const select = config.numericKey ? `${config.key}, *` : "*";
  const rows = cursor
    ? db.prepare(`SELECT ${select} FROM ${config.table} WHERE ${config.key} > ? ORDER BY ${config.key} LIMIT ?`).all(comparator, pageLimit)
    : db.prepare(`SELECT ${select} FROM ${config.table} ORDER BY ${config.key} LIMIT ?`).all(pageLimit);
  const rowToData = browserSafe ? (config.browserRowToData || config.rowToData) : config.rowToData;
  const documents = rows.map((row) => ({ id: String(row[config.key]), data: portableValue(rowToData(row)) }));
  return {
    collection: name,
    documents,
    nextCursor: rows.length === pageLimit ? String(rows.at(-1)[config.key]) : "",
    hasMore: rows.length === pageLimit,
  };
}

function restoreWatchlistMedia(row) {
  return {
    media_key: row.media_key,
    media_type: row.media_type,
    title: row.title || "Untitled",
    tmdb_id: row.tmdb_id || "",
    tvdb_id: row.tvdb_id || "",
    imdb_id: row.imdb_id || "",
    poster_url: row.poster_url || "",
    overview: row.overview || "",
    release_date: row.release_date || "",
  };
}

// A restore must leave a durable local desired state while invalidating every
// remote observation and outbound result from the source instance. The next
// explicit Publish restored watchlist action is the only operation allowed to
// establish new provider state.
function createWatchlistRestoreRevision() {
  const now = Date.now();
  const restoreState = getWatchlistRestoreState();
  const restoreId = restoreState.restoreId || crypto.randomUUID();
  const canonicalRows = db.prepare("SELECT * FROM personal_watchlist ORDER BY media_key").all();
  const latestRows = db.prepare(`
    SELECT mutation.*
    FROM personal_watchlist_mutations mutation
    INNER JOIN (
      SELECT media_key, MAX(canonical_revision) AS revision
      FROM personal_watchlist_mutations
      GROUP BY media_key
    ) latest ON latest.media_key = mutation.media_key AND latest.revision = mutation.canonical_revision
    ORDER BY mutation.media_key
  `).all();
  const desired = new Map(canonicalRows.map((row) => [row.media_key, { state: "present", media: restoreWatchlistMedia(row) }]));
  for (const row of latestRows) {
    if (desired.has(row.media_key)) continue;
    if (row.desired_state !== "absent") continue;
    desired.set(row.media_key, { state: "absent", media: parseJson(row.media_json, { media_key: row.media_key, media_type: "movie", title: "Untitled" }) });
  }

  const insert = db.prepare(`
    INSERT INTO personal_watchlist_mutations
      (id, media_key, media_json, desired_state, origin, reason, canonical_revision,
       event_fingerprint, source_timestamp, created_at, superseded_at, applied_at, tombstone)
    VALUES (?, ?, ?, ?, 'restore', 'restore', ?, ?, NULL, ?, NULL, ?, ?)
  `);
  const supersede = db.prepare("UPDATE personal_watchlist_mutations SET superseded_at = ? WHERE media_key = ? AND superseded_at IS NULL");
  const meta = db.prepare("SELECT revision FROM personal_watchlist_meta WHERE id = 1");
  const updateMeta = db.prepare("UPDATE personal_watchlist_meta SET revision = ?, updated_at = ? WHERE id = 1");
  let revision = Number(meta.get()?.revision || 0);
  let lastRevision = revision;
  db.transaction(() => {
    for (const [mediaKey, entry] of desired) {
      revision += 1;
      supersede.run(now, mediaKey);
      insert.run(crypto.randomUUID(), mediaKey, toJson(entry.media), entry.state, revision, `restore:${restoreId}:${mediaKey}:${revision}`, now, now, entry.state === "absent" ? 1 : 0);
      lastRevision = revision;
    }
    updateMeta.run(revision, now);
  })();
  clearWatchlistRemoteProjection();
  const pending = markWatchlistRestorePending({ restoreId, timestamp: now });
  return { ...pending, revision: lastRevision, restoredItems: desired.size };
}

function importWatchlistCollectionBatch(name, documents, { reset = false } = {}) {
  const config = collections[name];
  if (!config) throw new Error(`Unknown backup collection: ${name}`);
  if (!Array.isArray(documents)) throw new Error("Backup documents must be an array");
  if (documents.length > 250) throw new Error("Backup import batches are limited to 250 documents");

  const run = db.transaction(() => {
    if (name === "personalWatchlist" && reset) {
      for (const table of ["personal_watchlist", "personal_watchlist_mutations", "personal_watchlist_provider_items", "personal_watchlist_sync_queue", "personal_watchlist_sync_runs", "personal_watchlist_activity"]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      db.prepare("UPDATE personal_watchlist_meta SET revision = 0, updated_at = ? WHERE id = 1").run(Date.now());
    } else if (reset) {
      if (name === "personalWatchlistMutations") db.prepare("DELETE FROM personal_watchlist_mutations").run();
      if (name === "personalWatchlistProviderItems") db.prepare("DELETE FROM personal_watchlist_provider_items").run();
      if (name === "personalWatchlistSyncQueue") db.prepare("DELETE FROM personal_watchlist_sync_queue").run();
      if (name === "personalWatchlistSyncRuns") db.prepare("DELETE FROM personal_watchlist_sync_runs").run();
      if (name === "personalWatchlistActivity") db.prepare("DELETE FROM personal_watchlist_activity").run();
    }
    for (const document of documents) {
      const id = String(document?.id || "").trim();
      if (!id) throw new Error(`A ${name} document is missing its id`);
      const data = reviveValue(document.data || {});
      config.insert.run(config.dataToRow(id, data));
    }

    if (name === "personalWatchlistProviderItems") {
      db.prepare(`
        UPDATE personal_watchlist_provider_items
        SET remote_state = 'unknown', sync_status = 'unknown',
            last_confirmed_present_at = NULL, last_seen_at = NULL,
            last_complete_generation = NULL, last_outbound_state = NULL,
            last_outbound_intent_id = NULL, last_outbound_at = NULL,
            last_error = NULL, updated_at = ?
      `).run(Date.now());
    }
    if (name === "personalWatchlistSyncQueue") {
      db.prepare(`
        UPDATE personal_watchlist_sync_queue
        SET status = 'pending', attempt_count = 0, next_attempt_at = 0,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = 'Restore requires explicit watchlist publish.',
            succeeded_at = NULL, updated_at = ?
      `).run(Date.now());
    }
    if (name === "personalWatchlistSyncRuns") {
      db.prepare(`
        UPDATE personal_watchlist_sync_runs
        SET status = 'idle', started_at = NULL, completed_at = NULL,
            cursor_json = NULL, complete_snapshot = 0,
            last_error = 'Restore requires explicit watchlist publish.', updated_at = ?
      `).run(Date.now());
    }
  });
  run();

  let restore = null;
  if (["personalWatchlist", "personalWatchlistMutations"].includes(name)) restore = createWatchlistRestoreRevision();
  else if (WATCHLIST_BACKUP_COLLECTIONS.has(name)) restore = markWatchlistRestorePending();
  bumpDataVersion();
  return { collection: name, imported: documents.length, reset: Boolean(reset), restore };
}

export function importCollectionBatch(name, documents, { reset = false, portable = false } = {}) {
  if (WATCHLIST_BACKUP_COLLECTIONS.has(name)) return importWatchlistCollectionBatch(name, documents, { reset });
  const config = collections[name];
  if (!config) throw new Error(`Unknown backup collection: ${name}`);
  if (!Array.isArray(documents)) throw new Error("Backup documents must be an array");
  if (documents.length > 250) throw new Error("Backup import batches are limited to 250 documents");

  const run = db.transaction(() => {
    if (reset && !(portable && name === "settings")) db.prepare(`DELETE FROM ${config.table}`).run();
    for (const document of documents) {
      const id = String(document?.id || "").trim();
      if (!id) throw new Error(`A ${name} document is missing its id`);
      const data = reviveValue(document.data || {});
      const importData = name === "settings" && portable
        ? mergeRedactedSettings(parseJson(db.prepare("SELECT data FROM settings WHERE id = ?").get(id)?.data, {}), data)
        : data;
      config.insert.run(config.dataToRow(id, importData));
    }
  });
  run();

  if (["watchHistory", "playstate", "playbackProgress", "mediaArtwork"].includes(name)) bumpDataVersion();
  return { collection: name, imported: documents.length, reset: Boolean(reset) };
}
