import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

// Regression guard for the application-speed plan's Phase B stall: in the
// combined web + worker process, startup backfills, the first scheduled tick,
// provider pollers, and durable-job polling once competed with the first
// document requests and pushed SPA fallback TTFB to several seconds. This
// boots a real ROLE=all server with the first tick pulled into the request
// window and checks the SPA document keeps answering promptly throughout. The
// bound is deliberately coarse (half the plan's 5 s stall gate) so a loaded
// test machine does not flake it; the timing benchmarks live in docs/benchmarks.

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-spa-fallback-"));
const STALL_BOUND_MS = 2_500;
let child = null;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000).then(() => child.kill())]);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the SPA fallback stays fast while combined-role startup work runs", async () => {
  const port = await freePort();
  let output = "";
  child = spawn(process.execPath, ["server/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ROLE: "all",
      PORT: String(port),
      DATA_DIR: dataDir,
      API_KEY: "spa-fallback-test-api-key-32-characters",
      WEBHOOK_SECRET: "spa-fallback-test-webhook-secret-32",
      SESSION_SECRET: "spa-fallback-test-session-secret-32",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "spa-fallback-test-password",
      PLEMBFIN_TEST_MODE: "1",
      PLEMBFIN_TEST_LEASE_ACQUIRE_MS: "100",
      PLEMBFIN_TEST_LEASE_RENEW_MS: "150",
      PLEMBFIN_TEST_LEASE_TTL_MS: "800",
      // Pull the first tick, deferred pollers, backfills, and job polling into
      // the window where this test is requesting documents.
      PLEMBFIN_TEST_FIRST_TICK_MS: "400",
      PLEMBFIN_TEST_TICK_MS: "500",
      PLEMBFIN_TEST_JOB_POLL_MS: "50",
      // Hermetic: never reach the developer's real services from .env.
      PLEX_ENABLED: "false", PLEX_SERVER_URL: "", PLEX_TOKEN: "", PLEX_USERNAME: "",
      EMBY_ENABLED: "false", EMBY_SERVER_URL: "", EMBY_API_KEY: "", EMBY_USER_ID: "",
      JELLYFIN_ENABLED: "false", JELLYFIN_SERVER_URL: "", JELLYFIN_API_KEY: "", JELLYFIN_USER_ID: "",
      TMDB_API_KEY: "", TVDB_API_KEY: "", FANART_API_KEY: "", OMDB_API_KEY: "", YOUTUBE_API_KEY: "",
      TRAKT_CLIENT_ID: "", TRAKT_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 15_000;
  while (!output.includes("listening on") && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await delay(25);
  }
  assert.ok(output.includes("listening on"), `server did not start:\n${output}`);

  // Cover roughly 3 s after listen: startup maintenance, the 400 ms first
  // tick, the deferred pollers, the backfills at first tick + 1 s, and
  // several later ticks and job polls.
  const routes = ["/", "/movies", "/tvshows/", "/settings/media-servers", "/history"];
  const timings = [];
  const endAt = Date.now() + 3_000;
  let index = 0;
  while (Date.now() < endAt) {
    const route = routes[index % routes.length];
    index += 1;
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { cache: "no-store" });
    const body = await response.text();
    const elapsed = performance.now() - startedAt;
    timings.push({ route, elapsed });
    assert.equal(response.status, 200, `${route} returned ${response.status}`);
    assert.match(response.headers.get("content-type") || "", /text\/html/, `${route} is not the SPA document`);
    assert.match(body, /<title>Plekt<\/title>/, `${route} did not serve index.html`);
    assert.ok(elapsed < STALL_BOUND_MS, `${route} took ${Math.round(elapsed)} ms during startup work`);
    await delay(50);
  }
  assert.ok(timings.length >= 10, `only ${timings.length} document requests completed in the window`);

  // The two tiny endpoints added so the shell stops downloading the full
  // changelog and stale icon probes stop receiving the SPA document.
  const version = await fetch(`http://127.0.0.1:${port}/version.json`, { cache: "no-store" });
  assert.equal(version.status, 200);
  assert.ok("version" in await version.json());
  const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { cache: "no-store" });
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
});
