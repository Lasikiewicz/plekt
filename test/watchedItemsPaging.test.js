import test from "node:test";
import assert from "node:assert/strict";

import { fetchEmbyWatchedItems } from "../server/src/utils/embyClient.js";
import { fetchJellyfinWatchedItems } from "../server/src/utils/jellyfinClient.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Serves `total` played items in whatever StartIndex/Limit window is requested.
function mockWatchedFeed(t, total) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const start = Number(url.searchParams.get("StartIndex") || 0);
    const limit = Number(url.searchParams.get("Limit") || total);
    const end = Math.min(total, start + limit);
    const Items = [];
    for (let i = start; i < end; i++) Items.push({ Id: `item-${i}`, Type: "Movie", UserData: { Played: true } });
    return jsonResponse({ Items, TotalRecordCount: total });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

const clients = [
  ["Emby", fetchEmbyWatchedItems, { baseUrl: "https://emby.example.test", apiKey: "api-key", userId: "emby-user" }],
  ["Jellyfin", fetchJellyfinWatchedItems, { baseUrl: "https://jellyfin.example.test", apiKey: "api-key", userId: "jellyfin-user" }],
];

for (const [name, fetchWatched, config] of clients) {
  test(`${name} watched-items feed pages a large history instead of one unbounded request`, async (t) => {
    const calls = mockWatchedFeed(t, 1201);

    const items = await fetchWatched(config);

    assert.equal(items.length, 1201);
    assert.equal(new Set(items.map((item) => item.Id)).size, 1201);
    assert.deepEqual(calls.map((url) => url.searchParams.get("StartIndex")), ["0", "500", "1000"]);
    for (const url of calls) {
      assert.equal(url.searchParams.get("Limit"), "500");
      assert.equal(url.searchParams.get("Filters"), "IsPlayed");
      assert.equal(url.searchParams.get("SortBy"), "DatePlayed,SortName");
      assert.equal(url.searchParams.get("SortOrder"), "Descending");
      assert.equal(url.searchParams.get("EnableImages"), "false");
    }
  });

  test(`${name} watched-items feed keeps a small limit to one request`, async (t) => {
    const calls = mockWatchedFeed(t, 1201);

    const items = await fetchWatched(config, { limit: 25 });

    assert.deepEqual(items.map((item) => item.Id), Array.from({ length: 25 }, (_, i) => `item-${i}`));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("Limit"), "25");
  });

  test(`${name} watched-items feed pages each selected library separately`, async (t) => {
    const calls = mockWatchedFeed(t, 3);

    const items = await fetchWatched(config, { libraryIds: ["movies", "shows"] });

    assert.equal(items.length, 6);
    assert.deepEqual(calls.map((url) => url.searchParams.get("ParentId")), ["movies", "shows"]);
  });
}
