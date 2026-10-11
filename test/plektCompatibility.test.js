import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { makeTempDataDir } from "./helpers.js";

// Installs set up while the app was called Plembfin must keep working after the
// rename to Plekt: old environment variable names, the old webhook header, old
// backup files, the old database file, and the old Windows data folder.
makeTempDataDir("plekt-compatibility-");

const { brandEnv, legacyEnvNamesInUse, logLegacyEnvNames } = await import("../server/src/utils/brandEnv.js");
const { DB_PATH, resolveDbPath, resolveWindowsServiceDataDir } = await import("../server/src/paths.js");
const names = await import("../server/src/utils/backupNames.js");
const { db } = await import("../server/src/db.js");
const { loadCredentialKey } = await import("../server/src/utils/credentialVault.js");
const { handleWebhook } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { listActiveSessions } = await import("../server/src/utils/activeSessions.js");
const { UP_NEXT_SEED_DEVICE_ID } = await import("../server/src/utils/embyClient.js");
const { importWatchHistoryBackupFile, listWatchBackups } = await import("../server/src/utils/watchHistoryBackups.js");

test.after(() => db.close());

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("an environment variable is read under its new name first, then its old one", () => {
  assert.equal(brandEnv("PUBLIC_URL", { PLEKT_PUBLIC_URL: "new", PLEMBFIN_PUBLIC_URL: "old" }), "new");
  assert.equal(brandEnv("PUBLIC_URL", { PLEMBFIN_PUBLIC_URL: "old" }), "old");
  assert.equal(brandEnv("PUBLIC_URL", { PLEKT_PUBLIC_URL: "  ", PLEMBFIN_PUBLIC_URL: "old" }), "old", "a blank new name does not hide the old one");
  assert.equal(brandEnv("PUBLIC_URL", {}), undefined);
});

test("old environment variable names in use are reported once, with their new names", () => {
  const env = { PLEMBFIN_DEMO_MODE: "1", PLEMBFIN_PUBLIC_URL: "old", PLEKT_PUBLIC_URL: "new", PLEMBFIN_EMPTY: "", OTHER: "x" };
  assert.deepEqual(legacyEnvNamesInUse(env), ["PLEMBFIN_DEMO_MODE"]);
  const lines = [];
  logLegacyEnvNames(env, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /PLEMBFIN_DEMO_MODE/);
  assert.match(lines[0], /PLEKT_DEMO_MODE/);
  logLegacyEnvNames({ PLEKT_DEMO_MODE: "1" }, (line) => lines.push(line));
  assert.equal(lines.length, 1, "nothing is logged when only new names are set");
});

test("a new install gets plekt.db and an existing plembfin.db is never left beside a new one", () => {
  assert.equal(path.basename(DB_PATH), "plekt.db", "this test's empty data directory is a new install");

  const fresh = tempDir("plekt-db-fresh-");
  assert.equal(resolveDbPath(fresh), path.join(fresh, "plekt.db"));

  const existing = tempDir("plekt-db-existing-");
  fs.writeFileSync(path.join(existing, "plembfin.db"), "");
  assert.equal(resolveDbPath(existing), path.join(existing, "plembfin.db"));

  fs.writeFileSync(path.join(existing, "plekt.db"), "");
  assert.equal(resolveDbPath(existing), path.join(existing, "plembfin.db"), "the old database wins when both exist");
});

test("the Windows service keeps using the old data folder until the new one holds a database", () => {
  const programData = tempDir("plekt-programdata-");
  const current = path.join(programData, "Plekt");
  const legacy = path.join(programData, "Plembfin");
  assert.equal(resolveWindowsServiceDataDir(programData), current, "new install");

  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "plembfin.db"), "");
  assert.equal(resolveWindowsServiceDataDir(programData), legacy, "not migrated yet");

  fs.mkdirSync(current);
  assert.equal(resolveWindowsServiceDataDir(programData), legacy, "an empty new folder does not hide the old data");

  fs.writeFileSync(path.join(current, "plembfin.db"), "");
  assert.equal(resolveWindowsServiceDataDir(programData), current, "migrated: the moved database is used");
});

test("backup names are written as Plekt and read under both names", () => {
  assert.equal(names.BACKUP_FORMAT, "plekt-backup");
  for (const format of ["plekt-backup", "plembfin-backup"]) assert.equal(names.isBackupFormat(format), true);
  for (const format of ["plekt-encrypted-backup", "plembfin-encrypted-backup"]) assert.equal(names.isEncryptedBackupFormat(format), true);
  for (const format of ["plekt-watch-history-backup", "plembfin-watch-history-backup"]) assert.equal(names.isWatchHistoryBackupFormat(format), true);
  assert.equal(names.isBackupFormat("plekt-encrypted-backup"), false);
  assert.equal(names.isBackupFormat("other-backup"), false);

  const stamp = "20261009T030000Z";
  assert.equal(names.fullBackupFilename(stamp), `plekt-backup-${stamp}.encrypted.json`);
  assert.equal(names.watchHistoryBackupFilename(stamp), `plekt-watch-history-${stamp}.json.gz`);
  for (const prefix of ["plekt", "plembfin"]) {
    const full = `${prefix}-backup-${stamp}.encrypted.json`;
    const watch = `${prefix}-watch-history-${stamp}.json.gz`;
    assert.ok(names.FULL_BACKUP_FILE_PATTERN.test(full));
    assert.ok(names.FULL_BACKUP_TEMPORARY_FILE_PATTERN.test(`${full}.tmp-1`));
    assert.ok(names.WATCH_HISTORY_FILE_PATTERN.test(watch));
    assert.ok(names.REMOTE_BACKUP_FILE_PATTERN.test(full));
    assert.ok(names.REMOTE_BACKUP_FILE_PATTERN.test(watch));
    assert.equal(names.FULL_BACKUP_FILE_PATTERN.test(watch), false);
    assert.equal(names.WATCH_HISTORY_FILE_PATTERN.test(full), false);
  }
  assert.equal(names.REMOTE_BACKUP_FILE_PATTERN.test(`other-backup-${stamp}.encrypted.json`), false);

  assert.equal(names.backupValueType({ __plektType: "timestamp" }), "timestamp");
  assert.equal(names.backupValueType({ __plembfinType: "timestamp" }), "timestamp");
});

// Retention deletes everything after the newest N. Sorted by whole name, every
// old-prefixed file would rank as newer than every new-prefixed one, and the
// backups made since the rename would be the ones deleted.
test("old and new backup files are ordered by age, not by prefix", () => {
  const files = [
    "plembfin-backup-20261001T030000Z.encrypted.json",
    "plekt-backup-20261009T030000Z.encrypted.json",
    "plembfin-backup-20261005T030000Z.encrypted.json",
    "plekt-backup-20261008T030000Z.encrypted.json",
  ];
  const newestFirst = [...files].sort((a, b) => names.backupFileStamp(b).localeCompare(names.backupFileStamp(a)));
  assert.deepEqual(newestFirst, [files[1], files[3], files[2], files[0]]);
});

test("the credential key is accepted under the old variable name", () => {
  const keyPath = path.join(tempDir("plekt-credential-"), "credential.key");
  const oldKey = "11".repeat(32);
  const newKey = "22".repeat(32);
  assert.equal(loadCredentialKey({ keyPath, env: { PLEMBFIN_CREDENTIAL_KEY: oldKey } }).toString("hex"), oldKey);
  assert.equal(loadCredentialKey({ keyPath, env: { PLEKT_CREDENTIAL_KEY: newKey } }).toString("hex"), newKey);
  assert.equal(loadCredentialKey({ keyPath, env: { PLEKT_CREDENTIAL_KEY: newKey, PLEMBFIN_CREDENTIAL_KEY: oldKey } }).toString("hex"), newKey);
  assert.equal(fs.existsSync(keyPath), false, "no key file is generated while a variable supplies the key");
});

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = JSON.parse(body); return this; },
  };
}

// An Emby Up Next seed callback: authenticated like any webhook, then skipped
// without recording anything.
async function sendWebhook(headers) {
  const allHeaders = { "content-type": "application/json", ...headers };
  const response = responseCapture();
  await handleWebhook({
    method: "POST",
    query: {},
    headers: allHeaders,
    get: (name) => allHeaders[String(name).toLowerCase()] || "",
    body: {
      Event: "playback.start",
      UserId: "emby-user",
      DeviceId: UP_NEXT_SEED_DEVICE_ID,
      Client: "Emby",
      SessionId: "compatibility-seed",
      Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" }, RunTimeTicks: 36_000_000_000 },
    },
  }, response);
  return response;
}

test("a webhook is accepted with the new or the old secret header, and rejected with a wrong secret", async () => {
  const historyBefore = db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE title = ?").get("Arrival").count;
  const syncBefore = db.prepare("SELECT COUNT(*) AS count FROM sync_history WHERE title = ?").get("Arrival").count;
  for (const header of ["x-plekt-webhook-secret", "x-plembfin-webhook-secret"]) {
    const accepted = await sendWebhook({ [header]: AUTH.webhookSecret });
    assert.equal(accepted.statusCode, 200, header);
    assert.equal(accepted.body.skipped, true, header);

    const rejected = await sendWebhook({ [header]: `${AUTH.webhookSecret}-wrong` });
    assert.equal(rejected.statusCode, 401, header);
  }
  assert.equal((await sendWebhook({})).statusCode, 401);
  assert.equal((await listActiveSessions()).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE title = ?").get("Arrival").count, historyBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_history WHERE title = ?").get("Arrival").count, syncBefore);
});

test("a Jellyfin seed completion received with the legacy header cannot add a watch or dispatch", async () => {
  const historyBefore = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  const syncBefore = db.prepare("SELECT COUNT(*) AS count FROM sync_history").get().count;
  const headers = { "content-type": "application/json", "x-plembfin-webhook-secret": AUTH.webhookSecret };
  const response = responseCapture();
  await handleWebhook({
    method: "POST", query: {}, headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
    body: {
      NotificationType: "PlaybackStop", UserId: "jellyfin-user",
      DeviceId: UP_NEXT_SEED_DEVICE_ID, SessionId: "jellyfin-seed",
      Client: "Plekt", PlaybackPositionTicks: 36_000_000_000,
      Item: { Type: "Movie", Name: "Arrival", Id: "seed-item", ProviderIds: { Tmdb: "329865" }, RunTimeTicks: 36_000_000_000 },
    },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.skipped, true);
  assert.equal(response.body.propagated, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, historyBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_history").get().count, syncBefore);
  assert.equal((await listActiveSessions()).length, 0);
});

test("a watch-history backup made before the rename is accepted, under its old file name", () => {
  const data = { watchHistory: [], playstate: [], playbackProgress: [] };
  const document = {
    format: "plembfin-watch-history-backup",
    version: 1,
    createdAt: "2026-10-01T03:00:00.000Z",
    counts: { watchHistory: 0, playstate: 0, playbackProgress: 0 },
    dataChecksum: crypto.createHash("sha256").update(Buffer.from(JSON.stringify(data), "utf8")).digest("hex"),
    data,
  };
  const filename = "plembfin-watch-history-20261001T030000Z.json.gz";
  const result = importWatchHistoryBackupFile({ filename, buffer: zlib.gzipSync(JSON.stringify(document)) });
  assert.equal(result.name, filename);
  assert.ok(listWatchBackups().some((file) => file.name === filename), "old-named files are still listed");

  assert.throws(
    () => importWatchHistoryBackupFile({ filename, buffer: zlib.gzipSync(JSON.stringify({ ...document, format: "other" })) }),
    /not a Plekt watch-history backup/,
  );
});
