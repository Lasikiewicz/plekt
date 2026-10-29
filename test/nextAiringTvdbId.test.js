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
