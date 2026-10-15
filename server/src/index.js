import { sendJson, notFound } from "./utils/http.js";
import { isClaimRequired } from "./appConfig.js";
import { handleLogin, handleLogout, handleAuthStatus, handleAuthApiKey, handleAuthWebhookSecret, handleAuthCredentials, handleAuthClaim, handleRevokeAllSessions, requireAdmin } from "./utils/auth.js";
import { backfillUnknownShowTitles } from "./utils/dataRepo.js";
import { runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener } from "./scheduler.js";
import { handleBackupExport, handleBackupImport, handleImport, handlePlektBackups, handleWatchBackups } from "./routes/backups.js";
import { handleAppearance, handleConfig, handleMediaAppLinks, handleSeerrMediaStatus, handleSeerrRequest, handleSeerrStatus, handleTestConnection, handleTestPlexNotifications } from "./routes/admin.js";
import { handleAddWatchDate, handleClearMissingTelemetry, handleDeleteHistoryRecord, handleDeleteMedia, handleDeleteWatchDate, handleDeleteWatchDates, handleDuplicateWatchCleanup, handleDuplicateWatchScan, handleFullSyncWatchstates, handleHistory, handleHistoryAudit, handleMergeShows, handleMovies, handleRematchShow, handleShow, handleShows, handleUpdateWatch, handleUpdateWatchDates, handleWatchDates } from "./routes/media.js";
import { handleActiveSessions, handleCronSync, handleCronSyncStatus, handleForceSync, handleForceSyncPlan, handleForceSyncCancellation, handleLibraryForceSync, handleLibraryForceSyncStatus, handleManualUnwatch, handleMediaForceSync, handleMediaForceSyncStatus, handleManualWatch, handleNowPlaying, handlePlaybackProgressList, handlePlaybackProgressUnwatch, handlePlaybackProgressWatch, handleDismissSyncHistory, handleDismissSyncMatch, handleRetryAllSyncActivity, handleRetrySync, handleRetrySyncActivityGroup, handleRetrySyncHistory, handleStopForceSync, handleSyncActivity, handleSyncActivityGroup, handleSyncHistory, handleSyncJobs, handleSyncLibraries, handleUpNextRemove, handleUpNextSync,
  handleUpNextDismissed,
  handleUpNextRestore, handleWebhook } from "./routes/sync.js";
import { handleSeasonPosterOptions, handleSeasonPosters } from "./routes/seasonArtwork.js";
import { handleDiscover, handleDiscoverDismiss, handleFanartImages, handleFixMatchSearch, handleMediaSearch, handleOmdbRating, handlePoster, handlePosterBatch, handleRemoteArtwork, handleTmdbCollection, handleTmdbDetails, handleTmdbDetailsBatch, handleTmdbImages, handleTmdbPerson, handleTmdbPoster, handleTmdbProfile, handleTmdbSearch, handleTmdbSeason, handleTvdbImages, handleTvdbSearch, handleUpcoming, handleUpNext, handleUpNextShow, handleYoutubeMeta } from "./routes/metadata.js";
import { handleAdminFixHistory, handleBackfillStatus, handleBackfillTrakt, handleCacheStats, handleChangelog, handleClearCache, handleDebugPlexMatch, handleDiagnosticLogs, handleMaintenanceStub, handlePing, handleRefreshTmdbMetadata, handleRefreshTvdbMetadata, handleRematchTvShows, handleSyncHealth, handleSyncMatchReport, handleEpisodeTitleAudit, handleEpisodeTitleBackfill, handlePhantomWatchAudit, handlePhantomWatchRepair, handleStaleTraktImportAudit, handleStaleTraktImportRepair, handleStalePendingWatchAudit, handleStalePendingWatchRepair, handleSplitIdentityUnwatchAudit, handleSplitIdentityUnwatchRepair, handleLikelyFalseUnwatchAudit, handleLikelyFalseUnwatchRepair } from "./routes/maintenance.js";
import { handleWipeDataPreview, handleWipeData } from "./routes/wipeData.js";
import { handleEmbyLikeAuth, handleEmbyLikeConnection, handlePlexAuth, handlePlexConnection } from "./routes/mediaAuth.js";
import { handleTrackerAuth, handleTrackerConnections } from "./routes/trackerAuth.js";
import { handleLiveUpdates } from "./routes/liveUpdates.js";
import { handleSyncAttention } from "./routes/syncAttention.js";
import { handleSetupStatus, handleSetupStep, handleSetupImport, handleSetupComplete, handleSetupRestart, handleSetupChecklistDismiss, handleSetupCtaDismiss } from "./routes/onboarding.js";
import { handlePersonalMedia } from "./routes/personal.js";
import { handleRatingSync } from "./routes/ratingSync.js";
import { handleWatchlistSync } from "./routes/watchlistSync.js";
import { handleManualWatchReview } from "./routes/manualWatchReview.js";
import { handlePlaystateAliases } from "./routes/playstateAliases.js";
import { handleWebhookPort } from "./routes/webhookPort.js";
import { isDemoMode } from "./utils/demoMode.js";
import { handleTautulli } from "./routes/tautulli.js";
import { handlePlektRestore, handlePlektRestoreUpload } from "./routes/plektRestore.js";
import { noteRequestActivity } from "./utils/cacheWarmup.js";

function routePath(req) {
  const path = req.path || new URL(req.originalUrl || req.url, "https://local").pathname;
  return path.replace(/^\/api\/?/, "").replace(/^\/+/, "") || "";
}

// Reachable before a pristine install's administrator account is claimed.
// Everything else returns 403 CLAIM_REQUIRED so an unclaimed instance can't
// be driven through any other API surface.
const CLAIM_GATE_WHITELIST = new Set(["ping", "changelog", "login", "logout", "auth/status", "auth-status", "auth/claim"]);

// The hosted demo is an immutable catalogue. Read-only catalogue routes are
// still available, but anything that could expose credentials, create a
// connection, run a sync, export/restore data, or inspect diagnostics is
// rejected before it reaches a normal route handler.
const DEMO_DISABLED_ROUTE_PATTERNS = Object.freeze([
  /^setup(?:\/|$)/i,
  /^auth\/(?:apikey|webhook-secret|credentials|claim|sessions\/revoke-all)(?:\/|$)/i,
  /^(?:media-auth|media-connections|tracker-auth|tracker-connections)(?:\/|$)/i,
  /^(?:backup|watch-backups|plembfin-backups)(?:\/|$)/i,
  /^(?:import|delete-media|wipe-data|clear-cache|cache-stats)(?:\/|$)/i,
  /^(?:force-sync|full-sync-watchstates|cron-sync|stop-force-sync)(?:\/|$)/i,
  /^(?:sync-jobs|sync\/|sync-match-report|health\/sync|sync-attention|sync-activity|sync-history|manual-watch-review|retry-sync)(?:\/|$)/i,
  /^(?:test-connection|test-plex-notifications|seerr)(?:\/|$)/i,
  /^(?:tautulli)(?:\/|$)/i,
  /^(?:tmdb-search|tvdb-search|fix-match-search|media-search|refresh-tmdb-metadata|refresh-tvdb-metadata)(?:\/|$)/i,
  /^(?:remote-artwork|tmdb-poster|tmdb-profile|fanart-images|tvdb-images|tmdb-images|season-poster-options|youtube-meta|omdb-rating)(?:\/|$)/i,
  /^(?:admin-|phantom-watch-|episode-title-|stale-|split-identity-|likely-false-)/i,
  /^(?:rematch-show|merge-shows|duplicate-watch-|playstate-aliases)/i,
  /^(?:diagnostic-logs|debug-plex-match|webhook)$/i,
  /^webhook-port(?:\/|$)/i,
]);

const DEMO_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEMO_LOGIN_ROUTES = new Set(["login", "logout"]);
// These endpoints use POST only to carry a bounded batch payload. They read
// the bundled catalogue and do not mutate user/demo state, so they must remain
// available in the immutable demo just like their GET equivalents.
const DEMO_READ_ONLY_POST_ROUTES = new Set(["tmdb-details-batch"]);

function demoRouteDisabled(path) {
  return DEMO_DISABLED_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

function demoMutationResponse(path, res) {
  const operationId = `demo:simulated:${Date.now()}`;
  return sendJson(res, {
    ok: true,
    demo: true,
    simulated: true,
    status: "simulated",
    message: "Demo mode: this action was simulated and was not saved.",
    operationId,
    path,
    inserted: 0,
    skipped: 0,
    rejected: [],
    succeeded: 0,
    failed: 0,
    queued: 0,
    propagated: 0,
    syncQueued: 0,
    items: 0,
    synced: 0,
    imported: 0,
    results: [],
    records: [],
    targetStates: [],
    providerDismissals: [],
  }, 200, { "Cache-Control": "no-store" });
}

async function dispatch(req, res) {
  try {
    const path = routePath(req);
    // Health checks poll constantly and cost nothing; only real requests hold off the warm-up.
    if (path !== "ping") noteRequestActivity();
    if (isDemoMode()) {
      if (demoRouteDisabled(path)) {
        return sendJson(res, {
          error: "This action is disabled in the public demo",
          code: "DEMO_DISABLED",
          retryable: false,
        }, 403, { "Cache-Control": "no-store" });
      }
      if (DEMO_MUTATION_METHODS.has(String(req.method || "").toUpperCase())
        && !DEMO_LOGIN_ROUTES.has(path)
        && !DEMO_READ_ONLY_POST_ROUTES.has(path)) {
        if (!(await requireAdmin(req, res))) return;
        return demoMutationResponse(path, res);
      }
    }
    if (isClaimRequired() && !CLAIM_GATE_WHITELIST.has(path)) {
      return sendJson(res, { error: "This instance has not been claimed yet", code: "CLAIM_REQUIRED", retryable: false }, 403);
    }
    if (path === "ping") return handlePing(req, res);
    if (path === "live-updates") return handleLiveUpdates(req, res);
    if (path === "changelog") return handleChangelog(req, res);
    if (path === "diagnostic-logs") return handleDiagnosticLogs(req, res);
    if (path === "debug-plex-match") return handleDebugPlexMatch(req, res);
    if (path === "login") return handleLogin(req, res);
    if (path === "logout") return handleLogout(req, res);
    if (path === "auth/status" || path === "auth-status") return handleAuthStatus(req, res);
    if (path === "auth/claim") return handleAuthClaim(req, res);
    if (path === "setup/status") return handleSetupStatus(req, res);
    if (path === "setup/step") return handleSetupStep(req, res);
    if (path === "setup/import") return handleSetupImport(req, res);
    if (path === "setup/complete") return handleSetupComplete(req, res);
    if (path === "setup/restart") return handleSetupRestart(req, res);
    if (path === "setup/checklist/dismiss") return handleSetupChecklistDismiss(req, res);
    if (path === "setup/cta-dismiss") return handleSetupCtaDismiss(req, res);
    if (path === "auth/apikey") return handleAuthApiKey(req, res);
    if (path === "auth/webhook-secret") return handleAuthWebhookSecret(req, res);
    if (path === "auth/sessions/revoke-all") return handleRevokeAllSessions(req, res);
    if (path === "auth/credentials") return handleAuthCredentials(req, res);
    if (path === "media-auth/plex/start" || /^media-auth\/plex\/[a-f\d-]+\/(?:status|server)$/i.test(path)) return handlePlexAuth(req, res, path);
    if (path === "media-connections/plex") return handlePlexConnection(req, res);
    if (path === "media-auth/emby/login" || path === "media-auth/jellyfin/login" || path === "media-auth/jellyfin/quick-connect/start" || /^media-auth\/jellyfin\/quick-connect\/[a-f\d-]+\/status$/i.test(path)) return handleEmbyLikeAuth(req, res, path);
    if (path === "media-connections/emby") return handleEmbyLikeConnection(req, res, "emby");
    if (path === "media-connections/jellyfin") return handleEmbyLikeConnection(req, res, "jellyfin");
    if (path === "tracker-auth/trakt/start" || /^tracker-auth\/trakt\/[a-f\d-]+\/status$/i.test(path)) return handleTrackerAuth(req, res, path);
    if (path === "tracker-connections" || path === "tracker-connections/trakt") return handleTrackerConnections(req, res, path);
    if (path === "config") return handleConfig(req, res);
    if (path === "tautulli/status") return handleTautulli(req, res, "status");
    if (path === "tautulli/users") return handleTautulli(req, res, "users");
    if (path === "tautulli/test") return handleTautulli(req, res, "test");
    if (path === "tautulli/backup") return handleTautulli(req, res, "backup");
    if (path === "tautulli/import/preview/start") return handleTautulli(req, res, "preview-start");
    if (path === "tautulli/import/preview/status") return handleTautulli(req, res, "preview-status");
    if (path === "tautulli/import/preview") return handleTautulli(req, res, "preview");
    if (path === "tautulli/import") return handleTautulli(req, res, "import");
    if (path === "appearance") return handleAppearance(req, res);
    if (path === "history") return handleHistory(req, res);
    if (path === "history-audit") return handleHistoryAudit(req, res);
    if (path === "delete-history-record") return handleDeleteHistoryRecord(req, res);
    if (path === "sync-jobs") return handleSyncJobs(req, res);
    if (path === "sync/libraries") return handleSyncLibraries(req, res);
    if (path === "sync-match-report") return handleSyncMatchReport(req, res);
    if (path === "sync-match-report/dismiss") return handleDismissSyncMatch(req, res);
    if (path === "health/sync") return handleSyncHealth(req, res);
    if (path === "sync-attention") return handleSyncAttention(req, res);
    if (path === "sync-activity") return handleSyncActivity(req, res);
    if (path === "sync-activity/group") return handleSyncActivityGroup(req, res);
    if (path === "sync-history") return handleSyncHistory(req, res);
    if (path === "sync-history/retry") return handleRetrySyncHistory(req, res);
    if (path === "sync-history/dismiss") return handleDismissSyncHistory(req, res);
    if (path === "sync-history/retry-group") return handleRetrySyncActivityGroup(req, res);
    if (path === "sync-history/retry-all") return handleRetryAllSyncActivity(req, res);
    if (path === "clear-missing-telemetry") return handleClearMissingTelemetry(req, res);
    if (path === "movies") return handleMovies(req, res);
    if (path === "delete-media") return handleDeleteMedia(req, res);
    if (path === "shows") return handleShows(req, res);
    if (path === "show") return handleShow(req, res);
    if (path === "upcoming") return handleUpcoming(req, res);
    if (path === "up-next") return handleUpNext(req, res);
    if (path === "up-next/show") return handleUpNextShow(req, res);
    if (path === "up-next/remove") return handleUpNextRemove(req, res);
    if (path === "up-next/sync") return handleUpNextSync(req, res);
    if (path === "up-next/dismissed") return handleUpNextDismissed(req, res);
    if (path === "up-next/restore") return handleUpNextRestore(req, res);
    if (path === "full-sync-watchstates") return handleFullSyncWatchstates(req, res);
    if (path === "import") return handleImport(req, res);
    if (path === "backup/export") return handleBackupExport(req, res);
    if (path === "backup/import") return handleBackupImport(req, res);
    if (path === "watch-backups") return handleWatchBackups(req, res);
    if (path === "plembfin-backups") return handlePlektBackups(req, res);
    if (path === "plembfin-backups/restore") return handlePlektRestore(req, res);
    if (path === "plembfin-backups/upload") return handlePlektRestoreUpload(req, res);
    if (path === "manual-watch") return handleManualWatch(req, res);
    if (path === "manual-unwatch") return handleManualUnwatch(req, res);
    if (path === "manual-watch-review" || path.startsWith("manual-watch-review/")) return handleManualWatchReview(req, res, path);
    if (path === "playstate-aliases" || path.startsWith("playstate-aliases/")) return handlePlaystateAliases(req, res, path);
    if (path === "webhook-port/status") return handleWebhookPort(req, res, path);
    if (path === "playback-progress") return handlePlaybackProgressList(req, res);
    if (path === "playback-progress/watch") return handlePlaybackProgressWatch(req, res);
    if (path === "playback-progress/unwatch") return handlePlaybackProgressUnwatch(req, res);
    if (path === "retry-sync") return handleRetrySync(req, res);
    if (path === "update-watch") return handleUpdateWatch(req, res);
    if (path === "watch-dates") return handleWatchDates(req, res);
    if (path === "add-watch-date") return handleAddWatchDate(req, res);
    if (path === "delete-watch-date") return handleDeleteWatchDate(req, res);
    if (path === "delete-watch-dates") return handleDeleteWatchDates(req, res);
    if (path === "duplicate-watch-scan") return handleDuplicateWatchScan(req, res);
    if (path === "duplicate-watch-cleanup") return handleDuplicateWatchCleanup(req, res);
    if (path === "update-watch-dates") return handleUpdateWatchDates(req, res);
    if (path === "rematch-show") return handleRematchShow(req, res);
    if (path === "merge-shows") return handleMergeShows(req, res);
    if (path === "now-playing") return handleNowPlaying(req, res);
    if (path === "active-sessions") return handleActiveSessions(req, res);
    if (path === "cron-sync") return handleCronSync(req, res);
    if (path === "cron-sync/status") return handleCronSyncStatus(req, res);
    if (path === "force-sync/library/cancel" || path === "force-sync/media/cancel") return handleForceSyncCancellation(req, res);
    if (path === "force-sync/library/status") return handleLibraryForceSyncStatus(req, res);
    if (path === "force-sync/library") return handleLibraryForceSync(req, res);
    if (path === "force-sync/media/status") return handleMediaForceSyncStatus(req, res);
    if (path === "force-sync/media") return handleMediaForceSync(req, res);
    if (path === "force-sync") return handleForceSync(req, res);
    if (path === "force-sync/plan" || path.startsWith("force-sync/plan/")) return handleForceSyncPlan(req, res);
    if (path === "stop-force-sync") return handleStopForceSync(req, res);
    if (path === "phantom-watch-audit") return handlePhantomWatchAudit(req, res);
    if (path === "phantom-watch-repair") return handlePhantomWatchRepair(req, res);
    if (path === "episode-title-audit") return handleEpisodeTitleAudit(req, res);
    if (path === "episode-title-backfill") return handleEpisodeTitleBackfill(req, res);
    if (path === "stale-trakt-import-audit") return handleStaleTraktImportAudit(req, res);
    if (path === "stale-trakt-import-repair") return handleStaleTraktImportRepair(req, res);
    if (path === "stale-pending-watch-audit") return handleStalePendingWatchAudit(req, res);
    if (path === "stale-pending-watch-repair") return handleStalePendingWatchRepair(req, res);
    if (path === "split-identity-unwatch-audit") return handleSplitIdentityUnwatchAudit(req, res);
    if (path === "split-identity-unwatch-repair") return handleSplitIdentityUnwatchRepair(req, res);
    if (path === "likely-false-unwatch-audit") return handleLikelyFalseUnwatchAudit(req, res);
    if (path === "likely-false-unwatch-repair") return handleLikelyFalseUnwatchRepair(req, res);
    if (path === "tmdb-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-details-batch") return handleTmdbDetailsBatch(req, res);
    if (path === "poster-batch") return handlePosterBatch(req, res);
    if (path === "refresh-tmdb-metadata") return handleRefreshTmdbMetadata(req, res);
    if (path === "refresh-tvdb-metadata") return handleRefreshTvdbMetadata(req, res);
    if (path === "rematch-tv-shows") return handleRematchTvShows(req, res);
    if (path === "media-details") return handleTmdbDetails(req, res);
    if (path === "tmdb-search") return handleTmdbSearch(req, res);
    if (path === "tvdb-search") return handleTvdbSearch(req, res);
    if (path === "fix-match-search") return handleFixMatchSearch(req, res);
    if (path === "media-search") return handleMediaSearch(req, res);
    if (path === "tmdb-collection") return handleTmdbCollection(req, res);
    if (path === "discover/dismiss") return handleDiscoverDismiss(req, res);
    if (path === "discover") return handleDiscover(req, res);
    if (path === "personal-media") return handlePersonalMedia(req, res);
    if (["rating-sync/status", "rating-sync/run", "rating-sync/push", "rating-sync/retry", "rating-sync"].includes(path)) return handleRatingSync(req, res);
    if (["watchlist-sync/status", "watchlist-sync/preview", "watchlist-sync/run", "watchlist-sync/activity"].includes(path)) return handleWatchlistSync(req, res);
    if (path === "tmdb-season") return handleTmdbSeason(req, res);
    if (path === "tmdb-images") return handleTmdbImages(req, res);
    if (path === "tvdb-images") return handleTvdbImages(req, res);
    if (path === "fanart-images") return handleFanartImages(req, res);
    if (path === "season-posters") return handleSeasonPosters(req, res);
    if (path === "season-poster-options") return handleSeasonPosterOptions(req, res);
    if (path === "tmdb-person") return handleTmdbPerson(req, res);
    if (path === "youtube-meta") return handleYoutubeMeta(req, res);
    if (path === "omdb-rating") return handleOmdbRating(req, res);
    if (path === "webhook") return handleWebhook(req, res);
    if (path === "test-connection") return handleTestConnection(req, res);
    if (path === "test-plex-notifications") return handleTestPlexNotifications(req, res);
    if (path === "seerr/status") return handleSeerrStatus(req, res);
    if (path === "seerr/media-status") return handleSeerrMediaStatus(req, res);
    if (path === "seerr/request") return handleSeerrRequest(req, res);
    if (path === "media-app-links") return handleMediaAppLinks(req, res);
    if (path === "tmdb-poster") return handleTmdbPoster(req, res);
    if (path === "tmdb-profile") return handleTmdbProfile(req, res);
    if (path === "remote-artwork") return handleRemoteArtwork(req, res);
    if (path === "poster") return handlePoster(req, res);
    if (path === "cache-stats") return handleCacheStats(req, res);
    if (path === "clear-cache") return handleClearCache(req, res);
    if (path === "wipe-data/preview") return handleWipeDataPreview(req, res);
    if (path === "wipe-data") return handleWipeData(req, res);
    if (path === "admin-backfill-status") return handleBackfillStatus(req, res);
    if (path === "admin-backfill-trakt") return handleBackfillTrakt(req, res);
    if (path === "admin-fix-history") return handleAdminFixHistory(req, res);
    if (["admin-ensure-columns", "admin-clear-mock"].includes(path)) return handleMaintenanceStub(req, res, path);
    return notFound(res);
  } catch (error) {
    console.error("API route failed", error);
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && (status < 500 || error?.expose)) {
      return sendJson(res, { error: error.message || "Request failed" }, status);
    }
    return sendJson(res, { error: "API route failed" }, 500);
  }
}

export { dispatch, runScheduledTick, startPlexNotificationListener, stopPlexNotificationListener, backfillUnknownShowTitles };
