import test from "node:test";
import assert from "node:assert/strict";
import { retryAfterMs } from "../server/src/utils/retryAfter.js";
import { noteOutboundResponse, outboundGovernorTelemetry, resetOutboundGovernor } from "../server/src/utils/outboundGovernor.js";
import { createPlexNotificationListener } from "../server/src/utils/plexNotificationListener.js";
import { cacheArtworkFromUrl } from "../server/src/utils/posterCache.js";
import { runWithConcurrency } from "../server/src/utils/concurrency.js";

test("episode batch pool completes every episode within its four-worker cap", async () => {
  const episodes = Array.from({ length: 25 }, (_, Id) => ({ Id }));
  let active = 0, peak = 0;
  const completed = [];
  await runWithConcurrency(episodes, async ep => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    completed.push(ep.Id);
    active--;
  }, 4);
  assert.equal(peak, 4);
  assert.deepEqual(completed.sort((a, b) => a - b), episodes.map(ep => ep.Id));
});

test("Retry-After parses HTTP dates and bounds malformed and excessive waits", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  assert.equal(retryAfterMs("Thu, 05 Nov 2026 12:00:12 GMT", { now }), 12_000);
  assert.equal(retryAfterMs("999999999999"), 120_000);
  assert.equal(retryAfterMs("invalid"), 1000);
  assert.equal(retryAfterMs("-2"), 0);
  resetOutboundGovernor();
  const started = Date.now();
  noteOutboundResponse("clamp.test", 429, "999999999999");
  assert.ok(outboundGovernorTelemetry().destinations[0].cooldownUntil <= started + 120_010);
  resetOutboundGovernor();
});

test("Plex restart during config loading opens only the newest socket", async () => {
  const pending = [], sockets = [];
  const listener = createPlexNotificationListener({
    getPlexConfig: () => new Promise(resolve => pending.push(resolve)),
    onLibraryItemChange() {}, logger() {},
    socketFactory: () => { const ws = { close() {} }; sockets.push(ws); return ws; },
  });
  try {
    listener.start();
    listener.restart();
    const config = { baseUrl: "http://plex.test", token: "token" };
    pending[1](config);
    await Promise.resolve();
    pending[0](config);
    await Promise.resolve();
    assert.equal(sockets.length, 1);
  } finally { listener.stop(); }
});

test("short-lived Plex connections retain exponential reconnect backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const sockets = [];
  const listener = createPlexNotificationListener({ getPlexConfig: async () => ({ baseUrl: "http://plex.test", token: "token" }),
    onLibraryItemChange() {}, logger() {}, socketFactory: () => { const ws = { close() {} }; sockets.push(ws); return ws; } });
  try {
    listener.start(); await Promise.resolve();
    sockets[0].onopen(); sockets[0].onclose();
    t.mock.timers.tick(3000); await Promise.resolve();
    assert.equal(sockets.length, 2);
    sockets[1].onopen(); sockets[1].onclose();
    t.mock.timers.tick(3000); await Promise.resolve();
    assert.equal(sockets.length, 2);
    t.mock.timers.tick(3000); await Promise.resolve();
    assert.equal(sockets.length, 3);
    sockets[2].onopen();
    t.mock.timers.tick(30_000); await Promise.resolve();
    sockets[2].onclose();
    t.mock.timers.tick(3000); await Promise.resolve();
    assert.equal(sockets.length, 4, "stable connection resets the delay to three seconds");
  } finally { listener.stop(); }
});

test("artwork stops an oversized chunked response without Content-Length", async t => {
  const originalFetch = globalThis.fetch;
  let cancelled = false, chunks = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "image/jpeg" } });
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await cacheArtworkFromUrl("oversized-audit", "https://artwork-audit.test/large.jpg", "test"), null);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 12, "stream cancelled as soon as it exceeds 10 MiB");
});
