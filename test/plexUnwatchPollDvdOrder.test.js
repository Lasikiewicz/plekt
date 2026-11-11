import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// Issue #55 live test, 11 November 2026: a DVD-order watch of Futurama (stored as aired
// S02E05, Plex item 6497 = DVD S02E01) was unwatched about three minutes later by the
// per-minute Plex fallback poll. It rebuilt the media from the stored row and looked the
// Plex item up by the stored aired numbers, which in Plex's DVD numbering is a different,
// unplayed episode (6501), so Emby and Jellyfin received an unwatch for a real watch.

makeTempDataDir("plekt-plex-unwatch-poll-dvd-");
const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");
const { checkPlexUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");
const { plexUnwatchCheckTarget } = await import("../server/src/utils/episodeOrderWatch.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const config = {
  plex: { baseUrl: "https://plex.example.test", token: "test-token", disabled: false },
  emby: { disabled: true },
  jellyfin: { disabled: true },
};

const identity = { tvdbId: "73871", dvdId: 131187, airedId: 131187, order: "dvd" };
const episode = {
  title: "Futurama - S02E05", media_type: "episode", show_title: "Futurama",
  season: 2, episode: 5, tmdb_id: "615", tvdb_id: "73871",
};
const playstateMedia = { title: episode.title, type: "episode", season: 2, episode: 5, ids: { tmdb: "615", tvdb: "73871" } };

// Plex in DVD numbering: the item that was watched (6497, shown as 2/1) and the
// unwatched item that sits at the aired coordinate 2/5 (6501).
const WATCHED_ITEM = { ratingKey: "6497", key: "/library/metadata/6497", type: "episode", title: "Space Pilot 3000", grandparentTitle: "Futurama", parentIndex: 2, index: 1, viewCount: 1, viewOffset: 0 };
const OTHER_ITEM = { ratingKey: "6501", key: "/library/metadata/6501", type: "episode", title: "Why Must I Be a Crustacean in Love?", grandparentTitle: "Futurama", parentIndex: 2, index: 5, viewCount: 0, viewOffset: 0 };

let requested = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  requested.push(url);
  const item = /\/library\/metadata\/6497(?:\?|\/|$)/.test(url) ? WATCHED_ITEM : OTHER_ITEM;
  return new Response(JSON.stringify({ MediaContainer: { Metadata: [item], size: 1 } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
const realLog = console.log;
let logged = [];
console.log = (...args) => { logged.push(args.map(String).join(" ")); realLog(...args); };
test.after(() => { globalThis.fetch = realFetch; console.log = realLog; });
const unwatchAttempted = () => logged.some((line) => line.includes("marked unwatched; storing and propagating"));

async function resetDb() {
  requested = [];
  logged = [];
  for (const table of ["watch_history", "playback_progress", "playstate", "loop_keys"]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table may not exist in this build */ }
  }
}

// The insert guard refuses an alternate-order row without a cached TVDB catalogue, so
// store the row plainly and then write the provenance a verified watch would carry.
async function insertStoredWatch({ source, provenance, telemetry }) {
  const { id } = await repo.insertWatchRecord({
    ...episode, source, sync_action: "watched", watched_at: "2026-11-11T12:00:00.000Z",
    ...(telemetry ? { sync_dispatch_telemetry: telemetry } : {}),
  });
  db.prepare("UPDATE watch_history SET watch_provenance=? WHERE id=?").run(JSON.stringify({ version: 1, ...provenance }), id);
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched", "setup: Plekt holds the watch");
  return id;
}

test("the fallback poll checks the stored Plex item, not the Plex item at the aired coordinate", async () => {
  await resetDb();
  await insertStoredWatch({ source: "plex", provenance: { source: "plex", item_id: "6497", episode_order: identity } });

  await checkPlexUnwatchedStatus(config, createLoopStore());

  assert.equal(unwatchAttempted(), false, "no unwatch may be inferred from the Plex item at the aired numbers");
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched",
    "the watched DVD-order episode must not be unwatched because a different Plex item sits at its aired numbers");
  assert.ok(requested.some((url) => url.includes("/library/metadata/6497")), "the stored Plex item was fetched");
});

test("the fallback poll does not infer an unwatch from a coordinate lookup for an alternate-order row without a Plex item id", async () => {
  await resetDb();
  await insertStoredWatch({
    source: "emby",
    provenance: { source: "emby", item_id: "47582", episode_order: identity },
    telemetry: "Origin: emby\nTarget plex status: success - 200 OK",
  });

  await checkPlexUnwatchedStatus(config, createLoopStore());

  assert.equal(unwatchAttempted(), false, "no unwatch may be inferred from a coordinate lookup");
  assert.equal(await repo.getCanonicalWatchState(playstateMedia), "watched",
    "an alternate-order Emby watch with no stored Plex item must survive an unplayed Plex item at the same numbers");
});

test("an aired-order row without a Plex item id is still checked by coordinates", async () => {
  await resetDb();
  await insertStoredWatch({ source: "emby", provenance: { source: "emby", item_id: "47582" }, telemetry: "Origin: emby\nTarget plex status: success - 200 OK" });

  await checkPlexUnwatchedStatus(config, createLoopStore());

  assert.equal(unwatchAttempted(), true, "the coordinate lookup still runs for an aired-order row");
  assert.notEqual(await repo.getCanonicalWatchState(playstateMedia), "watched",
    "aired-order behaviour is unchanged: the unplayed Plex item at the stored numbers still unwatches the row");
});

test("plexUnwatchCheckTarget picks the stored Plex item, skips alternate-order rows without one, and leaves the rest", () => {
  assert.deepEqual(plexUnwatchCheckTarget({ media_type: "episode", watch_provenance: { source: "plex", item_id: 6497, episode_order: identity } }), { itemId: "6497" });
  assert.deepEqual(plexUnwatchCheckTarget({ media_type: "episode", watch_provenance: { source: "emby", item_id: "47582", episode_order: identity } }), { skip: true });
  assert.deepEqual(plexUnwatchCheckTarget({ media_type: "episode", watch_provenance: { source: "emby", item_id: "47582" } }), { skip: false });
  assert.deepEqual(plexUnwatchCheckTarget({ media_type: "movie", watch_provenance: { source: "plex" } }), { skip: false });
  assert.deepEqual(plexUnwatchCheckTarget({ media_type: "episode", watch_provenance: JSON.stringify({ source: "plex", item_id: "9" }) }), { itemId: "9" });
});
