# Troubleshooting (symptom-first)

Database commands below use `data/plekt.db` for a fresh install. If `data/plembfin.db`
exists, use that existing file instead; do not let SQLite create a new empty database.
Docker commands use the fresh-install container name `plekt`; substitute your existing
container name when upgrading.


Start here. Find the symptom, follow the pointer.

## "Now Playing is empty or stale"

Causes, in order of likelihood:

1. **Scheduler isn't reaching the media servers.** The poller runs on the Plekt
   server machine. If that machine can't reach the configured Plex/Emby/Jellyfin
   URLs, `live_tracking_cache` stays empty. The browser-side local probe compensates
   for display but the scheduler's completion/catch-up logic won't run. Check the
   server logs and Settings → Advanced → System integrity check.
2. **Database is stale.** Check via SQLite directly:
   ```sh
   sqlite3 data/plekt.db "SELECT title, last_progress, completed_at FROM live_tracking_cache ORDER BY updated_at DESC LIMIT 10;"
   ```
3. **Frontend render bug.** `/api/now-playing` returns sessions but the grid stays
   empty → bug in `renderNowPlaying`/`setActiveSessions` (`public/app.js`).

See [now-playing.md](now-playing.md) for full diagnosis steps.

## "A watched event didn't record"

- Confirm the webhook reached Plekt with the correct `?token=` secret. The server
  logs every incoming webhook attempt and whether auth passed.
- Check `media.phase` was `completed` - a Plex `media.stop` below the watched
  threshold (90% by default) becomes
  `ended`, not `completed`. See the phase table in [webhooks.md](webhooks.md).
- Check `sync_history` and the watch record's `sync_dispatch_telemetry` for errors.

## "A watched item recorded but didn't sync to the other platforms"

- Look at `sync_history` and the record's `sync_dispatch_telemetry`.
  ```sh
  sqlite3 data/plekt.db "SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 10;"
  ```
- Check the target platform's client credentials (URL / API key / user ID).
- `status: skipped - No matching item found` is terminal for that target: Plekt does
  not retry an episode coordinate that is absent from the connected library every minute.
  Add the item and use **Retry Sync**, repeat the watched action, or let a later library
  history import reintroduce it. Timeout, connection, and HTTP errors remain retryable.
- Errors reading `Request timed out after 10000ms` mean the target server accepted
  the connection but did not answer within the outbound timeout - check that the
  media server is responsive and reachable from the Plekt host (backup
  destinations use a 60-second budget for uploads/downloads).
- Echo suppression: `loopStore` drops events that look like echoes of a recent
  dispatch - usually correct. If sync is double-firing, check loop keys:
  ```sh
  sqlite3 data/plekt.db "SELECT * FROM loop_keys WHERE expires_at > unixepoch('now', 'subsec') * 1000;"
  ```

## "Resume position didn't carry over"

Triggered on `ended` when `shouldSyncResumeProgress` is true and the source
provided `viewOffset`/`duration`. Check that Plex is sending lifecycle events
(`media.pause`, `media.stop`) with `viewOffset` and `duration` populated, and that
the position is over one minute (sub-minute positions are ignored to avoid noise).

## "Posters are missing / wrong"

Two-tier: frontend renders a `poster-fallback` then calls
`/api/poster?id=<watchRecordId>`. Backend tries candidates in order - stored URL →
configured server URL (Plex/Emby/Jellyfin) → TMDB - resizes with sharp, writes the
winner to `data/media/posters` or `data/media/backdrops`, and records metadata in
`poster_cache`.

Only `/media/posters/` and `/media/backdrops/` URLs are treated as "cached"
(`isCachedStorageImageUrl`); `image.tmdb.org` URLs are not.

## "Can't sign in / 401s everywhere"

- Verify credentials: `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars, or `data/config.json`.
- The session cookie `plembfin_session` must be present and unexpired (7-day TTL).
- If `COOKIE_SECURE=true` is set, the cookie is only sent over HTTPS. Accessing the
  app over HTTP will silently drop it.
- Retrieve the API key from `GET /api/auth/apikey` with a valid admin session, or
  inspect the configured `API_KEY` / generated value in `data/config.json`.
- If all sessions appear invalid, `sessionSecret` may have rotated (e.g. after
  "Revoke All Sessions"). Sign in again.

## "Webhook returns 401"

- The webhook secret is missing or wrong. Media-server setup usually uses the
  `?token=` URL from **Settings → Media servers → Webhooks**; automation can send
  `X-Plembfin-Webhook-Secret` or `Authorization: Bearer <secret>`.
- If you rotated the webhook secret ("Rotate Secret" button), all media servers need
  to be updated with the new URL or header value.

## "Scheduler / background sync not running"

- Check `GET /health`: `worker.available` must be true. In split mode, inspect the
  worker container/process rather than only the web process.
- Confirm every process uses the same local `DATA_DIR` and that no network filesystem
  is involved.
- Trigger it manually: `POST /api/cron-sync` with your API key - the response
  streams a line-by-line log.
- Watch the server stdout for `[cron]` log lines.

## "Settings or config not saving"

- Confirm `DATA_DIR` (`data/` by default) is writable.
- In Docker, confirm the volume is mounted: `docker exec plekt ls /data`.
- `data/config.json` must be writable for credential/secret persistence.

## "database disk image is malformed"

- Plekt only writes through better-sqlite3, so this means the file was damaged
  underneath SQLite, not by a Plekt query. The first large burst of writes (often the
  first Trakt sync on a fresh database) is where it surfaces, not what causes it.
- Docker Desktop on macOS or Windows with `/data` on a folder bind mount is the known
  cause (#38). Move `/data` to a named volume (`plekt-data:/data`) and restore a backup
  into it. Linux hosts are not affected.
- Never open either `plekt.db` or `plembfin.db` from the host (a `sqlite3` shell, a DB browser) while the
  container is running.

## "A media account connection fails or becomes invalid"

- Account setup is enabled by default. If it is missing, remove
  `PLEKT_MEDIA_AUTH_ENABLED=false` (or set it to `true`) and restart.
- Plex must be able to reach Plex account services and the selected server from the
  Plekt host. Emby/Jellyfin server URLs must also be reachable from that host.
- Jellyfin Quick Connect must be enabled on Jellyfin; otherwise use the account fallback.
- Managed tokens require the same `PLEKT_CREDENTIAL_KEY` or `data/credential.key` that
  encrypted them. Restore that key after a migration, then restart; reconnecting a provider
  also creates ciphertext for the current key.
- A 429 on a start/login request means too many account mutations were attempted from the
  same address. Read-only Plex/Jellyfin authorization polling does not consume this budget;
  wait for the `Retry-After` interval before starting another flow.

## "Trakt changes do not appear everywhere"

- Confirm Settings → Import shows Trakt connected, then choose **Sync Now**. Normal polling
  runs once a minute, so allow one full tick before treating it as missed.
- Disable/de-authorize the Emby and Jellyfin Trakt plugins. Two live Trakt writers can echo
  stale state back after Plekt has applied the user's action.
- Check Settings → Logs for Trakt authorization, pagination, match, or destination errors.
  A title absent from a media-server library is recorded locally and skipped only there.
- An open Plekt page should refresh through `/api/live-updates`. If it does not, verify
  the browser session is signed in and that a reverse proxy does not buffer streaming API
  responses; reloading once re-establishes the stream.

## "The Logs panel doesn't show enough detail"

Per-request tracing - Plex ID lookups, search fallbacks, and the per-phase narration of
each scheduled-sync run - is suppressed by default, because on a per-minute scheduler it
produces hundreds of lines an hour that describe routine no-op work. Errors and warnings
are always recorded.

Set `LOG_VERBOSE=true` and restart to include it while diagnosing a specific problem, then
turn it back off. A user-triggered catch-up run logs its per-phase steps to the job log
regardless of this flag.

Two related behaviours are worth knowing when reading a log:
- Repeated per-item skips are aggregated into one line with a count
  (`Emby: skipped 50 watched item(s) without a played date (…)`) rather than one line each.
- A scheduled run that changed nothing logs nothing. Silence between ticks is normal.

## "The data/logs directory is large"

`data/logs` holds two separate things:
- `access.log` - Morgan HTTP access log, rotated daily **and** at 10 MB, keeping 14 files.
  Successful static-asset, cached-artwork, and front-end poller requests are excluded, so
  it records meaningful traffic and errors rather than every poster fetch.
- `diagnostic-*.jsonl` - crash-forensics archive of captured console output, pruned on boot
  to the newest 20 files / last 7 days. Nothing reads these at runtime; the Logs panel is
  served from the `diagnostic_log` table.

Clearing the logs from Settings → Logs empties the table. The JSONL archive is managed only
by the boot-time prune, so deleting those files by hand is safe while the app is stopped.

## Tracing an unexpected watch, or an episode that will not match

When a watch looks unexpected, start with the show's **Info** export (the data behind
`/api/history-audit`) rather than the displayed timestamp alone. Compare these fields:

- `watch_provenance.source`, `ingest_path`, `event`, `phase`, `source_timestamp`,
  `captured_at`, `item_id`, `user`, `session_id`, `device`, and `client`.
- `sync_dispatch_telemetry`, then the `watch_audit_events` entries for `source_event`,
  `history_added`, `sync_dispatch`, and `sync_target`.
- A `source_event` from more than 90 days ago may have no payload: the audit row keeps its
  summary, but the payload was cleared by the retention prune. For a recent valid event, the raw
  provider body is replaced by a `trimmed` marker (`originalBytes`, `topLevelKeys`, `ids`). Only
  rejected events keep the full body. Check `watch_provenance` and the sync telemetry first.
- A `library_history` event with no session/device/client is a scheduled media-server
  library-state import, not proof that playback occurred. An `item.markplayed` event is an
  explicit played-state change; compare the raw server payload's played date and play count.
  A successful `200` target result confirms propagation, not that the source watch was valid.

Trace sync issues in this order:

1. `server/src/utils/recentWatchImport.js` (`syncRecentlyWatchedFromPlex`, `syncRecentlyWatchedFromEmby`,
   `syncRecentlyWatchedFromJellyfin`) and `server/src/utils/watchDates.js` for catch-up
   polling, source played dates, and API-marked items.
2. `server/src/routes/sync.js` and `server/src/utils/parsers.js` for webhook normalization,
   phases, and source-event handling.
3. `server/src/utils/syncOrchestrator.js`, `loopStore.js`, and `syncRoles.js` for target
   selection, outbound results, and echo-loop suppression. Use `docs/scheduled-sync.md`,
   `docs/webhooks.md`, and the relevant platform doc alongside the code. For a detail-page
   Force Sync (`server/src/utils/mediaForceSync.js`) or a manual watch-date edit
   (`propagateCorrectedWatchDate` in `server/src/routes/media.js`), the same
   `syncOrchestrator.js` functions do the outbound work; check `remoteItemToMedia`'s
   played-date handling first if a title was imported with an unexpected watched date.
4. `server/src/utils/watchAudit.js`, `server/src/routes/media.js` (`handleHistoryAudit`),
   and `server/src/utils/dataRepo.js` for the persisted audit trail, watch-history rows,
   playstate, and telemetry.

For episode queries, identity mismatches, or duplicate show episodes, check
`server/src/utils/dataRepo.js` first: `mediaKeyFor`, `findWatchedByAnyMediaKey`,
`queryShowDetail`, and `queryWatchHistory`. Then trace `handleShow`/`handleHistory` in
`server/src/routes/media.js`, the episode fetchers (`fetchPlexSeriesEpisodes`,
`fetchEmbySeriesEpisodes`, `fetchJellyfinSeriesEpisodes`) in the three platform clients,
and the renderer in `public/modules/media-detail-show.js`. Always compare title, show title,
season/episode coordinates, all provider IDs, and `media_key`; `mediaKeyFor` prefers IMDb,
then TMDB, then TVDB, while `findWatchedByAnyMediaKey` also checks alternate IDs and the
coordinate fallback.


## General: where do I look?

| Need | Place |
| --- | --- |
| What route handles X | `dispatch()` in `server/src/index.js` |
| Live server logs | stdout of `node server/server.js` (or `docker logs plekt`) |
| Captured log history | `diagnostic_log` table, or Settings → Logs |
| HTTP access log | `data/logs/access.log` |
| Database inspection | `sqlite3 data/plekt.db` |
| Run the background worker on demand | `POST /api/cron-sync` (streams a log) |
| Frontend debug logs | `logDebug(...)` calls throughout `public/app.js` (and the in-app Logs panel) |
| Which file owns a feature | The file map in [architecture.md](architecture.md) |
| Security controls | [security-checklist.md](security-checklist.md) |
