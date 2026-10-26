# Architecture flows

Server-wide runtime behaviour that no feature doc owns: how a request is served, logging, headers, rate limits, shutdown, environment variable conventions and the synchronization safety modules. The overview and routing table are in [architecture.md](architecture.md); files are described in the file map ([server](file-map-server.md), [public](file-map-public.md), [repository](file-map-repo.md)).

## Request flow

```
browser ──/api/whatever──▶ Express (server.js) ──▶ dispatch() (index.js) ──▶ handleX()
browser ──/health────────▶ Express ──▶ { ok: true, ts: <epoch> }  (no auth required)
browser ──/──────────────▶ Express ──▶ static public/ (SPA fallback → index.html)
browser ──/media/────────▶ Express ──▶ static data/media/ (cached artwork)
browser ──/changelog.json▶ Express ──▶ bundled changelog.json
```

1. `server.js` mounts the API router at `/api/*` and static-serves `public/` and
   `data/media`.
2. `dispatch()` (`server/src/index.js`) strips the `/api/` prefix and routes by
   path to a `handleX` function. The full route table is the body of `dispatch()`.
3. Auth: webhook routes use `verifyWebhookToken(token)` from
   `X-Plembfin-Webhook-Secret`, `Authorization: Bearer`, or the compatibility
   `?token=` URL param. All other protected routes call `requireAdmin(req, res)`, which accepts
   either a signed HttpOnly session cookie (`plembfin_session`) or an API key
   (`X-Api-Key` header / `Authorization: Bearer`).
4. Secrets stay server-side: `GET /api/config` returns each integration section
   with a `configured` boolean instead of the stored token/API key. A settings
   save that leaves a credential field blank keeps the stored value
   (`mergeIncomingConfig` in `configStore.js`); entering a new value replaces it.
   Test-connection endpoints fall back to the stored credential when the request
   body omits the token.
   The live Trakt connection ships a device application in the same model as the
   Jellyfin Trakt plugin. `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` can replace it for
   rotation or private deployment; the browser receives only an `appConfigured`
   capability flag. Application credentials are not copied into tracker connection,
   authentication-flow, or backup rows. A personal Trakt app entered through the
   advanced fallback is encrypted in SQLite.
5. Outbound HTTP: every server-side call to an external service goes through
   `fetchWithTimeout` (`server/src/utils/outbound.js`, configurable 10s default; backup
   transfers use 60s). The helper validates initial and redirected URLs, blocks
   cloud-metadata targets, and removes credentials from cross-origin redirects.
   The build check (`scripts/build-check.js`) fails on any bare `fetch(` outside
   that shared boundary.
   Plex HTTP requests send `X-Plex-Token` as a header rather than a query
   parameter so tokens stay out of access logs; the Plex notification WebSocket
   is the one exception because the handshake cannot carry custom headers.

## Access logging

Sensitive query parameters such as `token`, `api_key`, `secret`, and `password` are
redacted before request log formatting.

Morgan `combined`-format request logs are written to `data/logs/access.log`. The file
rotates daily and the last 14 days of logs are retained. Logs are never written to
stdout - only to the file - so container log streams stay clean.

## Security headers

The CSP keeps scripts and connections same-origin, allows local/TMDB/YouTube/Fanart.tv/
TheTVDB images, sets `frame-ancestors 'none'`, and permits YouTube embeds only in frames.

The `img-src` directive is extended dynamically at request time: `server.js` reads the
stored media config and appends the origins of any configured Plex, Emby, Jellyfin, and
Seerr server URLs to the whitelist. The computed origin list is memoized against the
`mediaConfig.updated_at` revision, so ordinary requests do not repeatedly parse and merge
the settings row while a settings save is visible on the next response. This ensures
artwork served directly by those servers (e.g. backdrop images) is not blocked by the CSP,
without permanently whitelisting arbitrary external origins.

Every response carries: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(),
geolocation=()`, and a `Content-Security-Policy` that allows frames only from YouTube.
`Strict-Transport-Security` is added when `COOKIE_SECURE=true`. `x-powered-by` is
suppressed. Eligible responses are gzip-compressed by the application when requested by the
client; the authenticated `text/event-stream` live-update response remains uncompressed and
is marked `no-transform`. Public asset cache headers are described under `httpPerformance.js`
in [file-map-server.md](file-map-server.md).

Startup runs `logSecuritySummary()` (in `appConfig.js`) which warns if the admin password
is still the default, or if any pinned secret is shorter than the minimum length. A
separate `[security]` warning is emitted if `COOKIE_SECURE` is not set, reminding
operators to enable it when the app is behind an HTTPS reverse proxy.

## Rate limiting

`server.js` applies express-rate-limit tiers before any route handler: `/api/login`
(10/15min), `/api/webhook` (60/min), TMDB image proxies (300/min), provider account/
tracker mutations (30/10min; read-only authorization polling is excluded), a list of
destructive/expensive admin actions (15/min, GET/HEAD/OPTIONS exempt so status polling
is never throttled), a general `/api` ceiling (1200/min), and a static-asset ceiling
(2000/min).

## Graceful shutdown

`server.js` registers `SIGTERM` and `SIGINT` handlers. On signal: the Plex notification
WebSocket listener is stopped, `server.close()` drains in-flight HTTP requests, then
`db.close()` flushes the WAL. A 5-second watchdog forces `exit(1)` if the drain hangs.

## Environment variables

The full table of supported variables, with defaults, is the
[Configuration Reference](../README.md#configuration-reference) in the README;
`.env.example` is the commented template. Conventions the table does not spell out:

- App-specific variables are named `PLEKT_<NAME>`. Every one is also read under its
  older `PLEMBFIN_<NAME>` name (the new name wins when both are set), through
  `brandEnv()` in `server/src/utils/brandEnv.js`; the server logs one line at boot
  listing any old names in use. New code reads these variables through `brandEnv()`,
  never `process.env.PLEKT_*` directly.
- `EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED`: Emby's and Jellyfin's per-item lookup,
  `findEpisode`, costs several outbound requests, so each checked batch is capped lower
  than Plex's, at `EMBY_LIKE_UNWATCHED_BATCH_SIZE = 5`, and records are checked
  sequentially rather than concurrently.
- `BUILD_CHANNEL` is `develop` in the `ghcr.io/lasikiewicz/plekt:develop` image, as well as
  `release` and `alpha` in the other images. It controls the channel metadata shown in the
  sidebar badge, About, and Changelog.

Environment variables act as **defaults** for connection and sync-tuning settings:
values saved in Settings (stored in the `settings` SQLite row) take precedence over
env values (`mergeEnvDefaults` in `configStore.js`).

## Synchronization safety modules

- `server/src/utils/forceSyncPlanner.js` collects read-only server state and builds typed, scoped Force Sync actions.
- `server/src/utils/libraryForceSync.js` powers the Settings library-wide Set Plekt as Source of Truth (push) and Import Watched Status (pull) operations.
- `server/src/utils/forceSyncExecutor.js` validates plan freshness, creates verified destructive-run snapshots, and executes confirmed actions.
- `server/src/utils/syncPlans.js` stores plan summaries/actions, confirmation state, snapshots, and retention.
- `server/src/utils/outboundGovernor.js` coordinates per-host pacing, lanes, cooldowns, and safe telemetry.
- `server/src/routes/maintenance.js` exposes `/api/health/sync`; `scripts/benchmark-sync.js` provides the repeatable planner benchmark, and `scripts/benchmark-surfaces.js` the server-side surface baseline.
- `docs/benchmarks/` holds committed benchmark output, so a result travels with the workload that produced it. Each file records the library scale, the hardware, and the spread across repeated runs.

`GET /api/health/sync` returns row counts, per-platform `matchFailures` with samples,
outbound governor telemetry, and a `dataQuality` block from `watchHistoryQualityCounts()`
in `dataRepo.js`:

| Field | Meaning |
| --- | --- |
| `sameEventDuplicateRows` | Rows restating a play already recorded for the same viewing within 10 minutes; these are excluded from displayed play history |
| `rewatchedItems` | Items with at least two retained actual viewing events after same-event echoes are removed; separate viewings are deliberately kept |
| `nullSeasonEpisodeRows` | Episode rows with no season number, which cannot match reliably for sync or count toward show progress |
| `opaqueShowTitleRows` | Rows storing a provider URI (`plex://…`) in `show_title`, so episode totals cannot be resolved |

Each non-zero count adds a plain-language entry to `recommendations`, so the data-quality
conditions are available in the application response as well as the server log.
