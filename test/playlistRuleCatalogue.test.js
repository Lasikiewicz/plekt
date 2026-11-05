import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-playlist-rule-catalogue-");

const {
  CATALOGUE_CACHE_TTL_MS,
  clearLibraryCatalogueCache,
  genreKey,
  playlistRuleGenres,
  readEmbyLikeLibraryCatalogue,
  readLibraryCatalogue,
  readLibraryCatalogues,
  readLibrarySeriesEpisodes,
  readPlexLibraryCatalogue,
} = await import("../server/src/utils/playlistRuleCatalogue.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "t" },
  emby: { baseUrl: "http://emby.test/", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" },
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// routes: { "path?query": body | status number }. Unlisted URLs are 404.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (...args) => {
    const url = args.find((arg) => arg instanceof URL);
    const key = `${url.pathname}${url.search}`;
    calls.push(url);
    const match = Object.keys(routes).find((route) => route === key || route === url.pathname);
    if (match === undefined) return jsonResponse({}, 404);
    const value = routes[match];
    return typeof value === "number" ? jsonResponse({}, value) : jsonResponse(value);
  };
  return { fetch, calls };
}

test("genreKey merges case, spacing, punctuation, and known alternate spellings", () => {
  assert.equal(genreKey("Science Fiction"), genreKey("Sci-Fi"));
  assert.equal(genreKey("sci fi"), genreKey("science  fiction"));
  assert.equal(genreKey("Action/Adventure"), genreKey("Action & Adventure"));
  assert.equal(genreKey("Sci-Fi & Fantasy"), genreKey("Science Fiction & Fantasy"));
  assert.equal(genreKey("Children"), genreKey("Kids"));
  assert.equal(genreKey("Reality-TV"), genreKey("Reality"));
  // A compound genre stays its own genre.
  assert.notEqual(genreKey("Sci-Fi & Fantasy"), genreKey("Science Fiction"));
  assert.notEqual(genreKey("Music"), genreKey("Musical"));
  assert.equal(genreKey("  "), "");
});

test("Plex catalogue reads every movie and show section with full genre membership per genre", async () => {
  const { fetch, calls } = fakeFetch({
    "/library/sections": { MediaContainer: { Directory: [
      { key: "1", type: "movie" }, { key: "2", type: "show" }, { key: "3", type: "artist" },
    ] } },
    "/library/sections/1/all?type=1&includeGuids=1": { MediaContainer: { Metadata: [
      { ratingKey: "10", title: "Alien", year: 1979, originallyAvailableAt: "1979-05-25", addedAt: 1700000000, audienceRating: 8.5, Genre: [{ tag: "Horror" }], Guid: [{ id: "tmdb://348" }, { id: "imdb://tt0078748" }] },
      { ratingKey: "11", title: "Heat", year: 1995, addedAt: 1600000000, rating: 7.9, Guid: [{ id: "tmdb://949" }] },
    ] } },
    "/library/sections/1/genre": { MediaContainer: { Directory: [
      { key: "501", title: "Science Fiction" },
      { key: "/library/sections/1/all?genre=502", title: "Horror" },
    ] } },
    "/library/sections/1/all?genre=501&type=1": { MediaContainer: { Metadata: [{ ratingKey: "10" }] } },
    "/library/sections/1/all?genre=502&type=1": { MediaContainer: { Metadata: [{ ratingKey: "10" }, { ratingKey: "unknown" }] } },
    "/library/sections/2/all?type=2&includeGuids=1": { MediaContainer: { Metadata: [
      { ratingKey: "20", title: "Andor", year: 2022, addedAt: 1710000000, Guid: [{ id: "tmdb://83867" }, { id: "tvdb://393189" }] },
    ] } },
    "/library/sections/2/genre": { MediaContainer: { Directory: [{ key: "601", title: "Sci-Fi" }] } },
    "/library/sections/2/all?genre=601&type=2": { MediaContainer: { Metadata: [{ ratingKey: "20" }] } },
  });
  const items = await readPlexLibraryCatalogue(config.plex, { fetchPlex: fetch });
  assert.deepEqual(items.map((item) => [item.item_id, item.media_type, item.genres]), [
    ["10", "movie", ["Horror", "Science Fiction"]],
    ["11", "movie", []],
    ["20", "tv", ["Sci-Fi"]],
  ]);
  const alien = items[0];
  assert.equal(alien.year, 1979);
  assert.equal(alien.release_date, "1979-05-25");
  assert.equal(alien.added_at, 1700000000 * 1000);
  assert.equal(alien.rating, 8.5);
  assert.deepEqual(alien.ids, { tmdb: "348", tvdb: "", imdb: "tt0078748" });
  assert.deepEqual(alien.genre_keys, ["horror", "sciencefiction"]);
  assert.equal(items[1].rating, 7.9);
  assert.deepEqual(items[2].ids, { tmdb: "83867", tvdb: "393189", imdb: "" });
  assert.ok(!calls.some((url) => url.pathname.startsWith("/library/sections/3")), "music sections are skipped");
});

test("a failed Plex genre read fails the whole catalogue instead of returning titles without that genre", async () => {
  const { fetch } = fakeFetch({
    "/library/sections": { MediaContainer: { Directory: [{ key: "1", type: "movie" }] } },
    "/library/sections/1/all?type=1&includeGuids=1": { MediaContainer: { Metadata: [{ ratingKey: "10", title: "Alien" }] } },
    "/library/sections/1/genre": { MediaContainer: { Directory: [{ key: "501", title: "Horror" }] } },
    "/library/sections/1/all?genre=501&type=1": 500,
  });
  await assert.rejects(readPlexLibraryCatalogue(config.plex, { fetchPlex: fetch }), (error) => error.status === 500);
});

test("Emby and Jellyfin catalogues page through movies and series with their own parameter spelling", async () => {
  const page = (items, total) => ({ Items: items, TotalRecordCount: total });
  const movie = (id, extra = {}) => ({ Id: id, Type: "Movie", Name: `Movie ${id}`, ProductionYear: 2001, DateCreated: "2024-05-01T10:00:00.000Z", CommunityRating: 6.5, PremiereDate: "2001-03-04T00:00:00.0000000Z", Genres: ["Sci-Fi", "Science Fiction"], ProviderIds: { Tmdb: "1", Imdb: "tt1" }, ...extra });
  const series = { Id: "s1", Type: "Series", Name: "Show", Genres: ["Drama"], ProviderIds: { Tvdb: "77" } };
  const bodies = [page([movie("a"), movie("b")], 3), page([series, { Id: "x", Type: "BoxSet" }], 3)];
  for (const provider of ["emby", "jellyfin"]) {
    const calls = [];
    let index = 0;
    const fetchImpl = async (url, options) => { calls.push({ url, options }); return jsonResponse(bodies[index++]); };
    const items = await readEmbyLikeLibraryCatalogue(provider, config[provider], { fetchImpl, pageSize: 2 });
    assert.deepEqual(items.map((item) => [item.item_id, item.media_type]), [["a", "movie"], ["b", "movie"], ["s1", "tv"]], provider);
    assert.deepEqual(items[0].genres, ["Sci-Fi"], "two spellings of one genre are kept once");
    assert.equal(items[0].added_at, Date.parse("2024-05-01T10:00:00.000Z"));
    assert.equal(items[0].rating, 6.5);
    assert.deepEqual(items[0].ids, { tmdb: "1", tvdb: "", imdb: "tt1" });
    assert.equal(items[2].year, null);
    assert.equal(items[0].release_date, "2001-03-04");
    assert.equal(items[2].release_date, "");
    assert.equal(calls.length, 2);
    const first = calls[0].url;
    assert.equal(first.pathname, "/Users/u/Items");
    if (provider === "emby") {
      assert.equal(first.searchParams.get("IncludeItemTypes"), "Movie,Series");
      assert.equal(first.searchParams.get("Fields"), "Genres,DateCreated,ProviderIds,ProductionYear,PremiereDate,CommunityRating");
      assert.equal(first.searchParams.get("api_key"), "k");
      assert.equal(calls[1].url.searchParams.get("StartIndex"), "2");
    } else {
      assert.equal(first.searchParams.get("includeItemTypes"), "Movie,Series");
      assert.equal(first.searchParams.get("fields"), "Genres,DateCreated,ProviderIds,ProductionYear,PremiereDate");
      assert.equal(first.searchParams.get("api_key"), null);
      assert.equal(calls[1].url.searchParams.get("startIndex"), "2");
    }
  }
});

test("an Emby-like read that ends short of its reported total fails instead of returning a partial library", async () => {
  const fetchImpl = async () => jsonResponse({ Items: [{ Id: "a", Type: "Movie" }], TotalRecordCount: 5 });
  await assert.rejects(readEmbyLikeLibraryCatalogue("emby", config.emby, { fetchImpl, pageSize: 2 }), /stopped at 1 of 5/);
  const failing = async () => jsonResponse({}, 503);
  await assert.rejects(readEmbyLikeLibraryCatalogue("jellyfin", config.jellyfin, { fetchImpl: failing }), (error) => error.status === 503);
});

test("catalogues are cached per app, re-read after the cache age or on force, and a failed read marks only that app", async () => {
  clearLibraryCatalogueCache();
  let reads = 0;
  let fail = false;
  const readers = {
    plex: async () => { reads += 1; return [{ item_id: `p${reads}` }]; },
    emby: async () => { if (fail) throw new Error("Emby timed out"); return []; },
    jellyfin: async () => [],
  };
  const now = Date.now();
  const first = await readLibraryCatalogue("plex", config, { readers, now });
  assert.equal(first.status, "ok");
  assert.equal((await readLibraryCatalogue("plex", config, { readers, now: first.fetched_at + 1000 })).items[0].item_id, "p1");
  assert.equal(reads, 1);
  assert.equal((await readLibraryCatalogue("plex", config, { readers, now: first.fetched_at + CATALOGUE_CACHE_TTL_MS + 1 })).items[0].item_id, "p2");
  assert.equal((await readLibraryCatalogue("plex", config, { readers, force: true })).items[0].item_id, "p3");

  fail = true;
  const all = await readLibraryCatalogues(["plex", "emby", "jellyfin"], { ...config, jellyfin: { disabled: true } }, { readers });
  assert.equal(all.plex.status, "ok");
  assert.deepEqual(all.emby, { status: "error", error: "Emby timed out" });
  assert.deepEqual(all.jellyfin, { status: "not_configured" });
  fail = false;
  assert.equal((await readLibraryCatalogue("emby", config, { readers })).status, "ok", "a failed read is not cached");
  clearLibraryCatalogueCache();
});

test("the genre list merges app and TMDB genres under TMDB's name and leaves out the other kind", () => {
  const item = (provider, mediaType, genres) => ({ provider, media_type: mediaType, genres, genre_keys: genres.map(genreKey) });
  const catalogues = {
    plex: { status: "ok", items: [item("plex", "movie", ["Science Fiction", "Martial Arts"]), item("plex", "tv", ["Sitcom"])] },
    emby: { status: "ok", items: [item("emby", "movie", ["Sci-Fi"]), item("emby", "movie", ["martial arts"]), item("emby", "movie", ["Martial Arts"])] },
    jellyfin: { status: "error", error: "down" },
  };
  const movies = playlistRuleGenres("movie", catalogues);
  const sciFi = movies.filter((genre) => genre.key === "sciencefiction");
  assert.equal(sciFi.length, 1);
  assert.deepEqual(sciFi[0], { key: "sciencefiction", name: "Science Fiction", tmdb_id: 878, providers: ["plex", "emby"], app_titles: 2 });
  const martial = movies.find((genre) => genre.key === "martialarts");
  assert.deepEqual(martial, { key: "martialarts", name: "Martial Arts", tmdb_id: null, providers: ["plex", "emby"], app_titles: 3 });
  assert.ok(movies.find((genre) => genre.name === "Western" && genre.tmdb_id === 37 && genre.app_titles === 0), "TMDB genres are listed with no library titles");
  assert.ok(!movies.some((genre) => genre.key === "sitcom"), "TV genres stay out of the Movies list");
  assert.deepEqual(movies.map((genre) => genre.name), [...movies.map((genre) => genre.name)].sort((a, b) => a.localeCompare(b)));

  const tv = playlistRuleGenres("tv", catalogues);
  assert.ok(tv.find((genre) => genre.key === "sitcom" && genre.providers.join() === "plex"));
  assert.ok(tv.find((genre) => genre.name === "Sci-Fi & Fantasy" && genre.tmdb_id === 10765));
  assert.ok(!tv.some((genre) => genre.key === "sciencefiction"), "no TV title carries plain Science Fiction here");
});

test("a show's episodes are read by its series id; a failed read throws, an empty one is an answer", async () => {
  const plex = fakeFetch({ "/library/metadata/77/allLeaves": { MediaContainer: { Metadata: [
    { parentIndex: 1, index: 2, title: "Two", originallyAvailableAt: "2020-01-08" },
    { parentIndex: 0, index: 1, title: "Special" },
    { parentIndex: 1, index: null, title: "No number" },
  ] } } });
  assert.deepEqual(await readLibrarySeriesEpisodes("plex", config.plex, "77", { fetchPlex: plex.fetch }), [
    { season: 1, episode: 2, title: "Two", overview: "", air_date: "2020-01-08" },
    { season: 0, episode: 1, title: "Special", overview: "", air_date: "" },
  ]);
  const jellyfin = fakeFetch({ "/Users/u/Items": { Items: [{ ParentIndexNumber: 2, IndexNumber: 1, Name: "Next", PremiereDate: "2021-02-03T00:00:00Z" }], TotalRecordCount: 1 } });
  assert.deepEqual(await readLibrarySeriesEpisodes("jellyfin", config.jellyfin, "s9", { fetchImpl: jellyfin.fetch }), [
    { season: 2, episode: 1, title: "Next", overview: "", air_date: "2021-02-03" },
  ]);
  assert.equal(jellyfin.calls[0].searchParams.get("parentId"), "s9");
  assert.equal(jellyfin.calls[0].searchParams.get("includeItemTypes"), "Episode");
  const empty = fakeFetch({ "/Users/u/Items": { Items: [], TotalRecordCount: 0 } });
  assert.deepEqual(await readLibrarySeriesEpisodes("emby", config.emby, "s1", { fetchImpl: empty.fetch }), []);
  assert.equal(empty.calls[0].searchParams.get("ParentId"), "s1");
  const failing = fakeFetch({ "/Users/u/Items": 500 });
  await assert.rejects(readLibrarySeriesEpisodes("emby", config.emby, "s1", { fetchImpl: failing.fetch }), (error) => error.status === 500);
});
