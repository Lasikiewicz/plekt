import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const schedulerSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "server/src/scheduler.js"), "utf8");

// A show whose stored tmdb id TMDB cannot map to a TVDB series failed with
// "Could not resolve TVDB ID" (the title search cannot resolve a short title such
// as "FBI") even though Plekt already holds the show's TVDB id. The gateway uses
// ids.tvdbId when it is supplied, so the next-airing refresh must pass it.
test("the next-airing refresh passes the recorded TVDB id to the details lookup", () => {
  const start = schedulerSource.indexOf("async function refreshNextAiringCache");
  const end = schedulerSource.indexOf("const scheduledTasksInFlight", start);
  const body = schedulerSource.slice(start, end);
  assert.match(body, /getTmdbDetails\(\{[^}]*ids: \{ tvdbId: show\.tvdb_id \}/);
});

// Behaviour behind the source check above: the gateway answers from the recorded TVDB id
// when TMDB cannot map the stored tmdb id, and only the id-less call falls back to the failing
// title search. No TMDB key or network is available here, so both calls run on the caches.
test("the details lookup resolves by the recorded TVDB id when the tmdb id has no mapping", async () => {
  const os = await import("node:os");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-next-airing-tvdb-test-"));
  const { db, toJson } = await import("../server/src/db.js");
  const { getTmdbDetails } = await import("../server/src/utils/tmdbGateway.js");
  db.prepare(
    `INSERT INTO tvdb_metadata_cache (id, tvdb_id, title, details, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("series_71", "71", "FBI", toJson({
    id: 71,
    name: "FBI",
    overview: "",
    status: { name: "Continuing" },
    episodes: [],
    seasons: [],
    remoteIds: [],
    firstAired: "2018-09-25",
  }), Date.now());
  db.prepare(
    `INSERT INTO fanart_cache (id, data, missing, updated_at_ms) VALUES (?, ?, ?, ?)`,
  ).run("tv/71", null, 1, Date.now());

  await assert.rejects(
    getTmdbDetails({ mediaType: "tv", tmdbId: "424242", title: "FBI", ids: {} }),
    /Could not resolve TVDB ID/,
  );
  const details = await getTmdbDetails({ mediaType: "tv", tmdbId: "424242", title: "FBI", ids: { tvdbId: "71" } });
  assert.equal(details.name, "FBI");
});
