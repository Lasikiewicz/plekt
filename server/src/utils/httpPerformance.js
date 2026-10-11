import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import compression from "compression";
import { brandEnv } from "./brandEnv.js";

const STATIC_ASSET_EXTENSIONS = /\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?)$/i;

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function mediaImageOrigins(config = {}) {
  const urls = [
    config.plex?.baseUrl || config.plex?.serverUrl,
    config.emby?.baseUrl || config.emby?.serverUrl,
    config.jellyfin?.baseUrl || config.jellyfin?.serverUrl,
    config.seerr?.baseUrl,
  ];
  return [...new Set(urls.map(originFromUrl).filter(Boolean))];
}

// The CSP only needs the configured media-server origins. Keep that projection
// memoized, but key it to the settings row so a save in another same-host role
// invalidates it without making provider-resolution work part of every request.
export function createCspImageOriginMemo({ readRevision, loadConfig }) {
  let cachedRevision = Symbol("empty-csp-cache");
  let cachedOrigins = [];

  return async function getCspImageOrigins() {
    const revision = await readRevision();
    if (Object.is(revision, cachedRevision)) return cachedOrigins;

    const config = await loadConfig();
    cachedOrigins = mediaImageOrigins(config);
    cachedRevision = revision;
    return cachedOrigins;
  };
}

// Keep the index and manifest revalidating: they are how a browser discovers
// that everything else changed, so they must never be cached hard.
//
// Every other public asset is referenced through scripts/asset-versions.js at a
// canonical `?v=<version>` URL, which changes when the release does. A request
// carrying that query is therefore asking for one immutable version of a file
// and can be cached indefinitely; a request without it may be any version, so
// it still has to revalidate.
export function setPublicAssetCacheHeaders(response, filePath, { disableCaching = false } = {}) {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === "index.html" || fileName === "manifest.webmanifest") {
    response.setHeader("Cache-Control", "no-cache");
    return;
  }
  if (!STATIC_ASSET_EXTENSIONS.test(fileName)) return;
  // Local source-mode QA can opt out of immutable asset caching without
  // changing the release cache contract used by deployed builds. This keeps
  // a browser with an older stamped query string from hiding current source
  // changes while the elevated test server is running.
  if (disableCaching) {
    response.setHeader("Cache-Control", "no-store");
    return;
  }
  const versioned = Boolean(String(response.req?.query?.v || "").trim());
  response.setHeader(
    "Cache-Control",
    versioned ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
}

export function createResponseCompression() {
  return compression({
    threshold: 1024,
    filter(request, response) {
      const contentType = String(response.getHeader("Content-Type") || "").toLowerCase();
      if (request.path === "/api/live-updates" || contentType.startsWith("text/event-stream")) return false;
      return compression.filter(request, response);
    },
  });
}

// Opt-in request timing for diagnosing the localhost stalls recorded in the
// application-speed plan. The middleware is inert unless enabled explicitly,
// so normal installs pay no event-loop-monitor or logging cost.
export function createHttpTimingMiddleware({
  enabled = brandEnv("DEBUG_HTTP") === "1",
  thresholdMs = Number(brandEnv("DEBUG_HTTP_THRESHOLD_MS") || 500),
  logger = console.warn,
} = {}) {
  if (!enabled) return (_request, _response, next) => next();

  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let activeRequests = 0;

  const middleware = (request, response, next) => {
    const startedAt = performance.now();
    activeRequests += 1;
    let completed = false;

    const finish = () => {
      if (completed) return;
      completed = true;
      activeRequests = Math.max(0, activeRequests - 1);
      const durationMs = performance.now() - startedAt;
      const status = Number(response.statusCode || 0);
      if (durationMs < thresholdMs && status < 500) return;

      logger({
        event: "http-slow-request",
        method: request.method,
        path: request.path || request.url,
        status,
        durationMs: Math.round(durationMs * 10) / 10,
        activeRequests,
        eventLoopDelayMs: Number.isFinite(eventLoop.mean) ? Math.round((eventLoop.mean / 1e6) * 10) / 10 : 0,
        eventLoopMaxMs: Number.isFinite(eventLoop.max) ? Math.round((eventLoop.max / 1e6) * 10) / 10 : 0,
      });
    };

    response.once("finish", finish);
    response.once("close", finish);
    next();
  };

  // Tests and short-lived diagnostic servers can stop the histogram without
  // reaching into the implementation. Production servers leave it running for
  // the lifetime of the opt-in diagnostic process.
  middleware.stop = () => eventLoop.disable();
  return middleware;
}
