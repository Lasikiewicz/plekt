# Metadata Sources (TMDB, TheTVDB, Fanart.tv, OMDb, YouTube)

Where movie/TV metadata comes from, how the sources are split, and how everything is
cached. The frontend never talks to a metadata API directly - the server proxies and
caches every source (the CSP is `connect-src 'self'`).

## Files

| File | Role |
| --- | --- |
| `server/src/utils/tmdbGateway.js` | TMDB gateway + merged TV details assembly, discovery feeds, collection search/details; caches in `tmdb_metadata_cache`, `tmdb_search_cache`, `tmdb_person_cache` |
| `server/src/utils/tvdbGateway.js` | TheTVDB v4 gateway; caches in `tvdb_metadata_cache`, `tvdb_season_cache` |
| `server/src/utils/fanartGateway.js` | Fanart.tv artwork (posters, season posters, backdrops, HD logos); caches in `fanart_cache` |
| `server/src/utils/omdbGateway.js` | OMDb - IMDb rating/votes by IMDb id (`omdb_cache`, 7-day TTL) |
| `server/src/utils/nextAiringCache.js` | File-backed next-airing cache used to narrow Upcoming page episode lookups |
| `server/src/utils/tmdbClient.js` | Thin poster-URL helper for the poster pipeline's TMDB fallback |
| `public/modules/tmdb.js` | Frontend fetch + in-memory cache over the `/api/tmdb-*` endpoints |

## What the cached TMDB document holds

The cached document is trimmed before it is stored, so the detail pages are not
paying to carry data nothing renders:

- Streaming availability is kept only for the regions the detail page reads
  (`GB` and `US`). TMDB returns every country it knows about, which was the single
  largest field in a movie document.
- The release-dates block is dropped; nothing in the server or the SPA reads it.
- `status`, `poster_path`, `backdrop_path` and the cached artwork URLs are mirrored
  into their own columns on every write, so grid and card paths read those instead
  of parsing the whole document.

Existing rows were rewritten in place on upgrade rather than being re-fetched, so
no title is requested from TMDB again to gain the smaller shape.

**Resolving a show's TVDB id.** TV details are cached against the TVDB series id,
so that id has to be known before the cache can answer. When a caller supplies only
a TMDB id, the id is read from the already-cached document first; the upstream
lookup runs only when it genuinely is not known yet. That lookup asks TMDB for the
full appended payload, so leaving it on the hot path cost roughly 300ms on every
show and episode page load, cached or not.


## Who provides what

| Data | Movies | TV shows |
| --- | --- | --- |
| Title, overview, status, genres, artwork | TMDB | **TheTVDB** |
| Season/episode numbering, titles, overviews, air dates | - | **TheTVDB** |
| Cast/credits, trailers, reviews, recommendations, watch providers, content ratings | TMDB | TMDB |
| Extra artwork (posters/backdrops/logos gallery) | TMDB + Fanart.tv | TMDB + TVDB + Fanart.tv |
| IMDb rating badge | OMDb | OMDb |
| Trailer titles/metadata | YouTube Data API | YouTube Data API |

The split is invisible to callers: `getTmdbDetails()` / `getTmdbSeason()`
(`tmdbGateway.js`) return one merged shape for TV, keyed by TMDB id. The full rationale
and edge cases (remoteIds verification, Specials handling, `DETAILS_SCHEMA_VERSION`
bumping) are in the "TV metadata" section of [architecture.md](architecture.md).

## API keys

- **TMDB** - user-supplied key (Settings → Metadata or `TMDB_API_KEY`). Required for
  metadata-rich pages.
- **TheTVDB** - works out of the box via a built-in shared project key
  (`TVDB_PROJECT_KEY` overrides it); a personal key (Settings or `TVDB_API_KEY`) takes
  precedence and raises the personal rate limit. Bearer tokens are cached ~25 days,
  keyed by a fingerprint of the key in use.
- **Fanart.tv** - built-in shared project key (`FANART_PROJECT_KEY` overrides); an
  optional personal key is passed as `client_key` for a higher limit.
- **OMDb** - optional user key (Settings → Metadata or `OMDB_API_KEY`); enables the
  IMDb rating pill.
- **YouTube** - optional user key; enables trailer metadata via `GET /api/youtube-meta`
  (key sent as an `X-goog-api-key` header, never in the URL).

## Caching

Every gateway throttles requests, de-duplicates in-flight calls (`inflight` maps), and
caches in SQLite:

| Cache table | Contents | TTL |
| --- | --- | --- |
| `tmdb_metadata_cache` | Merged details per item, keyed by `movie_<id>` / `tv_<id>` with TVDB aliases (or `tv_tvdb_<id>` when no TMDB match), stamped with `DETAILS_SCHEMA_VERSION` | 1 day for airing/in-production shows; longer for ended/released |
| `tmdb_search_cache` | Search responses, including negative results, Discover snapshots keyed by feed type/genre, and per-title recommendation responses | Searches: 15 min (1 day for misses); Discover: 15 min with stale-while-revalidate; recommendations: 6 hours (1 day for misses) |
| `tmdb_person_cache` | Person details + credits, `PERSON_SCHEMA_VERSION` | 7 days |
| `tvdb_metadata_cache` | Raw TVDB series/extended responses + title-search results | 14 days active / 180 days archived series; searches 180 days (1 hour for misses; the movie page's Recommended TV Shows lookup, sent with `relatedTvLookup`, reads a miss for 7 days) |
| `tvdb_season_cache` | TVDB season episode lists, built from the cached series payload's episodes (one TVDB call covers every season, stamped with the series fetch time; a series row older than the season TTL is refetched once first); seasons absent from that payload use `/v4/seasons/{id}/extended` | 2 days upcoming / 7 days active / 180 days archived |
| `fanart_cache` | Raw fanart.tv responses per item, key `movies/<tmdbId>` / `tv/<tvdbId>`, including "no artwork" 404 misses | 7 days (1 day for misses) |
| `omdb_cache` | IMDb rating/votes, including HTTP-error negatives (bad key / exhausted quota) | 7 days (6 hours for HTTP errors) |
| `youtube_meta_cache` | Trailer metadata per video ID (oEmbed + optional Data API fields) | 30 days |

Schema-version bumps (`DETAILS_SCHEMA_VERSION`, `PERSON_SCHEMA_VERSION`,
`PROGRESS_CACHE_SCHEMA_VERSION` in `showProgressCache.js`) force refetches after a
shape change - never hand-edit cache rows to migrate them.

Discover snapshots use versioned keys (`discover:v2|<type>|<genre>`) in
`tmdb_search_cache`. A normal `/api/discover` request returns the last successful
snapshot immediately, starts a background refresh when that snapshot is older than
15 minutes, and only increments the shared `cache_versions.discover` generation when
the feed payload changes. The same response adds a bounded personalized rail by combining
TMDB recommendations for distinct movies and shows watched in the rolling last 12 months.
Those per-title responses are cached separately so a watch-state refresh does not rebuild the
public rails. Every rail removes titles already present in the user's watched history before it
reaches the browser.
`/api/live-updates` carries the Discover generation so open pages can re-read changed TMDB
snapshots without waiting for the TMDB calls in the foreground.

A show whose episode total cannot be resolved stamps `total_checked_at` in the progress
cache and waits seven days before trying again, so an unresolvable title does not repeat
the same failing lookups on every start. See [tv-shows.md](tv-shows.md).

Library-added webhooks and newly observed provider Up Next items enqueue the show/movie in a
single background metadata warm-up queue. The scheduler also scans active `playback_progress`
(the Part Watched source) and known watch history as a restart/import backstop. Queue work is
deduplicated and serialized through the gateway throttle, with visible media-page requests
given priority over queued warm-up work. It refreshes missing-artwork, light, or stale rows,
so a temporary provider failure is retried automatically rather than waiting
for a dashboard or show-page visit. Settings → Advanced → Storage & cache (`/settings/advanced#storage`, `GET /api/cache-stats`,
`POST /api/clear-cache`, handlers in `index.js`) reports and clears the caches;
`POST /api/refresh-tmdb-metadata` (and the TVDB-scoped `POST /api/refresh-tvdb-metadata`)
queue a whole-library refresh as a cancellable background job and return immediately
(`202`); `GET` on either endpoint polls the same job's live log and result. Running the
whole pass server-side means it survives closing the settings panel, navigating away, or
reloading the page - the poll just re-attaches to whatever job is already running.

TV Fix Match uses the same queue with the selected TVDB series identity as an explicit
warm-up item. It first clears stale show metadata and artwork associations, then queues
the corrected series so cache-only dashboard cards can resolve the new poster without a
prior show-page visit. The interactive dialog also requests the full merged details
record and refreshes the compact dashboard snapshot before closing when that provider
request succeeds; a provider outage leaves the rematch saved and the queued warm-up
available for a later retry. `POST /api/rematch-show` reports this server-side work as
`metadata_refresh: "queued"`.

## API endpoints (all admin-authenticated, all in `server/src/index.js`)

Trakt replacement reads a complete show history snapshot and keeps Trakt-only plays at their
current canonical episode numbers, including numbers that overlap Plekt's old structure.
Missing target plays are added and verified before only uniquely identified old history IDs
are removed. Already-correct plays are not re-added. If a new date would share an occupied
target, replacement refuses before writing: Trakt can disable multiple plays and replace the
existing date even for an append request. Ambiguous imported rows stay for review; an imported
row proven by its Trakt date and coordinates can be repaired into the stored numbering while
retaining its canonical Trakt override. Only inbound polling advances the history import cursor.

Single and batch marks, Force Sync, restore replay and retry all apply the same outbound
numbering rules. An unmatched translated episode fails closed instead of sending stored
coordinates to Trakt. Cached inbound maps also cover the first Trakt import before Fix Match.
Background metadata warming fills the recent stored TVDB seasons needed by translated Up Next
cards (two active seasons and their successors, at most four serial reads); dashboard reads
remain cache-only.

| Endpoint | Backing |
| --- | --- |
| `GET /api/tmdb-details` (alias `media-details`) | `getTmdbDetails` - merged movie/TV details |
| `POST /api/tmdb-details-batch` | Batched details for explorer prefetch (bounded worker pool; items may set `light: true` to skip next-airing/artwork enrichment on cold fetches - light-cached rows are refetched in full by detail pages) |
| `GET /api/tmdb-season` | Season episode list (TVDB-backed for TV). Takes `tmdbId` or, for series that only exist on TVDB, `tvdbId` |
| `GET /api/tmdb-person` | Person details + filmography |
| `GET /api/tmdb-search`, `GET /api/tvdb-search`, `GET /api/media-search` | Remote + local search. `tmdb-search` accepts `movie`, `tv`, `multi`, or `person`; `media-search` returns `local`, `discovery` (TMDB movies/shows), `people` (a separately paged TMDB people search), `collections`, and `tvdb` results, all queried in parallel. `tvdb-search` result lists are cached so the shared TVDB key survives per-keystroke searching |
| `GET /api/tmdb-collection?id=` | Cached TMDB collection/franchise details and movie members |
| `GET /api/discover?mediaType=&genre=` | Cached TMDB feeds for trending, movies currently in theatres, popular/upcoming or on-air titles, optional genre browsing, and a watch-history recommendation rail. The theatrical rail follows TMDB release data and is not a local cinema or streaming-availability check. Watched titles are filtered from every rail, and titles dismissed with Discover's **Don't recommend** action are filtered from the personalized rail. Normal requests serve the cached snapshot and revalidate stale data in the background; `refresh=1` rebuilds before responding. Requires a reachable TMDB API key |
| `POST /api/discover/dismiss` | Persist a movie or TV TMDB id as excluded from the personalized Discover recommendation rail. |
| `GET /api/tmdb-images`, `GET /api/tvdb-images`, `GET /api/fanart-images` | Artwork galleries for the edit-image dialog |
| `GET /api/season-posters`, `GET /api/season-poster-options` | Saved/current season posters for the Season Posters tab, and TMDB/TVDB/fanart.tv options for one season (`routes/seasonArtwork.js`; provider options are demo-disabled) |
| `GET /api/show-season-source/preview?tvdbId=&tmdbId=&source=`, `POST /api/show-season-source` | Fix Match per-show TVDB/TMDB choice (`routes/showSeasonSource.js`). The preview returns the rows' detected numbering, episode and watch-row counts and the episodes with no partner, without writing. The save needs `confirm: true`, recomputes that preview, stores the choice, and refreshes show progress. Watch rows keep their stored numbers; the show page places them by translation. Demo-disabled |
| `GET /api/show-season-source/trakt-preview?tvdbId=&tmdbId=`, `POST /api/show-season-source/trakt-replace` | Second Fix Match confirmation (`routes/showSeasonSource.js`, `utils/showTraktReplace.js`). The preview returns episode and play counts and the review list without calling Trakt; replacement needs `confirm: true`, verifies target numbers and history, preserves Trakt-only plays, and writes per-row Trakt overrides. Conflicting occupied targets refuse before writing. A show with a translated choice is skipped by scheduled override reconciliation. |
| `GET /api/tmdb-poster`, `GET /api/tmdb-profile` | Image proxies (rate-limited 300/min) |
| `GET /api/remote-artwork` | Downloads and caches fanart.tv / TVDB / TMDB artwork by URL, then redirects to `/media/...` (see [posters-artwork.md](posters-artwork.md)) |
| `GET /api/omdb-rating` | IMDb rating pill |
| `GET /api/youtube-meta` | Trailer metadata |
| `GET /api/upcoming?month=YYYY-MM` | Future TV episodes for the Upcoming calendar. `&revalidate=1` answers from the persistent cache and rebuilds the month behind the response; `&refresh=1` rebuilds before responding (see [upcoming.md](upcoming.md)) |
| `POST /api/refresh-tmdb-metadata`, `POST /api/rematch-show`, `POST /api/rematch-tv-shows` | Cache refresh / identity fixes |

## Frontend

`public/modules/tmdb.js` wraps the endpoints with in-memory caches
(`state.tmdbDetailsCache`, `state.tmdbSeasonCache`) and helpers like
`resolveEpisodeTitleFromTmdb` that upgrade "Episode 5" labels to real titles as data
arrives. Explorer prefetch (`observeExplorerTmdbPrefetch`) warms details for visible
cards.

The Discover page keeps provider failures actionable: a missing TMDB key links to
Settings → Metadata, transient TMDB/network failures offer a retry, and a stale local
server build asks the operator to restart Plekt. The selected rails, including the
personalized recommendation rail, are restored from a bounded browser cache before the
first request, then refreshed from the server cache when its SSE Discover version changes
or watch state changes. Watched titles are hidden rather than shown with a watched badge.
Choosing **Don't recommend** on a Discover card removes that movie or show from the personalized
rail immediately and saves the exclusion on the server, so it remains excluded after a refresh
or on another browser.
Discover never depends on a media server or Trakt connection.

Background frontend lookups are debounced into bounded batches of up to eight items, and a
batch answers only once its slowest item resolves. Detail pages therefore pass `{ immediate: true }` to
`fetchTmdbDetails`, which sends that single item on its own request so a visible page
never waits behind explorer prefetch work. Dashboard history and Up Next rendering are
cache-only: they use local rows, cached artwork, and cached metadata, and never initiate
TMDB/TVDB requests. If an episode has no trusted series id, its title is used without
promoting an episode-level provider id into a TV-series lookup.
