import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const { state } = await import("../public/modules/state.js");
const { loadUpNext, resetUpNext } = await import("../public/modules/up-next.js");

// Remove from Up Next rebuilds the server cache before it answers. The rail
// reload that follows must read that snapshot (revalidate=1), not force a
// second full rebuild (refresh=1), which doubled the wait on the local server.

// The first /api/up-next request waits until released (or aborted); later
// ones answer at once.
function installFetch() {
  const calls = [];
  let release = null;
  globalThis.fetch = (url, options = {}) => {
    const path = String(url);
    calls.push({ path, signal: options.signal });
    const railCalls = calls.filter((call) => call.path.startsWith("/api/up-next?"));
    if (path.startsWith("/api/up-next?") && railCalls.length === 1) {
      return new Promise((resolve, reject) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ items: [], upNextVersion: 2 }) });
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [], upNextVersion: 2 }) });
  };
  return { calls, release: () => release?.() };
}

const railRequests = (calls) => calls.filter((call) => call.path.startsWith("/api/up-next?"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a reload after a removal reads the rebuilt cache instead of forcing a rebuild", async () => {
  const { calls, release } = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  const loading = loadUpNext({ afterMutation: true });
  assert.equal(railRequests(calls).length, 1);
  assert.match(railRequests(calls)[0].path, /revalidate=1/);
  assert.doesNotMatch(railRequests(calls)[0].path, /refresh=1/);
  release();
  await loading;
});

test("a removal reload is queued, not dropped, while another load runs, even off the dashboard", async () => {
  const { calls, release } = installFetch();
  state.token = "token";
  state.activeView = "show";
  resetUpNext();
  const first = loadUpNext({ fromSse: true });
  loadUpNext({ afterMutation: true });
  assert.equal(state.upNextMutationRefreshQueued, true);
  release();
  await first;
  await settle();
  await settle();
  assert.equal(railRequests(calls).length, 2, "the removal reload runs after the in-flight load");
  assert.match(railRequests(calls)[1].path, /revalidate=1/);
  assert.equal(state.upNextMutationRefreshQueued, false);
});

test("a queued forced refresh still wins over a queued removal reload", async () => {
  const { calls, release } = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  const first = loadUpNext({ fromSse: true });
  loadUpNext({ afterMutation: true });
  loadUpNext({ force: true });
  release();
  await first;
  await settle();
  await settle();
  assert.equal(railRequests(calls).length, 2);
  assert.match(railRequests(calls)[1].path, /refresh=1/);
});

test("a live reset reissues a queued removal reload as a cache read", async () => {
  const { calls } = installFetch();
  state.token = "token";
  state.activeView = "dashboard";
  resetUpNext();
  loadUpNext({ fromSse: true });
  loadUpNext({ afterMutation: true });
  resetUpNext({ preserveItems: true });
  assert.equal(railRequests(calls)[0].signal.aborted, true);
  assert.equal(railRequests(calls).length, 2);
  assert.match(railRequests(calls)[1].path, /revalidate=1/);
  assert.equal(state.upNextMutationRefreshQueued, false);
  await settle();
});
