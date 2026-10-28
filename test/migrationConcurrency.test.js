import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

test("legacy schema migration is idempotent under concurrent process startup", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-legacy-concurrent-"));
  const dbPath = path.join(dataDir, "plembfin.db");
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE watch_history (
    id TEXT PRIMARY KEY, title_lower TEXT, media_type TEXT, watched_at TEXT,
    media_key TEXT, show_title_lower TEXT
  ); INSERT INTO watch_history (id) VALUES ('legacy-row');
  CREATE TABLE sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER, media_type TEXT, title TEXT, source TEXT, status TEXT,
    details TEXT, action TEXT, target_states TEXT, raw_payload_debug TEXT,
    activity_group_key TEXT, created_at INTEGER
  );
  INSERT INTO sync_history
    (timestamp, media_type, title, source, status, details, action, target_states, raw_payload_debug, activity_group_key, created_at)
  VALUES
    (1000, 'episode', 'The Curse of Oak Island - S12E01', 'trakt', 'success', '', 'watched', '[]',
     '{"ids":{"imdb":"tt3455408"},"showTitle":"The Curse of Oak Island","season":12,"episode":1}',
     'episode|imdb:tt3455408|s:12|e:1', 1000)`);
  legacy.close();

  const command = "import('./server/src/db.js').then(({db}) => { db.close(); })";
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", command], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `migration child exited ${code}`)));
  });

  try {
    await Promise.all([run(), run()]);
    const upgraded = new Database(dbPath, { readonly: true });
    const columns = new Set(upgraded.pragma("table_info(watch_history)").map((column) => column.name));
    for (const name of ["logo_url", "backdrop_url", "sync_retry_count", "sync_next_retry_at", "watch_provenance", "sync_match_ignored_at", "episode_title", "episode_title_status", "episode_title_checked_at", "episode_title_resolution_error"]) assert.ok(columns.has(name));
    assert.equal(upgraded.prepare("SELECT id FROM watch_history WHERE id='legacy-row'").get()?.id, "legacy-row");
    assert.deepEqual(upgraded.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((row) => row.id), Array.from({ length: 63 },(_, index) => index + 1));
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_connections'").get());
    const connectionColumns = new Set(upgraded.pragma("table_info(media_connections)").map((column) => column.name));
    assert.ok(connectionColumns.has("server_credential_ciphertext"));
    assert.ok(connectionColumns.has("server_owned"));
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracker_connections'").get());
    const trackerColumns = new Set(upgraded.pragma("table_info(tracker_connections)").map((column) => column.name));
    assert.ok(trackerColumns.has("history_synced_at"));
    assert.ok(upgraded.pragma("table_info(tracker_observations)").some((column) => column.name === "attention_required"));
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracker_play_history'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_rating_sources'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_rating_sync_queue'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_rating_sync_runs'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='up_next_provider_items'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='up_next_provider_feed_state'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='up_next_manual_shows'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recommendation_exclusions'").get());
    const ratingColumns = new Set(upgraded.pragma("table_info(personal_ratings)").map((column) => column.name));
    for (const name of ["episode_tmdb_id", "episode_tvdb_id", "episode_imdb_id", "origin", "canonical_updated_at"]) assert.ok(ratingColumns.has(name));
    assert.equal(
      upgraded.prepare("SELECT activity_group_key FROM sync_history WHERE title = 'The Curse of Oak Island - S12E01'").get()?.activity_group_key,
      "show|title:the-curse-of-oak-island",
    );
    upgraded.close();
  } finally {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      // Windows can retain a transient SQLite file handle after both child
      // processes have exited. Cleanup must not turn a successful migration
      // assertion into a test failure; the OS temp directory reclaims it.
      if (error?.code !== "EBUSY") throw error;
    }
  }
});
