import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const calls = { admin: true, sent: null };
globalThis.legacyImageRouteFixture = calls;
const source = (code) => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (!context.parentURL?.endsWith("/routes/legacyImage.js")) return next(specifier, context);
  const preamble = "const f = globalThis.legacyImageRouteFixture;";
  const modules = {
    "../utils/auth.js": "export const requireAdmin = async () => f.admin;",
    "../utils/http.js": "export const sendJson = (res, data, status=200, headers={}) => {f.sent={data,status,headers}}; export const sendOptions=()=>{f.sent='options'}; export const methodNotAllowed=()=>{f.sent='405'};",
  };
  return modules[specifier] ? source(preamble + modules[specifier]) : next(specifier, context);
} });
const { isLegacyImage, legacyImageNotice, LEGACY_IMAGE_MIN_SUPPORT_DATE } = await import("../server/src/utils/legacyImage.js");
const { handleLegacyImage } = await import("../server/src/routes/legacyImage.js");

test("flag unset or false-like means no legacy image", () => {
  for (const value of [undefined, "", "0", "false", "no", "off", "plekt"]) {
    assert.equal(isLegacyImage({ PLEKT_LEGACY_IMAGE: value }), false, String(value));
    assert.deepEqual(legacyImageNotice({ PLEKT_LEGACY_IMAGE: value }), { legacyImage: false });
  }
  assert.deepEqual(legacyImageNotice({}), { legacyImage: false });
});

test("flag set reports the notice with the installed version and new images", () => {
  for (const value of ["1", "true", " YES ", "on"]) assert.equal(isLegacyImage({ PLEKT_LEGACY_IMAGE: value }), true, value);
  const notice = legacyImageNotice({ PLEKT_LEGACY_IMAGE: "1" });
  assert.equal(notice.legacyImage, true);
  assert.match(notice.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(notice.newImages, ["ghcr.io/lasikiewicz/plekt", "plembfin/plekt"]);
  assert.equal(notice.supportedUntil, LEGACY_IMAGE_MIN_SUPPORT_DATE);
  assert.match(notice.switchUrl, /^https:\/\/plekt\.net\//);
});

test("route is admin-only, GET-only and never cached", async () => {
  const saved = process.env.PLEKT_LEGACY_IMAGE;
  try {
    delete process.env.PLEKT_LEGACY_IMAGE;
    calls.admin = true; calls.sent = null;
    await handleLegacyImage({ method: "GET" }, {});
    assert.deepEqual(calls.sent.data, { legacyImage: false });
    assert.equal(calls.sent.headers["Cache-Control"], "private, no-store");

    process.env.PLEKT_LEGACY_IMAGE = "1";
    calls.sent = null;
    await handleLegacyImage({ method: "GET" }, {});
    assert.equal(calls.sent.data.legacyImage, true);

    calls.admin = false; calls.sent = null;
    await handleLegacyImage({ method: "GET" }, {});
    assert.equal(calls.sent, null, "non-admin gets nothing from the handler");

    calls.admin = true;
    await handleLegacyImage({ method: "POST" }, {});
    assert.equal(calls.sent, "405");
  } finally {
    if (saved === undefined) delete process.env.PLEKT_LEGACY_IMAGE; else process.env.PLEKT_LEGACY_IMAGE = saved;
  }
});
