# Emby Integration

How Plekt talks to Emby: webhooks in, API calls out, plus scheduled catch-up
polling. Read [architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/embyClient.js` | Outbound HTTP client - all Emby API calls |
| `server/src/utils/parsers.js` | `parseEmbyWebhook` - webhook normalization |
| `server/src/utils/recentWatchImport.js` | `syncRecentlyWatchedFromEmby` - catch-up watched import |
| `server/src/scheduled.js` | `syncRecentlyResumableFromEmby`, `syncRecentlyNextUpFromEmby` - catch-up polling |
| `server/src/utils/liveSessions.js` | Polls `/Sessions` for Now Playing |
| `public/modules/help-content.js` | `embyCredentialGuide()`, `embyWebhookSetup()` - in-app setup guides |

## Emby plugin

The Plekt Emby server plugin (`Emby.Plugin.Plekt.dll`) is available as a public beta in
[its own repository](https://github.com/Lasikiewicz/emby-plugin-plekt), starting with
[v0.1.0.1](https://github.com/Lasikiewicz/emby-plugin-plekt/releases/tag/v0.1.0.1).
It needs no Emby Premiere subscription or built-in webhook. It is built against SDK 4.9.1.90
and runtime-tested on Emby Server 4.10.1.0; other server versions are unverified.

1. Download `Emby.Plugin.Plekt.dll` from [Releases](https://github.com/Lasikiewicz/emby-plugin-plekt/releases).
2. Copy it into Emby's `plugins` folder (`/config/plugins` inside the linuxserver.io Docker
   container; otherwise the plugins folder in Emby's program data directory), then restart Emby Server.
3. Open **Settings → Plugins → Plekt**, paste the complete webhook address from
   **Plekt → Settings → Media Servers → Webhooks**, including its token, and save.
4. In Docker, use Plekt's reachable LAN address or hostname, not `localhost` or `127.0.0.1`.
5. Disable any built-in Emby webhook posting to the same Plekt server to avoid duplicate events.

Each release includes a SHA-256 file for download verification. The plugin is not in Emby's
plugin catalog, so installation and updates are manual. To update, replace the DLL and restart
Emby Server. Settings survive a restart or reinstall. To uninstall, remove the plugin through
Emby's plugin settings or delete the DLL, then restart Emby Server.

The plugin sends start, pause, unpause and stop, progress at most every 30 seconds per playback
session/item/user, and explicit played/unplayed changes. Delivery is ordered and best effort,
with a five-second timeout, no retry and at most 100 pending events. Plekt's scheduled sync
catches up missed activity. Delivery failure logs exclude the webhook address and token.

The built-in Emby webhook remains a supported alternative requiring no Plekt plugin (see
[Inbound: webhooks](#inbound-webhooks)).

## Configuration

Settings → Media Servers → Emby uses account setup by default. Plekt sends the server
URL, username, and password directly to that Emby server, verifies the returned user, and
stores only the encrypted user-scoped token. The password is never persisted.

Manual setup remains optional; its values are stored in the `settings` SQLite row and env
vars `EMBY_SERVER_URL` / `EMBY_API_KEY` / `EMBY_USER_ID` act as defaults:

- **baseUrl** - reachable *from the Plekt server machine*
- **apiKey** - an Emby API key (Dashboard → Advanced → API Keys)
- **userId** - the Emby user whose watch state is tracked and written

All three are required when Emby is enabled in manual mode (`validateConfig`). Only one
mode is active: completing account setup removes the stored manual key, while saving
manual setup switches Emby back to manual mode. Requests authenticate with the
`X-Emby-Token` header.

## Watchlist note

Emby is not a Personal Watchlist Sync provider. Emby has no native account-level
watchlist contract; its playlist and Favorites equivalents are library-bound and cannot
represent titles the user does not own. Plekt therefore keeps the personal watchlist
projection on Plex, whose account Universal Watchlist can hold the full catalogue. Emby's
watched-state and personal-rating integrations remain independent of that feature; see
[personal-watchlist.md](personal-watchlist.md) for the supported watchlist flow.

## Inbound: webhooks

Use the [Plekt Emby plugin](#emby-plugin) or the built-in Emby webhook
(Settings → Notifications → Webhooks, events playback start/pause/unpause/stop, mark played
and mark unplayed). Both post JSON to
`/api/webhook?token=<webhookSecret>`; do not run both against the same Plekt server. The
in-app guide (`embyWebhookSetup()` in `help-content.js`) documents both senders and links to
the public plugin releases.

**Enable "Send All
Properties" on the built-in Emby webhook** - without the full item payload, events can arrive
without enough title/type/progress data to record a watch.

`parseEmbyWebhook` (`parsers.js`) derives the phase:

- `playback.start` / `playback.unpause` / `playback.progress` / `playback.pause` → `active`
- `item.markplayed`, or a userdata-saved event with `Played=true` → `completed`
- `item.markunplayed`, or `Played=false` → `unplayed`
- `playback.stop` → `completed` at the watched threshold (90% by default), else `ended`

`item.markplayed` and userdata-saved events are also tagged `playedFlagOnly`, because
Emby fires them whenever anything sets the played flag - including Plekt's own
outbound sync - and can deliver them hours late. They are dated from the item's
`LastPlayedDate` rather than arrival time, and never record a rewatch for an item
already marked watched. See [webhooks.md](webhooks.md#rewatch-detection).

Unlike Plex, Emby **does** send mark-unplayed events, so unwatch propagation works
purely through the webhook - no extra listener is needed.

To check that a manual mark reaches Plekt, use the Test button next to "Plugin configured" or "Webhook configured" in Settings > Webhooks
(see [webhooks.md](webhooks.md#webhook-delivery-test)). It works with either sender. Jellyfin has the same test.

## Inbound: scheduler polling

The independent live-session poller calls `/Sessions` every 10 seconds while active,
5 minutes while idle, or 30 seconds after a failed poll. Set up the plugin or playback
webhooks for prompt detection; idle polling is a fallback for missed activity, whether
or not a plugin/webhook is configured. The dashboard refreshes its
cached view every 10 seconds. Plugins and playback webhooks can report activity sooner;
polling remains enabled to recover missed events and reconcile session state. See
[Now Playing](now-playing.md). The separate catch-up sync
(every 15 minutes by default) pulls:

- **Recently watched** - `fetchEmbyWatchedItems` (user's items filtered to
  `IsPlayed`, ordered by play date) → `syncRecentlyWatchedFromEmby` records watches
  whose webhooks were missed. Full-history reads (initial import, Force Sync, restore
  clears) fetch this feed in pages of 500 with `EnableImages=false`, so a large history
  never depends on one response finishing inside the outbound timeout and Emby skips
  image-enhancer plugins for these items.
- **Resumable items** - `fetchEmbyResumableItems` (`/Users/<id>/Items/Resume`) →
  `syncRecentlyResumableFromEmby` replicates resume positions to the other platforms.
  The query asks for `Fields=UserDataLastPlayedDate`: Emby 4.9 otherwise omits the last-played
  time, and without it an older explicit unwatch outranks the part-watch (decision 35).
  Episode rows include series provider IDs so cross-server lookup can resolve the
  series before selecting the matching season and episode.
- **Next Up** - `fetchEmbyNextUpItems` (`/Shows/NextUp`, scoped to the configured user)
  records released episode observations for the unified dashboard queue. Resume and
  Next Up responses are generation-based source snapshots: a failed or partial response
  keeps the last successful generation instead of clearing the queue, and the source
  ledger is never treated as canonical watched state.

**Enabled by default** - set `EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED=false` to disable it. Every
5 minutes (`EMBY_UNWATCHED_POLL_INTERVAL_MS`), **unwatched reconciliation**
(`checkEmbyUnwatchedStatus`) re-checks up to 5 items Plekt thinks are watched via Emby
against Emby's current played flag. Emby's webhook natively reports `Mark Unplayed`, so
this is a backstop for a missed or misconfigured webhook, not the primary detection path -
mirrors `checkPlexUnwatchedStatus` in [plex.md](plex.md), but Plex needs that poll as its
*only* unwatch signal since its webhook can't report unwatch at all, and its per-item
lookup is a single cheap call, so it stays enabled by default at a one-minute cadence over
a larger batch. Emby runs available provider-ID searches concurrently and keeps a
connection/user-scoped ten-minute identity index for resolved series and episode
coordinates. Concurrent sibling episodes join one in-flight resolution and reuse one
episode-list fetch; operations that inspect watched state still fetch fresh `UserData`.
Confirmed empty discovery is cached only briefly, while transport failures remain retryable.

Playback positions use Emby's tick units (1 tick = 100 ns); `scheduled.js` converts
with `ticksToMilliseconds`.

### Items flagged played without a play date

Marking an item watched over the Emby API - which is exactly what outbound playstate sync
does - sets `UserData.Played` to `true` but leaves `PlayCount` at `0` and writes no
`LastPlayedDate`. Emby returns those items in the recently-watched list, so a propagated
watch comes back on the next catch-up poll looking like a watch with missing metadata.

`watchedAtForEmbyLikeItem` never invents a timestamp for a dateless item, because doing so
would turn an existing library into a burst of new watch rows after a restore or first
connection. It separates the two cases:

- **`Played: true` with an explicit `PlayCount: 0`** - marked over the API, nothing to
  ingest. Ignored silently; counted only when `LOG_VERBOSE` is set.
- **`Played: true` with a real play count but no date** - a genuine data gap. Reported as
  one aggregated line naming the affected titles.

An install whose Emby library was populated entirely by outbound sync will therefore have
every played item fall into the first case, and the recently-watched poll will record
nothing from Emby. That is expected: those watches are already in history under the source
platform that reported them.

## Outbound operations (`embyClient.js`)

| Function | What it does |
| --- | --- |
| `findEmbyItems` | Locates library items by provider ID (`AnyProviderIdEquals` with `imdb.` / `tmdb.` / `tvdb.` terms), falling back to title/year search; episodes resolved through the series. An exact episode miss during a mutation refreshes the cached series index once before returning a skip. A title search that matches two items with different ids or years (two shows or films of the same name, such as "Scrubs" 2001 and 2026) finds nothing rather than both ([decision 40](decisions.md)) |
| `markEmbyPlayed` / `markEmbyUnplayed` | `POST` / `DELETE` on `/Users/<userId>/PlayedItems/<itemId>` |
| `setEmbyProgress` | Writes a resume position via the item's UserData, retaining the source progress date so Emby's Continue Watching feed can order and include it |
| `markEmbyUnplayedById` | Unplay by item ID (used by unwatch propagation) |
| `fetchEmbySeriesEpisodes` / `fetchEmbyEpisodes` | Episode lists for season-level operations |
| `fetchEmbyWatchedItems` / `fetchEmbyResumableItems` / `fetchEmbyNextUpItems` | Watched, resume, and Next Up feeds for catch-up sync |
| `fetchEmbyPersonalRatingSnapshot` | Reads rated movies, series, and episodes for the isolated personal-rating snapshot worker |
| `setEmbyPersonalRating` / `clearEmbyPersonalRating` | Writes or clears a personal rating without changing played state or resume progress. **Known defect:** Emby 4.9.5.0 returns 204 but does not store the numeric `Rating`, so writes report success without effect and the snapshot reads no ratings (see `plan/active/personal-rating-sync/step4-emby-readback.md`) |

## Artwork

Emby poster URLs are built from `/Items/<id>/Images/Primary` with the image tag
(`embyLikePosterUrl` in `liveSessions.js`, `configuredImageUrl` in
`public/modules/images.js`). The server-side poster pipeline caches a resized local
copy - see [posters-artwork.md](posters-artwork.md).
