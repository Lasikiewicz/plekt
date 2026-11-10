import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-discover-recommendations-");
process.env.TMDB_API_KEY = "discover-test-key";

const { AUTH } = await import("../server/src/appConfig.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { handleDiscover, handleDiscoverDismiss } = await import("../server/src/routes/metadata.js");
const { filterExcludedRecommendations } = await import("../server/src/utils/recommendationExclusions.js");

function responseCapture() {
  const capture = { body: null, headers: {}, status: 200 };
  return {
    capture,
    status(code) { capture.status = code; return this; },
    set(headers) { Object.assign(capture.headers, headers); return this; },
    send(body) { capture.body = body; return this; },
  };
}

function request(query = {}) {
  return {
    method: "GET",
    query,
    cookies: {},
    get(name) {
      return String(name || "").toLowerCase() === "x-api-key" ? AUTH.apiKey : "";
    },
  };
}

function dismissRequest(body = {}) {
  return {
    ...request(),
    method: "POST",
    body,
  };
}

function tmdbResponse(body) {
  return Response.json(body);
}

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

test("Discover filters watched titles and adds a personalized recommendation rail", async () => {
  repo.insertWatchRecordSync({
    title: "Watched Movie",
    media_type: "movie",
    tmdb_id: "100",
    watched_at: daysAgo(30),
    source: "trakt_import",
  });
  repo.insertWatchRecordSync({
    title: "Watched Show - S01E01",
    show_title: "Watched Show",
    media_type: "episode",
    season: 1,
    episode: 1,
    tmdb_id: "200",
    watched_at: daysAgo(20),
    source: "trakt_import",
  });
  for (let index = 0; index < 7; index += 1) {
    repo.insertWatchRecordSync({
      title: `Older In-Window Movie ${index}`,
      media_type: "movie",
      tmdb_id: String(501 + index),
      watched_at: daysAgo(40 + index * 10),
      source: "trakt_import",
    });
  }
  repo.insertWatchRecordSync({
    title: "Historical Seed",
    media_type: "movie",
    tmdb_id: "300",
    watched_at: daysAgo(200),
    source: "trakt_import",
  });
  repo.insertWatchRecordSync({
    title: "Outside History Window",
    media_type: "movie",
    tmdb_id: "900",
    watched_at: daysAgo(400),
    source: "trakt_import",
  });

  const previousFetch = globalThis.fetch;
  const fetchPaths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/3\//, "");
    fetchPaths.push(path);
    const feeds = {
      "trending/movie/week": [{ id: 100, title: "Watched Movie", poster_path: "/watched.jpg" }, { id: 101, title: "Unwatched Movie", poster_path: "/unwatched.jpg" }],
      "trending/tv/week": [{ id: 200, name: "Watched Show", poster_path: "/watched-show.jpg" }, { id: 201, name: "Unwatched Show", poster_path: "/unwatched-show.jpg" }],
      "movie/now_playing": [{ id: 999, title: "Watched Movie", poster_path: "/same-title.jpg" }],
      "movie/100/recommendations": [{ id: 100, title: "Watched Movie", genre_ids: [18], release_date: "2025-01-01", poster_path: "/watched-movie.jpg" }, { id: 301, title: "Recommended Movie", genre_ids: [18], release_date: "2024-01-01", poster_path: "/recommended-movie.jpg", popularity: 4 }, { id: 303, title: "Old Movie", genre_ids: [18], release_date: "2018-01-01", poster_path: "/old-movie.jpg", popularity: 100 }, { id: 304, title: "Posterless Movie", genre_ids: [18], release_date: "2024-01-01", popularity: 200 }],
      "tv/200/recommendations": [{ id: 200, name: "Watched Show", genre_ids: [18], first_air_date: "2025-01-01", poster_path: "/watched-show.jpg" }, { id: 401, name: "Recommended Show", genre_ids: [18], first_air_date: "2024-01-01", poster_path: "/recommended-show.jpg", popularity: 8 }],
    };
    const results = feeds[path] || (path === "movie/300/recommendations"
      ? [{ id: 302, title: "Historical Recommendation", genre_ids: [18], release_date: "2023-01-01", poster_path: "/historical-recommendation.jpg", popularity: 100 }]
      : /^movie\/\d+\/recommendations$/.test(path) ? [] : null);
    if (!results) throw new Error(`Unexpected TMDB request: ${path}`);
    return tmdbResponse({ page: 1, total_pages: 1, results });
  };

  try {
    const response = responseCapture();
    await handleDiscover(request({ mediaType: "all" }), response);
    assert.equal(response.capture.status, 200);
    const body = JSON.parse(response.capture.body);

    assert.deepEqual(body.feeds.trending_movies.results.map((item) => item.id), [101]);
    assert.deepEqual(body.feeds.trending_shows.results.map((item) => item.id), [201]);
    assert.deepEqual(body.feeds.new_movies.results, []);
    assert.equal(Object.hasOwn(body.feeds, "new_shows"), false);
    // Recent watched titles outrank a much older seed, even when the older
    // candidate has a higher TMDB popularity score.
    assert.deepEqual(body.feeds.recommended.results.map((item) => item.id), [401, 301, 302]);
    assert.ok(!body.feeds.recommended.results.some((item) => [100, 200].includes(item.id)));
    assert.ok(!body.feeds.recommended.results.some((item) => item.id === 303));
    assert.ok(!body.feeds.recommended.results.some((item) => item.id === 304));
    assert.ok(fetchPaths.includes("movie/300/recommendations"));
    assert.ok(!fetchPaths.includes("movie/900/recommendations"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Discover exclusions persist and filter only matching recommendation identities", async () => {
  const response = responseCapture();
  await handleDiscoverDismiss(dismissRequest({ media_type: "movie", tmdb_id: "301", title: "Recommended Movie" }), response);
  assert.equal(response.capture.status, 200);
  assert.equal(JSON.parse(response.capture.body).exclusion.tmdb_id, "301");

  const filtered = filterExcludedRecommendations({
    media_type: "all",
    results: [
      { id: 301, title: "Recommended Movie", media_type: "movie" },
      { id: 301, name: "Recommended Show", media_type: "tv" },
      { id: 401, name: "Other Show", media_type: "tv" },
    ],
  });
  assert.deepEqual(filtered.results.map((item) => `${item.media_type}:${item.id}`), ["tv:301", "tv:401"]);

  const invalid = responseCapture();
  await handleDiscoverDismiss(dismissRequest({ media_type: "movie", tmdb_id: "not-a-tmdb-id" }), invalid);
  assert.equal(invalid.capture.status, 400);
});
