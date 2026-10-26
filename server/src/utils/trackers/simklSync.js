import { getTrackerConnection, findLatestTrackerOutboundSince } from "../trackerConnectionRepo.js";
import { isAuthoritativeRestoreActive, loadMediaConfig } from "../configStore.js";
import { applyWatchedTransition } from "../watchStateTransitions.js";
import { getCanonicalWatchState, getPlaystateForMediaSync, invalidateHistoryDerivedCaches, signalHistoryDataChanged } from "../dataRepo.js";
import { createLoopStore } from "../loopStore.js";
import { assertTrackerSafetyGate } from "./registry.js";
import { assertTrackerGeneration, runInTrackerGeneration } from "./generation.js";
import { readSimklSnapshot, simklAdapter } from "./simkl.js";
import { assertSimklTrigger } from "./simklClient.js";
import { simklObservationCursor, persistSimklObservations, pendingSimklObservations, completeSimklObservation,
  requeueSimklObservation, settledSimklWatchedObservations } from "./simklObservations.js";

const flights = new Map();

// Never pass this envelope to trackerSync's plain-array absence reconciler.
// A reconcile (user import) also restores settled remote watches that local
// history lacks; it never removes anything.
export async function syncSimklObservations({ trigger, reconcile = false } = {}) {
  if(reconcile)throw Object.assign(new Error('Historical imports require an approved full-sync preview'),{code:'FULL_SYNC_PREVIEW_REQUIRED',status:409});
  assertSimklTrigger(trigger);
  assertTrackerSafetyGate(simklAdapter);
  const connection = getTrackerConnection("simkl");
  if (!connection || connection.status !== "connected") return { skipped: true, reason: "not-connected" };
  if (flights.has(connection.id)) return flights.get(connection.id);
  const flight = runInTrackerGeneration("simkl", connection.id, async () => {
    if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
    const config = await loadMediaConfig();
    const loopStore = createLoopStore();
    let watched = 0;
    const drain = async () => {
      for (const row of pendingSimklObservations(connection)) {
        assertTrackerGeneration("simkl");
        if (isAuthoritativeRestoreActive()) return false;
        const item = row.observation;
        if(item.syncIntent==='import')continue; // Retain legacy inbox evidence until explicitly approved.
        const media = { ...item.media, source: "simkl", watched_at: new Date(item.watchedAt).toISOString(),
          ...(item.syncIntent === "import" ? { syncIntent: "import" } : {}) };
        const result = await applyWatchedTransition(media, config, loopStore, { shouldDefer: () => {
          assertTrackerGeneration("simkl");
          const outbound = findLatestTrackerOutboundSince("simkl", item, Date.now() - 30 * 60_000);
          const local = getPlaystateForMediaSync(media);
          return isAuthoritativeRestoreActive() || outbound?.lastOutboundState === "unwatched"
            || local?.state === "unwatched" && Number(local.updated_at || 0) >= row.created_at;
        } });
        if (!result.deferred) {
          completeSimklObservation(connection, row.id);
          watched++;
        }
      }
      return true;
    };
    // Recover durable work before an unchanged activity cursor can short circuit.
    if (!await drain()) return { skipped: true, reason: "authoritative-restore-active" };
    const cursor = simklObservationCursor(connection);
    const snapshot = await readSimklSnapshot(connection, { trigger, ...(cursor ? { dateFrom: cursor } : {}) });
    if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
    persistSimklObservations(connection, snapshot, { expectedCursor: cursor });
    if (reconcile) {
      for (const row of settledSimklWatchedObservations(connection)) {
        if (isAuthoritativeRestoreActive()) break;
        const state = await getCanonicalWatchState(row.observation.media).catch(() => null);
        if (state !== "watched") requeueSimklObservation(connection, row.id);
      }
    }
    await drain();
    if (watched) {
      signalHistoryDataChanged();
      await invalidateHistoryDerivedCaches("simkl-observations");
    }
    return { skipped: false, watched, unwatched: 0, baselineEstablished: !cursor,
      pending: pendingSimklObservations(connection).length };
  }).finally(() => { if (flights.get(connection.id) === flight) flights.delete(connection.id); });
  flights.set(connection.id, flight);
  return flight;
}
