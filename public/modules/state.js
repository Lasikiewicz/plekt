import { readStoredAdminToken } from "./auth.js?v=2.2.0.1.0";
import { readStoredDebugLogs } from "./logs.js?v=2.2.0.1.0";
import { isDemoMode } from "./utils.js?v=2.2.0.1.0";

const TOKEN_KEY = "adminToken";
const LEGACY_UPPER_TOKEN_KEY = "ADMIN_TOKEN";
const LEGACY_TOKEN_KEY = "sync_admin_token";

export const ACTIVE_VIEW_KEY = "history_active_view";
export const ACTIVE_SETTINGS_TAB_KEY = "history_active_settings_tab";
export const EXPLORER_SORT_KEY_MOVIES = "plembfin:explorerSort:movies";
export const EXPLORER_SORT_KEY_SHOWS = "plembfin:explorerSort:shows";
export const EXPLORER_VIEW_KEY_MOVIES = "plembfin:explorerView:movies";
export const EXPLORER_VIEW_KEY_SHOWS = "plembfin:explorerView:shows";
// Posters-only toggle of the Movies and TV Shows libraries, remembered separately.
export const explorerCardModeKey = (mode) => `plembfin:card-mode:explorer-${mode === "shows" ? "shows" : "movies"}`;
export const HIDE_WATCHED_KEY_SHOWS = "plembfin:hideWatched:shows";
export const HIDE_ENDED_KEY_SHOWS = "plembfin:hideEnded:shows";
export const HIDE_EPISODE_SPOILERS_KEY = "plembfin:hideEpisodeSpoilers";
export const HISTORY_VIEW_KEY = "plembfin:historyView";
export const HISTORY_FILTER_KEY = "plembfin:historyFilter";
export const HISTORY_VIEW_MODES = ["grid", "list", "cards", "days"];
export const HISTORY_FILTERS = ["all", "movies", "shows"];
export const PERSONAL_MEDIA_VIEWS = ["watchlist", "ratings", "playlists"];
export const PRIMARY_VIEWS = ["dashboard", "stats", "explorer", "upcoming", "discover", ...PERSONAL_MEDIA_VIEWS, "settings", "help", "search", "history", "syncActivity", "manualWatchReview", "setup"];
export const SETTINGS_TABS = ["account", "connections", "metadata", "data", "system"];

function _startOfWeek(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return _startOfWeek(new Date());
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

// Query-versioned browser imports and bare imports used by offline tests can
// resolve this source file as different module URLs. Keep the mutable client
// store shared across those URLs so cache-busting never creates two frontends
// with diverging state.
const initialState = {
  token: readStoredAdminToken([TOKEN_KEY, LEGACY_UPPER_TOKEN_KEY, LEGACY_TOKEN_KEY]),
  authReady: false,
  claimRequired: false,
  mustChangePassword: false,
  currentUser: undefined,
  // Custom Lists was renamed Playlists; a stored view from before keeps working.
  activeView: (localStorage.getItem(ACTIVE_VIEW_KEY) || "dashboard").replace(/^custom-lists$/, "playlists"),
  activeSettingsTab: localStorage.getItem(ACTIVE_SETTINGS_TAB_KEY) || "general",
  activeSettingsRoute: null,
  activeBackupsTab: localStorage.getItem("activeBackupsTab") || "settings",
  remoteBackupFiles: [],
  remoteBackupFilesLoading: false,
  remotePlektBackupFiles: [],
  remotePlektBackupFilesLoading: false,
  historyWeekStart: _startOfWeek(new Date()),
  history: [],
  historyVersion: "",
  historyLoadPromise: null,
  historyFetchedAt: 0,
  historyLoading: false,
  historyLoadError: "",
  dashboardHistoryFilter: "all",
  dashboardHistoryViewMode: "cards",
  dashboardHistoryResizeTimer: undefined,
  activeSessions: [],
  syncJobs: [],
  syncJobsLoaded: false,
  syncJobsLoading: false,
  syncHistory: [],
  syncHistoryLoaded: false,
  syncHistoryLoading: false,
  syncActivity: [],
  syncActivityLoaded: false,
  syncActivityLoading: false,
  manualWatchReviews: [],
  manualWatchReviewCount: 0,
  manualWatchSourceMismatchCount: 0,
  manualWatchReviewLoading: false,
  manualWatchReviewLoaded: false,
  manualWatchReviewError: "",
  manualWatchReviewSearch: "",
  syncActivitySearch: "",
  syncActivityFailedOnly: false,
  syncActivityCurrentIssueGroupCount: 0,
  syncActivityCurrentIssueCount: 0,
  syncActivityRetryableCount: 0,
  syncActivityMatchReport: null,
  syncActivityMatchIssueCount: 0,
  syncActivityPagination: { page: 1, limit: 25, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: false, hasNext: false },
  syncActivityProgress: { total: 0, completed: 0, active: false, label: "", currentItemLabel: "", startupScanActive: false },
  syncActivityPaused: false,
  syncAttention: [],
  syncAttentionCount: 0,
  syncAttentionStatus: "clear",
  syncAttentionSeverity: "clear",
  syncAttentionLoaded: false,
  syncAttentionLoading: false,
  syncAttentionError: "",
  syncAttentionSkipping: "",
  syncAttentionIssueSkipping: "",
  syncAttentionIssueRetrying: "",
  syncAttentionIssueRetryTerminal: null,
  syncAttentionExpandedShows: new Set(),
  syncAttentionShowSkipping: "",
  syncAttentionShowRetrying: "",
  syncAttentionShowRetryTerminal: null,
  clientAttentionRetrying: "",
  clientAttention: [],
  changelog: null,
  savedConfig: {},
  stats: {
    totalWatches: 0,
    uniqueMoviesLogged: 0,
    totalTvEpisodesTracked: 0,
    sourceBreakdown: [],
    topShows: [],
    monthlyActivity: [],
    reports: { all: null, years: [], months: [] },
  },
  statsMediaFilter: "all",
  statsPeriodType: "all",
  statsPeriodValue: "all",
  statsLoaded: false,
  statsLoading: false,
  upcomingMonth: "",
  upcomingRangeStart: "",
  upcomingRangeEnd: "",
  upcomingByMonth: new Map(),
  upcomingLoadingMonth: "",
  upcomingSearch: "",
  upcomingSearchLoading: false,
  explorerMode: "movies",
  explorerSearch: "",
  explorerSearchTimer: undefined,
  moviesRaw: [],
  moviesOffset: 0,
  moviesHasMore: true,
  moviesLoading: false,
  moviesRequestVersion: 0,
  moviesQueryKey: "",
  showsRaw: [],
  showsOffset: 0,
  showsHasMore: true,
  showsLoading: false,
  showsRequestVersion: 0,
  showsQueryKey: "",
  explorerSortMovies: localStorage.getItem(EXPLORER_SORT_KEY_MOVIES) || "title_asc",
  explorerSortShows: localStorage.getItem(EXPLORER_SORT_KEY_SHOWS) || "title_asc",
  hideWatchedShows: localStorage.getItem(HIDE_WATCHED_KEY_SHOWS) === "true",
  hideEndedShows: localStorage.getItem(HIDE_ENDED_KEY_SHOWS) === "true",
  partWatchedRaw: [],
  partWatchedOffset: 0,
  partWatchedHasMore: true,
  partWatchedLoading: false,
  partWatchedQueryKey: "",
  partWatchedRequestVersion: 0,
  partWatchedAbortController: null,
  upNextItems: [],
  upNextManualShows: [],
  upNextDismissed: [],
  upNextLoading: false,
  upNextSyncing: false,
  upNextLoadedAt: 0,
  upNextError: "",
  upNextErrorCode: "",
  upNextFromCache: false,
  upNextExitIds: [],
  upNextPendingRemovals: [],
  upNextPendingWatchedRemovals: [],
  upNextVersion: 0,
  upNextSourceVersion: "",
  upNextSourceStatus: [],
  upNextConnectionRetryingProvider: "",
  upNextConnectionRetryAttempts: {},
  upNextConnectionRetryError: "",
  upNextConnectionRetryErrorProvider: "",
  upNextRefreshQueued: false,
  upNextForceRefreshQueued: false,
  upNextRequestVersion: 0,
  upNextAbortController: null,
  explorerViewMovies: localStorage.getItem(EXPLORER_VIEW_KEY_MOVIES) || "posters",
  explorerViewShows: localStorage.getItem(EXPLORER_VIEW_KEY_SHOWS) || "posters",
  posterLookupCache: new Map(),
  posterLookupInflight: new Map(),
  tmdbDetailsCache: new Map(),
  tmdbSeasonCache: new Map(),
  tmdbPersonCache: new Map(),
  globalDiscoveryResults: new Map(),
  globalSearchRequestToken: 0,
  searchQuery: "",
  searchFilter: "all",
  searchResults: [],
  searchLoading: false,
  searchPeoplePage: 1,
  searchPeopleTotalPages: 1,
  searchPeopleTotalResults: 0,
  searchPeopleLoading: false,
  searchPeopleError: "",
  searchCollectionDetails: new Map(),
  searchCollectionLoading: new Set(),
  globalSearchRemoteTimer: undefined,
  discoverFeeds: {},
  discoverLoading: false,
  discoverLoadedAt: 0,
  discoverError: "",
  discoverErrorCode: "",
  discoverMediaType: "all",
  discoverGenreId: "",
  discoverVersion: 0,
  discoverRequestVersion: 0,
  discoverAbortController: null,
  discoverRefreshQueued: false,
  personalMediaTab: "watchlist",
  personalMediaActiveListId: "",
  personalMediaLoadedAt: 0,
  personalMediaLoading: false,
  personalMediaError: "",
  personalRatings: [],
  personalWatchlist: [],
  personalLists: [],
  personalDeletedLists: [],
  playlistProviders: [],
  explorerPageCache: new Map(),
  explorerLoadObserver: undefined,
  dashboardPosterObserver: undefined,
  explorerScrollArmed: false,
  posterHydrateScrollScheduled: false,
  historyViewSearch: "",
  historyViewMode: HISTORY_VIEW_MODES.includes(localStorage.getItem(HISTORY_VIEW_KEY)) ? localStorage.getItem(HISTORY_VIEW_KEY) : "days",
  historyViewFilter: HISTORY_FILTERS.includes(localStorage.getItem(HISTORY_FILTER_KEY)) ? localStorage.getItem(HISTORY_FILTER_KEY) : "all",
  historyViewSearchTimer: undefined,
  historyViewRaw: [],
  historyViewOffset: 0,
  historyViewHasMore: true,
  historyViewLoading: false,
  historyViewRequestVersion: 0,
  historyViewLoadObserver: undefined,
  historyViewScrollArmed: false,
  expandedShows: new Set(),
  expandedSeasons: new Set(),
  activeShowModalKey: null,
  activeShowTmdbId: null,
  activeShowTvdbId: null,
  activeShowModalTitle: null,
  activeShowModalSeason: null,
  activeShowModalEpisode: null,
  // Set only by a real navigation to a URL naming a season (path segment or
  // #seasonN hash), consumed and cleared by the very next render so a season
  // already expanded on page load scrolls into view once - not on every
  // later re-render of the same modal (e.g. toggling an episode watched).
  pendingSeasonScrollTarget: null,
  showModalAllSeasonsExpanded: false,
  // The demo is a visual product tour: show the bundled stills on first load
  // so an unwatched episode is not mistaken for missing artwork. The toggle
  // remains available if a visitor wants spoiler protection for that session.
  hideEpisodeSpoilers: isDemoMode() ? false : localStorage.getItem(HIDE_EPISODE_SPOILERS_KEY) !== "false",
  showModalRequestToken: 0,
  showModalEpisodes: [],
  showModalEpisodeIndex: new Map(),
  activeShowRenderContext: null,
  showDetailInflight: new Map(),
  // A resolved show, indexed by every identifier that resolves to it. The
  // detail page asks for the same show through several different code paths
  // and parameter shapes, so a URL-keyed cache misses; this is keyed on
  // identity instead. Cleared by clearDerivedUiCaches() on any mutation.
  showDetailCache: new Map(),
  showDetailAliases: new Map(),
  // Identity token -> timestamp of a /api/show lookup that returned 404, so a
  // title absent from the library is not re-asked for on every re-render.
  showDetailMisses: new Map(),
  mediaDetailInline: false,
  mediaDetailReturnView: "explorer",
  mediaDetailReturnExplorerMode: "movies",
  personReturnUrl: null,
  personProfileName: "",
  personCreditsPersonId: null,
  personCreditsFilter: "all",
  personCreditsYear: "all",
  personCreditsGenre: "all",
  personCreditsSort: "date_desc",
  personCreditsMovieSort: "date_desc",
  personCreditsTvSort: "date_desc",
  pendingWatchAction: null,
  savingWatchActions: new Set(),
  savingUnwatchActions: new Set(),
  savingUnwatchIds: new Set(),
  activeMovieModalId: null,
  activeMovieTmdbId: null,
  activeMediaInfo: null,
  activeHelpTopic: "getting-started",
  importRecords: [],
  importFileNames: [],
  importLogs: ["[idle] Waiting for files."],
  importProgressValue: 0,
  importActive: false,
  debugLogs: readStoredDebugLogs(),
  activeLogCategory: "all",
  renderedLogsText: "",
  logsRefreshInterval: undefined,
  nowPlayingInterval: undefined,
  nowPlayingRequestActive: false,
  nowPlayingRefreshToken: "",
  nowPlayingSessionKey: "",
  nowPlayingLastFetchAt: 0,
  configLoaded: false,
  seerrConfigured: false,
  seerrSupports4k: { movie: false, tv: false },
  seerrMediaStatusCache: new Map(),
  fullSyncActive: false,
  // Shared live sync snapshot used by media detail pages to pause controls
  // only when the visible item's own watch state is in flight.
  syncProgress: {
    active: false,
    total: 0,
    completed: 0,
    label: "",
    currentItemLabel: "",
  },
  backupImport: null,
  watchBackups: null,
  watchBackupsLoading: false,
  cacheStats: null,
  cacheStatsLoading: false,
  internalHistoryCount: history.state?.index || 0,
};

const moduleQuery = new URL(import.meta.url).search;
const sharesWithProductionStore = !moduleQuery || /^\?v=[A-Za-z0-9._-]+$/.test(moduleQuery);
const storeKey = sharesWithProductionStore
  ? "__PLEMBFIN_FRONTEND_STATE__"
  : `__PLEMBFIN_FRONTEND_STATE__${moduleQuery}`;
const sharedStore = globalThis[storeKey] || { state: initialState, elements: {} };
globalThis[storeKey] = sharedStore;

export const state = sharedStore.state;
export const elements = sharedStore.elements;
