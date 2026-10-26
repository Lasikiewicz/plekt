import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";
import { createNetflixCatalogue } from "../server/src/utils/netflixCatalogue.js";
makeTempDataDir("netflix-catalogue-matching-");
const { prepareNetflixImport } = await import("../server/src/utils/netflixImport.js");
const { db } = await import("../server/src/db.js");
test.after(() => db.close());

test("crowded movie searches still check runtime before the existing reported-winner rule", async () => {
  const catalogue = create([{ mediaType: "movie", titles: ["Example (2019)"] }]);
  const candidates = Array.from({ length: 17 }, (_, index) => ({ id: index + 1, title: "Example",
    release_date: index === 0 ? "2019-01-01" : "2015-01-01", vote_count: index === 0 ? 1000 : index === 1 ? 10000 : 5 }));
  const csv = "Profile Name,Start Time,Duration,Title,Bookmark\nKing,2020-01-01 12:00:00,00:15:00,Example,01:30:00";
  const options = { ...defaults, catalogue, profiles: ["King"], search: async () => ({ results: candidates }),
    getMovieRuntime: async (id) => ["1", "3"].includes(String(id)) ? 100 : 10 };
  const preview = await prepareNetflixImport(csv, options);
  assert.equal(preview.needsReview, 0);
  assert.equal(preview.records[0].tmdb_id, "1");
  const unknown = await prepareNetflixImport(csv, { ...options, getMovieRuntime: async (id) => String(id) === "2" ? null : options.getMovieRuntime(id) });
  assert.equal(unknown.needsReview, 1, "unknown runtime retains a competing high-vote namesake");
  const unreported = await prepareNetflixImport(csv, { ...options, catalogue: create([]) });
  assert.equal(unreported.needsReview, 1, "runtime pruning cannot choose between the two survivors by votes alone");
});

test("explicit CSV episodes can reopen an exact namesake search for a recorded Netflix alias", async () => {
  const catalogue = create([{ mediaType: "tv", titles: ["The Golden Hour", "Het gouden uur"] }]);
  const csv = "Title,Date\n" + Array.from({ length: 6 }, (_, index) => `The Golden Hour: Season 1: Episode ${index + 1},1/1/24`).join("\n");
  const options = { ...defaults, catalogue,
    search: async ({ query }) => ({ results: query === "The Golden Hour" ? [{ id: 1, name: query }]
      : query === "Het gouden uur" ? [{ id: 2, name: query }] : [] }),
    getSeasonLists: async ({ tmdbId }) => [{ season: 1, episodes: Array.from({ length: String(tmdbId) === "1" ? 4 : 6 }, (_, index) => ({ id: index + 1, name: `Episode ${index + 1}`, episode_number: index + 1 })) }] };
  const preview = await prepareNetflixImport(csv, options);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => record.tmdb_id), Array(6).fill("2"));
  const missing = await prepareNetflixImport(csv, { ...options, getSeasonLists: async () => [] });
  assert.equal(missing.matched, 0, "missing metadata is not proof for the alias");
  const tied = await prepareNetflixImport(csv, { ...options,
    getSeasonLists: async () => [{ season: 1, episodes: Array.from({ length: 6 }, (_, index) => ({ name: `Episode ${index + 1}`, episode_number: index + 1 })) }] });
  assert.deepEqual(tied.records.map((record) => record.tmdb_id), Array(6).fill("1"), "an exact show with all requested coordinates retains precedence");
});
const create = (entries) => createNetflixCatalogue({ schemaVersion: 1, entries });
const defaults = { getHistory: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
  getSeasonLists: async () => [{ season: 1, episodes: ["Opening", "Finale"].map((name, index) => ({ id: index + 1, name, episode_number: index + 1 })) }] };

test("Charité at War's sourced show alias learns season two by titles without guessing numbering", async () => {
  const { entries } = JSON.parse(fs.readFileSync(new URL("../server/resources/netflix-title-aliases.json", import.meta.url), "utf8"));
  const catalogue = createNetflixCatalogue({}, entries);
  assert.deepEqual(catalogue.aliases("Charité at War", "tv"), ["Charité"]);
  assert.deepEqual(catalogue.reportedCandidates("tv", [{ id: 70837, name: "Charité" }]), []);
  const names = ["Blighty Wound", "A Difficult Birth", "Last Hope", "Buried", "Underground", "Zero Hour"];
  const csv = "Title,Date\n" + names.map((name) => `Charité at War: Season 1: ${name},1/1/20`).join("\n");
  const options = { ...defaults, catalogue,
    search: async ({ query }) => ({ results: query === "Charité" ? [{ id: 70837, name: "Charité", first_air_date: "2017-03-21" }] : [] }),
    getSeasonLists: async () => [{ season: 1, episodes: [{ id: 1, episode_number: 1, name: "Compassion" }] },
      { season: 2, episodes: names.map((name, index) => ({ id: 1709107 + index, name, episode_number: index + 1 })) }] };
  const preview = await prepareNetflixImport(csv, options);
  assert.equal(preview.needsReview, 0);
  assert.deepEqual(preview.records.map((record) => [record.tmdb_id, record.season, record.episode]), names.map((_, index) => ["70837", 2, index + 1]));
  const conflict = await prepareNetflixImport(csv, { ...options, search: async ({ query }) => ({ results: query === "Charité"
    ? [{ id: 70837, name: "Charité" }, { id: 999, name: "Charité" }] : [] }) });
  assert.equal(conflict.matched, 0, "the alias cannot break tied show evidence");
  assert.equal(conflict.needsReview, 6);
});

test("producer-only and untrusted title-alias sources supply no matching evidence", () => {
  for (const sources of [["https://www.ufa.de/produktionen/charite-serie"],
    ["https://www.netflix.com/gb/title/81081067", "https://example.com/unverified"]]) {
    const catalogue = createNetflixCatalogue({}, [{ mediaType: "tv", titles: ["Charité at War", "Charité"], sources }]);
    assert.deepEqual(catalogue.aliases("Charité at War", "tv"), []);
  }
});

test("Netflix editorial aliases recover titles without supplying report or clear-winner evidence", async () => {
  const catalogue = createNetflixCatalogue({ schemaVersion: 1, entries: [] }, [{ mediaType: "movie",
    titles: ["Trolls Holiday Special", "Trolls Holiday"], sources: ["https://www.netflix.com/tudum/articles/animated-holiday-movies"] }]);
  const candidates = [{ id: 1, title: "Trolls Holiday", release_date: "2017-01-01", vote_count: 1000 }];
  assert.deepEqual(catalogue.reportedCandidates("movie", candidates), []);
  assert.equal(catalogue.has("Trolls Holiday", "movie"), false);
  const options = { ...defaults, catalogue, search: async () => ({ results: candidates }) };
  const preview = await prepareNetflixImport("Title,Date\nTrolls Holiday Special,1/1/24", options);
  assert.equal(preview.records[0].tmdb_id, "1");
  const ambiguous = await prepareNetflixImport("Title,Date\nTrolls Holiday Special,1/1/24", {
    ...options, search: async () => ({ results: [...candidates, { id: 2, title: "Trolls Holiday", release_date: "2010-01-01" }] }),
  });
  assert.equal(ambiguous.needsReview, 1);
});

test("exact original-language titles and leading spelled numbers preserve all namesake candidates", async () => {
  const choices = [{ id: 1, title: "Translated Title", original_title: "Le serment des Hitler", release_date: "2013-01-01" },
    { id: 2, title: "Fifty Dead Men Walking", release_date: "2008-01-01" }];
  const options = { ...defaults, catalogue: create([]), search: async ({ mediaType }) => ({ results: mediaType === "movie" ? choices : [] }) };
  const preview = await prepareNetflixImport("Title,Date\nLe serment des Hitler,1/1/24\n50 Dead Men Walking,1/2/24", options);
  assert.deepEqual(preview.records.map((record) => record.tmdb_id), ["1", "2"]);
  const ambiguous = await prepareNetflixImport("Title,Date\nLe serment des Hitler,1/1/24", { ...options,
    search: async () => ({ results: [...choices, { id: 3, title: "Le serment des Hitler", release_date: "2010-01-01" }] }) });
  assert.equal(ambiguous.needsReview, 1);
  const literal = await prepareNetflixImport("Title,Date\n50 Dead Men Walking,1/1/24", { ...options,
    search: async () => ({ results: [...choices, { id: 4, title: "50 Dead Men Walking", release_date: "2010-01-01" }] }) });
  assert.equal(literal.records[0].tmdb_id, "4");
});

test("official original-language alias recovers a title search miss and still matches the episode", async () => {
  const queries = [];
  const preview = await prepareNetflixImport("Title,Date\nReported Show: Season 1: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Reported Show", "원제"] }]),
    search: async ({ query }) => { queries.push(query); return { results: query === "원제" ? [{ id: 42, name: "International Title", original_name: "원제" }] : [] }; },
  });
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].tmdb_id, "42");
  assert.deepEqual(queries, ["Reported Show", "원제"]);
});

test("a report-backed alias ranks an ambiguous remake but does not choose it", async () => {
  const preview = await prepareNetflixImport("Title,Date\nReported Show: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Reported Show", "원제"] }]),
    search: async () => ({ results: [{ id: 1, name: "Reported Show", original_name: "Reported Show", popularity: 100 },
      { id: 2, name: "Reported Show", original_name: "원제", popularity: 1 }] }),
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 1);
  assert.equal(preview.reviews[0].showCandidates.length, 2);
  assert.equal(preview.reviews[0].showCandidates[0].id, "2");
  assert.equal(preview.reviews[0].showCandidates[0].netflixEvidence.kind, "paired_title");
});

test("episode evidence remains stronger than a report alias when choosing a show", async () => {
  const preview = await prepareNetflixImport("Title,Date\nReported Show: Opening,1/1/24\nReported Show: Finale,1/2/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Reported Show", "원제"] }]),
    search: async () => ({ results: [{ id: 1, name: "Reported Show", original_name: "원제" }, { id: 2, name: "Reported Show" }] }),
    getSeasonLists: async ({ tmdbId }) => tmdbId === "2" ? defaults.getSeasonLists() : [],
  });
  assert.equal(preview.matched, 2);
  assert.ok(preview.records.every((record) => record.tmdb_id === "2"));
});

test("a full Netflix film title containing a colon can match without a false TV prefix", async () => {
  const options = { ...defaults, search: async ({ query, mediaType }) => ({ results: mediaType === "movie" && query === "Film: A Subtitle"
    ? [{ id: 5, title: query, media_type: "movie" }] : [] }) };
  const csv = 'Title,Date\nFilm: A Subtitle,1/1/24';
  // With no exact TV prefix, the one exact film of the full title matches even when unreported.
  assert.equal((await prepareNetflixImport(csv, { ...options, catalogue: create([]) })).matched, 1);
  const preview = await prepareNetflixImport(csv, { ...options, catalogue: create([{ mediaType: "movie", titles: ["Film: A Subtitle"] }]) });
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].media_type, "movie");
});

test("a full report show name with a colon parses correctly even for one episode", async () => {
  const preview = await prepareNetflixImport("Title,Date\nSeries: A Subtitle: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Series: A Subtitle"] }]),
    search: async ({ query }) => ({ results: query === "Series: A Subtitle" ? [{ id: 6, name: query }] : [] }),
  });
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].show_title, "Series: A Subtitle");
});

test("absence from the reports does not prevent normal title matching", async () => {
  const preview = await prepareNetflixImport("Title,Date\nUnlisted Film,1/1/24", {
    ...defaults, catalogue: create([]), search: async ({ query }) => ({ results: [{ id: 7, title: query, media_type: "movie" }] }),
  });
  assert.equal(preview.matched, 1);
});

test("an unresolvable report season title does not replace a working series boundary", async () => {
  const preview = await prepareNetflixImport("Title,Date\nSeries: Special: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Series: Special"] }]),
    search: async ({ query }) => ({ results: query === "Series" ? [{ id: 6, name: query }] : [] }),
  });
  assert.equal(preview.matched, 1);
  assert.equal(preview.records[0].show_title, "Series");
});

test("an alias lookup cap cannot turn a partial search into an automatic match", async () => {
  const preview = await prepareNetflixImport("Title,Date\nReported Show: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Reported Show", "A", "B", "C", "D"] }]),
    search: async ({ query }) => ({ results: query === "A" ? [{ id: 42, name: "A" }] : [] }),
  });
  assert.equal(preview.matched, 0);
  assert.equal(preview.needsReview, 1);
  assert.equal(preview.reviews[0].showCandidates[0].id, "42");
});

test("Netflix title + clear winner: the one reported candidate with ten times the votes matches", async () => {
  const films = [{ id: 1, title: "Same Film", release_date: "1999-05-01", vote_count: 5000 },
    { id: 2, title: "Same Film", release_date: "2015-01-01", vote_count: 400 }];
  const run = (entries, results = films) => prepareNetflixImport("Title,Date\nSame Film,1/1/24", {
    ...defaults, catalogue: create(entries), search: async () => ({ results }) });
  const labelled = await run([{ mediaType: "movie", titles: ["Same Film (1999)"], reportTitles: ["Same Film (1999)"] }]);
  assert.equal(labelled.matched, 1);
  assert.equal(labelled.records[0].tmdb_id, "1");
  // Netflix's premiere year identifies an original the same way.
  const dated = await run([{ mediaType: "movie", titles: ["Same Film"], reportTitles: ["Same Film"], releaseYears: [2015] }],
    [{ ...films[0], vote_count: 40 }, { ...films[1], vote_count: 900 }]);
  assert.equal(dated.records[0].tmdb_id, "2");
  // Not ten times the votes, an undated report entry, or no report entry: review.
  assert.equal((await run([{ mediaType: "movie", titles: ["Same Film (1999)"] }], [films[0], { ...films[1], vote_count: 501 }])).needsReview, 1);
  assert.equal((await run([{ mediaType: "movie", titles: ["Same Film"] }])).needsReview, 1);
  assert.equal((await run([])).needsReview, 1);
});

test("Netflix title + clear winner needs the show to start near a first-season premiere", async () => {
  const shows = [{ id: 1, name: "Same Show", first_air_date: "2020-03-01", vote_count: 900 },
    { id: 2, name: "Same Show", first_air_date: "1985-01-01", vote_count: 20 }];
  const run = (entry) => prepareNetflixImport("Title,Date\nSame Show: Season 1: Opening,1/1/24", {
    ...defaults, catalogue: create([{ mediaType: "tv", titles: ["Same Show"], ...entry }]), search: async () => ({ results: shows }) });
  const opening = await run({ reportTitles: ["Same Show: Season 1"], releaseYears: [2020] });
  assert.equal(opening.matched, 1);
  assert.equal(opening.records[0].tmdb_id, "1");
  // A later-season premiere fits both shows, so nothing singles one out.
  assert.equal((await run({ reportTitles: ["Same Show: Season 3"], releaseYears: [2023] })).needsReview, 1);
});

test("a year in the Netflix film title picks the one same-named film from that year", async () => {
  const results = [{ id: 1, title: "Same Film", release_date: "1991-11-13" }, { id: 2, title: "Same Film", release_date: "2017-03-16" },
    { id: 3, title: "Same Film", release_date: "2014-02-12" }];
  const run = (title) => prepareNetflixImport(`Title,Date\n${title},1/1/24`, { ...defaults, catalogue: create([]), search: async () => ({ results }) });
  const labelled = await run("Same Film (2017)");
  assert.equal(labelled.matched, 1);
  assert.equal(labelled.records[0].tmdb_id, "2");
  assert.equal((await run("Same Film (2000)")).needsReview, 1);
  assert.equal((await run("Same Film")).needsReview, 1);
});
