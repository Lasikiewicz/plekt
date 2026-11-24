import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mergeShowWithLoadedHistory, patchShowModalEpisodeFromLive } = await import("../public/modules/media-detail-show.js");
const { state, elements } = await import("../public/modules/state.js");

test("show detail unwatch tombstones do not resurrect an older dashboard watch", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [{
    id: "old-watch",
    title: "Reacher - S04E05",
    show_title: "Reacher",
    media_type: "episode",
    season: 4,
    episode: 5,
    watched_at: "2026-09-05T20:09:00.000Z",
    sync_action: "watched",
  }];
  state.showsRaw = [{
    title: "Reacher",
    tmdb_id: "108978",
    episodes: [{
      id: "unwatch-transition",
      title: "Reacher - S04E05",
      show_title: "Reacher",
      media_type: "episode",
      season: 4,
      episode: 5,
      watched_at: "2026-09-08T10:19:31.052Z",
      sync_action: "unwatched",
      source: "emby",
    }],
  }];

  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Reacher",
      tmdb_id: "108978",
      episode_count: 28,
      episodes: [
        {
          id: "old-watch",
          title: "Reacher - S04E05",
          show_title: "Reacher",
          media_type: "episode",
          season: 4,
          episode: 5,
          watched_at: "2026-09-05T20:09:00.000Z",
          sync_action: "watched",
          source: "manual",
        },
        {
          id: "s04e04-watch",
          title: "Reacher - S04E04",
          show_title: "Reacher",
          media_type: "episode",
          season: 4,
          episode: 4,
          watched_at: "2026-09-05T19:24:00.000Z",
          sync_action: "watched",
          source: "manual",
        },
      ],
    });

    assert.deepEqual(
      merged.episodes.map((episode) => [episode.season, episode.episode]),
      [[4, 4]],
    );
    assert.equal(merged.episode_count, 28);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("a stale provider watch cannot repaint an episode after its local unwatch", () => {
  const previous = {
    mediaDetailInline: state.mediaDetailInline,
    activeShowRenderContext: state.activeShowRenderContext,
    showModalEpisodes: state.showModalEpisodes,
    explorerPanel: elements.explorerPanel,
  };
  const tombstone = {
    id: "unwatch-transition",
    title: "Reacher - S04E03",
    show_title: "Reacher",
    media_type: "episode",
    season: 4,
    episode: 3,
    media_key: "episode:4:3:imdb:tt9288030",
    watched_at: "2026-09-08T11:19:37.776Z",
    sync_action: "unwatched",
    source: "manual",
  };
  const target = {
    key: "reacher:s04e03",
    showTitle: "Reacher",
    seasonNumber: 4,
    episodeNumber: 3,
    watched: null,
    progress: null,
  };

  state.mediaDetailInline = true;
  elements.explorerPanel = { querySelectorAll: () => [], querySelector: () => null };
  state.activeShowRenderContext = {
    show: { title: "Reacher", tmdb_id: "108978", episodes: [tombstone] },
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: false,
    watchHistoryLoading: false,
  };
  state.showModalEpisodes = [target];

  try {
    const staleProviderWatch = {
      ...tombstone,
      id: "provider-watch",
      media_key: "episode:4:3:tvdb:stale-provider-id",
      source: "jellyfin",
      sync_action: "watched",
      watched_at: "2026-09-05T19:38:00.000Z",
    };
    assert.equal(patchShowModalEpisodeFromLive({
      change: {
        sourceTable: "watch_history",
        mediaType: "episode",
        showTitle: "Reacher",
        mediaKey: staleProviderWatch.media_key,
        season: 4,
        episode: 3,
      },
      row: staleProviderWatch,
    }), true);
    assert.equal(target.watched, null);
    assert.equal(state.activeShowRenderContext.show.episodes[0].sync_action, "unwatched");

    const laterProviderWatch = {
      ...staleProviderWatch,
      id: "provider-watch-later",
      watched_at: "2026-09-09T19:38:00.000Z",
    };
    patchShowModalEpisodeFromLive({
      change: {
        sourceTable: "watch_history",
        mediaType: "episode",
        showTitle: "Reacher",
        mediaKey: laterProviderWatch.media_key,
        season: 4,
        episode: 3,
      },
      row: laterProviderWatch,
    });
    assert.equal(target.watched.id, "provider-watch-later");
  } finally {
    state.mediaDetailInline = previous.mediaDetailInline;
    state.activeShowRenderContext = previous.activeShowRenderContext;
    state.showModalEpisodes = previous.showModalEpisodes;
    elements.explorerPanel = previous.explorerPanel;
  }
});

test("mergeShowWithLoadedHistory keeps telemetry, provenance, and imdb_id when state.history holds a compact preview of the same row", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.showsRaw = [];
  // Compact dashboard preview row omits imdb_id, sync_dispatch_telemetry, and watch_provenance.
  state.history = [{
    id: "ep-s02e09",
    title: "Outlander: Blood of My Blood - S02E09",
    show_title: "Outlander: Blood of My Blood",
    media_type: "episode",
    season: 2,
    episode: 9,
    watched_at: "2026-11-20T23:07:50.000Z",
    sync_action: "watched",
    source: "plex",
    tmdb_id: "207484",
    tvdb_id: "429964",
    media_key: "episode:2:9:imdb:tt18332852",
  }, {
    id: "ep-s02e08-newer",
    title: "Outlander: Blood of My Blood - S02E08",
    show_title: "Outlander: Blood of My Blood",
    media_type: "episode",
    season: 2,
    episode: 8,
    watched_at: "2026-11-21T20:00:00.000Z",
    sync_action: "watched",
    source: "plex",
    tmdb_id: "207484",
    tvdb_id: "429964",
    media_key: "episode:2:8:imdb:tt18332852",
  }];

  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Outlander: Blood of My Blood",
      tmdb_id: "207484",
      tvdb_id: "429964",
      imdb_id: "tt18332852",
      episodes: [{
        id: "ep-s02e09",
        title: "Outlander: Blood of My Blood - S02E09",
        show_title: "Outlander: Blood of My Blood",
        media_type: "episode",
        season: 2,
        episode: 9,
        watched_at: "2026-11-20T23:07:50.000Z",
        sync_action: "watched",
        source: "plex",
        imdb_id: "tt18332852",
        tmdb_id: "207484",
        tvdb_id: "429964",
        media_key: "episode:2:9:imdb:tt18332852",
        sync_dispatch_telemetry: "Origin: plex\nDispatch status: success",
        watch_provenance: { version: 1, source: "plex", ingest_path: "plex_notification" },
      }, {
        id: "ep-s02e08-older",
        title: "Outlander: Blood of My Blood - S02E08",
        show_title: "Outlander: Blood of My Blood",
        media_type: "episode",
        season: 2,
        episode: 8,
        watched_at: "2026-11-07T19:09:59.000Z",
        sync_action: "watched",
        source: "plex",
        imdb_id: "tt18332852",
        tmdb_id: "207484",
        tvdb_id: "429964",
        media_key: "episode:2:8:imdb:tt18332852",
        sync_dispatch_telemetry: "Origin: plex\nDispatch status: success\nDetails: Old row telemetry",
        watch_provenance: { version: 1, source: "plex", ingest_path: "live_session" },
      }],
    });

    const ep9 = merged.episodes.find((ep) => ep.season === 2 && ep.episode === 9);
    assert.equal(ep9.imdb_id, "tt18332852");
    assert.equal(ep9.sync_dispatch_telemetry, "Origin: plex\nDispatch status: success");
    assert.deepEqual(ep9.watch_provenance, { version: 1, source: "plex", ingest_path: "plex_notification" });

    // A genuinely newer watch row with a different id must not inherit the older row's telemetry/provenance.
    const ep8 = merged.episodes.find((ep) => ep.season === 2 && ep.episode === 8);
    assert.equal(ep8.id, "ep-s02e08-newer");
    assert.equal(ep8.imdb_id, "tt18332852");
    assert.equal(ep8.sync_dispatch_telemetry, undefined);
    assert.equal(ep8.watch_provenance, undefined);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});
