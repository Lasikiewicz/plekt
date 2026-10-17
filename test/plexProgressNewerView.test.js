import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-plex-progress-newer-view-test-");

const { setPlexProgress } = await import("../server/src/utils/plexClient.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
});

const plexConfig = { baseUrl: "https://plex.example.test", token: "plex-token" };

function stubPlex(t, metadata) {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/unscrobble") || url.pathname.endsWith("/:/progress")) {
      writes.push(url.pathname);
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example", ...metadata }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return writes;
}

function resumeMedia(updatedAt) {
  return {
    isValid: true,
    source: "emby",
    type: "movie",
    title: "Example",
    ids: { tmdb: "123" },
    providerItems: { plex: ["42"] },
    positionMs: 1_805_676,
    progress: 65,
    updatedAt,
  };
}

test("a propagated resume position does not unscrobble a newer completed Plex view", async (t) => {
  const viewedAt = Date.parse("2026-10-17T12:30:00.000Z");
  const writes = stubPlex(t, { viewCount: 1, lastViewedAt: viewedAt / 1000 });

  const result = await setPlexProgress(plexConfig, resumeMedia(Date.parse("2026-10-17T12:16:36.000Z")), { protectNewerView: true });

  assert.equal(result.status, "skipped");
  assert.deepEqual(writes, []);
});

test("a resume position newer than the Plex view is still written", async (t) => {
  const viewedAt = Date.parse("2026-10-17T12:30:00.000Z");
  const writes = stubPlex(t, { viewCount: 1, lastViewedAt: viewedAt / 1000 });

  const result = await setPlexProgress(plexConfig, resumeMedia(Date.parse("2026-10-17T13:00:00.000Z")), { protectNewerView: true });

  assert.equal(result.status, "fulfilled");
  assert.deepEqual(writes, ["/:/unscrobble", "/:/progress"]);
});

test("progress clears without the protection still unscrobble a watched Plex item", async (t) => {
  const writes = stubPlex(t, { viewCount: 1, lastViewedAt: Date.parse("2026-10-17T12:30:00.000Z") / 1000 });

  const result = await setPlexProgress(plexConfig, { ...resumeMedia(0), positionMs: 0, progress: 0 });

  assert.equal(result.status, "fulfilled");
  assert.deepEqual(writes, ["/:/unscrobble", "/:/progress"]);
});
