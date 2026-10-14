import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const { nowPlayingFirst, oneCardPerEpisode } = await import("../public/modules/up-next-shared.js");

const tedLasso = { id: "ted", media_type: "episode", show_title: "Ted Lasso", season: 4, episode: 4 };
const scrubs = { id: "scrubs", media_type: "episode", show_title: "Scrubs", season: 1, episode: 2 };
const quietPlace = { id: "quiet", media_type: "movie", title: "A Quiet Place" };

test("Up Next puts the episode that is playing first", () => {
  const sessions = [{ mediaType: "episode", title: "Ted Lasso (2020) - S04E04", season: 4, episode: 4 }];
  assert.deepEqual(nowPlayingFirst([scrubs, tedLasso], sessions).map((item) => item.id), ["ted", "scrubs"]);
});

test("Up Next keeps a different episode of the playing show in its place", () => {
  const sessions = [{ mediaType: "episode", title: "Ted Lasso - S04E03", season: 4, episode: 3 }];
  assert.deepEqual(nowPlayingFirst([scrubs, tedLasso], sessions).map((item) => item.id), ["scrubs", "ted"]);
});

test("Up Next puts the movie that is playing first", () => {
  const sessions = [{ mediaType: "movie", title: "A Quiet Place" }];
  assert.deepEqual(nowPlayingFirst([tedLasso, quietPlace], sessions).map((item) => item.id), ["quiet", "ted"]);
});

test("Up Next shows one card per episode, keeping the part-watched one", () => {
  const nextUp = { id: "ted-next", media_type: "episode", show_title: "Ted Lasso", season: 4, episode: 4, queue_kind: "next_up" };
  const resume = { id: "ted-resume", media_type: "episode", show_title: "Ted Lasso", season: 4, episode: 4, queue_kind: "resume", progress: 40 };
  const sessions = [{ mediaType: "episode", title: "Ted Lasso - S04E04", season: 4, episode: 4 }];
  const items = oneCardPerEpisode(nowPlayingFirst([scrubs, nextUp, resume], sessions));
  assert.deepEqual(items.map((item) => item.id), ["ted-resume", "scrubs"]);
});

test("Up Next keeps a different episode of the same show as its own card", () => {
  const nextEpisode = { id: "ted-e5", media_type: "episode", show_title: "Ted Lasso", season: 4, episode: 5, queue_kind: "next_up" };
  assert.deepEqual(oneCardPerEpisode([tedLasso, nextEpisode]).map((item) => item.id), ["ted", "ted-e5"]);
});

test("Up Next is unchanged with nothing playing", () => {
  const items = [tedLasso, scrubs];
  assert.equal(nowPlayingFirst(items, []), items);
});
