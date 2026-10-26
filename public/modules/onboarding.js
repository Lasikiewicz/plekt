// Guided first-run setup (`/setup`). Talks to the /api/setup/* endpoints
// added alongside this module and reuses the same Settings building blocks
// wherever possible - openServiceEditModal() for every provider connect/test
// flow, and the webhook-guide functions - so setup and Settings never diverge
// in behavior, only in presentation.
import { createOnboardingSections } from "./onboarding-sections.js?v=2.1.1.1.0";
import { createOnboardingTrackers } from "./onboarding-trackers.js?v=2.1.1.1.0";
import { state, elements } from "./state.js?v=2.1.1.1.0";
import { escapeHtml, escapeAttribute, isDemoMode } from "./utils.js?v=2.1.1.1.0";
import { setupSwitchMarkup } from "./supervisor-switch.js?v=2.1.1.1.0";
import { openServiceEditModal } from "./settings-services.js?v=2.1.1.1.0";
import { claimAdminAccount } from "./auth.js?v=2.1.1.1.0";
import { lazyExport, loadRouteModule, loadedRouteModule } from "./route-modules.js?v=2.1.1.1.0";
import {
  plexHistoricalSyncEnabled,
} from "./plex-history-policy.js?v=2.1.1.1.0";

let _cb = {};
const loadWatchBackups = lazyExport("tools-backups", "loadWatchBackups");
const loadPlektBackups = lazyExport("tools-backups", "loadPlektBackups");
export function initOnboarding(callbacks = {}) {
  _cb = callbacks;
  document.addEventListener("click", handleSetupClick);
  document.addEventListener("change", handleSetupChange);
  // A Settings modal (connect/save/disconnect) can change server/metadata
  // state while the wizard is open behind it - refresh so the step reflects
  // it as soon as the modal closes, without polling.
  document.addEventListener("plembfin:config-changed", () => {
    // A connection can be finished from Settings directly, outside the wizard
    // - always refresh so the sidebar onboarding CTA (and the wizard itself,
    // if it happens to be open behind a Settings modal) reflect it.
    loadSetupStatus().catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.activeView === "setup") trackers.checkFlows();
  });
}

const authHeaders = (...args) => _cb.authHeaders?.(...args) || {};
const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const setUnlocked = (...args) => _cb.setUnlocked?.(...args);
const loadHistory = (...args) => _cb.loadHistory?.(...args) || Promise.resolve();
const loadSavedConfig = (...args) => _cb.loadSavedConfig?.(...args) || Promise.resolve();
const startHistoryPolling = (...args) => _cb.startHistoryPolling?.(...args);

export function setClaimRequired(isRequired) {
  const required = Boolean(isRequired);
  state.claimRequired = required;
  elements.authPanelSignIn?.classList.toggle("hidden", required);
  elements.claimPanel?.classList.add("hidden");
  if (required) {
    ensurePreClaimStatus();
    state.activeView = "setup";
    renderSetupPage();
  } else {
    homeClaimPanel();
  }
}

export async function claimWithForm(username, password, confirmPassword) {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername || !password) {
    elements.claimMessage.textContent = "Choose a username and password.";
    elements.claimMessage.dataset.tone = "error";
    return;
  }
  if (password !== confirmPassword) {
    elements.claimMessage.textContent = "Passwords do not match.";
    elements.claimMessage.dataset.tone = "error";
    return;
  }
  const result = await claimAdminAccount(cleanUsername, password, confirmPassword);
  state.currentUser = result.user;
  state.token = result.token;
  state.claimRequired = false;
  cachedStatus = null;
  if (elements.settingsUsername) elements.settingsUsername.value = cleanUsername;
  localStorage.setItem("adminUsername", cleanUsername);
  setClaimRequired(false);
  setUnlocked(true);
  navigateTo("/setup");
  await loadHistory().catch(() => {});
  await loadSavedConfig().catch(() => {});
  startHistoryPolling();
}

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const STEPS = [
  { id: "overview", label: "Overview" },
  { id: "trackers", label: "Trackers" },
  { id: "metadata", label: "Metadata" },
  { id: "servers", label: "Media Servers" },
  { id: "webhooks", label: "Webhooks" },
  { id: "seerr", label: "Seerr" },
  { id: "backup", label: "Backup" },
  { id: "imports", label: "Import & sync" },
  { id: "options", label: "Options" },
  { id: "review", label: "Review" },
];
const SKIPPABLE_STEPS = new Set(["servers", "metadata", "webhooks", "seerr", "backup"]);
const STEP_TITLES = {
  overview: "Set up Plekt",
  servers: "Connect media servers",
  metadata: "Add metadata",
  webhooks: "Enable reliable updates",
  seerr: "Connect Seerr",
  trackers: "Connect watch trackers",
  imports: "Import progress",
  options: "Choose your options",
  backup: "Protect your Plekt data",
  review: "Review and finish",
};

let cachedStatus = null;
let statusLoading = null;
let importStatusPollTimer = null;
let backupSetupData = null;
let backupSetupLoading = null;
// null (normal wizard steps) | "choice" | "local" | "remote" - see
// renderRestoreView() and the overview step's "Restore from backup" button.
let restoreView = null;

function isPreClaimSetup() {
  return state.claimRequired === true && !state.token;
}

function createPreClaimStatus() {
  return {
    onboarding: {
      version: 0,
      currentOnboardingVersion: 2,
      accountClaimed: false,
      runState: "not_started",
      currentStep: "overview",
      startedAt: null,
      completedAt: null,
      acknowledgements: { webhooks: {}, trackersSkipped: false },
      backgroundImports: {
        servers: {},
        trackers: {},
      },
      pushSync: { status: "not_started", startedAt: null, completedAt: null },
      checklistDismissedAt: null,
      ctaDismissedAt: null,
    },
    servers: [],
    trackers: [],
    metadata: { tmdbConfigured: false, builtInAvailable: { tvdb: false, fanart: false } },
    seerr: { configured: false },
    options: { watchImportMode: null, plexHistoricalWatchedSync: true, fastLocalPacing: false, upNextSync: true },
    watchHistoryCount: 0,
    pushSyncAvailable: false,
    syncLocked: false,
    checklist: [],
  };
}

function ensurePreClaimStatus() {
  if (!cachedStatus) cachedStatus = createPreClaimStatus();
  return cachedStatus;
}

// Keep one claim form in the document so the existing auth event handler
// preserves its validation and error handling when onboarding borrows it.
function homeClaimPanel() {
  const home = document.getElementById("claimPanelHome");
  const panel = document.getElementById("claimPanel");
  if (!home || !panel) return;
  if (panel.parentElement !== home) home.appendChild(panel);
  panel.classList.add("hidden");
  panel.classList.remove("setup-claim-panel");
}

function mountClaimPanel() {
  const host = document.getElementById("setupClaimFormHost");
  const panel = document.getElementById("claimPanel");
  if (!host || !panel) return;
  host.appendChild(panel);
  panel.classList.remove("hidden");
  panel.classList.add("setup-claim-panel");
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Request failed");
    error.code = data.code || "";
    error.status = res.status;
    throw error;
  }
  return data;
}

export async function loadSetupStatus() {
  if (isDemoMode()) {
    cachedStatus = null;
    elements.sidebarOnboardingCta?.classList.add("hidden");
    return null;
  }
  if (isPreClaimSetup()) {
    ensurePreClaimStatus();
    renderSetupPage();
    return cachedStatus;
  }
  if (statusLoading) return statusLoading;
  statusLoading = api("/api/setup/status")
    .then((data) => {
      cachedStatus = data;
      renderSetupPage();
      renderSidebarOnboardingCta();
      return data;
    })
    .catch((error) => {
      // Setup endpoints remain protected until the instance is claimed. The
      // auth bootstrap will also report this state, but handling the response
      // here keeps a direct /setup load from getting stuck on an API error.
      if (error.code === "CLAIM_REQUIRED") {
        state.claimRequired = true;
        ensurePreClaimStatus();
        state.activeView = "setup";
        renderSetupPage();
        return cachedStatus;
      }
      throw error;
    })
    .finally(() => { statusLoading = null; });
  return statusLoading;
}

// Compact setup reminder in the sidebar. The detailed task list is no longer
// rendered across the dashboard; this entry point opens the wizard and can be
// dismissed alongside the server-derived checklist.
export function renderSidebarOnboardingCta() {
  const container = elements.sidebarOnboardingCta;
  if (!container || !cachedStatus) return;
  if (isDemoMode()) {
    container.classList.add("hidden");
    return;
  }
  const hasSetupTasks = Array.isArray(cachedStatus.checklist) && cachedStatus.checklist.length > 0;
  const dismissed = Boolean(cachedStatus.onboarding.checklistDismissedAt || cachedStatus.onboarding.ctaDismissedAt);
  container.classList.toggle("hidden", !hasSetupTasks || dismissed);
}

async function loadBackupSetupData({ force = false } = {}) {
  if (backupSetupLoading) return backupSetupLoading;
  if (backupSetupData && !force) return backupSetupData;
  backupSetupLoading = Promise.all([api("/api/plembfin-backups"), api("/api/watch-backups")])
    .then(([plembfin, watch]) => {
      backupSetupData = { plembfin, watch };
      if (currentStep() === "backup" || restoreView === "remote") renderSetupPage();
      return backupSetupData;
    })
    .catch((error) => {
      setMessage(error.message, "error");
      return null;
    })
    .finally(() => { backupSetupLoading = null; });
  return backupSetupLoading;
}

// Checked by default but not started until Continue is clicked on the
// servers step (see startPendingServerImports) - checking the box before
// then would defeat the point of being able to opt a server out first.
const pendingServerImportChoice = new Map();
// Watchlist sync is on unless the user clears it here. This is first-run setup,
// so an untouched box means "keep the default", not "the stored value" - the
// stored value is still the pre-setup default of off at this point.
let pendingWatchlistChoice = null;
// Options are applied together when the user continues past the Options step,
// so a radio/toggle change is only an in-wizard choice until it is accepted.
let pendingWatchImportMode = null;
let pendingFastLocalPacing = null;
let pendingUpNextSync = null;
let pendingPlexHistoricalSync = null;
// Season source (TVDB or TMDB) is picked on the metadata step and saved when
// the step is left, the same as the options above.
let pendingSeasonSource = null;

const WATCH_IMPORT_MODES = Object.freeze([
  { value: "review", label: "Require review", description: "Hold the item for a decision in Manual Watch review." },
  { value: "now", label: "Mark as watched now", description: "Use the time the scanner sees the watched flag." },
  { value: "release_day", label: "Mark as watched on release day", description: "Use the movie or episode release date." },
  { value: "episode_timing", label: "Mark as watched at the same time as other episodes", description: "Use the before/after timing from the media pages." },
]);

const sections = createOnboardingSections({
  getStatus: () => cachedStatus, getBackupData: () => backupSetupData,
  MEDIA_SERVERS, WATCH_IMPORT_MODES, isPreClaimSetup, serverImportPending, watchlistSyncPending,
  seasonSourcePending, setupWatchImportMode, setupFastLocalPacing, setupUpNextSync, setupPlexHistoricalSync,
  currentStep, api, setMessage, loadBackupSetupData,
});
const { renderOverview, renderServers, renderMetadata, renderWebhooks, renderSeerr, renderImports, renderOptions, renderBackup, renderReview, updateBackupContinueAction, setPassphraseError, saveBackupSetup, saveBackblazeAction, testBackblazeAction, backblazeDestination, renderBackblazeCard, webhookSetupRequired, importState } = sections;
const trackers = createOnboardingTrackers({ getStatus: () => cachedStatus, api, renderSetupPage, loadSetupStatus, setMessage });

function savedWatchImportMode() {
  const configured = state.savedConfig?.tuning?.watchImportMode ?? cachedStatus?.options?.watchImportMode;
  const value = typeof configured === "object" ? configured?.value : configured;
  return WATCH_IMPORT_MODES.some((option) => option.value === value) ? value : "review";
}

function setupWatchImportMode() {
  return pendingWatchImportMode || savedWatchImportMode();
}

function setupFastLocalPacing() {
  if (pendingFastLocalPacing !== null) return pendingFastLocalPacing;
  if (state.savedConfig?.pacing?.profile) return state.savedConfig.pacing.profile === "fast";
  return cachedStatus?.options?.fastLocalPacing === true;
}

function setupUpNextSync() {
  if (pendingUpNextSync !== null) return pendingUpNextSync;
  if (state.savedConfig?.upNextSync?.enabled !== undefined) return state.savedConfig.upNextSync.enabled !== false;
  return cachedStatus?.options?.upNextSync !== false;
}

function setupPlexHistoricalSync() {
  if (pendingPlexHistoricalSync !== null) return pendingPlexHistoricalSync;
  if (state.savedConfig?.tuning?.plexHistoricalWatchedSync !== undefined) {
    return plexHistoricalSyncEnabled(state.savedConfig);
  }
  return cachedStatus?.options?.plexHistoricalWatchedSync !== false;
}

function serverImportPending(provider) {
  if (pendingServerImportChoice.has(provider)) return pendingServerImportChoice.get(provider);
  const existing = importState(provider);
  return existing ? existing.enabled !== false : true;
}

function watchlistSyncPending() {
  return pendingWatchlistChoice === null ? true : pendingWatchlistChoice;
}

// Applied on Continue rather than on click, for the same reason the import
// toggles are: the choice should not take effect until the step is finished.
async function savePendingWatchlistChoice() {
  const plex = (cachedStatus?.servers || []).find((server) => server.provider === "plex");
  if (!plex?.connected && !plex?.tested) return;
  const enabled = watchlistSyncPending();
  if (state.savedConfig?.watchlistSync?.enabled === enabled) return;
  await api("/api/config", { method: "POST", body: JSON.stringify({ watchlistSync: { enabled } }) })
    .then((body) => { if (body?.config) state.savedConfig = body.config; })
    .catch(() => {});
}

function seasonSourcePending() {
  const value = pendingSeasonSource || state.savedConfig?.metadata?.seasonSource;
  return value === "tmdb" ? "tmdb" : "tvdb";
}

async function saveSeasonSourceChoice() {
  if (pendingSeasonSource === null) return;
  const seasonSource = seasonSourcePending();
  if (state.savedConfig?.metadata?.seasonSource !== seasonSource) {
    const body = await api("/api/config", { method: "POST", body: JSON.stringify({ metadata: { seasonSource } }) });
    if (body?.config) state.savedConfig = body.config;
  }
  pendingSeasonSource = null;
}

async function saveSetupOptions() {
  const mode = setupWatchImportMode();
  const fastLocalPacing = setupFastLocalPacing();
  const upNextSync = setupUpNextSync();
  const plexHistoricalWatchedSync = setupPlexHistoricalSync();
  const body = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      tuning: { watchImportMode: mode, plexHistoricalWatchedSync },
      pacing: { profile: fastLocalPacing ? "fast" : "standard" },
      upNextSync: { enabled: upNextSync },
    }),
  });
  if (body?.config) state.savedConfig = body.config;
  pendingWatchImportMode = null;
  pendingFastLocalPacing = null;
  pendingUpNextSync = null;
  pendingPlexHistoricalSync = null;
  document.dispatchEvent(new CustomEvent("plembfin:config-changed", { detail: { refreshSyncTuning: true } }));
}

async function startPendingServerImports() {
  for (const server of cachedStatus?.servers || []) {
    if (!server.tested) continue;
    if (!serverImportPending(server.provider)) continue;
    if (importState(server.provider)) continue; // already started/finished
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target: server.provider, action: "start" }) }).catch(() => {});
  }
  pendingServerImportChoice.clear();
  await savePendingWatchlistChoice();
  await loadSetupStatus();
}

function setCurrentStep(stepId) {
  if (!cachedStatus) ensurePreClaimStatus();
  // Legacy in-progress state may still store "claim"; treat it as Overview.
  if (stepId === "claim") stepId = "overview";
  if (!STEPS.some((step) => step.id === stepId)) return;
  if (isPreClaimSetup() && stepId !== "overview") return;
  cachedStatus.onboarding.currentStep = stepId;
  renderSetupPage();
  if (isPreClaimSetup()) return;
  api("/api/setup/step", { method: "POST", body: JSON.stringify({ currentStep: stepId }) }).catch(() => {});
}

function currentStep() {
  const step = cachedStatus?.onboarding?.currentStep || "overview";
  return step === "claim" ? "overview" : step;
}

function stepDone(id) {
  if (!cachedStatus) return false;
  const { servers, trackers, metadata, seerr, onboarding } = cachedStatus;
  if (id === "overview") return !isPreClaimSetup();
  if (id === "servers") return servers.some((s) => s.tested);
  if (id === "metadata") return Boolean(metadata.tmdbConfigured);
  if (id === "webhooks") return servers.filter((s) => s.tested && webhookSetupRequired(s.provider)).every((s) => onboarding.acknowledgements.webhooks?.[s.provider]);
  if (id === "seerr") return Boolean(seerr?.configured || state.savedConfig?.seerr?.configured);
  if (id === "trackers") return trackers.some((tracker) => tracker.connected) || onboarding.acknowledgements.trackersSkipped;
  if (id === "imports") return true;
  if (id === "options") return Boolean(state.savedConfig?.tuning?.watchImportMode || cachedStatus.options?.watchImportMode);
  if (id === "backup") return Boolean(backupSetupData?.plembfin?.config?.enabled);
  return false;
}

export function renderSetupPage() {
  const root = elements.setupPageRoot;
  if (!root) return;
  clearTimeout(importStatusPollTimer);
  importStatusPollTimer = null;
  // #restore-local/#restore-remote and #oneTimeImportsContent are the exact
  // same DOM Settings uses - every root.innerHTML assignment past this point
  // would otherwise destroy them if they were still parented inside root from
  // a previous render, so always send them home first; the restoreView and
  // imports branches re-borrow what they need once the new markup exists.
  homeRestoreSections();
  homeOneTimeImports();
  homeClaimPanel();
  if (isPreClaimSetup()) ensurePreClaimStatus();
  if (!cachedStatus) {
    root.innerHTML = `<div class="settings-content"><p class="muted-copy">Loading setup...</p></div>`;
    return;
  }
  const logoSrc = document.documentElement.classList.contains("light-mode") ? "/plekt_header_logo_light.png?v=2.1.1.1.0" : "/plekt_header_logo_dark.png?v=2.1.1.1.0";
  if (restoreView) {
    renderRestoreView(root, logoSrc);
    return;
  }
  const step = currentStep();
  const isPreClaim = isPreClaimSetup();
  // No media server is required to finish setup - manually tracking watches
  // (mark watched from a title's page, reached via search) works on its own.
  // This only drives the Review step's nudge styling now, not whether
  // setup can be completed.
  const hasTestedServer = cachedStatus.servers.some((s) => s.tested);
  root.innerHTML = `
    <div class="setup-brand">
      <img class="setup-brand-logo brand-logo" src="${logoSrc}" alt="Plekt" />
    </div>
    <section class="glass-panel p-section setup-shell">
      <div class="section-heading">
        <div><h2>${escapeHtml(STEP_TITLES[step] || "Setup")}</h2></div>
        <div class="setup-header-actions">
          <span>Step ${STEPS.findIndex((s) => s.id === step) + 1} of ${STEPS.length}</span>
          ${isPreClaim ? "" : `<button type="button" class="button-ghost" data-setup-action="exit">Exit to Settings</button>`}
        </div>
      </div>
      <div class="setup-progress" role="tablist" aria-label="Setup progress">
        ${STEPS.map((s) => {
          const locked = isPreClaim && s.id !== "overview";
          return `<button type="button" role="tab" class="segment-button setup-progress-step${s.id === step ? " active" : ""}${stepDone(s.id) ? " done" : ""}" data-setup-step="${s.id}" aria-selected="${s.id === step ? "true" : "false"}"${locked ? " disabled" : ""} title="${escapeAttribute(s.label)}">${escapeHtml(s.label)}</button>`;
        }).join("")}
      </div>
      <div class="setup-step-body">${renderStep(step, hasTestedServer)}</div>
      <div class="setup-actions">
        <span style="display:flex; gap:8px;">
          ${step !== "overview" ? `<button type="button" class="button-ghost" data-setup-action="back">Back</button>` : ""}
        </span>
        ${step === "overview" && isPreClaim
          ? ""
          : step === "review"
          ? `<button type="button" class="button-primary" data-setup-action="complete">Open dashboard</button>`
          : step === "trackers" && !cachedStatus.trackers.some((tracker) => tracker.connected)
            ? `<span style="display:flex; gap:8px;">
                <button type="button" class="button-ghost" data-setup-action="trackers-skip">Skip for now</button>
                <button type="button" class="button-primary" data-setup-action="continue">Continue</button>
              </span>`
            : step === "trackers"
              ? `<span class="setup-continue-group">${trackers.hasSelectedImports() ? `<span class="muted-copy setup-import-continue-note">Selected tracker imports will start after you press Continue.</span>` : ""}<button type="button" class="button-primary" data-setup-action="continue">Continue</button></span>`
            : SKIPPABLE_STEPS.has(step) && !stepDone(step)
              ? `<button type="button" class="button-ghost" data-setup-action="continue">Skip for now</button>`
              : `<button type="button" class="button-primary" data-setup-action="continue">Continue</button>`}
      </div>
    </section>
    ${setupSwitchMarkup()}`;
  if (step === "overview" && isPreClaim) mountClaimPanel();
  if (step === "imports") mountOneTimeImports();
  if (step === "backup") updateBackupContinueAction();
  scheduleImportStatusRefresh(step);
  if (step === "backup" && !backupSetupData && !backupSetupLoading) loadBackupSetupData().catch(() => {});
}

// Sends #restore-local/#restore-remote back to their home in Settings' own
// Restore tab (see settings-shell.js's applySettingsRoute(), which does the
// same reclaim whenever that tab is actually opened) if they aren't already
// there. Always safe to call even when nothing was borrowed.
function homeRestoreSections() {
  const home = document.getElementById("restoreSectionsHome");
  if (!home) return;
  const local = document.getElementById("restore-local");
  const remote = document.getElementById("restore-remote");
  if (local && local.parentElement !== home) home.appendChild(local);
  if (remote && remote.parentElement !== home) home.appendChild(remote);
}

// Same borrow pattern as restore: Import & sync reuses Settings → Connections
// → One Time Imports (Tautulli + Netflix) rather than duplicating fixed IDs.
function homeOneTimeImports() {
  const home = document.getElementById("oneTimeImportsHome");
  const content = document.getElementById("oneTimeImportsContent");
  if (home && content && content.parentElement !== home) home.appendChild(content);
}

function mountOneTimeImports() {
  const host = document.getElementById("setupOneTimeImportsHost");
  const content = document.getElementById("oneTimeImportsContent");
  if (!host || !content) return;
  host.appendChild(content);
  Promise.all([loadRouteModule("tautulli-import"), loadRouteModule("netflix-import")])
    .then(() => {
      loadedRouteModule("tautulli-import")?.refreshTautulliImport?.();
    })
    .catch(() => {});
}

function renderRestoreChoice() {
  return `
    <p class="muted-copy setup-step-intro">Already have a Plekt backup? Restore it now instead of connecting everything from scratch.</p>
    <div class="settings-card-grid setup-overview-list">
      <button type="button" class="settings-card setup-overview-item setup-restore-choice" data-setup-restore-view="local">
        <div class="setup-overview-item-heading"><b>Restore from a local backup</b></div>
        <p class="muted-copy">Upload a backup file from your computer, or restore one already stored on this server.</p>
      </button>
      <button type="button" class="settings-card setup-overview-item setup-restore-choice" data-setup-restore-view="remote">
        <div class="setup-overview-item-heading"><b>Restore from a remote backup</b></div>
        <p class="muted-copy">Connect a Backblaze B2 destination, then choose a backup stored there.</p>
      </button>
    </div>`;
}

function renderRestoreRemoteIntro() {
  if (!backupSetupData) return `<p class="muted-copy">Loading remote destinations...</p>`;
  const destination = backblazeDestination();
  const config = backupSetupData.plembfin?.config || {};
  return `
    <p class="muted-copy setup-step-intro">Enter the Backblaze B2 destination your old Plekt server was backing up to, then test the connection to pull its backup list below.</p>
    ${renderBackblazeCard({ destination, config, showScheduleToggle: false, mode: "connect" })}`;
}

// Renders the "Restore from backup" flow, entered from the overview step's
// Backup card. This does not reimplement restore - #restore-local and
// #restore-remote are the very same elements Settings' Restore tab uses
// (upload/list/restore logic and all), temporarily reparented in here for the
// duration of this view and returned home by homeRestoreSections() the
// moment the user leaves (see renderSetupPage()).
function renderRestoreView(root, logoSrc) {
  const backLabel = restoreView === "choice" ? "Back to setup" : "Back";
  root.innerHTML = `
    <div class="setup-brand">
      <img class="setup-brand-logo brand-logo" src="${logoSrc}" alt="Plekt" />
    </div>
    <section class="glass-panel p-section setup-shell">
      <div class="section-heading">
        <div><h2>Restore from backup</h2></div>
        <div class="setup-header-actions">
          <button type="button" class="button-ghost" data-setup-restore-back="1">${backLabel}</button>
        </div>
      </div>
      <div class="setup-step-body" id="setupRestoreBody">
        ${restoreView === "choice" ? renderRestoreChoice() : ""}
        ${restoreView === "local" ? `<p class="muted-copy setup-step-intro">Restore from a backup already stored on this server, or upload one from your computer. Watch-history and full Plekt backups restore from separate sections below.</p>` : ""}
        ${restoreView === "remote" ? `<div id="setupRestoreRemoteIntro">${renderRestoreRemoteIntro()}</div>` : ""}
      </div>
    </section>`;
  const body = document.getElementById("setupRestoreBody");
  if (!body) return;
  if (restoreView === "local") {
    const local = document.getElementById("restore-local");
    if (local) body.appendChild(local);
    loadWatchBackups().catch(() => {});
    loadPlektBackups().catch(() => {});
  } else if (restoreView === "remote") {
    if (!backupSetupData && !backupSetupLoading) loadBackupSetupData().catch(() => {});
    const remote = document.getElementById("restore-remote");
    if (remote) body.appendChild(remote);
    loadWatchBackups().catch(() => {});
  }
}

function scheduleImportStatusRefresh(step) {
  if (step !== "imports" || state.activeView !== "setup") return;
  const serverImports = Object.values(cachedStatus?.onboarding?.backgroundImports?.servers || {});
  const trackerImports = Object.values(cachedStatus?.onboarding?.backgroundImports?.trackers || {});
  const oneTimeImports=Object.values(cachedStatus?.onboarding?.backgroundImports?.oneTime||{});
  if (![...serverImports, ...trackerImports,...oneTimeImports].some((entry) => entry?.enabled !== false && entry?.status === "importing")) return;
  importStatusPollTimer = setTimeout(() => {
    importStatusPollTimer = null;
    if (state.activeView === "setup" && currentStep() === "imports") loadSetupStatus().catch(() => {});
  }, 1500);
}

function renderStep(step, hasTestedServer) {
  if (step === "overview") return renderOverview();
  if (step === "servers") return renderServers();
  if (step === "metadata") return renderMetadata();
  if (step === "webhooks") return renderWebhooks();
  if (step === "seerr") return renderSeerr();
  if (step === "trackers") return trackers.render();
  if (step === "imports") return renderImports();
  if (step === "options") return renderOptions();
  if (step === "backup") return renderBackup();
  if (step === "review") return renderReview(hasTestedServer);
  return "";
}

function stepNeighbor(direction) {
  const ids = STEPS.map((s) => s.id);
  const index = ids.indexOf(currentStep());
  const next = ids[index + direction];
  return next || ids[index];
}

async function toggleImport(target, enabled) {
  try {
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target, action: enabled ? "start" : "cancel" }) });
  } catch (error) {
    setMessage(error.message, "error");
  }
  await loadSetupStatus();
}

function handleSetupChange(event) {
  if (!elements.setupPageRoot?.contains(event.target)) return;
  if (event.target.matches("[data-setup-backup-field], [data-setup-backblaze-field]")) {
    if (event.target.matches('[data-setup-backup-field="passphrase"], [data-setup-backup-field="rememberPassphrase"]')) setPassphraseError(false);
    updateBackupContinueAction();
    return;
  }
  if (trackers.handleChange(event.target)) return;
  if (event.target.matches("[data-setup-watchlist-toggle]")) {
    pendingWatchlistChoice = event.target.checked;
    return;
  }
  if (event.target.matches("[data-setup-season-source] input")) {
    pendingSeasonSource = event.target.value;
    return;
  }
  if (event.target.matches("[data-setup-watch-import-mode]")) {
    pendingWatchImportMode = event.target.value;
    return;
  }
  if (event.target.matches("[data-setup-fast-local-sync]")) {
    pendingFastLocalPacing = event.target.checked;
    return;
  }
  if (event.target.matches("[data-setup-up-next-sync]")) {
    pendingUpNextSync = event.target.checked;
    return;
  }
  if (event.target.matches("[data-setup-plex-historical-sync]")) {
    pendingPlexHistoricalSync = event.target.value === "on";
    return;
  }
  const importToggle = event.target.closest("[data-setup-import-toggle]");
  if (importToggle) {
    const target = importToggle.dataset.setupImportToggle;
    if (MEDIA_SERVERS.includes(target)) {
      // Servers wait for Continue (startPendingServerImports); only record intent here.
      pendingServerImportChoice.set(target, importToggle.checked);
      renderSetupPage();
    } else {
      trackers.setImportChoice(target, importToggle.checked);
      renderSetupPage();
    }
    return;
  }
  const webhookAck = event.target.closest("[data-setup-webhook-ack]");
  if (webhookAck) {
    const provider = webhookAck.dataset.setupWebhookAck;
    const method = webhookAck.dataset.webhookMethod || "";
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ webhookAck: { provider, method } }) })
      .then(() => loadSetupStatus())
      .catch((error) => setMessage(error.message, "error"));
  }
}

async function handleSetupClick(event) {
  const onboardingCtaButton = event.target.closest("#sidebarOnboardingButton");
  if (onboardingCtaButton) {
    navigateTo("/setup");
    return;
  }
  const restoreBackupButton = event.target.closest("[data-setup-restore-backup]");
  if (restoreBackupButton) {
    restoreView = "choice";
    renderSetupPage();
    return;
  }
  const onboardingCtaDismiss = event.target.closest("#sidebarOnboardingDismiss");
  if (onboardingCtaDismiss) {
    api("/api/setup/checklist/dismiss", { method: "POST" }).then(() => loadSetupStatus()).catch(() => {});
    return;
  }
  if (!elements.setupPageRoot?.contains(event.target)) return;
  const skipOneTime=event.target.closest('[data-setup-one-time-skip]');
  if(skipOneTime) {
    try {await api('/api/setup/import',{method:'POST',body:JSON.stringify({target:skipOneTime.dataset.setupOneTimeSkip,action:'cancel'})});await loadSetupStatus();}
    catch(error) {setMessage(error.message,'error');}
    return;
  }
  const stepButton = event.target.closest("[data-setup-step]");
  if (stepButton) {
    setCurrentStep(stepButton.dataset.setupStep);
    return;
  }
  const connectButton = event.target.closest("[data-setup-connect]");
  if (connectButton) {
    openServiceEditModal(connectButton.dataset.setupConnect);
    return;
  }
  const retryButton = event.target.closest("[data-setup-import-retry]");
  if (retryButton) {
    event.preventDefault();
    const card = retryButton.closest("[data-setup-server]");
    const provider = card?.dataset.setupServer;
    if (provider) toggleImport(provider, true);
    return;
  }
  const restoreViewChoice = event.target.closest("[data-setup-restore-view]");
  if (restoreViewChoice) {
    restoreView = restoreViewChoice.dataset.setupRestoreView;
    renderSetupPage();
    return;
  }
  const restoreBack = event.target.closest("[data-setup-restore-back]");
  if (restoreBack) {
    restoreView = restoreView === "choice" ? null : "choice";
    renderSetupPage();
    return;
  }
  const trackerConnect = event.target.closest("[data-setup-tracker-connect]");
  if (trackerConnect) { trackers.connect(trackerConnect.dataset.setupTrackerConnect); return; }
  const action = event.target.closest("[data-setup-action]")?.dataset.setupAction;
  if (!action) return;
  if (action === "continue") {
    if(currentStep()==='imports') {
      try {await api('/api/setup/step',{method:'POST',body:JSON.stringify({startInitialSync:true})});}
      catch(error) {setMessage(error.message,'error');return;}
    }
    if (currentStep() === "servers") {
      // The coordinator persists the shared tracker wait server-side,
      // so queued server imports survive navigation and page reloads.
      await startPendingServerImports().catch(() => {});
    }
    if (currentStep() === "trackers") {
      const started = await trackers.startImports();
      if (!started) return;
    }
    if (currentStep() === "backup") {
      try {
        const saved = await saveBackupSetup();
        if (!saved) return;
      } catch (error) {
        setMessage(error.message, "error");
        return;
      }
    }
    if (currentStep() === "options") {
      try {
        await saveSetupOptions();
      } catch (error) {
        setMessage(error.message, "error");
        return;
      }
    }
    if (currentStep() === "metadata") {
      try {
        await saveSeasonSourceChoice();
      } catch (error) {
        setMessage(error.message, "error");
        return;
      }
    }
    setCurrentStep(stepNeighbor(1));
  } else if (action === "back") {
    setCurrentStep(stepNeighbor(-1));
  } else if (action === "exit") {
    restoreView = null;
    homeRestoreSections();
    homeOneTimeImports();
    navigateTo("/settings");
  } else if (action === "backblaze-save") {
    saveBackblazeAction();
  } else if (action === "backblaze-test") {
    testBackblazeAction();
  } else if (action === "trackers-skip") {
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ trackersSkipped: true }) })
      .then(() => { setCurrentStep(stepNeighbor(1)); })
      .catch((error) => setMessage(error.message, "error"));
  } else if (action === "complete") {
    api("/api/setup/complete", { method: "POST" })
      .then(() => {
        restoreView = null;
        homeRestoreSections();
        homeOneTimeImports();
        navigateTo("/");
      })
      .catch((error) => setMessage(error.message, "error"));
  }
}
