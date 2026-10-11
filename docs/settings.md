# Settings

Settings is a hierarchical, task-oriented administration area modeled on Sonarr. The
Settings page groups related sections under bold parent headings; clicking a parent or a
child scrolls to that section on the parent's own aggregated page rather than opening a
separate screen. `/settings` itself shows a plain overview list grouped the same way.
The primary left rail keeps Settings and the top-level **About** page separate. Desktop
and mobile use the **Settings section** select control for the full settings catalogue
(a flat list of options under `<optgroup>` headings).

| Group (parent) | Parent route | Child sections | Child routes |
| --- | --- | --- | --- |
| General | `/settings/general` | Account, System Integrity Check, Storage & Cache | `/settings/general#account`, `/settings/general#system-integrity`, `/settings/general#storage` |
| Media servers | `/settings/media-servers` | Plex, Emby, Jellyfin | `/settings/media-servers#plex`, `/settings/media-servers#emby`, `/settings/media-servers#jellyfin` |
| Webhooks | `/settings/webhooks` | Setup Guides, Webhook Secret | `/settings/webhooks#setup-guides`, `/settings/webhooks#webhook-secret` |
| Connections | `/settings/connections` | Trakt, Tautulli watch-history import, Seerr | `/settings/connections#trakt`, `/settings/connections#tautulli`, `/settings/connections#seerr` |
| Metadata | `/settings/metadata` | Metadata Providers, Refresh Metadata (TMDB, TVDB) | `/settings/metadata#metadata-providers`, `/settings/metadata#refresh-metadata` |
| Sync | `/settings/sync` | Sync Tuning, Sync Tools (Repair Recent Items, Full Sync Watchstates, Force Sync, Personal Rating Sync, Plex Watchlist Sync), Sync History | `/settings/sync#sync-tuning`, `/settings/sync#sync-tools`, `/settings/sync#sync-history` |
| Backup | `/settings/backup` | Local (Watch History, Plekt), Remote (Watch History, Plekt) | `/settings/backup#backup-local`, `/settings/backup#backup-remote` |
| Restore | `/settings/restore` | Local (Watch History, Plekt), Remote (Watch History, Plekt) | `/settings/restore#restore-local`, `/settings/restore#restore-remote` |
| Tools | `/settings/tools` | Guided Setup, Database Repairs, Library Rebuilds and Backfills, Wipe data (Watch History, Personal Watchlist, Sync History & Logs, Everything Tracked, Wipe All / Fresh Start) | `/settings/tools#guided-setup`, `/settings/tools#database-repairs`, `/settings/tools#library-rebuilds`, `/settings/tools#wipe-data` |
| Logs | `/settings/logs` | (none - single-page group) | - |
| Changelog | `/settings/changelog` | (none - single-page group) | Main / Alpha channel toggle; see [`architecture.md`](architecture.md#changelog--update-check) |

The Settings overview and section select expose the parent groups and their display-only
children. Every child section navigates to the parent group's path with the section id
appended as a URL hash (`#system-integrity`), then scrolls that specific section into view.
The parent's page always renders every child's content stacked together - clicking a
child is a same-page jump, not a different screen. Logs and Changelog are single-page Settings groups;
About is a separate top-level page at `/about`. Use the parent-and-hash routes above when
documenting or linking to a child tool; for example, Full Sync Watchstates is
`/settings/sync#full-sync-watchstates`.

**The sidebar, the mobile `<select>`, and the `/settings` overview boxes are all generated
from `SECTION_GROUPS`/`SECTIONS` at render time** (`renderSettingsSidebar()`,
`renderSettingsSectionSelect()`, `renderSettingsOverview()` in `settings-shell.js`) - none
of them are hand-written lists elsewhere. Adding, renaming, splitting, or reordering a
group or section only ever means editing `SECTION_GROUPS`/`SECTIONS`; every nav surface
picks up the change automatically and does not need a matching edit of its own.

Backup and Restore go one level deeper than most groups: their Local and Remote children each carry their own `subSections` (Watch History, Plekt), which the sidebar renders as a third-level "grandchild" row and which resolve via the same parent-and-hash pattern - for example, `/settings/backup#local-watch-history-backups` or `/settings/restore#remote-plembfin-restore`. This is the same three-level pattern already used by Database Repairs, System Integrity Check, and Wipe data.

### Section ID naming rule

**A section's `SECTIONS` key in `settings-shell.js` must be a kebab-case slug of its
`label`**, and the URL hash is always that same key (`/settings/<group>#<section-key>`).
This is what keeps a child's URL predictable from its sidebar text - `Account` is
`#account`, `System Integrity Check` is `#system-integrity`. A key that lives under more
than one parent (two different groups both have a "Local" and a "Remote" child) is
prefixed with its own parent group's id to stay unique in the flat `SECTIONS` namespace,
the same way `sync-tuning`/`sync-tools` are prefixed under `sync` - Backup's children are
`backup-local`/`backup-remote`, Restore's are `restore-local`/`restore-remote`. Do not
reuse an old internal name, an implementation detail, or a panel id as a section key
(`import`, `health`, and `backups` were all fixed for this reason - the ids referred to
internal plumbing, not what the sidebar displayed). When renaming a section's `label` or
moving it between groups:

1. Rename its `SECTIONS` key to match the new label's slug.
2. Update every `sections`/`displayOnly` array in `SECTION_GROUPS` that lists the old key.
3. Update the `LEGACY_TABS`/`LEGACY_PATHS` value if the old key is a legacy-redirect target.
4. Add a `LEGACY_PATHS` entry redirecting the *old* key's bare path (`/settings/<old-key>`)
   to the new one, so an existing bookmark still resolves.
5. Update the tables in this document and re-check the route-compatibility table below.

`data-sub-panel` values (the DOM attribute a section's `subPanels` entries point at) are
a separate namespace from `SECTIONS` keys and must stay unique across the whole page,
since `applySettingsRoute()` reveals them with a first-match `querySelector`.

The Trakt page also owns the live bidirectional Trakt connection. Plekt ships a
device application in the same model as the Jellyfin Trakt plugin, so the normal flow
asks only for the initial-sync policy and then displays a Trakt authorization code.
`TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` can override the bundled application for
rotation or a private deployment. The advanced personal-app fields remain a fallback
for Trakt VIP developers and their values are encrypted at rest.

The Connections page also includes the one-time **Tautulli Watch-History Importer**.
It stores the Tautulli URL and API key separately from the Plex connection, scopes
each request to one selected Tautulli user, and previews completed movies and episodes
before writing. A local watch-history backup is created before a confirmed import.

The importer does not ask which servers to project to: Plekt's scheduled sync reconciles
Emby and Jellyfin with imported watches regardless, and both receive the original playback
date. It shows a notice before importing only when **Sync historical watched items to Plex**
is off, because that is the one case where a server will not receive the import at all. The
preview still reports the per-target outcome as `will receive this import` or `skipped by
the historical sync policy`. A play matching more than one existing
record, or sitting within 31 days of a single existing record, is held in a review list with
its candidates; the administrator chooses to use an existing record, import it as a separate
play, or skip it, and anything left undecided is not imported. A bulk control applies one
answer to every undecided possible rewatch. A real playback timestamp within two days of an
approximated date (a round clock hour) is merged automatically as the same viewing. The final summary breaks the result down into imported,
already represented, incomplete, reviewed-and-merged, reviewed-and-imported,
reviewed-and-skipped, still undecided, unresolved, and rejected.
See [backups.md](backups.md) for the full importer behaviour.

Media Servers uses account setup by default and keeps manual credentials as an optional
fallback. Plex signs in through Plex, verifies the selected server, and maintains an
encrypted account/server token pair. Emby exchanges a server URL, username, and password
for an encrypted user-scoped token without storing the password. Jellyfin prefers Quick
Connect and also supports a one-time username/password exchange when Quick Connect is
disabled. Manual mode accepts the traditional token/API-key fields. Each provider has
exactly one active mode: completing account setup removes its stored manual secret, and
saving manual setup changes that provider back to manual mode.

After its initial baseline or full-history import, the Trakt connection reads the complete
watched snapshot every minute. Added watches, timestamp changes (rewatches), and removed
watches enter the same synchronization pipeline as media-server and Plekt actions, so
watched and unwatched state converges everywhere. Emby and Jellyfin Trakt plugins should
be disabled to keep Plekt as the sole Trakt bridge. The browser subscribes to an
authenticated update stream and refreshes the active page as imported changes commit.

### Sync Tuning: app-marked watched flags

The **When you manually mark an item as watched in Plex / Emby / Jellyfin** setting controls scheduled Plex, Emby, and
Jellyfin library snapshots that report a watched flag without threshold-reaching playback
evidence. The default is **Require review**. **Mark as watched on release day** uses
the item's release date; **Mark as watched at the same time as other episodes** uses the
nearest watched episode in the same season with the same runtime-plus-one-minute spacing
as the media-page watch-date picker. A real provider playback timestamp is always kept.

**Require review** leaves the item out of canonical watch history until an administrator
chooses a policy on the **Manual Watch review** page. The page is linked in the sidebar
above **Sync - Idle**, shows the provider evidence, and offers now, release-day, episode-
timing, or dismiss actions. Leaving an item untouched defers it; repeated scans do not
create duplicate review rows or re-announce a flag that is already resolved by Plekt's
canonical watched state.

### Sync Tuning: historical watched items and Plex

The **Sync historical watched items to Plex** setting controls whether an import, a
restore, a backdated manual mark, or a library-wide push projects an already-known watch
onto Plex. It is **on by default** and is the recommended setting.

The setting exists because the providers are not equivalent. Plekt and Trakt keep the
canonical play date and rewatch history, Emby receives the original date through its
`DatePlayed` parameter, and Jellyfin through `datePlayed`. Plex's server API has no
supported way to set a historical play date, so a scrobble is always recorded using the
Plex server's own clock: the watched state is correct, but the activity date reads as
today. Plekt says so rather than implying the original date survived.

Turning the setting off means historical items may remain unwatched in Plex; Plex badges,
counts, and homepage sections may not match Plekt; a new Plex server will not receive
older watched history; imported or restored watches will be missing from Plex activity;
and you may need to mark those items in Plex yourself later. Existing Plex watch history
is never removed or changed. Day-to-day watching is not affected - a new watch still
reaches Plex normally - and Emby, Jellyfin, and Trakt keep receiving historical watches
with their original dates either way.

The setting is scoped to Plex and to *historical* watched projections, and within that it
is absolute: with it off, no watch Plekt already holds reaches Plex by any route. That
includes Full Sync Watchstates, a per-item Force Sync, Trakt and Tautulli imports, restores,
backdated manual marks, availability repair, and the reconcile that follows a webhook for an
item Plekt already had watched.

What still reaches Plex with the setting off:

- a live play, synced normally;
- a **Now** manual mark, which is a watch the user is creating rather than replaying;
- any **unwatch**, which is a state change rather than a backfill;
- the Plex adaptive poller restoring a watch Plex itself dropped moments after threshold
  playback - that watch just happened, so it is live rather than historical.

Turning the setting back on is how you ask for your history to be pushed to Plex; there is
deliberately no per-operation override that bypasses it.

When a target is skipped this way, Plekt reports it as *skipped by policy* rather than
as a failure, in the item's dispatch telemetry, in Sync Activity, and in the per-provider
summary an import or bulk mark-watched returns. A policy skip is never retried. Plekt
also checks Plex's current state before a mark-watched write and reports *already
matching* instead of sending a redundant scrobble that would only move the activity date.

The same control and copy appear during guided first-run setup, next to the Trakt
first-connection choice, because it changes what an import will do.

Full Sync Watchstates replays Plekt's canonical watched and resume rows in two phases. It takes a fixed snapshot for each phase, temporarily suppresses inbound media-server callbacks and scheduled catch-up work, and shows rows processed, throughput, and an estimated remaining time. The shared sync-operation lock prevents it from overlapping Force Sync or a backup restore. The Stop Restore control cancels future batches; already completed batches remain applied. Reset Restore Lock is an administrator-confirmed recovery action for a run abandoned by a browser or server restart; it stops any in-flight restore before allowing another run to start.

Force Sync contains the same two controls and live activity terminal used by media detail
pages. The controls stay inline in the Force Sync box. Each action asks for confirmation
before it starts, and the activity header exposes **Cancel operation** while a run is in
progress. A confirmed plan's actions run with bounded concurrency (independent library
items in flight together, capped per destination server by the outbound pacing profile so
it speeds up a large plan without sending more simultaneous requests to any one server).
Cancellation stops any items that have not yet started; items already in flight finish and
their writes remain applied.
**Set Plekt as Source of Truth** replays Plekt's watched playstate (and saved resume
positions) to one destination or all destinations, overwriting whatever they currently
show - it does not check their current state first.
**Import Watched Status** scans the configured Plex, Emby, and Jellyfin libraries for
watched items and adds anything Plekt doesn't already have, without sending anything
back out or removing anything.
Both watched-state operations are library-wide, and status is polled through the shared
Force Sync activity ledger until each completes. The detail-page modal also exposes a
separate **Push Personal Rating** row for the open title. Its provider selector includes
Trakt, and its request does not enter the watched-state Force Sync worker or lock.
Trakt is a valid watched-state Push target as well; the watched-state Pull selector
remains media-server-only.

## Multi-view aggregation

A parent group's page can pull content from more than one underlying panel or backup
tab. Each group definition in `settings-shell.js` carries a `views` array (or, for
single-panel groups, a flat `panel`/`subPanels`/`backupTab` that `sectionRoute()`
wraps into a one-item `views` array automatically):

| Group | Views |
| --- | --- |
| General | `general` panel's Account, System Integrity (`tools-diagnostics`), and Image Cache (`cache`) rows |
| Media servers | `apps` panel's Plex, Emby, and Jellyfin rows |
| Webhooks | `general` panel's Setup Guides (`general-endpoints-guides`) and Webhook Secret (`general-endpoints`) rows |
| Connections | `tools` panel's Trakt (`tools-migration`) and Seerr rows |

`applySettingsRoute()` iterates every view in the route and reveals each one's panel and
sub-panel rows; for the shared `backups` panel it also accumulates every requested
`backupTab` into a set before hiding any backup panel not in that set, which is what lets
the Backup and Restore groups reuse the same physical panel element while each only ever
reveals its own tab (`settings` or `restore`). Post-route data loaders in `app.js`
(media-server cards, sync jobs/history, watch backups, cache stats, logs, changelog)
check membership across the whole `route.views` list, not just the route's primary
panel, so a loader for a panel that only appears as a secondary view (e.g. the `cache`
panel inside Advanced) still runs.

## Section-scoped scrolling

Clicking a child section calls `scrollToSettingsSection(sectionId)`
(`settings-shell.js`), which resolves the section to a DOM element and calls
`scrollIntoView({ behavior: "smooth", block: "start" })` on it:

- If the section's first sub-panel is wrapped in a `<details class="settings-disclosure">`
  accordion (Database Repairs / Library Rebuilds inside the Tools panel), the *disclosure
  wrapper* is the scroll target, not the bare row - otherwise the scroll would land past
  the section's own heading (the heading lives in the synthetic `<summary>`, not the row).
- Otherwise it falls back to the `[data-sub-panel]` row, the backup-tab-qualified panel,
  or the plain panel element, in that order.

`.settings-pane`, `.settings-row`, and `.settings-disclosure` all carry
`scroll-margin-top: calc(var(--right-topbar-height) + var(--space-3))` so the sticky
`.page-topbar` (which sits at `position: sticky; top: 0` inside the scrolling
`.page-shell` container) never covers the section that was just scrolled to.

Navigating to a genuinely different settings path (not just a same-page hash jump)
resets `.page-shell`'s scroll position to the top - this targets the actual scrolling
viewport (`.page-shell`, `overflow-y: auto`), not `window`/`body`, since the app shell
itself never scrolls.

## Card and modal workflows

Media servers and metadata providers use card grids. Configured services appear as cards
with status badges; the trailing **+** card opens a provider
picker. Selecting a card opens an edit dialog with aligned label/control rows, inline
help, and Save/Cancel actions. Media-server dialogs also provide **Test** and an Enable
switch. Fixed services can be disabled but not deleted because the config API has no
credential-clear operation.

**Sync Tuning is the one exception**: its watched-flag policy, the Plex historical
watched-sync checkbox, four numeric fields
(watched threshold, minimum resume position, active-session TTL, outbound timeout) plus the Fast
Local-Network Sync and Up Next sync checkboxes render directly inline on the Sync page in a plain form
with its own Save button - not behind a card + edit modal - since there's only ever
one instance to edit and no add/remove/test workflow.

Media Servers is rendered as a boxed settings section with a separate boxed Seerr
subsection and its own left-menu link; its edit modal keeps provider setup help visible
beside the fields on wider screens.
Webhooks shows the current secret, complete webhook URL, and separate Plex, Emby, and
Jellyfin setup guides.

Backup and Restore each render their Local and Remote children as their own top-level
boxed card (`#backup-local`/`#backup-remote` and `#restore-local`/`#restore-remote` in
`index.html`), not stacked inside one shared "Backup"/"Restore" wrapper card - this is
what makes each one a real card-level `subSections` grandchild target rather than just a
plain anchor inside a bigger box. `#restore-local`/`#restore-remote` are additionally
borrowed by the guided-setup wizard's "Restore from backup" step (`onboarding.js`);
`applySettingsRoute()` re-parents them back under `#restoreSectionsHome` whenever the
Restore page is opened directly, so they must stay direct children of that container -
never wrap them in an intermediate element.

Remote backup destinations use the same card and modal primitives. The Backblaze B2
dialog edits its name, enabled state, region/endpoint, bucket, key ID, optional prefix,
and application key. Save and Test persist the destination before refreshing status;
Delete removes the destination record after confirmation without deleting remote files.

Dialogs are singletons, close on Escape/backdrop/close button, keep their header and
footer visible while the body scrolls, and collapse to stacked fields on mobile.

## Frontend ownership

| File | Role |
| --- | --- |
| `public/modules/settings-shell.js` | Hierarchical section/group registry, multi-view aggregation, legacy aliases, landing list, sidebar, mobile selector, panel visibility, section-scoped scrolling, and tools disclosures |
| `public/modules/settings-ui.js` | Shared edit modal, picker modal, service-card grid, and the `renderFieldRow`/`collectFieldValues` primitives reused by both modal and inline forms |
| `public/modules/settings-services.js` | Media-server and metadata definitions, config saves, connection tests, cards/dialogs, and the inline Sync Tuning form |
| `public/modules/rating-sync-settings.js` | Personal Rating Sync on/off control, connection summary, Sync now, and status polling |
| `public/modules/watchlist-sync-settings.js` | Plex Watchlist Sync on/off control, Plex connection summary, Sync now, and status polling |
| `public/modules/settings.js` | Shared connection-label formatting |
| `public/modules/tools.js` | Trakt import and compatibility exports for backup and maintenance behavior |
| `public/modules/tools-backups.js` | Backup schedules, restore, destination cards/dialogs, and appearance behavior |
| `public/modules/tools-maintenance.js` | Diagnostics, cross-platform match reporting, repairs, backfills, and cache behavior |
| `public/modules/tools-wipe-data.js` | Wipe data: Watch History, Personal Watchlist, Sync History & Logs, Everything Tracked, and Wipe All / Fresh Start, each behind two confirm dialogs |
| `public/modules/help-content.js` | Credential, webhook, migration, and account setup guides |
| `public/modules/logs.js` / `public/modules/sync.js` | Logs and sync rendering/loaders |
| `public/app.js` | SPA routing, per-view data-loader gating across `route.views`, element binding, and module callback injection |

## Route compatibility

Old bookmarks are normalized with `history.replaceState`:

| Previous route | Canonical route |
| --- | --- |
| `/settings/account/login` | `/settings/account` (UI: `/settings/general#account`) |
| `/settings/apps`, `/settings/connections/:provider` (plex/emby/jellyfin) | `/settings/media-servers` |
| `/settings/api-keys`, `/settings/metadata/:provider` | `/settings/metadata` |
| `/settings/connections/webhooks` | `/settings/webhooks` |
| `/settings/connections/seerr` | `/settings/seerr` (UI: `/settings/connections#seerr`) |
| `/settings/data`, `/settings/data/backups`, `/settings/backups`, `/settings/backup-settings` | `/settings/backup` (UI: `/settings/backup#backup-local`) |
| `/settings/data/restore` | `/settings/restore` (UI: `/settings/restore#restore-local`) |
| `/settings/backup-restore`, `/settings/backup-restore-group` | `/settings/backup` |
| `/settings/data/import`, `/settings/import` | `/settings/trakt` (UI: `/settings/connections#trakt`) |
| `/settings/system`, `/settings/system/health`, `/settings/health` | `/settings/system-integrity` (UI: `/settings/general#system-integrity`) |
| `/settings/webhook-guides` | `/settings/setup-guides` (UI: `/settings/webhooks#setup-guides`) |
| `/settings/system/advanced` | `/settings/database-repairs` (UI: `/settings/tools#database-repairs`) |
| `/sync` | `/settings/sync` |
| `/settings/sync/issues`, `/settings/sync-issues`, `/settings/system/sync` | `/sync-activity` |
| `/settings/sync/history` | `/settings/sync-history` (UI: `/settings/sync#sync-history`) |
| `/settings/sync/tuning` | `/settings/sync-tuning` (UI: `/settings/sync#sync-tuning`) |
| `/logs`, `/settings/system/logs` | `/settings/logs` |
| `/settings/cache`, `/settings/system/storage` | `/settings/storage` |
| `/settings/about`, `/settings/system/about` | `/about` |

The forced-password-change state always resolves to the Account section (`/settings/account`; the normal sidebar path is `/settings/general#account`).

## Configuration and secrets

Service dialogs post one section at a time to `POST /api/config`. The server merges the
incoming section over stored configuration. Browser-safe responses expose only a
`configured` boolean for secrets, so secret inputs are always blank. A configured field
shows a replacement placeholder; saving or testing with it blank keeps and uses the
stored credential. Seerr and destination secrets are omitted from payloads when blank.

URLs are restricted to HTTP/HTTPS, embedded credentials and cloud-metadata hosts are
rejected, and saved values take precedence over environment defaults. Connection tests
fall back to stored credentials when the modal secret field is blank.

The **Sync Tuning** form (on the Sync page) exposes the **Sync historical watched items
to Plex** checkbox (on by default, stored as `tuning.plexHistoricalWatchedSync`, also
settable via the `PLEX_HISTORICAL_WATCHED_SYNC` environment variable) and four optional
numeric settings: watched threshold, minimum resume position, active-session TTL, and
outbound request timeout. Blank fields inherit the matching environment variable or built-in default;
saved values take precedence. The defaults remain 90%, 60 seconds, 5 minutes, and 10
seconds respectively. It also includes a **Sync Up Next to media apps** toggle, enabled by
default. When enabled, Plekt keeps its Up Next queue in sync with Plex and Emby's Continue
Watching and Jellyfin's Next Up. Turning the toggle off leaves those app lists unchanged while
Plekt's local Up Next view remains available.

**Personal Rating Sync** is disabled by default and has a single on/off control, plus a
**Sync now** button in the bottom right of the panel that runs an immediate sync. When
enabled, every connected Plex, Emby, Jellyfin, and Trakt account participates in
two-way sync every five minutes. Local rating changes are saved to Plekt first and
delivered through a durable queue; provider failures do not alter watched state, play
history, resume positions, or lists. See
[personal-ratings.md](personal-ratings.md).

**Plex Watchlist Sync** is disabled by default and has a single on/off control, plus a
**Sync now** button that runs an immediate reconcile. Plekt is the canonical local
present-set and Plex uses its account Universal Watchlist. Enabling sync takes a safe union
on the first run, imports Plex-only additions, and sends each newer local change to Plex.
A Plex failure never deletes the local list. The same checkbox appears on the Plex card
under Media Servers and on the Plex row of guided setup, where it is checked by default.

The panel explains anything it cannot deliver instead of only reporting that attention is
needed: a refused sign-in links to the Plex connection settings, and a rejected change
shows the error Plex returned and when the next attempt is due. A **Retry queued changes**
button reruns stuck work immediately. See [personal-watchlist.md](personal-watchlist.md).

The same form's **Fast Local-Network Sync** checkbox controls the outbound pacing
governor's profile (`server/src/utils/outboundGovernor.js`), stored as `pacing.profile`
("standard" or "fast"; also settable via the `OUTBOUND_PACING_PROFILE` environment
variable). It is unchecked by default. Checking it raises the per-destination-server
concurrency limit and removes the delay between requests for Force Sync, Full Sync
Watchstates, and other bulk sync operations, which finishes them much faster - but it
is only safe when Plex, Emby, and Jellyfin are all self-hosted on the same trusted
local network as Plekt, since it removes most of the throttling that protects a
server reached over the public internet from being overwhelmed by a large sync.

## Maintenance disposition

- System Integrity Check runs the integrity, database, webhook, scheduler, media-server, and
  cross-platform library matching checks.
- Sync combines history, repair-recent, force, stop/reset, and refresh. Current
  watched-state failures and unresolved cross-platform media matches are reviewed
  in the standalone `/sync-activity` page with its **Issues only** filter. The
  activity page uses the admin-guarded `GET /api/sync-match-report` data to show
  unidentified media alongside the matching actions. Identified media that is
  simply absent from a connected library remains an availability difference,
  not an issue.
- Storage & Cache (under Advanced) displays and clears image cache categories.
- Tools retains history repair, deduplication, full watch-state sync, metadata refresh,
  TV rematching, and Trakt poster backfill with their confirmations and logs, split
  across the Database Repairs and Library Rebuilds and Backfills accordions. Database
  Repairs also includes **Restore Missing Episode Names**, which scans the full watch history
  in one operation, backfills real names onto rows that only stored a coordinate ("8" /
  "Episode 08"), and reports verified **No title provided** rows separately. Exact audit
  counts cover the full library; temporary metadata failures remain retryable rather than
  being presented as verified title-less records. The **Watch-State Aliases** card lists
  episode watch states the automatic repair could not tie to their show, with the reason for
  each. **Belongs to this show** moves them into the show (the newest watch state wins);
  **Different show** leaves them alone and stops them being listed or repaired again. Only
  Plekt's own watch state changes; nothing is sent to connected platforms.
- Trakt owns the Trakt/CSV importer; Backup and Restore own their respective workflows.
- Wipe data (`server/src/routes/wipeData.js`, `GET/POST /api/wipe-data(/preview)`) offers four
  destructive scopes: Watch History, Sync History & Logs, Everything Tracked (both together),
  and Wipe All / Fresh Start. The first three only ever touch tracked watch/sync tables -
  settings, connections, credentials, and the admin login are untouched. Wipe All / Fresh Start
  is the one exception: it also clears every remaining table, deletes cached artwork on disk,
  and calls `resetAdminAccount()` in `server/src/appConfig.js` to reset `data/config.json` back
  to a pristine, unclaimed install - which signs out every session, including the one that ran
  it. Every action requires two sequential confirm dialogs in the browser, plus the request body
  must include `confirm: "DELETE"` as a server-side backstop against a stray or replayed request.

No maintenance API or stored media configuration format changes are introduced by the
settings shell.

## Cross-Platform Match Report data

Sync Activity's **Issues only** view includes unresolved cross-platform matches:
records carrying no IMDB, TMDB, or TVDB id, where nothing reliable was ever
resolved. Picking the right title from the issue's **Fix match** action fixes
the identity, and the issue leaves Sync Activity once the corrected record has
been dispatched successfully. The classification reads the record's ids rather
than its media key, because the key is written when the row is created and is
not rebuilt when a later Fix Match resolves an id.

Records that *are* identified and still report "no matching item found" are not
listed. That result means the platform has no copy of the media, which is a
difference between your libraries rather than a fault, and no action in this
issue view can change it. Those items need nothing: the watch is recorded correctly in
Plekt, and if the media is later added to that server it is marked watched
automatically (see [Catching up newly added media](webhooks.md#catching-up-newly-added-media)).
The unfiltered per-platform totals are still returned by
`GET /api/sync-match-report` and reported by Sync Health.

Rows are built from each record's stored `sync_dispatch_telemetry`, so an issue
only leaves Sync Activity once that record has been dispatched again and
reported a match. The issue panel provides a per-item **Fix match** action and a
**Remove** action. Remove keeps the local watch history and suppresses that unresolved
issue from future reports. The normal Sync Activity controls remain available for
retrying or reviewing the underlying sync events.

Only unidentified items are offered for matching. An item that already knows
what it is cannot be repaired by choosing a search result, so an identified
item that is absent from one library remains an availability difference rather
than an issue.

## Server Logs

The **Server Logs** panel (`/settings/logs`) displays real-time and historical diagnostic logs captured by the server alongside browser output. Logs are automatically categorized and can be filtered using interactive tabs:

- **All Logs**: Complete chronological event stream.
- **⚡ Plex WebSockets**: WebSocket connection lifecycle, incoming timeline events, ratingKey extraction, and handler triggers.
- **🔄 Outbound Sync**: Real-time playstate dispatches, watch record insertions, and manual watch/unwatch propagation.
- **⏱️ Scheduled Polls**: Periodic background catch-up library checks, session tracking, and scheduled sync cycles.
- **🖥️ System Logs**: General administrative, startup, and system events.

Log entries feature human-readable timestamps (`YYYY-MM-DD HH:MM:SS`), color-coded category badges (`[PLEX]`, `[SYNC]`, `[POLL]`, `[SYSTEM]`, `[ERROR]`), a live pulsing activity indicator, and glassmorphic styling compatible with both Dark and Light appearance modes. Routine keep-alive recycling and 0-item background sync ticks are filtered out before they are stored, to ensure a high-signal log stream.

Entries are served from the `diagnostic_log` table, so the panel merges output from the web and worker processes and reads at a fixed cost no matter how long the server has been running. The table is a bounded ring buffer; **Clear Logs** empties it. Per-request tracing is off unless `LOG_VERBOSE` is set - see [troubleshooting.md](troubleshooting.md) for what that adds. On-disk JSONL copies under `data/logs` are a crash-forensics archive only, pruned automatically on start.

The panel also appends a browser-side debug log trail below the server entries. That trail has no category of its own, so it only appears under **All Logs** and **System Logs** - the other three tabs show only the matching server-categorized entries, so each tab's content is distinct.

## Settings Layout & Card Standards

All settings pages follow the standard layout established on `/settings/metadata`:

1. **Section Heading Structure (`sync-static-heading`)**:
   - Every settings card uses `<div class="section-heading sync-static-heading"><div><div><p style="margin: 0;">[Title]</p></div><span>[Description]</span></div></div>`.
   - Title is rendered bold on the left (`font-weight: 850; font-size: 0.95rem;`).
   - Description is right-aligned on the right side of the card header (`color: var(--muted); font-size: 0.78rem; text-align: right; flex: 0 1 auto;`).

2. **Card Inner Spacing & Layout**:
   - `.settings-pane` and `.settings-content` use `gap: var(--space-5);` (1.5rem / 24px) vertical spacing between stacked settings rows.
   - All settings cards (`.settings-card`, `.tool-section-card`, `.settings-row-help > article`) use `gap: var(--space-5) !important;` (1.5rem / 24px) inner spacing between title and card content.
   - Card content elements have `margin-top: 0 !important;` to avoid doubling the flex gap.

3. **Help Card Height Constraint (`prepareHelpReadMore`)**:
   - `.settings-row` uses `align-items: flex-start;` so main sections and help boxes size tightly to content without creating empty vertical space.
   - `prepareHelpReadMore()` measures the height of `.settings-row-main` on the left. If the right help box (`.settings-row-help > article`) exceeds the main card height, it auto-collapses with `max-height: ${mainCardHeight}px` and appends a "Read more" toggle button.
   - A `ResizeObserver` monitors main card height changes and updates help box collapse states dynamically.
