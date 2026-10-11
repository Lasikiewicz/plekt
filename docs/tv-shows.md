# TV Shows Page

The `/tvshows` library view: a poster grid (or list) of every tracked show, with watch
progress, next-airing dates, hide-watched/hide-ended filters, search, sort, and
infinite scroll. Clicking a show opens the show detail page
([media-detail.md](media-detail.md)).

## Files

| File | Role |
| --- | --- |
| `public/modules/explorer.js` | All TV-page rendering and data loading (`renderShowExplorer`, `loadExplorerShows`, `renderShowRecord`, `loadShowDetail`, season/episode folders) |
| `server/src/index.js` | `handleShows` (`GET /api/shows`), `handleShow` (`GET /api/show`), `refreshNextAiringCache`, `handleRematchTvShows`, `handleMergeShows` |
| `server/src/utils/dataRepo.js` | `queryShows` / `queryShowDetail` / `getCachedShows` - show summaries derived from episode rows |
| `server/src/utils/showProgressCache.js` | Per-show watched/total episode counts (file cache `data/tv_progress_cache.json`) |
| `server/src/utils/nextAiringCache.js` | Next-episode air dates (file cache `data/next-airing-cache.json`) |
| `server/src/utils/tvdbGateway.js` + `tmdbGateway.js` | Season/episode structure and metadata (see [metadata.md](metadata.md)) |

The progress cache recalculates the watched count from SQLite on every queued flush but
reuses a recently resolved TMDB total during a burst. Concurrent flush callers share one
draining promise, and the complete JSON file is atomically replaced only after all queued
titles are current. Logs report calculation, serialization, and write timings separately.
Persistence remains synchronous so an awaited flush is durable when it resolves.

## Data model

A "show" is derived from `watch_history` rows with `media_type = "episode"`, grouped by
`groupShowRows()` in `dataRepo.js`. Rows are grouped by canonical show title and linked
(union-find) when they share any show-level provider id (`show_imdb_id`/`show_tmdb_id`/`show_tvdb_id`)
so a title-only grouping key can't silently merge two distinct real shows that share an
exact title (a reboot/revival, e.g. Scrubs 2001 vs Scrubs 2026), while episode-level provider ids
stay scoped to individual episodes. A row with no show provider id folds into the cluster matching
its canonical title. A lone row whose ids match no established cluster of the same title is
folded into that cluster, but it never lends the cluster its TVDB id: only rows with no TMDB
id or the cluster's own TMDB id supply the show's TVDB id, so a folded 2001 Scrubs watch
cannot give the 2026 reboot's show row a mixed identity. `getCachedShows()` builds one summary per resulting show - earliest/latest
watch, episode count, inherited artwork (first available poster/logo/backdrop from its
episode rows) - memoized in-process and invalidated on any history change.

The client applies the same rule when merging a show's `state.history` preview rows into
its full episode list (`mergeShowWithLoadedHistory()` in `media-detail-show.js`): a row
whose explicit show provider id contradicts the show's is excluded, while episode-level
provider ids on history rows are preserved.

`queryShowDetail()` reads and dedupes every tracked episode row before narrowing to the
requested show, reading SQLite directly rather than the process-wide history cache so an
interactive detail page cannot show a stale watched state right after a manual watch. A
caller resolving many shows in one pass should not pay that per show: pass a single
`loadTrackedEpisodeRows()` snapshot as `episodeRows` instead (see the Up Next note in
[dashboard.md](dashboard.md)).

A title lookup with no id to disambiguate by (`queryShowDetail({ title })`) can still
resolve more than one real cluster under an exact title match - two distinct shows
sharing a name, or a single mismatched import (an ambiguous Trakt title resolving to the
wrong TMDB/TVDB show for one play) sitting alongside the real, well-established one.
`mostRecentShowFirst()` picks between them by recency, but only after checking size
first: a cluster with far fewer watched episodes than another loses even if it was
touched more recently, so one stray recent row can't outrank dozens of correctly
identified ones. Two comparably-sized clusters resolve by recency.

A show stays groupable once every one of its episodes is marked unwatched:
`getCachedShows()` and `queryShowDetail()` group episode rows regardless of each row's
current watched/unwatched `sync_action` (only genuinely untrustworthy rows - an unscoped
library-scan row with no confirming user/timestamp - are excluded). This lets an open
detail page refresh to the correct 0-watched state after its last episode is unwatched.
`queryShows()` excludes groups with no currently watched episodes from `/tvshows`, which
is a watched-history library; this also keeps metadata-less `0/?` orphan groups from
creating ambiguous title-only detail links.

A show's displayed `tmdb_id` (`getCachedShows()`, `queryShowDetail()`) always trusts the
id already recorded on its own watch_history rows over `getCachedShowProgress()`'s
cached one. The progress cache can hold an id resolved from an earlier ambiguous title
search that was never written back onto any row (see the matching comment in
`rematchShowWatchRecords()`); `cachedShowTmdbId()` only returns a candidate that already
has TMDB metadata cached under it, so without this ordering a wrong-but-cached id could
keep permanently overriding a correct-but-not-yet-cached one.

Episode history and Up Next cards have a stricter URL contract than show summaries:
`show_tmdb_id`, `show_tvdb_id`, and `show_imdb_id` are the only fields eligible for a
series URL. The flat `tmdb_id`/`tvdb_id`/`imdb_id` fields may identify the episode, so a
card with no explicit series identity falls back to a title route instead of guessing.

On the client, `renderShowDetailFromMetadata()` (`media-detail-show.js`) matches the
freshly-fetched provider metadata against the show already cached in `state.showsRaw` by
tmdb_id, tvdb_id, or title slug - trying all three, not just tmdb_id/slug, matters right
after a Fix Match rematch: the show's tmdb_id is briefly cleared and re-backfilled in the
background, and `preferredShowTitle()` can legitimately display a title with no trailing
year while the provider's own name still carries one, breaking a slug-only match. Without
the tvdb_id fallback, a show in that window would render from an empty placeholder (0
watched episodes) instead of the real, already-correct data.

`queryShowDetail()` and `rematchShowWatchRecords()` (Fix Match) both look a show up by a
canonical title key (`canonicalTitleKey(showTitleFrom(title))`), never by an exact
`show_title_lower` string match. The same real show's episode rows can carry different
exact show_title text over time - a media server's own title for a show is rarely
year-suffixed even when Plekt's preferred display title is, and a Fix Match rename
only ever touches rows matching whichever exact text its anchor row happened to have - so
an exact match only ever sees one variant, silently missing the rest of the same show's
episodes (or, worse, resolving a different variant to an unrelated show that happens to
share that exact text). `showTitleFrom()` strips the year from both the query and every
row before comparing, so every episode of the show is found and repaired together
regardless of which exact text it carries.

A show's `tvdb_id`, by contrast, is never trusted straight from a watch_history row.
Plex/Emby/Jellyfin webhooks tag an episode with its own TVDB id (TVDB assigns every
episode a unique id, separate from its series), so a raw row's `tvdb_id` is usually
episode-scoped, not the show's. Feeding an episode id into a TVDB *series* lookup (the
`/tvshow/tvdb/:id` route, `openShowImmersiveModalByTvdbId`) can land on a completely
unrelated show whenever the numbers happen to collide. `cachedShowTvdbId()` in
`dataRepo.js` only accepts a candidate once it has already been resolved as a real
series - cached via `getTvdbSeriesExtended()` from a search result, Fix Match, or an
earlier correct visit to the show - the same trust boundary `cachedShowTmdbId()` applies
to its own weaker candidates. A show whose only tvdb_id candidates are unverified
episode-level ids simply has no `tvdb_id` until one is resolved through a trusted path,
rather than risking a wrong-show redirect.

`queryShows({ search, sort, limit, offset, hideWatched, hideEnded })` filters/sorts/
pages that cache. Sort modes include `title_asc`, `title_desc`, `watched_asc`, recency,
and `next_air_asc` (next airing date, powered by the next-airing cache so no metadata
API is hit during page loads).

Rewatched episodes work the same way as movies: `dedupeHistory` (`dataRepo.js`)
collapses every watch of the same episode into one row with a `playHistory` array
of `{ id, watched_at, source }`. The show detail page shows a "Watch History" list
(date + source app per play) on any episode with more than one recorded watch,
in place of the single watched-date line - see [media-detail.md](media-detail.md)
and [webhooks.md#rewatch-detection](webhooks.md#rewatch-detection).

### Watch progress

`showProgressCache.js` maintains watched-vs-total episode counts per show. Totals come
from TVDB/TMDB details using the record's authoritative TVDB identity when present
(specials/season 0 excluded - `PROGRESS_CACHE_SCHEMA_VERSION` is
bumped when the calculation changes shape so stale entries refetch). Genuine
Plekt-tracked watches count, including scheduled library-history detections that carry
both the configured source user and the server's played timestamp. Unscoped scan rows
remain excluded because they are not sufficient evidence of a user watch. Updates are
queued (`queueShowProgressUpdate`) and flushed by the scheduler.

On startup `initShowProgressCache` queues a background refresh for shows that are missing
an episode total, carry a stale `schema_version`, or are absent from the cache entirely.

Show titles are matched by canonical key rather than by an exact `show_title_lower`
comparison. Queued titles have already passed through `showTitleFrom()`, which strips a
trailing `(year)`, so an exact match would miss rows stored as `Robin Hood (2025)`: the
show would never be cached, would be rediscovered as uncached on the next start, and would
be recalculated on every boot without ever succeeding.

A show whose total cannot be resolved - for example a record holding a provider URI where
the title should be - records `total_checked_at` and is not retried for seven days
(`MISSING_TOTAL_RETRY_MS`), instead of re-spending the same failing lookups on every start.
`GET /api/health/sync` reports how many rows hold such a URI as
`dataQuality.opaqueShowTitleRows`.

### Next airing

`nextAiringCache.js` stores `{ nextAiringDate, status }` per show in
`data/next-airing-cache.json`. `refreshNextAiringCache` (in `index.js`, driven by the
scheduler) refreshes stale entries in small batches (default 40 shows per pass), oldest
first - active shows go stale after 6 hours, ended shows after 7 days. This lets the
grid sort by upcoming episode and show "next airs" chips without any per-row API calls.

## Frontend behavior

Shares the explorer infrastructure with Movies ([movies.md](movies.md)): 240-item
pages, IntersectionObserver infinite scroll, persisted page cache, poster/list view
modes, adjustable poster width, A-Z filter, server-side search, TMDB prefetch.
Ordinary sorts append the next page's cards while keeping existing poster nodes mounted.
Next Airing moves mounted cards into their updated order as metadata or another page
arrives, and refreshes the visible next-airing cells without rebuilding the list. TV page
cache entries revalidate after 30 minutes even when watch history is unchanged, since
the server's next-airing cache updates independently.

TV-specific extras:

- **Show artwork** - library cards and the detail-page header use the shared series poster;
  episode cards use their matching season poster when that artwork is cached.
- **Hide watched / hide ended** toggles, persisted in `plembfin:hideWatched:shows` /
  `plembfin:hideEnded:shows`, passed through to `GET /api/shows`.
- **Progress bars** on cards from the show progress cache.
- **Next-airing chips** and the `next_air_asc` sort; `scheduleNextAirResort` re-sorts
  the rendered grid when fresher airing data arrives.
- **Season/episode folders** - the list view can expand a show into seasons and
  episodes (`renderShowFolder` / `renderSeasonFolder`, expansion state in
  `state.expandedShows` / `state.expandedSeasons`).

## Show identity maintenance

The batch TV re-match tool is under **Settings → Tools → Library Rebuilds**
(`/settings/tools#library-rebuilds`); the merge action is available from a show page:

- **Merge shows** (`POST /api/merge-shows`, `mergeShows` in `dataRepo.js`,
  dialog in `edit-dialogs.js`) - folds one show title's episode rows into another.
- **Re-match TV shows** (`POST /api/rematch-tv-shows`) - re-resolves shows against
  TMDB/TVDB when the automatic match picked the wrong series.
- **Fix Match on a show page** (`POST /api/rematch-show`) - stamps the selected TVDB
  identity across every episode in one transaction and refreshes remote-derived
  metadata in the background. The picked series name is sent as `new_show_title`
  and, when it differs from the stored name, is written to every episode's
  `show_title` and title alongside the identity. A show's route key is derived from
  its name, so renaming moves it to a new URL and the UI navigates there - this is
  what lifts an "Unknown Show" group onto its real title.
- `backfillUnknownShowTitles` (run at boot from `server.js`) fixes episodes stored
  with an "Unknown Show" title once a better title is known.

## Related endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/shows?search=&sort=&limit=&offset=&hideWatched=&hideEnded=` | Paged show summaries |
| `GET /api/show?id=` / `?title=` | One show's full detail (seasons, episodes, watch rows) |
| `GET /api/tmdb-details` / `GET /api/tmdb-season` | Metadata + episode lists for the detail page |
| `POST /api/merge-shows`, `POST /api/rematch-show`, `POST /api/rematch-tv-shows` | Identity fixes |
| `GET /api/watch-dates?id=` / `POST /api/add-watch-date` / `POST /api/delete-watch-date` | List/add/remove individual watch dates for one episode (see [media-detail.md](media-detail.md)) |
| `POST /api/update-watch-dates` | Update selected existing season/show watch rows atomically; never inserts history rows |
