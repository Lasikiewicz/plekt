import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-dropped-undrop-");
const { dropTitle, listDroppedTitles, undropTitleForLivePlay } = await import("../server/src/utils/droppedTitles.js");
const { db } = await import("../server/src/db.js");
const { insertWatchRecordSync, batchInsertWatchRecords } = await import("../server/src/utils/dataRepo.js");
const { handleWebhook } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { loadMediaConfig, saveMediaConfig } = await import("../server/src/utils/configStore.js");

const reacherShow = { media_type: "tv", title: "Reacher", tmdb_id: "108978" };
const reacherRow = (watchedAt) => ({
  title: "Reacher - S02E04",
  media_type: "episode",
  show_title: "Reacher",
  season: 2,
  episode: 4,
  tmdb_id: "108978",
  watched_at: new Date(watchedAt).toISOString(),
  source: "jellyfin",
});

function reset() {
  db.prepare("DELETE FROM dropped_titles").run();
}

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = JSON.parse(body); return this; },
  };
}

async function sendJellyfin(body) {
  const headers = { "content-type": "application/json", "x-plekt-webhook-secret": AUTH.webhookSecret };
  const response = responseCapture();
  await handleWebhook({ method: "POST", query: {}, headers, get: (name) => headers[String(name).toLowerCase()] || "", body }, response);
  return response;
}

const movieItem = (name, tmdb) => ({ Type: "Movie", Name: name, Id: `jf-${tmdb}`, ProviderIds: { Tmdb: tmdb }, RunTimeTicks: 36_000_000_000 });

test("a live play dated after the drop un-drops; one dated before it does not", () => {
  reset();
  const droppedAt = Date.parse("2026-10-20T12:00:00Z");
  dropTitle(reacherShow, { now: droppedAt });
  assert.equal(undropTitleForLivePlay(reacherRow(droppedAt - 60_000)), 0, "a play from before the drop");
  assert.equal(listDroppedTitles().length, 1);
  assert.equal(undropTitleForLivePlay(reacherRow(droppedAt)), 0, "a play at the exact drop time is not newer");
  assert.equal(undropTitleForLivePlay({ ...reacherRow(droppedAt), watched_at: "invalid" }), 0, "an unknown watch time cannot restore");
  assert.equal(undropTitleForLivePlay({ ...reacherRow(droppedAt + 60_000), tmdb_id: "999001" }), 0, "a same-title show with another id");
  assert.equal(listDroppedTitles().length, 1);
  assert.equal(undropTitleForLivePlay(reacherRow(droppedAt + 60_000)), 1);
  assert.equal(listDroppedTitles().length, 0);
});

test("imported and backfilled plays never un-drop, even when dated after the drop", async () => {
  reset();
  const droppedAt = Date.now() - 3_600_000;
  dropTitle(reacherShow, { now: droppedAt });
  insertWatchRecordSync({ ...reacherRow(droppedAt + 60_000), source: "trakt_import" });
  await batchInsertWatchRecords([{ ...reacherRow(droppedAt + 120_000), episode: 5, title: "Reacher - S02E05", source: "import" }]);
  assert.equal(listDroppedTitles().length, 1);
});

test("a completed playback webhook un-drops; a played flag and a play before the drop do not", async () => {
  reset();
  const config = await loadMediaConfig();
  await saveMediaConfig({ ...config, tuning: { ...config.tuning, watchImportMode: "now" } });
  const now = Date.now();
  dropTitle({ media_type: "movie", title: "Arrival", tmdb_id: "329865" }, { now: now - 3_600_000 });
  dropTitle({ media_type: "movie", title: "Sicario", tmdb_id: "273481" }, { now: now - 3_600_000 });
  dropTitle({ media_type: "movie", title: "Prisoners", tmdb_id: "146233" }, { now: now + 3_600_000 });

  const flag = await sendJellyfin({
    NotificationType: "ItemMarkPlayed", UserId: "jellyfin-user",
    Item: { ...movieItem("Sicario", "273481"), UserData: { Played: true, LastPlayedDate: new Date(now).toISOString() } },
  });
  assert.equal(flag.statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE title = 'Sicario'").get().count, 1, "played flag reaches watch persistence");

  for (const [name, tmdb] of [["Arrival", "329865"], ["Prisoners", "146233"]]) {
    const played = await sendJellyfin({
      NotificationType: "PlaybackStop", UserId: "jellyfin-user", DeviceId: `device-${tmdb}`, SessionId: `session-${tmdb}`,
      Client: "Jellyfin Web", PlaybackPositionTicks: 36_000_000_000, PlayedToCompletion: true, Item: movieItem(name, tmdb),
    });
    assert.equal(played.statusCode, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE title = ?").get(name).count, 1, `${name} play recorded`);
  }

  assert.deepEqual(listDroppedTitles().map((row) => row.title).sort(), ["Prisoners", "Sicario"]);
});

test("a same-day completed PlaybackStop after dropping restores without adding another history row", async () => {
  reset();
  const now = Date.now();
  const media = { title: "Same Day Rewatch", media_type: "movie", tmdb_id: "900008", watched_at: new Date(now - 10_000).toISOString(), source: "jellyfin" };
  insertWatchRecordSync(media);
  dropTitle({ media_type: "movie", title: media.title, tmdb_id: media.tmdb_id }, { now: now - 5_000 });

  const played = await sendJellyfin({
    NotificationType: "PlaybackStop", UserId: "jellyfin-user", DeviceId: "device-900008", SessionId: "session-900008",
    Client: "Jellyfin Web", PlaybackPositionTicks: 36_000_000_000, PlayedToCompletion: true,
    Item: movieItem(media.title, media.tmdb_id),
  });

  assert.equal(played.statusCode, 200);
  assert.equal(played.body.inserted, false, "recent watch dedupe retains the existing history row");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE title = ?").get(media.title).count, 1);
  assert.equal(listDroppedTitles().length, 0, "the genuine completed playback restores the title");
});
