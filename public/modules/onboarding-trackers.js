import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.2.0.0";

// Status comes from the server registry. No separate frontend provider list
// can expose a tracker whose synchronization is still gated off.
export function createOnboardingTrackers({ getStatus, api, renderSetupPage, loadSetupStatus, setMessage }) {
  const flows = new Map();
  const timers = new Map();
  const preferences = new Map();
  const choices = new Map();
  const connecting = new Set();
  const providers = () => getStatus()?.trackers || [];
  const importState = (provider) => getStatus()?.onboarding?.backgroundImports?.trackers?.[provider];
  const selected = (provider) => choices.has(provider) ? choices.get(provider) : importState(provider)?.enabled !== false;

  function render() {
    const html = `<p class="muted-copy setup-step-intro">Connect any watch trackers you use, or skip this step. Review selected imports first; approved watches are then propagated to connected media servers.</p>
      <div class="settings-card-grid setup-tracker-grid">${providers().map((tracker) => {
        const { provider, label, connected } = tracker;
        const flow = flows.get(provider);
        const info = importState(provider);
        return `<section class="settings-card setup-trakt-card" data-setup-server="${escapeAttribute(provider)}">
          <div class="setup-trakt-heading"><b>${escapeHtml(label)}</b><span class="badge${connected ? " badge-success" : ""}">${connected ? "Connected" : "Not connected"}</span></div>
          ${connected ? `
            <div class="setup-tracker-options">
              <div class="setup-tracker-choice-box"><label class="field-label setup-import-toggle-label"><input type="checkbox" data-setup-import-toggle="${escapeAttribute(provider)}" ${selected(provider) ? "checked" : ""} />Import watch history from ${escapeHtml(label)}</label></div>
              <div class="setup-tracker-choice-box"><label class="checkbox-label tracker-date-preference"><input type="checkbox" data-setup-tracker-date-pref="${escapeAttribute(provider)}" ${tracker.preferEarlierWatchedDate !== false ? "checked" : ""} /><span>Prefer ${escapeHtml(label)}'s earlier watch date when Plex, Emby or Jellyfin later report the same title</span></label></div>
            </div>
            ${info?.status === "importing" ? `<p class="muted-copy">Importing… ${info.itemCount ?? 0} items so far.</p>` : ""}
            ${info?.status === "failed" ? `<p class="muted-copy is-error">${escapeHtml(info.error || "Import failed")} <a href="#" data-setup-import-retry="1">Retry</a></p>` : ""}`
          : flow ? `<p>Go to <a href="${escapeAttribute(flow.verificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(flow.verificationUrl)}</a> and enter this code:</p><p class="setup-trakt-code">${escapeHtml(flow.userCode)}</p><p class="muted-copy">Waiting for confirmation…</p>`
          : `<p class="muted-copy">Keep watched state synchronized with ${escapeHtml(label)}. Disable other plugins that write to this tracker to avoid duplicate writers.</p>
            <label class="checkbox-label setup-trakt-date-pref"><input type="checkbox" data-setup-tracker-date-pref="${escapeAttribute(provider)}" ${preferences.get(provider) !== false ? "checked" : ""} /><span>Prefer ${escapeHtml(label)}’s watched date when it is earlier than a media server’s</span></label>
            <button type="button" class="button-primary" data-setup-tracker-connect="${escapeAttribute(provider)}" ${connecting.has(provider) ? "disabled" : ""}>Connect ${escapeHtml(label)}</button>`}
        </section>`;
      }).join("") || '<p class="muted-copy">No watch trackers are currently available. Continue to connect your media servers.</p>'}</div>`;
    return html;
  }

  function schedule(provider) {
    clearTimeout(timers.get(provider));
    const flow = flows.get(provider);
    if (!flow) return;
    timers.set(provider, setTimeout(() => check(provider), Math.max(2, Number(flow.intervalSeconds) || 5) * 1000));
  }

  async function connect(provider) {
    const tracker = providers().find((entry) => entry.provider === provider);
    if (!tracker || connecting.has(provider)) return;
    connecting.add(provider);
    try {
      const flow = await api(`/api/tracker-auth/${encodeURIComponent(provider)}/start`, {
        method: "POST", body: JSON.stringify({ preferEarlierWatchedDate: preferences.get(provider) !== false }),
      });
      const activation = new URL(flow.verificationUrl);
      if (activation.protocol !== "https:") throw new Error("The tracker returned an invalid activation URL.");
      flows.set(provider, flow);
      schedule(provider);
    } catch (error) { setMessage(error.message, "error"); }
    finally { connecting.delete(provider); renderSetupPage(); }
  }

  async function check(provider) {
    clearTimeout(timers.get(provider));
    const flow = flows.get(provider);
    if (!flow || flow.checking) return;
    flow.checking = true;
    try {
      const result = await api(`/api/tracker-auth/${encodeURIComponent(provider)}/${encodeURIComponent(flow.flowId)}/status`);
      if (result.status === "completed") {
        flows.delete(provider);
        await loadSetupStatus();
      } else if (["expired", "denied", "failed"].includes(result.status)) {
        const error = new Error(`${providers().find((entry) => entry.provider === provider)?.label || provider} authorization expired or was denied. Try again.`);
        error.terminal = true;
        throw error;
      } else {
        flow.intervalSeconds = Math.max(Number(flow.intervalSeconds) || 5, Number(result.retryAfter) || 0);
        schedule(provider);
      }
    } catch (error) {
      if (error.terminal || [400, 401, 403, 404, 409, 410].includes(error.status) || Date.now() >= flow.expiresAt) {
        flows.delete(provider);
        setMessage(error.message, "error");
        renderSetupPage();
      } else schedule(provider);
    } finally { flow.checking = false; }
  }

  async function startImports() {
    try {
      await Promise.all(providers().filter((tracker) => tracker.connected).map(async ({ provider }) => {
        const existing = importState(provider);
        const enabled = selected(provider);
        if (existing && existing.enabled === enabled && existing.status !== "not_started") return;
        await api("/api/setup/import", { method: "POST", body: JSON.stringify({ target: provider, action: enabled ? "start" : "cancel" }) });
      }));
      choices.clear();
      await loadSetupStatus();
      return true;
    } catch (error) {
      setMessage(error.message, "error");
      await loadSetupStatus();
      return false;
    }
  }

  return {
    render, connect, startImports,
    hasSelectedImports: () => providers().some((tracker) => tracker.connected && selected(tracker.provider)),
    checkFlows: () => Promise.all([...flows.keys()].map(check)),
    setImportChoice: (provider, enabled) => choices.set(provider, enabled),
    handleChange(target) {
      if (!target.matches("[data-setup-tracker-date-pref]")) return false;
      const provider = target.dataset.setupTrackerDatePref;
      preferences.set(provider, target.checked);
      if (providers().some((tracker) => tracker.provider === provider && tracker.connected)) {
        api(`/api/tracker-connections/${encodeURIComponent(provider)}`, { method: "PATCH", body: JSON.stringify({ preferEarlierWatchedDate: target.checked }) })
          .catch((error) => setMessage(error.message, "error"));
      }
      return true;
    },
  };
}
