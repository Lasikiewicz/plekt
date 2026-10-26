import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

// Every phase is a fresh OS process, against only the parent's temporary DB.
assert.ok(path.resolve(process.env.DATA_DIR || "").startsWith(path.resolve(os.tmpdir()) + path.sep));
const scenario = process.argv[2];
const base = Date.parse("2026-10-25T10:00:00Z");
const iso = offset => new Date(base + offset).toISOString();
const trakt = scenario.startsWith("trakt-");
const provider = trakt ? "trakt" : "simkl";
const media = trakt
  ? { type: "show", media_type: "show", title: "Fixture show", year: 2020, ids: { tmdb: "900001", imdb: "tt900001" }, tmdb_id: "900001", imdb_id: "tt900001" }
  : { type: "movie", media_type: "movie", title: "Fixture movie", year: 2020, ids: { tmdb: "900002", imdb: "tt900002", simkl: "900003" }, tmdb_id: "900002", imdb_id: "tt900002" };
const remote = { status: "dropped", changedAt: iso(1000), activity: iso(5000), malformed: false, badAck: false };
const calls = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.ok(["api.simkl.com", "api.trakt.tv"].includes(url.hostname), `unexpected host ${url.hostname}`);
  assert.ok(!/\/sync\/(history|watched|unwatched)/.test(url.pathname), "history endpoint forbidden");
  const method = options.method || "GET";
  calls.push({ path: url.pathname, method });
  let body;
  if (url.pathname === "/sync/activities") body = { all: remote.activity };
  else if (url.pathname === "/sync/last_activities") body = { shows: { dropped_at: remote.activity } };
  else if (url.pathname === "/sync/add-to-list") {
    const item = JSON.parse(options.body).movies[0];
    remote.status = item.to;
    body = remote.badAck ? { added: { movies: [] }, not_found: { movies: [] } }
      : { added: { movies: [{ movie: { ids: media.ids }, to: item.to }] }, not_found: { movies: [] } };
  } else if (url.pathname.startsWith("/sync/all-items/")) {
    const [, , , type, status] = url.pathname.split("/");
    body = remote.malformed && type === "anime" && status === "dropped" ? { wrong: [] }
      : type === "movies" && status === remote.status
        ? { movies: [{ status, last_listed_at: remote.changedAt, movie: { title: media.title, year: media.year, ids: media.ids } }] } : {};
  } else if (url.pathname === "/users/hidden/dropped/remove" && method === "POST") {
    remote.status = "plantowatch";
    body = { deleted: { shows: 1 }, not_found: { shows: [] } };
  } else if (url.pathname === "/users/hidden/dropped" && method === "POST") {
    remote.status = "dropped";
    body = { added: { shows: 1 }, not_found: { shows: [] } };
  } else if (url.pathname === "/users/hidden/dropped") {
    body = remote.status === "dropped" ? [{ listed_at: remote.changedAt, show: { title: media.title, year: media.year, ids: media.ids } }] : [];
  } else throw new Error(`unexpected fixture path ${url.pathname}`);
  return new Response(JSON.stringify(body), { status: method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
};

const { db } = await import("../../server/src/db.js");
const { dropTitle, undropTitle, listDroppedTitles } = await import("../../server/src/utils/droppedTitles.js");
const { saveTrackerConnection, getTrackerConnection } = await import("../../server/src/utils/trackerConnectionRepo.js");
const { syncDroppedTitleTracker } = await import("../../server/src/utils/droppedTitleTrackerSync.js");
const { simklTransport } = await import("../../server/src/utils/trackers/simklTransport.js");
const existing = getTrackerConnection(provider);
if (!existing) saveTrackerConnection({ provider, clientId: "fixture-client", remoteUserId: "fixture-user", accessToken: "fixture-token", refreshToken: "fixture-refresh", accessTokenExpiresAt: Date.now() + 3600_000 });
const connection = getTrackerConnection(provider);
const cursor = () => db.prepare("SELECT activities_json FROM dropped_title_tracker_cursors WHERE provider=?").get(provider)?.activities_json;
const rows = () => db.prepare("SELECT * FROM dropped_title_tracker_state WHERE provider=? ORDER BY action_at DESC").all(provider);
const posts = () => calls.filter(call => call.method === "POST");
function seed({ desired = 0, action = 2000, present = 0, status = "pending", identity = "fixture-state", previous = "plantowatch" } = {}) {
  db.prepare(`INSERT INTO dropped_title_tracker_state(id,provider,connection_id,account_id,identity_key,media_json,desired_dropped,action_at,source,remote_present,previous_status,write_status,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${provider}:${identity}`, provider, connection.id, connection.remoteUserId, identity, JSON.stringify(media), desired, base + action, "local", present, previous, status, base + action);
}
function seedCursor() {
  const data = provider === "simkl" ? { all: iso(0) } : { shows: { dropped_at: iso(0) } };
  db.prepare("INSERT OR REPLACE INTO dropped_title_tracker_cursors(provider,connection_id,account_id,activities_json,updated_at) VALUES(?,?,?,?,?)")
    .run(provider, connection.id, connection.remoteUserId, JSON.stringify(data), base);
}
function done(extra = {}) {
  assert.equal(db.prepare("SELECT count(*) n FROM watch_history").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM playback_progress").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM personal_rating_sources").get().n, 0);
  console.log("DROPPED_CHECK=" + JSON.stringify({ scenario, calls: calls.length, posts: posts().length, ...extra }));
  db.close();
  process.exit(0); // No fixture timer or background drain survives the phase.
}

if (scenario === "restart-seed") {
  seedCursor();
  const first = dropTitle(media, { now: base + 1000 });
  db.prepare("UPDATE dropped_title_tracker_state SET previous_status='hold'").run();
  undropTitle(first.id, { actionAt: base + 2000 });
  dropTitle(media, { now: base + 3000 });
  assert.equal(rows().length, 1, "re-drop must reuse the durable identity");
  assert.equal(rows()[0].previous_status, "hold");
  assert.equal(rows()[0].write_status, "pending");
  done({ rowId: rows()[0].identity_key });
}
if (scenario === "restart-drain" || scenario === "restart-confirm") {
  remote.activity = iso(0);
  assert.equal(listDroppedTitles().length, 1, "drop survives process restart");
  assert.equal(rows().length, 1);
  if (scenario === "restart-drain") {
    await assert.rejects(syncDroppedTitleTracker("simkl", { trigger: "scheduled" }), /requires a user/);
    assert.equal(calls.length, 0, "scheduled pass must not spend quota or drain");
  }
  await syncDroppedTitleTracker("simkl", { trigger: "user" });
  assert.equal(posts().length, scenario === "restart-drain" ? 1 : 0, "pending intent drains once across restarts");
  assert.equal(rows()[0].write_status, "done");
  assert.equal(rows()[0].remote_present, 1);
  assert.equal(rows()[0].previous_status, "hold");
  done();
}

seedCursor();
if (scenario === "simkl-newer-remote-drop") remote.changedAt = iso(4000);
if (scenario.includes("missing") || scenario === "simkl-pending-drop") remote.changedAt = null;
if (scenario === "simkl-tie") remote.changedAt = iso(2000);
if (scenario === "simkl-newer-remote-removal" || scenario === "simkl-pending-drop") {
  dropTitle(media, { now: base + 1000, sync: false });
  seed({ desired: 1, present: 1 });
  remote.status = "plantowatch";
  remote.changedAt = scenario === "simkl-pending-drop" ? null : iso(4000);
} else if (scenario === "simkl-echo") {
  dropTitle(media, { now: base + 1000, sync: false });
  seed({ desired: 1, action: 1000, present: 1, status: "done" });
  remote.changedAt = iso(4000);
} else if (scenario === "simkl-duplicate") {
  seed({ desired: 1, action: 1000, present: 1, status: "done", identity: "older" });
  seed({ desired: 0, action: 3000, present: 0, identity: "newer" });
} else seed();

if (scenario === "simkl-incomplete") {
  remote.malformed = true;
  const before = cursor();
  await assert.rejects(syncDroppedTitleTracker(provider, { trigger: "user" }), /incomplete or invalid/);
  assert.equal(cursor(), before, "incomplete snapshot cannot advance cursor");
  assert.equal(posts().length, 0);
  assert.equal(rows()[0].write_status, "pending");
  assert.equal(listDroppedTitles().length, 0);
  done();
}
if (scenario === "simkl-bad-ack") remote.badAck = true;
await syncDroppedTitleTracker(provider, { trigger: "user" });
if (["simkl-newer-remote-drop", "simkl-echo", "simkl-pending-drop"].includes(scenario)) {
  assert.equal(listDroppedTitles().length, 1);
  assert.equal(posts().length, scenario === "simkl-pending-drop" ? 1 : 0);
  if (scenario === "simkl-newer-remote-drop") assert.equal(rows()[0].action_at, base + 4000, "numeric item timestamp is retained");
  if (scenario === "simkl-echo") {
    assert.equal(rows()[0].source, "local");
    assert.equal(rows()[0].action_at, base + 1000);
    const count = calls.length;
    await syncDroppedTitleTracker(provider, { trigger: "user" });
    assert.equal(calls.length, count + 1, "unchanged cursor avoids another full snapshot");
    assert.equal(posts().length, 0);
  }
} else {
  assert.equal(listDroppedTitles().length, 0, "newer local un-drop remains canonical");
  assert.equal(posts().length, scenario === "simkl-newer-remote-removal" ? 0 : 1);
}
if (scenario === "simkl-bad-ack") assert.equal(rows()[0].write_status, "pending");
else assert.equal(rows()[0].write_status, "done");
if (scenario === "simkl-duplicate") {
  assert.equal(rows().length, 1, "duplicate identities coalesce to newest action");
  assert.equal(rows()[0].desired_dropped, 0);
  assert.equal(rows()[0].action_at, base + 3000);
}
done();
