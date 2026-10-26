import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithUserContext } from "../server/src/utils/userContext.js";
import { closeAllTenantDatabases } from "../server/src/utils/tenantDatabase.js";
import { mergeNextAiringCacheEntries, readNextAiringCache } from "../server/src/utils/nextAiringCache.js";
import { getUpNextCacheSnapshot } from "../server/src/utils/upNextCache.js";
import { getUpcomingCalendarMonth } from "../server/src/utils/upcomingCalendarCache.js";
import { getCachedShowProgress, initShowProgressCache } from "../server/src/utils/showProgressCache.js";

test("file-backed caches and their memory state stay isolated by active tenant", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-tenant-caches-"));
  const aliceDir = path.join(root, "users", "alice");
  const bobDir = path.join(root, "users", "bob");
  fs.mkdirSync(aliceDir, { recursive: true });
  fs.mkdirSync(bobDir, { recursive: true });
  const forUser = (name, dataDir, fn) => runWithUserContext({ name, dataDir, role: "user" }, fn);

  try {
    await forUser("alice", aliceDir, () => mergeNextAiringCacheEntries([
      { key: "tv_123", title: "Alice Only Show", tmdbId: "123", nextAiringDate: "2026-11-01" },
    ]));
    const aliceAiring = await forUser("alice", aliceDir, () => readNextAiringCache());
    const bobAiring = await forUser("bob", bobDir, () => readNextAiringCache());
    assert.ok(aliceAiring.entries.tv_123);
    assert.equal(bobAiring.entries.tv_123, undefined);

    const buildQueue = (title) => async () => ({ items: [{ media_type: "movie", title }], sourceStatus: [] });
    const aliceQueue = await forUser("alice", aliceDir, () => getUpNextCacheSnapshot(buildQueue("Alice Queue"), { refresh: true }));
    const bobQueue = await forUser("bob", bobDir, () => getUpNextCacheSnapshot(buildQueue("Bob Queue"), { refresh: true }));
    assert.deepEqual(aliceQueue.items.map((item) => item.title), ["Alice Queue"]);
    assert.deepEqual(bobQueue.items.map((item) => item.title), ["Bob Queue"]);

    fs.writeFileSync(path.join(aliceDir, "tv_progress_cache.json"), JSON.stringify({
      aliceonlyshow: {
        title: "Alice Only Show",
        tmdb_id: "123",
        episode_count: 1,
        total_episodes: 10,
        total_checked_at: Date.now(),
        schema_version: 3,
      },
    }));
    await forUser("alice", aliceDir, () => initShowProgressCache());
    assert.equal(forUser("alice", aliceDir, () => getCachedShowProgress("aliceonlyshow"))?.title, "Alice Only Show");
    fs.writeFileSync(path.join(bobDir, "tv_progress_cache.json"), JSON.stringify({
      bobonlyshow: {
        title: "Bob Only Show",
        tmdb_id: "456",
        episode_count: 2,
        total_episodes: 12,
        total_checked_at: Date.now(),
        schema_version: 3,
      },
    }));
    assert.equal(forUser("bob", bobDir, () => getCachedShowProgress("bobonlyshow")), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forUser("bob", bobDir, () => getCachedShowProgress("bobonlyshow"))?.title, "Bob Only Show");
    assert.equal(forUser("bob", bobDir, () => getCachedShowProgress("aliceonlyshow")), null);

    const month = "2026-10";
    const alicePayload = {
      month,
      start: "2026-10-01",
      end: "2026-10-31",
      episodes: [{ showTitle: "Alice Calendar Show", airDate: "2026-10-20", season: 1, episode: 1 }],
    };
    fs.writeFileSync(path.join(aliceDir, "upcoming-calendar-cache.json"), JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      months: { [month]: { builtAt: Date.now(), showKeys: [], payload: alicePayload } },
    }));
    const aliceCalendar = await forUser("alice", aliceDir, () => getUpcomingCalendarMonth(month));
    const bobCalendar = await forUser("bob", bobDir, () => getUpcomingCalendarMonth(month));
    assert.deepEqual(aliceCalendar.episodes.map((episode) => episode.showTitle), ["Alice Calendar Show"]);
    assert.deepEqual(bobCalendar.episodes, []);
  } finally {
    closeAllTenantDatabases();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
