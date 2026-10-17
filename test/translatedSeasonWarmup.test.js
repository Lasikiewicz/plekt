import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-row-season-warmup-");
const { db } = await import("../server/src/db.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const { translatedRowSeasons, needsTranslatedSeasonWarmup, warmTranslatedRowSeasons } = await import("../server/src/utils/translatedSeasonWarmup.js");
const details = { name: "Naruto", external_ids: { tvdb_id: "78857" } };

test("translated warmup repairs cold row seasons with bounded serial background requests", async () => {
  setShowSeasonSource("78857", "tmdb", { rowNumbering: "tvdb" });
  const insert = db.prepare("INSERT INTO watch_history (id,title,media_type,show_title,season,episode,watched_at) VALUES (?, 'Episode', 'episode', ?, ?, 9, ?)");
  for (let season = 1; season <= 10; season++) insert.run(`watch-${season}`, "Naruto", season, String(season).padStart(2, "0"));
  insert.run("other", "Other show", 30, "99");
  assert.deepEqual(translatedRowSeasons(details), [10, 11, 9]);
  assert.equal(needsTranslatedSeasonWarmup(details), true);
  const requests = [];
  await warmTranslatedRowSeasons(details, { fetchSeason: async (request) => { requests.push(request); } });
  assert.deepEqual(requests.map((request) => request.seasonNumber), [10, 11, 9]);
  assert.ok(requests.every((request) => request.tvdbId === "78857" && request.lane === "enrichment"));
  setShowSeasonSource("78857", "tvdb", { rowNumbering: "tvdb" });
  assert.deepEqual(translatedRowSeasons(details), []);
});

test("real background season warming populates the cache-only Up Next season reader", async () => {
  setShowSeasonSource("78857", "tmdb", { rowNumbering: "tvdb" });
  const episodes = [9, 10, 11].flatMap((seasonNumber) => [9, 10].map((number) => ({ seasonNumber, number, aired: "2003-01-01", name: `Episode ${number}` })));
  db.prepare("INSERT INTO tvdb_metadata_cache (id,tvdb_id,title,details,updated_at_ms) VALUES (?,?,?,?,?)")
    .run("series_78857", "78857", "Naruto", JSON.stringify({ id: 78857, name: "Naruto", episodes, seasons: [], status: { name: "Ended" } }), Date.now());
  const { getCachedTmdbSeason } = await import("../server/src/utils/tmdbGateway.js");
  assert.equal(getCachedTmdbSeason({ tvdbId: "78857", seasonNumber: 10 }), null);
  await warmTranslatedRowSeasons(details);
  assert.deepEqual(getCachedTmdbSeason({ tvdbId: "78857", seasonNumber: 10 }).episodes.map((episode) => episode.episode_number), [9, 10]);
  assert.equal(needsTranslatedSeasonWarmup(details), false);
});

test("active resume seasons outrank older watched seasons and unrelated titles stay excluded", () => {
  db.prepare("INSERT INTO playback_progress (media_key,title,media_type,season,episode,position_ms,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("resume", "Naruto - S02E09 - Episode", "episode", 2, 9, 12000, Date.now());
  assert.deepEqual(translatedRowSeasons(details), [2, 3, 10, 11]);
});
