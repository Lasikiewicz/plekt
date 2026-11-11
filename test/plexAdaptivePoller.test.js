import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-plex-adaptive-poller-");

const { createPlexAdaptivePoller } = await import("../server/src/utils/plexAdaptivePoller.js");

test("createPlexAdaptivePoller detects newly watched items and passes them to onLibraryItemChange", async () => {
  const events = [];
  let pollCount = 0;

  const mockConfig = {
    baseUrl: "http://127.0.0.1:32400",
    token: "mock-token",
    disabled: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/status/sessions/history/all")) {
      pollCount++;
      if (pollCount === 1) {
        // Initial tick - seeds the cursor
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                { ratingKey: "101", title: "Show S01E01", type: "episode", viewedAt: 1700000000 },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second tick - new watch event
      return new Response(
        JSON.stringify({
          MediaContainer: {
            Metadata: [
              { ratingKey: "102", title: "Show S01E02", type: "episode", viewedAt: 1700000050 },
              { ratingKey: "101", title: "Show S01E01", type: "episode", viewedAt: 1700000000 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("/library/sections")) {
      return new Response(
        JSON.stringify({
          MediaContainer: {
            Directory: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const poller = createPlexAdaptivePoller({
      getPlexConfig: async () => mockConfig,
      onLibraryItemChange: async (ratingKey, item) => {
        events.push({ ratingKey, title: item.title });
      },
      activeIntervalMs: 20,
      idleIntervalMs: 100,
      idleThresholdMs: 500,
    });

    poller.start();

    // Wait for initial tick and subsequent tick
    await new Promise((resolve) => setTimeout(resolve, 200));
    poller.stop();

    assert.equal(events.length, 1);
    assert.equal(events[0].ratingKey, "102");
    assert.equal(events[0].title, "Show S01E02");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPlexAdaptivePoller catches every item of a quick burst of manual watched marks", async () => {
  // A manual Mark as watched never reaches Plex's history; it only shows in the
  // section's lastViewedAt sort. Three marks within one poll used to leave the oldest
  // behind because only the 2 newest per section were read.
  const events = [];
  let sectionPolls = 0;
  const requestedSizes = [];
  const marks = [
    { ratingKey: "6507", title: "C", type: "episode", viewCount: 1, lastViewedAt: 1700000030 },
    { ratingKey: "6506", title: "B", type: "episode", viewCount: 1, lastViewedAt: 1700000020 },
    { ratingKey: "6501", title: "A", type: "episode", viewCount: 1, lastViewedAt: 1700000010 },
  ];
  const seed = { ratingKey: "100", title: "Seed", type: "episode", viewCount: 1, lastViewedAt: 1700000000 };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (parsed.pathname.endsWith("/status/sessions/history/all")) return json({ MediaContainer: { Metadata: [] } });
    if (parsed.pathname.endsWith("/library/sections")) {
      return json({ MediaContainer: { Directory: [{ key: "2", type: "show" }] } });
    }
    if (parsed.pathname.endsWith("/library/sections/2/all")) {
      sectionPolls++;
      const size = Number(parsed.searchParams.get("X-Plex-Container-Size"));
      requestedSizes.push(size);
      const items = sectionPolls === 1 ? [seed] : [...marks, seed];
      return json({ MediaContainer: { Metadata: items.slice(0, size) } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const poller = createPlexAdaptivePoller({
      getPlexConfig: async () => ({ baseUrl: "http://127.0.0.1:32400", token: "mock-token", disabled: false }),
      onLibraryItemChange: async (ratingKey) => {
        events.push(ratingKey);
      },
      activeIntervalMs: 20,
      idleIntervalMs: 100,
      idleThresholdMs: 500,
    });

    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    poller.stop();

    assert.ok(requestedSizes.every((size) => size >= 10), `window was ${requestedSizes[0]}`);
    // Oldest first, all three, none dropped.
    assert.deepEqual(events, ["6501", "6506", "6507"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPlexAdaptivePoller triggers checkUnwatched and handles unwatch callback", async () => {
  let unwatchCalls = 0;
  const mockConfig = {
    baseUrl: "http://127.0.0.1:32400",
    token: "mock-token",
    disabled: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ MediaContainer: { Metadata: [], Directory: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const poller = createPlexAdaptivePoller({
      getPlexConfig: async () => mockConfig,
      onLibraryItemChange: async () => {},
      checkUnwatched: async () => {
        unwatchCalls++;
        return true;
      },
      activeIntervalMs: 20,
      unwatchIntervalMs: 20,
      idleIntervalMs: 100,
      idleThresholdMs: 500,
    });

    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    poller.stop();

    assert.ok(unwatchCalls >= 1, "checkUnwatched should have been called at least once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
