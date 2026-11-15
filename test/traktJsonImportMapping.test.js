import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mapImportRecord } = await import("../public/modules/tools.js");

// Issue #61: selecting every file from a Trakt export imported watched-shows.json
// summaries as movies carrying the show's TMDB id, and collection files as watches.

test("Trakt history episode rows import as episodes with show ids", () => {
  const record = mapImportRecord({
    id: 1,
    watched_at: "2026-10-26T03:46:00.000Z",
    action: "watch",
    type: "episode",
    episode: { season: 8, number: 22, title: "Return to Base (2)", ids: { trakt: 9, tmdb: 555 } },
    show: { title: "S.W.A.T.", year: 2017, ids: { trakt: 7, tvdb: 328687, tmdb: 71790 } },
  });
  assert.equal(record.media_type, "episode");
  assert.equal(record.title, "S.W.A.T. - S08E22");
  assert.equal(record.tmdb_id, 71790);
  assert.equal(record.season, 8);
  assert.equal(record.episode, 22);
});

test("Trakt history movie rows still import as movies", () => {
  const record = mapImportRecord({
    watched_at: "2026-10-01T20:00:00.000Z",
    type: "movie",
    movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } },
  });
  assert.equal(record.media_type, "movie");
  assert.equal(record.title, "Heat");
  assert.equal(record.tmdb_id, 949);
});

test("watched-shows.json summaries are skipped, not imported as movies", () => {
  const summary = {
    plays: 212,
    last_watched_at: "2026-10-26T03:46:00.000Z",
    last_updated_at: "2026-10-26T03:46:00.000Z",
    reset_at: null,
    show: { title: "S.W.A.T.", year: 2017, ids: { trakt: 7, tvdb: 328687, tmdb: 71790 } },
    seasons: [{ number: 8, episodes: [{ number: 22, plays: 1, last_watched_at: "2026-10-26T03:46:00.000Z" }] }],
  };
  assert.equal(mapImportRecord(summary), undefined);
  const { seasons, ...withoutSeasons } = summary;
  assert.equal(mapImportRecord(withoutSeasons), undefined);
});

test("collection files are not watches", () => {
  assert.equal(mapImportRecord({
    collected_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } },
  }), undefined);
});

test("CSV rows with a plain show title still import as episodes", () => {
  const record = mapImportRecord({ type: "episode", show: "Superstore", season: "2", episode: "3", watched_at: "2026-10-03T10:59:00Z" });
  assert.equal(record.media_type, "episode");
  assert.equal(record.title, "Superstore - S02E03");
});
