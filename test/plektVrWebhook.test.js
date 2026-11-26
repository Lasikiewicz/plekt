import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plektvr-webhook-");

const { normalizeWebhook } = await import("../server/src/routes/sync.js");

function request(body) {
  const headers = { "content-type": "application/json", "user-agent": "PlektVR/1.0" };
  return {
    get: (name) => headers[String(name).toLowerCase()] || "",
    rawBody: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

test("a PlektVR movie stopped at 95% is completed and keeps its timing", async () => {
  const media = await normalizeWebhook(request({
    source: "plektvr",
    event: "stop",
    type: "movie",
    title: "Arrival",
    year: 2016,
    ids: { tmdb: "329865" },
    file: { name: "Arrival (2016).mkv", path: "smb://nas/movies/Arrival (2016).mkv", sizeBytes: 4200000000 },
    positionMs: 6840000,
    durationMs: 7200000,
    device: "Quest 3",
  }));

  assert.equal(media.isValid, true);
  assert.equal(media.source, "plektvr");
  assert.equal(media.type, "movie");
  assert.equal(media.title, "Arrival");
  assert.equal(media.phase, "completed");
  assert.equal(media.event, "stop");
  assert.equal(media.progress, 95);
  assert.equal(media.offsetMs, 6840000);
  assert.equal(media.durationMs, 7200000);
  assert.equal(media.ids.tmdb, "329865");
});

test("a PlektVR episode stopped at 50% is ended and keeps season and episode", async () => {
  const media = await normalizeWebhook(request({
    source: "plektvr",
    event: "stop",
    type: "episode",
    title: "Severance",
    season: "2",
    episode: 4,
    positionMs: 1200000,
    durationMs: 2400000,
  }));

  assert.equal(media.isValid, true);
  assert.equal(media.type, "episode");
  assert.equal(media.season, 2);
  assert.equal(media.episode, 4);
  assert.equal(media.phase, "ended");
  assert.equal(media.progress, 50);
});

test("a PlektVR stop without a known duration cannot prove a watch", async () => {
  const media = await normalizeWebhook(request({
    source: "plektvr",
    type: "movie",
    title: "Unknown Length",
    positionMs: 3600000,
  }));

  assert.equal(media.isValid, true);
  assert.equal(media.phase, "ended");
  assert.equal(media.progress, 0);
  assert.equal(media.durationMs, 0);
  assert.deepEqual(
    { imdb: media.ids.imdb, tmdb: media.ids.tmdb, tvdb: media.ids.tvdb },
    { imdb: undefined, tmdb: undefined, tvdb: undefined },
  );
});

test("a PlektVR event with an unknown type is not actionable", async () => {
  const media = await normalizeWebhook(request({
    source: "plektvr",
    type: "trailer",
    title: "Something",
    positionMs: 100,
    durationMs: 100,
  }));

  assert.equal(media.isValid, false);
});

test("the Plex unscrobble path is unchanged by the PlektVR branch", async () => {
  const media = await normalizeWebhook(request({
    source: "plex",
    event: "media.unscrobble",
    type: "movie",
    title: "Arrival",
    tmdb_id: "329865",
  }));

  assert.equal(media.isValid, true);
  assert.equal(media.source, "plex");
  assert.equal(media.phase, "unplayed");
});
