import { buildAuthHeaders } from "./auth.js?v=2.3.0.0.6";
import { state } from "./state.js?v=2.3.0.0.6";
import { escapeHtml, formatNumber } from "./utils.js?v=2.3.0.0.6";

let _setMessage = () => {};
let _showConfirmModal = () => {};
let pollTimer = null;
let lastStatus = null;

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function fmtSize(bytes) {
  const num = Number(bytes || 0);
  if (num >= 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${num} B`;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    loadStorageStatus({ quiet: true }).catch(() => null);
  }, 1500);
}

function renderStoragePanel(data) {
  const panel = document.getElementById("storageOptimizationPanel");
  const statusPill = document.getElementById("storageOptimizationStatus");
  if (!panel) return;
  if (!data) {
    panel.innerHTML = `<p class="muted">Storage usage unavailable.</p>`;
    return;
  }

  const anyActive = Boolean(data.db?.active || data.artwork?.active || data.backups?.active);
  if (statusPill) {
    statusPill.textContent = anyActive ? "Optimizing…" : fmtSize(data.sizes?.totalBytes || 0);
    statusPill.className = `status-pill ${anyActive ? "status-pending" : "status-muted"}`;
  }

  const sizes = data.sizes || {};
  const activityLines = [];
  if (data.db?.active) {
    activityLines.push(`Databases: ${escapeHtml(data.db.label || "Compacting…")} (${Number(data.db.percent || 0)}%)`);
  } else if (data.db?.finishedAt && data.db.savedBytes > 0) {
    activityLines.push(`Last database compaction reclaimed ${fmtSize(data.db.savedBytes)}.`);
  }
  if (data.artwork?.active) {
    const progress = data.artwork.total > 0
      ? `${formatNumber(data.artwork.scanned)} / ${formatNumber(data.artwork.total)} images`
      : `${formatNumber(data.artwork.scanned)} images`;
    activityLines.push(`Artwork optimization running in background: ${progress} (${fmtSize(data.artwork.savedBytes)} saved).`);
  } else if (data.artwork?.finishedAt && data.artwork.savedBytes > 0) {
    activityLines.push(`Last artwork pass optimized ${formatNumber(data.artwork.optimized)} images (${fmtSize(data.artwork.savedBytes)} saved).`);
  }
  if (data.backups?.active) {
    activityLines.push("Recompressing legacy encrypted backups…");
  } else if (data.backups?.finishedAt && data.backups.recompressed > 0) {
    activityLines.push(`Recompressed ${formatNumber(data.backups.recompressed)} legacy backup${data.backups.recompressed === 1 ? "" : "s"} (${fmtSize(data.backups.savedBytes)} saved).`);
  }
  if (data.db?.error) activityLines.push(`Database error: ${escapeHtml(data.db.error)}`);
  if (data.artwork?.error) activityLines.push(`Artwork error: ${escapeHtml(data.artwork.error)}`);
  if (data.backups?.error) activityLines.push(`Backup error: ${escapeHtml(data.backups.error)}`);

  const legacyCount = Number(data.legacyBackups?.count || 0);
  const legacyBytes = Number(data.legacyBackups?.bytes || 0);
  const recompressButton = legacyCount > 0
    ? `<button id="storageRecompressBackupsButton" class="button-secondary sync-action-btn sync-tool-button" type="button" ${data.backups?.active ? "disabled" : ""}>Recompress ${formatNumber(legacyCount)} Legacy Backup${legacyCount === 1 ? "" : "s"} (${fmtSize(legacyBytes)})</button>`
    : "";

  panel.innerHTML = `
    <div class="cache-stats-grid">
      <div><span class="muted">Databases</span><strong>${fmtSize(sizes.databaseBytes)}</strong></div>
      <div><span class="muted">Shared Metadata</span><strong>${fmtSize(sizes.sharedMetadataBytes)}</strong></div>
      <div><span class="muted">Cached Artwork</span><strong>${fmtSize(sizes.mediaBytes)}</strong></div>
      <div><span class="muted">Logs</span><strong>${fmtSize(sizes.logsBytes)}</strong></div>
      <div><span class="muted">Backups</span><strong>${fmtSize(sizes.backupsBytes)}</strong></div>
      <div><span class="muted">Total</span><strong>${fmtSize(sizes.totalBytes)}</strong></div>
    </div>
    ${activityLines.length ? `<div class="muted" style="margin-top: 10px; font-size: 0.85rem; line-height: 1.5;">${activityLines.map((line) => `<div>${line}</div>`).join("")}</div>` : ""}
    <div class="settings-actions" style="margin-top: 12px;">
      <button id="storageRefreshButton" class="button-secondary sync-action-btn sync-tool-button" type="button">Refresh</button>
      <button id="storageCompactDbButton" class="button-primary sync-action-btn sync-tool-button" type="button" ${data.db?.active ? "disabled" : ""}>Compact Databases</button>
      <button id="storageOptimizeArtworkButton" class="button-secondary sync-action-btn sync-tool-button" type="button" ${data.artwork?.active ? "disabled" : ""}>Optimize Artwork</button>
      ${recompressButton}
    </div>
  `;

  document.getElementById("storageRefreshButton")?.addEventListener("click", () => {
    loadStorageStatus().catch((error) => _setMessage(error.message, "error"));
  });
  document.getElementById("storageCompactDbButton")?.addEventListener("click", () => {
    triggerStorageAction("/api/storage/compact-db", "Database compaction started.").catch((error) => _setMessage(error.message, "error"));
  });
  document.getElementById("storageOptimizeArtworkButton")?.addEventListener("click", () => {
    triggerStorageAction("/api/storage/optimize-artwork", "Artwork optimization started.").catch((error) => _setMessage(error.message, "error"));
  });
  document.getElementById("storageRecompressBackupsButton")?.addEventListener("click", () => {
    if (!data.legacyBackups?.hasStoredPassphrase) {
      _setMessage("Save your backup encryption passphrase under Settings → Backups before recompressing legacy backups.", "error");
      return;
    }
    _showConfirmModal(
      "Recompress Legacy Backups?",
      `This converts ${legacyCount} uncompressed full backup${legacyCount === 1 ? "" : "s"} (${fmtSize(legacyBytes)}) to the compressed v2 format. Older Plekt versions cannot restore compressed v2 backups.`,
      "Recompress",
      async () => {
        await triggerStorageAction("/api/storage/recompress-backups", "Legacy backup recompression started.");
      },
    );
  });

  if (anyActive) schedulePoll();
  else stopPolling();
}

async function triggerStorageAction(endpoint, successMessage) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Storage action failed");
  if (payload.status) {
    lastStatus = payload.status;
    renderStoragePanel(lastStatus);
  }
  _setMessage(successMessage, "success");
  schedulePoll();
}

export async function loadStorageStatus({ quiet = false } = {}) {
  const response = await fetch("/api/storage/status", { headers: authHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!quiet) throw new Error(payload.error || "Could not load storage status");
    return null;
  }
  lastStatus = payload;
  renderStoragePanel(payload);
  return payload;
}

export function initStorageTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  const details = document.getElementById("storageOptimizationDetails");
  if (details && !details.dataset.storageWired) {
    details.dataset.storageWired = "1";
    details.addEventListener("toggle", () => {
      if (details.open) {
        loadStorageStatus({ quiet: true }).catch(() => null);
      } else {
        stopPolling();
      }
    });
  }
}
