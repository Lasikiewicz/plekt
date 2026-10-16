import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-force-accounting-");
const { db } = await import("../server/src/db.js");
const { createSyncPlanRecord, getSyncPlanSummary } = await import("../server/src/utils/syncPlans.js");
const { executeForceSyncPlan } = await import("../server/src/utils/forceSyncExecutor.js");
const config = { emby: { baseUrl: "https://emby.example.test", apiKey: "key", userId: "user" } };
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => db.close());
const missing = { kind: "mark_played", target: "emby", media: { title: "Missing Movie", type: "movie", tmdb: "123" } };
function plan(actions, destructive = 0) {
  return createSyncPlanRecord({ actions, summary: { destructive }, scope: {}, fingerprints: {} }, { status: "confirmed" });
}
function noItems() { globalThis.fetch = async () => new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { headers: { "Content-Type": "application/json" } }); }
test("not found is missing, never completed, and persists titles in a failed plan", async () => {
  noItems(); const p = plan([missing]);
  const result = await executeForceSyncPlan(p.id, config);
  assert.equal(result.completedActions, 0);
  assert.equal(result.missingActions, 1);
  assert.equal(result.failedActions, 0);
  assert.equal(result.success, false);
  assert.deepEqual(result.missingItems, [{ title: "Missing Movie", target: "emby" }]);
  const stored = getSyncPlanSummary(p.id);
  assert.equal(stored.status, "failed");
  assert.deepEqual(stored.result.missingItems, result.missingItems);
  assert.match(result.message, /0 of 1 actions applied; 1 not found on Emby/);
  assert.match(result.message, /Missing Movie/);
});
test("mixed applied and missing actions add up and finish partially applied", async () => {
  noItems(); const p = plan([missing, { kind: "delete_history_rows", historyRowIds: [] }]);
  const result = await executeForceSyncPlan(p.id, config);
  assert.equal(result.completedActions + result.failedActions + result.missingActions, result.plannedActions);
  assert.equal(result.completedActions, 1);
  assert.equal(result.success, false);
  assert.equal(getSyncPlanSummary(p.id).status, "partial");
  assert.match(result.message, /^Partially applied: 1 of 2/);
});
test("remote error is failed, not missing or completed", async () => {
  globalThis.fetch = async (url) => new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), {
    status: new URL(String(url)).searchParams.get("Limit") === "1" ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
  const p = plan([missing]); const result = await executeForceSyncPlan(p.id, config);
  assert.equal(result.failedActions, 1);
  assert.equal(result.missingActions, 0);
  assert.equal(result.success, false);
  assert.equal(getSyncPlanSummary(p.id).status, "failed");
});
test("exception after a verified snapshot never stores completed", async () => {
  noItems(); const p = plan([missing], 1);
  const result = await executeForceSyncPlan(p.id, config, (line) => {
    if (line.includes("recovery snapshot verified")) throw new Error("injected after snapshot");
  });
  assert.ok(result.snapshot);
  assert.equal(result.success, false);
  assert.equal(getSyncPlanSummary(p.id).status, "failed");
});
test("cancellation remains cancelled", async () => {
  noItems(); const p = plan([missing]);
  const result = await executeForceSyncPlan(p.id, config, () => {}, { shouldCancel: async () => true });
  assert.equal(result.cancelled, true);
  assert.equal(getSyncPlanSummary(p.id).status, "cancelled");
});
