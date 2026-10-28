// Settings > Users panel: lists the accounts on this server, adds new users,
// and runs the admin actions on each user (open, restart/stop/start, reset
// password, sign out, disable/enable, rename, remove).

import { escapeAttribute, escapeHtml, isDemoMode } from "./utils.js?v=2.2.0.0.3";
import { refreshSwitchUsers } from "./supervisor-switch.js?v=2.2.0.0.3";
import { updateAdminCredentials } from "./auth.js?v=2.2.0.0.3";
import { prepareHelpReadMore } from "./settings-shell.js?v=2.2.0.0.3";

let _authHeaders = () => ({ "Content-Type": "application/json" });
let _supervised = false;
let _bound = false;

function formatUptime(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatMegabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function instanceSummary(user, supervised) {
  const inst = user.instance;
  if (!inst) {
    return {
      pillText: user.isAdmin ? "Running" : "Stopped",
      pillTone: user.isAdmin ? "status-ready" : "status-muted",
      detail: user.isAdmin ? "Main server" : "Added",
    };
  }
  const state = inst.state || "stopped";
  const parts = [];
  if (state === "running") {
    const up = formatUptime(inst.startedAt);
    if (up) parts.push(`Up ${up}`);
    if (inst.restarts > 0) parts.push(`${inst.restarts} restart${inst.restarts === 1 ? "" : "s"}`);
    return { pillText: "Running", pillTone: "status-ready", detail: parts.join(" · ") || "Running" };
  }
  if (state === "starting") {
    return { pillText: "Starting", pillTone: "status-muted", detail: "Starting up" };
  }
  if (state === "crashed") {
    if (inst.restarts > 0) parts.push(`Stopped after ${inst.restarts} restart${inst.restarts === 1 ? "" : "s"}`);
    else parts.push("Stopped after a problem");
    return { pillText: "Stopped", pillTone: "status-error", detail: parts.join(" · ") };
  }
  return {
    pillText: "Stopped",
    pillTone: "status-muted",
    detail: supervised ? "Stopped by the administrator" : "Added; ready when multi-user mode is active",
  };
}

function renderAdminRow(user, supervised) {
  const summary = instanceSummary(user, supervised);
  const key = escapeAttribute(user.key || "admin");
  const isCurrent = Boolean(user.active);
  const state = user.instance?.state || "running";
  return `
    <div class="settings-row">
      <div class="settings-row-main">
        <article class="glass-panel p-section settings-card tool-section-card" data-user-card="${key}">
          <div class="section-heading sync-heading sync-static-heading">
            <div class="sync-heading-title">
              <p style="margin: 0;">${escapeHtml(user.name)}</p>
              <span class="status-pill ${summary.pillTone}">${escapeHtml(summary.pillText)}</span>
            </div>
            <span>Administrator · ${escapeHtml(summary.detail)}${isCurrent ? " · Open now" : ""}</span>
          </div>
          ${supervised ? `
          <div class="user-options-shell" style="display: flex; flex-direction: column; gap: var(--space-3);">
            <details class="sync-tool-details user-options-details">
              <summary class="accordion-header">
                <div class="sync-tool-summary-title">
                  <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
                  <b>Options</b>
                </div>
                <div class="user-option-actions user-options-heading-actions">
                  ${isCurrent ? "" : `<button class="button-primary sync-action-btn sync-tool-button" type="button" data-user-action="open" data-user="${key}" ${state === "running" ? "" : "disabled"}>Open</button>`}
                  <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="restart" data-user="${key}">Restart</button>
                </div>
              </summary>
              <div class="tool-item-row user-options">
                <p class="user-option-instance-description">${isCurrent ? "This is the instance you have open." : "Switch your session to the administrator's instance."}</p>
                <p class="message user-action-status" role="status" aria-live="polite"></p>
              </div>
            </details>
          </div>` : ""}
        </article>
      </div>
      <div class="settings-row-help">
        <article class="glass-panel p-section settings-card">
          <div class="section-heading">
            <p>${escapeHtml(user.name)} - Help</p>
          </div>
          <div class="settings-help-content">
            <div>
              <ul>
                <li>
                  <b>Administrator</b>
                  <span>Can open any user's instance and manage users. The administrator account cannot be stopped, disabled, renamed, or removed.</span>
                </li>
                <li>
                  <b>Data folder</b>
                  <span><code>data/</code> (the root data folder).</span>
                </li>
              </ul>
            </div>
          </div>
        </article>
      </div>
    </div>
  `;
}

function renderUserRow(user, supervised) {
  const summary = instanceSummary(user, supervised);
  const name = escapeHtml(user.name);
  const attr = escapeAttribute(user.name);
  const state = user.instance?.state || "stopped";
  const isRunning = state === "running" || state === "starting";
  const isCurrent = Boolean(user.active);
  const flags = [];
  if (user.isAdmin) flags.push("Administrator");
  if (user.disabled) flags.push("Sign-in disabled");
  if (isCurrent) flags.push("Open now");
  const subtitle = [summary.detail, ...flags].filter(Boolean).join(" · ");

  return `
    <div class="settings-row">
      <div class="settings-row-main">
        <article class="glass-panel p-section settings-card tool-section-card" data-user-card="${attr}">
          <div class="section-heading sync-heading sync-static-heading">
            <div class="sync-heading-title">
              <p style="margin: 0;">${name}</p>
              <span class="status-pill ${summary.pillTone}">${escapeHtml(summary.pillText)}</span>
              ${user.disabled ? `<span class="status-pill status-muted">Disabled</span>` : ""}
            </div>
            <span>${escapeHtml(subtitle || "User")}</span>
          </div>
          <div class="user-options-shell" style="display: flex; flex-direction: column; gap: var(--space-3);">
            <details class="sync-tool-details user-options-details">
              <summary class="accordion-header">
                <div class="sync-tool-summary-title">
                  <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
                  <b>Options</b>
                </div>
                <div class="user-option-actions user-options-heading-actions">
                  ${isCurrent ? "" : `<button class="button-primary sync-action-btn sync-tool-button" type="button" data-user-action="open" data-user="${attr}" ${state === "running" && !user.disabled ? "" : "disabled"}>Open</button>`}
                  ${isRunning
                    ? `<button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="restart" data-user="${attr}">Restart</button>
                       <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="stop" data-user="${attr}">Stop</button>`
                    : `<button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="start" data-user="${attr}">Start</button>`}
                </div>
              </summary>
              <div class="tool-item-row user-options">
                <div class="user-options-grid">
                  <form class="user-option user-option-card" data-user-rename-form="${attr}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
                    <div class="user-option-copy">
                      <b>Rename</b>
                      <span>Moves <code>data/users/${name}</code> and changes their webhook URL to <code>/u/&lt;new-name&gt;/api/webhook</code>.</span>
                    </div>
                    <div class="user-option-actions">
                      <input class="field" type="text" name="newName" autocomplete="off" data-lpignore="true" data-1p-ignore="true" maxlength="32" placeholder="New user name" aria-label="New user name for ${attr}" required />
                      <button class="button-ghost sync-action-btn sync-tool-button" type="submit">Rename</button>
                    </div>
                  </form>

                  <form class="user-option user-option-card" data-user-password-form="${attr}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
                    <div class="user-option-copy">
                      <b>Reset password</b>
                      <span>Set a new password of at least 8 characters. Their current sessions are signed out.</span>
                    </div>
                    <div class="user-option-actions">
                      <input class="field" type="password" name="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" minlength="8" maxlength="256" placeholder="New password" aria-label="New password for ${attr}" required />
                      <button class="button-ghost sync-action-btn sync-tool-button" type="submit">Set password</button>
                    </div>
                  </form>

                  <div class="user-option user-option-card">
                    <div class="user-option-copy">
                      <b>Access</b>
                      <span>${user.disabled ? "Sign-in is disabled for this user." : "Sign out their browser sessions or disable their sign-in."}</span>
                    </div>
                    <div class="user-option-actions">
                      <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="sign-out" data-user="${attr}">Sign out sessions</button>
                      <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="${user.disabled ? "enable" : "disable"}" data-user="${attr}">${user.disabled ? "Enable sign-in" : "Disable sign-in"}</button>
                    </div>
                  </div>

                  <div class="user-option user-option-card">
                    <div class="user-option-copy">
                      <b>Administrator access</b>
                      <span>${user.isAdmin ? "This account can access all settings and manage every user." : "Grant full access to shared settings and user management."}</span>
                    </div>
                    <div class="user-option-actions">
                      <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-action="${user.isAdmin ? "remove-admin" : "make-admin"}" data-user="${attr}">${user.isAdmin ? "Remove admin access" : "Make admin"}</button>
                    </div>
                  </div>
                </div>

                <div class="user-options-footer">
                  <div class="user-confirm hidden" data-user-remove-confirm="${attr}">
                    <p>Remove <b>${name}</b>?</p>
                    <label class="user-confirm-check">
                      <input type="checkbox" data-user-remove-delete="${attr}" />
                      <span>Also delete <code>data/users/${name}</code> and all of this user's watch history, connections, and backups. Shared artwork and shared metadata are kept.</span>
                    </label>
                    <div class="user-option-actions">
                      <button class="button-ghost sync-action-btn sync-tool-button" type="button" data-user-remove-cancel="${attr}">Cancel</button>
                      <button class="button-danger sync-action-btn sync-tool-button" type="button" data-user-action="remove" data-user="${attr}">Confirm remove</button>
                    </div>
                  </div>
                  <button class="button-danger sync-action-btn sync-tool-button" type="button" data-user-remove-open="${attr}">Remove user</button>
                </div>

                <p class="message user-action-status" role="status" aria-live="polite"></p>
              </div>
            </details>
          </div>
        </article>
      </div>
      <div class="settings-row-help">
        <article class="glass-panel p-section settings-card">
          <div class="section-heading">
            <p>${name} - Help</p>
          </div>
          <div class="settings-help-content">
            <div>
              <ul>
                <li>
                  <b>Data folder</b>
                  <span><code>data/users/${name}</code></span>
                </li>
                <li>
                  <b>Webhook path</b>
                  <span><code>/u/${name}/api/webhook</code></span>
                </li>
                <li>
                  <b>Sign-in</b>
                  <span>This user signs in with their user name and password and sees only their own instance.</span>
                </li>
              </ul>
            </div>
          </div>
        </article>
      </div>
    </div>
  `;
}

function renderUsersStats(users = [], processInfo = {}) {
  const stats = document.querySelector("#usersStats");
  if (!stats) return;

  const running = users.filter((user) => (user.instance?.state || (user.isAdmin ? "running" : "stopped")) === "running").length;
  const stopped = users.length - running;
  const disabled = users.filter((user) => user.disabled).length;
  const active = users.find((user) => user.active)?.name || "None";
  const runningInstance = users.find((user) => user.instance?.state === "running")?.instance;
  const memoryBytes = processInfo.memoryBytes ?? runningInstance?.memoryBytes;
  const startedAt = processInfo.startedAt ?? runningInstance?.startedAt;
  const processMemory = formatMegabytes(memoryBytes) || "Unavailable";
  const processUptime = startedAt ? formatUptime(startedAt) : "Unavailable";
  const values = {
    total: users.length,
    running,
    stopped,
    disabled,
    active,
    memory: processMemory,
    uptime: processUptime,
  };
  for (const [key, value] of Object.entries(values)) {
    const target = stats.querySelector(`[data-user-stat="${key}"]`);
    if (target) target.textContent = String(value);
  }
}

function renderUsersList(users = [], supervised = false, processInfo = {}) {
  const list = document.querySelector("#usersList");
  if (!list) return;
  _supervised = Boolean(supervised);
  renderUsersStats(users, processInfo);
  list.innerHTML = users
    .map((user) => (user.isInstallAdmin ? renderAdminRow(user, _supervised) : renderUserRow(user, _supervised)))
    .join("");
  prepareHelpReadMore();
}

function setCardStatus(card, text, tone = "muted") {
  const status = card?.querySelector(".user-action-status");
  if (!status) return;
  status.textContent = text;
  status.dataset.tone = tone;
}

export async function loadSettingsUsers() {
  const list = document.querySelector("#usersList");
  if (!list) return;
  if (isDemoMode()) {
    renderUsersList([{ name: "admin", key: "admin", role: "admin", isAdmin: true, isInstallAdmin: true, disabled: false }], false);
    return;
  }
  try {
    const response = await fetch("/api/users", {
      headers: _authHeaders(),
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403 && body.code === "ADMIN_ONLY") {
        document.querySelector('[data-settings-panel="users"]')?.classList.add("hidden");
        return;
      }
      list.innerHTML = `<p class="message" data-tone="error">${escapeHtml(body.error || "Could not load users.")}</p>`;
      return;
    }
    renderUsersList(Array.isArray(body.users) ? body.users : [], body.supervised, body.process);
  } catch (error) {
    list.innerHTML = `<p class="message" data-tone="error">${escapeHtml(error.message || "Could not load users.")}</p>`;
  }
}

async function runManageAction(card, payload, progressText, doneText) {
  setCardStatus(card, progressText, "muted");
  try {
    const response = await fetch("/api/users/manage", {
      method: "POST",
      headers: _authHeaders(),
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setCardStatus(card, body.error || "Action failed.", "error");
      return;
    }
    if (body.reload) {
      window.location.assign(body.path || "/");
      return;
    }
    await loadSettingsUsers();
    refreshSwitchUsers();
    const refreshedCard = document.querySelector(`[data-user-card="${CSS.escape(payload.newName || payload.name)}"]`);
    if (refreshedCard && doneText) {
      const details = refreshedCard.querySelector("details.sync-tool-details");
      if (details) details.open = true;
      setCardStatus(refreshedCard, doneText, "success");
    }
  } catch (error) {
    setCardStatus(card, error.message || "Action failed.", "error");
  }
}

async function submitPasswordReset(form) {
  const name = form.getAttribute("data-user-password-form") || "";
  const card = form.closest("[data-user-card]");
  const input = form.querySelector('input[name="password"]');
  const password = String(input?.value || "");
  setCardStatus(card, "Setting password...", "muted");
  try {
    const response = await fetch("/api/users/password", {
      method: "POST",
      headers: _authHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ name, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setCardStatus(card, body.error || "Could not set password.", "error");
      return;
    }
    if (input) input.value = "";
    setCardStatus(card, `Password updated for ${name}. Their active sessions were signed out.`, "success");
  } catch (error) {
    setCardStatus(card, error.message || "Could not set password.", "error");
  }
}

function bindListEvents(list) {
  list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const removeOpen = target.closest("[data-user-remove-open]");
    if (removeOpen) {
      const name = removeOpen.getAttribute("data-user-remove-open");
      list.querySelector(`[data-user-remove-confirm="${CSS.escape(name)}"]`)?.classList.remove("hidden");
      removeOpen.classList.add("hidden");
      return;
    }
    const removeCancel = target.closest("[data-user-remove-cancel]");
    if (removeCancel) {
      const name = removeCancel.getAttribute("data-user-remove-cancel");
      const box = list.querySelector(`[data-user-remove-confirm="${CSS.escape(name)}"]`);
      const check = list.querySelector(`[data-user-remove-delete="${CSS.escape(name)}"]`);
      if (check) check.checked = false;
      box?.classList.add("hidden");
      list.querySelector(`[data-user-remove-open="${CSS.escape(name)}"]`)?.classList.remove("hidden");
      return;
    }

    const actionButton = target.closest("[data-user-action]");
    if (!actionButton) return;
    const action = actionButton.getAttribute("data-user-action") || "";
    const name = actionButton.getAttribute("data-user") || "";
    const card = actionButton.closest("[data-user-card]");
    if (!action || !name || !card) return;

    if (action === "remove") {
      const check = list.querySelector(`[data-user-remove-delete="${CSS.escape(name)}"]`);
      const deleteData = Boolean(check?.checked);
      runManageAction(card, { action: "remove", name, deleteData }, `Removing ${name}...`, "");
      return;
    }
    const labels = {
      open: [`Opening ${name}...`, ""],
      start: [`Starting ${name}...`, `Started ${name}.`],
      stop: [`Stopping ${name}...`, `Stopped ${name}.`],
      restart: [`Restarting ${name}...`, `Restarted ${name}.`],
      "sign-out": [`Signing out ${name}...`, `Signed out ${name}'s sessions.`],
      disable: [`Disabling ${name}...`, `Disabled sign-in for ${name}.`],
      enable: [`Enabling ${name}...`, `Enabled sign-in for ${name}.`],
      "make-admin": [`Granting admin access to ${name}...`, `Granted admin access to ${name}.`],
      "remove-admin": [`Removing admin access from ${name}...`, `Removed admin access from ${name}.`],
    };
    const [progress, done] = labels[action] || ["Working...", "Done."];
    runManageAction(card, { action, name }, progress, done);
  });

  list.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    if (form.hasAttribute("data-user-password-form")) {
      event.preventDefault();
      submitPasswordReset(form);
      return;
    }
    if (form.hasAttribute("data-user-rename-form")) {
      event.preventDefault();
      const name = form.getAttribute("data-user-rename-form") || "";
      const card = form.closest("[data-user-card]");
      const input = form.querySelector('input[name="newName"]');
      const newName = String(input?.value || "").trim();
      runManageAction(card, { action: "rename", name, newName }, `Renaming ${name}...`, `Renamed ${name} to ${newName.toLowerCase()}.`);
    }
  });
}

export function initSettingsUsers({ authHeaders } = {}) {
  if (typeof authHeaders === "function") _authHeaders = authHeaders;
  if (_bound) return;
  _bound = true;

  const list = document.querySelector("#usersList");
  if (list) bindListEvents(list);

  const selfServiceForm = document.querySelector("#userPasswordForm");
  selfServiceForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isDemoMode()) return;

    const currentPassword = String(selfServiceForm.querySelector("#userCurrentPassword")?.value || "");
    const newPassword = String(selfServiceForm.querySelector("#userNewPassword")?.value || "");
    const confirmPassword = String(selfServiceForm.querySelector("#userConfirmPassword")?.value || "");
    const status = selfServiceForm.querySelector("#userPasswordStatus");
    const button = selfServiceForm.querySelector("#saveUserPasswordButton");
    const setStatus = (text, tone = "muted") => {
      if (!status) return;
      status.textContent = text;
      status.dataset.tone = tone;
    };

    if (newPassword !== confirmPassword) {
      setStatus("New password and confirmation do not match.", "error");
      return;
    }

    if (button) button.disabled = true;
    setStatus("Updating your password...", "muted");
    try {
      await updateAdminCredentials({ username: "", currentPassword, newPassword });
      selfServiceForm.reset();
      setStatus("Password updated. Other sessions have been signed out.", "success");
    } catch (error) {
      setStatus(error.message || "Could not update your password.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });

  const form = document.querySelector("#addUserForm");
  const nameInput = document.querySelector("#newUserName");
  const passwordInput = document.querySelector("#newUserPassword");
  const button = document.querySelector("#addUserButton");
  const status = document.querySelector("#addUserStatus");
  if (!form) return;

  const setStatus = (text, tone = "muted") => {
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isDemoMode()) {
      setStatus("Demo settings are read-only.", "muted");
      return;
    }
    const name = String(nameInput?.value || "").trim();
    const password = String(passwordInput?.value || "");
    if (button) button.disabled = true;
    setStatus("Adding user...", "muted");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: _authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({ name, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(body.error || "Could not add user.", "error");
        return;
      }
      if (nameInput) nameInput.value = "";
      if (passwordInput) passwordInput.value = "";
      const created = body.user?.name || name;
      setStatus(`Added ${created}. Their instance is ready.`, "success");
      await loadSettingsUsers();
      refreshSwitchUsers();
    } catch (error) {
      setStatus(error.message || "Could not add user.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}
