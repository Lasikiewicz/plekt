import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must point at a temp directory before any server module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-tvdb-english-overview-test-"));
process.env.DATA_DIR = dataDir;

const { db, parseJson, toJson } = await import("../server/src/db.js");
const { getTvdbEnglishSeriesOverview, shapeTvdbSeriesAsTmdb } = await import("../server/src/utils/tvdbGateway.js");
const { getTmdbDetails } = await import("../server/src/utils/tmdbGateway.js");

const seedSeries = db.prepare(
  `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET tvdb_id=excluded.tvdb_id, title=excluded.title,
     details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
);

function seriesDetails(id, overrides = {}) {
  return {
    id: Number(id),
    name: `Series ${id}`,
    overview: "Original-language synopsis",
    status: { name: "Ended" },
    seasons: [],
    episodes: [],
    remoteIds: [],
    ...overrides,
  };
}

function response(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
}

test("English TVDB overview is cached, force-refreshable, and preferred by the TV shape", async () => {
  const id = "79001";
  const seriesAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
  seedSeries.run(`series_${id}`, id, "Series 79001", toJson(seriesDetails(id)), seriesAt);

  const originalFetch = globalThis.fetch;
  let englishOverview = "English synopsis v1";
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/v4/login") return response({ token: "tvdb-test-token" });
    if (url.pathname === `/v4/series/${id}/translations/eng`) {
      return response({ language: "eng", overview: englishOverview });
    }
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    const first = await getTvdbEnglishSeriesOverview(id);
    assert.equal(first.overview, "English synopsis v1");
    assert.equal(first.status, "available");
    assert.equal(shapeTvdbSeriesAsTmdb(seriesDetails(id), { englishOverview: first.overview }).overview, "English synopsis v1");

    assert.equal((await getTvdbEnglishSeriesOverview(id)).overview, "English synopsis v1");
    assert.equal(paths.filter((item) => item === `/v4/series/${id}/translations/eng`).length, 1, "fresh translation cache avoids another request");

    englishOverview = "English synopsis v2";
    assert.equal((await getTvdbEnglishSeriesOverview(id, { force: true })).overview, "English synopsis v2");
    assert.equal(paths.filter((item) => item === `/v4/series/${id}/translations/eng`).length, 2, "force refresh replaces the cached synopsis");

    const saved = db.prepare("SELECT details, updated_at_ms FROM tvdb_metadata_cache WHERE id = ?").get(`series_${id}`);
    assert.equal(saved.updated_at_ms, seriesAt, "translation refresh does not extend the structural series TTL");
    assert.equal(parseJson(saved.details)._plektEnglishOverview.overview, "English synopsis v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missing English translation is negatively cached and leaves the original synopsis as fallback", async () => {
  const id = "79002";
  seedSeries.run(`series_${id}`, id, "Series 79002", toJson(seriesDetails(id)), Date.now());

  const originalFetch = globalThis.fetch;
  let translationRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v4/login") return response({ token: "tvdb-test-token" });
    if (url.pathname === `/v4/series/${id}/translations/eng`) {
      translationRequests += 1;
      return response({}, 404);
    }
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    assert.equal((await getTvdbEnglishSeriesOverview(id)).overview, "");
    assert.equal((await getTvdbEnglishSeriesOverview(id)).overview, "");
    assert.equal(translationRequests, 1, "a missing translation is cached instead of requested on every read");
    assert.equal(shapeTvdbSeriesAsTmdb(seriesDetails(id), { englishOverview: "" }).overview, "Original-language synopsis");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TV details use the English TVDB synopsis and stamp the cache language version", async () => {
  const id = "79004";
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === `/v4/series/${id}/extended`) {
      return response(seriesDetails(id, {
        name: "Integration Show",
        remoteIds: [{ sourceName: "TheMovieDB.com", id }],
      }));
    }
    if (url.pathname === `/v4/series/${id}/translations/eng`) {
      return response({ language: "eng", overview: "English integration synopsis" });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  try {
    const details = await getTmdbDetails({
      mediaType: "tv",
      tmdbId: id,
      title: "Integration Show",
      ids: { tvdbId: id },
      light: true,
    });
    assert.equal(details.overview, "English integration synopsis");
    assert.equal(details.tv_synopsis_language_version, 1);
    assert.equal(details.tv_synopsis_language_status, "available");
    assert.ok(paths.includes(`/v4/series/${id}/translations/eng`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a temporary TVDB failure keeps the last cached English synopsis usable", async () => {
  const id = "79003";
  const staleEnglish = {
    overview: "Previously cached English synopsis",
    status: "available",
    checkedAtMs: Date.now() - 31 * 24 * 60 * 60 * 1000,
  };
  seedSeries.run(`series_${id}`, id, "Series 79003", toJson(seriesDetails(id, { _plektEnglishOverview: staleEnglish })), Date.now());

  const originalFetch = globalThis.fetch;
  let translationRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v4/login") return response({ token: "tvdb-test-token" });
    if (url.pathname === `/v4/series/${id}/translations/eng`) {
      translationRequests += 1;
      return response({}, 503);
    }
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    const first = await getTvdbEnglishSeriesOverview(id);
    assert.equal(first.overview, "Previously cached English synopsis");
    assert.equal(first.status, "error");
    assert.equal((await getTvdbEnglishSeriesOverview(id)).overview, "Previously cached English synopsis");
    assert.equal(translationRequests, 1, "a short error backoff avoids repeated TVDB calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
