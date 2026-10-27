// In-app user switcher for the install administrator.
// Lists accounts from the current-user control and at the foot of the setup page,
// and calls POST /api/users/manage { action: "open", name } to switch context.

import { ifLoaded } from "./route-modules.js?v=2.2.0.0.1";
import { escapeAttribute, escapeHtml, isDemoMode } from "./utils.js?v=2.2.0.0.1";
import { currentUser } from "./auth.js?v=2.2.0.0.1";
import { sidebarUserPresentation } from "./sidebar-navigation.js?v=2.2.0.0.1";

const renderSetupPage = ifLoaded("onboarding", "renderSetupPage");

let accounts = [];
let busy = false;
let lastError = "";

function stateNote(user) {
  if (user.active) return "Open now";
  if (user.disabled) return "Sign-in disabled";
  const state = user.instance?.state || "stopped";
  if (state === "running") return "";
  if (state === "starting") return "Starting";
  if (state === "crashed") return "Stopped after a problem";
  return "Stopped";
}

function canSwitchTo(user) {
  if (busy || user.active) return false;
  return (user.instance?.state || "stopped") === "running";
}

function listItemsMarkup({ buttonClass }) {
  return accounts
    .map((user) => {
      const note = stateNote(user);
      const active = user.active ? " active" : "";
      const current = user.active ? ' aria-current="true"' : "";
      const disabled = canSwitchTo(user) ? "" : " disabled";
      return `<button class="${buttonClass}${active}" type="button" data-switch-user="${escapeAttribute(user.key)}"${current}${disabled}>
        <span>${escapeHtml(user.name)}</span>
        ${note ? `<span class="sidebar-switch-user-note">${escapeHtml(note)}</span>` : ""}
      </button>`;
    })
    .join("");
}

function renderSidebarSwitch() {
  const wrap = document.querySelector("#sidebarCurrentUserWrap");
  const list = document.querySelector("#sidebarCurrentUserList");
  const button = document.querySelector("#sidebarCurrentUserButton");
  const buttonName = document.querySelector("#sidebarCurrentUserButtonName");
  const staticName = document.querySelector("#sidebarCurrentUserStatic");
  if (!wrap || !list) return;
  const { name, canSwitch } = sidebarUserPresentation(
    accounts,
    currentUser()?.username,
    document.documentElement.classList.contains("non-admin-user")
      && !document.documentElement.classList.contains("admin-session"),
  );
  if (!name) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  if (buttonName) buttonName.textContent = name;
  if (staticName) staticName.textContent = name;
  button?.classList.toggle("hidden", !canSwitch);
  staticName?.classList.toggle("hidden", canSwitch);
  if (!canSwitch) {
    list.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
    button?.classList.remove("active");
  }
  const errorLine = lastError
    ? `<p class="message sidebar-switch-user-error" data-tone="error" role="status">${escapeHtml(lastError)}</p>`
    : "";
  list.innerHTML = `${listItemsMarkup({ buttonClass: "sidebar-appearance-list-item sidebar-switch-user-item" })}${errorLine}`;
  button?.setAttribute("aria-label", canSwitch ? `${name}; switch user` : name);
}

export function setupSwitchMarkup() {
  if (accounts.length <= 1) return "";
  const errorLine = lastError
    ? `<p class="message" data-tone="error" role="status">${escapeHtml(lastError)}</p>`
    : "";
  return `
    <div class="setup-switch-user" aria-label="Switch user">
      <p class="muted-copy">Switch user</p>
      <div class="setup-switch-user-list">
        ${listItemsMarkup({ buttonClass: "button-ghost" })}
      </div>
      ${errorLine}
    </div>
  `;
}

async function switchToUser(key) {
  if (busy || !key) return;
  busy = true;
  lastError = "";
  renderSidebarSwitch();
  try {
    const response = await fetch("/api/users/manage", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", name: key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = body.error || "Could not switch to that user.";
      busy = false;
      renderSidebarSwitch();
      if (!document.querySelector("#setup-view")?.classList.contains("hidden")) renderSetupPage();
      return;
    }
    window.location.assign(body.path || "/");
  } catch {
    lastError = "Could not switch to that user.";
    busy = false;
    renderSidebarSwitch();
  }
}

export async function refreshSwitchUsers() {
  if (isDemoMode()) return;
  try {
    const response = await fetch("/api/users", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      accounts = [];
      renderSidebarSwitch();
      return;
    }
    const body = await response.json().catch(() => ({}));
    accounts = Array.isArray(body.users) ? body.users : [];
    renderSidebarSwitch();
    if (!document.querySelector("#setup-view")?.classList.contains("hidden")) renderSetupPage();
  } catch {
    accounts = [];
    renderSidebarSwitch();
  }
}

export function initSupervisorSwitch() {
  const button = document.querySelector("#sidebarCurrentUserButton");
  const wrap = document.querySelector("#sidebarCurrentUserWrap");
  const list = document.querySelector("#sidebarCurrentUserList");
  button?.addEventListener("click", () => {
    if (!list) return;
    const opening = list.classList.contains("hidden");
    list.classList.toggle("hidden", !opening);
    button.setAttribute("aria-expanded", opening ? "true" : "false");
    button.classList.toggle("active", opening);
  });
  document.addEventListener("click", (event) => {
    if (wrap && !wrap.contains(event.target)) {
      list?.classList.add("hidden");
      button?.setAttribute("aria-expanded", "false");
      button?.classList.remove("active");
    }
    const target = event.target instanceof Element ? event.target.closest("[data-switch-user]") : null;
    if (!target || target.disabled) return;
    event.preventDefault();
    switchToUser(target.getAttribute("data-switch-user") || "");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || list?.classList.contains("hidden")) return;
    list.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
    button?.classList.remove("active");
    button?.focus();
  });
}
