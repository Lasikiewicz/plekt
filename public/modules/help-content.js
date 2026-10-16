import { getWebhookToken } from "./auth.js?v=2.0.0.3.5";
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.0.0.3.5";

function snippet(code, language = "text") {
  const trimmed = String(code).trim();
  return `
    <div class="copy-block">
      <button class="copy-button" type="button" data-copy="${escapeAttribute(trimmed)}" aria-label="Copy ${escapeHtml(language)} snippet">Copy</button>
      <pre><code>${escapeHtml(trimmed)}</code></pre>
    </div>
  `;
}

function terminalOutput(text) {
  return `<pre class="terminal-output"><code>${escapeHtml(text)}</code></pre>`;
}

export function adminTokenGuide() {
  return `
    <div class="credential-guide" style="display: grid; gap: var(--space-3);">
      <p style="margin: 0; color: var(--muted); font-size: 0.85rem; line-height: 1.5;">
        The local username and password for this self-hosted instance.
      </p>
      <ol style="display: grid; gap: var(--space-2); margin: 0; padding-left: 1.2rem; line-height: 1.5; font-size: 0.82rem; color: var(--text);">
        <li><b>Default credentials:</b> Username is <code>admin</code> on first run. If <code>ADMIN_PASSWORD</code> isn't set, a random password is generated and printed once to the server console.</li>
        <li><b>Environment overrides:</b> Set <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> as environment variables (for example, in <code>docker-compose.yml</code>) to override a fresh install.</li>
        <li><b>In-app management:</b> Once you change credentials in Settings, Plekt manages them itself and stops reading the environment variables.</li>
        <li><b>Webhook secrets:</b> A separate secret token, not this password, is what secures webhooks. Rotate it any time without affecting your admin login.</li>
      </ol>
    </div>
  `;
}

export function plexCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>PLEX_URL and PLEX_TOKEN Credential Extraction</b>
      <h3>Finding your PLEX_URL</h3>
      <ul>
        <li>If Plex is running on the same computer or local network, it usually defaults to <code>http://127.0.0.1:32400</code> or <code>http://localhost:32400</code>.</li>
        <li>If Plex is running on another machine, use that server's local IP address with port <code>32400</code>, such as <code>http://192.168.1.50:32400</code>.</li>
        <li>If you use a secure remote domain like <code>https://plex.example.com</code>, confirm it by opening Plex Web and checking the browser URL bar while connected to your server.</li>
        <li>You can also confirm the advertised LAN and remote addresses in Plex server network settings.</li>
      </ul>
      <h3>Finding your PLEX_TOKEN</h3>
      <ol>
        <li>Open a web browser, go to your Plex Web App, and sign in.</li>
        <li>Navigate to any library item, either a movie or a specific TV episode.</li>
        <li>Click the vertical ellipsis <code>...</code> button to open the context menu.</li>
        <li>Click <b>Get Info</b> from the menu.</li>
        <li>In the bottom-right corner of the pop-up modal, click the <b>View XML</b> text link.</li>
        <li>A new browser tab will open displaying raw XML code. Look at the address bar at the very top of your browser.</li>
        <li>Scroll to the absolute end of the URL string and locate <code>X-Plex-Token=</code>. Copy the exact alphanumeric string that follows it.</li>
        <li><b>Warning:</b> keep this private and do not commit it to public git history.</li>
      </ol>
    </div>
  `;
}

export function embyCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>EMBY_URL, EMBY_API_KEY, and EMBY_USER_ID Credential Extraction</b>
      <h3>Finding your EMBY_URL</h3>
      <ul>
        <li>If Emby is running locally, it is usually <code>http://localhost:8096</code>.</li>
        <li>If Emby is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://emby.example.com</code>.</li>
      </ul>
      <h3>Generating your EMBY_API_KEY</h3>
      <ol>
        <li>Open your Emby Server web dashboard as an administrator.</li>
        <li>Click the gear icon in the top right to access <b>Server Settings</b>.</li>
        <li>In the left-hand sidebar, scroll down to the <b>Advanced</b> section and click <b>API Keys</b>.</li>
        <li>Click the <b>New API Key</b> button.</li>
        <li>Enter an app name identifier, for example <code>Plekt Tracker</code>, and click OK.</li>
        <li>Copy the newly generated long character string from the table.</li>
      </ol>
      <h3>Finding your EMBY_USER_ID</h3>
      <ol>
        <li>In the Emby Server Settings left sidebar, click <b>Users</b>.</li>
        <li>Click on your active user account profile.</li>
        <li>Look at your browser's address bar URL.</li>
        <li>Extract the string value following <code>?userId=</code>. This is your unique identifier string.</li>
      </ol>
    </div>
  `;
}

export function jellyfinCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>JELLYFIN_URL, JELLYFIN_API_KEY, and JELLYFIN_USER_ID Credential Extraction</b>
      <h3>Finding your JELLYFIN_URL</h3>
      <ul>
        <li>If Jellyfin is running locally, it defaults to <code>http://localhost:8096</code> or <code>http://127.0.0.1:8096</code>.</li>
        <li>If Jellyfin is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://jellyfin.example.com</code>.</li>
      </ul>
      <h3>Generating your JELLYFIN_API_KEY</h3>
      <ol>
        <li>Open your Jellyfin Dashboard using an administrator profile.</li>
        <li>Select the <b>Dashboard</b> menu option under the <b>Administration</b> section.</li>
        <li>Scroll down the left settings panel until you reach the <b>Advanced</b> header and select <b>API Keys</b>.</li>
        <li>Click the <code>+</code> icon button to generate a token. Name it <code>Plekt Bridge</code>.</li>
        <li>Instantly copy the resulting string.</li>
      </ol>
      <h3>Finding your JELLYFIN_USER_ID</h3>
      <ol>
        <li>Go to your Jellyfin Dashboard settings page.</li>
        <li>Under the <b>Administration</b> header, click <b>Users</b>.</li>
        <li>Select your primary user profile card.</li>
        <li>Inspect the browser address bar. The long alphanumeric string right after <code>/users?userId=</code> is your true Jellyfin User ID.</li>
      </ol>
    </div>
  `;
}

export function traktBridgeGuide() {
  return `
    <div class="credential-guide" style="display: grid; gap: var(--space-3);">
      <div class="guide-callout">
        <b>Let Plekt be the only Trakt bridge</b>
        <p style="margin: var(--space-1) 0 0;">The live connection reads and writes Trakt directly. A watched or unwatched change made in Trakt, Plex, Emby, Jellyfin, or Plekt is then distributed to every other connected service. Running an Emby or Jellyfin Trakt plugin at the same time creates a second writer and can restore stale state.</p>
      </div>

      <details class="sync-tool-details" open>
        <summary class="accordion-header">
          <div class="sync-tool-summary-title"><b>Connect Trakt directly</b></div>
          <span>Use the server app and approve the device code</span>
        </summary>
        <div class="tool-item-row" style="display: grid; gap: var(--space-2);">
          <ol>
            <li>Choose <b>Connect Trakt</b>. Plekt uses its built-in Trakt device application, so normal users do not need Trakt VIP or their own API application.</li>
            <li>Visit the displayed Trakt activation link, enter the device code, and approve access. Plekt encrypts your access and refresh tokens at rest.</li>
            <li>A server administrator can replace the built-in application with <code>TRAKT_CLIENT_ID</code> and <code>TRAKT_CLIENT_SECRET</code>. If it is unavailable, a Trakt VIP developer can expand <b>Use a personal Trakt app</b>.</li>
          </ol>
        </div>
      </details>

      <details class="sync-tool-details">
        <summary class="accordion-header">
          <div class="sync-tool-summary-title"><b>Disable the old media-server bridges</b></div>
          <span>Prevent duplicate writers and authority loops</span>
        </summary>
        <div class="tool-item-row" style="display: grid; gap: var(--space-2);">
          <ul>
            <li><b>Emby:</b> disable the Trakt plugin or remove its authorization, then disable every Trakt scheduled task. Turning off only scheduled history is insufficient because realtime scrobbling can still write.</li>
            <li><b>Jellyfin:</b> choose <b>De-authorize Device</b> in the Trakt plugin, or disable the plugin. At minimum turn off live scrobbling, instant watched/unwatched, and both watched-state scheduled tasks.</li>
            <li>Plex needs no plugin. Plekt sends Plex changes to Trakt itself.</li>
          </ul>
        </div>
      </details>

      <div class="guide-callout">
        <b>Choose the first-connection mode</b>
        <p style="margin: var(--space-1) 0 0;"><b>Use “Start from current state”</b> when your media servers already have watch history, or you are not sure which service is complete. Plekt records Trakt's current state as a baseline without sending existing Trakt watches to Plex, Emby, or Jellyfin. Future changes still sync.</p>
        <p style="margin: var(--space-1) 0 0;"><b>Use “Import all existing Trakt watched state”</b> when Trakt is your trusted source, your other servers are new or empty, or you are migrating to Plekt. It imports Trakt's existing history and queues matching items as watched on your connected servers.</p>
        <p style="margin: var(--space-1) 0 0;">This imports watched state, not every historical play date into each media server. Plekt keeps Trakt play dates and rewatches in its own history, while Plex, Emby, and Jellyfin typically receive watched/unwatched updates.</p>
        <p style="margin: var(--space-1) 0 0;"><b>Rule of thumb:</b> keep the safe default unless you intentionally want Trakt to populate the other servers.</p>
      </div>
      <p class="tool-accordion-desc" style="margin: 0;"><b>After the first connection:</b> Plekt checks the complete Trakt snapshot each minute; additions become watched actions and removals become unwatched actions. <b>Sync Now</b> is a safe repair pass: it restores missing watched state from Trakt, but never treats a partial Trakt response as a bulk unwatch. While it runs, the connection card shows progress and changes the action to “Syncing”; completion reports how many Trakt items were checked and how many changes were applied.</p>
    </div>
  `;
}

export function buildWebhookUrl() {
  const token = getWebhookToken();
  const base = `${window.location.origin}/api/webhook`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function embyWebhookSetup() {
  const url = buildWebhookUrl();
  return `
    <div class="webhook-guide-content" style="display: grid; gap: var(--space-2); padding-top: var(--space-1);">
      <div class="copy-block">
        <button class="copy-button" type="button" data-copy="${escapeAttribute(url)}" aria-label="Copy Webhook URL">Copy</button>
        <pre><code>${escapeHtml(url)}</code></pre>
      </div>
      <p style="font-size: 0.78rem; color: var(--muted); margin: 0;">Automation clients can also call <code>/api/webhook</code> with an <code>X-Plekt-Webhook-Secret</code> or <code>Authorization: Bearer</code> header.</p>
      <ul class="webhook-instruction-list">
        <li>Go to Emby Preferences ➔ <b>Notifications</b> ➔ <b>Webhooks</b> and add a new webhook pointing to the URL above.</li>
        <li>Under <b>Events → Playback</b>, check:
          <ul class="webhook-option-list">
            <li><code>Start</code> <span>Detects when playback begins.</span></li>
            <li><code>Pause</code> <span>Saves the current resume position when playback pauses.</span></li>
            <li><code>Unpause</code> <span>Continues resume tracking when playback restarts.</span></li>
            <li><code>Stop</code> <span>Records the final position and evaluates watched status.</span></li>
          </ul>
        </li>
        <li>Under <b>Events → Users</b>, check:
          <ul class="webhook-option-list">
            <li><code>Mark Played</code> <span>Detects items manually marked as watched.</span></li>
            <li><code>Mark Unplayed</code> <span>Detects items manually marked as unwatched.</span></li>
          </ul>
        </li>
        <li>Leave every other event category unticked. Plekt ignores library, system, and activity events, and they only add rejected entries to Sync History.</li>
        <li>Enable <b>Send All Properties</b> so payloads include <code>PlaybackPositionTicks</code> for resume sync.</li>
      </ul>
    </div>
  `;
}

export function jellyfinWebhookSetup() {
  const url = buildWebhookUrl();
  return `
    <div class="webhook-guide-content" style="display: grid; gap: var(--space-2); padding-top: var(--space-1);">
      <div class="copy-block">
        <button class="copy-button" type="button" data-copy="${escapeAttribute(url)}" aria-label="Copy Webhook URL">Copy</button>
        <pre><code>${escapeHtml(url)}</code></pre>
      </div>
      <p style="font-size: 0.78rem; color: var(--muted); margin: 0;">Automation clients can also call <code>/api/webhook</code> with an <code>X-Plekt-Webhook-Secret</code> or <code>Authorization: Bearer</code> header.</p>
      <ul class="webhook-instruction-list">
        <li>Install the <b>Webhooks</b> plugin in the Jellyfin Dashboard (Plugins → Catalog).</li>
        <li>Add a new <b>Generic Webhook</b> named <code>plekt</code> pointing to the URL above. Check <b>Enable</b>.</li>
        <li>Under <b>Notification Type</b>, check:
          <ul class="webhook-option-list">
            <li><code>Playback Start</code> <span>Required to detect when media starts playing.</span></li>
            <li><code>Playback Progress</code> <span>Required to keep resume progress up to date while media plays.</span></li>
            <li><code>Playback Stop</code> <span>Required to save the final position and evaluate watched status.</span></li>
            <li><code>User Data Saved</code> <span>Detects items manually marked as watched or unwatched.</span></li>
            <li><code>Item Added</code> <span>Optional. Applies Plekt's existing watched state when new media is added to Jellyfin.</span></li>
          </ul>
        </li>
        <li>Under <b>Item Type</b>, select:
          <ul class="webhook-option-list">
            <li><code>Movies</code> <span>Enables movie playback and watch-state updates.</span></li>
            <li><code>Episodes</code> <span>Enables episode playback and watch-state updates.</span></li>
          </ul>
        </li>
        <li>Leave every other notification type and item type unticked. Plekt ignores them.</li>
        <li>Check <b>Send All Properties (ignores template)</b> so resume position fields are included.</li>
        <li>The body has to be JSON, but the content type does not matter - Jellyfin labels its payloads <code>text/plain</code> and Plekt reads them anyway. A body that is not JSON is logged in Sync History as <code>Unsupported webhook content type</code>, along with the sender that posted it.</li>
      </ul>
    </div>
  `;
}

export function webhookWarning() {
  return `
    <div class="guide-callout warning-callout" style="gap: var(--space-3); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08);">
      <b style="font-size: 1.1rem; color: var(--yellow);">Webhook Setup & Unwatched Sync Guide</b>
      <p>Configure your media servers to send played and unplayed/unwatched events to your Plekt webhook URL:</p>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #eab308;"></span>
          1. Plex Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Plex does not support sending unwatched (unscrobble) events via native webhooks or Tautulli.</li>
          <li>For resume sync, Plex webhook traffic must include playback lifecycle events such as <code>media.play</code>, <code>media.resume</code>, <code>media.pause</code>, <code>media.stop</code>, and <code>media.scrobble</code>. Plekt reads <code>viewOffset</code> and <code>duration</code> when Plex provides them.</li>
          <li><b>Real-time Sync (Built-in):</b> Plekt's server includes a built-in Plex notification listener. It connects to your Plex Media Server via the WebSocket notification channel (configured automatically from your Plex URL and token in Settings → Media Servers), records watched and unwatched library changes, and expands bulk show or season changes into their episodes for propagation - no external script or daemon is required.</li>
          <li><b>Per-Minute Scheduler:</b> Plekt's background worker runs every minute to process playback sessions, evaluate watched thresholds, and dispatch sync actions.</li>
          <li>For general playback events, set up webhooks according to the <a href="https://support.plex.tv/articles/115002267687-webhooks/?utm_campaign=Plex%20Apps&utm_medium=Plex%20Web&utm_source=Plex%20Apps" target="_blank" rel="noopener noreferrer" style="color: #4b96e6; text-decoration: underline;">Plex Webhook Documentation</a>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #10b981;"></span>
          2. Emby Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>In Emby Server Settings ➔ <b>Webhooks</b>, add a new webhook pointing to your Plekt webhook URL.</li>
          <li>Under <b>Events</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><b>Playback</b>: Check <code>Start</code>, <code>Pause</code>, <code>Unpause</code>, and <code>Stop</code></li>
              <li><b>Users</b>: Check <code>Mark Played</code> and <code>Mark Unplayed</code></li>
            </ul>
          </li>
          <li>Resume sync uses Emby's <code>Pause</code> and <code>Stop</code> events. Those payloads need to include <code>PlaybackPositionTicks</code> or <code>PositionTicks</code>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #4b96e6;"></span>
          3. Jellyfin Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Install the <b>Webhooks</b> plugin in the Jellyfin Dashboard (under Plugins).</li>
          <li>Add a new Generic Webhook named <code>plekt</code> pointing to your Plekt webhook URL.</li>
          <li>Check <b>Enable</b>.</li>
          <li>Under <b>Notification Type</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Playback Start</code></li>
              <li><code>Playback Progress</code></li>
              <li><code>Playback Stop</code></li>
              <li><code>User Data Saved</code> <i>(Crucial: sends events when items are marked watched or unwatched)</i></li>
              <li><code>Item Added</code> <i>(Marks newly added media watched only when its current Plekt state is watched; a newer unwatch wins)</i></li>
            </ul>
          </li>
          <li>Under <b>Item Type</b>, select:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Movies</code></li>
              <li><code>Episodes</code></li>
            </ul>
          </li>
          <li>Check <b>Send All Properties (ignores template)</b>.</li>
          <li>Resume sync depends on Jellyfin sending <code>PlaybackPositionTicks</code>, <code>PositionTicks</code>, or item <code>UserData</code> playback position fields.</li>
        </ul>
      </div>
    </div>
  `;
}

export function cronSyncGuide() {
  const endpoint = `${window.location.origin}/api/cron-sync`;
  return `
    <section class="guide-callout" id="cron-sync-setup">
      <b>Background Sync Worker</b>
      <p>Plekt runs a built-in scheduler directly inside the server process - no external cron job or cloud infrastructure is required. It fires once per minute as long as the server is running.</p>
      <h3>Manual trigger</h3>
      <p>To force an immediate run, send an authenticated POST to <code>/api/cron-sync</code>. You can also use <b>Force Sync</b> in the dashboard, which calls <code>/api/force-sync</code> and streams progress.</p>
      <h3>Authenticated request</h3>
      ${snippet(`POST ${endpoint}

X-Api-Key: <your-api-key>`, "http")}
      <h3>What this runs</h3>
      <p>Restores pause automated sync while they own watch state. The scheduler recovers an interrupted restore after three minutes without a heartbeat, allowing live playback tracking and history recording to resume.</p>
      <p>The worker writes a heartbeat timestamp, polls Plex, Emby, and Jellyfin for active playback, updates live-session cache rows, detects completed sessions at the watched threshold (90% by default), writes completed watches to <code>watch_history</code>, dispatches outbound watched-state sync, repairs platform drift against Plekt's canonical watched state, maintains <code>data/next-airing-cache.json</code>, and progressively stores month results in <code>data/upcoming-calendar-cache.json</code>.</p>
    </section>
  `;
}

function rebuildPlaystateGuide() {
  return `
          <p><b>scripts/rebuildPlaystateDatabase.js</b> is the one-time database reset tool for rebuilding Plekt from a Trakt export and the latest live Plex state. It preserves saved server/admin settings, clears media history and sync state, imports Trakt and Plex history, writes canonical playstate rows, then converges Plex, Emby, and Jellyfin.</p>
          <p>Run the dry run first. It reads the Trakt export folder and configured media server APIs, but does not write because <code>--write</code> is omitted. Only run the write command after the convergence plan looks safe.</p>
          <section class="guide-callout">
            <b>What the write pass changes</b>
            <ol>
              <li>Clears <code>watchHistory</code>, <code>playstate</code>, <code>playbackProgress</code>, sync logs, active-session cache, live-tracking cache, and derived history caches.</li>
              <li>Preserves saved Plex, Emby, Jellyfin, TMDB, and admin configuration.</li>
              <li>Imports Trakt <code>watched-history-*.json</code> and current watched movie/show exports.</li>
              <li>Pulls Plex full play history, current Plex watched state, and target-library availability from the live Plex API.</li>
              <li>Skips items unavailable in a target library instead of issuing thousands of failed mark-watched requests.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Dry run</b>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot;" aria-label="Copy dry-run command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie"</code></pre>
            </div>
          </section>
          <section class="guide-callout">
            <b>Write pass</b>
            <p>This clears and rebuilds Plekt media data, then applies the convergence plan to all configured media servers.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot; --write" aria-label="Copy write command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie" --write</code></pre>
            </div>
          </section>
        `;
}

function exportPlexHistoryGuide() {
  return `
          <p><b>scripts/exportPlexHistory.js</b> reads your full Plex play history and streams it into the local SQLite database via the import API. Imported rows become canonical Plekt playstate and are queued for outbound sync, so use the full-sync tool only when you want an immediate complete replay.</p>
          <p>Use it once when you want to bootstrap a fresh deployment, or again if you are migrating an existing Plex library and need the cloud history to reflect years of prior viewing. The script does not need the browser open after launch; it reads the local configuration block, streams rows to the import API in batches, and finishes with a deterministic summary.</p>
          <section class="guide-callout">
            <b>Token discovery walkthrough</b>
            <ol>
              <li>Open a desktop browser such as Chrome, Firefox, Edge, or Safari.</li>
              <li>Navigate to the Plex Web App and sign in with an administrative account.</li>
              <li>Open any movie or series row from your library.</li>
              <li>Open the item action menu and select <b>Get Info</b>.</li>
              <li>Click <b>View XML</b> in the lower-right corner of the dialog to open the raw metadata page.</li>
              <li>Do not inspect the XML content itself. Look at the browser address bar and scroll to the end of the URL.</li>
              <li>Find the query parameter named <code>X-Plex-Token=</code> and copy the long alphanumeric string immediately after it.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>Configure PLEX_URL and the harvested PLEX_TOKEN as environment variables before running. The import API authenticates with your configured API key.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/exportPlexHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/exportPlexHistory.js</code></pre>
            </div>
            ${terminalOutput(`🚀 Initiating Local Plex History Extraction Engine...
      ✔ Connection established to local server at http://127.0.0.1:32400
      ℹ Found 3 media library sections to process.

      [1/3] Processing Section: "Movies" (ID: 1)
      → Found 450 watched titles. Streaming to local database in batches...
      └── Chunks: [██████████████████████████████] 100% | Sent 5/5 batches successfully.

      [2/3] Processing Section: "TV Shows" (ID: 2)
      → Traversing underlying episodes. Found 1,200 tracked played logs.
      └── Chunks: [██████████████████████████████] 100% | Sent 12/12 batches successfully.

      🎉 [SUCCESS] Historic data migration finalized!
      Total Rows Synced to Local Database: 1,650 items.
      Ecosystem is fully synchronized and ready for live playback tracking.`)}
          </section>
        `;
}

function forcePushHistoryGuide() {
  return `
          <p><b>scripts/forcePushHistory.js</b> is the ecosystem equalizer. It reads the local SQLite watch history, resolves each row against Plex, Emby, and Jellyfin, and replays the played state back out through their APIs so all three servers converge on the same watch record.</p>
          <p>It is meant for catch-up and repair, not for routine polling. Use it when you want to reconcile a clean server, recover from a migration, or make a newly joined platform match the canonical watch archive with no manual checkbox clicking.</p>
          <section class="guide-callout">
            <b>Platform setup walkthrough</b>
            <ol>
              <li>Open the Emby server settings page and sign in as an administrator.</li>
              <li>Navigate to <b>Advanced</b>, then <b>API Keys</b>, and generate an API key if needed.</li>
              <li>Open the target Emby user profile and copy the user ID from the browser URL parameter that follows <code>?userId=</code>.</li>
              <li>Repeat the same flow in Jellyfin: open the admin dashboard, create or confirm the API key, then copy the user identifier from the profile URL.</li>
              <li>Paste the harvested server URLs, API keys, and user IDs into the header block at the top of <code>scripts/forcePushHistory.js</code>.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>Open scripts/forcePushHistory.js in your editor, configure your server credentials in the file header, then run the command below from the project root to synchronize your media ecosystem.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/forcePushHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/forcePushHistory.js</code></pre>
            </div>
            ${terminalOutput(`🔄 Initiating Central Database Outward Force-Push Matrix...
      ✔ Fetched 1,650 master tracking history logs from website API.
      ℹ Mapping provider GUID parameters across target endpoints...

      [PROCESSING] Index: 001/1650 | 'Dimension 20 - S01E01' ➔ Synchronizing...
      ├── Plex Server Client API: [SKIPPED] (Already marked watched)
      ├── Emby Server Client API: [SUCCESS] Item resolved (ID: 8849) ➔ Sent PlayState HTTP 200 OK
      └── Jellyfin Server Client API: [SUCCESS] Cache-busted (ID: 9412) ➔ Sent PlayState HTTP 200 OK

      ⏳ Applying 150ms structural rate-limit protection delay...
      [PROCESSING] Index: 002/1650 | 'The Curse of Oak Island' ➔ Synchronizing...
      └── Continuing batch redistribution across all configured servers.

      🎉 [SUCCESS] Outward catch-up synchronization task completed across all servers!`)}
          </section>
        `;
}

// Saved tokens/API keys are never sent back to the browser, so credential inputs
// render blank with a "Configured" placeholder once a value is stored.
export function savedCredentialNote() {
  return `
    <div class="guide-callout credential-guide">
      <b>About saved credentials</b>
      <p>Saved tokens and API keys are never shown again in the browser.</p>
      <p style="margin-top: 4px;">A blank field with a "Configured" placeholder means one is already saved and in use. Leave it blank to keep it, or enter a new value to replace it.</p>
    </div>
  `;
}

export function watchlistSyncGuide() {
  return `
    <b>Plekt is the canonical watchlist</b>
    <p style="margin: 4px 0 0;">Turn sync on once to keep Plekt and your Plex account watchlist aligned in both directions. Additions and removals save in Plekt first, then go out through a durable delivery queue.</p>
    <ul style="margin: 4px 0 0; padding-left: 1.1rem; line-height: 1.45;">
      <li>Syncs with the account-level Plex Universal Watchlist, so it can hold anything in the Plex catalogue - not only titles on your server.</li>
      <li>Anything added in the Plex app is imported into Plekt, and anything added in Plekt is sent to Plex.</li>
      <li>Failed items stay queued for retry. A restored list performs a safe union first, so an empty snapshot can never erase it.</li>
      <li>Anything Plex refuses is explained above, with what it reported and what to do about it. <b>Sync now</b> runs a full reconcile immediately.</li>
    </ul>
  `;
}

export function renderSettingsInlineHelp() {
  const adminLoginHelp = document.getElementById("adminLoginHelp");
  if (adminLoginHelp) adminLoginHelp.innerHTML = adminTokenGuide();

  const webhookSecret = document.getElementById("webhookSecret");
  if (webhookSecret) webhookSecret.textContent = getWebhookToken() || "Not available";

  const webhookSetupGuides = document.getElementById("webhookSetupGuides");
  if (webhookSetupGuides) {
    webhookSetupGuides.innerHTML = `
      <details class="sync-tool-details">
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>Plex</b>
            <span class="badge badge-success">Automatic</span>
          </div>
          <span>No webhook setup required</span>
        </summary>
        <div class="tool-item-row">
          <p style="font-size: 0.9rem; color: var(--muted); margin: 0;">Plekt watches Plex automatically. It picks up watched and unwatched changes in real time, and also checks playback progress every minute.</p>
          <p style="font-size: 0.9rem; color: var(--muted); margin: var(--space-2) 0 0;">Changes are saved to Plekt and passed on to your other servers.</p>
          <div class="guide-callout warning-callout" style="gap: var(--space-1); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08); margin-top: var(--space-3);">
            <b style="color: var(--yellow); font-size: 0.85rem; display: block;">
              Turn off "Refresh library metadata periodically"
            </b>
            <ol style="margin: var(--space-1) 0 0; padding-left: 1.1rem; font-size: 0.82rem; line-height: 1.5; color: var(--text-muted, var(--muted));">
              <li>In Plex, go to <b>Settings &rarr; Scheduled Tasks</b>.</li>
              <li>Disable <b>"Refresh library metadata periodically"</b>.</li>
            </ol>
            <p style="margin: var(--space-1) 0 0; font-size: 0.82rem; line-height: 1.4; color: var(--text-muted, var(--muted));">
              This Plex task can quietly reset watched items back to unwatched overnight. Plekt would then copy that "unwatch" to Emby, Jellyfin, and Trakt. Turning it off stops that from happening.
            </p>
          </div>
        </div>
      </details>
      <details class="sync-tool-details">
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>Emby Webhook Setup Guide</b>
          </div>
          <span>Instructions for adding webhooks in Emby Server</span>
        </summary>
        <div class="tool-item-row">${embyWebhookSetup()}</div>
      </details>
      <details class="sync-tool-details">
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>Jellyfin Webhook Setup Guide</b>
          </div>
          <span>Instructions for adding webhooks in Jellyfin Media Server</span>
        </summary>
        <div class="tool-item-row">${jellyfinWebhookSetup()}</div>
      </details>
    `;
  }

  const watchlistHelp = document.getElementById("watchlistSyncHelp");
  if (watchlistHelp) watchlistHelp.innerHTML = watchlistSyncGuide();
}
