import { state, elements } from "./state.js?v=2.1.1.0.10";
import { escapeHtml, escapeAttribute, platformIconMarkup } from "./utils.js?v=2.1.1.0.10";
import { SEASON_SOURCE_FIELD } from "./settings-services.js?v=2.1.1.0.10";
import { renderFieldRow } from "./settings-ui.js?v=2.1.1.0.10";
import { embyWebhookSetup, jellyfinWebhookSetup } from "./help-content.js?v=2.1.1.0.10";
import { PLEX_HISTORICAL_SYNC_CHOICES, PLEX_HISTORICAL_SYNC_LABEL } from "./plex-history-policy.js?v=2.1.1.0.10";

import { createOnboardingBackups } from "./onboarding-backups.js?v=2.1.1.0.10";

export function createOnboardingSections(context) {
const { backblazeDestination, renderBackblazeCard, renderBackup, updateBackupContinueAction, setPassphraseError, saveBackupSetup, saveBackblazeAction, testBackblazeAction } = createOnboardingBackups(context);
const { getStatus, getBackupData, MEDIA_SERVERS, WATCH_IMPORT_MODES, isPreClaimSetup, serverImportPending, watchlistSyncPending, seasonSourcePending, setupWatchImportMode, setupFastLocalPacing, setupUpNextSync, setupPlexHistoricalSync, currentStep, api, setMessage, loadBackupSetupData } = context;
function claimedAdminUsername() {
  const user = state.currentUser || {};
  return String(user.username || user.email || localStorage.getItem("adminUsername") || "admin").trim() || "admin";
}

function currentInstanceAddress() {
  try {
    return new URL("/", window.location.href).toString();
  } catch {
    return "";
  }
}

function renderOverviewClaim() {
  if (!isPreClaimSetup()) {
    const username = claimedAdminUsername();
    const address = currentInstanceAddress();
    return `
      <section class="setup-overview-claim setup-claim-claimed" aria-labelledby="setupClaimSummaryTitle">
        <p class="muted-copy setup-overview-claim-intro">Your administrator account is ready. Use these details to sign in to this Plekt instance.</p>
        <section class="setup-claim-panel setup-claim-summary" aria-labelledby="setupClaimSummaryTitle">
          <div class="setup-claim-panel-heading">
            <div>
              <h3 id="setupClaimSummaryTitle">Administrator account</h3>
              <p class="muted-copy">This instance is claimed and ready for the rest of onboarding.</p>
            </div>
            <span class="badge badge-success">Claimed</span>
          </div>
          <dl class="setup-claim-summary-list">
            <div>
              <dt>Username</dt>
              <dd>${escapeHtml(username)}</dd>
            </div>
            <div>
              <dt>Password</dt>
              <dd><span class="setup-claim-summary-status">Added</span><small>Stored securely and never shown here.</small></dd>
            </div>
            <div>
              <dt>Plekt address</dt>
              <dd>${address ? `<a href="${escapeAttribute(address)}">${escapeHtml(address)}</a>` : "<span>Current Plekt address</span>"}<small>Use this address to open Plekt on this computer.</small></dd>
            </div>
          </dl>
        </section>
      </section>`;
  }
  return `
    <section class="setup-overview-claim" aria-labelledby="setupClaimFormTitle">
      <div class="setup-overview-claim-heading">
        <h3 id="setupClaimFormTitle">Claim account</h3>
        <span class="badge badge-warning">Required</span>
      </div>
      <p class="muted-copy setup-overview-claim-intro">Create the administrator account for this local Plekt instance. Once it is claimed, the remaining setup steps unlock.</p>
      <div id="setupClaimFormHost" class="setup-claim-form-host"></div>
    </section>`;
}

const OVERVIEW_STEPS = [
  {
    title: "Trackers", tag: "Optional",
    detail: "Connect the watch trackers you use and choose which watch histories to import.",
  },
  {
    title: "Metadata", tag: "Recommended",
    detail: "A free TMDB key powers posters, cast, and episode details; TheTVDB and Fanart.tv work out of the box.",
  },
  {
    title: "Media Servers", tag: "Recommended",
    detail: "Connect a Plex, Emby, or Jellyfin server for automatic tracking, or skip and mark watches manually.",
  },
  {
    title: "Webhooks", tag: "Recommended",
    detail: "Plex updates instantly; Emby needs a quick webhook and Jellyfin needs the Plekt plugin for the same.",
  },
  {
    title: "Seerr", tag: "Optional",
    detail: "Connect Seerr for request status and one-click requests on detail pages.",
  },
  {
    title: "Backup", tag: "Optional",
    detail: "Encrypted local backups of your settings and watch history, with an optional off-server mirror.",
  },
  {
    title: "Import & sync", tag: "Optional",
    detail: "Import tracker and server history, plus optional Tautulli or Netflix one-time imports.",
  },
  {
    title: "Options", tag: "Recommended",
    detail: "Choose how app-marked watches are dated or reviewed, and optionally speed up trusted local-network sync.",
  },
];

function renderOverview() {
  return `
    ${renderOverviewClaim()}
    <p class="muted-copy setup-overview-intro">Set things up at your own pace. Everything here can be changed later in Settings, and your progress saves automatically.</p>
    <div class="settings-card-grid setup-overview-list">
      ${OVERVIEW_STEPS.map((item) => `
        <div class="settings-card setup-overview-item">
          <div class="setup-overview-item-heading">
            <b>${escapeHtml(item.title)}</b>
            <span class="badge${item.tag === "Required" ? " badge-warning" : ""}">${escapeHtml(item.tag)}</span>
          </div>
          <p class="muted-copy">${escapeHtml(item.detail)}</p>
          ${item.title === "Backup" ? `<button type="button" class="button-ghost setup-restore-backup-button" data-setup-restore-backup="1">Restore from backup</button>` : ""}
        </div>`).join("")}
    </div>`;
}

function serverStatusBadge(server) {
  if (server.tested) return `<span class="badge badge-success">Connected</span>`;
  if (server.connected) return `<span class="badge badge-warning">Saved, not tested</span>`;
  return `<span class="badge">Not connected</span>`;
}

function importState(provider) {
  return getStatus().onboarding.backgroundImports.servers[provider] || null;
}

function importStatusLine(importInfo) {
  if (!importInfo || importInfo.enabled === false) return "";
  if (importInfo.status === "importing") return `<p class="muted-copy setup-import-status-line">Importing... ${importInfo.itemCount ?? 0} items so far.</p>`;
  if (importInfo.status === "complete") return `<p class="muted-copy setup-import-status-line">Import complete: ${importInfo.itemCount ?? 0} items.</p>`;
  if (importInfo.status === "failed") return `<p class="muted-copy setup-import-status-line is-error">Import failed: ${escapeHtml(importInfo.error || "unknown error")}. <a href="#" data-setup-import-retry="1">Retry</a></p>`;
  return "";
}

const SERVER_BLURBS = {
  plex: "Connect your Plex account and pick your server.",
  emby: "Sign in with your Emby username and password.",
  jellyfin: "Use Quick Connect, or sign in directly.",
};

function trackerSyncStatusBanner() {
  const connected = getStatus().trackers.filter((tracker) => tracker.connected);
  if (!connected.length) return '<div class="guide-callout setup-trakt-sync-note">No watch tracker is connected. These imports will use each server’s watched dates.</div>';
  const importing = connected.filter(({ provider }) => {
    const info = getStatus().onboarding.backgroundImports.trackers?.[provider];
    return info?.enabled !== false && info?.status === "importing";
  });
  return `<div class="guide-callout setup-trakt-sync-note">${importing.length ? "Watch tracker imports are running. Server imports wait for all selected trackers, up to one shared 30-minute limit." : "Server imports use earlier watched dates from your connected trackers where available."}</div>`;
}

function renderServers() {
  const rows = MEDIA_SERVERS.map((provider) => {
    const server = getStatus().servers.find((s) => s.provider === provider);
    const importInfo = importState(provider);
    const checked = serverImportPending(provider);
    return `
      <div class="settings-card setup-server-row" data-setup-server="${provider}">
        <div class="setup-server-row-main">
          <div>
            <div class="setup-server-row-title">
              <span class="setup-server-name-group">
                ${platformIconMarkup(provider, "setup-server-type-icon", "setup-server-type-icon-set")}
                <b class="setup-server-name">${escapeHtml(server.serverName || provider)}</b>
              </span>
              ${serverStatusBadge(server)}
            </div>
          </div>
        </div>
        ${provider === "plex" ? `
          <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-top: var(--space-3);">
            <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
              Turn off "Refresh library metadata periodically"
            </b>
            <p style="margin: 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
              In Plex, under Settings &rarr; Scheduled Tasks. Its nightly run can reset watched items to unwatched, and Plekt would sync that to your other connected apps and trackers.
            </p>
          </div>
        ` : ""}
        ${provider === "plex" || server.tested ? `
          <div class="settings-choice-grid setup-server-toggles">
            ${provider === "plex" ? `
              <label class="settings-choice-option setup-toggle-box">
                <input type="checkbox" data-setup-watchlist-toggle ${watchlistSyncPending() ? "checked" : ""} />
                <span class="settings-choice-option-body">
                  <span class="settings-choice-option-title">Sync Watchlist with Plekt</span>
                  <span class="settings-choice-option-description settings-choice-option-description--block">Keeps your Plex watchlist and Plekt's watchlist aligned in both directions.</span>
                </span>
              </label>
            ` : ""}
            ${server.tested ? `
              <label class="settings-choice-option setup-toggle-box">
                <input type="checkbox" data-setup-import-toggle="${provider}" ${checked ? "checked" : ""} />
                <span class="settings-choice-option-body">
                  <span class="settings-choice-option-title">Import watched status from ${escapeHtml(server.serverName || provider)}</span>
                </span>
              </label>
            ` : ""}
          </div>
        ` : ""}
        <div class="setup-server-row-actions">
          <div class="setup-server-row-meta">
            ${server.baseUrl ? `
              <p class="muted-copy setup-server-detail">Server - ${escapeHtml(server.baseUrl)}</p>
              ${server.remoteUsername ? `<p class="muted-copy setup-server-detail">User - ${escapeHtml(server.remoteUsername)}</p>` : ""}
            ` : `<p class="muted-copy setup-server-detail">${SERVER_BLURBS[provider]}</p>`}
          </div>
          ${server.tested ? importStatusLine(importInfo) : ""}
          <button type="button" class="button-primary" data-setup-connect="${provider}">${server.connected ? "Edit connection" : "Set up"}</button>
        </div>
      </div>`;
  }).join("");
  return `
    <p class="muted-copy setup-step-intro">Connect and test at least one server to continue. You can connect more than one.</p>
    ${trackerSyncStatusBanner()}
    <div class="setup-server-rows">${rows}</div>`;
}

function renderMetadata() {
  const tmdbConfigured = getStatus().metadata.tmdbConfigured;
  const built = getStatus().metadata.builtInAvailable;
  return `
    <div class="setup-season-source" data-setup-season-source>${renderFieldRow({ ...SEASON_SOURCE_FIELD, label: "Choose your default metadata provider", help: "Chooses where season and episode numbers come from.", id: "setup-season-source", value: seasonSourcePending() })}</div>
    <div class="settings-card-grid setup-metadata-core-grid">
      <div class="settings-card setup-metadata-card">
        <div class="setup-metadata-titlerow"><b>TMDB</b><span class="setup-metadata-provider-status${tmdbConfigured ? " is-ok" : ""}">${tmdbConfigured ? "Configured" : "Not configured"}</span></div>
        <p class="muted-copy setup-metadata-provider-desc">Required. Posters, backdrops, episode details, and search.</p>
        <div class="setup-metadata-actions">
          <button type="button" class="button-ghost" data-setup-connect="tmdb">${tmdbConfigured ? "Edit" : "Add TMDB key"}</button>
          <a class="button-ghost" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Get a free TMDB key</a>
        </div>
      </div>
      <div class="settings-card">
        <div class="setup-metadata-titlerow"><b>TheTVDB</b><span class="setup-metadata-provider-status${built.tvdb ? " is-ok" : ""}">${built.tvdb ? "Using built-in access" : "Not configured"}</span></div>
        <p class="muted-copy setup-metadata-provider-desc">Episode ordering and air dates - more accurate season/episode numbering than TMDB alone.</p>
        <button type="button" class="button-ghost" data-setup-connect="tvdb">Add personal key</button>
      </div>
    </div>
    <div class="setup-metadata-optional">
      <div class="settings-card-grid setup-metadata-optional-grid">
        <div class="settings-card">
          <div class="setup-metadata-titlerow"><b>Fanart.tv</b><span class="setup-metadata-provider-status${built.fanart ? " is-ok" : ""}">${built.fanart ? "Using built-in access" : "Not configured"}</span></div>
          <p class="muted-copy setup-metadata-provider-desc">Fallback posters, backdrops, and logos when TMDB has no artwork for a title.</p>
          <button type="button" class="button-ghost" data-setup-connect="fanart">Add personal key</button>
        </div>
        <div class="settings-card">
          <b>OMDb</b>
          <p class="muted-copy setup-metadata-provider-desc">IMDb ratings shown next to the TMDB score on movie pages. Free key, 1,000 requests/day.</p>
          <button type="button" class="button-ghost" data-setup-connect="omdb">Add key</button>
        </div>
        <div class="settings-card">
          <b>YouTube</b>
          <p class="muted-copy setup-metadata-provider-desc">Trailer titles, descriptions, and durations for the trailer player.</p>
          <button type="button" class="button-ghost" data-setup-connect="youtube">Add key</button>
        </div>
      </div>
    </div>`;
}

function webhookGuideFor(provider, ack = null) {
  const options = { ack, confirmationAttr: "data-setup-webhook-ack", namePrefix: "setup-" };
  if (provider === "emby") return embyWebhookSetup(options);
  return jellyfinWebhookSetup(options);
}

function webhookSetupRequired(provider) {
  return provider === "emby" || provider === "jellyfin";
}

function webhookProviderName(provider) {
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  return "Jellyfin";
}

function renderWebhooks() {
  const testedServers = getStatus().servers.filter((s) => s.tested);
  // Show every provider's guide up front rather than gating it behind an
  // actual connection - people want to read what a webhook setup involves
  // (or learn Plex needs none at all) while they're still deciding which
  // servers to connect, not only after coming back to this step later.
  const rowServers = MEDIA_SERVERS.map((provider) => (
    testedServers.find((s) => s.provider === provider) || { provider, tested: false, serverName: "" }
  ));
  const cards = rowServers.map((server) => {
    const requiresSetup = webhookSetupRequired(server.provider);
    const ack = getStatus().onboarding.acknowledgements.webhooks?.[server.provider] || null;
    const acked = Boolean(ack);
    const ackMethod = ack?.method === "plugin" || ack?.method === "webhook" ? ack.method : "";
    const ackBadge = ackMethod === "plugin"
      ? "Plugin - Connected"
      : ackMethod === "webhook"
        ? "Webhook - Connected"
        : "Configured";
    const title = `<span class="setup-webhook-title"><b>${escapeHtml(webhookProviderName(server.provider))}</b>${server.tested ? `<span>&nbsp;- ${escapeHtml(server.serverName || `${webhookProviderName(server.provider)} server`)}</span>` : ""}</span>`;
    if (!requiresSetup) {
      return `
        <section class="settings-card setup-webhook-row setup-webhook-row--automatic" data-setup-webhook-provider="${escapeHtml(server.provider)}">
          <div class="setup-webhook-row-heading">
            ${title}
            <p class="setup-webhook-automatic-copy"><b>No webhook setup required.</b> Plekt checks Plex every minute.</p>
            <span class="badge badge-success">Automatic</span>
          </div>
          <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-top: 0;">
            <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
              Turn off "Refresh library metadata periodically"
            </b>
            <p style="margin: 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
              In Plex, under Settings &rarr; Scheduled Tasks. Its nightly run can reset watched items to unwatched, and Plekt would sync that to your other connected apps and trackers.
            </p>
          </div>
        </section>`;
    }
    return `
      <details class="settings-card setup-webhook-row setup-webhook-accordion" data-setup-webhook-provider="${escapeHtml(server.provider)}">
        <summary class="setup-webhook-row-heading">
          <span class="setup-webhook-summary-main">
            <span class="setup-webhook-chevron" aria-hidden="true">›</span>
            ${title}
          </span>
          ${acked ? `<span class="badge badge-success">${escapeHtml(ackBadge)}</span>` : server.tested ? `<span class="badge badge-warning">Setup needed</span>` : `<span class="badge">Not connected yet</span>`}
        </summary>
        <div class="setup-webhook-accordion-body">
          ${webhookGuideFor(server.provider, ack)}
        </div>
      </details>`;
  }).join("");
  return `
    <p class="muted-copy setup-step-intro">Plex is automatic. Emby needs a webhook and Jellyfin needs the Plekt plugin for instant updates. See <a href="/#help/webhooks">the webhook guide</a>.</p>
    <div class="setup-webhook-rows">${cards}</div>`;
}

function renderSeerr() {
  const configured = Boolean(getStatus().seerr?.configured || state.savedConfig?.seerr?.configured);
  return `
    <p class="muted-copy setup-step-intro">Optional. Connect Seerr so movie and TV pages can show request status and a one-click Request action. You can skip this and set it up later from Settings.</p>
    <div class="settings-card-grid setup-seerr-grid">
      <div class="settings-card setup-metadata-card">
        <div class="setup-metadata-titlerow"><b>Seerr</b><span class="setup-metadata-provider-status${configured ? " is-ok" : ""}">${configured ? "Configured" : "Not configured"}</span></div>
        <p class="muted-copy setup-metadata-provider-desc">Live request status and Request on Seerr on detail pages.</p>
        <div class="setup-metadata-actions">
          <button type="button" class="button-ghost" data-setup-connect="seerr">${configured ? "Edit" : "Connect Seerr"}</button>
        </div>
      </div>
    </div>`;
}

function renderImports() {
  const rows = [];
  for(const entry of Object.values(getStatus().onboarding.backgroundImports.oneTime||{})) {
    if(entry.enabled===false||entry.status!=='failed')continue;
    const source=entry.source==='netflix'?'Netflix':'Tautulli';
    rows.push(`<div class="setup-import-row"><div class="setup-import-source"><b>${source}</b></div><div class="setup-import-result"><p class="is-error">Import failed. Retry below, or <button type="button" class="button-ghost" data-setup-one-time-skip="${escapeAttribute(entry.source)}">Skip failed import</button> to let initial sync continue.</p></div></div>`);
  }
  for (const tracker of getStatus().trackers.filter((entry) => entry.connected)) {
    rows.push(importProgressRow(tracker.provider, tracker.label, getStatus().onboarding.backgroundImports.trackers?.[tracker.provider]));
  }
  for (const provider of MEDIA_SERVERS.filter((p) => getStatus().servers.find((s) => s.provider === p)?.tested)) {
    const server = getStatus().servers.find((entry) => entry.provider === provider);
    const info = importState(provider);
    // The coordinator persists the shared tracker wait server-side. A selected
    // import can have no item count until the media-server pull begins.
    rows.push(importProgressRow(provider, server?.serverName || provider, info, serverImportPending(provider)));
  }
  return `
    <p class="muted-copy setup-step-intro">Import watch history from connected trackers and media servers. Optionally add Tautulli or a Netflix viewing-activity CSV below - same tools as Settings → Connections → One Time Imports. Background imports keep running if you continue.</p>
    <div class="guide-callout setup-import-note">Continue starts initial sync after your selected imports finish. Plekt adds missing watches to your connected trackers and media servers. Progress stays available above Sync / Idle.</div>
    <div class="setup-import-list">${rows.join("") || `<p class="muted-copy">No tracker or media-server imports were requested. Plekt will track new activity from this point forward.</p>`}</div>
    <section class="setup-one-time-imports" aria-labelledby="setupOneTimeImportsTitle">
      <div class="setup-options-heading">
        <b id="setupOneTimeImportsTitle">One Time Imports</b>
        <p class="muted-copy">Optional. Import completed plays from Tautulli or Netflix viewing activity. Skip either if you do not use them.</p>
      </div>
      <div id="setupOneTimeImportsHost" class="setup-one-time-imports-host"></div>
    </section>`;
}

function renderOptions() {
  const selectedMode = setupWatchImportMode();
  const fastLocalPacing = setupFastLocalPacing();
  const upNextSync = setupUpNextSync();
  const plexHistoricalSync = setupPlexHistoricalSync();
  const plexConnected = (getStatus()?.servers || []).some((server) => server.provider === "plex" && (server.connected || server.tested));
  return `
    <div class="setup-options-fields">
      ${plexConnected ? `
      <section class="settings-card setup-options-card setup-options-policy">
        <div class="setup-options-heading">
          <b>${escapeHtml(PLEX_HISTORICAL_SYNC_LABEL)}</b>
          <p class="muted-copy">Choose whether older watched items are sent to Plex.</p>
        </div>
        <div class="settings-choice-grid setup-options-radio-grid" role="radiogroup" aria-label="${escapeAttribute(PLEX_HISTORICAL_SYNC_LABEL)}">
          ${PLEX_HISTORICAL_SYNC_CHOICES.map((option) => `
            <label class="settings-choice-option">
              <input type="radio" name="setup-plex-historical-sync" value="${escapeAttribute(option.value)}" data-setup-plex-historical-sync="1" ${plexHistoricalSync === (option.value === "on") ? "checked" : ""} />
              <span class="settings-choice-option-body${option.inlineDescription ? " settings-choice-option-body--inline" : ""}">
                <span class="settings-choice-option-title">${escapeHtml(option.label)}</span>
                ${option.inlineDescription ? `<span class="settings-choice-option-description settings-choice-option-description--inline">${escapeHtml(option.inlineDescription)}</span>` : ""}
                ${(option.descriptionLines || [option.description]).map((line) => `<span class="settings-choice-option-description settings-choice-option-description--block">${escapeHtml(line)}</span>`).join("")}
              </span>
            </label>`).join("")}
        </div>
      </section>
      ` : ""}
      <section class="settings-card setup-options-card setup-options-policy">
        <div class="setup-options-heading">
          <b>When you manually mark an item as watched in Plex / Emby / Jellyfin</b>
          <p class="muted-copy">Choose whether Plekt dates the watch automatically or sends it to Manual Watch review.</p>
        </div>
        <div class="settings-choice-grid setup-options-radio-grid" role="radiogroup" aria-label="When you manually mark an item as watched in Plex / Emby / Jellyfin">
          ${WATCH_IMPORT_MODES.map((option) => `
            <label class="settings-choice-option">
              <input type="radio" name="setup-watch-import-mode" value="${escapeAttribute(option.value)}" data-setup-watch-import-mode="1" ${selectedMode === option.value ? "checked" : ""} />
              <span class="settings-choice-option-body">
                <span class="settings-choice-option-title">${escapeHtml(option.label)}</span>
                <span class="settings-choice-option-description">${escapeHtml(option.description)}</span>
              </span>
            </label>`).join("")}
        </div>
      </section>
      <section class="settings-card setup-options-card setup-options-policy">
        <div class="setup-options-heading"><b>Other options</b></div>
        <div class="settings-choice-grid setup-options-radio-grid">
          <label class="settings-choice-option">
            <input type="checkbox" data-setup-fast-local-sync="1" ${fastLocalPacing ? "checked" : ""} />
            <span class="settings-choice-option-body">
              <span class="settings-choice-option-title">Fast Local-Network Sync</span>
              <span class="settings-choice-option-description">Speed up bulk sync when Plekt and all media apps are on the same trusted local network. Leave this off for public or mixed networks.</span>
            </span>
          </label>
          <label class="settings-choice-option">
            <input type="checkbox" data-setup-up-next-sync="1" ${upNextSync ? "checked" : ""} />
            <span class="settings-choice-option-body">
              <span class="settings-choice-option-title">Sync Up Next to media apps</span>
              <span class="settings-choice-option-description">Keep Plex and Emby's Continue Watching and Jellyfin's Next Up in sync with Plekt's Up Next queue. Turn this off to leave media app lists unchanged.</span>
            </span>
          </label>
        </div>
      </section>
    </div>`;
}

function importProgressBar(status) {
  if (status === "importing") return `<div class="setup-import-progress" role="progressbar" aria-label="Importing"><div class="setup-import-progress-fill is-indeterminate"></div></div>`;
  if (status === "complete") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-complete" style="width:100%"></div></div>`;
  if (status === "failed") return `<div class="setup-import-progress"><div class="setup-import-progress-fill is-failed" style="width:100%"></div></div>`;
  return "";
}

function importProgressRow(provider, name, info, pending = false) {
  const providerLabel = getStatus().trackers.find((tracker) => tracker.provider === provider)?.label || webhookProviderName(provider);
  // A selected server import can still be waiting for the tracker gate.
  const status = info?.enabled === false ? "not_requested" : (info?.status || (pending ? "importing" : "not_started"));
  let badge = `<span class="badge">Not requested</span>`;
  let detail = "This source was not selected for import.";
  if (status === "importing") {
    // A null count means the server pull has not started yet.
    const waitingOnTrackers = MEDIA_SERVERS.includes(provider) && info?.itemCount == null && Object.values(getStatus().onboarding.backgroundImports.trackers || {}).some((entry) => entry?.enabled !== false && entry?.status === "importing");
    badge = `<span class="badge badge-warning">${waitingOnTrackers ? "Waiting" : "Importing"}</span>`;
    detail = waitingOnTrackers
      ? "Waiting for watch tracker imports to complete."
      : (info?.itemCount == null ? "Fetching watch history in the background." : `${info.itemCount} items imported so far.`);
  } else if (status === "complete") {
    badge = `<span class="badge badge-success">Complete</span>`;
    detail = info.itemCount == null ? "Watch history import finished." : `${info.itemCount} items imported.`;
  } else if (status === "failed") {
    badge = `<span class="badge badge-error">Failed</span>`;
    detail = `${escapeHtml(info.error || "The import could not be completed.")} <a href="#" data-setup-import-retry="1">Retry</a>`;
  } else if (status === "cancelled") {
    badge = `<span class="badge">Cancelled</span>`;
    detail = "The import was cancelled.";
  }
  return `
    <div class="setup-import-row" data-setup-server="${escapeHtml(provider)}">
      <div class="setup-import-source"><b>${escapeHtml(providerLabel)}</b><span>&nbsp;- ${escapeHtml(name)}</span></div>
      <div class="setup-import-result">
        <div class="setup-import-result-head">${badge}<span class="muted-copy">${detail}</span></div>
        ${importProgressBar(status)}
      </div>
    </div>`;
}

function renderReview(hasTestedServer) {
  const s = getStatus();
  const testedServers = s.servers.filter((server) => server.tested);
  const requiredWebhookServers = testedServers.filter((server) => webhookSetupRequired(server.provider));
  const webhooksReady = requiredWebhookServers.every((server) => s.onboarding.acknowledgements.webhooks?.[server.provider]);
  const imports = [
    ...Object.values(s.onboarding.backgroundImports.servers || {}),
    ...Object.values(s.onboarding.backgroundImports.trackers || {}),
  ].filter((entry) => entry?.enabled !== false && entry?.status !== "not_started");
  const completedImports = imports.filter((entry) => entry.status === "complete").length;
  const runningImports = imports.filter((entry) => entry.status === "importing").length;
  const backupConfig = getBackupData()?.plembfin?.config || {};
  const rows = [
    { label: "Account security", detail: "Administrator account secured", status: "Ready", tone: "success" },
    {
      label: "Media Servers",
      detail: testedServers.map((server) => server.serverName || webhookProviderName(server.provider)).join(", ") || "None connected - tracking will be manual",
      status: `${testedServers.length} connected`, tone: testedServers.length ? "success" : "warning",
    },
    {
      label: "Metadata", detail: s.metadata.tmdbConfigured ? "TMDB is configured for artwork and discovery" : "TMDB has not been configured",
      status: s.metadata.tmdbConfigured ? "Configured" : "Not configured", tone: s.metadata.tmdbConfigured ? "success" : "muted",
    },
    {
      label: "Updates", detail: webhooksReady ? "Plex automatic updates and configured server webhooks are ready" : "An Emby or Jellyfin webhook still needs confirmation",
      status: webhooksReady ? "Ready" : "Setup pending", tone: webhooksReady ? "success" : "warning",
    },
    {
      label: "Trackers", detail: s.trackers.filter((tracker) => tracker.connected).map((tracker) => `${tracker.label}${tracker.username ? ` as ${tracker.username}` : ""}`).join(", ") || "Watch tracker connections were skipped",
      status: s.trackers.some((tracker) => tracker.connected) ? "Connected" : "Optional", tone: s.trackers.some((tracker) => tracker.connected) ? "success" : "muted",
    },
    {
      label: "Seerr",
      detail: s.seerr?.configured || state.savedConfig?.seerr?.configured
        ? "Media requests from detail pages are available"
        : "Not configured - can be added later in Settings",
      status: s.seerr?.configured || state.savedConfig?.seerr?.configured ? "Configured" : "Optional",
      tone: s.seerr?.configured || state.savedConfig?.seerr?.configured ? "success" : "muted",
    },
    {
      label: "Imports",
      detail: runningImports ? `${runningImports} import${runningImports === 1 ? " is" : "s are"} still running in the background` : (imports.length ? "Selected watch-history imports finished" : "No history imports were requested"),
      status: runningImports ? `${runningImports} running` : `${completedImports} complete`, tone: runningImports ? "warning" : "success",
    },
    {
      label: "Options",
      detail: `${WATCH_IMPORT_MODES.find((option) => option.value === setupWatchImportMode())?.label || "Require review"}; fast local-network sync ${setupFastLocalPacing() ? "enabled" : "off"}`,
      status: "Saved", tone: "success",
    },
    {
      label: "Backups",
      detail: backupConfig.enabled
        ? `Daily encrypted backup at ${backupConfig.time || "03:00"}${backupConfig.remoteEnabled ? ", mirrored to Backblaze B2" : ", stored locally"}`
        : "Not scheduled; this can be configured later in Settings",
      status: backupConfig.enabled ? "Scheduled" : "Optional", tone: backupConfig.enabled ? "success" : "muted",
    },
  ];
  return `
    <div class="setup-review-lead ${hasTestedServer ? "is-ready" : "is-optional"}">
      <span class="setup-review-mark" aria-hidden="true">${hasTestedServer ? "✓" : "!"}</span>
      <div><b>${hasTestedServer ? "Plekt is ready" : "Ready when you are"}</b><p>${hasTestedServer ? "Review your connections and open the dashboard when everything looks right." : "No media server is connected, so watches will need to be marked manually from search. Finish now and connect one anytime from Settings, or go back to add one first."}</p></div>
    </div>
    <div class="setup-review-list">
      ${rows.map((row) => `
        <div class="setup-review-row">
          <div class="setup-review-copy"><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.detail)}</span></div>
          <span class="badge ${row.tone === "success" ? "badge-success" : row.tone === "warning" ? "badge-warning" : row.tone === "error" ? "badge-error" : ""}">${escapeHtml(row.status)}</span>
        </div>`).join("")}
    </div>`;
}


return { renderOverview, renderServers, renderMetadata, renderWebhooks, renderSeerr, renderImports, renderOptions, renderBackup, renderReview, updateBackupContinueAction, setPassphraseError, saveBackupSetup, saveBackblazeAction, testBackblazeAction, backblazeDestination, renderBackblazeCard, webhookSetupRequired, importState };
}
