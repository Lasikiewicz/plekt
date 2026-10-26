import test from "node:test";
import assert from "node:assert/strict";
import * as legacy from "../server/src/utils/traktClient.js";
import * as extracted from "../server/src/utils/trackers/traktClient.js";
import { makeTempDataDir } from "./helpers.js";
import { assertTrackerOperation } from "../server/src/utils/trackers/contract.js";
import { traktDispatchErrorDetail } from "../server/src/utils/trackers/trakt.js";

// The registry reaches db.js through the Simkl adapter: set the data dir first.
makeTempDataDir("plekt-tracker-adapter-");
const { getTrackerAdapter, listTrackerCapabilities, runTrackerOperation, trackerSupportsTrigger } = await import("../server/src/utils/trackers/registry.js");

const adapter = getTrackerAdapter("trakt");
function context(operation, mediaType = "movie") {
  return { mediaType, trigger: "user", satisfiedPreconditions: adapter.capabilities[operation].preconditions };
}

test("adapter extraction preserves every legacy client export and function identity", () => {
  assert.deepEqual(Object.keys(legacy), Object.keys(extracted));
  for (const name of Object.keys(legacy)) assert.equal(legacy[name], extracted[name]);
  assert.equal(adapter.auth.refreshToken, legacy.refreshTraktToken);
});

test("registry enumerates immutable Trakt and Simkl capabilities; only Trakt polls on the scheduler", () => {
  const inventory = listTrackerCapabilities();
  assert.deepEqual(inventory.map(({ id, sources }) => ({ id, sources })), [
    { id: "trakt", sources: ["trakt", "trakt_import"] }, { id: "simkl", sources: ["simkl", "simkl_import"] },
  ]);
  for (const entry of JSON.parse(JSON.stringify(inventory))) assert.equal(entry.capabilities.watchlist.supported, false, entry.id);
  assert.equal(trackerSupportsTrigger("trakt", "scheduled"), true);
  assert.equal(trackerSupportsTrigger("simkl", "scheduled"), false);
  for (const trigger of ["event", "user"]) assert.equal(trackerSupportsTrigger("simkl", trigger), true, trigger);
  assert.equal(trackerSupportsTrigger("letterboxd", "user"), false);
  assert.throws(() => inventory[0].sources.push("simkl"), TypeError);
  assert.throws(() => { inventory[0].capabilities.watchedWrite.supported = false; }, TypeError);
  assert.throws(() => { inventory[1].capabilities.watchedSnapshot.triggers.push("scheduled"); }, TypeError);
  assert.throws(() => getTrackerAdapter("letterboxd"), { code: "TRACKER_UNSUPPORTED_PROVIDER" });
  for (const source of ["trakt", "trakt_import", "TRAKT", "legacy_trakt_source"]) assert.equal(adapter.ownsSource(source), true);
  for (const source of ["manual", "plex", "simkl", undefined]) assert.equal(adapter.ownsSource(source), false);
});

test("contract rejects unsupported operations, media, triggers and missing preconditions before HTTP", () => {
  for (const operation of ["watchlist", "resumeProgress", "existingDateMutation", "unknown", "toString"]) {
    assert.throws(() => runTrackerOperation("trakt", operation, { mediaType: "movie", trigger: "user" }), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  }
  assert.throws(() => assertTrackerOperation(adapter, "watchedWrite", context("watchedWrite", "show")), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  assert.throws(() => assertTrackerOperation(adapter, "watchedWrite", { ...context("watchedWrite"), trigger: "unknown" }), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  assert.throws(() => assertTrackerOperation(adapter, "datedHistoryWrite", { mediaType: "movie", trigger: "user" }), { code: "TRACKER_PRECONDITION_REQUIRED" });
  assert.equal(assertTrackerOperation(adapter, "repeatHistoryWrite", context("repeatHistoryWrite")).supported, true);
  assert.equal(assertTrackerOperation(adapter, "ratingSet", context("ratingSet", "episode")).supported, true);
});

test("adapter watched snapshot normalizes all pages through the common contract", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    const page = Number(parsed.searchParams.get("page"));
    const movies = parsed.pathname.endsWith("movies");
    const rows = movies
      ? [{ last_watched_at: "2026-08-15T10:00:00.000Z", movie: { title: `Movie ${page}`, ids: { tmdb: page } } }]
      : [{ show: { title: `Show ${page}`, ids: { tvdb: page } }, seasons: [{ number: 1, episodes: [{ number: page, last_watched_at: "2026-08-15T10:00:00.000Z" }] }] }];
    return new Response(JSON.stringify(rows), { headers: { "x-pagination-page-count": "2", "x-pagination-page": String(page) } });
  };
  try {
    const snapshot = await runTrackerOperation("trakt", "watchedSnapshot", context("watchedSnapshot"), { clientId: "client", accessToken: "token" });
    assert.equal(snapshot.length, 4);
    assert.equal(urls.length, 4);
    assert.deepEqual(snapshot.map((row) => row.mediaKey), ["movie:tmdb:1", "movie:tmdb:2", "episode:tvdb:1:s1e1", "episode:tvdb:2:s1e2"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("adapter errors preserve auth and upstream payloads and classify without rewriting them", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, classification] of [[401, "reauth_required"], [429, "rate_limited"], [503, "transient"], [404, "not_found"], [400, "failed"]]) {
      const body = { error: "provider_error", error_description: "Provider explanation" };
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { "retry-after": "2" } });
      await assert.rejects(adapter.auth.getUser({ clientId: "client", accessToken: "token" }), (error) => {
        assert.equal(error.message, body.error_description);
        assert.equal(error.status, status);
        assert.equal(error.retryAfter, 2);
        assert.deepEqual(error.body, body);
        assert.equal(adapter.classifyError(error), classification);
        assert.equal(traktDispatchErrorDetail(error), [429, 503].includes(status) ? `Provider explanation (HTTP ${status})` : "Provider explanation");
        return true;
      });
    }
    assert.equal(adapter.classifyError({ code: "UPSTREAM_TIMEOUT" }), "transient");
    assert.equal(adapter.classifyError({ code: "not_found" }), "not_found");
  } finally { globalThis.fetch = originalFetch; }
});

test("common writes retain dated play payloads and provider results without authorizing a replay", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const response = { added: { movies: 1 }, not_found: { movies: [] } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify(response));
  };
  try {
    const connection = { clientId: "client", accessToken: "token" };
    const media = { type: "movie", ids: { tmdb: 123 }, watched_at: "2020-01-02T03:04:05.000Z" };
    assert.deepEqual(await runTrackerOperation("trakt", "watchedWrite", context("watchedWrite"), connection, media), response);
    assert.deepEqual(await runTrackerOperation("trakt", "datedHistoryWrite", context("datedHistoryWrite"), connection, [media]), response);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ url }) => url.endsWith("/sync/history")));
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests[0].body.movies[0].watched_at, media.watched_at);
    // Inventory reads and rejected operations cannot issue remove/add work.
    listTrackerCapabilities();
    assert.throws(() => runTrackerOperation("trakt", "existingDateMutation", context("existingDateMutation"), connection, media), { code: "TRACKER_UNSUPPORTED_OPERATION" });
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("adapter play history retains repeat IDs and dates across complete pagination", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    const page = Number(parsed.searchParams.get("page"));
    const movies = parsed.pathname.endsWith("movies");
    const watched_at = `2020-01-0${page}T03:04:05.000Z`;
    const row = movies
      ? { id: page, watched_at, movie: { title: "Repeated movie", ids: { tmdb: 123 } } }
      : { id: page + 100, watched_at, show: { title: "Repeated episode", ids: { tvdb: 456 } }, episode: { season: 1, number: 2 } };
    return new Response(JSON.stringify([row]), { headers: { "x-pagination-page-count": "2", "x-pagination-page": String(page) } });
  };
  try {
    const startAt = "2019-01-01T00:00:00.000Z";
    const history = await runTrackerOperation("trakt", "playHistory", context("playHistory"), { clientId: "client", accessToken: "token" }, { startAt });
    assert.deepEqual(history.map(({ historyId }) => historyId), ["1", "2", "101", "102"]);
    assert.deepEqual(history.map(({ mediaKey }) => mediaKey), ["movie:tmdb:123", "movie:tmdb:123", "episode:tvdb:456:s1e2", "episode:tvdb:456:s1e2"]);
    assert.equal(history[1].watchedAt, Date.parse("2020-01-02T03:04:05.000Z"));
    assert.equal(urls.length, 4);
    assert.ok(urls.every((url) => url.searchParams.get("start_at") === startAt));
  } finally { globalThis.fetch = originalFetch; }
});
