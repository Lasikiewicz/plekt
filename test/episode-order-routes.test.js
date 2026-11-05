import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-routes-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { getTvdbOrderCatalogue, getCachedTvdbOrderCatalogue } = await import("../server/src/utils/tvdbOrderGateway.js");
const { readEpisodeOrder } = await import("../server/src/utils/episodeOrder.js");
const { handleEpisodeOrder, handleEpisodeOrderPreflight } = await import("../server/src/routes/episodeOrder.js");
const { handleManualWatch, handleManualUnwatch } = await import("../server/src/routes/sync.js");
const { handleBackupExport, handleBackupImport } = await import("../server/src/routes/backups.js");
const { BACKUP_FORMAT, BACKUP_VERSION } = await import("../server/src/utils/backup.js");

const SHOW_ID = "780001";
const EMPTY_DVD_SHOW_ID = "780002";
const SETTING_ID = `episode-order:v1:${SHOW_ID}`;

function requestResponse({ method = "GET", body = null, query = {}, authenticated = true, headers: extraHeaders = {} } = {}) {
  const headers = { ...(authenticated ? { "x-api-key": AUTH.apiKey } : {}), ...extraHeaders };
  let statusCode = 200;
  let responseBody = null;
  return {
    req: {
      method,
      body,
      query,
      headers,
      cookies: {},
      get(name) { return headers[String(name).toLowerCase()] || headers[name] || ""; },
    },
    res: {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(payload) { responseBody = typeof payload === "string" && payload ? JSON.parse(payload) : payload; return this; },
    },
    status: () => statusCode,
    body: () => responseBody,
  };
}

function clearFeatureData() {
  db.prepare("DELETE FROM tracker_write_intents").run();
  db.prepare("DELETE FROM tracker_connections").run();
  db.prepare("DELETE FROM sync_history").run();
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'episode-order:v1:%'").run();
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id LIKE 'order_catalogue_v%'").run();
}

async function seedCatalogue(tvdbId, { dvdAvailable = true, officialEntries = null, dvdEntries = null } = {}) {
  const id = String(tvdbId);
  const official = officialEntries || [
    { id: Number(id) * 10 + 1, seriesId: Number(id), seasonNumber: 1, number: 1, name: "Aired One", aired: "2020-01-01" },
    { id: Number(id) * 10 + 2, seriesId: Number(id), seasonNumber: 1, number: 2, name: "Aired Two", aired: "2020-01-08" },
  ];
  const dvd = dvdEntries || (dvdAvailable
    ? [
      { id: Number(id) * 10 + 101, seriesId: Number(id), seasonNumber: 1, number: 1, name: "DVD One", aired: "2020-01-01" },
      { id: Number(id) * 10 + 102, seriesId: Number(id), seasonNumber: 1, number: 2, name: "DVD Two", aired: "2020-01-08" },
    ]
    : []);
  await getTvdbOrderCatalogue(id, {
    force: true,
    loadSeries: async (seriesId) => ({
      id: Number(seriesId),
      name: `Fixture Show ${seriesId}`,
      seasons: [
        { type: { type: "official" } },
        ...(dvdAvailable ? [{ type: { type: "dvd" } }] : []),
      ],
    }),
    loadEndpoint: async (path) => {
      if (path === "/seasons/types") {
        return { data: [{ id: 1, type: "official" }, { id: 2, type: "dvd" }] };
      }
      const order = path.replace(/\/eng$/, "").split("/").at(-1);
      const episodes = order === "official" ? official : order === "dvd" ? dvd : null;
      assert.ok(episodes, `unexpected TVDB fixture path: ${path}`);
      return { data: { episodes, links: { next: null }, meta: { totalItems: episodes.length, totalPages: 1 } } };
    },
  });
  return { official, dvd };
}

async function getOrder(tvdbId = SHOW_ID, authenticated = true) {
  const http = requestResponse({ query: { tvdbId }, authenticated });
  await handleEpisodeOrder(http.req, http.res);
  return http;
}

async function saveOrder(tvdbId, body, method = "POST", authenticated = true) {
  const http = requestResponse({ method, body: { tvdbId, ...body }, authenticated });
  await handleEpisodeOrder(http.req, http.res);
  return http;
}

async function selectDvd(tvdbId = SHOW_ID) {
  const current = await getOrder(tvdbId);
  assert.equal(current.status(), 200, JSON.stringify(current.body()));
  const saved = await saveOrder(tvdbId, { confirm: true, revision: current.body().revision, order: "dvd" });
  assert.equal(saved.status(), 200, JSON.stringify(saved.body()));
  return saved.body();
}

async function mapAndSelectDvd(tvdbId, dvdId, airedId) {
  const current = await getOrder(tvdbId);
  assert.equal(current.status(), 200, JSON.stringify(current.body()));
  const mapped = await saveOrder(tvdbId, { confirm: true, revision: current.body().revision, dvdId, airedId });
  assert.equal(mapped.status(), 200, JSON.stringify(mapped.body()));
  const selected = await saveOrder(tvdbId, { confirm: true, revision: mapped.body().revision, order: "dvd" });
  assert.equal(selected.status(), 200, JSON.stringify(selected.body()));
  return selected.body();
}

async function disableMediaServers() {
  await saveMediaConfig({
    plex: { disabled: true, authMode: "manual" },
    emby: { disabled: true, authMode: "manual" },
    jellyfin: { disabled: true, authMode: "manual" },
  });
}

async function withoutOutbound(action) {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("Unexpected network request in isolated route test");
  };
  try {
    const result = await action();
    assert.equal(calls, 0, "route must use the seeded catalogue and avoid upstream metadata/provider requests");
    return result;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test.beforeEach(async () => {
  clearFeatureData();
  await disableMediaServers();
});

test("episode-order and manual watch/unwatch endpoints reject unauthenticated requests", async () => {
  await seedCatalogue(SHOW_ID);
  const get = await getOrder(SHOW_ID, false);
  assert.equal(get.status(), 401);

  const watch = requestResponse({ method: "POST", body: { records: [] }, authenticated: false });
  await handleManualWatch(watch.req, watch.res);
  assert.equal(watch.status(), 401);

  const unwatch = requestResponse({ method: "POST", body: { ids: ["missing"] }, authenticated: false });
  await handleManualUnwatch(unwatch.req, unwatch.res);
  assert.equal(unwatch.status(), 401);
});

test("stale revision and unavailable DVD selection leave preferences unchanged", async () => {
  await seedCatalogue(SHOW_ID);
  const before = await getOrder(SHOW_ID);
  const stale = await saveOrder(SHOW_ID, { confirm: true, revision: "stale-revision", order: "dvd" });
  assert.equal(stale.status(), 409);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE id=?").get(SETTING_ID), undefined);
  assert.deepEqual(readEpisodeOrder(SHOW_ID), { order: "official", mappings: [] });

  await seedCatalogue(EMPTY_DVD_SHOW_ID, { dvdAvailable: false });
  const emptyBefore = await getOrder(EMPTY_DVD_SHOW_ID);
  assert.equal(emptyBefore.body().available.dvd, false);
  const unavailable = await saveOrder(EMPTY_DVD_SHOW_ID, {
    confirm: true,
    revision: emptyBefore.body().revision,
    order: "dvd",
  });
  assert.equal(unavailable.status(), 409);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE id=?").get(`episode-order:v1:${EMPTY_DVD_SHOW_ID}`), undefined);
  assert.deepEqual(readEpisodeOrder(EMPTY_DVD_SHOW_ID), { order: "official", mappings: [] });
  assert.equal(before.status(), 200);
});

test("mixed manual-watch batch with invalid DVD episode is rejected before any mutation", async () => {
  const { dvd } = await seedCatalogue(SHOW_ID);
  await selectDvd(SHOW_ID);
  assert.ok(dvd.length);

  const http = await withoutOutbound(async () => {
    const request = requestResponse({
      method: "POST",
      body: {
        records: [
          { media_type: "movie", title: "Valid first movie", tmdb_id: "movie-123", watched_at: "2026-10-20T12:00:00.000Z" },
          { media_type: "episode", title: "Fixture Show - S09E99", tvdb_id: SHOW_ID, season: 9, episode: 99,
            numbering_source: "dvd", watched_at: "2026-10-20T12:00:00.000Z" },
        ],
      },
    });
    await handleManualWatch(request.req, request.res);
    return request;
  });
  assert.equal(http.status(), 409, JSON.stringify(http.body()));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playstate").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents").get().count, 0);
});

test("manual-unwatch batch with missing DVD identity is rejected before the first mutation", async () => {
  await seedCatalogue(SHOW_ID);
  await selectDvd(SHOW_ID);
  const recordId = "legacy-unmapped-dvd-watch";
  db.prepare(`INSERT INTO watch_history
    (id,title,title_lower,media_type,watched_at,source,tvdb_id,season,episode,sync_action,watch_provenance,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    recordId, "Fixture Show - S01E01", "fixture show - s01e01", "episode", "2026-10-20T12:00:00.000Z",
    "manual", SHOW_ID, 1, 1, "watched", null, Date.now(), Date.now(),
  );
  db.prepare(`INSERT INTO playstate
    (media_key,title,title_lower,media_type,state,watched_at,last_source,tvdb_id,season,episode,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    `tvdb:${SHOW_ID}:s1e1`, "Fixture Show - S01E01", "fixture show - s01e01", "episode", "watched",
    "2026-10-20T12:00:00.000Z", "manual", SHOW_ID, 1, 1, Date.now(),
  );
  const priorSyncHistory = db.prepare("SELECT COUNT(*) AS count FROM sync_history").get().count;

  const http = await withoutOutbound(async () => {
    const request = requestResponse({ method: "POST", body: { ids: [recordId] } });
    await handleManualUnwatch(request.req, request.res);
    return request;
  });
  assert.equal(http.status(), 409, JSON.stringify(http.body()));
  assert.ok(db.prepare("SELECT 1 FROM watch_history WHERE id=?").get(recordId));
  assert.equal(db.prepare("SELECT state FROM playstate").get().state, "watched");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_history").get().count, priorSyncHistory);
});

test("manual watch and unwatch preserve a verified DVD episode across aired-order storage", async () => {
  const airedOneId = Number(SHOW_ID) * 10 + 1;
  const dvdTenId = Number(SHOW_ID) * 10 + 101;
  const officialEntries = [
    { id: airedOneId, seriesId: Number(SHOW_ID), seasonNumber: 2, number: 1, name: "Aired Two One", aired: "2020-01-01" },
    { id: airedOneId + 1, seriesId: Number(SHOW_ID), seasonNumber: 2, number: 2, name: "Aired Two Two", aired: "2020-01-08" },
  ];
  const dvdEntries = [
    { id: dvdTenId, seriesId: Number(SHOW_ID), seasonNumber: 1, number: 10, name: "DVD One Ten", aired: "2020-01-01" },
    { id: dvdTenId + 1, seriesId: Number(SHOW_ID), seasonNumber: 1, number: 11, name: "DVD One Eleven", aired: "2020-01-08" },
  ];
  await seedCatalogue(SHOW_ID, { officialEntries, dvdEntries });
  await mapAndSelectDvd(SHOW_ID, dvdTenId, airedOneId);

  const watch = await withoutOutbound(async () => {
    const request = requestResponse({
      method: "POST",
      body: {
        records: [
          { media_type: "episode", title: `tvdb://${SHOW_ID} - S01E10`, tvdb_id: SHOW_ID, season: 1, episode: 10,
            numbering_source: "dvd", watched_at: "2026-10-21T12:00:00.000Z" },
          { media_type: "movie", title: "Second batch item", tmdb_id: "movie-batch-item", watched_at: "2026-10-21T12:00:00.000Z" },
        ],
      },
    });
    await handleManualWatch(request.req, request.res);
    return request;
  });
  assert.equal(watch.status(), 200, JSON.stringify(watch.body()));
  const storedEpisode = db.prepare("SELECT * FROM watch_history WHERE tvdb_id=? AND media_type='episode' AND sync_action='watched'").get(SHOW_ID);
  assert.ok(storedEpisode);
  assert.equal(storedEpisode.season, 2);
  assert.equal(storedEpisode.episode, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE tvdb_id=? AND season=1 AND episode=10").get(SHOW_ID).count, 0);
  const storedProvenance = JSON.parse(storedEpisode.watch_provenance);
  assert.deepEqual(storedProvenance.episode_order, { tvdbId: SHOW_ID, dvdId: dvdTenId, airedId: airedOneId, order: "dvd" });
  assert.equal(db.prepare("SELECT state FROM playstate WHERE tvdb_id=? AND media_type='episode'").get(SHOW_ID).state, "watched");

  const unwatch = await withoutOutbound(async () => {
    const request = requestResponse({ method: "POST", body: { ids: [storedEpisode.id] } });
    await handleManualUnwatch(request.req, request.res);
    return request;
  });
  assert.equal(unwatch.status(), 200, JSON.stringify(unwatch.body()));
  const tombstone = db.prepare("SELECT * FROM watch_history WHERE tvdb_id=? AND media_type='episode'").get(SHOW_ID);
  assert.ok(tombstone);
  assert.equal(tombstone.sync_action, "unwatched");
  assert.equal(tombstone.season, 2);
  assert.equal(tombstone.episode, 1);
  assert.deepEqual(JSON.parse(tombstone.watch_provenance).episode_order, {
    tvdbId: SHOW_ID, dvdId: dvdTenId, airedId: airedOneId, order: "dvd",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE tvdb_id=? AND season=1 AND episode=10").get(SHOW_ID).count, 0);
  assert.equal(db.prepare("SELECT state FROM playstate WHERE tvdb_id=? AND media_type='episode'").get(SHOW_ID).state, "unwatched");
});

test("episode-order preflight accepts more than 100 IDs and rejects a later invalid row without mutation", async () => {
  const airedId = Number(SHOW_ID) * 10 + 1;
  const dvdId = Number(SHOW_ID) * 10 + 101;
  await seedCatalogue(SHOW_ID, {
    officialEntries: [{ id: airedId, seriesId: Number(SHOW_ID), seasonNumber: 2, number: 1, name: "Aired Two One", aired: "2020-01-01" }],
    dvdEntries: [{ id: dvdId, seriesId: Number(SHOW_ID), seasonNumber: 1, number: 10, name: "DVD One Ten", aired: "2020-01-01" }],
  });
  await mapAndSelectDvd(SHOW_ID, dvdId, airedId);

  const insert = db.prepare(`INSERT INTO watch_history
    (id,title,title_lower,media_type,watched_at,source,tvdb_id,season,episode,sync_action,watch_provenance,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  for (let index = 0; index < 101; index += 1) {
    const id = `valid-preflight-${index}`;
    ids.push(id);
    insert.run(id, "Fixture Show - S02E01", "fixture show - s02e01", "episode", "2026-10-21T12:00:00.000Z",
      "manual", SHOW_ID, 2, 1, "watched", JSON.stringify({ episode_order: { tvdbId: SHOW_ID, dvdId, airedId } }), Date.now(), Date.now());
  }
  const valid = await withoutOutbound(async () => {
    const request = requestResponse({ method: "POST", body: { ids } });
    await handleEpisodeOrderPreflight(request.req, request.res);
    return request;
  });
  assert.equal(valid.status(), 200, JSON.stringify(valid.body()));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 101);

  const invalidId = "late-invalid-preflight";
  insert.run(invalidId, "Fixture Show - S02E01", "fixture show - s02e01", "episode", "2026-10-21T12:00:00.000Z",
    "manual", SHOW_ID, 2, 1, "watched", null, Date.now(), Date.now());
  const rejected = await withoutOutbound(async () => {
    const request = requestResponse({ method: "POST", body: { ids: [...ids, invalidId] } });
    await handleEpisodeOrderPreflight(request.req, request.res);
    return request;
  });
  assert.equal(rejected.status(), 409, JSON.stringify(rejected.body()));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 102);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE sync_action!='watched'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents").get().count, 0);
});

test("portable settings backup restores DVD preference and mappings, then invalidates catalogue cache", async () => {
  const { official, dvd } = await seedCatalogue(SHOW_ID);
  const initial = await getOrder(SHOW_ID);
  const mapping = await saveOrder(SHOW_ID, {
    confirm: true,
    revision: initial.body().revision,
    dvdId: dvd[0].id,
    airedId: official[1].id,
  });
  assert.equal(mapping.status(), 200, JSON.stringify(mapping.body()));
  const selected = await saveOrder(SHOW_ID, {
    confirm: true,
    revision: mapping.body().revision,
    order: "dvd",
  });
  assert.equal(selected.status(), 200, JSON.stringify(selected.body()));
  const selectedPreference = readEpisodeOrder(SHOW_ID);
  assert.equal(selectedPreference.order, "dvd");
  assert.equal(selectedPreference.mappings.length, 1);
  assert.equal(selectedPreference.mappings[0].dvdId, dvd[0].id);
  assert.equal(selectedPreference.mappings[0].airedId, official[1].id);
  assert.equal(typeof selectedPreference.mappings[0].signature, "string");
  assert.equal(Number.isFinite(selectedPreference.mappings[0].confirmedAt), true);

  const exportRequest = requestResponse({ query: { collection: "settings" } });
  await handleBackupExport(exportRequest.req, exportRequest.res);
  assert.equal(exportRequest.status(), 200, JSON.stringify(exportRequest.body()));
  const settingDocument = exportRequest.body().documents.find((document) => document.id === SETTING_ID);
  assert.ok(settingDocument);
  assert.equal(settingDocument.data.order, "dvd");
  assert.equal(settingDocument.data.mappings[0].dvdId, dvd[0].id);

  db.prepare("DELETE FROM settings WHERE id=?").run(SETTING_ID);
  assert.deepEqual(readEpisodeOrder(SHOW_ID), { order: "official", mappings: [] });
  assert.ok(getCachedTvdbOrderCatalogue(SHOW_ID));

  const importRequest = requestResponse({
    method: "POST",
    body: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      collection: "settings",
      documents: [settingDocument],
      portable: true,
      reset: false,
    },
  });
  await handleBackupImport(importRequest.req, importRequest.res);
  assert.equal(importRequest.status(), 200, JSON.stringify(importRequest.body()));
  assert.deepEqual(readEpisodeOrder(SHOW_ID), {
    order: "dvd",
    mappings: [{ order: "dvd", dvdId: dvd[0].id, airedId: official[1].id, signature: settingDocument.data.mappings[0].signature,
      confirmedAt: settingDocument.data.mappings[0].confirmedAt }],
  });
  assert.equal(getCachedTvdbOrderCatalogue(SHOW_ID), null);
});

test.after(() => db.close());
