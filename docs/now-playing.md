# Now Playing

The dashboard's "Now Playing" row is backed by the current live-session and scheduler
data described below.

## What feeds it

`handleNowPlaying` (`server/src/routes/sync.js`) merges **two** SQLite sources:

1. **`live_tracking_cache`** - written by an independent live-session poller
   (`server/src/utils/liveSessionPoller.js`, using `refreshLiveSessions()` in
   `server/src/scheduled.js`), which polls Plex/Emby/Jellyfin directly and
   snapshots whatever is currently playing. Only rows with `completed_at IS NULL`
   are returned.
2. **`active_sessions`** - written by the **webhook** `active` phase
   (`upsertActiveSession`). These have a configurable TTL (**5 minutes by default**):
   `listActiveSessions` deletes any row whose `updated_at` is older than the active
   session TTL before returning.

The merge de-duplicates by `(source, title, season, episode)` and sorts by
`updated_at` desc. A session can reach Now Playing via the poller, via a
webhook, or both.

The Emby Continue Watching rail is refreshed by a zero-position playback-session
touch after Plekt marks the watched predecessor. Those callbacks carry the
reserved `plembfin-up-next-seed` device id and are rejected before they can create
an `active_sessions` row; the touch does not write resume progress or increment a
play count. Rows written by older alpha builds are removed when
`listActiveSessions()` projects the response, and matching cached poll rows are
excluded from Now Playing as well.

### Live-session poller cadence

`live_tracking_cache` used to be refreshed only once a minute, inside the same
scheduler tick as backups, TMDB prewarm, and catch-up sync - a session starting
or ending could take up to 60s to show up or clear. `liveSessionPoller.js` now
runs on its own timer instead, independent of that tick, and is
activity-adaptive: it polls every 10s while a session is currently playing, and
backs off to 45s while idle (close to the old baseline, so idle-state load on
Plex/Emby/Jellyfin does not meaningfully increase). The once-a-minute scheduler
tick no longer calls the same fetch itself - that would just poll the same
session endpoints a second time for no benefit - it only reads the cache the
poller already keeps current.

Two things poke the poller to run immediately instead of waiting out its
current interval:

- Plex's notification WebSocket (`server/src/utils/plexNotificationListener.js`,
  see [plex.md](plex.md)) also carries a `playing` frame the instant a Plex
  session starts, pauses, resumes, or stops. That frame carries no more than a
  ratingKey and playback state - not enough to build a session row from - so it
  is used purely as a "something changed, refresh now" signal rather than being
  parsed into session data itself.
- `handleNowPlaying` pokes the poller whenever a request arrives more than 20s
  after the last one - i.e. a browser tab was just opened or just became
  visible again - so the first view after a gap doesn't wait out the poller's
  own idle interval. The response itself is never delayed by this: it always
  serves whatever is already cached, and the poke's fresher data lands in time
  for the next 10s frontend poll.
- Emby and Jellyfin have no equivalent push channel wired up today, so their
  Now Playing freshness is bounded by the poller's own interval alone.

### Not mistaking a poll blip for a real stop

`refreshLiveSessions()` (`server/src/scheduled.js`) reconciles the previous
`live_tracking_cache` rows against whatever the latest poll returned; anything
previously tracked that isn't in the new result is treated as stopped, and
either recorded as a completed watch (progress past the watched threshold) or
a resume/progress update (below it). Two safeguards keep a poll problem from
being misread as the session actually stopping:

- **A failed fetch to a platform is not treated as "nothing is playing" on
  it.** `fetchLiveSessions()` (`server/src/utils/liveSessions.js`) reports
  which of Plex/Emby/Jellyfin it could not reach this call; a cached row from
  a platform that just failed is left untouched and re-checked next poll,
  instead of every session on that platform looking like it stopped because
  of one bad request.
- **A session has to be missing across two consecutive successful polls of
  its platform before it's treated as stopped**, not just one
  (`MISSING_LIVE_SESSION_CONFIRMATION_POLLS`). This absorbs a Plex session-key
  change - e.g. a transcode/quality switch assigns the still-playing item a
  new session id - without needing to fix the id matching itself. The poller
  stays on its fast interval while a confirmation like this is pending, so the
  worst-case delay before a genuine stop is recorded is about two poll
  intervals, not one poller cycle plus a fall back to the slow idle interval.

- **A stale or paused cached row is never promoted to a completed watch.** A
  missing row whose last provider snapshot is older than five minutes is
  discarded as historical cache data, and a high-progress row last seen paused
  is discarded rather than treated as playback completion. This intentionally
  prefers a missed watch over a phantom watch after a restart or poller outage.

Without these, the symptom looks like: Now Playing (or a title's resume
position) drops to "partially watched" even though playback never stopped -
one bad request or one session-id change was enough to make the reconciliation
think it had.

```text
Plex/Emby/Jellyfin
   |  (adaptive poll: 10s active / 45s idle)   (webhook "active" events)
   v                                                  |
liveSessionPoller.js -> live_tracking_cache   active_sessions <- handleWebhook (phase=active)
        ^                       |                     |
        |                       `-- handleNowPlaying merges both --'
   poke() from Plex "playing"                   |
   WebSocket frame, or a                  GET /api/now-playing
   Now Playing viewer                            |
   showing up after a gap              app.js loadActiveSessions() (polled every 10s)
```

## Frontend (polling)

- `startHistoryPolling()` (`public/modules/sync.js`) starts a `setInterval` that
  calls `loadActiveSessions()` every `NOW_PLAYING_POLL_MS` (10s).
  `stopHistoryPolling()` clears it.
- `loadActiveSessions()` does a plain `fetch` of `/api/now-playing`, parses the
  JSON array, then calls `setActiveSessions()` -> `renderActiveSessions()`.
- **Visibility gating**: polling runs on every view, not just the dashboard, so a
  watched/unwatched change is picked up no matter what page is open; it only stops
  on `visibilitychange` (`pollNowPlayingOnce()` bails + clears the interval whenever
  `document.hidden`) or when signed out. `handleNowPlaying` is a cheap local
  SQLite read (no outbound calls to Plex/Emby/Jellyfin), so polling continuously
  across views has negligible cost.
- Mobile resume boundaries also include `pageshow` and `focus`. They force a fresh
  `/api/now-playing` request and invalidate any request that was suspended while the
  page was backgrounded, so a restored phone tab cannot stay on its old in-memory
  Now Playing snapshot.
- The `X-Now-Playing-Refresh` response header signals that watch history changed -
  a webhook fired, or the Plex notification listener (`handlePlexLibraryItemChange`
  in `server/src/scheduler.js`, see [plex.md](plex.md)) detected a watched/unwatched
  change. When it changes, `loadActiveSessions` triggers `loadHistory()` and, if
  the user is currently on the Explorer or History view, also clears derived UI
  caches and re-renders that view so the change shows up immediately.

## Posters

A live session's `posterUrl` is the **raw media-server thumb path** (e.g. Plex
`/library/metadata/.../thumb/...`), not a cached image. A browser on the public
`https://` site can't load that directly: the media server is usually `http://`
on the LAN (mixed-content blocked, and the LAN address isn't reachable remotely).
So the now-playing card renders a `poster-fallback` span and hydrates it through
`/api/poster?id=<media_key>`, the same server-side fetch-and-cache pipeline that
backs history posters (artwork lands in `/media/posters/*.webp`).

`handlePoster` resolves the `id` in this order: watch record -> `media_key` ->
`playback_progress` -> **live session**. The live-session step
(`findLiveSessionPosterRow`) matches the `media_key` against `live_tracking_cache`
and `active_sessions`, then synthesizes a row carrying the thumb path as
`poster_url`. Without it, a currently-playing item that has never been watched
exists in none of the watch tables, so `/api/poster` returns **404** and the
poster never loads. The cache is keyed by `media_key`, so once the episode becomes
a real watch record it reuses the same cached artwork.

## Transport contract

`GET /api/now-playing` returns a JSON array. The client calls it every 10 seconds while
the document is visible and the user is authenticated. The endpoint does not use an
SSE stream; it reads the local SQLite sources described above and performs no outbound
media-server requests.

## Diagnosing "Now Playing is wrong"

Work outside-in:

1. **Is the data in the database?** Run:
   ```sh
   # Use data/plembfin.db instead if this install already has that database.
   sqlite3 data/plekt.db "SELECT title, source_platform, last_progress, completed_at FROM live_tracking_cache ORDER BY updated_at DESC LIMIT 10;"
   ```
   With media playing you should see rows with `completed_at` = NULL.
   - If empty/stale -> the live-session poller isn't reaching the servers. Check the
     server logs for "Live session poller failed" or "Live session fetch failed".
     Confirm the Plex/Emby/Jellyfin URLs in Settings are reachable from the Plekt
     server.
   - If all rows have `completed_at != NULL` -> they were marked complete after
     reaching the watched threshold (90% by default) and disappearing, so they
     won't show. Expected.

2. **Does the API return it?** DevTools -> Network -> filter `now-playing`. You should
   see repeating requests every 10s returning a JSON array. If the array has
   sessions but the grid is empty, check `renderActiveSessions()` /
   `setActiveSessions()`.

3. **Auth?** A `401` means the session cookie or API key isn't being sent. Check
   that you're signed in and the `plembfin_session` cookie is present.
