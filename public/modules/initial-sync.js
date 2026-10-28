import { buildAuthHeaders } from "./auth.js?v=2.2.0.1.0";
import { state } from "./state.js?v=2.2.0.1.0";
import { escapeHtml, isDemoMode } from "./utils.js?v=2.2.0.1.0";

const VISIBLE_STATUSES = new Set(["waiting", "planning", "running", "waiting_quota", "interrupted", "partial", "failed"]);
const ACTIVE_STATUSES = new Set(["waiting", "planning", "running", "waiting_quota"]);
let summary = null;
let loadError = "";
let requestPromise = null;
let requestSerial = 0;
let listenersBound = false;
let returnFocus = null;

function node(selector) {
  return document.querySelector(selector);
}

function statusLabel(status) {
  const labels = {
    waiting: "Waiting to start",
    planning: "Planning",
    running: "Running",
    waiting_quota: "Waiting for quota",
    interrupted: "Interrupted",
    partial: "Partially completed",
    failed: "Failed",
    held: "Held",
    pending: "Pending",
    sending: "Sending",
    review: "Needs review",
    completed: "Completed",
    cancelled: "Cancelled",
  };
  return labels[String(status || "").toLowerCase()] || "Status unavailable";
}

function countText(value, noun, plural = `${noun}s`) {
  const count = Math.max(Number(value) || 0, 0);
  return `${count} ${count === 1 ? noun : plural}`;
}

function localDateTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

function pacingMarkup(pacing, nextRunAt, remainingItems) {
  if (!pacing || typeof pacing !== "object") return "";
  const remaining = Math.max(Number(remainingItems) || 0, 0);
  const when = localDateTime(nextRunAt || pacing.nextResetAt);
  const requests = pacing.totalRequests ?? (remaining ? Math.ceil(remaining / 100) * 4 + 18 * (Number.isFinite(Number(pacing.estimatedDays)) ? Math.max(1, Number(pacing.estimatedDays)) : 1) : 0);
  const quotaDetails = pacing.quotaKnown === true
    ? `Estimated requests including verification allowance: ${countText(requests, "request")}. Normal-use reserve: ${countText(pacing.normalReserve ?? 0, "request")}; safety reserve: ${countText(pacing.safetyReserve ?? 0, "request")}.`
    : `Estimated requests including verification allowance: ${requests == null ? "unavailable" : countText(requests, "request")}. Normal-use reserve: ${pacing.normalReserve == null ? "unavailable" : countText(pacing.normalReserve, "request")}; safety reserve: ${pacing.safetyReserve == null ? "unavailable" : countText(pacing.safetyReserve, "request")}. Quota estimate unavailable; Simkl quota will be checked automatically before starting.`;
  const days = Number(pacing.estimatedDays);
  const duration = Number.isFinite(days) && days > 1 ? ` Approximate quota time: ${countText(days, "day")}; continuation is automatic after reset.` : "";
  const resume = when ? ` Next resume: ${escapeHtml(when)}.` : "";
  return `<section class="initial-sync-pacing" aria-label="Simkl full sync pacing"><p>${escapeHtml(countText(remaining, "missing watch", "missing watches"))} selected for sending. ${escapeHtml(quotaDetails)}${escapeHtml(duration)}</p>${pacing.pacingRequired === true || nextRunAt ? `<p class="initial-sync-pacing-wait">Waiting for quota.${resume}</p>` : ""}</section>`;
}

function destinationMarkup(destination) {
  const label = escapeHtml(destination?.label || destination?.provider || "Destination");
  const status = String(destination?.status || "").toLowerCase();
  const remaining = Math.max(Number(destination?.remaining) || 0, 0);
  const total = Math.max(Number(destination?.total) || 0, 0);
  const count = total > 0 ? `${countText(remaining, "item")} remaining of ${total}` : countText(remaining, "item");
  const explanation = escapeHtml(destination?.error || statusLabel(status));
  // Pacing and the resume time only describe a run that is still going.
  const pacing = destination?.pacing && ACTIVE_STATUSES.has(status) ? pacingMarkup(destination.pacing, destination.nextRunAt, remaining) : "";
  return `<section class="initial-sync-destination" aria-label="${label}">
    <div class="initial-sync-destination-heading"><h3>${label}</h3><span class="initial-sync-status-label" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span></div>
    <p class="initial-sync-destination-count">${escapeHtml(count)}</p>
    <p class="initial-sync-destination-detail">${explanation}</p>${pacing}
  </section>`;
}

function itemMarkup(item) {
  const title = escapeHtml(item?.title || "Untitled item");
  const showTitle = String(item?.showTitle || "").trim();
  const type = String(item?.type || "").toLowerCase();
  const episode = type === "episode" && (item?.season != null || item?.episode != null)
    ? `Season ${escapeHtml(item?.season ?? "?")}, episode ${escapeHtml(item?.episode ?? "?")}`
    : "";
  const metadata = [showTitle && showTitle !== item?.title ? escapeHtml(showTitle) : "", episode, item?.destination ? escapeHtml(item.destination) : ""]
    .filter(Boolean).join(" · ");
  const status = escapeHtml(statusLabel(item?.status || "pending"));
  const detail = item?.detail ? `<p class="initial-sync-item-detail">${escapeHtml(item.detail)}</p>` : "";
  return `<li class="initial-sync-item">
    <div class="initial-sync-item-heading"><strong>${title}</strong><span>${status}</span></div>
    ${metadata ? `<p class="initial-sync-item-meta">${metadata}</p>` : ""}${detail}
  </li>`;
}

export function initialSyncDialogMarkup(data = summary, error = loadError) {
  const destinations = Array.isArray(data?.destinations) ? data.destinations : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const status = String(data?.status || "").toLowerCase();
  const heading = data?.error || error || statusLabel(status);
  const counts = Math.max(Number(data?.remaining) || 0, 0);
  const total = Math.max(Number(data?.total) || 0, 0);
  const itemSummary = total > 0 ? `${countText(counts, "item")} remaining of ${total}` : countText(counts, "item");
  const statusCopy = `<p class="initial-sync-summary" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))} · ${escapeHtml(itemSummary)}</p>`;
  const explanation = `<p class="initial-sync-explanation">${escapeHtml(heading)}</p>`;
  const destinationsMarkup = destinations.length
    ? `<div class="initial-sync-destinations">${destinations.map(destinationMarkup).join("")}</div>`
    : `<p class="initial-sync-empty">No destination details are available.</p>`;
  const itemMarkupList = items.length
    ? `<ul class="initial-sync-items">${items.map(itemMarkup).join("")}</ul>`
    : `<p class="initial-sync-empty">No pending or held items are listed.</p>`;
  const truncated = data?.truncated ? `<p class="initial-sync-truncated">Showing the available item list; more items may be pending.</p>` : "";
  return `${statusCopy}${explanation}<h3 class="initial-sync-section-title">Destinations</h3>${destinationsMarkup}<h3 class="initial-sync-section-title">Pending and held items</h3>${truncated}${itemMarkupList}`;
}

export function renderInitialSync(data = summary, error = loadError) {
  const chip = node("#initialSyncChip");
  const dialog = node("#initialSyncDialog");
  const body = node("#initialSyncDialogBody");
  if (!chip || !dialog || !body) return;
  const status = String(data?.status || "").toLowerCase();
  const visible = Boolean(state.token) && !isDemoMode() && VISIBLE_STATUSES.has(status);
  chip.classList.toggle("hidden", !visible);
  if (visible) {
    const remaining = Math.max(Number(data?.remaining) || 0, 0);
    const label = ACTIVE_STATUSES.has(status) ? "Initial sync" : `Initial sync · ${statusLabel(status)}`;
    const waiting = status === "waiting_quota" ? localDateTime(data?.nextRunAt || data?.destinations?.find((item) => item?.status === "waiting_quota")?.nextRunAt) : "";
    node("#initialSyncChipText").textContent = `${label}${status === "waiting_quota" ? " · waiting for quota" : ""} · ${remaining} left${waiting ? ` · resumes ${waiting}` : ""}`;
    chip.dataset.status = status;
    chip.setAttribute("aria-label", `${label}${status === "waiting_quota" ? ". Waiting for quota" : ""}. ${countText(remaining, "item")} remaining${waiting ? `. Next resume ${waiting}` : ""}. Open Initial sync screen.`);
  }
  body.innerHTML = initialSyncDialogMarkup(data, error);
}

export async function loadInitialSyncSummary() {
  if (!state.token || isDemoMode()) {
    summary = null;
    loadError = "";
    renderInitialSync(null, "");
    return null;
  }
  if (requestPromise) return requestPromise;
  const serial = ++requestSerial;
  requestPromise = fetch("/api/setup/initial-sync", {
    headers: buildAuthHeaders(state.token),
    cache: "no-store",
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `Initial sync status failed with ${response.status}`);
    if (serial === requestSerial) {
      summary = body;
      loadError = "";
      renderInitialSync();
    }
    return summary;
  }).catch((error) => {
    if (serial === requestSerial) {
      loadError = error?.message || "Initial sync status could not be loaded.";
      renderInitialSync();
    }
    throw error;
  }).finally(() => {
    requestPromise = null;
  });
  return requestPromise;
}

function closeDialog() {
  const dialog = node("#initialSyncDialog");
  if (!dialog || dialog.classList.contains("hidden")) return;
  dialog.classList.add("hidden");
  node("#initialSyncChip")?.setAttribute("aria-expanded", "false");
  returnFocus?.focus?.();
  returnFocus = null;
}

export function openInitialSyncDialog() {
  const dialog = node("#initialSyncDialog");
  if (!dialog || node("#initialSyncChip")?.classList.contains("hidden")) return;
  returnFocus = node("#initialSyncChip");
  dialog.classList.remove("hidden");
  node("#initialSyncChip")?.setAttribute("aria-expanded", "true");
  node("#closeInitialSyncDialog")?.focus?.();
}

function bindDialogEvents() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener("plekt:full-sync-changed", () => { loadInitialSyncSummary().catch(() => {}); });
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.("#initialSyncChip")) openInitialSyncDialog();
    else if (event.target?.closest?.("#closeInitialSyncDialog") || event.target?.id === "initialSyncDialog") closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    const dialog = node("#initialSyncDialog");
    if (!dialog || dialog.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function startInitialSyncUi() {
  bindDialogEvents();
  if (!state.token || isDemoMode()) {
    summary = null;
    renderInitialSync(null, "");
    return Promise.resolve(null);
  }
  return loadInitialSyncSummary();
}

export function stopInitialSyncUi() {
  requestSerial += 1;
  requestPromise = null;
  summary = null;
  loadError = "";
  closeDialog();
  renderInitialSync(null, "");
}
