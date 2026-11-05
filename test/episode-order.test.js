import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-test-");

const { db, toJson } = await import("../server/src/db.js");
const {
  changeEpisodeOrder,
  dvdToAired,
  episodeOrderSeason,
  episodeOrderState,
  readEpisodeOrder,
  orderLinks,
} = await import("../server/src/utils/episodeOrder.js");
const { preflightOrderRecords } = await import("../server/src/utils/episodeOrderWatch.js");
const { saveTrackerConnection, deleteTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { normalizeWatchRecordForInsert } = await import("../server/src/utils/dataRepo.js");

const TVDB_ID = "73871"; // Futurama; synthetic leaf IDs below isolate unit scenarios.
const SERIES_ID = Number(TVDB_ID);
const OFFICIAL_2101 = 761582101;
const OFFICIAL_110 = 761580110;
const DVD_110 = 761581110;
const DVD_2101 = 7615821010;

function episode(id, season, number, name) {
  return {
    id, seriesId: SERIES_ID, season, episode: number, name,
    air_date: "2002-03-28", overview: `${name} synopsis`, still_path: "/episode.jpg", runtime: 22,
  };
}

const fixture = {
  tvdbId: SERIES_ID,
  orders: {
    official: [
      episode(OFFICIAL_2101, 2, 1, "Aired episode 2.1"),
      episode(OFFICIAL_110, 1, 10, "Aired episode 1.10"),
    ],
    dvd: [
      episode(DVD_110, 1, 10, "DVD episode 1.10"),
      episode(DVD_2101, 2, 1, "DVD episode 2.1"),
    ],
  },
  fetchedAt: Date.now() + 60 * 60 * 1000,
};

function seedCatalogue(catalogue = fixture) {
  db.prepare(`INSERT OR REPLACE INTO tvdb_metadata_cache
    (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)`)
    .run(`order_catalogue_v4_${TVDB_ID}`, TVDB_ID, "Futurama", toJson(catalogue), catalogue.fetchedAt);
}

function saveMapping(dvdId, airedId, opts = {}) {
  return episodeOrderState(TVDB_ID).then((current) => changeEpisodeOrder(TVDB_ID, {
    tvdbId: TVDB_ID, revision: current.revision, confirm: true, dvdId, airedId, ...opts,
  }, "POST"));
}

async function setOrder(order) {
  const current = await episodeOrderState(TVDB_ID);
  return changeEpisodeOrder(TVDB_ID, { tvdbId: TVDB_ID, revision: current.revision, confirm: true, order }, "POST");
}

function saveRaw(data) {
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run(`episode-order:v1:${TVDB_ID}`, toJson(data), Date.now());
}

test.after(() => db.close());

test("Futurama DVD S01E10 can be explicitly mapped to aired S02E01 within the same TVDB series", async () => {
  seedCatalogue();
  saveRaw({ order: "official", mappings: [] });
  const saved = await saveMapping(DVD_110, OFFICIAL_2101);
  assert.deepEqual(saved.links.find((link) => link.dvdId === DVD_110), {
    dvdId: DVD_110, airedId: OFFICIAL_2101, manual: true,
  });
  const resolved = await dvdToAired(TVDB_ID, 1, 10);
  assert.deepEqual([resolved.dvd.season, resolved.dvd.episode], [1, 10]);
  assert.deepEqual([resolved.aired.season, resolved.aired.episode], [2, 1]);
  assert.equal(resolved.aired.seriesId, SERIES_ID);
});

test("an episode coordinate absent from the verified DVD catalogue is blocked", async () => {
  seedCatalogue();
  saveRaw({ order: "dvd", mappings: [] });
  await assert.rejects(dvdToAired(TVDB_ID, 9, 9), /cannot be safely matched/);
});

test("manual mapping saves require both an explicit confirmation and the current revision", async () => {
  seedCatalogue();
  saveRaw({ order: "official", mappings: [] });
  const current = await episodeOrderState(TVDB_ID);
  await assert.rejects(changeEpisodeOrder(TVDB_ID, {
    revision: current.revision, dvdId: DVD_110, airedId: OFFICIAL_2101,
  }, "POST"), /changed|preview/);
  await assert.rejects(changeEpisodeOrder(TVDB_ID, {
    revision: "stale", confirm: true, dvdId: DVD_110, airedId: OFFICIAL_2101,
  }, "POST"), /changed|preview/);
  assert.deepEqual(readEpisodeOrder(TVDB_ID).mappings, []);
});

test("a second DVD episode cannot be mapped to an aired episode already in use", async () => {
  const withAnotherDvd = structuredClone(fixture);
  withAnotherDvd.orders.dvd.push(episode(761581111, 1, 11, "DVD episode 1.11"));
  seedCatalogue(withAnotherDvd);
  saveRaw({ order: "official", mappings: [] });
  await saveMapping(DVD_110, OFFICIAL_2101);
  const current = await episodeOrderState(TVDB_ID);
  await assert.rejects(changeEpisodeOrder(TVDB_ID, {
    revision: current.revision, confirm: true, dvdId: 761581111, airedId: OFFICIAL_2101,
  }, "POST"), /already maps/);
  assert.equal(readEpisodeOrder(TVDB_ID).mappings.length, 1);
});

test("removing a manual mapping restores an automatic shared-id link, or leaves an unresolved DVD episode", async () => {
  const withSharedId = structuredClone(fixture);
  withSharedId.orders.official.push(episode(DVD_2101, 9, 1, "Aired shared-id episode"));
  seedCatalogue(withSharedId);
  saveRaw({ order: "official", mappings: [] });
  await saveMapping(DVD_2101, OFFICIAL_110);
  let current = await episodeOrderState(TVDB_ID);
  await changeEpisodeOrder(TVDB_ID, {
    revision: current.revision, confirm: true, dvdId: DVD_2101,
  }, "DELETE");
  current = await episodeOrderState(TVDB_ID);
  assert.deepEqual(current.links.find((link) => link.dvdId === DVD_2101), {
    dvdId: DVD_2101, airedId: DVD_2101, manual: false,
  });
  assert.deepEqual([withSharedId.orders.official.at(-1).season, withSharedId.orders.official.at(-1).episode], [9, 1]);

  seedCatalogue();
  saveRaw({ order: "official", mappings: [] });
  await saveMapping(DVD_110, OFFICIAL_2101);
  current = await episodeOrderState(TVDB_ID);
  await changeEpisodeOrder(TVDB_ID, {
    revision: current.revision, confirm: true, dvdId: DVD_110,
  }, "DELETE");
  assert.equal((await episodeOrderState(TVDB_ID)).links.some((link) => link.dvdId === DVD_110), false);
});

test("a provider signature change invalidates a previously confirmed mapping", async () => {
  seedCatalogue();
  saveRaw({ order: "official", mappings: [] });
  await saveMapping(DVD_110, OFFICIAL_2101);
  const changed = structuredClone(fixture);
  changed.orders.dvd[0].name = "Provider changed this episode identity";
  changed.fetchedAt = Date.now() + 2 * 60 * 60 * 1000;
  seedCatalogue(changed);
  assert.equal((await episodeOrderState(TVDB_ID)).links.some((link) => link.dvdId === DVD_110), false);
  await assert.rejects(dvdToAired(TVDB_ID, 1, 10), /cannot be safely matched/);
});

test("an unavailable DVD catalogue does not silently replace the saved order preference", async () => {
  seedCatalogue();
  saveRaw({ order: "official", mappings: [] });
  await setOrder("dvd");
  const unavailable = structuredClone(fixture);
  unavailable.orders.dvd = [];
  unavailable.fetchedAt = Date.now() + 2 * 60 * 60 * 1000;
  seedCatalogue(unavailable);
  const current = await episodeOrderState(TVDB_ID);
  assert.equal(current.order, "dvd");
  assert.equal(current.available.dvd, false);
  await assert.rejects(episodeOrderSeason({ tvdbId: TVDB_ID, seasonNumber: 1 }), /metadata is unavailable/);
  assert.equal(readEpisodeOrder(TVDB_ID).order, "dvd");
});

test("watch normalization preserves verified episode-order provenance", async () => {
  seedCatalogue();
  saveRaw({ order: "dvd", mappings: [] });
  await saveMapping(DVD_110, OFFICIAL_2101);
  // Insert-time validation currently reads the original cache key; seed it as
  // well so this test isolates normalization and provenance preservation.
  const identity = { tvdbId: TVDB_ID, dvdId: DVD_110, airedId: OFFICIAL_2101 };
  const { record, data } = normalizeWatchRecordForInsert({
    type: "episode", title: "Futurama - S02E01 - Example", watched_at: "2026-10-01T00:00:00Z",
    source: "manual", tvdb_id: TVDB_ID, season: 2, episode: 1,
    watch_provenance: { source: "manual", episode_order: identity },
  });
  assert.deepEqual(record.watch_provenance.episode_order, identity);
  assert.deepEqual(JSON.parse(data.watch_provenance).episode_order, identity);
});

test("batch preflight failure leaves watch history and tracker write intents untouched", async () => {
  seedCatalogue();
  saveRaw({ order: "dvd", mappings: [] });
  await saveMapping(DVD_110, OFFICIAL_2101);
  const beforeHistory = db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count;
  const beforeIntents = db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents").get().count;
  const records = [
    { type: "episode", tvdb_id: TVDB_ID, season: 1, episode: 10, numbering_source: "dvd", title: "Futurama - S01E10", watched_at: "2026-10-01T00:00:00Z" },
    { type: "episode", tvdb_id: TVDB_ID, season: 9, episode: 9, numbering_source: "dvd", title: "Futurama - S09E09", watched_at: "2026-10-02T00:00:00Z" },
  ];
  await assert.rejects(preflightOrderRecords(records, {}), /cannot be safely matched/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, beforeHistory);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_write_intents").get().count, beforeIntents);
});

test("captured TVDB Futurama identity links DVD S01E10 to aired S02E01 automatically", () => {
  // Read-only provider capture, 2 November 2026: /v4/series/73871/episodes/{official|dvd}.
  const aired = {id:131183,seriesId:73871,season:2,episode:1,name:"A Flight to Remember"};
  const dvd = {...aired,season:1,episode:10};
  assert.deepEqual(orderLinks({orders:{official:[aired],dvd:[dvd]}},{mappings:[]}),[{dvdId:131183,airedId:131183,manual:false}]);
});

test("returning to Aired preserves the existing TVDB or TMDB source choice", async () => {
  const {setShowSeasonSource,readShowNumbering} = await import("../server/src/utils/seasonSource.js");
  seedCatalogue(); saveRaw({order:"official",mappings:[]});
  for (const source of ["tvdb","tmdb"]) {
    setShowSeasonSource(TVDB_ID,source,{rowNumbering:source});
    const before = readShowNumbering(TVDB_ID);
    await setOrder("dvd");
    assert.equal((await episodeOrderSeason({tvdbId:TVDB_ID,seasonNumber:1})).episode_order,"dvd");
    await setOrder("official");
    assert.equal(await episodeOrderSeason({tvdbId:TVDB_ID,seasonNumber:1}),null);
    assert.deepEqual(readShowNumbering(TVDB_ID),before);
  }
});

test("DVD inputs without a series identity and unexpanded container actions fail closed", async () => {
  saveRaw({order:"dvd",mappings:[]});
  await assert.rejects(preflightOrderRecords([{media_type:"Episode",numbering_source:"dvd",season:1,episode:10}],{}),/TVDB show identity/);
  await assert.rejects(preflightOrderRecords([{media_type:"TV",tvdbId:TVDB_ID}],{}),/Expand this show or season/);
});

// Issue #55: Disenchantment's TVDB "Parts Order (Netflix)" is season type
// `alternate`. Its episodes share their IDs with the aired order but use other
// season and episode numbers (alternate S5E7 is aired S3E7).
const NETFLIX = (() => {
  const aired = [episode(9934185, 3, 7, "Aired 3.7"), episode(9934186, 3, 8, "Aired 3.8")];
  const alternate = [episode(9934185, 5, 7, "Aired 3.7"), episode(9934186, 5, 8, "Aired 3.8")];
  return { tvdbId: SERIES_ID, orders: { official: aired, dvd: [], absolute: [], alternate, regional: [], altdvd: [], alttwo: [] }, labels: { alternate: "Parts Order (Netflix)" }, fetchedAt: Date.now() + 60 * 60 * 1000 };
})();

test("an alternate order such as the Netflix parts order resolves to aired episodes by shared ID", async () => {
  seedCatalogue(NETFLIX);
  saveRaw({ order: "official", mappings: [] });
  const before = await episodeOrderState(TVDB_ID);
  assert.equal(before.available.alternate, true);
  assert.equal(before.available.dvd, false);
  assert.equal(before.labels.alternate, "Parts Order (Netflix)");
  assert.equal(before.linkOrder, "alternate");
  // The dialog previews an order's episodes before it is chosen.
  assert.deepEqual(before.linksByOrder.alternate.map((link) => [link.dvdId, link.airedId, link.manual]), [[9934185, 9934185, false], [9934186, 9934186, false]]);
  assert.equal(before.linksByOrder.dvd, undefined);
  const state = await setOrder("alternate");
  assert.equal(state.order, "alternate");
  assert.deepEqual(state.links.map((link) => [link.dvdId, link.airedId]), [[9934185, 9934185], [9934186, 9934186]]);
  const season = await episodeOrderSeason({ tvdbId: TVDB_ID, seasonNumber: 5 });
  assert.equal(season.episode_order, "alternate");
  assert.deepEqual(season.episodes.map((e) => e.episode_number), [7, 8]);
  const { aired, dvd } = await dvdToAired(TVDB_ID, 5, 7, "alternate");
  assert.deepEqual([dvd.id, aired.season, aired.episode], [9934185, 3, 7]);
  await assert.rejects(dvdToAired(TVDB_ID, 3, 7, "alternate"), /cannot be safely matched/);
});

test("a connected Simkl account needs an acknowledgement before a non-Aired order is saved", async () => {
  seedCatalogue(NETFLIX);
  saveRaw({ order: "official", mappings: [] });
  try {
    assert.equal((await episodeOrderState(TVDB_ID)).simklConnected, false);
    saveTrackerConnection({ provider: "simkl", accessToken: "test-access", refreshToken: "test-refresh", remoteUserId: "1", clientId: "test-client" });
    const current = await episodeOrderState(TVDB_ID);
    assert.equal(current.simklConnected, true);
    const body = { tvdbId: TVDB_ID, revision: current.revision, confirm: true, order: "alternate" };
    await assert.rejects(changeEpisodeOrder(TVDB_ID, body, "POST"), /Simkl does not support this order/);
    await assert.rejects(changeEpisodeOrder(TVDB_ID, { ...body, acknowledgeSimkl: "yes" }, "POST"), /Simkl does not support this order/);
    assert.equal(readEpisodeOrder(TVDB_ID).order, "official");
    assert.equal((await changeEpisodeOrder(TVDB_ID, { ...body, acknowledgeSimkl: true }, "POST")).order, "alternate");
    // Returning to Aired never needs it.
    const back = await episodeOrderState(TVDB_ID);
    assert.equal((await changeEpisodeOrder(TVDB_ID, { tvdbId: TVDB_ID, revision: back.revision, confirm: true, order: "official" }, "POST")).order, "official");
  } finally {
    deleteTrackerConnection("simkl");
  }
});

test("a mapping saved for an alternate order is stored with that order and never applies to DVD", async () => {
  seedCatalogue(NETFLIX);
  saveRaw({ order: "alternate", mappings: [] });
  const current = await episodeOrderState(TVDB_ID);
  const saved = await changeEpisodeOrder(TVDB_ID, { tvdbId: TVDB_ID, revision: current.revision, confirm: true, linkOrder: "alternate", dvdId: 9934185, airedId: 9934185 }, "POST");
  assert.deepEqual(saved.mappings.map((m) => m.order), ["alternate"]);
  assert.equal(readEpisodeOrder(TVDB_ID).mappings[0].order, "alternate");
  assert.deepEqual(orderLinks(NETFLIX, readEpisodeOrder(TVDB_ID), "dvd"), []);
  // Mappings written before alternate orders existed carry no order and stay DVD.
  saveRaw({ order: "official", mappings: [{ dvdId: 5, airedId: 6, signature: "x" }] });
  assert.equal(readEpisodeOrder(TVDB_ID).mappings[0].order, "dvd");
});
