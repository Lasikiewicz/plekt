import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-db-maintenance-");

const { runDbOptimizeIfDue, DB_OPTIMIZE_INTERVAL_MS } = await import("../server/src/utils/dbMaintenance.js");

test("PRAGMA optimize runs at most once per interval", () => {
  let calls = 0;
  const optimize = () => { calls += 1; };
  const start = Date.now() + 10 * DB_OPTIMIZE_INTERVAL_MS;

  assert.equal(runDbOptimizeIfDue(start, optimize).ran, true);
  assert.equal(runDbOptimizeIfDue(start + 60_000, optimize).ran, false);
  assert.equal(runDbOptimizeIfDue(start + DB_OPTIMIZE_INTERVAL_MS - 1, optimize).ran, false);
  assert.equal(runDbOptimizeIfDue(start + DB_OPTIMIZE_INTERVAL_MS, optimize).ran, true);
  assert.equal(calls, 2);
});
