import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// The Seerr availability cache was keyed by media only, so one user could be
// served another user's Seerr answer for three minutes (10 November 2026 audit,
// step 2). Each user's Seerr server is answered here by a stubbed fetch that
// reports a different status per API key.

makeTempDataDir("plekt-seerr-status-cache-");

const { AUTH } = await import("../server/src/appConfig.js");
const auth = await import("../server/src/utils/auth.js");
const { addUserAccount } = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { handleSeerrMediaStatus } = await import("../server/src/routes/admin.js");

const created = addUserAccount({ name: "alice", password: "alice-password-123" });
assert.ok(!created.status || created.status < 300, JSON.stringify(created.body || created));

let COOKIE = "";
auth.setSessionCookie({ cookie: (name) => { COOKIE = name; } }, "probe");
assert.ok(COOKIE);
const adminName = AUTH.username;

function makeReq({ cookie = null, query = {} } = {}) {
  return {
    method: "GET",
    cookies: cookie ? { [COOKIE]: cookie } : {},
    headers: {},
    get: () => undefined,
    query,
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

// Each Seerr key gets its own answer: the admin's title is available (status 5),
// alice's is not requested (status 1).
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, options = {}) => {
  const apiKey = options.headers?.["X-Api-Key"];
  const status = apiKey === "admin-seerr-key" ? 5 : 1;
  return new Response(JSON.stringify({ id: 1, status }), { status: 200, headers: { "content-type": "application/json" } });
};

test("a Seerr status answered for one user is not served to another user", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const seerrSettings = (apiKey) => ({ seerr: { baseUrl: "https://seerr.example.com", apiKey, disabled: false } });
  await saveMediaConfig(seerrSettings("admin-seerr-key"));
  const aliceCtx = auth.resolveSessionTenantContext(makeReq({ cookie: aliceCookie() }));
  assert.ok(aliceCtx, "alice's session must resolve to her own tenant");
  await runWithUserContext(aliceCtx, () => saveMediaConfig(seerrSettings("alice-seerr-key")));

  // Admin first, so the admin's answer is in the cache when alice asks.
  const adminRes = await call(handleSeerrMediaStatus, makeReq({ cookie: adminCookie(), query: { mediaType: "movie", mediaId: "42" } }));
  assert.equal(adminRes.payload?.status, 5);
  const aliceRes = await call(handleSeerrMediaStatus, makeReq({ cookie: aliceCookie(), query: { mediaType: "movie", mediaId: "42" } }));
  assert.equal(aliceRes.payload?.status, 1, "alice must get her own Seerr answer, not the admin's cached one");

  // And the other way round for a different title.
  const aliceFirst = await call(handleSeerrMediaStatus, makeReq({ cookie: aliceCookie(), query: { mediaType: "movie", mediaId: "43" } }));
  assert.equal(aliceFirst.payload?.status, 1);
  const adminSecond = await call(handleSeerrMediaStatus, makeReq({ cookie: adminCookie(), query: { mediaType: "movie", mediaId: "43" } }));
  assert.equal(adminSecond.payload?.status, 5, "the admin must not be served alice's cached answer");
});
