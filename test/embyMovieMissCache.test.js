import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-emby-movie-miss-cache-");

const { findEmbyItems } = await import("../server/src/utils/embyClient.js");

const config = { baseUrl: "http://emby.test", apiKey: "emby-key", userId: "emby-user" };
const media = { type: "movie", title: "Miss Cache Film", ids: { imdb: "tt7777001" } };
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("a failed Emby movie search fallback is not cached as a miss", async () => {
  let searchAvailable = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/Users/emby-user/Items") return json({}, 404);
    // The provider-id lookup answers empty. The title search fails, then succeeds.
    if (url.searchParams.has("AnyProviderIdEquals")) return json({ Items: [] });
    if (!searchAvailable) return json({}, 500);
    return json({ Items: [{ Id: "movie-1", Name: "Miss Cache Film", Type: "Movie", ProviderIds: { Imdb: "tt7777001" } }] });
  };

  await assert.rejects(findEmbyItems(config, media));
  searchAvailable = true;
  const found = await findEmbyItems(config, media);
  assert.deepEqual(found.map((item) => item.Id), ["movie-1"]);
});
