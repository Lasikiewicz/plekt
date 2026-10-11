# Plekt Documentation

This directory contains the technical reference for Plekt's current architecture,
behavior, configuration, operations, and integration contracts.

> **System map:** [architecture.md](architecture.md) describes the application flow,
> configuration, data model, and repository file map. The topic documents below define
> the detailed behavior for each subsystem.

## Map

### Core

| Document | Scope |
| --- | --- |
| [architecture.md](architecture.md) | Application flow, repository file map, request flow, configuration, and data model. |
| [frontend.md](frontend.md) | SPA routing, state, module ownership, and data-loading conventions. |
| [sqlite-schema.md](sqlite-schema.md) | SQLite tables, columns, indexes, and migration behavior. |
| [personal-ratings.md](personal-ratings.md) | Canonical personal ratings, one-toggle two-way sync, queue delivery, identity, and Force Sync actions. |
| [personal-watchlist.md](personal-watchlist.md) | Canonical personal watchlist membership, Plex account projection, completion removal, recovery, and status. |
| [development.md](development.md) | Build checks, Git hooks, CI workflows, Docker, and release/versioning. |
| [troubleshooting.md](troubleshooting.md) | Symptom-based diagnosis and operational remedies. |
| [decisions.md](decisions.md) | Why the non-obvious design and release-pipeline calls were made, and what was rejected. |

### Sync engine

| Document | Scope |
| --- | --- |
| [webhooks.md](webhooks.md) | Webhook phases, authentication, event normalization, and propagation. |
| [scheduled-sync.md](scheduled-sync.md) | The minute-by-minute worker, catch-up sync, safeguards, live-session polling, and personal watchlist delivery. |
| [now-playing.md](now-playing.md) | Now Playing data sources, polling, poster resolution, and diagnostics. |

### Platform integrations

| Document | Scope |
| --- | --- |
| [plex.md](plex.md) | Plex client, webhook parsing, WebSocket listener, and account resolution. |
| [emby.md](emby.md) | Emby client, webhook parsing, and catch-up polling. |
| [jellyfin.md](jellyfin.md) | Jellyfin client, webhook plugin, and catch-up polling. |
| [metadata.md](metadata.md) | TMDB, TVDB, Fanart, OMDb, and YouTube data ownership, keys, caches, and TTLs. |

### Pages & features

| Document | Scope |
| --- | --- |
| [dashboard.md](dashboard.md) | Home view, Now Playing, mixed Up Next, and completed watch history. |
| [movies.md](movies.md) | Movies library behavior and API payloads. |
| [tv-shows.md](tv-shows.md) | TV Shows library, progress, next airing, and show identity. |
| [upcoming.md](upcoming.md) | Upcoming calendar, search, and episode air dates. |
| [media-detail.md](media-detail.md) | Movie, show, and person detail pages, watch actions, Seerr, and edit dialogs. |
| [history-search.md](history-search.md) | History page, duplicate handling, and global Search. |
| [stats.md](stats.md) | Stats page and report payload. |
| [posters-artwork.md](posters-artwork.md) | Poster, backdrop, logo, and artwork fetch/cache behavior. |
| [settings.md](settings.md) | Settings routes, connection persistence, maintenance tools, and in-app help. |
| [backups.md](backups.md) | Backup subsystems, restore workflows, and remote destinations. |
| [watch-history-backups.md](watch-history-backups.md) | Watch-history backup format, scheduling, storage, remote copies, and restore behavior. |

### Security

| Document | Scope |
| --- | --- |
| [auth.md](auth.md) | Login, sessions, API key, webhook secret, and audit log. |
| [onboarding.md](onboarding.md) | Pristine-install account claim and the guided `/setup` wizard. |
| [hardening.md](hardening.md) | Production deployment: credentials, HTTPS/reverse proxy, Docker hardening, and rotation. |
| [security-checklist.md](security-checklist.md) | Current authentication, network, container, and secret-handling controls. |

`screenshots/` holds the images embedded in the root README.

## The most important mental model

This is a **self-hosted Node.js application** with no cloud functions or external
database. The default `ROLE=all` deployment runs the web UI, API, and per-minute
scheduler in one `node server/server.js` process. The split Compose profile can run
separate `web` and `worker` roles against the same local SQLite file and media volume;
a SQLite lease elects exactly one scheduler owner.

Data written to the database is always in the same file regardless of where you run
the app. There is no "works locally but not in production" because there is no
separate production environment - you run the binary directly, or in a container
via `docker compose up`.

Common gotchas:
1. **Media server reachability** - Plekt contacts Plex/Emby/Jellyfin from the
   machine it runs on, not from the browser. A URL that the browser can reach but
   the server cannot (e.g. a different LAN segment or a VPN-gated address) will
   fail silently for the background sync while appearing fine in the UI probe.
2. **Webhook secret in URL** - The webhook endpoint requires `?token=<webhookSecret>`
   in the URL. Omitting it returns 401. Copy the full URL from Settings → Media servers → Webhooks.
3. **Config persistence** - Credentials and settings are stored in `data/config.json`
   (generated on first boot) and in the `settings` SQLite row. The Docker volume mount
   at `/data` must be persistent across container restarts or settings will reset.
