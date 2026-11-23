import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-auto-sync-");

const { db } = await import("../server/src/db.js");
const {
  UP_NEXT_PRIORITY_SYNC_JOB,
  requestUpNextAutoSync,
  runAutomaticUpNextSync,
  upNextQueueFingerprint,
} = await import("../server/src/utils/upNextAutoSync.js");

test("Up Next fingerprints ignore observation timestamps but track queue content and order", () => {
  const first = [{
    id: "episode:show:s3:e7",
    title: "Episode 7",
    media_type: "episode",
    position_ms: 6000,
    provider_items: { emby: ["episode-2", "episode-1"] },
    observed_at: 1000,
    source_updated_at: 1100,
  }];
  const sameContent = [{
    id: "episode:show:s3:e7",
    title: "Episode 7",
    media_type: "episode",
    position_ms: 6000,
    provider_items: { emby: ["episode-1", "episode-2"] },
    observed_at: 2000,
    source_updated_at: 2100,
  }];
  const changed = [{ ...sameContent[0], position_ms: 12_000 }];
  const reordered = [{ id: "episode:show:s3:e8", title: "Episode 8" }, first[0]];

  assert.equal(upNextQueueFingerprint(first), upNextQueueFingerprint(sameContent));
  assert.notEqual(upNextQueueFingerprint(first), upNextQueueFingerprint(changed));
  assert.notEqual(upNextQueueFingerprint(first), upNextQueueFingerprint(reordered));
});

test("automatic Up Next requests coalesce into one durable background job", async () => {
  const first = await requestUpNextAutoSync("first queue change");
  const second = await requestUpNextAutoSync("second queue change");

  assert.equal(first.queued, true);
  assert.equal(second.coalesced, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE type='up_next_sync' AND status='queued'").get().count, 1);
  assert.deepEqual(db.prepare("SELECT payload FROM background_jobs WHERE type='up_next_sync'").get(), {
    payload: JSON.stringify({ reason: "first queue change" }),
  });
});

test("manual Up Next changes use a priority job lane", async () => {
  db.prepare("DELETE FROM background_job_logs").run();
  db.prepare("DELETE FROM background_jobs").run();

  const normal = await requestUpNextAutoSync("background queue change");
  const priority = await requestUpNextAutoSync("media page add", { priority: true });

  assert.equal(normal.queued, true);
  assert.equal(priority.queued, true);
  assert.equal(priority.job.type, UP_NEXT_PRIORITY_SYNC_JOB);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE status='queued'").get().count, 2);
});

test("automatic Up Next sync skips cleanly when no provider is configured", async () => {
  const result = await runAutomaticUpNextSync();
  assert.deepEqual(result, { status: "skipped", reason: "no-configured-providers" });
});

// Step 7 offline run: with Jellyfin down no run was ever remembered, and each
// run's Emby rail restamp set rerun, so pushes ran back to back (9 a minute).
test("an unreachable provider does not keep the automatic push running, and its recovery queues one", async (t) => {
  const { loadMediaConfig, saveMediaConfig, saveProviderLibraryMonitoring } = await import("../server/src/utils/configStore.js");
  const { refreshUpNextProviderFeeds } = await import("../server/src/utils/upNextProviderSync.js");
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let jellyfinUp = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "jellyfin.test" && !jellyfinUp) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user", serverId: "emby-auto-srv" },
    jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user", serverId: "jf-auto-srv" },
  });
  saveProviderLibraryMonitoring("emby", { serverId: "emby-auto-srv", selectedIds: ["emby-lib-1"] });
  saveProviderLibraryMonitoring("jellyfin", { serverId: "jf-auto-srv", selectedIds: ["jf-lib-1"] });

  const first = await runAutomaticUpNextSync();
  assert.equal(first.status, "partial");
  assert.equal(first.summary.pushedProviders.includes("emby"), true);
  assert.equal(first.summary.pushedProviders.includes("jellyfin"), false);
  const second = await runAutomaticUpNextSync();
  assert.equal(second.status, "unchanged");

  db.prepare("DELETE FROM background_jobs").run();
  jellyfinUp = true;
  // The scheduler's failed-feed retry path, which reads outside a push.
  await refreshUpNextProviderFeeds({ config: await loadMediaConfig(), providers: ["jellyfin"] });
  const queuedPayload = () => db.prepare("SELECT payload FROM background_jobs WHERE type='up_next_sync'").get()?.payload || "";
  for (let waited = 0; !queuedPayload() && waited < 3000; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(queuedPayload(), /jellyfin (next_up|resume) feed recovered/);
  const third = await runAutomaticUpNextSync();
  assert.equal(third.status, "succeeded");
  assert.equal(third.summary.pushedProviders.includes("jellyfin"), true);
  assert.equal(third.syncStatus?.status, "succeeded");

  const { readUpNextSyncStatus, recordManualUpNextSyncResult } = await import("../server/src/utils/upNextAutoSync.js");
  const recordedAuto = await readUpNextSyncStatus();
  assert.equal(recordedAuto?.mode, "auto");
  assert.equal(recordedAuto?.status, "succeeded");
  assert.deepEqual(recordedAuto?.pushedProviders, ["emby", "jellyfin"]);

  const manualStatus = await recordManualUpNextSyncResult(
    await loadMediaConfig(),
    [{ id: "episode:show:s1:e1" }],
    { ok: true, pushedProviders: ["emby"], feeds: [{ provider: "jellyfin", status: "failed" }] },
  );
  assert.equal(manualStatus?.mode, "manual");
  assert.equal(manualStatus?.status, "partial");
  assert.deepEqual(manualStatus?.pushedProviders, ["emby"]);
  assert.deepEqual(manualStatus?.failedFeedProviders, ["jellyfin"]);
});


test("a partial push retries only the failed destination with capped exponential backoff, and recovery clears it", async (t) => {
  const { saveMediaConfig, saveProviderLibraryMonitoring, loadRuntimeState, setRuntimeState } = await import("../server/src/utils/configStore.js");
  const { requestDueUpNextRetry } = await import("../server/src/utils/upNextAutoSync.js");
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  const calls = [];
  let jellyfinNextUpDown = true;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ host: url.hostname, method: String(options.method || "GET").toUpperCase() });
    // One Jellyfin feed fails and the other answers, so Jellyfin is a failed
    // destination but not an "unreachable" one that would be settled over.
    if (url.hostname === "jellyfin.test" && url.pathname === "/Shows/NextUp" && jellyfinNextUpDown) {
      return new Response("boom", { status: 500 });
    }
    if (options.method && options.method !== "GET") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.error = () => {};
  console.log = () => {};
  // Real time plus an offset, so code that polls Date.now still advances.
  const realNow = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, "now", () => realNow() + skew);
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  });

  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user", serverId: "emby-auto-srv" },
    jellyfin: { baseUrl: "http://jellyfin.test", apiKey: "jellyfin-key", userId: "jelly-user", serverId: "jf-auto-srv" },
  });
  saveProviderLibraryMonitoring("emby", { serverId: "emby-auto-srv", selectedIds: ["emby-lib-1"] });
  saveProviderLibraryMonitoring("jellyfin", { serverId: "jf-auto-srv", selectedIds: ["jf-lib-1"] });
  db.prepare("DELETE FROM background_job_logs").run();
  db.prepare("DELETE FROM background_jobs").run();
  await setRuntimeState({ upNextAutoSyncFingerprint: null, upNextAutoSyncRetry: null });
  const retryState = async () => (await loadRuntimeState()).upNextAutoSyncRetry;
  const hostCalls = (host) => calls.filter((call) => call.host === host).length;

  const advanceTo = (at) => { skew += Math.max(0, at - Date.now()) + 1; };
  // Runs one automatic sync and returns the delay it scheduled, to the millisecond window of the run.
  const runAndReadDelay = async () => {
    const before = Date.now();
    const run = await runAutomaticUpNextSync();
    const after = Date.now();
    const state = await retryState();
    return { run, state, minDelay: state.dueAt - after, maxDelay: state.dueAt - before };
  };

  // Attempt 1: Emby succeeds, Jellyfin does not. Retry is for Jellyfin only.
  const expectedDelays = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
  let attempt = await runAndReadDelay();
  assert.equal(attempt.run.status, "partial");
  assert.equal(attempt.run.summary.feeds.some((feed) => feed.provider === "jellyfin" && feed.feed_kind === "next_up" && feed.status === "failed"), true);
  assert.deepEqual(attempt.state.completed, ["emby"]);
  assert.equal(attempt.state.attempt, 1);
  assert.ok(attempt.minDelay <= expectedDelays[0] && expectedDelays[0] <= attempt.maxDelay);

  // Before it is due the run waits and touches no provider, and no retry job is queued yet.
  const callsBeforeWait = calls.length;
  assert.equal((await runAutomaticUpNextSync()).status, "retry_pending");
  assert.equal(calls.length, callsBeforeWait);
  assert.equal(await requestDueUpNextRetry(), null);

  // Successive failures: due after 1, 2, 4, 8, 16 then a capped 30 minutes.
  for (let n = 2; n <= expectedDelays.length; n += 1) {
    advanceTo(attempt.state.dueAt);
    db.prepare("DELETE FROM background_jobs").run();
    const dueRequest = await requestDueUpNextRetry();
    assert.ok(dueRequest?.queued || dueRequest?.coalesced, "a due retry requests the automatic job");
    const embyBefore = hostCalls("emby.test");
    attempt = await runAndReadDelay();
    assert.equal(attempt.run.status, "partial");
    assert.equal(hostCalls("emby.test"), embyBefore, "Emby already took the push and is not contacted again");
    assert.equal(attempt.state.attempt, n);
    assert.deepEqual(attempt.state.completed, ["emby"]);
    assert.ok(
      attempt.minDelay <= expectedDelays[n - 1] && expectedDelays[n - 1] <= attempt.maxDelay,
      "attempt " + n + " scheduled " + attempt.minDelay + " to " + attempt.maxDelay + " ms, expected " + expectedDelays[n - 1],
    );
  }

  // Jellyfin recovers: its retry succeeds, Emby is still not re-pushed, and the retry state is cleared.
  jellyfinNextUpDown = false;
  advanceTo(attempt.state.dueAt);
  const embyBeforeRecovery = hostCalls("emby.test");
  const recovered = await runAutomaticUpNextSync();
  assert.equal(recovered.status, "succeeded");
  assert.deepEqual([...recovered.summary.pushedProviders].sort(), ["emby", "jellyfin"]);
  assert.equal(hostCalls("emby.test"), embyBeforeRecovery);
  assert.equal(await retryState(), null);
  assert.equal(await requestDueUpNextRetry(), null);
});
