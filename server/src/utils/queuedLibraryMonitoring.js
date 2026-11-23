import { getStoredLibraryMonitoringRevision, loadMediaConfig } from "./configStore.js";
import { getProviderLibrarySelection, LIBRARY_MONITORING_PROVIDERS, resolveItemLibraryMembership } from "./librarySelection.js";
import { normalizeWatchProvenance } from "./watchProvenance.js";

export async function authorizeQueuedLibraryWatch(media, config = null) {
  if (media.source === "plex_personal_media") return null;
  const source = String(media.source || "").trim().toLowerCase().split("_")[0];
  if (!LIBRARY_MONITORING_PROVIDERS.includes(source)) return () => true;
  // Some internal callers provide a synthetic provider configuration.
  if (config && !config.libraryMonitoring && !config[source]?.libraryMonitoringEnforced) return () => true;
  const current = await loadMediaConfig();
  const provenance = normalizeWatchProvenance(media.watchProvenance || media.watch_provenance);
  const itemId = media.itemId || provenance?.item_id;
  if (!itemId) return null;
  const decision = await resolveItemLibraryMembership(source, current, {
    type: media.type || media.media_type,
    itemId,
  });
  if (!decision.allowed) return null;
  const selection = getProviderLibrarySelection(await loadMediaConfig(), source);
  if (!selection.hasSelectedLibraries || selection.revision !== decision.revision
    || !selection.selectedIdSet.has(decision.libraryId)) return null;
  const isCurrent = () => getStoredLibraryMonitoringRevision(source) === decision.revision;
  return isCurrent() ? isCurrent : null;
}
