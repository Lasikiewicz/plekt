import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-dropped-title-tracker-sync-");
// Background event drains must never escape a fixture when a scoped mock ends.
globalThis.fetch = async () => { throw new Error("Live network access is forbidden in dropped-title tests"); };
const { db } = await import("../server/src/db.js");
const { dropTitle, undropTitle, listDroppedTitles } = await import("../server/src/utils/droppedTitles.js");
const {
  pendingDroppedTitleRowsForConnection, resolveSimklRestoreStatus, shouldApplyRemoteDroppedChange, snapshotContainsDroppedIdentity,
  syncDroppedTitleTracker,
} = await import("../server/src/utils/droppedTitleTrackerSync.js");
const { addTraktDroppedShows, removeTraktDroppedShows, setTraktDroppedShow } = await import("../server/src/utils/trackers/traktClient.js");
const { fetchSimklDroppedTitleSnapshot, setSimklDroppedTitleStatus } = await import("../server/src/utils/trackers/simklClient.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");
const { getFullBackup, importCollectionBatch, BROWSER_BACKUP_COLLECTIONS } = await import("../server/src/utils/backup.js");
const trackerConnections = await import("../server/src/utils/trackerConnectionRepo.js");

const movie = { media_type: "movie", title: "Arrival", year: 2016, tmdb_id: "329865", imdb_id: "tt2543164" };
const show = { media_type: "tv", title: "Severance", year: 2022, tmdb_id: "95396", tvdb_id: "366972" };

function clear() {
  db.prepare("DELETE FROM dropped_title_tracker_state").run();
  db.prepare("DELETE FROM dropped_title_tracker_cursors").run();
  db.prepare("DELETE FROM dropped_titles").run();
}

test("local drop and un-drop leave durable provider intents and retain the un-drop tombstone", () => {
  clear();
  dropTitle(movie, { now: 100 });
  let rows = db.prepare("SELECT * FROM dropped_title_tracker_state ORDER BY provider").all();
  assert.deepEqual(rows.map(({ provider, desired_dropped, source, write_status }) => [provider, desired_dropped, source, write_status]), [
    ["simkl", 1, "local", "unbound"],
  ]);
  const title = listDroppedTitles()[0];
  undropTitle(title.id, { sync: true });
  rows = db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider='simkl'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desired_dropped, 0);
  assert.equal(rows[0].source, "local");
  assert.equal(rows[0].write_status, "unbound");
  assert.equal(listDroppedTitles().length, 0);
});

test("Trakt outbound intents are shows only and imported changes queue only the other tracker", () => {
  clear();
  dropTitle(show, { now: 100 });
  const providers = db.prepare("SELECT provider FROM dropped_title_tracker_state ORDER BY provider").all().map((row) => row.provider);
  assert.deepEqual(providers, ["simkl", "trakt"]);
  clear();
  dropTitle(show, { now: 100, source: "trakt" });
  const imported = db.prepare("SELECT provider,source,write_status FROM dropped_title_tracker_state").all();
  assert.deepEqual(imported.map(({ provider, source, write_status }) => [provider, source, write_status]), [["simkl", "trakt", "unbound"]]);
});

test("local pending work is bound to its account and account replacement unbinds it", () => {
  clear();
  db.prepare("DELETE FROM tracker_connections").run();
  const connectionData = { provider: "simkl", clientId: "client", remoteUserId: "account-a", accessToken: "token", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3600_000 };
  trackerConnections.saveTrackerConnection(connectionData);
  const original = trackerConnections.getTrackerConnection("simkl");
  dropTitle(movie);
  let row = db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider='simkl'").get();
  assert.equal(row.connection_id, original.id);
  assert.equal(row.account_id, "account-a");
  assert.equal(row.write_status, "pending");
  trackerConnections.saveTrackerConnection({ ...connectionData, remoteUserId: "account-b" });
  row = db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider='simkl'").get();
  assert.equal(row.connection_id, "");
  assert.equal(row.account_id, "");
  assert.equal(row.write_status, "unbound");
  assert.equal(row.desired_dropped, 1);
  trackerConnections.deleteTrackerConnection("simkl");
});

test("Trakt reading back our own pushed drop confirms it without relabelling or queueing Simkl", async () => {
  clear();
  db.prepare("DELETE FROM tracker_connections").run();
  for (const provider of ["trakt", "simkl"]) {
    trackerConnections.saveTrackerConnection({ provider, clientId: "client", remoteUserId: `${provider}-user`, accessToken: "token", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3600_000 });
  }
  dropTitle(show, { now: 1_000 });
  db.prepare("UPDATE dropped_title_tracker_state SET write_status='done'").run();
  const listedAt = "2026-10-22T14:00:00.000Z";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path === "/sync/last_activities"
      ? { shows: { dropped_at: listedAt } }
      : [{ listed_at: listedAt, type: "show", show: { title: "Severance", year: 2022, ids: { trakt: 1, tmdb: 95396, tvdb: 366972 } } }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { syncDroppedTitleTracker } = await import("../server/src/utils/droppedTitleTrackerSync.js");
    await syncDroppedTitleTracker("trakt", { trigger: "user" });
  } finally { globalThis.fetch = originalFetch; }
  const rows = db.prepare("SELECT provider,source,action_at,write_status,remote_present FROM dropped_title_tracker_state ORDER BY provider").all();
  assert.deepEqual(rows.map(({ provider, source, action_at, write_status }) => [provider, source, action_at, write_status]), [
    ["simkl", "local", 1_000, "done"],
    ["trakt", "local", 1_000, "done"],
  ]);
  assert.equal(rows[1].remote_present, 1);
  assert.equal(listDroppedTitles().length, 1);
  for (const provider of ["trakt", "simkl"]) trackerConnections.deleteTrackerConnection(provider);
});

test("newest explicit action wins and Simkl un-drop avoids history-creating statuses", () => {
  assert.equal(shouldApplyRemoteDroppedChange(200, 199), false);
  assert.equal(shouldApplyRemoteDroppedChange(200, 201), true);
  assert.equal(shouldApplyRemoteDroppedChange(0, 201), true);
  assert.equal(resolveSimklRestoreStatus("movie", "completed"), null);
  assert.equal(resolveSimklRestoreStatus("movie", "watching"), "plantowatch");
  assert.equal(resolveSimklRestoreStatus("show", "completed"), null);
  assert.equal(resolveSimklRestoreStatus("show", "hold"), "hold");
  assert.equal(resolveSimklRestoreStatus("show", ""), "watching");
});

test("identity enrichment reuses the same show and account fences exclude stale pending work", () => {
  const sparse = { type: "show", title: "Severance", ids: { tmdb: "95396" } };
  const enriched = { type: "show", title: "Severance", ids: { tmdb: "95396", tvdb: "366972", imdb: "tt11280740" } };
  assert.equal(snapshotContainsDroppedIdentity([{ media: sparse }], enriched), true);
  assert.equal(snapshotContainsDroppedIdentity([{ media: sparse }], { ...enriched, ids: { tmdb: "999" } }), false);
  const rows = [
    { write_status: "pending", connection_id: "old", account_id: "a" },
    { write_status: "pending", connection_id: "current", account_id: "b" },
  ];
  assert.deepEqual(pendingDroppedTitleRowsForConnection(rows, { id: "current", remoteUserId: "b" }), [rows[1]]);
});

test("tracker tombstones and activity cursors round-trip in full backups only", () => {
  clear();
  db.prepare("DELETE FROM tracker_connections").run();
  trackerConnections.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "backup-account", accessToken: "token", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3600_000 });
  dropTitle(movie);
  const backup = getFullBackup();
  const state = backup.collections.droppedTitleTrackerState;
  assert.equal(state.length, 1);
  assert.equal(state[0].data.desired_dropped, 1);
  assert.equal(BROWSER_BACKUP_COLLECTIONS.includes("droppedTitleTrackerState"), false);
  db.prepare("DELETE FROM dropped_title_tracker_state").run();
  assert.equal(importCollectionBatch("droppedTitleTrackerState", state, { reset: true }).imported, 1);
  const restored = db.prepare("SELECT desired_dropped,write_status,last_error FROM dropped_title_tracker_state").get();
  assert.equal(restored.desired_dropped, 1);
  assert.equal(restored.write_status, "review");
  assert.match(restored.last_error, /needs review/);
  trackerConnections.deleteTrackerConnection("simkl");
});

test("Trakt add/remove use only hidden dropped endpoints and show payloads", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options, body: JSON.parse(options.body) });
    return new Response("{}", { status: 200 });
  };
  try {
    const connection = { clientId: "client", accessToken: "token" };
    const payload = [{ ids: { tmdb: "95396", tvdb: "366972" } }];
    await addTraktDroppedShows(connection, payload);
    await removeTraktDroppedShows(connection, payload);
    assert.deepEqual(calls.map(({ url }) => url.pathname), ["/users/hidden/dropped", "/users/hidden/dropped/remove"]);
    assert.ok(calls.every(({ options, body }) => options.method === "POST" && body.shows[0].ids.tmdb === "95396"));
  } finally { globalThis.fetch = originalFetch; }
});

test("Trakt writes require a valid result and a matching complete readback", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let readback = 0;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    if (options.method === "GET") {
      const dropped = readback++ === 0;
      return new Response(JSON.stringify(dropped ? [{ show: { ids: { tmdb: 7 } } }] : []));
    }
    const remove = parsed.pathname.endsWith("/remove");
    return new Response(JSON.stringify(remove
      ? { deleted: { shows: 1 }, not_found: { shows: [] } }
      : { added: { shows: 1 }, not_found: { shows: [] } }));
  };
  try {
    const connection = { clientId: "client", accessToken: "token" };
    assert.equal((await setTraktDroppedShow(connection, { ids: { tmdb: 7 } }, true)).confirmed, true);
    assert.equal((await setTraktDroppedShow(connection, { ids: { tmdb: 7 } }, false)).confirmed, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("Simkl drop status uses add-to-list payload and never history or watched writes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ added: { movies: [{ movie: { ids: { tmdb: "329865" } }, to: "dropped" }] }, not_found: { movies: [] } }), { status: 200 });
  };
  try {
    await setSimklDroppedTitleStatus({ clientId: "client", accessToken: "token" }, {
      type: "movie", ids: { tmdb: "329865" }, title: "Arrival",
    }, "dropped", { trigger: "user" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, "/sync/add-to-list");
    assert.deepEqual(calls[0].body, { movies: [{ ids: { tmdb: "329865" }, to: "dropped" }] });
    assert.equal(calls.some(({ url }) => /sync\/(history|watched|unwatched)/.test(url.pathname)), false);
    await assert.rejects(setSimklDroppedTitleStatus({ clientId: "client", accessToken: "token" }, {
      type: "movie", ids: { tmdb: "329865" }, title: "Arrival",
    }, "watching", { trigger: "user" }), /cannot be restored/);
    assert.equal(calls.length, 1, "unsafe movie status is rejected before transport");
  } finally { globalThis.fetch = originalFetch; }
});

test("Simkl dropped snapshot never borrows activities.all as an item's change time", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  simklTransport.resetForTests();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    const body = parsed.pathname === "/sync/activities"
      ? { all: "2026-10-22T10:00:00.000Z" }
      : parsed.pathname === "/sync/all-items/movies/dropped"
        ? { movies: [{ status: "dropped", movie: { title: "Arrival", year: 2016, ids: { tmdb: 329865 } } }] }
        : { [parsed.pathname.split("/")[3]]: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const snapshot = await fetchSimklDroppedTitleSnapshot({ clientId: "client", accessToken: "token" }, { trigger: "user" });
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.activities.all, "2026-10-22T10:00:00.000Z");
    assert.equal(snapshot.dropped.length, 1);
    assert.equal(snapshot.dropped[0].changedAt, null);
    assert.equal(calls.some((path) => /sync\/(history|watched|unwatched)/.test(path)), false);
    let malformedActivity = true;
    globalThis.fetch = async (url) => new Response(JSON.stringify(new URL(url).pathname === "/sync/activities"
      ? { all: "2026-10-22T10:00:00.000Z" }
      : malformedActivity ? { unexpected: [] } : { movies: [], shows: [] }), { status: 200 });
    simklTransport.resetForTests();
    await assert.rejects(fetchSimklDroppedTitleSnapshot({ clientId: "client", accessToken: "token" }, { trigger: "user" }), /incomplete or invalid snapshot/);
  } finally {
    globalThis.fetch = originalFetch;
    simklTransport.resetForTests();
  }
});

test("Simkl imports drop and un-drop changes from complete snapshots without item timestamps", async () => {
  clear();
  db.prepare("DELETE FROM tracker_connections").run();
  simklTransport.resetForTests();
  trackerConnections.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "simkl-user", accessToken: "token", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3600_000 });
  const connection = trackerConnections.getTrackerConnection("simkl", { includeCredentials: true });
  const testStarted = Date.now();
  const before = new Date(testStarted - 20_000).toISOString();
  const localDropAt = new Date(testStarted - 15_000).toISOString();
  const remoteUndropAt = new Date(testStarted - 10_000).toISOString();
  const remoteDropAt = new Date(testStarted - 5_000).toISOString();
  const localRestoreAt = new Date(testStarted + 5_000).toISOString();
  db.prepare("INSERT INTO dropped_title_tracker_cursors(provider,connection_id,account_id,activities_json,updated_at) VALUES('simkl',?,?,?,?)")
    .run(connection.id, connection.remoteUserId, JSON.stringify({ all: before }), Date.now());
  dropTitle(movie, { now: testStarted - 15_000 });

  let activities = before;
  let remoteStatus = "plantowatch";
  let postCount = 0;
  const paths = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === "/sync/activities") return new Response(JSON.stringify({ all: activities }), { status: 200 });
    if (parsed.pathname === "/sync/add-to-list") {
      const body = JSON.parse(options.body);
      const item = body.movies[0];
      remoteStatus = item.to;
      activities = [localDropAt, remoteUndropAt, remoteDropAt, localRestoreAt][postCount++];
      return new Response(JSON.stringify({
        added: { movies: [{ movie: { title: "Arrival", year: 2016, ids: { tmdb: "329865", imdb: "tt2543164" } }, to: item.to }] },
        not_found: { movies: [] },
      }), { status: 201 });
    }
    const [, , , type, status] = parsed.pathname.split("/");
    if (type === "movies" && status === remoteStatus) {
      return new Response(JSON.stringify({ movies: [{ status, last_listed_at: null, movie: { title: "Arrival", year: 2016, ids: { tmdb: "329865", imdb: "tt2543164" } } }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  try {
    // dropTitle above also scheduled a background drain. Let it finish so it
    // cannot race the explicit syncs below over the same fake account.
    const drainDeadline = Date.now() + 5_000;
    while (Date.now() < drainDeadline && db.prepare("SELECT write_status FROM dropped_title_tracker_state WHERE provider='simkl'").get()?.write_status !== "done") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await syncDroppedTitleTracker("simkl", { trigger: "user" });
    let row = db.prepare("SELECT desired_dropped,remote_present,write_status FROM dropped_title_tracker_state WHERE provider='simkl'").get();
    assert.deepEqual(row, { desired_dropped: 1, remote_present: 1, write_status: "done" }, "confirmed local drop records known Simkl presence");
    await setSimklDroppedTitleStatus(connection, { type: "movie", title: "Arrival", year: 2016, ids: { tmdb: "329865", imdb: "tt2543164" } }, "plantowatch", { trigger: "user" });
    await syncDroppedTitleTracker("simkl", { trigger: "user" });
    assert.equal(listDroppedTitles().length, 0, "changed complete snapshot imports the Simkl un-drop");
    row = db.prepare("SELECT desired_dropped,remote_present,previous_status,source,write_status FROM dropped_title_tracker_state WHERE provider='simkl' ORDER BY updated_at DESC LIMIT 1").get();
    assert.equal(row.desired_dropped, 0);
    assert.equal(row.remote_present, 0);
    assert.equal(row.previous_status, "plantowatch");
    assert.equal(row.source, "simkl");
    assert.equal(row.write_status, "done");

    await setSimklDroppedTitleStatus(connection, { type: "movie", title: "Arrival", year: 2016, ids: { tmdb: "329865", imdb: "tt2543164" } }, "dropped", { trigger: "user" });
    await syncDroppedTitleTracker("simkl", { trigger: "user" });
    assert.equal(listDroppedTitles().length, 1, "changed complete snapshot imports the Simkl drop");
    undropTitle(listDroppedTitles()[0].id, { sync: true, source: "local", actionAt: Date.now() + 10_000 });
    const restoreDeadline = Date.now() + 5_000;
    let restored;
    while (Date.now() < restoreDeadline) {
      restored = db.prepare("SELECT desired_dropped,remote_present,previous_status,write_status FROM dropped_title_tracker_state WHERE provider='simkl' ORDER BY updated_at DESC LIMIT 1").get();
      if (restored?.desired_dropped === 0 && restored?.remote_present === 0 && restored?.write_status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(listDroppedTitles().length, 0, "local un-drop queues restoration to Simkl");
    const restoredRows = db.prepare("SELECT desired_dropped,remote_present,previous_status,write_status FROM dropped_title_tracker_state WHERE provider='simkl'").all();
    assert.ok(restoredRows.some((state) => state.desired_dropped === 0 && state.remote_present === 0 && state.write_status === "done"));
    // Three complete 13-partition snapshots: after the drain's own write, the
    // Simkl un-drop and the Simkl re-drop.
    assert.equal(paths.filter((path) => path.startsWith("/sync/all-items/")).length, 39);
    assert.equal(paths.some((path) => /sync\/(history|watched|unwatched)/.test(path)), false);
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnections.deleteTrackerConnection("simkl");
    clear();
    simklTransport.resetForTests();
  }
});
