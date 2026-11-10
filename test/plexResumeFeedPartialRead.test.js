import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-resume-feed-partial-read-");

const { fetchPlexResumableItems, fetchPlexContinueWatchingItems } = await import("../server/src/utils/plexClient.js");

const config = { baseUrl: "http://plex.test", token: "plex-token" };
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function movie(key, viewOffset = 60000) {
  return { ratingKey: key, type: "movie", title: `Movie ${key}`, viewOffset };
}

// A section scan that pages like Plex with a cap of two items per response, whatever
// size is requested, so the client has to page to see every item.
function sectionAll(items) {
  return (url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start") || 0);
    const size = Math.min(Number(url.searchParams.get("X-Plex-Container-Size") || 2), 2);
    return json({ MediaContainer: { totalSize: items.length, Metadata: items.slice(start, start + size) } });
  };
}

function stubPlex(routes) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const route = routes(url);
    if (!route) return json({}, 404);
    return route;
  };
}

test("a failed section in the resume scan throws instead of returning a partial feed", async () => {
  stubPlex((url) => {
    if (url.pathname === "/library/sections") {
      return json({ MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "movie" }] } });
    }
    if (url.pathname === "/library/sections/1/all") return json({ MediaContainer: { totalSize: 1, Metadata: [movie("a")] } });
    if (url.pathname === "/library/sections/2/all") return json({}, 500);
    return null;
  });
  await assert.rejects(fetchPlexResumableItems(config), /section 2|status 500/);
});

test("the resume section scan pages through every item instead of stopping at the first page", async () => {
  const items = [movie("p1"), movie("p2"), movie("p3")];
  stubPlex((url) => {
    if (url.pathname === "/library/sections") {
      return json({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } });
    }
    if (url.pathname === "/library/sections/1/all") return sectionAll(items)(url);
    return null;
  });
  const result = await fetchPlexResumableItems(config);
  assert.deepEqual(result.map((item) => item.ratingKey), ["p1", "p2", "p3"]);
});

test("a Continue Watching hub that fails partway through throws instead of returning the partial hub", async () => {
  stubPlex((url) => {
    if (url.pathname === "/hubs/continueWatching") {
      const start = Number(url.searchParams.get("X-Plex-Container-Start") || 0);
      if (start === 0) {
        return json({ MediaContainer: { totalSize: 2, Hub: [{ Metadata: [{ ratingKey: "h1", type: "movie" }] }] } });
      }
      return json({}, 500);
    }
    // The section fallback is empty, so a result of [h1] could only come from the partial hub.
    if (url.pathname === "/library/sections") return json({ MediaContainer: { Directory: [] } });
    return null;
  });
  const result = await fetchPlexContinueWatchingItems(config, { limit: 0 });
  assert.notDeepEqual(result.map((item) => item.ratingKey), ["h1"]);
});

test("a page-level size without totalSize does not truncate the resume scan", async () => {
  const items = Array.from({ length: 201 }, (_, index) => movie(`sized-${index}`));
  const starts = [];
  stubPlex((url) => {
    if (url.pathname === "/library/sections") return json({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } });
    if (url.pathname !== "/library/sections/1/all") return null;
    const start = Number(url.searchParams.get("X-Plex-Container-Start") || 0);
    starts.push(start);
    const page = items.slice(start, start + 200);
    return json({ MediaContainer: { size: page.length, Metadata: page } });
  });
  const result = await fetchPlexResumableItems(config);
  assert.equal(result.length, 201);
  assert.deepEqual(starts, [0, 200]);
});
