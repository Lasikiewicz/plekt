import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-polling-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db, toJson } = await import("../server/src/db.js");
const { assertOrderInsert } = await import("../server/src/utils/episodeOrder.js");
const { keepOrderProvenance, resolveOrderMediaForPolling, resolveOrderUpNextAction } = await import("../server/src/utils/episodeOrderWatch.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");

const TVDB_ID = "340234";
const SERIES_ID = Number(TVDB_ID);
const episode = (id, season, number) => ({ id, seriesId: SERIES_ID, season, episode: number, name: `Episode ${id}`, air_date: "2018-08-17", overview: "", still_path: null, runtime: 25 });

// Netflix parts order: the same episode ids as the aired order under other numbers
// (alternate S2E1 is aired S1E11).
const catalogue = {
  tvdbId: SERIES_ID,
  orders: { official: [episode(7187957, 1, 11)], dvd: [], absolute: [], alternate: [episode(7187957, 2, 1)], regional: [], altdvd: [], alttwo: [] },
  labels: { alternate: "Parts Order (Netflix)" },
  fetchedAt: Date.now() + 60 * 60 * 1000,
};

function seed(order = "alternate", orders = catalogue) {
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)")
    .run(`order_catalogue_v4_${TVDB_ID}`, TVDB_ID, "Disenchantment", toJson(orders), orders.fetchedAt);
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run(`episode-order:v1:${TVDB_ID}`, toJson({ order, mappings: [] }), Date.now());
  setShowSeasonSource(TVDB_ID, "tvdb", { rowNumbering: "tvdb" });
}

test.after(() => db.close());

test("review approval preserves identity, serializes concurrent decisions, and blocks lost proof", async () => {
  seed();
  const { AUTH } = await import("../server/src/appConfig.js");
  const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
  const { enqueueManualWatchReview, getManualWatchReview } = await import("../server/src/utils/manualWatchReview.js");
  const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
  await saveMediaConfig({});
  const identity = { tvdbId: TVDB_ID, dvdId: 7187957, airedId: 7187957, order: "alternate" };
  const media = { type: "episode", source: "plex", title: "Disenchantment - S01E11", showTitle: "Disenchantment", season: 1, episode: 11,
    ids: { tvdb: TVDB_ID }, watchProvenance: { episode_order: identity } };
  const approve = async id => {
    let status = 200, body;
    await handleManualWatchReview({ method: "POST", body: { mode: "now" }, headers: { "x-api-key": AUTH.apiKey }, cookies: {},
      get(name) { return this.headers[name.toLowerCase()] || ""; } },
    { status(code) { status = code; return this; }, set() { return this; }, send(value) { body = JSON.parse(value); return this; } },
    `manual-watch-review/${id}/approve`);
    return { status, body };
  };
  const queue = enqueueManualWatchReview(media, { sourceFingerprint: "order-review" });
  // Selecting a different order must not reinterpret the queued coordinates.
  seed("official");
  const results = await Promise.all([approve(queue.review.id), approve(queue.review.id)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const rows = db.prepare("SELECT * FROM watch_history WHERE tvdb_id=?").all(TVDB_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].season, rows[0].episode], [1, 11]);
  assert.deepEqual(JSON.parse(rows[0].watch_provenance).episode_order, identity);
  await approve(queue.review.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE tvdb_id=?").get(TVDB_ID).n, 1);
  db.prepare("DELETE FROM watch_history WHERE tvdb_id=?").run(TVDB_ID);
  db.prepare("DELETE FROM playstate").run();
  seed();
  const legacy = enqueueManualWatchReview({ ...media, episode: 12, watchProvenance: null }, { sourceFingerprint: "legacy-order-review" });
  assert.equal((await approve(legacy.review.id)).status, 409);
  assert.equal(getManualWatchReview(legacy.review.id).status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE tvdb_id=?").get(TVDB_ID).n, 0);
});

test("changed identity proof and an unavailable destination refuse order revalidation", async () => {
  seed();
  const { resolveOrderWatch } = await import("../server/src/utils/episodeOrderWatch.js");
  const media = { type: "episode", source: "plex", title: "Disenchantment - S01E11", season: 1, episode: 11,
    ids: { tvdb: TVDB_ID }, watchProvenance: { episode_order: { tvdbId: TVDB_ID, dvdId: 7187957, airedId: 999, order: "alternate" } } };
  await assert.rejects(resolveOrderWatch(media, {}), { code: "EPISODE_MAPPING_REQUIRED" });
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method && options.method !== "GET") writes++;
    return Response.json({ error: "unavailable" }, { status: 503 });
  };
  try {
    await assert.rejects(resolveOrderWatch({ ...media, watchProvenance: { episode_order: { ...media.watchProvenance.episode_order, airedId: 7187957 } } },
      { emby: { baseUrl: "https://unavailable-order.test", apiKey: "key", userId: "user" } }), /cannot safely match/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("selected-order display keeps canonical coordinates and provider actions intact", async () => {
  seed();
  const { episodeOrderDisplay } = await import("../server/src/utils/episodeOrder.js");
  const item = { media_type: "episode", show_tvdb_id: TVDB_ID, season: 1, episode: 11, provider_items: { plex: ["native"] } };
  const shown = episodeOrderDisplay(item);
  assert.deepEqual([shown.display_season, shown.display_episode], [2, 1]);
  assert.equal(shown.episode_order_label, "Parts Order (Netflix)");
  assert.deepEqual([shown.season, shown.episode], [1, 11]);
  assert.equal(shown.provider_items, item.provider_items);
  assert.equal(item.display_season, undefined);
  assert.equal(shown.watch_provenance.episode_order.airedId, 7187957);
});

test("Up Next library inventory and lookups use exact aired IDs instead of native order coordinates", async (t) => {
  seed();
  const { orderCoordinate: canonicalOrderCoordinate, orderSeason: getCachedTmdbSeason, orderDetails: getCachedTmdbDetails } = await import("../server/src/utils/episodeOrderUpNext.js");
  const { resolveUpNextProviderItemId, createUpNextLibraryEpisodeLookup } = await import("../server/src/utils/upNextLibraryLookup.js");
  const show = { title: "Disenchantment", tvdb_id: TVDB_ID };
  assert.deepEqual(getCachedTmdbSeason({ tvdbId: TVDB_ID, seasonNumber: 1 }).episodes.map(e => e.episode_number), [11]);
  assert.deepEqual(getCachedTmdbDetails({ mediaType: "tv", ids: { tvdbId: TVDB_ID } }).seasons, [{ season_number: 1 }]);
  const native = { Id: "native", ParentIndexNumber: 2, IndexNumber: 1, ProviderIds: { Tvdb: "7187957" }, PremiereDate: "2018-08-17" };
  assert.deepEqual(canonicalOrderCoordinate("emby", native, show, { season: 2, episode: 1 }), { season: 1, episode: 11 });
  assert.equal(canonicalOrderCoordinate("emby", { ...native, ProviderIds: {} }, show, { season: 2, episode: 1 }), null);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) return Response.json({ Items: [{ Id: "series", ProviderIds: { Tvdb: TVDB_ID } }] });
    if (url.searchParams.get("ParentId") === "series") return Response.json({ Items: [native] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const section = { baseUrl: "https://inventory-order.test", apiKey: "key", userId: "user" };
  const item = { media_type: "episode", show_tvdb_id: TVDB_ID, show_title: "Disenchantment", season: 1, episode: 11 };
  assert.equal((await resolveUpNextProviderItemId("emby", section, item)).providerItemId, "native");
  assert.equal((await resolveUpNextProviderItemId("emby", section, { ...item, season: 2, episode: 1, provider_items: { emby: ["native"] } })).providerItemId, "");
  const inventory = await createUpNextLibraryEpisodeLookup({ emby: section })(show);
  assert.deepEqual(inventory.map(e => [e.season, e.episode]), [[1, 11]]);
});

test("a manual Up Next removal verifies its native episode before inserting an unwatch", async (t) => {
  seed();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(options.method || "GET", "GET", "preflight must not change provider state");
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) {
      return Response.json({ Items: [{ Id: "series", ProviderIds: { Tvdb: TVDB_ID } }] });
    }
    if (url.searchParams.get("ParentId") === "series") {
      return Response.json({ Items: [{ Id: "native-episode", ParentIndexNumber: 2, IndexNumber: 1, ProviderIds: { Tvdb: "7187957" } }] });
    }
    throw new Error(`Unexpected preflight request: ${url.pathname}`);
  };
  const config = { emby: { baseUrl: "https://upnext-order.test", apiKey: "key", userId: "user" } };
  const media = {
    type: "episode", source: "manual", title: "Disenchantment - S02E01", ids: { tvdb: TVDB_ID },
    season: 2, episode: 1, providerItems: { emby: ["native-episode"] }, media_key: "native-s2e1",
  };
  const resolved = await resolveOrderUpNextAction(media, config);
  assert.deepEqual([resolved.season, resolved.episode], [1, 11]);
  assert.equal(resolved.source, "manual");
  assert.equal(resolved.media_key, undefined);
  assert.doesNotThrow(() => assertOrderInsert(resolved));
  assert.equal(media.season, 2, "the request remains unchanged");
  await assert.rejects(resolveOrderUpNextAction({ ...media, providerItems: {} }, config), { code: "EPISODE_MAPPING_REQUIRED" });
});

test("remove and clear return a mapping conflict before writing unverified order state", async () => {
  seed();
  const { AUTH } = await import("../server/src/appConfig.js");
  const { handleUpNextRemove, handlePlaybackProgressUnwatch } = await import("../server/src/routes/sync.js");
  const before = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  for (const handler of [handleUpNextRemove, handlePlaybackProgressUnwatch]) {
    let status, payload;
    const headers = { "x-api-key": AUTH.apiKey };
    const req = { method: "POST", headers, cookies: {}, get: name => headers[name] || "",
      body: { media_key: "order-removal", media_type: "episode", title: "Disenchantment", show_tvdb_id: TVDB_ID, season: 2, episode: 1 } };
    const res = { status(code) { status = code; return this; }, set() { return this; }, send(value) { payload = JSON.parse(value); return this; } };
    await handler(req, res);
    assert.equal(status, 409);
    assert.equal(payload.code, "EPISODE_MAPPING_REQUIRED");
    assert.match(payload.error, /verified media-server item/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, before);
  }
});

test("a polled episode already carrying its verified order identity keeps it through a provenance rebuild", async () => {
  seed();
  const identity = { tvdbId: TVDB_ID, dvdId: 7187957, airedId: 7187957, order: "alternate" };
  const media = {
    type: "episode", source: "plex", isValid: true, title: "Disenchantment - S01E11", tvdb_id: TVDB_ID, ids: { tvdb: TVDB_ID },
    season: 1, episode: 11, watchProvenance: { episode_order: identity },
  };
  const warnings = [];
  const resolved = await resolveOrderMediaForPolling(media, {}, (message) => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.deepEqual([resolved.season, resolved.episode], [1, 11]);
  assert.deepEqual(resolved.watchProvenance.episode_order, identity);

  // A provenance builder replaces the whole object; the identity must survive it or
  // the insert guard refuses the row.
  const rebuilt = keepOrderProvenance(resolved.watchProvenance, { source: "plex", ingestPath: "plex_notification" });
  assert.deepEqual(rebuilt.episode_order, identity);
  assert.equal(rebuilt.ingestPath, "plex_notification");
  const { watch_provenance: _resolvedProvenance, ...bare } = resolved;
  assert.doesNotThrow(() => assertOrderInsert({ ...bare, watchProvenance: rebuilt }));
  assert.throws(() => assertOrderInsert({ ...bare, watchProvenance: { source: "plex" } }), /cannot be safely matched/);
});

test("keepOrderProvenance leaves a plain provenance alone and carries provider overrides", () => {
  assert.deepEqual(keepOrderProvenance(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(keepOrderProvenance({ other: true }, { a: 1 }), { a: 1 });
  assert.deepEqual(
    keepOrderProvenance({ episode_order: { airedId: 1 }, provider_overrides: { trakt: { tvdb_episode_id: "1" } } }, { a: 1 }),
    { a: 1, episode_order: { airedId: 1 }, provider_overrides: { trakt: { tvdb_episode_id: "1" } } },
  );
});

test("a polled watch that cannot be translated is refused with a logged reason and writes nothing", async () => {
  seed();
  const before = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  const warnings = [];
  // No verified identity and no reachable source server: the native S02E01 cannot be proven to be aired S01E11.
  const resolved = await resolveOrderMediaForPolling(
    { type: "episode", source: "plex", isValid: true, title: "Disenchantment - S02E01", tvdb_id: TVDB_ID, ids: { tvdb: TVDB_ID }, season: 2, episode: 1 },
    {},
    (message) => warnings.push(message),
  );
  assert.equal(resolved, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Disenchantment - S02E01/);
  assert.match(warnings[0], /plex/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, before);
});

test("a movie or an Aired-order show passes through the polling resolver untouched", async () => {
  db.prepare("DELETE FROM settings WHERE id=?").run(`episode-order:v1:${TVDB_ID}`);
  const movie = { type: "movie", source: "plex", title: "A Movie" };
  assert.equal(await resolveOrderMediaForPolling(movie, {}), movie);
  const aired = { type: "episode", source: "plex", title: "Disenchantment - S01E11", tvdb_id: TVDB_ID, season: 1, episode: 11 };
  assert.equal(await resolveOrderMediaForPolling(aired, {}), aired);
});

// A media server that numbers the episode in the saved order (S02E01 or the DVD
// number) while its provider id proves it is the aired S01E11.
function mockEmbyNativeEpisode(t, { season, episode }) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ method: options.method || "GET", host: url.host, path: url.pathname });
    if (url.pathname.endsWith("/Sessions")) return Response.json([]);
    if (url.searchParams.has("AnyProviderIdEquals")) return Response.json({ Items: [{ Id: "series", ProviderIds: { Tvdb: TVDB_ID } }] });
    if (url.searchParams.get("ParentId") === "series") {
      return Response.json({ Items: [{ Id: "native-episode", ParentIndexNumber: season, IndexNumber: episode, ProviderIds: { Tvdb: "7187957" } }] });
    }
    return new Response("{}", { status: 404 });
  };
  return calls;
}
const EMBY_CONFIG = { emby: { baseUrl: "https://polling-order.test", apiKey: "key", userId: "user" } };

for (const [label, order, native, orders] of [
  ["Netflix (alternate)", "alternate", { season: 2, episode: 1 }, catalogue],
  ["DVD", "dvd", { season: 1, episode: 5 }, {
    ...catalogue,
    orders: { ...catalogue.orders, dvd: [episode(7187957, 1, 5)], alternate: [] },
  }],
]) {
  test(`a polled ${label} order watch from a media server is stored under its aired episode with the order identity`, async (t) => {
    seed(order, orders);
    mockEmbyNativeEpisode(t, native);
    const resolved = await resolveOrderMediaForPolling(
      { type: "episode", source: "emby", isValid: true, title: `Disenchantment - S0${native.season}E0${native.episode}`, tvdb_id: TVDB_ID, ids: { tvdb: TVDB_ID }, season: native.season, episode: native.episode, itemId: "native-episode" },
      EMBY_CONFIG,
    );
    assert.ok(resolved, "the order translated");
    assert.deepEqual([resolved.season, resolved.episode], [1, 11]);
    assert.equal(resolved.title, "Disenchantment - S01E11");
    assert.deepEqual(resolved.watchProvenance.episode_order, { tvdbId: TVDB_ID, dvdId: 7187957, airedId: 7187957, order });
    const record = { ...resolved, watch_provenance: undefined };
    assert.doesNotThrow(() => assertOrderInsert(record));
    // The same row without the identity is refused: the guard that the provenance rebuild must not defeat.
    assert.throws(() => assertOrderInsert({ ...record, watchProvenance: {} }), /cannot be safely matched/);
  });
}

test("a Netflix order unwatch from a media server is translated as an unwatch", async (t) => {
  seed();
  mockEmbyNativeEpisode(t, { season: 2, episode: 1 });
  const resolved = await resolveOrderMediaForPolling(
    { type: "episode", source: "emby", isValid: true, phase: "unplayed", title: "Disenchantment - S02E01", tvdb_id: TVDB_ID, ids: { tvdb: TVDB_ID }, season: 2, episode: 1, itemId: "native-episode" },
    EMBY_CONFIG,
  );
  assert.deepEqual([resolved.season, resolved.episode], [1, 11]);
  assert.equal(resolved.watchProvenance.episode_order.order, "alternate");
});

test("a live Emby session in the Netflix order becomes one watch stored as the aired episode", async (t) => {
  seed();
  const repo = await import("../server/src/utils/dataRepo.js");
  const { refreshLiveSessions } = await import("../server/src/utils/liveSessionCompletion.js");
  const { createLoopStore } = await import("../server/src/utils/loopStore.js");
  const calls = mockEmbyNativeEpisode(t, { season: 2, episode: 1 });
  const payload = {
    title: "Disenchantment - S02E01", mediaType: "episode", source: "emby", ids: { tvdb: TVDB_ID }, tvdb_id: TVDB_ID,
    season: 2, episode: 1, itemId: "native-episode", progress: 97, offsetMs: 97 * 60_000, durationMs: 100 * 60_000, paused: false, playbackState: "playing",
  };
  await repo.upsertLiveTrackingCache([{
    session_id: "order-live-netflix", title: payload.title, source_platform: "emby", last_progress: 97,
    updated_at: Date.now() - 10_000, completed_at: null, payload_json: JSON.stringify(payload),
  }]);
  const loop = createLoopStore();
  // A session must be missing from two consecutive polls before it counts as stopped.
  await refreshLiveSessions(EMBY_CONFIG, loop);
  await refreshLiveSessions(EMBY_CONFIG, loop);
  const rows = db.prepare("SELECT season,episode,title,watch_provenance FROM watch_history WHERE media_type='episode' AND tvdb_id=?").all(TVDB_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].season, rows[0].episode], [1, 11]);
  assert.equal(JSON.parse(rows[0].watch_provenance).episode_order.order, "alternate");
  assert.equal(JSON.parse(rows[0].watch_provenance).ingest_path, "live_session");
  assert.deepEqual(calls.filter((call) => call.host === "polling-order.test" && call.method !== "GET"), [], "no provider write from the order lookup");
});

test("a live session whose order cannot be proven writes no watch", async (t) => {
  seed();
  const repo = await import("../server/src/utils/dataRepo.js");
  const { refreshLiveSessions } = await import("../server/src/utils/liveSessionCompletion.js");
  const { createLoopStore } = await import("../server/src/utils/loopStore.js");
  mockEmbyNativeEpisode(t, { season: 9, episode: 9 });
  const before = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  const payload = {
    title: "Disenchantment - S02E02", mediaType: "episode", source: "emby", ids: { tvdb: TVDB_ID }, tvdb_id: TVDB_ID,
    season: 2, episode: 2, itemId: "native-episode", progress: 97, offsetMs: 97 * 60_000, durationMs: 100 * 60_000, paused: false, playbackState: "playing",
  };
  await repo.upsertLiveTrackingCache([{
    session_id: "order-live-unproven", title: payload.title, source_platform: "emby", last_progress: 97,
    updated_at: Date.now() - 10_000, completed_at: null, payload_json: JSON.stringify(payload),
  }]);
  const loop = createLoopStore();
  await refreshLiveSessions(EMBY_CONFIG, loop);
  await refreshLiveSessions(EMBY_CONFIG, loop);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, before);
});
