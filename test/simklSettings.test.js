import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { initTrackerSettings, refreshTrackerSettings } from "../public/modules/tracker-settings.js";

test("Simkl Settings keeps authentication separate from sync and handles polling outcomes", async (t) => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === "simklInitialSyncMode" ? "baseline" : "public-client-id", textContent: "", innerHTML: "", disabled: false,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(event, handler) { this[event] = handler; },
      setAttribute() {}, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => [],
    });
    return nodes.get(id);
  };
  const originalDocument = globalThis.document;
  globalThis.document = { ...originalDocument, getElementById: node,
    createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } }),
  };
  t.after(() => { globalThis.document = originalDocument; });
  // Let the browser polling loop advance without waiting real provider intervals.
  let now = Date.now();
  const delays = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    delays.push(delay);
    now += delay;
    callback();
    return 1;
  });
  let requests = [];
  let queue = [];
  t.mock.method(globalThis, "fetch", async (path, options = {}) => {
    requests.push({ path, ...options });
    const next = queue.shift();
    assert.ok(next, `Unexpected request: ${path}`);
    if (typeof next === "function") return next();
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  });
  initTrackerSettings();
  const submit = () => node("simklConnectForm").submit({ preventDefault() {} });
  const start = (extra = {}) => ({ status: 200, body: {
    flowId: "flow-id", userCode: "CODE", verificationUrl: "https://simkl.com/pin",
    expiresAt: Date.now() + 60000, intervalSeconds: 5, ...extra,
  } });

  queue = [start(), { status: 202, body: { status: "pending", retryAfter: 10 } }, {
    status: 200, body: { status: "completed", connection: { status: "connected", remoteUsername: "Tester" }, syncEnabled: false },
  }];
  await submit();
  assert.equal(node("simklConnectionStatus").textContent, "Connected");
  assert.match(node("simklConnectMessage").textContent, /Check now/);
  assert.deepEqual(JSON.parse(requests[0].body), { initialSyncMode: "baseline" });
  assert.equal(requests.length, 3);
  assert.ok(requests.slice(1).every((request) => request.path.endsWith("/status")));
  assert.equal(node("simklConnectButton").disabled, false);

  queue = [start(), { status: 202, body: { status: "pending", retryAfter: 999999999 } }];
  await submit();
  assert.match(node("simklConnectMessage").textContent, /expired.*Start again/);
  assert.equal(delays.at(-1), 55000, "backoff waits only until device expiry");

  requests = [];
  queue = [start(), { status: 410, body: { status: "expired" } }];
  await submit();
  assert.match(node("simklConnectMessage").textContent, /expired.*Start again/);
  assert.equal(node("simklConnectButton").disabled, false);

  queue = [start({ verificationUrl: "https://attacker.example/pin" })];
  await submit();
  assert.match(node("simklConnectMessage").textContent, /unsafe sign-in link/);
  assert.equal(queue.length, 0);

  queue = [start(), { status: 502, body: { status: "failed", error: "Simkl sign-in failed. Start the sign-in again." } }];
  await submit();
  assert.match(node("simklConnectMessage").textContent, /failed/);

  queue = [
    { status: 200, body: { connections: [], providers: {} } },
    { status: 200, body: { connection: { status: "reauth_required", remoteUsername: "Tester" }, syncEnabled: false } },
  ];
  await refreshTrackerSettings();
  assert.equal(node("simklConnectionStatus").textContent, "Reconnect required");
  assert.equal(node("simklConnectButton").textContent, "Reconnect Simkl");
  assert.ok(requests.every((request) => request.method !== "POST" || request.path === "/api/tracker-auth/simkl/start"));

  window.confirm = () => true;
  t.after(() => { delete window.confirm; });
  queue = [{ status: 200, body: { ok: true } }];
  await node("simklDisconnectButton").click();
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(requests.at(-1).path, "/api/tracker-connections/simkl");
  assert.equal(node("simklConnectionStatus").textContent, "Not connected");
  assert.match(node("simklConnectMessage").textContent, /Local history was kept/);

  // An older Settings refresh must not repaint an account after disconnect.
  let resolveOldRefresh;
  queue = [
    { status: 200, body: { connections: [], providers: {} } },
    () => new Promise((resolve) => { resolveOldRefresh = resolve; }),
  ];
  const oldRefresh = refreshTrackerSettings();
  queue.push({ status: 200, body: { ok: true } });
  await node("simklDisconnectButton").click();
  resolveOldRefresh({ ok: true, status: 200, json: async () => ({ connection: { status: "connected", remoteUsername: "Old account" } }) });
  await oldRefresh;
  assert.equal(node("simklConnectionStatus").textContent, "Not connected");
});
