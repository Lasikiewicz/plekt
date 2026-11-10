import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-jellyfin-watched-scan-partial-read-");

const { fetchJellyfinWatchedItems } = await import("../server/src/utils/jellyfinClient.js");

const config = { baseUrl: "http://jellyfin.test", apiKey: "jelly-key", userId: "jelly-user" };
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function item(id) {
  return { Id: id, Type: "Movie", Name: `Item ${id}`, UserData: { Played: true } };
}

// A server that caps every page at two items and reports no TotalRecordCount, as some
// Jellyfin-compatible servers do. It honours StartIndex.
function cappedServer(items, calls) {
  return (url) => {
    calls.push(url);
    const start = Number(url.searchParams.get("StartIndex") || 0);
    return json({ Items: items.slice(start, start + 2) });
  };
}

test("a full Jellyfin scan keeps paging past a short page when the server reports no total", async () => {
  const calls = [];
  const items = [item("j1"), item("j2"), item("j3"), item("j4"), item("j5")];
  const serve = cappedServer(items, calls);
  globalThis.fetch = async (input) => serve(new URL(String(input)));
  const result = await fetchJellyfinWatchedItems(config, {});
  assert.deepEqual(result.map((entry) => entry.Id), ["j1", "j2", "j3", "j4", "j5"]);
});

test("a full Jellyfin scan sorts by Id so the order is stable across pages", async () => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return json({ Items: [] });
  };
  await fetchJellyfinWatchedItems(config, {});
  assert.equal(calls[0].searchParams.get("SortBy"), "Id");
  assert.equal(calls[0].searchParams.get("SortOrder"), "Ascending");
});

test("a Jellyfin scan that keeps returning the same page throws instead of ending silently", async () => {
  globalThis.fetch = async () => json({ Items: [item("dup1"), item("dup2")] });
  await assert.rejects(fetchJellyfinWatchedItems(config, {}), /did not advance/);
});
