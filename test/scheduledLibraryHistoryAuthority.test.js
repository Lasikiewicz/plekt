import test from "node:test";
import assert from "node:assert/strict";

import { libraryHistoryDecision, shouldSkipLibraryHistoryImport } from "../server/src/utils/recentWatchImport.js";

test("a provider library snapshot cannot recreate a date removed from an already-watched item", () => {
  assert.equal(shouldSkipLibraryHistoryImport(null, { state: "watched" }), true);
});

test("library history can still add genuinely unknown watched items", () => {
  assert.equal(shouldSkipLibraryHistoryImport(null, null), false);
  assert.equal(shouldSkipLibraryHistoryImport(null, { state: "unwatched" }), true);
});

test("an existing matching watch remains an ordinary no-op", () => {
  assert.equal(shouldSkipLibraryHistoryImport({ id: "existing-watch" }, { state: "watched" }), false);
});

// Marshals S01E02, review 499b5d89: an Emby library import queued a review
// seven minutes after the user's manual watch of the same episode.
test("a library import never queues a review for an episode already watched in Plembfin", () => {
  const now = Date.now();
  assert.equal(libraryHistoryDecision({
    requiresReview: true,
    existing: { id: "manual-watch" },
    playstate: { state: "watched", updated_at: now - 7 * 60_000 },
    now,
  }), "skip_already_watched");
  assert.equal(libraryHistoryDecision({ requiresReview: true, existing: null, playstate: { state: "watched" }, now }), "skip_already_watched");
  assert.equal(libraryHistoryDecision({ requiresReview: true, existing: { id: "w" }, playstate: null, now }), "skip_already_watched");
});

test("a library review is still queued when Plembfin has no watch or is unwatched (decision 32)", () => {
  const now = Date.now();
  assert.equal(libraryHistoryDecision({ requiresReview: true, existing: null, playstate: null, now }), "review");
  assert.equal(libraryHistoryDecision({
    requiresReview: true,
    existing: { id: "older-watch" },
    playstate: { state: "unwatched", updated_at: now - 60_000 },
    now,
  }), "review");
});

test("the non-review library paths are unchanged", () => {
  const now = Date.now();
  assert.equal(libraryHistoryDecision({ existing: null, playstate: { state: "unwatched", updated_at: now - 1000 }, now }), "skip_recent_unwatch");
  assert.equal(libraryHistoryDecision({ existing: null, playstate: { state: "watched" }, now }), "skip_already_watched");
  assert.equal(libraryHistoryDecision({ existing: { id: "w" }, playstate: { state: "watched" }, now }), "import");
  assert.equal(libraryHistoryDecision({ existing: null, playstate: null, now }), "import");
});
