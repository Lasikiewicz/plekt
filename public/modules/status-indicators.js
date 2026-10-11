import { buildAuthHeaders } from "./auth.js?v=1.3.1.3.0";
import { state, elements } from "./state.js?v=1.3.1.3.0";

const REVIEW_POLL_MS = 30000;

let reviewPollTimer = null;
let reviewSummaryPromise = null;
let reviewSummaryRequestSerial = 0;
let attentionSummaryPromise = null;
let attentionSummaryRequestSerial = 0;

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function currentSyncProgress() {
  return state.syncProgress || state.syncActivityProgress || {};
}

function syncIsActive(progress = currentSyncProgress()) {
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  return Boolean(progress.active) || (total > 0 && completed < total);
}

function syncStatusText(progress = currentSyncProgress()) {
  if (syncIsActive(progress)) return `Sync - ${progress.label || "Working"}`;
  if (Number(state.syncAttentionCount) > 0) return "Sync - Attention";
  return "Sync - Idle";
}

function renderSidebarSyncAttention() {
  const container = elements.sidebarSyncAttention;
  const button = elements.sidebarSyncAttentionButton;
  if (!container || !button) return;
  const items = Array.isArray(state.clientAttention) ? state.clientAttention : [];
  const count = items.length;
  const tone = items.some((item) => ["error", "critical", "blocking", "red", "failed", "attention"].includes(String(item?.severity || item?.tone || "").toLowerCase()))
    ? "error"
    : "warning";
  const visible = count > 0;
  container.classList.toggle("hidden", !visible);
  if (!visible) {
    container.removeAttribute("data-attention-tone");
    button.removeAttribute("data-attention-tone");
    return;
  }
  const detail = tone === "error"
    ? `${count} issue${count === 1 ? "" : "s"}`
    : `${count} warning${count === 1 ? "" : "s"}`;
  container.dataset.attentionTone = tone;
  button.dataset.attentionTone = tone;
  if (elements.sidebarSyncAttentionTitle) elements.sidebarSyncAttentionTitle.textContent = "Attention";
  if (elements.sidebarSyncAttentionText) elements.sidebarSyncAttentionText.textContent = detail;
  button.title = "Open Sync Activity to review this issue";
  button.setAttribute("aria-label", `Attention: ${detail}. Open Sync Activity for details.`);
}

// This is the small, always-available part of the sync activity renderer. The
// full page module replaces these bindings when /sync-activity is opened.
export function renderSyncActivityStatus() {
  const progress = currentSyncProgress();
  const text = syncStatusText(progress);
  const hasAttention = Number(state.syncAttentionCount) > 0 || Boolean(state.syncAttentionError);
  const stateName = syncIsActive(progress) ? "active" : hasAttention ? "attention" : "idle";
  const attentionTone = state.syncAttentionSeverity === "warning" && !state.syncAttentionError ? "warning" : hasAttention ? "error" : "clear";

  if (elements.syncProgressIndicator && elements.syncProgressText) {
    elements.syncProgressText.textContent = text;
    elements.syncProgressIndicator.dataset.syncState = stateName;
    elements.syncProgressIndicator.dataset.attentionTone = attentionTone;
    elements.syncProgressIndicator.title = hasAttention
      ? "Open sync activity - attention needed"
      : "Open sync activity";
  }
  if (elements.syncActivityStatus && elements.syncActivityStatusText) {
    elements.syncActivityStatusText.textContent = text;
    elements.syncActivityStatus.dataset.syncState = stateName;
    elements.syncActivityStatus.dataset.attentionTone = attentionTone;
  }
  if (elements.startupScanNotice) {
    elements.startupScanNotice.classList.toggle("hidden", !progress.startupScanActive);
  }
  renderSidebarSyncAttention();
}

export function setSyncActivityProgress({ total = 0, completed = 0, active = false, label = "", currentItemLabel = "", startupScanActive = false } = {}) {
  const progress = { total, completed, active, label, currentItemLabel, startupScanActive };
  state.syncProgress = progress;
  state.syncActivityProgress = progress;
  renderSyncActivityStatus();
}

export function setSyncAttentionSummary({ count = 0, status = "", severity = "" } = {}) {
  const normalizedCount = Math.max(Number(count) || 0, 0);
  state.syncAttentionCount = normalizedCount;
  state.syncAttentionStatus = normalizedCount > 0 || String(status || "").toLowerCase() === "attention" ? "attention" : "clear";
  state.syncAttentionSeverity = normalizedCount > 0
    ? (String(severity || status).toLowerCase() === "warning" ? "warning" : "error")
    : "clear";
  if (normalizedCount === 0) {
    state.syncAttention = [];
    if (String(status || "").toLowerCase() !== "attention") state.syncAttentionError = "";
  }
  renderSyncActivityStatus();
}

function reviewCountFromBody(body) {
  return Math.max(Number(body?.count) || 0, 0);
}

export function renderManualWatchReviewSummary() {
  const button = document.querySelector("#manualWatchReviewButton");
  const count = document.querySelector("#manualWatchReviewCount");
  const pending = Math.max(Number(state.manualWatchReviewCount) || 0, 0);
  const label = `${pending} item${pending === 1 ? "" : "s"} waiting`;
  if (count) {
    count.textContent = pending > 99 ? "99+" : String(pending);
    count.setAttribute("aria-label", label);
  }
  if (button) {
    button.classList.toggle("hidden", !state.token || pending <= 0);
    button.setAttribute("aria-label", pending > 0 ? `Manual Watch review - ${label}` : "Manual Watch review");
  }
}

export async function loadManualWatchReviewSummary() {
  if (!state.token) {
    state.manualWatchReviewCount = 0;
    renderManualWatchReviewSummary();
    return 0;
  }
  if (reviewSummaryPromise) return reviewSummaryPromise;
  const requestSerial = ++reviewSummaryRequestSerial;
  reviewSummaryPromise = fetch("/api/manual-watch-review?summary=1", {
    cache: "no-store",
    headers: authHeaders(),
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `Manual Watch review failed with ${response.status}`);
      if (requestSerial === reviewSummaryRequestSerial) {
        state.manualWatchReviewCount = reviewCountFromBody(body);
        renderManualWatchReviewSummary();
      }
      return state.manualWatchReviewCount;
    })
    .finally(() => {
      reviewSummaryPromise = null;
    });
  return reviewSummaryPromise;
}

export async function loadSyncAttentionSummary() {
  if (!state.token) {
    setSyncAttentionSummary({ count: 0, status: "clear" });
    return [];
  }
  if (attentionSummaryPromise) return attentionSummaryPromise;
  const requestSerial = ++attentionSummaryRequestSerial;
  attentionSummaryPromise = fetch("/api/sync-attention", { headers: authHeaders(), cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `Sync attention failed with ${response.status}`);
      if (requestSerial === attentionSummaryRequestSerial) {
        state.syncAttention = Array.isArray(body.attention) ? body.attention : [];
        setSyncAttentionSummary({
          count: Math.max(Number(body.count) || state.syncAttention.length, 0),
          status: body.count ? "attention" : "clear",
          severity: state.syncAttention.some((item) => ["error", "critical", "blocking", "red", "failed", "attention"].includes(String(item?.severity || item?.tone || "").toLowerCase())) ? "error" : "warning",
        });
        state.syncAttentionLoaded = true;
      }
      return state.syncAttention;
    })
    .finally(() => {
      attentionSummaryPromise = null;
    });
  return attentionSummaryPromise;
}

export function startStatusSummaryPolling() {
  if (reviewPollTimer) return;
  reviewPollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden" || !state.token) return;
    loadManualWatchReviewSummary().catch(() => null);
  }, REVIEW_POLL_MS);
}

export function stopStatusSummaryPolling() {
  if (reviewPollTimer) window.clearInterval(reviewPollTimer);
  reviewPollTimer = null;
}
