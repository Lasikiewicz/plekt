import { state } from "./state.js?v=2.1.1.0.8";
import { escapeHtml } from "./utils.js?v=2.1.1.0.8";

const PROVIDERS = ["plex", "emby", "jellyfin", "trakt"];
const PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin", trakt: "Trakt" };
let callbacks = {};
let status = null;
let refreshTimer = null;

function authHeaders() {
  return callbacks.authHeaders?.() || {};
}

function elements() {
  return {
    panel: document.querySelector("#ratingSyncPanel"),
    enabled: document.querySelector("#ratingSyncEnabled"),
    providerRows: document.querySelector("#ratingSyncProviderRows"),
    status: document.querySelector("#ratingSyncStatus"),
    help: document.querySelector("#ratingSyncHelp"),
    syncNow: document.querySelector("#ratingSyncNow"),
  };
}

function currentConfig() {
  const saved = state.savedConfig?.ratingSync || {};
  const enabled = Boolean(saved.enabled);
  return {
    enabled,
    intervalMinutes: 5,
    initialSyncMode: "import",
    conflictPolicy: "local_wins",
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, enabled ? "bidirectional" : "off"])),
  };
}

function renderProviderRows(config = currentConfig()) {
  const ui = elements();
  if (!ui.providerRows) return;
  const entries = status?.providers || PROVIDERS.map((provider) => ({ provider, configured: false, connectionStatus: "not_connected", queue: {} }));
  ui.providerRows.innerHTML = entries.map((entry) => {
    const provider = entry.provider;
    const connection = entry.configured ? (entry.connectionStatus || "configured") : "Not connected";
    const pending = Number(entry.queue?.pending || 0) + Number(entry.queue?.processing || 0);
    const queueDetails = [
      pending ? `${pending} queued` : "",
      ...queueIssueDetails(entry.queue),
    ].filter(Boolean);
    const stateLabel = !entry.configured ? "Not connected" : queueDetails.length ? queueDetails.join(" · ") : config.enabled ? "Syncing" : "Available";
    const hold = entry.run?.cursor?.ratingHold;
    return `<div class="personal-rating-sync-provider">
      <strong>${escapeHtml(PROVIDER_LABELS[provider] || provider)}</strong>
      <small>${escapeHtml(entry.configured ? `${connection} · ${stateLabel}` : stateLabel)}</small>
      ${hold ? `<div role="alert"><strong>Rating scan held for review</strong>
        <p>${Number(hold.missingCount)} of ${Number(hold.baselineCount)} ratings are missing on ${escapeHtml(PROVIDER_LABELS[provider])}. No ratings were cleared.</p>
        ${entry.run.last_error ? `<p>${escapeHtml(entry.run.last_error)}</p>` : ""}
        <details><summary>Review missing titles</summary><ul>${hold.items.map(item => `<li>${escapeHtml(item.title)}</li>`).join("")}</ul></details>
        <button type="button" class="button-secondary" data-rating-hold="approve" data-provider="${escapeHtml(provider)}" data-run-id="${escapeHtml(entry.run.run_id)}">Approve these removals</button>
        <button type="button" class="button-ghost" data-rating-hold="dismiss" data-provider="${escapeHtml(provider)}" data-run-id="${escapeHtml(entry.run.run_id)}">Dismiss and keep ratings</button>
        <small>Approval rechecks this removal set. Dismissal keeps ratings; a later scan may ask again.</small></div>` : ""}
    </div>`;
  }).join("");
}

function applyControls(config = currentConfig()) {
  const ui = elements();
  if (!ui.enabled) return;
  ui.enabled.checked = Boolean(config.enabled);
  if (ui.syncNow) ui.syncNow.disabled = !config.enabled;
  renderProviderRows(config);
}

function selectedConfig() {
  const ui = elements();
  const enabled = Boolean(ui.enabled?.checked);
  return {
    enabled,
    intervalMinutes: 5,
    initialSyncMode: "import",
    conflictPolicy: "local_wins",
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, enabled ? "bidirectional" : "off"])),
  };
}

function queueIssueCount(queue = {}) {
  return Number(queue.failed || 0)
    + Number(queue.not_found ?? queue.notFound ?? 0)
    + Number(queue.reauth_required ?? queue.reauthRequired ?? 0);
}

function queueIssueDetails(queue = {}) {
  const details = [];
  const failed = Number(queue.failed || 0);
  const notFound = Number(queue.not_found ?? queue.notFound ?? 0);
  const reauthRequired = Number(queue.reauth_required ?? queue.reauthRequired ?? 0);
  if (failed) details.push(`${failed} failed`);
  if (notFound) details.push(`${notFound} not found`);
  if (reauthRequired) details.push(`${reauthRequired} need re-auth`);
  return details;
}

function setBusy(busy) {
  const ui = elements();
  if (ui.enabled) ui.enabled.disabled = Boolean(busy);
  if (ui.syncNow) ui.syncNow.disabled = Boolean(busy) || !currentConfig().enabled;
  ui.panel?.toggleAttribute("aria-busy", Boolean(busy));
}

function renderStatus(nextStatus = status) {
  const ui = elements();
  if (!ui.panel || !nextStatus) return;
  const config = nextStatus.config || currentConfig();
  if (nextStatus.running) {
    if (ui.status) ui.status.textContent = "Running…";
  } else if (!config.enabled) {
    if (ui.status) ui.status.textContent = "Disabled";
  } else {
    const pending = Number(nextStatus.queue?.pending || 0) + Number(nextStatus.queue?.processing || 0);
    const issues = queueIssueCount(nextStatus.queue) + (nextStatus.providers || []).filter(entry => entry.run?.status === "held").length;
    if (ui.status) ui.status.textContent = issues
      ? `${issues} sync issue${issues === 1 ? "" : "s"}`
      : pending ? `${pending} queued` : "Two-way Active";
  }
  const configured = (nextStatus.providers || []).filter((entry) => entry.configured && entry.direction !== "off").length;
  const issues = queueIssueCount(nextStatus.queue) + (nextStatus.providers || []).filter(entry => entry.run?.status === "held").length;
  if (ui.help) {
    ui.help.textContent = !config.enabled
      ? "Disabled: ratings stay in Plekt and are not sent to any provider."
      : issues
        ? "Some ratings need attention. Review the provider rows and run sync again."
        : configured
        ? `Plekt is syncing ratings across ${configured} connected service${configured === 1 ? "" : "s"}. Changes made anywhere are sent to the others.`
        : "Connect at least one media server or Trakt to sync ratings.";
  }
}

export function applyRatingSyncConfig(config = {}) {
  if (config?.ratingSync) {
    state.savedConfig = { ...state.savedConfig, ratingSync: config.ratingSync };
  }
  applyControls(currentConfig());
  renderStatus(status);
}

// Opening Settings and applying its saved config both ask for status within
// moments of each other; maxAgeMs lets those callers share one request. Saves
// and explicit refreshes pass nothing and always fetch.
let statusRequest = null;
let statusAt = 0;
export async function refreshRatingSyncStatus({ maxAgeMs = 0 } = {}) {
  if (!state.token) return null;
  if (maxAgeMs && statusRequest) return statusRequest;
  if (maxAgeMs && status && Date.now() - statusAt < maxAgeMs) return status;
  statusRequest = fetchRatingSyncStatus().finally(() => { statusRequest = null; });
  return statusRequest;
}

async function fetchRatingSyncStatus() {
  const response = await fetch("/api/rating-sync/status", { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Rating sync status failed with ${response.status}`);
  status = body;
  statusAt = Date.now();
  if (body.config) {
    state.savedConfig = { ...state.savedConfig, ratingSync: body.config };
    applyControls(body.config);
  }
  renderStatus(body);
  return body;
}

async function saveSettings() {
  const ui = elements();
  const payload = selectedConfig();
  setBusy(true);
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ratingSync: payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (body.details || []).join("; ") || `Rating settings save failed with ${response.status}`);
    if (body.config) {
      state.savedConfig = body.config;
      callbacks.onConfig?.(body.config);
      applyControls(body.config.ratingSync || payload);
    }
    callbacks.setMessage?.("Personal rating sync settings saved.", "success");
    await refreshRatingSyncStatus().catch(() => null);
    if (payload.enabled) await runSync();
  } finally {
    setBusy(false);
  }
}

async function runSync() {
  setBusy(true);
  try {
    const response = await fetch("/api/rating-sync/run", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", providers: [] }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Personal rating sync failed with ${response.status}`);
    const issues = queueIssueCount(body.queue);
    const partial = body.status === "partial" || issues > 0;
    callbacks.setMessage?.(partial
      ? `Personal rating sync completed with ${issues || "some"} sync issue${issues === 1 ? "" : "s"}. Review Settings → Sync Tools.`
      : "Personal rating sync completed.", partial ? "muted" : "success");
    await refreshRatingSyncStatus().catch(() => null);
  } catch (error) {
    callbacks.setMessage?.(error.message || "Personal rating sync failed.", "error");
  } finally {
    setBusy(false);
    renderStatus(status);
  }
}

export function runRatingSyncNow() {
  return runSync();
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.token) refreshRatingSyncStatus().catch(() => null);
  }, 30_000);
}

export function resumeRatingSyncSettings() {
  startRefreshTimer();
  return refreshRatingSyncStatus({ maxAgeMs: 2000 });
}

export function initRatingSyncSettings(nextCallbacks = {}) {
  callbacks = nextCallbacks;
  const ui = elements();
  if (!ui.panel || ui.panel.dataset.bound === "1") return;
  ui.panel.dataset.bound = "1";
  applyControls(currentConfig());
  // Only meaningful while sync is on; a run with it off reconciles nothing.
  ui.syncNow?.addEventListener("click", () => { runSync(); });
  ui.providerRows?.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-rating-hold]");
    if (!button || ui.panel.hasAttribute("aria-busy")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/rating-sync/run", { method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: `${button.dataset.ratingHold}-held`, provider: button.dataset.provider, runId: button.dataset.runId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not review held scan");
      callbacks.setMessage?.(body.status === "dismissed" ? "Scan dismissed. Ratings kept." : body.providers?.some(entry => entry.status === "held") ? "Removal set changed. Review the updated warning." : body.status === "partial" ? "Scan could not be fully applied. Review provider status and retry." : "Approved scan applied.", "muted");
    } catch (error) { callbacks.setMessage?.(error.message, "error"); }
    finally { await refreshRatingSyncStatus().catch(() => null); setBusy(false); }
  });
  ui.enabled?.addEventListener("change", () => {
    if (ui.status) ui.status.textContent = "Saving…";
    saveSettings().catch((error) => {
      applyControls(currentConfig());
      callbacks.setMessage?.(error.message, "error");
    });
  });
  document.addEventListener("plembfin:config-changed", () => {
    applyControls(currentConfig());
    refreshRatingSyncStatus({ maxAgeMs: 2000 }).catch(() => null);
  });
  startRefreshTimer();
}

export function stopRatingSyncSettings() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
