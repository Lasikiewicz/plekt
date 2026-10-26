import test from "node:test";
import assert from "node:assert/strict";
import { createSimklTransport, nextSimklDailyReset, simklQuotaMetadata } from "../server/src/utils/trackers/simklTransport.js";

const account = { clientId: "client", remoteUserId: "account", accessToken: "secret" };
test('scoped verification budget caps real attempts and preserves its quota floor',async()=>{
  let calls=0;
  const request=createSimklTransport({sleep:async()=>{},fetcher:async()=>{calls++;return Response.json({}, {headers:{'x-ratelimit-remaining':String(60-calls)}});}});
  await request.withBudget({maxRequests:2,minimumRemaining:56,allowUnknownFirst:true},async()=>{
    await request(account,'https://api.simkl.com/sync/activities',{method:'GET'});
    await request(account,'https://api.simkl.com/sync/all-items',{method:'GET'});
    await assert.rejects(request(account,'https://api.simkl.com/sync/all-items',{method:'GET'}),{code:'SIMKL_REQUEST_BUDGET'});
  });
  assert.equal(calls,2);
  await request.withBudget({maxRequests:18,minimumRemaining:59,allowUnknownFirst:true},async()=>{
    await assert.rejects(request(account,'https://api.simkl.com/sync/activities',{method:'GET'}),{code:'SIMKL_QUOTA_RESERVE'});
  });
  assert.equal(calls,2);
});
test('preflight can learn unknown quota but cannot spend known reserve; reset permits a fresh check',async()=>{
  let time=Date.parse('2026-10-23T12:00:00Z'),calls=0;
  const request=createSimklTransport({now:()=>time,sleep:async()=>{},fetcher:async()=>{
    calls++;return Response.json({}, {headers:{'x-ratelimit-remaining':'55'}});
  }});
  const options={method:'GET',minimumRemaining:59,allowUnknownQuota:true};
  await request(account,'https://api.simkl.com/sync/activities',options);
  await assert.rejects(request(account,'https://api.simkl.com/sync/activities',options),{code:'SIMKL_QUOTA_RESERVE'});
  assert.equal(calls,1);
  time=nextSimklDailyReset(time);
  await request(account,'https://api.simkl.com/sync/activities',options);
  assert.equal(calls,2);
});
test('batch quota floors are checked against the latest account-wide response inside the transport queue', async () => {
  let calls=0;
  const request=createSimklTransport({sleep:async()=>{},fetcher:async()=>{
    calls++;return Response.json({}, {headers:{'x-ratelimit-remaining':String(59-calls)}});
  }});
  await request(account,'https://api.simkl.com/test',{method:'GET'}); // 58
  await request(account,'https://api.simkl.com/test',{method:'GET'}); // competing caller: 57
  await assert.rejects(request(account,'https://api.simkl.com/test',{method:'POST',minimumRemaining:58}),{code:'SIMKL_QUOTA_RESERVE'});
  assert.equal(calls,2);
});
function fixture(handler = () => Response.json({})) {
  let time = Date.parse("2026-10-21T12:00:00Z");
  const calls = [], sleeps = [];
  const request = createSimklTransport({ now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; }, fetcher: async (...args) => { calls.push(time); return handler(...args); } });
  return { calls, sleeps, advance: (ms) => { time += ms; }, request: (scope = account, method = "GET") => request(scope, "https://api.simkl.com/test", { method }) };
}

test("Simkl serializes account requests including body consumption and paces mixed methods", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0, maximum = 0;
  const f = fixture(async () => {
    active++; maximum = Math.max(maximum, active);
    await gate;
    return { ok: true, status: 200, headers: new Headers(), json: async () => { active--; return {}; } };
  });
  const jobs = [f.request(), f.request({ ...account, accessToken: "rotated" }, "POST"), f.request(), f.request(account, "POST")];
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  release(); await Promise.all(jobs);
  assert.equal(maximum, 1);
  assert.deepEqual(f.calls.map((t) => t - f.calls[0]), [0, 110, 1210, 1320]);
});

test("Simkl daily exhaustion rejects queued calls without sleeping and resumes at reset", async () => {
  let count = 0;
  const f = fixture(() => ++count === 1 ? Response.json({ error: "user_limit_exceeded", secret: "private" }, { status: 429 }) : Response.json({}));
  const first = await f.request();
  assert.equal(first.rateCode, "SIMKL_DAILY_LIMIT");
  await assert.rejects(f.request(), (e) => e.code === "SIMKL_DAILY_LIMIT" && e.resetAt === Date.parse("2026-10-22T04:00:00Z") && !JSON.stringify(e).includes("private"));
  assert.equal(f.calls.length, 1); assert.deepEqual(f.sleeps, []);
  f.advance(16 * 3600_000); await f.request(); assert.equal(f.calls.length, 2);
});

test("Simkl burst cooldown is shared across methods but isolated between accounts", async () => {
  const f = fixture(() => Response.json({ error: "rate_limit" }, { status: 429, headers: { "Retry-After": "5" } }));
  await f.request();
  await assert.rejects(f.request(account, "POST"), { code: "SIMKL_RATE_LIMIT", retryAfter: 1 });
  f.advance(1000);
  await f.request();
  await f.request({ ...account, remoteUserId: "other", accessToken: "other" });
  assert.equal(f.calls.length, 3); assert.deepEqual(f.sleeps, []);
});

test("Simkl absent/invalid quota metadata stays unknown; numeric and date values survive", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.deepEqual(simklQuotaMetadata(new Headers()), {});
  assert.deepEqual(simklQuotaMetadata(new Headers({ "x-ratelimit-limit": "secret", "x-ratelimit-remaining": "", "retry-after": "nonsense" })), {});
  assert.deepEqual(simklQuotaMetadata(new Headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "0", "retry-after": "Wed, 21 Oct 2026 12:00:20 GMT" }), now), { quotaLimit: 1000, quotaRemaining: 0, retryAfter: 20 });
});

test("Simkl reset uses New York midnight across both DST changes", () => {
  for (const [input, expected] of [["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"], ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"]]) {
    assert.equal(nextSimklDailyReset(Date.parse(input)), Date.parse(expected));
  }
});

test("Simkl never retries an uncertain POST and failures do not poison the queue", async () => {
  let count = 0;
  const f = fixture(() => { if (++count === 1) throw new Error("uncertain write"); return Response.json({}); });
  await assert.rejects(f.request(account, "POST"), /uncertain write/);
  assert.equal(count, 1);
  await f.request(account, "POST"); assert.equal(count, 2);
  assert.equal(f.calls[1] - f.calls[0], 1100);
});

test("Simkl stalled response bodies time out once and release the account queue", async () => {
  let count = 0, cancelled = false;
  const request = createSimklTransport({ fetcher: async () => ++count === 1
    ? { ok: true, status: 200, headers: new Headers(), body: { cancel: async () => { cancelled = true; } }, json: () => new Promise(() => {}) }
    : Response.json({ ok: true }) });
  const stalled = request(account, "https://api.simkl.com/test", { method: "POST" }, 20);
  const next = request(account, "https://api.simkl.com/test", { method: "GET" }, 20);
  await assert.rejects(stalled, { code: "UPSTREAM_TIMEOUT" });
  assert.equal(cancelled, true);
  assert.deepEqual((await next).data, { ok: true });
  assert.equal(count, 2);
});

test("Simkl last successful quota slot is delivered then blocks rotated credentials and auth", async () => {
  const f = fixture(() => Response.json({ ok: true }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "500" } }));
  assert.deepEqual((await f.request()).data, { ok: true });
  await assert.rejects(f.request({ ...account, accessToken: "new-token" }, "POST"), { code: "SIMKL_DAILY_LIMIT", quotaLimit: 500, quotaRemaining: 0 });
  assert.equal(f.calls.length, 1);
});

test("Simkl V1 app exhaustion retains a separate code and a daily reset", async () => {
  const f = fixture(() => Response.json({ error: "app_limit_exceeded" }, { status: 429 }));
  assert.equal((await f.request()).rateCode, "SIMKL_APP_LIMIT");
  await assert.rejects(f.request(), { code: "SIMKL_APP_LIMIT", resetAt: Date.parse("2026-10-22T04:00:00Z") });
});
