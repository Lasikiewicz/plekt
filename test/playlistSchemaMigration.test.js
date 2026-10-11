import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

function openWithAppSchema(dataDir) {
  const command = "import('./server/src/db.js').then(({db}) => { db.close(); })";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", command], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output || `db child exited ${code}`)));
  });
}

function removeDir(dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    if (error?.code !== "EBUSY") throw error;
  }
}

function assertPlaylistConstraints(database) {
  database.pragma("foreign_keys = ON");
  const now = Date.now();
  database.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES ('p1', 'Road Trip', ?, ?)").run(now, now);
  assert.throws(
    () => database.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES ('p2', 'road trip', ?, ?)").run(now, now),
    /UNIQUE/,
  );
  database.prepare("INSERT INTO personal_lists (id, name, created_at, updated_at, deleted_at) VALUES ('p3', 'ROAD TRIP', ?, ?, ?)").run(now, now, now);

  database.prepare(`INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, show_title, season, episode, position, created_at, updated_at)
    VALUES ('p1', 'episode:tmdb:1:s1e2', 'episode', 'Pilot 2', '1', 'Show', 1, 2, 0, ?, ?)`).run(now, now);
  assert.throws(
    () => database.prepare(`INSERT INTO personal_list_items (list_id, media_key, media_type, title, created_at, updated_at)
      VALUES ('p1', 'episode:bad', 'episode', 'No numbers', ?, ?)`).run(now, now),
    /CHECK/,
  );
  database.prepare(`INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, position, created_at, updated_at)
    VALUES ('p1', 'tv:tmdb:1', 'tv', 'Show', '1', 1, ?, ?)`).run(now, now);
  database.prepare("INSERT INTO personal_list_item_exclusions (list_id, media_key, season, episode, origin, excluded_at) VALUES ('p1', 'tv:tmdb:1', 1, 3, 'plex', ?)").run(now);
  database.prepare("INSERT INTO personal_list_targets (list_id, provider, remote_playlist_id, created_at, updated_at) VALUES ('p1', 'plex', '99', ?, ?)").run(now, now);
  assert.throws(
    () => database.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES ('p1', 'trakt', ?, ?)").run(now, now),
    /CHECK/,
  );
  database.prepare(`INSERT INTO personal_list_entry_ledger (list_id, provider, remote_entry_id, provider_item_id, media_key, remote_position, origin, first_seen_at, last_seen_at)
    VALUES ('p1', 'plex', 'e1', 'rk1', 'tv:tmdb:1', 0, 'plembfin', ?, ?)`).run(now, now);

  database.prepare("DELETE FROM personal_list_items WHERE list_id = 'p1' AND media_key = 'tv:tmdb:1'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM personal_list_item_exclusions").get().n, 0);
  database.prepare("DELETE FROM personal_lists WHERE id = 'p1'").run();
  for (const table of ["personal_list_items", "personal_list_targets", "personal_list_entry_ledger"]) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE list_id = 'p1'`).get().n, 0, table);
  }
}

test("playlist migration keeps existing lists Plembfin-only with their order", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-migration-"));
  const legacy = new Database(path.join(dataDir, "plekt.db"));
  legacy.exec(`
    CREATE TABLE personal_lists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE personal_list_items (
      list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      title TEXT NOT NULL, tmdb_id TEXT, tvdb_id TEXT, imdb_id TEXT, poster_url TEXT, overview TEXT, release_date TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (list_id, media_key)
    );
    CREATE INDEX idx_personal_list_items_list ON personal_list_items(list_id, updated_at DESC);
    INSERT INTO personal_lists VALUES ('a', 'Favourites', 1, 10), ('b', 'favourites', 2, 20), ('c', 'Empty', 3, 30);
    INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, poster_url, created_at, updated_at) VALUES
      ('a', 'movie:tmdb:1', 'movie', 'Oldest', '1', '/p1.jpg', 1, 100),
      ('a', 'movie:tmdb:2', 'movie', 'Newest', '2', '/p2.jpg', 2, 300),
      ('a', 'tv:tmdb:3', 'tv', 'Middle', '3', '/p3.jpg', 3, 200),
      ('b', 'movie:tmdb:4', 'movie', 'Only', '4', NULL, 4, 50);
  `);
  legacy.close();

  try {
    await openWithAppSchema(dataDir);
    await openWithAppSchema(dataDir);
    const upgraded = new Database(path.join(dataDir, "plekt.db"));
    assert.ok(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = 43").get());
    // Migration 44 then moves the show out of the mixed list 'a' (next test).
    assert.deepEqual(
      upgraded.prepare("SELECT media_key, title, poster_url, position FROM personal_list_items WHERE list_id = 'a' ORDER BY position").all(),
      [
        { media_key: "movie:tmdb:2", title: "Newest", poster_url: "/p2.jpg", position: 0 },
        { media_key: "movie:tmdb:1", title: "Oldest", poster_url: "/p1.jpg", position: 1 },
      ],
    );
    assert.equal(upgraded.prepare("SELECT list_id FROM personal_list_items WHERE media_key = 'tv:tmdb:3'").get().list_id,
      upgraded.prepare("SELECT id FROM personal_lists WHERE name = 'Favourites (TV)'").get().id);
    assert.equal(upgraded.prepare("SELECT position FROM personal_list_items WHERE list_id = 'b'").get().position, 0);
    assert.deepEqual(
      upgraded.prepare("SELECT id, name, created_at, deleted_at, kind FROM personal_lists WHERE id IN ('a', 'b', 'c') ORDER BY id").all(),
      [
        { id: "a", name: "Favourites", created_at: 1, deleted_at: null, kind: "movie" },
        { id: "b", name: "favourites (2)", created_at: 2, deleted_at: null, kind: "movie" },
        { id: "c", name: "Empty", created_at: 3, deleted_at: null, kind: null },
      ],
    );
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM personal_list_targets").get().n, 0);
    assert.equal(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_personal_list_items_list'").get(), undefined);
    for (const leftover of ["personal_lists_migrated", "personal_list_items_backup"]) {
      assert.equal(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(leftover), undefined);
    }
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    assertPlaylistConstraints(upgraded);
    upgraded.close();
  } finally {
    removeDir(dataDir);
  }
});

test("migration 44 types playlists and splits a mixed one into a Movies and a TV playlist", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-kind-"));
  try {
    await openWithAppSchema(dataDir);
    // Back to the state before migration 44, with playlists already synced.
    const before = new Database(path.join(dataDir, "plekt.db"));
    before.exec(`
      DELETE FROM schema_migrations WHERE id = 44;
      ALTER TABLE personal_lists DROP COLUMN kind;
      INSERT INTO personal_lists (id, name, created_at, updated_at) VALUES
        ('mix', 'Weekend', 1, 1), ('clash', 'Weekend (TV)', 2, 2), ('tvonly', 'Shows', 3, 3), ('eps', 'Eps', 4, 4);
      INSERT INTO personal_lists (id, name, created_at, updated_at, deleted_at, deleted_origin) VALUES ('gone', 'Old', 5, 5, 9, 'local');
      INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, season, episode, position, created_at, updated_at) VALUES
        ('mix', 'episode:tmdb:7:s1e1', 'episode', 'Pilot', '7', 1, 1, 0, 1, 1),
        ('mix', 'movie:tmdb:1', 'movie', 'Film', '1', NULL, NULL, 1, 1, 1),
        ('mix', 'tv:tmdb:8', 'tv', 'Series', '8', NULL, NULL, 2, 1, 1),
        ('mix', 'movie:tmdb:2', 'movie', 'Film 2', '2', NULL, NULL, 3, 1, 1),
        ('clash', 'movie:tmdb:3', 'movie', 'Film 3', '3', NULL, NULL, 0, 1, 1),
        ('tvonly', 'tv:tmdb:9', 'tv', 'Other', '9', NULL, NULL, 0, 1, 1),
        ('eps', 'episode:tmdb:9:s2e1', 'episode', 'Two', '9', 2, 1, 0, 1, 1),
        ('gone', 'movie:tmdb:4', 'movie', 'Film 4', '4', NULL, NULL, 0, 1, 1),
        ('gone', 'tv:tmdb:5', 'tv', 'Five', '5', NULL, NULL, 1, 1, 1);
      INSERT INTO personal_list_item_exclusions (list_id, media_key, season, episode, origin, excluded_at) VALUES ('mix', 'tv:tmdb:8', 1, 2, 'plex', 1);
      INSERT INTO personal_list_targets (list_id, provider, desired_state, remote_playlist_id, remote_name, created_at, updated_at) VALUES
        ('mix', 'plex', 'present', '99', 'Weekend', 1, 1), ('mix', 'emby', 'absent', '98', 'Weekend', 1, 1);
      INSERT INTO personal_list_item_availability (list_id, media_key, provider, status, checked_at) VALUES
        ('mix', 'tv:tmdb:8', 'plex', 'available', 1), ('mix', 'movie:tmdb:1', 'plex', 'available', 1);
      INSERT INTO personal_list_entry_ledger (list_id, provider, remote_entry_id, provider_item_id, media_key, remote_position, origin, first_seen_at, last_seen_at) VALUES
        ('mix', 'plex', 'e1', 'rk1', 'tv:tmdb:8', 0, 'plembfin', 1, 1);
    `);
    before.close();

    await openWithAppSchema(dataDir);
    const after = new Database(path.join(dataDir, "plekt.db"));
    const lists = Object.fromEntries(after.prepare("SELECT * FROM personal_lists").all().map((row) => [row.name, row]));
    const items = (listId) => after.prepare("SELECT media_key, position FROM personal_list_items WHERE list_id = ? ORDER BY position").all(listId)
      .map((row) => [row.media_key, row.position]);
    const tv = lists["Weekend (TV) (2)"];
    assert.ok(tv, "the split takes a free name");
    assert.equal(lists.Weekend.kind, "movie");
    assert.equal(tv.kind, "tv");
    assert.deepEqual(items("mix"), [["movie:tmdb:1", 0], ["movie:tmdb:2", 1]]);
    assert.deepEqual(items(tv.id), [["episode:tmdb:7:s1e1", 0], ["tv:tmdb:8", 1]]);
    assert.deepEqual([lists["Weekend (TV)"].kind, lists.Shows.kind, lists.Eps.kind], ["movie", "tv", "tv"]);
    // The TV half targets the same selected apps, with no app copy yet.
    assert.deepEqual(after.prepare("SELECT provider, desired_state, remote_playlist_id FROM personal_list_targets WHERE list_id = ?").all(tv.id)
      .map((row) => ({ ...row })), [{ provider: "plex", desired_state: "present", remote_playlist_id: null }]);
    assert.deepEqual(after.prepare("SELECT list_id, media_key, season, episode FROM personal_list_item_exclusions").all().map((row) => ({ ...row })),
      [{ list_id: tv.id, media_key: "tv:tmdb:8", season: 1, episode: 2 }]);
    assert.deepEqual(after.prepare("SELECT media_key FROM personal_list_item_availability").all().map((row) => row.media_key), ["movie:tmdb:1"]);
    // The original's ledger keeps the moved entry, so its push removes it from the app copy.
    assert.equal(after.prepare("SELECT list_id FROM personal_list_entry_ledger WHERE remote_entry_id = 'e1'").get().list_id, "mix");
    // A deleted mixed playlist splits into two deleted playlists.
    const goneTv = lists["Old (TV)"];
    assert.deepEqual([lists.Old.kind, lists.Old.deleted_at, goneTv.kind, goneTv.deleted_at, goneTv.deleted_origin], ["movie", 9, "tv", 9, "local"]);
    assert.deepEqual(after.pragma("foreign_key_check"), []);
    after.close();
  } finally {
    removeDir(dataDir);
  }
});

test("migration 45 widens the playlist type to Mixed without losing playlists, items, or targets", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-mixed-"));
  try {
    await openWithAppSchema(dataDir);
    // Back to the Movies-or-TV-only column from before migration 45.
    const before = new Database(path.join(dataDir, "plekt.db"));
    before.exec(`
      DELETE FROM schema_migrations WHERE id = 45;
      ALTER TABLE personal_lists DROP COLUMN kind;
      ALTER TABLE personal_lists ADD COLUMN kind TEXT CHECK (kind IN ('movie', 'tv'));
      INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES ('m', 'Films', 'movie', 1, 1), ('t', 'Shows', 'tv', 2, 2), ('u', 'Old', NULL, 3, 3);
      INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, position, created_at, updated_at) VALUES ('m', 'movie:tmdb:1', 'movie', 'Film', '1', 0, 1, 1);
      INSERT INTO personal_list_targets (list_id, provider, desired_state, remote_playlist_id, created_at, updated_at) VALUES ('m', 'plex', 'present', '99', 1, 1);
    `);
    assert.throws(() => before.prepare("UPDATE personal_lists SET kind = 'mixed' WHERE id = 'u'").run(), /CHECK/);
    before.close();

    await openWithAppSchema(dataDir);
    const after = new Database(path.join(dataDir, "plekt.db"));
    after.pragma("foreign_keys = ON");
    assert.deepEqual(after.prepare("SELECT id, kind FROM personal_lists ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "m", kind: "movie" }, { id: "t", kind: "tv" }, { id: "u", kind: null }]);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM personal_list_items WHERE list_id = 'm'").get().n, 1);
    assert.equal(after.prepare("SELECT remote_playlist_id FROM personal_list_targets WHERE list_id = 'm'").get().remote_playlist_id, "99");
    after.prepare("UPDATE personal_lists SET kind = 'mixed' WHERE id = 'u'").run();
    assert.throws(() => after.prepare("UPDATE personal_lists SET kind = 'music' WHERE id = 'u'").run(), /CHECK/);
    assert.ok(after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_personal_lists_active_name'").get());
    assert.equal(after.pragma("table_info(personal_lists)").some((column) => column.name === "kind_widened"), false);
    assert.deepEqual(after.pragma("foreign_key_check"), []);
    after.close();
  } finally {
    removeDir(dataDir);
  }
});

test("a fresh database gets the playlist schema and indexes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-fresh-"));
  try {
    await openWithAppSchema(dataDir);
    const fresh = new Database(path.join(dataDir, "plekt.db"));
    for (const index of ["idx_personal_lists_active_name", "idx_personal_list_items_position", "idx_personal_list_entry_ledger_item"]) {
      assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index);
    }
    assertPlaylistConstraints(fresh);
    fresh.prepare("INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES ('fresh-mixed', 'Both', 'mixed', 1, 1)").run();
    const columns = fresh.pragma("table_info(personal_lists)").map((column) => column.name);
    for (const column of ["rule_json", "rule_checked_at", "rule_error", "remove_watched"]) assert.ok(columns.includes(column), column);
    assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_list_handoffs'").get());
    fresh.close();
  } finally {
    removeDir(dataDir);
  }
});

test("migration 47 adds the automatic playlist rule columns and keeps existing playlists manual", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-rules-"));
  try {
    await openWithAppSchema(dataDir);
    const before = new Database(path.join(dataDir, "plekt.db"));
    before.exec(`
      DELETE FROM schema_migrations WHERE id = 47;
      ALTER TABLE personal_lists DROP COLUMN rule_json;
      ALTER TABLE personal_lists DROP COLUMN rule_checked_at;
      ALTER TABLE personal_lists DROP COLUMN rule_error;
      INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES ('m', 'Films', 'movie', 1, 1);
      INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, position, created_at, updated_at) VALUES ('m', 'movie:tmdb:1', 'movie', 'Film', '1', 0, 1, 1);
    `);
    before.close();

    await openWithAppSchema(dataDir);
    const after = new Database(path.join(dataDir, "plekt.db"));
    assert.deepEqual({ ...after.prepare("SELECT id, kind, rule_json, rule_checked_at, rule_error FROM personal_lists").get() },
      { id: "m", kind: "movie", rule_json: null, rule_checked_at: null, rule_error: null });
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM personal_list_items WHERE list_id = 'm'").get().n, 1);
    assert.ok(after.prepare("SELECT id FROM schema_migrations WHERE id = 47").get());
    after.close();
  } finally {
    removeDir(dataDir);
  }
});

test("migration 49 adds Remove items once watched (off) and the hand-off table", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-playlist-watched-"));
  try {
    await openWithAppSchema(dataDir);
    const before = new Database(path.join(dataDir, "plekt.db"));
    before.exec(`
      DELETE FROM schema_migrations WHERE id = 49;
      DROP TABLE personal_list_handoffs;
      ALTER TABLE personal_lists DROP COLUMN remove_watched;
      INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES ('w', 'Films', 'movie', 1, 1);
    `);
    before.close();

    await openWithAppSchema(dataDir);
    const after = new Database(path.join(dataDir, "plekt.db"));
    assert.equal(after.prepare("SELECT remove_watched FROM personal_lists WHERE id = 'w'").get().remove_watched, 0);
    after.prepare("INSERT INTO personal_list_handoffs (list_id, identity, handed_off_at) VALUES ('w', 'movie:tmdb:1', 1)").run();
    after.pragma("foreign_keys = ON");
    after.prepare("DELETE FROM personal_lists WHERE id = 'w'").run();
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM personal_list_handoffs").get().n, 0);
    assert.ok(after.prepare("SELECT id FROM schema_migrations WHERE id = 49").get());
    after.close();
  } finally {
    removeDir(dataDir);
  }
});
