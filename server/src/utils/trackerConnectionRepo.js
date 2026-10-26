import crypto from "node:crypto";
import { db } from "../db.js";
import { decryptCredential, encryptCredential } from "./credentialVault.js";
import { trackerMediaIdentityKeys, trackerMediaMatches } from "./traktClient.js";

import { assertTrackerEnabled, isTrackerProvider, trackerProviderIds } from "./trackers/registry.js";
import { assertTrackerAuthProvider, isTrackerAuthProvider } from "./trackers/authProviders.js";
import { assertTrackerGeneration, currentTrackerGeneration, StaleTrackerConnectionError, trackerGenerationFence } from "./trackers/generation.js";
const SERVER_CREDENTIAL_SENTINEL = "plembfin:server-configured";
const providerName = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  assertTrackerAuthProvider(provider);
  return provider;
};

const encrypted = (value) => encryptCredential(String(value || ""));
const decrypted = (row, prefix) => decryptCredential({
  ciphertext: row[`${prefix}_ciphertext`], iv: row[`${prefix}_iv`], tag: row[`${prefix}_tag`], version: row.token_version || row.key_version,
});

function publicConnection(row) {
  if (!row) return null;
  return {
    id: row.id, provider: row.provider, status: row.status,
    remoteUserId: row.remote_user_id || "", remoteUsername: row.remote_username || "",
    accessTokenExpiresAt: row.access_token_expires_at,
    initialSyncMode: row.initial_sync_mode, baselineComplete: Boolean(row.baseline_complete),
    preferEarlierWatchedDate: row.prefer_earlier_watched_date == null ? true : Boolean(row.prefer_earlier_watched_date),
    lastPolledAt: row.last_polled_at, lastValidatedAt: row.last_validated_at,
    lastError: row.last_error || "", historySyncedAt: row.history_synced_at || 0,
    connectedAt: row.connected_at || row.created_at,
    initialSync: parseProgress(row.initial_sync_json), fullSync: parseProgress(row.full_sync_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function parseProgress(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

export function getTrackerConnection(provider, { includeCredentials = false } = {}) {
  const row = db.prepare("SELECT * FROM tracker_connections WHERE provider=? LIMIT 1").get(providerName(provider));
  const result = publicConnection(row);
  if (result && includeCredentials) {
    result.clientId = row.client_id;
    const clientSecret = decrypted(row, "client_secret");
    result.clientSecret = clientSecret === SERVER_CREDENTIAL_SENTINEL ? "" : clientSecret;
    result.accessToken = decrypted(row, "access_token");
    result.refreshToken = decrypted(row, "refresh_token");
  }
  return result;
}

// A restore or downgrade can bring rows for a tracker this version does not
// know. They are kept untouched and never read as connections.
export function listTrackerConnections() {
  return db.prepare("SELECT * FROM tracker_connections ORDER BY provider").all().filter((row) => isTrackerProvider(row.provider)).map(publicConnection);
}

const TRACKER_TABLES = ["tracker_connections", "tracker_item_state", "tracker_play_history", "tracker_write_intents"];
export function unknownTrackerProviderData() {
  const known = JSON.stringify(trackerProviderIds());
  const found = new Map();
  for (const table of TRACKER_TABLES) {
    for (const { provider, count } of db.prepare(`SELECT provider, COUNT(*) AS count FROM ${table} WHERE provider NOT IN (SELECT value FROM json_each(?)) GROUP BY provider`).all(known)) {
      // A supported auth-only connection is intentionally waiting for its sync
      // adapter. Restored snapshot/play/write data must still remain quarantined.
      if (table === "tracker_connections" && isTrackerAuthProvider(provider)) continue;
      found.set(provider, { ...found.get(provider), [table]: count });
    }
  }
  return [...found].map(([provider, tables]) => ({ provider, tables }));
}

export function saveTrackerConnection(input) {
  const provider = providerName(input.provider);
  assertTrackerAuthProvider(provider);
  const clientSecret = encrypted(input.clientSecret || SERVER_CREDENTIAL_SENTINEL);
  const accessToken = encrypted(input.accessToken);
  const refreshToken = encrypted(input.refreshToken);
  const timestamp = Date.now();
  const existing = db.prepare("SELECT id, created_at, remote_user_id FROM tracker_connections WHERE provider=?").get(provider);
  const accountChanged = existing && existing.remote_user_id !== String(input.remoteUserId || "");
  const row = {
    id: !accountChanged && existing?.id || crypto.randomUUID(), provider, status: input.status || "connected",
    remote_user_id: String(input.remoteUserId || ""), remote_username: String(input.remoteUsername || ""), client_id: String(input.clientId || ""),
    client_secret_ciphertext: clientSecret.ciphertext, client_secret_iv: clientSecret.iv, client_secret_tag: clientSecret.tag,
    access_token_ciphertext: accessToken.ciphertext, access_token_iv: accessToken.iv, access_token_tag: accessToken.tag,
    refresh_token_ciphertext: refreshToken.ciphertext, refresh_token_iv: refreshToken.iv, refresh_token_tag: refreshToken.tag,
    token_version: accessToken.version, access_token_expires_at: Number(input.accessTokenExpiresAt || 0) || null,
    initial_sync_mode: input.initialSyncMode === "import" ? "import" : "baseline", baseline_complete: input.baselineComplete ? 1 : 0,
    prefer_earlier_watched_date: input.preferEarlierWatchedDate === false ? 0 : 1,
    last_polled_at: input.lastPolledAt || null, last_validated_at: input.lastValidatedAt || timestamp,
    last_error: input.lastError || null, created_at: existing?.created_at || timestamp, updated_at: timestamp,
    connected_at: timestamp,
  };
  db.transaction(() => {
  // An auth flow is bound to the generation it started against ("" when no
  // connection existed); a late completion cannot overwrite a newer one.
  if (input.expectedConnectionId !== undefined && currentTrackerGeneration(provider) !== String(input.expectedConnectionId ?? "")) {
    throw new StaleTrackerConnectionError(provider);
  }
  if (accountChanged) {
    clearTrackerAccountState(provider);
    row.baseline_complete = 0;
  }
  db.prepare(`INSERT INTO tracker_connections (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})
    ON CONFLICT(provider) DO UPDATE SET id=excluded.id,status=excluded.status,remote_user_id=excluded.remote_user_id,remote_username=excluded.remote_username,
    client_id=excluded.client_id,client_secret_ciphertext=excluded.client_secret_ciphertext,client_secret_iv=excluded.client_secret_iv,client_secret_tag=excluded.client_secret_tag,
    access_token_ciphertext=excluded.access_token_ciphertext,access_token_iv=excluded.access_token_iv,access_token_tag=excluded.access_token_tag,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_iv=excluded.refresh_token_iv,refresh_token_tag=excluded.refresh_token_tag,
    token_version=excluded.token_version,access_token_expires_at=excluded.access_token_expires_at,initial_sync_mode=excluded.initial_sync_mode,
    prefer_earlier_watched_date=excluded.prefer_earlier_watched_date,
    baseline_complete=excluded.baseline_complete,last_validated_at=excluded.last_validated_at,last_error=excluded.last_error,updated_at=excluded.updated_at,
    connected_at=CASE WHEN tracker_connections.id=excluded.id THEN COALESCE(tracker_connections.connected_at,tracker_connections.created_at) ELSE excluded.connected_at END,
    initial_sync_json=CASE WHEN tracker_connections.id=excluded.id THEN tracker_connections.initial_sync_json END,
    full_sync_json=CASE WHEN tracker_connections.id=excluded.id THEN tracker_connections.full_sync_json END`).run(row);
  }).immediate();
  return getTrackerConnection(provider);
}

// Everything observed from, or destined for, one remote account. Account
// replacement and disconnect both clear it so a new account re-baselines
// instead of inheriting the old account's snapshot, plays, writes or ratings
// (a stale rating baseline would read the old account's ratings as clears).
const ACCOUNT_SCOPED_TABLES = ["tracker_item_state", "tracker_play_history", "tracker_write_intents", "tracker_observation_cursors", "tracker_observations", "personal_rating_sources", "personal_rating_sync_queue", "personal_rating_sync_runs"];
function clearTrackerAccountState(name) {
  for (const table of ACCOUNT_SCOPED_TABLES) db.prepare(`DELETE FROM ${table} WHERE provider=?`).run(name);
  // Local canonical actions remain useful conflict evidence after an account
  // replacement, but their old outbox work must never reach the new account.
  db.prepare(`UPDATE dropped_title_tracker_state SET connection_id='',account_id='',write_status='unbound',last_error=NULL,updated_at=?
    WHERE provider=? AND source='local'`).run(Date.now(), name);
  db.prepare("DELETE FROM dropped_title_tracker_state WHERE provider=? AND source<>'local'").run(name);
  db.prepare("DELETE FROM dropped_title_tracker_cursors WHERE provider=?").run(name);
}

// Status and token writes from fenced work (or naming an explicit connection)
// only land on that same generation; a stale result is silently discarded.
function generationClause(name, connectionId) {
  const expected = connectionId ?? trackerGenerationFence(name);
  return expected === undefined ? { sql: "", args: [] } : { sql: " AND id=?", args: [String(expected)] };
}

export function updateTrackerTokens(provider, tokens) {
  const name = providerName(provider);
  assertTrackerAuthProvider(name);
  const access = encrypted(tokens.accessToken);
  const refresh = encrypted(tokens.refreshToken);
  const fence = generationClause(name, tokens.connectionId);
  return db.prepare(`UPDATE tracker_connections SET access_token_ciphertext=?,access_token_iv=?,access_token_tag=?,refresh_token_ciphertext=?,refresh_token_iv=?,refresh_token_tag=?,token_version=?,access_token_expires_at=?,status='connected',last_error=NULL,updated_at=? WHERE provider=?${fence.sql}`)
    .run(access.ciphertext, access.iv, access.tag, refresh.ciphertext, refresh.iv, refresh.tag, access.version, tokens.accessTokenExpiresAt || null, Date.now(), name, ...fence.args).changes > 0;
}

export function updateTrackerConnectionStatus(provider, patch = {}) {
  const name = providerName(provider);
  if (patch.status === "connected") assertTrackerEnabled(name);
  const allowed = { status: "status", baselineComplete: "baseline_complete", lastPolledAt: "last_polled_at", lastValidatedAt: "last_validated_at", lastError: "last_error", historySyncedAt: "history_synced_at",
    preferEarlierWatchedDate: "prefer_earlier_watched_date", initialSync: "initial_sync_json", fullSync: "full_sync_json" };
  const entries = Object.entries(patch).filter(([key]) => allowed[key]);
  if (!entries.length) return false;
  const values = entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value);
  const fence = generationClause(name, patch.connectionId);
  return db.prepare(`UPDATE tracker_connections SET ${entries.map(([key]) => `${allowed[key]}=?`).join(",")},updated_at=? WHERE provider=?${fence.sql}`)
    .run(...values.map((value) => typeof value === "boolean" ? Number(value) : value), Date.now(), name, ...fence.args).changes > 0;
}

export function deleteTrackerConnection(provider) {
  const name = providerName(provider);
  return db.transaction(() => {
    clearTrackerAccountState(name);
    return db.prepare("DELETE FROM tracker_connections WHERE provider=?").run(name).changes > 0;
  })();
}

export function createTrackerAuthFlow(input) {
  const provider = providerName(input.provider);
  assertTrackerAuthProvider(provider);
  const secret = encrypted(input.clientSecret || SERVER_CREDENTIAL_SENTINEL);
  const device = encrypted(input.deviceCode);
  const timestamp = Date.now();
  const row = {
    id: crypto.randomUUID(), provider, client_id: String(input.clientId),
    client_secret_ciphertext: secret.ciphertext, client_secret_iv: secret.iv, client_secret_tag: secret.tag,
    device_code_ciphertext: device.ciphertext, device_code_iv: device.iv, device_code_tag: device.tag,
    key_version: secret.version, user_code: String(input.userCode), verification_url: String(input.verificationUrl),
    interval_seconds: Math.max(1, Number(input.intervalSeconds || 5)), initial_sync_mode: input.initialSyncMode === "import" ? "import" : "baseline",
    prefer_earlier_watched_date: input.preferEarlierWatchedDate === false ? 0 : 1,
    status: "pending", expires_at: Number(input.expiresAt), last_polled_at: null, created_at: timestamp, updated_at: timestamp,
    expected_connection_id: input.expectedConnectionId ?? currentTrackerGeneration(provider),
  };
  db.prepare(`INSERT INTO tracker_auth_flows (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})`).run(row);
  return { id: row.id, provider, userCode: row.user_code, verificationUrl: row.verification_url, intervalSeconds: row.interval_seconds, expiresAt: row.expires_at, status: row.status };
}

export function getTrackerAuthFlow(id, { includeCredentials = false } = {}) {
  const row = db.prepare("SELECT * FROM tracker_auth_flows WHERE id=?").get(String(id || ""));
  if (!row) return null;
  const result = { id: row.id, provider: row.provider, clientId: row.client_id, userCode: row.user_code, verificationUrl: row.verification_url, intervalSeconds: row.interval_seconds, initialSyncMode: row.initial_sync_mode, preferEarlierWatchedDate: Boolean(row.prefer_earlier_watched_date), status: row.status, expiresAt: row.expires_at, lastPolledAt: row.last_polled_at, expectedConnectionId: row.expected_connection_id ?? null };
  if (includeCredentials) {
    const clientSecret = decrypted(row, "client_secret");
    result.clientSecret = clientSecret === SERVER_CREDENTIAL_SENTINEL ? "" : clientSecret;
    result.deviceCode = decrypted(row, "device_code");
  }
  return result;
}

export function markTrackerAuthFlow(id, status, intervalSeconds = null) {
  db.prepare("UPDATE tracker_auth_flows SET status=?,last_polled_at=?,updated_at=?,interval_seconds=COALESCE(?,interval_seconds) WHERE id=?").run(status, Date.now(), Date.now(), intervalSeconds, id);
}

// Atomic persisted pacing, including across processes and after a restart.
export function claimTrackerAuthFlowPoll(id, now = Date.now()) {
  return db.prepare(`UPDATE tracker_auth_flows SET last_polled_at=?,updated_at=?
    WHERE id=? AND status='pending' AND expires_at>? AND expected_connection_id IS NOT NULL
    AND (last_polled_at IS NULL OR last_polled_at + interval_seconds * 1000 <= ?)`)
    .run(now, now, id, now, now).changes > 0;
}

function trackerItemStateFromRow(row) {
  return row ? {
    provider: row.provider, mediaKey: row.media_key, media: JSON.parse(row.media_json), remoteWatchedAt: row.remote_watched_at,
    lastSeenAt: row.last_seen_at, lastOutboundState: row.last_outbound_state, lastOutboundAt: row.last_outbound_at, lastOutboundIntentId: row.last_outbound_intent_id,
  } : null;
}

const selectTrackerItemStateStmt = db.prepare(
  "SELECT * FROM tracker_item_state WHERE provider=? AND media_key=?",
);
const selectTrackerOutboundExactSinceStmt = db.prepare(`SELECT * FROM tracker_item_state
  WHERE provider=? AND media_key=? AND COALESCE(last_outbound_at,0)>=?`);
const selectTrackerOutboundSinceStmt = db.prepare(`SELECT * FROM tracker_item_state
  WHERE provider=? AND COALESCE(last_outbound_at,0)>=?
  ORDER BY last_outbound_at DESC`);
const selectLatestTrackerOutboundTimestampStmt = db.prepare(
  "SELECT MAX(COALESCE(last_outbound_at,0)) AS timestamp FROM tracker_item_state WHERE provider=?",
);
const upsertTrackerOutboundStmt = db.prepare(`INSERT INTO tracker_item_state
  (provider,media_key,media_json,remote_watched_at,last_seen_at,last_outbound_state,last_outbound_at)
  VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,media_key) DO UPDATE SET
  media_json=excluded.media_json,last_outbound_state=excluded.last_outbound_state,last_outbound_at=excluded.last_outbound_at`);

function nextTrackerOutboundTimestamp(provider) {
  // Date.now() can repeat for consecutive operations. Make intent timestamps
  // monotonic per provider so two cross-ID aliases written in the same
  // millisecond still have a deterministic newest-wins order.
  const latest = Number(selectLatestTrackerOutboundTimestampStmt.get(provider)?.timestamp || 0);
  return Math.max(Date.now(), latest + 1);
}

export function listTrackerItemStates(provider) {
  return db.prepare("SELECT * FROM tracker_item_state WHERE provider=?").all(providerName(provider)).map(trackerItemStateFromRow);
}

// Ground truth for "how many items has this provider's snapshot resolved
// against local state" - an in-memory counter accumulated across a reconcile
// run is lost if the process restarts mid-import (see onboardingImportCoordinator.js),
// so a status report needs a source that survives that.
export function countTrackerItemStates(provider) {
  // Simkl keeps its watched set as observations, not a replaced snapshot.
  if (providerName(provider) === "simkl") {
    return db.prepare(`SELECT COUNT(*) AS count FROM tracker_observations o JOIN tracker_connections c ON c.provider=o.provider AND c.id=o.connection_id
      WHERE o.provider='simkl' AND o.kind='watched' AND o.status IN ('observed','pending','applied')`).get()?.count || 0;
  }
  return db.prepare("SELECT COUNT(*) AS count FROM tracker_item_state WHERE provider=?").get(providerName(provider))?.count || 0;
}

export function getTrackerItemState(provider, mediaKey) {
  const row = selectTrackerItemStateStmt.get(providerName(provider), String(mediaKey || ""));
  return trackerItemStateFromRow(row);
}

// Returns a recent outbound intent/success for the same real media item. An
// exact media_key is preferred, but provider-id richness can change the key's
// preferred prefix (IMDb vs TMDB, for example). Also match episode coordinates
// plus an overlapping provider-specific series id, or the exact normalized show
// title when a Force Sync is carrying a stale provider id. The latter is only
// an outbound-echo guard; it never becomes a remote Trakt identity.
export function findLatestTrackerOutboundSince(provider, item, since = 0) {
  const name = providerName(provider);
  const mediaKey = String(item?.mediaKey || "");
  const normalizedSince = Math.max(0, Number(since) || 0);
  const exact = selectTrackerOutboundExactSinceStmt.get(name, mediaKey, normalizedSince);
  const media = item?.media || {};
  // The indexed exact-key path above is the normal case. Only scan the much
  // smaller window newer than it for a possible alias; without an exact row,
  // scan the full recent window. State is deliberately not filtered here -
  // the newest watched/unwatched intent must win across every alias.
  const aliasSince = exact ? Number(exact.last_outbound_at || 0) + 1 : normalizedSince;
  const rows = selectTrackerOutboundSinceStmt.all(name, aliasSince);
  const newerAlias = rows.find((row) => trackerMediaMatches(JSON.parse(row.media_json), media));
  return trackerItemStateFromRow(newerAlias || exact);
}

export function findTrackerOutboundSince(provider, item, state, since = 0) {
  const latest = findLatestTrackerOutboundSince(provider, item, since);
  return latest?.lastOutboundState === state ? latest : null;
}

export function replaceTrackerSnapshot(provider, items) {
  const name = providerName(provider);
  const timestamp = Date.now();
  db.transaction(() => {
    assertTrackerGeneration(name);
    const previousRows = db.prepare("SELECT * FROM tracker_item_state WHERE provider=?").all(name);
    const previous = new Map(previousRows.map((row) => [row.media_key, row]));
    const previousByIdentity = new Map();
    for (const row of previousRows) {
      const media = JSON.parse(row.media_json);
      for (const identity of trackerMediaIdentityKeys(media)) {
        const current = previousByIdentity.get(identity);
        if (!current || Number(row.last_outbound_at || 0) > Number(current.last_outbound_at || 0)) {
          previousByIdentity.set(identity, row);
        }
      }
    }
    db.prepare("DELETE FROM tracker_item_state WHERE provider=?").run(name);
    const insert = db.prepare("INSERT INTO tracker_item_state (provider,media_key,media_json,remote_watched_at,last_seen_at,last_outbound_state,last_outbound_at,last_outbound_intent_id) VALUES (?,?,?,?,?,?,?,?)");
    for (const item of items) {
      // An exact snapshot row can predate a newer outbound marker stored
      // under an alias key. Choose the newest marker across both instead of
      // letting the marker-less exact row mask it.
      const aliases = [
        previous.get(item.mediaKey),
        ...trackerMediaIdentityKeys(item.media).map((identity) => previousByIdentity.get(identity)),
      ].filter(Boolean).sort((a, b) => Number(b.last_outbound_at || 0) - Number(a.last_outbound_at || 0));
      const old = aliases[0];
      insert.run(name, item.mediaKey, JSON.stringify(item.media), item.watchedAt || null, timestamp, old?.last_outbound_state || null, old?.last_outbound_at || null, old?.last_outbound_intent_id || null);
    }
  })();
}

export function recordTrackerOutboundBatch(provider, entries = []) {
  const name = providerName(provider);
  const rows = entries.filter((entry) => entry?.mediaKey && entry?.media && entry?.state);
  if (!rows.length) return 0;
  // Allocate the sequence and persist the intent under one immediate SQLite
  // write lock. Plembfin supports split web/worker processes; a MAX read and
  // later write in separate transactions lets both processes claim the same
  // timestamp, making cross-ID "newest intent wins" nondeterministic. A Force
  // Sync also publishes a whole title's intents here as one batch, so its
  // separate poller process sees either the state before that authoritative
  // operation or every item it will replay, never a half-primed show.
  db.transaction(() => {
    assertTrackerGeneration(name);
    for (const entry of rows) {
      const timestamp = nextTrackerOutboundTimestamp(name);
      // An outbound write is an intent/acknowledgement, not proof that a later
      // watched-snapshot has observed the item. Keep remote_watched_at null for
      // a brand-new row; an existing observed row retains its value via the
      // ON CONFLICT update, and replaceTrackerSnapshot fills it once Trakt
      // actually reports the item. This prevents a failed new write becoming a
      // synthetic watched baseline that later fans out a false unwatch.
      upsertTrackerOutboundStmt.run(
        name,
        entry.mediaKey,
        JSON.stringify(entry.media),
        null,
        timestamp,
        entry.state,
        timestamp,
      );
    }
  }).immediate();
  return rows.length;
}

export function recordTrackerOutbound(provider, mediaKey, media, state) {
  return recordTrackerOutboundBatch(provider, [{ mediaKey, media, state }]);
}

// Returns the subset of `historyIds` that have not already been imported for
// this provider, so a poll only fetches/inserts plays it hasn't seen before.
export function listUnrecordedTrackerPlayIds(provider, historyIds) {
  const name = providerName(provider);
  const ids = [...new Set((historyIds || []).map((id) => String(id)))];
  if (!ids.length) return new Set();
  const known = new Set();
  const CHUNK_SIZE = 500;
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT history_id FROM tracker_play_history WHERE provider=? AND history_id IN (${placeholders})`).all(name, ...chunk)) {
      known.add(row.history_id);
    }
  }
  return new Set(ids.filter((id) => !known.has(id)));
}

export function recordTrackerPlay(provider, { historyId, mediaKey, watchedAt, watchRecordId }) {
  const name = providerName(provider);
  db.transaction(() => {
    assertTrackerGeneration(name);
    db.prepare(`INSERT OR IGNORE INTO tracker_play_history (provider,history_id,media_key,watched_at,watch_record_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(name, String(historyId), mediaKey, watchedAt, watchRecordId || null, Date.now());
  }).immediate();
}
