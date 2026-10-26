import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeTempDataDir } from "./helpers.js";

// Offline, isolated: temp DATA_DIR, injected fetch, no network or credentials.
makeTempDataDir("plekt-simkl-unrelated-intents-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const observations = await import("../server/src/utils/trackers/simklObservations.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");
const { createTrackerWriteIntent } = await import("../server/src/utils/trackerWriteIntents.js");
const { writeSimklWatched } = await import("../server/src/utils/trackers/simkl.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");

const when = "2026-10-22T12:00:00.000Z";
const cursor = "2026-10-22T11:59:00Z";
const FIXTURE = { imdb: "tt0000001", tmdb: 900001 };
const fixtureMedia = () => ({ type: "movie", title: "Fixture title", ids: { tmdb: FIXTURE.tmdb, imdb: FIXTURE.imdb }, watched_at: when });

// Fingerprints use SELECT * so updated_at, attempts, due_at, status, last_error and
// every other column are part of each row's hash.
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isFixtureJson = (json) => { const m = JSON.parse(json); return m?.ids?.tmdb === FIXTURE.tmdb || m?.ids?.imdb === FIXTURE.imdb; };
function snapshotUnrelated() {
  const intents = db.prepare("SELECT * FROM tracker_write_intents ORDER BY id").all().filter((r) => !isFixtureJson(r.media_json));
  const obs = db.prepare("SELECT * FROM tracker_observations ORDER BY id").all().filter((r) => !isFixtureJson(JSON.stringify(JSON.parse(r.observation_json).media)));
  const itemState = db.prepare("SELECT * FROM tracker_item_state ORDER BY provider, media_key").all().filter((r) => !isFixtureJson(r.media_json));
  return {
    intentIds: intents.map((r) => r.id), intentRows: intents.map((r) => sha(r)), intentHash: sha(intents),
    obsIds: obs.map((r) => r.id), obsHash: sha(obs),
    stateKeys: itemState.map((r) => `${r.provider}:${r.media_key}`), stateHash: sha(itemState),
    watchHistory: db.prepare("SELECT count(*) AS n FROM watch_history").get().n,
  };
}

function seed() {
  simklTransport.resetForTests();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  for (const table of ["tracker_write_intents", "tracker_observations", "tracker_item_state", "tracker_connections", "watch_history"]) db.prepare(`DELETE FROM ${table}`).run();
  repo.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "isolation-account", accessToken: "t", refreshToken: "r",
    initialSyncMode: "import", accessTokenExpiresAt: Date.now() + 3600_000 });
  const connection = repo.getTrackerConnection("simkl", { includeCredentials: true });
  const other = (i, extra = {}) => ({ type: "movie", title: `Other ${i}`, ids: { tmdb: 700000 + i, imdb: `tt77000${i}` }, watched_at: when, ...extra });
  // Non-fixture rows in several shapes: coalesced future watched (30 min), watched already DUE,
  // manual-unwatch-like pending, a review row, and a decoy that mentions the fixture tmdb digits as free text.
  createTrackerWriteIntent({ provider: "simkl", connection, media: other(1), action: "watched" });
  createTrackerWriteIntent({ provider: "simkl", connection, media: other(2), action: "watched", dueAt: Date.now() - 60_000 });
  createTrackerWriteIntent({ provider: "simkl", connection, media: other(3, { title: "Carrie - S01E05" }), action: "unwatched" });
  createTrackerWriteIntent({ provider: "simkl", connection, media: other(4), action: "watched", status: "review" });
  createTrackerWriteIntent({ provider: "simkl", connection, media: other(9, { note: `unrelated text mentioning ${FIXTURE.tmdb}` }), action: "watched" });
  // A second provider's pending intents (rows only; no Trakt connection or request is involved).
  for (let i = 5; i <= 6; i++) {
    createTrackerWriteIntent({ provider: "trakt", connection: { id: "trakt-conn", remoteUserId: "trakt-account" }, media: other(i), action: i === 5 ? "unwatched" : "watched" });
  }
  // Observations for other titles: one pending, one observed.
  const envelope = (items, value) => ({ watched: items, ratings: [], unrated: [], review: [], activities: { all: value }, cursor: value, complete: true, absenceReconciliation: false });
  const watched = [1, 2].map((i) => ({ media: { type: "movie", mediaType: "movie", title: `Observed ${i}`, ids: { tmdb: String(710000 + i) }, source: "simkl" }, watchedAt: Date.parse("2026-10-01T12:00:00Z"), timestampProvenance: "observed" }));
  observations.persistSimklObservations(connection, envelope(watched, cursor));
  const [first] = db.prepare("SELECT id FROM tracker_observations ORDER BY id").all();
  db.prepare("UPDATE tracker_observations SET status='pending' WHERE id=?").run(first.id);
  return { connection };
}

async function withSimkl(handler, work) {
  const previous = globalThis.fetch, prevTimeout = globalThis.setTimeout;
  const calls = [];
  simklTransport.resetForTests();
  globalThis.setTimeout = (cb, delay, ...args) => prevTimeout(cb, delay >= 20_000 ? 5 : delay, ...args);
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.hostname, "api.simkl.com", "no other host may be contacted");
    calls.push([options.method, u.pathname]);
    const r = await handler(u, options, calls);
    if (!r.headers.has("x-ratelimit-remaining")) r.headers.set("x-ratelimit-remaining", "400");
    r.headers.set("x-ratelimit-limit", "500");
    return r;
  };
  try { await work(calls); } finally { globalThis.fetch = previous; globalThis.setTimeout = prevTimeout; simklTransport.resetForTests(); }
}
const posted = (calls) => calls.some((c) => c[1] === "/sync/history");
const successHandler = (u, options, calls) => {
  if (u.pathname === "/sync/history") return Response.json({ added: { movies: 1, episodes: 0 }, not_found: {} });
  if (u.pathname === "/sync/activities") return Response.json({ all: posted(calls) ? "2026-10-22T12:01:00Z" : cursor });
  if (u.pathname === "/sync/watched") return Response.json(JSON.parse(options.body).map(({ ids }) => ({ ids, result: true, list: "completed", last_watched_at: when })));
  return Response.json({});
};

test("fixture write settles while every non-fixture intent, observation and item-state row stays identical", async () => {
  const { connection } = seed();
  const before = snapshotUnrelated();
  assert.equal(before.intentIds.length, 7, "seeded non-fixture intents across both providers");
  assert.equal(before.obsIds.length, 2);
  const fixtureIntent = createTrackerWriteIntent({ provider: "simkl", connection, media: fixtureMedia(), action: "watched" });
  assert.deepEqual(snapshotUnrelated(), before, "creating the fixture intent alone changes no unrelated row");
  await withSimkl(successHandler, async (calls) => {
    await writeSimklWatched(connection, { ...fixtureMedia(), trackerWriteIntentId: fixtureIntent.id }, { trigger: "event", sendNow: true });
    assert.equal(calls.filter((c) => c[1] === "/sync/history").length, 1, "exactly one POST");
  });
  assert.equal(db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(fixtureIntent.id).status, "settled");
  assert.deepEqual(snapshotUnrelated(), before, "ids and full-row fingerprints identical after the fixture write");
});

test("fixture write that fails (injected 500) still leaves non-fixture rows identical", async () => {
  const { connection } = seed();
  const before = snapshotUnrelated();
  const fixtureIntent = createTrackerWriteIntent({ provider: "simkl", connection, media: fixtureMedia(), action: "watched" });
  await withSimkl((u, options, calls) => u.pathname === "/sync/history" ? Response.json({ error: "injected" }, { status: 500 }) : successHandler(u, options, calls), async () => {
    await assert.rejects(writeSimklWatched(connection, { ...fixtureMedia(), trackerWriteIntentId: fixtureIntent.id }, { trigger: "event", sendNow: true }));
  });
  assert.equal(db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(fixtureIntent.id).status, "review");
  assert.deepEqual(snapshotUnrelated(), before);
});

test("production fan-out dispatch for the fixture leaves non-fixture rows identical", async () => {
  seed();
  const before = snapshotUnrelated();
  let results;
  await withSimkl(successHandler, async (calls) => {
    results = await dispatchTrackerWatchState({ ...fixtureMedia(), source: "plex", syncTargets: ["simkl"] }, "watched", { lane: "sync" });
    assert.ok(calls.filter((c) => c[1] === "/sync/history").length <= 1);
  });
  assert.ok(Array.isArray(results) && results.length === 1 && results[0].target === "simkl", JSON.stringify(results));
  console.log("fan-out result:", JSON.stringify(results));
  assert.deepEqual(snapshotUnrelated(), before);
});

test("old runner comparison (JS id filter before, SQL LIKE after) can disagree with no row changing", () => {
  seed();
  // Copied from plan/active/external-tracker-connections/checks/phase-d-runner.mjs lines 69, 85-88 and 197-198.
  const f = { imdb: FIXTURE.imdb, tmdb: String(FIXTURE.tmdb) };
  const cols = "id,provider,action,media_json,status";
  const pendingAll = db.prepare(`SELECT ${cols} FROM tracker_write_intents WHERE status NOT IN ('settled','cancelled','rejected') ORDER BY id`).all();
  const before = sha(pendingAll.filter((r) => { const m = JSON.parse(r.media_json); return m?.ids?.imdb !== f.imdb && String(m?.ids?.tmdb || "") !== f.tmdb; }));
  const after = sha(db.prepare(`SELECT ${cols} FROM tracker_write_intents WHERE status NOT IN ('settled','cancelled','rejected') AND NOT (media_json LIKE ? OR media_json LIKE ?) ORDER BY id`).all(`%${f.imdb}%`, `%${f.tmdb}%`));
  // The seeded decoy only mentions the fixture tmdb digits as free text: kept by the id filter, dropped by LIKE.
  assert.notEqual(before, after, "same rows, no mutation, yet the old before/after hashes differ");
});

test("old runner fingerprint ignores updated_at, attempts and due_at but not a status change", () => {
  seed();
  const cols = "id,provider,action,media_json,status";
  const pick = () => sha(db.prepare(`SELECT ${cols} FROM tracker_write_intents ORDER BY id`).all());
  const before = pick();
  db.prepare("UPDATE tracker_write_intents SET updated_at=updated_at+5000, attempts=attempts+1, due_at=due_at+1").run();
  assert.equal(pick(), before, "timestamp/attempt churn cannot trip the old comparison");
  db.prepare("UPDATE tracker_write_intents SET status='review' WHERE status='pending' AND action='unwatched'").run();
  assert.notEqual(pick(), before, "but a status change on an unrelated row does");
});
