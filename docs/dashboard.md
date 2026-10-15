# Dashboard

The home view (`/`): Now Playing, one mixed Up Next rail, and Watch History with separate
TV-show and movie rows. Part Watched ("continue watching") belongs in Up Next; the recent
history rows contain completed watches only.

## Files

| File | Role |
| --- | --- |
| `public/modules/dashboard.js` | Dashboard rendering (`renderDashboard`, completed-history rows, mixed Up Next cards, compatibility progress-card renderer, dedupe helpers, poster observer) |
| `public/modules/up-next.js` | Cached Up Next loading/rendering and shared media-card presentation |
| `public/modules/media-card.js` | Shared media-card normalization, navigation, poster, metadata, status, and badge contract |
| `public/modules/sync.js` | Now Playing polling + rendering (`loadActiveSessions`, `renderActiveSessions`, `startHistoryPolling`) |
| `server/src/index.js` | `handleNowPlaying`, `handleHistory` (`?limit=` preview), `handlePlaybackProgressList`, `handleUpNext` |
| `public/app.js` | Route `/` -> dashboard view; history preview loading + localStorage cache |

## Sections

### Now Playing

Fully documented in [now-playing.md](now-playing.md): the merge of
`live_tracking_cache` (scheduler polling) and `active_sessions` (webhook `active`
events), polled by the browser every 10 seconds with visibility gating.
The episode label and playback progress use the active appearance accent, matching
Part Watched, while the green Live indicator remains a semantic playback-status color.
On the dashboard, the section keeps a small inset from the page edge, and the no-media
state stays transparent so it follows the surrounding surface in both themes. If a
connected media server cannot refresh its provider feed, the dashboard identifies that
server, keeps the last usable queue visible, and offers a Retry connection action. The
background scheduler retries only the affected provider every two minutes by default;
the normal multi-provider catch-up remains on its longer cadence. An outage is noticed
without waiting for either: when the Now Playing session poll (about every 45 seconds)
cannot reach a server whose feeds last succeeded, that server's feeds are re-read at once
(at most every two minutes per server), so the status line appears within about a minute.

In the modern style, the Now Playing panel holds three items by default. Live sessions come
first; the remaining slots (all of them when nothing is playing) feature the Up Next rail's
part watched items, then its other Up Next items, and a featured item is hidden from the rail
so nothing shows twice. A cog beside the heading opens the panel options: **Allow part watched
items here**, **Allow Up Next items here** (both on by default), and the number of items (1 to
3). Every change saves at once, for the whole server.

### Up Next

The dashboard's Up Next section is a single mixed queue of movies and TV episodes.
On a fresh page load or dashboard re-entry after the current snapshot expires, saved
history and Up Next cards stay hidden while fresh server data loads. The server also
refreshes playback and queue state in the background, so updates do not depend on the
dashboard being open.
While an item is in Now Playing, its Up Next card (same show, season and episode, or the same
movie title) moves to the top of the Up Next rail (client-side, `nowPlayingFirst()` in
`public/modules/up-next-shared.js`). Each show has at most one card:
a part-watched episode with a known position wins over that show's next-up card, and of several
part-watched episodes the most recently updated is kept (`collapseUncertainEpisodeQueues()`).
`GET /api/up-next` combines actionable canonical resume progress with released `next_up`
episodes from provider observations and a local cache-backed fallback. For TV shows, the media
detail page's episode watch state is the source of truth: the first released episode not marked
watched there is the only eligible next episode. Provider Resume/Next Up data may contribute
native item IDs, artwork, and progress, but cannot jump past that episode. Two shows count as
the same show only when no TMDB or TVDB show id disagrees, so a same-title reboot (Scrubs 2001
and 2026) keeps its own next-up card and cannot hold back or replace the other show's; the
one-card-per-show collapse of provider next-up rows splits on the same rule. A local fallback
episode is included only when an active provider observation confirms that exact show and
season/episode coordinate exists in a connected media-server library; local history and metadata
alone do not create a Watch now card. Resume cards always come first and are ordered newest-first
by the parsed authoritative progress-update time, so the last part-watched item stays at the front
even when a timestamp is stored as date text. Next-up cards then prioritize the show whose episode
was watched most recently, with show/season/episode order as the deterministic tie-breaker. A matching
resume and next-up observation becomes one resume card. An episode listed in a provider's
Continue Watching or Resume rail with no playback position (Plex lists the next episode there
with no offset) is a `next_up` card, not a 0% resume; any real position keeps it a resume. The builder is bounded to the most
recently active shows and a small number of candidate seasons, and reads TMDB/TVDB metadata
only from SQLite. Missing or stale metadata is queued by library-added/provider-feed discovery
and refreshed by the single background warm-up worker, so a dashboard render cannot create an
outbound provider burst. Canonical local resume cards remain usable without a provider
connection.

Series identity is filled in from the local library before the projection is returned
(`showIdentityIndex` / `withLocalShowIdentity` in `upNextService.js`). Provider Next Up feeds
regularly omit series-level provider ids, leaving an episode carrying only its own - and an
episode's TMDB id is not its show's, so a series route built from one resolves to nothing and
pays a full cold lookup before falling back. An id the provider did supply is never
overwritten, and a title held by more than one show with differing ids is left empty rather
than guessed, because inheriting the wrong series id would link to a different show. Episode
ids are preserved unchanged. The result is that Up Next and Watch History link the same
episode to the same route.

Two provider-raw values are rejected before the projection is returned, because both reach
the browser as a visible failure:

- **A series id equal to the episode's own id.** A series id can never equal one of its own
  episodes', so a series field holding the episode id is an observation stored raw rather than
  resolved. It is discarded and the local identity fills the gap; with no local match the item
  falls back to a title route, which beats a route that resolves to nothing.
- **Artwork that only resolves against the media server**, such as a bare Plex
  `/library/metadata/.../thumb/...` path. The browser requests it from Plekt's own origin,
  where it hits the SPA fallback and renders no image. Dropping it hands the card back to the
  normal poster resolution (`/api/poster`, then cached artwork). Cached `/media/...`, `/api/...`
  and absolute `http(s)` URLs are kept as they are.

The browser hydrates the rail from the 24-hour `plembfin:upNextCache:v6` localStorage
snapshot before requesting the network. The server also keeps the completed mixed snapshot
in `data/up-next-cache.json`, so a restart can serve warm data immediately. Dashboard loads
request `/api/up-next?revalidate=1`: a stale snapshot is returned while one background
rebuild runs, and a changed projection advances the `up_next` cache generation. The
`/api/live-updates` stream announces that generation with `up-next-version`; history-version
events also refresh Up Next after watched/progress changes. When the page becomes visible, regains
focus, returns from the back/forward cache, or comes back online, the active history-derived view
revalidates even if its shared version did not change; the dashboard also refreshes Up Next.
Existing cards remain painted while a refresh is in flight, then the refreshed snapshot is
reconciled into the rail.
Background revalidation is limited to once per ten minutes per process. Retained local logs
measured 27 completed rebuilds over 29.95 hours (0.90/hour, 26.24-minute median interval),
so the measured 1.99-second projection cost is infrequent background work rather than a
per-load wait.

When the projection or one of its queue inputs changes, the server also queues a coalesced
automatic provider push. This covers canonical watch/resume changes, provider-feed changes,
and server-side dismissal/restore, and runs through the worker even when the dashboard is
closed. Queue additions, removals, and reorderings are included in the same trigger path, so
provider delivery follows the latest queue content and order. It sends the latest mixed queue up
to the 100-item API bound; the visible dashboard
still renders its smaller card window. The existing header action remains available for an
explicit immediate push, while the scheduled provider-feed catch-up remains the 15-minute
backstop. An add or remove from a media detail page is treated as interactive intent: its
provider push uses a priority worker lane ahead of queued background syncs, while any provider
request already in flight is allowed to finish safely. The projection generation is checked before
serving a warm cache, so the newly selected show is not hidden behind an older rebuild.

Building the projection is synchronous work on the shared event loop, so its cost is a
whole-process cost: while it runs, nothing else is served and no timer fires. That includes
the "background" rebuild, which is background only in the sense that the request does not
wait for its result. Resolving a candidate's playstate therefore normalizes the `playstate`
table once per projection into an alias index (`buildPlaystateIndex` in `upNextService.js`)
rather than re-deriving an identity for every row on every lookup. Keep it that way: the
per-row form ran tens of thousands of times per build, which on a library of a few thousand
rows blocked the process for around a minute per rebuild - long enough to stall every HTTP
request and to expire the 60-second scheduler lease, so the symptom presented as the whole
app freezing rather than as a slow rail.

For the same reason the local-fallback pass reads the episode table once for the whole pass.
`queryShowDetail` reads and dedupes every tracked episode row before narrowing to the show
it was asked about, which is correct for a detail page resolving one show but repeats a
full-table read and dedupe per show when Up Next resolves up to 24 of them. It accepts an
`episodeRows` snapshot for that case, produced once by `loadTrackedEpisodeRows`
(`dataRepo.js`); `groupShowRows` copies every row it keeps, so the shared snapshot is never
mutated by the calls consuming it. Any new caller that resolves many shows in one pass
should hand the same snapshot to each call rather than letting each one re-read.

Up Next normally holds one card per show. The exception is a rewatch from an older season
(`server/src/utils/upNextRewatch.js`): when a show's most recent watched play is behind its
furthest watched episode, and the episode right after that play is released and unwatched, that
episode gets a rewatch card (`up_next_lane: "rewatch"`) beside the show's ordinary next episode
after the furthest one (`up_next_lane: "new"`, only once a media library has it). An episode
already watched never becomes a rewatch card, because Remove marks its episode unwatched
everywhere. A part-watched new episode is the "new" card itself, so the episode after it does not
appear beside it. The native rail refresh skips the "new" card: the apps' rails hold one episode
per show and follow the rewatch. Remove on a show with two cards asks whether to hide that card's
season (`dismissal_scope: "season"`, stored with season aliases only) or the whole show; the
dismissed dialog lists a hidden season as its own entry.

Resume cards show progress, source badges, app links, Watch now, Mark watched, and Clear
progress when a positive playback position exists. The three-dot menu on all Up Next cards
provides Mark watched, Rate, watchlist actions, Clear progress (only for resume items with
real progress), and Remove from up next (to dismiss the card from the queue and clear progress
across connected servers). Removing an episode dismisses its whole show from the rail, while
clearing an episode deletes its
positive progress and marks it unwatched, so a refresh moves it below remaining resumes as a
zero-progress next-up card. Clearing a movie removes it from the queue. Mark watched commits
locally first, deletes the resume row, adds completed history, and then dispatches to connected
providers. Season and show marking uses each episode's release date as a floor when a shared
watch date would otherwise be before that episode aired. Future episodes are excluded initially;
the watch-date prompt offers an explicit **Include unreleased episodes** choice for episodes
watched through an early online release. A failed or partial provider feed keeps the last good observations and displays a
compact source-status message; future episodes remain in the Upcoming view.

The Up Next header action is an authoritative push from Plekt to Plex, Emby, and Jellyfin. It
sends the full loaded Plekt snapshot (up to the API's 100-item bound) and works entirely
through each provider's own native rail. The target mapping is Plex Continue Watching, Emby
Continue Watching (the Resume API), and Jellyfin Next Up. For each ready episode, Plekt
verifies that the target is unwatched, released, and follows a fully watched earlier run, then
refreshes the provider's native calculated rail from the immediately preceding watched episode.
Plex and Emby receive their native watched mark; Jellyfin receives only a merged `LastPlayedDate`
update, preserving its play count, watched flag, and resume position. Genuine part-watches are
never overwritten, and an item that is already part-watched is already on its provider's rail by
that position alone.

The push also forwards known positive resume checkpoints. It only ever adds to the native rails:
an entry the app lists but Plekt's queue does not is reported as left in place and is never
hidden, whether the push is automatic or started from the header (`docs/decisions.md` entry 36).
Jellyfin Continue Watching is read only to protect genuine part-watched progress; it is not the
Jellyfin queue being reconciled. It never adds a card, but when it lists an episode that already
has a resume card it gives that card its Jellyfin item, so Watch now can open the exact episode
there. Removing an item from an app's rail happens only as the direct
result of your own Clear progress or Remove from up next action on that card.

A provider whose every Up Next feed read failed in the same push is treated as unreachable: its
rail is not refreshed and its result reports that it could not be reached, so an outage does not
turn each automatic push into a search for every queued item. Known resume checkpoints are still
attempted. An automatic push that reached every other provider counts as done for that queue, so
the push does not repeat while the provider stays down; the first feed read that succeeds again
queues a push, which refreshes the recovered provider's whole rail.

Plekt no longer maintains a managed `Plembfin Up Next` playlist on any provider; see
`docs/decisions.md` entry 28. An installation upgraded from a build that created one keeps that
playlist until it is deleted by hand in Plex, Emby, or Jellyfin.

Beside it, a count button opens the dismissed-items dialog. Dismissals are stored server-side in
`up_next_dismissals` and applied inside the projection, so the queue is the same on every device
and for every consumer, including the API and anything scheduled. They were browser-local until
`docs/decisions.md` entry 23; a browser holding pre-migration dismissals posts them once on first
load and then clears its stored copy. An episode dismissal keeps show identity as well as the
item's aliases and show/season/episode coordinate, so removing one episode keeps the whole show
out of the rail across re-matches and provider id changes. A dismissed show returns when one of
its episodes has a newer real playback position. Adding one back clears the dismissal and then
runs the authoritative push, so every connected server mirrors the restored queue.

The local fallback can queue the detail page's first unwatched released episode even when no
provider feed mentions it. Watch history only records a native provider item id once something
has been played, so a next unwatched episode never carries one; the projection resolves it against
the configured Plex, Emby, and Jellyfin libraries with the same lookup the push uses
(`upNextLibraryLookup.js`), caching hits for six hours and misses for two hours, so a newly added next episode can take up to
two hours to appear. For a show whose known episodes are all watched, the projection reads the
show's full episode list from each library to find an episode the metadata does not know yet; that
list is kept for thirty minutes. A lookup that
fails (the server is unreachable or returns an error) is not cached as a miss; instead that provider's
lookups stand down for one minute, so an outage costs one failed request per minute rather than one
per show on every rebuild, and cached answers keep being used meanwhile. Each build that uses the
real library lookups writes one `Up Next build:` line to the diagnostic log with its duration and
how many library lookups and series inventories were live, cached, or skipped for the per-build
budget of 32 live lookups; a build with no live lookups means both caches are full. The lookups a
build skips for that budget are then asked in the background, 32 at a time with a two-second pause
between batches, so the next rebuild finds them cached; one top-up runs at a time and writes one
`Up Next lookup top-up:` line when it finishes. An episode
that no configured library contains is still not queued. A show manually added to Up Next is also
eligible before its first watch, but a show whose current records are all explicit unwatch actions
is excluded, so a deliberate clear cannot be resurrected by a stale Continue Watching or Next Up
row. A fully completed show is removed from the rail as well, including stale provider Next Up
observations; a later released episode can make the manually retained show eligible again. An
episode-level unwatch remains an authoritative unwatched state for selecting the next episode and
cannot be skipped by a stale provider card.

Episode cards build series routes only from explicit `show_*` identities. An episode-level
`tmdb_id`, `tvdb_id`, or `imdb_id` is never substituted into a `/tvshow/<provider>/<id>`
route; if the series identity is unavailable, the card uses the title route and keeps the
episode coordinates. Dashboard history cards render from the local payload and cached artwork;
they do not prefetch TMDB or resolve missing posters during the dashboard render (a missing
poster remains a placeholder). A scheduler warm-up pass scans active Part Watched rows as
well as completed history and retries missing-artwork metadata, so a temporary provider
failure is repaired without requiring a dashboard visit. Visible detail requests remain
isolated and immediate when a user opens a media page.

### Recent history

`GET /api/history` (preview limit 120) rendered as either **cards** or **posters**
(toggle persisted in `plembfin:dashboardHistoryView`), filtered all/movies/shows, fit
to two rows of whatever the viewport holds (`getRowFitLimit`,
`updateDashboardSplitState` re-fits on resize). Same-day duplicate rows are collapsed
(`dedupeMediaRecords`) so webhook echoes don't crowd the rail. The rendered payload is
cached in localStorage (`plembfin:dashboardHistory:v1`, 14 day TTL, revalidated on every load) for instant paint on
reload; the `X-Now-Playing-Refresh` header from the now-playing poll signals when to
re-fetch.

Each card shows poster, platform badge, sync-status pill, and links into the media
detail page ([media-detail.md](media-detail.md)). On episode cards the Season/Ep line sits
directly under the episode name, and "Last Played" sits directly above the app used. Up next
cards show no availability line; a resume card's progress bar sits above its Watch now apps.
When season artwork is cached, episode cards use the poster for their own season. The TV Shows
library and the show detail header continue to use the shared series poster.
The Explorer's cards (Movies and TV Shows pages, built by the same renderer) keep "Watched
Twice" / "Watched N Times" under "Last Played" (`actualWatchLabel` in `dashboard.js`, driven by
`watch_count`, falling back to `playHistory.length`, as on the movie detail page's rewatch
history) and keep Season/Ep in the meta block.

Episode cards always prefer the episode *name* stored on the watch record
(backfilled to a real name at ingest when a media server only reported a coordinate). When a
dashboard history row has only a coordinate, its existing metadata enrichment path runs once in
the background and updates the visible episode label without repainting the card. A row that has
been explicitly verified as title-less displays "No title provided" rather than a misleading
episode number.
Installations that recorded watches before that ingest behaviour can run
Settings → Tools → Database Repairs → **Restore Missing Episode Names** to scan the full
library, filling names from stored/cached metadata and provider seasons. The repair tracks
resolved, retryable, and verified-no-title rows separately, so a confirmed absence is not shown
again as an actionable missing-name row.

### Watch History and legacy progress compatibility

`GET /api/playback-progress` lists positive resume records from the
`playback_progress` table for compatibility with older embeds and non-dashboard tooling.
The dashboard uses the unified `/api/up-next` response for resume cards and does not make a
separate Part Watched request or prepend resume rows to recent history. Completed TV/movie
rows are limited to canonical watched records. The compatibility `loadPartWatched` /
`renderPartWatched` helpers are available to explicit legacy panels; they are not part of the
current dashboard shell.

The displayed percentage on a resume card is derived from the saved playback position and
duration when both are available, so an incomplete percentage field from a webhook cannot
show `0%` for an item with real resume progress. SSE history/up-next events fetch the
authoritative snapshots in the background; the dashboard reconciles the visible rows and
rail without a full page reload or dashboard-wide rerender.

The legacy Part Watched card reconciler operates per card rather than diffing its
whole panel as one block: when a refresh returns the same set of items in the same order,
it patches only each card's progress bar, "% watched" text, and "Last Played" timestamp
in place (`patchPartWatchedCardProgress`) and never touches the poster `<img>` or rebuilds
the card's DOM node. The mixed Up Next rail uses stable canonical IDs and the same
no-flash refresh behavior; a resume-to-next-up transition is a deliberate membership
and priority change, so it is refreshed from the server instead of being hidden by a
client-side dismissal.

Removing an item from Up Next animates the dismissed tile out of the rail before the
fresh snapshot replaces it: the exit runs in place (`dashboard-card-exit`), and an
overlapping refresh waits for the animation to finish before repainting, so the tile is
never yanked away mid-fade. Items that become watched somewhere else (e.g. completed on
a connected media server or marked watched from a detail page) leave Up Next the same way:
the server projection is authoritative and drops them, and the `/api/live-updates`
`up-next-version`/history events pull the updated snapshot in. The rail never paints the
same episode twice: the merge unifies the same next-up episode even when it is keyed
under two identity sources (a native server series id, e.g. `series:jellyfin:…`, versus
the verified external show id), reuniting them into one card when the show, season/episode,
episode title, and resolved airing year all agree - while a re-release/reboot that shares a
title and coordinate but aired a different year (or is a different episode) stays its own card.

### Version badge / update check

The sidebar version badge is populated from `/api/changelog` on dashboard load; see
the "Changelog & update check" section of [architecture.md](architecture.md).

### Background sync indicator

A sync line sits above the version badge on every page. It reads "Sync - Idle" when
nothing is being dispatched and "Sync - N of M" while Plekt is actively pushing
watch-state changes out to Plex/Emby/Jellyfin/Trakt - the scheduler's pending-dispatch
queue working through a backlog, a bulk duplicate-watch cleanup, a manual
watch/unwatch, anything. The indicator is driven by the `sync-progress` events on the
`GET /api/live-updates` SSE stream (`onSyncProgress` in `live-updates.js`, rendered by
`renderSyncProgress` in `app.js`); see the "Manual dispatch queue" part of
[scheduled-sync.md](scheduled-sync.md#what-it-does-each-run) for where the underlying
`{ total, completed }` snapshot comes from.

Active dispatch bursts publish a heartbeat every 15 seconds. An incomplete snapshot
whose heartbeat is more than 90 seconds old is treated as orphaned and reset to Idle;
every live-update connection receives the current value, including an explicit zero,
so a browser cannot retain stale progress after a server restart.

Clicking the line opens the Sync Activity page at `/sync-activity`.

### Sync Activity page

`/sync-activity` (`public/modules/sync-activity.js`) lists what Plekt has synced,
one row per movie or show, newest group activity first. `GET /api/sync-activity`
groups the durable `sync_history` events before pagination, so a busy movie cannot
fill a page by itself. The older event-shaped `GET /api/sync-history` endpoint remains
for retry tooling and compatibility. The same Idle / N of M status appears at the top
of the page, and the page reloads itself every 15 seconds while it is visible.

Each group row shows the title, movie/show type, number of recorded events, latest
timestamp/source/action, the latest route and target results, and whether the newest
event for any movie or episode in the group has an issue. A group moves to the top
whenever any new checkpoint, watch, retry, or target result is recorded. Pending groups
use "Awaiting dispatch" and "Waiting for dispatch" rather than presenting missing target
results as an error. Older failures stop counting as issues as soon as a newer result
for that same movie or episode succeeds.

An item that is not present in a connected library is an expected **skipped** result,
not a failure. It remains available in the audit history for context, but it does not
increase the issue count, appear in **Issues only**, or enter **Retry all failed**.
An actual target error, including a Trakt error, remains actionable.

Unresolved cross-platform matches also appear in the Sync Activity attention area and
the **Issues only** view. These are watched items for which the target server has no
reliable provider identity; each item has a **Fix match** action and a **Remove** action.
Remove keeps the local watch history but stops reporting that unresolved match issue.
Items that already
have a provider identity but are absent from a connected library remain availability
differences and are not raised as issues.

When an episode's Trakt target reports `not_found`, the current result explains that
the show identity may need correcting and offers **Fix show match**. This opens the
same source search used elsewhere in Plekt; after the user chooses the correct
series, every stored episode for that show is rematched and the failed Trakt update is
retried automatically using the current local identity. A complete show group also
offers **Fix show match & retry all**: one show-level match updates every stored
episode, then the server retries every current failed entry sequentially. When Trakt
does not contain the show, the episode and group actions also offer a dismiss option;
dismissing marks only the Trakt target as intentionally skipped, preserves the local
watched state, and remembers the decision across later retries that still return
`not_found`, removing that permanent mismatch from the current issue count. If
the group header's newest activity was a later skip, the failed-only group result says
to expand the group so the actual failed episode is visible instead of presenting the
later skip as the issue.

Clicking a row loads the current result for each movie or episode in that show, newest
first. This is the actionable view: current items with issues get their own issue card
above the history, with every destination response and the actions that apply to that
item. Other current results stay available below the issue cards without competing with
the failure. The header shows the number of current item results and the number that
need attention. **Failed audit history** is collapsed by default and loads the older
failed attempts only when opened; that view has a **Load older failed audit records**
button for unusually large groups. Historical failures are kept for context, but only
the current issue cards are actionable. The event details are fetched only when opened,
so the default list stays quick and readable without deleting audit data.

The summary above the list (for example, "Showing 1-25 of 26 media groups / 11 media
groups with 14 current issues") is red when the activity store contains current issues,
and includes a separate **Show only Failed** button whenever there is an issue anywhere
in the current result set. The summary count is for the full result set, not just the
visible page, so it does not suggest that a clean first page means the activity store is
clean. Clicking the button reloads the list with failed groups from every page; it
changes to **Show all** while active. The filter also removes successful current item
results inside an expanded group.

When there are no current issues anywhere in the result set, the summary uses the normal
neutral text colour. The global **Retry all failed** action is hidden only when the
activity store has no actual failed target to retry.

Partial or failed events with an actual failed destination include a Retry button inside
the expanded group. Only the newest event for each movie or episode gets that button;
older duplicate results are audit-only. `POST /api/sync-history/retry`
reconstructs the media identity from the activity record (including a fresh Plex
metadata lookup when a native rating key is available) and retries only the failed
destinations. The retried row is updated in place - a target that now succeeds
shows success, a target with nowhere to dispatch to (no server configured for it) shows
skipped rather than a stale error, and a target that wasn't retried keeps its prior
result. A resolved item therefore drops out of the failed count instead of leaving the
old error sitting alongside a new row forever.
The row's prior outcome is folded into its raw debug data before being overwritten, so
what it looked like before the retry isn't lost. A "queued:" row (a watch recorded
locally with no durable activity row of its own yet) is retried the same way, but the
outcome is written back onto the underlying watch record's own telemetry, since that is
what the queued row is rendered from.

`POST /api/sync-history/retry-group` accepts a show `groupKey` and applies the same
current-item selection and retry logic to every failed episode in that group. The
operation is sequential and returns per-entry results, so the UI can report how many
episodes succeeded, remain failed, were skipped, or could not be processed. `POST
/api/sync-history/dismiss` accepts one `id` or a batch of current episode ids and
rewrites the matching Trakt target to an intentional skip. A later retry still reaches
Trakt, but a repeated episode `not_found` is folded back into the intentional skip;
superseded audit rows and non-Trakt failures cannot be dismissed.

When an authoritative watch-history restore is blocked, retained media-server projection
failures appear in the Sync - Attention Needed panel grouped by show. A show can be
expanded to reveal its episodes, retried or skipped as a batch, or repaired one item at a
time with a target-specific "Retry on …" action. Each retry runs while the restore fence
remains in place; the fence is released automatically after the last outstanding item is
repaired or skipped. If a failed item no longer has enough saved identity data for a
direct retry, **Fix match** opens the normal local title/provider-ID correction flow and
the retry uses the corrected identity. Items that cannot be repaired can still be
skipped or handled by running the restore again.

The "Retry all failed" button next to Refresh retries the newest failed event for each
movie or episode across the entire sync history, not just the current page. Missing
library items recorded as skipped are excluded. Duplicate older events and items whose
latest event succeeded are also excluded.
Clicking it discovers the real total across every page first and confirms before
starting. The retry itself runs as a background job (`retry_all_sync_activity`,
alongside `force_sync` and the metadata refresh jobs - see [scheduled-sync.md](scheduled-sync.md)),
so it keeps running - and survives navigating away, reloading, or closing the tab - the
same way Force Sync does.
`POST /api/sync-history/retry-all` enqueues the job; `GET /api/sync-history/retry-all`
polls its status/log/result, which the button label reflects while it runs. Returning to
the Sync Activity page resumes polling an already-running job automatically.

Sync Activity resolves platform names itself (`activityPlatform`) rather than through
`normalizePlatformSource`, which knows only the three media servers and folds anything
else into Plex. That is what lets a Trakt dispatch appear as Trakt, with its own icon,
alongside Plex, Emby, Jellyfin, and Plekt's own manual actions.

Clicking a title opens that media's page: its local page when the record matches
something in the library, the TMDB or TVDB route when the dispatch carried those ids,
and a search for the title when it carried neither. Clicking anywhere else on a row
expands it to show the grouped event list; a background refresh reopens rows that were
already expanded. The `/history` page remains the chronological watch-history view; Sync
Activity is the operational record of what Plekt attempted and what each destination
reported.

The "Download all logs" button saves every event in the group as one plain-text `.log`
file. Each event includes its title, media type, action, status, local and ISO timestamps,
record id, source, targets, details, target results, and raw payload debug JSON when present.

`sync_history` is deliberately a permanent audit log: it has no age or row-count
retention policy. Pagination and on-demand group detail loading keep responses bounded;
they do not remove old records. Older duplicate results remain downloadable for
diagnostics, but are not live issues and cannot be selected by Retry all. Backups retain
this audit data with the rest of the database.

## Posters

Dashboard posters use the standard fallback -> `/api/poster` hydration pipeline with a
dedicated IntersectionObserver (`observeDashboardPosters`) so only visible cards
trigger lookups. Up Next episode cards use their season poster when available and fall back
to the shared show poster; a failed season image also switches to the show poster. TV Fix
Match clears stale identity artwork, queues the corrected TVDB/TMDB metadata and canonical
poster, and refreshes the dashboard snapshot; the interactive dialog waits for the metadata response when the provider is
available so the corrected poster is ready when the homepage is revisited. See
[posters-artwork.md](posters-artwork.md).

## Gotchas

- The dashboard is the **only** view where Now Playing polls; `pollNowPlayingOnce`
  bails when `document.hidden` or when the active view isn't the dashboard.
- Mobile (<= 760px) must be re-verified after any dashboard layout change: the split
  state and row-fit logic have broken on mobile after desktop-only redesigns before.
