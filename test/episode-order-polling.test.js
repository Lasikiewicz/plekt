import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-polling-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db, toJson } = await import("../server/src/db.js");
const { assertOrderInsert } = await import("../server/src/utils/episodeOrder.js");
const { keepOrderProvenance, resolveOrderMediaForPolling } = await import("../server/src/utils/episodeOrderWatch.js");
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

function seed() {
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)")
    .run(`order_catalogue_v4_${TVDB_ID}`, TVDB_ID, "Disenchantment", toJson(catalogue), catalogue.fetchedAt);
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run(`episode-order:v1:${TVDB_ID}`, toJson({ order: "alternate", mappings: [] }), Date.now());
  setShowSeasonSource(TVDB_ID, "tvdb", { rowNumbering: "tvdb" });
}

test.after(() => db.close());

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
