# Architecture

This document maps the application, explains how its components fit together, and links
each subsystem to its detailed source of truth.

## The big picture

Plekt is a **self-hosted Node.js app** in the style of Sonarr/Radarr/
Jellyseerr. One long-running `node server/server.js` process serves:

- the **web UI** - a plain ES-module SPA in `public/` with no framework, bundler, or build step
- the **API** - every route lives under `/api/*`, dispatched by one hand-written router
- the **scheduler** - an in-process `setInterval` tick that runs sync work every minute

All state lives in a local **SQLite** database (`data/plekt.db`, or `data/plembfin.db` on
installs that predate the rename and already have one; WAL mode) and a local
media folder (`data/media/`). There is no external database, no cloud functions, and no
separate production environment.

What the app does: it receives play/stop/scrobble **webhooks** from Plex, Emby, and
Jellyfin, records watch history, and **propagates watched/unwatched state and resume
progress to the other platforms** so all three stay in sync. On top of that it provides
a dashboard (Now Playing + recent history), Movies/TV Shows library browsers, a stats
page, an upcoming-episodes calendar, rich media detail pages (TMDB/TVDB metadata,
cast, trailers, artwork), Jellyseerr/Overseerr requesting, and a backup system.
Personal ratings are a separate optional domain: Plekt remains their local
canonical store, while a durable rating queue can exchange ratings with Plex, Emby,
Jellyfin, and Trakt without entering the watched-state pipeline.
Personal watchlist membership is another isolated domain: `personal_watchlist` is the
canonical present-set, while provider-specific observations, tombstones, queues, and
complete-snapshot runs drive safe projections to Plex, Emby, and Jellyfin.

### Performance-sensitive page loading

The SPA keeps secondary data out of the first paint. Upcoming starts with the
current month and one either side, then extends the calendar a month at a time
as the user scrolls toward either end of the loaded range; search results
are cached in the session and stale searches cannot replace newer ones; person
filmography watch-state data loads after the profile shell. Logs and changelog
history retain complete source data for export and refresh, but render a bounded
initial view. Preserve these loading, stale-request, and retry guards when adding
new metadata requests.

## Subsystem map

| Area | Files | Source |
| --- | --- | --- |
| API routing | `server/src/index.js` (`dispatch()` route table) plus the owning `server/src/routes/*.js` module | this doc |
| Webhook parsing or phases | `server/src/utils/parsers.js`, `handleWebhook` in `server/src/routes/sync.js` | [webhooks.md](webhooks.md) |
| Watched/unwatched propagation between platforms | `server/src/utils/syncOrchestrator.js`, platform clients | [webhooks.md](webhooks.md) |
| Per-provider historical watched-sync policy and outcomes | `server/src/utils/watchSyncPolicy.js`, `public/modules/plex-history-policy.js` | [settings.md](settings.md), [decisions.md](decisions.md) |
| Plex API calls, Plex WebSocket listener | `server/src/utils/plexClient.js`, `plexNotificationListener.js` | [plex.md](plex.md) |
| Emby API calls | `server/src/utils/embyClient.js` | [emby.md](emby.md) |
| Jellyfin API calls | `server/src/utils/jellyfinClient.js` | [jellyfin.md](jellyfin.md) |
| Background/scheduled sync, catch-up sync, provider Up Next feeds | `server/src/scheduler.js`, `server/src/scheduled.js`, `server/src/utils/upNextRepository.js` | [scheduled-sync.md](scheduled-sync.md) |
| Now Playing (dashboard live sessions) | `handleNowPlaying` in `server/src/routes/sync.js`, `server/src/utils/liveSessions.js`, `liveSessionPoller.js`, `activeSessions.js`, `public/modules/sync.js` | [now-playing.md](now-playing.md) |
| Dashboard rendering | `public/modules/dashboard.js` | [dashboard.md](dashboard.md) |
| Up Next queue, provider push, dismissals | `public/modules/up-next.js`, `server/src/utils/upNextService.js`, `upNextProviderSync.js`, `upNextRailSeed.js`, `upNextSeedLedger.js`, `upNextDismissals.js`, `upNextLibraryLookup.js` | [dashboard.md](dashboard.md) |
| Settings changelog channels | `public/modules/changelog-channels.js`, `handleChangelog` in `routes/maintenance.js` | this document |
| Sidebar sync indicator, Sync Activity page | `public/modules/status-indicators.js`, `public/modules/sync-activity.js`, `handleSyncHistory` / `handleSyncActivity` in `routes/sync.js` | [dashboard.md](dashboard.md) |
| Movies library page | `public/modules/explorer.js`, `queryMovies` in `dataRepo.js` | [movies.md](movies.md) |
| TV Shows library page | `public/modules/explorer.js`, `queryShows`, `showProgressCache.js`, `nextAiringCache.js` | [tv-shows.md](tv-shows.md) |
| Upcoming episode calendar | `public/modules/upcoming.js`, `handleUpcoming` in `routes/metadata.js`, `upcomingCalendarCache.js`, `nextAiringCache.js` | [upcoming.md](upcoming.md) |
| Movie/show/person detail pages | `public/modules/media-detail*.js`, `media-person.js` | [media-detail.md](media-detail.md) |
| Personal media pages | `public/modules/personal-media.js`, `public/modules/playlists.js`, `public/modules/personal-media-metadata.js`, `handlePersonalMedia` in `routes/personal.js` | [frontend.md](frontend.md) |
| Personal rating sync | `server/src/utils/personalRatingSync.js`, `personalRatingRepository.js`, provider clients, `public/modules/rating-sync-settings.js` | [personal-ratings.md](personal-ratings.md) |
| Rating snapshot validation | `server/src/utils/ratingSnapshotSafety.js` validates provider response shape and page completeness before missing-rating reconciliation | [personal-ratings.md](personal-ratings.md) |
| Plex watchlist sync | `server/src/utils/personalWatchlistSync.js`, `plexWatchlistClient.js`, `routes/watchlistSync.js`, `public/modules/watchlist-sync-settings.js` | this document, [personal-watchlist.md](personal-watchlist.md) |
| History page, Search page | `public/modules/explorer.js`, `handleHistory` in `routes/media.js`, `handleMediaSearch` in `routes/metadata.js` | [history-search.md](history-search.md) |
| Stats page | `public/modules/stats.js`, `getWatchStats` in `dataRepo.js` | [stats.md](stats.md) |
| TMDB/TVDB/Fanart/OMDb metadata | `server/src/routes/metadata.js`, `server/src/utils/tmdbGateway.js`, `tvdbGateway.js`, `fanartGateway.js`, `omdbGateway.js` | [metadata.md](metadata.md) |
| Posters, backdrops, logos, artwork caching | `server/src/utils/posterCache.js`, `server/src/utils/mediaArtwork.js`, `routes/seasonArtwork.js`, `handlePoster` in `routes/metadata.js`, `public/modules/images.js`, `public/modules/season-posters-panel.js` | [posters-artwork.md](posters-artwork.md), [media-detail.md](media-detail.md) |
| Backups (all three subsystems) | `server/src/routes/backups.js`, `server/src/utils/backup.js`, `watchHistoryBackups.js`, `plektBackups.js`, `plektRestore.js`, `server/src/routes/plektRestore.js`, `backupDestinations/`, `public/modules/tools-backups.js` | [backups.md](backups.md) |
| Settings pages, connection config | `server/src/routes/admin.js`, `server/src/utils/configStore.js`, `public/modules/settings-shell.js`, `public/modules/settings-ui.js`, `public/modules/settings-services.js`, `public/modules/rating-sync-settings.js`, `public/modules/tools-backups.js` | [settings.md](settings.md) |
| Login, sessions, API key, webhook secret | `server/src/utils/auth.js`, `server/src/appConfig.js`, `public/modules/auth.js` | [auth.md](auth.md) |
| Pristine-install account claim, guided `/setup` wizard, dashboard checklist | `server/src/routes/onboarding.js`, `server/src/utils/onboardingStore.js`, `onboardingImportCoordinator.js`, `public/modules/onboarding.js` | [onboarding.md](onboarding.md) |
| SPA routing, view switching, module layout | `public/app.js`, `public/modules/state.js`, `app-events.js` | [frontend.md](frontend.md) |
| Database tables and their meaning | `server/src/schema.sql`, `server/src/db.js` | [sqlite-schema.md](sqlite-schema.md) |
| Build check, CI, Docker, release/changelog pipeline | `scripts/`, `.github/workflows/`, `Dockerfile` | [development.md](development.md) |
| Production security posture | - | [hardening.md](hardening.md), [security-checklist.md](security-checklist.md) |
| "Something is broken, where do I look?" | - | [troubleshooting.md](troubleshooting.md) |

Frontend module placement rules, file-size limits, module ownership, and dependency
direction are defined in [frontend.md](frontend.md).

## Complete file map

Repository files relevant to the application, build, and operations, grouped by directory.

### Repository root

| File | What it is |
| --- | --- |
| `README.md` | User-facing GitHub readme: features, setup guide, configuration reference, screenshots. |
| `changelog.json` | Bundled release history. `scripts/promote-alpha-to-main.js` appends an entry and bumps the version locally, as part of "Force to main"; served verbatim at `GET /changelog.json` and consumed by the in-app changelog/update check. |
| `package.json` | Dependencies and npm scripts (`start`, `dev`, `test`, `build`, `docs:check`, `demo:verify`, `seed:demo`, `prepare`). Version is set locally by `scripts/promote-alpha-to-main.js` as part of "Force to main". |
| `package-lock.json` | Locked dependency tree. Version field is CI-managed alongside `package.json`. |
| `Dockerfile` | `node:25-trixie-slim` image: installs prod deps, copies `server/`, `public/`, `changelog.json`, creates the non-root `plekt` user, and uses the separate SQLite worker-health probe so synchronous maintenance cannot make the container fail its HTTP healthcheck. |
| `docker-compose.yml` | Published-image quick-start: port 5056, `./data:/data`, required admin password from `.env`. |
| `docker-compose.dev.yml` | Local source-build overlay with local image, optional Trakt credentials and resource limits. |
| `docker-compose.secure.yml` | Hardened overlay: read-only rootfs, tmpfs `/tmp`, required env vars (`ADMIN_PASSWORD`, `SESSION_SECRET`, `API_KEY`, `WEBHOOK_SECRET`), forces `COOKIE_SECURE=true`. |
| `.dockerignore` | Excludes `node_modules`, `data`, `docs`, `scratch`, markdown, and secrets from the Docker build context while whitelisting the required runtime scripts. |
| `.env.example` | Commented template of every supported environment variable - copy to `.env` (loaded by `server/src/env.js`). The variables are documented under [Environment variables](#environment-variables) below. |
| `website/` | Static Astro documentation site. Its build reads the root release data and shared assets, runs the website checks, and outputs `website/dist/` for Cloudflare Pages. |
| `.editorconfig` | Editor whitespace/indent conventions. |
| `.gitattributes` | Normalizes line endings to LF; marks image formats binary. |
| `.gitignore` | Ignores `node_modules`, `data/`, logs, local env files. |
| `.githooks/commit-msg`, `.githooks/pre-push` | Git hooks installed by `scripts/install-git-hooks.js`: release commit messages must contain meaningful changelog bullets; a same-name push merges `origin/<current-branch>` first, a push to `develop` validates its committed changelog with `rebuild-develop-changelog.js --check`, and every push runs `npm run build`. Cross-ref pushes skip the sync step because their branch state was reconciled by the promotion workflow. |
| `.claude/skills/` | Repository-local release, publishing, and local-development procedures referenced by `CLAUDE.md`, including the `push-website-live` and `start-website` website workflows. |
| `LICENSE.md` | Project license. |
| `SECURITY.md` | Vulnerability reporting policy. |
| `CONTRIBUTING.md` | Contribution guidelines. |
| `CODE_OF_CONDUCT.md` | Community code of conduct. |

### `.github/`

| File | What it is |
| --- | --- |
| `workflows/update-changelog.yml` (workflow name "Publish Main Release") | On every push to `main`: runs the full build gate, reads the version already committed by "Force to main" (`scripts/promote-alpha-to-main.js`, run locally before the push), builds/pushes a multi-architecture Docker image to GHCR tagged `latest` + the version, creates or updates the matching formatted GitHub Release through `scripts/publish-github-release.js`, then deploys the exact version tag to the OCI-hosted public demo and verifies it. Does not write anything back to the branch. |
| `workflows/docker-publish-alpha.yml`, `workflows/docker-publish-develop.yml` | The same shape for `alpha`/`develop`: verify, then build/push a rolling image (`alpha`/`alpha-<build>`, `develop`/`develop-<build>`) using the build number already committed by "Force to alpha" / "Push to git". Alpha also creates or updates its matching numbered GitHub prerelease with generated notes. Neither writes anything back to its branch. `docker-publish-develop.yml` has `paths-ignore` for `changelog.develop.json`/`changelog.alpha.json`, since "Force to alpha" step 4 pushes to `develop` with only those two files changed - the app's own live remote-fetch changelog comparison reads that file straight from GitHub regardless of whether a new image was built, so that push was never meant to also trigger a full rebuild. |
| `workflows/docker-publish.yml` | Manual (`workflow_dispatch`) Docker build & push to GHCR, without touching the changelog. |
| `workflows/security.yml` | `npm audit` (high+) and CodeQL on push/PR/daily schedule. |
| `workflows/secret-scan.yml` | TruffleHog verified-secret scan on push/PR. |
| `dependabot.yml` | Automated dependency update PRs. |
| `ISSUE_TEMPLATE/bug_report.md`, `ISSUE_TEMPLATE/feature_request.md`, `ISSUE_TEMPLATE/config.yml` | GitHub issue forms. |
| `PULL_REQUEST_TEMPLATE.md` | PR description template. |

### `docs/`

See [README.md](README.md) for the documentation index, including this file
(`architecture.md`) and the per-feature sources of truth.
`decisions.md` records why the non-obvious design and release-pipeline calls were made,
and what was rejected; the feature docs describe current behavior, so read `decisions.md`
before reversing something that looks unnecessarily cautious.
`docs/screenshots/` holds the PNG screenshots embedded in the root README (`bio.png`,
`history.png`, `media.png`, `movies.png`, `now-playing.png`, `part-watched.png`,
`search.png`, `stats.png`, `tvshows.png`).

### `server/`

| File | What it is |
| --- | --- |
| `server.js` | **Process entrypoint.** Express app: access logging (rotating `data/logs/access.log`, secrets redacted), security headers + dynamic CSP, rate limiters, raw-body capture for `/api/*` → `dispatch()`, static mounts for `/media` and `public/`, `/health`, `/changelog.json`, SPA fallback, the per-minute scheduler tick, the Plex notification listener startup, and graceful shutdown. |
| `src/index.js` | **The API router.** `dispatch()` strips `/api/` and routes paths to `handleX` functions exported by `src/routes/*.js`. The full route table is the body of `dispatch()`; feature behavior belongs in the owning route module. |
| `src/db.js` | Opens `data/plekt.db` (or existing `data/plembfin.db`) via better-sqlite3 (WAL), applies concurrency-safe migrations, and exposes helpers plus the SQLite-backed cache version observed by every process. |
| `src/schema.sql` | Authoritative table definitions. See [sqlite-schema.md](sqlite-schema.md). |
| `src/appConfig.js` | Resolves admin credentials + secrets from env / `data/config.json` (scrypt password hash, generated API key / webhook secret / session secret), warns about insecure config at startup, exports `AUTH`, `verifyWebhookToken`, `rotateWebhookSecret`, `updateAdminCredentials`. |
| `src/env.js` | Minimal `.env` loader (`loadLocalEnv`) - parses `<repo>/.env` without a dotenv dependency; env vars already set take precedence. |
| `src/paths.js` | Resolves `DATA_DIR` and every path under it (`MEDIA_DIR`, `POSTERS_DIR`, `BACKDROPS_DIR`, `PROFILES_DIR`, backup dirs, `DB_PATH`, `CONFIG_PATH`, `PUBLIC_DIR`); `ensureDataDirs()` creates them. |
| `src/scheduled.js` | The background sync engine: live-session polling → `live_tracking_cache`, completed-session detection, resume-progress replication, per-platform catch-up sync (recently watched + resumable + provider Up Next feeds), Plekt-canonical dispatch/reconciliation queue, Plex drift repair, `runScheduledSync` and `runForceSync`. See [scheduled-sync.md](scheduled-sync.md). |
| `src/scheduler.js` | Scheduler wrapper and Plex notification listener lifecycle: per-minute tick orchestration, scheduled backup runs, watchlist/rating worker hooks, cache-backed metadata warm-up/backfill, next-airing cache refresh, startup/shutdown listener control, and Plex library-item unwatch callback. |

### `server/src/routes/`

| File | What it is |
| --- | --- |
| `admin.js` | Settings/admin API handlers: config, appearance, Seerr/app links, connection tests, and Plex notification probe. |
| `backups.js` | Backup API handlers for portable import/export (`/api/import`, `/api/backup/export`, `/api/backup/import`), encrypted full backups (`/api/plekt-backups`), and watch-history backup actions (`/api/watch-backups`). |
| `media.js` | Library and history handlers: history, movies, shows/show detail, delete/update watch records, show and season artwork saves, transactional show rematching, merge shows, full watchstate replay, and missing-telemetry clearing. |
| `seasonArtwork.js` | Saved season-poster lookup and per-season TMDB, TVDB, and fanart.tv options for Edit Images. |
| `metadata.js` | Poster proxy and metadata/search handlers: TMDB details/search/season/images/person/poster/profile, the remote-artwork caching proxy, TVDB search/images, Fanart images, media search, Discover feeds and recommendation exclusions, Upcoming episodes, cached Up Next, YouTube metadata, and OMDb ratings. |
| `sync.js` | Sync/runtime handlers: webhook ingestion, manual watch/unwatch, playback progress, retry sync, sync job/history listing, Now Playing, active sessions, cron sync, library-wide planner Force Sync, Settings library Force Sync modes and status polling, title-scoped detail-page Force Sync modes and status polling, and stop-force-sync. |
| `ratingSync.js` | Authenticated personal-rating status, snapshot, local-push, and retry actions. |
| `watchlistSync.js` | Authenticated personal-watchlist status, reconcile/retry actions, compatibility preview endpoint, and paged activity. |
| `maintenance.js` | Maintenance/admin utility handlers: ping, changelog/update check, diagnostic logs, cross-platform match reporting, backfill/repair/dedup/rematch, cache stats, cache clearing, plus the read-only `episode-title-audit` and `episode-title-backfill` Database Repairs endpoints that restore real episode names onto watch rows that only stored a coordinate. |
| `wipeData.js` | Wipe data handlers (`GET /api/wipe-data/preview`, `POST /api/wipe-data`): Watch History, Personal Watchlist, Sync History & Logs, Everything Tracked, and Wipe All / Fresh Start (also clears every remaining table, deletes cached artwork, and resets `data/config.json` via `appConfig.js`'s `resetAdminAccount()`). Kept separate from `maintenance.js`, which is already near its size limit. |
| `playstateAliases.js` | Watch-State Aliases card (`GET /api/playstate-aliases`, `POST /api/playstate-aliases/fold`, `POST /api/playstate-aliases/dismiss`), admin-only, disabled in the demo. Logic in `utils/playstateAliasReview.js`. |
| `webhookPort.js` | Webhook port diagnostics (`GET /api/webhook-port/status`), admin-only, disabled in the demo. Logic in `utils/webhookPortCheck.js`; findings are logged at startup. |
| `mediaAuth.js` | Browser-session-only Plex account, Emby account, and Jellyfin Quick Connect/account flows; verifies identities and persists encrypted managed connections. |
| `trackerAuth.js` | Trakt device authorization, initial-state policy, connection status/disconnect, and manual tracker synchronization. |
| `liveUpdates.js` | Authenticated streaming endpoint that emits shared history, Up Next-cache, and Discover-cache version changes so open pages refresh as local state or feed snapshots change. The history version it reports is the sum of the watch-history and resume-position generations, so a page still sees a resume position move even though that write no longer invalidates any derived cache. |
| `onboarding.js` | Guided-setup API: aggregated `/api/setup/status`, step/acknowledgement persistence, background-import start/cancel, completion, restart, and checklist dismissal. |

### `server/src/utils/`

| File | What it is |
| --- | --- |
| `dataRepo.js` | **The data repository** - pure SQLite. All prepared-statement CRUD for watch history, playstate, playback progress, live tracking cache; the memoized derived caches (`getCachedHistory/Movies/Shows`, `getWatchStats`); canonical show-poster enrichment; `mediaKeyFor` canonical keys; query functions behind `/api/history`, `/api/movies`, `/api/shows`, `/api/show`; dedup/merge/rematch/backfill helpers. |
| `parsers.js` | Webhook normalization: `parsePlexWebhook` (multipart), `parseEmbyWebhook`, `parseJellyfinWebhook`, `parseCustomWebhook` → a unified `media` object with a `phase` field (`active`/`completed`/`ended`/`unplayed`/`ignored`). Also `parsePlexGuids`, `normalizeProviderIds`, `decodeHtmlEntities`, `buildPlexMediaFromMetadata`. See [webhooks.md](webhooks.md). |
| `resumeAuthority.js` | Shared ordering rules for resume candidates versus canonical watched/unwatched state: same-position acknowledgement matching, reliable source/receipt timestamps, stored-progress deletion authority, and Emby/Jellyfin ambiguous `UserDataSaved` phase resolution. |
| `syncOrchestrator.js` | Cross-platform propagation: `syncMediaPlaystate` / `syncMediaUnplayedPlaystate` / `syncMediaProgress` fan out normal events to the other platforms' clients, while `syncCanonicalPlaystate` replays Plekt's state to every configured destination; all use `TARGETS_BY_SOURCE` routing, echo-loop detection via `loopStore.checkAndClaim`, and result summaries written to telemetry. |
| `watchSyncPolicy.js` | The provider matrix for one outgoing watched action: resolves its explicit intent (`live`, `manual`, `historical`, `import`, `restore`), decides per target whether to `send`, and names the terminal outcomes (`sent`, `already_matching`, `skipped_by_policy`, `unsupported`, `failed`). Owns the canonical play date Emby and Jellyfin receive, and the Plex-only historical-sync policy enforced by both `syncOrchestrator.js` and `markPlexPlayed`. Imports `tuning.js` only, so any provider adapter can enforce the matrix. |
| `personalRatingIdentity.js` | Normalizes movie/show/episode rating identity; episode keys use parent show identity plus season/episode while retaining leaf provider IDs for writes. |
| `personalRatingRepository.js` | SQLite repository for canonical rating source observations, latest-intent queue rows, provider echo markers, and per-provider sync runs. |
| `personalRatingSync.js` | Optional two-way personal-rating snapshots, Plekt-authoritative conflict handling, validated complete-snapshot clears with persistent mass-removal review, durable queue delivery, retries, and the independent scheduler hook. |
| `personalWatchlistIdentity.js` | Canonical movie/TV watchlist identity and provider/title aliases; episode rows are intentionally excluded from the first watchlist release. |
| `personalWatchlistRepository.js` | Canonical watchlist mutations/tombstones, provider ownership ledger, durable queue, sync runs, activity, restore gate, and completed-watch removal hook. |
| `personalWatchlistSync.js` | Bounded provider snapshots, safe first-run union, complete-snapshot removal safety, provider-addition fanout, owned-container cleanup, queue delivery, retries, and scheduler integration. |
| `playlistSyncTriggers.js` | Playlist sync triggers: debounced per-playlist `syncPlaylist` after Plekt edits (worker-capable processes only, app-targeted playlists only) and the 5-minute scheduled `syncAllPlaylists` pass, the only pass that counts toward an app-side deletion. Engines: `playlistPushEngine.js`, `playlistPullEngine.js` (plan: `plan/archive/custom-playlist-sync/plan.md`). |
| `upNextIdentity.js` | Shared Up Next identity normalizer and deterministic ordering/merge rules: verified movie IDs, provider-series-plus-SxxExx episode keys, native-ID fallbacks, source-ID preservation, and resume-over-next-up reconciliation. |
| `upNextRepository.js` | Generation-based SQLite source ledger for provider Resume/Continue Watching/Next Up feeds. Activates only complete snapshots, preserves last-good rows on failures, exposes redacted feed status, and advances `up_next` invalidation when active source content changes. |
| `upNextService.js` | Builds the unified dashboard projection from canonical local resume/playstate, provider observations, and bounded released-episode metadata fallback; emits stable public queue items without raw provider payloads. |
| `upNextAutoSync.js` | Queues coalesced, durable worker pushes when the unified Up Next projection changes, fingerprints the last successful queue, and reruns once when a queue mutation lands during a push. |
| `upNextLibraryLookup.js` | Shared Up Next media-descriptor builder and cached Plex/Emby/Jellyfin library resolution. Lets the projection prove an unwatched next episode exists in a real library, and lets the authoritative push resolve the item it needs to add. |
| `upNextRailSeed.js` | Clear-only compatibility migration for 6%-of-runtime positions written by older builds. Current Up Next pushes refresh Plex Continue Watching, Emby Continue Watching (Resume), and Jellyfin Next Up from verified watched predecessors without writing synthetic progress. |
| `providerItemIds.js` | Resolves a media object's native ids for one provider, refusing a bare `provider_item_id` that belongs to a different one. Prevents an outbound write landing on an unrelated title. |
| `upNextDismissals.js` | Server-side Up Next dismissals: alias plus coordinate identity, projection filter, and restore. Replaces the browser-local map; see `docs/decisions.md` entry 23. |
| `recommendationExclusions.js` | Server-side movie/TV exclusions for the personalized Discover recommendation rail, including identity normalization, bounded persistence, and recommendation filtering. |
| `upNextSeedLedger.js` | Legacy ledger for identifying and suppressing positions written by older native-rail seed builds while they are migrated out. |
| `providerPlaylists.js` | Uniform Plex/Emby/Jellyfin playlist client for Plekt playlist sync (list, read, create, add, remove, move, rename, delete) plus minimal-move order reconcile (entries already in relative order stay put) and a `rebuild` mode that moves each entry to the end; the push re-reads Plex after moving, because Plex answered some moves between two entries with success yet ignored them, rebuilds once on a mismatch, and stores the order the app reports. Only a definite 404 counts as not-found; other read failures throw. Backed by `plexPlaylists.js` and `embyLikePlaylists.js`. Not yet wired to any route or job (`plan/archive/custom-playlist-sync/plan.md`). |
| `playlistRuleCatalogue.js` | Library catalogue read for automatic playlists: every movie and show each connected app holds, with genres (Plex read per genre), year, added date, rating, and ids; cached per app for 50 minutes; any failed page is an unreadable app, never a partial library. Also the merged genre list (`genreKey`, TMDB genre ids) behind the `list-rule-genres` action (`plan/archive/custom-playlist-sync/step8-auto-playlists.md`). |
| `playlistWatched.js` | Watch index for playlists (trusted `watch_history` rows with watch times, furthest watched episode per show) and "Remove items once watched" (`personal_lists.remove_watched`): items watched after they were added are removed on every 5-minute playlist pass and before each rule check; an automatic playlist also records the title in `personal_list_handoffs` so the rule never adds it back (a TV show then carries on in Up Next). `handOffAutomaticPlaylistItem` does the same for a title removed by hand from an automatic playlist (the whole show for TV). |
| `playlistRuleEngine.js` | Automatic playlist rules: validation, evaluation (a type picks up to the maximum titles in its ranking, then any order but Ranked re-sorts them: Top rated, Popular, and New releases from TMDB Discover, Trending from TMDB's weekly trending list filtered locally; the library source ranks your titles by the apps' rating for Top rated, or by their place on the same TMDB list for the others; library source from the catalogue above (titles merged across apps by shared id; a title its app has not matched to any id is left out until it is), catalogue source from TMDB, watched state from `watch_history`, TV rules hold one episode per show: the next one to watch, read from TMDB season by season for the catalogue source; shows and movies handed off by "Remove items once watched" stay out; a Language choice keeps titles whose TMDB original language is ticked, read for library titles by `playlistLanguages.js` from the `tmdb_metadata_cache.original_language` column filled when metadata is imported, a title with no language left out), the whole-update hold for large removals (an episode replaced by its own show's next one does not count), the hourly check run from the scheduled playlist pass (which also re-checks, at that pass, a playlist with "Remove items once watched" off whose show was watched, so it moves on to its next episode), and Stop updating. A failed read never changes the items. |
| `playlistLanguages.js` | Original language of each library title for automatic playlist rules: read from the metadata cache's `original_language` column (blob fallback for restored rows); only a title with no cached details is looked up through the TMDB gateway (lane `sync`); no TMDB match reads as unknown, any other failed lookup throws. |
| `playlistPushEngine.js` | Push half of Plekt playlist sync: per targeted app, resolves items (series expanded minus exclusions), reconciles the app playlist to Plekt's order, writes the entry ledger and `personal_list_item_availability`, deletes deselected or soft-deleted apps' playlists. Removes only what Plekt no longer wants; failed lookups, app-added entries, and entries removed in the app are left for the pull pass. Not yet wired to any route or job (`plan/archive/custom-playlist-sync/plan.md`). |
| `plexWatchlistClient.js` | Plex account-level Universal Watchlist adapter with native read/write capability probing and RSS read-only fallback. |
| `traktAppConfig.js` | Supplies the bundled Plekt Trakt device application, applies optional `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` overrides, validates the personal-app fallback, and hydrates runtime requests without persisting application credentials in tracker records. |
| `credentialVault.js` | AES-256-GCM envelope for provider credentials, backed by `PLEKT_CREDENTIAL_KEY` or the generated `data/credential.key`. |
| `mediaConnectionRepo.js` | CRUD and runtime adaptation for encrypted Plex/Emby/Jellyfin account connections. |
| `embyLikeAuth.js` | Emby/Jellyfin authentication exchange and verified user identity helpers. |
| `plexAuth.js` | Plex PIN authorization, account verification, resource discovery, and server selection. |
| `plexFetch.js` | Plex-account HTTP boundary with Plex client identity headers and structured failures. |
| `plexTokenManager.js` | Managed Plex account/server-token validity checks and refresh/recovery. |
| `trackerConnectionRepo.js` | Encrypted tracker connection and expiring device-flow persistence. |
| `onboardingStore.js` | `accountClaimed`/onboarding progress persisted in its own `settings` row; the atomic (SQLite immediate-transaction) account-claim check-and-write; pristine-vs-upgraded install detection. |
| `onboardingImportCoordinator.js` | Starts/cancels the safe, additive background pulls onboarding offers per media server (`forceSyncLibraryState({mode:"pull"})`) and for Trakt (`pollConnectedTrackers`), tracking progress in the onboarding state without taking the global force-sync lock. |
| `rateLimit.js` | Minimal in-memory sliding-window rate limiter shared by `/api/login` and `/api/auth/claim`. |
| `trackerDispatcher.js` | Sends canonical watched/unwatched/rewatch changes to active trackers with echo suppression. Trakt's history is a play log with no update semantics - `POST /sync/history` only ever adds a play - so a canonical replay (`source: "manual"`, e.g. Force Sync or a watched-date correction) first removes any existing Trakt plays for that item before adding the corrected one, instead of stacking a duplicate. A genuine watch reported by a media server still just adds. |
| `trackerSync.js` | Compares complete Trakt watched snapshots with stored tracker state and feeds additions, removals, and changed timestamps into canonical transitions. A large, simultaneous drop in one show's episodes (Trakt returning a rate-limited or truncated but still well-formed watched-progress response) is held back rather than trusted as a real unwatch - it only propagates once the same episodes are still missing on a second consecutive poll (`partitionSuspiciousUnwatches`, `SUSPICIOUS_SHOW_DROP_MIN_COUNT`/`_FRACTION`). |
| `traktClient.js` | Trakt device OAuth, refresh, paged watched-history reads, watched-history write client, and personal rating snapshot/write adapter. |
| `watchStateTransitions.js` | Shared transactional watched/unwatched transition boundary used by tracker and media-server inputs. |
| `syncMatchReport.js` | Pure aggregation of current watch-history telemetry into per-platform unmatched-media counts, movie/episode splits, and bounded samples used by Sync Activity's unresolved-match issue view. |
| `mediaForceSync.js` | Detail-page Force Sync: title-scoped Plex/Emby/Jellyfin watched-state lookup, Set Plekt as Source of Truth (push)/Import Watched Status (pull) modes, explicit import of remote-only records on pull, provenance/telemetry, and target-filtered canonical propagation. A remote item whose played flag has no reliable played date is skipped rather than imported with a fabricated current-time date. The modal's separate Push Personal Rating action uses `ratingSync/push` and does not enter this watched-state worker. The library-wide Force Sync planner remains remote-only-safe. Items are processed with bounded concurrency (`runWithConcurrency` in `concurrency.js`) so a show with many seasons doesn't sync one episode at a time. An all-destinations push completes the local media-server phase first and then drains a separate two-item Trakt phase, merging both phases into one final result and preserving each canonical remove/add pair during cancellation. |
| `libraryForceSync.js` | Settings Force Sync: library-wide push (Set Plekt as Source of Truth)/pull (Import Watched Status) operations, remote watched-state collection, and target-filtered canonical propagation. Also processes items and resume positions with bounded concurrency. |
| `concurrency.js` | `runWithConcurrency(items, handler, limit)` - a small bounded worker pool used by Force Sync to process multiple items at once. Safe to raise: outbound HTTP calls are still throttled per host by the outbound governor (`outboundGovernor.js`), so this only shortens wall-clock time. |
| `mediaForceSyncActivity.js` | Bounded in-memory activity ledger used by the detail-page and Settings Force Sync status/cancellation endpoints to stream operation lines, cancellation state, and final results to the UI. |
| `tuning.js` | Import-free runtime accessors for watched threshold, minimum resume position, active-session TTL, outbound timeout, and the app-marked watched-flag policy; reads environment defaults and applies validated Settings overrides. |
| `manualWatchReview.js` | Durable deduplicated queue for provider watched flags that require an administrator decision, including safe media snapshots and review status. |
| `plexClient.js` | Plex HTTP client: find items by GUID/title, mark played/unplayed, set resume progress, fetch watched/resumable/account-scoped Continue Watching/metadata/episodes, and read/write personal ratings; username→accountID resolution with memoization. Token always sent as `X-Plex-Token` header. See [plex.md](plex.md). |
| `plexNotificationListener.js` | Plex real-time WebSocket listener (`/:/websockets/notifications`): detects watched/unwatched changes the webhook can never deliver, reconnects with backoff, debounces per ratingKey; also recognizes the `playing` notification type to poke the live session poller (see `liveSessionPoller.js`) the instant a session's state changes; plus `probePlexNotificationSocket` for the System Integrity Check. |
| `embyClient.js` | Emby HTTP client (same operation set as Plex client, `X-Emby-Token` auth, provider-ID `AnyProviderIdEquals` lookups), including user-scoped Resume/Next Up feeds and personal rating snapshots/writes. See [emby.md](emby.md). |
| `jellyfinClient.js` | Jellyfin HTTP client (same shape as Emby client; uses the modern `Authorization: MediaBrowser ... Token="..."` header and preserves existing manual/API-account credential values); includes user-scoped Resume/Next Up feeds, retains duplicate quality copies so all matching items receive playstate, and uses the same isolated queue adapter for rating operations. See [jellyfin.md](jellyfin.md). |
| `liveSessions.js` | Polls Plex/Emby/Jellyfin `sessions` endpoints for what's playing now (`fetchLiveSessions`, reports per-platform fetch failures separately from a genuinely empty result), normalizes them (`buildCacheRow`, `sessionIdentity`, `hydrateCachedSession`) for `live_tracking_cache`. Feeds Now Playing and completed-session detection. |
| `liveSessionPoller.js` | Independent, activity-adaptive timer (10s while something's playing, 45s while idle) that runs `refreshLiveSessions()` (in `scheduled.js`) outside the once-a-minute scheduler tick, so Now Playing updates in seconds instead of up to a minute. `poke()` lets the Plex notification listener and `handleNowPlaying` trigger an immediate refresh. See [now-playing.md](now-playing.md). |
| `activeSessions.js` | The `active_sessions` table (webhook `active`-phase sessions, configurable 5-minute TTL by default, enforced on read). |
| `loopStore.js` | SQLite-backed loop-detection KV (`loop_keys` table) with TTL; `checkAndClaim` runs check+claim in one transaction so concurrent webhooks can't both pass. |
| `syncFlags.js` | `watchedPlayedSyncEnabled()` - global kill-switch for watched/played propagation via `WATCHED_PLAYED_SYNC_ENABLED`. |
| `configStore.js` | The `settings` SQLite row: media-server connection config (Plex/Emby/Jellyfin/Seerr/TMDB/Fanart/TVDB/YouTube/OMDb), sync-tuning overrides, and the disabled-by-default personal rating sync section with secret-preserving merges (`mergeIncomingConfig`), browser-safe shape (`publicMediaConfig`), URL/range validation; plus `runtime_state` helpers and the `sync_history` log. |
| `auth.js` | Session cookie sign/verify (HMAC, 7-day TTL), API-key matching, `requireAdmin`, and the auth route handlers (`login`, `logout`, `auth/status`, `auth/apikey`, `auth/webhook-secret`, `auth/credentials`, `auth/sessions/revoke-all`). See [auth.md](auth.md). |
| `outbound.js` | `fetchWithTimeout` (configurable 10s default - **all** server-side outbound HTTP must use it; enforced by the build check), `normalizeHttpUrl`, and `assertSafeOutboundUrl`. The shared boundary permits configured LAN media servers while rejecting unsafe schemes, embedded credentials, cloud-metadata targets, and unsafe redirect targets; credentials are removed from cross-origin redirects. |
| `http.js` | `sendJson` / `sendApiError` / `sendOptions` / `methodNotAllowed` / `notFound` response helpers; restore conflicts preserve HTTP 409/code/message. Same-origin only - no CORS headers are ever sent. |
| `restoreFailureNotice.js` | Preserves an interrupted restore's failure during owner-checked stale recovery, independently of the released fence. |
| `httpPerformance.js` | Response compression (gzip over eligible text/JSON above 1KB, with the live update stream excluded), the CSP image-origin memo keyed to the settings revision, and the public asset cache headers. A request carrying the canonical `?v=<version>` query is one immutable version of a file and is cached for a year; anything else revalidates, and `index.html` and the manifest are never cached hard. |
| `statsPayload.js` | Shapes the stats response around the period actually being viewed: full totals, a lightweight `{period, label}` index of every year and month, and only the selected report. The page previously received every ranked report on every load. |
| `requestBody.js` | `readJson` and `readFormData` (urlencoded + multipart via busboy) over the raw body captured by `server.js`. |
| `diagnosticLogger.js` | Wraps `console.log/warn/error` and writes captured lines (secrets redacted) to the `diagnostic_log` table for Settings → Logs (`/api/diagnostic-logs`). Batches writes, caps the table at 20,000 rows, and prunes the `data/logs` JSONL archive on boot. |
| `logVerbose.js` | `LOG_VERBOSE` flag plus `traceLog()`, used to keep per-request tracing (Plex GUID lookups, search fallbacks) out of the log unless explicitly enabled. |
| `cacheWarmup.js` | Background warm-up of the history-derived page caches after startup and after data changes settle (5 s quiet, 60 s ceiling); started by `server/server.js` in the web-serving process only. See "Data layer". |
| `cacheTelemetry.js` | Derived-cache rebuild counters: per cache, how many rebuilds, total/max/mean milliseconds, and which labelled generation change each was for. `timeCacheRebuild`/`timeCacheRebuildAsync` wrap the rebuild itself, so a cache hit costs nothing. Logs per rebuild under `PLEKT_DEBUG_CACHE_REBUILDS`; `cacheRebuildTelemetry()` returns the snapshot. |
| `posterCache.js` | Artwork fetch-resize-store pipeline: downloads a remote image (Plex token moved to a header), resizes with sharp to webp (poster 340w / backdrop 1600w / profile 780w / logo 800w), writes to `data/media/<variant>s/`, records metadata in `poster_cache` with negative caching for missing/failed. See [posters-artwork.md](posters-artwork.md). |
| `mediaArtwork.js` | Canonical show posters in `media_artwork` and season-specific poster overrides in `season_artwork`, shared across provider aliases and kept separate from episode artwork. |
| `tmdbGateway.js` | TMDB API gateway + SQLite caches (`tmdb_metadata_cache`, `tmdb_search_cache`, `tmdb_person_cache`): details, search, seasons, season artwork, people, images, library prewarm, request throttling and in-flight dedupe. For TV it merges TVDB structural data - see [metadata.md](metadata.md). Also caches what an IMDb/TVDB id is to TMDB `find` (series, episode with show and coordinate, or nothing) for the playstate alias repair. |
| `playstateAliasReview.js` | Watch-State Aliases card logic: lists episode-id playstate rows no proof tier places (id-less title-keyed rows excluded), folds a show's rows newest-state-wins, or stores them as "Different show" (settings row `playstateAliasDismissed`, whose keys the scheduled repair skips). |
| `playstateAliasRepair.js` | Schedules `repairPlaystateEpisodeIdAliases()` (`dataRepo.js`): the scheduler tick runs it from cached answers only, and uncached ids go to the `repair_playstate_episode_ids` background job, which looks them up and runs the repair again. Removes or rekeys episode playstate rows keyed on the episode's own ids once TMDB `find` proves them, or, when `find` cannot, a TVDB episode lookup (`lookupTvdbEpisodeKind` in `tvdbGateway.js`) names the profile's TVDB series at the row's coordinate; a newer conflicting alias is left for the user. |
| `tvdbGateway.js` | TheTVDB v4 gateway (built-in shared project key, optional personal key): series/season/episode data, title search, artwork; raw responses cached in `tvdb_metadata_cache` / `tvdb_season_cache`; `shapeTvdbSeriesAsTmdb` adapts TVDB shapes to TMDB-style fields. |
| `fanartGateway.js` | Fanart.tv gateway (built-in shared key + optional personal `client_key`): best/all posters, season posters, backdrops, and HD logos for movies (by TMDB id) and TV (by TVDB id). |
| `omdbGateway.js` | OMDb gateway: IMDb rating + vote count by IMDb id, cached 7 days in `omdb_cache`. |
| `tmdbClient.js` | Tiny wrapper `fetchPosterFromTmdb(row)` used by the poster pipeline's TMDB fallback. |
| `nextAiringCache.js` | File-backed cache (`data/next-airing-cache.json`) of each show's next episode air date + status, so the TV Shows page can sort by "next airing" without live TVDB/TMDB calls. TTL 6h for active shows, 7d for ended. |
| `upcomingCalendarCache.js` | Persistent month-level episode calendar (`data/upcoming-calendar-cache.json`): serves cached results, builds historical months once, checks current/future results for changes, and merges newly tracked shows without rebuilding existing entries. |
| `upNextCache.js` | Persistent unified dashboard queue snapshot (`data/up-next-cache.json`): serves a warm mixed movie/episode result, revalidates stale canonical/source-ledger data in the background, and advances the shared `up_next` cache generation when the completed snapshot changes. |
| `showProgressCache.js` | File-backed cache (`data/tv_progress_cache.json`) of per-show watched/total episode counts. Burst updates share one flush, reuse recent metadata totals, and atomically replace the file after synchronous persistence. In split `web` + `worker` deployments each process still owns a private whole-file snapshot, so concurrent writers can overwrite one another's unrelated show updates; SQLite watch history remains authoritative and a later recalculation repairs the cache. |
| `backup.js` | Portable full-backup format: exports/imports the core SQLite tables as versioned JSON collections (paged export, batched import, optional reset). Used by Settings → Backup / restore and the encrypted backup subsystem. |
| `watchHistoryBackups.js` | Watch-history-only backup subsystem: gzip JSON of `watch_history` + `playstate` + `playback_progress` with checksum manifest, independent daily local and remote schedules with separate retention counts, dry-run/merge/replace restore, remote destination management (secrets kept server-side, redacted in every API response), cron-sync pausing around restores. See [backups.md](backups.md). |
| `plektBackups.js` | Full encrypted backup subsystem: AES-256-GCM (PBKDF2) encrypted export of the entire portable backup, daily scheduling + retention, optional remote mirroring. |
| `plektRestore.js` | Server-side restore of a full backup file of any size: streamed base64/AES-GCM decrypt, a verify pass before any write, then import through `importCollectionBatch`; in-memory restore job and streamed uploads. |
| `backupStreamScanner.js` | Incremental reader for the backup document that reports top-level fields and one collection document at a time, so a backup is never held as one string. |
| `backupDestinations/index.js` | Adapter registry: `folder`, `webdav`, `s3` (also `backblaze`), `onedrive`, `dropbox` - all sharing `testConnection / upload / list / download / delete`. |
| `backupDestinations/folder.js` | Local/mounted-folder destination adapter. |
| `backupDestinations/webdav.js` | WebDAV destination adapter (basic auth). |
| `backupDestinations/s3.js` | S3-compatible destination adapter with its own SigV4 signer (AWS S3, Backblaze B2, MinIO…). |
| `backupDestinations/onedrive.js` | OneDrive adapter using the Microsoft device-code OAuth flow (app-folder scope, refresh-token persistence). |
| `backupDestinations/dropbox.js` | Dropbox adapter using the manual no-redirect OAuth code flow (refresh-token persistence). |

### `public/`

| File | What it is |
| --- | --- |
| `index.html` | The single HTML shell: nav tabs (Dashboard / Movies / TV Shows / Upcoming / History / Stats / Settings), one `view-panel` section per view, all modals/dialogs, and `modulepreload` links for every module. Element IDs here are what `bindElements()` queries. |
| `app.js` | **Frontend orchestrator** (keep under 3,000 lines): startup, theme init, backend warm-up ping, `bindElements`, SPA routing (`handleRouting`/`navigateTo`/`selectView`), auth flow wiring, and the callback objects handed to each module's `init*` function. Feature logic belongs in `public/modules/`, not here. |
| `styles.css` | All styling for the app, including responsive/mobile rules (mobile ≤ 760px must be verified for any layout change). Declares the self-hosted `@font-face` rules for the fonts in `fonts/`. |
| `styles-modern.css` | The Modern theme style, loaded after `styles.css`. Every rule is scoped to `html[data-style="modern"]`, so Classic (no attribute) is unaffected. |
| `theme-boot.js` | Tiny classic script loaded with a blocking `<script>` in `<head>`, before the stylesheet. Applies the saved (or system) theme and the saved theme style (`plembfin:style`) before first paint and gives every `img[data-theme-logo]` the matching header logo as it is parsed. The logo `<img>` tags carry no `src` so the browser's preload scanner cannot fetch the wrong variant. `app.js` (`initializeTheme`/`updateThemeIcon`) keeps the theme in sync afterwards. |
| `fonts/*.woff2`, `fonts/OFL-*.txt` | Self-hosted Outfit and JetBrains Mono variable fonts (latin and latin-ext subsets) with their SIL Open Font License texts, copied from the `@fontsource-variable` packages the public website uses. The app makes no request to Google Fonts; the CSP allows fonts from `'self'` only. |
| `favicon.png`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `plekt_header_logo_dark.png`, `plekt_header_logo_light.png` | `icon-192.png` (light browser theme) and `icon-192-dark.png` (dark browser theme) are the browser tab icons, and `favicon.png` is the Windows package icon source; `favicon.svg` is the placeholder art used wherever a poster or profile image is missing. `apple-touch-icon.png` is the 180x180 icon, filled to the edges with the app's dark background, that iOS uses when the app is added to the Home Screen, and the `icon-*.png` files are the Android/Chrome install icons named by the web manifest. The two header logos are swapped by the theme toggle. |
| `manifest.webmanifest` | Web app manifest: app name, standalone display mode, theme/background colour, and the install icons above. Linked from `index.html`, which also sets `apple-touch-icon`, `apple-mobile-web-app-title` and `theme-color`. |
| `icons/plex.svg`, `icons/emby.svg`, `icons/jellyfin.svg`, `icons/trakt.svg`, `icons/plembfin.png`, `icons/tmdb.svg`, `icons/tvdb.svg`, `icons/imdb.svg` | Media-server, Plekt, and metadata-source badge icons used on cards and pills (the media detail page's Ratings/Watch Now rows, and per-watch source badges). A watch recorded with `source: "manual"` (marked watched from within Plekt itself, not reported by a media server) normalizes to `plembfin` and renders with `icons/plembfin.png` and the "Plekt" label, rather than defaulting to Plex (`normalizePlatformSource` in `modules/utils.js`). `icons/trakt.svg` is used by the Sync Activity page, which resolves tracker names itself. |

### `public/modules/`

| Module | Owns |
| --- | --- |
| `state.js` | The single shared `state` object, the `elements` registry, localStorage keys, view/tab constants. No logic. |
| `utils.js` | Formatting/escaping/date helpers (`escapeHtml`, `formatDate`, `platformBadge`, `slug`, show/episode title parsing, duration/progress formatting…). |
| `auth.js` | Login/logout/status against `/api/auth/*`, `onAuthChange`, credential updates, webhook-secret rotation, auth header building, one-time account claim. See [auth.md](auth.md). |
| `onboarding.js` | The `/setup` page (steps, status polling, background-import toggles, sync options, Trakt connect), the account-claim form handlers, and the dashboard checklist. See [onboarding.md](onboarding.md). |
| `settings.js` | Shared connection-label formatting. |
| `settings-ui.js` | Reusable settings edit dialog, provider picker, and status-card grid primitives. |
| `settings-services.js` | Media-server and metadata-provider card grids, edit dialogs, config saves, connection tests, and the inline Sync Tuning form, including the app-marked watched-flag policy. |
| `manual-watch-review.js` | Manual Watch review page and policy actions. The compact sidebar count and summary polling live in `status-indicators.js`. |
| `rating-sync-settings.js` | Personal Rating Sync on/off control, provider summary, Sync now, status polling, and queue feedback. |
| `watchlist-sync-settings.js` | Plex Watchlist Sync on/off control, Plex summary, Sync now, and status polling. |
| `settings-shell.js` | Owns hierarchical settings routes (parent groups + child sections), multi-view panel aggregation, legacy aliases, the landing list, sidebar/mobile navigation, section-scoped scrolling, and tools disclosures. |
| `tracker-settings.js` | Trakt device-code connection, initial baseline/import policy, connection state, personal-app fallback, and Sync Now controls. |
| `live-updates.js` | Authenticated watch-state/personal-media, Up Next-cache, and Discover-cache version stream, reconnect/backoff, and debounced background data refresh with targeted visible-row reconciliation. |
| `logs.js` | Frontend debug-log store (localStorage ring buffer) + fetching backend diagnostic logs. |
| `images.js` | Poster/artwork frontend: `posterMarkup` (with its loading skeleton), `hydratePosterFallbacks`, `/api/poster` lookups with a persistent cache, TMDB image URL builders, `proxiedArtworkUrl`, `isCachedStorageImageUrl`. See [posters-artwork.md](posters-artwork.md). |
| `appearance.js` | Small always-available appearance preference helper: defaults, body visibility classes, saved appearance loading, and the text size scale (100% to 130%) applied to font sizes in the stylesheets. |
| `status-indicators.js` | Small always-available sidebar sync progress/attention and Manual Watch review count helpers, plus compact authenticated summary fetches and polling. |
| `media-routing.js` | Small core movie lookup and Now Playing route helpers used by the shell and live dashboard links. |
| `cast-disclosure.js` | Small core cast-card markup and deferred cast disclosure/focus helper used by the shell event wiring and detail renderer. |
| `sync.js` | Now Playing polling + rendering, sync-status pills/telemetry parsing, sync jobs + sync history panels, cron/force-sync triggers. |
| `sync-activity.js` | The on-demand `/sync-activity` page: per-media rows from `/api/sync-history` newest first, source-to-target route line, icon-plus-status target results (`activityPlatform` names trackers as well as media servers, so Trakt is not folded into Plex), targeted retry for actual failed destinations while expected missing-library skips remain audit-only, a "Retry all failed" background job covering the whole history, title links to the media page, click-to-expand inline logs, the per-item log download, and route-scoped search/paging/retry/match-fix/dismiss handlers. See [dashboard.md](dashboard.md). |
| `media-records.js` | Shared media identity and duplicate-record selection used by dashboard, explorer, detail, and watch-action route modules. |
| `dashboard.js` | Dashboard rendering: Now Playing grid, completed recent-history rows, mixed Up Next cards, and compatibility-only Part Watched panels. See [dashboard.md](dashboard.md). |
| `media-card.js` | Shared media-card normalization/rendering for Up Next, Discover, collection members, and later list/library surfaces. |
| `card-art.js` | Modern-style backdrop artwork behind cards on every page: `data-art` keys, lazy batched lookups with retry, and the injected `#modernArtStyles` sheet. See [frontend.md](frontend.md). |
| `history-poster-overlay.js` | History with Posters only on: the episode name, watched date, and app overlaid on the bottom of each poster, over a blur. See [frontend.md](frontend.md). |
| `page-card-open.js` | With Posters only on (Library, Discover, History, Watchlist, Ratings, Playlists), a clicked poster opens its card in place, one at a time, as the Dashboard's compact rows do. See [frontend.md](frontend.md). |
| `up-next.js` | Dashboard mixed Up Next loader/rendering backed by browser/server cache hydration, provider/local resume and released-episode observations, SSE revalidation, source-status messaging, and the shared media-card contract. See [dashboard.md](dashboard.md). |
| `settings-events.js` | Settings-page event wiring (diagnostic logs, admin login and webhook secret rotation, import, backups and restore, maintenance tools, sync controls). A Settings route module, initialized by `app-events.js` through `onRouteModuleLoaded()`, so other pages never parse it. |
| `playlists.js` | Playlists page (`/playlists`): playlist rails with app icons and sync status, "Missing from <app>" notes and poster badges, drag-and-drop plus a compact Move left/right control for reordering (item cards show no summary), held-change Confirm/Discard, Recently deleted (Restore / Delete permanently), and the create/edit dialog with the app picker. The "Import from apps" dialog lives in `playlist-import.js` (server side: `server/src/utils/playlistImport.js`); the automatic playlist rule editor and heading panel in `playlist-rules.js` (server side: `server/src/utils/playlistRuleEngine.js`). Imported one way by `personal-media.js`, which injects its helpers through `initPlaylists()`. |
| `personal-media-metadata.js` | Fills missing overview/release date for the personal ratings, watchlist, and playlist items on the visible page from TMDB (through `tmdb.js`'s session cache), and shares what it learns across the three collections. |
| `up-next-shared.js` | Small Up Next show identity and action-markup helpers shared by poster menus and media-detail rendering without loading the dashboard Up Next route module, plus the dismissal key builders and `provenDifferentShow`, which keeps same-title shows (Scrubs 2001 and 2026) from matching each other. |
| `discover.js` | `/discover` cached TMDB feeds, watch-history recommendations, watched-title filtering, persisted Don't recommend actions, type/genre filters, browser/server cache hydration, SSE refresh, error/empty states, and poster hydration. See [metadata.md](metadata.md). |
| `stats.js` | Stats page: KPI cards, leaderboards, platform split, month chart, yearly/monthly review reports. See [stats.md](stats.md). |
| `explorer.js` | Movies grid, TV Shows grid, History page, Search page: paging, sorting, filters, collection expansion, IntersectionObserver infinite scroll, TMDB prefetch. See [movies.md](movies.md), [tv-shows.md](tv-shows.md), [history-search.md](history-search.md). |
| `route-modules.js` | Registry of on-demand route modules: their `import()` loaders, dependency order, one-time initializers, and the `lazyExport`/`ifLoaded` wrappers the shell event modules use. See [frontend.md](frontend.md#core-graph-and-route-modules). |
| `poster-menu.js` | Builds and positions the poster three-dot overflow dropdown (Edit watch date / Fix match / Mark unwatched), portaled to `<body>` so it isn't clipped by a card's `overflow: hidden`. See [movies.md](movies.md#frontend-behavior). |
| `upcoming.js` | Upcoming page: scrolling month calendar of historical and future TV episode air dates that opens on the current week, search, outside-month matches, poster hydration, and show navigation. See [upcoming.md](upcoming.md). |
| `media-detail.js` | Detail-page entry points: open movie/show detail by id/slug/TMDB id, lookups, modal-close routing. |
| `media-detail-context.js` | Detail-modal shell/context: init callbacks, `authHeaders`, modal DOM root, render token, debug modal, shared action markup (including Force Sync), and actions-menu state. |
| `media-detail-shared.js` | Route-scoped shared TMDB/Seerr rendering fragments: rating pills, availability labels, Seerr request pills/controls, external ratings, app links, and primary-ready milestone. |
| `media-detail-show.js` | TV show detail rendering: seasons/episodes accordion, show modal, per-episode actions. |
| `media-detail-movie.js` | Movie detail rendering + watched-state patching. |
| `media-detail-events.js` | Click delegation inside the detail modal (cast, trailers, poster edit, watch actions, shared title-scoped Force Sync dialog and Settings library Force Sync panel with live activity polling, card navigation). |
| `media-person.js` | Person profile pages: bio, filmography with watch badges. |
| `media-lightbox.js` | Trailer playback (YouTube embed) and photo lightbox. |
| `calendar-picker.js` | Shared calendar + time picker (month/year quick-select, fixed-height day grid) used by every date/time picker in the app - the edit-date dialogs and the mark-watched date prompts - so they all look and behave identically. No global state; each mount owns its own picker instance. |
| `edit-dialogs.js` | Edit watched-date (including multiple watch dates per item: add/edit/delete), edit images (poster/logo/backdrop and season poster picker), fix-match, and merge-show dialogs. |
| `season-posters-panel.js` | Season list, provider poster options, upload selection, and save payload for the Edit Images Season Posters tab. |
| `watch-action.js` | Manual mark watched/unwatched flows: date prompt (built on `calendar-picker.js`), batched `/api/manual-watch` posts, delete-media, Seerr request submission. |
| `tmdb.js` | Frontend TMDB enrichment helpers (`fetchTmdbDetails`, season details, episode-title resolution) with in-memory caches. |
| `tools.js` | Settings tools bridge: Trakt/CSV import flows, `initTools()`, and compatibility re-exports for backup/appearance and maintenance tools. |
| `tools-backups.js` | Settings backup UI and appearance save action: full export/import, watch-history backups, encrypted backups, Backblaze destination cards/dialogs, and backup passphrase controls. The always-available appearance defaults/body/loading helper lives in `appearance.js`. See [backups.md](backups.md). |
| `tools-maintenance.js` | Maintenance diagnostics: System Integrity Check, repair workflow, dedup history, Trakt backfill, TV re-match, full watchstate sync, cache stats/clear, and the "Restore Missing Episode Names" audit/backfill Database Repairs tool. |
| `tools-duplicates.js` | Library-wide duplicate-watch cleanup (Settings → Tools → Database Repairs): scans then removes every extra watch beyond the oldest, for TV episodes and movies separately. |
| `tools-playstate-aliases.js` | Watch-State Aliases card (Settings → Tools → Database Repairs): lists episode-id playstate rows no TMDB/TVDB proof places, per show "Belongs to this show" (newest state wins) or "Different show" (never listed again, skipped by the repair). Local playstate only. |
| `tools-wipe-data.js` | Wipe data (Settings → Tools → Wipe data): Watch History, Personal Watchlist, Sync History & Logs, Everything Tracked, and Wipe All / Fresh Start (full factory reset). Two confirm dialogs per action; row-count previews from `GET /api/wipe-data/preview`. |
| `help-content.js` | Static help/guide HTML: credential guides, webhook setup per platform, cron guide, settings inline help. |
| `app-events.js` | Global app event wiring (delegated click/submit/keyboard handlers bound at startup); route-specific Sync Activity action wiring is initialized by `sync-activity.js` when that page loads. |

### `scripts/`

`workflow-check.js` provides read-only push/alpha/main prechecks, narrow-scope baseline,
candidate identity, staged-path and safe local develop-reconciliation gates.
`verify-release-website.js` checks the released website's changelog, guide URLs and
homepage screenshot content hashes/bytes. Neither script acquires a lock or publishes.

| File | What it is |
| --- | --- |
| `build-check.js` | The `npm run build` gate: syntax-checks every JS file, runs `docs-check.js`, validates the JSON manifests, rejects bare `fetch(` in `server/` (must be `fetchWithTimeout`), then boots the server once against a temp DATA_DIR (`PLEKT_BUILD_CHECK=1`). |
| `docs-check.js` | `npm run docs:check` - derives the required Node.js version from `package.json`, checks the README badge and setup text, and rejects weak/default Docker password examples. |
| `changelog-message.js` | Shared changelog-message formatting, bullet extraction, release-detail validation, noise/release-process detection, and the `changelogEntryProcessViolations` safety check used by the local hooks, tests, and the three changelog scripts below. `synthesizeHeadline()` folds every commit/entry headline bundled into a release entry into one sentence naming all of them, rather than only the most recent one. `isReleaseToolingText()` strips bullets describing the release pipeline's own machinery (git hooks, CI workflows, the promotion scripts) by content, regardless of which commit type carried them, so a real feat/fix commit's bullet list can't leak dev-tooling notes into a changelog end users read. |
| `changelog-git-helpers.js` | Shared git plumbing for the changelog scripts: walks real commit history between an anchor and HEAD (`commitsSinceLastEntry`), lists a commit's changed files, and reads the current HEAD commit/author. |
| `validate-commit-message.js` | CLI used by the commit-message hook to reject user-visible release commits with missing or title-repeating details. |
| `rebuild-develop-changelog.js` | Run locally as part of "Push to git" (CLAUDE.md), before the push: fully recomputes `changelog.develop.json`'s single entry from every real commit between its `resetCommit` anchor and HEAD, replacing it rather than appending. Its `--check <commit>` mode validates the committed changelog tree used by the develop pre-push guard without modifying files. |
| `promote-develop-to-alpha.js` | Run locally as part of "Force to alpha", before the force-push: packages develop's current entry as its own standalone alpha build entry, prepended to alpha's `entries` (`promoteDevelopToAlpha`), bumps the alpha build, and resets develop for the next cycle. Also exports `categorizeEntries`/`simplifyEntries`/`formatSections`/`mergeSections`, shared with the script below. |
| `promote-alpha-to-main.js` | Run locally as part of "Force to main", before the force-push: consolidates every alpha build entry accumulated this cycle into one release entry (`promoteAlphaToMain`), bumps the real semver (honouring a manually-set higher `package.json` version), writes `changelog.json`/`package.json`/`package-lock.json`/`CHANGELOG.md`, resets alpha, and resets develop to the released version at build 1 for the next cycle. `--preview` runs the same computation read-only and prints the would-be release entry so a human can approve the changelog before anything is staged or pushed; it lists any website guides the content-impact gate still needs without stopping, while `--confirm` refuses until none remain. |
| `deploy-oracle-demo.sh` | Copied to the dedicated OCI instance by the main-release workflow; pulls one exact GHCR release tag, recreates only the configured demo container, preserves its `/data` mount, and starts it in isolated public-demo mode. |
| `verify-oracle-demo.js` | Main-release smoke check: confirms the OCI public demo's health endpoint, public-demo guardrail, and `/changelog.json` all match the released version. |
| `generate-release-notes.js` | Renders the committed main or alpha changelog entry into the formatted GitHub Release body: categorized changes, safe-start guidance, limitations, Docker tags, Windows installer status, and project links. Supports a local Markdown preview with `node scripts/generate-release-notes.js <main|alpha>`. |
| `publish-github-release.js` | CI helper called by the main image, alpha image, and Windows installer workflows: creates or updates the matching GitHub Release from `generate-release-notes.js`, marks alpha builds as prereleases, and handles two workflows finishing at the same time without duplicate releases. |
| `notify-discord-release.js` | CI helper called by `update-changelog.yml` (`main`) and `docker-publish-alpha.yml` (`alpha`): builds a Discord embed from the newest `changelog.json`/`changelog.alpha.json` entry and posts it to the `DISCORD_RELEASES_WEBHOOK` secret. No-ops if the secret isn't set; supports `--dry-run` to print the embed instead of posting. |
| `install-git-hooks.js` | Sets `core.hooksPath` to `.githooks` (runs automatically via npm `prepare`). |
| `docker-entrypoint.sh` | Container entrypoint: chowns `/data` when starting as root, then drops to the `plekt` user via gosu. |
| `exportPlexHistory.js` | Standalone one-shot importer: reads a Plex server's watch history over its API and posts it to `/api/import` in chunks. Driven by env vars (`PLEX_URL`, `PLEX_TOKEN`, `API_KEY`). |
| `forcePushHistory.js` | Standalone one-shot replicator: fetches Plekt's `/api/history` and replays every row against Plex/Emby/Jellyfin as mark-played calls. |
| `seed-demo-content.js` | `npm run seed:demo` - inserts fictional movies/shows with generated poster art for demo screenshots/dev. |
| `generate-synthetic-library.js` | Builds a disposable library at a stated scale for performance measurement, parameterized by movies, shows, episodes per show, history rows, TMDB cache blob size, and poster pool. Writes only to the `--data-dir` it is given, refuses a directory holding a database it did not create, and drops a `synthetic-library.json` marker recording the parameters and resulting counts. |
| `browser-route-benchmark.js` | Browser-side route benchmark for the application-speed plan: pasted or injected into a signed-in tab, it drives one same-origin popup (the app sends `X-Frame-Options: DENY`) through document loads or SPA transitions and reports TTFB, load, FCP, LCP, detail primary-ready, request/transfer/decoded totals, the shell subset, and a per-path request inventory. Never handles credentials. |
| `browser-route-benchmark-playwright.js`, `phase-g-*-playwright.js` | Phase G helpers for the application-speed plan. Each file is one Playwright page function pasted into the Playwright MCP browser tool, not a `node` script: the warm route matrix, the non-mutating smoke pass, the CLS diagnostic and follow-up, and isolated auth expiry/restoration. None enters credentials or changes provider state. |
| `benchmark-surfaces.js` | Records the server-side surface baseline against a generated library (dashboard payload, stats, History/Movies/Shows page N, and a cold full cache rebuild) and writes it to `docs/benchmarks/`. Each measured result includes a SHA-256 payload fingerprint so before/after timing runs can also prove byte-identical output. Makes no database writes: the cold rebuild is measured from a fresh process's first read of each cache rather than by forcing a miss. |

### `test/`

The focused `node:test` suite run by `npm test` and the build check. Each file runs in
its own process; DB-backed tests point `DATA_DIR` at a temp directory before importing
server modules.

### `reddit-app/`

A separate deployable, not part of the main app's build/test/CI - see
[`reddit-app/README.md`](../reddit-app/README.md). A [Devvit](https://developers.reddit.com)
app installed only in r/plembfin: a scheduled job polls this repository's public
`changelog.json` and, when a new release appears, posts and pins an announcement to
r/plembfin (un-pinning whichever release post it had pinned before). It has its own
`package.json`, builds with `vite`/`devvit` rather than this repo's Node tooling, and is
deployed with the `devvit` CLI, not Docker/GHCR. `PRIVACY.md`/`TERMS.md` in that
directory are linked from the app's Reddit developer-platform listing.

| File | What it covers |
| --- | --- |
| `changelogMessage.test.js` | Changelog subject formatting, bullet extraction, and rejection of missing or title-repeating release details. |
| `parsers.test.js` | Webhook normalization (Plex/Emby/Jellyfin/custom payload parsing, phases, GUID extraction). |
| `mediaKey.test.js` | Canonical `mediaKeyFor`/`canonicalTitleKey` derivation and specials (season 0) normalization in watch records. |
| `syncOrchestrator.test.js` | Target routing, resume-progress actionability, loop-store echo detection. |
| `mediaForceSync.test.js` | Title-scoped Force Sync mode/target normalization, watched Plex/Emby item shaping, and duplicate-quality Jellyfin episode matching. |
| `mediaForceSyncTrackerPhases.test.js` | Local-first detail Force Sync ordering, independently bounded Trakt work, combined partial outcomes, and cancellation of queued tracker items. |
| `scheduledResumeAuthority.test.js` | Timestamp and canonical-state precedence for webhook and scheduled resume candidates, including stale acknowledgements and explicit unwatches. |
| `staleRestoreScheduler.test.js` | Scheduler admission recovers orphaned restores while preserving fresh heartbeats and replacement operation owners. |
| `defaultShowSeason.test.js` | Latest regular season selection, preserving collapsed seasons, explicit season links, and load-ready deep-link scrolling. |
| `syncRetry.test.js` | Scheduled-dispatch retry backoff schedule/eligibility, retry columns, permanent `sync_history` pagination. |
| `bulkMarkWatchedPerformance.test.js` | Bulk-watch dispatch identity grouping, scheduler deferral threshold, provider fan-out, and single-flight series/episode lookup coverage. |
| `metadataCaches.test.js` | Fanart response cache (hits and negative misses), TMDB details cache freshness, light-vs-full cache row semantics. |
| `exportPlexHistory.test.js` | The standalone Plex history export script's episode-record shaping (specials season zero). |
| `trackerSettings.test.js` | Live Trakt Sync Now completion summary counts and wording. |
| `upNextIdentity.test.js` | Canonical mixed movie/episode identity, provider-ID aliases, deterministic ordering, and queue merging. |
| `upNextQueue.test.js` | Unified Up Next projection, local resume precedence, canonical watched-state filtering, and bounded metadata fallback. |
| `upNextProviderFeeds.test.js` | Generation-based provider feed snapshots, last-good retention, source-ledger metadata, and credential-redacted errors. |

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

## Data flow: webhook → sync

When a play event arrives at `/api/webhook`:

1. `normalizeWebhook()` parses Plex (multipart), Emby (JSON), Jellyfin (JSON), or custom
   JSON into a unified `media` object (`parsers.js`).
2. The `phase` field drives branching: `active` → upsert active session; `ended` → sync
   resume progress; `unplayed` → delete + propagate unwatched; `completed` → insert watch
   record + propagate watched.
3. `syncMediaPlaystate()` (`syncOrchestrator.js`) propagates to the other two platforms
   via `plexClient` / `embyClient` / `jellyfinClient`, with echo-loop detection via
   `loopStore`.
4. Results are written back as `sync_dispatch_telemetry` on the watch record and logged
   to `sync_history`.

Full detail: [webhooks.md](webhooks.md).

## Scheduler

The elected worker coordinator (`server/src/workerCoordinator.js`) drives the tick, calling
`runScheduledTick()` from `server/src/scheduler.js` (wrapping `runScheduledSync` from
`scheduled.js`) once a minute. The tick is guarded against overlap: if the previous tick is
still running when the next fires, the new tick is skipped.

Before the restore admission gate, the worker recovers stale operation markers after
three minutes without a heartbeat. Recovery atomically rechecks the operation owner
and heartbeat, preserving a replacement operation or a restore that has renewed its
lease. This recovery runs even when a persisted restore fence blocks normal sync.

Each tick is scheduled from the **start** of the previous one, so the period stays 60 seconds
whatever a tick costs. `nextTickDelayMs()` computes the delay: a tick that finishes inside its
period waits out the remainder, and a tick that overruns skips the whole periods it consumed
rather than firing a catch-up burst. Timing the wait from a tick's completion instead would
make the real period `60s + tick duration`, which compounds across every later tick.

The same logic runs on demand via:
- `GET /api/cron-sync/status` - returns the last cron trigger/result as JSON for automation.
- `POST /api/cron-sync` - streams a text log of what the tick did.
- `POST /api/force-sync` - runs and stores progress in `runtime_state` for the
  dashboard to poll; `stop-force-sync` cancels.
- `POST /api/force-sync/library` - runs a library-wide push (Set Plekt as
  Source of Truth) or pull (Import Watched Status) operation from Settings →
  Sync Tools; `GET /api/force-sync/library/status?id=...` returns its live
  activity and final result.
- `POST /api/force-sync/media` - runs a title-scoped push (Set Plekt as
  Source of Truth) or pull (Import Watched Status) operation from the detail
  page; `GET /api/force-sync/media/status?id=...` returns its live activity
  and final result.
- `GET /api/rating-sync/status` and `POST /api/rating-sync/run` - inspect or run
  the optional personal-rating snapshot/reconciliation worker.
- `POST /api/rating-sync/push` and `POST /api/rating-sync/retry` - explicitly
  queue local ratings or retry durable rating work.
- `GET /api/watchlist-sync/status` and `GET /api/watchlist-sync/activity` - inspect
  canonical count, provider capabilities, queue/run state, and recent
  watchlist-specific activity.
- `POST /api/watchlist-sync/preview` - read a provider snapshot and show local items
  that can be resolved plus provider-only items without changing state.
- `POST /api/watchlist-sync/run` - run reconciliation or compatibility retry/publish
  actions; the one-toggle UI always reconciles every connected provider.

Personal rating sync is invoked by the same elected scheduler tick only after the
watched-state work, but it has its own enabled flag, interval gate, queue, leases,
provider adapters, and error accounting. A rating provider outage cannot change
watched state, play history, resume progress, or the watched-state Force Sync lock.

Plex watchlist sync is a separate elected-worker pass, and Plex is its only provider -
see [personal-watchlist.md](personal-watchlist.md) for why Emby and Jellyfin cannot
represent a watchlist. Local add/remove actions commit the canonical row or append-only
tombstone and the provider queue intent in one SQLite transaction. Snapshots are only
allowed to infer removals after a successful complete snapshot. Plex uses the
account-level Universal Watchlist (RSS is read-only). An unavailable provider never
deletes the canonical row, and a restored watchlist takes a safe union before delivery
resumes.

Playlist sync (`playlistSyncTriggers.js`) runs as the next elected-worker step: a full
pull-then-push pass over every app-targeted playlist once per 5 minutes, plus a
debounced single-playlist sync 5 seconds after a Plekt add, remove, or delete. A
web-only process skips the debounced sync (the per-playlist lock is in-process) and
leaves it to the worker's next pass. Plekt-only playlists never sync.

The tick also runs the scheduled watch-history backup and encrypted backup jobs
([backups.md](backups.md)), refreshes the generation-based provider Up Next source ledger,
maintains `data/next-airing-cache.json`, and progressively builds
`data/upcoming-calendar-cache.json`. The calendar cache stores the previous 24 months
without refreshing them, checks current/future months for actual changes, and merges
newly tracked shows on access without repeating existing TVDB season pulls. Provider
feed failures preserve their last successful ledger generation and are surfaced as
non-secret status on the dashboard.

Full detail: [scheduled-sync.md](scheduled-sync.md).

## TV metadata (TMDB + TheTVDB hybrid)

`server/src/utils/tmdbGateway.js` and `server/src/utils/tvdbGateway.js` split TV show
metadata by source, both behind the same `getTmdbDetails()`/`getTmdbSeason()` API so
every caller (routes, frontend, `deriveNextAiring`) is unaware of the split:

- **TheTVDB** supplies structural data for TV shows - name, overview, status, network,
  genres, artwork, and season/episode numbering, titles, overviews, and air dates.
  This is deliberately more accurate than TMDB's own numbering for many shows.
- **TMDB** supplies everything TheTVDB doesn't have: cast/credits, trailers,
  reviews, similar/recommendations, watch providers, and content ratings. `id` on a
  TV show's details is always the resolved TMDB ID (via TheTVDB's `remoteIds`, or the
  caller-supplied ID), since Seerr requests and `/tvshow/tmdb/:id` routing are
  TMDB-keyed. TheTVDB's `remoteIds` mapping is community-submitted and occasionally
  points at a stale/incorrect TMDB id; `getTvShowDetails` verifies it by fetching that
  id and, if it 404s, falls back to a TMDB title search and uses the corrected id -
  otherwise cast/trailers/images would silently stay empty for that show.
- A "Specials" (season 0) entry is only included in a show's `seasons` list when
  TheTVDB actually has episodes attached to it - an empty placeholder season is
  dropped rather than shown as a dead, always-empty accordion row.
- **Movies** are 100% TMDB.

Like `fanartGateway.js`, `tvdbGateway.js` ships a hardcoded project API key so TVDB
lookups work out of the box; an optional personal key can be set in Settings →
Metadata → TheTVDB or via `TVDB_API_KEY` for a higher personal rate limit.

Raw TVDB API responses are cached in `tvdb_metadata_cache` / `tvdb_season_cache`;
the merged TMDB+TVDB result is cached in the `tmdb_metadata_cache` table
under `tv_{tmdbId}` keys, so movie caching and downstream consumers (poster pipeline,
Seerr, next-airing) all read one shape. `DETAILS_SCHEMA_VERSION` is bumped whenever the
cached shape changes, which forces every existing cache row to be treated as stale and
refetched on next access - no manual cache clearing needed after an upgrade that changes
this shape.

Full detail: [metadata.md](metadata.md).

## Changelog & update check

Each build ships with a bundled `changelog.json` at the repo root (served verbatim at
`GET /changelog.json`) that records the version this instance was built from - this is what
the Changelog screen reads. A small `GET /version.json` response carries only that installed
version for the sidebar badge. On dashboard load `loadAppVersion()` calls `/api/changelog`
with `?refresh=1` for a quick update check; when a newer release exists the badge changes
from `v0.2.15` to `v0.2.15 - Update available` (accent-tinted).

`GET /api/changelog` (`handleChangelog` in `routes/maintenance.js`) layers an update check on top: it
reads the bundled `changelog.json` for the current version and fetches the published
`changelog.json` from GitHub raw (`Lasikiewicz/plekt@main`), cached in-process for one
minute (8-second fetch timeout). `?refresh=1` from an admin session bypasses that cache and
re-fetches immediately. The browser cannot reach GitHub directly because the CSP is
`connect-src 'self'`, so the server proxies and caches it.

Settings -> Changelog carries a Main / Alpha toggle. The toggle is available on every
channel, because `/api/changelog` returns the alpha branch's live manifest whatever is
installed, so a release install can read alpha build notes. Reading them never changes the
reported installed version and never raises an update prompt: the server forces
`alphaBuild.newerBuildAvailable` to false off the alpha channel. An alpha or develop install is
told separately about a newer build on its own channel and a newer published release, rather
than only whichever check ran first. Alpha builds left over from an earlier release are grouped
under their own heading so they are not read as builds of the installed one. Display formatting
for the five-segment build version (`formatBuildVersion()`, `versionDisplayLabel()`) lives in
core `public/modules/utils.js`, because the sidebar badge renders it on every page; it trims
trailing zero segments so a release reads `v1.1.0` and an alpha build `v1.1.0.1`. The Settings
changelog renderer itself is `public/modules/changelog-channels.js`, loaded with that route.

All three of `changelog.develop.json`, `changelog.alpha.json`, and `changelog.json` are
written locally, as part of running the selected "Push to git" / "Push all to git" /
"Force to alpha" / "Force to main" command themselves (see CLAUDE.md's branching model
section for the full step-by-step) - never by a CI job reading GitHub's push-event commit
list after the fact, which is only reliable for a plain incremental push and unreliable
for `alpha`/`main`, both of which are always reached by a force-push. None of the three
publish workflows write anything back to their branch; each only builds, verifies, and
publishes the Docker image using values already committed.

Each alpha build entry carries `sections` (`newFeatures`/`majorBugFixes`/`tweaks`),
produced by `categorizeEntries()` in `scripts/promote-develop-to-alpha.js` from that
build's own develop commits. A main-release entry's `sections` are produced by merging
every alpha build entry's own `sections` directly (`mergeSections()`, also in
`promote-develop-to-alpha.js`, used by `scripts/promote-alpha-to-main.js`) rather than
re-categorizing the entries themselves - an entry's `message` is a synthesized headline
sentence, not a commit-message bullet, and re-categorizing it would land it in tweaks as
a garbled duplicate. Settings → Changelog (`renderChangelogDetails()` in `public/app.js`)
and the generated `CHANGELOG.md` (`scripts/generate-changelog-md.js`) render `sections`
as separate headed groups whenever any of the three is non-empty, falling back to the
flat `entry.details` list otherwise. Alpha and main promotion automatically derive
optional `sectionGroups` for thematic `####` subheadings; a reviewed release may
override those defaults without changing the flat arrays. Develop's entry stays flat,
since it never carries `sections` at all (see below). Main release entries may also carry
`websiteUrl`; GitHub-facing renderers use a Markdown link, while Reddit and the app/website
views render the same URL through their own compatible output instead of assuming GitHub
Markdown will be interpreted everywhere.

Both promotion scripts run the same release-content check
(`changelogEntryProcessViolations` in `scripts/changelog-message.js`) on the entry they
just assembled, and refuse to write it - throwing rather than publishing - if any
recognized release-process text survives (changelog consolidation, folded-in release-note
bullets, branch build-counter resets, and similar). This is the only gate; there is no
separate CI validation step.

The two entry lists are merged rather than one replacing the other: entries are keyed by
commit (falling back to version + message), remote copies win on conflict except that a
local entry's `details` are kept when the remote one has none, and the result is sorted
newest-first by semver then date. A release that exists only in the bundled file therefore
stays visible alongside releases that exist only on GitHub. The response is
`{ current, channel, alphaBuild, latest, updateAvailable, remoteAvailable, remoteError, newer, entries }`,
where `latest` is the highest version across the remote manifest and the merged entries,
`newer` lists releases with a higher semver than the running build, `updateAvailable` is
true when `latest` outranks `current`, and `channel` is `"alpha"` when the image was built
with `BUILD_CHANNEL=alpha` (the `ghcr.io/lasikiewicz/plekt:alpha` image) or `"release"`
otherwise. `current` itself always stays a plain semver string so entry-matching and
update comparisons are unaffected; the frontend appends " alpha" (and, on alpha, the build
number) only where the version is displayed - the sidebar badge and About's
current-version banner - never in the value compared against changelog entries. If GitHub
is unreachable the bundled entries are served on their own.

`alphaBuild` is populated only on the `alpha` channel, read from the bundled
`changelog.alpha.json` (`readLocalAlphaChangelog()` in `routes/maintenance.js`): a rolling
build counter and one changelog entry per build accumulated so far this cycle, separate
from `changelog.json`'s real semver and reset on the next "Force to main".
`scripts/promote-develop-to-alpha.js` writes this file, run locally as part of "Force to
alpha" (before the force-push): it packages develop's current entry as its own standalone
alpha build entry and prepends it to `entries` - so a fresh "Force to alpha" call adds
another entry rather than updating one in place, and a user can see exactly what changed
in each build they haven't pulled yet - bumps `build`, and resets to a fresh `baseVersion`,
build 1, and an empty `entries` array whenever `changelog.alpha.json`'s `baseVersion`
differs from `changelog.json`'s version (i.e. main moved forward since the last alpha
push). A build's version is 4 segments - `baseVersion.build` (e.g. `0.14.0.3`) - not 5;
nothing parses past the 4th segment, so a trailing `.0` was only ever visual noise in the
changelog UI. `docker-publish-alpha.yml` reads the build number already in the pushed
commit and tags the published image `alpha-<build>` alongside the rolling `alpha` tag; it
does not write anything back.

`handleChangelog` also fetches `changelog.alpha.json` from the `alpha` branch on GitHub raw
(`fetchRemoteAlphaChangelog()`, same one-minute cache and `?refresh=1` bypass as the main
remote fetch) and passes the local and remote alpha manifests through
`describePendingAlphaBuild()` (a pure, exported function - no I/O - so it's unit-tested
directly rather than through the route) to add `alphaBuild.latestBuild` /
`alphaBuild.newerBuildAvailable` / `alphaBuild.pendingEntries` to the response.
`newerBuildAvailable` is true when the remote's `build` is higher than the running
instance's own, or its `baseVersion` differs (a release cycle moved on) - a distinct signal
from a main release existing, answering "has a newer `:alpha` image been published since
this one was built," which the running build's own bundled file can never know on its own.
`pendingEntries` is the actual changelog bullets for those not-yet-pulled builds - read from
the *remote* manifest, not the local one, since a build that hasn't been pulled yet can only
ever appear in GitHub's copy of the file - so the UI can show what changed before the user
updates, not only after.

About renders the current version, a status banner, and the full release list
with newer versions highlighted. On the `alpha` channel the banner never shows the
"Update available" treatment for the semver gap: alpha's bundled semver only advances when
it is merged into `main`, so it always trails main's latest release right after every merge
even though the running alpha build may already contain newer commits than that release -
flagging that gap as an actionable update would be misleading. It shows the real
"Update available" treatment instead when `alphaBuild.newerBuildAvailable` is true, naming
the newer build number and prompting a pull of the latest `:alpha` image; otherwise the
banner states that alpha is a rolling pre-release channel and, if `newer` is non-empty,
notes how many releases have landed on `main` since this build for context. The sidebar/About
version label itself still distinguishes one alpha build from the next via the build number
(`v0.8.0.7 alpha`), and the release list shows a separate "New since your build - not pulled
yet" section (tagged "Not pulled yet", `alphaBuild.pendingEntries`) above the "Current alpha
build" section (`alphaBuild.entries` - every build entry accumulated so far this cycle,
newest first, not just the one this instance has installed) whenever either is non-empty,
so a newer build's changes are visible without updating first.

`developBuild` (populated only on the `develop` channel, read from `changelog.develop.json`
via `readLocalDevelopChangelog()`) carries the current build version and its rolling cycle
counter, `{ version, build, resetCommit, entries }`. `scripts/rebuild-develop-changelog.js`,
run locally as part of "Push to git" (before the push), fully recomputes the single entry
from every real commit between `resetCommit` and HEAD, rather than appending one entry per
push - there is only ever one entry to read, and it is always current. It also stamps the
build's own version onto every `?v=` public asset reference, so each develop build gets its
own immutable-cache URL. `build` starts at 0 when "Force to main" completes and bumps by one
on every later rebuild that finds real content. `promoteDevelopToAlpha()` clears the current
entry, moves the anchor, and returns the counter to 0 for the new alpha build;
`promoteAlphaToMain()` sets the released version and returns it to 0 for the next cycle.
`describePendingDevelopBuild()` compares versions before build numbers so an older remote
cycle cannot look newer merely because its counter is higher.

Build versions are five numeric segments, `major.minor.patch.alpha.dev`: the released
semver, then alpha builds since that release, then develop builds since the last alpha
build. `scripts/version.js` owns parsing, comparison, and display for them, and
`parseSemver`/`compareSemver` in `routes/maintenance.js` read all five so a pre-release
build can be ordered against another and against the release that follows it. Missing
segments zero-fill, so a four-segment version written by an earlier promotion still means
what it did. Display trims trailing zeros and never goes below three segments, so a release
reads `v1.1.0`, an alpha build `v1.1.0.1`, and a develop build `v1.1.0.0.2`. `package.json`
and `changelog.json` keep the three-segment released semver only, because five segments is
not valid semver. See `docs/decisions.md` entry 18.

## Data layer (`server/src/db.js` + `schema.sql`)

`better-sqlite3` opens `data/plembfin.db` in WAL mode and applies `schema.sql` on
boot. All database access uses prepared statements.

**Cross-process memoization:** derived caches are keyed by monotone versions in
`cache_versions`, polled at most every 500 ms. SQLite triggers advance `history` in the
same transaction as canonical watch-state writes; Discover and Up Next cache writes
advance their separate generations only when the completed derived payload changes.
`bumpDataVersion()`
also supports file-backed derived changes. Provider Up Next feed generations contribute
to the source version used by the queue cache; the next read reloads from SQLite. This
keeps each process's in-memory memoization coherent; persistent file-backed caches use
atomic replacement and re-read their on-disk snapshot when another process updates it.

Gotcha: `getCachedHistory()`, `getCachedMovies()`, and `getCachedShows()` rebuild full
history-derived result sets after invalidation. That is acceptable for current local
install sizes, but large datasets should move hot paths to indexed SQL with
`LIMIT`/`OFFSET` before adding more full-table caches. `PLEKT_DEBUG_CACHE_REBUILDS=1`
reports what each rebuild actually costs and which caller's invalidation caused it.

**Background warm-up** (`server/src/utils/cacheWarmup.js`): so a page request does not pay
those rebuilds, the process that serves the UI polls the history version once a second and,
after startup and once changes have been quiet for 5 seconds (at least every 60 seconds
while they keep arriving), calls the same getters the main pages use: full history, the
dashboard preview, the History page artwork index, TV Shows, Movies, Stats, and the
scheduled-show list behind Upcoming. It is single-flight, yields between caches, abandons
the run if the version moves, and never calls a provider. Before each cache it waits while
API requests are still arriving (any request other than `/api/ping` in the last 50 ms, for
at most 1 second), so page loads go first. The builds themselves also yield: the per-show
grouping pass (`groupShowRowsYielding()` in `dataRepo.js`, used by the show caches, the
dashboard preview, and the artwork index) runs in 25 ms slices, and the tvdb-to-TMDB
lookup in `mediaArtwork.js` reads tvdb ids with SQLite `json_extract` and parses a show's
cached details only when that show is looked up. No single step blocks the server for more
than about 150 ms on a 9,000-row library (it was about 550 ms). Each run logs one
`[cache-warmup]` line with the version, per-cache milliseconds, and whether it was
abandoned. It changes only when caches are built, never what they contain.

Scale behavior: `getCachedHistory()` is uncapped, and the dashboard preview, Stats, and TV
Shows library therefore describe the full history. `MAX_HISTORY_LIMIT` remains an API
pagination safety bound, not a derived-cache ceiling. Full rebuild cost grows with library
size; measured guidance is in [capacity.md](capacity.md).

Concurrent readers share one in-flight `getCachedShows()` rebuild per show-set variant,
and an empty result is cached by version just like a non-empty result. This keeps a burst
of history invalidations from multiplying the synchronous per-show work that feeds the TV
Shows and Upcoming views.

Table-by-table reference: [sqlite-schema.md](sqlite-schema.md).

## Auth (`server/src/utils/auth.js` + `server/src/appConfig.js`)

- Admin login: local username / password. Password is hashed with scrypt (64-byte
  output) and stored in `data/config.json`.
- Session: stateless HMAC-SHA256 signed cookie (`plembfin_session`), 7-day TTL.
  All sessions are revoked instantly by rotating `sessionSecret`.
- API key: 48-hex-char random string, stored in `data/config.json`. Sent as
  `X-Api-Key` header or `Authorization: Bearer`.
- Webhook secret: separate 48-hex-char key, rotatable independently. Sent as
  `X-Plembfin-Webhook-Secret`, `Authorization: Bearer`, or the compatibility
  `?token=` URL parameter.

Full detail: [auth.md](auth.md).

## Frontend state & routing

- One global `state` object in `public/modules/state.js` (no framework), with
  feature code split across `public/modules/` and `app.js` kept to startup,
  routing, shared callbacks, and element binding.
- SPA navigation via `navigateTo(url)` / `handleRouting()` / `history.pushState`.
  Routes: `/` dashboard, `/movies`, `/tvshows`, `/upcoming`, `/discover`, `/watchlist`, `/ratings`, `/playlists` (`/custom-lists` redirects), `/history`, `/stats`,
  `/sync-activity`,
  `/search`, `/settings` and `/settings/:section` (plus `/sync`, `/logs`, and retired
  grouped settings aliases), `/movie/:id`,
  `/movie/tmdb/:id`, `/tvshow/:key(/season/:n(/episode/:n))`, `/tvshow/tmdb/:id`,
  `/tvshow/tvdb/:id`,
  `/person/:id`.
- Auth handled by `onAuthChange()` (`modules/auth.js`) - which checks
  `/api/auth/status`. The auth panel is hidden until a session is confirmed.
- Browser API calls use the HttpOnly session cookie after authentication.
  `fetchAndCacheApiKey()` keeps the integration API key in memory only for
  authenticated display/copy flows; it is not persisted to localStorage.

Full detail: [frontend.md](frontend.md).

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
is marked `no-transform`. `index.html` and managed public assets use safe revalidation
headers; long-lived immutable caching is a separate, not-yet-enabled deployment decision.

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

- `PORT` - HTTP port (default `5056`)
- `DATA_DIR` - data directory (default `<repo>/data`; Docker sets `/data`)
- `ROLE` - `all` (default), `web`, or `worker`; worker mode does not bind HTTP
- `ADMIN_USERNAME` (default `admin`) / `ADMIN_PASSWORD` - admin login. If `ADMIN_PASSWORD` is unset on a brand-new install, a random password is generated and printed once to the server console.
- `API_KEY` - pin the webhook/integration key
- `WEBHOOK_SECRET` - pin the webhook secret used by header/Bearer auth and the compatibility `?token=` URL
- `SESSION_SECRET` - pin the session signing secret
- App-specific variables are named `PLEKT_<NAME>`. Every one is also read under its
  older `PLEKT_<NAME>` name (the new name wins when both are set), through
  `brandEnv()` in `server/src/utils/brandEnv.js`; the server logs one line at boot
  listing any old names in use. New code reads these variables through `brandEnv()`,
  never `process.env.PLEKT_*` directly.
- `PLEKT_CREDENTIAL_KEY` - optional external credential-vault key; otherwise `data/credential.key` is generated
- `PLEKT_PUBLIC_URL` - fixed public origin for provider return links
- `PLEKT_PUBLISHED_PORT` - host port Plekt is published on (5056 in the compose files); used by the startup webhook port advisory (`docs/webhooks.md`), which is skipped when unset
- `PLEKT_MEDIA_AUTH_ENABLED` - account-connection routes, enabled by default; set `false` for manual-only setup
- `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` - optional replacement for the bundled Trakt device application
- `COOKIE_SECURE` - set to `true` when behind an HTTPS reverse proxy
- `LOG_VERBOSE` - set to `true` to include per-request tracing (Plex GUID lookups, search fallbacks, per-phase scheduled-sync narration) in the logs. Off by default; errors and warnings are always logged.
- `WATCHED_PLAYED_SYNC_ENABLED` - set to `false`/`0`/`off` to disable all watched/played propagation (recording still happens)
- `CATCHUP_SYNC_INTERVAL_MS` - how often the catch-up library sync runs inside the scheduler (default 15 minutes)
- `PLEX_UNWATCHED_POLL_INTERVAL_MS` - cadence of Plex's unwatched-reconciliation fallback poll (default 60 seconds); Plex's per-item lookup is a single cheap call
- `EMBY_JELLYFIN_UNWATCHED_POLL_ENABLED` - set to `false` to disable Emby's/Jellyfin's equivalent of the Plex unwatched-reconciliation poll (enabled by default; their per-item lookup, `findEpisode`, costs several outbound requests, so each checked batch is capped lower than Plex's, at `EMBY_LIKE_UNWATCHED_BATCH_SIZE = 5`, and records are checked sequentially rather than concurrently)
- `EMBY_UNWATCHED_POLL_INTERVAL_MS` / `JELLYFIN_UNWATCHED_POLL_INTERVAL_MS` - cadence of that poll (default 5 minutes)
- `WATCHED_THRESHOLD_PERCENT` - playback percentage that counts as watched (default `90`, range 50-100)
- `WATCH_IMPORT_MODE` - default policy for app-marked watched flags: `review` (default), `now`, `release_day`, or `episode_timing`; Settings overrides it
- `PLEX_HISTORICAL_WATCHED_SYNC` - default for sending historical watched items to Plex: `true` (default) or `false`; Settings overrides it. Plex-only, and only for imports, restores, backdated marks, and library-wide pushes
- `MIN_RESUME_POSITION_SEC` - minimum stopped-play position saved as resume progress (default `60`, range 0-3600 seconds)
- `ACTIVE_SESSION_TTL_MIN` - time without a webhook update before an active session is stale (default `5`, range 1-120 minutes)
- `OUTBOUND_TIMEOUT_SEC` - default timeout for outbound media-server requests (default `10`, range 2-120 seconds)
- `PLEX_SERVER_URL` / `PLEX_TOKEN` / `PLEX_USERNAME` / `PLEX_ENABLED` - Plex connection defaults (Settings values take precedence)
- `EMBY_SERVER_URL` / `EMBY_API_KEY` / `EMBY_USER_ID` / `EMBY_ENABLED` - Emby connection defaults
- `JELLYFIN_SERVER_URL` / `JELLYFIN_API_KEY` / `JELLYFIN_USER_ID` / `JELLYFIN_ENABLED` - Jellyfin connection defaults
- `TMDB_API_KEY` - TMDB API key default
- `YOUTUBE_API_KEY` - YouTube Data API key default (trailer metadata)
- `OMDB_API_KEY` - optional OMDb API key; when set, enables IMDb rating badges on media detail pages (free tier: 1,000 req/day from omdbapi.com). Can also be configured in Settings → Metadata → OMDb.
- `TVDB_API_KEY` - optional personal TheTVDB API key for a higher personal rate limit. A built-in project key is used when this is unset. Can also be configured in Settings → Metadata → TheTVDB.
- `TVDB_PROJECT_KEY` - advanced: replace the built-in shared TheTVDB project key (used when no personal key is set). Only needed if the built-in key is revoked or exhausted.
- `FANART_PROJECT_KEY` - advanced: replace the built-in shared Fanart.tv project key. Only needed if the built-in key is revoked or exhausted.
- `FANART_API_KEY` - optional personal Fanart.tv key (raises the rate limit as a `client_key`)
- `PLEKT_DEBUG_OUTBOUND` - set to `1` to log a per-host outbound HTTP request count once a minute (visible in Settings → Logs); for measuring upstream traffic
- `PLEKT_DEBUG_CACHE_REBUILDS` - set to `1` to log one line per derived-cache rebuild (visible in Settings → Logs), recording which cache rebuilt, how long it took, and which generation change it was for. A version bump on its own is free; what costs is a bump that invalidates a cache which is then read
- `PLEKT_DEBUG_SCHEDULER` - set to `1` to log per-step scheduler timing (visible in Settings → Logs): each step's name, where in the tick it started, how long it ran, whether it exhausted its time budget, plus a per-tick summary carrying the achieved interval between tick starts
- `PLEKT_PAUSE_SCHEDULED_WORKER` - set to `1` only for diagnostics that need real-time provider listeners without scheduled sync ticks or background-job polling; the default is off
- `PLEKT_TRAKS_COLLECTOR_ORIGIN` / `PLEKT_TRAKS_SITE_KEY` - optional public-demo Traks configuration; the browser uses first-party `/t` and `/api/event` routes while the collector origin remains server-side. `PLEKT_TRAKS_SCRIPT_URL` is retained as a legacy origin fallback
- `BUILD_CHANNEL` - baked into published Docker images at build time (`release` by default, `alpha` in the `ghcr.io/lasikiewicz/plekt:alpha` image, and `develop` in the `ghcr.io/lasikiewicz/plekt:develop` image); local `npm start` and `npm run dev` default to `develop`, while an explicit value can select another local channel. It controls the channel metadata shown in the sidebar badge, About, and Changelog

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
