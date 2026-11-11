import { WebSocket } from "undici";
import { assertSafeOutboundUrl } from "./outbound.js";

// Plex Media Server pushes real-time notifications over a WebSocket at
// `/:/websockets/notifications`. Unlike the webhook (which only fires for playback
// events), this stream reports library item changes. On Plex 1.43 a client marking an
// item watched/unwatched arrives as a `library.refresh.items` activity frame (see
// parsePlexNotificationRatingKeys), not as a `timeline` frame.
// We use it to detect unwatch events the webhook can never deliver, then verify the
// actual view state with a targeted metadata lookup before propagating.
//
// This module is pure transport: it connects, reconnects with backoff, filters timeline
// entries down to watchable items and TV containers, debounces per ratingKey, and hands
// each changed ratingKey to `onLibraryItemChange`. The caller expands show/season
// containers into episodes before applying state. All DB/config/propagation logic lives
// in the caller.
//
// Reverse proxies in front of Plex (Cloudflare, nginx, Traefik, etc.) commonly drop an
// idle WebSocket after a timeout without ever sending a close frame - the socket then
// looks open to us forever but never delivers another message. undici's WebSocket only
// exposes the plain browser surface (no ping/pong control), so there's no way to probe
// liveness directly. Instead an idle watchdog forces a reconnect if no frame has arrived
// within IDLE_WATCHDOG_MS, which self-heals a silently-dead connection.

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const DEBOUNCE_MS = 2500;
const IDLE_WATCHDOG_MS = 5 * 60 * 1000;
const WATCHDOG_CHECK_INTERVAL_MS = 30_000;
const ACTIVITY_BURST_LIMIT = 50;
const ACTIVITY_BURST_WINDOW_MS = 60_000;

// Plex TimelineEntry.type: 1 = movie, 2 = show, 3 = season, 4 = episode.
const WATCH_STATE_TIMELINE_TYPES = new Set([1, 2, 3, 4]);
const LIBRARY_IDENTIFIER = "com.plexapp.plugins.library";

function buildNotificationsUrl(baseUrl, token, clientIdentifier = "") {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/:/websockets/notifications";
  url.search = "";
  // Unlike the HTTP clients (which send X-Plex-Token as a header), the token must
  // stay in the URL here: the WebSocket handshake API offers no way to set custom
  // headers, and Plex's notification socket only reads the query parameter.
  url.searchParams.set("X-Plex-Token", token);
  if (clientIdentifier) url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier);
  return url.toString();
}

// One-shot connectivity probe used by the System Integrity Check. Opens the notification
// socket exactly the way the listener does and resolves as soon as it connects - proving
// the full path works end to end (including any reverse proxy / Cloudflare WebSocket
// upgrade in front of Plex). Never throws; always resolves to a result object.
export async function probePlexNotificationSocket({ baseUrl, token, clientIdentifier = "", timeoutMs = 8000 } = {}) {
  if (!baseUrl || !token) {
    return { ok: false, error: "Plex URL or token not provided" };
  }

  let wsUrl;
  try {
    // The WebSocket does not go through fetchWithTimeout, so apply the same URL guard here.
    assertSafeOutboundUrl(baseUrl, { label: "Plex URL" });
    wsUrl = buildNotificationsUrl(baseUrl, token, clientIdentifier);
  } catch (error) {
    return { ok: false, error: `Invalid Plex URL: ${error?.message || error}` };
  }

  const started = Date.now();
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    return { ok: false, error: `Failed to open socket: ${error?.message || error}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.onopen = ws.onerror = ws.onclose = null;
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `Timed out after ${timeoutMs}ms (no WebSocket upgrade - check reverse proxy)` }),
      timeoutMs,
    );

    ws.onopen = () => finish({ ok: true, elapsedMs: Date.now() - started });
    ws.onerror = (event) =>
      finish({ ok: false, error: event?.error?.message || event?.message || "WebSocket connection failed" });
    ws.onclose = (event) =>
      finish({ ok: false, error: `Socket closed before connecting${event?.code ? ` (code ${event.code})` : ""}` });
  });
}

function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  try {
    return Buffer.from(data).toString("utf8");
  } catch {
    return "";
  }
}

// Plex's own websocket also emits a "playing" notification the instant a session
// starts, pauses, resumes, or stops (and periodically while it keeps playing). It
// carries no more than the session's ratingKey/state, not full item metadata, so
// it isn't parsed into a session here - it's only used as a signal that something
// changed right now, to wake up the live session poller instead of waiting for its
// own timer (see liveSessionPoller.js).
export function isPlexPlayingNotification(raw) {
  let payload;
  try {
    payload = JSON.parse(decodeFrame(raw));
  } catch {
    return false;
  }
  return payload?.NotificationContainer?.type === "playing";
}

// Splits a frame's ratingKeys by where they came from: a timeline entry, or the ended
// library.refresh.items activity (which a bulk metadata refresh also produces, so the
// listener rate-limits it separately).
function extractPlexNotificationKeys(raw) {
  let payload;
  try {
    payload = JSON.parse(decodeFrame(raw));
  } catch {
    return { timeline: [], activity: [] };
  }
  const container = payload?.NotificationContainer;
  if (!container) return { timeline: [], activity: [] };

  const keys = [];
  const activityKeys = [];

  if (container.type === "timeline") {
    const rawEntries = container.TimelineEntry;
    const entries = Array.isArray(rawEntries)
      ? rawEntries
      : rawEntries && typeof rawEntries === "object"
      ? [rawEntries]
      : [];
    for (const entry of entries) {
      if (entry.identifier && entry.identifier !== LIBRARY_IDENTIFIER) continue;
      if (!WATCH_STATE_TIMELINE_TYPES.has(Number(entry.type))) continue;
      const ratingKey = String(entry.itemID ?? entry.ratingKey ?? "").trim();
      if (ratingKey) keys.push(ratingKey);
    }
  }

  // Plex 1.43 never sends a `timeline` frame for a watched/unwatched flag change. A
  // client's Mark as watched/unwatched (a plain /:/scrobble or /:/unscrobble call) instead
  // surfaces as one `activity` frame of type library.refresh.items per item, whose
  // Context.key is the item's metadata path, with event "ended" when it finishes. Only the
  // "ended" frame is used: the started/updated frames repeat the same key four times.
  // The handler verifies the real view state with a metadata lookup, so a refresh that did
  // not change the watched flag is a harmless no-op re-check.
  if (container.type === "activity") {
    const rawActivities = container.ActivityNotification;
    const activities = Array.isArray(rawActivities)
      ? rawActivities
      : rawActivities && typeof rawActivities === "object"
      ? [rawActivities]
      : [];
    for (const notification of activities) {
      if (notification?.event !== "ended") continue;
      if (notification.Activity?.type !== "library.refresh.items") continue;
      const match = /^\/library\/metadata\/(\d+)$/.exec(String(notification.Activity?.Context?.key || ""));
      if (match) activityKeys.push(match[1]);
    }
  }

  return { timeline: [...new Set(keys)], activity: [...new Set(activityKeys)] };
}

export function parsePlexNotificationRatingKeys(raw) {
  const { timeline, activity } = extractPlexNotificationKeys(raw);
  return [...new Set([...timeline, ...activity])];
}

// A burst of notifications (e.g. Plex announcing a large batch of changes right as
// the socket connects or reconnects, which happens on every process restart) debounces
// down to one timer per ratingKey, but every timer previously fired its handler
// immediately and unboundedly - hundreds of concurrent handlers each doing metadata
// fetches, playstate lookups, and possibly full unwatch propagation to every connected
// platform was severe enough in practice to spike memory and get the process killed.
// This caps how many handlers run at once; the rest wait in a queue instead of all
// firing at the same moment.
const MAX_CONCURRENT_HANDLERS = 2;

export function createPlexNotificationListener({ getPlexConfig, onLibraryItemChange, onPlaySessionActivity, logger = console.log, socketFactory = (url) => new WebSocket(url) }) {
  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let attempt = 0;
  let lastActivityAt = 0;
  let connecting = false;
  let connectionGeneration = 0;
  const pending = new Map(); // ratingKey -> debounce timeout
  const handlerQueue = [];
  let activeHandlers = 0;
  let activityWindowStartedAt = 0;
  let activityKeysInWindow = 0;
  let activityBurstLogged = false;

  function drainHandlerQueue() {
    while (activeHandlers < MAX_CONCURRENT_HANDLERS && handlerQueue.length > 0) {
      const ratingKey = handlerQueue.shift();
      activeHandlers += 1;
      Promise.resolve()
        .then(() => onLibraryItemChange(ratingKey))
        .catch((error) => logger(`Plex notifications: handler failed for ${ratingKey}: ${error?.message || error}`))
        .finally(() => {
          activeHandlers -= 1;
          drainHandlerQueue();
        });
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (stopped || !socket) return;
      if (Date.now() - lastActivityAt > IDLE_WATCHDOG_MS) {
        logger(`Plex notifications: no activity for ${Math.round(IDLE_WATCHDOG_MS / 1000)}s, recycling the connection (a reverse proxy may have silently dropped it)`);
        closeSocket();
        connect();
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function closeSocket() {
    if (!socket) return;
    const stale = socket;
    socket = null;
    try {
      stale.onopen = stale.onmessage = stale.onclose = stale.onerror = null;
      stale.close();
    } catch {
      /* ignore */
    }
  }

  function flushPending() {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    handlerQueue.length = 0;
  }

  function debounce(ratingKey) {
    if (pending.has(ratingKey)) clearTimeout(pending.get(ratingKey));
    pending.set(
      ratingKey,
      setTimeout(() => {
        pending.delete(ratingKey);
        handlerQueue.push(ratingKey);
        drainHandlerQueue();
      }, DEBOUNCE_MS),
    );
  }



function handleFrame(raw, onPlaySessionActivity) {
  lastActivityAt = Date.now();
  if (onPlaySessionActivity && isPlexPlayingNotification(raw)) {
    try {
      onPlaySessionActivity();
    } catch (error) {
      logger(`Plex notifications: onPlaySessionActivity handler failed: ${error?.message || error}`);
    }
  }
  const { timeline, activity } = extractPlexNotificationKeys(raw);
  for (const ratingKey of timeline) debounce(ratingKey);
  for (const ratingKey of activity) {
    if (activityKeyAllowed()) debounce(ratingKey);
  }
}

// A library-wide metadata refresh in Plex sends one ended library.refresh.items frame
// per item. Allow a normal run of manual marks (ACTIVITY_BURST_LIMIT items per window)
// and drop the rest of a burst; the adaptive poller and the scheduled scans still catch
// any watch change that was dropped.
function activityKeyAllowed() {
  const now = Date.now();
  if (now - activityWindowStartedAt >= ACTIVITY_BURST_WINDOW_MS) {
    activityWindowStartedAt = now;
    activityKeysInWindow = 0;
    activityBurstLogged = false;
  }
  activityKeysInWindow += 1;
  if (activityKeysInWindow <= ACTIVITY_BURST_LIMIT) return true;
  if (!activityBurstLogged) {
    activityBurstLogged = true;
    logger(`Plex notifications: more than ${ACTIVITY_BURST_LIMIT} item refreshes in ${Math.round(ACTIVITY_BURST_WINDOW_MS / 1000)}s (a bulk metadata refresh); ignoring the rest of this burst, the poller still catches watch changes`);
  }
  return false;
}

  async function connect() {
    if (stopped || socket || connecting) return;
    const generation = ++connectionGeneration;
    connecting = true;
    clearReconnect();

    let config;
    try {
      config = await getPlexConfig();
    } catch (error) {
      if (generation !== connectionGeneration || stopped) return;
      connecting = false;
      logger(`Plex notifications: failed to load config: ${error?.message || error}`);
      scheduleReconnect();
      return;
    }
    if (generation !== connectionGeneration || stopped) return;
    connecting = false;

    if (!config?.baseUrl || !config?.token || config.disabled) {
      // Plex not configured (or disabled) yet - back off and re-check later. A settings
      // save calls restart() which retries immediately.
      scheduleReconnect();
      return;
    }

    let ws;
    try {
      ws = socketFactory(buildNotificationsUrl(config.baseUrl, config.token, config.clientIdentifier));
    } catch (error) {
      logger(`Plex notifications: failed to open socket: ${error?.message || error}`);
      scheduleReconnect();
      return;
    }

    socket = ws;
    let openedAt = 0;
    ws.onopen = () => {
      if (socket !== ws) return;
      openedAt = Date.now();
      lastActivityAt = Date.now();
      logger("Plex notifications: connected");
    };
    ws.onmessage = (event) => {
      if (socket === ws) handleFrame(event.data, onPlaySessionActivity);
    };
    ws.onerror = (event) => {
      if (socket !== ws) return;
      logger(`Plex notifications: socket error: ${event?.error?.message || event?.message || "unknown"}`);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      if (openedAt && Date.now() - openedAt >= 30_000) attempt = 0;
      socket = null;
      if (!stopped) {
        logger("Plex notifications: socket closed, scheduling reconnect");
        scheduleReconnect();
      }
    };
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      lastActivityAt = Date.now();
      startWatchdog();
      connect();
    },
    stop() {
      stopped = true;
      connectionGeneration++;
      connecting = false;
      clearReconnect();
      clearWatchdog();
      flushPending();
      closeSocket();
    },
    // Re-evaluate config and reconnect. Called after a settings save so a newly added
    // or changed Plex server/token is picked up without a process restart.
    restart() {
      if (stopped) {
        this.start();
        return;
      }
      clearReconnect();
      attempt = 0;
      connectionGeneration++;
      connecting = false;
      lastActivityAt = Date.now();
      closeSocket();
      connect();
    },
  };
}
