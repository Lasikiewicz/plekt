import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-loop-key-prune-");

const { db } = await import("../server/src/db.js");
const { createLoopStore, pruneExpiredLoopKeys } = await import("../server/src/utils/loopStore.js");

const insert = db.prepare("INSERT INTO loop_keys (id, key, value, created_at, expire_at) VALUES (?, ?, ?, ?, ?)");

test("pruneExpiredLoopKeys removes only expired rows and keeps live and no-expiry rows", () => {
  db.prepare("DELETE FROM loop_keys").run();
  const now = Date.now();
  insert.run("expired", "expired", "1", now - 10_000, now - 1_000);
  insert.run("live", "live", "1", now, now + 60_000);
  insert.run("null-expiry", "null-expiry", "1", now, null);
  insert.run("zero-expiry", "zero-expiry", "1", now, 0);

  const removed = pruneExpiredLoopKeys(now);

  assert.equal(removed, 1);
  const remaining = db.prepare("SELECT id FROM loop_keys ORDER BY id").all().map((row) => row.id);
  assert.deepEqual(remaining, ["live", "null-expiry", "zero-expiry"]);
});

test("pruneExpiredLoopKeys returns zero when nothing has expired", () => {
  db.prepare("DELETE FROM loop_keys").run();
  const now = Date.now();
  insert.run("live", "live", "1", now, now + 60_000);

  assert.equal(pruneExpiredLoopKeys(now), 0);
});

test("loop store reads still treat pruned keys as absent", async () => {
  db.prepare("DELETE FROM loop_keys").run();
  const store = createLoopStore();
  await store.put("short", "value", { expirationTtl: 1 });
  db.prepare("UPDATE loop_keys SET expire_at = ? WHERE id = ?").run(Date.now() - 1, Buffer.from("short").toString("base64url"));

  assert.equal(pruneExpiredLoopKeys(), 1);
  assert.equal(await store.get("short"), null);
});
