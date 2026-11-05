import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The history-derived caches in dataRepo.js used to be module-level slots keyed
// only by the data version. Each tenant has its own version counter, so the
// admin and an added user could sit at the same number and read each other's
// cached rows (reproduced by the 5 November 2026 app audit).

const root = makeTempDataDir("plekt-per-user-caches-");
const aliceDir = path.join(root, "users", "alice");
fs.mkdirSync(aliceDir, { recursive: true });

const repo = await import("../server/src/utils/dataRepo.js");
const { bumpDataVersion, getDataVersion } = await import("../server/src/db.js");
const { runAsAdmin, runWithUserContext } = await import("../server/src/utils/userContext.js");
const cacheTelemetry = await import("../server/src/utils/cacheTelemetry.js");

const asAlice = (fn) => runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, fn);

async function insert(record) {
  const result = await repo.insertWatchRecord(record);
  await result.assetPrefetch;
}

const movie = (title, imdb) => ({
  title,
  media_type: "movie",
  watched_at: "2026-01-01T12:00:00.000Z",
  source: "plex",
  imdb_id: imdb,
});
const episode = (show, tvdb) => ({
  title: `${show} - S01E01 - Pilot`,
  media_type: "episode",
  watched_at: "2026-01-02T12:00:00.000Z",
  source: "emby",
  tvdb_id: tvdb,
  season: 1,
  episode: 1,
});

await runAsAdmin(() => insert(movie("ADMIN", "tt-admin")));
await asAlice(() => insert(movie("ALICE", "tt-alice")));
await runAsAdmin(() => insert(episode("Admin Show", "admin-show")));
await asAlice(() => insert(episode("Alice Show", "alice-show")));
// Line both version counters up, as the audit found them.
for (let guard = 0; guard < 50; guard += 1) {
  const adminVersion = await runAsAdmin(() => getDataVersion());
  const aliceVersion = await asAlice(() => getDataVersion());
  if (adminVersion === aliceVersion) break;
  await (adminVersion < aliceVersion ? runAsAdmin : asAlice)(() => bumpDataVersion());
}

// Every title starts with its owner, so the first word names whose row it is.
const titles = (rows) => rows.map((row) => String(row.title).split(" ")[0].toLowerCase()).sort();

test("admin and tenant at the same data version see only their own cached rows", async () => {
  const adminVersion = await runAsAdmin(() => getDataVersion());
  const aliceVersion = await asAlice(() => getDataVersion());
  assert.equal(adminVersion, aliceVersion, "the reproduction needs both users at the same version");

  const adminHistory = await runAsAdmin(() => repo.getCachedHistory());
  const aliceHistory = await asAlice(() => repo.getCachedHistory());
  assert.deepEqual(titles(adminHistory), ["admin", "admin"]);
  assert.deepEqual(titles(aliceHistory), ["alice", "alice"]);

  const adminMovies = await runAsAdmin(() => repo.getCachedMovies());
  const aliceMovies = await asAlice(() => repo.getCachedMovies());
  assert.deepEqual(titles(adminMovies), ["admin"]);
  assert.deepEqual(titles(aliceMovies), ["alice"]);

  const adminShows = await runAsAdmin(() => repo.getCachedShows());
  const aliceShows = await asAlice(() => repo.getCachedShows());
  assert.deepEqual(titles(adminShows), ["admin"]);
  assert.deepEqual(titles(aliceShows), ["alice"]);

  const adminStats = await runAsAdmin(() => repo.getWatchStats());
  const aliceStats = await asAlice(() => repo.getWatchStats());
  assert.notStrictEqual(adminStats, aliceStats, "stats must not be one shared object");
  assert.ok(!JSON.stringify(aliceStats).includes("ADMIN"), "alice's stats must not mention the admin's movie");
  assert.ok(!JSON.stringify(adminStats).includes("ALICE"), "the admin's stats must not mention alice's movie");

  const adminPreview = await runAsAdmin(() => repo.queryWatchHistoryPreview({ limit: 10 }));
  const alicePreview = await asAlice(() => repo.queryWatchHistoryPreview({ limit: 10 }));
  assert.ok(!JSON.stringify(alicePreview).includes("ADMIN"), "alice's preview must not show the admin's rows");
  assert.ok(!JSON.stringify(adminPreview).includes("ALICE"), "the admin's preview must not show alice's rows");
});

test("alternating admin and tenant reads do not rebuild each other's caches", async () => {
  const readAll = async () => {
    for (const run of [runAsAdmin, asAlice]) {
      await run(() => repo.getCachedHistory());
      await run(() => repo.getCachedMovies());
      await run(() => repo.getCachedShows());
      await run(() => repo.getWatchStats());
    }
  };
  await readAll();
  const before = cacheTelemetry.cacheRebuildTelemetry().totalRebuilds;
  const adminRows = await runAsAdmin(() => repo.getCachedHistory());
  for (let i = 0; i < 4; i += 1) await readAll();
  assert.equal(cacheTelemetry.cacheRebuildTelemetry().totalRebuilds, before, "no cache may rebuild while nothing changed");
  assert.strictEqual(await runAsAdmin(() => repo.getCachedHistory()), adminRows);
});

test("per-user state with a cap drops the least recently used folder first", async () => {
  const { createPerUserState } = await import("../server/src/utils/perUserState.js");
  let built = 0;
  const stateFor = createPerUserState(() => ({ id: ++built }), { maxEntries: 2 });
  const inDir = (name) => (fn) => runWithUserContext({ name, dataDir: path.join(root, "cap", name), role: "user" }, fn);
  const [a, b, c] = ["a", "b", "c"].map(inDir);
  const first = a(stateFor);
  b(stateFor);
  assert.strictEqual(a(stateFor), first, "a re-read keeps its state and becomes most recent");
  c(stateFor); // evicts b, the least recently used
  assert.strictEqual(a(stateFor), first);
  const before = built;
  b(stateFor);
  assert.equal(built, before + 1, "b was evicted and is rebuilt");
});
