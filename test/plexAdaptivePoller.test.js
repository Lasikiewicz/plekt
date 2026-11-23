import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-plex-adaptive-poller-");

const { createPlexAdaptivePoller } = await import("../server/src/utils/plexAdaptivePoller.js");
const { configureOutboundGovernor, resetOutboundGovernor } = await import("../server/src/utils/outboundGovernor.js");

test("an open notification socket spaces fallback polls out and a failed poll backs off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  configureOutboundGovernor("fast");
  t.after(resetOutboundGovernor);
  let historyReads = 0;
  let unwatchChecks = 0;
  let connected = true;
  let failed = false;
  t.mock.method(globalThis, "fetch", async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.includes("/history/")) historyReads++;
    return {
      ok: !failed,
      status: failed ? 404 : 200,
      headers: new Headers(),
      json: async () => ({ MediaContainer: { Metadata: [], Directory: [{ key: "1", type: "movie" }] } }),
    };
  });
  const poller = createPlexAdaptivePoller({
    getPlexConfig: async () => ({ baseUrl: "http://127.0.0.1:32400", token: "test" }),
    isNotificationConnected: () => connected,
    checkUnwatched: async () => { unwatchChecks++; },
  });
  t.after(() => poller.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise(setImmediate);
  };

  poller.start();
  await advance(1_000);
  assert.equal(historyReads, 1);
  assert.equal(unwatchChecks, 1);
  await advance(59_999);
  assert.equal(historyReads, 1);
  connected = false;
  await advance(1);
  assert.equal(historyReads, 2);
  failed = true;
  await advance(5_000);
  assert.equal(historyReads, 3);
  await advance(5_000);
  assert.equal(historyReads, 4);
  await advance(9_999);
  assert.equal(historyReads, 4);
  await advance(1);
  assert.equal(historyReads, 5);
});

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

test("Plex fallback reads a burst across pages and retries a failed later page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  resetOutboundGovernor();
  configureOutboundGovernor("fast");
  t.after(resetOutboundGovernor);
  const events = [];
  const offsets = [];
  let burst = false;
  let failSecondPage = true;
  const marks = Array.from({ length: 11 }, (_, index) => ({
    ratingKey: String(6501 + index), type: "episode", viewCount: 1, lastViewedAt: 1700000010 + index,
  }));
  const seed = { ratingKey: "100", title: "Seed", type: "episode", viewCount: 1, lastViewedAt: 1700000000 };

  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    const json = (body, status = 200) => ({
      ok: status === 200, status, headers: new Headers(), json: async () => body,
    });
    if (parsed.pathname.endsWith("/status/sessions/history/all")) return json({ MediaContainer: { Metadata: [] } });
    if (parsed.pathname.endsWith("/library/sections")) {
      return json({ MediaContainer: { Directory: [{ key: "2", type: "show" }] } });
    }
    if (parsed.pathname.endsWith("/library/sections/2/all")) {
      const start = Number(parsed.searchParams.get("X-Plex-Container-Start"));
      const size = Number(parsed.searchParams.get("X-Plex-Container-Size"));
      offsets.push(start);
      if (start === 10 && failSecondPage) return json({}, 503);
      const items = burst ? [...marks].reverse().concat(seed) : [seed];
      return json({ MediaContainer: { Metadata: items.slice(start, start + size) } });
    }
    return json({}, 404);
  });

  const poller = createPlexAdaptivePoller({
    getPlexConfig: async () => ({ baseUrl: "http://127.0.0.1:32400", token: "mock-token" }),
    onLibraryItemChange: async (ratingKey) => events.push(ratingKey),
    isNotificationConnected: () => true,
  });
  t.after(() => poller.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise(setImmediate);
  };
  poller.start();
  await advance(1_000);
  burst = true;
  await advance(60_000);
  assert.deepEqual(offsets, [0, 0, 10]);
  assert.deepEqual(events, []);

  failSecondPage = false;
  await advance(5_000);
  assert.deepEqual(offsets, [0, 0, 10, 0, 10]);
  assert.deepEqual(events, marks.map(({ ratingKey }) => ratingKey));
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

test("a saved library selection reloads cached Plex sections so a new library is polled at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  resetOutboundGovernor();
  configureOutboundGovernor("fast");
  t.after(resetOutboundGovernor);
  let directories = [{ key: "1", type: "movie" }];
  let sectionListReads = 0;
  const scanned = [];
  const events = [];
  const config = { baseUrl: "http://127.0.0.1:32400", token: "mock-token", monitoredLibraryIds: ["1"], monitoredLibraryRevision: 1 };

  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (parsed.pathname.endsWith("/status/sessions/history/all")) return json({ MediaContainer: { Metadata: [] } });
    if (parsed.pathname.endsWith("/library/sections")) {
      sectionListReads++;
      return json({ MediaContainer: { Directory: directories } });
    }
    const match = parsed.pathname.match(/\/library\/sections\/(\d+)\/all$/);
    if (match) {
      scanned.push(match[1]);
      const items = match[1] === "6" && directories.length > 1
        ? [{ ratingKey: "6528", type: "movie", viewCount: 1, lastViewedAt: 1700000100 }]
        : [];
      return json({ MediaContainer: { Metadata: items } });
    }
    return json({});
  });

  const poller = createPlexAdaptivePoller({
    getPlexConfig: async () => config,
    onLibraryItemChange: async (ratingKey) => events.push(ratingKey),
    isNotificationConnected: () => true,
  });
  t.after(() => poller.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise(setImmediate);
  };

  poller.start();
  await advance(1_000);
  assert.equal(sectionListReads, 1);

  // Same revision: the cached list is reused.
  await advance(60_000);
  assert.equal(sectionListReads, 1);

  // A library is added on Plex and selected in Settings (revision bump).
  directories = [{ key: "1", type: "movie" }, { key: "6", type: "movie" }];
  config.monitoredLibraryIds = ["1", "6"];
  config.monitoredLibraryRevision = 2;
  await advance(60_000);
  assert.equal(sectionListReads, 2);
  assert.ok(scanned.includes("6"));
  assert.deepEqual(events, ["6528"]);
});

test("restart keeps the Plex poller cursor for the same server and reseeds for a different one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  resetOutboundGovernor();
  configureOutboundGovernor("fast");
  t.after(resetOutboundGovernor);
  let marks = [{ ratingKey: "100", type: "movie", viewCount: 1, lastViewedAt: 1700000000 }];
  const events = [];
  const config = { baseUrl: "http://127.0.0.1:32400", token: "mock-token", serverId: "server-a", monitoredLibraryIds: ["1"], monitoredLibraryRevision: 1 };

  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (parsed.pathname.endsWith("/status/sessions/history/all")) return json({ MediaContainer: { Metadata: [] } });
    if (parsed.pathname.endsWith("/library/sections")) return json({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } });
    if (parsed.pathname.endsWith("/library/sections/1/all")) return json({ MediaContainer: { Metadata: marks } });
    return json({});
  });

  const poller = createPlexAdaptivePoller({
    getPlexConfig: async () => config,
    onLibraryItemChange: async (ratingKey) => events.push(ratingKey),
    isNotificationConnected: () => true,
  });
  t.after(() => poller.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise(setImmediate);
  };

  // The first poll seeds the cursor from the newest mark without handling it.
  poller.start();
  await advance(1_000);
  assert.deepEqual(events, []);

  // A manual mark lands, then a settings save restarts the poller before the next poll.
  marks = [{ ratingKey: "200", type: "movie", viewCount: 1, lastViewedAt: 1700000030 }, ...marks];
  poller.restart();
  await advance(1_000);
  assert.deepEqual(events, ["200"]);

  // The connection switches to a different Plex server: its marks are not replayed.
  config.serverId = "server-b";
  marks = [{ ratingKey: "300", type: "movie", viewCount: 1, lastViewedAt: 1700000050 }];
  poller.restart();
  await advance(1_000);
  assert.deepEqual(events, ["200"]);

  // A fresh start (not a restart) still reseeds.
  poller.stop();
  marks = [{ ratingKey: "400", type: "movie", viewCount: 1, lastViewedAt: 1700000070 }, ...marks];
  poller.start();
  await advance(1_000);
  assert.deepEqual(events, ["200"]);
});
