import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must point at a temp directory before any server module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-metadata-cache-test-"));
process.env.DATA_DIR = dataDir;

const { db, toJson } = await import("../server/src/db.js");
const { getFanartTvArt, getFanartMovieArt } = await import("../server/src/utils/fanartGateway.js");
const { getTmdbDetails, getTmdbSeason, getTmdbShowSeasonLists } = await import("../server/src/utils/tmdbGateway.js");

// No TMDB API key is configured in this environment and fanart.tv is not
// reachable synchronously, so any code path that misses the SQLite caches and
// reaches the network either throws or returns a fallback - the assertions
// below only pass when the cache layer answers.

const seedFanart = db.prepare(
  `INSERT INTO fanart_cache (id, data, missing, updated_at_ms) VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data=excluded.data, missing=excluded.missing, updated_at_ms=excluded.updated_at_ms`,
);

test("fanart gateway serves fresh cached responses without fetching", async () => {
  seedFanart.run("tv/88888", toJson({
    tvposter: [{ url: "https://assets.fanart.tv/poster.jpg", likes: "5", lang: "en" }],
    showbackground: [{ url: "https://assets.fanart.tv/bg.jpg", likes: "2", lang: "" }],
    hdtvlogo: [{ url: "https://assets.fanart.tv/logo.png", likes: "9", lang: "en" }],
  }), 0, Date.now());

  const art = await getFanartTvArt("88888");
  assert.equal(art.poster, "https://assets.fanart.tv/poster.jpg");
  assert.equal(art.backdrop, "https://assets.fanart.tv/bg.jpg");
  assert.equal(art.logo, "https://assets.fanart.tv/logo.png");
});

test("fanart gateway serves fresh cached misses as null without fetching", async () => {
  seedFanart.run("movies/77777", null, 1, Date.now());
  const art = await getFanartMovieArt("77777");
  assert.equal(art, null);
});

test("light-cached details satisfy light callers but full callers refetch", async () => {
  // Seed a fresh light row for tv_666 …
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("tv_666", "666", "tv", "Light Show", toJson({
    id: "666",
    name: "Light Show",
    status: "Ended",
    details_light: true,
    tv_synopsis_language_version: 1,
    tv_synopsis_language_status: "missing",
    external_ids: { tvdb_id: "333", tmdb_id: "666" },
  }), 9999, Date.now());
  // … plus the TVDB series cache and a fanart miss, so the full refetch below
  // resolves entirely from SQLite (no TMDB key is configured, TVDB/fanart are
  // answered by their caches).
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("series_333", "333", "Full Show", toJson({
    id: 333,
    name: "Full Show",
    overview: "",
    status: { name: "Ended" },
    episodes: [],
    seasons: [],
    remoteIds: [{ sourceName: "TheMovieDB.com", id: "666" }],
    firstAired: "2020-01-01",
  }), Date.now());
  seedFanart.run("tv/333", null, 1, Date.now());

  const light = await getTmdbDetails({ mediaType: "tv", tmdbId: "666", title: "Light Show", ids: { tvdbId: "333" }, light: true });
  assert.equal(light.name, "Light Show");
  assert.equal(light.details_light, true);

  const full = await getTmdbDetails({ mediaType: "tv", tmdbId: "666", title: "Light Show", ids: { tvdbId: "333" } });
  assert.equal(full.name, "Full Show");
  assert.equal(full.details_light, undefined);
});

test("getTmdbDetails returns fresh cached TV details without upstream fetches", async () => {
  const details = {
    id: "555",
    name: "Cached Show",
    status: "Returning Series",
    tv_synopsis_language_version: 1,
    tv_synopsis_language_status: "missing",
    seasons: [{ season_number: 1, episode_count: 8 }],
    external_ids: { tvdb_id: "444", tmdb_id: "555" },
    next_airing_date: "2999-01-01",
  };
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("tv_555", "555", "tv", "Cached Show", toJson(details), 9999, Date.now());

  const result = await getTmdbDetails({ mediaType: "tv", tmdbId: "555", title: "Cached Show", ids: { tvdbId: "444" } });
  assert.equal(result.name, "Cached Show");
  assert.equal(result.next_airing_date, "2999-01-01");
  // cache_stale is only stamped when the fresh-cache path was missed and the
  // upstream fetch failed - its absence proves the cache answered directly.
  assert.equal(result.cache_stale, undefined);
});

test("demo TV details can resolve a TMDB-keyed row through its TVDB identity", async () => {
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("tv_556", "556", "tv", "TVDB Routed Demo Show", toJson({
    id: "556",
    name: "TVDB Routed Demo Show",
    external_ids: { tvdb_id: "445", tmdb_id: "556" },
  }), 9999, Date.now());

  const previousDemoMode = process.env.PLEMBFIN_DEMO_MODE;
  process.env.PLEMBFIN_DEMO_MODE = "1";
  try {
    const result = await getTmdbDetails({ mediaType: "tv", ids: { tvdbId: "445" } });
    assert.equal(result.name, "TVDB Routed Demo Show");
    assert.equal(result.external_ids.tvdb_id, "445");
  } finally {
    if (previousDemoMode === undefined) delete process.env.PLEMBFIN_DEMO_MODE;
    else process.env.PLEMBFIN_DEMO_MODE = previousDemoMode;
  }
});

test("explicit TVDB and IMDb ids cannot reuse a conflicting TMDB cache slot", async () => {
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("tv_290057", "290057", "tv", "The Assembly", toJson({
    id: "290057",
    name: "The Assembly",
    external_ids: { tvdb_id: "452480", imdb_id: "tt33204483", tmdb_id: "290057" },
  }), 9999, Date.now());
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run("series_453869", "453869", "The Assembly (UK)", toJson({
    id: 453869,
    name: "The Assembly (UK)",
    status: { name: "Continuing" },
    episodes: [],
    seasons: [],
    remoteIds: [
      { sourceName: "TheMovieDB.com", id: "6227290" },
      { sourceName: "IMDB", id: "tt8064568" },
    ],
    firstAired: "2025-04-26",
  }), Date.now());

  const result = await getTmdbDetails({
    mediaType: "tv",
    tmdbId: "290057",
    title: "The Assembly (UK)",
    ids: { tvdbId: "453869", imdbId: "tt8064568" },
  });
  assert.equal(result.name, "The Assembly (UK)");
  assert.equal(result.id, "6227290");
  assert.equal(result.external_ids.tvdb_id, "453869");
  assert.equal(result.external_ids.imdb_id, "tt8064568");
});

test("TMDB-id season requests find TVDB-keyed show metadata", async () => {
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("tv_tvdb_777", "777", "tv", "TVDB Cached Show", toJson({
    id: "777",
    name: "TVDB Cached Show",
    external_ids: { tvdb_id: "888", tmdb_id: "777" },
  }), 9999, Date.now());
  db.prepare(
    `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("888_1", "888", 1, toJson({
    episodes: [
      { number: 1, name: "Pilot", aired: "2026-01-01", image: "https://example.test/pilot.jpg" },
      { number: 2, name: "Second", aired: "2026-01-08", image: "https://example.test/second.jpg" },
    ],
  }), Date.now());

  const season = await getTmdbSeason({ tmdbId: "777", seasonNumber: 1 });
  assert.deepEqual(season.episodes.map((episode) => episode.name), ["Pilot", "Second"]);
});

test("TMDB show season lists preserve episode IDs for Netflix review choices", async () => {
  db.prepare(
    `INSERT INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("778_1", "778", 1, null, toJson({
    episodes: [{ id: 98765, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }],
  }), Date.now());

  const seasons = await getTmdbShowSeasonLists({ tmdbId: "778", cachedOnly: true });
  assert.equal(seasons[0].episodes[0].id, 98765);
  assert.equal(seasons[0].episodes[0].episode_number, 1);
});
