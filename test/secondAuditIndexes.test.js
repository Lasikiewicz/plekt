import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// Second audit optimizations, step 1 (10 November 2026): missing SQLite indexes.
// poster_cache had only its primary key, and the TVDB id lookup in the TMDB
// metadata cache parsed the JSON of every TV row.
const dataDir = makeTempDataDir("plekt-audit-indexes-");
const { db } = await import("../server/src/db.js");
const { getSharedMetadataDb } = await import("../server/src/utils/sharedMetadataStore.js");

const plan = (database, sql, ...params) =>
  database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" | ");

test("poster_cache lookups search an index instead of scanning the table", () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'poster_cache'").all().map((row) => row.name));
  assert.ok(names.has("idx_poster_cache_media_variant"));
  assert.ok(names.has("idx_poster_cache_storage_path"));

  const byMediaAndVariant = plan(db, "SELECT id FROM poster_cache WHERE media_key = ? AND variant = ? ORDER BY updated_at_ms DESC LIMIT 1", "k", "poster");
  assert.match(byMediaAndVariant, /USING (?:COVERING )?INDEX idx_poster_cache_media_variant/, byMediaAndVariant);
  assert.doesNotMatch(byMediaAndVariant, /SCAN|TEMP B-TREE/, byMediaAndVariant);

  const artwork = plan(db, "SELECT url FROM poster_cache WHERE media_key = ? AND variant = 'poster' AND status = 'cached' LIMIT 1", "k");
  assert.match(artwork, /USING INDEX idx_poster_cache_media_variant/, artwork);

  const byPath = plan(db, "SELECT media_key, variant, source, original_url FROM poster_cache WHERE storage_path = ? AND status = 'cached' LIMIT 1", "p");
  assert.match(byPath, /USING INDEX idx_poster_cache_storage_path/, byPath);

  const remove = plan(db, "DELETE FROM poster_cache WHERE media_key = ?", "k");
  assert.match(remove, /USING INDEX idx_poster_cache_media_variant/, remove);
});

test("the TVDB id lookup uses the expression index and keeps the old tie order", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../server/src/utils/tmdbGateway.js"), "utf8");
  const match = source.match(/const metaGetByTvdbIdStmt = db\.prepare\(\s*(?:\/\/[^\n]*\n\s*)*"([^"]+)"/);
  assert.ok(match, "metaGetByTvdbIdStmt statement not found in tmdbGateway.js");
  const sql = match[1];

  const shared = getSharedMetadataDb(dataDir);
  assert.match(plan(shared, sql, "1"), /USING INDEX idx_tmdb_metadata_cache_tv_tvdb_id/, "lookup must use the expression index");

  const insert = shared.prepare("INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, details, updated_at_ms) VALUES (?, ?, 'tv', ?, ?)");
  insert.run("tv_100", "100", JSON.stringify({ external_ids: { tvdb_id: "555" } }), 10);
  insert.run("tv_tvdb_555", "100", JSON.stringify({ external_ids: { tvdb_id: "555" } }), 10);
  insert.run("tv_200", "200", JSON.stringify({ external_ids: { tvdb_id: "555" } }), 20);
  insert.run("tv_bad", "300", "{not json", 30);
  insert.run("tv_other", "400", JSON.stringify({ external_ids: { tvdb_id: "777" } }), 40);

  const lookup = shared.prepare(sql);
  // Newest row wins; equal timestamps keep the lowest rowid, as the old scan did.
  assert.equal(lookup.get("555").id, "tv_200");
  shared.prepare("UPDATE tmdb_metadata_cache SET updated_at_ms = 5 WHERE id = 'tv_200'").run();
  assert.equal(lookup.get("555").id, "tv_100");
  assert.equal(lookup.get("777").id, "tv_other");
  assert.equal(lookup.get("999"), undefined);
});
