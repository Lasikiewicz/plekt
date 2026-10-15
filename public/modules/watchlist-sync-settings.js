import { state } from "./state.js?v=2.0.0.2.0";
import { escapeHtml } from "./utils.js?v=2.0.0.2.0";

// Plex-only: Emby and Jellyfin have no watchlist concept, so they were retired
// from this projection. See the note on WATCHLIST_SYNC_PROVIDERS in configStore.js.
const PROVIDERS = ["plex"];
const PROVIDER_LABELS = { plex: "Plex" };
let callbacks = {};
let status = null;
let refreshTimer = null;

function authHeaders() {
  return callbacks.authHeaders?.() || {};
}

function elements() {
  return {
    panel: document.querySelector("#watchlistSyncPanel"),
    enabled: document.querySelector("#watchlistSyncEnabled"),
    providerRows: document.querySelector("#watchlistSyncProviderRows"),
    status: document.querySelector("#watchlistSyncStatus"),
    issues: document.querySelector("#watchlistSyncIssues"),
    // The dynamic one-line state gets its own element. `#watchlistSyncHelp` is
    // owned by renderSettingsInlineHelp's static guide, and writing both to one
    // element meant whichever ran last destroyed the other - with status polling
    // every 30 seconds, that was always the guide.
    summary: document.querySelector("#watchlistSyncSummary"),
    syncNow: document.querySelector("#watchlistSyncNow"),
  };
}

function defaultProviderConfig(provider) {
  return {
    enabled: false,
    representation: "native",
    writeEnabled: false,
    publishConfirmedAt: 0,
  };
}

function currentConfig() {
  const saved = state.savedConfig?.watchlistSync || {};
  return {
    enabled: Boolean(saved.enabled),
    intervalMinutes: 5,
    importRemoteAdditions: Boolean(saved.enabled),
    providers: Object.fromEntries(PROVIDERS.map((provider) => [
      provider,
      { ...defaultProviderConfig(provider), ...(saved.providers?.[provider] || {}), enabled: Boolean(saved.enabled), ...(provider === "plex" ? { writeEnabled: Boolean(saved.enabled) } : {}) },
    ])),
  };
}

function connectionLabel(entry) {
  const connection = entry.connection;
  if (!entry.configured) return "Not connected";
  const name = connection?.serverName || "Connected server";
  const user = connection?.remoteUsername || connection?.remoteUserId;
  return user ? `${name} · ${user}` : name;
}

function renderProviderRows(config = currentConfig()) {
  const ui = elements();
  if (!ui.providerRows) return;
  const entries = status?.providers || PROVIDERS.map((provider) => ({ provider, configured: false, connection: null, capability: "unavailable", queue: {} }));
  ui.providerRows.innerHTML = entries.map((entry) => {
    const provider = entry.provider;
    const pending = Number(entry.pending || 0);
    const capability = entry.capability === "full"
        ? "Ready"
        : entry.capability === "read_only"
          ? "Read-only"
          : entry.reason || entry.capability || "Unavailable";
    const syncState = !entry.configured ? "Not connected" : !config.enabled ? "Available" : capability;
    return `<div class="personal-watchlist-sync-provider">
      <div class="personal-watchlist-sync-provider-copy">
        <strong>${escapeHtml(PROVIDER_LABELS[provider] || provider)}</strong>
        <small>${entry.configured ? `${escapeHtml(connectionLabel(entry))} · ` : ""}${escapeHtml(syncState)}${pending ? ` · ${pending} queued` : ""}${Number(entry.unavailable || 0) ? ` · ${Number(entry.unavailable)} unmatched` : ""}</small>
      </div>
    </div>`;
  }).join("");
}

function formatTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function issueCopy(issue) {
  const label = PROVIDER_LABELS[issue.provider] || issue.provider;
  const count = Number(issue.count || 0);
  const items = `${count} item${count === 1 ? "" : "s"}`;
  const titles = (issue.titles || []).length ? `${(issue.titles || []).join(", ")}${count > (issue.titles || []).length ? ", and others" : ""}` : "";
  if (issue.status === "reauth_required") {
    return {
      tone: "error",
      title: `${label} rejected Plekt's saved sign-in`,
      body: `${items} could not be written to the ${label} watchlist because the stored ${label} credentials were refused. Reconnect ${label} in Settings → Media Servers, then retry the queued changes.`,
      titles,
      action: { label: `Reconnect ${label}`, href: "/settings/media-servers" },
    };
  }
  if (issue.status === "not_available") {
    // Plex's watchlist is account-scoped over the whole Plex catalogue, so a
    // title that cannot be placed there was not identified rather than not owned.
    return {
      tone: "info",
      title: `${items} could not be matched in the Plex catalogue`,
      body: `Plekt could not find ${count === 1 ? "a matching title" : "matching titles"} in Plex, so ${count === 1 ? "it" : "they"} cannot be added to your Plex watchlist. This usually means the entry is missing the provider IDs Plex matches on. ${count === 1 ? "It stays" : "They stay"} on the Plekt watchlist and Plekt keeps trying.`,
      titles,
      action: null,
    };
  }
  const reason = String(issue.lastError || "").trim();
  return {
    tone: "error",
    title: `${label} rejected ${items}`,
    body: `${reason || `${label} returned an error while applying the change.`} Attempt ${Number(issue.attemptCount || 0) || 1} failed${issue.retryAt ? `; the next automatic attempt is due ${formatTime(issue.retryAt)}` : ""}. Retry queued changes to try again immediately.`,
    titles,
    action: null,
  };
}

// A provider whose snapshot read fails is invisible in the queue: nothing can be
// queued for a list Plekt could not fetch. That read is also the only way an
// addition made in the provider reaches the Plekt watchlist, so a failed run
// silently stops imports in both directions and has to be reported on its own.
function runFailureCards(nextStatus) {
  return (nextStatus?.providers || [])
    .filter((entry) => entry.configured && entry.lastRun?.status === "failed")
    .map((entry) => {
      const label = PROVIDER_LABELS[entry.provider] || entry.provider;
      const reason = String(entry.lastRun?.last_error || "").trim();
      return {
        tone: "error",
        title: `Plekt could not read the ${label} watchlist`,
        body: `${reason || `${label} did not return a usable watchlist.`} Until this read succeeds, items added in ${label} are not imported into the Plekt watchlist and Plekt cannot confirm what ${label} already holds.${entry.lastRun?.updated_at ? ` Last attempted ${formatTime(entry.lastRun.updated_at)}.` : ""}`,
        titles: "",
        action: null,
      };
    });
}

function renderIssues(nextStatus = status, config = currentConfig()) {
  const ui = elements();
  if (!ui.issues) return;
  const issues = config.enabled ? (nextStatus?.issues || []) : [];
  const runFailures = config.enabled ? runFailureCards(nextStatus) : [];
  if (!issues.length && !runFailures.length) {
    ui.issues.innerHTML = "";
    ui.issues.classList.add("hidden");
    return;
  }
  const retryable = runFailures.length || issues.some((issue) => issue.status !== "not_available");
  ui.issues.classList.remove("hidden");
  ui.issues.innerHTML = `${[...runFailures, ...issues.map(issueCopy)].map((copy) => {
    return `<div class="personal-watchlist-sync-issue personal-watchlist-sync-issue-${copy.tone}">
      <div>
        <strong>${escapeHtml(copy.title)}</strong>
        <small>${escapeHtml(copy.body)}</small>
        ${copy.titles ? `<small class="personal-watchlist-sync-issue-titles">Affected: ${escapeHtml(copy.titles)}</small>` : ""}
      </div>
      ${copy.action ? `<button type="button" class="button-ghost sync-action-btn" data-settings-path="${escapeHtml(copy.action.href)}">${escapeHtml(copy.action.label)}</button>` : ""}
    </div>`;
  }).join("")}
  ${retryable ? `<div class="personal-watchlist-sync-issue-actions"><button type="button" class="button-ghost sync-action-btn" id="watchlistSyncRetry">${runFailures.length ? "Retry now" : "Retry queued changes"}</button></div>` : ""}`;
  // `retry` clears the backoff on stuck queue rows but deliberately skips the
  // provider snapshot, so it alone can never re-attempt a failed read. A run
  // failure therefore needs the reconcile pass afterwards to try reading again.
  const needsQueueRetry = issues.some((issue) => issue.status !== "not_available");
  ui.issues.querySelector("#watchlistSyncRetry")?.addEventListener("click", async () => {
    if (needsQueueRetry) await runSync("retry", { silent: runFailures.length > 0 });
    if (runFailures.length) await runSync("run");
  });
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
  const saved = currentConfig();
  return {
    enabled: Boolean(ui.enabled?.checked),
    intervalMinutes: 5,
    importRemoteAdditions: Boolean(ui.enabled?.checked),
    providers: Object.fromEntries(PROVIDERS.map((provider) => [
      provider,
      {
        enabled: Boolean(ui.enabled?.checked),
        representation: saved.providers[provider].representation,
        ...(provider === "plex" ? { writeEnabled: Boolean(ui.enabled?.checked) } : {}),
        publishConfirmedAt: Number(saved.providers[provider].publishConfirmedAt || 0),
      },
    ])),
  };
}

function setBusy(busy) {
  const ui = elements();
  if (ui.enabled) ui.enabled.disabled = Boolean(busy);
  const retry = ui.issues?.querySelector("#watchlistSyncRetry");
  if (retry) retry.disabled = Boolean(busy);
  if (ui.syncNow) ui.syncNow.disabled = Boolean(busy) || !currentConfig().enabled;
  ui.panel?.toggleAttribute("aria-busy", Boolean(busy));
}

function renderStatus(nextStatus = status) {
  const ui = elements();
  if (!ui.panel || !nextStatus) return;
  const config = currentConfig();
  const pending = Number(nextStatus.queue?.pending || 0) + Number(nextStatus.queue?.processing || 0);
  const blocking = Number(nextStatus.queue?.failed || 0) + Number(nextStatus.queue?.reauth_required || 0);
  const unavailable = Number(nextStatus.queue?.not_available || 0);
  if (!config.enabled) ui.status && (ui.status.textContent = "Disabled");
  else if (blocking) ui.status && (ui.status.textContent = "Needs attention");
  else if (unavailable) ui.status && (ui.status.textContent = `Synced · ${unavailable} unmatched`);
  else if (pending) ui.status && (ui.status.textContent = `${pending} queued`);
  else ui.status && (ui.status.textContent = "Synced");

  const enabled = (nextStatus.providers || []).filter((entry) => entry.configured && entry.read && entry.add && entry.remove).length;
  if (ui.summary) {
    ui.summary.textContent = !config.enabled
      ? "Plekt remains the canonical list. Turn sync on to keep it aligned with your Plex account watchlist."
      : blocking
        ? `${blocking} watchlist change${blocking === 1 ? " needs" : "s need"} attention. The details below explain what each service reported and what to do about it.`
        : unavailable
          ? `${unavailable} watchlist item${unavailable === 1 ? "" : "s"} could not be matched in the Plex catalogue. The details below name ${unavailable === 1 ? "it" : "them"}.`
          : enabled
            ? "Plekt and your Plex watchlist are in sync. A change in either one is sent to the other."
            : "Connect a Plex account to sync your Plekt watchlist.";
  }
  renderProviderRows(config);
  renderIssues(nextStatus, config);
}

export function applyWatchlistSyncConfig(config = {}) {
  if (config?.watchlistSync) state.savedConfig = { ...state.savedConfig, watchlistSync: config.watchlistSync };
  applyControls(currentConfig());
  renderStatus(status);
}

async function requestStatus() {
  const response = await fetch("/api/watchlist-sync/status", { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Watchlist sync status failed with ${response.status}`);
  status = body;
  statusAt = Date.now();
  renderStatus(body);
  return body;
}

// Opening Settings and applying its saved config both ask for status within
// moments of each other; maxAgeMs lets those callers share one request. Saves
// and explicit refreshes pass nothing and always fetch.
let statusRequest = null;
let statusAt = 0;
export async function refreshWatchlistSyncStatus({ maxAgeMs = 0 } = {}) {
  if (!state.token) return null;
  if (maxAgeMs && statusRequest) return statusRequest;
  if (maxAgeMs && status && Date.now() - statusAt < maxAgeMs) return status;
  statusRequest = requestStatus().finally(() => { statusRequest = null; });
  return statusRequest;
}

async function saveSettings() {
  const ui = elements();
  setBusy(true);
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ watchlistSync: selectedConfig() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (body.details || []).join("; ") || `Watchlist settings save failed with ${response.status}`);
    if (body.config) {
      state.savedConfig = body.config;
      callbacks.onConfig?.(body.config);
      applyControls(body.config.watchlistSync || currentConfig());
    }
    callbacks.setMessage?.("Personal watchlist sync settings saved.", "success");
    await refreshWatchlistSyncStatus().catch(() => null);
    if (selectedConfig().enabled) await runSync();
  } finally {
    setBusy(false);
  }
}

async function runSync(action = "run", { silent = false } = {}) {
  setBusy(true);
  try {
    const response = await fetch("/api/watchlist-sync/run", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, providers: [] }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Personal watchlist sync failed with ${response.status}`);
    if (!silent) callbacks.setMessage?.(action === "retry" ? "Queued watchlist changes were retried." : "Personal watchlist sync completed.", body.ok === false ? "muted" : "success");
    await refreshWatchlistSyncStatus().catch(() => null);
  } catch (error) {
    callbacks.setMessage?.(error.message || "Personal watchlist sync failed.", "error");
  } finally {
    setBusy(false);
    renderStatus(status);
  }
}

export function runWatchlistSyncNow() {
  return runSync("run");
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.token) refreshWatchlistSyncStatus().catch(() => null);
  }, 30_000);
}

export function resumeWatchlistSyncSettings() {
  startRefreshTimer();
  return refreshWatchlistSyncStatus({ maxAgeMs: 2000 });
}

export function initWatchlistSyncSettings(nextCallbacks = {}) {
  callbacks = nextCallbacks;
  const ui = elements();
  if (!ui.panel || ui.panel.dataset.bound === "1") return;
  ui.panel.dataset.bound = "1";
  applyControls(currentConfig());
  // Sync now is only meaningful while sync is on; a run with it off would
  // reconcile nothing and read as a no-op failure.
  ui.syncNow?.addEventListener("click", () => { runSync("run"); });
  ui.enabled?.addEventListener("change", () => {
    if (ui.status) ui.status.textContent = "Saving…";
    saveSettings().catch((error) => {
      applyControls(currentConfig());
      callbacks.setMessage?.(error.message, "error");
    });
  });
  document.addEventListener("plembfin:config-changed", () => {
    applyControls(currentConfig());
    refreshWatchlistSyncStatus({ maxAgeMs: 2000 }).catch(() => null);
  });
  startRefreshTimer();
}

export function stopWatchlistSyncSettings() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
