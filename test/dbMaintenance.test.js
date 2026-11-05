import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-db-maintenance-");

const { runDbOptimizeIfDue, runDatabaseMaintenance, DB_OPTIMIZE_INTERVAL_MS } = await import("../server/src/utils/dbMaintenance.js");
const { db } = await import("../server/src/db.js");
const { getSharedMetadataDb } = await import("../server/src/utils/sharedMetadataStore.js");
const { DATA_DIR } = await import("../server/src/paths.js");
const { sweepOrphanArtwork } = await import("../server/src/utils/diskMaintenance.js");

test("PRAGMA optimize runs at most once per interval", () => {
  let calls = 0;
  const optimize = () => { calls += 1; };
  const start = Date.now() + 10 * DB_OPTIMIZE_INTERVAL_MS;

  assert.equal(runDbOptimizeIfDue(start, optimize).ran, true);
  assert.equal(runDbOptimizeIfDue(start + 60_000, optimize).ran, false);
  assert.equal(runDbOptimizeIfDue(start + DB_OPTIMIZE_INTERVAL_MS - 1, optimize).ran, false);
  assert.equal(runDbOptimizeIfDue(start + DB_OPTIMIZE_INTERVAL_MS, optimize).ran, true);
  assert.equal(calls, 2);
});

test("daily maintenance truncates both database WALs", () => {
  const shared = getSharedMetadataDb();
  for (const database of [db, shared]) {
    database.pragma("wal_autocheckpoint = 0");
    database.exec("CREATE TABLE IF NOT EXISTS maintenance_probe (data TEXT)");
    database.prepare("INSERT INTO maintenance_probe VALUES (?)").run("x".repeat(200000));
    assert.ok(fs.statSync(`${database.name}-wal`).size > 0);
  }
  runDatabaseMaintenance();
  for (const database of [db, shared]) {
    assert.equal(fs.statSync(`${database.name}-wal`).size, 0);
    assert.equal(database.pragma("journal_size_limit", { simple: true }), 16777216);
  }
});

test("artwork sweep preserves every user's references and unknown or temporary files", () => {
  const mediaDir = path.join(DATA_DIR, "sweep-test");
  const posters = path.join(mediaDir, "posters");
  fs.mkdirSync(posters, { recursive: true });
  const kept = `${"a".repeat(40)}.webp`;
  const orphan = `${"b".repeat(64)}.jpg`;
  for (const name of [kept, orphan, "upload.jpg", `${orphan}.tmp`]) fs.writeFileSync(path.join(posters, name), "image");
  const settled = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(path.join(posters, orphan), settled, settled);
  const fakeDb = (rows) => ({ prepare: () => ({ all: () => rows }) });
  assert.deepEqual(sweepOrphanArtwork({ mediaDir, databases: [fakeDb([]), fakeDb([{ storage_path: `posters/${kept}` }])] }), { removed: 1 });
  assert.deepEqual(fs.readdirSync(posters).sort(), [kept, "upload.jpg", `${orphan}.tmp`].sort());
});
