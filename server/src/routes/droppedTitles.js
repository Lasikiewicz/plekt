import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { dropTitle, isSameDroppedTitle, listDroppedTitles, undropTitleForMedia } from "../utils/droppedTitles.js";
import { loadMediaConfig } from "../utils/configStore.js";
import { buildUpNextProjection } from "../utils/upNextService.js";
import { refreshUpNextAfterMutation } from "../utils/upNextCache.js";
import { hideUpNextAcrossProviders } from "./sync.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";

// Titles dropped before the drop saved a poster have none in their snapshot;
// the library's canonical poster fills the gap for the Dropped-only cards.
function withPoster(row) {
  if (row.snapshot?.show_poster_url || row.snapshot?.poster_url) return row;
  const poster = getCanonicalPosterUrl({ media_type: row.media_type === "movie" ? "movie" : "tv", title: row.title, tmdb_id: row.tmdb_id, tvdb_id: row.tvdb_id, imdb_id: row.imdb_id });
  return poster ? { ...row, snapshot: { ...row.snapshot, poster_url: poster } } : row;
}

function railIdentities(item, candidates) {
  const providerItems = { plex: [], emby: [], jellyfin: [] };
  for (const candidate of candidates) {
    if (!isSameDroppedTitle(item, candidate)) continue;
    for (const provider of Object.keys(providerItems)) {
      const raw = candidate.provider_items?.[provider] ?? candidate.providerItems?.[provider];
      for (const value of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        const id = String(value || "").trim();
        if (id && !providerItems[provider].includes(id)) providerItems[provider].push(id);
      }
    }
  }
  return providerItems;
}

function normalizedHideMedia(item) {
  const rawType = String(item.media_type || item.mediaType || item.type || "").toLowerCase();
  const show = ["episode", "show", "tv", "series"].includes(rawType);
  const ids = show && (item.show_tmdb_id || item.show_tvdb_id || item.show_imdb_id)
    ? { imdb: item.show_imdb_id, tmdb: item.show_tmdb_id, tvdb: item.show_tvdb_id }
    : {
        imdb: item.imdb_id || item.imdbId || item.imdb,
        tmdb: item.tmdb_id || item.tmdbId || item.tmdb,
        tvdb: item.tvdb_id || item.tvdbId || item.tvdb,
      };
  return {
    type: show ? "episode" : "movie",
    title: String(item.title || item.show_title || item.showTitle || "").trim(),
    showTitle: show ? String(item.show_title || item.showTitle || item.title || "").trim() : undefined,
    ids,
    season: item.season == null ? undefined : Number(item.season),
    episode: item.episode == null ? undefined : Number(item.episode),
    providerItemId: item.provider_item_id || item.providerItemId,
  };
}

export async function handleDroppedTitles(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "GET") return sendJson(res, { items: listDroppedTitles().map(withPoster) }, 200, { "Cache-Control": "private, no-store" });
  if (req.method !== "POST") return methodNotAllowed(res);

  let body;
  try { body = await readJson(req); } catch (error) { return sendJson(res, { error: error.message || "Invalid JSON body" }, 400); }
  const item = body?.item;
  if (!item || typeof item !== "object" || Array.isArray(item) || typeof body.dropped !== "boolean") {
    return sendJson(res, { error: "item and a boolean dropped value are required" }, 400);
  }
  const mediaType = String(item.media_type || item.mediaType || item.type || "").toLowerCase();
  if (!["movie", "episode", "show", "tv", "series"].includes(mediaType) || !String(item.title || item.show_title || item.showTitle || "").trim()) {
    return sendJson(res, { error: "A valid movie or show item is required" }, 400);
  }

  let providerDismissals = [];
  try {
    const config = await loadMediaConfig();
    let result;
    if (body.dropped) {
      // Capture the rail identities before persisting: the projection filter
      // hides this title as soon as dropTitle bumps the queue generation.
      let projectionError = null;
      let providerItems = { plex: [], emby: [], jellyfin: [] };
      try {
        const projection = await buildUpNextProjection({ mediaConfig: config });
        providerItems = railIdentities(item, projection.items);
      } catch (error) {
        projectionError = error;
      }
      result = dropTitle(item);
      if (!result) return sendJson(res, { error: "Could not identify this title" }, 400);
      providerDismissals = await hideUpNextAcrossProviders({ ...config, jellyfin: {} }, normalizedHideMedia(item), { ...body, provider_items: providerItems }, { lane: "interactive" });
      if (config.jellyfin?.baseUrl && config.jellyfin?.userId) providerDismissals.push({
        target: "jellyfin", status: "unsupported",
        details: "Dropped in Plekt. Jellyfin cannot hide an existing rail entry without changing watch state or resume progress; both were preserved.",
      });
      if (projectionError) providerDismissals.unshift({ target: "up_next_projection", status: "failed", details: projectionError.message || "Could not resolve queued provider items" });
    } else {
      result = { removed: undropTitleForMedia(item) > 0 };
    }
    await refreshUpNextAfterMutation(config, "handleDroppedTitles");
    return sendJson(res, { ok: true, dropped: body.dropped, result, providerDismissals }, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    console.error("Dropped title update failed", error);
    // The local drop is deliberately durable even if provider hiding or queue
    // refresh fails; provider outcomes are returned when available.
    return sendJson(res, { error: "Dropped title update failed", dropped: listDroppedTitles().some((row) => isSameDroppedTitle(row, item)), providerDismissals }, 500);
  }
}
