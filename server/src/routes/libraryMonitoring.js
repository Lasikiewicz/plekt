import { isSameOrigin, requireAdmin } from "../utils/auth.js";
import { isDemoMode } from "../utils/demoMode.js";
import { writeAuditLog } from "../db.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import { loadMediaConfig, saveProviderLibraryMonitoring } from "../utils/configStore.js";
import {
  LIBRARY_MONITORING_PROVIDERS,
  PROVIDER_LABELS,
  discoverProviderLibraries,
  getProviderLibrarySelection,
  publicLibraryMonitoringConfig,
  validateLibrarySelectionSave,
} from "../utils/librarySelection.js";

function providerFromPath(path = "") {
  const match = String(path || "").match(/^library-monitoring\/(plex|emby|jellyfin)(?:\/(libraries))?$/i);
  if (!match) return { provider: "", action: "" };
  return { provider: match[1].toLowerCase(), action: (match[2] || "").toLowerCase() };
}

export async function handleLibraryMonitoring(req, res, path = "library-monitoring") {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;

  if (path === "library-monitoring") {
    if (req.method !== "GET") return methodNotAllowed(res);
    const config = await loadMediaConfig();
    return sendJson(res, publicLibraryMonitoringConfig(config), 200, { "Cache-Control": "no-store" });
  }

  const { provider, action } = providerFromPath(path);
  if (!provider || !LIBRARY_MONITORING_PROVIDERS.includes(provider)) {
    return sendJson(res, { error: "Unsupported media provider" }, 404);
  }

  if (action === "libraries") {
    if (req.method !== "GET") return methodNotAllowed(res);
    const config = await loadMediaConfig();
    const selection = getProviderLibrarySelection(config, provider);
    if (!selection.connected) {
      return sendJson(res, {
        provider,
        connected: false,
        libraries: [],
        unavailableLibraries: [],
        selection: publicLibraryMonitoringConfig(config).providers[provider],
        error: `${PROVIDER_LABELS[provider]} is not configured or is disabled.`,
      }, 200, { "Cache-Control": "no-store" });
    }
    try {
      const discovered = await discoverProviderLibraries(provider, config[provider], { lane: "interactive" });
      const liveIds = new Set(discovered.libraries.map((lib) => lib.id));
      const serverMismatch = Boolean(selection.serverId && discovered.serverId && selection.serverId !== discovered.serverId);
      const unavailableLibraries = serverMismatch
        ? []
        : selection.selectedLibraries
          .filter((entry) => !liveIds.has(entry.id))
          .map((entry) => ({ ...entry, unavailable: true }));

      return sendJson(res, {
        provider,
        connected: true,
        serverId: discovered.serverId,
        serverName: discovered.serverName,
        serverMismatch,
        libraries: discovered.libraries,
        unavailableLibraries,
        selection: publicLibraryMonitoringConfig(config).providers[provider],
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      // Discovery failure must never erase saved selections or select all.
      return sendJson(res, {
        error: `Could not load ${PROVIDER_LABELS[provider]} libraries: ${error.message}`,
        provider,
        connected: true,
        libraries: [],
        unavailableLibraries: [],
        selection: publicLibraryMonitoringConfig(config).providers[provider],
      }, 502, { "Cache-Control": "no-store" });
    }
  }

  if (req.method !== "PUT" && req.method !== "POST") return methodNotAllowed(res);
  if (!isSameOrigin(req)) return sendJson(res, { error: "Cross-origin requests are not allowed" }, 403);
  if (isDemoMode()) return sendJson(res, { error: "Public demo is read-only" }, 403);

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const config = await loadMediaConfig();
  const current = getProviderLibrarySelection(config, provider);
  if (!current.connected) {
    return sendJson(res, { error: `${PROVIDER_LABELS[provider]} is not configured or is disabled.` }, 400);
  }

  if (body?.expectedRevision !== undefined && body?.expectedRevision !== null) {
    const expectedRev = Number(body.expectedRevision);
    if (Number.isFinite(expectedRev) && expectedRev !== current.revision) {
      return sendJson(res, {
        error: "Library monitoring settings changed in another session. Refresh and try again.",
        code: "LIBRARY_SELECTION_CONFLICT",
        currentRevision: current.revision,
      }, 409);
    }
  }

  try {
    const { selection } = await validateLibrarySelectionSave({
      provider,
      providerConfig: config[provider],
      requestedIds: Array.isArray(body?.selectedIds) ? body.selectedIds : null,
      currentMonitoring: config.libraryMonitoring?.[provider],
      expectedServerId: body?.serverId || "",
    });
    const saved = saveProviderLibraryMonitoring(provider, selection, { expectedRevision: current.revision });
    writeAuditLog("library-monitoring.updated", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: {
        provider,
        serverId: saved.serverId,
        revision: saved.revision,
        selectedCount: saved.selectedIds.length,
      },
    });
    const updatedConfig = await loadMediaConfig();
    return sendJson(res, {
      ok: true,
      provider,
      saved,
      libraryMonitoring: publicLibraryMonitoringConfig(updatedConfig),
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return sendJson(res, {
      error: error.message || `Could not save ${PROVIDER_LABELS[provider]} libraries`,
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.invalidIds ? { invalidIds: error.invalidIds } : {}),
      ...(error?.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
    }, status, { "Cache-Control": "no-store" });
  }
}
