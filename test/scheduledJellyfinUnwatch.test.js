import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-jellyfin-unwatch-guard-");

const {
  confirmJellyfinUnwatchedObservation,
  jellyfinMatchesContainWatched,
  jellyfinUnwatchedConfirmationKey,
} = await import("../server/src/utils/unwatchedStatusPoll.js");

function fakeLoopStore() {
  const values = new Map();
  return {
    values,
    get(key) { return values.get(key) || 0; },
    put(key, value) { values.set(key, value); },
  };
}

test("Jellyfin fallback requires the same false observation twice", async () => {
  const store = fakeLoopStore();
  const media = { type: "movie", title: "Bad Grandpa", ids: { tmdb: "98765" } };
  assert.equal(await confirmJellyfinUnwatchedObservation(media, store, { now: 1_000, windowMs: 1_200 }), false);
  assert.equal(await confirmJellyfinUnwatchedObservation(media, store, { now: 2_000, windowMs: 1_200 }), true);
  assert.equal(store.values.has(jellyfinUnwatchedConfirmationKey(media)), true);
  assert.equal(await confirmJellyfinUnwatchedObservation(media, store, { now: 4_000, windowMs: 1_200 }), false);
});

test("a watched duplicate Jellyfin match prevents an unwatch inference", () => {
  assert.equal(jellyfinMatchesContainWatched([
    { Id: "stale", UserData: { Played: false } },
    { Id: "real", UserData: { Played: true } },
  ]), true);
  assert.equal(jellyfinMatchesContainWatched([{ Id: "only", UserData: { Played: false } }]), false);
});
