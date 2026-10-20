import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
const routeModulesSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/route-modules.js"), "utf8");
const upNextSource = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/up-next.js"), "utf8");

// app.js declares every route-module export as a `let` holding a no-op
// placeholder, then reassigns it when that module loads. Reassignment does not
// reach a copy another module already stored, which is how Now Playing links,
// live redraws, and dashboard episode titles silently broke.
const lazyBlock = appSource.slice(appSource.indexOf("const lazyNoopAsync"), appSource.indexOf("// A callback another module stores"));
const lazyNames = [...lazyBlock.matchAll(/(?:let |, )([A-Za-z_$][\w$]*) = /g)].map((match) => match[1]);
const syncPlaceholders = [...lazyBlock.matchAll(/([A-Za-z_$][\w$]*) = lazyNoop(?![A-Za-z])/g)].map((match) => match[1]);
const initializerBlock = appSource.slice(appSource.indexOf("const ROUTE_MODULE_INITIALIZERS = {"), appSource.indexOf("for (const [key, initializer] of Object.entries(ROUTE_MODULE_INITIALIZERS))"));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callArguments(name) {
  const start = appSource.indexOf(`  ${name}({\n`);
  assert.ok(start >= 0, `expected a ${name}({ ... }) call`);
  const end = appSource.indexOf("\n  });", start);
  return appSource.slice(start, end);
}

test("the lazy binding list is parsed", () => {
  assert.ok(lazyNames.length > 100, `parsed only ${lazyNames.length} lazy names`);
  assert.ok(lazyNames.includes("renderExplorer"));
  assert.ok(initializerBlock.length > 1000, "expected the route-module initializer table");
});

test("core modules never store a deferred placeholder as a callback", () => {
  for (const initName of ["initSync", "initDashboard", "initSettingsServices"]) {
    const args = callArguments(initName);
    for (const name of lazyNames) {
      const escapedName = escapeRegExp(name);
      const bare = new RegExp(`^\\s+${escapedName},?\\s*$|:\\s*${escapedName}\\s*[,}\\n]`, "m");
      assert.doesNotMatch(args, bare, `${initName} stores deferred ${name} by value; pass a wrapper that reads the live binding`);
    }
  }
  for (const pattern of [/initOnboarding\(\{[^}]*\}\)/, /initUpNext\(\{[^}]*\}\)/]) {
    const call = appSource.match(pattern)?.[0] || "";
    assert.ok(call, `expected a one-line call matching ${pattern}`);
    for (const name of lazyNames) {
      assert.doesNotMatch(call, new RegExp(`[{,\\s]${escapeRegExp(name)}[,\\s}]`), `${call.slice(0, 20)} stores deferred ${name} by value`);
    }
  }
});

test("route modules never receive another route module's placeholder by value", () => {
  // Modules load in any order, so every callback that names a lazy binding
  // must go through live(...) or viaModule(...).
  for (const name of lazyNames) {
    const escapedName = escapeRegExp(name);
    const shorthand = new RegExp(`[{,]\\s*${escapedName}\\s*(?=[,}])`);
    const byValue = new RegExp(`:\\s*${escapedName}\\s*[,}\\n]`);
    // Destructuring assignments (`({ a, b } = module)`) are the one legitimate shorthand use.
    const withoutAssignments = initializerBlock.replace(/\(\{[^}]*\} = module\);/g, "");
    assert.doesNotMatch(withoutAssignments, shorthand, `an initializer passes deferred ${name} by value`);
    assert.doesNotMatch(withoutAssignments, byValue, `an initializer passes deferred ${name} by value`);
  }
});

test("each route module is initialized exactly once, from its registry entry", () => {
  const lazyInits = lazyNames.filter((name) => /^init[A-Z]/.test(name));
  assert.ok(lazyInits.includes("initAppEvents") && lazyInits.includes("initWatchAction"));
  for (const name of lazyInits) {
    const calls = appSource.match(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\(`, "g")) || [];
    assert.equal(calls.length, 1, `${name} is called ${calls.length} times`);
    assert.match(initializerBlock, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\(`), `${name} must be called from ROUTE_MODULE_INITIALIZERS`);
  }
});

test("no synchronous placeholder is chained like a promise", () => {
  // A detail deep link called openShowImmersiveModalByTvdbId(...).catch() on a
  // placeholder that returned undefined; the TypeError aborted initialize()
  // and the signed-in user was left on a black, auth-locked page.
  for (const name of syncPlaceholders) {
    const chained = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.(then|catch|finally)\\(`);
    assert.doesNotMatch(appSource, chained, `${name} is chained as a promise but its placeholder is lazyNoop; use lazyNoopAsync`);
  }
});

test("the watch-action re-render reloads the data behind the visible page", () => {
  assert.match(appSource, /renderActiveView: renderActiveViewAfterWatch/);
  const body = appSource.match(/function renderActiveViewAfterWatch\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(body, /loadUpNext\(\)/);
  assert.match(body, /loadDiscover\(\)/);
  assert.match(body, /loadPersonalMedia\(\{ force: true \}\)/);
});

test("saved config is applied only after the shell modules are initialized", () => {
  const body = appSource.match(/async function loadSavedConfig\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(body, /fetch\("\/api\/config"[\s\S]*?ensureShellModules\(\)/);
  assert.doesNotMatch(body, /apply(?:Rating|Watchlist)SyncConfig\(/, "settings-only sync controls must not be pulled into every route's config load");
  assert.match(body, /document\.dispatchEvent\(new CustomEvent\("plembfin:config-changed"\)\)/);
  const ensure = routeModulesSource.match(/function ensureShellModules\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(ensure, /loadRouteModules\(SHELL_ROUTE_MODULES\)/);
});

test("settings-only status modules run only while signed in on Settings", () => {
  const forState = appSource.match(/function routeModulesForState\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(forState, /case "settings":[\s\S]*?\.\.\.SETTINGS_ROUTE_MODULES/);
  assert.match(appSource, /if \(state\.activeView !== "settings" \|\| !state\.token\) \{[\s\S]*?stopRatingSyncSettings\(\);[\s\S]*?stopWatchlistSyncSettings\(\);/);
  assert.match(appSource, /resumeRatingSyncSettings\(\)\.catch[\s\S]*?resumeWatchlistSyncSettings\(\)\.catch/);
  const status = appSource.match(/function startDeferredStatusWork\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(status, /refresh(?:TrackerSettings|RatingSyncStatus|WatchlistSyncStatus)\(\)/, "settings status refreshes must not run in the global startup batch");
});

test("activations before the shell modules load are held and replayed, never dropped", () => {
  const init = appSource.match(/function initialize\(\) \{[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(init, /installEarlyActivationCapture\(\);/);
  assert.match(init, /ensureShellModules\(\)[\s\S]*?replayEarlyActivation\(\);/);
  // A native form submission would be a GET that puts field values,
  // including the sign-in password, into the URL.
  const capture = routeModulesSource.match(/function captureEarlyActivation\(event\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(capture, /if \(shellModulesReady\) return;/);
  assert.match(capture, /event\.type === "submit"[\s\S]*?event\.preventDefault\(\)/);
});

test("startup status summaries stay lightweight and run once per token", () => {
  const summaryLoads = appSource.match(/loadManualWatchReviewSummary\(\)/g) || [];
  assert.ok(summaryLoads.length >= 2);
  const body = appSource.match(/function startDeferredStatusWork\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(body, /if \(deferredStatusToken === state\.token\) return;/);
  assert.match(body, /loadRouteModules\(\[\.\.\.SHELL_ROUTE_MODULES, \.\.\.routeStatusModules\]\)/);
  assert.match(body, /loadSyncAttentionSummary\(\)/);
  assert.match(body, /startStatusSummaryPolling\(\)/);
  assert.doesNotMatch(body, /STATUS_ROUTE_MODULES/);
});

test("a route waits for its own modules and is replayed once, not the whole graph", () => {
  const routing = appSource.match(/function handleRouting\(path\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(routing, /const keys = routeModulesForState\(\);/);
  assert.match(routing, /if \(generation !== routeGeneration\) return;/);
  const apply = appSource.match(/function applyActiveView\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(apply, /routeReplayGeneration === routeGeneration/);
  const forState = appSource.match(/function routeModulesForState\(\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(forState, /return \[\.\.\.DETAIL_ROUTE_MODULES, \.\.\.posterMenu\];/);
  assert.match(forState, /case "dashboard":\s*return \["dashboard", "up-next", \.\.\.posterMenu\];/);
  assert.match(forState, /case "stats":\s*return \["stats"\];/);
  assert.match(forState, /default:\s*return \[\];/);
  assert.doesNotMatch(appSource, /import\("\.\/modules\//, "route modules are loaded through route-modules.js only");
});

test("the dashboard reads the server snapshot without forcing provider refresh and marks stale server cards while revalidating", () => {
  assert.match(appSource, /scheduleDeferredStartupWork\(\(\) => loadUpNext\(\), 0\)/);
  assert.match(upNextSource, /const params = force \? "refresh=1" : "revalidate=1";/);
  assert.match(upNextSource, /const checkingCachedItems = state\.upNextFromCache\s+&& \(state\.upNextLoading \|\| \(!state\.upNextLoadedAt && !state\.upNextError\)\)/);
  assert.match(upNextSource, /checking: checkingCachedItems/);
  assert.match(fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/dashboard.js"), "utf8"), /up-next-checking-status.*Checking/);
  assert.doesNotMatch(upNextSource, /state\.upNextFromCache && \(state\.upNextLoading/);
  assert.doesNotMatch(upNextSource, /allowStale|UP_NEXT_STALE_FOLLOW_UP_MS/);
});

test("a history-paired queue version refreshes the open dashboard immediately", () => {
  const callback = appSource.match(/onUpNextVersion: ([\s\S]*?),\s*onDiscoverVersion:/)?.[1];
  assert.ok(callback);
  const state = { upNextVersion: 10, activeView: "dashboard" };
  const requests = [];
  const handle = new Function("state", "loadUpNext", "logDebug", `return (${callback});`)(
    state, (options) => { requests.push(options); return Promise.resolve(); }, () => {},
  );
  handle(11, { initial: false, pairedWithHistory: true });
  assert.deepEqual(requests, [{ fromSse: true }]);
  handle(11, { initial: false, pairedWithHistory: false });
  assert.equal(requests.length, 1, "duplicate versions do not fetch twice");
});
