import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state } = await import("../public/modules/state.js");
const { resolveEpisodeTitleFromTmdb } = await import("../public/modules/tmdb.js");

test("history episode titles resolve by show title without requiring Fix Match ids", async () => {
  const originalFetch = globalThis.fetch;
  state.savedConfig = { tmdb: { configured: true } };
  state.showsRaw = [];
  state.tmdbDetailsCache.clear();
  state.tmdbSeasonCache.clear();

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body || "" });
    if (String(url) === "/api/tmdb-details-batch") {
      const [{ title, tmdbId }] = JSON.parse(options.body).items;
      assert.equal(title, "Reacher");
      assert.equal(tmdbId, undefined, "a missing series id must fall back to title lookup");
      return new Response(JSON.stringify({ results: [{ details: { id: 108978, name: "Reacher" } }] }), { status: 200 });
    }
    if (String(url).startsWith("/api/tmdb-season?")) {
      return new Response(JSON.stringify({
        episodes: [{ episode_number: 3, name: "Picture Says a Thousand Words", air_date: "2023-12-15" }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const entry = {
      media_type: "episode",
      title: "Reacher - S02E03",
      show_title: "Reacher",
      season: 2,
      episode: 3,
    };
    const element = { textContent: "Episode 3", title: "Episode 3" };

    await resolveEpisodeTitleFromTmdb(entry, element);

    assert.equal(entry.episode_title, "Picture Says a Thousand Words");
    assert.equal(element.textContent, "Picture Says a Thousand Words");
    assert.equal(entry.air_date, "2023-12-15");
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /episodeTextVersion=1/, "season requests bypass pre-policy browser cache entries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
