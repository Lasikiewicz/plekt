import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("personal-rating-year-");

const { db } = await import("../server/src/db.js");
const {
  personalRatingMediaKey,
} = await import("../server/src/utils/personalRatingIdentity.js");
const {
  findCanonicalPersonalRating,
  getCanonicalPersonalRating,
  upsertCanonicalPersonalRating,
} = await import("../server/src/utils/personalRatingRepository.js");

test.after(() => db.close());

test("episode title keys drop a release year from the show title", () => {
  const withYear = personalRatingMediaKey({
    media_type: "episode",
    show_title: "Ludwig (2024)",
    season: 2,
    episode: 1,
  });
  const bare = personalRatingMediaKey({
    media_type: "episode",
    show_title: "Ludwig",
    season: 2,
    episode: 1,
  });
  assert.equal(withYear, "episode:title:ludwig:s2e1");
  assert.equal(bare, withYear);
});

test("only a trailing four-digit year is dropped, and movie keys are unchanged", () => {
  assert.equal(
    personalRatingMediaKey({ media_type: "episode", show_title: "Blade 1999", season: 1, episode: 1 }),
    "episode:title:blade-1999:s1e1",
  );
  assert.equal(
    personalRatingMediaKey({ media_type: "movie", title: "Ludwig (2024)" }),
    "movie:title:ludwig-2024",
  );
});

test("a year-less episode rating finds a year-titled row for the same episode", () => {
  const stored = upsertCanonicalPersonalRating({
    media_type: "episode",
    title: "Episode 1",
    show_title: "Ludwig (2024)",
    season: 2,
    episode: 1,
  }, 6, { origin: "manual", timestamp: 1000 });
  assert.equal(stored.media_key, "episode:title:ludwig:s2e1");

  const found = findCanonicalPersonalRating({
    media_type: "episode",
    title: "Episode 1",
    show_title: "Ludwig",
    season: 2,
    episode: 1,
  });
  assert.equal(found?.media_key, "episode:title:ludwig:s2e1");
});

test("a rating with show ids still matches a title-keyed row by show title and coordinate", () => {
  upsertCanonicalPersonalRating({
    media_type: "episode",
    title: "Episode 3",
    show_title: "Tracker Show (2019)",
    season: 1,
    episode: 3,
  }, 7, { origin: "manual", timestamp: 2000 });

  const found = findCanonicalPersonalRating({
    media_type: "episode",
    title: "Episode 3",
    show_title: "Tracker Show",
    show_tmdb_id: "555",
    season: 1,
    episode: 3,
  });
  assert.equal(found?.media_key, "episode:title:tracker-show:s1e3");
  assert.equal(getCanonicalPersonalRating("episode:tmdb:555:s1e3"), null);
});
