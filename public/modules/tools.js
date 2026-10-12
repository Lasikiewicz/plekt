import { buildAuthHeaders } from "./auth.js?v=2.0.0.0.1";
import { state, elements } from "./state.js?v=2.0.0.0.1";
import { escapeHtml, escapeAttribute, formatNumber, formatDate, csvRows, normalizeHeader, episodeCode } from "./utils.js?v=2.0.0.0.1";
import { initBackupTools } from "./tools-backups.js?v=2.0.0.0.1";
import { initMaintenanceTools } from "./tools-maintenance.js?v=2.0.0.0.1";
import { initHealthTools } from "./tools-health.js?v=2.0.0.0.1";
import { initDuplicateWatchTools } from "./tools-duplicates.js?v=2.0.0.0.1";
import { initWipeDataTools } from "./tools-wipe-data.js?v=2.0.0.0.1";
import { initPlaystateAliasTools } from "./tools-playstate-aliases.js?v=2.0.0.0.1";
// Callbacks injected by app.js at startup to avoid circular imports.
let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _showConfirmModal = () => {};
let _loadSavedConfig = async () => {};
let _loadHistory = async () => {};
let _loadActiveSessions = async () => {};
let _loadStats = async () => {};
let _clearDerivedUiCaches = () => {};
let _loadSyncJobs = async () => {};
let _loadSyncHistory = async () => {};
export function initTools(callbacks) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadSavedConfig) _loadSavedConfig = callbacks.loadSavedConfig;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.loadActiveSessions) _loadActiveSessions = callbacks.loadActiveSessions;
  if (callbacks.loadStats) _loadStats = callbacks.loadStats;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadSyncJobs) _loadSyncJobs = callbacks.loadSyncJobs;
  if (callbacks.loadSyncHistory) _loadSyncHistory = callbacks.loadSyncHistory;
  initBackupTools(callbacks);
  initMaintenanceTools(callbacks);
  initHealthTools();
  initDuplicateWatchTools(callbacks);
  initWipeDataTools(callbacks);
  initPlaystateAliasTools(callbacks);
}
function authHeaders() {
  return buildAuthHeaders(state.token);
}
// ── Constants ──────────────────────────────────────────────────────────────
const IMPORT_BATCH_SIZE = 100;
const IMPORT_MAX_ATTEMPTS = 4;
const IMPORT_RETRY_BASE_MS = 1500;
export {
  createPlektBackupNow,
  createPlektBackupRemoteNow,
  createRemoteWatchBackupNow,
  createWatchBackupNow,
  deletePlektBackupFile,
  downloadPlektBackup,
  downloadWatchBackup,
  exportPlektBackup,
  importPlektBackup,
  loadPlektBackups,
  loadRemoteBackupsForRestoreTab,
  loadRemotePlektBackupsForRestoreTab,
  loadWatchBackups,
  postPlektBackupAction,
  postWatchBackupAction,
  renderPlektBackups,
  renderWatchBackups,
  restorePlektBackupFromServer,
  restoreRemoteBackupFromCard,
  restoreRemotePlektBackup,
  restoreWatchBackup,
  saveAppearanceSettings,
  savePlektBackupRemoteSettings,
  savePlektBackupSettings,
  saveRemoteWatchBackupSettings,
  saveWatchBackupSettings,
  selectPlektBackupFile,
  setBackupTransferState,
  updatePlektButtonsState,
  uploadWatchBackupFile,
} from "./tools-backups.js?v=2.0.0.0.1";
export { APPEARANCE_DEFAULTS, applyAppearanceToBody, loadAppearanceSettings } from "./appearance.js?v=2.0.0.0.1";
export { loadCacheStats, renderCachePanel, resetFullSyncWatchstates } from "./tools-maintenance.js?v=2.0.0.0.1";
export { loadSyncHealth } from "./tools-health.js?v=2.0.0.0.1";
// ── Trakt / CSV import ─────────────────────────────────────────────────────
export async function parseSelectedFiles(files) {
  const selectedFiles = [...files];
  const parsedRecords = [];
  resetImportActivity();
  appendImportLog(`Selected ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}.`);
  for (const [index, file] of selectedFiles.entries()) {
    appendImportLog(`Reading ${file.name}...`);
    const text = await file.text();
    const extension = file.name.split(".").pop().toLowerCase();
    const records = extension === "json" ? parseJsonExport(text) : parseCsvExport(text);
    const mapped = records.map(mapImportRecord).filter(Boolean);
    parsedRecords.push(...mapped);
    appendImportLog(`Parsed ${formatNumber(mapped.length)} usable records from ${file.name}.`);
    setImportProgress(((index + 1) / selectedFiles.length) * 100);
  }
  state.importRecords = parsedRecords;
  state.importFileNames = selectedFiles.map((file) => file.name);
  appendImportLog(`Ready: ${formatNumber(parsedRecords.length)} total records queued.`);
  renderImportPreview();
}
function parseJsonExport(text) {
  const json = JSON.parse(text);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.history)) return json.history;
  if (Array.isArray(json.watched)) return json.watched;
  return [json];
}
function parseCsvExport(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => normalizeHeader(header));
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || "";
    });
    return record;
  });
}

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "");
}

function mapImportRecord(record) {
  const source = record.source || "trakt_import";
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};
  const ids = record.ids || movie.ids || show.ids || episode.ids || {};
  const rawType = record.media_type || record.mediatype || record.type || record["type"] || "";
  const mediaType = inferMediaType(rawType, record);
  const title = importTitle(record, mediaType);
  const watchedAt =
    record.watched_at ||
    record.watched_at_utc ||
    record.watchedAt ||
    record.last_watched_at ||
    record.lastWatchedAt ||
    record.scrobbled_at ||
    record.collected_at ||
    record.date ||
    record.watched_date ||
    record.Date ||
    "";
  if (!title || !watchedAt) return undefined;
  return {
    title,
    media_type: mediaType,
    watched_at: watchedAt,
    source,
    imdb_id: record.imdb_id || record.imdb || record.imdbid || ids.imdb || "",
    tmdb_id: record.tmdb_id || record.tmdb || record.tmdbid || ids.tmdb || "",
    tvdb_id: record.tvdb_id || record.tvdb || record.tvdbid || ids.tvdb || "",
    season: firstPresent(record.season, episode.season, ""),
    episode: firstPresent(record.episode_number, episode.number, typeof record.episode === "object" ? "" : record.episode, ""),
  };
}
function importTitle(record, mediaType) {
  const movie = record.movie || {};
  const show = record.show || {};
  const episode = record.episode || {};
  if (mediaType === "episode") {
    const showTitle = record.show_title || show.title || record.show || "";
    const season = firstPresent(record.season, episode.season);
    const episodeNumber = firstPresent(record.episode_number, episode.number, typeof record.episode === "object" ? "" : record.episode);
    if (showTitle && (season != null || episodeNumber != null)) {
      return `${showTitle} - ${episodeCode(season, episodeNumber)}`;
    }
  }
  return (
    record.title ||
    record.name ||
    record.movie_title ||
    record.show_title ||
    movie.title ||
    show.title ||
    episode.title ||
    record.show ||
    record.movie ||
    record.Title ||
    ""
  );
}
function inferMediaType(type, record) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("movie")) return "movie";
  if (normalized.includes("episode") || normalized.includes("show") || normalized.includes("tv")) return "episode";
  if (record.season != null || record.episode != null) return "episode";
  return "movie";
}
export function renderImportPreview() {
  elements.startImportButton.disabled = !state.importRecords.length || state.importActive;
  elements.clearImportButton.disabled = state.importActive;
  elements.importFile.disabled = state.importActive;
  if (!state.importActive) {
    elements.importProgress.textContent = state.importRecords.length
      ? `${formatNumber(state.importRecords.length)} parsed from ${formatNumber(state.importFileNames.length || 1)} file${state.importFileNames.length === 1 ? "" : "s"}`
      : "Idle";
  }
  renderImportActivity();
  if (!state.importRecords.length) {
    elements.importPreview.innerHTML = "";
    return;
  }
  elements.importPreview.innerHTML = `
    <div class="table-row table-head">
      <span>Preview title</span>
      <span>Type</span>
      <span>Watched</span>
    </div>
    ${state.importRecords
      .slice(0, 5)
      .map(
        (record) => `
          <article class="table-row">
            <b>${escapeHtml(record.title)}</b>
            <span>${escapeHtml(record.media_type)}</span>
            <time>${formatDate(record.watched_at)}</time>
          </article>
        `,
      )
      .join("")}
  `;
}
function resetImportActivity() {
  state.importLogs = [];
  setImportProgress(0);
}
export function appendImportLog(message) {
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  state.importLogs.push(`[${timestamp}] ${message}`);
  if (state.importLogs.length > 250) state.importLogs = state.importLogs.slice(-250);
  renderImportActivity();
}
function setImportProgress(value) {
  state.importProgressValue = Math.max(0, Math.min(100, Number(value || 0)));
  renderImportActivity();
}
export function renderImportActivity() {
  const progress = Math.round(state.importProgressValue || 0);
  if (elements.importProgressFill) {
    elements.importProgressFill.style.width = `${progress}%`;
    elements.importProgressFill.parentElement?.setAttribute("aria-valuenow", String(progress));
  }
  if (elements.importProgressPercent) {
    elements.importProgressPercent.textContent = `${progress}%`;
  }
  if (elements.importTerminal) {
    elements.importTerminal.textContent = state.importLogs.length ? state.importLogs.join("\n") : "[idle] Waiting for files.";
    elements.importTerminal.scrollTop = elements.importTerminal.scrollHeight;
  }
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatImportFailure(body, status) {
  return [body?.error, body?.details].filter(Boolean).join(": ") || `Import failed with ${status}`;
}
async function sendImportBatch(records, batchNumber, totalBatches) {
  for (let attempt = 1; attempt <= IMPORT_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch("/api/import", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ records }),
      });
    } catch (error) {
      if (attempt >= IMPORT_MAX_ATTEMPTS) {
        appendImportLog(`Batch ${batchNumber}/${totalBatches} failed after ${IMPORT_MAX_ATTEMPTS} attempts: ${error.message}.`);
        throw error;
      }
      const delay = IMPORT_RETRY_BASE_MS * attempt;
      appendImportLog(`Batch ${batchNumber}/${totalBatches} attempt ${attempt} failed: ${error.message}. Retrying in ${Math.round(delay / 1000)}s.`);
      await wait(delay);
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    const failure = formatImportFailure(body, response.status);
    if (response.status < 500) {
      appendImportLog(`Batch ${batchNumber}/${totalBatches} failed: ${failure}.`);
      throw new Error(failure);
    }
    if (attempt >= IMPORT_MAX_ATTEMPTS) {
      appendImportLog(`Batch ${batchNumber}/${totalBatches} failed after ${IMPORT_MAX_ATTEMPTS} attempts: ${failure}.`);
      throw new Error(failure);
    }
    const delay = IMPORT_RETRY_BASE_MS * attempt;
    appendImportLog(`Batch ${batchNumber}/${totalBatches} attempt ${attempt} failed: ${failure}. Retrying in ${Math.round(delay / 1000)}s.`);
    await wait(delay);
  }
  throw new Error("Import batch failed");
}
export async function startImport() {
  if (!state.importRecords.length) return;
  state.importActive = true;
  elements.startImportButton.disabled = true;
  elements.clearImportButton.disabled = true;
  elements.importFile.disabled = true;
  setImportProgress(0);
  appendImportLog(`Starting import of ${formatNumber(state.importRecords.length)} records in chunks of ${IMPORT_BATCH_SIZE}.`);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let rejected = 0;
  const totalBatches = Math.ceil(state.importRecords.length / IMPORT_BATCH_SIZE);
  try {
    for (let index = 0; index < state.importRecords.length; index += IMPORT_BATCH_SIZE) {
      const records = state.importRecords.slice(index, index + IMPORT_BATCH_SIZE);
      const batchNumber = Math.floor(index / IMPORT_BATCH_SIZE) + 1;
      const rangeEnd = Math.min(index + records.length, state.importRecords.length);
      elements.importProgress.textContent = `Importing ${index + 1}-${rangeEnd}`;
      appendImportLog(`Sending batch ${batchNumber}/${totalBatches}: records ${index + 1}-${rangeEnd}.`);
      const body = await sendImportBatch(records, batchNumber, totalBatches);
      const batchInserted = Number(body.inserted || 0);
      const batchUpdated = Number(body.updated || 0);
      const batchSkipped = Number(body.skipped || 0);
      const batchRejected = Array.isArray(body.rejected) ? body.rejected.length : 0;
      inserted += batchInserted;
      updated += batchUpdated;
      skipped += batchSkipped;
      rejected += batchRejected;
      appendImportLog(`Batch ${batchNumber}/${totalBatches} done: ${batchInserted} inserted, ${batchUpdated} updated, ${batchSkipped} skipped, ${batchRejected} rejected.`);
      setImportProgress((rangeEnd / state.importRecords.length) * 100);
    }
    elements.importProgress.textContent = `${formatNumber(inserted)} inserted / ${formatNumber(updated)} updated`;
    appendImportLog(`Import complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${rejected} rejected.`);
    _setMessage(`Import complete. Inserted ${inserted}, updated ${updated}, skipped ${skipped}, rejected ${rejected}.`, "success");
    _clearDerivedUiCaches();
    await _loadHistory();
  } catch (error) {
    appendImportLog(`Import failed: ${error.message}`);
    throw error;
  } finally {
    state.importActive = false;
    elements.startImportButton.disabled = !state.importRecords.length;
    elements.clearImportButton.disabled = false;
    elements.importFile.disabled = false;
    renderImportActivity();
  }
}
// ── Maintenance tools ──────────────────────────────────────────────────────
// History repair, dedup, Trakt backfill, full-sync, and system integrity
// checks live in tools-maintenance.js (per CLAUDE.md's module table) and are
// re-exported here so existing imports of these names from "./tools.js?v=2.0.0.0.1"
// keep working unchanged.
export { runRepairWorkflow, runPhantomWatchAudit, runPhantomWatchRepair, runTraktBackfill, runRematchTvShows, runFullSyncWatchstates, cancelFullSyncWatchstates, runSystemIntegrityCheck, triggerClearMissingTelemetry, triggerRetryAllCategory } from "./tools-maintenance.js?v=2.0.0.0.1";
export { runDuplicateWatchCleanup } from "./tools-duplicates.js?v=2.0.0.0.1";
export { runEpisodeTitleAudit, runEpisodeTitleBackfill } from "./tools-maintenance.js?v=2.0.0.0.1";
export { loadWipeDataPreview, runWipeData } from "./tools-wipe-data.js?v=2.0.0.0.1";
