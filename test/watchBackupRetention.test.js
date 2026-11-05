import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-retention-");
const { db } = await import("../server/src/db.js");
const { WATCH_HISTORY_BACKUPS_DIR } = await import("../server/src/paths.js");
const { createWatchHistoryBackup, listWatchBackups, saveWatchBackupConfig } = await import("../server/src/utils/watchHistoryBackups.js");
test.after(() => db.close());

test("retention continues past a locked file and protects safety snapshots for seven days", async (t) => {
  saveWatchBackupConfig({ retention: 1 });
  const safety = await createWatchHistoryBackup({ reason: "pre-tracker-full-sync" });
  const old = await createWatchHistoryBackup();
  const originalUnlink = fs.unlinkSync;
  const attempted = [];
  t.mock.method(fs, "unlinkSync", (filename) => {
    attempted.push(path.basename(filename));
    if (path.basename(filename) === old.name) throw new Error("locked");
    return originalUnlink(filename);
  });
  const newer = await createWatchHistoryBackup();
  const latest = await createWatchHistoryBackup();
  assert.ok(attempted.includes(old.name));
  assert.ok(attempted.includes(newer.name), "pruning continues after the locked older file");
  assert.deepEqual(new Set(listWatchBackups().map((file) => file.name)), new Set([safety.name, old.name, latest.name]));
  const marker = path.join(WATCH_HISTORY_BACKUPS_DIR, `${safety.name}.safety`);
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(marker, expired, expired);
  await createWatchHistoryBackup();
  assert.ok(!fs.existsSync(path.join(WATCH_HISTORY_BACKUPS_DIR, safety.name)), "expired safety snapshots become eligible for retention");
});
