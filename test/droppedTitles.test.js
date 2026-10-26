import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-dropped-titles-");
const {
  dropTitle,
  undropTitle,
  undropTitleForMedia,
  listDroppedTitles,
  createDroppedTitleFilter,
} = await import("../server/src/utils/droppedTitles.js");
const { recordUpNextDismissal, restoreAllUpNextDismissals } = await import("../server/src/utils/upNextDismissals.js");
const { db } = await import("../server/src/db.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { getFullBackup, importCollectionBatch, BROWSER_BACKUP_COLLECTIONS } = await import("../server/src/utils/backup.js");
const { handleWipeData } = await import("../server/src/routes/wipeData.js");
const { AUTH } = await import("../server/src/appConfig.js");

const reacherEpisode = (season, episode) => ({
  media_key: `reacher-s${season}e${episode}`,
  media_type: "episode",
  title: `Reacher - S0${season}E0${episode}`,
  show_title: "Reacher",
  season,
  episode,
  tmdb_id: `ep-${season}-${episode}`,
  show_ids: { tmdb: "108978" },
});
const reacherShow = { media_type: "tv", title: "Reacher", tmdb_id: "108978" };
const dune = { media_type: "movie", title: "Dune", year: 2021, tmdb_id: "438631", imdb_id: "tt1160419" };
const dune1984 = { media_type: "movie", title: "Dune", year: 1984, tmdb_id: "841" };

function reset() {
  db.prepare("DELETE FROM dropped_titles").run();
}

test("a dropped show hides every episode and its show record, not other titles", () => {
  reset();
  const result = dropTitle(reacherEpisode(2, 3), { now: 1000 });
  assert.equal(result.created, true);
  const [row] = listDroppedTitles();
  assert.equal(row.media_type, "show");
  assert.equal(row.tmdb_id, "108978", "the show id is stored, never the episode id");
  const filter = createDroppedTitleFilter();
  assert.equal(filter.isDropped(reacherEpisode(3, 1)), true);
  assert.equal(filter.isDropped(reacherShow), true);
  assert.equal(filter.droppedAt(reacherEpisode(4, 7)), 1000);
  assert.equal(filter.isDropped(dune), false);
  assert.equal(filter.isDropped({ media_type: "episode", show_title: "Jack Reacher", season: 1, episode: 1 }), false);
});

test("same-title shows and movies with different ids stay separate", () => {
  reset();
  const scrubs2001 = { media_type: "tv", title: "Scrubs", tmdb_id: "4556" };
  const scrubsReboot = { media_type: "episode", show_title: "Scrubs", season: 1, episode: 1, show_tmdb_id: "999001" };
  dropTitle(scrubs2001);
  dropTitle(dune1984);
  const filter = createDroppedTitleFilter();
  assert.equal(filter.isDropped(scrubs2001), true);
  assert.equal(filter.isDropped(scrubsReboot), false);
  assert.equal(filter.isDropped({ media_type: "movie", title: "Dune", year: 2021 }), false, "a different year proves a different movie");
  assert.equal(filter.isDropped(dune), false);
  assert.equal(undropTitleForMedia(scrubsReboot), 0, "un-dropping the reboot leaves the original dropped");
  assert.equal(createDroppedTitleFilter().isDropped(scrubs2001), true);
});

test("dropping again keeps one row and the original drop time", () => {
  reset();
  dropTitle(reacherEpisode(1, 1), { now: 1000 });
  const again = dropTitle({ ...reacherShow, tvdb_id: "366924" }, { now: 5000 });
  assert.equal(again.created, false);
  const rows = listDroppedTitles();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dropped_at, 1000);
  assert.equal(rows[0].tvdb_id, "366924");
  assert.equal(createDroppedTitleFilter().isDropped({ media_type: "episode", show_title: "Reacher (2022)", season: 1, episode: 2, show_tvdb_id: "366924" }), true);
});

test("dropped titles are not capped", () => {
  reset();
  for (let index = 0; index < 600; index += 1) dropTitle({ media_type: "movie", title: `Movie ${index}`, tmdb_id: String(100000 + index) }, { now: index + 1 });
  assert.equal(listDroppedTitles().length, 600);
  assert.equal(createDroppedTitleFilter().isDropped({ media_type: "movie", title: "Movie 0", tmdb_id: "100000" }), true, "the oldest drop is still kept");
});

test("un-drop by id or by media, with an optional before-drop guard", () => {
  reset();
  const { id } = dropTitle(dune, { now: 2000 });
  assert.equal(undropTitleForMedia(dune, { before: 1500 }), 0, "a play before the drop does not un-drop");
  assert.equal(undropTitleForMedia(dune, { before: 2500 }), 1);
  assert.equal(createDroppedTitleFilter().isDropped(dune), false);
  const second = dropTitle(dune);
  assert.equal(undropTitle(second.id), true);
  assert.equal(undropTitle(id), false);
  assert.equal(listDroppedTitles().length, 0);
});

test("Up Next dismissals are not converted into dropped titles", () => {
  reset();
  restoreAllUpNextDismissals();
  recordUpNextDismissal(reacherEpisode(2, 3));
  assert.equal(listDroppedTitles().length, 0);
  assert.equal(createDroppedTitleFilter().isDropped(reacherEpisode(2, 3)), false);
  restoreAllUpNextDismissals();
});

test("drop and un-drop never change watch history", () => {
  reset();
  insertWatchRecordSync({
    title: "Reacher - S01E01",
    media_type: "episode",
    show_title: "Reacher",
    tmdb_id: "108978",
    season: 1,
    episode: 1,
    watched_at: "2026-10-01T12:00:00.000Z",
    source: "manual",
  });
  const before = db.prepare("SELECT * FROM watch_history ORDER BY id").all();
  dropTitle(reacherEpisode(1, 1));
  undropTitleForMedia(reacherShow);
  dropTitle(reacherShow);
  assert.deepEqual(db.prepare("SELECT * FROM watch_history ORDER BY id").all(), before);
});

test("full and portable backups round-trip dropped titles", () => {
  reset();
  dropTitle(reacherEpisode(1, 1), { now: 1234 });
  dropTitle(dune, { now: 5678 });
  assert.ok(BROWSER_BACKUP_COLLECTIONS.includes("droppedTitles"));
  const documents = getFullBackup("test").collections.droppedTitles;
  assert.equal(documents.length, 2);
  const expected = listDroppedTitles();
  reset();
  importCollectionBatch("droppedTitles", JSON.parse(JSON.stringify(documents)), { reset: true, portable: true });
  assert.deepEqual(listDroppedTitles(), expected);
  const filter = createDroppedTitleFilter();
  assert.equal(filter.isDropped(reacherEpisode(3, 3)), true);
  assert.equal(filter.droppedAt(dune), 5678);
});

async function wipe(scope) {
  let responseData = null;
  const response = {
    status() { return this; },
    set() { return this; },
    send(data) {
      responseData = JSON.parse(data);
      return this;
    },
  };
  await handleWipeData({
    method: "POST",
    headers: { authorization: `Bearer ${AUTH.apiKey}` },
    body: { scope, confirm: "DELETE" },
    get(name) { return this.headers[name.toLowerCase()]; },
  }, response);
  return responseData;
}

test("the Watch History wipe clears dropped titles; the logs wipe keeps them", async () => {
  reset();
  dropTitle(dune);
  assert.equal((await wipe("logs")).ok, true);
  assert.equal(listDroppedTitles().length, 1);
  const result = await wipe("history");
  assert.equal(result.ok, true);
  assert.equal(result.deleted.dropped_titles, 1);
  assert.equal(listDroppedTitles().length, 0);
});

test("the factory reset clears dropped titles", async () => {
  reset();
  dropTitle(dune);
  const result = await wipe("factory");
  assert.equal(result.ok, true);
  assert.equal(result.deleted.dropped_titles, 1);
  assert.equal(listDroppedTitles().length, 0);
});
