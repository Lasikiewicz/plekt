import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// Second app audit, step 8: metadata and artwork fixes.
makeTempDataDir("plekt-metadata-artwork-fixes-");

const { db, toJson, parseJson } = await import("../server/src/db.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { getTmdbDetails } = await import("../server/src/utils/tmdbGateway.js");
const { getTvdbSeriesArtwork } = await import("../server/src/utils/tvdbGateway.js");
const { pickNextEpisode } = await import("../server/src/utils/playlistRuleEngine.js");
const { airDayOf, todayLocalDate } = await import("../server/src/utils/watchDates.js");
const { restoreMissingCachedArtwork } = await import("../server/src/utils/posterCache.js");

function json(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
}

function seedSeries(id) {
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET details=excluded.details, updated_at_ms=excluded.updated_at_ms`,
  ).run(`series_${id}`, id, `Show ${id}`, toJson({
    id: Number(id),
    name: `Show ${id}`,
    overview: "Synopsis",
    status: { name: "Continuing" },
    seasons: [],
    episodes: [],
    remoteIds: [],
  }), Date.now());
  db.prepare("INSERT OR REPLACE INTO fanart_cache (id, data, missing, updated_at_ms) VALUES (?, ?, ?, ?)")
    .run(`tv/${id}`, null, 1, Date.now());
}

// Item 1: a temporary TMDB failure must not be stored as a finished record.
test("a TMDB outage keeps the previous cast and videos and the record is retried within minutes", async (t) => {
  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const id = "88101";
  seedSeries(id);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let tmdbMode = "ok";
  let tmdbRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      tmdbRequests += 1;
      if (tmdbMode === "503") return new Response("", { status: 503 });
      if (tmdbMode === "404") return new Response("", { status: 404 });
      return new Response(JSON.stringify({
        id: Number(id),
        name: `Show ${id}`,
        credits: { cast: [{ id: 1, name: "Cast Member" }] },
        videos: { results: [{ key: "abc", site: "YouTube" }] },
        images: { logos: [], backdrops: [], posters: [] },
        external_ids: { imdb_id: "tt0088101" },
        networks: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/v4/login") return json({ token: "tvdb-test-token" });
    if (url.pathname === `/v4/series/${id}/extended`) {
      return json({ id: Number(id), name: `Show ${id}`, overview: "Synopsis", status: { name: "Continuing" }, seasons: [], episodes: [], remoteIds: [] });
    }
    if (url.pathname === `/v4/series/${id}/translations/eng`) return json({ language: "eng", overview: "Synopsis" });
    throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
  };

  const first = await getTmdbDetails({ mediaType: "tv", tmdbId: id, title: `Show ${id}`, ids: { tvdbId: id }, force: true });
  assert.equal(first.credits.cast[0].name, "Cast Member");
  assert.equal(first.tmdb_incomplete_at_ms, undefined);

  tmdbMode = "503";
  const refreshed = await getTmdbDetails({ mediaType: "tv", tmdbId: id, title: `Show ${id}`, ids: { tvdbId: id }, force: true });
  assert.equal(refreshed.credits.cast[0].name, "Cast Member", "cast from the previous record is kept");
  assert.equal(refreshed.videos.results[0].key, "abc", "videos from the previous record are kept");
  assert.ok(refreshed.tmdb_incomplete_at_ms, "the stopgap record is marked incomplete");

  // Inside the short lifetime the stopgap is served without asking TMDB again.
  tmdbMode = "ok";
  const before = tmdbRequests;
  const served = await getTmdbDetails({ mediaType: "tv", tmdbId: id, title: `Show ${id}`, ids: { tvdbId: id } });
  assert.equal(tmdbRequests, before, "a fresh stopgap is not refetched at once");
  assert.ok(served.tmdb_incomplete_at_ms);

  // Past the short lifetime a full caller fetches the real record and clears the mark.
  const row = db.prepare("SELECT details FROM tmdb_metadata_cache WHERE id = ?").get(`tv_${id}`);
  const stored = parseJson(row.details);
  stored.tmdb_incomplete_at_ms = Date.now() - 10 * 60 * 1000;
  db.prepare("UPDATE tmdb_metadata_cache SET details = ? WHERE id = ?").run(toJson(stored), `tv_${id}`);
  const healed = await getTmdbDetails({ mediaType: "tv", tmdbId: id, title: `Show ${id}`, ids: { tvdbId: id } });
  assert.ok(tmdbRequests > before, "the expired stopgap is fetched again");
  assert.equal(healed.tmdb_incomplete_at_ms, undefined);
  assert.equal(healed.credits.cast[0].name, "Cast Member");
});

test("a TMDB 404 is an answer, not an outage: the record is stored as complete", async (t) => {
  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const id = "88102";
  seedSeries(id);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") return new Response("", { status: 404 });
    if (url.pathname === "/v4/login") return json({ token: "tvdb-test-token" });
    if (url.pathname === `/v4/series/${id}/extended`) {
      return json({ id: Number(id), name: `Show ${id}`, overview: "Synopsis", status: { name: "Ended" }, seasons: [], episodes: [], remoteIds: [] });
    }
    if (url.pathname === `/v4/series/${id}/translations/eng`) return json({ language: "eng", overview: "Synopsis" });
    throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
  };
  const details = await getTmdbDetails({ mediaType: "tv", tmdbId: id, title: `Show ${id}`, ids: { tvdbId: id }, force: true });
  assert.equal(details.tmdb_incomplete_at_ms, undefined);
});

// Item 2: one failed artwork-types call must not disable TVDB artwork for 30 days.
test("a failed TVDB artwork-types call is retried on the next artwork request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let typeRequests = 0;
  const artworkTypeFilters = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v4/login") return json({ token: "tvdb-test-token" });
    if (url.pathname === "/v4/artwork/types") {
      typeRequests += 1;
      if (typeRequests === 1) return new Response("", { status: 503 });
      return json([{ id: 2, name: "Poster", recordType: "series" }, { id: 3, name: "Background", recordType: "series" }, { id: 23, name: "ClearLogo", recordType: "series" }]);
    }
    if (url.pathname === "/v4/series/88103/artworks") {
      artworkTypeFilters.push(url.searchParams.get("type"));
      return json({ artworks: [] });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  await getTvdbSeriesArtwork("88103");
  await getTvdbSeriesArtwork("88103");
  assert.equal(typeRequests, 2, "the failed types call is asked again");
  assert.equal(artworkTypeFilters[0], null, "the first call had no type ids");
  assert.equal(artworkTypeFilters[1], "2,3,23", "the retry resolved the type ids");
  await getTvdbSeriesArtwork("88103");
  assert.equal(typeRequests, 2, "a non-empty result is kept");
});

// Item 3: the in-flight entry is removed in a finally and the waiting branch catches.
test("a rejected poster download clears its in-flight entry and does not fail waiting requests", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "server/src/routes/metadata.js"), "utf8");
  const start = source.indexOf("export async function handleTmdbPoster");
  const end = source.indexOf("export async function handleTmdbProfile", start);
  const body = source.slice(start, end);
  assert.match(body, /\}\)\(\)\.finally\(\(\) => _tmdbPosterInflight\.delete\(posterPath\)\)/);
  assert.match(body, /_tmdbPosterInflight\.get\(posterPath\)\.catch\(/);
  assert.match(body, /await downloadPromise\.catch\(/);
});

// Item 4: an episode airing today is released.
test("an Emby or Jellyfin ISO air timestamp for today counts as released", () => {
  const today = "2026-11-10";
  assert.equal(airDayOf("2026-11-10T00:00:00.0000000Z"), "2026-11-10");
  assert.equal(airDayOf("2026-11-10"), "2026-11-10");
  assert.equal(airDayOf(""), "");
  const episodes = [{ season: 1, episode: 2, air_date: "2026-11-10T00:00:00.0000000Z" }];
  assert.equal(pickNextEpisode(episodes, { season: 1, episode: 1 }, today)?.episode, 2);
  const tomorrow = [{ season: 1, episode: 2, air_date: "2026-11-11T00:00:00.0000000Z" }];
  assert.equal(pickNextEpisode(tomorrow, { season: 1, episode: 1 }, today), null);
});

// Item 5: "today" is the server's local calendar date.
test("today is the server's local calendar date, not the UTC date", () => {
  const now = new Date(2026, 10, 10, 0, 30).getTime();
  assert.equal(todayLocalDate(now), "2026-11-10");
  const lateEvening = new Date(2026, 10, 10, 23, 30).getTime();
  assert.equal(todayLocalDate(lateEvening), "2026-11-10");
});

// Item 6: a redacted source URL is not fetched again.
test("restoring artwork skips a source whose token was redacted", async (t) => {
  const storagePath = "poster/redacted-source.jpg";
  db.prepare(
    `INSERT INTO poster_cache (id, media_key, variant, status, source, original_url, storage_path, url, updated_at_ms)
     VALUES (?, ?, 'poster', 'cached', 'plex', ?, ?, ?, ?)`,
  ).run("redacted-source-row", "media:redacted-source", "https://plex.example/library/poster?X-Plex-Token=redacted", storagePath, `/media/${storagePath}`, Date.now());
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("", { status: 401 }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await restoreMissingCachedArtwork(storagePath), null);
  assert.equal(fetches, 0, "no download is attempted");
  const row = db.prepare("SELECT status FROM poster_cache WHERE id = ?").get("redacted-source-row");
  assert.equal(row.status, "cached", "no failure is recorded for the poster");
});
