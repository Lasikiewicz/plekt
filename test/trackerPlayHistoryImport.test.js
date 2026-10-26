import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tracker-play-history-");

const repo = await import("../server/src/utils/dataRepo.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { pollConnectedTrackers } = await import("../server/src/utils/trackerSync.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
const { trackerMediaKey } = await import("../server/src/utils/traktClient.js");

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
  // Fixture history predates this connection, so it remains eligible for the
  // normal post-baseline play-history import path.
  repo.requireDb().prepare("UPDATE tracker_connections SET connected_at=? WHERE provider='trakt'").run(Date.parse("2026-01-01T00:00:00.000Z"));
}

// Regression coverage for the incident where the Trakt play-history import
// (added to preserve rewatches) fed straight back out to Trakt: an imported
// play had no "already synced" telemetry, so the scheduler's manual-dispatch
// retry sweep treated it as pending work and re-pushed it to Trakt, which
// assigned it a new history id that the next poll re-imported and re-pushed -
// an unbounded loop that flooded the connected Trakt account's history.
test("importing Trakt play history never pushes those plays back out to Trakt or leaves them pending re-dispatch", async () => {
  connectTrakt();
  let historyWriteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/sync/watched/")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "https://api.trakt.tv/sync/history" || href === "https://api.trakt.tv/sync/history/remove") {
      historyWriteCalls += 1;
      return new Response(JSON.stringify({ added: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/history/movies")) {
      return new Response(JSON.stringify([{
        id: 555001,
        watched_at: "2026-08-10T10:00:00.000Z",
        action: "watch",
        type: "movie",
        movie: { title: "Arrival", year: 2016, ids: { trakt: 1, imdb: "tt2543164", tmdb: 329865 } },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/history/episodes")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    const result = await pollConnectedTrackers();
    assert.equal(result.skipped, false);

    const movie = { type: "movie", ids: { imdb: "tt2543164", tmdb: "329865" } };
    const stored = await repo.findExistingWatch(repo.mediaKeyFor(movie), "2026-08-10T10:00:00.000Z");
    assert.ok(stored, "the backfilled play should be stored in watch_history");
    assert.equal(stored.source, "trakt_import");

    // These are exactly the substrings server/src/scheduled.js's
    // syncPendingManualDispatches checks to decide whether a row still needs
    // outbound propagation. If either assertion below fails, that sweep will
    // pick this row back up and re-dispatch it - including back out to Trakt.
    assert.ok(!stored.sync_dispatch_telemetry.includes("Dispatch status: pending"), "must not read as pending");
    for (const target of ["plex", "emby", "jellyfin"]) {
      assert.match(stored.sync_dispatch_telemetry, new RegExp(`Target ${target} status: skipped`));
    }

    assert.equal(historyWriteCalls, 0, "the import must never call Trakt's /sync/history write endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Regression coverage for a real incident (2026-08-19): a manual "mark
// watched" bug pushed the wrong (current-time) date to Trakt via a canonical
// replay. The play-history importer had no way to know that play was just an
// echo of Plembfin's own very-recent push, so it imported it as a genuine
// new play - creating a phantom second local watch alongside the correct
// one. That underlying push-date bug is now fixed separately, but this is
// defense-in-depth against any future bug (or plain clock skew) doing the
// same thing again.
test("an IMDb-rich Trakt play arriving after our TMDB-only push is treated as an echo", async () => {
  connectTrakt({ baselineComplete: true });
  const media = { type: "movie", ids: { imdb: "tt9999999", tmdb: "999999" } };
  const outboundMedia = { type: "movie", ids: { tmdb: "999999" } };
  trackerConnectionRepo.recordTrackerOutbound("trakt", trackerMediaKey(outboundMedia), outboundMedia, "watched");
  const echoWatchedAtIso = new Date(Date.now() + 5000).toISOString(); // 5s after our own push, well inside the echo window

  let historyWriteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/sync/watched/")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "https://api.trakt.tv/sync/history" || href === "https://api.trakt.tv/sync/history/remove") {
      historyWriteCalls += 1;
      return new Response(JSON.stringify({ added: {} }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/history/movies")) {
      return new Response(JSON.stringify([{
        id: 777001, watched_at: echoWatchedAtIso, action: "watch", type: "movie",
        movie: { title: "Echo Movie", ids: { imdb: "tt9999999", tmdb: 999999 } },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/sync/history/episodes")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };

  try {
    await pollConnectedTrackers();

    const stored = await repo.findExistingWatch(repo.mediaKeyFor(media), echoWatchedAtIso);
    assert.equal(stored, null, "an echo of our own recent outbound push must not be imported as a new local watch");
    assert.equal(historyWriteCalls, 0);

    const db = repo.requireDb();
    const recordedPlay = db.prepare("SELECT * FROM tracker_play_history WHERE provider='trakt' AND history_id=?").get("777001");
    assert.ok(recordedPlay, "the historyId must still be recorded so it is not re-evaluated on every poll");
    assert.equal(recordedPlay.watch_record_id, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an outbound watch sourced from Trakt (live sync or import) is never echoed back to Trakt", async () => {
  connectTrakt();
  let historyWriteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.trakt.tv/sync/history") historyWriteCalls += 1;
    return new Response(JSON.stringify({ added: {} }), { status: 201, headers: { "content-type": "application/json" } });
  };

  try {
    for (const source of ["trakt", "trakt_import"]) {
      const [entry] = await dispatchTrackerWatchState({
        title: "Arrival", type: "movie", source, ids: { imdb: "tt2543164" }, watched_at: "2026-08-10T10:00:00.000Z",
      }, "watched");
      assert.equal(entry.status, "skipped");
      assert.match(entry.detail, /echo suppressed/i);
    }
    assert.equal(historyWriteCalls, 0, "a Trakt-sourced watch must never trigger an outbound Trakt write");

    // Sanity check the guard is source-specific, not a blanket no-op: a
    // genuinely new watch from a media server should still reach Trakt.
    const [plexEntry] = await dispatchTrackerWatchState({
      title: "Arrival", type: "movie", source: "plex", ids: { imdb: "tt2543164" }, watched_at: "2026-08-10T10:00:00.000Z",
    }, "watched");
    assert.equal(plexEntry.status, "success");
    assert.equal(historyWriteCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the stale-telemetry repair settles pre-fix trakt_import rows without touching anything else", async () => {
  // A row shaped exactly like what the buggy pre-fix importer created: no
  // sync_dispatch_telemetry at all, so it reads as "pending" to the retry sweep.
  const stale = await repo.insertWatchRecord({
    title: "Reacher - S01E07", show_title: "Reacher", media_type: "episode", season: 1, episode: 7,
    watched_at: "2026-08-10T10:00:00.000Z", source: "trakt_import", imdb_id: "tt14503470",
  });
  // A row with telemetry already set (post-fix, or a legitimate CSV import)
  // must be left completely alone by the repair.
  const settled = await repo.insertWatchRecord({
    title: "Reacher - S01E08", show_title: "Reacher", media_type: "episode", season: 1, episode: 8,
    watched_at: "2026-08-11T10:00:00.000Z", source: "trakt_import", imdb_id: "tt14503474",
    sync_dispatch_telemetry: "Origin: trakt_import\nDispatch status: pending",
  });
  // A non-trakt_import row must never be touched by this repair either.
  const unrelated = await repo.insertWatchRecord({
    title: "Silo - S01E01", media_type: "episode", season: 1, episode: 1,
    watched_at: "2026-08-12T10:00:00.000Z", source: "plex",
  });

  const auditBefore = repo.auditStaleTraktImportRows();
  assert.equal(auditBefore.count, 1);
  assert.equal(auditBefore.sample[0].id, stale.id);

  const result = repo.repairStaleTraktImportRows();
  assert.equal(result.repaired, 1);

  const db = repo.requireDb();
  const staleRow = db.prepare("SELECT sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(stale.id);
  assert.ok(!staleRow.sync_dispatch_telemetry.includes("Dispatch status: pending"));
  assert.match(staleRow.sync_dispatch_telemetry, /Target plex status: skipped/);

  const settledRow = db.prepare("SELECT sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(settled.id);
  assert.equal(settledRow.sync_dispatch_telemetry, "Origin: trakt_import\nDispatch status: pending");

  const unrelatedRow = db.prepare("SELECT sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(unrelated.id);
  assert.equal(unrelatedRow.sync_dispatch_telemetry, null);

  assert.equal(repo.auditStaleTraktImportRows().count, 0);
});
