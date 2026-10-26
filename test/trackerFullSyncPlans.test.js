import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-tracker-full-sync-plans-");
const { db } = await import("../server/src/db.js");
const plans = await import("../server/src/utils/trackers/fullSyncPlans.js");

const movie = (tmdb, extra = {}) => ({ type: "movie", title: `Movie ${tmdb}`, ids: { tmdb: String(tmdb) }, ...extra });
const state = (local = [], remote = [], extra = {}) => ({
  connection: { id: "connection-a", account: "account-a", preferEarlier: true }, local, remote, review: [],
  lan: {}, lanTargets: [], localGuard: "local-a", identityGuard: "identity-a", ...extra,
});

test.beforeEach(() => db.prepare("DELETE FROM settings WHERE id LIKE 'tracker-full-sync-plan:%'").run());

test('large library comparison indexes identities instead of scanning every pair',()=>{
  let reads=0;
  const make=(id)=>({type:'movie',title:`Movie ${id}`,watched_at:'2020-01-01T00:00:00Z',get ids(){reads++;return {tmdb:String(id)};}});
  const local=Array.from({length:2000},(_,i)=>make(i+1));
  const remote=Array.from({length:2000},(_,i)=>({media:make(i+1001),remoteWatchedAt:Date.parse('2020-01-01T00:00:00Z')}));
  const rows=plans.buildTrackerFullSyncItems('trakt',local,remote);
  assert.equal(rows.filter(row=>row.side==='tracker'&&row.selectable).length,1000);
  assert.equal(rows.filter(row=>row.side==='plekt'&&row.selectable).length,1000);
  assert.ok(reads<100_000,`Identity reads must scale with inventory, observed ${reads}`);
});

test("builds per-item add-only rows and preserves existing dates", () => {
  const items = plans.buildTrackerFullSyncItems("trakt", [movie(1, { watched_at: "2020-01-01T00:00:00Z" }), movie(2, { watched_at: "2020-01-02T00:00:00Z" })], [
    { media: movie(1), remoteWatchedAt: Date.parse("2022-01-01T00:00:00Z") },
  ]);
  assert.deepEqual(items.map(row => [row.operation, row.title]), [["date_difference", "Movie 1"], ["add", "Movie 2"]]);
  assert.equal(items[0].existingWatchedAt, "2022-01-01T00:00:00.000Z");
  assert.equal(items[0].selectable, false);
  assert.equal(items[1].selectable, true);
});

test("skips conflicting identities and unknown dates or unsupported ids", () => {
  const a = { type: "movie", title: "A", ids: { tmdb: "5", imdb: "tt-a" }, watched_at: "2020-01-01" };
  const b = { type: "movie", title: "B", ids: { tmdb: "5", imdb: "tt-b" }, watched_at: "2020-01-01" };
  const items = plans.buildTrackerFullSyncItems("simkl", [a, b, movie(6), movie(7, { watched_at: "unknown" })], [
    { media: movie(8), remoteWatchedAt: null },
  ]);
  assert.equal(items.length, 5);
  assert.ok(items.every(row => row.operation === "skip" && !row.selectable));
  assert.equal(items.filter(row => /Conflicting/.test(row.reason)).length, 2);
  assert.ok(items.some(row => row.reason === "No observed watch date"));
  assert.ok(items.some(row => /Missing verified identity or observed watch date/.test(row.reason)));
});

test("tracker review observations hold sends that could rewrite the tracker's watched state", () => {
  const show = { tmdb: "1409", imdb: "tt1124373" }, other = { tmdb: "31917" };
  const ep = (ids, season, episode) => ({ type: "episode", title: `S${season}E${episode}`, ids, season, episode, watched_at: "2020-01-01T00:00:00Z" });
  const review = [
    { media: { type: "movie", title: "Rated", ids: { tmdb: "293660" } }, reason: "rating_watch_ambiguity" },
    { media: { type: "show", title: "Covered", ids: { tmdb: "1409" } }, reason: "incomplete_episode_coverage" },
    { media: { type: "show", title: "Mapped", ids: other }, reason: "episode_mapping_required", season: 0, episode: 10 },
  ];
  const local = [movie(293660, { watched_at: "2020-01-01T00:00:00Z" }), movie(5, { watched_at: "2020-01-01T00:00:00Z" }), ep(show, 1, 1), ep(show, 2, 3), ep(other, 0, 10), ep(other, 1, 1)];
  const sends = plans.buildTrackerFullSyncItems("simkl", local, [], { review }).filter(row => row.side === "tracker");
  assert.deepEqual(sends.map(row => [row.title, row.operation]), [["Movie 293660", "skip"], ["Movie 5", "add"], ["S1E1", "skip"], ["S2E3", "skip"], ["S0E10", "skip"], ["S1E1", "add"]]);
  assert.ok(sends.filter(row => row.operation === "skip").every(row => /resolve its review/.test(row.reason) && !row.selectable));
});

test("Simkl holds older episode sends on a show with newer Simkl progress, and only on Simkl", () => {
  const oak = { tvdb: "268004" }, fresh = { tvdb: "81189" };
  const ep = (ids, season, episode, watched_at) => ({ type: "episode", title: `S${season}E${episode}`, ids, season, episode, watched_at });
  const remote = [{ media: ep(oak, 12, 1), remoteWatchedAt: "2024-11-13T20:23:42Z" }];
  const local = [ep(oak, 10, 10, "2023-01-05T20:00:00Z"), ep(oak, 13, 3, "2026-05-01T20:00:00Z"), ep(fresh, 1, 1, "2020-01-01T00:00:00Z")];
  const sends = items => items.filter(row => row.side === "tracker").map(row => [row.title, row.operation]);
  const simkl = plans.buildTrackerFullSyncItems("simkl", local, remote);
  assert.deepEqual(sends(simkl), [["S10E10", "skip"], ["S13E3", "add"], ["S1E1", "add"]]);
  assert.match(simkl.find(row => row.title === "S10E10").reason, /past watch-through/);
  assert.deepEqual(sends(plans.buildTrackerFullSyncItems("trakt", local, remote)), [["S10E10", "add"], ["S13E3", "add"], ["S1E1", "add"]]);
});

test("preview validation enforces selected ids and rejects duplicate or skipped ids at apply", () => {
  const plan = plans.storeTrackerFullSyncPlan("trakt", state([], [{ media: movie(1), remoteWatchedAt: Date.now() }]));
  assert.throws(() => plans.readTrackerFullSyncPlan("trakt", "wrong"), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
  assert.equal(plan.items[0].selectable, true);
  assert.throws(() => plans.claimTrackerFullSyncPlan("trakt", plan.id + "-wrong"), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
});

test("claimed and expired previews cannot be applied again", () => {
  const plan = plans.storeTrackerFullSyncPlan("trakt", state([], [{ media: movie(1), remoteWatchedAt: Date.now() }]));
  assert.equal(plans.claimTrackerFullSyncPlan("trakt", plan.id).status, "applying");
  assert.throws(() => plans.readTrackerFullSyncPlan("trakt", plan.id), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
  const expired = plans.storeTrackerFullSyncPlan("trakt", state([], [{ media: movie(2), remoteWatchedAt: Date.now() }]));
  db.prepare("UPDATE settings SET data=? WHERE id=?").run(JSON.stringify({ ...expired, expiresAt: Date.now() - 1 }), "tracker-full-sync-plan:trakt");
  assert.throws(() => plans.readTrackerFullSyncPlan("trakt", expired.id), { code: "FULL_SYNC_PLAN_EXPIRED" });
});

test("LAN destinations include only configured unwatched targets", () => {
  const items = plans.buildTrackerFullSyncItems("trakt", [], [{ media: movie(1), remoteWatchedAt: Date.now() }], {
    lan: { plex: [movie(1)], emby: [] }, lanTargets: ["plex", "emby", "jellyfin"],
  });
  assert.deepEqual(items[0].destinations, ["plekt", "emby", "jellyfin"]);
  assert.deepEqual(items[0].targets, ["emby", "jellyfin"]);
});

test("fingerprint fences a preview to its account", () => {
  const first = state([], [{ media: movie(1), remoteWatchedAt: 1 }]);
  const second = { ...first, connection: { ...first.connection, id: "connection-b", account: "account-b" } };
  assert.notEqual(plans.trackerFullSyncFingerprint(first), plans.trackerFullSyncFingerprint(second));
  const stored = plans.storeTrackerFullSyncPlan("trakt", first);
  assert.equal(stored.connection.account, "account-a");
});

test('pending, uncertain and recent settled writes cannot gain new full-sync send intents',()=>{
  for(const status of ['pending','sending','uncertain','review','settled']) {
    const items=plans.buildTrackerFullSyncItems('simkl',[{...movie(1),watched_at:'2020-01-01T00:00:00Z'}],[],{writeHolds:[{media:movie(1),status}]});
    assert.equal(items.length,1);assert.equal(items[0].operation,'skip');assert.equal(items[0].selectable,false);
  }
});
