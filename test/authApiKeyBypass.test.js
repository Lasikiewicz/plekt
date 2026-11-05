import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { makeTempDataDir } from "./helpers.js";

// App audit, 5 November 2026: any X-Api-Key or Bearer value made the server skip
// session tenant routing, so an added user's session cookie was read in the
// install admin's context and GET /api/auth/apikey returned the admin's key.

makeTempDataDir("plekt-auth-apikey-bypass-");

const { AUTH } = await import("../server/src/appConfig.js");
const auth = await import("../server/src/utils/auth.js");
const { addUserAccount } = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { handlePlektRestore, handlePlektRestoreUpload } = await import("../server/src/routes/plektRestore.js");
const { handleTestConnection } = await import("../server/src/routes/admin.js");
const { saveUploadedBackup } = await import("../server/src/utils/plektRestore.js");

const created = addUserAccount({ name: "alice", password: "alice-password-123" });
assert.ok(!created.status || created.status < 300, JSON.stringify(created.body || created));

// The session cookie's name, read from the code that sets it.
let COOKIE = "";
auth.setSessionCookie({ cookie: (name) => { COOKIE = name; } }, "probe");
assert.ok(COOKIE);
const adminName = AUTH.username;

function makeReq({ cookie = null, headers = {}, method = "GET", body = undefined } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    cookies: cookie ? { [COOKIE]: cookie } : {},
    headers: lower,
    get: (name) => lower[String(name).toLowerCase()],
    body,
    resume() {},
    ip: "127.0.0.1",
  };
}

function makeRes() {
  const res = { statusCode: 200, payload: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (values) => { Object.assign(res.headers, values); return res; };
  res.send = (text) => { res.payload = text ? JSON.parse(text) : null; return res; };
  return res;
}

// Mirrors server.js handleApiDispatch: resolve the session's tenant first, then
// run the handler inside that context.
async function call(handler, req) {
  const res = makeRes();
  const tenant = auth.resolveSessionTenantContext(req);
  await (tenant ? runWithUserContext(tenant, () => handler(req, res)) : handler(req, res));
  return res;
}

const aliceCookie = () => auth.signSession("alice", { role: "user" });
const adminCookie = () => auth.signSession(adminName, { role: "admin" });

test("a user session with a junk API key cannot read the admin's key or webhook secret", async () => {
  for (const headers of [{ "X-Api-Key": "junk" }, { Authorization: "Bearer junk" }]) {
    const keyRes = await call(auth.handleAuthApiKey, makeReq({ cookie: aliceCookie(), headers }));
    assert.notEqual(keyRes.payload?.apiKey, AUTH.apiKey, "the admin API key must not be returned");
    const secretRes = await call(auth.handleAuthWebhookSecret, makeReq({ cookie: aliceCookie(), headers }));
    assert.notEqual(secretRes.payload?.webhookToken, AUTH.webhookSecret, "the admin webhook secret must not be returned");
  }
});

test("a user session in the root context is not accepted", async () => {
  const res = makeRes();
  await auth.handleAuthApiKey(makeReq({ cookie: aliceCookie() }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, "ADMIN_ONLY");
  assert.equal(res.payload.apiKey, undefined);
});

test("the real admin API key and the admin's session still work", async () => {
  const byKey = await call(auth.handleAuthApiKey, makeReq({ headers: { "X-Api-Key": AUTH.apiKey } }));
  assert.equal(byKey.statusCode, 200);
  assert.equal(byKey.payload.apiKey, AUTH.apiKey);
  const byKeyWithUserCookie = await call(auth.handleAuthApiKey, makeReq({ cookie: aliceCookie(), headers: { "X-Api-Key": AUTH.apiKey } }));
  assert.equal(byKeyWithUserCookie.statusCode, 200, "the admin key itself still authenticates");
  const bySession = await call(auth.handleAuthApiKey, makeReq({ cookie: adminCookie() }));
  assert.equal(bySession.statusCode, 200);
  assert.equal(bySession.payload.apiKey, AUTH.apiKey);
});

test("a user session gets 403 on restore and upload", async () => {
  const restoreStatus = await call(handlePlektRestore, makeReq({ cookie: aliceCookie() }));
  assert.equal(restoreStatus.statusCode, 403);
  const restoreStart = await call(handlePlektRestore, makeReq({ cookie: aliceCookie(), method: "POST", body: { filename: "x.json" } }));
  assert.equal(restoreStart.statusCode, 403);
  const upload = await call(handlePlektRestoreUpload, makeReq({ cookie: aliceCookie(), method: "POST" }));
  assert.equal(upload.statusCode, 403);
  const adminStatus = await call(handlePlektRestore, makeReq({ cookie: adminCookie() }));
  assert.equal(adminStatus.statusCode, 200);
});

test("test-connection never sends the saved token to a different URL", async () => {
  for (const cookie of [adminCookie(), aliceCookie()]) {
    const res = await call(handleTestConnection, makeReq({
      cookie,
      method: "POST",
      body: { type: "emby", url: "https://attacker.example", token: "" },
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "TOKEN_REQUIRED_FOR_NEW_URL");
  }
});

test("backup uploads are capped and need free space", async () => {
  const source = (bytes) => Readable.from([Buffer.alloc(bytes, 1)]);
  await assert.rejects(saveUploadedBackup(source(10), { declaredBytes: 11, maxBytes: 10 }), { status: 413 });
  await assert.rejects(saveUploadedBackup(source(11), { maxBytes: 10 }), { status: 413 });
  await assert.rejects(saveUploadedBackup(source(5), { declaredBytes: 5, maxBytes: 10, freeBytes: () => 100, freeSpaceMarginBytes: 200 }), { status: 507 });
  const saved = await saveUploadedBackup(source(5), { declaredBytes: 5, maxBytes: 10, freeBytes: () => 1000, freeSpaceMarginBytes: 10 });
  assert.equal(saved.sizeBytes, 5);
});
