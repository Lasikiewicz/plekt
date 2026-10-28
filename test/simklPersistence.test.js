import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-persistence-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const observations = await import("../server/src/utils/trackers/simklObservations.js");
const { syncSimklObservations } = await import("../server/src/utils/trackers/simklSync.js");
const { dispatchSimklWatchState } = await import("../server/src/utils/trackers/simklDispatch.js");
const { captureTrackerDestinations } = await import("../server/src/utils/trackerWriteIntents.js");
const { isTrackerProvider, getTrackerAdapter } = await import("../server/src/utils/trackers/registry.js");
const { TARGET_DECISIONS } = await import("../server/src/utils/watchSyncPolicy.js");
const cursor = "2026-10-21T12:00:00Z", later = "2026-10-21T13:00:00Z";
const date = "2026-10-01T12:00:00Z";
const media = (id = 1) => ({ type: "movie", mediaType: "movie", title: `Movie ${id}`, ids: { tmdb: String(id) }, source: "simkl" });
const watched = (id = 1) => ({ media: media(id), watchedAt: Date.parse(date), timestampProvenance: "observed" });
const envelope = (items = [], next = cursor, complete = true) => ({ watched: items, ratings: [], review: [], activities: { all: next }, cursor: next, complete, absenceReconciliation: false });
function connect(mode = "baseline", account = "account") {
  repo.deleteTrackerConnection("simkl");
  return repo.saveTrackerConnection({ provider: "simkl", clientId: "client", accessToken: "private", refreshToken: "private-refresh", remoteUserId: account,
    initialSyncMode: mode, accessTokenExpiresAt: Date.now() + 3600_000 });
}

test("Simkl baseline is persisted without importing old history; deltas merge and never remove omissions", () => {
  const connection = connect();
  assert.deepEqual(observations.persistSimklObservations(connection, envelope([watched()])), []);
  assert.equal(observations.simklObservationCursor(connection), cursor);
  assert.equal(repo.getTrackerConnection("simkl").baselineComplete, true);
  observations.persistSimklObservations(connection, envelope([watched(2)], later, false), { expectedCursor: cursor });
  const pending = observations.pendingSimklObservations(connection);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].observation.media.ids.tmdb, "2");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations").get().n, 2);
  observations.persistSimklObservations(connection, envelope([], later, false), { expectedCursor: later });
  assert.equal(observations.pendingSimklObservations(connection).length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, 0);
});

test("legacy Simkl import inbox survives unchanged activity until preview approval", () => {
  const connection = connect("import");
  observations.persistSimklObservations(connection, envelope([watched()]));
  const observed = db.prepare("SELECT id,observation_json FROM tracker_observations WHERE kind='watched'").get();
  const legacyImport = { ...JSON.parse(observed.observation_json), syncIntent: "import" };
  db.prepare("UPDATE tracker_observations SET status='pending',observation_json=? WHERE id=?").run(JSON.stringify(legacyImport), observed.id);
  const [row] = observations.pendingSimklObservations(connection);
  assert.equal(row.observation.syncIntent, "import");
  observations.persistSimklObservations(connection, envelope([], cursor, false), { expectedCursor: cursor });
  assert.equal(observations.pendingSimklObservations(connection)[0].id, row.id);
  assert.equal(observations.completeSimklObservation(connection, row.id), true, "explicit preview approval acknowledges the staged import");
  observations.persistSimklObservations(connection, envelope([{ ...watched(), watchedAt: Date.parse(later) }], later, false), { expectedCursor: cursor });
  assert.equal(observations.pendingSimklObservations(connection).length, 0);
});

test("identity enrichment cannot create a second pending import or revive acknowledged work", () => {
  for (const acknowledge of [false, true]) {
    const connection = connect("import");
    const original = { ...watched(), media: { ...media(), ids: { imdb: "tt0000001" } } };
    observations.persistSimklObservations(connection, envelope([original]));
    const stored = db.prepare("SELECT id,observation_json FROM tracker_observations WHERE kind='watched'").get();
    db.prepare("UPDATE tracker_observations SET status='pending',observation_json=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(stored.observation_json), syncIntent: "import" }), stored.id);
    const [row] = observations.pendingSimklObservations(connection);
    if (acknowledge) observations.completeSimklObservation(connection, row.id);
    const enriched = { ...original, media: { ...original.media, ids: { tmdb: "1", imdb: "tt0000001" } } };
    observations.persistSimklObservations(connection, envelope([enriched], later, false), { expectedCursor: cursor });
    const pending = observations.pendingSimklObservations(connection);
    assert.equal(pending.length, acknowledge ? 0 : 1);
    if (!acknowledge) assert.equal(pending[0].id, row.id);
  }
});

test("invalid, stale-cursor and out-of-order envelopes atomically keep previous state", () => {
  const connection = connect("import");
  observations.persistSimklObservations(connection, envelope([watched()]));
  for (const [snapshot, expectedCursor] of [
    [envelope([watched(2)], later, false), null],
    [envelope([watched(2)], date, false), cursor],
    [{ ...envelope([watched(2)], later, false), review: [{ media: {}, reason: "invalid" }] }, cursor],
    [{ ...envelope([watched(2)], later, false), absenceReconciliation: true }, cursor],
  ]) assert.throws(() => observations.persistSimklObservations(connection, snapshot, { expectedCursor }), { code: "TRACKER_REVIEW_REQUIRED" });
  assert.equal(observations.simklObservationCursor(connection), cursor);
  assert.equal(observations.pendingSimklObservations(connection).length, 0);
});

test("baseline review evidence stays out of attention while new unsafe deltas remain visible", () => {
  const connection = connect("import");
  const snapshot = envelope([{ ...watched(), watchedAt: null, timestampProvenance: "unknown" },
    { ...watched(2), media: { ...media(2), ids: { simkl: "9" } } }, watched(3)]);
  snapshot.review = [{ media: media(3), reason: "rating_watch_ambiguity" }];
  snapshot.ratings = [{ media: { title: "Rated movie", media_type: "movie" }, providerItemId: "10", rating: 8, ratedAt: null }];
  observations.persistSimklObservations(connection, snapshot);
  assert.equal(observations.pendingSimklObservations(connection).length, 0);
  assert.equal(observations.simklObservationAttentionItems().length, 0, "baseline review evidence does not create a permanent attention queue");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations WHERE status='review'").get().n, 4, "unsafe baseline evidence remains retained");
  const delta = envelope([], later, false);
  delta.review = [{ media: media(4), reason: "episode_mapping_required" }];
  observations.persistSimklObservations(connection, delta, { expectedCursor: cursor });
  const attention = observations.simklObservationAttentionItems();
  assert.equal(attention.length, 1, "a new unsafe delta remains actionable");
  assert.equal(attention[0].title, "Simkl: Movie 4");
  assert.ok(attention.every((item) => item.canSkip && item.source === "tracker_observation"));
  assert.equal(observations.dismissSimklObservation(attention[0].id.replace("simkl-observation-", "")), true);
  assert.equal(observations.simklObservationAttentionItems().length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
});

test("replacement accounts and disconnect clear only their own cursor/inbox and reject late work", () => {
  const old = connect("import");
  observations.persistSimklObservations(old, envelope([watched()]));
  const replacement = repo.saveTrackerConnection({ provider: "simkl", remoteUserId: "replacement", accessToken: "new", refreshToken: "new-refresh", clientId: "client" });
  assert.equal(observations.simklObservationCursor(replacement), null);
  assert.equal(observations.pendingSimklObservations(replacement).length, 0);
  assert.throws(() => observations.persistSimklObservations(old, envelope([watched(2)])), { code: "TRACKER_CONNECTION_STALE" });
  observations.persistSimklObservations(replacement, envelope([watched(2)]));
  repo.deleteTrackerConnection("simkl");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_observations").get().n, 0);
});

test("activated integration rejects scheduled reads before networking and joins destination capture", async () => {
  connect();
  assert.equal(isTrackerProvider("simkl"), true);
  assert.equal(getTrackerAdapter("simkl").id, "simkl");
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not network"); };
  try {
    await assert.rejects(syncSimklObservations({ trigger: "scheduled" }), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  } finally { globalThis.fetch = original; }
  assert.deepEqual(captureTrackerDestinations({ ...media(), watched_at: date, source: "plex" }, "record").map(({ provider }) => provider), ["simkl"]);
});

test("dispatch creates durable current-account work and preserves an already watched remote item", async () => {
  connect();
  const connected = repo.getTrackerConnection('simkl');
  db.prepare(`INSERT INTO tracker_observations (id,provider,connection_id,account_id,observation_key,kind,observation_json,status,reason,created_at,updated_at)
    VALUES ('batch-already-seen','simkl',?,?,'watched:movie:tmdb:1','watched',?,'observed','',0,0)`)
    .run(connected.id, connected.remoteUserId, JSON.stringify({media:media(),watchedAt:Date.parse(date)}));
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") posts++;
    const path = new URL(url).pathname;
    if (path === "/sync/activities") return Response.json({ all: cursor });
    const type = path.split("/")[3];
    return Response.json({ [type]: type === "movies" ? [{ movie: { title: "Movie", ids: { tmdb: 1 } }, status: "completed", last_watched_at: date }] : [] });
  };
  try {
    const result = await dispatchSimklWatchState({ ...media(), watched_at: date, watchRecordId: "record", simklSendNow: true }, "watched", "sync");
    assert.equal(result.status, "success");
    assert.equal(posts, 0);
    const intent = db.prepare("SELECT * FROM tracker_write_intents").get();
    assert.equal(intent.status, "settled");
    assert.equal(intent.watched_at, date.replace("Z", ".000Z"));
    assert.equal(observations.simklObservationCursor(repo.getTrackerConnection("simkl")), null);
  } finally { globalThis.fetch = original; }
});

test("unwatches are a terminal policy skip and undated plays hold, both without provider calls", async () => {
  connect();
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not network"); };
  try {
    const skipped = await dispatchSimklWatchState({ ...media(), watched_at: date, watchRecordId: "unwatch" }, "unwatched", "sync");
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.decision, TARGET_DECISIONS.SKIPPED_BY_POLICY);
    assert.equal(skipped.dismissed, true);
    await assert.rejects(dispatchSimklWatchState({ ...media(2), watchRecordId: "undated" }, "watched", "sync"), { code: "TRACKER_REVIEW_REQUIRED" });
    const intents = await import("../server/src/utils/trackerWriteIntents.js");
    const attention = intents.trackerWriteAttentionItems();
    assert.equal(attention.length, 1);
    assert.match(attention[0].reason, /^Not sent: Simkl needs an observed watch date/);
    assert.match(attention[0].explanation, /before contacting Simkl.*It was not sent/);
    const statuses = db.prepare("SELECT status FROM tracker_write_intents ORDER BY id").all().map((row) => row.status).sort();
    assert.deepEqual(statuses, ["cancelled", "review"]);
  } finally { globalThis.fetch = original; }
});

test("full backups preserve cursor/review decisions and quarantine restored unfinished work", async () => {
  const connection = connect("import");
  observations.persistSimklObservations(connection, envelope([watched()]));
  await assert.rejects(dispatchSimklWatchState({ ...media(2), watchRecordId: "held" }, "watched", "sync"));
  const backup = await import("../server/src/utils/backup.js");
  const saved = backup.getFullBackup();
  assert.equal(saved.collections.trackerObservationCursors.length, 1);
  assert.equal(saved.collections.trackerObservations.length, 1);
  assert.equal(saved.collections.trackerWriteIntents.length, 1);
  assert.ok(!backup.BROWSER_BACKUP_COLLECTIONS.includes("trackerObservations"));
  for (const name of ["trackerObservationCursors", "trackerObservations", "trackerWriteIntents"]) {
    backup.importCollectionBatch(name, saved.collections[name], { reset: true });
  }
  assert.equal(observations.simklObservationCursor(connection), cursor);
  assert.equal(observations.pendingSimklObservations(connection).length, 0);
  assert.equal(observations.simklObservationAttentionItems().length, 0, "observed baseline history remains ledger evidence, not pending attention");
  assert.equal(db.prepare("SELECT status FROM tracker_observations").get().status, "observed");
  assert.equal(db.prepare("SELECT status FROM tracker_write_intents").get().status, "review");
});

test("expired Simkl send leases become visible review without retry activation or another dispatch", async () => {
  const connection = connect();
  const intents = await import("../server/src/utils/trackerWriteIntents.js");
  const intent = intents.createTrackerWriteIntent({ provider: "simkl", connection, media: { ...media(), watched_at: date }, action: "watched" });
  db.prepare("UPDATE tracker_write_intents SET status='sending',due_at=? WHERE id=?").run(Date.now() + 60_000, intent.id);
  assert.equal(intents.trackerWriteAttentionItems().filter((item) => item.intentId === intent.id).length, 0);
  db.prepare("UPDATE tracker_write_intents SET due_at=0 WHERE id=?").run(intent.id);
  assert.equal(intents.trackerWriteAttentionItems().filter((item) => item.intentId === intent.id).length, 1);
  assert.equal(db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(intent.id).status, "review");
  assert.deepEqual(intents.listDueTrackerWriteIntents(), []);
});
