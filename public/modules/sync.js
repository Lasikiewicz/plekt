import { buildAuthHeaders, buildNowPlayingUrl } from "./auth.js?v=2.0.0.3.4";
import { state, elements } from "./state.js?v=2.0.0.3.4";
import { escapeHtml, escapeAttribute, platformBadge, sourceClass, sourceBadgeHtml, computeProgress, formatDate, formatPlaybackClock, showName } from "./utils.js?v=2.0.0.3.4";
import { hydratePosters, posterMarkup } from "./images.js?v=2.0.0.3.4";

const NOW_PLAYING_POLL_MS = 10000;

let _cb = {};
let nowPlayingRequestController = null;
let nowPlayingRequestGeneration = 0;
let nowPlayingRequestStartedAt = 0;
const NOW_PLAYING_REQUEST_STALE_MS = 30000;

export function initSync(callbacks) {
  _cb = callbacks;
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function nowPlayingUrl() {
  return buildNowPlayingUrl(window.location.origin);
}

export function telemetryLineValue(telemetry = "", label = "") {
  const prefix = `${label}:`;
  const line = String(telemetry || "").split(/\r?\n/).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

export function historyAction(entry = {}) {
  const action = String(entry.sync_action || "").toLowerCase();
  if (["unwatched", "unplayed"].includes(action)) return "Marked Unwatched";
  const telemetryAction = telemetryLineValue(entry.sync_dispatch_telemetry, "Action");
  if (/unwatched|unplayed/i.test(telemetryAction)) return "Marked Unwatched";
  return "Marked Watched";
}

export function isWatchedHistoryAction(entry = {}) {
  return historyAction(entry) !== "Marked Unwatched";
}

export function syncStatus(entry = {}) {
  const telemetry = String(entry.sync_dispatch_telemetry || "");
  if (telemetry.includes("Force Sync resolved status to")) {
    return { tone: "success", label: "Full sync complete", detail: telemetry };
  }
  const status = telemetryLineValue(telemetry, "Dispatch status").toLowerCase();
  const origin = telemetryLineValue(telemetry, "Origin").toLowerCase();
  const details = telemetryLineValue(telemetry, "Details").toLowerCase();
  const hasTargetTelemetry = telemetryTargetStates(telemetry).length > 0;
  if (origin.endsWith("_initial_sync") && !hasTargetTelemetry && details.includes("awaiting outbound sync telemetry")) {
    return { tone: "success", label: "Sync skipped intentionally", detail: "This row came from an initial history import and has no active outbound sync job." };
  }
  if (status === "success") {
    return { tone: "success", label: "Full sync complete", detail: "All configured target apps accepted this watched-state change." };
  }
  if (["pending", "queued", "in_progress", "in progress"].includes(status)) {
    return { tone: "pending", label: "Sync in progress", detail: "Propagation is queued or waiting for target app responses." };
  }
  if (status === "skipped") {
    return { tone: "success", label: "Sync skipped intentionally", detail: "No outbound sync was required for this history row." };
  }
  return { tone: "error", label: "Sync needs attention", detail: status ? "One or more target apps did not confirm this watched-state change." : "No dispatch telemetry was recorded for this history row." };
}

function normalizedSyncText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function syncLabelMatchesEntry(entry = {}, label = "") {
  const currentLabel = normalizedSyncText(label);
  if (!currentLabel) return false;
  const mediaType = String(entry.media_type || entry.mediaType || entry.type || "").toLowerCase();
  if (mediaType === "episode" || entry.season != null || entry.episode != null || entry.seasonNumber != null || entry.episodeNumber != null) {
    const showTitle = normalizedSyncText(entry.show_title || entry.showTitle || entry.title || "");
    const season = Number(entry.season ?? entry.seasonNumber);
    const episode = Number(entry.episode ?? entry.episodeNumber);
    if (!showTitle || !Number.isInteger(season) || !Number.isInteger(episode)) return false;
    const code = `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
    return currentLabel.includes(showTitle) && currentLabel.includes(code);
  }
  const title = normalizedSyncText(entry.title || entry.name || "");
  return Boolean(title && currentLabel === title);
}

// Pending telemetry identifies imported/queued rows. The current-item label
// covers force and scheduled syncs while the row is being written, before its
// final telemetry snapshot reaches the browser.
export function isMediaSyncing(entry = {}) {
  const progress = state.syncProgress || {};
  if (syncStatus(entry).tone === "pending") return true;
  if (!progress.active) return false;
  return syncLabelMatchesEntry(entry, progress.currentItemLabel);
}

export function mediaSyncNoticeHtml(entries = [], scopeLabel = "this item") {
  const affected = (Array.isArray(entries) ? entries : []).filter((entry) => isMediaSyncing(entry));
  if (!affected.length) return "";
  return `
    <div class="media-detail-sync-notice" data-media-detail-sync-notice role="status" aria-live="polite">
      <span class="media-detail-sync-notice-spinner" aria-hidden="true"></span>
      <span><strong>Syncing…</strong> Plekt is updating ${escapeHtml(scopeLabel)}. Watch controls are paused until the sync completes.</span>
    </div>
  `;
}

export function historySyncPill(entry = {}) {
  return `
    <span class="history-sync-row">
      <span class="history-action-pill ${sourceClass(entry.source)}">${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(historyAction(entry))}</span>
      ${renderSyncStatusDot(entry)}
    </span>
  `;
}

export function getActiveTargets() {
  const targets = [];
  // /api/config exposes a `configured` flag per section instead of raw credentials.
  if (state.savedConfig.plex?.baseUrl && state.savedConfig.plex?.configured && !state.savedConfig.plex?.disabled) targets.push("plex");
  if (state.savedConfig.emby?.baseUrl && state.savedConfig.emby?.configured && state.savedConfig.emby?.userId && !state.savedConfig.emby?.disabled) targets.push("emby");
  if (state.savedConfig.jellyfin?.baseUrl && state.savedConfig.jellyfin?.configured && state.savedConfig.jellyfin?.userId && !state.savedConfig.jellyfin?.disabled) targets.push("jellyfin");
  return targets;
}

export function sourcePlatform(value = "") {
  const source = String(value || "").toLowerCase();
  if (source.startsWith("plex")) return "plex";
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "";
}

export function normalizeTargetStatus(value = "") {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["fulfilled", "ok", "complete", "completed"].includes(status)) return "success";
  if (["queued", "in_progress", "checking"].includes(status)) return "pending";
  if (["not_found", "not_attempted", "unavailable"].includes(status)) return "skipped";
  return status || "pending";
}

export function targetStateUnavailable(targetState = {}) {
  const text = `${targetState.rawStatus || targetState.status || ""} ${targetState.detail || ""}`.toLowerCase();
  return text.includes("no matching") || text.includes("not_found") || text.includes("not found") || text.includes("unavailable");
}

export function targetStateNoop(targetState = {}) {
  const text = `${targetState.rawStatus || targetState.status || ""} ${targetState.detail || ""}`.toLowerCase();
  return text.includes("not attempted") || text.includes("historical import") || text.includes("stored locally");
}

export function hasConfirmedMediaAvailability(entry = {}, states = []) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  if (telemetry.includes("Force Sync resolved status to success")) return true;
  if (activeTargets.includes(sourcePlatform(entry.source))) return true;
  return states.some((s) => normalizeTargetStatus(s.status) === "success");
}

export function sharedLibraryAvailability(entry = {}, states = telemetryTargetStates(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "")) {
  if (!hasConfirmedMediaAvailability(entry, states)) return null;
  return { statusClass: "success", statusLabel: "Available" };
}

export function getMediaTargetSyncStatus(entry = {}) {
  const activeTargets = getActiveTargets();
  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");

  if (telemetry.includes("Force Sync resolved status to success")) {
    return activeTargets.map(target => ({ target, status: "success" }));
  }

  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const available = hasConfirmedMediaAvailability(entry, states);

  return activeTargets.map((target) => {
    if (source === target || source.startsWith(`${target}_`)) {
      return { target, status: "success" };
    }
    const match = states.find((s) => s.target === target);
    if (match) {
      const status = normalizeTargetStatus(match.status);
      if (status === "success" || status === "pending" || status === "error") {
        return { target, status };
      }
      if ((targetStateUnavailable(match) || targetStateNoop(match)) && !available) {
        return { target, status: "skipped", hidden: true, detail: match.detail };
      }
      if (targetStateUnavailable(match) && available) {
        return { target, status: "error", detail: match.detail };
      }
      if (targetStateNoop(match) && available) {
        return { target, status: "pending", detail: match.detail };
      }
      return { target, status: "skipped", detail: match.detail };
    }

    if (telemetry.includes("Details: Historical import stored locally") || telemetry.includes("Origin: import")) {
      return { target, status: "skipped", hidden: true };
    }

    if (!available) {
      return { target, status: "skipped", hidden: true };
    }

    return { target, status: "pending" };
  });
}

export function getSyncStatusTone(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "success";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  if (statuses.some((s) => s.status === "error")) {
    return "error";
  }
  if (statuses.some((s) => s.status === "pending")) {
    return "pending";
  }
  return "success";
}

export function getSyncStatusTooltip(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "No targets configured";
  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "No sync status needed";
  return `Watched sync: ${statuses.map(s => `${platformBadge(s.target)} ${s.status}`).join(", ")}`;
}

export function renderSyncStatusDot(entry = {}, style = "") {
  const tone = getSyncStatusTone(entry);
  if (!tone) return "";
  const tooltip = getSyncStatusTooltip(entry);
  const styleAttr = style ? ` style="${escapeAttribute(style)}"` : "";
  return `<span class="sync-status-dot sync-status-dot--${tone}" data-sync-status-dot="true" role="button" tabindex="0" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"${styleAttr}></span>`;
}

export function showAvailIssuePopup(anchorEl) {
  const existing = document.getElementById("avail-issue-popup");
  if (existing) existing.remove();

  const message = anchorEl.dataset.availIssue || "Unknown issue.";
  const lines = message.split("\\n");
  const [headline, ...steps] = lines;

  const popup = document.createElement("div");
  popup.id = "avail-issue-popup";
  popup.className = "avail-issue-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "false");

  const stepsHtml = steps.length
    ? `<ol class="avail-issue-steps">${steps.map(s => `<li>${escapeHtml(s.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`
    : "";

  popup.innerHTML = `
    <button class="avail-issue-close" type="button" aria-label="Close">✕</button>
    <b class="avail-issue-headline">${escapeHtml(headline)}</b>
    ${stepsHtml ? `<p class="avail-issue-fix-label">Steps to fix:</p>${stepsHtml}` : ""}
  `;

  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  const popupW = 280;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 6;
  if (left + popupW > window.innerWidth - 12) left = window.innerWidth - popupW - 12;
  if (left < 8) left = 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const closePopup = (event) => {
    if (!popup.contains(event?.target) || event?.target.classList.contains("avail-issue-close")) {
      popup.remove();
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", escKey);
    }
  };
  const outsideClick = (event) => {
    if (!popup.contains(event.target) && event.target !== anchorEl) closePopup(event);
  };
  const escKey = (event) => { if (event.key === "Escape") closePopup(); };

  popup.querySelector(".avail-issue-close").addEventListener("click", closePopup);
  setTimeout(() => {
    document.addEventListener("click", outsideClick, true);
    document.addEventListener("keydown", escKey);
  }, 0);
}

export function renderAvailabilityPills(entry = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const telemetry = String(entry.sync_dispatch_telemetry || entry.syncDispatchTelemetry || "");
  const states = telemetryTargetStates(telemetry);
  const source = String(entry.source || "").toLowerCase();
  const sharedAvailability = sharedLibraryAvailability(entry, states);

  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";

    if (sharedAvailability) {
      statusClass = sharedAvailability.statusClass;
    } else if (source === target || source.startsWith(`${target}_`)) {
      statusClass = "success";
    } else {
      const match = states.find((s) => s.target === target);
      if (match) {
        if (match.status === "success") {
          statusClass = "success";
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          statusClass = "error";
          issueDetail = `${platformBadge(target)} could not find this title in your library. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your ${platformBadge(target)} server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check all platforms.`;
        } else if (match.status === "error") {
          const detailLower = String(match.detail || "").toLowerCase();
          if (detailLower.includes("not found") || detailLower.includes("404") || detailLower.includes("not_found")) {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} returned a 'not found' error for this title. Steps to fix:\n1. Confirm the title exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check your server URL and API credentials in Settings.`;
          } else {
            statusClass = "error";
            issueDetail = `${platformBadge(target)} reported an error: ${match.detail || "unknown error"}. Steps to fix:\n1. Check your ${platformBadge(target)} server is running and reachable.\n2. Verify your API key / token in Settings.\n3. Use Force Sync to retry.`;
          }
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync is still in progress. Steps to fix:\n1. Wait a moment and refresh.\n2. If it stays pending, use Force Sync.\n3. Check the Sync Jobs panel for details.`;
        }
      } else {
        if (telemetry.includes("Historical import stored locally") || telemetry.includes("Origin: import")) {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} sync has not run yet for this imported item. Steps to fix:\n1. Use Force Sync to push this watched-state to all platforms.\n2. Check the Sync Jobs panel for progress.`;
        } else {
          statusClass = "pending";
          issueDetail = `${platformBadge(target)} availability is unknown. Steps to fix:\n1. Use Force Sync to check all platforms.\n2. Verify ${platformBadge(target)} credentials in Settings.`;
        }
      }
    }

    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

export function renderShowAvailabilityPills(show = {}) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const episodes = show.episodes || [];
  const watchedEpisodes = episodes.filter(e => isWatchedHistoryAction(e));
  const sharedAvailable = watchedEpisodes.some((episode) => sharedLibraryAvailability(episode));

  return activeTargets.map((target) => {
    let statusClass = "pending";
    let issueDetail = "";

    let anyAvailable = false;
    let anyChecked = false;
    let allUnavailable = true;

    for (const ep of watchedEpisodes) {
      const source = String(ep.source || "").toLowerCase();
      if (source === target || source.startsWith(`${target}_`)) {
        anyAvailable = true;
        anyChecked = true;
        allUnavailable = false;
        break;
      }

      const telemetry = String(ep.sync_dispatch_telemetry || ep.syncDispatchTelemetry || "");
      const states = telemetryTargetStates(telemetry);
      const match = states.find((s) => s.target === target);
      if (match) {
        anyChecked = true;
        if (match.status === "success") {
          anyAvailable = true;
          allUnavailable = false;
          break;
        } else if (match.status === "skipped" && (match.detail.includes("No matching") || match.detail.includes("not_found") || match.detail.includes("not found"))) {
          // Continue loop - item not found on this target, keep checking
        } else {
          allUnavailable = false;
        }
      } else {
        allUnavailable = false;
      }
    }

    if (sharedAvailable || anyAvailable) {
      statusClass = "success";
    } else if (anyChecked && allUnavailable && watchedEpisodes.length > 0) {
      statusClass = "error";
      issueDetail = `${platformBadge(target)} could not find this show in your library. Steps to fix:\n1. Confirm the show exists in your ${platformBadge(target)} library.\n2. Run a library scan in ${platformBadge(target)}.\n3. Check that your server URL and credentials are correct in Settings.\n4. Use Force Sync to re-check.`;
    } else {
      statusClass = "pending";
      issueDetail = `${platformBadge(target)} availability is still being determined. Steps to fix:\n1. Use Force Sync to push watched-state to all platforms.\n2. Check the Sync Jobs panel for details.\n3. Verify ${platformBadge(target)} credentials in Settings.`;
    }

    const displayTarget = platformBadge(target);
    const issueAttr = (statusClass !== "success" && issueDetail) ? ` data-avail-issue="${escapeAttribute(issueDetail)}" role="button" tabindex="0" style="cursor:pointer;"` : "";
    return `<span class="target-pill avail-pill" data-status="${statusClass}"${issueAttr} title="${escapeAttribute(displayTarget)}">${escapeHtml(displayTarget)}</span>`;
  }).join(" ");
}

export function renderMediaSyncPills(entry = {}, showRetry = true) {
  const activeTargets = getActiveTargets();
  if (!activeTargets.length) return "";

  const statuses = getMediaTargetSyncStatus(entry).filter((s) => !s.hidden);
  if (!statuses.length) return "";
  const allSynced = statuses.every((s) => s.status === "success" || s.status === "skipped");

  const pillsHtml = statuses
    .map((s) => {
      const statusClass = s.status === "success" ? "success" : s.status === "pending" ? "pending" : "error";
      return `<span class="target-pill" data-status="${statusClass}" style="font-size: 0.62rem; padding: 0.1rem 0.35rem; margin-right: 0.2rem;" title="${escapeAttribute(`${platformBadge(s.target)}: ${s.status}`)}">${escapeHtml(platformBadge(s.target))}</span>`;
    })
    .join("");

  const retryButtonHtml = (showRetry && !allSynced)
    ? `<button class="retry-sync-btn" type="button" data-retry-sync-id="${escapeAttribute(entry.id)}" title="Retry syncing watched state to all platforms">Retry</button>`
    : "";

  return `
    <div class="media-sync-row">
      <div class="media-sync-pills">
        ${pillsHtml}
      </div>
      ${retryButtonHtml}
    </div>
  `;
}

export function telemetryTargetStates(telemetry = "") {
  const rows = [];
  for (const line of String(telemetry || "").split(/\r?\n/)) {
    const match = line.match(/^(?:Target\s+)?(Plex|Emby|Jellyfin)\s+(?:progress\s+)?status:\s*([^-]+)(?:\s+-\s*(.*))?$/i);
    if (!match) continue;
    rows.push({
      target: match[1].toLowerCase(),
      status: normalizeTargetStatus(match[2]),
      rawStatus: match[2].trim().toLowerCase(),
      detail: (match[3] || "").trim(),
    });
  }
  return rows;
}

export function syncJobSortWeight(job = {}) {
  const status = syncStatus(job).tone;
  if (status === "pending") return 0;
  if (status === "error") return 1;
  return 2;
}

export function renderTargetPills(job = {}) {
  const targets = telemetryTargetStates(job.sync_dispatch_telemetry);
  if (!targets.length) return `<span class="target-pill" data-status="error">No target telemetry</span>`;
  return targets
    .map((target) => {
      const status = target.status === "success" ? "success" : target.status === "pending" ? "pending" : "error";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${status}" title="${escapeAttribute(`${platformBadge(target.target)} ${target.status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(target.status)}</span>`;
    })
    .join("");
}

export function syncJobMediaType(job = {}) {
  return String(job.media_type || "").toLowerCase() === "movie" ? "movie" : "tv";
}

export function syncHistoryTone(entry = {}) {
  const status = String(entry.status || "").toLowerCase();
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (status === "error" || targets.some((target) => String(target.status || "").toLowerCase() === "error")) return "error";
  if (["pending", "queued", "in_progress", "partial"].includes(status)) return "pending";
  return "success";
}

export function syncHistoryActionLabel(entry = {}) {
  const action = String(entry.action || "").toLowerCase();
  if (action === "progress") return "Resume Progress";
  if (action === "unwatched" || action === "unplayed") return "Marked Unwatched";
  return "Marked Watched";
}

export function syncHistoryTargetPills(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  if (!targets.length) return `<span class="target-pill" data-status="pending">No target detail</span>`;
  return targets
    .map((target) => {
      const status = String(target.status || "unknown").toLowerCase();
      const tone = status === "success" ? "success" : status === "error" ? "error" : "pending";
      const detail = target.detail ? ` - ${target.detail}` : "";
      return `<span class="target-pill" data-status="${tone}" title="${escapeAttribute(`${platformBadge(target.target)} ${status}${detail}`)}">${escapeHtml(platformBadge(target.target))}: ${escapeHtml(status)}</span>`;
    })
    .join("");
}

export function categorizeIssues(jobs = []) {
  const categories = {
    missingTelemetry: [],
    plexMismatch: [],
    targetMismatch: [],
    otherIssues: [],
  };

  for (const job of jobs) {
    const telemetry = job.sync_dispatch_telemetry || "";
    if (!telemetry || telemetry.trim() === "") {
      categories.missingTelemetry.push(job);
    } else if (telemetry.includes("plex") && telemetry.includes("No matching item found")) {
      categories.plexMismatch.push(job);
    } else if (telemetry.includes("Synced to no targets")) {
      categories.targetMismatch.push(job);
    } else {
      categories.otherIssues.push(job);
    }
  }
  return categories;
}

export function renderIssueCategory(categoryName, jobs = [], helpText = "") {
  if (!jobs.length) return "";

  const titles = {
    missingTelemetry: "Missing Dispatch Telemetry",
    plexMismatch: "Plex Match Issues",
    targetMismatch: "Emby/Jellyfin Match Issues",
    otherIssues: "Unresolved Sync Issues",
  };

  const showFixButtons = categoryName !== 'missingTelemetry';

  return `
    <details class="issue-category">
      <summary class="accordion-header">
        <div class="sync-tool-summary-title">
          <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
          <b>${titles[categoryName] || categoryName}</b>
          <span class="status-pill status-muted">${jobs.length} issue${jobs.length !== 1 ? "s" : ""}</span>
        </div>
        <span>${escapeHtml(helpText)}</span>
      </summary>
      <div style="padding: var(--space-3); border-top: 1px solid var(--line);">
        <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-3);">
          ${categoryName === 'missingTelemetry' ? `<button class="button-primary sync-action-btn sync-tool-button" type="button" data-action="clearMissingTelemetry">Clear ${jobs.length} Records</button>` : `<button class="button-primary sync-action-btn sync-tool-button" type="button" data-action="retryAllCategory" data-category="${categoryName}">Retry All ${jobs.length}</button>`}
        </div>
        <div style="display: grid; gap: var(--space-2);">
          ${jobs.map(job => {
            const telemetry = String(job.sync_dispatch_telemetry || "");
            return `
            <details class="sync-issue-card" style="background: rgba(0,0,0,0.02); border-left: 3px solid var(--color-warning); border-radius: var(--radius-sm); overflow: hidden;">
              <summary class="accordion-header" style="display: flex; gap: var(--space-2); align-items: center; padding: var(--space-2); cursor: pointer; list-style: none;">
                <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 500; word-break: break-word;">${escapeHtml(job.title || "Unknown")}</div>
                  <div style="font-size: 0.85rem; opacity: 0.7; margin-top: 0.25rem;">
                    ${escapeHtml(platformBadge(job.source))} • ${escapeHtml(job.media_type || "unknown")} • ${escapeHtml(formatDate(job.watched_at))}
                  </div>
                </div>
                ${showFixButtons ? `
                  <div style="display: flex; gap: var(--space-1); flex-shrink: 0; align-items: center;">
                    <button class="button-ghost media-fix-match-btn sync-btn" type="button" data-edit-id="${escapeAttribute(job.id)}" data-title="${escapeAttribute(job.title || "")}" data-media-type="${escapeAttribute(syncJobMediaType(job))}" style="font-size: 0.75rem; padding: 0.35rem 0.7rem; white-space: nowrap;">Fix</button>
                    <button class="retry-sync-btn sync-job-retry-btn sync-btn" type="button" data-retry-sync-id="${escapeAttribute(job.id)}" style="font-size: 0.75rem; padding: 0.35rem 0.7rem; white-space: nowrap;">Retry</button>
                    <button class="button-ghost dismiss-issue-btn sync-btn" type="button" data-dismiss-id="${escapeAttribute(job.id)}" title="Dismiss this issue" style="font-size: 0.75rem; padding: 0.35rem 0.55rem; color: var(--muted); white-space: nowrap;">✕</button>
                  </div>
                ` : ''}
              </summary>
              ${telemetry ? `
                <div style="background: rgba(0,0,0,0.05); padding: var(--space-2); border-top: 1px solid rgba(0,0,0,0.1); font-size: 0.75rem; font-family: monospace; line-height: 1.4; word-break: break-word; white-space: pre-wrap;">
                  <div style="margin-bottom: var(--space-1); font-weight: 500; opacity: 0.7;">Sync Telemetry Details:</div>
                  ${escapeHtml(telemetry)}
                </div>
              ` : `
                <div style="background: rgba(0,0,0,0.05); padding: var(--space-2); border-top: 1px solid rgba(0,0,0,0.1); font-size: 0.8rem; opacity: 0.7;">
                  ${showFixButtons ? 'Click "Retry" to view detailed error information' : 'No telemetry details available.'}
                </div>
              `}
            </details>
          `;
          }).join("")}
        </div>
      </div>
    </details>
  `;
}

export function renderSyncJobs() {
  const container = document.getElementById("syncIssuesContainer");
  if (!container) return;

  if (state.syncJobsLoading) {
    if (elements.syncSummary) elements.syncSummary.textContent = "Loading...";
    return;
  }

  const jobs = [...state.syncJobs];
  const categories = categorizeIssues(jobs);
  const totalIssues = jobs.length;
  const hasIssues = totalIssues > 0;

  if (elements.syncSummary) {
    const summary = hasIssues
      ? `${totalIssues} issue${totalIssues !== 1 ? "s" : ""}`
      : "All clear";
    elements.syncSummary.textContent = summary;
    elements.syncSummary.className = `status-pill ${hasIssues ? "status-error" : "status-ready"}`;
  }

  if (!hasIssues) {
    container.innerHTML = `
      <details id="sync-issues-status" class="sync-tool-details settings-static-details" open>
        <summary class="accordion-header" tabindex="-1">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>No sync issues</b>
          </div>
          <span>All watched-state dispatches are up to date</span>
        </summary>
        <div class="tool-item-row">
          <p style="margin: 0; color: var(--muted); font-size: 0.85rem;">All watched states, resume positions, and history records across your media servers are fully synchronized. No dispatches are currently failing or pending.</p>
        </div>
      </details>
    `;
    return;
  }

  const html = `
    ${renderIssueCategory('missingTelemetry', categories.missingTelemetry,
      'Records without dispatch telemetry are old or incomplete. They likely synced successfully but logging was missing. Safe to clear without affecting actual sync.')}
    ${renderIssueCategory('plexMismatch', categories.plexMismatch,
      'Plex could not find matching items. Check Plex metadata, external IDs, or library content. Emby/Jellyfin may have synced successfully.')}
    ${renderIssueCategory('targetMismatch', categories.targetMismatch,
      'Plex found the item but Emby/Jellyfin could not. Check their metadata and external IDs to match Plex.')}
    ${renderIssueCategory('otherIssues', categories.otherIssues,
      'These items have unresolved sync issues. Check the telemetry for details on what went wrong.')}
  `;

  container.innerHTML = html;
}

export function renderSyncHistory() {
  if (!elements.syncHistoryPanel) return;

  if (state.syncHistoryLoading) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>Loading sync history</b><span>Fetching recent propagation attempts.</span></div>`;
    if (elements.syncHistorySummary) elements.syncHistorySummary.textContent = "Loading";
    return;
  }

  const history = [...state.syncHistory].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

  if (elements.syncHistorySummary) {
    elements.syncHistorySummary.textContent = "Log only";
    elements.syncHistorySummary.className = "status-pill status-muted";
  }

  if (!history.length) {
    elements.syncHistoryPanel.innerHTML = `<div class="empty-log"><b>No sync history yet</b><span>New webhook, cron, and resume propagation attempts will appear here.</span></div>`;
    return;
  }

  elements.syncHistoryPanel.innerHTML = history
    .map((entry) => {
      const tone = syncHistoryTone(entry);
      const debug = entry.rawPayloadDebug && Object.keys(entry.rawPayloadDebug).length ? JSON.stringify(entry.rawPayloadDebug, null, 2) : "";
      return `
        <details class="sync-history-card">
          <summary class="sync-history-summary">
            <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
            <b>${escapeHtml(entry.title || "Unknown media")}</b>
          </summary>
          <div class="sync-job-main">
            <div class="sync-job-title">
              <span>${escapeHtml(platformBadge(entry.source))} - ${escapeHtml(syncHistoryActionLabel(entry))} - ${escapeHtml(formatDate(entry.timestamp))}</span>
            </div>
            <span class="status-pill ${tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready"}">${escapeHtml(entry.status || "unknown")}</span>
          </div>
          <div class="sync-job-meta">
            <div><span>Action</span><b>${escapeHtml(syncHistoryActionLabel(entry))}</b></div>
            <div><span>Media</span><b>${escapeHtml(entry.mediaType || "unknown")}</b></div>
            <div><span>Source</span><b>${escapeHtml(platformBadge(entry.source))}</b></div>
            <div><span>Details</span><b>${escapeHtml(entry.details || "No details")}</b></div>
          </div>
          <div class="sync-target-row">${syncHistoryTargetPills(entry)}</div>
          ${debug ? `<pre class="sync-telemetry">${escapeHtml(debug)}</pre>` : ""}
        </details>
      `;
    })
    .join("");
}

export async function loadSyncJobs({ force = false } = {}) {
  if (!state.token || (state.syncJobsLoading && !force)) return state.syncJobs;
  state.syncJobsLoading = true;
  renderSyncJobs();
  try {
    const url = new URL("/api/sync-jobs", window.location.origin);
    url.searchParams.set("status", "outstanding");
    url.searchParams.set("limit", "150");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync jobs load failed with ${response.status}`);
    state.syncJobs = Array.isArray(body.jobs) ? body.jobs : [];
    state.syncJobsLoaded = true;
    return state.syncJobs;
  } finally {
    state.syncJobsLoading = false;
    renderSyncJobs();
  }
}

// maxAgeMs lets a route that re-renders during one navigation reuse the list it
// just loaded instead of asking again.
let syncHistoryLoadedAt = 0;
export async function loadSyncHistory({ force = false, maxAgeMs = 0 } = {}) {
  if (!state.token || (state.syncHistoryLoading && !force)) return state.syncHistory;
  if (!force && maxAgeMs && state.syncHistoryLoaded && Date.now() - syncHistoryLoadedAt < maxAgeMs) return state.syncHistory;
  state.syncHistoryLoading = true;
  renderSyncHistory();
  try {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync history load failed with ${response.status}`);
    state.syncHistory = Array.isArray(body.history) ? body.history : [];
    state.syncHistoryLoaded = true;
    syncHistoryLoadedAt = Date.now();
    return state.syncHistory;
  } finally {
    state.syncHistoryLoading = false;
    renderSyncHistory();
  }
}

export function activeSessionsKey(sessions = []) {
  if (!sessions.length) return "empty";
  return sessions
    .map((session) => {
      const progress = Math.round(Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs) ?? 0));
      return [
        session.source || "",
        session.sessionId || session.id || "",
        session.mediaType || session.media_type || "",
        session.title || "",
        session.season ?? "",
        session.episode ?? "",
        session.client?.userName || "",
        session.client?.deviceName || "",
        progress,
        // Pausing freezes progress, so without this the play/pause transition
        // would produce an identical key and never repaint the card.
        session.paused === true || session.playbackState === "paused" ? "paused" : "playing",
      ].join("|");
    })
    .sort()
    .join("::");
}

let lastNowPlayingItemsKey = "";

export function setActiveSessions(sessions = [], { force = false } = {}) {
  const nextKey = activeSessionsKey(sessions);
  if (!force && nextKey === state.nowPlayingSessionKey) return false;
  state.activeSessions = sessions;
  state.nowPlayingSessionKey = nextKey;
  renderActiveSessions();
  // Up Next moves whatever is playing to the top, so it repaints when the
  // playing items change (not on every progress tick).
  const itemsKey = sessions.map((s) => `${s.mediaType}|${s.title}|${s.season ?? ""}|${s.episode ?? ""}`).sort().join("::");
  if (itemsKey !== lastNowPlayingItemsKey) {
    lastNowPlayingItemsKey = itemsKey;
    _cb.renderUpNext?.();
  }
  return true;
}

function isServerArtworkUrl(value = "") {
  const raw = String(value || "").trim();
  return /^\/media\/(?:posters|backdrops)\//i.test(raw)
    || /^\/demo-assets\//i.test(raw)
    || /^\/api\/(?:poster|tmdb-poster|remote-artwork)(?:[/?]|$)/i.test(raw);
}

export function nowPlayingPosterItem(session = {}) {
  const posterId = session.media_key || session.mediaKey || "";
  if (posterId) {
    const item = { ...session, id: posterId, media_key: posterId, prefer_raw_poster: true, cache_only_artwork: true, eager_poster: true };
    const suppliedPoster = session.poster_url || session.posterUrl || "";
    // Provider session payloads contain credential-free relative image paths
    // (for example /library/metadata/... or /Items/...); those paths cannot be
    // loaded by the browser. Point the initial render at the authenticated
    // media-key proxy so the card does not flash a placeholder while the
    // background poster hydration request is still running.
    if (!isServerArtworkUrl(suppliedPoster)) {
      item.poster_url = `/api/poster?format=image&id=${encodeURIComponent(String(posterId))}&v=2`;
    }
    return item;
  }

  const item = { ...session };
  delete item.id;
  return { ...item, cache_only_artwork: true };
}

function nowPlayingCardIdentity(session = {}) {
  return [
    session.source || "",
    session.sessionId || session.id || session.media_key || session.mediaKey || "",
    session.mediaType || session.media_type || "",
    session.title || "",
    session.season ?? "",
    session.episode ?? "",
    session.client?.userName || "",
    session.client?.deviceName || "",
  ].join("|");
}

function nowPlayingCardStaticIdentity(session = {}) {
  return [
    nowPlayingCardIdentity(session),
    session.episodeTitle || "",
    session.source || "",
    session.poster_url || session.posterUrl || "",
    session.media_key || session.mediaKey || "",
  ].join("|");
}

function nowPlayingPosterKey(poster) {
  if (!poster) return "";
  const posterId = String(poster.getAttribute("data-poster-id") || "");
  if (posterId) return `id:${posterId}`;
  return `src:${String(poster.currentSrc || poster.getAttribute("src") || "")}`;
}

function preserveNowPlayingPoster(currentCard, nextCard) {
  const currentPoster = currentCard?.querySelector?.(".now-poster-large-wrapper img, .now-poster-large-wrapper .poster-fallback");
  const nextPoster = nextCard?.querySelector?.(".now-poster-large-wrapper img, .now-poster-large-wrapper .poster-fallback");
  if (!currentPoster || !nextPoster || nowPlayingPosterKey(currentPoster) !== nowPlayingPosterKey(nextPoster)) return;
  nextPoster.replaceWith(currentPoster);
}

function patchNowPlayingProgress(currentCard, nextCard) {
  const nextFill = nextCard.querySelector(".now-card-progress-fill");
  const currentFill = currentCard.querySelector(".now-card-progress-fill");
  if (nextFill && currentFill) {
    currentFill.className = nextFill.className;
    currentFill.style.width = nextFill.style.width;
  }
  const nextClock = nextCard.querySelector(".now-card-progress-text");
  const currentClock = currentCard.querySelector(".now-card-progress-text");
  if (nextClock && currentClock) currentClock.textContent = nextClock.textContent;

  const nextIndicator = nextCard.querySelector(".stream-indicator");
  const currentIndicator = currentCard.querySelector(".stream-indicator");
  if (nextIndicator && currentIndicator) {
    currentIndicator.className = nextIndicator.className;
    currentIndicator.textContent = nextIndicator.textContent;
  }
}

function reconcileNowPlayingCards(grid, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const nextCards = [...template.content.children].filter((node) => node.matches?.("[data-now-playing-card-id]"));

  // The grid starts with the empty-state placeholder. In-place reconciliation
  // only tracks card nodes, so remove that placeholder when the first live
  // snapshot arrives instead of leaving it beside the active cards.
  for (const child of [...grid.children]) {
    if (!child.matches?.("[data-now-playing-card-id]")) child.remove();
  }

  const currentCards = [...grid.children].filter((node) => node.matches?.("[data-now-playing-card-id]"));
  const currentById = new Map(currentCards.map((card) => [card.dataset.nowPlayingCardId, card]));
  const nextIds = new Set(nextCards.map((card) => card.dataset.nowPlayingCardId));

  for (let index = 0; index < nextCards.length; index += 1) {
    const nextCard = nextCards[index];
    const id = nextCard.dataset.nowPlayingCardId;
    let currentCard = currentById.get(id);
    if (currentCard) {
      if (currentCard.dataset.nowPlayingStaticKey === nextCard.dataset.nowPlayingStaticKey) {
        patchNowPlayingProgress(currentCard, nextCard);
      } else {
        preserveNowPlayingPoster(currentCard, nextCard);
        currentCard.replaceWith(nextCard);
        currentCard = nextCard;
        currentById.set(id, currentCard);
      }
      if (grid.children[index] !== currentCard) grid.insertBefore(currentCard, grid.children[index] || null);
      continue;
    }
    grid.insertBefore(nextCard, grid.children[index] || null);
    currentById.set(id, nextCard);
  }

  for (const card of [...grid.children].filter((node) => node.matches?.("[data-now-playing-card-id]"))) {
    if (!nextIds.has(card.dataset.nowPlayingCardId)) card.remove();
  }
}

export function renderActiveSessions() {
  if (!elements.nowPlayingGrid) return;

  if (!state.activeSessions.length) {
    const emptyHtml = `
      <div class="idle-state">
        <b>No media currently playing.</b>
      </div>
    `;
    if (elements.nowPlayingGrid.dataset.renderedHtml !== "empty" || elements.nowPlayingGrid.querySelector("[data-now-playing-card-id]")) {
      elements.nowPlayingGrid.dataset.renderedHtml = "empty";
      elements.nowPlayingGrid.innerHTML = emptyHtml;
    }
    delete elements.nowPlayingGrid.dataset.renderedKey;
    if (elements.nowPlayingStatus) elements.nowPlayingStatus.textContent = "";
    _cb.updateDashboardSplitState?.();
    return;
  }

  const nextHtml = state.activeSessions
    .map((session) => {
      const progress = Math.max(0, Math.min(100, Number(session.progress ?? computeProgress(session.offsetMs, session.durationMs))));
      const href = _cb.nowPlayingHref?.(session) ?? "";
      const posterItem = nowPlayingPosterItem(session);
      const isEpisode = session.mediaType === "episode" || (session.season != null && session.episode != null);
      const showTitle = isEpisode ? (session.showTitle || showName(session.title)) : session.title;
      const epLabel = isEpisode && session.season != null && session.episode != null
        ? `S${String(session.season).padStart(2, "0")}E${String(session.episode).padStart(2, "0")}${session.episodeTitle ? ` - ${session.episodeTitle}` : ""}`
        : "";
      const userName = session.client?.userName || "";
      const deviceName = session.client?.deviceName || "";
      // A paused session stays on the rail because the media server still holds
      // it open, but it is not playing - label it rather than calling it Live.
      const isPaused = session.paused === true || session.playbackState === "paused";
      return `
        <button class="now-card-large live-now-card" type="button" data-now-playing-card-id="${escapeAttribute(nowPlayingCardIdentity(session))}" data-now-playing-static-key="${escapeAttribute(nowPlayingCardStaticIdentity(session))}" data-now-playing-href="${escapeAttribute(href)}" aria-label="Open ${escapeAttribute(session.title)} details">
          <span class="now-poster-large-wrapper">
            ${posterMarkup(posterItem, "now-poster-large")}
          </span>
          <div class="now-card-details">
            <div class="now-card-header">
              <div class="now-card-head">
                <span class="stream-indicator${isPaused ? " is-paused" : ""}">${isPaused ? "Paused" : "Live"}</span>
              </div>
              <b class="now-card-title" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
              ${epLabel ? `<span class="now-card-episode">${escapeHtml(epLabel)}</span>` : ""}
            </div>
            <div class="now-card-meta">
              ${userName ? `<span><span class="meta-label">User:</span> ${escapeHtml(userName)}</span>` : ""}
              ${deviceName ? `<span><span class="meta-label">Device:</span> ${escapeHtml(deviceName)}</span>` : ""}
              <span><span class="meta-label">App Used:</span> ${sourceBadgeHtml(session.source)}</span>
            </div>
            <div class="now-card-progress-container">
              <div class="now-card-progress-bar">
                <div class="now-card-progress-fill${isPaused ? " is-paused" : ""}" style="width: ${progress}%;"></div>
              </div>
              <span class="now-card-progress-text">${escapeHtml(formatPlaybackClock(session.offsetMs, session.durationMs))}</span>
            </div>
          </div>
        </button>
      `;
    })
    .join("");

  if (elements.nowPlayingGrid.dataset.renderedKey !== state.nowPlayingSessionKey) {
    elements.nowPlayingGrid.dataset.renderedKey = state.nowPlayingSessionKey;
    reconcileNowPlayingCards(elements.nowPlayingGrid, nextHtml);
    // Live-session cards may not have a cached poster yet. Resolve their
    // fallback through the authenticated server proxy so provider artwork can
    // be cached without exposing provider credentials in the browser.
    hydratePosters(elements.nowPlayingGrid, { allowNetwork: true });
  }

  if (elements.nowPlayingStatus) {
    elements.nowPlayingStatus.textContent = "";
  }
  _cb.updateDashboardSplitState?.();
}

export async function loadActiveSessions({ force = false } = {}) {
  if (!state.token) return state.activeSessions;
  // A request that never settles (a socket left half-open by sleep) would
  // otherwise make every later poll skip, freezing Now Playing on a visible
  // page until the next focus change. Treat it as abandoned after a while.
  const requestStuck = state.nowPlayingRequestActive
    && Date.now() - nowPlayingRequestStartedAt > NOW_PLAYING_REQUEST_STALE_MS;
  if (state.nowPlayingRequestActive && !force && !requestStuck) return state.activeSessions;
  if (state.nowPlayingRequestActive) nowPlayingRequestController?.abort();

  const requestGeneration = ++nowPlayingRequestGeneration;
  nowPlayingRequestStartedAt = Date.now();
  const requestController = typeof AbortController === "function" ? new AbortController() : null;
  nowPlayingRequestController = requestController;

  state.nowPlayingRequestActive = true;
  const url = nowPlayingUrl();
  _cb.logDebug?.("Initiating request loop to /api/now-playing unified backend route...", { url: `${url.pathname}?token=present` });

  let response;
  let bodyText = "";
  try {
    const request = {
      headers: authHeaders(),
      cache: "no-store",
    };
    if (requestController) request.signal = requestController.signal;
    response = await fetch(url, request);
    bodyText = await response.clone().text().catch(() => "");
  } catch (error) {
    if (requestController?.signal.aborted || requestGeneration !== nowPlayingRequestGeneration) return state.activeSessions;
    const message = `Now-playing fetch failed. Reason: FETCH_FAILED (${error?.message || "network request failed"})`;
    _cb.logDebug?.(message);
    throw new Error(message);
  } finally {
    if (requestGeneration === nowPlayingRequestGeneration) {
      state.nowPlayingLastFetchAt = Date.now();
      state.nowPlayingRequestActive = false;
      if (nowPlayingRequestController === requestController) nowPlayingRequestController = null;
    }
  }

  if (requestGeneration !== nowPlayingRequestGeneration) return state.activeSessions;

  _cb.logDebug?.(`Now-playing API returned HTTP ${response.status} ${response.statusText || ""}`.trim(), {
    bodyPreview: bodyText.slice(0, 1200),
  });

  let body = [];
  try {
    body = bodyText ? JSON.parse(bodyText) : [];
  } catch (error) {
    if (requestGeneration !== nowPlayingRequestGeneration) return state.activeSessions;
    const message = `Now-playing payload parsing exception: ${error?.message || "invalid JSON response"}`;
    _cb.logDebug?.(message, { bodyPreview: bodyText.slice(0, 1200) });
    setActiveSessions([]);
    return [];
  }
  if (!response.ok) {
    if (requestGeneration !== nowPlayingRequestGeneration) return state.activeSessions;
    const message = `Now playing failed with HTTP ${response.status}`;
    _cb.logDebug?.(message, body);
    setActiveSessions([]);
    return [];
  }

  const refreshToken = response.headers.get("X-Now-Playing-Refresh") || "";
  let sessions = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
  _cb.logDebug?.(`Now-playing payload parsed successfully. Active sessions: ${sessions.length}`, sessions);

  if (requestGeneration !== nowPlayingRequestGeneration) return state.activeSessions;
  state.nowPlayingRefreshToken = refreshToken || state.nowPlayingRefreshToken;
  setActiveSessions(sessions);

  return sessions;
}

export function pollNowPlayingOnce({ force = false } = {}) {
  if (!state.token || document.hidden) {
    stopHistoryPolling();
    return;
  }
  loadActiveSessions({ force }).catch((error) => {
    _cb.logDebug?.(`Now Playing poll failed: ${error?.message || "unknown error"}`);
  });
}

export function startHistoryPolling({ force = false } = {}) {
  stopHistoryPolling();
  if (!state.token || document.hidden) return;

  _cb.logDebug?.(`Starting Now Playing polling (every ${NOW_PLAYING_POLL_MS / 1000}s).`);
  pollNowPlayingOnce({ force });
  state.nowPlayingInterval = setInterval(pollNowPlayingOnce, NOW_PLAYING_POLL_MS);
}

export function stopHistoryPolling() {
  if (state.nowPlayingInterval) {
    clearInterval(state.nowPlayingInterval);
    state.nowPlayingInterval = undefined;
  }
  if (state.nowPlayingRequestActive || nowPlayingRequestController) {
    nowPlayingRequestGeneration += 1;
    nowPlayingRequestController?.abort();
    nowPlayingRequestController = null;
    state.nowPlayingRequestActive = false;
  }
  _cb.logDebug?.("Stopped Now Playing polling.");
}

export function syncNowPlayingPolling() {
  // The refresh-token check needs to run on every view, not just the dashboard, so
  // watched/unwatched changes detected in the background show up immediately no matter
  // what page is open.
  startHistoryPolling();
}

// ── Sync trigger actions ───────────────────────────────────────────────────

export async function triggerRetrySync(id, button) {
  if (!id || !button) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Syncing...";

  const titleEl = document.getElementById("terminalModalTitle");
  if (titleEl) titleEl.textContent = "Retry Sync Terminal";

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

  termLog("plekt@server:~$ ./retry-sync --id=" + id, "header");
  termLog("Initializing sync connection...", "info");
  termLog("POST /api/retry-sync HTTP/1.1", "info");

  try {
    const response = await fetch("/api/retry-sync", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      termLog("[ERROR] Sync request failed with status: " + response.status, "error");
      if (body.error) termLog("Reason: " + body.error, "error");
      throw new Error(body.error || `Retry failed with status ${response.status}`);
    }

    termLog("Response received: HTTP 200 OK", "success");
    termLog("Fetching updated watch record from database...", "info");

    const refreshRes = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    const refreshBody = await refreshRes.json().catch(() => ({}));
    if (refreshRes.ok && refreshBody.row) {
      const updatedRow = refreshBody.row;
      if (Array.isArray(state.history)) {
        const idx = state.history.findIndex((x) => x.id === id);
        if (idx !== -1) state.history[idx] = updatedRow;
      }
      if (Array.isArray(state.moviesRaw)) {
        const idx = state.moviesRaw.findIndex((x) => x.id === id);
        if (idx !== -1) state.moviesRaw[idx] = updatedRow;
      }
      if (Array.isArray(state.showsRaw)) {
        for (const show of state.showsRaw) {
          if (Array.isArray(show.episodes)) {
            const idx = show.episodes.findIndex((x) => x.id === id);
            if (idx !== -1) show.episodes[idx] = updatedRow;
          }
        }
      }

      termLog("\n--- Sync Telemetry Dispatch Output ---", "header");
      const telemetry = String(updatedRow.sync_dispatch_telemetry || updatedRow.syncDispatchTelemetry || "");
      if (telemetry) {
        for (const line of telemetry.split(/\r?\n/)) {
          if (line.toLowerCase().includes("status: success") || line.toLowerCase().includes("resolved status to success")) {
            termLog(line, "success");
          } else if (line.toLowerCase().includes("status: error") || line.toLowerCase().includes("status: failed") || line.toLowerCase().includes("error") || line.toLowerCase().includes("fail")) {
            termLog(line, "error");
          } else if (line.toLowerCase().includes("status: pending") || line.toLowerCase().includes("pending")) {
            termLog(line, "warn");
          } else {
            termLog(line, "info");
          }
        }
      } else {
        termLog("No dispatch telemetry recorded.", "warn");
      }

      const targetStatuses = getMediaTargetSyncStatus(updatedRow);
      const errors = targetStatuses.filter((t) => t.status === "error" || t.status === "failed");
      const pendings = targetStatuses.filter((t) => t.status === "pending");

      if (errors.length > 0) {
        termLog("\n⚠️ Sync failure detected for one or more targets!", "error");
        for (const err of errors) {
          termLog(`\n[DIAGNOSTICS & FIX FOR ${err.target.toUpperCase()}]:`, "warn");
          const telLine = telemetry.split("\n").find((l) => l.toLowerCase().includes(err.target) && l.toLowerCase().includes("error"));
          termLog(`Details: ${telLine || "Connection failed"}`, "info");
          const errLower = (telLine || "").toLowerCase();
          if (errLower.includes("unauthorized") || errLower.includes("401") || errLower.includes("token") || errLower.includes("auth")) {
            termLog("👉 FIX: Open Settings → Media Servers for this app and verify that the API key or token is correct, valid, and not expired.", "success");
          } else if (errLower.includes("refused") || errLower.includes("timeout") || errLower.includes("conn") || errLower.includes("reach") || errLower.includes("address")) {
            termLog("👉 FIX: Verify that the Server URL is correct, the target server is currently online, and there are no network rules or firewalls blocking the connection from the machine running Plekt.", "success");
          } else if (errLower.includes("not found") || errLower.includes("404") || errLower.includes("match")) {
            termLog("👉 FIX: The media item was not found on the target platform. Ensure the TMDB/IMDB/TVDB IDs are correct and that the media is properly scanned/matched in your Plex/Emby/Jellyfin library.", "success");
          } else {
            termLog("👉 FIX: Check Settings → Media Servers for this platform, then test the connection to verify credentials and endpoint URLs.", "success");
          }
        }
      } else if (pendings.length > 0) {
        termLog("\n⚠️ One or more sync dispatches are still pending or queued.", "warn");
        termLog("👉 SUGGESTION: The target sync is in progress or propagation is queued. Wait a few moments and retry.", "info");
      } else {
        termLog("\n✨ Sync completed successfully! All configured targets are fully up to date.", "success");
      }

      _cb.clearDerivedUiCaches?.({ resetExplorer: false });
      _cb.renderDashboard?.();
      _cb.renderStats?.();
      await Promise.all([
        _cb.loadSyncJobs?.({ force: true }),
        _cb.loadSyncHistory?.({ force: true }),
      ]).catch(() => null);

      if (state.activeView === "explorer") _cb.renderExplorer?.();
      if (state.activeShowModalKey) _cb.renderImmersiveShowModal?.(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);

      _cb.setMessage?.("Retry sync completed.", "success");
    } else {
      throw new Error("Could not fetch the updated sync state from server.");
    }
  } catch (error) {
    termLog(`\n[FATAL ERROR] Retry sync process aborted: ${error.message}`, "error");
    button.disabled = false;
    button.textContent = originalText;
    _cb.setMessage?.(`Retry sync failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

let syncProgressTimer = null;
let syncProgressState = null;

function formatSyncDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function renderSyncProgress() {
  if (!syncProgressState || !elements.syncProgress) return;
  const value = Math.max(0, Math.min(100, Math.round(syncProgressState.value)));
  const elapsed = formatSyncDuration(Date.now() - syncProgressState.startedAt);
  let meta = `${value}% · ${elapsed} elapsed · ${syncProgressState.remaining || "Estimating remaining"}`;
  if (syncProgressState.status === "complete") meta = `100% · ${elapsed} total`;
  if (syncProgressState.status === "stopped") meta = `${value}% · Stopped after ${elapsed}`;
  if (syncProgressState.status === "error") meta = `${value}% · Failed after ${elapsed}`;

  elements.syncProgress.classList.remove("hidden");
  elements.syncProgress.dataset.status = syncProgressState.status;
  if (elements.syncProgressLabel) elements.syncProgressLabel.textContent = syncProgressState.label;
  if (elements.syncProgressMeta) elements.syncProgressMeta.textContent = meta;
  if (elements.syncProgressTrack) elements.syncProgressTrack.setAttribute("aria-valuenow", String(value));
  if (elements.syncProgressFill) elements.syncProgressFill.style.transform = `scaleX(${value / 100})`;
}

function beginSyncProgress(label) {
  if (syncProgressTimer) clearInterval(syncProgressTimer);
  syncProgressState = {
    label,
    value: 3,
    status: "running",
    remaining: "Estimating remaining",
    startedAt: Date.now(),
    itemSample: null,
  };
  renderSyncProgress();
  syncProgressTimer = setInterval(renderSyncProgress, 1000);
}

function setSyncProgress(label, value, remaining = null) {
  if (!syncProgressState) return;
  syncProgressState.label = label;
  syncProgressState.value = Math.max(syncProgressState.value, value);
  if (remaining) syncProgressState.remaining = remaining;
  renderSyncProgress();
}

function updateSyncProgressFromLine(line, mode) {
  if (!syncProgressState || !line) return;
  const text = String(line);
  const lower = text.toLowerCase();

  if (mode === "force") {
    const itemProgress = text.match(/Force Sync progress:\s*(\d+)\/(\d+) items/i);
    if (itemProgress) {
      const processed = Number(itemProgress[1]);
      const total = Math.max(1, Number(itemProgress[2]));
      const now = Date.now();
      let remaining = null;
      const previous = syncProgressState.itemSample;
      if (previous && processed > previous.processed && now > previous.at) {
        const itemsPerMs = (processed - previous.processed) / (now - previous.at);
        const remainingMs = (total - processed) / itemsPerMs;
        if (Number.isFinite(remainingMs) && remainingMs >= 0) remaining = `About ${formatSyncDuration(remainingMs)} remaining`;
      }
      syncProgressState.itemSample = { processed, at: now };
      setSyncProgress(`Reconciling library items (${processed}/${total})`, 58 + (processed / total) * 38, remaining);
      return;
    }

    const stages = [
      ["loading media configuration", "Loading media configuration", 8],
      ["receiving targets resolved", "Media servers connected", 15],
      ["querying watched libraries", "Scanning watched libraries", 24],
      ["collected ", "Watched libraries scanned", 38],
      ["loading plekt watchhistory", "Loading Plekt history", 45],
      ["grouping and matching", "Matching items across servers", 52],
      ["resolving watched state", "Preparing reconciliation", 58],
      ["process complete", "Sync complete", 100],
    ];
    const stage = stages.find(([needle]) => lower.includes(needle));
    if (stage) setSyncProgress(stage[1], stage[2]);
    return;
  }

  const stages = [
    ["starting background sync workflow", "Loading sync configuration", 8],
    ["checking plex unwatched status", "Checking Plex watched state", 16],
    ["running catch-up library checks", "Starting recent-item repair", 22],
    ["running requested recent-item repair", "Starting recent-item repair", 22],
    ["checking plex recently watched", "Scanning Plex history", 30],
    ["checking emby recently watched", "Scanning Emby history", 38],
    ["checking jellyfin recently watched", "Scanning Jellyfin history", 46],
    ["checking plex continue watching", "Checking Plex progress", 54],
    ["checking emby continue watching", "Checking Emby progress", 62],
    ["checking jellyfin continue watching", "Checking Jellyfin progress", 70],
    ["processing pending manual dispatches", "Sending pending changes", 80],
    ["scanning active sessions", "Checking active sessions", 90],
    ["scheduled sync complete", "Sync complete", 100],
  ];
  const stage = stages.find(([needle]) => lower.includes(needle));
  if (stage) setSyncProgress(stage[1], stage[2]);
}

export function isSyncProgressActive() {
  return Boolean(syncProgressState && syncProgressState.status === "running");
}

function finishSyncProgress(status, label) {
  if (!syncProgressState) return;
  if (syncProgressTimer) clearInterval(syncProgressTimer);
  syncProgressTimer = null;
  syncProgressState.status = status;
  syncProgressState.label = label;
  if (status === "complete") syncProgressState.value = 100;
  renderSyncProgress();
  _cb.queueLiveHistoryRefresh?.({ immediate: true });
}

export async function triggerCronSync() {
  const button = elements.runCronSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  if (terminal) { terminal.classList.remove("hidden"); terminal.textContent = ""; }
  beginSyncProgress("Preparing recent-item repair");

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Repairing...";

  try {
    const response = await fetch("/api/cron-sync", { method: "POST", headers: authHeaders() });
    if (!response.ok) throw new Error(`Cron sync failed with HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("RESULT: ")) {
          try { finalResult = JSON.parse(trimmed.substring(8)); } catch (e) { console.error("Failed to parse final result JSON", e); }
        } else if (terminal) {
          terminal.textContent += `${trimmed}\n`;
          terminal.scrollTop = terminal.scrollHeight;
        }
        updateSyncProgressFromLine(trimmed, "cron");
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("RESULT: ")) {
        try { finalResult = JSON.parse(trimmed.substring(8)); } catch (e) { console.error("Failed to parse final result JSON", e); }
      } else if (terminal) {
        terminal.textContent += `${trimmed}\n`;
        terminal.scrollTop = terminal.scrollHeight;
      }
      updateSyncProgressFromLine(trimmed, "cron");
    }

    if (finalResult?.success === false) {
      throw new Error(finalResult.error || "Scheduled sync failed");
    }

    if (finalResult) {
      const detail = `Cron run complete! Sessions: ${finalResult.sessions ?? 0}, completions: ${finalResult.completions ?? 0}, cached: ${finalResult.cached ?? 0}`;
      _cb.setMessage?.(detail, "success");
      if (terminal) { terminal.textContent += `\nSUCCESS: ${detail}\n`; terminal.scrollTop = terminal.scrollHeight; }
      finishSyncProgress("complete", "Recent-item repair complete");
    } else {
      throw new Error("No final result returned from server");
    }

    await Promise.all([_cb.loadSyncJobs?.({ force: true }), _cb.loadSyncHistory?.({ force: true })]);
  } catch (error) {
    _cb.setMessage?.(`Error: ${error.message}`, "error");
    if (terminal) { terminal.textContent += `\nERROR: ${error.message}\n`; terminal.scrollTop = terminal.scrollHeight; }
    finishSyncProgress("error", "Recent-item repair failed");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

export async function triggerStopSync() {
  const button = elements.stopSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Stopping...";
  try {
    const response = await fetch("/api/stop-force-sync", { method: "POST", headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stop sync failed with HTTP ${response.status}`);
    _cb.setMessage?.(body.message || "Stop sync request sent.", "muted");
    if (body.reset && terminal) {
      terminal.classList.remove("hidden");
      terminal.textContent += `${terminal.textContent ? "\n" : ""}RESET: ${body.message}\n`;
      terminal.scrollTop = terminal.scrollHeight;
    }
  } catch (error) {
    _cb.setMessage?.(`Error stopping sync: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

export async function triggerForceSync({ planId = "", confirmed = false } = {}) {
  const button = elements.forceSyncButton;
  const terminal = elements.forceSyncTerminal;
  if (!button) return;

  const startForceSyncJob = async () => {
    if (terminal) { terminal.classList.remove("hidden"); terminal.textContent = "Force Sync starting...\n"; }
    beginSyncProgress(planId ? "Preparing confirmed Force Sync plan" : "Preparing force sync");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Syncing...";
    button.classList.add("hidden");

    try {
      const startResponse = await fetch("/api/force-sync", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(planId ? { planId } : {}),
      });
      if (!startResponse.ok) {
        const body = await startResponse.json().catch(() => ({}));
        throw new Error(body.error || `Force sync failed with HTTP ${startResponse.status}`);
      }

      let seenLines = 0;
      let finalResult = null;
      let pollActive = true;

      while (pollActive) {
        await new Promise((r) => setTimeout(r, 2000));
        let statusBody;
        try {
          const statusRes = await fetch("/api/force-sync", { headers: authHeaders(), cache: "no-store" });
          statusBody = await statusRes.json();
        } catch (err) { continue; }

        const log = Array.isArray(statusBody.log) ? statusBody.log : [];
        for (let i = seenLines; i < log.length; i++) {
          const line = log[i];
          if (line && line.startsWith("RESULT: ")) {
            try { finalResult = JSON.parse(line.substring(8)); } catch (_) { }
          } else if (terminal && line) {
            terminal.textContent += `${line}\n`;
            terminal.scrollTop = terminal.scrollHeight;
          }
          updateSyncProgressFromLine(line, "force");
        }
        seenLines = log.length;
        if (!statusBody.active) {
          finalResult = finalResult || statusBody.result;
          if (!finalResult && statusBody.status === "cancelled") {
            finalResult = { success: false, aborted: true, cancelled: true, error: "Force Sync was cancelled." };
          } else if (!finalResult && statusBody.status === "failed") {
            finalResult = { success: false, error: "Force Sync failed without a result." };
          }
          pollActive = false;
        }
      }

      if (!finalResult) throw new Error("No final result returned from server");

      const stopped = Boolean(finalResult.aborted || finalResult.cancelled);
      if (stopped) {
        const detail = finalResult.error || "Force Sync stopped.";
        _cb.setMessage?.(detail, "muted");
        if (terminal) { terminal.textContent += `\nABORTED: ${detail}\n`; terminal.scrollTop = terminal.scrollHeight; }
        finishSyncProgress("stopped", "Force sync stopped");
      } else if (finalResult.success || Number.isInteger(finalResult.plannedActions)) {
        const stats = finalResult.stats || {};
        const scanErrorCount = Object.keys(stats.scanErrors || {}).length;
        const detail = finalResult.message || `Force Sync complete! Targets: ${(finalResult.activeTargets || []).join(", ") || "none"}. Found: ${stats.totalWatchedFoundAcrossServers ?? 0}, added: ${stats.addedToHistory ?? 0}, deleted: ${stats.deletedFromHistory ?? 0}, propagated: ${stats.propagatedUpdates ?? 0}${scanErrorCount ? `; ${scanErrorCount} server scan${scanErrorCount === 1 ? "" : "s"} failed` : ""}`;
        _cb.setMessage?.(detail, finalResult.success ? "success" : "muted");
        if (terminal) { terminal.textContent += `\n${finalResult.success ? "SUCCESS" : "INCOMPLETE"}: ${detail}\n`; terminal.scrollTop = terminal.scrollHeight; }
        finishSyncProgress(finalResult.success ? "complete" : "error", finalResult.success ? "Force sync complete" : "Force sync incomplete");
      } else {
        throw new Error(finalResult.error || "Force Sync ended with an unknown error.");
      }

      await Promise.all([_cb.loadSyncJobs?.({ force: true }), _cb.loadSyncHistory?.({ force: true })]);
    } catch (error) {
      _cb.setMessage?.(`Error: ${error.message}`, "error");
      if (terminal) { terminal.textContent += `\nERROR: ${error.message}\n`; terminal.scrollTop = terminal.scrollHeight; }
      finishSyncProgress("error", "Force sync failed");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
      button.classList.remove("hidden");
    }
  };

  if (confirmed) return startForceSyncJob();
  _cb.showConfirmModal?.(
    "Are you sure you want to run Force Sync?\n\nThis checks configured media servers and repairs their watched/unwatched states from Plekt's canonical history. It may take some time.",
    startForceSyncJob,
  );
}
