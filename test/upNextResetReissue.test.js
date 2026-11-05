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

// Decision 20 October 2026 reversed 5 November 2026 (docs/decisions.md): a
// reload paints the last confirmed cards as checking, but the server is always
// read and its reply replaces them, so a card cleared on another device leaves.
function deferredRail() {
  let finish;
  let requests = 0;
  globalThis.fetch = (url) => {
    if (String(url).startsWith("/api/up-next?")) {
      requests += 1;
      if (requests === 1) return new Promise((resolve) => { finish = resolve; });
    }
    return Promise.resolve({ ok: true, json: async () => ({ items: [], upNextVersion: 2 }) });
  };
  return { finish: (body) => finish({ ok: true, json: async () => body }), requests: () => requests };
}

test("a reload paints the saved cards as checking, then the server reply replaces them", async () => {
  resetUpNext();
  localStorage.clear();
  state.token = "token";
  state.activeView = "dashboard";
  state.currentUser = { uid: "owner", activeUser: "admin" };
  localStorage.setItem("plekt:upNextSnapshot:v1:owner:admin", JSON.stringify({
    savedAt: Date.now(), items: [{ id: "kept" }, { id: "cleared-on-phone" }],
  }));
  const rail = deferredRail();
  const loading = loadUpNext();
  assert.deepEqual(state.upNextItems.map((item) => item.id), ["kept", "cleared-on-phone"], "saved cards paint at once");
  assert.equal(state.upNextFromCache, true, "saved cards show as checking");
  assert.equal(rail.requests(), 1, "the server is still read");
  rail.finish({ items: [{ id: "kept" }], upNextVersion: 3 });
  await loading;
  assert.deepEqual(state.upNextItems.map((item) => item.id), ["kept"], "the server reply wins");
  assert.equal(state.upNextFromCache, false);
  const saved = JSON.parse(localStorage.getItem("plekt:upNextSnapshot:v1:owner:admin"));
  assert.deepEqual(saved.items.map((item) => item.id), ["kept"], "the confirmed list is saved for the next reload");
});

test("saved cards never paint for another dashboard, an expired save, or once the rail has loaded", async () => {
  resetUpNext();
  localStorage.clear();
  state.token = "token";
  state.activeView = "dashboard";
  localStorage.setItem("plekt:upNextSnapshot:v1:owner:admin", JSON.stringify({ savedAt: Date.now(), items: [{ id: "admins" }] }));
  // The admin viewing an added user's dashboard.
  state.currentUser = { uid: "owner", activeUser: "friend" };
  let rail = deferredRail();
  let loading = loadUpNext();
  assert.deepEqual(state.upNextItems, [], "another dashboard's cards must never paint");
  rail.finish({ items: [], upNextVersion: 2 });
  await loading;

  resetUpNext();
  state.currentUser = { uid: "owner", activeUser: "admin" };
  localStorage.setItem("plekt:upNextSnapshot:v1:owner:admin", JSON.stringify({ savedAt: Date.now() - 15 * 24 * 60 * 60 * 1000, items: [{ id: "old" }] }));
  rail = deferredRail();
  loading = loadUpNext();
  assert.deepEqual(state.upNextItems, [], "an expired save must not paint");
  rail.finish({ items: [{ id: "fresh" }], upNextVersion: 2 });
  await loading;
  await loadUpNext();
  assert.deepEqual(state.upNextItems.map((item) => item.id), [], "a later load reads the server again");
});
