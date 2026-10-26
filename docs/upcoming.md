# Upcoming Page

The Upcoming page shows a continuously scrollable calendar of historical and future TV
episode air dates for tracked shows. It uses the same TV metadata split as detail pages:
TheTVDB supplies season, episode, title, and air-date structure, while TMDB identity is
used for show navigation.

## Files

| File | Role |
| --- | --- |
| `public/modules/upcoming.js` | Week-range scrolling, month navigation, client-side search, calendar rendering, poster hydration, show navigation |
| `public/app.js` | Route binding for `/upcoming`, element binding, module initialization |
| `public/index.html` | Upcoming nav item, page shell, month controls, search field, calendar container |
| `public/styles.css` | Week-row grid, mobile agenda layout, search results, poster sizing |
| `server/src/routes/metadata.js` | Authenticated `handleUpcoming` API response |
| `server/src/utils/upcomingCalendarCache.js` | Persistent month results, historical backfill, future checks, and new-show merging |
| `server/src/routes/calendarFeed.js` | Admin feed URL settings and token-authenticated `.ics` response |
| `server/src/utils/calendarFeed.js` | Public-origin validation, token/type storage, and calendar serialization |
| `server/src/index.js` | Dispatches `GET /api/upcoming` |

## Private calendar subscription

The **Subscribe** button in the Upcoming page navbar opens the private `.ics` URL controls.
Choose TV shows, movies, or both (both are selected by default). Generate or regenerate the
URL to save the selection; regenerating immediately revokes the previous URL. Calendar clients
cannot send Plekt login cookies, so the URL contains a high-entropy bearer token. The token is stored
in SQLite runtime state and compared in constant time. The public read-only endpoint returns the
selected upcoming library episodes and/or cached movie release dates and answers with no calendar
data for an invalid token. The feed
uses the persistent upcoming episode cache and cached movie metadata so a calendar refresh does
not trigger metadata requests across the whole library. Watchlist and playlist entries are not
included. The URL uses the browser's current origin, or `PLEKT_PUBLIC_URL` when configured.
Local hostnames and private or reserved IP addresses are rejected and never shown. An origin
must be reachable by the calendar service; its public-looking name alone does not prove that.
The access logger
redacts the URL's `token` query parameter.

## Backend

`GET /api/upcoming?month=YYYY-MM` returns episodes airing in the requested
month. The handler:

1. Returns the requested month immediately when it exists in
   `data/upcoming-calendar-cache.json`.
2. On a cache miss, reads the TV Shows library and `data/next-airing-cache.json`.
3. Uses the next-airing cache to skip irrelevant shows for future months, and scans all
   tracked shows for the current or a historical month.
4. Fetches merged TMDB/TVDB show details to resolve the TVDB id.
5. Reads the current and next season for current/future calendars, or all known seasons
   for a historical calendar, from the TVDB season cache.
6. Stores and returns episodes whose air dates fall within the requested month.

The scheduler checks the persistent calendar cache every 10 minutes. It progressively
builds the previous 24 months once and checks the current month plus the next 12 months
for changes every 6 hours. A check only rewrites a month when its episode data changed;
historical months are not periodically refreshed. Up to 60 month results survive server
restarts, so revisiting a month does not repeat metadata pulls.

Each month records the tracked shows included in its result. Opening a cached calendar
after another show enters the library fetches only that missing show and merges its
episodes immediately.

Opening the Upcoming page revalidates the current month with
`GET /api/upcoming?month=YYYY-MM&revalidate=1`. That request answers from the persistent
cache straight away and rebuilds the month behind the response, so the calendar paints
from cached data while the refresh happens out of band. Background rebuilds are deduped
per month and throttled to one per ten minutes, so repeatedly reloading the browser
cannot queue a burst of metadata pulls. A rebuild only rewrites the cache file when the
episode data actually changed.

`&refresh=1` is the blocking variant: it rebuilds the month before responding and is
reserved for explicit re-syncs. It takes several seconds on a normal library.

Other months are fetched once as the visible week range reaches them and then reused for
the rest of the session. The months needed for the visible range are requested in
parallel and each renders as it arrives.

Every month request checks the tracked-show list via
`getCachedShows({ includeScheduledLibraryHistory: true })`, which is memoized on the
in-memory `dataVersion`. A warm month therefore answers in single-digit milliseconds; the
first request after a restart or a library change pays for rebuilding that list once.

## Frontend Behavior

The calendar renders one block per month, stacked in date order. A block is a sticky
month heading (e.g. "July 2026") pinned below the topbar while that month is in view,
followed by that month's Monday-start week rows. Each row is a 7-column grid of day
cards - the same card style used across the app for a single day (weekday name, date
number, episode entries). Episodes for the same show on a day are grouped together;
when there are more than two, the first two appear with a View more button for the rest.
The same limit applies to search results. A week that straddles a month boundary appears in both blocks,
and the days belonging to the other month render as invisible spacers, so every date is
drawn once, under its own heading, with the columns still aligned. Confining each heading
to its own block is what stops the headings stacking on top of one another at the top of
the scroller.

Opening the page (via nav click or direct URL) always puts the current week in the top
row, regardless of where a previous visit left off. The month either side is already
rendered, so the user can scroll up into the past or down into the future straight away.
Scrolling near either end extends the loaded range automatically - one month at a time,
up to 24 months either side of the current month - and fetches the newly visible months
from `/api/upcoming` on demand. Scrolling upward preserves the user's viewport position
as older months are prepended.

The topbar title tracks whichever month's heading is currently pinned below the topbar.
The Previous/Next arrows step one month back or forward from that month and land it as
the topmost month, with its heading pinned directly under the topbar; Today returns to
the current week the same way. All three extend the loaded range first if needed, and a
jump to the last loaded month appends further months below it - otherwise there would be
nothing under the target to scroll against and it would come to rest partway down the
page rather than at the top. The jump is instant rather than animated, and scroll events
are ignored briefly afterwards, so the month the arrows step from is always the month
that was just selected.

At `<=760px`, week rows collapse to a single-column agenda list. Outside-month spacer
cards are hidden, but empty days remain visible so the current day is still a useful
anchor when nothing airs. The mobile header is a single row with Search on the left,
arrow/month navigation in the middle, and Today on the right. Opening the page or
choosing Today anchors the actual current-day card, then the agenda can keep extending
as the user scrolls.

The search box switches the page to a dedicated results view: a flat, month-grouped list
of every matching episode (filtered by show title, episode title, or an episode code
such as `S2E4`) across all months currently cached, including a 12-month lookahead that
prefetches in the background while typing. Clearing the search returns to the normal
scrollable month grid.

Posters use `posterMarkup()` and `hydratePosters()` from `public/modules/images.js`, so
the standard local poster cache and fallback pipeline applies. Episode cards use a saved
season-poster override ahead of cached TMDB/TVDB season art when one is available.
