// Provider pacing only. Callers own eligibility, replay policy and durable work.
const TRAKT_RATE_LIMIT_RETRIES = 3;
const TRAKT_WRITE_MIN_INTERVAL_MS = 200;
let traktWriteQueue = Promise.resolve();
let lastTraktWriteStartedAt = 0;

function waitForTraktRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
}

function traktRetryDelayMs(error, attempt) {
  const retryAfterSeconds = Number(error?.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(60_000, Math.max(10, retryAfterSeconds * 1000));
  }
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt)));
}

export async function runTraktWrite(operation) {
  const waitMs = Math.max(0, lastTraktWriteStartedAt + TRAKT_WRITE_MIN_INTERVAL_MS - Date.now());
  if (waitMs) await waitForTraktRetry(waitMs);
  lastTraktWriteStartedAt = Date.now();
  return operation();
}

function enqueueTraktWrite(operation) {
  const run = async () => runTraktWrite(operation);
  const result = traktWriteQueue.then(run, run);
  traktWriteQueue = result.catch(() => {});
  return result;
}

// Preserve bounded 429 retries and one queue slot for each remove/add pair.
export async function withTraktRateLimitRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await enqueueTraktWrite(operation);
    } catch (error) {
      if (Number(error?.status) !== 429 || attempt >= TRAKT_RATE_LIMIT_RETRIES) throw error;
      await waitForTraktRetry(traktRetryDelayMs(error, attempt));
    }
  }
}
