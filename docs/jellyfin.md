# Jellyfin Integration

How Plekt talks to Jellyfin: webhooks in, API calls out, plus scheduled catch-up
polling. Jellyfin's integration is structurally the same as Emby's (Jellyfin is an Emby
fork and keeps most of the API surface) with a few differences noted below. Read
[architecture.md](architecture.md) first for the big picture.

## Files

| File | Role |
| --- | --- |
| `server/src/utils/jellyfinClient.js` | Outbound HTTP client - all Jellyfin API calls |
| `server/src/utils/parsers.js` | `parseJellyfinWebhook` - webhook normalization |
| `server/src/utils/recentWatchImport.js` | `syncRecentlyWatchedFromJellyfin` - catch-up watched import |
| `server/src/scheduled.js` | `syncRecentlyResumableFromJellyfin`, `syncRecentlyNextUpFromJellyfin` - catch-up polling |
| `server/src/utils/liveSessions.js` | Polls `/Sessions` for Now Playing |
| `public/modules/help-content.js` | `jellyfinCredentialGuide()`, `jellyfinWebhookSetup()` - in-app setup guides |

## Related project: Jellyfin plugin

The Plekt Jellyfin server plugin lives in its own repository at
`C:\Github\jellyfin-plugin-plekt` (GPL-3.0-or-later). It posts playback and explicit
watched or unwatched events straight to Plekt's webhook address, so it does not use the
Jellyfin Webhook plugin. All work on the plugin is done from the plekt project; its files are
outside this repo and are not covered by the checks here. See the plugin README for build and
configuration details.

## Configuration

Settings → Media Servers → Jellyfin uses Quick Connect by default: enter the server URL,
start the flow, and approve the displayed code from a signed-in Jellyfin client. A direct
username/password exchange is available when Quick Connect is disabled. Both flows verify
the user and store only the encrypted user-scoped token; passwords are never persisted.

Manual setup remains optional; its values are stored in the `settings` SQLite row and env
vars `JELLYFIN_SERVER_URL` / `JELLYFIN_API_KEY` / `JELLYFIN_USER_ID` act as defaults:

- **baseUrl** - reachable *from the Plekt server machine*
- **apiKey** - a Jellyfin API key (Dashboard → API Keys)
- **userId** - the Jellyfin user whose watch state is tracked and written

All three are required when Jellyfin is enabled in manual mode (`validateConfig`). Only
one mode is active: completing account setup removes the stored manual key, while saving
manual setup switches Jellyfin back to manual mode. Existing manual API keys and
account/Quick Connect access tokens are both retained and sent through Jellyfin's
modern `Authorization: MediaBrowser ... Token="..."` header. Browser-facing artwork
URLs use Jellyfin's supported `ApiKey=` query parameter because they cannot attach the
header; server-side requests do not send both authentication forms.

## Watchlist note

Jellyfin is not a Personal Watchlist Sync provider. Jellyfin has no native account-level
watchlist contract; playlists and Favorites are library-bound and cannot represent titles
the user does not own. Plekt therefore keeps the personal watchlist projection on Plex,
whose account Universal Watchlist can hold the full catalogue. Jellyfin's watched-state
and personal-rating integrations remain independent of that feature; see
[personal-watchlist.md](personal-watchlist.md) for the supported watchlist flow.

## Inbound: webhooks

The recommended sender is the **Plekt Jellyfin plugin** (see
[Related project](#related-project-jellyfin-plugin)); it posts JSON to the complete webhook
address from Plekt's Settings → Media Servers → Webhooks. The Jellyfin **Webhook plugin** still
works as an alternative and posts JSON to the same `/api/webhook?token=<webhookSecret>`.
`parseJellyfinWebhook` (`parsers.js`) derives the phase:

- `PlaybackStart` / `PlaybackProgress` / `PlaybackPause` → `active`
- Mark-played events, or userdata saved with `Played=true` → `completed`
- Mark-unplayed events, or `Played=false` at position 0 → `unplayed`
- `Played=false` with a positive position → `ended` (partial playback)
- `Played=false` at position 0 saved by playback itself (`SaveReason` `PlaybackStart`,
  `PlaybackProgress`, `PlaybackFinished`) → ignored; Jellyfin writes it when a play starts, and
  treating it as an unwatch blocked that play's resume position
- `PlaybackStop` → `completed` at the watched threshold (90% by default), else `ended`

Jellyfin sends mark-unplayed events, so unwatch propagation works purely through the
webhook. The in-app guide (`jellyfinWebhookSetup()` in `help-content.js`) has two boxes: the
expanded **Official Plekt Jellyfin Plugin (Recommended)** box, with the repository name and
manifest URL in copy blocks and the webhook address in its last step, and a collapsed
**Jellyfin Webhooks** box, which holds the webhook address and the Webhook plugin's notification
types.

## Inbound: scheduler polling

Every minute `fetchLiveSessions` polls `/Sessions` for Now Playing. The catch-up sync
(every 15 minutes by default) pulls:

- **Recently watched** - `fetchJellyfinWatchedItems` → `syncRecentlyWatchedFromJellyfin`
  records watches whose webhooks were missed. Full-history reads fetch this feed in pages
  of 500 with `EnableImages=false`, so a large history never depends on one response
  finishing inside the outbound timeout.
- **Resumable items** - `fetchJellyfinResumableItems` (`/Users/<id>/Items/Resume`) →
  `syncRecentlyResumableFromJellyfin` replicates resume positions. Episode rows include
  series provider IDs so cross-server lookup can resolve the series before selecting
  the matching season and episode.
- **Next Up** - `fetchJellyfinNextUpItems` (`/Shows/NextUp`, scoped to the configured user)
  records released episode observations for the unified dashboard queue. Jellyfin native
  IDs are retained, so equivalent entries from multiple Jellyfin libraries can fan out
  mutations safely. Feed generations are activated only after a complete response;
  failures preserve the last good source snapshot and never change canonical watch state.

**Enabled by default** - set `EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED=false` to disable it. Every
5 minutes (`JELLYFIN_UNWATCHED_POLL_INTERVAL_MS`), **unwatched
reconciliation** (`checkJellyfinUnwatchedStatus`) re-checks up to 5 items Plekt thinks
are watched via Jellyfin against Jellyfin's current played flag. Jellyfin's webhook
natively reports unwatch via `User Data Saved`, so this is a backstop for a missed or
misconfigured webhook, not the primary detection path - mirrors `checkPlexUnwatchedStatus`
in [plex.md](plex.md), but Plex needs that poll as its *only* unwatch signal since its
webhook can't report unwatch at all, and its per-item lookup is a single cheap call, so it
stays enabled by default at a one-minute cadence over a larger batch. Jellyfin runs
available provider-ID searches concurrently and keeps a connection/user-scoped ten-minute
identity index for resolved series and episode coordinates. Concurrent sibling episodes
join one in-flight resolution and reuse one episode-list fetch; operations that inspect
watched state still fetch fresh `UserData`. Confirmed empty discovery is cached only
briefly, while transport failures remain retryable.

Playback positions use tick units (1 tick = 100 ns), converted in `scheduled.js`.

## Outbound operations (`jellyfinClient.js`)

| Function | What it does |
| --- | --- |
| `findJellyfinItems` | Locates library items by provider ID (`AnyProviderIdEquals`), falling back to title/year search; episodes resolved through the series. An exact episode miss during a mutation refreshes the cached series index once before returning a skip. A title search that matches two items with different ids or years (two shows or films of the same name, such as "Scrubs" 2001 and 2026) finds nothing rather than both ([decision 40](decisions.md)) |
| `markJellyfinPlayed` / `markJellyfinUnplayed` | `POST` / `DELETE` on `/Users/<userId>/PlayedItems/<itemId>` |
| `setJellyfinProgress` | Writes a resume position via the item's UserData |
| `updateJellyfinUserData` | Merges selected UserData fields, used to order a verified Next Up series without resetting play count or progress |
| `markJellyfinUnplayedById` | Unplay by item ID (used by unwatch propagation) |
| `fetchJellyfinSeriesEpisodes` / `fetchJellyfinEpisodes` | Episode lists for season-level operations |
| `fetchJellyfinEpisodesForSeries` | A series' episodes for identity resolution and season operations: uses the item-tree query when it returns episode rows, otherwise `/Shows/<seriesId>/Episodes` (some Jellyfin-compatible libraries return only Season containers from the item tree) |
| `fetchJellyfinWatchedItems` / `fetchJellyfinResumableItems` / `fetchJellyfinNextUpItems` | Watched, resume, and Next Up feeds for catch-up sync |
| `fetchJellyfinPersonalRatingSnapshot` | Reads rated movies, series, and episodes for the isolated personal-rating snapshot worker |
| `setJellyfinPersonalRating` / `clearJellyfinPersonalRating` | Writes or clears a personal rating without changing played state or resume progress. A clear sends `Rating: 0`: Jellyfin (verified on 12.0.0) ignores `Rating: null` in this partial update |

## Artwork

Jellyfin poster URLs use the same `/Items/<id>/Images/Primary` shape as Emby
(`embyLikePosterUrl` in `liveSessions.js`). The server-side poster pipeline caches a
resized local copy - see [posters-artwork.md](posters-artwork.md).
