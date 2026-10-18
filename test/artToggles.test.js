import test from "node:test";
import assert from "node:assert/strict";

const stored = new Map();
const attributes = new Map();
const events = [];
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
globalThis.CustomEvent ??= class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.document = {
  documentElement: {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  },
  addEventListener() {},
  dispatchEvent: (event) => events.push(event),
  querySelector: () => null,
  createElement: () => ({ append() {} }),
  head: { append() {} },
};

const { ART_TOGGLE_EVENT, isArtEnabled, setArtEnabled } = await import("../public/modules/appearance.js");
const { observeCardArtwork } = await import("../public/modules/card-art.js");

test("Card Art and Background Art are on by default", () => {
  assert.equal(isArtEnabled("card"), true);
  assert.equal(isArtEnabled("background"), true);
});

test("turning an art toggle off saves it for this browser and marks the page", () => {
  setArtEnabled("card", false);
  assert.equal(stored.get("plekt:card-art"), "off");
  assert.equal(attributes.get("data-card-art"), "off");
  assert.equal(isArtEnabled("card"), false);
  assert.equal(isArtEnabled("background"), true, "the other toggle is untouched");
  assert.deepEqual(events.at(-1).detail, { kind: "card", enabled: false });
  assert.equal(events.at(-1).type, ART_TOGGLE_EVENT);

  setArtEnabled("card", true);
  assert.equal(stored.has("plekt:card-art"), false);
  assert.equal(attributes.has("data-card-art"), false);
  assert.equal(isArtEnabled("card"), true);

  setArtEnabled("background", false);
  assert.equal(stored.get("plekt:background-art"), "off");
  assert.equal(attributes.get("data-background-art"), "off");
  setArtEnabled("background", true);
  assert.equal(stored.has("plekt:background-art"), false);
});

test("with Card Art off, cards are not watched for backdrop lookups", () => {
  const observed = [];
  const card = { getAttribute: () => "movie|1|||Toggle fixture" };
  const originalObserver = globalThis.IntersectionObserver;
  const originalWindowObserver = window.IntersectionObserver;
  class FakeObserver {
    observe(node) { observed.push(node); }
    unobserve() {}
  }
  globalThis.IntersectionObserver = FakeObserver;
  window.IntersectionObserver = FakeObserver;
  try {
    setArtEnabled("card", false);
    observeCardArtwork({ querySelectorAll: () => [card] });
    assert.deepEqual(observed, []);
    setArtEnabled("card", true);
    observeCardArtwork({ querySelectorAll: () => [card] });
    assert.deepEqual(observed, [card]);
  } finally {
    globalThis.IntersectionObserver = originalObserver;
    window.IntersectionObserver = originalWindowObserver;
  }
});
