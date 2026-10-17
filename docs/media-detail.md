# Media Detail Pages (Movies, TV Shows, People)

The immersive detail pages opened from any card in the app - or directly via URL
(`/movie/:id`, `/movie/tmdb/:id`, `/tvshow/:key`, `/tvshow/tmdb/:id`, `/tvshow/tvdb/:id`,
`/person/:id`).
They render TMDB/TVDB metadata (overview, cast, trailers, ratings, recommendations,
images), watch state, sync status, Seerr request controls, and the edit tools.

## Module family

The detail system is split across eight modules; the ownership table below is the
authoritative module boundary:

| Module | Owns |
| --- | --- |
| `media-detail.js` | Entry points: `openMovieInlineDetail`, `openShowInlineDetail`, `openMovieImmersiveModalByTmdbId`, `openShowImmersiveModalByTmdbId`, slug/id lookups, `nowPlayingHref`, history debug modal opener |
| `media-detail-context.js` | Shell/context: init callbacks into `app.js`, `authHeaders()`, the modal DOM root (`mediaDetailRoot`), shared detail loading indicator, render token (stale-render guard), actions-menu state, `closeMediaDetail` / `clearMediaDetailState` |
| `media-detail-shared.js` | Rendering fragments shared by movie + show pages: rating pills, external ratings (IMDb via OMDb), Seerr availability labels and request pills, app deep-links (`hydrateMediaAppLinks`) |
| `media-detail-movie.js` | Movie page rendering (`renderMovieImmersiveModalContent`), watched-state patching, TMDB-id open path |
| `media-detail-show.js` | Show page rendering: header, season accordion, episode rows with watch state, season/episode deep-linking (`renderImmersiveShowModal`, `renderShowModalContent`) |
| `media-detail-events.js` | One delegated click handler for everything inside the detail root: cast → person page, trailer → lightbox, poster → photo lightbox, watch buttons, recommendation cards |
| `media-person.js` | Person pages: bio, filmography grid with watch badges (`loadCastMemberDetails`, `hydratePersonFilmographyWatchStatuses`) |
| `media-lightbox.js` | Trailer playback (YouTube embed) and photo lightbox |

Supporting modules: `tmdb.js` (frontend metadata fetch + cache), `edit-dialogs.js`
(edit date / edit images / fix match / merge show), `watch-action.js` (mark watched/
unwatched, delete, Seerr requests), `calendar-picker.js` (the shared calendar + time
picker every date/time control in the app is built on).

## How a detail page opens

1. A card click (delegated in `media-detail-events.js` or `app-events.js`) calls
   `navigateTo("/movie/…")` / `navigateTo("/tvshow/…")`. Show cards in the poster grid
   render as real links, so they can be middle-clicked, opened in a new tab, or copied;
   the delegated handler claims only the plain left-click and routes it through the SPA
   router, leaving modifier and middle clicks to the browser.
2. `handleRouting` (`app.js`) matches the URL, records the return view
   (`state.mediaDetailReturnView`), sets `state.mediaDetailInline = true`, and calls the
   matching opener in `media-detail.js`.
3. The opener resolves the local watch record (`/api/history`-backed caches, or
   `/api/show?id=`), fetches TMDB/TVDB details through `fetchTmdbDetails`
   (`modules/tmdb.js` → `GET /api/tmdb-details`, cached client- and server-side), and
   renders into the explorer panel's detail root.
4. A **render token** (`bumpMediaRenderToken`) is captured before each async render;
   stale responses check the token and drop themselves so rapid navigation can't paint
   an old page over a new one.
5. Closing the page (`closeMediaDetail`) navigates back to the recorded return view,
   restoring the library URL so the address bar and the topbar controls match the grid
   the user lands on.

Direct URL loads work identically - routing hydrates the same UI without needing
in-app navigation state. TV URLs support deep links:
`/tvshow/<key>/season/2/episode/5` (and a legacy `#season2ep5` hash form).
Episode cards use explicit series provider ids when available. Episode-level provider ids
are never promoted into `/tvshow/tmdb/:id` or `/tvshow/tvdb/:id`; cards without a trusted
series id use the title route, preserving the season/episode coordinates safely.
Legacy movie title routes such as `/movie/the-flash` remain resolvable after the
movie is marked unwatched: when no watched library row exists, the route resolves
the title through TMDB and renders the normal unwatched detail page. Canonical
`/movie/tmdb/:id` links remain the unambiguous form for newly generated links.

Opening a show without a season deep link expands its latest regular season once
metadata is ready, while leaving the page at the top. Specials are used only when no
regular season exists. Later refreshes preserve a season the user has collapsed.

Season 1 deep links expand Season 1 and start at the top of the page. Other season
deep links wait for the details to load and smoothly scroll to the named season.

Expanding a season by clicking its header
scrolls it into view with an eased custom animation (`scrollSeasonAccordionIntoView`
in `media-detail-show.js`), landing just below the sticky topbar (via `scroll-margin-top`
on `.season-accordion-trigger`). The app shell keeps `window`/`document` fixed and
scrolls `<main class="page-shell">` internally instead, so this walks up from the
clicked/targeted season's trigger to find whichever ancestor actually has the overflow
rather than assuming it's page-shell specifically. A URL-named season scrolls into view
exactly once on that navigation (`state.pendingSeasonScrollTarget`, consumed by the
first render), not on every later re-render of the same modal.
The target is re-read every frame, and for about 600ms after the animation ends the page
keeps re-aiming at the card, so a card above it that finishes loading or resizing (a
lazy poster, for example) still lands below the topbar. Any wheel, touch, pointer or key
input from the user cancels that correction.

Series that TMDB has no record of are addressed by `/tvshow/tvdb/:id` instead of
`/tvshow/tmdb/:id`. Show metadata is TVDB-backed either way, so the page renders the
same, with two differences: season episode lists are fetched by TVDB id, and the Seerr
request pill is absent because Seerr requests are keyed on TMDB ids. If the resolved
metadata does carry a TMDB id after all, the page switches to the TMDB URL.

A TV URL may also carry `?historyId=<record id>`, which library cards append so the
page opens against the play that was clicked. When that record names a series the app
can resolve, the page loads the full show and enriches it normally. The single-record
shell, which keeps Fix Match usable without a stale lookup replacing it, is reserved
for rows whose own series identity cannot be identified at all - a record that names a
real, different show than the URL's own key is treated as a stale id and ignored rather
than substituted in, and the router only carries a `historyId` forward across a route
change when the show being navigated to is the one already open, not into a link (a
global search result, for instance) that names a different show without supplying its
own.

The show page uses a two-stage first paint. When the local show summary or watched rows
are already in client state, it paints the local shell - including the title, artwork,
watched counts, and season headings - before either the mutable `/api/show` detail request
or provider metadata. A direct route with no local summary paints the provider shell as
soon as that metadata resolves. The mutable `/api/show` response remains `private,
no-store`; it is started in parallel and is never used as a first-paint gate.

On a direct `/movie/...` or `/tvshow/...` reload, the app also seeds the detail state from
the short-lived persisted dashboard history snapshot when one is available. Known artwork,
summaries, watched rows, and watch dates remain visible while the no-store detail request
and provider metadata revalidate; the authoritative responses replace that snapshot when
they complete.

Metadata, local watch detail, playback progress, and the optional IMDb pill enrich the
existing page afterward. Enrichment patches the header, facts, and independently loaded
sections instead of replacing the whole detail root, so the mounted poster/backdrop and
the internal scroll position survive. Only the season the page is about to expand (if
any) is fetched before that first render; other season episode lists hydrate lazily. A
season expanded before its own episode list arrives shows a loading placeholder instead
of a premature "no episodes" message.

## What's on the page

- **Metadata** - overview, genres, runtime, status, ratings; TV structure (seasons/
  episodes, air dates) comes from TVDB, extras (cast, trailers, recommendations,
  watch providers) from TMDB - see [metadata.md](metadata.md).
- **Responsive episode cards** - expanded TV seasons use a five-column desktop grid,
  narrowing with the available width and settling into two cards per row on phone-sized
  screens so episode artwork and actions remain scannable without making each tile fill
  the entire viewport. On phone-sized cards, the content is ordered as title, availability
  with the personal rating aligned to the right, synopsis, and the latest watched date with
  its edit action; older watch rows, source badges, and the watched-state action stay
  available on wider layouts without crowding the mobile tile.
- **Mobile TV controls** - the phone navigation centers the Plekt mark with the menu
  trigger at the left. TV season headers keep episode and watched counts inline, suppress
  redundant complete-season progress text, and place season options inline with the watched
  count. Episode cards keep their compact watch state and watch-history controls without a
  separate per-episode options disclosure.
  The Seasons summary is one compact row: its count sits beside the title and standard/4K
  availability is combined into one label such as **8 1080p · 8 4K**; the redundant
  Expand All control is omitted.
  Show/movie watched-state actions now live in the Options menu, whose labels stay on one line
  on narrow screens. Shared watch-date, edit, confirmation, force-sync, and generic modal
  surfaces collapse or scroll within the phone viewport instead of forcing horizontal overflow.
- **External ratings** - IMDb rating pill via `GET /api/omdb-rating` when an OMDb key
  is configured. TMDB, TheTVDB, and IMDb each render as a pill with that service's real
  logo (`public/icons/tmdb.svg`, `tvdb.svg`, `imdb.svg`) in a "Ratings" row inside the
  Media facts panel - see below.
- **Trailers** - YouTube keys from TMDB, metadata enriched via `GET /api/youtube-meta`,
  played in the lightbox.
- **Cast** - profile images proxied/cached via `GET /api/tmdb-profile`; clicking opens
  `/person/:id`.
- **Artwork below the fold is lazy-loaded.** Cast avatars, the related/recommendation/images
  poster rails, and trailer thumbnails all carry `loading="lazy" decoding="async"`. A first
  view of a title issues around 78 API requests, roughly 49 of them one-per-image proxies, and
  on a normal viewport every cast avatar sits below the fold - fetching them eagerly made the
  page's genuinely slow provider calls queue behind the burst, to the point where
  `/api/setup/status`, which answers in 9ms on its own, took over two seconds. The app-link
  pills in the Watch Now row stay `eager`: they are small, always above the fold, and part of
  the first paint. Repeat views are unaffected either way, since these proxies already send
  `public, max-age=31536000, immutable` and come from the browser cache. Detail-page artwork
  reserves its layout box and shows the shared shimmer skeleton until the image load settles;
  reduced-motion users receive the static skeleton, and failed images settle into the existing
  fallback behavior.
- **Watch state & actions** - mark watched (with date prompt: today / release date /
  episode-relative date / custom), mark unwatched, delete; episode- season- and
  show-level for TV (`watch-action.js`, `POST /api/manual-watch` in batches of 100,
  `POST /api/manual-unwatch`, `POST /api/delete-media`). For a single episode, an
  earlier watched episode offers **After last episode**, which bases the new watch
  date on that episode's watch time plus its runtime and a one-minute gap. If no
  earlier episode is watched but a later one is, the choice becomes **Before next
  episode** and subtracts the later episode's runtime plus a one-minute gap. The
  episode runtime comes from the TVDB-backed season metadata. Season/show batches
  retain **Same as other episodes**, using the earliest watched episode as their
  shared base. For shared-date batch choices, episodes are ordered by
  season/episode and each next episode is placed after the previous episode's
  runtime plus a one-minute gap; when matching an existing watched reference,
  the first new episode follows that reference by the same interval. These
  relative choices only appear when a watched reference exists. Marking more
  than one episode at once therefore keeps a realistic time between consecutive
  episodes instead of assigning every episode the same instant
  (`watchedAtForEpisodeBatch`, `runtimeSeparationMs`). A mark-watched
  request is skipped as a duplicate whenever the item is already watched, regardless of what
  timestamp the request itself used - a page left open for a while, or a season/show batch
  built from a "which episodes are unwatched" list that's gone stale since the page loaded,
  can never turn into a second logged play; the response reports it as already-logged
  instead. This is checked two ways rather than relying on a single lookup:
  `getCanonicalWatchState` (playstate first, falling back to watch history) and
  `findWatchedByAnyMediaKey` (provider ids, then season+episode+title, then a normalized
  show-title compare that tolerates a "(YYYY)" only one side carries) run independently, not
  one gated behind the other - a record old enough to predate provider-id tracking can be
  keyed loosely enough that playstate's own matching misses it while the more thorough
  watch-history lookup still finds it. A non-watched bookkeeping row occupying the exact same
  media identity and timestamp (left behind by an unwatch transition) is separately replaced
  with the new watched record
  instead of being mistaken for an existing one. A mixed season-level mark-watched
  action dispatches only its eligible unwatched episodes, so episodes Plekt already
  has as watched are left untouched. When a season has nothing left unwatched, its
  button relabels to "Resync season" so it can still be clicked to re-push the existing
  watched state; show-level mark-watched similarly re-pushes already-watched episodes
  when the whole show action includes them. These explicit resync rows use their
  existing `watched_at` (no new watch-history row or date prompt), so a target whose
  own watched flag drifted after the original push (e.g. following a library rescan)
  gets corrected without needing Force Sync. When the whole show has nothing left
  unwatched, its button relabels to "Resync Watched" instead of disabling, so it can
  still be clicked to re-push
  (`watchActionFromButton`, `runResyncWatchAction` in `watch-action.js`). `POST
  /api/manual-watch` awaits the outbound dispatch to every target before responding
  (rather than backgrounding it), and a manual unwatch (`POST /api/manual-unwatch`,
  `POST /api/playback-progress/unwatch`) always forces a live re-push even when
  Plekt's own state already says unwatched - so the UI can show a row as busy
  for the duration of the request and only flip it to watched/unwatched once the
  response confirms the push actually completed, instead of updating optimistically
  on click. Mark-watched/resync busy rows read "Saving..." while mark-unwatched
  busy rows read "Unwatching..." - the two states are tracked in separate sets
  (`state.savingWatchActions` for mark-watched/resync, `state.savingUnwatchIds` for
  mark-unwatched, keyed by watch-record id) so a season/show sync in one direction
  never mislabels a row that's actually being unwatched, or vice versa. Multiple
  watch actions can be in flight at the same time: clicking mark watched/unwatched
  on one episode, season, show, or movie only disables the buttons that target the
  same episodes (or the same movie), so a large season/show sync doesn't block
  marking something unrelated watched while it runs. Show-wide controls
  (mark/resync the whole show, edit show date, edit images, fix match, merge) stay
  disabled until every action on that show finishes, since they'd otherwise
  re-push episodes that are already mid-sync. Removing a single watch date from
  the edit-date dialog (`edit-dialogs.js`) also marks that row's id busy in
  `state.savingUnwatchIds` for the duration of the delete, so it reads
  "Unwatching..." underneath the dialog if an unrelated in-flight sync happens to
  re-render the season/show panel while the delete is still pending.
  Once the server confirms an episode, season, or show action, the mounted show
  detail patches only the affected episode cards instead of rebuilding the modal;
  scroll position, loaded artwork, and the rest of the season stay in place. An
  unwatch transition remains as an invisible local tombstone until the next history
  merge, so a delayed provider played-flag callback cannot repaint the episode as
  watched; a later explicit provider Mark played event or genuinely newer watch can
  establish it again. On the server, a manual unwatch stays canonical against every
  generic provider watched flag. Only an exact live-session playback completion whose
  provider timestamp and Plekt receive time are both newer than the unwatch can
  replace it (see `docs/decisions.md` entry 31).
- **Live import and sync protection** - the detail page consumes the same live
  sync-progress snapshot as the Sync Activity view. When a visible movie or
  episode has pending import/dispatch telemetry, or is the active item reported
  by a force or scheduled sync, the page shows a **Syncing…** notice and pauses
  its watched/unwatched controls (including the affected season/show controls).
  The notice is removed and the controls are recalculated when the item's
  dispatch completes, so unrelated media can still be edited while a different
  item is syncing (`isMediaSyncing`, `syncActiveMediaDetailState`).
- **Personal ratings** - the show detail page is the source of truth for episode
  ratings. Each rating uses the parent show's provider identity plus season/episode,
  so the same episode remains one item on the Ratings page even when another surface
  only knows an episode-level provider id. Episode artwork is still stored separately
  and is not replaced by the show's poster.
- **Personal lists** - movie and show detail pages keep **Add to watch list** and
  **Add to playlist** in the control bar. The watch-list action changes to
  **Remove from watch list** when the title is already saved. The playlist action
  changes to **In playlist** when it has memberships, and its chooser marks each
  existing membership as already added. Matching uses the title's provider identity
  (plus show/season/episode coordinates for episodes), so the state agrees with the
  Watchlist and Playlists pages.
- **Detail action bar** - the everyday actions stay visible while a permanent
  **Options** section groups **Force Sync**, **Info**, **Edit Images**, **Fix Match**,
  and **Delete**. TV show pages also place **Merge** in Options. The grouped menu is
  used at every viewport width so the control bar has one predictable layout.
- **Rewatch tracking** - a genuine rewatch (a webhook playback event for an
  already-watched item on a later UTC calendar day; see [webhooks.md](webhooks.md#rewatch-detection))
  adds a new watch record instead of being dropped as a duplicate. A bare
  played-flag event never counts as a rewatch. Same-event propagation echoes
  inside the ten-minute duplicate window are removed from displayed history, so
  movie/episode cards and show summaries count actual watches only. Movies and
  episodes with more than one recorded watch show a "Watch History" list (date
  + source app for every play) in place of the single watched-date line; TV show
  and season summaries also show the total actual-watch count.
- **Sync status** - per-platform pills from `sync_dispatch_telemetry`
  (`modules/sync.js`), with retry (`POST /api/retry-sync`). Detail pages also
  expose **Force Sync** for movies and shows. Its dialog offers two independent
  operations, each explicit about what it does: **Set Plekt as Source of
  Truth** sends this title's watched state exactly as Plekt currently has
  it recorded to a selected destination (or all), overwriting whatever they
  show, without checking their current state first
  (`syncCanonicalPlaystate` in `syncOrchestrator.js`, and
  `syncMediaUnplayedPlaystate` also clears playback position, not just the
  played flag, on every server an unwatched state is replayed to); and
  **Import Watched Status** reads watched state from a selected server (or
  all) and adds anything Plekt doesn't already have, without sending
  anything back out or removing anything. A remote item whose played flag has
  no reliable played date (common for episodes bulk-marked watched through a
  server's own library UI, which sets the played flag but never a played
  timestamp) falls back to the episode's own release date rather than being
  silently dropped or given a fabricated "just now" date - this operation is
  explicit and scoped to one title, unlike the background scheduled sync
  (`scheduled.js`), which still skips these entirely to avoid manufacturing a
  burst of phantom watches across an entire rebuilt library
  (`remoteItemToMedia` in `mediaForceSync.js`). If even a release date is
  unavailable, the item is skipped rather than given a fabricated date.
  Whether an item needs inserting is decided from its actual current
  canonical state (`getCanonicalWatchState`), not merely whether *any*
  watched row exists for it anywhere in history
  (`findWatchedByAnyMediaKey`) - a later unwatch (even a stale one recorded
  while a show's identity was mismatched) always wins the display's dedup
  tie-break by recency, so an old watched row can sit on file while the show
  still displays and counts as unwatched. Checking only "does a watched row
  exist" treated that as already handled and silently did nothing; checking
  the canonical pointer instead inserts a fresh record so the source's
  confirmed "still watched" genuinely wins the tie-break back. For a
  show-scoped pull, that canonical check prefers a season+episode map built
  once from the show's own current detail (`queryShowDetail`) over the
  playstate-based canonical lookup - an incoming Plex/Emby/Jellyfin item's
  ids are episode-scoped (its own imdb/tvdb id, not the show's), so a
  playstate lookup keyed on them can miss and fall back to the same
  any-watched-row check the fix exists to avoid; matching against the show's
  own episode list can't disagree with what the page actually renders.
  A pulled episode's tmdb_id/tvdb_id are always the show being pulled, not
  whatever id the source item itself carries: Plex/Emby/Jellyfin tag an
  episode with its own tmdb/tvdb id (both providers assign episodes ids
  separate from their series), and trusting that would tag the inserted row
  with the wrong-scope identity and fragment it into its own show cluster
  instead of the real show's - the same class of episode-vs-series id
  conflation documented for `tvdb_id` resolution in `tv-shows.md`. Only
  imdb_id still comes from the item, since it's meaningfully episode-scoped
  and doesn't affect show grouping (`remoteItemToMedia` in
  `mediaForceSync.js`). The asynchronous
  `POST /api/force-sync/media` operation is followed through
  `GET /api/force-sync/media/status?id=...`, and the dialog shows its detailed
  live terminal output until completion. Every action asks for confirmation before it
  starts, and the activity header exposes **Cancel operation** while it is running.
  Settings → Sync → Sync Tools → Force Sync
  keeps the same two operations and live terminal inline in the Force Sync box for
  the complete library.
  Both operations process several episodes at once (bounded concurrency, see
  `runWithConcurrency` in `concurrency.js`) rather than one at a time, so a show with
  many seasons syncs significantly faster; outbound calls to each media server are still
  throttled per host by the outbound governor regardless of how many episodes are in
  flight. An all-destinations **Set Plekt as Source of Truth** run uses two awaited
  phases: it finishes every Plex/Emby/Jellyfin write first, then drains Trakt through its
  own two-item queue. The activity stays open until both phases finish and records one
  combined result per item, with slow cloud history writes kept outside the six-item
  local-server worker pool. A cancellation stops new Trakt items while allowing an
  in-flight canonical remove/add pair to finish, so Trakt cannot be left between the two
  halves of a watched-state replay. Selecting one explicit media-server destination
  remains destination-only and never queues Trakt.
  For a TV show, the dialog also lists its seasons as checkboxes; leaving all of them
  unchecked scopes the operation to every season (the previous, only behavior), while
  checking one or more limits it to just those seasons. This reuses the same season
  filter (`mediaMatchesRequest` in `mediaForceSync.js`) that already scopes a single
  episode's Force Sync button, extended to accept a list.
  Jellyfin episode matching keeps every same-season/episode copy, so separate
  1080p and 4K items can both receive the watched or unwatched state.
  `POST /api/retry-sync` and `POST /api/update-watch` both take an optional
  `media_key` next to `id`, and fall back to it when the id names no row. A
  record can be superseded between the moment a caller reads its id and the
  moment it acts, so callers that hold an id for any length of time - the manual
  match queue in Settings → Sync → Sync Issues - send the key as well. Both endpoints
  also accept a media key supplied as the `id` itself.
- **Seerr integration** - when Jellyseerr/Overseerr is configured, availability status
  (`GET /api/seerr/media-status`) and request buttons (`POST /api/seerr/request`,
  season-level for TV, optional 4K) render on the page. The last known status per
  title is persisted in localStorage (`plembfin:seerrStatusCache:v1`), so availability
  pills render instantly on page open; a silent background refresh re-renders the page
  only when the status actually changed (`fetchSeerrMediaStatus` resolves `null` when
  the fresh result matches the persisted one). That repaint only fires when the browser
  still considers itself "on" the same title - a TV show opened via `/tvshow/tmdb/:id`
  or `/tvshow/tvdb/:id` never sets `state.activeShowModalKey` (only the plain
  `/tvshow/:key` route does), so a slug-only check there always failed for those two
  routes and left a stale availability badge on screen indefinitely even once the
  background fetch had already resolved correct data - fixed by also matching on
  `state.activeShowTmdbId`/`activeShowTvdbId`. The "Available in <resolution>" wording
  reflects the actual resolution found on the connected server(s): a TV show/season only
  states a resolution when every one of its available episodes shares it (the per-episode
  resolution pills already show a mixed season's real breakdown); a movie states whatever
  resolution `mediaItemResolutionLabel` found for it, walking the same Plex/Emby/Jellyfin
  media-item shapes TV episodes use (`fetchConfiguredAppAvailability` in
  `server/src/routes/admin.js`) rather than a hardcoded resolution. For a TV show, the
  standard and 4K counts render as one compact summary (e.g. "8 1080p · 8 4K") in the
  Seasons section header, to the right of the season count, instead of under the ratings
  row.
- **App links** - "open in Plex/Emby/Jellyfin" deep links via
  `GET /api/media-app-links`. The last known links per title are persisted in
  localStorage (`plembfin:appLinksCache:v1`) and rendered instantly; a background
  refresh (at most once per 5 minutes per title) updates the buttons only on change.
  That window is read from the persisted entry's own timestamp, which is rewritten
  on every successful check including one that found nothing changed, so it holds
  across a page reload. For a series the lookup enumerates every episode from each
  configured server, so repeating it per page load was the slowest request on a
  show page by a wide margin.
  Concurrent renders of one page share a single request per lookup key: the
  timestamp above only suppresses a refresh once one has completed, so a page that
  paints its shell and then re-renders as metadata arrives used to start the whole
  lookup again before the first returned. A title that is in no connected library
  is the worst case, because an empty result leaves nothing for the timestamp guard
  to read. The server also remembers an empty result for 60 seconds
  (`clearEmptyAppLinksCache()` drops it when the media configuration changes, since
  connecting a server changes what can be found); a populated result is never
  cached server-side, so a link can never go stale.
  A media server whose lookup could not connect or timed out is skipped by this
  lookup for 60 seconds, then tried again, so a stopped server no longer makes every
  detail page wait on it. Only a server that did not answer at all counts; "not
  found" and HTTP errors do not. While a server is skipped or its lookup failed, the
  answer carries `partial: true`: the server does not remember it as an empty
  result, the browser refreshes it after 60 seconds instead of 5 minutes, and that
  server's pill is simply absent (the same look as not found). This state is
  private to app links and never affects sync or health reporting.
  The pills render (`mediaAppLinksHtml` in `media-detail-shared.js`) as their own
  "Watch Now" row inside the Media facts panel, the last row on the page.
- **One show lookup per page.** A detail page resolves its show through several
  paths - by TMDB id, by TVDB id, and by title - which previously meant up to four
  identical `GET /api/show` calls for one page. A resolved show is now indexed
  under every identifier it is known by (imdb/tmdb/tvdb id, record id, title slug)
  in `state.showDetailCache`, so a lookup by any of them reuses the first answer.
  `/api/show` carries authoritative watched rows and dates, so the entry lives for
  10 seconds and `clearDerivedUiCaches()` drops it on any mutation.
  A lookup that finds nothing is remembered too, in `state.showDetailMisses` under
  the same identity tokens and for the same 10 seconds. Without it a title absent
  from the library - which is what a recommendation rail usually links to - was
  re-asked on every re-render, six times for one page load, each one a 404 in the
  browser console. The window has to cover a slow page load: at 5 seconds a page
  whose provider work took 5.4 seconds outlived its own entries and asked again.
  Each lookup shape is remembered separately, because a miss by TMDB id does not
  prove a miss by title - a record may exist with a title and no provider id - so
  one page load asks at most once per shape rather than once in total.
- **Media facts panel** (`renderMediaFacts` in `media-detail-shared.js`) - a
  transparent, borderless panel next to the center section (with a 60/40 header
  split) displaying a top metadata table (Status incorporating release/air date,
  Genres, Network/Studio, Language, and Runtime) and a bottom-anchored group with
  Available on, Watch Now, and Ratings (each with borders and backgrounds removed).
  The Ratings row is anchored to the bottom edge inline with the progress bar in the
  center column and formatted as brand logo plus rating percentage (e.g. TVDB/TMDB/IMDb
  logos) rather than star widgets. Network and Available on render as icon chips
  (`providerChipsHtml`) using TMDB's `logo_path` for each network/provider; a
  network's own `logo_path` is frequently empty even when the same service also has
  one under `watch/providers` (e.g. Apple TV), so a network without its own logo
  borrows one from a provider whose name loosely matches (`findProviderLogoForNetwork` -
  either name containing the other, not just an exact match). A show resolved
  primarily via TheTVDB only carries a network name with no logo at all (TVDB's company
  data has no logo field), so those still show as text-only. Each Network/Available on
  chip links to TMDB's own "where to watch" page for the title (the
  `watch/providers.results.<region>.link` TMDB's terms require attributing when that data
  is shown), since TMDB doesn't expose a per-provider deep link. All the icons in this
  panel and the ratings row are theme-agnostic (no background fill or border boxes).
- **Poster lightbox** - clicking the poster image opens it in the same photo lightbox
  used for the media images gallery (`window.openPhotoLightbox`, `media-lightbox.js`),
  via a `data-lightbox-src` attribute on `.immersive-poster-img`.
- **Edit tools** - edit watched date (single, per-season, per-show), edit artwork
  (poster/logo/backdrop picker fed by `GET /api/tmdb-images`, `/api/tvdb-images`,
  `/api/fanart-images`, with tiles previewed through the caching artwork proxy so a
  fanart.tv or TVDB CDN the browser cannot reach still shows its gallery; saves via
  `POST /api/update-watch`). TV shows also have a **Season Posters** tab: choose a
  season, select its TMDB, TVDB, or fanart.tv poster, or upload an image. The selected
  poster is saved for that season without replacing the episode's own artwork and is
  used on episode cards when available. Fix match
  (TMDB search for movies; TheTVDB search for shows), merge show. All in
  `edit-dialogs.js`. The single-item edit-date dialog lists every recorded watch
  date for that movie/episode (`GET /api/watch-dates?id=`), letting you edit any
  one of them, add another watch date (`POST /api/add-watch-date`, clones the
  anchor row's identity fields onto a new date), or remove one with confirmation
  (`POST /api/delete-watch-date` - rolls `playstate.watched_at` back to whichever
  remaining watch is newest, or clears it if none remain, and clears the
  dashboard/explorer's cached history so the "N actual watches" count updates
  immediately instead of only after some unrelated reload). The list only ever
  shows one row per real viewing event, since a webhook echo can write more
  than one `watch_history` row within the same short window
  (`SAME_EVENT_WINDOW_MS` in `dataRepo.js`); deleting that row also deletes any
  echo chained to it (`sameEventChainIdsFor` in `dataRepo.js`), so a hidden
  duplicate can't resurface as a "new" watch date afterward. An episode's other
  plays are found by `siblingWatchRowsFor()` matching season, episode, and a
  canonical (year-stripped) show title - normalizing the full show_title-or-
  title expression, not just the title fallback, matters for the same reason
  it does in `queryShowDetail` (see `tv-shows.md`): two of an episode's own
  watch rows can carry differently-formatted show_title text, and comparing
  one normalized side against one raw side silently missed a real duplicate
  play instead of listing it. `siblingWatchRowsFor()` also trusts a sibling row
  by `isPlembfinTrackedEpisodeRow` rather than `isPlembfinTrackedWatchRow` -
  the same check `queryShowDetail`'s grouping uses to build the "N actual
  watches" badge - since a real past play whose `sync_action` was later
  flipped to "unwatched" (e.g. an explicit unwatch from a connected server)
  is still a play that belongs in the list; requiring the row's *current*
  action to be "watched" silently dropped it from the editor while the
  episode card's own history count still included it. If every surviving
  sibling reads "unwatched" - no genuinely watched row is left at all -
  `remainingWatchRowFor()` promotes the newest of them to "watched" in place
  (flipping its own `sync_action`, not just `playstate`) rather than falling
  back to fully unwatched: deleting the other watch date down to that row
  and leaving it standing is itself the user's statement that it should
  count, regardless of what its own `sync_action` said going in (e.g. a
  genuine past watch whose unwatch marker predates today, or a stray marker
  left by an earlier sync issue). This only fires when *no* sibling currently
  reads "watched" - an older genuinely watched row still wins over a newer,
  deliberate unwatch, so a real unwatch performed on purpose is never
  resurrected just because it happens to be the most recent row. Deleting a
  watch date also replays the resulting canonical state - the rolled-back
  (or promoted) date if a watch remains, or "unwatched" if none do - to every
  connected Plex/Emby/Jellyfin/Trakt server (`propagateWatchDateRemoval` in
  `routes/media.js`, reusing the same `syncCanonicalPlaystate` replay as an
  edited date), so a platform that already received the deleted watch as
  "watched" gets corrected instead of continuing to disagree with Plekt;
  left uncorrected, that platform's own next catch-up scan could otherwise
  re-import its stale "watched" state as a brand-new phantom watch. Once that
  replay finishes, its outcome is written onto the surviving row's own
  `sync_dispatch_telemetry` (`formatDispatchTelemetry`, shared with
  `routes/sync.js`'s manual-watch handler) - a promoted row's telemetry would
  otherwise stay "Dispatch status: pending" forever, which is exactly what the
  scheduler's backlog sweep (`syncPendingManualDispatches` in `utils/syncDispatchQueue.js`,
  see `scheduled-sync.md`) watches for; left unpersisted, that sweep would
  re-dispatch the row later using its own media object, which does not carry
  this row's `watched_at`, sending Trakt today's date instead of the real one
  this replay just correctly sent. The open movie/show detail also clears its
  short-lived detail cache and re-renders from the authoritative response after
  a single-date delete, so the removed watch disappears immediately while a
  surviving watch keeps the episode watched without requiring a page reload. The
  per-season "Edit season date" dialog additionally offers **Remove duplicate
  watches** when any episode in the season has more than one recorded watch: it
  keeps only the oldest watch per episode and bulk-deletes the rest in a single
  confirmed action (`POST /api/delete-watch-dates`, `deleteWatchDates` in
  `dataRepo.js`), rolling each affected `playstate.watched_at` back to the
  surviving (oldest) date the same way the single-row delete does. Unlike the
  single-row delete, the bulk path deliberately does **not** expand into
  `sameEventChainIdsFor`'s echo-chain window: the caller has already decided
  exactly which ids are duplicates to remove and which one to keep, and two
  genuinely separate watches for the same episode can land within that 10-
  minute window of each other (e.g. marking an episode watched "using the same
  time as another"); the bulk delete set contains only the ids selected by the
  caller, so a separate watch inside the echo window remains intact. The show-level date editor (`openEditShowDateDialog`
  in `edit-dialogs.js`) shows one row per season instead of a single date for
  the whole show - each season defaults to its own latest watched date and can
  be changed independently before saving, so Season 1 and Season 2 don't have
  to share one timestamp; it is not currently exposed on the show detail
  page's control bar. Editing, adding, or
  bulk-editing (`POST /api/update-watch-dates`) a watched date replays the
  corrected date to Trakt and every connected Plex/Emby/Jellyfin server as a
  canonical "watched" state in the background (`propagateCorrectedWatchDate` in
  `routes/media.js`, reusing `syncCanonicalPlaystate` - the same replay Force
  Sync's "Set Plekt as Source of Truth" uses), so the platforms Plekt is canonical for don't keep
  showing a stale or fabricated date after a manual fix; a record currently
  marked unwatched is left alone. Since Trakt's history is an additive play log,
  this replay clears any existing Trakt plays for the item first
  (`trackerDispatcher.js`) so the correction replaces the old entry instead of
  adding another one alongside it. Trakt's `/sync/history` and
  `/sync/history/remove` both return `200 OK` with a `{ added|deleted, not_found }`
  summary even when nothing actually matched, so `dispatchTrakt` reads that body
  rather than trusting the HTTP status alone: a non-empty `not_found` on the add
  step is reported back as an error instead of a false "success", and a
  canonical replay's clear step reports how many plays it actually deleted (and
  any it didn't recognize) in the telemetry, e.g. "Marked watched on Trakt
  (cleared 0 existing plays first)" - a visible signal that Trakt didn't
  recognize the item to clear, rather than a blind "success" while a stale
  duplicate play stays on Trakt. That `not_found` detail is also what exposed a
  real identity bug: an episode dispatched to Trakt without an id of its own
  used to have its ids re-derived from a TMDB title search every time
  (`hydrateTrackerMedia`/`trackerMediaWithSeriesIds` in `trackerDispatcher.js`)
  and that search result unconditionally replaced whatever ids the episode
  already had - so a short or ambiguous show title that TMDB's search
  resolved to the wrong series (e.g. "G'wed") silently corrupted every Trakt
  request for that show's episodes, `not_found`-ing both the add and the
  clear-existing-plays step. The lookup now only fills in ids an episode is
  missing and is skipped entirely once it already has one, so a correct
  stored id is never overwritten by a guess. If Trakt rejects an existing episode
  identity, its dispatch stops and reports the mismatch rather than retrying with
  a title-derived series id; only title-only episodes can be hydrated before their
  first dispatch, and movie retries remain supported. Plex notification episodes
  also use their native grandparent key to fetch exact series metadata when available.
  Plex/Emby/Jellyfin's own mark-played APIs
  don't accept an arbitrary date, so those servers still record the moment the
  correction ran, not the corrected date itself - only Trakt's history reflects
  the actual corrected timestamp. TV Fix Match sends one `POST /api/rematch-show` request that
  updates every episode record in a transaction, renaming them onto the picked
  series when that name differs. The server clears stale identity artwork and queues a
  metadata warm-up; when the provider responds, the interactive TV flow waits for the
  corrected show metadata and refreshes the dashboard snapshot before closing. If the
  provider is unavailable, the durable rematch is saved and the warm-up continues in the
  background. A rename changes the show's route key, so the UI navigates to the new show URL. Movie Fix Match saves the picked
  TMDB id via `PATCH /api/update-watch` (`updateWatchRecord` in `dataRepo.js`, which also
  accepts an `imdb_id`). Because a row's `media_key` is derived from its identity fields,
  correcting them recomputes the key and moves the row onto it - merging it with any other
  watch already recorded under that identity instead of leaving it permanently split under
  its old key - and reconciles `playstate` on both the old key (rolled back to whatever else
  is still there, or cleared) and the new one (merged with whatever it already reflects).
  Season and show date editors use `POST /api/update-watch-dates` to update the
  selected existing rows in one transaction. The season editor can use each
  episode's release day independently; this path never adds a watch-history row.
  Same-event webhook/propagation echoes are removed from displayed play history,
  while later genuine plays remain visible. Show cards, dashboard history, season
  summaries, and episode details expose the retained actual-watch count when it is
  greater than one.
  The artwork dialog has a match search box at the top (`GET /api/tmdb-search`):
  when a title has no automatic TMDB/TVDB match, searching and picking a result
  swaps the identifiers the picker browses with - the record itself is not
  re-linked (use Fix Match for that).
- **Debug modal** - `openHistoryDebugModal` shows the raw watch record + telemetry for
  a history row.

## Person pages

`loadCastMemberDetails(personId)` fetches `GET /api/tmdb-person` (server-cached, 7-day
TTL), renders a sidebar with profile image, name, age, biography, and personal info
(birthdate, place of birth, known-for department), plus social media links (IMDb,
Instagram, X, Facebook, TikTok, Wikidata). The main content area shows filmography
with three filter/sort controls: media type (all/movie/TV), year, and genre. Credits
are sorted by default by release date (newest first); other sort options are popularity,
release date (oldest first), and alphabetical title sort. A watch badge overlay on each
credit indicates whether it's in the library. Filmography paginates with an
IntersectionObserver (`FILMOGRAPHY_PAGE_SIZE` 40) and matches entries against the local
library (`findLibraryItem`, `hydratePersonFilmographyWatchStatuses`). The page layout
is responsive and stacks vertically on smaller screens. `state.personReturnUrl` remembers
where to go back to.

## Gotchas

- Every render path must respect the render token; async work that writes to the DOM
  without checking `currentMediaRenderToken()` causes ghost content on fast navigation.
- TV detail is keyed by **show key** (canonical title) locally but **TMDB id** for
  Seerr/routing; `getCachedTvdbId` and the details' `id` field bridge the two.
- Modal-close routing goes through `media-detail.js` so browser back/forward stays
  consistent with `state.internalHistoryCount`.
