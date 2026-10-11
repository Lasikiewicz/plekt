import crypto from "node:crypto";
import { db, parseJson, toJson, transaction } from "../db.js";
import { personalRatingMediaAliases, ratingMediaForStorage, showTitleKey } from "./personalRatingIdentity.js";

export const PERSONAL_RATING_PROVIDERS = ["plex", "emby", "jellyfin", "trakt"];
const QUEUE_STATUSES = ["pending", "processing", "succeeded", "not_found", "reauth_required", "failed"];
const SOURCE_STATUSES = ["unknown", "synced", "pending", "conflict", "not_found", "reauth_required", "failed"];
const MAX_ERROR_LENGTH = 1000;

function cleanError(value) {
  return String(value || "").trim().slice(0, MAX_ERROR_LENGTH) || null;
}

function providerOrThrow(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!PERSONAL_RATING_PROVIDERS.includes(value)) throw new Error(`Unsupported rating provider: ${provider}`);
  return value;
}

function ratingStateOrThrow(state) {
  const value = String(state || "").trim().toLowerCase();
  if (!new Set(["rated", "unrated"]).has(value)) throw new Error("Rating desired state must be rated or unrated");
  return value;
}

function mapSourceRow(row) {
  if (!row) return null;
  return {
    ...row,
    media: parseJson(row.media_json, {}),
    provider_ids: parseJson(row.provider_ids_json, {}),
    remote_rating: row.remote_rating == null ? null : Number(row.remote_rating),
    remote_state: row.remote_state || "unknown",
  };
}

function mapQueueRow(row) {
  if (!row) return null;
  return {
    ...row,
    media: parseJson(row.media_json, {}),
    desired_rating: row.desired_rating == null ? null : Number(row.desired_rating),
    canonical_version: Number(row.canonical_version || 0),
    attempt_count: Number(row.attempt_count || 0),
  };
}

function mapRunRow(row) {
  if (!row) return null;
  return {
    ...row,
    baseline_complete: Boolean(row.baseline_complete),
    generation: Number(row.generation || 0),
    scanned_count: Number(row.scanned_count || 0),
    changed_count: Number(row.changed_count || 0),
    imported_count: Number(row.imported_count || 0),
    cleared_count: Number(row.cleared_count || 0),
    queued_count: Number(row.queued_count || 0),
    cursor: parseJson(row.cursor_json, null),
  };
}

export function listCanonicalPersonalRatings({ limit = 0, offset = 0 } = {}) {
  const safeLimit = Math.max(0, Math.round(Number(limit) || 0));
  const safeOffset = Math.max(0, Math.round(Number(offset) || 0));
  const sql = safeLimit > 0
    ? "SELECT * FROM personal_ratings ORDER BY canonical_updated_at DESC, updated_at DESC, media_key ASC LIMIT ? OFFSET ?"
    : "SELECT * FROM personal_ratings ORDER BY canonical_updated_at DESC, updated_at DESC, media_key ASC";
  return (safeLimit > 0 ? db.prepare(sql).all(safeLimit, safeOffset) : db.prepare(sql).all());
}

export function getCanonicalPersonalRating(mediaKey) {
  return db.prepare("SELECT * FROM personal_ratings WHERE media_key = ?").get(String(mediaKey || "")) || null;
}

export function findCanonicalPersonalRating(media = {}) {
  const aliases = personalRatingMediaAliases(media);
  if (aliases.length) {
    const placeholders = aliases.map(() => "?").join(",");
    const exact = db.prepare(`
      SELECT *
      FROM personal_ratings
      WHERE media_key IN (${placeholders})
      ORDER BY canonical_updated_at DESC, updated_at DESC, media_key ASC
      LIMIT 1
    `).get(...aliases);
    if (exact) return exact;
  }
  const type = String(media.media_type || media.mediaType || media.type || "").toLowerCase();
  const showTitle = String(media.show_title || media.showTitle || "").trim();
  if (type === "episode" && showTitle && media.season != null && media.episode != null) {
    const wanted = showTitleKey(showTitle);
    if (!wanted) return null;
    const candidates = db.prepare(`
      SELECT *
      FROM personal_ratings
      WHERE media_type = 'episode'
        AND season = ?
        AND episode = ?
      ORDER BY canonical_updated_at DESC, updated_at DESC, media_key ASC
    `).all(Number(media.season), Number(media.episode));
    return candidates.find((row) => showTitleKey(row.show_title) === wanted) || null;
  }
  return null;
}

export function upsertCanonicalPersonalRating(media = {}, rating, { origin = "manual", timestamp = Date.now() } = {}) {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("Rating must be a whole number from 1 to 10");
  const stored = ratingMediaForStorage(media);
  const safeOrigin = ["manual", "import", "reconcile"].includes(origin) ? origin : "manual";
  const existing = getCanonicalPersonalRating(stored.media_key);
  db.prepare(`
    INSERT INTO personal_ratings
      (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date,
       show_title, season, episode, episode_tmdb_id, episode_tvdb_id, episode_imdb_id, rating,
       origin, canonical_updated_at, created_at, updated_at)
    VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date,
       @show_title, @season, @episode, @episode_tmdb_id, @episode_tvdb_id, @episode_imdb_id, @rating,
       @origin, @canonical_updated_at, @created_at, @updated_at)
    ON CONFLICT(media_key) DO UPDATE SET
      media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
      tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
      overview=excluded.overview, release_date=excluded.release_date, show_title=excluded.show_title,
      season=excluded.season, episode=excluded.episode, episode_tmdb_id=excluded.episode_tmdb_id,
      episode_tvdb_id=excluded.episode_tvdb_id, episode_imdb_id=excluded.episode_imdb_id,
      rating=excluded.rating, origin=excluded.origin,
      canonical_updated_at=excluded.canonical_updated_at, updated_at=excluded.updated_at
  `).run({
    ...stored,
    rating: value,
    origin: safeOrigin,
    canonical_updated_at: Number(timestamp) || Date.now(),
    created_at: existing?.created_at || Number(timestamp) || Date.now(),
    updated_at: Number(timestamp) || Date.now(),
  });
  return getCanonicalPersonalRating(stored.media_key);
}

export function deleteCanonicalPersonalRating(media = {}, { timestamp = Date.now() } = {}) {
  const existing = findCanonicalPersonalRating(media);
  if (!existing) return null;
  db.prepare("DELETE FROM personal_ratings WHERE media_key = ?").run(existing.media_key);
  return existing;
}

export function listRatingSourceRows(provider, { generation = null } = {}) {
  const source = providerOrThrow(provider);
  if (generation == null) {
    return db.prepare("SELECT * FROM personal_rating_sources WHERE provider = ? ORDER BY media_key ASC").all(source).map(mapSourceRow);
  }
  return db.prepare("SELECT * FROM personal_rating_sources WHERE provider = ? AND last_snapshot_generation = ? ORDER BY media_key ASC").all(source, Number(generation)).map(mapSourceRow);
}

export function getRatingSourceRow(provider, mediaKey) {
  return mapSourceRow(db.prepare("SELECT * FROM personal_rating_sources WHERE provider = ? AND media_key = ?").get(providerOrThrow(provider), String(mediaKey || "")));
}

export function upsertRatingSourceObservation({
  provider,
  media,
  providerItemId = null,
  providerIds = {},
  remoteRating = null,
  remoteState = "unknown",
  remoteRatedAt = null,
  generation = null,
  lastSeenAt = Date.now(),
  lastInboundAt = null,
  syncStatus = "synced",
  lastError = null,
} = {}) {
  const source = providerOrThrow(provider);
  const normalizedState = ["rated", "unrated", "unknown"].includes(remoteState) ? remoteState : "unknown";
  const value = remoteRating == null ? null : Number(remoteRating);
  if (value != null && (!Number.isInteger(value) || value < 1 || value > 10)) throw new Error("Remote rating must be a whole number from 1 to 10");
  if (!SOURCE_STATUSES.includes(syncStatus)) syncStatus = "unknown";
  const stored = ratingMediaForStorage(media);
  const existing = getRatingSourceRow(source, stored.media_key);
  db.prepare(`
    INSERT INTO personal_rating_sources
      (provider, media_key, media_json, provider_item_id, provider_ids_json, remote_rating, remote_state,
       remote_rated_at, last_seen_at, last_snapshot_generation, last_complete_snapshot_at,
       last_inbound_at, last_outbound_rating, last_outbound_state, last_outbound_intent_id,
       last_outbound_at, sync_status, last_error)
    VALUES (@provider, @media_key, @media_json, @provider_item_id, @provider_ids_json, @remote_rating, @remote_state,
       @remote_rated_at, @last_seen_at, @last_snapshot_generation, @last_complete_snapshot_at,
       @last_inbound_at, @last_outbound_rating, @last_outbound_state, @last_outbound_intent_id,
       @last_outbound_at, @sync_status, @last_error)
    ON CONFLICT(provider, media_key) DO UPDATE SET
      media_json=excluded.media_json, provider_item_id=COALESCE(excluded.provider_item_id, personal_rating_sources.provider_item_id),
      provider_ids_json=excluded.provider_ids_json, remote_rating=excluded.remote_rating,
      remote_state=excluded.remote_state, remote_rated_at=excluded.remote_rated_at,
      last_seen_at=excluded.last_seen_at, last_snapshot_generation=COALESCE(excluded.last_snapshot_generation, personal_rating_sources.last_snapshot_generation),
      last_complete_snapshot_at=COALESCE(excluded.last_complete_snapshot_at, personal_rating_sources.last_complete_snapshot_at),
      last_inbound_at=COALESCE(excluded.last_inbound_at, personal_rating_sources.last_inbound_at),
      sync_status=excluded.sync_status, last_error=excluded.last_error
  `).run({
    provider: source,
    media_key: stored.media_key,
    media_json: toJson(stored),
    provider_item_id: providerItemId == null ? null : String(providerItemId),
    provider_ids_json: toJson(providerIds || {}),
    remote_rating: value,
    remote_state: normalizedState,
    remote_rated_at: remoteRatedAt == null ? null : Number(remoteRatedAt),
    last_seen_at: Number(lastSeenAt) || Date.now(),
    last_snapshot_generation: generation == null ? existing?.last_snapshot_generation ?? null : Number(generation),
    last_complete_snapshot_at: existing?.last_complete_snapshot_at ?? null,
    last_inbound_at: lastInboundAt == null ? existing?.last_inbound_at ?? null : Number(lastInboundAt),
    last_outbound_rating: existing?.last_outbound_rating ?? null,
    last_outbound_state: existing?.last_outbound_state ?? null,
    last_outbound_intent_id: existing?.last_outbound_intent_id ?? null,
    last_outbound_at: existing?.last_outbound_at ?? null,
    sync_status: syncStatus,
    last_error: cleanError(lastError),
  });
  return getRatingSourceRow(source, stored.media_key);
}

export function ensureRatingSourceRow(provider, media, { now = Date.now() } = {}) {
  const target = providerOrThrow(provider);
  const stored = ratingMediaForStorage(media);
  const existing = getRatingSourceRow(target, stored.media_key);
  if (existing) return existing;
  return upsertRatingSourceObservation({
    provider: target,
    media: stored,
    providerIds: media?.provider_item_ids || {},
    remoteState: "unknown",
    syncStatus: "pending",
    lastSeenAt: now,
  });
}

export function markRatingSourceSnapshotComplete(provider, generation, completedAt = Date.now()) {
  const source = providerOrThrow(provider);
  return db.prepare(`
    UPDATE personal_rating_sources
    SET last_complete_snapshot_at = ?, sync_status = CASE WHEN sync_status = 'unknown' THEN 'synced' ELSE sync_status END
    WHERE provider = ? AND last_snapshot_generation = ?
  `).run(Number(completedAt) || Date.now(), source, Number(generation)).changes;
}

export function updateRatingSourceSyncStatus(provider, mediaKey, status, error = null) {
  const source = providerOrThrow(provider);
  const safeStatus = SOURCE_STATUSES.includes(status) ? status : "failed";
  return db.prepare(`
    UPDATE personal_rating_sources SET sync_status = ?, last_error = ? WHERE provider = ? AND media_key = ?
  `).run(safeStatus, cleanError(error), source, String(mediaKey || "")).changes;
}

export function markRatingSourceOutbound({ provider, mediaKey, desiredState, desiredRating = null, intentId, timestamp = Date.now() } = {}) {
  const source = providerOrThrow(provider);
  const state = ratingStateOrThrow(desiredState);
  return db.prepare(`
    UPDATE personal_rating_sources
    SET last_outbound_rating = ?, last_outbound_state = ?, last_outbound_intent_id = ?,
        last_outbound_at = ?, sync_status = 'synced', last_error = NULL
    WHERE provider = ? AND media_key = ?
  `).run(
    state === "rated" ? Number(desiredRating) : null,
    state,
    String(intentId || ""),
    Number(timestamp) || Date.now(),
    source,
    String(mediaKey || ""),
  ).changes;
}

export function updateRatingSourceOutboundFromQueue({ provider, mediaKey, media, ...options } = {}) {
  const target = providerOrThrow(provider);
  ensureRatingSourceRow(target, media, options);
  return markRatingSourceOutbound({ provider: target, mediaKey, ...options });
}

export function enqueuePersonalRatingMutation({
  provider,
  media,
  desiredState,
  desiredRating = null,
  source = "manual",
  canonicalVersion = 0,
  intentId = crypto.randomUUID(),
  timestamp = Date.now(),
} = {}) {
  const target = providerOrThrow(provider);
  const state = ratingStateOrThrow(desiredState);
  const safeSource = ["manual", "import", "reconcile", "push"].includes(source) ? source : "manual";
  const rating = desiredRating == null ? null : Number(desiredRating);
  if (state === "rated" && (!Number.isInteger(rating) || rating < 1 || rating > 10)) throw new Error("A rated queue item needs a whole number from 1 to 10");
  const stored = ratingMediaForStorage(media);
  const now = Number(timestamp) || Date.now();
  db.prepare(`
    INSERT INTO personal_rating_sync_queue
      (provider, media_key, media_json, desired_state, desired_rating, source, intent_id,
       canonical_version, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
       last_error, created_at, updated_at, succeeded_at)
    VALUES (@provider, @media_key, @media_json, @desired_state, @desired_rating, @source, @intent_id,
       @canonical_version, 'pending', 0, @next_attempt_at, NULL, NULL, NULL, @created_at, @updated_at, NULL)
    ON CONFLICT(provider, media_key) DO UPDATE SET
      media_json=excluded.media_json, desired_state=excluded.desired_state, desired_rating=excluded.desired_rating,
      source=excluded.source, intent_id=excluded.intent_id, canonical_version=excluded.canonical_version,
      status='pending', attempt_count=0, next_attempt_at=excluded.next_attempt_at,
      lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=excluded.updated_at, succeeded_at=NULL
  `).run({
    provider: target,
    media_key: stored.media_key,
    media_json: toJson(stored),
    desired_state: state,
    desired_rating: state === "rated" ? rating : null,
    source: safeSource,
    intent_id: String(intentId),
    canonical_version: Number(canonicalVersion) || 0,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  });
  return mapQueueRow(db.prepare("SELECT * FROM personal_rating_sync_queue WHERE provider = ? AND media_key = ?").get(target, stored.media_key));
}

export function claimPersonalRatingQueue({ provider = "", limit = 20, owner = crypto.randomUUID(), now = Date.now(), leaseMs = 120_000 } = {}) {
  const target = provider ? providerOrThrow(provider) : "";
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
  const current = Number(now) || Date.now();
  const rows = transaction(() => {
    const candidates = db.prepare(`
      SELECT *
      FROM personal_rating_sync_queue
      WHERE ${target ? "provider = @provider AND " : ""}
        ((status IN ('pending', 'failed') AND next_attempt_at <= @now)
          OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now))
      ORDER BY updated_at ASC, provider ASC, media_key ASC
      LIMIT @limit
    `).all({ provider: target, now: current, limit: safeLimit });
    const claimed = [];
    const update = db.prepare(`
      UPDATE personal_rating_sync_queue
      SET status='processing', attempt_count=attempt_count+1, lease_owner=?, lease_expires_at=?, updated_at=?
      WHERE provider=? AND media_key=? AND intent_id=?
    `);
    for (const row of candidates) {
      const result = update.run(String(owner), current + Math.max(10_000, Number(leaseMs) || 120_000), current, row.provider, row.media_key, row.intent_id);
      if (result.changes) claimed.push(mapQueueRow({ ...row, status: "processing", attempt_count: Number(row.attempt_count || 0) + 1, lease_owner: String(owner), lease_expires_at: current + Math.max(10_000, Number(leaseMs) || 120_000) }));
    }
    return claimed;
  });
  return { owner: String(owner), rows };
}

export function acknowledgePersonalRatingQueue({ provider, mediaKey, media = null, intentId, desiredState, desiredRating = null, timestamp = Date.now() } = {}) {
  const target = providerOrThrow(provider);
  const state = ratingStateOrThrow(desiredState);
  const result = transaction(() => {
    const updated = db.prepare(`
      UPDATE personal_rating_sync_queue
      SET status='succeeded', lease_owner=NULL, lease_expires_at=NULL, last_error=NULL,
          updated_at=?, succeeded_at=?
      WHERE provider=? AND media_key=? AND intent_id=? AND status='processing'
    `).run(Number(timestamp) || Date.now(), Number(timestamp) || Date.now(), target, String(mediaKey || ""), String(intentId || ""));
    if (!updated.changes) return false;
    if (media) ensureRatingSourceRow(target, media, { now: timestamp });
    markRatingSourceOutbound({ provider: target, mediaKey, desiredState: state, desiredRating, intentId, timestamp });
    return true;
  });
  return result;
}

export function failPersonalRatingQueue({ provider, mediaKey, intentId, status = "failed", error = "", nextAttemptAt = Date.now() + 60_000, timestamp = Date.now() } = {}) {
  const target = providerOrThrow(provider);
  const safeStatus = QUEUE_STATUSES.includes(status) && status !== "processing" && status !== "pending" ? status : "failed";
  const result = transaction(() => {
    const updated = db.prepare(`
      UPDATE personal_rating_sync_queue
      SET status=?, lease_owner=NULL, lease_expires_at=NULL, last_error=?, next_attempt_at=?, updated_at=?
      WHERE provider=? AND media_key=? AND intent_id=? AND status='processing'
    `).run(safeStatus, cleanError(error), Number(nextAttemptAt) || Date.now() + 60_000, Number(timestamp) || Date.now(), target, String(mediaKey || ""), String(intentId || ""));
    if (updated.changes) updateRatingSourceSyncStatus(target, mediaKey, safeStatus === "failed" ? "failed" : safeStatus, error);
    return updated.changes > 0;
  });
  return result;
}

// A local intent that has not yet been confirmed on this provider. Plex, Emby,
// and Jellyfin expose no rating-modified time, so an undelivered local edit is
// the only evidence that Plembfin's value is newer than what the provider holds.
const OUTSTANDING_QUEUE_STATUSES = ["pending", "processing", "failed", "reauth_required"];

export function getOutstandingPersonalRatingIntent(provider, mediaKeys = []) {
  const target = providerOrThrow(provider);
  const keys = [...new Set((Array.isArray(mediaKeys) ? mediaKeys : [mediaKeys]).map((key) => String(key || "")).filter(Boolean))];
  if (!keys.length) return null;
  const row = db.prepare(`
    SELECT * FROM personal_rating_sync_queue
    WHERE provider = ? AND media_key IN (${keys.map(() => "?").join(",")})
      AND status IN (${OUTSTANDING_QUEUE_STATUSES.map(() => "?").join(",")})
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(target, ...keys, ...OUTSTANDING_QUEUE_STATUSES);
  return row ? mapQueueRow(row) : null;
}

// Drops an undelivered local intent for one provider once a newer value from
// that same provider has become canonical, so the stale local value is not
// written back over it. In-flight (processing) rows are left to finish.
export function supersedePersonalRatingIntent(provider, mediaKeys = []) {
  const target = providerOrThrow(provider);
  const keys = [...new Set((Array.isArray(mediaKeys) ? mediaKeys : [mediaKeys]).map((key) => String(key || "")).filter(Boolean))];
  if (!keys.length) return 0;
  return db.prepare(`
    DELETE FROM personal_rating_sync_queue
    WHERE provider = ? AND media_key IN (${keys.map(() => "?").join(",")})
      AND status IN ('pending', 'failed', 'reauth_required')
  `).run(target, ...keys).changes;
}

export function retryPersonalRatingQueue({ provider = "", mediaKey = "", now = Date.now() } = {}) {
  const target = provider ? providerOrThrow(provider) : "";
  const clauses = ["status IN ('not_found','reauth_required','failed')"];
  const params = { now: Number(now) || Date.now() };
  if (target) { clauses.push("provider = @provider"); params.provider = target; }
  if (mediaKey) { clauses.push("media_key = @mediaKey"); params.mediaKey = String(mediaKey); }
  return db.prepare(`
    UPDATE personal_rating_sync_queue
    SET status='pending', next_attempt_at=@now, last_error=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=@now
    WHERE ${clauses.join(" AND ")}
  `).run(params).changes;
}

export function listPersonalRatingQueue({ provider = "", statuses = QUEUE_STATUSES, limit = 100 } = {}) {
  const target = provider ? providerOrThrow(provider) : "";
  const allowed = statuses.filter((value) => QUEUE_STATUSES.includes(value));
  if (!allowed.length) return [];
  const placeholders = allowed.map(() => "?").join(",");
  const params = target ? [target, ...allowed, Math.max(1, Math.min(500, Number(limit) || 100))] : [...allowed, Math.max(1, Math.min(500, Number(limit) || 100))];
  const providerClause = target ? "provider = ? AND " : "";
  return db.prepare(`SELECT * FROM personal_rating_sync_queue WHERE ${providerClause} status IN (${placeholders}) ORDER BY updated_at ASC LIMIT ?`).all(...params).map(mapQueueRow);
}

export function ratingQueueCounts(provider = "") {
  const target = provider ? providerOrThrow(provider) : "";
  const rows = target
    ? db.prepare("SELECT status, COUNT(*) AS count FROM personal_rating_sync_queue WHERE provider = ? GROUP BY status").all(target)
    : db.prepare("SELECT status, COUNT(*) AS count FROM personal_rating_sync_queue GROUP BY status").all();
  return Object.fromEntries(QUEUE_STATUSES.map((status) => [status, Number(rows.find((row) => row.status === status)?.count || 0)]));
}

export function getPersonalRatingSyncRun(provider) {
  return mapRunRow(db.prepare("SELECT * FROM personal_rating_sync_runs WHERE provider = ?").get(providerOrThrow(provider)));
}

export function listPersonalRatingSyncRuns() {
  return db.prepare("SELECT * FROM personal_rating_sync_runs ORDER BY provider ASC").all().map(mapRunRow);
}

export function startPersonalRatingSyncRun(provider, mode = "baseline", timestamp = Date.now()) {
  const target = providerOrThrow(provider);
  const safeMode = mode === "import" ? "import" : "baseline";
  const now = Number(timestamp) || Date.now();
  const existing = getPersonalRatingSyncRun(target);
  const generation = Number(existing?.generation || 0) + 1;
  const runId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO personal_rating_sync_runs
      (provider, run_id, generation, mode, status, baseline_complete, started_at, completed_at,
       scanned_count, changed_count, imported_count, cleared_count, queued_count, cursor_json, last_error, updated_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, 0, 0, 0, 0, 0, NULL, NULL, ?)
    ON CONFLICT(provider) DO UPDATE SET
      run_id=excluded.run_id, generation=excluded.generation, mode=excluded.mode, status='running',
      started_at=excluded.started_at, completed_at=NULL, scanned_count=0, changed_count=0,
      imported_count=0, cleared_count=0, queued_count=0, cursor_json=NULL, last_error=NULL, updated_at=excluded.updated_at
  `).run(target, runId, generation, safeMode, existing?.baseline_complete ? 1 : 0, now, now);
  return getPersonalRatingSyncRun(target);
}

export function updatePersonalRatingSyncRun(provider, fields = {}) {
  const target = providerOrThrow(provider);
  const allowed = ["scanned_count", "changed_count", "imported_count", "cleared_count", "queued_count", "cursor_json", "last_error", "status", "baseline_complete"];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return getPersonalRatingSyncRun(target);
  const values = { provider: target, updated_at: Date.now() };
  const setters = entries.map(([key, value]) => {
    values[key] = key === "cursor_json" ? (value == null ? null : toJson(value)) : key === "last_error" ? cleanError(value) : value;
    return `${key} = @${key}`;
  });
  setters.push("updated_at = @updated_at");
  db.prepare(`UPDATE personal_rating_sync_runs SET ${setters.join(", ")} WHERE provider = @provider`).run(values);
  return getPersonalRatingSyncRun(target);
}

export function finishPersonalRatingSyncRun(provider, { status = "succeeded", completedAt = Date.now(), ...fields } = {}) {
  const target = providerOrThrow(provider);
  const safeStatus = ["succeeded", "partial", "failed"].includes(status) ? status : "failed";
  const values = { provider: target, status: safeStatus, completed_at: Number(completedAt) || Date.now(), updated_at: Number(completedAt) || Date.now() };
  const setters = ["status=@status", "completed_at=@completed_at", "updated_at=@updated_at"];
  for (const key of ["scanned_count", "changed_count", "imported_count", "cleared_count", "queued_count", "baseline_complete", "last_error"]) {
    if (!(key in fields)) continue;
    values[key] = key === "last_error" ? cleanError(fields[key]) : fields[key];
    setters.push(`${key}=@${key}`);
  }
  db.prepare(`UPDATE personal_rating_sync_runs SET ${setters.join(", ")} WHERE provider=@provider`).run(values);
  return getPersonalRatingSyncRun(target);
}

export function personalRatingRepositoryStatus() {
  return {
    queue: ratingQueueCounts(),
    runs: listPersonalRatingSyncRuns(),
    canonicalCount: Number(db.prepare("SELECT COUNT(*) AS count FROM personal_ratings").get()?.count || 0),
  };
}
