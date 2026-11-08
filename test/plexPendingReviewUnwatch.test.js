import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-review-unwatch-");
const { db } = await import("../server/src/db.js");
const { checkPlexUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");
const { enqueueManualWatchReview, getManualWatchReview, setManualWatchReviewStatus } = await import("../server/src/utils/manualWatchReview.js");
const { getPlaystateForMedia } = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

test.after(() => db.close());

test("Plex fallback clears a review-only item without a notification, but preserves watched and resumed items", async (t) => {
  const config = { plex: { baseUrl: "https://plex.example.test", token: "test-token" } };
  const states = new Map();
  const reviews = [];
  for (const [id, source, state] of [
    ["clear", "plex", {}], // Plex omits zero-valued user-data fields.
    ["watched", "plex", { viewCount: 1 }],
    ["resumed", "plex", { viewOffset: 120000 }],
    ["missing", "plex", null],
    ["other", "emby", {}],
    ["decided", "plex", {}],
  ]) {
    const media = { title: `Review ${id}`, type: "movie", source, itemId: id, ids: { imdb: `tt-${id}` }, isValid: true };
    const queued = enqueueManualWatchReview(media, { reason: "flag_only", allowWhenUnwatched: true });
    reviews.push({ id, media, review: queued.review });
    states.set(id, state);
  }
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const id = url.pathname.split("/").at(-1);
    if (url.pathname.startsWith("/library/metadata/")) {
      requested.push(id);
      if (id === "decided") setManualWatchReviewStatus(reviews.find((entry) => entry.id === id).review.id, "approved");
      const state = states.get(id);
      return Response.json({ MediaContainer: { Metadata: state === null ? [] : [{ ratingKey: id, type: "movie", ...state }] } });
    }
    return new Response(null, { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await checkPlexUnwatchedStatus(config, createLoopStore());
  for (const entry of reviews) {
    assert.equal(getManualWatchReview(entry.review.id).status,
      entry.id === "clear" ? "dismissed" : entry.id === "decided" ? "approved" : "pending", entry.id);
    assert.equal((await getPlaystateForMedia(entry.media))?.state || null, entry.id === "clear" ? "unwatched" : null, entry.id);
  }
  assert.equal(requested.includes("other"), false, "another provider's review cannot authorize a Plex clear");
});

test("Plex review fallback rotates beyond its 30-item request budget", async (t) => {
  db.prepare("DELETE FROM manual_watch_reviews").run();
  const media = { title: "Old cleared review", type: "movie", source: "plex", itemId: "old", ids: { imdb: "tt-old" }, isValid: true };
  const old = enqueueManualWatchReview(media, { allowWhenUnwatched: true }).review;
  db.prepare("UPDATE manual_watch_reviews SET created_at = 1 WHERE id = ?").run(old.id);
  for (let index = 0; index < 30; index++) {
    enqueueManualWatchReview({ ...media, title: `Newer watched ${index}`, itemId: `new-${index}`, ids: { imdb: `tt-new-${index}` } }, { allowWhenUnwatched: true });
  }
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const id = new URL(String(input)).pathname.split("/").at(-1);
    requested.push(id);
    return Response.json({ MediaContainer: { Metadata: [{ ratingKey: id, type: "movie", viewCount: id === "old" ? 0 : 1 }] } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const config = { plex: { baseUrl: "https://plex.example.test", token: "test-token" } };
  const store = createLoopStore();
  await checkPlexUnwatchedStatus(config, store);
  assert.equal(requested.length, 30);
  assert.equal(getManualWatchReview(old.id).status, "pending");
  await checkPlexUnwatchedStatus(config, store);
  assert.equal(requested.length, 60);
  assert.equal(getManualWatchReview(old.id).status, "dismissed", "older reviews are reached on the next poll");
});
