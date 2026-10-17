import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-pending-manual-dispatch-trakt-date-");

const repo = await import("../server/src/utils/dataRepo.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { syncPendingManualDispatches } = await import("../server/src/utils/syncDispatchQueue.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

function connectTrakt(overrides = {}) {
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
    ...overrides,
  });
}

// Regression coverage: the scheduler's backlog-drain sweep picks up any
// sync_action='watched' row whose telemetry still reads "Dispatch status:
// pending" (which is exactly what remainingWatchRowFor() writes when it
// promotes a stale unwatched row left standing after a duplicate-watch
// removal - see dataRepo.js) and re-dispatches it. The media object it built
// for that re-dispatch never carried the row's own watched_at, so
// traktClient.js's syncPayload fell back to Date.now() - a real historical
// watch (e.g. from months ago) reached Trakt stamped as watched right now
// instead of on its actual date.
test("syncPendingManualDispatches sends the row's real historical watched_at to Trakt, not now", async () => {
  connectTrakt();
  let capturedWatchedAt = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://api.trakt.tv/sync/history") {
      const body = JSON.parse(options.body || "{}");
      capturedWatchedAt = body?.shows?.[0]?.seasons?.[0]?.episodes?.[0]?.watched_at || null;
      return new Response(JSON.stringify({ added: { episodes: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (href === "https://api.trakt.tv/sync/history/remove") {
      return new Response(JSON.stringify({ deleted: {}, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    const historicalWatchedAt = "2026-07-17T07:38:26.506Z";
    await repo.insertWatchRecord({
      title: "Promoted Sweep Show - S01E01",
      media_type: "episode",
      show_title: "Promoted Sweep Show",
      season: 1,
      episode: 1,
      tmdb_id: "sweep-1",
      watched_at: historicalWatchedAt,
      source: "plex",
      sync_action: "watched",
      sync_dispatch_telemetry: "Origin: manual\nLoop-check: Passed\nDispatch status: pending\nDetails: Promoted to watched.",
    });

    const loopStore = createLoopStore();
    await syncPendingManualDispatches({}, loopStore);

    assert.ok(capturedWatchedAt, "expected a /sync/history request to Trakt");
    assert.equal(capturedWatchedAt, historicalWatchedAt, "Trakt must receive the row's real watched_at, not the current time");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("syncPendingManualDispatches replays a queued manual unwatch as unplayed", async () => {
  connectTrakt();
  let removeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://api.trakt.tv/sync/history/remove") {
      removeCalls += 1;
      return new Response(JSON.stringify({ deleted: { movies: 1 }, not_found: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    const inserted = await repo.insertWatchRecord({
      title: "Queued Unwatch Movie",
      media_type: "movie",
      tmdb_id: "queued-unwatch-movie",
      watched_at: "2026-07-17T07:38:26.506Z",
      source: "plex",
      sync_action: "unwatched",
      sync_dispatch_telemetry: "Origin: manual\nAction: Marked Unwatched\nDispatch status: pending\nDetails: queued while restore was active",
    });

    await syncPendingManualDispatches({}, createLoopStore());

    assert.equal(removeCalls, 1, "the queued unwatch must use Trakt's history removal endpoint");
    const row = (await repo.getCachedHistory()).find((entry) => entry.id === inserted.id);
    assert.doesNotMatch(row.sync_dispatch_telemetry, /Dispatch status: pending/);
    assert.match(row.sync_dispatch_telemetry, /Target trakt status: success/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
