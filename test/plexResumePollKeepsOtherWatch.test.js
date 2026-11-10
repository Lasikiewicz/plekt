import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// Step 3 of the 10 November 2026 audit: the Plex resume poll forced an unwatch
// when Plex held a resume position and now shows no view, without checking that
// Plekt still holds a watch for the item (for example one recorded through Emby),
// or that the Plex item it found is the episode the progress row describes.

makeTempDataDir("plekt-plex-resume-poll-");
const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");
const { checkPlexUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const config = {
  plex: { baseUrl: "https://plex.example.test", token: "test-token", disabled: false },
  emby: { disabled: true },
  jellyfin: { disabled: true },
};
const episodeMedia = (episode, tmdb) => ({
  title: `Resume Poll Show - S01E0${episode}`, media_type: "episode", show_title: "Resume Poll Show",
  season: 1, episode, tmdb_id: tmdb,
});
const media = episodeMedia(1, "resume-poll-1");
const playstateMedia = { title: media.title, type: "episode", season: 1, episode: 1, ids: { tmdb: media.tmdb_id } };
const plexItemFor = (episode) => ({
  ratingKey: `50${episode}`, key: `/library/metadata/50${episode}`, type: "episode",
  title: "Resume Poll Episode", grandparentTitle: "Resume Poll Show",
  parentIndex: 1, index: episode, viewCount: 0, viewOffset: 0,
  Guid: [{ id: "tmdb://resume-poll-1" }],
});

// What Plex answers for every request: an unplayed episode with no view and no offset.
let plexEpisode = plexItemFor(1);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ MediaContainer: { Metadata: [plexEpisode], size: 1 } }), {
  status: 200, headers: { "content-type": "application/json" },
});

const watchRowCount = () => db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n;
test.after(() => { globalThis.fetch = realFetch; });

async function resetDb() {
  for (const table of ["watch_history", "playback_progress", "playstate", "loop_keys"]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table may not exist in this build */ }
  }
}

test("a resume position Plex held does not unwatch an episode Plekt holds as watched from another source", async () => {
  await resetDb();
  plexEpisode = plexItemFor(1);
  await repo.insertWatchRecord({ ...media, source: "emby", sync_action: "watched", watched_at: "2026-10-01T00:00:00.000Z" });
  await repo.upsertPlaybackProgress({ ...media, source: "plex", position_ms: 600_000, duration_ms: 1_800_000 });
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched", "setup: Plekt holds a watch");

  await checkPlexUnwatchedStatus(config, createLoopStore());

  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched",
    "the Emby watch must survive a stale Plex resume position");
});

test("a Plex item for a different episode does not clear the progress row's episode", async () => {
  await resetDb();
  plexEpisode = plexItemFor(2);
  await repo.insertWatchRecord({ ...media, source: "emby", sync_action: "watched", watched_at: "2026-10-01T00:00:00.000Z" });
  await repo.upsertPlaybackProgress({ ...media, source: "plex", position_ms: 600_000, duration_ms: 1_800_000 });

  await checkPlexUnwatchedStatus(config, createLoopStore());

  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched", "episode 2's Plex item must not clear episode 1");
});
