import { getTrackerAdapter, trackerProviderIds } from "./registry.js";

// Only observed, positive timestamps may anchor local history. Preserve each
// provider's fallback policy separately so Trakt's combined-episode heuristic
// cannot lend a different provider's date to an unrelated episode.
export function mergeTrackerWatchedDates(snapshots = [], resolveAdapter = getTrackerAdapter) {
  const merged = new Map();
  const fallback = new Map();
  for (const { provider, snapshot } of snapshots) {
    const adapter = resolveAdapter(provider);
    for (const entry of snapshot) {
      const timestamp = Number(entry.watchedAt);
      const provenance = entry.timestampProvenance || adapter.policies?.defaultTimestampProvenance;
      if (!Number.isFinite(timestamp) || timestamp <= 0 || provenance !== "observed") continue;
      for (const key of adapter.identity.keys(entry.media)) {
        if (!merged.has(key) || timestamp < merged.get(key)) merged.set(key, timestamp);
        if (adapter.policies?.previousEpisodeDateFallback && (!fallback.has(key) || timestamp < fallback.get(key))) fallback.set(key, timestamp);
      }
    }
  }
  Object.defineProperty(merged, "previousEpisodeDates", { value: fallback });
  return merged;
}

function lookup(index, media) {
  // Canonical identity keys are shared across adapters; collect aliases from
  // all snapshot providers via the common movie/episode identity contract.
  const keys = trackerProviderIds().flatMap((provider) => getTrackerAdapter(provider).identity.keys(media));
  const dates = keys.map((key) => index.get(key)).filter((date) => date != null);
  return dates.length ? Math.min(...dates) : null;
}

export function earliestTrackerWatchedAt(index, media) {
  if (!index) return null;
  const direct = lookup(index, media);
  if (direct != null) return direct;
  const episode = Number(media.episode);
  if (media.type === "episode" && Number.isFinite(episode) && episode > 1) {
    // A plain Map is the legacy Trakt index accepted by existing callers.
    return lookup(index.previousEpisodeDates || index, { ...media, episode: episode - 1 });
  }
  return null;
}
