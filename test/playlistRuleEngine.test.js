import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";
import { fakeProvider } from "./playlistFakes.js";

makeTempDataDir("plembfin-playlist-rules-");

const { db } = await import("../server/src/db.js");
const { genreKey } = await import("../server/src/utils/playlistRuleCatalogue.js");
const {
  applyPlaylistRuleResult, checkDuePlaylistRules, checkPlaylistRule, confirmPlaylistRuleHold, discardPlaylistRuleHold,
  normalizePlaylistRule, readWatchIndex, stopPlaylistRule, RULE_CHECK_INTERVAL_MS,
} = await import("../server/src/utils/playlistRuleEngine.js");
const { pushPlaylist } = await import("../server/src/utils/playlistPushEngine.js");
const { syncPlaylist } = await import("../server/src/utils/playlistPullEngine.js");

const config = {
  plex: { baseUrl: "http://plex.test", token: "t" },
  emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "k", userId: "u" },
};
const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;

function catItem(provider, id, fields = {}) {
  const genres = fields.genres || [];
  return {
    provider,
    item_id: `${provider}-${id}`,
    media_type: fields.media_type || "movie",
    title: fields.title || `Title ${id}`,
    year: fields.year ?? 2000,
    release_date: fields.release_date ?? "",
    genres,
    genre_keys: genres.map(genreKey),
    added_at: fields.added_at ?? NOW - 400 * DAY,
    rating: fields.rating ?? null,
    ids: { tmdb: fields.tmdb ?? String(id), tvdb: "", imdb: fields.imdb ?? "" },
  };
}

function libraryDeps(catalogues, extra = {}) {
  return {
    readCatalogues: async (providers) => Object.fromEntries(providers.map((provider) => [provider, catalogues[provider] || { status: "not_configured" }])),
    now: () => NOW,
    ...extra,
  };
}

let counter = 0;
function createRuleList({ kind = "movie", rule, targets = [], items = [] } = {}) {
  const id = `rules-${++counter}`;
  db.prepare("INSERT INTO personal_lists (id, name, kind, rule_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(id, `Rules ${counter}`, kind, JSON.stringify(normalizePlaylistRule(rule, kind)));
  for (const provider of targets) {
    db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, ?, 1, 1)").run(id, provider);
  }
  items.forEach((key, position) => {
    db.prepare("INSERT INTO personal_list_items (list_id, media_key, media_type, title, position, created_at, updated_at) VALUES (?, ?, 'movie', ?, ?, 1, 1)")
      .run(id, key, key, position);
  });
  return id;
}

const titles = (listId) => db.prepare("SELECT title FROM personal_list_items WHERE list_id = ? ORDER BY position").all(listId).map((row) => row.title);
const listRow = (listId) => db.prepare("SELECT * FROM personal_lists WHERE id = ?").get(listId);

test("rules are validated: catalogue has a maximum and no recently added, genres must be TMDB's for it", () => {
  const rule = normalizePlaylistRule({ genres: ["Drama", "drama", " "] }, "movie");
  assert.deepEqual(rule, { source: "library", type: "top", genres: ["Drama"], genreMatch: "any", languages: [], yearFrom: null, yearTo: null, watched: "any", addedWithinDays: null, limit: null, order: "ranked" });
  assert.equal(normalizePlaylistRule({ source: "catalogue" }, "tv").limit, 20);
  assert.equal(normalizePlaylistRule({ type: "Trending" }, "movie").type, "trending");
  assert.throws(() => normalizePlaylistRule({ type: "hot" }, "movie"), /type must be one of top, popular, trending, new/);
  assert.throws(() => normalizePlaylistRule({ source: "catalogue", addedWithinDays: 7 }, "movie"), /only for playlists from your libraries/);
  assert.throws(() => normalizePlaylistRule({ source: "catalogue", genres: ["Anime"] }, "movie"), /Not a TMDB movie genre: Anime/);
  assert.equal(normalizePlaylistRule({ source: "catalogue", genres: ["Science Fiction"] }, "tv").genres[0], "Science Fiction");
  assert.throws(() => normalizePlaylistRule({ yearFrom: 2010, yearTo: 2000 }, "movie"), /yearFrom/);
  assert.throws(() => normalizePlaylistRule({}, "mixed"), /Movies or TV/);
  assert.throws(() => normalizePlaylistRule({ order: "loudest" }, "movie"), /order must be/);
});

test("library movies: union over apps, genre any and all, years, recently added, order, and maximum", async () => {
  const catalogues = {
    plex: { status: "ok", items: [
      catItem("plex", 1, { title: "Alpha", genres: ["Sci-Fi", "Drama"], year: 1999, rating: 8 }),
      catItem("plex", 2, { title: "Bravo", genres: ["Drama"], year: 2005, added_at: NOW - 2 * DAY, rating: 6 }),
      catItem("plex", 9, { title: "Show", media_type: "tv", genres: ["Drama"] }),
    ] },
    emby: { status: "ok", items: [
      catItem("emby", 1, { title: "Alpha", genres: ["Science Fiction"], year: 1999 }),
      catItem("emby", 3, { title: "Charlie", genres: ["science fiction"], year: 2012, added_at: NOW - DAY, rating: 9 }),
    ] },
    jellyfin: { status: "ok", items: [catItem("jellyfin", 1, { title: "Alpha", year: 1999 })] },
  };
  const deps = libraryDeps(catalogues);
  const check = async (rule, targets = ["plex", "emby"]) => {
    const id = createRuleList({ rule, targets });
    const result = await checkPlaylistRule(id, { config, deps });
    assert.notEqual(result.status, "error", result.error);
    return titles(id);
  };
  assert.deepEqual(await check({ genres: ["Science Fiction"] }), ["Charlie", "Alpha"]);
  assert.deepEqual(await check({ genres: ["Science Fiction", "Drama"], genreMatch: "all" }), ["Alpha"]);
  assert.deepEqual(await check({ genres: ["Drama", "Sci-Fi"], order: "oldest" }), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(await check({ yearFrom: 2000, yearTo: 2010 }), ["Bravo"]);
  assert.deepEqual(await check({ addedWithinDays: 3, order: "title" }), ["Bravo", "Charlie"]);
  assert.deepEqual(await check({ order: "rating", limit: 2 }), ["Charlie", "Alpha"]);
  // Only the playlist's own apps count.
  assert.deepEqual(await check({ order: "title" }, ["plex"]), ["Alpha", "Bravo"]);
  // A Plembfin-only playlist draws from every connected app (decision 50).
  assert.deepEqual(await check({ order: "title" }, []), ["Alpha", "Bravo", "Charlie"]);
});

test("a library title its app has not matched to any id is left out until it is", async () => {
  // Plex scanned a second Tenet file it has not matched yet, and a new unmatched Delta.
  const catalogues = {
    plex: { status: "ok", items: [
      catItem("plex", 1, { title: "Tenet", year: 2020 }),
      catItem("plex", 2, { title: "Tenet", year: 2020, tmdb: "" }),
      catItem("plex", 3, { title: "Delta", year: 2026, tmdb: "" }),
    ] },
    emby: { status: "ok", items: [catItem("emby", 1, { title: "Tenet", year: 2020 })] },
  };
  const id = createRuleList({ rule: { order: "title" }, targets: ["plex", "emby"] });
  const result = await checkPlaylistRule(id, { config, deps: libraryDeps(catalogues) });
  assert.notEqual(result.status, "error", result.error);
  assert.deepEqual(db.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ?").all(id).map((row) => row.media_key), ["movie:tmdb:1"]);
});

test("newest and oldest order by release date within a year, taking the date from any app", async () => {
  const catalogues = {
    plex: { status: "ok", items: [
      catItem("plex", 1, { title: "Anaconda", year: 2025, release_date: "2025-12-25" }),
      catItem("plex", 2, { title: "Black Phone 2", year: 2025, release_date: "2025-10-17" }),
      catItem("plex", 3, { title: "Zombie", year: 2025 }),
    ] },
    emby: { status: "ok", items: [catItem("emby", 3, { title: "Zombie", year: 2025, release_date: "2025-11-01" })] },
  };
  const deps = libraryDeps(catalogues);
  const id = createRuleList({ rule: { order: "newest" }, targets: ["plex", "emby"] });
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(id), ["Anaconda", "Zombie", "Black Phone 2"]);
  const oldest = createRuleList({ rule: { order: "oldest" }, targets: ["plex", "emby"] });
  await checkPlaylistRule(oldest, { config, deps });
  assert.deepEqual(titles(oldest), ["Black Phone 2", "Zombie", "Anaconda"]);
});

test("compound TV genres match their parts both ways", async () => {
  const catalogues = { plex: { status: "ok", items: [
    catItem("plex", 1, { title: "Compound", media_type: "tv", genres: ["Sci-Fi & Fantasy"] }),
    catItem("plex", 2, { title: "Fantasy Only", media_type: "tv", genres: ["Fantasy"] }),
    catItem("plex", 3, { title: "Drama Only", media_type: "tv", genres: ["Drama"] }),
  ] } };
  const seriesEpisodes = async () => [{ season: 1, episode: 1, title: "Pilot" }];
  const deps = libraryDeps(catalogues, { seriesEpisodes });
  const shows = async (genre) => {
    const id = createRuleList({ kind: "tv", rule: { genres: [genre], order: "title" }, targets: ["plex"] });
    await checkPlaylistRule(id, { config, deps });
    return db.prepare("SELECT show_title FROM personal_list_items WHERE list_id = ? ORDER BY position").all(id).map((row) => row.show_title);
  };
  assert.deepEqual(await shows("Science Fiction"), ["Compound"]);
  assert.deepEqual(await shows("Sci-Fi & Fantasy"), ["Compound", "Fantasy Only"]);
});

function watchEpisode(id, tmdb, season, episode, { at = "2026-09-20T10:00:00Z", action = "watched" } = {}) {
  db.prepare(`INSERT INTO watch_history (id, title, media_type, watched_at, tmdb_id, season, episode, sync_action, created_at, updated_at)
    VALUES (?, 'Show', 'episode', ?, ?, ?, ?, ?, 1, 1)`).run(id, at, String(tmdb), season, episode, action);
}

test("library TV holds each show's next episode; the maximum counts shows", async () => {
  const catalogues = {
    plex: { status: "ok", items: [
      catItem("plex", 10, { title: "One", media_type: "tv", year: 2020, rating: 9 }),
      catItem("plex", 11, { title: "Two", media_type: "tv", year: 2010 }),
      catItem("plex", 12, { title: "Three", media_type: "tv", year: 2005 }),
      catItem("plex", 13, { title: "Four", media_type: "tv", year: 2000 }),
    ] },
    jellyfin: { status: "ok", items: [catItem("jellyfin", 10, { title: "One", media_type: "tv", year: 2020 })] },
  };
  // Read by the series id each app's catalogue listed.
  const seriesEpisodes = async (_provider, _config, seriesId) => ({
    "plex-10": [{ season: 0, episode: 1, title: "Special" }, { season: 1, episode: 2, title: "B" }, { season: 1, episode: 1, title: "A" }],
    "jellyfin-10": [{ season: 1, episode: 3, title: "C" }, { season: 1, episode: 1, title: "A (Jellyfin)" }],
    "plex-11": [{ season: 1, episode: 1, title: "Z" }],
    "plex-12": [{ season: 1, episode: 1, title: "Done" }],
    "plex-13": [{ season: 1, episode: 1, title: "Aired", air_date: "2026-01-01" }, { season: 1, episode: 2, title: "Future", air_date: "2026-12-01" }],
  })[seriesId];
  const deps = libraryDeps(catalogues, { seriesEpisodes });
  // Never watched gives the first episode, specials left out. Top rated picks
  // the best rated show.
  const limited = createRuleList({ kind: "tv", rule: { limit: 1 }, targets: ["plex", "jellyfin"] });
  await checkPlaylistRule(limited, { config, deps });
  assert.deepEqual(titles(limited), ["A"]);
  const id = createRuleList({ kind: "tv", rule: { order: "newest" }, targets: ["plex", "jellyfin"] });
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(id), ["A", "Z", "Done", "Aired"]);

  // The episode after the furthest watched; fully watched shows and shows
  // whose next episode has not aired are left out.
  watchEpisode("w-ep", 10, 1, 1);
  watchEpisode("w-ep-12", 12, 1, 1);
  watchEpisode("w-ep-13", 13, 1, 1);
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(id), ["B", "Z"]);
  watchEpisode("w-ep-10-3", 10, 1, 3);
  await checkPlaylistRule(id, { config, deps });
  // Earlier gaps are ignored: S1E3 watched means One is done.
  assert.deepEqual(titles(id), ["Z"]);
  // TV rules ignore the Watched choice (decision 54).
  assert.equal(normalizePlaylistRule({ watched: "unwatched" }, "tv").watched, "any");
  db.prepare("DELETE FROM watch_history WHERE id = 'w-ep-10-3'").run();
});

test("moving each show on to its next episode is not held for Confirm", async () => {
  const catalogues = { plex: { status: "ok", items: [20, 21, 22].map((tmdb) => catItem("plex", tmdb, { title: `S${tmdb}`, media_type: "tv" })) } };
  const seriesEpisodes = async (_provider, _config, seriesId) => [
    { season: 1, episode: 1, title: `${seriesId} E1` }, { season: 1, episode: 2, title: `${seriesId} E2` },
  ];
  const deps = libraryDeps(catalogues, { seriesEpisodes });
  const id = createRuleList({ kind: "tv", rule: { order: "title" }, targets: ["plex"] });
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(id), ["plex-20 E1", "plex-21 E1", "plex-22 E1"]);
  for (const tmdb of [20, 21, 22]) watchEpisode(`w-move-${tmdb}`, tmdb, 1, 1);
  const result = await checkPlaylistRule(id, { config, deps });
  assert.equal(result.status, "changed");
  assert.deepEqual(titles(id), ["plex-20 E2", "plex-21 E2", "plex-22 E2"]);
});

test("watch index: the latest trusted row decides", () => {
  db.prepare(`INSERT INTO watch_history (id, title, media_type, watched_at, tmdb_id, sync_action, created_at, updated_at) VALUES
    ('m1', 'M', 'movie', '2026-01-01T00:00:00Z', '501', 'watched', 1, 1),
    ('m2', 'M', 'movie', '2026-02-01T00:00:00Z', '501', 'unwatched', 1, 1),
    ('m3', 'N', 'movie', '2026-01-01T00:00:00Z', '502', 'watched', 1, 1)`).run();
  const index = readWatchIndex();
  assert.equal(index.movie({ tmdb: "501" }), false);
  assert.equal(index.movie({ tmdb: "502" }), true);
  assert.equal(index.movie({ tmdb: "503" }), false);
  assert.equal(index.episode({ tmdb: "10" }, 1, 1), true);
});

test("random order is fixed per playlist and survives a re-check", async () => {
  const items = Array.from({ length: 12 }, (_, index) => catItem("plex", 100 + index, { title: `R${index}` }));
  const deps = libraryDeps({ plex: { status: "ok", items } });
  const id = createRuleList({ rule: { order: "random", limit: 5 }, targets: ["plex"] });
  await checkPlaylistRule(id, { config, deps });
  const first = titles(id);
  assert.equal(first.length, 5);
  await checkPlaylistRule(id, { config, deps });
  assert.deepEqual(titles(id), first);
  assert.equal(listRow(id).rule_hold_json, null);
});

test("a failed or empty read leaves the items untouched and records why", async () => {
  const id = createRuleList({ rule: {}, targets: ["plex", "emby"], items: ["keep-1", "keep-2"] });
  let result = await checkPlaylistRule(id, { config, deps: libraryDeps({ plex: { status: "ok", items: [catItem("plex", 1)] }, emby: { status: "error", error: "timeout" } }) });
  assert.equal(result.status, "error");
  assert.deepEqual(titles(id), ["keep-1", "keep-2"]);
  assert.match(listRow(id).rule_error, /emby library could not be read: timeout/);
  result = await checkPlaylistRule(id, { config, deps: libraryDeps({ plex: { status: "ok", items: [] }, emby: { status: "ok", items: [catItem("emby", 1)] } }) });
  assert.match(result.error, /plex library read came back empty/);
  const tv = createRuleList({ kind: "tv", rule: {}, targets: ["plex"], items: ["keep-3"] });
  const tvDeps = (seriesEpisodes) => libraryDeps({ plex: { status: "ok", items: [catItem("plex", 5, { media_type: "tv" })] } }, { seriesEpisodes });
  result = await checkPlaylistRule(tv, { config, deps: tvDeps(async () => { throw new Error("Plex series 5 episodes read failed with status 500"); }) });
  assert.match(result.error, /status 500/);
  assert.deepEqual(titles(tv), ["keep-3"]);
  // A definite empty answer (a show folder with no episodes) leaves that show out.
  result = await checkPlaylistRule(tv, { config, deps: tvDeps(async () => []) });
  assert.equal(result.status, "changed");
  assert.deepEqual(titles(tv), []);
  // A catalogue show whose episodes TMDB cannot resolve (404) is left out; other failures fail the check.
  const catalogueTv = createRuleList({ kind: "tv", rule: { source: "catalogue", limit: 2 }, items: ["keep-4"] });
  const catalogueDeps = (showNextEpisode) => ({
    now: () => NOW,
    discoverPage: async () => ({ total_pages: 1, results: [{ id: 90, name: "New Show" }, { id: 91, name: "Old Show" }] }),
    showNextEpisode,
  });
  result = await checkPlaylistRule(catalogueTv, { config, deps: catalogueDeps(async () => { throw Object.assign(new Error("timeout"), { status: 504 }); }) });
  assert.equal(result.status, "error");
  assert.deepEqual(titles(catalogueTv), ["keep-4"]);
  result = await checkPlaylistRule(catalogueTv, { config, deps: catalogueDeps(async (show) => {
    if (show.tmdb_id === "90") throw Object.assign(new Error("Could not resolve TVDB ID"), { status: 404 });
    return { season: 1, episode: 1, title: "Old Pilot" };
  }) });
  assert.deepEqual(titles(catalogueTv), ["Old Pilot"]);
});

test("a check removing many items is held whole; Confirm applies it and Discard keeps the items", async () => {
  const id = createRuleList({ rule: { order: "title" }, targets: ["plex"], items: ["old-1", "old-2", "old-3", "old-4"] });
  const deps = libraryDeps({ plex: { status: "ok", items: [catItem("plex", 1, { title: "New" })] } });
  let result = await checkPlaylistRule(id, { config, deps });
  assert.equal(result.status, "held");
  // The whole update waits: nothing added either (decision 47).
  assert.deepEqual(titles(id), ["old-1", "old-2", "old-3", "old-4"]);
  assert.equal(JSON.parse(listRow(id).rule_hold_json).removal_count, 4);

  assert.equal(discardPlaylistRuleHold(id), true);
  assert.equal(listRow(id).rule_hold_json, null);
  assert.deepEqual(titles(id), ["old-1", "old-2", "old-3", "old-4"]);
  // The next check asks again (decision 48).
  assert.equal((await checkPlaylistRule(id, { config, deps })).status, "held");

  assert.equal(confirmPlaylistRuleHold(id), true);
  result = await checkPlaylistRule(id, { config, deps });
  assert.equal(result.status, "changed");
  assert.deepEqual(titles(id), ["New"]);
  assert.equal(listRow(id).rule_hold_json, null);
  assert.equal(confirmPlaylistRuleHold(id), false);
});

test("a small removal applies at once", () => {
  const id = createRuleList({ rule: {}, items: ["a", "b", "c", "d"] });
  const row = (key) => ({ media_key: key, media_type: "movie", title: key, tmdb_id: "", tvdb_id: "", imdb_id: "", overview: "", release_date: "", show_title: null, season: null, episode: null, poster_url: "" });
  const result = applyPlaylistRuleResult(id, [row("d"), row("a"), row("e")], NOW);
  assert.equal(result.status, "changed");
  assert.deepEqual(titles(id), ["d", "a", "e"]);
});

test("catalogue source pages TMDB Discover with the rule's filters", async () => {
  const requests = [];
  const page = (number, ids) => ({ page: number, total_pages: 3, results: ids.map((id) => ({ id, title: `T${id}`, release_date: "2001-05-05", genre_ids: [878], vote_average: 7, poster_path: `/p${id}.jpg` })) });
  const deps = {
    now: () => NOW,
    discoverPage: async ({ mediaType, params }) => {
      requests.push({ mediaType, params });
      return params.page === 1 ? page(1, [1, 2, 502]) : page(params.page, [3, 4]);
    },
  };
  const id = createRuleList({ rule: { source: "catalogue", genres: ["Sci-Fi"], yearFrom: 2000, limit: 3, watched: "unwatched" } });
  const result = await checkPlaylistRule(id, { config, deps });
  assert.equal(result.status, "changed");
  // 502 is watched (see the watch index test), so it is skipped.
  assert.deepEqual(titles(id), ["T1", "T2", "T3"]);
  // A movie with no cached poster shows TMDB's.
  const poster = () => db.prepare("SELECT poster_url FROM personal_list_items WHERE list_id = ? AND title = 'T1'").get(id).poster_url;
  assert.equal(poster(), "https://image.tmdb.org/t/p/w342/p1.jpg");
  // An item stored before without a poster gets one at the next check.
  db.prepare("UPDATE personal_list_items SET poster_url = '' WHERE list_id = ?").run(id);
  await checkPlaylistRule(id, { config, deps });
  assert.equal(poster(), "https://image.tmdb.org/t/p/w342/p1.jpg");
  requests.length = 2;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].mediaType, "movie");
  // Top rated (the default type) ranks by rating with enough votes.
  assert.deepEqual({ ...requests[0].params }, {
    sort_by: "vote_average.desc", "vote_count.gte": 500, with_genres: "878", "primary_release_date.gte": "2000-01-01", "primary_release_date.lte": "2026-09-26", page: 1,
  });

  const tvRequests = [];
  const tv = createRuleList({ kind: "tv", rule: { source: "catalogue", genres: ["Science Fiction", "Drama"], genreMatch: "all", order: "title", limit: 1 } });
  await checkPlaylistRule(tv, { config, deps: {
    now: () => NOW,
    discoverPage: async ({ params }) => { tvRequests.push(params); return { total_pages: 1, results: [{ id: 77, name: "Space", genre_ids: [10765, 18] }, { id: 78, name: "Only Drama", genre_ids: [18] }] }; },
    showNextEpisode: async () => ({ season: 1, episode: 1, title: "Launch" }),
  } });
  // "Science Fiction" is TMDB TV's compound genre (decision 46); "all" joins with ",".
  assert.equal(tvRequests[0].with_genres, "10765,18");
  assert.equal(tvRequests[0].sort_by, "vote_average.desc");
  assert.deepEqual(titles(tv), ["Launch"]);
});

test("catalogue types: each asks TMDB for its list, and the picked titles are re-sorted by the order", async () => {
  const requests = [];
  const result = (id, fields = {}) => {
    const name = fields.title || `K${id}`;
    const date = fields.release_date || "2026-09-01";
    return { id, title: name, name, release_date: date, first_air_date: date, genre_ids: fields.genre_ids || [18] };
  };
  const deps = {
    now: () => NOW,
    discoverPage: async ({ mediaType, params }) => { requests.push({ mediaType, params }); return { total_pages: 1, results: [result(701), result(702), result(703)] }; },
    trendingPage: async ({ mediaType, page }) => {
      requests.push({ mediaType, trending: page });
      return { total_pages: 1, results: [
        result(711, { title: "Zed" }), result(712, { genre_ids: [35] }), result(713, { release_date: "2026-12-01" }), result(714, { title: "Abe" }), result(715, { title: "Mo" }),
      ] };
    },
  };
  const check = async (rule, kind = "movie") => {
    requests.length = 0;
    const id = createRuleList({ kind, rule: { source: "catalogue", genres: ["Drama"], ...rule } });
    const outcome = await checkPlaylistRule(id, { config, deps: { ...deps, showNextEpisode: async (show) => ({ season: 1, episode: 1, title: `${show.title} E1` }) } });
    assert.notEqual(outcome.status, "error", outcome.error);
    return titles(id);
  };
  await check({ type: "popular" });
  assert.equal(requests[0].params.sort_by, "popularity.desc");
  assert.equal(requests[0].params["vote_count.gte"], undefined);
  await check({ type: "new" });
  assert.deepEqual({ ...requests[0].params }, {
    sort_by: "popularity.desc", with_genres: "18", with_release_type: "2|3", "primary_release_date.gte": "2026-08-15", "primary_release_date.lte": "2026-09-26", page: 1,
  });
  await check({ type: "new" }, "tv");
  assert.equal(requests[0].params["air_date.gte"], "2026-09-26");
  assert.equal(requests[0].params["air_date.lte"], "2026-10-03");
  // TV leaves out Talk and News unless the rule asks for them (decision 73).
  assert.equal(requests[0].params.without_genres, "10767,10763");
  await check({ type: "popular", genres: ["Talk"] }, "tv");
  assert.equal(requests[0].params.without_genres, "10763");
  await check({ type: "popular" });
  assert.equal(requests[0].params.without_genres, undefined, "movies leave nothing out");
  // Trending takes no filters: genre and unreleased titles are filtered here.
  // The first 2 in trending rank are picked, then sorted by title.
  assert.deepEqual(await check({ type: "trending", limit: 2 }), ["Zed", "Abe"]);
  assert.deepEqual(requests, [{ mediaType: "movie", trending: 1 }]);
  assert.deepEqual(await check({ type: "trending", limit: 2, order: "title" }), ["Abe", "Zed"]);
  assert.deepEqual(await check({ type: "trending", limit: 2, order: "title" }, "tv"), ["Abe E1", "Zed E1"]);

  // Trending takes no filters, so a talk show is left out here, and a library
  // talk show too.
  const talkId = createRuleList({ kind: "tv", rule: { source: "catalogue", type: "trending", limit: 5 } });
  await checkPlaylistRule(talkId, { config, deps: {
    now: () => NOW,
    trendingPage: async () => ({ total_pages: 1, results: [{ id: 721, name: "Late Show", first_air_date: "2015-09-08", genre_ids: [10767] }, { id: 722, name: "Drama Show", first_air_date: "2020-01-01", genre_ids: [18] }] }),
    showNextEpisode: async (show) => ({ season: 1, episode: 1, title: `${show.title} E1` }),
  } });
  assert.deepEqual(titles(talkId), ["Drama Show E1"]);
  const libraryTalk = createRuleList({ kind: "tv", rule: { order: "title" }, targets: ["plex"] });
  await checkPlaylistRule(libraryTalk, { config, deps: libraryDeps({ plex: { status: "ok", items: [
    catItem("plex", 731, { title: "Chat", media_type: "tv", genres: ["Talk"] }),
    catItem("plex", 732, { title: "Story", media_type: "tv", genres: ["Drama"] }),
  ] } }, { seriesEpisodes: async (_provider, _config, seriesId) => [{ season: 1, episode: 1, title: `${seriesId} E1` }] }) });
  assert.deepEqual(titles(libraryTalk), ["plex-732 E1"]);
});

test("library types: Top by the apps' rating; the others keep your titles on the TMDB list, in its rank", async () => {
  const catalogues = { plex: { status: "ok", items: [
    catItem("plex", 801, { title: "Low", rating: 5 }),
    catItem("plex", 802, { title: "High", rating: 9 }),
    catItem("plex", 803, { title: "Unrated" }),
    catItem("plex", 804, { title: "No Tmdb", tmdb: "", imdb: "tt804", rating: 10 }),
  ] } };
  const trendingRequests = [];
  const deps = libraryDeps(catalogues, {
    trendingPage: async ({ page }) => {
      trendingRequests.push(page);
      return { total_pages: 2, results: page === 1 ? [{ id: 999 }, { id: 803 }] : [{ id: 801 }, { id: 802 }] };
    },
    discoverPage: async ({ params }) => ({ total_pages: 1, results: [{ id: 802 }, { id: 801 }], params }),
  });
  const check = async (rule) => {
    const id = createRuleList({ rule, targets: ["plex"] });
    await checkPlaylistRule(id, { config, deps });
    return titles(id);
  };
  assert.deepEqual(await check({ type: "top" }), ["No Tmdb", "High", "Low", "Unrated"]);
  assert.deepEqual(await check({ type: "top", limit: 2, order: "title" }), ["High", "No Tmdb"]);
  // A title with no TMDB id cannot be found on a TMDB list.
  assert.deepEqual(await check({ type: "trending" }), ["Unrated", "Low", "High"]);
  // Paging stops once the maximum is reached.
  trendingRequests.length = 0;
  assert.deepEqual(await check({ type: "trending", limit: 1 }), ["Unrated"]);
  assert.deepEqual(trendingRequests, [1]);
  assert.deepEqual(await check({ type: "popular" }), ["High", "Low"]);
});

test("languages: validated, and library and catalogue rules keep only the chosen original languages", async () => {
  assert.deepEqual(normalizePlaylistRule({ languages: ["EN", "ko", "en"] }, "movie").languages, ["en", "ko"]);
  assert.deepEqual(normalizePlaylistRule({}, "tv").languages, []);
  assert.throws(() => normalizePlaylistRule({ languages: ["english"] }, "movie"), /Not a language code: english/);

  const catalogues = { plex: { status: "ok", items: [catItem("plex", 601), catItem("plex", 602), catItem("plex", 603), catItem("plex", 604)] } };
  const languageOf = { 601: "en", 602: "ko", 603: "", 604: "ja" };
  const asked = [];
  const deps = libraryDeps(catalogues, { titleLanguages: async (mediaType, list) => { asked.push(mediaType); return list.map((title) => languageOf[title.ids.tmdb]); } });
  const chosen = createRuleList({ rule: { languages: ["en", "ko"], order: "title" }, targets: ["plex"] });
  await checkPlaylistRule(chosen, { config, deps });
  // 603's language is unknown, so it is left out (decision 62).
  assert.deepEqual(titles(chosen), ["Title 601", "Title 602"]);
  assert.deepEqual(asked, ["movie"]);

  asked.length = 0;
  const any = createRuleList({ rule: { order: "title" }, targets: ["plex"] });
  await checkPlaylistRule(any, { config, deps });
  assert.equal(titles(any).length, 4, "no language ticked keeps every title");
  assert.deepEqual(asked, [], "no lookup when any language will do");

  // A rule saved before the Language choice has no languages key.
  const old = createRuleList({ rule: { order: "title" }, targets: ["plex"] });
  const rule = JSON.parse(listRow(old).rule_json);
  delete rule.languages;
  db.prepare("UPDATE personal_lists SET rule_json = ? WHERE id = ?").run(JSON.stringify(rule), old);
  await checkPlaylistRule(old, { config, deps });
  assert.equal(titles(old).length, 4);

  const requests = [];
  const catalogue = createRuleList({ rule: { source: "catalogue", languages: ["en", "ko"], order: "title", limit: 5 } });
  await checkPlaylistRule(catalogue, { config, deps: {
    now: () => NOW,
    discoverPage: async ({ params }) => {
      requests.push(params);
      return { total_pages: 1, results: [{ id: 611, title: "Kept", original_language: "en" }, { id: 612, title: "French", original_language: "fr" }, { id: 613, title: "Korean", original_language: "ko" }] };
    },
  } });
  assert.equal(requests[0].with_original_language, "en|ko");
  assert.deepEqual(titles(catalogue), ["Kept", "Korean"], "a result in another language is filtered out here too");
});

test("title languages come from the metadata cache; only uncached titles are looked up", async () => {
  const { readTitleLanguages } = await import("../server/src/utils/playlistLanguages.js");
  const insert = db.prepare("INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, details, original_language, updated_at_ms) VALUES (?, ?, ?, ?, ?, 1)");
  insert.run("movie_701", "701", "movie", JSON.stringify({ original_language: "en" }), "en");
  // A row restored from an old backup has only the blob.
  insert.run("movie_702", "702", "movie", JSON.stringify({ original_language: "ko" }), null);
  // Cached details that list no language are not looked up again.
  insert.run("tv_tvdb_900", null, "tv", JSON.stringify({ name: "TVDB only" }), null);
  const looked = [];
  const getDetails = async (request) => {
    looked.push(request.tmdbId || request.title);
    assert.equal(request.lane, "sync");
    assert.equal(request.light, true);
    if (request.tmdbId === "704") throw Object.assign(new Error("not found"), { status: 404 });
    return { original_language: "JA" };
  };
  const movies = [701, 702, 703, 704].map((id) => ({ title: `M${id}`, ids: { tmdb: String(id), tvdb: "", imdb: "" } }));
  assert.deepEqual(await readTitleLanguages("movie", movies, { getDetails }), ["en", "ko", "ja", ""]);
  assert.deepEqual(looked, ["703", "704"]);
  assert.deepEqual(await readTitleLanguages("tv", [{ title: "TVDB only", ids: { tmdb: "", tvdb: "900", imdb: "" } }], { getDetails }), [""]);
  assert.equal(looked.length, 2);
  await assert.rejects(
    readTitleLanguages("movie", [{ title: "M705", ids: { tmdb: "705" } }], { getDetails: async () => { throw Object.assign(new Error("TMDB down"), { status: 503 }); } }),
    /TMDB down/,
    "any other failed lookup fails the check",
  );
});

test("only automatic playlists due an hourly check are checked", async () => {
  db.prepare("UPDATE personal_lists SET rule_checked_at = ? WHERE rule_json IS NOT NULL").run(NOW);
  // Earlier tests' watched shows move on once here, not again below (decision 68).
  await checkDuePlaylistRules({ config, deps: libraryDeps({ plex: { status: "ok", items: [] } }), now: NOW + 1 });
  const due = createRuleList({ rule: {}, targets: ["plex"] });
  const checked = [];
  const deps = libraryDeps({ plex: { status: "ok", items: [catItem("plex", 1)] } }, { readCatalogues: async () => { checked.push(true); return { plex: { status: "ok", items: [catItem("plex", 1)] } }; } });
  let results = await checkDuePlaylistRules({ config, deps, now: NOW + 1 });
  assert.deepEqual(results.map((entry) => entry.listId), [due]);
  results = await checkDuePlaylistRules({ config, deps, now: NOW + RULE_CHECK_INTERVAL_MS });
  assert.equal(results.length, db.prepare("SELECT COUNT(*) AS count FROM personal_lists WHERE rule_json IS NOT NULL AND deleted_at IS NULL").get().count);
  assert.ok(checked.length >= 2);
});

// --- One way out, and Stop updating ------------------------------------------

function syncSetup() {
  const plex = fakeProvider("plex");
  const deps = {
    client: () => plex.client,
    resolveItemId: async (_provider, _config, row) => ({ "movie:tmdb:1": "p1", "movie:tmdb:2": "p2", "movie:tmdb:3": "p3" })[row.media_key] || "",
    identifyEntry: async (_provider, _config, entry) => ({ media_type: "movie", title: entry.itemId, tmdb_id: entry.itemId.slice(1) }),
  };
  return { plex, deps };
}

test("an automatic playlist with a lost ledger preserves remote entries", async () => {
  const { plex, deps } = syncSetup();
  const id = createRuleList({ rule: {}, targets: ["plex"] });
  applyPlaylistRuleResult(id, [{ media_key: "movie:tmdb:1", media_type: "movie", title: "M1", tmdb_id: "1", tvdb_id: "", imdb_id: "", overview: "", release_date: "", show_title: null, season: null, episode: null, poster_url: "" }], NOW);
  await syncPlaylist(id, { config, deps });
  const playlistId = db.prepare("SELECT remote_playlist_id FROM personal_list_targets WHERE list_id = ? AND provider = 'plex'").get(id).remote_playlist_id;
  const remote = plex.state.playlists.get(playlistId);
  remote.entries.push({ entryId: "untracked", itemId: "p3" });
  db.prepare("DELETE FROM personal_list_entry_ledger WHERE list_id = ?").run(id);
  await syncPlaylist(id, { config, deps });
  assert.ok(remote.entries.some(entry => entry.itemId === "p3"));
});

test("an automatic playlist is synced one way out: app edits are overwritten, a rename comes back", async () => {
  const { plex, deps } = syncSetup();
  const id = createRuleList({ rule: {}, targets: ["plex"] });
  const rows = [1, 2].map((tmdb) => ({ media_key: `movie:tmdb:${tmdb}`, media_type: "movie", title: `M${tmdb}`, tmdb_id: String(tmdb), tvdb_id: "", imdb_id: "", overview: "", release_date: "", show_title: null, season: null, episode: null, poster_url: "" }));
  assert.equal(applyPlaylistRuleResult(id, rows, NOW).status, "changed");
  await syncPlaylist(id, { config, deps });
  const playlistId = db.prepare("SELECT remote_playlist_id FROM personal_list_targets WHERE list_id = ?").get(id).remote_playlist_id;
  const remote = () => plex.state.playlists.get(playlistId);
  assert.deepEqual(remote().entries.map((entry) => entry.itemId), ["p1", "p2"]);

  // In the app: add p3, remove p1, rename.
  remote().entries.push({ entryId: "plex-extra", itemId: "p3" });
  remote().entries = remote().entries.filter((entry) => entry.itemId !== "p1");
  remote().title = "Renamed In App";
  await syncPlaylist(id, { config, deps });
  assert.deepEqual(remote().entries.map((entry) => entry.itemId), ["p1", "p2"]);
  assert.deepEqual(titles(id), ["M1", "M2"]);
  assert.equal(listRow(id).name, "Renamed In App");
  const ledger = db.prepare("SELECT provider_item_id FROM personal_list_entry_ledger WHERE list_id = ? ORDER BY remote_position").all(id).map((row) => row.provider_item_id);
  assert.deepEqual(ledger, ["p1", "p2"]);

  // Stop updating: an app edit made while automatic is overwritten by the
  // last push and never imported; later edits import as for a manual playlist.
  remote().entries.push({ entryId: "plex-while-auto", itemId: "p3" });
  const stopped = await stopPlaylistRule(id, { config, deps });
  assert.equal(stopped.status, "stopped");
  assert.equal(listRow(id).rule_json, null);
  assert.deepEqual(remote().entries.map((entry) => entry.itemId), ["p1", "p2"]);
  remote().entries.push({ entryId: "plex-after", itemId: "p3" });
  await syncPlaylist(id, { config, deps });
  assert.deepEqual(titles(id).length, 3);
  assert.equal((await stopPlaylistRule(id, { config, deps })).status, "not_automatic");
});

test("a manual playlist still keeps an app entry it does not know (two-way)", async () => {
  const { plex, deps } = syncSetup();
  const id = `manual-${++counter}`;
  db.prepare("INSERT INTO personal_lists (id, name, kind, created_at, updated_at) VALUES (?, ?, 'movie', 1, 1)").run(id, `Manual ${counter}`);
  db.prepare("INSERT INTO personal_list_targets (list_id, provider, created_at, updated_at) VALUES (?, 'plex', 1, 1)").run(id);
  db.prepare("INSERT INTO personal_list_items (list_id, media_key, media_type, title, tmdb_id, position, created_at, updated_at) VALUES (?, 'movie:tmdb:1', 'movie', 'M1', '1', 0, 1, 1)").run(id);
  await pushPlaylist(id, { config, deps });
  const playlistId = db.prepare("SELECT remote_playlist_id FROM personal_list_targets WHERE list_id = ?").get(id).remote_playlist_id;
  plex.state.playlists.get(playlistId).entries.push({ entryId: "plex-unknown", itemId: "p9" });
  await pushPlaylist(id, { config, deps });
  assert.deepEqual(plex.state.playlists.get(playlistId).entries.map((entry) => entry.itemId), ["p1", "p9"]);
});
