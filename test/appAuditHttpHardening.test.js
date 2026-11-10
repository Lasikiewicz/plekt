import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { AUTH, updateAdminCredentials } from "../server/src/appConfig.js";
import { CONFIG_PATH } from "../server/src/paths.js";
import { signSession, verifySession, handleLogout, setSessionCookie } from "../server/src/utils/auth.js";
import { handleWebhook } from "../server/src/routes/sync.js";

test("config permissions are restricted before sensitive contents are written", t => {
  const events = [];
  const originalOpen = fs.openSync, originalWrite = fs.writeFileSync, originalChmod = fs.fchmodSync;
  let configFd;
  t.mock.method(fs, "openSync", function(file, flags, mode) {
    const fd = originalOpen.call(this, file, flags, mode);
    if (file === CONFIG_PATH) { configFd = fd; events.push(["open", mode]); }
    return fd;
  });
  t.mock.method(fs, "fchmodSync", function(fd, mode) {
    if (fd === configFd) events.push(["chmod", mode]);
    return originalChmod.call(this, fd, mode);
  });
  t.mock.method(fs, "writeFileSync", function(fd, ...args) {
    if (fd === configFd) events.push(["write"]);
    return originalWrite.call(this, fd, ...args);
  });
  updateAdminCredentials({ username: AUTH.username, password: "audit-permission-password" });
  assert.deepEqual(events.slice(0, 3), [["open", 0o600], ["chmod", 0o600], ["write"]]);
  if (process.platform !== "win32") assert.equal(fs.statSync(CONFIG_PATH).mode & 0o777, 0o600);
});

test("webhook parser errors return a generic response without exception details", async t => {
  t.mock.method(console, "error", () => {});
  const req = { method: "POST", query: {}, headers: { "content-type": "application/json" },
    body: Buffer.from('{"private-marker":'), get: key => key === "x-plekt-webhook-secret" ? AUTH.webhookSecret : key === "content-type" ? "application/json" : undefined };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, set() { return this; }, send(body) { this.payload = JSON.parse(body); return this; } };
  await handleWebhook(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: "Invalid webhook body" });
});

test("revocation survives another process and extra token segments cannot bypass it", async () => {
  const token = signSession(AUTH.username);
  assert.equal(verifySession(`${token}.extra`), null);
  let cookieName;
  setSessionCookie({ cookie(name) { cookieName = name; } }, AUTH.username);
  await handleLogout({ method: "POST", cookies: { [cookieName]: token } }, { clearCookie() {}, status() { return this; }, set() { return this; }, send() {} });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import {verifySession} from './server/src/utils/auth.js'; process.stdout.write('REVOCATION:'+String(verifySession(process.env.AUDIT_REVOKED_TOKEN)===null));"],
    { cwd: process.cwd(), env: { ...process.env, AUDIT_REVOKED_TOKEN: token }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /REVOCATION:true/);
});

test("actual server applies smaller login, claim and webhook body caps before dispatch", async t => {
  const child = spawn(process.execPath, ["server/server.js"], { cwd: process.cwd(), env: {
    ...process.env, PORT: "0", HOST: "127.0.0.1", ROLE: "web", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "audit-body-password",
    PLEX_ENABLED: "false", EMBY_ENABLED: "false", JELLYFIN_ENABLED: "false", PLEKT_TEST_MODE: "1",
    TMDB_API_KEY: "", TVDB_API_KEY: "", FANART_API_KEY: "", OMDB_API_KEY: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
  });
  let logs = "";
  child.stderr.on("data", chunk => { logs += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timed out: ${logs.slice(-2000)}`)), 20_000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${logs.slice(-2000)}`)); });
    child.stdout.on("data", chunk => {
      logs += chunk;
      const match = logs.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  for (const prefix of ["", "/u/test-tenant"]) {
    for (const route of ["login", "/login", "auth/claim"]) {
      const res = await fetch(`http://127.0.0.1:${port}${prefix}/api/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(32 * 1024 + 1) });
      assert.equal(res.status, 413, `${prefix}/${route}`);
      await res.text();
    }
    const res = await fetch(`http://127.0.0.1:${port}${prefix}/api/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(res.status, 413, `${prefix}/webhook`);
    await res.text();
  }
  const small = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "audit-body-password" }) });
  assert.equal(small.status, 401, "a small login reaches authentication rather than the body cap");
  await small.text();
});
