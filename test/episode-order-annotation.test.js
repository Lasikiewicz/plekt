import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-annotation-test-");

const { db, toJson } = await import("../server/src/db.js");
const { annotateEpisodeOrder, readEpisodeOrder } = await import("../server/src/utils/episodeOrder.js");

const TVDB_ID = "73871";
const DVD_ID = 500302;
const AIRED_ID = 500304;

test.after(() => db.close());

test("a valid DVD annotation clears an earlier numbering review marker", async () => {
  const catalogue = {
    tvdbId: Number(TVDB_ID),
    fetchedAt: Date.now(),
    labels: { dvd: "DVD order" },
    orders: {
      official: [{ id: AIRED_ID, seriesId: Number(TVDB_ID), season: 3, episode: 4, name: "Canonical episode" }],
      dvd: [{ id: DVD_ID, seriesId: Number(TVDB_ID), season: 3, episode: 2, name: "DVD episode" }],
    },
  };
  db.prepare(`INSERT OR REPLACE INTO tvdb_metadata_cache
    (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)`)
    .run(`order_catalogue_v4_${TVDB_ID}`, TVDB_ID, "Futurama", toJson(catalogue), catalogue.fetchedAt);
  const signature = JSON.stringify([
    DVD_ID, Number(TVDB_ID), 3, 2, "DVD episode",
    AIRED_ID, Number(TVDB_ID), 3, 4, "Canonical episode",
  ]);
  db.prepare("INSERT OR REPLACE INTO settings(id,data,updated_at) VALUES(?,?,?)")
    .run(`episode-order:v1:${TVDB_ID}`, toJson({
      order: "dvd",
      mappings: [{ order: "dvd", dvdId: DVD_ID, airedId: AIRED_ID, signature }],
    }), Date.now());
  assert.equal(readEpisodeOrder(TVDB_ID).order, "dvd");

  const show = {
    tvdb_id: TVDB_ID,
    episodes: [{
      season: 3,
      episode: 4,
      numbering_review: true,
      watch_provenance: { episode_order: { tvdbId: TVDB_ID, dvdId: DVD_ID, airedId: AIRED_ID, order: "dvd" } },
    }, {
      season: 3,
      episode: 5,
      watch_provenance: { episode_order: { tvdbId: TVDB_ID, dvdId: DVD_ID, airedId: AIRED_ID + 1, order: "dvd" } },
    }, {
      season: 3,
      episode: 6,
    }],
  };
  await annotateEpisodeOrder(show);

  assert.deepEqual([show.episodes[0].display_season, show.episodes[0].display_episode], [3, 2]);
  assert.equal(show.episodes[0].numbering_review, undefined);
  for (const row of show.episodes.slice(1)) {
    assert.equal(row.numbering_review, true);
    assert.equal(row.display_episode, undefined);
  }
});
