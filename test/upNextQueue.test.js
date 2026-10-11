import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-queue-");
const { buildUpNextProjection, publicUpNextItems } = await import("../server/src/utils/upNextService.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { saveCanonicalPoster } = await import("../server/src/utils/mediaArtwork.js");
const { recordUpNextRailSeeds } = await import("../server/src/utils/upNextSeedLedger.js");
const { removeManualUpNextShow, upsertManualUpNextShow } = await import("../server/src/utils/upNextManual.js");
const { withUpNextFeedSeriesIdentity } = await import("../server/src/utils/upNextRepository.js");

test("queue projection keeps canonical resumes first and provider next-up after them", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "The Expanse", tmdb_id: "123", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [{
      media_key: "movie:tmdb:10",
      media_type: "movie",
      title: "A Part-Watched Movie",
      tmdb_id: "10",
      position_ms: 300000,
      duration_ms: 1200000,
      progress: 25,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "episode-next",
      media_type: "episode",
      title: "The Expanse - S02E05",
      show_title: "The Expanse",
      episode_title: "Home",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      air_date: "2017-02-01",
    }],
  });

  assert.deepEqual(projection.items.map((item) => item.queue_kind), ["resume", "next_up"]);
  assert.equal(projection.items[0].media_type, "movie");
  assert.equal(projection.items[0].progress, 25);
  assert.equal(projection.items[1].media_type, "episode");
  assert.equal(projection.items[1].progress, 0);
  assert.deepEqual(projection.items[1].provider_items, { jellyfin: ["episode-next"] });
});

test("Jellyfin observations take part in the Up Next projection", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "Jellyfin Show", tmdb_id: "5150", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-next",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "5150" },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Jellyfin Show");
  assert.equal(projection.items[0].queue_kind, "next_up");
  assert.deepEqual(projection.items[0].provider_items, { jellyfin: ["jellyfin-next"] });
});

test("an explicit unwatched state suppresses a stale provider next-up card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [{
      media_key: "episode:1:1:tmdb:5150",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      show_tmdb_id: "5150",
      season: 1,
      episode: 1,
      state: "unwatched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-next-stale",
      media_type: "episode",
      title: "Jellyfin Show - S01E01",
      show_title: "Jellyfin Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "5150" },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("provider specials are not promoted into the Up Next rail", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "special-1",
      media_type: "episode",
      title: "Special Show - S00E01",
      show_title: "Special Show",
      season: 0,
      episode: 1,
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("a watched episode suppresses a stale provider resume card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [{
      media_key: "episode:3:7:tmdb:113962",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      show_tmdb_id: "113962",
      season: 3,
      episode: 7,
      state: "watched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-lioness-s03e07-stale",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      season: 3,
      episode: 7,
      show_ids: { tmdb: "113962" },
      position_ms: 162184,
      duration_ms: 2684557,
      progress: 6,
    }],
  });

  assert.equal(projection.items.length, 0);
});

test("queue projection carries show watch recency into provider next-up ordering", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    shows: [
      { title: "Ted Lasso", tmdb_id: "97546", latest_watched_at: "2026-08-28T20:00:00.000Z" },
      { title: "Reacher", tmdb_id: "108978", latest_watched_at: "2026-09-03T20:00:00.000Z" },
    ],
    providerItems: [
      { provider: "jellyfin", feed_kind: "next_up", provider_item_id: "ted-next", media_type: "episode", title: "Ted Lasso - S03E02", show_title: "Ted Lasso", show_ids: { tmdb: "97546" }, season: 3, episode: 2, air_date: "2026-08-01" },
      { provider: "jellyfin", feed_kind: "next_up", provider_item_id: "reacher-next", media_type: "episode", title: "Reacher - S03E08", show_title: "Reacher", show_ids: { tmdb: "108978" }, season: 3, episode: 8, air_date: "2026-08-01" },
    ],
  });

  assert.deepEqual(projection.items.map((item) => item.show_title), ["Reacher", "Ted Lasso"]);
});

test("native provider resume membership remains visible, as next up, when position is omitted", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [{ title: "Ted Lasso", tmdb_id: "97546", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-resume-without-position",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      show_ids: { tmdb: "97546" },
    }],
  });

  assert.equal(projection.items.length, 1);
  // Defect N: membership with no position is not saved progress, so the card
  // is not labelled part-watched (The Testaments S01E03 sat among next_up
  // cards as a 0% resume).
  assert.equal(projection.items[0].queue_kind, "next_up");
  assert.equal(projection.items[0].progress, 0);
  assert.equal(projection.items[0].playback_position_known, false);
  assert.deepEqual(projection.items[0].provider_items, { emby: ["emby-resume-without-position"] });
});

test("a Jellyfin part-watch resume card lists the Jellyfin id Jellyfin keeps in Next Up", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-23T12:00:00.000Z"),
    shows: [{ title: "Scot Squad", tmdb_id: "55615", latest_watched_at: "2026-09-01T12:00:00.000Z" }],
    localFallback: false,
    // A play of the 720p version of a two-version episode: Jellyfin Resume is
    // not a projection feed, so the part-watch is only this canonical row.
    progressRows: [{
      media_key: "episode:1:2:tmdb:55615",
      media_type: "episode",
      title: "Scot Squad - S01E02",
      season: 1,
      episode: 2,
      position_ms: 300000,
      duration_ms: 1720000,
      progress: 17.4,
      updated_at: Date.parse("2026-09-23T08:15:56.000Z"),
      source: "jellyfin",
    }],
    playstateRows: [],
    providerItems: [
      {
        provider: "jellyfin",
        feed_kind: "next_up",
        provider_item_id: "jelly-primary-1080p",
        media_type: "episode",
        title: "Scot Squad - S01E02",
        show_title: "Scot Squad",
        season: 1,
        episode: 2,
        show_ids: { tmdb: "55615" },
        air_date: "2014-02-01",
      },
      {
        provider: "emby",
        feed_kind: "resume",
        provider_item_id: "emby-22065",
        media_type: "episode",
        title: "Scot Squad - S01E02",
        show_title: "Scot Squad",
        season: 1,
        episode: 2,
        show_ids: { tmdb: "55615" },
        position_ms: 300000,
        duration_ms: 1720000,
      },
    ],
  });

  // Step 6 found this card listing only Emby 22065.
  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "resume");
  assert.equal(projection.items[0].position_ms, 300000);
  assert.deepEqual(projection.items[0].provider_items, { emby: ["emby-22065"], jellyfin: ["jelly-primary-1080p"] });
});

test("a position-less membership merged with a real resume stays a resume", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [{ title: "Ted Lasso", tmdb_id: "97546", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [
      {
        provider: "plex",
        feed_kind: "resume",
        provider_item_id: "plex-no-offset",
        media_type: "episode",
        title: "Ted Lasso - S04E03",
        show_title: "Ted Lasso",
        season: 4,
        episode: 3,
        show_ids: { tmdb: "97546" },
      },
      {
        provider: "emby",
        feed_kind: "resume",
        provider_item_id: "emby-real-position",
        media_type: "episode",
        title: "Ted Lasso - S04E03",
        show_title: "Ted Lasso",
        season: 4,
        episode: 3,
        show_ids: { tmdb: "97546" },
        position_ms: 600000,
        duration_ms: 1800000,
      },
    ],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "resume");
  assert.equal(projection.items[0].position_ms, 600000);
  assert.deepEqual(projection.items[0].provider_items, { emby: ["emby-real-position"], plex: ["plex-no-offset"] });
});

test("native provider resume positions remain visible as part-watched progress", async () => {
  const positionMs = 162184;
  const durationMs = 2684557;
  recordUpNextRailSeeds([{
    provider: "emby",
    providerItemId: "emby-seeded-resume",
    positionMs,
    durationMs,
  }]);

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [{ title: "Lioness", tmdb_id: "113962", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-seeded-resume",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      episode_title: "Kiss the Girls",
      season: 3,
      episode: 7,
      show_ids: { tmdb: "113962" },
      position_ms: positionMs,
      duration_ms: durationMs,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].position_ms, positionMs);
  assert.equal(projection.items[0].duration_ms, durationMs);
  assert.ok(Math.abs(projection.items[0].progress - ((positionMs / durationMs) * 100)) < 0.001);
  assert.equal(projection.items[0].playback_position_known, true);
});

test("canonical resume positions remain visible when they match a legacy rail seed", async () => {
  const positionMs = 162184;
  const durationMs = 2684557;
  recordUpNextRailSeeds([{
    provider: "jellyfin",
    providerItemId: "jellyfin-seeded-resume",
    positionMs,
    durationMs,
    mediaKey: "episode:3:7:tmdb:113962",
  }]);

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:3:7:tmdb:113962",
      media_type: "episode",
      title: "Lioness - S03E07",
      show_title: "Lioness",
      show_tmdb_id: "113962",
      season: 3,
      episode: 7,
      position_ms: positionMs,
      duration_ms: durationMs,
      progress: (positionMs / durationMs) * 100,
      updated_at: 500,
      source: "jellyfin",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].position_ms, positionMs);
  assert.equal(projection.items[0].progress, (positionMs / durationMs) * 100);
  assert.equal(projection.items[0].playback_position_known, true);
});

test("uncertain provider membership keeps only the furthest episode for a show", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-04T12:00:00.000Z"),
    shows: [
      { title: "Ludwig (2024)", latest_watched_at: "2026-08-01T12:00:00.000Z" },
      { title: "Ludwig", latest_watched_at: "2026-08-01T12:00:00.000Z" },
    ],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [
      {
        provider: "emby",
        feed_kind: "resume",
        provider_item_id: "emby-ludwig-1",
        series_provider_item_id: "emby-ludwig",
        media_type: "episode",
        title: "Ludwig (2024) - S02E01",
        show_title: "Ludwig (2024)",
        episode_title: "Episode 1",
        season: 2,
        episode: 1,
      },
      {
        provider: "plex",
        feed_kind: "resume",
        provider_item_id: "plex-ludwig-2",
        series_provider_item_id: "plex-ludwig",
        media_type: "episode",
        title: "Ludwig (2024) - S02E02",
        show_title: "Ludwig (2024)",
        episode_title: "Episode 2",
        season: 2,
        episode: 2,
        ids: { imdb: "tt-ludwig-episode-2" },
      },
      {
        provider: "jellyfin",
        feed_kind: "next_up",
        provider_item_id: "jellyfin-ludwig-2",
        series_provider_item_id: "jellyfin-ludwig",
        media_type: "episode",
        title: "Ludwig - S02E02",
        show_title: "Ludwig",
        episode_title: "Episode 2",
        season: 2,
        episode: 2,
        ids: { imdb: "tt-ludwig-episode-2" },
      },
    ],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Ludwig (2024)");
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 2);
  assert.deepEqual(projection.items[0].provider_items, {
    jellyfin: ["jellyfin-ludwig-2"],
    plex: ["plex-ludwig-2"],
  });
});

test("a matching provider next-up observation does not duplicate a canonical resume", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:show:123:s:2:e:5",
      media_type: "episode",
      title: "The Expanse - S02E05 - Home",
      show_title: "The Expanse",
      tmdb_id: "123",
      season: 2,
      episode: 5,
      position_ms: 600000,
      duration_ms: 2400000,
      progress: 25,
      updated_at: 500,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-episode-5",
      media_type: "episode",
      title: "Home",
      show_title: "The Expanse",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      air_date: "2017-02-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "resume");
});

// Verified live: the only known "Scrubs" was the 2026 reboot, so a Plex resume
// of the 2001 show inherited the reboot's show ids and Up Next auto-sync wrote
// the position onto the reboot's Emby and Jellyfin episodes.
test("a resume row keeps its own series ids when they disagree with the title's only known show", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Scrubs", imdb_id: "tt40197357", tmdb_id: "295778", tvdb_id: "465690", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    progressRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      position_ms: 245_000,
      duration_ms: 1_331_349,
      progress: 18.4,
      updated_at: 500,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  const [card] = projection.items;
  assert.equal(card.queue_kind, "resume");
  assert.notEqual(card.show_imdb_id, "tt40197357");
  assert.notEqual(card.show_tmdb_id, "295778");
  assert.equal(card.tmdb_id, "4556");
});

test("a provider resume of a same-title show does not inherit the other show's ids by title", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Scrubs", imdb_id: "tt40197357", tmdb_id: "295778", tvdb_id: "465690", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    progressRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      position_ms: 245_000,
      duration_ms: 1_331_349,
      progress: 18.4,
      updated_at: 500,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "3263",
      series_provider_item_id: "3258",
      media_type: "episode",
      title: "My Old Lady",
      show_title: "Scrubs",
      season: 1,
      episode: 4,
      ids: { imdb: "tt0696616", tmdb: "6992251" },
      position_ms: 245_000,
      duration_ms: 1_331_349,
      updated_at: 500,
    }],
  });

  assert.equal(projection.items.some((item) => item.show_imdb_id === "tt40197357" || item.show_tmdb_id === "295778"), false);
});

// Verified live in step 2: once Clear progress deleted the canonical row, the
// title index was unambiguous again and Plex's 2001 Continue Watching item was
// filled with the reboot's ids. The feed now resolves the native series handle
// when it is stored, so the observation carries its own show ids.
test("a stored provider feed episode keeps the series ids of its native series handle", async () => {
  const lookups = [];
  const [stored] = await withUpNextFeedSeriesIdentity("plex", [{
    ratingKey: "3263",
    grandparentRatingKey: "3258",
    type: "episode",
    title: "My Old Lady",
    grandparentTitle: "Scrubs",
    parentIndex: 1,
    index: 4,
    viewOffset: 245_000,
    duration: 1_331_349,
  }], { baseUrl: "http://plex.test", token: "t" }, {
    resolve: async (source, seriesItemId) => {
      lookups.push(`${source}:${seriesItemId}`);
      return { imdb: "tt0285403", tmdb: "4556", tvdb: "76156" };
    },
  });
  assert.deepEqual(lookups, ["plex:3258"]);

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [
      { title: "Scrubs", imdb_id: "tt40197357", tmdb_id: "295778", tvdb_id: "465690", latest_watched_at: "2026-08-01T12:00:00.000Z" },
      { title: "Scrubs", imdb_id: "tt0285403", tmdb_id: "4556", tvdb_id: "76156", latest_watched_at: "2026-07-01T12:00:00.000Z" },
    ],
    progressRows: [],
    playstateRows: [],
    providerItems: [{ provider: "plex", feed_kind: "resume", item: stored }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_tmdb_id, "4556");
  assert.notEqual(projection.items[0].show_imdb_id, "tt40197357");
});

const SCRUBS_REBOOT = { title: "Scrubs", imdb_id: "tt40197357", tmdb_id: "295778", tvdb_id: "465690", latest_watched_at: "2026-08-01T12:00:00.000Z" };
// The 2001 show's own watches: the reboot's cannot vouch for it by title.
const SCRUBS_2001 = { title: "Scrubs", imdb_id: "tt0285403", tmdb_id: "4556", tvdb_id: "76156", latest_watched_at: "2026-07-01T12:00:00.000Z" };
const scrubs2001Observation = (overrides = {}) => ({
  provider: "plex",
  feed_kind: "resume",
  provider_item_id: "3263",
  series_provider_item_id: "3258",
  media_type: "episode",
  title: "My Old Lady",
  show_title: "Scrubs",
  season: 1,
  episode: 4,
  ids: { imdb: "tt0696616", tmdb: "6992251" },
  show_ids: { imdb: "tt0285403", tmdb: "4556", tvdb: "76156" },
  position_ms: 245_000,
  duration_ms: 1_331_349,
  updated_at: 500,
  ...overrides,
});

// Verified live in the step 2 repeat: the canonical row became a title-keyed
// card beside the resolved Plex observation of the same episode.
test("a same-title show's canonical row joins its provider observation in one card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [SCRUBS_REBOOT],
    progressRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      position_ms: 245_000,
      duration_ms: 1_331_349,
      updated_at: 500,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [scrubs2001Observation()],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].id, "episode|series:imdb:tt0285403|s:1|e:4");
  assert.equal(projection.items[0].show_tmdb_id, "4556");
  assert.deepEqual(projection.items[0].provider_items, { plex: ["3263"] });
  // The API path merges the public items again. Stripping the row's series
  // ids as "self-referential" turned the card into episode|title:scrubs there.
  assert.equal(publicUpNextItems(projection.items)[0].id, "episode|series:imdb:tt0285403|s:1|e:4");
});

// Once both shows have their own library row the title index drops "scrubs"
// as ambiguous. The canonical row must still use its own series ids: keyed by
// title it became a second resume card with no provider items (matrix step 4).
test("a canonical row joins its provider observation when two library shows share its title", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [
      { title: "Scrubs", imdb_id: "tt0285403", tmdb_id: "4556", tvdb_id: "76156", latest_watched_at: "2026-08-02T12:00:00.000Z" },
      SCRUBS_REBOOT,
    ],
    progressRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      position_ms: 245_000,
      duration_ms: 1_331_349,
      updated_at: 500,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [scrubs2001Observation()],
  });

  const ids = publicUpNextItems(projection.items).map((item) => item.id);
  assert.deepEqual(ids, ["episode|series:imdb:tt0285403|s:1|e:4"]);
  assert.deepEqual(projection.items[0].provider_items, { plex: ["3263"] });
});

// Verified live (step 6, defect R): Scot Squad's history knows only tvdb
// 264603, so the canonical row took show identity series:tvdb:264603 while the
// provider observations keyed by imdb, and one Jellyfin play made two cards.
test("a canonical row fills the ids a history-only title profile lacks and joins its observations", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Scot Squad", tvdb_id: "264603", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    progressRows: [{
      media_key: "episode:1:2:imdb:tt2493352",
      media_type: "episode",
      title: "Scot Squad - S01E02",
      imdb_id: "tt2493352",
      tmdb_id: "55615",
      tvdb_id: "264603",
      season: 1,
      episode: 2,
      position_ms: 300_000,
      duration_ms: 1_723_000,
      updated_at: 500,
      source: "jellyfin",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "3255",
      media_type: "episode",
      title: "Episode 2",
      show_title: "Scot Squad",
      season: 1,
      episode: 2,
      ids: { imdb: "tt3522498" },
      show_ids: { imdb: "tt2493352", tmdb: "55615", tvdb: "264603" },
      position_ms: 300_000,
      duration_ms: 1_723_000,
      updated_at: 500,
    }],
  });

  const ids = publicUpNextItems(projection.items).map((item) => item.id);
  assert.deepEqual(ids, ["episode|series:imdb:tt2493352|s:1|e:2"]);
  assert.equal(projection.items[0].show_tmdb_id, "55615");
  assert.equal(projection.items[0].show_tvdb_id, "264603");
  assert.deepEqual(projection.items[0].provider_items, { plex: ["3255"] });
});

// After Clear progress only the playstate row remains. The title index then
// names the reboot, and the unwatch must still reach the 2001 observation.
test("a cleared same-title episode's stale provider resume does not come back as resume", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [SCRUBS_REBOOT],
    progressRows: [],
    playstateRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      state: "unwatched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [scrubs2001Observation({ updated_at: Date.parse("2026-09-01T10:00:00.000Z") })],
  });

  assert.equal(projection.items.some((item) => item.queue_kind === "resume"), false);
});

// Verified live in the step 2 repeat: after the clear, Plex kept S01E04 in
// Continue Watching with no offset and a newer lastViewedAt.
test("a cleared episode kept in native Continue Watching without a position is next_up", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [SCRUBS_REBOOT, SCRUBS_2001],
    progressRows: [],
    playstateRows: [{
      media_key: "episode:1:4:imdb:tt0285403",
      media_type: "episode",
      title: "Scrubs - S01E04",
      imdb_id: "tt0285403",
      tmdb_id: "4556",
      tvdb_id: "76156",
      season: 1,
      episode: 4,
      state: "unwatched",
      updated_at: Date.parse("2026-09-01T11:00:00.000Z"),
    }],
    providerItems: [scrubs2001Observation({
      position_ms: undefined,
      duration_ms: undefined,
      updated_at: Date.parse("2026-09-01T11:01:00.000Z"),
    })],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].queue_kind, "next_up");
  assert.equal(Number(projection.items[0].position_ms || 0), 0);
  assert.equal(projection.items[0].show_tmdb_id, "4556");
});

test("a feed episode that already carries series ids is not looked up again", async () => {
  const raw = { ratingKey: "1", grandparentRatingKey: "2", type: "episode", show_ids: { tmdb: "4556" } };
  const [stored] = await withUpNextFeedSeriesIdentity("plex", [raw], { baseUrl: "http://plex.test" }, {
    resolve: async () => assert.fail("series lookup should be skipped"),
  });
  assert.equal(stored, raw);
});

test("a native provider resume joins the canonical local episode when the show identity is verified", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Ted Lasso", imdb_id: "tt10986410", tmdb_id: "97546", tvdb_id: "383203", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    progressRows: [{
      media_key: "episode:4:6:imdb:tt10986410",
      media_type: "episode",
      title: "Ted Lasso - S04E06",
      show_title: "Ted Lasso",
      imdb_id: "tt10986410",
      tmdb_id: "97546",
      tvdb_id: "383203",
      season: 4,
      episode: 6,
      position_ms: 1_181_147,
      duration_ms: 2_761_759,
      progress: 42.7,
      updated_at: 500,
      source: "emby",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "ted-episode-406",
      series_provider_item_id: "ted-series",
      media_type: "episode",
      title: "Ted Lasso - S04E06",
      show_title: "Ted Lasso",
      episode_title: "Don’t Jump Around Much Anymore",
      season: 4,
      episode: 6,
      ids: { imdb: "tt38494472", tvdb: "11767186" },
      position_ms: 1_181_147,
      duration_ms: 2_761_759,
      progress: 42.7,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].media_key, "episode:4:6:imdb:tt10986410");
  assert.deepEqual(projection.items[0].provider_items, { emby: ["ted-episode-406"] });
});

test("provider-backed posters use the authenticated poster proxy", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{ title: "Example Show", tvdb_id: "series-1", latest_watched_at: "2026-08-01T12:00:00.000Z" }],
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-poster-episode",
      media_type: "episode",
      title: "Example Show - S01E01",
      show_title: "Example Show",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-1" },
      item: {
        Id: "jellyfin-poster-episode",
        SeriesId: "jellyfin-poster-series",
        SeriesPrimaryImageTag: "series-tag",
      },
      air_date: "2026-08-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0].poster_url,
    "/api/poster?id=jellyfin-poster-episode&provider=jellyfin&format=image&v=2",
  );
  assert.equal(
    projection.items[0].show_poster_url,
    "/api/poster?id=jellyfin-poster-episode&provider=jellyfin&format=image&v=2",
  );
});

test("canonical episode rows reuse the cached show poster when no provider poster exists", async () => {
  saveCanonicalPoster({ media_type: "episode", show_title: "Reacher", show_tmdb_id: "108978" }, "/media/posters/reacher.webp", { source: "test" });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "episode:3:2:tmdb:108978",
      media_type: "episode",
      title: "Reacher - S03E02",
      show_title: "Reacher",
      tmdb_id: "108978",
      season: 3,
      episode: 2,
      position_ms: 300000,
      duration_ms: 1200000,
      progress: 25,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].poster_url, "/media/posters/reacher.webp");
  assert.equal(projection.items[0].show_poster_url, "/media/posters/reacher.webp");
});

test("canonical movie rows reuse the cached movie poster when no provider poster exists", async () => {
  saveCanonicalPoster({ media_type: "movie", title: "Arrival", tmdb_id: "329865" }, "/media/posters/arrival.webp", { source: "test" });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:tmdb:329865",
      media_type: "movie",
      title: "Arrival",
      tmdb_id: "329865",
      position_ms: 300000,
      duration_ms: 6000000,
      progress: 5,
      updated_at: 300,
      source: "local",
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].poster_url, "/media/posters/arrival.webp");
});

test("provider-sourced local resumes expose a safe poster proxy when their stored path is provider-relative", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:title:moana",
      media_type: "movie",
      title: "Moana",
      source: "plex",
      poster_url: "/library/metadata/43844/thumb/123",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
      updated_at: 300,
    }],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0].poster_url,
    "/api/poster?id=movie%3Atitle%3Amoana&format=image&v=2",
  );
});

test("title-only movie resumes collapse into the identified provider item and keep its poster", async () => {
  saveCanonicalPoster(
    { media_type: "movie", title: "Moana", tmdb_id: "1108427", imdb_id: "tt27419466" },
    "/media/posters/moana.webp",
    { source: "test" },
  );
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    progressRows: [{
      media_key: "movie:title:moana",
      media_type: "movie",
      title: "Moana",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
      updated_at: 300,
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "43844",
      media_type: "movie",
      title: "Moana",
      ids: { imdb: "tt27419466", tmdb: "1108427" },
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].id, "movie|id:imdb:tt27419466");
  assert.equal(projection.items[0].poster_url, "/media/posters/moana.webp");
  assert.deepEqual(projection.items[0].provider_items, { plex: ["43844"] });
});

test("provider next-up is filtered by a locally watched episode with a different media key", async () => {
  insertWatchRecordSync({
    title: "Expedition X - S01E05",
    show_title: "Expedition X",
    episode_title: "Mt Adams UFO Encounter",
    media_type: "episode",
    season: 1,
    episode: 5,
    tmdb_id: "99363",
    tvdb_id: "375704",
    imdb_id: "tt11774420",
    watched_at: "2020-03-11T12:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-12T12:00:00.000Z"),
    localFallback: false,
    shows: [{ title: "Expedition X", tmdb_id: "99363", tvdb_id: "375704", imdb_id: "tt11774420" }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-expedition-x-s01e05",
      series_provider_item_id: "jellyfin-expedition-x",
      media_type: "episode",
      title: "Expedition X - S01E05",
      show_title: "Expedition X",
      episode_title: "Mt Adams UFO Encounter",
      season: 1,
      episode: 5,
      ids: { imdb: "tt11946530" },
      air_date: "2020-03-11",
    }],
  });

  assert.deepEqual(projection.items, []);
});

test("handleUpNextRemove clears positive playback progress and marks unplayed", async () => {
  const { handleUpNextRemove } = await import("../server/src/routes/sync.js");
  const { upsertPlaybackProgress } = await import("../server/src/utils/dataRepo.js");
  const { AUTH } = await import("../server/src/appConfig.js");
  const { db } = await import("../server/src/db.js");

  const mediaKey = "episode:1:2:tmdb:999";
  upsertPlaybackProgress({
    media_key: mediaKey,
    media_type: "episode",
    title: "Test Show - S01E02",
    show_title: "Test Show",
    season: 1,
    episode: 2,
    tmdb_id: "999",
    position_ms: 500000,
    duration_ms: 2000000,
    progress: 25,
  });

  const req = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH.apiKey}`,
    },
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    body: {
      media_key: mediaKey,
      media_type: "episode",
      title: "Test Show - S01E02",
      show_title: "Test Show",
      season: 1,
      episode: 2,
      tmdb_id: "999",
    },
  };

  let statusCode = 200;
  let responseData = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    send(data) {
      if (data) responseData = JSON.parse(data);
      return this;
    },
  };

  await handleUpNextRemove(req, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData?.ok, true);

  const remaining = db.prepare("SELECT * FROM playback_progress WHERE media_key = ?").get(mediaKey);
  assert.equal(remaining, undefined);
});

// Regression (24 Sep 2026): a scheduled Plex stop stored resume progress, but
// the dashboard rail kept its cached snapshot because nothing advanced the Up
// Next version, so no live event reloaded it until a forced refresh.
test("storing or clearing resume progress advances the Up Next version", async () => {
  const { upsertPlaybackProgress, deletePlaybackProgressSync } = await import("../server/src/utils/dataRepo.js");
  const { db, getUpNextVersion } = await import("../server/src/db.js");
  const record = {
    media_key: "movie:none:none:imdb:tt7700001",
    media_type: "movie",
    title: "Resume Version Movie",
    source: "plex",
    imdb_id: "tt7700001",
    position_ms: 742000,
    duration_ms: 6000000,
    progress: 12.4,
    updated_at: Date.now(),
  };

  const beforeStore = getUpNextVersion();
  await upsertPlaybackProgress(record);
  const afterStore = getUpNextVersion();
  assert.ok(afterStore > beforeStore, "a new resume position must advance the Up Next version");

  await upsertPlaybackProgress({ ...record, updated_at: Date.now() + 1000 });
  assert.equal(getUpNextVersion(), afterStore, "an unchanged position must not advance the Up Next version");

  await upsertPlaybackProgress({ ...record, position_ms: 900000, progress: 15, updated_at: Date.now() + 2000 });
  const afterMove = getUpNextVersion();
  assert.ok(afterMove > afterStore, "a moved resume position must advance the Up Next version");

  const auditCount = () => db.prepare("SELECT COUNT(*) AS count FROM watch_audit_events WHERE event_type = ? AND media_key = ?")
    .get("resume_progress_cleared", record.media_key).count;
  const beforeClearAudit = auditCount();
  deletePlaybackProgressSync(record);
  const afterClear = getUpNextVersion();
  assert.ok(afterClear > afterMove, "clearing a resume position must advance the Up Next version");
  assert.equal(auditCount(), beforeClearAudit + 1, "clearing a stored resume position must record one audit event");

  deletePlaybackProgressSync(record);
  assert.equal(getUpNextVersion(), afterClear, "clearing an absent resume must not advance the Up Next version");
  assert.equal(auditCount(), beforeClearAudit + 1, "clearing absent progress must not record a false audit event");
});

test("two Jellyfin versions of one episode become one card carrying both native ids", async () => {
  const version = (id, extra = {}) => ({
    provider: "jellyfin",
    provider_item_id: id,
    series_provider_item_id: "jellyfin-scot-squad",
    media_type: "episode",
    title: "Scot Squad - S01E02",
    show_title: "Scot Squad",
    season: 1,
    episode: 2,
    ids: { imdb: "tt4095548", tvdb: "5050664" },
    show_ids: { imdb: "tt2493352", tmdb: "55615", tvdb: "264603" },
    air_date: "2014-11-06",
    ...extra,
  });
  const shows = [{ title: "Scot Squad", imdb_id: "tt2493352", tmdb_id: "55615", tvdb_id: "264603", latest_watched_at: "2026-09-01T12:00:00.000Z" }];

  const nextUp = await buildUpNextProjection({
    now: Date.parse("2026-09-23T12:00:00.000Z"),
    shows,
    localFallback: false,
    progressRows: [],
    playstateRows: [],
    providerItems: [version("jf-720p", { feed_kind: "next_up" }), version("jf-1080p", { feed_kind: "next_up" })],
  });
  assert.equal(nextUp.items.length, 1);
  assert.equal(nextUp.items[0].queue_kind, "next_up");
  assert.deepEqual(nextUp.items[0].provider_items, { jellyfin: ["jf-1080p", "jf-720p"] });
});

test("an episode clear or remove uses the card's show ids, not its episode ids", async () => {
  const { mediaFromProgressRequest } = await import("../server/src/routes/sync.js");
  // Scot Squad S01E02 as the Up Next card sends it: episode ids in the plain
  // fields, show ids in show_*. Trakt returned not_found for the episode ids.
  const body = {
    media_key: "episode|series:imdb:tt2493352|s:1|e:2",
    media_type: "episode",
    title: "Scot Squad - S01E02",
    show_title: "Scot Squad",
    season: 1,
    episode: 2,
    imdb_id: "tt4095548",
    tmdb_id: "1260552",
    tvdb_id: "5050664",
    show_imdb_id: "tt2493352",
    show_tmdb_id: "55615",
    show_tvdb_id: "264603",
  };
  assert.deepEqual(mediaFromProgressRequest(null, body, body.media_key).ids, {
    imdb: "tt2493352",
    tmdb: "55615",
    tvdb: "264603",
  });

  // A partial set of show ids is never topped up with an episode id.
  const partial = mediaFromProgressRequest(null, { ...body, show_imdb_id: "", show_tvdb_id: "" }, body.media_key);
  assert.deepEqual(partial.ids, { imdb: undefined, tmdb: "55615", tvdb: undefined });

  // Movies and callers that send no show ids keep the plain ids.
  const movie = mediaFromProgressRequest(null, { title: "Film", media_type: "movie", tmdb_id: "1", show_tmdb_id: "2" }, "movie:tmdb:1");
  assert.equal(movie.ids.tmdb, "1");
  const legacy = mediaFromProgressRequest(null, { title: "Show - S01E01", media_type: "episode", tmdb_id: "77", season: 1, episode: 1 }, "k");
  assert.equal(legacy.ids.tmdb, "77");
});

// --- Local fallback: an unwatched next episode has no watch history, so it
// can never carry a native provider id of its own. These cover the two ways
// that used to make a real, playable episode vanish from Up Next.

const { db } = await import("../server/src/db.js");

function seedShowMetadata({ tmdbId, tvdbId, title, seasonNumber, episodes, additionalSeasons = [] }) {
  const seasons = [{ seasonNumber, episodes }, ...additionalSeasons];
  db.prepare(
    `INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, schema_version, updated_at_ms)
     VALUES (?, ?, 'tv', ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
  ).run(
    `tv_${tmdbId}`,
    tmdbId,
    title,
    JSON.stringify({
      id: Number(tmdbId),
      name: title,
      external_ids: { tvdb_id: tvdbId },
      seasons: seasons.map((season) => ({ season_number: season.seasonNumber })),
    }),
    Date.now(),
  );
  for (const season of seasons) {
    db.prepare(
      `INSERT INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
    ).run(
      `${tvdbId}_${season.seasonNumber}`,
      tvdbId,
      season.seasonNumber,
      JSON.stringify({ episodes: season.episodes }),
      Date.now(),
    );
  }
}

test("completed shows leave Up Next while a never-watched manually queued show remains", async () => {
  insertWatchRecordSync({
    title: "Completed Queue Show - S01E01",
    show_title: "Completed Queue Show",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88010",
    watched_at: "2026-08-01T11:00:00.000Z",
    source: "manual",
  });
  insertWatchRecordSync({
    title: "Completed Queue Show - S01E02",
    show_title: "Completed Queue Show",
    media_type: "episode",
    season: 1,
    episode: 2,
    show_tmdb_id: "88010",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const completed = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    localFallback: false,
    shows: [{
      title: "Completed Queue Show",
      tmdb_id: "88010",
      episode_count: 2,
      total_episodes: 2,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "completed-queue-show-s01e03",
      media_type: "episode",
      title: "Completed Queue Show - S01E03",
      show_title: "Completed Queue Show",
      season: 1,
      episode: 3,
      show_ids: { tmdb: "88010" },
      air_date: "2026-08-03",
    }],
  });
  assert.equal(completed.items.find((item) => item.show_title === "Completed Queue Show"), undefined);

  upsertManualUpNextShow({ title: "Never Watched Queue Show", tmdb_id: "88011" }, {
    now: Date.parse("2026-09-10T12:00:00.000Z"),
  });
  const neverWatched = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    localFallback: false,
    shows: [],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "never-watched-queue-show-s01e01",
      media_type: "episode",
      title: "Never Watched Queue Show - S01E01",
      show_title: "Never Watched Queue Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "88011" },
      air_date: "2026-08-03",
    }],
  });
  assert.equal(neverWatched.items.find((item) => item.show_title === "Never Watched Queue Show")?.episode, 1);
  removeManualUpNextShow({ tmdb_id: "88011" });
});

test("a manually queued show with only explicit unwatches stays out of Up Next", async () => {
  insertWatchRecordSync({
    title: "Cleared Queue Show - S01E01",
    show_title: "Cleared Queue Show",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88012",
    watched_at: "2026-08-01T11:00:00.000Z",
    source: "manual",
    sync_action: "unwatched",
  });
  upsertManualUpNextShow({ title: "Cleared Queue Show", tmdb_id: "88012" }, {
    now: Date.parse("2026-09-10T12:00:00.000Z"),
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    localFallback: false,
    shows: [],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "cleared-queue-show-s01e01",
      media_type: "episode",
      title: "Cleared Queue Show - S01E01",
      show_title: "Cleared Queue Show",
      season: 1,
      episode: 1,
      show_ids: { tmdb: "88012" },
      air_date: "2026-08-03",
    }],
  });

  assert.equal(projection.items.find((item) => item.show_title === "Cleared Queue Show"), undefined);
  removeManualUpNextShow({ tmdb_id: "88012" });
});

test("local fallback resolves an unwatched next episode against the configured libraries", async () => {
  seedShowMetadata({
    tmdbId: "108978",
    tvdbId: "371980",
    title: "Reacher",
    seasonNumber: 4,
    episodes: [
      { number: 6, name: "Plum Out of Luck", aired: "2026-09-01" },
      { number: 7, name: "Vote for Sampson", aired: "2026-09-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Reacher - S04E06",
    show_title: "Reacher",
    episode_title: "Plum Out of Luck",
    media_type: "episode",
    season: 4,
    episode: 6,
    show_tmdb_id: "108978",
    show_tvdb_id: "371980",
    watched_at: "2026-09-05T19:26:00.000Z",
    source: "manual",
  });

  const shows = [{
    id: "reacher",
    title: "Reacher",
    tmdb_id: "108978",
    tvdb_id: "371980",
    episode_count: 1,
    latest_watched_at: "2026-09-05T19:26:00.000Z",
  }];
  const options = {
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    shows,
    progressRows: [],
    playstateRows: [],
    providerItems: [],
  };

  // No library to ask: the old, conservative behavior is preserved.
  const withoutLookup = await buildUpNextProjection(options);
  assert.equal(withoutLookup.items.length, 0);

  const asked = [];
  const withLookup = await buildUpNextProjection({
    ...options,
    resolveProviderItems: async (candidate) => {
      asked.push(`${candidate.season}:${candidate.episode}`);
      return { plex: ["4685"] };
    },
  });
  assert.deepEqual(asked, ["4:7"]);
  assert.equal(withLookup.items.length, 1);
  assert.equal(withLookup.items[0].season, 4);
  assert.equal(withLookup.items[0].episode, 7);
  assert.deepEqual(withLookup.items[0].provider_items, { plex: ["4685"] });
});

test("local fallback crosses from an exhausted season to the first episode of the next season", async () => {
  seedShowMetadata({
    tmdbId: "88001",
    tvdbId: "88001",
    title: "Season Boundary",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
    additionalSeasons: [{
      seasonNumber: 2,
      episodes: [
        { number: 1, name: "New Beginning", aired: "2026-09-01" },
      ],
    }],
  });
  for (const episode of [1, 2]) {
    insertWatchRecordSync({
      title: `Season Boundary - S01E0${episode}`,
      show_title: "Season Boundary",
      episode_title: episode === 1 ? "One" : "Two",
      media_type: "episode",
      season: 1,
      episode,
      show_tmdb_id: "88001",
      show_tvdb_id: "88001",
      watched_at: `2026-08-${episode === 1 ? "02" : "09"}T11:00:00.000Z`,
      source: "manual",
    });
  }

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "season-boundary",
      title: "Season Boundary",
      tmdb_id: "88001",
      tvdb_id: "88001",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({ plex: ["season-2-episode-1"] }),
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
});

test("local fallback discovers a newly available season from provider inventory when metadata is stale", async () => {
  seedShowMetadata({
    tmdbId: "88003",
    tvdbId: "88003",
    title: "New Season",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "Finale", aired: "2026-08-01" },
    ],
  });
  insertWatchRecordSync({
    title: "New Season - S01E01",
    show_title: "New Season",
    episode_title: "Finale",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88003",
    show_tvdb_id: "88003",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "new-season",
      title: "New Season",
      tmdb_id: "88003",
      tvdb_id: "88003",
      episode_count: 1,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderEpisodes: async () => [{
      source: "plex",
      provider: "plex",
      provider_items: { plex: ["new-season-s02e01"] },
      media_type: "episode",
      title: "New Season - S02E01",
      show_title: "New Season",
      season: 2,
      episode: 1,
      air_date: "2026-09-01",
    }],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
  assert.deepEqual(projection.items[0].provider_items, { plex: ["new-season-s02e01"] });
});

test("provider inventory cannot jump past the first released unwatched episode", async () => {
  seedShowMetadata({
    tmdbId: "88005",
    tvdbId: "88005",
    title: "Ordered Seasons",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "Watched", aired: "2026-08-01" },
      { number: 2, name: "Next", aired: "2026-08-08" },
    ],
    additionalSeasons: [{
      seasonNumber: 3,
      episodes: [{ number: 1, name: "Later", aired: "2026-09-01" }],
    }],
  });
  insertWatchRecordSync({
    title: "Ordered Seasons - S01E01",
    show_title: "Ordered Seasons",
    episode_title: "Watched",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88005",
    show_tvdb_id: "88005",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "ordered-seasons",
      title: "Ordered Seasons",
      tmdb_id: "88005",
      tvdb_id: "88005",
      episode_count: 1,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({}),
    resolveProviderEpisodes: async () => [{
      source: "plex",
      provider: "plex",
      provider_items: { plex: ["ordered-seasons-s03e01"] },
      media_type: "episode",
      title: "Ordered Seasons - S03E01",
      show_title: "Ordered Seasons",
      season: 3,
      episode: 1,
      air_date: "2026-09-01",
    }],
  });

  assert.equal(projection.items.find((item) => item.show_title === "Ordered Seasons"), undefined);
});

test("a later watch does not make an earlier unwatched episode read as watched", async () => {
  // History rows keep the series ids in their flat id columns. Read as episode
  // ids they gave every episode one shared alias, so the newest state in the
  // show (the S01E03 watch) answered for the unwatched S01E02 and Up Next
  // skipped ahead (reboot Scrubs sat at S01E07 with S01E04 and S01E06 unwatched).
  seedShowMetadata({
    tmdbId: "88031",
    tvdbId: "88131",
    title: "Gap Episode Show",
    seasonNumber: 1,
    episodes: [1, 2, 3, 4].map((number) => ({ number, name: `Episode ${number}`, aired: "2026-08-01" })),
  });
  const watch = (episode, watchedAt, extra = {}) => insertWatchRecordSync({
    title: `Gap Episode Show - S01E0${episode}`,
    show_title: "Gap Episode Show",
    media_type: "episode",
    season: 1,
    episode,
    imdb_id: "tt88031",
    tmdb_id: "88031",
    tvdb_id: "88131",
    watched_at: watchedAt,
    source: "manual",
    ...extra,
  });
  watch(1, "2026-08-02T11:00:00.000Z");
  watch(2, "2026-08-03T11:00:00.000Z", { sync_action: "unwatched" });
  watch(3, "2026-08-04T11:00:00.000Z");

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "tmdb:88031",
      title: "Gap Episode Show",
      imdb_id: "tt88031",
      tmdb_id: "88031",
      tvdb_id: "88131",
      episode_count: 2,
      latest_watched_at: "2026-08-04T11:00:00.000Z",
    }, {
      // A second show with the title, so rows get no show ids from a title
      // profile (as with the two Scrubs shows).
      id: "tmdb:88032",
      title: "Gap Episode Show",
      tmdb_id: "88032",
      tvdb_id: "88132",
      episode_count: 0,
    }],
    progressRows: [],
    // The unwatch's playstate row is keyed by the other series id, as the
    // reboot's S01E02/S01E06 rows are: it must still answer for its episode.
    playstateRows: [{
      media_key: "episode:1:2:tvdb:88131",
      media_type: "episode",
      title: "Gap Episode Show - S01E02",
      show_title: "Gap Episode Show",
      tvdb_id: "88131",
      season: 1,
      episode: 2,
      state: "unwatched",
      updated_at: Date.parse("2026-08-03T11:00:00.000Z"),
    }],
    providerItems: [],
    resolveProviderItems: async () => ({ plex: ["gap-episode-show-next"] }),
    resolveProviderEpisodes: async () => [],
  });

  const card = projection.items.find((item) => item.show_title === "Gap Episode Show");
  assert.equal(card?.queue_kind, "next_up");
  assert.equal(card?.episode, 2);
});

test("local fallback scans watched shows beyond the previous recency boundary", async () => {
  const targetTitle = "Long Tail New Season";
  insertWatchRecordSync({
    title: `${targetTitle} - S01E01`,
    show_title: targetTitle,
    episode_title: "The Old Finale",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "88004",
    watched_at: "2026-01-02T11:00:00.000Z",
    source: "manual",
  });

  const shows = Array.from({ length: 50 }, (_, index) => ({
    title: `Recent Show ${index + 1}`,
    tmdb_id: `recent-${index + 1}`,
    episode_count: 1,
    latest_watched_at: `2026-09-${String(index + 1).padStart(2, "0")}T11:00:00.000Z`,
  }));
  shows.push({
    title: targetTitle,
    tmdb_id: "88004",
    episode_count: 1,
    latest_watched_at: "2026-01-02T11:00:00.000Z",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows,
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderEpisodes: async (show) => show.title === targetTitle ? [{
      source: "plex",
      provider: "plex",
      provider_items: { plex: ["long-tail-s02e01"] },
      media_type: "episode",
      title: `${targetTitle} - S02E01`,
      show_title: targetTitle,
      season: 2,
      episode: 1,
      air_date: "2026-09-01",
    }] : [],
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, targetTitle);
  assert.equal(projection.items[0].season, 2);
  assert.equal(projection.items[0].episode, 1);
});

test("manual Up Next hides a future-dated or unavailable first episode", async () => {
  seedShowMetadata({
    tmdbId: "88002",
    tvdbId: "88002",
    title: "Future Boundary",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
    additionalSeasons: [{
      seasonNumber: 2,
      episodes: [
        { number: 1, name: "New Beginning", aired: "2026-10-01" },
      ],
    }],
  });
  for (const episode of [1, 2]) {
    insertWatchRecordSync({
      title: `Future Boundary - S01E0${episode}`,
      show_title: "Future Boundary",
      episode_title: episode === 1 ? "One" : "Two",
      media_type: "episode",
      season: 1,
      episode,
      show_tmdb_id: "88002",
      show_tvdb_id: "88002",
      watched_at: `2026-08-${episode === 1 ? "02" : "09"}T11:00:00.000Z`,
      source: "manual",
    });
  }
  upsertManualUpNextShow({ title: "Future Boundary", tmdb_id: "88002", tvdb_id: "88002" }, {
    now: Date.parse("2026-09-10T12:00:00.000Z"),
  });

  const beforeRelease = await buildUpNextProjection({
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
  });

  assert.equal(beforeRelease.items.find((candidate) => candidate.show_title === "Future Boundary"), undefined);

  const unavailable = await buildUpNextProjection({
    now: Date.parse("2026-10-02T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({}),
  });
  assert.equal(unavailable.items.find((candidate) => candidate.show_title === "Future Boundary"), undefined);

  const available = await buildUpNextProjection({
    now: Date.parse("2026-10-02T12:00:00.000Z"),
    shows: [{
      id: "future-boundary",
      title: "Future Boundary",
      tmdb_id: "88002",
      tvdb_id: "88002",
      episode_count: 2,
      latest_watched_at: "2026-08-09T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems: async () => ({ plex: ["future-boundary-s02e01"] }),
  });

  const item = available.items.find((candidate) => candidate.show_title === "Future Boundary");
  assert.equal(item?.season, 2);
  assert.equal(item?.episode, 1);
  assert.deepEqual(item?.provider_items, { plex: ["future-boundary-s02e01"] });
  removeManualUpNextShow({ tmdb_id: "88002" });
});

test("the first unwatched episode remains the detail page's Up Next choice", async () => {
  seedShowMetadata({
    tmdbId: "97546",
    tvdbId: "383203",
    title: "Ted Lasso",
    seasonNumber: 4,
    episodes: [
      { number: 2, name: "Second", aired: "2026-08-01" },
      { number: 3, name: "Richmond's Got Talent", aired: "2026-08-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Ted Lasso - S04E02",
    show_title: "Ted Lasso",
    episode_title: "Second",
    media_type: "episode",
    season: 4,
    episode: 2,
    show_tmdb_id: "97546",
    show_tvdb_id: "383203",
    watched_at: "2026-08-05T11:47:55.353Z",
    source: "manual",
  });
  // The explicit unwatch is the detail page's current state for S04E03. It is
  // still the first unwatched episode after S04E02, so a provider row for it
  // remains eligible while later episodes would be rejected.
  insertWatchRecordSync({
    title: "Ted Lasso - S04E03",
    show_title: "Ted Lasso",
    episode_title: "Richmond's Got Talent",
    media_type: "episode",
    season: 4,
    episode: 3,
    show_tmdb_id: "97546",
    show_tvdb_id: "383203",
    watched_at: "2026-09-12T22:58:10.828Z",
    source: "manual",
    sync_action: "unwatched",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-13T12:00:00.000Z"),
    shows: [{
      id: "ted-lasso",
      title: "Ted Lasso",
      tmdb_id: "97546",
      tvdb_id: "383203",
      episode_count: 2,
      latest_watched_at: "2026-08-05T11:47:55.353Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "3478",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      show_ids: { tmdb: "97546", tvdb: "383203" },
      position_ms: 400000,
      duration_ms: 1800000,
      progress: 22,
      updated_at: Date.parse("2026-09-06T10:00:00.000Z"),
    }],
    resolveProviderItems: async () => ({ plex: ["3478"] }),
  });

  const episodes = projection.items.filter((item) => item.show_title === "Ted Lasso");
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].season, 4);
  assert.equal(episodes[0].episode, 3);
  // Clear progress is an unwatch newer than the provider's last play. A
  // provider that kept its old position must not turn the card back into a
  // resume: the episode stays as next_up from the beginning.
  assert.equal(episodes[0].queue_kind, "next_up");
  assert.equal(Number(episodes[0].position_ms || 0), 0);
});

test("a native id from an earlier play is re-checked before it backs a next-up card", async () => {
  // Expedition X S12E01: watched and unwatched through Emby, then deleted from
  // the library. The history row kept Emby item 11221, and the card linked
  // Watch now to an item Emby no longer has.
  seedShowMetadata({
    tmdbId: "99812",
    tvdbId: "99813",
    title: "Stale Id Show",
    seasonNumber: 12,
    episodes: [
      { number: 1, name: "Pilot", aired: "2026-08-12" },
      { number: 2, name: "Robin Hood's Ghosts", aired: "2026-08-19" },
    ],
  });
  insertWatchRecordSync({
    title: "Stale Id Show - S12E01",
    show_title: "Stale Id Show",
    media_type: "episode",
    season: 12,
    episode: 1,
    tmdb_id: "99812",
    tvdb_id: "99813",
    watched_at: "2026-07-02T22:58:00.000Z",
    source: "manual",
  });
  insertWatchRecordSync({
    title: "Stale Id Show - S12E02",
    show_title: "Stale Id Show",
    media_type: "episode",
    season: 12,
    episode: 2,
    tmdb_id: "99812",
    tvdb_id: "99813",
    watched_at: "2026-09-12T13:03:00.000Z",
    source: "manual",
    sync_action: "unwatched",
    watch_provenance: {
      source: "emby",
      ingest_path: "emby_scheduled_library_history",
      event: "library_history",
      phase: "completed",
      item_id: "dead-emby-11221",
      user: "configured-user",
      source_timestamp: "2026-09-12T13:03:00.000Z",
    },
  });
  const build = (resolveProviderItems) => buildUpNextProjection({
    now: Date.parse("2026-09-23T12:00:00.000Z"),
    shows: [{
      id: "stale-id-show",
      title: "Stale Id Show",
      tmdb_id: "99812",
      tvdb_id: "99813",
      episode_count: 2,
      latest_watched_at: "2026-07-02T22:58:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [],
    resolveProviderItems,
  });
  const card = (projection) => projection.items.find((item) => item.show_title === "Stale Id Show");
  // Only this show's re-check asks for the detailed shape.
  const lookup = (providerItems, unanswered, asked = []) => async (candidate, options = {}) => {
    if (candidate.show_title !== "Stale Id Show") return {};
    asked.push({ providerItems: candidate.provider_items, options });
    return options.detailed ? { providerItems, unanswered } : providerItems;
  };

  const asked = [];
  const gone = await build(lookup({}, [], asked));
  assert.equal(card(gone), undefined, "every library answered missing, so no card");
  // The stored id is withheld from the lookup, which would otherwise return it unverified.
  assert.deepEqual(asked, [{ providerItems: {}, options: { detailed: true } }]);

  const moved = await build(lookup({ plex: ["plex-s12e01"] }, []));
  assert.equal(card(moved)?.episode, 2);
  assert.deepEqual(card(moved)?.provider_items, { plex: ["plex-s12e01"] });

  const embyDown = await build(lookup({}, ["emby"]));
  assert.deepEqual(card(embyDown)?.provider_items, { emby: ["dead-emby-11221"] },
    "an unanswered provider is not evidence the item is gone");
});

test("provider Up Next cannot jump past the first unwatched detail-page episode", async () => {
  seedShowMetadata({
    tmdbId: "70001",
    tvdbId: "70001",
    title: "Queue Truth",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
      { number: 3, name: "Three", aired: "2026-08-15" },
      { number: 4, name: "Four", aired: "2026-08-22" },
    ],
  });
  insertWatchRecordSync({
    title: "Queue Truth - S01E01",
    show_title: "Queue Truth",
    episode_title: "One",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "70001",
    show_tvdb_id: "70001",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });
  insertWatchRecordSync({
    title: "Queue Truth - S01E02",
    show_title: "Queue Truth",
    episode_title: "Two",
    media_type: "episode",
    season: 1,
    episode: 2,
    show_tmdb_id: "70001",
    show_tvdb_id: "70001",
    watched_at: "2026-08-03T11:00:00.000Z",
    source: "manual",
    sync_action: "unwatched",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{
      id: "tmdb:70001",
      title: "Queue Truth",
      tmdb_id: "70001",
      tvdb_id: "70001",
      episode_count: 2,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "queue-truth-four",
      media_type: "episode",
      title: "Queue Truth - S01E04",
      show_title: "Queue Truth",
      season: 1,
      episode: 4,
      show_ids: { tmdb: "70001", tvdb: "70001" },
      air_date: "2026-08-22",
    }],
    resolveProviderItems: async () => ({ plex: ["queue-truth-two"] }),
  });

  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].show_title, "Queue Truth");
  assert.equal(projection.items[0].season, 1);
  assert.equal(projection.items[0].episode, 2);
  assert.deepEqual(projection.items[0].provider_items, { plex: ["queue-truth-two"] });
});

// Verified live (step 3): the 2001 Scrubs watch folded into the reboot's show
// row gave it the reboot's TMDB/IMDb ids plus the 2001 TVDB id. One shared id
// made that card the authoritative next episode for the 2001 show as well, so
// Jellyfin's 2001 S01E05 next-up was dropped and no card was left for it.
test("a mixed-identity show does not suppress the next episode of the show it shares one id with", async () => {
  seedShowMetadata({
    tmdbId: "71001",
    tvdbId: "72002",
    title: "Mixed Identity",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Mixed Identity - S01E01",
    show_title: "Mixed Identity",
    episode_title: "One",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "71001",
    show_imdb_id: "tt71001",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{
      id: "tmdb:71001",
      title: "Mixed Identity",
      imdb_id: "tt71001",
      tmdb_id: "71001",
      tvdb_id: "72002",
      episode_count: 1,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [{
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "other-show-five",
      media_type: "episode",
      title: "Mixed Identity - S01E05",
      show_title: "Mixed Identity",
      season: 1,
      episode: 5,
      show_ids: { imdb: "tt72001", tmdb: "72001", tvdb: "72002" },
      air_date: "2026-08-22",
    }],
    resolveProviderItems: async () => ({}),
  });

  const other = projection.items.find((item) => item.episode === 5);
  assert.ok(other, "the other show's provider next-up must survive");
  assert.deepEqual(other.provider_items, { jellyfin: ["other-show-five"] });
});

// Seen live on 2001 Scrubs S01E06: Emby Resume and Jellyfin Next Up listed the
// episode, Plex listed it in no rail, and the card had no Plex item because the
// local fallback stood down without asking Plex.
test("a next-up card covered by some providers' observations is looked up in the others", async () => {
  seedShowMetadata({
    tmdbId: "81001",
    tvdbId: "82002",
    title: "Partly Observed",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
    ],
  });
  insertWatchRecordSync({
    title: "Partly Observed - S01E01",
    show_title: "Partly Observed",
    episode_title: "One",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "81001",
    show_tvdb_id: "82002",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });
  const observation = (provider, feedKind, id) => ({
    provider,
    feed_kind: feedKind,
    provider_item_id: id,
    media_type: "episode",
    title: "Partly Observed - S01E02",
    show_title: "Partly Observed",
    season: 1,
    episode: 2,
    position_ms: 0,
    show_ids: { tmdb: "81001", tvdb: "82002" },
    air_date: "2026-08-08",
  });
  const asked = [];
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [{
      id: "tmdb:81001",
      title: "Partly Observed",
      tmdb_id: "81001",
      tvdb_id: "82002",
      episode_count: 1,
      latest_watched_at: "2026-08-02T11:00:00.000Z",
    }],
    progressRows: [],
    playstateRows: [],
    providerItems: [observation("emby", "resume", "emby-two"), observation("jellyfin", "next_up", "jf-two")],
    resolveProviderItems: async (candidate, options = {}) => {
      asked.push(options.only);
      // A covered provider in the answer must not replace the observed id.
      return { plex: ["plex-two"], emby: ["emby-stale"] };
    },
  });

  assert.deepEqual(asked, [["plex"]]);
  const cards = projection.items.filter((item) => item.show_title === "Partly Observed");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].episode, 2);
  assert.deepEqual(cards[0].provider_items, { emby: ["emby-two"], jellyfin: ["jf-two"], plex: ["plex-two"] });
});

// Verified live (matrix step 4): with the canonical resume joined to its show,
// the local resolver skips that episode and names the next one, and the
// provider resume observations of the resumed episode itself were filtered as
// "past the authoritative next", leaving a card with no native items.
test("provider resume observations of a canonical resume episode survive the authoritative next filter", async () => {
  seedShowMetadata({
    tmdbId: "81001",
    tvdbId: "82001",
    title: "Twin Title",
    seasonNumber: 1,
    episodes: [
      { number: 1, name: "One", aired: "2026-08-01" },
      { number: 2, name: "Two", aired: "2026-08-08" },
      { number: 3, name: "Three", aired: "2026-08-15" },
    ],
  });
  insertWatchRecordSync({
    title: "Twin Title - S01E01",
    show_title: "Twin Title",
    episode_title: "One",
    media_type: "episode",
    season: 1,
    episode: 1,
    show_tmdb_id: "81001",
    show_imdb_id: "tt81001",
    watched_at: "2026-08-02T11:00:00.000Z",
    source: "manual",
  });

  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    shows: [
      { id: "tmdb:81001", title: "Twin Title", imdb_id: "tt81001", tmdb_id: "81001", tvdb_id: "82001", episode_count: 1, latest_watched_at: "2026-08-02T11:00:00.000Z" },
      { id: "tmdb:91001", title: "Twin Title", imdb_id: "tt91001", tmdb_id: "91001", tvdb_id: "92001", episode_count: 1, latest_watched_at: "2026-08-01T11:00:00.000Z" },
    ],
    progressRows: [{
      media_key: "episode:1:2:imdb:tt81001",
      media_type: "episode",
      title: "Twin Title - S01E02",
      imdb_id: "tt81001",
      tmdb_id: "81001",
      tvdb_id: "82001",
      season: 1,
      episode: 2,
      position_ms: 370_000,
      duration_ms: 1_330_000,
      updated_at: Date.parse("2026-08-31T12:00:00.000Z"),
      source: "plex",
    }],
    playstateRows: [{
      media_key: "episode:1:1:imdb:tt81001",
      media_type: "episode",
      title: "Twin Title - S01E01",
      imdb_id: "tt81001",
      tmdb_id: "81001",
      tvdb_id: "82001",
      season: 1,
      episode: 1,
      state: "watched",
      updated_at: Date.parse("2026-08-02T11:00:00.000Z"),
    }],
    providerItems: [{
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "twin-two",
      media_type: "episode",
      title: "Twin Title - S01E02",
      show_title: "Twin Title",
      season: 1,
      episode: 2,
      show_ids: { imdb: "tt81001", tmdb: "81001", tvdb: "82001" },
      position_ms: 370_000,
      duration_ms: 1_330_000,
      updated_at: Date.parse("2026-08-31T12:00:00.000Z"),
    }],
    resolveProviderItems: async () => ({}),
  });

  const resumes = projection.items.filter((item) => item.queue_kind === "resume");
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].episode, 2);
  assert.deepEqual(resumes[0].provider_items, { plex: ["twin-two"] });
});

// Seen live (Lanterns S01E02): every playstate row of the show was an explicit
// unwatch, so the show gate rejected all three providers' resume observations
// while the ungated canonical resume row still made a card, with no native ids.
test("a new play of a show whose episodes were all explicitly unwatched keeps its native resume ids", async () => {
  // The seeded unwatch rows carry a wall-clock updated_at, so the new play
  // must be later than that to count as a play after the unwatch.
  const playedAt = Date.now() + 60_000;
  for (const episode of [1, 2]) {
    insertWatchRecordSync({
      title: `Lantern Test - S01E0${episode}`,
      show_title: "Lantern Test",
      media_type: "episode",
      season: 1,
      episode,
      show_tmdb_id: "83001",
      show_imdb_id: "tt83001",
      watched_at: "2026-09-14T11:00:00.000Z",
      source: "manual",
      sync_action: "unwatched",
    });
  }
  const unwatchedRow = (episode) => ({
    media_key: `episode:1:${episode}:imdb:tt83001`,
    media_type: "episode",
    title: `Lantern Test - S01E0${episode}`,
    imdb_id: "tt83001",
    tmdb_id: "83001",
    season: 1,
    episode,
    state: "unwatched",
    updated_at: Date.parse("2026-09-14T11:00:00.000Z"),
  });
  const providerResume = (provider, id) => ({
    provider,
    feed_kind: "resume",
    provider_item_id: id,
    media_type: "episode",
    title: "Lantern Test - S01E02",
    show_title: "Lantern Test",
    season: 1,
    episode: 2,
    show_ids: { imdb: "tt83001", tmdb: "83001" },
    position_ms: 124_170,
    duration_ms: 1_400_000,
    updated_at: playedAt,
  });

  const projection = await buildUpNextProjection({
    now: playedAt + 60_000,
    // A tracked show with no watched episode, so it has no watched signal.
    shows: [
      { id: "tmdb:83001", title: "Lantern Test", imdb_id: "tt83001", tmdb_id: "83001", episode_count: 0, latest_watched_at: null },
    ],
    progressRows: [{
      media_key: "episode:1:2:imdb:tt83001",
      media_type: "episode",
      title: "Lantern Test - S01E02",
      imdb_id: "tt83001",
      tmdb_id: "83001",
      season: 1,
      episode: 2,
      position_ms: 124_170,
      duration_ms: 1_400_000,
      updated_at: playedAt,
      source: "plex",
    }],
    playstateRows: [unwatchedRow(1), unwatchedRow(2)],
    providerItems: [
      providerResume("plex", "lantern-plex"),
      providerResume("emby", "lantern-emby"),
      // Jellyfin Resume is not a projection feed; Jellyfin lists the
      // part-watched episode in Next Up.
      { ...providerResume("jellyfin", "lantern-jf"), feed_kind: "next_up", position_ms: 0, air_date: "2026-09-01" },
    ],
    resolveProviderItems: async () => ({}),
  });

  const cards = projection.items.filter((item) => item.show_title === "Lantern Test");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].queue_kind, "resume");
  assert.equal(cards[0].episode, 2);
  assert.deepEqual(cards[0].provider_items, { emby: ["lantern-emby"], jellyfin: ["lantern-jf"], plex: ["lantern-plex"] });
});

// Seen live after defect Y: Jellyfin listed Lanterns S01E02 only in its Resume
// feed (not in Next Up), so the card had no Jellyfin id. Jellyfin Resume is not
// a queue feed (decision 25); it may only lend its id to a canonical resume.
const jellyfinResumeRow = (overrides = {}) => ({
  provider: "jellyfin",
  feed_kind: "resume",
  provider_item_id: "jf-resume-two",
  media_type: "episode",
  title: "Jelly Resume - S01E02",
  show_title: "Jelly Resume",
  season: 1,
  episode: 2,
  show_ids: { imdb: "tt84001", tmdb: "84001" },
  position_ms: 300_000,
  duration_ms: 1_400_000,
  updated_at: Date.parse("2026-09-20T12:00:00.000Z"),
  ...overrides,
});
const jellyfinResumeShows = [
  { id: "tmdb:84001", title: "Jelly Resume", imdb_id: "tt84001", tmdb_id: "84001", episode_count: 1, latest_watched_at: "2026-09-01T11:00:00.000Z" },
];

test("a Jellyfin Resume row adds its id to the canonical resume card without changing it", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-21T12:00:00.000Z"),
    localFallback: false,
    shows: jellyfinResumeShows,
    progressRows: [{
      media_key: "episode:1:2:imdb:tt84001",
      media_type: "episode",
      title: "Jelly Resume - S01E02",
      imdb_id: "tt84001",
      tmdb_id: "84001",
      season: 1,
      episode: 2,
      position_ms: 124_000,
      duration_ms: 1_400_000,
      updated_at: Date.parse("2026-09-19T12:00:00.000Z"),
      source: "plex",
    }],
    playstateRows: [],
    providerItems: [
      jellyfinResumeRow(),
      {
        provider: "plex",
        feed_kind: "resume",
        provider_item_id: "plex-two",
        media_type: "episode",
        title: "Jelly Resume - S01E02",
        show_title: "Jelly Resume",
        season: 1,
        episode: 2,
        show_ids: { imdb: "tt84001", tmdb: "84001" },
        position_ms: 124_000,
        duration_ms: 1_400_000,
        updated_at: Date.parse("2026-09-19T12:00:00.000Z"),
      },
    ],
  });

  const cards = projection.items.filter((item) => item.show_title === "Jelly Resume");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].queue_kind, "resume");
  assert.equal(cards[0].episode, 2);
  // The canonical position stands; the Jellyfin row's newer 300s does not.
  assert.equal(cards[0].position_ms, 124_000);
  assert.deepEqual(cards[0].provider_items, { jellyfin: ["jf-resume-two"], plex: ["plex-two"] });
});

test("a Jellyfin Resume row with no canonical resume creates no card", async () => {
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-21T12:00:00.000Z"),
    localFallback: false,
    shows: jellyfinResumeShows,
    progressRows: [],
    playstateRows: [],
    providerItems: [jellyfinResumeRow()],
  });

  assert.equal(projection.items.find((item) => item.show_title === "Jelly Resume"), undefined);
});

// Verified live (step 3 repeat): Plex's 2026 Scrubs S01E05 and Jellyfin's 2001
// Scrubs S01E05 share the year-stripped title key, and the uncertain-queue
// collapse kept only one of them.
test("same-title shows with conflicting ids each keep their own next-up card", async () => {
  const observation = (id, showTitle, tmdb, tvdb) => ({
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: id,
    media_type: "episode",
    title: `${showTitle} - S01E05`,
    show_title: showTitle,
    season: 1,
    episode: 5,
    show_ids: { tmdb, tvdb },
    air_date: "2026-08-22",
  });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [
      { id: "tmdb:74001", title: "Twin Title", tmdb_id: "74001", tvdb_id: "74101", latest_watched_at: "2026-08-02T11:00:00.000Z" },
      { id: "tmdb:74002", title: "Twin Title (2026)", tmdb_id: "74002", tvdb_id: "74102", latest_watched_at: "2026-08-03T11:00:00.000Z" },
    ],
    progressRows: [],
    playstateRows: [],
    providerItems: [
      observation("twin-original-five", "Twin Title", "74001", "74101"),
      observation("twin-reboot-five", "Twin Title (2026)", "74002", "74102"),
    ],
  });

  const ids = projection.items.flatMap((item) => item.provider_items?.jellyfin || []).sort();
  assert.deepEqual(ids, ["twin-original-five", "twin-reboot-five"]);
});

test("a same-title show's watch does not vouch by title for a show with conflicting ids", async () => {
  // Jellyfin titles the UK The Assembly "The Assembly", the Australian show's
  // name, and that show's one watch kept a cleared UK show in Up Next.
  const observation = (id, episode, tmdb, tvdb) => ({
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: id,
    media_type: "episode",
    title: `Shared Assembly - S01E0${episode}`,
    show_title: "Shared Assembly",
    season: 1,
    episode,
    show_ids: { tmdb, tvdb },
    air_date: "2026-08-22",
  });
  const projection = await buildUpNextProjection({
    now: Date.parse("2026-09-01T12:00:00.000Z"),
    localFallback: false,
    shows: [
      { id: "tmdb:76001", title: "Shared Assembly", tmdb_id: "76001", tvdb_id: "76101", latest_watched_at: "2025-05-10T00:00:00.000Z" },
      { id: "tvdb:76102", title: "Shared Assembly (UK)", tvdb_id: "76102", latest_watched_at: "" },
    ],
    progressRows: [],
    playstateRows: [{
      media_key: "episode:1:4:tvdb:76102",
      media_type: "episode",
      title: "Shared Assembly (UK) - S01E04",
      show_title: "Shared Assembly (UK)",
      show_tvdb_id: "76102",
      season: 1,
      episode: 4,
      state: "unwatched",
      updated_at: Date.parse("2026-08-30T11:00:00.000Z"),
    }],
    providerItems: [
      observation("uk-five", 5, "76002", "76102"),
      observation("au-five", 5, "76001", "76101"),
    ],
  });

  const ids = projection.items.flatMap((item) => item.provider_items?.jellyfin || []);
  assert.deepEqual(ids, ["au-five"]);
  assert.equal(projection.items[0].show_latest_watched_at, "2025-05-10T00:00:00.000Z");
});
