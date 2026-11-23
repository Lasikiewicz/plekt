import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const root = makeTempDataDir("plekt-sync-activity-retention-");
const { db } = await import("../server/src/db.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { SYNC_ACTIVITY_PAYLOAD_RETENTION_MS, countPrunableSyncActivityPayloads, pruneSyncActivityPayloads, pruneSyncActivityPayloadsIfDue } = await import("../server/src/utils/syncActivityRetention.js");

test("trims only old debug payloads in bounded batches while preserving activity", () => {
  const now = Date.now(), cutoff = now - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS;
  const insert = db.prepare("INSERT INTO sync_history (timestamp,title,status,details,target_states,raw_payload_debug,activity_group_key,activity_item_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const payload = JSON.stringify({ bodyPreview: "x".repeat(1000), ids: { tvdb: "123" }, watchRecordId: "watch-1", dismissalHistory: [{ target: "trakt", reason: "not_found" }] });
  const add = (title, createdAt, body = payload) => insert.run(now, title, "error", "details", '{"plex":{"status":"error"}}', body, "group", title, createdAt).lastInsertRowid;
  const old = add("old", cutoff - 1), older = add("older", cutoff - 1000);
  const boundary = add("boundary", cutoff), recent = add("recent", now), unknown = add("unknown", null);
  const malformed = add("malformed", cutoff - 1, "not-json");
  const metadata = add("metadata", cutoff - 1, '{"ids":{"tvdb":"123"}}');
  assert.equal(countPrunableSyncActivityPayloads(now).rows, 2);
  assert.equal(pruneSyncActivityPayloads(now, 1), 1);
  assert.equal(pruneSyncActivityPayloads(now, 1), 1);
  assert.equal(pruneSyncActivityPayloads(now), 0);
  const get = db.prepare("SELECT * FROM sync_history WHERE id = ?");
  for (const id of [old, older]) {
    const row = get.get(id);
    const debug = JSON.parse(row.raw_payload_debug);
    assert.equal(debug.bodyPreview, undefined);
    assert.deepEqual(debug.ids, { tvdb: "123" });
    assert.equal(debug.watchRecordId, "watch-1");
    assert.equal(debug.dismissalHistory[0].reason, "not_found");
    assert.equal(row.status, "error");
    assert.equal(row.details, "details");
    assert.equal(row.target_states, '{"plex":{"status":"error"}}');
    assert.equal(row.activity_group_key, "group");
    assert.ok(row.activity_item_key);
  }
  for (const id of [boundary, recent, unknown]) assert.equal(get.get(id).raw_payload_debug, payload);
  assert.equal(get.get(malformed).raw_payload_debug, "not-json");
  assert.equal(get.get(metadata).raw_payload_debug, '{"ids":{"tvdb":"123"}}');
  assert.equal(countPrunableSyncActivityPayloads(now).rows, 0);
});

test("scheduled pruning stays within the active tenant", () => {
  const contexts = ["alice", "bob"].map((name) => {
    const dataDir = path.join(root, "users", name);
    fs.mkdirSync(dataDir, { recursive: true });
    return { name, dataDir, role: "user" };
  });
  const within = (index, fn) => runWithUserContext(contexts[index], fn);
  const old = Date.now() - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS - 1;
  for (let i = 0; i < 2; i++) within(i, () => db.prepare("INSERT INTO sync_history (title, raw_payload_debug, created_at) VALUES (?, ?, ?)").run(contexts[i].name, '{"bodyPreview":"private"}', old));
  const now = Date.now();
  assert.equal(within(0, () => pruneSyncActivityPayloadsIfDue(now)), 1);
  assert.equal(within(0, () => db.prepare("SELECT raw_payload_debug FROM sync_history").get().raw_payload_debug), "{}");
  assert.equal(within(1, () => db.prepare("SELECT raw_payload_debug FROM sync_history").get().raw_payload_debug), '{"bodyPreview":"private"}');
  assert.equal(within(1, () => pruneSyncActivityPayloadsIfDue(now)), 1);
  within(0, () => db.prepare("INSERT INTO sync_history (raw_payload_debug,created_at) VALUES (?,?)").run('{"bodyPreview":"later"}', old));
  assert.equal(within(0, () => pruneSyncActivityPayloadsIfDue(now + 1000)), 0);
  assert.equal(within(0, () => pruneSyncActivityPayloadsIfDue(now + 24 * 60 * 60 * 1000)), 1);
});

test("backup and restore preserve trimmed identity and dismissal data", async () => {
  const { getFullBackup, importCollectionBatch } = await import("../server/src/utils/backup.js");
  db.prepare("DELETE FROM sync_history").run();
  const raw = { bodyPreview: "private body", ids: { tvdb: "123" }, watchRecordId: "watch-1", dismissalHistory: [{ target: "trakt", reason: "not_found" }] };
  db.prepare("INSERT INTO sync_history (timestamp,title,status,raw_payload_debug,created_at) VALUES (?,?,?,?,?)")
    .run(Date.now(), "Retained", "error", JSON.stringify(raw), Date.now() - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS - 1000);
  assert.equal(pruneSyncActivityPayloads(), 1);
  const docs = getFullBackup("test").collections.syncHistory;
  db.prepare("DELETE FROM sync_history").run();
  importCollectionBatch("syncHistory", docs, { reset: true });
  const restored = db.prepare("SELECT title,raw_payload_debug FROM sync_history").get();
  assert.equal(restored.title, "Retained");
  const debug = JSON.parse(restored.raw_payload_debug);
  assert.equal(debug.bodyPreview, undefined);
  assert.deepEqual(debug.ids, raw.ids);
  assert.equal(debug.watchRecordId, raw.watchRecordId);
  assert.deepEqual(debug.dismissalHistory, raw.dismissalHistory);
});

test("activity search retains summaries but no longer exposes trimmed raw body text", async () => {
  const { getSyncHistoryPage } = await import("../server/src/utils/configStore.js");
  db.prepare("DELETE FROM sync_history").run();
  db.prepare("INSERT INTO sync_history (timestamp,title,details,raw_payload_debug,created_at) VALUES (?,?,?,?,?)")
    .run(Date.now(), "Retained title", "still searchable", '{"bodyPreview":"private-marker"}', Date.now() - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS - 1);
  assert.equal((await getSyncHistoryPage({ search: "private-marker" })).total, 1);
  assert.equal(pruneSyncActivityPayloads(), 1);
  assert.equal((await getSyncHistoryPage({ search: "private-marker" })).total, 0);
  assert.equal((await getSyncHistoryPage({ search: "Retained title" })).total, 1);
});

test("full batches continue next tick before the daily pause", () => {
  const dataDir = path.join(root, "users", "batch-test");
  fs.mkdirSync(dataDir, { recursive: true });
  runWithUserContext({ name: "batch-test", dataDir, role: "user" }, () => {
    const now = Date.now();
    const insert = db.prepare("INSERT INTO sync_history (created_at,raw_payload_debug) VALUES (?,?)");
    db.transaction(() => {
      for (let i = 0; i < 2001; i++) insert.run(now - SYNC_ACTIVITY_PAYLOAD_RETENTION_MS - 1, '{"bodyPreview":"raw"}');
    })();
    assert.equal(pruneSyncActivityPayloadsIfDue(now), 2000);
    assert.equal(pruneSyncActivityPayloadsIfDue(now + 1000), 1);
    assert.equal(pruneSyncActivityPayloadsIfDue(now + 2000), 0);
  });
});
