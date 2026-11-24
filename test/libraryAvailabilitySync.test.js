import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-library-availability-");

const repo = await import("../server/src/utils/dataRepo.js");
const { mediaFromLibraryItem, reconcileAvailableWatchedItems } = await import("../server/src/utils/libraryAvailabilitySync.js");

function embyEpisode(overrides = {}) {
  return {
    Id: "emby-4k-reacher-s3e3",
    Type: "Episode",
    Name: "Number 2 with a Bullet",
    SeriesName: "Reacher",
    ParentIndexNumber: 3,
    IndexNumber: 3,
    ProviderIds: { Imdb: "tt-episode-3" },
    SeriesProviderIds: { Imdb: "tt-reacher" },
    UserData: { Played: false, PlayCount: 0 },
    ...overrides,
  };
}

function embyConfig() {
  return {
    plex: { disabled: true },
    emby: { baseUrl: "https://emby.example", apiKey: "key", userId: "user" },
    jellyfin: { disabled: true },
  };
}

function plexConfig() {
  return {
    plex: { baseUrl: "https://plex.example", token: "token" },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  };
}

test("library inventory media keeps series identity and exact provider item id", () => {
  const media = mediaFromLibraryItem("emby", embyEpisode());
  assert.equal(media.title, "Reacher - S03E03");
  assert.equal(media.show_title, "Reacher");
  assert.equal(media.episodeTitle, "Number 2 with a Bullet");
  assert.equal(media.ids.imdb, "tt-reacher");
  assert.deepEqual(media.provider_items, { emby: ["emby-4k-reacher-s3e3"] });
  assert.equal(media.provider_item_id, "emby-4k-reacher-s3e3");
});

test("availability reconciliation repairs a present unplayed item from canonical watched state", async () => {
  const canonical = {
    title: "Reacher - S03E03",
    show_title: "Reacher",
    media_type: "episode",
    type: "episode",
    season: 3,
    episode: 3,
    ids: { imdb: "tt-reacher" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 3,
    episode: 3,
    imdb_id: "tt-reacher",
    watched_at: "2026-09-01T21:45:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);

  const marked = [];
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => [embyEpisode()] },
    },
    markWatched: async (media, provider) => {
      marked.push({ media, provider });
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 1);
  assert.equal(marked[0].provider, "emby");
  assert.deepEqual(marked[0].media.provider_items, { emby: ["emby-4k-reacher-s3e3"] });
});

test("Plex filtered inventory repairs missing viewCount items using explicit unplayed-feed evidence", async () => {
  const canonical = {
    title: "The Walking Dead - S05E02",
    show_title: "The Walking Dead",
    media_type: "episode",
    type: "episode",
    season: 5,
    episode: 2,
    ids: { imdb: "tt-walking-dead" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 5,
    episode: 2,
    imdb_id: "tt-walking-dead",
    watched_at: "2026-09-01T22:00:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);

  let marked;
  const result = await reconcileAvailableWatchedItems(plexConfig(), {
    clients: {
      plex: { fetch: async () => [{
        ratingKey: "plex-walking-dead-s5e2",
        type: "episode",
        title: "Strangers",
        grandparentTitle: "The Walking Dead",
        parentIndex: 5,
        index: 2,
        Guid: [{ id: "imdb://tt-walking-dead-episode-2" }],
        grandparentGuid: "imdb://tt-walking-dead",
        __plembfinUnwatchedFeed: true,
      }] },
    },
    markWatched: async (media, provider) => {
      marked = { media, provider };
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 1);
  assert.equal(marked.provider, "plex");
  assert.deepEqual(marked.media.provider_items, { plex: ["plex-walking-dead-s5e2"] });
});

test("Plex incomplete inventory without filtered-feed evidence is not treated as unplayed", async () => {
  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(plexConfig(), {
    clients: {
      plex: { fetch: async () => [{
        ratingKey: "plex-incomplete-item",
        type: "episode",
        title: "Unknown",
        grandparentTitle: "Unknown Show",
        parentIndex: 1,
        index: 1,
      }] },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(markCount, 0);
  assert.equal(result.marked, 0);
  assert.equal(result.providers.plex.candidates, 0);
});

test("availability reconciliation does not overwrite a canonical unwatch", async () => {
  const canonical = {
    title: "Reacher - S03E04",
    show_title: "Reacher",
    media_type: "episode",
    type: "episode",
    season: 3,
    episode: 4,
    ids: { imdb: "tt-reacher-s3e4" },
  };
  const watched = await repo.insertWatchRecord({
    title: canonical.title,
    show_title: canonical.show_title,
    media_type: "episode",
    season: 3,
    episode: 4,
    imdb_id: "tt-reacher-s3e4",
    watched_at: "2026-09-01T21:50:00.000Z",
    source: "plex",
  });
  await repo.upsertPlaystateForMedia(canonical, "watched", watched.record.watched_at);
  await repo.upsertPlaystateForMedia(canonical, "unwatched", "2026-09-04T10:00:00.000Z");

  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => [embyEpisode({ Id: "emby-4k-reacher-s3e4", IndexNumber: 4, Name: "Dominique", ProviderIds: { Imdb: "tt-episode-4" }, SeriesProviderIds: { Imdb: "tt-reacher" } })] },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 0);
  assert.equal(markCount, 0);
});

test("an id-less episode is not marked from a same-title show's watch once its series ids resolve", async () => {
  // Two real shows titled "The Assembly": the UK one is explicitly unwatched,
  // the Australian one has a watch. Jellyfin lists the UK episode with no ids.
  const uk = { imdb: "tt8064568", tmdb: "290057", tvdb: "453869" };
  const au = { imdb: "tt33204483", tmdb: "262100", tvdb: "452480" };
  const base = { title: "The Assembly - S01E04", show_title: "The Assembly", media_type: "episode", type: "episode", season: 1, episode: 4 };
  await repo.upsertPlaystateForMedia({ ...base, ids: uk }, "unwatched", "2026-09-23T13:29:59.000Z");
  const watched = await repo.insertWatchRecord({
    title: base.title, show_title: base.show_title, media_type: "episode", season: 1, episode: 4,
    imdb_id: au.imdb, tmdb_id: au.tmdb, tvdb_id: au.tvdb, watched_at: "2026-06-16T21:26:00.000Z", source: "trakt",
  });
  await repo.upsertPlaystateForMedia({ ...base, ids: au }, "watched", watched.record.watched_at);

  const jellyfinConfig = { plex: { disabled: true }, emby: { disabled: true }, jellyfin: { baseUrl: "https://jf.example", apiKey: "key", userId: "user" } };
  const item = { Id: "jf-uk-s1e4", Type: "Episode", Name: "Gary Lineker", SeriesName: "The Assembly", SeriesId: "jf-uk-series", ParentIndexNumber: 1, IndexNumber: 4, ProviderIds: {}, UserData: { Played: false, PlayCount: 0 } };
  const run = async (resolveSeriesIdentity) => {
    const marked = [];
    await reconcileAvailableWatchedItems(jellyfinConfig, {
      clients: { jellyfin: { fetch: async () => [item] } },
      resolveSeriesIdentity,
      markWatched: async (media) => { marked.push(media); return { status: "success" }; },
    });
    return marked;
  };

  // Without series ids the title/coordinate lookup finds the Australian watch.
  assert.equal((await run(async (media) => media)).length, 1);
  let resolvedSeries = "";
  const marked = await run(async (media) => {
    resolvedSeries = media.seriesItemId;
    return { ...media, ids: { ...media.ids, ...uk } };
  });
  assert.equal(resolvedSeries, "jf-uk-series");
  assert.equal(marked.length, 0);
});

test("a failed provider inventory produces no writes and no inferred unwatch", async () => {
  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: { fetch: async () => { throw new Error("temporary library timeout"); } },
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(markCount, 0);
  assert.equal(result.marked, 0);
  assert.match(result.providers.emby.error, /temporary library timeout/);
});

test("the restore fence is checked immediately before a provider write, not for every candidate", async () => {
  // Reacher S03E03 is canonically watched from the first test; S03E09 is not.
  let fenceChecks = 0;
  let markCount = 0;
  const result = await reconcileAvailableWatchedItems(embyConfig(), {
    clients: {
      emby: {
        fetch: async () => [
          embyEpisode(),
          embyEpisode({ Id: "emby-4k-reacher-s3e9", IndexNumber: 9, Name: "Unwatched", ProviderIds: { Imdb: "tt-episode-9" } }),
        ],
      },
    },
    shouldStop: async () => {
      fenceChecks += 1;
      return true;
    },
    markWatched: async () => {
      markCount += 1;
      return { status: "success" };
    },
  });

  assert.equal(markCount, 0, "an active restore fence must still block the write");
  assert.equal(result.marked, 0);
  assert.equal(fenceChecks, 1, "only the canonically watched candidate reaches the fence");
});

test("a large availability pass yields so timers and requests are not starved", async () => {
  const items = Array.from({ length: 3000 }, (_, index) => embyEpisode({
    Id: `emby-bulk-${index}`,
    SeriesName: `Bulk Show ${index % 50}`,
    ParentIndexNumber: 1,
    IndexNumber: index + 1,
    ProviderIds: { Imdb: `tt-bulk-episode-${index}` },
    SeriesProviderIds: { Imdb: `tt-bulk-show-${index % 50}` },
  }));
  let timerRuns = 0;
  const interval = setInterval(() => { timerRuns += 1; }, 5);
  const started = Date.now();
  try {
    await reconcileAvailableWatchedItems(embyConfig(), {
      clients: { emby: { fetch: async () => items } },
      markWatched: async () => ({ status: "success" }),
    });
  } finally {
    clearInterval(interval);
  }
  const elapsed = Date.now() - started;
  // Only meaningful when the pass is long enough to need a yield at all.
  if (elapsed > 100) assert.ok(timerRuns > 0, `a ${elapsed} ms pass never let a timer run`);
});

test("Jellyfin episode with episode-level TVDB/IMDb ids (no SeriesProviderIds) is repaired once series ids resolve", async () => {
  const seriesIds = { imdb: "tt18332852", tmdb: "207484", tvdb: "429964" };
  // Seed two watched episodes so the show establishes a proven sole series profile
  // (the exact condition where disagreesWithSoleProfile rejects episode-level TVDB ids).
  for (const [ep, watchedAt] of [[8, "2026-11-07T19:09:59.000Z"], [9, "2026-11-20T23:07:50.000Z"]]) {
    const title = `Outlander: Blood of My Blood - S02E0${ep}`;
    await repo.insertWatchRecord({
      title,
      show_title: "Outlander: Blood of My Blood",
      media_type: "episode",
      season: 2,
      episode: ep,
      imdb_id: seriesIds.imdb,
      tmdb_id: seriesIds.tmdb,
      tvdb_id: seriesIds.tvdb,
      watched_at: watchedAt,
      source: "plex",
    });
    await repo.upsertPlaystateForMedia({
      title,
      show_title: "Outlander: Blood of My Blood",
      media_type: "episode",
      type: "episode",
      season: 2,
      episode: ep,
      ids: seriesIds,
    }, "watched", watchedAt);
  }
  repo.invalidateSeriesIdentityIndex();

  const jellyfinConfig = {
    plex: { disabled: true },
    emby: { disabled: true },
    jellyfin: { baseUrl: "https://jf.example", apiKey: "key", userId: "user" },
  };
  const unplayedEpisode = {
    Id: "jf-4k-outlander-s2e9",
    Type: "Episode",
    Name: "Another Man's Shadow",
    SeriesName: "Outlander: Blood of My Blood",
    SeriesId: "jf-4k-series",
    ParentIndexNumber: 2,
    IndexNumber: 9,
    // Real Jellyfin /Items responses include episode-level ProviderIds and no SeriesProviderIds.
    ProviderIds: { Tvdb: "11982499", Imdb: "tt39602099" },
    UserData: { Played: false, PlayCount: 0 },
  };

  // Confirm raw episode-level ids alone are rejected by the proven series profile.
  assert.equal(await repo.getCanonicalWatchState(mediaFromLibraryItem("jellyfin", unplayedEpisode)), null);

  const marked = [];
  const resolvedSeriesCalls = [];
  const result = await reconcileAvailableWatchedItems(jellyfinConfig, {
    clients: { jellyfin: { fetch: async () => [unplayedEpisode] } },
    resolveSeriesIdentity: async (media) => {
      resolvedSeriesCalls.push({ seriesItemId: media.seriesItemId, ids: { ...media.ids } });
      return { ...media, ids: { ...media.ids, ...seriesIds } };
    },
    markWatched: async (media, provider) => {
      marked.push({ media, provider });
      return { status: "success" };
    },
  });

  assert.equal(result.marked, 1);
  assert.equal(resolvedSeriesCalls.length, 1);
  assert.deepEqual(resolvedSeriesCalls[0], { seriesItemId: "jf-4k-series", ids: {} });
  assert.deepEqual(marked[0].media.provider_items, { jellyfin: ["jf-4k-outlander-s2e9"] });
  assert.deepEqual(marked[0].media.ids, seriesIds);

  // If series lookup fails (returns no series ids), do not falsely mark on coordinate alone.
  const failedLookupMarked = [];
  const failedLookupResult = await reconcileAvailableWatchedItems(jellyfinConfig, {
    clients: { jellyfin: { fetch: async () => [unplayedEpisode] } },
    resolveSeriesIdentity: async (media) => media,
    markWatched: async (media) => {
      failedLookupMarked.push(media);
      return { status: "success" };
    },
  });
  assert.equal(failedLookupResult.marked, 0);
  assert.equal(failedLookupMarked.length, 0);

  // If series lookup resolves to a different show sharing the same title, skip it.
  const wrongShowMarked = [];
  const wrongShowResult = await reconcileAvailableWatchedItems(jellyfinConfig, {
    clients: { jellyfin: { fetch: async () => [unplayedEpisode] } },
    resolveSeriesIdentity: async (media) => ({ ...media, ids: { imdb: "tt99999999", tmdb: "999999", tvdb: "999999" } }),
    markWatched: async (media) => {
      wrongShowMarked.push(media);
      return { status: "success" };
    },
  });
  assert.equal(wrongShowResult.marked, 0);
  assert.equal(wrongShowMarked.length, 0);
});
