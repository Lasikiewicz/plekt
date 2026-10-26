import test from "node:test";
import assert from "node:assert/strict";
import { calendarFeedTokenMatches, createCalendarFeedToken, getCalendarFeed, getCalendarFeedSettings, isPublicCalendarOrigin, normalizeCalendarFeedTypes, regenerateCalendarFeedToken, serializeCalendarFeed } from "../server/src/utils/calendarFeed.js";

test("calendar feed tokens are high entropy and compared exactly", () => {
  const token = createCalendarFeedToken();
  assert.ok(token.length >= 40);
  assert.equal(calendarFeedTokenMatches(token, token), true);
  assert.equal(calendarFeedTokenMatches(token, `${token}x`), false);
  assert.equal(calendarFeedTokenMatches(token, ""), false);
});

test("calendar subscribe URLs are hidden for local origins and accepted for public origins", async () => {
  for (const localOrigin of [
    "http://localhost:5056",
    "http://plekt.local",
    "http://192.168.1.20:5056",
    "http://10.0.0.4",
    "http://[fd12::1]",
    "https://203.0.113.20",
  ]) {
    assert.equal(isPublicCalendarOrigin(localOrigin), false, localOrigin);
    assert.equal((await getCalendarFeedSettings(localOrigin)).url, "", localOrigin);
  }
  assert.equal(isPublicCalendarOrigin("https://calendar.example.net"), true);
});

test("regenerating the feed token immediately replaces the old subscription URL", async () => {
  const first = await regenerateCalendarFeedToken();
  const firstSettings = await getCalendarFeedSettings("https://plekt.example.net");
  assert.equal(new URL(firstSettings.url).searchParams.get("token"), first);
  assert.deepEqual(firstSettings.types, ["tv", "movies"]);
  const second = await regenerateCalendarFeedToken();
  const secondSettings = await getCalendarFeedSettings("https://plekt.example.net");
  assert.notEqual(second, first);
  assert.equal(new URL(secondSettings.url).searchParams.get("token"), second);
  assert.equal(calendarFeedTokenMatches(second, first), false);
});

test("a valid token returns only upcoming library episode and movie releases", async () => {
  const token = await regenerateCalendarFeedToken(["tv", "movies"]);
  const feed = await getCalendarFeed(token, {
    now: new Date("2026-10-25T12:00:00Z"),
    upcomingMonth: async (month) => ({ episodes: month === "2026-11" ? [
      { airDate: "2026-11-02", showTitle: "Library Show", season: 1, episode: 3, episodeTitle: "Next", tmdbId: "8" },
      { airDate: "2026-10-01", showTitle: "Library Show", season: 1, episode: 2, episodeTitle: "Past", tmdbId: "8" },
    ] : [] }),
    listMovies: async () => [
      { title: "Library Film", tmdb_id: "9", release_date: "2026-11-03" },
      { title: "Released Film", tmdb_id: "10", release_date: "2026-10-01" },
    ],
    cachedMovieDetails: () => null,
  });
  assert.deepEqual(feed.episodes.map((item) => item.episodeTitle), ["Next"]);
  assert.deepEqual(feed.movies.map((item) => item.title), ["Library Film"]);
});

test("calendar feed content follows the types saved when its URL is generated", async () => {
  let monthCalls = 0;
  let movieCalls = 0;
  const upcomingMonth = async (month) => {
    monthCalls += 1;
    return { episodes: month === "2026-11" ? [
      { airDate: "2026-11-02", showTitle: "Library Show", season: 1, episode: 3, tmdbId: "8" },
    ] : [] };
  };
  const listMovies = async () => {
    movieCalls += 1;
    return [{ title: "Library Film", tmdb_id: "9", release_date: "2026-11-03" }];
  };
  const now = new Date("2026-10-25T12:00:00Z");

  const tvToken = await regenerateCalendarFeedToken(["tv"]);
  const tvFeed = await getCalendarFeed(tvToken, { now, upcomingMonth, listMovies });
  assert.equal(tvFeed.episodes.length, 1);
  assert.deepEqual(tvFeed.movies, []);
  assert.equal(movieCalls, 0);
  assert.deepEqual((await getCalendarFeedSettings("https://plekt.example.net")).types, ["tv"]);

  monthCalls = 0;
  const movieToken = await regenerateCalendarFeedToken(["movies"]);
  const movieFeed = await getCalendarFeed(movieToken, { now, upcomingMonth, listMovies });
  assert.deepEqual(movieFeed.episodes, []);
  assert.equal(movieFeed.movies.length, 1);
  assert.equal(monthCalls, 0);
  assert.equal(movieCalls, 1);
  assert.deepEqual((await getCalendarFeedSettings("https://plekt.example.net")).types, ["movies"]);
});

test("calendar feed selection accepts only movies, TV shows, or both", async () => {
  assert.deepEqual(normalizeCalendarFeedTypes(["movies", "tv", "movies", "other"]), ["tv", "movies"]);
  assert.deepEqual(normalizeCalendarFeedTypes([]), []);
  await assert.rejects(() => regenerateCalendarFeedToken([]), /Select movies, TV shows or both/);
});

test("calendar feed serializes upcoming episodes and movies as all-day events", () => {
  const ics = serializeCalendarFeed({
    episodes: [{ airDate: "2026-11-02", showTitle: "A, Show", season: 2, episode: 4, episodeTitle: "Part; One", tmdbId: "9" }],
    movies: [{ date: "2026-11-03", title: "Film\\Name", tmdbId: "10" }],
  }, { now: new Date("2026-10-25T12:00:00Z") });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261102/);
  assert.match(ics, /SUMMARY:A\\, Show S02E04 - Part\\; One/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261103/);
  assert.match(ics, /SUMMARY:Film\\\\Name/);
  assert.match(ics, /END:VCALENDAR/);
});
