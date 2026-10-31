// Media-server and metadata-provider settings: Sonarr-style card grids backed
// by /api/config, with edit modals that save per-section payloads and test
// connections. Secrets follow the redacted-config contract - the server never
// echoes credentials, only a `configured` flag per section, and a blank secret
// on save means "keep the stored credential" (except Seerr, whose key is only
// sent when non-empty).
import { state } from "./state.js?v=2.2.3.0.0";
import { buildAuthHeaders } from "./auth.js?v=2.2.3.0.0";
import { openSettingsEditModal, openSettingsPickerModal, renderFieldRow, collectFieldValues, renderInlineServicePanel } from "./settings-ui.js?v=2.2.3.0.0";
import { prepareHelpReadMore } from "./settings-shell.js?v=2.2.3.0.0";
import { escapeAttribute, escapeHtml } from "./utils.js?v=2.2.3.0.0";
import { renderAnidbSettings } from "./anidb-settings.js?v=2.2.3.0.0";
import {
  plexCredentialGuide,
  embyCredentialGuide,
  jellyfinCredentialGuide,
  savedCredentialNote,
} from "./help-content.js?v=2.2.3.0.0";
import {
  PLEX_HISTORICAL_SYNC_HELP_HTML,
  PLEX_HISTORICAL_SYNC_CHOICES,
  PLEX_HISTORICAL_SYNC_LABEL,
  PROVIDER_DATE_NOTE_HTML,
  plexHistoricalSyncEnabled,
  plexHistoricalSyncOffWarningHtml,
} from "./plex-history-policy.js?v=2.2.3.0.0";

let _cb = {};
let _tautulliImport = {
  initTautulliImport: () => {},
  refreshTautulliImport: () => {},
};

export function setTautulliImportModule(module) {
  _tautulliImport = module || _tautulliImport;
}

export function initSettingsServices(callbacks = {}) {
  _cb = callbacks;
  // The onboarding Options step saves the same Sync Tuning fields while the
  // Settings DOM remains mounted in the background. Refresh only that form
  // for its explicit event so unrelated config changes cannot wipe another
  // field the user is currently editing.
  document.addEventListener("plembfin:config-changed", (event) => {
    if (event.detail?.refreshSyncTuning) renderSyncTuningCard();
  });
}
export function refreshTautulliImport(...args) {
  return _tautulliImport.refreshTautulliImport(...args);
}
const setMessage = (...args) => _cb.setMessage?.(...args);
const clearDerivedUiCaches = (...args) => _cb.clearDerivedUiCaches?.(...args);
const renderDashboard = (...args) => _cb.renderDashboard?.(...args);
const renderActiveSessions = (...args) => _cb.renderActiveSessions?.(...args);

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export async function refreshSeerrCapabilities() {
  if (!state.seerrConfigured) {
    state.seerrSupports4k = { movie: false, tv: false };
    return state.seerrSupports4k;
  }
  const response = await fetch("/api/seerr/status", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Seerr status failed with ${response.status}`);
  state.seerrSupports4k = {
    movie: Boolean(body.capabilities?.movie4k),
    tv: Boolean(body.capabilities?.tv4k),
  };
  return state.seerrSupports4k;
}

const seerrGuide = () => `
  <p class="tool-accordion-desc"><b>Seerr URL:</b> The base URL of your Seerr instance, typically <code>http://localhost:5055</code>.</p>
  <p class="tool-accordion-desc"><b>API Key:</b> Open Seerr → <b>Settings → General</b> and copy the <b>API Key</b> shown at the top of the page.</p>
  <p class="tool-accordion-desc">Once configured, a <b>"Request on Seerr"</b> button appears on every movie and TV show detail page.</p>
`;

const CONNECTION_SERVICES = {
  plex: {
    name: "Plex",
    description: "Sync watch history with a Plex server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "manualMode", label: "Use manual token setup", type: "checkbox", value: config.authMode === "manual", optionalGroup: true, help: "Turns off verified account mode. Only one Plex authentication mode is active at a time." },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:32400", help: "Address Plekt uses to reach Plex.", optionalGroup: true },
      { key: "token", label: "Token", secret: true, configured: config.configured, configuredPlaceholder: "Configured - enter a new token to replace it", placeholder: "Plex token", optionalGroup: true },
      { key: "username", label: "Username", value: config.username || "", optional: true, help: "Plex account name used to match webhook events.", optionalGroup: true },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, token: v.token, username: v.username, disabled: !v.enabled, authMode: v.manualMode ? "manual" : "account" }),
    testPayload: (v) => ({ type: "plex", url: v.baseUrl, token: v.token }),
    help: () => plexCredentialGuide() + savedCredentialNote(),
  },
  emby: {
    name: "Emby",
    description: "Sync watch history with an Emby server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:8096", help: "Address Plekt uses to reach Emby." },
      { key: "accountUsername", label: "Emby username", value: "", autocomplete: "username", help: "Used once to obtain a user-scoped access token." },
      { key: "accountPassword", label: "Emby password", secret: true, value: "", autocomplete: "current-password", placeholder: "Not stored by Plekt" },
      { key: "manualMode", label: "Use manual API key setup", type: "checkbox", value: config.authMode === "manual", optionalGroup: true, help: "Turns off verified account mode. Only one Emby authentication mode is active at a time." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Emby API key", optionalGroup: true },
      { key: "userId", label: "User ID", value: config.userId || "", help: "The Emby user whose playstate is synchronized.", optionalGroup: true },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, apiKey: v.apiKey, userId: v.userId, disabled: !v.enabled, authMode: v.manualMode ? "manual" : "account" }),
    testPayload: (v) => ({ type: "emby", url: v.baseUrl, token: v.apiKey }),
    help: () => embyCredentialGuide() + savedCredentialNote(),
  },
  jellyfin: {
    name: "Jellyfin",
    description: "Sync watch history with a Jellyfin server",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || config.url || "", placeholder: "http://127.0.0.1:8096", help: "Address Plekt uses to reach Jellyfin." },
      { key: "accountUsername", label: "Fallback username", value: "", autocomplete: "username", optional: true, help: "Only used if Quick Connect is disabled." },
      { key: "accountPassword", label: "Fallback password", secret: true, value: "", autocomplete: "current-password", placeholder: "Not stored by Plekt", optional: true },
      { key: "manualMode", label: "Use manual API key setup", type: "checkbox", value: config.authMode === "manual", optionalGroup: true, help: "Turns off verified account mode. Only one Jellyfin authentication mode is active at a time." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Jellyfin API key", optionalGroup: true },
      { key: "userId", label: "User ID", value: config.userId || "", help: "The Jellyfin user whose playstate is synchronized.", optionalGroup: true },
    ],
    payload: (v) => ({ baseUrl: v.baseUrl, apiKey: v.apiKey, userId: v.userId, disabled: !v.enabled, authMode: v.manualMode ? "manual" : "account" }),
    testPayload: (v) => ({ type: "jellyfin", url: v.baseUrl, token: v.apiKey }),
    help: () => jellyfinCredentialGuide() + savedCredentialNote(),
  },
  seerr: {
    name: "Seerr",
    description: "Send media requests from detail pages",
    fields: (config) => [
      { key: "enabled", label: "Enable", type: "checkbox", value: !config.disabled },
      { key: "baseUrl", label: "Server URL", type: "url", value: config.baseUrl || "", placeholder: "http://localhost:5055", help: "Base URL of your Overseerr / Jellyseerr instance." },
      { key: "apiKey", label: "API Key", secret: true, configured: config.configured, placeholder: "Seerr API key" },
    ],
    payload: (v) => {
      const payload = { baseUrl: v.baseUrl, disabled: !v.enabled };
      if (v.apiKey) payload.apiKey = v.apiKey;
      return payload;
    },
    help: () => savedCredentialNote() + seerrGuide(),
  },
};

const keySteps = (lines) => `<ol class="tool-accordion-desc" style="margin: 0; padding-left: 1.25rem; list-style: decimal; font-size: 0.8rem;">${lines.map((line) => `<li>${line}</li>`).join("")}</ol>`;

const METADATA_SERVICES = {
  tmdb: {
    name: "TMDB",
    description: "Artwork, cast, trailers, and metadata (required)",
    keyLabel: "API Key (v3)",
    keyPlaceholder: "TMDB API key",
    keyHelp: "Free v3 developer key - powers posters, cast, and detail pages.",
    help: () => `
      <p class="tool-accordion-desc">Provides poster artwork, cast directories, descriptions, and related recommendations. To obtain a free v3 API key:</p>
      ${keySteps(["Create an account at <b>themoviedb.org</b>", "Go to <b>Settings → API</b> in your profile menu", "Request a Developer key"])}
    `,
  },
  youtube: {
    name: "YouTube",
    description: "Trailer details and durations",
    keyLabel: "Data API Key",
    keyPlaceholder: "YouTube Data API key (optional)",
    optional: true,
    help: () => `
      <p class="tool-accordion-desc">Enables downloading trailer meta descriptions and length info. To create a key:</p>
      ${keySteps(["Go to <b>console.cloud.google.com</b>", "Enable the <b>YouTube Data API v3</b> in your project", "Generate an API Key under Credentials"])}
    `,
  },
  fanart: {
    name: "Fanart.tv",
    description: "Fallback posters, backdrops, and logos",
    keyLabel: "Personal API Key",
    keyPlaceholder: "Personal API key (optional)",
    optional: true,
    keyHelp: "A built-in project key is already configured - a personal key raises rate limits.",
    help: () => `
      <p class="tool-accordion-desc">Plekt uses fanart.tv as a fallback source for posters, backdrops, and logo art when TMDB has no images for a title. A built-in project key is already configured - no key is required to use this feature.</p>
      <p class="tool-accordion-desc">Entering your own personal API key gives you higher rate limits and access to images uploaded by your fanart.tv account:</p>
      ${keySteps(["Create an account at <b>fanart.tv</b>", "Go to your <b>Profile → API Key</b>", "Copy your personal key and paste it here"])}
    `,
  },
  tvdb: {
    name: "TheTVDB",
    description: "Episode ordering and air dates",
    keyLabel: "Personal API Key",
    keyPlaceholder: "Personal API key (optional)",
    optional: true,
    keyHelp: "A built-in project key is already configured - a personal key gives you your own quota.",
    help: () => `
      <p class="tool-accordion-desc">TV show names, seasons, episode numbering, air dates, and artwork are sourced from TheTVDB for more accurate episode ordering than TMDB alone. A built-in project key is already configured - no key is required to use this feature.</p>
      ${keySteps(["Create an account at <b>thetvdb.com</b>", "Go to <b>Dashboard → API Keys</b> and request a key", "Copy your personal key and paste it here"])}
    `,
  },
  omdb: {
    name: "OMDb",
    description: "IMDb ratings on movie pages",
    keyLabel: "API Key",
    keyPlaceholder: "OMDb API key",
    optional: true,
    help: () => `
      <p class="tool-accordion-desc">When configured, Plekt fetches IMDb ratings from the OMDb API and shows them next to the TMDB score on movie pages. Ratings are cached for 7 days; the free tier allows 1,000 requests/day.</p>
      ${keySteps(["Go to <b>omdbapi.com/apikey.aspx</b>", "Register for a free API key", "Paste the key here and save"])}
    `,
  },
};

export const SERVICE_DEFS = Object.freeze({ ...CONNECTION_SERVICES, ...METADATA_SERVICES });

// Sync tuning is not part of the add/remove service picker - it's a single,
// always-visible card, so it's kept out of CONNECTION_SERVICES/METADATA_SERVICES
// (which drive the "Add Media Server"/"Add Metadata Provider" pickers).
const TUNING_FIELD_DEFS = [
  { key: "watchedThresholdPercent", label: "Watched Threshold", unit: "%", help: "Playback progress percentage at which a play counts as watched." },
  { key: "minResumePositionSec", label: "Minimum Resume Position", unit: "sec", help: "Minimum playback position before a stopped play is saved as a resume point." },
  { key: "activeSessionTtlMin", label: "Active Session TTL", unit: "min", help: `How long a "now playing" session is kept without an update before it's considered stale.` },
  { key: "outboundTimeoutSec", label: "Outbound Request Timeout", unit: "sec", help: "How long Plekt waits for a response from Plex, Emby, or Jellyfin before giving up." },
];
const WATCH_IMPORT_FIELD = {
  key: "watchImportMode",
  id: "sync-field-watch_import_mode",
  label: "When you manually mark an item as watched in Plex / Emby / Jellyfin",
  type: "choice",
  options: [
    { value: "review", label: "Require review -", inlineDescription: "Default and recommended.", description: "Hold for a decision in Manual Watch review; items appear above Sync - Idle." },
    { value: "now", label: "Mark as watched now", description: "Use the time the scanner sees the watched flag." },
    { value: "release_day", label: "Mark as watched on release day", description: "Use the movie or episode release date." },
    { value: "episode_timing", label: "Mark as watched at the same time as other episodes", description: "Use the before/after from the media pages." },
  ],
  help: "",
};
// Plex-only, and only for historical projections (imports, restores, backdated
// marks, library-wide pushes). Emby, Jellyfin, and Trakt keep receiving the
// original watch date whatever this is set to - the label and help have to make
// that scope obvious, or turning it off reads as "stop syncing history".
const PLEX_HISTORICAL_SYNC_FIELD = {
  key: "plexHistoricalWatchedSync",
  id: "sync-field-plex_historical_watched_sync",
  type: "choice",
  label: PLEX_HISTORICAL_SYNC_LABEL,
  options: PLEX_HISTORICAL_SYNC_CHOICES,
  help: `${PLEX_HISTORICAL_SYNC_HELP_HTML}<br>${PROVIDER_DATE_NOTE_HTML}<br>${plexHistoricalSyncOffWarningHtml()}`,
  helpIsHtml: true,
};
const EXTRA_SERVICE_NAMES = { tuning: "Sync Tuning", upNextSync: "Up Next Sync" };

// Opt-in toggle for the outbound pacing governor's "fast" profile
// (server/src/utils/outboundGovernor.js) - off by default (profile
// "standard") because the governor's throttling is what keeps bulk sync
// operations from hammering a media server reached over the internet.
// "fast" removes almost all of that throttling, so it must be explicitly
// enabled here rather than assumed safe.
const PACING_FIELD = {
  key: "fastLocalPacing",
  type: "checkbox",
  label: "Fast Local-Network Sync",
  help: "Speeds up Force Sync, Full Sync Watchstates, and other bulk sync operations by removing most outbound pacing delays.<br>Only enable this when Plex, Emby, and Jellyfin are all self-hosted on the same trusted local network as Plekt.<br>It is not safe to enable if any of them is reached over the public internet.",
  helpIsHtml: true,
};
const UP_NEXT_SYNC_FIELD = {
  key: "upNextSyncEnabled",
  id: "sync-field-up_next_sync",
  type: "checkbox",
  label: "Sync Up Next to media apps",
  help: "When enabled, Plekt keeps its Up Next queue in sync with Plex and Emby's Continue Watching and Jellyfin's Next Up.<br>Turn it off to leave those app lists unchanged; Plekt's own Up Next view remains available.",
  helpIsHtml: true,
};

const SYNC_TUNING_SUMMARIES = Object.freeze({
  watchImportMode: "Choose how app-marked watches are dated or reviewed",
  plexHistoricalWatchedSync: "Control historical watched items sent to Plex",
  watchedThresholdPercent: "Set the playback percentage that counts as watched",
  minResumePositionSec: "Set the minimum playback position saved as a resume point",
  activeSessionTtlMin: "Set how long inactive now-playing sessions remain valid",
  outboundTimeoutSec: "Set how long requests wait for a media server response",
  fastLocalPacing: "Speed up bulk sync on a trusted local network",
  upNextSyncEnabled: "Keep Plekt's Up Next queue synced with media apps",
});

function tuningBadges(tuning = {}) {
  const overriddenCount = [WATCH_IMPORT_FIELD, PLEX_HISTORICAL_SYNC_FIELD, ...TUNING_FIELD_DEFS]
    .filter((field) => tuning[field.key]?.overridden).length;
  if (!overriddenCount) return [{ label: "Defaults", tone: "muted" }];
  return [{ label: `${overriddenCount} customized`, tone: "ready" }];
}

function syncTuningFieldSpecs(tuning = {}) {
  const modeInfo = tuning[WATCH_IMPORT_FIELD.key] || {};
  const modeDefaultValue = modeInfo.default || "review";
  const modeField = {
    ...WATCH_IMPORT_FIELD,
    value: modeInfo.value || modeDefaultValue,
    help: WATCH_IMPORT_FIELD.help,
    helpIsHtml: true,
  };
  const plexHistoricalField = {
    ...PLEX_HISTORICAL_SYNC_FIELD,
    value: plexHistoricalSyncEnabled({ tuning }) ? "on" : "off",
  };
  return [modeField, plexHistoricalField, ...TUNING_FIELD_DEFS].map((field) => {
    if (field.type === "select" || field.type === "choice" || field.type === "checkbox") return field;
    const info = tuning[field.key] || {};
    return {
      key: field.key,
      label: `${field.label}${field.unit ? ` (${field.unit})` : ""}`,
      type: "number",
      value: info.overridden ? info.value : "",
      placeholder: info.default != null ? String(info.default) : "",
      optional: false,
      help: field.help,
      defaultText: info.default != null
        ? `Default: ${info.default}${field.unit || ""}. Valid range: ${info.min}-${info.max}.`
        : "",
      helpIsHtml: true,
    };
  });
}

// Blank ⇒ null ⇒ configStore.js interprets null as "not overridden, fall back
// to the environment variable or built-in default" (see server/src/utils/tuning.js).
function syncTuningPayload(values = {}) {
  const payload = {};
  payload.watchImportMode = String(values.watchImportMode || "review").trim() || null;
  const plexHistoricalValue = values[PLEX_HISTORICAL_SYNC_FIELD.key];
  payload.plexHistoricalWatchedSync = plexHistoricalValue === "on" || plexHistoricalValue === true;
  for (const field of TUNING_FIELD_DEFS) {
    const raw = String(values[field.key] ?? "").trim();
    payload[field.key] = raw === "" ? null : Number(raw);
  }
  return payload;
}

function renderSyncTuningFieldDisclosure(field) {
  const fieldId = field.id || `sync-field-${field.key}`;
  const summaryText = SYNC_TUNING_SUMMARIES[field.key] || `Configure ${field.label}`;
  return `
    <details id="${escapeAttribute(fieldId)}-details" class="sync-tool-details">
      <summary class="accordion-header">
        <div class="sync-tool-summary-title">
          <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
          <b>${escapeHtml(field.label)}</b>
        </div>
        <span>${escapeHtml(summaryText)}</span>
      </summary>
      <div class="tool-item-row">
        ${renderFieldRow(field)}
      </div>
    </details>
  `;
}

// Renders the sync tuning fields directly into the page, one collapsed
// disclosure per setting, and wires the form's submit handler to save them in
// place.
export function renderSyncTuningCard() {
  const fieldsContainer = document.querySelector("#syncTuningFields");
  const form = document.querySelector("#syncTuningForm");
  if (!fieldsContainer || !form) return;
  const tuning = state.savedConfig?.tuning || {};
  const fastPacingEnabled = state.savedConfig?.pacing?.profile === "fast";
  const upNextSyncEnabled = state.savedConfig?.upNextSync?.enabled !== false;
  fieldsContainer.innerHTML = [
    ...syncTuningFieldSpecs(tuning),
    { ...PACING_FIELD, value: fastPacingEnabled },
    { ...UP_NEXT_SYNC_FIELD, value: upNextSyncEnabled },
  ].map(renderSyncTuningFieldDisclosure).join("");

  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  const statusEl = document.querySelector("#syncTuningStatus");
  const setStatus = (text, tone = "muted") => {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
    statusEl.className = `message ${tone}`;
  };
  const markDirty = () => {
    if (form.dataset.saving === "true") return;
    form.dataset.dirty = "true";
    setStatus("Unsaved changes.", "muted");
  };
  // The fields are re-rendered after a save, so listen on the stable container
  // rather than on individual inputs. This also keeps radio-button changes from
  // leaving a misleading "Saved." message on screen.
  fieldsContainer.addEventListener("input", markDirty);
  fieldsContainer.addEventListener("change", markDirty);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveButton = document.querySelector("#saveSyncTuningButton");
    form.dataset.saving = "true";
    if (saveButton) saveButton.disabled = true;
    setStatus("Saving...", "muted");
    try {
      const values = collectFieldValues(fieldsContainer);
      await saveServiceConfig("tuning", syncTuningPayload(values));
      await saveServiceConfig("pacing", { profile: values.fastLocalPacing ? "fast" : "standard" });
      await saveServiceConfig("upNextSync", { enabled: Boolean(values.upNextSyncEnabled) });
      form.dataset.dirty = "false";
      setStatus("Saved.", "success");
    } catch (error) {
      form.dataset.dirty = "true";
      setStatus(error?.message || "Save failed.", "error");
    } finally {
      delete form.dataset.saving;
      if (saveButton) saveButton.disabled = false;
    }
  });
}

function connectionTouched(config) {
  return Boolean(config && (config.connection || config.configured || config.baseUrl || config.url || config.disabled === true));
}

function connectionBadges(config = {}) {
  const verified = config.connection;
  const manualMode = config.authMode === "manual";
  const badges = manualMode && config.configured
    ? [{ label: "Manual setup active", tone: "warning" }]
    : verified?.status === "connected"
    ? [{ label: "Account connected", tone: "ready" }]
    : verified?.status === "reauth_required"
      ? [{ label: "Reconnect required", tone: "warning" }]
      : config.configured
        ? [{ label: "Legacy credentials", tone: "warning" }]
        : [{ label: "Not configured", tone: "warning" }];
  if (manualMode && verified) badges.push({ label: "Account available", tone: "muted" });
  if (config.disabled) badges.push({ label: "Sync disabled", tone: "muted" });
  const roleLabels = { bidirectional: "Source + Destination", source_only: "Source only", destination_only: "Destination only", monitor: "Monitor only" };
  const role = roleLabels[config.sync?.preset];
  if (role) badges.push({ label: role, tone: role === "Monitor only" ? "muted" : "ready" });
  return badges;
}

async function reloadSettingsConfig() {
  const response = await fetch("/api/config", { headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Configuration refresh failed with ${response.status}`);
  state.savedConfig = body.config || {};
  state.configLoaded = true;
  applyConfigToSettingsUi(state.savedConfig);
  clearDerivedUiCaches();
  renderDashboard();
  renderActiveSessions();
  // Lets other pages (e.g. the /setup wizard) know a connection changed
  // without settings-services.js importing them directly.
  document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
  return state.savedConfig;
}

function renderPlexServerPicker(ui, flowId, account, servers = []) {
  const fields = ui.dialog.querySelector(".settings-modal-fields");
  if (!fields) throw new Error("Plex server selection is unavailable");
  fields.innerHTML = `
    <div class="plex-account-summary">
      <b>${escapeHtml(account?.username || "Plex account")}</b>
      <span>Choose the server Plekt should synchronize.</span>
    </div>
    <p class="message" data-tone="success">Plex account verified. Choose a server.</p>
    <div class="settings-card-grid plex-server-picker">
      ${servers.map((server) => `
        <button class="service-card" type="button" data-plex-machine="${escapeAttribute(server.machineIdentifier)}">
          <b>${escapeHtml(server.name || "Plex Media Server")}</b>
          <span class="service-card-desc">${server.owned ? "Owned server" : "Shared server"}</span>
        </button>
      `).join("")}
    </div>
  `;
  if (!servers.length) throw new Error("This Plex account has no accessible media servers.");
  fields.querySelectorAll("[data-plex-machine]").forEach((button) => {
    button.addEventListener("click", async () => {
      ui.setBusy(true);
      ui.setStatus("Verifying the selected server...", "muted");
      try {
        const response = await fetch(`/api/media-auth/plex/${encodeURIComponent(flowId)}/server`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ machineIdentifier: button.dataset.plexMachine }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) throw new Error(body.error || "Plex server verification failed");
        await reloadSettingsConfig();
        ui.close();
        setMessage(`Connected Plex as ${body.connection?.remoteUsername || "the verified account"}.`, "success");
      } catch (error) {
        ui.setStatus(error?.message || "Plex server verification failed.", "error");
      } finally {
        ui.setBusy(false);
      }
    });
  });
}

async function connectPlexAccount(ui) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("Allow pop-ups for Plekt, then try again.");
  popup.document.title = "Opening Plex";
  popup.document.body.textContent = "Opening Plex sign-in...";
  ui.setStatus("Starting secure Plex sign-in...", "muted");
  let start;
  try {
    const response = await fetch("/api/media-auth/plex/start", { method: "POST", headers: authHeaders(), body: "{}" });
    start = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(start.error || "Could not start Plex sign-in");
    if (start.status === "authorised" && start.resumed) popup.close();
    else popup.location.replace(start.authUrl);
  } catch (error) {
    popup.close();
    throw error;
  }

  ui.setStatus(start.resumed ? "Resuming your completed Plex sign-in..." : "Finish signing in with Plex. This window will update automatically.", "muted");
  while (Date.now() < Number(start.expiresAt || 0)) {
    if (!start.resumed) await new Promise((resolve) => setTimeout(resolve, 2000));
    start.resumed = false;
    const response = await fetch(`/api/media-auth/plex/${encodeURIComponent(start.flowId)}/status`, { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (response.status === 410 || body.status === "expired") throw new Error("Plex sign-in expired. Start again.");
    if (!response.ok) throw new Error(body.error || "Plex sign-in check failed");
    if (body.status === "authorised") {
      renderPlexServerPicker(ui, start.flowId, body.account, body.servers);
      return;
    }
  }
  throw new Error("Plex sign-in expired. Start again.");
}

async function disconnectPlexAccount() {
  const response = await fetch("/api/media-connections/plex", { method: "DELETE", headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Plex disconnect failed");
  await reloadSettingsConfig();
  setMessage(body.guidance || "Plex account disconnected.", "success");
}

function confirmInsecureCredentialSubmit(baseUrl, provider) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error(`Enter a valid ${provider} server URL first.`); }
  if (url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return true;
  return window.confirm(`${provider} will receive your password over an unencrypted HTTP connection. Continue only if this is a trusted local network.`);
}

async function loginEmbyLikeAccount(ui, provider, values = ui.collect()) {
  const name = provider === "emby" ? "Emby" : "Jellyfin";
  if (!values.baseUrl) throw new Error(`Enter the ${name} server URL first.`);
  if (!values.accountUsername) throw new Error(`Enter your ${name} username.`);
  if (!confirmInsecureCredentialSubmit(values.baseUrl, name)) return;
  ui.setStatus(`Signing in to ${name} and verifying the user...`, "muted");
  const response = await fetch(`/api/media-auth/${provider}/login`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ baseUrl: values.baseUrl, username: values.accountUsername, password: values.accountPassword || "" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `${name} sign-in failed`);
  await reloadSettingsConfig();
  ui.close();
  setMessage(`Connected ${name} as ${body.connection?.remoteUsername || "the verified account"}.`, "success");
}

async function connectJellyfinAccount(ui) {
  const values = ui.collect();
  if (!values.baseUrl) throw new Error("Enter the Jellyfin server URL first.");
  ui.setStatus("Requesting a Jellyfin Quick Connect code...", "muted");
  const response = await fetch("/api/media-auth/jellyfin/quick-connect/start", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ baseUrl: values.baseUrl }),
  });
  const start = await response.json().catch(() => ({}));
  if (response.status === 409 && start.code === "quick_connect_disabled") {
    if (!values.accountUsername) {
      throw new Error("Quick Connect is disabled. Enter the fallback username and password above, then choose Connect Jellyfin again.");
    }
    return loginEmbyLikeAccount(ui, "jellyfin", values);
  }
  if (!response.ok) throw new Error(start.error || "Could not start Jellyfin Quick Connect");
  ui.setStatus(`In Jellyfin, open Settings → Quick Connect and enter ${start.code}. Waiting for approval...`, "muted");
  const fields = ui.dialog.querySelector(".settings-modal-fields");
  fields?.insertAdjacentHTML("afterbegin", `<div class="plex-account-summary jellyfin-quick-connect-code"><span>Jellyfin Quick Connect code</span><b>${escapeHtml(start.code)}</b><small>Approve this code in an already signed-in Jellyfin app.</small></div>`);
  while (Date.now() < Number(start.expiresAt || 0)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const check = await fetch(`/api/media-auth/jellyfin/quick-connect/${encodeURIComponent(start.flowId)}/status`, { headers: authHeaders() });
    const body = await check.json().catch(() => ({}));
    if (check.status === 410 || body.status === "expired") throw new Error("Jellyfin Quick Connect expired. Start again.");
    if (!check.ok) throw new Error(body.error || "Jellyfin Quick Connect check failed");
    if (body.status === "authorised" && body.ok) {
      await reloadSettingsConfig();
      ui.close();
      setMessage(`Connected Jellyfin as ${body.connection?.remoteUsername || "the verified account"}.`, "success");
      return;
    }
  }
  throw new Error("Jellyfin Quick Connect expired. Start again.");
}

async function disconnectEmbyLikeAccount(provider) {
  const name = provider === "emby" ? "Emby" : "Jellyfin";
  const response = await fetch(`/api/media-connections/${provider}`, { method: "DELETE", headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${name} disconnect failed`);
  await reloadSettingsConfig();
  setMessage(body.guidance || `${name} account disconnected.`, "success");
}

function metadataVisible(id, config) {
  return id === "tmdb" || Boolean(config?.configured);
}

function metadataBadges(id, config = {}) {
  if (id === "tmdb") {
    return [{
      label: config.configured ? "Configured using personal key" : "Required",
      tone: config.configured ? "ready" : "warning",
    }];
  }
  if (id === "tvdb") {
    return [{
      label: config.keySource === "personal" ? "Configured using personal key" : "Configured using built-in key",
      tone: "ready",
    }];
  }
  if (config.configured) return [{ label: "Configured", tone: "ready" }];
  return [{ label: id === "tmdb" ? "Required" : "Not configured", tone: "warning" }];
}

// Posts one config section and mirrors the old per-section post-save behavior:
// prefer the server's redacted echo, recompute `configured` locally when the
// echo is missing, refresh Seerr capabilities, and repaint dependent UI.
// The Plex card's watchlist checkbox saves on its own rather than waiting for
// the card's Save button, which only submits the connection fields.
async function saveWatchlistSyncEnabled(enabled) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ watchlistSync: { enabled: Boolean(enabled) } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Watchlist setting save failed with ${response.status}`);
  if (body.config) state.savedConfig = body.config;
  document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
  return body.config;
}

async function saveServiceConfig(section, sectionPayload) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ [section]: sectionPayload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.details) && body.details.length ? `: ${body.details.join("; ")}` : "";
    throw new Error(`${body.error || `Save failed with ${response.status}`}${detail}`);
  }

  const savedSectionConfig = body.config?.[section];
  const previousSectionConfig = state.savedConfig?.[section] || {};
  state.savedConfig = {
    ...state.savedConfig,
    [section]: savedSectionConfig || sectionPayload,
  };
  if (!savedSectionConfig) {
    if (METADATA_SERVICES[section]) {
      state.savedConfig[section] = {
        configured: Boolean(sectionPayload.apiKey || previousSectionConfig.configured),
        ...(METADATA_SERVICES[section] === METADATA_SERVICES.tvdb
          ? { keySource: sectionPayload.apiKey ? "personal" : previousSectionConfig.keySource || "built-in" }
          : {}),
      };
    } else if (section === "seerr") {
      const apiKeySet = Boolean(sectionPayload.apiKey || previousSectionConfig.configured);
      state.savedConfig.seerr = {
        configured: apiKeySet && Boolean(sectionPayload.baseUrl) && !sectionPayload.disabled,
        baseUrl: sectionPayload.baseUrl || "",
        disabled: Boolean(sectionPayload.disabled),
      };
    }
  }
  if (section === "seerr") {
    state.seerrConfigured = Boolean(state.savedConfig.seerr?.configured);
    await refreshSeerrCapabilities().catch(() => {
      state.seerrSupports4k = { movie: false, tv: false };
    });
  }

  state.configLoaded = true;
  clearDerivedUiCaches();
  renderDashboard();
  renderActiveSessions();
  renderMediaServerCards();
  renderMetadataCards();
  renderSyncTuningCard();
  // The setup wizard keeps its own server-derived status snapshot. Notify it
  // after every successful section save so metadata badges and completed-step
  // state refresh immediately instead of remaining stale until a page reload.
  document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
  setMessage(`Saved ${SERVICE_DEFS[section]?.name || EXTRA_SERVICE_NAMES[section] || section} settings successfully.`, "success");
  return body;
}

// Tests a media-server connection from modal values. A blank secret is allowed
// when the server is already configured - the backend falls back to the stored
// credential.
async function testServiceConnection(section, values) {
  const def = CONNECTION_SERVICES[section];

  if (section === "seerr") {
    await saveServiceConfig("seerr", def.payload(values));
    if (!state.seerrConfigured) throw new Error("Enter a Seerr server URL and API key first.");
    const response = await fetch("/api/seerr/status", { headers: authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "Connection failed");
    state.seerrSupports4k = {
      movie: Boolean(body.capabilities?.movie4k),
      tv: Boolean(body.capabilities?.tv4k),
    };
    return `✔ Connected to "${body.applicationTitle || "Seerr"}"`;
  }

  const payload = def.testPayload(values);
  if (!payload.url || (!payload.token && !state.savedConfig?.[section]?.configured && !state.savedConfig?.[section]?.connection)) {
    throw new Error("Server URL and token are required.");
  }
  const response = await fetch("/api/test-connection", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && body.ok) {
    return `✔ ${body.detail || "Server identity verified"} in ${body.elapsedMs || 0}ms (HTTP ${body.status || response.status})`;
  }
  const statusText = body.status ? `HTTP ${body.status}` : `HTTP ${response.status}`;
  throw new Error(`${body.error || "Connection failed"} (${statusText})`);
}

// Shared by the modal (metadata providers, Seerr) and the always-visible
// inline panels (Plex/Emby/Jellyfin) - everything about a service's fields,
// save/test/account-connect behavior except how it's displayed.
function buildServiceEditOptions(serviceId) {
  const connection = CONNECTION_SERVICES[serviceId];
  const metadata = METADATA_SERVICES[serviceId];
  const def = connection || metadata;
  if (!def) return null;
  const config = state.savedConfig?.[serviceId] || {};

  const fields = connection
    ? def.fields(config)
    : [{
        key: "apiKey",
        label: def.keyLabel,
        secret: true,
        configured: config.configured,
        placeholder: def.keyPlaceholder,
        optional: def.optional,
        help: def.keyHelp,
      }];

  const accountFlow = ["plex", "emby", "jellyfin"].includes(serviceId) && state.savedConfig?.mediaAuthEnabled;
  const accountAction = serviceId === "plex"
    ? connectPlexAccount
    : serviceId === "jellyfin"
      ? connectJellyfinAccount
      : serviceId === "emby"
        ? (ui) => loginEmbyLikeAccount(ui, "emby")
        : undefined;
  const disconnectAction = serviceId === "plex"
    ? disconnectPlexAccount
    : ["emby", "jellyfin"].includes(serviceId)
      ? () => disconnectEmbyLikeAccount(serviceId)
      : undefined;
  const connectLabel = serviceId === "plex" ? "Connect Plex account" : serviceId === "emby" ? "Connect Emby" : "Connect Jellyfin";
  return {
    def,
    connection,
    config,
    accountFlow,
    fields,
    enabledKey: connection ? "enabled" : "",
    saveDisabledLabel: connection ? "Save & disable" : "",
    onSave: (values) => saveServiceConfig(serviceId, connection ? def.payload(values) : { apiKey: values.apiKey }),
    onTest: connection ? (values) => testServiceConnection(serviceId, values) : undefined,
    onDelete: config.connection && disconnectAction ? async () => disconnectAction() : undefined,
    deleteLabel: "Disconnect account",
    leadingAction: accountFlow ? { label: config.connection ? `Reconnect ${def.name}` : connectLabel, onClick: accountAction } : undefined,
    saveLabel: "Save",
    // Plex is the only service with a real watchlist, so this is the only card
    // that offers the toggle. It writes to watchlistSync, not to the Plex
    // connection, which is why it is an extra toggle rather than a field.
    extraToggles: serviceId === "plex" ? [{
      label: "Sync Watchlist with Plekt",
      checked: Boolean(state.savedConfig?.watchlistSync?.enabled),
      onChange: (enabled) => saveWatchlistSyncEnabled(enabled),
    }] : [],
    optionalFieldsLabel: accountFlow ? "Optional manual credential setup" : "",
    helpHtml: `${accountFlow ? `<p class="tool-accordion-desc"><b>Recommended:</b> Connect ${serviceId === "emby" ? "an" : "a"} ${def.name} account to verify the remote user. Manual credentials below are a legacy compatibility option and do not prove user isolation.</p>` : ""}${def.help?.() || ""}`,
  };
}

export function openServiceEditModal(serviceId) {
  const options = buildServiceEditOptions(serviceId);
  if (!options) return;
  openSettingsEditModal({
    ...options,
    title: `${connectionTouched(options.config) || options.config.configured ? "Edit" : "Add"} ${options.def.name}`,
  });
}

// Plex/Emby/Jellyfin/Seerr render as always-visible inline panels (not a modal)
// on their settings pages.
export function renderMediaServerPanels() {
  for (const serviceId of ["plex", "emby", "jellyfin"]) {
    const container = document.querySelector(`#${serviceId}ServerPanel`);
    if (!container) continue;
    const options = buildServiceEditOptions(serviceId);
    if (!options) continue;
    const status = document.querySelector(`#${serviceId}ServerStatus`);
    const configured = connectionTouched(options.config);
    if (status) {
      status.textContent = configured ? "Configured" : "Not configured";
      status.className = `status-pill status-${configured ? "ready" : "muted"}`;
    }
    renderInlineServicePanel(container, options);
  }
}

function openServicePicker(area) {
  const defs = area === "connection" ? CONNECTION_SERVICES : METADATA_SERVICES;
  const config = state.savedConfig || {};
  const items = Object.entries(defs)
    .filter(([id]) => (area === "connection" ? id !== "seerr" && !connectionTouched(config[id]) : !metadataVisible(id, config[id])))
    .map(([id, def]) => ({ id, name: def.name, description: def.description }));
  openSettingsPickerModal({
    title: area === "connection" ? "Add Media Server" : "Add Metadata Provider",
    intro: area === "connection"
      ? "Plekt keeps watch history in sync across every connected server."
      : "Metadata providers enrich detail pages with artwork, ratings, and episode data.",
    items,
    onPick: (id) => openServiceEditModal(id),
  });
}

export function renderMediaServerCards() {
  renderMediaServerPanels();
  const seerrContainer = document.querySelector("#seerrPanel");
  if (!seerrContainer) return;
  const config = state.savedConfig || {};
  const seerrConfigured = connectionTouched(config.seerr);
  const status = document.querySelector("#seerrStatus");
  if (status) {
    status.textContent = seerrConfigured ? "Configured" : "Not configured";
    status.className = `status-pill status-${seerrConfigured ? "ready" : "muted"}`;
  }
  const options = buildServiceEditOptions("seerr");
  if (options) renderInlineServicePanel(seerrContainer, options);
}

// Global TVDB or TMDB choice for season and episode structure. The warning is
// the field help text, shown beside the control.
export const SEASON_SOURCE_FIELD = {
  key: "seasonSource",
  id: "metadata-season-source",
  label: "Season and episode structure",
  type: "choice",
  options: [
    { value: "tvdb", label: "TVDB", inlineDescription: "Default.", description: "Season and episode lists come from TheTVDB." },
    { value: "tmdb", label: "TMDB", description: "Season and episode lists come from The Movie Database." },
  ],
  help: "This affects future items only. Shows already in your library keep their current season and episode data.",
};

// Renders the season source choice under the metadata cards and saves it
// through the same /api/config route as the other settings.
export function renderSeasonSourceCard() {
  const fieldsContainer = document.querySelector("#seasonSourceFields");
  const form = document.querySelector("#seasonSourceForm");
  if (!fieldsContainer || !form) return;
  const current = state.savedConfig?.metadata?.seasonSource || "tvdb";
  fieldsContainer.innerHTML = renderFieldRow({ ...SEASON_SOURCE_FIELD, value: current });

  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  const statusEl = document.querySelector("#seasonSourceStatus");
  const setStatus = (text, tone = "muted") => {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
    statusEl.className = `message ${tone}`;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveButton = document.querySelector("#saveSeasonSourceButton");
    form.dataset.saving = "true";
    if (saveButton) saveButton.disabled = true;
    setStatus("Saving...", "muted");
    try {
      const values = collectFieldValues(fieldsContainer);
      await saveServiceConfig("metadata", { seasonSource: values[SEASON_SOURCE_FIELD.key] === "tmdb" ? "tmdb" : "tvdb" });
      setStatus("Saved.", "success");
    } catch (error) {
      setStatus(error?.message || "Save failed.", "error");
    } finally {
      delete form.dataset.saving;
      if (saveButton) saveButton.disabled = false;
    }
  });
}

export function renderMetadataCards() {
  renderAnidbSettings();
  const container = document.querySelector("#metadataProviderCards");
  if (!container) return;
  const config = state.savedConfig || {};
  const ids = Object.keys(METADATA_SERVICES);
  const openDetails = new Set([...container.querySelectorAll("details[open]")].map((detail) => detail.id));
  const badgeMarkup = (badges = []) => badges.map((badge) =>
    `<span class="status-pill status-${escapeAttribute(badge.tone || "muted")}">${escapeHtml(badge.label)}</span>`
  ).join("");

  container.innerHTML = ids.map((id) => {
    const def = METADATA_SERVICES[id];
    return `
      <details id="metadata-${escapeAttribute(id)}-details" class="sync-tool-details"${openDetails.has(`metadata-${id}-details`) ? " open" : ""}>
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>${escapeHtml(def.name)}</b>
          </div>
          ${badgeMarkup(metadataBadges(id, config[id]))}
          <span>${escapeHtml(def.description)}</span>
        </summary>
        <div id="metadata-${escapeAttribute(id)}-panel" class="tool-item-row"></div>
      </details>
    `;
  }).join("");

  ids.forEach((id) => {
    const panel = container.querySelector(`#metadata-${id}-panel`);
    const options = buildServiceEditOptions(id);
    if (panel && options) renderInlineServicePanel(panel, options);
  });
}

// Replaces the old populateConfigForm(): applies a freshly loaded redacted
// config to the settings UI (card grids + the global Seerr flag).
export function applyConfigToSettingsUi(config = {}) {
  state.seerrConfigured = Boolean(config.seerr?.configured);
  renderMediaServerCards();
  renderMetadataCards();
  renderSeasonSourceCard();
  renderSyncTuningCard();
  prepareHelpReadMore();
}
