import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-security-hardening-");

const { db, parseJson } = await import("../server/src/db.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { openTenantDatabase } = await import("../server/src/utils/tenantDatabase.js");
const { addUserAccount } = await import("../server/src/utils/tenancy.js");
const { handleAuthClaim, handleAuthCredentials, signSession, handleLogin, sessionCookieName } = await import("../server/src/utils/auth.js");
const { mergeIncomingConfig, loadMediaConfig, saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { watchedThresholdPercent } = await import("../server/src/utils/tuning.js");
const {
  saveBackupDestination,
  loadBackupDestinations,
  createWatchHistoryBackup,
  listWatchBackups,
  readWatchBackupFile,
} = await import("../server/src/utils/watchHistoryBackups.js");
const { savePlektBackupConfig, loadPlektBackupConfig, getPlektBackupConfigId } = await import("../server/src/utils/plektBackups.js");
const { exportCollectionPage } = await import("../server/src/utils/backup.js");
const { fetchWithTimeout, __setOutboundDnsLookupForTest } = await import("../server/src/utils/outbound.js");
const { handleSeerrMediaStatus } = await import("../server/src/routes/admin.js");
const { redactSecrets } = await import("../server/src/utils/diagnosticLogger.js");
const { saveNetflixPreview, commitNetflixImport } = await import("../server/src/utils/netflixImport.js");
const { safeHttpUrl, safeCssBackgroundUrl } = await import("../public/modules/utils.js");
const buildCheck = await import("../scripts/build-check.js");

function makeReq({ method = "GET", headers = {}, query = {}, body = null, cookies = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    headers: lower,
    query,
    body,
    cookies,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    cookies: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    set(k, v) {
      if (k && typeof k === "object") {
        for (const [hk, hv] of Object.entries(k)) this.headers[String(hk).toLowerCase()] = hv;
      } else {
        this.headers[String(k).toLowerCase()] = v;
      }
      return this;
    },
    cookie(name, value) { this.cookies[name] = value; return this; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = typeof payload === "string" ? JSON.parse(payload) : payload; return this; },
    end() { return this; },
  };
}

test("Step 1: Netflix preview store is tenant-scoped and uses UUID preview IDs", async () => {
  const tenantADir = path.join(dataDir, "users", "tenant-a");
  const tenantBDir = path.join(dataDir, "users", "tenant-b");
  const tenantADb = openTenantDatabase(tenantADir);
  const tenantBDb = openTenantDatabase(tenantBDir);

  let previewIdA = "";
  runWithUserContext({ name: "tenanta", role: "user", dataDir: tenantADir, db: tenantADb }, () => {
    previewIdA = saveNetflixPreview({ reviews: [], records: [], sourceRows: [] });
    assert.match(previewIdA, /^[0-9a-f-]{36}$/i);
  });

  await runWithUserContext({ name: "tenantb", role: "user", dataDir: tenantBDir, db: tenantBDb }, async () => {
    await assert.rejects(
      () => commitNetflixImport(previewIdA),
      (err) => err?.status === 410,
      "Tenant B must not read or commit Tenant A's Netflix preview",
    );
  });
});

test("Step 1: watchHistoryBackups isolates tenant directory and rejects path separators", async () => {
  const tenantDir = path.join(dataDir, "users", "tenant-backup");
  const tenantDb = openTenantDatabase(tenantDir);

  const rootSnap = await createWatchHistoryBackup({ reason: "test-root" });
  const rootFile = rootSnap.filename || rootSnap.name;
  const rootBackupDir = path.join(dataDir, "backups", "watch-history");
  const tenantBackupDir = path.join(tenantDir, "backups", "watch-history");
  assert.ok(fs.existsSync(path.join(rootBackupDir, rootFile)));
  const rootFilesBefore = fs.readdirSync(rootBackupDir);

  await runWithUserContext({ name: "tenantbk", role: "user", dataDir: tenantDir, db: tenantDb }, async () => {
    const tenantSnap = await createWatchHistoryBackup({ reason: "test-tenant" });
    const tenantFile = tenantSnap.filename || tenantSnap.name;
    assert.ok(fs.existsSync(path.join(tenantBackupDir, tenantFile)));
    assert.deepEqual(fs.readdirSync(rootBackupDir), rootFilesBefore, "Tenant backup must not write into root watch-history dir");
    const tenantList = listWatchBackups();
    assert.ok(tenantList.some((item) => (item.filename || item.name) === tenantFile));
    assert.throws(() => readWatchBackupFile(`../${rootFile}`), /Invalid .*backup filename/);
    assert.throws(() => readWatchBackupFile("..\\evil.json.gz"), /Invalid .*backup filename/);
  });
});

test("Step 1: non-admin tenant loadMediaConfig does not mutate root tuning", async () => {
  await saveMediaConfig({ tuning: { watchedThresholdPercent: 85 } });
  assert.equal(watchedThresholdPercent(), 85);

  const tenantDir = path.join(dataDir, "users", "tenant-tune");
  const tenantDb = openTenantDatabase(tenantDir);
  await runWithUserContext({ name: "tenanttune", role: "user", dataDir: tenantDir, db: tenantDb }, async () => {
    await saveMediaConfig({ tuning: { watchedThresholdPercent: 55 } });
    await loadMediaConfig({ resolveConnections: false });
  });

  assert.equal(watchedThresholdPercent(), 85, "Tenant config must not overwrite root process tuning");
});

test("Step 1: root admin rename colliding with managed user returns 409", async () => {
  const claimRes = makeRes();
  await handleAuthClaim(makeReq({
    method: "POST",
    headers: { host: "localhost:5055", origin: "http://localhost:5055" },
    body: Buffer.from(JSON.stringify({
      username: "rootadmin",
      password: "SuperSecretPass123!",
      confirmPassword: "SuperSecretPass123!",
    })),
  }), claimRes);
  assert.equal(claimRes.statusCode, 200);

  addUserAccount({ dataDir, name: "alice", password: "AlicePassword123!" });

  const cookieName = Object.keys(claimRes.cookies)[0] || sessionCookieName();
  const token = signSession("rootadmin");
  const req = makeReq({
    method: "POST",
    headers: {
      host: "localhost:5055",
      origin: "http://localhost:5055",
      cookie: `${cookieName}=${token}`,
    },
    cookies: { [cookieName]: token },
    body: Buffer.from(JSON.stringify({
      currentPassword: "SuperSecretPass123!",
      username: "alice",
    })),
  });
  const res = makeRes();
  await handleAuthCredentials(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(String(res.body?.error || ""), /already used/i);
});

test("Step 2: mergeIncomingConfig clears preserved secrets when server baseUrl changes", async () => {
  await saveMediaConfig({
    plex: { baseUrl: "https://plex-a.example.com", token: "secret-plex-token", serverName: "A" },
    emby: { baseUrl: "https://emby-a.example.com", apiKey: "secret-emby-key" },
    seerr: { baseUrl: "https://seerr-a.example.com", apiKey: "secret-seerr-key" },
  });

  // Same URL preserves secrets when omitted
  const sameUrlMerged = await mergeIncomingConfig({
    plex: { baseUrl: "https://plex-a.example.com/", serverName: "A2" },
    emby: { baseUrl: "https://emby-a.example.com" },
    seerr: { baseUrl: "https://seerr-a.example.com" },
  });
  assert.equal(sameUrlMerged.plex.token, "secret-plex-token");
  assert.equal(sameUrlMerged.emby.apiKey, "secret-emby-key");
  assert.equal(sameUrlMerged.seerr.apiKey, "secret-seerr-key");

  // Changed URL clears preserved secrets unless explicitly re-entered
  const changedUrlMerged = await mergeIncomingConfig({
    plex: { baseUrl: "https://attacker.example.com" },
    emby: { baseUrl: "https://attacker.example.com" },
    seerr: { baseUrl: "https://attacker.example.com" },
  });
  assert.equal(changedUrlMerged.plex.token, "");
  assert.equal(changedUrlMerged.emby.apiKey, "");
  assert.equal(changedUrlMerged.seerr.apiKey, "");
});

test("Step 2: backup destination secrets & Plekt backup passphrases are encrypted at rest and clear on URL change", () => {
  const saved = saveBackupDestination({
    type: "webdav",
    label: "My WebDAV",
    enabled: true,
    settings: { url: "https://dav-a.example.com/backups", username: "bob" },
    secrets: { password: "super-secret-webdav-password" },
  });
  const rawRow = parseJson(db.prepare("SELECT data FROM settings WHERE id = 'watchBackupDestinations'").get()?.data, []);
  const storedRaw = rawRow.find((item) => item.id === saved.id);
  assert.notEqual(storedRaw.secrets.password, "super-secret-webdav-password");
  assert.equal(storedRaw.secrets.password.__encrypted, true);

  // Decrypts transparently for internal callers
  const loaded = loadBackupDestinations().find((item) => item.id === saved.id);
  assert.equal(loaded.secrets.password, "super-secret-webdav-password");

  // Changing destination URL clears preserved password
  saveBackupDestination({
    id: saved.id,
    type: "webdav",
    label: "My WebDAV",
    enabled: true,
    settings: { url: "https://attacker-dav.example.com/backups", username: "bob" },
    secrets: {},
  });
  const afterUrlChange = loadBackupDestinations().find((item) => item.id === saved.id);
  assert.equal(afterUrlChange.secrets.password, undefined);

  // Plekt full backup passphrase encrypted at rest + legacy plaintext readable
  savePlektBackupConfig({
    enabled: true,
    rememberPassphrase: true,
    passphrase: "my-very-strong-passphrase",
    remoteEnabled: true,
    remoteRememberPassphrase: true,
    remotePassphrase: "my-remote-strong-passphrase",
  });
  const plektCfgId = getPlektBackupConfigId();
  const rawPlektCfg = parseJson(db.prepare("SELECT data FROM settings WHERE id = ?").get(plektCfgId)?.data, {});
  assert.equal(rawPlektCfg.passphrase.__encrypted, true);
  assert.equal(rawPlektCfg.remotePassphrase.__encrypted, true);
  const loadedPlektCfg = loadPlektBackupConfig();
  assert.equal(loadedPlektCfg.passphrase, "my-very-strong-passphrase");
  assert.equal(loadedPlektCfg.remotePassphrase, "my-remote-strong-passphrase");

  // Legacy plaintext passphrase still decrypts cleanly
  db.prepare("UPDATE settings SET data = ? WHERE id = ?").run(JSON.stringify({
    ...rawPlektCfg,
    passphrase: "legacy-plaintext-passphrase",
  }), plektCfgId);
  assert.equal(loadPlektBackupConfig().passphrase, "legacy-plaintext-passphrase");
});

test("Step 2: outbound fetchWithTimeout rejects hostname resolving to cloud metadata IP", async () => {
  __setOutboundDnsLookupForTest(async () => [{ address: "169.254.169.254", family: 4 }]);
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://metadata-rebind.example.test/latest", { method: "GET" }),
      /metadata/i,
    );
  } finally {
    __setOutboundDnsLookupForTest(null);
  }
});

test("Step 2: handleSeerrMediaStatus rejects invalid mediaType and mediaId path segments", async () => {
  const cookieName = sessionCookieName();
  const token = signSession("rootadmin");
  const reqWithQuery = (query) => makeReq({
    method: "GET",
    headers: { cookie: `${cookieName}=${token}` },
    cookies: { [cookieName]: token },
    query,
  });

  const resBadType = makeRes();
  await handleSeerrMediaStatus(reqWithQuery({ mediaType: "../settings", mediaId: "123" }), resBadType);
  assert.equal(resBadType.statusCode, 400);

  const resBadId = makeRes();
  await handleSeerrMediaStatus(reqWithQuery({ mediaType: "movie", mediaId: "123/../../users" }), resBadId);
  assert.equal(resBadId.statusCode, 400);
});

test("Step 2: browser-safe runtimeState export strips calendarFeedToken and diagnosticLogger redacts camelCase secrets", () => {
  db.prepare("INSERT OR REPLACE INTO runtime_state (id, data, updated_at) VALUES ('calendar', ?, ?)")
    .run(JSON.stringify({ calendarFeedToken: "secret-cal-token-xyz", lastBuiltAt: 12345 }), Date.now());
  const exported = exportCollectionPage("runtimeState", { browserSafe: true });
  const calDoc = exported.documents.find((doc) => doc.id === "calendar");
  assert.ok(calDoc);
  assert.equal(calDoc.data.calendarFeedToken, undefined);
  assert.equal(calDoc.data.lastBuiltAt, 12345);

  const redacted = redactSecrets(
    "apiKey=plain-api-key accessToken=plain-access refreshToken=plain-refresh passphrase=plain-passphrase Authorization: Basic dXNlcjpwYXNz",
  );
  assert.doesNotMatch(redacted, /plain-api-key/);
  assert.doesNotMatch(redacted, /plain-access/);
  assert.doesNotMatch(redacted, /plain-refresh/);
  assert.doesNotMatch(redacted, /plain-passphrase/);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz/);
});

test("Step 2: login rejects invalid root password cleanly without error", async () => {
  const req = makeReq({
    method: "POST",
    headers: { host: "localhost:5055", origin: "http://localhost:5055" },
    body: Buffer.from(JSON.stringify({ username: "rootadmin", password: "wrong-password" })),
  });
  const res = makeRes();
  await handleLogin(req, res);
  assert.equal(res.statusCode, 401);
});

test("Step 3: frontend URL and CSS background sanitizers block unsafe schemes and CSS breakouts", () => {
  assert.equal(safeHttpUrl("https://youtube.com/watch?v=abc"), "https://youtube.com/watch?v=abc");
  assert.equal(safeHttpUrl("http://localhost:8096/web"), "http://localhost:8096/web");
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(safeHttpUrl("vbscript:msgbox(1)"), "");

  assert.equal(safeCssBackgroundUrl("/media/backdrops/abc.jpg"), "/media/backdrops/abc.jpg");
  assert.equal(safeCssBackgroundUrl("https://image.tmdb.org/t/p/w1280/abc.jpg"), "https://image.tmdb.org/t/p/w1280/abc.jpg");
  assert.equal(safeCssBackgroundUrl("javascript:alert(1)"), "");
  assert.equal(safeCssBackgroundUrl("//evil.example/bg.png"), "");
  assert.equal(safeCssBackgroundUrl("https://a.test/x\nbody{}"), "");
  const encoded = safeCssBackgroundUrl("https://a.test/x');background:url(//evil");
  assert.ok(encoded && !encoded.includes("'") && !encoded.includes("(") && !encoded.includes(")"));
});

test("Step 3: hardened build-check static guards catch auth/route/outbound bypasses and pass on real codebase", () => {
  const fakeCommented = `export async function handleFake(req, res) { // await requireAdmin(req, res)\n const s = "await requireAdmin(req, res)"; return res.json({}); }`;
  const fakeBodies = buildCheck.extractFunctionBodies(fakeCommented);
  assert.equal(buildCheck.hasRequiredAuthGuard(fakeBodies.get("handleFake")), false);

  const fakeNoAwait = `export async function handleNoAwait(req, res) { requireAdmin(req, res); resolveAdminPrincipal(req); return res.json({}); }`;
  assert.equal(buildCheck.hasRequiredAuthGuard(buildCheck.extractFunctionBodies(fakeNoAwait).get("handleNoAwait")), false);

  const validWithBraces = "export async function handleGood(req, res) { const x = `}`; if (!(await requireAdmin(req, res))) return; return res.json({ ok: true }); }";
  assert.equal(buildCheck.hasRequiredAuthGuard(buildCheck.extractFunctionBodies(validWithBraces).get("handleGood")), true);

  const realServerSource = fs.readFileSync(path.resolve("server/server.js"), "utf8");
  assert.deepEqual(buildCheck.checkDirectServerRoutes(realServerSource), []);
  const sneakyServerSource = `${realServerSource}\napp.get("/api/unlisted-backdoor", (_req, res) => res.json({}));\n`;
  assert.deepEqual(buildCheck.checkDirectServerRoutes(sneakyServerSource), ["GET /api/unlisted-backdoor"]);

  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "const p = fetch('https://x.test');").length > 0);
  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "fetch('https://x.test').then(() => {});").length > 0);
  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "globalThis.fetch('https://x.test');").length > 0);
  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "import https from 'node:https';").length > 0);
  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "import { request } from 'undici';").length > 0);
  assert.ok(buildCheck.checkOutboundSource("server/src/foo.js", "const ws = new WebSocket('wss://x.test');").length > 0);
  assert.deepEqual(buildCheck.checkOutboundSource("server/src/foo.js", "// do not call fetch() directly\nexport const ok = true;\n"), []);

  const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJs(p);
    return entry.isFile() && entry.name.endsWith(".js") ? [p] : [];
  });
  const serverFiles = walkJs("server");
  const realOutboundOffenders = serverFiles.flatMap((file) => buildCheck.checkOutboundSource(file, fs.readFileSync(file, "utf8")));
  assert.deepEqual(realOutboundOffenders, []);

  const indexSource = fs.readFileSync("server/src/index.js", "utf8");
  const indexStripped = buildCheck.stripJs(indexSource, { stripStrings: true });
  const routedHandlers = new Set([...indexStripped.matchAll(/return\s+(handle[A-Z]\w*)\s*\(\s*req\s*,\s*res/g)].map((m) => m[1]));
  const handlerBodies = new Map();
  for (const file of ["server/src/index.js", "server/src/utils/auth.js", ...walkJs("server/src/routes")]) {
    for (const [name, body] of buildCheck.extractFunctionBodies(fs.readFileSync(file, "utf8"))) {
      handlerBodies.set(name, { file, body });
    }
  }
  const publicHandlers = new Set(["handlePing", "handleChangelog", "handleLogin", "handleLogout", "handleAuthStatus", "handleAuthClaim", "handleCalendarFeed"]);
  const authOffenders = [];
  for (const handler of routedHandlers) {
    const def = handlerBodies.get(handler);
    assert.ok(def, `Missing definition for routed handler ${handler}`);
    if (publicHandlers.has(handler)) continue;
    if (!buildCheck.hasRequiredAuthGuard(def.body)) authOffenders.push(`${def.file}: ${handler}`);
  }
  assert.deepEqual(authOffenders, []);
});
