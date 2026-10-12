// Guided first-run setup (`/setup`). Talks to the /api/setup/* endpoints
// added alongside this module and reuses the same Settings building blocks
// wherever possible - openServiceEditModal() for every provider connect/test
// flow, and the webhook-guide functions - so setup and Settings never diverge
// in behavior, only in presentation.
import { state, elements } from "./state.js?v=2.0.0.0.1";
import { escapeHtml, escapeAttribute, isDemoMode } from "./utils.js?v=2.0.0.0.1";
import { openServiceEditModal } from "./settings-services.js?v=2.0.0.0.1";
import { embyWebhookSetup, jellyfinWebhookSetup, buildWebhookUrl } from "./help-content.js?v=2.0.0.0.1";
import { claimAdminAccount } from "./auth.js?v=2.0.0.0.1";
import { lazyExport } from "./route-modules.js?v=2.0.0.0.1";
import {
  PLEX_HISTORICAL_SYNC_CHOICES,
  PLEX_HISTORICAL_SYNC_LABEL,
  plexHistoricalSyncEnabled,
} from "./plex-history-policy.js?v=2.0.0.0.1";

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
  // See checkTraktFlow() - re-check immediately when the user switches back
  // from the trakt.tv activation tab instead of waiting on a throttled timer.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && traktFlow && state.activeView === "setup" && currentStep() === "trakt") {
      checkTraktFlow();
    }
  });
}

const authHeaders = (...args) => _cb.authHeaders?.(...args) || {};
const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const openConfirmDialog = (...args) => _cb.openConfirmDialog?.(...args) || Promise.resolve(true);
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

// Called from dashboard.js's renderDashboard() - the checklist reflects
// server-derived state (cachedStatus.checklist), so it stays in sync with
// Settings without dashboard.js needing to know anything about onboarding.
export function renderDashboardChecklist() {
  const container = elements.dashboardChecklist;
  if (!container) return;
  // The demo has no connections, credentials, backups, or provider setup by
  // design. Showing the normal first-run checklist makes that intentional
  // fixture look broken and invites users to perform actions the demo must not
  // persist.
  if (isDemoMode()) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }
  const items = cachedStatus?.checklist || [];
  if (!items.length) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  const descriptions = {
    connect_tmdb: "Add artwork, episode details, and discovery metadata.",
    connect_trakt: "Keep watched state synchronized with Trakt.",
    configure_seerr: "Connect media requests and availability.",
    create_backup: "Protect settings, connections, and watch history.",
    store_credential_key: "Keep recovery access outside this Plekt server.",
  };
  container.innerHTML = `
    <section class="glass-panel dashboard-setup-checklist" id="dashboardChecklistPanel" aria-labelledby="dashboardChecklistTitle">
      <div class="dashboard-setup-checklist-head">
        <div class="dashboard-setup-checklist-title">
          <h2 id="dashboardChecklistTitle">Finish setting up Plekt</h2>
          <p>${items.length} recommended task${items.length === 1 ? "" : "s"} remaining</p>
          <span class="badge">${items.length} remaining</span>
        </div>
        <button type="button" class="button-ghost" data-setup-dismiss-checklist="1" aria-label="Dismiss setup checklist">Dismiss</button>
      </div>
      <ol class="dashboard-setup-actions">
        ${items.map((item, index) => `
          <li>
            <a href="${escapeHtml(item.href)}" class="dashboard-setup-action">
              <span class="dashboard-setup-action-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
              <span class="dashboard-setup-action-copy"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(descriptions[item.id] || "Complete this recommended setup task.")}</span></span>
              <span class="dashboard-setup-action-arrow" aria-hidden="true">→</span>
            </a>
          </li>`).join("")}
      </ol>
    </section>`;
}

const MEDIA_SERVERS = ["plex", "emby", "jellyfin"];
const STEPS = [
  { id: "overview", label: "Overview" },
  { id: "claim", label: "Claim account" },
  { id: "trakt", label: "Trakt" },
  { id: "metadata", label: "Metadata" },
  { id: "servers", label: "Media Servers" },
  { id: "webhooks", label: "Webhooks" },
  { id: "backup", label: "Backup" },
  { id: "imports", label: "Import & sync" },
  { id: "options", label: "Options" },
  { id: "review", label: "Review" },
];
const SKIPPABLE_STEPS = new Set(["servers", "metadata", "webhooks", "backup"]);
const STEP_TITLES = {
  overview: "Set up Plekt",
  claim: "Claim this instance",
  servers: "Connect media servers",
  metadata: "Add metadata",
  webhooks: "Enable reliable updates",
  trakt: "Connect Trakt",
  imports: "Import progress",
  options: "Choose your options",
  backup: "Protect your Plekt data",
  review: "Review and finish",
};

let cachedStatus = null;
let statusLoading = null;
let traktFlow = null;
let preferEarlierTraktDateChoice = true;
let traktPollTimer = null;
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
      currentOnboardingVersion: 1,
      accountClaimed: false,
      runState: "not_started",
      currentStep: "overview",
      startedAt: null,
      completedAt: null,
      acknowledgements: { webhooks: {}, traktSkipped: false },
      backgroundImports: {
        servers: {},
        trakt: { enabled: null, status: "not_started", startedAt: null, completedAt: null, itemCount: null, error: null },
      },
      pushSync: { status: "not_started", startedAt: null, completedAt: null },
      checklistDismissedAt: null,
      ctaDismissedAt: null,
    },
    servers: [],
    trakt: { connected: false, username: "", baselineComplete: false },
    metadata: { tmdbConfigured: false, builtInAvailable: { tvdb: false, fanart: false } },
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
    throw error;
  }
  return data;
}

export async function loadSetupStatus() {
  if (isDemoMode()) {
    cachedStatus = null;
    elements.dashboardChecklist && (elements.dashboardChecklist.innerHTML = "");
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
      if (state.activeView === "dashboard") renderDashboardChecklist();
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

// Persistent sidebar entry point for unfinished onboarding, shown in place of
// the old behavior of force-navigating to /setup on every load while setup
// wasn't done. Hidden once onboarding has actually been completed (finishing
// the wizard - a connected media server isn't required for that anymore) or
// a media server was connected and tested directly from Settings without
// ever finishing the wizard, or once permanently dismissed via its own "x"
// control.
export function renderSidebarOnboardingCta() {
  const container = elements.sidebarOnboardingCta;
  if (!container || !cachedStatus) return;
  if (isDemoMode()) {
    container.classList.add("hidden");
    return;
  }
  const finished = cachedStatus.onboarding.runState === "completed" || cachedStatus.servers.some((s) => s.tested);
  const dismissed = Boolean(cachedStatus.onboarding.ctaDismissedAt);
  container.classList.toggle("hidden", finished || dismissed);
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
let pendingTraktImportChoice = null;
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

const WATCH_IMPORT_MODES = Object.freeze([
  { value: "review", label: "Require review", description: "Hold the item for a decision in Manual Watch review." },
  { value: "now", label: "Mark as watched now", description: "Use the time the scanner sees the watched flag." },
  { value: "release_day", label: "Mark as watched on release day", description: "Use the movie or episode release date." },
  { value: "episode_timing", label: "Mark as watched at the same time as other episodes", description: "Use the before/after timing from the media pages." },
]);

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

function traktImportPending() {
  if (pendingTraktImportChoice !== null) return pendingTraktImportChoice;
  const existing = cachedStatus?.onboarding?.backgroundImports?.trakt;
  return existing?.enabled !== false;
}

async function startPendingTraktImport() {
  const existing = cachedStatus?.onboarding?.backgroundImports?.trakt;
  if (!cachedStatus?.trakt?.connected || !traktImportPending() || (existing && existing.status !== "not_started")) {
    pendingTraktImportChoice = null;
    return true;
  }
  try {
    await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target: "trakt", action: "start" }) });
    pendingTraktImportChoice = null;
    await loadSetupStatus();
    return true;
  } catch (error) {
    setMessage(error.message, "error");
    await loadSetupStatus();
    return false;
  }
}

function setCurrentStep(stepId) {
  if (!cachedStatus) ensurePreClaimStatus();
  if (!STEPS.some((step) => step.id === stepId)) return;
  if (isPreClaimSetup() && !["overview", "claim"].includes(stepId)) return;
  cachedStatus.onboarding.currentStep = stepId;
  renderSetupPage();
  if (isPreClaimSetup()) return;
  api("/api/setup/step", { method: "POST", body: JSON.stringify({ currentStep: stepId }) }).catch(() => {});
}

function currentStep() {
  return cachedStatus?.onboarding?.currentStep || "overview";
}

function stepDone(id) {
  if (!cachedStatus) return false;
  const { servers, trakt, metadata, onboarding } = cachedStatus;
  if (id === "overview") return true;
  if (id === "claim") return !isPreClaimSetup();
  if (id === "servers") return servers.some((s) => s.tested);
  if (id === "metadata") return Boolean(metadata.tmdbConfigured);
  if (id === "webhooks") return servers.filter((s) => s.tested && webhookSetupRequired(s.provider)).every((s) => onboarding.acknowledgements.webhooks?.[s.provider]);
  if (id === "trakt") return trakt.connected || onboarding.acknowledgements.traktSkipped;
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
  // #restore-local/#restore-remote are the exact same DOM Settings' own
  // Restore tab uses (see renderRestoreView() below) - every root.innerHTML
  // assignment past this point would otherwise destroy them outright if they
  // were still parented inside root from a previous render, so always send
  // them home first; the restoreView branch re-borrows whichever one it needs
  // once the new markup exists.
  homeRestoreSections();
  homeClaimPanel();
  if (isPreClaimSetup()) ensurePreClaimStatus();
  if (!cachedStatus) {
    root.innerHTML = `<div class="settings-content"><p class="muted-copy">Loading setup...</p></div>`;
    return;
  }
  const logoSrc = document.documentElement.classList.contains("light-mode") ? "/plekt_header_logo_light.png?v=2.0.0.0.1" : "/plekt_header_logo_dark.png?v=2.0.0.0.1";
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
          const locked = isPreClaim && !["overview", "claim"].includes(s.id);
          return `<button type="button" role="tab" class="segment-button setup-progress-step${s.id === step ? " active" : ""}${stepDone(s.id) ? " done" : ""}" data-setup-step="${s.id}" aria-selected="${s.id === step ? "true" : "false"}"${locked ? " disabled" : ""} title="${escapeAttribute(s.label)}">${escapeHtml(s.label)}</button>`;
        }).join("")}
      </div>
      <div class="setup-step-body">${renderStep(step, hasTestedServer)}</div>
      <div class="setup-actions">
        <span style="display:flex; gap:8px;">
          ${step !== "overview" ? `<button type="button" class="button-ghost" data-setup-action="back">Back</button>` : ""}
        </span>
        ${step === "claim" && isPreClaim
          ? ""
          : step === "review"
          ? `<button type="button" class="button-primary" data-setup-action="complete">Open dashboard</button>`
          : step === "trakt" && !cachedStatus.trakt.connected && !traktFlow
            ? `<span style="display:flex; gap:8px;">
                <button type="button" class="button-ghost" data-setup-action="trakt-skip">Skip for now</button>
                <button type="button" class="button-primary" data-setup-action="continue">Continue</button>
              </span>`
            : SKIPPABLE_STEPS.has(step) && !stepDone(step)
              ? `<button type="button" class="button-ghost" data-setup-action="continue">Skip for now</button>`
              : `<button type="button" class="button-primary" data-setup-action="continue">Continue</button>`}
      </div>
    </section>`;
  if (step === "claim" && isPreClaim) mountClaimPanel();
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
  const traktImport = cachedStatus?.onboarding?.backgroundImports?.trakt;
  if (![...serverImports, traktImport].some((entry) => entry?.enabled !== false && entry?.status === "importing")) return;
  importStatusPollTimer = setTimeout(() => {
    importStatusPollTimer = null;
    if (state.activeView === "setup" && currentStep() === "imports") loadSetupStatus().catch(() => {});
  }, 1500);
}

function renderStep(step, hasTestedServer) {
  if (step === "overview") return renderOverview();
  if (step === "claim") return renderClaim();
  if (step === "servers") return renderServers();
  if (step === "metadata") return renderMetadata();
  if (step === "webhooks") return renderWebhooks();
  if (step === "trakt") return renderTrakt();
  if (step === "imports") return renderImports();
  if (step === "options") return renderOptions();
  if (step === "backup") return renderBackup();
  if (step === "review") return renderReview(hasTestedServer);
  return "";
}

function claimedAdminUsername() {
  const user = state.currentUser || {};
  return String(user.username || user.email || localStorage.getItem("adminUsername") || "admin").trim() || "admin";
}

function currentInstanceAddress() {
  try {
    return new URL("/", window.location.href).toString();
  } catch {
    return "";
  }
}

function renderClaim() {
  if (!isPreClaimSetup()) {
    const username = claimedAdminUsername();
    const address = currentInstanceAddress();
    return `
      <div class="setup-claim-step setup-claim-claimed">
        <p class="muted-copy setup-step-intro">Your administrator account is ready. Use these details to sign in to this Plekt instance.</p>
        <section class="setup-claim-panel setup-claim-summary" aria-labelledby="setupClaimSummaryTitle">
          <div class="setup-claim-panel-heading">
            <div>
              <h3 id="setupClaimSummaryTitle">Administrator account</h3>
              <p class="muted-copy">This instance is claimed and ready for the rest of onboarding.</p>
            </div>
            <span class="badge badge-success">Claimed</span>
          </div>
          <dl class="setup-claim-summary-list">
            <div>
              <dt>Username</dt>
              <dd>${escapeHtml(username)}</dd>
            </div>
            <div>
              <dt>Password</dt>
              <dd><span class="setup-claim-summary-status">Added</span><small>Stored securely and never shown here.</small></dd>
            </div>
            <div>
              <dt>Plekt address</dt>
              <dd>${address ? `<a href="${escapeAttribute(address)}">${escapeHtml(address)}</a>` : "<span>Current Plekt address</span>"}<small>Use this address to open Plekt on this computer.</small></dd>
            </div>
          </dl>
        </section>
      </div>`;
  }
  return `
    <div class="setup-claim-step">
      <p class="muted-copy setup-step-intro">Create the administrator account for this local Plekt instance. Once it is claimed, the remaining setup steps unlock.</p>
      <div id="setupClaimFormHost" class="setup-claim-form-host"></div>
    </div>`;
}

const OVERVIEW_STEPS = [
  {
    title: "Claim account", tag: "Required",
    detail: "Create the administrator account that protects this local instance and unlocks the remaining setup steps.",
  },
  {
    title: "Trakt", tag: "Optional",
    detail: "Two-way watch-state sync with Plekt's built-in app credentials - no personal API key needed.",
  },
  {
    title: "Metadata", tag: "Recommended",
    detail: "A free TMDB key powers posters, cast, and episode details; TheTVDB and Fanart.tv work out of the box.",
  },
  {
    title: "Media Servers", tag: "Recommended",
    detail: "Connect a Plex, Emby, or Jellyfin server for automatic tracking, or skip and mark watches manually.",
  },
  {
    title: "Webhooks", tag: "Recommended",
    detail: "Plex updates instantly; Emby and Jellyfin need a quick webhook for the same.",
  },
  {
    title: "Backup", tag: "Optional",
    detail: "Encrypted local backups of your settings and watch history, with an optional off-server mirror.",
  },
  {
    title: "Import & sync", tag: "Optional",
    detail: "Import each server's existing watch history, or start tracking fresh from today.",
  },
  {
    title: "Options", tag: "Recommended",
    detail: "Choose how app-marked watches are dated or reviewed, and optionally speed up trusted local-network sync.",
  },
];

function renderOverview() {
  return `
    <p class="muted-copy setup-overview-intro">Set things up at your own pace. Everything here can be changed later in Settings, and your progress saves automatically.</p>
    <div class="settings-card-grid setup-overview-list">
      ${OVERVIEW_STEPS.map((item) => `
        <div class="settings-card setup-overview-item">
          <div class="setup-overview-item-heading">
            <b>${escapeHtml(item.title)}</b>
            <span class="badge${item.tag === "Required" ? " badge-warning" : ""}">${escapeHtml(item.tag)}</span>
          </div>
          <p class="muted-copy">${escapeHtml(item.detail)}</p>
          ${item.title === "Backup" ? `<button type="button" class="button-ghost setup-restore-backup-button" data-setup-restore-backup="1">Restore from backup</button>` : ""}
        </div>`).join("")}
    </div>`;
}

function serverStatusBadge(server) {
  if (server.tested) return `<span class="badge badge-success">Connected</span>`;
  if (server.connected) return `<span class="badge badge-warning">Saved, not tested</span>`;
  return `<span class="badge">Not connected</span>`;
}

function importState(provider) {
  return cachedStatus.onboarding.backgroundImports.servers[provider] || null;
}

function importStatusLine(importInfo) {
  if (!importInfo || importInfo.enabled === false) return "";
  if (importInfo.status === "importing") return `<p class="muted-copy setup-import-status-line">Importing... ${importInfo.itemCount ?? 0} items so far.</p>`;
  if (importInfo.status === "complete") return `<p class="muted-copy setup-import-status-line">Import complete: ${importInfo.itemCount ?? 0} items.</p>`;
  if (importInfo.status === "failed") return `<p class="muted-copy setup-import-status-line is-error">Import failed: ${escapeHtml(importInfo.error || "unknown error")}. <a href="#" data-setup-import-retry="1">Retry</a></p>`;
  return "";
}

const SERVER_BLURBS = {
  plex: "Connect your Plex account and pick your server.",
  emby: "Sign in with your Emby username and password.",
  jellyfin: "Use Quick Connect, or sign in directly.",
};

// Trakt is a more durable record of when something was actually watched than
// a media server's own "last watched" date (see loadTraktWatchedDateIndex in
// mediaForceSync.js) - but that preference can only apply if Trakt's own
// import has already finished by the time these servers are pulled. Trakt
// connects earlier in the wizard now specifically so this can be true; this
// banner tells the user whether that's actually the case yet.
function traktSyncStatusBanner() {
  const trakt = cachedStatus.trakt;
  const traktImport = cachedStatus.onboarding.backgroundImports.trakt;
  if (!trakt.connected) {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt isn't connected, so these imports will use each server's own watched dates as-is. Go back to the Trakt step first if you'd rather its dates take priority.</div>`;
  }
  if (traktImport?.enabled !== false && traktImport?.status === "importing") {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt is still importing your watch history${traktImport.itemCount != null ? ` (${traktImport.itemCount} items so far)` : ""}. Continuing will queue these server imports until Trakt finishes, so its watch dates take priority over the servers' own.</div>`;
  }
  if (traktImport?.enabled !== false && traktImport?.status === "complete") {
    return `<div class="guide-callout setup-trakt-sync-note">Trakt sync is complete - these server imports will start right away and use Trakt's watch dates wherever they're earlier.</div>`;
  }
  return `<div class="guide-callout setup-trakt-sync-note">Trakt is connected but its watch history import was skipped, so these imports will use each server's own watched dates as-is.</div>`;
}

function renderServers() {
  const rows = MEDIA_SERVERS.map((provider) => {
    const server = cachedStatus.servers.find((s) => s.provider === provider);
    const importInfo = importState(provider);
    const checked = serverImportPending(provider);
    return `
      <div class="settings-card setup-server-row" data-setup-server="${provider}">
        <div class="setup-server-row-main">
          <div>
            <div class="setup-server-row-title">
              <b class="setup-server-name">${escapeHtml(server.serverName || provider)}</b>
              ${serverStatusBadge(server)}
            </div>
            ${server.baseUrl ? `
              <p class="muted-copy setup-server-detail">Server - ${escapeHtml(server.baseUrl)}</p>
              ${server.remoteUsername ? `<p class="muted-copy setup-server-detail">User - ${escapeHtml(server.remoteUsername)}</p>` : ""}
            ` : `<p class="muted-copy setup-server-detail">${SERVER_BLURBS[provider]}</p>`}
          </div>
          <button type="button" class="button-primary" data-setup-connect="${provider}">${server.connected ? "Edit connection" : "Set up"}</button>
        </div>
        ${provider === "plex" ? `
          <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-top: var(--space-3);">
            <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
              Turn off "Refresh library metadata periodically"
            </b>
            <p style="margin: 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
              In Plex, under Settings &rarr; Scheduled Tasks, disable "Refresh library metadata periodically". This task can occasionally re-match and re-identify library items during its nightly maintenance window, which resets their viewed state to unwatched on Plex itself - and Plekt will propagate that as a real unwatch to Emby, Jellyfin, and Trakt. Turning it off removes the most common trigger for a mass false-unwatch event.
            </p>
          </div>
          <label class="field-label setup-import-toggle-label">
            <input type="checkbox" data-setup-watchlist-toggle ${watchlistSyncPending() ? "checked" : ""} />
            Sync Watchlist with Plekt
          </label>
          <p class="muted-copy setup-server-detail">Keeps your Plex watchlist and Plekt's watchlist aligned in both directions.</p>
        ` : ""}
        ${server.tested ? `
          <label class="field-label setup-import-toggle-label">
            <input type="checkbox" data-setup-import-toggle="${provider}" ${checked ? "checked" : ""} />
            Import watched status from ${escapeHtml(server.serverName || provider)}
          </label>
          ${importStatusLine(importInfo)}
        ` : ""}
      </div>`;
  }).join("");
  return `
    <p class="muted-copy">Connect and test at least one server to continue. You can connect more than one.</p>
    ${traktSyncStatusBanner()}
    <div class="setup-server-rows">${rows}</div>`;
}

function renderMetadata() {
  const tmdbConfigured = cachedStatus.metadata.tmdbConfigured;
  const built = cachedStatus.metadata.builtInAvailable;
  return `
    <p class="muted-copy">TMDB powers posters, backdrops, episode details, and search.</p>
    <div class="settings-card setup-metadata-card">
      <div class="setup-metadata-heading">
        <b>TMDB</b>
        <span class="setup-metadata-badges">
          <span class="badge badge-warning">Required</span>
          ${tmdbConfigured ? `<span class="badge badge-success">Configured</span>` : `<span class="badge">Not configured</span>`}
        </span>
      </div>
      <div class="setup-metadata-actions">
        <button type="button" class="button-ghost" data-setup-connect="tmdb">${tmdbConfigured ? "Edit" : "Add TMDB key"}</button>
        <a class="button-ghost" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Get a free TMDB key</a>
      </div>
    </div>
    <details class="setup-metadata-optional" open>
      <summary>Optional metadata providers</summary>
      <p class="muted-copy setup-metadata-optional-intro">TheTVDB and Fanart.tv already work out of the box with a shared key - add a personal key for higher rate limits. OMDb and YouTube are off until you add a free key.</p>
      <div class="settings-card-grid setup-metadata-optional-grid">
        <div class="settings-card">
          <b>TheTVDB</b>
          <p class="muted-copy setup-metadata-provider-desc">Episode ordering and air dates - more accurate season/episode numbering than TMDB alone.</p>
          <p class="muted-copy setup-metadata-provider-status">${built.tvdb ? "Using built-in access" : "Not configured"}</p>
          <button type="button" class="button-ghost" data-setup-connect="tvdb">Add personal key</button>
        </div>
        <div class="settings-card">
          <b>Fanart.tv</b>
          <p class="muted-copy setup-metadata-provider-desc">Fallback posters, backdrops, and logos when TMDB has no artwork for a title.</p>
          <p class="muted-copy setup-metadata-provider-status">${built.fanart ? "Using built-in access" : "Not configured"}</p>
          <button type="button" class="button-ghost" data-setup-connect="fanart">Add personal key</button>
        </div>
        <div class="settings-card">
          <b>OMDb</b>
          <p class="muted-copy setup-metadata-provider-desc">IMDb ratings shown next to the TMDB score on movie pages. Free key, 1,000 requests/day.</p>
          <button type="button" class="button-ghost" data-setup-connect="omdb">Add key</button>
        </div>
        <div class="settings-card">
          <b>YouTube</b>
          <p class="muted-copy setup-metadata-provider-desc">Trailer titles, descriptions, and durations for the trailer player.</p>
          <button type="button" class="button-ghost" data-setup-connect="youtube">Add key</button>
        </div>
      </div>
    </details>`;
}

function webhookGuideFor(provider) {
  if (provider === "emby") return embyWebhookSetup();
  return jellyfinWebhookSetup();
}

function webhookSetupRequired(provider) {
  return provider === "emby" || provider === "jellyfin";
}

function webhookProviderName(provider) {
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  return "Jellyfin";
}

function renderWebhooks() {
  const testedServers = cachedStatus.servers.filter((s) => s.tested);
  // Show every provider's guide up front rather than gating it behind an
  // actual connection - people want to read what a webhook setup involves
  // (or learn Plex needs none at all) while they're still deciding which
  // servers to connect, not only after coming back to this step later.
  const rowServers = MEDIA_SERVERS.map((provider) => (
    testedServers.find((s) => s.provider === provider) || { provider, tested: false, serverName: "" }
  ));
  const cards = rowServers.map((server) => {
    const requiresSetup = webhookSetupRequired(server.provider);
    const acked = Boolean(cachedStatus.onboarding.acknowledgements.webhooks?.[server.provider]);
    const title = `<span class="setup-webhook-title"><b>${escapeHtml(webhookProviderName(server.provider))}</b>${server.tested ? `<span>&nbsp;- ${escapeHtml(server.serverName || `${webhookProviderName(server.provider)} server`)}</span>` : ""}</span>`;
    if (!requiresSetup) {
      return `
        <section class="settings-card setup-webhook-row setup-webhook-row--automatic" data-setup-webhook-provider="${escapeHtml(server.provider)}">
          <div class="setup-webhook-row-heading">
            ${title}
            <span class="badge badge-success">Automatic</span>
          </div>
          <p class="setup-webhook-automatic-copy"><b>No webhook setup required.</b> Plekt receives Plex watch-state changes directly and checks playback progress every minute.</p>
          <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-top: var(--space-3);">
            <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
              Turn off "Refresh library metadata periodically"
            </b>
            <p style="margin: 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
              In Plex, under Settings &rarr; Scheduled Tasks, disable "Refresh library metadata periodically". This task can occasionally re-match and re-identify library items during its nightly maintenance window, which resets their viewed state to unwatched on Plex itself - and Plekt will propagate that as a real unwatch to Emby, Jellyfin, and Trakt. Turning it off removes the most common trigger for a mass false-unwatch event.
            </p>
          </div>
        </section>`;
    }
    return `
      <details class="settings-card setup-webhook-row setup-webhook-accordion" data-setup-webhook-provider="${escapeHtml(server.provider)}">
        <summary class="setup-webhook-row-heading">
          <span class="setup-webhook-summary-main">
            <span class="setup-webhook-chevron" aria-hidden="true">›</span>
            ${title}
          </span>
          ${acked ? `<span class="badge badge-success">Configured</span>` : server.tested ? `<span class="badge badge-warning">Setup needed</span>` : `<span class="badge">Not connected yet</span>`}
        </summary>
        <div class="setup-webhook-accordion-body">
          ${webhookGuideFor(server.provider)}
          <label class="field-label setup-webhook-confirmation">
            <input type="checkbox" data-setup-webhook-ack="${server.provider}" ${acked ? "checked" : ""} />
            I have configured the ${escapeHtml(webhookProviderName(server.provider))} webhook
          </label>
        </div>
      </details>`;
  }).join("");
  return `
    <p class="muted-copy setup-step-intro">Plex updates are automatic. Emby and Jellyfin need a webhook to send playback changes instantly; scheduled polling still runs every minute as a backstop. See <a href="/#help/webhooks">the webhook guide</a> for more detail.</p>
    <div class="setup-webhook-rows">${cards}</div>`;
}

function renderTrakt() {
  const trakt = cachedStatus.trakt;
  const traktImport = cachedStatus.onboarding.backgroundImports.trakt;
  if (trakt.connected) {
    return `
      <div class="settings-card setup-trakt-card">
        <div class="setup-trakt-heading">
          <b>Connected as ${escapeHtml(trakt.username || "Trakt user")}</b>
          <span class="badge badge-success">Connected</span>
        </div>
        <label class="field-label setup-import-toggle-label">
          <input type="checkbox" data-setup-import-toggle="trakt" ${traktImportPending() ? "checked" : ""} />
          Import watch history from Trakt
        </label>
        ${importStatusLine(traktImport)}
      </div>`;
  }
  if (traktFlow) {
    return `
      <div class="settings-card setup-trakt-flow">
        <p>Go to <a href="${escapeHtml(traktFlow.verificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(traktFlow.verificationUrl)}</a> and enter this code:</p>
        <p class="setup-trakt-code">${escapeHtml(traktFlow.userCode)}</p>
        <p class="muted-copy setup-trakt-waiting">Waiting for confirmation...</p>
      </div>`;
  }
  return `
    <div class="settings-card setup-trakt-card">
      <p class="muted-copy">Trakt keeps watch state in sync both ways, including individual rewatches, using Plekt's built-in app credentials - no personal API key or VIP required.</p>
      <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-bottom: var(--space-3);">
        <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
          Disable Existing Trakt Plugins
        </b>
        <p style="margin: 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
          Disable any Trakt plugins or scheduled tasks in Emby and Jellyfin before connecting. Plekt must be the sole Trakt bridge to prevent duplicate writers and sync loops.
        </p>
      </div>
      <label class="checkbox-label setup-trakt-date-pref">
        <input type="checkbox" data-setup-trakt-date-pref="1" ${preferEarlierTraktDateChoice ? "checked" : ""} />
        <span>Prefer Trakt's watched date when it is earlier than a media server's</span>
      </label>
      <p class="muted-copy setup-trakt-date-pref-help">A media server's own "last watched" date can be reset by a library rebuild or rescan. When this is on, Force Sync and imports use Trakt's date instead if it already has an earlier one for the same item.</p>
      <div class="setup-trakt-actions">
        <button type="button" class="button-primary" data-setup-action="trakt-connect">Connect Trakt</button>
      </div>
    </div>`;
}

function renderImports() {
  const rows = [];
  // Trakt listed first and imports before the media servers (see the Trakt
  // and Media servers step order) - keeping it first here too so its status
  // is the first thing explaining why the servers below might still be
  // queued rather than actively pulling.
  const traktInfo = cachedStatus.onboarding.backgroundImports.trakt;
  if (cachedStatus.trakt.connected) {
    rows.push(importProgressRow("trakt", cachedStatus.trakt.username || "Trakt account", traktInfo));
  }
  for (const provider of MEDIA_SERVERS.filter((p) => cachedStatus.servers.find((s) => s.provider === p)?.tested)) {
    const server = cachedStatus.servers.find((entry) => entry.provider === provider);
    const info = importState(provider);
    // Server pulls are queued client-side behind Trakt (see the servers step's
    // continue handler) and don't call the start API - and so have no
    // backgroundImports entry at all - until Trakt clears. Without this, a
    // genuinely selected-but-still-queued server reads identically to one the
    // user never checked in the first place.
    rows.push(importProgressRow(provider, server?.serverName || provider, info, serverImportPending(provider)));
  }
  return `
    <div class="guide-callout setup-import-note">These imports will continue in the background - go ahead and continue with setup.</div>
    <div class="setup-import-list">${rows.join("") || `<p class="muted-copy">No imports were requested. Plekt will track new activity from this point forward.</p>`}</div>`;
}

function renderOptions() {
  const selectedMode = setupWatchImportMode();
  const fastLocalPacing = setupFastLocalPacing();
  const upNextSync = setupUpNextSync();
  const plexHistoricalSync = setupPlexHistoricalSync();
  const plexConnected = (cachedStatus?.servers || []).some((server) => server.provider === "plex" && (server.connected || server.tested));
  return `
    <div class="setup-options-fields">
      ${plexConnected ? `
      <section class="settings-card setup-options-card setup-options-policy">
        <div class="setup-options-heading">
          <b>${escapeHtml(PLEX_HISTORICAL_SYNC_LABEL)}</b>
          <p class="muted-copy">Choose whether older watched items are sent to Plex.</p>
        </div>
        <div class="settings-choice-grid setup-options-radio-grid" role="radiogroup" aria-label="${escapeAttribute(PLEX_HISTORICAL_SYNC_LABEL)}">
          ${PLEX_HISTORICAL_SYNC_CHOICES.map((option) => `
            <label class="settings-choice-option">
              <input type="radio" name="setup-plex-historical-sync" value="${escapeAttribute(option.value)}" data-setup-plex-historical-sync="1" ${plexHistoricalSync === (option.value === "on") ? "checked" : ""} />
              <span class="settings-choice-option-body${option.inlineDescription ? " settings-choice-option-body--inline" : ""}">
                <span class="settings-choice-option-title">${escapeHtml(option.label)}</span>
                ${option.inlineDescription ? `<span class="settings-choice-option-description settings-choice-option-description--inline">${escapeHtml(option.inlineDescription)}</span>` : ""}
                ${(option.descriptionLines || [option.description]).map((line) => `<span class="settings-choice-option-description settings-choice-option-description--block">${escapeHtml(line)}</span>`).join("")}
              </span>
            </label>`).join("")}
        </div>
      </section>
      ` : ""}
      <section class="settings-card setup-options-card setup-options-policy">
        <div class="setup-options-heading">
          <b>When you manually mark an item as watched in Plex / Emby / Jellyfin</b>
          <p class="muted-copy">Choose whether Plekt dates the watch automatically or sends it to Manual Watch review.</p>
        </div>
        <div class="settings-choice-grid setup-options-radio-grid" role="radiogroup" aria-label="When you manually mark an item as watched in Plex / Emby / Jellyfin">
          ${WATCH_IMPORT_MODES.map((option) => `
            <label class="settings-choice-option">
              <input type="radio" name="setup-watch-import-mode" value="${escapeAttribute(option.value)}" data-setup-watch-import-mode="1" ${selectedMode === option.value ? "checked" : ""} />
              <span class="settings-choice-option-body">
                <span class="settings-choice-option-title">${escapeHtml(option.label)}</span>
                <span class="settings-choice-option-description">${escapeHtml(option.description)}</span>
              </span>
            </label>`).join("")}
        </div>
      </section>
      <label class="settings-card setup-options-card setup-options-toggle">
        <span class="setup-options-toggle-copy">
          <b>Fast Local-Network Sync</b>
          <span>Speed up bulk sync operations when Plekt, Plex, Emby, and Jellyfin are all on the same trusted local network. Leave this off for public or mixed networks.</span>
        </span>
        <input class="setup-options-switch" type="checkbox" role="switch" aria-label="Fast Local-Network Sync" data-setup-fast-local-sync="1" ${fastLocalPacing ? "checked" : ""} aria-checked="${fastLocalPacing ? "true" : "false"}" />
      </label>
      <label class="settings-card setup-options-card setup-options-toggle">
        <span class="setup-options-toggle-copy">
          <b>Sync Up Next to media apps</b>
          <span>When enabled, Plekt keeps its Up Next queue in sync with Plex and Emby's Continue Watching and Jellyfin's Next Up.<br>Turn it off to leave those app lists unchanged; Plekt's own Up Next view remains available.<br>You can change this later in Settings → Sync → Sync Tuning.</span>
        </span>
        <input class="setup-options-switch" type="checkbox" role="switch" aria-label="Sync Up Next to media apps" data-setup-up-next-sync="1" ${upNextSync ? "checked" : ""} aria-checked="${upNextSync ? "true" : "false"}" />
      </label>
    </div>`;
}

function importProgressBar(status) {
  if (status === "importing") return `<div class="setup-import-progress" role="progressbar" aria-label="Importing"><div class="setup-import-progress-fill is-indeterminate"></div></div>`;
  if (status === "complete") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-complete" style="width:100%"></div></div>`;
  if (status === "failed") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-failed" style="width:100%"></div></div>`;
  return "";
}

function importProgressRow(provider, name, info, pending = false) {
  const providerLabel = provider === "trakt" ? "Trakt" : webhookProviderName(provider);
  // A server pull selected on the previous step but still queued behind
  // Trakt (see the comment at this function's caller) has no backgroundImports
  // entry yet - treat that the same as "importing" with no progress yet
  // rather than falling through to the "not selected" default below.
  const status = info?.enabled === false ? "not_requested" : (info?.status || (pending ? "importing" : "not_started"));
  let badge = `<span class="badge">Not requested</span>`;
  let detail = "This source was not selected for import.";
  if (status === "importing") {
    // The media-server pulls intentionally wait for the routine scheduled
    // sync tick (which is what's actively polling Trakt while its own
    // reconcile is running) to clear before they start - see
    // startServerImport in onboardingImportCoordinator.js. itemCount stays
    // null while queued like this, only becoming a number once the pull
    // actually begins.
    const traktInfo = cachedStatus.onboarding.backgroundImports.trakt;
    const waitingOnTrakt = provider !== "trakt" && (info?.itemCount == null) && traktInfo?.enabled !== false && traktInfo?.status !== "complete";
    badge = `<span class="badge badge-warning">${waitingOnTrakt ? "Waiting" : "Importing"}</span>`;
    detail = waitingOnTrakt
      ? "Waiting for Trakt import to complete."
      : (info?.itemCount == null ? "Fetching watch history in the background." : `${info.itemCount} items imported so far.`);
  } else if (status === "complete") {
    badge = `<span class="badge badge-success">Complete</span>`;
    detail = info.itemCount == null ? "Watch history import finished." : `${info.itemCount} items imported.`;
  } else if (status === "failed") {
    badge = `<span class="badge badge-error">Failed</span>`;
    detail = `${escapeHtml(info.error || "The import could not be completed.")} <a href="#" data-setup-import-retry="1">Retry</a>`;
  } else if (status === "cancelled") {
    badge = `<span class="badge">Cancelled</span>`;
    detail = "The import was cancelled.";
  }
  return `
    <div class="setup-import-row" data-setup-server="${escapeHtml(provider)}">
      <div class="setup-import-source"><b>${escapeHtml(providerLabel)}</b><span>&nbsp;- ${escapeHtml(name)}</span></div>
      <div class="setup-import-result">
        <div class="setup-import-result-head">${badge}<span class="muted-copy">${detail}</span></div>
        ${importProgressBar(status)}
      </div>
    </div>`;
}

function backblazeDestination() {
  return backupSetupData?.watch?.destinations?.find((destination) => destination.type === "backblaze") || null;
}

// Shared by the wizard's own "backup" step (configuring a destination for
// future scheduled backups, mode "setup") and the restore flow's "remote"
// view (connecting to an existing destination to read backups back out of
// it, mode "connect") - same fields, same save/test actions, so a
// destination entered from either place is immediately usable from the
// other. "setup" walks through creating a new bucket/key on Backblaze;
// "connect" assumes that already exists and just asks for its details.
// showScheduleToggle hides the "upload scheduled backups here" checkbox in
// the restore context, where it isn't relevant.
function renderBackblazeCard({ destination, config, showScheduleToggle = true, mode = "setup" } = {}) {
  const settings = destination?.settings || {};
  const secretConfigured = Boolean(destination?.secretFlags?.secretAccessKey);
  const isConnect = mode === "connect";
  const fields = `
    <label class="field-label">Bucket name<input class="field" data-setup-backblaze-field="bucket" value="${escapeAttribute(settings.bucket || "")}" /></label>
    <label class="field-label">Region or S3 endpoint<input class="field" data-setup-backblaze-field="region" value="${escapeAttribute(settings.region || "")}" placeholder="eu-central-003" /></label>
    <label class="field-label">Key ID <span class="muted-copy">(Application Key ID, not the master Account ID)</span><input class="field" data-setup-backblaze-field="accessKeyId" value="${escapeAttribute(settings.accessKeyId || "")}" /></label>
    <label class="field-label">Application key<input class="field" type="password" autocomplete="new-password" data-setup-backblaze-field="secretAccessKey" placeholder="${secretConfigured ? "Configured - leave blank to keep" : ""}" /></label>
    <label class="field-label"><span class="setup-backup-label-line">Key prefix <span class="muted-copy">(optional)</span></span><input class="field" data-setup-backblaze-field="prefix" value="${escapeAttribute(settings.prefix || "plembfin/")}" /></label>`;
  const body = isConnect
    ? `<p class="muted-copy">Enter the bucket and application key from your existing Backblaze B2 account.</p>
       <div class="setup-backblaze-stage-fields setup-backblaze-connect-fields">${fields}</div>`
    : `
      <p class="muted-copy setup-backblaze-signup"><a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener noreferrer">Create a free Backblaze B2 account</a>, then set up a bucket and key for Plekt:</p>
      <div class="setup-backblaze-workflow">
        <section class="setup-backblaze-stage">
          <div class="setup-backblaze-guide">
            <h3>Create a private bucket</h3>
            <ol class="muted-copy setup-backblaze-steps">
              <li>Click <b>Create a Bucket</b>.</li>
              <li>Choose a unique name.</li>
              <li>Set the bucket to <b>Private</b>.</li>
              <li>Leave Default Encryption disabled.</li>
              <li>Leave Object Lock disabled.</li>
              <li>Click <b>Create a Bucket</b> to confirm.</li>
              <li>Copy the bucket name and paste it into <b>Bucket name</b> on the right.</li>
              <li>Copy the endpoint and paste it into <b>Region or S3 endpoint</b> on the right.</li>
            </ol>
          </div>
          <div class="setup-backblaze-stage-fields">
            <label class="field-label">Bucket name<input class="field" data-setup-backblaze-field="bucket" value="${escapeAttribute(settings.bucket || "")}" /></label>
            <label class="field-label">Region or S3 endpoint<input class="field" data-setup-backblaze-field="region" value="${escapeAttribute(settings.region || "")}" placeholder="eu-central-003" /></label>
          </div>
        </section>
        <section class="setup-backblaze-stage">
          <div class="setup-backblaze-guide">
            <h3>Create a restricted application key</h3>
            <ol class="muted-copy setup-backblaze-steps" start="9">
              <li>Click <b>App Keys</b> in the left menu.</li>
              <li>Click <b>Add a New Application Key</b> (not "Generate a New Master Application Key").</li>
              <li>Name the key.</li>
              <li>Allow access to the bucket you just created.</li>
              <li>Leave Read and Write access selected.</li>
              <li>Click <b>Create New Key</b>.</li>
              <li>Copy the keyID and paste it into <b>Key ID</b> on the right.</li>
              <li>Copy the applicationKey and paste it into <b>Application key</b> on the right.</li>
            </ol>
          </div>
          <div class="setup-backblaze-stage-fields">
            <label class="field-label">Key ID <span class="muted-copy">(Application Key ID, not the master Account ID)</span><input class="field" data-setup-backblaze-field="accessKeyId" value="${escapeAttribute(settings.accessKeyId || "")}" /></label>
            <label class="field-label">Application key<input class="field" type="password" autocomplete="new-password" data-setup-backblaze-field="secretAccessKey" placeholder="${secretConfigured ? "Configured - leave blank to keep" : ""}" /></label>
            <label class="field-label"><span class="setup-backup-label-line">Key prefix <span class="muted-copy">(optional)</span></span><input class="field" data-setup-backblaze-field="prefix" value="${escapeAttribute(settings.prefix || "plembfin/")}" /></label>
            <p class="muted-copy setup-backblaze-key-note">Backblaze shows the Application Key only once. Copy it when the key is created.</p>
          </div>
        </section>
      </div>`;
  return `
    <details class="settings-card setup-backup-card setup-backup-remote" ${destination ? "open" : ""}>
      <summary class="setup-backup-heading"><b>Backblaze B2</b>${destination ? `<span class="badge ${destination.enabled ? "badge-success" : ""}">${destination.enabled ? "Configured" : "Disabled"}</span>` : `<span class="badge">Not configured</span>`}</summary>
      <div class="setup-backup-remote-body">
        ${body}
        <div class="setup-backblaze-toggles">
          <label class="checkbox-label"><input type="checkbox" data-setup-backblaze-field="enabled" ${destination?.enabled ? "checked" : ""} /><span>${isConnect ? "Enable this connection" : "Enable this Backblaze destination"}</span></label>
          ${showScheduleToggle ? `<label class="checkbox-label"><input type="checkbox" data-setup-backup-field="remoteEnabled" ${config?.remoteEnabled ? "checked" : ""} /><span>Upload scheduled encrypted Plekt backups to Backblaze</span></label>` : ""}
        </div>
        <div class="setup-backblaze-actions">
          <button type="button" class="button-ghost" data-setup-action="backblaze-save">Save</button>
          <button type="button" class="button-ghost" data-setup-action="backblaze-test">Test</button>
        </div>
      </div>
    </details>`;
}

function renderBackup() {
  if (!backupSetupData) return `<p class="muted-copy">Loading backup settings...</p>`;
  const config = backupSetupData.plembfin?.config || {};
  const destination = backblazeDestination();
  return `
    <p class="muted-copy setup-step-intro">Schedule encrypted local backups so Plekt's settings, connections, and watch data can be recovered. Remote storage is optional.</p>
    <section class="settings-card setup-backup-card setup-backup-section">
      <div class="setup-backup-heading">
        <div><b>Local encrypted backup</b><p class="muted-copy">Stored on this Plekt server.</p></div>
        ${config.enabled ? `<span class="badge badge-success">Scheduled</span>` : `<span class="badge">Not scheduled</span>`}
      </div>
      <label class="checkbox-label"><input type="checkbox" data-setup-backup-field="enabled" ${config.enabled ? "checked" : ""} /><span>Enable daily local backups</span></label>
      <div class="setup-backup-fields">
        <label class="field-label">Backup time<input class="field" type="time" data-setup-backup-field="time" value="${escapeAttribute(config.time || "03:00")}" /></label>
        <label class="field-label">Backups to retain<input class="field" type="number" min="1" max="365" data-setup-backup-field="retention" value="${escapeAttribute(String(config.retention || 7))}" /></label>
        <div class="setup-backup-security">
          <label class="field-label setup-backup-passphrase"><span class="setup-backup-label-line">Encryption passphrase <span class="muted-copy">(at least 12 characters)</span></span><input class="field" type="password" autocomplete="new-password" data-setup-backup-field="passphrase" placeholder="${config.passphraseStored ? "Saved - leave blank to keep" : ""}" /></label>
          <label class="checkbox-label setup-backup-remember"><input type="checkbox" data-setup-backup-field="rememberPassphrase" ${config.rememberPassphrase || config.passphraseStored ? "checked" : ""} /><span>Remember the passphrase for scheduled backups</span></label>
          <p class="muted-copy setup-backup-passphrase-help">This passphrase encrypts every backup, local or remote. It has to be entered and "remembered" here before daily or remote backups can be scheduled, since a scheduled backup runs unattended with nobody there to type it in.</p>
        </div>
      </div>
    </section>
    ${renderBackblazeCard({ destination, config, showScheduleToggle: true })}`;
}

function updateBackupContinueAction() {
  const button = elements.setupPageRoot?.querySelector('[data-setup-action="continue"]');
  if (!button || currentStep() !== "backup") return;
  const shouldSave = setupFieldChecked('[data-setup-backup-field="enabled"]')
    || setupFieldChecked('[data-setup-backup-field="remoteEnabled"]')
    || setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  button.textContent = shouldSave ? "Save and continue" : "Skip for now";
  button.classList.toggle("button-primary", shouldSave);
  button.classList.toggle("button-ghost", !shouldSave);
}

function setupFieldValue(selector) {
  return elements.setupPageRoot?.querySelector(selector)?.value?.trim() || "";
}

function setupFieldChecked(selector) {
  return Boolean(elements.setupPageRoot?.querySelector(selector)?.checked);
}

function setPassphraseError(active) {
  elements.setupPageRoot?.querySelector(".setup-backup-security")?.classList.toggle("setup-field-error", Boolean(active));
}

function passphraseSatisfied(previous, rememberPassphrase, passphrase) {
  return rememberPassphrase && (previous.passphraseStored || passphrase.length >= 12);
}

async function saveBackblazeDestinationFromFields({ requireComplete } = {}) {
  const destination = backblazeDestination();
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  const shouldValidate = requireComplete ?? destinationEnabled;
  const region = setupFieldValue('[data-setup-backblaze-field="region"]');
  const bucket = setupFieldValue('[data-setup-backblaze-field="bucket"]');
  const accessKeyId = setupFieldValue('[data-setup-backblaze-field="accessKeyId"]');
  const secretAccessKey = setupFieldValue('[data-setup-backblaze-field="secretAccessKey"]');
  if (shouldValidate && (!region || !bucket || !accessKeyId || (!destination?.secretFlags?.secretAccessKey && !secretAccessKey))) {
    setMessage("Complete the Backblaze region, bucket, Key ID, and application key.", "error");
    return null;
  }
  if (!shouldValidate && !destination?.id) return null;
  const body = await api("/api/watch-backups", {
    method: "POST",
    body: JSON.stringify({
      action: "save-destination",
      destination: shouldValidate
        ? {
            ...(destination?.id ? { id: destination.id } : {}), type: "backblaze", label: "Backblaze B2", enabled: destinationEnabled,
            settings: { region, bucket, accessKeyId, prefix: setupFieldValue('[data-setup-backblaze-field="prefix"]') },
            secrets: secretAccessKey ? { secretAccessKey } : {},
          }
        : {
            id: destination.id, type: "backblaze", label: destination.label || "Backblaze B2", enabled: false,
            settings: { ...destination.settings }, secrets: {},
          },
    }),
  });
  return body.destination;
}

async function saveBackblazeAction() {
  const saved = await saveBackblazeDestinationFromFields({ requireComplete: true }).catch((error) => {
    setMessage(error.message, "error");
    return null;
  });
  if (!saved) return;
  await loadBackupSetupData({ force: true });
  setMessage("Backblaze destination saved.", "success");
}

async function testBackblazeAction() {
  try {
    const saved = await saveBackblazeDestinationFromFields({ requireComplete: true });
    if (!saved) return;
    const result = await api("/api/watch-backups", {
      method: "POST",
      body: JSON.stringify({ action: "test-destination", destinationId: saved.id }),
    });
    await loadBackupSetupData({ force: true });
    setMessage(`Connection OK - ${result.result?.detail || "reachable"}.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function saveBackupSetup() {
  if (!backupSetupData) return false;
  const previous = backupSetupData.plembfin?.config || {};
  const enabled = setupFieldChecked('[data-setup-backup-field="enabled"]');
  const remoteEnabled = setupFieldChecked('[data-setup-backup-field="remoteEnabled"]');
  const rememberPassphrase = setupFieldChecked('[data-setup-backup-field="rememberPassphrase"]');
  const passphrase = setupFieldValue('[data-setup-backup-field="passphrase"]');
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  setPassphraseError(false);
  if (enabled && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
    setPassphraseError(true);
    setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled backups.", "error");
    return false;
  }
  if (remoteEnabled && !previous.remotePassphraseStored && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
    setPassphraseError(true);
    setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled remote backups.", "error");
    return false;
  }
  if (remoteEnabled && !destinationEnabled) {
    setMessage("Enable and configure the Backblaze destination before turning on remote backups.", "error");
    return false;
  }
  if (destinationEnabled || backblazeDestination()?.id) {
    const saved = await saveBackblazeDestinationFromFields();
    if (!saved) return false;
  }
  await api("/api/plembfin-backups", {
    method: "POST",
    body: JSON.stringify({ action: "configure", config: {
      ...previous, enabled, remoteEnabled,
      time: setupFieldValue('[data-setup-backup-field="time"]') || "03:00",
      retention: Number(setupFieldValue('[data-setup-backup-field="retention"]')) || 7,
      rememberPassphrase,
      passphrase: rememberPassphrase ? passphrase : "",
    } }),
  });
  await loadBackupSetupData({ force: true });
  return true;
}

function renderReview(hasTestedServer) {
  const s = cachedStatus;
  const testedServers = s.servers.filter((server) => server.tested);
  const requiredWebhookServers = testedServers.filter((server) => webhookSetupRequired(server.provider));
  const webhooksReady = requiredWebhookServers.every((server) => s.onboarding.acknowledgements.webhooks?.[server.provider]);
  const imports = [
    ...Object.values(s.onboarding.backgroundImports.servers || {}),
    ...(s.trakt.connected ? [s.onboarding.backgroundImports.trakt] : []),
  ].filter((entry) => entry?.enabled !== false && entry?.status !== "not_started");
  const completedImports = imports.filter((entry) => entry.status === "complete").length;
  const runningImports = imports.filter((entry) => entry.status === "importing").length;
  const backupConfig = backupSetupData?.plembfin?.config || {};
  const rows = [
    { label: "Account security", detail: "Administrator account secured", status: "Ready", tone: "success" },
    {
      label: "Media Servers",
      detail: testedServers.map((server) => server.serverName || webhookProviderName(server.provider)).join(", ") || "None connected - tracking will be manual",
      status: `${testedServers.length} connected`, tone: testedServers.length ? "success" : "warning",
    },
    {
      label: "Metadata", detail: s.metadata.tmdbConfigured ? "TMDB is configured for artwork and discovery" : "TMDB has not been configured",
      status: s.metadata.tmdbConfigured ? "Configured" : "Not configured", tone: s.metadata.tmdbConfigured ? "success" : "muted",
    },
    {
      label: "Updates", detail: webhooksReady ? "Plex automatic updates and configured server webhooks are ready" : "An Emby or Jellyfin webhook still needs confirmation",
      status: webhooksReady ? "Ready" : "Setup pending", tone: webhooksReady ? "success" : "warning",
    },
    {
      label: "Trakt", detail: s.trakt.connected ? `Connected${s.trakt.username ? ` as ${s.trakt.username}` : " account"}` : "Two-way Trakt sync was skipped",
      status: s.trakt.connected ? "Connected" : "Optional", tone: s.trakt.connected ? "success" : "muted",
    },
    {
      label: "Imports",
      detail: runningImports ? `${runningImports} import${runningImports === 1 ? " is" : "s are"} still running in the background` : (imports.length ? "Selected watch-history imports finished" : "No history imports were requested"),
      status: runningImports ? `${runningImports} running` : `${completedImports} complete`, tone: runningImports ? "warning" : "success",
    },
    {
      label: "Options",
      detail: `${WATCH_IMPORT_MODES.find((option) => option.value === setupWatchImportMode())?.label || "Require review"}; fast local-network sync ${setupFastLocalPacing() ? "enabled" : "off"}`,
      status: "Saved", tone: "success",
    },
    {
      label: "Backups",
      detail: backupConfig.enabled
        ? `Daily encrypted backup at ${backupConfig.time || "03:00"}${backupConfig.remoteEnabled ? ", mirrored to Backblaze B2" : ", stored locally"}`
        : "Not scheduled; this can be configured later in Settings",
      status: backupConfig.enabled ? "Scheduled" : "Optional", tone: backupConfig.enabled ? "success" : "muted",
    },
  ];
  return `
    <div class="setup-review-lead ${hasTestedServer ? "is-ready" : "is-optional"}">
      <span class="setup-review-mark" aria-hidden="true">${hasTestedServer ? "✓" : "!"}</span>
      <div><b>${hasTestedServer ? "Plekt is ready" : "Ready when you are"}</b><p>${hasTestedServer ? "Review your connections and open the dashboard when everything looks right." : "No media server is connected, so watches will need to be marked manually from search. Finish now and connect one anytime from Settings, or go back to add one first."}</p></div>
    </div>
    <div class="setup-review-list">
      ${rows.map((row) => `
        <div class="setup-review-row">
          <div class="setup-review-copy"><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.detail)}</span></div>
          <span class="badge ${row.tone === "success" ? "badge-success" : row.tone === "warning" ? "badge-warning" : row.tone === "error" ? "badge-error" : ""}">${escapeHtml(row.status)}</span>
        </div>`).join("")}
    </div>`;
}

function stepNeighbor(direction) {
  const ids = STEPS.map((s) => s.id);
  const index = ids.indexOf(currentStep());
  const next = ids[index + direction];
  return next || ids[index];
}

async function startTraktConnect() {
  try {
    const flow = await api("/api/tracker-auth/trakt/start", {
      method: "POST",
      body: JSON.stringify({ preferEarlierWatchedDate: preferEarlierTraktDateChoice }),
    });
    traktFlow = flow;
    renderSetupPage();
    pollTraktFlow();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function pollTraktFlow() {
  clearTimeout(traktPollTimer);
  if (!traktFlow) return;
  traktPollTimer = setTimeout(checkTraktFlow, (traktFlow.intervalSeconds || 5) * 1000);
}

// The trakt.tv activation page opens in a separate tab, backgrounding this
// one - browsers throttle setTimeout in hidden tabs well beyond the nominal
// poll interval, so a user who confirms the code and switches straight back
// can be stuck waiting on a delayed timer. Checking immediately on return
// fixes that; the server's own lastPolledAt guard (trackerAuth.js) already
// makes an extra/early check a no-op against Trakt's own rate limit.
async function checkTraktFlow() {
  clearTimeout(traktPollTimer);
  if (!traktFlow) return;
  try {
    const result = await api(`/api/tracker-auth/trakt/${traktFlow.flowId}/status`);
    if (result.status === "completed") {
      traktFlow = null;
      await loadSetupStatus();
      return;
    }
    if (result.status === "expired" || result.status === "denied") {
      traktFlow = null;
      setMessage("Trakt authorization expired or was denied. Try again.", "error");
      renderSetupPage();
      return;
    }
    pollTraktFlow();
  } catch {
    pollTraktFlow();
  }
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
  if (event.target.matches("[data-setup-trakt-date-pref]")) {
    preferEarlierTraktDateChoice = event.target.checked;
    return;
  }
  if (event.target.matches("[data-setup-watchlist-toggle]")) {
    pendingWatchlistChoice = event.target.checked;
    return;
  }
  if (event.target.matches("[data-setup-watch-import-mode]")) {
    pendingWatchImportMode = event.target.value;
    return;
  }
  if (event.target.matches("[data-setup-fast-local-sync]")) {
    pendingFastLocalPacing = event.target.checked;
    event.target.setAttribute("aria-checked", event.target.checked ? "true" : "false");
    return;
  }
  if (event.target.matches("[data-setup-up-next-sync]")) {
    pendingUpNextSync = event.target.checked;
    event.target.setAttribute("aria-checked", event.target.checked ? "true" : "false");
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
      pendingTraktImportChoice = importToggle.checked;
      renderSetupPage();
    }
    return;
  }
  const webhookAck = event.target.closest("[data-setup-webhook-ack]");
  if (webhookAck) {
    const provider = webhookAck.dataset.setupWebhookAck;
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ webhookAck: { provider } }) })
      .then(() => loadSetupStatus())
      .catch((error) => setMessage(error.message, "error"));
  }
}

async function handleSetupClick(event) {
  const dismissChecklist = event.target.closest("[data-setup-dismiss-checklist]");
  if (dismissChecklist) {
    api("/api/setup/checklist/dismiss", { method: "POST" }).then(() => loadSetupStatus()).then(() => renderDashboardChecklist()).catch(() => {});
    return;
  }
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
    const confirmed = await openConfirmDialog({
      title: "Dismiss onboarding reminder?",
      body: "This hides the \"Complete onboarding\" reminder for good. You can still finish setup any time from Settings.",
      confirmLabel: "Dismiss permanently",
    });
    if (confirmed) api("/api/setup/cta-dismiss", { method: "POST" }).then(() => loadSetupStatus()).catch(() => {});
    return;
  }
  if (!elements.setupPageRoot?.contains(event.target)) return;
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
  const action = event.target.closest("[data-setup-action]")?.dataset.setupAction;
  if (!action) return;
  if (action === "continue") {
    if (currentStep() === "servers") {
      // startServerImport (server-side) now waits out an in-progress Trakt
      // reconcile itself via its own retrying timer, so this always fires
      // immediately - the wait survives a page reload this way, unlike the
      // old client-side polling loop that silently vanished on one.
      await startPendingServerImports().catch(() => {});
    }
    if (currentStep() === "trakt") {
      const started = await startPendingTraktImport();
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
    setCurrentStep(stepNeighbor(1));
  } else if (action === "back") {
    setCurrentStep(stepNeighbor(-1));
  } else if (action === "exit") {
    restoreView = null;
    navigateTo("/settings");
  } else if (action === "trakt-connect") {
    startTraktConnect();
  } else if (action === "backblaze-save") {
    saveBackblazeAction();
  } else if (action === "backblaze-test") {
    testBackblazeAction();
  } else if (action === "trakt-skip") {
    api("/api/setup/step", { method: "POST", body: JSON.stringify({ traktSkipped: true }) })
      .then(() => { setCurrentStep(stepNeighbor(1)); })
      .catch((error) => setMessage(error.message, "error"));
  } else if (action === "complete") {
    api("/api/setup/complete", { method: "POST" })
      .then(() => { restoreView = null; navigateTo("/"); })
      .catch((error) => setMessage(error.message, "error"));
  }
}
