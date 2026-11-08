import test from "node:test";
import assert from "node:assert/strict";
import { embyLikeUnplayedIsPartWatchedClear, plexUnplayedHasWatchEvidence, plexUnplayedIsPartWatchedClear, shouldRepairRecentPlexUnwatch } from "../server/src/utils/plexWatchstate.js";

test("a positive-offset Plex rollback is repaired after recent threshold playback", () => {
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched" },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: true,
  }), true);
});

test("a rapid positive-offset rollback is repaired across threshold rounding", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: now - 3 * 60_000 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now,
  }), true);
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: now - 6 * 60_000 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now,
  }), false, "the grace expires so a later deliberate unwatch can propagate");
});

test("ordinary Plex unwatches are not hidden by the rollback guard", () => {
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched", updated_at: 1 },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: false,
    now: 1_800_000_000_000,
  }), false, "stale resume position alone is not enough");
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "watched" },
    viewOffset: 0,
    hasPlaybackEvidence: true,
  }), false, "a zero-position manual unwatch remains authoritative");
  assert.equal(shouldRepairRecentPlexUnwatch({
    playstate: { state: "unwatched" },
    viewOffset: 3_064_000,
    hasPlaybackEvidence: true,
  }), false, "the guard cannot revive an already-unwatched canonical state");
});

test("an unplayed Plex notification for a never-watched item is not an unwatch", () => {
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: null, watchedRecord: null }), false,
    "a newly added library item has nothing to unwatch");
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: { state: "unwatched" }, watchedRecord: null }), false,
    "an already-unwatched item has nothing to unwatch");
});

test("an unplayed Plex notification is an unwatch when Plembfin holds a watch", () => {
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: { state: "watched" } }), true);
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: null, watchedRecord: { id: "w1" } }), true,
    "a watched history row under a sibling key still counts");
});

test("clearing a part watched item in Plex is an unwatch when Plex held the resume position", () => {
  // The All Quiet on the Western Front case: no watch was ever recorded, only a
  // resume position. Ignoring the clear left the other servers pushing it back.
  const unwatched = { state: "unwatched" };
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: unwatched, progress: { source: "plex" } }), true,
    "a position Plex reported is cleared when Plex stops reporting it");
  assert.equal(plexUnplayedHasWatchEvidence({
    playstate: unwatched,
    progress: { source: "emby", sync_dispatch_telemetry: "Target plex progress status: success - Resume set to 600s" },
  }), true, "a position pushed to Plex counts once Plex reports it cleared");
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: unwatched, pendingReview: true }), true,
    "a held Mark as Watched flag followed by Mark as Unwatched is a clear");
  assert.equal(plexUnplayedHasWatchEvidence({
    playstate: unwatched,
    progress: { source: "emby", sync_dispatch_telemetry: "Target plex progress status: error - 404" },
  }), false, "a position Plex never received says nothing about Plex");
  assert.equal(plexUnplayedHasWatchEvidence({ playstate: unwatched, progress: { source: "emby" } }), false,
    "a position only another server holds is not cleared by Plex's empty state");
});

test("clearing a part watched item on Emby or Jellyfin is an unwatch only when that server held it", () => {
  const unwatched = { state: "unwatched" };
  for (const provider of ["emby", "jellyfin"]) {
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, { playstate: unwatched, progress: { source: provider } }), true,
      `a position ${provider} reported is cleared when ${provider} unplays the item`);
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, {
      playstate: unwatched,
      progress: { source: "plex", sync_dispatch_telemetry: `Target ${provider} progress status: success - Resume set to 600s` },
    }), true, `a position pushed to ${provider} counts once ${provider} clears it`);
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, { playstate: unwatched, pendingReview: true }), true);
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, { playstate: unwatched, progress: { source: "plex" } }), false,
      `a position ${provider} never held is not cleared by ${provider}`);
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, { playstate: { state: "watched" }, progress: { source: provider } }), false,
      "a recorded watch takes the normal unwatch path");
    assert.equal(embyLikeUnplayedIsPartWatchedClear(provider, { playstate: null }), false);
  }
  assert.equal(embyLikeUnplayedIsPartWatchedClear("emby", {
    playstate: unwatched,
    progress: { source: "jellyfin", sync_dispatch_telemetry: "Target jellyfin progress status: success" },
  }), false, "one server's push receipt is not another server's");
});

test("an old imported watch row does not stop a canonically unwatched item's clear from being forced", () => {
  // Georgie & Mandy S01E20: Trakt and Simkl history imports left watched rows
  // under an item whose playstate was already unwatched.
  const imported = { id: "trakt-import-row" };
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: { state: "unwatched" }, watchedRecord: imported, progress: { source: "plex" } }), true);
  assert.equal(embyLikeUnplayedIsPartWatchedClear("emby", { playstate: { state: "unwatched" }, watchedRecord: imported, pendingReview: true }), true);
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: null, watchedRecord: imported, progress: { source: "plex" } }), false,
    "with no playstate, a watched row is still a real watch");
});

test("only a part watched clear needs a forced unwatch", () => {
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: { state: "unwatched" }, progress: { source: "plex" } }), true);
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: { state: "unwatched" }, pendingReview: true }), true);
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: { state: "watched" }, progress: { source: "plex" } }), false,
    "a recorded watch takes the normal unwatch path");
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: null, watchedRecord: { id: "w1" } }), false);
  assert.equal(plexUnplayedIsPartWatchedClear({ playstate: null }), false, "a newly added item is still not an unwatch");
});
