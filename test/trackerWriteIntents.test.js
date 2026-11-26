import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-write-intents-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const ledger = await import("../server/src/utils/trackerWriteIntents.js");
const { syncPendingTrackerWriteIntents } = await import("../server/src/utils/trackerIntentWorker.js");
const { trackerIntentRequest } = await import("../server/src/utils/trackerIntentRequest.js");
const { cancelSelectedTrackerWrites, recheckAllTrackerWrites } = await import("../server/src/utils/trackerWriteReviewActions.js");
const { migrateLegacyTrackerIntents } = await import("../server/src/utils/trackerIntentMigration.js");
const adapter = (await import("../server/src/utils/trackers/registry.js")).getTrackerAdapter("trakt");
const media = (date = "2026-10-01T12:00:00.000Z") => ({ type: "movie", title: "Intent test", ids: { tmdb: "123" }, source: "plex", watched_at: date });
const connect = (remoteUserId = "account-a") => repo.saveTrackerConnection({ provider: "trakt", remoteUserId, accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
const get = (id) => db.prepare("SELECT * FROM tracker_write_intents WHERE id=?").get(id);
const create = (connection, item, id, now) => ledger.createTrackerWriteIntent({ provider: "trakt", connection, media: item, action: "watched", watchRecordId: id, now });
const reset = () => { for (const table of ["tracker_write_intents", "tracker_item_state", "tracker_play_history", "tracker_connections", "watch_history"]) db.prepare(`DELETE FROM ${table}`).run(); };
test.beforeEach(reset);

test("bulk cancellation affects only selected held writes", () => {
  const connection = connect();
  const selected = create(connection, media(), "selected");
  const alsoSelected = create(connection, media(), "also-selected");
  const unselected = create(connection, media(), "unselected");
  const pending = create(connection, media(), "pending");
  for (const item of [selected, alsoSelected, unselected]) ledger.finishTrackerWriteIntent(item.id, "review");
  assert.equal(cancelSelectedTrackerWrites([selected, alsoSelected, pending].map(({ id }) => `tracker-intent-${id}`)), 2);
  assert.equal(get(selected.id).status, "cancelled");
  assert.equal(get(alsoSelected.id).status, "cancelled");
  assert.equal(get(unselected.id).status, "review");
  assert.equal(get(pending.id).status, "pending");
});

test("recheck all verifies competing Trakt writes for one local play without sending them", async (t) => {
  const connection = repo.saveTrackerConnection({
    provider: "trakt", remoteUserId: "offline-account", clientId: "offline-client",
    accessToken: "offline-token", refreshToken: "offline-refresh", accessTokenExpiresAt: Date.now() + 3600000,
  });
  const watch = media();
  const intents = ["first", "second"].map((logicalKey) => ledger.createTrackerWriteIntent({
    provider: "trakt", connection, media: watch, action: "watched", watchRecordId: "same-local-watch", logicalKey,
  }));
  const reason = `Ambiguous provider event 9876; competing intents: ${intents.map(({ id }) => id).join(", ")}`;
  for (const { id } of intents) ledger.finishTrackerWriteIntent(id, "review", reason);
  const previousFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, options) => {
    requests.push([new URL(url).pathname, options.method]);
    return Response.json([{ id: 9876, watched_at: watch.watched_at,
      movie: { title: watch.title, ids: { tmdb: 123 } } }]);
  };
  const result = await recheckAllTrackerWrites();
  assert.deepEqual(result, { confirmed: 2, remaining: 0, errors: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "/sync/history/movies");
  assert.equal(requests[0][1] || "GET", "GET");
  assert.ok(intents.every(({ id }) => get(id).status === "settled"));
});

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

test("an Activity retry reopens only a Simkl write that validation stopped before any send", () => {
  const connection = repo.saveTrackerConnection({ provider: 'simkl', remoteUserId: 'simkl-account', accessToken: 'test', refreshToken: 'test', accessTokenExpiresAt: Date.now() + 3600000 });
  const bare = { type: 'movie', title: 'Tenet', ids: {}, source: 'plex', watched_at: media().watched_at };
  const resolved = { ...bare, ids: { imdb: 'tt6723592', tmdb: '577922' } };
  const unsent = ledger.createTrackerWriteIntent({ provider: 'simkl', connection, media: bare, action: 'watched', watchRecordId: 'unsent' });
  ledger.finishTrackerWriteIntent(unsent.id, 'cancelled', 'Not sent: Simkl needs a verified media identity');
  const reopened = ledger.reopenUnsentTrackerWriteIntent(get(unsent.id), resolved);
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.last_error, '');
  assert.deepEqual(JSON.parse(reopened.media_json).ids, resolved.ids);
  assert.ok(reopened.due_at > Date.now());

  const attempted = ledger.createTrackerWriteIntent({ provider: 'simkl', connection, media: bare, action: 'watched', watchRecordId: 'attempted' });
  db.prepare("UPDATE tracker_write_intents SET attempts=1 WHERE id=?").run(attempted.id);
  ledger.finishTrackerWriteIntent(attempted.id, 'review', 'Not sent: Simkl needs a verified media identity');
  assert.equal(ledger.reopenUnsentTrackerWriteIntent(get(attempted.id), resolved).status, 'review');
  const unwatchPolicy = ledger.createTrackerWriteIntent({ provider: 'simkl', connection, media: bare, action: 'watched', watchRecordId: 'policy' });
  ledger.finishTrackerWriteIntent(unwatchPolicy.id, 'cancelled', 'Simkl unwatches are not sent');
  assert.equal(ledger.reopenUnsentTrackerWriteIntent(get(unwatchPolicy.id), resolved).status, 'cancelled');
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

test("a dispatch without its row id sends the intent captured for that play, so the echo is not ambiguous", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  let posts = 0;
  await trackerIntentRequest(connection, [media()], "watched", async () => { posts++; return {}; }, async () => []);
  assert.equal(posts, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 1);
  assert.equal(get(captured.id).status, "settled");
  const echo = ledger.correlateTrackerObservation("trakt", connection, { historyId: "one-play", media: media(), watchedAt: Date.parse(media().watched_at) });
  assert.equal(echo.status, "acknowledged");
  assert.equal(ledger.trackerWriteAttentionItems().length, 0);
});

test("dispatch with a watch record but no date reuses its captured intent", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  const { watched_at, ...undated } = media();
  let sent;
  await trackerIntentRequest(connection, [{ ...undated, watchRecordId: "local-play" }], "watched", async (items) => { sent = items; return {}; }, async () => []);
  assert.equal(sent[0].watched_at, watched_at);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 1);
  assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId: "one-play", media: media(), watchedAt: Date.parse(watched_at) }).intentId, captured.id);
});

test("an undated replay of a settled watch record still sends, so a canonical remove is re-added", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(captured.id, "settled");
  const { watched_at, ...undated } = media();
  let posts = 0;
  await trackerIntentRequest(connection, [{ ...undated, watchRecordId: "local-play" }], "watched", async () => { posts++; return {}; }, async () => []);
  assert.equal(posts, 1);
});

test("a dated canonical replay of a settled watch record still sends its add after the remove", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(captured.id, "settled");
  let posts = 0;
  await trackerIntentRequest(connection, [{ ...media(), watchRecordId: "local-play" }], "watched", async () => { posts++; return {}; }, async () => [], { replay: true });
  assert.equal(posts, 1);
  assert.equal(get(captured.id).status, "settled");
});

test("a repeat canonical replay sends its remove and its add again, each after settling", async () => {
  const connection = connect();
  const watched = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(watched.id, "settled");
  const sent = [];
  const send = (action) => async (items) => { sent.push([action, items.length]); return {}; };
  const replay = (action) => trackerIntentRequest(connection, [{ ...media(), source: "manual", watchRecordId: "local-play" }], action, send(action), async () => [], { replay: true });
  await replay("unwatched");
  await replay("watched");
  ledger.finishTrackerWriteIntent(db.prepare("SELECT id FROM tracker_write_intents WHERE action='unwatched'").get().id, "settled");
  ledger.finishTrackerWriteIntent(watched.id, "settled");
  await replay("unwatched");
  await replay("watched");
  assert.deepEqual(sent, [["unwatched", 1], ["watched", 1], ["unwatched", 1], ["watched", 1]]);
});

test("a settled watch is not resent when the dispatch is not a canonical replay", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(captured.id, "settled");
  let posts = 0;
  await trackerIntentRequest(connection, [{ ...media(), watchRecordId: "local-play" }], "watched", async () => { posts++; return {}; }, async () => []);
  assert.equal(posts, 0);
});

test("every ingest path that saves a watch dispatches with its record id", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["../server/src/scheduler.js", "../server/src/utils/recentWatchImport.js", "../server/src/routes/sync.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const blocks = [...source.matchAll(/const (\w+) = (?:await insertWatchRecord\([^\n]*|insertOutcome\.result;)\n(?:[^\n]*\n){0,6}?[^\n]*syncMediaPlaystate\(([^\n]*)/g)];
    assert.ok(blocks.length, file);
    for (const [block, id] of blocks) assert.match(block, new RegExp(`watchRecordId(: |\\s*=\\s*)${id}\\.id|watchRecordId = id`), block);
  }
});

test("a dispatch whose identity changed after capture keeps one intent when it carries the record id", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  const rewritten = { ...media(), ids: { imdb: "tt123", tmdb: "123" }, watchRecordId: "local-play" };
  await trackerIntentRequest(connection, [rewritten], "watched", async () => ({}), async () => []);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 1);
  assert.equal(ledger.correlateTrackerObservation("trakt", connection, { historyId: "one-play", media: rewritten, watchedAt: Date.parse(media().watched_at) }).intentId, captured.id);
});

test("a captured intent is only reused for the same unsent play", async () => {
  const connection = connect();
  const send = async () => ({});
  const captured = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(captured.id, "settled");
  await trackerIntentRequest(connection, [media()], "watched", send, async () => []);
  const pending = create(connection, media("2026-10-02T12:00:00.000Z"), "other-play");
  await trackerIntentRequest(connection, [media("2026-10-02T12:00:01.000Z")], "watched", send, async () => []);
  await trackerIntentRequest(connection, [{ ...media("2026-10-02T12:00:00.000Z"), trackerActionId: "manual-action" }], "watched", send, async () => []);
  assert.equal(get(pending.id).status, "pending");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tracker_write_intents").get().n, 5);
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

test("a partial Trakt not_found result settles accepted items and retries only the unmatched item", async () => {
  const connection = connect();
  const accepted = { ...media(), ids: { tmdb: "123" }, watchRecordId: "accepted" };
  const rejected = { ...media(), ids: { tmdb: "456" }, watchRecordId: "rejected" };
  const secondAccepted = { ...media(), ids: { tmdb: "789" }, watchRecordId: "second-accepted" };
  const acceptedIntent = create(connection, accepted, "accepted");
  const secondAcceptedIntent = create(connection, secondAccepted, "second-accepted");
  const rejectedIntent = create(connection, rejected, "rejected");

  await trackerIntentRequest(connection, [accepted, rejected, secondAccepted], "watched", async (items) => {
    assert.equal(items.length, 3);
    return { added: { movies: 2 }, not_found: { movies: [{ ids: { tmdb: "456" } }] } };
  }, async () => []);
  assert.equal(get(acceptedIntent.id).status, "settled");
  assert.equal(get(secondAcceptedIntent.id).status, "settled");
  assert.equal(get(rejectedIntent.id).status, "rejected");

  let retryItems;
  await trackerIntentRequest(connection, [accepted, rejected, secondAccepted], "watched", async (items) => {
    retryItems = items;
    return { added: { movies: 1 }, not_found: {} };
  }, async () => []);
  assert.equal(retryItems.length, 1);
  assert.equal(retryItems[0].ids.tmdb, "456");
  assert.equal(get(acceptedIntent.id).status, "settled");
  assert.equal(get(rejectedIntent.id).status, "settled");
});

test("a partly identifiable not_found response holds every write for review", async () => {
  const connection = connect();
  const items = ["123", "456", "789"].map((tmdb, index) => ({ ...media(), ids: { tmdb }, watchRecordId: `mixed-${index}` }));
  const intents = items.map(item => create(connection, item, item.watchRecordId));
  await trackerIntentRequest(connection, items, "watched", async () => ({ not_found: { movies: [{ ids: { tmdb: "456" } }, { ids: { tmdb: "unknown" } }] } }), async () => []);
  assert.deepEqual(intents.map(intent => get(intent.id).status), ["review", "review", "review"]);
});

test("unidentifiable Trakt not_found results hold the batch for review", async () => {
  const connection = connect();
  const a = create(connection, { ...media(), watchRecordId: "a" }, "a");
  const b = create(connection, { ...media("2026-10-02T12:00:00.000Z"), watchRecordId: "b" }, "b");
  await trackerIntentRequest(connection, [
    { ...media(), watchRecordId: "a" },
    { ...media("2026-10-02T12:00:00.000Z"), watchRecordId: "b" },
  ], "watched", async () => ({ not_found: { movies: [{ ids: { tmdb: "unknown" } }] } }), async () => []);
  assert.equal(get(a.id).status, "review");
  assert.equal(get(b.id).status, "review");
});

test("one throwing tracker intent is held for review and the worker continues", async () => {
  const connection = connect();
  const broken = create(connection, { ...media(), watchRecordId: "broken" }, "broken", Date.now() - 10);
  const next = create(connection, { ...media("2026-10-02T12:00:00.000Z"), source: "webhook", watchRecordId: "next" }, "next", Date.now());
  db.prepare("UPDATE tracker_write_intents SET media_json='{' WHERE id=?").run(broken.id);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url) === "https://api.trakt.tv/sync/history") {
      return new Response(JSON.stringify({ added: { movies: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  };
  try {
    await syncPendingTrackerWriteIntents(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(get(broken.id).status, "review");
  assert.equal(get(next.id).status, "settled");
  assert.deepEqual(requests, ["https://api.trakt.tv/sync/history"]);
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

test("automatic discovery throttles pruning but still reviews expired pending writes", () => {
  const connection = connect();
  const now = Date.now();
  ledger.maintainTrackerWriteIntents(now);
  const old = now - ledger.TRACKER_INTENT_RETENTION_MS - 1000;
  const settled = create(connection, media(), "throttled-settled", old);
  const pending = create(connection, media(), "throttled-pending", old);
  ledger.finishTrackerWriteIntent(settled.id, "settled");
  db.prepare("UPDATE tracker_write_intents SET settled_at=? WHERE id=?").run(old, settled.id);
  ledger.listDueTrackerWriteIntents(now + 1000);
  assert.equal(get(settled.id).status, "settled");
  assert.equal(get(pending.id).status, "review");
  ledger.listDueTrackerWriteIntents(now + 5 * 60_000);
  assert.equal(get(settled.id), undefined);
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

test("a dispatch whose every item is already settled reports alreadySent without sending", async () => {
  const connection = connect();
  const captured = create(connection, media(), "local-play");
  ledger.finishTrackerWriteIntent(captured.id, "settled");
  let posts = 0;
  const result = await trackerIntentRequest(connection, [{ ...media(), watchRecordId: "local-play" }], "watched", async () => { posts++; return {}; }, async () => []);
  assert.equal(posts, 0);
  assert.equal(result.alreadySent, true);
});

test("worker automatically rechecks due held Trakt writes and defers inconclusive ones", async (t) => {
  const connection = repo.saveTrackerConnection({
    provider: "trakt", remoteUserId: "auto-recheck-account", clientId: "offline-client",
    accessToken: "offline-token", refreshToken: "offline-refresh", accessTokenExpiresAt: Date.now() + 3600000,
  });
  const confirmedMedia = media("2026-10-01T12:00:00.000Z");
  const missingMedia = media("2026-10-02T12:00:00.000Z");
  const confirmedIntent = create(connection, confirmedMedia, "trakt-held-confirmed");
  const missingIntent = create(connection, missingMedia, "trakt-held-missing");
  const unsentIntent = create(connection, media("2026-10-03T12:00:00.000Z"), "trakt-held-unsent");
  const due = Date.now() - 1000;
  db.prepare("UPDATE tracker_write_intents SET status='review',attempts=1,due_at=?,last_error='Trakt reported not_found' WHERE id IN (?,?)").run(due, confirmedIntent.id, missingIntent.id);
  db.prepare("UPDATE tracker_write_intents SET status='review',attempts=0,due_at=?,last_error='Unresolved tracker write is older than 30 days' WHERE id=?").run(due, unsentIntent.id);

  // Unsent Trakt review intent is labelled notSent accurately instead of claiming Trakt history couldn't be confirmed.
  const attention = ledger.trackerWriteAttentionItems();
  assert.equal(attention.find((item) => item.intentId === unsentIntent.id)?.notSent, true);
  assert.equal(attention.find((item) => item.intentId === confirmedIntent.id)?.notSent, false);

  const previousFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.searchParams.get("start_at")?.startsWith("2026-10-01")) {
      return Response.json([{ id: 4321, watched_at: confirmedMedia.watched_at, movie: { title: confirmedMedia.title, ids: { tmdb: 123 } } }]);
    }
    return Response.json([]);
  };

  assert.equal(await syncPendingTrackerWriteIntents(() => {}), 1);
  assert.equal(get(confirmedIntent.id).status, "settled");
  assert.equal(get(missingIntent.id).status, "review");
  assert.equal(get(unsentIntent.id).status, "review");
  assert.equal(requests.length, 2, "only attempted held Trakt writes should be queried");

  // Second pass immediately after does not re-query the deferred inconclusive intent.
  assert.equal(await syncPendingTrackerWriteIntents(() => {}), 0);
  assert.equal(requests.length, 2);
});

test("unsent skipped Trakt intents close on maintenance and via closeUnsentTrackerWriteIntent", () => {
  const connection = connect();
  const bare = { type: "movie", title: "Tenet", ids: {}, source: "plex", watched_at: media().watched_at };
  db.prepare("INSERT INTO watch_history (id,title,media_type,source,watched_at,sync_action,sync_dispatch_telemetry,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("tenet-skip", "Tenet", "movie", "plex", bare.watched_at, "watched",
      "Target trakt status: skipped - Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item\nDispatch status: error", 1, 1);
  const leaked = create(connection, bare, "tenet-skip", Date.now() - ledger.TRACKER_INTENT_RETENTION_MS - 5000);
  db.prepare("UPDATE tracker_write_intents SET status='review',attempts=0,last_error='Unresolved tracker write is older than 30 days' WHERE id=?").run(leaked.id);
  ledger.maintainTrackerWriteIntents();
  assert.equal(get(leaked.id).status, "cancelled");
  assert.equal(ledger.trackerWriteAttentionItems().length, 0);

  const pendingUnsent = create(connection, bare, "direct-skip");
  assert.equal(ledger.closeUnsentTrackerWriteIntent("trakt", { ...bare, watchRecordId: "direct-skip" }, "watched", "rejected", "Not sent: missing IDs"), true);
  assert.equal(get(pendingUnsent.id).status, "rejected");

  const attempted = create(connection, media(), "already-attempted");
  db.prepare("UPDATE tracker_write_intents SET attempts=1 WHERE id=?").run(attempted.id);
  assert.equal(ledger.closeUnsentTrackerWriteIntent("trakt", { ...media(), watchRecordId: "already-attempted" }, "watched", "cancelled", "skip"), false);
  assert.equal(get(attempted.id).status, "pending");
});
