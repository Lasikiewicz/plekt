import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("season-posters-");
const { saveCanonicalSeasonPoster, getCanonicalSeasonPosterUrls } = await import("../server/src/utils/mediaArtwork.js");

const slowHorses = { media_type: "tv", title: "Slow Horses", tmdb_id: "95396", tvdb_id: "371028" };

test("a saved season poster is returned for every alias of the show", () => {
  const saved = saveCanonicalSeasonPoster(slowHorses, 2, "/api/season-2.jpg?v=1");
  assert.equal(saved.ok, true);

  assert.equal(getCanonicalSeasonPosterUrls({ media_type: "tv", tvdb_id: "371028" }).get(2), "/api/season-2.jpg?v=1");
  assert.equal(getCanonicalSeasonPosterUrls({ media_type: "tv", tmdb_id: "95396" }).get(2), "/api/season-2.jpg?v=1");
});

test("saving one season keeps the other seasons' posters", () => {
  saveCanonicalSeasonPoster(slowHorses, 1, "/api/season-1.jpg?v=1");
  saveCanonicalSeasonPoster(slowHorses, 3, "/api/season-3.jpg?v=1");

  const posters = getCanonicalSeasonPosterUrls(slowHorses);
  assert.equal(posters.get(1), "/api/season-1.jpg?v=1");
  assert.equal(posters.get(3), "/api/season-3.jpg?v=1");
});

test("a later save replaces the season poster for the same season", () => {
  saveCanonicalSeasonPoster(slowHorses, 1, "/api/season-1.jpg?v=1");
  saveCanonicalSeasonPoster(slowHorses, 1, "/api/season-1.jpg?v=2");

  assert.equal(getCanonicalSeasonPosterUrls(slowHorses).get(1), "/api/season-1.jpg?v=2");
});

test("a title-only season poster can be read back without provider ids", () => {
  const titleOnly = { media_type: "tv", title: "A Title Only Show" };
  const saved = saveCanonicalSeasonPoster(titleOnly, 2, "/api/title-only-season-2.jpg");

  assert.equal(saved.ok, true);
  assert.equal(getCanonicalSeasonPosterUrls(titleOnly).get(2), "/api/title-only-season-2.jpg");
});

test("a season save without a usable url or season number is rejected", () => {
  assert.equal(saveCanonicalSeasonPoster(slowHorses, 4, "").ok, false);
  assert.equal(saveCanonicalSeasonPoster(slowHorses, -1, "/api/season-4.jpg").ok, false);
  assert.equal(saveCanonicalSeasonPoster(slowHorses, "x", "/api/season-4.jpg").ok, false);
  assert.equal(getCanonicalSeasonPosterUrls(slowHorses).has(4), false);
});
