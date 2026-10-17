// Fills in overview and release date for personal ratings, watchlist, and
// custom-list items that were saved without them, and shares what one
// collection learned with the others. Split from personal-media.js, which owns
// loading and rendering those collections.
import { state } from "./state.js?v=2.1.0.0.3";
import { fetchTmdbDetails } from "./tmdb.js?v=2.1.0.0.3";

let personalMetadataHydrationPromise = null;

export function personalMetadataItems() {
  return [
    ...(state.personalRatings || []),
    ...(state.personalWatchlist || []),
    ...(state.personalLists || []).flatMap((list) => list.items || []),
  ].filter(Boolean);
}

// Items the visible page shows. Discover reads across all three collections.
function visiblePersonalMetadataItems() {
  if (state.activeView === "discover") return personalMetadataItems();
  if (state.personalMediaTab === "ratings") return state.personalRatings || [];
  if (state.personalMediaTab === "lists") return (state.personalLists || []).flatMap((list) => list.items || []);
  return state.personalWatchlist || [];
}

// fetchTmdbDetails() keeps its own session cache, so revisiting a page does not
// ask TMDB again; this only decides which items are worth asking about.
export function hydratePersonalMetadata({ normalizeItem }) {
  if (personalMetadataHydrationPromise) return personalMetadataHydrationPromise;
  const targets = visiblePersonalMetadataItems().filter((item) => item && (!item.overview || !item.release_date));
  if (!targets.length) return Promise.resolve(false);

  personalMetadataHydrationPromise = Promise.allSettled(targets.map(async (item) => {
    const normalized = normalizeItem(item);
    const isEpisode = normalized.media_type === "episode";
    const mediaType = isEpisode ? "tv" : normalized.media_type;
    const tmdbId = isEpisode ? (normalized.show_tmdb_id || normalized.tmdb_id) : normalized.tmdb_id;
    const title = isEpisode ? (normalized.show_title || normalized.title) : normalized.title;
    const details = await fetchTmdbDetails(mediaType, tmdbId, title, {
      imdbId: isEpisode ? normalized.show_imdb_id : normalized.imdb_id,
      tvdbId: isEpisode ? normalized.show_tvdb_id : normalized.tvdb_id,
    }, { light: true });
    if (!details) return false;
    let changed = false;
    if (!item.overview && details.overview) {
      item.overview = details.overview;
      changed = true;
    }
    if (!item.release_date && (details.release_date || details.first_air_date)) {
      item.release_date = details.release_date || details.first_air_date;
      changed = true;
    }
    return changed;
  })).then((results) => results.some((result) => result.status === "fulfilled" && result.value === true))
    .finally(() => {
      personalMetadataHydrationPromise = null;
    });
  return personalMetadataHydrationPromise;
}

export function propagatePersonalMetadata(keyFor) {
  const sourceByKey = new Map();
  for (const item of personalMetadataItems()) {
    const key = String(item.media_key || keyFor(item));
    if (!key) continue;
    const source = sourceByKey.get(key) || {};
    if (!source.overview && item.overview) source.overview = item.overview;
    if (!source.release_date && item.release_date) source.release_date = item.release_date;
    sourceByKey.set(key, source);
  }

  let changed = false;
  for (const item of personalMetadataItems()) {
    const source = sourceByKey.get(String(item.media_key || keyFor(item)));
    if (!source) continue;
    if (!item.overview && source.overview) {
      item.overview = source.overview;
      changed = true;
    }
    if (!item.release_date && source.release_date) {
      item.release_date = source.release_date;
      changed = true;
    }
  }
  return changed;
}
