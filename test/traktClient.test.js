import test from "node:test";
import assert from "node:assert/strict";
import { fetchTraktPersonalRatingSnapshot, fetchTraktWatchedSnapshot, pollTraktDeviceAuth, setTraktPersonalRating, setTraktWatchHistoryBatch, setTraktWatchState, startTraktDeviceAuth, trackerMediaKey, trackerMediaMatches } from "../server/src/utils/traktClient.js";

test("Trakt device authorization uses the API device endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify(requests.length === 1
      ? { device_code: "device", user_code: "CODE", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }
      : { access_token: "access", refresh_token: "refresh", expires_in: 604800 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await startTraktDeviceAuth("client");
    await pollTraktDeviceAuth({ deviceCode: "device", clientId: "client", clientSecret: "secret" });
    assert.equal(requests[0].url, "https://api.trakt.tv/oauth/device/code");
    assert.equal(requests[1].url, "https://api.trakt.tv/oauth/device/token");
    assert.match(requests[0].headers["user-agent"], /^Plekt/);
    assert.deepEqual(requests[1].body, { code: "device", client_id: "client", client_secret: "secret" });
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots normalize movies and episodes onto stable series coordinates", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify(String(url).includes("/movies") ? [{
      last_watched_at: "2026-08-15T10:00:00.000Z", movie: { title: "Arrival", year: 2016, ids: { trakt: 1, imdb: "tt2543164", tmdb: 329865 } },
    }] : [{
      show: { title: "Reacher", year: 2022, ids: { trakt: 2, tvdb: 366924, tmdb: 108978 } },
      seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: "2026-08-16T10:00:00.000Z", ids: { trakt: 3, tvdb: 900001 } }] }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const snapshot = await fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" });
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[1].mediaKey, "episode:tmdb:108978:s1e1");
    assert.deepEqual(snapshot[1].media.ids, { trakt: 2, tvdb: 366924, tmdb: 108978 });
    assert.deepEqual(snapshot[1].media.trackerEpisodeIds, { trakt: 3, tvdb: 900001 });
    assert.ok(requestedUrls.some((url) => url.includes("/shows?") && url.includes("extended=progress")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots follow every pagination page", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    const isMovies = value.includes("/movies");
    const page = Number(new URL(value).searchParams.get("page"));
    const rows = isMovies
      ? [{ last_watched_at: "2026-08-15T10:00:00.000Z", movie: { title: `Movie ${page}`, ids: { trakt: page } } }]
      : [{ show: { title: `Show ${page}`, ids: { trakt: 100 + page } }, seasons: [{ number: 1, episodes: [{ number: page, ids: { trakt: 200 + page } }] }] }];
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json", "x-pagination-page": String(page), "x-pagination-page-count": "2" },
    });
  };
  try {
    const snapshot = await fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" });
    assert.equal(snapshot.length, 4);
    assert.equal(urls.length, 4);
    assert.ok(urls.every((url) => url.includes("limit=250")));
    assert.ok(urls.some((url) => url.includes("page=2")));
    assert.ok(urls.filter((url) => url.includes("/shows?")).every((url) => url.includes("extended=progress")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched snapshots reject show responses without season progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("/movies") ? [] : [{
    show: { title: "Peaky Blinders", ids: { trakt: 60158, tvdb: 270915 } },
  }]), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      fetchTraktWatchedSnapshot({ clientId: "client", accessToken: "token" }),
      /did not include season progress/,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt personal rating snapshots use the authenticated me endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    const type = new URL(value).pathname.split("/").pop();
    const body = type === "episodes"
      ? [{
          rating: 9,
          rated_at: "2026-09-02T18:00:00.000Z",
          show: { title: "Ted Lasso", year: 2020, ids: { trakt: 97546, tmdb: 97546, tvdb: 383203, imdb: "tt10986410" } },
          episode: { season: 4, number: 2, title: "Curiouser and Curiouser!", ids: { trakt: 14143103, tmdb: 7203306, tvdb: 11767182, imdb: "tt38494462" } },
        }]
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const snapshot = await fetchTraktPersonalRatingSnapshot({ clientId: "client", accessToken: "token", remoteUsername: "wrong-user" });
    assert.ok(urls.length > 0);
    assert.ok(urls.every((url) => url.includes("/users/me/ratings/")));
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].media.episode_trakt_id, 14143103);
    assert.equal(snapshot[0].rating, 9);
  } finally { globalThis.fetch = originalFetch; }
});

test("tracker outbound matching bridges a stale episode id by exact show and coordinates", () => {
  const stale = {
    type: "episode",
    title: "Reacher - S03E01",
    showTitle: "Reacher",
    season: 3,
    episode: 1,
    ids: { tmdb: "old-series-id" },
  };
  const corrected = {
    type: "episode",
    title: "Reacher - S03E01",
    showTitle: "Reacher",
    season: 3,
    episode: 1,
    ids: { tmdb: "new-series-id" },
  };

  assert.equal(trackerMediaMatches(stale, corrected), true);
  assert.equal(trackerMediaMatches(stale, { ...corrected, episode: 2 }), false);
  assert.equal(trackerMediaMatches(stale, { ...corrected, showTitle: "Reachers" }), false);
});

test("Trakt episode writes use show IDs plus season and episode coordinates", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { episodes: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const media = { type: "episode", season: 1, episode: 1, ids: { tvdb: 366924, tmdb: 108978 } };
    await setTraktWatchState({ clientId: "client", accessToken: "token" }, media, "watched");
    assert.equal(request.url, "https://api.trakt.tv/sync/history");
    assert.equal(request.body.shows[0].ids.tvdb, 366924);
    assert.equal(request.body.shows[0].seasons[0].episodes[0].number, 1);
    assert.equal(trackerMediaKey(media), "episode:tmdb:108978:s1e1");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt personal episode ratings resolve a leaf id when only show identity is available", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    requests.push({ url: value, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (value.includes("/search/tmdb/97546")) {
      return new Response(JSON.stringify([{ show: { ids: { trakt: 12345 } } }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("/shows/12345/seasons/4/episodes/2")) {
      return new Response(JSON.stringify({ ids: { trakt: 67890, tvdb: 11767182, imdb: "tt38494462" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ added: { episodes: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const media = {
      type: "episode",
      title: "Curiouser and Curiouser!",
      show_title: "Ted Lasso",
      tmdb_id: 97546,
      season: 4,
      episode: 2,
    };
    await setTraktPersonalRating({ clientId: "client", accessToken: "token" }, media, 9);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "GET");
    assert.equal(requests[2].url, "https://api.trakt.tv/sync/ratings");
    assert.deepEqual(requests[2].body, { episodes: [{ ids: { trakt: 67890, tvdb: 11767182, imdb: "tt38494462" }, rating: 9 }] });
    assert.equal(media.episode_tvdb_id, "11767182");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt personal episode ratings retry with Trakt’s canonical id after an external id is not found", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: value, method: options.method || "GET", body });
    if (value.includes("/sync/ratings") && !value.includes("/sync/ratings/remove")) {
      return requests.filter((request) => request.url.includes("/sync/ratings") && request.method === "POST").length === 1
        ? new Response(JSON.stringify({ added: {}, not_found: { episodes: [{ ids: { tvdb: "bad-tvdb" } }] } }), { status: 201, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ added: { episodes: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (value.includes("/search/tmdb/97546")) {
      return new Response(JSON.stringify([{ show: { ids: { trakt: 12345 } } }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("/shows/12345/seasons/4/episodes/2")) {
      return new Response(JSON.stringify({ ids: { trakt: 67890, tvdb: 11767182 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await setTraktPersonalRating({ clientId: "client", accessToken: "token" }, {
      type: "episode",
      title: "Curiouser and Curiouser!",
      show_title: "Ted Lasso",
      show_tmdb_id: 97546,
      episode_tvdb_id: "bad-tvdb",
      season: 4,
      episode: 2,
    }, 9);
    const posts = requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.episodes[0].ids.tvdb, "bad-tvdb");
    assert.equal(posts[1].body.episodes[0].ids.trakt, "67890");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt watched writes send an explicit historical watched_at rather than the current time", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { episodes: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const media = { type: "episode", season: 5, episode: 6, ids: { tmdb: 38772847 }, watched_at: "2026-08-12T12:00:00.000Z" };
    await setTraktWatchState({ clientId: "client", accessToken: "token" }, media, "watched");
    assert.equal(request.body.shows[0].seasons[0].episodes[0].watched_at, "2026-08-12T12:00:00.000Z");
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt restore batches preserve dates for movies and repeated episodes", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ added: { movies: 1, episodes: 2 } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    await setTraktWatchHistoryBatch({ clientId: "client", accessToken: "token" }, [
      { type: "movie", ids: { tmdb: 329865 }, source: "restore_replay", watched_at: "2020-01-02T03:04:05.000Z" },
      { type: "episode", ids: { tmdb: 108978 }, season: 1, episode: 2, source: "restore_replay", watched_at: "2021-02-03T04:05:06.000Z" },
      { type: "episode", ids: { tmdb: 108978 }, season: 1, episode: 3, source: "restore_replay", watched_at: "2022-03-04T05:06:07.000Z" },
    ], "watched");
    assert.equal(request.url, "https://api.trakt.tv/sync/history");
    assert.equal(request.body.movies[0].watched_at, "2020-01-02T03:04:05.000Z");
    assert.equal(request.body.shows[0].seasons[0].number, 1);
    assert.deepEqual(request.body.shows[0].seasons[0].episodes.map((item) => item.watched_at), [
      "2021-02-03T04:05:06.000Z",
      "2022-03-04T05:06:07.000Z",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt restore writes fail closed when a historical date is missing", async () => {
  assert.throws(
    () => setTraktWatchHistoryBatch({ clientId: "client", accessToken: "token" }, [{ type: "movie", ids: { tmdb: 1 }, source: "restore_replay" }], "watched"),
    /requires a valid watched_at timestamp/,
  );
});
