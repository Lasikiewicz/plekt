import { buildAuthHeaders, signOutAdmin } from "./auth.js?v=2.2.0.0.3";
import { state } from "./state.js?v=2.2.0.0.3";
import { formatNumber } from "./utils.js?v=2.2.0.0.3";

// ── Wipe data ────────────────────────────────────────────────────────────
// Deliberately separate from tools-maintenance.js (repairs/backfills), which
// is already near its module size limit - see CLAUDE.md's frontend module
// discipline table. Every non-factory scope here only ever touches tracked
// watch/sync data; settings, connections, credentials, and the admin login are
// never part of what gets deleted (see server/src/routes/wipeData.js).
//
// Elements are queried directly by id rather than through the shared
// state.js `elements` registry - app.js is already at its 3,000-line module
// ceiling, and every id here is only ever read from this one file.
const el = (id) => document.getElementById(id);

let _setMessage = () => {};
let _openConfirmDialog = async () => false;
let _clearDerivedUiCaches = () => {};
let _loadHistory = async () => {};
let _loadActiveSessions = async () => {};
let _loadStats = async () => {};

export function initWipeDataTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  if (callbacks.loadHistory) _loadHistory = callbacks.loadHistory;
  if (callbacks.loadActiveSessions) _loadActiveSessions = callbacks.loadActiveSessions;
  if (callbacks.loadStats) _loadStats = callbacks.loadStats;
}

function authHeaders() { return buildAuthHeaders(state.token); }

function setStatusPill(element, text, tone = "muted") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-pill status-${tone}`;
}

const SCOPES = {
  history: {
    label: "Watch History",
    countsEl: () => el("wipeHistoryCounts"),
    statusEl: () => el("wipeHistoryStatus"),
    logEl: () => el("wipeHistoryLog"),
    buttonEl: () => el("wipeHistoryButton"),
    tableLabels: {
      watch_history: "watch history rows",
      playstate: "playstate rows",
      playback_progress: "resume progress rows",
      active_sessions: "active sessions",
      live_tracking_cache: "live tracking rows",
      tracker_item_state: "tracker item states",
      tracker_play_history: "tracker play history rows",
    },
  },
  watchlist: {
    label: "Personal Watchlist",
    countsEl: () => el("wipeWatchlistCounts"),
    statusEl: () => el("wipeWatchlistStatus"),
    logEl: () => el("wipeWatchlistLog"),
    buttonEl: () => el("wipeWatchlistButton"),
    tableLabels: {
      personal_watchlist: "canonical watchlist rows",
      personal_watchlist_meta: "watchlist revision rows",
      personal_watchlist_mutations: "watchlist mutation/tombstone rows",
      personal_watchlist_provider_items: "provider ledger rows",
      personal_watchlist_sync_queue: "watchlist queue rows",
      personal_watchlist_sync_runs: "watchlist run rows",
      personal_watchlist_activity: "watchlist activity rows",
    },
  },
  logs: {
    label: "Sync History & Logs",
    countsEl: () => el("wipeLogsCounts"),
    statusEl: () => el("wipeLogsStatus"),
    logEl: () => el("wipeLogsLog"),
    buttonEl: () => el("wipeLogsButton"),
    tableLabels: {
      sync_history: "sync history rows",
      watch_audit_events: "audit events",
      diagnostic_log: "diagnostic log lines",
    },
  },
  all: {
    label: "Everything Tracked",
    countsEl: () => el("wipeAllCounts"),
    statusEl: () => el("wipeAllStatus"),
    logEl: () => el("wipeAllLog"),
    buttonEl: () => el("wipeAllButton"),
    tableLabels: null, // summarized as a total instead of per-table
  },
  factory: {
    label: "Everything (Factory Reset)",
    countsEl: () => el("wipeFactoryCounts"),
    statusEl: () => el("wipeFactoryStatus"),
    logEl: () => el("wipeFactoryLog"),
    buttonEl: () => el("wipeFactoryButton"),
    tableLabels: null, // summarized as a total instead of per-table
  },
};

async function fetchPreview() {
  const response = await fetch("/api/wipe-data/preview", { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Wipe data preview failed with ${response.status}`);
  return body.scopes || [];
}

function summarizeCounts(scope, tables, total) {
  const def = SCOPES[scope];
  if (!total) return "Nothing to delete - every table in this scope is already empty.";
  if (scope === "factory") return `${formatNumber(total)} row${total === 1 ? "" : "s"} across the entire database, plus all settings, connections, and cached artwork.`;
  if (!def.tableLabels) return `${formatNumber(total)} row${total === 1 ? "" : "s"} across watch history, personal watchlist, and sync history/logs.`;
  const parts = Object.entries(tables)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${formatNumber(count)} ${def.tableLabels[table] || table}`);
  return parts.length ? `${parts.join(", ")}.` : "Nothing to delete - every table in this scope is already empty.";
}

export async function loadWipeDataPreview() {
  for (const def of Object.values(SCOPES)) {
    const el = def.countsEl();
    if (el) el.textContent = "Loading row counts…";
  }
  try {
    const scopes = await fetchPreview();
    for (const entry of scopes) {
      const def = SCOPES[entry.scope];
      const el = def?.countsEl();
      if (el) el.textContent = summarizeCounts(entry.scope, entry.tables, entry.total);
      const button = def?.buttonEl();
      if (button) button.disabled = false;
    }
  } catch (error) {
    for (const def of Object.values(SCOPES)) {
      const el = def.countsEl();
      if (el) el.textContent = `Couldn't load row counts: ${error.message}`;
    }
  }
}

export async function runWipeData(scope) {
  const def = SCOPES[scope];
  if (!def) return;
  const button = def.buttonEl();
  const status = def.statusEl();
  const log = def.logEl();
  if (!button || button.disabled) return;

  const isFactory = scope === "factory";
  const firstBody = isFactory
    ? "⚠️ This resets Plekt to a brand-new install: every table, all settings, media server and Trakt connections, cached artwork, and the admin login.\n\nYou will be signed out and taken to first-run setup. Only a full Plekt backup can bring this back.\n\nContinue?"
    : `⚠️ This permanently deletes ${def.label.toLowerCase()} from the local database.\n\nBack it up first if you might want it back - this cannot be undone.\n\nContinue?`;
  const firstApproved = await _openConfirmDialog({
    title: `Wipe ${def.label}?`,
    body: firstBody,
    confirmLabel: "Continue",
    danger: true,
  });
  if (!firstApproved) return;

  const secondBody = isFactory
    ? "This is the last confirmation. There is no undo, and no way back without a full Plekt backup made beforehand.\n\nReset Plekt now?"
    : `This is the last confirmation. Wiping ${def.label} cannot be undone and there is no recovery once it runs.\n\nDelete it now?`;
  const secondApproved = await _openConfirmDialog({
    title: "Are you absolutely sure?",
    body: secondBody,
    confirmLabel: isFactory ? "Yes, reset everything" : "Yes, delete it",
    danger: true,
  });
  if (!secondApproved) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = isFactory ? "Resetting..." : "Wiping...";
  setStatusPill(status, isFactory ? "Resetting..." : "Wiping...", "warning");
  try {
    const response = await fetch("/api/wipe-data", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ scope, confirm: "DELETE" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Wipe failed with ${response.status}`);

    const total = Number(body.total || 0);
    setStatusPill(status, total ? `Deleted ${formatNumber(total)} rows` : "Nothing to delete", "ready");
    if (log) {
      log.classList.remove("hidden");
      log.textContent = total
        ? `Deleted ${formatNumber(total)} rows from ${def.label}.`
        : `${def.label} was already empty - nothing was deleted.`;
    }

    if (body.signOutRequired) {
      _setMessage("Plekt has been reset. Signing you out…", "success");
      await signOutAdmin();
      window.location.href = "/";
      return;
    }

    _setMessage(`Wiped ${def.label}.`, "success");
    await _clearDerivedUiCaches();
    await Promise.all([
      _loadHistory({ force: true }).catch(() => null),
      _loadActiveSessions().catch(() => null),
      _loadStats({ force: true }).catch(() => null),
    ]);
    await loadWipeDataPreview();
  } catch (error) {
    setStatusPill(status, "Failed", "error");
    if (log) { log.classList.remove("hidden"); log.textContent = error.message; }
    _setMessage(`Wiping ${def.label} failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
