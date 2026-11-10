import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mergeShowWithLoadedHistory } = await import("../public/modules/media-detail-show.js");
const { state } = await import("../public/modules/state.js");

test("show detail keeps DVD display coordinates when canonical summary rows are merged", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [];
  state.showsRaw = [{
    title: "Futurama",
    tmdb_id: "615",
    tvdb_id: "73871",
    episodes: [{
      title: "Futurama - S03E04",
      media_type: "episode",
      season: 3,
      episode: 4,
      sync_action: "watched",
      watched_at: "2026-10-01T12:00:00.000Z",
    }],
  }];

  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama",
      tmdb_id: "615",
      tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: { "3:4": { season: 3, episode: 2 } } },
      episodes: [{
        title: "Futurama - S03E04",
        media_type: "episode",
        season: 3,
        episode: 4,
        display_season: 3,
        display_episode: 2,
        watch_provenance: { episode_order: { tvdbId: "73871", dvdId: 3002, airedId: 3004, order: "dvd" } },
        sync_action: "watched",
        watched_at: "2026-10-01T12:00:00.000Z",
      }],
    });

    assert.equal(merged.episodes.length, 1);
    assert.deepEqual(
      [merged.episodes[0].season, merged.episodes[0].episode, merged.episodes[0].display_season, merged.episodes[0].display_episode],
      [3, 4, 3, 2],
    );
    assert.deepEqual(merged.episodes[0].watch_provenance.episode_order, {
      tvdbId: "73871", dvdId: 3002, airedId: 3004, order: "dvd",
    });
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("translated show does not import summary-only canonical watches as display episodes", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [];
  state.showsRaw = [{
    title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
    episodes: [{ season: 3, episode: 4, sync_action: "watched", watched_at: "2026-10-01T12:00:00.000Z" }],
  }];
  try {
    const show = {
      title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
      episodes: [],
    };
    const merged = mergeShowWithLoadedHistory(show);
    assert.deepEqual(merged.episodes, []);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("DVD summary tombstones still suppress older annotated detail watches", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [];
  state.showsRaw = [{
    title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
    episodes: [{ season: 3, episode: 4, sync_action: "unwatched", watched_at: "2026-10-02T12:00:00.000Z" }],
  }];
  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
      episodes: [
        { season: 3, episode: 4, display_season: 3, display_episode: 2, sync_action: "watched", watched_at: "2026-10-01T12:00:00.000Z" },
        { season: 3, episode: 5, display_season: 3, display_episode: 1, sync_action: "watched", watched_at: "2026-10-01T13:00:00.000Z" },
      ],
    });
    assert.deepEqual(merged.episodes.map(({ season, episode, display_episode }) => [season, episode, display_episode]), [[3, 5, 1]]);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("a newer dashboard watch override keeps the detail row's DVD coordinates", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.showsRaw = [];
  state.history = [{
    title: "Futurama - S03E04", show_title: "Futurama", media_type: "episode",
    season: 3, episode: 4, sync_action: "watched", source: "manual",
    watched_at: "2026-10-02T12:00:00.000Z",
  }];
  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: { "3:4": { season: 3, episode: 2 } } },
      episodes: [{
        title: "Futurama - S03E04", media_type: "episode", season: 3, episode: 4,
        display_season: 3, display_episode: 2, sync_action: "watched", source: "emby",
        watched_at: "2026-10-01T12:00:00.000Z", playHistory: [{ watched_at: "2026-09-01T12:00:00.000Z" }],
      }],
    });
    assert.deepEqual(
      [merged.episodes[0].season, merged.episodes[0].episode, merged.episodes[0].display_season, merged.episodes[0].display_episode],
      [3, 4, 3, 2],
    );
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});
