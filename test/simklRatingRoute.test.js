import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const state = { connected: true, enabled: true, calls: [] };
globalThis.simklRatingRouteFixture = state;
const source = (code) => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (!context.parentURL?.endsWith("/routes/ratingSync.js")) return next(specifier, context);
  const preamble = "const state = globalThis.simklRatingRouteFixture;";
  const modules = {
    "../utils/auth.js": "export const requireAdmin = async () => true;",
    "../utils/requestBody.js": "export const readJson = async req => req.body;",
    "../utils/http.js": "export const sendJson = (res, data) => {res.data=data}; export const sendOptions=()=>{}; export const methodNotAllowed=()=>{};",
    "../utils/configStore.js": "export const loadMediaConfig = async () => ({ratingSync:{enabled:state.enabled}});",
    "../utils/trackerConnectionRepo.js": "export const getTrackerConnection = () => state.connected ? {status:'connected'} : null;",
    "../utils/trackerSync.js": "export const pollConnectedTrackers = async options => { state.calls.push(['poll', options]); };",
    "../utils/personalRatingSync.js": "export const runRatingSync = async options => {state.calls.push(['run',options]); return {ok:true};}; export const getRatingSyncStatus=()=>{}; export const pushPersonalRatings=()=>{}; export const retryRatingSync=()=>{}; export const resolveRatingScanHold=()=>{};",
  };
  return modules[specifier] ? source(preamble + modules[specifier]) : next(specifier, context);
} });
const { handleRatingSync } = await import("../server/src/routes/ratingSync.js");

test("rating Sync now checks connected Simkl before reading ratings, only when requested and enabled", async () => {
  for (const fixture of [
    { body: {}, connected: true, enabled: true, poll: true },
    { body: { providers: ["simkl"] }, connected: true, enabled: true, poll: true },
    { body: { providers: ["trakt"] }, connected: true, enabled: true, poll: false },
    { body: {}, connected: false, enabled: true, poll: false },
    { body: {}, connected: true, enabled: false, poll: false },
    { body: { snapshot: false }, connected: true, enabled: true, poll: false },
  ]) {
    Object.assign(state, fixture, { calls: [] });
    await handleRatingSync({ method: "POST", body: fixture.body }, {});
    assert.deepEqual(state.calls.map(x => x[0]), fixture.poll ? ["poll", "run"] : ["run"]);
    if (fixture.poll) assert.equal(state.calls[0][1].trigger, "user");
  }
});
