# Guided first-run setup

Plekt replaces the old "generated password printed to the console" dead end with a
one-time account claim, followed by a resumable `/setup` wizard. This page covers the
claim flow, the setup wizard, and how to reach either one again later.

## Pristine-install account claim

On a brand-new install with no `ADMIN_PASSWORD` set and no in-app credentials yet, the app
shows **Claim this Plekt instance** instead of the normal sign-in form. No password is
generated or logged anywhere - the first administrator sets their own username and
password directly.

- The claim endpoint (`POST /api/auth/claim`) is atomic: if two browsers submit a claim at
  the same moment, exactly one wins (inside a SQLite immediate transaction) and the other
  gets a neutral `CLAIM_CONFLICT` response with no indication of what the winning
  credentials were.
- While unclaimed, every API endpoint except `GET /api/ping`, `GET /api/changelog`,
  `POST /api/login`, `POST /api/logout`, `GET /api/auth/status`, and `POST /api/auth/claim`
  returns `403` with `code: "CLAIM_REQUIRED"`.
- The claim endpoint shares a rate limiter and the same cross-site `Origin` check as
  `/api/login`, plus a short randomized delay, to blunt brute-force and timing attacks.
- Deployments that set `ADMIN_USERNAME`/`ADMIN_PASSWORD` never see the claim screen - they
  keep the normal sign-in flow, and claiming is skipped entirely (`isClaimRequired()`
  returns `false` whenever `ADMIN_PASSWORD` is set or credentials are already
  in-app-managed).
- Existing or upgraded installs are detected automatically and marked as already-claimed
  the first time the server boots against that data directory - if it has an existing
  media connection, watch history, a configured metadata key, or in-app-managed
  credentials, it's treated as pristine-complete and the claim screen never appears.

## The `/setup` wizard

After claiming the account (or signing into a fresh environment-managed install), the app
opens `/setup`: a step flow covering media servers, metadata, webhooks, an optional Trakt
connection, background imports, sync options, and a final review. Every action in it calls the exact
same endpoints and Settings dialogs used elsewhere in the app - there is no separate
setup-only configuration path.

- **Media servers** - reuses the same Plex/Emby/Jellyfin connect-and-test modal shown from
  Settings → Media Servers. No server is actually required - Plekt also works from
  manually marking titles watched (via search), so this step can be skipped like any other
  optional one.
- **Metadata** - TMDB save/test, plus a note on which providers (TheTVDB, Fanart.tv) are
  already available through Plekt's built-in project keys.
- **Webhooks** - the same per-provider setup instructions and webhook URL shown in
  Settings, with a self-attestation checkbox per connected server. See
  [`docs/webhooks.md`](webhooks.md) for the full guide.
- **Trakt** (optional) - the same device-authorization flow as Settings → Import. Skipping
  it carries a reminder onto the dashboard checklist.
- **Background imports** - once a server passes its connection test, Plekt
  automatically starts pulling its watched status in the background (the same "Import
  Watched Status" pull already offered from Settings → Sync → Force Sync, scoped to that
  one server). Unchecking the box on the server's card cancels the in-progress pull and
  marks it opted-out; re-checking it starts a fresh pull. These pulls run concurrently
  across servers and continue in the background even after setup is closed - none of them
  push anything outward, so they don't take the same lock a full Force Sync push does.
- **Trakt baseline import** - same idea, using the same first-sync path Trakt's regular
  poll cycle uses once a connection's baseline snapshot isn't complete yet. It is only
  started by an explicit onboarding choice, an import request for a newly connected
  Trakt account, or an explicit Sync Now/reconciliation request; routine polls never
  launch a full import.
  Because the onboarding import is an in-process operation, a server restart cancels
  any stale `Importing` marker rather than silently starting it again.
- **Options** - chooses how app-marked watched flags are dated or sent to Manual Watch
  review. The default is **Require review**. It also includes the opt-in
  **Fast Local-Network Sync** toggle, which is only appropriate when all connected
  media services are on the same trusted local network. The **Sync Up Next to media
  apps** toggle is enabled by default. When enabled, Plekt keeps its Up Next queue in
  sync with Plex and Emby's Continue Watching and Jellyfin's Next Up. Turn it off to leave
  those app lists unchanged; Plekt's own Up Next view remains available. You can change
  this later in Settings →
  Sync → Sync Tuning. These choices are saved together when continuing past the step
  and remain editable in Settings → Sync → Sync Tuning.
- **Setting Plekt as the source of truth** (pushing local watch history outward) is
  intentionally *not* offered inline in the wizard. It's a destructive, confirm-gated
  action, so the wizard links to Settings → Sync → Sync Tools, where the existing
  preview/confirm/lock/cancel flow already lives. The wizard does surface whether it's
  even possible yet (disabled with an explanation when local watch history is empty).
- **Review** - a summary of account security, connected/tested servers, metadata,
  webhook acknowledgements, and Trakt status, each linking back to its Settings section.
  No item here is required to finish - a build with no tested server shows a neutral
  "no server connected, tracking will be manual" notice rather than blocking completion,
  since `POST /api/setup/complete` (`handleSetupComplete` in
  `server/src/routes/onboarding.js`) doesn't require one either.

### Resuming and reopening

- Leaving the wizard early (**Exit to Settings**) doesn't mark it complete.
- The sidebar shows a **Complete onboarding** entry point on every page while setup isn't
  finished, alongside its own **×** control to dismiss it permanently. It disappears on its
  own once the wizard has actually been finished (a tested server isn't required for that)
  or once a media server has been connected and tested directly from Settings without ever
  finishing the wizard.
- Settings → Tools → **Reopen Onboarding** reopens `/setup` at any time, including after
  it's been completed - useful for revisiting a step (e.g. adding a second server) without
  touching anything already configured.
- Progress is stored server-side (a `settings` row keyed `onboarding`, not browser storage
  or cookies), so it survives a refresh, a different browser, or a different admin session.
- The wizard's overview step offers a **Restore from backup** shortcut for migrating an
  existing install onto a fresh one, before connecting anything. It reuses the exact same
  local-upload/server-stored and Backblaze B2 restore tools as Settings → Backups → Restore
  (see [`docs/backups.md`](backups.md)) rather than a separate implementation.

### Dashboard checklist

Once setup is complete, the dashboard shows a short **Finish setting up Plekt**
checklist for anything still outstanding - TMDB, per-server webhook acknowledgement,
Trakt, Seerr, and an encrypted backup/credential-key reminder. It's derived server-side
from canonical configuration on every load, not from anything the wizard "remembers", and
disappears once every item is resolved or dismissed.
