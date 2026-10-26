import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-tracker-add-later-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { trackerBacklogSkipReason } = await import("../server/src/utils/trackers/backlogGate.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
const fullSync = await import("../server/src/utils/trackers/fullSync.js");
const { pollConnectedTrackers } = await import("../server/src/utils/trackerSync.js");
const { initialSyncText, fullSyncView } = await import("../public/modules/tracker-full-sync.js");
const { persistSimklObservations } = await import("../server/src/utils/trackers/simklObservations.js");
const fullSyncPlans = await import("../server/src/utils/trackers/fullSyncPlans.js");

const realFetch = globalThis.fetch;
let requests = [];
const connect = (remoteUserId = "account-a") => repo.saveTrackerConnection({
  provider: "trakt", remoteUserId, clientId: "client", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000,
});
const connectSimkl = () => repo.saveTrackerConnection({
  provider: "simkl", remoteUserId: "simkl-a", clientId: "client", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000,
});
const movie = (tmdb, extra = {}) => ({ type: "movie", mediaType: "movie", title: `Movie ${tmdb}`, ids: { tmdb: String(tmdb) }, ...extra });

function insertWatch(id, tmdb, createdAt, watchedAt = "2020-01-01T00:00:00.000Z") {
  db.prepare(`INSERT INTO watch_history (id,title,media_type,watched_at,source,tmdb_id,sync_action,media_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `Movie ${tmdb}`, "movie", watchedAt, "plex", String(tmdb), "watched", `movie:none:none:tmdb:${tmdb}`, createdAt, createdAt);
}
function insertPlaystate(tmdb, ids = { tmdb_id: String(tmdb) }) {
  db.prepare(`INSERT INTO playstate (media_key,title,media_type,state,watched_at,imdb_id,tmdb_id,tvdb_id,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`movie:none:none:tmdb:${tmdb}`, `Movie ${tmdb}`, "movie", "watched", "2024-05-05T00:00:00.000Z", ids.imdb_id || null, ids.tmdb_id || null, ids.tvdb_id || null, Date.now());
  // Full sync reads Plekt's watched set from history; playstate alone is not a play.
  insertWatch(`ps-${tmdb}`, tmdb, Date.now(), "2024-05-05T00:00:00.000Z");
}

test.beforeEach(() => {
  for (const table of ["tracker_observations", "tracker_observation_cursors", "tracker_write_intents", "tracker_item_state", "tracker_play_history", "tracker_connections", "watch_history", "playstate"]) db.prepare(`DELETE FROM ${table}`).run();
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (/\/sync\/history$/.test(String(url))) {
      const sent = JSON.parse(options.body);
      return Response.json({ added: { movies: sent.movies?.length || 0, episodes: 0 }, not_found: { movies: [], shows: [], seasons: [], episodes: [] } });
    }
    return Response.json([], { headers: { "x-pagination-page-count": "1", "x-pagination-limit": "250" } });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

test("a connection generation records when it was connected and keeps progress only for the same account", () => {
  const first = connect();
  assert.ok(first.connectedAt > 0);
  repo.updateTrackerConnectionStatus("trakt", { initialSync: { status: "completed" }, fullSync: { status: "compared", plektOnly: 2 } });
  db.prepare("UPDATE tracker_connections SET connected_at=1").run();
  const same = connect();
  assert.equal(same.connectedAt, 1, "a same-account reconnect keeps its history eligibility");
  assert.equal(same.initialSync.status, "completed");
  assert.equal(same.fullSync.plektOnly, 2);
  const other = connect("account-b");
  assert.ok(other.connectedAt > 1, "a different account starts a new generation");
  assert.equal(other.initialSync, null);
  assert.equal(other.fullSync, null);
});

test("backlog recorded before a tracker was connected is not sent silently", async () => {
  const connection = connect();
  insertWatch("old", 1, connection.connectedAt - 60_000);
  insertWatch("new", 2, connection.connectedAt + 1);
  const old = movie(1, { watchRecordId: "old", source: "plex", watched_at: "2020-01-01T00:00:00.000Z" });
  assert.match(trackerBacklogSkipReason(connection, old, "Trakt"), /Recorded before Trakt was connected/);
  assert.equal(trackerBacklogSkipReason(connection, { ...old, syncIntent: "historical" }), "", "a tool the user runs may send history");
  assert.equal(trackerBacklogSkipReason(connection, { ...old, syncTargets: ["trakt"] }), "", "an explicit target is a user choice");
  assert.equal(trackerBacklogSkipReason(connection, movie(2, { watchRecordId: "new" })), "", "watches recorded after connecting flow");
  db.prepare(`INSERT INTO tracker_write_intents (id,provider,connection_id,account_id,logical_key,watch_record_id,media_key,media_json,action,watched_at,event_type,fingerprint,status,due_at,expires_at,created_at,updated_at)
    VALUES ('i1','trakt',?,?,'k','old','movie:tmdb:1','{}','watched','2020','watch','f','pending',0,0,0,0)`).run(connection.id, connection.remoteUserId);
  assert.equal(trackerBacklogSkipReason(connection, old), "", "a captured intent already authorized this destination");
  db.prepare("DELETE FROM tracker_write_intents").run();

  const [state] = await dispatchTrackerWatchState(old, "watched");
  assert.equal(state.status, "skipped");
  assert.equal(state.decision, "skipped_by_policy");
  assert.equal(state.dismissed, true, "kept in telemetry so the row is not replayed forever");
  assert.equal(requests.length, 0);
});

test("history imported from another tracker is not forwarded to this tracker", async () => {
  const connection = connect();
  insertWatch("from-simkl", 3, connection.connectedAt + 1);
  const imported = movie(3, { watchRecordId: "from-simkl", source: "simkl", syncIntent: "import", watched_at: "2020-04-23T23:32:51.000Z" });
  assert.match(trackerBacklogSkipReason(connection, imported, "Trakt", { sourceTracker: "simkl" }), /Imported from another tracker's history/);
  assert.equal(trackerBacklogSkipReason(connection, imported, "Trakt", { sourceTracker: "trakt" }), "", "the source tracker's own echo is handled elsewhere");
  assert.equal(trackerBacklogSkipReason(connection, { ...imported, syncIntent: "live" }, "Trakt", { sourceTracker: "simkl" }), "", "a new watch on another tracker flows");
  assert.equal(trackerBacklogSkipReason(connection, { ...imported, syncTargets: ["trakt"] }, "Trakt", { sourceTracker: "simkl" }), "", "an explicit target is a user choice");

  const [state] = await dispatchTrackerWatchState(imported, "watched");
  assert.equal(state.decision, "skipped_by_policy");
  assert.equal(requests.length, 0, "no Trakt request for imported Simkl history");
});

test("comparison matches on any shared id and ignores protective ledger rows", () => {
  const remote = [
    { mediaKey: "movie:imdb:tt1", media: movie(1, { ids: { imdb: "tt1", tmdb: "1" } }), remoteWatchedAt: 1 },
    { mediaKey: "movie:tmdb:9", media: movie(9), remoteWatchedAt: 1 },
    { mediaKey: "movie:tmdb:5", media: movie(5), remoteWatchedAt: null },
  ];
  const local = [movie(1), movie(5), { type: "movie", title: "No ids", ids: {} }];
  const result = fullSync.compareTrackerItems(remote, local);
  assert.deepEqual(result.trackerOnly.map((item) => item.mediaKey), ["movie:tmdb:9"]);
  assert.deepEqual(result.plektOnly.map((item) => item.ids.tmdb), ["5"], "an outbound-only ledger row is not a remote watch");
  assert.equal(result.unidentified, 1);
});

test("comparison counts a Fix Match renumbered show in the stored numbering", () => {
  const episode = (season, number) => ({ type: "episode", mediaType: "episode", title: `Show S${season}E${number}`,
    season, episode: number, ids: { tvdb: "500", tmdb: "77" } });
  const remote = [
    { mediaKey: "episode:tmdb:77:2:1", media: episode(2, 1), remoteWatchedAt: 1 },
    { mediaKey: "episode:tmdb:77:2:2", media: episode(2, 2), remoteWatchedAt: 1 },
  ];
  // Stored S1E13 is the tracker's S2E1; the tracker's S2E2 has no local watch.
  const local = [episode(1, 13)];
  const toStored = (media) => (media.season === 2 && media.episode === 1 ? { ...media, season: 1, episode: 13 } : media);
  const untranslated = fullSync.compareTrackerItems(remote, local);
  assert.equal(untranslated.plektOnly.length, 1, "without translation the renumbered episode looks missing");
  const result = fullSync.compareTrackerItems(remote, local, toStored);
  assert.equal(result.plektOnly.length, 0);
  assert.deepEqual(result.trackerOnly.map((item) => item.mediaKey), ["episode:tmdb:77:2:2"]);
  assert.ok(result.remoteKeys.has("episode:tmdb:77:2:1"), "the push still checks the tracker's own numbering");
});

test("full sync waits for the baseline; Simkl offers compare and import only", async () => {
  connect();
  await assert.rejects(fullSync.compareTrackerWithPlekt("trakt"), { code: "BASELINE_PENDING" });
  await assert.rejects(fullSync.compareTrackerWithPlekt("simkl"), { code: "NOT_CONNECTED" });
  await assert.rejects(fullSync.startTrackerFullSync("trakt", "sideways"), { code: "INVALID_DIRECTION" });
  connectSimkl();
  await assert.rejects(fullSync.compareTrackerWithPlekt("simkl"), { code: "BASELINE_PENDING" });
  repo.updateTrackerConnectionStatus("simkl", { baselineComplete: true });
  assert.deepEqual(fullSync.trackerFullSyncDirections("trakt"), fullSync.FULL_SYNC_DIRECTIONS);
  assert.deepEqual(fullSync.trackerFullSyncDirections("simkl"), fullSync.FULL_SYNC_DIRECTIONS, "all directions may be previewed while normal sending remains disabled");
  // Preview/apply requires a stored explicit selection, even while the UI keeps Simkl sends disabled.
  await assert.rejects(fullSync.startTrackerFullSync("simkl", "import"), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
  assert.equal(repo.getTrackerConnection("simkl").fullSync, null);
  assert.equal(requests.length, 0);
});

test("Simkl compare uses settled watched observations, never held ones", async () => {
  const connection = connectSimkl();
  const cursor = "2026-10-21T12:00:00Z";
  const seen = (tmdb, watchedAt = Date.parse("2026-10-01T12:00:00Z")) => ({ media: movie(tmdb, { source: "simkl" }), watchedAt, timestampProvenance: watchedAt ? "observed" : "unknown" });
  persistSimklObservations(connection, { watched: [seen(1), seen(3), seen(4, null)], ratings: [], review: [], activities: { all: cursor }, cursor, complete: true, absenceReconciliation: false });
  insertPlaystate(1);
  insertPlaystate(2);
  const compared = await fullSync.compareTrackerWithPlekt("simkl");
  assert.equal(compared.trackerOnly, 1, "the undated observation is held for review, not counted");
  assert.deepEqual(compared.examples.trackerOnly, ["Movie 3"]);
  assert.equal(compared.plektOnly, 1);
  assert.deepEqual(compared.examples.plektOnly, ["Movie 2"]);
  assert.equal(requests.length, 0, "compare reads only stored observations");
});

test("full-sync apply requires a stored preview and selection; push uses only selected preview rows", async () => {
  const connection = connect();
  repo.updateTrackerConnectionStatus("trakt", { baselineComplete: true });
  repo.replaceTrackerSnapshot("trakt", [
    { mediaKey: "movie:tmdb:1", media: movie(1), watchedAt: Date.now() },
    { mediaKey: "movie:tmdb:3", media: movie(3), watchedAt: Date.now() },
  ]);
  insertPlaystate(1);
  insertPlaystate(2);
  insertWatch("a", 2, connection.connectedAt - 10, "2019-03-03T00:00:00.000Z");
  insertWatch("b", 2, connection.connectedAt - 5, "2021-04-04T00:00:00.000Z");

  const compared = await fullSync.compareTrackerWithPlekt("trakt");
  assert.equal(compared.trackerOnly, 1);
  assert.equal(compared.plektOnly, 1);
  assert.deepEqual(compared.examples.plektOnly, ["Movie 2"]);
  assert.equal(repo.getTrackerConnection("trakt").fullSync.status, "compared");

  await assert.rejects(fullSync.startTrackerFullSync("trakt", "push"), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  const preview = await fullSync.compareTrackerWithPlekt("trakt");
  assert.equal(preview.preview.items.filter((item) => item.side === "tracker" && item.selectable).length, 1);
  const selected = preview.preview.items.filter((item) => item.side === "tracker" && item.selectable).map((item) => item.id);
  await assert.rejects(fullSync.startTrackerFullSync("trakt", "push", { planId: preview.preview.id, selectedIds: selected }), { code: "FULL_SYNC_PLAN_STALE" });
  assert.equal(requests.filter((request) => request.method === "POST").length, 0, "fresh provider state must match the preview before writes");
  assert.notEqual(repo.getTrackerConnection("trakt").fullSync.preview.id, preview.preview.id, "stale state creates a replacement preview");
  assert.throws(() => fullSyncPlans.readTrackerFullSyncPlan("trakt", preview.preview.id), { code: "FULL_SYNC_PREVIEW_REQUIRED" });
});

test("the first poll records durable initial-sync progress outside onboarding", async () => {
  connect();
  await pollConnectedTrackers({ provider: "trakt" });
  const { initialSync, baselineComplete } = repo.getTrackerConnection("trakt");
  assert.equal(baselineComplete, true);
  assert.equal(initialSync.status, "completed");
  assert.equal(initialSync.mode, "baseline");
  assert.equal(initialSync.imported, 0);
  await pollConnectedTrackers({ provider: "trakt" });
  assert.equal(repo.getTrackerConnection("trakt").initialSync.finishedAt, initialSync.finishedAt, "later polls leave it alone");
});

test("the date preference is a per-connection setting", () => {
  connect();
  repo.updateTrackerConnectionStatus("trakt", { preferEarlierWatchedDate: false });
  assert.equal(repo.getTrackerConnection("trakt").preferEarlierWatchedDate, false);
});

test("tracker card copy describes progress and offers only meaningful actions", () => {
  assert.match(initialSyncText({ provider: "simkl", baselineComplete: false, initialSync: { status: "running", total: 40, done: 25 } }), /25 of 40 items/);
  assert.match(fullSyncView("simkl", { baselineComplete: true }, { gated: true }).text, /when Simkl sync is enabled/);
  assert.equal(fullSyncView("trakt", { baselineComplete: false }).compare, false);
  const view = fullSyncView("trakt", { baselineComplete: true, fullSync: { status: "compared", comparedAt: 1, trackerOnly: 0, plektOnly: 3 } });
  assert.equal(view.run, true);
  assert.match(view.text, /Plekt has 3 items Trakt lacks/);
  assert.equal(fullSyncView("trakt", { baselineComplete: true, fullSync: { status: "compared", trackerOnly: 0, plektOnly: 0 } }).run, false);
  const simkl = fullSyncView("simkl", { baselineComplete: true, fullSync: { status: "compared", trackerOnly: 2, plektOnly: 3 } });
  assert.deepEqual(simkl.directions, ["import"]);
  assert.equal(simkl.run, true);
  assert.match(simkl.text, /Bulk sending.*not available/);
  assert.equal(fullSyncView("simkl", { baselineComplete: true, fullSync: { status: "compared", trackerOnly: 0, plektOnly: 3 } }).run, false);
  const setupTrakt = fullSyncView("trakt", {
    baselineComplete: true,
    fullSyncDirections: ["import"],
    fullSync: { status: "idle" },
  }, { setupImportOnly: true });
  assert.match(setupTrakt.text, /Initial connection records the current state without importing history/);
  assert.match(setupTrakt.text, /To import existing watches, select the option above and review the preview/);
  assert.doesNotMatch(setupTrakt.text, /Bulk sending/);
  assert.match(initialSyncText({ provider: "simkl" }), /Check now/);
  assert.match(
    initialSyncText({ provider: "trakt", baselineComplete: true, initialSync: { status: "completed", mode: "baseline", finishedAt: "2026-10-23T12:00:00Z" } }),
    /starting point; nothing was copied into Plekt yet/i,
  );
  assert.doesNotMatch(
    initialSyncText({ provider: "trakt", baselineComplete: true, initialSync: { status: "completed", mode: "baseline" } }),
    /recorded \./,
  );
});
