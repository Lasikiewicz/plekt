import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-coalesce-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const { createTrackerWriteIntent, SIMKL_WATCHED_COALESCE_MS } = await import("../server/src/utils/trackerWriteIntents.js");
const { writeSimklWatched } = await import("../server/src/utils/trackers/simkl.js");
const { dispatchSimklWatchState } = await import("../server/src/utils/trackers/simklDispatch.js");

const date = "2026-10-23T12:00:00.000Z";
const media = (tmdb = 1) => ({ type: "movie", title: `Movie ${tmdb}`, ids: { tmdb }, watched_at: date });

function connect() {
  db.prepare("DELETE FROM tracker_write_intents").run();
  db.prepare("DELETE FROM tracker_connections").run();
  repo.saveTrackerConnection({
    provider: "simkl", clientId: "client", remoteUserId: "coalesce",
    accessToken: "token", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3600_000,
  });
  return repo.getTrackerConnection("simkl", { includeCredentials: true });
}

test("Simkl watched intents share one coalesce due time and defer until it elapses", async () => {
  const connection = connect();
  const now = Date.now();
  const first = createTrackerWriteIntent({ provider: "simkl", connection, media: media(1), action: "watched", now });
  const second = createTrackerWriteIntent({ provider: "simkl", connection, media: media(2), action: "watched", now: now + 60_000 });
  assert.equal(first.due_at, now + SIMKL_WATCHED_COALESCE_MS);
  assert.equal(second.due_at, first.due_at);
  const deferred = await writeSimklWatched(connection, { ...media(1), trackerWriteIntentId: first.id }, { trigger: "event" });
  assert.deepEqual(deferred, { deferred: true, dueAt: first.due_at });
  assert.equal(db.prepare("SELECT status FROM tracker_write_intents WHERE id=?").get(first.id).status, "pending");
});

test("explicit simklSendNow bypasses the coalesce window without provider calls when already reported", async () => {
  const connection = connect();
  const now = Date.now();
  const intent = createTrackerWriteIntent({ provider: "simkl", connection, media: media(3), action: "watched", now });
  assert.ok(intent.due_at > now);
  db.prepare(`INSERT INTO tracker_observations (id,provider,connection_id,account_id,observation_key,kind,observation_json,status,reason,created_at,updated_at)
    VALUES ('seen','simkl',?,'coalesce','watched:movie:tmdb:3','watched',?,'observed','',0,0)`)
    .run(connection.id, JSON.stringify({ media: media(3), watchedAt: Date.parse(date) }));
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not network"); };
  try {
    const result = await dispatchSimklWatchState({ ...media(3), watchRecordId: "r3", simklSendNow: true }, "watched", "sync");
    assert.equal(result.status, "success");
  } finally {
    globalThis.fetch = original;
  }
});
