import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-rating-provider-migration-");
const { db } = await import("../server/src/db.js");
const { rebuildRatingTablesWithoutProviderCheck } = await import("../server/src/utils/ratingProviderMigration.js");
const { addHeldRatingStatus } = await import("../server/src/utils/ratingProviderMigration.js");
const ratings = await import("../server/src/utils/personalRatingRepository.js");

const OLD_CHECK = "CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt'))";

function legacyDatabase() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE personal_rating_sources (
      provider TEXT NOT NULL ${OLD_CHECK}, media_key TEXT NOT NULL, media_json TEXT NOT NULL,
      provider_item_id TEXT, provider_ids_json TEXT, remote_rating INTEGER, remote_state TEXT NOT NULL DEFAULT 'unknown',
      remote_rated_at INTEGER, last_seen_at INTEGER, last_snapshot_generation INTEGER, last_complete_snapshot_at INTEGER,
      last_inbound_at INTEGER, last_outbound_rating INTEGER, last_outbound_state TEXT, last_outbound_intent_id TEXT,
      last_outbound_at INTEGER, sync_status TEXT NOT NULL DEFAULT 'unknown', last_error TEXT, PRIMARY KEY (provider, media_key));
    CREATE INDEX idx_personal_rating_sources_snapshot ON personal_rating_sources(provider, last_snapshot_generation, remote_state);
    CREATE TABLE personal_rating_sync_queue (
      provider TEXT NOT NULL ${OLD_CHECK}, media_key TEXT NOT NULL, media_json TEXT NOT NULL, desired_state TEXT NOT NULL,
      desired_rating INTEGER, source TEXT NOT NULL, intent_id TEXT NOT NULL, canonical_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_expires_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      succeeded_at INTEGER, PRIMARY KEY (provider, media_key));
    CREATE TABLE personal_rating_sync_runs (
      provider TEXT PRIMARY KEY ${OLD_CHECK}, run_id TEXT, generation INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'baseline',
      status TEXT NOT NULL DEFAULT 'idle', baseline_complete INTEGER NOT NULL DEFAULT 0, started_at INTEGER, completed_at INTEGER,
      scanned_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
      cleared_count INTEGER NOT NULL DEFAULT 0, queued_count INTEGER NOT NULL DEFAULT 0, cursor_json TEXT, last_error TEXT,
      updated_at INTEGER NOT NULL);
    INSERT INTO personal_rating_sources (provider, media_key, media_json, remote_rating, remote_state, last_outbound_intent_id)
      VALUES ('trakt', 'movie:tmdb:1', '{"title":"A"}', 8, 'rated', 'intent-1'), ('plex', 'movie:tmdb:2', '{}', NULL, 'unrated', NULL);
    INSERT INTO personal_rating_sync_queue (provider, media_key, media_json, desired_state, desired_rating, source, intent_id, created_at, updated_at)
      VALUES ('emby', 'movie:tmdb:3', '{}', 'rated', 6, 'manual', 'intent-3', 1, 2);
    INSERT INTO personal_rating_sync_runs (provider, generation, baseline_complete, updated_at) VALUES ('jellyfin', 4, 1, 5);
  `);
  return database;
}

test("migration 58 and 60 widen provider and held-status checks while preserving rows and indexes", () => {
  const database = legacyDatabase();
  database.transaction(() => { rebuildRatingTablesWithoutProviderCheck(database); addHeldRatingStatus(database); }).immediate();

  for (const table of ["personal_rating_sources", "personal_rating_sync_queue", "personal_rating_sync_runs"]) {
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    assert.doesNotMatch(sql, /provider IN/i, table);
  }
  assert.deepEqual(
    database.prepare("SELECT provider, media_key, media_json, remote_rating, remote_state, last_outbound_intent_id FROM personal_rating_sources ORDER BY provider").all(),
    [
      { provider: "plex", media_key: "movie:tmdb:2", media_json: "{}", remote_rating: null, remote_state: "unrated", last_outbound_intent_id: null },
      { provider: "trakt", media_key: "movie:tmdb:1", media_json: '{"title":"A"}', remote_rating: 8, remote_state: "rated", last_outbound_intent_id: "intent-1" },
    ],
  );
  assert.equal(database.prepare("SELECT intent_id FROM personal_rating_sync_queue WHERE provider='emby'").get().intent_id, "intent-3");
  assert.equal(database.prepare("SELECT generation FROM personal_rating_sync_runs WHERE provider='jellyfin'").get().generation, 4);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_personal_rating_sources_snapshot'").get());
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_personal_rating_sync_queue_due'").get());
  // Value CHECKs other than provider survive the rebuild.
  assert.throws(() => database.prepare("INSERT INTO personal_rating_sync_queue (provider, media_key, media_json, desired_state, source, intent_id, created_at, updated_at) VALUES ('simkl', 'k', '{}', 'bogus', 'manual', 'i', 1, 1)").run(), /CHECK/);
  database.prepare("INSERT INTO personal_rating_sync_runs (provider, updated_at) VALUES ('simkl', 1)").run();

  // Migration 60 adds held without losing the CHECKs that protect other fields;
  // a second run of either migration is a no-op.
  database.prepare("INSERT INTO personal_rating_sync_queue (provider, media_key, media_json, desired_state, source, intent_id, status, created_at, updated_at) VALUES ('simkl', 'held-key', '{}', 'rated', 'manual', 'held-1', 'held', 1, 1)").run();
  database.transaction(() => { rebuildRatingTablesWithoutProviderCheck(database); addHeldRatingStatus(database); }).immediate();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM personal_rating_sources").get().count, 2);
  database.close();
});

test("migration 60 rebuilds pre-held status CHECKs and preserves data on rerun", () => {
  const database = new Database(":memory:");
  for (const table of ["personal_rating_sources", "personal_rating_sync_queue"]) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(table).sql;
    database.exec(sql.replaceAll(", 'held'", ""));
  }
  database.prepare("INSERT INTO personal_rating_sources (provider,media_key,media_json,remote_state,sync_status) VALUES ('simkl','movie:tmdb:1','{}','rated','synced')").run();
  database.prepare("INSERT INTO personal_rating_sync_queue (provider,media_key,media_json,desired_state,desired_rating,source,intent_id,status,created_at,updated_at) VALUES ('simkl','movie:tmdb:1','{}','rated',8,'manual','preserved','failed',1,2)").run();
  assert.throws(() => database.exec("UPDATE personal_rating_sync_queue SET status='held'"), /CHECK/);
  database.transaction(() => addHeldRatingStatus(database)).immediate();
  database.exec("UPDATE personal_rating_sync_queue SET status='held'; UPDATE personal_rating_sources SET sync_status='held'");
  database.transaction(() => addHeldRatingStatus(database)).immediate();
  assert.deepEqual(database.prepare("SELECT intent_id,status,desired_rating FROM personal_rating_sync_queue").get(), { intent_id: "preserved", status: "held", desired_rating: 8 });
  assert.equal(database.prepare("SELECT sync_status FROM personal_rating_sources").get().sync_status, "held");
  assert.throws(() => database.exec("UPDATE personal_rating_sync_queue SET desired_rating=11"), /CHECK/);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_personal_rating_sync_queue_due'").get());
  database.close();
});

test("fresh schema has no rating provider CHECK and the registry rejects unknown providers", () => {
  const sql = db.prepare("SELECT group_concat(sql, ' ') AS sql FROM sqlite_master WHERE type='table' AND name LIKE 'personal_rating_s%'").get().sql;
  assert.doesNotMatch(sql, /provider IN/i);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 60").get());
  assert.deepEqual(ratings.PERSONAL_RATING_PROVIDERS, ["plex", "emby", "jellyfin", "trakt", "simkl"]);
  assert.equal(ratings.getPersonalRatingSyncRun("simkl"), null);
  assert.throws(() => ratings.getPersonalRatingSyncRun("letterboxd"), /Unsupported rating provider/);
});

test("rating rows for an unknown provider are kept but never claimed, retried, listed or counted", () => {
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO personal_rating_sync_queue
    (provider, media_key, media_json, desired_state, desired_rating, source, intent_id, status, created_at, updated_at)
    VALUES (?, 'movie:tmdb:9', '{}', 'rated', 7, 'manual', ?, ?, ?, ?)`);
  insert.run("letterboxd", "unknown-pending", "pending", now, now);
  insert.run("trakt", "known-pending", "pending", now, now);
  db.prepare("INSERT INTO personal_rating_sync_runs (provider, updated_at) VALUES ('letterboxd', ?)").run(now);

  assert.deepEqual(ratings.listPersonalRatingQueue().map((row) => row.provider), ["trakt"]);
  assert.equal(ratings.ratingQueueCounts().pending, 1);
  assert.ok(!ratings.listPersonalRatingSyncRuns().some((run) => run.provider === "letterboxd"));
  db.prepare("UPDATE personal_rating_sync_queue SET status='failed' WHERE provider='letterboxd'").run();
  assert.equal(ratings.retryPersonalRatingQueue({ now }), 0);
  db.prepare("UPDATE personal_rating_sync_queue SET status='pending' WHERE provider='letterboxd'").run();
  assert.deepEqual(ratings.claimPersonalRatingQueue({ now }).rows.map((row) => row.provider), ["trakt"]);

  const kept = db.prepare("SELECT status, attempt_count FROM personal_rating_sync_queue WHERE provider='letterboxd'").get();
  assert.deepEqual(kept, { status: "pending", attempt_count: 0 });
});
