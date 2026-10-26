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
media folder (`data/media/`). When additional accounts are added (`data/users.json`), the
same single Node process serves every user: each non-admin user gets an isolated
`data/users/<name>/` folder (`plekt.db`, `config.json`, `credential.key`) while sharing
artwork in `data/media/` and provider metadata caches and API keys in
`data/shared-metadata.db`. There is no external database, no cloud functions, and no
separate production environment.

What the app does: it receives play/stop/scrobble **webhooks** from Plex, Emby, and
Jellyfin, records watch history, and **propagates watched/unwatched state and resume
progress to the other platforms** so all three stay in sync. On top of that it provides
a dashboard (Now Playing + recent history), Movies/TV Shows library browsers, a stats
page, an upcoming-episodes calendar, rich media detail pages (TMDB/TVDB metadata,
cast, trailers, artwork), Jellyseerr/Overseerr requesting, and a backup system.
Personal ratings are a separate optional domain: Plekt remains their local
canonical store, while a durable rating queue can exchange ratings with Plex, Emby,
Jellyfin, Trakt, and Simkl. Simkl reads stored library-check observations and guards
outbound ratings against watched-state/list side effects.
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
| API routing | `server/src/index.js` (`dispatch()` route table) plus the owning `server/src/routes/*.js` module | [architecture-flows.md](architecture-flows.md#request-flow), [code-index.md](code-index.md) |
| Webhook parsing or phases | `server/src/utils/parsers.js`, `handleWebhook` in `server/src/routes/sync.js` | [webhooks.md](webhooks.md) |
| Watched/unwatched propagation between platforms | `server/src/utils/syncOrchestrator.js`, platform clients | [webhooks.md](webhooks.md) |
| Per-provider historical watched-sync policy and outcomes | `server/src/utils/watchSyncPolicy.js`, `public/modules/plex-history-policy.js` | [settings.md](settings.md), [decisions.md](decisions.md) |
| Plex API calls, Plex WebSocket listener | `server/src/utils/plexClient.js`, `plexNotificationListener.js` | [plex.md](plex.md) |
| Emby API calls | `server/src/utils/embyClient.js` | [emby.md](emby.md) |
| Jellyfin API calls | `server/src/utils/jellyfinClient.js` | [jellyfin.md](jellyfin.md) |
| Background/scheduled sync, catch-up sync, provider Up Next feeds | `server/src/scheduler.js`, `server/src/scheduled.js`, `server/src/utils/upNextRepository.js` | [scheduled-sync.md](scheduled-sync.md) |
| Now Playing (dashboard live sessions) | `handleNowPlaying` in `server/src/routes/sync.js`, `server/src/utils/liveSessions.js`, `liveSessionPoller.js`, `activeSessions.js`, `public/modules/sync.js` | [now-playing.md](now-playing.md) |
| Dashboard rendering | `public/modules/dashboard.js` | [dashboard.md](dashboard.md) |
| Up Next queue, provider push, dismissals and dropped titles | `public/modules/up-next.js`, `dropped-titles.js`, `dropped-title-views.js`, `server/src/routes/droppedTitles.js`, `server/src/utils/droppedTitles.js`, `upNextService.js`, `upNextProviderSync.js`, `upNextRailSeed.js`, `upNextSeedLedger.js`, `upNextDismissals.js`, `upNextLibraryLookup.js` | [dashboard.md](dashboard.md) |
| Settings changelog channels | `public/modules/changelog-channels.js`, `handleChangelog` in `routes/maintenance.js` | [development.md](development.md#changelog-and-update-check) |
| Sidebar sync indicator, Sync Activity page | `public/modules/status-indicators.js`, `public/modules/sync-activity.js`, `handleSyncHistory` / `handleSyncActivity` in `routes/sync.js` | [dashboard.md](dashboard.md) |
| Movies library page | `public/modules/explorer.js`, `queryMovies` in `dataRepo.js` | [movies.md](movies.md) |
| TV Shows library page | `public/modules/explorer.js`, `queryShows`, `showProgressCache.js`, `nextAiringCache.js` | [tv-shows.md](tv-shows.md) |
| Upcoming episode calendar | `public/modules/upcoming.js`, `handleUpcoming` in `routes/metadata.js`, `upcomingCalendarCache.js`, `nextAiringCache.js` | [upcoming.md](upcoming.md) |
| Movie/show/person detail pages | `public/modules/media-detail*.js`, `media-person.js` | [media-detail.md](media-detail.md) |
| Personal media pages | `public/modules/personal-media.js`, `public/modules/playlists.js`, `public/modules/personal-media-metadata.js`, `handlePersonalMedia` in `routes/personal.js` | [frontend.md](frontend.md) |
| Personal rating sync | `server/src/utils/personalRatingSync.js`, `personalRatingRepository.js`, provider clients, `public/modules/rating-sync-settings.js` | [personal-ratings.md](personal-ratings.md) |
| Rating snapshot validation | `server/src/utils/ratingSnapshotSafety.js` validates provider response shape and page completeness before missing-rating reconciliation | [personal-ratings.md](personal-ratings.md) |
| Plex watchlist sync | `server/src/utils/personalWatchlistSync.js`, `plexWatchlistClient.js`, `routes/watchlistSync.js`, `public/modules/watchlist-sync-settings.js` | [personal-watchlist.md](personal-watchlist.md), [scheduled-sync.md](scheduled-sync.md#plex-watchlist-scheduler) |
| History page, Search page | `public/modules/explorer.js`, `handleHistory` in `routes/media.js`, `handleMediaSearch` in `routes/metadata.js` | [history-search.md](history-search.md) |
| Stats page | `public/modules/stats.js`, `getWatchStats` in `dataRepo.js` | [stats.md](stats.md) |
| TMDB/TVDB/Fanart/OMDb metadata | `server/src/routes/metadata.js`, `server/src/utils/tmdbGateway.js`, `tvdbGateway.js`, `fanartGateway.js`, `omdbGateway.js`, `sharedMetadataStore.js` | [metadata.md](metadata.md) |
| Posters, backdrops, logos, artwork caching | `server/src/utils/posterCache.js`, `server/src/utils/mediaArtwork.js`, `routes/seasonArtwork.js`, `handlePoster` in `routes/metadata.js`, `public/modules/images.js`, `public/modules/season-posters-panel.js` | [posters-artwork.md](posters-artwork.md), [media-detail.md](media-detail.md) |
| Backups (all three subsystems) | `server/src/routes/backups.js`, `server/src/utils/backup.js`, `watchHistoryBackups.js`, `plektBackups.js`, `plektRestore.js`, `server/src/routes/plektRestore.js`, `backupDestinations/`, `public/modules/tools-backups.js` | [backups.md](backups.md) |
| Settings pages, connection config | `server/src/routes/admin.js`, `server/src/utils/configStore.js`, `public/modules/settings-shell.js`, `public/modules/settings-ui.js`, `public/modules/settings-services.js`, `public/modules/rating-sync-settings.js`, `public/modules/tools-backups.js` | [settings.md](settings.md) |
| Login, sessions, API key, webhook secret, multi-user accounts | `server/src/utils/auth.js`, `server/src/appConfig.js`, `server/src/routes/users.js`, `server/src/utils/tenancy.js`, `userContext.js`, `tenantDatabase.js`, `tenantRouting.js`, `public/modules/auth.js`, `supervisor-switch.js`, `settings-users.js` | [auth.md](auth.md) |
| Pristine-install account claim, guided `/setup` wizard, recommended setup tasks and Finish Setup reminder | `server/src/routes/onboarding.js`, `server/src/utils/onboardingStore.js`, `onboardingImportCoordinator.js`, `public/modules/onboarding.js` | [onboarding.md](onboarding.md) |
| SPA routing, view switching, module layout | `public/app.js`, `public/modules/state.js`, `app-events.js` | [frontend.md](frontend.md) |
| Database tables and their meaning | `server/src/schema.sql`, `server/src/db.js` | [sqlite-schema.md](sqlite-schema.md) |
| Build check, CI, Docker, release/changelog pipeline | `scripts/`, `.github/workflows/`, `Dockerfile` | [development.md](development.md) |
| Production security posture | - | [hardening.md](hardening.md), [security-checklist.md](security-checklist.md) |
| "Something is broken, where do I look?" | - | [troubleshooting.md](troubleshooting.md) |

Frontend module placement rules, file-size limits, module ownership, and dependency
direction are defined in [frontend.md](frontend.md).

## Where to look first

Start here for "where is X?" questions: open the named file, then Grep the symbol inside
it. Route paths and exported names per file are in the generated
[code-index.md](code-index.md).

| Task | Owning files | Topic doc |
| --- | --- | --- |
| API routes | `server/src/index.js` (`dispatch()`), the owning `server/src/routes/*.js` module | [code-index.md](code-index.md), [architecture-flows.md](architecture-flows.md#request-flow) |
| Webhooks in | `handleWebhook` in `server/src/routes/sync.js`, `server/src/utils/parsers.js` | [webhooks.md](webhooks.md) |
| Sync and dispatch to media servers | `server/src/utils/syncOrchestrator.js`, `syncDispatchQueue.js`, `plexClient.js`, `embyClient.js`, `jellyfinClient.js` | [webhooks.md](webhooks.md), [scheduled-sync.md](scheduled-sync.md) |
| Trackers (Trakt, Simkl) | `server/src/utils/trackers/` (`trakt.js`, `traktClient.js`, `simkl*.js`), `trackerWriteIntents.js`, `trackerIntentWorker.js`, `trackerDispatcher.js`, `server/src/routes/trackerAuth.js`, `simklAuth.js`, `public/modules/tracker-settings.js` | [settings.md](settings.md), [scheduled-sync.md](scheduled-sync.md), [auth.md](auth.md) |
| Scheduler | `server/src/scheduler.js`, `server/src/scheduled.js`, `server/src/workerCoordinator.js` | [scheduled-sync.md](scheduled-sync.md) |
| Metadata providers | `server/src/routes/metadata.js`, `server/src/utils/tmdbGateway.js`, `tvdbGateway.js`, `fanartGateway.js`, `omdbGateway.js`, `sharedMetadataStore.js` | [metadata.md](metadata.md) |
| Artwork and the image cache | `server/src/utils/posterCache.js`, `mediaArtwork.js`, `server/src/routes/seasonArtwork.js`, `public/modules/images.js` | [posters-artwork.md](posters-artwork.md) |
| Database, migrations, derived caches | `server/src/schema.sql`, `server/src/db.js`, `server/src/utils/dataRepo.js`, `cacheWarmup.js` | [sqlite-schema.md](sqlite-schema.md) |
| Auth and multi-user tenancy | `server/src/utils/auth.js`, `server/src/appConfig.js`, `server/src/routes/users.js`, `server/src/utils/tenancy.js`, `userContext.js`, `tenantDatabase.js`, `tenantRouting.js`, `public/modules/auth.js`, `supervisor-switch.js`, `settings-users.js` | [auth.md](auth.md) |
| Frontend modules and routing | `public/app.js`, `public/modules/state.js`, `public/modules/route-modules.js` | [frontend.md](frontend.md), [agent-modules.md](agent-modules.md) |
| Settings | `server/src/routes/admin.js`, `server/src/utils/configStore.js`, `public/modules/settings-shell.js`, `settings-services.js`, `settings-ui.js` | [settings.md](settings.md) |
| Backups and restore | `server/src/routes/backups.js`, `server/src/routes/plektRestore.js`, `server/src/utils/backup.js`, `plektBackups.js`, `plektRestore.js`, `watchHistoryBackups.js`, `public/modules/tools-backups.js` | [backups.md](backups.md) |
| Releases, changelog, update check | `scripts/promote-develop-to-alpha.js`, `promote-alpha-to-main.js`, `rebuild-develop-changelog.js`, `.github/workflows/`, `handleChangelog` in `server/src/routes/maintenance.js` | [development.md](development.md#changelog-and-update-check) |
| Server runtime (headers, rate limits, logging, shutdown, outbound HTTP) | `server/server.js`, `server/src/utils/httpPerformance.js`, `outbound.js` | [architecture-flows.md](architecture-flows.md) |
| Environment variables | `.env.example`, `server/src/utils/brandEnv.js`, `configStore.js` | [README Configuration Reference](../README.md#configuration-reference), [architecture-flows.md](architecture-flows.md#environment-variables) |
| Force Sync planning and sync health | `server/src/utils/forceSyncPlanner.js`, `forceSyncExecutor.js`, `syncPlans.js`, `libraryForceSync.js`, `outboundGovernor.js` | [architecture-flows.md](architecture-flows.md#synchronization-safety-modules) |

## More detail

- File map, one row per file: [file-map-server.md](file-map-server.md) (`server/`,
  `server/src/routes/`, `server/src/utils/`), [file-map-public.md](file-map-public.md)
  (`public/`, `public/modules/`), [file-map-repo.md](file-map-repo.md) (repository root,
  `.github/`, `docs/`, `scripts/`, `test/`, retired Reddit app).
- Routes and exported names per source file: [code-index.md](code-index.md) (generated).
- Server-wide runtime behaviour with no feature owner: [architecture-flows.md](architecture-flows.md).
- Topic docs: the Source column of the subsystem map above, and the documentation index
  in [README.md](README.md).
