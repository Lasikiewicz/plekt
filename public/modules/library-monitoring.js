// Per-user, per-server library monitoring checklist under Settings > Media
// Servers and the persistent app-wide warning banner when a connected server
// has zero selected libraries.
import { state } from "./state.js?v=2.3.0.0.5";
import { buildAuthHeaders } from "./auth.js?v=2.3.0.0.5";
import { escapeAttribute, escapeHtml } from "./utils.js?v=2.3.0.0.5";

const PROVIDERS = ["plex", "emby", "jellyfin"];
const PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };

const discoveryCache = new Map();
const draftSelection = new Map();
const busyProviders = new Set();

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function formatLibraryTypeLabel(lib = {}) {
  const type = String(lib.type || lib.collectionType || "").trim().toLowerCase();
  const base = type === "movie" || type === "movies"
    ? "Movies"
    : type === "show" || type === "tvshows"
      ? "TV Shows"
      : type === "homevideos"
        ? "Home Videos"
        : type === "musicvideos"
          ? "Music Videos"
          : "Mixed";
  if (lib.isPersonalMedia) return `${base} · Personal Media`;
  return base;
}

export function formatLibraryDisambiguator(lib = {}) {
  const typeLabel = formatLibraryTypeLabel(lib);
  if (!lib.duplicateName) return typeLabel;
  const rawId = String(lib.id || "").trim();
  const shortId = rawId.length > 8 ? rawId.slice(0, 8) : rawId;
  return shortId ? `${typeLabel} · ID ${shortId}` : typeLabel;
}

export function formatUnselectedBannerCopy(unselected = []) {
  const list = Array.isArray(unselected) ? unselected : [];
  if (!list.length) return "";
  const names = list.map((item) => item.label || PROVIDER_LABELS[item.provider] || item.provider).filter(Boolean);
  const joined = names.length === 1
    ? names[0]
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const hasMismatch = list.some((item) => item.reason === "server_mismatch");
  return hasMismatch
    ? `Library monitoring is paused for ${joined} because no libraries are selected or the connected server changed. Select the libraries you want Plekt to monitor.`
    : `Library monitoring is paused for ${joined} because no libraries are selected yet. Select which libraries Plekt monitors before activity can sync.`;
}

export function renderLibrarySelectionBanner(config = state.savedConfig) {
  const banner = document.querySelector("#librarySelectionBanner");
  if (!banner) return;
  const unselected = config?.libraryMonitoring?.unselectedConnectedProviders || [];
  if (!state.token || !unselected.length) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  const copy = formatUnselectedBannerCopy(unselected);
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <div class="library-selection-banner-copy">
      <strong class="library-selection-banner-title">No libraries selected</strong>
      <span class="library-selection-banner-text">${escapeHtml(copy)}</span>
    </div>
    <a class="button-primary library-selection-banner-link" href="/settings/media-servers">Select libraries</a>
  `;
  const link = banner.querySelector(".library-selection-banner-link");
  if (link) {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      window.history.pushState({}, "", "/settings/media-servers");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }
}

function monitoringStateFor(provider) {
  return state.savedConfig?.libraryMonitoring?.providers?.[provider] || {
    connected: false,
    hasSelectedLibraries: false,
    selectedIds: [],
    storedSelectedIds: [],
    selectedLibraries: [],
    serverId: "",
    serverName: "",
    serverMismatch: false,
    revision: 0,
    reason: "not_configured",
  };
}

function getDraftSet(provider, monitoring) {
  if (!draftSelection.has(provider)) {
    const initial = monitoring.serverMismatch ? [] : (monitoring.selectedIds || []);
    draftSelection.set(provider, new Set(initial.map(String)));
  }
  return draftSelection.get(provider);
}

function renderProviderMonitoringPanel(provider, { statusMessage = "", statusTone = "muted" } = {}) {
  const container = document.querySelector(`#${provider}LibraryMonitoringPanel`);
  if (!container) return;

  const monitoring = monitoringStateFor(provider);
  const label = PROVIDER_LABELS[provider] || provider;

  if (!monitoring.connected) {
    discoveryCache.delete(provider);
    draftSelection.delete(provider);
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  const discovered = discoveryCache.get(provider);
  const isBusy = busyProviders.has(provider);
  const selectedCount = monitoring.selectedIds?.length || 0;
  const pillClass = monitoring.hasSelectedLibraries ? "status-ready" : "status-warning";
  const pillText = monitoring.serverMismatch
    ? "Re-selection required"
    : monitoring.hasSelectedLibraries
      ? `${selectedCount} ${selectedCount === 1 ? "library" : "libraries"} monitored`
      : "Monitoring paused (0 selected)";

  const warningHtml = monitoring.serverMismatch
    ? `<p class="library-monitoring-notice library-monitoring-notice-warning" role="alert">Connected ${escapeHtml(label)} server identity changed. Nothing is monitored until you review and save libraries for this server.</p>`
    : !monitoring.hasSelectedLibraries
      ? `<p class="library-monitoring-notice library-monitoring-notice-warning" role="status">Monitoring is paused for ${escapeHtml(label)}. Select at least one library below and save before Plekt records watches, reviews, or sync writes for this server.</p>`
      : `<p class="library-monitoring-notice">Only checked libraries are monitored. Unchecked and newly created libraries stay ignored.</p>`;

  let listHtml = "";
  if (!discovered && isBusy) {
    listHtml = `<p class="muted-copy library-monitoring-loading">Loading ${escapeHtml(label)} libraries…</p>`;
  } else if (discovered?.error) {
    listHtml = `<p class="library-monitoring-notice library-monitoring-notice-error" role="alert">${escapeHtml(discovered.error)} Existing saved choices were kept unchanged.</p>`;
  } else if (discovered) {
    const draft = getDraftSet(provider, monitoring);
    const liveLibraries = discovered.libraries || [];
    const unavailable = discovered.unavailableLibraries || [];

    if (!liveLibraries.length && !unavailable.length) {
      listHtml = `<p class="muted-copy">No video libraries were returned by ${escapeHtml(label)} for this account.</p>`;
    } else {
      const liveRows = liveLibraries.map((lib) => {
        const checked = draft.has(String(lib.id));
        const subtitle = formatLibraryDisambiguator(lib);
        return `
          <label class="library-monitoring-item">
            <input type="checkbox"
              data-library-monitoring-check="${escapeAttribute(provider)}"
              value="${escapeAttribute(lib.id)}"
              ${checked ? "checked" : ""}
              ${isBusy ? "disabled" : ""} />
            <span class="library-monitoring-item-copy">
              <span class="library-monitoring-item-name">${escapeHtml(lib.name)}</span>
              <span class="library-monitoring-item-meta">${escapeHtml(subtitle)}</span>
            </span>
          </label>
        `;
      }).join("");

      const unavailableRows = unavailable.map((lib) => `
        <div class="library-monitoring-item library-monitoring-item-unavailable" role="note">
          <span class="status-pill status-warning">Unavailable</span>
          <span class="library-monitoring-item-copy">
            <span class="library-monitoring-item-name">${escapeHtml(lib.name || lib.id)}</span>
            <span class="library-monitoring-item-meta">Previously selected, but no longer accessible on ${escapeHtml(label)}. Saving removes it from active monitoring.</span>
          </span>
        </div>
      `).join("");

      listHtml = `<div class="library-monitoring-checklist" role="group" aria-label="${escapeAttribute(label)} monitored libraries">${liveRows}${unavailableRows}</div>`;
    }
  } else {
    const savedNames = (monitoring.selectedLibraries || []).map((lib) => lib.name).filter(Boolean);
    listHtml = savedNames.length
      ? `<p class="muted-copy">Currently monitored: ${escapeHtml(savedNames.join(", "))}.</p>`
      : `<p class="muted-copy">Load libraries from ${escapeHtml(label)} to choose what Plekt monitors.</p>`;
  }

  const draftSet = discovered && !discovered.error ? getDraftSet(provider, monitoring) : null;
  const savedSet = new Set((monitoring.serverMismatch ? [] : (monitoring.selectedIds || [])).map(String));
  const hasChanges = Boolean(
    draftSet && (
      draftSet.size !== savedSet.size
      || [...draftSet].some((id) => !savedSet.has(id))
      || (discovered?.unavailableLibraries?.length > 0)
      || monitoring.serverMismatch
    ),
  );

  const statusHtml = statusMessage
    ? `<p class="library-monitoring-status library-monitoring-status-${escapeAttribute(statusTone)}" role="status">${escapeHtml(statusMessage)}</p>`
    : "";

  container.innerHTML = `
    <div class="library-monitoring-header">
      <div class="library-monitoring-heading">
        <strong>Monitored libraries</strong>
        <span class="status-pill ${pillClass}">${escapeHtml(pillText)}</span>
      </div>
      <div class="library-monitoring-actions">
        <button type="button" class="button-secondary library-monitoring-refresh" data-library-monitoring-refresh="${escapeAttribute(provider)}" ${isBusy ? "disabled" : ""}>
          ${isBusy ? "Loading…" : discovered ? "Refresh libraries" : "Load libraries"}
        </button>
        ${discovered && !discovered.error ? `
          <button type="button" class="button-primary library-monitoring-save" data-library-monitoring-save="${escapeAttribute(provider)}" ${isBusy || !hasChanges ? "disabled" : ""}>
            Save libraries
          </button>
        ` : ""}
      </div>
    </div>
    ${warningHtml}
    ${listHtml}
    ${statusHtml}
  `;

  container.querySelectorAll(`[data-library-monitoring-check="${provider}"]`).forEach((input) => {
    input.addEventListener("change", () => {
      const draft = getDraftSet(provider, monitoring);
      if (input.checked) draft.add(String(input.value));
      else draft.delete(String(input.value));
      renderProviderMonitoringPanel(provider);
    });
  });

  container.querySelector(`[data-library-monitoring-refresh="${provider}"]`)?.addEventListener("click", () => {
    void loadProviderLibraries(provider, { force: true });
  });

  container.querySelector(`[data-library-monitoring-save="${provider}"]`)?.addEventListener("click", () => {
    void saveProviderLibraries(provider);
  });
}

export async function loadProviderLibraries(provider, { force = false } = {}) {
  if (!PROVIDERS.includes(provider) || !state.token) return;
  const monitoring = monitoringStateFor(provider);
  if (!monitoring.connected) return;
  if (!force && discoveryCache.has(provider)) {
    renderProviderMonitoringPanel(provider);
    return;
  }
  if (busyProviders.has(provider)) return;

  busyProviders.add(provider);
  renderProviderMonitoringPanel(provider);
  try {
    const response = await fetch(`/api/library-monitoring/${encodeURIComponent(provider)}/libraries`, {
      headers: authHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      discoveryCache.set(provider, { error: body.error || `Could not load ${PROVIDER_LABELS[provider]} libraries.` });
    } else {
      discoveryCache.set(provider, body);
      const liveIds = new Set((body.libraries || []).map((lib) => String(lib.id)));
      const initial = body.serverMismatch
        ? []
        : (body.selection?.selectedIds || monitoring.selectedIds || []).map(String).filter((id) => liveIds.has(id));
      draftSelection.set(provider, new Set(initial));
    }
  } catch (error) {
    discoveryCache.set(provider, { error: error?.message || `Could not load ${PROVIDER_LABELS[provider]} libraries.` });
  } finally {
    busyProviders.delete(provider);
    renderProviderMonitoringPanel(provider);
  }
}

async function saveProviderLibraries(provider) {
  if (!PROVIDERS.includes(provider) || busyProviders.has(provider)) return;
  const monitoring = monitoringStateFor(provider);
  const discovered = discoveryCache.get(provider);
  if (!discovered || discovered.error) return;
  const draft = getDraftSet(provider, monitoring);
  const selectedIds = [...draft];

  busyProviders.add(provider);
  renderProviderMonitoringPanel(provider, { statusMessage: "Saving library selection…", statusTone: "muted" });
  try {
    const response = await fetch(`/api/library-monitoring/${encodeURIComponent(provider)}`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selectedIds,
        serverId: discovered.serverId || "",
        expectedRevision: monitoring.revision,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || `Could not save ${PROVIDER_LABELS[provider]} libraries.`);
    }
    if (body.libraryMonitoring) {
      state.savedConfig = {
        ...(state.savedConfig || {}),
        libraryMonitoring: body.libraryMonitoring,
      };
    }
    draftSelection.set(provider, new Set((body.saved?.selectedIds || []).map(String)));
    if (discovered) {
      discoveryCache.set(provider, {
        ...discovered,
        serverMismatch: false,
        unavailableLibraries: [],
        selection: body.libraryMonitoring?.providers?.[provider] || discovered.selection,
      });
    }
    renderLibrarySelectionBanner(state.savedConfig);
    renderProviderMonitoringPanel(provider, {
      statusMessage: selectedIds.length
        ? `Saved ${selectedIds.length} monitored ${selectedIds.length === 1 ? "library" : "libraries"} for ${PROVIDER_LABELS[provider]}.`
        : `Saved empty selection. Monitoring is paused for ${PROVIDER_LABELS[provider]}.`,
      statusTone: "success",
    });
    document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
  } catch (error) {
    renderProviderMonitoringPanel(provider, {
      statusMessage: error?.message || `Could not save ${PROVIDER_LABELS[provider]} libraries.`,
      statusTone: "error",
    });
  } finally {
    busyProviders.delete(provider);
  }
}

export function renderLibraryMonitoringPanels({ autoLoad = true } = {}) {
  renderLibrarySelectionBanner(state.savedConfig);
  for (const provider of PROVIDERS) {
    const monitoring = monitoringStateFor(provider);
    renderProviderMonitoringPanel(provider);
    if (autoLoad && monitoring.connected && !discoveryCache.has(provider) && !busyProviders.has(provider)) {
      void loadProviderLibraries(provider);
    }
  }
}

export function resetLibraryMonitoringCache() {
  discoveryCache.clear();
  draftSelection.clear();
  busyProviders.clear();
}
