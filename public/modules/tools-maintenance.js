import { buildAuthHeaders } from "./auth.js?v=2.1.1.1.0";
import { state, elements } from "./state.js?v=2.1.1.1.0";
import { escapeHtml, escapeAttribute, platformName, formatDate, formatNumber } from "./utils.js?v=2.1.1.1.0";
import { categorizeIssues } from "./sync.js?v=2.1.1.1.0";
import { openFixMatchDialog } from "./edit-dialogs.js?v=2.1.1.1.0";

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _loadSyncJobs = async () => {};
let _loadSyncHistory = async () => {};
let _loadHistory = async () => {};
let _clearDerivedUiCaches = () => {};
let _loadSavedConfig = async () => {};
let _queueLiveHistoryRefresh = () => {};
let fullSyncAbortController = null;
let fullSyncRunId = "";
let fullSyncCancelRequested = false;
let fullSyncProgressTimer = null;
let fullSyncProgressState = null;

export function initMaintenanceTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSyncJobs) _loadSyncJobs = callbacks.loadSyncJobs;
  if (callbacks.loadSyncHistory) _loadSyncHistory = callbacks.loadSyncHistory;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  if (callbacks.queueLiveHistoryRefresh) _queueLiveHistoryRefresh = callbacks.queueLiveHistoryRefresh;
  initSyncMatchReport();
}

function authHeaders() { return buildAuthHeaders(state.token); }
function setMessage(...args) { return _setMessage(...args); }
function showConfirmModal(...args) { return _showConfirmModal(...args); }
function loadSyncJobs(...args) { return _loadSyncJobs(...args); }
function loadSyncHistory(...args) { return _loadSyncHistory(...args); }
function loadHistory(...args) { return _loadHistory(...args); }
function clearDerivedUiCaches(...args) { return _clearDerivedUiCaches(...args); }
function setStatusPill(element, text, tone = "muted") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-pill status-${tone}`;
}

function formatFullSyncDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function fullSyncRowsProcessed() {
  if (!fullSyncProgressState) return 0;
  return Object.values(fullSyncProgressState.phases).reduce((sum, phase) => sum + Number(phase.processed || 0), 0);
}

function fullSyncKnownTotal() {
  if (!fullSyncProgressState) return null;
  const totals = Object.values(fullSyncProgressState.phases).map((phase) => phase.total);
  return totals.every((total) => Number.isFinite(total)) ? totals.reduce((sum, total) => sum + total, 0) : null;
}

function fullSyncProgressValue() {
  if (!fullSyncProgressState) return 0;
  if (fullSyncProgressState.status === "complete") return 100;
  const watched = fullSyncProgressState.phases.watched;
  const progress = fullSyncProgressState.phases.progress;
  const watchedValue = watched.total == null ? 0 : watched.total > 0 ? watched.processed / watched.total : 1;
  const progressValue = progress.total > 0 ? progress.processed / progress.total : 0;
  return fullSyncProgressState.phase === "progress"
    ? 50 + Math.max(0, Math.min(1, progressValue)) * 50
    : Math.max(0, Math.min(1, watchedValue)) * 50;
}

function renderFullSyncProgress() {
  if (!fullSyncProgressState || !elements.fullSyncProgress) return;

  const processed = fullSyncRowsProcessed();
  const total = fullSyncKnownTotal();
  const elapsedMs = Math.max(0, Date.now() - fullSyncProgressState.startedAt);
  const rowsPerMinute = elapsedMs > 0 ? processed / (elapsedMs / 60_000) : 0;
  const currentPhase = fullSyncProgressState.phases[fullSyncProgressState.phase];
  const phaseProcessed = Number(currentPhase?.processed || 0);
  const phaseTotal = Number.isFinite(currentPhase?.total) ? currentPhase.total : null;
  const remainingMs = rowsPerMinute > 0 && phaseTotal != null && phaseTotal > phaseProcessed
    ? ((phaseTotal - phaseProcessed) / rowsPerMinute) * 60_000
    : null;
  const value = Math.max(0, Math.min(100, Math.round(fullSyncProgressValue())));
  const phaseLabel = fullSyncProgressState.phase === "progress" ? "Resume positions" : "Watched states";

  let meta = `${value}% · ${formatFullSyncDuration(elapsedMs)} elapsed`;
  if (total == null) meta += " · Calculating remaining phase";
  else if (fullSyncProgressState.status === "complete") meta = `100% · ${formatFullSyncDuration(elapsedMs)} total`;

  if (elements.fullSyncProgressLabel) {
    elements.fullSyncProgressLabel.textContent = fullSyncProgressState.status === "complete"
      ? "Restore complete"
      : fullSyncProgressState.status === "stopped"
        ? "Restore stopped"
        : `${phaseLabel}: ${formatNumber(phaseProcessed)}${phaseTotal == null ? "" : ` / ${formatNumber(phaseTotal)}`}`;
  }
  if (elements.fullSyncProgressMeta) elements.fullSyncProgressMeta.textContent = meta;
  if (elements.fullSyncProgressCount) {
    elements.fullSyncProgressCount.textContent = total == null
      ? `${formatNumber(processed)} rows processed`
      : `${formatNumber(processed)} of ${formatNumber(total)} rows processed`;
  }
  if (elements.fullSyncProgressRate) {
    elements.fullSyncProgressRate.textContent = rowsPerMinute > 0 ? `${rowsPerMinute.toFixed(1)} rows/min` : "Rate —";
  }
  if (elements.fullSyncProgressEta) {
    elements.fullSyncProgressEta.textContent = fullSyncProgressState.status === "complete"
      ? "ETA complete"
      : remainingMs != null
        ? `${total == null ? `${phaseLabel} ` : ""}ETA ${formatFullSyncDuration(remainingMs)}`
        : "ETA calculating";
  }
  elements.fullSyncProgress.classList.remove("hidden");
  elements.fullSyncProgress.dataset.status = fullSyncProgressState.status;
  if (elements.fullSyncProgressTrack) elements.fullSyncProgressTrack.setAttribute("aria-valuenow", String(value));
  if (elements.fullSyncProgressFill) elements.fullSyncProgressFill.style.transform = `scaleX(${value / 100})`;
}

function beginFullSyncProgress() {
  if (fullSyncProgressTimer) clearInterval(fullSyncProgressTimer);
  fullSyncProgressState = {
    phase: "watched",
    status: "running",
    startedAt: Date.now(),
    phases: {
      watched: { processed: 0, total: null },
      progress: { processed: 0, total: null },
    },
  };
  renderFullSyncProgress();
  fullSyncProgressTimer = setInterval(renderFullSyncProgress, 1000);
}

function updateFullSyncProgress(phase, body = {}) {
  if (!fullSyncProgressState) return;
  fullSyncProgressState.phase = phase;
  const phaseState = fullSyncProgressState.phases[phase];
  const total = Number(body.total);
  if (Number.isFinite(total) && total >= 0) phaseState.total = total;
  phaseState.processed += Math.max(0, Number(body.processed || 0));
  renderFullSyncProgress();
}

function finishFullSyncProgress(status, label = "") {
  if (!fullSyncProgressState) return;
  if (fullSyncProgressTimer) clearInterval(fullSyncProgressTimer);
  fullSyncProgressTimer = null;
  fullSyncProgressState.status = status;
  if (label) fullSyncProgressState.label = label;
  renderFullSyncProgress();
}

export async function runSystemIntegrityCheck() {
  const button = elements.runCompleteCheckButton;
  const container = elements.completeCheckResults;
  if (!button || !container) return;

  button.disabled = true;
  button.textContent = "Running diagnostics...";
  container.classList.remove("hidden");
  container.innerHTML = `<div class="idle-state"><b>Running integrity checks...</b></div>`;

  const results = [];

  try {
    const startTime = Date.now();
    const response = await fetch("/api/history?limit=1", { headers: authHeaders() });
    const elapsed = Date.now() - startTime;
    if (response.ok) {
      results.push({ name: "Watch History API", status: "success", detail: `Connected successfully. Response time: ${elapsed}ms.` });
    } else {
      results.push({ name: "Watch History API", status: "error", detail: `Server responded with HTTP ${response.status}.` });
    }
  } catch (error) {
    results.push({ name: "Watch History API", status: "error", detail: `Connection failed: ${error.message}` });
  }

  try {
    await _loadSavedConfig();
    results.push({ name: "Server Configuration", status: "success", detail: "Read server-side media configuration successfully." });
  } catch (error) {
    results.push({ name: "Server Configuration", status: "error", detail: `Failed to read config: ${error.message}` });
  }

  let webhookEndpointStatus = "error";
  let webhookEndpointDetail = "Unavailable";
  try {
    const startTime = Date.now();
    const response = await fetch("/api/webhook", { method: "OPTIONS" });
    if (response.ok) {
      webhookEndpointStatus = "success";
      const elapsed = Date.now() - startTime;
      if (state.lastWebhook && state.lastWebhook.timestamp) {
        webhookEndpointDetail = `Active. Last event: ${platformName(state.lastWebhook.source)} watched "${state.lastWebhook.title}" at ${formatDate(state.lastWebhook.timestamp)}.`;
      } else {
        webhookEndpointDetail = `Active & online. No events received yet (${elapsed}ms).`;
      }
    } else {
      webhookEndpointDetail = `Responded with HTTP ${response.status}`;
    }
  } catch (error) {
    webhookEndpointDetail = `Ping failed: ${error.message}`;
  }
  results.push({ name: "Webhook Listener Endpoint", status: webhookEndpointStatus, detail: webhookEndpointDetail });

  if (state.lastCron) {
    const diff = Date.now() - Number(state.lastCron);
    const fiveMinutesMs = 5 * 60 * 1000;
    if (diff <= fiveMinutesMs) {
      results.push({ name: "Scheduled Cron Job", status: "success", detail: `Active. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 1000)}s ago).` });
    } else {
      results.push({ name: "Scheduled Cron Job", status: "warning", detail: `Warnings - Delayed execution. Last run: ${formatDate(state.lastCron)} (${Math.round(diff / 60000)}m ago).` });
    }
  } else {
    results.push({ name: "Scheduled Cron Job", status: "skipped", detail: "Not Configured - No execution logged." });
  }

  // The dashboard preview in state.history carries no sync record, so the
  // latest five full rows are always fetched for this check.
  let historyToCheck = [];
  try {
    const response = await fetch("/api/history?limit=5&stats=0", { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(body.history)) historyToCheck = body.history;
  } catch (e) { /* ignore */ }

  if (!historyToCheck.length) {
    results.push({ name: "Outbound Playstate Sync", status: "skipped", detail: "Not Configured - No watch history logged to scan." });
  } else {
    const recentRows = historyToCheck.slice(0, 5);
    let errorCount = 0;
    let totalChecked = 0;
    for (const row of recentRows) {
      if (row.sync_dispatch_telemetry) {
        totalChecked++;
        const tel = String(row.sync_dispatch_telemetry).toLowerCase();
        if (tel.includes("status: error") || tel.includes("failed") || tel.includes("propagation failed")) errorCount++;
      }
    }
    if (totalChecked === 0) {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: "Active. No recent outbound dispatches to check." });
    } else if (errorCount > 0) {
      results.push({ name: "Outbound Playstate Sync", status: "warning", detail: `Warnings - ${errorCount} of ${totalChecked} recent syncs failed. Check logs.` });
    } else {
      results.push({ name: "Outbound Playstate Sync", status: "success", detail: `All ${totalChecked} recent outbound syncs completed successfully.` });
    }
  }

  // Connection settings live in edit modals and media_connections (app sign-ins).
  // Diagnostics check both saved config and active connection state. A blank secret
  // deliberately asks the backend to fall back to the stored/connected credential.
  const getProviderInfo = (type) => {
    const section = state.savedConfig?.[type] || {};
    const conn = section.connection || {};
    const url = String(section.baseUrl || section.url || conn.baseUrl || "").trim();
    const isConfigured = Boolean(
      section.configured ||
      (conn.status && conn.status !== "disabled" && conn.baseUrl) ||
      (section.authMode === "account" && conn.status === "connected")
    );
    return { url, isConfigured };
  };

  const testConnection = async (type, name) => {
    const { url, isConfigured } = getProviderInfo(type);
    if (!isConfigured && !url) {
      results.push({ name, status: "skipped", detail: "Skipped - Server is not connected or configured." });
      return;
    }
    try {
      const startTime = Date.now();
      const response = await fetch("/api/test-connection", { method: "POST", headers: authHeaders(), body: JSON.stringify({ type, url, token: "" }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name, status: "success", detail: `${body.detail || "Server identity verified"} in ${body.elapsedMs || elapsed}ms.` });
      } else {
        results.push({ name, status: "error", detail: body.error || `Connection failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      results.push({ name, status: "error", detail: `Check failed: ${error.message}` });
    }
  };

  await testConnection("plex", "Plex Media Server");

  const plexInfo = getProviderInfo("plex");
  if (plexInfo.isConfigured || plexInfo.url) {
    try {
      const startTime = Date.now();
      // A blank token is fine - the backend falls back to the saved/connected Plex config.
      const response = await fetch("/api/test-plex-notifications", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url: plexInfo.url, token: "" }) });
      const body = await response.json().catch(() => ({}));
      const elapsed = Date.now() - startTime;
      if (response.ok && body.ok) {
        results.push({ name: "Plex Realtime Notifications", status: "success", detail: `Notification WebSocket connected in ${body.elapsedMs || elapsed}ms. Event-driven unwatch detection is active.` });
      } else {
        results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `${body.error || `Unavailable (HTTP ${response.status})`}. Adaptive polling and unwatch sync will continue working.` });
      }
    } catch (error) {
      results.push({ name: "Plex Realtime Notifications", status: "warning", detail: `Check failed: ${error.message}. Adaptive polling and unwatch sync will continue working.` });
    }
  } else {
    results.push({ name: "Plex Realtime Notifications", status: "skipped", detail: "Skipped - Plex is not connected or configured." });
  }

  await testConnection("emby", "Emby Media Server");
  await testConnection("jellyfin", "Jellyfin Media Server");

  try {
    const report = await fetchSyncMatchReport();
    const lines = ["plex", "emby", "jellyfin"]
      .map((platform) => ({ platform, stats: report.platforms?.[platform] }))
      .filter((entry) => entry.stats && entry.stats.uniqueMediaCount > 0)
      .map((entry) => `${platformName(entry.platform)}: ${entry.stats.uniqueMediaCount} item${entry.stats.uniqueMediaCount !== 1 ? "s" : ""} unmatched (${entry.stats.movies} movies, ${entry.stats.episodes} episodes)`);
    if (!lines.length) {
      results.push({ name: "Cross-Platform Library Matching", status: "success", detail: `No "no matching item" sync failures across ${report.scannedRows} records with telemetry.` });
    } else {
      results.push({ name: "Cross-Platform Library Matching", status: "warning", detail: `Warnings - ${lines.join("; ")}.` });
    }
  } catch (error) {
    results.push({ name: "Cross-Platform Library Matching", status: "error", detail: `Match report failed: ${error.message}` });
  }

  container.innerHTML = results.map((res) => {
    let statusLabel = "Skipped";
    let pillStyle = "border-color: var(--line); background: var(--panel-3); color: var(--muted);";
    let fixInstruction = "";
    let settingsPath = "";

    if (res.status === "success") { statusLabel = "Online"; pillStyle = "border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.12); color: var(--green);"; }
    else if (res.status === "error") { statusLabel = "Failed"; pillStyle = "border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); color: var(--red);"; }
    else if (res.status === "skipped") { statusLabel = "Not Configured"; pillStyle = "border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.12); color: var(--yellow);"; }
    else if (res.status === "warning") { statusLabel = "Warnings Detected"; pillStyle = "border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); color: var(--yellow);"; }

    if (res.status !== "success") {
      if (res.name === "Scheduled Cron Job") { fixInstruction = "Fix: The background sync worker runs in-process every minute. If it hasn't fired, confirm the server is running and check the server logs for errors. You can also trigger it manually via /api/cron-sync."; settingsPath = "/settings/sync"; }
      else if (res.name === "Watch History API") { fixInstruction = "Fix: The SQLite database may be locked or the data directory may not be writable. Check the server logs and confirm DATA_DIR is set correctly."; }
      else if (res.name === "Server Configuration") { fixInstruction = "Fix: Try saving your configuration again in Settings → Media Servers. If the error persists, check that data/config.json is writable."; }
      else if (res.name === "Webhook Listener Endpoint") { fixInstruction = "Fix: Confirm the server is running and accessible at the expected host and port. Check for firewall or reverse-proxy rules blocking /api/webhook."; }
      else if (res.name === "Outbound Playstate Sync") { fixInstruction = "Fix: Open the latest history row debug details, review sync_dispatch_telemetry, then correct the failed platform credentials or provider-ID match."; }
      else if (res.name === "Cross-Platform Library Matching") { fixInstruction = "Fix: Open Sync Activity and use Issues only to see which media each platform could not find, then correct its metadata or external IDs."; settingsPath = "/sync-activity"; }
      else if (res.name === "Plex Media Server") { fixInstruction = "Fix: Sign in with Plex or enter the Plex Server URL and Plex Token in Settings → Media Servers, then confirm the server is reachable from the machine running Plekt."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Plex Realtime Notifications") { fixInstruction = "Fix: Ensure any reverse proxy / Cloudflare in front of Plex forwards WebSocket upgrades on /:/websockets/notifications, or set the Plex Server URL to the direct LAN address (e.g. http://192.168.x.x:32400). Adaptive polling and unwatch sync will continue working."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Emby Media Server") { fixInstruction = "Fix: Sign in to Emby or enter the Emby Server URL, API Key, and User ID in Settings → Media Servers, then confirm the server is reachable from the machine running Plekt."; settingsPath = "/settings/media-servers"; }
      else if (res.name === "Jellyfin Media Server") { fixInstruction = "Fix: Sign in / Quick Connect to Jellyfin or enter the Jellyfin Server URL, API Key, and User ID in Settings → Media Servers, then confirm the server is reachable from the machine running Plekt."; settingsPath = "/settings/media-servers"; }
    }

    return `
      <div class="diagnostic-result-card">
        <div style="display: grid; gap: 4px;">
          <b style="color: var(--text); font-weight: 700; font-size: 0.88rem;">${escapeHtml(res.name)}</b>
          <span style="font-size: 0.8rem; color: var(--muted); line-height: 1.4;">${escapeHtml(res.detail)}</span>
          ${fixInstruction ? `<span style="font-size: 0.8rem; color: var(--text); margin-top: 2px;">${escapeHtml(fixInstruction)}</span>` : ""}
          ${settingsPath ? `<button type="button" data-settings-path="${escapeAttribute(settingsPath)}" class="button-ghost sync-action-btn sync-tool-button" style="width: fit-content; margin-top: 4px;">Open settings</button>` : ""}
        </div>
        <span class="target-pill" style="padding: 0.25rem 0.6rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; border: 1px solid; border-radius: 999px; white-space: nowrap; ${pillStyle}">${statusLabel}</span>
      </div>
    `;
  }).join("");

  button.disabled = false;
  button.textContent = "Run System Diagnostic";
}

// ── Cross-platform match report ────────────────────────────────────────────

export async function fetchSyncMatchReport() {
  const response = await fetch("/api/sync-match-report", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Failed with HTTP ${response.status}`);
  return body.report || { scannedRows: 0, totalUnmatchedRows: 0, platforms: {} };
}

// A record that carries no IMDB, TMDB, or TVDB id was never identified, and is
// the only kind a search result can repair. The ids are read directly rather
// than inferred from the media key: the key is stamped when the row is written
// and is not rebuilt when a Fix Match resolves an id afterwards, so a record
// fixed by hand would otherwise be offered for matching forever. The key is
// still consulted for rows written before the report carried the ids.
function identityIsUnresolved(sample = {}) {
  if (sample.imdb_id || sample.tmdb_id || sample.tvdb_id) return false;
  const key = String(sample.media_key || "");
  if (!key) return true;
  return !/:(imdb|tmdb|tvdb):/.test(key);
}

function matchReportSampleLabel(sample = {}) {
  if (sample.media_type === "episode") {
    const show = sample.show_title || sample.title || "Unknown show";
    const hasCode = sample.season != null && sample.episode != null;
    const code = hasCode ? ` S${String(sample.season).padStart(2, "0")}E${String(sample.episode).padStart(2, "0")}` : "";
    return `${show}${code}`;
  }
  return sample.title || "Unknown title";
}

export async function triggerFixAllMatches(platformTarget = "all", button) {
  let report;
  try {
    report = await fetchSyncMatchReport();
  } catch (error) {
    _setMessage(`Could not fetch match report: ${error.message}`, "error");
    return;
  }

  const platforms = Object.entries(report.platforms || {}).filter(([name, stats]) => {
    if (platformTarget !== "all" && name !== platformTarget) return false;
    return stats && Array.isArray(stats.samples) && stats.samples.length > 0;
  });

  const allSamples = platforms.flatMap(([, stats]) => stats.samples).filter((s) => s && s.id);

  if (!allSamples.length) {
    _setMessage("No unmatched items found to fix.", "info");
    return;
  }

  const uniqueSamples = Array.from(new Map(allSamples.map((item) => [item.id, item])).values());
  const targetLabel = platformTarget === "all" ? "all media servers" : platformName(platformTarget);

  _showConfirmModal(
    `Fix all ${uniqueSamples.length} unmatched item(s) on ${targetLabel}?\n\nThis will attempt automatic rematching first. Any items that cannot be matched automatically will be presented 1-by-1 for manual matching.`,
    async () => {
      const originalText = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = `Fixing ${uniqueSamples.length}...`;
      }

      _setMessage(`Fixing matches automatically... 0/${uniqueSamples.length}`, "info");

      let autoSuccessCount = 0;
      const manualQueue = [];

      for (let i = 0; i < uniqueSamples.length; i++) {
        const sample = uniqueSamples[i];
        try {
          const res = await fetch("/api/retry-sync", {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ id: sample.id, media_key: sample.media_key || "" }),
          });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.status === "success" || String(data.status || "").includes("success")) {
              autoSuccessCount++;
            } else {
              manualQueue.push(sample);
            }
          } else {
            manualQueue.push(sample);
          }
        } catch {
          manualQueue.push(sample);
        }

        if (i % 3 === 0 || i === uniqueSamples.length - 1) {
          _setMessage(`Fixing matches... ${i + 1}/${uniqueSamples.length} (${autoSuccessCount} auto-fixed, ${manualQueue.length} require manual match)`, "info");
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }

      await _loadSyncJobs({ force: true });
      await _loadSyncHistory({ force: true });

      // Only items whose identity is unresolved are answerable by hand. An item
      // that already carries a provider id is not unmatched because Plekt
      // picked the wrong title - it is unmatched because that library does not
      // hold it, and no search result can change that.
      const matchable = manualQueue.filter(identityIsUnresolved);
      const libraryGaps = manualQueue.filter((sample) => !identityIsUnresolved(sample));

      // Group TV show episodes so matching 1 episode fixes the entire show at once
      const groupedManualQueue = [];
      const seenShows = new Set();
      for (const sample of matchable) {
        if (sample.media_type === "episode") {
          const showKey = (sample.show_title || sample.title || "").toLowerCase().trim();
          if (showKey && seenShows.has(showKey)) continue;
          if (showKey) seenShows.add(showKey);
        }
        groupedManualQueue.push(sample);
      }

      const gapNote = libraryGaps.length
        ? ` ${libraryGaps.length} item(s) are identified correctly and simply absent from those libraries; they are not listed and need nothing from you.`
        : "";

      if (!groupedManualQueue.length) {
        _setMessage(
          libraryGaps.length
            ? `Auto-fix complete: ${autoSuccessCount} resolved. Nothing left to match by hand.${gapNote}`
            : `Successfully fixed all ${autoSuccessCount} unmatched items automatically!`,
          libraryGaps.length ? "warning" : "success",
        );
        window.dispatchEvent(new Event("sync-match-report-refresh"));
        return;
      }

      _setMessage(`Auto-fix complete: ${autoSuccessCount} resolved, ${groupedManualQueue.length} show(s)/item(s) need a manual match. Opening 1-by-1 manual matching...${gapNote}`, "warning");

      presentManualMatchQueue(groupedManualQueue, 0, autoSuccessCount);
    }
  );
}

function presentManualMatchQueue(queue, index, autoSuccessCount) {
  if (index >= queue.length) {
    _setMessage(`Completed manual matching queue (${queue.length} item${queue.length !== 1 ? "s" : ""} processed). Re-scanning match report...`, "success");
    window.dispatchEvent(new Event("sync-match-report-refresh"));
    return;
  }

  const sample = queue[index];
  const title = sample.media_type === "episode" ? (sample.show_title || sample.title || "") : (sample.title || "");
  const mediaType = sample.media_type || "movie";
  const countHeader = `Fix Match (${index + 1} of ${queue.length} requiring manual match)`;

  openFixMatchDialog(
    document.body,
    sample.id,
    title,
    mediaType,
    async () => {
      _setMessage(`Updated match for "${title}". Retrying sync... (${index + 1}/${queue.length})`, "info");

      // Filter out any other episodes of the same show from the remainder of the queue
      if (sample.media_type === "episode") {
        const showKey = (sample.show_title || sample.title || "").toLowerCase().trim();
        for (let k = queue.length - 1; k > index; k--) {
          const checkKey = (queue[k].show_title || queue[k].title || "").toLowerCase().trim();
          if (checkKey === showKey) queue.splice(k, 1);
        }
      }

      try {
        await fetch("/api/retry-sync", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ id: sample.id, media_key: sample.media_key || "" }),
        });
      } catch { /* ignore */ }

      await _loadSyncJobs({ force: true });
      await _loadSyncHistory({ force: true });
      window.dispatchEvent(new Event("sync-match-report-refresh"));
      setTimeout(() => presentManualMatchQueue(queue, index + 1, autoSuccessCount), 250);
    },
    {
      headerTitle: countHeader,
      mediaKey: sample.media_key || "",
      onSkip: () => {
        _setMessage(`Skipped manual match for "${title}". Loading next item (${index + 2}/${queue.length})...`, "info");
        setTimeout(() => presentManualMatchQueue(queue, index + 1, autoSuccessCount), 150);
      },
      onCancel: () => {
        _setMessage(`Manual match queue stopped (${index} of ${queue.length} completed).`, "info");
        window.dispatchEvent(new Event("sync-match-report-refresh"));
      },
    }
  );
}

// Each row in the report comes from a watch record's stored sync telemetry, so
// re-reading the report cannot clear an entry on its own - the record has to be
// dispatched again first. Rescan re-runs the sync for every listed item and
// rebuilds the report from the fresh results. Media a library genuinely does
// not hold stays listed, because that is still true after the rescan.
export async function triggerRescanMatchReport(button) {
  let report;
  try {
    report = await fetchSyncMatchReport();
  } catch (error) {
    _setMessage(`Could not fetch match report: ${error.message}`, "error");
    return;
  }

  const samples = Object.values(report.platforms || {})
    .flatMap((stats) => stats?.samples || [])
    .filter((s) => s && s.id && identityIsUnresolved(s));
  const uniqueSamples = Array.from(new Map(samples.map((item) => [item.id, item])).values());

  if (!uniqueSamples.length) {
    _setMessage("No unmatched items to rescan.", "info");
    window.dispatchEvent(new Event("sync-match-report-refresh"));
    return;
  }

  const originalText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = `Rescanning 0/${uniqueSamples.length}...`;
  }
  _setMessage(`Rescanning ${uniqueSamples.length} unmatched item(s)...`, "info");

  let resolved = 0;
  for (let i = 0; i < uniqueSamples.length; i++) {
    const sample = uniqueSamples[i];
    try {
      const res = await fetch("/api/retry-sync", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: sample.id, media_key: sample.media_key || "" }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (String(data.status || "").includes("success")) resolved += 1;
      }
    } catch { /* counted as still unmatched */ }

    if (button) button.textContent = `Rescanning ${i + 1}/${uniqueSamples.length}...`;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (button) {
    button.disabled = false;
    button.textContent = originalText;
  }

  await _loadSyncJobs({ force: true });
  await _loadSyncHistory({ force: true });

  const remaining = uniqueSamples.length - resolved;
  _setMessage(
    remaining
      ? `Rescan complete: ${resolved} of ${uniqueSamples.length} item(s) now match. The remaining ${remaining} still have no confirmed identity - use Fix All Matches to set them.`
      : `Rescan complete: all ${resolved} item(s) now match.`,
    remaining ? "warning" : "success",
  );
  window.dispatchEvent(new Event("sync-match-report-refresh"));
}

export function renderSyncMatchReport(report = {}) {
  // Only media Plekt could not identify is worth showing. A record that
  // carries a provider id and still finds no match means that library has no
  // copy - a difference between libraries, not a fault, and nothing here can
  // act on it. The full unfiltered figures remain in `GET /api/sync-match-report`
  // and in Sync Health.
  const platforms = ["plex", "emby", "jellyfin"]
    .map((platform) => {
      const stats = report.platforms?.[platform];
      if (!stats) return { platform, stats: null };
      const samples = (stats.samples || []).filter(identityIsUnresolved);
      return {
        platform,
        stats: {
          ...stats,
          samples,
          uniqueMediaCount: samples.length,
          movies: samples.filter((s) => s.media_type === "movie").length,
          episodes: samples.filter((s) => s.media_type === "episode").length,
          rowCount: samples.reduce((sum, s) => sum + (Number(s.rowCount) || 1), 0),
        },
      };
    })
    .filter((entry) => entry.stats && entry.stats.uniqueMediaCount > 0);

  if (!platforms.length) {
    return `<div class="empty-log"><b>Nothing to match</b><span>Every item a platform could not find is already identified, so there is nothing here to correct (${report.scannedRows || 0} records with telemetry scanned).</span></div>`;
  }

  const globalHeader = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px solid var(--line);">
      <span style="font-size: 0.85rem; color: var(--muted); flex: 1 1 12rem; min-width: 0;">Cross-platform library matching found unmatched items across connected media servers.</span>
      <div style="display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; justify-content: flex-end;">
        <button type="button" class="button-ghost rescan-matches-btn" title="Re-run the sync for every listed item and rebuild this report" style="font-size: 0.8rem; padding: 0.35rem 0.85rem; white-space: nowrap;">Rescan</button>
        <button type="button" class="button-primary fix-all-matches-btn" data-platform="all" style="font-size: 0.8rem; padding: 0.35rem 0.85rem; white-space: nowrap;">Fix All Matches</button>
      </div>
    </div>
  `;

  const blocks = platforms.map(({ platform, stats }) => {
    const truncated = stats.uniqueMediaCount > stats.samples.length
      ? `<div style="font-size: 0.8rem; color: var(--muted); margin-top: var(--space-1);">Showing the first ${stats.samples.length} of ${stats.uniqueMediaCount} unmatched items.</div>`
      : "";
    return `
      <div style="margin-bottom: var(--space-3);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-1);">
          <div style="font-weight: 700;">
            ${escapeHtml(platformName(platform))}
            <span style="font-weight: 400; color: var(--muted); margin-left: var(--space-1);">${stats.uniqueMediaCount} item${stats.uniqueMediaCount !== 1 ? "s" : ""} not found (${stats.movies} movie${stats.movies !== 1 ? "s" : ""}, ${stats.episodes} episode${stats.episodes !== 1 ? "s" : ""}) across ${stats.rowCount} record${stats.rowCount !== 1 ? "s" : ""}</span>
          </div>
          <button type="button" class="button-ghost fix-all-matches-btn" data-platform="${escapeAttribute(platform)}" style="font-size: 0.78rem; padding: 0.3rem 0.65rem; white-space: nowrap;">Fix ${escapeHtml(platformName(platform))} Matches</button>
        </div>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <thead>
              <tr style="text-align: left; color: var(--muted);">
                <th style="padding: 0.3rem 0.5rem;">Title</th>
                <th style="padding: 0.3rem 0.5rem;">Type</th>
                <th style="padding: 0.3rem 0.5rem;">Last watched</th>
                <th style="padding: 0.3rem 0.5rem;">Detail</th>
                <th style="padding: 0.3rem 0.5rem;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${stats.samples.map((sample) => `
                <tr style="border-top: 1px solid var(--line);">
                  <td style="padding: 0.3rem 0.5rem; word-break: break-word;">${escapeHtml(matchReportSampleLabel(sample))}</td>
                  <td style="padding: 0.3rem 0.5rem;">${escapeHtml(sample.media_type === "episode" ? "TV" : "Movie")}</td>
                  <td style="padding: 0.3rem 0.5rem; white-space: nowrap;">${escapeHtml(formatDate(sample.watched_at))}</td>
                  <td style="padding: 0.3rem 0.5rem; color: var(--muted); word-break: break-word;">
                    Not identified - pick the right title to fix it.
                    ${sample.detail && !/^no matching item found$/i.test(sample.detail.trim())
                      ? `<span style="display: block; opacity: 0.75;">${escapeHtml(sample.detail)}</span>`
                      : ""}
                  </td>
                  <td style="padding: 0.3rem 0.5rem; white-space: nowrap;">
                    ${sample.id ? `<button type="button" class="button-ghost media-fix-match-btn" data-edit-id="${escapeAttribute(sample.id)}" data-title="${escapeAttribute(sample.media_type === "episode" ? sample.show_title || sample.title || "" : sample.title || "")}" data-media-type="${escapeAttribute(sample.media_type || "movie")}">Fix match</button>` : ""}
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${truncated}
      </div>
    `;
  }).join("");

  return globalHeader + blocks;
}

function initSyncMatchReport() {
  const details = document.getElementById("syncMatchReport");
  const container = document.getElementById("syncMatchReportContainer");
  if (!details || !container || details.dataset.matchReportBound) return;
  details.dataset.matchReportBound = "1";
  const loadReport = () => {
    if (!details.open) return;
    container.innerHTML = `<div class="idle-state"><b>Loading match report...</b></div>`;
    fetchSyncMatchReport()
      .then((report) => { container.innerHTML = renderSyncMatchReport(report); })
      .catch((error) => {
        container.innerHTML = `<div class="empty-log"><b>Match report unavailable</b><span>${escapeHtml(error.message)}</span></div>`;
      });
  };
  details.addEventListener("toggle", loadReport);
  container.addEventListener("click", (event) => {
    const rescanBtn = event.target.closest(".rescan-matches-btn");
    if (rescanBtn) {
      triggerRescanMatchReport(rescanBtn);
      return;
    }
    const fixAllBtn = event.target.closest(".fix-all-matches-btn");
    if (fixAllBtn) {
      const platform = fixAllBtn.dataset.platform || "all";
      triggerFixAllMatches(platform, fixAllBtn);
    }
  });
  window.addEventListener("sync-match-report-refresh", loadReport);
}

// ── Clear missing telemetry ────────────────────────────────────────────────

export async function triggerClearMissingTelemetry(button) {
  const btn = button || elements.clearMissingTelemetryButton || document.querySelector('[data-action="clearMissingTelemetry"]');
  if (!btn) return;

  _showConfirmModal(
    "Clear missing dispatch telemetry records?\n\nThis will mark records with missing telemetry as resolved, removing them from the outstanding jobs list. This is safe - it only affects logging, not actual sync functionality.",
    async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Clearing...";

      const titleEl = document.getElementById("terminalModalTitle");
      if (titleEl) titleEl.textContent = "Clear Telemetry Terminal";

      elements.terminalModal?.classList.remove("hidden");
      if (elements.retryTerminalOutput) elements.retryTerminalOutput.innerHTML = "";

      function termLog(text, tone = "info") {
        if (!elements.retryTerminalOutput) return;
        const span = document.createElement("span");
        if (tone === "error") { span.style.color = "#fb7185"; span.style.fontWeight = "bold"; }
        else if (tone === "success") { span.style.color = "#34d399"; span.style.fontWeight = "bold"; }
        else if (tone === "warn") { span.style.color = "#f59e0b"; }
        else if (tone === "header") { span.style.color = "#38bdf8"; span.style.fontWeight = "bold"; }
        else { span.style.color = "#e8edf2"; }
        span.textContent = text + "\n";
        elements.retryTerminalOutput.appendChild(span);
        elements.retryTerminalOutput.scrollTop = elements.retryTerminalOutput.scrollHeight;
      }

      termLog("plekt@server:~$ ./clear-missing-telemetry", "header");
      termLog("Initiating request to clear missing dispatch telemetry...", "info");
      termLog("POST /api/clear-missing-telemetry HTTP/1.1", "info");

      try {
        const response = await fetch("/api/clear-missing-telemetry", { method: "POST", headers: authHeaders() });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          termLog("[ERROR] Clear request failed with status: " + response.status, "error");
          if (body.error) termLog("Reason: " + body.error, "error");
          throw new Error(body.error || `Failed with HTTP ${response.status}`);
        }
        termLog("Response received: HTTP 200 OK", "success");
        termLog(`Successfully cleared ${body.cleared || 0} watch history record(s) with missing telemetry.`, "success");
        termLog("\n✨ Done!", "success");
        _setMessage(`Cleared ${body.cleared || 0} records`, "success");
        await _loadSyncJobs({ force: true });
      } catch (error) {
        termLog(`\n[FATAL ERROR] Clear process aborted: ${error.message}`, "error");
        _setMessage(`Error: ${error.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  );
}

// ── Retry all in category ──────────────────────────────────────────────────

export async function triggerRetryAllCategory(categoryName, button) {
  if (!categoryName || !state.syncJobs) return;

  const categories = categorizeIssues(state.syncJobs);
  const jobsInCategory = categories[categoryName] || [];

  if (!jobsInCategory.length) { _setMessage("No issues to retry in this category", "info"); return; }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = `Retrying ${jobsInCategory.length}...`;

  const categoryLabels = {
    plexMismatch: "Plex Match",
    targetMismatch: "Emby/Jellyfin Match",
    otherIssues: "Unresolved",
    missingTelemetry: "Missing Telemetry",
  };
  const categoryLabel = categoryLabels[categoryName] || categoryName;

  _showConfirmModal(
    `Retry all ${jobsInCategory.length} ${categoryLabel} issues?\n\nThis will sequentially retry each item. The process may take a minute or two.`,
    async () => {
      try {
        _setMessage(`Retrying ${jobsInCategory.length} items...`, "info");
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < jobsInCategory.length; i++) {
          const job = jobsInCategory[i];
          try {
            const response = await fetch("/api/retry-sync", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ id: job.id }),
            });
            if (response.ok) {
              const data = await response.json();
              if (data.status === "success" || String(data.status || "").includes("success")) successCount++;
              else failCount++;
            } else { failCount++; }
          } catch (err) {
            console.error(`Failed to retry ${job.id}:`, err);
            failCount++;
          }
          if (i % 5 === 0 || i === jobsInCategory.length - 1) {
            _setMessage(`Retrying... ${i + 1}/${jobsInCategory.length} (${successCount} passed)`, "info");
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        await _loadSyncJobs({ force: true });
        await _loadSyncHistory({ force: true });
        const resultMsg = `Completed ${jobsInCategory.length} retries. ${successCount} passed, ${failCount} had issues.`;
        _setMessage(resultMsg, successCount > failCount ? "success" : "warning");
      } catch (error) {
        _setMessage(`Error during retry: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  );
}

// ── History repair / dedup / backfill / full-sync tools ────────────────────

export async function runRepairWorkflow() {
  const button = elements.runRepairButton;
  const status = elements.repairStatus;
  if (!button || !status) return;
  button.disabled = true;
  button.textContent = "Repairing History...";
  setStatusPill(status, "Starting history repair...", "warning");
  const maxIterations = 20;
  let totalConverted = 0;
  let totalBackfilled = 0;
  const appendLog = (text) => {
    const now = new Date().toISOString();
    if (elements.repairLog) {
      elements.repairLog.classList.remove("hidden");
      elements.repairLog.textContent = `${now} - ${text}\n` + elements.repairLog.textContent;
      elements.repairLog.scrollTop = 0;
    } else {
      status.textContent = text;
    }
  };
  for (let i = 1; i <= maxIterations; i++) {
    const passLabel = `Repair pass ${i}`;
    appendLog(`${passLabel} started`);
    try {
      const res = await fetch("/api/admin-fix-history", { method: "POST", headers: authHeaders() });
      let body;
      try { body = await res.json(); } catch (e) { body = { text: await res.text() }; }
      const converted = Number(body.converted || 0);
      const backfilled = Number(body.backfilled || 0);
      totalConverted += converted;
      totalBackfilled += backfilled;
      appendLog(`${passLabel} result: retyped=${Number(body.retyped || 0)}, converted=${converted}, backfilled=${backfilled}${body.note ? `, note=${body.note}` : ''}`);
      if (!converted && !backfilled) {
        appendLog(`${passLabel} made no changes; stopping.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      appendLog(`ERROR: ${err?.message || String(err)}`);
      setStatusPill(status, `Repair failed: ${err?.message || String(err)}`, "error");
      button.disabled = false;
      throw err;
    }
  }
  setStatusPill(status, `Done: retyped history, converted ${totalConverted}, backfilled ${totalBackfilled}.`, "ready");
  button.disabled = false;
  button.textContent = "Repair History Now";
  clearDerivedUiCaches();
  await loadHistory().catch(() => { });
  return { converted: totalConverted, backfilled: totalBackfilled };
}

export async function runPhantomWatchAudit() {
  const button = elements.phantomAuditButton;
  const status = elements.phantomAuditStatus;
  const log = elements.phantomAuditLog;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Auditing...";
  setStatusPill(status, "Scanning history...", "warning");
  if (log) { log.classList.remove("hidden"); log.textContent = ""; }
  try {
    const response = await fetch("/api/phantom-watch-audit", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const malformedCount = Number(body.malformed_episode_count || 0);
    const candidateCount = Number(body.candidate_groups || 0);
    const totalFindings = candidateCount + malformedCount;
    const summary = `Scanned ${Number(body.scanned || 0).toLocaleString()} rows. Found ${candidateCount} suspicious group(s): ${Number(body.high_confidence_groups || 0)} high-confidence, ${Number(body.review_groups || 0)} review, and ${malformedCount} malformed imported episode row(s). No records changed.`;
    setStatusPill(status, totalFindings ? `${totalFindings} finding(s)` : "No findings", totalFindings ? "warning" : "ready");
    if (log) {
      const malformedLog = (body.malformed_episode_rows || []).slice(0, 20).map((row) =>
        `\n[malformed episode] ${row.title || row.show_title || "Unknown"} — ${row.reason}: ${row.details}`
      ).join("");
      log.textContent = summary + (body.candidates || []).slice(0, 20).map((item) => {
        const first = item.records?.[0] || {}; const last = item.records?.at(-1) || {};
        return `\n[${item.confidence}] ${first.title || first.show_title || "Unknown"} - ${first.watched_at} → ${last.watched_at} (${item.reason}, ${item.gap_seconds}s)`;
      }).join("") + malformedLog;
    }
    return body;
  } catch (error) {
    setStatusPill(status, `Audit failed: ${error.message}`, "error");
    if (log) log.textContent = error.message;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Run Phantom Audit";
  }
}

export async function runPhantomWatchRepair() {
  const button = elements.phantomRepairButton;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Removing confirmed rows...";
  try {
    const response = await fetch("/api/phantom-watch-repair", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const deleted = Number(body.deleted || 0);
    const malformedDeleted = Number(body.malformed_episode_deleted || 0);
    setStatusPill(elements.phantomAuditStatus, deleted ? `${deleted} row(s) removed` : "No confirmed rows", deleted ? "ready" : "muted");
    if (elements.phantomAuditLog) {
      elements.phantomAuditLog.classList.remove("hidden");
      elements.phantomAuditLog.textContent = deleted
        ? `Removed ${deleted} confirmed row(s): ${Number(body.burst_deleted || 0)} burst duplicate(s) and ${malformedDeleted} malformed imported episode row(s). Explicit manual watches and spaced-out rewatches were preserved.`
        : "No confirmed phantom or malformed imported episode rows were found.";
    }
    await clearDerivedUiCaches();
    await loadHistory();
    return body;
  } finally {
    button.disabled = false;
    button.textContent = "Remove Confirmed Phantom Rows";
  }
}

// Read-only: how many episode watch rows lack a real stored name. Shows a
// friendly summary and previews the newest rows so a user knows what a restore
// would touch before confirming.
export async function runEpisodeTitleAudit() {
  const button = elements.episodeTitleAuditButton;
  const status = elements.episodeTitleStatus;
  const logEl = elements.episodeTitleLog;
  if (!button || !status) return;
  button.disabled = true;
  button.textContent = "Auditing...";
  setStatusPill(status, "Scanning history...", "warning");
  if (logEl) { logEl.classList.remove("hidden"); logEl.textContent = ""; }
  try {
    const response = await fetch("/api/episode-title-audit", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const total = Number(body.total || 0);
    const noTitleProvided = Number(body.noTitleProvided || 0);
    const retryable = Number(body.retryable || 0);
    setStatusPill(status, total ? `${total.toLocaleString()} row(s) need checking` : "No rows need checking", total ? "warning" : "ready");
    if (logEl) {
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20) : [];
      logEl.textContent = total
        ? `${total.toLocaleString()} episode watch row(s) still need a title check (showing the newest ${rows.length}). Audits never change anything - use Restore to scan the full library.`
        : "No episode watch rows need a title check. Audits never change anything.";
      if (noTitleProvided) logEl.textContent += `\n${noTitleProvided.toLocaleString()} row(s) were verified with no title provided and are not listed for repair.`;
      if (retryable) logEl.textContent += `\n${retryable.toLocaleString()} row(s) have a retryable metadata error.`;
      logEl.textContent += rows.map((row) =>
        `\n[${row.show_title || row.title || "Unknown"}] S${String(row.season ?? "").padStart(2, "0")}E${String(row.episode ?? "").padStart(2, "0")} — "${row.episode_title || "No title provided"}"`
      ).join("");
    }
    return body;
  } catch (error) {
    setStatusPill(status, `Audit failed: ${error.message}`, "error");
    if (logEl) logEl.textContent = error.message;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Audit Missing Episode Names";
  }
}

// Backfill: replace rows that stored a coordinate with the real episode name,
// using stored data first and a grouped metadata lookup for the rest. The
// server scans the entire actionable set in one request.
export async function runEpisodeTitleBackfill() {
  const button = elements.episodeTitleBackfillButton;
  const status = elements.episodeTitleStatus;
  const logEl = elements.episodeTitleLog;
  if (!button || !status) return;

  const confirmRestore = typeof window !== "undefined" && window.confirm
    ? window.confirm("Restore missing episode names? This updates watch-history rows using stored data and a metadata lookup. It cannot be undone.")
    : true;
  if (!confirmRestore) return;

  button.disabled = true;
  button.textContent = "Restoring...";
  setStatusPill(status, "Backfilling episode names...", "warning");
  if (logEl) { logEl.classList.remove("hidden"); logEl.textContent = ""; }
  try {
    setStatusPill(status, "Scanning the full library...", "warning");
    const response = await fetch("/api/episode-title-backfill", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200, allow_fetch: true }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const totalBackfilled = Number(body.backfilled || 0);
    const remaining = Number(body.remaining || 0);
    const retryable = Number(body.retryable || 0);
    setStatusPill(status, totalBackfilled ? `${totalBackfilled} name(s) restored` : "No names restored", totalBackfilled ? "ready" : "muted");
    if (logEl) {
      logEl.textContent = totalBackfilled
        ? `Scanned ${Number(body.scanned || 0).toLocaleString()} row(s) and restored ${totalBackfilled.toLocaleString()} episode name(s).`
        : `Scanned ${Number(body.scanned || 0).toLocaleString()} row(s); no real names were available for the checked rows.`;
      const noTitleProvided = Number(body.no_title_provided || 0);
      if (noTitleProvided) logEl.textContent += ` ${noTitleProvided.toLocaleString()} row(s) were verified with no title provided and were left out of the repair list.`;
      if (retryable || remaining > 0) logEl.textContent += ` ${remaining.toLocaleString()} row(s) remain because their metadata lookup needs a retry.`;
    }
    return { totalBackfilled, remaining };
  } catch (error) {
    setStatusPill(status, `Restore failed: ${error.message}`, "error");
    if (logEl) logEl.textContent = error.message;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Restore Episode Names";
  }
}

export async function runTraktBackfill() {
  const button = elements.traktBackfillButton;
  const status = elements.traktBackfillStatus;
  const logEl = elements.traktBackfillLog;
  if (!button || !status) return;
  const limit = Math.max(1, Number(elements.traktBackfillLimit?.value || 500));
  const rate = Math.max(50, Number(elements.traktBackfillRate?.value || 300));
  button.disabled = true;
  button.textContent = "Backfilling Trakt Imports...";
  setStatusPill(status, `Starting Trakt import backfill (limit=${limit}, rate=${rate}ms)`, "warning");
  if (logEl) {
    logEl.classList.remove("hidden");
    logEl.textContent = `Starting Trakt import backfill at ${new Date().toISOString()}\n`;
  }
  try {
    const maxBatches = 2000;
    let batch = 0;
    let totalBackfilled = 0;
    let lastBackfilled = -1;
    for (; batch < maxBatches; batch++) {
      setStatusPill(status, `Running batch #${batch + 1}...`, "warning");
      const resp = await fetch(`/api/admin-backfill-trakt`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ limit, rateMs: rate }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = body.error || `Backfill failed (${resp.status})`;
        if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
        setStatusPill(status, `Error: ${msg}`, "error");
        break;
      }
      const tried = Number(body.tried || 0);
      const backfilled = Number(body.backfilled || 0);
      totalBackfilled += backfilled;
      const now = new Date().toISOString();
      if (logEl) {
        logEl.textContent = `${now} - Batch ${batch + 1}: tried=${tried} backfilled=${backfilled}\n` + logEl.textContent;
      }
      let remaining = null;
      try {
        const st = await fetch(`/api/admin-backfill-status`, { headers: authHeaders() });
        const stBody = await st.json().catch(() => ({}));
        remaining = Number(stBody.remaining ?? stBody.missing ?? null);
      } catch (err) {
        // ignore
      }
      setStatusPill(status, remaining != null ? `Batch ${batch + 1}: backfilled ${backfilled}. Remaining: ${remaining}` : `Batch ${batch + 1}: backfilled ${backfilled}`, "warning");
      if ((backfilled === 0 && lastBackfilled === 0) || (remaining === 0)) {
        if (logEl) logEl.textContent = `${new Date().toISOString()} - No further progress; stopping.\n` + logEl.textContent;
        break;
      }
      lastBackfilled = backfilled;
      await new Promise((r) => setTimeout(r, 300));
    }
    setStatusPill(status, `Completed: total backfilled ${totalBackfilled} after ${batch + 1} batches`, "ready");
  } catch (err) {
    const msg = err?.message || String(err);
    if (logEl) logEl.textContent = `${new Date().toISOString()} - ERROR: ${msg}\n` + logEl.textContent;
    setStatusPill(status, `Error: ${msg}`, "error");
    throw err;
  } finally {
    button.disabled = false;
    button.textContent = "Backfill Trakt Imports";
  }
}

export async function runRematchTvShows() {
  const button = elements.rematchTvButton;
  const status = elements.rematchTvStatus;
  const logEl = elements.rematchTvLog;
  if (!button || !status) return;

  button.disabled = true;
  button.textContent = "Rematching...";
  status.textContent = "Running";
  status.className = "status-pill status-warning";
  if (logEl) {
    logEl.classList.remove("hidden");
    logEl.textContent = `Starting TV show rematch at ${new Date().toISOString()}\n`;
  }

  const limit = 8;
  let offset = 0;
  let page = 1;
  let hasMore = true;
  const totals = { matched: 0, updatedShows: 0, updatedRows: 0, failed: 0 };

  try {
    while (hasMore) {
      status.textContent = `Batch ${page}`;
      const response = await fetch("/api/rematch-tv-shows", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ offset, limit }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Rematch failed with ${response.status}`);

      totals.matched += Number(body.matched || 0);
      totals.updatedShows += Number(body.updatedShows || 0);
      totals.updatedRows += Number(body.updatedRows || 0);
      totals.failed += Number(body.failed || 0);

      if (logEl) {
        for (const line of body.log || []) logEl.textContent += line + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      offset = Number(body.nextOffset || offset + Number(body.processed || 0));
      hasMore = Boolean(body.hasMore) && Number(body.processed || 0) > 0;
      status.textContent = `Batch ${page}: ${Math.min(offset, Number(body.total || offset))}/${Number(body.total || offset)}`;
      page += 1;
    }

    clearDerivedUiCaches();
    await loadHistory({ force: true }).catch(() => null);
    status.textContent = `Complete: ${totals.updatedShows} shows, ${totals.updatedRows} rows`;
    status.className = "status-pill status-ready";
    setMessage(`TV rematch complete. Updated ${totals.updatedShows} shows and ${totals.updatedRows} episode rows.`, totals.failed ? "warning" : "success");
  } catch (error) {
    status.textContent = "Error";
    status.className = "status-pill status-error";
    if (logEl) logEl.textContent += `ERROR: ${error.message}\n`;
    setMessage(`TV rematch failed: ${error.message}`, "error");
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Rematch TV Shows";
  }
}

function appendFullSyncLog(message) {
  if (!elements.fullSyncLog) return;
  elements.fullSyncLog.classList.remove("hidden");
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  elements.fullSyncLog.textContent = `[${timestamp}] ${message}\n${elements.fullSyncLog.textContent || ""}`.trim();
  elements.fullSyncLog.scrollTop = 0;
}

function summarizeFullSyncPhase(summary = {}) {
  return Object.entries(summary)
    .map(([target, counts]) => {
      const success = Number(counts.success || 0);
      const notFound = Number(counts.notFound || 0);
      const skipped = Number(counts.skipped || 0);
      const error = Number(counts.error || 0);
      return `${platformName(target)} ${success} ok, ${notFound} not found, ${skipped} skipped, ${error} errors`;
    })
    .join(" | ");
}

export async function runFullSyncWatchstates() {
  if (state.fullSyncActive) return;
  const button = elements.fullSyncButton;
  const status = elements.fullSyncStatus;
  if (!button || !status) return;

  fullSyncRunId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `full-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fullSyncCancelRequested = false;
  fullSyncAbortController = new AbortController();
  state.fullSyncActive = true;
  button.disabled = true;
  button.textContent = "Syncing...";
  setStatusPill(status, "Running", "ready");
  if (elements.cancelFullSyncButton) {
    elements.cancelFullSyncButton.classList.remove("hidden");
    elements.cancelFullSyncButton.disabled = false;
    elements.cancelFullSyncButton.textContent = "Stop Restore";
  }
  if (elements.resetFullSyncButton) elements.resetFullSyncButton.disabled = true;
  if (elements.fullSyncLog) elements.fullSyncLog.textContent = "";
  beginFullSyncProgress();
  const limit = 100;
  const phases = ["watched", "progress"];
  try {
    for (const phase of phases) {
      if (fullSyncCancelRequested) break;
      let offset = 0;
      let batch = 1;
      let hasMore = true;
      let snapshotAt = null;
      appendFullSyncLog(`Starting ${phase} restore (up to ${limit} rows per batch).`);
      while (hasMore) {
        if (fullSyncCancelRequested) break;
        const requestBody = {
          phase,
          offset,
          limit,
          runId: fullSyncRunId,
          start: batch === 1,
        };
        if (snapshotAt) requestBody.snapshotAt = snapshotAt;
        const response = await fetch("/api/full-sync-watchstates", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: fullSyncAbortController.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(body.error || `Full sync failed with ${response.status}`);
          error.status = response.status;
          error.body = body;
          throw error;
        }
        updateFullSyncProgress(phase, body);
        if (body.snapshotAt) snapshotAt = Number(body.snapshotAt);
        const phaseState = fullSyncProgressState?.phases?.[phase];
        appendFullSyncLog(`${phase} batch ${batch}: processed ${formatNumber(phaseState?.processed || 0)} of ${formatNumber(phaseState?.total || 0)}. ${summarizeFullSyncPhase(body.summary || {})}`);
        if (Array.isArray(body.errors) && body.errors.length) {
          appendFullSyncLog(`${phase} batch ${batch}: ${body.errors.length} platform errors captured.`);
        }
        if (body.cancelled) {
          fullSyncCancelRequested = true;
          appendFullSyncLog(`${phase} restore was stopped by another session or an administrator.`);
          hasMore = false;
          break;
        }
        offset = Number(body.nextOffset || offset + Number(body.processed || 0));
        hasMore = Boolean(body.hasMore) && Number(body.processed || 0) > 0;
        batch += 1;
      }
      if (!fullSyncCancelRequested) appendFullSyncLog(`${phase} restore complete.`);
    }
    if (fullSyncCancelRequested) {
      finishFullSyncProgress("stopped");
      setStatusPill(status, "Stopped", "warning");
      appendFullSyncLog("Restore stopped. Completed batches remain applied; no new batches will be sent.");
      setMessage("Full sync stopped. Completed batches remain applied.", "warning");
      return;
    }
    clearDerivedUiCaches();
    finishFullSyncProgress("complete");
    setStatusPill(status, "Complete", "ready");
    const watchedRows = fullSyncProgressState?.phases?.watched?.processed || 0;
    const progressRows = fullSyncProgressState?.phases?.progress?.processed || 0;
    setMessage(`Full sync complete. Watched rows: ${formatNumber(watchedRows)}. Progress rows: ${formatNumber(progressRows)}.`, "success");
  } catch (error) {
    if (fullSyncCancelRequested || error?.name === "AbortError") {
      finishFullSyncProgress("stopped");
      setStatusPill(status, "Stopped", "warning");
      appendFullSyncLog("Restore stopped. Completed batches remain applied; no new batches will be sent.");
      setMessage("Full sync stopped. Completed batches remain applied.", "warning");
      return;
    }
    finishFullSyncProgress("error");
    setStatusPill(status, "Error", "error");
    appendFullSyncLog(`ERROR: ${error.message}`);
    if (Number(error?.status) === 409) {
      if (elements.resetFullSyncButton) elements.resetFullSyncButton.disabled = false;
      appendFullSyncLog("If the other restore was interrupted, use Reset Restore Lock before trying again.");
      setMessage("Another restore is active. Reset its lock only if it was interrupted or abandoned.", "warning");
    } else {
      setMessage(`Full sync failed: ${error.message}`, "error");
    }
    throw error;
  } finally {
    state.fullSyncActive = false;
    button.disabled = false;
    button.textContent = "Full Sync Watchstates";
    if (elements.cancelFullSyncButton) {
      elements.cancelFullSyncButton.classList.add("hidden");
      elements.cancelFullSyncButton.disabled = false;
      elements.cancelFullSyncButton.textContent = "Stop Restore";
    }
    if (elements.resetFullSyncButton) elements.resetFullSyncButton.disabled = false;
    fullSyncAbortController = null;
    fullSyncRunId = "";
    fullSyncCancelRequested = false;
    _queueLiveHistoryRefresh({ immediate: true });
  }
}

export async function cancelFullSyncWatchstates() {
  if (!state.fullSyncActive || !fullSyncRunId) return;
  fullSyncCancelRequested = true;
  if (elements.cancelFullSyncButton) {
    elements.cancelFullSyncButton.disabled = true;
    elements.cancelFullSyncButton.textContent = "Stopping...";
  }
  const runId = fullSyncRunId;
  fullSyncAbortController?.abort();
  try {
    await fetch("/api/full-sync-watchstates", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", runId }),
    });
  } catch {
    // The browser request is already aborted; a stale server heartbeat will
    // release the restore guard if this cancellation request cannot reach it.
  }
}

// ── Cache stats ──────────────────────────────────────────────────────────

export function resetFullSyncWatchstates() {
  if (state.fullSyncActive || !elements.resetFullSyncButton) return;

  showConfirmModal(
    "Reset the Full Sync Watchstates restore lock?\n\nUse this only when the other restore was abandoned or interrupted by a server restart. Any in-flight restore request will stop before sending another batch.",
    async () => {
      const button = elements.resetFullSyncButton;
      button.disabled = true;
      const status = elements.fullSyncStatus;
      try {
        const response = await fetch("/api/full-sync-watchstates", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Restore reset failed with ${response.status}`);
        appendFullSyncLog(body.message || "Full Sync Watchstates restore lock cleared.");
        if (status) setStatusPill(status, "Ready", "muted");
        if (fullSyncProgressState?.status === "error") finishFullSyncProgress("stopped");
        setMessage(body.message || "Full Sync Watchstates restore lock cleared.", body.reset ? "success" : "info");
      } catch (error) {
        appendFullSyncLog(`ERROR: ${error.message}`);
        setMessage(`Could not reset the restore lock: ${error.message}`, "error");
      } finally {
        button.disabled = false;
      }
    },
  );
}

function fmtCacheBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export async function loadCacheStats({ force = false } = {}) {
  if (!state.token || state.cacheStatsLoading || (state.cacheStats && !force)) return state.cacheStats;
  state.cacheStatsLoading = true;
  renderCachePanel();
  try {
    const response = await fetch("/api/cache-stats", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache stats failed with ${response.status}`);
    state.cacheStats = body;
    return body;
  } finally {
    state.cacheStatsLoading = false;
    renderCachePanel();
  }
}

async function clearCacheType(type) {
  try {
    const response = await fetch("/api/clear-cache", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cache clear failed with ${response.status}`);
    const label = type === "all" ? "all images" : type;
    if (body.filesKept) {
      setMessage(`Cleared cached ${label} entries for this user (shared files kept).`, "success");
    } else {
      setMessage(`Cleared ${body.deleted} file${body.deleted !== 1 ? "s" : ""} (${fmtCacheBytes(body.freed)} freed) from ${label}.`, "success");
    }
    state.cacheStats = null;
    loadCacheStats().catch((error) => setMessage(error.message, "error"));
  } catch (error) {
    setMessage(error.message, "error");
  }
}

export function renderCachePanel() {
  const panel = document.getElementById("cacheStatsPanel");
  if (!panel) return;
  if (state.cacheStatsLoading && !state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">Loading...</p>`;
    return;
  }
  if (!state.cacheStats) {
    panel.innerHTML = `<p class="muted-text" style="padding:var(--space-3) 0;">No data loaded.</p>`;
    return;
  }
  const { disk } = state.cacheStats;
  const rows = [
    { key: "posters", label: "Posters" },
    { key: "backdrops", label: "Backdrops" },
    { key: "profiles", label: "Profiles" },
  ];
  const totalCount = rows.reduce((sum, r) => sum + (disk[r.key]?.count || 0), 0);
  const totalSize = rows.reduce((sum, r) => sum + (disk[r.key]?.size || 0), 0);

  const maxBytes = Math.max(...rows.map(({ key }) => disk[key]?.size || 0), 1);

  panel.innerHTML = `
    <div class="cache-gauge-grid">
      ${rows.map(({ key, label }) => {
        const count = disk[key]?.count || 0;
        const size = disk[key]?.size || 0;
        const percent = Math.max(5, Math.round((size / maxBytes) * 100));
        return `
          <div class="cache-gauge-card">
            <div class="cache-gauge-meta">
              <span class="cache-gauge-title">${label}</span>
              <span class="cache-gauge-count">${count.toLocaleString()} files</span>
            </div>
            <div class="cache-gauge-size">${fmtCacheBytes(size)}</div>
            <div class="cache-gauge-bar">
              <div class="cache-gauge-fill" style="width: ${percent}%;"></div>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:0.25rem;">
              <button class="button-ghost" type="button" style="font-size:0.76rem; padding:0.25rem 0.65rem; min-height:1.85rem; height:1.85rem;" data-clear-cache="${key}">Clear</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--line); flex-wrap:wrap; gap:1rem;">
      <div style="display:flex; gap:1.5rem; font-size:0.85rem;">
        <div><span style="color:var(--muted)">Total Files:</span> <strong style="color:var(--text); margin-left:0.3rem;">${totalCount.toLocaleString()}</strong></div>
        <div><span style="color:var(--muted)">Total Size:</span> <strong style="color:var(--text); margin-left:0.3rem;">${fmtCacheBytes(totalSize)}</strong></div>
      </div>
      <button class="button-primary" type="button" style="font-size:0.8rem; padding:0.25rem 0.85rem; height:2.2rem; min-height:2.2rem;" data-clear-cache="all">Clear All</button>
    </div>
  `;
  for (const btn of panel.querySelectorAll("[data-clear-cache]")) {
    btn.addEventListener("click", () => clearCacheType(btn.dataset.clearCache));
  }
}
