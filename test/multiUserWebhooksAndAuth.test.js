import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { makeTempDataDir } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(50);
    }
  }
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

function cookiePairFromResponse(response) {
  const raw = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
  const first = String(raw[0] || "");
  return first.split(";")[0] || "";
}

async function startTestServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  let output = "";
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
      ADMIN_PASSWORD: "admin-password-123",
      PLEKT_TEST_MODE: "1",
      PLEX_ENABLED: "false",
      EMBY_ENABLED: "false",
      JELLYFIN_ENABLED: "false",
      TMDB_API_KEY: "",
      TVDB_API_KEY: "",
      FANART_API_KEY: "",
      OMDB_API_KEY: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 20_000;
  while (!output.includes("listening on") && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await delay(25);
  }
  assert.ok(output.includes("listening on"), `server did not start:\n${output}`);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          delay(3_000).then(() => child.kill()),
        ]);
      }
    },
  };
}

test("Step 4, 6, 7: user management, sign-in isolation, switching, and per-user webhooks/API keys", async () => {
  const dataDir = makeTempDataDir("plekt-multi-user-e2e-");
  const server = await startTestServer(dataDir);
  try {
    const originHeaders = {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
    };

    // 1. Admin sign-in sets cookie with expected flags
    const adminLoginRes = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "admin", password: "admin-password-123" }),
    });
    assert.equal(adminLoginRes.status, 200);
    const setCookieHeader = String((adminLoginRes.headers.getSetCookie?.() || [adminLoginRes.headers.get("set-cookie")])[0] || "");
    assert.match(setCookieHeader, /HttpOnly/i);
    assert.match(setCookieHeader, /SameSite=Lax/i);
    assert.match(setCookieHeader, /Path=\//i);
    assert.match(setCookieHeader, /Max-Age=604800/i);
    assert.doesNotMatch(setCookieHeader, /;\s*Secure/i);
    const adminCookie = cookiePairFromResponse(adminLoginRes);

    // 2. Admin lists users (initially only admin, supervised: false)
    const initialUsersRes = await fetch(`${server.baseUrl}/api/users`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(initialUsersRes.status, 200);
    const initialUsersBody = await initialUsersRes.json();
    assert.equal(initialUsersBody.supervised, false);
    assert.equal(initialUsersBody.users.length, 1);
    assert.equal(initialUsersBody.users[0].name, "admin");
    assert.equal(initialUsersBody.users[0].isAdmin, true);

    // 3. Validate user creation rules (short name, Windows reserved name, duplicate admin name, short password)
    for (const badName of ["a", "../bob", "con", "nul"]) {
      const badRes = await fetch(`${server.baseUrl}/api/users`, {
        method: "POST",
        headers: { ...originHeaders, Cookie: adminCookie },
        body: JSON.stringify({ name: badName, password: "valid-password-123" }),
      });
      assert.equal(badRes.status, 400, `expected 400 for ${badName}`);
    }
    const adminDupRes = await fetch(`${server.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "admin", password: "valid-password-123" }),
    });
    assert.equal(adminDupRes.status, 409);

    const shortPwRes = await fetch(`${server.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "alice", password: "short" }),
    });
    assert.equal(shortPwRes.status, 400);

    // 4. Add users alice and bob
    const addAliceRes = await fetch(`${server.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "Alice", password: "alice-password-123" }),
    });
    assert.equal(addAliceRes.status, 201);
    const addAliceBody = await addAliceRes.json();
    assert.equal(addAliceBody.user.name, "alice");
    assert.ok(fs.existsSync(path.join(dataDir, "users", "alice")));

    const addBobRes = await fetch(`${server.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "bob", password: "bob-password-123" }),
    });
    assert.equal(addBobRes.status, 201);

    // Duplicate user rejected with 409
    const dupAliceRes = await fetch(`${server.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "alice", password: "alice-password-123" }),
    });
    assert.equal(dupAliceRes.status, 409);

    // 5. Alice signs in at /api/login — skips CLAIM_REQUIRED and gets her own webhookPath & secrets
    const aliceLoginRes = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "alice", password: "alice-password-123" }),
    });
    assert.equal(aliceLoginRes.status, 200);
    const aliceCookie = cookiePairFromResponse(aliceLoginRes);

    const aliceStatusRes = await fetch(`${server.baseUrl}/api/auth/status`, {
      headers: { Cookie: aliceCookie },
    });
    const aliceStatus = await aliceStatusRes.json();
    assert.equal(aliceStatus.authenticated, true);
    assert.equal(aliceStatus.username, "alice");
    assert.equal(aliceStatus.role, "user");
    assert.equal(aliceStatus.activeUser, "alice");
    assert.equal(aliceStatus.claimRequired, false);
    assert.equal(aliceStatus.mustChangePassword, false);
    assert.equal(aliceStatus.webhookPath, "/u/alice/api/webhook");

    // Alice's unprefixed /api/setup/status succeeds (not 403 CLAIM_REQUIRED!)
    const aliceSetupRes = await fetch(`${server.baseUrl}/api/setup/status`, {
      headers: { Cookie: aliceCookie },
    });
    assert.equal(aliceSetupRes.status, 200);

    // Alice's API key and webhook token are distinct from the admin's
    const aliceApiKey = (await (await fetch(`${server.baseUrl}/api/auth/apikey`, { headers: { Cookie: aliceCookie } })).json()).apiKey;
    const aliceWebhookToken = (await (await fetch(`${server.baseUrl}/api/auth/webhook-secret`, { headers: { Cookie: aliceCookie } })).json()).webhookToken;
    const adminApiKey = (await (await fetch(`${server.baseUrl}/api/auth/apikey`, { headers: { Cookie: adminCookie } })).json()).apiKey;
    const adminWebhookToken = (await (await fetch(`${server.baseUrl}/api/auth/webhook-secret`, { headers: { Cookie: adminCookie } })).json()).webhookToken;
    assert.ok(aliceApiKey && aliceApiKey !== adminApiKey);
    assert.ok(aliceWebhookToken && aliceWebhookToken !== adminWebhookToken);

    // 6. Cross-tenant isolation:
    // - Alice cannot list users or manage users (403 ADMIN_ONLY)
    const aliceUsersRes = await fetch(`${server.baseUrl}/api/users`, { headers: { Cookie: aliceCookie } });
    assert.equal(aliceUsersRes.status, 403);
    assert.equal((await aliceUsersRes.json()).code, "ADMIN_ONLY");

    // A regular user can read their config and change their own connection and
    // appearance settings, but shared settings, maintenance, and backups are
    // install-admin-only.
    assert.equal((await fetch(`${server.baseUrl}/api/config`, {
      headers: { Cookie: aliceCookie },
    })).status, 200);
    const ownConnectionRes = await fetch(`${server.baseUrl}/api/config`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ plex: { disabled: true } }),
    });
    assert.equal(ownConnectionRes.status, 200);
    const sharedConfigRes = await fetch(`${server.baseUrl}/api/config`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ tmdb: { apiKey: "must-not-be-written" } }),
    });
    assert.equal(sharedConfigRes.status, 403);
    assert.equal((await sharedConfigRes.json()).code, "ADMIN_ONLY");
    const appearanceRes = await fetch(`${server.baseUrl}/api/appearance`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ textScale: 105 }),
    });
    assert.equal(appearanceRes.status, 200);
    assert.equal((await appearanceRes.json()).appearance.textScale, 105);
    for (const url of [
      "/api/cache-stats",
      "/api/diagnostic-logs",
      "/api/backup/export",
      "/api/wipe-data/preview",
    ]) {
      assert.equal((await fetch(`${server.baseUrl}${url}`, {
        headers: { Cookie: aliceCookie },
      })).status, 403, `${url} must be admin-only`);
    }
    const clearCacheRes = await fetch(`${server.baseUrl}/api/clear-cache`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ type: "all" }),
    });
    assert.equal(clearCacheRes.status, 403);
    const wipeDataRes = await fetch(`${server.baseUrl}/api/wipe-data`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ scope: "factory", confirm: "DELETE" }),
    });
    assert.equal(wipeDataRes.status, 403);

    const aliceSwitchRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ action: "open", name: "admin" }),
    });
    assert.equal(aliceSwitchRes.status, 403);

    // - Alice's session cookie cannot access /u/admin/api/* or /u/bob/api/*
    const aliceToAdminRes = await fetch(`${server.baseUrl}/u/admin/api/history`, { headers: { Cookie: aliceCookie } });
    assert.equal(aliceToAdminRes.status, 401);
    const aliceToBobRes = await fetch(`${server.baseUrl}/u/bob/api/history`, { headers: { Cookie: aliceCookie } });
    assert.equal(aliceToBobRes.status, 401);

    // - Alice's API key works on /u/alice/api/history, but is rejected on /api/history and /u/bob/api/history
    assert.equal((await fetch(`${server.baseUrl}/u/alice/api/history`, { headers: { "X-Api-Key": aliceApiKey } })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/api/history`, { headers: { "X-Api-Key": aliceApiKey } })).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/u/bob/api/history`, { headers: { "X-Api-Key": aliceApiKey } })).status, 401);

    // - Admin's API key works on /api/history and /u/admin/api/history, but not on /u/alice/api/history
    assert.equal((await fetch(`${server.baseUrl}/api/history`, { headers: { "X-Api-Key": adminApiKey } })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/u/admin/api/history`, { headers: { "X-Api-Key": adminApiKey } })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/u/alice/api/history`, { headers: { "X-Api-Key": adminApiKey } })).status, 401);

    // 7. Step 6 Webhook isolation:
    const webhookPayload = JSON.stringify({
      Event: "system.webhooktest",
      Server: { Name: "EmbyTest", Id: "srv-1" },
    });
    // Alice's token is rejected on /api/webhook (admin) and /u/bob/api/webhook
    const aliceTokenOnAdminWh = await fetch(`${server.baseUrl}/api/webhook?token=${encodeURIComponent(aliceWebhookToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookPayload,
    });
    assert.equal(aliceTokenOnAdminWh.status, 401);

    const aliceTokenOnBobWh = await fetch(`${server.baseUrl}/u/bob/api/webhook?token=${encodeURIComponent(aliceWebhookToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookPayload,
    });
    assert.equal(aliceTokenOnBobWh.status, 401);

    // Alice's token is accepted on /u/alice/api/webhook
    const aliceTokenOnAliceWh = await fetch(`${server.baseUrl}/u/alice/api/webhook?token=${encodeURIComponent(aliceWebhookToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookPayload,
    });
    assert.notEqual(aliceTokenOnAliceWh.status, 401);
    assert.notEqual(aliceTokenOnAliceWh.status, 404);

    // Admin's token is accepted on /api/webhook and /u/admin/api/webhook, rejected on /u/alice/api/webhook
    const adminTokenOnAdminWh = await fetch(`${server.baseUrl}/api/webhook?token=${encodeURIComponent(adminWebhookToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookPayload,
    });
    assert.notEqual(adminTokenOnAdminWh.status, 401);

    const adminTokenOnAliceWh = await fetch(`${server.baseUrl}/u/alice/api/webhook?token=${encodeURIComponent(adminWebhookToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookPayload,
    });
    assert.equal(adminTokenOnAliceWh.status, 401);

    // 8. Admin switching users:
    // Fresh user alice has not completed setup -> lands on /setup
    const switchToAliceRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "open", name: "alice" }),
    });
    assert.equal(switchToAliceRes.status, 200);
    const switchToAliceBody = await switchToAliceRes.json();
    assert.equal(switchToAliceBody.path, "/setup");
    const adminOnAliceCookie = cookiePairFromResponse(switchToAliceRes);

    // Admin cookie now resolves unprefixed /api/auth/status in alice's context
    const adminOnAliceStatus = await (await fetch(`${server.baseUrl}/api/auth/status`, {
      headers: { Cookie: adminOnAliceCookie },
    })).json();
    assert.equal(adminOnAliceStatus.role, "admin");
    assert.equal(adminOnAliceStatus.activeUser, "alice");
    assert.equal(adminOnAliceStatus.nonAdminTenant, true);
    assert.equal(adminOnAliceStatus.webhookPath, "/u/alice/api/webhook");

    // Admin cannot accidentally overwrite credentials via /api/auth/credentials while viewing alice
    const blockedCredRes = await fetch(`${server.baseUrl}/api/auth/credentials`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminOnAliceCookie },
      body: JSON.stringify({ username: "alice", currentPassword: "admin-password-123", newPassword: "new-password-123" }),
    });
    assert.equal(blockedCredRes.status, 403);
    assert.equal((await blockedCredRes.json()).code, "SUPERVISED_ACCOUNT");

    // Complete alice's onboarding and verify switching to alice now lands on "/"
    const aliceDb = new Database(path.join(dataDir, "users", "alice", "plekt.db"));
    aliceDb.prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES ('onboarding', ?, ?)").run(
      JSON.stringify({ runState: "completed", completedAt: Date.now() }),
      Date.now(),
    );
    aliceDb.close();

    const switchToAliceCompletedRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "open", name: "alice" }),
    });
    assert.equal((await switchToAliceCompletedRes.json()).path, "/");

    // 9. Alice changes her own password via /api/auth/credentials
    const aliceWrongCurRes = await fetch(`${server.baseUrl}/api/auth/credentials`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ username: "alice", currentPassword: "wrong-password", newPassword: "alice-new-password-123" }),
    });
    assert.equal(aliceWrongCurRes.status, 401);

    const aliceChangePwRes = await fetch(`${server.baseUrl}/api/auth/credentials`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceCookie },
      body: JSON.stringify({ username: "alice", currentPassword: "alice-password-123", newPassword: "alice-new-password-123" }),
    });
    assert.equal(aliceChangePwRes.status, 200);
    const aliceNewCookie = cookiePairFromResponse(aliceChangePwRes);
    assert.equal((await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: aliceNewCookie } })).json()).authenticated, true);

    // 10. Step 7 User lifecycle actions: sign-out, stop/start, disable/enable, rename, remove
    // Sign-out invalidates alice's session cookie
    await delay(15);
    const signOutAliceRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "sign-out", name: "alice" }),
    });
    assert.equal(signOutAliceRes.status, 200);
    assert.equal((await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: aliceNewCookie } })).json()).authenticated, false);

    // Stop bob -> /u/bob/api/ping returns 503 INSTANCE_STOPPED, start bob -> 200
    const stopBobRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "stop", name: "bob" }),
    });
    assert.equal(stopBobRes.status, 200);
    const stoppedPing = await fetch(`${server.baseUrl}/u/bob/api/ping`);
    assert.equal(stoppedPing.status, 503);
    assert.equal((await stoppedPing.json()).code, "INSTANCE_STOPPED");

    const startBobRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "start", name: "bob" }),
    });
    assert.equal(startBobRes.status, 200);
    assert.equal((await fetch(`${server.baseUrl}/u/bob/api/ping`)).status, 200);

    // Disable bob -> login refused (401), /u/bob/api/ping returns 404; enable bob -> login works
    await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "disable", name: "bob" }),
    });
    const disabledLogin = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "bob", password: "bob-password-123" }),
    });
    assert.equal(disabledLogin.status, 401);
    assert.equal((await fetch(`${server.baseUrl}/u/bob/api/ping`)).status, 404);

    await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "enable", name: "bob" }),
    });
    assert.equal((await fetch(`${server.baseUrl}/u/bob/api/ping`)).status, 200);

    // Rename bob -> robert: moves folder and updates webhook path
    const renameBobRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "rename", name: "bob", newName: "robert" }),
    });
    assert.equal(renameBobRes.status, 200);
    assert.ok(!fs.existsSync(path.join(dataDir, "users", "bob")));
    assert.ok(fs.existsSync(path.join(dataDir, "users", "robert")));
    assert.equal((await fetch(`${server.baseUrl}/u/bob/api/ping`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/u/robert/api/ping`)).status, 200);

    // Promoted admins keep their tenant data while gaining full user
    // management access and the ability to switch between accounts.
    const promoteAliceRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "make-admin", name: "alice" }),
    });
    assert.equal(promoteAliceRes.status, 200);
    assert.equal((await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: aliceNewCookie } })).json()).authenticated, false);

    const aliceAdminLogin = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "alice", password: "alice-new-password-123" }),
    });
    assert.equal(aliceAdminLogin.status, 200);
    const aliceAdminCookie = cookiePairFromResponse(aliceAdminLogin);
    const aliceAdminStatus = await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: aliceAdminCookie } })).json();
    assert.equal(aliceAdminStatus.role, "admin");
    assert.equal(aliceAdminStatus.elevatedAdmin, true);
    assert.equal(aliceAdminStatus.supervisedView, false);
    const adminUsersRes = await fetch(`${server.baseUrl}/api/users`, { headers: { Cookie: aliceAdminCookie } });
    assert.equal(adminUsersRes.status, 200);
    assert.equal((await adminUsersRes.json()).users.find((user) => user.name === "alice")?.isAdmin, true);
    assert.equal((await fetch(`${server.baseUrl}/api/cache-stats`, { headers: { Cookie: aliceAdminCookie } })).status, 200);

    const switchFromAliceAdmin = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: aliceAdminCookie },
      body: JSON.stringify({ action: "open", name: "robert" }),
    });
    assert.equal(switchFromAliceAdmin.status, 200);
    const switchedAdminCookie = cookiePairFromResponse(switchFromAliceAdmin);
    const switchedAdminStatus = await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: switchedAdminCookie } })).json();
    assert.equal(switchedAdminStatus.role, "admin");
    assert.equal(switchedAdminStatus.loginUsername, "alice");
    assert.equal(switchedAdminStatus.activeUser, "robert");
    assert.equal(switchedAdminStatus.supervisedView, true);
    assert.equal((await fetch(`${server.baseUrl}/api/users`, { headers: { Cookie: switchedAdminCookie } })).status, 200);

    const demoteAliceRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "remove-admin", name: "alice" }),
    });
    assert.equal(demoteAliceRes.status, 200);
    assert.equal((await (await fetch(`${server.baseUrl}/api/auth/status`, { headers: { Cookie: aliceAdminCookie } })).json()).authenticated, false);
    const aliceAfterDemotion = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "alice", password: "alice-new-password-123" }),
    });
    assert.equal(aliceAfterDemotion.status, 200);
    const aliceStandardCookie = cookiePairFromResponse(aliceAfterDemotion);
    const demotedUsersRes = await fetch(`${server.baseUrl}/api/users`, { headers: { Cookie: aliceStandardCookie } });
    assert.equal(demotedUsersRes.status, 403);

    // Remove robert with deleteData: false -> folder kept; remove alice with deleteData: true -> folder deleted
    const removeRobertRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "remove", name: "robert", deleteData: false }),
    });
    assert.equal(removeRobertRes.status, 200);
    assert.ok(fs.existsSync(path.join(dataDir, "users", "robert")));

    const removeAliceRes = await fetch(`${server.baseUrl}/api/users/manage`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ action: "remove", name: "alice", deleteData: true }),
    });
    assert.equal(removeAliceRes.status, 200);
    assert.ok(!fs.existsSync(path.join(dataDir, "users", "alice")));

    // Admin account is protected from stop, disable, rename, remove
    for (const action of ["stop", "disable", "rename", "remove"]) {
      const res = await fetch(`${server.baseUrl}/api/users/manage`, {
        method: "POST",
        headers: { ...originHeaders, Cookie: adminCookie },
        body: JSON.stringify({ action, name: "admin", newName: "root2" }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "ADMIN_PROTECTED");
    }
  } finally {
    await server.stop();
    await removeTempDir(dataDir);
  }
});

test("Step 4 & 8: pristine single-user install requires claim, existing single-user install upgrades in place with zero moved files", async () => {
  // Part A: Pristine single-user install (no ADMIN_PASSWORD env, no config.json, no users.json) requires claim
  const pristineDir = makeTempDataDir("plekt-pristine-claim-");
  const pristineServer = await startTestServer(pristineDir, {
    ADMIN_PASSWORD: "",
    API_KEY: "",
    WEBHOOK_SECRET: "",
    SESSION_SECRET: "",
  });
  try {
    const statusRes = await fetch(`${pristineServer.baseUrl}/api/auth/status`);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.authenticated, false);
    assert.equal(statusBody.claimRequired, true);

    const historyRes = await fetch(`${pristineServer.baseUrl}/api/history`);
    assert.equal(historyRes.status, 403);
    assert.equal((await historyRes.json()).code, "CLAIM_REQUIRED");
  } finally {
    await pristineServer.stop();
    await removeTempDir(pristineDir);
  }

  // Part B: Existing single-user install upgrades in place with zero moved files and survives multi-user addition
  const upgradeDir = makeTempDataDir("plekt-upgrade-inplace-");
  const firstRun = await startTestServer(upgradeDir);
  let snapshotFilesBefore = [];
  try {
    const originHeaders = { "Content-Type": "application/json", Origin: firstRun.baseUrl };
    // Seed a watch record in the root database
    const rootDb = new Database(path.join(upgradeDir, "plekt.db"));
    rootDb.prepare(
      "INSERT INTO watch_history (id, title, media_type, source, watched_at, media_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("upgrade-watch-1", "Upgrade Test Movie", "movie", "plex", "2026-10-01T12:00:00.000Z", "tmdb:movie:550");
    rootDb.close();

    snapshotFilesBefore = fs.readdirSync(upgradeDir).sort();
    assert.ok(snapshotFilesBefore.includes("plekt.db"));
    assert.ok(!snapshotFilesBefore.includes("users.json"));

    // Admin login, API key, and /api/webhook work unchanged
    const loginRes = await fetch(`${firstRun.baseUrl}/api/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ username: "admin", password: "admin-password-123" }),
    });
    assert.equal(loginRes.status, 200);
    const adminCookie = cookiePairFromResponse(loginRes);

    const historyRes = await fetch(`${firstRun.baseUrl}/api/history`, {
      headers: { "X-Api-Key": "tenancy-test-api-key-32-characters-ok" },
    });
    assert.equal(historyRes.status, 200);
    const historyBody = await historyRes.json();
    assert.equal(historyBody.history.some((row) => row.title === "Upgrade Test Movie"), true);

    // Every original root file is still in place at the root
    const filesAfterBoot = fs.readdirSync(upgradeDir);
    for (const file of snapshotFilesBefore) {
      assert.ok(filesAfterBoot.includes(file), `expected root file ${file} not to move`);
    }

    // Add a second user; admin's root files still do not move and admin's history is untouched
    const addRes = await fetch(`${firstRun.baseUrl}/api/users`, {
      method: "POST",
      headers: { ...originHeaders, Cookie: adminCookie },
      body: JSON.stringify({ name: "seconduser", password: "second-password-123" }),
    });
    assert.equal(addRes.status, 201);
    for (const file of snapshotFilesBefore) {
      assert.ok(fs.existsSync(path.join(upgradeDir, file)), `expected root file ${file} to remain in place after adding user`);
    }
    const adminHistoryAfter = await (await fetch(`${firstRun.baseUrl}/api/history`, {
      headers: { "X-Api-Key": "tenancy-test-api-key-32-characters-ok" },
    })).json();
    assert.equal(adminHistoryAfter.history.some((row) => row.title === "Upgrade Test Movie"), true);
  } finally {
    await firstRun.stop();
    await removeTempDir(upgradeDir);
  }
});
