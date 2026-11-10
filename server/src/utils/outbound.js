import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { outboundTimeoutMs } from "./tuning.js";
import { acquireOutboundSlot, noteOutboundResponse, configureOutboundGovernor } from "./outboundGovernor.js";
import { isDemoMode } from "./demoMode.js";
import { brandEnv } from "./brandEnv.js";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTBOUND_REDIRECTS = 5;
const OUTBOUND_POLICY_CODES = Object.freeze({
  INVALID_URL: "OUTBOUND_INVALID_URL",
  UNSUPPORTED_SCHEME: "OUTBOUND_UNSUPPORTED_SCHEME",
  CREDENTIALS: "OUTBOUND_CREDENTIALS",
  REDIRECT_BODY: "OUTBOUND_REDIRECT_BODY",
  METADATA: "OUTBOUND_METADATA",
  REDIRECT_LIMIT: "OUTBOUND_REDIRECT_LIMIT",
  DEMO_DISABLED: "OUTBOUND_DEMO_DISABLED",
});

// Keep transport failures safe to show in the UI without leaking a configured
// URL, credential, host name, or upstream stack. The old generic message was
// safe but useless: it erased the one piece of information an operator needs
// first - whether the service refused, reset, or never resolved the request.
const SAFE_NETWORK_FAILURES = Object.freeze({
  ECONNREFUSED: "connection refused",
  ENOTFOUND: "DNS lookup failed",
  EAI_AGAIN: "DNS lookup timed out",
  ETIMEDOUT: "connection timed out",
  ECONNRESET: "connection was reset",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  EPIPE: "connection closed unexpectedly",
});

function safeNetworkFailure(error = {}) {
  const code = String(error?.cause?.code || error?.code || "").trim().toUpperCase();
  if (SAFE_NETWORK_FAILURES[code]) return { code, label: SAFE_NETWORK_FAILURES[code] };

  // Undici normally supplies a cause code, but keep a useful fallback for
  // fetch implementations that only expose TypeError("fetch failed").
  if (String(error?.name || "").toLowerCase() === "typeerror" && /fetch failed/i.test(String(error?.message || ""))) {
    return { code: "FETCH_FAILED", label: "connection failed before the service returned a response" };
  }
  return null;
}

function outboundPolicyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicOutboundPolicyError(code) {
  const messages = {
    [OUTBOUND_POLICY_CODES.INVALID_URL]: "Outbound URL must be valid",
    [OUTBOUND_POLICY_CODES.UNSUPPORTED_SCHEME]: "Outbound URL must use http or https",
    [OUTBOUND_POLICY_CODES.CREDENTIALS]: "Outbound URL must not contain embedded credentials",
    [OUTBOUND_POLICY_CODES.REDIRECT_BODY]: "Cross-origin redirects cannot forward request bodies",
    [OUTBOUND_POLICY_CODES.METADATA]: "Outbound URL targets a blocked metadata endpoint",
    [OUTBOUND_POLICY_CODES.REDIRECT_LIMIT]: "Upstream request exceeded the redirect limit",
    [OUTBOUND_POLICY_CODES.DEMO_DISABLED]: "Outbound requests are disabled in demo mode",
  };
  return messages[code] ? outboundPolicyError(messages[code], code) : null;
}

export function createUpstreamTimeoutError(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const error = new Error(`Upstream request timed out after ${timeoutMs}ms`);
  error.status = 504;
  error.code = "UPSTREAM_TIMEOUT";
  return error;
}

export function boundedFetchTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_FETCH_TIMEOUT_MS;
  if (numeric <= 0) return 1;
  if (numeric > MAX_FETCH_TIMEOUT_MS) return MAX_FETCH_TIMEOUT_MS;
  return Math.trunc(numeric);
}

export function normalizeHttpUrl(value = "", { label = "URL", allowRelativeMedia = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allowRelativeMedia && raw.startsWith("/media/")) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  return url.toString().replace(/\/+$/, "");
}

// Cloud-metadata endpoints (AWS/GCP/Azure/etc.) are the one outbound target that is
// dangerous even in a self-hosted, admin-only context: a tricked request there can leak
// instance credentials. We intentionally do NOT block general private/LAN ranges because
// Plex/Emby/Jellyfin commonly run on localhost or the local network.
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);
// AWS and Azure/GCP (169.254.169.254), AWS ECS task metadata, Alibaba, Oracle, and
// the Azure wire server.
const BLOCKED_IPV4 = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "192.0.0.192",
  "168.63.129.16",
]);
// AWS IPv6 metadata endpoint, as eight 16-bit groups.
const BLOCKED_IPV6_GROUPS = new Set(["fd00:ec2:0:0:0:0:0:254"]);

// Expands an IPv6 literal (no brackets) into eight hex groups, or null when it is
// not one. The URL parser already lowercases and compresses, but accept any valid form.
function ipv6Groups(host) {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const expandIpv4 = (groups) => {
    const last = groups[groups.length - 1];
    if (!last || !last.includes(".")) return groups;
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return [...groups.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const headGroups = expandIpv4(head);
  const tailGroups = expandIpv4(tail);
  if (!headGroups || !tailGroups) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...headGroups, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tailGroups];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

function isBlockedMetadataHost(rawHost) {
  // Trailing dots are the same host in DNS; bracketed IPv6 and case are cosmetic.
  const host = String(rawHost || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_IPV4.has(host)) return true;
  const groups = ipv6Groups(host);
  if (!groups) return false;
  if (BLOCKED_IPV6_GROUPS.has(groups.join(":"))) return true;
  // IPv4 carried inside an IPv6 address: IPv4-mapped (::ffff:a.b.c.d), the deprecated
  // IPv4-compatible form (::a.b.c.d) and the NAT64 prefix (64:ff9b::a.b.c.d).
  const zeroPrefix = groups.slice(0, 5).every((g) => g === "0");
  const mapped = zeroPrefix && (groups[5] === "ffff" || groups[5] === "0");
  const nat64 = groups.slice(0, 6).join(":") === "64:ff9b:0:0:0:0";
  if (mapped || nat64) {
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return BLOCKED_IPV4.has(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

// Compares two server URLs after URL normalization (case of scheme and host,
// default ports, trailing slashes), falling back to exact text when unparsable.
export function sameServerUrl(a, b) {
  const normalize = (value) => {
    const textValue = String(value || "").trim().replace(/\/+$/, "");
    try {
      return new URL(textValue).href.replace(/\/+$/, "");
    } catch {
      return textValue;
    }
  };
  const left = normalize(a);
  return Boolean(left) && left === normalize(b);
}

export function assertSafeOutboundUrl(value, { label = "URL" } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw outboundPolicyError(`${label} must be a valid URL`, OUTBOUND_POLICY_CODES.INVALID_URL);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw outboundPolicyError(`${label} must use http or https`, OUTBOUND_POLICY_CODES.UNSUPPORTED_SCHEME);
  }
  if (url.username || url.password) {
    throw outboundPolicyError(`${label} must not contain embedded credentials`, OUTBOUND_POLICY_CODES.CREDENTIALS);
  }
  if (isBlockedMetadataHost(url.hostname)) {
    throw outboundPolicyError(`${label} targets a blocked metadata endpoint`, OUTBOUND_POLICY_CODES.METADATA);
  }
  return url;
}

function redirectRequestOptions(options, status, fromUrl, toUrl) {
  const redirected = { ...options };
  const method = String(redirected.method || "GET").toUpperCase();
  if ((status === 303 && method !== "GET" && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
    redirected.method = "GET";
    delete redirected.body;
  }

  if (fromUrl.origin !== toUrl.origin) {
    if (redirected.body != null) {
      throw outboundPolicyError("Cross-origin redirects cannot forward request bodies", OUTBOUND_POLICY_CODES.REDIRECT_BODY);
    }
    for (const name of [...toUrl.searchParams.keys()]) {
      if (/authorization|cookie|token|api[-_]?key|secret/i.test(name)) toUrl.searchParams.delete(name);
    }
  }
  if (fromUrl.origin !== toUrl.origin && redirected.headers) {
    const headers = new Headers(redirected.headers);
    for (const name of [...headers.keys()]) {
      if (/authorization|cookie|token|api[-_]?key|secret/i.test(name)) headers.delete(name);
    }
    redirected.headers = headers;
  }
  return redirected;
}

async function fetchFollowingSafeRedirects(url, options) {
  let currentUrl = assertSafeOutboundUrl(url, { label: "Outbound URL" });
  let currentOptions = { ...options, redirect: "manual" };

  for (let redirects = 0; redirects <= MAX_OUTBOUND_REDIRECTS; redirects += 1) {
    // The URL and every redirect target are validated immediately above/below. This
    // application deliberately permits configured LAN media servers, while blocking
    // cloud-metadata endpoints and unsafe URL forms at this shared request boundary.
    // CodeQL's js/request-forgery query is excluded repo-wide in
    // .github/codeql/codeql-config.yml for this exact reason - see that file for why.
    const response = await fetch(currentUrl, currentOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_OUTBOUND_REDIRECTS) throw outboundPolicyError("Upstream request exceeded the redirect limit", OUTBOUND_POLICY_CODES.REDIRECT_LIMIT);

    const nextUrl = assertSafeOutboundUrl(new URL(location, currentUrl), { label: "Outbound redirect URL" });
    await response.body?.cancel();
    currentOptions = { ...redirectRequestOptions(currentOptions, response.status, currentUrl, nextUrl), redirect: "manual" };
    currentUrl = nextUrl;
  }

  throw outboundPolicyError("Upstream request exceeded the redirect limit", OUTBOUND_POLICY_CODES.REDIRECT_LIMIT);
}

// Set PLEKT_DEBUG_OUTBOUND=1 to log a per-host outbound request count once
// a minute (visible in Settings → Logs via the diagnostic logger). Useful for
// measuring how much traffic each upstream (TMDB, TVDB, fanart.tv, media
// servers) actually receives before/after a caching change.
const DEBUG_OUTBOUND = ["1", "true"].includes(String(brandEnv("DEBUG_OUTBOUND") || "").toLowerCase());
const outboundCounts = new Map();
let outboundWindowStartedAt = 0;

function trackOutbound(url) {
  if (!DEBUG_OUTBOUND) return;
  let host = "";
  try {
    host = new URL(String(url)).host;
  } catch {
    host = "unparsed";
  }
  const now = Date.now();
  if (!outboundWindowStartedAt) outboundWindowStartedAt = now;
  outboundCounts.set(host, (outboundCounts.get(host) || 0) + 1);
  if (now - outboundWindowStartedAt >= 60_000) {
    const summary = [...outboundCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    console.log(`[outbound] last ${Math.round((now - outboundWindowStartedAt) / 1000)}s: ${summary}`);
    outboundCounts.clear();
    outboundWindowStartedAt = now;
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = undefined) {
  if (isDemoMode() && options.allowDemoAnalytics !== true) {
    const error = outboundPolicyError("Outbound requests are disabled in demo mode", OUTBOUND_POLICY_CODES.DEMO_DISABLED);
    error.status = 503;
    error.expose = true;
    throw error;
  }
  // Explicit overrides are used by a few short interactive and upload calls,
  // but they must remain bounded even if a future caller wires this helper to
  // request data. A long-lived timer is an easy resource-exhaustion footgun.
  const resolvedTimeoutMs = boundedFetchTimeoutMs(timeoutMs ?? outboundTimeoutMs());
  const safeUrl = assertSafeOutboundUrl(url, { label: "Outbound URL" });
  const host = safeUrl.hostname.toLowerCase();
  const metadataHost = /themoviedb|thetvdb|fanart|omdbapi|youtube|googlevideo/i.test(host);
  const lane = options.lane || (metadataHost ? "enrichment" : "sync");
  const releaseSlot = await acquireOutboundSlot(safeUrl.hostname, { lane, signal: options.signal });
  trackOutbound(safeUrl);
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const timeoutError = createUpstreamTimeoutError(resolvedTimeoutMs);
  const timeout = setTimeout(() => controller.abort(timeoutError), resolvedTimeoutMs);
  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  const cleanup = () => {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortFromUpstream);
    controller.signal.removeEventListener("abort", cleanup);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  let responseBodyOwnsTimeout = false;
  try {
    const { lane: _lane, allowDemoAnalytics: _allowDemoAnalytics, ...fetchOptions } = options;
    const response = await fetchFollowingSafeRedirects(safeUrl, { ...fetchOptions, signal: controller.signal });
    noteOutboundResponse(safeUrl.hostname, response.status, response.headers.get("retry-after") || "");
    if (!response.body) return response;

    // Preserve streaming: a caller may use text/json, a reader, or clone().
    // The timer stays attached to the underlying fetch until its body ends or
    // is cancelled, even when a caller abandons an error response unread.
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(stream) {
        try {
          const { value, done } = await reader.read();
          if (done) { cleanup(); stream.close(); }
          else stream.enqueue(value);
        } catch (error) {
          cleanup();
          stream.error(controller.signal.reason === timeoutError ? timeoutError : error);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    timeout.unref?.();
    responseBodyOwnsTimeout = true;
    return wrapped;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutError) throw timeoutError;
    const policyError = publicOutboundPolicyError(error?.code);
    if (policyError) throw policyError;
    if (controller.signal.aborted) {
      const cancelled = new Error("Upstream request cancelled");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    const networkFailure = safeNetworkFailure(error);
    const safeError = new Error(networkFailure
      ? `Upstream request failed (${networkFailure.label})`
      : "Upstream request failed");
    safeError.code = "UPSTREAM_REQUEST_FAILED";
    if (networkFailure) {
      safeError.failureCode = networkFailure.code;
      safeError.failureReason = networkFailure.label;
    }
    throw safeError;
  } finally {
    if (!responseBodyOwnsTimeout) cleanup();
    // The governor limits request starts, not unread responses; callers often
    // discard error bodies, so holding slots here could block a whole host.
    releaseSlot();
  }
}

const UPLOAD_RESPONSE_TEXT_LIMIT = 64 * 1024;

// Streams a local file as a request body with node:http(s). Node's fetch keeps
// every chunk of a streamed body alive until the request ends, which for a
// multi-hundred-MB backup costs as much memory as reading it whole. Same policy
// as fetchWithTimeout (demo mode, URL safety, per-host slot), but no redirects
// are followed, and the timeout restarts whenever a chunk is sent or received,
// so a large file can take as long as it needs while a stalled one still fails.
// Resolves to { ok, status, text } with the response text capped at 64 KB.
export async function uploadFileWithTimeout(url, { method = "PUT", headers = {}, filePath, lane = "sync" } = {}, timeoutMs = undefined) {
  if (isDemoMode()) {
    const error = outboundPolicyError("Outbound requests are disabled in demo mode", OUTBOUND_POLICY_CODES.DEMO_DISABLED);
    error.status = 503;
    error.expose = true;
    throw error;
  }
  const resolvedTimeoutMs = boundedFetchTimeoutMs(timeoutMs ?? outboundTimeoutMs());
  const safeUrl = assertSafeOutboundUrl(url, { label: "Outbound URL" });
  const releaseSlot = await acquireOutboundSlot(safeUrl.hostname, { lane });
  trackOutbound(safeUrl);
  const timeoutError = createUpstreamTimeoutError(resolvedTimeoutMs);
  const file = fs.createReadStream(filePath);
  const transport = safeUrl.protocol === "https:" ? https : http;
  const request = transport.request(safeUrl, { method, headers });
  let timer = null;

  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const restartTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(timeoutError), resolvedTimeoutMs);
      };
      const networkFail = (error) => {
        const networkFailure = safeNetworkFailure(error);
        const safeError = new Error(networkFailure
          ? `Upstream request failed (${networkFailure.label})`
          : "Upstream request failed");
        safeError.code = "UPSTREAM_REQUEST_FAILED";
        if (networkFailure) {
          safeError.failureCode = networkFailure.code;
          safeError.failureReason = networkFailure.label;
        }
        fail(safeError);
      };

      restartTimer();
      file.on("data", restartTimer);
      file.on("error", fail);
      request.on("error", networkFail);
      request.on("response", (response) => {
        restartTimer();
        const chunks = [];
        let kept = 0;
        response.on("data", (chunk) => {
          restartTimer();
          if (kept < UPLOAD_RESPONSE_TEXT_LIMIT) {
            chunks.push(chunk);
            kept += chunk.length;
          }
        });
        response.on("error", networkFail);
        response.on("end", () => {
          clearTimeout(timer);
          noteOutboundResponse(safeUrl.hostname, response.statusCode, response.headers["retry-after"] || "");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            text: Buffer.concat(chunks).toString("utf8").slice(0, UPLOAD_RESPONSE_TEXT_LIMIT),
          });
        });
      });
      file.pipe(request);
    });
  } finally {
    clearTimeout(timer);
    file.destroy();
    // An early answer (an error before the body was sent) or a failure leaves
    // the request unfinished; drop its socket rather than reuse it.
    if (!request.writableFinished) request.destroy();
    releaseSlot();
  }
}

export { configureOutboundGovernor };
