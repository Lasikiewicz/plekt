import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tracker-poll-race-");

const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");
const mediaConnectionRepo = await import("../server/src/utils/mediaConnectionRepo.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
const { pollConnectedTrackers, partitionPendingTraktUnwatches, TRAKT_UNWATCH_CONFIRMATION_MS } = await import("../server/src/utils/trackerSync.js");
const { trackerMediaKey } = await import("../server/src/utils/traktClient.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { syncCanonicalPlaystate } = await import("../server/src/utils/syncOrchestrator.js");

const ECHO_WINDOW_MS = 30 * 60_000;

function resetState() {
  db.prepare("DELETE FROM media_connections").run();
  db.prepare("DELETE FROM media_auth_devices").run();
  db.prepare("DELETE FROM tracker_item_state").run();
  db.prepare("DELETE FROM tracker_play_history").run();
  db.prepare("DELETE FROM tracker_connections").run();
  db.prepare("DELETE FROM playback_progress").run();
  db.prepare("DELETE FROM outbound_state_leases").run();
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
  db.prepare("DELETE FROM loop_keys").run();
}

function connectTrakt() {
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
}

async function disableMediaServers() {
  await saveMediaConfig({
    plex: { disabled: true, authMode: "manual" },
    emby: { disabled: true, authMode: "manual" },
    jellyfin: { disabled: true, authMode: "manual" },
  });
}

function testJwt(expiresAtSeconds, label) {
  return `e30.${Buffer.from(JSON.stringify({ exp: expiresAtSeconds, label })).toString("base64url")}.signature`;
}

async function waitForGate(promise, label, timeoutMs = 10_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function installConfigLoadGate(traktFetch) {
  const device = mediaConnectionRepo.getOrCreatePlexAuthDevice({ deviceName: "Tracker poll gate test" });
  mediaConnectionRepo.saveMediaConnection({
    provider: "plex",
    baseUrl: "http://192.168.1.10:32400",
    serverId: "test-plex",
    serverName: "Test Plex",
    authDeviceId: device.id,
    remoteUserId: "user-1",
    remoteUsername: "tester",
    authKind: "plex_jwt",
    credential: testJwt(1, "expired"),
    accessTokenExpiresAt: 1000,
  });
  await saveMediaConfig({
    plex: { disabled: true, authMode: "account" },
    emby: { disabled: true, authMode: "manual" },
    jellyfin: { disabled: true, authMode: "manual" },
  });

  let signalStarted;
  let releaseGate;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const freshJwt = testJwt(Math.floor(Date.now() / 1000) + 7 * 86400, "fresh");
  return {
    started,
    release: () => releaseGate(),
    fetch: async (url, options) => {
      const href = String(url);
      if (href.endsWith("/api/v2/auth/nonce")) {
        signalStarted();
        await gate;
        return new Response(JSON.stringify({ nonce: "nonce" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.endsWith("/api/v2/auth/token")) {
        return new Response(JSON.stringify({ auth_token: freshJwt }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/api/v2/resources")) {
        return new Response(JSON.stringify([{ product: "Plex Media Server", clientIdentifier: "test-plex", accessToken: "server-token" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return traktFetch(url, options);
    },
  };
}

function siloEpisode(episode, ids = { imdb: "tt14688458", tmdb: "125988" }) {
  return {
    isValid: true,
    source: "manual",
    type: "episode",
    mediaType: "episode",
    title: `Silo - S03E${String(episode).padStart(2, "0")}`,
    showTitle: "Silo",
    season: 3,
    episode,
    ids,
    watched_at: "2026-08-20T20:00:00.000Z",
  };
}

async function seedLocalWatch(media, source, watchedAt) {
  // These race tests do not exercise artwork hydration. Keep their setup
  // wholly local so a background TMDB request cannot delay the progress gate
  // under full-suite CPU/network contention or outlive a later fetch mock.
  repo.insertWatchRecordSync({
    ...repo.mediaToWatchRecord(media, source),
    watched_at: watchedAt,
    sync_action: "watched",
  });
  await repo.upsertPlaystateForMedia(media, "watched", watchedAt);
}

function emptyTraktReads() {
  return async (url) => {
    const href = String(url);
    if (href.includes("/sync/watched/") || href.includes("/sync/history/movies") || href.includes("/sync/history/episodes")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };
}

function traktReadsWithSiloEpisode(episode, watchedAt) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/sync/watched/movies")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/watched/shows")) {
      return new Response(JSON.stringify([{
        show: { title: "Silo", year: 2023, ids: { imdb: "tt14688458", tmdb: 125988 } },
        seasons: [{ number: 3, episodes: [{ number: episode, last_watched_at: watchedAt }] }],
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/history/movies") || href.includes("/sync/history/episodes")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };
}

test("an item without a provider ID fails before creating an outbound baseline", async () => {
  resetState();
  connectTrakt();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Trakt must not be called for an unidentified item");
  };

  try {
    const [result] = await dispatchTrackerWatchState({
      isValid: true,
      source: "manual",
      type: "movie",
      mediaType: "movie",
      title: "",
      ids: {},
    }, "watched");
    assert.equal(result.status, "not_found");
    assert.equal(fetchCalls, 0);
    assert.equal(trackerConnectionRepo.listTrackerItemStates("trakt").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonical Trakt replay primes its watched intent before the remove call", async () => {
  resetState();
  connectTrakt();
  const media = siloEpisode(3);
  const mediaKey = trackerMediaKey(media);
  let markerSeenDuringRemove = false;
  let writes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === "https://api.trakt.tv/sync/history/remove") {
      writes += 1;
      const marker = trackerConnectionRepo.getTrackerItemState("trakt", mediaKey);
      markerSeenDuringRemove = marker?.lastOutboundState === "watched" && Number(marker.lastOutboundAt) > 0;
      return new Response(JSON.stringify({ deleted: { episodes: 1 }, not_found: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "https://api.trakt.tv/sync/history") {
      writes += 1;
      return new Response(JSON.stringify({ added: { episodes: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    const [result] = await dispatchTrackerWatchState(media, "watched");
    assert.equal(result.status, "success");
    assert.equal(writes, 2);
    assert.equal(markerSeenDuringRemove, true, "the poll-visible intent must exist before canonical replay removes the old play");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed new outbound write never becomes a synthetic watched baseline", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const media = { ...siloEpisode(2), source: "plex" };
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-20T20:00:00.000Z";
  await seedLocalWatch(media, "plex", watchedAt);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.trakt.tv/sync/history") {
      return new Response(JSON.stringify({ error: "temporary outage" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during failed dispatch: ${url}`);
  };

  try {
    const [dispatchResult] = await dispatchTrackerWatchState(media, "watched");
    assert.equal(dispatchResult.status, "failed");
    const intentOnly = trackerConnectionRepo.getTrackerItemState("trakt", mediaKey);
    assert.equal(intentOnly.lastOutboundState, "watched");
    assert.equal(intentOnly.remoteWatchedAt, null, "an outbound attempt is not an observed Trakt watched row");
    db.prepare("UPDATE tracker_item_state SET last_outbound_at=? WHERE provider='trakt' AND media_key=?")
      .run(Date.now() - ECHO_WINDOW_MS - 1000, mediaKey);

    globalThis.fetch = emptyTraktReads();
    const pollResult = await pollConnectedTrackers();
    assert.equal(pollResult.unwatched, 0);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
    assert.equal(trackerConnectionRepo.getTrackerItemState("trakt", mediaKey), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("outbound lookup matches an IMDb snapshot row to a TMDB-only marker for the same episode", () => {
  resetState();
  const snapshotMedia = siloEpisode(4);
  const snapshotItem = { mediaKey: trackerMediaKey(snapshotMedia), media: snapshotMedia, watchedAt: Date.now() - 60_000 };
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [snapshotItem]);

  const tmdbOnly = siloEpisode(4, { tmdb: "125988" });
  trackerConnectionRepo.recordTrackerOutbound("trakt", trackerMediaKey(tmdbOnly), tmdbOnly, "watched");

  const marker = trackerConnectionRepo.findTrackerOutboundSince("trakt", snapshotItem, "watched", Date.now() - 60_000);
  assert.ok(marker, "overlapping series id plus episode coordinates should bridge the preferred-key difference");

  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [snapshotItem]);
  const retained = trackerConnectionRepo.getTrackerItemState("trakt", snapshotItem.mediaKey);
  assert.equal(retained.lastOutboundState, "watched");
  assert.ok(Number(retained.lastOutboundAt) > 0, "snapshot replacement must preserve the alias marker");
});

test("cross-ID aliases collapse to one episode and the newest intent wins", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const richMedia = siloEpisode(4);
  const richKey = trackerMediaKey(richMedia);
  const tmdbOnly = siloEpisode(4, { tmdb: "125988" });
  const tmdbKey = trackerMediaKey(tmdbOnly);
  const watchedAt = "2026-08-20T20:00:00.000Z";

  await seedLocalWatch(richMedia, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey: richKey, media: richMedia, watchedAt: Date.parse(watchedAt) }]);
  trackerConnectionRepo.recordTrackerOutbound("trakt", tmdbKey, tmdbOnly, "unwatched");
  trackerConnectionRepo.recordTrackerOutbound("trakt", richKey, richMedia, "watched");

  const latest = trackerConnectionRepo.findLatestTrackerOutboundSince(
    "trakt",
    { mediaKey: richKey, media: richMedia },
    Date.now() - 60_000,
  );
  assert.equal(latest.lastOutboundState, "watched");
  assert.ok(Number(latest.lastOutboundAt) > Number(trackerConnectionRepo.getTrackerItemState("trakt", tmdbKey).lastOutboundAt));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyTraktReads();
  try {
    const protectedResult = await pollConnectedTrackers();
    assert.equal(protectedResult.unwatched, 0);
    assert.equal(protectedResult.deferredUnwatched, 1, "one real episode should be protected, not one row per alias");
    assert.equal(trackerConnectionRepo.listTrackerItemStates("trakt").length, 1, "snapshot storage should collapse the alias rows");
    assert.equal((await repo.getPlaystateForMedia(richMedia)).state, "watched");

    const expiredAt = Date.now() - ECHO_WINDOW_MS - 1000;
    db.prepare("UPDATE tracker_item_state SET last_outbound_at=? WHERE provider='trakt'").run(expiredAt);
    db.prepare("UPDATE playstate SET updated_at=?").run(expiredAt);
    const recheckedResult = await pollConnectedTrackers();
    assert.equal(recheckedResult.unwatched, 0, "expired echo protection must not bypass the missing-item confirmation window");
    assert.equal(recheckedResult.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(richMedia)).state, "watched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an automatic-unwatch safety hold is reported as deferred, not applied", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const media = siloEpisode(8);
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-20T20:00:00.000Z";
  await seedLocalWatch(media, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(watchedAt) }]);

  const now = Date.now();
  const insertBurst = db.prepare("INSERT INTO loop_keys (id,key,value,created_at,expire_at) VALUES (?,?,?,?,?)");
  for (let index = 0; index < 15; index += 1) {
    insertBurst.run(crypto.randomUUID(), `auto-unwatch-burst:test:${index}`, String(now), now, now + 300_000);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyTraktReads();
  try {
    const result = await pollConnectedTrackers();
    assert.equal(result.unwatched, 0, "a circuit-breaker rejection must not be counted as applied");
    assert.equal(result.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
    assert.ok(trackerConnectionRepo.getTrackerItemState("trakt", mediaKey), "the held row must survive for a later poll");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a newer local unwatch defers a stale watched snapshot", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const media = siloEpisode(5);
  const mediaKey = trackerMediaKey(media);
  const oldWatchedAt = "2026-08-20T20:00:00.000Z";
  const newerRemotePlay = "2026-08-21T20:00:00.000Z";
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(oldWatchedAt) }]);
  await repo.upsertPlaystateForMedia(media, "unwatched", new Date().toISOString());
  trackerConnectionRepo.recordTrackerOutbound("trakt", mediaKey, media, "unwatched");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = traktReadsWithSiloEpisode(5, newerRemotePlay);
  try {
    const result = await pollConnectedTrackers();
    assert.equal(result.watched, 0);
    assert.equal(result.deferredWatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "unwatched");
    const retained = trackerConnectionRepo.getTrackerItemState("trakt", mediaKey);
    assert.equal(retained.remoteWatchedAt, null, "the stale remote play must remain eligible for a later re-check");
    assert.equal(retained.lastOutboundState, "unwatched");

    const expiredAt = Date.now() - ECHO_WINDOW_MS - 1000;
    db.prepare("UPDATE tracker_item_state SET last_outbound_at=? WHERE provider='trakt' AND media_key=?").run(expiredAt, mediaKey);
    db.prepare("UPDATE playstate SET updated_at=?").run(expiredAt);
    const accepted = await pollConnectedTrackers();
    assert.equal(accepted.watched, 1);
    assert.equal(accepted.deferredWatched, 0);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a poll during the canonical remove-add gap cannot reverse the local watched state", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const media = siloEpisode(3);
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-20T20:00:00.000Z";
  await seedLocalWatch(media, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(watchedAt) }]);

  let signalRemoveStarted;
  let releaseRemove;
  const removeStarted = new Promise((resolve) => { signalRemoveStarted = resolve; });
  const removeGate = new Promise((resolve) => { releaseRemove = resolve; });
  const originalFetch = globalThis.fetch;
  let replay = null;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === "https://api.trakt.tv/sync/history/remove") {
      signalRemoveStarted();
      await removeGate;
      return new Response(JSON.stringify({ deleted: { episodes: 1 }, not_found: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "https://api.trakt.tv/sync/history") {
      return new Response(JSON.stringify({ added: { episodes: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/watched/") || href.includes("/sync/history/movies") || href.includes("/sync/history/episodes")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    replay = dispatchTrackerWatchState(media, "watched");
    await waitForGate(removeStarted, "canonical Trakt remove");

    // This is the production failure window: Trakt has removed the episode,
    // the replacement play is not added yet, and its watched snapshot omits
    // the item. The poll must defer rather than fan an unwatch to local apps.
    const pollResult = await pollConnectedTrackers();
    assert.equal(pollResult.unwatched, 0);
    assert.equal(pollResult.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");

    releaseRemove();
    const [replayResult] = await replay;
    assert.equal(replayResult.status, "success");
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
  } finally {
    releaseRemove();
    await replay?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});

test("a watched intent written after the poll diff still blocks its queued unwatch", async () => {
  resetState();
  connectTrakt();
  const media = siloEpisode(6);
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-20T20:00:00.000Z";
  await seedLocalWatch(media, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(watchedAt) }]);

  // Pausing loadMediaConfig() on Plex JWT refresh happens only after the
  // empty Trakt snapshot has been diffed into an unwatch. Writing the marker
  // while paused therefore exercises the worker's final re-check rather than
  // the earlier candidate filter.
  const configGate = await installConfigLoadGate(emptyTraktReads());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = configGate.fetch;
  let poll = null;

  try {
    poll = pollConnectedTrackers();
    await waitForGate(configGate.started, "post-diff configuration load");
    trackerConnectionRepo.recordTrackerOutbound("trakt", mediaKey, media, "watched");
    configGate.release();

    const result = await poll;
    assert.equal(result.unwatched, 0);
    assert.equal(result.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
  } finally {
    configGate.release();
    await poll?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});

test("a local unwatch committed after the poll diff blocks its queued watch", async () => {
  resetState();
  connectTrakt();
  const media = siloEpisode(7);
  const remoteWatchedAt = "2026-08-21T20:00:00.000Z";
  const configGate = await installConfigLoadGate(traktReadsWithSiloEpisode(7, remoteWatchedAt));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = configGate.fetch;
  let poll = null;

  try {
    poll = pollConnectedTrackers();
    await waitForGate(configGate.started, "post-diff configuration load");
    await repo.upsertPlaystateForMedia(media, "unwatched", new Date().toISOString());
    configGate.release();

    const deferred = await poll;
    assert.equal(deferred.watched, 0);
    assert.equal(deferred.deferredWatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "unwatched");

    // With no persistent outbound marker, the same remote state is eligible
    // again on the next poll. It may apply only after the newer local action's
    // poll boundary has passed.
    const accepted = await pollConnectedTrackers();
    assert.equal(accepted.watched, 1);
    assert.equal(accepted.deferredWatched, 0);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    configGate.release();
    await poll?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});

test("a stale empty poll retains a recent watched marker and confirms before unwatch", async () => {
  resetState();
  connectTrakt();
  await disableMediaServers();
  const media = siloEpisode(3);
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-20T20:00:00.000Z";

  await seedLocalWatch(media, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(watchedAt) }]);
  trackerConnectionRepo.recordTrackerOutbound("trakt", mediaKey, media, "watched");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyTraktReads();
  try {
    const staleResult = await pollConnectedTrackers();
    assert.equal(staleResult.unwatched, 0);
    assert.equal(staleResult.deferredUnwatched, 1);
    const retained = trackerConnectionRepo.getTrackerItemState("trakt", mediaKey);
    assert.equal(retained.lastOutboundState, "watched");
    assert.ok(Number(retained.remoteWatchedAt) > 0, "the missing item must remain comparable on the next poll");
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");

    // Once the outbound echo grace has elapsed, the snapshot is still held
    // until it has remained missing for the separate confirmation period.
    const expiredAt = Date.now() - ECHO_WINDOW_MS - 1000;
    db.prepare("UPDATE tracker_item_state SET last_outbound_at=? WHERE provider='trakt' AND media_key=?").run(expiredAt, mediaKey);
    db.prepare("UPDATE playstate SET updated_at=?").run(expiredAt);

    const recheckedResult = await pollConnectedTrackers();
    assert.equal(recheckedResult.unwatched, 0);
    assert.equal(recheckedResult.deferredUnwatched, 1);
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
    assert.ok(trackerConnectionRepo.getTrackerItemState("trakt", mediaKey));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a newer watched LAN write finishes after an older poll paused while clearing progress", async () => {
  resetState();
  connectTrakt();
  const media = siloEpisode(88);
  const mediaKey = trackerMediaKey(media);
  const watchedAt = "2026-08-22T20:00:00.000Z";
  await seedLocalWatch(media, "manual", watchedAt);
  trackerConnectionRepo.replaceTrackerSnapshot("trakt", [{ mediaKey, media, watchedAt: Date.parse(watchedAt) }]);

  const config = {
    plex: { disabled: true, authMode: "manual" },
    emby: {
      disabled: false,
      authMode: "manual",
      baseUrl: "https://emby-ordering.example.test",
      apiKey: "test-key",
      userId: "test-user",
    },
    jellyfin: { disabled: true, authMode: "manual" },
  };
  await saveMediaConfig(config);

  let signalProgressStarted;
  let releaseProgress;
  const progressStarted = new Promise((resolve) => { signalProgressStarted = resolve; });
  const progressGate = new Promise((resolve) => { releaseProgress = resolve; });
  const writes = [];
  const originalFetch = globalThis.fetch;
  // Model a Trakt item that has already remained missing through the grace
  // period. This keeps the test focused on the concurrent LAN write race.
  partitionPendingTraktUnwatches(
    [{ mediaKey }],
    new Map(),
    Date.now() - TRAKT_UNWATCH_CONFIRMATION_MS - 1,
  );
  let poll = null;
  let watchedWrite = null;

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const method = options.method || "GET";
    if (requestUrl.hostname === "api.trakt.tv") {
      if (requestUrl.pathname.startsWith("/sync/watched/") || requestUrl.pathname.startsWith("/sync/history/")) {
        return Response.json([]);
      }
      throw new Error(`Unexpected Trakt request during LAN ordering test: ${method} ${requestUrl}`);
    }
    if (requestUrl.hostname !== "emby-ordering.example.test") {
      throw new Error(`Unexpected request during LAN ordering test: ${method} ${requestUrl}`);
    }
    if (requestUrl.pathname === "/Users/test-user/Items") {
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Series") {
        return Response.json({
          Items: [{
            Id: "silo-series",
            Name: "Silo",
            ProviderIds: { Imdb: "tt14688458", Tmdb: "125988" },
          }],
        });
      }
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Episode") {
        return Response.json({
          Items: [{ Id: "silo-s03e88", ParentIndexNumber: 3, IndexNumber: 88 }],
        });
      }
    }
    if (requestUrl.pathname === "/Users/test-user/Items/silo-s03e88/UserData" && method === "POST") {
      writes.push("progress-clear-started");
      signalProgressStarted();
      await progressGate;
      writes.push("progress-cleared");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/silo-s03e88" && method === "POST") {
      writes.push("watched");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/silo-s03e88" && method === "DELETE") {
      writes.push("unplayed");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request during LAN ordering test: ${method} ${requestUrl}`);
  };

  try {
    poll = pollConnectedTrackers();
    await waitForGate(progressStarted, "poll progress clear");

    // This is the newer Force-Sync generation: publish its tracker intent and
    // canonical local state, then start its watched LAN write while the older
    // poll still owns the target lease around progress-clear + unplayed. The
    // Force payload deliberately has wholly different (and wrong) provider
    // IDs plus a year-suffixed title. Keeping both playstate identities proves
    // the target mutex is derived from normalized title coordinates, not from
    // whichever provider-keyed row happens to resolve first.
    const rematchedMedia = {
      ...siloEpisode(88, { imdb: "tt-wrong-rematch", tmdb: "wrong-rematch" }),
      title: "Silo (2023) - S03E88",
      showTitle: "Silo (2023)",
    };
    trackerConnectionRepo.recordTrackerOutbound("trakt", mediaKey, media, "watched");
    await repo.upsertPlaystateForMedia(media, "watched", "2026-08-23T20:00:00.000Z");
    await repo.upsertPlaystateForMedia(rematchedMedia, "watched", "2026-08-23T20:00:01.000Z");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM playstate WHERE season=3 AND episode=88").get().c,
      2,
      "the race setup must retain both non-overlapping provider identities",
    );
    watchedWrite = syncCanonicalPlaystate(
      { ...rematchedMedia, source: "manual", syncTargets: ["emby"] },
      config,
      createLoopStore(),
      "watched",
      { trackDispatch: false, includeTrackers: false },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, ["progress-clear-started"], "the newer watched write must wait for the target lease");

    releaseProgress();
    const [pollResult, watchedSummary] = await Promise.all([poll, watchedWrite]);
    assert.equal(pollResult.unwatched, 0);
    assert.equal(pollResult.deferredUnwatched, 1);
    assert.equal(watchedSummary.status, "success");
    assert.equal(writes.includes("unplayed"), false, "the superseded poll must not send an unplayed flag");
    assert.equal(writes.at(-1), "watched", "the newer watched state must be the final LAN write");
    assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbound_state_leases").get().c, 0, "released leases must be pruned");
  } finally {
    releaseProgress();
    await poll?.catch(() => null);
    await watchedWrite?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});

test("an expired stolen lease fences its previous owner before the unplayed mutation", async () => {
  resetState();
  const media = siloEpisode(9);
  const config = {
    plex: { disabled: true, authMode: "manual" },
    emby: {
      disabled: false,
      authMode: "manual",
      baseUrl: "https://emby-lease-fence.example.test",
      apiKey: "test-key",
      userId: "test-user",
    },
    jellyfin: { disabled: true, authMode: "manual" },
  };
  await saveMediaConfig(config);

  let signalProgressStarted;
  let releaseProgress;
  const progressStarted = new Promise((resolve) => { signalProgressStarted = resolve; });
  const progressGate = new Promise((resolve) => { releaseProgress = resolve; });
  const writes = [];
  const originalFetch = globalThis.fetch;
  let staleUnwatch = null;
  let newerWatch = null;

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const method = options.method || "GET";
    if (requestUrl.hostname !== "emby-lease-fence.example.test") {
      throw new Error(`Unexpected request during lease fence test: ${method} ${requestUrl}`);
    }
    if (requestUrl.pathname === "/Users/test-user/Items") {
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Series") {
        return Response.json({
          Items: [{
            Id: "silo-series",
            Name: "Silo",
            ProviderIds: { Imdb: "tt14688458", Tmdb: "125988" },
          }],
        });
      }
      if (requestUrl.searchParams.get("IncludeItemTypes") === "Episode") {
        return Response.json({
          Items: [{ Id: "silo-s03e09", ParentIndexNumber: 3, IndexNumber: 9 }],
        });
      }
    }
    if (requestUrl.pathname === "/Users/test-user/Items/silo-s03e09/UserData" && method === "POST") {
      writes.push("progress-clear-started");
      signalProgressStarted();
      await progressGate;
      writes.push("progress-cleared");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/silo-s03e09" && method === "POST") {
      writes.push("watched");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/silo-s03e09" && method === "DELETE") {
      writes.push("unplayed");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request during lease fence test: ${method} ${requestUrl}`);
  };

  try {
    staleUnwatch = syncCanonicalPlaystate(
      { ...media, source: "manual", syncTargets: ["emby"] },
      config,
      createLoopStore(),
      "unwatched",
      { trackDispatch: false, includeTrackers: false },
    );
    await waitForGate(progressStarted, "stale owner's progress clear");

    const heldLease = db.prepare("SELECT lease_key, generation FROM outbound_state_leases").get();
    assert.ok(heldLease?.lease_key, "the stale operation must own a persisted target lease");
    db.prepare(`
      UPDATE outbound_state_leases
         SET owner_id = 'stolen-by-new-process',
             generation = generation + 1,
             expires_at = ?
       WHERE lease_key = ?
    `).run(Date.now() - 1, heldLease.lease_key);

    // A newer process can now claim the expired generation and write watched
    // while the stale owner is still suspended in its first remote mutation.
    newerWatch = syncCanonicalPlaystate(
      { ...media, source: "manual", syncTargets: ["emby"] },
      config,
      createLoopStore(),
      "watched",
      { trackDispatch: false, includeTrackers: false },
    );
    const watchedSummary = await newerWatch;
    assert.equal(watchedSummary.status, "success");
    assert.equal(writes.includes("watched"), true);

    releaseProgress();
    const staleSummary = await staleUnwatch;
    assert.equal(staleSummary.deferred, true, "the expired owner must observe its lost generation");
    assert.equal(writes.includes("unplayed"), false, "the fenced owner must not send its second mutation");
    assert.equal(
      writes.filter((write) => write === "watched" || write === "unplayed").at(-1),
      "watched",
      "the newer played-state mutation must remain final",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbound_state_leases").get().c, 0);
  } finally {
    releaseProgress();
    await staleUnwatch?.catch(() => null);
    await newerWatch?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});

test("movie aliases share one target lease when only one payload has a release year", async () => {
  resetState();
  const movieWithYear = {
    isValid: true,
    source: "trakt",
    type: "movie",
    mediaType: "movie",
    title: "Arrival",
    year: 2016,
    ids: { tmdb: "329865" },
  };
  const movieWithoutYear = {
    ...movieWithYear,
    source: "manual",
    year: undefined,
    ids: { imdb: "tt2543164" },
  };
  const config = {
    plex: { disabled: true, authMode: "manual" },
    emby: {
      disabled: false,
      authMode: "manual",
      baseUrl: "https://emby-movie-lease.example.test",
      apiKey: "test-key",
      userId: "test-user",
    },
    jellyfin: { disabled: true, authMode: "manual" },
  };
  await saveMediaConfig(config);

  let signalProgressStarted;
  let releaseProgress;
  const progressStarted = new Promise((resolve) => { signalProgressStarted = resolve; });
  const progressGate = new Promise((resolve) => { releaseProgress = resolve; });
  const writes = [];
  const originalFetch = globalThis.fetch;
  let olderUnwatch = null;
  let newerWatch = null;

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const method = options.method || "GET";
    if (requestUrl.hostname !== "emby-movie-lease.example.test") {
      throw new Error(`Unexpected request during movie lease test: ${method} ${requestUrl}`);
    }
    if (
      requestUrl.pathname === "/Users/test-user/Items"
      && requestUrl.searchParams.get("IncludeItemTypes") === "Movie"
    ) {
      return Response.json({
        Items: [{
          Id: "arrival-movie",
          Name: "Arrival",
          ProductionYear: 2016,
          ProviderIds: { Imdb: "tt2543164", Tmdb: "329865" },
        }],
      });
    }
    if (requestUrl.pathname === "/Users/test-user/Items/arrival-movie/UserData" && method === "POST") {
      writes.push("progress-clear-started");
      signalProgressStarted();
      await progressGate;
      writes.push("progress-cleared");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/arrival-movie" && method === "POST") {
      writes.push("watched");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/PlayedItems/arrival-movie" && method === "DELETE") {
      writes.push("unplayed");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected Emby request during movie lease test: ${method} ${requestUrl}`);
  };

  try {
    olderUnwatch = syncCanonicalPlaystate(
      { ...movieWithYear, syncTargets: ["emby"] },
      config,
      createLoopStore(),
      "unwatched",
      { trackDispatch: false, includeTrackers: false },
    );
    await waitForGate(progressStarted, "year-bearing movie progress clear");

    newerWatch = syncCanonicalPlaystate(
      { ...movieWithoutYear, syncTargets: ["emby"] },
      config,
      createLoopStore(),
      "watched",
      { trackDispatch: false, includeTrackers: false },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbound_state_leases").get().c,
      1,
      "the yearless alias must wait on the year-bearing alias's lease",
    );
    assert.equal(writes.includes("watched"), false, "the newer movie write must not pass the older operation");

    releaseProgress();
    const [unwatchedSummary, watchedSummary] = await Promise.all([olderUnwatch, newerWatch]);
    assert.equal(unwatchedSummary.status, "success");
    assert.equal(watchedSummary.status, "success");
    assert.deepEqual(
      writes.filter((write) => write === "unplayed" || write === "watched"),
      ["unplayed", "watched"],
      "the newer watched movie state must land last",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbound_state_leases").get().c, 0);
  } finally {
    releaseProgress();
    await olderUnwatch?.catch(() => null);
    await newerWatch?.catch(() => null);
    globalThis.fetch = originalFetch;
  }
});
