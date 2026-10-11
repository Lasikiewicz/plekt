import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-active-sessions-");
const { db } = await import("../server/src/db.js");
const { UP_NEXT_SEED_DEVICE_ID } = await import("../server/src/utils/embyClient.js");
const { deleteActiveSession, listActiveSessions, upsertActiveSession } = await import("../server/src/utils/activeSessions.js");

test("finished episodes are deleted when start and stop provider ids differ", async () => {
  await upsertActiveSession({
    source: "jellyfin",
    type: "episode",
    title: "Scrubs - S01E03",
    season: 1,
    episode: 3,
    ids: { tmdb: "184604" },
    progress: 98,
    offsetMs: 1_000,
    durationMs: 2_000,
  });

  const remaining = await deleteActiveSession({
    source: "jellyfin",
    type: "episode",
    title: "Scrubs - S01E03",
    season: 1,
    episode: 3,
    ids: { tvdb: "76156" },
  });

  assert.equal(remaining.length, 0);
  assert.equal((await listActiveSessions()).length, 0);
});

test("persisted Emby Up Next seed rows are purged from the active-session projection", async () => {
  db.prepare(`
    INSERT INTO active_sessions
      (id, title, media_type, source, progress, offset_ms, duration_ms, season, episode, poster_url, ids, event, client, updated_at, expire_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "emby:movie:tmdb:329865",
    "Arrival",
    "movie",
    "emby",
    0,
    0,
    3_600_000,
    null,
    null,
    "",
    JSON.stringify({ tmdb: "329865" }),
    "playback.start",
    JSON.stringify({ deviceName: "Plembfin Up Next", deviceId: UP_NEXT_SEED_DEVICE_ID }),
    Date.now(),
    Date.now() + 300_000,
  );

  assert.deepEqual(await listActiveSessions(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM active_sessions").get().count, 0);
});

test("an Emby Up Next seed session is rejected at the active-session write boundary", async () => {
  const sessions = await upsertActiveSession({
    source: "emby",
    type: "movie",
    title: "Synthetic Seed Movie",
    ids: { tmdb: "329865" },
    deviceId: UP_NEXT_SEED_DEVICE_ID,
    client: { deviceId: UP_NEXT_SEED_DEVICE_ID, deviceName: "Plekt Up Next" },
    progress: 0,
    durationMs: 3_600_000,
  });

  assert.deepEqual(sessions, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM active_sessions WHERE title = ?").get("Synthetic Seed Movie").count, 0);
});

test("a Jellyfin Up Next seed cannot be persisted or projected as Now Playing", async () => {
  await upsertActiveSession({
    source: "jellyfin", type: "movie", title: "Jellyfin Synthetic Seed",
    ids: { tmdb: "329865" }, deviceId: UP_NEXT_SEED_DEVICE_ID,
    client: { deviceId: UP_NEXT_SEED_DEVICE_ID }, durationMs: 3_600_000,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM active_sessions WHERE source = 'jellyfin'").get().count, 0);
  assert.deepEqual(await listActiveSessions(), []);
});
