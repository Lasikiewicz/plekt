# Security Checklist

This page describes the security controls that apply to a Plekt deployment and
the checks to complete before exposing it beyond a trusted local network.

## Authentication and sessions

- Browser administration routes require an authenticated administrator session.
- Webhook mutations require the configured webhook token.
- API integrations authenticate with `X-Api-Key` or
  `Authorization: Bearer <API_KEY>`; API keys are not accepted in query strings.
- Login, webhook, artwork-proxy, and profile-proxy routes have rate limits.
- Session cookies use `COOKIE_SECURE=true` when the instance is served through HTTPS.
- Sessions expire after seven days. **Revoke All Sessions** rotates the session secret
  and invalidates existing cookies.
- The audit log records login outcomes, credential changes, session revocation, settings
  changes, media deletion, and backup restores.

## Request and network protection

- Responses include clickjacking, MIME-sniffing, referrer, content-security, and
  frame-ancestor protections.
- Configured outbound URLs must use `http:` or `https:`. Outbound requests pass through
  the shared timeout, redirect, and URL-validation boundary.
- Plex and YouTube credentials are sent in request headers rather than URL query
  parameters.
- Tautulli is the compatibility exception: its REST API uses the `apikey` query
  parameter on supported older versions. Protect Tautulli and reverse-proxy access
  logs accordingly; Plekt does not write outbound URLs to its own diagnostics.
- Webhook access logs redact sensitive query parameters.
- Configured media-server URLs are administrator-controlled destinations; keep the
  Plekt administration surface behind a trusted network, VPN, or authenticated
  reverse proxy.

## Container and filesystem controls

- The Docker image runs as the non-root `plekt` user and exposes a health check at
  `/api/ping`.
- `docker-compose.secure.yml` supplies a read-only root filesystem, a `/tmp` tmpfs,
  required secrets, and `COOKIE_SECURE=true`.
- `data/config.json` is written with owner-only permissions where the filesystem
  supports them.
- Credentials, tokens, and provider settings are stored under `data/`; they are not
  included in watch-history backup files.
- `.env`, `data/`, and development dependencies are excluded from the Docker build
  context and Git tracking.

## Before internet exposure

1. Set unique values for `ADMIN_PASSWORD`, `SESSION_SECRET`, `API_KEY`, and
   `WEBHOOK_SECRET`.
2. Put the service behind HTTPS or a private VPN and set `COOKIE_SECURE=true`.
3. Keep each webhook URL private; rotate `WEBHOOK_SECRET` if a URL is exposed.
4. Mount a persistent `/data` volume and verify both local and remote backup recovery.
5. Run `npm run docs:check`, `npm audit --omit=dev --audit-level=high`, and
   `npm run build` before publishing an image.
