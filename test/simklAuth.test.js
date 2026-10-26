import { simklTransport } from "../server/src/utils/trackers/simklTransport.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  startSimklDeviceAuth, pollSimklDeviceAuth, refreshSimklToken, getSimklUser,
  simklDevicePollOutcome, validateSimklTokens, SIMKL_SCOPES,
} from "../server/src/utils/trackers/simklAuth.js";
import { makeTempDataDir } from "./helpers.js";

// The registry reaches db.js through the Simkl adapter: set the data dir first.
makeTempDataDir("plekt-simkl-auth-");
const { isTrackerProvider } = await import("../server/src/utils/trackers/registry.js");

const tokens = { access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", expires_in: 604800, scope: SIMKL_SCOPES };
const device = { device_code: "private-device", user_code: "ABCD-EFGH", verification_uri: "https://simkl.com/pin", verification_uri_complete: "https://simkl.com/pin?user_code=ABCD-EFGH", expires_in: 900, interval: 5 };

async function withFetch(handler, work) {
  simklTransport.resetForTests();
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try { await work(); } finally { globalThis.fetch = previous; }
}

test("Simkl device authorization requests explicit scopes without a bundled secret or invented PKCE", async () => {
  await withFetch(async (url, options) => {
    assert.equal(String(url), "https://api.simkl.com/oauth2/device");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["simkl-api-key"], "client");
    assert.deepEqual(JSON.parse(options.body), { client_id: "client", scope: SIMKL_SCOPES });
    return Response.json(device);
  }, async () => {
    assert.deepEqual(await startSimklDeviceAuth("client"), {
      device_code: device.device_code, user_code: device.user_code,
      verification_url: device.verification_uri_complete, expires_in: 900, interval: 5,
    });
    assert.equal(isTrackerProvider("simkl"), true, "the device flow serves the registered Simkl adapter");
  });
});

test("Simkl rejects malformed device responses and unsafe consent URLs", async () => {
  for (const changes of [
    { device_code: "" }, { user_code: null }, { expires_in: 0 }, { interval: "5" },
    { verification_uri_complete: "https://evil.example/pin" },
    { verification_uri_complete: "javascript:alert(1)" },
    { verification_uri_complete: "https://user:secret@simkl.com/pin" },
  ]) {
    await withFetch(async () => Response.json({ ...device, ...changes }), async () => {
      await assert.rejects(startSimklDeviceAuth("client"), { code: "SIMKL_INVALID_RESPONSE" });
    });
  }
  await withFetch(async () => Response.json({ ...device, verification_uri_complete: undefined }), async () => {
    assert.equal((await startSimklDeviceAuth("client")).verification_url, device.verification_uri);
  });
});

test("Simkl exchanges device and refresh grants using JSON bodies, never URL credentials", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    assert.equal(String(url), "https://api.simkl.com/oauth2/token");
    calls.push(JSON.parse(options.body));
    return Response.json(tokens);
  }, async () => {
    assert.deepEqual(await pollSimklDeviceAuth({ clientId: "client", deviceCode: "private-device" }), tokens);
    assert.deepEqual(await refreshSimklToken({ clientId: "client", refreshToken: "private-refresh" }), tokens);
    assert.deepEqual(calls, [
      { client_id: "client", device_code: "private-device", grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      { client_id: "client", refresh_token: "private-refresh", grant_type: "refresh_token" },
    ]);
  });
});

test("Simkl rejects silently downgraded read-only grants and incomplete token responses", () => {
  for (const scope of ["media:read", "public", "media:write", ""]) {
    assert.throws(() => validateSimklTokens({ ...tokens, scope }), { code: "SIMKL_SCOPE_REQUIRED" });
  }
  for (const changes of [{ access_token: "" }, { refresh_token: null }, { expires_in: -1 }, { token_type: "Other" }, { scope: null }]) {
    assert.throws(() => validateSimklTokens({ ...tokens, ...changes }), { code: "SIMKL_INVALID_RESPONSE" });
  }
});

test("Simkl OAuth errors retain only allowlisted codes/status/backoff and never upstream secrets", async () => {
  for (const code of ["authorization_pending", "slow_down", "expired_token", "invalid_client", "private-access"]) {
    await withFetch(async () => Response.json({ error: code, error_description: "private-access private-device private-refresh", access_token: "private-access" }, { status: 400, headers: { "retry-after": "2" } }), async () => {
      await assert.rejects(pollSimklDeviceAuth({ clientId: "client", deviceCode: "private-device" }), (error) => {
        assert.equal(error.code, code === "private-access" ? "SIMKL_REQUEST_FAILED" : code);
        assert.equal(error.status, 400);
        assert.equal(error.retryAfter, 2);
        assert.equal(error.body, undefined);
        assert.doesNotMatch(error.stack + JSON.stringify(error), /private-access|private-device|private-refresh/);
        return true;
      });
    });
  }
});

test("Simkl device polling distinguishes OAuth states rather than treating every 400 as pending", () => {
  assert.deepEqual(simklDevicePollOutcome({ status: 400, code: "authorization_pending" }, 10), { status: "pending", intervalSeconds: 10 });
  assert.deepEqual(simklDevicePollOutcome({ status: 400, code: "slow_down" }, 10), { status: "pending", intervalSeconds: 15 });
  assert.deepEqual(simklDevicePollOutcome({ status: 400, code: "expired_token" }), { status: "expired" });
  assert.deepEqual(simklDevicePollOutcome({ status: 429, retryAfter: 30 }), { status: "pending", intervalSeconds: 30 });
  for (const code of ["invalid_request", "invalid_client", "invalid_grant", "access_denied", "server_error"]) {
    assert.equal(simklDevicePollOutcome({ status: 400, code }), null);
  }
  assert.equal(simklDevicePollOutcome({ status: 503 }), null);
});

test("Simkl identity uses validated account ID and sends bearer token only in headers", async () => {
  await withFetch(async (url, options) => {
    assert.equal(String(url), "https://api.simkl.com/users/settings");
    assert.equal(options.headers.authorization, "Bearer private-access");
    return Response.json({ account: { id: 123 }, user: { name: "Test user" } });
  }, async () => {
    assert.deepEqual(await getSimklUser({ clientId: "client", accessToken: "private-access" }), { remoteUserId: "123", remoteUsername: "Test user" });
  });
  for (const account of [undefined, {}, { id: null }, { id: 0 }, { id: {} }]) {
    await withFetch(async () => Response.json({ account }), async () => {
      await assert.rejects(getSimklUser({ clientId: "client", accessToken: "private-access" }), { code: "SIMKL_INVALID_RESPONSE" });
    });
  }
});

test("Simkl malformed successful JSON is an error rather than a usable empty connection", async () => {
  await withFetch(async () => new Response("not-json"), async () => {
    await assert.rejects(startSimklDeviceAuth("client"), { code: "SIMKL_INVALID_RESPONSE" });
  });
  await assert.rejects(startSimklDeviceAuth(""), /Client ID is required/);
});
