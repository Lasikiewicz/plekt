import { createHash } from "node:crypto";
import { AsyncLocalStorage } from 'node:async_hooks';
import { createUpstreamTimeoutError, fetchWithTimeout } from "../outbound.js";

const RATE_ERRORS = { rate_limit: "SIMKL_RATE_LIMIT", user_limit_exceeded: "SIMKL_DAILY_LIMIT", app_limit_exceeded: "SIMKL_APP_LIMIT" };
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const zoneDate = (time) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);

// Find the first instant of tomorrow in New York, including 23/25-hour DST days.
export function nextSimklDailyReset(now) {
  const today = zoneDate(now);
  let low = now, high = now + 27 * 3600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (zoneDate(mid) === today) low = mid;
    else high = mid;
  }
  return high;
}

function numeric(value) {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(String(value).trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function simklQuotaMetadata(headers, now = Date.now()) {
  const result = {};
  for (const [header, key] of [["x-ratelimit-limit", "quotaLimit"], ["x-ratelimit-remaining", "quotaRemaining"]]) {
    const value = numeric(headers.get(header));
    if (value !== undefined) result[key] = value;
  }
  const raw = headers.get("retry-after");
  if (raw != null && raw.trim()) {
    const seconds = numeric(raw);
    const date = Date.parse(raw);
    if (seconds !== undefined) result.retryAfter = Math.ceil(seconds);
    else if (Number.isFinite(date)) result.retryAfter = Math.max(0, Math.ceil((date - now) / 1000));
  }
  return result;
}

export function createSimklTransport({ fetcher = fetchWithTimeout, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const states = new Map(), aliases = new Map();
  const budgets=new AsyncLocalStorage();
  function stateFor(scope) {
    const token = scope.accessToken ? `token:${hash(scope.accessToken)}` : null;
    const account = scope.remoteUserId ? `account:${hash(scope.remoteUserId)}` : null;
    const client = `auth:${hash(scope.clientId)}`;
    let state = (account && states.get(account)) || (token && aliases.get(token));
    if (!state) {
      const key = account || token || client;
      state = states.get(key);
      if (!state) states.set(key, state = { tail: Promise.resolve(), next: 0, metadata: {} });
    }
    if (account) states.set(account, state);
    if (token) aliases.set(token, state);
    return state;
  }
  const request = async function(scope, url, options, timeout) {
    const budget=budgets.getStore();
    const state = stateFor(scope);
    const work = state.tail.then(async () => {
      if (state.until > now()) throw Object.assign(new Error("Simkl requests are paused until the quota cooldown ends"), {
        status: 429, code: state.code, ...state.metadata, retryAfter: Math.ceil((state.until - now()) / 1000), resetAt: state.until,
      });
      // Check inside the account's serial HTTP queue. Other callers cannot
      // spend the same observed remainder between a batch's requests.
      if (state.metadataExpiresAt <= now()) state.metadata = {};
      const knownQuota = Number.isSafeInteger(state.metadata.quotaRemaining);
      if(budget&&budget.used>=budget.maxRequests)throw Object.assign(new Error('Simkl verification request limit reached'),{code:'SIMKL_REQUEST_BUDGET',status:429});
      const allowUnknown=options.allowUnknownQuota||budget?.allowUnknownFirst&&budget.used===0;
      let protectedFloor=0;
      // The normal-use floor gates each batch's preflight. Once a batch has
      // POSTed, its readbacks must still run or the outcome becomes uncertain.
      if(budget&&options.reserveCheckpoint)budget.afterPost=false;
      if(budget?.normalReservePolicy&&!budget.afterPost) {
        const policy=budget.normalReservePolicy,limit=state.metadata.quotaLimit;
        if(!Number.isSafeInteger(limit)&&!allowUnknown)throw Object.assign(new Error('Simkl daily allowance is unknown; full sync waits for verified quota'),{code:'SIMKL_QUOTA_UNKNOWN',status:429});
        if(Number.isSafeInteger(limit))protectedFloor=56+(policy.mode==='percent'?Math.ceil(limit*policy.value):policy.value);
      }
      const minimumRemaining=Math.max(options.minimumRemaining||0,budget?.minimumRemaining||0,protectedFloor);
      if (minimumRemaining > 0 && (knownQuota ? state.metadata.quotaRemaining < minimumRemaining : !allowUnknown)) {
        throw Object.assign(new Error("Simkl batch stopped before its quota reserve"), { status: 429, code: "SIMKL_QUOTA_RESERVE", ...state.metadata });
      }
      const wait = Math.max(state.next, options.method === "POST" ? state.nextPost || 0 : 0) - now();
      if (wait > 0) await sleep(wait);
      const started = now();
      state.next = started + (options.method === "POST" ? 1100 : 110);
      if (options.method === "POST") state.nextPost = started + 1100;
      // Exactly one attempt, including writes whose response might be lost.
      if(budget)budget.used++;
      if(budget&&options.method==='POST')budget.afterPost=true;
      const response = await fetcher(url, options, timeout);
      // fetchWithTimeout stops timing at headers; a stalled body must not hold
      // this account's queue forever. A POST timeout stays an uncertain outcome.
      let bodyTimer;
      const data = await Promise.race([
        response.json().catch(() => null),
        new Promise((_, reject) => { bodyTimer = setTimeout(() => reject(createUpstreamTimeoutError(timeout || 20_000)), timeout || 20_000); }),
      ]).catch((error) => { response.body?.cancel().catch(() => {}); throw error; }).finally(() => clearTimeout(bodyTimer));
      const metadata = simklQuotaMetadata(response.headers, now());
      state.metadata = metadata;
      state.metadataExpiresAt = nextSimklDailyReset(now());
      const providerCode = typeof data?.error === "string" ? RATE_ERRORS[data.error] : undefined;
      const daily = providerCode === "SIMKL_DAILY_LIMIT" || providerCode === "SIMKL_APP_LIMIT" || metadata.quotaRemaining === 0;
      const limited = daily || providerCode || response.status === 429;
      if (limited) {
        // Explicit burst errors may carry the daily-reset Retry-After; it does
        // not apply to that short throttle. Preserve it for diagnostics only.
        const burst = providerCode === "SIMKL_RATE_LIMIT" && !daily;
        const until = daily ? nextSimklDailyReset(now()) : now() + (burst ? 1 : Math.max(1, metadata.retryAfter || 1)) * 1000;
        state.until = burst ? until : Math.max(until, now() + (metadata.retryAfter || 0) * 1000);
        state.code = providerCode === "SIMKL_APP_LIMIT" ? providerCode : daily ? "SIMKL_DAILY_LIMIT" : providerCode || "SIMKL_RATE_LIMIT";
        state.metadata = metadata;
        metadata.resetAt = state.until;
      }
      return { response, data, metadata, rateCode: providerCode ? state.code : !response.ok && daily ? state.code : undefined };
    });
    state.tail = work.catch(() => {});
    return work;
  };
  // Offline fixtures must not inherit a previous fixture's account cooldown.
  request.resetForTests = () => {
    if (!process.env.NODE_TEST_CONTEXT) throw new Error("Simkl transport reset is test-only");
    states.clear(); aliases.clear();
  };
  request.quotaFor = scope => {
    const state=scope.remoteUserId&&states.get(`account:${hash(scope.remoteUserId)}`);
    return state&&state.metadataExpiresAt>now()?{...state.metadata}:{};
  };
  request.withBudget=(options,work)=>{
    if(!Number.isSafeInteger(options.maxRequests)||options.maxRequests<1||!Number.isSafeInteger(options.minimumRemaining)||options.minimumRemaining<1)throw new TypeError('A bounded Simkl request budget is required');
    const policy=options.normalReservePolicy;
    if(policy&&!(policy.mode==='percent'&&Number.isFinite(policy.value)&&policy.value>=0&&policy.value<=1||policy.mode==='fixed'&&Number.isSafeInteger(policy.value)&&policy.value>=0))throw new TypeError('Invalid normal-use quota reserve');
    return budgets.run({...options,used:0},work);
  };
  return request;
}

export const simklTransport = createSimklTransport();
