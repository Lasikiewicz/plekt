<p align="center">
  <img alt="Plekt" src="https://raw.githubusercontent.com/Lasikiewicz/plekt/main/public/plekt_header_logo_light.png" width="600">
</p>

**Plekt** keeps your watch history in sync across Plex, Emby, Jellyfin, and Trakt.
Your media servers don't talk to each other; Plekt remembers what you've watched and
keeps every one of them up to date.

[Website](https://plekt.net) ·
[Documentation](https://github.com/Lasikiewicz/plekt/blob/main/docs/README.md) ·
[Changelog](https://github.com/Lasikiewicz/plekt/blob/main/CHANGELOG.md) ·
[Source and issues](https://github.com/Lasikiewicz/plekt) ·
[Discord](https://discord.gg/7ZmEGKcRC5) ·
[Reddit](https://www.reddit.com/r/plembfin/) ·
[Public demo](https://demo.plembfin.com/) (`demo` / `demo`)

> Plekt writes watched state and playback progress to your connected media servers.
> Back up first (Settings > Backup > Local).

## What it does

- **Two-way sync** of watched and unwatched state across Plex, Emby, Jellyfin, and Trakt
- **Cross-platform resume**: pause on one server, carry on from the same spot on another
- **Rewatch tracking** with a full multi-watch history, stored locally in SQLite
- **Now Playing dashboard**, Up Next, watch history, and in-depth stats
- **Watch list, playlists, and ratings**, optionally synced with your media servers and Trakt
- **Rich metadata** from TMDB, TheTVDB, Fanart.tv, and OMDb, with a local artwork cache
- **Overseerr / Jellyseerr** requests straight from detail pages
- **Automated backups**, local and optionally offsite to Backblaze B2
- **Self-hosted and private**: runs entirely on your own hardware

![Plekt dashboard](https://plekt.net/assets/app-captures/dashboard-home-modern-light.png)

## Quick start (Docker Compose)

1. Create a `.env` file beside the Compose file with a unique admin password:
   ```dotenv
   ADMIN_PASSWORD=
   ```
2. Create `docker-compose.yml`:
   ```yaml
   services:
     plekt:
       image: plembfin/plekt:latest
       container_name: plekt
       ports:
         - "5056:5055"
       volumes:
         - ./data:/data
       environment:
         ADMIN_USERNAME: admin
         ADMIN_PASSWORD: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env before starting}"
       restart: unless-stopped
   ```
3. Run `docker compose up -d`, open `http://localhost:5056`, and log in. A setup wizard
   walks you through connecting your media servers, metadata, webhooks, and Trakt.

On **Docker Desktop for macOS or Windows**, use a named volume (`plekt-data:/data`)
instead of a folder bind mount; bind mounts there can corrupt the SQLite database under
heavy writes. Linux hosts are not affected.

For a hardened setup (read-only filesystem, required secrets, secure cookies), see the
[hardening guide](https://github.com/Lasikiewicz/plekt/blob/main/docs/hardening.md).

## Tags

| Tag | What it is |
|---|---|
| `latest` | The newest tested release (recommended) |
| `<version>`, for example `1.3.0` | A specific release, for pinning |

Images are built for `linux/amd64` and `linux/arm64`. Pre-release `alpha` and `develop`
builds are published only on GitHub Container Registry at `ghcr.io/lasikiewicz/plekt`.

## Configuration

| Setting | Purpose |
|---|---|
| Container port `5055` (host example: `5056`) | Web UI and API |
| Volume `/data` | Database, artwork cache, logs, and backups. Keep it on persistent storage. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The first admin account |

Every other setting is in the
[full documentation](https://github.com/Lasikiewicz/plekt/blob/main/docs/README.md).

## Moving from Plembfin

Change only the image from `plembfin/plembfin` to `plembfin/plekt`, keeping the same tag, volume and settings. Both old image names receive updates for at least six months after the rebrand release. Existing databases, sign-in, provider connections, environment variables and webhook-secret headers remain supported. New backups use Plekt names and do not restore on older builds. This overview is prepared locally for the unreleased rebrand; publication and new registry targets still require live verification.
