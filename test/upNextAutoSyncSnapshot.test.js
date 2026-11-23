import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-up-next-auto-sync-snapshot-");

const { bumpDataVersion, getDataVersion, getUpNextVersion } = await import("../server/src/db.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { getUpNextFeedSourceVersion } = await import("../server/src/utils/upNextRepository.js");
const { rememberUpNextSync, runAutomaticUpNextSync } = await import("../server/src/utils/upNextAutoSync.js");

const cacheFile = path.join(dataDir, "up-next-cache.json");

// A card no real build can produce here (the history is empty), so its
// presence in the sync's result proves the sync read the shared snapshot.
const cachedItem = {
  id: "movie:cached-snapshot-only",
  media_key: "movie:cached-snapshot-only",
  media_type: "movie",
  title: "Cached Snapshot Only",
  poster_url: "/posters/cached.jpg",
  provider_items: {},
};

function writeCurrentCache(items) {
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 7,
    builtAt: Date.now(),
    sourceVersion: getUpNextFeedSourceVersion(),
    historyVersion: getDataVersion(),
    upNextVersion: getUpNextVersion(),
    items,
    sourceStatus: [],
  }));
}

// Step 2 of plan/archive/up-next-build-speed/summary.md: the automatic sync built its own
// projection on every queue change, so each removal cost two full builds.
test("the automatic Up Next sync reads the shared snapshot and rebuilds it only when history changed", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  globalThis.fetch = async () => new Response(JSON.stringify({ Items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  console.error = () => {};
  console.log = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  });
  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
  });

  writeCurrentCache([cachedItem]);
  await rememberUpNextSync([cachedItem]);
  const current = await runAutomaticUpNextSync();
  assert.equal(current.status, "unchanged");
  assert.equal(current.itemCount, 1, "a current snapshot is served without a build");

  bumpDataVersion("test history change");
  const rebuilt = await runAutomaticUpNextSync();
  assert.equal(rebuilt.itemCount, 0, "a history change waits for a fresh build");
  const stored = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.deepEqual(stored.items, [], "the rebuild went through the shared cache");
  assert.equal(stored.historyVersion, getDataVersion());
});

function queueItem(id) {
  return {
    id: `movie:${id}`,
    media_key: `movie:${id}`,
    media_type: "movie",
    title: id,
    poster_url: `/posters/${id}.jpg`,
    provider_items: {},
  };
}

function installEmptyProviderFetch(t) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ url: new URL(String(input)), method: String(options.method || "GET").toUpperCase() });
    if (options.method && options.method !== "GET") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.error = () => {};
  console.log = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  });
  return calls;
}

// pushCurrentUpNextQueue takes no queue argument: whatever the browser last
// showed is irrelevant, the server snapshot at push time is what is pushed.
test("the manual push sends the current server snapshot, not a queue the caller held earlier", async (t) => {
  installEmptyProviderFetch(t);
  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
  });
  const { loadMediaConfig } = await import("../server/src/utils/configStore.js");
  const { pushCurrentUpNextQueue } = await import("../server/src/utils/upNextAutoSync.js");
  const config = await loadMediaConfig();
  assert.equal(pushCurrentUpNextQueue.length, 1, "only the config is a required argument; no queue can be supplied");

  writeCurrentCache([queueItem("older-browser-view")]);
  const first = await pushCurrentUpNextQueue(config);
  assert.deepEqual(first.items.map((item) => item.id), ["movie:older-browser-view"]);
  assert.equal(first.summary.desired_count, 1);

  // The server queue changes after the "browser" loaded the first one.
  writeCurrentCache([queueItem("newer-server-one"), queueItem("newer-server-two")]);
  // An extra argument shaped like a stale queue must be ignored.
  const second = await pushCurrentUpNextQueue(config, { items: [queueItem("older-browser-view")] });
  assert.deepEqual(second.items.map((item) => item.id), ["movie:newer-server-one", "movie:newer-server-two"]);
  assert.equal(second.summary.desired_count, 2);
});

test("duplicate automatic Up Next requests queue one job and the repeat run does not push again", async (t) => {
  const calls = installEmptyProviderFetch(t);
  await saveMediaConfig({
    emby: { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" },
  });
  const { db } = await import("../server/src/db.js");
  const { setRuntimeState } = await import("../server/src/utils/configStore.js");
  const { requestUpNextAutoSync } = await import("../server/src/utils/upNextAutoSync.js");
  db.prepare("DELETE FROM background_job_logs").run();
  db.prepare("DELETE FROM background_jobs").run();

  const requests = await Promise.all([
    requestUpNextAutoSync("duplicate one"),
    requestUpNextAutoSync("duplicate two"),
  ]);
  assert.equal(requests.filter((request) => request.queued).length, 1);
  assert.equal(requests.filter((request) => request.coalesced).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE type='up_next_sync'").get().count, 1);

  await setRuntimeState({ upNextAutoSyncFingerprint: null, upNextAutoSyncRetry: null });
  writeCurrentCache([queueItem("dedupe-one")]);
  const first = await runAutomaticUpNextSync();
  assert.ok(["succeeded", "partial"].includes(first.status), first.status);
  const callsAfterFirst = calls.length;
  assert.ok(callsAfterFirst > 0, "the first run reached the provider");

  // The second job for the same queue is recognised as unchanged and never contacts the provider.
  writeCurrentCache([queueItem("dedupe-one")]);
  const second = await runAutomaticUpNextSync();
  assert.equal(second.status, "unchanged");
  assert.equal(calls.length, callsAfterFirst);
});
