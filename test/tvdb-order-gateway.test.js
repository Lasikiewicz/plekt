import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-tvdb-order-test-"));
process.env.DATA_DIR = dataDir;
const { normalizeTvdbOrderEpisodes, getTvdbOrderCatalogue } = await import("../server/src/utils/tvdbOrderGateway.js");
const { db, parseJson } = await import("../server/src/db.js");

const ep = (id, seasonNumber, number, extra = {}) => ({
  id, seriesId: 840001, seasonNumber, number, name: `Episode ${number}`, aired: "2024-01-02",
  overview: "Synopsis", image: "/episode.jpg", runtime: 42, ...extra,
});

test("normalizes TVDB identities and rejects duplicate provider ids and coordinates", () => {
  const normalized = normalizeTvdbOrderEpisodes([ep(1, 1, 1)], 840001);
  assert.deepEqual(normalized[0], {
    id: 1, seriesId: 840001, season: 1, episode: 1, name: "Episode 1", air_date: "2024-01-02",
    overview: "Synopsis", still_path: "/episode.jpg", runtime: 42,
  });
  assert.throws(() => normalizeTvdbOrderEpisodes([ep(1, 1, 1), ep(1, 1, 2)], 840001), /colliding/);
  assert.throws(() => normalizeTvdbOrderEpisodes([ep(1, 1, 1), ep(2, 1, 1)], 840001), /colliding/);
  assert.throws(() => normalizeTvdbOrderEpisodes([ep(1, 1, 1, { seriesId: 840002 })], 840001), /invalid episode identity/);
  assert.throws(() => normalizeTvdbOrderEpisodes([{ ...ep(1, 1, 1), seriesId: undefined }], 840001), /invalid episode identity/);
});

test("catalogue retains separate provider orders and caches only a complete success", async () => {
  const tvdbId = 840001;
  const rowId = `order_catalogue_v4_${tvdbId}`;
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  const calls = [];
  const loadEndpoint = async (path, params) => {
    calls.push([path, params]);
    if (path === "/seasons/types") return { data: [
      { id: 1, type: "official", name: "Aired Order" }, { id: 2, type: "dvd", name: "DVD Order" },
    ] };
    const order = path.replace(/\/eng$/, "").split("/").at(-1);
    if (order === "official") return { data: { episodes: [ep(11, 1, 1)] }, links: { next: null } };
    return { data: { episodes: [ep(21, 1, 1, { name: "DVD Episode" })] }, links: { next: null } };
  };
  const forceOptions = [];
  const loadSeries = async (_id, options) => {
    forceOptions.push(options);
    return ({ id: tvdbId, name: "Example", seasons: [
    { number: 1, type: { id: 1, type: "official" } }, { number: 1, type: { id: 2, type: "dvd" } },
  ] });
  };
  try {
    const result = await getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint, loadSeries });
    assert.deepEqual(result.orders.official.map((e) => e.id), [11]);
    assert.deepEqual(result.orders.dvd.map((e) => e.id), [21]);
    assert.deepEqual(forceOptions, [{ force: true }]);
    assert.equal(calls.filter(([path]) => path.includes("/episodes/")).length, 2);
    // Episode titles are requested in English, not TVDB's original language.
    assert.ok(calls.filter(([path]) => path.includes("/episodes/")).every(([path]) => path.endsWith("/eng")));
    assert.deepEqual(await getTvdbOrderCatalogue(tvdbId, { loadEndpoint: async () => { throw new Error("cache miss"); }, loadSeries }), result);
    const stored = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE id = ?").get(rowId);
    assert.equal(parseJson(stored.details).orders.dvd[0].name, "DVD Episode");
  } finally {
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  }
});

test("incomplete pagination and request errors reject without writing a success cache", async () => {
  const tvdbId = 840002;
  const rowId = `order_catalogue_v4_${tvdbId}`;
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  const loadSeries = async () => ({ id: tvdbId, name: "Example", seasons: [{ type: { id: 1, type: "official" } }] });
  const loadEndpoint = async (path, params) => {
    if (path === "/seasons/types") return { data: [{ id: 1, type: "official" }, { id: 2, type: "dvd" }] };
    if (params.page === 0) return { data: { episodes: [ep(31, 1, 1)] }, links: { next: "/next" } };
    throw new Error("page failed");
  };
  try {
    await assert.rejects(getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint, loadSeries }), /page failed/);
    assert.equal(db.prepare("SELECT 1 FROM tvdb_metadata_cache WHERE id = ?").get(rowId), undefined);
  } finally {
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  }
});

test("rejects missing pagination links and a reported total that does not match the list", async () => {
  const tvdbId = 840003;
  const rowId = `order_catalogue_v4_${tvdbId}`;
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  const loadSeries = async () => ({ id: tvdbId, name: "Example", seasons: [{ type: { type: "official" } }] });
  let brokenCount = false;
  const loadEndpoint = async (path) => {
    if (path === "/seasons/types") return { data: [{ id: 1, type: "official" }, { id: 2, type: "dvd" }] };
    return brokenCount
      ? { data: { episodes: [ep(41, 1, 1, { seriesId: tvdbId })] }, links: { next: null }, meta: { totalItems: 2 } }
      : { data: { episodes: [ep(41, 1, 1, { seriesId: tvdbId })] } };
  };
  try {
    await assert.rejects(getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint, loadSeries }), /pagination links/);
    brokenCount = true;
    await assert.rejects(getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint, loadSeries }), /item count was incomplete/);
    assert.equal(db.prepare("SELECT 1 FROM tvdb_metadata_cache WHERE id = ?").get(rowId), undefined);
  } finally {
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
  }
});

test("catalogue loads an alternate order such as the Netflix parts order with TVDB's own name", async () => {
  const tvdbId = 840004;
  const rowId = `order_catalogue_v4_${tvdbId}`;
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id IN (?, 'order_season_types_v1')").run(rowId);
  const requested = [];
  const loadEndpoint = async (path) => {
    if (path === "/seasons/types") return { data: [
      { id: 1, type: "official" }, { id: 2, type: "dvd" }, { id: 4, type: "alternate", name: "Alternate Order" },
    ] };
    const order = path.replace(/\/eng$/, "").split("/").at(-1);
    requested.push(order);
    return { data: { episodes: [ep(order === "official" ? 51 : 52, order === "alternate" ? 5 : 3, 7, { seriesId: tvdbId })] }, links: { next: null } };
  };
  // The series has Aired and the alternate order, but no DVD order.
  const loadSeries = async () => ({ id: tvdbId, name: "Example", seasons: [
    { number: 3, type: { id: 1, type: "official", name: "Aired Order", alternateName: null } },
    { number: 5, type: { id: 4, type: "alternate", name: "Alternate Order", alternateName: "Parts Order (Netflix)" } },
  ] });
  try {
    const result = await getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint, loadSeries });
    assert.deepEqual(requested, ["official", "alternate"]);
    assert.deepEqual(result.orders.alternate.map((e) => [e.id, e.season, e.episode]), [[52, 5, 7]]);
    assert.deepEqual(result.orders.dvd, []);
    assert.equal(result.labels.alternate, "Parts Order (Netflix)");
    assert.deepEqual(await getTvdbOrderCatalogue(tvdbId, { loadEndpoint: async () => { throw new Error("cache miss"); }, loadSeries }), result);
  } finally {
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id IN (?, 'order_season_types_v1')").run(rowId);
  }
});

test("an optional order TVDB sends with colliding episodes is left out without failing Aired or DVD", async () => {
  const tvdbId = 840005;
  const rowId = `order_catalogue_v4_${tvdbId}`;
  db.prepare("DELETE FROM tvdb_metadata_cache WHERE id IN (?, 'order_season_types_v1')").run(rowId);
  const types = { data: [{ id: 1, type: "official" }, { id: 2, type: "dvd" }, { id: 3, type: "absolute" }] };
  const seasons = [{ type: { id: 1, type: "official" } }, { type: { id: 3, type: "absolute" } }];
  const loadSeries = async () => ({ id: tvdbId, name: "Example", seasons });
  const make = (absolute) => async (path) => {
    if (path === "/seasons/types") return types;
    const order = path.replace(/\/eng$/, "").split("/").at(-1);
    if (order === "absolute") return absolute();
    return { data: { episodes: [ep(61, 1, 1, { seriesId: tvdbId })] }, links: { next: null } };
  };
  try {
    const colliding = make(() => ({ data: { episodes: [ep(71, 1, 1, { seriesId: tvdbId }), ep(72, 1, 1, { seriesId: tvdbId })] }, links: { next: null } }));
    const result = await getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint: colliding, loadSeries });
    assert.deepEqual(result.orders.official.map((e) => e.id), [61]);
    assert.deepEqual(result.orders.absolute, []);
    // A failed request is not a bad list: it still rejects and caches nothing.
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id = ?").run(rowId);
    const failing = make(() => { throw new Error("network down"); });
    await assert.rejects(getTvdbOrderCatalogue(tvdbId, { force: true, loadEndpoint: failing, loadSeries }), /network down/);
    assert.equal(db.prepare("SELECT 1 FROM tvdb_metadata_cache WHERE id = ?").get(rowId), undefined);
  } finally {
    db.prepare("DELETE FROM tvdb_metadata_cache WHERE id IN (?, 'order_season_types_v1')").run(rowId);
  }
});
