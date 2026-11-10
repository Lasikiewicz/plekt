import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// App audit, 10 November 2026, step 7: the cloud-metadata block was an exact string
// match, saved credentials could be sent to a URL taken from the request, and an
// added user could read upstream response text from a URL they chose.

makeTempDataDir("plekt-outbound-guard-");

const { assertSafeOutboundUrl } = await import("../server/src/utils/outbound.js");
const auth = await import("../server/src/utils/auth.js");
const { addUserAccount } = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleSeerrStatus, handleTestPlexNotifications } = await import("../server/src/routes/admin.js");
const { handleTautulli } = await import("../server/src/routes/tautulli.js");
const { probePlexNotificationSocket } = await import("../server/src/utils/plexNotificationListener.js");
const { AUTH } = await import("../server/src/appConfig.js");

const created = addUserAccount({ name: "alice", password: "alice-password-123" });
assert.ok(!created.status || created.status < 300, JSON.stringify(created.body || created));

let COOKIE = "";
auth.setSessionCookie({ cookie: (name) => { COOKIE = name; } }, "probe");
const aliceCookie = () => auth.signSession("alice", { role: "user" });
const adminCookie = () => auth.signSession(AUTH.username, { role: "admin" });

function makeReq({ cookie = null, method = "GET", body = undefined } = {}) {
  return { method, cookies: cookie ? { [COOKIE]: cookie } : {}, headers: {}, get: () => undefined, body, resume() {}, ip: "127.0.0.1" };
}
function makeRes() {
  const res = { statusCode: 200, payload: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (values) => { Object.assign(res.headers, values); return res; };
  res.send = (text) => { res.payload = text ? JSON.parse(text) : null; return res; };
  return res;
}
async function call(handler, req, ...args) {
  const res = makeRes();
  const tenant = auth.resolveSessionTenantContext(req);
  await (tenant ? runWithUserContext(tenant, () => handler(req, res, ...args)) : handler(req, res, ...args));
  return res;
}

test("the metadata block survives alternate spellings of the same address", () => {
  const blocked = [
    "http://169.254.169.254/latest",
    "http://169.254.169.254./latest",
    "http://[::ffff:169.254.169.254]/latest",
    "http://[::ffff:a9fe:a9fe]/latest",
    "http://[::169.254.169.254]/latest",
    "http://[64:ff9b::169.254.169.254]/latest",
    "http://2852039166/latest",
    "http://0xa9.0xfe.0xa9.0xfe/latest",
    "http://0251.0376.0251.0376/latest",
    "http://METADATA.GOOGLE.INTERNAL./computeMetadata/v1",
    "http://metadata./x",
    "http://[fd00:ec2::254]/latest",
    "http://[FD00:EC2:0:0:0:0:0:254]/latest",
    "http://169.254.170.2/v2/credentials",
    "http://100.100.100.200/latest",
    "http://168.63.129.16/machine",
    "http://192.0.0.192/latest",
    "http://instance-data/latest",
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeOutboundUrl(url), /blocked metadata endpoint/, url);
  }
});

test("LAN, loopback and mapped LAN addresses stay allowed", () => {
  for (const url of [
    "http://192.168.1.20:32400",
    "http://127.0.0.1:32400",
    "http://localhost:8096",
    "http://[::1]:8096",
    "http://[::ffff:192.168.1.20]:8096",
    "https://plex.example.com",
    "http://169.254.1.1",
  ]) {
    assert.doesNotThrow(() => assertSafeOutboundUrl(url), url);
  }
});

test("the Plex notification probe refuses a metadata URL before opening a socket", async () => {
  const result = await probePlexNotificationSocket({ baseUrl: "http://[::ffff:169.254.169.254]", token: "t" });
  assert.equal(result.ok, false);
  assert.match(result.error, /blocked metadata endpoint/);
});

test("test-plex-notifications never sends the saved token to a different URL", async () => {
  await saveMediaConfig({ plex: { baseUrl: "http://192.168.1.10:32400", token: "saved-plex-token" } });
  const res = await call(handleTestPlexNotifications, makeReq({
    cookie: adminCookie(),
    method: "POST",
    body: { url: "http://192.168.1.99:32400" },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, "TOKEN_REQUIRED_FOR_NEW_URL");
});

test("test-plex-notifications refuses a metadata URL even with its own token", async () => {
  const res = await call(handleTestPlexNotifications, makeReq({
    cookie: adminCookie(),
    method: "POST",
    body: { url: "http://169.254.169.254", token: "own" },
  }));
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /blocked metadata endpoint/);
});

test("Tautulli test and preview never pair the saved key with a different URL", async () => {
  await saveMediaConfig({ tautulli: { baseUrl: "http://192.168.1.10:8181", apiKey: "saved-tautulli-key" } });
  for (const action of ["test", "preview", "preview-start"]) {
    const res = await call(handleTautulli, makeReq({
      cookie: adminCookie(),
      method: "POST",
      body: { baseUrl: "http://192.168.1.99:8181", userId: "1" },
    }), action);
    assert.equal(res.statusCode, 400, action);
    assert.equal(res.payload.code, "TOKEN_REQUIRED_FOR_NEW_URL", action);
  }
});

// The audit reported that /api/seerr/status returns the first 200 characters of the
// upstream body. sendJson replaces every 5xx body with a generic message, so the text
// never leaves the server; this keeps it that way for an added user's own Seerr URL.
test("Seerr status never returns upstream response text to an added user", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("internal-secret-page", { status: 403 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const tenant = auth.resolveSessionTenantContext(makeReq({ cookie: aliceCookie() }));
  assert.ok(tenant, "alice resolves to her own tenant");
  await runWithUserContext(tenant, () => saveMediaConfig({ seerr: { baseUrl: "http://192.168.1.10:5055", apiKey: "seerr-key" } }));
  const res = await call(handleSeerrStatus, makeReq({ cookie: aliceCookie() }));
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(res.payload), /internal-secret-page/);
});
