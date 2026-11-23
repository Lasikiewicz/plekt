import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-time-gated-checks-");
const { db } = await import("../server/src/db.js");
const { recordWatchAuditEvent, pruneWatchAuditPayloads, AUDIT_PAYLOAD_RETENTION_MS } = await import("../server/src/utils/watchAudit.js");
const { pruneSyncActivityPayloads } = await import("../server/src/utils/syncActivityRetention.js");
const { auditPayloadCheck, syncActivityTrimCheck, countRebuildLines, parseArgs } = await import("../scripts/time-gated-checks.js");

const DAY = 24 * 60 * 60 * 1000;

test("audit payload check waits for the window, fails when the prune falls behind, passes after it", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const id = recordWatchAuditEvent({ eventType: "source_event", status: "received", title: "Old", payload: { keep: "old" } });
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS + DAY, id);
  const waiting = auditPayloadCheck(db, now);
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.dueOn, /^\d{4}-\d{2}-\d{2}$/);

  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - AUDIT_PAYLOAD_RETENTION_MS - DAY, id);
  assert.equal(auditPayloadCheck(db, now).status, "fail");
  assert.equal(pruneWatchAuditPayloads(now), 1);
  const passed = auditPayloadCheck(db, now);
  assert.equal(passed.status, "pass");
  assert.match(passed.detail, /1 row/);
});

test("Sync Activity trim allows the daily cadence before failing", () => {
  db.prepare("DELETE FROM sync_history").run();
  const now = Date.now();
  const insert = db.prepare("INSERT INTO sync_history (title, raw_payload_debug, created_at) VALUES (?, ?, ?)");
  insert.run("just due", '{"bodyPreview":"x","ids":{"tvdb":"1"}}', now - AUDIT_PAYLOAD_RETENTION_MS - 60_000);
  assert.equal(syncActivityTrimCheck(db, now).status, "waiting");
  assert.equal(syncActivityTrimCheck(db, now + 2 * DAY).status, "fail");
  assert.equal(pruneSyncActivityPayloads(now), 1);
  assert.equal(syncActivityTrimCheck(db, now).status, "pass");
});

test("rebuild log lines are counted per cache and options parse", () => {
  const log = "x\n[cache-rebuild] cache=history version=3 trigger=a ms=1\n[cache-rebuild] cache=upNext version=3 trigger=b ms=2\n[cache-rebuild] cache=history version=4 trigger=c ms=1\n";
  assert.deepEqual(countRebuildLines(log), { history: 2, upNext: 1 });
  const args = parseArgs(["--idle-hour", "--minutes", "5", "--log", "server.log", "--json"]);
  assert.equal(args.idleHour, true);
  assert.equal(args.minutes, 5);
  assert.equal(args.log, "server.log");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});
