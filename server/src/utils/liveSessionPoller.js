import { activeSyncOperation, loadMediaConfig, loadRuntimeState, SYNC_OPERATION_SCHEDULED } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { isVerboseLogging } from "./logVerbose.js";
import { refreshLiveSessions } from "./liveSessionCompletion.js";

// Now Playing detection used to be gated entirely by the once-a-minute scheduled-sync
// tick (see docs/now-playing.md): a session starting or ending could take up to 60s to
// show up or clear. This runs refreshLiveSessions() on its own faster, activity-adaptive
// cadence instead - quick while something is actually playing, and no more frequent than
// the old baseline while idle, so it does not add load to Plex/Emby/Jellyfin the rest of
// the time. onPlaySessionActivity in plexNotificationListener.js pokes this poller the
// instant Plex's own "playing" WebSocket notification arrives, and handleNowPlaying pokes
// it when a viewer shows up after a gap - both cases collapse into an immediate re-run of
// the same tick this file already runs on a timer.
const DEFAULT_ACTIVE_INTERVAL_MS = 10_000;
const DEFAULT_IDLE_INTERVAL_MS = 45_000;
const DEFAULT_ERROR_INTERVAL_MS = 30_000;

export function createLiveSessionPoller({ logger = console.log } = {}) {
  let stopped = true;
  let timer = null;
  let running = false;
  let hasActiveSession = false;

  async function tick() {
    if (stopped) return;
    if (running) return;
    running = true;
    let nextDelay = DEFAULT_IDLE_INTERVAL_MS;

    try {
      const runtime = await loadRuntimeState().catch(() => ({}));
      const operation = activeSyncOperation(runtime);
      if (operation && operation.kind !== SYNC_OPERATION_SCHEDULED) {
        // A rebuild/restore/force-sync owns the watch tables right now - don't race it.
        hasActiveSession = false;
      } else {
        const config = await loadMediaConfig().catch(() => null);
        if (config) {
          const loopStore = createLoopStore();
          const trace = isVerboseLogging() ? logger : () => {};
          const result = await refreshLiveSessions(config, loopStore, { logger, trace });
          // Keep polling at the fast interval while a session is still playing, and also
          // while a missed-appearance is awaiting its confirmation poll (see
          // MISSING_LIVE_SESSION_CONFIRMATION_POLLS in scheduled.js) - otherwise the very
          // last active session dropping out would fall back to the slow idle interval
          // right when a prompt second poll is what's needed to confirm it actually ended.
          hasActiveSession = result.currentRows.length > 0 || result.pendingConfirmations > 0;
        } else {
          hasActiveSession = false;
        }
      }
      nextDelay = hasActiveSession ? DEFAULT_ACTIVE_INTERVAL_MS : DEFAULT_IDLE_INTERVAL_MS;
    } catch (error) {
      logger(`Live session poller failed: ${error?.message || error}`);
      hasActiveSession = false;
      nextDelay = DEFAULT_ERROR_INTERVAL_MS;
    } finally {
      running = false;
      scheduleNext(nextDelay);
    }
  }

  function scheduleNext(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      hasActiveSession = false;
      scheduleNext(1000);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    restart() {
      this.stop();
      this.start();
    },
    // Cuts the wait short so the next tick runs almost immediately - used when
    // something external (a Plex WebSocket "playing" notification, or a viewer
    // opening/returning to the Now Playing view) means the current cached state
    // is likely stale right now, without changing the steady-state interval.
    poke() {
      if (stopped || running) return;
      scheduleNext(50);
    },
  };
}
