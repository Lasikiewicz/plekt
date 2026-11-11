import test from "node:test";
import assert from "node:assert/strict";
import { storageGet, storageSet, storageRemove } from "../public/modules/utils.js";
import { appendDebugLog, clearDebugLogs, readStoredDebugLogs } from "../public/modules/logs.js";

test("optional storage tolerates blocked access and quota failures", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    assert.equal(storageGet("view"), null);
    assert.doesNotThrow(() => storageSet("view", "history"));
    assert.doesNotThrow(() => storageRemove("view"));
    assert.deepEqual(readStoredDebugLogs(), []);
    assert.match(appendDebugLog([], "still works")[0], /still works/);
    assert.deepEqual(clearDebugLogs(), []);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "saved", setItem() { throw new Error("quota"); }, removeItem() {} } });
    assert.equal(storageGet("view"), "saved");
    assert.doesNotThrow(() => storageSet("view", "history"));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("frontend state initializes with defaults when storage access is blocked", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    Object.defineProperty(globalThis, "history", { configurable: true, value: { state: null } });
    const { state } = await import("../public/modules/state.js?storage-guard-test");
    assert.equal(state.activeView, "dashboard");
    assert.equal(state.explorerViewMovies, "posters");
    assert.deepEqual(state.debugLogs, []);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
    if (originalHistory) Object.defineProperty(globalThis, "history", originalHistory);
    else delete globalThis.history;
  }
});
