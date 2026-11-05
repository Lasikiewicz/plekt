import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-audit-hardening-");
const { AUTH, updateAdminCredentials } = await import("../server/src/appConfig.js");
const { handleLogin, handleLogout, signSession, verifySession, isSameOrigin, setSessionCookie } = await import("../server/src/utils/auth.js");
const { dispatch } = await import("../server/src/index.js");
const { parsePlexGuids } = await import("../server/src/utils/parsers.js");
const { localCalendarDay } = await import("../server/src/utils/watchDates.js");
const repo = await import("../server/src/utils/dataRepo.js");
let cookieName;
setSessionCookie({ cookie(name) { cookieName = name; } }, AUTH.username);

function request({ method = "POST", headers = {}, body, token, path = "/api/login" } = {}) {
  return { method, path, url: path, headers, body, cookies: token ? { [cookieName]: token } : {}, ip: "audit-test", get: key => headers[key.toLowerCase()] };
}
function response() {
  return { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, set() { return this; },
    send(value) { this.payload = JSON.parse(value); return this; }, cookie() {}, clearCookie() {}, setHeader() {} };
}

test("logout revokes only that cookie", async () => {
  const first = signSession(AUTH.username);
  const second = signSession(AUTH.username);
  assert.notEqual(first, second);
  assert.ok(verifySession(first));
  await handleLogout(request({ token: first }), response());
  assert.equal(verifySession(first), null);
  assert.ok(verifySession(second));
});

test("successful logins do not exhaust the failed-login allowance", async () => {
  updateAdminCredentials({ username: AUTH.username, password: "audit-test-password" });
  for (let i = 0; i < 12; i++) {
    const res = response();
    await handleLogin(request({ body: { username: AUTH.username, password: "audit-test-password" } }), res);
    assert.equal(res.statusCode, 200);
  }
  for (let i = 0; i < 10; i++) await handleLogin(request({ body: { username: AUTH.username, password: "wrong" } }), response());
  const blocked = response();
  await handleLogin(request({ body: { username: AUTH.username, password: "wrong" } }), blocked);
  assert.equal(blocked.statusCode, 429);
});

test("dispatch rejects cross-site mutations while headerless API clients remain allowed", async () => {
  assert.equal(isSameOrigin(request()), true);
  assert.equal(isSameOrigin(request({ headers: { host: "localhost", origin: "http://localhost" } })), true);
  for (const headers of [{ host: "localhost", origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
    const res = response();
    await dispatch(request({ headers, path: "/api/cron-sync" }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, "ORIGIN_REJECTED");
  }
});

test("state-changing cron and stop endpoints reject GET", async () => {
  for (const path of ["/api/cron-sync", "/api/stop-force-sync"]) {
    const res = response();
    await dispatch(request({ method: "GET", path }), res);
    assert.equal(res.statusCode, 405);
  }
});

test("legacy Plex GUID query parameters do not become provider ids", () => {
  assert.deepEqual(parsePlexGuids({ guid: "com.plexapp.agents.themoviedb://123?lang=en", Guid: [{ id: "tvdb://456?lang=en" }, { id: "imdb://tt123?lang=en" }] }), { imdb: "tt123", tmdb: "123", tvdb: "456" });
});

test("watched-day comparison follows the server local calendar across UTC midnight", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    assert.equal(localCalendarDay("2026-11-05T01:00:00Z"), "2026-11-04");
    assert.equal(localCalendarDay("2026-11-04T23:00:00Z"), "2026-11-04");
    assert.equal(localCalendarDay("invalid"), "");
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("sync jobs filter before offset and limit even after many successful rows", async () => {
  for (let i = 0; i < 20; i++) repo.insertWatchRecordSync({ title: `Job ${i}`, media_type: "movie", tmdb_id: `audit-job-${i}`, source: "plex", watched_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), sync_dispatch_telemetry: i < 3 ? "Dispatch status: error\nEmby status: error" : "Dispatch status: success\nEmby status: success" });
  const first = await repo.querySyncJobs({ limit: 2, offset: 0, fresh: true });
  const second = await repo.querySyncJobs({ limit: 2, offset: 2, fresh: true });
  assert.deepEqual(first.map(row => row.title), ["Job 2", "Job 1"]);
  assert.deepEqual(second.map(row => row.title), ["Job 0"]);
});
