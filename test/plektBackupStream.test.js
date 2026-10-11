import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-backup-stream-");

const { db } = await import("../server/src/db.js");
const { FULL_BACKUPS_DIR } = await import("../server/src/paths.js");
const { fullBackupJsonChunks, getFullBackup } = await import("../server/src/utils/backup.js");
const {
  listPlektBackups,
  createPlektBackup,
  loadPlektBackupRuntime,
  runScheduledPlektBackup,
  savePlektBackupConfig,
  writeEncryptedPlektBackup,
} = await import("../server/src/utils/plektBackups.js");

const PASSPHRASE = "correct horse battery staple";

test("mixed-name local retention uses filename dates even when mtimes are equal", async () => {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  const old = "plembfin-backup-20200103T000000Z.encrypted.json";
  const older = "plekt-backup-20200102T000000Z.encrypted.json";
  const sharedTime = new Date("2026-01-01T00:00:00Z");
  for (const name of [older, old]) {
    const file = path.join(FULL_BACKUPS_DIR, name);
    fs.writeFileSync(file, "retention fixture");
    fs.utimesSync(file, sharedTime, sharedTime);
  }
  savePlektBackupConfig({ retention: 2, remoteEnabled: false });
  const result = await createPlektBackup({ passphrase: PASSPHRASE });
  assert.deepEqual(listPlektBackups().map((file) => file.name), [result.name, old]);
  for (const file of listPlektBackups()) fs.rmSync(path.join(FULL_BACKUPS_DIR, file.name));
});

test.after(() => db.close());

function seedRows() {
  const upsert = db.prepare(`
    INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);
  upsert.run("streamTestA", JSON.stringify({ text: "café ☃ \"quoted\"", list: [1, 2, 3] }), 1);
  upsert.run("streamTestB", JSON.stringify({ nested: { value: null } }), 2);
}

function withoutExportedAt(text) {
  return text.replace(/"exportedAt":"[^"]*"/, '"exportedAt":""');
}

function decryptFile(filePath, passphrase) {
  const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const payload = Buffer.from(envelope.payload, "base64");
  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const iv = Buffer.from(envelope.encryption.iv, "base64");
  const key = crypto.pbkdf2Sync(passphrase, salt, envelope.encryption.iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
  return { envelope, plain: plain.toString("utf8") };
}

function writeRuntime(values) {
  db.prepare(`
    INSERT INTO runtime_state (id, data, updated_at) VALUES ('plembfinBackups', ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(JSON.stringify(values), Date.now());
}

function localDateKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("streamed backup JSON is the same document getFullBackup builds", () => {
  seedRows();
  const streamed = [...fullBackupJsonChunks()].join("");
  const expected = JSON.stringify(getFullBackup());
  assert.equal(withoutExportedAt(streamed), withoutExportedAt(expected));
  assert.ok(JSON.parse(streamed).collections.runtimeState.some((row) => row.id === "streamTestA"));
});

test("encrypted backup file keeps the old layout and decrypts across chunk and base64 boundaries", () => {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  const filePath = path.join(FULL_BACKUPS_DIR, "stream-test.json");
  // Odd-sized pieces well past the 1 MB write chunk, so buffered writes and the
  // 3-byte base64 carry both have to join up correctly.
  const pieces = Array.from({ length: 3000 }, (_, index) => `${index}:${"xé".repeat(500)};`);
  const { sizeBytes } = writeEncryptedPlektBackup(filePath, PASSPHRASE, { chunks: pieces });
  const text = fs.readFileSync(filePath, "utf8");
  assert.equal(sizeBytes, Buffer.byteLength(text, "utf8"));

  const { envelope, plain } = decryptFile(filePath, PASSPHRASE);
  assert.equal(plain, pieces.join(""));
  assert.equal(envelope.format, "plekt-encrypted-backup");
  assert.equal(text, JSON.stringify(envelope, null, 2));
  fs.rmSync(filePath);
});

test("a scheduled backup that died is recorded, retried an hour later, and capped at three a day", async () => {
  savePlektBackupConfig({ enabled: true, time: "03:00", retention: 7, rememberPassphrase: true, passphrase: PASSPHRASE });
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const today = localDateKey(base);

  writeRuntime({ attemptDate: today, attemptCount: 1, lastAttemptAt: base.getTime() - 10 * 60 * 1000, attemptInProgress: true });
  assert.equal(await runScheduledPlektBackup({ now: base }), null);
  let runtime = loadPlektBackupRuntime();
  assert.equal(runtime.attemptInProgress, false);
  assert.match(runtime.lastError, /stopped before finishing/);
  assert.equal(listPlektBackups().length, 0);

  const stale = path.join(FULL_BACKUPS_DIR, "plembfin-backup-20260101T000000Z.encrypted.json.tmp-1");
  const fresh = path.join(FULL_BACKUPS_DIR, "plembfin-backup-20260101T000001Z.encrypted.json.tmp-1");
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  fs.writeFileSync(stale, "partial");
  fs.writeFileSync(fresh, "partial");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  const later = new Date(base.getTime() + 61 * 60 * 1000);
  const result = await runScheduledPlektBackup({ now: later });
  assert.ok(result?.name);
  runtime = loadPlektBackupRuntime();
  assert.equal(runtime.lastRunDate, localDateKey(new Date()));
  assert.equal(runtime.attemptCount, 2);
  assert.equal(runtime.attemptInProgress, false);
  assert.equal(runtime.lastError, "");
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.ok(JSON.parse(decryptFile(path.join(FULL_BACKUPS_DIR, result.name), PASSPHRASE).plain).collections);

  writeRuntime({ attemptDate: today, attemptCount: 3, lastAttemptAt: base.getTime() - 5 * 60 * 60 * 1000 });
  assert.equal(await runScheduledPlektBackup({ now: later }), null);
  assert.equal(loadPlektBackupRuntime().attemptCount, 3);
});
