import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plembfin-up-next-cache-");
const { bumpDataVersion, bumpUpNextVersion, getDataVersion, getUpNextVersion } = await import("../server/src/db.js");
const { getUpNextCacheSnapshot } = await import("../server/src/utils/upNextCache.js");

test("Up Next rebuilds synchronously when watch history changes", async () => {
  let buildCount = 0;
  const initial = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-a", title: "Alpha" }];
  }, { refresh: true });

  assert.deepEqual(initial.items.map((item) => item.id), ["episode-a"]);
  assert.equal(initial.stale, false);
  assert.ok(initial.builtAt > 0);
  const initialVersion = getUpNextVersion();
  const cacheFile = path.join(dataDir, "up-next-cache.json");
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")).items.map((item) => item.id), ["episode-a"]);

  bumpDataVersion();
  const refreshed = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-b", title: "Beta" }];
  }, { revalidate: true });

  assert.deepEqual(refreshed.items.map((item) => item.id), ["episode-b"]);
  assert.equal(refreshed.stale, false);
  assert.equal(buildCount, 2);
  assert.ok(refreshed.upNextVersion > initialVersion);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")).items.map((item) => item.id), ["episode-b"]);
});

test("Up Next can serve a stale projection while the dashboard rebuilds it", async () => {
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-stale", title: "Stale" }];
  }, { refresh: true });

  bumpDataVersion();
  let resolveBuild;
  const rebuilding = new Promise((resolve) => { resolveBuild = resolve; });
  const snapshot = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    await rebuilding;
    return [{ id: "episode-fresh", title: "Fresh" }];
  }, { revalidate: true, allowStale: true });

  assert.deepEqual(snapshot.items.map((item) => item.id), ["episode-stale"]);
  assert.equal(snapshot.stale, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(buildCount, 2);
  resolveBuild();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a stale first paint after a history change always queues a rebuild, even inside the throttle window", async () => {
  // The previous test already used the provider-feed revalidate slot. Before
  // the fix a second history-stale first paint inside that ten-minute window
  // queued nothing, so an episode watched elsewhere stayed in the rail.
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => [{ id: "episode-watched-elsewhere", title: "Watched" }], { refresh: true });

  bumpDataVersion();
  const snapshot = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-after-watch", title: "After" }];
  }, { revalidate: true, allowStale: true });
  assert.equal(snapshot.stale, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(buildCount, 1, "the history-stale snapshot must be followed by a rebuild");

  // The background rebuild intentionally starts on a later timer turn. Wait
  // for its persisted result instead of assuming a fixed 20 ms is enough on a
  // busy Windows test runner.
  const cacheFile = path.join(dataDir, "up-next-cache.json");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (persisted.items?.[0]?.id === "episode-after-watch") break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const followUp = await getUpNextCacheSnapshot(async () => [{ id: "unused", title: "Unused" }], { revalidate: true });
  assert.deepEqual(followUp.items.map((item) => item.id), ["episode-after-watch"]);
  assert.equal(followUp.stale, false);
});

test("Up Next rebuilds synchronously when the queue generation changes", async () => {
  let buildCount = 0;
  await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-c", title: "Gamma" }];
  }, { refresh: true });

  bumpUpNextVersion();
  const refreshed = await getUpNextCacheSnapshot(async () => {
    buildCount += 1;
    return [{ id: "episode-d", title: "Delta" }];
  }, { revalidate: true });

  assert.deepEqual(refreshed.items.map((item) => item.id), ["episode-d"]);
  assert.equal(refreshed.stale, false);
  assert.equal(buildCount, 2);
});

// Writes a snapshot file as another process (or an older build) would, current
// against both versions so a read serves it instead of rebuilding.
async function writeCacheFile(items) {
  const cacheFile = path.join(dataDir, "up-next-cache.json");
  const current = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  await fs.writeFile(cacheFile, JSON.stringify({
    ...current,
    builtAt: Date.now(),
    historyVersion: getDataVersion(),
    upNextVersion: getUpNextVersion(),
    items,
  }), "utf8");
}

test("reading a legacy cache snapshot collapses identity and title-only episode duplicates", async () => {
  await getUpNextCacheSnapshot(async () => [], { refresh: true });
  await writeCacheFile([
    {
      id: "episode|series:tmdb:6278773|s:1|e:5",
      media_type: "episode",
      title: "Example Show - S01E05",
      show_title: "Example Show",
      show_tmdb_id: "6278773",
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 100,
      duration_ms: 1000,
      progress: 10,
    },
    {
      id: "episode|title:example-show|s:1|e:5",
      media_type: "episode",
      title: "Example Show - S01E05",
      show_title: "Example Show",
      season: 1,
      episode: 5,
      queue_kind: "resume",
      position_ms: 90,
      duration_ms: 1000,
      progress: 9,
    },
  ]);

  const snapshot = await getUpNextCacheSnapshot(async () => [], { revalidate: true });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].show_tmdb_id, "6278773");
});

const partWatchedMovie = {
  id: "movie|id:imdb:tt27165187",
  media_type: "movie",
  title: "The End of Oak Street",
  imdb_id: "tt27165187",
  queue_kind: "resume",
  playback_position_known: true,
  position_ms: 742052,
  duration_ms: 5984672,
  progress: 12.4,
  updated_at: Date.parse("2026-09-24T08:35:49Z"),
};
const nextEpisode = {
  id: "episode|series:tmdb:7700002|s:1|e:4",
  media_type: "episode",
  title: "Example Show - S01E04",
  show_title: "Example Show",
  show_tmdb_id: "7700002",
  season: 1,
  episode: 4,
  queue_kind: "next_up",
  playback_position_known: false,
  show_latest_watched_at: "2026-09-24T08:28:30Z",
  updated_at: Date.parse("2026-09-24T08:51:36Z"),
};

// Regression (24 Sep 2026): a reloaded snapshot listed every episode before
// every movie, so a part-watched movie dropped to the end of the rail.
test("a part-watched movie keeps its place ahead of episodes when the snapshot is reloaded", async () => {
  await getUpNextCacheSnapshot(async () => [partWatchedMovie, nextEpisode], { refresh: true });
  await writeCacheFile([partWatchedMovie, nextEpisode]);

  const snapshot = await getUpNextCacheSnapshot(async () => [], { revalidate: true });
  assert.deepEqual(snapshot.items.map((item) => item.media_type), ["movie", "episode"]);
});

// Regression (24 Sep 2026): the process re-read its own write through the
// legacy normalizer, so an unchanged rebuild never compared equal and bumped
// the Up Next version (and queued an automatic sync) every time.
test("an unchanged rebuild does not advance the Up Next version", async () => {
  const build = async () => [partWatchedMovie, nextEpisode];
  const first = await getUpNextCacheSnapshot(build, { refresh: true });
  const second = await getUpNextCacheSnapshot(build, { refresh: true });
  assert.equal(second.upNextVersion, first.upNextVersion);
  assert.equal(getUpNextVersion(), first.upNextVersion);
  assert.deepEqual(second.items.map((item) => item.media_type), ["movie", "episode"]);
});

// A drop bumps the Up Next version while a background build is running. That
// older projection must not be stamped as current, or it is served with the
// dropped show until the next rebuild.
test("a projection built before a queue change is not served as current", async () => {
  await getUpNextCacheSnapshot(async () => [{ id: "episode-old", title: "Old" }], { refresh: true });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const before = getUpNextCacheSnapshot(async () => {
    await gate;
    return [{ id: "episode-dropped", title: "Dropped" }];
  }, { refresh: true });
  bumpUpNextVersion();
  release();
  await before;

  let fresh = 0;
  const after = await getUpNextCacheSnapshot(async () => {
    fresh += 1;
    return [{ id: "episode-kept", title: "Kept" }];
  }, { revalidate: true });
  assert.equal(fresh, 1);
  assert.deepEqual(after.items.map((item) => item.id), ["episode-kept"]);
});
