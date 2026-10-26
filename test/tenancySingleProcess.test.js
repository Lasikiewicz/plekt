import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { makeTempDataDir } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test("tenancy helpers: multi-user off by default and user folders stay separate", async () => {
  const dataDir = makeTempDataDir("plekt-tenancy-unit-");
  const {
    multiUserEnabled,
    saveUsersRegistry,
    tenantDataDir,
    ensureTenantDataDir,
    resolveActiveTenant,
    validateUserName,
  } = await import("../server/src/utils/tenancy.js");
  const { openTenantDatabase, closeAllTenantDatabases, getTenantDatabaseForUser } = await import("../server/src/utils/tenantDatabase.js");
  const { runWithUserContext, getActiveUserName, getActiveDataDir } = await import("../server/src/utils/userContext.js");

  try {
    assert.equal(multiUserEnabled(dataDir), false);
    assert.equal(resolveActiveTenant("bob", dataDir), null);
    assert.equal(validateUserName("Bob").ok, true);
    assert.equal(validateUserName("../etc").ok, false);

    saveUsersRegistry({
      version: 1,
      users: [{ name: "bob", role: "user", passwordHash: "x" }],
    }, dataDir);
    assert.equal(multiUserEnabled(dataDir), true);

    const bobDir = ensureTenantDataDir("bob", dataDir);
    assert.equal(bobDir, path.join(dataDir, "users", "bob"));
    assert.equal(tenantDataDir("admin", dataDir), dataDir);

    const bobDb = getTenantDatabaseForUser("bob", dataDir);
    const adminDb = openTenantDatabase(dataDir, { cacheKey: `${dataDir}::admin` });
    bobDb.prepare("INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run(
      "tenancy-probe",
      JSON.stringify({ who: "bob" }),
      Date.now(),
    );
    const bobRow = bobDb.prepare("SELECT data FROM settings WHERE id = ?").get("tenancy-probe");
    const adminRow = adminDb.prepare("SELECT data FROM settings WHERE id = ?").get("tenancy-probe");
    assert.ok(bobRow);
    assert.equal(adminRow, undefined);

    const active = runWithUserContext({ name: "bob", dataDir: bobDir }, () => ({
      name: getActiveUserName(),
      dataDir: getActiveDataDir(),
    }));
    assert.equal(active.name, "bob");
    assert.equal(active.dataDir, bobDir);

    const tenant = resolveActiveTenant("bob", dataDir);
    assert.equal(tenant?.name, "bob");
    assert.equal(tenant?.dataDir, bobDir);
  } finally {
    closeAllTenantDatabases();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("single-user mode: /u/<name>/api/ping is not found and one server process answers /api/ping", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-tenancy-single-"));
  const port = await freePort();
  let output = "";
  let childCount = 0;
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ROLE: "web",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      API_KEY: "tenancy-test-api-key-32-characters-ok",
      WEBHOOK_SECRET: "tenancy-test-webhook-secret-32-ok",
      SESSION_SECRET: "tenancy-test-session-secret-32-ok",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "tenancy-test-password",
      PLEKT_TEST_MODE: "1",
      PLEX_ENABLED: "false", EMBY_ENABLED: "false", JELLYFIN_ENABLED: "false",
      TMDB_API_KEY: "", TVDB_API_KEY: "", FANART_API_KEY: "", OMDB_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.on("spawn", () => { childCount += 1; });

  try {
    const deadline = Date.now() + 20_000;
    while (!output.includes("listening on") && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.ok(output.includes("listening on"), `server did not start:\n${output}`);

    const ping = await fetch(`http://127.0.0.1:${port}/api/ping`, { cache: "no-store" });
    assert.equal(ping.status, 200);
    const body = await ping.json();
    assert.equal(body.ok, true);
    assert.equal(body.user, undefined);

    const missing = await fetch(`http://127.0.0.1:${port}/u/bob/api/ping`, { cache: "no-store" });
    assert.equal(missing.status, 404);

    // The app server is this one child; it must not have spawned further Node children.
    assert.equal(childCount, 1);
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(3_000).then(() => child.kill()),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("multi-user: /u/<name>/api/ping resolves in-process and no second Node is spawned", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-tenancy-multi-"));
  fs.mkdirSync(path.join(dataDir, "users", "bob"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "users.json"), `${JSON.stringify({
    version: 1,
    users: [{ name: "bob", role: "user", passwordHash: "not-used-in-this-test" }],
  }, null, 2)}\n`);

  const port = await freePort();
  let output = "";
  const spawnedChildren = [];
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ROLE: "web",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      API_KEY: "tenancy-test-api-key-32-characters-ok",
      WEBHOOK_SECRET: "tenancy-test-webhook-secret-32-ok",
      SESSION_SECRET: "tenancy-test-session-secret-32-ok",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "tenancy-test-password",
      PLEKT_TEST_MODE: "1",
      PLEX_ENABLED: "false", EMBY_ENABLED: "false", JELLYFIN_ENABLED: "false",
      TMDB_API_KEY: "", TVDB_API_KEY: "", FANART_API_KEY: "", OMDB_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.on("spawn", () => spawnedChildren.push({ pid: child.pid, at: "self" }));

  try {
    const deadline = Date.now() + 20_000;
    while (!output.includes("listening on") && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.ok(output.includes("listening on"), `server did not start:\n${output}`);

    const adminPing = await fetch(`http://127.0.0.1:${port}/api/ping`, { cache: "no-store" });
    assert.equal(adminPing.status, 200);
    assert.equal((await adminPing.json()).user, undefined);

    const bobPing = await fetch(`http://127.0.0.1:${port}/u/bob/api/ping`, { cache: "no-store" });
    const bobBody = await bobPing.json();
    assert.equal(bobPing.status, 200, JSON.stringify(bobBody));
    assert.equal(bobBody.ok, true);
    assert.equal(bobBody.user, "bob");

    const adminNamed = await fetch(`http://127.0.0.1:${port}/u/admin/api/ping`, { cache: "no-store" });
    const adminNamedBody = await adminNamed.json();
    assert.equal(adminNamed.status, 200, JSON.stringify(adminNamedBody));
    assert.equal(adminNamedBody.user, "admin");

    const unknown = await fetch(`http://127.0.0.1:${port}/u/carol/api/ping`, { cache: "no-store" });
    assert.equal(unknown.status, 404);

    // Still a single server process: no supervisor child spawn path exists.
    assert.equal(spawnedChildren.length, 1);
    assert.match(output, /listening on/);
    assert.doesNotMatch(output, /spawned child|starting child|supervisor/i);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(3_000).then(() => child.kill()),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
