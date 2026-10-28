import { isVerboseLogging } from "./logVerbose.js";
import { refreshTenantLiveSessions } from "./liveSessionTenants.js";

// Now Playing detection used to be gated entirely by the once-a-minute scheduled-sync
// tick (see docs/now-playing.md): a session starting or ending could take up to 60s to
// show up or clear. This runs refreshLiveSessions() on its own faster, activity-adaptive
// cadence instead - quick while something is actually playing, with a five-minute
// idle fallback. Plugins/webhooks provide prompt playback events without continuous
// idle requests. onPlaySessionActivity in plexNotificationListener.js pokes this poller the
// instant Plex's own "playing" WebSocket notification arrives, and handleNowPlaying pokes
// it when a viewer shows up after a gap - both cases collapse into an immediate re-run of
// the same tick this file already runs on a timer.
const DEFAULT_ACTIVE_INTERVAL_MS = 10_000;
const DEFAULT_IDLE_INTERVAL_MS = 300_000;
const DEFAULT_ERROR_INTERVAL_MS = 30_000;

export function createLiveSessionPoller({ logger = console.log, refresh = refreshTenantLiveSessions } = {}) {
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
      const trace = isVerboseLogging() ? logger : () => {};
      const result = await refresh({ logger, trace });
      hasActiveSession = result.hasActiveSession;
      nextDelay = hasActiveSession ? DEFAULT_ACTIVE_INTERVAL_MS : result.failed ? DEFAULT_ERROR_INTERVAL_MS : DEFAULT_IDLE_INTERVAL_MS;
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
