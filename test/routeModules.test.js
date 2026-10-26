import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const modulesDir = path.resolve(import.meta.dirname, "../public/modules");
const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
const {
  DETAIL_ROUTE_MODULES, SETTINGS_ROUTE_MODULES, SHELL_ROUTE_MODULES, STATUS_ROUTE_MODULES, WATCH_ROUTE_MODULES,
  ifLoaded, isRouteModuleLoaded, lazyExport, loadRouteModule, routeModuleDeps, routeModuleKeys,
} = await import("../public/modules/route-modules.js");

const staticImports = (name) => {
  const source = fs.readFileSync(path.join(modulesDir, `${name}.js`), "utf8");
  return [...source.matchAll(/^import [^;]*? from "\.\/([\w-]+)\.js[^"]*";/gm)].map((match) => match[1]);
};

function staticClosure(name, seen = new Set()) {
  for (const dependency of staticImports(name)) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    staticClosure(dependency, seen);
  }
  return seen;
}

function declaredClosure(key, seen = new Set()) {
  for (const dependency of routeModuleDeps(key)) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    declaredClosure(dependency, seen);
  }
  return seen;
}

const keys = routeModuleKeys();

test("every registered route module loads the registered modules it imports first", () => {
  // A module that statically imports another registered module evaluates it
  // too. Unless that dependency is loaded through the registry first, its init
  // callbacks are missing when the dependent calls into it.
  for (const key of keys) {
    const imported = [...staticClosure(key)].filter((name) => keys.includes(name) && name !== key);
    const declared = declaredClosure(key);
    for (const dependency of imported) {
      assert.ok(declared.has(dependency), `${key} imports ${dependency} but does not list it (directly or transitively) in deps`);
    }
  }
});

test("the global event module keeps route modules out of its static imports", () => {
  // app-events.js loads on every page. A static import of a route module would
  // pull that route's whole graph onto every page.
  const routeImports = [...staticClosure("app-events")].filter((name) => keys.includes(name));
  assert.deepEqual(routeImports, [], `app-events statically imports route modules: ${routeImports.join(", ")}`);
});

test("the core graph imported by app.js contains no registered route module", () => {
  const core = [...appSource.matchAll(/^import [^;]*? from "\.\/modules\/([\w-]+)\.js[^"]*";/gm)].map((match) => match[1]);
  const coreClosure = new Set(core);
  for (const name of core) for (const dependency of staticClosure(name)) coreClosure.add(dependency);
  const leaked = [...coreClosure].filter((name) => keys.includes(name));
  assert.deepEqual(leaked, [], `route modules leaked into the core graph: ${leaked.join(", ")}`);
});

test("module groups only name registered modules", () => {
  for (const group of [SHELL_ROUTE_MODULES, SETTINGS_ROUTE_MODULES, STATUS_ROUTE_MODULES, WATCH_ROUTE_MODULES, DETAIL_ROUTE_MODULES]) {
    for (const key of group) assert.ok(keys.includes(key), `${key} is not registered`);
  }
  assert.ok(SHELL_ROUTE_MODULES.includes("app-events"));
  assert.ok(!SHELL_ROUTE_MODULES.includes("onboarding"));
  assert.ok(!SHELL_ROUTE_MODULES.includes("changelog-channels"));
  assert.ok(!SHELL_ROUTE_MODULES.includes("help-content"));
  assert.ok(SETTINGS_ROUTE_MODULES.includes("changelog-channels"));
  assert.ok(routeModuleDeps("settings-services").includes("help-content"));
  assert.ok(!SHELL_ROUTE_MODULES.includes("media-detail-events"));
  assert.ok(DETAIL_ROUTE_MODULES.includes("media-detail-events"));
  // The watch-date prompt's close and preset buttons are handled there, and a
  // dashboard card menu opens the prompt without the detail route loaded.
  assert.ok(routeModuleDeps("watch-action").includes("media-detail-events"));
  assert.deepEqual([...SETTINGS_ROUTE_MODULES], ["settings-services", "changelog-channels", "tracker-settings", "rating-sync-settings", "watchlist-sync-settings", "tautulli-import", "netflix-import", "settings-events"]);
  assert.ok(!SHELL_ROUTE_MODULES.includes("rating-sync-settings"), "settings status modules must not be global shell work");
});

test("poster-card menus stay route-scoped instead of loading with global status", () => {
  assert.deepEqual([...STATUS_ROUTE_MODULES], ["sync-activity", "manual-watch-review"]);
  assert.match(appSource, /const posterMenu = state\.token \? \["poster-menu"\] : \[\];/);
  assert.match(appSource, /case "dashboard":\s*return \["dashboard", "up-next", \.\.\.posterMenu\];/);
});

test("every registered module that app.js binds has an initializer", () => {
  const initializerBlock = appSource.slice(appSource.indexOf("const ROUTE_MODULE_INITIALIZERS = {"), appSource.indexOf("for (const [key, initializer] of Object.entries(ROUTE_MODULE_INITIALIZERS))"));
  // poster-menu and settings-events are wired by app-events; media-detail-movie only serves lazyExport.
  const withoutInitializer = new Set(["poster-menu", "settings-events", "media-detail-movie", "onboarding-sections", "onboarding-backups", "onboarding-trackers"]);
  for (const key of keys) {
    if (withoutInitializer.has(key)) continue;
    const pattern = /^[a-z]+$/.test(key) ? new RegExp(`^  ${key}\\(module\\)`, "m") : new RegExp(`^  "${key}"\\(module\\)`, "m");
    assert.match(initializerBlock, pattern, `no initializer for ${key}`);
  }
});

test("lazy wrappers never load for a render and reject unknown modules", async () => {
  assert.equal(isRouteModuleLoaded("stats"), false);
  assert.equal(ifLoaded("stats", "renderStats", "fallback")(), "fallback");
  assert.equal(isRouteModuleLoaded("stats"), false, "ifLoaded must not trigger a load");
  await assert.rejects(loadRouteModule("not-a-module"), /Unknown route module/);
  assert.equal(typeof lazyExport("stats", "renderStats"), "function");
});
