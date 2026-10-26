# Backups

Initial outward-sync item progress is included in backups. Restored unfinished rows
are held for review and restored active job headers become interrupted; restoring a
backup never resumes initial provider sends automatically.

Plekt has **three backup subsystems** plus a set of pluggable remote destinations.
Schedules and destinations are managed from **Settings → Backup → Local / Remote**
(`/settings/backup#backup-local`, `/settings/backup#backup-remote`); recovery workflows
live under **Settings → Restore → Local / Remote** (`/settings/restore#restore-local`,
`/settings/restore#restore-remote`) (UI in `public/modules/tools-backups.js`).

| Subsystem | What it saves | Format | Files |
| --- | --- | --- | --- |
| Watch-history backups | `watch_history`, `playstate`, `playback_progress` + manifest | gzip JSON (`plekt-watch-history-<stamp>.json.gz`) | `server/src/utils/watchHistoryBackups.js` |
| Encrypted full backups | Every portable collection, including canonical personal watchlist mutations, provider ledger, queue, runs, and activity (but no provider secret) | AES-256-GCM encrypted JSON (`plekt-backup-<stamp>.encrypted.json`) | `server/src/utils/plektBackups.js` |
| Full export/import | Same portable collections, plain JSON, paged over the API | `plekt-backup` v1 document | `server/src/utils/backup.js` |

Saved show and season poster choices are included as database records. Artwork binaries,
poster cache rows, and TMDB metadata cache rows are not included; copy `data/media/`
separately when preserving the locally cached images themselves.

Full and portable backups include dropped-title flags, identities, original drop times and
saved title snapshots. Restoring them invalidates Up Next so dropped titles remain excluded.
Watch-history-only backups do not include queue preferences such as Dropped. Wipe Data removes
dropped titles with the other Up Next state.

Encrypted full backups retain tracker observation cursors, inbox/review decisions and
write intents with their original connection/account fences. Restored unfinished known
tracker work is held for review because remote history did not roll back with the backup.
Browser portable exports omit these account-bound ledgers alongside tracker credentials.

Full and portable exports also retain each show's metadata source, stored-row numbering and
Fix Match timestamp (`showSeasonSource`). Watch provenance retains its per-row Trakt override.
Restore replay applies those overrides or the restored show mapping before clearing Trakt
history; an unmatched translated episode fails the preflight rather than being replayed under
its stored number. Older exports cannot recover a per-show choice they did not contain.

The focused watch-history subsystem reference is
[watch-history-backups.md](watch-history-backups.md); this doc covers all backup
subsystems and their shared destination adapters.

## Watch-history backups (`watchHistoryBackups.js`)

Small, automatic backups of just the data needed to restore watch state.

- **Contents** - the three watch-state tables plus a manifest (format/version, app
  version, creation time, row counts, checksum). Poster URLs are excluded (derived
  data, may embed expired tokens).
- **Scheduling** - the elected background worker runs `runScheduledWatchBackup()` and
  `runScheduledRemoteWatchBackup()` once per tick. Each fires daily at its own
  configured time (default 03:00), catching up if the scheduled time was missed: the
  local schedule writes a local backup, and the remote schedule creates a fresh backup
  and uploads it to every enabled destination. Config (`enabled`, `time`, `retention`,
  `remoteEnabled`, `remoteTime`, `remoteRetention`) lives in the `settings` row
  `watchHistoryBackups`; run state in `runtime_state` (`watchHistoryBackups`).
- **Storage** - always written to `data/backups/watch-history/` first: temp file →
  checksum verify → atomic rename. Local and remote retention default to 7 files (about
  seven days; max 365) and prune the oldest.
- **Restore** - `restoreWatchHistoryBackup(filename, { mode, dryRun })` supports
  **merge** (add missing, newest state wins on conflict), **replace** (clear the three
  tables first), and **dry run** (validate + report expected changes without writing).
  Uploaded files restore via `importWatchHistoryBackupFile`. Restores pause the cron
  sync (`pauseCronSync`, default 10 minutes) so the catch-up sync can't fight the
  restore, and stamp `lastRestoreAt`.
  A watch-history restore holds a write fence while it runs. Manual watched-status edits
  made in the app skip the fence; automated sync writes wait. A heartbeat stale for three
  minutes releases an orphaned restore fence automatically, after rechecking the owner
  and heartbeat. Settings → Backups retains the original failure until **Clear Status**
  is selected; dismissing that notice does not clear a different sync operation.
  Blocked automated writes return HTTP 409 with `code: RESTORE_ACTIVE` and the restore
  explanation. Direct manual watch edits stay available, with remote propagation queued
  until the restore fence releases.
- **API** - everything multiplexes through `GET/POST /api/watch-backups`
  (`handleWatchBackups` in `index.js`): status, list, create, download, upload,
  restore, destination CRUD, destination test, remote list/pull.

The Tautulli one-time importer uses the same local watch-history backup format, but
stages its workflow separately: preview and resolve matches first, create the
recommended pre-import backup (or explicitly skip it), then run the import. The
backup and import stages each show their own progress state in the UI. After a
successful import, Plekt reports completion and queues the selected targets for
background syncing.

### Remote destinations (`backupDestinations/`)

Watch-history backups upload to destinations on their own daily schedule (the Remote
Watch History Backups card) or on demand via that card's Back Up Now button; encrypted
full backups upload on their schedule or Back Up Now in the same way. Every upload is
best-effort - a remote failure never invalidates or deletes the local file.
Per-destination status (last attempt/success, bytes, duration, error) is recorded in
the backup runtime and shown on the Remote Watch History Backups card. Remote retention
is ordered by the sortable filename and scoped per backup type: pruning after a
watch-history upload only counts watch-history files (remote retention setting), and
pruning after a full-backup upload only counts encrypted full backups (Plekt
retention setting), so the two types never delete each other's files.

All adapters implement the same contract (`index.js` in the folder):
`testConnection() / upload(localPath, remoteName) / list() / download(remoteName) /
delete(remoteName)`.

| Type | Adapter | Auth |
| --- | --- | --- |
| `folder` | `folder.js` | none - local path (useful for mounted NAS storage) |
| `webdav` | `webdav.js` | basic auth |
| `s3` / `backblaze` | `s3.js` | access key + secret, built-in SigV4 signer (AWS S3, Backblaze B2, MinIO…) |
| `onedrive` | `onedrive.js` | Microsoft device-code OAuth (user supplies an Azure app client ID; app-folder scope; refresh token persisted via `persistSecrets`) |
| `dropbox` | `dropbox.js` | manual no-redirect OAuth code flow; refresh token persisted |

Destination records (`{ id, type, label, settings, secrets }`) live in the settings row
`watchBackupDestinations`. Secret fields (`password`, `secretAccessKey`, `appSecret`,
`refreshToken`) never reach the browser - every API response redacts them to "is-set"
flags (`loadBackupDestinationsRedacted`). Backup transfers use a 60-second outbound
timeout (vs the configurable 10s default). S3/Backblaze uploads are streamed from disk
(`uploadFileWithTimeout` in `server/src/utils/outbound.js`, over `node:http(s)` because
Node's `fetch` keeps every chunk of a streamed body in memory until the request ends):
the SigV4 payload hash comes from a separate streaming pass, `Content-Length` is sent
up front, and the 60 seconds restart with every chunk, so they only catch a stalled
transfer. The other adapters still read the whole file and are not exposed in the UI.

The settings UI currently exposes Backblaze B2 destinations. Each configured target is
shown as a status card; the trailing **+** card opens the type picker, and selecting a
card opens an edit dialog with Save, Test, and Delete. The B2 form uses the adapter's
canonical `region`, `bucket`, `accessKeyId`, `prefix`, and `secretAccessKey` fields.
Secret values are never prefilled; a configured placeholder means leaving the field
blank preserves the stored application key. Multiple B2 destination records are
supported.

## Encrypted full backups (`plektBackups.js`)

Nightly encrypted snapshots of the entire portable backup document.

- **Encryption** - AES-256-GCM, key derived with PBKDF2 (SHA-256, 100k iterations);
  passphrase must be ≥ 12 characters and is required - there is no plaintext mode.
- **Passphrase storage** - manual backups can use a one-time passphrase that is never
  persisted. Scheduled local or remote encrypted backups require "remember passphrase"
  to be enabled; existing stored passphrases are treated as remembered for backward
  compatibility and can be removed by unchecking the remember option and saving.
- **Scheduling** - `runScheduledPlembfinBackup()` runs from the same scheduler tick,
  daily at the configured time; retention default 7 (max 365). Config lives in the
  settings row `plembfinBackups`. Each attempt is recorded before it starts, so a
  failed day is retried at most 3 times, at least an hour apart, and an attempt that
  kills the process is reported on the card after the restart ("stopped before
  finishing") instead of being retried every tick.
- **Writing** - the backup is encrypted and base64-encoded in chunks straight to a
  `.tmp-<pid>` file and renamed when complete, so memory stays small whatever the
  library size (building it in memory needed about 3 GB for a 490 MB file). The file
  layout is unchanged. Leftover `.tmp-*` files older than 10 minutes, from a backup
  that was killed mid-write, are deleted at the start of the next backup.
- **Restoring** - every restore on the Restore page (a listed local backup, a remote
  backup pulled to local storage first, or an uploaded file) runs on the server, so a
  backup of any size restores. An uploaded file is sent to the server as it is (with
  upload progress) and restored from disk. The page confirms first (the dialog says the
  current data is not backed up first), starts the restore, then polls the job once a
  second and shows the check and import progress. The file's recorded iteration count
  is used, so server-made backups (100k) and browser exports (250k) both restore.
  Until 27 September 2026 the browser decrypted and parsed the whole file itself, which
  failed for backups over about 512 MB (V8's string limit). Downloading a backup from the
  card streams it from disk and works at any size.
- **Server-side restore** (`plektRestore.js`, `server/src/routes/plektRestore.js`)
  - restores a backup of any size from disk. The
    base64 payload is decoded and decrypted as a stream (the last 16 bytes are the GCM tag)
    and `backupStreamScanner.js` reads the document one collection document at a time.
  Before starting, the server runs SQLite `quick_check` on the current database. If it
  reports corruption, restore is refused before import and the Restore page explains the
  options: keep the current files for recovery, preserve the database and sidecars then
  retry against a clean database, or recover data from the damaged database first.
  A first pass decrypts the whole file, checks the tag, the format and every document,
  and writes nothing; only then does a second pass import through
  `importCollectionBatch` in batches of 250, with the browser restore's rules (same
  collections, so credential collections are left out; first batch of each collection
  resets it; watchlist restore rules; `bumpDataVersion`). A wrong passphrase or damaged
  file changes nothing. Cron catch-up is paused during the import and resumed after.
  No automatic backup of the current data is made first (user decision, 27 September
  2026). Plain portable exports restore the same way. A 648 MB backup restored 400,000
  rows in 13 s with peak memory about 234 MB. Progress is an in-memory job (restoring
  `runtimeState` replaces that table).
- **Remote mirroring** - optional; runs with the daily scheduled backup when remote
  mirroring is enabled, or immediately via the Remote Plekt Backups card's Back Up
  Now button. Reuses `pushBackupToRemotes` from the watch-history subsystem, so the
  same destination list applies; the aggregated attempt/success/error status across
  destinations is shown on the card.
- **Storage** - `data/backups/plembfin/`. **Warning:** these backups contain
  media-server URLs, usernames, tokens, and API keys (that's what the encryption is
  for).
- **API** - `GET/POST /api/plekt-backups` (`handlePlembfinBackups`): status, list,
  create, download, delete, restore-from-server, save settings.
  `POST /api/plekt-backups/upload` streams a raw backup file to a temporary upload in
  the backups folder (kept up to a day so a wrong passphrase can be retried; deleted
  after a successful restore) and returns an `uploadId`. `POST
  /api/plekt-backups/restore` with `{filename | uploadId, passphrase}` starts a
  server-side restore (202, or 409 while one is running); `GET` returns the job status
  (`verifying` / `importing` / `complete` / `failed`, bytes read, collection, documents
  imported of total). The passphrase is used only for that restore and never stored.

## Full export/import (`backup.js`)

The portable-format engine the other subsystems build on, also exposed directly:

- `GET /api/backup/export` (`handleBackupExport`) - pages collections out via
  `exportCollectionPage` (cursor + limit ≤ 500) so the browser can assemble a full
  plain-JSON backup for download (Settings → Backup / restore → Backup settings).
- `POST /api/backup/import` (`handleBackupImport`) - imports batches via
  `importCollectionBatch` (≤ 250 documents per batch, optional per-collection reset).
  Importing watch-state collections bumps `dataVersion` so derived caches reload.
  Watchlist collections are restored as local desired state: provider observations are
  downgraded, queue success/lease state is reset, a restore revision is recorded, and
  delivery pauses until the user explicitly selects **Publish restored watchlist** in
  Settings → Sync → Sync Tools.

Full backups include `personal_watchlist`, its append-only mutation/tombstone history,
provider ownership observations (including Plekt-owned playlist/container IDs),
non-secret queue/run state, and redacted activity. Provider URLs, users, and other
connection settings remain in encrypted full backups as before; browser portable export
does not include provider credentials. Restore never treats old provider success markers
as current truth and never publishes automatically.

Watch-history-only backups intentionally do **not** include personal watchlist rows,
mutations, provider ledgers, queues, or runs. Restoring one cannot change the Watchlist
page or provider watchlists.
- The `portableValue`/`reviveValue` helpers keep timestamps portable, and the format
  also revives `_seconds`-style timestamps found in old exports.

## Watch-history importer (Settings → Import)

Separate from backups: `POST /api/import` (`handleImport`) ingests watch records from
CSV/JSON files (e.g. Trakt exports, `scripts/exportPlexHistory.js` output). Frontend
flow in `tools.js` (`parseSelectedFiles`, `renderImportPreview`, `startImport`) parses
files in the browser and posts records in batches.

### Tautulli history import (Settings → Connections)

The Tautulli importer is an explicit, one-time migration tool at
`/settings/connections#tautulli`. Configure the Tautulli `/api/v2` URL and API key,
select exactly one Tautulli user, and preview completed movie and episode rows.

Before a confirmed import Plekt creates a local watch-history backup with the
reason `pre_tautulli_import`; remote mirroring follows the existing backup setting
when requested by the operation. The import is additive and does not delete or write
to Tautulli. Rows below Tautulli's watched threshold are reported as incomplete and
are not imported. Unix-second timestamps are converted before entering the normal
history pipeline, and missing dates fall back to the release date only when a new
local record is needed.

The final backup-and-import confirmation is shown in Plekt's in-app dialog, including
the multiline target summary and any possible-match plays that will remain unimported.
After confirmation, the Connections page keeps the operation visible as `Importing...` and
then reports `Import complete` while explaining that Plekt is now syncing the imported
watches to the connected media servers.

The merge is identity-aware and same-local-day: provider IDs are compared
independently, episodes can match by show/season/episode, and movies can match by
title when identity is unambiguous. A different local day is not automatically a rewatch -
see the next section. Imported
rows use the `tautulli_import` source and retain the selected Tautulli user, source
item ID, history-import event, and source timestamp in provenance. The Tautulli
`rating_key` is provenance only; it is local to that Plex/Tautulli installation and is
not used as a portable provider ID.

#### Approximated dates and rewatches

Plekt holds a lot of approximated watch dates: release-day anchoring, episode timing,
and older manual backfills all write a round clock hour rather than an observed time. A
real Tautulli playback timestamp often lands a day either side of one of those, which a
strict same-calendar-day merge would treat as a second viewing. Measured against a real
library, that silently duplicated dozens of plays.

Two rules handle it:

- **A real play within two days of an approximated record is the same viewing.** It merges
  and is counted as `merged_approximate_date`. A round clock hour (minutes and seconds both
  zero) is the tell; a genuine playback timestamp lands on one about once in 3600 plays.
- **Two plays of the same item within 31 days, where neither side looks approximated, are
  ambiguous.** Rather than guess in either direction, they go to the review list below as a
  *possible rewatch*.

Further apart than 31 days, a second play is treated as a genuine rewatch and imported
without asking.

#### Possible-match review

The review list holds two kinds of question, each labelled:

- **Possible match** - the play matches more than one existing record, so which one is it?
- **Possible rewatch** - the play sits close to one existing record, so is it a second
  viewing or the same one recorded with a different date?

Neither is ever merged on a guess or imported on a guess. The preview lists each one with
the records it could belong to, and the import stops short of it until an administrator
picks one of three resolutions:

- **Use this record** - treat the play as already represented by that existing record.
  Nothing is inserted; it is counted as reviewed and merged.
- **Import as a separate play** - the administrator is saying this is a genuinely
  distinct viewing. A new row is inserted and counted as reviewed and imported.
- **Skip this play** - drop it from this import entirely.

Because the rewatch question usually has the same answer across a whole import, the panel
also offers **All separate rewatches** and **All same viewing**, which apply to every
undecided possible-rewatch row at once. They never touch a row the administrator has
already decided, and never touch an ambiguous-match row, which has several candidates and
no single sensible bulk answer.

Leaving a row undecided is itself safe and is the default: it stays in review, is not
imported, and is reported as such in the final summary. Decisions are addressed by a
content-derived key rather than by position in the preview, because the commit re-reads
Tautulli and a play added or pruned in between would otherwise shift a decision onto a
different record.

#### Where an import is sent

The importer does not ask which servers to project to, and deliberately so. Plekt is the
source of truth, so the scheduled sync reconciles Emby and Jellyfin with imported watches
whether or not the import pushed them itself - and both receive the original Tautulli
playback date, so the watches land in the right place in their history either way. A
per-server opt-out would imply a choice that does not exist.

Plex is the one server where a setting genuinely prevents the data arriving:
**Sync historical watched items to Plex** in Sync Tuning. When it is off, the importer says
so before the import runs rather than reporting it afterwards, because imported items may
then stay unwatched in Plex. When it is on, there is nothing to ask and no notice is shown.

Each target is still reported per import as `will receive this import` or `skipped by the
historical sync policy`. A policy skip is a deliberate outcome, not a failure: the row's
telemetry records it as skipped so the scheduler's pending-dispatch sweep never retries it.

Plex is **not** excluded merely because Tautulli points at the same Plex server. An
already-watched Plex item is detected and reported as `already matching` instead, which is
accurate rather than a guess from the machine identifier. See [settings.md](settings.md).

## Frontend (`public/modules/tools-backups.js`)

Settings → Backup / restore → Backup settings renders four schedule cards - local and remote, for watch-history
and encrypted Plekt backups - each with an enable toggle in the card head, its own
time/retention (or passphrase) fields, a runtime status readout, and Save/Back Up Now
actions at the bottom right, plus the Backblaze destination cards and edit dialogs.
Settings → Backup / restore → Restore renders local/uploaded/remote backup choices and restore status
(`setBackupTransferState`). Full Plekt restores upload the chosen file
(`uploadPlembfinBackupFile`, XMLHttpRequest for upload progress) and run through
`runServerPlembfinRestore`, which starts the server restore and polls its job; the
browser never decrypts a backup. Encrypted exports are still encrypted in the browser.
State lives in
`state.watchBackups`, `state.remoteBackupFiles`, `state.backupImport`,
`state.activeBackupsTab`.

## Disaster recovery without the app

Backup files are named `plekt-backup-<stamp>.encrypted.json` and
`plekt-watch-history-<stamp>.json.gz`, with `plekt-*` format names inside. Files and
formats written under the older `plembfin-*` names are still restored, listed, and
counted by retention (`server/src/utils/backupNames.js`); retention orders files by
the timestamp in the name, not the whole name. A backup written under the new names
does not restore on a build from before the rename.

Everything lives under `data/`: the database (`plekt.db`, or `plembfin.db` on an
install that already had one; the old file is always used when present), `media/` (artwork),
`config.json` (credentials/secrets). Copying that directory and restarting is a
complete manual backup/restore - see the Backups section of
[hardening.md](hardening.md).

The local full-backup folder `data/backups/plembfin` and default Dropbox folder
`/Plembfin Backups` retain their old names so existing backups remain visible.
