import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-backup-numbering-");
const { db } = await import("../server/src/db.js");
const { getFullBackup, importCollectionBatch, BROWSER_BACKUP_COLLECTIONS } = await import("../server/src/utils/backup.js");
const { readShowNumbering } = await import("../server/src/utils/seasonSource.js");

test("full and portable backups retain translated and pinned numbering choices", () => {
  db.prepare("INSERT INTO show_season_source VALUES (?, ?, ?, ?, ?)").run("78857", "tmdb", 1234, "tvdb", 5678);
  db.prepare("INSERT INTO show_season_source VALUES (?, ?, ?, ?, ?)").run("pinned", "tvdb", 1234, null, null);
  const documents = getFullBackup("test").collections.showSeasonSource;
  assert.ok(BROWSER_BACKUP_COLLECTIONS.includes("showSeasonSource"));
  importCollectionBatch("showSeasonSource", JSON.parse(JSON.stringify(documents)), { reset: true, portable: true });
  assert.deepEqual(readShowNumbering("78857"), { source: "tmdb", rowNumbering: "tvdb", translate: true, overriddenAt: 5678 });
  assert.equal(db.prepare("SELECT recorded_at FROM show_season_source WHERE show_key = '78857'").get().recorded_at, 1234);
  assert.equal(readShowNumbering("pinned").translate, false);
  assert.throws(() => importCollectionBatch("showSeasonSource", [{ id: "bad", data: { seasonSource: "tmdb", rowNumbering: "invalid", recordedAt: 1234 } }], { reset: true }), /Invalid show season source/);
  assert.equal(readShowNumbering("78857").translate, true, "invalid import rolls back reset");
});
