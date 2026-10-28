import { db } from "../../db.js";
import { finishTrackerWriteIntent, trackerIntentConnectionCurrent } from "../trackerWriteIntents.js";
import { freezeTrackerValue } from "./contract.js";
import * as client from "./simklClient.js";
import * as auth from "./simklAuth.js";
import { freshSimklConnection } from "./simklConnection.js";
import { clearSimklPersonalRating, setSimklPersonalRating, storedSimklRatingSnapshot } from "./simklRatings.js";
import { runInTrackerGeneration, assertTrackerGeneration } from "./generation.js";
import { simklReportedWatched } from "./simklObservations.js";
import { enqueueSimklWatched } from "./simklBatch.js";
import { simklFullSyncContext } from './simklFullSyncContext.js';

export function classifySimklError(error) {
  const status = Number(error?.status);
  if (status === 401) return "reauth_required";
  if (status === 403) return "forbidden";
  if (status === 404 || error?.code === "not_found") return "not_found";
  if (status === 409 || ["TRACKER_REVIEW_REQUIRED", "SIMKL_INCOMPLETE_SNAPSHOT", "SIMKL_MAX_ITEMS"].includes(error?.code)) return "review_required";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599 || error?.code === "UPSTREAM_TIMEOUT") return "transient";
  return "failed";
}

export async function readSimklSnapshot(connection, options) {
  client.assertSimklTrigger(options?.trigger);
  if (!connection?.id) return client.fetchSimklSnapshot(connection, options);
  return runInTrackerGeneration("simkl", connection.id, async () => {
    assertTrackerGeneration("simkl");
    let fresh = await freshSimklConnection();
    if (!fresh || fresh.status !== "connected") throw client.simklReviewRequired("Simkl needs a connected account");
    let snapshot;
    try { snapshot = await client.fetchSimklSnapshot(fresh, options); }
    catch (error) {
      if (error.status !== 401) throw error;
      fresh = await freshSimklConnection(true);
      snapshot = await client.fetchSimklSnapshot(fresh, options);
    }
    assertTrackerGeneration("simkl");
    return snapshot;
  });
}

// A managed adapter write always consumes an existing durable intent. It never
// creates eligibility, invents a new logical play or sends an uncertain intent.
export async function writeSimklWatched(connection, media, { trigger, sendNow = false } = {}) {
  client.assertSimklTrigger(trigger);
  const intent = db.prepare("SELECT * FROM tracker_write_intents WHERE id=?").get(media.trackerWriteIntentId || "");
  if (!intent || intent.provider !== "simkl" || intent.connection_id !== connection?.id
      || intent.account_id !== connection.remoteUserId || intent.action !== "watched"
      || !trackerIntentConnectionCurrent(intent)) throw client.simklReviewRequired("Simkl write needs a durable intent for the current account");
  const stored = JSON.parse(intent.media_json);
  const pacedId=stored.simklFullSyncRunId||media.simklFullSyncRunId;
  if(pacedId&&simklFullSyncContext()?.runId!==pacedId)throw client.simklReviewRequired('This watched intent belongs to a paced full sync and cannot bypass its daily allowance');
  if (!client.simklMediaMatches(stored, media)) throw client.simklReviewRequired("Simkl write identity differs from its durable intent");
  if (intent.status === "settled") return { alreadySatisfied: true };
  if (intent.expires_at <= Date.now()) {
    finishTrackerWriteIntent(intent.id, "review", "Simkl write expired before a confirmed outcome");
    throw client.simklReviewRequired("Simkl write expired and needs review");
  }
  if (!["pending", "retry", "rejected"].includes(intent.status)) {
    if (intent.status === "uncertain" || intent.status === "sending" && intent.due_at <= Date.now()) finishTrackerWriteIntent(intent.id, "review", "Simkl write outcome is uncertain; check remote history before another send");
    throw client.simklReviewRequired("Simkl write is held or cancelled; it will not be sent again automatically");
  }
  const now = Date.now();
  if (!sendNow && !media.simklSendNow && intent.due_at > now) return { deferred: true, dueAt: intent.due_at };
  if ((sendNow || media.simklSendNow) && intent.due_at > now) {
    db.prepare("UPDATE tracker_write_intents SET due_at=?,updated_at=? WHERE id=? AND status IN ('pending','retry','rejected')")
      .run(now, now, intent.id);
  }
  return runInTrackerGeneration("simkl", connection.id, async () => {
    const live = db.prepare("SELECT * FROM tracker_write_intents WHERE id=?").get(intent.id);
    const item = { ...media, watched_at: live.watched_at };
    try { client.simklHistoryPayload(item); } // Fail closed before claiming or networking.
    catch (error) {
      finishTrackerWriteIntent(intent.id, "review", `Not sent: ${error.message || "Simkl media identity or observed date needs review"}`);
      throw error;
    }
    // Simkl already reported this item watched: settle without reading its
    // whole library, which costs several requests from the daily quota.
    let reported;
    try { reported = simklReportedWatched(connection, item); }
    catch (error) {
      finishTrackerWriteIntent(intent.id, 'review', 'Simkl stored identity needs review before batching');
      throw error;
    }
    if (reported) {
      finishTrackerWriteIntent(intent.id, "settled");
      return { alreadySatisfied: true };
    }
    return enqueueSimklWatched(connection, live, item, trigger);
  });
}

const capability = (mediaTypes, preconditions = []) => ({ supported: true, mediaTypes, triggers: ["event", "user"], preconditions: ["authenticated_connection", ...preconditions], sideEffects: [] });
const disabled = (sideEffects = []) => ({ supported: false, mediaTypes: [], triggers: [], preconditions: [], sideEffects });
const held = (reason) => () => { throw client.simklReviewRequired(reason); };
const watchedSnapshot = async (connection, options) => {
  const snapshot = await readSimklSnapshot(connection, options);
  // Do not expose a plain array that shared reconciliation could mistake for
  // authoritative absence proof. Activation must consume this explicit envelope.
  return snapshot;
};

// Deliberately outside the active registry. Auth/storage completion does not
// waive release, reconciliation, matching or UI integration gates.
export const simklAdapter = freezeTrackerValue({
  id: "simkl", label: "Simkl", sources: ["simkl", "simkl_import"],
  ownsSource: (source) => ["simkl", "simkl_import"].includes(String(source || "").toLowerCase()),
  correlation: { nativeIdempotency: false, strategy: "watched_state_readback_or_review" },
  policies: { inboundDateCorrections: false, previousEpisodeDateFallback: false, defaultTimestampProvenance: "unknown", absenceReconciliation: false },
  capabilities: {
    watchedSnapshot: capability(["movie", "episode"]),
    watchedWrite: capability(["movie", "episode", "show", "tv"], ["verified_media_identity", "durable_write_intent", "observed_watch_timestamp"]),
    ratingSnapshot: capability(["movie", "show"], ["stored_watched_check_observations"]),
    playHistory: disabled(), historyWindow: disabled(), datedHistoryWrite: disabled(), repeatHistoryWrite: disabled(), existingDateMutation: disabled(),
    unwatchedWrite: disabled(["may_remove_list_membership"]),
    // Sent only where Simkl already holds the title (simklRatings.js); else held.
    ratingSet: { ...capability(["movie", "show"], ["existing_completed_movie_or_listed_show", "post_write_readback"]), sideEffects: ["may_create_watched_history", "may_create_list_membership"] },
    ratingClear: { ...capability(["movie", "show"], ["existing_completed_movie_or_listed_show", "post_write_readback"]), sideEffects: ["may_create_watched_history", "may_create_list_membership"] },
    resumeProgress: disabled(), watchlist: disabled(),
  },
  operations: {
    watchedSnapshot, watchedWrite: writeSimklWatched,
    ratingSnapshot: storedSimklRatingSnapshot,
    unwatchedWrite: held("Simkl unwatch can remove list membership and requires review"),
    ratingSet: setSimklPersonalRating,
    ratingClear: clearSimklPersonalRating,
  },
  auth: { startDeviceAuth: auth.startSimklDeviceAuth, pollDeviceAuth: auth.pollSimklDeviceAuth, refreshToken: auth.refreshSimklToken, getUser: auth.getSimklUser, freshConnection: freshSimklConnection },
  identity: { key: client.simklMediaKey, keys: client.simklIdentityKeys, matches: client.simklMediaMatches },
  classifyError: classifySimklError,
});
