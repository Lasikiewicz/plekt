import crypto from "node:crypto";
import { db } from "../../db.js";
import { assertTrackerGeneration, StaleTrackerConnectionError } from "./generation.js";
import { simklMediaKey, simklMediaMatches, simklReviewRequired } from "./simklClient.js";

function assertConnection(connection) {
  assertTrackerGeneration("simkl");
  if (!db.prepare("SELECT 1 FROM tracker_connections WHERE provider='simkl' AND id=? AND remote_user_id=? AND status='connected'")
    .get(connection.id, connection.remoteUserId)) throw new StaleTrackerConnectionError("simkl");
}

export function simklObservationCursor(connection) {
  assertConnection(connection);
  return db.prepare("SELECT cursor FROM tracker_observation_cursors WHERE provider='simkl' AND connection_id=? AND account_id=?")
    .get(connection.id, connection.remoteUserId)?.cursor || null;
}

export function pendingSimklObservations(connection) {
  assertConnection(connection);
  return db.prepare("SELECT * FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND account_id=? AND status='pending' ORDER BY created_at,id")
    .all(connection.id, connection.remoteUserId).map((row) => ({ ...row, observation: JSON.parse(row.observation_json) }));
}

// Commit the complete envelope and cursor together, before applying anything.
// A crash can leave pending inbox rows, never a cursor that has lost its work.
// Readback snapshots must not call this function: they are not inbound activity.
export function persistSimklObservations(connection, snapshot, { expectedCursor = null } = {}) {
  return db.transaction(() => {
    assertConnection(connection);
    if (simklObservationCursor(connection) !== expectedCursor) throw simklReviewRequired("Simkl activity changed during this read; check again");
    const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > 1000;
    if (!snapshot || !validDate(snapshot.cursor) || snapshot.activities?.all !== snapshot.cursor
        || snapshot.absenceReconciliation !== false || snapshot.complete !== !expectedCursor
        || ![snapshot.watched, snapshot.ratings, snapshot.unrated ?? [], snapshot.review].every(Array.isArray)
        || expectedCursor && Date.parse(snapshot.cursor) < Date.parse(expectedCursor)) throw simklReviewRequired("Simkl activity envelope is incomplete or out of order");
    const previous = db.prepare("SELECT * FROM tracker_observations WHERE provider='simkl' AND connection_id=?").all(connection.id);
    const put = (kind, item, key, status, reason = "") => {
      if (!key) throw simklReviewRequired("Simkl observation has no usable identity");
      const observationKey = `${kind}:${key}`;
      const id = crypto.createHash("sha256").update(JSON.stringify([connection.id, observationKey])).digest("hex");
      const now = Date.now();
      // Keep an acknowledgement/dismissal across repeated delta observations.
      db.prepare(`INSERT INTO tracker_observations (id,provider,connection_id,account_id,observation_key,kind,observation_json,status,reason,created_at,updated_at)
        VALUES (?,'simkl',?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,connection_id,observation_key) DO UPDATE SET
        observation_json=excluded.observation_json,updated_at=excluded.updated_at`)
        .run(id, connection.id, connection.remoteUserId, observationKey, kind, JSON.stringify(item), status, reason, now, now);
    };
    for (const item of snapshot.review) {
      const key = simklMediaKey(item.media);
      if (!key) throw simklReviewRequired("Simkl review observation has no usable identity");
      put("review", item, `${key}:${item.reason}:${item.season ?? ""}:${item.episode ?? ""}`, "review", item.reason);
    }
    // One row per rated title holds its latest Simkl rating for rating sync.
    // Neither absence nor a rating-created movie watch is proof of a play.
    // Rows from before rating sync (one per rating value, held) are replaced.
    db.prepare("DELETE FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND kind='rating' AND reason='rating_integration_gated'").run(connection.id);
    const putRating = db.prepare(`INSERT INTO tracker_observations (id,provider,connection_id,account_id,observation_key,kind,observation_json,status,reason,created_at,updated_at)
      VALUES (?,'simkl',?,?,?,'rating',?,'observed','',?,?) ON CONFLICT(provider,connection_id,observation_key) DO UPDATE SET
      observation_json=excluded.observation_json,status='observed',reason='',updated_at=excluded.updated_at`);
    const ratingKey = (item) => `rating:${item.media?.media_type}:${item.providerItemId}`;
    for (const item of snapshot.ratings) {
      if (!item.providerItemId || !Number.isInteger(item.rating) || item.rating < 1 || item.rating > 10) throw simklReviewRequired("Simkl rating observation is invalid");
      const key = ratingKey(item);
      const id = crypto.createHash("sha256").update(JSON.stringify([connection.id, key])).digest("hex");
      putRating.run(id, connection.id, connection.remoteUserId, key, JSON.stringify(item), Date.now(), Date.now());
    }
    // An explicit empty rating clears a title Plekt saw rated; titles never
    // rated here store nothing.
    const clearRating = db.prepare(`UPDATE tracker_observations SET observation_json=?,updated_at=? WHERE provider='simkl' AND connection_id=?
      AND observation_key=? AND kind='rating' AND json_extract(observation_json,'$.rating') IS NOT NULL`);
    for (const item of snapshot.unrated ?? []) {
      if (!item.providerItemId) continue;
      clearRating.run(JSON.stringify({ ...item, rating: null, ratedAt: null }), Date.now(), connection.id, ratingKey(item));
    }
    for (const item of snapshot.watched) {
      const key = simklMediaKey(item.media);
      if (!key) throw simklReviewRequired("Simkl watched observation has no usable identity");
      const known = previous.some((row) => row.kind === "watched" && simklMediaMatches(JSON.parse(row.observation_json).media, item.media));
      const held = snapshot.review.some((entry) => simklMediaMatches(entry.media, item.media));
      const dated = Number.isFinite(item.watchedAt) && item.watchedAt > 1000 && item.timestampProvenance === "observed";
      const canonical = ["tmdb", "tvdb", "imdb"].some((id) => item.media.ids?.[id]);
      const reason = held ? "observation_requires_review" : !canonical ? "identity_mapping_required" : !dated ? "unknown_watch_date" : "";
      // Ordinary state observations are not a repeat-play feed. A new remote
      // date for a known watched item must never manufacture another local play.
      const baselineOnly = !expectedCursor;
      put("watched", item, key, reason ? "review" : known || baselineOnly ? "observed" : "pending", reason);
    }
    db.prepare(`INSERT INTO tracker_observation_cursors (provider,connection_id,account_id,cursor,activities_json,updated_at)
      VALUES ('simkl',?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET connection_id=excluded.connection_id,
      account_id=excluded.account_id,cursor=excluded.cursor,activities_json=excluded.activities_json,updated_at=excluded.updated_at`)
      .run(connection.id, connection.remoteUserId, snapshot.cursor, JSON.stringify(snapshot.activities), Date.now());
    db.prepare("UPDATE tracker_connections SET baseline_complete=1,last_polled_at=?,last_validated_at=?,last_error=NULL WHERE provider='simkl' AND id=?")
      .run(Date.now(), Date.now(), connection.id);
    return pendingSimklObservations(connection);
  }).immediate();
}

// Settled watched observations: the remote watched set this connection has
// seen. Deltas only add to it; a missing item is never proof of an unwatch.
export function settledSimklWatchedObservations(connection) {
  assertConnection(connection);
  return db.prepare("SELECT * FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND account_id=? AND kind='watched' AND status IN ('observed','applied') ORDER BY created_at,id")
    .all(connection.id, connection.remoteUserId).map((row) => ({ ...row, observation: JSON.parse(row.observation_json) }));
}

// Whether this connection has seen Simkl report the item watched. Absence never
// removes an observation, so this is a request-free "already there" check.
export function simklReportedWatched(connection, media) {
  assertConnection(connection);
  return db.prepare("SELECT observation_json FROM tracker_observations WHERE provider='simkl' AND connection_id=? AND account_id=? AND kind='watched' AND status IN ('observed','applied','pending')")
    .all(connection.id, connection.remoteUserId).some((row) => simklMediaMatches(JSON.parse(row.observation_json).media, media));
}

// An explicit import restores a remote watch the local history lacks. It is a
// historical projection, like a Trakt reconcile, never a new play event.
export function requeueSimklObservation(connection, id) {
  assertConnection(connection);
  const row = db.prepare("SELECT observation_json FROM tracker_observations WHERE id=? AND connection_id=? AND account_id=? AND kind='watched' AND status IN ('observed','applied')")
    .get(id, connection.id, connection.remoteUserId);
  if (!row) return false;
  const observation = { ...JSON.parse(row.observation_json), syncIntent: "import" };
  // created_at restarts so only a local unwatch after this import defers it.
  const now = Date.now();
  return db.prepare("UPDATE tracker_observations SET status='pending',observation_json=?,created_at=?,updated_at=? WHERE id=? AND status IN ('observed','applied')")
    .run(JSON.stringify(observation), now, now, id).changes === 1;
}

export function completeSimklObservation(connection, id) {
  assertConnection(connection);
  return db.prepare("UPDATE tracker_observations SET status='applied',updated_at=? WHERE id=? AND connection_id=? AND account_id=? AND status='pending'")
    .run(Date.now(), id, connection.id, connection.remoteUserId).changes === 1;
}

export function simklObservationAttentionItems() {
  const reasons = {
    rating_watch_ambiguity: "A rating may have created this watch.",
    episode_mapping_required: "This episode's numbering needs a verified match.",
    incomplete_episode_coverage: "Simkl did not return every watched episode.",
    observation_requires_review: "Another observation for this item needs review.",
    identity_mapping_required: "This item needs a verified media match.",
    unknown_watch_date: "Simkl did not provide a known watch date.",
  };
  return db.prepare(`SELECT o.* FROM tracker_observations o JOIN tracker_connections c ON c.provider=o.provider
    AND c.id=o.connection_id AND c.remote_user_id=o.account_id WHERE o.provider='simkl' AND o.status='review' ORDER BY o.created_at`).all().map((row) => {
    const item = JSON.parse(row.observation_json);
    return { id: `simkl-observation-${row.id}`, kind: "tracker_observation_review", provider: "simkl", severity: "warning",
      title: `Simkl: ${item.media?.title || "Media observation"}`, source: "tracker_observation", status: "review",
      reason: reasons[row.reason] || "This Simkl observation needs review.", summary: reasons[row.reason] || "This Simkl observation needs review before it can change local history.", createdAt: row.created_at,
      explanation: "The watch date, media identity or rating side effects are not safe to apply automatically. Missing items never clear local watches or ratings.",
      recommendations: ["Check this title and its history on Simkl. Local history has been kept."],
      canSkip: true, skipLabel: "Keep local history", skipTitle: "Keep local history?",
      skipNote: "Hides this observation. It does not send a write or change local history." };
  });
}

export function dismissSimklObservation(id) {
  return db.prepare(`UPDATE tracker_observations SET status='dismissed',updated_at=? WHERE id=? AND provider='simkl' AND status='review'
    AND EXISTS (SELECT 1 FROM tracker_connections c WHERE c.provider='simkl' AND c.id=connection_id AND c.remote_user_id=account_id)`)
    .run(Date.now(), id).changes === 1;
}
