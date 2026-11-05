import { createPerUserState } from "./perUserState.js";

// Every history-derived cache belongs to one user's data folder. Each user has
// its own data-version counter, so a slot keyed only by the version let the
// admin and an added user at the same number read each other's rows (app audit,
// 5 November 2026). Functions take this object once at their start, so a build
// that yields still stores its result for the user it was built for.
const HISTORY_CACHE_RESIDENT_USERS = 8;
export const historyCaches = createPerUserState(() => ({
  historyCache: { version: null, rows: [] },
  // History pages return episode rows, but each row also needs the canonical
  // artwork and series identity from its show. Build that lookup once per
  // history generation instead of regrouping the entire episode library for
  // every page, filter, or pagination request.
  historyArtworkCache: { version: null, byId: null, byMediaKey: null, byCoordinate: null },
  historyArtworkBuilds: new Map(),
  showCache: { version: null, shows: [] },
  historyPreviewCache: { version: null, rows: new Map() },
  historyPreviewBuilds: new Map(),
  // The includeScheduledLibraryHistory variant returns a different show set, so it
  // needs its own slot. Without one it was recomputed from the full watch history
  // on every call - the Upcoming calendar asks for it once per month requested.
  scheduledShowCache: { version: null, shows: [] },
  movieCache: { version: null, rows: null },
  movieSummaryCache: { version: null, rows: null },
  statsCache: { version: null, stats: null },
  // A cache invalidation can wake several API requests at once (for example while
  // a Plex season notification is updating sibling episodes). Keep one rebuild in
  // flight per show-set variant so those requests share the expensive synchronous
  // per-show work instead of multiplying it and starving the HTTP health check.
  showCacheBuilds: new Map(),
}), { maxEntries: HISTORY_CACHE_RESIDENT_USERS });
