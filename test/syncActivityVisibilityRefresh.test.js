import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { state } from "../public/modules/state.js";
import { startSyncActivityRefresh, stopSyncActivityRefresh } from "../public/modules/sync-activity.js";

test("sync activity skips hidden refresh ticks and refreshes once when visible again", async () => {
  const prior = { token: state.token, activeView: state.activeView, paused: state.syncActivityPaused, fetch: globalThis.fetch, visibilityState: document.visibilityState, setInterval: window.setInterval, clearInterval: window.clearInterval, add: document.addEventListener, remove: document.removeEventListener };
  let intervalCallback;
  let visibilityHandler;
  let requests = 0;
  window.setInterval = (callback) => { intervalCallback = callback; return 1; };
  window.clearInterval = () => {};
  document.addEventListener = (type, callback) => { if (type === "visibilitychange") visibilityHandler = callback; };
  document.removeEventListener = (type, callback) => { if (type === "visibilitychange" && visibilityHandler === callback) visibilityHandler = null; };
  globalThis.fetch = async () => { requests += 1; return { ok: true, json: async () => ({}) }; };
  state.token = "test-token";
  state.activeView = "syncActivity";
  state.syncActivityPaused = false;
  document.visibilityState = "hidden";
  try {
    startSyncActivityRefresh();
    intervalCallback();
    visibilityHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    document.visibilityState = "visible";
    visibilityHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    state.syncActivityPaused = true;
    visibilityHandler(); intervalCallback();
    state.syncActivityPaused = false;
    state.activeView = "dashboard";
    visibilityHandler(); intervalCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    stopSyncActivityRefresh();
    assert.equal(visibilityHandler, null);
  } finally {
    stopSyncActivityRefresh();
    state.token = prior.token;
    state.activeView = prior.activeView;
    state.syncActivityPaused = prior.paused;
    document.visibilityState = prior.visibilityState;
    globalThis.fetch = prior.fetch;
    window.setInterval = prior.setInterval;
    window.clearInterval = prior.clearInterval;
    document.addEventListener = prior.add;
    document.removeEventListener = prior.remove;
  }
});
