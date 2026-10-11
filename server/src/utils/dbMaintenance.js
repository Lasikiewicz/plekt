import { db } from "../db.js";

// SQLite's own planner statistics refresh. Cheap when there is little to do,
// and it keeps query plans current as tables grow, so it runs once a day.
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastOptimizeAt = 0;

export function runDbOptimizeIfDue(now = Date.now(), runOptimize = () => db.pragma("optimize")) {
  if (lastOptimizeAt && now - lastOptimizeAt < DB_OPTIMIZE_INTERVAL_MS) return { ran: false };
  lastOptimizeAt = now;
  runOptimize();
  return { ran: true };
}
