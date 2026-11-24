import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-dest-data-"));
process.env.DATA_DIR = isolatedDataDir;

const { db } = await import("../server/src/db.js");
const { BACKUPS_DIR, FULL_BACKUPS_DIR, LEGACY_FULL_BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, migrateLegacyFullBackupsDir } = await import("../server/src/paths.js");
const { createFolderAdapter } = await import("../server/src/utils/backupDestinations/folder.js");
const { createWebdavAdapter } = await import("../server/src/utils/backupDestinations/webdav.js");
const { createOneDriveAdapter } = await import("../server/src/utils/backupDestinations/onedrive.js");
const { createDropboxAdapter } = await import("../server/src/utils/backupDestinations/dropbox.js");
const { destinationAcceptsBackupType, destinationRetentionForBackupType } = await import("../server/src/utils/watchHistoryBackups.js");

test.after(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(isolatedDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

test("migrateLegacyFullBackupsDir renames backups/plembfin to backups/plekt when target is absent", (t) => {
  const root = makeTempDir("plekt-migrate-rename-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, "plembfin");
  const current = path.join(root, "plekt");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "plembfin-backup-20260101T000000Z.encrypted.json"), "{\"ok\":1}");

  const result = migrateLegacyFullBackupsDir(root);
  assert.equal(result.migrated, true);
  assert.equal(result.renamed, true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(path.join(current, "plembfin-backup-20260101T000000Z.encrypted.json"), "utf8"), "{\"ok\":1}");
});

test("migrateLegacyFullBackupsDir merges remaining files without overwriting existing backups/plekt files", (t) => {
  const root = makeTempDir("plekt-migrate-merge-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, "plembfin");
  const current = path.join(root, "plekt");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(legacy, "old.json"), "from-legacy");
  fs.writeFileSync(path.join(legacy, "shared.json"), "legacy-copy");
  fs.writeFileSync(path.join(current, "shared.json"), "newer-copy");

  const result = migrateLegacyFullBackupsDir(root);
  assert.equal(result.migrated, true);
  assert.equal(result.movedFiles, 1);
  assert.equal(fs.readFileSync(path.join(current, "old.json"), "utf8"), "from-legacy");
  assert.equal(fs.readFileSync(path.join(current, "shared.json"), "utf8"), "newer-copy");
});

test("Folder adapter copies, lists, downloads, deletes, and rejects relative or built-in backup paths", async (t) => {
  const srcDir = makeTempDir("plekt-folder-src-");
  const dstDir = makeTempDir("plekt-folder-dst-");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
  });

  const payload = Buffer.from("backup-bytes-12345");
  const localPath = path.join(srcDir, "backup.json");
  fs.writeFileSync(localPath, payload);

  const adapter = createFolderAdapter({ type: "folder", settings: { path: dstDir } });
  const testRes = await adapter.testConnection();
  assert.equal(testRes.ok, true);

  const name = "plekt-backup-20261124T000000Z.encrypted.json";
  const up = await adapter.upload(localPath, name);
  assert.equal(up.bytes, payload.length);

  const listed = await adapter.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, name);

  const downloaded = await adapter.download(name);
  assert.deepEqual(downloaded, payload);

  await adapter.delete(name);
  assert.deepEqual(await adapter.list(), []);

  // Guardrails: relative path and built-in backup directories must be rejected
  await assert.rejects(createFolderAdapter({ type: "folder", settings: { path: "relative/path" } }).testConnection(), /absolute path/i);
  for (const forbidden of [BACKUPS_DIR, WATCH_HISTORY_BACKUPS_DIR, FULL_BACKUPS_DIR, LEGACY_FULL_BACKUPS_DIR, path.join(FULL_BACKUPS_DIR, "nested")]) {
    await assert.rejects(createFolderAdapter({ type: "folder", settings: { path: forbidden } }).testConnection(), /outside Plekt's built-in local backups/i);
  }
});

test("WebDAV adapter creates subfolder and streams uploads with exact Content-Length", async (t) => {
  const dir = makeTempDir("plekt-webdav-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = crypto.randomBytes(128 * 1024);
  const filePath = path.join(dir, "backup.encrypted.json");
  fs.writeFileSync(filePath, payload);

  const mkcolPaths = [];
  let putRecord = null;
  const srv = await startServer(async (req, res) => {
    if (req.method === "MKCOL") {
      mkcolPaths.push(req.url);
      res.writeHead(201).end();
      return;
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      putRecord = {
        url: req.url,
        auth: req.headers.authorization,
        contentLength: req.headers["content-length"],
        hash: sha256(body),
      };
      res.writeHead(201).end();
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => srv.close());

  const adapter = createWebdavAdapter({
    type: "webdav",
    settings: { url: `${srv.baseUrl}/dav`, directory: "Plekt/Nightly", username: "alice" },
    secrets: { password: "pw" },
  });
  const result = await adapter.upload(filePath, "plekt-backup-20261124T000000Z.encrypted.json");
  assert.equal(result.bytes, payload.length);
  assert.deepEqual(mkcolPaths, ["/dav/Plekt/", "/dav/Plekt/Nightly/"]);
  assert.equal(putRecord.url, "/dav/Plekt/Nightly/plekt-backup-20261124T000000Z.encrypted.json");
  assert.equal(putRecord.contentLength, String(payload.length));
  assert.equal(putRecord.hash, sha256(payload));
  assert.equal(putRecord.auth, `Basic ${Buffer.from("alice:pw").toString("base64")}`);
});

test("OneDrive adapter uses Graph resumable upload sessions for files over the simple upload cap", async (t) => {
  const dir = makeTempDir("plekt-onedrive-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = crypto.randomBytes(100_000);
  const filePath = path.join(dir, "backup.encrypted.json");
  fs.writeFileSync(filePath, payload);

  const chunks = [];
  let sessionRequestedPath = "";
  let chunkAuthHeaders = [];
  const srv = await startServer(async (req, res) => {
    if (req.url === "/token") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        access_token: "od-access",
        expires_in: 3600,
        refresh_token: "od-rotated-refresh",
      }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/createUploadSession")) {
      sessionRequestedPath = req.url;
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        uploadUrl: `${srv.baseUrl}/upload-session/abc`,
      }));
      return;
    }
    if (req.method === "PUT" && req.url === "/upload-session/abc") {
      chunkAuthHeaders.push(req.headers.authorization || null);
      const body = await readBody(req);
      chunks.push({ range: req.headers["content-range"], length: Number(req.headers["content-length"]), body });
      const done = req.headers["content-range"]?.includes(`${payload.length - 1}/${payload.length}`);
      res.writeHead(done ? 201 : 202, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => srv.close());

  let persisted = null;
  const adapter = createOneDriveAdapter(
    {
      id: "od-test-chunked",
      type: "onedrive",
      settings: { clientId: "cid", folder: "Backups" },
      secrets: { refreshToken: "od-initial-refresh" },
    },
    {
      persistSecrets: (partial) => { persisted = partial; },
      graphBaseUrl: srv.baseUrl,
      tokenUrl: `${srv.baseUrl}/token`,
      simpleUploadLimit: 32_768,
      chunkSize: 32_768,
    },
  );

  const result = await adapter.upload(filePath, "plekt-backup-20261124T000000Z.encrypted.json");
  assert.equal(result.bytes, payload.length);
  assert.deepEqual(persisted, { refreshToken: "od-rotated-refresh" });
  assert.equal(sessionRequestedPath, "/me/drive/special/approot:/Backups/plekt-backup-20261124T000000Z.encrypted.json:/createUploadSession");
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunkAuthHeaders, [null, null, null, null], "Graph pre-authenticated uploadUrl must not receive Authorization header");
  assert.equal(chunks[0].range, `bytes 0-32767/${payload.length}`);
  assert.equal(chunks[3].range, `bytes 98304-${payload.length - 1}/${payload.length}`);
  assert.equal(sha256(Buffer.concat(chunks.map((c) => c.body))), sha256(payload));
});

test("Dropbox adapter defaults to /Plekt Backups and streams multi-chunk upload sessions", async (t) => {
  const dir = makeTempDir("plekt-dropbox-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = crypto.randomBytes(90_000);
  const filePath = path.join(dir, "backup.encrypted.json");
  fs.writeFileSync(filePath, payload);

  const received = [];
  let finishCommitPath = "";
  const srv = await startServer(async (req, res) => {
    if (req.url === "/token") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        access_token: "dbx-access",
        expires_in: 14400,
      }));
      return;
    }
    const arg = req.headers["dropbox-api-arg"] ? JSON.parse(req.headers["dropbox-api-arg"]) : {};
    const body = await readBody(req);
    if (req.url === "/2/files/upload_session/start") {
      received.push({ step: "start", offset: 0, body });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ session_id: "sess-1" }));
      return;
    }
    if (req.url === "/2/files/upload_session/append_v2") {
      received.push({ step: "append", offset: arg.cursor.offset, sessionId: arg.cursor.session_id, body });
      res.writeHead(200).end();
      return;
    }
    if (req.url === "/2/files/upload_session/finish") {
      finishCommitPath = arg.commit.path;
      received.push({ step: "finish", offset: arg.cursor.offset, sessionId: arg.cursor.session_id, body });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: "done" }));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => srv.close());

  const adapter = createDropboxAdapter(
    {
      id: "dbx-test-chunked",
      type: "dropbox",
      settings: { appKey: "k" },
      secrets: { appSecret: "s", refreshToken: "r" },
    },
    {
      apiBaseUrl: srv.baseUrl,
      contentBaseUrl: srv.baseUrl,
      tokenUrl: `${srv.baseUrl}/token`,
      chunkSize: 32_768,
    },
  );

  const result = await adapter.upload(filePath, "plekt-backup-20261124T000000Z.encrypted.json");
  assert.equal(result.bytes, payload.length);
  assert.equal(finishCommitPath, "/Plekt Backups/plekt-backup-20261124T000000Z.encrypted.json");
  assert.deepEqual(received.map((r) => [r.step, r.offset]), [["start", 0], ["append", 32768], ["finish", 65536]]);
  assert.equal(sha256(Buffer.concat(received.map((r) => r.body))), sha256(payload));
});

test("Dropbox adapter uses bundled PKCE app key without a secret and tests via list_folder", async (t) => {
  let tokenReq = null;
  let testPath = null;
  const srv = await startServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/token") {
      tokenReq = {
        auth: req.headers.authorization || null,
        params: Object.fromEntries(new URLSearchParams(body.toString("utf8"))),
      };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        access_token: "pkce-access",
        expires_in: 14400,
      }));
      return;
    }
    if (req.url === "/2/files/list_folder") {
      testPath = JSON.parse(body.toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ entries: [], has_more: false }));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => srv.close());

  const adapter = createDropboxAdapter(
    {
      id: "dbx-test-pkce",
      type: "dropbox",
      settings: {},
      secrets: { refreshToken: "pkce-refresh" },
    },
    {
      apiBaseUrl: srv.baseUrl,
      contentBaseUrl: srv.baseUrl,
      tokenUrl: `${srv.baseUrl}/token`,
    },
  );

  const check = await adapter.testConnection();
  assert.equal(check.ok, true);
  assert.equal(tokenReq.auth, null, "Bundled PKCE refresh must not send Basic Authorization");
  assert.equal(tokenReq.params.client_id, "lfdkjvsl7z8mcss");
  assert.equal(tokenReq.params.refresh_token, "pkce-refresh");
  assert.deepEqual(testPath, { path: "", limit: 1 });
});

test("Per-destination backup-type routing and retention defaults (Dropbox full backups default to 2)", () => {
  // Omitted flags default to accepting both backup types (backward compatible)
  const plain = { type: "backblaze", settings: {} };
  assert.equal(destinationAcceptsBackupType(plain, false), true);
  assert.equal(destinationAcceptsBackupType(plain, true), true);

  // Independent watch-history vs full-backup toggles
  const watchOnly = { type: "dropbox", settings: { backupWatchHistory: true, backupFullPlekt: false } };
  assert.equal(destinationAcceptsBackupType(watchOnly, false), true);
  assert.equal(destinationAcceptsBackupType(watchOnly, true), false);

  const fullOnly = { type: "s3", settings: { backupWatchHistory: false, backupFullPlekt: true } };
  assert.equal(destinationAcceptsBackupType(fullOnly, false), false);
  assert.equal(destinationAcceptsBackupType(fullOnly, true), true);

  // Dropbox defaults to 2 full backups when fullRetention is unset, while watch-history uses global retention
  const dbxDefault = { type: "dropbox", settings: {} };
  assert.equal(destinationRetentionForBackupType(dbxDefault, true, 7), 2);
  assert.equal(destinationRetentionForBackupType(dbxDefault, false, 7), 7);

  // Explicit per-destination overrides win over both Dropbox default and global retention
  const dbxCustom = { type: "dropbox", settings: { watchRetention: 14, fullRetention: 5 } };
  assert.equal(destinationRetentionForBackupType(dbxCustom, false, 7), 14);
  assert.equal(destinationRetentionForBackupType(dbxCustom, true, 7), 5);

  // Non-Dropbox destinations fall back to global retention unless overridden
  assert.equal(destinationRetentionForBackupType(plain, true, 10), 10);
  assert.equal(destinationRetentionForBackupType({ type: "webdav", settings: { fullRetention: 3 } }, true, 10), 3);
});
