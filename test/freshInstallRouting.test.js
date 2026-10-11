import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routing = source.slice(source.indexOf("function handleRouting(path) {"), source.indexOf("function applyActiveView() {"));
const routePrefix = source.slice(source.indexOf("function handleRoutingNow(path) {"), source.indexOf("  const previousExplorerListRoute ="));

test("a dashboard module finishing after fresh-install auth cannot replace setup", async () => {
  let finishLoading;
  const loading = new Promise((resolve) => { finishLoading = resolve; });
  const paths = [];
  const state = { claimRequired: false, token: "" };
  const context = vm.createContext({
    state, paths,
    routeGeneration: 0, routeReplayGeneration: -1,
    routeModulesForState: () => ["dashboard"],
    routeModulesLoaded: () => false,
    loadRouteModules: () => loading,
    applyActiveViewNow() {}, finishPageEntryScrollReset() {},
    routeModuleLoadFailed(error) { throw error; },
  });
  vm.runInContext(`${routePrefix} paths.push(pathname); }\n${routing}\nhandleRouting('/');`, context);
  assert.deepEqual(paths, ["/"]);
  state.claimRequired = true;
  finishLoading();
  await loading;
  await Promise.resolve();
  assert.deepEqual(paths, ["/", "/setup"]);
  state.claimRequired = false;
  state.token = "session";
  vm.runInContext("handleRoutingNow('/history');", context);
  assert.equal(paths.at(-1), "/history");
});
