import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must point at a temp directory before any server module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-tvdb-season-test-"));
process.env.DATA_DIR = dataDir;

const { db, toJson, parseJson } = await import("../server/src/db.js");
const { getCachedTvdbSeasonEpisodes, getTvdbSeasonEpisodes } = await import("../server/src/utils/tvdbGateway.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const seedSeries = db.prepare(
  `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

function seriesPayload(id, name) {
  return {
    id: Number(id),
    name,
    status: { name: "Ended" },
    seasons: [1, 2, 3].map((number) => ({ id: Number(`${id}${number}`), number, type: { type: "official" } })),
    episodes: [1, 2, 3].flatMap((season) => [1, 2].map((number) => ({
      id: Number(`${id}${season}${number}`),
      seasonNumber: season,
      number,
      name: `${name} S${season}E${number}`,
      overview: "Overview",
      aired: "2010-01-01",
      image: `/banners/episode/${season}${number}.jpg`,
      runtime: 42,
    }))),
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("cold seasons are derived from a fresh cached series payload without any TVDB request", async () => {
  const seriesAt = Date.now() - DAY_MS;
  seedSeries.run("series_7001", "7001", "Derived Show", toJson(seriesPayload("7001", "Derived Show")), seriesAt);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("unexpected TVDB request");
  };
  try {
    const seasons = await Promise.all([1, 2, 3].map((seasonNumber) => getTvdbSeasonEpisodes({ tvdbId: "7001", seasonNumber })));
    assert.equal(requests, 0);
    assert.deepEqual(seasons.map((season) => season.episodes.length), [2, 2, 2]);
    assert.deepEqual(seasons[1].episodes[0], {
      episode_number: 1,
      name: "Derived Show S2E1",
      overview: "Overview",
      air_date: "2010-01-01",
      still_path: "https://artworks.thetvdb.com/banners/episode/21.jpg",
      runtime: 42,
    });
    const row = db.prepare("SELECT details, updated_at_ms FROM tvdb_season_cache WHERE id = ?").get("7001_2");
    assert.equal(row.updated_at_ms, seriesAt, "the season row is never fresher than its series source");
    assert.equal(parseJson(row.details).episodes[0].name, "Derived Show S2E1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const { getCachedTmdbSeason } = await import("../server/src/utils/tmdbGateway.js");

test("getCachedTvdbSeasonEpisodes requires allowSeriesFallback and getCachedTmdbSeason derives uncached non-translated seasons from series_<tvdbId>", async () => {
  const seriesAt = Date.now() - DAY_MS;
  seedSeries.run("series_7003", "7003", "Cache Only Show", toJson(seriesPayload("7003", "Cache Only Show")), seriesAt);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("unexpected TVDB request");
  };
  try {
    assert.equal(getCachedTvdbSeasonEpisodes({ tvdbId: "7003", seasonNumber: 2 }), null);
    const season2 = getCachedTvdbSeasonEpisodes({ tvdbId: "7003", seasonNumber: 2, allowSeriesFallback: true });
    assert.equal(season2?.episodes?.length, 2);
    assert.deepEqual(season2.episodes[0], {
      episode_number: 1,
      name: "Cache Only Show S2E1",
      overview: "Overview",
      air_date: "2010-01-01",
      still_path: "https://artworks.thetvdb.com/banners/episode/21.jpg",
      runtime: 42,
    });
    const viaCachedTmdb = getCachedTmdbSeason({ tvdbId: "7003", seasonNumber: 2 });
    assert.deepEqual(viaCachedTmdb?.episodes, season2.episodes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a series row older than the season TTL is refetched once and then serves every season", async () => {
  // Ended show, but the payload is stored with an aired date inside the last
  // 30 days so each season's TTL (7 days) is shorter than the series row's age.
  const recent = new Date(Date.now() - 5 * DAY_MS).toISOString().slice(0, 10);
  const stale = seriesPayload("7002", "Old Name");
  for (const episode of stale.episodes) episode.aired = recent;
  seedSeries.run("series_7002", "7002", "Old Name", toJson(stale), Date.now() - 10 * DAY_MS);
  const refreshed = seriesPayload("7002", "New Name");
  for (const episode of refreshed.episodes) episode.aired = recent;
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/login")) return response({ data: { token: "token" } });
    if (url.pathname === "/v4/series/7002/extended") return response({ data: refreshed });
    return response({}, 404);
  };
  try {
    const seasons = await Promise.all([1, 2, 3].map((seasonNumber) => getTvdbSeasonEpisodes({ tvdbId: "7002", seasonNumber })));
    assert.deepEqual(seasons.map((season) => season.episodes[0].name), ["New Name S1E1", "New Name S2E1", "New Name S3E1"]);
    assert.equal(paths.filter((pathname) => pathname === "/v4/series/7002/extended").length, 1);
    assert.equal(paths.filter((pathname) => pathname.startsWith("/v4/seasons/")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
