import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-media-force-sync-canonical-");

const repo = await import("../server/src/utils/dataRepo.js");
const { getSyncHistory } = await import("../server/src/utils/configStore.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { forceSyncMediaState } = await import("../server/src/utils/mediaForceSync.js");

function canonicalFixture(id, syncAction, updatedAt) {
  return {
    id,
    title: "Canonical Order - S01E01",
    show_title: "Canonical Order",
    media_type: "episode",
    season: 1,
    episode: 1,
    watched_at: new Date(updatedAt).toISOString(),
    sync_action: syncAction,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

test("dedupeHistory keeps the newest canonical transition regardless of state or row order", () => {
  const olderWatched = canonicalFixture("older-watched", "watched", 1_000);
  const newerUnwatched = canonicalFixture("newer-unwatched", "unwatched", 2_000);
  const olderUnwatched = canonicalFixture("older-unwatched", "unwatched", 3_000);
  const newerWatched = canonicalFixture("newer-watched", "watched", 4_000);

  for (const rows of [[olderWatched, newerUnwatched], [newerUnwatched, olderWatched]]) {
    assert.equal(repo.dedupeHistory(rows)[0].id, "newer-unwatched");
  }
  for (const rows of [[olderUnwatched, newerWatched], [newerWatched, olderUnwatched]]) {
    assert.equal(repo.dedupeHistory(rows)[0].id, "newer-watched");
  }
});

test("metadata-only updated_at bumps cannot revive an older canonical state", () => {
  const olderWatched = canonicalFixture("metadata-watched", "watched", 1_000);
  olderWatched.updated_at = 9_000;
  const newerUnwatched = canonicalFixture("metadata-unwatched", "unwatched", 2_000);
  const olderUnwatched = canonicalFixture("artwork-unwatched", "unwatched", 3_000);
  olderUnwatched.updated_at = 10_000;
  const newerWatched = canonicalFixture("artwork-watched", "watched", 4_000);

  for (const rows of [[olderWatched, newerUnwatched], [newerUnwatched, olderWatched]]) {
    assert.equal(repo.dedupeHistory(rows)[0].id, "metadata-unwatched");
  }
  for (const rows of [[olderUnwatched, newerWatched], [newerWatched, olderUnwatched]]) {
    assert.equal(repo.dedupeHistory(rows)[0].id, "artwork-watched");
  }
});

test("canonical state is resolved across the whole identity group before choosing its display date", () => {
  const olderUnwatchedWithLaterDate = {
    ...canonicalFixture("triple-old-unwatch", "unwatched", 1_000),
    watched_at: "2026-08-30T20:00:00.000Z",
  };
  const newestUnwatchedWithEarlierDate = {
    ...canonicalFixture("triple-new-unwatch", "unwatched", 3_000),
    watched_at: "2026-08-10T20:00:00.000Z",
  };
  const middleWatched = {
    ...canonicalFixture("triple-middle-watch", "watched", 2_000),
    watched_at: "2026-08-01T20:00:00.000Z",
  };
  const rows = [olderUnwatchedWithLaterDate, newestUnwatchedWithEarlierDate, middleWatched];
  const permutations = [
    [rows[0], rows[1], rows[2]],
    [rows[0], rows[2], rows[1]],
    [rows[1], rows[0], rows[2]],
    [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]],
    [rows[2], rows[1], rows[0]],
  ];

  for (const ordered of permutations) {
    const [result] = repo.dedupeHistory(ordered);
    assert.equal(result.sync_action, "unwatched");
    assert.equal(result.id, "triple-old-unwatch", "same-state representative still follows watched_at");
    assert.equal(result.playHistory.length, 3);
  }
});

test("same-event display dedupe cannot discard a newer canonical rewatch", () => {
  const firstWatch = {
    ...canonicalFixture("rapid-first-watch", "watched", 1_000),
    watched_at: "2026-08-23T20:00:00.000Z",
  };
  const unwatch = {
    ...canonicalFixture("rapid-unwatch", "unwatched", 2_000),
    watched_at: "2026-08-23T20:02:00.000Z",
  };
  const rewatch = {
    ...canonicalFixture("rapid-rewatch", "watched", 3_000),
    watched_at: "2026-08-23T20:05:00.000Z",
  };

  const [result] = repo.dedupeHistory([firstWatch, unwatch, rewatch]);
  assert.equal(result.sync_action, "watched");
  assert.equal(result.id, "rapid-first-watch", "same-event cleanup still keeps the first display watch");
  assert.deepEqual(result.playHistory.map((entry) => entry.id), ["rapid-first-watch", "rapid-unwatch"]);
});

test("same-event provider echoes cannot replace an explicit Plembfin source", () => {
  const watchedAt = "2026-08-23T20:00:00.000Z";
  const providerEcho = {
    ...canonicalFixture("provider-echo", "watched", 1_000),
    source: "plex",
    watched_at: watchedAt,
  };
  const manualWatch = {
    ...canonicalFixture("manual-watch", "watched", 2_000),
    source: "manual",
    watched_at: watchedAt,
    sync_dispatch_telemetry: "Origin: manual\\nDispatch status: success",
  };

  const [result] = repo.dedupeHistory([providerEcho, manualWatch]);
  assert.equal(result.source, "manual");
  assert.equal(result.sync_dispatch_telemetry, manualWatch.sync_dispatch_telemetry);
  assert.deepEqual(result.playHistory.map((entry) => entry.id), ["provider-echo"]);
  assert.deepEqual(new Set(result.sources), new Set(["plex", "manual"]));
});

test("a newer provider unwatch supersedes an older explicit watched row", () => {
  const manualWatch = {
    ...canonicalFixture("manual-old-watch", "watched", 1_000),
    source: "manual",
  };
  const providerUnwatch = {
    ...canonicalFixture("jellyfin-new-unwatch", "unwatched", 2_000),
    source: "jellyfin",
  };

  for (const rows of [[manualWatch, providerUnwatch], [providerUnwatch, manualWatch]]) {
    const [result] = repo.dedupeHistory(rows);
    assert.equal(result.id, "jellyfin-new-unwatch");
    assert.equal(result.sync_action, "unwatched");
  }
});

test("a newer exact live completion supersedes an older manual unwatched tombstone", () => {
  const manualUnwatch = {
    ...canonicalFixture("manual-unwatch-before-live-watch", "unwatched", 1_000),
    source: "manual",
  };
  const liveWatch = {
    ...canonicalFixture("accepted-live-watch", "watched", 2_000),
    source: "emby",
    watch_provenance: JSON.stringify({
      source: "emby",
      ingest_path: "live_session",
      event: "playback.complete",
      phase: "completed",
      confidence: "exact",
      source_timestamp: "2026-08-23T20:05:00.000Z",
    }),
  };

  for (const rows of [[manualUnwatch, liveWatch], [liveWatch, manualUnwatch]]) {
    const [result] = repo.dedupeHistory(rows);
    assert.equal(result.id, "accepted-live-watch");
    assert.equal(result.sync_action, "watched");
  }
});

function exactLiveWatch(id, createdAt, sourceTimestamp) {
  return {
    ...canonicalFixture(id, "watched", createdAt),
    source: "emby",
    watch_provenance: JSON.stringify({
      source: "emby",
      ingest_path: "live_session",
      event: "playback.complete",
      phase: "completed",
      confidence: "exact",
      source_timestamp: sourceTimestamp,
    }),
  };
}

test("a live completion needs both clocks newer than the manual unwatch to revive it", () => {
  const unwatchedAt = Date.parse("2026-08-23T20:00:00.000Z");
  const manualUnwatch = {
    ...canonicalFixture("manual-unwatch-clock-guard", "unwatched", unwatchedAt),
    source: "manual",
  };
  // Replayed/late-ingested completion: received after the unwatch, but the
  // playback itself finished before it.
  const lateReplay = exactLiveWatch("late-replayed-live-watch", unwatchedAt + 60_000, "2026-08-23T19:55:00.000Z");
  // Provider clock running ahead: claims a later completion, but Plembfin
  // received it before the unwatch.
  const skewedClock = exactLiveWatch("skewed-clock-live-watch", unwatchedAt - 60_000, "2026-08-23T20:05:00.000Z");

  for (const liveWatch of [lateReplay, skewedClock]) {
    for (const rows of [[manualUnwatch, liveWatch], [liveWatch, manualUnwatch]]) {
      const [result] = repo.dedupeHistory(rows);
      assert.equal(result.id, "manual-unwatch-clock-guard", liveWatch.id);
      assert.equal(result.sync_action, "unwatched");
    }
  }

  const realLaterWatch = exactLiveWatch("real-later-live-watch", unwatchedAt + 300_000, "2026-08-23T20:04:00.000Z");
  for (const rows of [[manualUnwatch, realLaterWatch], [realLaterWatch, manualUnwatch]]) {
    const [result] = repo.dedupeHistory(rows);
    assert.equal(result.id, "real-later-live-watch");
    assert.equal(result.sync_action, "watched");
  }
});

test("a generic provider watch remains subordinate to a manual unwatched tombstone", () => {
  const manualUnwatch = {
    ...canonicalFixture("manual-unwatch-generic-provider", "unwatched", 1_000),
    source: "manual",
  };
  const genericProviderWatch = {
    ...canonicalFixture("generic-provider-watch", "watched", 2_000),
    source: "emby",
  };

  const [result] = repo.dedupeHistory([manualUnwatch, genericProviderWatch]);
  assert.equal(result.id, "manual-unwatch-generic-provider");
  assert.equal(result.sync_action, "unwatched");
});

test("an in-place promotion advances the canonical transition clock", async () => {
  const database = repo.requireDb();
  const insert = database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'manual', 1, 1,
            @sync_action, @media_key, @show_title, @show_title_lower, @created_at, @updated_at)`);
  const base = {
    title: "Promotion Order - S01E01",
    title_lower: "promotion order - s01e01",
    media_key: "episode:1:1:title:promotion-order",
    show_title: "Promotion Order",
    show_title_lower: "promotion order",
  };
  insert.run({ ...base, id: "promotion-old-unwatch", watched_at: "2026-08-20T20:00:00.000Z", sync_action: "unwatched", created_at: 1_000, updated_at: 9_000 });
  insert.run({ ...base, id: "promotion-new-unwatch", watched_at: "2026-08-21T20:00:00.000Z", sync_action: "unwatched", created_at: 2_000, updated_at: 2_000 });
  insert.run({ ...base, id: "promotion-delete-watch", watched_at: "2026-08-22T20:00:00.000Z", sync_action: "watched", created_at: 3_000, updated_at: 3_000 });

  const beforePromotion = Date.now();
  const deleted = await repo.deleteWatchDate("promotion-delete-watch");

  assert.equal(deleted.ok, true);
  assert.equal(deleted.remainingRow.id, "promotion-new-unwatch");
  assert.equal(deleted.remainingRow.sync_action, "watched");
  const promoted = database.prepare("SELECT sync_action, created_at, updated_at FROM watch_history WHERE id = ?").get("promotion-new-unwatch");
  assert.equal(promoted.sync_action, "watched");
  assert.ok(promoted.created_at >= beforePromotion);
  assert.equal(promoted.updated_at, promoted.created_at);
  const detail = await repo.queryShowDetail({ title: "Promotion Order" });
  assert.equal(detail.episodes[0].id, "promotion-new-unwatch");
  assert.equal(detail.episodes[0].sync_action, "watched");
});

test("a target-specific show push preserves watched and unwatched state without mutating Trakt", async () => {
  const database = repo.requireDb();
  const mediaKey = "episode:1:1:tmdb:force-sync-canonical";
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'manual', @tmdb_id, 1, 1,
            @sync_action, @media_key, @show_title, @show_title_lower, @created_at, @updated_at)`)
    .run({
      id: "walking-dead-watched",
      title: "The Walking Dead - S01E01",
      title_lower: "the walking dead - s01e01",
      watched_at: "2026-08-20T20:00:00.000Z",
      tmdb_id: "force-sync-canonical",
      sync_action: "watched",
      media_key: mediaKey,
      show_title: "The Walking Dead",
      show_title_lower: "the walking dead",
      created_at: 1_000,
      updated_at: 1_000,
    });
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES (@id, @title, @title_lower, 'episode', @watched_at, 'manual', @tmdb_id, 1, 1,
            @sync_action, @media_key, @show_title, @show_title_lower, @created_at, @updated_at)`)
    .run({
      id: "walking-dead-unwatched",
      title: "The Walking Dead - S01E01",
      title_lower: "the walking dead - s01e01",
      watched_at: "2026-08-21T20:00:00.000Z",
      tmdb_id: "force-sync-canonical",
      sync_action: "unwatched",
      media_key: mediaKey,
      show_title: "The Walking Dead",
      show_title_lower: "the walking dead",
      created_at: 2_000,
      updated_at: 2_000,
    });
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
     sync_action, media_key, show_title, show_title_lower, created_at, updated_at)
    VALUES ('walking-dead-s01e02-watched', 'The Walking Dead - S01E02',
            'the walking dead - s01e02', 'episode', '2026-08-22T20:00:00.000Z',
            'manual', 'force-sync-canonical', 1, 2, 'watched',
            'episode:1:2:tmdb:force-sync-canonical', 'The Walking Dead',
            'the walking dead', 3_000, 3_000)`)
    .run();
  await repo.invalidateHistoryDerivedCaches();

  const before = await repo.queryShowDetail({ title: "The Walking Dead" });
  assert.equal(before.episodes[0].id, "walking-dead-unwatched");
  assert.equal(before.episodes[0].sync_action, "unwatched");

  await repo.updateWatchTelemetry("walking-dead-watched", "Dispatch status: success");
  let afterMetadata = await repo.queryShowDetail({ title: "The Walking Dead" });
  assert.equal(afterMetadata.episodes[0].id, "walking-dead-unwatched");
  assert.equal(afterMetadata.episodes[0].sync_action, "unwatched");

  const telemetryUpdatedAt = database.prepare("SELECT updated_at FROM watch_history WHERE id = ?").get("walking-dead-watched").updated_at;
  database.prepare("UPDATE watch_history SET poster_url = ?, updated_at = ? WHERE id = ?")
    .run("https://example.test/walking-dead.jpg", telemetryUpdatedAt + 1, "walking-dead-watched");
  await repo.invalidateHistoryDerivedCaches();
  afterMetadata = await repo.queryShowDetail({ title: "The Walking Dead" });
  assert.equal(afterMetadata.episodes[0].id, "walking-dead-unwatched");
  assert.equal(afterMetadata.episodes[0].sync_action, "unwatched");
  const watchedMetadataUpdatedAt = telemetryUpdatedAt + 1;

  const originalFetch = globalThis.fetch;
  let unplayedWriteSeen = false;
  let playedWriteSeen = false;
  let traktWriteCount = 0;
  trackerConnectionRepo.saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "user-1",
    remoteUsername: "tester",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    initialSyncMode: "baseline",
    baselineComplete: true,
    lastValidatedAt: Date.now(),
  });
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === "api.trakt.tv") {
      traktWriteCount += 1;
      return Response.json({ deleted: { episodes: 1 } });
    }
    if (requestUrl.pathname === "/Users/test-user/Items") {
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Series") {
        return Response.json({
          Items: [{ Id: "walking-dead-series", Name: "The Walking Dead", ProviderIds: { Tmdb: "force-sync-canonical" } }],
        });
      }
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Episode") {
        return Response.json({
          Items: [
            { Id: "walking-dead-s01e01", ParentIndexNumber: 1, IndexNumber: 1 },
            { Id: "walking-dead-s01e02", ParentIndexNumber: 1, IndexNumber: 2 },
          ],
        });
      }
    }
    if (requestUrl.pathname === "/Users/test-user/Items/walking-dead-s01e01/UserData" && options.method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/walking-dead-s01e01" && options.method === "DELETE") {
      unplayedWriteSeen = true;
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/walking-dead-s01e02" && options.method === "POST") {
      playedWriteSeen = true;
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request: ${options.method || "GET"} ${requestUrl}`);
  };

  let result;
  try {
    result = await forceSyncMediaState({
      type: "show",
      title: "The Walking Dead",
      tmdb_id: "force-sync-canonical",
      mode: "push",
      push_to: "emby",
    }, {
      config: {
        plex: { disabled: true },
        emby: { disabled: false, baseUrl: "https://emby.example.test", apiKey: "test-key", userId: "test-user" },
        jellyfin: { disabled: true },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    trackerConnectionRepo.deleteTrackerConnection("trakt");
  }

  assert.equal(result.ok, true);
  assert.equal(result.results.find((item) => item.episode === 1)?.canonicalState, "unwatched");
  assert.equal(result.results.find((item) => item.episode === 1)?.status, "success");
  assert.equal(result.results.find((item) => item.episode === 2)?.canonicalState, "watched");
  assert.equal(result.results.find((item) => item.episode === 2)?.status, "success");
  assert.equal(unplayedWriteSeen, true);
  assert.equal(playedWriteSeen, true);
  assert.equal(traktWriteCount, 0, "a target-specific Emby repair must not mutate Trakt");

  const after = await repo.queryShowDetail({ title: "The Walking Dead" });
  assert.equal(after.episodes[0].id, "walking-dead-unwatched");
  assert.equal(after.episodes[0].sync_action, "unwatched");
  assert.match(after.episodes[0].sync_dispatch_telemetry, /Pushed Canonical State/);
  assert.equal(database.prepare("SELECT updated_at FROM watch_history WHERE id = ?").get("walking-dead-watched").updated_at, watchedMetadataUpdatedAt);
});

test("a successful movie-unwatch push does not revive its older watched history row", async () => {
  const database = repo.requireDb();
  database.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, sync_action,
     media_key, created_at, updated_at)
    VALUES ('arrival-watched', 'Arrival', 'arrival', 'movie', '2026-08-20T20:00:00.000Z',
            'manual', '329865', 'watched', 'movie:tmdb:329865', 1_000, 1_000)`)
    .run();
  const media = {
    title: "Arrival",
    type: "movie",
    ids: { tmdb: "329865" },
    isValid: true,
  };
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-08-21T20:00:00.000Z");
  assert.equal(await repo.getCanonicalWatchState(media), "unwatched");

  const originalFetch = globalThis.fetch;
  let unplayedWriteSeen = false;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname === "/Users/test-user/Items" && requestUrl.searchParams.get("IncludeItemTypes") === "Movie") {
      return Response.json({ Items: [{ Id: "arrival-movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } }] });
    }
    if (requestUrl.pathname === "/Users/test-user/Items/arrival-movie/UserData" && options.method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/arrival-movie" && options.method === "DELETE") {
      unplayedWriteSeen = true;
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request: ${options.method || "GET"} ${requestUrl}`);
  };

  const lines = [];
  let result;
  try {
    result = await forceSyncMediaState({
      type: "movie",
      title: "Arrival",
      tmdb_id: "329865",
      mode: "push",
      push_to: "emby",
    }, {
      config: {
        plex: { disabled: true },
        emby: { disabled: false, baseUrl: "https://emby.example.test", apiKey: "test-key", userId: "test-user" },
        jellyfin: { disabled: true },
      },
      logger: (line) => lines.push(line),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.ok, true);
  assert.equal(result.results[0].canonicalState, "unwatched");
  assert.equal(result.results[0].status, "success");
  assert.equal(unplayedWriteSeen, true);
  assert.ok(lines.some((line) => line.includes("sending unwatched state")));
  assert.ok(lines.some((line) => line.includes("Set Plekt as Source of Truth finished")));
  assert.equal(await repo.getCanonicalWatchState(media), "unwatched");
  const watchedRow = database.prepare("SELECT updated_at, sync_dispatch_telemetry FROM watch_history WHERE id = ?").get("arrival-watched");
  assert.equal(watchedRow.updated_at, 1_000);
  assert.equal(watchedRow.sync_dispatch_telemetry, null);
  const operation = (await getSyncHistory(100)).find((row) => row.title === "Arrival");
  assert.equal(operation?.status, "success");
  assert.equal(operation?.action, "unwatched");
  assert.equal(operation?.rawPayloadDebug?.event, "media_force_sync");
});
