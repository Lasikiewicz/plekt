import { isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js"; import { correlateTrackerObservation } from "./trackerWriteIntents.js";
import {
  findExistingWatch, getCanonicalWatchState, getPlaystateForMedia, getPlaystateForMediaSync, insertWatchRecordSync, prefetchWatchRecordAssets,
  invalidateHistoryDerivedCaches, mediaKeyFor, mediaToWatchRecord, signalHistoryDataChanged, upsertPlaystateForMedia,
} from "./dataRepo.js";
import { createLoopStore } from "./loopStore.js";
import { trackerMediaIdentityKeys, trackerMediaKey } from "./traktClient.js";
import {
  findLatestTrackerOutboundSince, getTrackerConnection, listTrackerConnections, listTrackerItemStates, listUnrecordedTrackerPlayIds,
  recordTrackerPlay, replaceTrackerSnapshot, updateTrackerConnectionStatus,
} from "./trackerConnectionRepo.js";
import { buildTraktInboundTranslator } from "./traktInboundNumbering.js";
import { applyUnwatchedTransition, applyWatchedTransition } from "./watchStateTransitions.js";
import { completeDispatchTracking, dispatchProgressKey, finishDispatchTracking, markReservedDispatchStarted, reserveDispatchBatch } from "./syncOrchestrator.js";
import { settledTrackerHistoryTelemetry } from "./trackers/telemetry.js";
import { assertTrackerEnabled, getTrackerAdapter, runTrackerOperation, trackerImportSource, trackerSupportsTrigger } from "./trackers/registry.js";
import { createTrackerPoller } from "./trackers/polling.js";
import { assertTrackerGeneration, trackerGenerationCurrent } from "./trackers/generation.js";
import { db } from "../db.js";
import { readTrackerSnapshot } from "./trackers/connections.js";
import { syncSimklObservations } from "./trackers/simklSync.js";
import { syncDroppedTitleTracker } from "./droppedTitleTrackerSync.js";

const OUTBOUND_ECHO_WINDOW_MS = 30 * 60_000;
const TRACKER_TRANSITION_CONCURRENCY = 8;

function isOutboundEcho(item, state, now = Date.now()) {
  return item?.lastOutboundState === state && Number(item.lastOutboundAt || 0) > 0 && now - Number(item.lastOutboundAt) <= OUTBOUND_ECHO_WINDOW_MS;
}

function trackerItemIdentities(item = {}) {
  return [...new Set([String(item.mediaKey || ""), ...trackerMediaIdentityKeys(item.media)].filter(Boolean))];
}

// Old snapshots and outbound intents can temporarily coexist under different
// preferred keys (IMDb-rich vs TMDB-only) for the same episode. Collapse that
// identity graph before diffing so one real episode can never be retained or
// unwatched twice.
export function dedupeTrackerItemsByIdentity(items = []) {
  const groups = [];
  const groupByIdentity = new Map();
  for (const item of items) {
    const identities = trackerItemIdentities(item);
    const matches = [...new Set(identities.map((identity) => groupByIdentity.get(identity)).filter(Boolean))];
    let group = matches[0];
    if (!group) {
      group = { items: [], identities: new Set() };
      groups.push(group);
    }
    for (const other of matches.slice(1)) {
      if (other === group) continue;
      group.items.push(...other.items);
      for (const identity of other.identities) {
        group.identities.add(identity);
        groupByIdentity.set(identity, group);
      }
      const index = groups.indexOf(other);
      if (index >= 0) groups.splice(index, 1);
    }
    group.items.push(item);
    for (const identity of identities) {
      group.identities.add(identity);
      groupByIdentity.set(identity, group);
    }
  }
  return groups.map((group) => group.items.slice().sort((left, right) => {
    const observed = Number(Boolean(right.remoteWatchedAt)) - Number(Boolean(left.remoteWatchedAt));
    if (observed) return observed;
    const richness = trackerItemIdentities(right).length - trackerItemIdentities(left).length;
    if (richness) return richness;
    return Number(right.lastOutboundAt || 0) - Number(left.lastOutboundAt || 0);
  })[0]);
}

function buildRecentOutboundIndex(states, since) {
  const index = new Map();
  for (const state of states) {
    if (!state.lastOutboundState || Number(state.lastOutboundAt || 0) < since) continue;
    for (const identity of trackerItemIdentities(state)) {
      const current = index.get(identity);
      if (!current || Number(state.lastOutboundAt || 0) >= Number(current.lastOutboundAt || 0)) index.set(identity, state);
    }
  }
  return index;
}

function latestOutboundFromIndex(index, item) {
  return trackerItemIdentities(item)
    .map((identity) => index.get(identity))
    .filter(Boolean)
    .sort((a, b) => Number(b.lastOutboundAt || 0) - Number(a.lastOutboundAt || 0))[0] || null;
}

// Trakt's watched-progress endpoint can return a well-formed but incomplete
// snapshot during rate limiting. A single poll that omits an item is not
// enough evidence to delete local history or fan an unwatch out to other
// providers. Require the item to remain missing for a short grace period;
// this also protects single movies and small episode drops, not just whole
// seasons. If an item reappears, its pending removal is cancelled.
export const TRAKT_UNWATCH_CONFIRMATION_MS = 10 * 60_000;
const pendingTrackerUnwatches = new Map(); // provider -> mediaKey -> first-detected timestamp

export function showIdentityFromMediaKey(mediaKey = "") {
  const match = /^episode:(.*):s-?\d+e-?\d+$/.exec(mediaKey);
  return match ? match[1] : null;
}

// Splits missing Trakt rows into confirmed unwatches and candidates still in
// their grace period. `now` is injectable so truncation/recovery cases can be
// tested without waiting in real time.
export function partitionPendingTraktUnwatches(unwatchedCandidates, currentByKey, now = Date.now()) {
  return partitionPendingTrackerUnwatches("trakt", unwatchedCandidates, currentByKey, now);
}

export function partitionPendingTrackerUnwatches(provider, unwatchedCandidates, currentByKey, now = Date.now()) {
  if (!pendingTrackerUnwatches.has(provider)) pendingTrackerUnwatches.set(provider, new Map());
  const pendingTraktUnwatches = pendingTrackerUnwatches.get(provider);
  for (const mediaKey of pendingTraktUnwatches.keys()) {
    if (currentByKey.has(mediaKey)) pendingTraktUnwatches.delete(mediaKey);
  }
  const unwatched = [];
  const heldBack = [];
  for (const item of unwatchedCandidates) {
    const firstDetectedAt = pendingTraktUnwatches.get(item.mediaKey);
    if (firstDetectedAt == null) {
      pendingTraktUnwatches.set(item.mediaKey, now);
      heldBack.push(item);
    } else if (now - firstDetectedAt < TRAKT_UNWATCH_CONFIRMATION_MS) {
      heldBack.push(item);
    } else {
      unwatched.push(item);
      pendingTraktUnwatches.delete(item.mediaKey);
    }
  }
  return { unwatched, heldBack };
}

async function readSnapshot(provider, reconcile) {
  return readTrackerSnapshot(provider, { trigger: reconcile ? "user" : "scheduled" });
}

async function runTransitionBatch(items, handler, concurrency = TRACKER_TRANSITION_CONCURRENCY) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await handler(item);
    }
  });
  // Promise.all rejects as soon as one worker fails even though the other
  // workers remain in flight. Wait for every worker to settle before the
  // caller closes its progress reservation, then preserve the original
  // failure semantics by rethrowing the first error. This keeps the outer
  // reservation cleanup limited to items no worker ever started.
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
}

// Imports every individual Trakt play (rewatches included) as its own
// watch_history row. This runs alongside the existing "current watched
// state" diff above rather than replacing it: that diff still owns
// playstate/unwatch detection/outbound propagation for the latest play,
// while this only backfills additional plays it doesn't already know about
// (via tracker_play_history) and nudges playstate's timestamp forward when
// a newer rewatch is found. It never propagates to sync targets itself -
// these are historical facts, not new events for Plex/Emby/Jellyfin to act on.
async function importTrackerPlayHistory(provider, connection, publicConnection, previousStates, watchlistConfig = null, trigger = "scheduled") {
  if (isAuthoritativeRestoreActive()) return;
  const watermarkMs = Math.max(Number(publicConnection.historySyncedAt || 0),Number(publicConnection.connectedAt||0));
  if(!publicConnection.baselineComplete) {updateTrackerConnectionStatus(provider,{historySyncedAt:watermarkMs});return;}
  // A minute of overlap tolerates clock skew; tracker_play_history dedup
  // means re-seeing already-imported plays here is a harmless no-op.
  const startAt = watermarkMs > 0 ? new Date(watermarkMs - 60_000).toISOString() : undefined;
  const adapter = getTrackerAdapter(provider);
  if (!adapter.capabilities.playHistory?.supported) return;
  const entries = await runTrackerOperation(provider, "playHistory", {
    mediaType: "movie", trigger, satisfiedPreconditions: ["authenticated_connection", "complete_pagination"],
  }, connection, { startAt });
  if (!entries.length) return;

  const pendingIds = listUnrecordedTrackerPlayIds(provider, entries.map((entry) => entry.historyId));
  // Advance past every entry this fetch saw, not just the newly-inserted
  // ones, or an already-imported entry would keep it re-fetching the same
  // window forever instead of narrowing to genuinely new plays next time.
  let latestWatchedAt = entries.reduce((max, entry) => Math.max(max, entry.watchedAt), watermarkMs);
  const touchedKeys = new Map();
  const recentOutbound = buildRecentOutboundIndex(previousStates, Date.now() - OUTBOUND_ECHO_WINDOW_MS);
  // A Fix Match translated show's Trakt plays use the display numbering; local
  // lookups and inserts use the stored numbering.
  const toStoredNumbering = await inboundTranslators.get(provider)();

  for (const entry of entries.filter((entry) => pendingIds.has(entry.historyId)&&entry.watchedAt>=watermarkMs-60_000).sort((a, b) => a.watchedAt - b.watchedAt)) {
    if (isAuthoritativeRestoreActive()) return;
    const watchedAtIso = new Date(entry.watchedAt).toISOString(); if (correlateTrackerObservation(provider, connection, entry).status !== "unmatched") continue;

    // A play that looks like it just happened, right after Plembfin itself
    // last pushed a "watched" mark for this item to Trakt, is almost
    // certainly an echo of that push rather than a genuine new play - e.g. a
    // canonical replay (manual mark-watched, a watched-date correction) whose
    // pushed date was wrong for any reason. Importing it as history would
    // create a second local watch alongside the correct one. Uses Trakt's
    // own mediaKey shape here (not dataRepo's mediaKeyFor below) because
    // that's what recordTrackerOutbound in trackerDispatcher.js keys by.
    // Reads from the previous snapshot captured in pollTrakt before
    // replaceTrackerSnapshot() ran, rather than querying tracker_item_state
    // fresh here - replaceTrackerSnapshot rebuilds that table from the
    // just-fetched watched snapshot, and a just-pushed item that hasn't
    // shown up there yet would otherwise have its outbound-echo state wiped
    // out from under this check before it ever ran.
    // Match by every provider identity, not just the preferred key: an
    // outbound TMDB-only item and IMDb-rich history response are the same
    // play and must not create a duplicate local watch.
    const outboundState = latestOutboundFromIndex(recentOutbound, entry);
    if (
      outboundState?.lastOutboundState === "watched"
      && Number(outboundState.lastOutboundAt || 0) > 0
      && Math.abs(entry.watchedAt - Number(outboundState.lastOutboundAt)) <= OUTBOUND_ECHO_WINDOW_MS
    ) {
      recordTrackerPlay(provider, { historyId: entry.historyId, mediaKey: trackerMediaKey(entry.media), watchedAt: watchedAtIso, watchRecordId: "" });
      continue;
    }

    // Trakt's own mediaKey shape (used for tracker_item_state) differs from
    // dataRepo's canonical media_key column format - recompute the canonical
    // one here or findExistingWatch's lookup against watch_history never matches.
    const localMedia = toStoredNumbering(entry.media);
    const canonicalMediaKey = mediaKeyFor(localMedia);
    let existing = await findExistingWatch(canonicalMediaKey, watchedAtIso).catch(() => null);
    if (!existing) {
      // findExistingWatch only matches an exact (media_key, watched_at) pair.
      // A media-key built from this Trakt entry's own ids can differ from the
      // key an existing local record (e.g. a "manual" watch, or one imported
      // from a different platform) was stored under, even though both are
      // the same real episode - findExistingWatch then reports nothing and
      // this loop creates a duplicate watch_history row instead of
      // recognizing the episode is already recorded. getCanonicalWatchState
      // has the same coordinate/provider-id fallback matching every other
      // ingest path in the app relies on for exactly this mismatch; treat
      // its "watched" answer as authoritative so a Trakt history entry never
      // creates a second row for an episode Plembfin already has recorded.
      const canonicalState = await getCanonicalWatchState(localMedia).catch(() => null);
      if (canonicalState === "watched") {
        recordTrackerPlay(provider, { historyId: entry.historyId, mediaKey: trackerMediaKey(entry.media), watchedAt: watchedAtIso, watchRecordId: "" });
        continue;
      }
    }
    let watchRecordId = existing?.id || "";
    if (!existing) {
      const record = mediaToWatchRecord({ ...localMedia, watched_at: watchedAtIso, syncAction: "watched" }, trackerImportSource(provider));
      record.sync_action = "watched";
      // Without telemetry that looks "done", the scheduler's manual-dispatch
      // retry sweep (server/src/scheduled.js syncPendingManualDispatches)
      // treats any watched row as needing outbound propagation and re-fires
      // it - including back out to Trakt, which (before the source-echo fix
      // in trackerDispatcher.js) created a new Trakt play every poll for
      // every backfilled play. Mark these as already-settled so nothing ever
      // re-dispatches them to Plex/Emby/Jellyfin or Trakt.
      record.sync_dispatch_telemetry = settledTrackerHistoryTelemetry(trackerImportSource(provider),
        `Historical play imported from ${adapter.label} history; current watch state is tracked separately and was not re-propagated.`);
      // Commit only while the poll's connection generation is still current.
      const result = db.transaction(() => {
        assertTrackerGeneration(provider);
        return insertWatchRecordSync(record, { watchlistConfig });
      }).immediate();
      void prefetchWatchRecordAssets(result);
      watchRecordId = result.id;
    }
    recordTrackerPlay(provider, { historyId: entry.historyId, mediaKey: canonicalMediaKey, watchedAt: watchedAtIso, watchRecordId });
    const previous = touchedKeys.get(canonicalMediaKey);
    if (!previous || entry.watchedAt > previous.watchedAtMs) {
      touchedKeys.set(canonicalMediaKey, { media: localMedia, watchedAtMs: entry.watchedAt, watchedAtIso });
    }
  }

  // Nudge playstate's timestamp forward for a newer rewatch that the
  // already-watched short-circuit above skips inserting a fresh row for -
  // never flips unwatched->watched and never regresses an existing timestamp.
  for (const [, info] of touchedKeys) {
    const state = await getPlaystateForMedia(info.media).catch(() => null);
    if (state?.state === "watched" && Number(Date.parse(state.watched_at || "")) < info.watchedAtMs) {
      await upsertPlaystateForMedia(info.media, "watched", info.watchedAtIso, { skipInvalidate: true });
    }
  }

  if (touchedKeys.size) await invalidateHistoryDerivedCaches("importTraktPlayHistory");
  updateTrackerConnectionStatus(provider, { historySyncedAt: latestWatchedAt });
}

export function selectTrackerWatchedTransitions({ snapshot = [], previous = [], baseline = false, initialSyncMode = "baseline", reconcileKeys = new Set() } = {}) {
  const previousByKey = new Map(previous.map((item) => [item.mediaKey, item]));
  return baseline
    ? snapshot.filter((item) => {
      const prior = previousByKey.get(item.mediaKey);
      const newlyWatched = !prior || Number(item.watchedAt || 0) !== Number(prior.remoteWatchedAt || 0);
      return (newlyWatched || reconcileKeys.has(item.mediaKey)) && !isOutboundEcho(prior, "watched");
    })
    : [];
}

export const selectTraktWatchedTransitions = selectTrackerWatchedTransitions;

// The first pass of a connection (its baseline or initial import) records
// durable progress on the connection, independent of onboarding state, so a
// tracker added later from Settings can show how its import is going.
function initialSyncRecorder(provider) {
  const before = getTrackerConnection(provider);
  if (before?.status !== "connected" || before.baselineComplete) return null;
  let current = { mode: 'baseline', requiresPreview:before.initialSyncMode==='import', startedAt: Date.now() };
  return (patch) => {
    current = { ...current, ...patch };
    updateTrackerConnectionStatus(provider, { initialSync: current, connectionId: before.id });
  };
}

async function pollTracker(provider, options = {}) {
  const progress = initialSyncRecorder(provider);
  if (!progress) return pollTrackerPass(provider, options);
  progress({ status: "running" });
  try {
    const result = await pollTrackerPass(provider, options, progress);
    progress(result.skipped
      ? { status: "waiting", reason: result.reason || "" }
      : { status: "completed", finishedAt: Date.now(), imported: Number(result.watched || 0), remoteItems: Number(result.remoteItems || 0) });
    return result;
  } catch (error) {
    if (!error.stale) progress({ status: "failed", finishedAt: Date.now(), error: String(error.message || error).slice(0, 300) });
    throw error;
  }
}

async function pollTrackerPass(provider, { reconcile = false, trigger = "scheduled" } = {}, progress = null) {
  if(reconcile)throw Object.assign(new Error('Historical imports require an approved full-sync preview'),{code:'FULL_SYNC_PREVIEW_REQUIRED',status:409});
  const adapter = assertTrackerEnabled(provider);
  if (provider === "simkl") return syncSimklObservations({ trigger: reconcile ? "user" : trigger, reconcile });
  const pollStartedAt = Date.now();
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };
  const publicConnection = getTrackerConnection(provider);
  if (!publicConnection || publicConnection.status !== "connected") return { skipped: true, reason: "not-connected", watched: 0, unwatched: 0 };
  if (!trackerGenerationCurrent(provider)) return { skipped: true, reason: "connection-changed", watched: 0, unwatched: 0 };
  const { connection, snapshot } = await readSnapshot(provider, reconcile);
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };
  const previous = listTrackerItemStates(provider);
  const previousForDiff = dedupeTrackerItemsByIdentity(previous);
  const currentByKey = new Map(snapshot.map((item) => [item.mediaKey, item]));
  const currentIdentityKeys = new Set(snapshot.flatMap((item) => [item.mediaKey, ...trackerMediaIdentityKeys(item.media)]));
  const baseline = publicConnection.baselineComplete;
  const reconcileKeys = new Set();
  // Snapshot and ledger keys stay in Trakt's numbering; local reads and
  // transitions use the stored numbering of a Fix Match translated show.
  const toStoredNumbering = await inboundTranslators.get(provider)();
  if (baseline && reconcile) {
    await runTransitionBatch(snapshot, async (item) => {
      const state = await getCanonicalWatchState(toStoredNumbering(item.media)).catch(() => null);
      if (state !== "watched") reconcileKeys.add(item.mediaKey);
    });
  }
  const watched = selectTrackerWatchedTransitions({
    snapshot,
    previous,
    baseline,
    initialSyncMode: publicConnection.initialSyncMode,
    reconcileKeys,
  });
  // Two ways to reach a bulk historical projection, and neither can be worked
  // out from an entry's timestamp: the import mode's very first poll, and any
  // explicit reconcile (the onboarding Trakt import and the Import from Trakt
  // action both ask for one). "Start from current state" never reaches this
  // branch with anything to apply, so it creates no outbound work at all.
  //
  // A genuinely new watch that lands inside a reconcile pass is tagged the same
  // way. That is a deliberate trade: the pass exists to project history, and
  // mislabelling one minute's activity is far cheaper than letting a whole
  // account's backfill through a policy the user turned off.
  const historicalTrackerImport = reconcile || (!baseline && publicConnection.initialSyncMode === "import");
  // A "watched" mark just pushed to Trakt does not always show up in the
  // very next watched-snapshot fetch - Trakt's API can lag behind its own
  // write for several seconds. Without this guard, that stale snapshot looks
  // identical to a genuine remote unwatch (the item is simply missing), so a
  // poll landing in that window would delete the watch it just created.
  // A missing item after a recent "watched" push needs its own guard here.
  // Resolve the newest intent across every provider-id alias so an older
  // unwatch cannot hide a newer watch (or vice versa).
  const protectedMissing = new Map();
  const unwatchedCandidates = [];
  // An explicit reconciliation is a one-way repair: anything currently
  // watched on Trakt is restored locally, but an incomplete/filtered Trakt
  // response must not be interpreted as thousands of remote unwatches.
  if (baseline && !reconcile) {
    const echoCutoff = Date.now() - OUTBOUND_ECHO_WINDOW_MS;
    const recentOutbound = buildRecentOutboundIndex(previous, echoCutoff);
    for (const item of previousForDiff) {
      const identities = [item.mediaKey, ...trackerMediaIdentityKeys(item.media)];
      if (identities.some((identity) => currentIdentityKeys.has(identity))) continue;
      // Rows created solely to protect an outbound write are not proof that
      // Trakt ever reported the item watched. Only an observed snapshot row
      // can become a future inbound unwatch candidate.
      if (!Number(item.remoteWatchedAt || 0)) continue;
      // Match the single newest intent across watched/unwatched and every
      // provider-key alias. An older unwatch must not mask a newer watch.
      const latestOutbound = latestOutboundFromIndex(recentOutbound, item);
      if (latestOutbound?.lastOutboundState === "unwatched") continue;
      if (latestOutbound?.lastOutboundState === "watched") {
        protectedMissing.set(item.mediaKey, item);
        continue;
      }
      unwatchedCandidates.push(item);
    }
  }
  const { unwatched, heldBack } = partitionPendingTrackerUnwatches(provider, unwatchedCandidates, currentByKey);
  if (heldBack.length) {
    console.error(`[trackerSync] Held back ${heldBack.length} suspiciously large ${adapter.label} unwatch(es) from propagating - will re-check on the next poll instead of trusting a possibly incomplete response.`);
  }

  const config = await loadMediaConfig();
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };
  const loopStore = createLoopStore();
  // Reserve the whole known batch size on the sidebar sync-progress indicator
  // up front, instead of letting it climb one item at a time as the bounded-
  // concurrency workers below pick up new items over the life of the batch -
  // see reserveDispatchBatch in syncOrchestrator.js.
  const trackingReservation = reserveDispatchBatch(watched.length + unwatched.length, {
    progressKeys: [...watched, ...unwatched].map((item) => dispatchProgressKey(item.media)),
  });
  const deferredWatchedKeys = new Set();
  let deferredWatched = 0;
  let appliedUnwatched = 0;
  let processed = 0;
  progress?.({ total: watched.length, done: 0 });
  try {
    if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };
    await runTransitionBatch(watched, async (item) => {
      try {
        markReservedDispatchStarted(trackingReservation, item.media);
        const media = {
          ...toStoredNumbering(item.media),
          source: provider,
          watched_at: new Date(item.watchedAt || Date.now()).toISOString(),
          // Every later poll reports genuine new activity, but the very first
          // poll of an "Import all existing Trakt watched state" connection is
          // a bulk historical import. The provider matrix needs that stated
          // explicitly (see watchSyncPolicy.js) - an entry's timestamp alone
          // proves nothing, since a freshly imported play can be from today.
          ...(historicalTrackerImport ? { syncIntent: "import" } : {}),
        };
        const shouldDefer = () => {
          if (!trackerGenerationCurrent(provider)) return true;
          const latestOutbound = findLatestTrackerOutboundSince(
            provider,
            item,
            Date.now() - OUTBOUND_ECHO_WINDOW_MS,
          );
          if (latestOutbound?.lastOutboundState === "unwatched") return true;
          const latestPlaystate = getPlaystateForMediaSync(toStoredNumbering(item.media));
          return latestPlaystate?.state === "unwatched" && Number(latestPlaystate.updated_at || 0) >= pollStartedAt;
        };
        const transition = await applyWatchedTransition(media, config, loopStore, { trackDispatch: false, shouldDefer });
        if (transition.deferred) {
          deferredWatchedKeys.add(item.mediaKey);
          deferredWatched += 1;
          return;
        }
        signalHistoryDataChanged();
      } finally {
        completeDispatchTracking(trackingReservation, item.media);
        processed += 1;
        if (progress && (processed % 25 === 0 || processed === watched.length)) progress({ done: processed });
      }
    });
    await runTransitionBatch(unwatched, async (item) => {
      try {
        markReservedDispatchStarted(trackingReservation, item.media);
        // The poll's snapshot/diff is not atomic with outbound Trakt writes.
        // Re-read the persistent ledger at the last responsible moment: a
        // canonical replay may have primed its watched intent after this poll
        // fetched its snapshot but before this worker reached the item.
        const shouldDefer = () => {
          if (!trackerGenerationCurrent(provider)) return true;
          const latestOutbound = findLatestTrackerOutboundSince(
            provider,
            item,
            Date.now() - OUTBOUND_ECHO_WINDOW_MS,
          );
          if (latestOutbound?.lastOutboundState === "watched") return true;
          const latestPlaystate = getPlaystateForMediaSync(toStoredNumbering(item.media));
          return latestPlaystate?.state === "watched" && Number(latestPlaystate.updated_at || 0) >= pollStartedAt;
        };
        const media = { ...toStoredNumbering(item.media), source: provider, isValid: true };
        const transition = await applyUnwatchedTransition(media, config, loopStore, { trackDispatch: false, shouldDefer });
        if (transition.deferred || transition.heldBackSuspiciousBurst) {
          protectedMissing.set(item.mediaKey, item);
          return;
        }
        appliedUnwatched += 1;
        signalHistoryDataChanged();
      } finally {
        completeDispatchTracking(trackingReservation, item.media);
      }
    });
  } finally {
    finishDispatchTracking(trackingReservation);
  }

  if (deferredWatched || protectedMissing.size) {
    console.log(
      `[trackerSync] Held ${deferredWatched} watched and ${protectedMissing.size} unwatched ${adapter.label} change(s) for re-check because a newer local/outbound intent or safety guard took precedence.`,
    );
  }

  // Tracker transitions deliberately skip per-item invalidation so a whole
  // show does not rebuild the same derived data dozens of times. Flush once
  // after the batch or the TV detail page can continue showing stale progress.
  if (watched.length - deferredWatched || appliedUnwatched) await invalidateHistoryDerivedCaches("pollTrakt");

  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };

  // Held-back items must stay recorded as watched in tracker_item_state (not
  // wiped out by the fresh snapshot) or the next poll would lose the "still
  // missing?" comparison point and never be able to confirm or clear them.
  const heldBackAsSnapshotItems = heldBack.map((item) => ({ mediaKey: item.mediaKey, media: item.media, watchedAt: item.remoteWatchedAt }));
  // The same retention is required for a recent outbound watched marker. If
  // a stale snapshot suppresses the unwatch but then deletes the ledger row,
  // the item can never be reconsidered after the echo window. Carry it for
  // now; if it is genuinely still absent after the window, a later poll will
  // propagate that real remote unwatch.
  const protectedAsSnapshotItems = [...protectedMissing.values()].map((item) => ({
    mediaKey: item.mediaKey,
    media: item.media,
    watchedAt: item.remoteWatchedAt,
  }));
  // tracker_item_state has a UNIQUE(provider, media_key) constraint, but
  // Trakt's watched snapshot can contain more than one entry for the same
  // media_key (e.g. a rewatch reported as a separate play rather than folded
  // into one per-item row upstream). Inserting the raw combined list crashes
  // the whole snapshot replace on the first repeat, which then keeps failing
  // every poll. Keep the last entry per media_key instead of the first, so a
  // duplicate resolves to its most recently reported watched_at.
  // A watched transition deferred because of a newer local/outbound unwatch
  // must remain a candidate on the next poll. Store a null remote timestamp
  // for that row instead of accepting the stale snapshot's watched_at; once
  // the grace marker expires, an item still reported watched is reconsidered.
  const snapshotForStorage = snapshot.map((item) => deferredWatchedKeys.has(item.mediaKey)
    ? { ...item, watchedAt: null }
    : item);
  const dedupedSnapshotItems = [...new Map(
    [...snapshotForStorage, ...heldBackAsSnapshotItems, ...protectedAsSnapshotItems].map((item) => [item.mediaKey, item]),
  ).values()];
  replaceTrackerSnapshot(provider, dedupedSnapshotItems);
  updateTrackerConnectionStatus(provider, { baselineComplete: true, lastPolledAt: Date.now(), lastValidatedAt: Date.now(), lastError: null });

  try {
    await importTrackerPlayHistory(provider, connection, publicConnection, previous, config, reconcile ? "user" : "scheduled");
  } catch (error) {
    console.error(`[trackerSync] ${provider} play-history import failed (non-fatal)`, error);
  }

  return {
    skipped: false,
    reconcile,
    baselineEstablished: !baseline,
    watched: watched.length - deferredWatched,
    unwatched: appliedUnwatched,
    deferredWatched,
    deferredUnwatched: heldBack.length + protectedMissing.size,
    remoteItems: snapshot.length,
  };
}

const pollTrackers = createTrackerPoller({
  connections: listTrackerConnections,
  poll: (provider, options) => {
    assertTrackerEnabled(provider);
    return pollTracker(provider, options);
  },
  onError: (provider, error) => {
    updateTrackerConnectionStatus(provider, { lastPolledAt: Date.now(), lastError: error.message || String(error) });
  },
  eligible: (provider, { reconcile = false, trigger = "scheduled" } = {}) => trackerSupportsTrigger(provider, reconcile ? "user" : trigger),
});
const inboundTranslators = new Map([["trakt", buildTraktInboundTranslator]]);

export async function pollConnectedTrackers(options = {}) {
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active", watched: 0, unwatched: 0 };
  if (options.provider) assertTrackerEnabled(options.provider);
  const result = await pollTrackers(options);
  const trigger = options.reconcile ? "user" : options.trigger || "scheduled";
  const providers = listTrackerConnections()
    .filter((connection) => connection.status === "connected" && (!options.provider || connection.provider === options.provider)
      && trackerSupportsTrigger(connection.provider, trigger))
    .map((connection) => connection.provider);
  await Promise.all(providers.map((provider) => syncDroppedTitleTracker(provider, { trigger })
    .catch((error) => console.error(`[trackerSync] ${provider} dropped-title sync failed`, error.message || error))));
  return result;
}

// Trackers that do not poll on the scheduler (Simkl) check for remote changes
// after a media-server webhook instead, at most once per throttle window.
// Simkl has no scheduled poll; inbound checks after media-server events share this
// window so webhook storms (for example Up Next rewriting playstates) cannot burn
// daily quota. User Check now stays immediate and does not use this throttle.
export const TRACKER_EVENT_CHECK_THROTTLE_MS = 30 * 60_000;
// 0 means "never ran"; do not treat that as a recent check or the first event
// after reset is blocked for the whole throttle window.
let lastEventCheckAt = 0;

export function checkTrackersAfterMediaEvent({ now = Date.now(), poll = pollConnectedTrackers, logger = console.error } = {}) {
  if (lastEventCheckAt > 0 && now - lastEventCheckAt < TRACKER_EVENT_CHECK_THROTTLE_MS) return null;
  const providers = listTrackerConnections()
    .filter((connection) => connection.status === "connected" && !trackerSupportsTrigger(connection.provider, "scheduled")
      && trackerSupportsTrigger(connection.provider, "event"))
    .map((connection) => connection.provider);
  if (!providers.length) return null;
  lastEventCheckAt = now;
  return Promise.all(providers.map((provider) => poll({ provider, trigger: "event" })
    .catch((error) => logger(`[trackerSync] ${provider} event check failed`, error.message || error))));
}

export function resetTrackerEventCheckThrottle() {
  lastEventCheckAt = 0;
}

// Test helper: 0 means no armed event check since the last reset.
export function peekTrackerEventCheckAt() {
  return lastEventCheckAt;
}
