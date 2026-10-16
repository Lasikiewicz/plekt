import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
const configSource = server.slice(server.indexOf("const TRAKS_CONFIG ="), server.indexOf("const ANALYTICS_CONFIG ="));
const loader = fs.readFileSync(new URL("../public/modules/analytics.js", import.meta.url), "utf8");

test("only demo mode exposes the demo collector and key", () => {
  for (const demoMode of [false, true]) {
    const config = vm.runInNewContext(`${configSource}; TRAKS_CONFIG`, { DEMO_MODE: demoMode });
    assert.equal(config.enabled, demoMode);
    assert.equal(config.siteKey, demoMode ? "pb_live_z70rk17kytof4pd9ejy1ovl6" : "");
    assert.equal(config.collectorOrigin, demoMode ? "https://plembfin-traks-collect.lasikie.workers.dev" : "");
  }
});

test("analytics loader loads only enabled approved collector and honors privacy signals", async () => {
  for (const [enabled, privacy, scriptUrl, expected] of [
    [false, false, "https://plembfin-traks-collect.lasikie.workers.dev/t.js", 0],
    [true, true, "https://plembfin-traks-collect.lasikie.workers.dev/t.js", 0],
    [true, false, "https://untrusted.example/t.js", 0],
    [true, false, "https://plembfin-traks-collect.lasikie.workers.dev/t.js", 1],
  ]) {
    const scripts = [];
    const window = { location: { href: "https://demo.plekt.net/" }, setTimeout: (callback) => callback() };
    const context = {
      URL, window,
      navigator: { globalPrivacyControl: privacy },
      document: { createElement: () => ({ dataset: {} }), head: { appendChild: (script) => scripts.push(script) } },
      fetch: async () => ({ ok: true, json: async () => ({ enabled, traks: { enabled, scriptUrl, siteKey: "pb_live_z70rk17kytof4pd9ejy1ovl6" } }) }),
    };
    await vm.runInNewContext(loader.replace("void boot();", "boot();"), context);
    assert.equal(scripts.length, expected);
    if (expected) {
      assert.equal(scripts[0].src, scriptUrl);
      assert.equal(scripts[0].dataset.site, "pb_live_z70rk17kytof4pd9ejy1ovl6");
      assert.equal(typeof window.traks, "function");
    }
  }
});
