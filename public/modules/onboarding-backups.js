import { elements } from "./state.js?v=2.2.0.0.1";
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.0.0.1";

export function createOnboardingBackups({ getBackupData, currentStep, api, setMessage, loadBackupSetupData }) {
function backblazeDestination() {
  return getBackupData()?.watch?.destinations?.find((destination) => destination.type === "backblaze") || null;
}

// Shared by the wizard's own "backup" step (configuring a destination for
// future scheduled backups, mode "setup") and the restore flow's "remote"
// view (connecting to an existing destination to read backups back out of
// it, mode "connect") - same fields, same save/test actions, so a
// destination entered from either place is immediately usable from the
// other. "setup" walks through creating a new bucket/key on Backblaze;
// "connect" assumes that already exists and just asks for its details.
// showScheduleToggle hides the "upload scheduled backups here" checkbox in
// the restore context, where it isn't relevant.
function renderBackblazeCard({ destination, config, showScheduleToggle = true, mode = "setup" } = {}) {
  const settings = destination?.settings || {};
  const secretConfigured = Boolean(destination?.secretFlags?.secretAccessKey);
  const isConnect = mode === "connect";
  const fields = `
    <label class="field-label">Bucket name<input class="field" data-setup-backblaze-field="bucket" value="${escapeAttribute(settings.bucket || "")}" /></label>
    <label class="field-label">Region or S3 endpoint<input class="field" data-setup-backblaze-field="region" value="${escapeAttribute(settings.region || "")}" placeholder="eu-central-003" /></label>
    <label class="field-label">Key ID <span class="muted-copy">(Application Key ID, not the master Account ID)</span><input class="field" data-setup-backblaze-field="accessKeyId" value="${escapeAttribute(settings.accessKeyId || "")}" /></label>
    <label class="field-label">Application key<input class="field" type="password" autocomplete="new-password" data-setup-backblaze-field="secretAccessKey" placeholder="${secretConfigured ? "Configured - leave blank to keep" : ""}" /></label>
    <label class="field-label"><span class="setup-backup-label-line">Key prefix <span class="muted-copy">(optional)</span></span><input class="field" data-setup-backblaze-field="prefix" value="${escapeAttribute(settings.prefix || "plembfin/")}" /></label>`;
  const body = isConnect
    ? `<p class="muted-copy">Enter the bucket and application key from your existing Backblaze B2 account.</p>
       <div class="setup-backblaze-stage-fields setup-backblaze-connect-fields">${fields}</div>`
    : `
      <p class="muted-copy setup-backblaze-signup"><a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener noreferrer">Create a free Backblaze B2 account</a>, then set up a bucket and key for Plekt:</p>
      <div class="setup-backblaze-workflow">
        <section class="setup-backblaze-stage">
          <div class="setup-backblaze-guide">
            <h3>Create a private bucket</h3>
            <ol class="muted-copy setup-backblaze-steps">
              <li>Click <b>Create a Bucket</b>.</li>
              <li>Choose a unique name.</li>
              <li>Set the bucket to <b>Private</b>.</li>
              <li>Leave Default Encryption disabled.</li>
              <li>Leave Object Lock disabled.</li>
              <li>Click <b>Create a Bucket</b> to confirm.</li>
              <li>Copy the bucket name and paste it into <b>Bucket name</b> on the right.</li>
              <li>Copy the endpoint and paste it into <b>Region or S3 endpoint</b> on the right.</li>
            </ol>
          </div>
          <div class="setup-backblaze-stage-fields">
            <label class="field-label">Bucket name<input class="field" data-setup-backblaze-field="bucket" value="${escapeAttribute(settings.bucket || "")}" /></label>
            <label class="field-label">Region or S3 endpoint<input class="field" data-setup-backblaze-field="region" value="${escapeAttribute(settings.region || "")}" placeholder="eu-central-003" /></label>
          </div>
        </section>
        <section class="setup-backblaze-stage">
          <div class="setup-backblaze-guide">
            <h3>Create a restricted application key</h3>
            <ol class="muted-copy setup-backblaze-steps" start="9">
              <li>Click <b>App Keys</b> in the left menu.</li>
              <li>Click <b>Add a New Application Key</b> (not "Generate a New Master Application Key").</li>
              <li>Name the key.</li>
              <li>Allow access to the bucket you just created.</li>
              <li>Leave Read and Write access selected.</li>
              <li>Click <b>Create New Key</b>.</li>
              <li>Copy the keyID and paste it into <b>Key ID</b> on the right.</li>
              <li>Copy the applicationKey and paste it into <b>Application key</b> on the right.</li>
            </ol>
          </div>
          <div class="setup-backblaze-stage-fields">
            <label class="field-label">Key ID <span class="muted-copy">(Application Key ID, not the master Account ID)</span><input class="field" data-setup-backblaze-field="accessKeyId" value="${escapeAttribute(settings.accessKeyId || "")}" /></label>
            <label class="field-label">Application key<input class="field" type="password" autocomplete="new-password" data-setup-backblaze-field="secretAccessKey" placeholder="${secretConfigured ? "Configured - leave blank to keep" : ""}" /></label>
            <label class="field-label"><span class="setup-backup-label-line">Key prefix <span class="muted-copy">(optional)</span></span><input class="field" data-setup-backblaze-field="prefix" value="${escapeAttribute(settings.prefix || "plembfin/")}" /></label>
            <p class="muted-copy setup-backblaze-key-note">Backblaze shows the Application Key only once. Copy it when the key is created.</p>
          </div>
        </section>
      </div>`;
  return `
    <details class="settings-card setup-backup-card setup-backup-remote">
      <summary class="setup-backup-heading"><b>Backblaze B2</b>${destination ? `<span class="badge ${destination.enabled ? "badge-success" : ""}">${destination.enabled ? "Configured" : "Disabled"}</span>` : `<span class="badge">Not configured</span>`}</summary>
      <div class="setup-backup-remote-body">
        ${body}
        <div class="setup-backblaze-toggles">
          <label class="checkbox-label"><input type="checkbox" data-setup-backblaze-field="enabled" ${destination?.enabled ? "checked" : ""} /><span>${isConnect ? "Enable this connection" : "Enable this Backblaze destination"}</span></label>
          ${showScheduleToggle ? `<label class="checkbox-label"><input type="checkbox" data-setup-backup-field="remoteEnabled" ${config?.remoteEnabled ? "checked" : ""} /><span>Upload scheduled encrypted Plekt backups to Backblaze</span></label>` : ""}
        </div>
        <div class="setup-backblaze-actions">
          <button type="button" class="button-ghost" data-setup-action="backblaze-save">Save</button>
          <button type="button" class="button-ghost" data-setup-action="backblaze-test">Test</button>
        </div>
      </div>
    </details>`;
}

function renderBackup() {
  if (!getBackupData()) return `<p class="muted-copy">Loading backup settings...</p>`;
  const config = getBackupData().plembfin?.config || {};
  const destination = backblazeDestination();
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
    <details class="settings-card setup-backup-card setup-backup-remote setup-backup-section">
      <summary class="setup-backup-heading"><div><b>Remote backups</b><p class="muted-copy">Mirrored to remote storage.</p></div>${destination ? `<span class="badge ${destination.enabled ? "badge-success" : ""}">${destination.enabled ? "Configured" : "Disabled"}</span>` : `<span class="badge">Not configured</span>`}</summary>
      <div class="setup-backup-remote-body">
        ${renderBackblazeCard({ destination, config, showScheduleToggle: true })}
      </div>
    </details>`;
}

function updateBackupContinueAction() {
  const button = elements.setupPageRoot?.querySelector('[data-setup-action="continue"]');
  if (!button || currentStep() !== "backup") return;
  const shouldSave = setupFieldChecked('[data-setup-backup-field="enabled"]')
    || setupFieldChecked('[data-setup-backup-field="remoteEnabled"]')
    || setupFieldChecked('[data-setup-backblaze-field="enabled"]');
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

async function saveBackblazeDestinationFromFields({ requireComplete } = {}) {
  const destination = backblazeDestination();
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
  const shouldValidate = requireComplete ?? destinationEnabled;
  const region = setupFieldValue('[data-setup-backblaze-field="region"]');
  const bucket = setupFieldValue('[data-setup-backblaze-field="bucket"]');
  const accessKeyId = setupFieldValue('[data-setup-backblaze-field="accessKeyId"]');
  const secretAccessKey = setupFieldValue('[data-setup-backblaze-field="secretAccessKey"]');
  if (shouldValidate && (!region || !bucket || !accessKeyId || (!destination?.secretFlags?.secretAccessKey && !secretAccessKey))) {
    setMessage("Complete the Backblaze region, bucket, Key ID, and application key.", "error");
    return null;
  }
  if (!shouldValidate && !destination?.id) return null;
  const body = await api("/api/watch-backups", {
    method: "POST",
    body: JSON.stringify({
      action: "save-destination",
      destination: shouldValidate
        ? {
            ...(destination?.id ? { id: destination.id } : {}), type: "backblaze", label: "Backblaze B2", enabled: destinationEnabled,
            settings: { region, bucket, accessKeyId, prefix: setupFieldValue('[data-setup-backblaze-field="prefix"]') },
            secrets: secretAccessKey ? { secretAccessKey } : {},
          }
        : {
            id: destination.id, type: "backblaze", label: destination.label || "Backblaze B2", enabled: false,
            settings: { ...destination.settings }, secrets: {},
          },
    }),
  });
  return body.destination;
}

async function saveBackblazeAction() {
  const saved = await saveBackblazeDestinationFromFields({ requireComplete: true }).catch((error) => {
    setMessage(error.message, "error");
    return null;
  });
  if (!saved) return;
  await loadBackupSetupData({ force: true });
  setMessage("Backblaze destination saved.", "success");
}

async function testBackblazeAction() {
  try {
    const saved = await saveBackblazeDestinationFromFields({ requireComplete: true });
    if (!saved) return;
    const result = await api("/api/watch-backups", {
      method: "POST",
      body: JSON.stringify({ action: "test-destination", destinationId: saved.id }),
    });
    await loadBackupSetupData({ force: true });
    setMessage(`Connection OK - ${result.result?.detail || "reachable"}.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function saveBackupSetup() {
  if (!getBackupData()) return false;
  const previous = getBackupData().plembfin?.config || {};
  const enabled = setupFieldChecked('[data-setup-backup-field="enabled"]');
  const remoteEnabled = setupFieldChecked('[data-setup-backup-field="remoteEnabled"]');
  const rememberPassphrase = setupFieldChecked('[data-setup-backup-field="rememberPassphrase"]');
  const passphrase = setupFieldValue('[data-setup-backup-field="passphrase"]');
  const destinationEnabled = setupFieldChecked('[data-setup-backblaze-field="enabled"]');
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
  if (remoteEnabled && !destinationEnabled) {
    setMessage("Enable and configure the Backblaze destination before turning on remote backups.", "error");
    return false;
  }
  if (destinationEnabled || backblazeDestination()?.id) {
    const saved = await saveBackblazeDestinationFromFields();
    if (!saved) return false;
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


return { backblazeDestination, renderBackblazeCard, renderBackup, updateBackupContinueAction, setPassphraseError, saveBackupSetup, saveBackblazeAction, testBackblazeAction };
}
