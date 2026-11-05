// Shared, hostname-scoped outbound pacing for media servers and providers.
import { retryAfterMs } from "./retryAfter.js";
// The governor is deliberately small: callers await admission, then release
// in a finally block. Credentials and URL paths never enter its telemetry.

const PROFILES = {
  gentle: { sync: { concurrency: 2, intervalMs: 120 }, enrichment: { concurrency: 1, intervalMs: 300 }, interactive: { concurrency: 3, intervalMs: 60 } },
  standard: { sync: { concurrency: 4, intervalMs: 30 }, enrichment: { concurrency: 2, intervalMs: 120 }, interactive: { concurrency: 6, intervalMs: 15 } },
  fast: { sync: { concurrency: 8, intervalMs: 0 }, enrichment: { concurrency: 4, intervalMs: 30 }, interactive: { concurrency: 10, intervalMs: 0 } },
};
const LANES = ["interactive", "sync", "enrichment"];
// Requests from a visible page should get the next available slot ahead of
// work that can safely wait. Keep sync ahead of enrichment so a metadata
// warm-up cannot delay the normal background synchronisation loop either.
const LANE_PRIORITY = { interactive: 0, sync: 1, enrichment: 2 };
const hosts = new Map();
let profile = "standard";

function normalizedLane(lane) { return LANES.includes(lane) ? lane : "sync"; }
function laneConfig(lane) { return PROFILES[profile][normalizedLane(lane)]; }
function hostState(host) {
  if (!hosts.has(host)) hosts.set(host, {
    active: 0,
    lastStartedAt: 0,
    cooldownUntil: 0,
    throttled: 0,
    retries: 0,
    cooldowns: 0,
    requests: 0,
    queued: 0,
    sequence: 0,
    waiters: [],
    pumpTimer: null,
  });
  return hosts.get(host);
}

function waiterSort(a, b) {
  return LANE_PRIORITY[a.lane] - LANE_PRIORITY[b.lane] || a.sequence - b.sequence;
}

function pumpHost(host, state) {
  if (state.pumpTimer) {
    clearTimeout(state.pumpTimer);
    state.pumpTimer = null;
  }

  const now = Date.now();
  let selected = null;
  let nextWakeAt = 0;
  for (const waiter of state.waiters) {
    if (waiter.signal?.aborted) continue;
    const limits = laneConfig(waiter.lane);
    const cooldownReady = state.cooldownUntil <= now;
    const intervalReady = now - state.lastStartedAt >= limits.intervalMs;
    if (state.active < limits.concurrency && cooldownReady && intervalReady) {
      if (!selected || waiterSort(waiter, selected) < 0) selected = waiter;
      continue;
    }

    // A capacity-only wait is woken by releaseSlot. Time-based waits need a
    // single timer for the host; polling once per waiter made a busy sync scan
    // unnecessarily expensive and still did not provide real lane priority.
    if (state.active < limits.concurrency) {
      const eligibleAt = Math.max(
        state.cooldownUntil,
        state.lastStartedAt + limits.intervalMs,
      );
      if (eligibleAt > now && (!nextWakeAt || eligibleAt < nextWakeAt)) nextWakeAt = eligibleAt;
    }
  }

  if (selected) {
    const index = state.waiters.indexOf(selected);
    if (index !== -1) state.waiters.splice(index, 1);
    state.queued = Math.max(0, state.queued - 1);
    selected.signal?.removeEventListener("abort", selected.onAbort);
    state.active += 1;
    state.lastStartedAt = Date.now();
    state.requests += 1;
    let released = false;
    selected.resolve(() => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      pumpHost(host, state);
    });
    // The selected request may be followed by another request that is ready
    // under the current lane's limits. Let pumpHost schedule the next slot and
    // preserve the configured inter-request interval.
    pumpHost(host, state);
    return;
  }

  if (nextWakeAt > now && state.waiters.length) {
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = null;
      pumpHost(host, state);
    }, Math.max(1, nextWakeAt - now));
  }
}

export function configureOutboundGovernor(nextProfile = "standard") {
  profile = PROFILES[nextProfile] ? nextProfile : "standard";
  return profile;
}
export function resetOutboundGovernor() { hosts.clear(); profile = "standard"; }
export function outboundGovernorProfile() { return profile; }

export async function acquireOutboundSlot(hostname, { lane = "sync", signal } = {}) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return () => {};
  const state = hostState(host);
  const normalized = normalizedLane(lane);
  if (signal?.aborted) throw signal.reason || new Error("Outbound request cancelled");

  return new Promise((resolve, reject) => {
    const waiter = {
      lane: normalized,
      signal,
      sequence: state.sequence++,
      resolve,
      reject,
      onAbort: null,
    };
    waiter.onAbort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index === -1) return;
      state.waiters.splice(index, 1);
      state.queued = Math.max(0, state.queued - 1);
      reject(signal.reason || new Error("Outbound request cancelled"));
      pumpHost(host, state);
    };
    state.waiters.push(waiter);
    state.queued += 1;
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    pumpHost(host, state);
  });
}

export function noteOutboundResponse(hostname, status, retryAfter = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host) return;
  const state = hostState(host);
  if (![429, 502, 503, 504].includes(Number(status))) return;
  state.throttled += Number(status) === 429 ? 1 : 0;
  const retryMs = retryAfterMs(retryAfter);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + retryMs);
  state.cooldowns += 1;
}
export function noteOutboundRetry(hostname) { const state = hostState(String(hostname || "").toLowerCase()); state.retries += 1; }
export function outboundGovernorTelemetry() {
  return { profile, destinations: [...hosts.entries()].map(([host, state]) => ({ host, requests: state.requests, throttled: state.throttled, retries: state.retries, cooldowns: state.cooldowns, active: state.active, queued: state.queued, cooldownUntil: state.cooldownUntil || 0, nextEligibleAt: Math.max(state.cooldownUntil || 0, state.lastStartedAt + laneConfig("sync").intervalMs) })) };
}
