import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-same-title-aliases-");

const repo = await import("../server/src/utils/dataRepo.js");
const { db } = await import("../server/src/db.js");

// Verified live (Up Next matrix defect F): "Scrubs" 2001 and the 2026 reboot
// both title their episodes "Scrubs - S01E0n". A clear or watch of the 2001
// episode also wrote the reboot's playstate row and deleted its history rows,
// because the alias convergence matched rows by title and coordinate alone.
const ORIGINAL = { imdb_id: "tt0285403", tmdb_id: "4556", tvdb_id: "76156" };
const REBOOT = { imdb_id: "tt40197357", tmdb_id: "295778", tvdb_id: "465690" };

function episodeRecord(ids, episode, extra = {}) {
  return {
    title: `Scrubs - S01E0${episode}`,
    show_title: "Scrubs",
    media_type: "episode",
    watched_at: `2026-09-0${episode}T01:00:00.000Z`,
    source: "manual",
    season: 1,
    episode,
    ...ids,
    ...extra,
  };
}

function episodeMedia(ids, episode) {
  return {
    title: `Scrubs - S01E0${episode}`,
    show_title: "Scrubs",
    type: "episode",
    season: 1,
    episode,
    source: "manual",
    isValid: true,
    ids: { imdb: ids.imdb_id, tmdb: ids.tmdb_id, tvdb: ids.tvdb_id },
  };
}

function playstateByKey(key) {
  return db.prepare("SELECT state, watched_at FROM playstate WHERE media_key = ?").get(key);
}

async function insert(record) {
  const result = await repo.insertWatchRecord(record);
  await result.assetPrefetch;
  return result.id;
}

// Each show is proven by rows at two coordinates, as live.
for (const episode of [1, 2, 3]) await insert(episodeRecord(REBOOT, episode));
for (const episode of [4, 5]) await insert(episodeRecord(ORIGINAL, episode));

test("a playstate change of one same-title show leaves the other show's row alone", async () => {
  await repo.upsertPlaystateForMedia(episodeMedia(REBOOT, 6), "watched", "2026-09-06T01:00:00.000Z");
  const rebootKey = "episode:1:6:imdb:tt40197357";
  assert.equal(playstateByKey(rebootKey)?.state, "watched");

  const result = await repo.setPlaystateForMediaIdentity(episodeMedia(ORIGINAL, 6), "unwatched", "2026-09-23T01:00:00.000Z");
  assert.ok(!result.mediaKeys.includes(rebootKey), `wrote the reboot key: ${result.mediaKeys}`);
  assert.equal(playstateByKey(rebootKey)?.state, "watched");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(REBOOT, 6))?.state, "watched");
  assert.equal(repo.getPlaystateForMediaSync(episodeMedia(ORIGINAL, 6))?.state, "unwatched");
});

test("clearing one same-title show's episode keeps the other show's history rows", () => {
  const before = db.prepare("SELECT id FROM watch_history WHERE imdb_id = ? AND episode = 2").get(REBOOT.imdb_id);
  assert.ok(before);
  repo.clearWatchHistoryForMediaIdentitySync(episodeMedia(ORIGINAL, 2));
  assert.ok(db.prepare("SELECT id FROM watch_history WHERE id = ?").get(before.id), "reboot S01E02 row was deleted");
});

test("a watch of one same-title show does not retire the other show's unwatch marker", async () => {
  const marker = "rebootunwatch7";
  db.prepare(
    `INSERT INTO watch_history (id, media_key, title, title_lower, show_title, media_type, sync_action, source,
       imdb_id, tmdb_id, tvdb_id, season, episode, watched_at, created_at, updated_at)
     VALUES (?, 'episode:1:7:imdb:tt40197357', 'Scrubs - S01E07', 'scrubs - s01e07', 'Scrubs', 'episode', 'unwatched', 'plex',
       ?, ?, ?, 1, 7, '2026-09-07T01:00:00.000Z', ?, ?)`,
  ).run(marker, REBOOT.imdb_id, REBOOT.tmdb_id, REBOOT.tvdb_id, Date.now(), Date.now());
  const id = await insert(episodeRecord(ORIGINAL, 7, { watched_at: "2026-09-23T02:00:00.000Z" }));
  repo.supersedeUnwatchedTransitionsForRecordSync(db.prepare("SELECT * FROM watch_history WHERE id = ?").get(id));
  assert.ok(db.prepare("SELECT id FROM watch_history WHERE id = ?").get(marker), "reboot unwatch marker was retired");
});

test("the ingest dedupe does not treat one same-title show's watch as the other's", async () => {
  await insert(episodeRecord(REBOOT, 9));
  assert.equal(repo.findWatchedByAnyMediaKeySync(episodeMedia(ORIGINAL, 9)), null);
  assert.ok(repo.findWatchedByAnyMediaKeySync(episodeMedia(REBOOT, 9)), "reboot watch not found by its own ids");
  assert.ok(repo.findWatchedByAnyMediaKeySync({ ...episodeMedia({}, 9), ids: {} }), "id-less lookup no longer matches by coordinate");
});

// Verified live (Up Next matrix defect AC): the Australian "The Assembly" has a
// single watch, so no profile proves its ids. A Jellyfin unplay of the UK show's
// S01E04 (its own series ids resolved) superseded that Australian watch.
const AU_ASSEMBLY = { imdb_id: "tt33204483", tmdb_id: "262100", tvdb_id: "452480" };
const UK_ASSEMBLY = { imdb: "tt8064568", tmdb: "290057", tvdb: "453869" };

function assemblyMedia(ids) {
  return { title: "The Assembly - S01E04", type: "episode", season: 1, episode: 4, source: "jellyfin", isValid: true, ids };
}

test("a same-title show with conflicting unproven ids is not matched by title and coordinate", async () => {
  const auId = await insert({
    title: "The Assembly - S01E04", show_title: "The Assembly", media_type: "episode", source: "trakt",
    watched_at: "2025-05-10T00:00:00.000Z", season: 1, episode: 4, ...AU_ASSEMBLY,
  });
  await repo.upsertPlaystateForMedia(assemblyMedia({ imdb: AU_ASSEMBLY.imdb_id, tmdb: AU_ASSEMBLY.tmdb_id, tvdb: AU_ASSEMBLY.tvdb_id }), "watched", "2025-05-10T00:00:00.000Z");
  const uk = assemblyMedia(UK_ASSEMBLY);

  assert.equal(repo.findWatchedByAnyMediaKeySync(uk), null);
  assert.equal(repo.findLatestWatchedByAnyMediaKeySync(uk), null);
  const result = await repo.setPlaystateForMediaIdentity(uk, "unwatched", "2026-09-23T13:29:59.000Z");
  assert.ok(!result.mediaKeys.includes("episode:1:4:imdb:tt33204483"), `wrote the Australian key: ${result.mediaKeys}`);
  assert.equal(playstateByKey("episode:1:4:imdb:tt33204483")?.state, "watched");
  repo.clearWatchHistoryForMediaIdentitySync(uk);
  assert.ok(db.prepare("SELECT id FROM watch_history WHERE id = ?").get(auId), "Australian S01E04 row was deleted");

  // Ids that share one value, an IMDb-only disagreement (a leaked episode id), or a
  // single mismatched TMDB id (a wrong library match) still converge.
  assert.equal(repo.findLatestWatchedByAnyMediaKeySync(assemblyMedia({ imdb: "tt99999999" }))?.id, auId);
  assert.equal(repo.findLatestWatchedByAnyMediaKeySync(assemblyMedia({ imdb: AU_ASSEMBLY.imdb_id, tmdb: "1", tvdb: "2" }))?.id, auId);
  assert.equal(repo.findLatestWatchedByAnyMediaKeySync(assemblyMedia({ tmdb: "1" }))?.id, auId);
});

test("rows whose ids are proven for no show still converge by title", async () => {
  await repo.upsertPlaystateForMedia({ ...episodeMedia({}, 8), ids: {} }, "watched", "2026-09-08T01:00:00.000Z");
  const result = await repo.setPlaystateForMediaIdentity(episodeMedia(ORIGINAL, 8), "unwatched", "2026-09-23T03:00:00.000Z");
  const titleOnly = result.mediaKeys.filter((key) => !key.includes(ORIGINAL.imdb_id));
  assert.ok(titleOnly.length >= 1, `title-only alias not converged: ${result.mediaKeys}`);
});

// Verified live (Simkl canary, 23 October): an import of Beauty and the Beast
// (1991) matched the 2017 remake's watch by title, so it recorded no watch and
// set the 1991 playstate to the remake's date.
test("the ingest dedupe does not treat a same-title remake's watch as this film's", async () => {
  await insert({ title: "Beauty and the Beast", media_type: "movie", watched_at: "2017-02-27T20:33:00.000Z", source: "trakt_import", imdb_id: "tt2771200", tmdb_id: "321612" });
  const movie = (ids) => ({ title: "Beauty and the Beast", type: "movie", source: "simkl_import", isValid: true, ids });
  assert.equal(repo.findWatchedByAnyMediaKeySync(movie({ imdb: "tt0101414", tmdb: "10020", tvdb: "226" })), null);
  assert.ok(repo.findWatchedByAnyMediaKeySync(movie({ imdb: "tt2771200" })), "remake watch not found by its own id");
  assert.ok(repo.findWatchedByAnyMediaKeySync(movie({})), "id-less lookup no longer matches by title");
  assert.ok(repo.findWatchedByAnyMediaKeySync(movie({ tvdb: "226" })), "a movie TVDB id alone does not prove another film");
});
