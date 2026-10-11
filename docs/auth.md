# Authentication & Secrets

Local single-admin auth: username/password login, a signed session cookie, an API key
for integrations, and a separate webhook secret. Provider account connections are
outbound authorizations managed by that administrator; they do not replace Plekt login.

## Files

| File | Role |
| --- | --- |
| `server/src/appConfig.js` | Resolves credentials/secrets at boot (env → `data/config.json` → generate), scrypt password hashing, secret rotation, startup security warnings |
| `server/src/utils/auth.js` | Session cookie sign/verify, `requireAdmin`, all `/api/auth/*` + `/api/login|logout` handlers |
| `public/modules/auth.js` | Frontend: sign in/out, `onAuthChange`, credential updates, webhook-secret rotation |
| `server/src/db.js` | `writeAuditLog` - security event log |
| `server/src/utils/credentialVault.js` | AES-256-GCM encryption for media-server and tracker tokens |
| `server/src/routes/mediaAuth.js` | Plex, Emby, and Jellyfin account authorization routes |
| `server/src/routes/trackerAuth.js` | Trakt device authorization and token lifecycle routes |
| `server/src/utils/onboardingStore.js` | `accountClaimed` state, atomic claim transaction, pristine-install detection |
| `server/src/utils/rateLimit.js` | Shared in-memory rate limiter used by `/api/login` and `/api/auth/claim` |

## The four credentials

| Credential | Purpose | Storage | Rotation |
| --- | --- | --- | --- |
| Admin username + password | Dashboard login | scrypt hash in `data/config.json` (`ADMIN_USERNAME`/`ADMIN_PASSWORD` env override until credentials are managed in-app) | Settings → General → Account |
| Session secret | Signs the `plembfin_session` cookie | `data/config.json` (`SESSION_SECRET` pins it) | Rotating it (credential change, revoke-all, env change + restart) invalidates every session at once |
| API key | Integrations/automation: `X-Api-Key` or `Authorization: Bearer` | `data/config.json` (`API_KEY` pins it) | Set a new `API_KEY` and restart |
| Webhook secret | Authorizes `/api/webhook` only | `data/config.json` (`WEBHOOK_SECRET` pins it) | Settings → Media servers → Webhooks → Rotate Secret (`POST /api/auth/webhook-secret`) - independent of everything else |

First boot: if `ADMIN_PASSWORD` is unset and the instance has no prior in-app credentials,
media connection, watch history, or configured metadata key, it's treated as pristine and
**no password is generated at all**. The app shows a one-time **Claim this Plekt
instance** screen instead of sign-in; `POST /api/auth/claim` sets the administrator
username/password atomically (inside a SQLite immediate transaction guarding
`accountClaimed`, so two simultaneous claims can't both win) and behaves like
`updateAdminCredentials` below - `authManagedInApp: true`, a fresh session secret, and an
immediate session for the winner. A losing concurrent request gets a neutral
`CLAIM_CONFLICT` with no indication of what the winning credentials were. While unclaimed,
`isClaimRequired()` gates every API route except `GET /api/ping`, `GET /api/changelog`,
`POST /api/login`, `POST /api/logout`, `GET /api/auth/status`, and `POST /api/auth/claim`
behind a `403 CLAIM_REQUIRED` response (`server/src/index.js`). See
[onboarding.md](onboarding.md) for the full claim and setup-wizard flow.

Existing or upgraded installs, and any deployment with `ADMIN_USERNAME`/`ADMIN_PASSWORD`
set, are unaffected and never see the claim screen. For those, if `ADMIN_PASSWORD` is
unset and no password hash is stored yet, a random password is generated and only its
scrypt hash is stored - only a startup warning is logged, not the plaintext password;
recover with `ADMIN_PASSWORD` or in-app credential reset. Secrets shorter than 32 chars
fail startup (`assertMinSecretLength`); a default `admin` password triggers a
forced-change flow (`mustChangePassword` in `/api/auth/status` pins the UI to Settings →
General → Account).

When credentials are changed from Settings or all sessions are revoked,
`authManagedInApp: true` is written to `data/config.json`. While that flag is present,
`ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables are ignored on startup. The
server logs a `[security]` notice if those env vars are set but inactive; remove
`authManagedInApp` from `data/config.json` to restore env-var control.

## Sessions

- Stateless: the cookie value is `base64url(payload).hmacSHA256(payload,
  sessionSecret)` with the issue time inside; 7-day TTL checked on verify.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`,
  path `/`.
- Revocation is global-only: rotating `sessionSecret` invalidates every cookie.
  `POST /api/auth/sessions/revoke-all` does exactly that, then issues the caller a
  fresh cookie so they stay signed in.

## Provider credentials

Media-server and Trakt access/refresh tokens are encrypted with AES-256-GCM before they
enter SQLite. Plekt uses `PLEKT_CREDENTIAL_KEY` when provided; otherwise it creates
`data/credential.key`. The generated key is not included in database or application
backups, so a restore containing encrypted provider connections also needs the original
key. Passwords entered for Emby or Jellyfin are used only for the authorization request
and are never persisted.

Account and tracker authorization routes require an authenticated browser session and
same-origin requests (`isSameOriginBrowserRequest` in `server/src/utils/auth.js`): a
`Sec-Fetch-Site` header decides when present, then `Origin`, then `Referer`, and a request
with none of the three is rejected. The `Referer` step exists because plain-HTTP LAN
addresses are not secure contexts, so browsers send neither `Sec-Fetch-Site` nor (on a GET)
`Origin`; `Referrer-Policy: same-origin` keeps `Referer` on the app's own requests only.
Short-lived authorization-flow rows are bound to that browser and
expire automatically. API-key callers cannot initiate those interactive flows.

## Request authentication

`requireAdmin(req, res)` (used by nearly every handler in `index.js`) accepts either:

1. a valid `plembfin_session` cookie, or
2. the API key via `X-Api-Key` or `Authorization: Bearer` (query-parameter API keys
   are deliberately **not** accepted)

and 401s otherwise. `resolveAdminPrincipal` is the no-response variant.

The webhook endpoint authenticates separately with `verifyWebhookToken` - see
[webhooks.md](webhooks.md). Timing-safe comparison is used for every secret check.

## Routes

| Route | Handler | Notes |
| --- | --- | --- |
| `POST /api/login` | `handleLogin` | Rate-limited 10/15min per IP; audit-logged success/failure |
| `POST /api/logout` | `handleLogout` | Clears the cookie |
| `GET /api/auth/status` | `handleAuthStatus` | `{ authenticated, username, mustChangePassword, claimRequired }` - never 401s |
| `POST /api/auth/claim` | `handleAuthClaim` | One-time pristine-install account claim; public route, rate-limited and origin-checked like login, with an artificial delay |
| `GET /api/auth/apikey` | `handleAuthApiKey` | Returns the API key; admin-only, fetched on demand by the UI |
| `GET/POST /api/auth/webhook-secret` | `handleAuthWebhookSecret` | GET returns it, POST rotates it |
| `POST /api/auth/credentials` | `handleAuthCredentials` | Requires current password; rotates session secret; re-issues cookie |
| `POST /api/auth/sessions/revoke-all` | `handleRevokeAllSessions` | Global session invalidation |

## Frontend flow

`onAuthChange()` (`public/modules/auth.js`) checks `/api/auth/status` at startup and
after login/logout; the auth panel shows only when no session is active, and the app
shell renders on success. After login, all browser API calls ride the HttpOnly cookie -
no token is kept in localStorage (legacy token keys are read once for migration and
scrubbed; `scrubTokenFromLocation` removes tokens from pasted URLs).

## Audit log

`writeAuditLog(action, { ip, detail })` records to the `audit_log` table:
`login.success` / `login.failure`, `credentials.updated`, `sessions.revoked`,
`webhook-secret.rotated`, `media.deleted`, `settings.saved`, `backup.restored`. Not
exposed via the API - query SQLite directly (see
[sqlite-schema.md](sqlite-schema.md)).

## Hardening

Production deployment controls (HTTPS, `COOKIE_SECURE`, pinned secrets, Docker overlay):
[hardening.md](hardening.md) and [security-checklist.md](security-checklist.md).
