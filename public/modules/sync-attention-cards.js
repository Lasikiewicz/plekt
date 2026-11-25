import { escapeHtml, escapeAttribute } from "./utils.js?v=2.3.0.0.5";
import { buildAuthHeaders } from "./auth.js?v=2.3.0.0.5";
import { state } from "./state.js?v=2.3.0.0.5";

function hasSimklEpisodeOrderSkip(entry) {
  return Array.isArray(entry?.targetStates) && entry.targetStates.some(({ target, status, detail }) =>
    target === "simkl" && status === "skipped"
    && /^Simkl (?:does not support alternate episode orders|could not verify this episode's alternate numbering)\b/i.test(detail));
}

export function syncActivityResultSummary(entry) {
  const summary = entry.details || "";
  if (!hasSimklEpisodeOrderSkip(entry)) return summary;
  const orderSkip = "Simkl skipped because of episode numbering";
  return summary.replace(/(?:Plex & )?Simkl skipped by the historical sync policy/, (note) =>
    note.startsWith("Plex") ? `Plex skipped by the historical sync policy. ${orderSkip}` : orderSkip);
}

export function simklEpisodeOrderGuidance(entries, groupKey) {
  if (!groupKey || !entries.some((entry) => entry?.action === "watched" && hasSimklEpisodeOrderSkip(entry))) return "";
  return `
    <div class="sync-activity-row-detail sync-activity-episode-order-guidance">
      <strong>Episodes skipped for Simkl because of alternate numbering</strong>
      <p>Check which skipped watches match episodes on Simkl, then choose which ones to send.</p>
      <div class="sync-activity-group-action-buttons"><button type="button" class="button-ghost" data-simkl-episode-order-review="${escapeAttribute(groupKey)}" aria-haspopup="dialog">Review Simkl updates</button></div>
    </div>`;
}

const SIMKL_FULL_SYNC_URL = "/api/tracker-connections/simkl/full-sync";
let simklReviewPending = false;

async function postSimklFullSync(path, payload) {
  const response = await fetch(SIMKL_FULL_SYNC_URL + path, {
    method: "POST",
    headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (/^FULL_SYNC_(?:PLAN_(?:STALE|EXPIRED)|PREVIEW_REQUIRED)$/.test(body.code || "")) {
      throw new Error("The preview changed or expired. Open Review Simkl updates again to check the latest matches.");
    }
    throw new Error(body.error || "Could not complete the Simkl request.");
  }
  return body.fullSync;
}

function simklReviewItemMarkup(item) {
  const coordinate = item.season != null && item.episode != null
    ? `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
    : "";
  const detail = [coordinate, trackerWriteWatchedAt(item), item.reason].filter(Boolean).join(" · ");
  return `<label class="tracker-preview-item"><input type="checkbox" value="${escapeAttribute(item.id)}" ${item.selectable ? "checked" : "disabled"}><span><b>${escapeHtml(item.title)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></label>`;
}

async function showSimklEpisodeOrderReview(preview, openConfirmDialog) {
  const items = preview.items.filter((item) => item.side === "tracker");
  const hasSelectable = items.some((item) => item.selectable);
  const description = hasSelectable ? "Send the selected watches to Simkl with their saved dates."
    : items.length ? "No watches are ready to send." : "There are no skipped watches to review for this show.";
  const listId = `simkl-review-${preview.id}`;
  const selectedIds = () => [...(document.getElementById(listId)?.querySelectorAll("input:checked:not(:disabled)") || [])]
    .map((input) => input.value);
  const dialog = openConfirmDialog({
    title: "Review Simkl updates",
    mediaHtml: `<div class="confirm-modal-media-info"><p class="tracker-preview-note">${description}</p><div class="tracker-preview-groups" id="${escapeAttribute(listId)}">${items.map(simklReviewItemMarkup).join("")}</div></div>`,
    confirmLabel: hasSelectable ? "Send selected watches" : "Close",
    cancelLabel: "Cancel",
    pendingLabel: "Checking and queuing the watches…",
    runOnConfirm: hasSelectable ? async () => {
      const ids = selectedIds();
      if (!ids.length) return "Select at least one watch to send.";
      document.getElementById(listId)?.querySelectorAll("input").forEach((input) => { input.disabled = true; });
      const result = await postSimklFullSync("", { direction: "push", planId: preview.id, selectedIds: ids });
      if (!result?.runId) throw new Error("Plekt could not confirm that the Simkl updates were queued. Check Settings → Connections → Simkl.");
      document.dispatchEvent?.(new CustomEvent("plekt:full-sync-changed", { detail: { provider: "simkl" } }));
      return `Queued ${ids.length} ${ids.length === 1 ? "watch" : "watches"} for Simkl. Track progress in Settings → Connections → Simkl.`;
    } : undefined,
  });
  const list = document.getElementById(listId);
  const modal = list?.closest(".confirm-dialog");
  if (hasSelectable) {
    const confirm = modal?.querySelector(".confirm-dialog-confirm");
    if (confirm) list.addEventListener("change", () => { confirm.disabled = !selectedIds().length; });
    list?.querySelector("input:not(:disabled)")?.focus();
  } else {
    const cancel = modal?.querySelector(".confirm-dialog-cancel");
    if (cancel) cancel.hidden = true;
  }
  await dialog;
}

export function handleSimklEpisodeOrderReviewClick(event, { openConfirmDialog, setMessage }) {
  const button = event.target.closest("[data-simkl-episode-order-review]");
  if (!button) return false;
  if (button.disabled || simklReviewPending || !openConfirmDialog) return true;
  const label = button.textContent;
  simklReviewPending = true;
  button.disabled = true;
  button.textContent = "Checking episodes…";
  button.setAttribute("aria-busy", "true");
  void postSimklFullSync("/compare", { activityGroupKey: button.dataset.simklEpisodeOrderReview })
    .then((fullSync) => {
      if (!fullSync?.preview?.id || !Array.isArray(fullSync.preview.items)) throw new Error("Could not load the Simkl preview.");
      button.textContent = label;
      button.removeAttribute("aria-busy");
      return showSimklEpisodeOrderReview(fullSync.preview, openConfirmDialog);
    })
    .catch((error) => setMessage?.(error.message || "Could not review the Simkl updates.", "error"))
    .finally(() => {
      simklReviewPending = false;
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute("aria-busy");
    });
  return true;
}

export function handleSyncActivityRetryClick(event, { openConfirmDialog, retrySyncActivity, setMessage }) {
  const button = event.target.closest("[data-sync-activity-retry]");
  if (!button) return false;
  if (button.disabled || !openConfirmDialog) return true;
  const { title, action, queued, failures } = JSON.parse(button.dataset.retryInfo);
  const destinations = [...new Set(failures.map(([name]) => name))].join(", ");
  const scope = queued
    ? "Plekt will retry this queued update using its current sync settings. This may contact several apps."
    : `Plekt will retry this update only for ${destinations || "the apps where it failed"}.`;
  const details = failures.map(([name, detail]) => detail ? `${name}: ${detail}` : `${name}: Sync failed`).join("\n");
  const body = [`${title} · ${action}`, scope, details && `Previous failure\n${details}`,
    "If an app is offline, reconnect it before retrying. Choose Not now to leave the issue open."].filter(Boolean).join("\n\n");
  button.disabled = true;
  void Promise.resolve().then(() => openConfirmDialog({
    title: "Retry this sync update?", body, confirmLabel: "Retry now", cancelLabel: "Not now",
    pendingLabel: "Retrying the sync update…",
    async runOnConfirm() {
      const result = await retrySyncActivity?.(button.dataset.syncActivityRetry);
      if (!result) return "A retry is already running for this item.";
      const failures = (result.targetStates || [])
        .filter(({ status }) => ["failed", "error", "partial"].includes(String(status).toLowerCase()))
        .map(({ target, detail }) => `${trackerLabel(target)}: ${detail || "The app did not confirm the update."}`);
      const queuedTargets = (result.targetStates || []).filter(({ status }) => String(status).toLowerCase() === "pending")
        .map(({ target }) => trackerLabel(target));
      const outcome = result.status === "success" ? "Retry completed."
        : !failures.length && queuedTargets.length ? `Retry queued. ${queuedTargets.join(", ")} will receive it with the next batch send.`
          : result.status === "skipped" ? "Retry skipped." : "The retry did not complete successfully.";
      return ["Retry result", outcome, ...new Set(failures.length ? failures : queuedTargets.length ? [] : [result.details].filter(Boolean))].join("\n");
    },
  }))
    .catch((error) => setMessage?.(error.message || "Could not retry this sync update.", "error"))
    .finally(() => { button.disabled = false; });
  return true;
}

function trackerLabel(target) {
  return { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin", simkl: "Simkl", trakt: "Trakt" }[target] || target || "Connected app";
}

const trackerHistory = {
  simkl: {
    href: "https://simkl.com/my/history/watch-history/",
    label: "View Simkl watch history",
  },
  trakt: { href: "https://app.trakt.tv/history", label: "View Trakt watch history" },
};

function trackerWriteWatchedAt(item = {}) {
  const date = new Date(item.watchedAt || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function trackerWriteTitle(item = {}) {
  const provider = String(item.provider || "").trim();
  return String(item.title || "this title").replace(new RegExp(`^${provider}:\\s*`, "i"), "");
}

function trackerWriteSummary(item = {}) {
  const provider = String(item.provider || "").toLowerCase();
  const title = trackerWriteTitle(item);
  const watchedAt = trackerWriteWatchedAt(item);
  const when = watchedAt ? ` on ${watchedAt}` : "";
  if (item.competing) {
    return "Several updates could be for the same watch. Plekt paused them to avoid duplicates.";
  }
  const isUnsent = item.notSent ?? String(item.explanation || "").includes("It was not sent.");
  if (isUnsent) {
    return "Plekt paused this update before sending it. Check the title match and watch date before trying again.";
  }
  if (provider === "simkl") {
    return `Plekt couldn’t confirm that Simkl recorded the watch for ${title}${when}. Checking the watch status clears this update when the date and time match.`;
  }
  if (provider === "trakt") {
    return `Plekt couldn’t confirm the watch for ${title}${when} in Trakt’s history.`;
  }
  return `Check for ${title}${when} in the tracker’s watch history before trying again.`;
}

function trackerWriteCard(item, state) {
  const history = trackerHistory[String(item.provider || "").toLowerCase()];
  const skipping = state.syncAttentionSkipping === String(item.id || "");
  const actionBusy = Boolean(state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying);
  return `
    <article class="sync-attention-item sync-attention-item--tracker-write" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-tracker-copy">
        <h3>${escapeHtml(item.title || "Watch update")}</h3>
        <p>${escapeHtml(trackerWriteSummary(item))}</p>
      </div>
      <div class="sync-attention-tracker-actions">
      ${history && !item.competing && !(item.notSent ?? String(item.explanation || "").includes("It was not sent.")) ? `<a class="button-ghost sync-attention-tracker-link" href="${history.href}" target="_blank" rel="noopener noreferrer">${history.label}</a>` : ""}
        <button class="button-ghost sync-attention-skip" type="button" data-sync-attention-skip="${escapeAttribute(item.id)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipping ? "Cancelling…" : "Cancel update")}</button>
      </div>
    </article>`;
}

export function renderSyncAttentionItem(item = {}, helpers = {}) {
  const { state, attentionToneForItem, attentionIssueList, attentionCreatedAt } = helpers;
  if (item.source === "tracker_write") return trackerWriteCard(item, state);

  const recommendations = Array.isArray(item.recommendations) ? item.recommendations.filter(Boolean) : [];
  const skipping = state.syncAttentionSkipping === String(item.id || "");
  const actionBusy = Boolean(state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying);
  const skipLabel = skipping ? "Skipping..." : String(item.skipLabel || "Skip this issue");
  const tone = attentionToneForItem(item);
  const isBlocking = tone === "error";
  return `
    <article class="sync-attention-item" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <span class="sync-attention-kicker">${isBlocking ? "Blocking issue" : "Warning"}</span>
          <h3>${escapeHtml(item.title || "Sync issue")}</h3>
        </div>
        <span class="status-pill status-${isBlocking ? "error" : "warning"}">${isBlocking ? "Needs attention" : "Review warning"}</span>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || "This operation did not complete.")}</p>
      <div class="sync-attention-detail-grid">
        <div>
          <h4>${escapeHtml(item.explanationHeading || "Why this blocks completion")}</h4>
          <p>${escapeHtml(item.explanation || "The sync cannot be considered complete until this issue is resolved or skipped.")}</p>
        </div>
        <div>
          <h4>Recommended next steps</h4>
          ${recommendations.length
            ? `<ol>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ol>`
            : `<p>Review Settings → Logs, correct the affected connection, and retry the operation.</p>`}
        </div>
      </div>
      ${attentionIssueList(item)}
      <div class="sync-attention-item-footer">
        <span class="sync-attention-detected">Detected ${escapeHtml(attentionCreatedAt(item))}</span>
        <div class="sync-attention-actions">
          <p>${escapeHtml(item.skipNote || "Skipping accepts this incomplete projection and lets normal sync resume; it does not create the missing remote records.")}</p>
          <button class="button-ghost sync-attention-skip" type="button" data-sync-attention-skip="${escapeAttribute(item.id)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipLabel)}</button>
        </div>
      </div>
    </article>`;
}

const selectedGroups = new Set();
const expandedGroups = new Set();
let trackerReviewBusy = false;
let trackerReviewStatus = "";

export function renderTrackerWriteReview(items, renderItem) {
  const groups = new Map();
  const other = [];
  for (const item of items) {
    if (item.source !== "tracker_write") {
      other.push(renderItem(item));
      continue;
    }
    const key = item.groupKey || item.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of selectedGroups) if (!groups.has(key)) selectedGroups.delete(key);
  for (const key of expandedGroups) if (!groups.has(key)) expandedGroups.delete(key);
  if (!groups.size) return other.join("");
  const disabled = trackerReviewBusy ? " disabled" : "";
  const groupRows = [...groups].sort(([, a], [, b]) =>
    (a[0].groupTitle || a[0].title).localeCompare(b[0].groupTitle || b[0].title)).map(([key, records]) => {
    const first = records[0];
    const title = first.groupTitle || first.title;
    const providers = [...new Set(records.map(({ provider }) => provider)
      .filter(Boolean))].sort().map(trackerLabel);
    const episodes = new Map();
    for (const item of records) {
      const code = item.episodeCode || "";
      if (!episodes.has(code)) episodes.set(code, []);
      episodes.get(code).push(item);
    }
    const episodeCodes = [...episodes.keys()].filter(Boolean);
    const episodeSummary = episodeCodes.length === 1 ? episodeCodes[0] : episodeCodes.length ? `${episodeCodes.length} episodes` : "";
    const meta = [
      episodeSummary,
      `${records.length} ${records.length === 1 ? "update" : "updates"}`,
      providers.join(", "),
    ].filter(Boolean).join(" · ");
    const details = [...episodes].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([code, writes]) => `<div class="sync-attention-list">${code ? `<h4>${escapeHtml(code)}</h4>` : ""}${writes.map(renderItem).join("")}</div>`).join("");
    return `
      <details class="sync-attention-item" data-tracker-review-group="${escapeAttribute(key)}"${expandedGroups.has(key) ? " open" : ""}>
        <summary>
          <input type="checkbox" data-tracker-review-select aria-label="Select ${escapeAttribute(title)}"${selectedGroups.has(key) ? " checked" : ""}${disabled}>
          <span class="tracker-review-group-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></span>
        </summary>
        <div class="sync-attention-list">${details}</div>
        ${records.map(({ id }) => `<span hidden data-tracker-review-id="${escapeAttribute(id)}"></span>`).join("")}
      </details>`;
  }).join("");
  return `
    <section class="sync-attention-list" data-tracker-review>
      <div class="tracker-review-toolbar">
        <label><input type="checkbox" data-tracker-review-select-all${selectedGroups.size === groups.size ? " checked" : ""}${disabled}> Select all</label>
        <span data-tracker-review-selection>${selectedGroups.size} of ${groups.size} titles selected</span>
        <div class="tracker-review-buttons">
          <button type="button" class="button-ghost" data-tracker-review-cancel aria-describedby="trackerReviewCancelHelp"${trackerReviewBusy || !selectedGroups.size ? " disabled" : ""}>Cancel selected updates</button>
          <button type="button" class="button-primary" data-tracker-review-recheck${disabled}>Check watch status</button>
        </div>
      </div>
      <p id="trackerReviewCancelHelp" class="tracker-review-help">Cancelling removes the selected updates from Plekt’s sync queue and keeps watch history in Plekt and on your trackers.</p>
      <p class="tracker-review-help" data-tracker-review-status role="status"${trackerReviewStatus ? "" : " hidden"}>${escapeHtml(trackerReviewStatus)}</p>
      <div class="sync-attention-list">${groupRows}</div>
    </section>
    ${other.join("")}`;
}

async function requestTrackerReview(cancel, ids) {
  const res = await fetch("/api/sync-attention", {
    method: "POST",
    headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
    body: JSON.stringify({ action: cancel ? "cancel-tracker-writes" : "recheck-tracker-writes", ids }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error || (cancel ? "Could not cancel the selected updates." : "Could not check watch status."));
  return result;
}

export function bindTrackerWriteReview(container, { confirm, refresh, message }) {
  if (!container) return;
  container.addEventListener("toggle", (event) => {
    const group = event.target.closest?.("[data-tracker-review-group]");
    if (!group || group !== event.target) return;
    if (group.open) expandedGroups.add(group.dataset.trackerReviewGroup);
    else expandedGroups.delete(group.dataset.trackerReviewGroup);
  }, true);
  container.addEventListener("change", (event) => {
    const panel = event.target.closest("[data-tracker-review]");
    if (!panel || trackerReviewBusy) return;
    const master = panel.querySelector("[data-tracker-review-select-all]");
    const boxes = [...panel.querySelectorAll("[data-tracker-review-select]")];
    if (event.target === master) {
      for (const box of boxes) box.checked = master.checked;
    } else if (!boxes.includes(event.target)) return;
    for (const box of boxes) {
      const key = box.closest("[data-tracker-review-group]").dataset.trackerReviewGroup;
      if (box.checked) selectedGroups.add(key);
      else selectedGroups.delete(key);
    }
    master.checked = boxes.every((box) => box.checked);
    master.indeterminate = selectedGroups.size > 0 && !master.checked;
    panel.querySelector("[data-tracker-review-selection]").textContent = `${selectedGroups.size} of ${boxes.length} titles selected`;
    panel.querySelector("[data-tracker-review-cancel]").disabled = !selectedGroups.size;
  });
  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-tracker-review-cancel], [data-tracker-review-recheck]");
    if (!button || trackerReviewBusy) return;
    const panel = button.closest("[data-tracker-review]");
    const cancel = button.hasAttribute("data-tracker-review-cancel");
    const label = button.textContent;
    const ids = [...panel.querySelectorAll("[data-tracker-review-select]:checked")].flatMap((box) =>
      [...box.closest("[data-tracker-review-group]").querySelectorAll("[data-tracker-review-id]")].map((item) => item.dataset.trackerReviewId));
    trackerReviewBusy = true;
    const controls = [...panel.querySelectorAll("button, input")].filter((control) => !control.disabled);
    for (const control of controls) control.disabled = true;
    button.setAttribute("aria-busy", "true");
    const showStatus = (text) => {
      trackerReviewStatus = text;
      const status = container.querySelector("[data-tracker-review-status]");
      if (!status) return;
      status.hidden = false;
      status.textContent = text;
    };
    try {
      if (cancel && (!ids.length || !await confirm?.({
        title: "Cancel selected watch updates?",
        body: `Remove ${ids.length} watch ${ids.length === 1 ? "update" : "updates"} from Plekt’s sync queue. Watch history stays in Plekt and on your trackers.`,
        confirmLabel: "Cancel updates",
        danger: true,
      }))) return;
      if (!cancel) {
        button.textContent = "Checking…";
        showStatus("Checking connected trackers for matching watches…");
      }
      const result = await requestTrackerReview(cancel, ids);
      const status = cancel ? `Cancelled ${result.cancelled} watch ${result.cancelled === 1 ? "update" : "updates"}.`
        : `${result.confirmed} confirmed. ${result.remaining} still on hold. ${(result.errors || []).join(" ")}`.trim();
      showStatus(status);
      message(status, result.errors?.length ? "warning" : "success");
      if (cancel) selectedGroups.clear();
    } catch (error) {
      showStatus(error.message);
      message(error.message, "error");
    } finally {
      trackerReviewBusy = false;
      if (!cancel) button.textContent = label;
      button.removeAttribute("aria-busy");
      for (const control of controls) control.disabled = false;
      await refresh();
    }
  });
}
