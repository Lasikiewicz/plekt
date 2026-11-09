import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-resume-unwatch-");
const { db } = await import("../server/src/db.js");
const { checkPlexUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");
const { upsertPlaybackProgress, getPlaybackProgressForMedia, getPlaystateForMedia } = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
test.after(() => db.close());

test("Plex fallback detects a cleared progress-only item without any notification or review", async (t) => {
  const cases = [
    ["clear", "plex", {}, true],
    ["pushed", "emby", {}, true],
    ["other", "emby", {}, false],
    ["resumed", "plex", { viewOffset: 2393811 }, false],
    ["watched", "plex", { viewCount: 1 }, false],
    ["missing", "plex", null, false],
    ["newer", "plex", {}, false],
  ];
  const records = new Map();
  for (const [id, source] of cases) {
    records.set(id, await upsertPlaybackProgress({
      title: `Resume ${id}`, media_type: "movie", source, imdb_id: `tt-${id}`,
      position_ms: 2393811, duration_ms: 8928800, updated_at: Date.now() - 600000,
      sync_dispatch_telemetry: id === "pushed" ? "Target plex progress status: success" : "",
    }));
  }
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const id = url.pathname === "/library/all"
      ? url.searchParams.get("guid").split("tt-").at(-1)
      : url.pathname.split("/").at(-1);
    requested.push(id);
    if (id === "newer" && url.pathname.startsWith("/library/metadata/")) {
      await upsertPlaybackProgress({ ...records.get(id), position_ms: 2500000, updated_at: Date.now() });
    }
    const state = cases.find((entry) => entry[0] === id)?.[2];
    return Response.json({ MediaContainer: { Metadata: state === null ? [] : [{ ratingKey: id, type: "movie", ...state }] } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await checkPlexUnwatchedStatus({ plex: { baseUrl: "https://plex.example.test", token: "test" } }, createLoopStore());
  for (const [id, , , cleared] of cases) {
    assert.equal(Boolean(await getPlaybackProgressForMedia(records.get(id))), !cleared, id);
    const media = { title: `Resume ${id}`, type: "movie", ids: { imdb: `tt-${id}` } };
    assert.equal((await getPlaystateForMedia(media))?.state || null, cleared ? "unwatched" : null, id);
  }
  assert.equal(requested.includes("other"), false, "Plex must have held the position");
});
