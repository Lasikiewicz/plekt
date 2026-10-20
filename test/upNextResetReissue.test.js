import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const { state } = await import("../public/modules/state.js");
const { loadUpNext, resetUpNext } = await import("../public/modules/up-next.js");

// The first /api/up-next request hangs until it is aborted; every later one
// answers at once, so the test can see whether a replacement was issued.
function installFetch() {
  const calls = [];
  globalThis.fetch = (url, options = {}) => {
    const path = String(url);
    calls.push({ path, signal: options.signal });
    const railCalls = calls.filter((call) => call.path.startsWith("/api/up-next?"));
    if (path.startsWith("/api/up-next?") && railCalls.length === 1) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [], upNextVersion: 2 }) });
  };
  return calls;
}

function railRequests(calls) {
  return calls.filter((call) => call.path.startsWith("/api/up-next?"));
}

test("a live dashboard reset reissues the Up Next load it aborts", async () => {
  const calls = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  loadUpNext({ fromSse: true });
  assert.equal(railRequests(calls).length, 1);

  // A manual watch clears derived caches while the SSE-triggered load runs.
  resetUpNext({ preserveItems: true });
  assert.equal(railRequests(calls)[0].signal.aborted, true);
  assert.equal(railRequests(calls).length, 2, "the aborted load is replaced, not dropped");
  assert.match(railRequests(calls)[1].path, /revalidate=1/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.upNextLoading, false);
});

test("a reissued load keeps a queued forced refresh forced", async () => {
  const calls = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  loadUpNext({ fromSse: true });
  loadUpNext({ force: true });
  assert.equal(state.upNextForceRefreshQueued, true);

  resetUpNext({ preserveItems: true });
  assert.equal(railRequests(calls).length, 2);
  assert.match(railRequests(calls)[1].path, /refresh=1/);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a full reset (sign-out, view change) does not reissue", async () => {
  const calls = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  loadUpNext({ fromSse: true });

  resetUpNext();
  assert.equal(railRequests(calls)[0].signal.aborted, true);
  assert.equal(railRequests(calls).length, 1);
  assert.equal(state.upNextLoading, false);
});

test("dashboard entry ignores another device's old browser snapshot and always reads the server", async () => {
  resetUpNext();
  state.token = "token";
  state.activeView = "dashboard";
  localStorage.setItem("plembfin:upNextCache:v6", JSON.stringify({
    savedAt: Date.now(), version: 1, items: [{ id: "cleared-on-phone" }],
  }));
  let finish;
  let requests = 0;
  globalThis.fetch = (url) => {
    if (String(url).startsWith("/api/up-next?")) {
      requests += 1;
      if (requests === 1) return new Promise((resolve) => { finish = resolve; });
    }
    return Promise.resolve({ ok: true, json: async () => ({ items: [], upNextVersion: 2 }) });
  };
  const loading = loadUpNext();
  assert.deepEqual(state.upNextItems, [], "old local cards must never paint");
  finish({ ok: true, json: async () => ({ items: [], upNextVersion: 2 }) });
  await loading;
  await loadUpNext();
  assert.equal(requests, 2, "a recent load must not suppress the next server read");
});
