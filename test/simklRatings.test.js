import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-ratings-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const inbox = await import("../server/src/utils/trackers/simklObservations.js");
const ratings = await import("../server/src/utils/trackers/simklRatings.js");
const { normalizeSimklRows } = await import("../server/src/utils/trackers/simklClient.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");
const sync = await import("../server/src/utils/personalRatingSync.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const originalFetch = globalThis.fetch;
const date = "2026-10-01T12:00:00Z";
const media = { media_type: "movie", title: "Rating fixture", tmdb_id: "1", simkl_id: "9" };
let connection, calls;
test.beforeEach(() => {
  for (const table of ["tracker_observations", "tracker_observation_cursors", "tracker_connections", "personal_ratings", "personal_rating_sources", "personal_rating_sync_queue", "personal_rating_sync_runs"]) db.prepare(`DELETE FROM ${table}`).run();
  connection = repo.saveTrackerConnection({ provider: "simkl", clientId: "test", remoteUserId: "account", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
  connection = repo.getTrackerConnection("simkl", { includeCredentials: true });
  calls = [];
  simklTransport.resetForTests();
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});
test.after(() => { globalThis.fetch = originalFetch; db.close(); });

function persist(partitions, cursor = "2026-10-22T12:00:00Z", expectedCursor = null) {
  inbox.persistSimklObservations(connection, { ...normalizeSimklRows(partitions), cursor, activities: { all: cursor }, complete: !expectedCursor, absenceReconciliation: false }, { expectedCursor });
}
const partitions = (rating = 8) => ({ movies: [{ status: "completed", last_watched_at: date, user_rating: rating, movie: { title: media.title, ids: { tmdb: 1, simkl: 9 } } }], shows: [], anime: [] });

test("stored snapshots require this account's baseline and only explicit null clears a known rating", () => {
  assert.throws(() => ratings.storedSimklRatingSnapshot(connection), /first library check/);
  persist(partitions());
  assert.equal(ratings.storedSimklRatingSnapshot(connection)[0].rating, 8);
  const missing = partitions(); delete missing.movies[0].user_rating;
  persist(missing, "2026-10-22T12:01:00Z", "2026-10-22T12:00:00Z");
  assert.equal(ratings.storedSimklRatingSnapshot(connection)[0].rating, 8);
  persist(partitions(null), "2026-10-22T12:02:00Z", "2026-10-22T12:01:00Z");
  assert.deepEqual(ratings.storedSimklRatingSnapshot(connection), []);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations WHERE kind='rating'").get().n, 1);
  assert.throws(() => ratings.storedSimklRatingSnapshot({ ...connection, remoteUserId: "other" }), /not connected/);
});

test("hold rules require dated completed movies or listed shows and reject anime and episodes", () => {
  const reason = ratings.simklRatingHoldReason;
  assert.equal(reason("movie", { list: "completed", lastWatchedAt: date }), "");
  for (const title of [{ list: "plantowatch", lastWatchedAt: date }, { list: "completed" }, { list: "completed", lastWatchedAt: "1970-01-01T00:00:01Z" }]) assert.match(reason("movie", title), /Held/);
  for (const list of ["watching", "plantowatch", "hold", "completed", "dropped"]) assert.equal(reason("tv", { list }), "");
  assert.match(reason("tv", { list: null }), /Held/);
  assert.match(reason("tv", { list: "completed", anime: true }), /anime/);
  assert.match(reason("movie", { list: "completed", lastWatchedAt: date }, { anime: true }), /anime/);
  assert.match(reason("episode", { list: "completed" }), /episode/);
});

function transport({ before = { list: "completed", last_watched_at: date }, after = before, result = {}, failReadback = false } = {}) {
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(options.body) });
    if (path === "/sync/watched") {
      if (reads++ && failReadback) return Response.json({}, { status: 500 });
      return Response.json([reads === 1 ? before : after]);
    }
    assert.ok(["/sync/ratings", "/sync/ratings/remove"].includes(path));
    return Response.json(result);
  };
}

for (const clear of [false, true]) test(`safe rating ${clear ? "clear" : "write"} sends once and checks list/date afterwards`, async () => {
  transport();
  const result = clear ? await ratings.clearSimklPersonalRating(connection, media) : await ratings.setSimklPersonalRating(connection, media, 7);
  assert.deepEqual(result, { status: "succeeded" });
  assert.deepEqual(calls.map(x => x.path), ["/sync/watched", clear ? "/sync/ratings/remove" : "/sync/ratings", "/sync/watched"]);
  assert.deepEqual(calls[1].body, { movies: [{ ids: { simkl: 9, tmdb: 1 }, ...(clear ? {} : { rating: 7 }) }] });
});

test("unsafe titles are held without sending a rating; missing identities and lookup misses are not found", async () => {
  assert.deepEqual(await ratings.setSimklPersonalRating(connection, { media_type: "movie" }, 7), { status: "not_found" });
  transport({ before: { result: "not_found" } });
  assert.deepEqual(await ratings.setSimklPersonalRating(connection, media, 7), { status: "not_found" });
  transport({ before: { list: "plantowatch" } });
  assert.equal((await ratings.setSimklPersonalRating(connection, media, 7)).status, "held");
  assert.ok(calls.every(x => x.path === "/sync/watched"));
});

test("known anime stays held when a canonical local write has only TMDB identity", async () => {
  persist({ movies: [], shows: [], anime: [{ status: "plantowatch", user_rating: 8, watched_episodes_count: 0, show: { title: "Anime", ids: { tmdb: 22, simkl: 99 } } }] });
  transport({ before: { list: "plantowatch" } });
  const result = await ratings.setSimklPersonalRating(connection, { media_type: "tv", tmdb_id: "22" }, 9);
  assert.equal(result.status, "held");
  assert.match(result.reason, /anime/);
  assert.equal(calls.length, 1);
});

test("write not_found and changed or failed readback are surfaced without retrying the send", async () => {
  transport({ result: { not_found: { movies: [{ ids: { simkl: 9 } }] } } });
  assert.deepEqual(await ratings.setSimklPersonalRating(connection, media, 7), { status: "not_found" });
  for (const options of [{ after: { list: "dropped", last_watched_at: date } }, { after: { list: "completed", last_watched_at: "2026-10-02T12:00:00Z" } }, { failReadback: true }]) {
    calls.length = 0;
    simklTransport.resetForTests(); transport(options);
    const result = await ratings.setSimklPersonalRating(connection, media, 7);
    assert.equal(result.status, "succeeded");
    assert.ok(result.reviewReason);
    assert.equal(calls.filter(x => x.path === "/sync/ratings").length, 1);
  }
});

test("rating scheduler imports and clears stored observations without refreshing expired Simkl credentials", async () => {
  persist(partitions());
  db.prepare("UPDATE tracker_connections SET access_token_expires_at=0 WHERE provider='simkl'").run();
  await saveMediaConfig({ ratingSync: { enabled: true } });
  const first = await sync.runRatingSyncScheduler();
  assert.equal(first.providers.find(x => x.provider === "simkl").status, "succeeded");
  assert.equal(db.prepare("SELECT rating FROM personal_ratings").get().rating, 8);
  persist(partitions(null), "2026-10-22T12:01:00Z", "2026-10-22T12:00:00Z");
  const second = await sync.runRatingSync({ providers: ["simkl"], drain: false });
  assert.equal(second.providers[0].cleared, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM personal_ratings").get().n, 0);
});

test("queue delivery keeps held explanations and readback conflicts visible, and excludes episodes", async () => {
  const config = { ratingSync: { enabled: true } };
  const episode = { media_type: "episode", title: "Episode", show_tmdb_id: "2", season: 1, episode: 1 };
  assert.equal(sync.queuePersonalRatingMutation(episode, 8, { config, providers: ["simkl"] }).queued, 0);
  sync.queuePersonalRatingMutation(media, 8, { config, providers: ["simkl"] });
  transport({ before: { list: "plantowatch" } });
  const held = await sync.runRatingSync({ providers: ["simkl"], config, snapshot: false });
  assert.equal(held.status, "partial");
  assert.equal(held.queue.held, 1);
  assert.match(db.prepare("SELECT last_error FROM personal_rating_sync_queue").get().last_error, /watched history/);
  const status = await sync.getRatingSyncStatus({ config });
  assert.match(status.providers.find(row => row.provider === "simkl").issues[0].reason, /watched history/);
  // A new user intent supersedes the terminal hold.
  sync.queuePersonalRatingMutation(media, 9, { config, providers: ["simkl"] });
  simklTransport.resetForTests();
  transport({ after: { list: "dropped", last_watched_at: date } });
  await sync.runRatingSync({ providers: ["simkl"], config, snapshot: false });
  const source = db.prepare("SELECT sync_status,last_error FROM personal_rating_sources WHERE provider='simkl'").get();
  assert.equal(source.sync_status, "conflict");
  assert.match(source.last_error, /list or watch date/);
  assert.equal((await sync.getRatingSyncStatus({ config })).providers.find(row => row.provider === "simkl").issues[0].status, "conflict");
});
