import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-order-skip-test-");

const { db } = await import("../server/src/db.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");

test.after(() => db.close());

test("a watch resolved from a non-Aired order is skipped for Simkl with a clear reason", async () => {
  saveTrackerConnection({ provider: "simkl", accessToken: "test-access", refreshToken: "test-refresh", remoteUserId: "1", clientId: "test-client" });
  // A non-episode record passes order resolution untouched, so this exercises
  // only the dispatcher's Simkl skip for records carrying order provenance.
  const media = {
    type: "movie", media_type: "movie", source: "plex", syncTargets: ["simkl"], title: "Order skip fixture",
    watch_provenance: { episode_order: { tvdbId: "1", dvdId: 2, airedId: 3, order: "alternate" } },
  };
  const results = await dispatchTrackerWatchState(media, "watched", { lane: "sync" });
  assert.equal(results.length, 1);
  assert.equal(results[0].target, "simkl");
  assert.equal(results[0].status, "skipped");
  assert.equal(results[0].dismissed, true);
  assert.match(results[0].detail, /Simkl does not support alternate episode orders/);
});
