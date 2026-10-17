# Plex Integration

How Plekt talks to Plex: three inbound channels (webhook, WebSocket, polling) and
one outbound client. Read [architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/plexClient.js` | Outbound HTTP client - all Plex API calls |
| `server/src/utils/plexNotificationListener.js` | Real-time WebSocket listener for library watch-state changes |
| `server/src/utils/parsers.js` | `parsePlexWebhook` / `parsePlexGuids` / `buildPlexMediaFromMetadata` - webhook + metadata normalization |
| `server/src/utils/recentWatchImport.js` | `syncRecentlyWatchedFromPlex` - catch-up watched import |
| `server/src/scheduled.js` | `syncRecentlyResumableFromPlex` - catch-up polling and Up Next source-ledger refresh |
| `server/src/utils/unwatchedStatusPoll.js` | `checkPlexUnwatchedStatus` - fallback unwatched poll |
| `server/src/utils/liveSessions.js` | Polls `/status/sessions` for Now Playing |
| `public/modules/help-content.js` | `plexCredentialGuide()`, `plexWebhookSetup()` - in-app setup guides |

## Configuration

Settings → Media Servers → Plex uses **Connect Plex account** by default. Plekt opens
Plex authorization with a strong PIN bound to Plekt's locally generated device key,
verifies the signed-in account, discovers its servers, and stores the selected server plus
encrypted managed account/server tokens. The resulting short-lived Plex JWT is refreshed
with that private device key before clients receive runtime configuration. Plekt never
sends the private key to Plex. Legacy PIN flows that were already open before an upgrade
can still complete, but every new connection uses strong PIN/JWT authorization.

Manual setup remains optional; its values are stored in the `settings` SQLite row via
`configStore.js`, and env vars `PLEX_SERVER_URL` / `PLEX_TOKEN` / `PLEX_USERNAME` act as
defaults:

- **baseUrl** - reachable *from the Plekt server machine*, not just the browser
- **token** - an X-Plex-Token
- **username** - which Plex account's watch state to track and write. `admin` or
  `owner` maps to account ID 1; any other name is resolved against `/accounts` and
  memoized (`resolvePlexAccountId` in `plexClient.js`, 10-min TTL, 1-min negative TTL)

`validateConfig` requires all three when Plex is enabled in manual mode. Only one mode is
active: completing account setup removes the stored manual token, while saving manual
setup switches Plex back to manual mode. Test the connection with
Open the Plex card under **Settings → Media Servers** and select **Test**
(`POST /api/test-connection`).

## Auth style

Every Plex HTTP request sends the token as an `X-Plex-Token` **header**
(`plexAuthHeaders`), never a query parameter, so tokens stay out of access logs. The
single exception is the notification WebSocket, whose handshake cannot carry custom
headers - there the token stays in the URL.

## Plex Watchlist Sync

Settings → Sync → Sync Tools can enable the separate Plex Watchlist Sync projection.
The Plex adapter (`plexWatchlistClient.js`) uses the account-level Universal Watchlist,
not a selected server library, so it authenticates with the connected Plex account JWT.
It deliberately does not reuse a server token for account operations. Enabling Plex
Watchlist Sync authorizes native reads and writes; Plekt no longer exposes separate
representation or account-write controls.

The whole account watchlist surface lives on `discover.provider.plex.tv`, not on the
selected Plex Media Server and not on `metadata.provider.plex.tv`. The adapter uses these
endpoints, each confirmed against the live account API:

| Operation | Request |
| --- | --- |
| Read the watchlist | `GET discover.provider.plex.tv/library/sections/watchlist/all` with `includeExternalMedia=1` and `includeGuids=1`, paged by `X-Plex-Container-Start` / `X-Plex-Container-Size` |
| Resolve a target | `GET discover.provider.plex.tv/library/search` with `searchTypes=movies` or `tv`, `searchProviders=discover`, and `includeMetadata=1` |
| Add | `PUT discover.provider.plex.tv/actions/addToWatchlist?ratingKey=<key>` |
| Remove | `PUT discover.provider.plex.tv/actions/removeFromWatchlist?ratingKey=<key>` |

Each detail above is load-bearing, and getting one wrong fails quietly enough to look like
a provider outage:

- The **metadata host** answers the watchlist section with `404 Section 'watchlist' not
  found!`, and the action endpoints with a bare `404`.
- **`includeExternalMedia=1`** matters because most of a watchlist is titles no reachable
  server holds.
- **`includeGuids=1`** is what puts the `Guid` array in the response. Without it every
  entry arrives with no imdb/tmdb/tvdb id and can only be matched on title and year.
- **`searchProviders=discover`** is required; omitting it returns `400 Missing required
  param searchProviders!`. Resolution searches the Plex catalog rather than a server
  library because a watchlist exists to hold things the account does not own, so
  `/hubs/search` on a media server is the wrong question.
- The write parameter is **`ratingKey`, singular**. `ratingKeys` is rejected with `400
  Invalid value provided for ratingKey!`.
- Both mutations are **`PUT`**. `POST` answers `404`, and a `DELETE` does not remove.

The rating key is the account catalog key, which is also the last segment of a
`plex://movie/<key>` guid, and the adapter falls back to that guid when a target carries no
resolved id.

Plex does not publish a stable, fully documented account-watchlist mutation API in the
PMS API reference. Plekt therefore keeps native paths configurable - overriding
`watchlistAddPath` with a template containing `{id}` still substitutes into the path
instead of sending `ratingKeys` - probes
capability before delivery, and leaves the canonical local row intact when the account
or target is unavailable. The initial snapshot takes a safe union and imports Plex-only
additions. A complete later snapshot is required before a missing previously managed
item can be treated as a provider removal.

## Inbound channel 1: webhooks

Plex webhooks (a Plex Pass feature) POST **multipart form data** to
`/api/webhook?token=<webhookSecret>`. `parsePlexWebhook` (`parsers.js`) reads the
`payload` field and derives the phase:

- `media.play` / `media.resume` / `media.progress` / `media.pause` → `active`
- `media.scrobble` → `completed`
- `user.playrate` (a rating) → `ignored`; rating a title is not evidence it was played
- `media.stop` → `completed` at the watched threshold (90% by default), else `ended`

Provider IDs come from `parsePlexGuids`, which understands both modern
(`tmdb://`, `tvdb://`, `imdb://`) and legacy agent (`themoviedb`, `thetvdb`) GUID
formats.

Outbound episode matching keeps a connection-scoped, ten-minute identity index. One
series resolution and one `allLeaves` fetch populate the coordinate map for a burst of
sibling episodes, and concurrent callers join the same in-flight lookup. Exact item keys
remain coordinate-specific and TTL-bounded. APIs that inspect current `viewCount` or
container state continue to fetch fresh Plex data instead of treating the identity index
as watched-state authority. When a mutation misses an exact episode, Plekt invalidates
the series index and retries once before reporting the destination skipped.

Two Plex-specific caveats (also in [webhooks.md](webhooks.md)):

- Native Plex webhooks fire only on **state changes** - there is no heartbeat. A single
  `media.play` creates an `active_sessions` row that expires after the active-session
  TTL (5 minutes by default) unless
  another event arrives. Continuous "still playing" tracking comes from the scheduler's
  session polling, not from webhooks.
- Plex **never sends unwatched (unscrobble) events**. The WebSocket listener below
  compensates.

## Inbound channel 2: the notification WebSocket

`plexNotificationListener.js` connects to `ws(s)://<plex>/:/websockets/notifications`
and watches `timeline` notifications for movies (type 1), shows (type 2), seasons
(type 3), and episodes (type 4) from the library section (supporting both array and
single-object `TimelineEntry` payloads). Show and season changes are expanded to their
episodes so bulk watched/unwatched actions propagate immediately. It is pure transport: reconnect with backoff (3s → 60s), debounce per
ratingKey (2.5s), then hand each changed ratingKey to `onLibraryItemChange` - capped at 2
concurrent handlers, queueing the rest. Show and season containers fan out at most two
episode handlers at a time, and repeated same-state notifications are coalesced for one
minute. A notification burst therefore cannot multiply into a provider and database storm
while the current state is being verified.

Reverse proxies in front of Plex (Cloudflare, nginx, Traefik, etc.) commonly drop an idle
WebSocket after a timeout without ever sending a close frame, leaving a "zombie"
connection that looks open but never delivers another message - and since undici's
`WebSocket` only exposes the plain browser surface (no ping/pong control), there's no way
to probe it directly. An idle watchdog checks every 30s and forces a reconnect if no frame
has arrived for 5 minutes, self-healing a silently-dead connection instead of leaving it
stuck indefinitely.

The callback (`handlePlexLibraryItemChange` in `server/src/scheduler.js`) fetches the
item's metadata via `fetchPlexMetadataItem` and merges it with the notification's own
state fields through `mergePlexMetadataItem` (`plexClient.js`): the notification payload
can arrive without the item's provider `Guid` collection, so the fresher metadata fetch's
identity data is kept while the notification's own live watch-state fields still win.
For an episode, `hydratePlexEpisodeMetadata` then follows Plex's native grandparent
rating key when available and copies the exact series GUID collection onto the episode
before normalization. That prevents an episode's own provider IDs from being sent in
Trakt's series slot, and avoids guessing the series from a short or ambiguous title.
The result is checked for its actual view state. A watched transition is recorded in
Plekt history and propagated to Emby/Jellyfin. An unwatched transition supersedes the
watched state in Plekt and propagates to the other eligible destinations. If a Plex
notification episode unwatch finds no matching item on any configured Emby/Jellyfin
destination, the orchestrator records that no-match result but withholds the remaining
Trakt episode unwatch until the identity/library mapping is reliable. This channel
covers library UI changes that Plex webhooks do not reliably report, including unwatching.
Plex's "Mark Unwatched" clears `viewCount` but can leave a stale `viewOffset` behind, and a
lingering offset alone cannot distinguish that from a fresh in-progress first watch. The
callback only treats a nonzero offset as a real unwatch when Plekt already had the item
recorded as watched; otherwise it is left alone, the same as any other watch in progress.
The same rule applies to an unplayed notification with no offset: Plex sends one when it
adds a new item to the library, so it is ignored unless Plekt holds a watched playstate
or a watched history row for the item (under any matching key). Either transition also bumps the
`nowPlayingRefresh` runtime-state signal (same as the webhook route), which is what tells
any open Plekt browser tab to refresh - see
[now-playing.md](now-playing.md) for how the frontend consumes that signal.

The same socket also carries a `playing` notification type, separate from `timeline`,
the instant a session starts, pauses, resumes, or stops (and periodically while it keeps
playing). It carries only a ratingKey and playback state, not full item metadata, so it
is not parsed into a session here - `onPlaySessionActivity` (wired in `scheduler.js`)
just pokes the independent live-session poller to refresh immediately instead of waiting
out its own interval. See [now-playing.md](now-playing.md) for that poller.

The listener is started by `server.js` at boot (`startPlexNotificationListener`) and
stopped during graceful shutdown. `probePlexNotificationSocket` runs the same connection
one-shot for the System Integrity Check (`POST /api/test-plex-notifications`), which
proves the full path works - including any reverse proxy's WebSocket upgrade in front of
Plex.

## Inbound channel 3: scheduler polling

`/status/sessions` (via `fetchLiveSessions`) is polled for Now Playing and
completed-session detection by the independent live-session poller
(`server/src/utils/liveSessionPoller.js`), not the once-a-minute scheduler tick - see
[now-playing.md](now-playing.md) for its adaptive interval and how the WebSocket above
pokes it. Every 15 minutes (configurable via `CATCHUP_SYNC_INTERVAL_MS`) the scheduler's
own catch-up sync separately pulls:

- **Recently watched** (`fetchPlexWatchedItems` → `syncRecentlyWatchedFromPlex`) -
  records watches that never produced a scrobble webhook. History items are filtered to
  the configured username/account ID (`plexHistoryItemMatchesConfiguredUser`).
- **Resumable items** (`fetchPlexResumableItems` → `syncRecentlyResumableFromPlex`) -
  replicates resume positions set on Plex to the other platforms.
- **Continue Watching / Up Next** (`fetchPlexContinueWatchingItems`, called by the
  resumable catch-up pass) - reads Plex's account-scoped
  `/hubs/home/continueWatching` feed, preserving the Plex rating key and account
  context. If that hub is unavailable, Plekt falls back to the existing configured
  library-section scan. The result is recorded in the provider source ledger for the
  unified dashboard queue; it does not overwrite canonical local watch state.

Every minute, **unwatched reconciliation** (`checkPlexUnwatchedStatus`) verifies items
Plekt thinks are watched are still watched on Plex, as a backstop for unwatches
missed while the WebSocket listener was disconnected. A mismatch records the unwatched
transition in Plekt and propagates it to the other eligible destinations.

## Outbound operations (`plexClient.js`)

Used by the sync orchestrator and manual watch actions:

| Function | What it does |
| --- | --- |
| `findPlexItem` | Locates a library item by provider GUID (tmdb/tvdb/imdb), falling back to title/year search; episodes resolved through the series' leaves. When the show search returns several title matches (a year-less "Scrubs" matches both "Scrubs" and "Scrubs (2026)"), it reads each candidate's Guids and takes the first that shares an id with the request, else the first title match. A candidate whose TMDB or TVDB id differs from the request's explicit show id is skipped even when it is the only match, so a show that no library holds does not resolve to a same-title show (the Jellyfin and Emby series title searches apply the same rule). `/library/all?guid=` finds nothing on the tested server, so this search is the usual path |
| `markPlexPlayed` / `markPlexUnplayed` | `/:/scrobble` and `/:/unscrobble` with the resolved account |
| `setPlexProgress` | `/:/progress` to set a resume position |
| `markPlexUnplayedByRatingKey` | Unscrobble by ratingKey (used by unwatch propagation) |
| `fetchPlexMetadataItem` | `/library/metadata/<ratingKey>` lookup (used by the WebSocket callback) |
| `hydratePlexEpisodeMetadata` | Follows an episode's native grandparent rating key and adds the exact series GUIDs needed for cross-platform matching |
| `mergePlexMetadataItem` | Merges a `fetchPlexMetadataItem` result with a notification's state override, keeping the fetch's provider `Guid` identity but the override's live state fields |
| `fetchPlexSeriesEpisodes` | All episodes of a series (season-level operations) |
| `fetchPlexWatchedItems` / `fetchPlexResumableItems` / `fetchPlexContinueWatchingItems` | History, resume, and account-scoped Continue Watching feeds for catch-up sync |
| `fetchPlexPersonalRatingSnapshot` | Reads rated movies, shows, and episodes for the isolated personal-rating snapshot worker |
| `setPlexPersonalRating` / `clearPlexPersonalRating` | Writes or clears a personal rating without changing watched state or resume progress |

The separate `plexWatchlistClient.js` exposes account-watchlist snapshot, identity
resolution, add, and remove operations to the watchlist worker. Its requests use
`X-Plex-Token` and `X-Plex-Client-Identifier` headers; the account token is never placed
in a query string. The adapter supports duplicate-safe provider identity matching and
returns an unavailable/ambiguous result instead of guessing a write target.

A `not_found` result from a mark-played call is reported as a skipped destination with
its no-match reason in sync telemetry rather than as an error. An episode miss includes
the result of the one refreshed series-index lookup.

## Artwork

Live-session posters use raw Plex thumb paths (`/library/metadata/.../thumb/...`); the
browser never loads them directly - `/api/poster` fetches them server-side with the
token as a header and caches a resized copy (see [posters-artwork.md](posters-artwork.md)
and the poster section of [now-playing.md](now-playing.md)).

## Import script

`scripts/exportPlexHistory.js` is a standalone one-shot importer that reads a Plex
server's full watch history over its API and posts it to `/api/import` in chunks of 100.
Run it with `PLEX_URL`, `PLEX_TOKEN`, and `API_KEY` env vars set.
