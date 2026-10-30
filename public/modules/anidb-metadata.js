import { state } from "./state.js?v=2.2.1.1.0";
import { buildAuthHeaders } from "./auth.js?v=2.2.1.1.0";
import { escapeHtml } from "./utils.js?v=2.2.1.1.0";

// One bounded read for the same batch already requested by tmdb.js. Failures
// preserve the original metadata and never affect identity or numbering.
export async function enrichAnidbDetails(items, details) {
  if (state.savedConfig?.metadata?.anidbEnabled !== true) return details;
  try {
    const response = await fetch("/api/anidb/enrich", {
      method: "POST", headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
      body: JSON.stringify({ cacheOnly: items.every((item) => item.light === true), items: items.map((item, index) => ({
        mediaType: item.mediaType, tmdbId: details[index]?.id || item.tmdbId,
        tvdbId: details[index]?.external_ids?.tvdb_id || item.tvdbId,
      })) }),
    });
    if (!response.ok) return details;
    const body = await response.json();
    return details.map((original, index) => {
      const overlay = body.results?.[index];
      if (!original || !overlay) return original;
      // Canonical provider title remains available to matching/search code.
      // Only the detail display helper uses the AniDB display title.
      return { ...original, overview: overlay.overview || original.overview, anidb: overlay };
    });
  } catch { return details; }
}

export const anidbDisplayTitle = (details, fallback) => details?.anidb?.title || fallback;
export function anidbAttributionHtml(details) {
  const aid = String(details?.anidb?.aid || "");
  if (!/^[1-9]\d{0,9}$/.test(aid)) return "";
  const stale = ["error", "held", "stale"].includes(details.anidb.status) ? " · cached" : "";
  return `<p class="tool-accordion-desc">Anime metadata: <a href="https://anidb.net/anime/${escapeHtml(aid)}" target="_blank" rel="noopener noreferrer">AniDB${stale}</a> · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 4.0</a> · description formatting adapted for Plekt.</p>`;
}
