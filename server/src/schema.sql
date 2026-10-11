-- Plembfin local SQLite schema.
-- Record ids are TEXT primary keys; provider ids ({imdb,tmdb,tvdb}) are flattened
-- to columns; timestamps are INTEGER ms (or ISO TEXT for watched_at, which is
-- compared lexicographically throughout).
-- Derived caches (history/movie/show summaries) have no tables on purpose:
-- a single long-lived process memoizes them in memory (see db.js dataVersion).

CREATE TABLE IF NOT EXISTS watch_history (
  id TEXT PRIMARY KEY,
  title TEXT,
  title_lower TEXT,
  media_type TEXT,
  watched_at TEXT,
  source TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  logo_url TEXT,
  backdrop_url TEXT,
  youtube_url TEXT,
  sync_action TEXT,
  sync_dispatch_telemetry TEXT,
  sync_match_ignored_at INTEGER,
  watch_provenance TEXT,
  sync_retry_count INTEGER DEFAULT 0,
  sync_next_retry_at INTEGER DEFAULT 0,
  media_key TEXT,
  show_title TEXT,
  show_title_lower TEXT,
  episode_title TEXT,
  episode_title_status TEXT NOT NULL DEFAULT 'missing',
  episode_title_checked_at INTEGER,
  episode_title_resolution_error TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  history_day TEXT GENERATED ALWAYS AS (
    SUBSTR(COALESCE(watched_at, ''), 1, 10)
  ) VIRTUAL,
  history_daily_key TEXT GENERATED ALWAYS AS (
    CASE
      WHEN media_type = 'episode' THEN
        'episode|show:' || COALESCE(
          NULLIF(
            CASE
              WHEN COALESCE(show_title_lower, show_title, '') GLOB '* ([0-9][0-9][0-9][0-9])'
                THEN LOWER(TRIM(SUBSTR(COALESCE(show_title_lower, show_title, ''), 1, LENGTH(COALESCE(show_title_lower, show_title, '')) - 7)))
              ELSE LOWER(TRIM(COALESCE(show_title_lower, show_title, '')))
            END,
            ''
          ),
          NULLIF(
            CASE
              WHEN COALESCE(title_lower, title, '') GLOB '* ([0-9][0-9][0-9][0-9])'
                THEN LOWER(TRIM(SUBSTR(COALESCE(title_lower, title, ''), 1, LENGTH(COALESCE(title_lower, title, '')) - 7)))
              ELSE LOWER(TRIM(COALESCE(title_lower, title, '')))
            END,
            ''
          ),
          'unknown'
        )
        || '|s:' || COALESCE(CAST(season AS TEXT), 'unknown')
        || '|e:' || COALESCE(CAST(episode AS TEXT), 'unknown')
      WHEN media_type = 'movie' THEN
        'movie|' || COALESCE(
          NULLIF('imdb:' || COALESCE(imdb_id, ''), 'imdb:'),
          NULLIF('tmdb:' || COALESCE(tmdb_id, ''), 'tmdb:'),
          NULLIF('tvdb:' || COALESCE(tvdb_id, ''), 'tvdb:'),
          NULLIF(
            'title:' || CASE
              WHEN COALESCE(title_lower, title, '') GLOB '* ([0-9][0-9][0-9][0-9])'
                THEN LOWER(TRIM(SUBSTR(COALESCE(title_lower, title, ''), 1, LENGTH(COALESCE(title_lower, title, '')) - 7)))
              ELSE LOWER(TRIM(COALESCE(title_lower, title, '')))
            END,
            'title:'
          ),
          'unknown'
        )
      ELSE
        COALESCE(media_type, 'unknown') || '|' || COALESCE(
          NULLIF(
            CASE
              WHEN COALESCE(title_lower, title, '') GLOB '* ([0-9][0-9][0-9][0-9])'
                THEN LOWER(TRIM(SUBSTR(COALESCE(title_lower, title, ''), 1, LENGTH(COALESCE(title_lower, title, '')) - 7)))
              ELSE LOWER(TRIM(COALESCE(title_lower, title, '')))
            END,
            ''
          ),
          'unknown'
        )
    END
  ) VIRTUAL
);
CREATE INDEX IF NOT EXISTS idx_watch_history_watched_at ON watch_history(watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_type_watched ON watch_history(media_type, watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_media_key ON watch_history(media_key);
CREATE INDEX IF NOT EXISTS idx_watch_history_show_lower ON watch_history(show_title_lower);

CREATE TABLE IF NOT EXISTS show_merge_history (
  id TEXT PRIMARY KEY,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_show_merge_history_target ON show_merge_history(target_title, merged_at DESC);

CREATE TABLE IF NOT EXISTS playstate (
  media_key TEXT PRIMARY KEY,
  title TEXT,
  title_lower TEXT,
  media_type TEXT,
  state TEXT,
  watched_at TEXT,
  last_source TEXT,
  sources TEXT,            -- JSON array
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playstate_state ON playstate(state);

-- Provider watched flags that need an administrator decision before they are
-- copied into canonical history. The normalized media payload is retained so
-- approving a review does not need the source server to repeat the original
-- library scan.
CREATE TABLE IF NOT EXISTS manual_watch_reviews (
  id TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_item_id TEXT,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  show_title TEXT,
  episode_title TEXT,
  season INTEGER,
  episode INTEGER,
  release_date TEXT,
  observed_watched_at TEXT,
  source_fingerprint TEXT NOT NULL,
  media_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  decision_mode TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_watch_reviews_media_key ON manual_watch_reviews(media_key);
CREATE INDEX IF NOT EXISTS idx_manual_watch_reviews_pending ON manual_watch_reviews(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS playback_progress (
  media_key TEXT PRIMARY KEY,
  title TEXT,
  media_type TEXT,
  source TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  position_ms INTEGER,
  duration_ms INTEGER,
  progress REAL,
  updated_at INTEGER,
  sync_dispatch_telemetry TEXT
);
CREATE INDEX IF NOT EXISTS idx_playback_progress_updated ON playback_progress(updated_at DESC);

-- A compact durable journal for SSE consumers. Cache versions tell a browser
-- that something changed, while these rows identify the media item that can be
-- patched in place. The journal is intentionally append-only here; db.js
-- keeps it bounded as streams observe new changes.
CREATE TABLE IF NOT EXISTS live_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('upsert', 'delete')),
  media_key TEXT,
  record_id TEXT,
  media_type TEXT,
  title TEXT,
  show_title TEXT,
  season INTEGER,
  episode INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_change_events_cursor ON live_change_events(id);
CREATE INDEX IF NOT EXISTS idx_live_change_events_created ON live_change_events(created_at, id);

-- Provider feed observations used to explain and rebuild the unified Up Next
-- projection. These rows are deliberately not canonical watch state: the
-- playstate/playback_progress tables remain authoritative.
CREATE TABLE IF NOT EXISTS up_next_provider_items (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  feed_kind TEXT NOT NULL CHECK (feed_kind IN ('resume', 'next_up')),
  provider_item_id TEXT NOT NULL,
  media_key TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  title TEXT,
  show_title TEXT,
  episode_title TEXT,
  season INTEGER,
  episode INTEGER,
  year INTEGER,
  air_date TEXT,
  poster_url TEXT,
  show_poster_url TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  show_imdb_id TEXT,
  show_tmdb_id TEXT,
  show_tvdb_id TEXT,
  provider_ids_json TEXT NOT NULL DEFAULT '{}',
  parent_provider_item_id TEXT,
  series_provider_item_id TEXT,
  position_ms INTEGER,
  duration_ms INTEGER,
  progress REAL,
  source_updated_at INTEGER,
  observed_at INTEGER NOT NULL,
  feed_generation INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'resolved',
  last_error TEXT,
  PRIMARY KEY (provider, feed_kind, provider_item_id)
);
CREATE INDEX IF NOT EXISTS idx_up_next_provider_items_feed
  ON up_next_provider_items(provider, feed_kind, feed_generation);
CREATE INDEX IF NOT EXISTS idx_up_next_provider_items_media_key
  ON up_next_provider_items(media_key);
CREATE INDEX IF NOT EXISTS idx_up_next_provider_items_coordinate
  ON up_next_provider_items(media_type, season, episode);

-- A provider/feed generation is only made active after a complete successful
-- response. Failed or partial generations therefore cannot erase the last
-- usable observations.
CREATE TABLE IF NOT EXISTS up_next_provider_feed_state (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  feed_kind TEXT NOT NULL CHECK (feed_kind IN ('resume', 'next_up')),
  current_generation INTEGER NOT NULL DEFAULT 0,
  active_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
  started_at INTEGER,
  completed_at INTEGER,
  last_success_at INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  last_run_complete INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  last_error TEXT,
  retry_after INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, feed_kind)
);

CREATE TABLE IF NOT EXISTS up_next_manual_shows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  tmdb_id TEXT,
  tvdb_id TEXT,
  imdb_id TEXT,
  poster_url TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_up_next_manual_shows_added_at
  ON up_next_manual_shows(added_at ASC, id ASC);

-- Last library-confirmed native id per Up Next lookup, read only while that
-- provider cannot answer (upNextLibraryLookup.js).
CREATE TABLE IF NOT EXISTS up_next_library_items (
  lookup_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
);

-- Cross-process mutex for writes that change a media server's played state.
-- A watched write and the corresponding progress-clear + unplayed pair must
-- never pass each other on the wire: whichever operation acquires this lease
-- first finishes first, and the newer operation writes the final state.
CREATE TABLE IF NOT EXISTS outbound_state_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  acquired_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_state_leases_expiry ON outbound_state_leases(expires_at);

CREATE TABLE IF NOT EXISTS active_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  media_type TEXT,
  source TEXT,
  progress REAL,
  offset_ms INTEGER,
  duration_ms INTEGER,
  season INTEGER,
  episode INTEGER,
  poster_url TEXT,
  ids TEXT,               -- JSON
  event TEXT,
  client TEXT,            -- JSON
  updated_at INTEGER,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_active_sessions_updated ON active_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS live_tracking_cache (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  source_platform TEXT,
  last_progress REAL,
  updated_at INTEGER,
  completed_at INTEGER,
  payload TEXT,           -- JSON
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_live_tracking_updated ON live_tracking_cache(updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  media_type TEXT,
  title TEXT,
  source TEXT,
  status TEXT,
  details TEXT,
  action TEXT,
  target_states TEXT,     -- JSON
  raw_payload_debug TEXT, -- JSON
  activity_group_key TEXT,
  activity_item_key TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_history_timestamp ON sync_history(timestamp DESC);

-- Durable, per-media history of every ingest, local state change, and outbound
-- dispatch. Both this provenance record and sync_history are retained with
-- backups; the Activity UI paginates sync_history instead of truncating it.
CREATE TABLE IF NOT EXISTS watch_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT,
  watch_record_id TEXT,
  media_key TEXT,
  media_type TEXT,
  title TEXT,
  title_lower TEXT,
  show_title TEXT,
  show_title_lower TEXT,
  source TEXT,
  source_event TEXT,
  phase TEXT,
  source_timestamp TEXT,
  captured_at TEXT,
  target TEXT,
  status TEXT,
  details TEXT,
  device TEXT,
  device_id TEXT,
  client TEXT,
  client_version TEXT,
  user_name TEXT,
  session_id TEXT,
  item_id TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_audit_media_key ON watch_audit_events(media_key, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_record_id ON watch_audit_events(watch_record_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_tmdb_id ON watch_audit_events(tmdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_tvdb_id ON watch_audit_events(tvdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_imdb_id ON watch_audit_events(imdb_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_title ON watch_audit_events(title_lower, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_show_title ON watch_audit_events(show_title_lower, timestamp);
CREATE INDEX IF NOT EXISTS idx_watch_audit_payload_created ON watch_audit_events(created_at) WHERE payload IS NOT NULL;

-- Single-row key/value documents stored as JSON blobs.
CREATE TABLE IF NOT EXISTS runtime_state (
  id TEXT PRIMARY KEY,
  data TEXT,              -- JSON
  updated_at INTEGER
);

-- Completed authoritative restore reports live outside the hot runtime row.
-- The runtime row keeps only the active cursor and a small terminal summary;
-- the full result/log is fetched explicitly when an administrator asks for it.
CREATE TABLE IF NOT EXISTS restore_reports (
  run_id TEXT PRIMARY KEY,
  result_json TEXT,
  log_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restore_reports_updated ON restore_reports(updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT,              -- JSON
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS loop_keys (
  id TEXT PRIMARY KEY,
  key TEXT,
  value TEXT,
  created_at INTEGER,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_loop_keys_expire_at ON loop_keys(expire_at);

CREATE TABLE IF NOT EXISTS poster_cache (
  id TEXT PRIMARY KEY,
  media_key TEXT,
  variant TEXT,
  status TEXT,
  source TEXT,
  detail TEXT,
  original_url TEXT,
  storage_path TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  url TEXT,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  media_type TEXT,
  title TEXT,
  details TEXT,           -- JSON
  poster_path TEXT,
  status TEXT,
  cached_poster_url TEXT,
  backdrop_path TEXT,
  cached_backdrop_url TEXT,
  tvdb_poster_url TEXT,
  schema_version INTEGER,
  updated_at_ms INTEGER
);

-- Show-level poster overrides. Keep these separate from watch_history.poster_url:
-- an episode row may legitimately use an episode still, while the selected
-- show poster must be shared by every non-episode surface.
CREATE TABLE IF NOT EXISTS media_artwork (
  identity_key TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT,
  imdb_id TEXT,
  poster_url TEXT,
  poster_source TEXT NOT NULL DEFAULT 'manual',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_artwork_provider_ids
  ON media_artwork(media_type, tmdb_id, tvdb_id, imdb_id);

CREATE TABLE IF NOT EXISTS tmdb_search_cache (
  id TEXT PRIMARY KEY,
  query TEXT,
  media_type TEXT,
  page INTEGER,
  response TEXT,          -- JSON
  missing INTEGER,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_season_cache (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  season_number INTEGER,
  show_status TEXT,
  details TEXT,           -- JSON
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tmdb_person_cache (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  details TEXT,           -- JSON
  schema_version INTEGER,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tvdb_metadata_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  title TEXT,
  details TEXT,           -- JSON (raw TVDB series/extended response)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tvdb_season_cache (
  id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  season_number INTEGER,
  details TEXT,           -- JSON (raw TVDB season/extended episodes)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS omdb_cache (
  id TEXT PRIMARY KEY,     -- IMDb ID (tt...)
  data TEXT,               -- JSON
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS fanart_cache (
  id TEXT PRIMARY KEY,     -- fanart.tv request path (movies/{tmdbId} or tv/{tvdbId})
  data TEXT,               -- JSON (raw fanart.tv response); NULL when missing = 1
  missing INTEGER DEFAULT 0, -- 1 when fanart.tv has no artwork for this item (404)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS youtube_meta_cache (
  id TEXT PRIMARY KEY,     -- YouTube video ID
  data TEXT,               -- JSON (trailer metadata response)
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts);

-- Captured console output for the Settings -> Logs panel. Bounded to
-- DIAGNOSTIC_LOG_MAX_ROWS by diagnosticLogger.js, which prunes the oldest rows
-- on flush, so this table is a ring buffer rather than an unbounded archive.
-- Every process writes here, which is how the panel merges web and worker logs.
CREATE TABLE IF NOT EXISTS diagnostic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT,
  category TEXT,
  role TEXT,
  instance TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS diagnostic_log_ts ON diagnostic_log (ts);
CREATE INDEX IF NOT EXISTS diagnostic_log_category_ts ON diagnostic_log (category, ts);
CREATE INDEX IF NOT EXISTS diagnostic_log_level_ts ON diagnostic_log (level, ts);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER
);

CREATE TABLE IF NOT EXISTS cache_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_exclusions (
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  excluded_at INTEGER NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);
CREATE INDEX IF NOT EXISTS idx_recommendation_exclusions_excluded_at
  ON recommendation_exclusions(excluded_at DESC);
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('history', 1, 0);
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('discover', 1, 0);
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('up_next', 1, 0);
-- Resume positions change constantly during playback but no history-derived
-- cache reads playback_progress, so they get their own generation. The browser
-- still sees a change through the aggregate in getHistoryCacheVersion().
INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('progress', 1, 0);

-- Keep cache invalidation in the same transaction as canonical state writes.
-- Explicit bumpDataVersion() calls remain useful for file-backed derived data;
-- duplicate bumps are harmless and force the conservative full-rebuild path.
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_insert AFTER INSERT ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_update AFTER UPDATE ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_watch_history_cache_delete AFTER DELETE ON watch_history BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_insert AFTER INSERT ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_update AFTER UPDATE ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playstate_cache_delete AFTER DELETE ON playstate BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_insert AFTER INSERT ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='progress';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_update AFTER UPDATE ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='progress';
END;
CREATE TRIGGER IF NOT EXISTS trg_playback_progress_cache_delete AFTER DELETE ON playback_progress BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='progress';
END;
CREATE TRIGGER IF NOT EXISTS trg_manual_watch_reviews_cache_insert AFTER INSERT ON manual_watch_reviews BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_manual_watch_reviews_cache_update AFTER UPDATE ON manual_watch_reviews BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_manual_watch_reviews_cache_delete AFTER DELETE ON manual_watch_reviews BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;

CREATE TABLE IF NOT EXISTS scheduler_lease (
  id TEXT PRIMARY KEY,
  holder_id TEXT,
  holder_role TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  expires_at INTEGER,
  last_tick_at INTEGER
);
INSERT OR IGNORE INTO scheduler_lease (id, generation) VALUES ('scheduler', 0);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  claimed_by TEXT,
  claim_generation INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON background_jobs(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_background_jobs_type ON background_jobs(type, requested_at DESC);

CREATE TABLE IF NOT EXISTS background_job_logs (
  job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY(job_id, seq)
);

-- Force Sync plans: the read-only preview produced before an execution run.
-- actions_json can be large for big libraries; the API pages it server-side
-- and the summary is stored separately so list views never load actions.
CREATE TABLE IF NOT EXISTS sync_plans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT,
  summary_json TEXT,
  actions_json TEXT,
  skipped_json TEXT,
  fingerprint_json TEXT,
  config_revision TEXT,
  snapshot_file TEXT,
  result_json TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_plans_created ON sync_plans(created_at DESC);

-- External watch trackers (Trakt first; provider-neutral for future adapters).
CREATE TABLE IF NOT EXISTS tracker_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('connected', 'reauth_required', 'disabled')),
  remote_user_id TEXT,
  remote_username TEXT,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  client_secret_tag TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_tag TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  access_token_expires_at INTEGER,
  initial_sync_mode TEXT NOT NULL DEFAULT 'baseline' CHECK (initial_sync_mode IN ('baseline', 'import')),
  baseline_complete INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER,
  last_validated_at INTEGER,
  last_error TEXT,
  history_synced_at INTEGER,
  prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracker_auth_flows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  client_secret_iv TEXT NOT NULL,
  client_secret_tag TEXT NOT NULL,
  device_code_ciphertext TEXT NOT NULL,
  device_code_iv TEXT NOT NULL,
  device_code_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  user_code TEXT NOT NULL,
  verification_url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  initial_sync_mode TEXT NOT NULL DEFAULT 'baseline',
  prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'denied')),
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracker_auth_flows_expiry ON tracker_auth_flows(expires_at);

CREATE TABLE IF NOT EXISTS tracker_item_state (
  provider TEXT NOT NULL,
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  remote_watched_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('watched', 'unwatched')),
  last_outbound_at INTEGER,
  PRIMARY KEY(provider, media_key)
);

-- Per-play dedup ledger for imported tracker history (Trakt can report the
-- same item watched multiple times - each play has its own history id).
-- Lets the poller import every individual rewatch exactly once without
-- re-fetching or re-diffing the whole watch_history table on every tick.
CREATE TABLE IF NOT EXISTS tracker_play_history (
  provider TEXT NOT NULL,
  history_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  watched_at TEXT NOT NULL,
  watch_record_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(provider, history_id)
);
CREATE INDEX IF NOT EXISTS idx_tracker_play_history_media ON tracker_play_history(provider, media_key);

-- Local personal media organization. Watchlist choices and custom lists remain
-- Plembfin-local. Ratings are still canonical here, but the separate optional
-- rating-sync queue may mirror them to explicitly enabled providers.
CREATE TABLE IF NOT EXISTS personal_ratings (
  media_key TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'episode')),
  title TEXT NOT NULL,
  tmdb_id TEXT,
  tvdb_id TEXT,
  imdb_id TEXT,
  poster_url TEXT,
  overview TEXT,
  release_date TEXT,
  show_title TEXT,
  season INTEGER,
  episode INTEGER,
  episode_tmdb_id TEXT,
  episode_tvdb_id TEXT,
  episode_imdb_id TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'import', 'reconcile')),
  canonical_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);

-- Provider-specific rating observations. This ledger is deliberately separate
-- from watched-state tables: a remote rating of NULL is an explicit unrated
-- observation, not a missing watched event.
CREATE TABLE IF NOT EXISTS personal_rating_sources (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  provider_item_id TEXT,
  provider_ids_json TEXT,
  remote_rating INTEGER CHECK (remote_rating BETWEEN 1 AND 10 OR remote_rating IS NULL),
  remote_state TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_state IN ('rated', 'unrated', 'unknown')),
  remote_rated_at INTEGER,
  last_seen_at INTEGER,
  last_snapshot_generation INTEGER,
  last_complete_snapshot_at INTEGER,
  last_inbound_at INTEGER,
  last_outbound_rating INTEGER,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('rated', 'unrated')),
  last_outbound_intent_id TEXT,
  last_outbound_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sync_status IN ('unknown', 'synced', 'pending', 'conflict', 'not_found', 'reauth_required', 'failed')),
  last_error TEXT,
  PRIMARY KEY (provider, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_rating_sources_snapshot
  ON personal_rating_sources(provider, last_snapshot_generation, remote_state);

-- Durable, deduplicated outbound rating mutations. desired_state remains
-- explicit for clears, so an unrated tombstone can never be confused with a
-- missing queue value.
CREATE TABLE IF NOT EXISTS personal_rating_sync_queue (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('rated', 'unrated')),
  desired_rating INTEGER CHECK (desired_rating BETWEEN 1 AND 10 OR desired_rating IS NULL),
  source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'reconcile', 'push')),
  intent_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'not_found', 'reauth_required', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  PRIMARY KEY (provider, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_rating_sync_queue_due
  ON personal_rating_sync_queue(status, next_attempt_at, updated_at);

-- One current run/cursor per provider is enough for restart-safe status. The
-- generation is the complete-snapshot gate: missing remote rows only mean
-- "unrated" after a full provider scan has completed successfully.
CREATE TABLE IF NOT EXISTS personal_rating_sync_runs (
  provider TEXT PRIMARY KEY CHECK (provider IN ('plex', 'emby', 'jellyfin', 'trakt')),
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'baseline' CHECK (mode IN ('baseline', 'import')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
  baseline_complete INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  cleared_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_watchlist (
  media_key TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  tmdb_id TEXT,
  tvdb_id TEXT,
  imdb_id TEXT,
  poster_url TEXT,
  overview TEXT,
  release_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_updated ON personal_watchlist(updated_at DESC);

-- A watchlist mutation is an append-only local intent.  The present rows above
-- remain the fast canonical read model; these records preserve removals and
-- revisions so an old provider callback can never delete a newer re-add.
CREATE TABLE IF NOT EXISTS personal_watchlist_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO personal_watchlist_meta (id, revision, updated_at) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS personal_watchlist_mutations (
  id TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  origin TEXT NOT NULL CHECK (origin IN ('local', 'plex', 'emby', 'jellyfin', 'watched', 'restore', 'reconcile', 'system')),
  reason TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL,
  event_fingerprint TEXT UNIQUE,
  source_timestamp INTEGER,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER,
  applied_at INTEGER,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_mutations_media
  ON personal_watchlist_mutations(media_key, canonical_revision DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_mutations_active
  ON personal_watchlist_mutations(canonical_revision DESC, desired_state);

-- One row per provider representation and remote item.  Duplicate remote
-- matches are intentionally retained instead of silently choosing one.
CREATE TABLE IF NOT EXISTS personal_watchlist_provider_items (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  provider_item_id TEXT NOT NULL DEFAULT '',
  provider_ids_json TEXT,
  remote_state TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_state IN ('present', 'absent', 'unavailable', 'unknown', 'unmanaged')),
  managed_by_plembfin INTEGER NOT NULL DEFAULT 0 CHECK (managed_by_plembfin IN (0, 1)),
  primary_target INTEGER NOT NULL DEFAULT 0 CHECK (primary_target IN (0, 1)),
  container_id TEXT,
  container_name TEXT,
  last_confirmed_present_at INTEGER,
  last_seen_at INTEGER,
  last_complete_generation INTEGER,
  last_outbound_state TEXT CHECK (last_outbound_state IN ('present', 'absent')),
  last_outbound_intent_id TEXT,
  last_outbound_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sync_status IN ('unknown', 'synced', 'pending', 'not_available', 'reauth_required', 'failed', 'needs_review')),
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation, media_key, provider_item_id)
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_provider_items_scope
  ON personal_watchlist_provider_items(provider, connection_id, remote_scope_key, representation, remote_state);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_provider_items_media
  ON personal_watchlist_provider_items(media_key, provider);

-- Durable per-provider desired state.  The unique scope/media key collapses
-- rapid add/remove churn while intent_id and canonical_revision preserve the
-- stale-event guard at the worker boundary.
CREATE TABLE IF NOT EXISTS personal_watchlist_sync_queue (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  media_key TEXT NOT NULL,
  media_json TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove', 'create_container', 'repair')),
  source_mutation_id TEXT,
  intent_id TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL DEFAULT 0,
  provider_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'not_available', 'reauth_required', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation, media_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_sync_queue_due
  ON personal_watchlist_sync_queue(status, next_attempt_at, updated_at);

CREATE TABLE IF NOT EXISTS personal_watchlist_sync_runs (
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  connection_id TEXT NOT NULL DEFAULT '',
  remote_scope_key TEXT NOT NULL DEFAULT '',
  representation TEXT NOT NULL CHECK (representation IN ('native', 'playlist', 'favorites', 'rss')),
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'reconcile' CHECK (mode IN ('initial_publish', 'reconcile', 'repair')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
  canonical_revision INTEGER NOT NULL DEFAULT 0,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  present_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  cursor_json TEXT,
  complete_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (complete_snapshot IN (0, 1)),
  snapshot_hash TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, remote_scope_key, representation)
);

CREATE TABLE IF NOT EXISTS personal_watchlist_activity (
  id TEXT PRIMARY KEY,
  provider TEXT,
  connection_id TEXT,
  remote_scope_key TEXT,
  representation TEXT,
  media_key TEXT,
  media_json TEXT,
  action TEXT NOT NULL,
  origin TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_watchlist_activity_created
  ON personal_watchlist_activity(created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_insert AFTER INSERT ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_update AFTER UPDATE ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;
CREATE TRIGGER IF NOT EXISTS trg_personal_watchlist_cache_delete AFTER DELETE ON personal_watchlist BEGIN
  UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='history';
END;

-- Playlists (UI name; internal tables keep the personal_list names). Indexes on
-- columns added by migration 43 (position, deleted_at) are created by that
-- migration, because this file runs before migrations on older databases.
CREATE TABLE IF NOT EXISTS personal_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  order_updated_at INTEGER,
  deleted_at INTEGER,
  deleted_origin TEXT,
  -- Automatic playlists: the rule as JSON (NULL for a manual playlist), when
  -- it was last evaluated, and why the last evaluation failed.
  rule_json TEXT,
  rule_checked_at INTEGER,
  rule_error TEXT,
  -- A rule check held for Confirm or Discard: the held update as JSON, and
  -- when the user confirmed it.
  rule_hold_json TEXT,
  rule_hold_confirmed_at INTEGER,
  -- "Remove items once watched": 1 removes a movie or episode once it is
  -- watched after it was added.
  remove_watched INTEGER NOT NULL DEFAULT 0,
  -- 'movie', 'tv', or 'mixed' (both); NULL until an empty pre-5d playlist gets
  -- its first item. Kept last: migration 45 looks for 'mixed' in the table text.
  kind TEXT CHECK (kind IN ('movie', 'tv', 'mixed'))
);

CREATE TABLE IF NOT EXISTS personal_list_items (
  list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'episode')),
  title TEXT NOT NULL,
  tmdb_id TEXT,
  tvdb_id TEXT,
  imdb_id TEXT,
  poster_url TEXT,
  overview TEXT,
  release_date TEXT,
  show_title TEXT,
  season INTEGER,
  episode INTEGER,
  episode_tmdb_id TEXT,
  episode_tvdb_id TEXT,
  episode_imdb_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, media_key),
  CHECK (media_type <> 'episode' OR (season IS NOT NULL AND episode IS NOT NULL))
);

-- Titles an automatic playlist with "Remove items once watched" handed off
-- after a watch (a show goes to Up Next); the rule never adds them back. One
-- row per id key, such as movie:tmdb:123 or show:tvdb:456.
CREATE TABLE IF NOT EXISTS personal_list_handoffs (
  list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  handed_off_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, identity)
);

-- Episodes of a series item removed in an app, so series expansion skips them.
CREATE TABLE IF NOT EXISTS personal_list_item_exclusions (
  list_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  origin TEXT NOT NULL,
  excluded_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, media_key, season, episode),
  FOREIGN KEY (list_id, media_key) REFERENCES personal_list_items(list_id, media_key) ON DELETE CASCADE
);

-- One row per app a playlist targets. No rows means Plembfin-only. A
-- deselected app stays as desired_state 'absent' until its playlist is deleted.
CREATE TABLE IF NOT EXISTS personal_list_targets (
  list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  desired_state TEXT NOT NULL DEFAULT 'present' CHECK (desired_state IN ('present', 'absent')),
  remote_playlist_id TEXT,
  remote_name TEXT,
  last_synced_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  not_found_passes INTEGER NOT NULL DEFAULT 0,
  missing_since INTEGER,
  unidentified_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, provider)
);

-- What Plembfin last wrote or saw per remote playlist entry. App-side changes
-- are diffed against this ledger, never against the other side's live state.
CREATE TABLE IF NOT EXISTS personal_list_entry_ledger (
  list_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  remote_entry_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  media_key TEXT,
  season INTEGER,
  episode INTEGER,
  remote_position INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('plembfin', 'provider')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  absent_reads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, provider, remote_entry_id),
  FOREIGN KEY (list_id, provider) REFERENCES personal_list_targets(list_id, provider) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_personal_list_entry_ledger_item
  ON personal_list_entry_ledger(list_id, provider, provider_item_id);

-- Whether each playlist item resolved in each targeted app's library on the
-- last push. A series counts as available when any episode resolved. A lookup
-- that failed leaves the previous answer in place.
CREATE TABLE IF NOT EXISTS personal_list_item_availability (
  list_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
  status TEXT NOT NULL CHECK (status IN ('available', 'missing')),
  episode_count INTEGER,
  reason TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, media_key, provider),
  FOREIGN KEY (list_id, media_key) REFERENCES personal_list_items(list_id, media_key) ON DELETE CASCADE
);

-- App-side changes the pull pass held back for confirmation instead of
-- applying: many removals from one playlist in one pass, or a playlist
-- deletion seen on more than one playlist of the same app at once.
-- entry_ids is a JSON array of remote entry ids (removals only). A row with
-- confirmed_at set is applied by the next pull.
CREATE TABLE IF NOT EXISTS personal_list_held_changes (
  list_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('removals', 'delete')),
  entry_ids TEXT,
  change_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  held_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  PRIMARY KEY (list_id, provider, kind),
  FOREIGN KEY (list_id, provider) REFERENCES personal_list_targets(list_id, provider) ON DELETE CASCADE
);
