import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import {
  appendSyncHistory,
  isAuthoritativeRestoreActive,
  loadMediaConfig,
} from "../utils/configStore.js";
import {
  deletePlaybackProgress,
  findWatchedByAnyMediaKey,
  getCachedHistory,
  insertWatchRecord,
  invalidateHistoryDerivedCaches,
  mediaKeyFor,
  mediaToWatchRecord,
  seriesIdsForEpisodeMedia,
  showTitleNamesSeveralShows,
  supersedeUnwatchedTransitionsForRecordSync,
  updateWatchRecord,
  updateWatchTelemetry,
  upsertPlaystateForMedia,
} from "../utils/dataRepo.js";
import { createLoopStore } from "../utils/loopStore.js";
import { syncMediaPlaystate } from "../utils/syncOrchestrator.js";
import { applyUnwatchedTransition } from "../utils/watchStateTransitions.js";
import { watchImportMode } from "../utils/tuning.js";
import { buildWatchProvenance, provenanceTelemetryLines } from "../utils/watchProvenance.js";
import { isoDateTime, resolveWatchImportDate } from "../utils/watchDates.js";
import {
  countPendingManualWatchReviewItems,
  getManualWatchReview,
  listPendingManualWatchReviews,
  listPendingManualWatchReviewsCached,
  manualWatchReviewMedia,
  setManualWatchReviewStatus,
} from "../utils/manualWatchReview.js";
import { recordWatchAuditEvent } from "../utils/watchAudit.js";
import { resolveEpisodeSeriesItemId, withSeriesIdentity } from "../utils/seriesIdentity.js";

const REVIEW_MODES = new Set(["now", "release_day", "episode_timing", "custom"]);
const REVIEW_SOURCES = new Set(["plex", "emby", "jellyfin"]);

function reviewPath(req) {
  const path = req.path || new URL(req.originalUrl || req.url || "/", "https://local").pathname;
  return String(path).replace(/^\/api\/?/, "").replace(/^\/+|\/+$/g, "");
}

function reviewTelemetry(summary = {}, media = {}, mode = "now") {
  return [
    `Origin: ${media.source || "unknown"}`,
    "Action: Marked Watched",
    `Media: ${media.title || "unknown"}`,
    `Review decision: ${mode}`,
    `Loop-check: ${summary.skipped ? "Skipped propagation" : "Passed"}`,
    `Dispatch status: ${summary.status || "unknown"}`,
    `Details: ${summary.details || "No details"}`,
    ...provenanceTelemetryLines(media.watchProvenance || media.watch_provenance),
    ...(summary.targetStates || []).map((target) => (
      `${String(target.target || "unknown").replace(/^./, (value) => value.toUpperCase())} status: ${target.status}${target.detail ? ` - ${target.detail}` : ""}`
    )),
  ].join("\n");
}

function reviewMediaSummary(media = {}) {
  return {
    mediaKey: mediaKeyFor(media),
    mediaType: media.type || media.media_type || "unknown",
    title: media.title || "Unknown media",
    showTitle: media.showTitle || media.show_title,
    source: media.source || "unknown",
    ids: media.ids || {},
    season: media.season,
    episode: media.episode,
  };
}

function reviewSourceConfigured(config = {}, source = "") {
  const section = config?.[source] || {};
  if (section.disabled) return false;
  if (source === "plex") return Boolean(section.baseUrl && section.token);
  return Boolean(section.baseUrl && section.apiKey && section.userId);
}

function reviewProviderLabel(value = "") {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  if (provider === "jellyfin") return "Jellyfin";
  if (provider === "trakt") return "Trakt";
  return provider ? provider.replace(/^./, (character) => character.toUpperCase()) : "Unknown app";
}

function reviewTargetStateIsAcceptable(target = {}) {
  const status = String(target.status || "").trim().toLowerCase();
  const detail = String(target.detail || "").trim().toLowerCase();
  if (status === "success") return true;
  return status === "skipped" && (/no matching item found|skipped by the configured sync policy/.test(detail));
}

function safeReviewTargetState(target = {}) {
  const provider = String(target.target || "").trim().toLowerCase();
  const status = String(target.status || "unknown").trim().toLowerCase();
  const detail = String(target.detail || "").replace(/\s+/g, " ").trim().slice(0, 320);
  return {
    target: provider || "unknown",
    provider: reviewProviderLabel(provider),
    status,
    ...(detail ? { detail } : {}),
  };
}

function reviewHasProviderIds(media = {}) {
  const ids = media.ids || {};
  return Boolean(ids.imdb || ids.tmdb || ids.tvdb);
}

// A review stored with no provider ids would otherwise be applied by show
// title and coordinates, which matches every same-title show (defect AI: a
// dismissed Scrubs 2001 S01E04 review unmarked the 2026 reboot's S01E04 too).
// Resolve the series ids from the reporting app's own item first. When they
// cannot be resolved and stored history proves the title names two shows, keep
// the review pending rather than guess.
async function reviewMediaWithIdentity(review, config) {
  const media = manualWatchReviewMedia(review);
  if (media.type !== "episode" || reviewHasProviderIds(media)) return media;
  const source = String(review.source || media.source || "").trim().toLowerCase();
  const provenance = media.watchProvenance || media.watch_provenance || {};
  const itemId = String(review.source_item_id || media.itemId || media.providerItemId || provenance.item_id || "").trim();
  const seriesItemId = itemId && REVIEW_SOURCES.has(source)
    ? await resolveEpisodeSeriesItemId(source, itemId, config?.[source])
    : "";
  const resolved = seriesItemId
    ? await withSeriesIdentity({ ...media, source, itemId: media.itemId || itemId, seriesItemId }, config)
    : null;
  if (resolved && reviewHasProviderIds(resolved)) return { ...resolved, source: media.source };
  if (showTitleNamesSeveralShows(media.showTitle || media.show_title || "")) {
    throw Object.assign(
      new Error(`Could not confirm which show "${media.title || "this episode"}" belongs to from ${reviewProviderLabel(source)}; the review remains pending.`),
      { status: 409 },
    );
  }
  return media;
}

async function dismissReview(review) {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; manual watch-state changes are paused until it completes."), { status: 409 });
  }

  const config = await loadMediaConfig();
  const media = await reviewMediaWithIdentity(review, config);
  const source = String(review.source || media.source || "").trim().toLowerCase();
  if (!REVIEW_SOURCES.has(source)) {
    throw Object.assign(new Error("This review has no supported reporting app, so it remains pending."), { status: 400 });
  }
  const syncTargets = [...REVIEW_SOURCES].filter((target) => reviewSourceConfigured(config, target));
  if (!syncTargets.length) {
    throw Object.assign(new Error("No connected media apps are configured; the review remains pending."), { status: 409 });
  }

  const sourceItemId = String(review.source_item_id || media.itemId || media.providerItemId || "").trim();
  const providerItems = {
    ...(media.providerItems || media.provider_items || {}),
  };
  const sourceProviderItems = Array.isArray(providerItems[source])
    ? providerItems[source].map((value) => String(value || "").trim()).filter(Boolean)
    : providerItems[source]
      ? [String(providerItems[source]).trim()]
      : [];
  if (sourceItemId && !sourceProviderItems.length) providerItems[source] = [sourceItemId];
  const dispatchMedia = {
    ...media,
    // This is an explicit Plembfin action, so keep it out of the automatic
    // inbound-unwatch burst guard. The reporting app is carried separately by
    // the authoritative target list below.
    source: "manual",
    ...(sourceItemId && !media.itemId ? { itemId: sourceItemId } : {}),
    providerItems,
    provider_items: providerItems,
    // Dismissing a manual review is a Plembfin-wide unwatch decision. Keep the
    // target list authoritative so every configured media app receives the
    // correction, regardless of which app reported the original watch.
    syncTargets,
  };
  if (!dispatchMedia.isValid || !["movie", "episode"].includes(dispatchMedia.type)) {
    throw Object.assign(new Error("This review does not contain a valid movie or episode identity; the review remains pending."), { status: 400 });
  }

  const result = await applyUnwatchedTransition(
    dispatchMedia,
    config,
    createLoopStore(),
    {
      includeSourcePlatform: true,
      force: true,
      lane: "interactive",
    },
  );
  // The local canonical state is updated before the outbound request. Refresh
  // derived history even when the provider rejects the correction so the UI
  // does not retain a stale watched item while the review stays pending for a
  // retry.
  await invalidateHistoryDerivedCaches("dismissManualWatchReview").catch(() => null);

  const targetStates = Array.isArray(result.summary?.targetStates) ? result.summary.targetStates : [];
  const failedTargets = targetStates.filter((target) => !reviewTargetStateIsAcceptable(target));
  if (!targetStates.length || failedTargets.length) {
    const successfulTargets = targetStates
      .filter((target) => String(target.status || "").trim().toLowerCase() === "success")
      .map((target) => reviewProviderLabel(target.target));
    const failureSummary = failedTargets.length
      ? failedTargets.map((target) => {
        const safeTarget = safeReviewTargetState(target);
        return `${safeTarget.provider}: ${safeTarget.detail || "did not confirm the correction"}`;
      }).join("; ")
      : "No provider result was returned";
    const acceptedSummary = successfulTargets.length
      ? `${successfulTargets.join(" and ")} accepted the correction. `
      : "";
    const error = new Error(
      `Could not complete the unwatched correction for "${dispatchMedia.title || "this item"}". `
      + `${acceptedSummary}Failed on ${failureSummary}. The review remains pending.`,
    );
    // This is an actionable provider-state conflict rather than an unhandled
    // server fault. Keep a small, user-safe diagnostic payload so the UI can
    // name the target app and preserve the retry context without exposing
    // configured URLs, credentials, or upstream stacks.
    Object.assign(error, {
      status: 409,
      failureTargets: failedTargets.map(safeReviewTargetState),
      targetStates: targetStates.map(safeReviewTargetState),
    });
    throw error;
  }

  await appendSyncHistory({
    mediaType: dispatchMedia.type || "unknown",
    title: dispatchMedia.title || "Unknown media",
    source: "manual",
    status: result.summary?.status || "unknown",
    details: result.summary?.details || "",
    action: "unwatched",
    targetStates: result.summary?.targetStates || [],
    rawPayloadDebug: {
      event: "manual_watch_review_dismiss",
      reviewId: review.id,
      sourcePlatform: source,
      mediaKey: mediaKeyFor(dispatchMedia),
      watchRecordId: result.id || null,
    },
  }).catch((error) => console.error("Failed to append manual review unwatch history", error));
  recordWatchAuditEvent({
    eventType: "manual_watch_review_decided",
    timestamp: Date.now(),
    action: "unwatched",
    watchRecordId: result.id || "",
    mediaKey: mediaKeyFor(dispatchMedia),
    mediaType: dispatchMedia.type,
    title: dispatchMedia.title,
    showTitle: dispatchMedia.showTitle,
    source,
    season: dispatchMedia.season,
    episode: dispatchMedia.episode,
    status: "dismissed",
    details: "Manual watch review dismissed; marked unwatched across connected media apps.",
    payload: {
      reviewId: review.id,
      sourcePlatform: source,
      targetStates: result.summary?.targetStates || [],
    },
  });

  const updated = setManualWatchReviewStatus(review.id, "dismissed");
  await invalidateHistoryDerivedCaches("dismissManualWatchReview").catch(() => null);
  return {
    id: review.id,
    status: "dismissed",
    action: "unwatched",
    source,
    syncStatus: result.summary?.status || "unknown",
    targetStates: result.summary?.targetStates || [],
    review: updated,
  };
}

// A review can carry the episode's own ids (an Emby library-history review of
// Slow Horses S06E01 held only its episode TVDB id). Use the title's proven
// series ids where the scheduled repair would, so the history row is keyed on
// the show.
function withProfileSeriesIds(media) {
  const seriesIds = seriesIdsForEpisodeMedia(media);
  if (!seriesIds) return media;
  const ids = { ...(media.ids || {}) };
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    if (seriesIds[provider]) ids[provider] = seriesIds[provider];
    else delete ids[provider];
  }
  return { ...media, ids };
}

// Playstate goes under the identity of the history row just written or
// updated. Matching on the review's own ids let an episode-id alias take the
// write while history sat under the show key, so the review stayed listed.
async function upsertPlaystateLikeHistory(media, historyRow, watchedAt) {
  const ids = {
    imdb: historyRow.imdb_id || undefined,
    tmdb: historyRow.tmdb_id || undefined,
    tvdb: historyRow.tvdb_id || undefined,
  };
  const mediaKey = historyRow.media_key || mediaKeyFor({ ...media, ids });
  await upsertPlaystateForMedia({ ...media, ids }, "watched", watchedAt, { skipInvalidate: true, mediaKey });
}

async function approveReview(review, requestedMode = "", requestedWatchedAt = "") {
  if (isAuthoritativeRestoreActive()) {
    throw Object.assign(new Error("An authoritative watch-history restore is active; manual watch-state changes are paused until it completes."), { status: 409 });
  }

  const config = await loadMediaConfig();
  const requested = String(requestedMode || "").toLowerCase();
  const mode = REVIEW_MODES.has(requested)
    ? requested
    : (watchImportMode() === "review" ? "now" : watchImportMode());
  const media = withProfileSeriesIds(await reviewMediaWithIdentity(review, config));
  let dateChoice;
  if (mode === "custom") {
    const watchedAt = isoDateTime(requestedWatchedAt);
    if (!watchedAt) {
      throw Object.assign(new Error("A valid manual watch date and time is required."), { status: 400 });
    }
    if (Date.parse(watchedAt) > Date.now() + 60_000) {
      throw Object.assign(new Error("The manual watch date and time cannot be in the future."), { status: 400 });
    }
    dateChoice = {
      watchedAt,
      previewWatchedAt: watchedAt,
      requiresReview: false,
      reason: "manual date and time",
    };
  } else {
    const historyRows = mode === "episode_timing" ? await getCachedHistory().catch(() => []) : [];
    dateChoice = resolveWatchImportDate({
      mode,
      manualMark: true,
      releaseDate: review.release_date || media.releaseDate,
      fallbackDate: review.observed_watched_at || media.watched_at,
      media,
      historyRows,
    });
  }
  media.watched_at = dateChoice.watchedAt;
  media.watchProvenance = buildWatchProvenance(
    {
      source: media.source,
      event: "manual_watch_review",
      phase: "completed",
      itemId: review.source_item_id || media.itemId,
    },
    {
      ingestPath: "manual_watch_review",
      sourceTimestamp: review.observed_watched_at || "",
      note: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy.`,
    },
  );

  const existing = await findWatchedByAnyMediaKey(media).catch(() => null);
  if (existing) {
    // A review is an explicit user decision. An existing watched row is only
    // an identity match, not a reason to discard the date the user selected.
    // This is especially important when the provider flag matches an older
    // Trakt/import row under a different media key: the old implementation
    // closed the review while silently keeping that row's historical date.
    const updatedRecord = await updateWatchRecord(
      existing.id,
      { watched_at: media.watched_at },
      { auditSource: "manual_watch_review" },
    );
    if (!updatedRecord?.ok) throw new Error(updatedRecord?.error || "Stored watch record could not be updated");
    supersedeUnwatchedTransitionsForRecordSync({ ...existing, ...(updatedRecord.record || {}), id: existing.id, sync_action: "watched" });
    media.watchRecordId = existing.id;
    await deletePlaybackProgress(media).catch(() => null);
    await upsertPlaystateLikeHistory(media, existing, media.watched_at);

    const loopStore = createLoopStore();
    const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
      skipped: false,
      status: "error",
      details: `Manual watch review propagation failed: ${error.message || String(error)}`,
      targetStates: [],
    }));
    await updateWatchTelemetry(existing.id, reviewTelemetry(summary, media, mode), { skipInvalidate: true });
    await appendSyncHistory({
      mediaType: media.type || "unknown",
      title: media.title || "Unknown media",
      source: media.source || "unknown",
      status: summary.status || "unknown",
      details: summary.details || "",
      action: "watched",
      targetStates: summary.targetStates || [],
      rawPayloadDebug: {
        event: "manual_watch_review",
        reviewId: review.id,
        decisionMode: mode,
        watchedAt: media.watched_at,
        mediaKey: mediaKeyFor(media),
        existingWatchRecordId: existing.id,
      },
    }).catch((error) => console.error("Failed to append manual review sync history", error));
    recordWatchAuditEvent({
      eventType: "manual_watch_review_decided",
      timestamp: Date.now(),
      action: "watched",
      mediaKey: mediaKeyFor(media),
      mediaType: media.type,
      title: media.title,
      showTitle: media.showTitle,
      source: media.source,
      season: media.season,
      episode: media.episode,
      status: "approved",
      details: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy; existing history updated.`,
      payload: { reviewId: review.id, mode, watchedAt: media.watched_at, existingWatchRecordId: existing.id },
    });
    const updated = setManualWatchReviewStatus(review.id, "approved", mode);
    await invalidateHistoryDerivedCaches("approveManualWatchReview").catch(() => null);
    return {
      id: review.id,
      status: "approved",
      mode,
      watchedAt: media.watched_at,
      watchRecordId: existing.id,
      existing: true,
      syncStatus: summary.status || "unknown",
      targetStates: summary.targetStates || [],
      review: updated,
    };
  }

  const watchRecord = mediaToWatchRecord(media, media.source || "manual");
  watchRecord.sync_action = "watched";
  watchRecord.sync_dispatch_telemetry = [
    `Origin: ${media.source || "manual"}`,
    "Loop-check: Passed",
    "Dispatch status: pending",
    `Details: Manual watch review approved with the ${mode.replaceAll("_", " ")} policy; queueing sync.`,
  ].join("\n");
  const inserted = await insertWatchRecord(watchRecord, { skipInvalidate: true, watchlistConfig: config });
  supersedeUnwatchedTransitionsForRecordSync({ ...inserted.record, id: inserted.id });
  media.watchRecordId = inserted.id;
  await deletePlaybackProgress(media).catch(() => null);
  await upsertPlaystateLikeHistory(media, inserted.record, inserted.record.watched_at);

  const loopStore = createLoopStore();
  const summary = await syncMediaPlaystate(media, config, loopStore, { lane: "interactive" }).catch((error) => ({
    skipped: false,
    status: "error",
    details: `Manual watch review propagation failed: ${error.message || String(error)}`,
    targetStates: [],
  }));
  await updateWatchTelemetry(inserted.id, reviewTelemetry(summary, media, mode), { skipInvalidate: true });
  await appendSyncHistory({
    mediaType: media.type || "unknown",
    title: media.title || "Unknown media",
    source: media.source || "unknown",
    status: summary.status || "unknown",
    details: summary.details || "",
    action: "watched",
    targetStates: summary.targetStates || [],
    rawPayloadDebug: {
      event: "manual_watch_review",
      reviewId: review.id,
      decisionMode: mode,
      watchedAt: inserted.record.watched_at,
      mediaKey: mediaKeyFor(media),
    },
  }).catch((error) => console.error("Failed to append manual review sync history", error));
  recordWatchAuditEvent({
    eventType: "manual_watch_review_decided",
    timestamp: Date.now(),
    action: "watched",
    mediaKey: mediaKeyFor(media),
    mediaType: media.type,
    title: media.title,
    showTitle: media.showTitle,
    source: media.source,
    season: media.season,
    episode: media.episode,
    status: "approved",
    details: `Manual watch review approved with the ${mode.replaceAll("_", " ")} policy.`,
    payload: { reviewId: review.id, mode, watchedAt: inserted.record.watched_at },
  });
  const updated = setManualWatchReviewStatus(review.id, "approved", mode);
  await invalidateHistoryDerivedCaches("approveManualWatchReview").catch(() => null);
  return {
    id: review.id,
    status: "approved",
    mode,
    watchedAt: inserted.record.watched_at,
    watchRecordId: inserted.id,
    syncStatus: summary.status || "unknown",
    targetStates: summary.targetStates || [],
    review: updated,
  };
}

export async function handleManualWatchReview(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  const normalizedPath = String(path || reviewPath(req)).replace(/^\/|\/$/g, "");
  const parts = normalizedPath.split("/");
  const action = parts.length >= 3 ? parts[2] : "";
  const id = parts.length >= 2 ? decodeURIComponent(parts[1]) : "";

  if (req.method === "GET" && !action) {
    const summaryOnly = String(req.query?.summary || "") === "1";
    const forceRefresh = String(req.query?.refresh || "") === "1";
    const pendingReviews = forceRefresh
      ? listPendingManualWatchReviews({ includeWatchContext: !summaryOnly })
      : listPendingManualWatchReviewsCached({ includeWatchContext: !summaryOnly });
    return sendJson(res, {
      ok: true,
      // `count` is the number of logical decisions shown in the UI. Keep the
      // raw provider-row count available for diagnostics because Plex and
      // Emby can report the same episode independently and the page merges
      // those records into one row.
      count: countPendingManualWatchReviewItems(pendingReviews),
      reviewCount: pendingReviews.length,
      // The sidebar summary hides reviews the page has just decided. It needs
      // the ids to subtract only those the server still reports, otherwise a
      // decided review cancels out a newly flagged one.
      ...(summaryOnly ? { ids: pendingReviews.map((review) => String(review.id)) } : {}),
      reviews: summaryOnly ? [] : pendingReviews,
    }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!id || !["approve", "dismiss", "defer"].includes(action)) return sendJson(res, { error: "Review action is invalid" }, 400);

  const review = getManualWatchReview(id);
  if (!review) return sendJson(res, { error: "Manual watch review not found" }, 404);
  if (action === "dismiss") {
    try {
      const result = review.status === "pending"
        ? await dismissReview(review)
        : { id, status: review.status, action: "unwatched", source: review.source, review };
      const pendingReviews = listPendingManualWatchReviews();
      return sendJson(res, {
        ok: true,
        ...result,
        count: countPendingManualWatchReviewItems(pendingReviews),
        reviewCount: pendingReviews.length,
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const status = Number(error?.status);
      return sendJson(res, {
        ok: false,
        error: error.message || "Manual watch review dismissal failed",
        ...(Array.isArray(error?.failureTargets) ? { failureTargets: error.failureTargets } : {}),
        ...(Array.isArray(error?.targetStates) ? { targetStates: error.targetStates } : {}),
      }, Number.isInteger(status) ? status : 500);
    }
  }
  if (action === "defer") {
    const pendingReviews = listPendingManualWatchReviews();
    return sendJson(res, {
      ok: true,
      review,
      count: countPendingManualWatchReviewItems(pendingReviews),
      reviewCount: pendingReviews.length,
    });
  }

  const body = await readJson(req);
  try {
    const result = review.status === "pending"
      ? await approveReview(review, body.mode || body.watchImportMode, body.watched_at || body.watchedAt)
      : { id, status: review.status, mode: review.decision_mode, watchedAt: review.media?.watched_at || "", review };
    const pendingReviews = listPendingManualWatchReviews();
    return sendJson(res, {
      ok: true,
      ...result,
      count: countPendingManualWatchReviewItems(pendingReviews),
      reviewCount: pendingReviews.length,
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    const status = Number(error?.status);
    return sendJson(res, { ok: false, error: error.message || "Manual watch review approval failed" }, Number.isInteger(status) ? status : 500);
  }
}
