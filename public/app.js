import { buildAuthHeaders, buildNowPlayingUrl, currentUser, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./modules/auth.js?v=2.2.0.0.1";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs, formatLogLineToHtml } from "./modules/logs.js?v=2.2.0.0.1";
import { applySettingsRoute, focusSettingsRoute, parseSettingsRoute, prepareSettingsShell, scrollToSettingsSection, settingsPathForLegacy } from "./modules/settings-shell.js?v=2.2.0.0.1";
import { state, elements, ACTIVE_VIEW_KEY, ACTIVE_SETTINGS_TAB_KEY, EXPLORER_SORT_KEY_MOVIES, EXPLORER_SORT_KEY_SHOWS, EXPLORER_VIEW_KEY_MOVIES, EXPLORER_VIEW_KEY_SHOWS, HIDE_WATCHED_KEY_SHOWS, HIDE_ENDED_KEY_SHOWS, HISTORY_VIEW_KEY, HISTORY_FILTER_KEY, HISTORY_VIEW_MODES, HISTORY_FILTERS, PERSONAL_MEDIA_VIEWS, PRIMARY_VIEWS } from "./modules/state.js?v=2.2.0.0.1";
import { escapeHtml, escapeAttribute, sanitizeTitle, safeImageUrl, isDemoMode, slug, movieSlug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showName, showTitleFrom, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDate, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel, versionDisplayLabel } from "./modules/utils.js?v=2.2.0.0.1";
import { isCachedStorageImageUrl, compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, rememberPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, tmdbProfile, proxiedArtworkUrl } from "./modules/images.js?v=2.2.0.0.1";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, showAvailIssuePopup, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerRetrySync, triggerCronSync, triggerStopSync, triggerForceSync, isSyncProgressActive } from "./modules/sync.js?v=2.2.0.0.1";
import { startLiveUpdates, stopLiveUpdates } from "./modules/live-updates.js?v=2.2.0.0.1";
import { APPEARANCE_DEFAULTS, applyAppearanceToBody, loadAppearanceSettings } from "./modules/appearance.js?v=2.2.0.0.1";
import { loadManualWatchReviewSummary, loadSyncAttentionSummary, renderManualWatchReviewSummary as renderCoreManualWatchReviewSummary, renderSyncActivityStatus as renderCoreSyncActivityStatus, setSyncActivityProgress as setCoreSyncActivityProgress, setSyncAttentionSummary as setCoreSyncAttentionSummary, startStatusSummaryPolling, stopStatusSummaryPolling } from "./modules/status-indicators.js?v=2.2.0.0.1";
import { initSupervisorSwitch, refreshSwitchUsers } from "./modules/supervisor-switch.js?v=2.2.0.0.1";
import { movieBySlugOrId, nowPlayingHref } from "./modules/media-routing.js?v=2.2.0.0.1";
import { cachedExplorerPage, rememberExplorerPage, clearPersistentExplorerPageCache, historyVersionFromRows } from "./modules/explorer-page-cache.js?v=2.2.0.0.1";
import { DETAIL_ROUTE_MODULES, SETTINGS_ROUTE_MODULES, SHELL_ROUTE_MODULES, STATUS_ROUTE_MODULES, ensureShellModules, ifLoaded, installEarlyActivationCapture, replayEarlyActivation,isRouteModuleLoaded, loadRouteModule, loadRouteModules, registerRouteModuleInitializer, routeModulesLoaded } from "./modules/route-modules.js?v=2.2.0.0.1";

// Route, dialog, media-detail, and maintenance modules load on demand through
// modules/route-modules.js: a route downloads only the modules it renders.
// Each deferred export below is a `let` holding a safe no-op until its module
// loads, so existing routing code can call it unconditionally. Never hand one
// of these to another module by value; pass live(...) or viaModule(...).
const lazyNoop = () => {};
const lazyNoopAsync = () => Promise.resolve();
let initOnboarding = lazyNoop, loadSetupStatus = lazyNoopAsync, renderSetupPage = lazyNoop, setClaimRequired = lazyNoop;
let initSettingsServices = lazyNoop, applyConfigToSettingsUi = lazyNoop, refreshSeerrCapabilities = lazyNoopAsync, refreshTautulliImport = lazyNoop, renderMediaServerCards = lazyNoop, renderMetadataCards = lazyNoop, setTautulliImportModule = lazyNoop;
let initTools = lazyNoop, loadCacheStats = lazyNoopAsync, renderCachePanel = lazyNoop, parseSelectedFiles = lazyNoop, renderImportPreview = lazyNoop, renderImportActivity = lazyNoop, startImport = lazyNoopAsync, runRepairWorkflow = lazyNoopAsync, runPhantomWatchAudit = lazyNoopAsync, runPhantomWatchRepair = lazyNoopAsync, runTraktBackfill = lazyNoopAsync, runSystemIntegrityCheck = lazyNoopAsync, triggerClearMissingTelemetry = lazyNoopAsync, triggerRetryAllCategory = lazyNoopAsync, runDuplicateWatchCleanup = lazyNoopAsync, loadWipeDataPreview = lazyNoopAsync, runWipeData = lazyNoopAsync;
let initDashboard = lazyNoop, renderDashboard = lazyNoop, refreshDashboardHistoryInPlace = lazyNoop, refreshDashboardHistoryFromLive = lazyNoopAsync, updateDashboardSplitState = lazyNoop, resetPartWatchedView = lazyNoop, renderPartWatched = lazyNoop;
let initUpNext = lazyNoop, renderUpNext = lazyNoop, loadUpNext = lazyNoopAsync, resetUpNext = lazyNoop, removeWatchedUpNextItems = lazyNoop, removeDismissedUpNextItems = lazyNoop, setUpNextWatchSavingState = lazyNoop, setUpNextUnwatchSavingState = lazyNoop;
let renderWatchBackups = lazyNoop, renderPlektBackups = lazyNoop, loadRemoteBackupsForRestoreTab = lazyNoopAsync, loadRemotePlektBackupsForRestoreTab = lazyNoopAsync, loadWatchBackups = lazyNoopAsync, loadPlektBackups = lazyNoopAsync;
let renderSyncActivity = lazyNoop, renderSyncActivityStatus = renderCoreSyncActivityStatus, setSyncActivityProgress = setCoreSyncActivityProgress, setSyncAttentionSummary = setCoreSyncAttentionSummary, loadSyncAttention = lazyNoopAsync, renderSyncAttention = lazyNoop, skipSyncAttention = lazyNoopAsync, skipSyncAttentionItem = lazyNoopAsync, retrySyncAttentionItem = lazyNoopAsync, skipSyncAttentionShow = lazyNoopAsync, retrySyncAttentionShow = lazyNoopAsync, recordClientAttention = lazyNoop, clearClientAttention = lazyNoop, clearClientAttentionForRoute = lazyNoop, retryClientAttention = lazyNoopAsync, setSyncActivitySearch = lazyNoop, resetSyncActivity = lazyNoop, loadSyncActivity = lazyNoopAsync, queueSyncActivityRefresh = lazyNoop, downloadSyncActivityLog = lazyNoop, retrySyncActivity = lazyNoopAsync, dismissSyncActivity = lazyNoopAsync, dismissSyncActivityGroup = lazyNoopAsync, retrySyncActivityGroup = lazyNoopAsync, startRetryAllSyncActivity = lazyNoopAsync, resumeRetryAllSyncActivityIfRunning = lazyNoop, fetchAllRetryableSyncActivityIds = lazyNoopAsync, toggleSyncActivityRowLog = lazyNoop, setSyncActivityGroupView = lazyNoop, loadOlderSyncActivityGroup = lazyNoopAsync, toggleSyncActivityFailedOnly = lazyNoop, toggleSyncActivityPaused = lazyNoop, startSyncActivityRefresh = lazyNoop, stopSyncActivityRefresh = lazyNoop, initSyncPreview = lazyNoop;
let initDiscover = lazyNoop, renderDiscover = lazyNoop, loadDiscover = lazyNoopAsync, resetDiscover = lazyNoop, initPersonalMedia = lazyNoop, renderPersonalMedia = lazyNoop, loadPersonalMedia = lazyNoopAsync, resetPersonalMedia = lazyNoop, initStats = lazyNoop, futureListDate = lazyNoop, showStatusLabel = lazyNoop, nextAiringDateValue = lazyNoop, nextAiringCell = lazyNoop, statsReports = [], statsPeriodLabel = lazyNoop, syncStatsPeriodOptions = lazyNoop, selectedStatsReport = lazyNoop, statsFilteredRows = lazyNoop, statsPeriodNoun = lazyNoop, statsTrackingSpanText = lazyNoop, statsPlatformLabel = lazyNoop, statsSelectedMediaLabel = lazyNoop, statsIntroCards = lazyNoop, renderStatsKpis = lazyNoop, renderStatsLeaderboard = lazyNoop, renderStatsMoviesTvSplit = lazyNoop, renderStatsPlatformRows = lazyNoop, renderStatsBookends = lazyNoop, renderMonthChart = lazyNoop, renderStats = lazyNoop, loadStats = lazyNoopAsync, renderRankingTable = lazyNoop, initUpcoming = lazyNoop, openUpcomingToToday = lazyNoop;
let initExplorer = lazyNoop, syncExplorerControlsState = lazyNoop, syncInlineMediaDetailHeading = lazyNoop, triggerSearchPage = lazyNoop, renderSearchPage = lazyNoop, renderExplorer = lazyNoop, explorerQueryKey = lazyNoop, updateAlphaFilter = lazyNoop, handleAlphaFilterClick = lazyNoop, resetMovieExplorer = lazyNoop, resetShowExplorer = lazyNoop, renderExplorerSentinel = lazyNoop, observeExplorerSentinel = lazyNoop, observeExplorerTmdbPrefetch = lazyNoop, scheduleNextAirResort = lazyNoop, currentExplorerView = lazyNoop, currentExplorerSort = lazyNoop, setCurrentExplorerSort = lazyNoop, applyListHeaderSort = lazyNoop, renderMovieCard = lazyNoop, renderMovieExplorer = lazyNoop, loadExplorerMovies = lazyNoopAsync, refreshMovieExplorerInPlace = lazyNoopAsync, refreshShowExplorerInPlace = lazyNoopAsync,renderHistoryItems = lazyNoop, renderHistoryView = lazyNoop, resetHistoryView = lazyNoop, loadHistoryView = lazyNoopAsync, refreshHistoryViewInPlace = lazyNoopAsync, observeHistorySentinel = lazyNoop, renderShowExplorer = lazyNoop, loadExplorerShows = lazyNoopAsync, loadShowDetail = lazyNoopAsync, matchesExplorerSearch = lazyNoop, sortExplorerItems = lazyNoop, renderShowRecord = lazyNoop, renderShowFolder = lazyNoop, renderSeasonFolder = lazyNoop, seasonsFromShowRecord = lazyNoop, representativeEpisode = lazyNoop, tmdbLookupIdsFromShow = lazyNoop, emptyExplorer = lazyNoop, FILMOGRAPHY_PAGE_SIZE = 24, getFilmographyObserver = lazyNoop, setFilmographyObserver = lazyNoop;
let initEditDialogs = lazyNoop, openEditDateDialog = lazyNoop, openEditShowDateDialog = lazyNoop, openEditSeasonDateDialog = lazyNoop, openEditImageDialog = lazyNoop, openFixMatchDialog = lazyNoop, openMergeShowDialog = lazyNoop, applyWatchedAtToLocalWatchRecord = lazyNoopAsync, editDateOptionsFromButton = lazyNoop;
let initWatchAction = lazyNoop, openWatchDatePrompt = lazyNoop, closeWatchDatePrompt = lazyNoop, submitSeerrRequest = lazyNoopAsync, markMovieWatched = lazyNoopAsync, refreshShowAfterManualWatch = lazyNoopAsync, applyWatchDateChoice = lazyNoopAsync, confirmAndMarkUnwatched = lazyNoopAsync, confirmAndDeleteMedia = lazyNoopAsync;
let initMediaDetail = lazyNoop, openMovieInlineDetail = lazyNoopAsync, openShowInlineDetail = lazyNoopAsync, clearMediaDetailState = lazyNoop, syncMediaActionsMenuState = lazyNoop, syncTopbarControlsMenuState = lazyNoop, closeDebugModal = lazyNoop, closeMediaDetail = lazyNoop, renderImmersiveShowModal = lazyNoop, patchShowModalEpisodeFromLive = lazyNoop, patchShowModalEpisodesSavingState = lazyNoop, syncShowModalWatchActionControls = lazyNoop, renderMovieImmersiveModalContent = lazyNoop, openMovieImmersiveModalByTmdbId = lazyNoopAsync, openShowImmersiveModalByTmdbId = lazyNoopAsync, openShowImmersiveModalByTvdbId = lazyNoopAsync, openHistoryDebugModal = lazyNoop, patchMovieWatchedState = lazyNoop, syncActiveMediaDetailState = lazyNoop;
let fetchSeerrMediaStatus = lazyNoopAsync, refreshActiveMediaDetailAfterSeerrStatus = lazyNoop;
let fetchTmdbDetails = lazyNoopAsync, fetchTmdbSeasonDetails = lazyNoopAsync, resolveEpisodeTitleFromTmdb = lazyNoopAsync;
let applyLiveHistoryChanges = lazyNoop, refreshActiveDetailView = lazyNoopAsync, initMediaPerson = lazyNoop, closePersonProfile = lazyNoop, loadCastMemberDetails = lazyNoopAsync, initMediaLightbox = lazyNoop, initAppEvents = lazyNoop, closeMobileMenu = lazyNoop, initTrackerSettings = lazyNoop, refreshTrackerPolicyNotes = lazyNoop, refreshTrackerSettings = lazyNoopAsync, initRatingSyncSettings = lazyNoop, applyRatingSyncConfig = lazyNoop, refreshRatingSyncStatus = lazyNoopAsync, resumeRatingSyncSettings = lazyNoopAsync, stopRatingSyncSettings = lazyNoop, runRatingSyncNow = lazyNoopAsync, initWatchlistSyncSettings = lazyNoop, applyWatchlistSyncConfig = lazyNoop, refreshWatchlistSyncStatus = lazyNoopAsync, resumeWatchlistSyncSettings = lazyNoopAsync, stopWatchlistSyncSettings = lazyNoop, runWatchlistSyncNow = lazyNoopAsync, initManualWatchReview = lazyNoop, loadManualWatchReview = lazyNoopAsync, renderManualWatchReviewPage = lazyNoop, renderManualWatchReviewSummary = renderCoreManualWatchReviewSummary, startManualWatchReviewPolling = lazyNoop, stopManualWatchReviewPolling = lazyNoop;
let renderChangelogFromModule = lazyNoopAsync;

// A callback another module stores must read the binding at call time.
// live(): render/patch callbacks that only matter once their module is loaded.
// viaModule(): actions that must happen, loading the owning module first.
const live = (read) => (...args) => read()(...args);
const viaModule = (key, read) => (...args) => (isRouteModuleLoaded(key)
  ? read()(...args)
  : loadRouteModule(key).then(() => read()(...args)));
const renderSettingsInlineHelp = ifLoaded("help-content", "renderSettingsInlineHelp");
const loadSettingsUsersForRoute = ifLoaded("settings-events", "loadSettingsUsers");
const renderChangelog = viaModule("changelog-channels", () => renderChangelogFromModule);

// How each route module is bound and initialized. route-modules.js runs this
// once, after the module's own dependencies have loaded and before anything
// else is told the module is ready.
const ROUTE_MODULE_INITIALIZERS = {
  "help-content"(module) {},
  "settings-services"(module) {
    ({ initSettingsServices, applyConfigToSettingsUi, refreshSeerrCapabilities, refreshTautulliImport, renderMediaServerCards, renderMetadataCards, setTautulliImportModule } = module);
    initSettingsServices({
      setMessage,
      clearDerivedUiCaches,
      renderDashboard: live(() => renderDashboard),
      renderActiveSessions,
      openConfirmDialog,
    });
    if (state.configLoaded) {
      applyConfigToSettingsUi(state.savedConfig || {});
      refreshTautulliImport();
      if (state.activeView !== "settings") refreshSeerrCapabilities().catch(() => null);
    }
  },
  onboarding(module) {
    ({ initOnboarding, loadSetupStatus, renderSetupPage, setClaimRequired } = module);
    initOnboarding({ authHeaders, navigateTo, setMessage, setUnlocked, loadHistory, loadSavedConfig, startHistoryPolling });
  },
  dashboard(module) {
    ({ initDashboard, renderDashboard, refreshDashboardHistoryInPlace, refreshDashboardHistoryFromLive, updateDashboardSplitState, resetPartWatchedView, renderPartWatched } = module);
    initDashboard({
      setMessage, loadHistory,
      resolveEpisodeTitleFromTmdb: viaModule("tmdb", () => resolveEpisodeTitleFromTmdb),
    });
  },
  "up-next"(module) {
    ({ initUpNext, renderUpNext, loadUpNext, resetUpNext, removeWatchedUpNextItems, removeDismissedUpNextItems, setUpNextWatchSavingState, setUpNextUnwatchSavingState } = module);
    initUpNext({ setMessage });
  },
  "tools-backups"(module) {
    ({ renderWatchBackups, renderPlektBackups, loadRemoteBackupsForRestoreTab, loadRemotePlektBackupsForRestoreTab, loadWatchBackups, loadPlektBackups } = module);
    module.initBackupTools(backupToolCallbacks());
  },
  "media-detail-shared"(module) {
    ({ fetchSeerrMediaStatus, refreshActiveMediaDetailAfterSeerrStatus } = module);
  },
  tmdb(module) {
    ({ fetchTmdbDetails, fetchTmdbSeasonDetails, resolveEpisodeTitleFromTmdb } = module);
  },
  tools(module) {
    ({ initTools, loadCacheStats, renderCachePanel, parseSelectedFiles, renderImportPreview, renderImportActivity, startImport, runRepairWorkflow, runPhantomWatchAudit, runPhantomWatchRepair, runTraktBackfill, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory, runDuplicateWatchCleanup, loadWipeDataPreview, runWipeData } = module);
    initTools({ ...backupToolCallbacks(), loadSyncJobs, loadSyncHistory, queueLiveHistoryRefresh });
    renderImportPreview();
  },
  "sync-activity"(module) {
    ({ renderSyncActivity, renderSyncActivityStatus, setSyncActivityProgress, setSyncAttentionSummary, loadSyncAttention, renderSyncAttention, skipSyncAttention, skipSyncAttentionItem, retrySyncAttentionItem, skipSyncAttentionShow, retrySyncAttentionShow, recordClientAttention, clearClientAttention, clearClientAttentionForRoute, retryClientAttention, setSyncActivitySearch, resetSyncActivity, loadSyncActivity, queueSyncActivityRefresh, downloadSyncActivityLog, retrySyncActivity, dismissSyncActivity, dismissSyncActivityGroup, retrySyncActivityGroup, startRetryAllSyncActivity, resumeRetryAllSyncActivityIfRunning, fetchAllRetryableSyncActivityIds, toggleSyncActivityRowLog, setSyncActivityGroupView, loadOlderSyncActivityGroup, toggleSyncActivityFailedOnly, toggleSyncActivityPaused, startSyncActivityRefresh, stopSyncActivityRefresh } = module);
    renderSyncActivityStatus();
    // Re-apply the latest sync progress the live stream delivered before the
    // sidebar indicator's module had loaded.
    if (state.syncProgress) setSyncActivityProgress(state.syncProgress);
  },
  "sync-preview"(module) {
    ({ initSyncPreview } = module);
    initSyncPreview({
      button: elements.previewForceSyncButton,
      panel: elements.forceSyncPreviewPanel,
      token: () => state.token,
      onToast: showToast,
      onExecute: (planId) => triggerForceSync({ planId, confirmed: true }),
    });
  },
  discover(module) {
    ({ initDiscover, renderDiscover, loadDiscover, resetDiscover } = module);
    initDiscover({ setMessage, navigateTo });
  },
  "personal-media"(module) {
    ({ initPersonalMedia, renderPersonalMedia, loadPersonalMedia, resetPersonalMedia } = module);
    initPersonalMedia({
      setMessage,
      renderDiscover: live(() => renderDiscover),
      openConfirmDialog,
      syncPersonalMedia: (type) => type === "ratings"
        ? viaModule("rating-sync-settings", () => runRatingSyncNow)()
        : viaModule("watchlist-sync-settings", () => runWatchlistSyncNow)(),
    });
  },
  stats(module) {
    ({ initStats, futureListDate, showStatusLabel, nextAiringDateValue, nextAiringCell, statsReports, statsPeriodLabel, syncStatsPeriodOptions, selectedStatsReport, statsFilteredRows, statsPeriodNoun, statsTrackingSpanText, statsPlatformLabel, statsSelectedMediaLabel, statsIntroCards, renderStatsKpis, renderStatsLeaderboard, renderStatsMoviesTvSplit, renderStatsPlatformRows, renderStatsBookends, renderMonthChart, renderStats, loadStats, renderRankingTable } = module);
    initStats({ slug, navigateTo, setMessage });
  },
  upcoming(module) {
    ({ initUpcoming, openUpcomingToToday } = module);
    initUpcoming({ navigateTo, setMessage });
  },
  explorer(module) {
    ({ initExplorer, syncExplorerControlsState, syncInlineMediaDetailHeading, triggerSearchPage, renderSearchPage, renderExplorer, explorerQueryKey, updateAlphaFilter, handleAlphaFilterClick, resetMovieExplorer, resetShowExplorer, renderExplorerSentinel, observeExplorerSentinel, observeExplorerTmdbPrefetch, scheduleNextAirResort, currentExplorerView, currentExplorerSort, setCurrentExplorerSort, applyListHeaderSort, renderMovieCard, renderMovieExplorer, loadExplorerMovies, refreshMovieExplorerInPlace, refreshShowExplorerInPlace,renderHistoryItems, renderHistoryView, resetHistoryView, loadHistoryView, refreshHistoryViewInPlace, observeHistorySentinel, renderShowExplorer, loadExplorerShows, loadShowDetail, matchesExplorerSearch, sortExplorerItems, renderShowRecord, renderShowFolder, renderSeasonFolder, seasonsFromShowRecord, representativeEpisode, tmdbLookupIdsFromShow, emptyExplorer, FILMOGRAPHY_PAGE_SIZE, getFilmographyObserver, setFilmographyObserver } = module);
    initExplorer({
      setMessage,
      selectView,
      navigateTo,
      syncPageTopbar,
      cachedExplorerPage,
      rememberExplorerPage,
      fetchTmdbDetails: viaModule("tmdb", () => fetchTmdbDetails),
      resolveEpisodeTitleFromTmdb: viaModule("tmdb", () => resolveEpisodeTitleFromTmdb),
    });
  },
  "edit-dialogs"(module) {
    ({ initEditDialogs, openEditDateDialog, openEditShowDateDialog, openEditSeasonDateDialog, openEditImageDialog, openFixMatchDialog, openMergeShowDialog, applyWatchedAtToLocalWatchRecord, editDateOptionsFromButton } = module);
    initEditDialogs({
      setMessage, clearDerivedUiCaches, loadHistory, navigateTo, openConfirmDialog,
      renderExplorer: live(() => renderExplorer),
      renderImmersiveShowModal: live(() => renderImmersiveShowModal),
      openShowImmersiveModalByTmdbId: viaModule("media-detail", () => openShowImmersiveModalByTmdbId),
      openShowImmersiveModalByTvdbId: viaModule("media-detail", () => openShowImmersiveModalByTvdbId),
      loadPersonalMedia: live(() => loadPersonalMedia),
    });
  },
  "watch-action"(module) {
    ({ initWatchAction, openWatchDatePrompt, closeWatchDatePrompt, submitSeerrRequest, markMovieWatched, refreshShowAfterManualWatch, applyWatchDateChoice, confirmAndMarkUnwatched, confirmAndDeleteMedia } = module);
    initWatchAction({
      setMessage, openConfirmDialog, clearDerivedUiCaches, loadHistory, showErrorExplainModal,
      renderActiveView: renderActiveViewAfterWatch,
      closeMediaDetail: live(() => closeMediaDetail),
      fetchSeerrMediaStatus: viaModule("media-detail-shared", () => fetchSeerrMediaStatus),
      refreshActiveMediaDetailAfterSeerrStatus: viaModule("media-detail-shared", () => refreshActiveMediaDetailAfterSeerrStatus),
      renderImmersiveShowModal: live(() => renderImmersiveShowModal),
      patchShowModalEpisodeFromLive: live(() => patchShowModalEpisodeFromLive),
      patchShowModalEpisodesSavingState: live(() => patchShowModalEpisodesSavingState),
      syncShowModalWatchActionControls: live(() => syncShowModalWatchActionControls),
      openShowImmersiveModalByTmdbId: viaModule("media-detail", () => openShowImmersiveModalByTmdbId),
      openShowImmersiveModalByTvdbId: viaModule("media-detail", () => openShowImmersiveModalByTvdbId),
      openMovieImmersiveModalByTmdbId: viaModule("media-detail", () => openMovieImmersiveModalByTmdbId),
      patchMovieWatchedState: live(() => patchMovieWatchedState),
      refreshUpNext: viaModule("up-next", () => loadUpNext),
      removeWatchedUpNextItems: viaModule("up-next", () => removeWatchedUpNextItems),
      removeDismissedUpNextItems: viaModule("up-next", () => removeDismissedUpNextItems),
      setUpNextWatchSavingState: viaModule("up-next", () => setUpNextWatchSavingState),
      setUpNextUnwatchSavingState: viaModule("up-next", () => setUpNextUnwatchSavingState),
      recordClientAttention: viaModule("sync-activity", () => recordClientAttention),
    });
  },
  "media-detail"(module) {
    ({ initMediaDetail, openMovieInlineDetail, openShowInlineDetail, clearMediaDetailState, syncMediaActionsMenuState, syncTopbarControlsMenuState, closeDebugModal, closeMediaDetail, renderImmersiveShowModal, patchShowModalEpisodeFromLive, patchShowModalEpisodesSavingState, syncShowModalWatchActionControls, renderMovieImmersiveModalContent, openMovieImmersiveModalByTmdbId, openShowImmersiveModalByTmdbId, openShowImmersiveModalByTvdbId, openHistoryDebugModal, patchMovieWatchedState, syncActiveMediaDetailState } = module);
    initMediaDetail({
      setMessage, navigateTo, selectView, syncPageTopbar,
      renderExplorer: live(() => renderExplorer),
      renderSearchPage: live(() => renderSearchPage),
      loadExplorerMovies: live(() => loadExplorerMovies),
      loadExplorerShows: live(() => loadExplorerShows),
      closePersonProfile: live(() => closePersonProfile),
    });
  },
  "media-detail-events"(module) {
    ({ applyLiveHistoryChanges, refreshActiveDetailView } = module);
  },
  "media-person"(module) {
    ({ initMediaPerson, closePersonProfile, loadCastMemberDetails } = module);
    initMediaPerson({ setMessage, navigateTo, authHeaders, applyActiveView, syncPageTopbar });
  },
  "media-lightbox"(module) {
    ({ initMediaLightbox } = module);
    initMediaLightbox();
  },
  "app-events"(module) {
    ({ initAppEvents, closeMobileMenu } = module);
    const sync = (read) => viaModule("sync-activity", read);
    const tool = (read) => viaModule("tools", read);
    initAppEvents({
      authHeaders, setMessage, unlockWithToken, clearSearchInputs, resetPageEntryState, selectView,
      renderLogs, logsText, copyToClipboard, selectBackupsTab, navigateTo, renderChangelog,
      lockDashboard, toggleTheme, openConfirmDialog, showConfirmModal, closeGlobalSearchDropdown,
      saveAdminCredentials, applyActiveView, handleRouting, loadHistory, clearDerivedUiCaches,
      loadSavedConfig, renderDbStatus, showErrorExplainModal, runRefreshMetadataWorkflow,
      runRefreshTvdbMetadataWorkflow, showToast, logDebug, syncPageTopbar, setUnlocked,
      renderSettingsStatus, renderAdminCredentialsStatus, toggleSet, renderGlobalSearchDropdown,
      loadGlobalDiscovery,
      closeDebugModal: live(() => closeDebugModal),
      closePersonProfile: live(() => closePersonProfile),
      closeMediaDetail: live(() => closeMediaDetail),
      openFixMatchDialog: viaModule("edit-dialogs", () => openFixMatchDialog),
      openHistoryDebugModal: viaModule("media-detail", () => openHistoryDebugModal),
      loadStats: viaModule("stats", () => loadStats),
      runPhantomWatchAudit: tool(() => runPhantomWatchAudit),
      runPhantomWatchRepair: tool(() => runPhantomWatchRepair),
      runDuplicateWatchCleanup: tool(() => runDuplicateWatchCleanup),
      runWipeData: tool(() => runWipeData),
      loadSyncActivity: sync(() => loadSyncActivity),
      loadSyncAttention: sync(() => loadSyncAttention),
      renderSyncAttention: live(() => renderSyncAttention),
      skipSyncAttention: sync(() => skipSyncAttention),
      skipSyncAttentionItem: sync(() => skipSyncAttentionItem),
      retrySyncAttentionItem: sync(() => retrySyncAttentionItem),
      retryClientAttention: sync(() => retryClientAttention),
      skipSyncAttentionShow: sync(() => skipSyncAttentionShow),
      retrySyncAttentionShow: sync(() => retrySyncAttentionShow),
      setSyncActivitySearch: sync(() => setSyncActivitySearch),
      downloadSyncActivityLog: sync(() => downloadSyncActivityLog),
      retrySyncActivity: sync(() => retrySyncActivity),
      dismissSyncActivity: sync(() => dismissSyncActivity),
      dismissSyncActivityGroup: sync(() => dismissSyncActivityGroup),
      retrySyncActivityGroup: sync(() => retrySyncActivityGroup),
      loadOlderSyncActivityGroup: sync(() => loadOlderSyncActivityGroup),
      startRetryAllSyncActivity: sync(() => startRetryAllSyncActivity),
      fetchAllRetryableSyncActivityIds: sync(() => fetchAllRetryableSyncActivityIds),
      toggleSyncActivityRowLog: sync(() => toggleSyncActivityRowLog),
      setSyncActivityGroupView: sync(() => setSyncActivityGroupView),
      toggleSyncActivityFailedOnly: sync(() => toggleSyncActivityFailedOnly),
      toggleSyncActivityPaused: sync(() => toggleSyncActivityPaused),
    });
  },
  "tracker-settings"(module) {
    ({ initTrackerSettings, refreshTrackerPolicyNotes, refreshTrackerSettings } = module);
    initTrackerSettings({ authHeaders });
  },
  "rating-sync-settings"(module) {
    ({ initRatingSyncSettings, applyRatingSyncConfig, refreshRatingSyncStatus, resumeRatingSyncSettings, stopRatingSyncSettings, runRatingSyncNow } = module);
    initRatingSyncSettings({
      authHeaders,
      setMessage,
      onConfig: (config) => { state.savedConfig = config || state.savedConfig; },
    });
    applyRatingSyncConfig(state.configLoaded ? state.savedConfig || {} : {});
  },
  "watchlist-sync-settings"(module) {
    ({ initWatchlistSyncSettings, applyWatchlistSyncConfig, refreshWatchlistSyncStatus, resumeWatchlistSyncSettings, stopWatchlistSyncSettings, runWatchlistSyncNow } = module);
    initWatchlistSyncSettings({
      authHeaders,
      setMessage,
      openConfirmDialog,
      onConfig: (config) => { state.savedConfig = config || state.savedConfig; },
    });
    applyWatchlistSyncConfig(state.configLoaded ? state.savedConfig || {} : {});
  },
  "tautulli-import"(module) {
    setTautulliImportModule(module);
    module.initTautulliImport({ openConfirmDialog });
  },
  "netflix-import"(module) {
    module.initNetflixImport({ openConfirmDialog });
  },
  "manual-watch-review"(module) {
    ({ initManualWatchReview, loadManualWatchReview, renderManualWatchReviewPage, renderManualWatchReviewSummary, startManualWatchReviewPolling, stopManualWatchReviewPolling } = module);
    initManualWatchReview({ setMessage, navigateTo, openConfirmDialog });
    renderManualWatchReviewSummary();
  },
  "changelog-channels"(module) {
    renderChangelogFromModule = module.renderChangelog;
    module.initChangelog({ authHeaders, updateVersionBadge });
  },
};
for (const [key, initializer] of Object.entries(ROUTE_MODULE_INITIALIZERS)) {
  registerRouteModuleInitializer(key, initializer);
}

// Callbacks for the backup tools, which are also re-initialized by initTools.
function backupToolCallbacks() {
  return {
    setMessage, openConfirmDialog, showConfirmModal, loadSavedConfig, loadHistory,
    loadActiveSessions, clearDerivedUiCaches,
    loadStats: viaModule("stats", () => loadStats),
  };
}

// The modules a route needs before it can render. Anything not listed is part
// of the core graph. Keep in step with handleRouting(); see docs/frontend.md.
function routeModulesForState() {
  const posterMenu = state.token ? ["poster-menu"] : [];
  if (state.mediaDetailInline || /^\/person\//.test(window.location.pathname)) {
    return [...DETAIL_ROUTE_MODULES, ...posterMenu];
  }
  switch (state.activeView) {
    case "dashboard":
      return ["dashboard", "up-next", ...posterMenu];
    case "explorer":
    case "history":
    case "search":
      return ["explorer", ...posterMenu];
    case "stats":
      return ["stats"];
    case "upcoming":
      return ["upcoming", ...posterMenu];
    case "discover":
    case "watchlist":
    case "ratings":
    case "playlists":
      return ["discover", "personal-media", ...posterMenu];
    case "settings":
      // The library force-sync panel on Settings is wired by media-detail-events,
      // which is deliberately route-scoped rather than part of the global shell.
      return ["tools", "sync-preview", "media-detail-events", ...SHELL_ROUTE_MODULES, ...SETTINGS_ROUTE_MODULES];
    case "setup":
      return ["onboarding"];
    case "syncActivity":
      return ["sync-activity"];
    case "manualWatchReview":
      return ["manual-watch-review"];
    default:
      return [];
  }
}

// Ping the backend the moment the app loads (no auth needed), so the server's
// caches and upstream connections are warm by the time the user clicks into
// anything. A light keep-alive repeats the ping while the tab is visible.
const BACKEND_KEEPALIVE_MS = 4 * 60 * 1000;
function warmUpBackend() {
  try {
    fetch("/api/ping", { cache: "no-store", keepalive: true }).catch(() => { });
  } catch { /* non-fatal */ }
}
warmUpBackend();
setInterval(() => {
  if (document.visibilityState === "visible") warmUpBackend();
}, BACKEND_KEEPALIVE_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") warmUpBackend();
});

// Theme initialization
const THEME_KEY = "plembfin:theme";

function updateThemeIcon() {
  const isLightMode = document.documentElement.classList.contains("light-mode");
  const src = isLightMode ? "/plekt_header_logo_light.png?v=2.2.0.0.1" : "/plekt_header_logo_dark.png?v=2.2.0.0.1";
  // Several logos can exist at once - the sidebar, setup wizard, and locked
  // login panel all need to track the selected theme.
  for (const logo of document.querySelectorAll(".brand-logo, [data-theme-logo]")) {
    logo.src = src;
  }
}

function initializeTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shouldUseLightMode = savedTheme === "light" || (savedTheme === null && !prefersDark);

  if (shouldUseLightMode) {
    document.documentElement.classList.add("light-mode");
  } else {
    document.documentElement.classList.remove("light-mode");
  }
  updateThemeIcon();
}

let themeTransitionTimeout = null;

function toggleTheme() {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  clearTimeout(themeTransitionTimeout);
  themeTransitionTimeout = setTimeout(() => root.classList.remove("theme-transition"), 180);

  const isLightMode = root.classList.contains("light-mode");
  if (isLightMode) {
    root.classList.remove("light-mode");
    localStorage.setItem(THEME_KEY, "dark");
  } else {
    root.classList.add("light-mode");
    localStorage.setItem(THEME_KEY, "light");
  }
  updateThemeIcon();
}

initializeTheme();

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";
const NOW_PLAYING_POLL_MS = 10000;
const NOW_PLAYING_EMPTY_POLL_MS = 2 * 60 * 1000;
const NOW_PLAYING_REENTRY_CACHE_MS = 20 * 1000;
const DASHBOARD_HISTORY_CACHE_KEY = "plembfin:dashboardHistory:v1";
// Keep a saved dashboard snapshot for offline fallback and other local views;
// the dashboard itself waits for the server response before displaying it.
const DASHBOARD_HISTORY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const HISTORY_PREVIEW_LIMIT = 120;
const DASHBOARD_HISTORY_ROWS = 2;
const EXPLORER_PAGE_SIZE = 240;
const MANUAL_WATCH_BATCH_SIZE = 100;
const STARTUP_DEFERRED_WORK_TIMEOUT_MS = 1200;

// Keep non-critical status panels and provider-backed dashboard enrichment out
// of the first authenticated render. Dashboard history refresh starts at once,
// and the saved Up Next copy stays hidden until the server reconciles it.
// A timeout keeps the deferred work eventually consistent in browsers without
// requestIdleCallback and on busy pages.
function scheduleDeferredStartupWork(task, timeout = STARTUP_DEFERRED_WORK_TIMEOUT_MS) {
  if (typeof task !== "function") return;
  const run = () => Promise.resolve().then(task).catch((error) => {
    logDebug(`Deferred startup work failed: ${error?.message || error}`);
  });
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout });
  } else {
    window.setTimeout(run, Math.min(timeout, 250));
  }
}

function bindElements() {
  Object.assign(elements, {
    appShell: document.querySelector("#appShell"),
    appVersion: document.querySelector("#appVersion"),
    aboutShareButton: document.querySelector("#aboutShareButton"),
    aboutShareModal: document.querySelector("#aboutShareModal"),
    aboutShareModalClose: document.querySelector("#aboutShareModalClose"),
    aboutShareNativeButton: document.querySelector("#aboutShareNativeButton"),
    aboutShareCopyButton: document.querySelector("#aboutShareCopyButton"),
    aboutShareStatus: document.querySelector("#aboutShareStatus"),
    sidebarOnboardingCta: document.querySelector("#sidebarOnboardingCta"),
    sidebarOnboardingButton: document.querySelector("#sidebarOnboardingButton"),
    sidebarOnboardingDismiss: document.querySelector("#sidebarOnboardingDismiss"),
    sidebarSyncAttention: document.querySelector("#sidebarSyncAttention"),
    sidebarSyncAttentionButton: document.querySelector("#sidebarSyncAttentionButton"),
    sidebarSyncAttentionTitle: document.querySelector("#sidebarSyncAttentionTitle"),
    sidebarSyncAttentionText: document.querySelector("#sidebarSyncAttentionText"),
    startupScanNotice: document.querySelector("#startupScanNotice"),
    syncProgressIndicator: document.querySelector("#syncProgressIndicator"),
    syncProgressText: document.querySelector("#syncProgressText"),
    syncActivityStatus: document.querySelector("#syncActivityStatus"),
    syncActivityStatusText: document.querySelector("#syncActivityStatusText"),
    syncActivityCurrentProgress: document.querySelector("#syncActivityCurrentProgress"),
    syncActivityCurrentProgressLabel: document.querySelector("#syncActivityCurrentProgressLabel"),
    syncActivityCurrentProgressTrack: document.querySelector("#syncActivityCurrentProgressTrack"),
    syncActivityCurrentProgressFill: document.querySelector("#syncActivityCurrentProgressFill"),
    syncActivityCurrentProgressMeta: document.querySelector("#syncActivityCurrentProgressMeta"),
    syncActivityPause: document.querySelector("#syncActivityPause"),
    syncActivityPauseStatus: document.querySelector("#syncActivityPauseStatus"),
    syncActivityAttention: document.querySelector("#syncActivityAttention"),
    syncActivitySummary: document.querySelector("#syncActivitySummary"),
    syncActivityRetryAllFailed: document.querySelector("#syncActivityRetryAllFailed"),
    syncActivityRefresh: document.querySelector("#syncActivityRefresh"),
    syncActivitySearch: document.querySelector("#syncActivitySearch"),
    syncActivityRows: document.querySelector("#syncActivityRows"),
    syncActivityTraktProgress: document.querySelector("#syncActivityTraktProgress"),
    syncActivityPagination: document.querySelector("#syncActivityPagination"),
    syncActivityPrevious: document.querySelector("#syncActivityPrevious"),
    syncActivityNext: document.querySelector("#syncActivityNext"),
    syncActivityPageLabel: document.querySelector("#syncActivityPageLabel"),
    syncActivityPageNumbers: document.querySelector("#syncActivityPageNumbers"),
    syncActivityPageRange: document.querySelector("#syncActivityPageRange"),
    changelogPanel: document.querySelector("#changelogPanel"),
    changelogChannelTabs: document.querySelector("#changelogChannelTabs"),
    changelogHeadingStatus: document.querySelector("#changelogHeadingStatus"),
    changelogRefreshButton: document.querySelector("#changelogRefreshButton"),
    aboutCurrentVersion: document.querySelector("#aboutCurrentVersion"),
    aboutReleaseChannel: document.querySelector("#aboutReleaseChannel"),
    authView: document.querySelector("#authView"),
    authForm: document.querySelector("#authForm"),
    authPanel: document.querySelector("#authPanel"),
    authPanelSignIn: document.querySelector("#authPanelSignIn"),
    authFooterBar: document.querySelector("#authFooterBar"),
    authFooterBarMeta: document.querySelector("#authFooterBarMeta"),
    claimPanel: document.querySelector("#claimPanel"),
    claimForm: document.querySelector("#claimForm"),
    claimUsername: document.querySelector("#claimUsername"),
    claimPassword: document.querySelector("#claimPassword"),
    claimPasswordConfirm: document.querySelector("#claimPasswordConfirm"),
    claimMessage: document.querySelector("#claimMessage"),
    setupPageRoot: document.querySelector("#setupPageRoot"),
    setupFooterBarMeta: document.querySelector("#setupFooterBarMeta"),
    adminToken: document.querySelector("#adminToken"),
    adminEmail: document.querySelector("#adminEmail"),
    adminCredentialsForm: document.querySelector("#adminCredentialsForm"),
    adminCredentialsStatus: document.querySelector("#adminCredentialsStatus"),
    currentAdminPassword: document.querySelector("#currentAdminPassword"),
    newAdminPassword: document.querySelector("#newAdminPassword"),
    confirmAdminPassword: document.querySelector("#confirmAdminPassword"),
    clearImportButton: document.querySelector("#clearImportButton"),
    closeModalButton: document.querySelector("#closeModalButton"),
    confirmModal: document.querySelector("#confirmModal"),
    confirmModalMedia: document.querySelector("#confirmModalMedia"),
    confirmModalMessage: document.querySelector("#confirmModalMessage"),
    approveConfirmButton: document.querySelector("#approveConfirmButton"),
    cancelConfirmButton: document.querySelector("#cancelConfirmButton"),
    closeConfirmModalButton: document.querySelector("#closeConfirmModalButton"),
    clearLogsButton: document.querySelector("#clearLogsButton"),
    downloadLogsButton: document.querySelector("#downloadLogsButton"),
    copyLogsButton: document.querySelector("#copyLogsButton"),
    dbStatus: document.querySelector("#dbStatus"),
    debugModal: document.querySelector("#debugModal"),
    explorerPanel: document.querySelector("#explorerPanel"),
    pageTopbar: document.querySelector("#pageTopbar"),
    pageTopbarActions: document.querySelector("#pageTopbarActions"),
    pageTopbarOnboardingButton: document.querySelector("#pageTopbarOnboardingButton"),
    topbarControlsMenu: document.querySelector("#topbarControlsMenu"),
    topbarControlsPanel: document.querySelector("#topbarControlsPanel"),
    settingsSubMenu: document.querySelector("#sidebarSettingsMenu"),
    sidebarAppearanceWrap: document.querySelector("#sidebarAppearanceWrap"),
    sidebarAppearanceButton: document.querySelector("#sidebarAppearanceButton"),
    sidebarAppearancePanel: document.querySelector("#sidebarAppearancePanel"),
    sidebarAppearanceMediaGroup: document.querySelector("#sidebarAppearanceMediaGroup"),
    historyPanel: document.querySelector("#historyPanel"),
    alphaFilterNav: document.querySelector("#alphaFilterNav"),
    explorerSearchInput: document.querySelector("#explorerSearchInput"),
    historySearchInput: document.querySelector("#historySearchInput"),
    historyFilterButtons: [...document.querySelectorAll("[data-history-filter]")],
    historyViewButtons: [...document.querySelectorAll("[data-history-view]")],
    partWatchedPanel: document.querySelector("#partWatchedRows"),
    partWatchedRows: document.querySelector("#partWatchedRows"),
    partWatchedSection: document.querySelector("#partWatchedRows"),
    partWatchedTvRow: document.querySelector("#partWatchedTvRow"),
    partWatchedTvSection: document.querySelector("#partWatchedTvSection"),
    partWatchedMovieRow: document.querySelector("#partWatchedMovieRow"),
    partWatchedMovieSection: document.querySelector("#partWatchedMovieSection"),
    explorerSort: document.querySelector("#explorerSort"),
    explorerHideWatchedLabel: document.querySelector("#explorerHideWatchedLabel"),
    explorerHideWatched: document.querySelector("#explorerHideWatched"),
    explorerHideEndedLabel: document.querySelector("#explorerHideEndedLabel"),
    explorerHideEnded: document.querySelector("#explorerHideEnded"),
    explorerViewButtons: [...document.querySelectorAll("[data-explorer-view]")],
    explorerTopbarControls: document.querySelector("#explorerTopbarControls"),
    historyTopbarControls: document.querySelector("#historyTopbarControls"),
    searchTopbarControls: document.querySelector("#searchTopbarControls"),
    statsTopbarControls: document.querySelector("#statsTopbarControls"),
    explorerSubtitle: document.querySelector("#explorerSubtitle"),
    explorerTitle: document.querySelector("#explorerTitle"),
    terminalModal: document.querySelector("#terminalModal"),
    closeTerminalModalButton: document.querySelector("#closeTerminalModalButton"),
    retryTerminalOutput: document.querySelector("#retryTerminalOutput"),
    globalSearchInput: document.querySelector("#globalSearchInput"),
    backupExportButton: document.querySelector("#createPlektBackupButton"),
    backupExportPassphrase: document.querySelector("#backupExportPassphrase"),
    backupExportRememberPassphrase: document.querySelector("#backupExportRememberPassphrase"),
    backupExportLog: document.querySelector("#backupExportLog"),
    backupExportStatus: document.querySelector("#plektBackupSummary"),
    backupImportButton: document.querySelector("#backupImportButton"),
    backupImportFile: document.querySelector("#backupImportFile"),
    backupRestorePassphrase: document.querySelector("#backupRestorePassphrase"),
    backupRestoreRemotePassphrase: document.querySelector("#backupRestoreRemotePassphrase"),
    backupRestoreLog: document.querySelector("#backupRestoreLog"),
    backupRestoreStatus: document.querySelector("#backupRestoreStatus"),
    plektBackupSummary: document.querySelector("#plektBackupSummary"),
    plektBackupEnabled: document.querySelector("#plektBackupEnabled"),
    plektBackupTime: document.querySelector("#plektBackupTime"),
    plektBackupRetention: document.querySelector("#plektBackupRetention"),
    savePlektBackupConfigButton: document.querySelector("#savePlektBackupConfigButton"),
    createPlektBackupButton: document.querySelector("#createPlektBackupButton"),
    plektBackupRuntime: document.querySelector("#plektBackupRuntime"),
    plektBackupList: document.querySelector("#plektBackupList"),
    remotePlektBackupList: document.querySelector("#remotePlektBackupList"),
    watchBackupSummary: document.querySelector("#watchBackupSummary"),
    watchBackupEnabled: document.querySelector("#watchBackupEnabled"),
    watchBackupTime: document.querySelector("#watchBackupTime"),
    watchBackupRetention: document.querySelector("#watchBackupRetention"),
    saveWatchBackupConfigButton: document.querySelector("#saveWatchBackupConfigButton"),
    createWatchBackupButton: document.querySelector("#createWatchBackupButton"),
    chooseWatchBackupFileButton: document.querySelector("#chooseWatchBackupFileButton"),
    watchBackupUploadFile: document.querySelector("#watchBackupUploadFile"),
    watchBackupUploadStatus: document.querySelector("#watchBackupUploadStatus"),
    refreshWatchBackupsButton: document.querySelector("#refreshWatchBackupsButton"),
    watchBackupRuntime: document.querySelector("#watchBackupRuntime"),
    watchBackupList: document.querySelector("#watchBackupList"),
    remoteWatchBackupList: document.querySelector("#remoteWatchBackupList"),
    backupDestinationCards: document.querySelector("#backupDestinationCards"),
    backupDestinationSummary: document.querySelector("#backupDestinationSummary"),
    remoteWatchBackupSummary: document.querySelector("#remoteWatchBackupSummary"),
    plektBackupRemoteEnabled: document.querySelector("#plektBackupRemoteEnabled"),
    plektBackupRemotePassphrase: document.querySelector("#plektBackupRemotePassphrase"),
    plektBackupRemoteRememberPassphrase: document.querySelector("#plektBackupRemoteRememberPassphrase"),
    savePlektBackupRemoteButton: document.querySelector("#savePlektBackupRemoteButton"),
    createPlektBackupRemoteButton: document.querySelector("#createPlektBackupRemoteButton"),
    plektBackupRemoteSummary: document.querySelector("#plektBackupRemoteSummary"),
    plektBackupRemoteRuntime: document.querySelector("#plektBackupRemoteRuntime"),
    createRemoteWatchBackupButton: document.querySelector("#createRemoteWatchBackupButton"),
    watchBackupRemoteRuntime: document.querySelector("#watchBackupRemoteRuntime"),
    watchBackupProgress: document.querySelector("#watchBackupProgress"),
    plektBackupProgress: document.querySelector("#plektBackupProgress"),
    remoteWatchBackupProgress: document.querySelector("#remoteWatchBackupProgress"),
    plektBackupRemoteProgress: document.querySelector("#plektBackupRemoteProgress"),
    remoteWatchBackupEnabled: document.querySelector("#remoteWatchBackupEnabled"),
    remoteWatchBackupTime: document.querySelector("#remoteWatchBackupTime"),
    remoteWatchBackupRetention: document.querySelector("#remoteWatchBackupRetention"),
    saveRemoteWatchBackupConfigButton: document.querySelector("#saveRemoteWatchBackupConfigButton"),
    appearShowLogoArt: document.querySelector("#appearShowLogoArt"),
    appearShowCast: document.querySelector("#appearShowCast"),
    appearShowTrailers: document.querySelector("#appearShowTrailers"),
    appearShowReviews: document.querySelector("#appearShowReviews"),
    appearShowImages: document.querySelector("#appearShowImages"),
    appearShowRelated: document.querySelector("#appearShowRelated"),
    appearHideLinks: document.querySelector("#appearHideLinks"),
    tvHistoryRow: document.querySelector("#tvHistoryRow"),
    movieHistoryRow: document.querySelector("#movieHistoryRow"),
    importFile: document.querySelector("#importFile"),
    importPreview: document.querySelector("#importPreview"),
    importProgress: document.querySelector("#importProgress"),
    importProgressFill: document.querySelector("#importProgressFill"),
    importProgressPercent: document.querySelector("#importProgressPercent"),
    importTerminal: document.querySelector("#importTerminal"),
    lockButton: document.querySelector("#lockButton"),
    logsTerminal: document.querySelector("#logsTerminal"),
    themeToggleButton: document.querySelector("#themeToggleButton"),
    message: document.querySelector("#message"),
    modalBody: document.querySelector("#modalBody"),
    monthChart: document.querySelector("#monthChart"),
    nowPlayingGrid: document.querySelector("#nowPlayingGrid"),
    nowPlayingStatus: document.querySelector("#nowPlayingStatus"),
    upNextPanel: document.querySelector("#upNextPanel"),
    upNextSection: document.querySelector("#upNextDashboardSection"),
    upNextSyncButton: document.querySelector("#upNextSyncButton"),
    upNextDismissedButton: document.querySelector("#upNextDismissedButton"),
    upNextSourceStatus: document.querySelector("#upNextSourceStatus"),
    discoverPanel: document.querySelector("#discoverPanel"),
    discoverTopbarControls: document.querySelector("#discoverTopbarControls"),
    discoverMediaType: document.querySelector("#discoverMediaType"),
    discoverGenre: document.querySelector("#discoverGenre"),
    discoverRefreshButton: document.querySelector("#discoverRefreshButton"),
    personalMediaTopbarControls: document.querySelector("#personalMediaTopbarControls"),
    personalMediaPanel: document.querySelector("#personalMediaPanel"),
    timelineView: document.querySelector("#timeline-view"),
    refreshSyncButton: document.querySelector("#refreshSyncButton"),
    runCronSyncButton: document.querySelector("#runCronSyncButton"),
    forceSyncButton: document.querySelector("#forceSyncButton"),
    stopSyncButton: document.querySelector("#stopSyncButton"),
    forceSyncTerminal: document.querySelector("#forceSyncTerminal"),
    syncProgress: document.querySelector("#syncProgress"),
    syncProgressLabel: document.querySelector("#syncProgressLabel"),
    syncProgressMeta: document.querySelector("#syncProgressMeta"),
    syncProgressTrack: document.querySelector("#syncProgressTrack"),
    syncProgressFill: document.querySelector("#syncProgressFill"),
    syncIssuesToggle: document.querySelector("#syncIssuesToggle"),
    syncIssuesContent: document.querySelector("#syncIssuesContent"),
    syncIssuesToggleIcon: document.querySelector("#syncIssuesToggleIcon"),
    syncHistoryToggle: document.querySelector("#syncHistoryToggle"),
    syncHistoryContent: document.querySelector("#syncHistoryContent"),
    syncHistoryToggleIcon: document.querySelector("#syncHistoryToggleIcon"),
    syncToolsToggle: document.querySelector("#syncToolsToggle"),
    syncToolsContent: document.querySelector("#syncToolsContent"),
    syncToolsToggleIcon: document.querySelector("#syncToolsToggleIcon"),
    runRepairButton: document.querySelector("#runRepairButton"),
    repairStatus: document.querySelector("#repairStatus"),
    repairLog: document.querySelector("#repairLog"),
    traktBackfillButton: document.querySelector("#traktBackfillButton"),
    traktBackfillLimit: document.querySelector("#traktBackfillLimit"),
    traktBackfillRate: document.querySelector("#traktBackfillRate"),
    traktBackfillStatus: document.querySelector("#traktBackfillStatus"),
    traktBackfillLog: document.querySelector("#traktBackfillLog"),
    phantomAuditButton: document.querySelector("#phantomAuditButton"),
    phantomAuditStatus: document.querySelector("#phantomAuditStatus"),
    phantomAuditLog: document.querySelector("#phantomAuditLog"),
    phantomRepairButton: document.querySelector("#phantomRepairButton"),
    phantomRepairStatus: document.querySelector("#phantomRepairStatus"),
    phantomRepairLog: document.querySelector("#phantomRepairLog"),
    duplicateWatchTvButton: document.querySelector("#duplicateWatchTvButton"),
    duplicateWatchMovieButton: document.querySelector("#duplicateWatchMovieButton"),
    duplicateWatchStatus: document.querySelector("#duplicateWatchStatus"),
    duplicateWatchLog: document.querySelector("#duplicateWatchLog"),
    episodeTitleAuditButton: document.querySelector("#episodeTitleAuditButton"),
    episodeTitleBackfillButton: document.querySelector("#episodeTitleBackfillButton"),
    episodeTitleStatus: document.querySelector("#episodeTitleStatus"),
    episodeTitleLog: document.querySelector("#episodeTitleLog"),
    wipeDataContent: document.querySelector("#wipeDataContent"),
    refreshMetadataButton: document.querySelector("#refreshMetadataButton"),
    refreshMetadataStatus: document.querySelector("#refreshMetadataStatus"),
    refreshMetadataLog: document.querySelector("#refreshMetadataLog"),
    refreshTvdbButton: document.querySelector("#refreshTvdbButton"),
    refreshTvdbStatus: document.querySelector("#refreshTvdbStatus"),
    refreshTvdbLog: document.querySelector("#refreshTvdbLog"),
    rematchTvButton: document.querySelector("#rematchTvButton"),
    rematchTvStatus: document.querySelector("#rematchTvStatus"),
    rematchTvLog: document.querySelector("#rematchTvLog"),
    settingsUsername: document.querySelector("#settingsUsername"),
    settingsForm: document.querySelector("#settingsForm"),
    settingsStatus: document.querySelector("#settingsStatus"),
    settingsPanels: [...document.querySelectorAll("[data-settings-panel]")],
    sourceRanking: document.querySelector("#sourceRanking"),
    statsMediaFilter: document.querySelector("#statsMediaFilter"),
    statsPeriodType: document.querySelector("#statsPeriodType"),
    statsPeriodValue: document.querySelector("#statsPeriodValue"),
    upcomingCalendar: document.querySelector("#upcomingCalendar"),
    upcomingCalendarFeedButton: document.querySelector("#upcomingCalendarFeedButton"),
    upcomingCalendarFeedDialog: document.querySelector("#upcomingCalendarFeedDialog"),
    upcomingCalendarFeedClose: document.querySelector("#upcomingCalendarFeedClose"),
    upcomingCalendarFeedUrl: document.querySelector("#upcomingCalendarFeedUrl"),
    upcomingCalendarFeedUrlFields: document.querySelector("#upcomingCalendarFeedUrlFields"),
    upcomingCalendarFeedStatus: document.querySelector("#upcomingCalendarFeedStatus"),
    upcomingCalendarFeedActions: document.querySelector("#upcomingCalendarFeedActions"),
    upcomingCalendarFeedIncludeTv: document.querySelector("#upcomingCalendarFeedIncludeTv"),
    upcomingCalendarFeedIncludeMovies: document.querySelector("#upcomingCalendarFeedIncludeMovies"),
    upcomingCalendarFeedCopy: document.querySelector("#upcomingCalendarFeedCopy"),
    upcomingCalendarFeedRegenerate: document.querySelector("#upcomingCalendarFeedRegenerate"),
    upcomingTopbarControls: document.querySelector("#upcomingTopbarControls"),
    upcomingMonthTitle: document.querySelector("#upcomingMonthTitle"),
    upcomingPrevButton: document.querySelector("#upcomingPrevButton"),
    upcomingNextButton: document.querySelector("#upcomingNextButton"),
    upcomingTodayButton: document.querySelector("#upcomingTodayButton"),
    upcomingSearchInput: document.querySelector("#upcomingSearchInput"),
    statsActivityTitle: document.querySelector("#statsActivityTitle"),
    statsActivitySubtitle: document.querySelector("#statsActivitySubtitle"),
    statsLeaderboardSubtitle: document.querySelector("#statsLeaderboardSubtitle"),
    topMediaReport: document.querySelector("#topMediaReport"),
    statsKpiStrip: document.querySelector("#statsKpiStrip"),
    statsLeaderboard: document.querySelector("#statsLeaderboard"),
    statsMoviesTvSplit: document.querySelector("#statsMoviesTvSplit"),
    statsBookends: document.querySelector("#statsBookends"),
    startImportButton: document.querySelector("#startImportButton"),
    statusPill: document.querySelector("#statusPill"),
    totalMovies: document.querySelector("#totalMovies"),
    totalEpisodes: document.querySelector("#totalEpisodes"),
    totalWatches: document.querySelector("#totalWatches"),
    topPlatform: document.querySelector("#topPlatform"),
    dbSize: document.querySelector("#dbSize"),
    trackingSpan: document.querySelector("#trackingSpan"),
    saveAdminCredentialsButton: document.querySelector("#saveAdminCredentialsButton"),
    rotateWebhookButton: document.querySelector("#rotateWebhookButton"),
    runCompleteCheckButton: document.querySelector("#runCompleteCheckButton"),
    previewForceSyncButton: document.querySelector("#previewForceSyncButton"),
    forceSyncPreviewPanel: document.querySelector("#forceSyncPreviewPanel"),
    refreshCacheStatsButton: document.querySelector("#refreshCacheStatsButton"),
    completeCheckResults: document.querySelector("#completeCheckResults"),
    syncHistoryPanel: document.querySelector("#syncHistoryPanel"),
    syncHistorySummary: document.querySelector("#syncHistorySummary"),
    syncJobsPanel: document.querySelector("#syncJobsPanel"),
    syncSummary: document.querySelector("#syncSummary"),
    tabButtons: [...document.querySelectorAll("[data-view]")],
    explorerButtons: [...document.querySelectorAll("[data-explorer-mode]")],
    viewPanels: [...document.querySelectorAll("[data-view-panel]")],
    closePersonModalButton: document.querySelector("#closePersonModalButton"),
    personModal: document.querySelector("#personModal"),
    personModalBody: document.querySelector("#personModalBody"),
    personModalTitle: document.querySelector("#personModalTitle"),
  });
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function updateAboutVersion(data) {
  if (!data) return;

  const channel = data.channel || "release";
  const current = data.current || data.version;
  const label = versionDisplayLabel(current, channel, data.alphaBuild, data.developBuild);

  if (elements.aboutCurrentVersion && label) {
    const labelPrefix = channel === "develop" ? "" : "v";
    elements.aboutCurrentVersion.textContent = `${labelPrefix}${label}`;
  }

  if (elements.aboutReleaseChannel) {
    elements.aboutReleaseChannel.textContent = channel === "develop"
      ? "Develop"
      : channel === "alpha"
        ? "Alpha"
        : "Latest";
  }
}

function updateVersionBadge(data) {
  updateAboutVersion(data);
  if (!elements.appVersion || !data?.current) return;
  const label = versionDisplayLabel(data.current, data.channel, data.alphaBuild, data.developBuild);
  const newerDevelopBuild = data.channel === "develop" && Boolean(data.developBuild?.newerBuildAvailable);
  const newerAlphaBuild = data.channel === "alpha" && Boolean(data.alphaBuild?.newerBuildAvailable);
  const showUpdate = data.channel === "develop"
    ? newerDevelopBuild
    : data.channel === "alpha"
      ? newerAlphaBuild
      : Boolean(data.updateAvailable);

  const labelPrefix = data.channel === "develop" ? "" : "v";
  elements.appVersion.textContent = showUpdate
    ? `${labelPrefix}${label} - Update available`
    : `${labelPrefix}${label}`;
  elements.appVersion.classList.toggle("app-version-update", showUpdate);
  elements.appVersion.title = newerDevelopBuild
    ? `Newer develop build available - build ${data.developBuild.latestBuild}. Open Changelog`
    : newerAlphaBuild
      ? `Newer alpha build available - build ${data.alphaBuild.latestBuild}. Open Changelog`
      : showUpdate
        ? `Update available - v${data.latest || data.current}. Open Changelog`
        : "Open Changelog";
}

// A page boot only needs the bundled version for the sidebar badge. The remote
// GitHub update check is useful, but it is not a critical dependency for the
// shell and can be slow when the provider worker is busy.
async function loadAppVersion() {
  if (!elements.appVersion) return;
  try {
    const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
    const checksForUpdates = pathname === "/" || pathname === "/dashboard";
    const response = await fetch("/version.json", {
      cache: "no-store",
      headers: authHeaders(),
    });
    const data = await response.json();
    if (response.ok) {
      updateVersionBadge({
        current: data.version,
        channel: data.channel || "release",
        alphaBuild: data.alphaBuild,
        developBuild: data.developBuild,
      });
      if (checksForUpdates) {
        // Use a real wall-clock delay here rather than requestIdleCallback:
        // an idle slot can arrive during the first paint on an otherwise light
        // page and put the remote request back on the critical path.
        window.setTimeout(async () => {
          try {
            const updateResponse = await fetch("/api/changelog?refresh=1", {
              cache: "no-store",
              headers: authHeaders(),
            });
            const updateData = await updateResponse.json().catch(() => null);
            if (updateResponse.ok && updateData) {
              state.changelog = updateData;
              updateVersionBadge(updateData);
            }
          } catch {
            // A remote release check is advisory; keep the bundled badge.
          }
        }, 5000);
      }
    }
  } catch {
    // Keep the HTML fallback version when release metadata is unavailable.
  }
}


function openConfirmDialog({ title = "Are you sure?", body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll(".confirm-dialog-overlay").forEach((el) => el.remove());
    const overlay = document.createElement("div");
    overlay.className = "edit-dialog-overlay confirm-dialog-overlay";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
    overlay.innerHTML = `
      <div class="edit-dialog">
        <h3>${escapeHtml(title)}</h3>
        ${body ? `<p class="confirm-dialog-body">${escapeHtml(body)}</p>` : ""}
        <div class="edit-dialog-actions">
          <button class="${danger ? "button-danger" : "button-primary"} confirm-dialog-confirm" type="button">${escapeHtml(confirmLabel)}</button>
          <button class="button-ghost confirm-dialog-cancel" type="button">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>
    `;
    overlay.querySelector(".confirm-dialog-confirm").addEventListener("click", () => finish(true));
    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", () => finish(false));
    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-dialog-confirm").focus();
  });
}

function closeGlobalSearchDropdown() {
  document.getElementById("globalSearchDropdown")?.remove();
}

function renderGlobalSearchDropdown(query) {
  closeGlobalSearchDropdown();
  const q = query.toLowerCase();

  const movies = [];
  const shows = [];
  const people = [];

  const seenMovies = new Set();
  const seenShows = new Set();
  const seenPeople = new Set();

  // Candidates are collected from every source without a per-source cap, then
  // ranked by how well each title matches the query and trimmed to the top few.
  // Capping during collection ranked by source instead: five TMDB shows would
  // crowd out a closer match that happened to come from TVDB.
  const COLLECT_LIMIT = 50;

  // 1. Local TV shows. Provider identity is the primary key: two series can
  // legitimately share a title, and a title-only key sends both to the same
  // legacy /tvshow/<slug> route.
  for (const s of (state.showsRaw || [])) {
    if (shows.length >= COLLECT_LIMIT) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    const identity = showSearchIdentity(s);
    if (seenShows.has(identity)) continue;
    seenShows.add(identity);
    shows.push({
      _type: "show",
      title: s.title,
      poster: s.poster_url || s.posterUrl || "",
      href: s.tmdb_id ? tvShowTmdbHref(s.tmdb_id, s.title) : s.tvdb_id ? tvShowTvdbHref(s.tvdb_id, s.title) : `/tvshow/${slug(s.title)}`,
      sub: "TV Show",
      overview: "",
      isLocal: true
    });
  }

  // 2. Local Movies
  for (const m of (state.history || [])) {
    if (movies.length >= COLLECT_LIMIT) break;
    if (m.media_type !== "movie") continue;
    if (!(m.title || "").toLowerCase().includes(q)) continue;
    if (seenMovies.has(comparableTitle(m.title))) continue;
    seenMovies.add(comparableTitle(m.title));
    movies.push({
      _type: "movie",
      title: m.title,
      poster: m.poster_url || "",
      href: movieHref(m),
      sub: "Movie",
      overview: "",
      isLocal: true
    });
  }

  // 3. TMDB Discovery
  const discoveryState = state.globalDiscoveryResults.get(q.trim());
  for (const item of (discoveryState?.results || [])) {
    const mediaType = item.media_type || (item.title ? "movie" : "tv");
    if (!["movie", "tv", "person"].includes(mediaType)) continue;

    const title = item.title || item.name || "Unknown title";
    const overview = item.overview || (item.known_for ? `Known for: ${item.known_for.map(x => x.title || x.name).filter(Boolean).join(", ")}` : "");
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);

    if (mediaType === "movie") {
      if (movies.length >= COLLECT_LIMIT) continue;
      if (seenMovies.has(comparableTitle(title))) {
        const existing = movies.find(m => comparableTitle(m.title) === comparableTitle(title));
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenMovies.add(comparableTitle(title));
      movies.push({
        _type: "movie",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "movie"),
        href: movieTmdbHref(item.id, title),
        sub: `Movie${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "tv") {
      if (shows.length >= COLLECT_LIMIT) continue;
      const identity = showSearchIdentity({ tmdb_id: item.id, title });
      if (seenShows.has(identity)) {
        const existing = shows.find(s => showSearchIdentity(s) === identity);
        if (existing && !existing.overview && overview) existing.overview = overview;
        continue;
      }
      seenShows.add(identity);
      shows.push({
        _type: "show",
        title,
        poster: tmdbPoster(item.poster_path, item.id, "tv"),
        href: tvShowTmdbHref(item.id, title),
        sub: `TV Show${year ? ` · ${year}` : ""} · TMDB`,
        overview,
        isLocal: false
      });
    } else if (mediaType === "person") {
      if (seenPeople.has(comparableTitle(title))) continue;
      seenPeople.add(comparableTitle(title));
      people.push({
        _type: "person",
        title,
        poster: tmdbProfile(item.profile_path) || tmdbPoster(item.profile_path),
        href: `/person/${item.id}`,
        sub: "Cast Member",
        overview,
        isLocal: false
      });
    }
  }

  // 4. TVDB series, searched alongside TMDB and de-duplicated against the local
  // and TMDB shows already collected above
  for (const item of (discoveryState?.tvdbShows || [])) {
    if (shows.length >= COLLECT_LIMIT) break;
    const title = item.name || "";
    const identity = showSearchIdentity({ tvdb_id: item.tvdb_id, title });
    if (!title || seenShows.has(identity)) continue;
    seenShows.add(identity);
    shows.push({
      _type: "show",
      title,
      poster: proxiedArtworkUrl(item.image_url, "poster"),
      href: tvShowTvdbHref(item.tvdb_id, title),
      sub: `TV Show${item.year ? ` · ${item.year}` : ""} · TVDB`,
      overview: "",
      isLocal: false
    });
  }

  const needle = comparableTitle(query);
  const finalMovies = rankSearchResults(movies, needle).slice(0, 5);
  const finalShows = rankSearchResults(shows, needle).slice(0, 5);
  const finalPeople = rankSearchResults(people, needle).slice(0, 5);

  if (!finalMovies.length && !finalShows.length && !finalPeople.length && !discoveryState?.loading && !discoveryState?.error) return;

  const anchor = document.querySelector(".global-search");
  if (!anchor) return;

  const renderItem = (r) => `
    <button class="global-search-result" data-href="${escapeAttribute(r.href)}" tabindex="0">
      ${r.poster ? `<img src="${escapeAttribute(r.poster)}" alt="" class="gsr-thumb" loading="lazy">` : `<span class="gsr-thumb gsr-thumb--empty"></span>`}
      <span class="gsr-text">
        <span class="gsr-title">${escapeHtml(r.title)}</span>
        <span class="gsr-sub">${escapeHtml(r.sub)}</span>
        ${r.overview ? `<span class="gsr-overview">${escapeHtml(r.overview)}</span>` : ""}
      </span>
    </button>`;

  const dd = document.createElement("div");
  dd.id = "globalSearchDropdown";
  dd.innerHTML = `
    <div class="gsd-header">Top Results for "<strong>${escapeHtml(query)}</strong>"</div>
    <div class="gsd-columns">
      <div class="gsd-column">
        <div class="gsd-column-header">Movies</div>
        <div class="gsd-column-list">
          ${finalMovies.length ? finalMovies.map(renderItem).join("") : '<div class="gsd-column-empty">No matching movies</div>'}
        </div>
      </div>
      <div class="gsd-column">
        <div class="gsd-column-header">TV Shows</div>
        <div class="gsd-column-list">
          ${finalShows.length ? finalShows.map(renderItem).join("") : '<div class="gsd-column-empty">No matching TV shows</div>'}
        </div>
      </div>
      <div class="gsd-column">
        <div class="gsd-column-header">People</div>
        <div class="gsd-column-list">
          ${finalPeople.length ? finalPeople.map(renderItem).join("") : '<div class="gsd-column-empty">No matching people</div>'}
        </div>
      </div>
    </div>
    ${discoveryState?.loading ? `<div class="gsd-loading">Searching TMDB…</div>` : ""}
    ${discoveryState?.error ? `<div class="gsd-error" role="status">${escapeHtml(discoveryState.error)}</div>` : ""}
    <button class="gsd-more" data-search="${escapeAttribute(query)}">View All Results</button>
  `;

  anchor.appendChild(dd);

  dd.addEventListener("click", (e) => {
    const more = e.target.closest(".gsd-more");
    if (more) {
      closeGlobalSearchDropdown();
      navigateTo(`/search?q=${encodeURIComponent(more.dataset.search)}`);
      return;
    }
    const btn = e.target.closest(".global-search-result");
    if (!btn) return;
    closeGlobalSearchDropdown();
    elements.globalSearchInput.value = "";
    navigateTo(btn.dataset.href);
  });

  dd.addEventListener("keydown", (e) => {
    const btns = [...dd.querySelectorAll(".global-search-result, .gsd-more")];
    const idx = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(idx + 1) % btns.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (idx > 0 ? btns[idx - 1] : elements.globalSearchInput)?.focus(); }
    else if (e.key === "Enter" && idx >= 0) { btns[idx].click(); }
    else if (e.key === "Escape") { closeGlobalSearchDropdown(); elements.globalSearchInput.focus(); }
  });
}

function comparableTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function showSearchIdentity(show = {}) {
  if (show.tmdb_id) return `tmdb:${String(show.tmdb_id)}`;
  if (show.tvdb_id) return `tvdb:${String(show.tvdb_id)}`;
  if (show.imdb_id) return `imdb:${String(show.imdb_id).toLowerCase()}`;
  return `title:${comparableTitle(show.title)}`;
}

// How closely a title answers the query. An exact title beats a prefix, which
// beats a match anywhere in the title.
function searchRelevance(title, needle) {
  const value = comparableTitle(title);
  if (!value || !needle) return 0;
  if (value === needle) return 8;
  if (value.startsWith(`${needle} `)) return 6;
  if (value.includes(` ${needle} `) || value.endsWith(` ${needle}`)) return 4;
  if (value.includes(needle)) return 2;
  if (needle.includes(value)) return 1;
  return 0;
}

// Whatever is on a connected media server is grouped ahead of TMDB/TVDB-only
// matches, then ranked by relevance within each group. Stable sort: equally
// relevant results keep the order the sources were collected in, so the
// ranking never reshuffles on a re-render.
function rankSearchResults(results, needle) {
  return results
    .map((result, index) => ({ result, index, score: searchRelevance(result.title, needle) }))
    .sort((a, b) => (Number(b.result.isLocal) - Number(a.result.isLocal)) || (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.result);
}

// TVDB series search, kept to results that plausibly match the query. TVDB uses
// the built-in project key, so this works whether or not a TMDB key is set.
async function tvdbShowSearch(query) {
  const needle = comparableTitle(query);
  if (!needle) return [];
  try {
    const response = await fetch(`/api/tvdb-search?query=${encodeURIComponent(query)}`, { headers: authHeaders() });
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    return (body.results || []).filter((item) => {
      const title = comparableTitle(item.name);
      return title && (title.includes(needle) || needle.includes(title));
    });
  } catch {
    return [];
  }
}

async function fetchTmdbDiscovery(query) {
  try {
    const response = await fetch(`/api/tmdb-search?query=${encodeURIComponent(query)}&mediaType=multi`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Search failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { results: body.results || [] };
  } catch (error) {
    console.warn("TMDB discovery search unavailable", error);
    return {
      results: [],
      error: error.status === 504 || /timed out/i.test(error.message || "")
        ? "TMDB is taking too long to respond. Local and TVDB results are still available; try again shortly."
        : "TMDB results are unavailable right now. Local and TVDB results are still available; try again.",
    };
  }
}

async function loadGlobalDiscovery(query) {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return;
  const token = ++state.globalSearchRequestToken;
  state.globalDiscoveryResults.set(normalized, { loading: true, results: [] });
  renderGlobalSearchDropdown(query);
  // Both catalogues are queried at once so TVDB series appear as quickly as TMDB
  // ones, and so an unavailable TMDB does not hold back or hide TVDB results.
  const [tmdb, tvdbShows] = await Promise.all([
    !isDemoMode() && state.savedConfig.tmdb?.configured ? fetchTmdbDiscovery(query) : Promise.resolve({ results: [] }),
    isDemoMode() ? Promise.resolve([]) : tvdbShowSearch(query),
  ]);
  state.globalDiscoveryResults.set(normalized, {
    loading: false,
    results: tmdb.results,
    tvdbShows,
    error: tmdb.error && !tvdbShows.length ? tmdb.error : "",
  });
  if (token === state.globalSearchRequestToken && elements.globalSearchInput?.value.trim().toLowerCase() === normalized) {
    renderGlobalSearchDropdown(query);
  }
}

function logDebug(message, details) {
  state.debugLogs = appendDebugLog(state.debugLogs, message, details);
  if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs") {
    renderLogs().catch(() => { });
  }
  return state.debugLogs.at(-1);
}

function logsText() {
  return logsToText(state.debugLogs);
}


function bootstrapTokenFromUrl() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token)=)|(?:^#(?:adminToken|username|token)=)/i.test(`${search}${hash}`);

  if (!hasAuthParams) return;

  scrubTokenFromLocation();
}

bootstrapTokenFromUrl();



function persistentDashboardHistoryCacheKey() {
  const userKey = state.currentUser?.uid || state.currentUser?.email || "local";
  return `${DASHBOARD_HISTORY_CACHE_KEY}:${userKey}`;
}

function readPersistentDashboardHistory() {
  try {
    const raw = localStorage.getItem(persistentDashboardHistoryCacheKey());
    const parsed = raw ? JSON.parse(raw) : {};
    if (!Array.isArray(parsed.history)) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > DASHBOARD_HISTORY_CACHE_TTL_MS) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function rememberDashboardHistory(history, historyVersion) {
  try {
    localStorage.setItem(persistentDashboardHistoryCacheKey(), JSON.stringify({
      savedAt: Date.now(),
      historyVersion: historyVersion || historyVersionFromRows(history),
      history,
    }));
  } catch (error) {
    // Dashboard cache is best-effort; the API remains the source of truth.
  }
}

function applyCachedDashboardHistory() {
  if (state.history.length) return true;
  const cached = readPersistentDashboardHistory();
  if (!cached?.history?.length) return false;
  state.history = cached.history;
  state.historyVersion = String(cached.historyVersion || historyVersionFromRows(cached.history));
  renderDashboard();
  return true;
}

function isLikelyActionableFailure(text, tone) {
  if (!["error", "warning"].includes(String(tone || "").toLowerCase())) return false;
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  // Validation and empty-state guidance belongs beside the control that raised
  // it. Only promote failures that indicate a service, request, sync, or
  // configuration problem that can still matter after the user changes page.
  if (/^(enter|select|choose|there are no|no watched|no local|cannot (?:mark|send|push)|this item does not|missing (?:media|details|info)|season information hasn't loaded|try again in a moment)/i.test(normalized)) return false;
  return /(could not|failed|failure|unable|error|exception|timed? out|timeout|unavailable|refused|unauthorized|forbidden|not responding|not found|network|connection|server|request|sync|import|metadata|backup|restore)/i.test(normalized);
}

function isSyncAttentionContext(options = {}) {
  if (String(options.scope || "").toLowerCase() === "sync") return true;
  return state.activeView === "syncActivity"
    || (state.activeView === "settings" && state.activeSettingsRoute?.panel === "sync");
}

function setMessage(text, tone = "muted", options = {}) {
  const messageText = String(text || "");
  if (elements.message) {
    elements.message.textContent = messageText;
    elements.message.dataset.tone = tone;
  }
  if (messageText && String(tone || "").toLowerCase() === "success") clearClientAttentionForRoute();
  if (messageText && elements.appShell && !elements.appShell.classList.contains("hidden") && !isSyncAttentionContext(options) && isLikelyActionableFailure(messageText, tone)) {
    recordClientAttention(messageText, tone, options);
  }
}

const DEMO_RESTRICTED_VIEWS = new Set(["syncActivity", "manualWatchReview", "setup", "importer"]);

function applyDemoSettingsReadOnly() {
  const settingsView = document.querySelector("#settings-view");
  if (!settingsView) return;
  const readOnly = isDemoMode();
  settingsView.classList.toggle("demo-settings-readonly", readOnly);
  document.querySelector("#demoSettingsReadOnlyNotice")?.classList.toggle("hidden", !readOnly);

  for (const control of settingsView.querySelectorAll("input, select, textarea, button")) {
    const isSettingsNavigation = control.id === "settingsSectionSelect" || Boolean(control.dataset.settingsPath);
    if (!control.dataset.demoOriginalDisabled) {
      control.dataset.demoOriginalDisabled = control.disabled ? "true" : "false";
    }
    control.disabled = readOnly && !isSettingsNavigation
      ? true
      : control.dataset.demoOriginalDisabled === "true";
    if (readOnly && !isSettingsNavigation) control.setAttribute("aria-disabled", "true");
    else control.removeAttribute("aria-disabled");
  }
}

function applyDemoUiRestrictions(isUnlocked = !elements.appShell?.classList.contains("hidden")) {
  const demo = isDemoMode();
  document.body.classList.toggle("demo-mode", demo);
  const banner = document.querySelector("#demoModeBanner");
  banner?.classList.toggle("hidden", !(demo && isUnlocked));
  for (const element of document.querySelectorAll(
    '#sidebarOnboardingCta, #sidebarSyncAttention, #manualWatchReviewButton'
  )) {
    // These controls have their own data-driven visibility renderers. Demo
    // mode may hide them, but normal route changes must not undo those states.
    if (demo) {
      element.classList.add("hidden");
      element.setAttribute("aria-hidden", "true");
    } else {
      element.removeAttribute("aria-hidden");
    }
  }
  if (elements.syncProgressIndicator) {
    elements.syncProgressIndicator.classList.remove("hidden");
    elements.syncProgressIndicator.toggleAttribute("aria-disabled", demo);
    if (demo) elements.syncProgressIndicator.title = "Sync is disabled in the public demo";
  }
  applyDemoSettingsReadOnly();
}

function setUnlocked(isUnlocked) {
  const showPreClaimSetup = !isUnlocked && state.claimRequired === true;
  const showAuthView = !isUnlocked && !showPreClaimSetup;
  document.body.classList.toggle("auth-locked", showAuthView);
  elements.authView?.classList.toggle("hidden", !showAuthView);
  elements.authPanel.classList.toggle("hidden", !showAuthView);
  elements.appShell.classList.toggle("hidden", !isUnlocked && !showPreClaimSetup);
  elements.lockButton.classList.toggle("hidden", !isUnlocked);
  if (isUnlocked) refreshSwitchUsers();
  applyDemoUiRestrictions(isUnlocked);
  if (!isUnlocked && isDemoMode()) {
    // Keep the public preview one click away even after a sign-out or a
    // browser refresh. These credentials are deliberately non-sensitive demo
    // credentials and never come from user storage.
    elements.adminEmail.value = "demo";
    elements.adminToken.value = "demo";
  }
  setLoginAutocompleteEnabled(!isUnlocked);
  if (elements.statusPill) {
    elements.statusPill.className = `session-dot ${isUnlocked ? "unlocked" : "locked"}`;
    elements.statusPill.setAttribute("aria-label", isUnlocked ? "Unlocked session" : "Locked session");
    elements.statusPill.title = isUnlocked ? "Unlocked" : "Locked";
  }
  applyActiveView();
}

function setLoginAutocompleteEnabled(enabled) {
  const fields = [
    { element: elements.adminEmail, autocomplete: "username" },
    { element: elements.adminToken, autocomplete: "current-password" },
  ];
  elements.authForm?.setAttribute("autocomplete", enabled ? "on" : "off");
  for (const attr of ["data-lpignore", "data-1p-ignore"]) {
    if (enabled) elements.authForm?.removeAttribute(attr);
    else elements.authForm?.setAttribute(attr, "true");
  }
  for (const { element, autocomplete } of fields) {
    if (!element) continue;
    element.setAttribute("autocomplete", enabled ? autocomplete : "off");
    for (const attr of ["data-lpignore", "data-1p-ignore"]) {
      if (enabled) element.removeAttribute(attr);
      else element.setAttribute(attr, "true");
    }
  }
}

const PW_BANNER_ID = "pw-change-required-banner";

function applyMustChangePassword() {
  const existing = document.getElementById(PW_BANNER_ID);
  if (state.mustChangePassword) {
    if (!existing) {
      const banner = document.createElement("div");
      banner.id = PW_BANNER_ID;
      banner.setAttribute("role", "alert");
      banner.style.cssText =
        "background:#b91c1c;color:#fff;padding:10px 16px;font-size:0.9rem;" +
        "font-weight:600;text-align:center;position:sticky;top:0;z-index:9999;" +
        "letter-spacing:0.01em;";
      banner.textContent =
        "Security notice: You are using the default admin password. " +
        "Change it below before using the dashboard.";
      elements.appShell?.prepend(banner);
    }
    state.activeView = "settings";
    state.activeSettingsRoute = parseSettingsRoute("/settings/account/login", { mustChangePassword: true });
    document.body.classList.add("pw-change-required");
  } else {
    existing?.remove();
    document.body.classList.remove("pw-change-required");
  }
}

function isPersonalMediaView(view) {
  return PERSONAL_MEDIA_VIEWS.includes(view);
}

function isConfigSensitiveRoute(path = "") {
  return path.startsWith("/movie/")
    || path.startsWith("/tvshow/")
    || path.startsWith("/person/")
    || path.startsWith("/search")
    || path.startsWith("/settings")
    || path === "/about"
    || path.startsWith("/sync")
    || path.startsWith("/logs")
    || path.startsWith("/discover")
    || path.startsWith("/watchlist")
    || path.startsWith("/ratings")
    || path.startsWith("/playlists")
    || path.startsWith("/custom-lists")
    || path.startsWith("/setup")
    || path.startsWith("/manual-watch-review");
}

// A route whose modules have not loaded yet renders its core parts now and is
// replayed once they arrive (route-modules.js loads each module once). A newer
// navigation supersedes a pending replay.
let routeGeneration = 0;
let routeReplayGeneration = -1;
// A route can repaint after the first active-view pass when its module graph is
// lazy-loaded. Keep the entry reset alive until that replay has painted too,
// otherwise the browser can restore the previous page's shell offset.
let pendingPageEntryScrollResetGeneration = null;
function routeModuleLoadFailed(error) {
  logDebug(`Route modules failed to load: ${error?.message || error}`);
  setMessage("This page failed to load. Reload the page to try again.", "error");
}

function finishPageEntryScrollReset(generation) {
  if (pendingPageEntryScrollResetGeneration !== generation) return;
  pendingPageEntryScrollResetGeneration = null;
  resetPageScrollPosition();
}

function handleRouting(path) {
  const generation = ++routeGeneration;
  handleRoutingNow(path);
  const keys = routeModulesForState();
  if (routeModulesLoaded(keys)) {
    if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "users") {
      Promise.resolve(loadSettingsUsersForRoute())
        .catch((error) => logDebug(`Users page refresh failed: ${error.message || error}`));
    }
    return;
  }
  routeReplayGeneration = generation;
  loadRouteModules(keys).then(() => {
    if (generation !== routeGeneration) return;
    routeReplayGeneration = -1;
    handleRoutingNow(path);
    applyActiveViewNow();
    if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "users") {
      Promise.resolve(loadSettingsUsersForRoute())
        .catch((error) => logDebug(`Users page refresh failed: ${error.message || error}`));
    }
    finishPageEntryScrollReset(generation);
  }).catch(routeModuleLoadFailed);
}

function applyActiveView() {
  applyActiveViewNow();
  const keys = routeModulesForState();
  // handleRouting() already scheduled a replay that ends in applyActiveViewNow().
  if (routeModulesLoaded(keys) || routeReplayGeneration === routeGeneration) return;
  const generation = routeGeneration;
  routeReplayGeneration = generation;
  loadRouteModules(keys).then(() => {
    if (generation !== routeGeneration) return;
    routeReplayGeneration = -1;
    applyActiveViewNow();
  }).catch(routeModuleLoadFailed);
}

function handleRoutingNow(path) {
  // A deferred route replay may finish after auth discovers a fresh install.
  // Keep every route in setup until the administrator has claimed it.
  if (state.claimRequired && !state.token) path = "/setup";
  const parts = path.split('#');
  const pathPart = parts[0];
  const hashPart = parts[1] || "";

  const pathPartNoQuery = pathPart.split('?')[0];
  const pathname = pathPartNoQuery.endsWith("/") && pathPartNoQuery.length > 1 ? pathPartNoQuery.slice(0, -1) : pathPartNoQuery;
  const previousExplorerListRoute = state.activeView === "explorer" && !state.mediaDetailInline
    ? (state.explorerMode === "shows" ? "/tvshows" : "/movies")
    : "";
  const isExplorerListRoute = pathname === "/movies" || pathname === "/tvshows";
  if (!isExplorerListRoute || (previousExplorerListRoute && previousExplorerListRoute !== pathname)) clearSearchInputs();

  if (!pathname.startsWith("/person")) {
    state.personProfileName = "";
    if (elements.personModal) {
      elements.personModal.classList.add("hidden");
    }
  }

  const personMatch = pathname.match(/^\/person\/(\d+)$/);
  // The trailing `-<slug>` (e.g. tmdb/202555-daredevil-born-again) is purely
  // decorative - the numeric id is what actually resolves the item. It's
  // never treated as identity on its own, unlike the local-key route below,
  // so two different real titles that happen to collide can't be confused.
  const movieTmdbMatch = pathname.match(/^\/movie\/tmdb\/(\d+)(?:-[^/]*)?$/);
  const tvshowTmdbMatch = pathname.match(/^\/tvshow\/tmdb\/(\d+)(?:-[^/]*)?(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);
  const tvshowTvdbMatch = pathname.match(/^\/tvshow\/tvdb\/(\d+)(?:-[^/]*)?(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);
  const movieMatch = pathname.match(/^\/movie\/([^/]+)$/);
  const tvshowMatch = pathname.match(/^\/tvshow\/([^/]+)(?:\/season\/(\d+))?(?:\/episode\/(\d+))?$/);

  if (personMatch) {
    const personId = personMatch[1];
    if (!state.activeView) {
      state.activeView = "dashboard";
    }
    loadCastMemberDetails(personId).catch((error) => console.error("Error loading cast member", error));
  } else if (movieTmdbMatch) {
    const tmdbId = movieTmdbMatch[1];
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      // The route type decides which library Back returns to. Reading
      // state.explorerMode here would capture whatever it happened to be, and on
      // a direct load of a detail URL that is still its "movies" default, which
      // sent Back to the wrong library.
      state.mediaDetailReturnExplorerMode = "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = null;
    state.activeMovieTmdbId = String(tmdbId);
    openMovieImmersiveModalByTmdbId(tmdbId).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowTmdbMatch) {
    const tmdbId = tvshowTmdbMatch[1];
    let seasonNum = null;
    let episodeNum = null;
    if (hashPart) {
      const hashMatch = hashPart.match(/^season(\d+)(?:ep(\d+))?$/);
      if (hashMatch) {
        seasonNum = Number(hashMatch[1]);
        episodeNum = hashMatch[2] ? Number(hashMatch[2]) : null;
      }
    }
    if (seasonNum === null) {
      seasonNum = tvshowTmdbMatch[2] ? Number(tvshowTmdbMatch[2]) : null;
      episodeNum = tvshowTmdbMatch[3] ? Number(tvshowTmdbMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = null;
    state.activeShowTmdbId = String(tmdbId);
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowImmersiveModalByTmdbId(tmdbId).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowTvdbMatch) {
    const tvdbId = tvshowTvdbMatch[1];
    let seasonNum = null;
    let episodeNum = null;
    if (hashPart) {
      const hashMatch = hashPart.match(/^season(\d+)(?:ep(\d+))?$/);
      if (hashMatch) {
        seasonNum = Number(hashMatch[1]);
        episodeNum = hashMatch[2] ? Number(hashMatch[2]) : null;
      }
    }
    if (seasonNum === null) {
      seasonNum = tvshowTvdbMatch[2] ? Number(tvshowTvdbMatch[2]) : null;
      episodeNum = tvshowTvdbMatch[3] ? Number(tvshowTvdbMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = null;
    state.activeShowTmdbId = null;
    state.activeShowTvdbId = String(tvdbId);
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowImmersiveModalByTvdbId(tvdbId).catch((error) => setMessage(error.message, "error"));
  } else if (movieMatch) {
    const movieKey = decodeURIComponent(movieMatch[1]);
    const movie = movieBySlugOrId(movieKey);
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "movies";
    }
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.activeMovieModalId = movie?.id || movieKey;
    openMovieInlineDetail(movie?.id || movieKey).catch((error) => setMessage(error.message, "error"));
  } else if (tvshowMatch) {
    const showKey = tvshowMatch[1];
    const routeQuery = pathPart.includes("?") ? pathPart.slice(pathPart.indexOf("?") + 1) : "";
    const queryHistoryId = new URLSearchParams(routeQuery).get("historyId")
      || new URLSearchParams(window.location.search).get("historyId")
      || "";
    // A pending/previous historyId is only relevant when re-rendering the show
    // already open (e.g. a season/episode hash change). Navigating to a
    // different show via a link that doesn't carry its own historyId - a
    // global search result, for instance - must not inherit the last show's
    // record, or the mismatch can make the wrong show's data render under
    // this show's URL.
    const sameShow = state.activeShowModalKey === showKey;
    const historyId = queryHistoryId || (sameShow ? (state.pendingShowHistoryId || state.activeShowHistoryId) : "") || "";
    state.activeShowHistoryId = historyId;
    state.pendingShowHistoryId = "";
    let seasonNum = null;
    let episodeNum = null;
    if (hashPart) {
      const hashMatch = hashPart.match(/^season(\d+)(?:ep(\d+))?$/);
      if (hashMatch) {
        seasonNum = Number(hashMatch[1]);
        episodeNum = hashMatch[2] ? Number(hashMatch[2]) : null;
      }
    }
    if (seasonNum === null) {
      seasonNum = tvshowMatch[2] ? Number(tvshowMatch[2]) : null;
      episodeNum = tvshowMatch[3] ? Number(tvshowMatch[3]) : null;
    }
    if (!state.mediaDetailInline) {
      state.mediaDetailReturnView = state.activeView || "dashboard";
      state.mediaDetailReturnExplorerMode = "shows";
    }
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.activeShowModalKey = showKey;
    state.activeShowModalSeason = seasonNum;
    state.activeShowModalEpisode = episodeNum;
    state.pendingSeasonScrollTarget = seasonNum;
    openShowInlineDetail(showKey, seasonNum, episodeNum, historyId).catch((error) => {
      console.error("Failed to open show detail", error);
      setMessage(error.message, "error");
    });
  } else if (pathname === "/" || pathname === "" || pathname === "/dashboard") {
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/movies") {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/tvshows") {
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/stats") {
    state.activeView = "stats";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/upcoming") {
    state.activeView = "upcoming";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/discover") {
    state.activeView = "discover";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/watchlist" || pathname === "/ratings" || pathname === "/playlists" || pathname === "/custom-lists") {
    if (pathname === "/custom-lists") history.replaceState(history.state, "", "/playlists");
    state.activeView = pathname === "/custom-lists" ? "playlists" : pathname.slice(1);
    state.personalMediaTab = state.activeView === "playlists" ? "lists" : state.activeView;
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/history") {
    state.activeView = "history";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/about" || pathname === "/settings/about") {
    state.activeView = "about";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    if (pathname !== "/about") history.replaceState(history.state, "", "/about");
  } else if (pathname === "/sync-activity") {
    state.activeView = "syncActivity";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/manual-watch-review") {
    state.activeView = "manualWatchReview";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  } else if (pathname === "/search") {
    state.activeView = "search";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    let query = "";
    try {
      const u = new URL(path, window.location.origin);
      query = u.searchParams.get("q") || u.searchParams.get("query") || "";
    } catch {
      const searchParams = new URLSearchParams(window.location.search);
      query = searchParams.get("q") || searchParams.get("query") || "";
    }
    triggerSearchPage(query);
  } else if (isDemoMode() && (
    pathname === "/setup"
    || pathname === "/sync"
    || pathname === "/logs"
    || pathname === "/sync-activity"
    || pathname === "/manual-watch-review"
  )) {
    // The demo deliberately has no onboarding, sync, backup, or provider-
    // management flow. Settings remain browseable but read-only.
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    history.replaceState(history.state, "", "/");
  } else if (pathname === "/setup") {
    state.activeView = "setup";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    loadSetupStatus().catch((error) => setMessage(error.message, "error"));
  } else if (pathname === "/settings/sync-issues"
    || pathname === "/settings/sync/issues"
    || pathname === "/settings/sync-match-report"
    || pathname === "/settings/system/sync") {
    state.activeView = "syncActivity";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    history.replaceState(history.state, "", "/sync-activity");
  } else if (pathname === "/sync" || pathname === "/logs" || pathname.startsWith("/settings")) {
    state.activeView = "settings";
    state.mediaDetailInline = false;
    clearMediaDetailState();
    state.activeSettingsRoute = parseSettingsRoute(pathname, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsTab = state.activeSettingsRoute.group;
    if (state.activeSettingsRoute.path !== pathname) {
      history.replaceState(history.state, "", state.activeSettingsRoute.path);
    }

  } else {
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  }
}

function clearSearchInputs() {
  window.clearTimeout(state.explorerSearchTimer);
  window.clearTimeout(state.globalSearchDropdownTimer);
  window.clearTimeout(state.globalSearchRemoteTimer);
  state.explorerSearch = "";
  if (elements.explorerSearchInput) {
    elements.explorerSearchInput.value = "";
    elements.explorerSearchInput.setAttribute("readonly", "true");
  }
  if (elements.globalSearchInput) {
    elements.globalSearchInput.value = "";
    elements.globalSearchInput.setAttribute("readonly", "true");
  }
  closeGlobalSearchDropdown();
}

function routePathname(url) {
  try {
    return new URL(url, window.location.origin).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(url || "/").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  }
}

function resetPageScrollPosition() {
  // The shell owns vertical scrolling, while media rails and page-specific
  // panels can own horizontal/inner scrolling. Reset every descendant that
  // actually has a position so no newly entered view inherits a hidden rail,
  // log panel, or calendar position from the previous page.
  const pageShell = document.querySelector(".page-shell");
  const scrollContainers = pageShell ? [pageShell, ...pageShell.querySelectorAll("*")] : [];
  for (const container of scrollContainers) {
    // An earlier settings/detail jump may still be running when navigation
    // starts. An explicit auto scroll cancels that animation before the new
    // route is rendered; assigning scrollTop alone is not reliable in that
    // case in every browser.
    if (container === pageShell && typeof container.scrollTo === "function") {
      try {
        container.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } catch {
        container.scrollTo(0, 0);
      }
    }
    if (container.scrollTop) container.scrollTop = 0;
    if (container.scrollLeft) container.scrollLeft = 0;
  }
  try {
    window.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
  } catch {
    window.scrollTo?.(0, 0);
  }
  if (document.scrollingElement) {
    if (typeof document.scrollingElement.scrollTo === "function") {
      try {
        document.scrollingElement.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } catch {
        document.scrollingElement.scrollTo(0, 0);
      }
    }
    document.scrollingElement.scrollTop = 0;
    document.scrollingElement.scrollLeft = 0;
  }
}

function resetMobileControlState() {
  for (const tab of document.querySelectorAll(".mobile-control-tab.active")) {
    tab.classList.remove("active");
    tab.setAttribute("aria-pressed", "false");
  }
  for (const panel of document.querySelectorAll(".active-mobile-panel")) {
    panel.classList.remove("active-mobile-panel");
  }
  for (const details of document.querySelectorAll(".page-topbar details[open], .topnav details[open]")) {
    details.removeAttribute("open");
  }
}

function resetPageEntryState(url) {
  try {
    history.scrollRestoration = "manual";
  } catch { }

  const hasExplicitAnchor = String(url || "").includes("#");
  const preservesRouteAnchor = routePathname(url) === "/upcoming";
  pendingPageEntryScrollResetGeneration = hasExplicitAnchor || preservesRouteAnchor
    ? null
    : routeGeneration + 1;
  resetPageScrollPosition();
  if (pendingPageEntryScrollResetGeneration !== null) {
    const expectedGeneration = pendingPageEntryScrollResetGeneration;
    const schedule = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback) => window.setTimeout(callback, 0);
    schedule(() => {
      if (pendingPageEntryScrollResetGeneration !== expectedGeneration || routeGeneration !== expectedGeneration) return;
      resetPageScrollPosition();
      // If the route was already loaded, there will be no lazy-module replay
      // to finish the reset. Clear the marker here; otherwise the replay owns
      // the final reset below.
      if (routeModulesLoaded(routeModulesForState())) pendingPageEntryScrollResetGeneration = null;
    });
  }
  resetMobileControlState();
  clearSearchInputs();
  // Sideways rails start at the beginning again, and modules holding opened
  // posters or stacks fold them back (page-entry listeners).
  // Swept generically: the Dashboard rails use their own classes.
  for (const el of document.querySelectorAll(".page-shell *")) {
    if (el.scrollLeft && el.scrollWidth > el.clientWidth) el.scrollLeft = 0;
  }
  document.dispatchEvent(new CustomEvent("plembfin:page-entry", { detail: { url } }));

  window.clearTimeout(state.historyViewSearchTimer);
  state.historyViewSearch = "";
  if (elements.historySearchInput) {
    elements.historySearchInput.value = "";
    elements.historySearchInput.setAttribute("readonly", "true");
  }
  state.upcomingSearch = "";
  state.upcomingSearchLoading = false;
  if (elements.upcomingSearchInput) elements.upcomingSearchInput.value = "";
  state.personalMediaActiveListId = "";

  // Reset the flat history on every entry so a late response from an earlier
  // visit cannot append old rows to the new page. The selected media filter
  // and layout remain user preferences; only the page/query state is fresh.
  resetHistoryView([state.historyViewSearch, state.historyViewFilter].join("|"));
  resetSyncActivity();

  const pathname = routePathname(url);
  if (pathname === "/") {
    // Keep the last painted Up Next cards on entry; the fresh snapshot replaces them.
    resetUpNext({ preserveItems: true });
    resetPartWatchedView("", { preserveItems: false });
  } else if (pathname === "/movies") {
    resetMovieExplorer();
  } else if (pathname === "/tvshows") {
    resetShowExplorer();
  } else if (pathname === "/discover") {
    state.discoverMediaType = "all";
    state.discoverGenreId = "";
    resetDiscover();
  } else if (isPersonalMediaView(pathname.slice(1))) {
    resetPersonalMedia();
  } else if (pathname === "/stats") {
    state.statsMediaFilter = "all";
    state.statsPeriodType = "all";
    state.statsPeriodValue = "all";
    state.statsLoaded = false;
  }
}

function navigateTo(url) {
  closeMobileMenu();
  const currentUrl = window.location.pathname + window.location.search + window.location.hash;
  if (currentUrl !== url) {
    const nextIndex = (history.state?.index || 0) + 1;
    history.pushState({ index: nextIndex }, "", url);
    state.internalHistoryCount = nextIndex;
    resetPageEntryState(url);
  }
  handleRouting(url);
  applyActiveView();
  if (url.startsWith("/settings")) {
    const targetSection = url.split("#")[1];
    if (targetSection) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToSettingsSection(targetSection));
      });
    } else {
      focusSettingsRoute(state.activeSettingsRoute);
    }
  }
}

function selectView(view, { fresh = false } = {}) {
  if (isDemoMode() && DEMO_RESTRICTED_VIEWS.has(view)) {
    navigateTo("/");
    return;
  }
  if (state.mustChangePassword && view !== "settings") {
    navigateTo("/settings/account/login");
    return;
  }
  const legacyImporterView = view === "importer";
  const requestedView = legacyImporterView ? "settings" : view;
  const legacySettingsTab = legacyImporterView ? "tools" : null;
  const targetView = requestedView === "about" || PRIMARY_VIEWS.includes(requestedView) ? requestedView : "dashboard";

  let url = "/";
  if (state.mediaDetailInline) {
    const personMatch = window.location.pathname.match(/^\/person\/(\d+)$/);
    if (personMatch) {
      url = window.location.pathname + window.location.hash;
    } else if (state.explorerMode === "shows" && state.activeShowModalKey) {
      url = `/tvshow/${state.activeShowModalKey}`;
      const historyId = state.activeShowHistoryId
        || state.pendingShowHistoryId
        || new URLSearchParams(window.location.search).get("historyId")
        || "";
      if (historyId) {
        url += `?historyId=${encodeURIComponent(historyId)}`;
      }
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "shows" && state.activeShowTmdbId) {
      url = tvShowTmdbHref(state.activeShowTmdbId, state.activeShowModalTitle);
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "shows" && state.activeShowTvdbId) {
      // Series TMDB has no record of are addressed by their TVDB id instead.
      url = tvShowTvdbHref(state.activeShowTvdbId, state.activeShowModalTitle);
      if (state.activeShowModalSeason !== null) {
        url += `#season${state.activeShowModalSeason}`;
        if (state.activeShowModalEpisode !== null) {
          url += `ep${state.activeShowModalEpisode}`;
        }
      }
    } else if (state.explorerMode === "movies" && state.activeMovieModalId) {
      url = movieHref(movieBySlugOrId(state.activeMovieModalId) || { id: state.activeMovieModalId });
    } else if (state.explorerMode === "movies" && state.activeMovieTmdbId) {
      url = movieTmdbHref(state.activeMovieTmdbId, document.querySelector(".immersive-title")?.textContent);
    } else {
      url = state.explorerMode === "shows" ? "/tvshows" : "/movies";
    }
  } else if (targetView === "explorer") {
    url = state.explorerMode === "shows" ? "/tvshows" : "/movies";
  } else if (targetView === "settings") {
    url = legacySettingsTab ? settingsPathForLegacy(legacySettingsTab) : "/settings";

  } else if (targetView === "about") {
    url = "/about";

  } else if (targetView === "search") {
    const q = state.searchQuery || new URLSearchParams(window.location.search).get("q") || "";
    url = `/search${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  } else if (targetView === "manualWatchReview") {
    url = "/manual-watch-review";
  } else if (targetView !== "dashboard") {
    url = `/${targetView}`;
  }

  const currentUrl = window.location.pathname + window.location.search + window.location.hash;
  if (currentUrl !== url) {
    // User navigation must not wait for bootstrap config. Route handlers can
    // render before config arrives, and the config completion path reconciles
    // the current URL afterward.
    navigateTo(url);
  } else {
    // A sidebar click on the page already open reloads it, exactly as the
    // browser's refresh does (resetting in place rebuilt Up Next and the rails
    // several times and flickered). Boot sets manual scroll restoration, so
    // the reload opens at the top.
    if (fresh) {
      window.location.reload();
      return;
    }
    // Repair URL/state drift if an async bootstrap callback finished after a
    // route change, and keep same-URL navigation deterministic.
    handleRouting(url);
    applyActiveView();
  }
}

function selectBackupsTab(tab) {
  const validTabs = ["settings", "restore"];
  state.activeBackupsTab = validTabs.includes(tab) ? tab : "settings";
  localStorage.setItem("activeBackupsTab", state.activeBackupsTab);
  if (state.activeBackupsTab === "restore") {
    state.remoteBackupFiles = [];
    state.remoteBackupFilesLoading = false;
  }
  applyActiveView();
  if (state.activeBackupsTab === "restore") {
    loadRemoteBackupsForRestoreTab().catch((error) => setMessage(error.message, "error"));
  }
}

function settingsTopbarTitle() {
  const route = state.activeSettingsRoute;
  if (route?.title === "Settings overview") return "Settings";
  const crumbs = ["Settings", route?.groupLabel, route?.title || "Overview"].filter(Boolean);
  return crumbs.join(" - ");
}



function syncPageTopbar() {
  if (!elements.pageTopbar) return;

  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search);
  const isPersonDetail = path.startsWith("/person/");
  const isInlineDetail = state.mediaDetailInline || isPersonDetail;
  const isMobile = window.matchMedia("(max-width: 640px)").matches;
  const isMobileTopbar = window.matchMedia("(max-width: 760px)").matches;
  document.body.classList.toggle("media-detail-active", isInlineDetail);
  document.body.classList.toggle("person-detail-active", isPersonDetail);
  const controlGroups = [
    elements.explorerTopbarControls,
    elements.historyTopbarControls,
    elements.searchTopbarControls,
    elements.statsTopbarControls,
    elements.upcomingTopbarControls,
    elements.discoverTopbarControls,
    elements.personalMediaTopbarControls,
    elements.settingsSubMenu,
  ].filter(Boolean);
  let title = "Dashboard";
  let subtitle = "Overview";
  let activeControls = null;

  if (state.activeView === "explorer") {
    const mode = state.explorerMode === "shows" ? "shows" : "movies";
    title = mode === "shows" ? "TV Shows" : "Movies";
    if (isInlineDetail) {
      if (mode === "shows" && state.activeShowModalKey) {
        const activeShow = state.showsRaw?.find(s => slug(s.title) === state.activeShowModalKey);
        if (activeShow?.title) title = `TV Shows - ${activeShow.title}`;
      } else if (mode === "shows" && state.activeShowModalTitle) {
        title = `TV Shows - ${state.activeShowModalTitle}`;
      } else if (mode === "movies" && state.activeMovieModalId) {
        const activeMovie =
          state.history?.find(h => h.id === state.activeMovieModalId) ||
          state.moviesRaw?.find(movie => String(movie.id) === String(state.activeMovieModalId));
        if (activeMovie?.title) title = `Movies - ${activeMovie.title}`;
      }
    } else {
      title = `${title} - ${state.savedConfig?.plex?.username || "Watched history library"}`;
    }
    subtitle = "";
    activeControls = isInlineDetail ? null : elements.explorerTopbarControls;
  } else if (state.activeView === "history") {
    title = "Watch History";
    subtitle = "";
    activeControls = elements.historyTopbarControls;
  } else if (state.activeView === "syncActivity") {
    title = "Sync Activity";
    subtitle = "";
    activeControls = null;
  } else if (state.activeView === "manualWatchReview") {
    title = "Manual Watch review";
    subtitle = "";
    activeControls = null;
  } else if (state.activeView === "stats") {
    title = "Stats";
    subtitle = "";
    activeControls = elements.statsTopbarControls;
  } else if (state.activeView === "upcoming") {
    title = "Upcoming";
    subtitle = "";
    activeControls = elements.upcomingTopbarControls;
  } else if (state.activeView === "discover") {
    title = "Discover";
    subtitle = "";
    activeControls = elements.discoverTopbarControls;
  } else if (isPersonalMediaView(state.activeView)) {
    title = state.activeView === "ratings"
      ? "Ratings"
      : state.activeView === "playlists"
        ? "Playlists"
        : "Watchlist";
    subtitle = "";
    activeControls = elements.personalMediaTopbarControls;
  } else if (state.activeView === "settings") {
    title = settingsTopbarTitle();
    subtitle = "";
    activeControls = null;

  } else if (state.activeView === "about") {
    title = "About";
    subtitle = "Product details, integrations, and privacy";
    activeControls = null;

  } else if (state.activeView === "search") {
    const searchQuery = state.searchQuery || query.get("q") || "";
    title = searchQuery
      ? `Search Results for "${searchQuery}" - Local and global database search results`
      : "Search Results - Local and global database search results";
    subtitle = "";
    activeControls = elements.searchTopbarControls;
  } else if (state.activeView === "setup") {
    title = "Initial Setup";
    subtitle = "";
    activeControls = null;
  }

  if (isPersonDetail && state.personProfileName) {
    title = state.personProfileName;
    subtitle = "";
  }

  const usePageOptionsMenu = Boolean(activeControls && isMobileTopbar && !isInlineDetail);

  if (elements.explorerTitle) elements.explorerTitle.textContent = title;
  if (elements.explorerSubtitle) {
    elements.explorerSubtitle.textContent = subtitle;
    elements.explorerSubtitle.classList.toggle("hidden", !subtitle);
  }

  elements.pageTopbarOnboardingButton?.classList.toggle(
    "hidden",
    !(state.activeView === "settings" && state.activeSettingsRoute?.group === "tools"),
  );

  const backButton = document.querySelector("#explorerBackButton");
  backButton?.classList.toggle("hidden", !isInlineDetail);

  document.body.classList.toggle("page-controls-options-active", usePageOptionsMenu);
  if (elements.topbarControlsMenu && elements.pageTopbarActions) {
    if (!usePageOptionsMenu && elements.topbarControlsMenu.parentElement !== elements.pageTopbarActions) {
      elements.pageTopbarActions.insertBefore(elements.topbarControlsMenu, elements.pageTopbarActions.firstChild);
    }
    elements.topbarControlsMenu.classList.toggle("hidden", !usePageOptionsMenu);
    const controlGroupId = usePageOptionsMenu ? activeControls.id : "";
    if (!usePageOptionsMenu || elements.topbarControlsMenu.dataset.controlsFor !== controlGroupId) {
      elements.topbarControlsMenu.removeAttribute("open");
    }
    if (usePageOptionsMenu) {
      elements.topbarControlsMenu.dataset.controlsFor = controlGroupId;
    } else {
      delete elements.topbarControlsMenu.dataset.controlsFor;
    }
  }

  for (const group of controlGroups) {
    restoreTopbarControlGroup(group);
    group.classList.add("hidden");
  }

  if (!isMobile && state.activeView === "settings" && elements.settingsSubMenu) {
    elements.settingsSubMenu.classList.remove("hidden");
  }


  const mediaDetailActions = document.getElementById("mediaDetailActions");
  // The detail action manager moves Options into the title row on phones.
  // Keep it there when syncing the rest of the topbar because the original
  // toolbar row is hidden at that viewport size.
  const keepMediaActionsInline = isInlineDetail && isMobile &&
    mediaDetailActions?.parentElement?.classList.contains("page-topbar-title");
  if (elements.pageTopbarActions) {
    if (usePageOptionsMenu && elements.topbarControlsMenu && elements.topbarControlsPanel) {
      const titleContainer = elements.pageTopbar?.querySelector(".page-topbar-title");
      if (titleContainer && elements.topbarControlsMenu.parentElement !== titleContainer) {
        titleContainer.appendChild(elements.topbarControlsMenu);
      }
      elements.topbarControlsPanel.appendChild(activeControls);
      activeControls.classList.remove("hidden");
    } else if (activeControls) {
      const targetNextSibling = mediaDetailActions || null;
      if (activeControls.parentElement !== elements.pageTopbarActions || activeControls.nextSibling !== targetNextSibling) {
        elements.pageTopbarActions.insertBefore(activeControls, targetNextSibling);
      }
      activeControls.classList.remove("hidden");
    }
    if (mediaDetailActions && mediaDetailActions.parentElement !== elements.pageTopbarActions && !keepMediaActionsInline) {
      elements.pageTopbarActions.appendChild(mediaDetailActions);
    }
  }
  syncTopbarControlsMenuState();
  const hasVisibleTopbarAction = Boolean(
    usePageOptionsMenu
    || (activeControls && !activeControls.classList.contains("hidden"))
    // The row is hidden while empty, so a control inside it has no client rects and the
    // check below would never see it. Read the toggle state directly instead.
    || Boolean(elements.pageTopbarOnboardingButton && !elements.pageTopbarOnboardingButton.classList.contains("hidden"))
    || Array.from(elements.pageTopbarActions?.querySelectorAll("button, a, input, select, [role='button']") || [])
      .some((control) => (
        !control.closest(".hidden") && getComputedStyle(control).display !== "none" && control.getClientRects().length > 0
      )),
  );
  const hasVisibleBackAction = isInlineDetail && backButton && !backButton.classList.contains("hidden");
  elements.pageTopbar.classList.toggle("page-topbar--empty", !hasVisibleTopbarAction && !hasVisibleBackAction);
}

function restoreTopbarControlGroup(group) {
  if (!group) return;
  if (group.id === "sidebarSettingsMenu") {
    const settingsButton = document.querySelector('[data-view="settings"]');
    if (settingsButton && (group.parentElement !== settingsButton.parentElement || settingsButton.nextElementSibling !== group)) {
      settingsButton.after(group);
    }
    return;
  }
  if (elements.topbarControlsPanel?.contains(group) && elements.pageTopbarActions) {
    const mediaDetailActions = document.getElementById("mediaDetailActions");
    elements.pageTopbarActions.insertBefore(group, mediaDetailActions || null);
  }
}

let settingsStatusActive = false;
function syncSettingsStatusLifecycle() {
  if (state.activeView !== "settings" || !state.token) {
    if (settingsStatusActive) {
      stopRatingSyncSettings();
      stopWatchlistSyncSettings();
    }
    settingsStatusActive = false;
    return;
  }
  if (settingsStatusActive || !routeModulesLoaded(SETTINGS_ROUTE_MODULES)) return;
  settingsStatusActive = true;
  refreshTrackerSettings().catch(() => null);
  resumeRatingSyncSettings().catch(() => null);
  resumeWatchlistSyncSettings().catch(() => null);
  resumeActiveRefreshJobs();
}

function applyActiveViewNow() {
  if (isDemoMode() && DEMO_RESTRICTED_VIEWS.has(state.activeView)) {
    state.activeView = "dashboard";
    state.mediaDetailInline = false;
    clearMediaDetailState();
  }
  syncSettingsStatusLifecycle();
  localStorage.setItem(ACTIVE_VIEW_KEY, state.activeView);
  applyDemoUiRestrictions();
  document.querySelector(".page-shell")?.setAttribute("data-active-view", state.activeView);
  // The setup wizard and locked login are full-page flows - the sidebar and
  // page topbar are not useful there, so hide both entirely. Each shell keeps
  // the version and theme controls in its own bottom-center bar so they stay
  // reachable without the rest of the sidebar.
  const isSetupView = state.activeView === "setup";
  const isAuthView = document.body.classList.contains("auth-locked");
  document.querySelector(".topnav")?.classList.toggle("hidden", isSetupView || isAuthView);
  document.querySelector("#pageTopbar")?.classList.toggle("hidden", isSetupView || isAuthView);
  const setupFooterBar = document.querySelector("#setupFooterBar");
  const authFooterBar = elements.authFooterBar;
  setupFooterBar?.classList.toggle("hidden", !isSetupView);
  authFooterBar?.classList.toggle("hidden", !isAuthView);
  if (elements.appVersion && elements.themeToggleButton) {
    if (isSetupView && setupFooterBar) {
      const meta = elements.setupFooterBarMeta || setupFooterBar;
      meta.appendChild(elements.appVersion);
      meta.appendChild(elements.themeToggleButton);
      // The changelog it links to isn't relevant mid-onboarding; keep the
      // version number visible but not clickable there.
      elements.appVersion.disabled = true;
    } else if (isAuthView && authFooterBar) {
      const meta = elements.authFooterBarMeta || authFooterBar;
      meta.appendChild(elements.appVersion);
      meta.appendChild(elements.themeToggleButton);
      elements.appVersion.disabled = true;
    } else if (!isSetupView) {
      const sidebarBuildRow = document.querySelector(".sidebar-build-row");
      if (sidebarBuildRow) sidebarBuildRow.prepend(elements.appVersion);
      // The theme switcher lives in its Appearance group; setup and sign-in move it out, so put
      // it back.
      const themeGroup = document.querySelector(".sidebar-appearance-theme-group");
      if (themeGroup && elements.themeToggleButton) themeGroup.appendChild(elements.themeToggleButton);
      elements.appVersion.disabled = false;
    }
  }

  for (const button of elements.tabButtons || []) {
    const explorerMode = button.dataset.explorerNav;
    const isExplorerMode = state.activeView === "explorer" && explorerMode === state.explorerMode;
    const isActiveView = button.dataset.view === state.activeView && !explorerMode;
    button.classList.toggle("active", isActiveView || isExplorerMode);
  }

  for (const panel of elements.viewPanels || []) {
    const isPersonalPanel = panel.dataset.viewPanel === "personal-media" && isPersonalMediaView(state.activeView);
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== state.activeView && !isPersonalPanel);
  }

  const settingsSubMenu = document.querySelector("#sidebarSettingsMenu");
  if (settingsSubMenu) {
    settingsSubMenu.classList.toggle("hidden", state.activeView !== "settings");
  }
  if (state.activeView === "dashboard") {
    const refreshHistory = state.token && Date.now() - state.historyFetchedAt > HISTORY_REUSE_MS;
    if (refreshHistory) {
      state.historyLoading = true;
      state.historyLoadError = "";
      state.upNextFromCache = true;
      state.upNextLoadedAt = 0;
    }
    renderDashboard();
    renderUpNext();
    // Read the shared server projection after the shell paints. The
    // dashboard shows a loading state until this authoritative snapshot arrives.
    scheduleDeferredStartupWork(() => loadUpNext(), 0);
    // The route replays once its modules load; reuse a fetch that just finished
    // rather than requesting history twice. Mutations use loadHistory({ force }).
    if (refreshHistory) {
      loadHistory({ force: !state.historyFetchedAt }).catch((error) => {
        state.historyLoading = false;
        state.historyLoadError = error.message || "Could not load watch history.";
        renderDashboard();
        setMessage(error.message, "error");
      });
    }
  }
  if (state.activeView === "stats") {
    renderStats();
    loadStats().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "upcoming") {
    openUpcomingToToday();
  }
  if (state.activeView === "discover") {
    renderDiscover();
    loadDiscover().catch((error) => setMessage(error.message, "error"));
    renderPersonalMedia();
    loadPersonalMedia().catch((error) => setMessage(error.message, "error"));
    if (state.token && !state.historyVersion && !state.historyLoadPromise) {
      loadHistory().catch((error) => setMessage(error.message, "error"));
    }
  }
  if (isPersonalMediaView(state.activeView)) {
    renderPersonalMedia();
    loadPersonalMedia({ maxAgeMs: 5000 }).catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
  if (state.activeView === "search") renderSearchPage();
  if (state.activeView === "setup") renderSetupPage();
  if (state.activeView === "history") renderHistoryView();
  if (state.activeView === "syncActivity") {
    renderSyncActivity();
    startSyncActivityRefresh();
    if (state.token) {
      loadSyncActivity({ force: true }).catch((error) => setMessage(error.message, "error"));
      loadSyncAttention({ force: true }).catch((error) => logDebug(`Sync attention details failed to load: ${error.message}`));
      resumeRetryAllSyncActivityIfRunning();
    }
  } else {
    stopSyncActivityRefresh();
  }
  if (state.activeView === "manualWatchReview") {
    renderManualWatchReviewPage();
    if (state.token) loadManualWatchReview().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView !== "explorer") {
    state.explorerLoadObserver?.disconnect();
    state.explorerLoadObserver = undefined;
    updateAlphaFilter();
  }

  if (state.activeView !== "history") {
    state.historyViewLoadObserver?.disconnect();
    state.historyViewLoadObserver = undefined;
  }
  if (state.activeView !== "dashboard") {
    state.partWatchedLoadObserver?.disconnect();
    state.partWatchedLoadObserver = undefined;
  }

  if (state.activeView !== "dashboard") {
    state.dashboardPosterObserver?.disconnect();
    state.dashboardPosterObserver = undefined;
  }

  // The topbar (title, back button, and which control group is mounted) is
  // derived state, so it has to be recomputed for every view change. popstate
  // reaches this function without going through selectView, so without this the
  // browser's own back button left the previous view's control bar in place.
  syncPageTopbar();

  const showMediaAppearance = Boolean(state.mediaDetailInline) && !window.location.pathname.startsWith("/person/");
  const showSidebarAppearance = true;
  if (elements.sidebarAppearanceWrap) {
    elements.sidebarAppearanceWrap.classList.toggle("hidden", !showSidebarAppearance);
    if (!showSidebarAppearance) {
      elements.sidebarAppearancePanel?.classList.add("hidden");
      elements.sidebarAppearanceButton?.setAttribute("aria-expanded", "false");
    }
  }
  elements.sidebarAppearanceMediaGroup?.classList.toggle("hidden", !showMediaAppearance);

  if (state.activeView === "settings") {
    renderSettingsInlineHelp();
    const rawPath = typeof url === "string" ? url : (window.location.pathname + window.location.hash);
    const route = parseSettingsRoute(rawPath, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsRoute = route;
    state.activeSettingsTab = route.group;
    localStorage.setItem(ACTIVE_SETTINGS_TAB_KEY, route.group);
    applySettingsRoute(route);
    refreshTautulliImport();
    // Cheap, network-free repaint of the Trakt Plex notes now the saved config
    // is available; refreshTrackerSettings() runs once at startup and can land
    // before it.
    refreshTrackerPolicyNotes();
    // A route can aggregate several panels at once (a parent group's page),
    // so gate each panel's loader on whether it appears anywhere in the
    // route's views, not just the primary/first one.
    const routePanels = new Set((route.views?.length ? route.views : [{ panel: route.panel }]).map((view) => view.panel));
    if (routePanels.has("apps")) renderMediaServerCards();
    if (routePanels.has("api-keys")) renderMetadataCards();
    if (routePanels.has("sync")) {
      renderSyncHistory();
      loadSyncHistory({ maxAgeMs: 5000 }).catch((error) => setMessage(error.message, "error"));
    }
    if (routePanels.has("backups")) {
      state.activeBackupsTab = route.backupTab || "settings";
      renderWatchBackups();
      renderPlektBackups();
      // The remote listing feeds both the Remote Watch History card's storage count
      // and the Remote Restore list, and it needs the backup status (destinations)
      // first - chain it behind loadWatchBackups so a cold direct link to any
      // backups route (including the aggregated group page) still populates it.
      loadWatchBackups()
        .then(() => {
          const jobs = [];
          if (!state.remoteBackupFilesLoading && !state.remoteBackupFiles.length) {
            jobs.push(loadRemoteBackupsForRestoreTab());
          }
          if (!state.remotePlektBackupFilesLoading && !state.remotePlektBackupFiles.length) {
            jobs.push(loadRemotePlektBackupsForRestoreTab());
          }
          return Promise.all(jobs);
        })
        .catch((error) => setMessage(error.message, "error"));
      loadPlektBackups().catch((error) => setMessage(error.message, "error"));
    }
    if (routePanels.has("tools")) loadWipeDataPreview().catch((error) => setMessage(error.message, "error"));
    if (routePanels.has("logs")) renderLogs().catch(() => { });
    if (routePanels.has("changelog")) renderChangelog().catch(() => { });
    if (routePanels.has("cache")) {
      renderCachePanel();
      if (!state.cacheStats && !state.cacheStatsLoading) loadCacheStats().catch((error) => setMessage(error.message, "error"));
    }
    if (state.configLoaded) {
      renderSettingsStatus("Configuration ready.", "success");
    }
  }
  syncPageTopbar();
  syncLogsRefresh();

  if (state.token) {
    syncNowPlayingPolling();
  }
}

function renderSettingsStatus(text, tone = "muted") {
  if (!elements.settingsStatus) return;
  elements.settingsStatus.textContent = text;
  elements.settingsStatus.dataset.tone = tone;
}

function renderAdminCredentialsStatus(text, tone = "muted") {
  if (!elements.adminCredentialsStatus) return;
  elements.adminCredentialsStatus.textContent = text;
  elements.adminCredentialsStatus.dataset.tone = tone;
}

async function saveAdminCredentials() {
  if (isDemoMode()) {
    renderAdminCredentialsStatus("Demo settings are read-only.", "muted");
    return;
  }
  const username = elements.settingsUsername.value.trim();
  const currentPassword = elements.currentAdminPassword.value;
  const newPassword = elements.newAdminPassword.value;
  const confirmPassword = elements.confirmAdminPassword.value;

  if (!username || !currentPassword) {
    renderAdminCredentialsStatus("Enter a username and your current password.", "error");
    return;
  }
  if (newPassword && newPassword.length < 8) {
    renderAdminCredentialsStatus("New password must be at least 8 characters.", "error");
    return;
  }
  if (newPassword !== confirmPassword) {
    renderAdminCredentialsStatus("New password and confirmation do not match.", "error");
    return;
  }

  const button = elements.saveAdminCredentialsButton;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  renderAdminCredentialsStatus("Updating login...", "muted");

  try {
    const result = await updateAdminCredentials({ username, currentPassword, newPassword });
    state.currentUser = result.user;
    state.token = result.token;
    elements.adminEmail.value = username;
    elements.currentAdminPassword.value = "";
    elements.newAdminPassword.value = "";
    elements.confirmAdminPassword.value = "";
    localStorage.setItem("adminUsername", username);
    renderAdminCredentialsStatus("Login updated. Other dashboard sessions have been signed out.", "success");
    setMessage(`Login updated for ${username}.`, "success");
    // Re-check whether the default-password flag has been cleared.
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then(r => r.json()).then(data => {
        if (state.mustChangePassword && !data.mustChangePassword) {
          state.mustChangePassword = false;
          applyMustChangePassword();
        }
      }).catch(() => {});
  } catch (error) {
    renderAdminCredentialsStatus(error.message, "error");
    setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function loadSavedConfig() {
  // Applying config to the settings-specific sync controls is owned by their
  // route initializers. Fetch in parallel with the document-wide shell, but do
  // not pull tracker/rating/watchlist modules into every authenticated route.
  const [response] = await Promise.all([
    fetch("/api/config", { headers: authHeaders() }),
    ensureShellModules(),
  ]);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Config load failed with ${response.status}`);

  state.savedConfig = body.config || {};
  // A direct Settings deep link can finish its config request before the
  // route graph has initialized. Ensure the settings renderer owns this
  // config before applying it, rather than silently applying a no-op.
  if (state.activeView === "settings") await loadRouteModule("settings-services");
  refreshTautulliImport();
  state.lastCron = body.lastCron;
  state.lastWebhook = body.lastWebhook;
  state.syncHistory = Array.isArray(body.history) ? body.history : state.syncHistory;
  state.syncHistoryLoaded = Array.isArray(body.history);
  applyConfigToSettingsUi(body.config || {});
  applyDemoSettingsReadOnly();
  state.configLoaded = true;
  // Settings-only modules may already have initialized while a direct Settings
  // route was loading. Let them apply the now-authoritative config without
  // importing those modules into every route just for this fetch.
  document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
  state.posterLookupCache.clear();
  state.posterLookupInflight.clear();
  renderSettingsStatus("Configuration loaded.", "success");
  // These two reads both depend on the saved config having been applied, but
  // they do not depend on each other. Running them together removes one full
  // network round-trip from the post-auth configuration waterfall.
  await Promise.all([
    state.activeView !== "settings" ? refreshSeerrCapabilities().catch(() => null) : Promise.resolve(),
    loadAppearanceSettings().catch(() => null),
  ]);
  renderDashboard();
  renderActiveSessions();
  renderSyncHistory();
  refreshHelpIfVisible();
  return body.config || {};
}

const HISTORY_REUSE_MS = 5000;
async function loadHistory({ force = false, silent = false } = {}) {
  if (state.historyLoadPromise) return state.historyLoadPromise;

  state.historyLoadPromise = (async () => {
    if (!force && !silent) applyCachedDashboardHistory();

    const url = new URL("/api/history", window.location.origin);
    url.searchParams.set("limit", String(HISTORY_PREVIEW_LIMIT));
    url.searchParams.set("stats", "0");
    url.searchParams.set("preview", "dashboard");

    // The dashboard preview response is served with Cache-Control: max-age=30
    // so routine loads/polls can reuse the browser's HTTP cache. A forced
    // refresh (e.g. right after marking something watched) needs to bypass
    // that cache on read, or it can silently hand back a pre-mutation
    // response for up to 30s - the "watched" item would then be missing from
    // the dashboard's watch-history row until the cache naturally expired.
    // Using "reload" rather than "no-store" also re-populates the cache with
    // this fresh response: every dashboard-view entry runs an unforced
    // loadHistory() right after (see the "dashboard" branch above), and with
    // "no-store" that follow-up default-mode fetch could still hit the
    // stale pre-mutation entry left over from the page's original load and
    // silently undo the forced refresh.
    const response = await fetch(url, { headers: authHeaders(), cache: force ? "reload" : "default" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `History load failed with ${response.status}`);

    const previousHistoryVersion = state.historyVersion;
    state.history = Array.isArray(body.history) ? body.history : [];
    state.historyVersion = String(body.historyVersion ?? historyVersionFromRows(state.history));
    state.historyFetchedAt = Date.now();
    state.historyLoading = false;
    state.historyLoadError = "";
    rememberDashboardHistory(state.history, state.historyVersion);
    if (previousHistoryVersion && previousHistoryVersion !== state.historyVersion) {
      state.explorerPageCache.clear();
    }
    if (body.stats) {
      state.stats = body.stats;
      state.statsLoaded = true;
    }
    if (!silent) {
      renderDashboard();
      if (state.activeView === "discover") renderDiscover();
      if (state.activeView === "dashboard") {
        renderUpNext();
        loadUpNext({ force }).catch((error) => setMessage(error.message, "error"));
      }
      renderStats();
      if (state.activeView === "stats") loadStats({ force: true }).catch((error) => setMessage(error.message, "error"));
      if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "sync" && (!state.syncHistoryLoaded || (previousHistoryVersion && previousHistoryVersion !== state.historyVersion))) {
        loadSyncHistory({ force: state.syncHistoryLoaded }).catch((error) => setMessage(error.message, "error"));
      }
      renderDbStatus(true);
    }
    return state.history;
  })().finally(() => {
    state.historyLoadPromise = null;
  });

  return state.historyLoadPromise;
}

function clearDerivedUiCaches({ resetExplorer = true } = {}) {
  state.explorerPageCache.clear();
  // /api/show carries authoritative watched rows and dates, so the short
  // identity-keyed cache that collapses one page's duplicate lookups must not
  // outlive a mutation.
  state.showDetailCache.clear();
  state.showDetailAliases.clear();
  state.showDetailMisses.clear();
  clearPersistentExplorerPageCache();
  state.posterLookupCache.clear();
  state.posterLookupInflight.clear();
  clearPersistentPosterLookupCache();
  state.statsLoaded = false;
  // Keep the currently painted Up Next cards during a live refresh. The next
  // server snapshot can then animate watched/removed items out instead of
  // replacing the whole rail with an empty state first.
  resetUpNext({ preserveItems: state.activeView === "dashboard" });
  // History-version SSE events also reach Discover because its watched badges
  // are derived from the same local history. Keep the current rails painted
  // while that history snapshot is refreshed; a discovery-cache SSE event
  // will request the new TMDB payload separately.
  if (state.activeView !== "discover") resetDiscover();
  if (resetExplorer) {
    resetMovieExplorer();
    resetShowExplorer();
  }
}

let isBackgroundSyncing = false;
let syncIdleGraceTimer = null;
const SYNC_IDLE_GRACE_MS = 3000;
let lastReportedSyncCompleted = 0;
let lastReportedSyncActive = false;

function isAnySyncRunning() {
  return isBackgroundSyncing || Boolean(state.fullSyncActive) || isSyncProgressActive();
}

function renderSyncProgress({ total = 0, completed = 0, active = false, label = "", currentItemLabel = "", startupScanActive = false } = {}) {
  const syncing = Boolean(active) || (total > 0 && completed < total);
  state.syncProgress = { active: syncing, total, completed, label, currentItemLabel, startupScanActive };
  syncActiveMediaDetailState();
  const normalizedCompleted = Math.max(Number(completed) || 0, 0);
  const completedItem = normalizedCompleted > lastReportedSyncCompleted;
  const finishedSync = lastReportedSyncActive && !syncing;
  lastReportedSyncCompleted = normalizedCompleted;
  lastReportedSyncActive = syncing;

  // A long sync runs as a sequence of small batches with brief idle gaps
  // between them (one batch finishes, completed>=total, before the next
  // batch's progress event arrives). Flipping isBackgroundSyncing false
  // during those gaps let queueLiveHistoryRefresh's guard miss them, so a
  // continuous multi-batch sync could still rebuild the explorer grid (full
  // reset + refetch, not an in-place patch) close to once a second for its
  // whole duration - visible as ongoing flicker even after the 1s debounce.
  // Keep isBackgroundSyncing true through a short grace window after the
  // last "still going" event so a same-sync follow-up batch doesn't reopen
  // the gap; only treat it as genuinely finished once nothing has reported
  // progress for the whole window.
  if (syncing) {
    isBackgroundSyncing = true;
    if (syncIdleGraceTimer) { window.clearTimeout(syncIdleGraceTimer); syncIdleGraceTimer = null; }
  } else if (isBackgroundSyncing && !syncIdleGraceTimer) {
    syncIdleGraceTimer = window.setTimeout(() => {
      syncIdleGraceTimer = null;
      isBackgroundSyncing = false;
      queueLiveHistoryRefresh({ immediate: true });
    }, SYNC_IDLE_GRACE_MS);
  }

  // The sidebar indicator is permanent: it reads "Sync - Idle" when nothing is
  // running, shows item counts for a known dispatch burst, and uses the
  // operation label for scans/imports whose total is not known yet.
  setSyncActivityProgress({ total, completed, active: syncing, label, currentItemLabel, startupScanActive });

  // Progress heartbeats only refresh this list when a completed item or the
  // finished run can have appended a sync-history row. The activity module
  // coalesces these requests and patches/reorders existing DOM rows in place.
  if (completedItem || finishedSync) queueSyncActivityRefresh({ immediate: finishedSync });
}

function handleSyncAttentionUpdate(summary = {}) {
  const previousCount = Number(state.syncAttentionCount) || 0;
  setSyncAttentionSummary(summary);
  // The SSE stream deliberately carries only the compact count/status. If the
  // attention page is already open, fetch the protected detail payload as soon
  // as a new blocker arrives instead of making the user wait for its periodic
  // refresh.
  const nextCount = Number(summary.count) || 0;
  if (state.activeView === "syncActivity" && !state.syncActivityPaused && nextCount > 0 && (!state.syncAttentionLoaded || previousCount !== nextCount)) {
    loadSyncAttention({ force: true }).catch((error) => logDebug(`Live sync attention refresh failed: ${error.message}`));
  }
}

let liveHistoryRefreshTimer = null;
let liveHistoryRefreshActive = false;
let liveHistoryRefreshQueued = false;
const pendingLiveHistoryChanges = new Map();
let liveHistoryFullRefreshQueued = false;
let activeDetailLivePatchPromise = Promise.resolve();
const activeDetailLiveAppliedChanges = new Map();

function liveHistoryChangeKey(change = {}) {
  return String(
    change.mediaKey
      ?? change.media_key
      ?? change.recordId
      ?? change.record_id
      ?? `${change.sourceTable || change.source_table || "change"}:${change.season ?? ""}:${change.episode ?? ""}`,
  ).trim();
}

// An open show detail should not wait for the sync-idle debounce before it
// reflects a watch-history SSE event. Queue these lightweight row patches
// independently of the broader dashboard/history refresh; the latter can
// still wait for the sync burst to settle without making the detail page look
// stuck on "Saving…".
function queueActiveDetailLivePatch(changes = []) {
  if (!state.activeShowRenderContext?.show || !Array.isArray(changes) || !changes.length) return;
  const detailChanges = changes.filter((change) => {
    const mediaType = String(change.mediaType || change.media_type || "").toLowerCase();
    return !mediaType || mediaType === "episode" || mediaType === "movie";
  });
  if (!detailChanges.length) return;
  activeDetailLivePatchPromise = activeDetailLivePatchPromise
    .catch(() => {})
    .then(async () => {
      const applied = await applyLiveHistoryChanges(detailChanges);
      if (applied < detailChanges.length) return;
      for (const change of detailChanges) {
        const key = liveHistoryChangeKey(change);
        if (key && pendingLiveHistoryChanges.get(key) === change) {
          activeDetailLiveAppliedChanges.set(key, change);
        }
      }
    })
    .catch((error) => logDebug(`Live detail item patch failed: ${error.message}`));
}

function queueLiveHistoryRefresh({ immediate = false, changes = [], fullRefresh = false } = {}) {
  const incomingChanges = Array.isArray(changes) ? changes.filter((change) => change && typeof change === "object") : [];
  for (const change of incomingChanges) {
    const key = liveHistoryChangeKey(change);
    if (key) pendingLiveHistoryChanges.set(key, change);
  }
  // A caller must explicitly request a full snapshot. The sync-idle grace
  // timer is only a drain point for changes already delivered by SSE; turning
  // an empty change list into a full refresh rebuilt the open detail page a
  // second time after the affected episode had already patched.
  if (fullRefresh) liveHistoryFullRefreshQueued = true;
  queueActiveDetailLivePatch(incomingChanges);
  if (incomingChanges.length || fullRefresh) refreshDashboardHistoryFromLive().catch((error) => logDebug(`Live dashboard history refresh failed: ${error.message}`));
  if (!pendingLiveHistoryChanges.size && !liveHistoryFullRefreshQueued) return;
  liveHistoryRefreshQueued = true;

  // Broader views wait for sync; dashboard history refreshes independently.
  if (!immediate && isAnySyncRunning()) {
    return;
  }

  if (immediate) {
    if (liveHistoryRefreshTimer) {
      window.clearTimeout(liveHistoryRefreshTimer);
      liveHistoryRefreshTimer = null;
    }
  } else if (liveHistoryRefreshTimer) {
    return;
  }

  // A background sync dispatches items in small bursts with brief gaps
  // between them, during which isAnySyncRunning() momentarily reads false -
  // the early-return guard above only catches calls that land while it's
  // true, so calls landing in those gaps still fall through to here and each
  // sets its own timer. At the old 350ms that let the explorer grid (full
  // reset + refetch) rebuild several times a second during a sync, which is
  // the flicker - 1000ms settles it to about once a second, matching the
  // Sync Activity page's fix for the same class of issue above.
  const delayMs = immediate ? 50 : 1000;

  liveHistoryRefreshTimer = window.setTimeout(() => {
    liveHistoryRefreshTimer = null;
    const drain = async () => {
      if (!immediate && isAnySyncRunning()) {
        liveHistoryRefreshQueued = true;
        return;
      }
      // Do not let the broader refresh race the direct in-place detail patch.
      // This also lets the dedupe below prevent a second replacement of the
      // same episode node after the SSE update has already painted it.
      while (true) {
        const detailPatch = activeDetailLivePatchPromise;
        await detailPatch;
        if (detailPatch === activeDetailLivePatchPromise) break;
      }
      if (!immediate && isAnySyncRunning()) {
        liveHistoryRefreshQueued = true;
        return;
      }
      if (liveHistoryRefreshActive) return;
      const changesToApply = [...pendingLiveHistoryChanges.values()];
      const fullRefresh = liveHistoryFullRefreshQueued;
      pendingLiveHistoryChanges.clear();
      const detailChangesAlreadyApplied = changesToApply.filter((change) => (
        activeDetailLiveAppliedChanges.get(liveHistoryChangeKey(change)) === change
      ));
      for (const change of changesToApply) activeDetailLiveAppliedChanges.delete(liveHistoryChangeKey(change));
      liveHistoryFullRefreshQueued = false;
      refreshLiveHistoryView({ changes: changesToApply, detailChangesAlreadyApplied, fullRefresh }).catch((error) => logDebug(`Live history refresh failed: ${error.message}`));
    };
    drain().catch((error) => logDebug(`Live history refresh drain failed: ${error.message}`));
  }, delayMs);
}

async function refreshLiveHistoryView({ changes = [], detailChangesAlreadyApplied = [], fullRefresh = false } = {}) {
  if (liveHistoryRefreshActive) return;
  liveHistoryRefreshActive = true;
  liveHistoryRefreshQueued = false;
  try {
    if (!fullRefresh && changes.length) {
      const reviewChanges = changes.filter((change) => String(change.sourceTable || change.source_table || "").toLowerCase() === "manual_watch_reviews");
      const historyChanges = changes.filter((change) => String(change.sourceTable || change.source_table || "").toLowerCase() !== "manual_watch_reviews");
      const appliedKeys = new Set(detailChangesAlreadyApplied.map(liveHistoryChangeKey));
      const historyChangesToApply = historyChanges.filter((change) => !appliedKeys.has(liveHistoryChangeKey(change)));
      if (historyChangesToApply.length) await applyLiveHistoryChanges(historyChangesToApply);
      if (reviewChanges.length) {
        const refreshReviews = state.activeView === "manualWatchReview"
          ? () => loadManualWatchReview()
          : () => loadManualWatchReviewSummary();
        await refreshReviews().catch((error) => {
          logDebug(`Background Manual Watch review refresh failed: ${error.message}`);
        });
      }
      // The dashboard Up Next rail is refreshed independently from the live
      // history callback so it is not held behind provider sync. Avoid a
      // second forced request here; this branch is still responsible for the
      // other history-derived views and their coalesced refresh.
      const hasPersonalChange = changes.some((change) => String(change.sourceTable || change.source_table || "") === "personal_watchlist");
      if (hasPersonalChange && isPersonalMediaView(state.activeView)) {
        await loadPersonalMedia({ force: true }).catch((error) => logDebug(`Background personal watchlist refresh failed: ${error.message}`));
      }
      if (state.activeView === "dashboard") refreshDashboardHistoryInPlace();
      if (state.activeView === "discover" && changes.some((change) => ["watch_history", "playstate"].includes(
        String(change.sourceTable || change.source_table || "").toLowerCase(),
      ))) {
        await loadDiscover({ fromSse: true }).catch((error) => logDebug(`Live Discover refresh failed: ${error.message}`));
      }
      if (state.activeView === "history") {
        await refreshHistoryViewInPlace().catch((error) => logDebug(`Background History refresh failed: ${error.message}`));
      }
      if (state.activeView === "explorer" && state.explorerMode === "movies") {
        await refreshMovieExplorerInPlace().catch((error) => logDebug(`Background Movies refresh failed: ${error.message}`));
      }
      if (state.activeView === "explorer" && state.explorerMode === "shows") {
        await refreshShowExplorerInPlace().catch((error) => logDebug(`Background TV Shows refresh failed: ${error.message}`));
      }
      if (state.activeView === "stats") {
        await loadStats({ force: true }).catch((error) => logDebug(`Background Stats refresh failed: ${error.message}`));
      }
      return;
    }
    if (!fullRefresh) return;
    clearDerivedUiCaches({ resetExplorer: false });
    // SSE only tells us that the shared data version changed. Fetch the
    // authoritative history/progress snapshots, then reconcile the visible
    // rows and refresh the preserved Up Next rail without a full page render.
    await loadHistory({ force: true, silent: true });
    if (state.activeView === "discover") {
      await loadDiscover({ fromSse: true }).catch((error) => logDebug(`Live Discover refresh failed: ${error.message}`));
    }
    if (isPersonalMediaView(state.activeView)) {
      await loadPersonalMedia({ force: true }).catch((error) => logDebug(`Background personal watchlist refresh failed: ${error.message}`));
    }
    if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "sync") {
      refreshWatchlistSyncStatus().catch((error) => logDebug(`Background watchlist status refresh failed: ${error.message}`));
    }
    // An open movie/show detail page holds its own fetched record, so a removed
    // or added watch date stays on screen until it is re-rendered from the
    // reloaded history above.
    await refreshActiveDetailView().catch((error) => logDebug(`Live detail refresh failed: ${error.message}`));
    if (state.activeView === "history") {
      await refreshHistoryViewInPlace().catch((error) => logDebug(`Background History refresh failed: ${error.message}`));
    }
    if (state.activeView === "explorer" && !state.mediaDetailInline) {
      const refreshExplorer = state.explorerMode === "shows" ? refreshShowExplorerInPlace : refreshMovieExplorerInPlace;
      await refreshExplorer().catch((error) => logDebug(`Background library refresh failed: ${error.message}`));
    }
    if (state.activeView === "stats") {
      await loadStats({ force: true }).catch((error) => logDebug(`Background Stats refresh failed: ${error.message}`));
    }
    const upNextRefresh = state.activeView === "dashboard"
      ? loadUpNext({ fromSse: true }).catch((error) => {
        logDebug(`Background Up Next refresh failed: ${error.message}`);
      })
      : null;
    if (state.activeView === "dashboard") refreshDashboardHistoryInPlace();
    await upNextRefresh;
  } finally {
    liveHistoryRefreshActive = false;
    if ((pendingLiveHistoryChanges.size || liveHistoryFullRefreshQueued) && !isAnySyncRunning()) {
      queueLiveHistoryRefresh();
    } else if (!pendingLiveHistoryChanges.size && !liveHistoryFullRefreshQueued) {
      liveHistoryRefreshQueued = false;
    }
  }
}

function renderDbStatus(isOnline) {
  if (!elements.dbStatus) return;
  elements.dbStatus.innerHTML = `
    <span class="target-pill" data-status="${isOnline ? "success" : "error"}">${isOnline ? "Connected" : "Unavailable"}</span>
    <p>Total rows visible to this query: ${formatNumber(state.stats.totalWatches || 0)}</p>
    <p>Backend store: <code>SQLite</code></p>
  `;
}



async function renderLogs(forceScrollToBottom = false) {
  if (!elements.logsTerminal) return;

  const isInitialLoad = !state.hasLoadedLogsOnce;
  state.hasLoadedLogsOnce = true;

  const localLogs = logsText();
  const category = state.activeLogCategory || "all";

  // The frontend debug log is a flat browser-activity trail with no server-side
  // category of its own, so it only genuinely belongs under "All" and "System" -
  // showing it under Plex WebSockets/Outbound Sync/Scheduled Polls made every tab
  // look identical, since tab switches force-scroll to the bottom of this section.
  const includeFrontendSection = category === "all" || category === "system";

  try {
    const backendLogs = await fetchDiagnosticLogs(authHeaders(), category);
    if (backendLogs.length > 0 || includeFrontendSection) {
      const visibleBackendLogs = backendLogs.slice(-250);
      const visibleFrontendLogs = includeFrontendSection && localLogs ? localLogs.split("\n").slice(-50) : [];
      const allLogs = [
        `=== BACKEND DIAGNOSTIC LOGS (${category.toUpperCase()}) ===`,
        ...backendLogs,
        ...(includeFrontendSection ? ["", "=== FRONTEND DEBUG LOGS ===", localLogs || "[no frontend logs]"] : [])
      ].join("\n");
      state.renderedLogsText = allLogs;

      const htmlLines = [
        `<div class="log-section-header">=== BACKEND DIAGNOSTIC LOGS (${escapeHtml(category.toUpperCase())}) - showing latest ${visibleBackendLogs.length} of ${backendLogs.length} ===</div>`,
        ...(visibleBackendLogs.length ? visibleBackendLogs.map(formatLogLineToHtml) : ['<div class="log-row"><span class="log-msg" style="opacity: 0.6;">[no backend logs for this category]</span></div>']),
        ...(includeFrontendSection ? [
          `<div class="log-section-header" style="margin-top: 1rem;">=== FRONTEND DEBUG LOGS ===</div>`,
          ...(visibleFrontendLogs.length ? visibleFrontendLogs.map(formatLogLineToHtml) : ['<div class="log-row"><span class="log-msg" style="opacity: 0.6;">[no frontend logs]</span></div>'])
        ] : [])
      ].join("");

      elements.logsTerminal.innerHTML = htmlLines;
    } else {
      state.renderedLogsText = localLogs || `[no diagnostic logs captured yet for category: ${category}]`;
      elements.logsTerminal.innerHTML = `<div class="log-row"><span class="log-msg" style="opacity: 0.6;">${escapeHtml(state.renderedLogsText)}</span></div>`;
    }
  } catch (error) {
    state.renderedLogsText = localLogs || "[no diagnostic logs captured yet]";
    elements.logsTerminal.innerHTML = `<div class="log-row"><span class="log-msg" style="opacity: 0.6;">${escapeHtml(state.renderedLogsText)}</span></div>`;
  }

  const el = elements.logsTerminal;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (forceScrollToBottom || isInitialLoad || atBottom) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

function syncLogsRefresh() {
  const shouldRefresh = state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs" && state.token;
  if (shouldRefresh && !state.logsRefreshInterval) {
    if (!state.hasLoadedLogsOnce) renderLogs(true).catch(() => { });
    state.logsRefreshInterval = window.setInterval(() => {
      if (state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs") {
        renderLogs().catch(() => { });
      }
    }, 3000);
  } else if (!shouldRefresh) {
    if (state.logsRefreshInterval) {
      window.clearInterval(state.logsRefreshInterval);
      state.logsRefreshInterval = undefined;
    }
    state.hasLoadedLogsOnce = false;
  }
}

function refreshHelpIfVisible() {}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

async function unlockWithToken(password, email = elements.adminEmail?.value) {
  const cleanEmail = String(email || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanEmail || !cleanPassword) {
    setMessage("Enter your admin username and password.", "error");
    return;
  }

  const result = await signInAdmin(cleanEmail, cleanPassword);
  state.currentUser = result.user;
  state.token = result.token;
  if (elements.settingsUsername) elements.settingsUsername.value = cleanEmail;
  localStorage.setItem("adminUsername", cleanEmail);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  setUnlocked(true);
  selectView(state.activeView);
  await loadHistory().catch((error) => {
    renderDbStatus(false);
    setMessage(`${error.message} Signed in, but dashboard APIs are not responding yet.`, "error");
  });
  await loadSavedConfig().catch((error) => {
    renderSettingsStatus(error.message, "error");
    setMessage(error.message, "error");
  });
  const fullPath = window.location.pathname + window.location.search + window.location.hash;
  if (isConfigSensitiveRoute(fullPath)) {
    handleRouting(fullPath);
    applyActiveView();
  }
  startHistoryPolling();
  setMessage("Dashboard unlocked.", "success");
}

async function lockDashboard() {
  stopHistoryPolling();
  resetUpNext();
  resetDiscover();
  resetPersonalMedia();
  state.token = "";
  state.currentUser = undefined;
  state.history = [];
  state.historyVersion = "";
  state.historyFetchedAt = 0;
  state.activeSessions = [];
  state.syncJobs = [];
  state.syncJobsLoaded = false;
  state.syncHistory = [];
  state.syncHistoryLoaded = false;
  state.syncActivity = [];
  state.syncActivityLoaded = false;
  state.syncActivityLoading = false;
  state.syncActivityPaused = false;
  state.syncActivitySearch = "";
  state.manualWatchReviews = [];
  state.manualWatchReviewCount = 0;
  state.manualWatchReviewLoaded = false;
  state.manualWatchReviewLoading = false;
  state.manualWatchReviewError = "";
  state.manualWatchReviewSearch = "";
  stopManualWatchReviewPolling();
  stopStatusSummaryPolling();
  renderManualWatchReviewSummary();
  clearClientAttention();
  state.syncAttention = [];
  state.syncAttentionCount = 0;
  state.syncAttentionStatus = "clear";
  state.syncAttentionSeverity = "clear";
  state.syncAttentionLoaded = false;
  state.syncAttentionError = "";
  state.syncAttentionSkipping = "";
  state.syncAttentionIssueSkipping = "";
  state.syncAttentionIssueRetrying = "";
  state.syncAttentionIssueRetryTerminal = null;
  state.syncAttentionExpandedShows = new Set();
  state.syncAttentionShowSkipping = "";
  state.syncAttentionShowRetrying = "";
  state.syncAttentionShowRetryTerminal = null;
  state.clientAttentionRetrying = "";
  if (elements.syncActivitySearch) elements.syncActivitySearch.value = "";
  state.syncActivityPagination = { page: 1, limit: 25, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: false, hasNext: false };
  state.importRecords = [];
  state.importFileNames = [];
  state.importLogs = ["[idle] Waiting for files."];
  state.importProgressValue = 0;
  state.nowPlayingRefreshToken = "";
  state.nowPlayingSessionKey = "";
  state.nowPlayingLastFetchAt = 0;
  state.configLoaded = false;
  state.savedConfig = {};
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_UPPER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  await signOutAdmin().catch(() => { });
  elements.adminToken.value = "";
  if (elements.settingsUsername) elements.settingsUsername.value = "";
  applyConfigToSettingsUi({});
  applyRatingSyncConfig({});
  applyWatchlistSyncConfig({});
  renderDashboard();
  renderActiveSessions();
  renderSyncHistory();
  renderSyncActivity();
  renderStats();
  renderImportPreview();
  renderDbStatus(false);
  renderSettingsStatus("Configuration cleared from the unlocked session.");
  refreshHelpIfVisible();
  setUnlocked(false);
  setMessage("Dashboard locked.");
}


function showConfirmModal(message, onApprove, options = {}) {
  if (!elements.confirmModal || !elements.confirmModalMessage) return;

  const titleEl = document.getElementById("confirmModalTitle") || elements.confirmModal.querySelector("h2");
  if (titleEl) {
    titleEl.textContent = options.title || "Confirm Sync";
  }
  elements.confirmModal.classList.remove("confirm-modal--error");
  const cancelBtn = elements.cancelConfirmButton;
  if (cancelBtn) cancelBtn.style.display = "";

  elements.approveConfirmButton.textContent = options.approveLabel || "Approve";

  if (elements.confirmModalMedia) {
    if (options.mediaHtml) {
      elements.confirmModalMedia.innerHTML = options.mediaHtml;
      elements.confirmModalMedia.classList.remove("hidden");
    } else {
      elements.confirmModalMedia.innerHTML = "";
      elements.confirmModalMedia.classList.add("hidden");
    }
  }

  elements.confirmModalMessage.textContent = message;
  elements.confirmModal.classList.remove("hidden");

  // Remove existing listeners to avoid multiple triggers
  const newApproveButton = elements.approveConfirmButton.cloneNode(true);
  elements.approveConfirmButton.parentNode.replaceChild(newApproveButton, elements.approveConfirmButton);
  elements.approveConfirmButton = newApproveButton;

  elements.approveConfirmButton.addEventListener("click", () => {
    elements.confirmModal.classList.add("hidden");
    onApprove();
  });
}

function showErrorExplainModal(title, errorMsg) {
  if (!elements.confirmModal || !elements.confirmModalMessage) return;

  const titleEl = document.getElementById("confirmModalTitle") || elements.confirmModal.querySelector("h2");
  if (titleEl) {
    titleEl.textContent = title;
  }

  if (elements.confirmModalMedia) {
    elements.confirmModalMedia.innerHTML = "";
    elements.confirmModalMedia.classList.add("hidden");
  }

  let resolutionInstructions = "";
  const displayError = String(errorMsg || "").trim() || "The request could not be completed.";
  const errLower = displayError.toLowerCase();

  if (errLower.includes("not found") || errLower.includes("404")) {
    resolutionInstructions = "This item could not be found on the target media server. Ensure the server is running, the item exists in its library, and its metadata (IMDB, TMDB, or TVDB IDs) is matched and synchronized.";
  } else if (errLower.includes("unauthorized") || errLower.includes("401") || errLower.includes("forbidden") || errLower.includes("key") || errLower.includes("token")) {
    resolutionInstructions = "Authentication failed. Check the app under Settings and verify that the server URL, API key, user ID, or access token is correct and still valid.";
  } else if (errLower.includes("timeout") || errLower.includes("refused") || errLower.includes("network") || errLower.includes("fetch") || errLower.includes("connect")) {
    resolutionInstructions = "The media server could not be reached. Verify that it is online and reachable from Plekt, and check that no firewall or proxy is blocking the request.";
  } else {
    resolutionInstructions = "Check Settings → Logs for a detailed traceback, then test the media server credentials under Settings → Media Servers.";
  }

  elements.confirmModal.classList.add("confirm-modal--error");
  elements.confirmModalMessage.innerHTML = `
    <div class="confirm-modal-error-summary" role="alert">
      <span class="confirm-modal-error-mark" aria-hidden="true">!</span>
      <span class="confirm-modal-error-detail">${escapeHtml(displayError)}</span>
    </div>
    <div class="confirm-modal-resolution">
      <h3>How to resolve</h3>
      <p>${escapeHtml(resolutionInstructions)}</p>
    </div>`;

  const cancelBtn = elements.cancelConfirmButton;
  if (cancelBtn) cancelBtn.style.display = "none";

  const approveBtn = elements.approveConfirmButton;
  if (approveBtn) {
    approveBtn.textContent = "OK";
    const newApproveBtn = approveBtn.cloneNode(true);
    approveBtn.parentNode.replaceChild(newApproveBtn, approveBtn);
    elements.approveConfirmButton = newApproveBtn;
    newApproveBtn.addEventListener("click", () => {
      elements.confirmModal.classList.add("hidden");
      if (cancelBtn) cancelBtn.style.display = "";
      newApproveBtn.textContent = "Approve";
      if (titleEl) titleEl.textContent = "Confirm Sync";
    });
  }

  elements.confirmModal.classList.remove("hidden");
}

function primeSensitiveRouteState(path = "") {
  const pathname = path.split("?")[0].split("#")[0];
  if (pathname === "/about" || pathname === "/settings/about") {
    state.activeView = "about";
    if (pathname === "/settings/about") history.replaceState(history.state, "", "/about");
    return true;
  }
  if (pathname === "/sync" || pathname === "/logs" || pathname.startsWith("/settings")) {
    state.activeView = "settings";
    state.activeSettingsRoute = parseSettingsRoute(pathname, { mustChangePassword: state.mustChangePassword });
    state.activeSettingsTab = state.activeSettingsRoute.group;
    return true;
  }
  if (pathname === "/setup") {
    state.activeView = "setup";
    return true;
  }
  if (pathname === "/manual-watch-review") {
    state.activeView = "manualWatchReview";
    return true;
  }
  if (pathname === "/discover") {
    state.activeView = "discover";
    return true;
  }
  if (pathname === "/watchlist" || pathname === "/ratings" || pathname === "/playlists" || pathname === "/custom-lists") {
    if (pathname === "/custom-lists") history.replaceState(history.state, "", "/playlists");
    state.activeView = pathname === "/custom-lists" ? "playlists" : pathname.slice(1);
    state.personalMediaTab = state.activeView === "playlists" ? "lists" : state.activeView;
    return true;
  }
  // These branches mark the detail as already open, which means the matching
  // handleRouting branch skips its own "where did I come from" capture. Record
  // the return context here too, or Back falls through to the defaults in
  // state.js and sends a directly loaded show page to the movies library.
  if (pathname.startsWith("/movie/")) {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    state.mediaDetailReturnView = "explorer";
    state.mediaDetailReturnExplorerMode = "movies";
    return true;
  }
  if (pathname.startsWith("/tvshow/")) {
    state.activeView = "explorer";
    state.explorerMode = "shows";
    state.mediaDetailInline = true;
    state.mediaDetailReturnView = "explorer";
    state.mediaDetailReturnExplorerMode = "shows";
    return true;
  }
  if (pathname.startsWith("/person/")) {
    state.activeView = "explorer";
    state.explorerMode = "movies";
    state.mediaDetailInline = true;
    return true;
  }
  if (pathname.startsWith("/search")) {
    state.activeView = "search";
    return true;
  }
  return false;
}

// After a manual watch/unwatch, re-render the visible page and reload the data
// behind it, so Discover and the personal-media pages cannot keep stale state.
function renderActiveViewAfterWatch() {
  if (state.activeView === "dashboard") {
    renderDashboard();
    renderUpNext();
    loadUpNext().catch((error) => setMessage(error.message, "error"));
  }
  if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
  if (state.activeView === "history") renderHistoryView();
  if (state.activeView === "discover") {
    renderDiscover();
    loadDiscover().catch((error) => setMessage(error.message, "error"));
    renderPersonalMedia();
    loadPersonalMedia().catch((error) => setMessage(error.message, "error"));
  }
  if (isPersonalMediaView(state.activeView)) {
    renderPersonalMedia();
    loadPersonalMedia({ force: true }).catch((error) => setMessage(error.message, "error"));
  }
}

// Compact status summaries (sidebar badges and Manual Watch review count) need
// a signed-in token. Sign-in and the first idle slot arrive in either order,
// so both call this; it runs once per token. Full status pages stay route-scoped.
let deferredStatusToken = "";
function startDeferredStatusWork() {
  if (!state.token || isDemoMode()) return;
  if (deferredStatusToken === state.token) return;
  deferredStatusToken = state.token;
  const token = state.token;
  const routeStatusModules = state.activeView === "dashboard" ? ["poster-menu"] : [];
  loadRouteModules([...SHELL_ROUTE_MODULES, ...routeStatusModules])
    .then(() => {
      if (state.token !== token) return null;
      startStatusSummaryPolling();
      return Promise.all([
        loadManualWatchReviewSummary(),
        loadSyncAttentionSummary(),
      ]);
    })
    .catch((error) => {
      // Allow a later sign-in or idle pass to retry a failed module fetch.
      if (deferredStatusToken === token) deferredStatusToken = "";
      logDebug(`Deferred status startup failed: ${error?.message || error}`);
    });
}

function initialize() {
  try {
    history.scrollRestoration = "manual";
  } catch { }
  bindElements();
  installEarlyActivationCapture();
  initSupervisorSwitch();
  prepareSettingsShell();
  // sync.js and dashboard.js are core modules that store these callbacks at
  // startup. Functions from the deferred graph are passed as wrappers so each
  // call reads the current binding instead of the startup placeholder.
  initSync({
    logDebug,
    loadHistory,
    resetPartWatchedView: live(() => resetPartWatchedView),
    renderPartWatched: live(() => renderPartWatched),
    setMessage,
    updateDashboardSplitState: live(() => updateDashboardSplitState),
    renderUpNext: live(() => renderUpNext),
    nowPlayingHref,
    clearDerivedUiCaches,
    renderDashboard: live(() => renderDashboard),
    renderStats: (...args) => renderStats(...args),
    loadSyncJobs,
    loadSyncHistory,
    renderExplorer: (...args) => renderExplorer(...args),
    renderHistoryView: (...args) => renderHistoryView(...args),
    renderImmersiveShowModal: (...args) => renderImmersiveShowModal(...args),
    showToast,
    showConfirmModal,
    queueLiveHistoryRefresh,
  });
  loadAppVersion();
  bootstrapTokenFromUrl();
  const initialPath = window.location.pathname + window.location.search + window.location.hash;
  if (isConfigSensitiveRoute(initialPath)) {
    primeSensitiveRouteState(initialPath);
  } else {
    handleRouting(initialPath);
  }
  applyAppearanceToBody(APPEARANCE_DEFAULTS);
  applyDemoUiRestrictions(false);
  elements.adminEmail.value = isDemoMode() ? "demo" : (localStorage.getItem("adminUsername") || "");
  elements.adminToken.value = isDemoMode() ? "demo" : "";
  elements.settingsUsername.value = elements.adminEmail.value;
  applyActiveView();
  applyConfigToSettingsUi({});
  renderDashboard();
  renderActiveSessions();
  renderWatchBackups();
  renderPlektBackups();
  renderDbStatus(false);
  renderSettingsStatus("Configuration not loaded yet.");

  onAuthChange((user, token, mustChangePassword, claimRequired) => {
    state.authReady = true;
    state.claimRequired = claimRequired === true;
    state.mustChangePassword = mustChangePassword === true;
    state.currentUser = user || undefined;
    state.token = token || "";
    if (user && token) {
      if (!isDemoMode()) {
        startLiveUpdates({
          authHeaders,
          onResume: () => {
            if (state.token) queueLiveHistoryRefresh({ immediate: true, fullRefresh: true });
          },
          onHistoryVersion: (version, { changes = [], reconnect = false } = {}) => {
            const upNextRelevantChange = changes.length === 0 || changes.some((change) => ["watch_history", "playstate", "playback_progress"].includes(
              String(change.sourceTable || change.source_table || "").toLowerCase(),
            ));
            if (upNextRelevantChange && state.activeView === "dashboard") {
              // The broader history refresh waits for an active sync to go
              // idle, but the local Up Next rail is derived from the same
              // canonical write that just produced this event. Refresh it
              // independently so provider delivery cannot leave the browser
              // showing a stale rail for the duration of a long sync.
              loadUpNext({ fromSse: true }).catch((error) => logDebug(`Live Up Next history refresh failed: ${error.message}`));
            }
            // A reconnect (tab shown again, wake from sleep) reports that data
            // changed while this tab was not listening, without saying what.
            // Reload every visible list instead of dropping the empty change set.
            queueLiveHistoryRefresh({ changes, fullRefresh: reconnect });
            if (state.activeView === "syncActivity") queueSyncActivityRefresh();
          },
          onUpNextVersion: (version, { initial = false } = {}) => {
            const normalized = Number(version);
            if (!Number.isFinite(normalized)) return;
            const previous = Number(state.upNextVersion || 0);
            state.upNextVersion = normalized;
            // The deferred dashboard load handles the first snapshot. Only a
            // later queue change refreshes even when paired with history.
            if (!initial && previous !== normalized && state.activeView === "dashboard") {
              loadUpNext({ fromSse: true }).catch((error) => logDebug(`Live Up Next refresh failed: ${error.message}`));
            }
          },
          onDiscoverVersion: (version, { initial = false } = {}) => {
            const previous = Number(state.discoverVersion || 0);
            state.discoverVersion = Number(version) || 0;
            if (initial || previous !== state.discoverVersion) {
              state.discoverLoadedAt = 0;
              if (state.activeView === "discover") {
                loadDiscover({ fromSse: true }).catch((error) => logDebug(`Live Discover refresh failed: ${error.message}`));
              }
            }
          },
          onSyncProgress: renderSyncProgress,
          onSyncAttention: handleSyncAttentionUpdate,
          onError: (error) => logDebug(`Live update connection interrupted: ${error.message}`),
        });
        // Runs once per token, whichever of sign-in and the post-paint idle pass comes first.
        scheduleDeferredStartupWork(startDeferredStatusWork);
      }
      for (const [key, value] of state.posterLookupCache.entries()) {
        if (!value) state.posterLookupCache.delete(key);
      }
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("plembfin:posterLookupCache:v2")) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const cleaned = parsed.filter(item => item.url);
                localStorage.setItem(key, JSON.stringify(cleaned));
              }
            }
          }
        }
      } catch (e) { }

    }
    if (user && token && !state.configLoaded) {
      const fullPath = window.location.pathname + window.location.search + window.location.hash;
      elements.settingsUsername.value = user.username || user.email || "";
      localStorage.setItem("adminUsername", user.email || "");
      setUnlocked(true);
      applyMustChangePassword();
      if (!isDemoMode() && !state.mustChangePassword && fullPath !== "/setup") {
        // Onboarding no longer force-navigates here on every load/refresh - it
        // only redirected once and left no way back except finishing the whole
        // wizard. loadSetupStatus() renders the persistent, dismissible
        // "Finish Setup" sidebar entry point instead (see
        // renderSidebarOnboardingCta() in onboarding.js).
        // Keep the large wizard graph out of the first authenticated render: a
        // real timeout (an idle callback can fire at once and erase the route
        // split), then the compact status, and the wizard only if setup is
        // unfinished or its dashboard checklist has items.
        window.setTimeout(() => {
          if (!state.token || state.mustChangePassword) return;
          const failed = (error) => logDebug(`Deferred onboarding check failed: ${error.message}`);
          if (isRouteModuleLoaded("onboarding")) return void loadSetupStatus().catch(failed);
          fetch("/api/setup/status", { headers: authHeaders(), cache: "no-store" })
            .then((res) => res.json().catch(() => ({})).then((data) => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
              const onboarding = data?.onboarding || {};
              const done = onboarding.runState === "completed" || onboarding.ctaDismissedAt || data?.servers?.some((server) => server.tested);
              if (ok && done && !data?.checklist?.length) return;
              return loadRouteModule("onboarding").then(() => loadSetupStatus());
            })
            .catch(failed);
        }, 1800);
      }
      if (isConfigSensitiveRoute(fullPath) && !state.mustChangePassword) {
        primeSensitiveRouteState(fullPath);
        applyActiveView();
        const isMediaDetailPath = fullPath.startsWith("/movie/") || fullPath.startsWith("/tvshow/");
        if (isMediaDetailPath) {
          // A direct detail reload has no in-memory history yet. Reuse the
          // short-lived local dashboard snapshot synchronously so the detail
          // renderer can show every known watched row while the authoritative
          // history request and provider metadata revalidate in the background.
          applyCachedDashboardHistory();
          loadHistory({ silent: true }).catch((error) => logDebug(`Initial detail history load failed: ${error.message}`));
        }
        // Paint the media detail immediately using local data (e.g. /api/show)
        // instead of waiting for loadSavedConfig() - which is three sequential
        // round-trips (/api/config → /api/seerr/status → /api/appearance). The
        // local show record (title, poster, episodes, progress) needs no config,
        // so rendering now removes the blank flash on a direct load/refresh. The
        // post-config handleRouting below re-renders to layer in TMDB/IMDb data.
        handleRouting(fullPath);
      } else {
        selectView(state.activeView);
      }
      const configDelay = isConfigSensitiveRoute(fullPath) ? 250 : STARTUP_DEFERRED_WORK_TIMEOUT_MS;
      scheduleDeferredStartupWork(() => loadSavedConfig()
        .then(() => {
          // Config loading can finish after the user has already moved to a
          // different route. Always reconcile the route that is visible now;
          // replaying the path captured during bootstrap can silently replace
          // Discover, personal media, or History with the previous page.
          const currentPath = window.location.pathname + window.location.search + window.location.hash;
          if (isConfigSensitiveRoute(currentPath)) {
            handleRouting(currentPath);
            applyActiveView();
          }
          // The dashboard route already loads history; only redraw it with
          // the applied config instead of fetching and parsing it again.
          if (state.activeView === "dashboard") return state.historyFetchedAt ? renderDashboard() : loadHistory();
          if (state.activeView === "stats") return loadStats();
          return null;
        })
        .then(() => startHistoryPolling())
        .catch((error) => {
          renderDbStatus(false);
          setMessage(`${error.message} Signed in, but dashboard APIs are not responding yet.`, "error");
        }), configDelay);
    } else if (user && token) {
      const fullPath = window.location.pathname + window.location.search + window.location.hash;
      if (isConfigSensitiveRoute(fullPath)) {
        handleRouting(fullPath);
        applyActiveView();
      }
    } else if (!user) {
      stopLiveUpdates();
      renderSyncProgress({ total: 0, completed: 0 });
      clearClientAttention();
      setSyncAttentionSummary({ count: 0, status: "clear" });
      if (state.claimRequired) {
        loadRouteModule("onboarding")
          .then(() => {
            setClaimRequired(true);
            setUnlocked(false);
            applyActiveView();
          })
          .catch((error) => setMessage(error.message, "error"));
      } else {
        setUnlocked(false);
      }
    }
  });

  // The shell modules load right after the first paint. The current route's
  // own modules are already requested by handleRouting()/applyActiveView(),
  // which replay the route once they arrive, so nothing is re-routed here.
  window.setTimeout(() => {
    ensureShellModules()
      .then(() => {
        replayEarlyActivation();
        scheduleDeferredStartupWork(startDeferredStatusWork);
      })
      .catch((error) => {
        logDebug(`Shell modules failed to load: ${error.message}`);
        setMessage("Part of the app failed to load. Reload the page to try again.", "error");
      });
  }, 0);
}

window.addEventListener("DOMContentLoaded", initialize);

async function copyToClipboard(value, sourceButton = null) {
  try {
    await navigator.clipboard.writeText(value);
    showCopyFeedback(sourceButton);
  } catch (error) {
    const textArea = document.createElement("textarea");
    textArea.value = value;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
    showCopyFeedback(sourceButton);
  }
}

function showToast(text, tone = "success", options = {}) {
  const messageText = String(text || "").trim();
  if (!messageText || !["error", "warning"].includes(String(tone || "").toLowerCase())) return;
  if (isSyncAttentionContext(options)) return;
  if (isLikelyActionableFailure(messageText, tone)) recordClientAttention(messageText, tone);
}

function showCopyFeedback(button) {
  if (!button) return;
  if (!button.dataset.copyOriginalLabel) button.dataset.copyOriginalLabel = button.textContent || "Copy";
  if (!button.dataset.copyOriginalAriaLabel) button.dataset.copyOriginalAriaLabel = button.getAttribute("aria-label") || "";
  window.clearTimeout(button.copyFeedbackTimer);
  button.textContent = "Copied";
  button.setAttribute("aria-label", "Copied");
  button.copyFeedbackTimer = window.setTimeout(() => {
    button.textContent = button.dataset.copyOriginalLabel || "Copy";
    if (button.dataset.copyOriginalAriaLabel) button.setAttribute("aria-label", button.dataset.copyOriginalAriaLabel);
    else button.removeAttribute("aria-label");
    delete button.dataset.copyOriginalLabel;
    delete button.dataset.copyOriginalAriaLabel;
    delete button.copyFeedbackTimer;
  }, 1600);
}

// Both refresh workflows run as server-side background jobs (see
// workerCoordinator.js's runTmdbMetadataRefreshJob/runTvdbMetadataRefreshJob)
// instead of a client-driven paging loop, so progress survives navigating away
// from this settings panel, closing the tab, or reloading the page - the
// button click just enqueues the job, and pollRefreshJob() polls its status
// until it finishes. resumeActiveRefreshJobs() (called on entering Settings,
// where the progress UI lives) re-attaches polling to a job that was already running before this page load.
const REFRESH_JOB_POLL_MS = 2000;
const refreshJobPolling = { tmdb: false, tvdb: false };

const REFRESH_JOB_UI = {
  tmdb: {
    url: "/api/refresh-tmdb-metadata",
    button: () => elements.refreshMetadataButton,
    status: () => elements.refreshMetadataStatus,
    log: () => elements.refreshMetadataLog,
    idleLabel: "Refresh Metadata Now",
    activeLabel: "Refreshing Metadata...",
    noun: "items",
  },
  tvdb: {
    url: "/api/refresh-tvdb-metadata",
    button: () => elements.refreshTvdbButton,
    status: () => elements.refreshTvdbStatus,
    log: () => elements.refreshTvdbLog,
    idleLabel: "Refresh TVDB Metadata Now",
    activeLabel: "Refreshing TVDB Metadata...",
    noun: "shows",
  },
};

function lastRefreshProgress(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\((\d+)\/(\d+)\)\s*$/);
    if (match) return { done: Number(match[1]), total: Number(match[2]) };
  }
  return null;
}

function summarizeRefreshResult(kind, result) {
  const { noun } = REFRESH_JOB_UI[kind];
  if (!result) return "";
  if (result.cancelled) return `Cancelled after ${result.refreshed || 0} of ${result.total || 0} ${noun}.`;
  if (result.success === false) return `Error: ${result.error || "refresh failed"}`;
  const postersLine = kind === "tmdb" && result.postersWritten ? `, ${result.postersWritten} posters stored` : "";
  return `Done! Refreshed ${result.refreshed || 0} ${noun} (failed: ${result.failed || 0})${postersLine}.`;
}

async function pollRefreshJob(kind) {
  if (refreshJobPolling[kind]) return;
  refreshJobPolling[kind] = true;
  const ui = REFRESH_JOB_UI[kind];
  const button = ui.button();
  const status = ui.status();
  const logEl = ui.log();

  try {
    for (;;) {
      const res = await fetch(ui.url, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const lines = Array.isArray(data.log) ? data.log : [];
      if (logEl && lines.length) {
        logEl.classList.remove("hidden");
        logEl.textContent = lines.join("\n") + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (data.active) {
        if (button) { button.disabled = true; button.textContent = ui.activeLabel; }
        if (status) {
          const progress = lastRefreshProgress(lines);
          status.textContent = progress
            ? `Progress: ${progress.done} of ${progress.total} (${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%)`
            : "Starting...";
          status.className = "status-pill status-warning";
        }
        await new Promise((resolve) => setTimeout(resolve, REFRESH_JOB_POLL_MS));
        continue;
      }

      if (button) { button.disabled = false; button.textContent = ui.idleLabel; }
      if (data.result) {
        const summary = summarizeRefreshResult(kind, data.result);
        const isError = data.result.success === false && !data.result.cancelled;
        if (status) {
          status.textContent = summary || "Idle";
          status.className = isError ? "status-pill status-error" : "status-pill status-ready";
        }
        if (logEl && summary) {
          logEl.textContent += summary + "\n";
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (!isError) {
          clearDerivedUiCaches();
          state.historyVersion = "";
          await loadHistory({ force: true }).catch(() => {});
        }
      }
      break;
    }
  } catch (err) {
    if (status) { status.textContent = `Error: ${err.message}`; status.className = "status-pill status-error"; }
    if (button) { button.disabled = false; button.textContent = ui.idleLabel; }
  } finally {
    refreshJobPolling[kind] = false;
  }
}

async function startRefreshJob(kind) {
  const ui = REFRESH_JOB_UI[kind];
  const button = ui.button();
  const status = ui.status();
  if (!button) return;
  try {
    const res = await fetch(ui.url, { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" } });
    // A 409 means a matching job is already running (e.g. resumed from another
    // tab) - fall through to polling instead of treating it as a failure.
    if (!res.ok && res.status !== 409) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    if (status) { status.textContent = `Error: ${err.message}`; status.className = "status-pill status-error"; }
    return;
  }
  pollRefreshJob(kind);
}

function runRefreshMetadataWorkflow() {
  return startRefreshJob("tmdb");
}

function runRefreshTvdbMetadataWorkflow() {
  return startRefreshJob("tvdb");
}

// Re-attaches status polling to a TMDB/TVDB refresh job that was already
// running before this page loaded, so a reload or a return visit shows live
// progress instead of the static "Idle" markup.
function resumeActiveRefreshJobs() {
  for (const kind of Object.keys(REFRESH_JOB_UI)) {
    fetch(REFRESH_JOB_UI[kind].url, { headers: authHeaders(), cache: "no-store" })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => { if (data?.active) pollRefreshJob(kind); })
      .catch(() => {});
  }
}

window.showCastMemberDetails = function (personId, personName) {
  state.personReturnUrl = window.location.pathname + window.location.hash;
  navigateTo(`/person/${personId}`);
};
