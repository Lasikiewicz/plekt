# Settings

Simkl checks run on demand and after media-server events, never on unattended
polling. Event-driven checks are throttled to at most once per 30 minutes; Check
now is immediate. Ordinary outbound watches wait up to 30 minutes so several can
share one batch; explicit multi-item marks still send immediately. The integration retains baseline/delta
observations and activity cursors durably. Unsafe observations from the initial
baseline remain available to the explicit full-sync preview, but do not create a
permanent Sync Attention queue; newly observed unsafe delta items do. **Keep local
history** hides a delta observation without applying it or sending a tracker write.
Settings → Connections → External trackers includes a Simkl connection card.
Opening Settings reads saved tracker previews and sync status locally. Watchlist
status does not resolve Plex credentials, and Settings bootstrap skips automatic
Seerr capability requests; explicit Seerr save/test actions can still contact Seerr.
Simkl and Trakt have separate boxes. The Trakt box contains its live connection,
manual connection and history importer.
Select Connect, copy the code and approve access in Simkl; Plekt uses its own
Simkl app, so no Client ID is needed. The page waits for completion and reports
expiry or failure so sign-in can be restarted. Connected accounts show
**Connected**; reconnect-required accounts show that state explicitly.
Disconnect deletes Plekt's encrypted credentials and keeps local history; access
can also be revoked in Simkl's connected-app settings. The Simkl card has the same
**First connection** choice as Trakt (start from current state, or review history for
import after connecting). The first check always establishes a baseline; it never
imports old watched state automatically. Unsafe baseline rows stay available to an
explicit full-sync preview without raising individual Sync Attention warnings.
**Check now** checks for new changes;
historical import requires the full-sync preview and explicit selected-item approval.
Simkl full sync supports previewed import and selected batched sends, subject to
normal activation, identity and quota guards. Ordinary eligible watched dispatches use
batches of up to 100 items. Titles already
observed watched on Simkl settle without a request. Each remaining batch uses a
quota preflight, one send and bounded delta confirmation, preserving a 55-request
reserve. Unsent intents stay pending when quota is insufficient or unknown;
uncertain writes wait for review and are never automatically resent. This does
not authorize sending an unresolved write again through a new full-sync plan.
Simkl sends audited as absent from current watched progress stay in Sync Attention
until reviewed; full-sync previews skip those episodes, and routine cleanup retains
their holds. Catalogue match failures retain their normal rejection behavior.
Paid rewatches and unwatches remain disabled.
Personal Rating Sync supports movies and shows with safe-write holds; held writes
and readback conflicts list the title and explanation in the rating provider row.

Dropped titles sync both ways for Trakt and Simkl. Trakt hides shows only (movies
stay local). Simkl moves the title to its Dropped list and, on un-drop, restores the
list it was on before the drop (Watching, Plan to Watch or On Hold for shows; always
Plan to Watch for movies, because Simkl's Watching state for a movie records it as
watched). A title that was Completed
before the drop is held rather than moved back, because Simkl would record a watch. Drop sync never writes watched or unwatched state. When Plekt and a tracker
disagree, the newest explicit action wins. If a tracker omits the title's change time,
a queued local action keeps priority. A drop imported from a tracker is not pushed
back to it. Simkl writes wait for the next user or media-server event; they are not
drained by the scheduled poll.

Each connected tracker card also shows:

- the first check's durable progress (waiting, importing N of M items, finished, or
  failed with the reason), stored on the connection rather than in onboarding state, so a
  tracker added after setup reports its import the same way;
- **Prefer the tracker's earlier watch date**, a per-connection toggle shown beside
  Full sync (not inside the first-check status): when Plex, Emby or Jellyfin later
  report a title the tracker already knew, keep the tracker's earlier date instead
  of the server's newer one. First-run setup is import-only for trackers; sending
  to Trakt is available later in Settings;
- an optional **Full sync** with a mandatory stored preview, valid for one hour.
  **Compare with Plekt** sits beside the connection actions and shows progress while reading.
  **Compare with Plekt** lists every addition, preserved date difference and skipped
  item, grouped into expandable shows and movies. Actionable items start selected;
  deselect any before choosing import, send, or both directions. Tracker comparison
  uses the last recorded observations; applying verifies fresh tracker and media-server
  state and returns a replacement preview if anything changed. No changed plan is
  silently approved. A verified automatic watch-history backup precedes the final
  fresh check and all writes; its name and restore link remain in the result.
  Imports list Plekt and eligible missing media-server destinations and use normal
  watched propagation. Existing watched dates are preserved, including on already
  watched media servers. Plex's inability to set a historical date is shown explicitly.
  Sending adds one play per missing item at its earliest Plekt date, never every rewatch.
  Pending, uncertain and recently delivered tracker writes are held out to avoid
  duplicate sends. Simkl batches gather up to 100 and show the selected batch cost,
  up to 18 verification requests, available quota when known, and the retained reserve.
  Large Simkl sends need not fit one day's quota: the approved selection is stored as a
  paced run that continues automatically after each daily reset (also across restarts).
  Each day it leaves 20% of Simkl's reported daily allowance for normal use plus the
  55-request safety reserve. The preview shows the selected request estimate, both
  reserves and approximate quota days; an unknown allowance is shown as unavailable,
  never assumed. While waiting, the card shows items left and the resume time, and
  **Cancel full sync** stops further sends. Each day only previously approved items are
  rechecked: already on Simkl completes, no longer watched is cancelled, a changed date
  or held write goes to review, and an uncertain send is never replayed. New history is
  never added to a running sync. Compare is unavailable until the run finishes or is cancelled.
  During first-run setup, selecting **Import watch history** and pressing Continue
  imports all eligible missing watches automatically after a verified backup and fresh-state check; no
  separate preview is required. Progress survives reload, and partial delivery points
  to Sync Activity. In Settings, manual full sync still requires preview and selection.

Watches recorded after a tracker was connected are sent to it straight away. Older Plekt
history recorded before the connection reaches it only through the full sync or a tool
the user runs (Force Sync); a pending-dispatch replay of an older row records a
deliberate skip for that tracker instead of sending it.

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
| Connections | `/settings/connections` | External trackers (Trakt and Simkl), One Time Imports (Tautulli and Netflix), Seerr | `/settings/connections#trakt`, `/settings/connections#one-time-imports`, `/settings/connections#seerr` |
| Metadata | `/settings/metadata` | Metadata Providers, Refresh Metadata (TMDB, TVDB) | `/settings/metadata#metadata-providers`, `/settings/metadata#refresh-metadata` |
| Sync | `/settings/sync` | Sync Tuning, Sync Tools (Repair Recent Items, Full Sync Watchstates, Force Sync, Personal Rating Sync, Plex Watchlist Sync), Sync History | `/settings/sync#sync-tuning`, `/settings/sync#sync-tools`, `/settings/sync#sync-history` |
| Backup | `/settings/backup` | Local (Watch History, Plekt), Remote (Watch History, Plekt) | `/settings/backup#backup-local`, `/settings/backup#backup-remote` |
| Restore | `/settings/restore` | Local (Watch History, Plekt), Remote (Watch History, Plekt) | `/settings/restore#restore-local`, `/settings/restore#restore-remote` |
| Tools | `/settings/tools` | Guided Setup, Database Repairs, Library Rebuilds and Backfills, Wipe data (Watch History, Personal Watchlist, Sync History & Logs, Everything Tracked, Wipe All / Fresh Start) | `/settings/tools#guided-setup`, `/settings/tools#database-repairs`, `/settings/tools#library-rebuilds`, `/settings/tools#wipe-data` |
| Users (admin only) | `/settings/users` | Multi-user stats, account list, Add user | - |
| Logs | `/settings/logs` | (none - single-page group) | - |
| Changelog | `/settings/changelog` | (none - single-page group) | Main / Alpha channel toggle; see [`development.md`](development.md#changelog-and-update-check) |

For a non-admin user, the General parent route contains only that user's Account section. The
sidebar, Settings overview, and route aggregation omit shared installation settings and
maintenance sections; personal media-server and connection settings, webhook setup, sync history,
appearance, and Changelog remain available.

The administrator's signed-in account appears in the sidebar footer above Version. Selecting it
opens the account switcher when more than one account is available; non-admin accounts see their
name without the switcher.

Tracker connection views use the server's provider inventory. Trakt and Simkl are
enabled with separate connection state and capability limits; registration alone
does not authorize unsupported operations or a bulk history push.

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

The External trackers section also owns the live bidirectional Trakt connection. Plekt ships a
device application in the same model as the Jellyfin Trakt plugin, so the normal flow
asks only for the initial-sync policy and then displays a Trakt authorization code.
`TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` can override the bundled application for
rotation or a private deployment. The advanced personal-app fields remain a fallback
for Trakt VIP developers and their values are encrypted at rest.

Connections includes a **One Time Imports** parent card containing Tautulli and Netflix
accordion sections in the same compact content group, with one combined help card beside the parent.
`#oneTimeImportsContent` is also borrowed by the guided-setup **Import & sync** step
(`onboarding.js`); `applySettingsRoute()` re-parents it under `#oneTimeImportsHome` when
Connections → One Time Imports is opened directly. The Netflix accordion shows
whether a CSV is needed or selected. The Tautulli importer
stores its URL and API key separately from the Plex connection, scopes each request to one
selected Tautulli user, and previews completed movies and episodes before writing. A local
watch-history backup is created before a confirmed import.

During first-run setup, active one-time import commits join the initial-sync completion
barrier. Continue on Import & sync then sends missing watches to writable destinations;
the Initial sync chip exposes progress and held work. See [onboarding](onboarding.md).

The Netflix importer reads `CONTENT_INTERACTION/ViewingActivity.csv`
from Account → Security & privacy → Download your personal information. It lists every profile on
the account, so after choosing the file you tick the profiles you used (`#netflixProfileChoice`);
If the CSV contains only one profile with usable titles, it is selected automatically; profiles containing only blank, unknown, unnamed-show or supplemental titles are omitted. Preview stays disabled until at least one is ticked, and only those profiles' rows are uploaded
(12 MB limit). Trailers, previews and other `Supplemental Video Type` rows are dropped. Each title
counts once per UTC day: a profile's sessions for that title and day must total at least 5
minutes, and several chosen profiles watching it the same day still give one play, dated at the
latest session's end. Netflix's `(Episode N)` title suffix is stripped before matching; the number
only narrows several same-titled episodes to one, lifts that episode in suggestions, and stops the
row being read as a colon-containing film. A bare number left where Netflix dropped the word
(`Show:  1: Title`, `:  7: Episode 8`) and localized season words (`Staffel 2:`, `Temporada 1:`)
are season labels. Hard facts from the file then rule out candidates: a same-named show missing a
season and episode number the rows name is dropped, and a film whose TMDB runtime is shorter
than the furthest `Bookmark` is dropped; a single survivor matches. When exact titles miss, the
episode at the row's season and Netflix number matches only if TMDB has no real name for it or
the names agree (words shared by the season's names, filler words and differing part numbers
do not count); TMDB episodes that merge two Netflix rows (`A / B`) match either one. A colon
title with no season label or Netflix number, whose prefix is no TV show, imports as the single
exact film of the full title. `&`/`and` and trailing sequel numerals (`II`/`2`) compare equal,
and a title TMDB cannot find is searched again with `and`/`&` swapped. When no TMDB result has
the exact Netflix name, a top result whose TMDB alternative titles include it counts as exact
(Mako Mermaids for Mako: Island of Secrets, the British `Daniel Tiger's Neighbourhood`).
Failing that, a country suffix (`Shameless (U.S.)`, `(UK)`) matches the same name only where
TMDB records that country of origin (the 2011 US show, not the 2004 British one), and a leading
`The` that TMDB leaves out is dropped (`The Dublin Murders` is TMDB's `Dublin Murders`). A year Netflix puts in a film title (`Beauty and the Beast (2017)`) is left out of the TMDB
search and then picks the single same-named film released within a year of it.
Blank-title, `Unknown Title`, and `Unknown Title (Episode N)` rows are silently discarded before profile counts or preview totals,
so they never appear in review. The settings page no longer offers the per-profile
`Title,Date` export (Profile & parental controls → Viewing activity → Download all), but the
parser still accepts it. Large histories may take several
minutes to preview (around 20 minutes for large libraries). Time varies with export size and TMDB
response speed. Series rows match the show, then the episode title against TMDB season data, so
only episodes present in the CSV are imported. Ambiguous shows are compared against distinct
episode titles across the CSV: selection requires at least two exact, unique episode matches,
a lead of at least two over the next candidate, and at least 1.5 times its matches. Rewatches
and generic `Episode N` labels do not increase show confidence. Popularity only orders tied
suggestions and never resolves a tied evidence score, with one exception ("Netflix title +
clear winner"): when no hard fact splits same-named titles, the one candidate that fits an
official Netflix report entry (its `(1999)` label or Netflix premiere year within a year) is
matched if it has at least 50 TMDB votes and ten times the votes of every other candidate. Alternative colon boundaries allow
show names containing colons to resolve when episode evidence establishes a clear winner.
The selected boundary must also match the current episode, so a parent show's larger viewing
history cannot hide a spin-off. Search suggestions with longer names require the same distinct
episode evidence; a suggestion alone never identifies a show. Nested `Limited Series` labels,
`Vol. N` labels and a repeated series name followed by a season number are parsed before
matching; episode-title and conflicting-part-number guards still apply. A named batch can
constrain a season when three distinct titles each uniquely identify that one TMDB season.
With no episode coordinates or competing episode match, a unique released full-row movie
title can also resolve a row whose shorter TV prefix is ambiguous.
Explicitly sourced Netflix editorial aliases also recover title differences such as
`Trolls Holiday Special` / `Trolls Holiday`; the word `Special` is not dropped generally,
and these aliases never supply the clear-winner rule's engagement-report evidence.
Netflix's Charité at War title, corroborated by producer UFA, also searches Charité;
its six distinct episode titles establish TMDB season 2 through the existing season-map rules.
TMDB's original-language title/name also counts as exact. If no literal title matches,
a leading spelled English number may match its digits (`Fifty Dead Men Walking` / `50 Dead
Men Walking`); literal matches take precedence and competing namesakes remain in review.
Explicit season hints constrain automatic episode matching; a match in another season stays
in review, except where Netflix renumbers a season (Mako Mermaids' Netflix season 4 is TMDB
season 3): when at least three of a Netflix season's titles each name exactly one TMDB episode,
all in one other season, and none matches in the labelled season, its rows match by title in
that season (decision 55). A single title that still misses can match when one episode in the
labelled season is the only loose fit (ignoring a leading article, filler words, `Pt.`/`Part`,
`&`/`and` and the show's own prefix); otherwise, when nothing in the labelled season fits, the
show's only season 0 special of that title, or, if TMDB has the labelled season, the one episode
in the whole show with that exact title. A show-prefixed row with no season or episode number
that names no episode (`Alvin and the Chipmunks: The Road Chip`) is imported as the one film,
released by the watch year and long enough for the bookmark, with that full title. British `Series N:` labels are treated as explicit seasons; Netflix `Part N:` release
batches are stripped without assuming they are provider seasons. Anthology/series subtitle
prefixes are tried only after a full episode-title miss, retaining competing matches for review.
Episode titles also normalize accents and numbered `(2)` / `Part 2` suffixes. Near-miss titles
(hyphen drift, a trailing plural `s`, or a trailing `(I)` / `(II)`) auto-match only when that
softened key is unique inside the hinted season; otherwise they stay in review. When both
neighbouring CSV rows for the same show and season uniquely match episodes that differ by
exactly two, the row between them takes the single missing TMDB episode (for example Netflix
`Good to Go` between `Where the Heart Is` and `He Who Hesitates` → `Oh the Places You'll Go`).
Netflix labels such as `Season 12:` and
`Limited Series:` are stripped before matching, and `Season N` / `Episode N` numbers are used as
hints when present. When several TMDB movies share an exact name, a unique release year that
matches the Netflix watch year is auto-selected into a collapsed “matched by watch year”
section you can still change or skip; otherwise the title stays in requires review. Before
that, exact movie or show candidates first released after the watch year are ruled out, but
only when every candidate has a release year; the review list still shows all of them.
Combined Netflix rows such as `Alpha / Beta` import every segment as its own episode, only
when each segment names exactly one TMDB episode; this also counts as show evidence. If a
segment has no existing title match, its known show prefix (including possessive `s`) and
the filler words `the`, `a`, `an`, `and`, `of` may be removed from both titles. All remaining
words must agree in order, including part numbers, and name one episode in the allowed
season. Missing, ambiguous or repeated segment targets leave the whole row in review;
`Grandad` and `Granddad` compare equally, recovering Peppa Pig's garage bundle without relaxing the complete-bundle or season checks.
A reversed bundle order can match a unique complete provider episode containing exactly
the same distinct segments; incomplete, repeated or extra segments remain in review.
Netflix's bundle number and neighbour gap-fill cannot resolve an incomplete bundle. A bare
`Episode N` is read as season 1 when the same show's other rows carry `Season N:` labels and
none is labelled season 1. When the first colon does not give a unique show, a longer colon
prefix is used only if exactly one longer prefix is a unique exact TMDB show. It previews exact unique TMDB matches, year-resolved titles, existing plays, and a requires-review
list; unmatched episode rows are grouped under their show. Separate summary boxes show matched watches, watch-year matches, required review, existing watches, and excluded short views, with review instructions beneath them. Blank titles, Netflix's `Unknown Title`
placeholder (including `Unknown Title (Episode N)`),
and episode rows with no show name (such as `: Episode 8`) are silently excluded before profile and preview
counts. Review each remaining item by choosing a suggested match or skipping it before commit.
Choose the show once and use **Match episodes** to rematch its unresolved CSV rows in the
preview. TMDB episode titles are tried first, then linked TVDB titles when a unique episode ID
or air-date mapping identifies the same TMDB episode. TMDB numbering is retained; ambiguous
cross-provider mappings stay in review. Matching never marks an entire series watched.
Verified complete-row mappings cover the Modi special, Big Al mini-series, two LEGO Friends
episodes and the Just One Bite / The Bully bundle. They require the exact source title and
every recorded episode ID, canonical title and air date, while keeping current provider
coordinates. Missing, conflicting or future targets stay on the normal review path.
The same registry covers verified named rows in Sirens, Starstruck, Medal of Honor and
Go, Diego, Go. Reused Don't Tell the Bride couple titles are pinned only for pre-2021 watches,
before the retrospective versions. Longer provider names and individual named bundle segments
can supply show evidence, but every query word must occur in order and the existing evidence
lead and complete-current-row checks still apply.
Sourced episode aliases also recover six alternate or censored You Me Her titles and Peppa Pig's
Cold Winter's Day and Zoë Zebra segments. An alias requires the exact TMDB show and unique
episode ID, the expected canonical title, and the recorded air date when present; conflicts
stay in review. Every segment of a bundle still needs its own unique episode match.
Other source-pinned entries cover verified broadcaster, alternate-dub and spelling variants;
they do not allow arbitrary changed words or partial episode bundles to match.
Choosing a show does not select its episodes. After matching, expand **Review episodes** and
select each episode to include; each stays skipped until selected. Matching only updates the
preview and does not write history. The source title
and proposed episode are shown before **Use suggested matches for season…** selects that batch;
the final import still requires confirmation. **Skip this show** selects skip for its review
rows. Unrelated selections survive a show rematch when their candidates remain valid.
Official Netflix engagement reports provide an additional, bundled title snapshot. Paired
English/original-language titles expand failed searches and rank report-supported suggestions,
labelled **Netflix title alias**. Listed full show names help preserve colons; listed film names
can recover colon-containing movies when no competing exact TV prefix exists. Existing exact
same-name candidates are retained, so report presence does not resolve remakes by itself.
Report absence and viewing hours never exclude or choose a title; report years only take
part in the clear-winner rule above.
The snapshot covers five reports from 2023 H2 through 2026 H1, with gaps; it is not a complete
historical catalogue. Missing snapshot data falls back to normal matching. See the metadata
documentation for the refresh command and source provenance.
Plekt creates a local watch-history backup, inserts only selected plays not already present,
then queues outbound sync to connected Plex, Emby, Jellyfin, Trakt, and Simkl destinations.
A later re-upload of the Viewing Activity CSV skips title+date rows already imported from
Netflix before TMDB matching, so only new watches need scanning.
The existing **Sync historical watched items to Plex** setting still controls Plex writes.
Tracker writes use their normal configured queue spacing.

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

Simkl is an independent enabled tracker with user/media-event library checks rather
than unattended inbound polling. Its complete local history remains in Plekt; Simkl
snapshots and safe rating changes use persisted account-bound observations. Uncertain
writes and unresolved anime/special identities stay held. Missing items in a Simkl
snapshot never authorize automatic absence reconciliation. Paid rewatches and
list-destructive unwatches remain unsupported. Adding a tracker after setup does not
send older backlog automatically; use its explicit compare/full-sync controls.

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

The same control and copy appear during guided first-run setup alongside the import
options, because it changes what an import will do.

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
| Connections | `tools` panel's Trakt (`tools-migration`), One Time Imports (`tools-one-time-imports`, containing Tautulli and Netflix), and Seerr rows |

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
| `/settings/connections#tautulli` | `/settings/connections#one-time-imports` |
| `/settings/tautulli` | `/settings/connections` |
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
  each. It includes unmatched title-keyed rows as well as episode-id aliases. **Belongs to this
  show** moves them into the show (the newest watch state wins); **Different show** leaves them
  alone and stops them being listed or repaired again. The **Dismissed** section can restore a
  dismissed entry to review. These actions change only Plekt's watch state; nothing is sent to
  connected platforms. **Repair Split Episode Shows** (`routes/splitEpisodeRepair.js`,
  `utils/splitEpisodeRepair.js`) finds watches an Emby or Jellyfin Force Sync stored under an
  episode's own ids. A row qualifies only when its ids exactly match a watched server episode
  at the same season and episode and that episode's series resolves; other rows are listed as
  skipped with a reason. The administrator ticks shows, Plekt re-checks them, takes a full
  backup (stopping if it fails), and rekeys watch history and resume positions only, never
  merging into an existing watch: an episode the show already has a watch for, under any key
  sharing a series id, is skipped for Fix Match. Nothing is dispatched; watches already sent elsewhere under
  the wrong ids are flagged for a manual check. Each run is listed with **Undo this repair**.
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

Automatic refresh preserves the scroll position while reading older entries.
**Pause updates** freezes the current snapshot, including responses already in flight;
**Resume updates** loads fresh logs. Category selection and Clear Logs are disabled while
paused. **Follow latest** scrolls to new entries; scrolling up turns it off, and the button
turns it back on. Refresh preserves a visible entry when the bounded log window rolls forward.
The case-insensitive **Filter text** searches fetched entries within the selected category,
including the paused snapshot. Copy Logs copies matching entries; Download Logs still exports
all categories. The view shows at most 250 backend and 50 browser entries and refreshes every
three seconds while open and unpaused. Opening or switching category starts at the latest entries.

The **Server Logs** panel (`/settings/logs`) displays real-time and historical diagnostic logs captured by the server alongside browser output. Logs are automatically categorized and can be filtered using interactive tabs:

- **All Logs**: Complete chronological event stream.
- **âš¡ Plex WebSockets**: WebSocket connection lifecycle, incoming timeline events, ratingKey extraction, and handler triggers.
- **ðŸ”„ Outbound Sync**: Real-time playstate dispatches, watch record insertions, and manual watch/unwatch propagation.
- **â±ï¸ Scheduled Polls**: Periodic background catch-up library checks, session tracking, and scheduled sync cycles.
- **ðŸ–¥ï¸ System Logs**: General administrative, startup, and system events.

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
   - `prepareHelpReadMore()` keeps each help box at least as tall as its matching left settings card. It shows "Read more" only when meaningful additional help is clipped; expanded help can grow past the left card.
   - Accordion status labels in Settings and `/setup` render as plain coloured text (no pill chrome), right-aligned in the summary row.
   - A `ResizeObserver` monitors main card height changes and updates help box collapse states dynamically.
