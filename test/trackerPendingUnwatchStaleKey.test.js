import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-tracker-pending-unwatch-stale-");

const { partitionPendingTrackerUnwatches, TRAKT_UNWATCH_CONFIRMATION_MS } = await import("../server/src/utils/trackerSync.js");

// A key that stopped being an unwatch candidate must not keep its old
// first-detected timestamp. Otherwise a much later fresh miss would skip the
// confirmation grace and unwatch on its first poll.
test("a pending unwatch that stops being a candidate restarts its grace period", () => {
  const provider = "stale-key-test";
  const item = { mediaKey: "movie:tmdb:stale-key-movie" };

  const first = partitionPendingTrackerUnwatches(provider, [item], new Map(), 0);
  assert.equal(first.heldBack.length, 1);

  // The key is no longer a candidate on this poll (for example protected by a newer outbound watch).
  partitionPendingTrackerUnwatches(provider, [], new Map(), TRAKT_UNWATCH_CONFIRMATION_MS + 1000);

  // It is a candidate again, but this is a fresh first miss and must be held back.
  const later = partitionPendingTrackerUnwatches(provider, [item], new Map(), TRAKT_UNWATCH_CONFIRMATION_MS + 2000);
  assert.equal(later.unwatched.length, 0, "a stale timestamp must not skip the grace period");
  assert.equal(later.heldBack.length, 1);
});
