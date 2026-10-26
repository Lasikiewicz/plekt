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
opens `/setup`: a step flow whose Overview step holds the account claim form or claimed
summary at the top, then cards for the remaining steps. Later steps cover optional watch
trackers, media servers, metadata, webhooks, Seerr, background imports (including optional
Tautulli and Netflix one-time imports), sync options, and a final review. Every action in
it calls the exact same endpoints and Settings dialogs used elsewhere in the app - there is
no separate setup-only configuration path.

The sync options step presents Fast Local-Network Sync and Sync Up Next to media apps
as side-by-side checkbox cards in one Other options section, stacking on mobile.

- **Media servers** - reuses the same Plex/Emby/Jellyfin connect-and-test modal shown from
  Settings → Media Servers. No server is actually required - Plekt also works from
  manually marking titles watched (via search), so this step can be skipped like any other
  optional one.
- **Metadata** - TMDB save/test, plus a note on which providers (TheTVDB, Fanart.tv) are
  already available through Plekt's built-in project keys.
- **Webhooks** - the same per-provider setup instructions and webhook URL shown in
  Settings. Emby and Jellyfin each ask you to confirm either the Plekt plugin or the
  webhook path inside that box (only one at a time); the row status shows
  **Plugin - Connected** or **Webhook - Connected**. Jellyfin's guide leads with the
  expanded Plekt Jellyfin plugin box and keeps the Webhooks plugin in its own collapsed
  box, the same as Settings. See [`docs/webhooks.md`](webhooks.md) for the full guide.
- **Trackers** (optional) - one step lists all trackers enabled for sync, using the
  same device-authorization flow as Settings → Import. Connect none, one, or several;
  connecting any tracker satisfies the dashboard reminder. Simkl stays out of this grid
  while its sync safety gate is closed, even if its auth-only Settings connection exists.
  Selecting **Import watch history** imports eligible missing watches after you press
  Continue; setup does not ask for a separate preview.
- **Seerr** (optional) - its own skippable wizard step after webhooks. Reuses the same
  connect modal as Settings → Connections → Seerr. Skipping leaves the dashboard
  **Configure Seerr** checklist item until a connection is saved later.
- **Background imports** - once a server passes its connection test, Plekt
  automatically starts pulling its watched status in the background (the same "Import
  Watched Status" pull already offered from Settings → Sync → Force Sync, scoped to that
  one server). Unchecking the box on the server's card cancels the in-progress pull and
  marks it opted-out; re-checking it starts a fresh pull. These pulls run concurrently
  across servers and continue in the background even after setup is closed - none of them
  push anything outward, so they don't take the same lock a full Force Sync push does.
  The **Import & sync** step also hosts Settings → Connections → **One Time Imports**
  (Tautulli and Netflix) in place, so those optional inbound importers run from the
  wizard without a separate Settings detour.
- **Tracker baseline imports** - same idea, using each provider's first-sync path
  once a connection's baseline snapshot isn't complete yet. An import is only
  started by an explicit onboarding choice, an import request for a newly connected
  tracker account, or an explicit Sync Now/reconciliation request; routine polls never
  launch a full import.
  Because the onboarding import is an in-process operation, a server restart cancels
  any stale `Importing` marker rather than silently starting it again.
  Chosen tracker imports run in parallel, with separate progress and reconcile passes.
  Media-server pulls wait for all importing trackers under one shared 30-minute cap,
  so earlier tracker watch dates are available before server history is pulled.
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
- **Initial sync** - Continue on **Import & sync** arms one add-only outward pass
  after all selected tracker/server imports and active Tautulli/Netflix commits finish.
  Failed imports wait for retry or an explicit skip; uncommitted previews are skipped.
  Each connected writable tracker or media server receives only missing watches,
  once per item at its earliest Plekt date. Existing watches and dates are preserved;
  removals and rewatch replay are excluded. Provider holds, quota reserves, sync roles
  and Plex historical-sync policy still apply. Independent destination queues use
  the existing paced dispatch and tracker batch paths.
  A chip above **Sync / Idle** opens the **Initial sync** screen with destination
  counts and remaining/held items. Progress is stored in SQLite. A process restart
  marks interrupted work honestly; uncertain sends are held for review rather than
  automatically replayed. Resolve remaining work through Settings full sync or
  Sync Activity. If all imports were skipped or nothing is missing, the pass is skipped.
  Reopening completed onboarding or adding a tracker in Settings does not arm another
  initial pass.
- **Setting Plekt as the source of truth** (the broader Force Sync operation) is
  intentionally *not* offered inline in the wizard. It's a destructive, confirm-gated
  action, so the wizard links to Settings → Sync → Sync Tools, where the existing
  preview/confirm/lock/cancel flow already lives. The wizard does surface whether it's
  even possible yet (disabled with an explanation when local watch history is empty).
- **Review** - a summary of account security, connected/tested servers, metadata,
  webhook acknowledgements, and tracker status, each linking back to its Settings section.
  No item here is required to finish - a build with no tested server shows a neutral
  "no server connected, tracking will be manual" notice rather than blocking completion,
  since `POST /api/setup/complete` (`handleSetupComplete` in
  `server/src/routes/onboarding.js`) doesn't require one either.

### Resuming and reopening

- Leaving the wizard early (**Exit to Settings**) doesn't mark it complete.
- When recommended setup tasks remain, the sidebar shows a compact **Finish Setup** button
  above **Sync - Idle**. It opens `/setup`; its **×** control dismisses the reminder without
  confirmation. The reminder disappears when every task is resolved or dismissed.
- Settings → Tools → **Reopen Onboarding** reopens `/setup` at any time, including after
  it's been completed - useful for revisiting a step (e.g. adding a second server) without
  touching anything already configured.
- Progress is stored server-side (a `settings` row keyed `onboarding`, not browser storage
  or cookies), so it survives a refresh, a different browser, or a different admin session.
  Version 2 stores tracker imports by provider and one `trackersSkipped` acknowledgement;
  an in-progress version 1 Trakt step, import and skip answer migrate automatically.
- The wizard's overview step offers a **Restore from backup** shortcut for migrating an
  existing install onto a fresh one, before connecting anything. It reuses the exact same
  local-upload/server-stored and Backblaze B2 restore tools as Settings → Backups → Restore
  (see [`docs/backups.md`](backups.md)) rather than a separate implementation.

### Recommended setup tasks

Plekt derives recommended tasks server-side from canonical configuration on every load, including
TMDB, per-server webhook acknowledgement, a watch tracker, Seerr, and an encrypted
backup/credential-key reminder. The dashboard does not display a separate task panel; the sidebar
**Finish Setup** button opens the wizard while tasks remain. Dismissing the button dismisses the
task reminder for the current onboarding run.
