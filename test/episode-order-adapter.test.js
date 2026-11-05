import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-adapter-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db, toJson } = await import("../server/src/db.js");
const { getTvdbOrderCatalogue } = await import("../server/src/utils/tvdbOrderGateway.js");
const { markEmbyPlayed, markEmbyUnplayed, __resetEmbySeriesCache } = await import("../server/src/utils/embyClient.js");

const tvdbId = "987654";
const config = { baseUrl: "https://emby.example.test", apiKey: "token", userId: "user" };
const aired = { id: 987651, seriesId: 987654, season: 2, episode: 1, name: "Pilot" };
const dvd = { id: 987652, seriesId: 987654, season: 1, episode: 10, name: "Pilot" };
const episode = { Id: "native-s1e10", ParentIndexNumber: 1, IndexNumber: 10, ProviderIds: { Tvdb: String(aired.id) } };

async function seedCatalogue() {
  await getTvdbOrderCatalogue(tvdbId, {
    force: true,
    loadSeries: async (id) => ({ id: Number(id), name: "Example Show", seasons: [{ type: { type: "official" } }, { type: { type: "dvd" } }] }),
    loadEndpoint: async (endpoint) => {
      if (endpoint === "/seasons/types") return { data: [{ id: 1, type: "official" }, { id: 2, type: "dvd" }] };
      const order = endpoint.replace(/\/eng$/, "").endsWith("/dvd") ? [dvd] : [aired];
      return { data: { episodes: order.map((row) => ({ id: row.id, seriesId: row.seriesId, seasonNumber: row.season, number: row.episode, name: row.name })), links: { next: null }, meta: { totalItems: order.length, totalPages: 1 } } };
    },
  });
  db.prepare("INSERT INTO settings(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
    .run(`episode-order:v1:${tvdbId}`, toJson({ order: "dvd", mappings: [{ dvdId: dvd.id, airedId: aired.id, signature: JSON.stringify([dvd.id,dvd.seriesId,dvd.season,dvd.episode,dvd.name,aired.id,aired.seriesId,aired.season,aired.episode,aired.name]) }] }), Date.now());
}

test.before(async () => {
  await seedCatalogue();
});

test.after(() => db.close());

async function invokeAdapter(action, rows) {
  __resetEmbySeriesCache();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/Users/user/Items" && parsed.searchParams.has("AnyProviderIdEquals")) {
      return Response.json({ Items: [{ Id: "series-native", ProviderIds: { Tvdb: tvdbId } }] });
    }
    if (parsed.pathname === "/Users/user/Items" && parsed.searchParams.get("ParentId") === "series-native") {
      return Response.json({ Items: rows });
    }
    if (parsed.pathname.startsWith("/Users/user/PlayedItems/")) {
      requests.push({ path: parsed.pathname, method: options.method });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fake Emby request: ${options.method || "GET"} ${parsed}`);
  };
  try {
    const fn = action === "watched" ? markEmbyPlayed : markEmbyUnplayed;
    try {
      const result = await fn(config, {
        type: "episode", media_type: "episode", title: "Example Show - S02E01", tvdb_id: tvdbId,
        season: aired.season, episode: aired.episode,
        watch_provenance: { episode_order: { tvdbId, dvdId: dvd.id, airedId: aired.id } },
      });
      return { result, requests };
    } catch (error) {
      return { error, requests };
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Emby watch and unwatch use the exact native item for a mapped aired episode", async () => {
  for (const [action, method] of [["watched", "POST"], ["unwatched", "DELETE"]]) {
    const { result, requests } = await invokeAdapter(action, [episode]);
    assert.equal(result.status, "fulfilled");
    assert.deepEqual(requests, [{ path: "/Users/user/PlayedItems/native-s1e10", method }]);
    assert.ok(requests.every((request) => !request.path.endsWith("/wrong-coordinate-target")));
  }
});

test("Emby adapter sends no mutation when the exact TVDB episode id is absent or ambiguous", async () => {
  for (const rows of [
    [{ ...episode, ProviderIds: {} }],
    [episode, { ...episode, Id: "duplicate-native" }],
  ]) {
    const { error, requests } = await invokeAdapter("watched", rows);
    assert.match(error?.message || "", /DVD order mapping warning/);
    assert.deepEqual(requests, [], "an unverified mapping must not send a mutation");
  }
});
