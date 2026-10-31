import { buildAuthHeaders } from "./auth.js?v=2.2.3.0.0";
import { state } from "./state.js?v=2.2.3.0.0";
import { escapeAttribute, escapeHtml, episodeCode, formatDate } from "./utils.js?v=2.2.3.0.0";

// ── Repair Split Episode Shows ──────────────────────────────────────────────
// Watch rows an Emby/Jellyfin Force Sync import stored under an episode's own
// ids, so one show shows up as one "show" per episode
// (plan/active/emby-reporter-feedback/step6-split-episode-repair.md). The audit
// is read-only; the repair needs ticked shows, takes a full backup first, and
// sends nothing to connected platforms. Each run can be undone.

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _clearDerivedUiCaches = () => {};
let audit = null;

const REASONS = {
  "ids-differ": "The server reports different ids for this episode now, so it cannot be proven.",
  "lookup-failed": "The server could not tell which series this episode belongs to.",
  ambiguous: "More than one series on your servers matches these ids.",
  collision: "A correctly matched watch for this episode already exists. Use Fix Match instead.",
};

function byId(id) { return document.getElementById(id); }
function authHeaders() { return buildAuthHeaders(state.token); }

function setStatus(text, tone = "muted") {
  const pill = byId("splitEpisodeStatus");
  if (!pill) return;
  pill.textContent = text;
  pill.className = `status-pill status-${tone}`;
}

function showResult(text, tone) {
  const log = byId("splitEpisodeLog");
  if (log) {
    log.textContent = text;
    log.classList.remove("hidden");
  }
  _setMessage(text, tone);
}

function idsText(ids = {}) {
  const parts = [["IMDb", ids.imdb], ["TMDB", ids.tmdb], ["TVDB", ids.tvdb]]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} ${value}`);
  return parts.join(" · ") || "no ids";
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function renderShow(show) {
  const rows = show.rows.map((row) => `<li>
      <span>${escapeHtml(episodeCode(row.season, row.episode))}</span>
      <span>Stored as ${escapeHtml(idsText(row.oldIds))}</span>
      ${row.delivered.length ? `<small>Already sent to ${escapeHtml(row.delivered.join(", "))}</small>` : ""}
    </li>`).join("");
  const progress = show.progress.length
    ? `<p class="playstate-alias-note">${plural(show.progress.filter((move) => !move.blocked).length, "resume position")} will move too${show.progress.some((move) => move.blocked) ? "; positions that would overwrite an existing one stay where they are" : ""}.</p>`
    : "";
  const others = Object.entries(show.otherTables || {});
  const otherNote = others.length
    ? `<p class="playstate-alias-note">Not changed: ${escapeHtml(others.map(([table, count]) => `${table} (${count})`).join(", "))}.</p>`
    : "";
  const delivered = show.delivered.length
    ? `<p class="playstate-alias-warning">Some of these watches were already sent to ${escapeHtml(show.delivered.join(", "))} under the wrong ids. The repair does not change them there; check those accounts by hand.</p>`
    : "";
  return `<article class="playstate-alias-show">
    <h4><label class="checkbox-label"><input type="checkbox" data-split-show="${escapeAttribute(show.showKey)}"> ${escapeHtml(show.title)}</label></h4>
    <p class="playstate-alias-ids">Show ids: ${escapeHtml(idsText(show.newIds))}</p>
    <ul class="playstate-alias-rows">${rows}</ul>
    ${progress}${otherNote}${delivered}
  </article>`;
}

function renderSkipped(skipped = []) {
  if (!skipped.length) return "";
  const items = skipped.map((row) => `<li>
      <span>${escapeHtml(row.title)} ${escapeHtml(episodeCode(row.season, row.episode))}</span>
      <span>${escapeHtml(idsText(row.oldIds))}</span>
      <small>${escapeHtml(REASONS[row.reason] || row.reason)}</small>
    </li>`).join("");
  return `<details><summary>Skipped (${skipped.length})</summary><ul class="playstate-alias-rows">${items}</ul></details>`;
}

function renderRuns(runs = []) {
  if (!runs.length) return "";
  const items = runs.map((run) => `<article class="playstate-alias-show">
      <h4>${escapeHtml(formatDate(run.createdAt))}: ${escapeHtml(run.shows.join(", "))}</h4>
      <p>${plural(run.rows, "watch", "watches")}, ${plural(run.progress, "resume position")}${run.backup ? `. Backup ${escapeHtml(run.backup)}` : ""}</p>
      ${run.reverted ? "<p>Undone</p>" : `<button class="button-ghost sync-action-btn sync-tool-button" type="button" data-split-undo="${escapeAttribute(run.runId)}">Undo this repair</button>`}
    </article>`).join("");
  return `<details><summary>Earlier repairs (${runs.length})</summary>${items}</details>`;
}

function render() {
  const list = byId("splitEpisodeList");
  const repairButton = byId("splitEpisodeRepairButton");
  if (!list || !audit) return;
  list.classList.remove("hidden");
  const errors = (audit.serverErrors || []).map((entry) => `<p class="playstate-alias-warning">${escapeHtml(entry.server)}: ${escapeHtml(entry.error)}. Its watches could not be checked.</p>`).join("");
  const shows = audit.shows || [];
  const body = shows.length
    ? shows.map(renderShow).join("")
    : '<p class="playstate-alias-note">No split shows found. Every episode watch that matches a watched Emby or Jellyfin episode is stored under its show.</p>';
  list.innerHTML = errors + body + renderSkipped(audit.skipped) + renderRuns(audit.runs);
  if (repairButton) repairButton.classList.toggle("hidden", !shows.length);
  setStatus(shows.length ? `${plural(shows.length, "show")}, ${plural(audit.totals.rows, "watch", "watches")}` : "Nothing to repair", shows.length ? "warning" : "ready");
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { ...authHeaders(), ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export async function loadSplitEpisodeAudit() {
  const button = byId("splitEpisodeAuditButton");
  if (button) button.disabled = true;
  setStatus("Checking servers...", "warning");
  try {
    audit = await request("/api/split-episode-audit");
    render();
  } catch (error) {
    setStatus(`Error: ${error.message}`, "error");
    _setMessage(`Checking split episode shows failed: ${error.message}`, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function confirmRepair() {
  const showKeys = [...document.querySelectorAll("#splitEpisodeList [data-split-show]:checked")].map((input) => input.dataset.splitShow);
  if (!showKeys.length) {
    showResult("Tick at least one show to repair.", "error");
    return;
  }
  const chosen = (audit?.shows || []).filter((show) => showKeys.includes(show.showKey));
  const watches = chosen.reduce((total, show) => total + show.rows.length, 0);
  const message = `Move ${plural(watches, "watch", "watches")} in ${plural(chosen.length, "show")} onto their show ids?\n\nPlekt takes a full backup first and stops if it cannot. Each watch is checked against your server again before it changes. Nothing is sent to connected platforms, and you can undo this repair afterwards.`;
  _showConfirmModal(message, async () => {
    const button = byId("splitEpisodeRepairButton");
    if (button) button.disabled = true;
    try {
      const result = await request("/api/split-episode-repair", { method: "POST", body: JSON.stringify({ showKeys }) });
      const extras = [
        result.progressRekeyed ? plural(result.progressRekeyed, "resume position") + " moved" : "",
        result.changed ? `${result.changed} changed since the check and left alone` : "",
        result.notProven?.length ? `${plural(result.notProven.length, "show")} no longer proven and skipped` : "",
      ].filter(Boolean).join("; ");
      showResult(`${plural(result.repaired, "watch", "watches")} repaired${result.backup ? ` (backup ${result.backup})` : ""}${extras ? `; ${extras}` : ""}.`, "success");
      await _clearDerivedUiCaches();
    } catch (error) {
      showResult(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
    await loadSplitEpisodeAudit();
  }, { title: "Repair split episode shows", approveLabel: "Repair" });
}

function confirmUndo(runId) {
  _showConfirmModal("Undo this repair?\n\nEach watch and resume position it moved goes back to its old ids, unless it has changed since.", async () => {
    try {
      const result = await request("/api/split-episode-undo", { method: "POST", body: JSON.stringify({ runId }) });
      showResult(`${plural(result.restored, "watch", "watches")} and ${plural(result.progressRestored, "resume position")} restored${result.changed ? `; ${result.changed} changed since and left alone` : ""}.`, "success");
      await _clearDerivedUiCaches();
    } catch (error) {
      showResult(error.message, "error");
    }
    await loadSplitEpisodeAudit();
  }, { title: "Undo repair", approveLabel: "Undo" });
}

export function initSplitEpisodeRepairTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  byId("splitEpisodeAuditButton")?.addEventListener("click", () => loadSplitEpisodeAudit());
  byId("splitEpisodeRepairButton")?.addEventListener("click", () => confirmRepair());
  byId("splitEpisodeList")?.addEventListener("click", (event) => {
    const undo = event.target.closest("[data-split-undo]");
    if (undo) confirmUndo(undo.dataset.splitUndo);
  });
}
