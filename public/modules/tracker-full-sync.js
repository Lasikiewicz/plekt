// Per-connection extras on a tracker card: first-import progress, the earlier
// watched date preference and the optional compare-then-confirm full sync.
// Rendered from the connection the server returns, so a reload or another tab
// shows the same durable state.
let request = async () => ({});
const timers = new Map();
const LABELS = { trakt: "Trakt", simkl: "Simkl" };
const DIRECTION_COPY = {
  both: "Sync both ways",
  import: "Import selected history from {label}",
  push: "Only send to {label}",
};

export function initTrackerFullSync({ api } = {}) {
  if (api) request = api;
}

export function previewIsExpired(preview, now = Date.now()) {
  const expiry=typeof preview?.expiresAt==='number'?preview.expiresAt:Date.parse(preview?.expiresAt);
  return !Number.isFinite(expiry)||expiry<=now;
}

export function selectablePreviewItems(preview) {
  return (preview?.items || []).filter((item) => item.selectable && item.operation === "add");
}

export function selectedPreviewItems(preview,chosen,direction) {
  return selectablePreviewItems(preview).filter(item=>chosen.has(item.id)&&(direction==='both'||item.side===(direction==='import'?'plekt':'tracker')));
}

const label = (provider) => LABELS[provider] || provider;
const count = (value) => Number(value || 0).toLocaleString();
const items = (value) => `${count(value)} item${Number(value) === 1 ? "" : "s"}`;
const when = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = String(value ?? "");
  return span.innerHTML;
}

export function initialSyncText(connection = {}) {
  const name = label(connection.provider);
  const run = connection.initialSync || {};
  if (!connection.baselineComplete) {
    if (run.status === "running") return run.total ? `Importing your ${name} history: ${count(run.done)} of ${items(run.total)}.` : `Reading your ${name} history…`;
    if (run.status === "failed") return `The first ${name} check failed: ${run.error || "unknown error"}. It is tried again on the next check.`;
    if (run.status === "waiting") return `The first ${name} check is paused and will run again shortly.`;
    return connection.provider === "simkl" ? "Waiting for the first Simkl check. Use Check now, or wait for a media-server event." : `Waiting for the first ${name} check. It normally starts within a minute.`;
  }
  if (run.status !== "completed") return "";
  if (run.mode === "import") {
    return `First import finished ${when(run.finishedAt)}: ${items(run.imported)} imported from ${name}.`;
  }
  // Baseline mode: the first check only snapshots remote history for later
  // compare/sync. It does not copy watches into Plekt or push anything out.
  const finished = when(run.finishedAt);
  return finished
    ? `First check finished ${finished}. Your ${name} history is on file as a starting point; nothing was copied into Plekt yet.`
    : `First check finished. Your ${name} history is on file as a starting point; nothing was copied into Plekt yet.`;
}

// Returns the panel copy plus which actions are offered for the state.
export function fullSyncView(provider, connection = {}, { gated = false, setupImportOnly = false } = {}) {
  const name = label(provider);
  const state = connection.fullSync || {};
  if (gated) return { text: `Full sync becomes available when ${name} sync is enabled.`, compare: false, run: false };
  if (!connection.baselineComplete) return { text: `Available after the first ${name} check finishes.`, compare: false, run: false };
  if (["running", "queued", "waiting_quota"].includes(state.status)) {
    // Only a durable paced Simkl run (it has a runId) can be cancelled.
    const canCancel = provider === "simkl" && Boolean(state.runId);
    const left = state.total ? ` ${count(Math.max(0, state.total - state.done))} of ${items(state.total)} left.` : "";
    if (state.status === "waiting_quota") {
      const resume = when(state.nextRunAt || state.pacing?.nextResetAt);
      const reserve = state.pacing?.protectedQuota;
      const days = Number(state.pacing?.estimatedDays);
      const estimate = Number.isFinite(Number(state.pacing?.totalRequests)) && state.pacing?.quotaKnown === true
        ? ` Estimated at start: ${count(state.pacing.totalRequests)} requests including verification${Number.isFinite(days) && days > 0 ? `, about ${count(days)} quota day${days === 1 ? "" : "s"}` : ""}.`
        : "";
      return { text: `Full sync is waiting for Simkl quota${resume ? ` and will resume ${resume}` : ""}.${left}${estimate}${reserve != null ? ` Normal-use and safety reserves remain protected (${count(state.pacing?.normalReserve)} + ${count(state.pacing?.safetyReserve)} requests).` : " Simkl's daily allowance is not known yet; it is checked after the reset."}`, compare: false, run: false, running: true, waitingQuota: true, canCancel, state };
    }
    if (state.status === "queued") return { text: `Full sync queued and will continue automatically${state.nextRunAt && state.nextRunAt > Date.now() ? ` ${when(state.nextRunAt)}` : ""}.${left}`, compare: false, run: false, running: true, canCancel, state };
    const phase = state.phase === "push" ? `Sending to ${name}: ${count(state.done)} of ${items(state.total)}.` : `Importing from ${name}…`;
    return { text: `Full sync running. ${phase}`, compare: false, run: false, running: true, canCancel, state };
  }
  const directions = connection.fullSyncDirections || (provider === "simkl" ? ["import"] : ["both", "import", "push"]);
  const intro = directions.includes("push")
    ? `Manual only; full sync is off unless you start it.\nCompare ${name} with Plekt, review the preview, then choose what to copy.\nLeave it untouched to skip.\nIt only adds missing watches; nothing is removed, and ${name} gets one play per item, dated with its earliest Plekt watch.`
    : setupImportOnly
      ? `Initial connection records the current state without importing history.\nTo import existing watches, select the option above and review the preview. Nothing is removed.`
      : `Compare ${name} with Plekt, then import missing watches into Plekt. Nothing is removed. Bulk sending to ${name} is not available.`;
  const finished = ["completed","partial"].includes(state.status)
    ? ` Last full sync finished ${when(state.finishedAt)}: ${items(state.imported)} imported, ${items(state.sent)} sent${state.notSent ? `, ${items(state.notSent)} not sent (see Sync Activity)` : ""}${state.propagationFailed?`, ${items(state.propagationFailed)} with unconfirmed media-server updates (see Sync Activity)`:''}.`
    : state.status === "cancelled" ? ` The last full sync was cancelled ${when(state.finishedAt)}: ${items(state.sent)} sent; the rest were not sent.`
    : state.status === "failed" ? ` The last full sync failed: ${state.error || "unknown error"}.`
      : state.status === "interrupted" ? " The last full sync was interrupted by a restart. Compare again to continue." : "";
  if (state.status !== "compared") return { text: `${intro}${finished}`, compare: !setupImportOnly || connection.importHistorySelected !== false, run: false };
  const split = state.preview?.items ? previewSummaryCounts(state.preview) : null;
  const compared = (split
    ? ` Compared ${when(state.comparedAt)}: missing from Plekt ${titleSplitText(split.missingInPlekt)}; missing from ${name} ${titleSplitText(split.missingOnTracker)}.`
    : ` Compared ${when(state.comparedAt)}: ${name} has ${items(state.trackerOnly)} Plekt lacks; Plekt has ${items(state.plektOnly)} ${name} lacks.`)
    + (state.unidentified ? ` ${items(state.unidentified)} in Plekt have no IMDb, TMDB or TVDB id and are left out.` : "");
  return { text: `${intro}${compared}`, compare: true, run: Boolean(state.trackerOnly || directions.includes("push") && state.plektOnly), state, directions };
}

function examples(state = {}) {
  const lists = [["trackerOnly", "Only on the tracker"], ["plektOnly", "Only in Plekt"]]
    .filter(([key]) => state.examples?.[key]?.length)
    .map(([key, heading]) => `<small>${heading}: ${state.examples[key].map(escapeText).join(", ")}${state[key] > state.examples[key].length ? ", …" : ""}</small>`);
  return lists.join("");
}

export function renderTrackerFullSync(provider, connection, options = {}) {
  const root = options.root || document.getElementById(options.rootId || `${provider}TrackerExtras`);
  if (!root) return;
  const context = { root, api: options.api || request, onApplied: options.onApplied, timerKey: options.rootId || root.id || provider };
  const connectionActions = !options.root && !options.rootId ? document.getElementById(`${provider === 'trakt' ? 'traktSyncNow' : 'simklCheckNow'}Button`)?.parentElement : null;
  connectionActions?.querySelector('[data-full-sync-compare]')?.remove();
  clearTimeout(timers.get(context.timerKey));
  const connected = connection?.status === "connected" || connection?.status === "reauth_required";
  root.classList.toggle("hidden", !connected);
  if (!connected) { root.innerHTML = ""; return; }
  const name = label(provider);
  const directions = options.directions || connection.fullSyncDirections || (provider === "simkl" ? ["import"] : ["both", "import", "push"]);
  const view = fullSyncView(provider, { ...connection, fullSyncDirections: directions }, options);
  const preview = view.running ? null : view.state?.preview;
  const previewExpired = previewIsExpired(preview);
  const actionable = selectablePreviewItems(preview);
  const chosen = new Set(actionable.map((item) => item.id));
  const previewMarkup = preview ? renderPreview(preview, previewExpired, chosen, directions, name) : "";
  const status = initialSyncText({ ...connection, provider });
  const actions = "";
  // Status is a finished-event note; the date preference is an ongoing setting.
  // Keep them separate so the checkbox is not read as part of the first-check box.
  const showCompare = !options.setupImportOnly && view.compare;
  root.innerHTML = `${options.setupImportOnly ? `<div class="setup-tracker-choice-box">${connection.importHistoryLabel ? `<label class="field-label setup-import-toggle-label"><input type="checkbox" data-setup-import-toggle="${escapeText(provider)}" ${connection.importHistorySelected !== false ? "checked" : ""} />${escapeText(connection.importHistoryLabel)}</label>` : ""}${showCompare ? `<div class="settings-actions setup-import-review-action"><button class="button-ghost sync-action-btn sync-tool-button" type="button" data-full-sync-compare>${escapeText(options.compareLabel || "Compare with Plekt")}</button></div>` : ""}</div>` : status ? `<p class="muted-copy tracker-initial-sync" role="status">${escapeText(status)}</p>` : ""}
    <div class="setup-tracker-choice-box tracker-date-preference-box"><label class="checkbox-label tracker-date-preference"><input type="checkbox" data-tracker-date ${connection.preferEarlierWatchedDate !== false ? "checked" : ""}><span>Prefer ${escapeText(name)}'s earlier watch date when Plex, Emby or Jellyfin later report the same title</span></label></div>
    ${!options.setupImportOnly || previewMarkup || options.completionText || view.running ? `<div class="tracker-full-sync${options.setupImportOnly ? " setup-import-preview-section" : ""}" role="group" aria-label="${escapeText(name)} ${options.setupImportOnly ? "import preview" : "full sync"}">
      ${options.setupImportOnly ? `<b>${previewMarkup ? "Import preview" : "Import status"}</b>` : `<b>Full sync</b><p class="muted-copy" role="status" aria-live="polite">${escapeText(preview ? 'Review missing watches below. Existing watches and dates are preserved.' : view.text)}</p>`}
      ${view.state && !preview ? examples(view.state) : ""}
      ${previewMarkup}
      ${connection.fullSync?.backup?.name ? `<p class="muted-copy">Backup: ${escapeText(connection.fullSync.backup.name)}. <a href="/settings/backups">Restore backups</a></p>` : ""}
      <p class="message hidden" data-full-sync-message></p>
      ${view.canCancel ? `<div class="settings-actions"><button type="button" class="button-ghost sync-action-btn sync-tool-button" data-full-sync-cancel>Cancel full sync</button></div>` : ""}
      <div class="trakt-sync-progress hidden" data-full-sync-progress role="status" aria-live="polite"><div class="trakt-sync-progress-copy"><b>Comparing watched history…</b><span>Reading connected media servers. Large libraries can take a little while.</span></div><div class="trakt-sync-progress-track" role="progressbar" aria-label="Comparing watched history"><span></span></div></div>
      ${!options.setupImportOnly && showCompare || actions || options.completionText ? `<div class="settings-actions">${options.completionText ? `<span class="muted-copy tracker-completion-status">${escapeText(options.completionText)}</span>` : ""}${!options.setupImportOnly && showCompare ? `<button class="button-ghost sync-action-btn sync-tool-button" type="button" data-full-sync-compare>${escapeText(options.compareLabel || "Compare with Plekt")}</button>` : ""}${actions}</div>` : ""}
    </div>` : ""}`;
  root.querySelector("[data-tracker-date]")?.addEventListener("change", (event) => saveDatePreference(provider, event.target, context));
  root.querySelector("[data-full-sync-compare]")?.addEventListener("click", (event) => compare(provider, event.target, context));
  root.querySelectorAll("[data-full-sync]").forEach((button) => button.addEventListener("click", () => start(provider, button.dataset.fullSync, view.state, context)));
  root.querySelector("[data-full-sync-cancel]")?.addEventListener("click", (event) => cancelFullSync(provider, view.state, event.currentTarget, context));
  root.querySelectorAll("[data-preview-group]").forEach((button) => button.addEventListener("click", () => {
    const group = root.querySelector(`[data-preview-items="${CSS.escape(button.dataset.previewGroup)}"]`);
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    if (open && !group.dataset.loaded) {
      const index = Number(button.dataset.previewGroup.slice(1));
      const entries = previewGroups(preview)[index] || [];
      group.innerHTML = entries.map((item) => previewItemMarkup(item, previewExpired, chosen, name)).join("");
      group.dataset.loaded = "true";
      group.querySelectorAll("[data-preview-item]").forEach((input) => input.addEventListener("change", () => {
        if (input.checked) chosen.add(input.value); else chosen.delete(input.value);
        updateApplyState(root, preview, actionable, chosen);
      }));
    }
    group?.classList.toggle("hidden", !open);
  }));
  root.querySelector("[data-preview-all]")?.addEventListener("change", (event) => {
    chosen.clear();
    if (event.target.checked) actionable.forEach((item) => chosen.add(item.id));
    root.querySelectorAll("[data-preview-item]").forEach((input) => { input.checked = chosen.has(input.value); });
    updateApplyState(root, preview, actionable, chosen);
  });
  root.querySelector("[data-preview-apply]")?.addEventListener("click", () => {
    const direction = root.querySelector("[data-preview-direction]")?.value || directions[0];
    const selectedIds = selectedPreviewItems(preview,chosen,direction).map(item=>item.id);
    start(provider, "preview", { preview, selectedIds, direction }, context);
  });
  root.querySelector('[data-preview-direction]')?.addEventListener('change',()=>updateApplyState(root,preview,actionable,chosen));
  if(preview)updateApplyState(root,preview,actionable,chosen,directions[0]);
  const compareButton = root.querySelector('[data-full-sync-compare]');
  if (connectionActions && compareButton) {
    const previousRow = compareButton.parentElement;
    connectionActions.prepend(compareButton);
    previousRow.remove();
  }
  if (view.running) timers.set(context.timerKey, setTimeout(() => refresh(provider, context), 3000));
}

function renderPreview(preview, expired, selected, directions, trackerName = "tracker") {
  const groups = previewGroups(preview);
  const groupMarkup = groups.map((entries, index) => {
    const title = previewGroupTitle(entries[0]);
    const key = `g${index}`;
    return `<div class="tracker-preview-group"><button type="button" class="tracker-preview-group-toggle" data-preview-group="${key}" aria-expanded="false"><span class="tracker-preview-chevron" aria-hidden="true">›</span><span>${escapeText(title)}</span><small>${escapeText(previewGroupSummary(entries, trackerName))}</small></button><div class="tracker-preview-items hidden" data-preview-items="${key}"></div></div>`;
  }).join("");
  const summary = previewSummaryCounts(preview);
  const cost = preview.requestEstimate?.batchRequests;
  const directionOptions = directions.map((direction) => `<option value="${direction}">${escapeText(DIRECTION_COPY[direction]?.replace("{label}", trackerName) || direction)}</option>`).join("");
  return `<div class="tracker-full-sync-preview"><div class="tracker-preview-summary tracker-preview-summary-wide"><div class="tracker-preview-metric"><strong>${titleSplitText(summary.missingInPlekt)}</strong><span>missing from Plekt</span></div><div class="tracker-preview-metric"><strong>${titleSplitText(summary.missingOnTracker)}</strong><span>missing from ${escapeText(trackerName)}</span></div><div class="tracker-preview-metric"><strong>${count(summary.unchanged)}</strong><span>left unchanged</span></div><div class="tracker-preview-metric"><strong>${count(summary.datesPreserved)}</strong><span>dates preserved</span></div></div>
    <p class="muted-copy tracker-preview-note">${expired ? "Preview expired. Compare again." : `Valid until ${escapeText(when(preview.expiresAt))}.`} Uses the last saved tracker check; all destinations are rechecked before applying.</p>
    ${cost != null || preview.requestEstimate?.pacing ? `<p class="muted-copy" data-preview-cost></p>` : ""}
    <div class="tracker-preview-toolbar"><label class="tracker-preview-direction">Direction <select class="field" data-preview-direction>${directionOptions}</select></label>
    <label class="tracker-preview-select-all"><input type="checkbox" data-preview-all ${selected.size ? "checked" : ""} ${expired || !selected.size ? "disabled" : ""}> Select all actionable items</label></div>
    <div class="tracker-preview-groups" aria-label="Watches grouped by show">${groupMarkup}</div>
    <div class="tracker-preview-footer"><span>Only selected additions will be applied.</span><button type="button" class="button-primary sync-action-btn sync-tool-button" data-preview-apply ${expired || !selected.size ? "disabled" : ""}>${expired ? "Preview expired" : `Apply ${items(selected.size)}`}</button></div></div>`;
}

// Missing watches counted as titles: distinct TV shows plus movies.
function titleSplit(rows) {
  const shows = new Set(rows.filter((item) => item.type !== "movie").map((item) => (item.type === "show" ? String(item.title || "").trim() : previewGroupTitle(item))));
  return { shows: shows.size, movies: rows.filter((item) => item.type === "movie").length };
}

export function titleSplitText({ shows = 0, movies = 0 } = {}) {
  return `${count(shows)} TV show${shows === 1 ? "" : "s"} · ${count(movies)} movie${movies === 1 ? "" : "s"}`;
}

export function previewSummaryCounts(preview = {}) {
  const rows = preview.items || [];
  const adds = rows.filter((item) => item.operation === "add");
  return {
    missingInPlekt: titleSplit(adds.filter((item) => item.side === "plekt")),
    missingOnTracker: titleSplit(adds.filter((item) => item.side === "tracker")),
    unchanged: rows.filter((item) => item.operation === "skip").length,
    datesPreserved: rows.filter((item) => item.operation === "date_difference").length,
  };
}

export function previewMissingLabel(item = {}, trackerName = "tracker") {
  if (item.operation === "add" && item.side === "plekt") return "Missing from Plekt";
  if (item.operation === "add" && item.side === "tracker") return `Missing from ${trackerName}`;
  if (item.operation === "date_difference") return "Date preserved";
  return "Left unchanged";
}

export function previewGroupSummary(entries = [], trackerName = "tracker") {
  const missingInPlekt = entries.filter((item) => item.operation === "add" && item.side === "plekt").length;
  const missingOnTracker = entries.filter((item) => item.operation === "add" && item.side === "tracker").length;
  const parts = [];
  if (missingInPlekt) parts.push(`${count(missingInPlekt)} missing from Plekt`);
  if (missingOnTracker) parts.push(`${count(missingOnTracker)} missing from ${trackerName}`);
  if (!parts.length) parts.push("nothing to add");
  parts.push(`${count(entries.length)} total`);
  return parts.join(" · ");
}

export function previewGroupTitle(item = {}) {
  if (item.type !== "episode") return "Movies";
  const show = String(item.showTitle || "").trim();
  if (show) return show;
  const title = String(item.title || "TV episodes").trim();
  const withoutCode = title
    .replace(/\s*(?:[-–—:|]\s*)?(?:S(?:eason)?\s*\d+\s*E(?:p(?:isode)?)?\s*\d+|S\d+E\d+)\b.*$/i, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .trim();
  if (withoutCode && withoutCode !== title) return withoutCode;
  if (item.season != null || item.episode != null) {
    const withoutEpisodeName = title.replace(/\s*[-–—:]\s+[^–—:-]+$/, "").trim();
    if (withoutEpisodeName && withoutEpisodeName.length < title.length) return withoutEpisodeName;
  }
  return withoutCode || "TV episodes";
}

function previewItemOrder(a, b) {
  const season = (a.season ?? 0) - (b.season ?? 0);
  if (season) return season;
  const episode = (a.episode ?? 0) - (b.episode ?? 0);
  if (episode) return episode;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

export function previewGroups(preview) {
  const groups = new Map();
  for (const item of preview?.items || []) {
    const title = previewGroupTitle(item);
    const key = item.type === "episode" ? `show:${title.toLocaleLowerCase()}` : "movies";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const entries of groups.values()) entries.sort(previewItemOrder);
  return [...groups.values()].sort((a, b) => previewGroupTitle(a[0]).localeCompare(previewGroupTitle(b[0])));
}

function previewItemMarkup(item, expired, selected, trackerName = "tracker") {
  const selectable = item.selectable && item.operation === "add" && !expired;
  const detail = [item.type === "episode" && item.season != null ? `S${item.season}E${item.episode}` : "", item.watchedAt ? when(item.watchedAt) : "", item.existingWatchedAt ? `Existing date: ${when(item.existingWatchedAt)}` : "", item.destinations?.length ? `Add to ${item.destinations.map(p => ({plekt:'Plekt',plex:'Plex',emby:'Emby',jellyfin:'Jellyfin'}[p] || p)).join(', ')}` : "", ...(item.notes||[]),item.reason || ""].filter(Boolean).join(" · ");
  return `<label class="tracker-preview-item"><input type="checkbox" data-preview-item value="${escapeText(item.id)}" ${selectable ? selected.has(item.id) ? "checked" : "" : "disabled"}> <span><b>${escapeText(item.title)}</b><small>${escapeText(detail || previewMissingLabel(item, trackerName))}</small></span><span class="tracker-preview-operation">${escapeText(previewMissingLabel(item, trackerName))}</span></label>`;
}

export function selectedPacing(preview, selected, direction) {
  const pacing = preview?.requestEstimate?.pacing;
  if (!pacing) return null;
  const outboundCount = selectedPreviewItems(preview, selected, direction).filter(row => row.side === 'tracker').length;
  const batches = Math.ceil(outboundCount / 100);
  const verificationRequests = batches ? Number(pacing.verificationRequests ?? 18) : 0;
  const batchRequests = batches * 4;
  if (!outboundCount) return { ...pacing, itemCount: 0, batchRequests: 0, verificationRequests: 0, totalRequests: 0, estimatedDays: 0, pacingRequired: false, itemsToday: 0, outboundCount: 0 };
  const known = pacing.quotaKnown === true && Number.isFinite(pacing.quotaRemaining) && Number.isFinite(pacing.protectedQuota);
  const perDay = Number.isFinite(pacing.itemsPerFullDay) ? pacing.itemsPerFullDay : null;
  const today = known && perDay != null
    ? Math.min(outboundCount, Math.max(0, Math.floor((pacing.quotaRemaining - pacing.protectedQuota - verificationRequests) / 4)) * 100)
    : null;
  const estimatedDays = known && perDay > 0 && today != null
    ? 1 + Math.ceil(Math.max(0, outboundCount - today) / perDay)
    : null;
  const dailySlices = estimatedDays ?? 1;
  return { ...pacing, itemCount: outboundCount, batchRequests, verificationRequests: verificationRequests * dailySlices, totalRequests: batchRequests + verificationRequests * dailySlices, itemsToday: today, estimatedDays, pacingRequired: today == null ? null : today < outboundCount, outboundCount };
}

function updateApplyState(root, preview, actionable, chosen, fallbackDirection = 'both') {
  const direction=root.querySelector('[data-preview-direction]')?.value||fallbackDirection;
  const selected=selectedPreviewItems(preview,chosen,direction);
  const checked = selected.length;
  const expired = previewIsExpired(preview);
  const apply = root.querySelector("[data-preview-apply]");
  if (apply) { apply.disabled = expired || !checked; apply.textContent = expired ? "Preview expired" : `Apply ${items(checked)}`; }
  const all = root.querySelector("[data-preview-all]");
  if (all) { all.checked = actionable.length>0&&actionable.every(item=>chosen.has(item.id)); all.disabled = expired || !actionable.length; }
  const cost=root.querySelector('[data-preview-cost]');
  if (cost) {
    const pacing = selectedPacing(preview, chosen, direction);
    const outbound = pacing?.outboundCount ?? selected.filter(row => row.side === 'tracker').length;
    if (!outbound) cost.textContent = `Selected missing watches: ${items(selected.length)}. No items will be sent to Simkl; sending budget: 0 requests.`;
    else if (!pacing || !pacing.quotaKnown) cost.textContent = `Selected missing watches: ${items(selected.length)}; sending to Simkl: ${items(outbound)}. Estimated requests including verification allowance: ${pacing?.totalRequests ?? "unavailable"}. Normal-use reserve: ${pacing?.normalReserve == null ? "unavailable" : `${count(pacing.normalReserve)} requests`}. Safety reserve: ${pacing?.safetyReserve == null ? "unavailable" : `${count(pacing.safetyReserve)} requests`}. Quota estimate unavailable; Simkl quota will be checked automatically before starting.`;
    else cost.textContent = `Selected missing watches: ${items(selected.length)}; sending to Simkl: ${items(outbound)}. Estimated requests including verification allowance: ${count(pacing.totalRequests)}. Normal-use reserve: ${count(pacing.normalReserve)} requests. Safety reserve: ${count(pacing.safetyReserve)} requests.${pacing.estimatedDays > 1 ? ` Approximate quota time: ${count(pacing.estimatedDays)} days; continuation is automatic after reset.` : ""}`;
  }
}

async function cancelFullSync(provider, state, button, context) {
  button.disabled = true;
  try {
    const body = await (context.api || request)(`/api/tracker-connections/${provider}/full-sync`, { method: "POST", body: JSON.stringify({ action: "cancel", runId: state?.runId }) });
    // The Initial sync chip may show this run; let it reload its summary.
    document.dispatchEvent?.(new CustomEvent("plekt:full-sync-changed", { detail: { provider } }));
    if (context.onApplied) await context.onApplied(body);
    else await refresh(provider, context);
  } catch (error) {
    button.disabled = false;
    message(provider, error.message, "error", context);
  }
}

function message(provider, text, tone = "error", context = {}) {
  const root = context.root || document.getElementById(context.rootId || `${provider}TrackerExtras`);
  const node = root?.querySelector("[data-full-sync-message]");
  if (!node) return;
  node.textContent = text;
  node.className = `message ${tone}`;
  node.classList.toggle("hidden", !text);
}

async function refresh(provider, context = {}) {
  try {
    const body = await (context.api || request)(`/api/tracker-connections/${provider}`);
    const connection = body.connection || (body.connections || []).find((item) => item.provider === provider);
    if (connection) {context.onRefresh?.(connection);renderTrackerFullSync(provider, connection, context);}
  } catch (error) { message(provider, error.message, "error", context); }
}

async function saveDatePreference(provider, input, context = {}) {
  input.disabled = true;
  try {
    await (context.api || request)(`/api/tracker-connections/${provider}`, { method: "PATCH", body: JSON.stringify({ preferEarlierWatchedDate: input.checked }) });
  } catch (error) {
    input.checked = !input.checked;
    message(provider, error.message, "error", context);
  } finally { input.disabled = false; }
}

async function compare(provider, button, context = {}) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  context.root?.querySelector('[data-full-sync-progress]')?.classList.remove('hidden');
  button.textContent = "Comparing…";
  try {
    await (context.api || request)(`/api/tracker-connections/${provider}/full-sync/compare`, { method: "POST", body: "{}" });
    await refresh(provider, context);
  } catch (error) {
    message(provider, error.message, "error", context);
    button.disabled = false;
    button.textContent = "Compare with Plekt";
  } finally {
    button.removeAttribute('aria-busy');
    context.root?.querySelector('[data-full-sync-progress]')?.classList.add('hidden');
  }
}

async function start(provider, direction, state = {}, context = {}) {
  if (direction === "preview") {
    try {
      const body = await (context.api || request)(`/api/tracker-connections/${provider}/full-sync`, { method: "POST", body: JSON.stringify({ direction: state.direction || "import", planId: state.preview.id, selectedIds: state.selectedIds }) });
      const backup = body.fullSync?.backup||body.backup;
      if (context.onApplied) await context.onApplied(body);
      else await refresh(provider, context);
      if (backup?.name) {
        message(provider, `Backup created: ${backup.name}. `, "success", context);
        const node = context.root?.querySelector("[data-full-sync-message]") || document.querySelector(`#${provider}TrackerExtras [data-full-sync-message]`);
        const link = document.createElement("a");
        link.href = "/settings/backups";
        link.textContent = "Restore from Tools";
        node?.append(link);
      }
    } catch (error) {
      if (/stale|expired|preview/i.test(error.message || "")) {
        await refresh(provider, context);
        message(provider, "The preview changed or expired. Review the refreshed items before applying again.", "error", context);
      } else message(provider, error.message, "error", context);
    }
    return;
  }
}
