import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const bootSource = fs.readFileSync(path.join(root, "public/theme-boot.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const assetVersion = indexSource.match(/theme-boot\.js\?v=([A-Za-z0-9._-]+)/)?.[1];

// Runs public/theme-boot.js against a minimal DOM and returns what it did.
function runBoot({ saved, prefersDark, style = null, cardArt = null, backgroundArt = null }) {
  const art = { "plekt:card-art": cardArt, "plekt:background-art": backgroundArt };
  const removed = [];
  const classes = new Set();
  const attributes = {};
  const appended = [];
  const listeners = {};
  let observerCallback = null;
  const makeImg = (src = "") => {
    const attributes = src ? { src } : {};
    return {
      nodeType: 1,
      attributes,
      getAttribute: (name) => attributes[name] ?? null,
      set src(value) { attributes.src = value; },
      get src() { return attributes.src; },
      matches: (selector) => selector === "img[data-theme-logo]",
      querySelectorAll: () => [],
    };
  };
  const documentElement = {
    nodeType: 1,
    classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)) },
    setAttribute: (name, value) => { attributes[name] = value; },
    matches: () => false,
    querySelectorAll: () => [],
  };
  const context = {
    localStorage: { getItem: (key) => ({ "plembfin:theme": saved, "plembfin:style": style })[key] ?? null, removeItem: (key) => removed.push(key) },
    window: { matchMedia: (query) => ({ matches: query === "(prefers-color-scheme: dark)" ? prefersDark : false }) },
    document: {
      documentElement,
      head: { appendChild: (node) => appended.push(node) },
      createElement: (tag) => ({ tag }),
      addEventListener: (type, callback) => { listeners[type] = callback; },
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() { observerCallback = null; }
    },
  };
  const getStored = context.localStorage.getItem;
  context.localStorage.getItem = (key) => art[key] ?? getStored(key);
  vm.runInNewContext(bootSource, context);
  const parsed = makeImg();
  const alreadySet = makeImg("/custom.png");
  observerCallback?.([{ addedNodes: [parsed, alreadySet] }]);
  return { light: classes.has("light-mode"), dataStyle: attributes["data-style"], cardArt: attributes["data-card-art"], backgroundArt: attributes["data-background-art"], removed, preload: appended[0], parsed, alreadySet, listeners };
}

test("theme boot clears the old Classic/Modern style key and sets no style attribute", () => {
  for (const saved of ["light", "dark"]) {
    for (const style of [null, "classic", "modern"]) {
      const result = runBoot({ saved, prefersDark: true, style });
      const label = `saved=${saved} style=${style}`;
      assert.equal(result.dataStyle, undefined, label);
      assert.equal(result.light, saved === "light", `${label}: the style does not change the mode`);
      assert.deepEqual(result.removed, ["plembfin:style"], label);
    }
  }
});

test("theme boot marks Card Art and Background Art off only when this browser turned them off", () => {
  const fresh = runBoot({ saved: null, prefersDark: true });
  assert.equal(fresh.cardArt, undefined, "a new browser shows card art");
  assert.equal(fresh.backgroundArt, undefined, "a new browser shows background art");
  const cardOff = runBoot({ saved: "dark", prefersDark: true, cardArt: "off" });
  assert.equal(cardOff.cardArt, "off");
  assert.equal(cardOff.backgroundArt, undefined);
  const backgroundOff = runBoot({ saved: "light", prefersDark: true, backgroundArt: "off" });
  assert.equal(backgroundOff.cardArt, undefined);
  assert.equal(backgroundOff.backgroundArt, "off");
  const unknown = runBoot({ saved: null, prefersDark: true, cardArt: "on", backgroundArt: "maybe" });
  assert.equal(unknown.cardArt, undefined);
  assert.equal(unknown.backgroundArt, undefined);
});

test("theme boot follows the saved theme first, then the system preference", () => {
  const cases = [
    { saved: "light", prefersDark: true, light: true },
    { saved: "dark", prefersDark: false, light: false },
    { saved: null, prefersDark: false, light: true },
    { saved: null, prefersDark: true, light: false },
  ];
  for (const { saved, prefersDark, light } of cases) {
    const result = runBoot({ saved, prefersDark });
    // Versioned like every other asset, so production caches it immutably.
    const logo = `/plekt_header_logo_${light ? "light" : "dark"}.png?v=${assetVersion}`;
    const label = `saved=${saved} prefersDark=${prefersDark}`;
    assert.equal(result.light, light, label);
    // Exactly one logo variant is requested: the preload and every parsed logo agree.
    assert.deepEqual({ rel: result.preload.rel, as: result.preload.as, href: result.preload.href }, { rel: "preload", as: "image", href: logo }, label);
    assert.equal(result.parsed.src, logo, label);
    assert.equal(result.alreadySet.src, "/custom.png", `${label}: an explicit src is left alone`);
    assert.equal(typeof result.listeners.DOMContentLoaded, "function", label);
  }
});

test("the theme boot runs before the stylesheet and no logo carries a src in the markup", () => {
  const boot = indexSource.indexOf('<script src="/theme-boot.js?v=');
  assert.ok(boot > 0, "index.html must load theme-boot.js");
  assert.ok(boot < indexSource.indexOf('rel="stylesheet"'), "theme-boot.js must run before the stylesheet and body");
  assert.ok(boot < indexSource.indexOf("<body"), "theme-boot.js must be in <head>");
  // A logo src in the markup would be fetched by the preload scanner regardless of theme.
  assert.doesNotMatch(indexSource, /plekt_header_logo_(?:dark|light)\.png/);
  for (const match of indexSource.matchAll(/<img[^>]*class="(?:brand-logo|auth-brand-logo|about-page-brand-logo)"[^>]*>/g)) {
    assert.match(match[0], /data-theme-logo/, match[0]);
    assert.doesNotMatch(match[0], /\ssrc=/, match[0]);
  }
});
