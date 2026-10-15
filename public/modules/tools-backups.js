import { buildAuthHeaders } from "./auth.js?v=2.0.0.3.1";
import { state, elements } from "./state.js?v=2.0.0.3.1";
import { escapeHtml, escapeAttribute, formatNumber, formatDate } from "./utils.js?v=2.0.0.3.1";
import { openSettingsEditModal, openSettingsPickerModal, renderServiceCardGrid } from "./settings-ui.js?v=2.0.0.3.1";
import { applyAppearanceToBody } from "./appearance.js?v=2.0.0.3.1";

let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _showConfirmModal = () => {};
let _loadSavedConfig = async () => {};
let _loadHistory = async () => {};
let _loadActiveSessions = async () => {};
let _loadStats = async () => {};
let _clearDerivedUiCaches = () => {};

export function initBackupTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.loadActiveSessions) _loadActiveSessions = callbacks.loadActiveSessions;
  if (callbacks.loadStats) _loadStats = callbacks.loadStats;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

const BACKUP_BATCH_SIZE = 250;
const ENCRYPTED_BACKUP_FORMAT = "plekt-encrypted-backup";
const ENCRYPTED_BACKUP_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 250000;
const RESTORE_POLL_MS = 1000;
// ── Backup transfer state ──────────────────────────────────────────────────
export function setBackupTransferState(label, tone = "muted", log = "", area = "restore") {
  const status = area === "export" ? elements.backupExportStatus : elements.backupRestoreStatus;
  const output = area === "export" ? elements.backupExportLog : elements.backupRestoreLog;
  if (status) {
    status.textContent = label;
    status.className = `status-pill status-${tone}`;
  }
  if (log && output) {
    output.classList.remove("hidden");
    output.textContent = log;
    output.scrollTop = output.scrollHeight;
  }
}
// ── Backup export ──────────────────────────────────────────────────────────
function downloadJsonFile(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
function backupPassphrase(area = "restore") {
  const input = area === "export" ? elements.backupExportPassphrase : elements.backupRestorePassphrase;
  return String(input?.value || "").trim();
}
async function backupCryptoKey(passphrase, salt, iterations = BACKUP_KDF_ITERATIONS) {
  const cryptoApi = globalThis.crypto;
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptPlektBackup(backup, passphrase) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("This browser does not support encrypted backups.");
  if (passphrase.length < 12) throw new Error("Use an encryption passphrase of at least 12 characters.");
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await backupCryptoKey(passphrase, salt);
  const payload = new TextEncoder().encode(JSON.stringify(backup));
  const encrypted = new Uint8Array(await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    encryptedAt: new Date().toISOString(),
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: BACKUP_KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(encrypted),
  };
}
export async function exportPlektBackup() {
  const button = elements.backupExportButton;
  if (!button) return;
  const passphrase = backupPassphrase("export");
  button.disabled = true;
  button.textContent = "Exporting...";
  setBackupTransferState("Exporting", "warning", "Collecting Plekt data before browser-side encryption...", "export");
  try {
    if (passphrase.length < 12) throw new Error("Enter an encryption passphrase of at least 12 characters.");
    const manifestResponse = await fetch("/api/backup/export", { headers: authHeaders() });
    const manifest = await manifestResponse.json().catch(() => ({}));
    if (!manifestResponse.ok) throw new Error(manifest.error || `Backup manifest failed with ${manifestResponse.status}`);
    const collectionNames = Array.isArray(manifest.collections) ? manifest.collections : [];
    const backup = { ...manifest, source: { ...manifest.source, origin: window.location.origin }, collections: {} };
    let totalDocuments = 0;
    for (const collection of collectionNames) {
      const documents = [];
      let cursor = "";
      let hasMore = true;
      while (hasMore) {
        const params = new URLSearchParams({ collection, limit: String(BACKUP_BATCH_SIZE) });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/backup/export?${params}`, { headers: authHeaders() });
        const page = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(page.error || `${collection} export failed with ${response.status}`);
        documents.push(...(page.documents || []));
        cursor = page.nextCursor || "";
        hasMore = Boolean(page.hasMore && cursor);
        setBackupTransferState("Exporting", "warning", `Exporting ${collection}: ${formatNumber(documents.length)} documents\nTotal collected: ${formatNumber(totalDocuments + documents.length)}`, "export");
      }
      backup.collections[collection] = documents;
      totalDocuments += documents.length;
    }
    setBackupTransferState("Encrypting", "warning", `Encrypting ${formatNumber(totalDocuments)} documents in this browser...`, "export");
    const encryptedBackup = await encryptPlektBackup(backup, passphrase);
    downloadJsonFile(encryptedBackup, `plekt-backup-${new Date().toISOString().slice(0, 10)}.encrypted.json`);
    setBackupTransferState("Downloaded", "ready", `Encrypted backup downloaded: ${formatNumber(totalDocuments)} documents across ${formatNumber(collectionNames.length)} collections.\nKeep the passphrase separately. Plekt cannot recover it.`, "export");
    _setMessage("Encrypted Plekt backup downloaded.", "success");
  } catch (error) {
    setBackupTransferState("Failed", "error", `Backup failed: ${error.message}`, "export");
    _setMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Export Plekt Backup";
  }
}
// ── Full Plekt restore (runs on the server) ─────────────────────────────
// The server decrypts, checks and imports the file in small pieces, so a backup
// of any size restores; this page only uploads the file (when it is not already
// on the server), starts the restore and shows its progress.
export function selectPlektBackupFile(file) {
  state.backupImport = file ? { file, uploadId: "" } : null;
  if (!file) {
    setBackupTransferState("Idle", "muted", "[idle] Enter a passphrase, then choose an encrypted Plekt backup.", "restore");
    return;
  }
  setBackupTransferState("Ready", "ready", `${file.name} (${formatBytes(file.size)})\nThe file is uploaded and checked on the server when you restore it.`, "restore");
}
function confirmPlektRestore(label) {
  return _openConfirmDialog({
    title: "Restore Plekt backup?",
    body: `This replaces every collection included in ${label} with the backup's contents. Your current data is not backed up first; if you might want it back, make sure a recent backup is listed under Local Plekt Backups (or use Back Up Now) before you continue. Your local admin username and password stay unchanged. Nothing is changed until the whole file has been checked. Watch-history restores are safer for ordinary history rollback; use this for a full Plekt move or rebuild.`,
    confirmLabel: "Restore Plekt Backup",
    danger: true,
  });
}
// XMLHttpRequest rather than fetch so a large upload can show its progress.
function uploadPlektBackupFile(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/plembfin-backups/upload");
    for (const [name, value] of Object.entries(authHeaders())) {
      if (name !== "Content-Type") request.setRequestHeader(name, value);
    }
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setBackupTransferState("Uploading", "warning", `Uploading ${file.name}: ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`, "restore");
    };
    request.onload = () => {
      let body = {};
      try { body = JSON.parse(request.responseText || "{}"); } catch { body = {}; }
      if (request.status >= 200 && request.status < 300 && body.uploadId) resolve(body.uploadId);
      else reject(new Error(body.error || `Backup upload failed with ${request.status}`));
    };
    request.onerror = () => reject(new Error("Backup upload failed: the connection to the server was lost."));
    request.send(file);
  });
}
function plektRestoreLog(job) {
  if (job.status === "verifying") {
    return `Checking ${job.label}: ${formatBytes(job.bytesRead)} of ${formatBytes(job.totalBytes)} read\nNothing is changed until the whole file has been checked.`;
  }
  if (job.status === "importing") {
    const collection = job.collection
      ? `Importing ${job.collection}: ${formatNumber(job.collectionImported)} of ${formatNumber(job.collectionTotal)} documents\n`
      : "";
    return `${collection}Total imported: ${formatNumber(job.imported)} of ${formatNumber(job.totalDocuments)} documents (${formatNumber(job.collectionsDone)} of ${formatNumber(job.collectionsTotal)} collections done)`;
  }
  if (job.status === "complete") {
    return `Restore complete: ${formatNumber(job.imported)} documents across ${formatNumber(job.collectionsTotal)} collections.`;
  }
  return `Restore failed: ${job.error || "unknown error"}`;
}
async function showRestoreRecoveryOptions(options = []) {
  const listedOptions = options.length
    ? options.map((option, index) => `${index + 1}. ${option}`).join("\n\n")
    : "Cancel and preserve the current database, or preserve its database and sidecar files, start with a clean database, and retry the backup.";
  await _openConfirmDialog({
    title: "Database corruption detected",
    body: `Plekt checked the current SQLite database before importing. The integrity check failed, so this restore was not started and no data was changed.\n\nRecovery options:\n${listedOptions}`,
    confirmLabel: "Understood",
    cancelLabel: "Close",
  });
}
async function waitForPlektRestore(jobId) {
  let failures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS));
    let job;
    try {
      const response = await fetch("/api/plembfin-backups/restore", { headers: authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Restore status failed with ${response.status}`);
      job = body.job;
      failures = 0;
    } catch (error) {
      // The server is busy importing; a missed poll is not a failed restore.
      failures += 1;
      if (failures >= 30) throw new Error(`Lost track of the restore: ${error.message}`);
      continue;
    }
    if (!job || job.id !== jobId) throw new Error("The restore status was lost. Check the server log.");
    if (job.status === "verifying" || job.status === "importing") {
      setBackupTransferState(job.status === "verifying" ? "Checking" : "Importing", "warning", plektRestoreLog(job), "restore");
      continue;
    }
    return job;
  }
}
// Starts the server restore of a listed backup ({ filename }) or an upload
// ({ uploadId }), shows its progress and reloads the page's data when it is done.
async function runServerPlektRestore(target, passphrase) {
  const response = await fetch("/api/plembfin-backups/restore", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ ...target, passphrase }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.job) {
    if (body.code === "DATABASE_CORRUPT") await showRestoreRecoveryOptions(body.recoveryOptions);
    throw new Error(body.error || `Restore failed to start with ${response.status}`);
  }
  setBackupTransferState("Checking", "warning", plektRestoreLog(body.job), "restore");
  const job = await waitForPlektRestore(body.job.id);
  if (job.status !== "complete") throw new Error(job.error || "The restore failed.");
  _clearDerivedUiCaches();
  state.configLoaded = false;
  state.syncJobsLoaded = false;
  state.syncHistoryLoaded = false;
  await Promise.all([
    _loadSavedConfig(),
    _loadHistory({ force: true }),
    _loadActiveSessions(),
    _loadStats({ force: true }),
  ]);
  setBackupTransferState("Complete", "ready", plektRestoreLog(job), "restore");
  _setMessage("Plekt backup restored.", "success");
  return job;
}
export async function importPlektBackup() {
  const selected = state.backupImport;
  if (!selected?.file) return;
  const passphrase = backupPassphrase("restore");
  if (passphrase.length < 12) {
    _setMessage("Enter a restore passphrase of at least 12 characters.", "warning");
    return;
  }
  if (!(await confirmPlektRestore(selected.file.name))) return;
  const button = elements.backupImportButton;
  const input = elements.backupImportFile;
  button.disabled = true;
  input.disabled = true;
  button.textContent = "Restoring...";
  try {
    // A failed restore keeps the upload on the server for a day, so a retry
    // with the right passphrase does not upload the file again.
    if (!selected.uploadId) selected.uploadId = await uploadPlektBackupFile(selected.file);
    await runServerPlektRestore({ uploadId: selected.uploadId }, passphrase);
    selected.uploadId = "";
  } catch (error) {
    if (/Upload not found|Backup file not found|Invalid upload id/i.test(error.message)) selected.uploadId = "";
    setBackupTransferState("Failed", "error", `Restore failed: ${error.message}`, "restore");
    _setMessage(error.message, "error");
  } finally {
    input.disabled = false;
    button.disabled = !state.backupImport;
    button.textContent = "Restore Plekt Backup";
  }
}
// ── Watch-history backups ──────────────────────────────────────────────────
function watchBackupDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}
function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function setEnabledStatus(element, enabled, loading = false) {
  if (!element) return;
  if (loading) {
    element.textContent = "Loading";
    element.className = "status-pill status-warning";
    return;
  }
  element.textContent = enabled ? "Enabled" : "Disabled";
  element.className = `status-pill status-${enabled ? "ready" : "muted"}`;
}
// Restore lists show only the two newest backups; the rest live inside a
// collapsed disclosure so long histories don't dominate the page.
function collapseOlderRows(rows) {
  if (!rows.length) return "";
  return `<details class="backup-collapse"><summary>Show ${formatNumber(rows.length)} older backup${rows.length === 1 ? "" : "s"}</summary>${rows.join("")}</details>`;
}
export function renderWatchBackups() {
  if (!elements.watchBackupList) return;
  const data = state.watchBackups;
  if (!data) {
    setEnabledStatus(elements.watchBackupSummary, false, state.watchBackupsLoading);
    setEnabledStatus(elements.remoteWatchBackupSummary, false, state.watchBackupsLoading);
    setEnabledStatus(elements.backupDestinationSummary, false, state.watchBackupsLoading);
    const loadingCopy = `<div class="empty-log"><b>${state.watchBackupsLoading ? "Loading backups..." : "Backups not loaded"}</b><span>Watch-history backups and Plekt backups restore from separate sections.</span></div>`;
    elements.watchBackupList.innerHTML = loadingCopy;
    if (elements.remoteWatchBackupList) elements.remoteWatchBackupList.innerHTML = loadingCopy;
    return;
  }
  const config = data.config || {};
  const runtime = data.runtime || {};
  const files = Array.isArray(data.files) ? data.files : [];
  // Settings-side cards and restore-side lists both render every time: panels that are
  // not part of the current route stay hidden, and aggregated group routes show both.
  {
    elements.watchBackupEnabled && (elements.watchBackupEnabled.checked = Boolean(config.enabled));
    elements.watchBackupTime && (elements.watchBackupTime.value = config.time || "03:00");
    elements.watchBackupRetention && (elements.watchBackupRetention.value = String(config.retention || 7));
    elements.remoteWatchBackupEnabled && (elements.remoteWatchBackupEnabled.checked = Boolean(config.remoteEnabled));
    elements.remoteWatchBackupTime && (elements.remoteWatchBackupTime.value = config.remoteTime || "03:00");
    elements.remoteWatchBackupRetention && (elements.remoteWatchBackupRetention.value = String(config.remoteRetention || 7));
    setEnabledStatus(elements.watchBackupSummary, Boolean(config.enabled));
    setEnabledStatus(elements.remoteWatchBackupSummary, Boolean(config.remoteEnabled));
    const localPathEl = document.querySelector("#watchBackupLocalPath");
    if (localPathEl && data.backupsDir) localPathEl.textContent = data.backupsDir;
    if (elements.watchBackupRuntime) {
      // A failed restore keeps automated sync fenced until someone clears it, so show that here.
      const restoreSync = data.restoreSync || {};
      // A cleared restore also reports success false, but with a reason rather than an error.
      const restoreFailed = restoreSync.result?.success === false && Boolean(restoreSync.result.error);
      elements.watchBackupRuntime.innerHTML = `
        <div><span>Last successful backup</span><b>${escapeHtml(watchBackupDate(runtime.lastSuccessAt))}</b></div>
        <div class="backup-runtime-with-action">
          <span>Last restore</span>
          <b>${escapeHtml(watchBackupDate(runtime.lastRestoreAt))}</b>
          ${runtime.lastRestoreAt || restoreFailed ? `<button class="button-ghost" type="button" data-clear-restore-status>Clear Status</button>` : ""}
        </div>
        ${restoreSync.active ? `<p class="backup-runtime-error">A watch-history restore is running. Automated sync writes wait until it finishes.</p>` : ""}
        ${restoreFailed ? `<p class="backup-runtime-error">The last watch-history restore failed: ${escapeHtml(restoreSync.result.error || "unknown error")}. Automated sync writes stay paused until you clear this status.</p>` : ""}
        <div><span>Storage</span><b>${formatNumber(files.length)} file${files.length === 1 ? "" : "s"}</b></div>
        ${runtime.lastError ? `<p class="backup-runtime-error">${escapeHtml(runtime.lastError)}</p>` : ""}
      `;
    }
    renderBackupDestinationCards();
    renderRemoteWatchBackupRuntime(data);
  }
  const localEntries = files.map((f) => ({ ...f, source: "local", destId: null, destLabel: "Local" }));
  const remoteEntries = (state.remoteBackupFiles || []);
  const sortNewest = (entries) => [...entries].sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
  const cronPausedUntil = runtime.cronSyncPausedUntil;
  const cronPausedBanner = cronPausedUntil && Date.now() < cronPausedUntil
    ? `<div class="backup-runtime" style="margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); background: rgba(255,165,0,0.08);">
        <span style="font-size: 0.85rem;">Cron sync is paused until ${escapeHtml(new Date(cronPausedUntil).toLocaleTimeString())} while restore work settles.</span>
       </div>`
    : "";
  let remoteLoading = "";
  if (state.remoteBackupFilesLoading) {
    const destNames = Array.isArray(state.watchBackups?.destinations)
      ? state.watchBackups.destinations.map((d) => d.label || d.type).filter(Boolean)
      : [];
    const destText = destNames.length ? ` (${destNames.map(escapeHtml).join(", ")})` : "";
    remoteLoading = `<div class="remote-search-banner"><span class="remote-search-spinner"></span><span>Searching remote destinations${destText} for backups…</span></div>`;
  }
  const clearMode = state.restoreClearMode || "wipe";
  const clearModeSelector = `
    <div class="restore-clear-mode" style="margin-bottom: var(--space-3);">
      <div class="restore-clear-intro">Watch-history restore pushes the selected backup's watched history to every connected app. Choose whether to merge it into each app's existing state or replace that state completely:</div>
      <label>
        <input type="radio" name="restoreClearMode" value="reconcile" ${clearMode === "reconcile" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Merge into existing state</b> - adds this backup's watched items to each app without touching anything else. Faster, but watched items the apps have that this backup does not know about are left as they are.</span>
      </label>
      <label>
        <input type="radio" name="restoreClearMode" value="wipe" ${clearMode === "wipe" ? "checked" : ""} data-restore-clear-mode>
        <span><b>Replace existing state</b> - marks every watched item in each app as unwatched, then re-applies only this backup's watched set, so each app ends up matching the backup exactly. Slower, but this is a true restore.</span>
      </label>
    </div>`;
  const entryRow = (entry) => `
    <article class="watch-backup-row">
      <div class="watch-backup-copy">
        <b>${escapeHtml(entry.name)}</b>
        <span>
          ${escapeHtml(watchBackupDate(entry.createdAt))} · ${escapeHtml(formatBytes(entry.sizeBytes))}
          <span class="status-pill status-muted" style="font-size: 0.7rem; padding: 1px 6px; margin-left: 4px;">${escapeHtml(entry.destLabel || "Local")}</span>
        </span>
      </div>
      <div class="watch-backup-actions">
        ${entry.source === "local" ? `
          <button class="button-ghost" type="button" data-watch-backup-download="${escapeAttribute(entry.name)}">Download</button>
          <button class="button-ghost" type="button" data-watch-backup-dry-run="${escapeAttribute(entry.name)}">Validate</button>` : ""}
        <button class="button-primary" type="button"
          data-watch-backup-restore="${escapeAttribute(entry.name)}"
          ${entry.destId ? `data-restore-dest-id="${escapeAttribute(entry.destId)}"` : ""}>
          Restore Watch History
        </button>
      </div>
    </article>
  `;
  const renderEntries = (entries, emptyCopy) => {
    const sorted = sortNewest(entries);
    if (!sorted.length) return emptyCopy;
    const rows = sorted.map(entryRow);
    return rows.slice(0, 2).join("") + collapseOlderRows(rows.slice(2));
  };
  const localEmpty = `<div class="empty-log"><b>No local watch-history backups</b><span>Use Back Up Now on the Backups tab or add a .json.gz file from your computer.</span></div>`;
  const remoteEmpty = state.remoteBackupFilesLoading
    ? ""
    : `<div class="empty-log"><b>No remote watch-history backups</b><span>Configure a remote destination on the Backups tab, then create a watch-history backup.</span></div>`;
  elements.watchBackupList.innerHTML = cronPausedBanner + (localEntries.length ? clearModeSelector : "") + renderEntries(localEntries, localEmpty);
  if (elements.remoteWatchBackupList) {
    elements.remoteWatchBackupList.innerHTML = remoteLoading + (remoteEntries.length ? clearModeSelector : "") + renderEntries(remoteEntries, remoteEmpty);
  }
}
// Runtime readout for the Remote Watch History Backups card on the Backups tab:
// the same sections as the local card, plus a per-destination status row each.
function renderRemoteWatchBackupRuntime(data) {
  if (!elements.watchBackupRemoteRuntime) return;
  const destinations = Array.isArray(data.destinations) ? data.destinations : [];
  if (!destinations.length) {
    elements.watchBackupRemoteRuntime.innerHTML = `<div><span>Status</span><b>No remote destinations configured</b></div>`;
    return;
  }
  const statusMap = data.runtime?.destinations || {};
  const lastSuccessAt = Math.max(0, ...destinations.map((destination) => Number(statusMap[destination.id]?.lastSuccessAt || 0)));
  const remoteFiles = Array.isArray(state.remoteBackupFiles) ? state.remoteBackupFiles : [];
  const storage = state.remoteBackupFilesLoading
    ? "Checking destinations..."
    : `${formatNumber(remoteFiles.length)} file${remoteFiles.length === 1 ? "" : "s"}`;
  const destinationRows = destinations.map((destination) => {
    const status = statusMap[destination.id] || {};
    const label = destination.label || destination.type || "Remote";
    if (!destination.enabled) {
      return `<div><span>${escapeHtml(label)}</span><b>Disabled</b></div>`;
    }
    if (!status.lastAttemptAt) {
      return `<div><span>${escapeHtml(label)}</span><b>Never synced</b></div>`;
    }
    if (status.status === "error") {
      return `
        <div><span>${escapeHtml(label)}</span><b style="color: var(--red);">Last upload failed</b></div>
        <p class="backup-runtime-error">${escapeHtml(status.lastError || "Unknown error")}</p>
      `;
    }
    return `<div><span>${escapeHtml(label)}</span><b>Last mirrored ${escapeHtml(watchBackupDate(status.lastSuccessAt))}</b></div>`;
  }).join("");
  elements.watchBackupRemoteRuntime.innerHTML = `
    <div class="backup-runtime-remote-grid">
    <div><span>Last successful backup</span><b>${escapeHtml(watchBackupDate(lastSuccessAt || 0))}</b></div>
    <div><span>Last restore</span><b>${escapeHtml(watchBackupDate(data.runtime?.lastRestoreAt))}</b></div>
    <div><span>Storage</span><b>${escapeHtml(storage)}</b></div>
    ${destinationRows}
    </div>
  `;
}
export async function loadRemoteBackupsForRestoreTab() {
  const data = state.watchBackups;
  if (!data) return;
  const destinations = Array.isArray(data.destinations) ? data.destinations : [];
  if (!destinations.length) return;
  state.remoteBackupFilesLoading = true;
  state.remoteBackupFiles = [];
  renderWatchBackups();
  const results = await Promise.allSettled(
    destinations.map(async (dest) => {
      try {
        const result = await postWatchBackupAction({ action: "list-remote-backups", destinationId: dest.id });
        const files = Array.isArray(result.files) ? result.files : [];
        return files.map((f) => ({ ...f, source: "remote", destId: dest.id, destLabel: dest.label || dest.type || "Remote" }));
      } catch {
        return [];
      }
    })
  );
  state.remoteBackupFiles = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  state.remoteBackupFilesLoading = false;
  renderWatchBackups();
}
const DESTINATION_FORMS = {
  backblaze: {
    label: "Backblaze B2",
    description: "Mirror backups to a Backblaze B2 bucket",
    settings: [
      { key: "region", label: "Region or endpoint", placeholder: "eu-central-003", help: "A region name or full S3 endpoint is accepted." },
      { key: "bucket", label: "Bucket name", placeholder: "yourname-plekt" },
      { key: "accessKeyId", label: "Key ID", placeholder: "0035..." },
      { key: "prefix", label: "Key prefix", placeholder: "plekt/", optional: true, help: "Optional folder-like prefix within the bucket." },
    ],
    secrets: [{ key: "secretAccessKey", label: "Application key", placeholder: "Backblaze application key" }],
    helpHtml: `
      <p class="tool-accordion-desc">Plekt needs a private B2 bucket and an application key that can read and write it. No Backblaze account yet? <a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener noreferrer">Sign up for B2 Cloud Storage</a> (the first 10 GB are free).</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li>Open <a href="https://secure.backblaze.com/b2_buckets.htm" target="_blank" rel="noopener noreferrer">Buckets</a> and choose <b>Create a Bucket</b>. Keep files <b>Private</b> and enter the name under <b>Bucket name</b>.</li>
        <li>On the bucket's card, copy the <b>Endpoint</b> (for example <code>s3.eu-central-003.backblazeb2.com</code>) into <b>Region or endpoint</b>. The region alone (<code>eu-central-003</code>) also works.</li>
        <li>Open <a href="https://secure.backblaze.com/app_keys.htm" target="_blank" rel="noopener noreferrer">Application Keys</a> and choose <b>Add a New Application Key</b>. Allow access to this bucket only, with <b>Read and Write</b> access.</li>
        <li>Copy the <b>keyID</b> into <b>Key ID</b> and the <b>applicationKey</b> into <b>Application key</b>. Backblaze shows the application key only once.</li>
        <li>Choose <b>Test</b>, then tick <b>Enable</b> and save.</li>
      </ol>
      <p class="tool-accordion-desc"><b>Tip:</b> B2 keeps old versions of a deleted file by default, so backups removed by retention still use space. In the bucket's <b>Lifecycle Settings</b>, choose <b>Keep only the last version of the file</b>. If the bucket is shared, use a custom rule scoped to the Plekt prefix. <a href="https://www.backblaze.com/docs/cloud-storage-configure-and-manage-lifecycle-rules" target="_blank" rel="noopener noreferrer">Backblaze lifecycle rule instructions</a>.</p>
      <p class="tool-accordion-desc">Plekt stores the application key securely and never sends it back to the browser. More detail: <a href="https://www.backblaze.com/docs/cloud-storage-s3-compatible-api" target="_blank" rel="noopener noreferrer">Backblaze S3-compatible API</a>.</p>
    `,
  },
};
function destinationBadges(destination, status) {
  const badges = [{ label: destination.enabled ? "Enabled" : "Disabled", tone: destination.enabled ? "ready" : "muted" }];
  if (status?.status === "success") badges.push({ label: "Connected", tone: "ready" });
  else if (status?.status === "error") badges.push({ label: "Last run failed", tone: "danger" });
  else badges.push({ label: "Not tested", tone: "warning" });
  return badges;
}

function destinationFields(destination, form) {
  return [
    { key: "label", label: "Name", value: destination.label || form.label, help: "A recognizable name for this backup target." },
    { key: "enabled", label: "Enable", type: "checkbox", value: Boolean(destination.enabled) },
    ...form.settings.map((field) => ({ ...field, value: destination.settings?.[field.key] || "" })),
    ...form.secrets.map((field) => ({
      ...field,
      type: "password",
      secret: true,
      configured: Boolean(destination.secretFlags?.[field.key]),
      configuredPlaceholder: `Configured - enter a new ${field.label.toLowerCase()} to replace it`,
    })),
  ];
}

function destinationFromValues(destination, form, values) {
  const settings = Object.fromEntries(form.settings.map((field) => [field.key, values[field.key]]));
  const secrets = {};
  for (const field of form.secrets) {
    if (values[field.key]) secrets[field.key] = values[field.key];
  }
  return {
    ...(destination.id ? { id: destination.id } : {}),
    type: destination.type,
    label: values.label || form.label,
    enabled: Boolean(values.enabled),
    settings,
    secrets,
  };
}

async function refreshBackupDestinations() {
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
}

async function saveDestinationValues(destination, form, values) {
  const body = await postWatchBackupAction({
    action: "save-destination",
    destination: destinationFromValues(destination, form, values),
  });
  if (body.destination) Object.assign(destination, body.destination);
  return body.destination;
}

export function openBackupDestinationModal(destination = {}) {
  const type = destination.type || "backblaze";
  const form = DESTINATION_FORMS[type];
  if (!form) throw new Error(`Unsupported destination type: ${type}`);
  const target = { type, settings: {}, secretFlags: {}, ...destination };
  openSettingsEditModal({
    title: target.id ? `Edit ${target.label || form.label}` : `Add ${form.label}`,
    fields: destinationFields(target, form),
    enabledKey: "enabled",
    saveDisabledLabel: "Save & disable",
    helpHtml: form.helpHtml,
    onSave: async (values) => {
      await saveDestinationValues(target, form, values);
      await refreshBackupDestinations();
      _setMessage("Backup destination saved.", "success");
    },
    onTest: async (values) => {
      const saved = await saveDestinationValues(target, form, values);
      const result = await postWatchBackupAction({ action: "test-destination", destinationId: saved.id });
      await refreshBackupDestinations();
      return `Connection OK - ${result.result?.detail || "reachable"}.`;
    },
    onDelete: target.id ? async () => {
      const approved = await _openConfirmDialog({
        title: "Remove destination?",
        body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!approved) return false;
      await postWatchBackupAction({ action: "remove-destination", destinationId: target.id });
      await refreshBackupDestinations();
      _setMessage("Destination removed.", "success");
    } : undefined,
  });
}

function openBackupDestinationPicker() {
  openSettingsPickerModal({
    title: "Add Backup Destination",
    intro: "Choose where Plekt should mirror scheduled backups.",
    items: Object.entries(DESTINATION_FORMS).map(([id, form]) => ({ id, name: form.label, description: form.description })),
    onPick: (type) => openBackupDestinationModal({ type }),
  });
}

export function renderBackupDestinationCards() {
  const destinations = Array.isArray(state.watchBackups?.destinations) ? state.watchBackups.destinations : [];
  const statusMap = state.watchBackups?.runtime?.destinations || {};
  setEnabledStatus(elements.backupDestinationSummary, destinations.some((destination) => destination.enabled));
  renderServiceCardGrid(elements.backupDestinationCards, {
    items: destinations.map((destination) => ({
      id: destination.id,
      name: destination.label || DESTINATION_FORMS[destination.type]?.label || destination.type,
      description: DESTINATION_FORMS[destination.type]?.description || "Remote backup destination",
      badges: destinationBadges(destination, statusMap[destination.id]),
    })),
    onSelect: (id) => openBackupDestinationModal(destinations.find((destination) => destination.id === id)),
    onAdd: openBackupDestinationPicker,
    addLabel: "Add backup destination",
    addVisibleLabel: "Click to add a remote destination",
  });
}
export async function restoreRemoteBackupFromCard(card, filename, clearMode = "wipe") {
  const wipe = clearMode === "wipe";
  const approved = await _openConfirmDialog({
    title: "Restore watch history?",
    body: `⚠️ AUTHORITATIVE RESTORE - this backup becomes the source of truth.\n\nWill DELETE all current watch history, playstate and resume progress, restore from:\n\n${filename}\n\nand push that state to every connected app.\n\n${wipe
      ? "Clear mode: FULL WIPE - every currently-watched item on each app is first marked unwatched."
      : "Clear mode: RECONCILE - only items tracked by the backup are pushed."}\n\nThis cannot be undone.`,
    confirmLabel: wipe ? "Wipe Apps and Restore" : "Restore and Push",
    danger: true,
  });
  if (!approved) return;
  await runAuthoritativeRestore({ action: "restore-remote-backup", destinationId: card.dataset.destId, filename, clearMode });
}
export async function loadWatchBackups({ force = false } = {}) {
  if (!state.token || state.watchBackupsLoading || (state.watchBackups && !force)) return state.watchBackups;
  state.watchBackupsLoading = true;
  renderWatchBackups();
  try {
    const response = await fetch("/api/watch-backups", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Backup status failed with ${response.status}`);
    state.watchBackups = body;
    return body;
  } finally {
    state.watchBackupsLoading = false;
    renderWatchBackups();
  }
}
export async function postWatchBackupAction(payload) {
  const response = await fetch("/api/watch-backups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backup action failed with ${response.status}`);
  return body;
}
export async function loadPlektBackups({ force = false } = {}) {
  if (!state.token || state.plektBackupsLoading || (state.plektBackups && !force)) return state.plektBackups;
  state.plektBackupsLoading = true;
  renderPlektBackups();
  try {
    const response = await fetch("/api/plembfin-backups", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Plekt backup status failed with ${response.status}`);
    state.plektBackups = body;
    return body;
  } finally {
    state.plektBackupsLoading = false;
    renderPlektBackups();
  }
}
export async function postPlektBackupAction(payload) {
  const response = await fetch("/api/plembfin-backups", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Plekt backup action failed with ${response.status}`);
  return body;
}
export function updatePlektButtonsState() {
  const config = state.plektBackups?.config || {};
  const passphrase = elements.backupExportPassphrase?.value.trim() || "";
  const remember = Boolean(elements.backupExportRememberPassphrase?.checked);
  const hasStoredPassphrase = Boolean(config.passphraseStored);
  const hasLocalPassphrase = passphrase.length >= 12 || (remember && hasStoredPassphrase);
  const localScheduleEnabled = Boolean(elements.plektBackupEnabled?.checked);
  if (elements.savePlektBackupConfigButton) {
    elements.savePlektBackupConfigButton.disabled = localScheduleEnabled && (!remember || !hasLocalPassphrase);
  }
  if (elements.createPlektBackupButton) elements.createPlektBackupButton.disabled = !hasLocalPassphrase && passphrase.length < 12;

  const remotePassphrase = elements.plektBackupRemotePassphrase?.value.trim() || "";
  const remoteRemember = Boolean(elements.plektBackupRemoteRememberPassphrase?.checked);
  const hasStoredRemotePassphrase = Boolean(config.remotePassphraseStored);
  const hasRemotePassphrase = remotePassphrase.length >= 12 || (remoteRemember && hasStoredRemotePassphrase);
  const remoteScheduleEnabled = Boolean(elements.plektBackupRemoteEnabled?.checked);
  if (elements.savePlektBackupRemoteButton) {
    elements.savePlektBackupRemoteButton.disabled = remoteScheduleEnabled && !hasLocalPassphrase && (!remoteRemember || !hasRemotePassphrase);
  }
  if (elements.createPlektBackupRemoteButton) {
    const canBackUpRemoteNow = remotePassphrase.length >= 12 || hasStoredRemotePassphrase || hasStoredPassphrase || hasLocalPassphrase;
    elements.createPlektBackupRemoteButton.disabled = !canBackUpRemoteNow;
  }
}
export function renderPlektBackups() {
  if (!elements.plektBackupList) return;
  const data = state.plektBackups;
  if (!data) {
    setEnabledStatus(elements.plektBackupSummary, false, state.plektBackupsLoading);
    setEnabledStatus(elements.plektBackupRemoteSummary, false, state.plektBackupsLoading);
    const loadingCopy = `<div class="empty-log"><b>${state.plektBackupsLoading ? "Loading backups..." : "Backups not loaded"}</b><span>Watch-history backups and Plekt backups restore from separate sections.</span></div>`;
    elements.plektBackupList.innerHTML = loadingCopy;
    return;
  }
  const config = data.config || {};
  const runtime = data.runtime || {};
  const files = Array.isArray(data.files) ? data.files : [];
  
  elements.plektBackupEnabled && (elements.plektBackupEnabled.checked = Boolean(config.enabled));
  elements.plektBackupTime && (elements.plektBackupTime.value = config.time || "03:00");
  elements.plektBackupRetention && (elements.plektBackupRetention.value = String(config.retention || 7));
  if (elements.backupExportRememberPassphrase) {
    elements.backupExportRememberPassphrase.checked = Boolean(config.rememberPassphrase || config.passphraseStored);
  }
  if (elements.backupExportPassphrase) {
    elements.backupExportPassphrase.placeholder = config.passphraseStored ? "Saved - leave blank to keep" : "";
  }

  elements.plektBackupRemoteEnabled && (elements.plektBackupRemoteEnabled.checked = Boolean(config.remoteEnabled));
  elements.plektBackupRemoteRetention && (elements.plektBackupRemoteRetention.value = String(config.remoteRetention || config.retention || 7));
  if (elements.plektBackupRemoteRememberPassphrase) {
    elements.plektBackupRemoteRememberPassphrase.checked = Boolean(config.remoteRememberPassphrase || config.remotePassphraseStored);
  }
  if (elements.plektBackupRemotePassphrase) {
    elements.plektBackupRemotePassphrase.placeholder = config.remotePassphraseStored ? "Saved - leave blank to keep" : "";
  }
  
  setEnabledStatus(elements.plektBackupSummary, Boolean(config.enabled));
  setEnabledStatus(elements.plektBackupRemoteSummary, Boolean(config.remoteEnabled));
  
  if (elements.plektBackupRuntime) {
    elements.plektBackupRuntime.innerHTML = `
      <div><span>Last successful backup</span><b>${escapeHtml(watchBackupDate(runtime.lastSuccessAt))}</b></div>
      <div class="backup-runtime-with-action">
        <span>Last restore</span>
        <b>${escapeHtml(watchBackupDate(runtime.lastRestoreAt))}</b>
      </div>
      <div><span>Storage</span><b>${formatNumber(files.length)} file${files.length === 1 ? "" : "s"}</b></div>
      ${runtime.lastError ? `<p class="backup-runtime-error">${escapeHtml(runtime.lastError)}</p>` : ""}
    `;
  }

  if (elements.plektBackupRemoteRuntime) {
    let remoteHtml = "";
    if (runtime.lastRemoteAttemptAt) {
      if (!runtime.lastRemoteError) {
        remoteHtml = `
          <div><span>Last successful sync</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteSuccessAt))}</b></div>
          <div><span>Last attempt</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteAttemptAt))} (Success)</b></div>
          <div><span>Status</span><b>Connected</b></div>
        `;
      } else {
        remoteHtml = `
          <div><span>Last successful sync</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteSuccessAt))}</b></div>
          <div><span>Last attempt</span><b>${escapeHtml(watchBackupDate(runtime.lastRemoteAttemptAt))} (Error)</b></div>
          <div><span>Status</span><b style="color: var(--red);">Not connected</b></div>
          <p class="backup-runtime-error">${escapeHtml(runtime.lastRemoteError)}</p>
        `;
      }
    } else {
      remoteHtml = `
        <div><span>Last successful sync</span><b>Never</b></div>
        <div><span>Last attempt</span><b>Never</b></div>
        <div><span>Status</span><b>Not connected</b></div>
      `;
    }
    elements.plektBackupRemoteRuntime.innerHTML = remoteHtml;
  }
  
  const plektRows = files.map((file) => `
    <article class="watch-backup-row">
      <div class="watch-backup-copy">
        <b>${escapeHtml(file.name)}</b>
        <span>${escapeHtml(watchBackupDate(file.createdAt))} · ${escapeHtml(formatBytes(file.sizeBytes))}</span>
      </div>
      <div class="watch-backup-actions">
        <button class="button-ghost" type="button" data-plekt-backup-download="${escapeAttribute(file.name)}">Download</button>
        <button class="button-primary" type="button" data-plekt-backup-restore="${escapeAttribute(file.name)}">Restore</button>
        <button class="button-ghost" type="button" data-plekt-backup-delete="${escapeAttribute(file.name)}">Delete</button>
      </div>
    </article>
  `);
  elements.plektBackupList.innerHTML = plektRows.length
    ? plektRows.slice(0, 2).join("") + collapseOlderRows(plektRows.slice(2))
    : `<div class="empty-log"><b>No scheduled Plekt backups yet</b><span>Use Back Up Now or enable the daily schedule.</span></div>`;

  if (elements.remotePlektBackupList) {
    const remoteFiles = Array.isArray(state.remotePlektBackupFiles) ? state.remotePlektBackupFiles : [];
    const remoteSorted = [...remoteFiles].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const remoteRows = remoteSorted.map((file) => `
      <article class="watch-backup-row">
        <div class="watch-backup-copy">
          <b>${escapeHtml(file.name)}</b>
          <span>
            ${escapeHtml(watchBackupDate(file.createdAt))} · ${escapeHtml(formatBytes(file.sizeBytes))}
            <span class="status-pill status-muted" style="font-size: 0.7rem; padding: 1px 6px; margin-left: 4px;">${escapeHtml(file.destLabel || "Remote")}</span>
          </span>
        </div>
        <div class="watch-backup-actions">
          <button class="button-primary" type="button" data-plekt-remote-backup-restore="${escapeAttribute(file.name)}" data-restore-dest-id="${escapeAttribute(file.destId)}">Restore</button>
        </div>
      </article>
    `);
    if (state.remotePlektBackupFilesLoading) {
      elements.remotePlektBackupList.innerHTML = `<div class="empty-log"><b>Checking remote destinations...</b></div>`;
    } else {
      elements.remotePlektBackupList.innerHTML = remoteRows.length
        ? remoteRows.slice(0, 2).join("") + collapseOlderRows(remoteRows.slice(2))
        : `<div class="empty-log"><b>No remote Plekt backups</b><span>Configure a remote destination on the Backups tab, then create a Plekt backup with remote mirroring on.</span></div>`;
    }
  }

  updatePlektButtonsState();
}
export async function savePlektBackupSettings() {
  const rememberPassphrase = Boolean(elements.backupExportRememberPassphrase?.checked);
  const config = {
    ...state.plektBackups?.config,
    enabled: elements.plektBackupEnabled.checked,
    time: elements.plektBackupTime.value || "03:00",
    retention: Number(elements.plektBackupRetention.value) || 7,
    rememberPassphrase,
    passphrase: rememberPassphrase ? elements.backupExportPassphrase.value.trim() : "",
  };
  await postPlektBackupAction({ action: "configure", config });
  state.plektBackups = null;
  await loadPlektBackups({ force: true });
  flashButtonSuccess(elements.savePlektBackupConfigButton);
}
export async function savePlektBackupRemoteSettings() {
  const remoteRememberPassphrase = Boolean(elements.plektBackupRemoteRememberPassphrase?.checked);
  const config = {
    ...state.plektBackups?.config,
    remoteEnabled: elements.plektBackupRemoteEnabled.checked,
    remoteRetention: Number(elements.plektBackupRemoteRetention.value) || 7,
    remoteRememberPassphrase,
    remotePassphrase: remoteRememberPassphrase ? elements.plektBackupRemotePassphrase.value.trim() : "",
  };
  await postPlektBackupAction({ action: "configure", config });
  state.plektBackups = null;
  await loadPlektBackups({ force: true });
  flashButtonSuccess(elements.savePlektBackupRemoteButton);
}
export async function createPlektBackupNow() {
  const button = elements.createPlektBackupButton;
  button.disabled = true;
  button.textContent = "Backing up...";
  toggleBackupProgress(elements.plektBackupProgress, true);
  try {
    const result = await postPlektBackupAction({
      action: "create",
      passphrase: elements.backupExportPassphrase.value.trim()
    });
    state.plektBackups = null;
    await loadPlektBackups({ force: true });
    _setMessage(`Created ${result.backup?.name || "Plekt backup"}.`, "success");
  } finally {
    toggleBackupProgress(elements.plektBackupProgress, false);
    button.disabled = false;
    button.textContent = "Back Up Now";
    updatePlektButtonsState();
  }
}
export async function createPlektBackupRemoteNow() {
  const button = elements.createPlektBackupRemoteButton;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Backing up...";
  toggleBackupProgress(elements.plektBackupRemoteProgress, true);
  try {
    const result = await postPlektBackupAction({
      action: "create",
      remote: true,
      passphrase: elements.plektBackupRemotePassphrase?.value.trim() || "",
    });
    state.plektBackups = null;
    await loadPlektBackups({ force: true });
    const remotes = Array.isArray(result.backup?.remotes) ? result.backup.remotes : [];
    const failed = remotes.filter((remote) => remote.status === "error");
    if (!remotes.length) {
      _setMessage("Backup created, but there are no enabled remote destinations to upload it to.", "error");
    } else if (failed.length) {
      _setMessage(`Backup created, but ${failed.length} remote upload${failed.length === 1 ? "" : "s"} failed: ${failed[0].lastError || "unknown error"}`, "error");
    } else {
      _setMessage(`Created ${result.backup?.name || "Plekt backup"} and uploaded it to ${remotes.length} remote destination${remotes.length === 1 ? "" : "s"}.`, "success");
    }
  } finally {
    toggleBackupProgress(elements.plektBackupRemoteProgress, false);
    button.disabled = false;
    button.textContent = "Back Up Now";
    updatePlektButtonsState();
  }
}
export async function downloadPlektBackup(filename) {
  const response = await fetch(`/api/plembfin-backups?download=${encodeURIComponent(filename)}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Backup download failed with ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
export async function deletePlektBackupFile(filename) {
  const approved = await _openConfirmDialog({
    title: "Delete Plekt backup?",
    body: `Are you sure you want to permanently delete the backup file ${filename} from the server?`,
    confirmLabel: "Delete Backup",
    danger: true,
  });
  if (!approved) return;
  await postPlektBackupAction({ action: "delete", filename });
  state.plektBackups = null;
  await loadPlektBackups({ force: true });
  _setMessage("Backup deleted successfully.", "success");
}
export async function restorePlektBackupFromServer(filename, passphraseOverride) {
  const passphrase = passphraseOverride || elements.backupRestorePassphrase?.value.trim() || "";
  if (passphrase.length < 12) {
    throw new Error("Enter a restore passphrase of at least 12 characters.");
  }
  if (!(await confirmPlektRestore(filename))) return;
  try {
    await runServerPlektRestore({ filename }, passphrase);
  } catch (error) {
    setBackupTransferState("Failed", "error", `Restore failed: ${error.message}`, "restore");
    _setMessage(error.message, "error");
  }
}
// Pulls an encrypted Plekt backup mirrored to a remote destination into local
// storage, then restores it on the server like any listed local backup.
export async function restoreRemotePlektBackup(destinationId, filename) {
  const passphrase = elements.backupRestoreRemotePassphrase?.value.trim() || "";
  if (passphrase.length < 12) {
    _setMessage("Enter a restore passphrase of at least 12 characters.", "warning");
    return;
  }
  if (!(await confirmPlektRestore(filename))) return;
  setBackupTransferState("Downloading", "warning", `Downloading ${filename} from remote destination...`, "restore");
  try {
    const { pulled } = await postPlektBackupAction({ action: "pull-remote-backup", destinationId, filename });
    await loadPlektBackups({ force: true });
    await runServerPlektRestore({ filename: pulled.name }, passphrase);
  } catch (error) {
    setBackupTransferState("Failed", "error", `Restore failed: ${error.message}`, "restore");
    _setMessage(error.message, "error");
  }
}
export async function loadRemotePlektBackupsForRestoreTab() {
  const data = state.watchBackups;
  if (!data) return;
  const destinations = Array.isArray(data.destinations) ? data.destinations : [];
  if (!destinations.length) return;
  state.remotePlektBackupFilesLoading = true;
  state.remotePlektBackupFiles = [];
  renderPlektBackups();
  const results = await Promise.allSettled(
    destinations.map(async (dest) => {
      try {
        const result = await postPlektBackupAction({ action: "list-remote-backups", destinationId: dest.id });
        const files = Array.isArray(result.files) ? result.files : [];
        return files.map((f) => ({ ...f, source: "remote", destId: dest.id, destLabel: dest.label || dest.type || "Remote" }));
      } catch {
        return [];
      }
    })
  );
  state.remotePlektBackupFiles = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  state.remotePlektBackupFilesLoading = false;
  renderPlektBackups();
}
export async function saveAppearanceSettings() {
  const prefs = {
    showLogoArt: elements.appearShowLogoArt?.checked ?? true,
    showCast: elements.appearShowCast?.checked ?? true,
    showTrailers: elements.appearShowTrailers?.checked ?? true,
    showReviews: elements.appearShowReviews?.checked ?? true,
    showImages: elements.appearShowImages?.checked ?? true,
    showRelated: elements.appearShowRelated?.checked ?? true,
    textScale: Number(document.querySelector("#appearTextScale")?.value) || 100,
  };
  applyAppearanceToBody(prefs);

  if (state.activeShowModalKey) {
    const { openShowInlineDetail, renderImmersiveShowModal } = await import("./media-detail-show.js?v=2.0.0.3.1");
    if (state.mediaDetailInline) {
      openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason).catch(() => null);
    } else {
      renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason).catch(() => null);
    }
  } else if (state.activeMovieTmdbId || state.activeMovieModalId) {
    const { openMovieImmersiveModalByTmdbId, openMovieImmersiveModal } = await import("./media-detail-movie.js?v=2.0.0.3.1");
    if (state.activeMovieTmdbId) {
      openMovieImmersiveModalByTmdbId(state.activeMovieTmdbId).catch(() => null);
    } else if (state.activeMovieModalId) {
      openMovieImmersiveModal(state.activeMovieModalId).catch(() => null);
    }
  }

  await fetch("/api/appearance", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  }).catch(() => null);
}
export async function saveWatchBackupSettings() {
  const config = {
    ...state.watchBackups?.config,
    enabled: elements.watchBackupEnabled.checked,
    time: elements.watchBackupTime.value || "03:00",
    retention: Number(elements.watchBackupRetention.value) || 7,
  };
  await postWatchBackupAction({ action: "configure", config });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  flashButtonSuccess(elements.saveWatchBackupConfigButton);
}
export async function saveRemoteWatchBackupSettings() {
  const config = {
    ...state.watchBackups?.config,
    remoteEnabled: elements.remoteWatchBackupEnabled.checked,
    remoteTime: elements.remoteWatchBackupTime.value || "03:00",
    remoteRetention: Number(elements.remoteWatchBackupRetention.value) || 7,
  };
  await postWatchBackupAction({ action: "configure", config });
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  flashButtonSuccess(elements.saveRemoteWatchBackupConfigButton);
}
function toggleBackupProgress(element, active) {
  element?.classList.toggle("hidden", !active);
}
// Inline success feedback on the button that was clicked: swap its label for
// "Saved!" (green) for a moment, then restore the original label.
const buttonFlashTimers = new WeakMap();
export function flashButtonSuccess(button, label = "Saved!") {
  if (!button) return;
  if (!buttonFlashTimers.has(button)) button.dataset.flashOriginal = button.textContent;
  window.clearTimeout(buttonFlashTimers.get(button));
  button.textContent = label;
  button.classList.add("button-flash-success");
  buttonFlashTimers.set(button, window.setTimeout(() => {
    button.textContent = button.dataset.flashOriginal || label;
    button.classList.remove("button-flash-success");
    delete button.dataset.flashOriginal;
    buttonFlashTimers.delete(button);
  }, 2000));
}
export async function createWatchBackupNow() {
  const button = elements.createWatchBackupButton;
  button.disabled = true;
  button.textContent = "Backing up...";
  toggleBackupProgress(elements.watchBackupProgress, true);
  try {
    const result = await postWatchBackupAction({ action: "create" });
    state.watchBackups = null;
    await loadWatchBackups({ force: true });
    _setMessage(`Created ${result.backup?.name || "watch-history backup"}.`, "success");
  } finally {
    toggleBackupProgress(elements.watchBackupProgress, false);
    button.disabled = false;
    button.textContent = "Back Up Now";
  }
}
export async function createRemoteWatchBackupNow() {
  const button = elements.createRemoteWatchBackupButton;
  if (!button) return;
  button.disabled = true;
  button.textContent = "Backing up...";
  toggleBackupProgress(elements.remoteWatchBackupProgress, true);
  try {
    const result = await postWatchBackupAction({ action: "create", remote: true });
    state.watchBackups = null;
    await loadWatchBackups({ force: true });
    const remotes = Array.isArray(result.backup?.remotes) ? result.backup.remotes : [];
    const failed = remotes.filter((remote) => remote.status === "error");
    if (!remotes.length) {
      _setMessage("Backup created, but there are no enabled remote destinations to mirror it to.", "error");
    } else if (failed.length) {
      _setMessage(`Backup created, but ${failed.length} remote upload${failed.length === 1 ? "" : "s"} failed: ${failed[0].lastError || "unknown error"}`, "error");
    } else {
      _setMessage(`Created ${result.backup?.name || "watch-history backup"} and mirrored it to ${remotes.length} remote destination${remotes.length === 1 ? "" : "s"}.`, "success");
    }
  } finally {
    toggleBackupProgress(elements.remoteWatchBackupProgress, false);
    button.disabled = false;
    button.textContent = "Back Up Now";
  }
}
export async function downloadWatchBackup(filename) {
  const response = await fetch(`/api/watch-backups?download=${encodeURIComponent(filename)}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Backup download failed with ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
export async function uploadWatchBackupFile(file) {
  if (!file) return;
  const name = String(file.name || "");
  if (!name.toLowerCase().endsWith(".gz")) {
    throw new Error("Choose a Plekt watch-history .json.gz backup file.");
  }
  if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = `Uploading ${name}...`;
  const response = await fetch(`/api/watch-backups?upload=1&filename=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/gzip",
    },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backup upload failed with ${response.status}`);
  state.watchBackups = null;
  await loadWatchBackups({ force: true });
  if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = `Ready: ${body.file?.name || name}`;
  _setMessage(`Backup file added: ${body.file?.name || name}.`, "success");
  return body.file;
}
export async function restoreWatchBackup(filename, clearMode = "wipe", dryRun = false) {
  if (dryRun) {
    const result = await postWatchBackupAction({ action: "restore", filename, dryRun: true });
    const summary = result.restore || {};
    _setMessage(`Backup valid: ${summary.watchHistory || 0} history, ${summary.playstate || 0} playstate, ${summary.playbackProgress || 0} progress rows.`, "success");
    return;
  }
  const wipe = clearMode === "wipe";
  const approved = await _openConfirmDialog({
    title: "⚠️ Wipe and restore watch history?",
    body: `⚠️ AUTHORITATIVE RESTORE - this backup becomes the source of truth.\n\nWill DELETE all current watch history, playstate and resume progress, restore from ${filename}, and push that state to every connected app (Plex/Emby/Jellyfin).\n\n${wipe
      ? "Clear mode: FULL WIPE - every currently-watched item on each app is first marked unwatched, so the apps end up matching the backup exactly."
      : "Clear mode: RECONCILE - only items tracked by the backup are pushed; extra watched items on the apps are left as-is."}\n\nThis cannot be undone.`,
    confirmLabel: wipe ? "Wipe Apps and Restore" : "Restore and Push",
    danger: true,
  });
  if (!approved) return;
  await runAuthoritativeRestore({ action: "restore", filename, clearMode });
}
// Shared driver for both local and remote authoritative restores: kick off the background job,
// stream its log into the restore terminal, then refresh the UI.
async function runAuthoritativeRestore(payload) {
  const terminal = document.querySelector("#restoreProgressTerminal");
  if (terminal) {
    terminal.classList.remove("hidden");
    terminal.textContent = "[Starting] Preparing authoritative restore...\n";
  }
  try {
    const result = await postWatchBackupAction(payload);
    const summary = result.restore || {};
    if (terminal) {
      terminal.textContent += `[${new Date().toLocaleTimeString()}] Restored ${summary.watchHistory || 0} history, ${summary.playstate || 0} playstate, ${summary.playbackProgress || 0} progress records\n`;
      terminal.textContent += `[${new Date().toLocaleTimeString()}] Pushing to connected apps (clear mode: ${result.clearMode || payload.clearMode || "wipe"})...\n`;
    }
    const jobResult = await pollRestoreProgress(terminal);
    _clearDerivedUiCaches();
    await Promise.all([_loadHistory({ force: true }), _loadStats({ force: true })]);
    state.watchBackups = null;
    await loadWatchBackups({ force: true });
    if (jobResult && jobResult.success === false) {
      _setMessage(`Restore finished with errors: ${jobResult.error || "see terminal"}.`, "error");
    } else {
      _setMessage(`Watch history restored from ${payload.filename} and pushed to connected apps.`, "success");
    }
  } catch (error) {
    if (terminal) terminal.textContent += `[ERROR] ${error.message}\n`;
    throw error;
  }
}
// Poll the watch-backups status endpoint, appending new restore-job log lines to the terminal
// until the job is actually finished (restoreSync.active === false). A large restore can run a
// long time, so we keep following it (high safety cap ~3h) instead of giving up early.
//
// The endpoint deliberately empties `log` once active is false unless `report=1` is passed (see
// handleWatchBackups), since the in-memory tail isn't reliable once a job has finished. A poll
// timed to land exactly as the job finishes therefore sees active:false with no lines at all -
// including the final "restore complete" confirmation - even though real work happened between
// the previous poll and this one. Measured directly (plan/active/speed/step1-phase0-quick-wins.md, Test 4): a ~7-minute restore
// left 18 lines, including the completion line, unreported by the live poll loop. Once active
// flips false, re-fetch the same cursor with report=1 so the terminal reads from the persisted
// report instead of settling for whatever the in-memory tail happened to still hold.
function appendRestoreLog(terminal, log, printed) {
  if (!terminal || !log.length) return printed;
  for (const line of log) terminal.textContent += `${line}\n`;
  terminal.scrollTop = terminal.scrollHeight;
  return printed + log.length;
}
async function pollRestoreProgress(terminal) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_TICKS = 5400; // ~3h at 2s
  let printed = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    let data;
    try {
      const url = new URL("/api/watch-backups", window.location.origin);
      url.searchParams.set("since", String(printed));
      const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
      data = await response.json().catch(() => ({}));
    } catch {
      await sleep(2000);
      continue;
    }
    const rs = data.restoreSync || {};
    printed = appendRestoreLog(terminal, Array.isArray(rs.log) ? rs.log : [], printed);
    if (rs.active !== true) {
      let finalResult = rs.result || null;
      try {
        const finalUrl = new URL("/api/watch-backups", window.location.origin);
        finalUrl.searchParams.set("since", String(printed));
        finalUrl.searchParams.set("report", "1");
        const finalResponse = await fetch(finalUrl, { headers: authHeaders(), cache: "no-store" });
        const finalData = await finalResponse.json().catch(() => ({}));
        const finalRs = finalData.restoreSync || {};
        printed = appendRestoreLog(terminal, Array.isArray(finalRs.log) ? finalRs.log : [], printed);
        finalResult = finalRs.result || finalResult;
      } catch {
        // The tail is best-effort polish on top of the result already in hand; the restore
        // itself already completed, so a failed follow-up fetch must not block returning it.
      }
      if (terminal && finalResult && finalResult.success === false) {
        terminal.textContent += `[ERROR] ${finalResult.error || "Restore reconcile failed"}\n`;
      }
      return finalResult;
    }
    await sleep(2000);
  }
  if (terminal) terminal.textContent += "[Note] Still running - stopped following the log. Check the server logs for completion.\n";
  return null;
}
