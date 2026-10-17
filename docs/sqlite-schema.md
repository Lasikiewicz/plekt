# SQLite Schema

Reference for `data/plembfin.db`. The full authoritative schema is in
`server/src/schema.sql`; this doc adds context on the less-obvious fields.

## Table list

| Table | Purpose | Written by | Read by |
| --- | --- | --- | --- |
| `watch_history` | Canonical watch records (one row per unique watched item) | webhook `completed`/`unplayed`, scheduled catch-up, import | history endpoints, dashboard |
| `live_tracking_cache` | Snapshot of currently-playing sessions from the scheduler | elected worker only | `handleNowPlaying` |
| `active_sessions` | Live sessions from webhook `active` events (5-min TTL) | webhook `active` phase | `handleNowPlaying`, `active-sessions` |
| `playback_progress` | Resume position records | webhook `ended`, sync orchestrator | resume propagation |
| `up_next_provider_items` | Latest generation of provider Resume/Continue Watching/Next Up observations, keyed by provider feed and native item ID | scheduled provider feed sync | unified Up Next builder, source-ledger mutation lookup |
| `up_next_provider_feed_state` | Per-provider/feed generation, completion, freshness, count, cursor, retry, and redacted error state | scheduled provider feed sync | Up Next cache/status response |
| `up_next_library_items` | Last library-confirmed native item id per Up Next library lookup (30-day window); a live "missing" deletes the row | Up Next library lookup | the same lookup, only while that provider cannot answer, so a restart during an outage keeps the cards it proved |
| `playstate` | Per-item watched/unwatched state for sync targets | sync orchestrator | sync orchestrator |
| `manual_watch_reviews` | Deduplicated provider watched flags awaiting an administrator date decision | scheduled library sync, Manual Watch review page | Manual Watch review page |
| `sync_history` | Permanent log of sync dispatch results, with `activity_group_key` for grouped movie/show activity and `activity_item_key` for latest-result selection per movie/episode | sync outcome changes | sync-history and sync-activity endpoints |
| `runtime_state` | Single-row JSON blob - last cron time, force-sync state/log, `nowPlayingRefresh` signal | scheduler, force-sync, webhooks | dashboard polling |
| `restore_reports` | A completed authoritative restore's full result and log, keyed by run id | restore job | restore status view, on request |
| `cache_versions` | Monotone cross-process cache generations (`history` for canonical watch state, `progress` for resume positions, `discover` for changed TMDB feed snapshots, `up_next` for changed dashboard queue snapshots) | SQLite triggers and explicit invalidation | every web/worker process |
| `scheduler_lease` | Current worker leader, fencing generation, heartbeat and tick time | worker coordinator | health and worker coordination |
| `background_jobs` / `background_job_logs` | Durable cron/force-sync queue, state, results and ordered logs | web enqueues; leader claims | sync APIs and worker |
| `settings` | Single-row JSON blob - Plex/Emby/Jellyfin/TMDB/TVDB connection settings | config endpoint | everything that talks to servers |
| `media_auth_devices` | Stable per-provider client identities used by managed account connections | media auth routes | Plex/Emby/Jellyfin authentication clients |
| `media_auth_flows` | Expiring, browser-bound account authorization attempts | media auth routes | media auth polling/completion |
| `media_connections` | Active encrypted provider token and verified remote identity | media auth routes | runtime media-server config adapter |
| `tracker_connections` | Encrypted Trakt OAuth connection plus initial-sync policy/cursor state | tracker auth routes | scheduled tracker sync and outbound dispatcher |
| `tracker_auth_flows` | Expiring Trakt device-code authorization attempts | tracker auth routes | tracker auth polling/completion |
| `tracker_item_state` | Last observed Trakt state/timestamp and echo-suppression markers per canonical item | tracker sync/dispatcher | Trakt change detection |
| `tracker_play_history` | Dedup ledger of individually-imported Trakt plays, keyed by Trakt history id | tracker sync | rewatch/multi-play import |
| `personal_rating_sources` | Last per-provider personal-rating observation, snapshot generation, conflict status, and outbound echo markers | rating snapshot/queue worker | rating reconciliation and status |
| `personal_rating_sync_queue` | Durable latest-intent personal-rating writes with leases, retries, and outcomes | local rating actions, rating push/reconcile | rating queue worker and status |
| `personal_rating_sync_runs` | Per-provider baseline/import generation and scan counters | rating snapshot worker | rating status and missing-row safety |
| `personal_watchlist` | Canonical present-set of local movie/TV watchlist rows | personal-media actions, watched completion hook | Watchlist page, watchlist sync |
| `personal_watchlist_meta` | Singleton monotone canonical watchlist revision | watchlist repository | mutation ordering and queue intent |
| `personal_watchlist_mutations` | Append-only present/absent mutations, including removal tombstones and origin/reason | local/provider/watched/restore paths | latest desired state, reconciliation |
| `personal_watchlist_provider_items` | Provider/user/representation observations, ownership, container IDs, and outbound status | watchlist snapshot/queue worker | safe removal, status, retry |
| `personal_watchlist_sync_queue` | Durable latest-intent provider additions/removals with leases and retry state | watchlist repository/worker | watchlist queue worker |
| `personal_watchlist_sync_runs` | Provider snapshot generations, completion markers, cursors, counts, and errors | watchlist snapshot worker | complete-snapshot safety/status |
| `personal_watchlist_activity` | Redacted watchlist-specific activity and removal reasons | watchlist repository/worker | Watchlist settings activity feed |
| `personal_lists` / `personal_list_items` | Playlists (formerly Custom Lists), each Movies, TV, or Mixed, and their ordered movie and episode items, with soft delete for Recently deleted | personal-media list actions | Playlists page, playlist sync |
| `personal_list_handoffs` | Titles an automatic playlist removed as watched and never adds back | `playlistWatched.js` | playlist rule engine |
| `personal_list_item_exclusions` | Episodes of a pre-conversion show item removed in an app (no new rows) | playlist pull engine (before migration 44) | show-to-episodes conversion |
| `personal_list_targets` | Which apps each playlist targets, remote playlist id, and sync/not-found state | playlist routes and sync engine | playlist sync, status |
| `personal_list_entry_ledger` | Per-remote-entry record of what Plekt last wrote or saw | playlist sync engine | app-side change detection |
| `personal_list_item_availability` | Per-item, per-app library availability from the last push | playlist push engine | "Missing from <app>" notes |
| `personal_list_held_changes` | App-side mass removals or deletions held for confirmation | playlist pull engine | confirm/discard of held changes |
| `loop_keys` | Loop-detection KV with TTL; expired rows deleted each tick by `pruneExpiredLoopKeys` | sync orchestrator | sync orchestrator |
| `watch_audit_events` | Audit trail of source events and watch changes; source-event payloads older than 90 days are cleared each tick (summary columns kept), and routine source-event payloads are trimmed at write | webhook ingest (`routes/sync.js`) and watch transitions | audit views, debug details |
| `poster_cache` | Cached artwork metadata (binaries in `data/media/`) | poster handler | poster resolution |
| `tmdb_metadata_cache` | Movie details (pure TMDB) or TV show details (TVDB structure + TMDB extras merged), key `${mediaType}_${tmdbId}` (or `tv_tvdb_${tvdbId}` if no TMDB match). `status`, `original_language` (read by the Language choice of automatic playlists), poster and backdrop paths are also mirrored into their own columns, written on every cache write and backfilled from the stored blob on upgrade, so the TV Shows grid can read them without parsing a details blob that averages 64KB for a TV entry. The stored document keeps streaming availability only for the regions the detail page reads (GB and US) and drops the unread release-dates block, which is about 40% of the cache | tmdb-details handler | detail pages, prefetch |
| `tmdb_search_cache` | TMDB search results and versioned Discover feed snapshots | tmdb-search/discover handlers | TMDB search and Discover |
| `recommendation_exclusions` | Movies and TV shows excluded from the personalized Discover recommendation rail | Discover card action | Discover recommendation filtering |
| `tmdb_season_cache` | TMDB season episode lists, read only for shows whose season source is TMDB (`getTmdbSeasonEpisodes` in `tmdbGateway.js`); TVDB seasons stay in `tvdb_season_cache` | `getTmdbSeason`, `getCachedTmdbSeason` | 2 days |
| `show_season_source` | Season structure source (`tvdb` or `tmdb`) saved per show (key: TVDB series id) on its first read, so a global change never re-numbers an existing show (`seasonSource.js`). A Fix Match choice replaces the source and records `row_numbering`, the numbering the show's stored watch rows use (rows are never renumbered; migration 55) | `resolveAndRecordSeasonSource`, `pinUnrecordedSeasonSources`, `setShowSeasonSource` | None (permanent) |
| `tmdb_person_cache` | TMDB person details, key `person_${personId}` | tmdb-person handler | cast pages |
| `tvdb_metadata_cache` | Raw TheTVDB series/extended response, key `series_${tvdbId}` (also holds title-search results, key `search_${hash}`) | tvdbGateway | tv show detail resolution |
| `tvdb_season_cache` | TheTVDB season episode list (from the series payload's episodes, or season/extended when a season is missing there), key `${tvdbId}_${seasonNumber}` | tvdbGateway | tmdb-season handler |
| `omdb_cache` | OMDb/IMDb ratings, 7-day TTL, key is the IMDb ID (`tt…`) | omdb-rating handler | media detail pages |
| `fanart_cache` | Raw fanart.tv responses including "no artwork" misses, 7-day TTL (1 day for misses), key `movies/<tmdbId>` / `tv/<tvdbId>` | fanartGateway | artwork resolution, edit-image galleries |
| `youtube_meta_cache` | Trailer metadata per YouTube video ID, 30-day TTL | youtube-meta handler | trailer playback |
| `audit_log` | Security-relevant event log (login, credential change, rotation) | `writeAuditLog()` in `db.js` | ops/debugging only |
| `diagnostic_log` | Captured console output, bounded ring buffer of 20,000 rows | `diagnosticLogger.js` | Settings → Logs panel |
| `schema_migrations` | Ordered migration ledger (`id`, `applied_at`) | `db.js` at startup | startup only |

## Why resume positions have their own generation

`playback_progress` writes arrive constantly while something is playing, and they used to
advance the same `history` generation that the watch-history derived caches key on. None of
those caches - history, movies, shows, stats - reads `playback_progress`, so every resume
ping threw away work it could not have invalidated. Measured with a dashboard open during
playback, the process spent **21.9%** of wall clock rebuilding on a 7,458-row library and
**46.8%** on a 90,000-row one; after giving resume positions the `progress` generation, both
are **0%**.

The browser's change contract is deliberately *broader* than the cache generation. An open
page still has to notice a resume position moving, so the live-update stream and
`getHistoryCacheVersion()` report the **sum** of the two generations. A sum rather than a
dotted pair because the client parses the value with `Number()`, where `5.10` and `5.1` are
the same number; both generations only increase, so their sum advances on every bump of
either.


## Schema migrations

`server/src/db.js` applies `schema.sql`, then runs ordered migration steps and records
each applied id in `schema_migrations`. Existing databases that already have a migrated
column still record the migration id after the idempotent check succeeds, so every
database converges on the same ledger.

## `up_next_provider_items` and `up_next_provider_feed_state`

The provider tables are a rebuildable source ledger, not a second watch-history store.
`up_next_provider_items` keeps one row per `(provider, feed_kind, provider_item_id)` in
the currently active feed generation. It retains canonical identity hints (IMDb/TMDB/
TVDB IDs and series IDs), episode coordinates, source timestamps, progress, poster
metadata, and the native IDs needed for later provider writes. `provider_ids_json` is
normalized metadata rather than a raw provider response.

`up_next_provider_feed_state` makes refreshes atomic from the queue's point of view:
the scheduler writes a generation, replaces active rows only after a complete response,
and records `failed`/`partial` status without discarding the last successful generation.
The dashboard receives feed freshness and redacted errors, never
provider URLs, API keys, tokens, or raw payloads. A changed active ledger advances the
`up_next` cache version and the live-update stream.

These two tables are cleared by tracked-data wipes and are intentionally rebuildable;
portable watch-history backups do not need to include them. Restoring canonical
`watch_history`, `playstate`, and `playback_progress` remains sufficient to recover the
local queue, while the next scheduled provider catch-up repopulates source observations.

## `live_tracking_cache`

Written by `upsertLiveTrackingCache` in `server/src/utils/dataRepo.js` (the data repository):

```
session_id     TEXT PRIMARY KEY  -- e.g. "plex:<id>:<season>:<episode>"
title          TEXT
source_platform TEXT             -- "plex" | "emby" | "jellyfin"
last_progress  REAL              -- 0..100
updated_at     INTEGER           -- epoch ms
completed_at   INTEGER           -- NULL while playing; set when progress ≥ 90 then session disappears
payload_json   TEXT              -- full session object (offset, duration, IDs, raw)
```

`handleNowPlaying` filters `WHERE completed_at IS NULL`. Rows with `completed_at`
set represent recently-finished sessions; they're kept temporarily so the dashboard
can show "just finished" state, then purged after 24h.

## `active_sessions`

Written by `upsertActiveSession`. **Configurable TTL enforced in code (5 minutes by
default):** `listActiveSessions` deletes rows with `updated_at` older than the active
session TTL on every read. The table will be
absent from queries when playback events haven't arrived recently - that's normal.

## `runtime_state` (single row)

JSON blob with:
- `nowPlayingRefresh` - timestamp bumped on webhook events; surfaced via the
  `X-Now-Playing-Refresh` response header so the dashboard knows to reload history
- `forceSyncState` - current force-sync status (`"running"`, `"done"`, `"error"`)
- `forceSyncLog` - streamed log text from the last force-sync run
- `lastCronAt` - epoch ms of the last successful scheduled tick

## `settings` (single row)

JSON blob with provider mode and non-secret connection configuration, legacy manual
Plex URL/token, Emby/Jellyfin URL/API key/user ID, TMDB key, Fanart.tv key, YouTube key,
OMDb key, and Seerr credentials. Managed account and Trakt tokens live encrypted in their
dedicated connection tables and are adapted into runtime configuration only in memory.
Written by `POST /api/config`, read by everything that calls the media server APIs.

## `watch_history` History-page columns

History paging also exposes two virtual, derived columns used only for indexed same-day
collapse: `history_day` (the calendar date from `watched_at`) and `history_daily_key`
(the existing movie or show/season/episode identity expression). The composite
`idx_watch_history_daily_key_order` index lets the History page keep whole-library
same-day semantics without sorting the whole table for every page. Because both columns
are virtual, inserts, edits, imports, restores, merges, and rematches cannot leave a stored
key stale.

Migration 33 also normalizes existing base fields that used to be repaired on every read:
HTML entities in `title`, malformed specials coordinates such as `S0?E03`, and missing
`season`/`episode` values recoverable from the title. New inserts, title edits, and watch-
history restores apply the same pure projection before writing.

## `watch_history` artwork columns

Custom artwork selected from media detail pages is stored on each watch row:
- `poster_url` - selected poster or locally cached `/media/posters/...` URL
- `logo_url` - selected transparent logo/title art URL
- `backdrop_url` - selected background/backdrop or locally cached `/media/backdrops/...` URL

For TV shows, grouped show summaries expose the canonical poster from `media_artwork`
when one exists; episode rows retain their own poster so episode stills remain
independent.

Episode title repair state is stored alongside each episode row:
- `episode_title_status` - `resolved`, `missing`, `retryable_error`, or
  `no_title_provided`; verified title-less rows are excluded from the actionable repair list
- `episode_title_checked_at` - epoch-ms time of the last authoritative repair check
- `episode_title_resolution_error` - bounded, non-secret error text for a retryable lookup

## `media_artwork`

Show-level poster overrides are stored separately from `watch_history`:

- `identity_key` - provider alias (`tv:tmdb:<id>`, `tv:tvdb:<id>`, `tv:imdb:<id>`) or normalized show-title key
- `media_type` - currently `tv` for canonical show posters
- `title`, `tmdb_id`, `tvdb_id`, `imdb_id` - identity values known when the poster was saved
- `poster_url` - selected or locally cached show poster
- `poster_source` - `manual` for Edit Images selections, or the source used by a future automatic resolver
- `updated_at` - last update timestamp

An Edit Images poster change updates all known aliases for the show. It never copies
the show poster into episode rows.

## `season_artwork`

Season posters chosen in the Edit Images "Season Posters" tab:

- `identity_key` - the same provider alias keys as `media_artwork`
- `season_number` - season the poster belongs to (`0` for Specials)
- `poster_url`, `poster_source`, `updated_at` - as in `media_artwork`

Primary key `(identity_key, season_number)`. `getCanonicalSeasonPosterUrls` returns these
ahead of the cached TMDB/TVDB season art, so Up Next, Recently watched and the upcoming
calendar pick them up. Saved through `POST /api/update-watch` with `artwork_scope: "season"`
and `season_number`; the watch row's own `poster_url` is not changed.

## `personal_ratings`

Personal ratings are local user data. Movie and TV rows use their own provider
identity; episode rows use the parent show's provider identity plus `season` and
`episode` in `media_key`. Episode-level provider IDs are stored separately so a
provider write can address the leaf item without changing the canonical key.
`origin` identifies `manual`, `import`, or `reconcile` writes and
`canonical_updated_at` supplies ordering for conflict resolution and queue intents.
Startup migration 17 merges older episode aliases that share a show title and
episode coordinate, keeping the canonical media-page row and the latest rating.
Migration 52 re-keys title-keyed episode ratings whose show title carries a
release year (`Ludwig (2024)`) to the bare-title key (`episode:title:ludwig:s2e1`).
Where both rows exist, the newest rating wins, and its source and queue rows
replace the other row's for the same providers.
Migration 20 adds the episode identity/origin columns and the isolated rating
source, queue, and run tables. The Ratings page reads the canonical records, while
`poster_url` remains the episode's own artwork.

## Personal rating sync tables

`personal_rating_sources` stores the latest observation for each provider/media key,
including the provider item ID, remote rated/unrated state, snapshot generation,
last inbound timestamp, last outbound intent marker, and a bounded error/status.

`personal_rating_sync_queue` has one row per provider/media key. A newer local or
reconcile intent replaces the older pending intent, which prevents stale ratings
from being delivered after a quick edit/remove sequence. `processing` rows have a
lease owner and expiry so a crashed worker can be reclaimed; transient failures use
`failed` plus `next_attempt_at`, while `not_found` and `reauth_required` await an
explicit retry.

`personal_rating_sync_runs` records one current snapshot generation per provider,
its baseline/import mode, completion marker, counts, cursor, and last error. Missing
remote ratings are only treated as clears after a previous complete generation, so
an incomplete provider response cannot bulk-clear local ratings.
Held mass-removal scans retain the previous baseline and store provider counts, missing
keys and display titles in `cursor_json.ratingHold`. Their stored status is `partial`;
the repository/API exposes `held` until approval or dismissal. No migration is needed.

## Personal watchlist tables

`personal_watchlist` remains the compatibility-facing current present-set. Every local
add, local removal, provider-originated removal, watched completion, or restore writes an
append-only `personal_watchlist_mutations` row and advances `personal_watchlist_meta`.
Absent mutations are retained as tombstones so a restart or rapid re-add cannot lose a
removal. The latest canonical revision, rather than the provider timestamp alone, wins.

`personal_watchlist_provider_items` is deliberately scoped by provider connection,
remote user, representation, and media key. It supports duplicate provider copies and
records whether Plekt owns each item or container. Queue rows explicitly store
`desired_state` (`present` or `absent`), so an absence can never be confused with “no
work”. Processing rows have a lease; transient failures retry with backoff, while
`not_available` and `reauth_required` remain visible for an explicit retry.

`personal_watchlist_sync_runs.complete_snapshot` is the safety gate for remote deletion:
only a successful complete snapshot may interpret a previously owned item missing from
the next snapshot as a confirmed provider removal. Restore resets remote observations,
queue success markers, and snapshot completion, records a restore revision, and stores a
separate restore-pending flag until explicit publish.

## Playlist tables

The UI calls these Playlists; the tables keep their original `personal_list` names.
Migration 43 rebuilt `personal_lists` and `personal_list_items` (the `media_type` CHECK had
to accept `episode`). Existing lists kept their items and got `position` numbered from the
old newest-first order; they have no target rows, so they stay Plekt-only.

- `personal_lists`: `deleted_at` / `deleted_origin` (`local` or a provider) mark a playlist
  in Recently deleted; active lists have `deleted_at IS NULL`. Names are unique
  case-insensitively among active lists only (partial index
  `idx_personal_lists_active_name`), so a deleted playlist does not block reusing its name.
  `order_updated_at` records the last Plekt-side reorder, so an app-side reorder is
  imported only when Plekt's order did not change since the last sync.
- `personal_list_items`: ordered by `position`; a new item takes the next position and a
  re-add keeps its place. Episode items use the `personal_ratings` convention: `tmdb_id` /
  `tvdb_id` / `imdb_id` are the show's ids, plus `show_title`, `season`, `episode`, and
  `episode_*` ids. A CHECK requires season and episode on episode rows.
- `personal_lists.kind` (migration 44, widened by migration 45): `movie`, `tv`, or `mixed`
  (movies and episodes together), fixed at creation; NULL only for a
  playlist that was empty when the column arrived, until its first item (a Plekt add or
  an imported app add) sets it. Migration 44 typed existing playlists by their items and
  split a mixed one: the original keeps its name and movies as `movie`, and its shows and
  episodes move to a new `Name (TV)` playlist (`(TV) (2)` on a name clash) with the same
  deleted state and copies of the `present` targets without a remote id, so the push
  creates the app copies and removes the moved entries from the original's.
- `personal_lists.rule_json`, `rule_checked_at`, `rule_error` (migration 47): automatic
  playlists (server side built; the Playlists page does not show them yet). `rule_json` is
  NULL for a manual playlist; otherwise the rule `{ source: "library" | "catalogue", genres,
  genreMatch: "any" | "all", yearFrom, yearTo, watched: "any" | "unwatched" | "watched",
  addedWithinDays, limit, order: "newest" | "oldest" | "title" | "random" | "rating" }`, with
  `rule_checked_at` the last evaluation time and `rule_error` why the last one failed. `kind`
  stays `movie` or `tv`. `server/src/utils/playlistRuleEngine.js` evaluates it hourly (from
  the scheduled playlist pass) and on Refresh now, and replaces the items; a failed library,
  TMDB, or episode read changes nothing and sets `rule_error`.
- `personal_lists.rule_hold_json`, `rule_hold_confirmed_at` (migration 48): a rule check that
  would remove at least 3 items that are also more than half the playlist is held whole (no
  adds or reorders either) as `{ removal_count, item_count, desired_count, held_at }`.
  Confirm sets `rule_hold_confirmed_at` and re-checks, applying even a large removal; Discard
  clears the hold and keeps the items until the next hourly check, which holds again if still
  needed. Kept here rather than in `personal_list_held_changes`, which is keyed per app target.
  An episode replaced by its own show's next episode does not count toward the hold.
- `personal_lists.remove_watched` (migration 49, default 0): "Remove items once watched".
  `server/src/utils/playlistWatched.js` deletes a movie or episode item whose latest trusted
  watch is later than the item's `created_at`, every scheduled playlist pass and before each
  rule check; the next push removes it from the apps.
- `personal_list_handoffs` (migration 49): `(list_id, identity, handed_off_at)`, one row per id
  key (`movie:tmdb:123`, `show:tvdb:456`) of a title an automatic playlist removed as watched.
  The rule never adds those titles back, even after an unwatch, a rule edit, or turning the
  switch off. Cascades when the playlist is deleted.
- `personal_list_items` with `media_type = 'tv'` (a whole show) exist only from before
  TV playlists held separate episodes. `server/src/utils/playlistShowConversion.js`, run at
  the start of each scheduled playlist pass for every playlist (Plekt-only and deleted
  ones too), replaces each with every episode the TMDB metadata lists (specials and unaired
  included) minus its exclusions, at the show's place; episodes already present keep theirs.
  The show's ledger rows are relinked to the episode keys so the push keeps the app entries.
  A failed fetch keeps the show and retries next pass; the sync skips a playlist until its
  shows are converted.
- `personal_list_item_exclusions`: episodes of a pre-conversion show item removed in an app.
  Only the show conversion reads it now; nothing writes new rows. Cascades when the show
  item is removed.
- `personal_list_targets`: one row per app a playlist targets, with the remote playlist id
  and last seen name. `desired_state = 'absent'` keeps a deselected app's row (and its
  remote id) until that app's playlist is deleted. `not_found_passes` / `missing_since`
  count definite not-found reads, since one not-found is never a deletion.
  `unidentified_count` is how many entries of that app's playlist the last pull could not
  identify (left in the app untouched; the Playlists page shows a note per app).
- `personal_list_entry_ledger`: what Plekt last wrote or saw per remote entry
  (`remote_entry_id` is Plex `playlistItemID` or Emby/Jellyfin `PlaylistItemId`). App-side
  changes are diffed against this ledger, never against the other side's live state, so
  Plekt's own writes are not re-imported. `absent_reads` counts consecutive reads missing
  the entry, since one short read never drives a removal. Cascades from its target row.
- `personal_list_item_availability`: whether each item resolved in each targeted app's
  library on the last push (`available` / `missing`, with a `reason`; `episode_count` was for
  the retired series items). A lookup that failed leaves the previous row; an item the app playlist still
  holds counts as available even when the lookup missed it. Written by
  `server/src/utils/playlistPushEngine.js`; cascades when the item is removed. A new table in
  `schema.sql`, so no migration.
- `personal_list_held_changes`: app-side changes the pull pass held for confirmation instead
  of applying (`kind` `removals`: at least 3 user removals that are more than half the
  ledger in one pass, with the remote `entry_ids` as JSON; `kind` `delete`: a concluded app
  deletion while more than one playlist of the same app reads as not found). Setting
  `confirmed_at` makes the next pull apply it; discarding forgets the held ledger rows (the
  push re-adds them) or clears the remote id (the push recreates the playlist). Written by
  `server/src/utils/playlistPullEngine.js`; cascades from its target row. New table, no
  migration.

The indexes on columns added by migration 43 are created by that migration, not
`schema.sql`, because `schema.sql` runs before migrations on older databases.

Route actions on `POST /api/personal-media` (`server/src/routes/personal.js`) that write
these tables, each scheduling a debounced sync:

- `list-create` / `list-update`: `providers` sets the target apps. A newly selected app must
  be connected; an already selected app may stay while disconnected. Deselecting an app with
  a remote playlist marks it `absent` (the sync deletes it); without one the row is dropped.
- `list-create` needs `kind` (`movie`, `tv`, or `mixed`; 400 `kind_required`).
- `list-add`: a new item takes `position` 0 and shifts the rest down; re-adding keeps its place.
  The item must match the playlist's type (400 `wrong_type`; a `mixed` playlist takes movies and
  episodes), a whole show is refused
  (400 `show_needs_episodes`), and the first item of an untyped playlist sets its `kind`.
- `list-add-episodes`: the picked episodes of one show go to the top as one block in episode
  order; episodes already present keep their place. `show-episodes` (read-only) returns
  every episode the metadata lists for the picker.
- `list-reorder`: `order` must be every media key of the playlist, else 409. Sets
  `order_updated_at`. The pull pass imports an app-side reorder only while
  `order_updated_at` is not later than that target's `last_synced_at` (and the target has no
  `last_error`); importing sets `order_updated_at` too, so a second app reordered in the same
  pass is moved back.
- `list-delete`: every playlist is soft-deleted (`deleted_origin = 'local'`) and its held
  changes cleared. `list-restore` clears the soft delete; when an active playlist took the
  name it answers 409 with `code: "name_taken"` and changes nothing, and the page asks for a
  new `name` to send. It also drops `absent` targets whose app playlist is already gone, and
  resets the `present` targets' not-found and error state so the push recreates them.
  `list-purge` hard-deletes a soft-deleted playlist once no connected app still holds a copy.
- `list-held`: confirm or discard a held change. With `ROLE=web` it only records the
  decision and the worker's next scheduled pass applies it.
- `list-import-candidates` (read-only, `server/src/utils/playlistImport.js`): each connected
  app's playlists that no `personal_list_targets.remote_playlist_id` links yet (a soft-deleted
  playlist's link still counts). Smart playlists are left out and counted in `smart_skipped`;
  an app whose list read fails comes back with `status: "error"`, never as an empty list. Each
  candidate carries its entry count, a `kind_guess` (`movie`, `tv`, `mixed`, or `empty` when it
  holds no movie or episode), `other_count` (entries that are neither), and `clash`:
  `name_taken`, `merge_into` (a live playlist of the same name, trimmed and case-insensitive,
  whose type can take it: same type, Mixed, or untyped, and that has no playlist in that app
  yet), and `same_name` candidates in other apps.
- Automatic playlists (`rule_json` set): `list-add`, `list-remove`, `list-add-episodes`, and
  `list-reorder` answer 409 `code: "automatic_playlist"`. `list-create` accepts `rule`
  (validated, 400 `code: "invalid_rule"`; `kind` movie or tv only; Recently added only with
  the library source; the catalogue source defaults to a maximum of 100). `list-update`
  accepts `rule` only for an automatic playlist (400 `code: "not_automatic"`) and resets the
  check time. `list-refresh-rule` checks at once, rereading the libraries (`ROLE=web`: 202,
  marked due for the worker). `list-rule-held` with `decision` confirm or discard.
  `list-stop-rule` runs a last one-way push (so app edits made while automatic are never
  imported), then clears the rule and any hold. The push for an automatic playlist removes
  app entries the rule does not want, re-adds removed ones at once, and forgets ledger rows
  whose entries left the app; the pull imports only renames and app-side deletion.
- `list-rule-genres` (read-only, `server/src/utils/playlistRuleCatalogue.js`): body `kind`
  (`movie` or `tv`, else 400). Reads each connected app's library catalogue (every movie and
  show with genres, year, added date, rating, and ids; Plex genre membership read per genre,
  since its list responses carry only a few tags; cached per app for 50 minutes; a failed or
  short read is an app `status: "error"`, never a partial library) and returns `genres`: TMDB's
  genres for that kind plus the apps' genres, merged by a key that ignores case, spacing, and
  punctuation and maps known alternate spellings (`Sci-Fi` and `Science Fiction`); a merged
  genre carries TMDB's name where TMDB has one, its `tmdb_id` for that kind, the `providers`
  reporting it, and `app_titles`. `apps` gives each app's read status.
- `list-import` (`importAppPlaylists` in the same file) takes `picks`: `{ provider,
  remote_playlist_id, mode: "merge" | "separate", merge_into?, targets }`. Each app playlist is
  re-read (gone or smart is refused), then all picks are linked in one transaction, so any
  refusal changes nothing: already linked (`already_linked`), a merge of Movies with TV
  (`kinds_differ`), or a playlist that already has a playlist in that app (`app_taken`).
  Separate creates a playlist of the guessed type (untyped when empty), named `Name (App)` when
  the name is taken or another pick shares it. Merge links into `merge_into`, or, without it,
  groups the merge picks of one name into a new playlist. The source app's target row gets
  `remote_playlist_id`, `remote_name` set to the app title (so the Plekt name wins and the
  push renames the app playlist), and an empty ledger; the other ticked apps are added as
  targets, and no other app is touched. The route then runs each playlist's first sync
  (worker roles only): with an empty ledger the pull imports every identified entry and the
  push only adds. Returns `imported` and per-playlist `lists` (`added`, `unidentified`,
  `errors`).

`GET` returns each active playlist with its selected `providers` (sync status), per-item
`availability` for those apps, and `held_changes`, plus `deleted_lists` and
`playlist_providers` (which apps are connected).

## `watch_history` sync retry columns

The scheduled dispatcher tracks its automatic-retry backoff on each watch row:
- `sync_retry_count` - consecutive failed dispatch attempts (reset to 0 on
  success or by the manual Retry Sync action)
- `sync_next_retry_at` - epoch-ms timestamp before which the scheduler will not
  re-dispatch this record (exponential backoff: 1 m → 5 m → 15 m → 1 h → 6 h)

After 10 failed attempts the record is terminal and only a manual Retry Sync
re-queues it. See [scheduled-sync.md](scheduled-sync.md).

## `audit_log`

Written by `writeAuditLog(action, { ip, detail })`. Actions logged:
- `login.success` / `login.failure`
- `credentials.updated`
- `sessions.revoked`
- `webhook-secret.rotated`
- `media.deleted`
- `settings.saved`
- `backup.restored`

Not exposed via API - query the database directly for ops review:
```sh
sqlite3 data/plembfin.db "SELECT ts, action, ip, detail FROM audit_log ORDER BY ts DESC LIMIT 50;"
```

## `watch_audit_events` retention

Summary columns (type, media key, phase, source, status, timestamp) are kept indefinitely. The
`payload` column has two limits for `source_event` rows:

- **Write-time trim:** a valid (`received`) source event keeps `watchProvenance` and `request`,
  but its `rawPayloadDebug` is replaced by `{ trimmed: true, originalBytes, topLevelKeys, ids }`
  (`auditSourceEventPayload` in `utils/watchAudit.js`). Rejected (`ignored`) events keep the full
  payload, because they are the ones that need troubleshooting. Raw provider bodies were about 95%
  of received payload bytes.
- **90-day prune:** each tick `pruneWatchAuditPayloads` sets `payload = NULL` for source-event rows older than
  90 days, in batches of 2,000. The partial index `idx_watch_audit_payload_created` serves it.
  Readers already handle a null payload (`parseJson` returns null), and the audit view shows
  "No additional payload was stored."

Other audit event types retain their payloads.

Disk space is not reclaimed until `VACUUM` runs, and the first payloads reach the 90-day window
about 30 November 2026.

## `diagnostic_log`

`diagnosticLogger.js` wraps `console.log` / `console.warn` / `console.error` and writes
each captured line here. Columns: `ts`, `level`, `category`, `role`, `instance`, `message`.
Secrets are redacted and known-spam lines are dropped before insert.

Writes are batched - entries buffer for up to a second and flush inside one transaction,
so a burst of output costs a single disk sync. The table is a ring buffer capped at 20,000
rows; the oldest rows are trimmed as new batches land, which keeps the Settings → Logs
query flat regardless of how long the process has been running.

Every process writes to this shared table, so the logs panel shows web and worker output
merged without reading other processes' files. `GET /api/diagnostic-logs` serves the panel
from an indexed query; `DELETE` on the same route clears the table.

Indexes: `diagnostic_log_ts`, `diagnostic_log_category_ts`, `diagnostic_log_level_ts` -
one per filter combination the panel offers.

The JSONL files under `data/logs` are a separate crash-forensics archive written
asynchronously. Nothing reads them at runtime, and they are pruned on boot to the last
20 files / 7 days.
