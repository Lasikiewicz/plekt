import { elements } from "./state.js?v=2.3.0.1.1";
import { escapeAttribute } from "./utils.js?v=2.3.0.1.1";
import { renderBackupDestinationCardGrid } from "./backup-destinations.js?v=2.3.0.1.1";

export function createOnboardingBackups({
  getBackupData,
  currentStep,
  api,
  setMessage,
  openConfirmDialog,
  loadBackupSetupData,
  onDestinationsChanged,
}) {
  function remoteDestinations() {
    const list = getBackupData()?.watch?.destinations;
    return Array.isArray(list) ? list : [];
  }

  function hasEnabledDestination() {
    return remoteDestinations().some((destination) => destination.enabled);
  }

  function remoteBadgeHtml() {
    const list = remoteDestinations();
    const enabledCount = list.filter((destination) => destination.enabled).length;
    if (enabledCount > 0) {
      return `<span class="badge badge-success">${enabledCount === 1 ? "1 destination" : `${enabledCount} destinations`}</span>`;
    }
    if (list.length > 0) return `<span class="badge">Disabled</span>`;
    return `<span class="badge">Not configured</span>`;
  }

  function renderRemoteDestinationsCard({ config, showScheduleToggle = true, mode = "setup" } = {}) {
    const isConnect = mode === "connect";
    const copy = isConnect
      ? "Add or edit a remote destination (Backblaze B2, S3-compatible / Cloudflare R2, WebDAV, Dropbox, or an external folder), then pick a backup below."
      : "Choose one or more remote targets (Backblaze B2, S3-compatible / Cloudflare R2, WebDAV, Dropbox, or an external mounted folder).";
    return `
      <details class="settings-card setup-backup-card setup-backup-remote"${isConnect ? " open" : ""}>
        <summary class="setup-backup-heading"><div><b>Remote destinations</b><p class="muted-copy">${copy}</p></div>${remoteBadgeHtml()}</summary>
        <div class="setup-backup-remote-body">
          <div id="setupBackupDestinationCards" class="settings-card-grid"></div>
          ${showScheduleToggle ? `
            <div class="setup-backblaze-toggles">
              <label class="checkbox-label"><input type="checkbox" data-setup-backup-field="remoteEnabled" ${config?.remoteEnabled ? "checked" : ""} /><span>Upload scheduled encrypted Plekt backups to enabled remote destinations</span></label>
            </div>
          ` : ""}
        </div>
      </details>`;
  }

  function mountBackupDestinations() {
    const container = elements.setupPageRoot?.querySelector("#setupBackupDestinationCards");
    if (!container || !getBackupData()) return;
    const watch = getBackupData().watch || {};
    renderBackupDestinationCardGrid(container, {
      destinations: Array.isArray(watch.destinations) ? watch.destinations : [],
      statusMap: watch.runtime?.destinations || {},
      onChanged: async () => {
        await loadBackupSetupData({ force: true });
        await onDestinationsChanged?.();
      },
      setMessage,
      openConfirmDialog,
      addVisibleLabel: "Click to add a remote destination",
    });
  }

  function renderBackup() {
    if (!getBackupData()) return `<p class="muted-copy">Loading backup settings...</p>`;
    const config = getBackupData().plembfin?.config || {};
    return `
      <p class="muted-copy setup-step-intro setup-step-intro--nowrap">Schedule encrypted local backups. Remote storage is optional.</p>
      <details class="settings-card setup-backup-card setup-backup-remote setup-backup-section">
        <summary class="setup-backup-heading"><div><b>Local encrypted backup</b><p class="muted-copy">Stored on this Plekt server.</p></div>${config.enabled ? `<span class="badge badge-success">Scheduled</span>` : `<span class="badge">Not scheduled</span>`}</summary>
        <div class="setup-backup-remote-body">
          <label class="checkbox-label"><input type="checkbox" data-setup-backup-field="enabled" ${config.enabled ? "checked" : ""} /><span>Enable daily local backups</span></label>
          <div class="setup-backup-fields">
            <label class="field-label">Backup time<input class="field" type="time" data-setup-backup-field="time" value="${escapeAttribute(config.time || "03:00")}" /></label>
            <label class="field-label">Backups to retain<input class="field" type="number" min="1" max="365" data-setup-backup-field="retention" value="${escapeAttribute(String(config.retention || 7))}" /></label>
            <div class="setup-backup-security">
              <label class="field-label setup-backup-passphrase"><span class="setup-backup-label-line">Encryption passphrase <span class="muted-copy">(at least 12 characters)</span></span><input class="field" type="password" autocomplete="new-password" data-setup-backup-field="passphrase" placeholder="${config.passphraseStored ? "Saved - leave blank to keep" : ""}" /></label>
              <label class="checkbox-label setup-backup-remember"><input type="checkbox" data-setup-backup-field="rememberPassphrase" ${config.rememberPassphrase || config.passphraseStored ? "checked" : ""} /><span>Remember the passphrase for scheduled backups</span></label>
              <p class="muted-copy setup-backup-passphrase-help">This passphrase encrypts every backup, local or remote. It has to be entered and "remembered" here before daily or remote backups can be scheduled, since a scheduled backup runs unattended with nobody there to type it in.</p>
            </div>
          </div>
        </div>
      </details>
      ${renderRemoteDestinationsCard({ config, showScheduleToggle: true, mode: "setup" })}`;
  }

  function updateBackupContinueAction() {
    const button = elements.setupPageRoot?.querySelector('[data-setup-action="continue"]');
    if (!button || currentStep() !== "backup") return;
    const shouldSave = setupFieldChecked('[data-setup-backup-field="enabled"]')
      || setupFieldChecked('[data-setup-backup-field="remoteEnabled"]')
      || hasEnabledDestination();
    button.textContent = shouldSave ? "Save and continue" : "Skip for now";
    button.classList.toggle("button-primary", shouldSave);
    button.classList.toggle("button-ghost", !shouldSave);
  }

  function setupFieldValue(selector) {
    return elements.setupPageRoot?.querySelector(selector)?.value?.trim() || "";
  }

  function setupFieldChecked(selector) {
    return Boolean(elements.setupPageRoot?.querySelector(selector)?.checked);
  }

  function setPassphraseError(active) {
    elements.setupPageRoot?.querySelector(".setup-backup-security")?.classList.toggle("setup-field-error", Boolean(active));
  }

  function passphraseSatisfied(previous, rememberPassphrase, passphrase) {
    return rememberPassphrase && (previous.passphraseStored || passphrase.length >= 12);
  }

  async function saveBackupSetup() {
    if (!getBackupData()) return false;
    const previous = getBackupData().plembfin?.config || {};
    const enabled = setupFieldChecked('[data-setup-backup-field="enabled"]');
    const remoteEnabled = setupFieldChecked('[data-setup-backup-field="remoteEnabled"]');
    const rememberPassphrase = setupFieldChecked('[data-setup-backup-field="rememberPassphrase"]');
    const passphrase = setupFieldValue('[data-setup-backup-field="passphrase"]');
    setPassphraseError(false);
    if (enabled && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
      setPassphraseError(true);
      setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled backups.", "error");
      return false;
    }
    if (remoteEnabled && !previous.remotePassphraseStored && !passphraseSatisfied(previous, rememberPassphrase, passphrase)) {
      setPassphraseError(true);
      setMessage("Enter and remember an encryption passphrase of at least 12 characters before enabling scheduled remote backups.", "error");
      return false;
    }
    if (remoteEnabled && !hasEnabledDestination()) {
      setMessage("Add and enable at least one remote backup destination before turning on remote backups.", "error");
      return false;
    }
    await api("/api/plembfin-backups", {
      method: "POST",
      body: JSON.stringify({ action: "configure", config: {
        ...previous, enabled, remoteEnabled,
        time: setupFieldValue('[data-setup-backup-field="time"]') || "03:00",
        retention: Number(setupFieldValue('[data-setup-backup-field="retention"]')) || 7,
        rememberPassphrase,
        passphrase: rememberPassphrase ? passphrase : "",
      } }),
    });
    await loadBackupSetupData({ force: true });
    return true;
  }

  return {
    remoteDestinations,
    hasEnabledDestination,
    renderRemoteDestinationsCard,
    mountBackupDestinations,
    renderBackup,
    updateBackupContinueAction,
    setPassphraseError,
    saveBackupSetup,
  };
}
