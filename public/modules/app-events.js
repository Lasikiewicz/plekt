import { buildAuthHeaders, buildNowPlayingUrl, getWebhookToken, onAuthChange, readStoredAdminToken, rotateWebhookSecret, scrubTokenFromLocation, signInAdmin, signOutAdmin, updateAdminCredentials } from "./auth.js?v=2.2.2.0.0";
import { appendDebugLog, clearDebugLogs, logsToText, readStoredDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./logs.js?v=2.2.2.0.0";
import { state, elements, explorerCardModeKey } from "./state.js?v=2.2.2.0.0";
import { escapeHtml, sanitizeTitle, safeImageUrl, movieSlug, showTitleFrom, slug, episodeTitle, startOfWeek, addDays, toDateInputValue, toDateTimeInputValue, formatDayName, formatDayDate, formatWeekRange, formatShortTime, formatNumber, formatDateShort, shortMonthLabel, normalizePlatformSource, platformName, platformBadge, sourceClass, computeProgress, formatDuration, formatPlaybackClock, formatNowPlayingMeta, idLine, csvRows, normalizeHeader, formatTmdbDate, ordinalDay, formatLongAiringDate, knownShowAirtime, formatEpisodeAirtime, showEpisodeKey, episodeCode, seasonLabel } from "./utils.js?v=2.2.2.0.0";
import { compactPosterUrl, clearPersistentPosterLookupCache, cachedPosterLookup, posterServerConfig, configuredImageUrl, posterUrlFor, posterMarkup, posterFallbackElement, lookupPosterUrl, hydratePosterFallbacks, bindPosterImageErrorHandler, hydratePosterImages, hydratePosters, tmdbImage, tmdbPoster, bestTmdbLogo, markArtworkUnavailable, tmdbProfile } from "./images.js?v=2.2.2.0.0";
import { initSync, nowPlayingUrl, telemetryLineValue, historyAction, isWatchedHistoryAction, syncStatus, historySyncPill, getActiveTargets, sourcePlatform, normalizeTargetStatus, targetStateUnavailable, targetStateNoop, hasConfirmedMediaAvailability, sharedLibraryAvailability, getMediaTargetSyncStatus, getSyncStatusTone, getSyncStatusTooltip, renderSyncStatusDot, renderAvailabilityPills, renderShowAvailabilityPills, renderMediaSyncPills, telemetryTargetStates, syncJobSortWeight, renderTargetPills, syncJobMediaType, syncHistoryTone, syncHistoryActionLabel, syncHistoryTargetPills, categorizeIssues, renderIssueCategory, renderSyncJobs, renderSyncHistory, loadSyncJobs, loadSyncHistory, activeSessionsKey, setActiveSessions, renderActiveSessions, loadActiveSessions, pollNowPlayingOnce, startHistoryPolling, stopHistoryPolling, syncNowPlayingPolling, triggerCronSync, triggerStopSync } from "./sync.js?v=2.2.2.0.0";
import { attachSidebarMiddleClickNavigation } from "./sidebar-navigation.js?v=2.2.2.0.0";
import { applyTextScale } from "./appearance.js?v=2.2.2.0.0";
import { WATCH_ROUTE_MODULES, ifLoaded, lazyExport, loadRouteModules, onRouteModuleLoaded } from "./route-modules.js?v=2.2.2.0.0";

// Route modules are not imported statically: that pulled the whole route graph
// (about 1 MB) into the event wiring every page loads. Actions load their module
// on first use (lazyExport); renders and cleanups only run when the module is
// already on the page (ifLoaded). See docs/frontend.md.
const claimWithForm = lazyExport("onboarding", "claimWithForm");
const renderSettingsInlineHelp = ifLoaded("help-content", "renderSettingsInlineHelp");
const lazyBackups = (name) => lazyExport("tools-backups", name);
const saveAppearanceSettings = lazyBackups("saveAppearanceSettings");
const renderDashboard = ifLoaded("dashboard", "renderDashboard");
const resetPartWatchedView = ifLoaded("dashboard", "resetPartWatchedView");
const renderPartWatched = ifLoaded("dashboard", "renderPartWatched");
const lazyUpNext = (name) => lazyExport("up-next", name, ["dashboard"]);
const loadUpNext = lazyUpNext("loadUpNext");
const removeUpNextItem = lazyUpNext("removeUpNextItem");
const upNextHasSiblingCard = lazyUpNext("upNextHasSiblingCard");
const chooseUpNextRemovalScope = lazyUpNext("chooseUpNextRemovalScope");
const removeShowFromUpNext = lazyUpNext("removeShowFromUpNext");
const removeManualShowFromUpNext = lazyUpNext("removeManualShowFromUpNext");
const addShowToUpNext = lazyUpNext("addShowToUpNext");
const upNextAttentionOptions = ifLoaded("up-next", "upNextAttentionOptions", () => ({}));
const restoreUpNextItem = lazyUpNext("restoreUpNextItem");
const setUpNextRemovalPending = ifLoaded("up-next", "setUpNextRemovalPending");
const renderSearchPage = ifLoaded("explorer", "renderSearchPage");
const loadMoreSearchPeople = lazyExport("explorer", "loadMoreSearchPeople"), loadSearchCollection = lazyExport("explorer", "loadSearchCollection"), loadShowDetail = lazyExport("explorer", "loadShowDetail");
const openWatchDatePrompt = lazyExport("watch-action", "openWatchDatePrompt", WATCH_ROUTE_MODULES), markDiscoverWatched = lazyExport("watch-action", "markDiscoverWatched", WATCH_ROUTE_MODULES), submitSeerrRequest = lazyExport("watch-action", "submitSeerrRequest", WATCH_ROUTE_MODULES);
// Synchronous: callers load WATCH_ROUTE_MODULES before using it.
const watchedReferenceFor = ifLoaded("watch-action", "watchedReferenceFor", null);
const lazyPersonal = (name) => lazyExport("personal-media", name);
const addToWatchlist = lazyPersonal("addToWatchlist"), removeFromWatchlist = lazyPersonal("removeFromWatchlist"), openRatingDialog = lazyPersonal("openRatingDialog"), openAddToListDialog = lazyPersonal("openAddToListDialog"), addToCustomList = lazyPersonal("addToCustomList"), removeFromCustomList = lazyPersonal("removeFromCustomList"), openCreateListDialog = lazyPersonal("openCreateListDialog"), handlePersonalAction = lazyPersonal("handlePersonalAction");
// Poster-menu actions only exist once poster-menu (which imports personal-media) has built them.
const personalItemFromPosterMenuDataset = ifLoaded("personal-media", "personalItemFromPosterMenuDataset", {});
const closePosterOverflowMenu = ifLoaded("poster-menu", "closePosterOverflowMenu"), setPosterOverflowMenuActionPending = ifLoaded("poster-menu", "setPosterOverflowMenuActionPending");
const dontRecommendDiscoverItem = lazyExport("discover", "dontRecommendDiscoverItem");
const syncMediaActionsMenuState = ifLoaded("media-detail", "syncMediaActionsMenuState"), closeDebugModal = ifLoaded("media-detail", "closeDebugModal"), closeMediaDetail = ifLoaded("media-detail", "closeMediaDetail"), closeMediaInfoModal = ifLoaded("media-detail", "closeMediaInfoModal");
const openHistoryDebugModal = lazyExport("media-detail", "openHistoryDebugModal");
const closePersonProfile = ifLoaded("media-person", "closePersonProfile");
import { hydrateDeferredCastDisclosure } from "./cast-disclosure.js?v=2.2.2.0.0";

let _cb = {};

function getMobileMenuElements() {
  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");
  const collapsibleRegions = topnav
    ? [
      topnav.querySelector(".global-search"),
      topnav.querySelector(".sidebar-scrollable"),
    ].filter(Boolean)
    : [];
  return { hamburgerButton, topnav, collapsibleRegions };
}

function syncMobileMenuAccessibility(isMobile, isOpen) {
  const { hamburgerButton, collapsibleRegions } = getMobileMenuElements();
  const isCollapsed = isMobile && !isOpen;
  collapsibleRegions.forEach((region) => {
    region.toggleAttribute("inert", isCollapsed);
    if (isCollapsed) region.setAttribute("aria-hidden", "true");
    else region.removeAttribute("aria-hidden");
  });
  hamburgerButton?.setAttribute("aria-expanded", String(isMobile && isOpen));
}

export function setMobileMenuState(isMobile, isOpen) {
  const { hamburgerButton, topnav } = getMobileMenuElements();
  if (!hamburgerButton || !topnav) return;
  const shouldOpen = isMobile && isOpen;
  topnav.classList.toggle("nav-open", shouldOpen);
  topnav.classList.toggle("nav-closed", isMobile && !shouldOpen);
  hamburgerButton.classList.toggle("active", shouldOpen);
  syncMobileMenuAccessibility(isMobile, shouldOpen);
}

export function closeMobileMenu() {
  const isMobile = window.innerWidth <= 760;
  const { hamburgerButton, topnav } = getMobileMenuElements();
  if (!topnav) return;
  if (topnav.classList.contains("nav-open") || hamburgerButton?.classList.contains("active")) {
    setMobileMenuState(isMobile, false);
  }
}

export function initAppEvents(callbacks = {}) {
  _cb = callbacks;
  attachEvents();
  // Detail/watch-prompt change handlers and the poster-card menu belong to
  // modules that load later (or may already have loaded); wire each once.
  onRouteModuleLoaded((key, module) => {
    if (key === "media-detail-events") {
      module.initMediaDetailEvents(callbacks);
      module.initLibraryForceSyncPanel();
      module.attachMediaDetailEvents();
    } else if (key === "sync-activity") {
      module.initSyncActivityEvents?.(callbacks);
    } else if (key === "settings-events") {
      module.initSettingsEvents(callbacks);
    } else if (key === "poster-menu") {
      module.initPosterOverflowMenu();
    }
  });
}

const authHeaders = (...args) => _cb.authHeaders?.(...args), setMessage = (...args) => _cb.setMessage?.(...args), unlockWithToken = (...args) => _cb.unlockWithToken?.(...args), clearSearchInputs = (...args) => _cb.clearSearchInputs?.(...args), selectView = (...args) => _cb.selectView?.(...args), renderLogs = (...args) => _cb.renderLogs?.(...args), logsText = (...args) => _cb.logsText?.(...args), copyToClipboard = (...args) => _cb.copyToClipboard?.(...args), selectBackupsTab = (...args) => _cb.selectBackupsTab?.(...args), navigateTo = (...args) => _cb.navigateTo?.(...args), renderChangelog = (...args) => _cb.renderChangelog?.(...args), lockDashboard = (...args) => _cb.lockDashboard?.(...args), toggleTheme = (...args) => _cb.toggleTheme?.(...args), showConfirmModal = (...args) => _cb.showConfirmModal?.(...args), openConfirmDialog = (...args) => _cb.openConfirmDialog?.(...args) || Promise.resolve(true), closeGlobalSearchDropdown = (...args) => _cb.closeGlobalSearchDropdown?.(...args), saveAdminCredentials = (...args) => _cb.saveAdminCredentials?.(...args), applyActiveView = (...args) => _cb.applyActiveView?.(...args), handleRouting = (...args) => _cb.handleRouting?.(...args), loadHistory = (...args) => _cb.loadHistory?.(...args), loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args), renderHelp = (...args) => _cb.renderHelp?.(...args), renderDbStatus = (...args) => _cb.renderDbStatus?.(...args), showErrorExplainModal = (...args) => _cb.showErrorExplainModal?.(...args), runRefreshMetadataWorkflow = (...args) => _cb.runRefreshMetadataWorkflow?.(...args), runRefreshTvdbMetadataWorkflow = (...args) => _cb.runRefreshTvdbMetadataWorkflow?.(...args), showToast = (...args) => _cb.showToast?.(...args), logDebug = (...args) => _cb.logDebug?.(...args), syncPageTopbar = (...args) => _cb.syncPageTopbar?.(...args), setUnlocked = (...args) => _cb.setUnlocked?.(...args), renderSettingsStatus = (...args) => _cb.renderSettingsStatus?.(...args), renderAdminCredentialsStatus = (...args) => _cb.renderAdminCredentialsStatus?.(...args), toggleSet = (...args) => _cb.toggleSet?.(...args), renderGlobalSearchDropdown = (...args) => _cb.renderGlobalSearchDropdown?.(...args), loadGlobalDiscovery = (...args) => _cb.loadGlobalDiscovery?.(...args);

function syncAttentionIssueMediaType(issue = {}) {
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  return ["episode", "movie"].includes(type) ? type : "";
}

function syncAttentionIssueShowTitle(issue = {}) {
  return String(issue.showTitle || issue.sourceShowTitle || showTitleFrom(issue.sourceTitle || issue.title || "")).trim();
}

function syncAttentionIssueSourceKey(issue = {}) {
  return String(issue.sourceRowId || issue.sourceMediaKey || issue.sourcePlaystateKey || issue.mediaKey || "").trim();
}

function syncAttentionIssueRowsFromState() {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    seen.add(String(row.id));
    rows.push(row);
  };

  for (const row of [...(state.history || []), ...(state.historyViewRaw || []), ...(state.moviesRaw || [])]) add(row);
  for (const show of state.showsRaw || []) {
    for (const episode of show.episodes || []) add(episode?.watched || episode);
  }
  return rows;
}

function syncAttentionIssueRowMatch(rows = [], issue = {}) {
  const type = syncAttentionIssueMediaType(issue);
  const sourceKey = syncAttentionIssueSourceKey(issue);
  const byKey = sourceKey && rows.find((row) => String(row.media_key || row.mediaKey || "") === sourceKey);
  if (byKey) return byKey;

  const sourceIds = issue.sourceIds || issue.ids || {};
  const byProviderId = rows.find((row) => type === String(row.media_type || row.type || "").toLowerCase()
    && ["imdb", "tmdb", "tvdb"].some((name) => sourceIds[name] && String(row[`${name}_id`] || row[name] || "") === String(sourceIds[name])));
  if (byProviderId) return byProviderId;

  if (type === "episode") {
    const showTitle = syncAttentionIssueShowTitle(issue);
    const showKey = showTitle ? slug(showTitle) : "";
    const season = Number(issue.sourceSeason ?? issue.season);
    const episode = Number(issue.sourceEpisode ?? issue.episode);
    const coordinateRows = rows.filter((row) => String(row.media_type || row.type || "").toLowerCase() === "episode"
      && Number(row.season) === season
      && Number(row.episode) === episode);
    return (showKey && coordinateRows.find((row) => slug(row.show_title || row.showTitle || showTitleFrom(row.title || "")) === showKey))
      || coordinateRows[0]
      || null;
  }

  const titleKey = slug(issue.sourceTitle || issue.title || "");
  return rows.find((row) => String(row.media_type || row.type || "").toLowerCase() === "movie" && slug(row.title || "") === titleKey) || null;
}

async function syncAttentionHistoryRowById(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const response = await fetch(`/api/history?id=${encodeURIComponent(key)}`, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body.row || null : null;
}

async function resolveSyncAttentionFixMatchAnchor(issue = {}) {
  const sourceRowId = String(issue.sourceRowId || "").trim();
  if (sourceRowId) {
    const row = await syncAttentionHistoryRowById(sourceRowId).catch(() => null);
    if (row?.id) return row;
  }

  let rows = syncAttentionIssueRowsFromState();
  let match = syncAttentionIssueRowMatch(rows, issue);
  if (match?.id) return match;

  const type = syncAttentionIssueMediaType(issue);
  const search = type === "episode" ? syncAttentionIssueShowTitle(issue) : String(issue.sourceTitle || issue.title || "").trim();
  if (!search) return null;
  const url = new URL("/api/history", window.location.origin);
  url.searchParams.set("search", search);
  url.searchParams.set("mediaType", type);
  url.searchParams.set("limit", "500");
  url.searchParams.set("dedupe", "false");
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  rows = Array.isArray(body.history) ? body.history : [];
  match = syncAttentionIssueRowMatch(rows, issue);
  return match?.id ? match : null;
}

async function openSyncAttentionFixMatch(issue = {}) {
  const type = syncAttentionIssueMediaType(issue);
  const anchor = await resolveSyncAttentionFixMatchAnchor(issue);
  if (!anchor?.id) {
    const href = String(issue.localHref || "").trim();
    if (href) {
      navigateTo(href);
      setMessage("No local watch row was found for a direct match dialog. Opened the affected Plekt item instead.", "warning");
      return;
    }
    throw new Error("Could not find a local watch row to fix-match.");
  }

  const currentTitle = type === "episode"
    ? syncAttentionIssueShowTitle(issue)
    : String(issue.sourceTitle || issue.title || anchor.title || "").trim();
  if (!currentTitle) throw new Error("This issue does not include a title to match.");

  _cb.openFixMatchDialog?.(null, anchor.id, currentTitle, type, async () => {
    setMessage("Match updated. Retry this item now; the retry will use the corrected local identity.", "success");
  }, {
    headerTitle: `Fix match · ${currentTitle}`,
    ...(type === "movie" && syncAttentionIssueSourceKey(issue)
      ? { mediaKey: syncAttentionIssueSourceKey(issue) }
      : {}),
  });
}

function updatePosterMenuAction(button, { label, ariaLabel = label, title = ariaLabel, busy = false, disabled = false }) {
  button.textContent = label;
  button.disabled = disabled;
  button.toggleAttribute("aria-busy", busy);
  button.setAttribute("aria-label", ariaLabel);
  button.title = title;
}

function attachEvents() {
  attachSidebarMiddleClickNavigation(document.querySelector(".topnav"));

  const cardModeTargets = {
    explorer: document.querySelector('#explorer-view-root, [data-view-panel="explorer"]'),
    discover: document.querySelector('[data-view-panel="discover"]'),
    personal: document.querySelector('[data-view-panel="personal-media"]'),
    history: document.querySelector('[data-view-panel="history"]'),
  };
  // The library toggle is remembered per library; renderExplorer re-syncs it on a switch.
  const cardModeKey = (target) => (target === "explorer" ? explorerCardModeKey(state.explorerMode) : `plembfin:card-mode:${target}`);
  const syncCardMode = (target) => {
    let compact = false;
    try { compact = localStorage.getItem(cardModeKey(target)) === "1"; } catch { /* storage unavailable */ }
    cardModeTargets[target]?.classList.toggle("page-card-mode-compact", compact);
    document.querySelectorAll(`[data-card-mode-toggle="${target}"]`).forEach((button) => {
      const label = compact ? "Show full cards" : "Show poster view";
      button.setAttribute("aria-pressed", String(compact));
      button.setAttribute("aria-label", label);
      button.title = label;
      const labelNode = button.querySelector(".page-card-mode-label");
      if (labelNode) labelNode.textContent = label;
    });
    document.querySelectorAll(`[data-card-mode-select="${target}"]`).forEach((input) => {
      input.checked = input.dataset.cardMode === (compact ? "posters" : "full");
    });
  };
  Object.keys(cardModeTargets).forEach(syncCardMode);
  document.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-card-mode-select]");
    if (!input) return;
    const target = input.dataset.cardModeSelect;
    if (!(target in cardModeTargets)) return;
    const compact = input.dataset.cardMode === "posters";
    try {
      if (compact) localStorage.setItem(cardModeKey(target), "1");
      else localStorage.removeItem(cardModeKey(target));
    } catch { /* storage unavailable; this page still updates */ }
    syncCardMode(target);
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-card-mode-toggle]");
    if (!button) return;
    const target = button.dataset.cardModeToggle;
    if (!(target in cardModeTargets)) return;
    const compact = button.getAttribute("aria-pressed") !== "true";
    try {
      if (compact) localStorage.setItem(cardModeKey(target), "1");
      else localStorage.removeItem(cardModeKey(target));
    } catch { /* storage unavailable; this page still updates */ }
    syncCardMode(target);
  });

  document.querySelectorAll(".backup-managed-form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const target = document.getElementById(form.dataset.submitTarget || "");
      if (target && !target.disabled) target.click();
    });
  });

  document.addEventListener("click", (e) => {
    const controlTab = e.target.closest(".mobile-control-tab");
    if (controlTab) {
      const container = controlTab.closest(".explorer-controls");
      if (container) {
        const target = controlTab.dataset.target;
        const isActive = controlTab.classList.contains("active");

        container.querySelectorAll(".mobile-control-tab").forEach(tab => {
          tab.classList.remove("active");
          tab.setAttribute("aria-pressed", "false");
        });
        container.querySelectorAll(".compact-field, .explorer-view-toggle, #explorerHideWatchedLabel, #explorerHideEndedLabel, #explorerDroppedOnlyLabel").forEach(panel => {
          panel.classList.remove("active-mobile-panel");
        });

        if (!isActive) {
          controlTab.classList.add("active");
          controlTab.setAttribute("aria-pressed", "true");
          if (target === "search") {
            container.querySelector(".explorer-search-box")?.classList.add("active-mobile-panel");
          } else if (target === "sort") {
            container.querySelector("select")?.closest(".compact-field")?.classList.add("active-mobile-panel");
          } else if (target === "filter") {
            const hideWatched = container.querySelector("#explorerHideWatchedLabel");
            const hideEnded = container.querySelector("#explorerHideEndedLabel");
            const historyControls = container.querySelectorAll(".history-filter-toggle, .history-view-toggle");
            if (hideWatched) hideWatched.classList.add("active-mobile-panel");
            if (hideEnded) hideEnded.classList.add("active-mobile-panel");
            container.querySelector("#explorerDroppedOnlyLabel")?.classList.add("active-mobile-panel");
            historyControls.forEach((control) => control.classList.add("active-mobile-panel"));
          } else if (target === "view") {
            const viewToggle = container.querySelector(".explorer-view-toggle:not(.history-filter-toggle)");
            if (viewToggle) viewToggle.classList.add("active-mobile-panel");
          }
        }
      }
      return;
    }

    const castMore = e.target.closest("[data-cast-more-trigger]");
    if (castMore) {
      hydrateDeferredCastDisclosure(castMore);
      return;
    }
    const castCard = e.target.closest("[data-person-id]");
    if (castCard) {
      window.showCastMemberDetails(castCard.dataset.personId, castCard.dataset.personName);
      return;
    }
    const trailer = e.target.closest(".trailer-thumb-container[data-video-key]");
    if (trailer) {
      window.playTrailer(trailer, trailer.dataset.videoKey, trailer.dataset.videoName);
      return;
    }
    const reviewBtn = e.target.closest(".review-toggle-btn");
    if (reviewBtn) {
      const p = reviewBtn.previousElementSibling.querySelector(".review-content");
      p.classList.toggle("expanded");
      reviewBtn.textContent = p.classList.contains("expanded") ? "Show Less" : "Read More";
      return;
    }
    const photoThumb = e.target.closest("[data-photo-index]");
    if (photoThumb) {
      window.openPhotoLightbox(window._personPhotos, parseInt(photoThumb.dataset.photoIndex, 10));
      return;
    }
  });

  // Posters render their skeleton until the bitmap is decoded. `load` does not
  // bubble, so this listens in the capture phase and covers every poster and
  // detail-page image the app renders, including ones swapped in after a lookup.
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && (img.classList.contains("poster-img") || img.closest(".media-detail-page"))) {
      img.classList.add("is-loaded");
    }
  }, true);

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG") return;
    // A poster that failed is no longer loading; the error paths below decide
    // what replaces it.
    img.classList.add("is-loaded");
    markArtworkUnavailable(img.src);
    const mode = img.dataset.err;
    if (!mode) return;
    img.dataset.err = "";
    if (mode === "fav") { img.src = "/favicon.svg"; }
    else if (mode === "hide") { img.style.display = "none"; }
    else if (mode === "hide-parent") { img.parentElement.style.display = "none"; }
    else if (mode === "hide-closest-btn") { img.closest("button").style.display = "none"; }
    else if (mode === "hide-show-next") { img.style.display = "none"; img.nextElementSibling.style.display = "inline-grid"; }
    // A logo that cannot be fetched must not leave the hero blank: drop the
    // image and promote the screen-reader title back to the visible heading.
    else if (mode === "logo-title") {
      const heading = img.parentElement?.querySelector(".immersive-title");
      img.remove();
      heading?.classList.remove("sr-only");
    }
  }, true);

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await unlockWithToken(elements.adminToken.value);
    } catch (error) {
      setUnlocked(false);
      renderDbStatus(false);
      setMessage(error.message, "error");
    }
  });

  elements.claimForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await claimWithForm(elements.claimUsername.value, elements.claimPassword.value, elements.claimPasswordConfirm.value);
    } catch (error) {
      elements.claimMessage.textContent = error.message;
      elements.claimMessage.dataset.tone = "error";
    }
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.explorerNav) {
        if (state.activeView === "explorer" && !state.mediaDetailInline && state.explorerMode !== button.dataset.explorerNav) {
          clearSearchInputs();
        }
        state.explorerMode = button.dataset.explorerNav;
      }
      if (state.mediaDetailInline) {
        state.mediaDetailInline = false;
        state.activeShowModalKey = null;
        state.activeShowModalSeason = null;
        state.activeShowModalEpisode = null;
        state.showModalRequestToken += 1;
        state.showModalEpisodes = [];
        state.showModalEpisodeIndex = new Map();
        state.pendingWatchAction = null;
        state.activeMovieModalId = null;
        document.querySelector("#explorerBackButton")?.classList.add("hidden");
        elements.explorerTopbarControls?.classList.remove("hidden");
      }
      closeMobileMenu();
      selectView(button.dataset.view, { fresh: true });
    });
  });

  const hamburgerButton = document.getElementById("hamburgerButton");
  const topnav = document.querySelector(".topnav");

  if (hamburgerButton && topnav) {
    let lastIsMobile = window.innerWidth <= 760;
    function initMobileMenu(force = false) {
      const isMobile = window.innerWidth <= 760;
      if (force || isMobile !== lastIsMobile) {
        const { collapsibleRegions } = getMobileMenuElements();
        if (isMobile && collapsibleRegions.some((region) => region.contains(document.activeElement))) {
          hamburgerButton.focus({ preventScroll: true });
        }
        setMobileMenuState(isMobile, false);
        lastIsMobile = isMobile;
      }
    }
    initMobileMenu(true);
    window.addEventListener("resize", () => initMobileMenu(false));

    hamburgerButton.addEventListener("click", () => {
      const isMobile = window.innerWidth <= 760;
      setMobileMenuState(isMobile, !topnav.classList.contains("nav-open"));
    });
  }

  // No scroll events or arrow click handlers needed for fixed-fit rows

  document.querySelector("#settingsSectionSelect")?.addEventListener("change", (event) => {
    navigateTo(event.currentTarget.value);
  });

  document.addEventListener("click", (event) => {
    const copyBtn = event.target.closest(".copy-button");
    if (copyBtn) {
      const copyText = copyBtn.dataset.copy || copyBtn.closest(".copy-block")?.querySelector("code")?.textContent;
      if (copyText) copyToClipboard(copyText.trim(), copyBtn);
      return;
    }
    const target = event.target.closest("[data-settings-path]");
    if (!target) return;
    closeMobileMenu();
    navigateTo(target.dataset.settingsPath);
  });

  elements.sidebarAppearanceButton?.addEventListener("click", () => {
    const isClosed = elements.sidebarAppearancePanel?.classList.toggle("hidden");
    elements.sidebarAppearanceButton.setAttribute("aria-expanded", String(!isClosed));
  });

  for (const id of ["appearShowLogoArt", "appearShowCast", "appearShowTrailers", "appearShowReviews", "appearShowImages", "appearShowRelated", "appearHideLinks"]) {
    elements[id]?.addEventListener("change", () => saveAppearanceSettings().catch(() => null));
  }
  document.querySelector("#appearTextScale")?.addEventListener("input", () => {
    const value = Number(document.querySelector("#appearTextScale").value) || 100;
    applyTextScale(value);
  });
  document.querySelector("#appearTextScale")?.addEventListener("change", () => saveAppearanceSettings().catch(() => null));

  const brandLink = document.querySelector("#brandLink");
  if (brandLink) {
    brandLink.addEventListener("click", (event) => {
      event.preventDefault();
      closeMobileMenu();
      navigateTo("/");
    });
  }

  document.addEventListener("click", (event) => {
    // Click activation can be delivered without a pointer button (for example
    // through keyboard or automation).  The click event itself is already the
    // left-button activation boundary, so only reject modified activations.
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const nowPlayingCard = event.target.closest("[data-now-playing-href]");
    if (nowPlayingCard?.dataset.nowPlayingHref) {
      event.preventDefault();
      navigateTo(nowPlayingCard.dataset.nowPlayingHref);
      return;
    }
    // An Up Next card opens its episode from anywhere on the card, like a
    // recently watched card, except on its own links and buttons.
    const upNextCard = event.target.closest("[data-up-next-card-id]");
    if (upNextCard && !event.target.closest("a, button, input, select, textarea, label")) {
      const upNextLink = upNextCard.querySelector(".history-card-poster-link[data-media-card-href]");
      if (upNextLink) {
        event.preventDefault();
        navigateTo(upNextLink.dataset.mediaCardHref);
        return;
      }
    }
    const link = event.target.closest("a[data-media-card-href]");
    if (!link?.dataset.mediaCardHref) return;
    event.preventDefault();
    navigateTo(link.dataset.mediaCardHref);
  });

  const parseDatasetObject = (value, fallback = {}) => {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const upNextPayloadFromButton = (button) => {
    const d = button?.dataset || {};
    const mediaType = d.upNextMediaType === "episode" ? "episode" : "movie";
    const isEpisode = mediaType === "episode";
    const title = d.upNextTitle || d.upNextMenuTitle || d.title || "Untitled";
    const showTitle = d.showTitle || d.upNextShowTitle || (isEpisode ? title : "");
    return {
      id: d.upNextWatch || d.upNextMenuWatch || d.upNextClear || d.upNextRemove || "",
      mediaType,
      isEpisode,
      title,
      showTitle,
      episodeTitle: d.episodeTitle || d.upNextEpisodeTitle || "",
      season: d.season || d.upNextSeason || "",
      episode: d.episode || d.upNextEpisode || "",
      tmdbId: d.tmdbId || d.upNextTmdbId || "",
      tvdbId: d.tvdbId || d.upNextTvdbId || "",
      imdbId: d.imdbId || d.upNextImdbId || "",
      posterUrl: d.posterUrl || d.upNextPosterUrl || "",
      airDate: d.airDate || d.upNextAirDate || "",
      providerItems: parseDatasetObject(d.providerItems || d.upNextProviderItems, {}),
    };
  };

  const upNextWatchedReference = (item) => {
    const showKey = slug(showTitleFrom(item?.showTitle || "")).replace(/-\d{4}$/, "");
    const showIds = {
      tmdb: String(item?.tmdbId || "").trim(),
      tvdb: String(item?.tvdbId || "").trim(),
      imdb: String(item?.imdbId || "").trim().toLowerCase(),
    };
    if (!showKey) return null;
    const identityMatches = (candidate = {}) => Object.entries(showIds).some(([provider, value]) => (
      value && String(candidate[`show_${provider}_id`] || candidate[`${provider}_id`] || "").trim().toLowerCase() === value
    ));
    const titleMatches = (candidate = {}) => (
      slug(showTitleFrom(candidate.show_title || candidate.title || "")).replace(/-\d{4}$/, "") === showKey
    );
    const scopeEpisodes = [];
    const seen = new Set();
    const addEpisode = (episode) => {
      const seasonNumber = Number(episode?.seasonNumber ?? episode?.season);
      const episodeNumber = Number(episode?.episodeNumber ?? episode?.episode);
      const watchedAt = episode?.watched?.watched_at || episode?.watched_at;
      if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber) || !watchedAt) return;
      const key = `${seasonNumber}:${episodeNumber}:${watchedAt}`;
      if (seen.has(key)) return;
      seen.add(key);
      scopeEpisodes.push({
        seasonNumber,
        episodeNumber,
        runtime: episode?.runtime ?? null,
        watched: { watched_at: watchedAt },
      });
    };

    for (const row of state.history || []) {
      if (row?.media_type !== "episode" || !isWatchedHistoryAction(row)) continue;
      if (!titleMatches(row) && !identityMatches(row)) continue;
      addEpisode(row);
    }
    for (const show of state.showsRaw || []) {
      if (!titleMatches(show) && !identityMatches(show)) continue;
      for (const episode of show.episodes || []) addEpisode(episode);
    }

    return watchedReferenceFor(scopeEpisodes, {
      seasonNumber: Number(item?.season),
      episodeNumber: Number(item?.episode),
    });
  };

  const openUpNextWatchPrompt = async (watchBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const item = upNextPayloadFromButton(watchBtn);
    if (!item.id) return;
    // upNextWatchedReference() reads watch-action synchronously.
    await loadRouteModules(WATCH_ROUTE_MODULES);

    if (!item.isEpisode) {
      state.pendingWatchAction = {
        origin: "up-next",
        scope: "movie",
        mediaKey: item.id,
        title: item.title,
        movie: {
          title: item.title,
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          tvdbId: item.tvdbId,
          posterUrl: item.posterUrl || null,
          releaseDate: item.airDate || null,
          providerItems: item.providerItems,
        },
        providerItems: item.providerItems,
        label: `Mark ${item.title} watched`,
        countLabel: "1 movie",
      };
      openWatchDatePrompt(state.pendingWatchAction);
      return;
    }

    const season = Number(item.season);
    const episode = Number(item.episode);
    if (!Number.isInteger(season) || !Number.isInteger(episode) || episode <= 0) return;
    const showTitle = item.showTitle || "Show";
    // The dashboard history payload is intentionally a small preview and the
    // explorer may not have loaded this show yet. Fetch the authoritative show
    // detail when the local preview cannot provide a sibling watch date; that
    // keeps the Up Next prompt in parity with the media-page prompt instead of
    // silently omitting "Same as other episodes".
    let reference = upNextWatchedReference(item);
    let referenceShow = null;
    if (!reference && showTitle && showTitle !== "Show") {
      try {
        referenceShow = await loadShowDetail({
          title: showTitle,
          tmdb_id: item.tmdbId,
          tvdb_id: item.tvdbId,
          imdb_id: item.imdbId,
        });
        reference = upNextWatchedReference({
          ...item,
          showTitle: referenceShow?.title || showTitle,
          tmdbId: referenceShow?.tmdb_id || item.tmdbId,
          tvdbId: referenceShow?.tvdb_id || item.tvdbId,
          imdbId: referenceShow?.imdb_id || item.imdbId,
        });
      } catch (error) {
        logDebug(`Up Next watched reference lookup failed: ${error.message}`);
      }
    }
    const resolvedShowTitle = referenceShow?.title || showTitle;
    state.pendingWatchAction = {
      origin: "up-next",
      scope: "episode",
      showTitle: resolvedShowTitle,
      showTmdbId: referenceShow?.tmdb_id || item.tmdbId,
      episodes: [{
        seasonNumber: season,
        episodeNumber: episode,
        title: item.episodeTitle || episodeCode(season, episode),
        showTitle: resolvedShowTitle,
        showTmdbId: referenceShow?.tmdb_id || item.tmdbId,
        tvdbId: referenceShow?.tvdb_id || item.tvdbId,
        imdbId: referenceShow?.imdb_id || item.imdbId,
        posterUrl: item.posterUrl || null,
        providerItems: item.providerItems,
        key: item.id || `up-next:${showTitle}:${season}:${episode}`,
        airDate: item.airDate || null,
      }],
      resyncEpisodes: [],
      referenceWatchedAt: reference?.watchedAt || "",
      referenceEpisodeLabel: reference?.label || "",
      referenceRuntime: reference?.runtime ?? null,
      referenceDirection: reference?.direction || "",
      label: `Mark ${episodeCode(season, episode)} watched`,
      countLabel: `${episodeCode(season, episode)} · ${resolvedShowTitle}`,
    };
    openWatchDatePrompt(state.pendingWatchAction);
  };

  const clearUpNextProgress = async (clearBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const d = clearBtn?.dataset || {};
    const itemId = d.upNextClear || "";
    const item = state.upNextItems.find((candidate) => String(candidate?.id || "") === String(itemId)) || null;
    const payload = item
      ? {
          ...item,
          providerItems: item.provider_items || item.providerItems || {},
        }
      : upNextPayloadFromButton(clearBtn);
    if (!payload.id && !payload.media_key) return;

    const payloadMediaType = payload.media_type || payload.mediaType || "movie";
    const title = payloadMediaType === "episode"
      ? (payload.show_title || payload.showTitle || payload.title || "this episode")
      : (payload.title || "this movie");
    const confirmed = await openConfirmDialog({
      title: "Clear Progress",
      body: `Clear saved progress for "${title}" and mark it unwatched?`,
      confirmLabel: "Clear progress",
      danger: true,
    });
    if (!confirmed) return;

    const clearingCard = clearBtn.closest("[data-up-next-card-id]");
    const originalText = clearBtn.textContent;
    const originalLabel = clearBtn.getAttribute("aria-label");
    clearingCard?.classList.add("card-removing");
    clearBtn.disabled = true;
    clearBtn.textContent = "…";
    clearBtn.setAttribute("aria-label", "Clearing progress");
    // Hide the resume immediately and persist the temporary dismissal while
    // provider feeds catch up. A failed clear restores the card in its place.
    const pendingClear = removeUpNextItem(payload.id || itemId || payload.media_key, payload);
    try {
      const mediaType = payload.media_type || payload.mediaType || (payload.season != null ? "episode" : "movie");
      const response = await fetch("/api/playback-progress/unwatch", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          media_key: payload.media_key || payload.id,
          media_type: mediaType,
          title: payload.title || payload.episode_title || payload.show_title || payload.showTitle || "Untitled",
          show_title: payload.show_title || payload.showTitle || "",
          tmdb_id: payload.tmdb_id || payload.tmdbId || payload.show_tmdb_id || payload.showTmdbId || "",
          imdb_id: payload.imdb_id || payload.imdbId || payload.show_imdb_id || payload.showImdbId || "",
          tvdb_id: payload.tvdb_id || payload.tvdbId || payload.show_tvdb_id || payload.showTvdbId || "",
          show_tmdb_id: payload.show_tmdb_id || payload.showTmdbId || "",
          show_imdb_id: payload.show_imdb_id || payload.showImdbId || "",
          show_tvdb_id: payload.show_tvdb_id || payload.showTvdbId || "",
          season: mediaType === "episode" ? (payload.season ?? "") : "",
          episode: mediaType === "episode" ? (payload.episode ?? "") : "",
          provider_items: payload.provider_items || payload.providerItems || {},
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage(
        body.queued
          ? `Progress cleared for "${title}"; unwatched sync queued until the current blocking operation completes`
          : `Progress cleared for "${title}"`,
        "success",
      );
      await loadHistory({ force: true, silent: true }).catch(() => null);
      await loadUpNext({ force: true });
      renderDashboard();
    } catch (error) {
      restoreUpNextItem(pendingClear);
      showErrorExplainModal(`Failed to clear progress for "${title}"`, error.message);
    } finally {
      clearingCard?.classList.remove("card-removing");
      clearBtn.disabled = false;
      clearBtn.textContent = originalText;
      if (originalLabel === null) clearBtn.removeAttribute("aria-label");
      else clearBtn.setAttribute("aria-label", originalLabel);
    }
  };

  const removeUpNextItemAction = async (removeBtn, event = null) => {
    event?.preventDefault();
    event?.stopPropagation();
    const d = removeBtn?.dataset || {};
    const itemId = d.upNextRemove || "";
    const item = state.upNextItems.find((candidate) => String(candidate?.id || "") === String(itemId)) || null;
    const payload = item
      ? {
          ...item,
          providerItems: item.provider_items || item.providerItems || {},
        }
      : upNextPayloadFromButton(removeBtn);
    if (!payload.id && !payload.media_key && !itemId) return;

    const payloadMediaType = payload.media_type || payload.mediaType || (payload.season != null ? "episode" : "movie");
    const isEpisode = payloadMediaType === "episode";
    const title = isEpisode
      ? (payload.show_title || payload.showTitle || payload.title || "this episode")
      : (payload.title || "this movie");
    // Two cards for one show (a rewatch beside a new episode) ask for the scope.
    const scope = isEpisode && item && (await upNextHasSiblingCard(item))
      ? await chooseUpNextRemovalScope(item)
      : (await openConfirmDialog({
        title: "Remove from Up Next",
        body: `Remove "${title}" from Up Next in Plekt and every connected media app?`,
        confirmLabel: "Remove from Up Next",
        danger: true,
      })) && "show";
    if (!scope) return;
    if (scope === "season") payload.dismissal_scope = "season";

    const originalText = removeBtn.textContent;
    const originalLabel = removeBtn.getAttribute("aria-label");
    removeBtn.disabled = true;
    removeBtn.textContent = "…";
    removeBtn.setAttribute("aria-label", "Removing from Up Next");

    // Keep the card in place while the provider calls run. The pending state
    // is part of the rendered snapshot, so an overlapping refresh cannot
    // repaint the item as an ordinary card before removal is complete.
    setUpNextRemovalPending(payload.dismissal_scope ? payload : (item || payload), true);
    try {
      const response = await fetch("/api/up-next/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          media_key: payload.media_key || payload.id || itemId,
          media_type: payloadMediaType,
          queue_kind: payload.queue_kind || payload.queueKind || d.upNextQueueKind || "",
          title: payload.title || payload.episode_title || payload.show_title || payload.showTitle || "Untitled",
          show_title: payload.show_title || payload.showTitle || "",
          tmdb_id: payload.tmdb_id || payload.tmdbId || payload.show_tmdb_id || payload.showTmdbId || "",
          imdb_id: payload.imdb_id || payload.imdbId || payload.show_imdb_id || payload.showImdbId || "",
          tvdb_id: payload.tvdb_id || payload.tvdbId || payload.show_tvdb_id || payload.showTvdbId || "",
          show_tmdb_id: payload.show_tmdb_id || payload.showTmdbId || "",
          show_imdb_id: payload.show_imdb_id || payload.showImdbId || "",
          show_tvdb_id: payload.show_tvdb_id || payload.showTvdbId || "",
          season: isEpisode ? (payload.season ?? "") : "",
          episode: isEpisode ? (payload.episode ?? "") : "",
          provider_items: payload.provider_items || payload.providerItems || {},
          dismissal_scope: payload.dismissal_scope || "",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (isEpisode && scope === "show") {
        await removeManualShowFromUpNext({
          title: payload.show_title || payload.showTitle || title,
          tmdb_id: payload.show_tmdb_id || payload.showTmdbId || payload.tmdb_id || payload.tmdbId || "",
          tvdb_id: payload.show_tvdb_id || payload.showTvdbId || payload.tvdb_id || payload.tvdbId || "",
          imdb_id: payload.show_imdb_id || payload.showImdbId || payload.imdb_id || payload.imdbId || "",
        });
      }
      removeUpNextItem(payload.id || itemId, payload, { showScope: scope === "show", seasonScope: scope === "season" });
      const dismissals = Array.isArray(body.providerDismissals) ? body.providerDismissals : [];
      const synced = dismissals.filter((entry) => entry.status === "fulfilled").length;
      const issues = dismissals.filter((entry) => entry.status !== "fulfilled").length;
      setMessage(
        issues
          ? `Removed "${title}" in Plekt and ${synced} connected app${synced === 1 ? "" : "s"}; ${issues} app${issues === 1 ? " needs" : "s need"} attention`
          : body.queued
          ? `Removed "${title}" from Up Next; sync queued until the current blocking operation completes`
          : synced
            ? `Removed "${title}" from Up Next in Plekt and ${synced} connected app${synced === 1 ? "" : "s"}`
            : `Removed "${title}" from Up Next in Plekt`,
        issues ? "muted" : "success",
      );
      await loadHistory({ force: true, silent: true }).catch(() => null);
      await loadUpNext({ force: true });
      renderDashboard();
    } catch (error) {
      setUpNextRemovalPending(payload.dismissal_scope ? payload : (item || payload), false);
      showErrorExplainModal(`Failed to remove "${title}" from Up Next`, error.message);
    } finally {
      removeBtn.disabled = false;
      removeBtn.textContent = originalText;
      if (originalLabel === null) removeBtn.removeAttribute("aria-label");
      else removeBtn.setAttribute("aria-label", originalLabel);
    }
  };

  elements.upNextPanel?.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-up-next-remove]");
    if (removeBtn) {
      removeUpNextItemAction(removeBtn, event);
      return;
    }
    const clearBtn = event.target.closest("[data-up-next-clear]");
    if (clearBtn) {
      clearUpNextProgress(clearBtn, event);
      return;
    }
    const watchBtn = event.target.closest("[data-up-next-watch]");
    if (!watchBtn) return;
    openUpNextWatchPrompt(watchBtn, event);
  });

  // Overflow menus are portaled to <body>, so their Up Next actions cannot be
  // delegated from the horizontal row itself.
  document.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-up-next-remove]");
    if (removeBtn) {
      removeUpNextItemAction(removeBtn, event);
      return;
    }

    const clearBtn = event.target.closest("[data-up-next-clear]");
    if (clearBtn) {
      clearUpNextProgress(clearBtn, event);
      return;
    }

    const watchBtn = event.target.closest("[data-up-next-menu-watch]");
    if (watchBtn) {
      event.preventDefault();
      event.stopPropagation();
      openUpNextWatchPrompt(watchBtn, event);
      return;
    }

    const upNextShowAction = event.target.closest("[data-up-next-show-toggle]");
    if (upNextShowAction) {
      event.preventDefault();
      event.stopPropagation();
      const remove = upNextShowAction.dataset.upNextShowToggle === "remove";
      if (remove) {
        const title = upNextShowAction.dataset.upNextShowTitle || "this show";
        openConfirmDialog({
          title: "Remove from Up Next",
          body: `Remove "${title}" from Up Next?`,
          confirmLabel: "Remove from Up Next",
          danger: true,
        }).then((confirmed) => {
          if (confirmed) return removeShowFromUpNext(upNextShowAction);
          return null;
        }).catch((error) => setMessage(error.message, "error", upNextAttentionOptions(error, "remove")));
      } else {
        addShowToUpNext(upNextShowAction).catch((error) => setMessage(error.message, "error", upNextAttentionOptions(error, "add")));
      }
      return;
    }

    const discoverItemFromButton = (button) => ({
      media_type: button.dataset.discoverMediaType || "movie",
      tmdb_id: button.dataset.discoverTmdbId || "",
      tvdb_id: button.dataset.discoverTvdbId || "",
      imdb_id: button.dataset.discoverImdbId || "",
      title: button.dataset.discoverTitle || "Untitled",
      poster_url: button.dataset.discoverPosterUrl || "",
      overview: button.dataset.discoverOverview || "",
      release_date: button.dataset.discoverReleaseDate || "",
    });

    const mediaRateButton = event.target.closest("[data-media-rate]");
    if (mediaRateButton) {
      event.preventDefault();
      event.stopPropagation();
      openRatingDialog({
        media_type: mediaRateButton.dataset.mediaRateMediaType || "movie",
        tmdb_id: mediaRateButton.dataset.mediaRateTmdbId || "",
        tvdb_id: mediaRateButton.dataset.mediaRateTvdbId || "",
        imdb_id: mediaRateButton.dataset.mediaRateImdbId || "",
        show_tmdb_id: mediaRateButton.dataset.mediaRateShowTmdbId || "",
        show_tvdb_id: mediaRateButton.dataset.mediaRateShowTvdbId || "",
        show_imdb_id: mediaRateButton.dataset.mediaRateShowImdbId || "",
        episode_tmdb_id: mediaRateButton.dataset.mediaRateEpisodeTmdbId || "",
        episode_tvdb_id: mediaRateButton.dataset.mediaRateEpisodeTvdbId || "",
        episode_imdb_id: mediaRateButton.dataset.mediaRateEpisodeImdbId || "",
        title: mediaRateButton.dataset.mediaRateTitle || "Untitled",
        show_title: mediaRateButton.dataset.mediaRateShowTitle || "",
        season: mediaRateButton.dataset.mediaRateSeason || "",
        episode: mediaRateButton.dataset.mediaRateEpisode || "",
        poster_url: mediaRateButton.dataset.mediaRatePosterUrl || "",
        overview: mediaRateButton.dataset.mediaRateOverview || "",
        release_date: mediaRateButton.dataset.mediaRateReleaseDate || "",
      });
      return;
    }

    const personalMenuAction = event.target.closest("[data-personal-action][data-poster-menu-personal-action]");
    if (personalMenuAction) {
      event.preventDefault();
      event.stopPropagation();
      handlePersonalAction(personalMenuAction).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const posterPersonalAction = event.target.closest("[data-poster-menu-watchlist], [data-poster-menu-list-id], [data-poster-menu-create-list]");
    if (posterPersonalAction) {
      event.preventDefault();
      event.stopPropagation();
      const item = personalItemFromPosterMenuDataset(posterPersonalAction.dataset);
      if (posterPersonalAction.matches("[data-poster-menu-watchlist]")) {
        const isAdd = posterPersonalAction.dataset.posterMenuWatchlist === "add";
        const originalLabel = posterPersonalAction.textContent || (isAdd ? "Add to watch list" : "Remove from watch list");
        const pendingLabel = isAdd ? "Saving…" : "Removing…";
        const pendingDescription = isAdd ? "Saving to watchlist" : "Removing from watchlist";
        updatePosterMenuAction(posterPersonalAction, {
          label: pendingLabel,
          ariaLabel: pendingDescription,
          title: pendingDescription,
          busy: true,
          disabled: true,
        });
        setPosterOverflowMenuActionPending(posterPersonalAction, true);
        const request = isAdd
          ? addToWatchlist(item, { showMessage: false })
          : removeFromWatchlist(item, { showMessage: false });
        request
          .then(() => {
            const label = isAdd ? "Added to watchlist" : "Removed from watchlist";
            updatePosterMenuAction(posterPersonalAction, { label, ariaLabel: label, title: label, disabled: true });
            posterPersonalAction.dataset.posterMenuWatchlist = isAdd ? "added" : "removed";
          })
          .catch((error) => {
            updatePosterMenuAction(posterPersonalAction, {
              label: originalLabel,
              ariaLabel: originalLabel,
              title: originalLabel,
              disabled: false,
            });
            setMessage(error.message, "error");
          })
          .finally(() => setPosterOverflowMenuActionPending(posterPersonalAction, false));
      } else if (posterPersonalAction.matches("[data-poster-menu-list-id]")) {
        const originalLabel = posterPersonalAction.textContent;
        const isRemove = posterPersonalAction.dataset.posterMenuListAction === "remove";
        const listName = posterPersonalAction.dataset.posterMenuListName
          || originalLabel.replace(/^Remove from\s+/, "")
          || "Playlist";
        const pendingLabel = `${listName} - ${isRemove ? "Removing…" : "Saving…"}`;
        updatePosterMenuAction(posterPersonalAction, {
          label: pendingLabel,
          ariaLabel: pendingLabel,
          title: pendingLabel,
          busy: true,
          disabled: true,
        });
        setPosterOverflowMenuActionPending(posterPersonalAction, true);
        const request = isRemove
          ? removeFromCustomList(item, posterPersonalAction.dataset.posterMenuListId, { showMessage: false })
          : addToCustomList(item, posterPersonalAction.dataset.posterMenuListId, { showMessage: false });
        request
          .then((result) => {
            // A show opened the episode picker; the menu has done its part.
            if (result?.picker) {
              closePosterOverflowMenu();
              return;
            }
            const label = `${listName} - ${isRemove ? "Removed" : "Added"}`;
            updatePosterMenuAction(posterPersonalAction, { label, ariaLabel: label, title: label, disabled: true });
            posterPersonalAction.dataset.posterMenuListAction = isRemove ? "removed" : "added";
          })
          .catch((error) => {
            updatePosterMenuAction(posterPersonalAction, {
              label: originalLabel,
              ariaLabel: originalLabel,
              title: originalLabel,
              disabled: false,
            });
            setMessage(error.message, "error");
          })
          .finally(() => setPosterOverflowMenuActionPending(posterPersonalAction, false));
      } else {
        closePosterOverflowMenu();
        openCreateListDialog(item);
      }
      return;
    }

    const discoverWatchButton = event.target.closest("[data-discover-mark-watched]");
    if (discoverWatchButton) {
      event.preventDefault();
      event.stopPropagation();
      markDiscoverWatched(discoverItemFromButton(discoverWatchButton)).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const discoverSeerrButton = event.target.closest("[data-discover-seerr-request]");
    if (discoverSeerrButton) {
      event.preventDefault();
      event.stopPropagation();
      const mediaType = discoverSeerrButton.dataset.seerrMediaType || discoverSeerrButton.dataset.discoverMediaType || "movie";
      const mediaId = discoverSeerrButton.dataset.seerrMediaId || discoverSeerrButton.dataset.discoverTmdbId || "";
      submitSeerrRequest(mediaType, mediaId, discoverSeerrButton);
      return;
    }

    const discoverWatchlistButton = event.target.closest("[data-discover-watchlist]");
    if (discoverWatchlistButton) {
      event.preventDefault();
      event.stopPropagation();
      const item = discoverItemFromButton(discoverWatchlistButton);
      const action = discoverWatchlistButton.dataset.discoverWatchlist === "remove" ? removeFromWatchlist : addToWatchlist;
      action(item).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const discoverRateButton = event.target.closest("[data-discover-rate]");
    if (discoverRateButton) {
      event.preventDefault();
      event.stopPropagation();
      openRatingDialog(discoverItemFromButton(discoverRateButton));
      return;
    }

    const discoverListButton = event.target.closest("[data-discover-add-list]");
    if (discoverListButton) {
      event.preventDefault();
      event.stopPropagation();
      openAddToListDialog(discoverItemFromButton(discoverListButton));
      return;
    }

    const discoverDontRecommendButton = event.target.closest("[data-discover-dont-recommend]");
    if (discoverDontRecommendButton) {
      event.preventDefault();
      event.stopPropagation();
      const item = discoverItemFromButton(discoverDontRecommendButton);
      closePosterOverflowMenu();
      dontRecommendDiscoverItem(item)
        .then(() => setMessage(`${item.title || "This title"} won't be recommended again.`, "success"))
        .catch((error) => setMessage(error.message, "error"));
      return;
    }

  });

  elements.syncProgressIndicator?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/sync-activity");
  });

  elements.sidebarSyncAttentionButton?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/sync-activity");
  });

  elements.syncActivityAttention?.addEventListener("click", async (event) => {
    const matchDismiss = event.target.closest("[data-sync-attention-match-dismiss-id]");
    if (matchDismiss && !matchDismiss.disabled) {
      const id = String(matchDismiss.dataset.syncAttentionMatchDismissId || "").trim();
      const title = String(matchDismiss.dataset.syncAttentionMatchDismissTitle || "this item").trim();
      if (!id) return;
      const confirmed = await openConfirmDialog({
        title: "Remove from match issues?",
        body: `Keep the local watch history for "${title}", but stop reporting this unresolved media match in Sync Activity. You can still use Fix match later to add the correct identity or YouTube URL.`,
        confirmLabel: "Remove from issues",
      });
      if (!confirmed) return;
      const matchRow = matchDismiss.closest(".sync-attention-match-row");
      const matchActions = matchRow?.querySelectorAll("button") || [];
      const originalText = matchDismiss.textContent;
      const originalLabel = matchDismiss.getAttribute("aria-label");
      matchRow?.classList.add("sync-attention-match-row--removing");
      matchActions.forEach((button) => { button.disabled = true; });
      matchDismiss.textContent = "Removing…";
      matchDismiss.setAttribute("aria-label", "Removing match issue");
      try {
        const response = await fetch("/api/sync-match-report/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || "Could not remove this match issue.");
        matchRow?.classList.remove("sync-attention-match-row--removing");
        matchRow?.classList.add("sync-attention-match-row--removed");
        setMessage(`Removed "${title}" from match issues. Local watch history was kept.`, "success");
        await new Promise((resolve) => setTimeout(resolve, 240));
        matchRow?.remove();
        try {
          await _cb.loadSyncActivity?.({ force: true, page: 1 });
        } catch (refreshError) {
          setMessage(
            `Removed "${title}" from match issues. Local history was kept, but Sync Activity could not refresh yet.`,
            "warning",
          );
        }
      } catch (error) {
        setMessage(error.message || "Could not remove this match issue.", "error");
        matchRow?.classList.remove("sync-attention-match-row--removing");
        matchActions.forEach((button) => { button.disabled = false; });
        if (matchDismiss.isConnected) {
          matchDismiss.textContent = originalText;
          if (originalLabel == null) matchDismiss.removeAttribute("aria-label");
          else matchDismiss.setAttribute("aria-label", originalLabel);
        }
      }
      return;
    }

    const matchFix = event.target.closest("[data-sync-attention-match-fix-id]");
    if (matchFix && !matchFix.disabled) {
      const id = String(matchFix.dataset.syncAttentionMatchFixId || "").trim();
      const mediaType = String(matchFix.dataset.syncAttentionMatchFixType || "movie").trim().toLowerCase() === "episode" ? "episode" : "movie";
      const title = String(matchFix.dataset.syncAttentionMatchFixTitle || "").trim();
      if (!id || !title) {
        setMessage("This match issue does not contain enough information to fix the media identity.", "error");
        return;
      }
      matchFix.disabled = true;
      _cb.openFixMatchDialog?.(null, id, title, mediaType, async () => {
        setMessage("Match updated. Refreshing Sync Activity to confirm the issue is resolved.", "success");
        await _cb.loadSyncActivity?.({ force: true, page: 1 });
      }, {
        headerTitle: `Fix match · ${title}`,
        onCancel: () => {
          if (matchFix.isConnected) matchFix.disabled = false;
        },
      });
      return;
    }

    const clientRetry = event.target.closest("[data-sync-client-retry]");
    if (clientRetry && !clientRetry.disabled) {
      const id = String(clientRetry.dataset.syncClientRetry || "");
      try {
        const result = await _cb.retryClientAttention?.(id);
        setMessage(result?.rejected ? "The watch update was retried, but some items were rejected." : "Watch update retried successfully.", result?.rejected ? "warning" : "success");
        await _cb.loadSyncActivity?.({ force: true, page: 1 });
      } catch (error) {
        setMessage(error.message || "Could not retry the watch update.", "error");
      }
      return;
    }

    const fixMatch = event.target.closest("[data-sync-attention-fix-match]");
    if (fixMatch && !fixMatch.disabled) {
      const id = String(fixMatch.dataset.syncAttentionFixMatch || "");
      const itemKey = String(fixMatch.dataset.syncAttentionItemKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const issue = parent?.context?.issueItems?.find((candidate) => String(candidate.key || candidate.sourceRowId || "") === itemKey);
      if (!issue) {
        setMessage("That restore issue is no longer available. Refresh Sync Activity and try again.", "error");
        return;
      }
      fixMatch.disabled = true;
      try {
        await openSyncAttentionFixMatch(issue);
      } catch (error) {
        setMessage(error.message || "Could not open Fix match.", "error");
      } finally {
        if (fixMatch.isConnected) fixMatch.disabled = false;
      }
      return;
    }

    const retryShow = event.target.closest("[data-sync-attention-retry-show]");
    if (retryShow && !retryShow.disabled) {
      const id = String(retryShow.dataset.syncAttentionRetryShow || "");
      const showKey = String(retryShow.dataset.syncAttentionShowKey || "");
      try {
        const result = await _cb.retrySyncAttentionShow?.(id, showKey);
        setMessage(result?.message || "Show retry complete.", result?.failed > 0 ? "warning" : "success");
      } catch (error) {
        setMessage(error.message || "Could not retry this show.", "error");
      }
      return;
    }

    const skipShow = event.target.closest("[data-sync-attention-skip-show]");
    if (skipShow && !skipShow.disabled) {
      const id = String(skipShow.dataset.syncAttentionSkipShow || "");
      const showKey = String(skipShow.dataset.syncAttentionShowKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const allIssues = Array.isArray(parent?.context?.issueItems) ? parent.context.issueItems : [];
      const showIssues = allIssues.filter((issue) => {
        const explicit = String(issue.showTitle || issue.show_title || "").trim();
        const title = String(issue.title || "").trim();
        const stripped = explicit || title.replace(/\s*-?\s*S\d{1,3}E\d{1,3}\b.*$/i, "").trim() || title;
        return String(stripped).toLowerCase().replace(/[^a-z0-9]+/g, "").trim() === showKey;
      });
      const showTitle = showIssues[0]?.showTitle || showIssues[0]?.show_title || "this show";
      const count = showIssues.length || 1;
      const confirmed = await openConfirmDialog({
        title: `Skip all plays for ${showTitle}?`,
        body: `${count} ${count === 1 ? "play" : "plays"} for "${showTitle}" will remain missing from Trakt. The restore fence stays active until every remaining issue is repaired or skipped.`,
        confirmLabel: `Skip ${count} ${count === 1 ? "play" : "plays"}`,
      });
      if (!confirmed) return;
      try {
        const result = await _cb.skipSyncAttentionShow?.(id, showKey);
        setMessage(result?.message || `Plays for "${showTitle}" skipped.`, result?.released ? "warning" : "muted");
      } catch (error) {
        setMessage(error.message || `Could not skip plays for "${showTitle}".`, "error");
      }
      return;
    }

    const toggleShow = event.target.closest("[data-sync-attention-toggle-show]");
    if (toggleShow) {
      if (event.target.closest("button, a, input")) return;
      const id = String(toggleShow.dataset.syncAttentionToggleShow || "");
      const showKey = String(toggleShow.dataset.syncAttentionShowKey || "");
      const actionKey = `${id}:${showKey}`;
      if (!state.syncAttentionExpandedShows) state.syncAttentionExpandedShows = new Set();
      if (state.syncAttentionExpandedShows.has(actionKey)) {
        state.syncAttentionExpandedShows.delete(actionKey);
      } else {
        state.syncAttentionExpandedShows.add(actionKey);
      }
      _cb.renderSyncAttention?.();
      return;
    }

    const retryItem = event.target.closest("[data-sync-attention-retry-item]");
    if (retryItem && !retryItem.disabled) {
      const id = String(retryItem.dataset.syncAttentionRetryItem || "");
      const itemKey = String(retryItem.dataset.syncAttentionItemKey || "");
      try {
        const result = await _cb.retrySyncAttentionItem?.(id, itemKey);
        setMessage(result?.message || "The restored item was repaired.", "success");
      } catch (error) {
        setMessage(error.message || "Could not retry this restored item.", "error");
      }
      return;
    }

    const skipItem = event.target.closest("[data-sync-attention-skip-item]");
    if (skipItem && !skipItem.disabled) {
      const id = String(skipItem.dataset.syncAttentionSkipItem || "");
      const itemKey = String(skipItem.dataset.syncAttentionItemKey || "");
      const parent = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
      const issue = parent?.context?.issueItems?.find((candidate) => String(candidate.key) === itemKey);
      const confirmed = await openConfirmDialog({
        title: "Skip this restored play?",
        body: `${issue?.title || "This play"} will remain missing from Trakt. The restore fence stays active until every remaining issue is repaired or skipped.`,
        confirmLabel: "Skip this play",
      });
      if (!confirmed) return;
      try {
        const result = await _cb.skipSyncAttentionItem?.(id, itemKey);
        setMessage(result?.message || "Restore play skipped.", result?.released ? "warning" : "muted");
      } catch (error) {
        setMessage(error.message || "Could not skip this restored play.", "error");
      }
      return;
    }

    const skip = event.target.closest("[data-sync-attention-skip]");
    if (!skip || skip.disabled) return;
    const id = String(skip.dataset.syncAttentionSkip || "");
    const item = (state.syncAttention || []).find((candidate) => String(candidate.id) === id);
    const confirmed = await openConfirmDialog({
      title: item?.skipTitle || "Skip this sync issue?",
      body: `${item?.summary || "This sync operation did not complete."}\n\n${item?.skipNote || "Skipping acknowledges the incomplete projection and releases the restore fence when it belongs to this issue. The missing remote records will not be created automatically."}`,
      confirmLabel: item?.skipLabel || "Skip and resume sync",
    });
    if (!confirmed) return;
    try {
      const result = await _cb.skipSyncAttention?.(id);
      setMessage(result?.message || "Sync issue skipped.", result?.released ? "warning" : "muted");
    } catch (error) {
      setMessage(error.message || "Could not skip this sync issue.", "error");
    }
  });

  elements.syncAttention?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const toggleShow = event.target.closest("[data-sync-attention-toggle-show]");
    if (!toggleShow) return;
    event.preventDefault();
    toggleShow.click();
  });

  elements.appVersion?.addEventListener("click", () => {
    closeMobileMenu();
    navigateTo("/settings/changelog");
  });

  const aboutShareProjectUrl = () => elements.aboutShareButton?.dataset.shareUrl || "https://github.com/Lasikiewicz/plekt";
  const aboutShareData = () => ({
    title: "Plekt",
    text: "Plekt — the local brain for your media stack.",
    url: aboutShareProjectUrl(),
  });
  const setAboutShareStatus = (message = "") => {
    if (elements.aboutShareStatus) elements.aboutShareStatus.textContent = message;
  };
  const closeAboutShareModal = () => {
    if (!elements.aboutShareModal) return;
    elements.aboutShareModal.classList.add("hidden");
    setAboutShareStatus();
    elements.aboutShareButton?.focus();
  };
  const updateAboutShareLinks = () => {
    const data = aboutShareData();
    const encodedUrl = encodeURIComponent(data.url);
    const encodedText = encodeURIComponent(data.text);
    const shareLinks = {
      x: `https://x.com/intent/post?text=${encodedText}&url=${encodedUrl}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      reddit: `https://www.reddit.com/submit?url=${encodedUrl}&title=${encodeURIComponent(data.title)}`,
      whatsapp: `https://api.whatsapp.com/send?text=${encodeURIComponent(`${data.text} ${data.url}`)}`,
      telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
      email: `mailto:?subject=${encodeURIComponent("Plekt")}&body=${encodeURIComponent(`${data.text}\n\n${data.url}`)}`,
    };

    elements.aboutShareModal?.querySelectorAll("[data-about-share-network]").forEach((link) => {
      const href = shareLinks[link.dataset.aboutShareNetwork];
      if (href) link.href = href;
    });
  };

  if (elements.aboutShareNativeButton) {
    elements.aboutShareNativeButton.classList.toggle("hidden", typeof navigator.share !== "function");
  }
  elements.aboutShareButton?.addEventListener("click", () => {
    updateAboutShareLinks();
    setAboutShareStatus();
    elements.aboutShareModal?.classList.remove("hidden");
    elements.aboutShareModalClose?.focus();
  });
  elements.aboutShareModalClose?.addEventListener("click", closeAboutShareModal);
  elements.aboutShareModal?.addEventListener("click", (event) => {
    if (event.target === elements.aboutShareModal) closeAboutShareModal();
  });
  elements.aboutShareCopyButton?.addEventListener("click", async () => {
    try {
      await copyToClipboard(aboutShareProjectUrl(), elements.aboutShareCopyButton);
      setAboutShareStatus("Project link copied.");
    } catch {
      setAboutShareStatus("Copy the GitHub project link to share Plekt.");
    }
  });
  elements.aboutShareNativeButton?.addEventListener("click", async () => {
    try {
      await navigator.share(aboutShareData());
      setAboutShareStatus("Share sheet opened.");
    } catch (error) {
      if (error?.name !== "AbortError") setAboutShareStatus("The device share sheet could not be opened.");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.aboutShareModal && !elements.aboutShareModal.classList.contains("hidden")) {
      closeAboutShareModal();
    }
  });

  elements.changelogRefreshButton?.addEventListener("click", () => {
    renderChangelog(true).catch(() => { });
  });

  elements.lockButton.addEventListener("click", () => {
    closeMobileMenu();
    lockDashboard();
  });
  if (elements.themeToggleButton) {
    elements.themeToggleButton.addEventListener("click", (...args) => _cb.toggleTheme?.(...args));
  }
  elements.closeModalButton.addEventListener("click", closeDebugModal);
  elements.debugModal.addEventListener("click", (event) => {
    if (event.target === elements.debugModal) closeDebugModal();
  });

  if (elements.closePersonModalButton) {
    elements.closePersonModalButton.addEventListener("click", () => {
      closePersonProfile();
    });
  }
  if (elements.personModal) {
    elements.personModal.addEventListener("click", (event) => {
      if (event.target === elements.personModal) {
        closePersonProfile();
      }
    });
  }

  const closeConfirmModal = () => {
    if (elements.confirmModal) elements.confirmModal.classList.add("hidden");
  };
  if (elements.closeConfirmModalButton) {
    elements.closeConfirmModalButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.cancelConfirmButton) {
    elements.cancelConfirmButton.addEventListener("click", closeConfirmModal);
  }
  if (elements.confirmModal) {
    elements.confirmModal.addEventListener("click", (event) => {
      if (event.target === elements.confirmModal) closeConfirmModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const topnav = document.querySelector(".topnav");
      if (topnav?.classList.contains("nav-open")) {
        closeMobileMenu();
        document.getElementById("hamburgerButton")?.focus({ preventScroll: true });
        return;
      }
      if (document.querySelector(".media-info-overlay")) {
        closeMediaInfoModal();
        return;
      }
      if (elements.personModal && !elements.personModal.classList.contains("hidden")) {
        closePersonProfile();
      } else {
        closeMediaDetail();
      }
      closeConfirmModal();
      elements.terminalModal?.classList.add("hidden");
    }
  });

  // Wheel scrolling a horizontal row sideways only engages after the pointer has
  // rested on that row for a moment. Without the delay a vertical page scroll that
  // merely passes over one of these rows is swallowed by its horizontal scrolling.
  const horizontalWheelRowSelector = ".horizontal-scroll-row, .trailer-scroll-row, .cast-scroll-row, .media-images-scroll-row";
  const horizontalWheelArmDelayMs = 240;
  let hoveredWheelRow = null;
  let armedWheelRow = null;
  let wheelArmTimer = 0;

  const clearWheelArm = () => {
    window.clearTimeout(wheelArmTimer);
    wheelArmTimer = 0;
    armedWheelRow = null;
  };

  // (Re)start the hover delay from now.
  const restartWheelArm = () => {
    window.clearTimeout(wheelArmTimer);
    armedWheelRow = null;
    wheelArmTimer = window.setTimeout(() => {
      wheelArmTimer = 0;
      armedWheelRow = hoveredWheelRow;
    }, horizontalWheelArmDelayMs);
  };

  document.addEventListener("pointerover", (event) => {
    const row = event.target instanceof Element ? event.target.closest(horizontalWheelRowSelector) : null;
    // Boundary events also fire for children of the row the pointer already rests on
    // (including while that row scrolls sideways), so only a row change restarts the delay.
    if (row === hoveredWheelRow) return;
    hoveredWheelRow = row;
    clearWheelArm();
    if (row) restartWheelArm();
  }, { passive: true });

  const wheelScrollTargets = new WeakMap();
  document.addEventListener("wheel", (e) => {
    const row = e.target.closest(horizontalWheelRowSelector);
    if (!row) return;
    if (row.scrollWidth <= row.clientWidth) return;
    // Let native horizontal gestures (trackpad swipe) pass through untouched.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // The wheel is still being used to move down the page (each notch pushes the hover
    // delay out), so the page keeps scrolling until the pointer actually rests on the row.
    if (armedWheelRow !== row) {
      hoveredWheelRow = row;
      restartWheelArm();
      return;
    }

    // Normalise delta to pixels regardless of the device's wheel mode.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= row.clientWidth;

    const maxScroll = row.scrollWidth - row.clientWidth;
    const atLeft = row.scrollLeft <= 0;
    const atRight = Math.ceil(row.scrollLeft + row.clientWidth) >= row.scrollWidth;
    // At an edge in the scroll direction, release the wheel back to the page.
    if ((delta > 0 && atRight) || (delta < 0 && atLeft)) {
      wheelScrollTargets.delete(row);
      return;
    }
    e.preventDefault();

    const current = wheelScrollTargets.has(row) ? wheelScrollTargets.get(row) : row.scrollLeft;
    const target = Math.max(0, Math.min(maxScroll, current + delta));
    wheelScrollTargets.set(row, target);

    if (!row._wheelRAF) {
      const step = () => {
        const goal = wheelScrollTargets.get(row);
        if (goal == null) {
          row._wheelRAF = null;
          return;
        }
        const diff = goal - row.scrollLeft;
        if (Math.abs(diff) < 0.5) {
          row.scrollLeft = goal;
          wheelScrollTargets.delete(row);
          row._wheelRAF = null;
          return;
        }
        row.scrollLeft += diff * 0.2;
        row._wheelRAF = requestAnimationFrame(step);
      };
      row._wheelRAF = requestAnimationFrame(step);
    }
  }, { passive: false });


  document.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const statusDot = event.target.closest?.("[data-sync-status-dot]");
    if (!statusDot) return;
    const historyRow = statusDot.closest("[data-history-id]");
    if (!historyRow) return;
    event.preventDefault();
    openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
  });

  elements.globalSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeGlobalSearchDropdown();
      elements.globalSearchInput.blur();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = document.querySelector(".global-search-result");
      first?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const firstResult = document.querySelector(".global-search-result");
    if (firstResult) {
      firstResult.click();
      return;
    }
    closeGlobalSearchDropdown();
    const query = elements.globalSearchInput.value.trim();
    if (query) {
      navigateTo(`/search?q=${encodeURIComponent(query)}`);
    }
  });

  elements.globalSearchInput?.addEventListener("input", () => {
    const query = elements.globalSearchInput.value.trim();
    window.clearTimeout(state.globalSearchDropdownTimer);
    window.clearTimeout(state.globalSearchRemoteTimer);
    if (!query) { closeGlobalSearchDropdown(); }
    else {
      renderGlobalSearchDropdown(query);
      state.globalSearchRemoteTimer = window.setTimeout(() => loadGlobalDiscovery(query), 260);
    }
  });

  // Browsers ignore autocomplete="off" and will dump the saved login username into
  // the first text field on load. The search box ships read-only so the password
  // manager can't autofill it; unlock it the moment the user actually interacts.
  const unlockGlobalSearch = () => elements.globalSearchInput?.removeAttribute("readonly");
  elements.globalSearchInput?.addEventListener("pointerdown", unlockGlobalSearch);
  elements.globalSearchInput?.addEventListener("focus", unlockGlobalSearch);

  const unlockExplorerSearch = () => elements.explorerSearchInput?.removeAttribute("readonly");
  elements.explorerSearchInput?.addEventListener("pointerdown", unlockExplorerSearch);
  elements.explorerSearchInput?.addEventListener("focus", unlockExplorerSearch);

  elements.globalSearchInput?.addEventListener("focus", () => {
    const query = elements.globalSearchInput.value.trim();
    if (query) renderGlobalSearchDropdown(query);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".global-search")) closeGlobalSearchDropdown();
  });

  document.querySelectorAll(".search-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".search-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.searchFilter = btn.dataset.filter;
      renderSearchPage();
    });
  });

  document.getElementById("searchViewResults")?.addEventListener("click", (e) => {
    const loadMorePeople = e.target.closest("[data-search-load-more-people]");
    if (loadMorePeople) {
      e.stopPropagation();
      loadMoreSearchPeople();
      return;
    }
    const collectionToggle = e.target.closest("[data-search-collection]");
    if (collectionToggle) {
      e.preventDefault();
      e.stopPropagation();
      loadSearchCollection(collectionToggle.dataset.searchCollection);
      return;
    }
    const card = e.target.closest(".explorer-overview-card");
    if (card && card.dataset.href) {
      navigateTo(card.dataset.href);
    }
  });

  window.addEventListener("error", (event) => {
    logDebug("Global browser error captured.", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logDebug("Global unhandled promise rejection captured.", {
      reason: event.reason?.message || String(event.reason || "unknown"),
    });
  });

  window.addEventListener("resize", () => {
    syncPageTopbar();
    syncMediaActionsMenuState();
    window.clearTimeout(state.dashboardHistoryResizeTimer);
    state.dashboardHistoryResizeTimer = window.setTimeout(() => {
      if (state.activeView === "dashboard") renderDashboard();
    }, 120);
  });

  window.addEventListener("scroll", () => {
    if (state.activeView !== "explorer" && state.activeView !== "history" && state.activeView !== "upcoming") return;
    if (state.activeView === "explorer") {
      state.explorerScrollArmed = true;
    } else if (state.activeView === "history") {
      state.historyViewScrollArmed = true;
    }
    if (state.posterHydrateScrollScheduled) return;
    state.posterHydrateScrollScheduled = true;
    window.requestAnimationFrame(() => {
      state.posterHydrateScrollScheduled = false;
      const container = state.activeView === "explorer"
        ? elements.explorerPanel
        : state.activeView === "history"
          ? elements.historyPanel
          : elements.upcomingCalendar;
      hydratePosters(container);
    });
  }, { passive: true });

  // Now Playing polling runs on every view, not just the dashboard, so this must
  // restart it on every view too. Gating the restart on the dashboard while
  // pollNowPlayingOnce() stops the interval from any view left the poll dead
  // after a tab was backgrounded anywhere else: nothing restarted it until the
  // next navigation, so watch state and Now Playing silently stopped updating.
  const resumeNowPlayingPolling = () => {
    if (!state.token || document.hidden) return;
    startHistoryPolling({ force: true });
  };

  document.addEventListener("visibilitychange", () => {
    if (!state.token) return;
    if (document.hidden) {
      stopHistoryPolling();
      return;
    }
    resumeNowPlayingPolling();
  });
  // Mobile browsers may restore a suspended/bfcache page without emitting a
  // useful visibility transition. Both events are resume boundaries, so force
  // a fresh snapshot instead of trusting the page's old in-memory cards.
  window.addEventListener("pageshow", resumeNowPlayingPolling);
  window.addEventListener("focus", resumeNowPlayingPolling);

  window.addEventListener("popstate", () => {
    state.internalHistoryCount = history.state?.index || 0;
    const path = window.location.pathname + window.location.search + window.location.hash;
    closeMobileMenu();
    _cb.resetPageEntryState?.(path);
    handleRouting(path);
    applyActiveView();
  });

  // Keep the legacy Part Watched panel fallbacks for older embeds. The current
  // dashboard renders resume cards through the mixed Up Next rail.
  (elements.partWatchedRows || elements.partWatchedPanel || elements.timelineView)?.addEventListener("click", async (event) => {
    const posterLink = event.target.closest("[data-part-watched-href]");
    if (posterLink) {
      event.preventDefault();
      navigateTo(posterLink.dataset.partWatchedHref);
      return;
    }
    const watchBtn = event.target.closest("[data-action-watch]");
    const unwatchBtn = event.target.closest("[data-action-unwatch]");
    if (!watchBtn && !unwatchBtn) return;

    const btn = watchBtn || unwatchBtn;
    const mediaKey = watchBtn ? watchBtn.dataset.actionWatch : unwatchBtn.dataset.actionUnwatch;
    const title = watchBtn ? watchBtn.dataset.title : unwatchBtn.dataset.title;
    event.preventDefault();
    event.stopPropagation();

    if (watchBtn) {
      const entry = state.partWatchedRaw.find(e => e.media_key === mediaKey);
      if (entry) {
        if (entry.media_type === "movie") {
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "movie",
            mediaKey: entry.media_key,
            title: entry.title,
            movie: {
              title: entry.title,
              tmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
            },
            label: `Mark ${entry.title} watched`,
            lastPlayedAt: entry.updated_at,
          };
        } else {
          const showTitle = entry.show_title || showTitleFrom(entry.title);
          state.pendingWatchAction = {
            origin: "part-watched",
            scope: "episode",
            mediaKey: entry.media_key,
            title: entry.title,
            showTitle: showTitle,
            episodes: [{
              seasonNumber: entry.season,
              episodeNumber: entry.episode,
              title: entry.episode_title || entry.title,
              showTmdbId: entry.tmdb_id,
              imdbId: entry.imdb_id,
              tvdbId: entry.tvdb_id,
              posterUrl: entry.poster_url || entry.imageUrl || entry.thumb || null,
              key: entry.media_key,
              airDate: entry.airDate || entry.air_date || null,
            }],
            label: `Mark ${showTitle} watched`,
            countLabel: `Season ${entry.season} · Episode ${entry.episode}`,
            lastPlayedAt: entry.updated_at,
          };
        }
        openWatchDatePrompt(state.pendingWatchAction);
      }
    } else if (unwatchBtn) {
      const entry = state.partWatchedRaw.find(e => e.media_key === mediaKey);
      const isEpisode = entry?.media_type === "episode";
      const displayTitle = isEpisode ? (entry.show_title || showTitleFrom(entry.title)) : (entry?.title || title);
      const progressPercent = Math.round(entry?.progress || 0);
      const sources = entry ? (Array.isArray(entry.sources) && entry.sources.length ? entry.sources : (entry.source ? [entry.source] : [])) : [];
      const sourceLabel = sources.length ? sources.map(platformName).join(", ") : "the originating server";

      let mediaHtml = "";
      if (entry) {
        mediaHtml = `
          ${posterMarkup(entry, "confirm-modal-media-poster")}
          <div class="confirm-modal-media-info">
            <span class="confirm-modal-media-title">${escapeHtml(displayTitle)}</span>
            <span class="confirm-modal-media-meta">
              ${isEpisode ? `<span>${escapeHtml(episodeCode(entry.season, entry.episode))}</span>` : ""}
              <span>${progressPercent}% watched</span>
            </span>
          </div>
        `;
      }

      const message = `This will clear the saved playback progress for "${title}", mark it as unwatched, and remove it from your Part Watched list.\n\nThe unwatched status will also be sent back to ${sourceLabel} and propagated to any other connected media servers, so it stays in sync everywhere.`;

      showConfirmModal(message, async () => {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Clearing...";
        try {
          const res = await fetch("/api/playback-progress/unwatch", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ media_key: mediaKey }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setMessage(
            body.queued
              ? `Progress cleared for "${title}"; unwatched sync queued until the current blocking operation completes`
              : `Progress cleared for "${title}"`,
            "success",
          );
          resetPartWatchedView("default");
          renderPartWatched();
          await loadUpNext({ force: true });
        } catch (error) {
          showErrorExplainModal(`Failed to clear progress for "${title}"`, error.message);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }, { title: "Clear Progress", mediaHtml });
    }
  });

  elements.closeTerminalModalButton?.addEventListener("click", () => {
    elements.terminalModal?.classList.add("hidden");
  });

  elements.terminalModal?.addEventListener("click", (event) => {
    if (event.target === elements.terminalModal) {
      elements.terminalModal.classList.add("hidden");
    }
  });
}
