import { buildAuthHeaders } from "./auth.js?v=2.2.0.1.0";
import { state, elements } from "./state.js?v=2.2.0.1.0";
import { escapeAttribute } from "./utils.js?v=2.2.0.1.0";

const API = "/api/dropped-titles";
let unDropInProgress = false;

function allDroppedTitleActionButtons() {
  const buttons = [...(document.querySelectorAll?.("[data-plekt-dropped-title-action]") || [])];
  for (const template of document.querySelectorAll?.("template[data-dropped-menu-action]") || []) {
    const button = template.content?.querySelector?.("[data-plekt-dropped-title-action]");
    if (button) buttons.push(button);
  }
  return [...new Set(buttons)];
}

function setUnDropPending(pending) {
  unDropInProgress = pending;
  for (const button of allDroppedTitleActionButtons()) {
    if (button.getAttribute("aria-pressed") !== "true") continue;
    applyUnDropBusyState(button, pending);
  }
}

// Menu open reloads Un-drop via loadDroppedTitleState; that must not re-enable
// other Un-drop actions while one save is still in flight.
function applyUnDropBusyState(button, pending) {
  const title = button.dataset.droppedTitle || "this show";
  button.disabled = pending;
  if (pending) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  button.setAttribute("aria-label", `${pending ? "Un-dropping" : "Un-drop"} ${title}`);
  button.title = `${pending ? "Un-dropping" : "Un-drop"} ${title}`;
  const label = button.querySelector("[data-dropped-label]");
  if (label) label.textContent = pending ? "Un-dropping…" : "Un-drop";
}

export function isDroppedUnDropBusy() {
  return unDropInProgress;
}

function reportOutcome(message, tone = "muted") {
  if (!elements.message) return;
  elements.message.textContent = message;
  elements.message.dataset.tone = tone;
}

function normalizedType(item = {}) {
  return ["tv", "show", "series", "episode"].includes(String(item.media_type || "").toLowerCase()) ? "show" : "movie";
}

function itemFromButton(button) {
  return {
    media_type: button.dataset.droppedType,
    title: button.dataset.droppedTitle || "",
    tmdb_id: button.dataset.droppedTmdb || "",
    tvdb_id: button.dataset.droppedTvdb || "",
    imdb_id: button.dataset.droppedImdb || "",
    year: button.dataset.droppedYear || "",
    poster_url: button.dataset.droppedPoster || "",
  };
}

function titleSlug(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function yearOf(...values) {
  for (const value of values) {
    const match = String(value || "").trim().match(/^(\d{4})/);
    if (match) return match[1];
  }
  return "";
}

function matches(item, row) {
  const type = normalizedType(item);
  const rowType = normalizedType({ media_type: row.media_type || row.mediaType || "" });
  if (type !== rowType) return false;
  const providers = type === "show" ? ["tmdb", "tvdb"] : ["imdb", "tmdb", "tvdb"];
  const conflicts = providers.some((provider) => item[`${provider}_id`] && row[`${provider}_id`]
    && String(item[`${provider}_id`]).trim().toLowerCase() !== String(row[`${provider}_id`]).trim().toLowerCase());
  const itemYear = yearOf(item.year, item.release_date, item.first_air_date);
  const rowYear = yearOf(row.year);
  if (conflicts || (itemYear && rowYear && itemYear !== rowYear)) return false;
  if (providers.some((provider) => item[`${provider}_id`] && String(item[`${provider}_id`]).trim().toLowerCase() === String(row[`${provider}_id`] || "").trim().toLowerCase())) return true;
  const title = String(item.title || "").trim().toLowerCase();
  const rowTitle = String(type === "show" ? row.show_title || row.title : row.title || "").trim().toLowerCase();
  return Boolean(titleSlug(title) && titleSlug(title) === titleSlug(rowTitle));
}

function setButtonState(button, dropped, message = "") {
  if (!button.isConnected) return;
  button.classList.toggle("has-personal-state", dropped);
  button.setAttribute("aria-pressed", String(dropped));
  // Keep every Un-drop disabled while another un-drop save is running. Opening a
  // second card's menu loads state and would otherwise re-enable its action.
  if (dropped && unDropInProgress && !message) {
    applyUnDropBusyState(button, true);
    const icon = button.querySelector("[data-dropped-icon]");
    if (icon) icon.innerHTML = "&#x21a9;";
    return;
  }
  button.disabled = false;
  button.removeAttribute("aria-busy");
  const label = dropped ? "Un-drop" : "Drop";
  const title = button.dataset.droppedTitle || "this media";
  button.setAttribute("aria-label", message || `${label} ${title}`);
  button.title = message || `${label} ${title}`;
  const text = button.querySelector("[data-dropped-label]");
  if (text) text.textContent = message ? `${label} (error)` : label;
  const icon = button.querySelector("[data-dropped-icon]");
  if (icon) icon.innerHTML = message ? "!" : dropped ? "&#x21a9;" : "&#x2298;";
}

export function droppedTitleActionHtml(item = {}, { card = false, dropped = false } = {}) {
  const type = normalizedType(item);
  if (type === "movie") return ""; // Drop is for shows only: movies are watched, unwatched or partly watched.
  const title = String(item.title || "");
  const labelText = dropped ? "Un-drop" : "Drop";
  const description = `${labelText} ${title} from Up Next`;
  const className = `${card ? "poster-overflow-item" : "action-pill personal-media-detail-action"}${dropped ? " has-personal-state" : ""}`;
  const style = card ? ' role="menuitem"' : "";
  const label = `<span data-dropped-label>${labelText}</span>`;
  const markup = `<button class="${className}" type="button" data-plekt-dropped-title-action data-dropped-card="${card}" data-dropped-type="${type}" data-dropped-title="${escapeAttribute(title)}" data-dropped-tmdb="${escapeAttribute(item.tmdb_id || "")}" data-dropped-tvdb="${escapeAttribute(item.tvdb_id || "")}" data-dropped-imdb="${escapeAttribute(item.imdb_id || "")}" data-dropped-year="${escapeAttribute(item.year || item.release_date || item.first_air_date || "")}" data-dropped-poster="${escapeAttribute(item.poster_url || item.show_poster_url || "")}" aria-label="${escapeAttribute(description)}" aria-pressed="${dropped}" title="${escapeAttribute(description)}"${style}><span data-dropped-icon aria-hidden="true">${dropped ? "&#x21a9;" : "&#x2298;"}</span>${label}</button>`;
  if (typeof document !== "undefined") queueMicrotask(() => {
    const buttons = Array.from(document.querySelectorAll?.("[data-plekt-dropped-title-action]:not([data-dropped-loaded])") || []);
    for (const button of buttons) {
      button.dataset.droppedLoaded = "1";
    }
    if (buttons.length) void loadDroppedTitleStates(buttons);
  });
  return card ? `<template data-dropped-menu-action>${markup}</template>` : markup;
}

async function fetchDroppedTitles() {
  const response = await fetch(API, { headers: buildAuthHeaders(state.token), cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Could not load dropped titles (${response.status})`);
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function loadDroppedTitleStates(buttons = []) {
  const targets = Array.from(buttons);
  targets.forEach((button) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
  try {
    const rows = await fetchDroppedTitles();
    targets.forEach((button) => setButtonState(button, rows.some((row) => matches(itemFromButton(button), row))));
    return targets.map((button) => button.getAttribute("aria-pressed") === "true");
  } catch (error) {
    targets.forEach((button) => setButtonState(button, false, error.message || "Could not load dropped title state"));
    return targets.map(() => false);
  }
}

export async function loadDroppedTitleState(button) {
  if (!button) return false;
  return (await loadDroppedTitleStates([button]))[0] || false;
}

export async function handleDroppedTitleAction(button, { onSuccess } = {}) {
  if (!button || button.disabled) return;
  let pendingUnDrop = button.getAttribute("aria-pressed") === "true";
  if (pendingUnDrop && unDropInProgress) return false;
  if (pendingUnDrop) setUnDropPending(true);
  const item = itemFromButton(button);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const rows = await fetchDroppedTitles();
    const wasDropped = rows.some((row) => matches(item, row));
    if (wasDropped && !pendingUnDrop) {
      pendingUnDrop = true;
      setUnDropPending(true);
    }
    setButtonState(button, wasDropped);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const label = button.querySelector("[data-dropped-label]");
    if (label) label.textContent = wasDropped ? "Un-dropping…" : "Dropping…";
    if (wasDropped) setUnDropPending(true);
    const response = await fetch(API, {
      method: "POST",
      headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
      body: JSON.stringify({ item, dropped: !wasDropped }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerFailures = (payload.providerDismissals || []).filter((entry) => entry?.status === "failed" || entry?.ok === false || entry?.error);
      const details = providerFailures.map((entry) => `${entry.target || entry.provider || "Provider"}: ${entry.details || entry.error || entry.message || "failed"}`).join("; ");
      const persisted = typeof payload.dropped === "boolean" ? payload.dropped : wasDropped;
      setButtonState(button, persisted, details || payload.error || `Could not update dropped title (${response.status})`);
      reportOutcome(`${persisted ? "Dropped state saved. " : ""}${details || payload.error || "Could not update dropped title"}`, "error");
      if (persisted !== wasDropped) onSuccess?.();
      return false;
    }
    const providerFailures = (payload.providerDismissals || []).filter((entry) => ["failed", "unsupported"].includes(entry?.status) || entry?.ok === false || entry?.error);
    const providerMessage = providerFailures.map((entry) => `${entry.target || entry.provider || "Provider"}: ${entry.details || entry.error || entry.message || "failed"}`).join("; ");
    setButtonState(button, !wasDropped, providerFailures.some(entry => entry.status === "failed") ? providerMessage : "");
    reportOutcome(`${item.title} ${wasDropped ? "un-dropped" : "dropped"}.${providerMessage ? ` ${providerMessage}` : ""}`, providerFailures.some(entry => entry.status === "failed") ? "warning" : "muted");
    onSuccess?.();
    document.dispatchEvent?.(new CustomEvent("plekt:dropped-titles-changed"));
    return true;
  } catch (error) {
    setButtonState(button, button.getAttribute("aria-pressed") === "true", error.message || "Could not update dropped title");
    reportOutcome(error.message || "Could not update dropped title", "error");
    return false;
  } finally {
    if (pendingUnDrop) setUnDropPending(false);
  }
}

if (typeof document !== "undefined") document.addEventListener?.("click", async (event) => {
  const button = event.target.closest?.("[data-plekt-dropped-title-action]");
  if (!button) return;
  if (button.closest?.(".poster-overflow-dropdown")) return;
  if (!button.dataset.droppedLoaded) {
    button.dataset.droppedLoaded = "1";
    await loadDroppedTitleState(button);
    if (!button.isConnected) return;
  }
  void handleDroppedTitleAction(button);
});
