// Remote backup destination definitions, inline provider accordions (Settings),
// status-card grid (/setup), edit modal, and built-in Dropbox PKCE OAuth flow.
// Shared by Settings → Backup → Remote (`tools-backups.js`) and `/setup`
// (`onboarding-backups.js`, `onboarding.js`).
import { buildAuthHeaders } from "./auth.js?v=2.3.0.0.6";
import { state } from "./state.js?v=2.3.0.0.6";
import { escapeHtml, escapeAttribute, formatDate } from "./utils.js?v=2.3.0.0.6";
import {
  collectFieldValues,
  openSettingsEditModal,
  openSettingsPickerModal,
  renderServiceCardGrid,
} from "./settings-ui.js?v=2.3.0.0.6";

function authHeaders() {
  return buildAuthHeaders(state.token);
}

async function postBackupEndpoint(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}`);
  return body;
}

function postDestinationAction(payload) {
  return postBackupEndpoint("/api/watch-backups", payload);
}

function isAllowedHost(urlText, allowedSuffixes) {
  try {
    const parsed = new URL(String(urlText || ""));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export const DESTINATION_FORMS = {
  backblaze: {
    label: "Backblaze B2",
    description: "Mirror backups to a Backblaze B2 bucket",
    settings: [
      { key: "region", label: "Region or endpoint", placeholder: "eu-central-003", help: "A region name or full S3 endpoint is accepted." },
      { key: "bucket", label: "Bucket name", placeholder: "yourname-plekt" },
      { key: "accessKeyId", label: "Key ID", placeholder: "0035..." },
      { key: "prefix", label: "Key prefix", placeholder: "plekt/", optional: true, help: "Optional folder-like prefix within the bucket." },
    ],
    secrets: [{ key: "secretAccessKey", label: "Application key", placeholder: "Backblaze application key" }],
    helpHtml: `
      <p class="tool-accordion-desc">Plekt needs a private B2 bucket and an application key that can read and write it. No Backblaze account yet? <a href="https://www.backblaze.com/sign-up/cloud-storage" target="_blank" rel="noopener noreferrer">Sign up for B2 Cloud Storage</a> (the first 10 GB are free).</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li>Open <a href="https://secure.backblaze.com/b2_buckets.htm" target="_blank" rel="noopener noreferrer">Buckets</a> and choose <b>Create a Bucket</b>. Keep files <b>Private</b> and enter the name under <b>Bucket name</b>.</li>
        <li>On the bucket's card, copy the <b>Endpoint</b> (for example <code>s3.eu-central-003.backblazeb2.com</code>) into <b>Region or endpoint</b>. The region alone (<code>eu-central-003</code>) also works.</li>
        <li>Open <a href="https://secure.backblaze.com/app_keys.htm" target="_blank" rel="noopener noreferrer">Application Keys</a> and choose <b>Add a New Application Key</b>. Allow access to this bucket only, with <b>Read and Write</b> access.</li>
        <li>Copy the <b>keyID</b> into <b>Key ID</b> and the <b>applicationKey</b> into <b>Application key</b>. Backblaze shows the application key only once.</li>
        <li>Choose <b>Test</b>, then save.</li>
      </ol>
      <p class="tool-accordion-desc"><b>Tip:</b> B2 keeps old versions of a deleted file by default, so backups removed by retention still use space. In the bucket's <b>Lifecycle Settings</b>, choose <b>Keep only the last version of the file</b>. If the bucket is shared, use a custom rule scoped to the Plekt prefix. <a href="https://www.backblaze.com/docs/cloud-storage-configure-and-manage-lifecycle-rules" target="_blank" rel="noopener noreferrer">Backblaze lifecycle rule instructions</a>.</p>
      <p class="tool-accordion-desc">Plekt stores the application key securely and never sends it back to the browser.</p>
    `,
  },
  dropbox: {
    label: "Dropbox",
    description: "Mirror backups to a dedicated Plekt folder in Dropbox",
    oauthKind: "dropbox",
    optionalFieldsLabel: "Use your own Dropbox app (optional)",
    settings: [
      { key: "folder", label: "Folder path", placeholder: "/Plekt Backups", optional: true, help: "Subfolder inside Plekt's Dropbox app folder (defaults to /Plekt Backups)." },
      { key: "appKey", label: "Custom App key", placeholder: "Leave blank to use Plekt's built-in app", optional: true, optionalGroup: true, help: "Only needed if you registered your own Dropbox app." },
    ],
    secrets: [{ key: "appSecret", label: "Custom App secret", placeholder: "Optional for custom apps", optional: true, optionalGroup: true }],
    helpHtml: `
      <p class="tool-accordion-desc">Plekt connects directly to Dropbox using a scoped App Folder — Plekt can only access its own folder in your Dropbox and never sees your other files. Large encrypted backups automatically stream via chunked upload sessions, and Dropbox keeps 2 full backups by default to save space.</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li>Click <b>Connect Dropbox</b>.</li>
        <li>Click <b>Open Dropbox authorization</b> and click <b>Allow</b> in the Dropbox tab.</li>
        <li>Copy the code Dropbox shows, paste it back here, and click <b>Complete connection</b>.</li>
        <li>Click <b>Test</b> to verify, then <b>Save</b>.</li>
      </ol>
      <p class="tool-accordion-desc">No developer account or API keys are required. Expand <b>Use your own Dropbox app (optional)</b> only if you want to use your own Dropbox App Key.</p>
    `,
  },
  s3: {
    label: "S3-Compatible",
    description: "Cloudflare R2, AWS S3, MinIO, Wasabi, or any S3-compatible bucket",
    settings: [
      { key: "endpoint", label: "Endpoint URL", placeholder: "https://<account-id>.r2.cloudflarestorage.com", optional: true, help: "Required for Cloudflare R2, MinIO, Wasabi, and other S3 providers. Leave blank for standard AWS S3." },
      { key: "region", label: "Region", placeholder: "auto", help: "Use auto for Cloudflare R2, or your bucket region (for example us-east-1)." },
      { key: "bucket", label: "Bucket name", placeholder: "yourname-plekt" },
      { key: "accessKeyId", label: "Access Key ID", placeholder: "AKIA..." },
      { key: "prefix", label: "Key prefix", placeholder: "plekt/", optional: true, help: "Optional folder-like prefix within the bucket." },
    ],
    secrets: [{ key: "secretAccessKey", label: "Secret Access Key", placeholder: "S3 secret access key" }],
    helpHtml: `
      <p class="tool-accordion-desc">Works with any S3-compatible object store using Signature V4, including <b>Cloudflare R2</b> (10 GB free with zero egress fees), <b>AWS S3</b>, <b>MinIO</b>, <b>Wasabi</b>, <b>Storj</b>, and <b>Garage</b>.</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li><b>Cloudflare R2:</b> Create a bucket, then create an <b>R2 API Token</b> scoped to <b>Object Read &amp; Write</b> on that bucket. Paste the <b>S3 API</b> endpoint (<code>https://&lt;account-id&gt;.r2.cloudflarestorage.com</code>), set Region to <code>auto</code>, and paste the Access Key ID and Secret Access Key.</li>
        <li><b>AWS S3:</b> Create a private bucket and an IAM user/policy limited to that bucket (<code>ListBucket</code>, <code>GetObject</code>, <code>PutObject</code>, <code>DeleteObject</code>). Leave <b>Endpoint URL</b> blank and enter the AWS region (for example <code>us-east-1</code>).</li>
        <li><b>MinIO / self-hosted:</b> Enter your server's HTTP(S) S3 endpoint, bucket name, and access key pair. Path-style requests are used by default.</li>
        <li>Choose <b>Test</b>, then save.</li>
      </ol>
      <p class="tool-accordion-desc">Large encrypted backups stream straight from disk with no memory spike. Secrets are encrypted at rest and never returned to the browser.</p>
    `,
  },
  webdav: {
    label: "WebDAV",
    description: "Nextcloud, ownCloud, Hetzner Storage Box, Synology NAS, or any WebDAV share",
    settings: [
      { key: "url", label: "WebDAV URL", placeholder: "https://cloud.example.com/remote.php/dav/files/username/", help: "Full http:// or https:// URL of the WebDAV folder." },
      { key: "directory", label: "Subfolder", placeholder: "Plekt Backups", optional: true, help: "Optional folder inside the WebDAV URL. Plekt creates it on upload if needed." },
      { key: "username", label: "Username", placeholder: "your-username", optional: true },
    ],
    secrets: [{ key: "password", label: "Password or app password", placeholder: "WebDAV password" }],
    helpHtml: `
      <p class="tool-accordion-desc">Mirrors backups over HTTP(S) WebDAV using Basic authentication. Large encrypted backups stream directly from disk.</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li><b>Nextcloud / ownCloud:</b> Open <b>Files → Files settings</b> to copy your WebDAV URL (usually <code>https://&lt;host&gt;/remote.php/dav/files/&lt;user&gt;/</code>). Under <b>Settings → Security → Devices &amp; sessions</b>, generate a dedicated <b>App password</b> rather than using your main password.</li>
        <li><b>Hetzner Storage Box:</b> Enable WebDAV in Robot/Cloud Console and use <code>https://uXXXXXX.your-storagebox.de/</code> with your Storage Box username and password.</li>
        <li><b>NAS (Synology / TrueNAS / QNAP):</b> Enable WebDAV Server on a backup share and enter its HTTPS URL and credentials.</li>
        <li>Optionally enter a <b>Subfolder</b> (for example <code>Plekt Backups</code>), choose <b>Test</b>, and save.</li>
      </ol>
    `,
  },
  folder: {
    label: "External / Mounted Folder",
    description: "Copy backups to a mounted NAS share, external drive, Docker volume, or desktop sync folder",
    settings: [
      { key: "path", label: "Folder path", placeholder: "/mnt/nas/plekt-backups", help: "Absolute path outside Plekt's built-in data/backups directory." },
    ],
    secrets: [],
    helpHtml: `
      <p class="tool-accordion-desc">Copies backups atomically to a separate filesystem path on this host or container. Plekt blocks pointing this at its own built-in <code>data/backups/</code> directory so local and mirrored backups stay separate.</p>
      <ol class="tool-accordion-desc settings-help-steps">
        <li><b>Docker / Unraid / NAS:</b> Mount your NAS share or external drive into the container (for example <code>-v /mnt/nas/plekt:/remote-backups</code>) and enter <code>/remote-backups</code> here.</li>
        <li><b>Windows / Linux / macOS:</b> Enter an absolute path to a mounted network drive, external disk, or a local OneDrive/Dropbox/Nextcloud desktop sync folder (for example <code>D:\\Backups\\Plekt</code> or <code>/mnt/nas/plekt</code>).</li>
        <li>Choose <b>Test</b> to verify Plekt can create and write to the folder, then save.</li>
      </ol>
    `,
  },
};

export function destinationLabel(destination) {
  return destination?.label || DESTINATION_FORMS[destination?.type]?.label || destination?.type || "Remote";
}

function destinationScopeBadge(destination) {
  const watch = destination.settings?.backupWatchHistory !== false;
  const full = destination.settings?.backupFullPlekt !== false;
  if (watch && full) return { label: "Watch + Full", tone: "muted" };
  if (watch) return { label: "Watch history", tone: "muted" };
  if (full) return { label: "Full backups", tone: "muted" };
  return { label: "No backup types", tone: "warning" };
}

function destinationBadges(destination, status) {
  const form = DESTINATION_FORMS[destination?.type];
  const badges = [{ label: destination.enabled ? "Enabled" : "Disabled", tone: destination.enabled ? "ready" : "muted" }];
  if (form?.oauthKind && !destination.secretFlags?.refreshToken) {
    badges.push({ label: "Not connected", tone: "warning" });
  } else if (status?.status === "success") {
    badges.push({ label: "Connected", tone: "ready" });
  } else if (status?.status === "error") {
    badges.push({ label: "Last run failed", tone: "danger" });
  } else if (form?.oauthKind && destination.secretFlags?.refreshToken) {
    badges.push({ label: "Authorized", tone: "ready" });
  } else {
    badges.push({ label: "Not tested", tone: "warning" });
  }
  badges.push(destinationScopeBadge(destination));
  return badges;
}

function providerFieldsFor(destination, form) {
  return [
    ...form.settings.map((field) => ({ ...field, value: destination.settings?.[field.key] || "" })),
    ...form.secrets.map((field) => ({
      ...field,
      type: "password",
      secret: true,
      configured: Boolean(destination.secretFlags?.[field.key]),
      configuredPlaceholder: `Configured - enter a new ${field.label.toLowerCase()} to replace it`,
    })),
  ];
}

function destinationFields(destination, form) {
  const isNew = !destination.id;
  const isDropbox = destination.type === "dropbox";
  return [
    { key: "label", label: "Name", value: destination.label || form.label, help: "A recognizable name for this backup target." },
    { key: "enabled", label: "Enable", type: "checkbox", value: isNew ? true : Boolean(destination.enabled) },
    ...providerFieldsFor(destination, form),
    {
      key: "backupWatchHistory",
      label: "Mirror watch-history backups",
      type: "checkbox",
      value: destination.settings?.backupWatchHistory !== false,
      help: "Upload watch-history backups to this destination.",
    },
    {
      key: "backupFullPlekt",
      label: "Mirror encrypted full Plekt backups",
      type: "checkbox",
      value: destination.settings?.backupFullPlekt !== false,
      help: "Upload encrypted full Plekt backups to this destination.",
    },
    {
      key: "watchRetention",
      label: "Watch-history backups to keep",
      type: "number",
      optional: true,
      optionalGroup: true,
      value: destination.settings?.watchRetention ?? "",
      placeholder: "Use global setting",
      help: "Optional override (1-365). Leave blank to use the Remote Watch History retention count.",
    },
    {
      key: "fullRetention",
      label: "Full Plekt backups to keep",
      type: "number",
      optional: true,
      optionalGroup: true,
      value: destination.settings?.fullRetention ?? (isNew && isDropbox ? "2" : ""),
      placeholder: isDropbox ? "2 (Dropbox default)" : "Use global setting",
      help: isDropbox
        ? "Defaults to 2 for Dropbox to save space (1-365)."
        : "Optional override (1-365). Leave blank to use the Remote Plekt Backups retention count.",
    },
  ];
}

function parseRetentionField(rawValue, label) {
  const text = String(rawValue ?? "").trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new Error(`${label} must be a whole number between 1 and 365.`);
  }
  return parsed;
}

function destinationFromValues(destination, form, values) {
  const settings = Object.fromEntries(form.settings.map((field) => [field.key, values[field.key]]));
  settings.backupWatchHistory = Boolean(values.backupWatchHistory);
  settings.backupFullPlekt = Boolean(values.backupFullPlekt);
  const watchRetention = parseRetentionField(values.watchRetention, "Watch-history backups to keep");
  const fullRetention = parseRetentionField(values.fullRetention, "Full Plekt backups to keep");
  if (watchRetention !== undefined) settings.watchRetention = watchRetention;
  if (fullRetention !== undefined) settings.fullRetention = fullRetention;
  const secrets = {};
  for (const field of form.secrets) {
    if (values[field.key]) secrets[field.key] = values[field.key];
  }
  return {
    ...(destination.id ? { id: destination.id } : {}),
    type: destination.type,
    label: values.label || form.label,
    enabled: Boolean(values.enabled),
    settings,
    secrets,
  };
}

async function saveDestinationValues(destination, form, values) {
  const body = await postDestinationAction({
    action: "save-destination",
    destination: destinationFromValues(destination, form, values),
  });
  if (body.destination) Object.assign(destination, body.destination);
  return body.destination;
}

function getOAuthHost(container) {
  let host = container.querySelector(".backup-oauth-host");
  if (host) return host;
  host = document.createElement("div");
  host.className = "backup-oauth-host";
  const anchor = container.querySelector(".settings-modal-leading-action-row");
  if (anchor) anchor.insertAdjacentElement("afterend", host);
  else container.querySelector(".settings-modal-fields")?.appendChild(host);
  return host;
}

export function renderBackupDestinationHelpGuides(container) {
  if (!container || container.dataset.rendered === "1") return;
  const chevron = `<svg class="accordion-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`;
  container.innerHTML = `
    <p class="backup-help-guides-heading">Remote Setup Guides</p>
    <div class="backup-help-guides-list">
      ${Object.entries(DESTINATION_FORMS).map(([type, form]) => `
        <details class="sync-tool-details backup-help-guide-item" data-help-dest="${escapeAttribute(type)}">
          <summary class="accordion-header">
            <div class="sync-tool-summary-title">${chevron}<b>${escapeHtml(form.label)}</b></div>
          </summary>
          <div class="settings-help-body backup-dest-guide-body">${form.helpHtml || ""}</div>
        </details>
      `).join("")}
    </div>
  `;
  container.dataset.rendered = "1";
}

async function runDropboxConnectFlow(target, form, { container, collect, setStatus, onConnected, onChanged }) {
  setStatus("Preparing Dropbox authorization link...", "muted");
  const saved = await saveDestinationValues(target, form, collect());
  const result = await postDestinationAction({ action: "oauth-url", destinationId: saved.id });
  if (!isAllowedHost(result.url, ["dropbox.com"])) {
    throw new Error("Dropbox returned an unexpected authorization URL.");
  }

  const host = getOAuthHost(container);
  host.innerHTML = `
    <div class="backup-oauth-panel">
      <p class="muted-copy backup-oauth-hint">1. Open Dropbox, approve access, and copy the code it displays. 2. Paste that code below and complete the connection.</p>
      <div class="backup-oauth-actions">
        <a class="button-primary" href="${escapeAttribute(result.url)}" target="_blank" rel="noopener noreferrer">Open Dropbox authorization</a>
      </div>
      <div class="backup-oauth-code-row">
        <input type="text" class="field" data-dropbox-code placeholder="Paste Dropbox authorization code" autocomplete="off" />
        <button type="button" class="button-primary" data-dropbox-exchange>Complete connection</button>
        <button type="button" class="button-ghost" data-oauth-cancel>Cancel</button>
      </div>
    </div>
  `;
  const codeInput = host.querySelector("[data-dropbox-code]");
  const exchangeBtn = host.querySelector("[data-dropbox-exchange]");
  host.querySelector("[data-oauth-cancel]")?.addEventListener("click", () => {
    host.innerHTML = "";
    setStatus("Dropbox authorization cancelled.", "muted");
  });
  exchangeBtn?.addEventListener("click", async () => {
    const code = String(codeInput?.value || "").trim();
    if (!code) {
      setStatus("Paste the authorization code shown by Dropbox first.", "error");
      codeInput?.focus();
      return;
    }
    exchangeBtn.disabled = true;
    setStatus("Exchanging Dropbox authorization code...", "muted");
    try {
      await postDestinationAction({ action: "oauth-exchange", destinationId: saved.id, code });
      target.secretFlags = { ...(target.secretFlags || {}), refreshToken: true };
      host.innerHTML = "";
      onConnected?.();
      await onChanged?.();
      setStatus("✔ Dropbox connected. Click Test to verify or Save to finish.", "success");
    } catch (error) {
      setStatus(`✘ ${error?.message || "Dropbox authorization failed."}`, "error");
    } finally {
      exchangeBtn.disabled = false;
    }
  });
  setStatus("Open Dropbox, approve access, then paste the code above.", "muted");
}

function buildDropboxLeadingAction(target, form, onChanged) {
  return {
    label: target.secretFlags?.refreshToken ? "Reconnect Dropbox" : "Connect Dropbox",
    onClick: (ui) => runDropboxConnectFlow(target, form, {
      container: ui.dialog,
      collect: ui.collect,
      setStatus: ui.setStatus,
      onConnected: () => {
        const leadBtn = ui.dialog.querySelector(".settings-modal-leading-action");
        if (leadBtn) leadBtn.textContent = "Reconnect Dropbox";
      },
      onChanged,
    }),
  };
}

export function openBackupDestinationModal(destination = {}, callbacks = {}) {
  const { onChanged, setMessage = () => {}, openConfirmDialog = async () => false } = callbacks;
  const type = destination.type || "backblaze";
  const form = DESTINATION_FORMS[type];
  if (!form) throw new Error(`Unsupported destination type: ${type}`);
  const target = { type, settings: {}, secretFlags: {}, ...destination };

  const leadingAction = form.oauthKind === "dropbox"
    ? buildDropboxLeadingAction(target, form, onChanged)
    : undefined;

  openSettingsEditModal({
    title: target.id ? `Edit ${target.label || form.label}` : `Add ${form.label}`,
    fields: destinationFields(target, form),
    enabledKey: "enabled",
    saveDisabledLabel: "Save & disable",
    optionalFieldsLabel: form.optionalFieldsLabel || "Retention overrides (optional)",
    leadingAction,
    helpHtml: form.helpHtml,
    onSave: async (values) => {
      await saveDestinationValues(target, form, values);
      await onChanged?.();
      setMessage("Backup destination saved.", "success");
    },
    onTest: async (values) => {
      const saved = await saveDestinationValues(target, form, values);
      const result = await postDestinationAction({ action: "test-destination", destinationId: saved.id });
      await onChanged?.();
      return `Connection OK - ${result.result?.detail || "reachable"}.`;
    },
    onDelete: target.id ? async () => {
      const approved = await openConfirmDialog({
        title: "Remove destination?",
        body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!approved) return false;
      await postDestinationAction({ action: "remove-destination", destinationId: target.id });
      await onChanged?.();
      setMessage("Destination removed.", "success");
    } : undefined,
  });
}

export function openBackupDestinationPicker(callbacks = {}) {
  openSettingsPickerModal({
    title: "Add Backup Destination",
    intro: "Choose where Plekt should mirror scheduled backups.",
    items: Object.entries(DESTINATION_FORMS).map(([id, form]) => ({ id, name: form.label, description: form.description })),
    onPick: (type) => openBackupDestinationModal({ type }, callbacks),
  });
}

// Card grid used by the compact `/setup` onboarding wizard.
export function renderBackupDestinationCardGrid(container, {
  destinations = [],
  statusMap = {},
  onChanged,
  setMessage,
  openConfirmDialog,
  addVisibleLabel = "Click to add a remote destination",
} = {}) {
  if (!container) return;
  const callbacks = { onChanged, setMessage, openConfirmDialog };
  renderServiceCardGrid(container, {
    items: destinations.map((destination) => ({
      id: destination.id,
      name: destinationLabel(destination),
      description: DESTINATION_FORMS[destination.type]?.description || "Remote backup destination",
      badges: destinationBadges(destination, statusMap[destination.id]),
    })),
    onSelect: (id) => {
      const found = destinations.find((destination) => destination.id === id);
      if (found) openBackupDestinationModal(found, callbacks);
    },
    onAdd: () => openBackupDestinationPicker(callbacks),
    addLabel: "Add backup destination",
    addVisibleLabel,
  });
}

// ── Inline provider accordions for Settings → Backup → Remote ────────────────
// Matches External trackers (Simkl / Trakt) on Settings → Connections: each
// provider has its own expandable accordion with inline connection fields,
// independent Watch History and Full Plekt backup toggles/retention/Back Up Now,
// plus an "+ Add another destination" option for multiple buckets or shares.

function accordionStatusPill(destination, form, status) {
  if (!destination.id) return { label: "Not configured", tone: "muted" };
  if (!destination.enabled) return { label: "Disabled", tone: "muted" };
  if (form.oauthKind && !destination.secretFlags?.refreshToken) return { label: "Not connected", tone: "warning" };
  if (status?.status === "error") return { label: "Error", tone: "danger" };
  if (status?.status === "success") return { label: "Connected", tone: "ready" };
  if (form.oauthKind && destination.secretFlags?.refreshToken) return { label: "Connected", tone: "ready" };
  return { label: "Enabled", tone: "ready" };
}

function accordionSubtitle(destination, form, globalWatchRetention, globalFullRetention) {
  if (!destination.id) return form.description;
  const parts = [];
  const watchOn = destination.settings?.backupWatchHistory !== false;
  const fullOn = destination.settings?.backupFullPlekt !== false;
  const watchKeep = destination.settings?.watchRetention || globalWatchRetention || 7;
  const fullKeep = destination.settings?.fullRetention || (destination.type === "dropbox" ? 2 : (globalFullRetention || 7));
  if (watchOn) parts.push(`Watch history (keep ${watchKeep})`);
  if (fullOn) parts.push(`Full Plekt (keep ${fullKeep})`);
  return parts.length ? parts.join(" · ") : "No backup types selected";
}

function formatTypeRuntime(entry, enabled) {
  if (!enabled) return `<span class="muted-copy">Mirroring off for this destination</span>`;
  if (!entry || (!entry.lastSuccessAt && !entry.lastAttemptAt)) {
    return `<span class="muted-copy">Never synced</span>`;
  }
  if (entry.status === "error") {
    return `<span style="color: var(--red);">Failed: ${escapeHtml(entry.lastError || "unknown error")}</span>`;
  }
  const when = entry.lastSuccessAt ? formatDate(entry.lastSuccessAt) : "Recently";
  return `<span class="muted-copy">Last synced ${escapeHtml(when)}</span>`;
}

function buildAccordionEntries(destinations) {
  const ordered = [...destinations].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)));
  const entries = [];
  for (const dest of ordered) {
    const form = DESTINATION_FORMS[dest.type];
    if (!form) continue;
    entries.push({ key: `dest:${dest.id}`, type: dest.type, form, destination: dest });
  }
  return entries;
}

function renderCompactDestField(field) {
  const type = field.type || "text";
  const value = field.secret ? "" : (field.value ?? "");
  const placeholder = field.secret && field.configured
    ? (field.configuredPlaceholder || "Configured - enter a new value to replace it")
    : (field.placeholder || "");
  const optionalTag = field.optional ? ` <em class="settings-field-optional">- optional</em>` : "";
  return `
    <label class="backup-dest-field" title="${escapeAttribute(field.help || "")}">
      <span class="backup-dest-field-label">${escapeHtml(field.label)}${optionalTag}</span>
      <input class="field backup-dest-field-input" type="${escapeAttribute(type)}" data-modal-field="${escapeAttribute(field.key)}"
        value="${escapeAttribute(String(value))}" placeholder="${escapeAttribute(placeholder)}"
        autocomplete="off" data-lpignore="true" data-1p-ignore="true" />
    </label>
  `;
}

// Remembers the last inline status notice per accordion across re-renders so
// Save / Test / Back Up Now feedback stays visible right inside the panel.
const panelStatusCache = new Map();

export function renderBackupDestinationAccordions(container, {
  destinations = [],
  statusMap = {},
  globalWatchRetention = 7,
  globalFullRetention = 7,
  getPlektPassphrase = () => "",
  onChanged,
  setMessage = () => {},
  openConfirmDialog = async () => false,
} = {}) {
  if (!container) return;
  renderBackupDestinationHelpGuides(document.getElementById("backupDestinationHelpGuides"));

  // Preserve open accordions across re-renders (e.g. after Save, Test, Connect, Back Up Now).
  const openKeys = new Set();
  container.querySelectorAll("details[data-dest-panel-key][open]").forEach((el) => {
    openKeys.add(el.dataset.destPanelKey);
    if (el.dataset.destType) openKeys.add(`type:${el.dataset.destType}`);
  });

  const entries = buildAccordionEntries(destinations);
  const chevron = `<svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`;

  const emptyHtml = entries.length
    ? ""
    : `<div class="empty-log"><b>No remote destinations configured</b><span>Add Backblaze B2, Dropbox, S3-Compatible, WebDAV, or an external mounted folder to mirror backups off-server.</span></div>`;
  const addLabel = entries.length ? "+ Add another remote destination" : "+ Add remote destination";

  container.innerHTML = emptyHtml + entries.map(({ key, type, form, destination }) => {
    const status = destination.id ? statusMap[destination.id] || {} : {};
    const pill = accordionStatusPill(destination, form, status);
    const subtitle = accordionSubtitle(destination, form, globalWatchRetention, globalFullRetention);
    const isNew = !destination.id;
    const isDropbox = type === "dropbox";
    const watchOn = destination.settings?.backupWatchHistory !== false;
    const fullOn = destination.settings?.backupFullPlekt !== false;
    const watchRuntime = status.watchHistory || (status.lastSuccessAt && !status.fullBackup ? status : null);
    const fullRuntime = status.fullBackup || null;
    const allProviderFields = [
      { key: "label", label: "Name", value: destination.label || form.label, help: "A recognizable name for this backup target." },
      ...providerFieldsFor(destination, form),
    ];
    const mainFieldsHtml = allProviderFields.filter((f) => !f.optionalGroup).map(renderCompactDestField).join("");
    const optionalFields = allProviderFields.filter((f) => f.optionalGroup);
    const optionalFieldsHtml = optionalFields.length
      ? `<details class="sync-tool-details settings-modal-optional-fields backup-dest-subdetails">
          <summary class="accordion-header"><div class="sync-tool-summary-title">${chevron}<b>${escapeHtml(form.optionalFieldsLabel || "Advanced options")}</b></div></summary>
          <div class="settings-modal-optional-fields-body backup-dest-fields">${optionalFields.map(renderCompactDestField).join("")}</div>
        </details>`
      : "";
    const reconnectButtonHtml = form.oauthKind === "dropbox"
      ? `<button type="button" class="button-ghost" data-dest-connect>${destination.secretFlags?.refreshToken ? "Reconnect Dropbox" : "Connect Dropbox"}</button>`
      : "";
    const wasOpen = openKeys.has(key) || (destination.id && openKeys.has(`new:${type}`));
    const cachedNotice = panelStatusCache.get(key) || (destination.id ? panelStatusCache.get(`new:${type}`) : null);
    if (cachedNotice && destination.id && panelStatusCache.has(`new:${type}`)) {
      panelStatusCache.set(key, cachedNotice);
      panelStatusCache.delete(`new:${type}`);
    }

    return `
      <details class="sync-tool-details backup-dest-accordion" data-dest-panel-key="${escapeAttribute(key)}" data-dest-type="${escapeAttribute(type)}"${wasOpen ? " open" : ""}>
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            ${chevron}
            <b>${escapeHtml(destinationLabel(destination))}</b>
          </div>
          <span class="status-pill status-${escapeAttribute(pill.tone)}">${escapeHtml(pill.label)}</span>
          <span>${escapeHtml(subtitle)}</span>
        </summary>
        <div class="tool-item-row backup-dest-panel">
          <div class="backup-dest-fields">
            ${mainFieldsHtml}
          </div>

          <div class="backup-dest-types">
            <div class="backup-dest-type-card">
              <div class="backup-dest-type-head">
                <label class="checkbox-label">
                  <input type="checkbox" data-modal-field="backupWatchHistory" ${watchOn ? "checked" : ""} />
                  <b>Watch History Backups</b>
                </label>
                <label class="backup-dest-keep-label">
                  <span>Keep</span>
                  <input class="field backup-dest-keep-input" type="number" min="1" max="365" data-modal-field="watchRetention" value="${escapeAttribute(String(destination.settings?.watchRetention ?? ""))}" placeholder="${escapeAttribute(String(globalWatchRetention || 7))}" />
                </label>
              </div>
              <div class="backup-dest-type-foot">
                <span class="backup-dest-type-meta">${formatTypeRuntime(watchRuntime, watchOn)}</span>
                <button type="button" class="button-ghost sync-action-btn sync-tool-button" data-dest-backup="watch">Back Up Now</button>
              </div>
            </div>

            <div class="backup-dest-type-card">
              <div class="backup-dest-type-head">
                <label class="checkbox-label">
                  <input type="checkbox" data-modal-field="backupFullPlekt" ${fullOn ? "checked" : ""} />
                  <b>Full Encrypted Plekt Backups</b>
                </label>
                <label class="backup-dest-keep-label">
                  <span>Keep</span>
                  <input class="field backup-dest-keep-input" type="number" min="1" max="365" data-modal-field="fullRetention" value="${escapeAttribute(String(destination.settings?.fullRetention ?? (isNew && isDropbox ? "2" : "")))}" placeholder="${escapeAttribute(isDropbox ? "2" : String(globalFullRetention || 7))}" />
                </label>
              </div>
              <div class="backup-dest-type-foot">
                <span class="backup-dest-type-meta">${formatTypeRuntime(fullRuntime, fullOn)}</span>
                <button type="button" class="button-ghost sync-action-btn sync-tool-button" data-dest-backup="full">Back Up Now</button>
              </div>
            </div>
          </div>

          ${optionalFieldsHtml}
          ${form.oauthKind === "dropbox" ? `<div class="backup-oauth-host"></div>` : ""}

          <p class="message ${cachedNotice ? escapeAttribute(cachedNotice.tone || "muted") : "hidden"}" data-dest-status data-tone="${cachedNotice ? escapeAttribute(cachedNotice.tone || "muted") : ""}" role="status" aria-live="polite">${cachedNotice ? escapeHtml(cachedNotice.text || "") : ""}</p>

          <div class="settings-inline-footer">
            <label class="checkbox-label settings-inline-enabled">
              <input type="checkbox" data-modal-field="enabled" ${isNew ? "checked" : (destination.enabled ? "checked" : "")} />
              <span>Enable this destination</span>
            </label>
            <div class="settings-inline-buttons">
              ${reconnectButtonHtml}
              ${destination.id ? `<button type="button" class="button-danger" data-dest-delete>Remove</button>` : ""}
              <button type="button" class="button-ghost" data-dest-test>Test</button>
              <button type="button" class="button-primary" data-dest-save>Save</button>
            </div>
          </div>
        </div>
      </details>
    `;
  }).join("") + `
    <div class="backup-dest-add-row">
      <button type="button" class="button-ghost sync-action-btn sync-tool-button" data-dest-add-extra>${addLabel}</button>
    </div>
  `;

  // Wire each accordion's controls
  entries.forEach(({ key, type, form, destination }) => {
    const details = container.querySelector(`details[data-dest-panel-key="${CSS.escape(key)}"]`);
    if (!details) return;
    const panel = details.querySelector(".backup-dest-panel");
    const statusEl = panel.querySelector("[data-dest-status]");
    const target = { type, settings: {}, secretFlags: {}, ...destination };

    const setStatus = (text, tone = "muted") => {
      statusEl.textContent = text || "";
      statusEl.dataset.tone = tone;
      statusEl.className = text ? `message ${tone}` : "message hidden";
    };
    const collect = () => collectFieldValues(panel);
    const setActionButtonsDisabled = (disabled) => {
      panel.querySelectorAll("[data-dest-save], [data-dest-test], [data-dest-delete], [data-dest-connect], [data-dest-backup]").forEach((btn) => {
        btn.disabled = disabled;
      });
    };

    const connectBtn = panel.querySelector("[data-dest-connect]");
    connectBtn?.addEventListener("click", async () => {
      setActionButtonsDisabled(true);
      try {
        await runDropboxConnectFlow(target, form, {
          container: panel,
          collect,
          setStatus,
          onConnected: () => { connectBtn.textContent = "Reconnect Dropbox"; },
          onChanged,
        });
      } catch (error) {
        setStatus(`✘ ${error?.message || "Dropbox connection failed."}`, "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    });

    panel.querySelector("[data-dest-save]")?.addEventListener("click", async () => {
      setActionButtonsDisabled(true);
      setStatus("Saving...", "muted");
      try {
        const saved = await saveDestinationValues(target, form, collect());
        panelStatusCache.set(`dest:${saved.id}`, { text: "✔ Settings saved.", tone: "success" });
        await onChanged?.();
        setMessage(`${destinationLabel(target)} saved.`, "success");
      } catch (error) {
        setStatus(`✘ ${error?.message || "Save failed."}`, "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    });

    panel.querySelector("[data-dest-test]")?.addEventListener("click", async () => {
      setActionButtonsDisabled(true);
      setStatus("Testing connection...", "muted");
      try {
        const saved = await saveDestinationValues(target, form, collect());
        const result = await postDestinationAction({ action: "test-destination", destinationId: saved.id });
        panelStatusCache.set(`dest:${saved.id}`, {
          text: `✔ Connection OK - ${result.result?.detail || "reachable"}.`,
          tone: "success",
        });
        await onChanged?.();
      } catch (error) {
        setStatus(`✘ ${error?.message || "Connection test failed."}`, "error");
      } finally {
        setActionButtonsDisabled(false);
      }
    });

    panel.querySelector("[data-dest-delete]")?.addEventListener("click", async () => {
      const approved = await openConfirmDialog({
        title: `Remove ${destinationLabel(target)}?`,
        body: "Stop mirroring backups here? Files already uploaded to the remote are left untouched.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!approved) return;
      setActionButtonsDisabled(true);
      try {
        await postDestinationAction({ action: "remove-destination", destinationId: target.id });
        panelStatusCache.delete(key);
        await onChanged?.();
        setMessage("Destination removed.", "success");
      } catch (error) {
        setStatus(`✘ ${error?.message || "Remove failed."}`, "error");
        setActionButtonsDisabled(false);
      }
    });

    panel.querySelectorAll("[data-dest-backup]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kind = btn.dataset.destBackup;
        const origLabel = btn.textContent;
        setActionButtonsDisabled(true);
        btn.textContent = "Backing up...";
        setStatus(kind === "full" ? "Creating and uploading encrypted full backup..." : "Creating and uploading watch-history backup...", "muted");
        try {
          const saved = await saveDestinationValues(target, form, collect());
          const result = kind === "full"
            ? await postBackupEndpoint("/api/plembfin-backups", {
                action: "create",
                remote: true,
                destinationId: saved.id,
                passphrase: getPlektPassphrase() || "",
              })
            : await postDestinationAction({
                action: "create",
                remote: true,
                destinationId: saved.id,
              });
          const remotes = Array.isArray(result.backup?.remotes) ? result.backup.remotes : [];
          const failed = remotes.find((r) => r.status === "error");
          if (failed) {
            throw new Error(failed.lastError || "Upload failed");
          }
          panelStatusCache.set(`dest:${saved.id}`, {
            text: `✔ Uploaded ${result.backup?.name || "backup"}.`,
            tone: "success",
          });
          await onChanged?.();
          setMessage(`Uploaded ${result.backup?.name || "backup"} to ${destinationLabel(saved)}.`, "success");
        } catch (error) {
          setStatus(`✘ ${error?.message || "Backup failed."}`, "error");
        } finally {
          btn.textContent = origLabel;
          setActionButtonsDisabled(false);
        }
      });
    });
  });

  container.querySelector("[data-dest-add-extra]")?.addEventListener("click", () => {
    openBackupDestinationPicker({ onChanged, setMessage, openConfirmDialog });
  });
}

// Renders active remote destinations grouped by location for Settings → Restore.
export function renderRemoteRestoreGroups({
  kind,
  activeDestinations = [],
  groups = null,
  fallbackFiles = [],
  loading = false,
  loadingHtml = "",
  preambleHtml = "",
  emptyForGroup,
  renderGroupFiles,
}) {
  const count = activeDestinations.length;
  const toolbar = `<div class="remote-restore-toolbar"><span class="muted-copy">${count ? `${count} active location${count === 1 ? "" : "s"}` : "No active remote locations"}</span><button type="button" class="button-ghost sync-action-btn sync-tool-button" data-remote-restore-refresh="${escapeAttribute(kind)}"${loading ? " disabled" : ""}>Refresh</button></div>`;
  if (loading) return toolbar + loadingHtml;
  if (!count) {
    return toolbar + `<div class="empty-log"><b>No active remote backup locations</b><span>Enable a remote destination in Settings → Backup to restore from remote storage.</span></div>`;
  }
  const list = Array.isArray(groups) && groups.length
    ? groups
    : activeDestinations.map((dest) => ({
        destId: dest.id,
        destLabel: destinationLabel(dest),
        destType: dest.type,
        files: fallbackFiles.filter((file) => file.destId === dest.id),
        error: "",
      }));
  const sections = list.map((group) => {
    const provider = DESTINATION_FORMS[group.destType]?.label || group.destType || "Remote";
    const badge = group.error
      ? `<span class="status-pill status-danger">Unavailable</span>`
      : `<span class="status-pill status-muted">${group.files.length} backup${group.files.length === 1 ? "" : "s"}</span>`;
    const body = group.error
      ? `<div class="empty-log"><b style="color: var(--red);">Could not list backups</b><span>${escapeHtml(group.error)}</span></div>`
      : (group.files.length ? renderGroupFiles(group.files) : emptyForGroup(group));
    return `<section class="remote-restore-group"><header class="remote-restore-group-head"><div class="remote-restore-group-title"><b>${escapeHtml(group.destLabel)}</b><span class="muted-copy">${escapeHtml(provider)}</span></div>${badge}</header>${body}</section>`;
  }).join("");
  return toolbar + preambleHtml + sections;
}
