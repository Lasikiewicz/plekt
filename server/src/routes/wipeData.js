import fs from "node:fs";
import nodePath from "node:path";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { db, writeAuditLog, bumpDataVersion } from "../db.js";
import { invalidateHistoryDerivedCaches } from "../utils/dataRepo.js";
import { clearWatchlistRestorePending } from "../utils/personalWatchlistRepository.js";
import { resetAdminAccount } from "../appConfig.js";
import { POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR } from "../paths.js";

// ---------------------------------------------------------------------------
// Wipe data (Settings -> Tools -> Wipe Data)
//
// The history, watchlist, logs, and everything-tracked scopes are deliberately
// limited to tracked watch/sync data only - never settings, connections,
// credentials, or the admin account. The separate "factory" scope is the one
// genuine exception: a real fresh-start reset, requested
// explicitly as its own option, that also clears every remaining table
// (settings, caches, tracker connections, everything except schema_migrations)
// and the on-disk image cache, then resets data/config.json back to a
// pristine, unclaimed install via resetAdminAccount(). That changes the
// session secret, so it also signs out every current session - the response
// still succeeds for this request, but the client is expected to sign out and
// reload once it sees signOutRequired in the response.
//
// Kept as its own route module (rather than folded into maintenance.js, which
// is already near CLAUDE.md's frontend/backend module size limits) so a
// destructive, security-sensitive feature like this stays easy to find and
// review on its own.
// ---------------------------------------------------------------------------

const WIPE_SCOPES = {
  history: {
    label: "Watch History",
    tables: [
      "watch_history",
      "playstate",
      "manual_watch_reviews",
      "playback_progress",
      "active_sessions",
      "live_tracking_cache",
      "tracker_item_state",
      "tracker_play_history",
      "up_next_provider_items",
      "up_next_provider_feed_state",
      "up_next_manual_shows",
    ],
  },
  watchlist: {
    label: "Personal Watchlist",
    tables: [
      "personal_watchlist",
      "personal_watchlist_meta",
      "personal_watchlist_mutations",
      "personal_watchlist_provider_items",
      "personal_watchlist_sync_queue",
      "personal_watchlist_sync_runs",
      "personal_watchlist_activity",
    ],
  },
  logs: {
    label: "Sync History & Logs",
    tables: ["sync_history", "watch_audit_events", "diagnostic_log"],
  },
};
// "all" always means "every table listed above", not a literal third table
// list - keeping it derived avoids the two ever drifting apart.
WIPE_SCOPES.all = {
  label: "Everything Tracked",
  tables: [...new Set([
    ...WIPE_SCOPES.history.tables,
    ...WIPE_SCOPES.watchlist.tables,
    ...WIPE_SCOPES.logs.tables,
  ])],
};
// Every table in schema.sql except schema_migrations (schema-version
// bookkeeping, not user data). Listed explicitly rather than derived, so a
// schema change is caught by a reviewer here instead of silently expanding
// (or shrinking) what a factory reset touches.
WIPE_SCOPES.factory = {
  label: "Everything (Factory Reset)",
  resetAuth: true,
  tables: [
    "show_merge_history",
    "watch_history",
    "playstate",
    "manual_watch_reviews",
    "playback_progress",
    "outbound_state_leases",
    "active_sessions",
    "live_tracking_cache",
    "sync_history",
    "watch_audit_events",
    "runtime_state",
    "settings",
    // The pristine-install detector uses this table to decide whether the
    // instance has already been configured. It must be cleared before
    // resetAdminAccount() runs, or Fresh Start falls back to the login screen.
    "media_connections",
    "loop_keys",
    "media_artwork",
    "season_artwork",
    "poster_cache",
    "tmdb_metadata_cache",
    "tmdb_search_cache",
    "tmdb_season_cache",
    "tmdb_person_cache",
    "recommendation_exclusions",
    "tvdb_metadata_cache",
    "tvdb_season_cache",
    "omdb_cache",
    "fanart_cache",
    "youtube_meta_cache",
    "audit_log",
    "diagnostic_log",
    "cache_versions",
    "scheduler_lease",
    "background_job_logs",
    "background_jobs",
    "sync_plans",
    "tracker_connections",
    "tracker_auth_flows",
    "tracker_item_state",
    "tracker_play_history",
    "personal_watchlist",
    "personal_watchlist_meta",
    "personal_watchlist_mutations",
    "personal_watchlist_provider_items",
    "personal_watchlist_sync_queue",
    "personal_watchlist_sync_runs",
    "personal_watchlist_activity",
    "up_next_provider_items",
    "up_next_provider_feed_state",
    "up_next_manual_shows",
    "up_next_library_items",
  ],
};

function wipeScopeCounts(scope) {
  const def = WIPE_SCOPES[scope];
  if (!def) throw new Error(`Unknown wipe scope: ${scope}`);
  const counts = {};
  let total = 0;
  for (const table of def.tables) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    counts[table] = row.c;
    total += row.c;
  }
  return { scope, label: def.label, tables: counts, total };
}

// Deletes every cached image file on disk - the same three directories
// handleClearCache's "all" type clears - without touching the poster_cache
// table (the caller already deletes that as part of the table wipe).
async function deleteAllCachedImages() {
  let deleted = 0;
  for (const dir of [POSTERS_DIR, BACKDROPS_DIR, PROFILES_DIR]) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        try {
          await fs.promises.unlink(nodePath.join(dir, file));
          deleted++;
        } catch {}
      }
    } catch {}
  }
  return deleted;
}

export async function handleWipeDataPreview(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const preview = Object.keys(WIPE_SCOPES).map((scope) => wipeScopeCounts(scope));
    return sendJson(res, { ok: true, scopes: preview }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Wipe data preview failed", error);
    return sendJson(res, { error: "Wipe data preview failed" }, 500);
  }
}

export async function handleWipeData(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = await readJson(req);
    const scope = String(body?.scope || "").trim();
    const def = WIPE_SCOPES[scope];
    if (!def) return sendJson(res, { error: "scope must be one of: history, watchlist, logs, all, factory" }, 400);
    // A second, explicit typed confirmation from the client - on top of the two
    // confirm dialogs already shown in the browser - so this can never fire from
    // a stray click or a replayed request.
    if (String(body?.confirm || "").trim().toUpperCase() !== "DELETE") {
      return sendJson(res, { error: "Type DELETE to confirm this action" }, 400);
    }

    const before = wipeScopeCounts(scope);
    db.transaction(() => {
      for (const table of def.tables) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    })();

    // The restore gate lives in settings rather than the watchlist tables so a
    // restored local list cannot remain paused after the user explicitly wipes
    // that list. Factory reset removes settings entirely below.
    if (!def.resetAuth && (scope === "watchlist" || scope === "all")) {
      clearWatchlistRestorePending();
    }

    let imagesDeleted = 0;
    if (def.resetAuth) imagesDeleted = await deleteAllCachedImages();

    if (def.tables.includes("watch_history")) {
      await invalidateHistoryDerivedCaches("handleWipeData").catch(() => null);
    } else {
      bumpDataVersion();
    }

    // Reset the admin account after the database wipe (not before), so the
    // onboarding-state re-detection this triggers sees a clean settings
    // table rather than one about to be deleted out from under it.
    if (def.resetAuth) resetAdminAccount();

    writeAuditLog("data.wiped", {
      ip: req.ip || req.socket?.remoteAddress,
      detail: { scope, label: def.label, tables: before.tables, total: before.total, imagesDeleted, resetAuth: Boolean(def.resetAuth) },
    });

    return sendJson(res, {
      ok: true,
      scope,
      label: def.label,
      deleted: before.tables,
      total: before.total,
      imagesDeleted,
      signOutRequired: Boolean(def.resetAuth),
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Wipe data failed", error);
    return sendJson(res, { error: "Wipe data failed" }, 500);
  }
}
