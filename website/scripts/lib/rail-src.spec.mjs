import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedRailSrc } from "./rail-src.mjs";

const base = "http://localhost:5056/app/";

test("absolute http(s) artwork URLs are allowed", () => {
  assert.equal(isAllowedRailSrc("https://image.tmdb.org/t/p/w500/poster.jpg", base), true);
  assert.equal(isAllowedRailSrc("http://localhost:5056/assets/poster.jpg", base), true);
  assert.equal(isAllowedRailSrc("HTTPS://image.tmdb.org/poster.jpg", base), true);
});

test("site-relative paths on the captured origin are allowed", () => {
  assert.equal(isAllowedRailSrc("/api/images/poster.jpg", base), true);
});

test("protocol-relative and backslash forms that leave the site are rejected", () => {
  assert.equal(isAllowedRailSrc("//evil.example/poster.jpg", base), false);
  assert.equal(isAllowedRailSrc("/\\evil.example/poster.jpg", base), false);
  assert.equal(isAllowedRailSrc("/\t/evil.example/poster.jpg", base), false);
  assert.equal(isAllowedRailSrc("/\n/evil.example/poster.jpg", base), false);
});

test("other schemes and bare relative paths are rejected", () => {
  assert.equal(isAllowedRailSrc("javascript:alert(1)", base), false);
  assert.equal(isAllowedRailSrc("data:image/png;base64,AAAA", base), false);
  assert.equal(isAllowedRailSrc("https:evil.example/poster.jpg", base), false);
  assert.equal(isAllowedRailSrc("poster.jpg", base), false);
  assert.equal(isAllowedRailSrc("", base), false);
  assert.equal(isAllowedRailSrc(null, base), false);
});

test("an unusable base rejects instead of throwing", () => {
  assert.equal(isAllowedRailSrc("/poster.jpg", "about:blank"), false);
});
