import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-futurama-force-sync-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "false";
const { db, toJson } = await import("../server/src/db.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const { forceSyncMediaState } = await import("../server/src/utils/mediaForceSync.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const episode = (id, season, number, name) => ({ id, seriesId: 73871, season, episode: number, name });
const catalogue = { tvdbId: 73871, fetchedAt: Date.now() + 3600000, orders: {
  official: [episode(131184, 2, 2, "Mars University"), episode(131188, 2, 6, "Brannigan, Begin Again")],
  dvd: [episode(131184, 1, 11, "Mars University"), episode(131188, 2, 2, "Brannigan, Begin Again")],
} };

test.after(() => db.close());
test("Futurama DVD Force Sync imports Mars University at its verified aired identity", async (t) => {
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache(id,tvdb_id,title,details,updated_at_ms) VALUES(?,?,?,?,?)")
    .run("order_catalogue_v4_73871", "73871", "Futurama", toJson(catalogue), catalogue.fetchedAt);
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run("episode-order:v1:73871", toJson({ order: "dvd", mappings: [] }), Date.now());
  setShowSeasonSource("73871", "tvdb", { rowNumbering: "tvdb" });
  const config = { plex: { baseUrl: "https://futurama-force.test", token: "test" } };
  await saveMediaConfig(config);
  const original = globalThis.fetch;
  let includeUnverifiedEpisode = true;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.ok(!options.method || options.method === "GET", "pull must not write to a provider");
    if (url.pathname === "/library/all") return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "show", type: "show" }] } });
    if (url.pathname === "/library/metadata/show") return Response.json({ MediaContainer: { Metadata: [{ ratingKey: "show", type: "show" }] } });
    if (url.pathname === "/library/metadata/show/allLeaves") return Response.json({ MediaContainer: { Metadata: [{
      ratingKey: "mars", type: "episode", grandparentTitle: "Futurama", title: "Mars University",
      parentIndex: 1, index: 11, viewCount: 1, lastViewedAt: 1794000000,
      Guid: [{ id: "tvdb://131184" }],
    }, ...(includeUnverifiedEpisode ? [{
      ratingKey: "unknown", type: "episode", grandparentTitle: "Futurama", title: "Unknown episode",
      parentIndex: 9, index: 1, viewCount: 1, lastViewedAt: 1794000000, Guid: [],
    }] : [])] } });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const request = { title: "Futurama", type: "show", tvdb_id: "73871", mode: "pull", source: "plex" };
  await assert.rejects(forceSyncMediaState(request, { config }), /cannot safely match/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playstate").get().n, 0);
  includeUnverifiedEpisode = false;
  const result = await forceSyncMediaState(request, { config });
  assert.equal(result.imported, 1);
  const rows = db.prepare("SELECT season,episode,watch_provenance FROM watch_history WHERE tvdb_id='73871'").all();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].season, rows[0].episode], [2, 2]);
  assert.equal(JSON.parse(rows[0].watch_provenance).episode_order.airedId, 131184);
});

test("approving Mars University targets its Emby item rather than DVD S02E02", async (t) => {
  process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
  const { AUTH } = await import("../server/src/appConfig.js");
  const { enqueueManualWatchReview } = await import("../server/src/utils/manualWatchReview.js");
  const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
  const config = { plex: { disabled: true }, emby: { baseUrl: "https://futurama-review.test", apiKey: "test", userId: "user" } };
  await saveMediaConfig(config);
  const writes = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) return Response.json({ Items: [{ Id: "futurama", ProviderIds: { Tvdb: "73871" } }] });
    if (url.searchParams.get("ParentId") === "futurama") return Response.json({ Items: [
      { Id: "mars", ParentIndexNumber: 1, IndexNumber: 11, ProviderIds: { Tvdb: "131184" } },
      { Id: "brannigan", ParentIndexNumber: 2, IndexNumber: 2, ProviderIds: { Tvdb: "131188" } },
    ] });
    if (url.pathname.startsWith("/Users/user/PlayedItems/")) {
      writes.push({ path: url.pathname, method: options.method });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const queued = enqueueManualWatchReview({ type: "episode", source: "plex", title: "Futurama - S02E02",
    showTitle: "Futurama", episode_title: "Mars University", season: 2, episode: 2, ids: { tvdb: "73871" },
    watchProvenance: { episode_order: { tvdbId: "73871", dvdId: 131184, airedId: 131184, order: "dvd" } },
  }, { sourceFingerprint: "futurama-mars-review" });
  let status = 200, body;
  await handleManualWatchReview({ method: "POST", body: { mode: "now" }, headers: { "x-api-key": AUTH.apiKey }, cookies: {},
    get(name) { return this.headers[name.toLowerCase()] || ""; } },
  { status(code) { status = code; return this; }, set() { return this; }, send(value) { body = JSON.parse(value); return this; } },
  `manual-watch-review/${queued.review.id}/approve`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(writes, [{ path: "/Users/user/PlayedItems/mars", method: "POST" }]);
  const rows = db.prepare("SELECT season,episode,watch_provenance FROM watch_history WHERE tvdb_id='73871'").all();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].season, rows[0].episode], [2, 2]);
  assert.equal(JSON.parse(rows[0].watch_provenance).episode_order.airedId, 131184);
});
