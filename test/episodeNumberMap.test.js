import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-number-map-test-");

const {
  buildEpisodeNumberMap,
  translateEpisode,
  detectRowNumbering,
  planShowTranslation,
} = await import("../server/src/utils/episodeNumberMap.js");
const { setShowSeasonSource, readShowNumbering, resolveAndRecordSeasonSource, pinUnrecordedSeasonSources } =
  await import("../server/src/utils/seasonSource.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
});

function day(offset) {
  return new Date(Date.UTC(2002, 9, 3) + offset * 7 * 86400000).toISOString().slice(0, 10);
}

// Naruto-shaped fixture: TVDB has 3 + 3 episodes, TMDB has one season of 6.
const tvdb = [
  { season: 1, episodes: [1, 2, 3].map((n) => ({ episode_number: n, air_date: day(n - 1) })) },
  { season: 2, episodes: [1, 2, 3].map((n) => ({ episode_number: n, air_date: day(n + 2) })) },
];
const tmdb = [
  { season: 1, episodes: [1, 2, 3, 4, 5, 6].map((n) => ({ episode_number: n, air_date: day(n - 1) })) },
];

test("buildEpisodeNumberMap pairs episodes across different season splits by order and air date", () => {
  const map = buildEpisodeNumberMap({ from: tvdb, to: tmdb });
  assert.deepEqual(translateEpisode(map, 1, 3), { season: 1, episode: 3 });
  assert.deepEqual(translateEpisode(map, 2, 1), { season: 1, episode: 4 });
  assert.deepEqual(translateEpisode(map, 2, 3), { season: 1, episode: 6 });
  assert.equal(map.unmapped.length, 0);
  const back = buildEpisodeNumberMap({ from: tmdb, to: tvdb });
  assert.deepEqual(translateEpisode(back, 1, 5), { season: 2, episode: 2 });
});

test("an episode missing from the target is left unmapped instead of shifting later pairs", () => {
  const target = [{ season: 1, episodes: [1, 2, 4, 5, 6].map((n, index) => ({ episode_number: index + 1, air_date: day(n - 1) })) }];
  const map = buildEpisodeNumberMap({ from: tmdb, to: target });
  assert.equal(translateEpisode(map, 1, 3), null);
  assert.deepEqual(map.unmapped, [{ season: 1, episode: 3 }]);
  assert.deepEqual(translateEpisode(map, 1, 4), { season: 1, episode: 3 });
  assert.deepEqual(translateEpisode(map, 1, 6), { season: 1, episode: 5 });
});

test("air dates a day apart still pair", () => {
  const shifted = [{ season: 1, episodes: [1, 2, 3, 4, 5, 6].map((n) => ({ episode_number: n, air_date: new Date(Date.parse(day(n - 1)) + 86400000).toISOString().slice(0, 10) })) }];
  const map = buildEpisodeNumberMap({ from: tvdb, to: shifted });
  assert.deepEqual(translateEpisode(map, 2, 2), { season: 1, episode: 5 });
});

test("specials pair by air date only; an unmatched special has no partner", () => {
  const from = [{ season: 0, episodes: [
    { episode_number: 1, air_date: "2002-12-21" },
    { episode_number: 7, air_date: "2004-08-01" },
    { episode_number: 8, air_date: "" },
  ] }];
  const to = [{ season: 0, episodes: [
    { episode_number: 2, air_date: "2004-08-02" },
    { episode_number: 1, air_date: "2002-12-21" },
  ] }];
  const map = buildEpisodeNumberMap({ from, to });
  assert.deepEqual(translateEpisode(map, 0, 1), { season: 0, episode: 1 });
  assert.deepEqual(translateEpisode(map, 0, 7), { season: 0, episode: 2 });
  assert.equal(translateEpisode(map, 0, 8), null);
  assert.equal(translateEpisode(map, 0, 3), null);
  assert.deepEqual(map.unmapped, [{ season: 0, episode: 8 }]);
});

test("planShowTranslation keeps every distinct watched episode, translated or listed for review", () => {
  const map = buildEpisodeNumberMap({ from: tvdb, to: tmdb });
  const rows = [
    { season: 1, episode: 1 }, { season: 1, episode: 1 }, // a rewatch is one episode
    { season: 2, episode: 3 }, { season: 4, episode: 1 }, { season: 0, episode: 2 },
  ];
  const plan = planShowTranslation(rows, map);
  assert.deepEqual(plan.translated.map((item) => item.to), [{ season: 1, episode: 1 }, { season: 1, episode: 6 }]);
  // The fixtures have no specials, so the watched special has no partner.
  assert.deepEqual(plan.review, [{ season: 4, episode: 1 }, { season: 0, episode: 2 }]);
});

test("detectRowNumbering reports which structure the stored rows already fit", () => {
  assert.equal(detectRowNumbering([{ season: 2, episode: 1 }, { season: 1, episode: 2 }], { tvdb, tmdb }).numbering, "tvdb");
  const tmdbRows = detectRowNumbering([{ season: 1, episode: 5 }, { season: 1, episode: 6 }], { tvdb, tmdb });
  assert.equal(tmdbRows.numbering, "tmdb");
  assert.equal(tmdbRows.fitsTvdb, 0);
  assert.equal(tmdbRows.fitsTmdb, 2);
});

test("a Fix Match choice replaces the write-once record and keeps the row numbering", () => {
  assert.equal(resolveAndRecordSeasonSource("777"), "tvdb");
  assert.deepEqual(readShowNumbering("777").translate, false);
  setShowSeasonSource("777", "tmdb", { rowNumbering: "tvdb", now: 5 });
  assert.deepEqual(readShowNumbering("777"), { source: "tmdb", rowNumbering: "tvdb", translate: true, overriddenAt: 5 });
  // A later global change pin or first read does not undo the choice.
  pinUnrecordedSeasonSources(["777"]);
  assert.equal(resolveAndRecordSeasonSource("777"), "tmdb");
  setShowSeasonSource("777", "tvdb", { rowNumbering: "tvdb" });
  assert.equal(readShowNumbering("777").translate, false);
});

test("a show with no Fix Match choice follows the global default and is not translated", () => {
  assert.deepEqual(readShowNumbering("888"), { source: "tvdb", rowNumbering: "tvdb", translate: false, overriddenAt: null });
});
