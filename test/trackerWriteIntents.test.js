import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-write-intents-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const ledger = await import("../server/src/utils/trackerWriteIntents.js");
const { trackerIntentRequest } = await import("../server/src/utils/trackerIntentRequest.js");
const { migrateLegacyTrackerIntents } = await import("../server/src/utils/trackerIntentMigration.js");
const adapter = (await import("../server/src/utils/trackers/registry.js")).getTrackerAdapter("trakt");
const media = (date = "2026-10-01T12:00:00.000Z") => ({ type: "movie", title: "Intent test", ids: { tmdb: "123" }, source: "plex", watched_at: date });
const connect = (remoteUserId = "account-a") => repo.saveTrackerConnection({ provider: "trakt", remoteUserId, accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
const get = (id) => db.prepare("SELECT * FROM tracker_write_intents WHERE id=?").get(id);
const create = (connection, item, id, now) => ledger.createTrackerWriteIntent({ provider: "trakt", connection, media: item, action: "watched", watchRecordId: id, now });
const reset = () => { for (const table of ["tracker_write_intents", "tracker_item_state", "tracker_play_history", "tracker_connections", "watch_history"]) db.prepare(`DELETE FROM ${table}`).run(); };
test.beforeEach(reset);

test("Simkl audited missing progress becomes a durable review hold, not a new preview send", async () => {
  const connection = repo.saveTrackerConnection({ provider: 'simkl', remoteUserId: 'simkl-account', accessToken: 'test', refreshToken: 'test', accessTokenExpiresAt: Date.now() + 3600000 });
  const item = { type: 'episode', title: 'Held episode', ids: { tvdb: '123' }, season: 1, episode: 2, watched_at: media().watched_at };
  const intent = ledger.createTrackerWriteIntent({ provider: 'simkl', connection, media: item, action: 'watched' });
  ledger.finishTrackerWriteIntent(intent.id, 'rejected', 'Not watched on Simkl current progress after resume audit; not resent');
  const now = Date.now() + 31 * 86400_000;
  ledger.maintainTrackerWriteIntents(now);
  assert.equal(get(intent.id).status, 'review');
  assert.equal(get(intent.id).settled_at, null);
  ledger.maintainTrackerWriteIntents(now + 31 * 86400_000);
  assert.equal(get(intent.id).status, 'review');
  const { buildTrackerFullSyncItems } = await import('../server/src/utils/trackers/fullSyncPlans.js');
  const rows = buildTrackerFullSyncItems('simkl', [item, { ...item, episode: 3 }], [], { writeHolds: [{ media: item, status: get(intent.id).status }] });
  assert.deepEqual(rows.map(row => row.selectable), [false, true]);
  assert.match(rows[0].reason, /Sync Attention/);
  assert.ok(ledger.trackerWriteAttentionItems().some(row => row.intentId === intent.id));
  ledger.cancelTrackerWriteIntent(intent.id);
  assert.equal(get(intent.id).status, 'cancelled');
});

test("catalogue rejection and another account's audit rejection keep their existing disposition", () => {
  const connection = connect();
  const intent = create(connection, media(), 'catalogue-reject');
  ledger.finishTrackerWriteIntent(intent.id, 'rejected', 'Not watched on Simkl current progress after full-apply audit (23 October); not resent');
  const simkl = repo.saveTrackerConnection({ provider: 'simkl', remoteUserId: 'simkl-account', accessToken: 'test', refreshToken: 'test', accessTokenExpiresAt: Date.now() + 3600000 });
  const rejected = ledger.createTrackerWriteIntent({ provider: 'simkl', connection: simkl, media: media(), action: 'watched' });
  ledger.finishTrackerWriteIntent(rejected.id, 'rejected', 'Simkl did not match this item');
  ledger.maintainTrackerWriteIntents();
  assert.equal(get(intent.id).status, 'rejected');
  assert.equal(get(rejected.id).status, 'rejected');
  db.prepare("UPDATE tracker_write_intents SET account_id='old-account',last_error='Not watched on Simkl current progress after resume audit; not resent' WHERE id=?").run(rejected.id);
  ledger.maintainTrackerWriteIntents();
  assert.equal(get(rejected.id).status, 'rejected');
});

test("lost response is correlated before retry, acknowledges exactly once and never posts twice", async () => {
  const connection = connect();
  const item = { ...media(), watchRecordId: "local-play" };
  let posts = 0;
  const send = async () => { posts++; throw new Error("Response lost after remote commit"); };
  await assert.rejects(trackerIntentRequest(connection, [item], "watched", send, async () => []));
  const intent = db.prepare("SELECT * FROM tracker_write_intents").get();
  assert.equal(intent.status, "uncertain");
  await trackerIntentRequest(connection, [{ ...item, trackerWriteIntentId: intent.id }], "watched", send,
    async () => [{ historyId: "remote-play", media: item, watchedAt: Date.parse(item.watched_at) }]);
  assert.equal(posts, 1);
  assert.equal(get(intent.id).status, "settled");
  assert.equal(get(intent.id).remote_event_id, "remote-play");
  assert.equal(db.prepare("SELECT watch_record_id FROM tracker_play_history").get().watch_record_id, "local-play");
  assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId: "remote-play", media: item, watchedAt: Date.parse(item.watched_at) }).status, "known");
});

test("independent plays survive snapshot replacement, recovery and out-of-order echoes", () => {
  const connection = connect();
  const first = create(connection, media(), "first");
  const secondMedia = media("2026-10-02T12:00:00.000Z");
  const second = create(connection, secondMedia, "second");
  assert.notEqual(first.id, second.id);
  assert.equal(create(connection, media(), "first").id, first.id);
  ledger.claimTrackerWriteIntent(first.id);
  ledger.claimTrackerWriteIntent(second.id);
  ledger.maintainTrackerWriteIntents(Date.now() + 6 * 60_000);
  repo.replaceTrackerSnapshot("trakt", []);
  assert.equal(get(first.id).status, "uncertain");
  for (const [intent, item, historyId] of [[second, secondMedia, "second-remote"], [first, media(), "first-remote"]]) {
    assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId, media: item, watchedAt: Date.parse(item.watched_at) }).intentId, intent.id);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_play_history").get().n, 2);
  assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId: "genuine-new", media: media(), watchedAt: Date.parse("2026-10-03T12:00:00Z") }).status, "unmatched");
});

test("ambiguous dates hold all competing intents without acknowledging the event", async () => {
  const connection = connect();
  const a = create(connection, media(), "a");
  const b = create(connection, media(), "b");
  const result = ledger.correlateTrackerObservation("trakt", connection, { historyId: "ambiguous", media: media(), watchedAt: Date.parse(media().watched_at) });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(new Set(result.intentIds), new Set([a.id, b.id]));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_play_history").get().n, 0);
  let posts = 0;
  await assert.rejects(trackerIntentRequest(connection, [{ ...media(), trackerWriteIntentId: a.id }], "watched", async () => { posts++; }, async () => []));
  assert.equal(posts, 0);
  assert.equal(ledger.trackerWriteAttentionItems().length, 2);
});

test("an uncertain write is resent only after history proves it never landed", async () => {
  const connection = connect();
  const intent = create(connection, media(), "a");
  ledger.finishTrackerWriteIntent(intent.id, "uncertain");
  let posts = 0;
  const send = async () => { posts++; return { added: { movies: 1 }, not_found: {} }; };
  await assert.rejects(trackerIntentRequest(connection, [{ ...media(), trackerWriteIntentId: intent.id }], "watched", send, async () => { throw new Error("history unavailable"); }));
  assert.equal(posts, 0);
  assert.equal(get(intent.id).status, "uncertain");
  await trackerIntentRequest(connection, [{ ...media(), trackerWriteIntentId: intent.id }], "watched", send, async () => []);
  assert.equal(posts, 1);
  assert.equal(get(intent.id).status, "settled");
});

test("a provider match failure can be resent; a cancelled review write cannot", async () => {
  const connection = connect();
  const intent = create(connection, media(), "a");
  let posts = 0;
  await trackerIntentRequest(connection, [{ ...media(), watchRecordId: "a" }], "watched", async () => { posts++; return { not_found: { movies: [{ ids: { tmdb: "123" } }] } }; }, async () => []);
  assert.equal(get(intent.id).status, "rejected");
  await trackerIntentRequest(connection, [{ ...media(), ids: { tmdb: "456" }, watchRecordId: "a" }], "watched", async (items) => { posts++; assert.equal(items[0].ids.tmdb, "456"); return { added: { movies: 1 } }; }, async () => []);
  assert.equal(posts, 2);
  assert.equal(get(intent.id).status, "settled");
  const held = create(connection, media("2026-10-05T12:00:00.000Z"), "held");
  ledger.finishTrackerWriteIntent(held.id, "review", "Ambiguous");
  assert.equal(ledger.trackerWriteAttentionItems()[0].canSkip, true, "Sync Attention only accepts skips for skippable items");
  assert.equal(ledger.cancelTrackerWriteIntent(held.id), true);
  await assert.rejects(trackerIntentRequest(connection, [{ ...media(), trackerWriteIntentId: held.id }], "watched", async () => { posts++; }, async () => []), /cancelled/);
  assert.equal(posts, 2);
  assert.equal(ledger.trackerWriteAttentionItems().length, 0);
});

test("30-day cleanup removes settled intents, retains permanent acknowledgements and surfaces unresolved work", () => {
  const connection = connect();
  const now = Date.now();
  const old = now - ledger.TRACKER_INTENT_RETENTION_MS - 1000;
  const settled = create(connection, media(), "settled", old);
  const pending = create(connection, media(), "pending", old);
  ledger.correlateTrackerObservation("trakt", connection, { historyId: "known", media: media(), watchedAt: Date.parse(media().watched_at) + 120_000 });
  ledger.finishTrackerWriteIntent(settled.id, "settled");
  db.prepare("UPDATE tracker_write_intents SET settled_at=? WHERE id=?").run(old, settled.id);
  repo.recordTrackerPlay("trakt", { historyId: "permanent", mediaKey: adapter.identity.key(media()), watchedAt: media().watched_at, watchRecordId: "settled" });
  ledger.maintainTrackerWriteIntents(now);
  assert.equal(get(settled.id), undefined);
  assert.equal(get(pending.id).status, "review");
  assert.equal(ledger.trackerWriteAttentionItems().length, 1);
  assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId: "permanent", media: media(), watchedAt: Date.parse(media().watched_at) }).status, "known");
});

test("account replacement clears old ledger; same account refresh preserves it", () => {
  const a = connect();
  const intent = create(a, media(), "a");
  assert.equal(connect().id, a.id);
  assert.ok(get(intent.id));
  const b = connect("account-b");
  assert.notEqual(b.id, a.id);
  assert.equal(b.baselineComplete, false);
  assert.equal(get(intent.id), undefined);
  assert.equal(ledger.trackerIntentConnectionCurrent(intent), false);
  assert.equal(ledger.correlateTrackerObservation("trakt", a, { historyId: "late", media: media(), watchedAt: Date.parse(media().watched_at) }).status, "stale");
});

test("destination capture is transactional and settled imports never acquire eligibility", () => {
  connect();
  assert.throws(() => db.transaction(() => { ledger.captureTrackerDestinations(media(), "rolled-back"); throw new Error("rollback"); })());
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 0);
  assert.equal(ledger.captureTrackerDestinations({ ...media(), sync_dispatch_telemetry: "Dispatch status: success" }, "settled").length, 0);
  assert.equal(ledger.captureTrackerDestinations({ ...media(), source: "trakt_import" }, "imported").length, 0);
  assert.equal(ledger.captureTrackerDestinations(media(), "new").length, 1);
});

test("legacy upgrade migrates known pending work only and quarantines missing destinations", () => {
  connect();
  const insert = db.prepare("INSERT INTO watch_history (id,title,media_type,source,watched_at,sync_action,sync_dispatch_telemetry,created_at,updated_at) VALUES (?,?,'movie','plex',?,'watched',?,1,1)");
  for (const [id, telemetry] of [["settled", "Target trakt status: success"], ["missing", "Dispatch status: success"], ["pending", "Target trakt status: pending"], ["ambiguous", "Dispatch status: pending"], ["uncertain", "Target trakt status: error - upstream request timed out"]]) insert.run(id, id, media().watched_at, telemetry);
  migrateLegacyTrackerIntents(db);
  migrateLegacyTrackerIntents(db);
  const rows = db.prepare("SELECT watch_record_id,status FROM tracker_write_intents ORDER BY watch_record_id").all();
  assert.deepEqual(rows, [{ watch_record_id: "ambiguous", status: "review" }, { watch_record_id: "pending", status: "pending" }, { watch_record_id: "uncertain", status: "uncertain" }]);
});
