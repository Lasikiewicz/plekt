import { buildAuthHeaders } from "./auth.js?v=2.3.0.1.0";
import { state } from "./state.js?v=2.3.0.1.0";
import { escapeHtml, formatNumber } from "./utils.js?v=2.3.0.1.0";

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

function pillLabelFor(data) {
  const running = [];
  if (data.db?.active) running.push("Compacting DB…");
  if (data.backups?.active) running.push("Recompressing backups…");
  if (data.artwork?.active) running.push("Optimizing artwork…");
  if (running.length) return running.join(" · ");
  return fmtSize(data.sizes?.totalBytes || 0);
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
    statusPill.textContent = pillLabelFor(data);
    statusPill.className = `status-pill ${anyActive ? "status-pending" : "status-muted"}`;
  }

  const sizes = data.sizes || {};
  const breakdown = [
    { label: "Databases", bytes: Number(sizes.databaseBytes || 0) },
    { label: "Shared Metadata", bytes: Number(sizes.sharedMetadataBytes || 0) },
    { label: "Cached Artwork", bytes: Number(sizes.mediaBytes || 0) },
    { label: "Logs", bytes: Number(sizes.logsBytes || 0) },
    { label: "Backups", bytes: Number(sizes.backupsBytes || 0) },
    { label: "Total", bytes: Number(sizes.totalBytes || 0) },
  ];
  const maxCategoryBytes = Math.max(
    ...breakdown.slice(0, 5).map((item) => item.bytes),
    1,
  );

  const activityLines = [];
  if (data.db?.active) {
    activityLines.push(`Databases: ${escapeHtml(data.db.label || "Compacting…")} (${Number(data.db.percent || 0)}%)`);
  } else if (data.db?.finishedAt && data.db.savedBytes > 0) {
    activityLines.push(`Last database compaction reclaimed ${fmtSize(data.db.savedBytes)}.`);
  }
  if (data.backups?.active) {
    const fileNum = Number(data.backups.currentIndex || 0);
    const totalFiles = Number(data.backups.total || 0);
    const pct = Number(data.backups.currentPercent || 0);
    const progressPart = totalFiles > 0 && fileNum > 0
      ? `file ${formatNumber(fileNum)} / ${formatNumber(totalFiles)} (${pct}% of current file)`
      : "starting…";
    const savedPart = data.backups.savedBytes > 0 ? `, ${fmtSize(data.backups.savedBytes)} saved so far` : "";
    activityLines.push(`Recompressing legacy backups: ${progressPart}${savedPart}.`);
  } else if (data.backups?.finishedAt && data.backups.recompressed > 0) {
    activityLines.push(`Recompressed ${formatNumber(data.backups.recompressed)} legacy backup${data.backups.recompressed === 1 ? "" : "s"} (${fmtSize(data.backups.savedBytes)} saved).`);
  }
  if (data.artwork?.active) {
    const progress = data.artwork.total > 0
      ? `${formatNumber(data.artwork.scanned)} / ${formatNumber(data.artwork.total)} images`
      : `${formatNumber(data.artwork.scanned)} images`;
    activityLines.push(`Artwork optimization running in background: ${progress} (${fmtSize(data.artwork.savedBytes)} saved).`);
  } else if (data.artwork?.finishedAt && data.artwork.savedBytes > 0) {
    activityLines.push(`Last artwork pass optimized ${formatNumber(data.artwork.optimized)} images (${fmtSize(data.artwork.savedBytes)} saved).`);
  }
  if (data.db?.error) activityLines.push(`Database error: ${escapeHtml(data.db.error)}`);
  if (data.backups?.error) activityLines.push(`Backup error: ${escapeHtml(data.backups.error)}`);
  if (data.artwork?.error) activityLines.push(`Artwork error: ${escapeHtml(data.artwork.error)}`);

  const legacyCount = Number(data.legacyBackups?.count || 0);
  const legacyBytes = Number(data.legacyBackups?.bytes || 0);
  const recompressLabel = data.backups?.active
    ? "Recompressing Backups…"
    : `Recompress ${formatNumber(legacyCount)} Legacy Backup${legacyCount === 1 ? "" : "s"} (${fmtSize(legacyBytes)})`;
  const recompressButton = (legacyCount > 0 || data.backups?.active)
    ? `<button id="storageRecompressBackupsButton" class="button-ghost sync-action-btn sync-tool-button" type="button" ${data.backups?.active ? "disabled" : ""}>${recompressLabel}</button>`
    : "";

  panel.innerHTML = `
    <div class="cache-gauge-grid">
      ${breakdown.map((item) => {
        const pct = item.label === "Total"
          ? 100
          : Math.max(item.bytes > 0 ? 5 : 0, Math.round((item.bytes / maxCategoryBytes) * 100));
        return `
          <div class="cache-gauge-card">
            <div class="cache-gauge-meta">
              <span class="cache-gauge-title">${escapeHtml(item.label)}</span>
            </div>
            <div class="cache-gauge-size">${fmtSize(item.bytes)}</div>
            <div class="cache-gauge-bar"><div class="cache-gauge-fill" style="width:${pct}%;"></div></div>
          </div>
        `;
      }).join("")}
    </div>
    ${activityLines.length ? `<div class="muted" style="margin-top: 10px; font-size: 0.85rem; line-height: 1.5;">${activityLines.map((line) => `<div>${line}</div>`).join("")}</div>` : ""}
    <div class="settings-actions" style="margin-top: 12px;">
      <button id="storageRefreshButton" class="button-ghost sync-action-btn sync-tool-button" type="button">Refresh</button>
      <button id="storageCompactDbButton" class="button-primary sync-action-btn sync-tool-button" type="button" ${data.db?.active ? "disabled" : ""}>${data.db?.active ? "Compacting…" : "Compact Databases"}</button>
      <button id="storageOptimizeArtworkButton" class="button-ghost sync-action-btn sync-tool-button" type="button" ${data.artwork?.active ? "disabled" : ""}>${data.artwork?.active ? "Optimizing Artwork…" : "Optimize Artwork"}</button>
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
      `This converts ${legacyCount} uncompressed full backup${legacyCount === 1 ? "" : "s"} (${fmtSize(legacyBytes)}) to the compressed v2 format. Older Plekt versions cannot restore compressed v2 backups.`,
      () => {
        triggerStorageAction("/api/storage/recompress-backups", "Legacy backup recompression started.")
          .catch((error) => _setMessage(error.message, "error"));
      },
      { title: "Recompress Legacy Backups?", approveLabel: "Recompress" },
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
  const response = await fetch("/api/storage/status", { headers: authHeaders(), cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!quiet) throw new Error(payload.error || "Could not load storage status");
    return null;
  }
  lastStatus = payload;
  renderStoragePanel(payload);
  return payload;
}

function revealStorageDetails(details) {
  if (!details?.open || typeof details.getBoundingClientRect !== "function") return;
  const container = details.closest(".page-shell") || document.scrollingElement || document.documentElement;
  if (!container || typeof container.getBoundingClientRect !== "function") {
    details.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    return;
  }
  const isDoc = container === document.documentElement || container === document.body;
  const viewTop = isDoc ? 0 : container.getBoundingClientRect().top;
  const viewBottom = isDoc ? window.innerHeight : container.getBoundingClientRect().bottom;
  const rect = details.getBoundingClientRect();
  const pad = 16;
  if (rect.bottom > viewBottom - pad) {
    const maxDelta = Math.max(0, rect.top - (viewTop + pad));
    const needed = rect.bottom - (viewBottom - pad);
    const delta = Math.min(needed, maxDelta);
    if (delta > 0 && typeof container.scrollBy === "function") {
      container.scrollBy({ top: delta, behavior: "smooth" });
      return;
    }
  }
  if (rect.top < viewTop + pad || rect.bottom > viewBottom - pad) {
    details.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
}

export function initStorageTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  const details = document.getElementById("storageOptimizationDetails");
  if (details && !details.dataset.storageWired) {
    details.dataset.storageWired = "1";
    details.addEventListener("toggle", () => {
      if (details.open) {
        requestAnimationFrame(() => revealStorageDetails(details));
        loadStorageStatus({ quiet: true })
          .then(() => {
            if (details.open) requestAnimationFrame(() => revealStorageDetails(details));
          })
          .catch(() => null);
      } else {
        stopPolling();
      }
    });
  }
}
