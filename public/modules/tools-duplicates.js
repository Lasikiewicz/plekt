import { buildAuthHeaders } from "./auth.js?v=2.0.0.0.10";
import { state, elements } from "./state.js?v=2.0.0.0.10";

// ── Library-wide duplicate watch cleanup ────────────────────────────────────
// The per-season "remove duplicate watches" cleanup (edit-dialogs.js) only
// covers episodes already loaded into an open season dialog. This sweeps the
// whole library instead: for every movie or episode with more than one
// recorded watch, everything after the oldest is a removable duplicate (a
// rewatch import, a sync echo, or the kind of wrong-id Trakt overwrite fixed
// in trackerDispatcher.js). Always scans first and confirms with the real
// count before deleting anything irreversible.

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _loadHistory = async () => {};
let _clearDerivedUiCaches = () => {};

export function initDuplicateWatchTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
}

function authHeaders() { return buildAuthHeaders(state.token); }

function setStatusPill(element, text, tone = "muted") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-pill status-${tone}`;
}

function duplicateWatchElements(mediaType) {
  const isMovie = mediaType === "movie";
  return {
    button: isMovie ? elements.duplicateWatchMovieButton : elements.duplicateWatchTvButton,
    status: elements.duplicateWatchStatus,
    log: elements.duplicateWatchLog,
    label: isMovie ? "movie" : "TV",
    itemNoun: isMovie ? "movie" : "episode",
  };
}

export async function runDuplicateWatchCleanup(mediaType) {
  const { button, status, log, label, itemNoun } = duplicateWatchElements(mediaType);
  if (!button) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Scanning...";
  setStatusPill(status, `Scanning ${label} watches...`, "warning");
  try {
    const response = await fetch(`/api/duplicate-watch-scan?mediaType=${mediaType}`, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);

    const removable = Number(body.removable || 0);
    const itemsWithDuplicates = Number(body.itemsWithDuplicates || 0);
    button.disabled = false;
    button.textContent = originalText;

    if (!removable) {
      setStatusPill(status, `No duplicate ${label} watches found`, "ready");
      return;
    }
    setStatusPill(status, `${removable} duplicate${removable === 1 ? "" : "s"} found`, "warning");

    _showConfirmModal(
      `Remove ${removable} duplicate ${label} watch${removable === 1 ? "" : "es"} across ${itemsWithDuplicates} ${itemNoun}${itemsWithDuplicates === 1 ? "" : "s"}?\n\n` +
      `For every ${itemNoun} with more than one recorded watch, only the oldest date is kept - the rest are permanently deleted and the corrected watch state is pushed out to every connected platform. This cannot be undone.`,
      async () => {
        button.disabled = true;
        button.textContent = "Removing...";
        setStatusPill(status, `Removing ${removable} duplicate${removable === 1 ? "" : "s"}...`, "warning");
        try {
          const cleanupResponse = await fetch("/api/duplicate-watch-cleanup", {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ mediaType }),
          });
          const cleanupBody = await cleanupResponse.json().catch(() => ({}));
          if (!cleanupResponse.ok) throw new Error(cleanupBody.error || `HTTP ${cleanupResponse.status}`);

          const removed = Number(cleanupBody.removed || 0);
          const itemsAffected = Number(cleanupBody.itemsAffected || 0);
          setStatusPill(status, `Removed ${removed} duplicate${removed === 1 ? "" : "s"}`, "ready");
          if (log) {
            log.classList.remove("hidden");
            log.textContent = `Removed ${removed} duplicate ${label} watch${removed === 1 ? "" : "es"} across ${itemsAffected} ${itemNoun}${itemsAffected === 1 ? "" : "s"}. The corrected watch state was pushed to every connected platform.`;
          }
          _setMessage(`Removed ${removed} duplicate ${label} watches.`, "success");
          await _clearDerivedUiCaches();
          await _loadHistory({ force: true });
        } catch (error) {
          setStatusPill(status, `Error: ${error.message}`, "error");
          _setMessage(`Removing duplicate ${label} watches failed: ${error.message}`, "error");
          if (log) { log.classList.remove("hidden"); log.textContent = error.message; }
        } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    );
  } catch (error) {
    setStatusPill(status, `Scan failed: ${error.message}`, "error");
    button.disabled = false;
    button.textContent = originalText;
    _setMessage(`Duplicate watch scan failed: ${error.message}`, "error");
  }
}
