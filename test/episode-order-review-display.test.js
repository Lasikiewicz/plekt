import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mergeShowWithLoadedHistory } = await import("../public/modules/media-detail-show.js");
const { state } = await import("../public/modules/state.js");

test("an older summary unwatch tombstone cannot hide a newer approved DVD detail watch", () => {
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
      sync_action: "unwatched",
      watched_at: "2026-10-01T12:00:00.000Z",
      created_at: 1790856000000,
      updated_at: 1790856000000,
    }],
  }];

  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama",
      tmdb_id: "615",
      tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
      episodes: [
        {
          title: "Futurama - S03E04",
          media_type: "episode",
          season: 3,
          episode: 4,
          display_season: 3,
          display_episode: 2,
          watch_provenance: { episode_order: { tvdbId: "73871", dvdId: 3002, airedId: 3004, order: "dvd" } },
          sync_action: "watched",
          watched_at: "2026-11-10T10:00:00.000Z",
          created_at: 1794304800000,
          updated_at: 1794304800000,
        },
        {
          title: "Futurama - S03E05",
          media_type: "episode",
          season: 3,
          episode: 5,
          display_season: 3,
          display_episode: 1,
          sync_action: "watched",
          watched_at: "2026-11-09T10:00:00.000Z",
          created_at: 1794218400000,
          updated_at: 1794218400000,
        },
      ],
    });

    const approved = merged.episodes.find((episode) => episode.season === 3 && episode.episode === 4);
    assert.ok(approved, "the newer approved watch should remain in the merged show");
    assert.equal(approved.sync_action, "watched");
    assert.deepEqual([approved.display_season, approved.display_episode], [3, 2]);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("a summary tombstone's later metadata refresh does not make its old unwatch newer", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [];
  state.showsRaw = [{
    title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
    episodes: [{
      season: 3, episode: 4, sync_action: "unwatched",
      watched_at: "2026-10-01T12:00:00.000Z",
      created_at: 1790856000000,
      updated_at: 1795000000000,
    }],
  }];
  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
      episodes: [
        {
          season: 3, episode: 4, display_season: 3, display_episode: 2,
          watch_provenance: { episode_order: { tvdbId: "73871", dvdId: 3002, airedId: 3004, order: "dvd" } },
          sync_action: "watched", watched_at: "2026-11-10T10:00:00.000Z",
          created_at: 1794304800000, updated_at: 1794304800000,
        },
        { season: 3, episode: 5, display_season: 3, display_episode: 1, sync_action: "watched", watched_at: "2026-11-09T10:00:00.000Z" },
      ],
    });
    const approved = merged.episodes.find((episode) => episode.season === 3 && episode.episode === 4);
    assert.ok(approved, "metadata refresh time must not supersede the newer watched transition");
    assert.deepEqual([approved.display_season, approved.display_episode], [3, 2]);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("a genuinely newer unwatch transition still hides a detail watch", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [];
  state.showsRaw = [{
    title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
    episodes: [{
      season: 3, episode: 4, sync_action: "unwatched",
      watched_at: "2026-11-11T12:00:00.000Z",
      created_at: 1794400000000, updated_at: 1794400000000,
    }],
  }];
  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
      season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
      episodes: [
        { season: 3, episode: 4, display_season: 3, display_episode: 2, sync_action: "watched", watched_at: "2026-11-10T10:00:00.000Z", created_at: 1794304800000 },
        { season: 3, episode: 5, display_season: 3, display_episode: 1, sync_action: "watched", watched_at: "2026-11-09T10:00:00.000Z", created_at: 1794218400000 },
      ],
    });
    assert.equal(merged.episodes.some((episode) => episode.season === 3 && episode.episode === 4), false);
    assert.deepEqual(merged.episodes.map((episode) => [episode.season, episode.episode]), [[3, 5]]);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});
