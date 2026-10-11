import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-backup-pruned-audit-");

const { db } = await import("../server/src/db.js");
const { recordWatchAuditEvent, pruneWatchAuditPayloads, AUDIT_PAYLOAD_RETENTION_MS } = await import("../server/src/utils/watchAudit.js");
const { getFullBackup, importCollectionBatch } = await import("../server/src/utils/backup.js");

test("a backup of a pruned audit table restores the NULL payloads and the live payloads intact", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const prunedId = recordWatchAuditEvent({ eventType: "source_event", status: "received", title: "Pruned", mediaKey: "movie:imdb:tt0000003", payload: { rawPayloadDebug: { big: "x".repeat(100) } } });
  const liveId = recordWatchAuditEvent({ eventType: "source_event", status: "ignored", title: "Live", mediaKey: "movie:imdb:tt0000004", payload: { rawPayloadDebug: { keep: true } } });
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS - 1000, prunedId);
  assert.equal(pruneWatchAuditPayloads(now), 1);

  const backup = getFullBackup("test");
  const documents = backup.collections.watchAuditEvents;
  assert.equal(documents.length, 2);
  const prunedDoc = documents.find((doc) => doc.id === String(prunedId));
  assert.equal(prunedDoc.data.payload, null);
  assert.equal(prunedDoc.data.title, "Pruned");

  // Round-trip through the restore path: clear the table, import the backup documents.
  db.prepare("DELETE FROM watch_audit_events").run();
  importCollectionBatch("watchAuditEvents", documents, { reset: true });

  const restored = db.prepare("SELECT id, payload, title FROM watch_audit_events ORDER BY id").all();
  assert.equal(restored.length, 2);
  assert.equal(restored.find((row) => row.id === prunedId).payload, null);
  assert.deepEqual(JSON.parse(restored.find((row) => row.id === liveId).payload), { rawPayloadDebug: { keep: true } });
});
