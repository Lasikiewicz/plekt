# Watch-History Backups

Plekt's watch-history backup subsystem stores the minimum data required to restore
watched state and resume progress. It is separate from the encrypted full-backup and
plain portable export/import systems described in [backups.md](backups.md).

## Backup document

Each backup is a gzip-compressed JSON document named
`plekt-watch-history-<YYYYMMDDTHHMMSSZ>.json.gz`.

The document contains:

- `watchHistory`: rows from `watch_history`.
- `playstate`: canonical watched/unwatched rows.
- `playbackProgress`: resume positions.
- `format`, `version`, `createdAt`, row `counts`, and a SHA-256 `dataChecksum`.

Poster URLs, artwork binaries, metadata caches, sessions, logs, credentials, and
media-server configuration are excluded.

## Local scheduling and storage

- Configure the feature in **Settings → Backup → Local**
  (`/settings/backup#backup-local`).
- The elected scheduler runs the local backup once per day after the configured local
  time. The default time is 03:00.
- Local files are written under `data/backups/watch-history/` using a temporary file
  followed by an atomic rename.
- Local retention defaults to 7 files (about seven days) and accepts values from 1 through 365.
- Recovery snapshots referenced by a recent sync plan are protected from retention
  deletion while that plan remains active.

## Restore

Restore is available from **Settings → Restore → Local**
(`/settings/restore#restore-local`). The restore modes are:

- **Merge**: add missing records and apply the newest state for conflicts.
- **Replace**: clear `watch_history`, `playstate`, and `playback_progress` before import.
- **Dry run**: validate the document and report expected changes without writing.

Uploaded files use the same format and validation as local files. Restore pauses cron
sync while the authoritative restore operation runs, increments the data version after
the transaction, and records the restore result in runtime state.

## Remote copies

Remote mirroring has an independent daily schedule, time, and retention count. Local and
remote retention each default to 7 files (about seven days). A fresh local backup is
verified and durable before it is uploaded. Remote failures are recorded per destination
and do not invalidate or delete the local file.

Supported destination adapters are listed in [backups.md](backups.md): local folder,
WebDAV, S3-compatible storage, Backblaze B2, OneDrive, and Dropbox. Destination secrets
remain server-side and are redacted from API responses. Remote retention applies only
to files of the same backup type.

## API and runtime state

`GET/POST /api/watch-backups` provides status, list, create, download, upload, restore,
destination management, destination tests, and remote list/pull operations.
Configuration is stored in the `watchHistoryBackups` settings row; scheduler state is
stored in the `watchHistoryBackups` runtime-state record.

Watch-history backups do not contain provider credentials. Use the encrypted full-backup
subsystem for portable snapshots that include settings and secrets, or copy the complete
`data/` directory while the application is stopped for a filesystem-level recovery.

Implementation: `server/src/utils/watchHistoryBackups.js` and
`public/modules/tools-backups.js`.

## Backups from before the rename

Plekt writes new backup files and format markers under Plekt names. Backups written by Plembfin remain accepted, listed and pruned, including encrypted and watch-history backups. The local full-backup folder `data/backups/plembfin` and default Dropbox folder `/Plembfin Backups` stay unchanged so existing backups remain visible. A newly written Plekt backup cannot be restored by an older Plembfin build.
