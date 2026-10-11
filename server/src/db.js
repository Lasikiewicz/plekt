import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH, ensureDataDirs } from "./paths.js";
import { repairPhantomWatchBursts } from "./utils/phantomWatchRepair.js";
import { activityGroupKeyFor, activityItemKeyFor } from "./utils/syncActivityIdentity.js";
import { persistedWatchDerivedFields } from "./utils/watchDerivedFields.js";

ensureDataDirs();

export const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* non-POSIX FS (Windows, some Docker volumes) */ }

// A journal_mode switch needs a momentary exclusive lock and can throw
// SQLITE_BUSY immediately rather than honoring busy_timeout, if another
// process opens the same brand-new database at the same instant (e.g. two
// Plembfin processes starting together for the first time). Retry those
// startup pragmas ourselves so a transient race doesn't crash boot.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function pragmaWithRetry(statement, { attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return db.pragma(statement);
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY" || attempt >= attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

pragmaWithRetry("busy_timeout = 5000");
pragmaWithRetry("journal_mode = WAL");
pragmaWithRetry("foreign_keys = ON");

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
db.exec(schema);

const migrations = [
  {
    id: 1,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("logo_url")) database.exec("ALTER TABLE watch_history ADD COLUMN logo_url TEXT");
    },
  },
  {
    id: 2,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("backdrop_url")) database.exec("ALTER TABLE watch_history ADD COLUMN backdrop_url TEXT");
    },
  },
  {
    id: 3,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map(c => c.name);
      if (!watchCols.includes("sync_retry_count")) database.exec("ALTER TABLE watch_history ADD COLUMN sync_retry_count INTEGER DEFAULT 0");
      if (!watchCols.includes("sync_next_retry_at")) database.exec("ALTER TABLE watch_history ADD COLUMN sync_next_retry_at INTEGER DEFAULT 0");
    },
  },
  {
    id: 4,
    up(database) {
      const watchCols = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      // Very old/imported databases can be upgraded in stages and may not yet
      // have the columns needed for burst detection. The normal compatibility
      // path will finish those upgrades; do not make startup fail here.
      if (!["title", "media_type", "watched_at", "source", "sync_action"].every((column) => watchCols.has(column))) return;
      // The migration runner already owns an IMMEDIATE transaction.
      const result = repairPhantomWatchBursts(database, { transaction: false });
      if (result.deleted) {
        console.warn(`[history] removed ${result.deleted} implausible phantom watch row${result.deleted === 1 ? "" : "s"} from ${result.bursts.length} burst${result.bursts.length === 1 ? "" : "s"}`);
      }
    },
  },
  {
    id: 5,
    up(database) {
      const watchCols = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      if (!["title", "media_type", "watched_at", "source", "sync_action"].every((column) => watchCols.has(column))) return;
      // Re-run the guarded repair after the exact-event duplicate rules were
      // expanded. Migration 4 may already have run on an existing database.
      const result = repairPhantomWatchBursts(database, { transaction: false });
      if (result.deleted) {
        console.warn(`[history] removed ${result.deleted} duplicate or implausible phantom watch row${result.deleted === 1 ? "" : "s"} from ${result.bursts.length} burst${result.bursts.length === 1 ? "" : "s"}`);
      }
    },
  },
  {
    id: 6,
    up(database) {
      const watchCols = database.pragma("table_info(watch_history)").map((column) => column.name);
      if (!watchCols.includes("watch_provenance")) database.exec("ALTER TABLE watch_history ADD COLUMN watch_provenance TEXT");
    },
  },
  {
    id: 7,
    up(database) {
      database.exec(`
        CREATE TABLE media_auth_devices (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
          device_identifier TEXT NOT NULL,
          device_name TEXT NOT NULL,
          public_jwk TEXT,
          private_key_ciphertext TEXT,
          private_key_iv TEXT,
          private_key_tag TEXT,
          key_version INTEGER NOT NULL DEFAULT 1,
          retired_at INTEGER,
          replacement_device_id TEXT REFERENCES media_auth_devices(id),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            provider = 'plex'
            OR (public_jwk IS NULL AND private_key_ciphertext IS NULL AND private_key_iv IS NULL AND private_key_tag IS NULL)
          )
        );
        CREATE UNIQUE INDEX media_auth_devices_one_active_provider
          ON media_auth_devices(provider) WHERE retired_at IS NULL;
        CREATE UNIQUE INDEX media_auth_devices_identifier
          ON media_auth_devices(provider, device_identifier);

        CREATE TABLE media_connections (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
          base_url TEXT NOT NULL,
          server_id TEXT NOT NULL,
          server_name TEXT,
          auth_device_id TEXT NOT NULL REFERENCES media_auth_devices(id),
          remote_user_id TEXT NOT NULL,
          remote_username TEXT,
          auth_kind TEXT NOT NULL CHECK (auth_kind IN ('plex_jwt', 'plex_managed_jwt', 'plex_legacy', 'emby_user', 'jellyfin_quick_connect', 'jellyfin_user', 'legacy')),
          credential_ciphertext TEXT NOT NULL,
          credential_iv TEXT NOT NULL,
          credential_tag TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1,
          access_token_expires_at INTEGER,
          last_refreshed_at INTEGER,
          refresh_failure_count INTEGER NOT NULL DEFAULT 0,
          refresh_lease_owner TEXT,
          refresh_lease_expires_at INTEGER,
          status TEXT NOT NULL CHECK (status IN ('connected', 'reauth_required', 'disabled', 'legacy')),
          last_validated_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX media_connections_one_enabled_provider
          ON media_connections(provider) WHERE status IN ('connected', 'reauth_required', 'legacy');
        CREATE INDEX media_connections_device ON media_connections(auth_device_id);

        CREATE TABLE media_auth_flows (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'jellyfin')),
          auth_device_id TEXT NOT NULL REFERENCES media_auth_devices(id),
          base_url TEXT,
          remote_flow_id TEXT,
          secret_ciphertext TEXT,
          secret_iv TEXT,
          secret_tag TEXT,
          key_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK (status IN ('pending', 'authorised', 'completed', 'expired', 'rejected')),
          admin_session_fingerprint TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX media_auth_flows_expiry ON media_auth_flows(expires_at);
      `);
    },
  },
  {
    id: 8,
    up(database) {
      const flowColumns = database.pragma("table_info(media_auth_flows)").map((column) => column.name);
      if (!flowColumns.includes("key_version")) database.exec("ALTER TABLE media_auth_flows ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    id: 9,
    up(database) {
      const columns = new Set(database.pragma("table_info(media_connections)").map((column) => column.name));
      if (!columns.has("server_credential_ciphertext")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_ciphertext TEXT");
      if (!columns.has("server_credential_iv")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_iv TEXT");
      if (!columns.has("server_credential_tag")) database.exec("ALTER TABLE media_connections ADD COLUMN server_credential_tag TEXT");
      if (!columns.has("server_token_version")) database.exec("ALTER TABLE media_connections ADD COLUMN server_token_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    id: 10,
    up(database) {
      const deviceColumns = new Set(database.pragma("table_info(media_auth_devices)").map((column) => column.name));
      if (!deviceColumns.has("legacy_client_identifier")) database.exec("ALTER TABLE media_auth_devices ADD COLUMN legacy_client_identifier TEXT");
      database.exec("UPDATE media_auth_devices SET legacy_client_identifier=device_identifier || '-pms' WHERE legacy_client_identifier IS NULL OR legacy_client_identifier='' ");
      const flowColumns = new Set(database.pragma("table_info(media_auth_flows)").map((column) => column.name));
      if (!flowColumns.has("flow_kind")) database.exec("ALTER TABLE media_auth_flows ADD COLUMN flow_kind TEXT");
    },
  },
  {
    id: 11,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tracker_connections (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('connected','reauth_required','disabled')),
          remote_user_id TEXT, remote_username TEXT, client_id TEXT NOT NULL,
          client_secret_ciphertext TEXT NOT NULL, client_secret_iv TEXT NOT NULL, client_secret_tag TEXT NOT NULL,
          access_token_ciphertext TEXT NOT NULL, access_token_iv TEXT NOT NULL, access_token_tag TEXT NOT NULL,
          refresh_token_ciphertext TEXT NOT NULL, refresh_token_iv TEXT NOT NULL, refresh_token_tag TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1, access_token_expires_at INTEGER,
          initial_sync_mode TEXT NOT NULL DEFAULT 'baseline' CHECK (initial_sync_mode IN ('baseline','import')),
          baseline_complete INTEGER NOT NULL DEFAULT 0, last_polled_at INTEGER, last_validated_at INTEGER,
          last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracker_auth_flows (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, client_id TEXT NOT NULL,
          client_secret_ciphertext TEXT NOT NULL, client_secret_iv TEXT NOT NULL, client_secret_tag TEXT NOT NULL,
          device_code_ciphertext TEXT NOT NULL, device_code_iv TEXT NOT NULL, device_code_tag TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1, user_code TEXT NOT NULL, verification_url TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL, initial_sync_mode TEXT NOT NULL DEFAULT 'baseline',
          status TEXT NOT NULL CHECK (status IN ('pending','completed','expired','denied')),
          expires_at INTEGER NOT NULL, last_polled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_auth_flows_expiry ON tracker_auth_flows(expires_at);
        CREATE TABLE IF NOT EXISTS tracker_item_state (
          provider TEXT NOT NULL, media_key TEXT NOT NULL, media_json TEXT NOT NULL,
          remote_watched_at INTEGER, last_seen_at INTEGER NOT NULL,
          last_outbound_state TEXT CHECK (last_outbound_state IN ('watched','unwatched')), last_outbound_at INTEGER,
          PRIMARY KEY(provider, media_key)
        );
      `);
    },
  },
  {
    id: 12,
    up(database) {
      const columns = database.pragma("table_info(tracker_connections)").map((column) => column.name);
      if (!columns.includes("history_synced_at")) database.exec("ALTER TABLE tracker_connections ADD COLUMN history_synced_at INTEGER");
      database.exec(`
        CREATE TABLE IF NOT EXISTS tracker_play_history (
          provider TEXT NOT NULL, history_id TEXT NOT NULL, media_key TEXT NOT NULL,
          watched_at TEXT NOT NULL, watch_record_id TEXT, created_at INTEGER NOT NULL,
          PRIMARY KEY(provider, history_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_play_history_media ON tracker_play_history(provider, media_key);
      `);
    },
  },
  {
    id: 13,
    up(database) {
      const connectionColumns = database.pragma("table_info(tracker_connections)").map((column) => column.name);
      if (!connectionColumns.includes("prefer_earlier_watched_date")) {
        database.exec("ALTER TABLE tracker_connections ADD COLUMN prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1");
      }
      const flowColumns = database.pragma("table_info(tracker_auth_flows)").map((column) => column.name);
      if (!flowColumns.includes("prefer_earlier_watched_date")) {
        database.exec("ALTER TABLE tracker_auth_flows ADD COLUMN prefer_earlier_watched_date INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    id: 14,
    up(database) {
      database.exec(`
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
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);

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

        CREATE TABLE IF NOT EXISTS personal_lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS personal_list_items (
          list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
          media_key TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          title TEXT NOT NULL,
          tmdb_id TEXT,
          tvdb_id TEXT,
          imdb_id TEXT,
          poster_url TEXT,
          overview TEXT,
          release_date TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (list_id, media_key)
        );
        CREATE INDEX IF NOT EXISTS idx_personal_list_items_list ON personal_list_items(list_id, updated_at DESC);
      `);
    },
  },
  {
    id: 15,
    up(database) {
      const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (!table) return;
      const columns = new Set(database.pragma("table_info(personal_ratings)").map((column) => column.name));
      const tableSql = String(table.sql || "").toLowerCase();
      if (columns.has("show_title") && columns.has("season") && columns.has("episode") && tableSql.includes("'episode'")) return;

      database.exec(`
        DROP TABLE IF EXISTS personal_ratings_migrated;
        CREATE TABLE personal_ratings_migrated (
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
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO personal_ratings_migrated
          (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, show_title, season, episode, rating, created_at, updated_at)
        SELECT media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, NULL, NULL, NULL, rating, created_at, updated_at
        FROM personal_ratings;
        DROP TABLE personal_ratings;
        ALTER TABLE personal_ratings_migrated RENAME TO personal_ratings;
        CREATE INDEX IF NOT EXISTS idx_personal_ratings_updated ON personal_ratings(updated_at DESC);
      `);
    },
  },
  {
    id: 16,
    up(database) {
      database.exec(`
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
      `);
    },
  },
  {
    id: 17,
    up(database) {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (!table) return;

      const rows = database.prepare(`
        SELECT *
        FROM personal_ratings
        WHERE media_type = 'episode'
          AND trim(COALESCE(show_title, '')) <> ''
          AND season IS NOT NULL
          AND episode IS NOT NULL
        ORDER BY updated_at ASC, media_key ASC
      `).all();
      const groups = new Map();
      for (const row of rows) {
        const groupKey = `${String(row.show_title || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}:${row.season}:${row.episode}`;
        const group = groups.get(groupKey) || [];
        group.push(row);
        groups.set(groupKey, group);
      }

      const cachedTvTmdbIds = new Set(database.prepare(`
        SELECT tmdb_id
        FROM tmdb_metadata_cache
        WHERE media_type = 'tv' AND trim(COALESCE(tmdb_id, '')) <> ''
      `).all().map((row) => String(row.tmdb_id).trim()));
      const cachedSeriesTvdbIds = new Set(database.prepare(`
        SELECT tvdb_id
        FROM tvdb_metadata_cache
        WHERE id LIKE 'series_%' AND trim(COALESCE(tvdb_id, '')) <> ''
      `).all().map((row) => String(row.tvdb_id).trim()));
      const valuePresent = (value) => String(value ?? "").trim() !== "";
      const identityScore = (row) => {
        let score = 0;
        if (valuePresent(row.tmdb_id) && cachedTvTmdbIds.has(String(row.tmdb_id).trim())) score += 100;
        if (valuePresent(row.tvdb_id) && cachedSeriesTvdbIds.has(String(row.tvdb_id).trim())) score += 100;
        if (valuePresent(row.overview)) score += 4;
        if (valuePresent(row.release_date)) score += 2;
        if (valuePresent(row.poster_url)) score += 1;
        return score;
      };
      const update = database.prepare(`
        UPDATE personal_ratings
        SET title = @title,
            tmdb_id = @tmdb_id,
            tvdb_id = @tvdb_id,
            imdb_id = @imdb_id,
            poster_url = @poster_url,
            overview = @overview,
            release_date = @release_date,
            show_title = @show_title,
            season = @season,
            episode = @episode,
            rating = @rating,
            created_at = @created_at,
            updated_at = @updated_at
        WHERE media_key = @media_key
      `);
      const remove = database.prepare("DELETE FROM personal_ratings WHERE media_key = ?");
      let mergedGroups = 0;

      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const ranked = [...group].sort((left, right) => (
          identityScore(right) - identityScore(left)
          || Number(right.updated_at || 0) - Number(left.updated_at || 0)
          || String(left.media_key).localeCompare(String(right.media_key))
        ));
        const canonical = ranked[0];
        const latest = [...group].sort((left, right) => (
          Number(right.updated_at || 0) - Number(left.updated_at || 0)
          || String(left.media_key).localeCompare(String(right.media_key))
        ))[0];
        const pick = (field) => {
          for (const source of [canonical, ...ranked.slice(1)]) {
            if (valuePresent(source[field])) return source[field];
          }
          return null;
        };
        update.run({
          media_key: canonical.media_key,
          title: pick("title") || "Untitled",
          tmdb_id: pick("tmdb_id"),
          tvdb_id: pick("tvdb_id"),
          imdb_id: pick("imdb_id"),
          poster_url: pick("poster_url"),
          overview: pick("overview"),
          release_date: pick("release_date"),
          show_title: pick("show_title"),
          season: canonical.season,
          episode: canonical.episode,
          rating: latest.rating,
          created_at: Math.min(...group.map((row) => Number(row.created_at || 0))),
          updated_at: Math.max(...group.map((row) => Number(row.updated_at || 0))),
        });
        for (const row of group) {
          if (row.media_key !== canonical.media_key) remove.run(row.media_key);
        }
        mergedGroups += 1;
      }

      if (mergedGroups) {
        console.warn(`[personal] merged ${mergedGroups} duplicate episode rating group${mergedGroups === 1 ? "" : "s"}`);
      }
    },
  },
  {
    id: 18,
    up(database) {
      const columns = new Set(database.pragma("table_info(sync_history)").map((column) => column.name));
      if (!columns.has("activity_group_key")) {
        database.exec("ALTER TABLE sync_history ADD COLUMN activity_group_key TEXT");
      }

      const rows = database.prepare("SELECT id, media_type, title, source, action, target_states, raw_payload_debug FROM sync_history WHERE activity_group_key IS NULL OR activity_group_key = ''").all();
      const update = database.prepare("UPDATE sync_history SET activity_group_key = ? WHERE id = ?");
      for (const row of rows) {
        update.run(activityGroupKeyFor({
          mediaType: row.media_type,
          title: row.title,
          source: row.source,
          action: row.action,
          targetStates: parseJsonValue(row.target_states, []),
          rawPayloadDebug: parseJsonValue(row.raw_payload_debug, {}),
        }), row.id);
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_history_activity_group ON sync_history(activity_group_key, timestamp DESC, id DESC)");
    },
  },
  {
    id: 19,
    up(database) {
      const columns = new Set(database.pragma("table_info(sync_history)").map((column) => column.name));
      if (!columns.has("activity_group_key")) return;

      // Migration 18 originally keyed episodes by show + season + episode.
      // Recompute every row with the final show-level identity so databases
      // that already ran that migration receive the same grouping as fresh
      // installs. Do not pass the stored key back into the helper: it may be
      // one of those older episode-level keys.
      const rows = database.prepare("SELECT id, media_type, title, source, action, target_states, raw_payload_debug FROM sync_history").all();
      const update = database.prepare("UPDATE sync_history SET activity_group_key = ? WHERE id = ?");
      for (const row of rows) {
        const activityGroupKey = activityGroupKeyFor({
          mediaType: row.media_type,
          title: row.title,
          source: row.source,
          action: row.action,
          targetStates: parseJsonValue(row.target_states, []),
          rawPayloadDebug: parseJsonValue(row.raw_payload_debug, {}),
        });
        if (activityGroupKey) update.run(activityGroupKey, row.id);
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_history_activity_group ON sync_history(activity_group_key, timestamp DESC, id DESC)");
    },
  },
  {
    id: 20,
    up(database) {
      const ratingsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (ratingsTable) {
        const columns = new Set(database.pragma("table_info(personal_ratings)").map((column) => column.name));
        if (!columns.has("episode_tmdb_id")) database.exec("ALTER TABLE personal_ratings ADD COLUMN episode_tmdb_id TEXT");
        if (!columns.has("episode_tvdb_id")) database.exec("ALTER TABLE personal_ratings ADD COLUMN episode_tvdb_id TEXT");
        if (!columns.has("episode_imdb_id")) database.exec("ALTER TABLE personal_ratings ADD COLUMN episode_imdb_id TEXT");
        if (!columns.has("origin")) database.exec("ALTER TABLE personal_ratings ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
        if (!columns.has("canonical_updated_at")) database.exec("ALTER TABLE personal_ratings ADD COLUMN canonical_updated_at INTEGER NOT NULL DEFAULT 0");
        database.exec("UPDATE personal_ratings SET canonical_updated_at = updated_at WHERE canonical_updated_at = 0 OR canonical_updated_at IS NULL");
      }

      database.exec(`
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
      `);
    },
  },
  {
    id: 21,
    up(database) {
      database.exec(`
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
      `);
    },
  },
  {
    id: 22,
    up(database) {
      database.exec(`
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
      `);
    },
  },
  {
    id: 23,
    up(database) {
      const columns = new Set(database.pragma("table_info(up_next_provider_items)").map((column) => column.name));
      if (!columns.has("air_date")) database.exec("ALTER TABLE up_next_provider_items ADD COLUMN air_date TEXT");
    },
  },
  {
    id: 24,
    up(database) {
      const columns = new Set(database.pragma("table_info(up_next_provider_items)").map((column) => column.name));
      if (!columns.has("poster_url")) database.exec("ALTER TABLE up_next_provider_items ADD COLUMN poster_url TEXT");
      if (!columns.has("show_poster_url")) database.exec("ALTER TABLE up_next_provider_items ADD COLUMN show_poster_url TEXT");
    },
  },
  {
    id: 25,
    up(database) {
      const columns = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      if (!columns.has("episode_title")) database.exec("ALTER TABLE watch_history ADD COLUMN episode_title TEXT");
      if (!columns.has("episode_title_status")) database.exec("ALTER TABLE watch_history ADD COLUMN episode_title_status TEXT NOT NULL DEFAULT 'missing'");
      if (!columns.has("episode_title_checked_at")) database.exec("ALTER TABLE watch_history ADD COLUMN episode_title_checked_at INTEGER");
      if (!columns.has("episode_title_resolution_error")) database.exec("ALTER TABLE watch_history ADD COLUMN episode_title_resolution_error TEXT");
      database.exec(`
        UPDATE watch_history
        SET episode_title_status = CASE
          WHEN media_type = 'episode' AND (episode_title IS NULL OR TRIM(episode_title) = '' OR episode_title GLOB '[0-9]*' OR episode_title LIKE 'Episode %') THEN 'missing'
          ELSE 'resolved'
        END
        WHERE episode_title_status IS NULL OR episode_title_status = '' OR episode_title_status = 'missing';
        CREATE INDEX IF NOT EXISTS idx_watch_history_episode_title_status
          ON watch_history(media_type, episode_title_status, watched_at DESC);
      `);
    },
  },
  {
    id: 26,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS restore_reports (
          run_id TEXT PRIMARY KEY,
          result_json TEXT,
          log_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_restore_reports_updated ON restore_reports(updated_at DESC);
      `);
    },
  },
  {
    id: 27,
    up(database) {
      const columns = new Set(database.pragma("table_info(tmdb_metadata_cache)").map((column) => column.name));
      for (const column of ["poster_path", "cached_poster_url", "backdrop_path", "cached_backdrop_url", "tvdb_poster_url"]) {
        if (!columns.has(column)) database.exec(`ALTER TABLE tmdb_metadata_cache ADD COLUMN ${column} TEXT`);
      }
      // Backfill from the existing JSON blob without making a provider call.
      // json_extract is available in the SQLite build used by better-sqlite3;
      // malformed legacy blobs simply leave the compact field NULL.
      database.exec(`
        UPDATE tmdb_metadata_cache
        SET poster_path = COALESCE(poster_path, CASE WHEN json_valid(details) THEN json_extract(details, '$.poster_path') END),
            cached_poster_url = COALESCE(cached_poster_url, CASE WHEN json_valid(details) THEN json_extract(details, '$.cached_poster_url') END),
            backdrop_path = COALESCE(backdrop_path, CASE WHEN json_valid(details) THEN json_extract(details, '$.backdrop_path') END),
            cached_backdrop_url = COALESCE(cached_backdrop_url, CASE WHEN json_valid(details) THEN json_extract(details, '$.cached_backdrop_url') END),
            tvdb_poster_url = COALESCE(tvdb_poster_url, CASE WHEN json_valid(details) THEN json_extract(details, '$.tvdb_poster_url') END)
        WHERE details IS NOT NULL
      `);
    },
  },
  {
    id: 28,
    up(database) {
      // Very old imported databases can predate some watch-history columns.
      // Create each index only after confirming its columns exist; this keeps
      // the compatibility boot path safe while still upgrading normal installs.
      const columns = (table) => new Set(database.pragma(`table_info(${table})`).map((column) => column.name));
      const create = (table, required, sql) => {
        if (required.every((column) => columns(table).has(column))) database.exec(sql);
      };
      create("watch_history", ["media_type", "season", "episode"], "CREATE INDEX IF NOT EXISTS idx_watch_history_media_season_episode ON watch_history(media_type, season, episode)");
      create("watch_history", ["media_type", "title_lower"], "CREATE INDEX IF NOT EXISTS idx_watch_history_media_title_lower ON watch_history(media_type, title_lower)");
      create("watch_history", ["tmdb_id"], "CREATE INDEX IF NOT EXISTS idx_watch_history_tmdb_id ON watch_history(tmdb_id)");
      create("watch_history", ["tvdb_id"], "CREATE INDEX IF NOT EXISTS idx_watch_history_tvdb_id ON watch_history(tvdb_id)");
      create("watch_history", ["updated_at", "created_at"], "CREATE INDEX IF NOT EXISTS idx_watch_history_updated_created ON watch_history(updated_at DESC, created_at DESC)");
      create("playstate", ["media_type", "title_lower"], "CREATE INDEX IF NOT EXISTS idx_playstate_media_title_lower ON playstate(media_type, title_lower)");
      create("playstate", ["media_type", "imdb_id"], "CREATE INDEX IF NOT EXISTS idx_playstate_media_imdb_id ON playstate(media_type, imdb_id)");
      create("playstate", ["media_type", "tmdb_id"], "CREATE INDEX IF NOT EXISTS idx_playstate_media_tmdb_id ON playstate(media_type, tmdb_id)");
      create("playstate", ["media_type", "tvdb_id"], "CREATE INDEX IF NOT EXISTS idx_playstate_media_tvdb_id ON playstate(media_type, tvdb_id)");
      create("playstate", ["season", "episode"], "CREATE INDEX IF NOT EXISTS idx_playstate_season_episode ON playstate(season, episode)");
      create("playback_progress", ["tmdb_id"], "CREATE INDEX IF NOT EXISTS idx_playback_progress_tmdb_id ON playback_progress(tmdb_id)");

      // Keep planner statistics current after the targeted identity/order
      // indexes are created. This runs once per database rather than on every
      // boot and does not change durability settings.
      database.exec("ANALYZE watch_history; ANALYZE playstate; ANALYZE playback_progress;");
    },
  },
  {
    id: 29,
    up(database) {
      const columns = new Set(database.pragma("table_info(tmdb_metadata_cache)").map((column) => column.name));
      if (!columns.has("status")) database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN status TEXT");
      // Backfilled from the blob already stored, so no title is re-fetched from
      // TMDB and DETAILS_SCHEMA_VERSION is deliberately not bumped.
      database.exec(`
        UPDATE tmdb_metadata_cache
        SET status = COALESCE(status, CASE WHEN json_valid(details) THEN json_extract(details, '$.status') END)
        WHERE details IS NOT NULL
      `);
    },
  },
  {
    id: 30,
    up(database) {
      // The cached TMDB blob carried streaming availability for every country
      // TMDB knows about, and a release-dates block nothing reads. Together
      // those were about 40% of the metadata cache. New rows are trimmed on
      // write; this rewrites the rows already stored so existing titles get the
      // smaller payload immediately instead of waiting to be refreshed. It
      // reads only what is already on disk and makes no provider request.
      const rows = database.prepare("SELECT id, details FROM tmdb_metadata_cache WHERE details IS NOT NULL").all();
      const update = database.prepare("UPDATE tmdb_metadata_cache SET details = ? WHERE id = ?");
      for (const row of rows) {
        let details;
        try {
          details = JSON.parse(row.details);
        } catch {
          continue; // a malformed legacy row is left exactly as it is
        }
        if (!details || typeof details !== "object") continue;
        const trimmed = { ...details };
        let changed = false;
        if (trimmed["watch/providers"]?.results && typeof trimmed["watch/providers"].results === "object") {
          const results = trimmed["watch/providers"].results;
          const kept = {};
          for (const region of ["GB", "US"]) {
            if (results[region]) kept[region] = results[region];
          }
          if (Object.keys(kept).length !== Object.keys(results).length) {
            trimmed["watch/providers"] = { ...trimmed["watch/providers"], results: kept };
            changed = true;
          }
        }
        if (trimmed.release_dates !== undefined) {
          delete trimmed.release_dates;
          changed = true;
        }
        if (changed) update.run(JSON.stringify(trimmed), row.id);
      }
    },
  },
  {
    id: 31,
    up(database) {
      // Give resume positions their own generation. Every history-derived cache
      // was being thrown away by a write none of them reads.
      database.exec("INSERT OR IGNORE INTO cache_versions (id, version, updated_at) VALUES ('progress', 1, 0)");
      // The triggers are recreated rather than edited in place: SQLite has no
      // ALTER TRIGGER, and dropping first means a database that already has the
      // repointed version cannot end up with two.
      for (const event of ["insert", "update", "delete"]) {
        database.exec(`DROP TRIGGER IF EXISTS trg_playback_progress_cache_${event}`);
        database.exec(`
          CREATE TRIGGER trg_playback_progress_cache_${event} AFTER ${event.toUpperCase()} ON playback_progress BEGIN
            UPDATE cache_versions SET version=version+1, updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id='progress';
          END;
        `);
      }
    },
  },
  {
    id: 32,
    up(database) {
      // History paging keeps the existing whole-library, same-day collapse,
      // but stores its deterministic expressions as virtual columns so the
      // correlated newest-row lookup can use an index. Virtual columns avoid
      // duplicating derived data in every writer and are calculated for
      // existing rows without a backfill.
      const columns = new Set(database.pragma("table_xinfo(watch_history)").map((column) => column.name));
      const required = ["title", "title_lower", "media_type", "watched_at", "imdb_id", "tmdb_id", "tvdb_id", "season", "episode", "show_title", "show_title_lower", "updated_at"];
      if (!required.every((column) => columns.has(column))) return;
      if (!columns.has("history_day")) {
        database.exec("ALTER TABLE watch_history ADD COLUMN history_day TEXT GENERATED ALWAYS AS (SUBSTR(COALESCE(watched_at, ''), 1, 10)) VIRTUAL");
      }
      if (!columns.has("history_daily_key")) {
        database.exec(`
          ALTER TABLE watch_history ADD COLUMN history_daily_key TEXT GENERATED ALWAYS AS (
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
        `);
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_watch_history_daily_key_order
          ON watch_history(history_day, history_daily_key, watched_at DESC, updated_at DESC);
        ANALYZE watch_history;
      `);
    },
  },
  {
    id: 33,
    up(database) {
      // rowToWatch historically repaired malformed specials coordinates and
      // decoded titles on every cache rebuild. Persist that projection once
      // for existing rows; all normal writers use the same pure helper.
      const columns = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      const required = ["id", "title", "title_lower", "media_type", "season", "episode"];
      if (!required.every((column) => columns.has(column))) return;
      const rows = database.prepare("SELECT id, title, title_lower, media_type, season, episode FROM watch_history").all();
      const update = database.prepare(`
        UPDATE watch_history
        SET title = @title, title_lower = @title_lower, season = @season, episode = @episode
        WHERE id = @id
      `);
      for (const row of rows) {
        const derived = persistedWatchDerivedFields(row);
        if (
          derived.title === row.title
          && derived.title_lower === row.title_lower
          && derived.season === row.season
          && derived.episode === row.episode
        ) continue;
        update.run({ id: row.id, ...derived });
      }
    },
  },
  {
    id: 34,
    up(database) {
      const columns = new Set(database.pragma("table_info(sync_history)").map((column) => column.name));
      if (!columns.has("activity_item_key")) database.exec("ALTER TABLE sync_history ADD COLUMN activity_item_key TEXT");

      const rows = database.prepare("SELECT id, media_type, title, source, action, raw_payload_debug FROM sync_history").all();
      const update = database.prepare("UPDATE sync_history SET activity_item_key = ? WHERE id = ?");
      for (const row of rows) {
        update.run(activityItemKeyFor({
          mediaType: row.media_type,
          title: row.title,
          source: row.source,
          action: row.action,
          rawPayloadDebug: parseJsonValue(row.raw_payload_debug, {}),
        }), row.id);
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_history_activity_item ON sync_history(activity_item_key, timestamp DESC, id DESC)");
    },
  },
  {
    id: 35,
    up(database) {
      const columns = new Set(database.pragma("table_info(sync_history)").map((column) => column.name));
      if (!columns.has("activity_item_key")) database.exec("ALTER TABLE sync_history ADD COLUMN activity_item_key TEXT");
      const rows = database.prepare("SELECT id, media_type, title, source, action, raw_payload_debug FROM sync_history").all();
      const update = database.prepare("UPDATE sync_history SET activity_item_key = ? WHERE id = ?");
      for (const row of rows) {
        update.run(activityItemKeyFor({
          mediaType: row.media_type,
          title: row.title,
          source: row.source,
          action: row.action,
          rawPayloadDebug: parseJsonValue(row.raw_payload_debug, {}),
        }), row.id);
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_history_activity_item ON sync_history(activity_item_key, timestamp DESC, id DESC)");
    },
  },
  {
    id: 36,
    up(database) {
      // A pre-release build briefly used migration 35 for the same column
      // before the canonical padded-coordinate repair was finalized. Re-run
      // the backfill once so those local/test databases converge too.
      const columns = new Set(database.pragma("table_info(sync_history)").map((column) => column.name));
      if (!columns.has("activity_item_key")) database.exec("ALTER TABLE sync_history ADD COLUMN activity_item_key TEXT");
      const rows = database.prepare("SELECT id, media_type, title, source, action, raw_payload_debug FROM sync_history").all();
      const update = database.prepare("UPDATE sync_history SET activity_item_key = ? WHERE id = ?");
      for (const row of rows) {
        update.run(activityItemKeyFor({
          mediaType: row.media_type,
          title: row.title,
          source: row.source,
          action: row.action,
          rawPayloadDebug: parseJsonValue(row.raw_payload_debug, {}),
        }), row.id);
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_history_activity_item ON sync_history(activity_item_key, timestamp DESC, id DESC)");
    },
  },
  {
    id: 37,
    up(database) {
      // Up Next writes a position to Plex Continue Watching, Emby Resume, and
      // Jellyfin Next Up so their calculated rails can show the queue. That
      // position has to be large enough for the provider to keep it, which
      // puts it above Plembfin's own resume threshold, so size alone can no
      // longer tell a seeded position apart from a real one. This ledger
      // records exactly what was written so ingestion can reject it by
      // identity.
      database.exec(`
        CREATE TABLE IF NOT EXISTS up_next_rail_seeds (
          provider TEXT NOT NULL CHECK (provider IN ('plex', 'emby', 'jellyfin')),
          provider_item_id TEXT NOT NULL,
          position_ms INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          media_key TEXT,
          title TEXT,
          seeded_at INTEGER NOT NULL,
          PRIMARY KEY (provider, provider_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_up_next_rail_seeds_seeded_at
          ON up_next_rail_seeds(seeded_at);
      `);
    },
  },
  {
    id: 38,
    up(database) {
      // Up Next dismissals used to live only in the browser's localStorage, so
      // the server's idea of the queue was not the one the user saw. Any push
      // that did not originate from that exact browser - the API, a second
      // device, anything scheduled - pushed the dismissed items back out to
      // every media server. Dismissals are queue state and belong here.
      database.exec(`
        CREATE TABLE IF NOT EXISTS up_next_dismissals (
          id TEXT PRIMARY KEY,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          media_key TEXT,
          media_type TEXT,
          title TEXT,
          show_title TEXT,
          episode_title TEXT,
          season INTEGER,
          episode INTEGER,
          snapshot_json TEXT,
          dismissed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_up_next_dismissals_dismissed_at
          ON up_next_dismissals(dismissed_at DESC);
      `);
    },
  },
  {
    id: 39,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS recommendation_exclusions (
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          tmdb_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          excluded_at INTEGER NOT NULL,
          PRIMARY KEY (media_type, tmdb_id)
        );
        CREATE INDEX IF NOT EXISTS idx_recommendation_exclusions_excluded_at
          ON recommendation_exclusions(excluded_at DESC);
      `);
    },
  },
  {
    id: 40,
    up(database) {
      database.exec(`
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
      `);
    },
  },
  {
    id: 41,
    up(database) {
      const watchCols = new Set(database.pragma("table_info(watch_history)").map((column) => column.name));
      if (!watchCols.has("sync_match_ignored_at")) {
        database.exec("ALTER TABLE watch_history ADD COLUMN sync_match_ignored_at INTEGER");
      }
    },
  },
  {
    id: 42,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS up_next_library_items (
          lookup_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          provider_item_id TEXT NOT NULL,
          resolved_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Playlists: ordered items, episode items, and soft delete. The items
    // media_type CHECK must accept 'episode', so both tables are rebuilt.
    // A DROP TABLE with foreign keys on runs an implicit DELETE that cascades,
    // so items are copied to a key-less backup and dropped before the lists.
    // Existing lists get no personal_list_targets rows, so they stay
    // Plembfin-only; positions follow the previous updated_at DESC order.
    id: 43,
    up(database) {
      const listColumns = new Set(database.pragma("table_info(personal_lists)").map((column) => column.name));
      const itemColumns = new Set(database.pragma("table_info(personal_list_items)").map((column) => column.name));
      const itemsSql = String(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'personal_list_items'").get()?.sql || "").toLowerCase();
      const current = listColumns.has("deleted_at") && itemColumns.has("position") && itemsSql.includes("'episode'");
      if (!current) {
        database.exec(`
          DROP TABLE IF EXISTS personal_lists_migrated;
          DROP TABLE IF EXISTS personal_list_items_backup;
          CREATE TABLE personal_lists_migrated (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            order_updated_at INTEGER,
            deleted_at INTEGER,
            deleted_origin TEXT
          );
          INSERT INTO personal_lists_migrated (id, name, created_at, updated_at)
          SELECT id, name, created_at, updated_at FROM personal_lists;
          CREATE TABLE personal_list_items_backup AS
          SELECT list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url,
            overview, release_date, created_at, updated_at,
            ROW_NUMBER() OVER (PARTITION BY list_id ORDER BY updated_at DESC, media_key ASC) - 1 AS position
          FROM personal_list_items;
          DROP TABLE personal_list_items;
          DROP TABLE personal_lists;
          ALTER TABLE personal_lists_migrated RENAME TO personal_lists;
          CREATE TABLE personal_list_items (
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
          INSERT INTO personal_list_items
            (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, position, created_at, updated_at)
          SELECT list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, position, created_at, updated_at
          FROM personal_list_items_backup;
          DROP TABLE personal_list_items_backup;
        `);
      }
      // Names were unique case-sensitively; the app checked case-insensitively.
      // Suffix any case-only duplicate so the active-name index can be built.
      const seen = new Set();
      const rename = database.prepare("UPDATE personal_lists SET name = ? WHERE id = ?");
      for (const list of database.prepare("SELECT id, name FROM personal_lists WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC").all()) {
        let name = list.name;
        for (let suffix = 2; seen.has(name.toLowerCase()); suffix++) name = `${list.name} (${suffix})`;
        if (name !== list.name) rename.run(name, list.id);
        seen.add(name.toLowerCase());
      }
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_lists_active_name
          ON personal_lists(name COLLATE NOCASE) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_personal_list_items_position
          ON personal_list_items(list_id, position, media_key);
      `);
    },
  },
  {
    // Playlists become Movies or TV (plan/archive/custom-playlist-sync/plan.md decisions
    // 14, 15, 19). A playlist holding both keeps its movies and name; its
    // shows and episodes move to a new "Name (TV)" playlist that targets the
    // same apps with no app copy yet, so the push creates one and removes the
    // moved entries from the original's app copies. Show items become episodes
    // later (playlistShowConversion.js), because that needs metadata.
    id: 44,
    up(database) {
      const columns = new Set(database.pragma("table_info(personal_lists)").map((column) => column.name));
      if (!columns.has("kind")) {
        database.exec("ALTER TABLE personal_lists ADD COLUMN kind TEXT CHECK (kind IN ('movie', 'tv'))");
      }
      const lists = database.prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM personal_list_items i WHERE i.list_id = l.id AND i.media_type = 'movie') AS movies,
          (SELECT COUNT(*) FROM personal_list_items i WHERE i.list_id = l.id AND i.media_type <> 'movie') AS shows
        FROM personal_lists l WHERE l.kind IS NULL ORDER BY l.created_at ASC, l.id ASC
      `).all();
      const setKind = database.prepare("UPDATE personal_lists SET kind = ? WHERE id = ?");
      const nameTaken = database.prepare("SELECT 1 FROM personal_lists WHERE lower(name) = lower(?) AND deleted_at IS NULL");
      const renumber = (listId) => {
        const keys = database.prepare("SELECT media_key FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC").all(listId);
        const update = database.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
        keys.forEach((row, index) => update.run(index, listId, row.media_key));
      };
      for (const list of lists) {
        if (!list.movies && !list.shows) continue;
        if (!list.shows) { setKind.run("movie", list.id); continue; }
        if (!list.movies) { setKind.run("tv", list.id); continue; }
        const now = Date.now();
        const id = crypto.randomUUID();
        let name = `${list.name} (TV)`;
        for (let suffix = 2; !list.deleted_at && nameTaken.get(name); suffix++) name = `${list.name} (TV) (${suffix})`;
        database.prepare(`
          INSERT INTO personal_lists (id, name, kind, created_at, updated_at, order_updated_at, deleted_at, deleted_origin)
          VALUES (?, ?, 'tv', ?, ?, ?, ?, ?)
        `).run(id, name, list.created_at, now, list.order_updated_at, list.deleted_at, list.deleted_origin);
        database.prepare(`
          INSERT INTO personal_list_targets (list_id, provider, desired_state, created_at, updated_at)
          SELECT ?, provider, 'present', ?, ? FROM personal_list_targets WHERE list_id = ? AND desired_state = 'present'
        `).run(id, now, now, list.id);
        // Exclusions and availability reference the items, so they cannot
        // follow a list_id change: exclusions are re-inserted, availability is
        // rebuilt by the next push.
        const exclusions = database.prepare(`
          SELECT e.* FROM personal_list_item_exclusions e
          JOIN personal_list_items i ON i.list_id = e.list_id AND i.media_key = e.media_key
          WHERE e.list_id = ? AND i.media_type <> 'movie'
        `).all(list.id);
        database.prepare(`
          DELETE FROM personal_list_item_exclusions WHERE list_id = ? AND media_key IN
            (SELECT media_key FROM personal_list_items WHERE list_id = ? AND media_type <> 'movie')
        `).run(list.id, list.id);
        database.prepare(`
          DELETE FROM personal_list_item_availability WHERE list_id = ? AND media_key IN
            (SELECT media_key FROM personal_list_items WHERE list_id = ? AND media_type <> 'movie')
        `).run(list.id, list.id);
        database.prepare("UPDATE personal_list_items SET list_id = ? WHERE list_id = ? AND media_type <> 'movie'").run(id, list.id);
        const reinsert = database.prepare(`
          INSERT INTO personal_list_item_exclusions (list_id, media_key, season, episode, origin, excluded_at) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const row of exclusions) reinsert.run(id, row.media_key, row.season, row.episode, row.origin, row.excluded_at);
        setKind.run("movie", list.id);
        database.prepare("UPDATE personal_lists SET updated_at = ? WHERE id = ?").run(now, list.id);
        renumber(list.id);
        renumber(id);
      }
    },
  },
  {
    // Mixed playlists hold movies and episodes together
    // (plan/archive/custom-playlist-sync/plan.md decision 25). A CHECK cannot be
    // altered and a table rebuild would cascade-delete the items, so the
    // column is swapped: a widened copy is added, filled, and renamed.
    id: 45,
    up(database) {
      const sql = String(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'personal_lists'").get()?.sql || "");
      if (sql.includes("'mixed'")) return;
      database.exec(`
        ALTER TABLE personal_lists ADD COLUMN kind_widened TEXT CHECK (kind_widened IN ('movie', 'tv', 'mixed'));
        UPDATE personal_lists SET kind_widened = kind;
        ALTER TABLE personal_lists DROP COLUMN kind;
        ALTER TABLE personal_lists RENAME COLUMN kind_widened TO kind;
      `);
    },
  },
  {
    // App playlist entries Plembfin could not identify, counted per app at
    // each pull (plan/archive/custom-playlist-sync/plan.md decision 24).
    id: 46,
    up(database) {
      const columns = new Set(database.pragma("table_info(personal_list_targets)").map((column) => column.name));
      if (!columns.has("unidentified_count")) {
        database.exec("ALTER TABLE personal_list_targets ADD COLUMN unidentified_count INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    // Automatic playlists (plan/archive/custom-playlist-sync/plan.md decisions
    // 32 to 43): the rule that picks the items (NULL for a manual playlist),
    // when it was last evaluated, and why the last evaluation failed.
    id: 47,
    up(database) {
      const columns = new Set(database.pragma("table_info(personal_lists)").map((column) => column.name));
      if (!columns.has("rule_json")) database.exec("ALTER TABLE personal_lists ADD COLUMN rule_json TEXT");
      if (!columns.has("rule_checked_at")) database.exec("ALTER TABLE personal_lists ADD COLUMN rule_checked_at INTEGER");
      if (!columns.has("rule_error")) database.exec("ALTER TABLE personal_lists ADD COLUMN rule_error TEXT");
    },
  },
  {
    // A rule check held for Confirm or Discard (decisions 41, 47, 48): the
    // desired items it would apply, as JSON, and when the user confirmed it.
    // personal_list_held_changes cannot hold it (keyed per app target, and a
    // Plembfin-only playlist has no target).
    id: 48,
    up(database) {
      const columns = new Set(database.pragma("table_info(personal_lists)").map((column) => column.name));
      if (!columns.has("rule_hold_json")) database.exec("ALTER TABLE personal_lists ADD COLUMN rule_hold_json TEXT");
      if (!columns.has("rule_hold_confirmed_at")) database.exec("ALTER TABLE personal_lists ADD COLUMN rule_hold_confirmed_at INTEGER");
    },
  },
  {
    // "Remove items once watched" (decisions 55 to 57), and the titles an
    // automatic playlist handed off after a watch and never adds back
    // (decision 56), one row per id key of the title.
    id: 49,
    up(database) {
      const columns = new Set(database.pragma("table_info(personal_lists)").map((column) => column.name));
      if (!columns.has("remove_watched")) database.exec("ALTER TABLE personal_lists ADD COLUMN remove_watched INTEGER NOT NULL DEFAULT 0");
      database.exec(`
        CREATE TABLE IF NOT EXISTS personal_list_handoffs (
          list_id TEXT NOT NULL REFERENCES personal_lists(id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          handed_off_at INTEGER NOT NULL,
          PRIMARY KEY (list_id, identity)
        )
      `);
    },
  },
  {
    // A title's TMDB original language, mirrored out of the details blob so
    // the Language choice of automatic playlists (decisions 60 to 62) reads
    // it for a whole library without parsing every blob. Backfilled from the
    // stored details without a provider call.
    id: 50,
    up(database) {
      const columns = new Set(database.pragma("table_info(tmdb_metadata_cache)").map((column) => column.name));
      if (!columns.has("original_language")) database.exec("ALTER TABLE tmdb_metadata_cache ADD COLUMN original_language TEXT");
      database.exec(`
        UPDATE tmdb_metadata_cache
        SET original_language = CASE WHEN json_valid(details) THEN json_extract(details, '$.original_language') END
        WHERE details IS NOT NULL AND original_language IS NULL
      `);
    },
  },
  {
    // Playlist type (plan/archive/custom-playlist-sync decision 72): existing
    // automatic playlists become Top rated with a maximum of 20, keep their
    // order, and are due a rule check. The check's usual safety hold asks
    // for Confirm when that removes many titles.
    id: 51,
    up(database) {
      const rows = database.prepare("SELECT id, rule_json FROM personal_lists WHERE rule_json IS NOT NULL").all();
      const update = database.prepare("UPDATE personal_lists SET rule_json = ?, rule_checked_at = NULL WHERE id = ?");
      for (const row of rows) {
        const rule = parseJsonValue(row.rule_json, null);
        if (!rule || typeof rule !== "object" || rule.type) continue;
        update.run(JSON.stringify({ ...rule, type: "top", limit: 20 }), row.id);
      }
    },
  },
  {
    // Episode rating identity drops a release year from the show title (see
    // showTitleKey in personalRatingIdentity.js). Rows keyed with the year,
    // such as "Ludwig (2024)", move to the bare-title key. Where a bare-title
    // row already exists for the same episode, the newest canonical rating
    // wins. Its provider ledger and queue rows are kept; the other rows keep
    // only the providers the winner lacks. This rewrite is one-time: keep it
    // frozen rather than calling the live identity helpers.
    id: 52,
    up(database) {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_ratings'").get();
      if (!table) return;

      const titleSlug = (showTitle) => String(showTitle ?? "").trim().slice(0, 300)
        .replace(/\s*\(\d{4}\)$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const yearPattern = /\(\d{4}\)\s*$/;
      const marks = (values) => values.map(() => "?").join(",");

      const rows = database.prepare(`
        SELECT media_key, show_title, season, episode, canonical_updated_at, updated_at
        FROM personal_ratings
        WHERE media_type = 'episode'
          AND media_key LIKE 'episode:title:%'
          AND trim(COALESCE(show_title, '')) <> ''
      `).all();
      const groups = new Map();
      for (const row of rows) {
        const coordinate = `s${Number.isInteger(row.season) ? row.season : "?"}e${Number.isInteger(row.episode) ? row.episode : "?"}`;
        const target = `episode:title:${titleSlug(row.show_title)}:${coordinate}`;
        const group = groups.get(target) || { target, rows: [] };
        group.rows.push(row);
        groups.set(target, group);
      }

      const ledgerTables = ["personal_rating_sources", "personal_rating_sync_queue"];
      let rekeyedGroups = 0;
      for (const { target, rows: members } of groups.values()) {
        if (!members.some((row) => yearPattern.test(String(row.show_title).trim()) && row.media_key !== target)) continue;
        const ranked = [...members].sort((left, right) => (
          Number(right.canonical_updated_at || 0) - Number(left.canonical_updated_at || 0)
          || Number(right.updated_at || 0) - Number(left.updated_at || 0)
          || String(left.media_key).localeCompare(String(right.media_key))
        ));
        const winner = ranked[0].media_key;
        const losers = ranked.slice(1).map((row) => row.media_key);
        const allKeys = ranked.map((row) => row.media_key);
        const droppedLosers = losers.filter((key) => key !== target);

        for (const ledger of ledgerTables) {
          if (losers.length) {
            database.prepare(`
              DELETE FROM ${ledger}
              WHERE media_key IN (${marks(losers)})
                AND provider IN (SELECT provider FROM ${ledger} WHERE media_key = ?)
            `).run(...losers, winner);
          }
          database.prepare(`UPDATE OR IGNORE ${ledger} SET media_key = ? WHERE media_key IN (${marks(allKeys)})`).run(target, ...allKeys);
          if (droppedLosers.length) {
            database.prepare(`DELETE FROM ${ledger} WHERE media_key IN (${marks(droppedLosers)})`).run(...droppedLosers);
          }
        }

        if (losers.length) {
          database.prepare(`DELETE FROM personal_ratings WHERE media_key IN (${marks(losers)})`).run(...losers);
        }
        // A row already at the target key outside this group has no show title to
        // check, so it is left alone rather than overwritten.
        const targetTaken = database.prepare("SELECT 1 FROM personal_ratings WHERE media_key = ?").get(target);
        if (winner !== target && !targetTaken) {
          database.prepare("UPDATE personal_ratings SET media_key = ? WHERE media_key = ?").run(target, winner);
        }
        rekeyedGroups += 1;
      }

      if (rekeyedGroups) {
        console.warn(`[personal] re-keyed ${rekeyedGroups} episode rating group${rekeyedGroups === 1 ? "" : "s"} without the show year`);
      }
    },
  },
];

function parseJsonValue(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function runSchemaMigrations() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER)");
  const appliedStmt = db.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const insertStmt = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    db.transaction(() => {
      // Recheck under an IMMEDIATE transaction. Two Plembfin processes may
      // start against the same database at exactly the same time.
      if (appliedStmt.get(migration.id)) return;
      migration.up(db);
      insertStmt.run(migration.id, Date.now());
    }).immediate();
  }
}

try {
  runSchemaMigrations();
} catch (error) {
  console.error("Schema migration failed", error);
  throw error;
}

// Compatibility guard for databases from before the migration table existed.
try {
  const watchCols = db.pragma("table_info(watch_history)").map(c => c.name);
  if (!watchCols.includes("logo_url")) db.exec("ALTER TABLE watch_history ADD COLUMN logo_url TEXT");
  if (!watchCols.includes("backdrop_url")) db.exec("ALTER TABLE watch_history ADD COLUMN backdrop_url TEXT");
  if (!watchCols.includes("watch_provenance")) db.exec("ALTER TABLE watch_history ADD COLUMN watch_provenance TEXT");
  if (!watchCols.includes("sync_match_ignored_at")) db.exec("ALTER TABLE watch_history ADD COLUMN sync_match_ignored_at INTEGER");
} catch { /* column already exists */ }

// The main schema is executed before legacy migrations. Keep the item-level
// triggers out of schema.sql so an old watch_history table without newer
// columns can still be upgraded, then install the richest trigger shape the
// resulting table supports once migrations have completed.
function installLiveChangeTriggers() {
  db.transaction(() => {
    const columnsFor = (table) => new Set(db.pragma(`table_info(${table})`).map((column) => column.name));
    const expr = (alias, column, columns) => columns.has(column) ? `${alias}.${column}` : "NULL";
    const triggerNames = [
      "watch_history", "playstate", "playback_progress", "personal_watchlist", "manual_watch_reviews",
    ].flatMap((table) => ["insert", "update", "delete"].map((event) => `trg_${table}_live_${event}`));
    for (const name of triggerNames) db.exec(`DROP TRIGGER IF EXISTS ${name}`);

  const createTriggers = ({ table, source, recordIdColumn = null, updateOldKeyDelete = false, mediaKeyColumn = "media_key" }) => {
    const columns = columnsFor(table);
    if (!columns.has("media_key") || !columns.has("media_type") || !columns.has("title")) return;
    const insertEvent = (kind, alias) => `
      INSERT INTO live_change_events (source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at)
      VALUES ('${source}', '${kind}', ${mediaKeyColumn ? expr(alias, mediaKeyColumn, columns) : "NULL"}, ${recordIdColumn ? expr(alias, recordIdColumn, columns) : "NULL"}, ${expr(alias, "media_type", columns)}, ${expr(alias, "title", columns)}, ${expr(alias, "show_title", columns)}, ${expr(alias, "season", columns)}, ${expr(alias, "episode", columns)}, CAST(unixepoch('subsec')*1000 AS INTEGER));
    `;
    db.exec(`
      CREATE TRIGGER trg_${table}_live_insert AFTER INSERT ON ${table} BEGIN
        ${insertEvent("upsert", "NEW")}
      END;
      CREATE TRIGGER trg_${table}_live_update AFTER UPDATE ON ${table} BEGIN
        ${insertEvent("upsert", "NEW")}
        ${updateOldKeyDelete ? `${insertEvent("delete", "OLD")} WHERE COALESCE(OLD.media_key, '') <> COALESCE(NEW.media_key, '');` : ""}
      END;
      CREATE TRIGGER trg_${table}_live_delete AFTER DELETE ON ${table} BEGIN
        ${insertEvent("delete", "OLD")}
      END;
    `);
  };

    const watchColumns = columnsFor("watch_history");
    if (watchColumns.has("id") && watchColumns.has("media_key") && watchColumns.has("media_type")) {
      const insertEvent = (kind, alias) => `
      INSERT INTO live_change_events (source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at)
      VALUES ('watch_history', '${kind}', ${expr(alias, "media_key", watchColumns)}, ${expr(alias, "id", watchColumns)}, ${expr(alias, "media_type", watchColumns)}, ${expr(alias, "title", watchColumns)}, ${expr(alias, "show_title", watchColumns)}, ${expr(alias, "season", watchColumns)}, ${expr(alias, "episode", watchColumns)}, CAST(unixepoch('subsec')*1000 AS INTEGER));
    `;
      db.exec(`
      CREATE TRIGGER trg_watch_history_live_insert AFTER INSERT ON watch_history BEGIN
        ${insertEvent("upsert", "NEW")}
      END;
      CREATE TRIGGER trg_watch_history_live_update AFTER UPDATE ON watch_history BEGIN
        ${insertEvent("upsert", "NEW")}
        INSERT INTO live_change_events (source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at)
        SELECT 'watch_history', 'delete', OLD.media_key, OLD.id, OLD.media_type, ${expr("OLD", "title", watchColumns)}, ${expr("OLD", "show_title", watchColumns)}, ${expr("OLD", "season", watchColumns)}, ${expr("OLD", "episode", watchColumns)}, CAST(unixepoch('subsec')*1000 AS INTEGER)
        WHERE COALESCE(OLD.media_key, '') <> COALESCE(NEW.media_key, '');
      END;
      CREATE TRIGGER trg_watch_history_live_delete AFTER DELETE ON watch_history BEGIN
        ${insertEvent("delete", "OLD")}
      END;
      `);
    }

    createTriggers({ table: "playstate", source: "playstate" });
    createTriggers({ table: "playback_progress", source: "playback_progress" });
    createTriggers({ table: "personal_watchlist", source: "personal_watchlist" });
    // Review rows have their own identity so a status update cannot coalesce
    // away the canonical watch-history event for the same media key. The
    // source-specific event lets the browser refresh only the review item/list.
    createTriggers({ table: "manual_watch_reviews", source: "manual_watch_reviews", recordIdColumn: "id", mediaKeyColumn: null });
  }).immediate();
}

try {
  installLiveChangeTriggers();
} catch (error) {
  console.error("Live change trigger setup failed", error);
  throw error;
}

// ---------------------------------------------------------------------------
// Shared derived-cache version. Each process keeps a fast local copy and polls
// SQLite at a bounded cadence so writes by another process invalidate caches.
// ---------------------------------------------------------------------------
const CACHE_VERSION_POLL_MS = 500;
const selectHistoryVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'history'");
const bumpHistoryVersion = db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'history' RETURNING version");
const selectProgressVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'progress'");
const selectDiscoverVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'discover'");
const bumpDiscoverVersionStmt = db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'discover' RETURNING version");
const selectUpNextVersion = db.prepare("SELECT version FROM cache_versions WHERE id = 'up_next'");
const bumpUpNextVersionStmt = db.prepare("UPDATE cache_versions SET version = version + 1, updated_at = ? WHERE id = 'up_next' RETURNING version");
const selectLatestLiveChangeId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM live_change_events");
const selectLiveChangesAfter = db.prepare(`
  SELECT id, source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at
  FROM live_change_events
  WHERE id > ?
  ORDER BY id ASC
  LIMIT ?
`);
const pruneLiveChangesByAge = db.prepare("DELETE FROM live_change_events WHERE created_at < ?");
const pruneLiveChangesByCount = db.prepare(`
  DELETE FROM live_change_events
  WHERE id < (SELECT MAX(id) - ? FROM live_change_events)
`);
let lastLiveChangePruneAt = 0;
const LIVE_CHANGE_PRUNE_INTERVAL_MS = 60_000;
const LIVE_CHANGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const LIVE_CHANGE_MAX_ROWS = 20_000;
let dataVersion = Number(selectHistoryVersion.get()?.version || 1);
let lastDataVersionCheckAt = 0;
export function getDataVersion() {
  const checkedAt = Date.now();
  if (checkedAt - lastDataVersionCheckAt >= CACHE_VERSION_POLL_MS) {
    lastDataVersionCheckAt = checkedAt;
    const shared = Number(selectHistoryVersion.get()?.version || 1);
    if (shared > dataVersion) dataVersion = shared;
  }
  return dataVersion;
}
// Which caller advanced a given generation, for the rebuild telemetry in
// cacheTelemetry.js. A version can also move without any call here - a
// canonical SQLite write advances it by trigger, and another process advances
// it independently - so an unlabelled generation is reported as "observed"
// rather than guessed at.
const DATA_VERSION_TRIGGER_LIMIT = 64;
const dataVersionTriggers = new Map();
function noteDataVersionTrigger(version, reason) {
  const label = String(reason || "").trim();
  if (!label) return;
  dataVersionTriggers.set(version, label);
  if (dataVersionTriggers.size > DATA_VERSION_TRIGGER_LIMIT) {
    const oldest = dataVersionTriggers.keys().next().value;
    dataVersionTriggers.delete(oldest);
  }
}
// Resume-position writes advance this instead of the shared history generation.
// No history-derived cache reads playback_progress, so rebuilding them for a
// resume ping was pure waste: with a dashboard open during playback it spent
// 21.9% of wall clock rebuilding on a 7,458-row library and 46.8% on a 90,000-row
// one. The browser still learns about the change through the aggregate in
// getHistoryCacheVersion(), so resume positions refresh exactly as before.
export function getProgressVersion() {
  return Number(selectProgressVersion.get()?.version || 1);
}

export function latestLiveChangeId() {
  return Number(selectLatestLiveChangeId.get()?.id || 0);
}

export function liveChangesSince(cursor = 0, limit = 5000) {
  const safeCursor = Math.max(Number(cursor) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10_000);
  const rows = selectLiveChangesAfter.all(safeCursor, safeLimit);
  const now = Date.now();
  if (now - lastLiveChangePruneAt >= LIVE_CHANGE_PRUNE_INTERVAL_MS) {
    lastLiveChangePruneAt = now;
    pruneLiveChangesByAge.run(now - LIVE_CHANGE_RETENTION_MS);
    pruneLiveChangesByCount.run(LIVE_CHANGE_MAX_ROWS);
  }
  return rows;
}

export function dataVersionTrigger(version) {
  return dataVersionTriggers.get(version) || "observed";
}

export function bumpDataVersion(reason = "") {
  const sharedBeforeBump = Number(selectHistoryVersion.get()?.version || 1);
  // Canonical SQLite writes advance the version atomically via triggers. Adopt
  // that generation instead of double-bumping, which preserves the safe
  // one-row cache carry-forward optimization. File-only changes still need an
  // explicit increment below.
  if (sharedBeforeBump > dataVersion) {
    dataVersion = sharedBeforeBump;
    lastDataVersionCheckAt = Date.now();
    noteDataVersionTrigger(dataVersion, reason);
    return dataVersion;
  }
  const row = bumpHistoryVersion.get(Date.now());
  dataVersion = Math.max(dataVersion + 1, Number(row?.version || 1));
  lastDataVersionCheckAt = Date.now();
  noteDataVersionTrigger(dataVersion, reason);
  return dataVersion;
}

export function refreshDataVersion() {
  lastDataVersionCheckAt = 0;
  return getDataVersion();
}

export function getDiscoverVersion() {
  return Number(selectDiscoverVersion.get()?.version || 1);
}

export function bumpDiscoverVersion() {
  return Number(bumpDiscoverVersionStmt.get(Date.now())?.version || 1);
}

export function getUpNextVersion() {
  return Number(selectUpNextVersion.get()?.version || 1);
}

export function bumpUpNextVersion() {
  return Number(bumpUpNextVersionStmt.get(Date.now())?.version || 1);
}

// JSON column helpers -------------------------------------------------------
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function now() {
  return Date.now();
}

// Run a function inside a single transaction.
export function transaction(fn) {
  return db.transaction(fn)();
}

const insertAuditLog = db.prepare(
  "INSERT INTO audit_log (ts, action, actor_ip, detail) VALUES (?, ?, ?, ?)"
);
export function writeAuditLog(action, { ip = null, detail = null } = {}) {
  try {
    insertAuditLog.run(Date.now(), String(action), ip ?? null, detail ? JSON.stringify(detail) : null);
  } catch { /* audit failures must never break the primary flow */ }
}
