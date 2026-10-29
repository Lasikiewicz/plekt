# Webhooks

## Port advisory

Inside Docker, Plekt always listens on 5055; the compose files publish it on host port 5056 (changed
from 5055 on 6 October 2026). A webhook still aimed at the old host port fails silently, so Plekt
checks at startup and shows a dismissable notice on the dashboard.

- Set `PLEKT_PUBLISHED_PORT` to the host port you open Plekt on. The compose files set it to 5056.
  If it is unset, Plekt logs that the ports cannot be checked and makes no comparison.
- **Jellyfin:** Plekt reads the enabled Generic destinations of its Webhook plugin and warns when a
  destination's port differs from `PLEKT_PUBLISHED_PORT`. Tokens in the URLs are never logged or shown.
- **Emby and Plex:** advice only. Plekt cannot read their webhook settings, so check the URL by hand.
- Users still on 5055 can move their webhooks to 5056, or keep the old mapping and set
  `PLEKT_PUBLISHED_PORT` to the port they use. Plekt does not force either change.
- The notice returns until the webhook is fixed or dismissed; a dismissal is remembered per warning text.
  Status is served by `GET /api/webhook-port/status` (admin only).

## Webhook delivery test

A **Test** button beside "Plugin configured" or "Webhook configured" for Emby (Plekt plugin, built-in webhook) and
Jellyfin (Plekt plugin, Jellyfin Webhooks plugin) in Settings > Webhooks and the setup step opens a
pop-up that checks a manual played mark reaches Plekt, whichever sender is used. Plex has no button
(no webhook). The pop-up shows the steps, a live countdown,
the events Plekt receives as they arrive (polled every second) and the result, with no page refresh;
closing it cancels the test. Logic is in
`server/src/utils/webhookTest.js`, routes in `server/src/routes/webhookTest.js`
(`POST webhook-test/start|cancel|unmark`, `GET webhook-test/status|poster`; admin only, disabled in the
demo), panel in `public/modules/webhook-test.js`.

- A test lasts 5 minutes. The first played-flag event from the tested server (Emby `item.markplayed`, Jellyfin `UserDataSaved` with Played true or `ItemMarkedPlayed`) that passes the token and the
  connected-user checks is captured in `handleWebhook` and answered with 200. Capture runs after the Plekt-echo guards (native Up Next rail refresh, Jellyfin Next Up ordering nudge, outbound mark and progress echoes), so Plekt's own writes never count as the person's mark. It writes no watch
  history, queues no Manual Watch review and is never dispatched to another app or tracker.
- `GET webhook-test/poster` streams the captured item's poster from the media server (path checked, key kept server-side) for the pass screen. The hold is checked once early and again right at the capture point, so a duplicate mark-played that was already in flight when the first was captured is swallowed too.
- The captured item is held: the Emby or Jellyfin scheduled scan skips it, and a duplicate mark-played or the
  unmark echo for that item is swallowed. The hold ends 10 minutes after capture, immediately on
  "Leave it marked" (the next scan then treats it as a normal manual mark), or 60 seconds after
  "Unmark it" (which calls the Emby or Jellyfin API for that one item id).
- Only the first mark is captured, so a genuine mark made during the window becomes the test item;
  "Leave it marked" hands it to the next scan as a normal manual mark. Playback events and every
  other item pass through untouched.
- State is in memory per signed-in user (single API process); a server restart ends a test.
- On timeout the status route reads the server's most recent played items to tell "nothing was marked"
  from "the server never told Plekt". The panel combines that with what arrived (event names, rejected
  tokens) into one likely cause. Tests cover the state rules in `test/webhookTest.test.js`.

## Authentication & per-user routing

The admin's webhook endpoint is at `/api/webhook`, so existing single-user Plex, Emby, and
Jellyfin webhook configurations keep working unchanged. In a multi-user install, each
non-admin user has their own isolated webhook endpoint at `/u/<name>/api/webhook` (and
API-key integrations for that user similarly call `/u/<name>/api/*`).

Each user has their own independent `webhookSecret` (`data/config.json` for the admin,
`data/users/<name>/config.json` for a non-admin user). A valid secret for one user is
rejected on another user's webhook path. Media servers commonly use the compatibility
query-token URL:

```
POST /api/webhook?token=<webhookSecret>
POST /u/<name>/api/webhook?token=<webhookSecret>
```

Header auth is preferred for custom automation clients that can set request headers:

```
POST /api/webhook
X-Plekt-Webhook-Secret: <webhookSecret>
```

The header's older name, `X-Plembfin-Webhook-Secret`, is still accepted, so clients
configured before the rename keep working unchanged.

`Authorization: Bearer <webhookSecret>` is also accepted. Plex, Emby, and Jellyfin
setups can continue using the query-token URL above when custom headers are not
available; access logs redact sensitive query parameters before writing to disk.

`webhookSecret` is generated on first boot (or when the user is first created) and stored
in that user's `config.json`. Copy the full URL (including `/u/<name>/api/webhook` when
viewing a non-admin user, plus the token) from **Settings → Media servers → Webhooks** in
the dashboard (`getWebhookPath()` in `public/modules/auth.js`). You can rotate it
independently via the "Rotate Secret" button without affecting the password, API key, or
any other user's webhook secret.

> The `?token=` approach mirrors Sonarr/Radarr/Overseerr and remains the compatibility
> method for webhook senders such as Plex, Emby, and Jellyfin when they cannot set
> custom HTTP headers on outbound notifications.

## Normalization → phases

`handleWebhook` calls `normalizeWebhook()` (`server/src/utils/parsers.js`) to parse
Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom JSON into a unified `media`
object. The crucial output is `media.phase`, derived per platform by
`phaseFromPlexEvent` / `phaseFromEmbyEvent` / `phaseFromJellyfinEvent`:

| phase | Meaning | What `handleWebhook` does |
| --- | --- | --- |
| `active` | Currently playing (play/resume/progress) | `upsertActiveSession()` → writes `active_sessions` row (5-minute TTL by default), bumps `runtimeState.nowPlayingRefresh`. **No history insert.** |
| `completed` | Watched (scrobble, mark-played, a stop at the watched threshold, 90% by default, or an Emby/Jellyfin stop that says `PlayedToCompletion`). Percentage fields are read as 0-100; a Plex rating (`user.playrate`) is ignored | Inserts/updates a `watch_history` record + propagates *watched* to the other platforms. |
| `ended` | Stopped below the watched threshold | Deletes active session; if resume is actionable, stores/propagates resume progress to `playback_progress`. |
| `unplayed` | Marked unwatched/unplayed | Deletes the active session, records the unwatched transition as the canonical state, and propagates it to the other eligible destinations. |
| `added` | New item appeared in a library (`library.new`, `item.added`, `ItemAdded`) | Checks the current canonical state for that media. If it is watched, marks the item watched **on that server only**; writes no history. A current unwatch overrides older watch history. |
| `ignored` | Not actionable | Dropped early. |

Phase determination highlights:
- **Plex**: `media.stop` → `completed` if progress ≥ 90 else `ended`; configured
  "active" events → `active`; "complete" events → `completed`.
- **Emby/Jellyfin**: `markplayed` / `userdata saved with played=true` →
  `completed`; `markunplayed` / `played=false` → `unplayed`; `playbackstop` →
  `completed` if ≥ 90 else `ended`; progress events → `active`.

For Emby, enable **Send All Properties** on the webhook. Without the full item
payload, Plekt may receive an event without enough title/type/progress data to
record a watched item.

## Propagation (sync)

For a new watched event, `syncMediaPlaystate()` propagates to the **other two**
platforms via their clients (`plexClient.js`, `embyClient.js`, `jellyfinClient.js`).
An explicit unwatched event from a configured source changes Plekt's canonical state
and propagates unplayed to the other eligible destinations. Manual unwatches in Plekt
follow the same transition path and include the originating platform as a destination.
A later provider watched event does not undo a manual unwatch unless it is an exact
live-session playback completion whose provider timestamp and Plekt receive time are
both newer than the unwatch; generic played flags go to Manual Watch review instead (see
`docs/decisions.md` entry 31). While that review is pending, Plekt does not write the
watched state to any other provider.

**Loop detection:** when Plekt writes a state to (say) Emby, Emby fires its own
webhook back. `loopStore` (`server/src/utils/loopStore.js`) tracks
recently-dispatched events keyed by platform + media identifier in the SQLite
`loop_keys` table (a key/value store with per-row TTL, see `schema.sql`); an
incoming webhook matching a recent dispatch is detected as an echo and dropped
before it can trigger another round. Up Next native rail refreshes and other
Plekt outbound play/unplay marks are media-server and Plekt only: their echoed
webhooks are consumed before any Simkl (or other non-polling tracker) event
check, so they never spend tracker quota.

Played callbacks caused by Plekt's own outbound mark are also dropped before
the canonical-repair path, even when the item is already watched locally. This
prevents a provider acknowledgement from being sent back to every provider and
starting a reconciliation loop. A callback without a matching outbound marker
still enters the normal canonical repair path.

> `loop_keys` rows are persisted in the database, so loop detection survives a
> process restart. The check-then-claim step (`checkAndClaim`) runs the read and
> the write inside a single SQLite transaction, so a concurrent claim for the
> same key cannot slip in between the check and the write.

Each media item claims a key per provider id it carries **and** a key derived
from its title and episode coordinates. Both forms are needed because the two
directions of a round trip identify the same item differently: a record Plekt
holds no provider ids for dispatches under its title key, while the echo the
target server sends back carries that server's own imdb/tmdb/tvdb ids. Sharing
the title key is what lets the second half of that trip recognise the first.

Unwatch handling is also canonical and idempotent as a second line of defence. An
echo of an explicit Plekt unwatch finds the item already unwatched and changes
nothing. A platform-side unwatch for an item Plekt still considers watched never
deletes that local record; it dispatches a watched repair instead.

## Catching up newly added media

An outbound sync can only mark an item a server actually holds. When a watch is
recorded for media one of your servers is missing, that server is simply skipped
with "no matching item found" and the watch stays correct in Plekt.

The `added` phase closes that gap. When a server announces new content and
Plekt already holds a watched record for it, the item is marked watched on
that server as it arrives, without waiting for a Force Sync. The rules are
deliberately tight:

- Only the server that reported the addition is touched. Other platforms are not
  re-dispatched, because nothing about them changed.
- Adding a show or a season walks that container's episodes on the announcing
  server, considering only the ones it currently reports as unplayed. This runs
  ahead of the season/series branch that handles play events, which would
  otherwise read an addition as "the whole show was just watched".
- No watch history is ever written. A library scan cannot manufacture a play -
  only an already-recorded watch is applied.
- An item with no watched record, or one whose current canonical state is
  unwatched, is left alone. The current unwatch takes precedence over every
  older watched-history row.
- The server's own sync role still applies: a platform not configured to receive
  watched state is skipped.
- The outbound mark is written to the loop ledger, so the played event the server
  fires back is recognised as Plekt's own write rather than a new play.

Enable the library-add notification in each server's webhook configuration for
this to fire: **library.new** on Plex, **library.new** / **item.added** on Emby,
and **ItemAdded** on Jellyfin.

**Record identity across an unwatch:** the `unwatched` row that supersedes a
watched one inherits the replaced row's id rather than being created under a new
one. Watch records are addressed by id throughout the app, so a queued manual
match or an open edit dialog still resolves to the record after an unwatch event
rewrites it.

Results are written back as `sync_dispatch_telemetry` on the watch record and into
the `sync_history` SQLite table.

**Content type is not trusted.** `normalizeWebhook` routes multipart and form-encoded
bodies to the Plex parser, except a body with no Plex `payload` field whose `data` field
holds JSON: that is Emby's Notifications webhook set to multipart/form-data, and it goes to
the JSON parsers (before 28 October 2026 every such Emby event was dropped as "Plex Raw
Event: missing payload"). Everything else is judged by whether the body parses as
JSON - not by the declared content type. Jellyfin's webhook plugin posts valid JSON
labelled `text/plain`, so a header-based check would drop every event it sends,
including the mark-played and mark-unplayed events unwatch propagation depends on. A
body that *declares* `application/json` and is malformed is still a 400, because that is
a genuine client error rather than an unrecognised sender.

**Rejected requests:** a body that is not JSON at all is recorded in `sync_history` as
`Unsupported webhook content type` with its `contentType`, `userAgent`, and the first
300 bytes of the body in `rawPayloadDebug` - enough to identify which server sent it and
why it was refused.

## Rewatch detection

A `completed` event for an item whose `playstate` is already `watched` is not
always a duplicate: media servers can report an item as played without an actual
new play, but a real rewatch produces a `completed` event too. `handleWebhook`
(`server/src/routes/sync.js`) tells them apart by what kind of event arrived,
not by when it arrived.

Emby and Jellyfin emit a **played-flag event** (`item.markplayed`, or a
userdata-saved event carrying `Played=true`) whenever anything sets the played
flag - including Plekt's own outbound sync - and they can deliver it hours
after the fact. The parser marks these with `playedFlagOnly` on the normalized
payload. They carry no playback evidence, so:

- **A played-flag event for an item already marked watched** is dropped: no new
  `watch_history` row, no re-propagation. The calendar day it lands on is
  meaningless, because delivery time says nothing about when the play happened.
- **A played-flag event for an item not yet watched** enters Manual Watch review
  when review is required, including when Plekt currently has an explicit
  unwatched state. It is not written to watch history or propagated until the
  user confirms it. Dismissing it sends the normal unwatched correction.
- **A playback event** (`media.scrobble`, `playback.stop` past the watched
  threshold) is real evidence of a play. For an item already watched, one on a
  later UTC day is recorded as a genuine rewatch: a new `watch_history` row is
  inserted and `playstate.watched_at` advances. Pause/resume events never reach
  this check at all - they're routed through the `active`/`ended` phases above.

The same principle applies to inbound state read from library polling and from
the Plex notification listener, so a played flag Plekt itself wrote is never
read back as a new watch. See [scheduled-sync.md](scheduled-sync.md#echo-suppression).

Every watch of the same movie/episode collapses into one card everywhere the UI
lists history (`dedupeHistory` / `collapseMovieCluster` in
`server/src/utils/dataRepo.js`), carrying a `playHistory` array of
`{ id, watched_at, source }` for each individual play - this is what powers the
"Watch History" list and rewatch counts described in [media-detail.md](media-detail.md).

## Resume / playback progress

On `ended` (and via the scheduled poller), if resume is actionable
(`shouldSyncResumeProgress`), a record goes into `playback_progress` keyed by
`media_key`, and `syncMediaProgress()` pushes the resume position to the other
platforms. When position and duration are available, Plekt derives the percentage
from those timing fields instead of trusting a conflicting percentage supplied by the
webhook. This keeps stop-phase classification, stored progress, and the dashboard in
agreement with the resume position written to each media server.

Emby and Jellyfin include `Played: false` in ordinary positive resume-position
`UserData` writes. Plekt classifies that combination as partial playback (`ended`),
not as an explicit unwatch; named mark-unplayed events and zero-position unwatch writes
remain authoritative. A repeated server acknowledgement of the same position retains
the newer stored progress timestamp even when the server returns an older
`LastPlayedDate`, while a later explicit unwatch still clears it. Generic item metadata
dates such as `DateCreated` and `DateLastSaved` are not treated as playback authority.

## Plex specifics worth remembering

- Native Plex webhooks only fire on **state changes** (play/pause/resume/stop/
  scrobble) - there is **no heartbeat**. So a single `media.play` creates an
  `active_sessions` row that **expires after the active-session TTL (5 minutes by
  default)** unless another event
  arrives. Continuous "still playing" tracking for Plex comes from the
  elected scheduler worker (→ `live_tracking_cache`), not from native webhooks.
- Plex does **not** send unwatched (unscrobble) events. Plekt compensates via
  the built-in Plex WebSocket notification listener, which connects automatically
  using the configured Plex URL and token. Bulk show and season state changes are
  expanded into their affected episodes before propagation.
- The setup help in each card under Settings → Media servers documents per-server webhook configuration.
