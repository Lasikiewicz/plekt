import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-netflix-episode-aliases-test-");

const { getNetflixEpisodeAliases, resolveNetflixVerifiedRow } = await import("../server/src/utils/netflixEpisodeAliases.js");

test("verified full rows require every pinned identity and preserve current provider coordinates", async () => {
  const entry = { sourceTitle: "Example: Season 9: One / Two", showTmdbId: "42", showTitle: "Example",
    sources: ["https://www.themoviedb.org/tv/42"], targets: [
      { episodeTmdbId: "901", expectedTitle: "One", airDate: "2020-01-01" },
      { episodeTmdbId: "902", expectedTitle: "Two", airDate: "2020-01-02" }] };
  const lists = [{ season: 2, episodes: [{ id: 901, name: "One", episode_number: 7, air_date: "2020-01-01" },
    { id: 902, name: "Two", episode_number: 8, air_date: "2020-01-02" }] }];
  const run = (changes = {}) => resolveNetflixVerifiedRow(entry.sourceTitle, { entries: [entry], watchedAt: "2021-01-01T12:00:00Z",
    getSeasonLists: async ({ tmdbId }) => { assert.equal(tmdbId, "42"); return lists; }, ...changes });
  const result = await run();
  assert.deepEqual(result.map((episode) => [episode.tmdbId, episode.season, episode.episode]), [["42", 2, 7], ["42", 2, 8]]);
  assert.equal(await run({ watchedAt: "2019-01-01T12:00:00Z" }), null);
  assert.equal(await run({ entries: [{ ...entry, watchedBefore: "2021-01-01" }] }), null, "a later reused title is outside the verified watch window");
  assert.equal(await run({ getSeasonLists: async () => [{ season: 2, episodes: [lists[0].episodes[0]] }] }), null, "no partial bundles");
  assert.equal(await run({ getSeasonLists: async () => { throw Error("offline"); } }), null);
  assert.equal(await run({ entries: [entry, entry] }), null, "conflicting source registrations do not resolve");
  for (const field of [{ expectedTitle: "Wrong" }, { airDate: "2020-01-03" }, { episodeTmdbId: "999" }]) {
    assert.equal(await run({ entries: [{ ...entry, targets: [{ ...entry.targets[0], ...field }, entry.targets[1]] }] }), null);
  }
  assert.equal(await resolveNetflixVerifiedRow("Example: Season 9: One / Extra", { entries: [entry], getSeasonLists: async () => { throw Error("must not fetch for other titles"); } }), null);
});

const identity = {
  getTmdbDetails: async () => ({ id: "42", external_ids: { tvdb_id: "700" } }),
};

function run(tmdbLists, episodes, dependencies = {}) {
  return getNetflixEpisodeAliases({
    tmdbId: "42",
    tmdbLists,
    dependencies: {
      ...identity,
      getTvdbSeriesExtended: async (tvdbId) => ({ id: tvdbId, episodes }),
      ...dependencies,
    },
  });
}

test("verified aliases require current show, unique episode ID, canonical title and recorded air date", async () => {
  const episode = { id: 901, episode_number: 8, name: "Canonical title", air_date: "2020-01-01" };
  const entry = { showTmdbId: "42", episodeTmdbId: "901", expectedTitle: "Canonical title",
    airDate: "2020-01-01", titles: ["Verified alternate title"], sources: ["https://tv.apple.com/episode/verified"] };
  const check = (lists, entries = [entry]) => run(lists, [], { verifiedEpisodeAliases: entries,
    getTmdbDetails: async () => { throw new Error("offline"); } });
  const lists = [{ season: 3, episodes: [episode] }];
  const result = await check(lists);
  assert.deepEqual(result[0].episodes[0].alternateTitles, ["Verified alternate title"]);
  assert.equal(result[0].season, 3);
  assert.equal(result[0].episodes[0].episode_number, 8);
  assert.equal(episode.alternateTitles, undefined, "provider input stays unchanged");
  for (const change of [{ showTmdbId: "43" }, { episodeTmdbId: "902" }, { expectedTitle: "Changed title" },
    { airDate: "2020-01-02" }, { sources: [] }]) assert.equal(await check(lists, [{ ...entry, ...change }]), lists);
  const duplicate = [{ season: 3, episodes: [episode, { ...episode, episode_number: 9 }] }];
  assert.equal(await check(duplicate), duplicate);
  const conflict = [{ season: 3, episodes: [episode, { id: 902, name: "Verified alternate title", episode_number: 9 }] }];
  assert.equal(await check(conflict), conflict);
});

test("recovers an alternate title using linked episode IDs across different numbering", async () => {
  const lists = [{ season: 1, episodes: [{ id: 901, episode_number: 8, name: "TMDB title", air_date: "2020-01-01" }] }];
  const result = await run(lists, [{
    id: 333,
    seasonNumber: 3,
    number: 2,
    name: "Netflix title",
    aired: "2020-01-09",
    remoteIds: [{ sourceName: "TheMovieDB.com", id: "901" }],
  }]);
  assert.deepEqual(result[0].episodes[0].alternateTitles, ["Netflix title"]);
  assert.equal(result[0].season, 1);
  assert.equal(result[0].episodes[0].episode_number, 8);
  assert.equal(result[0].episodes[0].id, 901);
});

test("maps a unique exact air date when no episode remote ID is available", async () => {
  const lists = [{ season: 1, episodes: [{ id: 10, episode_number: 1, air_date: "2021-02-03" }] }];
  const result = await run(lists, [{ seasonNumber: 2, number: 4, name: "Date alias", aired: "2021-02-03" }]);
  assert.deepEqual(result[0].episodes[0].alternateTitles, ["Date alias"]);
});

test("does not map an air date shared by multiple episodes", async () => {
  const lists = [{ season: 1, episodes: [
    { id: 10, episode_number: 1, air_date: "2021-02-03" },
    { id: 11, episode_number: 2, air_date: "2021-02-03" },
  ] }];
  const result = await run(lists, [{ name: "Ambiguous alias", aired: "2021-02-03" }]);
  assert.equal(result, lists);
});

test("returns the original lists when TMDB cannot verify a TVDB identity", async () => {
  const lists = [{ season: 1, episodes: [{ episode_number: 1, air_date: "2021-02-03" }] }];
  const result = await run(lists, [{ name: "Do not guess", aired: "2021-02-03" }], {
    getTmdbDetails: async () => ({ id: "42", external_ids: { tvdb_id: "" } }),
  });
  assert.equal(result, lists);
});

test("returns original lists on provider failure", async () => {
  const lists = [{ season: 1, episodes: [{ episode_number: 1, name: "TMDB title" }] }];
  const result = await getNetflixEpisodeAliases({
    tmdbId: "42",
    tmdbLists: lists,
    dependencies: { getTmdbDetails: async () => { throw new Error("offline"); } },
  });
  assert.equal(result, lists);
});
