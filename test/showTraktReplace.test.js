import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-show-trakt-replace-test-");

const repo = await import("../server/src/utils/dataRepo.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const { replaceShowOnTrakt } = await import("../server/src/utils/showTraktReplace.js");
const { db, toJson } = await import("../server/src/db.js");

test.after(() => {
  db.close();
});

const TVDB_ID = "78857";
const TMDB_ID = "46260";

function day(offset) {
  return new Date(Date.UTC(2002, 9, 3) + offset * 7 * 86400000).toISOString().slice(0, 10);
}

// TVDB: S1E1-3 and S2E1-3. TMDB: one season of 5 (TVDB S2E3 has no partner).
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

const SETTLED = "Origin: manual\nLoop-check: Passed\nDispatch status: success\nTarget trakt status: success";

function insertRow(season, episode, watchedAt) {
  return repo.insertWatchRecordSync({
    media_type: "episode",
    title: `Split Show - S0${season}E0${episode}`,
    source: "manual",
    sync_action: "watched",
    watched_at: watchedAt,
    tvdb_id: TVDB_ID,
    tmdb_id: TMDB_ID,
    season,
    episode,
    sync_dispatch_telemetry: SETTLED,
  });
}

function connectTrakt() {
  trackerConnectionRepo.saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "user-1",
    remoteUsername: "tester",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    initialSyncMode: "baseline",
    baselineComplete: true,
    lastValidatedAt: Date.now(),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Trakt mock: the show exists; season 1 has `traktEpisodes` episodes.
function mockTrakt({ traktEpisodes, rejectAdds = false, historyFailure = false, occupiedTarget = false }) {
  const calls = [];
  let nextId = 10;
  let history = [
    [1, 1, 2, "2026-01-01T10:00:00.000Z"], [2, 1, 2, "2026-02-01T10:00:00.000Z"],
    [3, 2, 1, "2026-01-02T10:00:00.000Z"], [4, 1, occupiedTarget ? 4 : 5, "2020-01-01T10:00:00.000Z"],
    [5, 2, 1, "2020-02-01T10:00:00.000Z"], [6, 1, 2, "2020-03-01T10:00:00.000Z"],
  ].map(([id, season, number, watched_at]) => ({ id, watched_at, episode: { season, number }, show: { title: "Split Show", ids: { trakt: 99, tvdb: Number(TVDB_ID), tmdb: Number(TMDB_ID) } } }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://api.trakt.tv/search/")) {
      return json([{ type: "show", show: { title: "Split Show", ids: { trakt: 99, tvdb: Number(TVDB_ID), tmdb: Number(TMDB_ID) } } }]);
    }
    if (href.startsWith("https://api.trakt.tv/shows/99/seasons/1")) {
      return json(Array.from({ length: traktEpisodes }, (_, index) => ({ number: index + 1, season: 1 })));
    }
    if (href.startsWith("https://api.trakt.tv/users/me/history/shows/99?")) {
      if (historyFailure) return json({ error: "unavailable" }, 503);
      return json(history);
    }
    if (href === "https://api.trakt.tv/sync/history/remove" || href === "https://api.trakt.tv/sync/history") {
      calls.push({ href, body: JSON.parse(options.body || "{}") });
      if (href.endsWith("remove")) history = history.filter((item) => !JSON.parse(options.body).ids.includes(String(item.id)));
      else if (rejectAdds) return json({ not_found: { episodes: [{}] } });
      else for (const item of episodesIn(JSON.parse(options.body))) history.push({ id: nextId++, watched_at: item.watched_at, episode: { season: item.season, number: item.episode }, show: { title: "Split Show", ids: { trakt: 99, tvdb: Number(TVDB_ID), tmdb: Number(TMDB_ID) } } });
      return json(href.endsWith("remove") ? { deleted: { episodes: 1 }, not_found: {} } : { added: { episodes: 1 }, not_found: {} }, 201);
    }
    throw new Error(`Unexpected fetch during test: ${href}`);
  };
  return { calls, history: () => history, restore: () => { globalThis.fetch = originalFetch; } };
}

function episodesIn(body) {
  return (body.shows || []).flatMap((show) => (show.seasons || []).flatMap((season) => (season.episodes || []).map((episode) => ({
    season: season.number,
    episode: episode.number,
    watched_at: episode.watched_at,
  }))));
}

function rowFor(id) {
  return db.prepare("SELECT season, episode, watch_provenance, sync_dispatch_telemetry FROM watch_history WHERE id = ?").get(id);
}

seedCaches();
connectTrakt();
const rowA1 = insertRow(1, 2, "2026-01-01T10:00:00.000Z").id;
const rowA2 = insertRow(1, 2, "2026-02-01T10:00:00.000Z").id;
const rowB = insertRow(2, 1, "2026-01-02T10:00:00.000Z").id;
const rowC = insertRow(2, 3, "2026-01-03T10:00:00.000Z").id;
setShowSeasonSource(TVDB_ID, "tmdb", { rowNumbering: "tvdb" });

async function loadShow() {
  return repo.queryShowDetail({ tvdbId: TVDB_ID, tmdbId: TMDB_ID });
}

test("nothing is written to Trakt when a new episode number is missing there", async () => {
  const trakt = mockTrakt({ traktEpisodes: 3 }); // TMDB S1E4 is missing on Trakt
  try {
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not have 1 of the new episode numbers/);
    assert.equal(trakt.calls.length, 0);
    assert.equal(JSON.parse(rowFor(rowB).watch_provenance || "{}")?.provider_overrides, undefined);
  } finally {
    trakt.restore();
  }
});

test("replace preserves remote-only plays and verifies additions before removing exact old history ids", async () => {
  const trakt = mockTrakt({ traktEpisodes: 5 });
  try {
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.episodes, 2);
    assert.equal(result.plays, 3);
    assert.deepEqual(result.review, [{ season: 2, episode: 3 }]);

    // New coordinates must be safely present before an old play can be removed.
    const firstAdd = trakt.calls.findIndex((call) => call.href.endsWith("/sync/history"));
    const lastRemove = trakt.calls.map((call) => call.href.endsWith("remove")).lastIndexOf(true);
    assert.ok(lastRemove > firstAdd);
    assert.deepEqual(trakt.calls.filter((call) => call.href.endsWith("remove")).flatMap((call) => call.body.ids), ["3"]);
    assert.deepEqual(trakt.history().filter((item) => [4, 5, 6].includes(item.id)).map((item) => item.id), [4, 5, 6], "Trakt-only plays at source, target and overlapping coordinates stay put");
    const added = trakt.calls.filter((call) => call.href.endsWith("/sync/history")).flatMap((call) => episodesIn(call.body))
      .map((item) => `${item.season}x${item.episode}@${item.watched_at.slice(0, 10)}`).sort();
    assert.deepEqual(added, ["1x4@2026-01-02"], "existing correct plays are not duplicated");

    // Every translated row is mapped for Trakt; stored numbers and telemetry stay.
    for (const [id, season, episode, traktEpisode] of [[rowA1, 1, 2, 2], [rowA2, 1, 2, 2], [rowB, 2, 1, 4]]) {
      const row = rowFor(id);
      assert.equal(row.season, season);
      assert.equal(row.episode, episode);
      assert.deepEqual(JSON.parse(row.watch_provenance).provider_overrides.trakt, { tmdb_id: TMDB_ID, season: 1, episode: traktEpisode });
      assert.equal(row.sync_dispatch_telemetry, SETTLED);
    }
    assert.equal(JSON.parse(rowFor(rowC).watch_provenance || "{}")?.provider_overrides, undefined);

    // Ledger: the removed old coordinate reads as Plekt's own unwatch, and the
    // re-added coordinates as its own watch, so the next poll does not echo.
    const states = trackerConnectionRepo.listTrackerItemStates("trakt");
    const stateOf = (season, episode) => states.find((item) => Number(item.media?.season) === season && Number(item.media?.episode) === episode)?.lastOutboundState;
    assert.equal(stateOf(2, 1), "watched", "a remote-only play remains at the source");
    assert.equal(stateOf(1, 4), "watched");
    assert.equal(stateOf(1, 2), "watched");
    assert.equal(Number(trackerConnectionRepo.getTrackerConnection("trakt").historySyncedAt), 0, "outbound replacement cannot skip another show's history window");
  } finally {
    trakt.restore();
  }
});

test("unconfirmed additions never remove old history", async () => {
  const trakt = mockTrakt({ traktEpisodes: 5, rejectAdds: true });
  try {
    await assert.rejects(replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID }), /rejected target plays/);
    assert.equal(trakt.calls.some((call) => call.href.endsWith("remove")), false);
    assert.ok(trakt.history().some((entry) => entry.id === 3));
  } finally { trakt.restore(); }
});

test("a failed complete history snapshot changes nothing", async () => {
  const trakt = mockTrakt({ traktEpisodes: 5, historyFailure: true });
  try {
    await assert.rejects(replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID }));
    assert.equal(trakt.calls.length, 0);
  } finally { trakt.restore(); }
});

test("a pre-switch Trakt row keeps its canonical remote episode and gains the correct local identity", async () => {
  const inserted = repo.insertWatchRecordSync({ media_type: "episode", title: "Split Show - S01E05", source: "trakt", sync_action: "watched", watched_at: "2020-01-01T10:00:00.000Z", tvdb_id: TVDB_ID, tmdb_id: TMDB_ID, season: 1, episode: 5, sync_dispatch_telemetry: SETTLED });
  const trakt = mockTrakt({ traktEpisodes: 5 });
  try {
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.equal(result.ok, true, result.error);
    const row = rowFor(inserted.id);
    assert.deepEqual([row.season, row.episode], [2, 2]);
    assert.deepEqual(JSON.parse(row.watch_provenance).provider_overrides.trakt, { tmdb_id: TMDB_ID, season: 1, episode: 5 });
    assert.ok(trakt.history().some((entry) => entry.id === 4), "canonical Trakt play is retained by id");
  } finally { trakt.restore(); await repo.deleteWatchRecordById(inserted.id); }
});

test("an occupied target refuses before any write because Trakt may replace its existing date", async () => {
  const trakt = mockTrakt({ traktEpisodes: 5, occupiedTarget: true });
  try {
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.equal(result.ok, false);
    assert.match(result.error, /another play at a target/);
    assert.equal(trakt.calls.length, 0);
  } finally { trakt.restore(); }
});

test("an imported row without numbering evidence stays for review instead of moving to a guessed episode", async () => {
  const inserted = repo.insertWatchRecordSync({ media_type: "episode", title: "Split Show - S01E03", source: "trakt", sync_action: "watched", watched_at: "2019-01-01T10:00:00.000Z", tvdb_id: TVDB_ID, tmdb_id: TMDB_ID, season: 1, episode: 3, sync_dispatch_telemetry: SETTLED });
  const trakt = mockTrakt({ traktEpisodes: 5 });
  try {
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.ok(result.review.some((row) => row.season === 1 && row.episode === 3));
    assert.equal(trakt.calls.flatMap((call) => episodesIn(call.body)).some((row) => row.watched_at === "2019-01-01T10:00:00.000Z"), false);
    assert.equal(JSON.parse(rowFor(inserted.id).watch_provenance || "{}")?.provider_overrides, undefined);
  } finally { trakt.restore(); await repo.deleteWatchRecordById(inserted.id); }
});

test("rewatches use distinct episode batches and remain idempotent on retry", async () => {
  const inserted = insertRow(2, 1, "2026-03-01T10:00:00.000Z");
  const trakt = mockTrakt({ traktEpisodes: 5 });
  try {
    await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    for (const call of trakt.calls.filter((call) => call.href.endsWith("/sync/history"))) {
      const coordinates = episodesIn(call.body).map((row) => `${row.season}:${row.episode}`);
      assert.equal(new Set(coordinates).size, coordinates.length);
    }
    const count = trakt.history().length;
    const result = await replaceShowOnTrakt({ show: await loadShow(), tvdbId: TVDB_ID, tmdbId: TMDB_ID });
    assert.equal(result.added, 0);
    assert.equal(trakt.history().length, count);
  } finally { trakt.restore(); await repo.deleteWatchRecordById(inserted.id); }
});
