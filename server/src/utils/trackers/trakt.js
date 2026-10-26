import * as client from "./traktClient.js";
import { freezeTrackerValue } from "./contract.js";

const historyTypes = ["movie", "episode"];
const ratingTypes = ["movie", "show", "episode"];
const triggers = ["scheduled", "event", "user"];
const historyPreconditions = ["authenticated_connection", "verified_media_identity"];
const capability = (mediaTypes, preconditions, sideEffects = []) => ({
  supported: true, mediaTypes, triggers, preconditions, sideEffects,
});

// A successful HTTP response can still report unmatched items in its body.
export function traktNotFoundCount(result) {
  return Object.values(result?.not_found || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

// Classify without changing the original error's status/body/retryAfter/code.
export function classifyTraktError(error) {
  const status = Number(error?.status);
  if (status === 401) return "reauth_required";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599 || error?.code === "UPSTREAM_TIMEOUT") return "transient";
  if (error?.code === "not_found" || status === 404) return "not_found";
  return "failed";
}

export function traktDispatchErrorDetail(error) {
  let detail = error.message || String(error);
  const status = Number(error?.status);
  if ((status === 429 || status >= 500 && status <= 599)
      && error.code !== "UPSTREAM_TIMEOUT" && !detail.includes(String(status))) detail += ` (HTTP ${status})`;
  return detail;
}

export const traktAdapter = freezeTrackerValue({
  id: "trakt",
  label: "Trakt",
  correlation: { nativeIdempotency: false, windowMs: 60_000, strategy: "event_id_then_identity_action_watched_date" },
  policies: { inboundDateCorrections: true, previousEpisodeDateFallback: true, defaultTimestampProvenance: "observed" },
  sources: ["trakt", "trakt_import"],
  // Historical source variants retain the legacy substring echo protection.
  ownsSource: (source) => String(source || "").toLowerCase().includes("trakt"),
  capabilities: {
    watchedSnapshot: capability(historyTypes, ["authenticated_connection", "complete_snapshot_before_absence_reconciliation"]),
    playHistory: capability(historyTypes, ["authenticated_connection", "complete_pagination"]),
    historyWindow: capability(historyTypes, ["authenticated_connection", "observed_watch_timestamp"]),
    watchedWrite: capability(historyTypes, historyPreconditions, ["adds_play_each_call"]),
    unwatchedWrite: capability(historyTypes, historyPreconditions, ["removes_all_item_plays"]),
    datedHistoryWrite: capability(historyTypes, [...historyPreconditions, "observed_watch_timestamp"], ["adds_play_each_call"]),
    repeatHistoryWrite: capability(historyTypes, [...historyPreconditions, "distinct_play_intent"], ["adds_play_each_call", "lost_response_requires_history_check"]),
    existingDateMutation: { supported: false, mediaTypes: historyTypes, triggers: [], preconditions: [], sideEffects: ["canonical_replay_requires_shared_remove_add_policy"] },
    ratingSnapshot: capability(ratingTypes, ["authenticated_connection", "complete_snapshot_before_absence_reconciliation"]),
    ratingSet: capability(ratingTypes, historyPreconditions),
    ratingClear: capability(ratingTypes, historyPreconditions),
    resumeProgress: { supported: false, mediaTypes: [], triggers: [], preconditions: [], sideEffects: [] },
    watchlist: { supported: false, mediaTypes: [], triggers: [], preconditions: [], sideEffects: [] },
  },
  operations: {
    watchedSnapshot: client.fetchTraktWatchedSnapshot,
    playHistory: client.fetchTraktPlayHistory,
    historyWindow: client.fetchTraktHistoryWindow,
    watchedWrite: (connection, media, options) => client.setTraktWatchState(connection, media, "watched", options),
    unwatchedWrite: (connection, media, options) => client.setTraktWatchState(connection, media, "unwatched", options),
    datedHistoryWrite: (connection, items, options) => client.setTraktWatchHistoryBatch(connection, items, "watched", options),
    repeatHistoryWrite: (connection, media, options) => client.setTraktWatchState(connection, media, "watched", options),
    ratingSnapshot: client.fetchTraktPersonalRatingSnapshot,
    ratingSet: client.setTraktPersonalRating,
    ratingClear: client.clearTraktPersonalRating,
  },
  auth: {
    startDeviceAuth: client.startTraktDeviceAuth,
    pollDeviceAuth: client.pollTraktDeviceAuth,
    refreshToken: client.refreshTraktToken,
    getUser: client.getTraktUser,
  },
  identity: {
    keys: client.trackerMediaIdentityKeys,
    key: client.trackerMediaKey,
    matches: client.trackerMediaMatches,
  },
  catalogue: {
    findShowByProviderId: client.fetchTraktShowByProviderId,
    seasonEpisodes: client.fetchTraktSeasonEpisodes,
  },
  history: {
    writeBatch: client.setTraktWatchHistoryBatch,
    removeIds: client.removeTraktHistoryIds,
    showPlays: client.fetchTraktShowPlayHistory,
  },
  classifyError: classifyTraktError,
});
