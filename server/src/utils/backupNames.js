// Backup format names and file names. Backups are written under the Plekt
// names; everything that reads, lists, or prunes them also accepts the Plembfin
// names used before the rename, so a backup made by an older build restores.
export const BACKUP_FORMAT = "plekt-backup";
export const ENCRYPTED_BACKUP_FORMAT = "plekt-encrypted-backup";
export const WATCH_HISTORY_BACKUP_FORMAT = "plekt-watch-history-backup";

const LEGACY_BACKUP_FORMAT = "plembfin-backup";
const LEGACY_ENCRYPTED_BACKUP_FORMAT = "plembfin-encrypted-backup";
const LEGACY_WATCH_HISTORY_BACKUP_FORMAT = "plembfin-watch-history-backup";

export const isBackupFormat = (value) => value === BACKUP_FORMAT || value === LEGACY_BACKUP_FORMAT;
export const isEncryptedBackupFormat = (value) => value === ENCRYPTED_BACKUP_FORMAT || value === LEGACY_ENCRYPTED_BACKUP_FORMAT;
export const isWatchHistoryBackupFormat = (value) => value === WATCH_HISTORY_BACKUP_FORMAT || value === LEGACY_WATCH_HISTORY_BACKUP_FORMAT;

// Matches the envelope's format field in the raw head of a file.
export const ENCRYPTED_BACKUP_FORMAT_FIELD_PATTERN = /"format"\s*:\s*"(?:plekt|plembfin)-encrypted-backup"/;

// Marker fields inside a backup document.
export const TYPE_FIELD = "__plektType";
export const LEGACY_TYPE_FIELD = "__plembfinType";
export const REDACTED_SECRETS_FIELD = "__plektRedactedSecrets";
export const LEGACY_REDACTED_SECRETS_FIELD = "__plembfinRedactedSecrets";

export function backupValueType(value) {
  return value?.[TYPE_FIELD] ?? value?.[LEGACY_TYPE_FIELD];
}

export const FULL_BACKUP_FILE_PATTERN = /^(?:plekt|plembfin)-backup-(\d{8}T\d{6}Z)\.encrypted\.json$/;
export const FULL_BACKUP_TEMPORARY_FILE_PATTERN = /^(?:plekt|plembfin)-backup-\d{8}T\d{6}Z\.encrypted\.json\.tmp-/;
export const WATCH_HISTORY_FILE_PATTERN = /^(?:plekt|plembfin)-watch-history-(\d{8}T\d{6}Z)\.json\.gz$/;
// Either kind, as stored side by side on a remote destination.
export const REMOTE_BACKUP_FILE_PATTERN = /^(?:plekt|plembfin)-(?:watch-history-\d{8}T\d{6}Z\.json\.gz|backup-\d{8}T\d{6}Z\.encrypted\.json)$/;

export const fullBackupFilename = (stamp) => `plekt-backup-${stamp}.encrypted.json`;
export const watchHistoryBackupFilename = (stamp) => `plekt-watch-history-${stamp}.json.gz`;

// The sortable UTC stamp embedded in a backup file name. Old and new prefixes
// sort differently as plain strings, so ordering by age must use this.
export function backupFileStamp(name) {
  return /(\d{8}T\d{6}Z)/.exec(String(name || ""))?.[1] || "";
}
