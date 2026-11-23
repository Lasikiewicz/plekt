import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalUpNextKey,
  mergeUpNextCandidates,
  normalizeUpNextCandidate,
  sortUpNextItems,
  upNextOrderKey,
} from "../server/src/utils/upNextIdentity.js";

function plexEpisode(overrides = {}) {
  return {
    provider: "plex",
    feed_kind: "resume",
    item: {
      type: "episode",
      ratingKey: "plex-episode-1",
      grandparentRatingKey: "plex-series-1",
      grandparentTitle: "The Expanse",
      grandparentGuid: "tmdb://123",
      parentIndex: 2,
      index: 5,
      title: "Home",
      viewOffset: 120000,
      duration: 240000,
      lastViewedAt: 100,
      ...overrides,
    },
  };
}

test("provider episode observations share one canonical identity and keep native ids", () => {
  const merged = mergeUpNextCandidates([
    plexEpisode(),
    {
      provider: "emby",
      feed_kind: "next_up",
      provider_item_id: "emby-episode-1",
      media_type: "episode",
      title: "The Expanse - S02E05",
      show_title: "The Expanse",
      episode_title: "Home",
      season: 2,
      episode: 5,
      show_ids: { tmdb: "123" },
      queue_kind: "next_up",
      air_date: "2017-02-01",
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].queue_kind, "resume");
  assert.equal(merged[0].canonical_key, "episode|series:tmdb:123|s:2|e:5");
  assert.deepEqual(merged[0].provider_items, {
    emby: ["emby-episode-1"],
    plex: ["plex-episode-1"],
  });
});

test("Plex parent GUID aliases preserve the series identity", () => {
  const candidate = normalizeUpNextCandidate({
    provider: "plex",
    feed_kind: "next_up",
    item: {
      type: "episode",
      ratingKey: "plex-episode-upper-case",
      grandparentRatingKey: "plex-series-upper-case",
      grandparentTitle: "The Expanse",
      grandparentGUID: "tmdb://123",
      parentIndex: 2,
      index: 5,
      title: "Home",
    },
  });

  assert.equal(candidate.show_tmdb_id, "123");
  assert.equal(candidate.canonical_key, "episode|series:tmdb:123|s:2|e:5");
});

test("title-only episode observations merge into the one compatible verified series", () => {
  const merged = mergeUpNextCandidates([
    {
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-episode-5",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      season: 1,
      episode: 5,
      show_ids: { imdb: "tt38807772" },
      position_ms: 618000,
      duration_ms: 3221680,
      updated_at: 200,
    },
    {
      source: "local",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      season: 1,
      episode: 5,
      position_ms: 614000,
      duration_ms: 3221680,
      updated_at: 100,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "episode|series:imdb:tt38807772|s:1|e:5");
  assert.equal(merged[0].show_imdb_id, "tt38807772");
  assert.deepEqual(merged[0].provider_items, { emby: ["emby-episode-5"] });
});

test("title-only movie observations merge with one unambiguous identified movie across providers", () => {
  const merged = mergeUpNextCandidates([
    {
      source: "plex",
      media_type: "movie",
      queue_kind: "resume",
      title: "Moana",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
    },
    {
      provider: "jellyfin",
      feed_kind: "resume",
      provider_item_id: "jellyfin-moana",
      media_type: "movie",
      title: "Moana",
      ids: { tmdb: "1108427" },
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "movie|id:tmdb:1108427");
  assert.deepEqual(merged[0].provider_items, { jellyfin: ["jellyfin-moana"] });
});

test("title-only episode observations stay separate when two verified reboots are possible", () => {
  const merged = mergeUpNextCandidates([
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-a" },
    },
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
      show_ids: { tvdb: "series-b" },
    },
    {
      media_type: "episode",
      title: "The Returned - S01E01",
      show_title: "The Returned",
      season: 1,
      episode: 1,
    },
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((item) => item.canonical_key).sort(),
    [
      "episode|series:tvdb:series-a|s:1|e:1",
      "episode|series:tvdb:series-b|s:1|e:1",
      "episode|title:the-returned|s:1|e:1",
    ],
  );
});

test("native series identity bridges to a matching external provider id", () => {
  const merged = mergeUpNextCandidates([
    {
      source: "local",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      show_ids: { tvdb: "10652667" },
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 618000,
      duration_ms: 3221680,
    },
    {
      provider: "emby",
      provider_item_id: "12601",
      series_provider_item_id: "10723",
      media_type: "episode",
      title: "The War Between the Land and the Sea - S01E05",
      show_title: "The War Between the Land and the Sea",
      ids: { tvdb: "10652667" },
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 618000,
      duration_ms: 3221680,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "episode|series:tvdb:10652667|s:1|e:5");
  assert.deepEqual(merged[0].provider_items, { emby: ["12601"] });
});

test("native series identity keeps same-title series separate when external ids are absent", () => {
  const first = normalizeUpNextCandidate({
    provider: "jellyfin",
    provider_item_id: "episode-a",
    series_provider_item_id: "series-a",
    media_type: "episode",
    title: "Pilot",
    show_title: "The Returned",
    season: 1,
    episode: 1,
  });
  const second = normalizeUpNextCandidate({
    provider: "jellyfin",
    provider_item_id: "episode-b",
    series_provider_item_id: "series-b",
    media_type: "episode",
    title: "Pilot",
    show_title: "The Returned",
    season: 1,
    episode: 1,
  });

  assert.notEqual(first.canonical_key, second.canonical_key);
  assert.equal(mergeUpNextCandidates([first, second]).length, 2);
});

test("shared episode external ids merge provider-native series identities", () => {
  const rows = [
    {
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "plex-episode",
      series_provider_item_id: "plex-series",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      ids: { imdb: "tt38494464", tvdb: "11767183" },
      position_ms: 1,
      duration_ms: 100,
    },
    {
      provider: "emby",
      feed_kind: "resume",
      provider_item_id: "emby-episode",
      series_provider_item_id: "emby-series",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond’s Got Talent",
      season: 4,
      episode: 3,
      ids: { imdb: "tt38494464", tvdb: "11767183" },
    },
    {
      provider: "jellyfin",
      feed_kind: "next_up",
      provider_item_id: "jellyfin-episode",
      series_provider_item_id: "jellyfin-series",
      media_type: "episode",
      title: "Ted Lasso - S04E03",
      show_title: "Ted Lasso",
      episode_title: "Richmond's Got Talent",
      season: 4,
      episode: 3,
      ids: { imdb: "tt38494464", tvdb: "11767183" },
    },
  ];

  const merged = mergeUpNextCandidates(rows);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].provider_items, {
    emby: ["emby-episode"],
    jellyfin: ["jellyfin-episode"],
    plex: ["plex-episode"],
  });
  assert.equal(merged[0].queue_kind, "resume");
});

test("native-series next-up bridges the identical episode keyed only by an external show id", () => {
  // Mirrors two same-show observations in a real rail: a Jellyfin "next up" row
  // keyed only by its native series id, plus a local observation keyed by the
  // verified external (IMDb) show id, both describing Ted Lasso S04E03 with an
  // apostrophe that differs only by typographic character.
  const native = {
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: "native-episode-x",
    series_provider_item_id: "native-series-x",
    media_type: "episode",
    title: "Ted Lasso - S04E03",
    show_title: "Ted Lasso",
    episode_title: "Richmond's Got Talent",
    season: 4,
    episode: 3,
    queue_kind: "next_up",
    air_date: "2026-08-17T23:00:00.0000000Z",
  };
  const external = {
    source: "local",
    media_type: "episode",
    title: "Ted Lasso - S04E03",
    show_title: "Ted Lasso",
    episode_title: "Richmond’s Got Talent",
    season: 4,
    episode: 3,
    queue_kind: "next_up",
    show_ids: { imdb: "tt10986410" },
    air_date: "2026-08-17",
  };

  const merged = mergeUpNextCandidates([native, external]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "episode|series:imdb:tt10986410|s:4|e:3");
  // The native Jellyfin provider item is folded into the surviving card.
  assert.deepEqual(merged[0].provider_items.jellyfin, ["native-episode-x"]);
});

test("native resume rows with a missing provider title bridge the sole verified episode", () => {
  // Jellyfin's live row for this episode has the native series id and
  // coordinate, but no episode title or external show id. The Emby row is the
  // only verified series candidate for that exact show/coordinate.
  const native = {
    provider: "jellyfin",
    feed_kind: "resume",
    provider_item_id: "744045b1f1ea66e3a79f3b0d6cdee74",
    series_provider_item_id: "9d3ab079af5db78c86bf06b38c5982a5",
    media_type: "episode",
    title: "The Grand Tour - S07E01",
    show_title: "The Grand Tour",
    episode_title: "",
    season: 7,
    episode: 1,
    queue_kind: "resume",
    position_ms: 30_000,
    duration_ms: 600_000,
    progress: 5,
  };
  const verified = {
    provider: "emby",
    feed_kind: "resume",
    provider_item_id: "127534",
    media_type: "episode",
    title: "The Grand Tour - S07E01",
    show_title: "The Grand Tour",
    episode_title: "The Next Generation",
    season: 7,
    episode: 1,
    queue_kind: "resume",
    show_ids: { tvdb: "11884343" },
    position_ms: 36_000,
    duration_ms: 600_000,
    progress: 6,
  };

  const merged = mergeUpNextCandidates([native, verified]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].episode_title, "The Next Generation");
  assert.deepEqual(merged[0].provider_items, {
    emby: ["127534"],
    jellyfin: ["744045b1f1ea66e3a79f3b0d6cdee74"],
  });
});

test("native-series next-up does not bridge a different show that shares the title and coordinate", () => {
  // 2001 "Scrubs" S01E03 and a 2026 "Scrubs" reboot S01E03 live in the same
  // library as distinct native series. They share a show name and coordinate
  // but are different episodes (different titles and years) - they must stay
  // separate just as they do without an external-id bridge.
  const original = {
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: "episode-2001",
    series_provider_item_id: "series-2001",
    media_type: "episode",
    title: "Scrubs - S01E03",
    show_title: "Scrubs",
    episode_title: "My Best Friend's Mistake",
    season: 1,
    episode: 3,
    queue_kind: "next_up",
    year: 2001,
    air_date: "2001-10-08",
  };
  const reboot = {
    source: "local",
    media_type: "episode",
    title: "Scrubs - S01E03",
    show_title: "Scrubs",
    episode_title: "My Rom-Com",
    season: 1,
    episode: 3,
    queue_kind: "next_up",
    show_ids: { imdb: "tt40197357" },
    year: 2026,
    air_date: "2026-03-04",
  };
  const merged = mergeUpNextCandidates([original, reboot]);
  assert.equal(merged.length, 2);
});

test("native-series next-up does not bridge a same-title reboot that aired a different year", () => {
  const original = {
    provider: "jellyfin",
    feed_kind: "next_up",
    provider_item_id: "episode-x",
    series_provider_item_id: "series-2001",
    media_type: "episode",
    title: "Showcase - S01E01",
    show_title: "Showcase",
    episode_title: "Episode One",
    season: 1,
    episode: 1,
    queue_kind: "next_up",
    year: 2001,
    air_date: "2001-02-01",
  };
  const reboot = {
    source: "local",
    media_type: "episode",
    title: "Showcase - S01E01",
    show_title: "Showcase",
    episode_title: "Episode One",
    season: 1,
    episode: 1,
    queue_kind: "next_up",
    show_ids: { imdb: "tt999000" },
    year: 2026,
    air_date: "2026-02-01",
  };
  assert.equal(mergeUpNextCandidates([original, reboot]).length, 2);
});

test("same-title movies only merge with a verified identity or matching year", () => {
  const remake = { media_type: "movie", title: "The Thing", year: 1982, source: "plex", provider_item_id: "movie-1982" };
  const newer = { media_type: "movie", title: "The Thing", year: 2011, source: "emby", provider_item_id: "movie-2011" };
  assert.notEqual(canonicalUpNextKey(remake), canonicalUpNextKey(newer));
  assert.equal(mergeUpNextCandidates([remake, newer]).length, 2);

  const verified = mergeUpNextCandidates([
    { ...remake, ids: { imdb: "tt0084787" } },
    { media_type: "movie", title: "The Thing", year: 1982, source: "jellyfin", provider_item_id: "movie-copy", ids: { imdb: "tt0084787" } },
  ]);
  assert.equal(verified.length, 1);
});

test("title-only movie resumes merge with the single same-provider identified item", () => {
  const merged = mergeUpNextCandidates([
    {
      source: "plex",
      media_type: "movie",
      title: "Moana",
      queue_kind: "resume",
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
      is_canonical: true,
    },
    {
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "43844",
      media_type: "movie",
      title: "Moana",
      queue_kind: "resume",
      ids: { imdb: "tt27419466", tmdb: "1108427" },
      position_ms: 360000,
      duration_ms: 6000000,
      progress: 6,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_key, "movie|id:imdb:tt27419466");
  assert.equal(merged[0].imdb_id, "tt27419466");
  assert.deepEqual(merged[0].provider_items, { plex: ["43844"] });
});

test("title-only movie resumes stay separate when same-title provider items are ambiguous", () => {
  const merged = mergeUpNextCandidates([
    {
      source: "plex",
      media_type: "movie",
      title: "The Thing",
      queue_kind: "resume",
      position_ms: 300000,
      duration_ms: 6000000,
      progress: 5,
      is_canonical: true,
    },
    {
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "movie-1982",
      media_type: "movie",
      title: "The Thing",
      year: 1982,
      queue_kind: "resume",
      ids: { imdb: "tt0084787" },
    },
    {
      provider: "plex",
      feed_kind: "resume",
      provider_item_id: "movie-2011",
      media_type: "movie",
      title: "The Thing",
      year: 2011,
      queue_kind: "resume",
      ids: { imdb: "tt0905372" },
    },
  ]);

  assert.equal(merged.length, 3);
});

test("resume cards sort before stable next-up cards", () => {
  const items = mergeUpNextCandidates([
    { media_type: "movie", title: "Older resume", ids: { tmdb: "1" }, queue_kind: "resume", position_ms: 100, duration_ms: 1000, updated_at: 100 },
    { media_type: "movie", title: "Newer resume", ids: { tmdb: "2" }, queue_kind: "resume", position_ms: 100, duration_ms: 1000, updated_at: 200 },
    { media_type: "episode", title: "Show B", show_title: "Show B", show_ids: { tmdb: "3" }, season: 1, episode: 2, queue_kind: "next_up", air_date: "2026-01-01" },
    { media_type: "episode", title: "Show A", show_title: "Show A", show_ids: { tmdb: "4" }, season: 1, episode: 1, queue_kind: "next_up", air_date: "2026-01-02" },
  ]);

  assert.deepEqual(items.map((item) => item.title), ["Newer resume", "Older resume", "Show A - S01E01", "Show B - S01E02"]);
});

test("next-up cards prioritize the show watched most recently", () => {
  const items = mergeUpNextCandidates([
    { media_type: "episode", title: "Ted Lasso - S03E02", show_title: "Ted Lasso", show_ids: { tmdb: "97546" }, season: 3, episode: 2, queue_kind: "next_up", show_latest_watched_at: "2026-08-28T20:00:00.000Z" },
    { media_type: "episode", title: "Reacher - S03E08", show_title: "Reacher", show_ids: { tmdb: "108978" }, season: 3, episode: 8, queue_kind: "next_up", show_latest_watched_at: "2026-09-03T20:00:00.000Z" },
  ]);

  assert.deepEqual(items.map((item) => item.show_title), ["Reacher", "Ted Lasso"]);
});

test("custom order follows the show as its queued episode advances and keeps rewatch lanes distinct", () => {
  const show = { media_type: "episode", show_tmdb_id: "123", season: 1, episode: 1, queue_kind: "next_up" };
  const advanced = { ...show, episode: 2 };
  const other = { ...show, show_tmdb_id: "456", show_title: "A different show" };
  assert.equal(upNextOrderKey(show), upNextOrderKey(advanced));
  assert.notEqual(upNextOrderKey({ ...show, up_next_lane: "rewatch" }), upNextOrderKey(show));
  assert.deepEqual(sortUpNextItems([other, advanced], { sort: "custom", customOrder: [upNextOrderKey(show)] }), [advanced, other]);
});

test("newly_aired sort puts newly aired episodes first while keeping known resumes at the front", async () => {
  const { sortUpNextItems } = await import("../server/src/utils/upNextIdentity.js");
  const sorted = sortUpNextItems([
    { id: "older-watch-new-air", show_title: "Fresh Show", media_type: "episode", queue_kind: "next_up", air_date: "2026-09-10", show_latest_watched_at: "2026-08-01T00:00:00Z" },
    { id: "recent-watch-old-air", show_title: "Catalog Show", media_type: "episode", queue_kind: "next_up", air_date: "2021-04-01", show_latest_watched_at: "2026-09-09T00:00:00Z" },
    { id: "active-resume", show_title: "Active Resume", media_type: "episode", queue_kind: "resume", playback_position_known: true, air_date: "2018-01-01", updated_at: 1000 },
    { id: "missing-air", show_title: "Undated Show", media_type: "episode", queue_kind: "next_up", show_latest_watched_at: "2026-09-11T00:00:00Z" },
  ], { sort: "newly_aired" });

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["active-resume", "older-watch-new-air", "recent-watch-old-air", "missing-air"],
  );
  assert.deepEqual(
    sortUpNextItems(sorted, { sort: "newly_aired", partWatchedFirst: false }).map((item) => item.id),
    ["older-watch-new-air", "recent-watch-old-air", "active-resume", "missing-air"],
  );
  assert.deepEqual(
    sortUpNextItems(sorted, { sort: "oldest_unwatched", partWatchedFirst: false }).map((item) => item.id),
    ["active-resume", "recent-watch-old-air", "older-watch-new-air", "missing-air"],
  );

  const merged = mergeUpNextCandidates([
    {
      provider: "plex",
      feed_kind: "next_up",
      provider_item_id: "plex-ep-1",
      media_type: "episode",
      title: "Show Air - S02E01",
      show_title: "Show Air",
      season: 2,
      episode: 1,
      queue_kind: "next_up",
      show_ids: { tvdb: "112233" },
      item: { originallyAvailableAt: "2026-09-05" },
    },
  ]);
  assert.equal(merged[0].air_date, "2026-09-05");
});

