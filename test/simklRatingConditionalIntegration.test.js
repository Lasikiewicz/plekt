import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import express from "express";
import http from "node:http";
import { once } from "node:events";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-rating-conditional-");
const source = (code) => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../utils/auth.js" && context.parentURL?.endsWith("/routes/ratingSync.js")) {
    return source("export const requireAdmin = async () => true;");
  }
  if (specifier === "../outbound.js" && context.parentURL?.endsWith("/trackers/simklTransport.js")) {
    return source("export const fetchWithTimeout = (url, options) => globalThis.fetch(url, options); export const createUpstreamTimeoutError = () => new Error('fixture timeout');");
  }
  return next(specifier, context);
} });
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleRatingSync } = await import("../server/src/routes/ratingSync.js");
const { syncSimklObservations } = await import("../server/src/utils/trackers/simklSync.js");
const { simklObservationCursor } = await import("../server/src/utils/trackers/simklObservations.js");
const { storedSimklRatingSnapshot } = await import("../server/src/utils/trackers/simklRatings.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");

const t0 = "2026-10-20T12:00:00Z";
const t1 = "2026-10-21T12:00:00Z";
const t2 = "2026-10-22T12:00:00Z";
const t3 = "2026-10-23T12:00:00Z";
const dateFrom = "2026-10-01T12:00:00Z";
const movie = { title: "Conditional Movie", media_type: "movie", ids: { tmdb: 101, simkl: 901 } };
const show = { title: "Conditional Show", media_type: "show", ids: { tvdb: 202, simkl: 902 } };
let connection;
let activities;
let ratingRows;
let calls;
let httpServer;
const originalFetch = globalThis.fetch;

test.before(() => {
  connection = repo.saveTrackerConnection({ provider: "simkl", clientId: "offline-test", remoteUserId: "offline-account", accessToken: "fixture-only", refreshToken: "fixture-only", accessTokenExpiresAt: Date.now() + 3_600_000 });
  connection = repo.getTrackerConnection("simkl", { includeCredentials: true });
});

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.post("/api/rating-sync/run", (req, res) => {
    Promise.resolve(handleRatingSync(req, res)).catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: error.message });
    });
  });
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
});

test.beforeEach(() => {
  activities = { all: t0 };
  ratingRows = {};
  calls = [];
  simklTransport.resetForTests();
  globalThis.fetch = async (input) => {
    try {
      const url = new URL(input);
      assert.equal(url.origin, "https://api.simkl.com", "only mocked Simkl API requests are allowed");
      calls.push({ path: url.pathname, dateFrom: url.searchParams.get("date_from") });
      if (url.pathname === "/sync/activities") return withQuota(Response.json(activities));
      if (url.pathname === "/sync/all-items" || url.pathname.startsWith("/sync/all-items/")) return withQuota(Response.json({}));
      if (url.pathname === "/sync/ratings") return withQuota(Response.json(ratingRows));
      assert.fail(`Unexpected Simkl request: ${url.pathname}`);
    } catch (error) {
      globalThis.simklRatingConditionalFetchError = { input: String(input), message: error.message };
      throw error;
    }
  };
});

function withQuota(response) {
  response.headers.set("x-ratelimit-remaining", "400");
  response.headers.set("x-ratelimit-limit", "500");
  return response;
}

test.after(() => {
  globalThis.fetch = originalFetch;
  httpServer?.close();
  db.close();
});

test("conditional ratings integration supplements only newer activity, stores explicit clears, and fails closed", async () => {
  await syncSimklObservations({ trigger: "user" });
  assert.equal(simklObservationCursor(connection), t0);
  assert.deepEqual(calls.map(({ path }) => path), ["/sync/activities", "/sync/all-items/movies", "/sync/all-items/shows", "/sync/all-items/anime"]);

  calls = [];
  activities = { all: t1, movies: { rated_at: t1 } };
  ratingRows = {
    movies: [{ status: "completed", last_watched_at: dateFrom, user_rating: 7, movie }],
    shows: [{ show, status: "watching", user_rating: 8 }],
  };
  await syncSimklObservations({ trigger: "user" });
  assert.deepEqual(calls.map(({ path }) => path), ["/sync/activities", "/sync/all-items", "/sync/ratings"]);
  assert.ok(calls.every(({ dateFrom: value }) => value == null || value === t0));
  assert.equal(simklObservationCursor(connection), t1);
  assert.deepEqual(storedSimklRatingSnapshot(connection).map(({ media, rating }) => [media.title, rating]).sort(), [
    ["Conditional Movie", 7], ["Conditional Show", 8],
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0, "rating-only rows must not create watched events");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations WHERE kind='watched'").get().n, 0, "ratings feed must not create watched observations");

  calls = [];
  await syncSimklObservations({ trigger: "user" });
  assert.deepEqual(calls.map(({ path }) => path), ["/sync/activities"], "unchanged cursor skips both library and ratings deltas");
  assert.equal(simklObservationCursor(connection), t1);

  calls = [];
  activities = { all: t2, movies: { rated_at: t2 } };
  ratingRows = { movies: [{ status: "completed", last_watched_at: dateFrom, user_rating: null, movie }] };
  await syncSimklObservations({ trigger: "user" });
  assert.equal(simklObservationCursor(connection), t2);
  assert.deepEqual(storedSimklRatingSnapshot(connection).map(({ media, rating }) => [media.title, rating]), [["Conditional Show", 8]], "explicit null clears the movie while an omitted show row does not clear it");
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);

  calls = [];
  activities = { all: t3, movies: { rated_at: t3 } };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.simkl.com");
    calls.push(url.pathname);
    if (url.pathname === "/sync/activities") return Response.json(activities);
    if (url.pathname === "/sync/all-items") return Response.json({});
    if (url.pathname === "/sync/ratings") return Response.json({ error: "fixture failure" }, { status: 503 });
    assert.fail(`Unexpected Simkl request: ${url.pathname}`);
  };
  await assert.rejects(syncSimklObservations({ trigger: "user" }));
  assert.deepEqual(calls, ["/sync/activities", "/sync/all-items", "/sync/ratings"]);
  assert.equal(simklObservationCursor(connection), t2, "failed supplement cannot advance the durable cursor");
  assert.deepEqual(storedSimklRatingSnapshot(connection).map(({ media, rating }) => [media.title, rating]), [["Conditional Show", 8]], "failed supplement cannot partially change ratings");
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations WHERE kind='watched'").get().n, 0);
});

test("real HTTP Check now route dispatches conditional Simkl ratings and persists the snapshot", async () => {
  await saveMediaConfig({ ratingSync: { enabled: true, providers: { simkl: "receive" } } });
  activities = { all: "2026-10-24T12:00:00Z", movies: { rated_at: "2026-10-24T12:00:00Z" } };
  ratingRows = { movies: [{ status: "completed", last_watched_at: dateFrom, user_rating: 7, movie }] };
  const { status, payload } = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ providers: ["simkl"] });
    const request = http.request({
      host: "127.0.0.1",
      port: httpServer.address().port,
      path: "/api/rating-sync/run",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, payload: JSON.parse(responseBody) }));
    });
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(calls.slice(0, 3).map(({ path }) => path), ["/sync/activities", "/sync/all-items", "/sync/ratings"]);
  assert.ok(calls.slice(3).every(({ path }) => path === "/sync/activities" || path.startsWith("/sync/all-items/")), "post-check dropped-title scan stays within mocked read endpoints");
  assert.equal(simklObservationCursor(connection), "2026-10-24T12:00:00Z");
  assert.deepEqual(storedSimklRatingSnapshot(connection).map(({ media, rating }) => [media.title, rating]).sort(), [
    ["Conditional Movie", 7], ["Conditional Show", 8],
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
});
