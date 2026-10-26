import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../../db.js";

// A tracker connection row's id is its generation: a token refresh or same-
// account re-auth keeps it, while account replacement or reconnecting after a
// disconnect mints a new one. Work started against one generation (a poll, a
// token refresh, a rating scan) runs inside this scope, and every connection
// mutation it makes is conditional on that generation still being current, so
// a late result can never mark, baseline or import into its replacement.
const scope = new AsyncLocalStorage();
const currentIdStmt = db.prepare("SELECT id FROM tracker_connections WHERE provider=?");

export class StaleTrackerConnectionError extends Error {
  constructor(provider) {
    super(`The ${provider} connection changed while this work was running; its result was discarded`);
    this.name = "StaleTrackerConnectionError";
    this.code = "TRACKER_CONNECTION_STALE";
    this.stale = true;
  }
}

export const currentTrackerGeneration = (provider) => currentIdStmt.get(provider)?.id ?? "";

export function runInTrackerGeneration(provider, connectionId, fn) {
  return scope.run(new Map(scope.getStore()).set(provider, String(connectionId ?? "")), fn);
}

export const trackerGenerationFence = (provider) => scope.getStore()?.get(provider);

export function trackerGenerationCurrent(provider) {
  const expected = trackerGenerationFence(provider);
  return expected === undefined || currentTrackerGeneration(provider) === expected;
}

// Call inside the transaction that performs the mutation it protects.
export function assertTrackerGeneration(provider) {
  if (!trackerGenerationCurrent(provider)) throw new StaleTrackerConnectionError(provider);
}
