import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getPersonCreditWatchRows } from "../server/src/utils/personCreditWatchRows.js";

test("person credit watch lookup matches ids and movie/show titles", () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE watch_history (
      id INTEGER PRIMARY KEY,
      tmdb_id TEXT,
      title TEXT,
      media_type TEXT,
      season INTEGER,
      episode INTEGER,
      show_title TEXT,
      title_lower TEXT,
      show_title_lower TEXT,
      source TEXT
    );
    INSERT INTO watch_history VALUES
      (1, '100', 'Film A', 'movie', NULL, NULL, NULL, 'film a', NULL, 'plex'),
      (2, NULL, 'Show - S01E01', 'episode', 1, 1, 'Show', 'show - s01e01', 'show', 'jellyfin');
  `);

  try {
    const rows = getPersonCreditWatchRows(database, {
      creditTmdbIds: ["100", "100"],
      creditTitles: ["Film A", "SHOW"],
    });
    assert.deepEqual(rows.map((row) => row.id).sort(), [1, 2]);
  } finally {
    database.close();
  }
});

test("large person filmographies split below SQLite's 999-variable limit", () => {
  const calls = [];
  const database = {
    prepare(query) {
      return {
        all(params) {
          calls.push({ query, params });
          return [];
        },
      };
    },
  };
  const creditTmdbIds = Array.from({ length: 1000 }, (_, index) => String(index + 1));
  const creditTitles = Array.from({ length: 1000 }, (_, index) => `title ${index + 1}`);

  assert.deepEqual(getPersonCreditWatchRows(database, { creditTmdbIds, creditTitles }), []);
  assert.equal(calls.length, 4);
  for (const { query, params } of calls) {
    assert.ok(params.length <= 900);
    assert.equal((query.match(/\?/g) || []).length, params.length);
    assert.doesNotMatch(query, /IN\s*\(\s*\)/i);
  }
  assert.equal(calls[0].params.length, 900);
  assert.equal(calls[3].params.length, 300);
});
