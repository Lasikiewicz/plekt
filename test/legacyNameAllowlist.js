// Where the old name "plembfin" is allowed to remain after the rename to Plekt,
// and why. The final-sweep guard test reads this: any match outside it fails.
//
// class "keep":        stored on disk, in a browser, or on a provider; renaming
//                      costs existing installs something and shows nobody anything.
// class "accept-both": the old name is still read from outside the code, beside
//                      the new one that is now written.
// class "history":     records of the past, left as written.
//
// `pattern` matches the text of the occurrence; `files` (optional) limits where.
export const PLEMBFIN_NAME_ALLOWLIST = [
  // Accept both
  { class: "accept-both", pattern: /PLEMBFIN_[A-Z0-9_]+/, reason: "Environment variables set by existing installs; read through brandEnv() after PLEKT_<NAME>." },
  { class: "accept-both", pattern: /x-plembfin-webhook-secret/i, reason: "Webhook secret header configured in existing Emby, Jellyfin and automation clients." },
  { class: "accept-both", pattern: /plembfin-(?:encrypted-|watch-history-)?backup/, reason: "Backup format names and file names written before the rename; still restored, listed and pruned." },
  { class: "accept-both", pattern: /plembfin-watch-history-/, reason: "Watch-history backup file names written before the rename." },
  { class: "accept-both", pattern: /__plembfin(?:Type|RedactedSecrets)/, reason: "Marker fields inside backups written before the rename." },
  { class: "accept-both", pattern: /plembfin\.db/, reason: "Database file of existing installs; used whenever it exists, never replaced by plekt.db." },
  { class: "accept-both", pattern: /ProgramData.{0,12}Plembfin|"Plembfin"/, files: ["server/src/paths.js"], reason: "Windows service data folder of existing installs, until the installer moves it." },

  // Keep
  { class: "keep", pattern: /"plembfin"/, files: ["server/src/paths.js"], reason: "Local full-backup folder backups/plembfin/; renaming hides existing backups from the list and from retention." },
  { class: "keep", pattern: /plembfin_session/, reason: "Session cookie; renaming signs everyone out and drops in-flight media sign-ins." },
  { class: "keep", pattern: /\/api\/plembfin-backups/, reason: "Route used by scripts and by cached older pages." },
  { class: "keep", pattern: /plembfin-restore-upload-/, reason: "Temporary upload files a restore in progress may still be reading." },
  { class: "keep", pattern: /plembfin-up-next-(?:seed|refresh)|plembfin-watchlist|DeviceId="plembfin"|Client="Plembfin"/, reason: "Provider device identity: how the app recognises its own synthetic sessions; a mismatch can record phantom watches." },
  { class: "keep", pattern: /"Plembfin"|Device="Plembfin(?: Up Next)?"|\^plembfin\\b/, files: ["server/src/utils/brandEnv.js", "server/src/utils/embyLikeAuth.js", "server/src/utils/jellyfinAuth.js", "server/src/utils/embyClient.js"], reason: "App and device name announced by connections registered before the rename (decision D7); new registrations announce Plekt." },
  { class: "keep", pattern: /\/Plembfin Backups/, files: ["server/src/utils/backupDestinations/dropbox.js"], reason: "Default Dropbox folder; existing installs relying on the default keep finding their backups." },
  { class: "keep", pattern: /managed_by_plembfin|'plembfin'|plembfin%|plembfin:server-configured/, reason: "Database values, columns and CHECK constraints; renaming needs table rebuilds for no visible gain." },
  { class: "keep", pattern: /plembfin:[a-z-]+|plembfin_debug_logs|plembfin-live-updates/, files: ["public/"], reason: "Browser storage keys and channel; renaming resets every browser's preferences." },
  { class: "keep", pattern: /plembfin-tvdb-token-cache-v1/, reason: "Key-derivation salt for a cache." },
  { class: "keep", pattern: /plembfinBackups/, reason: "Settings and runtime-state row ids for the full-backup schedule." },

  // History
  { class: "history", files: ["CHANGELOG.md", "changelog.json", "changelog-develop.json", "changelog-alpha.json", "docs/decisions.md", "docs/benchmarks/"], reason: "Past changelog entries, decision records and benchmark results." },
];
