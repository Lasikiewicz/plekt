# Hardening Guide

Database commands below use `data/plekt.db` for a fresh install. If `data/plembfin.db`
exists, use that existing file instead; do not let SQLite create a new empty database.
Docker commands use the fresh-install container name `plekt`; substitute your existing
container name when upgrading.


A practical checklist for running Plekt securely in production.

---

## 1. Credentials

| What | Recommendation |
|------|----------------|
| Admin password | Fresh installs get a random password generated on first boot (printed once to the server console) - record it before it scrolls off. Set your own via `ADMIN_PASSWORD` or **Settings → General → Account**. Minimum 12 characters. |
| `SESSION_SECRET` | Pin to a random 32+ char string via env var. Auto-generated value is fine for single-host installs. |
| `API_KEY` | Pin if you share the key with external scripts or Home Assistant. |
| `WEBHOOK_SECRET` | Rotate via **Settings → Media servers → Webhooks → Rotate Secret** after any suspected exposure. |

Generate a strong secret:

```bash
openssl rand -hex 32
```

---

## 2. HTTPS and reverse proxy

Plekt speaks plain HTTP. Always place it behind a TLS-terminating reverse proxy when accessible over the internet.

### Caddy (recommended - auto TLS)

```caddyfile
plekt.example.com {
    reverse_proxy localhost:5056
}
```

### NGINX

```nginx
server {
    listen 443 ssl;
    server_name plekt.example.com;
    ssl_certificate     /etc/letsencrypt/live/plekt.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/plekt.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5056;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Traefik

Label the Docker service:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.plekt.rule=Host(`plekt.example.com`)"
  - "traefik.http.routers.plekt.entrypoints=websecure"
  - "traefik.http.routers.plekt.tls.certresolver=letsencrypt"
```

### Cloudflare Tunnel

```bash
cloudflared tunnel route dns <tunnel-id> plekt.example.com
```

Then point the tunnel to `http://localhost:5056`.

### Enable the Secure cookie flag

Once HTTPS is in place, set `COOKIE_SECURE=true` in your environment. This adds `Strict-Transport-Security` and the `Secure` attribute to the session cookie, preventing it from being sent over HTTP.

### Transport behavior

Plekt is self-hosted: it can run directly on a host, in Docker, or behind a reverse
proxy chosen by the operator. The application compresses eligible responses when the client
advertises gzip, keeps `index.html` and managed static assets on safe revalidation headers,
and deliberately does not compress the authenticated `text/event-stream` live-update
connection. A proxy must pass through an already encoded response and must not recompress
responses marked `no-transform`; its own buffering and compression settings remain the
operator's responsibility.

---

## 3. Docker hardening

The base `docker-compose.yml` pulls the published image and requires an admin password.
The secure overlay adds `no-new-privileges` and CPU/memory limits.

For a fully hardened setup use the secure overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d
```

The overlay adds:

- **Read-only root filesystem** - the container cannot write to `/` except `/tmp` (tmpfs) and `/data` (volume).
- **Required env vars** - `ADMIN_PASSWORD`, `SESSION_SECRET`, `API_KEY`, and `WEBHOOK_SECRET` must be set or Compose refuses to start.
- **`COOKIE_SECURE=true`** - enforced automatically.

Create a `.env` file (never commit it):

```dotenv
ADMIN_PASSWORD=your-strong-password-here
SESSION_SECRET=<openssl rand -hex 32>
API_KEY=<openssl rand -hex 32>
WEBHOOK_SECRET=<openssl rand -hex 32>
```

---

## 4. Webhook setup

Keep your webhook URL private. It contains a secret token that authorises write access to your watch history.

```
https://plekt.example.com/api/webhook?token=<WEBHOOK_SECRET>
```

- Configure this URL inside each media server (Plex, Emby, Jellyfin).
- If the token is ever exposed, rotate it in **Settings → Media servers → Webhooks → Rotate Secret**. Rotations take effect immediately; update all media servers afterwards.

---

## 5. Backups

The entire application state lives in two locations:

| What | Path |
|------|------|
| SQLite database | `data/plekt.db`, or existing `data/plembfin.db` |
| Cached artwork | `data/media/` |
| Config + secrets | `data/config.json` |

For filesystem-level backups, stop the container before copying `data/` so SQLite can
checkpoint the WAL files cleanly. For online backups, use the built-in
**Settings → Backup / restore** systems (see [backups.md](backups.md)) or snapshot the database
with SQLite itself:

```bash
sqlite3 data/plekt.db "VACUUM INTO 'backup.db'"
```

Restore: unzip a backup archive into `data/` and restart the container.

---

## 6. Updates

```bash
docker compose pull
docker compose up -d
```

Schema migrations run automatically on startup. No manual steps required.

Subscribe to GitHub release notifications to be alerted of security patches.

---

## 7. Monitoring

The `/health` endpoint returns HTTP 200 with the process role, database status, and
non-sensitive worker availability/heartbeat ages. Use it as a liveness check and
alert separately when `worker.available` is false.

## Multi-process constraints

`ROLE=all` remains the default. `ROLE=web` and `ROLE=worker` may share one `DATA_DIR`
only when every process runs on the same host and local filesystem. SQLite WAL on
NFS, SMB, clustered volumes, or separate hosts is unsupported. All web replicas must
share `SESSION_SECRET`, `API_KEY`, and `WEBHOOK_SECRET`. Stop every old-version
process before upgrading; mixed-version rolling deployments are unsupported. To
roll back operationally, stop the split services and restart one `ROLE=all` process.
The additive coordination tables may remain in the database.

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:5055/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

---

## 8. Secret rotation

| Secret | How to rotate |
|--------|---------------|
| Admin password | **Settings → General → Account → Admin login** |
| Webhook token | **Settings → Media servers → Webhooks → Rotate Secret** |
| Session secret | Set a new `SESSION_SECRET` env var and restart - invalidates all sessions |
| API key | Set a new `API_KEY` env var and restart - update any external integrations |
