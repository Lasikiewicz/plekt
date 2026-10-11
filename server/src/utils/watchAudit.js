import { db, parseJson, toJson } from "../db.js";

const MAX_TEXT_LENGTH = 500;
const MAX_TITLE_LENGTH = 500;

function text(value, maxLength = MAX_TEXT_LENGTH) {
  const valueText = String(value ?? "").trim();
  return valueText ? valueText.slice(0, maxLength) : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function object(value) {
  return value && typeof value === "object" ? value : {};
}

function keyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function idsFrom(event = {}) {
  const ids = object(event.ids || event.media?.ids);
  return {
    imdb: text(event.imdbId || event.imdb_id || ids.imdb),
    tmdb: text(event.tmdbId || event.tmdb_id || ids.tmdb),
    tvdb: text(event.tvdbId || event.tvdb_id || ids.tvdb),
  };
}

function titleFields(event = {}) {
  const media = object(event.media);
  const title = text(event.title || media.title, MAX_TITLE_LENGTH);
  const showTitle = text(event.showTitle || event.show_title || media.showTitle || media.show_title, MAX_TITLE_LENGTH);
  return {
    title,
    title_lower: title ? title.toLowerCase() : null,
    show_title: showTitle,
    show_title_lower: showTitle ? showTitle.toLowerCase() : null,
  };
}

function mediaFields(event = {}) {
  const media = object(event.media);
  const provenance = object(event.watchProvenance || event.watch_provenance || media.watchProvenance || media.watch_provenance);
  const ids = idsFrom(event);
  const title = titleFields(event);
  const clientObject = object(event.client || media.client);
  const clientValue = typeof event.client === "string"
    ? event.client
    : clientObject.client || clientObject.product || clientObject.platform || clientObject.name;
  return {
    media_type: text(event.mediaType || event.media_type || event.type || media.type || media.mediaType),
    source: text(event.source || media.source),
    source_event: text(event.sourceEvent || event.source_event || event.event || media.event),
    phase: text(event.phase || media.phase),
    source_timestamp: text(event.sourceTimestamp || event.source_timestamp || media.sourceTimestamp || media.source_timestamp || provenance.source_timestamp),
    captured_at: text(event.capturedAt || event.captured_at || media.capturedAt || media.captured_at || provenance.captured_at),
    device: text(event.device || event.deviceName || media.device || media.deviceName || provenance.device || provenance.deviceName),
    device_id: text(event.deviceId || event.device_id || media.deviceId || media.device_id || provenance.deviceId || provenance.device_id),
    client: text(clientValue || provenance.client),
    client_version: text(event.clientVersion || event.client_version || media.clientVersion || media.client_version || provenance.clientVersion || provenance.client_version),
    user_name: text(event.user || event.userName || event.user_name || media.user || media.userName || provenance.user),
    session_id: text(event.sessionId || event.session_id || media.sessionId || media.session_id || provenance.sessionId || provenance.session_id),
    item_id: text(event.itemId || event.item_id || media.itemId || media.item_id || provenance.itemId || provenance.item_id),
    imdb_id: ids.imdb,
    tmdb_id: ids.tmdb,
    tvdb_id: ids.tvdb,
    season: numberOrNull(event.season ?? media.season),
    episode: numberOrNull(event.episode ?? media.episode),
    ...title,
  };
}

function eventPayload(event = {}) {
  if (event.payload !== undefined) return event.payload;
  if (event.rawPayload !== undefined) return event.rawPayload;
  if (event.rawPayloadDebug !== undefined) return event.rawPayloadDebug;
  return null;
}

function derivedMediaKey(event = {}) {
  const fields = mediaFields(event);
  const coordinates = [keyPart(fields.media_type), keyPart(fields.season), keyPart(fields.episode)].join(":");
  const id = fields.imdb_id
    ? `imdb:${keyPart(fields.imdb_id)}`
    : fields.tmdb_id
      ? `tmdb:${keyPart(fields.tmdb_id)}`
      : fields.tvdb_id
        ? `tvdb:${keyPart(fields.tvdb_id)}`
        : `title:${keyPart(fields.title)}`;
  return `${coordinates}:${id}`;
}

function insertParams(event = {}) {
  const fields = mediaFields(event);
  const now = Date.now();
  const payload = eventPayload(event);
  return {
    timestamp: numberOrNull(event.timestamp || event.occurredAt) || now,
    event_type: text(event.eventType || event.event_type || "unknown") || "unknown",
    action: text(event.action),
    watch_record_id: text(event.watchRecordId || event.watch_record_id),
    media_key: text(event.mediaKey || event.media_key) || derivedMediaKey(event),
    ...fields,
    target: text(event.target),
    status: text(event.status) || "recorded",
    details: text(event.details, 1000),
    payload: payload == null ? null : toJson(payload),
    created_at: now,
  };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    timestamp: Number(row.timestamp || row.created_at || 0),
    eventType: row.event_type || "unknown",
    action: row.action || "",
    watchRecordId: row.watch_record_id || "",
    mediaKey: row.media_key || "",
    mediaType: row.media_type || "",
    title: row.title || "",
    showTitle: row.show_title || "",
    source: row.source || "",
    sourceEvent: row.source_event || "",
    phase: row.phase || "",
    sourceTimestamp: row.source_timestamp || "",
    capturedAt: row.captured_at || "",
    target: row.target || "",
    status: row.status || "",
    details: row.details || "",
    device: row.device || "",
    deviceId: row.device_id || "",
    client: row.client || "",
    clientVersion: row.client_version || "",
    user: row.user_name || "",
    sessionId: row.session_id || "",
    itemId: row.item_id || "",
    ids: {
      imdb: row.imdb_id || "",
      tmdb: row.tmdb_id || "",
      tvdb: row.tvdb_id || "",
    },
    season: row.season ?? null,
    episode: row.episode ?? null,
    payload: parseJson(row.payload, null),
    createdAt: Number(row.created_at || 0),
  };
}

const insertStmt = db.prepare(`
  INSERT INTO watch_audit_events (
    timestamp, event_type, action, watch_record_id, media_key, media_type, title, title_lower,
    show_title, show_title_lower, source, source_event, phase, source_timestamp, captured_at, target, status, details,
    device, device_id, client, client_version, user_name, session_id, item_id,
    imdb_id, tmdb_id, tvdb_id, season, episode, payload, created_at
  ) VALUES (
    @timestamp, @event_type, @action, @watch_record_id, @media_key, @media_type, @title, @title_lower,
    @show_title, @show_title_lower, @source, @source_event, @phase, @source_timestamp, @captured_at, @target, @status, @details,
    @device, @device_id, @client, @client_version, @user_name, @session_id, @item_id,
    @imdb_id, @tmdb_id, @tvdb_id, @season, @episode, @payload, @created_at
  )
`);

// Routine source events keep a compact debug summary, provenance, and request
// details for 90 days. Rejected events keep the full payload until the same
// retention cutoff, because they need troubleshooting. Decision recorded in
// plan/active/data-growth-and-reliability/plan.md.
export function auditSourceEventPayload(payload = {}, isValid = true) {
  const raw = payload?.rawPayloadDebug;
  if (!isValid || !raw || typeof raw !== "object") return payload;
  return {
    ...payload,
    rawPayloadDebug: {
      trimmed: true,
      originalBytes: Buffer.byteLength(JSON.stringify(raw)),
      topLevelKeys: Object.keys(raw),
      ids: raw.ids && typeof raw.ids === "object" ? raw.ids : null,
    },
  };
}

export const AUDIT_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUDIT_PAYLOAD_PRUNE_BATCH = 2000;
const countPrunablePayloadStmt = db.prepare(`
  SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
  FROM watch_audit_events
  WHERE event_type = 'source_event' AND payload IS NOT NULL AND created_at < ?
`);
const prunePayloadStmt = db.prepare(`
  UPDATE watch_audit_events SET payload = NULL
  WHERE id IN (
    SELECT id FROM watch_audit_events
    WHERE event_type = 'source_event' AND payload IS NOT NULL AND created_at < ?
    LIMIT ?
  )
`);

// Read-only: how many payloads and bytes a prune would clear right now.
export function countPrunableAuditPayloads(now = Date.now()) {
  const row = countPrunablePayloadStmt.get(now - AUDIT_PAYLOAD_RETENTION_MS);
  return { rows: Number(row.rows), bytes: Number(row.bytes) };
}

// Clears source-event payloads older than the retention window in bounded batches. Summary
// columns (type, media key, phase, source, status, timestamp) are never touched.
export function pruneWatchAuditPayloads(now = Date.now(), batchSize = AUDIT_PAYLOAD_PRUNE_BATCH) {
  return prunePayloadStmt.run(now - AUDIT_PAYLOAD_RETENTION_MS, batchSize).changes;
}

export function recordWatchAuditEvent(event = {}) {
  try {
    const result = insertStmt.run(insertParams(event));
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.error("Failed to store watch audit event", error);
    return null;
  }
}

export function recordWatchAuditEvents(events = []) {
  const values = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!values.length) return [];
  try {
    const run = db.transaction(() => values.map((event) => {
      const result = insertStmt.run(insertParams(event));
      return Number(result.lastInsertRowid);
    }));
    return run();
  } catch (error) {
    console.error("Failed to store watch audit events", error);
    return [];
  }
}

function queryValues(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || "").trim()).filter(Boolean))];
}

function addInClause(clauses, params, column, values, transform = (value) => value) {
  const normalized = queryValues(values).map(transform);
  if (!normalized.length) return;
  clauses.push(`${column} IN (${normalized.map(() => "?").join(",")})`);
  params.push(...normalized);
}

export function listWatchAuditEvents({
  mediaKeys = [],
  recordIds = [],
  titles = [],
  showTitles = [],
  ids = {},
  mediaType = "",
  limit = 2000,
} = {}) {
  const clauses = [];
  const params = [];
  addInClause(clauses, params, "media_key", mediaKeys);
  addInClause(clauses, params, "watch_record_id", recordIds);

  const idClauses = [];
  for (const [column, value] of [["imdb_id", ids.imdb], ["tmdb_id", ids.tmdb], ["tvdb_id", ids.tvdb]]) {
    if (!value) continue;
    idClauses.push(`${column} = ?`);
    params.push(String(value));
  }
  if (idClauses.length) clauses.push(`(${idClauses.join(" OR ")})`);

  const titleClauses = [];
  const hasStrongIdentity = queryValues(mediaKeys).length > 0 || queryValues(recordIds).length > 0 || idClauses.length > 0;
  if (!hasStrongIdentity) {
    for (const value of queryValues(titles)) {
      titleClauses.push("title_lower = ?");
      params.push(value.toLowerCase());
    }
    for (const value of queryValues(showTitles)) {
      titleClauses.push("show_title_lower = ?");
      params.push(value.toLowerCase());
    }
  }
  if (titleClauses.length) clauses.push(`(${titleClauses.join(" OR ")})`);
  if (!clauses.length) return [];

  const type = String(mediaType || "").trim().toLowerCase();
  let typeClause = "";
  if (type) {
    const normalizedType = ["tv", "show", "series"].includes(type) ? "episode" : type;
    typeClause = "(media_type = ? OR media_type IS NULL OR media_type = '')";
    params.push(normalizedType);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 10000);
  const identityClause = clauses.join(" OR ");
  return db.prepare(`
    SELECT * FROM watch_audit_events
    WHERE (${identityClause})${typeClause ? ` AND ${typeClause}` : ""}
    ORDER BY timestamp ASC, id ASC
    LIMIT ?
  `).all(...params, safeLimit).map(rowToEvent);
}

export function hasWatchAuditEventForRecord(recordId = "") {
  if (!recordId) return false;
  const row = db.prepare("SELECT id FROM watch_audit_events WHERE watch_record_id = ? LIMIT 1").get(String(recordId));
  return Boolean(row);
}

export function watchAuditEventForLegacyRecord(record = {}) {
  if (!record?.id || hasWatchAuditEventForRecord(record.id)) return null;
  return recordWatchAuditEvent({
    eventType: "legacy_record",
    timestamp: Date.parse(record.watched_at || "") || Date.now(),
    action: record.sync_action || "watched",
    watchRecordId: record.id,
    mediaKey: record.media_key,
    mediaType: record.media_type,
    title: record.title,
    showTitle: record.show_title,
    source: record.source,
    watchProvenance: record.watch_provenance,
    ids: { imdb: record.imdb_id, tmdb: record.tmdb_id, tvdb: record.tvdb_id },
    season: record.season,
    episode: record.episode,
    status: "historical",
    details: "This row predates detailed audit capture. The exact source event, device, and dispatch sequence were not stored and cannot be reconstructed exactly.",
    payload: {
      storedRecord: record,
      reconstruction: "not_available",
    },
  });
}
