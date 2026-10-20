let activeController = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let lastVersion = null;
let lastDiscoverVersion = null;
let lastUpNextVersion = null;
let visibilityHandler = null;
let resumeHandler = null;
let lockAbortController = null;
let liveChannel = null;

const RECONNECT_MS = 1_000;
// The server writes at least a heartbeat every 15 s. A stream that has been
// silent for three of those is dead (typically a half-open socket after the
// computer slept) even though the browser has not reported an error, so the
// page would otherwise sit on it forever showing stale data.
const STALL_MS = 45_000;
const STALL_CHECK_MS = 5_000;

function progressFromEvent(event, { standalone = false } = {}) {
  const progress = {
    total: Number(standalone ? event.total : event.syncTotal) || 0,
    completed: Number(standalone ? event.completed : event.syncCompleted) || 0,
  };
  // Keep the old callback shape for older servers/events, while forwarding
  // the richer active/label fields emitted by the current live-updates route.
  const activeKey = standalone ? "active" : "syncActive";
  const labelKey = standalone ? "label" : "syncLabel";
  if (activeKey in event) progress.active = event[activeKey] === true;
  if (labelKey in event) progress.label = String(event[labelKey] || "");
  const currentItemKey = standalone && !("currentItemLabel" in event)
    ? "syncCurrentItemLabel"
    : standalone ? "currentItemLabel" : "syncCurrentItemLabel";
  if (currentItemKey in event) progress.currentItemLabel = String(event[currentItemKey] || "");
  const startupKey = standalone && !("startupScanActive" in event)
    ? "syncStartupScanActive"
    : standalone ? "startupScanActive" : "syncStartupScanActive";
  if (startupKey in event) progress.startupScanActive = event[startupKey] === true;
  return progress;
}

function attentionFromEvent(event) {
  if (!("syncAttentionCount" in event) && !("syncAttentionStatus" in event)) return null;
  const count = Math.max(Number(event.syncAttentionCount) || 0, 0);
  return {
    count,
    status: String(event.syncAttentionStatus || (count ? "attention" : "clear")),
  };
}

export function stopLiveUpdates() {
  connectionGeneration += 1;
  activeController?.abort();
  activeController = null;
  lockAbortController?.abort();
  lockAbortController = null;
  liveChannel?.close();
  liveChannel = null;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  visibilityHandler = null;
  if (resumeHandler) {
    window.removeEventListener?.("online", resumeHandler);
    window.removeEventListener?.("pageshow", resumeHandler);
    window.removeEventListener?.("focus", resumeHandler);
  }
  resumeHandler = null;
  lastVersion = null;
  lastDiscoverVersion = null;
  lastUpNextVersion = null;
}

export function startLiveUpdates({ authHeaders, onHistoryVersion, onDiscoverVersion, onUpNextVersion, onResume, onSyncProgress, onSyncAttention, onError, stallMs = STALL_MS, stallCheckMs = STALL_CHECK_MS } = {}) {
  stopLiveUpdates();
  const generation = connectionGeneration;

  // A streaming fetch occupies one HTTP/1.1 connection for the lifetime of
  // the page. Edge/Chromium only permits a small number of connections to one
  // origin, so a handful of background tabs could consume the whole pool and
  // leave their normal API requests queued forever. Keep the stream only in a
  // visible tab; a newly visible tab reconnects and receives the current
  // authoritative version/progress snapshot immediately.
  const isVisible = () => document.visibilityState !== "hidden";
  let lastResumeNotificationAt = 0;
  const notifyResume = (reason) => {
    if (!isVisible()) return;
    const now = Date.now();
    // Browsers commonly emit visibilitychange, focus, and pageshow together
    // when a window is restored. One revalidation is enough for that return.
    if (now - lastResumeNotificationAt < 1_500) return;
    lastResumeNotificationAt = now;
    onResume?.({ reason });
  };

  const scheduleReconnect = () => {
    if (generation !== connectionGeneration || reconnectTimer || !isVisible()) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      requestConnection();
    }, RECONNECT_MS);
  };

  let latestSnapshot = null;
  const consumeEvent = (block, { shared = false } = {}) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    const event = JSON.parse(data);
    if (!shared) {
      latestSnapshot = { ...latestSnapshot, ...event };
      if (event.type === "sync-progress") {
        const progress = progressFromEvent(event, { standalone: true });
        latestSnapshot.syncTotal = progress.total;
        latestSnapshot.syncCompleted = progress.completed;
        for (const field of ["active", "label", "currentItemLabel", "startupScanActive"]) {
          if (field in progress) latestSnapshot[`sync${field[0].toUpperCase()}${field.slice(1)}`] = progress[field];
        }
      }
    }

    const attention = attentionFromEvent(event);
    if (attention) onSyncAttention?.(attention);

    const upNextVersion = Number(event.upNextVersion);
    let upNextVersionChanged = false;
    let upNextVersionInitial = false;
    if (Number.isFinite(upNextVersion)) {
      upNextVersionInitial = lastUpNextVersion === null && (!shared || event.type === "ready");
      upNextVersionChanged = !upNextVersionInitial && upNextVersion !== lastUpNextVersion;
    }

    if (event.type === "sync-progress") {
      onSyncProgress?.(progressFromEvent(event, { standalone: true }));
      return;
    }

    // `ready` carries the authoritative progress snapshot. Apply it before
    // comparing versions so a reconnect cannot start a history refresh using
    // the stale sync-busy state left by the previous stream.
    if ("syncTotal" in event) {
      onSyncProgress?.(progressFromEvent(event));
    }

    const discoverVersion = Number(event.discoverVersion);
    if (Number.isFinite(discoverVersion)) {
      if (lastDiscoverVersion === null) {
        lastDiscoverVersion = discoverVersion;
        onDiscoverVersion?.(discoverVersion, { initial: true });
      } else if (discoverVersion !== lastDiscoverVersion) {
        lastDiscoverVersion = discoverVersion;
        onDiscoverVersion?.(discoverVersion, { initial: false });
      }
    }

    const version = Number(event.version);
    const historyVersionChanged = Number.isFinite(version) && version !== lastVersion
      && (lastVersion !== null || (shared && event.type !== "ready"));
    if (Number.isFinite(version) && lastVersion === null) {
      lastVersion = version;
    } else if (historyVersionChanged) {
      lastVersion = version;
    }

    if (Number.isFinite(upNextVersion)) {
      lastUpNextVersion = upNextVersion;
      if (upNextVersionInitial || upNextVersionChanged) {
        onUpNextVersion?.(upNextVersion, {
          initial: upNextVersionInitial,
          pairedWithHistory: historyVersionChanged,
        });
      }
    }

    if (!Number.isFinite(version)) {
      if (event.type === "up-next-version" && upNextVersionChanged) return;
      return;
    }
    if (!historyVersionChanged) return;
    // If the server piggybacked sync-progress onto this version bump, apply it
    // first so the client's sync-busy flag is current before onHistoryVersion
    // decides whether to queue a dashboard refresh.
    const changes = Array.isArray(event.changes) ? event.changes : [];
    // A `ready` event with a newer version means this tab reconnected after
    // missing changes (hidden tab, sleep, dropped stream). It carries no
    // change list, so the page must reload its data rather than patch it.
    onHistoryVersion?.(version, { changes, initial: false, reconnect: event.type === "ready", event });
  };

  // Only the lock owner holds an HTTP stream. Relay its public version/status
  // events so other visible windows update without consuming more connections.
  if (typeof globalThis.BroadcastChannel === "function") {
    liveChannel = new BroadcastChannel("plekt-live-updates");
    liveChannel.onmessage = ({ data }) => {
      if (generation !== connectionGeneration || !isVisible()) return;
      if (data?.type === "snapshot-request") {
        if (activeController && latestSnapshot) {
          liveChannel.postMessage({ type: "event", block: `data: ${JSON.stringify({ ...latestSnapshot, type: "ready" })}` });
        }
      } else if (data?.type === "event" && typeof data.block === "string" && !activeController) {
        try { consumeEvent(data.block, { shared: true }); } catch (error) { onError?.(error); }
      }
    };
    liveChannel.postMessage({ type: "snapshot-request" });
  }

  const connect = async () => {
    if (generation !== connectionGeneration || !isVisible() || activeController) return;
    const controller = new AbortController();
    activeController = controller;
    let lastActivityAt = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastActivityAt >= stallMs) controller.abort();
    }, stallCheckMs);
    controller.signal.addEventListener("abort", () => clearInterval(stallTimer), { once: true });
    try {
      const response = await fetch("/api/live-updates", {
        headers: authHeaders?.() || {},
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Live updates failed with ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (generation === connectionGeneration) {
        const { value, done } = await reader.read();
        if (done) break;
        lastActivityAt = Date.now();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          try {
            consumeEvent(block);
            liveChannel?.postMessage({ type: "event", block });
          } catch (error) { onError?.(error); }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") onError?.(error);
    } finally {
      clearInterval(stallTimer);
      if (activeController === controller) activeController = null;
      scheduleReconnect();
    }
  };

  const requestConnection = () => {
    if (generation !== connectionGeneration || !isVisible() || activeController || lockAbortController) return;
    if (!liveChannel || !globalThis.navigator?.locks?.request) {
      connect();
      return;
    }

    // Coordinate across every Plekt tab. Exactly one document owns the
    // long-lived stream; waiting lock requests consume no HTTP connection.
    const controller = new AbortController();
    lockAbortController = controller;
    navigator.locks.request("plembfin-live-updates", { mode: "exclusive", signal: controller.signal }, async () => {
      if (lockAbortController === controller) lockAbortController = null;
      if (generation !== connectionGeneration || !isVisible()) return;
      await connect();
    }).catch((error) => {
      if (error?.name !== "AbortError") onError?.(error);
    }).finally(() => {
      if (lockAbortController === controller) lockAbortController = null;
    });
  };

  visibilityHandler = () => {
    if (generation !== connectionGeneration) return;
    if (!isVisible()) {
      activeController?.abort();
      activeController = null;
      lockAbortController?.abort();
      lockAbortController = null;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      return;
    }
    notifyResume("visibilitychange");
    liveChannel?.postMessage({ type: "snapshot-request" });
    requestConnection();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  // Waking from sleep or regaining the network can leave the old socket
  // half-open without any visibility change. Drop it and reconnect so the
  // `ready` snapshot brings the page up to date straight away.
  resumeHandler = (event) => {
    if (generation !== connectionGeneration || !isVisible()) return;
    // Only a page restored from the back/forward cache holds a stale socket.
    if (event?.type === "pageshow" && !event.persisted) return;
    notifyResume(event?.type || "online");
    if (activeController) {
      activeController.abort();
      return;
    }
    requestConnection();
  };
  window.addEventListener?.("online", resumeHandler);
  window.addEventListener?.("pageshow", resumeHandler);
  window.addEventListener?.("focus", resumeHandler);
  requestConnection();
}
