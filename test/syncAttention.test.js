import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-sync-attention-");

const runtime = await import("../server/src/utils/configStore.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { getOnboardingState } = await import("../server/src/utils/onboardingStore.js");
const { handleSyncAttention } = await import("../server/src/routes/syncAttention.js");
const { buildSyncAttentionItems, syncAttentionState } = await import("../server/src/utils/syncAttention.js");

function mockRequestResponse(method = "GET", body = {}) {
  const request = {
    method,
    body,
    cookies: {},
    headers: { "x-api-key": AUTH.apiKey },
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let statusCode = 200;
  let payload = null;
  const response = {
    status(code) { statusCode = code; return this; },
    set() { return this; },
    send(value) { payload = JSON.parse(value); return this; },
  };
  return { request, response, status: () => statusCode, payload: () => payload };
}

const traktFailure = {
  success: false,
  error: "Trakt rejected 2 restored play(s) after 3 retries (for example: Split Show - S01E01, Split Show - S01E02)",
};

const structuredTraktFailure = {
  success: false,
  error: "Trakt rejected 2 restored play(s) after 3 retries",
  restoreIssueCount: 2,
  restoreIssuesComplete: true,
  restoreIssues: [
    {
      key: "restore-row:one",
      sourceRowId: "one",
      title: "Split Show - S01E01 - Part One",
      showTitle: "Split Show",
      type: "episode",
      season: 1,
      episode: 1,
      sourceSeason: 1,
      sourceEpisode: 1,
      watchedAt: "2016-08-21T19:33:00.000Z",
      ids: { tmdb: "123" },
      reason: "Trakt returned not_found for this play.",
    },
    {
      key: "restore-row:two",
      sourceRowId: "two",
      title: "Split Show - S01E02 - Part Two",
      showTitle: "Split Show",
      type: "episode",
      season: 1,
      episode: 2,
      sourceSeason: 1,
      sourceEpisode: 2,
      watchedAt: "2016-08-21T20:10:00.000Z",
      ids: { tmdb: "123" },
      reason: "Trakt returned not_found for this play.",
    },
  ],
};

test("restore failures become actionable attention items with split-episode guidance", () => {
  const items = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-123",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: traktFailure,
  }, {});

  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "blocking");
  assert.equal(items[0].canSkip, true);
  assert.match(items[0].title, /Trakt rejected/);
  assert.match(items[0].explanation, /paused/);
  assert.match(items[0].explanation, /split, combined, or special episode/i);
  assert.ok(items[0].recommendations.some((item) => /split or combined episodes/i.test(item)));
  assert.deepEqual(items[0].context.examples, ["Split Show - S01E01", "Split Show - S01E02"]);
});
test("structured restore failures expose every play with a local repair link", () => {
  const [item] = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-structured",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: structuredTraktFailure,
  }, {});

  assert.equal(item.context.issueCount, 2);
  assert.equal(item.context.issueItemsComplete, true);
  assert.equal(item.context.issueItems.length, 2);
  assert.equal(item.context.issueItems[0].canRepair, true);
  assert.match(item.context.issueItems[0].localHref, /historyId=one/);
  assert.match(item.context.issueItems[1].localHref, /episode\/2/);
});

test("media-server restore failures expose target-specific repair actions", () => {
  const [item] = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-app-123",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: {
      success: false,
      runId: "restore-app-123",
      finishedAt: Date.now(),
      error: "1 restored item projection still need attention on emby.",
      restoreIssueCount: 1,
      restoreIssuesComplete: true,
      restoreIssues: [{
        key: "restore-target:emby:media-1:x:1",
        provider: "emby",
        target: "emby",
        sourceRowId: "history-1",
        sourcePlaystateKey: "media-1",
        sourceTitle: "Split Show - S01E01 - Part One",
        showTitle: "Split Show",
        type: "episode",
        season: 1,
        episode: 1,
        watchedAt: "2016-08-21T19:33:00.000Z",
        reason: "timed out after 30000ms: emby: Split Show - S01E01 - Part One",
      }],
    },
  }, {});

  assert.equal(item.kind, "restore_projection_failures");
  assert.deepEqual(item.context.providers, ["emby"]);
  assert.equal(item.context.issueItems[0].provider, "emby");
  assert.equal(item.context.issueItems[0].canRepair, true);
  assert.equal(item.context.issueItems[0].repairLabel, "Retry on Emby");
  assert.match(item.context.issueItems[0].localHref, /historyId=history-1/);
  assert.match(item.recommendations.join(" "), /Emby/i);
});

test("media-server restore failures remain repairable when only the playstate key was retained", () => {
  const [item] = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-playstate-key-123",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: {
      success: false,
      runId: "restore-playstate-key-123",
      finishedAt: Date.now(),
      error: "1 restored item projection still need attention on jellyfin.",
      restoreIssueCount: 1,
      restoreIssuesComplete: true,
      restoreIssues: [{
        key: "restore-target:jellyfin:show-key:1:1",
        provider: "jellyfin",
        target: "jellyfin",
        sourceMediaKey: "episode:tmdb:123:1:1",
        sourceTitle: "A Thousand Blows - S01E01",
        showTitle: "A Thousand Blows",
        type: "episode",
        season: 1,
        episode: 1,
        watchedAt: "2026-08-22T01:21:00.000Z",
        reason: "timed out after 30000ms: jellyfin: A Thousand Blows - S01E01",
      }],
    },
  }, {});

  assert.equal(item.context.issueItems[0].sourceMediaKey, "episode:tmdb:123:1:1");
  assert.equal(item.context.issueItems[0].canRepair, true);
  assert.equal(item.context.issueItems[0].repairLabel, "Retry on Jellyfin");
});

test("expected media availability skips do not become restore blockers", () => {
  const [item] = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-availability-123",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: {
      success: false,
      runId: "restore-availability-123",
      finishedAt: Date.now(),
      error: "3 restored item projections still need attention on plex, emby, jellyfin.",
      restoreIssueCount: 3,
      restoreIssuesComplete: true,
      restoreIssues: [
        {
          key: "restore-target:plex:missing-1:x:x",
          provider: "plex",
          sourceRowId: "history-missing-1",
          sourceTitle: "Unavailable Movie",
          type: "movie",
          reason: "No matching item found",
        },
        {
          key: "restore-target:emby:missing-1:x:x",
          provider: "emby",
          sourceRowId: "history-missing-1",
          sourceTitle: "Unavailable Movie",
          type: "movie",
          reason: "No matching item was found on emby",
        },
        {
          key: "restore-target:jellyfin:timeout-1:x:x",
          provider: "jellyfin",
          sourceRowId: "history-timeout-1",
          sourceTitle: "Reachable Movie",
          type: "movie",
          reason: "timed out after 30000ms",
        },
      ],
    },
  }, {});

  assert.equal(item.context.expectedSkipCount, 2);
  assert.equal(item.context.issueCount, 1);
  assert.equal(item.context.issueItems.length, 1);
  assert.equal(item.context.issueItems[0].provider, "jellyfin");
  assert.match(item.summary, /2 expected availability skips omitted/i);
});

test("intentional cancellation/reset results do not become blockers and skips are durable", () => {
  const cancelled = buildSyncAttentionItems({
    restoreSyncActive: false,
    restoreSyncResult: { success: false, cancelled: true, reset: true, reason: "Administrator reset" },
  }, {});
  assert.deepEqual(cancelled, []);

  const item = buildSyncAttentionItems({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-456",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: traktFailure,
    syncAttentionSkips: {},
  }, {})[0];
  const state = syncAttentionState({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-456",
    restoreSyncKind: "backup_restore",
    restoreSyncResult: traktFailure,
    syncAttentionSkips: { [item.id]: { skippedAt: Date.now() } },
  }, {});
  assert.equal(state.count, 0);
});

test("failed initial imports are surfaced while cancelled imports remain quiet", () => {
  const failed = buildSyncAttentionItems({}, {
    backgroundImports: {
      servers: { emby: { status: "failed", startedAt: 100, completedAt: 200, error: "Emby connection refused" } },
      trackers: { trakt: { status: "cancelled", error: "Cancelled by administrator" } },
    },
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].source, "initial_import");
  assert.match(failed[0].title, /Emby/);
  assert.ok(failed[0].recommendations.some((item) => /reachable/i.test(item)));
});

test("skipping the matching restore blocker records an exception and releases only its restore lock", async () => {
  await runtime.setRuntimeState({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-route-789",
    restoreSyncKind: runtime.RESTORE_KIND_BACKUP,
    restoreSyncStartedAt: Date.now(),
    restoreSyncHeartbeat: Date.now(),
    restoreSyncResult: { ...traktFailure, runId: "restore-route-789" },
    syncOperation: null,
    syncAttentionSkips: {},
  });

  const get = mockRequestResponse("GET");
  await handleSyncAttention(get.request, get.response);
  assert.equal(get.status(), 200);
  assert.equal(get.payload().count, 1);
  const id = get.payload().attention[0].id;

  const post = mockRequestResponse("POST", { id });
  await handleSyncAttention(post.request, post.response);
  assert.equal(post.status(), 200);
  assert.equal(post.payload().ok, true);
  assert.equal(post.payload().released, true);
  assert.equal(post.payload().count, 0);

  const after = await runtime.loadRuntimeState();
  assert.equal(after.restoreSyncActive, false);
  assert.equal(after.restoreSyncRunId, "");
  assert.equal(after.restoreSyncResult.completedWithSkippedIssues, true);
  assert.equal(after.restoreSyncResult.success, true);
  assert.ok(Number(after.lastRestoreAt) > 0);
  assert.ok(after.syncAttentionSkips[id].skippedAt > 0);

  await runtime.setRuntimeState({
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    restoreSyncResult: null,
    syncOperation: null,
    syncAttentionSkips: {},
  });
});

test("individual restore issues can be skipped while the restore fence remains until the last one", async () => {
  await runtime.setRuntimeState({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-item-route-123",
    restoreSyncKind: runtime.RESTORE_KIND_BACKUP,
    restoreSyncStartedAt: Date.now(),
    restoreSyncHeartbeat: Date.now(),
    restoreSyncResult: { ...structuredTraktFailure, runId: "restore-item-route-123" },
    syncOperation: null,
    syncAttentionSkips: {},
  });

  const get = mockRequestResponse("GET");
  await handleSyncAttention(get.request, get.response);
  const parent = get.payload().attention[0];
  const firstKey = parent.context.issueItems[0].key;
  const first = mockRequestResponse("POST", { id: parent.id, itemKey: firstKey, action: "skip-item" });
  await handleSyncAttention(first.request, first.response);
  assert.equal(first.status(), 200);
  assert.equal(first.payload().released, false);
  assert.equal(first.payload().count, 1);

  const afterFirst = await runtime.loadRuntimeState();
  assert.equal(afterFirst.restoreSyncActive, true);
  assert.equal(afterFirst.restoreSyncResult.restoreIssues.length, 1);

  const remainingKey = first.payload().attention[0].context.issueItems[0].key;
  const second = mockRequestResponse("POST", { id: parent.id, itemKey: remainingKey, action: "skip-item" });
  await handleSyncAttention(second.request, second.response);
  assert.equal(second.status(), 200);
  assert.equal(second.payload().released, true);
  assert.equal(second.payload().count, 0);

  await runtime.setRuntimeState({
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    restoreSyncResult: null,
    syncOperation: null,
    syncAttentionSkips: {},
  });
});

test("multiple restore issues can be skipped at once with skip-items releasing the restore fence", async () => {
  await runtime.setRuntimeState({
    restoreSyncActive: true,
    restoreSyncRunId: "restore-items-batch-456",
    restoreSyncKind: runtime.RESTORE_KIND_BACKUP,
    restoreSyncStartedAt: Date.now(),
    restoreSyncHeartbeat: Date.now(),
    restoreSyncResult: { ...structuredTraktFailure, runId: "restore-items-batch-456" },
    syncOperation: null,
    syncAttentionSkips: {},
  });

  const get = mockRequestResponse("GET");
  await handleSyncAttention(get.request, get.response);
  const parent = get.payload().attention[0];
  const allKeys = parent.context.issueItems.map((i) => i.key);
  assert.equal(allKeys.length, 2);

  const batchSkip = mockRequestResponse("POST", { id: parent.id, itemKeys: allKeys, action: "skip-items" });
  await handleSyncAttention(batchSkip.request, batchSkip.response);
  assert.equal(batchSkip.status(), 200);
  assert.equal(batchSkip.payload().released, true);
  assert.equal(batchSkip.payload().count, 0);

  const afterBatch = await runtime.loadRuntimeState();
  assert.equal(afterBatch.restoreSyncActive, false);
  assert.equal(afterBatch.restoreSyncResult.restoreIssues.length, 0);

  await runtime.setRuntimeState({
    restoreSyncActive: false,
    restoreSyncRunId: "",
    restoreSyncKind: "",
    restoreSyncResult: null,
    syncOperation: null,
    syncAttentionSkips: {},
  });
});
