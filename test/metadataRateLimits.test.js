import test from "node:test";
import assert from "node:assert/strict";
import { saveMediaConfig } from "../server/src/utils/configStore.js";
import { searchTmdb } from "../server/src/utils/tmdbGateway.js";
import { resolveTvdbSeriesIdFromEpisodeId } from "../server/src/utils/tvdbGateway.js";
import { acquireOutboundSlot, configureOutboundGovernor, resetOutboundGovernor } from "../server/src/utils/outboundGovernor.js";

test("TMDB exhausts bounded retries then rejects new requests during its cooldown", async t => {
  await saveMediaConfig({ tmdb: { apiKey: "test-key" } });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("", { status: 429, headers: { "retry-after": "0" } }); };
  t.after(() => { globalThis.fetch = originalFetch; resetOutboundGovernor(); });
  await assert.rejects(searchTmdb({ query: "audit-rate-limit-one" }), /429/);
  assert.equal(requests, 3);
  await assert.rejects(searchTmdb({ query: "audit-rate-limit-two" }), /cooling down/);
  assert.equal(requests, 3);
});

test("TVDB 429 retry retains sync admission while enrichment capacity is occupied", async t => {
  resetOutboundGovernor();
  configureOutboundGovernor("standard");
  const originalFetch = globalThis.fetch;
  const held = [await acquireOutboundSlot("api4.thetvdb.com", { lane: "enrichment" }), await acquireOutboundSlot("api4.thetvdb.com", { lane: "enrichment" })];
  let episodeRequests = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/login")) return new Response(JSON.stringify({ data: { token: "fake-token" } }), { status: 200 });
    episodeRequests++;
    if (episodeRequests === 1) {
      // Both enrichment slots remain occupied across the original call and retry.
      return new Response("", { status: 429, headers: { "retry-after": "0.1" } });
    }
    return new Response(JSON.stringify({ data: { seriesId: 42 } }), { status: 200 });
  };
  t.after(() => { held.forEach(release => release()); globalThis.fetch = originalFetch; resetOutboundGovernor(); });
  let timeout;
  try {
    const result = await Promise.race([
      resolveTvdbSeriesIdFromEpisodeId("123", { lane: "sync" }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("sync retry blocked by enrichment capacity")), 3000); }),
    ]);
    assert.equal(result, "42");
    assert.equal(episodeRequests, 2);
  } finally { clearTimeout(timeout); }
});
