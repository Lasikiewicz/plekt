// Retry-After accepts either seconds or an HTTP date. Bound provider-controlled
// waits so a malformed/far-future header cannot stall a host indefinitely.
export function retryAfterMs(value, { now = Date.now(), fallbackMs = 1000, maximumMs = 120_000 } = {}) {
  const raw = String(value || "").trim();
  const seconds = raw ? Number(raw) : NaN;
  const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Math.min(maximumMs, Math.max(0, Number.isFinite(parsed) ? parsed : fallbackMs));
}
