import test from "node:test";
import assert from "node:assert/strict";
import { createAnidbMovieLookup } from "../server/src/utils/anidbMovieMatches.js";

const movie = { mediaType: "movie", tmdbId: "149" };
const binding = (aid = "28", item = "Q123") => ({
  item: { type: "uri", value: `http://www.wikidata.org/entity/${item}` },
  aid: { type: "literal", value: aid },
});
const response = (rows) => new Response(JSON.stringify({ results: { bindings: rows } }));

test("movie lookup uses exact movie identifiers, deduplicates and keeps cache-only reads offline", async () => {
  let calls = 0;
  let clock = 0;
  const lookup = createAnidbMovieLookup({ now: () => clock, fetcher: async (url) => {
    calls++;
    assert.match(new URL(url).searchParams.get("query"), /wdt:P4947 "149"; wdt:P5646/);
    return response([binding()]);
  } });
  assert.equal(await lookup(movie, { cacheOnly: true }), null);
  assert.equal(await lookup({ mediaType: "tv", tmdbId: "149" }), null);
  const values = await Promise.all([lookup(movie), lookup(movie)]);
  assert.deepEqual(values[0], { aid: "28", evidence: "wikidata", url: "https://www.wikidata.org/entity/Q123" });
  assert.deepEqual(values[0], values[1]);
  assert.equal(calls, 1);
  assert.deepEqual(await lookup(movie, { cacheOnly: true }), values[0]);
  clock = 86400_001;
  assert.equal(await lookup(movie, { cacheOnly: true }), null);
  assert.equal(calls, 1);
  await assert.rejects(lookup({ mediaType: "movie", tmdbId: '149" }' }));
});

test("ambiguous, absent and malformed identifiers never become automatic matches", async () => {
  for (const rows of [[], [binding(), binding("29")], [binding(), binding("28", "Q456")],
    [binding("0")], [binding("not-an-id")], [{ ...binding(), item: { type: "uri", value: "https://evil.test/Q123" } }]]) {
    let calls = 0;
    const lookup = createAnidbMovieLookup({ fetcher: async () => { calls++; return response(rows); } });
    assert.equal(await lookup(movie), null);
    assert.equal(await lookup(movie), null);
    assert.equal(calls, 1);
  }
});

test("outage, invalid JSON, oversized responses and rate limits fall back with global cooldown", async () => {
  for (const fetcher of [async () => { throw new Error("offline"); },
    async () => new Response("no", { status: 429 }),
    async () => new Response("invalid json"),
    async () => new Response("x".repeat(65537)),
    async () => new Response('{"results":{}}')]) {
    let calls = 0;
    let clock = 0;
    const lookup = createAnidbMovieLookup({ now: () => clock, fetcher: async (...args) => { calls++; return fetcher(...args); } });
    assert.equal(await lookup(movie), null);
    assert.equal(await lookup({ ...movie, tmdbId: "128" }), null);
    assert.equal(calls, 1);
    clock = 900_001;
    assert.equal(await lookup(movie), null);
    assert.equal(calls, 2);
  }
});
