import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-authoritative-restore-");

const runtime = await import("../server/src/utils/configStore.js");
const jobs = await import("../server/src/utils/backgroundJobs.js");
const schedulerLease = await import("../server/src/utils/schedulerLease.js");
const { syncMediaPlaystate, syncMediaProgress } = await import("../server/src/utils/syncOrchestrator.js");
const { insertWatchRecord } = await import("../server/src/utils/dataRepo.js");
const { buildRestoreSeriesIdentityIndex, partitionTraktNotFoundBatch, restoreMediaWithSeriesIdentityFallback } = await import("../server/src/utils/trackerDispatcher.js");

test("Trakt restore recovers sparse and episode-level rows from repeated series identity", () => {
  const rows = [
    { media_type: "episode", title: "Parks and Recreation - S06E20", show_title: "Parks and Recreation", season: 6, episode: 20, imdb_id: "tt1266020", tmdb_id: "8592", tvdb_id: "84912" },
    { media_type: "episode", title: "Parks and Recreation - S07E01", show_title: "Parks and Recreation", season: 7, episode: 1, imdb_id: "tt1266020", tmdb_id: "8592", tvdb_id: "84912" },
    { media_type: "episode", title: "Parks and Recreation - S06E21", show_title: "Parks and Recreation", season: 6, episode: 21 },
  ];
  const index = buildRestoreSeriesIdentityIndex(rows);
  const sparse = restoreMediaWithSeriesIdentityFallback({
    type: "episode",
    title: rows[2].title,
    showTitle: rows[2].show_title,
    season: 6,
    episode: 21,
    ids: {},
  }, index);
  assert.deepEqual(sparse.ids, { imdb: "tt1266020", tmdb: "8592", tvdb: "84912" });

  const episodeIdentity = restoreMediaWithSeriesIdentityFallback({
    type: "episode",
    title: "Parks and Recreation - S06E22",
    showTitle: "Parks and Recreation",
    season: 6,
    episode: 22,
    ids: { imdb: "tt9999999", tmdb: "9999999", tvdb: "9999999" },
  }, index);
  assert.deepEqual(episodeIdentity.ids, { imdb: "tt1266020", tmdb: "8592", tvdb: "84912" });
});

test("Trakt restore isolates rejected plays so the remaining batch can continue", () => {
  const accepted = { type: "episode", mediaType: "episode", title: "Good Show - S01E01", season: 1, episode: 1, ids: { tmdb: "100" } };
  const rejected = { type: "episode", mediaType: "episode", title: "Broken Show - S02E03", season: 2, episode: 3, ids: { tmdb: "200" } };
  const partition = partitionTraktNotFoundBatch([accepted, rejected], {
    not_found: { episodes: [{ ids: { tmdb: "200" }, season: 2, number: 3 }] },
  });
  assert.deepEqual(partition.accepted, [accepted]);
  assert.deepEqual(partition.rejected, [rejected]);
});

test("Trakt restore isolates nested grouped episode rejections by coordinate", () => {
  const accepted = { type: "episode", mediaType: "episode", title: "Good Show - S06E20", season: 6, episode: 20, ids: { tmdb: "100" } };
  const rejected = { type: "episode", mediaType: "episode", title: "Good Show - S06E21", season: 6, episode: 21, ids: { tmdb: "100" } };
  const partition = partitionTraktNotFoundBatch([accepted, rejected], {
    not_found: {
      episodes: [{
        ids: { tmdb: "100" },
        seasons: [{ number: 6, episodes: [{ number: 21 }] }],
      }],
    },
  });
  assert.deepEqual(partition.accepted, [accepted]);
  assert.deepEqual(partition.rejected, [rejected]);
});

test("authoritative backup restore preempts active sync work and cancels its jobs", async () => {
  await runtime.setRuntimeState({
    syncOperation: null,
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    forceSyncActive: false,
    forceSyncRunId: "",
    scheduledSyncActive: false,
  });
  const lease = schedulerLease.claimSchedulerLease({ holderId: "restore-test-worker", role: "worker", ttlMs: 60_000, now: Date.now() });
  const queued = jobs.enqueueBackgroundJob("force_sync", {}, Date.now());
  const running = jobs.claimNextBackgroundJob({ holderId: "restore-test-worker", generation: lease.generation, now: Date.now() + 1 });
  assert.equal(running.id, queued.id);

  const force = await runtime.claimSyncOperation({
    kind: runtime.SYNC_OPERATION_FORCE,
    ownerId: "force-owner",
    activeField: "forceSyncActive",
    values: { forceSyncActive: true, forceSyncRunId: "force-owner" },
  });
  assert.equal(force.ok, true);
  const takeover = await runtime.claimSyncOperation({
    kind: runtime.RESTORE_KIND_BACKUP,
    ownerId: "backup-owner",
    activeField: "restoreSyncActive",
    preempt: true,
    values: { restoreSyncActive: true, restoreSyncRunId: "backup-owner", restoreSyncKind: runtime.RESTORE_KIND_BACKUP },
  });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.preempted.kind, runtime.SYNC_OPERATION_FORCE);
  jobs.cancelSyncJobsForAuthoritativeRestore();
  assert.equal(jobs.getBackgroundJob(running.id).cancelRequested, true);
  assert.equal((await runtime.loadRuntimeState()).forceSyncActive, false);

  const config = { plex: {}, emby: {}, jellyfin: {} };
  const media = { title: "Restore gate test", type: "movie", source: "plex", ids: { tmdb: "1" }, isValid: true };
  const watched = await syncMediaPlaystate(media, config, {});
  const progress = await syncMediaProgress({ ...media, positionMs: 20_000, progress: 0.2 }, config, {});
  assert.equal(watched.reason, undefined);
  assert.match(watched.details, /authoritative watch-history restore/);
  assert.match(progress.details, /authoritative watch-history restore/);

  await assert.rejects(
    insertWatchRecord({
      title: "Restore write fence test",
      media_type: "movie",
      source: "plex",
      watched_at: "2020-01-01T00:00:00.000Z",
    }, { skipInvalidate: true }),
    (error) => error?.code === "RESTORE_ACTIVE",
  );

  // A user's own watched-status edit is not refused by the restore fence.
  await assert.doesNotReject(insertWatchRecord({
    title: "Restore fence manual edit test",
    media_type: "movie",
    source: "manual",
    watched_at: "2020-01-01T00:00:00.000Z",
  }, { skipInvalidate: true }));

  await runtime.releaseSyncOperation({
    kind: runtime.RESTORE_KIND_BACKUP,
    ownerId: "backup-owner",
    values: { restoreSyncActive: false, restoreSyncRunId: "", restoreSyncKind: "" },
  });
  schedulerLease.releaseSchedulerLease({ holderId: "restore-test-worker", generation: lease.generation, now: Date.now() });
});

test("backup restore can take priority over an in-flight full sync restore", async () => {
  await runtime.setRuntimeState({ syncOperation: null, restoreSyncActive: false, restoreSyncRunId: "", restoreSyncKind: "" });
  const fullSync = await runtime.claimSyncOperation({
    kind: runtime.RESTORE_KIND_FULL_SYNC,
    ownerId: "full-sync-owner",
    activeField: "restoreSyncActive",
    values: { restoreSyncActive: true, restoreSyncRunId: "full-sync-owner", restoreSyncKind: runtime.RESTORE_KIND_FULL_SYNC },
  });
  assert.equal(fullSync.ok, true);

  const backup = await runtime.claimSyncOperation({
    kind: runtime.RESTORE_KIND_BACKUP,
    ownerId: "backup-owner-2",
    activeField: "restoreSyncActive",
    preempt: true,
    values: { restoreSyncActive: true, restoreSyncRunId: "backup-owner-2", restoreSyncKind: runtime.RESTORE_KIND_BACKUP },
  });
  assert.equal(backup.ok, true);
  assert.equal(backup.preempted.kind, runtime.RESTORE_KIND_FULL_SYNC);
  assert.equal((await runtime.loadRuntimeState()).restoreSyncRunId, "backup-owner-2");

  await runtime.releaseSyncOperation({
    kind: runtime.RESTORE_KIND_BACKUP,
    ownerId: "backup-owner-2",
    values: { restoreSyncActive: false, restoreSyncRunId: "", restoreSyncKind: "" },
  });
});

test("async restore cancellation hooks are awaited by outbound dispatch", async () => {
  await runtime.setRuntimeState({ syncOperation: null, restoreSyncActive: false, restoreSyncRunId: "", restoreSyncKind: "" });
  const result = await syncMediaPlaystate(
    { title: "Async restore hook", type: "movie", source: "restore", ids: { tmdb: "2" }, isValid: true },
    {},
    {},
    { includeTrackers: false, shouldDefer: async () => true },
  );
  assert.equal(result.deferred, true);
  assert.match(result.details, /newer unwatched state took precedence/);
});
