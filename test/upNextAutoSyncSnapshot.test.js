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
    version: 6,
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
