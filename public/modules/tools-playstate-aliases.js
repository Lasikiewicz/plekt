import { buildAuthHeaders } from "./auth.js?v=2.0.0.0.8";
import { state } from "./state.js?v=2.0.0.0.8";
import { escapeAttribute, escapeHtml, episodeCode, formatDate } from "./utils.js?v=2.0.0.0.8";

// ── Watch-state aliases ─────────────────────────────────────────────────────
// Episode playstate rows keyed on the episode's own ids that no TMDB or TVDB
// lookup could tie to the show (plan/active/playstate-episode-id-repair/plan.md). The
// scheduled repair never folds these; the user decides per show. Only local
// playstate changes, nothing is dispatched to connected platforms.

let _setMessage = () => {};
let _showConfirmModal = () => {};
let _clearDerivedUiCaches = () => {};
let shows = [];
let dismissed = [];

const REASONS = {
  "title-only": "This entry has only a title. Confirm the show identity before moving it.",
  "no-profile": "No show identity is available yet. This entry can be moved once the show is matched in your history.",
  "newer-conflict": "This entry is newer and disagrees with the show's watch state. Choose which show it belongs to to keep the newest state.",
  "no-lookup": "Only a TMDB episode id is stored, which cannot be looked up.",
  "series-id": "TMDB says this id is a whole show, not an episode.",
  "not-found": "Neither TMDB nor TVDB could identify this id.",
  "tvdb-unmatched": "TVDB knows this episode, but not under this show's TVDB id or episode number.",
  "other-show": "TMDB places this episode in another show.",
  coordinate: "TMDB numbers this episode differently.",
  ambiguous: "More than one show with this title matches.",
};

function byId(id) { return document.getElementById(id); }
function authHeaders() { return buildAuthHeaders(state.token); }

function setStatus(text, tone = "muted") {
  const pill = byId("playstateAliasStatus");
  if (!pill) return;
  pill.textContent = text;
  pill.className = `status-pill status-${tone}`;
}

// The app-wide message line is not visible on the settings page, so the
// outcome of a fold or dismiss is also written into the card, as the sibling
// repair cards do with their logs.
function showResult(text, tone) {
  const log = byId("playstateAliasLog");
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

function stateText(entry) {
  if (!entry) return "no entry";
  return `${entry.state || "unknown"}${entry.updatedAt ? `, ${formatDate(entry.updatedAt)}` : ""}`;
}

function renderShow(show) {
  const several = show.profiles.length > 1;
  const profileLines = show.profiles
    .map((ids, index) => `<p class="playstate-alias-ids">${several ? `Show ${index + 1}: ` : "Show ids: "}${escapeHtml(idsText(ids))}</p>`)
    .join("");
  const warning = show.tmdbDisagreement
    ? `<p class="playstate-alias-warning">TMDB places these episodes in show ${escapeHtml(show.tmdbDisagreement.findShowId)}, but your history records this show as TMDB ${escapeHtml(show.tmdbDisagreement.profileTmdbIds.join(", "))}. The history itself may be matched to the wrong show.</p>`
    : "";
  const rows = show.rows.map((row) => {
    const showKeyed = show.profiles
      .map((ids, index) => `${several ? `Show ${index + 1}` : "Show"}: ${stateText(row.showKeyed[index])}`)
      .join("; ");
    return `<li>
      <span>${escapeHtml(episodeCode(row.season, row.episode))}</span>
      <span>Entry: ${escapeHtml(stateText(row))} (${escapeHtml(idsText(row.ids))})</span>
      <span>${escapeHtml(showKeyed)}</span>
      <small>${escapeHtml(REASONS[row.reason] || "")}</small>
    </li>`;
  }).join("");
  const key = escapeAttribute(show.showKey);
  const foldButtons = show.profiles.map((ids, index) => `
    <button class="button-primary sync-action-btn sync-tool-button" type="button" data-alias-action="fold" data-show-key="${key}" data-profile="${index}">${several ? `Belongs to show ${index + 1}` : "Belongs to this show"}</button>`).join("");
  return `<article class="playstate-alias-show">
    <h4>${escapeHtml(show.title)}</h4>
    ${profileLines}
    ${warning}
    <ul class="playstate-alias-rows">${rows}</ul>
    <div class="settings-actions">
      ${foldButtons}
      ${show.profiles.length ? "" : '<p class="playstate-alias-note">Match this show in your history before moving these entries.</p>'}
      <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-alias-action="dismiss" data-show-key="${key}">Different show</button>
    </div>
  </article>`;
}

function render() {
  const list = byId("playstateAliasList");
  if (!list) return;
  list.classList.remove("hidden");
  const dismissedHtml = dismissed.length ? `<details><summary>Dismissed (${dismissed.reduce((total, show) => total + show.rows.length, 0)})</summary>${dismissed.map((show) => `<article class="playstate-alias-show"><h4>${escapeHtml(show.title)}</h4><p>${show.rows.length} dismissed entries</p><button class="button-ghost sync-action-btn sync-tool-button" type="button" data-alias-action="restore" data-show-key="${escapeAttribute(show.showKey)}">Restore for review</button></article>`).join("")}</details>` : "";
  if (!shows.length) {
    list.innerHTML = `<p class="playstate-alias-note">Nothing to review. Every episode watch state is stored under its show, or is still being looked up.</p>${dismissedHtml}`;
    setStatus("Nothing to review", "ready");
    return;
  }
  const count = shows.reduce((total, show) => total + show.rows.length, 0);
  list.innerHTML = shows.map(renderShow).join("") + dismissedHtml;
  setStatus(`${shows.length} show${shows.length === 1 ? "" : "s"}, ${count} entr${count === 1 ? "y" : "ies"}`, "warning");
}

export async function loadPlaystateAliases() {
  const button = byId("playstateAliasScanButton");
  if (button) button.disabled = true;
  setStatus("Checking...", "warning");
  try {
    const response = await fetch("/api/playstate-aliases", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    shows = Array.isArray(body.shows) ? body.shows : [];
    dismissed = Array.isArray(body.dismissed) ? body.dismissed : [];
    render();
  } catch (error) {
    setStatus(`Error: ${error.message}`, "error");
    _setMessage(`Checking watch-state aliases failed: ${error.message}`, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function postAction(action, payload) {
  const response = await fetch(`/api/playstate-aliases/${action}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function confirmAction(button) {
  if (button.dataset.aliasAction === "restore") {
    button.disabled = true;
    postAction("restore", { showKey: button.dataset.showKey })
      .then((result) => showResult(`${result.restored} dismissed entries restored for review.`, "success"))
      .catch((error) => showResult(error.message, "error"))
      .finally(() => loadPlaystateAliases());
    return;
  }
  const show = shows.find((entry) => entry.showKey === button.dataset.showKey);
  if (!show) return;
  const count = show.rows.length;
  const entries = `${count} watch-state entr${count === 1 ? "y" : "ies"}`;
  const isFold = button.dataset.aliasAction === "fold";
  const message = isFold
    ? `Move ${entries} into ${show.title}?\n\nFor each episode the newest watch state wins and the older entry is deleted. Only Plekt's local watch state changes; nothing is sent to connected platforms. This cannot be undone.`
    : `Mark ${entries} as a different show than ${show.title}?\n\nThey are left as they are and not listed again, and the automatic repair will not move them. You can restore them from the Dismissed list.`;
  _showConfirmModal(message, async () => {
    button.disabled = true;
    try {
      if (isFold) {
        const result = await postAction("fold", { showKey: show.showKey, profile: Number(button.dataset.profile || 0) });
        showResult(`${show.title}: ${result.rekeyed} watch state(s) moved to the show, ${result.deleted} older entr${result.deleted === 1 ? "y" : "ies"} removed.`, "success");
        await _clearDerivedUiCaches();
      } else {
        await postAction("dismiss", { showKey: show.showKey });
        showResult(`${show.title}: ${entries} marked as a different show.`, "success");
      }
    } catch (error) {
      showResult(`${show.title}: ${error.message}`, "error");
    }
    await loadPlaystateAliases();
  }, { title: isFold ? "Belongs to this show" : "Different show", approveLabel: isFold ? "Move" : "Mark" });
}

export function initPlaystateAliasTools(callbacks = {}) {
  if (callbacks.setMessage) _setMessage = callbacks.setMessage;
  if (callbacks.showConfirmModal) _showConfirmModal = callbacks.showConfirmModal;
  if (callbacks.clearDerivedUiCaches) _clearDerivedUiCaches = callbacks.clearDerivedUiCaches;
  byId("playstateAliasScanButton")?.addEventListener("click", () => loadPlaystateAliases());
  byId("playstate-aliases")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open && !shows.length) loadPlaystateAliases();
  });
  byId("playstateAliasList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-alias-action]");
    if (button) confirmAction(button);
  });
}
