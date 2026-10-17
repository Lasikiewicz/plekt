# Scheduled Sync

The elected background worker runs `runScheduledTick()` **every minute**, timed from the start
of each tick so the cadence holds regardless of how long a tick takes; a tick that overruns a
full minute skips the periods it consumed rather than running back to back. In the
default `ROLE=all` deployment this is the same server process as the UI. A SQLite
lease ensures only one `all` or `worker` process runs scheduler work and the Plex
notification listener. The lease is renewed every 10 seconds and expires after 60.
The existing per-process overlap guard remains in place.

Before applying the restore admission gate, the worker recovers an operation whose
heartbeat is more than three minutes old. Recovery rechecks the owner and heartbeat
inside the SQLite transaction, so a replacement operation or renewed heartbeat stays
protected. An interrupted restore therefore cannot leave live playback tracking and
scheduled history recording paused indefinitely.

The lease prevents concurrent scheduler ownership. A process crash during an
already-issued media-server API call cannot make that remote call exactly-once;
Plekt's persisted loop detection and idempotent watched/unwatched writes provide
recovery protection.

The same logic runs on demand via:
- `GET /api/cron-sync/status` - returns the last cron trigger/result as JSON for
  automation that needs a reliable success/failure signal after a streamed run.
- `POST /api/cron-sync` - `handleCronSync` (streams a text log back, auth by API key
  or session cookie).
- `POST /api/force-sync` - queues durable worker work for the dashboard to poll;
  `POST /api/stop-force-sync` cancels queued or running work.
- `POST /api/force-sync/media` - an authenticated, title-scoped detail-page action.
  Its `mode` is `full`, `push`, or `pull`; `push_to` and `pull_from` optionally
  select one of Plex, Emby, or Jellyfin. The response returns an operation id,
  and `GET /api/force-sync/media/status?id=...` exposes live log lines and the
  final result for the popup terminal.
- `GET /api/rating-sync/status` - reports the independent personal-rating queue,
  connected providers, and per-provider snapshot runs.
- `POST /api/rating-sync/run`, `/api/rating-sync/push`, and
  `/api/rating-sync/retry` - run a rating snapshot, explicitly push local ratings,
  or retry failed/not-found/reauthorization-required rating work.

Manual cron and force-sync requests are stored in `background_jobs`; their ordered
logs live in `background_job_logs`. The web process relays logs while the leaseholder
executes the job, so disconnecting a browser does not stop it.

## Event-triggered Up Next provider sync

The unified Up Next projection is also reconciled automatically when a queue input
changes: canonical watch/resume progress, a changed provider feed snapshot, a server-side
dismissal/restore, or a changed cached projection. The worker queues one singleton
`up_next_sync` job for a burst of changes, builds the latest mixed movie-and-episode
projection (up to 100 items) when it runs, and pushes it through the configured native
provider rails. The push only adds to those rails; an entry the app lists that the
projection lacks is left in place, never hidden (`docs/decisions.md` entry 36). The
dashboard does not need to be open. If another change lands during
the push, one follow-up job is queued after it finishes; the push's own feed reads are
excluded from this trigger so it cannot loop on itself.

This event-triggered push is disabled when **Up Next sync** is disabled in configuration.
The scheduled provider-feed catch-up remains the 15-minute backstop described below,
so an external provider change is still discovered even when no local queue mutation
has occurred.

Force Sync also supports an opt-in read-only preview. `POST /api/force-sync/plan` queues
the preview and returns a job id. Once the job result contains a `planId`,
`GET /api/force-sync/plan/:id` returns the summary and paged action details, while
`POST /api/force-sync/plan/:id` confirms a draft. Plans expire after 15 minutes and a
plan over its configured maximum-change limit cannot be confirmed. A preview with
an incomplete server scan is also blocked: an unavailable server is never treated
as an empty library and cannot become a write target. The normal and preview-backed
paths share the same operation lock, role-aware destination filtering, and
restart-safe cancellation behavior.

After confirmation, `POST /api/force-sync` with `{ "planId": "..." }` rechecks the
server fingerprints and configuration revision. Any drift expires the plan before writes.
Destructive plans create and checksum-verify a local Plekt watch-history snapshot first;
snapshot failure blocks execution. This snapshot covers Plekt watch history, playstate,
and resume progress, not the databases owned by Plex, Emby, or Jellyfin.

Confirmed-plan results count only applied actions as completed. Missing provider items
have a separate count and a persisted title/target list. Mixed results read, for example,
**Partially applied: 12 of 14 actions applied; 2 not found on Emby**, followed by the
missing titles. Plans with unresolved actions finish `partial` when some applied, or
`failed` when none applied; `success` is false and the background job is unsuccessful.
An exception after a recovery snapshot also finishes failed. Cancellation stays cancelled.

Force Sync is a canonical replay from Plekt history. It never imports a watched item
that exists only on a connected server, and it never writes to a server whose watched
library scan failed. Source-only and monitor-only sync roles are scanned for information
but are excluded from outbound writes. Force Sync, Full Sync Watchstates, backup restore,
and rebuild operations use one owner-scoped SQLite operation marker, so they cannot run
concurrently. Inbound callbacks received during an authoritative operation are suppressed
as echoes; scheduled-sync callbacks remain eligible for normal echo-ledger checks. Delayed
unplayed callbacks are additionally matched against a 14-day outbound unmark ledger.

The detail-page endpoint is deliberately separate from that library-wide policy. It is a
user-requested repair for one title, with two independent, explicit operations: Import
Watched Status (pull) queries configured servers for that title and imports any watched
movie or episode found there into Plekt - the import only, nothing is sent back out and
nothing is removed. Set Plekt as Source of Truth (push) replays Plekt's existing
canonical state to the selected destination(s) without checking their current state first.
It does not change the behavior or safety guarantees of the library-wide `/api/force-sync`
planner and executor. Jellyfin episode lookups return every matching season/episode item so
duplicate quality copies are marked consistently.

For an all-destination title push, every local media-server write completes before the
Trakt history phase begins. Trakt writes are serialized with a short start interval and
retry a bounded number of times after a `429`; cancelling the operation prevents queued
items from starting but lets the current canonical remove/add pair finish atomically.

## Personal rating scheduler

Personal Rating Sync is disabled by default and is not part of the watched-state
dispatch queue. When enabled in Settings → Sync → Sync Tools, the elected worker
checks its configured interval after the normal watched-state work completes. Each
provider has its own snapshot run and durable outbound queue, so a slow or unavailable
rating provider cannot block or rewrite watched history, playstate, resume progress,
or the Force Sync operation lock.

Local rating changes commit to `personal_ratings` first and enqueue provider writes in
the same SQLite transaction. The queue uses latest-intent deduplication, leases,
backoff, explicit reauthentication status, and outbound echo markers. Baseline mode
records the first remote snapshot without importing it; Import mode seeds the local
canonical ratings. A missing-row clear is only considered after a complete previous
snapshot.

## Plex watchlist scheduler

Plex Watchlist Sync is disabled globally until enabled from Settings → Sync → Sync Tools,
the Plex media-server card, or guided setup. The elected worker runs it after watched-state
work and personal ratings, within its own bounded budget. Local add/remove mutations are
already durable before this pass starts; the worker repairs Plex queue rows, reads the
account-level Universal Watchlist, and delivers pending additions/removals with leases,
retry backoff, and redacted errors.

The first run takes a safe union of the local and Plex lists. `POST
/api/watchlist-sync/preview` remains available for a read-only snapshot and resolution
check; `POST /api/watchlist-sync/run` performs the reconcile. Plex-only additions are
imported into Plekt, and a complete later snapshot is required before a missing
previously managed item can be treated as a provider removal.

Missing remote items only become provider-originated removals after a successful, complete
snapshot has followed an earlier complete snapshot. Partial, empty-after-error,
unauthorized, or unavailable responses never remove the canonical local row. A confirmed
Plex removal does remove the canonical row and records the local change. A completed movie
watch, explicitly completed TV show, or show-progress completion follows the same removal
hook; watching one episode alone does not remove a TV show watchlist row.

The worker records provider/user/representation scope, ownership, queue outcome, run
generation, and removal reason in the watchlist ledger/activity tables. A full backup
restore pauses delivery and requires an explicit Publish restored watchlist action;
disabling or disconnecting a provider never deletes the canonical list.

Provider-ID changes can create a distinct local record. Fix Match
(`PATCH /api/update-watch`) recomputes `media_key` and merges playstate when a correction
changes a record's identity. Title comparisons normalize whitespace, so title variants from
Trakt and media servers can resolve to the same watched item when provider IDs are absent.

## One canonical state, input from every connected service

Plekt stores the canonical `playstate`/watch-history decision, but accepts explicit
watched and unwatched actions from Plekt, Plex, Emby, Jellyfin, and a connected Trakt
account. Each accepted transition is committed locally and distributed to every other
eligible destination. Trakt is read as a complete snapshot each minute: additions become
watches, removals become unwatches, and a changed watched timestamp updates the canonical
playstate. Persisted tracker state and echo markers prevent Plekt's own outbound write
from being read back as a second user action.

Trakt records every individual play of an item, not just its most recent one. Alongside
the snapshot diff above, Plekt separately reads Trakt's play-by-play history
(`/sync/history/movies` and `/sync/history/episodes`) and imports each play Plekt
doesn't already have as its own `watch_history` row, so rewatches show up individually in
History and Stats instead of being collapsed into one watched record. The first poll after
connecting imports the full history; later polls only fetch plays since the last-seen
timestamp (`tracker_connections.history_synced_at`), and each play is deduplicated by its
Trakt history id in the `tracker_play_history` table so it is only ever imported once.
These backfilled plays do not propagate to Plex/Emby/Jellyfin - they record what already
happened on Trakt rather than triggering a new watch event - and pushing a local watch to
Trakt (`setTraktWatchState`) already sends each individual play with its own timestamp, so
rewatches recorded locally reach Trakt as separate history entries too.

Before importing a play, the history importer checks it against Plekt's own most recent
outbound "watched" push for that item (the same `tracker_item_state` ledger the snapshot
diff's echo markers use, captured before that poll's snapshot rewrite so a not-yet-reflected
push isn't lost). A play timestamped within 30 minutes of that push is treated as an echo of
it rather than a new play: it is recorded in `tracker_play_history` so it is never
re-evaluated, but no `watch_history` row is created for it. This is defense-in-depth against
a wrongly-dated outbound push (or plain clock skew) round-tripping back in as a phantom
second local watch, on top of whatever caused the wrong date reaching Trakt in the first
place.

Backfilled Trakt plays are recorded without outbound propagation. The stale-import audit
and repair endpoints expose rows with missing dispatch telemetry and mark them settled
without changing watched state or sending another dispatch:
`GET /api/stale-trakt-import-audit` and `POST /api/stale-trakt-import-repair`
(`auditStaleTraktImportRows`/`repairStaleTraktImportRows` in `dataRepo.js`).

During an authoritative watch-history restore, an explicit manual unwatch or clear-
progress action commits Plekt's local unwatched state immediately. Its outbound
fan-out is recorded as pending and the scheduler dispatches it after the restore fence
is released; provider callbacks and automatic transitions remain fenced while the
restore is active.

Canonical replays for an existing `watch_history` row record dispatch telemetry so the
manual-dispatch queue can retry failures. `GET /api/stale-pending-watch-audit` reports
watched rows with missing or exhausted retry telemetry (read-only).
`POST /api/stale-pending-watch-repair` resets their retry bookkeeping so the next
scheduler tick performs a real dispatch (`auditStalePendingWatchRows`/
`repairStalePendingWatchRows` in `dataRepo.js`).

An incomplete or rate-limited media-server scan can report a burst of items as unplayed.
The resulting automatic unwatch events may leave a watched row under one `media_key` and
an unwatched row under another, which makes the item appear unwatched despite existing
watch history.

`applyUnwatchedTransition` in `watchStateTransitions.js` is the choke point for automatic
unwatch events from Plex, Emby, Jellyfin, and Trakt. It tracks a shared `loop_keys`-
backed sliding-window count in SQLite and holds back an automatic unwatch when the burst
threshold is exceeded. The guard applies across split web/worker deployments and does
not affect explicit actions from Plekt, Force Sync, Set Plekt as Source of Truth,
or Trakt import. Trakt also has a per-show suspicious-drop guard; the shared guard covers
bursts distributed across multiple shows.

`GET /api/split-identity-unwatch-audit` finds episodes whose watched and unwatched rows
use different identities (read-only; `auditSplitIdentityUnwatches` in `dataRepo.js`).
`POST /api/split-identity-unwatch-repair` restores each one - deletes the shadowing unwatched
row, restores playstate to the shadowed watch's own date, and re-pushes the corrected
"watched" state to every connected platform (`repairSplitIdentityUnwatches` in `dataRepo.js`,
propagated the same way `propagateWatchDateRemoval` in `routes/media.js` replays a corrected
date). This is an explicit admin action, not wired to any automatic trigger - review the audit
output first.

`GET /api/likely-false-unwatch-audit` finds lower-confidence candidates where no row in a
group is watched and at least one unwatched row came from an automatic source
(`plex`/`emby`/`jellyfin`, never `manual`).
`auditLikelyFalseUnwatches` in `dataRepo.js`; `POST /api/likely-false-unwatch-repair`
consolidates every stale row for the episode into one fresh watched record using the oldest
row's own date as the best evidence of when it was genuinely watched, then re-pushes it to
every connected platform (`repairLikelyFalseUnwatches`). Review candidates before repairing:
an automatic source can also represent a genuine unwatch performed directly on a media server.

An explicit unplayed webhook/notification or Trakt snapshot removal changes the canonical
state to unwatched and propagates it. Plex show and season notifications are expanded into
their episodes so bulk library actions follow the same transition path. Plex notification
handlers are bounded and repeated same-state frames are coalesced, including the recursive
episode fan-out from a container, so a library burst cannot overwhelm provider lookups or
the web process. Polling remains conservative when a server scan is unavailable or
incomplete: absence from a failed/partial scan is never interpreted as an unwatch.

Implementation lives in `server/src/utils/unwatchedStatusPoll.js` (the fallback polls, run by
`runDueUnwatchedPolls` from `scheduled.js`) and `server/src/scheduled.js`.

## What it does each run

1. **Live session tracking** (this feeds Now Playing) - **runs every minute**:
   - `fetchLiveSessions(config)` polls the configured servers for what's playing now.
   - `buildCacheRow()` shapes each session; `upsertLiveTrackingCache()` writes them
     to the `live_tracking_cache` SQLite table.
   - Reconciles against cached rows: a **recent** cached session that is **no
     longer reported** (for two polls) and had `last_progress` at or past the
     watched threshold (`WATCHED_THRESHOLD_PERCENT`, 90% by default) is treated as
     a **completed watch** (`processCompletedSession` → inserts history +
     propagates). Progress is floored to two decimals, so 89.6% stays under 90%.
     A session last seen paused counts too when it was paused at or past the
     threshold (paused in the credits, then closed). A row older than five minutes
     is discarded rather than promoted to a watch; sessions that vanish below the
     threshold are marked/cleared as stale.
   - An item already held as watched is recorded again only as a **rewatch**, by the
     same rule as webhooks: its last watch fell on an earlier UTC day than the
     session. A second completion on the same day is not recorded.
2. **Manual dispatch queue** - **runs every minute**:
   - `syncPendingManualDispatches` processes anything queued by the UI or an import
     (manual mark-watched, Trakt history, retries). The `media` object it builds for
     each retried row carries that row's own `watched_at` - without it, Trakt's sync
     payload falls back to the current time, so a genuinely historical watch (one
     re-dispatched later rather than right when it happened, e.g. a row that
     `remainingWatchRowFor()` in `dataRepo.js` promoted from a stale unwatched marker
     back to watched) would reach Trakt stamped as watched right now instead of on
     its real date.
   - The queue selects at most 15 rows per tick, groups them with the complete
     history as identity context, and runs up to six different media identities
     concurrently. Alias rows for the same movie or episode remain serialized so
     mixed-source loop keys cannot suppress one another. Bulk historical imports
     remain behind ordinary pending work.
   - Records whose targets keep failing are retried with **exponential backoff**
     (1 m → 5 m → 15 m → 1 h → 6 h, tracked in the `sync_retry_count` /
     `sync_next_retry_at` columns on `watch_history`). After 10 failed attempts a
     record becomes terminal - its telemetry says automatic retries are exhausted
     and only a manual **Retry Sync** (which resets the counters) re-queues it.
     A `sync_history` row is only written when the outcome changes (first
     failure, success, or giving up), not on every identical failed attempt.
   - **Trakt** is retried the same way, but only while Trakt is connected and only
     when the row's Trakt line is an error caused by a rate limit (429), a Trakt
     server error (5xx), a timeout, or a connection failure. "Could not match" and
     other Trakt errors stay failed until **Retry Sync**. Before re-adding a watched
     play the retry reads Trakt's history within one minute of the row's
     `watched_at`; a play already there (a write Trakt accepted before its response
     was lost) marks the row synced without writing again. A retry for a local
     server alone never re-sends to Trakt; the row's earlier Trakt line is kept
     (decision 41).
     A destination no-match is recorded in the row's telemetry. For an episode
     mutation, Plex, Emby, and Jellyfin invalidate the cached series episode index and
     retry once before returning a skip; Sync Activity shows the final reason when the
     refreshed index still has no matching episode. Unidentified items are surfaced in
     the standalone Sync Activity page's Issues view, using the Cross-Platform Match
     Report data from `GET /api/sync-match-report`; identified items that are absent
     from a library remain an availability difference rather than an issue.
     A skipped/not-found result is terminal for that target rather than a reason
     to rediscover the same absent coordinate every minute. An explicit later
     action or library-history import can retry an item after it enters a library.
   - Every real dispatch this queue makes (and every other one - a bulk duplicate-watch
     cleanup, a single manual watch/unwatch, a webhook-triggered propagation) goes through
     `syncMediaPlaystate` or `syncMediaUnplayedPlaystate` in `syncOrchestrator.js`, which is
     where the sidebar's "Sync - N of M" indicator gets its numbers - tracking it there,
     rather than per call site, means the indicator does not depend on knowing every place
     that can trigger a dispatch. A "burst" opens the first time a dispatch starts after being
     fully idle and closes `DISPATCH_PROGRESS_IDLE_MS` (2s) after the last one in it finishes,
     so a handful of near-simultaneous fire-and-forget calls (e.g. one propagation per episode
     from a season's duplicate-watch cleanup) share one window instead of each flashing the
     indicator open and shut on its own. A caller that already knows its batch size (the Trakt
     snapshot poll, a bulk mark-watched/unwatched) reports the whole total up front with
     `reserveDispatchBatch(size)` instead of letting the total climb one item at a time as
     bounded-concurrency workers pick up new items - the indicator shows the true total
     immediately rather than rising toward an unknown ceiling. Each process gives its burst a
     unique owner and updates that owner's counters inside an atomic SQLite transaction;
     `runtime_state.backgroundSyncProgress` is the aggregate of every live owner, so one
     process finishing cannot erase another process's work. Owners heartbeat every 15 seconds,
     expire 90 seconds after a process disappears, and have a 30-minute hard lease so a leaked
     local timer cannot hold the UI busy forever. `GET /api/live-updates` reads and repairs that
     shared state every 250ms. Its initial `ready` event includes the current counters before
     the browser reacts to a changed history version, then later changes use `sync-progress`
     events. `renderSyncProgress` in `app.js` shows the indicator while `total > 0` and
     `completed < total`. Keeping the owner map in `runtime_state` rather than process memory
     makes the aggregate safe across a split web/worker deployment.
3. **Trakt snapshot sync** - **runs every minute when connected**:
   - Refreshes OAuth tokens when required and reads every watched movie and episode page.
   - Applies additions, removals, and rewatch timestamp changes with bounded concurrency.
   - A removal is only trusted immediately when it is a small change. If a large share of one
     show's episodes disappear from Trakt's watched response in the same poll - the shape of a
     rate-limited or truncated response, not a real unwatch - those removals are held back and
     re-checked on the next poll instead of propagating right away: still missing next time means
     genuine and they go through then; back in the snapshot means the previous poll was a
     transient hiccup and nothing is sent out. A normal removal of a couple of episodes is never
     affected by this and still propagates the same minute (`partitionSuspiciousUnwatches` in
     `trackerSync.js`).
   - A watched mark Plekt just pushed to Trakt does not always appear in the very next
     watched-snapshot fetch - Trakt's API can lag a few seconds behind its own write. A poll
     landing in that window would otherwise see the item as missing and read it as a genuine
     remote unwatch, deleting the watch it had just created. The unwatch-candidate filter
     excludes any item pushed "watched" within the last 30 minutes for this reason, the same
     window already used to stop a pushed "unwatched" from echoing back as a second unwatch.

Before the manual queue and Trakt snapshot poll start, the scheduler reads the shared
dispatch-progress owners. When more than eight items remain in an active dispatch burst,
it defers scheduled media sync and the Trakt poll until the next tick. Backups, TMDB
prewarm, next-airing, and upcoming-calendar maintenance still run. A scheduled sync
already in flight is not cancelled; the guard only prevents new competing outbound work.
   - **Sync Now** is a one-way repair pass for the current Trakt snapshot: it compares
     unchanged Trakt watches with Plekt's canonical state and restores missing
     watched state. It does not infer unwatches from items missing in that one response,
     so a partial Trakt result cannot clear a whole show such as Oak Island. The normal
     minute-by-minute poll still handles genuine remote removals, with the safety checks
     above. The connection card reports how many Trakt items were checked and how many
     watched states were restored.
   - Episode writes resolve series-level provider IDs before calling Trakt. This avoids
     sending episode-level Plex/Emby/Jellyfin IDs in the show slot and lets identity-poor
     catch-up rows use the show's cached metadata. Plex notification episodes first use
     their native grandparent rating key to fetch the exact Plex series metadata when the
     notification omitted the series GUID; this is a direct parent lookup, not a title guess.
     Title-only episodes can still be hydrated once because they have no identity to protect.
     An episode that already carries an identity remains tied to it: if Trakt rejects that
     identity (`not_found` in `/sync/history`), Plekt does not retry with a title-derived
     series id. It records the mismatch as an error so the media can be fixed or matched
     explicitly. Movies retain their one title-derived retry because their Trakt payload is
     title-level rather than series-plus-episode.
   - Compound episodes are canonicalized when the source represents one story as two
     numbered parts. Common `(1)`/`(2)`, `(Part 1)`/`(Part 2)`, `(Pt 1)`/`(Pt 2)`, and
     bracketed markers are recognized directly; matching split titles in cached season
     metadata are also recognized when the watch rows lack those markers. Both source
     coordinates map to the canonical first episode for dispatch while the original
     coordinate is retained for audit and matching.
   - A Plex notification episode unwatch whose every configured Emby/Jellyfin destination
     reports no matching episode after its one index refresh is kept out of Trakt.
     Plekt still records the incoming local transition and the no-match audit, but
     does not let an unresolved Plex episode identity change Trakt's state.
   - Dispatches accepted transitions to media servers and signals the authenticated
     browser update stream after each committed item.
   - After the snapshot diff, a separate step reads Trakt's per-play history and imports
     any rewatch Plekt hasn't recorded yet (see "One canonical state" above). A failure
     here is logged and does not fail the poll - the snapshot-driven playstate sync above
     still completes normally.
4. **Catch-up library sync** - **runs every 15 minutes** (configurable via `CATCHUP_SYNC_INTERVAL_MS` env variable) to avoid heavy redundant API queries:
   - Pulls recently-watched and continue-watching (resumable) items from each active server: `syncRecentlyWatchedFromPlex` (and the Emby/Jellyfin equivalents) in `server/src/utils/recentWatchImport.js`, and `syncRecentlyResumableFromPlex` (and the Emby/Jellyfin equivalents) in `scheduled.js`.
   - Runs a full paginated availability reconciliation after watched imports. For every active provider, an item must be present in that provider's successful library inventory, explicitly unplayed there, and canonically watched in Plekt before the scheduler marks it played. This catches bulk-added 4K/alternate-library copies, uses the exact native item id, and is positive-only: missing items, failed/partial scans, and canonical unwatches never trigger an unwatch.
   - Refreshes the provider Up Next feeds in the same catch-up window. Plekt uses Plex's
     account-scoped **Continue Watching** hub, Emby's user-scoped **Continue Watching/Resume**
     endpoint, and Jellyfin's user-scoped **Next Up** endpoint as the three target rails. The
     Jellyfin **Continue Watching/Resume** endpoint is also read separately to protect genuine
     part-watched progress, but it is not used as the Jellyfin Up Next queue. Plex falls back to
     the configured library sections when its hub is unavailable.
     Provider clients paginate these feeds, so the stored snapshot is not capped at the
     first 50 items. The responses are stored as source observations in
     `up_next_provider_items`, not as watched-state authority. Each feed is generation-based:
     only a complete response becomes active, while a failed or partial response leaves the
     last good generation available and records a redacted status for the dashboard.
     The newest 50 resume rows are propagated into Plekt's canonical progress table in
     that pass; the complete provider observation remains available to the queue.
   - The queue builder merges those observations by verified provider identity and
     episode coordinates, keeps resume cards ahead of released next-up episodes, and
     uses bounded local TVDB/TMDB lookup when a configured provider has no usable Next Up
     feed. The active source-ledger IDs are also preferred for later provider mutations,
     including all matching Jellyfin item variants.
   - A recently-watched row counts in Plekt's visible history and show progress when it
     carries the configured source user and either an explicit server played timestamp or
     a configured policy for app-marked watched flags. The default policy dates a manual
     watched flag at the current time; release-day and same-season episode-timing policies
     use their respective stable dates. With **Require review**, the scanner stores a
      deduplicated pending item in `manual_watch_reviews` and waits for the Manual Watch
      review page. A flag already superseded by a newer canonical watched state is not
      reported as a new queued review, and neither is an episode history already shows
      watched. An episode review that carries only the episode's own IMDb/TVDB ids (Emby) is
      matched to its show through the same cached TMDB `find` / TVDB proof the playstate
      alias repair uses; uncached ids are looked up by that repair's background job
      (`repair_playstate_episode_ids`). A library import never queues a review for an item
      Plekt already has watched, and a pending review that local state already answers is
      closed (`dismissed`, `resolved_by_local_state`, status only) rather than kept pending out
      of sight (`docs/decisions.md` entry 39). Unscoped library scans remain diagnostic evidence
      rather than asserted watches.
   - Emby/Jellyfin episode resume rows retain series provider IDs so the corresponding SxxExx item can be found on another server. Resume and playstate records sharing any IMDb, TMDB, or TVDB ID are treated as one media item even when app titles differ. When a server reads back the same position with a stale or missing `LastPlayedDate`, Plekt retains the newer timestamp already stored for that position; generic item-save/create dates never outrank an explicit watch-state change, and a genuinely newer unwatch still clears older progress.
   - Propagates playstate changes that were missed by webhooks. A server-side unwatch
     that conflicts with Plekt's watched state is repaired instead of imported as a
     local unwatch. Each platform check is wrapped in try/catch so one failure doesn't
     abort the run.
   - **Unwatched reconciliation** - `checkPlexUnwatchedStatus` re-checks up to 30
     recently-tracked, platform-confirmed-watched records per minute against Plex's current
     played state (a single cheap lookup per item), repairing an unwatch that the
     notification WebSocket missed - Plex's webhook cannot report unwatch at all, so this
     poll is a primary detection path, not just a backstop. "Recently-tracked" here means
     Plekt last *learned about* the record (`listRecentlyUpdatedTrackedWatchRows`,
     ordered by `updated_at`), not the media's own reported watched date - Plex can
     legitimately report an old watch date (and sparse notifications have historically
     fallen back to release dates), which otherwise made a newly inserted watched item
     invisible to this safety net right after it was added. `checkPlexUnwatchedFast`
     (`scheduler.js`, a smaller batch of 10 checked every minute alongside the WebSocket
     listener) uses the same helper. `checkEmbyUnwatchedStatus` and
     `checkJellyfinUnwatchedStatus` do the same for a smaller batch (5 records, checked
     sequentially rather than concurrently) every 5 minutes instead of every 1, since their
     webhooks natively report unwatch and these polls only ever backstop a missed or
     misconfigured webhook. Emby is enabled by default with
     `EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED`; Jellyfin's ambiguous library `Played=false`
     fallback is **disabled by default** and can be opted into with
     `JELLYFIN_UNWATCHED_POLL_ENABLED=true`. Jellyfin's explicit mark-unplayed webhook
     remains authoritative. When the fallback is enabled, it requires the same false
     state twice within `JELLYFIN_UNWATCHED_CONFIRMATION_WINDOW_MS` and ignores a duplicate
     match if any matching Jellyfin item is still watched. Their per-item lookup
     (`findEpisode`: several sequential provider-ID/fallback/episode-fetch requests) is more
     expensive than Plex's single lookup, which is why the batch size and cadence are
     smaller; the "last checked" timestamp seeds to process start time instead of zero so a
     restart can't make the next tick fire immediately. A record more than ~100 tracked
     watches old ages out of this window and is only caught by a manual Force Sync
     (`docs/media-detail.md`).

This is how a play that finishes without a final scrobble webhook still gets
recorded: the poller sees it hit the watched threshold (90% by default), then
disappear, and completes it.

5. **TV next-airing cache** - `runScheduledTick()` maintains
   `data/next-airing-cache.json`. To prevent timing out, the cache is
   built and refreshed in small batches (default 40 shows per 30-minute tick)
   sorted by the oldest update times. Each show is looked up through the regular
   `getTmdbDetails` cache layer (no forced refetch), so a refresh cycle only
   reaches TMDB/TVDB when a show's cached details have actually expired. This
   allows the TV Shows page to sort by upcoming episode date without querying
   TMDB for every row, while avoiding timeouts on large libraries.

6. **Upcoming calendar cache** - every 10 minutes the scheduler processes one month
   in `data/upcoming-calendar-cache.json`. It builds the previous 24 months once and
   checks the current month plus the next 12 months every 6 hours. Future checks only
   rewrite stored data when episode results changed; historical months are not refreshed.
   Newly tracked shows are merged into cached months on the next calendar request.

## Echo suppression

Marking an item played on a media server bumps that server's own "last played"
timestamp. That makes Plekt's own outbound write indistinguishable from a user's
play the next time the same server is read back - through library polling, the Plex
notification listener, or a delayed webhook. Left unchecked it records a watch that
never happened, and each phantom re-propagates and produces another one.

Three mechanisms keep inbound state honest:

- **Outbound mark ledger** - every successful played-mark is recorded per target in
  `loop_keys` under a `mark:` prefix with a 14-day TTL
  (`recordOutboundPlayedMarks` / `lastOutboundPlayedMarkAt` in `syncOrchestrator.js`).
  The Plex notification listener consults it: a view timestamp within 10 minutes of
  a mark Plekt wrote is treated as its own echo, not a new play. This outlives the
  15-second loop-detection window, which only breaks immediate ping-pong.
- **Existing-record guard** - the Plex, Emby, and Jellyfin library pollers record a
  watch only for an item with no watch record at all. When a record exists but the
  playstate has drifted, the poller repairs the playstate instead of filing a second
  watch for the same play.
- **Played-flag rule** - a bare "marked played" webhook never opens a rewatch for an
  item already watched; see [webhooks.md](webhooks.md#rewatch-detection).
- **Canonical unwatch handling** - an explicit Plekt unwatch is propagated and an
  echo that arrives after the 15-second loop window closes is already represented as
  unwatched, so it is a no-op. An explicit unwatched event from an eligible platform
  supersedes the watched state and propagates to the other configured destinations.

Full Sync Watchstates uses a separate `restoreSyncKind` marker and heartbeat in the
shared runtime state. A server restart cannot resume its browser-driven batch, so a
startup clears a tagged Full Sync lock and marks it cancelled. The **Reset Restore
Lock** control under **Settings → Sync → Sync Tools → Full Sync Watchstates** handles
older or untagged locks and stops an in-flight request before it can send another
batch. Backup restores use a different restore kind and are not cleared by this
control.

Completed sessions flushed from `live_tracking_cache` are dated from when the session
was last seen playing, not from the tick that noticed it had gone, so a session that
lingered through a restart is not backdated to the restart time.

## Why it matters for Now Playing

`live_tracking_cache` is the **primary** source for Now Playing (see
[now-playing.md](now-playing.md)). If the poller can't reach the media servers,
`live_tracking_cache` goes empty and Now Playing shows idle - even though the UI and
webhooks are fine.

**Reachability:** the poller runs on the same machine as the Plekt server process.
It can reach any URL that machine can reach - including `localhost`, LAN IPs, and VPN
addresses.

## Debugging

- Trigger it manually and watch the log: `POST /api/cron-sync` with your API key
  (the response streams a line-by-line log identical to what the scheduler runs).
- Or watch the server process stdout. A background tick that changed nothing logs
  nothing, so silence between ticks is normal - errors and completed work still log.
- Set `PLEKT_DEBUG_SCHEDULER=1` to log each step's name, where in the tick it started,
  how long it ran, and whether it exhausted its time budget, followed by a per-tick summary
  carrying the achieved interval between tick starts. That is the measurement to reach for
  when a later step looks starved by an earlier one, because the claim is about wall-clock
  offsets inside a tick rather than about any one step's own duration.
- A step that runs past its time budget (a large Plekt backup, a long catch-up pass) is
  not stopped: the tick moves on, the log says "`<step>` is still running after Nms", and
  "finished in the background" (or "`<step>` failed" with the real error) follows when it
  settles. Later ticks skip that step with "still running from a previous tick" meanwhile.
- Set `LOG_VERBOSE=true` to add the per-phase narration, including
  `"live sessions: N, cached sessions in tracking: M"`, which tells you whether the
  poller is seeing anything. A user-triggered catch-up run logs those phases to its
  job log regardless of the flag.
- Repeated per-item outcomes are condensed: skipped watched items are reported once
  per run with a count, and a resume-progress item that keeps producing the same
  outcome is logged only when that outcome changes.
- Force sync from the dashboard: **Settings → Sync → Sync Tools → Force Sync**
  (`/settings/sync#sync-tools`) streams the same log in-browser and shows
  per-platform status.
