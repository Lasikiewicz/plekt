import { getTrackerConnection } from "../trackerConnectionRepo.js";
import { trackerIntentForDispatch, finishTrackerWriteIntent } from "../trackerWriteIntents.js";
import { writeSimklWatched } from "./simkl.js";
import { assertSimklTrigger, simklHistoryPayload, simklReviewRequired } from "./simklClient.js";
import { runInTrackerGeneration } from "./generation.js";
import { TARGET_DECISIONS } from "../watchSyncPolicy.js";

const UNWATCH_NOT_SENT = "Simkl unwatches are not sent: removing a play on Simkl can also remove list membership";

// The shared dispatcher enforces activation before reaching this handler.
// Recovery never upgrades an uncertain send into a new ordinary play.
export async function dispatchSimklWatchState(media, state, lane, isCancelled = () => false, { trigger = "event" } = {}) {
  assertSimklTrigger(trigger);
  const connection = getTrackerConnection("simkl");
  if (!connection || connection.status !== "connected") throw simklReviewRequired("Simkl needs a connected account");
  if (isCancelled()) return { target: "simkl", status: "cancelled", detail: "Simkl dispatch was cancelled before it started" };
  return runInTrackerGeneration("simkl", connection.id, async () => {
    const intent = trackerIntentForDispatch("simkl", connection, media, state);
    // A deliberate, terminal skip: nothing is held for review or retried.
    if (state !== "watched") {
      if (!["settled", "cancelled"].includes(intent.status)) finishTrackerWriteIntent(intent.id, "cancelled", UNWATCH_NOT_SENT);
      return { target: "simkl", status: "skipped", decision: TARGET_DECISIONS.SKIPPED_BY_POLICY, dismissed: true, detail: UNWATCH_NOT_SENT };
    }
    try {
      // Never let the generic intent's fallback-to-now date become evidence.
      if (!media.watched_at && !media.watchedAt) throw simklReviewRequired("Simkl needs an observed watch date");
      simklHistoryPayload({ ...media, watched_at: intent.watched_at });
    } catch (error) {
      if (!["settled", "cancelled"].includes(intent.status)) finishTrackerWriteIntent(intent.id, "review", `Not sent: ${error.message}`);
      throw error;
    }
    const result = await writeSimklWatched(connection, { ...media, trackerWriteIntentId: intent.id }, {
      trigger,
      sendNow: Boolean(media.simklSendNow),
    });
    if (result.deferred) {
      return { target: "simkl", status: "pending", detail: "Queued for the next Simkl batch send" };
    }
    return { target: "simkl", status: "success", detail: result.alreadySatisfied ? "Simkl already has this watched item; its date was kept" : "Watched state confirmed on Simkl" };
  });
}
