import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-audit-payload-prune-");

const { db } = await import("../server/src/db.js");
const {
  auditSourceEventPayload,
  AUDIT_PAYLOAD_RETENTION_MS,
  countPrunableAuditPayloads,
  pruneWatchAuditPayloads,
  recordWatchAuditEvent,
  listWatchAuditEvents,
} = await import("../server/src/utils/watchAudit.js");

const DAY = 24 * 60 * 60 * 1000;
const rawBody = { ids: { imdb: "tt0000001" }, big: "x".repeat(4000), nested: { a: 1 } };

test("routine source events keep provenance and request but drop the raw debug body", () => {
  const payload = {
    rawPayloadDebug: rawBody,
    watchProvenance: { source: "plex" },
    request: { userAgent: "test", remoteAddress: "127.0.0.1" },
  };
  const trimmed = auditSourceEventPayload(payload, true);

  assert.deepEqual(trimmed.watchProvenance, { source: "plex" });
  assert.deepEqual(trimmed.request, { userAgent: "test", remoteAddress: "127.0.0.1" });
  assert.equal(trimmed.rawPayloadDebug.trimmed, true);
  assert.deepEqual(trimmed.rawPayloadDebug.topLevelKeys, ["ids", "big", "nested"]);
  assert.deepEqual(trimmed.rawPayloadDebug.ids, { imdb: "tt0000001" });
  assert.equal(trimmed.rawPayloadDebug.originalBytes, Buffer.byteLength(JSON.stringify(rawBody)));
  assert.ok(JSON.stringify(trimmed).length < JSON.stringify(payload).length);
});

test("rejected source events keep the full payload", () => {
  const payload = { rawPayloadDebug: rawBody, watchProvenance: null };
  assert.equal(auditSourceEventPayload(payload, false), payload);
});

test("prune clears only payloads older than the window and keeps summary columns", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const oldId = recordWatchAuditEvent({ eventType: "source_event", status: "received", title: "Old", payload: { keep: "old" } });
  const freshId = recordWatchAuditEvent({ eventType: "source_event", status: "received", title: "Fresh", payload: { keep: "fresh" } });
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS - DAY, oldId);

  assert.deepEqual(countPrunableAuditPayloads(now).rows, 1);
  assert.equal(pruneWatchAuditPayloads(now), 1);
  assert.equal(pruneWatchAuditPayloads(now), 0);

  const oldRow = db.prepare("SELECT payload, title, event_type, status, timestamp FROM watch_audit_events WHERE id = ?").get(oldId);
  assert.equal(oldRow.payload, null);
  assert.equal(oldRow.title, "Old");
  assert.equal(oldRow.event_type, "source_event");
  assert.equal(oldRow.status, "received");
  assert.ok(oldRow.timestamp > 0);

  const freshRow = db.prepare("SELECT payload FROM watch_audit_events WHERE id = ?").get(freshId);
  assert.deepEqual(JSON.parse(freshRow.payload), { keep: "fresh" });
});

test("retention counts and prune exclude other audit event types", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const oldCreatedAt = now - AUDIT_PAYLOAD_RETENTION_MS - DAY;
  const sourcePayload = { rawPayloadDebug: { body: "old source event" } };
  const sourceId = recordWatchAuditEvent({ eventType: "source_event", payload: sourcePayload });
  const retained = ["sync_target", "sync_dispatch", "history_added"].map((eventType) => {
    const payload = { error: "provider failure", diagnostic: eventType };
    const id = recordWatchAuditEvent({ eventType, status: "failed", payload });
    return { id, payload };
  });
  db.prepare("UPDATE watch_audit_events SET created_at = ?").run(oldCreatedAt);

  assert.deepEqual(countPrunableAuditPayloads(now), {
    rows: 1,
    bytes: JSON.stringify(sourcePayload).length,
  });
  assert.equal(pruneWatchAuditPayloads(now), 1);
  assert.equal(db.prepare("SELECT payload FROM watch_audit_events WHERE id = ?").get(sourceId).payload, null);
  for (const { id, payload } of retained) {
    assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM watch_audit_events WHERE id = ?").get(id).payload), payload);
  }
  assert.deepEqual(countPrunableAuditPayloads(now), { rows: 0, bytes: 0 });
  assert.equal(pruneWatchAuditPayloads(now), 0);
});

test("prune runs in bounded batches", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    const id = recordWatchAuditEvent({ eventType: "source_event", title: `Batch ${index}`, payload: { index } });
    db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS - DAY, id);
  }

  assert.equal(pruneWatchAuditPayloads(now, 2), 2);
  assert.equal(pruneWatchAuditPayloads(now, 2), 1);
});

test("the audit read path still returns events whose payload was pruned", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const id = recordWatchAuditEvent({ eventType: "source_event", mediaKey: "movie:imdb:tt0000002", title: "Pruned movie", payload: { x: 1 } });
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS - DAY, id);
  pruneWatchAuditPayloads(now);

  const events = listWatchAuditEvents({ mediaKeys: ["movie:imdb:tt0000002"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Pruned movie");
  assert.equal(events[0].payload, null);
});
