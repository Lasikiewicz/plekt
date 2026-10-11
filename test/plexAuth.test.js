import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPlexPin, decodeJwtClaims, plexAuthUrl, plexClientHeaders, pollPlexPin, refreshPlexJwt, signPlexDeviceJwt } from "../server/src/utils/plexAuth.js";

function fixtureDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { device: { deviceIdentifier: "stable-device", publicJwk: { ...jwk, kid: "key-id", alg: "EdDSA", use: "sig" } }, privateKey };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function textResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("Plex device JWT is Ed25519-signed with bounded claims", () => {
  const { device, privateKey } = fixtureDevice();
  const token = signPlexDeviceJwt({ device, privateKey, nonce: "nonce-1", now: 1_700_000_000_000 });
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url")), { kid: "key-id", alg: "EdDSA", typ: "JWT" });
  assert.equal(decodeJwtClaims(token).nonce, "nonce-1");
  assert.equal(decodeJwtClaims(token).exp - decodeJwtClaims(token).iat, 300);
  assert.equal(crypto.verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), crypto.createPublicKey(privateKey), Buffer.from(encodedSignature, "base64url")), true);
});

test("Plex PIN creation binds the JWK in the single strong-PIN request", async () => {
  const { device } = fixtureDevice();
  let request;
  const pin = await createPlexPin(device, { fetchImpl: async (url, options) => { request = { url: String(url), options }; return jsonResponse({ id: 42, code: "ABCD", expiresIn: 60 }); } });
  assert.equal(request.url, "https://clients.plex.tv/api/v2/pins");
  assert.deepEqual(JSON.parse(request.options.body), { strong: true, jwk: device.publicJwk });
  assert.equal(pin.id, "42");
});

test("Plex cloud requests carry the stable device identity and access token", () => {
  const { device } = fixtureDevice();
  const headers = plexClientHeaders(device, { token: "account-token" });
  assert.equal(headers["X-Plex-Client-Identifier"], "stable-device");
  assert.equal(headers["X-Plex-Product"], "Plembfin");
  // Decision D7: a device registered since the rename announces itself as Plekt;
  // one registered before keeps the name its server already lists.
  assert.equal(plexClientHeaders({ ...device, deviceName: "Plekt" })["X-Plex-Product"], "Plekt");
  assert.equal(plexClientHeaders({ ...device, deviceName: "Plembfin" })["X-Plex-Product"], "Plembfin");
  assert.equal(headers["X-Plex-Token"], "account-token");
});

test("Plex auth URL only includes a configured public return origin", () => {
  const { device } = fixtureDevice();
  assert.doesNotMatch(plexAuthUrl({ device, code: "ABCD" }), /forwardUrl/);
  assert.match(plexAuthUrl({ device, code: "ABCD", publicBaseUrl: "https://media.example" }), /forwardUrl=https%3A%2F%2Fmedia.example%2Fauth%2Fplex%2Freturn/);
});

test("Plex hosted auth can request a strong PIN without opting into device JWT", async () => {
  const { device } = fixtureDevice();
  let request;
  await createPlexPin(device, {
    strong: true,
    includeJwk: false,
    originUrl: "https://media.example/setup",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({ id: 42, code: "long-code", expiresIn: 60 });
    },
  });
  assert.equal(request.options.headers.Origin, "https://media.example");
  assert.deepEqual(JSON.parse(request.options.body), { strong: true });
});

test("Plex strong PIN polling requests XML and extracts the refreshable JWT", async () => {
  const { device, privateKey } = fixtureDevice();
  let request;
  const result = await pollPlexPin({
    device,
    privateKey,
    pinId: "42",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return textResponse('<pin id="42" authToken="header.claims.signature" />');
    },
  });
  assert.match(request.url, /^https:\/\/clients\.plex\.tv\/api\/v2\/pins\/42\?deviceJWT=/);
  assert.equal(request.options.headers.Accept, "application/xml");
  assert.deepEqual(result, { authorised: true, token: "header.claims.signature" });
});

test("Plex strong PIN polling remains pending when Plex has not supplied a token", async () => {
  const { device, privateKey } = fixtureDevice();
  const result = await pollPlexPin({ device, privateKey, pinId: "42", fetchImpl: async () => textResponse('<pin id="42" authToken="" />') });
  assert.deepEqual(result, { authorised: false, token: "" });
});

test("Plex legacy PIN polling still accepts JSON responses", async () => {
  const { device } = fixtureDevice();
  const result = await pollPlexPin({ device, privateKey: null, pinId: "42", strong: false, fetchImpl: async () => textResponse('{"authToken":"legacy-token"}') });
  assert.deepEqual(result, { authorised: true, token: "legacy-token" });
});

test("Plex refresh obtains a nonce and exchanges a signed device JWT", async () => {
  const { device, privateKey } = fixtureDevice();
  const accessClaims = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
  const accessToken = `e30.${accessClaims}.signature`;
  const calls = [];
  const result = await refreshPlexJwt({ device, privateKey, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return calls.length === 1 ? jsonResponse({ nonce: "fresh" }) : jsonResponse({ auth_token: accessToken }); } });
  assert.equal(calls[0].url, "https://clients.plex.tv/api/v2/auth/nonce");
  assert.equal(calls[1].url, "https://clients.plex.tv/api/v2/auth/token");
  assert.equal(decodeJwtClaims(JSON.parse(calls[1].options.body).jwt).nonce, "fresh");
  assert.equal(result.expiresAt, 1_800_000_000_000);
});
