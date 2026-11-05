import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { SessionCache } from "../public/modules/state.js";

test("session caches bound retained entries and retain refreshed keys", () => {
  const cache = new SessionCache();
  for (let i = 0; i < 200; i++) cache.set(i, i);
  cache.set(0, "refreshed");
  cache.set(200, 200);
  assert.equal(cache.size, 200);
  assert.equal(cache.get(0), "refreshed");
  assert.equal(cache.has(1), false);
  assert.equal(cache.get(200), 200);
});
