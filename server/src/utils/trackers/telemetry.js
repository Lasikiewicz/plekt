import { trackerProviderIds } from "./registry.js";

export function settledDestinationLines(detail) {
  return ["plex", "emby", "jellyfin", ...trackerProviderIds()].map((provider) =>
    `Target ${provider} status: skipped - ${detail}`);
}

// Historical observations are settled facts, never implicit destination work.
export function settledTrackerHistoryTelemetry(source, detail) {
  return [
    `Origin: ${source}`,
    "Loop-check: Skipped propagation",
    "Dispatch status: skipped",
    `Details: ${detail}`,
    ...settledDestinationLines("Historical import; not re-propagated"),
  ].join("\n");
}
