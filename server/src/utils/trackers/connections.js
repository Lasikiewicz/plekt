import { assertTrackerEnabled, runTrackerOperation } from "./registry.js";
import { withFreshTraktConnection } from "../trackerDispatcher.js";
import { freshSimklConnection } from "./simklConnection.js";

const refreshers = new Map([["trakt", withFreshTraktConnection], ["simkl", freshSimklConnection]]);

export function freshTrackerConnection(provider, force = false) {
  assertTrackerEnabled(provider);
  return refreshers.get(provider)(force);
}

export async function readTrackerSnapshot(provider, { trigger = "scheduled" } = {}) {
  const adapter = assertTrackerEnabled(provider);
  const read = (connection) => runTrackerOperation(provider, "watchedSnapshot", {
    mediaType: "movie", trigger,
    satisfiedPreconditions: ["authenticated_connection", "complete_snapshot_before_absence_reconciliation"],
  }, connection, { trigger });
  let connection = await freshTrackerConnection(adapter.id);
  if (!connection) return { connection: null, snapshot: [] };
  try {
    return { connection, snapshot: await read(connection) };
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await freshTrackerConnection(adapter.id, true);
    if (!connection) throw error;
    return { connection, snapshot: await read(connection) };
  }
}
