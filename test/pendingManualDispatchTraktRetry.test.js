import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-pending-manual-dispatch-trakt-retry-");

const repo = await import("../server/src/utils/dataRepo.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { syncPendingManualDispatches, traktNeedsRetry, SYNC_RETRY_MAX_ATTEMPTS } = await import("../server/src/utils/syncDispatchQueue.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Records every Trakt call. `history` is what /sync/history/{type} returns for
// the retry's history-window check; `add` answers the POST that adds a play.
async function withTraktFetch({ history = [], add = () => json({ added: { movies: 1, episodes: 1 }, not_found: {} }, 201) } = {}, run) {
  const calls = { historyReads: [], adds: 0, removes: 0, other: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("https://api.trakt.tv/sync/history/movies?") || href.startsWith("https://api.trakt.tv/sync/history/episodes?")) {
      calls.historyReads.push(href);
      return json(history);
    }
    if (href === "https://api.trakt.tv/sync/history") {
      calls.adds += 1;
      return add();
    }
    if (href === "https://api.trakt.tv/sync/history/remove") {
      calls.removes += 1;
      return json({ deleted: {}, not_found: {} }, 201);
    }
    calls.other.push(href);
    throw new Error(`Unexpected fetch during test: ${href}`);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function failedTraktTelemetry(detail) {
  return [
    "Origin: plex",
    "Loop-check: Passed",
    "Dispatch status: error",
    "Details: Synced to nothing; failed Trakt",
    `Target trakt status: error - ${detail}`,
  ].join("\n");
}

async function rowById(id) {
  return (await repo.getCachedHistory()).find((entry) => entry.id === id);
}

test("traktNeedsRetry accepts only transient Trakt failures", () => {
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt request failed with 429")), true);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt request failed with 502")), true);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Service unavailable (HTTP 503)")), true);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Upstream request timed out after 20000ms")), true);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Upstream request failed (connection refused)")), true);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Upstream request failed")), true);
  assert.equal(traktNeedsRetry("Origin: manual\nPlex status: skipped - No matching item found\nTrakt status: error - Trakt request failed with 429"), true, "manual rows omit the Target prefix");
  assert.equal(traktNeedsRetry("Origin: manual\nTrakt status: success - Marked watched on Trakt"), false);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt could not match this item to mark it watched (not_found: {})")), false);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt request failed with 401")), false);
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt request failed with 404")), false);
  assert.equal(traktNeedsRetry("Origin: plex\nTarget trakt status: success - Marked watched on Trakt"), false);
  assert.equal(traktNeedsRetry("Origin: plex\nDispatch status: success"), false, "no Trakt line means Trakt was never attempted");
  assert.equal(traktNeedsRetry(failedTraktTelemetry("Trakt request failed with 429"), "trakt_import"), false);
});

test("a 429 Trakt failure is retried once and the play is added when history does not have it", async () => {
  connectTrakt();
  await withTraktFetch({}, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Rate Limited Movie",
      media_type: "movie",
      tmdb_id: "retry-429-movie",
      watched_at: "2026-09-20T20:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: failedTraktTelemetry("Trakt request failed with 429"),
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(calls.historyReads.length, 1, "the retry must check Trakt history before adding");
    assert.match(calls.historyReads[0], /start_at=2026-09-20T19%3A59%3A00\.000Z/);
    assert.match(calls.historyReads[0], /end_at=2026-09-20T20%3A01%3A00\.000Z/);
    assert.equal(calls.adds, 1);
    assert.equal(calls.removes, 0);
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success/);
    assert.equal(Number(row.sync_retry_count || 0), 0);

    // Settled: a second tick must not touch Trakt again.
    await syncPendingManualDispatches({}, createLoopStore());
    assert.equal(calls.adds, 1);
    assert.equal(calls.historyReads.length, 1);
  });
});

test("a timed-out write that Trakt did record is not added again", async () => {
  connectTrakt();
  const watchedAt = "2026-09-21T21:15:00.000Z";
  const history = [{
    id: 991,
    watched_at: watchedAt,
    action: "watch",
    type: "episode",
    episode: { season: 2, number: 3, title: "Echo", ids: { trakt: 55 } },
    show: { title: "Timeout Show", year: 2024, ids: { trakt: 7, tmdb: 4242, tvdb: 8080 } },
  }];
  await withTraktFetch({ history }, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Timeout Show - S02E03",
      media_type: "episode",
      show_title: "Timeout Show",
      season: 2,
      episode: 3,
      tmdb_id: "4242",
      watched_at: watchedAt,
      source: "emby",
      sync_action: "watched",
      sync_dispatch_telemetry: failedTraktTelemetry("Upstream request timed out after 20000ms"),
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(calls.historyReads.length, 1);
    assert.match(calls.historyReads[0], /\/sync\/history\/episodes\?/);
    assert.equal(calls.adds, 0, "a play already on Trakt must not be added a second time");
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success - Already on Trakt/);
    assert.equal(Number(row.sync_retry_count || 0), 0);
  });
});

test("a Trakt not_found failure is terminal and never retried", async () => {
  connectTrakt();
  await withTraktFetch({}, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Unknown To Trakt",
      media_type: "movie",
      tmdb_id: "retry-not-found-movie",
      watched_at: "2026-09-22T10:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: failedTraktTelemetry("Trakt could not match this item to mark it watched (not_found: {\"movies\":[{}]})"),
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(calls.historyReads.length + calls.adds + calls.removes, 0);
    const row = await rowById(inserted.id);
    assert.equal(Number(row.sync_retry_count || 0), 0);
  });
});

test("a Trakt server error with its own text is tagged, counted and rescheduled until the cap", async () => {
  connectTrakt();
  await withTraktFetch({ add: () => json({ error: "Server busy" }, 503) }, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Still Failing Movie",
      media_type: "movie",
      tmdb_id: "retry-503-movie",
      watched_at: "2026-09-23T10:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: failedTraktTelemetry("Trakt request failed with 502"),
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(calls.adds, 1);
    let row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: error - Server busy \(HTTP 503\)/);
    assert.equal(Number(row.sync_retry_count), 1);
    assert.ok(Number(row.sync_next_retry_at) > Date.now(), "the next attempt waits for the backoff");

    // Not due yet: nothing is sent.
    await syncPendingManualDispatches({}, createLoopStore());
    assert.equal(calls.adds, 1);

    // At the cap the row is left for a manual Retry.
    await repo.updateWatchSyncRetry(inserted.id, SYNC_RETRY_MAX_ATTEMPTS, 0);
    await syncPendingManualDispatches({}, createLoopStore());
    assert.equal(calls.adds, 1);
  });
});

test("a local retry never re-sends to Trakt when Trakt is already confirmed", async () => {
  connectTrakt();
  await withTraktFetch({}, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Jellyfin Down Movie",
      media_type: "movie",
      tmdb_id: "retry-local-only-movie",
      watched_at: "2026-09-24T10:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: [
        "Origin: plex",
        "Loop-check: Passed",
        "Dispatch status: partial",
        "Details: Synced to Trakt; failed Jellyfin",
        "Target jellyfin status: error - Upstream request failed",
        "Target trakt status: success - Marked watched on Trakt",
      ].join("\n"),
    });

    const config = { jellyfin: { baseUrl: "http://jellyfin.invalid", apiKey: "key", userId: "user" } };
    await syncPendingManualDispatches(config, createLoopStore());

    assert.equal(calls.historyReads.length + calls.adds + calls.removes, 0, "Trakt must not be contacted");
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success - Marked watched on Trakt/, "the confirmed Trakt line is carried forward");
    assert.equal(Number(row.sync_retry_count), 1, "the Jellyfin failure is still retried");
  });
});

test("a local retry carries every registered tracker's settled line forward, not only Trakt's", async () => {
  connectTrakt();
  await withTraktFetch({}, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Jellyfin Down Simkl Movie",
      media_type: "movie",
      tmdb_id: "retry-local-only-simkl-movie",
      watched_at: "2026-09-24T10:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: [
        "Origin: plex",
        "Loop-check: Passed",
        "Dispatch status: partial",
        "Details: Synced to Trakt and Simkl; failed Jellyfin",
        "Target jellyfin status: error - Upstream request failed",
        "Target trakt status: success - Marked watched on Trakt",
        "Target simkl status: success - Watched state confirmed on Simkl",
      ].join("\n"),
    });

    const config = { jellyfin: { baseUrl: "http://jellyfin.invalid", apiKey: "key", userId: "user" } };
    await syncPendingManualDispatches(config, createLoopStore());

    assert.equal(calls.historyReads.length + calls.adds + calls.removes, 0, "Trakt must not be contacted");
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success - Marked watched on Trakt/);
    assert.match(row.sync_dispatch_telemetry, /Target simkl status: success - Watched state confirmed on Simkl/, "the Simkl line is not dropped");
  });
});

// Mirrors the live Gold Rush rows (29 Sept 2026): a manual watch writes its
// target lines without the "Target " prefix. A Trakt-only retry must keep those
// local lines, or the row looks unsynced and is retried again.
test("a Trakt-only retry of a manual row keeps its unprefixed local lines and settles", async () => {
  connectTrakt();
  const watchedAt = "2026-09-26T08:35:00.000Z";
  const history = [{
    id: 1441,
    watched_at: watchedAt,
    action: "watch",
    type: "movie",
    movie: { title: "Manual Row Movie", year: 2020, ids: { trakt: 9, tmdb: 777001 } },
  }];
  await withTraktFetch({ history }, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Manual Row Movie",
      media_type: "movie",
      tmdb_id: "777001",
      watched_at: watchedAt,
      source: "manual",
      sync_action: "watched",
      sync_dispatch_telemetry: [
        "Origin: manual",
        "Action: Marked Watched",
        "Loop-check: Passed",
        "Dispatch status: error",
        "Details: Synced to no targets; failed Trakt",
        "Jellyfin status: skipped - No matching item found",
        "Trakt status: error - Trakt request failed with 429",
      ].join("\n"),
    });

    const config = { jellyfin: { baseUrl: "http://jellyfin.invalid", apiKey: "key", userId: "user" } };
    await syncPendingManualDispatches(config, createLoopStore());

    assert.deepEqual(calls.other, [], "Jellyfin already answered and must not be contacted");
    assert.equal(calls.adds + calls.removes, 0);
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Jellyfin status: skipped - No matching item found/);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success - Already on Trakt/);
    assert.equal(Number(row.sync_retry_count || 0), 0, "the row is settled, not scheduled for another attempt");
  });
});

test("Trakt failures are not retried while Trakt is disconnected", async () => {
  trackerConnectionRepo.deleteTrackerConnection("trakt");
  await withTraktFetch({}, async (calls) => {
    const inserted = await repo.insertWatchRecord({
      title: "Disconnected Movie",
      media_type: "movie",
      tmdb_id: "retry-disconnected-movie",
      watched_at: "2026-09-25T10:00:00.000Z",
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: failedTraktTelemetry("Trakt request failed with 429"),
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(calls.historyReads.length + calls.adds + calls.removes, 0);
    const row = await rowById(inserted.id);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: error - Trakt request failed with 429/);
    assert.equal(Number(row.sync_retry_count || 0), 0);
  });
});
