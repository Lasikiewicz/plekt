import { db } from "../db.js";
import { isAuthoritativeRestoreActive, loadMediaConfig } from "./configStore.js";
import { checkDuePlaylistRules, checkPlaylistRule } from "./playlistRuleEngine.js";
import { resolveProcessRole, roleHasWorker } from "./processRole.js";
import { syncAllPlaylists, syncPlaylist } from "./playlistPullEngine.js";
import { convertAllPlaylistShows } from "./playlistShowConversion.js";
import { removeWatchedPlaylistItems } from "./playlistWatched.js";
import { createPerUserState } from "./perUserState.js";

// Plembfin edits sync after a short quiet period, so a burst of adds and
// removals becomes one pass. The scheduled pass picks up app-side changes and
// newly available media at the watchlist sync's default cadence.
export const PLAYLIST_SYNC_DEBOUNCE_MS = 5_000;
export const PLAYLIST_SYNC_INTERVAL_MS = 5 * 60_000;

const hasTargetsStmt = db.prepare("SELECT 1 FROM personal_list_targets WHERE list_id = ? LIMIT 1");
const anyTargetStmt = db.prepare("SELECT 1 FROM personal_list_targets LIMIT 1");

const pending = new Map();
const scheduledCadence = createPerUserState(() => ({ lastScheduledRunAt: 0 }));

export function playlistHasTargets(listId) {
  return Boolean(hasTargetsStmt.get(String(listId || "").trim()));
}

// Returns whether a sync was scheduled. Plembfin-only playlists never sync.
// The per-playlist lock is in-process, so a web-only process leaves the sync
// to the worker's scheduled pass instead of racing it.
export function schedulePlaylistSync(listId, { delayMs = PLAYLIST_SYNC_DEBOUNCE_MS, sync = syncPlaylist, role = resolveProcessRole() } = {}) {
  const id = String(listId || "").trim();
  if (!id || !roleHasWorker(role) || !playlistHasTargets(id)) return false;
  clearTimeout(pending.get(id));
  const timer = setTimeout(() => {
    pending.delete(id);
    if (isAuthoritativeRestoreActive()) return;
    Promise.resolve()
      .then(() => sync(id))
      .catch((error) => console.error(`[playlists] Sync of playlist ${id} failed: ${error?.message || error}`));
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  pending.set(id, timer);
  return true;
}

export function cancelPendingPlaylistSyncs() {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

// Called every scheduler tick; runs a full pass once per interval. Only these
// passes count toward concluding that a playlist was deleted in an app. Show
// items left from before TV playlists held episodes are converted first, in
// Plembfin-only playlists too; a failed conversion retries on the next pass.
// Automatic playlists due their hourly rule check are checked before the
// pass, so the pass pushes the result (decision 36).
async function checkDueRules() {
  return checkDuePlaylistRules({ config: await loadMediaConfig() });
}

export async function runPlaylistSyncScheduler({ now = Date.now(), force = false, syncAll = syncAllPlaylists, convertAll = convertAllPlaylistShows, checkRules = checkDueRules, removeWatched = removeWatchedPlaylistItems } = {}) {
  if (isAuthoritativeRestoreActive()) return { skipped: true, reason: "authoritative-restore-active" };
  const cadence = scheduledCadence();
  if (!force && now - cadence.lastScheduledRunAt < PLAYLIST_SYNC_INTERVAL_MS) return { skipped: true, reason: "not_due" };
  cadence.lastScheduledRunAt = now;
  const converted = await convertAll();
  // "Remove items once watched" runs every pass, before the rule checks, so
  // the push takes watched items out of the apps (decision 55).
  try {
    await removeWatched();
  } catch (error) {
    console.error(`[playlists] Removing watched playlist items failed: ${error?.message || error}`);
  }
  let rules = [];
  try {
    rules = await checkRules();
  } catch (error) {
    console.error(`[playlists] Automatic playlist checks failed: ${error?.message || error}`);
  }
  if (!anyTargetStmt.get()) return { skipped: true, reason: "no_targets", converted: converted.length, rules: rules.length };
  const results = await syncAll();
  return { skipped: false, playlists: results.length, converted: converted.length, rules: rules.length };
}

// Runs an automatic playlist's rule check soon (after a create or a rule
// edit), then syncs it. A web-only process leaves it to the worker's pass,
// which checks playlists never checked first.
export function schedulePlaylistRuleCheck(listId, { role = resolveProcessRole(), check = checkPlaylistRule, sync = syncPlaylist } = {}) {
  const id = String(listId || "").trim();
  if (!id || !roleHasWorker(role)) return false;
  const timer = setTimeout(() => {
    if (isAuthoritativeRestoreActive()) return;
    Promise.resolve()
      .then(async () => check(id, { config: await loadMediaConfig() }))
      .then(() => (playlistHasTargets(id) ? sync(id) : null))
      .catch((error) => console.error(`[playlists] Rule check of playlist ${id} failed: ${error?.message || error}`));
  }, 0);
  timer.unref?.();
  return true;
}
