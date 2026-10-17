import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-trakt-numbering-dispatch-");
const { db, toJson } = await import("../server/src/db.js");
const { saveTrackerConnection, getTrackerConnection, updateTrackerConnectionStatus } = await import("../server/src/utils/trackerConnectionRepo.js");
const { setShowSeasonSource } = await import("../server/src/utils/seasonSource.js");
const { dispatchTrackerWatchState, dispatchTraktWatchStateBatch, replayTraktWatchHistory, retryTraktRestoreItem } = await import("../server/src/utils/trackerDispatcher.js");

test.after(() => db.close());

function setup() {
  saveTrackerConnection({ provider: "trakt", status: "connected", clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", accessTokenExpiresAt: Date.now() + 3_600_000 });
  updateTrackerConnectionStatus("trakt", { historySyncedAt: 1000 });
  setShowSeasonSource("78857", "tmdb", { rowNumbering: "tvdb" });
  const episodes = [{ seasonNumber: 2, number: 1, aired: "2003-01-01" }, { seasonNumber: 2, number: 2, aired: "2003-01-08" }];
  db.prepare("INSERT OR REPLACE INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
    .run("series_78857", "78857", "Split Show", toJson({ episodes, seasons: [] }), Date.now());
  db.prepare("INSERT OR REPLACE INTO tmdb_season_cache (id, tmdb_id, season_number, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
    .run("46260_1", "46260", 1, toJson({ episodes: [{ episode_number: 36, air_date: "2003-01-01" }, { episode_number: 37, air_date: "2003-01-08" }] }), Date.now());
}

function media(episode = 1) {
  return { type: "episode", mediaType: "episode", source: "manual", title: "Split Show", showTitle: "Split Show", season: 2, episode, ids: { tmdb: "46260", tvdb: "78857" }, watched_at: "2026-01-01T12:00:00.000Z" };
}

async function capture(run) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ href, body });
    if (href.includes("api.trakt.tv/sync/history") && (!options.method || options.method === "GET")) return new Response("[]", { headers: { "content-type": "application/json" } });
    if (href === "https://api.trakt.tv/sync/history/remove" || href === "https://api.trakt.tv/sync/history") return new Response(JSON.stringify({ added: { episodes: 2 }, deleted: { episodes: 2 }, not_found: {} }), { headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected outbound request: ${href}`);
  };
  try { return { result: await run(), requests }; } finally { globalThis.fetch = original; }
}

function coordinates(requests) {
  return requests.filter(({ body }) => body).flatMap(({ body }) => body.shows.flatMap((show) => show.seasons.flatMap((season) => season.episodes.map((episode) => [String(show.ids.tmdb), season.number, episode.number]))));
}

test("single Force Sync and batch manual dispatch send translated coordinates", async () => {
  setup();
  const single = await capture(() => dispatchTrackerWatchState({ ...media(), source: "force_sync" }, "watched"));
  assert.equal(single.result[0].status, "success");
  assert.deepEqual(coordinates(single.requests), [["46260", 1, 36]]);
  const batch = await capture(() => dispatchTraktWatchStateBatch([media(), media(2)], "watched"));
  assert.equal(batch.result.status, "success");
  assert.deepEqual(coordinates(batch.requests), [["46260", 1, 36], ["46260", 1, 37], ["46260", 1, 36], ["46260", 1, 37]]);
  assert.equal(getTrackerConnection("trakt").historySyncedAt, 1000, "outbound writes must not skip unrelated inbound plays");
});

test("unmatched single and batch dispatch fail without sending stored coordinates", async () => {
  setup();
  const single = await capture(() => dispatchTrackerWatchState(media(99), "watched"));
  assert.equal(single.result[0].status, "failed");
  assert.match(single.result[0].detail, /could not map/);
  assert.equal(single.requests.length, 0);
  const batch = await capture(() => dispatchTraktWatchStateBatch([media(99)], "unwatched"));
  assert.equal(batch.result.results[0].status, "failed");
  assert.equal(batch.requests.length, 0);
});

test("batch unwatch uses saved overrides and rejects invalid overrides before writes", async () => {
  setup();
  const mapped = { ...media(), providerOverrides: { trakt: { tmdb_id: "46260", season: 1, episode: 44 } } };
  const batch = await capture(() => dispatchTraktWatchStateBatch([mapped], "unwatched"));
  assert.equal(batch.result.status, "success");
  assert.deepEqual(coordinates(batch.requests), [["46260", 1, 44]]);
  const invalid = { ...media(), traktOverride: { tmdb_id: "46260", season: 1 } };
  const failed = await capture(() => dispatchTraktWatchStateBatch([invalid], "watched"));
  assert.equal(failed.result.results[0].status, "failed");
  assert.match(failed.result.results[0].detail, /override is invalid/);
  assert.equal(failed.requests.length, 0);
});

function restoreRow(episode, override) {
  return { id: `row-${episode}`, media_type: "episode", title: "Split Show", show_title: "Split Show", season: 2, episode, tmdb_id: "46260", tvdb_id: "78857", watched_at: "2026-01-01T12:00:00.000Z", ...(override ? { watch_provenance: JSON.stringify({ provider_overrides: { trakt: override } }) } : {}) };
}

const detailsResolver = async () => ({ id: 46260, external_ids: { tvdb_id: 78857 } });

test("restore uses saved provenance overrides and maps later rows before replay", async () => {
  setup();
  const { requests } = await capture(() => replayTraktWatchHistory([restoreRow(1, { tmdb_id: "46260", season: 1, episode: 44 }), restoreRow(2)], { detailsResolver }));
  assert.deepEqual(coordinates(requests), [["46260", 1, 44], ["46260", 1, 37]]);
  assert.equal(getTrackerConnection("trakt").historySyncedAt, 1000);
});

test("restore fails preflight before any history read or clear when a row cannot map", async () => {
  setup();
  const { requests } = await capture(async () => {
    await assert.rejects(replayTraktWatchHistory([restoreRow(1), restoreRow(99)], { detailsResolver }), /could not map/);
  });
  assert.equal(requests.length, 0);
});

test("individual restore retry applies numbering and preserves the inbound cursor", async () => {
  setup();
  const { result, requests } = await capture(() => retryTraktRestoreItem(restoreRow(1), { detailsResolver }));
  assert.equal(result.success, true);
  assert.deepEqual(coordinates(requests), [["46260", 1, 36]]);
  assert.equal(getTrackerConnection("trakt").historySyncedAt, 1000);
  const unmatched = await capture(() => retryTraktRestoreItem(restoreRow(99), { detailsResolver }));
  assert.equal(unmatched.result.success, false);
  assert.equal(unmatched.requests.length, 0);
});

test("a TVDB-only choice passes through, but switching back retains established Trakt numbering", async () => {
  setup();
  setShowSeasonSource("78857", "tvdb", { rowNumbering: "tvdb" });
  const unchanged = await capture(() => dispatchTraktWatchStateBatch([media()], "unwatched"));
  assert.deepEqual(coordinates(unchanged.requests), [["46260", 2, 1]]);
  db.prepare("INSERT INTO watch_history (id, media_type, tvdb_id, watch_provenance) VALUES (?, ?, ?, ?)")
    .run("previously-replaced", "episode", "78857", JSON.stringify({ provider_overrides: { trakt: { tmdb_id: "46260", season: 1, episode: 36 } } }));
  const mapped = await capture(() => dispatchTraktWatchStateBatch([media()], "unwatched"));
  assert.deepEqual(coordinates(mapped.requests), [["46260", 1, 36]]);
});
