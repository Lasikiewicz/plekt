import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.0.0.3";

const trackerHistory = {
  simkl: {
    href: "https://simkl.com/my/history/watch-history/",
    label: "Check Simkl Watch History",
    historyName: "Simkl Watch History",
  },
  trakt: { href: "https://app.trakt.tv/history", label: "Check Trakt history", historyName: "Trakt history" },
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
  const historyName = trackerHistory[provider]?.historyName || "tracker history";
  const title = trackerWriteTitle(item);
  const watchedAt = trackerWriteWatchedAt(item);
  const when = watchedAt ? ` on ${watchedAt}` : "";
  const isUnsent = String(item.explanation || "").includes("It was not sent.");
  if (isUnsent) {
    return `Plekt did not send this watch. Look for ${title}${when} in ${historyName}. If it is there, cancel this write; otherwise, fix the title or date and create a new write.`;
  }
  if (provider === "simkl" || provider === "trakt") {
    return `Look for ${title}${when} in ${historyName}. If it is there, cancel this write to avoid a duplicate.`;
  }
  return `Plekt couldn't confirm delivery to the tracker. Check its history for ${title}${when} before retrying to avoid a duplicate.`;
}

function trackerWriteCard(item, state) {
  const history = trackerHistory[String(item.provider || "").toLowerCase()];
  const skipping = state.syncAttentionSkipping === String(item.id || "");
  const actionBusy = Boolean(state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying);
  return `
    <article class="sync-attention-item sync-attention-item--tracker-write" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-tracker-copy">
        <h3>${escapeHtml(item.title || "Tracker write")}</h3>
        <p>${escapeHtml(trackerWriteSummary(item))}</p>
      </div>
      <div class="sync-attention-tracker-actions">
        ${history ? `<a class="button-ghost sync-attention-tracker-link" href="${history.href}" target="_blank" rel="noopener noreferrer">${history.label}</a>` : ""}
        <button class="button-ghost sync-attention-skip" type="button" data-sync-attention-skip="${escapeAttribute(item.id)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipping ? "Cancelling…" : "Cancel write")}</button>
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
