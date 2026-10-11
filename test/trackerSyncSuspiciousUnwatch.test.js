import test from "node:test";
import assert from "node:assert/strict";

// Exercises the pure Trakt missing-item confirmation logic (no DB/network).
// A transient, well-formed but incomplete snapshot must not delete local
// history or dispatch unwatches to connected providers.

const { partitionPendingTraktUnwatches, showIdentityFromMediaKey, TRAKT_UNWATCH_CONFIRMATION_MS } = await import("../server/src/utils/trackerSync.js");

function episodeItem(showId, season, episode) {
  const mediaKey = `episode:${showId}:s${season}e${episode}`;
  return { mediaKey, media: { type: "episode", season, episode, ids: {} }, remoteWatchedAt: Date.now() };
}

test("showIdentityFromMediaKey extracts the show id ignoring season/episode", () => {
  assert.equal(showIdentityFromMediaKey("episode:imdb:tt1266020:s7e2"), "imdb:tt1266020");
  assert.equal(showIdentityFromMediaKey("movie:imdb:tt1234567"), null);
});

test("a large simultaneous drop from one show is held throughout the confirmation window", () => {
  const showId = `imdb:tt${Date.now()}b`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  // 20 of 22 episodes vanish at once, matching the real incident's shape.
  const unwatchedCandidates = Array.from({ length: 20 }, (_, i) => episodeItem(showId, 6, i + 1));
  const now = Date.now();

  const firstPoll = partitionPendingTraktUnwatches(unwatchedCandidates, new Map(), now);
  assert.equal(firstPoll.unwatched.length, 0);
  assert.equal(firstPoll.heldBack.length, 20);

  const secondPoll = partitionPendingTraktUnwatches(unwatchedCandidates, new Map(), now + 2 * 60_000);
  assert.equal(secondPoll.unwatched.length, 0);
  assert.equal(secondPoll.heldBack.length, 20);

  const confirmed = partitionPendingTraktUnwatches(unwatchedCandidates, new Map(), now + TRAKT_UNWATCH_CONFIRMATION_MS);
  assert.equal(confirmed.unwatched.length, 20);
  assert.equal(confirmed.heldBack.length, 0);
});

test("a single omitted movie or episode that reappears never propagates an unwatch", () => {
  const showId = `imdb:tt${Date.now()}c`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  const missing = [episodeItem(showId, 6, 1)];
  const now = Date.now();

  const firstPoll = partitionPendingTraktUnwatches(missing, new Map(), now);
  assert.equal(firstPoll.heldBack.length, 1);

  // Next poll: Trakt's response recovered and includes the item again.
  const recoveredByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  const secondPoll = partitionPendingTraktUnwatches([], recoveredByKey, now + 2 * 60_000);
  assert.equal(secondPoll.unwatched.length, 0);
  assert.equal(secondPoll.heldBack.length, 0);
});

test("a single omitted movie remains pending until the grace period ends", () => {
  const showId = `imdb:tt${Date.now()}d`;
  const previous = Array.from({ length: 22 }, (_, i) => episodeItem(showId, 6, i + 1));
  const movie = { mediaKey: "movie:tmdb:12345", media: { type: "movie", ids: { tmdb: "12345" } }, remoteWatchedAt: Date.now() };
  const now = Date.now();

  const firstPoll = partitionPendingTraktUnwatches([movie], new Map(), now);
  assert.equal(firstPoll.heldBack.length, 1);
  assert.equal(firstPoll.unwatched.length, 0);

  const beforeGrace = partitionPendingTraktUnwatches([movie], new Map(), now + TRAKT_UNWATCH_CONFIRMATION_MS - 1);
  assert.equal(beforeGrace.unwatched.length, 0);
  assert.equal(beforeGrace.heldBack.length, 1);

  const afterGrace = partitionPendingTraktUnwatches([movie], new Map(), now + TRAKT_UNWATCH_CONFIRMATION_MS);
  assert.equal(afterGrace.unwatched.length, 1);
  assert.equal(afterGrace.heldBack.length, 0);
});
