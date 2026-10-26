import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-season-source-test-");

const { normalizeStoredConfig, saveMediaConfig } = await import("../server/src/utils/configStore.js");
const {
  normalizeSeasonSource,
  resolveSeasonSource,
  readGlobalSeasonSource,
  readSeasonSource,
  resolveAndRecordSeasonSource,
  pinUnrecordedSeasonSources,
} = await import("../server/src/utils/seasonSource.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
});

test("normalizeSeasonSource defaults anything that is not tmdb to tvdb", () => {
  assert.equal(normalizeSeasonSource(undefined), "tvdb");
  assert.equal(normalizeSeasonSource(""), "tvdb");
  assert.equal(normalizeSeasonSource("imdb"), "tvdb");
  assert.equal(normalizeSeasonSource(" TMDB "), "tmdb");
});

test("resolveSeasonSource: per-show override beats saved source, which beats the global default", () => {
  assert.equal(resolveSeasonSource({ globalSource: "tvdb" }), "tvdb");
  assert.equal(resolveSeasonSource({ globalSource: "tmdb" }), "tmdb");
  assert.equal(resolveSeasonSource({ recordedSource: "tvdb", globalSource: "tmdb" }), "tvdb");
  assert.equal(resolveSeasonSource({ showOverride: "tmdb", recordedSource: "tvdb", globalSource: "tvdb" }), "tmdb");
  assert.equal(resolveSeasonSource({ showOverride: "bogus", recordedSource: "tmdb", globalSource: "tvdb" }), "tmdb");
});

test("normalizeStoredConfig gives a metadata.seasonSource of tvdb when nothing is stored", () => {
  assert.deepEqual(normalizeStoredConfig({}).metadata, { seasonSource: "tvdb", anidbEnabled: false });
  assert.equal(normalizeStoredConfig({ metadata: { seasonSource: "nope" } }).metadata.seasonSource, "tvdb");
  assert.equal(normalizeStoredConfig({ metadata: { seasonSource: "tmdb" } }).metadata.seasonSource, "tmdb");
});

test("a fresh install reads the global default as tvdb", () => {
  assert.equal(readGlobalSeasonSource(), "tvdb");
});

test("the first read of a show saves its source, and a later global change does not move it", async () => {
  const shows = ["100001"];
  assert.equal(resolveAndRecordSeasonSource(shows[0]), "tvdb");

  await saveMediaConfig({ metadata: { seasonSource: "tmdb" } });
  assert.equal(readGlobalSeasonSource(), "tmdb");

  // Already read under tvdb: keeps tvdb.
  assert.equal(resolveAndRecordSeasonSource(shows[0]), "tvdb");
  // Never read before the change: follows the new default.
  assert.equal(resolveAndRecordSeasonSource("100002"), "tmdb");
});

test("pinUnrecordedSeasonSources pins only shows with no record, and leaves recorded shows alone", async () => {
  await saveMediaConfig({ metadata: { seasonSource: "tmdb" } });
  // 100002 was recorded as tmdb above; 100003 has no record.
  pinUnrecordedSeasonSources(["100002", "100003"]);
  assert.equal(readSeasonSource("100002"), "tmdb");
  assert.equal(readSeasonSource("100003"), "tvdb");
});

test("changing the global setting only writes the settings row and new records, never existing records", async () => {
  const before = db.prepare("SELECT show_key, season_source FROM show_season_source ORDER BY show_key").all();
  await saveMediaConfig({ metadata: { seasonSource: "tvdb" } });
  await saveMediaConfig({ metadata: { seasonSource: "tmdb" } });
  const after = db.prepare("SELECT show_key, season_source FROM show_season_source ORDER BY show_key").all();
  for (const row of before) {
    assert.deepEqual(after.find((candidate) => candidate.show_key === row.show_key), row);
  }
});

test("a TMDB source with no TMDB episodes falls back to the TVDB season", async () => {
  const { getCachedTmdbSeason } = await import("../server/src/utils/tmdbGateway.js");
  await saveMediaConfig({ metadata: { seasonSource: "tmdb" } });
  const tvdbId = "900001";
  const tmdbId = "800001";
  const now = Date.now();
  db.prepare("INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
    .run(`${tvdbId}_1`, tvdbId, 1, JSON.stringify({ episodes: [{ number: 1, name: "From TVDB", aired: "2030-01-01" }] }), now);
  db.prepare("INSERT INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`${tmdbId}_1`, tmdbId, 1, null, JSON.stringify({ episodes: [] }), now);

  assert.equal(readSeasonSource(tvdbId), "tmdb");
  assert.equal(getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber: 1 })?.episodes[0]?.name, "From TVDB");

  db.prepare("INSERT INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`${tmdbId}_2`, tmdbId, 2, null, JSON.stringify({ episodes: [{ episode_number: 1, name: "From TMDB", air_date: "2030-01-01" }] }), now);
  db.prepare("INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
    .run(`${tvdbId}_2`, tvdbId, 2, JSON.stringify({ episodes: [] }), now);
  assert.equal(getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber: 2 })?.episodes[0]?.name, "From TMDB");
});

test("the settings route saves metadata.seasonSource and returns it on read", async () => {
  const { handleConfig } = await import("../server/src/routes/admin.js");
  const { AUTH } = await import("../server/src/appConfig.js");
  const request = (method, body) => {
    const headers = { "x-api-key": AUTH.apiKey, "content-type": "application/json" };
    return { method, headers, body, get: (name) => headers[name.toLowerCase()] || "", ip: "127.0.0.1", socket: {} };
  };
  const send = (req) => new Promise((resolve, reject) => {
    const res = {
      status() { return res; },
      set() { return res; },
      setHeader() { return res; },
      send(payload) { resolve(typeof payload === "string" ? JSON.parse(payload) : payload); },
      json(payload) { resolve(payload); },
      end(payload) { resolve(typeof payload === "string" ? JSON.parse(payload) : payload); },
    };
    Promise.resolve(handleConfig(req, res)).catch(reject);
  });

  await send(request("POST", { metadata: { seasonSource: "tmdb" } }));
  const readTmdb = await send(request("GET"));
  assert.equal(readTmdb.config.metadata.seasonSource, "tmdb");

  await send(request("POST", { metadata: { seasonSource: "imdb" } }));
  const readInvalid = await send(request("GET"));
  assert.equal(readInvalid.config.metadata.seasonSource, "tvdb");
});
