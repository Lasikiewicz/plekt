import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-restore-");

const { db } = await import("../server/src/db.js");
const { FULL_BACKUPS_DIR } = await import("../server/src/paths.js");
const { BackupStreamScanner } = await import("../server/src/utils/backupStreamScanner.js");
const { writeEncryptedPlektBackup } = await import("../server/src/utils/plektBackups.js");
const { loadWatchBackupRuntime } = await import("../server/src/utils/watchHistoryBackups.js");
const {
  getPlektRestoreJob,
  runPlektRestore,
  saveUploadedBackup,
  startPlektRestore,
  uploadedBackupPath,
} = await import("../server/src/utils/plektRestore.js");

const PASSPHRASE = "correct horse battery staple";

test.after(() => db.close());

const upsertRuntime = db.prepare(`
  INSERT INTO runtime_state (id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const runtimeRow = (id) => {
  const row = db.prepare("SELECT data FROM runtime_state WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
};

function backupFile(name) {
  fs.mkdirSync(FULL_BACKUPS_DIR, { recursive: true });
  return path.join(FULL_BACKUPS_DIR, name);
}

// Browser exports use 250,000 iterations and compact JSON.
function writeBrowserStyleBackup(filePath, document, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 250000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(filePath, JSON.stringify({
    format: "plembfin-encrypted-backup",
    version: 1,
    encryptedAt: new Date().toISOString(),
    encryption: { algorithm: "AES-256-GCM", kdf: "PBKDF2", hash: "SHA-256", iterations: 250000, salt: salt.toString("base64"), iv: iv.toString("base64") },
    payload: encrypted.toString("base64"),
  }));
}

function scanEvents(text, pieceSizes) {
  const events = [];
  const scanner = new BackupStreamScanner({
    onField: (key, value) => events.push(["field", key, value]),
    onCollectionStart: (name) => events.push(["start", name]),
    onDocument: (name, document) => events.push(["doc", name, document]),
    onCollectionEnd: (name) => events.push(["end", name]),
  });
  let at = 0;
  let piece = 0;
  while (at < text.length) {
    const size = pieceSizes[piece % pieceSizes.length];
    scanner.write(text.slice(at, at + size));
    at += size;
    piece += 1;
  }
  scanner.end();
  return events;
}

test("the stream scanner reports the same fields and documents in pieces of any size", () => {
  const document = {
    format: "plembfin-backup",
    version: 1,
    portable: false,
    notes: ["a \"quoted\" ] } note", "back\\slash"],
    collections: {
      runtimeState: [
        { id: "a", data: { text: "café ☃ 😀 \"x\" [y] {z}", n: -1.5e3, t: true, f: false, z: null, list: [[], {}] } },
        { id: "b", data: {} },
      ],
      empty: [],
      settings: [{ id: "c", data: { nested: { deeper: [1, 2, { x: "]" }] } } }],
    },
    source: { app: "plembfin" },
  };
  const expected = scanEvents(JSON.stringify(document), [1 << 20]);
  assert.deepEqual(expected.filter((event) => event[0] === "doc").map((event) => event[2]), [
    ...document.collections.runtimeState,
    ...document.collections.settings,
  ]);
  assert.deepEqual(expected.find((event) => event[1] === "source"), ["field", "source", { app: "plembfin" }]);
  for (const text of [JSON.stringify(document), JSON.stringify(document, null, 2)]) {
    for (const sizes of [[1], [2], [3, 7], [5, 1, 11]]) {
      assert.deepEqual(scanEvents(text, sizes), expected);
    }
  }
  assert.throws(() => scanEvents('{"collections":{"x":[{"id":"a"}', [4]), /ends early/);
  assert.throws(() => scanEvents('{"collections":{"x":{}}}', [4]), /not a valid document array/);
  assert.throws(() => scanEvents('{"collections":[]}', [4]), /collections object/);
});

test("a server-written encrypted backup restores through the server", async () => {
  upsertRuntime.run("restoreKeep", JSON.stringify({ text: "café ☃", list: [1, 2] }), 1);
  const filePath = backupFile("plembfin-backup-20260927T000000Z.encrypted.json");
  writeEncryptedPlektBackup(filePath, PASSPHRASE);

  db.prepare("DELETE FROM runtime_state WHERE id = 'restoreKeep'").run();
  upsertRuntime.run("restoreAddedLater", JSON.stringify({ later: true }), 2);

  const job = await runPlektRestore({ filePath, passphrase: PASSPHRASE, label: "server" });
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.encrypted, true);
  assert.ok(job.totalDocuments > 0);
  assert.equal(job.imported, job.totalDocuments);
  assert.deepEqual(runtimeRow("restoreKeep"), { text: "café ☃", list: [1, 2] });
  assert.equal(runtimeRow("restoreAddedLater"), null, "the runtimeState collection is replaced");
  assert.equal(loadWatchBackupRuntime().cronSyncPausedUntil, undefined, "cron is resumed after the restore");
  assert.equal(fs.existsSync(filePath), true, "a listed backup is kept");
  fs.rmSync(filePath);
});

test("a wrong passphrase or a damaged file changes nothing", async () => {
  upsertRuntime.run("restoreBefore", JSON.stringify({ v: 1 }), 1);
  const filePath = backupFile("plembfin-backup-20260927T000001Z.encrypted.json");
  writeEncryptedPlektBackup(filePath, PASSPHRASE);
  upsertRuntime.run("restoreMarker", JSON.stringify({ untouched: true }), 1);

  let job = await runPlektRestore({ filePath, passphrase: "wrong passphrase here" });
  assert.equal(job.status, "failed");
  assert.match(job.error, /Could not decrypt/);
  assert.deepEqual(runtimeRow("restoreMarker"), { untouched: true });

  const text = fs.readFileSync(filePath, "utf8");
  const payloadAt = text.indexOf('"payload": "') + '"payload": "'.length;
  const middle = payloadAt + Math.floor((text.lastIndexOf('"') - payloadAt) / 2);
  const flipped = text[middle] === "A" ? "B" : "A";
  fs.writeFileSync(filePath, text.slice(0, middle) + flipped + text.slice(middle + 1));
  job = await runPlektRestore({ filePath, passphrase: PASSPHRASE });
  assert.equal(job.status, "failed");
  assert.match(job.error, /Could not decrypt/);
  assert.deepEqual(runtimeRow("restoreMarker"), { untouched: true });

  fs.writeFileSync(filePath, text.slice(0, text.length - 200));
  job = await runPlektRestore({ filePath, passphrase: PASSPHRASE });
  assert.equal(job.status, "failed");
  assert.deepEqual(runtimeRow("restoreMarker"), { untouched: true });
  fs.rmSync(filePath);
});

test("a browser export (250,000 iterations) restores, and an invalid document stops it before any write", async () => {
  const filePath = backupFile("browser-export.encrypted.json");
  const document = {
    format: "plembfin-backup",
    version: 1,
    portable: true,
    collections: {
      runtimeState: [{ id: "fromBrowser", data: { ok: "yes" } }],
      mediaConnections: [{ id: "skipped", data: {} }],
    },
  };
  writeBrowserStyleBackup(filePath, document, PASSPHRASE);
  let job = await runPlektRestore({ filePath, passphrase: PASSPHRASE });
  assert.equal(job.status, "complete", job.error);
  assert.deepEqual(job.counts, { runtimeState: 1 }, "credential collections are left out, as in the browser restore");
  assert.deepEqual(runtimeRow("fromBrowser"), { ok: "yes" });

  document.collections.runtimeState = [{ id: "fromBrowser2", data: { ok: 2 } }, { id: "", data: {} }];
  writeBrowserStyleBackup(filePath, document, PASSPHRASE);
  job = await runPlektRestore({ filePath, passphrase: PASSPHRASE });
  assert.equal(job.status, "failed");
  assert.match(job.error, /invalid document/);
  assert.deepEqual(runtimeRow("fromBrowser"), { ok: "yes" });
  assert.equal(runtimeRow("fromBrowser2"), null);
  fs.rmSync(filePath);
});

// Runs the Restore page's own export encryption (tools-backups.js imports DOM
// modules, so the crypto functions are lifted out of its source).
function browserEncryptFunction() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/tools-backups.js"), "utf8");
  const lift = (pattern) => {
    const start = source.search(pattern);
    assert.ok(start >= 0, `${pattern} not found in tools-backups.js`);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
  };
  const body = [
    lift(/^const ENCRYPTED_BACKUP_FORMAT = /m).split("\n")[0],
    lift(/^const ENCRYPTED_BACKUP_VERSION = /m).split("\n")[0],
    lift(/^const BACKUP_KDF_ITERATIONS = /m).split("\n")[0],
    lift(/^function bytesToBase64\(/m),
    lift(/^async function backupCryptoKey\(/m),
    lift(/^async function encryptPlektBackup\(/m),
    "return encryptPlektBackup;",
  ].join("\n");
  return new Function(body)();
}

test("a backup the Restore page exported restores on the server", async () => {
  const filePath = backupFile("page-export.encrypted.json");
  const encryptPlektBackup = browserEncryptFunction();
  const document = { format: "plembfin-backup", version: 1, collections: { runtimeState: [{ id: "fromPage", data: { text: "café ☃" } }] } };
  // downloadJsonFile writes the envelope indented.
  fs.writeFileSync(filePath, JSON.stringify(await encryptPlektBackup(document, PASSPHRASE), null, 2));
  const job = await runPlektRestore({ filePath, passphrase: PASSPHRASE });
  assert.equal(job.status, "complete", job.error);
  assert.deepEqual(runtimeRow("fromPage"), { text: "café ☃" });
  fs.rmSync(filePath);
});

test("an uploaded plain backup is streamed to disk, restored, and removed", async () => {
  const document = {
    format: "plembfin-backup",
    version: 1,
    portable: true,
    collections: { runtimeState: Array.from({ length: 600 }, (_, index) => ({ id: `upload${index}`, data: { index } })) },
  };
  const text = JSON.stringify(document);
  const { uploadId, sizeBytes } = await saveUploadedBackup(Readable.from([text.slice(0, 1000), text.slice(1000)]));
  assert.equal(sizeBytes, Buffer.byteLength(text));
  const filePath = uploadedBackupPath(uploadId);
  assert.equal(fs.readFileSync(filePath, "utf8"), text);
  assert.throws(() => uploadedBackupPath("../escape"), /Invalid upload id/);

  const started = startPlektRestore({ filePath, label: "Uploaded backup", removeAfter: true });
  assert.equal(started.status, "verifying");
  assert.throws(() => startPlektRestore({ filePath }), /already running/);
  while (["verifying", "importing"].includes(getPlektRestoreJob().status)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const job = getPlektRestoreJob();
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.encrypted, false);
  assert.equal(job.imported, 600);
  assert.deepEqual(runtimeRow("upload599"), { index: 599 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_state WHERE id LIKE 'upload%'").get().n, 600);
  assert.equal(fs.existsSync(filePath), false);
});
