import test from "node:test";
import assert from "node:assert/strict";

const sheetRules = [];
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
globalThis.document = {
  addEventListener() {},
  querySelector: () => null,
  createElement: () => ({ append: (rule) => sheetRules.push(rule) }),
  head: { append() {} },
};
globalThis.CSS ??= { escape: (value) => value };

const { ART_RETRY_DELAYS_MS, cardArtAttribute, mediaArtKey, observeCardArtwork, requestArtKey } = await import("../public/modules/card-art.js");

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const details = responses.shift() ?? null;
    return { ok: true, status: 200, json: async () => ({ results: [{ details }] }) };
  };
  return { calls, fetch };
}

test("cards carry a backdrop lookup key for the show or the movie", () => {
  assert.equal(
    cardArtAttribute({ media_type: "episode", show_tmdb_id: 12, show_tvdb_id: 34, show_title: "Show", tmdb_id: 99 }),
    ' data-art="tv|12|34||Show"',
  );
  assert.equal(cardArtAttribute({ media_type: "movie", tmdb_id: 7, imdb_id: "tt1", title: "A \"Film\"" }), ' data-art="movie|7||tt1|A &quot;Film&quot;"');
  assert.equal(cardArtAttribute({ media_type: "movie" }), "");
});

test("Discover and personal media records key shows as TV and movies as movies", () => {
  assert.equal(mediaArtKey({ media_type: "tv", tmdb_id: 1399, title: "A Show" }), "tv|1399|||A Show");
  assert.equal(mediaArtKey({ media_type: "movie", tmdb_id: 603, title: "A Movie" }), "movie|603|||A Movie");
});

test("backdrop lookups wait until cards approach view", async () => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalWindowObserver = window.IntersectionObserver;
  const originalFetch = globalThis.fetch;
  let callback;
  const observed = [];
  const card = { getAttribute: () => "movie|12345|||Observer deferral fixture" };
  class FakeObserver {
    constructor(onChange) { callback = onChange; }
    observe(node) { observed.push(node); }
    unobserve(node) { assert.equal(node, card); }
    disconnect() {}
  }
  globalThis.IntersectionObserver = FakeObserver;
  window.IntersectionObserver = FakeObserver;
  const { calls, fetch } = fakeFetch([{ id: 12345 }]);
  globalThis.fetch = fetch;
  try {
    observeCardArtwork({ querySelectorAll: () => [card] });
    assert.deepEqual(observed, [card]);
    callback([{ target: card, isIntersecting: false }]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(calls.length, 0);
    callback([{ target: card, isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(calls.length, 1);
  } finally {
    observeCardArtwork(null);
    globalThis.IntersectionObserver = originalObserver;
    window.IntersectionObserver = originalWindowObserver;
    globalThis.fetch = originalFetch;
  }
});

test("a failed backdrop lookup is retried and then published", async (t) => {
  const key = "movie|777|||Retry fixture";
  const originalFetch = globalThis.fetch;
  // First answer: the lookup failed (no details). Second: the backdrop.
  const { calls, fetch } = fakeFetch([null, { id: 777, backdrop_path: "/retry-backdrop.jpg" }]);
  globalThis.fetch = fetch;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = requestArtKey(key);
    t.mock.timers.tick(50);
    await first;
    assert.equal(calls.length, 1);
    assert.equal(sheetRules.some((rule) => rule.includes("retry-backdrop")), false);

    // Before the retry delay the key is still treated as requested.
    await requestArtKey(key);
    assert.equal(calls.length, 1);

    t.mock.timers.tick(ART_RETRY_DELAYS_MS[0]);
    const second = requestArtKey(key);
    t.mock.timers.tick(50);
    await second;
    assert.equal(calls.length, 2);
    assert.ok(sheetRules.some((rule) => rule.includes(`[data-art="${key}"]`) && rule.includes("retry-backdrop.jpg")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
