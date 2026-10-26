// One place that decides, per outgoing watched action and per target, what the
// provider is actually allowed to be told. Every path that can mark an item
// watched - a live webhook, a manual action, a Trakt or Tautulli import, a
// restore, a bulk backfill - resolves its intent here, so the same provider
// matrix applies no matter which entry point produced the work.
//
// The matrix exists because the providers are not equivalent:
//
//   Plembfin  canonical watched state and canonical play date
//   Trakt     watched state, exact play date, rewatch history
//   Emby      watched state plus the original date via DatePlayed
//   Jellyfin  watched state plus the original date via datePlayed
//   Plex      watched state only - its server API has no supported historical
//             date setter, so an imported watch is recorded using the Plex
//             server's own clock
//
// Only the Plex row needs a user-facing choice, and only for *historical*
// projections. See docs/decisions.md for why this is not a global
// "disable history sync" switch.
//
// This module imports tuning.js only (which itself imports nothing), so any
// provider adapter can enforce the matrix without creating an import cycle.

import { plexHistoricalWatchedSyncEnabled } from "./tuning.js";

// Intent is always explicit. It is never inferred from how old a timestamp
// looks: a user can create a current action carrying a manually selected date,
// and an imported event can carry a recent one.
export const WATCH_SYNC_INTENTS = Object.freeze(["live", "manual", "historical", "import", "restore"]);
export const HISTORICAL_WATCH_SYNC_INTENTS = Object.freeze(["historical", "import", "restore"]);
export const DEFAULT_WATCH_SYNC_INTENT = "live";

// Per-target outcomes. `send` is the pre-dispatch decision; the rest are
// terminal. `skipped_by_policy` and `unsupported` are deliberate answers, not
// failures, and must never be queued for retry.
export const TARGET_DECISIONS = Object.freeze({
  SEND: "send",
  SENT: "sent",
  ALREADY_MATCHING: "already_matching",
  SKIPPED_BY_POLICY: "skipped_by_policy",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

const NON_RETRYABLE_DECISIONS = new Set([
  TARGET_DECISIONS.SKIPPED_BY_POLICY,
  TARGET_DECISIONS.UNSUPPORTED,
  TARGET_DECISIONS.ALREADY_MATCHING,
  TARGET_DECISIONS.SENT,
]);

export const PLEX_POLICY_SKIP_DETAIL =
  "Skipped by policy: historical watched items are not sent to Plex (Settings - Sync - Sync Tuning)";

export const PLEX_ALREADY_MATCHING_DETAIL = "Already watched in Plex; no update sent";

// A source name alone is enough for the paths that have never carried an
// explicit intent. Anything that knows better sets media.syncIntent and wins
// over this table.
const INTENT_BY_SOURCE = Object.freeze({
  manual: "manual",
  // Force Sync replays a watch Plembfin already holds, so it is a historical
  // projection rather than something the user just watched. It is deliberately
  // NOT an exception to the Plex policy: turning the setting off means no
  // historical watch reaches Plex by any route, and the setting itself is how a
  // user asks for their history to be pushed there.
  force_sync: "historical",
  trakt_import: "import",
  tautulli_import: "import",
  netflix_import: "import",
});

export function normalizeWatchSyncIntent(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return WATCH_SYNC_INTENTS.includes(normalized) ? normalized : "";
}

export function isHistoricalWatchIntent(intent) {
  return HISTORICAL_WATCH_SYNC_INTENTS.includes(normalizeWatchSyncIntent(intent));
}

// Resolution order: the explicit field, then a source that can only ever mean
// one thing, then "live". A restore is recognized by its source prefix because
// several restore entry points build their own source strings
// ("restore", "restore_replay", ...).
export function resolveWatchSyncIntent(media = {}) {
  const explicit = normalizeWatchSyncIntent(media.syncIntent ?? media.sync_intent);
  if (explicit) return explicit;
  const source = String(media.source || "").trim().toLowerCase();
  if (!source) return DEFAULT_WATCH_SYNC_INTENT;
  if (source.startsWith("restore")) return "restore";
  if (source.endsWith("_initial_sync")) return "import";
  return INTENT_BY_SOURCE[source] || DEFAULT_WATCH_SYNC_INTENT;
}

export function plexHistoricalSyncAllowed() {
  return plexHistoricalWatchedSyncEnabled() !== false;
}

/**
 * The pre-dispatch decision for one target. Returns `send` unless the target
 * cannot represent the requested operation or a standing policy forbids it.
 *
 * Unwatch is a state change, not a historical backfill, and is never gated:
 * removing a watch that should not be there must always be able to reach every
 * provider.
 */
export function watchTargetPolicy({ target, intent = DEFAULT_WATCH_SYNC_INTENT, state = "watched" } = {}) {
  const normalizedTarget = String(target || "").trim().toLowerCase();
  const normalizedState = String(state || "watched").trim().toLowerCase();
  const resolvedIntent = normalizeWatchSyncIntent(intent) || DEFAULT_WATCH_SYNC_INTENT;

  if (normalizedTarget !== "plex") return { decision: TARGET_DECISIONS.SEND, retryable: true, detail: "" };
  if (normalizedState !== "watched" && normalizedState !== "played") {
    return { decision: TARGET_DECISIONS.SEND, retryable: true, detail: "" };
  }
  if (!isHistoricalWatchIntent(resolvedIntent)) return { decision: TARGET_DECISIONS.SEND, retryable: true, detail: "" };
  if (plexHistoricalSyncAllowed()) return { decision: TARGET_DECISIONS.SEND, retryable: true, detail: "" };
  return { decision: TARGET_DECISIONS.SKIPPED_BY_POLICY, retryable: false, detail: PLEX_POLICY_SKIP_DETAIL };
}

// Convenience wrapper for a provider adapter that only has the media object.
// The adapter guard is deliberately redundant with the orchestrator's target
// filtering: a future entry point that reaches the client directly must not be
// able to send a historical Plex update the user has disabled.
export function plexHistoricalWatchedAllowed(media = {}) {
  return watchTargetPolicy({ target: "plex", intent: resolveWatchSyncIntent(media), state: "watched" })
    .decision === TARGET_DECISIONS.SEND;
}

/**
 * The canonical play date for an outgoing watched action as an ISO string, or
 * "" when the caller supplied none. This is always the date Plembfin recorded,
 * never a substitute for "now": a provider that can carry the original date
 * must receive the real one, and a provider that cannot must be reported as
 * unable to rather than handed a fabricated value.
 */
export function canonicalPlayedDateIso(media = {}) {
  const raw = media.watched_at ?? media.watchedAt ?? media.playedAt ?? media.played_at ?? media.datePlayed;
  if (raw === null || raw === undefined || String(raw).trim() === "") return "";
  const numeric = Number(raw);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return new Date(parsed).toISOString();
}

export function isRetryableTargetDecision(decision) {
  return !NON_RETRYABLE_DECISIONS.has(String(decision || "").trim().toLowerCase());
}

const DECISION_LABELS = Object.freeze({
  [TARGET_DECISIONS.SENT]: "sent",
  [TARGET_DECISIONS.ALREADY_MATCHING]: "already matching",
  [TARGET_DECISIONS.SKIPPED_BY_POLICY]: "skipped by policy",
  [TARGET_DECISIONS.UNSUPPORTED]: "unsupported",
  [TARGET_DECISIONS.FAILED]: "failed",
});

const DECISION_ORDER = [
  TARGET_DECISIONS.SENT,
  TARGET_DECISIONS.ALREADY_MATCHING,
  TARGET_DECISIONS.SKIPPED_BY_POLICY,
  TARGET_DECISIONS.UNSUPPORTED,
  TARGET_DECISIONS.FAILED,
];

// Maps one dispatch targetState onto the plan's reporting vocabulary so an
// import summary can distinguish "we chose not to" from "it broke".
export function targetStateDecision(entry = {}) {
  const explicit = String(entry.decision || "").trim().toLowerCase();
  if (explicit && DECISION_LABELS[explicit]) return explicit;
  const status = String(entry.status || "").trim().toLowerCase();
  if (status === "success") return TARGET_DECISIONS.SENT;
  if (status === "error" || status === "failed") return TARGET_DECISIONS.FAILED;
  if (status === "not_found") return TARGET_DECISIONS.UNSUPPORTED;
  return TARGET_DECISIONS.UNSUPPORTED;
}

/**
 * Rolls a flat list of per-item targetStates up into per-provider counts, which
 * is what an import, restore, or bulk mark-watched result needs to show. Returns
 * `[{ target, sent, already_matching, skipped_by_policy, unsupported, failed }]`
 * in a stable provider order.
 */
export function summarizeProviderOutcomes(targetStates = []) {
  const byTarget = new Map();
  for (const entry of targetStates) {
    const target = String(entry?.target || "").trim().toLowerCase();
    if (!target) continue;
    if (!byTarget.has(target)) {
      byTarget.set(target, Object.fromEntries([["target", target], ...DECISION_ORDER.map((decision) => [decision, 0])]));
    }
    const bucket = byTarget.get(target);
    bucket[targetStateDecision(entry)] += 1;
  }
  return [...byTarget.values()];
}

function providerLabel(target) {
  const normalized = String(target || "").trim().toLowerCase();
  if (normalized === "tmdb") return "TMDB";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

// "Plex: 120 sent, 35 already matching, 80 skipped by policy"
export function formatProviderOutcomeSummary(targetStates = []) {
  return summarizeProviderOutcomes(targetStates).map((bucket) => {
    const parts = DECISION_ORDER
      .filter((decision) => bucket[decision] > 0)
      .map((decision) => `${bucket[decision]} ${DECISION_LABELS[decision]}`);
    return `${providerLabel(bucket.target)}: ${parts.length ? parts.join(", ") : "no work"}`;
  });
}
