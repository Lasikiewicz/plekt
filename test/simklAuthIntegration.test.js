import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-integration-");
const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { handleTrackerAuth, handleTrackerConnections } = await import("../server/src/routes/trackerAuth.js");
const { freshSimklConnection } = await import("../server/src/utils/trackers/simklConnection.js");
const { isTrackerProvider } = await import("../server/src/utils/trackers/registry.js");
const { simklTransport } = await import("../server/src/utils/trackers/simklTransport.js");
const { resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");
const { BUNDLED_SIMKL_CLIENT_ID } = await import("../server/src/utils/simklAppConfig.js");
const tokens = { access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", scope: "media:read media:write", expires_in: 3600 };
const device = { device_code: "private-device", user_code: "ABCD", verification_uri: "https://simkl.com/pin", expires_in: 600, interval: 5 };
const originalFetch = globalThis.fetch;
const connect = (id = "one") => repo.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: id, accessToken: "old-access", refreshToken: "old-refresh" });

function request(method = "GET", body = {}, headers = {}, session = true) {
  const payload = Buffer.from(JSON.stringify({ u: "admin", iat: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH.sessionSecret).update(payload).digest("base64url");
  const values = { host: "localhost:5056", origin: "http://localhost:5056", ...headers };
  return { method, body, cookies: session ? { plembfin_session: `${payload}.${signature}` } : {}, get: (name) => values[name.toLowerCase()] };
}
async function call(path, req = request(), connections = false) {
  const res = { status(code) { this.code = code; return this; }, set() { return this; }, send(body) { this.body = JSON.parse(body); return this; } };
  await (connections ? handleTrackerConnections : handleTrackerAuth)(req, res, path);
  return res;
}
const begin = () => call("tracker-auth/simkl/start", request("POST"));
const status = (id) => call(`tracker-auth/simkl/${id}/status`);
const due = (id) => db.prepare("UPDATE tracker_auth_flows SET last_polled_at=NULL WHERE id=?").run(id);

test.beforeEach(() => {
  simklTransport.resetForTests();
  for (const table of ["tracker_connections", "tracker_auth_flows"]) db.prepare(`DELETE FROM ${table}`).run();
  globalThis.fetch = async (url) => Response.json(String(url).endsWith("/device") ? device : String(url).endsWith("/settings") ? { account: { id: 123 }, user: { name: "Test user" } } : tokens);
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

test("Simkl auth requires an admin browser session and same origin", async () => {
  globalThis.fetch = () => { throw new Error("must not reach provider"); };
  assert.equal((await call("tracker-auth/simkl/start", request("POST", {}, {}, false))).code, 401);
  assert.equal((await call("tracker-auth/simkl/start", request("POST", {}, { "x-api-key": AUTH.apiKey }, false))).code, 403);
  assert.equal((await call("tracker-auth/simkl/start", request("POST", {}, { origin: "https://other.example" }))).code, 403);
});

test("device grant and tokens persist encrypted, public responses redact credentials and the connection joins the registry", async () => {
  const start = await begin();
  assert.equal(start.code, 200);
  const flow = repo.getTrackerAuthFlow(start.body.flowId, { includeCredentials: true });
  assert.equal(flow.deviceCode, device.device_code);
  assert.equal(flow.clientId, BUNDLED_SIMKL_CLIENT_ID);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM tracker_auth_flows").get()).includes(device.device_code), false);
  const completed = await status(flow.id);
  assert.equal(completed.body.status, "completed");
  assert.equal("syncEnabled" in completed.body, false);
  assert.equal(JSON.stringify(completed.body).includes(tokens.access_token), false);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM tracker_connections").get()).includes(tokens.refresh_token), false);
  assert.equal(repo.getTrackerConnection("simkl", { includeCredentials: true }).accessToken, tokens.access_token);
  assert.equal(repo.getTrackerConnection("simkl", { includeCredentials: true }).clientId, BUNDLED_SIMKL_CLIENT_ID);
  const syncStart = db.prepare("SELECT initial_sync_mode,baseline_complete FROM tracker_connections WHERE provider='simkl'").get();
  assert.equal(syncStart.initial_sync_mode, "baseline", "new authorization always starts with a baseline");
  assert.equal(syncStart.baseline_complete, 0);
  assert.equal(isTrackerProvider("simkl"), true);
  assert.deepEqual(repo.listTrackerConnections().map(({ provider }) => provider), ["simkl"]);
  assert.deepEqual(repo.unknownTrackerProviderData(), []);
  const read = await call("tracker-connections/simkl", request("GET"), true);
  assert.equal(read.code, 200);
  assert.equal(read.body.connection.provider, "simkl");
  assert.equal(JSON.stringify(read.body).includes(tokens.access_token), false);
  assert.equal((await call("tracker-connections/simkl", request("DELETE"), true)).body.removed, true);
});

test("pending/slow_down/429 persist pacing; arbitrary 400 is terminal", async () => {
  const { body: { flowId } } = await begin();
  let calls = 0;
  let error = "slow_down";
  let code = 400;
  globalThis.fetch = async () => { calls++; return Response.json({ error }, { status: code, headers: { "retry-after": "11" } }); };
  assert.equal((await status(flowId)).body.retryAfter, 10);
  assert.equal(repo.getTrackerAuthFlow(flowId).intervalSeconds, 10);
  assert.equal((await status(flowId)).code, 202);
  assert.equal(calls, 1);
  due(flowId); error = "authorization_pending";
  assert.equal((await status(flowId)).body.retryAfter, 10);
  due(flowId); code = 429;
  assert.equal((await status(flowId)).body.retryAfter, 11);
  assert.equal(repo.getTrackerAuthFlow(flowId).intervalSeconds, 11);
  // due() skips the persisted 11s interval, so also clear both 429 cooldowns.
  simklTransport.resetForTests(); resetOutboundGovernor();
  due(flowId); code = 400; error = "invalid_grant";
  assert.equal((await status(flowId)).code, 502);
  assert.equal(repo.getTrackerAuthFlow(flowId).status, "expired");
});

test("expired flows never contact Simkl, including expiry during exchange", async () => {
  const { body: { flowId } } = await begin();
  db.prepare("UPDATE tracker_auth_flows SET expires_at=1 WHERE id=?").run(flowId);
  globalThis.fetch = () => { throw new Error("must not contact provider"); };
  assert.equal((await status(flowId)).code, 410);
  globalThis.fetch = async () => Response.json(device);
  const second = (await begin()).body.flowId;
  db.prepare("UPDATE tracker_auth_flows SET expires_at=? WHERE id=?").run(Date.now() + 50, second);
  globalThis.fetch = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 75));
    return Response.json(String(url).endsWith("/settings") ? { account: { id: 123 } } : tokens);
  };
  assert.equal((await status(second)).code, 410);
  assert.equal(repo.getTrackerConnection("simkl"), null);
});

test("connection replacement during identity lookup cannot overwrite the replacement", async () => {
  const { body: { flowId } } = await begin();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/settings")) { connect("replacement"); return Response.json({ account: { id: 123 } }); }
    return Response.json(tokens);
  };
  assert.equal((await status(flowId)).code, 409);
  assert.equal(repo.getTrackerConnection("simkl").remoteUserId, "replacement");
});

test("forced refresh is single-flight and persists rotated tokens without changing generation", async () => {
  const before = connect();
  let count = 0;
  globalThis.fetch = async () => { count++; return Response.json(tokens); };
  const [a, b] = await Promise.all([freshSimklConnection(true), freshSimklConnection(true)]);
  assert.equal(count, 1);
  assert.equal(a.id, before.id);
  assert.equal(b.accessToken, tokens.access_token);
  assert.equal(repo.getTrackerConnection("simkl", { includeCredentials: true }).refreshToken, tokens.refresh_token);
});

test("late refresh never saves or returns a replacement account's credentials", async () => {
  connect();
  globalThis.fetch = async () => { connect("replacement"); return Response.json(tokens); };
  await assert.rejects(freshSimklConnection(true), { code: "TRACKER_CONNECTION_STALE" });
  assert.equal(repo.getTrackerConnection("simkl", { includeCredentials: true }).accessToken, "old-access");
});

test("auth initiation captures the generation before contacting the provider", async () => {
  globalThis.fetch = async () => { connect("replacement"); return Response.json(device); };
  const { body: { flowId } } = await begin();
  assert.equal(repo.getTrackerAuthFlow(flowId).expectedConnectionId, "");
  globalThis.fetch = () => { throw new Error("stale flow must not poll"); };
  assert.equal((await status(flowId)).code, 409);
});

test("invalid refresh grant requests reauthentication without losing encrypted credentials", async () => {
  const before = connect();
  globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "private-refresh" }, { status: 400 });
  await assert.rejects(freshSimklConnection(true));
  const after = repo.getTrackerConnection("simkl", { includeCredentials: true });
  assert.equal(after.id, before.id);
  assert.equal(after.status, "reauth_required");
  assert.equal(after.refreshToken, "old-refresh");
  assert.equal(after.lastError.includes("private-refresh"), false);
});
