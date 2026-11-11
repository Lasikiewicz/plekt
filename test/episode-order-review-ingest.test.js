import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-review-ingest-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db, toJson } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { handleWebhook } = await import("../server/src/routes/sync.js");
const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
const { listPendingManualWatchReviews } = await import("../server/src/utils/manualWatchReview.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const { queryShowDetail } = await import("../server/src/utils/dataRepo.js");

test.after(() => db.close());

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = JSON.parse(body); return this; },
  };
}

function reviewRequest() {
  const headers = { "x-api-key": AUTH.apiKey };
  return {
    method: "POST",
    body: { mode: "detected" },
    headers,
    cookies: {},
    get(name) { return headers[String(name).toLowerCase()] || ""; },
  };
}

test("Emby played flag retains verified DVD identity through manual review approval", async (t) => {
  const showId = "73871";
  const episodeId = 131206;
  const catalogue = {
    tvdbId: Number(showId),
    fetchedAt: Date.now() + 60 * 60 * 1000,
    orders: {
      official: [{ id: episodeId, seriesId: Number(showId), season: 3, episode: 4, name: "Parasites Lost" }],
      dvd: [{ id: episodeId, seriesId: Number(showId), season: 3, episode: 2, name: "Parasites Lost" }],
    },
  };
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache(id,tvdb_id,title,details,updated_at_ms) VALUES(?,?,?,?,?)")
    .run(`order_catalogue_v4_${showId}`, showId, "Futurama", toJson(catalogue), catalogue.fetchedAt);
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache(id,tvdb_id,title,details,updated_at_ms) VALUES(?,?,?,?,?)")
    .run(`series_${showId}`, showId, "Futurama", toJson({ id: Number(showId), name: "Futurama", episodes: [] }), Date.now());
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run(`episode-order:v1:${showId}`, toJson({ order: "dvd", mappings: [] }), Date.now());
  setShowSeasonSource(showId, "tvdb", { rowNumbering: "tvdb" });

  await saveMediaConfig({
    tuning: { watchImportMode: "review" },
    emby: {
      baseUrl: "https://futurama-review-ingest.test",
      apiKey: "test-key",
      userId: "emby-user",
      sync: { preset: "custom", watched: "send", unwatched: "off", progress: "off" },
    },
    plex: { disabled: true },
    jellyfin: { disabled: true },
  });

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.ok(!options.method || options.method === "GET", "the regression path performs provider reads only");
    if (url.pathname === "/Users/emby-user/Items/futurama") {
      return Response.json({ Id: "futurama", Type: "Series", ProviderIds: { Tvdb: showId } });
    }
    if (url.pathname === "/Users/emby-user/Items" && url.searchParams.get("IncludeItemTypes") === "Series") {
      return Response.json({ Items: [{ Id: "futurama", Type: "Series", ProviderIds: { Tvdb: showId } }] });
    }
    if (url.pathname === "/Users/emby-user/Items" && url.searchParams.get("ParentId") === "futurama") {
      return Response.json({ Items: [{
        Id: "parasites-lost",
        Type: "Episode",
        SeriesId: "futurama",
        SeriesName: "Futurama",
        Name: "Parasites Lost",
        ParentIndexNumber: 3,
        IndexNumber: 2,
        ProviderIds: { Tvdb: String(episodeId) },
        UserData: { Played: true, LastPlayedDate: "2026-11-10T12:00:00.000Z" },
      }] });
    }
    throw new Error(`Unexpected provider request: ${url.pathname}${url.search}`);
  };

  const webhookResponse = captureResponse();
  await handleWebhook({
    method: "POST",
    query: {},
    body: {
      Event: "ItemMarkPlayed",
      UserId: "emby-user",
      Item: {
        Id: "parasites-lost",
        Type: "Episode",
        Name: "Parasites Lost",
        SeriesName: "Futurama",
        SeriesId: "futurama",
        ParentIndexNumber: 3,
        IndexNumber: 2,
        ProviderIds: { Tvdb: String(episodeId) },
        SeriesProviderIds: { Tvdb: showId },
        PremiereDate: "2002-03-28T00:00:00.0000000Z",
        UserData: { Played: true, LastPlayedDate: "2026-11-10T12:00:00.000Z" },
      },
    },
    headers: { "x-plekt-webhook-secret": AUTH.webhookSecret },
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  }, webhookResponse);

  assert.equal(webhookResponse.statusCode, 200, JSON.stringify(webhookResponse.body));
  assert.equal(webhookResponse.body.queued, true, JSON.stringify(webhookResponse.body));
  const [review] = listPendingManualWatchReviews();
  assert.ok(review, "the played flag is held for a manual decision");
  assert.deepEqual(review.media.watchProvenance.episode_order, {
    tvdbId: showId,
    dvdId: episodeId,
    airedId: episodeId,
    order: "dvd",
  }, "the review retains the identity verified against the DVD catalogue");

  const approvalResponse = captureResponse();
  await handleManualWatchReview(reviewRequest(), approvalResponse, `manual-watch-review/${encodeURIComponent(review.id)}/approve`);
  assert.equal(approvalResponse.statusCode, 200, JSON.stringify(approvalResponse.body));
  assert.equal(approvalResponse.body.status, "approved");

  const stored = db.prepare("SELECT season, episode, watch_provenance FROM watch_history WHERE tvdb_id = ?").get(showId);
  assert.ok(stored, "approval writes the canonical history row");
  assert.deepEqual([stored.season, stored.episode], [3, 4], "storage uses the verified aired coordinate");
  assert.deepEqual(JSON.parse(stored.watch_provenance).episode_order, {
    tvdbId: showId,
    dvdId: episodeId,
    airedId: episodeId,
    order: "dvd",
  });

  const detail = await queryShowDetail({ title: "Futurama", tvdbId: showId, displayNumbering: true });
  const episode = detail.episodes.find((row) => row.season === 3 && row.episode === 4);
  assert.ok(episode, "the approved episode appears on the show detail");
  assert.deepEqual([episode.display_season, episode.display_episode], [3, 2], "the show page uses the selected DVD coordinates");
});
