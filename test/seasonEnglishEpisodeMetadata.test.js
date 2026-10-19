import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-season-english-episode-test-"));
process.env.DATA_DIR = dataDir;

const { db, toJson } = await import("../server/src/db.js");
const { getTmdbSeason } = await import("../server/src/utils/tmdbGateway.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");

function seedShow({ tmdbId, tvdbId, source = "tvdb", language = "ja", episodes }) {
  db.prepare(
    `INSERT INTO settings (id, data, updated_at) VALUES ('mediaConfig', ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
  ).run(toJson({ tmdb: { apiKey: "tmdb-test-key" }, metadata: { seasonSource: source } }), Date.now());
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, 'tv', ?, ?, 9999, ?)
     ON CONFLICT(id) DO UPDATE SET details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
  ).run(`tv_${tmdbId}`, tmdbId, `Show ${tmdbId}`, toJson({
    id: tmdbId,
    name: `Show ${tmdbId}`,
    original_language: language,
    external_ids: { tmdb_id: tmdbId, tvdb_id: tvdbId },
  }), Date.now());
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
  ).run(`series_${tvdbId}`, tvdbId, `Show ${tmdbId}`, toJson({
    id: Number(tvdbId),
    name: `Show ${tmdbId}`,
    status: { name: "Ended" },
    seasons: [{ id: Number(`${tvdbId}1`), number: 1, type: { type: "official" } }],
    episodes: episodes.map((episode) => ({
      id: Number(`${tvdbId}${episode.number}`),
      seasonNumber: 1,
      number: episode.number,
      name: episode.name,
      overview: episode.overview,
      aired: episode.air_date,
      image: "",
      runtime: 24,
    })),
  }), Date.now());
  setShowSeasonSource(tvdbId, source, { rowNumbering: source });
}

function tmdbResponse(episodes, status = 200) {
  return new Response(JSON.stringify({ episodes }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("TVDB episode structure prefers matching English TMDB text and falls back per field", async () => {
  const tvdbEpisodes = [
    { number: 1, name: "日本語の題名 1", overview: "日本語の概要 1", air_date: "2020-01-01" },
    { number: 2, name: "日本語の題名 2", overview: "日本語の概要 2", air_date: "2020-01-08" },
    { number: 3, name: "日本語の題名 3", overview: "日本語の概要 3", air_date: "2020-01-15" },
  ];
  seedShow({ tmdbId: "700101", tvdbId: "710101", episodes: tvdbEpisodes });

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/3/tv/700101/season/1") {
      assert.equal(url.searchParams.get("language"), "en-US");
      assert.equal(url.searchParams.get("api_key"), "tmdb-test-key");
      return tmdbResponse([
        { episode_number: 10, name: "English title 1", overview: "English overview 1", air_date: "2020-01-01" },
        { episode_number: 20, name: "", overview: "English overview 2", air_date: "2020-01-08" },
        { episode_number: 30, name: "Wrong episode", overview: "Wrong overview", air_date: "2020-01-20" },
      ]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  try {
    // The details page's live request carries a TVDB id only; the cached show
    // record must still provide the TMDB id needed for English season text.
    const result = await getTmdbSeason({ tvdbId: "710101", seasonNumber: 1 });
    assert.deepEqual(result.episodes.map(({ episode_number, name, overview }) => ({ episode_number, name, overview })), [
      { episode_number: 1, name: "English title 1", overview: "English overview 1" },
      { episode_number: 2, name: "日本語の題名 2", overview: "English overview 2" },
      { episode_number: 3, name: "日本語の題名 3", overview: "日本語の概要 3" },
    ]);
    assert.equal(result.episodes[0].runtime, 24, "TVDB runtime and numbering stay with the selected season source");
    assert.equal(requests.length, 1, "one cached TMDB season request covers all episode text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TMDB episode text remains preferred while missing English fields fall back to TVDB", async () => {
  seedShow({
    tmdbId: "700102",
    tvdbId: "710102",
    source: "tmdb",
    episodes: [
      { number: 1, name: "TVDB title 1", overview: "TVDB overview 1", air_date: "2020-02-01" },
      { number: 2, name: "TVDB title 2", overview: "TVDB overview 2", air_date: "2020-02-08" },
    ],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/3/tv/700102/season/1") {
      return tmdbResponse([
        { episode_number: 1, name: "English title 1", overview: "English overview 1", air_date: "2020-02-01" },
        { episode_number: 2, name: "", overview: "", air_date: "2020-02-08" },
      ]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  try {
    const result = await getTmdbSeason({ tmdbId: "700102", tvdbId: "710102", seasonNumber: 1 });
    assert.deepEqual(result.episodes.map(({ name, overview }) => ({ name, overview })), [
      { name: "English title 1", overview: "English overview 1" },
      { name: "TVDB title 2", overview: "TVDB overview 2" },
    ]);
    assert.equal(result.episodes[1].episode_number, 2, "TMDB numbering remains primary");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed English season lookup leaves TVDB episode metadata available", async () => {
  seedShow({
    tmdbId: "700103",
    tvdbId: "710103",
    episodes: [{ number: 1, name: "Fallback title", overview: "Fallback overview", air_date: "2020-03-01" }],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/3/tv/700103/season/1") return tmdbResponse([], 503);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  try {
    const result = await getTmdbSeason({ tmdbId: "700103", tvdbId: "710103", seasonNumber: 1 });
    assert.equal(result.episodes[0].name, "Fallback title");
    assert.equal(result.episodes[0].overview, "Fallback overview");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
