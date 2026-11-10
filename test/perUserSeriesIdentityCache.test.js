import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The show identity index was one module-level object with a 60 second life.
// Whichever user built it first served its series ids to every other user
// (reproduced by the 10 November 2026 app audit, step 2).

const root = makeTempDataDir("plekt-series-identity-cache-");
const aliceDir = path.join(root, "users", "alice");
fs.mkdirSync(aliceDir, { recursive: true });

const repo = await import("../server/src/utils/dataRepo.js");
const { runAsAdmin, runWithUserContext } = await import("../server/src/utils/userContext.js");
const asAlice = (fn) => runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, fn);

// An id counts as proven for a show only when two episodes carry it, so each
// user gets two episodes with the same tvdb id.
const episode = (tvdb, number) => ({
  title: `Shared Show - S01E0${number} - Pilot`,
  media_type: "episode",
  watched_at: `2026-01-0${number}T12:00:00.000Z`,
  source: "emby",
  tvdb_id: tvdb,
  season: 1,
  episode: number,
});
for (const number of [1, 2]) {
  await runAsAdmin(() => repo.insertWatchRecord(episode("admin-tvdb", number)).then((r) => r.assetPrefetch));
  await asAlice(() => repo.insertWatchRecord(episode("alice-tvdb", number)).then((r) => r.assetPrefetch));
}

const tvdbIds = (profiles) => profiles.map((profile) => profile.ids.tvdb).sort();

test("the series identity index is built per user and does not leak across users", async () => {
  const adminProfiles = await runAsAdmin(() => repo.seriesIdentityProfilesForShowTitle("Shared Show"));
  const aliceProfiles = await asAlice(() => repo.seriesIdentityProfilesForShowTitle("Shared Show"));
  assert.deepEqual(tvdbIds(adminProfiles), ["admin-tvdb"]);
  assert.deepEqual(tvdbIds(aliceProfiles), ["alice-tvdb"]);
});

test("invalidating one user's identity index leaves another user's entry alone", async () => {
  await runAsAdmin(() => repo.seriesIdentityProfilesForShowTitle("Shared Show"));
  await asAlice(() => repo.seriesIdentityProfilesForShowTitle("Shared Show"));
  await asAlice(() => repo.invalidateSeriesIdentityIndex());
  const adminProfiles = await runAsAdmin(() => repo.seriesIdentityProfilesForShowTitle("Shared Show"));
  assert.deepEqual(tvdbIds(adminProfiles), ["admin-tvdb"]);
});
