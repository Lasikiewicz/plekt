# Frontend Architecture

The UI is a plain ES-module SPA served straight from `public/` - no framework, no
bundler, no TypeScript, no build step. This doc covers structure, routing, state, and
the module rules. Feature-specific behavior lives in the per-feature docs
([dashboard.md](dashboard.md), [movies.md](movies.md), [tv-shows.md](tv-shows.md),
[media-detail.md](media-detail.md), [history-search.md](history-search.md),
[stats.md](stats.md), [settings.md](settings.md), [personal-ratings.md](personal-ratings.md)).

## Structure

## Brand colours

Use these shell surface colours as Plekt's brand colours for the two themes:

| Theme | Left menu | Main background |
| --- | --- | --- |
| Dark mode | `#1f242c` | `#080b0f` |
| Light mode | `#f1f5f9` | `#fbfbfb` |

Keep the left menu and main background aligned with these values when changing the
application theme styles. They are the `--brand-menu` and `--brand-main` tokens in
`public/styles.css` (`:root` for dark, `html.light-mode` for light). Every page paints its
navbar (and, on media pages, its stacked title and controls rows on phones) with `--brand-menu`,
matching the left menu.

Settings uses only these two tones in both themes and both styles. The settings canvas is
`--brand-main`; each nested surface level (section card, box or disclosure, field, input
or choice option) alternates, starting with `--brand-menu` for parent sections. One
depth-based rule set at the end of `styles.css` paints every listed settings surface
without gradients. Add a new settings surface to that shared list instead of giving it a
per-section background.

- **`public/index.html`** - the single shell: nav tabs, one `view-panel` section per
  view (`data-view-panel="dashboard|history|stats|explorer|upcoming|discover|personal-media|settings|search"`),
  every modal/dialog, and `modulepreload` links for each module. All element IDs the JS
  uses are defined here and bound once by `bindElements()` in `app.js`.
- **`public/app.js`** - orchestrator only (hard rule: stays under 3,000 lines):
  startup, theme, backend warm-up ping, element binding, routing, auth wiring, and the
  callback objects passed to each module's `init*(callbacks)` function. Modules never
  import from `app.js` - dependencies flow one way, and cross-module calls that would
  point "upward" go through those init callbacks instead.

- **`public/modules/*.js`** - feature modules with named ES exports (soft limit 1,200
  lines, hard limit 1,500). The module ownership rules in this document and the file map
  in [architecture.md](architecture.md) are authoritative.
- **`public/modules/settings-ui.js`** - reusable settings card-grid, picker, and edit
  dialog primitives. `settings-services.js` owns media-server/metadata behavior, while
  `tools-backups.js` consumes the same primitives for remote destinations.
- **`public/styles.css`** - all styling, including the ≤ 760px mobile rules. Any
  layout/appearance change must be verified on mobile.

### Core graph and route modules

`app.js` statically imports only the core graph needed for the first paint: auth,
state, utils, images, logs, settings shell, sync,
live updates, the small appearance, status-indicator, media-routing, and cast-disclosure
helpers, and `route-modules.js`. Dashboard, Up Next, backup tools, the metadata helper,
shared detail renderer, and the full status pages are registered route modules, so
their graphs load only when the relevant route or action needs them. The `modulepreload`
links in `index.html` cover the remaining core graph only.

Everything else is a **route module**, registered in `public/modules/route-modules.js` and
loaded on demand with native `import()`:

- **Shell modules** (`SHELL_ROUTE_MODULES`) load right after the first paint on every page:
  `app-events.js` (the document-wide click and change wiring). The changelog helper is
  Settings-scoped, while detail event wiring is route-scoped with the detail group and
  Settings explicitly loads it for the library Force Sync panel. The tracker, rating-sync,
  watchlist-sync, and Tautulli modules are Settings-only and load with that route, after
  the saved config has been fetched. So does `settings-events.js`, which holds the Settings
  page's own handlers (logs, admin login, import, backups, maintenance tools, sync controls);
  `app-events.js` initializes it through `onRouteModuleLoaded()`.
- **Status modules** (`STATUS_ROUTE_MODULES`: sync activity and manual watch review) load only
  when their pages are opened. The small `status-indicators.js` core helper keeps the sidebar
  sync progress, attention, and Manual Watch review count live and polls their compact summaries
  after sign-in. Poster-card menus are route work and load only for library, dashboard,
  discovery, upcoming, personal-media, and detail views.
- The onboarding wizard is also route-scoped: its large setup/claim module loads only for
  `/setup`, a claim-required session, or when the deferred `/api/setup/status` check for a
  signed-in account finds something for it to show (setup unfinished and not dismissed, or a
  non-empty dashboard checklist). A finished install never downloads it, and the dashboard
  renders its checklist through `ifLoaded("onboarding", ...)`.
- The Settings service renderer (`settings-services.js`, with its `settings-ui.js` and
  `help-content.js` dependencies) is route-scoped as well. Direct Settings routes initialize
  it before applying saved config; Dashboard reaches it only through the onboarding checklist
  dependency. Help-content is therefore absent from the global shell and loaded when Settings
  or onboarding needs its guides.
- **Route groups** load when their route is opened: `routeModulesForState()` in `app.js`
  maps each view to its modules (Dashboard and Up Next, Explorer/History/Search, Stats, Upcoming, Discover and the
  personal-media pages, Settings/Tools/Backups, Sync Activity, Manual Watch Review, and the detail
  group for movie, show, and person pages). `handleRouting()` and `applyActiveView()` render
  the core parts immediately and replay once the route's modules arrive; a newer navigation
  supersedes a pending replay.

Rules that keep this correct:

- Each registry entry lists the registered modules it imports statically (`deps`), so they
  load and initialize first. `test/routeModules.test.js` checks this against the real
  import lines, and fails if a shell module or the core graph statically imports a route
  module (that would pull the route's whole graph onto every page).
- `app-events.js` and the route-scoped `media-detail-events.js` reach route modules only through
  `lazyExport()` (actions: loads the module on first use) and `ifLoaded()` (renders and
  cleanups: never triggers a load). A synchronous read of another module (for example the
  watch-date reference or edit-date options) must `await loadRouteModules([...])` first.
  `media-detail-events.js` also owns the watch-date prompt's click and change handlers, so
  `watch-action` lists it as a dependency: a prompt opened from a dashboard card menu would
  otherwise have a dead X and dead date presets.
- Each route-module export used by `app.js` is a `let` holding a no-op placeholder until its
  module loads. **Never hand one to another module by value**: that module keeps the
  placeholder forever. Pass `live(() => name)` for renders or `viaModule(key, () => name)`
  for actions. A placeholder whose result is chained with `.then`/`.catch` must be
  `lazyNoopAsync`. `test/frontendLazyGraph.test.js` enforces all three.
- Each route module is initialized once, by its entry in `ROUTE_MODULE_INITIALIZERS`.
  `loadSavedConfig()` waits for the document-wide shell modules; Settings-only initializers
  apply the already-fetched config when that route is opened, so other routes do not download
  or poll those controls.
- Until the shell modules are ready, `installEarlyActivationCapture()` (in
  `route-modules.js`, next to `ensureShellModules()`) holds the last click
  or form submit and replays it afterwards. It never lets a form fall back to a native GET
  submit.
- The theme is applied before first paint by `theme-boot.js`, a blocking classic script in
  `<head>`. Header logos (`img[data-theme-logo]`) have no `src` in `index.html`; the boot
  script assigns the variant for the saved or system theme as each one is parsed, so a load
  requests exactly one logo whatever the combination of saved theme and system preference.
  The two logo URLs and the fonts are versioned (`?v=`) like other assets, so production
  caches them immutably and a theme toggle is served from cache.
- There is one look (Modern; the old Classic style was removed in October 2026). Its rules
  live in `styles.css`, with the merged Modern section near the end; dark rules use
  `html:root:not(.light-mode)` and light rules `html:root.light-mode`. `theme-boot.js` clears
  the retired Classic/Modern style key once so no stale value lingers. Settings help panels share
  the same surface treatment as the main Settings panel beside them, including on the
  Changelog page.
- The sidebar Appearance panel has **Card Art** (every page) and **Background Art** (shown
  only on the Dashboard and details pages, by a `body:has(...)` rule in `styles.css`)
  checkboxes, both on by default and saved per browser like light/dark under
  `plekt:card-art` / `plekt:background-art` (`off` when off, removed when on).
  `theme-boot.js` sets `html[data-card-art="off"]` / `html[data-background-art="off"]` before
  first paint; `modules/appearance.js` (`ART_TOGGLES`, `isArtEnabled()`, `setArtEnabled()`)
  binds the checkboxes and dispatches `plekt:art-toggle-changed` (`ART_TOGGLE_EVENT`). With
  Card Art off, `card-art.js` stops looking up card backdrops and a CSS rule clears
  `--modern-art` on every `[data-art]`. With Background Art off, `dashboard-modern.js` sets no
  `data-page-art` on the page shell and CSS hides the details-page `.modal-backdrop-image`.
- Dashboard behaviour lives in
  `modules/dashboard-modern.js` (imported by `dashboard.js`): consecutive watches of one show
  collapse into a single TV history card that expands in place when clicked (the newest
  expanded card has a Collapse button). The same module owns the compact toggle beside each
  "Recently watched" title (stored per row under `plembfin:dashboard-compact:tv`
  and `:movie`): every card in the row folds to its poster (the details slide closed behind
  it), clicking a folded poster opens that card, and a further click behaves as normal. The
  Now Playing heading is hidden; the panel holds 3 items by default. Live sessions come
  first, and the slots they leave (all of them when nothing is playing) take the Up Next
  rail's part watched (resume) cards, then its other Up Next cards. Those are featured there
  in a backdrop layout and hidden from the rail by CSS (`data-featured-in-panel` on each
  rail card), and live sessions take the same layout side by side. A cog beside the heading
  opens the options popup (`modules/now-playing-options.js`): allow part watched, allow Up
  Next (both on by default), and the item count (1 to 3), saved server-wide in the
  `nowPlaying` config section. One
  MutationObserver on `#timeline-view` drives all of this, so `sync.js` and `up-next.js`
  have no hooks for it.
- The Posters only switch on Library, Discover, History, Watchlist, Ratings, and Playlists
  (`data-card-mode-toggle`, wired in `app-events.js`, which puts `.page-card-mode-compact` on
  the page panel) folds every item to its poster in every view. The Library switch is
  remembered separately for Movies and TV Shows (`explorerCardModeKey` in `state.js`, re-synced
  by `renderExplorer` on a switch). `modules/page-card-open.js`
  (imported by `media-card.js` and `dashboard-modern.js`) gives those posters the Dashboard
  compact rows' behaviour: a capture-phase click on a folded poster adds `.page-card-open`
  to it instead of following its link, closing the one that was open; a click on the open
  item behaves as normal. It stays open until another poster opens, the page changes, or
  the switch is used, and a re-render of the page reopens it. The poster-mode rules in
  `styles.css` skip `.page-card-open`, and the full-card rules match it, so it takes its
  Posters-off look: three poster slots in a grid (the whole row on phones, or with
  `.page-card-open-full` where fewer than three posters fit), a full-width row in a list or
  table view, its caption under its poster in History's grid view, and its full width in the
  Discover and Playlists rails.
- On History, `modules/history-poster-overlay.js` (imported by `explorer.js`) adds an overlay
  to every poster in all three views: episode name (TV only), watched date, and app badge.
  `styles.css` hides it except on folded posters with Posters only on, where it sits along
  the bottom edge over a blurred dark tint (a stronger tint without `backdrop-filter`). A
  resolved episode title updates both the card and the overlay.
- Card backdrops (the Card Art toggle) live in `modules/card-art.js`. Cards on the Dashboard, History, the
  library, Discover, Watchlist, Ratings, and Playlists carry
  `data-art="type|tmdb|tvdb|imdb|title"` (`cardArtAttribute()`; live cards get it from
  `state.activeSessions` in `dashboard-modern.js`). One MutationObserver on `.page-shell`
  finds cards as any page renders them, and an IntersectionObserver requests a key only when
  one of its cards nears view. Each key's backdrop is looked up through the batched TMDB
  details request and published as a rule in an injected `#modernArtStyles` stylesheet, so
  the cards are never mutated and their reconcile signatures stay stable. A failed lookup is
  retried after 5 s, 30 s, and 2 min; a title with no backdrop is not asked again.
- Every dynamic import carries the canonical `?v=` token. `assets:check` fails an unstamped
  or stale one (`test/assetVersionDynamicImports.test.js`).
- Detail pages mark `plembfin:detail-primary-ready` (`markDetailPrimaryReady()` in
  `media-detail-shared.js`) when title, artwork, synopsis, watch state, and primary actions
  are rendered from real data. The application-speed benchmark reads it.

## State

One global `state` object (`modules/state.js`) holds everything: active view, auth
state, loaded data (history, movies, shows, stats, sessions), paging offsets, caches
(poster lookups, TMDB details, explorer pages), UI toggles, and timers. The `elements`
object holds the DOM references bound at startup. Nothing is reactive - rendering is
manual: change state, call the relevant `renderX()`.

Preferences persist in localStorage under `plembfin:*` keys (view modes, sort orders,
filters, theme, cached pages); the constants at the top of `state.js` list them all.

Two of those caches exist to stop one page load asking for the same thing repeatedly.
`state.showDetailCache`/`showDetailAliases` index a resolved show under every
identifier it is known by, so the detail page's separate lookups by TMDB id, TVDB id
and title share one `/api/show` answer. Both are short-lived and cleared by
`clearDerivedUiCaches()`, because that response carries authoritative watch state.

Explorer paging appends only the newly loaded cards rather than re-rendering the whole
accumulated list, guarded by a check that the grid on screen still matches the prefix
already rendered. Movies and ordinary TV sorts use this path. TV's Next Airing sort moves
existing cards into their updated order as metadata or another page arrives, keeping
their DOM nodes mounted. Sort, view, and data refreshes still redraw the grid.

## Routing

SPA navigation via `history.pushState`:

- `navigateTo(url)` - pushes state, resets the shell and nested view scroll positions,
  then routes so every page entry starts with fresh controls and a clean viewport.
  The shell reset is repeated after the active view paints and after any lazy route
  modules replay the route, so replacing a page cannot restore the previous page's
  scroll offset. Explicit hash anchors and Upcoming's current-week anchor keep their
  intentional destinations. A sidebar click on the page already open
  (`selectView(view, { fresh: true })`) reloads the browser page, exactly like the
  browser's refresh; an in-place reset rebuilt Up Next and the rails several times and
  flickered. Page entry also scrolls every scrolled element inside `.page-shell` (rails
  included) back to its start and dispatches `plembfin:page-entry`
  on `document`; `dashboard-modern.js` (open posters, expanded runs), `page-card-open.js`
  (the in-place open card) and `playlists.js` (expanded episode stacks) listen and fold
  back, so a page is always entered fresh.
- `handleRouting(path)` (`app.js`) - parses the URL into `state.activeView` (+ mode/
  detail state) and calls the right opener. Routes:

| URL | View |
| --- | --- |
| `/`, `/dashboard` | Dashboard |
| `/movies`, `/tvshows` | Explorer in movies/shows mode |
| `/upcoming` | Upcoming TV episode calendar |
| `/discover` | Deterministic TMDB discovery feeds |
| `/watchlist`, `/ratings`, `/playlists` | Personal watchlist, ratings, and playlists (`/custom-lists` redirects to `/playlists`, and a stored `custom-lists` view maps to `playlists`) |
| `/history`, `/stats`, `/search?q=` | History / Stats / Search |
| `/sync-activity` | Sync Activity: per-media sync rows, newest first |
| `/settings`, `/settings/:section` | Settings landing list and parent-group administration sections; child sections use `#hash` anchors |
| `/sync`, `/logs`, retired grouped `/settings/*` URLs | Compatibility aliases normalized to supported settings sections |
| `/movie/:idOrSlug`, `/movie/tmdb/:id(-slug)` | Movie detail (inline in explorer) |
| `/tvshow/:key(/season/:n(/episode/:n))`, `/tvshow/tmdb/:id(-slug)`, `/tvshow/tvdb/:id(-slug)` | Show detail, with season/episode deep links (legacy `#seasonNepM` hash also parsed). The `tvdb` form addresses series TMDB has no record of |
| `/person/:id` | Person profile |
| anything else | Dashboard |

The optional `-slug` after a `tmdb`/`tvdb` route's numeric id (e.g.
`tmdb/202555-daredevil-born-again`) is purely decorative, generated by
`tvShowTmdbHref()` / `tvShowTvdbHref()` / `movieTmdbHref()` in `modules/utils.js`
wherever such a link is built - the id alone resolves the route, so old links without
one still work. It's never treated as identity on its own, so two different real
titles that happen to collide (a reboot sharing a name with its original) can't be
confused. `/tvshow/:key` resolves the same way it always has (matching a locally
known show, then falling back through `/api/show`), but once it has a provider id it
delegates into the same TMDB/TVDB fetch-and-render pipeline the `tmdb`/`tvdb` routes
use, instead of a separate lighter render that never fetched season-level episode
metadata - so all three routes load identical data for the same show, they just
differ in which id (if any) is already known when the page opens. `state.activeShowModalKey`
stays set to the slug throughout, so the address bar keeps the `/tvshow/:key` form.

- `applyActiveView()` toggles the `view-panel` sections, triggers each view's loader,
  and resyncs the topbar (title, back button, and which control group is mounted) so a
  view reached through `popstate` gets the same chrome as one reached through a nav tab;
  `selectView(view)` is the nav-tab entry point (and enforces the forced-password-change
  pin to Settings).
- Detail pages record `state.mediaDetailReturnView` and
  `state.mediaDetailReturnExplorerMode` so closing returns to where the user came from.
  The return library follows the route type: a `/tvshow/…` URL returns to the shows
  library and a `/movie/…` URL to the movies library, so a detail page opened from a
  direct URL still returns to the matching grid. Closing navigates rather than only
  re-rendering, which keeps the address bar and the topbar controls in step with the
  view. `state.internalHistoryCount` tracks how deep in-app history goes so back-button
  behavior stays sane.
- `modules/settings-shell.js` is the settings route registry. It resolves flat sections
  and legacy aliases, renders the landing list/sidebar/mobile selector, and applies
  focused panel visibility.
- `popstate` re-runs `handleRouting` for browser back/forward; direct URL loads hydrate
  the same UI (the server falls back to `index.html` for any non-API path).
- `modules/live-updates.js` coordinates its streaming `/api/live-updates` request with
  the browser Web Locks API, so only one Plekt tab holds the long-lived HTTP
  connection. Other tabs load through the normal connection pool and automatically
  take ownership when the stream-owning tab closes or becomes unavailable.

## Startup sequence (`app.js` bottom + `init` functions)

1. Theme applied from `plembfin:theme` (or `prefers-color-scheme`); warm-up ping to
   `/api/ping`.
2. `bindElements()` populates `elements`.
3. Each module's `init*(callbacks)` is called, handing it the app-level functions it
   may call (`navigateTo`, `setMessage`, `renderExplorer`, …).
4. `initAppEvents` (`modules/app-events.js`) binds the delegated global handlers
  (nav clicks, form submits, search inputs, keyboard shortcuts). Sync Activity's
  pause, refresh, retry-all, failed-only, search, paging, retry, match-fix, dismiss, log, and row-keyboard handlers are
   initialized by `sync-activity.js` only when that route module loads. Explorer/History
   controls and Stats filters/link handlers are initialized by their owning route modules.
5. `onAuthChange` checks `/api/auth/status`; on success the shell shows,
   `handleRouting(location.pathname)` runs, and the active view loads.

## Data-loading conventions

- Loaders are idempotent and guarded (`state.xLoading`, `state.xLoaded`,
  `{ force }` options) so view switches don't stampede the API.
- Personal Rating Sync is an authenticated settings module with its own status
  polling and queue feedback; it does not reuse the watched-state sync activity
  indicator or Force Sync operation state.
- Infinite scroll uses IntersectionObserver sentinels (1200px rootMargin, 240-item
  pages) for vertical views; the mobile History card rail loads its next page when
  the user reaches the right edge so horizontal layout does not eagerly fetch the
  complete log.
- History draws a fresh page (scrolled to its start) as its first 48 cards, then appends
  the rest of the page in idle-time chunks (`appendRestInChunks()` in `utils.js`); its
  paging sentinel is observed only after the last chunk. Re-renders while scrolled into
  the list (paging, in-place refresh) draw the whole list at once so scroll holds.
- Poster hydration is observer-gated and cached - see
  [posters-artwork.md](posters-artwork.md).
- Now Playing polls only while the dashboard is visible - see
  [now-playing.md](now-playing.md).
- Upcoming loads one month at a time through `/api/upcoming`, growing the rendered range
  by a month as the user scrolls toward either end; server-side month results persist
  locally across restarts, while search can prefetch the next 12 months to list matches
  outside the visible range - see [upcoming.md](upcoming.md).
- Up Next loads through `/api/up-next` only while the dashboard is visible, hydrates a
24-hour `plembfin:upNextCache:v6` localStorage snapshot for instant first paint, and
  uses a durable mixed movie/episode server snapshot with stale-while-revalidate. Resume
  cards are ordered by canonical progress updates and released provider/local `next_up`
  cards follow a stable order; a matching resume/next-up observation renders once. A
  changed Up Next snapshot announces its generation on `/api/live-updates`, and feed
  failures/partial refreshes expose source status while retaining the last good rows.
  Watch-state history events refresh the rail after the authoritative history snapshot
  arrives. Only the dashboard's first paint of a page load sends `allowStale=1`, which may
  return a snapshot built before the latest watch history. The server always queues a
  rebuild in that case (bypassing its 10-minute provider-feed throttle), and the client asks
  once more about 2.5 s later without `allowStale`, so a stale first paint is always replaced
  by the authoritative rail. Discover loads cached TMDB feeds and a bounded rolling-12-month watch-history recommendation rail
  through `/api/discover` with type/genre filters and a longer TTL, hydrates the selected rail
  set from a bounded localStorage cache for the first paint, then reconciles it with the server
  cache. Watched titles are removed from every rail using provider identity and title fallback.
  A stale server snapshot is served immediately and refreshed in the background; changed
  snapshots announce a Discover version on `/api/live-updates`, while watch-state events
  refresh the personalized rail without clearing the rendered cards. Both modules preserve
  rendered data while a refresh is in flight and expose loading, empty, stale, and error states.
- Long-lived caches (explorer pages, dashboard history, Up Next, poster lookups, and
  Discover rail snapshots) persist to localStorage with TTLs and versioned keys; bump the
  key version when the cached shape changes.
- TV Shows explorer pages revalidate after 30 minutes even when watch history has not
  changed, because their summaries include independently refreshed next-airing data.
  Movie explorer pages retain the longer persisted TTL.
- `modules/live-updates.js` keeps an authenticated streaming `fetch` open to
  `/api/live-updates`. A shared SQLite data version lets web and worker processes
  announce committed watch-state and personal-media changes, while separate Discover
  and Up Next cache generations announce changed derived snapshots. The client debounces
  bursts and reloads the affected active view in place, then reconnects after a dropped
  stream. A stream silent for 45 s (three missed server heartbeats, typically a
  half-open socket after sleep) is dropped and reopened, as is the stream on `online`
  and on a back/forward-cache `pageshow`. A reconnect `ready` event whose version is
  newer than the tab last saw carries no change list, so it triggers a full refresh
  (history, dashboard, Up Next, History page, Movies/TV Shows grid, Stats, open detail
  page) rather than an in-place patch. Now Playing treats a poll request still pending
  after 30 s as abandoned, so a hung request cannot stop later polls.
- Watchlist mutations are local-first: the Watchlist page and detail cards update after
  the local transaction and show `Saved locally` or provider queue feedback without
  waiting on a remote API call. The same live refresh path reloads Watchlist cards when
  a provider-originated removal or a completed watch changes the canonical list.

### Personal media organization

The personal media module backs the Watchlist, Ratings, and Playlists pages, as well
as the personal actions on movie and TV show detail pages. Watchlist and playlist
membership use provider identity when available, with normalized title/year matching as
a fallback. Detail-page actions update their labels immediately after a successful
change; an existing watchlist item offers removal, while the playlist chooser marks
each playlist that already contains the title as **Added**. Playlists renders every
playlist as its own horizontal media rail, keeps up to four rails in the desktop viewport,
and places additional rails below. Vertical mouse-wheel input enters a rail only after the
pointer has stopped over it, preserving normal page scrolling while the pointer is moving.

The Playlists page itself lives in `playlists.js` (the sync behind it is described in
[sqlite-schema.md](sqlite-schema.md) "Playlist tables"). Each
heading shows the selected apps as icon-and-name badges (icon dimmed while waiting for the
first sync, with a dot for a failed sync or a playlist the app no longer finds; the tooltip
says which) or "Plekt only", the item count, and on the right an **Options** menu
(`details.playlist-options`, closed by an outside click, Escape, or choosing an item) with
Edit and Delete. On desktop, cards are dragged and dropped within
their rail to reorder (`bindPlaylistDragAndDrop`, delegated on the panel): the held card moves
through the rail live, the others slide aside, its slot shows as a dashed insert outline, and a
drag that ends without a drop puts the cards back; full cards also carry a **Move** pill
(`< MOVE >`, centred at the bottom of the card) for touch (the first card's
left arrow and the last card's right arrow are disabled). Both send the whole new order
(`list-reorder`). Playlist cards show no summary (`personalCard(..., { hideOverview })`). Full cards show a "Missing from <app>" note for each selected app whose
library lacks the title; posters-only mode hides the card body, so a "Missing" badge on the
poster carries it instead (tooltip names the apps). New items join the top of a playlist.
A change the sync held for confirmation shows a banner with Confirm and
Discard. Delete moves a playlist to **Recently deleted**, a toolbar button (with its count)
shown only while something is there (`recentlyDeletedButtonHtml`); it opens a wide dialog with
Restore and Delete permanently on each row, plus Delete all permanently (one confirmation,
shown when more than one playlist is there), which closes while it runs and opens again with
what is left; a restore whose name a live playlist took meanwhile asks for a new name. The create/edit dialog (also opened from
media pages and the poster menu) has the app picker: connected apps can be ticked, an app
already selected stays tickable while disconnected, and a notice explains that each app's
copy holds only titles in that app's library.

Each playlist is **Movies**, **TV**, or **Mixed** (movies and episodes together), chosen in
the create dialog and fixed afterwards (opened from a title, the other single type is
disabled and Mixed stays offered); the heading shows the type. A playlist left empty from
before types existed stays untyped until its first title. Add-to menus and the add-to dialog
offer only playlists that accept the title (`playlistAcceptsItem`; Mixed accepts both). TV
and Mixed playlists hold separate episodes, so adding a show opens the
episode picker (`playlist-episode-picker.js`): every episode the metadata lists, specials
and unaired ones included, grouped by season with a select-all per season; episodes already
in the playlist are shown ticked and disabled. The picked episodes go to the top of the
playlist as one block in episode order (`list-add-episodes`).

Automatic playlists (`playlist-rules.js`): the create and edit dialog is a wide dialog with
steps down the side (Name and type, Rule, Apps; a scrolling row on top at 760 px and below).
Opened from the Playlists page it offers "Pick items" or "Automatic"; Automatic adds the Rule
step with the rule editor (source: your libraries or
the TMDB catalogue, genres with any/all from `list-rule-genres`, original languages as tick
boxes (English ticked on a new automatic playlist; none ticked means any), years or a decade, watched
(movies only; a TV playlist holds the next episode of each show), recently added for the
library source only, type (Top rated, the default, Popular, Trending this week, or New
releases), maximum (20 on a new playlist), order (Ranked, the type's own ranking, by default))
and rules out Mixed. Every playlist's Name and type step
has a "Remove items once watched" switch (`remove_watched`), ticked on a new playlist; its help
line for an automatic TV playlist says the show moves to Up Next. Refresh now reads
"Refreshing" and a spinner shows left of the title until the check and reload finish; the
playlist payload's `rule_checking` keeps it spinning after a page reload, and the 10 s reload below also runs
while any check is in progress. A confirmed held check is a "Confirmed" tag in the heading
row. An automatic playlist's cards keep "Remove from this playlist" in the poster menu: the
title is handed off (as with a watched one) so the rule never adds it back; for TV the whole
show leaves. An automatic playlist that has never been checked
says "Checking the rule, this can take a minute or two.", and while one exists and the
Playlists tab is on screen and visible, `watchUncheckedPlaylistRules` reloads the playlists
every 10 s. Otherwise the same watcher asks the server every 30 s for `list-stamp` (a
fingerprint of the playlists part of the payload, also sent as `playlists_stamp`) and reloads
only when it differs, so a scheduled pass (a watched title removed, a rule check, a sync) shows
without a manual reload; it skips a round while a drag is in progress. Editing an
automatic playlist can change its rule; a manual playlist cannot be made automatic. An
automatic playlist's heading row carries an "Auto" label on the right, left of Options (its
tooltip gives the last check), and its Options menu adds Info (a pop-up listing every detail
of the rule, `playlistRuleDetails`), Refresh now (`list-refresh-rule`), and Stop updating
(`list-stop-rule`, asked first), so its rail is as tall as any other. Only a rule error or a held check (Confirm/Discard, `list-rule-held`) adds
a line below the heading. Its cards have no
remove, drag, or Move arrows, and add-to menus leave it out (`playlistAcceptsItem`).

"Import from apps" beside New playlist opens the import dialog (`playlist-import.js`): each
connected app's playlists not linked yet (`list-import-candidates`), with item count and type,
smart playlists counted in a note, and a failing app shown with its error. A picked row shows
Merge / Import separately when its name clashes (Merge by default, offered only for a
compatible type) and "Sync to" app choices with only its own app ticked. Import sends
`list-import`.

With Posters only on, TV and Mixed playlists stack neighbouring episodes of one show
(`playlistStackRuns`): a stack card (the show's poster, an "N episodes" count, and a Missing
badge if any episode is missing) sits before its episode cards, which are hidden while it is
collapsed. A movie or another show between episodes starts a new stack, so the poster order
stays the playing order; a lone episode is a plain poster. Clicking the stack expands it in
place (each episode keeps its own Missing badge) and clicking again collapses it; the open
state survives re-renders. `page-card-open.js` leaves stack cards alone. A collapsed stack
drags as a block (`reorderedBlock`), and a drop onto a stack lands before its first or after
its last episode. With Posters only off, stack cards are hidden and every episode shows.
Every folded episode poster in a playlist (stacked or not) carries the History poster
overlay (`history-poster-overlay` classes plus `playlist-poster-overlay`): its episode code
and name. The Missing badge sits in the poster's top-left corner on every playlist poster
(movie, episode, or stack), since the top right holds the menu button and the stack count.

Movie and TV ratings use their provider identity. An episode rating originates from
the episode row on the show detail page and is keyed by the parent show's identity
plus its season and episode number. The Ratings page consumes the canonical server
record, while the client also collapses any legacy aliases defensively. Episode
artwork remains independent from the show's poster.

### Plex Watchlist Sync settings

The Plex Watchlist Sync panel lives in Settings → Sync → Sync Tools and is rendered by
`watchlist-sync-settings.js`. It exposes an on/off control, a read-only summary of the
Plex connection, and a **Sync now** button in the bottom right of the panel's action row
(the Personal Rating Sync panel above it carries the same control in the same place). Status polling reports the sync state and Plex
capability. Enabling it immediately starts a safe-union sync, so Plex-only additions are
imported without allowing an empty first snapshot to erase Plekt.

The same `watchlistSync.enabled` flag has two other entry points, so all three stay in
step through the `plembfin:config-changed` event: the Plex card under Media Servers
(an `extraToggles` entry on `renderInlineServicePanel`, which saves on change because the
card's Save button only submits connection fields) and the Plex row of guided setup
(checked by default, applied when that step completes).

The panel writes its live one-line state to `#watchlistSyncSummary`, never to
`#watchlistSyncHelp` - the latter belongs to `renderSettingsInlineHelp`'s static guide, and
when both wrote to one element the 30-second status poll destroyed the guide every time.

At mobile widths, Discover, Watchlist, Ratings, Playlists, and History use the
dashboard's compact poster-first card geometry. Each feed or collection is a
horizontal rail that exposes the next card at the right edge, while the card's
metadata and actions remain below its poster inside the tile.

The mobile page topbar mounts only the active page's controls. Explorer and Upcoming
control groups keep their hidden state when they are moved into the shared topbar, so
their search/calendar controls cannot leak onto Discover, personal-media, History,
Stats, or Settings pages. Upcoming, Discover, Watchlist, Ratings, Playlists, History,
Stats, and Settings use the same media-detail-style icon/label action strip; secondary
filters, search, sizing, and settings-section controls live in a compact Options disclosure.
Calendar navigation remains visible for Upcoming, while the other page controls keep the
same compact action geometry without squeezing a full desktop form into the phone width.

## Settings Layout & Design Standards

These are canonical values for the settings UI - do not change them without explicit user instruction.

### Spacing Token Reference (`styles.css` `:root`)

| Variable | Value | Pixels |
|---|---|---|
| `--space-1` | 0.25rem | 4px |
| `--space-2` | 0.5rem | 8px |
| `--space-3` | 0.75rem | 12px |
| `--space-4` | 1rem | 16px |
| `--space-5` | 1.5rem | 24px |
| `--space-6` | 2rem | 32px |

### Canonical Settings Gaps

All of the following must stay consistent - do not change one without updating the others.

| Element | Property | Value | Notes |
|---|---|---|---|
| `.app-shell` | `gap` | `var(--space-3)` | Gap between topbar and view content |
| `.page-topbar + .view-panel` | `padding-top` | `var(--space-2)` | Extra breathing room below topbar |
| `.settings-content` | `gap` | `var(--space-3)` | Gap between settings panes when stacked |
| `.settings-pane` | `gap` | `var(--space-3)` | Gap between `.settings-row` elements |
| `.settings-row` | `gap` | `var(--space-3)` | Gap between left (main) and right (help) columns - **must equal the topbar gap** |
| `.settings-row-main` | `gap` | `var(--space-3)` | Gap between stacked cards inside main column |
| `.settings-row-help` | `gap` | `var(--space-3)` | Gap between stacked cards inside help column |
| `.settings-card` | `padding` | `1.5rem` (help column) / `0` (main column) | See "Settings Card Shell" below - the main-column value comes from a more specific override |

### Spacing Rules

1. **Every structural layout gap in the settings shell uses `var(--space-3)` = 0.75rem.** This applies to `.settings-content`, `.settings-pane`, `.settings-row`, `.settings-row-main`, and `.settings-row-help` - all must use the same token so topbar gap, horizontal gap, and vertical section gaps are visually identical.
2. **Card internal padding differs by column.** The base `.settings-card { padding: 1.5rem !important }` rule applies as written to help-column cards (`.settings-row-help > .settings-card`). Inside the main column, `.settings-pane .settings-row-main > :is(.settings-card, .sync-panel, .logs-panel, .backup-settings-panel)` is more specific and overrides it to `padding: 0 !important`, moving the padding onto the child `.section-heading` and content wrapper instead - see "Settings Card Shell" below for the full structure.
3. **Never add per-panel margin or gap overrides** (e.g. `margin-top` on a specific `settings-pane[data-settings-panel]` selector). All spacing must come from the flex gap alone.
4. **Do not merge `.app-shell` into a shared selector with `.view-panel`** - `.app-shell` needs `gap: var(--space-3)` while `.view-panel` needs `gap: 0`. Merging them collapses the topbar into the page content.

### Settings Card Shell

The Sync Tools section is the reference implementation for the primary settings card
shell in the main column. Sync Tuning, Sync Issues, and Sync History share the exact
same layout system, spacing, and styling rules, and the same shell applies across every
settings panel: Account, Media Servers, Seerr, Webhooks, Metadata Providers, Refresh
Metadata, System Integrity, Trakt, Database Repairs, Rebuilds, Backups, Restore, Sync
Tuning, Sync Tools, Sync Issues, Sync History, Server Logs, Changelog, and Image Cache.

Each settings page uses this canonical DOM hierarchy:

```html
<div class="settings-pane">
  <div class="settings-row" data-sub-panel="[panel-id]">
    <div class="settings-row-main">
      <article class="glass-panel p-section settings-card tool-section-card">
        <div class="section-heading sync-heading sync-static-heading">
          <div class="sync-heading-title">
            <p style="margin: 0;">[Title]</p>
            <!-- Optional status pill -->
            <span class="status-pill status-muted">Ready</span>
          </div>
          <span>[Description / Subtitle]</span>
        </div>
        <div class="media-force-sync-options sync-tools-content">
          <!-- Content rows / forms / action items -->
        </div>
      </article>
    </div>
    <div class="settings-row-help">
      <article class="glass-panel p-section settings-card">
        <div class="section-heading">
          <p>[Help Title]</p>
          <span>[Help Subtitle]</span>
        </div>
        <!-- Help sections -->
      </article>
    </div>
  </div>
</div>
```

The main column (`.settings-row-main`) is the primary working area (~2.2fr flex ratio).
The help column (`.settings-row-help`) explains the working area (~1fr flex ratio,
~320px fixed reference) and collapses below `900px`.

**Main settings card** - the primary card follows the canonical Sync Tools shell:

- Full-width `<article class="glass-panel p-section settings-card tool-section-card">` inside `.settings-row-main`.
- Outer card padding removed (`padding: 0 !important`) and `gap: 0 !important` so the heading and content form one continuous panel.
- `overflow: hidden` so the header border and rounded corners stay clean.
- `border: 1px solid var(--line-strong)` and `background: var(--panel)` for the outer card surface.
- `border-radius: var(--radius)` (8px default).

**Card heading** - the first direct child is the section heading:

- `<div class="section-heading sync-heading sync-static-heading">`.
- Title and optional status pill grouped on the left inside `<div class="sync-heading-title">`; supporting description `<span>` on the right.
- `padding: var(--space-3) !important` (16px / `1rem`), `margin: 0 !important`, bottom border `1px solid var(--line) !important`.
- Title text: `<p style="margin: 0;">` with `font-weight: 700`.
- Supporting subtitle `<span>`: `var(--muted)`, `0.78rem` (`font-weight: 500`), right-aligned on wide screens.
- Accordion header toggles (e.g. Sync History) use `<button class="section-heading sync-heading sync-static-heading accordion-header" type="button">` with `background: transparent; border: none; width: 100%; cursor: pointer;`.

**Card content** - every content wrapper immediately following the heading:

- `<div class="media-force-sync-options sync-tools-content">`.
- `padding: var(--space-3) !important` (16px); child rows use `gap: var(--space-2) !important` (12px).
- Content elements have `margin-top: 0 !important` to avoid doubling the flex gap.

**Action rows, fields, and controls** - action rows, tuning fields, issue items, match reports, and history cards use the standard Sync Tools treatment:

- Full border `1px solid var(--line)`, `border-radius: var(--radius)` (8px), `background: var(--panel-2)`, `padding: var(--space-3)` (16px).
- `:hover` and `:focus-within` change border to `var(--blue)` and background to `var(--panel-3)` with `transition: border-color 160ms ease, background 160ms ease`.
- Descriptions stay left-aligned and use the available width before wrapping.

Field layout and multi-line help formatting (Sync Tuning):

- Settings input fields use a 2-column CSS Grid: `display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 13rem); align-items: center; gap: var(--space-3);`, collapsing to a single column below `760px`.
- Field title: `color: var(--text)`, `font-weight: 700`.
- Field help text with a default/range uses explicit `<br>` line breaks and `helpIsHtml: true`:
  ```html
  <span class="settings-field-help">
    [Description].<br>
    Default: [default value]. Valid range: [min]-[max].
  </span>
  ```
  Color `var(--muted)`, `font-size: inherit`, `line-height: 1.45`, `max-width: none`.

Buttons (`.sync-tool-button`, `.button-primary`, `.button-ghost`, `.sync-action-btn`):

- `min-height: 2.05rem !important` (~33px), `padding: 0.45rem 0.72rem !important`.
- `font-size: 0.78rem !important`, `font-weight: 800 !important`, `letter-spacing: 0 !important`, `border-radius: 4px !important`, `box-shadow: none !important`.
- Primary actions use `.button-primary` (blue accent). Cancel/stop actions use `.sync-tools-cancel-button` or `.button-danger` with red OKLCH tinting: border `color-mix(in oklch, var(--red) 55%, var(--line-strong))`, background `color-mix(in oklch, var(--red) 14%, var(--panel-2))`, color `var(--red)`.

Responsive behavior:

- Below `900px`, `.settings-row-main` stacks above `.settings-row-help` at full width.
- Below `760px`: section headings stack (`flex-direction: column`, `align-items: flex-start`) with left-aligned subtitle text; action buttons stack full-width; grid rows (target rows, tuning fields) collapse to a single column.
- The same heading, border, background, and padding hierarchy is preserved in both dark and light themes.

**Implementation rule**: when adding or updating a settings page, use the shared main-card shell (`article.glass-panel.p-section.settings-card.tool-section-card`) and the Sync Tools structure first. Add a component-specific rule only when the content cannot fit the standard heading/content/action-row pattern, and document the exception beside the component styles.

### Settings Navigation Rules

5. **All settings navigation links** (sidebar buttons, overview link rows, section-select dropdown options) must navigate to the **parent group path**, with an optional child `#hash` anchor (for example `/settings/sync#full-sync-watchstates`). Child anchors identify the in-page section on the parent route.
6. **`focusSettingsRoute`** must scroll the `.page-shell` container to the selected section while respecting its scroll margin; a route without a hash should start at the top of the parent group page.

## Where new frontend code goes

Place new frontend code in the most specific existing module that owns its feature area.
The size limits and grandfathered files that constrain these modules are in `CLAUDE.md`
("Module discipline"); new code for an over-limit file goes into a sibling module instead.

| Feature area | Module |
| --- | --- |
| Formatting, string escaping, date helpers | `modules/utils.js` |
| Poster URLs, image caching, `posterMarkup` | `modules/images.js` |
| Static help/guide HTML | `modules/help-content.js` |
| Always-available appearance preferences | `modules/appearance.js` |
| Always-available sync/manual-review indicators and compact status summaries | `modules/status-indicators.js` |
| Core movie lookups and Now Playing route links | `modules/media-routing.js` |
| Core deferred cast disclosure markup and focus handling | `modules/cast-disclosure.js` |
| Sync status, sync history, now-playing polling | `modules/sync.js`, `modules/sync-preview.js` |
| Sync Activity page (`/sync-activity`), including its route-scoped action/event handlers | `modules/sync-activity.js` |
| Dashboard rendering | `modules/dashboard.js` |
| Dashboard behaviour (TV runs collapsed only in posters-only mode, Now Playing feature layout, the page backdrop) and the compact Recently watched rows | `modules/dashboard-modern.js` |
| Backdrop artwork behind cards on every page (Card Art) | `modules/card-art.js` |
| Posters only on the library and media pages: a clicked poster opens its card in place | `modules/page-card-open.js` |
| History, Posters only: episode, date and app overlaid on each poster | `modules/history-poster-overlay.js` |
| Shared media identity/deduplication | `modules/media-records.js` |
| Stats rendering | `modules/stats.js` |
| Explorer grid, history page, search page | `modules/explorer.js` |
| Upcoming page (scrolling month calendar of upcoming episode air dates) | `modules/upcoming.js` |
| Up Next rail, provider push, dismissed-items dialog | `modules/up-next.js` |
| Up Next show identity, same-title show veto, dismissal keys, and action markup | `modules/up-next-shared.js` |
| Personal ratings/watchlist/playlist metadata fill (overview, release date) | `modules/personal-media-metadata.js` |
| Playlists page: rails, app picker, Movies/TV/Mixed type, reorder, missing notes, held changes, Recently deleted | `modules/playlists.js` |
| Playlist episode picker (adding a show to a TV playlist) | `modules/playlist-episode-picker.js` |
| "Import from apps" dialog (app playlists into Plekt playlists) | `modules/playlist-import.js` |
| Automatic playlists: rule editor, rule summary and Info pop-up, Auto label, Refresh now, Stop updating, held rule check | `modules/playlist-rules.js` |
| Backup/restore tools (Settings route) | `modules/tools-backups.js` |
| Settings changelog renderer and Main/Alpha tabs (build-version display formatting is core, in `modules/utils.js`) | `modules/changelog-channels.js` |
| TV/movie detail entry points, lookups, modal-close routing | `modules/media-detail.js` |
| Detail-modal shell/context: callbacks, `authHeaders`, modal DOM root, render-token, debug modal | `modules/media-detail-context.js` |
| Detail-page watch and sync info summary rendering | `modules/media-info-summary.js` |
| Route-scoped shared TMDB/Seerr rendering fragments (cast, trailers, images, ratings, recommendations) | `modules/media-detail-shared.js` |
| TV show detail rendering (seasons, episodes, show modal) | `modules/media-detail-show.js` |
| Open season episode box placement beside its card (season card size watch) | `modules/season-card-sizes.js` |
| Movie detail rendering | `modules/media-detail-movie.js` |
| Person profiles and filmography | `modules/media-person.js` |
| Edit dialogs and watched-date/image/match tools | `modules/edit-dialogs.js` |
| Fix Match per-show TVDB/TMDB season and episode numbers, its preview confirmation and the Trakt second confirmation | `modules/show-season-source.js` |
| Season Posters tab in Edit Images (season list, per-season options) | `modules/season-posters-panel.js` |
| Manual watched/unwatched actions | `modules/watch-action.js` |
| Shared calendar/time picker (used by edit dialogs and mark-watched prompts) | `modules/calendar-picker.js` |
| TMDB detail/season/person enrichment helpers | `modules/tmdb.js` |
| Trailer playback and photo lightbox | `modules/media-lightbox.js` |
| Trakt/CSV import and settings tools bridge | `modules/tools.js` |
| Tautulli connection and one-time watch-history importer | `modules/settings-services.js`, `modules/tautulli-import.js` |
| Live Trakt connection and initial-sync controls | `modules/tracker-settings.js` |
| Authenticated live watch-state refresh stream | `modules/live-updates.js` |
| Backup tools and appearance save actions | `modules/tools-backups.js`; `modules/appearance.js` owns the always-available defaults/body/loading helper |
| Maintenance diagnostics, cache tools, sync repair tools, and sync health | `modules/tools-maintenance.js`, `modules/tools-health.js` |
| Library-wide duplicate-watch cleanup (Settings → Tools → Database Repairs) | `modules/tools-duplicates.js` |
| Watch-state aliases card: fold or dismiss unproven episode-id playstate rows (Settings → Tools → Database Repairs) | `modules/tools-playstate-aliases.js` |
| Wipe data (Settings → Tools → Wipe data): watch history, sync history/logs, and full factory reset | `modules/tools-wipe-data.js` |
| Auth, session, tokens | `modules/auth.js` |
| Guided first-run setup (`/setup`), account-claim form wiring, dashboard checklist, Settings resume banner | `modules/onboarding.js` |
| Debug/diagnostic logs & telemetry export | `modules/logs.js` (categorization, local time formatting, export) |
| Connection label formatting | `modules/settings.js` |
| Shared settings modal, picker, and card-grid primitives | `modules/settings-ui.js` |
| Media-server and metadata-provider settings cards/modals | `modules/settings-services.js` |
| Personal Rating Sync settings, provider directions, status polling, and manual actions | `modules/rating-sync-settings.js` |
| Flat settings routes, landing list, sidebar, help panels, and clean path routing (`/settings/media-servers`, `/settings/sync`, etc.) | `modules/settings-shell.js` |
| Shared `state` and `elements` objects | `modules/state.js` |
| Global app event wiring | `modules/app-events.js` |
| Settings-page event wiring (logs, admin login/webhook secret, import, backups, maintenance tools, sync controls), loaded with the Settings route | `modules/settings-events.js` |
| Media-detail modal click delegation (cast/trailers/poster edit/watch actions/card navigation) | `modules/media-detail-events.js` |
| Shared copy for the Plex historical watched-sync setting (setup wizard and Sync Tuning) | `modules/plex-history-policy.js` |
| Poster-card three-dot overflow menu (Mark Unwatched / Edit watch date / Fix match) outside the media detail pages | `modules/poster-menu.js` |
| Route-module registry: on-demand `import()` loaders, dependency order, `lazyExport`/`ifLoaded`, shell-module readiness and early click/submit hold-and-replay | `modules/route-modules.js` |
| App startup, routing, `bindElements` | `app.js` |

Create a new module only when the feature area fits none of these and would exceed 150
lines, then add it to this table.

## Adding a new module

1. Create `public/modules/<feature>.js` with named ES exports.
2. If the module is part of the core graph (needed for the first paint), add
   `<link rel="modulepreload" href="/modules/<feature>.js" />` to `index.html`. A route,
   dialog, or tool module is instead registered in `route-modules.js` (see "Core graph and
   route modules" above) and gets no preload.
3. Import it in `app.js` (or the owning module) and, if it needs app-level functions,
   give it an `init<Feature>(callbacks)` entry point.
4. Add the module to the file map in [architecture.md](architecture.md) and the relevant
   feature documentation.

### Cache-busting version strings

Every local bundle, stylesheet, icon, and manifest reference under `public/` carries the
same `?v=<package-version>` token. A module URL is a module identity to the browser: the
same file imported under two different suffixes is loaded and instantiated twice, so any
module-level state exists twice over. The `assets:check` build guard rejects both bare local
asset references and mismatched tokens, and it checks URLs assembled at runtime as well as
fully literal ones.

Build an icon URL through `platformIconUrl()` in `utils.js` rather than writing the path
inline, and never render an icon URL that arrived from the server or from a persisted cache.
Markup held in `localStorage` outlives the release that produced it, so a stored URL pins an
old asset version indefinitely; rebuilding the markup from the platform target keeps every
reference on the current one.

When the package version changes, run `npm run assets:update`. It rewrites every local
reference and its `modulepreload` link in `index.html` together, so the whole app keeps
referring to one URL per module. Do not hand-bump one import or preload in isolation.

The server compresses eligible API and static responses when the client requests gzip.
`index.html` and managed public assets use revalidation rather than a long-lived cache
policy, while the authenticated live-update stream remains uncompressed and carries
`Cache-Control: no-cache, no-transform`. A reverse proxy may be selected by the operator,
but it must not recompress an already encoded response or transform the live stream.
