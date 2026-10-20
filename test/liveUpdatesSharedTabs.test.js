import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

test("two visible windows share one stream and both receive queue removals", async () => {
  const originalFetch = globalThis.fetch;
  const originalChannel = globalThis.BroadcastChannel;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const channels = new Set();
  class Channel {
    constructor() { channels.add(this); }
    postMessage(data) {
      for (const peer of channels) {
        if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }));
      }
    }
    close() { channels.delete(this); }
  }
  let lockHeld = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (_name, { signal }, callback) => {
      if (!lockHeld) {
        lockHeld = true;
        try { await callback(); } finally { lockHeld = false; }
      } else {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    } },
  } });
  globalThis.BroadcastChannel = Channel;
  let stream;
  let fetches = 0;
  globalThis.fetch = async (_url, { signal }) => {
    fetches += 1;
    return { ok: true, body: new ReadableStream({
      start(controller) {
        stream = controller;
        signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    }) };
  };
  const owner = await import("../public/modules/live-updates.js?owner");
  const follower = await import("../public/modules/live-updates.js?follower");
  const ownerEvents = [];
  const followerEvents = [];
  const histories = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const send = (event) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  try {
    owner.startLiveUpdates({ onUpNextVersion: (version) => ownerEvents.push(version) });
    await tick();
    send({ type: "ready", version: 1, upNextVersion: 10 });
    await tick();
    follower.startLiveUpdates({
      onUpNextVersion: (version, details) => followerEvents.push({ version, ...details }),
      onHistoryVersion: (version) => histories.push(version),
    });
    await tick();
    assert.equal(fetches, 1, "the waiting window must not open another stream");
    assert.equal(followerEvents[0].version, 10, "a new window receives the owner's current snapshot");
    send({ type: "history-version", version: 2, upNextVersion: 11, changes: [] });
    await tick();
    assert.deepEqual(ownerEvents, [10, 11]);
    assert.deepEqual(followerEvents.at(-1), { version: 11, initial: false, pairedWithHistory: true });
    assert.deepEqual(histories, [2]);
    send({ type: "up-next-version", upNextVersion: 12 });
    await tick();
    assert.equal(followerEvents.at(-1).version, 12);
    follower.stopLiveUpdates();
    assert.equal(channels.size, 1, "sign-out closes the forwarding channel");
  } finally {
    follower.stopLiveUpdates();
    owner.stopLiveUpdates();
    globalThis.fetch = originalFetch;
    globalThis.BroadcastChannel = originalChannel;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
