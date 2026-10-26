# Authentication & Security

Plekt is a private, self-hosted web app with no remote phone-home or external auth
dependencies. All access is controlled locally.

## Threat model & access tiers

| Tier | Authentication | Scope |
| --- | --- | --- |
| **Anonymous** | None | Static assets, `/api/ping`, `/api/setup/status`, `/api/auth/status`, one-time `/api/auth/claim`, `/api/calendar-feed.ics` (scoped by signed HMAC token) |
| **API key** | `X-Api-Key: <key>` or `Authorization: Bearer <key>` | Full programmatic access to read and write data; cannot initiate interactive OAuth flows |
| **Session cookie** | HttpOnly signed cookie (`SameSite=Lax`) | Full interactive access to the web dashboard and settings |

There are no public user accounts, registrations, or multi-tenant boundaries. A single
password protects the entire instance.

## The four credentials

| Credential | Purpose | Storage | Rotation |
| --- | --- | --- | --- |
| Admin username + password | Dashboard login (and multi-user management) | scrypt hash (64-byte output) in `data/config.json` (`ADMIN_USERNAME`/`ADMIN_PASSWORD` env override until credentials are managed in-app); non-admin user password hashes live in `data/users.json` | Settings → General → Account (or Settings → Users) |
| Session secret | Signs the `plembfin_session` cookie | `data/config.json` (`SESSION_SECRET` pins it) | Rotating it (credential change, revoke-all, env change + restart) invalidates every session at once |
| API key | Integrations/automation: `X-Api-Key` or `Authorization: Bearer` | 48-hex-char random string in `data/config.json` (`API_KEY` pins the admin key; each non-admin user gets their own generated key in `data/users/<name>/config.json`) | Set a new `API_KEY` and restart (admin) |
| Webhook secret | Authorizes `/api/webhook` (admin) or `/u/<name>/api/webhook` (per user) | Separate 48-hex-char key in `data/config.json` (`WEBHOOK_SECRET` pins the admin secret) or `data/users/<name>/config.json` | Settings → Media servers → Webhooks → Rotate Secret (`POST /api/auth/webhook-secret`) - independent of everything else |

First boot: if `ADMIN_PASSWORD` is unset and the instance has no prior in-app credentials,
media connection, watch history, or configured metadata key, it's treated as pristine and
**no password is generated at all**. The app shows a one-time **Claim this Plekt
instance** screen instead of sign-in; `POST /api/auth/claim` sets the administrator
username/password atomically (inside a SQLite immediate transaction guarding
`accountClaimed`, so two simultaneous claims can't both win) and behaves like
`POST /api/login` (issuing the session cookie and audit-logging `claim.success`).

Auto-generation (non-pristine installs without explicit credentials): if `ADMIN_PASSWORD`
is unset on a database that already has data, a secure 20-character password is generated
and printed to stdout/stderr once. All four credentials default to random secure values
persisted in `data/config.json` if not provided via environment variables.

When credentials are changed from Settings or all sessions are revoked,
`authManagedInApp: true` is written to `data/config.json`. Once that flag is present,
in-app changes win over the startup `ADMIN_USERNAME` and `ADMIN_PASSWORD` env vars. The
server logs a `[security]` notice if those env vars are set but inactive; remove
`authManagedInApp` from `data/config.json` to restore env-var control.

## Single-process multi-user sign-in & switching

All accounts share one login form (`POST /api/login`) and one Node process:

- **Install admin**: verified against `data/config.json` (`ADMIN_USERNAME` / `passwordHash`). Receives a session cookie with `role: "admin"` and `activeUser: "admin"`.
- **Delegated administrators**: verified against `data/users.json` like other users, but receive `role: "admin"` while keeping their own tenant as `activeUser`. Their account stays in `data/users/<name>/`; promotion and demotion revoke existing sessions.
- **Standard users**: verified against `data/users.json` (`passwordHash` + not `disabled`). Receives a session cookie with `role: "user"` and `activeUser: "<name>"`.
- **Unprefixed `/api/*` requests**: `server/server.js` inspects the session cookie's `activeUser` (`resolveSessionTenantContext`) and wraps `dispatch()` in `runWithUserContext(activeUser, ...)` so the browser SPA works at `/` for both the admin and any signed-in or switched-into user without changing frontend route paths.
- **Prefixed `/u/<name>/api/*` requests**: used by webhooks (`/u/<name>/api/webhook`) and API-key integrations. A non-admin user's session cookie is rejected with `403 FORBIDDEN` on another user's `/u/<other>/api/*` path; the admin session can reach any running tenant. A stopped user returns `503 INSTANCE_STOPPED`.
- **Administrator user switching**: the account picker stays available to admin sessions while viewing another user's workspace. `POST /api/users/manage` with `{ action: "open", name }` changes `activeUser` while preserving the administrator's login identity, writes an audit entry in the target user's database, and returns `{ ok: true, path: "/setup" | "/" }` based on whether that user has completed or dismissed `/setup`.
- **Settings → General → Account**: when a non-admin user is signed in (`role: "user"`), or when the admin is viewing a non-admin user's workspace (`supervised: true`), the root-admin credential/revoke-all card is replaced by a self-service password form (`POST /api/users/password`) that requires the user's current password.
- **Settings access**: a non-admin, including the admin while viewing a non-admin user's workspace, can edit that user's account password, appearance, media-server and personal connection settings, and webhook secret. The Users menu, shared provider keys, install settings, and maintenance sections stay unavailable in that workspace. The UI hides those sections and `POST /api/config` rejects non-admin changes outside the user's connection sections.
- The install admin can grant or remove delegated administrator access from **Settings → Users**. Delegated administrators can open any account, manage users, and access admin-only settings. Their own account data stays in its tenant folder; the install admin account remains protected.

## Sessions

- Stateless: the cookie value is `base64url(payload).hmacSHA256(payload,
  sessionSecret)` with `{ u, role, activeUser, iat }` inside; 7-day TTL checked on verify.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`,
  path `/`.
- Revocation: rotating `sessionSecret` (`POST /api/auth/sessions/revoke-all`) invalidates every cookie across the install and issues the admin caller a fresh cookie. For an individual non-admin user, the admin can click **Sign out now** or **Disable sign-in** in **Settings → Users**, which updates `sessionsValidAfter` / `disabled` in `data/users.json` and immediately invalidates that user's existing cookies.

## Provider credentials

Media-server, Trakt and Simkl access/refresh tokens are encrypted with AES-256-GCM before they
enter SQLite. Plekt uses `PLEKT_CREDENTIAL_KEY` when provided (admin context only); otherwise it creates
`data/credential.key` for the admin and `data/users/<name>/credential.key` for each non-admin user.
The generated key is not included in database or application
backups, so a restore containing encrypted provider connections also needs the original
key. Passwords entered for Emby or Jellyfin are used only for the authorization request
and are never persisted.

Plex authentication uses ephemeral cryptographic keypairs generated during the
auth flow: the private key never leaves memory, and the public key is sent to
Plex.tv for token delivery.

Tokens are automatically refreshed by the background scheduler before they expire. If a
refresh fails, Plekt retries with exponential backoff and marks the connection as
`reauth_required` if the provider explicitly revokes access.

## CSRF protection

All state-changing routes (`POST`, `PUT`, `DELETE`, `PATCH`) enforce CSRF defense:

1. **Origin check**: the `Origin` header (or `Referer` fallback) must match the server's
   host and port. Requests without either header are rejected, except when authenticated
   via API key (which browsers cannot send cross-origin without CORS preflight).
2. **SameSite=Lax**: session cookies are not sent on cross-site subrequests (images,
   fetch, XHR). Top-level cross-site navigations send cookies but only with `GET`, which
   cannot trigger mutations.

Interactive OAuth flows (Trakt device flow, Plex PIN flow) use short-lived flow tokens
tied to the administrator session that initiated them. Flows cannot be completed by
unauthenticated callers.

## Brute-force & rate limiting

- `POST /api/login` and `POST /api/auth/claim` are limited to **10 attempts per 15-minute
  window per IP**. Exceeding the limit returns `429 Too Many Requests`.
- Webhook endpoints are limited to **60 requests per minute per IP**.
- Failed logins log a `login.failure` event with the client IP to `audit_log`.
- Successful logins log `login.success` and clear the failed attempt counter for that IP.
- Rate-limit state is kept in memory with periodic cleanup of expired buckets. It does not
  survive server restarts.

## Request authentication

`requireAdmin(req, res)` (used by nearly every handler in `index.js`) accepts either:

1. a valid `plembfin_session` cookie, or
2. the active user's API key via `X-Api-Key` or `Authorization: Bearer` (query-parameter API keys
   are deliberately **not** accepted; non-admin API keys must be sent to `/u/<name>/api/*`)

and 401s otherwise. `resolveAdminPrincipal` is the no-response variant. Routes that manage
the whole install (`/api/users`, `/api/users/manage`, `/api/auth/credentials`,
`/api/auth/sessions/revoke-all`) additionally check that the caller's session `role` is `"admin"`.

The webhook endpoint authenticates separately with `verifyWebhookToken` - see
[webhooks.md](webhooks.md). Timing-safe comparison is used for every secret check.

The read-only `/api/calendar-feed.ics?token=…` endpoint is the exception to login/API-key
auth. Its token is an HMAC-SHA256 signature of the user's feed parameters, signed by the
server's `SESSION_SECRET` with an embedded issue timestamp and salt (`CALENDAR_FEED_SALT`).
The access logger redacts the `token` query parameter.

## API surface & route map

| Route | Handler | Notes |
| --- | --- | --- |
| `POST /api/login` | `handleLogin` | Rate-limited 10/15min per IP; signs in admin or any enabled user in `users.json`; audit-logged success/failure |
| `POST /api/logout` | `handleLogout` | Clears the cookie |
| `GET /api/auth/status` | `handleAuthStatus` | `{ authenticated, username, role, activeUser, supervised, webhookPath, mustChangePassword, claimRequired }` - never 401s |
| `POST /api/auth/claim` | `handleAuthClaim` | One-time pristine-install account claim; public route, rate-limited and origin-checked like login, with an artificial delay |
| `GET /api/auth/apikey` | `handleAuthApiKey` | Returns the active user's API key; fetched on demand by the UI |
| `GET/POST /api/auth/webhook-secret` | `handleAuthWebhookSecret` | GET returns the active user's webhook secret, POST rotates it |
| `POST /api/auth/credentials` | `handleAuthCredentials` | Admin-only (in root context); requires current password; rotates session secret; re-issues cookie |
| `POST /api/auth/sessions/revoke-all` | `handleRevokeAllSessions` | Admin-only (in root context); global session invalidation |
| `GET/POST /api/users` | `handleUsers` | Admin-only: list accounts with state/active flags (`GET`), or add a new non-admin user (`POST`) |
| `POST /api/users/password` | `handleUsersPassword` | Change password: any signed-in user can change their own (with `currentPassword`); admin can reset any non-admin user's password without their old one |
| `POST /api/users/manage` | `handleUsersManage` | Admin-only: `open` (switch active user), `start`, `stop`, `restart`, `sign-out`, `disable`, `enable`, `make-admin`, `remove-admin`, `check-rename`, `rename`, `remove` (two-step with optional `deleteData`) |

## Frontend flow

The frontend boots through `app.js` → `checkAuth()`:

- Calls `GET /api/auth/status`.
- If `{ claimRequired: true }`, the single-page app presents the **Claim this Plekt
  instance** screen (`renderClaimScreen()`) so the operator sets the admin credentials
  directly without needing terminal access.
- If `{ authenticated: false }`, the app presents the login form (`renderLogin()`).
- If `{ mustChangePassword: true }`, the user is forced to choose a new password before
  reaching any app views.
- The API key is never rendered into the initial HTML payload; it is fetched on demand for
  display/copy flows; it is not persisted to localStorage.

## Audit log

`writeAuditLog(action, { ip, detail })` records to the active user's `audit_log` table:
`login.success` / `login.failure`, `switch.user`, `users.password.changed`,
`credentials.updated`, `sessions.revoked`, `webhook-secret.rotated`, `media.deleted`,
`settings.saved`, `backup.restored`. Not exposed via the API - query SQLite directly (see
[sqlite-schema.md](sqlite-schema.md)).

## Hardening

- Passwords hashed with **scrypt** (N=16384, r=8, p=1, 32-byte salt, 64-byte derived key).
- Sessions use **HMAC-SHA256** with timing-safe comparison on verify.
- Secrets (`API_KEY`, `WEBHOOK_SECRET`, `SESSION_SECRET`, `PLEKT_CREDENTIAL_KEY`) use
  `crypto.randomBytes(24|32)`.
- Input validation on all credential changes: minimum 8 characters, maximum 128
  characters, no control characters.
- Non-admin tenant isolation: tenant files live in `data/users/<name>/` with 0700/0600
  permissions; non-admin users cannot call administrative endpoints (`/api/users`,
  `/api/users/manage`, `/api/auth/credentials`, `/api/auth/sessions/revoke-all`).
- Path traversal guards on user names: validated against `/^[a-zA-Z0-9_-]{2,32}$/`,
  Windows reserved filenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) forbidden,
  and case-insensitive duplicate prevention.
- Security response headers set on every response:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'`
