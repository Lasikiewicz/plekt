import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// Issue #55 live test, 11 November 2026: after the Plex poll was fixed, the Emby poll
// unwatched three DVD-order Futurama watches about 14 minutes after they were stored.
// It looked the Emby item up by the row's aired season and episode, which Emby numbers
// differently, found an unplayed episode there, and sent an unwatch for a real watch.
// The Jellyfin poll builds its lookup the same way.

makeTempDataDir("plekt-emby-jellyfin-unwatch-poll-dvd-");
const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");
const { checkEmbyUnwatchedStatus, checkJellyfinUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");
const { isAlternateOrderEpisodeRow } = await import("../server/src/utils/episodeOrderWatch.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const config = {
  plex: { disabled: true },
  emby: { baseUrl: "https://emby.example.test", apiKey: "k", userId: "u", disabled: false },
  jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "k", userId: "u", disabled: false },
};
const identity = { tvdbId: "73871", dvdId: 131187, airedId: 131187, order: "dvd" };
const episode = { title: "Futurama - S02E05", media_type: "episode", show_title: "Futurama", season: 2, episode: 5, tmdb_id: "615", tvdb_id: "73871" };
const playstateMedia = { title: episode.title, type: "episode", season: 2, episode: 5, ids: { tmdb: "615", tvdb: "73871" } };

let requested = [];
const realFetch = globalThis.fetch;
// Every Emby or Jellyfin lookup returns an unplayed episode: the one at the aired numbers.
globalThis.fetch = async (input) => {
  requested.push(String(input?.url || input));
  return new Response(JSON.stringify({ Items: [{ Id: "5", Name: "Other", Type: "Episode", ParentIndexNumber: 2, IndexNumber: 5, UserData: { Played: false } }], TotalRecordCount: 1 }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
test.after(() => { globalThis.fetch = realFetch; });

async function insertStoredWatch(provenance, telemetry) {
  for (const table of ["watch_history", "playback_progress", "playstate", "loop_keys"]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table may not exist */ }
  }
  const { id } = await repo.insertWatchRecord({ ...episode, source: "plex", sync_action: "watched", watched_at: "2026-11-11T12:00:00.000Z", sync_dispatch_telemetry: telemetry });
  db.prepare("UPDATE watch_history SET watch_provenance=? WHERE id=?").run(JSON.stringify({ version: 1, ...provenance }), id);
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched", "setup: Plekt holds the watch");
  requested = []; // storing the row may itself talk to the providers; count only the poll
}

test("the Emby poll does not look up an alternate-order row by its aired numbers", async () => {
  await insertStoredWatch({ source: "plex", item_id: "6497", episode_order: identity }, "Origin: plex\nTarget emby status: success - 200 OK");
  await checkEmbyUnwatchedStatus(config, createLoopStore());
  assert.equal(requested.length, 0, "no Emby lookup may be made for an alternate-order row");
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched");
});

test("the Jellyfin poll does not look up an alternate-order row by its aired numbers", async () => {
  await insertStoredWatch({ source: "plex", item_id: "6497", episode_order: identity }, "Origin: plex\nTarget jellyfin status: success - 200 OK");
  await checkJellyfinUnwatchedStatus(config, createLoopStore());
  await checkJellyfinUnwatchedStatus(config, createLoopStore());
  assert.equal(requested.length, 0, "no Jellyfin lookup may be made for an alternate-order row");
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched");
});

test("aired-order rows are still checked by the Emby and Jellyfin polls", async () => {
  await insertStoredWatch({ source: "plex", item_id: "6497" }, "Origin: plex\nTarget emby status: success - 200 OK\nTarget jellyfin status: success - 200 OK");
  await checkEmbyUnwatchedStatus(config, createLoopStore());
  assert.ok(requested.some((url) => url.includes("emby.example.test")), "the Emby lookup still runs for an aired-order row");
  await checkJellyfinUnwatchedStatus(config, createLoopStore());
  assert.ok(requested.some((url) => url.includes("jellyfin.example.test")), "the Jellyfin lookup still runs for an aired-order row");
});

test("isAlternateOrderEpisodeRow only matches episodes that carry an episode order", () => {
  assert.equal(isAlternateOrderEpisodeRow({ media_type: "episode", watch_provenance: { episode_order: identity } }), true);
  assert.equal(isAlternateOrderEpisodeRow({ media_type: "episode", watch_provenance: JSON.stringify({ episode_order: identity }) }), true);
  assert.equal(isAlternateOrderEpisodeRow({ media_type: "episode", watch_provenance: { source: "plex" } }), false);
  assert.equal(isAlternateOrderEpisodeRow({ media_type: "movie", watch_provenance: { episode_order: identity } }), false);
});
