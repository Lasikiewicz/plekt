import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-emby-up-next-rail-session-");
const { touchEmbyResumeRail, UP_NEXT_SEED_DEVICE_ID, isUpNextSeedDeviceId } = await import("../server/src/utils/embyClient.js");

test("the Emby Up Next rail session is labelled Plekt and keeps the device id the live readers filter on", async (t) => {
  const originalFetch = globalThis.fetch;
  const sessionHeaders = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/Sessions/Playing")) {
      const headers = new Headers(options.headers || {});
      sessionHeaders.push({ path: url.pathname, authorization: headers.get("x-emby-authorization") || "" });
      return new Response(null, { status: 204 });
    }
    if (String(options.method || "GET").toUpperCase() === "POST") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ UserData: { PlayCount: 2, Played: false, PlaybackPositionTicks: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await touchEmbyResumeRail({ baseUrl: "http://emby.test", apiKey: "k", userId: "u" }, "1787032");

  assert.deepEqual(
    sessionHeaders.map((entry) => entry.path),
    ["/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"],
  );
  for (const { authorization } of sessionHeaders) {
    assert.match(authorization, /Device="Plekt Up Next"/);
    assert.ok(authorization.includes(`DeviceId="${UP_NEXT_SEED_DEVICE_ID}"`), "the device id stays so the live readers keep skipping it");
  }
  assert.ok(isUpNextSeedDeviceId(UP_NEXT_SEED_DEVICE_ID));
});
