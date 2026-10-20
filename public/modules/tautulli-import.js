import { state } from "./state.js?v=2.1.1.0.6";
import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.6";
import { escapeAttribute, escapeHtml } from "./utils.js?v=2.1.1.0.6";
import {
  PLEX_HISTORICAL_SYNC_LABEL,
  plexHistoricalSyncEnabled,
} from "./plex-history-policy.js?v=2.1.1.0.6";

let bound = false;
let preview = null;
let knownUsers = [];
// reviewKey -> { action: "merge" | "import" | "skip", matchedId? }. Content-keyed
// so a decision survives a re-preview even if Tautulli's history shifted.
let reviewDecisions = {};
let previewPending = false;
let previewTimer = null;
let previewStartedAt = 0;
let previewPhase = "starting";
let backupPending = false;
let backupDecision = "pending";
let importPending = false;
let _openConfirmDialog = async () => false;

function el(id) { return document.getElementById(id); }
function headers(json = false) { return { ...buildAuthHeaders(state.token), ...(json ? { "Content-Type": "application/json" } : {}) }; }
function message(text, tone = "muted", targetId = "tautulliConfigMessage") {
  const node = el(targetId);
  if (!node) return;
  node.textContent = text || "";
  const loading = targetId === "tautulliPreviewMessage" && tone === "muted" && /^(Still )?(Reading|Checking|Preparing|Starting)/i.test(text || "");
  node.className = `message ${tone}${loading ? " is-loading" : ""}`;
  node.setAttribute("aria-busy", loading ? "true" : "false");
  node.style.display = text ? "block" : "none";
}
function importStatus(text = "", tone = "muted", loading = false) {
  const node = el("tautulliImportStatus");
  if (!node) return;
  node.textContent = text;
  node.className = `message tautulli-import-status ${tone}${loading ? " is-loading" : ""}`;
  node.setAttribute("aria-busy", loading ? "true" : "false");
  node.style.display = text ? (loading ? "inline-flex" : "block") : "none";
}
// There is deliberately no per-server choice here. Plekt is the source of
// truth, so its scheduled sync brings Emby and Jellyfin into line with imported
// watches regardless - and they receive the original playback dates, so the
// watches land correctly in their history either way. Asking would imply a
// choice that does not exist. Plex is the one server where a setting genuinely
// prevents the data arriving, and that lives in Sync Tuning.
function renderPlexNotice() {
  const node = el("tautulliPlexNotice");
  if (!node) return;
  const plexConnected = Boolean(state.savedConfig?.plex?.configured) && !state.savedConfig?.plex?.disabled;
  const historicalOff = !plexHistoricalSyncEnabled(state.savedConfig || {});
  if (!plexConnected || !historicalOff) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  node.innerHTML = `<b>These watches will not be sent to Plex.</b> `
    + `You have turned <b>${escapeHtml(PLEX_HISTORICAL_SYNC_LABEL)}</b> off in Settings &rarr; Sync &rarr; Sync Tuning, `
    + `so imported history is not projected to Plex and those items may stay unwatched there. `
    + `Emby and Jellyfin still receive them with their original playback dates. `
    + `Turn that setting on before importing if you want Plex updated too.`;
  node.hidden = false;
}
function updateActionState() {
  const config = state.savedConfig?.tautulli || {};
  const userId = el("tautulliUserId")?.value || config.userId || "";
  const ready = Boolean(config.configured);
  if (el("tautulliPreviewButton")) el("tautulliPreviewButton").disabled = previewPending || !ready || !userId;
  const hasImportableRecords = Boolean(preview && preview.result?.new !== 0);
  if (el("tautulliBackupButton")) el("tautulliBackupButton").disabled = backupPending || importPending || previewPending || !ready || !userId || !hasImportableRecords || backupDecision !== "pending";
  if (el("tautulliSkipBackupButton")) el("tautulliSkipBackupButton").disabled = backupPending || importPending || previewPending || !ready || !userId || !hasImportableRecords || backupDecision !== "pending";
  if (el("tautulliImportButton")) el("tautulliImportButton").disabled = importPending || backupPending || previewPending || !ready || !userId || !hasImportableRecords || backupDecision === "pending";
}

function previewElapsedLabel(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const prefix = previewPhase === "counting"
    ? "Checking Tautulli history size…"
    : previewPhase === "reading"
      ? "Reading Tautulli history…"
      : previewPhase === "preparing"
        ? "Preparing preview…"
        : "Connecting to Tautulli…";
  if (seconds < 10) return `${prefix} ${seconds}s`;
  if (seconds < 60) return `${prefix} ${seconds}s (large histories may take a few minutes)`;
  const minutes = Math.floor(seconds / 60);
  return `Still ${prefix.toLowerCase()} ${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function setPreviewProgress(status = null) {
  const container = el("tautulliPreviewProgress");
  const bar = el("tautulliPreviewProgressBar");
  const text = el("tautulliPreviewProgressText");
  if (!container || !bar || !text) return;
  if (!status) {
    container.hidden = true;
    text.hidden = true;
    container.classList.remove("is-indeterminate");
    bar.style.width = "0%";
    return;
  }
  previewPhase = status.phase || previewPhase;
  const progress = status.progress || {};
  const hasTotal = Number.isFinite(progress.total) && progress.total > 0;
  const percent = hasTotal && Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
  container.hidden = false;
  container.classList.toggle("is-indeterminate", !hasTotal);
  bar.style.width = hasTotal ? `${percent}%` : "35%";
  container.setAttribute("aria-valuenow", String(percent));
  text.hidden = false;
  text.textContent = status.phase === "starting" || status.phase === "connecting"
    ? "Connecting to Tautulli…"
    : status.phase === "counting"
    ? "Checking how many completed movie and episode plays Tautulli has…"
    : status.phase === "preparing"
      ? "Matching imported history against existing Plekt records…"
      : hasTotal
        ? `Read ${Number(progress.completed || 0).toLocaleString()} of ${Number(progress.total).toLocaleString()} history records (${percent}%).`
        : "Reading completed movie and episode history…";
  const summary = el("tautulliPreviewSummary");
  if (summary && status.phase === "preparing") {
    summary.textContent = "[working] Matching completed plays against existing Plekt history and preparing the preview summary.";
  }
}

function startPreviewProgress() {
  previewStartedAt = Date.now();
  previewPhase = "starting";
  previewPending = true;
  importStatus();
  backupDecision = "pending";
  if (el("tautulliBackupButton")) el("tautulliBackupButton").textContent = "Create backup (Recommended)";
  if (el("tautulliImportButton")) el("tautulliImportButton").textContent = "Import Tautulli history";
  setOperationProgress("tautulliBackup");
  setOperationProgress("tautulliImport");
  if (el("tautulliBackupStatus")) {
    el("tautulliBackupStatus").textContent = "";
    el("tautulliBackupStatus").style.display = "none";
  }
  if (el("tautulliImportStatus")) {
    el("tautulliImportStatus").textContent = "";
    el("tautulliImportStatus").style.display = "none";
  }
  updateActionState();
  if (el("tautulliPreviewSummary")) {
    el("tautulliPreviewSummary").textContent = "[working] Checking the history size first, then reading completed movie and episode records from Tautulli.";
  }
  setPreviewProgress({ phase: previewPhase, progress: {} });
  message(previewElapsedLabel(previewStartedAt), "muted", "tautulliPreviewMessage");
  const update = () => message(previewElapsedLabel(previewStartedAt), "muted", "tautulliPreviewMessage");
  previewTimer = window.setInterval(update, 1000);
}

function stopPreviewProgress() {
  if (previewTimer) window.clearInterval(previewTimer);
  previewTimer = null;
  setPreviewProgress();
  previewPending = false;
  updateActionState();
}

function setOperationProgress(prefix, text = "", state = "working") {
  const container = el(`${prefix}Progress`);
  const bar = el(`${prefix}ProgressBar`);
  const status = el(`${prefix}ProgressText`);
  if (!container || !bar || !status) return;
  if (!text) {
    container.hidden = true;
    status.hidden = true;
    container.classList.remove("is-indeterminate", "is-complete", "is-error");
    bar.style.width = "0%";
    return;
  }
  const complete = state === "complete";
  container.hidden = false;
  container.classList.toggle("is-indeterminate", state === "working");
  container.classList.toggle("is-complete", complete);
  container.classList.toggle("is-error", state === "error");
  bar.style.width = complete ? "100%" : "35%";
  container.setAttribute("aria-valuenow", complete ? "100" : "0");
  status.hidden = false;
  status.textContent = text;
  status.className = `tautulli-operation-progress-text ${state === "error" ? "is-error" : complete ? "is-complete" : ""}`;
}

async function readPreviewJob(body) {
  const startResponse = await fetch("/api/tautulli/import/preview/start", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
  const start = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok || !start.ok || !start.jobId) throw new Error(start.error || "Could not start Tautulli preview");
  setPreviewProgress(start);
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const response = await fetch(`/api/tautulli/import/preview/status?jobId=${encodeURIComponent(start.jobId)}`, { headers: headers() });
    const status = await response.json().catch(() => ({}));
    if (!response.ok || !status.ok) throw new Error(status.error || "Tautulli preview status failed");
    setPreviewProgress(status);
    if (status.status === "complete") return status.result;
    if (status.status === "failed") throw new Error(status.error || "Tautulli preview failed");
  }
  throw new Error("Tautulli preview is taking longer than 12 minutes. Check the Tautulli connection and try again.");
}

// The per-target decision the server computed for this preview: the operation's
// own checkbox choice first, then the standing Plex historical policy. Saying
// "not selected" and "skipped by policy" in the same words the server uses keeps
// a deliberate policy skip from reading as a broken target.
const TARGET_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const DECISION_COPY = {
  send: "will receive this import",
  not_selected: "not selected for this import",
  skipped_by_policy: "skipped by the historical sync policy",
};

function renderPolicyNote(targetPlan = []) {
  const node = el("tautulliPolicyNote");
  if (!node) return;
  if (!targetPlan.length) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const lines = targetPlan.map((entry) => {
    const label = TARGET_LABELS[entry.target] || entry.target;
    return `<b>${escapeHtml(label)}</b>: ${escapeHtml(DECISION_COPY[entry.decision] || entry.decision)}`;
  });
  // Read the policy state from the plan the server just returned, not from the
  // browser's cached config: the plan is the authoritative answer for this
  // import, and a stale cache would let this sentence contradict the per-target
  // line immediately above it. Fall back to the cache only when Plex is not a
  // configured target at all and so has no plan entry.
  const plexEntry = targetPlan.find((entry) => entry.target === "plex");
  const policyOn = plexEntry
    ? plexEntry.decision !== "skipped_by_policy"
    : plexHistoricalSyncEnabled(state.savedConfig || {});
  lines.push(
    `<b>${escapeHtml(PLEX_HISTORICAL_SYNC_LABEL)}</b> is currently <b>${policyOn ? "on" : "off"}</b> (Settings &rarr; Sync &rarr; Sync Tuning). Emby, Jellyfin, and Trakt receive the original Tautulli playback date either way; Plex receives the watched state only, and its activity date may show as today.`,
  );
  node.innerHTML = lines.join("<br>");
  node.hidden = false;
}

function reviewItemLabel(review = {}) {
  if (review.media_type === "episode" && review.season != null && review.episode != null) {
    const code = `S${String(review.season).padStart(2, "0")}E${String(review.episode).padStart(2, "0")}`;
    return `${review.show_title || review.title} - ${code}`;
  }
  return review.title || "Unknown title";
}

function candidateLabel(candidate = {}) {
  const when = candidate.watched_at ? new Date(candidate.watched_at).toLocaleString() : "unknown date";
  const source = candidate.source ? ` - ${candidate.source}` : "";
  return `${when}${source}`;
}

// Two different questions share one panel, so each row has to say which it is
// asking. An ambiguous identity means "which of these records is this play?";
// a possible rewatch means "is this a second viewing, or the same one dated
// differently?".
function reviewRowCopy(review = {}) {
  if (review.reason === "possible_rewatch") {
    const gap = Number(review.gapDays);
    const when = Number.isFinite(gap)
      ? `${gap < 1 ? "less than a day" : `${gap} day${gap === 1 ? "" : "s"}`} apart`
      : "close together";
    return {
      badge: "Possible rewatch",
      note: `Plekt already has this watched ${when}. Is this a second viewing, or the same one recorded with a different date?`,
      mergeLabel: "Same viewing",
    };
  }
  return {
    badge: "Possible match",
    note: "This play matches more than one record Plekt already has.",
    mergeLabel: "Use this record",
  };
}

function renderReviews(reviews = []) {
  const panel = el("tautulliReviewPanel");
  const list = el("tautulliReviewList");
  const count = el("tautulliReviewCount");
  const bulk = el("tautulliReviewBulk");
  if (!panel || !list) return;
  if (!reviews.length) {
    panel.hidden = true;
    list.innerHTML = "";
    if (bulk) bulk.hidden = true;
    return;
  }
  panel.hidden = false;
  const rewatches = reviews.filter((review) => review.reason === "possible_rewatch").length;
  if (count) {
    count.textContent = rewatches && rewatches !== reviews.length
      ? `${reviews.length} to review (${rewatches} possible rewatches)`
      : `${reviews.length} to review`;
  }
  // Deciding a hundred rows one at a time is not reasonable, and the rewatch
  // question usually has the same answer for a whole import.
  if (bulk) bulk.hidden = rewatches < 2;
  list.innerHTML = reviews.map((review) => {
    const key = escapeAttribute(review.reviewKey);
    const chosen = reviewDecisions[review.reviewKey];
    const copy = reviewRowCopy(review);
    const extra = review.candidateCount > review.candidates.length
      ? `<small class="muted-copy">and ${review.candidateCount - review.candidates.length} more</small>`
      : "";
    const candidates = review.candidates.map((candidate) => {
      const active = chosen?.action === "merge" && chosen.matchedId === candidate.id;
      return `<button type="button" class="tautulli-review-candidate${active ? " is-chosen" : ""}" aria-pressed="${active ? "true" : "false"}" data-tautulli-review="merge" data-review-key="${key}" data-matched-id="${escapeAttribute(candidate.id || "")}">${escapeHtml(copy.mergeLabel)}<small>${escapeHtml(candidateLabel(candidate))}</small></button>`;
    }).join("");
    return `
      <article class="tautulli-review-row" data-review-row="${key}" data-review-reason="${escapeAttribute(review.reason || "ambiguous_identity")}">
        <div class="tautulli-review-item">
          <b>${escapeHtml(reviewItemLabel(review))}</b>
          <span class="badge tautulli-review-badge">${escapeHtml(copy.badge)}</span>
          <small class="muted-copy">Tautulli play: ${escapeHtml(review.watched_at ? new Date(review.watched_at).toLocaleString() : "unknown date")}</small>
          <small class="muted-copy">${escapeHtml(copy.note)}</small>
        </div>
        <div class="tautulli-review-choices">
          ${candidates}
          ${extra}
          <button type="button" class="tautulli-review-action${chosen?.action === "import" ? " is-chosen" : ""}" aria-pressed="${chosen?.action === "import" ? "true" : "false"}" data-tautulli-review="import" data-review-key="${key}">${review.reason === "possible_rewatch" ? "Separate rewatch" : "Import as a separate play"}</button>
          <button type="button" class="tautulli-review-action${chosen?.action === "skip" ? " is-chosen" : ""}" aria-pressed="${chosen?.action === "skip" ? "true" : "false"}" data-tautulli-review="skip" data-review-key="${key}">Skip this play</button>
        </div>
      </article>`;
  }).join("");
}

// Applies one answer to every undecided possible-rewatch row. Deliberately
// leaves rows the user has already decided alone, and never touches an
// ambiguous-identity row - those have several candidates and no single sensible
// bulk answer.
function applyBulkRewatchDecision(action) {
  const reviews = (preview?.result?.reviews || []).filter((review) => review.reason === "possible_rewatch");
  let applied = 0;
  for (const review of reviews) {
    if (reviewDecisions[review.reviewKey]) continue;
    reviewDecisions[review.reviewKey] = action === "merge"
      ? { action, matchedId: review.candidates[0]?.id || null }
      : { action };
    applied += 1;
  }
  renderReviews(preview?.result?.reviews || []);
  const all = preview?.result?.reviews || [];
  message(
    `Applied to ${applied} undecided possible rewatch${applied === 1 ? "" : "es"}. ${decidedReviewCount(all)} of ${all.length} decided.`,
    decidedReviewCount(all) === all.length ? "success" : "warning",
    "tautulliPreviewMessage",
  );
}

function decidedReviewCount(reviews = []) {
  return reviews.filter((review) => reviewDecisions[review.reviewKey]).length;
}

// Repaints one row's buttons rather than re-rendering the whole list. The panel
// scrolls and can hold dozens of rows, so rebuilding its innerHTML on every
// click would throw away the scroll position and the focused button mid-review.
function paintReviewRow(reviewKey) {
  const row = document.querySelector(`[data-review-row="${CSS.escape(reviewKey)}"]`);
  if (!row) return;
  const chosen = reviewDecisions[reviewKey];
  for (const button of row.querySelectorAll("[data-tautulli-review]")) {
    const action = button.dataset.tautulliReview;
    const active = chosen?.action === action
      && (action !== "merge" || (button.dataset.matchedId || null) === chosen.matchedId);
    button.classList.toggle("is-chosen", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function renderUsers(users = null, selected = "") {
  const select = el("tautulliUserId");
  if (!select) return;
  if (Array.isArray(users)) knownUsers = users;
  const options = knownUsers.length
    ? `<option value="">Choose a Tautulli user</option>${knownUsers.map((user) => `<option value="${String(user.id).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${String(user.name || user.id).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`).join("")}`
    : selected
      ? `<option value="${String(selected).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Saved Tautulli user</option>`
      : `<option value="">Test the connection to load users</option>`;
  select.innerHTML = options;
  if (selected) select.value = selected;
  updateActionState();
}
function renderConfig({ selectedUserId = "" } = {}) {
  const config = state.savedConfig?.tautulli || {};
  if (el("tautulliBaseUrl")) el("tautulliBaseUrl").value = config.baseUrl || "http://127.0.0.1:8181";
  const apiKey = el("tautulliApiKey");
  if (apiKey) {
    // The API key is intentionally never returned to the browser. Keep the
    // field empty after reload, but make it clear that an existing key is
    // retained when the user saves without entering a replacement.
    apiKey.value = "";
    apiKey.placeholder = config.configured ? "Saved API key — leave blank to keep it" : "Tautulli API key";
  }
  const apiKeyHint = el("tautulliApiKeyHint");
  if (apiKeyHint) apiKeyHint.textContent = config.configured
    ? "A saved API key is kept when this field is blank. Enter a new key only to replace it."
    : "Required when saving a new Tautulli connection.";
  renderUsers(knownUsers, selectedUserId || config.userId || "");
  renderPlexNotice();
  const ready = Boolean(config.configured);
  if (el("tautulliStatus")) {
    el("tautulliStatus").textContent = ready ? "Configured" : "Not configured";
    el("tautulliStatus").className = `status-pill ${ready ? "status-success" : "status-muted"}`;
  }
  updateActionState();
}
// Settings init and the saved-config event both ask within moments of each
// other; maxAgeMs lets them share one request. Imports always refetch.
let statusRequest = null;
let statusAt = 0;
function loadStatus({ maxAgeMs = 0 } = {}) {
  if (!state.token) return Promise.resolve();
  if (maxAgeMs && statusRequest) return statusRequest;
  if (maxAgeMs && Date.now() - statusAt < maxAgeMs) return Promise.resolve();
  statusRequest = fetchStatus().finally(() => { statusRequest = null; });
  return statusRequest;
}
async function fetchStatus() {
  const response = await fetch("/api/tautulli/status", { headers: headers() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Tautulli status failed");
  statusAt = Date.now();
  const latest = body.latestBackup;
  const node = el("tautulliLastBackupStatus");
  if (node) node.textContent = latest ? `Last local backup: ${latest.name} (${new Date(latest.createdAt).toLocaleString()})` : "No local backup yet. One will be created automatically before import.";
}
async function testAndLoadUsers() {
  const body = { baseUrl: el("tautulliBaseUrl")?.value.trim(), apiKey: el("tautulliApiKey")?.value.trim() };
  message("Testing Tautulli and loading users…");
  const response = await fetch("/api/tautulli/test", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Tautulli connection failed");
  renderUsers(result.users || [], state.savedConfig?.tautulli?.userId || "");
  message(`Connected to Tautulli${result.serverInfo?.version ? ` ${result.serverInfo.version}` : ""}. Choose a user, then save.`, "success");
}
async function saveConnection(event) {
  event.preventDefault();
  const selectedUserId = el("tautulliUserId")?.value || state.savedConfig?.tautulli?.userId || "";
  const payload = {
    baseUrl: el("tautulliBaseUrl")?.value.trim(),
    apiKey: el("tautulliApiKey")?.value.trim(),
    userId: selectedUserId,
    disabled: false,
  };
  message("Saving Tautulli connection…");
  const response = await fetch("/api/config", { method: "POST", headers: headers(true), body: JSON.stringify({ tautulli: payload }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || (result.details || []).join("; ") || "Could not save Tautulli");
  state.savedConfig = result.config || state.savedConfig;
  // Keep the user's selection even if a redacted/legacy config response omits
  // it. The server still receives and persists the value in the payload.
  if (state.savedConfig?.tautulli && selectedUserId && !state.savedConfig.tautulli.userId) {
    state.savedConfig.tautulli.userId = selectedUserId;
  }
  preview = null;
  renderConfig({ selectedUserId });
  message("Tautulli connection details saved. You can choose a user and preview history later.", "success");
  await loadStatus().catch(() => null);
}
async function previewImport() {
  if (previewPending) return;
  const body = {
    userId: el("tautulliUserId")?.value || state.savedConfig?.tautulli?.userId,
    fromDate: el("tautulliFromDate")?.value || "",
    reviewDecisions,
  };
  if (!body.userId) throw new Error("Choose a Tautulli user first.");
  preview = null;
  startPreviewProgress();
  try {
    const result = await readPreviewJob(body);
    preview = { body, result };
    renderPolicyNote(result.targetPlan || []);
    renderReviews(result.reviews || []);
    const reviewed = Number(result.reviewed_merged || 0) + Number(result.reviewed_imported || 0) + Number(result.reviewed_skipped || 0);
    const summary = [
      `Preview found ${Number(result.total || 0).toLocaleString()} plays in the selected history:`,
      `• ${Number(result.new || 0).toLocaleString()} plays are ready to import into Plekt.`,
      `• ${Number(result.merged || 0).toLocaleString()} plays are already in Plekt, so they will be skipped.`,
      `• ${Number(result.skipped_incomplete || 0).toLocaleString()} incomplete or part-watched plays will be ignored.`,
      `• ${Number(result.skipped_newer_unwatch || 0).toLocaleString()} plays are older than a later unwatch in Plekt, so they will be skipped.`,
      `• ${Number(result.needs_review || 0).toLocaleString()} have more than one possible match and still need a decision below.`,
      `• ${Number(result.unresolved || 0).toLocaleString()} could not be matched because key details were missing.`,
      ...(reviewed ? [
        `Review decisions applied: ${Number(result.reviewed_imported || 0).toLocaleString()} imported as separate plays, ${Number(result.reviewed_merged || 0).toLocaleString()} merged into an existing record, ${Number(result.reviewed_skipped || 0).toLocaleString()} skipped.`,
      ] : []),
      "",
      "Where this import will be sent:",
      ...(result.targetPlan || []).map((entry) => `• ${TARGET_LABELS[entry.target] || entry.target}: ${DECISION_COPY[entry.decision] || entry.decision}`),
    ].join("\n");
    if (el("tautulliPreviewSummary")) el("tautulliPreviewSummary").textContent = summary;
    backupDecision = "pending";
    const pending = Number(result.needs_review || 0);
    message(
      pending
        ? `Preview ready. ${pending} play${pending === 1 ? "" : "s"} still need a decision below; anything left undecided is not imported.`
        : "Preview ready. Review target choices, then import.",
      pending ? "warning" : "success",
      "tautulliPreviewMessage",
    );
  } finally {
    stopPreviewProgress();
  }
}
// The confirmation states the standing Plex policy as well as the counts,
// because the policy decides whether Plex sees this import at all and the user
// should not discover that afterwards.
function importConfirmationText(result = {}) {
  const lines = [`Import ${Number(result.new || 0)} new Tautulli watch record(s)?`];
  const pending = Number(result.needs_review || 0);
  if (pending) lines.push(`${pending} play(s) with more than one possible match have no decision yet and will NOT be imported.`);
  for (const entry of result.targetPlan || []) {
    lines.push(`${TARGET_LABELS[entry.target] || entry.target}: ${DECISION_COPY[entry.decision] || entry.decision}`);
  }
  const plexSkipped = (result.targetPlan || []).some((entry) => entry.target === "plex" && entry.decision === "skipped_by_policy");
  if (plexSkipped) {
    lines.push(`"${PLEX_HISTORICAL_SYNC_LABEL}" is off, so historical Plex writes are skipped. Emby, Jellyfin, and Trakt still receive the original playback date.`);
  }
  return lines.join("\n\n");
}

async function runImport() {
  if (!preview || backupDecision === "pending") return;
  const confirmed = await _openConfirmDialog({
    title: "Confirm Tautulli import",
    body: importConfirmationText(preview.result),
    confirmLabel: "Import Tautulli history",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;
  importPending = true;
  updateActionState();
  const importButton = el("tautulliImportButton");
  if (importButton) importButton.textContent = "Importing…";
  const body = { ...preview.body, reviewDecisions, backup: false };
  setOperationProgress("tautulliImport", "Importing Tautulli history…", "working");
  importStatus("Importing Tautulli history…", "muted", true);
  const response = await fetch("/api/tautulli/import", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Tautulli import failed");
  const targetPlan = Array.isArray(result.targetPlan) ? result.targetPlan : [];
  const summary = [
    `Imported ${Number(result.inserted || 0).toLocaleString()} new record(s).`,
    `• ${Number(result.merged || 0).toLocaleString()} already represented in Plekt.`,
    `• ${Number(result.skipped_incomplete || 0).toLocaleString()} incomplete or part-watched plays ignored.`,
    `• ${Number(result.skipped_newer_unwatch || 0).toLocaleString()} skipped because a later unwatch in Plekt supersedes them.`,
    `• ${Number(result.reviewed_merged || 0).toLocaleString()} reviewed and merged into an existing record.`,
    `• ${Number(result.reviewed_imported || 0).toLocaleString()} reviewed and imported as separate plays.`,
    `• ${Number(result.reviewed_skipped || 0).toLocaleString()} reviewed and skipped.`,
    `• ${Number(result.needs_review || 0).toLocaleString()} left undecided and not imported.`,
    `• ${Number(result.unresolved || 0).toLocaleString()} unresolved (key details missing).`,
    `• ${Number(result.rejectedRows || 0).toLocaleString()} rejected on insert.`,
    "",
    "Outbound projection:",
    ...targetPlan.map((entry) => `• ${TARGET_LABELS[entry.target] || entry.target}: ${DECISION_COPY[entry.decision] || entry.decision}`),
    "Selected targets are queued for background sync; skipped ones were not queued and will not retry.",
  ].join("\n");
  if (el("tautulliImportSummary")) el("tautulliImportSummary").textContent = summary;
  try {
    renderPolicyNote(targetPlan);
    // Decisions belong to the import that consumed them.
    reviewDecisions = {};
    renderReviews(Array.isArray(result.reviews) ? result.reviews : []);
  } catch (error) {
    console.warn("Tautulli import result rendering failed after a successful import", error);
  }
  preview = null;
  importPending = false;
  if (importButton) {
    importButton.disabled = true;
    importButton.textContent = "Import complete";
  }
  setOperationProgress("tautulliImport", "Import complete.", "complete");
  importStatus("Import complete. Plekt is now syncing imported watches to your connected media servers.", "success");
  await loadStatus().catch(() => null);
}

async function runBackup() {
  if (!preview || backupDecision !== "pending" || backupPending) return;
  backupPending = true;
  updateActionState();
  const backupButton = el("tautulliBackupButton");
  if (backupButton) backupButton.textContent = "Creating backup…";
  setOperationProgress("tautulliBackup", "Creating a local watch-history backup…", "working");
  const status = el("tautulliBackupStatus");
  if (status) {
    status.textContent = "Creating a restore point before import…";
    status.className = "message tautulli-operation-status muted";
    status.style.display = "block";
  }
  try {
    const response = await fetch("/api/tautulli/backup", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Tautulli backup failed");
    backupDecision = "created";
    backupPending = false;
    if (backupButton) backupButton.textContent = "Backup complete";
    setOperationProgress("tautulliBackup", "Backup complete. Your restore point is ready.", "complete");
    if (status) {
      status.textContent = `Backup complete${result.backup?.name ? `: ${result.backup.name}` : ""}. Import is ready when you are.`;
      status.className = "message tautulli-operation-status success";
    }
    await loadStatus().catch(() => null);
    updateActionState();
  } catch (error) {
    backupPending = false;
    if (backupButton) backupButton.textContent = "Create backup (Recommended)";
    setOperationProgress("tautulliBackup", error?.message || "Tautulli backup failed", "error");
    if (status) {
      status.textContent = error?.message || "Tautulli backup failed";
      status.className = "message tautulli-operation-status error";
    }
    updateActionState();
    throw error;
  }
}

function skipBackup() {
  if (!preview || backupDecision !== "pending" || backupPending) return;
  backupDecision = "skipped";
  setOperationProgress("tautulliBackup");
  const status = el("tautulliBackupStatus");
  if (status) {
    status.textContent = "Backup skipped. You can continue, but there is no pre-import restore point for this import.";
    status.className = "message tautulli-operation-status warning";
    status.style.display = "block";
  }
  updateActionState();
}

function handleImportError(error) {
  importPending = false;
  const importButton = el("tautulliImportButton");
  if (importButton) importButton.textContent = "Import Tautulli history";
  updateActionState();
  const text = error?.message || "Tautulli import failed";
  setOperationProgress("tautulliImport", text, "error");
  importStatus(text, "error");
}

function handleReviewClick(event) {
  const button = event.target.closest("[data-tautulli-review]");
  if (!button) return;
  const key = button.dataset.reviewKey;
  const action = button.dataset.tautulliReview;
  if (!key || !action) return;
  const current = reviewDecisions[key];
  const matchedId = button.dataset.matchedId || null;
  // Clicking the active choice again clears it, returning the row to undecided.
  const isSame = current?.action === action && (action !== "merge" || current.matchedId === matchedId);
  if (isSame) delete reviewDecisions[key];
  else reviewDecisions[key] = action === "merge" ? { action, matchedId } : { action };
  paintReviewRow(key);
  const reviews = preview?.result?.reviews || [];
  const decided = decidedReviewCount(reviews);
  message(
    decided === reviews.length
      ? "All possible matches decided. Run the import to apply them."
      : `${decided} of ${reviews.length} possible matches decided. Undecided plays are not imported.`,
    decided === reviews.length ? "success" : "warning",
    "tautulliPreviewMessage",
  );
}
export function initTautulliImport(callbacks = {}) {
  if (callbacks.openConfirmDialog) _openConfirmDialog = callbacks.openConfirmDialog;
  if (bound) return;
  bound = true;
  el("tautulliConfigForm")?.addEventListener("submit", (event) => saveConnection(event).catch((error) => message(error.message, "error")));
  el("tautulliTestButton")?.addEventListener("click", () => testAndLoadUsers().catch((error) => message(error.message, "error")));
  el("tautulliUserId")?.addEventListener("change", updateActionState);
  el("tautulliPreviewButton")?.addEventListener("click", () => previewImport().catch((error) => message(error.message, "error", "tautulliPreviewMessage")));
  el("tautulliBackupButton")?.addEventListener("click", () => runBackup().catch((error) => message(error.message, "error", "tautulliBackupStatus")));
  el("tautulliSkipBackupButton")?.addEventListener("click", skipBackup);
  el("tautulliImportButton")?.addEventListener("click", () => runImport().catch(handleImportError));
  el("tautulliReviewList")?.addEventListener("click", handleReviewClick);
  el("tautulliReviewBulk")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tautulli-review-bulk]");
    if (button) applyBulkRewatchDecision(button.dataset.tautulliReviewBulk);
  });
  document.addEventListener("plembfin:config-changed", () => { renderConfig(); loadStatus({ maxAgeMs: 2000 }).catch(() => null); });
  renderConfig();
  loadStatus({ maxAgeMs: 2000 }).catch(() => null);
}

// The settings shell can mount this panel before the first async config load
// completes. The bootstrap path calls this hook once the redacted saved config
// is available so the controls cannot remain on their initial defaults.
export function refreshTautulliImport() {
  renderConfig();
}
