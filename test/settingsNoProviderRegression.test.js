import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The route test uses its own SQLite database and a fetch trap. A configured
// expired Plex account JWT would otherwise make loadMediaConfig() refresh it.
makeTempDataDir("plekt-settings-no-provider-");

const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const mediaConnections = await import("../server/src/utils/mediaConnectionRepo.js");
const { handleWatchlistSync } = await import("../server/src/routes/watchlistSync.js");

test("watchlist sync status GET does not refresh a configured Plex account JWT", async () => {
  const device = mediaConnections.getOrCreatePlexAuthDevice({ deviceName: "Regression test" });
  mediaConnections.saveMediaConnection({
    provider: "plex",
    baseUrl: "http://127.0.0.1:32400",
    serverId: "test-server",
    authDeviceId: device.id,
    remoteUserId: "test-user",
    authKind: "plex_jwt",
    credential: "e30.eyJleHAiOjF9.signature",
    accessTokenExpiresAt: 1,
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("unexpected outbound request");
  };
  try {
    let status = 0;
    let body;
    const req = {
      method: "GET",
      url: "/api/watchlist-sync/status",
      cookies: {},
      get(name) { return name.toLowerCase() === "authorization" ? `Bearer ${AUTH.apiKey}` : ""; },
    };
    const res = {
      status(code) { status = code; return this; },
      set() { return this; },
      send(value) { body = JSON.parse(value); return this; },
    };

    await handleWatchlistSync(req, res);

    assert.equal(status, 200);
    assert.ok(body && typeof body === "object", "status response body is returned");
    assert.deepEqual(calls, [], "status GET made no provider requests");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Settings bootstrap skips automatic Seerr capability refresh while explicit Seerr actions retain it", () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  const services = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-services.js"), "utf8");

  assert.match(app, /if \(state\.activeView !== "settings"\) refreshSeerrCapabilities\(\)\.catch\(\(\) => null\);/,
    "late settings-services module initialization must not refresh capabilities on Settings");
  assert.match(app, /state\.activeView !== "settings" \? refreshSeerrCapabilities\(\)\.catch\(\(\) => null\) : Promise\.resolve\(\)/,
    "config bootstrap must not refresh capabilities on Settings");
  assert.equal((app.match(/refreshSeerrCapabilities\(\)/g) || []).length, 2,
    "both automatic app-level capability refreshes are covered by the Settings guards");

  assert.match(services, /if \(section === "seerr"\) \{[\s\S]*?await refreshSeerrCapabilities\(\)\.catch\(/,
    "saving Seerr settings must still refresh capabilities explicitly");
  assert.match(services, /if \(section === "seerr"\) \{[\s\S]*?await saveServiceConfig\("seerr", def\.payload\(values\)\);[\s\S]*?fetch\("\/api\/seerr\/status"/,
    "testing Seerr must still perform its explicit connection check");
});

test.after(() => db.close());
