import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-live-poller-");
const { createLiveSessionPoller } = await import("../server/src/utils/liveSessionPoller.js");

test("idle polls wait five minutes, active tracking stays fast, and explicit refresh still works", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let result = { hasActiveSession: false, failed: false };
  const poller = createLiveSessionPoller({ refresh: async () => { calls++; return result; } });
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
  };
  try {
    poller.start();
    await tick(1000);
    assert.equal(calls, 1, "startup still checks promptly");
    await tick(299_999);
    assert.equal(calls, 1, "idle does not poll before five minutes");
    result = { hasActiveSession: true, failed: false };
    await tick(1);
    assert.equal(calls, 2);
    await tick(9_999);
    assert.equal(calls, 2);
    await tick(1);
    assert.equal(calls, 3, "detected playback polls every ten seconds");
    result = { hasActiveSession: false, failed: true };
    await tick(10_000);
    await tick(29_999);
    assert.equal(calls, 4);
    result = { hasActiveSession: false, failed: false };
    await tick(1);
    assert.equal(calls, 5, "failed polls retain the thirty-second retry");
    poller.poke();
    await tick(50);
    assert.equal(calls, 6, "a notification/viewer refresh bypasses the idle wait");
    poller.stop();
    await tick(300_000);
    assert.equal(calls, 6, "stopping cancels the idle timer");
  } finally {
    poller.stop();
  }
});
