import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { createStream } from "rotating-file-stream";
import { rateLimit } from "express-rate-limit";
import { setGlobalDispatcher, Agent } from "undici";
import { loadLocalEnv } from "./src/env.js";
import { installProcessErrorHandlers } from "./src/utils/processErrorHandlers.js";
import { brandEnv, logLegacyEnvNames } from "./src/utils/brandEnv.js";

loadLocalEnv();
logLegacyEnvNames();

const { createInstanceId, resolveProcessRole, roleHasWeb, roleHasWorker } = await import("./src/utils/processRole.js");
const ROLE = resolveProcessRole();
const INSTANCE_ID = createInstanceId(ROLE);
process.env.PLEKT_INSTANCE_ID = INSTANCE_ID;
process.env.ROLE = ROLE;
const { isDemoMode } = await import("./src/utils/demoMode.js");
const DEMO_MODE = isDemoMode();
const { createTraksProxyHandler } = await import("./src/utils/traksProxy.js");

// Public-demo analytics must never be enabled on self-hosted installs.
const TRAKS_CONFIG = DEMO_MODE
  ? {
    enabled: true,
    scriptUrl: "https://plembfin-traks-collect.lasikie.workers.dev/t.js",
    siteKey: "pb_live_z70rk17kytof4pd9ejy1ovl6",
    collectorOrigin: "https://plembfin-traks-collect.lasikie.workers.dev",
  }
  : { enabled: false, scriptUrl: "/t", siteKey: "", collectorOrigin: "" };

const ANALYTICS_CONFIG = {
  enabled: TRAKS_CONFIG.enabled,
  traks: {
    enabled: TRAKS_CONFIG.enabled,
    scriptUrl: TRAKS_CONFIG.scriptUrl,
    siteKey: TRAKS_CONFIG.siteKey,
  },
};

const { DATA_DIR, DB_PATH, PUBLIC_DIR, MEDIA_DIR, ensureDataDirs } = await import("./src/paths.js");
if (path.basename(DB_PATH) === "plembfin.db" && fs.existsSync(path.join(DATA_DIR, "plekt.db"))) {
  console.warn(`[config] Both plembfin.db and plekt.db exist in ${DATA_DIR}. Using plembfin.db; move one of them away to choose which database is used.`);
}
const { dispatch } = await import("./src/index.js");
const { db } = await import("./src/db.js");
const { enableTmdbMetadataWarmup } = await import("./src/utils/tmdbGateway.js");
const { clearRestoreSyncState, loadMediaConfig, loadRuntimeState, RESTORE_KIND_FULL_SYNC } = await import("./src/utils/configStore.js");
const { createCspImageOriginMemo, createHttpTimingMiddleware, createResponseCompression, setPublicAssetCacheHeaders } = await import("./src/utils/httpPerformance.js");
const { restoreMissingCachedArtwork } = await import("./src/utils/posterCache.js");
const { recoverInterruptedBackgroundImports } = await import("./src/utils/onboardingStore.js");
const { schedulerLeaseStatus } = await import("./src/utils/schedulerLease.js");
const { createWorkerCoordinator } = await import("./src/workerCoordinator.js");
const { flushPending: flushDiagnosticLogs } = await import("./src/utils/diagnosticLogger.js");
const { startCacheWarmup, stopCacheWarmup } = await import("./src/utils/cacheWarmup.js");
const { runWebhookPortCheck } = await import("./src/utils/webhookPortCheck.js");

ensureDataDirs();
if (!DEMO_MODE) enableTmdbMetadataWarmup();

// One-shot cleanup of provider rows the Up Next feature no longer polls. They
// can never be refreshed or expired by a feed generation, so nothing else
// removes them.
if (roleHasWeb(ROLE)) {
  const { purgeUnsupportedUpNextProviders } = await import("./src/utils/upNextRepository.js");
  try {
    purgeUnsupportedUpNextProviders();
  } catch (error) {
    console.warn("Failed to purge unsupported Up Next provider rows", error);
  }
}

if (roleHasWeb(ROLE)) {
  const recoveredImports = recoverInterruptedBackgroundImports();
  if (recoveredImports.recovered.length) {
    console.warn("Cancelled background imports interrupted by server restart", {
      providers: recoveredImports.recovered,
    });
  }
}

// Full Sync Watchstates is driven by browser requests, so it cannot survive a
// process restart. Clear only the tagged full-sync guard here; backup restores
// have their own kind and must remain protected across web-process startup.
if (roleHasWeb(ROLE)) {
  const runtime = await loadRuntimeState().catch(() => ({}));
  const restoreKind = String(runtime.restoreSyncKind || "");
  const legacyFullSync = runtime.restoreSyncActive === true
    && !restoreKind
    && /^[a-zA-Z0-9_-]{8,100}$/.test(String(runtime.restoreSyncRunId || ""));
  const interruptedRestore = (restoreKind === RESTORE_KIND_FULL_SYNC || legacyFullSync)
    ? await clearRestoreSyncState({
      ...(legacyFullSync ? {} : { expectedKind: RESTORE_KIND_FULL_SYNC }),
      reason: "Full Sync Watchstates was interrupted by a server restart.",
    }).catch(() => ({ reset: false }))
    : { reset: false };
  if (interruptedRestore.reset) {
    console.warn("Cleared interrupted Full Sync Watchstates restore after server restart", {
      runId: interruptedRestore.runId,
    });
  }
}

const LOGS_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
// Interval rotation only fires while a process stays alive across the boundary,
// so a restart-heavy install never rotated and access.log grew without limit.
// The size cap makes maxFiles effective regardless of uptime.
const accessLogStream = DEMO_MODE
  ? { write() {} }
  : createStream(ROLE === "all" ? "access.log" : `access-${ROLE}-${process.pid}.log`, {
    interval: "1d",
    size: "10M",
    path: LOGS_DIR,
    maxFiles: 14,
  });

// Keep upstream connections (Plex/Emby/Jellyfin/TMDB) warm.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 15000, connections: 64 }));

const PORT = Number(process.env.PORT || 5056);
const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const app = express();
app.disable("x-powered-by");
// Request timing is deliberately opt-in for diagnosing the performance plan's
// localhost stalls. It logs only slow/error responses and includes event-loop
// delay, so normal deployments do not add per-request telemetry overhead.
app.use(createHttpTimingMiddleware());
// Settings and integration status are mutable application state. Do not let a
// browser revalidate an old JSON response and turn a saved connection into a
// stale/default-looking form after a refresh.
app.disable("etag");
// The public demo is served through one Cloudflare reverse-proxy hop. Trusting
// that hop lets rate-limit middleware use the visitor address from
// X-Forwarded-For instead of treating every visitor as the same edge IP.
if (DEMO_MODE || process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
const mediaConfigRevisionStmt = db.prepare("SELECT updated_at FROM settings WHERE id = 'mediaConfig'");
const getCspImageOrigins = createCspImageOriginMemo({
  readRevision: () => Number(mediaConfigRevisionStmt.get()?.updated_at || 0),
  loadConfig: () => loadMediaConfig({ resolveConnections: false }),
});

function redactedUrl(req) {
  try {
    const url = new URL(req.originalUrl || req.url || "", "http://localhost");
    for (const key of [...url.searchParams.keys()]) {
      if (/token|api[_-]?key|secret|password|authorization/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(req.originalUrl || req.url || "").replace(/([?&](?:token|api[_-]?key|secret|password|authorization)=)[^&\s"]+/gi, "$1redacted");
  }
}

morgan.token("safe-url", redactedUrl);
// Successful cached-artwork and static-asset hits dominate the access log by an
// order of magnitude and carry no diagnostic value. Failures still get logged.
const ACCESS_LOG_SKIP_PATHS = /^\/(?:media\/|modules\/|favicon|.*\.(?:css|js|png|jpe?g|svg|webp|ico|woff2?)$)/i;
// Front-end pollers that fire on a fixed timer for as long as a tab is open.
// They were the top three entries in the access log and say nothing useful
// about what the app did.
const ACCESS_LOG_SKIP_POLLS = new Set(["/api/ping", "/api/now-playing", "/api/diagnostic-logs"]);
function skipAccessLog(req, res) {
  if (DEMO_MODE) return true;
  if (res.statusCode >= 400) return false;
  const requestPath = String(req.path || req.url || "").split("?")[0];
  if (ACCESS_LOG_SKIP_POLLS.has(requestPath)) return true;
  return ACCESS_LOG_SKIP_PATHS.test(requestPath);
}
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', { stream: accessLogStream, skip: skipAccessLog }));
app.use(cookieParser());

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
if (!COOKIE_SECURE) {
  console.warn("[security] COOKIE_SECURE is not set - session cookies will not have the Secure flag. Set COOKIE_SECURE=true when running behind HTTPS.");
}

// HTTP security headers.
app.use(async (_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  let contentSecurityPolicy;
  if (DEMO_MODE) {
    // Only the demo analytics collector may load scripts and receive events.
    const analyticsOrigin = TRAKS_CONFIG.enabled ? ` ${TRAKS_CONFIG.collectorOrigin}` : "";
    contentSecurityPolicy = `default-src 'self'; img-src 'self' data: blob:; script-src 'self'${analyticsOrigin}; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'${analyticsOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; frame-src 'none';`;
  } else {
    let extraImgSrc = "";
    try {
      const origins = await getCspImageOrigins();
      if (origins.length) {
        extraImgSrc = " " + [...new Set(origins)].join(" ");
      }
    } catch {
      // Fail-safe: ignore configuration errors
    }
    contentSecurityPolicy =
      `default-src 'self'; img-src 'self' data: blob: https://image.tmdb.org https://img.youtube.com https://assets.fanart.tv https://fanart.tv https://artworks.thetvdb.com https://thetvdb.com${extraImgSrc}; ` +
      "script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com;";
  }
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  next();
});

// Compress ordinary HTTP responses in the app when a self-hosted deployment
// has no compressing proxy. The live update stream opts out explicitly; its
// no-transform cache directive remains a second independent safeguard.
app.use(createResponseCompression());

// Rate limiting - applied before any route handler.
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use("/api/webhook", rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-poster", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/tmdb-profile", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
// Interactive provider flows poll read-only status endpoints every two seconds.
// Do not charge those reads to the mutation budget: a normal authorization
// lasting two minutes would otherwise consume all 60 requests and block the
// next start/login attempt with 429. The general API limiter still bounds reads.
const providerMutationLimiter = () => rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use("/api/media-auth", providerMutationLimiter());
app.use("/api/media-connections", providerMutationLimiter());
app.use("/api/tracker-auth", providerMutationLimiter());
app.use("/api/tracker-connections", providerMutationLimiter());
// Destructive/expensive admin actions - several of these paths also serve a
// cheap GET status/poll (e.g. force-sync progress), so only the mutating
// request is throttled; GET/HEAD/OPTIONS pass through untouched.
app.use([
  "/api/delete-media",
  "/api/backup/import",
  "/api/watch-backups",
  "/api/plembfin-backups",
  "/api/force-sync",
  "/api/cron-sync",
  "/api/auth/credentials",
  "/api/full-sync-watchstates",
  "/api/merge-shows",
  "/api/admin-backfill-trakt",
  "/api/admin-fix-history",
  "/api/clear-cache",
  "/api/tautulli/import",
], rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
}));
// General API limiter - generous ceiling so the poster-heavy dashboard/explorer is never
// throttled in normal use, while still capping abusive bursts. Applied after the tighter
// per-route limiters above so those still take precedence for their paths.
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 1200, standardHeaders: true, legacyHeaders: false }));
// The demo asset bundle is deliberately made up of many small immutable files
// (posters, season art, gallery images, cast portraits, and related posters).
// A single valid page crawl can exceed the generic static ceiling, so never
// turn a bundled asset into a 429. API and SPA requests remain rate limited.
const skipBundledDemoAssets = (req) => /^\/demo-assets(?:\/|$)/i.test(String(req.path || ""));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipBundledDemoAssets,
}));

// Capture the raw request body for /api so webhook/JSON handlers can parse it
// themselves (multipart via busboy, JSON via readJson). express.raw sets
// req.body to a Buffer, which the requestBody helpers already understand.
app.get("/analytics-config.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ANALYTICS_CONFIG);
});

// Keep the collector first-party to the demo. Without these routes the SPA
// fallback would return index.html for /t, which makes the browser reject the
// response as tracker JavaScript and no pageview can be sent.
const traksProxyHandler = createTraksProxyHandler({ collectorOrigin: TRAKS_CONFIG.collectorOrigin });
app.all("/t", traksProxyHandler);
app.all("/api/event", express.raw({ type: "*/*", limit: "256kb" }), traksProxyHandler);

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// A backup upload can be over 1 GB; its handler streams the body to disk.
const isStreamedUpload = (req) => /^\/api\/plembfin-backups\/upload\/?$/i.test(String(req.path || ""));
app.all("/api/*path", express.raw({ type: (req) => !isStreamedUpload(req), limit: "15mb" }), (req, res) => {
  Promise.resolve(dispatch(req, res)).catch((error) => {
    console.error("Unhandled API error", error);
    if (res.headersSent) return;
    // Deliberate client errors (e.g. readJson's 400 for a malformed body) keep
    // their status and message; anything unexpected returns a generic 500 so
    // internal details never reach the client. Handlers return promises that
    // dispatch() does not await, so their rejections surface here, not in
    // dispatch()'s own catch.
    const status = error?.code === "RESTORE_ACTIVE" ? 409 : Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ error: error.message || "Request failed", ...(error?.code === "RESTORE_ACTIVE" ? { code: error.code } : {}) });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });
});

// Locally cached posters/backdrops.
app.use("/media", express.static(MEDIA_DIR, { maxAge: "365d", immutable: true }));
// The static mount only answers when the file exists. A missing cached poster
// is downloaded again from its recorded source and redirected to the new file.
// Without this the SPA fallback below answers 200 with index.html, and the
// image shows broken.
app.get("/media/*name", async (req, res) => {
  const storagePath = decodeURIComponent(req.path.slice("/media/".length));
  if (!/^(?:posters|backdrops|profiles|logos)\/[\w.-]+$/.test(storagePath)) return res.status(404).end();
  const url = await restoreMissingCachedArtwork(storagePath).catch(() => null);
  if (!url) return res.status(404).end();
  res.setHeader("Cache-Control", "no-cache");
  res.redirect(302, url);
});
// Bundled app and source icons.
app.use("/icons", express.static(path.join(PUBLIC_DIR, "icons"), { maxAge: "7d" }));

app.get("/changelog.json", (_req, res) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "..", "changelog.json"));
});

// Browsers still probe the conventional path when an installed profile has
// remembered an older favicon. Keep that fallback tiny instead of letting the
// SPA catch-all return the full index document.
app.get("/favicon.ico", (_req, res) => {
  res.type("image/svg+xml").sendFile(path.resolve(PUBLIC_DIR, "favicon.svg"));
});

// The shell only needs the installed version for its sidebar badge. Keep the
// full release history on the Changelog route instead of paying for it on
// every authenticated page.
app.get("/version.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const bundled = JSON.parse(fs.readFileSync(path.resolve(PUBLIC_DIR, "..", "changelog.json"), "utf8"));
    const root = path.resolve(PUBLIC_DIR, "..");
    const hasAlphaFile = fs.existsSync(path.join(root, "changelog.alpha.json"));
    const hasDevelopFile = fs.existsSync(path.join(root, "changelog.develop.json"));
    const envChannel = String(process.env.BUILD_CHANNEL || "").toLowerCase().trim();
    let channel = "release";
    if (["alpha", "develop"].includes(envChannel)) {
      channel = envChannel;
    } else if (!["release", "latest", "stable", "main"].includes(envChannel)) {
      if (hasAlphaFile && !fs.existsSync(path.join(root, "changelog.json"))) channel = "alpha";
      else if (hasDevelopFile && !fs.existsSync(path.join(root, "changelog.json"))) channel = "develop";
    }

    const payload = { version: String(bundled.version || "").trim() || null, channel };
    if (channel === "alpha") {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "changelog.alpha.json"), "utf8"));
      const entry = Array.isArray(manifest.entries) ? manifest.entries[0] : null;
      payload.alphaBuild = {
        build: Number(manifest.build) || 0,
        baseVersion: manifest.baseVersion || null,
        version: entry?.version || manifest.version || null,
        shortVersion: entry?.shortVersion || entry?.version || manifest.version || null,
      };
    } else if (channel === "develop") {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "changelog.develop.json"), "utf8"));
      payload.developBuild = {
        version: String(manifest.version || "").trim() || null,
        build: Number(manifest.build) || 0,
      };
    }
    return res.json(payload);
  } catch {
    return res.status(503).json({ error: "Version unavailable" });
  }
});

app.get("/auth/plex/return", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plex connected</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    background: #05080c;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Outfit, Arial, sans-serif;
  }
  main {
    display: grid;
    justify-items: center;
    gap: 14px;
    max-width: 26rem;
    padding: 2.5rem 2rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    background: rgba(18, 22, 28, 0.55);
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 50%;
    background: color-mix(in srgb, #10b981, transparent 85%);
    color: #10b981;
  }
  .icon svg { width: 1.75rem; height: 1.75rem; }
  h1 { margin: 0; font-size: 1.25rem; }
  p { margin: 0; color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
  .closing { font-size: 0.85rem; color: #64748b; }
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
  </div>
  <h1>Plex connected</h1>
  <p>Plekt is verifying the connection in the original tab.</p>
  <p class="closing">You may close this tab.</p>
</main>
</body>
</html>`);
});

// Health check - must be above the SPA fallback.
app.all(["/health", "/health/"], (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).set("Allow", "GET, HEAD").json({ error: "Method not allowed" });
  }
  const now = Date.now();
  const lease = schedulerLeaseStatus(now);
  res.json({
    ok: true,
    ts: now,
    role: ROLE,
    database: { ok: true },
    worker: {
      available: lease.available,
      leader: lease.available && lease.holderId === INSTANCE_ID,
      heartbeatAgeMs: lease.heartbeatAt ? Math.max(0, now - lease.heartbeatAt) : null,
      lastTickAgeMs: lease.lastTickAt ? Math.max(0, now - lease.lastTickAt) : null,
    },
  });
});

// Static SPA assets, then SPA fallback to index.html for client-side routes.
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders: (res, filePath) => setPublicAssetCacheHeaders(res, filePath, {
    disableCaching: brandEnv("DEV_NO_CACHE_ASSETS") === "1",
  }),
}));
app.get("/*name", (req, res) => {
  // The SPA fallback serves index.html for client-side routes, and bypasses the
  // static setHeaders hook, so it needs the same revalidation rule set here.
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ROLE=web omits this coordinator; ROLE=all preserves the default combined process.
const coordinator = !DEMO_MODE && roleHasWorker(ROLE) ? createWorkerCoordinator({ holderId: INSTANCE_ID, role: ROLE }) : null;
const server = roleHasWeb(ROLE) ? app.listen(PORT, HOST) : null;

server?.on("listening", async () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`plekt listening on http://localhost:${listeningPort}`);
  if (brandEnv("BUILD_CHECK") === "1") {
    server.close((error) => {
      if (error) {
        console.error("Build-check shutdown failed", error);
        process.exitCode = 1;
      }
    });
    return;
  }
  // Only the process that serves pages warms the page caches; a ROLE=worker
  // process has no readers for them.
  startCacheWarmup();
  // Non-blocking: the port advisory never delays startup, and a failed check is logged only.
  runWebhookPortCheck().catch((error) => console.error("Webhook port check failed", error));
  await coordinator?.start().catch((error) => console.error("Failed to start worker coordinator", error));
});

server?.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing Plekt process or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received - shutting down gracefully`);
  const timer = setTimeout(() => {
    console.error("Graceful shutdown timed out - forcing exit");
    process.exit(1);
  }, 5000);
  timer.unref();
  await stopCacheWarmup().catch(() => null);
  await coordinator?.stop().catch((error) => console.error("Worker shutdown failed", error));
  const finish = () => {
    // Persist buffered diagnostics while the database is still open.
    try { flushDiagnosticLogs(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  if (server) server.close(finish);
  else finish();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
installProcessErrorHandlers({ flush: () => flushDiagnosticLogs() });

if (!server) {
  console.log(`plekt worker started (role=${ROLE})`);
  await coordinator?.start();
}
