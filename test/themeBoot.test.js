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
function runBoot({ saved, prefersDark, style = null }) {
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
    localStorage: { getItem: (key) => ({ "plembfin:theme": saved, "plembfin:style": style })[key] ?? null },
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
  vm.runInNewContext(bootSource, context);
  const parsed = makeImg();
  const alreadySet = makeImg("/custom.png");
  observerCallback?.([{ addedNodes: [parsed, alreadySet] }]);
  return { light: classes.has("light-mode"), dataStyle: attributes["data-style"], preload: appended[0], parsed, alreadySet, listeners };
}

test("theme boot applies the saved Modern style independently of the mode; anything else is Classic", () => {
  for (const saved of ["light", "dark"]) {
    const modern = runBoot({ saved, prefersDark: true, style: "modern" });
    assert.equal(modern.dataStyle, "modern", `saved=${saved}`);
    assert.equal(modern.light, saved === "light", `saved=${saved}: the style does not change the mode`);
  }
  // Classic is the absence of the attribute, so Classic users get no new selector matches.
  for (const style of [null, "classic", "unknown"]) {
    assert.equal(runBoot({ saved: "dark", prefersDark: true, style }).dataStyle, undefined, `style=${style}`);
  }
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
