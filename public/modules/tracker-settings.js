import { state } from "./state.js?v=2.1.1.0.9";
import { plexHistoricalSyncEnabled } from "./plex-history-policy.js?v=2.1.1.0.9";
import { initTrackerFullSync, renderTrackerFullSync } from "./tracker-full-sync.js?v=2.1.1.0.9";

let getHeaders = () => ({ "Content-Type": "application/json" });
let bound = false;
let simklFlow = 0;
let simklBusy = false;
let simklViewRevision = 0;
// Last known connection state, so the Plex notes can be repainted when the
// saved config arrives without re-querying the tracker API.
let lastConnected = false;
let traktProvider = { appConfigured: false, configurationIncomplete: false, personalAppSupported: true };
const connectionViews = new Map([["trakt", (provider, connection) => {
  traktProvider = provider;
  renderProvider();
  renderConnection(connection);
}]]);

const el = (id) => document.getElementById(id);
const setStatus = (text, tone = "muted") => {
  const status = el("traktConnectionStatus");
  if (status) { status.textContent = text; status.className = `status-pill status-${tone}`; }
};
const setMessage = (text, tone = "muted") => {
  const message = el("traktConnectMessage");
  if (!message) return;
  message.textContent = text || "";
  message.style.display = text ? "block" : "none";
  message.className = `message ${tone}`;
  message.dataset.tone = tone;
};
const setSyncProgress = (active, label = "Reading the complete Trakt watched snapshot…") => {
  const progress = el("traktSyncProgress");
  const progressLabel = el("traktSyncProgressLabel");
  progress?.classList.toggle("hidden", !active);
  if (progressLabel) progressLabel.textContent = label;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function traktSyncCompletionMessage(result = {}) {
  const watched = Number(result.watched || 0);
  const unwatched = Number(result.unwatched || 0);
  const deferred = Number(result.deferredWatched || 0) + Number(result.deferredUnwatched || 0);
  const remoteItems = Number(result.remoteItems || 0);
  const changes = watched + unwatched;
  const deferredCopy = deferred
    ? ` ${deferred} change${deferred === 1 ? "" : "s"} held for re-check.`
    : "";
  if (result.reconcile) {
    return `Trakt reconciliation complete: ${remoteItems.toLocaleString()} watched item${remoteItems === 1 ? "" : "s"} checked; ${watched} missing watched state restored and ${unwatched} unwatched change${unwatched === 1 ? "" : "s"} applied.${deferredCopy}`;
  }
  return `Trakt sync complete: ${remoteItems.toLocaleString()} item${remoteItems === 1 ? "" : "s"} checked; ${watched} watched and ${unwatched} unwatched change${changes === 1 ? "" : "s"} applied.${deferredCopy}`;
}

function renderConnection(connection) {
  const connected = connection?.status === "connected" || connection?.status === "reauth_required";
  lastConnected = connected;
  renderTrackerFullSync("trakt", connection);
  const summary = el("traktConnectedSummary");
  const fields = el("traktConnectForm")?.querySelector(".sync-tuning-fields");
  el("traktConnectButton")?.classList.toggle("hidden", connected);
  el("traktSyncNowButton")?.classList.toggle("hidden", !connected);
  // Sync Now is an explicit historical import. Say something only when there is
  // something to act on: with historical Plex sync off, these watches will not
  // reach Plex at all. With it on there is no decision to make, so stay quiet
  // rather than repeating provider trivia above every button.
  refreshTrackerPolicyNotes();
  el("traktDisconnectButton")?.classList.toggle("hidden", !connected);
  fields?.classList.toggle("hidden", connected);
  el("traktPersonalAppFields")?.classList.toggle("hidden", connected);
  summary?.classList.toggle("hidden", !connected);
  if (!connected) {
    setStatus("Not connected", "warning");
    if (summary) summary.innerHTML = "";
    return;
  }
  setStatus(connection.status === "connected" ? "Live - Connected" : "Reconnect required", connection.status === "connected" ? "ready" : "warning");
  if (summary) summary.innerHTML = `<b>${escapeText(connection.remoteUsername || "Trakt account")}</b><span>${connection.baselineComplete ? "Live bidirectional sync is active." : "The first complete Trakt snapshot is waiting to run."}</span>${connection.lastError ? `<small>${escapeText(connection.lastError)}</small>` : ""}`;
}

/**
 * Repaints the two Plex notes: the one under the First connection picker, which
 * says what choosing "Import all existing Trakt watched state" will actually do
 * about Plex, and the warning beside Sync Now. Both depend on the standing
 * setting, so neither can be static copy, and with no Plex connected there is
 * nothing to say at all.
 *
 * Exported and free of network calls because the saved config loads
 * asynchronously and often lands after the first render - the settings route
 * calls this once the config is available, and a Sync Tuning save re-fires it
 * so the notes track the setting without a reload.
 */
export function refreshTrackerPolicyNotes() {
  const plexConnected = Boolean(state.savedConfig?.plex?.configured) && !state.savedConfig?.plex?.disabled;
  const plexHistoricalOff = !plexHistoricalSyncEnabled(state.savedConfig || {});
  el("traktSyncPolicyNote")?.classList.toggle("hidden", !(lastConnected && plexConnected && plexHistoricalOff));

  const node = el("traktFirstConnectionPlexNote");
  if (!node) return;
  if (!plexConnected) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  node.hidden = false;
  node.classList.toggle("is-warning", plexHistoricalOff);
  node.innerHTML = plexHistoricalOff
    ? `<b>Plex will not receive an import.</b> <b>Sync historical watched items to Plex</b> is off in Sync Tuning, so choosing <b>Import all existing Trakt watched state</b> will not mark those items watched in Plex.`
    : `Plex receives the watched state only; its activity date may read as today, because the Plex server sets it. Turn off <b>Sync historical watched items to Plex</b> in Sync Tuning if you would rather Plex was left alone.`;
}

function renderProvider() {
  const status = el("traktAppStatus");
  const personal = el("traktPersonalAppFields");
  if (traktProvider.appConfigured) {
    if (status) status.textContent = "";
    personal?.removeAttribute("open");
    return;
  }
  if (status) status.textContent = traktProvider.configurationIncomplete
    ? "The server has an incomplete Trakt configuration. Set both TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET, then restart Plekt."
    : "The Plekt Trakt app is unavailable. A Trakt VIP developer may use a personal app below.";
  if (!traktProvider.configurationIncomplete) personal?.setAttribute("open", "");
}

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = String(value || "");
  return span.innerHTML;
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...getHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}`);
  return body;
}

export async function refreshTrackerSettings() {
  await Promise.all([refreshTraktSettings(), refreshSimklSettings()]);
}

async function refreshTraktSettings() {
  try {
    const body = await api("/api/tracker-connections");
    const connections = new Map((body.connections || []).map((item) => [item.provider, item]));
    for (const [provider, configuration] of Object.entries(body.providers || {})) {
      connectionViews.get(provider)?.(configuration, connections.get(provider));
    }
  } catch (error) {
    if (!/401|403|administrator|same-origin/i.test(error.message)) setMessage(error.message, "error");
  }
}

function simklMessage(text, tone = "muted") {
  const node = el("simklConnectMessage");
  if (!node) return;
  node.textContent = text;
  node.className = `message ${tone}`;
  node.classList.toggle("hidden", !text);
}

function renderSimkl(connection) {
  const connected = Boolean(connection);
  const reauth = connection?.status === "reauth_required";
  renderTrackerFullSync("simkl", connection);
  const status = el("simklConnectionStatus");
  if (status) {
    status.textContent = reauth ? "Reconnect required" : connected ? "Connected" : "Not connected";
    status.className = `status-pill status-${connected && !reauth ? "ready" : "warning"}`;
  }
  const summary = el("simklConnectedSummary");
  if (summary) {
    summary.textContent = connected ? `${connection.remoteUsername || "Simkl account"}. ${reauth ? "Sign in again to renew this connection." : "Checks run on demand and after media-server events. Missing items never clear local watches."}` : "";
    summary.classList.toggle("hidden", !connected);
  }
  el("simklDisconnectButton")?.classList.toggle("hidden", !connected);
  el("simklCheckNowButton")?.classList.toggle("hidden", !connected || reauth);
  const button = el("simklConnectButton");
  if (button) button.textContent = connected ? "Reconnect Simkl" : "Connect Simkl";
}

async function refreshSimklSettings() {
  if (simklBusy) return;
  const revision = ++simklViewRevision;
  try {
    const body = await api("/api/tracker-connections/simkl");
    if (revision !== simklViewRevision) return;
    renderSimkl(body.connection);
  } catch (error) {
    if (revision !== simklViewRevision) return;
    const status = el("simklConnectionStatus");
    if (status) status.textContent = "Unavailable";
    simklMessage(error.message, "error");
  }
}

async function connectSimkl(event) {
  event.preventDefault();
  if (simklBusy) return;
  simklBusy = true;
  ++simklViewRevision;
  const flow = ++simklFlow;
  const button = el("simklConnectButton");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  el("simklDeviceCode")?.classList.add("hidden");
  simklMessage("Starting Simkl sign-in…");
  try {
    const start = await api("/api/tracker-auth/simkl/start", {
      method: "POST", body: JSON.stringify({ initialSyncMode: el("simklInitialSyncMode")?.value || "baseline" }),
    });
    if (flow !== simklFlow) return;
    const url = new URL(start.verificationUrl);
    if (url.protocol !== "https:" || url.hostname !== "simkl.com" || url.username || url.password || url.port) throw new Error("Simkl returned an unsafe sign-in link.");
    const expiresAt = Number(start.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Simkl sign-in expired. Start again.");
    const code = el("simklDeviceCode");
    code.innerHTML = `<span>Enter this code in Simkl</span><b>${escapeText(start.userCode)}</b><small>Keep this page open. The code expires automatically.</small><div class="settings-actions"><button id="simklCopyDeviceCode" class="button-ghost sync-action-btn sync-tool-button" type="button">Copy code</button><a id="simklOpenActivation" class="button-primary sync-action-btn sync-tool-button" target="_blank" rel="noopener noreferrer">Open Simkl</a></div>`;
    el("simklOpenActivation").href = url.href;
    el("simklCopyDeviceCode").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(start.userCode); }
      catch { if (flow === simklFlow) simklMessage(`Copy this Simkl code: ${start.userCode}`, "warning"); return; }
      if (flow === simklFlow) el("simklCopyDeviceCode").textContent = "Copied";
    });
    code.classList.remove("hidden");
    simklMessage("Copy the code, open Simkl and approve access. After the baseline check, review a full-sync preview before importing history.");
    let interval = Math.max(2, Number(start.intervalSeconds) || 5);
    while (Date.now() < expiresAt && flow === simklFlow) {
      await sleep(Math.min(interval * 1000, expiresAt - Date.now(), 2147483647));
      if (flow !== simklFlow) return;
      if (Date.now() >= expiresAt) break;
      const response = await fetch(`/api/tracker-auth/simkl/${encodeURIComponent(start.flowId)}/status`, { credentials: "same-origin", headers: getHeaders() });
      const body = await response.json().catch(() => ({}));
      if (flow !== simklFlow) return;
      if (response.status === 202 && body.status === "pending") {
        const retryAfter = Number(body.retryAfter);
        if (Number.isFinite(retryAfter) && retryAfter > 0) interval = Math.max(interval, retryAfter);
        continue;
      }
      if (!response.ok) throw new Error(body.error || (body.status === "expired" ? "Simkl sign-in expired. Start again." : "Simkl sign-in failed. Start again."));
      if (body.status !== "completed") throw new Error("Simkl returned an unexpected sign-in response. Start again.");
      renderSimkl(body.connection);
      simklMessage("Simkl connected. Use Check now to run the first library check.", "success");
      return;
    }
    if (flow === simklFlow) throw new Error("Simkl sign-in expired. Start again.");
  } catch (error) {
    if (flow === simklFlow) simklMessage(error.message || "Simkl sign-in failed. Start again.", "error");
  } finally {
    if (flow === simklFlow) {
      simklBusy = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      el("simklDeviceCode")?.classList.add("hidden");
    }
  }
}

async function disconnectSimkl() {
  const disconnectButton = el("simklDisconnectButton");
  if (disconnectButton?.disabled) return;
  if (!window.confirm("Disconnect Simkl and delete its encrypted credentials from Plekt? Existing local history will be kept.")) return;
  if (disconnectButton) disconnectButton.disabled = true;
  ++simklFlow;
  ++simklViewRevision;
  simklBusy = true;
  const button = el("simklConnectButton");
  button.disabled = true;
  el("simklDeviceCode")?.classList.add("hidden");
  try {
    await api("/api/tracker-connections/simkl", { method: "DELETE" });
    renderSimkl(null);
    simklMessage("Simkl disconnected. Local history was kept. You can also revoke access in Simkl’s connected-app settings.", "success");
  } catch (error) { simklMessage(error.message, "error"); }
  finally {
    simklBusy = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (disconnectButton) disconnectButton.disabled = false;
  }
}

async function startTraktFlow({ clientId = "", clientSecret = "" } = {}) {
  const isManual = Boolean(clientId || clientSecret);
  const connectBtn = el("traktConnectButton");
  const saveBtn = el("traktSaveManualButton");
  if (connectBtn) connectBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  setMessage(isManual ? "Starting Trakt device sign-in with manual credentials…" : "Starting Trakt device sign-in…");
  try {
    const start = await api("/api/tracker-auth/trakt/start", {
      method: "POST",
      body: JSON.stringify({
        clientId: isManual ? clientId : (traktProvider.appConfigured ? "" : el("traktClientId")?.value.trim() || ""),
        clientSecret: isManual ? clientSecret : (traktProvider.appConfigured ? "" : el("traktClientSecret")?.value.trim() || ""),
        initialSyncMode: el("traktInitialSyncMode")?.value || "baseline",
      }),
    });
    const code = el("traktDeviceCode");
    code.classList.remove("hidden");
    code.innerHTML = `<span>Enter this code in Trakt</span><b>${escapeText(start.userCode)}</b><small>The code expires automatically. Keep this page open while authorizing Plekt.</small><div class="settings-actions"><button id="traktCopyDeviceCode" class="button-ghost sync-action-btn sync-tool-button" type="button">Copy code</button><a id="traktOpenActivation" class="button-primary sync-action-btn sync-tool-button" target="_blank" rel="noopener noreferrer">Open Trakt</a></div>`;
    el("traktOpenActivation").href = start.verificationUrl;
    el("traktCopyDeviceCode").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(start.userCode);
        el("traktCopyDeviceCode").textContent = "Copied";
      } catch {
        setMessage(`Copy this Trakt code: ${start.userCode}`, "warning");
      }
    });
    code.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setMessage("Copy the code, then open Trakt and approve Plekt. This page will finish automatically.");
    let interval = Math.max(2, Number(start.intervalSeconds || 5));
    while (Date.now() < Number(start.expiresAt)) {
      await sleep(interval * 1000);
      const response = await fetch(`/api/tracker-auth/trakt/${encodeURIComponent(start.flowId)}/status`, { credentials: "same-origin", headers: getHeaders() });
      const body = await response.json().catch(() => ({}));
      if (response.status === 202 || body.status === "pending") { interval = Math.max(interval, Number(body.retryAfter || 0)); continue; }
      if (!response.ok) throw new Error(body.error || (body.status === "denied" ? "Trakt authorization was denied." : "Trakt sign-in expired."));
      if (body.status === "completed") {
        code.classList.add("hidden");
        if (el("traktClientSecret")) el("traktClientSecret").value = "";
        renderConnection(body.connection);
        setMessage("Trakt connected. Run Sync Now, or wait for the next one-minute poll.", "success");
        return;
      }
    }
    throw new Error("Trakt sign-in expired. Start again.");
  } catch (error) {
    setMessage(error.message || "Trakt connection failed.", "error");
  } finally {
    if (connectBtn) connectBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function connect(event) {
  event.preventDefault();
  await startTraktFlow();
}

async function saveManual(event) {
  event.preventDefault();
  const clientId = el("traktClientId")?.value.trim();
  const clientSecret = el("traktClientSecret")?.value.trim();
  if (!clientId || !clientSecret) {
    setMessage("Please enter both Trakt Client ID and Client Secret.", "warning");
    return;
  }
  await startTraktFlow({ clientId, clientSecret });
}

async function syncNow() {
  const button = el("traktSyncNowButton");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "Syncing…";
  button.setAttribute("aria-busy", "true");
  setMessage("");
  setSyncProgress(true);
  try {
    const body = await api("/api/tracker-connections/trakt", { method: "POST", body: "{}" });
    renderConnection(body.connection);
    setMessage(traktSyncCompletionMessage(body.result), "success");
  } catch (error) { setMessage(error.message, "error"); }
  finally {
    setSyncProgress(false);
    button.disabled = false;
    button.textContent = "Sync Now";
    button.removeAttribute("aria-busy");
  }
}

async function disconnect() {
  if (!window.confirm("Disconnect Trakt and delete its encrypted OAuth credentials from Plekt?")) return;
  try {
    await api("/api/tracker-connections/trakt", { method: "DELETE" });
    renderConnection(null);
    setMessage("Trakt disconnected. Existing Plekt history was kept.", "success");
  } catch (error) { setMessage(error.message, "error"); }
}

export function initTrackerSettings({ authHeaders } = {}) {
  if (authHeaders) getHeaders = authHeaders;
  initTrackerFullSync({ api });
  if (bound) return;
  bound = true;
  el("simklConnectForm")?.addEventListener("submit", connectSimkl);
  el("simklDisconnectButton")?.addEventListener("click", disconnectSimkl);
  el("simklCheckNowButton")?.addEventListener("click", async () => {
    const button = el("simklCheckNowButton");
    button.disabled = true;
    try {
      await api("/api/tracker-connections/simkl", { method: "POST", body: "{}" });
      simklMessage("Simkl check complete. Review Sync Attention for held observations.", "success");
      await refreshSimklSettings();
    } catch (error) { simklMessage(error.message, "error"); }
    finally { button.disabled = false; }
  });
  el("traktConnectForm")?.addEventListener("submit", connect);
  el("traktManualForm")?.addEventListener("submit", saveManual);
  el("traktSyncNowButton")?.addEventListener("click", syncNow);
  el("traktDisconnectButton")?.addEventListener("click", disconnect);
  // The Plex notes below the picker and beside Sync Now are derived from the
  // saved config, which loads asynchronously and can land after the first
  // render. Without this they would keep whatever they were built with on the
  // very first paint - in practice, nothing, because savedConfig was still
  // empty. Re-render when the config arrives or changes.
  document.addEventListener("plembfin:config-changed", refreshTrackerPolicyNotes);
}
