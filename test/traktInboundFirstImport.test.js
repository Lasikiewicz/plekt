import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-trakt-first-import-");
const { db, toJson } = await import("../server/src/db.js");
const { buildTraktInboundTranslator } = await import("../server/src/utils/traktInboundNumbering.js");
const { mediaToWatchRecord } = await import("../server/src/utils/dataRepo.js");
test.after(() => db.close());

test("the first Trakt play uses cached media numbering before a per-show choice or override exists", async () => {
  const dates = ["2000-01-01", "2000-01-08", "2000-01-15"];
  db.prepare("INSERT INTO tvdb_metadata_cache(id,tvdb_id,title,details,updated_at_ms) VALUES(?,?,?,?,?)").run("series_123", "123", "Split", toJson({ id: 123, episodes: dates.map((aired, index) => ({ seasonNumber: index < 2 ? 1 : 2, number: index < 2 ? index + 1 : 1, aired })) }), Date.now());
  db.prepare("INSERT INTO tmdb_metadata_cache(id,tmdb_id,media_type,title,details,updated_at_ms) VALUES(?,?,?,?,?,?)").run("tv_456", "456", "tv", "Split", toJson({ id: 456, name: "Split", external_ids: { tvdb_id: 123 }, seasons: [{ season_number: 1 }] }), Date.now());
  db.prepare("INSERT INTO tmdb_season_cache(id,tmdb_id,season_number,details,updated_at_ms) VALUES(?,?,?,?,?)").run("456_1", "456", 1, toJson({ episodes: dates.map((air_date, index) => ({ episode_number: index + 1, air_date })) }), Date.now());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Inbound catalogue translation must be cache-only"); };
  try {
    const translate = await buildTraktInboundTranslator();
    const media = translate({ type: "episode", title: "Split - S01E03", ids: { tmdb: "456", tvdb: "123" }, season: 1, episode: 3 });
    assert.deepEqual([media.season, media.episode], [2, 1]);
    const record = mediaToWatchRecord(media, "trakt_import");
    assert.deepEqual(record.watch_provenance.provider_overrides.trakt, { tmdb_id: "456", season: 1, episode: 3 });
    assert.equal(db.prepare("SELECT count(*) n FROM show_season_source").get().n, 0);
  } finally { globalThis.fetch = originalFetch; }
});
