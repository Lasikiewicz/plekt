# Movies Page

The `/movies` library view: a poster grid (or list) of every movie in the watch
history, with search, sort, alpha filter, and infinite scroll. Clicking a movie opens
the movie detail page ([media-detail.md](media-detail.md)).

## Files

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | All Movies-page rendering and data loading (`renderMovieExplorer`, `loadExplorerMovies`, `renderMovieCard`, sort/search/paging helpers) |
| `server/src/index.js` | `handleMovies` - `GET /api/movies` |
| `server/src/utils/dataRepo.js` | `queryMovies` + `getCachedMovies` - the derived movie list |
| `public/modules/images.js` | Poster markup + hydration for the grid, `posterOverflowMenu` (the three-dot button) |
| `public/modules/poster-menu.js` | Builds/positions the three-dot dropdown (Edit watch date / Fix match / Mark unwatched) on demand |
| `public/app.js` | Route `/movies` → explorer view in `movies` mode |

## Data model

A "movie" is derived from `watch_history` rows with `media_type = "movie"`.
`getCachedMovies()` (`dataRepo.js`) groups history rows into one entry per movie
(latest watch wins), memoized in-process and invalidated by `bumpDataVersion()` whenever
history changes. `queryMovies({ search, sort, limit, offset })` filters/sorts/pages that
cache. Sort modes: `title_asc`, `title_desc`, `watched_asc`, and watched-date descending
(default order for recency), plus release/year ordering applied client-side.

Rewatches are collapsed into the same card, not split across multiple cards:
`dedupeMovies`/`collapseMovieCluster` link every `watch_history` row for the same
film into a `playHistory` array of `{ id, watched_at, source }`, one per play. A
movie card shows a "↻ ×N" badge once it has more than one recorded watch (see
[webhooks.md#rewatch-detection](webhooks.md#rewatch-detection) for how a genuine
rewatch gets recorded instead of dropped as a duplicate webhook echo).

## Frontend behavior

- **Route** - `/movies` sets `state.activeView = "explorer"`, `state.explorerMode =
  "movies"`. The Movies and TV Shows pages share the explorer panel and most controls.
- **Paging** - pages of 240 (`EXPLORER_PAGE_SIZE` in `app.js`) with an
  IntersectionObserver sentinel (1200px rootMargin) pre-fetching the next page before
  the user reaches the bottom (`observeExplorerSentinel`). Movie cards merge by provider
  identity (then title fallback), never by poster URL, because different movies can share
  artwork. Both the initial load and later-page fetches show an animated loading indicator.
- **Page cache** - responses are cached per query key in `state.explorerPageCache` and
  persisted to localStorage (`plembfin:explorerPageCache:v3`, 14-day TTL) so revisits
  render instantly. If the saved first page has an older history version, it is shown
  immediately while `/api/movies` refreshes it; the fresh response replaces that page.
- **View modes** - posters or list, persisted per mode (`plembfin:explorerView:movies`);
  poster width is adjustable (`applyExplorerPosterWidth`).
- **Sort** - persisted in `plembfin:explorerSort:movies`; list headers are clickable
  (`applyListHeaderSort`).
- **Search + alpha filter** - the search box filters server-side via
  `GET /api/movies?search=`; the A-Z strip (`updateAlphaFilter` /
  `handleAlphaFilterClick`) jumps within results.
- **TMDB prefetch** - a second IntersectionObserver (`observeExplorerTmdbPrefetch`)
  pre-fetches TMDB details for visible cards so opening a detail page is instant and
  release-year/rating data can enrich cards.
- **Sync pills** - each card can show sync/availability status derived from the watch
  record's `sync_dispatch_telemetry` (`renderMediaSyncPills` and friends in
  `public/modules/sync.js`).
- **Poster overflow menu** - hovering a card reveals a three-dot button
  (`posterOverflowMenu` in `images.js`); clicking it builds and positions a dropdown
  (`poster-menu.js`, portaled to `<body>` so it isn't clipped by the card's own
  `overflow: hidden`) offering Edit watch date, Fix match, and Mark unwatched. These
  reuse the same delegated handlers the movie detail page uses
  (`media-detail-events.js`), but every button carries `data-grid-origin="1"` so those
  handlers patch the card and the in-memory list in place and refresh the current view
  instead of opening the detail page. A confirmed unwatch dims the card, then animates
  it out and removes it from `state.moviesRaw` without a full page reload.
- **Live-update refresh** - a live-update poll's history-version change (a watch or
  unwatch on Trakt, another device, or a background sync) refreshes the grid via
  `refreshMovieExplorerInPlace()` (`explorer.js`) rather than
  `resetMovieExplorer()` + `renderExplorer()`: it refetches the currently-loaded pages
  and swaps `state.moviesRaw` directly without ever emptying it first, so the grid
  never collapses to a "Loading movies…" placeholder and the scroll position is
  preserved. `loadExplorerMovies()`'s own pagination fetch also always bypasses the
  browser's HTTP cache (`cache: "reload"`) for the same reason - `/api/movies` is
  served with `stale-while-revalidate`, which could otherwise hand back a
  pre-mutation response for minutes after a change.

## Related endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/movies?search=&sort=&limit=&offset=` | Paged movie list |
| `POST /api/delete-media` | Delete a movie (and its watch rows) from history |
| `POST /api/manual-watch` / `POST /api/manual-unwatch` | Manual watch-state changes (see [media-detail.md](media-detail.md)) |
| `GET /api/watch-dates?id=` / `POST /api/add-watch-date` / `POST /api/delete-watch-date` | List/add/remove individual watch dates for one movie (see [media-detail.md](media-detail.md)) |
| `GET /api/poster?id=` | Poster hydration (see [posters-artwork.md](posters-artwork.md)) |

## Gotchas

- The movie list is a **derived cache** - if movies look stale after a direct DB edit,
  the `dataVersion` bump was skipped. All repo write helpers call
  `invalidateHistoryDerivedCaches()`; raw SQL edits from outside the process won't.
- Search hits the server, but the alpha filter and some sorts operate on already-loaded
  pages - a movie that hasn't been paged in yet appears once its page loads.
