import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("netflix-import-test-");
const {
  groupNetflixReviews,
  netflixCsvProfiles,
  parseNetflixCsv,
  readNetflixCsv,
  parseNetflixDate,
  parseNetflixEpisodePart,
  pickByWatchYear,
  prepareNetflixImport,
} = await import("../server/src/utils/netflixImport.js");
const { db } = await import("../server/src/db.js");
test.after(() => db.close());

test("one complete named bundle can identify a show, but generic or incomplete bundles cannot", async () => {
  const options = { getHistory: async () => [], getAlternativeTitles: async () => [],
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 1, name: query }, { id: 2, name: query }] : [] }),
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: (String(tmdbId) === "1" ? ["Alpha", "Beta", "Episode 1", "Episode 2"] : ["Other"])
      .map((name, index) => ({ id: index + 1, name, episode_number: index + 1 })) }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists };
  const preview = await prepareNetflixImport("Title,Date\nExample: Season 1: Alpha / Beta,1/1/24", options);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => [record.tmdb_id, record.episode]), [["1", 1], ["1", 2]]);
  for (const title of ["Alpha / Beta / Missing", "Alpha / Alpha", "Episode 1 / Episode 2"]) {
    assert.equal((await prepareNetflixImport(`Title,Date\nExample: Season 1: ${title},1/1/24`, options)).needsReview, 1);
  }
});

test("longer show names containing every query word require distinguishing multi-episode evidence", async () => {
  const options = { getHistory: async () => [], getAlternativeTitles: async () => [],
    search: async ({ query }) => ({ results: query === "Example Stories" ? [{ id: 1, name: "Example 6 Stories Collection" }, { id: 2, name: "Unrelated" }] : [] }),
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: (String(tmdbId) === "1" ? ["Alpha", "Beta"] : ["Other"])
      .map((name, index) => ({ id: index + 1, name, episode_number: index + 1 })) }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists };
  const csv = "Title,Date\nExample Stories: Season 1: Alpha,1/1/24\nExample Stories: Season 1: Beta,1/2/24";
  const preview = await prepareNetflixImport(csv, options);
  assert.equal(preview.needsReview, 0);
  assert.ok(preview.records.every((record) => record.tmdb_id === "1"));
  const future = await prepareNetflixImport(csv, { ...options, search: async () => ({ results: [{ id: 1, name: "Example 6 Stories Collection", first_air_date: "2030-01-01" }] }) });
  assert.equal(future.needsReview, 2, "episode evidence cannot select a show released after the watch");
  const unrelated = await prepareNetflixImport(csv, { ...options, search: async () => ({ results: [{ id: 1, name: "Unrelated" }] }) });
  assert.equal(unrelated.needsReview, 2, "episode evidence cannot bypass all query-name overlap");
  const tied = await prepareNetflixImport(csv, { ...options, search: async () => ({ results: [{ id: 1, name: "Example Stories A" }, { id: 2, name: "Example Stories B" }] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta"].map((name, index) => ({ id: index + 1, name, episode_number: index + 1 })) }] });
  assert.equal(tied.needsReview, 2);
});

test("verified full-row targets retain provenance and deduplicate only already-present episode watches", async () => {
  const options = { getHistory: async () => [{ media_type: "episode", tmdb_id: "42", season: 2, episode: 7, watched_at: "2021-01-01T10:00:00Z" }],
    getVerifiedRow: async () => [7, 8].map((episode) => ({ mediaType: "episode", tmdbId: "42", showTitle: "Example", episodeTitle: `Part ${episode}`, season: 2, episode })),
    search: async () => { throw Error("verified rows do not need a title search"); } };
  const preview = await prepareNetflixImport("Title,Date\nExample: Season 9: One / Two,1/1/21", options);
  assert.equal(preview.needsReview, 0);
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].episode, 8);
  assert.equal(preview.records[0].season, 2);
  assert.equal(preview.records[0].watch_provenance.source_title, "Example: Season 9: One / Two");
  const repeated = await prepareNetflixImport("Title,Date\nExample: Season 9: One / Two,1/1/21", { ...options,
    getHistory: async () => [7, 8].map((episode) => ({ media_type: "episode", tmdb_id: "42", season: 2, episode, watched_at: "2021-01-01T10:00:00Z" })) });
  assert.equal(repeated.matched, 0);
  assert.equal(repeated.skipped, 1);
});

test("reordered provider bundles require the whole unique bundle in the allowed season", async () => {
  const { rowEpisodes } = await import("../server/src/utils/netflixEpisodes.js");
  const combined = { id: 240512, name: "Keeping Cool / Socks & Snooze", episode_number: 1 };
  const part = { episodeTitle: "Socks and Snooze / Keeping Cool", seasonHint: 1, showTitle: "Clifford's Puppy Days" };
  assert.deepEqual(rowEpisodes([{ season: 1, episodes: [combined] }], part).episodes.map((episode) => episode.id), [240512]);
  for (const title of ["Socks and Snooze / Missing", "Socks and Snooze / Socks and Snooze", "Socks and Snooze / Keeping Cool / Extra"]) {
    assert.equal(rowEpisodes([{ season: 1, episodes: [combined] }], { ...part, episodeTitle: title }).episodes, null);
  }
  assert.equal(rowEpisodes([{ season: 2, episodes: [combined] }], part).episodes, null);
  assert.equal(rowEpisodes([{ season: 1, episodes: [combined, { ...combined, id: 2, episode_number: 2 }] }], part).episodes, null);
});

test("a verified episode alias can bind the current row after independent show evidence wins", async () => {
  const lists = [{ season: 2, episodes: ["Opening", "Finale", "Canonical segment", "Other segment"].map((name, index) => ({ id: index + 1, episode_number: index + 1, name })) }];
  let calls = 0;
  const preview = await prepareNetflixImport("Title,Date\nExample: Season 2: Opening,1/1/24\nExample: Season 2: Finale,1/2/24\nExample: Season 2: Alias segment / Other segment,1/3/24", {
    getHistory: async () => [], getAlternativeTitles: async () => [],
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: "Example" }, { id: 43, name: "Example" }] : [] }),
    getSeasonLists: async ({ tmdbId }) => String(tmdbId) === "42" ? lists : [],
    getEpisodeAliases: async ({ tmdbLists }) => { calls += 1; return tmdbLists.map((season) => ({ ...season, episodes: season.episodes.map((episode) => episode.id === 3 ? { ...episode, alternateTitles: ["Alias segment"] } : episode) })); },
  });
  assert.equal(preview.needsReview, 0);
  assert.equal(preview.matched, 4);
  assert.deepEqual(preview.records.map((record) => [record.tmdb_id, record.season, record.episode]), [["42", 2, 1], ["42", 2, 2], ["42", 2, 3], ["42", 2, 4]]);
  assert.equal(calls, 1, "boundary matching reuses the verified alias cache");
});

test("compound episodes accept grandad spelling only with unique complete season matches", async () => {
  const { rowEpisodes } = await import("../server/src/utils/netflixEpisodes.js");
  const episodes = ["Granddad Dog's Garage", "Foggy Day", "Jumble Sale", "Swimming"]
    .map((name, index) => ({ name, episode_number: index + 17 }));
  const part = { showTitle: "Peppa Pig", seasonHint: 2,
    episodeTitle: "Grandad Dog's Garage / Foggy Day / Jumble Sale / Swimming" };
  assert.deepEqual(rowEpisodes([{ season: 2, episodes }], part).episodes.map((episode) => episode.episode_number), [17, 18, 19, 20]);
  assert.equal(rowEpisodes([{ season: 2, episodes: episodes.slice(0, 3) }], part).episodes, null);
  assert.equal(rowEpisodes([{ season: 2, episodes: [...episodes, { name: "Granddad Dog's Garage", episode_number: 53 }] }], part).episodes, null);
  assert.equal(rowEpisodes([{ season: 3, episodes }], part).episodes, null);
});

test("episode evidence checks a longer colon title even beside an exact but unrelated parent title", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Subtitle: Alpha,1/1/24\nExample: Subtitle: Beta,1/2/24", {
    getHistory: async () => [], getAlternativeTitles: async () => [],
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 1, name: "Example" },
      ...Array.from({ length: 8 }, (_, index) => ({ id: 10 + index, name: `Other ${index}` })),
      { id: 2, name: "Example: A Longer Provider Subtitle" }] : [] }),
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: (String(tmdbId) === "2" ? ["Alpha", "Beta"] : ["Other"])
      .map((name, index) => ({ name, episode_number: index + 1 })) }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  });
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => record.tmdb_id), ["2", "2"]);
});

test("volume and repeated-series season labels retain title and part-number guards", async () => {
  assert.deepEqual(parseNetflixEpisodePart("Example 5: Return", { showTitle: "Example" }),
    { episodeTitle: "Return", seasonHint: 5, episodeHint: null });
  assert.equal(parseNetflixEpisodePart("Other 5: Return", { showTitle: "Example" }).seasonHint, null);
  const preview = await prepareNetflixImport("Title,Date\nExample: Vol. 7: Fire Part Two,1/1/24\nExample: Vol. 7: Fire Part One,1/2/24", {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 7, episodes: [{ name: "Fire (1)", episode_number: 1 }, { name: "Fire (2)", episode_number: 2 }] }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  });
  assert.deepEqual(preview.records.map((record) => record.episode), [2, 1]);
  assert.equal(preview.needsReview, 0);
});

test("named season evidence needs three distinct unique titles agreeing on a season", async () => {
  const { learnedNetflixSeasonLabel } = await import("../server/src/utils/netflixEpisodes.js");
  const lists = [{ season: 2, episodes: ["Alpha", "Beta", "Gamma", "Finale"].map((name, index) => ({ name, episode_number: index + 1 })) },
    { season: 3, episodes: [{ name: "Finale", episode_number: 1 }, { name: "Other", episode_number: 2 }] }];
  const rows = ["Alpha", "Beta", "Gamma", "Finale"].map((title) => ({ title: `Example: New Batch: ${title}` }));
  assert.equal(learnedNetflixSeasonLabel(rows, "Example", "New Batch: Finale", lists), 2);
  assert.equal(learnedNetflixSeasonLabel(rows.slice(1), "Example", "New Batch: Finale", lists), null);
  assert.equal(learnedNetflixSeasonLabel([...rows, { title: "Example: New Batch: Other" }], "Example", "New Batch: Finale", lists), null);
  assert.equal(learnedNetflixSeasonLabel([rows[0], rows[0], rows[0]], "Example", "New Batch: Finale", lists), null);
});

test("an ambiguous television prefix cannot hide a unique full film title, but a real episode competes", async () => {
  const options = {
    getHistory: async () => [], getAlternativeTitles: async () => [],
    search: async ({ query, mediaType }) => ({ results: mediaType === "movie" && query === "Example: A Film"
      ? [{ id: 7, title: query, release_date: "2020-01-01" }] : mediaType === "tv" && query === "Example"
        ? [{ id: 1, name: query }, { id: 2, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: [{ name: "Other", episode_number: 1 }] }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  };
  const csv = "Title,Date\nExample: A Film,1/1/24";
  assert.equal((await prepareNetflixImport(csv, options)).records[0].media_type, "movie");
  const competing = await prepareNetflixImport(csv, { ...options,
    getSeasonLists: async () => [{ season: 1, episodes: [{ name: "A Film", episode_number: 1 }] }] });
  assert.equal(competing.needsReview, 1);
});

test("a nested limited-series label lets episode evidence identify a spin-off", async () => {
  assert.deepEqual(parseNetflixEpisodePart("Revival: Limited Series: Winter"),
    { episodeTitle: "Winter", seasonHint: 1, episodeHint: null });
  const preview = await prepareNetflixImport("Title,Date\nParent: Revival: Limited Series: Winter,1/1/24\nParent: Revival: Limited Series: Summer,1/2/24", {
    getHistory: async () => [],
    search: async ({ query }) => ({ results: query === "Parent" ? [{ id: 1, name: "Parent" }]
      : query === "Parent: Revival" ? [{ id: 2, name: query }] : [] }),
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: (String(tmdbId) === "2" ? ["Winter", "Summer"] : ["Other"])
      .map((name, index) => ({ name, episode_number: index + 1 })) }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  });
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => record.tmdb_id), ["2", "2"]);
});

test("a longer show name requires multiple episode evidence, never just a search suggestion", async () => {
  const options = {
    getHistory: async () => [],
    search: async ({ query }) => ({ results: query === "Short Name" ? [{ id: 2, name: "Longer: Short Name" }] : [] }),
    getAlternativeTitles: async () => [],
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta"].map((name, index) => ({ name, episode_number: index + 1 })) }],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  };
  const one = await prepareNetflixImport("Title,Date\nShort Name: Alpha,1/1/24", options);
  assert.equal(one.needsReview, 1);
  const two = await prepareNetflixImport("Title,Date\nShort Name: Alpha,1/1/24\nShort Name: Beta,1/2/24", options);
  assert.equal(two.needsReview, 0);
  assert.equal(two.matched, 2);
  const repeat = await prepareNetflixImport("Title,Date\nShort Name: Alpha,1/1/24\nShort Name: Alpha,1/2/24", options);
  assert.equal(repeat.needsReview, 2);
  const unrelated = await prepareNetflixImport("Title,Date\nShort Name: Alpha,1/1/24\nShort Name: Beta,1/2/24", {
    ...options, search: async () => ({ results: [{ id: 3, name: "Completely Different Series" }] }),
  });
  assert.equal(unrelated.needsReview, 2);
});

test("known shows match Netflix series, part and anthology labels without inventing season numbers", async () => {
  assert.deepEqual(parseNetflixEpisodePart("Series 4: Episode 6"), { episodeTitle: "Episode 6", seasonHint: 4, episodeHint: 6 });
  assert.deepEqual(parseNetflixEpisodePart("Part 4: Chapter Thirty: The Uninvited"), { episodeTitle: "Chapter Thirty: The Uninvited", seasonHint: null, episodeHint: null });
  const preview = await prepareNetflixImport([
    "Title,Date", "Example: Series 4: Episode 6,1/1/24", "Example: Coven: The Finale,1/2/24",
    "Example: Part 4: Chapter Thirty: The Uninvited,1/3/24",
    '"Example: New World Order, Part 2",1/4/24', "Example: Mientras Dormias,1/5/24",
    "Example: Subtitle: Season 2: The Return,1/6/24",
  ].join("\n"), {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [
      { season: 4, episodes: [{ id: 46, name: "Final", episode_number: 6 }] },
      { season: 2, episodes: ["The Finale", "Chapter Thirty: The Uninvited", "New World Order (2)", "Mientras Dormías", "The Return"]
        .map((name, index) => ({ id: 21 + index, name, episode_number: index + 1 })) },
    ],
  });
  assert.equal(preview.matched, 6);
  assert.equal(preview.needsReview, 0);
});

test("anthology suffix conflicts stay in review", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Anthology: Finale,1/1/24", {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [1, 2].map((season) => ({ season, episodes: [{ id: season, name: "Finale", episode_number: 1 }] })),
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 1);
});

test("episode evidence beats popularity and watch year; duplicate watches do not add evidence", async () => {
  const search = async () => ({ results: [
    { id: 1, name: "Example", popularity: 100, first_air_date: "2024-01-01" },
    { id: 2, name: "Example", popularity: 1, first_air_date: "1990-01-01" },
  ] });
  const getSeasonLists = async ({ tmdbId }) => [{ season: 1, episodes: (tmdbId === "2" ? ["Alpha", "Beta"] : ["Other"])
    .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }];
  const options = { search, getSeasonLists, getHistory: async () => [] };
  const preview = await prepareNetflixImport("Title,Date\nExample: Alpha,1/1/24\nExample: Beta,1/2/24", options);
  assert.equal(preview.matched, 2);
  assert.ok(preview.records.every((record) => record.tmdb_id === "2"));
  assert.equal(preview.evidenceMatches[0].hits, 2);
  const repeated = await prepareNetflixImport("Title,Date\nExample: Alpha,1/1/24\nExample: Alpha,1/2/24", options);
  assert.equal(repeated.matched, 0);
});

test("episode evidence preserves colons in show names and respects explicit seasons", async () => {
  const preview = await prepareNetflixImport("Title,Date\nKeep Sweet: Pray and Obey: Limited Series: Alpha,1/1/24\nKeep Sweet: Pray and Obey: Limited Series: Beta,1/2/24\nKeep Sweet: Pray and Obey: Season 2: Alpha,1/3/24", {
    getHistory: async () => [],
    search: async ({ query }) => ({ results: query === "Keep Sweet: Pray and Obey" ? [{ id: 9, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.equal(preview.matched, 2);
  assert.equal(preview.needsReview, 1);
  assert.equal(preview.records[0].show_title, "Keep Sweet: Pray and Obey");
});

test("tied show evidence stays in review even when popularity differs", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Alpha,1/1/24\nExample: Beta,1/2/24", {
    getHistory: async () => [],
    search: async () => ({ results: [{ id: 1, name: "Example", popularity: 100 }, { id: 2, name: "Example", popularity: 1 }] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 2);
});

test("compound rows record every segment only when each names exactly one episode", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Alpha / Beta,1/1/24\nExample: Alpha/ Missing,1/2/24", {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => record.episode), [1, 2]);
  assert.equal(preview.needsReview, 1);
});

test("compound normalization removes show prefixes and filler only, preserving ambiguity and complete bundles", async () => {
  const titles = [
    "Octonauts: Season 1: Spinner Dolphins / The Coelacanth",
    "Octonauts: Season 1: Spinner Dolphins / Missing",
    "Octonauts: Season 1: Spinner Dolphins / The Rescue",
    "Octonauts: Season 1: Spinner Dolphins / Coelacanth Part 2",
    "Octonauts: Season 1: Spinner Dolphins / Spinner Dolphins",
    "Octonauts: Season 2: Spinner Dolphins / Coelacanth",
  ];
  const preview = await prepareNetflixImport("Title,Date\n" + titles.map((title, i) => `${title},1/${i + 1}/24`).join("\n"), {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Octonauts" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: ["Octonauts and the Spinner Dolphins", "Octonauts and the Coelacanth",
      "Octonauts and a Rescue", "Octonauts and Rescue", "Octonauts and the Coelacanth Part 1"]
      .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => record.episode), [1, 2]);
  assert.equal(preview.needsReview, 5);
});

test("compound normalization handles possessive prefixes without enabling whole-row number fallback", async () => {
  const preview = await prepareNetflixImport([ACTIVITY_HEADER,
    activityRow("00:20:00", "2024-01-01 12:00:00", "Alex", "Horrid Henry: Season 5: Horrid Henry's Teacher Talk / Horrid Henry and the Good Day, Bad Day"),
    activityRow("00:20:00", "2024-01-02 12:00:00", "Alex", "Horrid Henry: Season 5: Teacher Talk / Missing (Episode 1)"),
  ].join("\n"), {
    profiles: ["Alex"],
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Horrid Henry" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 5, episodes: ["Horrid Henry's Teacher Talk", "Horrid Henry: Good Day, Bad Day"]
      .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => record.episode), [1, 2]);
  assert.equal(preview.needsReview, 1);
});

test("single-title misses: loose title in season, season 0 special, unique other-season title", async () => {
  const titles = [
    "Example: Season 1: Pups Save Friendship Day",
    "Example: Season 1: Stoneheart: Origins: Pt. 2",
    "Example: Season 1: The Rescue",
    "Example: The Great Fire",
    "Example: Season 5: Dora in Wonderland",
    "Example: Season 1: Dora in Wonderland",
    "Example: Season 1: Best Friends",
  ];
  const preview = await prepareNetflixImport("Title,Date\n" + titles.map((title, i) => `${title},1/${i + 1}/24`).join("\n"), {
    getHistory: async () => [], search: async ({ query, mediaType }) => ({ results: query === "Example" && mediaType === "tv" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [
      { season: 0, episodes: [{ id: 1, name: "Example: The Great Fire", episode_number: 1 }] },
      { season: 1, episodes: ["The Pups Save Friendship Day", "Stoneheart - Origins, Part 2", "Rescue", "A Rescue"]
        .map((name, i) => ({ id: 10 + i, name, episode_number: i + 1 })) },
      { season: 2, episodes: ["Dora in Wonderland", "Best Friends"].map((name, i) => ({ id: 20 + i, name, episode_number: i + 1 })) },
      { season: 3, episodes: [{ id: 30, name: "Best Friends", episode_number: 1 }] },
    ],
  });
  assert.deepEqual(preview.records.map((record) => `${record.season}x${record.episode}`), ["1x1", "1x2", "0x1", "2x1"]);
  assert.equal(preview.needsReview, 3);
});

test("a show-prefixed row with no season or number becomes the one released film of that full title", async () => {
  const films = { "Alvin: The Road Chip": "2015-12-18", "Alvin: Future Film": "2030-01-01" };
  const preview = await prepareNetflixImport("Title,Date\nAlvin: The Road Chip,1/1/24\nAlvin: Future Film,1/2/24\nAlvin: Season 1: The Road Chip,1/3/24", {
    getHistory: async () => [],
    search: async ({ query, mediaType }) => ({ results: mediaType === "tv"
      ? (query === "Alvin" ? [{ id: 42, name: query }] : [])
      : (films[query] ? [{ id: 7, title: query, release_date: films[query] }] : []) }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: [{ id: 1, name: "Alpha", episode_number: 1 }] }],
  });
  assert.deepEqual(preview.records.map((record) => `${record.media_type} ${record.tmdb_id}`), ["movie 7"]);
  assert.equal(preview.needsReview, 2);
});

test("compound segments supply show evidence", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Alpha / Beta,1/1/24\nExample: Gamma / Delta,1/2/24", {
    getHistory: async () => [],
    search: async () => ({ results: [{ id: 1, name: "Example" }, { id: 2, name: "Example" }] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: (tmdbId === "2" ? ["Alpha", "Beta", "Gamma", "Delta"] : ["Other"])
      .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.equal(preview.matched, 4);
  assert.ok(preview.records.every((record) => record.tmdb_id === "2"));
});

test("bare Episode N is season 1 only beside labelled later seasons", async () => {
  const getSeasonLists = async () => [1, 2].map((season) => ({ season, episodes: [{ id: season, name: "Episode 1", episode_number: 1 }] }));
  const options = { getHistory: async () => [], getSeasonLists, getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async ({ query }) => ({ results: [{ id: 42, name: query }] }) };
  const labelled = await prepareNetflixImport("Title,Date\nExample: Episode 1,1/1/24\nExample: Season 2: Episode 1,1/2/24", options);
  assert.deepEqual(labelled.records.map((record) => record.season), [1, 2]);
  const unlabelled = await prepareNetflixImport("Title,Date\nExample: Episode 1,1/1/24", options);
  assert.equal(unlabelled.needsReview, 1);
  const seasonOneLabelled = await prepareNetflixImport("Title,Date\nExample: Episode 1,1/1/24\nExample: Season 1: Episode 1,1/2/24", options);
  assert.equal(seasonOneLabelled.needsReview, 1);
});

test("a longer colon prefix names the show only when it alone is unique", async () => {
  const results = {
    "See No Evil": [{ id: 1, name: "See No Evil" }, { id: 2, name: "See No Evil" }],
    "See No Evil: The Story": [{ id: 3, name: "See No Evil: The Story" }],
  };
  const preview = await prepareNetflixImport("Title,Date\nSee No Evil: The Story: Episode 2,1/1/24", {
    getHistory: async () => [], search: async ({ query }) => ({ results: results[query] || [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: [1, 2].map((n) => ({ id: n, name: `Episode ${n}`, episode_number: n })) }],
  });
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].tmdb_id, "3");
});

test("a TMDB alternative title or an and/& spelling names the show when no title matches exactly", async () => {
  const results = {
    "Mako Mermaids": [{ id: 1, name: "Mako: Island of Secrets" }, { id: 2, name: "Mako Reef" }],
    "Mako Mermaids: An H2O Adventure": [{ id: 1, name: "Mako: Island of Secrets" }],
    "Kate & Mim-Mim": [{ id: 3, name: "Kate & Mim-Mim" }],
    Nameless: [{ id: 4, name: "Something Else" }],
  };
  const alternatives = { 1: ["Mako Mermaids", "Mako Mermaids: An H2O Adventure"], 2: ["Mako"], 4: ["Another Name"] };
  const preview = await prepareNetflixImport([
    "Title,Date", "Mako Mermaids: An H2O Adventure: Season 1: Alpha,1/1/24",
    "Mako Mermaids: An H2O Adventure: Season 1: Beta,1/2/24", "Kate and Mim-Mim: Season 1: Gamma,1/3/24",
    "Nameless: Season 1: Alpha,1/4/24",
  ].join("\n"), {
    getHistory: async () => [], search: async ({ query }) => ({ results: results[query] || [] }),
    getAlternativeTitles: async ({ tmdbId }) => alternatives[tmdbId] || [],
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta", "Gamma"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => `${record.tmdb_id}:${record.episode}`), ["1:1", "1:2", "3:3"]);
  assert.equal(preview.needsReview, 1);
});

test("a country suffix picks the same name made there, and a leading The TMDB omits is dropped", async () => {
  const results = {
    Shameless: [{ id: 1, name: "Shameless", origin_country: ["US"] }, { id: 2, name: "Shameless", origin_country: ["GB"] }],
    Wanderers: [{ id: 3, name: "Wanderers", origin_country: ["US"] }],
    Nomads: [{ id: 4, name: "Nomads" }],
    "Dublin Murders": [{ id: 5, name: "Dublin Murders" }],
  };
  const preview = await prepareNetflixImport([
    "Title,Date", "Shameless (U.S.): Season 1: Alpha,1/1/24", "Shameless (UK): Season 1: Beta,1/2/24",
    "Wanderers (UK): Season 1: Alpha,1/3/24", "Nomads (U.S.): Season 1: Alpha,1/4/24",
    "The Dublin Murders: Season 1: Gamma,1/5/24",
  ].join("\n"), {
    getHistory: async () => [], search: async ({ query }) => ({ results: results[query] || [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: ["Alpha", "Beta", "Gamma"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => `${record.tmdb_id}:${record.episode}`), ["1:1", "2:2", "5:3"]);
  assert.equal(preview.needsReview, 2);
});

test("a renumbered Netflix season maps to one TMDB season only when three unique titles agree", async () => {
  const getSeasonLists = async () => [
    { season: 1, episodes: ["Alpha", "Twin"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) },
    { season: 2, episodes: ["Beta", "Gamma", "Delta", "Twin"].map((name, i) => ({ id: 10 + i, name, episode_number: i + 1 })) },
  ];
  const options = { getHistory: async () => [], getSeasonLists, getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }) };
  const rows = ["Beta", "Gamma", "Delta", "Twin"].map((name, i) => `Example: Season 3: ${name},1/${i + 1}/24`);
  const mapped = await prepareNetflixImport(["Title,Date", ...rows].join("\n"), options);
  assert.deepEqual(mapped.records.map((record) => `${record.season}:${record.episode}`), ["2:1", "2:2", "2:3", "2:4"]);
  const tooFew = await prepareNetflixImport(["Title,Date", ...rows.slice(1)].join("\n"), options);
  assert.equal(tooFew.matched, 0);
  const labelFits = await prepareNetflixImport(["Title,Date", ...rows, "Example: Season 3: Alpha,2/1/24"].join("\n"), {
    ...options, getSeasonLists: async () => [...await getSeasonLists(), { season: 3, episodes: [{ id: 30, name: "Alpha", episode_number: 1 }] }],
  });
  // No season map, but each title unique in the show and absent from the existing
  // labelled season still matches on its own; Twin (two seasons) stays in review.
  assert.deepEqual(labelFits.records.map((record) => `${record.season}:${record.episode}`), ["2:1", "2:2", "2:3", "3:1"]);
  assert.equal(labelFits.needsReview, 1);
});

test("a generic Episodes N-M label never soft-matches TMDB's Episode N", async () => {
  const preview = await prepareNetflixImport("Title,Date\nExample: Season 1: Episodes 13-16,1/1/24", {
    getHistory: async () => [], search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{ season: 1, episodes: [{ id: 1, name: "Episode 1", episode_number: 1 }] }],
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 1);
});

test("titles released after the watch year are ruled out; undated candidates block it", async () => {
  const run = (results) => prepareNetflixImport("Title,Date\nGroundhog Day,1/1/17", {
    getHistory: async () => [], search: async () => ({ results }),
  });
  const dated = await run([{ id: 1, title: "Groundhog Day", release_date: "1993-02-12" }, { id: 2, title: "Groundhog Day", release_date: "2023-05-01" }]);
  assert.equal(dated.records[0].tmdb_id, "1");
  const undated = await run([{ id: 1, title: "Groundhog Day", release_date: "1993-02-12" }, { id: 2, title: "Groundhog Day" }]);
  assert.equal(undated.needsReview, 1);
  assert.equal(undated.reviews[0].candidates.length, 2);
});

test("Netflix CSV parser handles quoted titles, a BOM and CRLF", () => {
  const rows = parseNetflixCsv('\uFEFFTitle,Date\r\n"Film, the Sequel",3/4/24\r\n"Show: Episode",12/31/25\r\n');
  assert.deepEqual(rows.map(({ title }) => title), ["Film, the Sequel", "Show: Episode"]);
  assert.equal(rows[0].watchedAt, "2024-03-04T12:00:00.000Z");
});

const ACTIVITY_HEADER = '"Duration","Start Time","Bookmark","Latest Bookmark","Profile Name","Country","Supplemental Video Type","Attributes","Device Type","Title"';
const activityRow = (duration, start, profile, title, supplemental = "") =>
  `"${duration}","${start}","00:00:00","00:00:00","${profile}","GB (United Kingdom)","${supplemental}","","TV","${title}"`;

test("Viewing Activity export lists profiles and needs a choice when several exist", () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2026-10-23 20:00:00", "Alex", "Film"),
    activityRow("00:00:30", "2026-10-23 19:00:00", "Sam", "Film", "TRAILER"),
    activityRow("00:40:00", "2026-10-22 20:00:00", "Sam", "Other Film"),
  ].join("\n");
  assert.deepEqual(netflixCsvProfiles(csv), [{ name: "Alex", rows: 1 }, { name: "Sam", rows: 1 }]);
  assert.throws(() => readNetflixCsv(csv), (error) => error.status === 400 && /Choose the Netflix profiles/.test(error.message));
  assert.deepEqual(parseNetflixCsv(csv, { profiles: ["Sam"] }).map((row) => row.title), ["Other Film"]);
});

test("Viewing Activity keeps one play per title and day, drops previews and short views, and strips Netflix episode numbers", () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:03:00", "2026-10-23 20:06:34", "Alex", "Show: Season 5: Splinter (Episode 7)"),
    activityRow("00:18:46", "2026-10-23 19:47:43", "Alex", "Show: Season 5: Exposed (Episode 6)"),
    activityRow("00:06:02", "2026-10-23 19:35:41", "Alex", "Show: Season 5: Exposed (Episode 6)"),
    activityRow("00:30:00", "2026-10-23 18:00:00", "Sam", "Show: Season 5: Exposed (Episode 6)"),
    activityRow("00:04:00", "2026-10-22 18:00:00", "Alex", "Film"),
    activityRow("00:04:00", "2026-10-22 17:00:00", "Sam", "Film"),
    activityRow("00:02:00", "2026-10-21 18:00:00", "Alex", "Trailer Film", "HOOK"),
    activityRow("01:40:00", "2026-10-20 18:00:00", "Kid", "Cartoon"),
  ].join("\n");
  const { format, records, excluded } = readNetflixCsv(csv, { profiles: ["Alex", "Sam"] });
  assert.equal(format, "viewing_activity");
  assert.deepEqual(records, [{
    index: 0, rowNumber: 3, title: "Show: Season 5: Exposed", watchedAt: "2026-10-23T20:06:29.000Z", episodeNumber: 6,
  }]);
  // Splinter (3 min) and each profile's 4-minute Film view fall under the five-minute minimum.
  assert.deepEqual(excluded, { supplemental: 1, otherProfiles: 1, shortViews: 3 });
});

test("Netflix episode numbers break ties between same-titled episodes but never override the title", async () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2026-10-23 20:00:00", "Alex", "Example: Season 1: Pilot (Episode 2)"),
    activityRow("00:40:00", "2026-10-22 20:00:00", "Alex", "Example: Season 1: Finale (Episode 9)"),
  ].join("\n");
  const preview = await prepareNetflixImport(csv, {
    profiles: ["Alex"], getHistory: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Pilot", "Pilot", "Finale"].map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => [record.episode, record.watch_provenance.source_title]),
    [[2, "Example: Season 1: Pilot"], [3, "Example: Season 1: Finale"]]);
  assert.equal(preview.needsReview, 0);
});

test("a bare season number left by a dropped Season word is a season hint, but clock titles are not", () => {
  assert.deepEqual(parseNetflixEpisodePart("  1: Crown Jewels"), { episodeTitle: "Crown Jewels", seasonHint: 1, episodeHint: null });
  assert.deepEqual(parseNetflixEpisodePart(" A Bridgerton Story:  1: Crown Jewels"), { episodeTitle: "Crown Jewels", seasonHint: 1, episodeHint: null });
  assert.deepEqual(parseNetflixEpisodePart("  7: Episode 8"), { episodeTitle: "Episode 8", seasonHint: 7, episodeHint: 8 });
  assert.deepEqual(parseNetflixEpisodePart(" Season 1: 12:00 a.m.-1:00 a.m."), { episodeTitle: "12:00 a.m.-1:00 a.m.", seasonHint: 1, episodeHint: null });
  assert.deepEqual(parseNetflixEpisodePart(" Staffel 2 – Teil B: Spanien"), { episodeTitle: "Spanien", seasonHint: 2, episodeHint: null });
  assert.deepEqual(parseNetflixEpisodePart(" Temporada 3: Episodio 4"), { episodeTitle: "Episodio 4", seasonHint: 3, episodeHint: null });
  assert.deepEqual(parseNetflixEpisodePart("12:00 a.m.-1:00 a.m."), { episodeTitle: "12:00 a.m.-1:00 a.m.", seasonHint: null, episodeHint: null });
});

test("same-named shows are ruled out when they lack a season and episode the rows name", async () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2026-10-23 20:00:00", "Alex", "Example: Season 3: Episode 2 (Episode 2)"),
    activityRow("00:40:00", "2026-10-22 20:00:00", "Alex", "Example: Season 1: Episode 1 (Episode 1)"),
  ].join("\n");
  const run = (seasonsFor) => prepareNetflixImport(csv, {
    profiles: ["Alex"], getHistory: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async () => ({ results: [{ id: 1, name: "Example" }, { id: 2, name: "Example" }] }),
    getSeasonLists: async ({ tmdbId }) => seasonsFor(tmdbId).map((season) => ({ season, episodes: [1, 2].map((n) => ({ id: season * 10 + n, name: `Episode ${n}`, episode_number: n })) })),
  });
  const resolved = await run((id) => (id === "2" ? [1, 2, 3] : [1]));
  assert.ok(resolved.records.length === 2 && resolved.records.every((record) => record.tmdb_id === "2"));
  const both = await run(() => [1, 2, 3]);
  assert.equal(both.matched, 0);
  assert.equal(both.needsReview, 2);
});

test("season and Netflix episode number match a retitled or unnamed TMDB episode only when names agree", async () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2026-10-23 20:00:00", "Alex", "Example: Season 1: The Unravelling: Pt. 2 (Episode 2)"),
    activityRow("00:40:00", "2026-10-22 20:00:00", "Alex", "Example: Season 1: Anything (Episode 3)"),
    activityRow("00:40:00", "2026-10-21 20:00:00", "Alex", "Example: Season 1: The Stockholm Syndrome (Episode 9)"),
    // Not between two matched neighbours, so only the name check decides it.
    activityRow("00:40:00", "2026-10-20 20:00:00", "Alex", "Example: Season 1: Clash of the Titans (Episode 4)"),
  ].join("\n");
  const preview = await prepareNetflixImport(csv, {
    profiles: ["Alex"], getHistory: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Pilot", "The Unravelling (2)", "Episode 3", "Something Else", "The Change Constant / The Stockholm Syndrome"]
      .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.deepEqual(preview.records.map((record) => record.episode), [2, 3, 5]);
  assert.equal(preview.needsReview, 1);
});

test("number agreement rejects other part numbers and names that share only the show's words", async () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2026-10-23 20:00:00", "Alex", "Example: Season 1: Home to Roost: Part 1 (Episode 2)"),
    activityRow("00:40:00", "2026-10-20 20:00:00", "Alex", "Example: Season 1: Henry's School Trip / Henry and the Aquarium (Episode 5)"),
  ].join("\n");
  const preview = await prepareNetflixImport(csv, {
    profiles: ["Alex"], getHistory: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: ["Henry's Pilot", "Home to Roost, Part Two", "Henry's Day", "Henry Sings", "Henry and the Dinner Guests"]
      .map((name, i) => ({ id: i + 1, name, episode_number: i + 1 })) }],
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 2);
});

test("a colon film with no TV prefix match imports as the one film of that full title", async () => {
  const results = {
    "movie:Death Wish 4: The Crackdown": [{ id: 7, title: "Death Wish 4: The Crackdown", release_date: "1987-11-06" }],
    "movie:Ghostbusters 2": [{ id: 8, title: "Ghostbusters II", release_date: "1989-06-16" }],
    "movie:Pets: Party": [{ id: 9, title: "Pets: Party" }, { id: 10, title: "Pets: Party" }],
  };
  const preview = await prepareNetflixImport("Title,Date\nDeath Wish 4: The Crackdown,1/1/24\nGhostbusters 2,1/2/24\nPets: Party,1/3/24", {
    getHistory: async () => [], search: async ({ query, mediaType }) => ({ results: results[`${mediaType}:${query}`] || [] }),
  });
  assert.deepEqual(preview.records.map((record) => record.tmdb_id), ["7", "8"]);
  assert.equal(preview.needsReview, 1);
});

test("rows without a Netflix title are silently excluded from profile and preview counts", async () => {
  const csv = [ACTIVITY_HEADER,
    activityRow("00:40:00", "2021-04-30 17:53:35", "Alex", "Unknown Title"),
    activityRow("00:40:00", "2021-06-06 12:00:00", "Alex", "Unknown Title (Episode 1)"),
    activityRow("00:40:00", "2021-06-06 12:00:00", "Alex", ":  7: Episode 8 (Episode 8)"),
    activityRow("00:40:00", "2024-01-01 12:00:00", "Alex", "Known Film"),
    activityRow("00:40:00", "2024-01-02 12:00:00", "Other", "   "),
  ].join("\n");
  assert.deepEqual(netflixCsvProfiles(csv), [{ name: "Alex", rows: 1 }]);
  const parsed = readNetflixCsv(csv);
  assert.deepEqual(parsed.records.map((row) => row.title), ["Known Film"]);
  assert.deepEqual(parsed.excluded, { supplemental: 0, otherProfiles: 0, shortViews: 0 });
  const preview = await prepareNetflixImport(csv, {
    getHistory: async () => [], search: async () => ({ results: [{ id: 1, title: "Known Film" }] }),
  });
  assert.equal(preview.total, 1);
  assert.equal(preview.matched, 1);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.reviews, []);
  assert.deepEqual(parseNetflixCsv("Title,Date\nUnknown Title,4/30/21\n"), []);
  assert.deepEqual(parseNetflixCsv("Title,Date\nUnknown Title (Episode 1),6/6/21\n"), []);
  assert.deepEqual(parseNetflixCsv("Title,Date\n\":  7: Episode 8 (Episode 8)\",6/6/21\n"), []);
});

test("films shorter than the Netflix bookmark are ruled out; unknown runtimes stay", async () => {
  const csv = [ACTIVITY_HEADER,
    '"01:50:00","2026-10-23 20:00:00","01:50:00","01:50:00","Alex","GB","","","TV","Persuasion"'].join("\n");
  const run = (runtimes) => prepareNetflixImport(csv, {
    profiles: ["Alex"], getHistory: async () => [],
    search: async () => ({ results: [1, 2, 3].map((id) => ({ id, title: "Persuasion", release_date: `${2000 + id}-01-01` })) }),
    getMovieRuntime: async (id) => runtimes[id],
  });
  const resolved = await run({ 1: 90, 2: 118, 3: 80 });
  assert.equal(resolved.records[0].tmdb_id, "2");
  const unknown = await run({ 1: 90, 2: 118, 3: null });
  assert.equal(unknown.needsReview, 1);
});

test("Netflix dates reject invalid calendar dates and use a stable two-digit year rule", () => {
  assert.equal(parseNetflixDate("2/29/24"), "2024-02-29T12:00:00.000Z");
  assert.equal(parseNetflixDate("2/29/23"), "");
  assert.equal(parseNetflixDate("1/1/70"), "1970-01-01T12:00:00.000Z");
});

test("Netflix episode parts strip Season and Limited Series labels into match hints", () => {
  assert.deepEqual(parseNetflixEpisodePart("Season 12: The Stockholm Syndrome"), {
    episodeTitle: "The Stockholm Syndrome",
    seasonHint: 12,
    episodeHint: null,
  });
  assert.deepEqual(parseNetflixEpisodePart("Limited Series: Leap"), {
    episodeTitle: "Leap",
    seasonHint: 1,
    episodeHint: null,
  });
  assert.deepEqual(parseNetflixEpisodePart("Season 1: Episode 3"), {
    episodeTitle: "Episode 3",
    seasonHint: 1,
    episodeHint: 3,
  });
  assert.deepEqual(parseNetflixEpisodePart("Episode 10"), {
    episodeTitle: "Episode 10",
    seasonHint: null,
    episodeHint: 10,
  });
  assert.deepEqual(parseNetflixEpisodePart("The Peanut Reaction"), {
    episodeTitle: "The Peanut Reaction",
    seasonHint: null,
    episodeHint: null,
  });
});

test("unmatched episode rows are grouped under one show for review", () => {
  const grouped = groupNetflixReviews([
    { row: 1, title: "Example Show: Episode One", episodeTitle: "Episode One", showTitle: "Example Show", watchedAt: "2024-01-01", kind: "episode", reason: "no_episode_match", candidates: [] },
    { row: 2, title: "Example Show: Episode Two", episodeTitle: "Episode Two", showTitle: "Example Show", watchedAt: "2024-01-02", kind: "episode", reason: "no_episode_match", candidates: [] },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].type, "show");
  assert.equal(grouped[0].show, "Example Show");
  assert.equal(grouped[0].episodes.length, 2);
  assert.equal(grouped[0].episodes[0].title, "Episode One");
});

test("Netflix preview resolves episode titles to season/episode watches", async () => {
  const calls = [];
  const seasonCalls = [];
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Example Show: Episode One,1/1/24",
    "Example Show: Episode Two,1/1/24",
    "Example Show: Episode Two,1/1/24",
    "Example Film,1/1/24",
    "Example Film,1/1/24",
  ].join("\n"), {
    getHistory: async () => [],
    search: async ({ query, mediaType }) => {
      calls.push({ query, mediaType });
      if (mediaType === "tv") return { results: [{ id: 123, media_type: "tv", name: "Example Show" }] };
      return { results: [{ id: 456, media_type: "movie", title: "Example Film" }] };
    },
    getSeasonLists: async ({ tmdbId }) => {
      seasonCalls.push(String(tmdbId));
      return [{
        season: 1,
        episodes: [
          { id: 1, name: "Episode One", episode_number: 1 },
          { id: 2, name: "Episode Two", episode_number: 2 },
        ],
      }];
    },
  });
  assert.deepEqual(calls, [
    { query: "Example Show", mediaType: "tv" },
    { query: "Example Film", mediaType: "movie" },
  ]);
  assert.deepEqual(seasonCalls, ["123"]);
  assert.deepEqual(
    preview.records.map(({ media_type, tmdb_id, season, episode, watched_at }) => [media_type, tmdb_id, season, episode, watched_at.slice(0, 10)]),
    [
      ["episode", "123", 1, 1, "2024-01-01"],
      ["episode", "123", 1, 2, "2024-01-01"],
      ["movie", "456", null, null, "2024-01-01"],
    ],
  );
  assert.equal(preview.skipped, 2);
});

test("unmatched episode titles stay in requires review instead of marking the whole show", async () => {
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Example Show: Missing Episode,1/1/24",
  ].join("\n"), {
    getHistory: async () => [],
    search: async () => ({ results: [{ id: 123, media_type: "tv", name: "Example Show" }] }),
    getSeasonLists: async () => [{ season: 1, episodes: [{ id: 1, name: "Other Episode", episode_number: 1 }] }],
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 1);
  assert.equal(preview.reviews[0].type, "show");
  assert.equal(preview.reviews[0].episodes[0].reason, "no_episode_match");
});

test("Season-prefixed and Episode-N Netflix titles resolve with season and number hints", async () => {
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Example Show: Season 2: The Bad Fish Paradigm,1/2/24",
    "Example Show: Season 1: Episode 2,1/3/24",
    "Example Show: Limited Series: Leap,1/4/24",
  ].join("\n"), {
    getHistory: async () => [],
    search: async () => ({ results: [{ id: 123, media_type: "tv", name: "Example Show" }] }),
    getSeasonLists: async () => ([
      {
        season: 1,
        episodes: [
          { id: 1, name: "Pilot", episode_number: 1 },
          { id: 2, name: "The Soft Rain", episode_number: 2 },
          { id: 3, name: "Leap", episode_number: 3 },
        ],
      },
      {
        season: 2,
        episodes: [
          { id: 4, name: "The Bad Fish Paradigm", episode_number: 1 },
          { id: 5, name: "Leap", episode_number: 2 },
        ],
      },
    ]),
  });
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(
    preview.records.map(({ season, episode, episode_title }) => [season, episode, episode_title]),
    [
      [2, 1, "The Bad Fish Paradigm"],
      [1, 2, "The Soft Rain"],
      [1, 3, "Leap"],
    ],
  );
});

test("malformed Netflix CSV is rejected before any import can start", () => {
  assert.throws(() => parseNetflixCsv("Name,Date\nFilm,1/1/24\n"), /Title and Date/);
  assert.throws(() => parseNetflixCsv('Title,Date\n"Film,1/1/24\n'), /unclosed quoted/);
  assert.throws(() => parseNetflixCsv("Title,Date\nFilm,2/30/24\n"), /valid M\/D\/YY/);
});

test("pickByWatchYear resolves a unique release year against the watch date", () => {
  const picked = pickByWatchYear([
    { id: 1, title: "Last Christmas", release_date: "2019-11-08" },
    { id: 2, title: "Last Christmas", release_date: "2024-12-01" },
    { id: 3, title: "Last Christmas", release_date: "1999-01-01" },
  ], "2024-12-12T12:00:00.000Z");
  assert.equal(picked.id, 2);
  assert.equal(pickByWatchYear([
    { id: 1, title: "Film", release_date: "2024-01-01" },
    { id: 2, title: "Film", release_date: "2024-06-01" },
  ], "2024-12-12T12:00:00.000Z"), null);
});

test("ambiguous movie titles auto-pick a unique watch-year match into a collapsed review group", async () => {
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Last Christmas,12/12/24",
    "Office Romance,6/12/26",
  ].join("\n"), {
    getHistory: async () => [],
    search: async ({ query }) => {
      if (query === "Last Christmas") {
        return {
          results: [
            { id: 10, media_type: "movie", title: "Last Christmas", release_date: "2019-11-08" },
            { id: 11, media_type: "movie", title: "Last Christmas", release_date: "2024-11-01" },
            { id: 12, media_type: "movie", title: "Last Christmas", release_date: "1999-01-01" },
          ],
        };
      }
      return {
        results: [
          { id: 20, media_type: "movie", title: "Office Romance", release_date: "2026-01-01" },
          { id: 21, media_type: "movie", title: "Office Romance", release_date: "1977-01-01" },
        ],
      };
    },
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.matchedByYear, 2);
  assert.equal(preview.needsReview, 0);
  assert.equal(preview.reviews[0].type, "year_matched");
  assert.equal(preview.reviews[0].items[0].selectedCandidateId, "11");
  assert.equal(preview.reviews[0].items[1].selectedCandidateId, "20");
});

test("ambiguous movie titles without a unique watch-year still require review", async () => {
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Dup Film,1/1/24",
  ].join("\n"), {
    getHistory: async () => [],
    search: async () => ({
      results: [
        { id: 1, media_type: "movie", title: "Dup Film", release_date: "2020-01-01" },
        { id: 2, media_type: "movie", title: "Dup Film", release_date: "2021-01-01" },
      ],
    }),
  });
  assert.equal(preview.matchedByYear, 0);
  assert.equal(preview.needsReview, 1);
  assert.equal(preview.reviews[0].reason, "ambiguous_title");
});

test("Netflix rows with an empty show name are excluded from preview and never searched", async () => {
  const searches = [];
  const preview = await prepareNetflixImport([
    "Title,Date",
    ": Episode 8,6/7/21",
    ": Episode 7,6/7/21",
  ].join("\n"), {
    getHistory: async () => [],
    search: async ({ query }) => {
      searches.push(query);
      return { results: [] };
    },
  });
  assert.deepEqual(searches, []);
  assert.equal(preview.total, 0);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.reviews, []);
});

test("previously imported Netflix CSV rows are skipped before TMDB matching", async () => {
  const searches = [];
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Example Film,1/1/24",
    "New Film,2/1/24",
  ].join("\n"), {
    getHistory: async () => ([{
      source: "netflix_import",
      watched_at: "2024-01-01T12:00:00.000Z",
      tmdb_id: "456",
      media_type: "movie",
      watch_provenance: {
        source: "netflix_import",
        phase: "netflix",
        source_title: "Example Film",
        source_timestamp: "2024-01-01T12:00:00.000Z",
      },
    }]),
    search: async ({ query, mediaType }) => {
      searches.push(query);
      return { results: [{ id: 789, media_type: mediaType, title: query, name: query, release_date: "2024-01-01" }] };
    },
  });
  assert.deepEqual(searches, ["New Film"]);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].title, "New Film");
});

test("near-miss episode titles auto-match only when unique in the hinted season", async () => {
  const options = {
    getHistory: async () => [],
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{
      season: 3,
      episodes: [
        { id: 1, name: "Fate Accomplis", episode_number: 17 },
        { id: 2, name: "Broke and Panty-less", episode_number: 7 },
        { id: 3, name: "Moonlight on the Bayou (I)", episode_number: 14 },
        { id: 4, name: "Other Title", episode_number: 1 },
      ],
    }],
  };
  const preview = await prepareNetflixImport([
    "Title,Date",
    "Example: Season 3: Fate Accompli,1/1/24",
    "Example: Season 3: Broke and Pantyless,1/2/24",
    "Example: Season 3: Moonlight on the Bayou,1/3/24",
  ].join("\n"), options);
  assert.equal(preview.matched, 3);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => record.episode).sort((a, b) => a - b), [7, 14, 17]);

  const ambiguous = await prepareNetflixImport("Title,Date\nExample: Season 3: Moonlight on the Bayou,1/1/24", {
    ...options,
    getSeasonLists: async () => [{
      season: 3,
      episodes: [
        { id: 1, name: "Moonlight on the Bayou (I)", episode_number: 14 },
        { id: 2, name: "Moonlight on the Bayou (II)", episode_number: 15 },
      ],
    }],
  });
  assert.equal(ambiguous.matched, 0);
  assert.equal(ambiguous.needsReview, 1);
  assert.equal(ambiguous.reviews[0].episodes[0].reason, "ambiguous_episode");
});

test("a season neighbour gap fills only when both sides pin one missing episode", async () => {
  const options = {
    getHistory: async () => [],
    search: async ({ query }) => ({ results: query === "Example" ? [{ id: 42, name: query }] : [] }),
    getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    getSeasonLists: async () => [{
      season: 3,
      episodes: [
        { id: 22, name: "Where the Heart Is", episode_number: 22 },
        { id: 21, name: "Oh the Places You'll Go", episode_number: 21 },
        { id: 20, name: "He Who Hesitates", episode_number: 20 },
        { id: 10, name: "Need to Know", episode_number: 10 },
        { id: 19, name: "Acceptance", episode_number: 19 },
      ],
    }],
  };
  const filled = await prepareNetflixImport([
    "Title,Date",
    "Example: Season 3: Where the Heart Is,1/1/24",
    "Example: Season 3: Good to Go,1/2/24",
    "Example: Season 3: He Who Hesitates,1/3/24",
  ].join("\n"), options);
  assert.equal(filled.matched, 3);
  assert.equal(filled.needsReview, 0);
  assert.equal(filled.records.find((record) => /Good to Go/.test(record.watch_provenance.source_title)).episode, 21);
  assert.equal(filled.records.find((record) => /Good to Go/.test(record.watch_provenance.source_title)).episode_title, "Oh the Places You'll Go");

  const openGap = await prepareNetflixImport([
    "Title,Date",
    "Example: Season 3: Where the Heart Is,1/1/24",
    "Example: Season 3: Good to Go,1/2/24",
    "Example: Season 3: Acceptance,1/3/24",
  ].join("\n"), options);
  assert.equal(openGap.matched, 2);
  assert.equal(openGap.needsReview, 1);
  assert.equal(openGap.reviews[0].episodes[0].reason, "no_episode_match");
  const bundleGap = await prepareNetflixImport([
    "Title,Date",
    "Example: Season 3: Where the Heart Is,1/1/24",
    "Example: Season 3: Good to Go / Missing,1/2/24",
    "Example: Season 3: He Who Hesitates,1/3/24",
  ].join("\n"), options);
  assert.equal(bundleGap.matched, 2);
  assert.equal(bundleGap.needsReview, 1);
});
