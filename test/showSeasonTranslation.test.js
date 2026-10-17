import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-show-season-translation-test-");

const { previewShowSeasonSource, annotateShowNumbering, withDisplaySeasons, inRowNumbering, translatedWatchedCount } = await import("../server/src/utils/showSeasonTranslation.js");
const { setShowSeasonSource, readShowNumbering } = await import("../server/src/utils/seasonSource.js");
const { getCachedTmdbSeason } = await import("../server/src/utils/tmdbGateway.js");
const { db, toJson } = await import("../server/src/db.js");

test.after(() => {
  db.close();
});

function day(offset) {
  return new Date(Date.UTC(2002, 9, 3) + offset * 7 * 86400000).toISOString().slice(0, 10);
}

const TVDB_ID = "78857";
const TMDB_ID = "46260";

// TVDB: 3 + 3 episodes. TMDB: one season of 5, missing TVDB S2E3 (no partner).
function seedCaches() {
  const now = Date.now();
  const tvdbEpisodes = [
    ...[1, 2, 3].map((n) => ({ seasonNumber: 1, number: n, aired: day(n - 1) })),
    ...[1, 2, 3].map((n) => ({ seasonNumber: 2, number: n, aired: day(n + 2) })),
  ];
  db.prepare(
    `INSERT OR REPLACE INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)`,
  ).run(`series_${TVDB_ID}`, TVDB_ID, "Split Show", toJson({ id: Number(TVDB_ID), name: "Split Show", status: { name: "Ended" }, episodes: tvdbEpisodes, seasons: [] }), now);
  db.prepare(
    `INSERT OR REPLACE INTO tmdb_season_cache (id, tmdb_id, season_number, show_status, details, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${TMDB_ID}_1`, TMDB_ID, 1, null, toJson({ episodes: [1, 2, 3, 4, 5].map((n) => ({ episode_number: n, air_date: day(n - 1) })) }), now);
}

function showFixture() {
  return {
    title: "Split Show",
    tvdb_id: TVDB_ID,
    tmdb_id: TMDB_ID,
    episodes: [
      { id: "a", season: 1, episode: 2, playHistory: [{ watched_at: "2026-01-01" }, { watched_at: "2026-02-01" }] },
      { id: "b", season: 2, episode: 1, playHistory: [{ watched_at: "2026-01-02" }] },
      { id: "c", season: 2, episode: 3, playHistory: [] },
      { id: "d", season: 2, episode: 2, sync_action: "unwatched" },
    ],
  };
}

test("preview counts episodes and watch rows and lists rows with no partner, without writing", async () => {
  seedCaches();
  const preview = await previewShowSeasonSource({ show: showFixture(), tvdbId: TVDB_ID, tmdbId: TMDB_ID, source: "tmdb" });
  assert.equal(preview.currentSource, "tvdb");
  assert.equal(preview.rowNumbering, "tvdb");
  assert.equal(preview.unchanged, false);
  assert.equal(preview.sourceAvailable, true);
  assert.equal(preview.episodes, 3);
  assert.equal(preview.watchRows, 4);
  assert.equal(preview.translatedEpisodes, 2);
  assert.deepEqual(preview.review, [{ season: 2, episode: 3 }]);
  assert.equal(preview.reviewWatchRows, 1);
  assert.equal(readShowNumbering(TVDB_ID).overriddenAt, null, "preview must not save a choice");
});

test("annotateShowNumbering places every watched row once: translated or marked for review", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const show = await annotateShowNumbering(showFixture());
  const [a, b, c] = show.episodes;
  assert.deepEqual([a.display_season, a.display_episode], [1, 2]);
  assert.deepEqual([b.display_season, b.display_episode], [1, 4]);
  assert.equal(c.numbering_review, true);
  assert.equal(c.display_season, undefined);
  for (const row of show.episodes) {
    assert.ok(row.season > 0 && row.episode > 0, "stored numbers are never changed");
  }
  assert.equal(show.episodes.length, 4, "no row is dropped or added");
  assert.equal(show.season_numbering.ready, true);
});

test("a show without a translated choice is returned unchanged", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tvdb", { rowNumbering: "tvdb" });
  const show = await annotateShowNumbering(showFixture());
  assert.ok(show.episodes.every((row) => row.display_season === undefined && !row.numbering_review));
  assert.equal(show.season_numbering, undefined);
});

test("Up Next season reads follow the stored rows' numbering for a translated show", async () => {
  seedCaches();
  db.prepare(
    `INSERT OR REPLACE INTO tvdb_season_cache (id, tvdb_id, season_number, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)`,
  ).run(`${TVDB_ID}_1`, TVDB_ID, 1, toJson({ episodes: [1, 2, 3].map((n) => ({ number: n, aired: day(n - 1) })) }), Date.now());
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const season = getCachedTmdbSeason({ tmdbId: TMDB_ID, tvdbId: TVDB_ID, seasonNumber: 1 });
  assert.equal(season.episodes.length, 3, "TVDB-numbered rows read TVDB seasons");
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tmdb" });
  assert.equal(getCachedTmdbSeason({ tmdbId: TMDB_ID, tvdbId: TVDB_ID, seasonNumber: 1 }).episodes.length, 5);
});

test("show page details list the display source's own seasons; a TVDB show keeps its list", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const details = { id: TMDB_ID, external_ids: { tvdb_id: TVDB_ID }, seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 3 }], number_of_episodes: 6 };
  const shown = await withDisplaySeasons(details, { cachedOnly: true });
  assert.deepEqual(shown.seasons.map((season) => [season.season_number, season.episode_count]), [[1, 5]]);
  assert.equal(shown.number_of_episodes, 5);
  assert.equal(shown.season_source, "tmdb");
  assert.deepEqual(details.seasons.length, 2, "the cached details object is not changed");
  const tvdbShow = { id: "999", external_ids: { tvdb_id: "999001" }, seasons: [{ season_number: 1, episode_count: 3 }] };
  assert.equal(await withDisplaySeasons(tvdbShow, { cachedOnly: true }), tvdbShow);
});

test("a show page watch in display numbers is stored in the rows' numbering, or refused", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const normalize = (record) => ({ record });
  const display = { media_type: "episode", title: "Split Show - S01E04 - Four", tvdb_id: TVDB_ID, tmdb_id: TMDB_ID, season: 1, episode: 4 };
  const { record } = await inRowNumbering({ record: display }, { ...display, numbering_source: "tmdb" }, normalize);
  assert.equal(record.season, 2);
  assert.equal(record.episode, 1);
  assert.equal(record.title, "Split Show - S02E01 - Four");
  assert.equal(record.numbering_source, undefined);
  // Untagged records (Up Next) already use the rows' numbering.
  assert.equal((await inRowNumbering({ record: display }, display, normalize)).record, display);
  const missing = { ...display, title: "Split Show - S01E09", episode: 9 };
  await assert.rejects(inRowNumbering({ record: missing }, { ...missing, numbering_source: "tmdb" }, normalize), /S01E09 has no matching episode/);
});

test("progress for a translated show counts what its show page counts", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const rows = [{ season: 1, episode: 2 }, { season: 2, episode: 1 }, { season: 2, episode: 3 }, { season: 0, episode: 1 }];
  // 1x2 -> 1x2, 2x1 -> 1x4, 2x3 has no partner (still a watched row), specials are left out.
  assert.equal(await translatedWatchedCount({ tvdbId: TVDB_ID, tmdbId: TMDB_ID, rows }), 3);
  assert.equal(await translatedWatchedCount({ tvdbId: "999001", tmdbId: "999", rows }), null);
});

test("annotateShowNumbering sends the stored-to-display pairs for progress bars", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const show = await annotateShowNumbering(showFixture());
  assert.deepEqual(show.season_numbering.pairs["2:1"], { season: 1, episode: 4 });
  assert.equal(show.season_numbering.pairs["2:3"], undefined);
});

test("Trakt replace plan and inbound mapping for a translated show", async () => {
  seedCaches();
  setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });
  const { planShowTraktReplace } = await import("../server/src/utils/showTraktReplace.js");
  const plan = await planShowTraktReplace({ show: showFixture(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
  // 1x2 (two plays) -> 1x2, 2x1 -> 1x4; 2x3 has no partner and is left alone.
  assert.deepEqual(plan.moves.map((move) => [move.season, move.episode, move.to.season, move.to.episode, move.dates.length]), [[1, 2, 1, 2, 2], [2, 1, 1, 4, 1]]);
  assert.equal(plan.plays, 3);
  assert.deepEqual(plan.review, [{ season: 2, episode: 3 }]);

  const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
  insertWatchRecordSync({
    media_type: "episode", title: "Split Show - S02E01", source: "manual", sync_action: "watched",
    watched_at: "2026-01-02T00:00:00.000Z", tvdb_id: TVDB_ID, tmdb_id: TMDB_ID, season: 2, episode: 1,
    sync_dispatch_telemetry: "Origin: manual\nDispatch status: success",
    provider_overrides: { trakt: { tmdb_id: TMDB_ID, season: 1, episode: 4 } },
  });
  const { buildTraktInboundTranslator } = await import("../server/src/utils/traktInboundNumbering.js");
  const translate = await buildTraktInboundTranslator();
  const inbound = { type: "episode", ids: { tmdb: TMDB_ID }, season: 1, episode: 4, title: "Split Show - S01E04" };
  assert.deepEqual(translate(inbound), { ...inbound, season: 2, episode: 1, title: "Split Show - S02E01", watchProvenance: { source: "trakt", ingest_path: "trakt_import", provider_overrides: { trakt: { tmdb_id: TMDB_ID, season: 1, episode: 4 } } } });
  // An episode watched after the replace has no row override; the show's map covers it.
  const later = translate({ type: "episode", ids: { tmdb: TMDB_ID }, season: 1, episode: 5 });
  assert.deepEqual([later.season, later.episode], [2, 2]);
  assert.deepEqual(later.watchProvenance.provider_overrides.trakt, { tmdb_id: TMDB_ID, season: 1, episode: 5 });
  const unrelated = { type: "episode", ids: { tmdb: TMDB_ID }, season: 1, episode: 9 };
  assert.equal(translate(unrelated), unrelated);
  const otherShow = { type: "episode", ids: { tmdb: "1" }, season: 1, episode: 4 };
  assert.equal(translate(otherShow), otherShow);
  // Switched back to the stored numbering, the Trakt plays still use the
  // replaced numbers, so inbound events keep mapping back.
  setShowSeasonSource(TVDB_ID, "tvdb", { rowNumbering: "tvdb" });
  assert.equal((await buildTraktInboundTranslator())(inbound).episode, 1);
});
