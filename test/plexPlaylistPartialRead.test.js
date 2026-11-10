import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-playlist-partial-read-");

const { providerPlaylistClient } = await import("../server/src/utils/providerPlaylists.js");

const plexConfig = { baseUrl: "http://plex.test", token: "plex-token" };

function stubFetch(t, response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response();
  t.after(() => { globalThis.fetch = originalFetch; });
}

test("a 200 playlist items body that is not JSON throws instead of reading as an empty playlist", async (t) => {
  stubFetch(t, () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } }));
  await assert.rejects(providerPlaylistClient("plex").fetchPlaylistItems(plexConfig, "900"), /unrecognised|not JSON|unexpected/i);
});

test("a 200 playlist items body in no Plex shape throws instead of reading as an empty playlist", async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(providerPlaylistClient("plex").fetchPlaylistItems(plexConfig, "900"), /unrecognised|unexpected/i);
});

test("a genuinely empty Plex playlist still reads as zero entries", async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ MediaContainer: { size: 0 } }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.deepEqual(await providerPlaylistClient("plex").fetchPlaylistItems(plexConfig, "900"), []);
});
