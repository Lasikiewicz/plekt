import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const apiKey = "multiprocess-test-api-key-32-characters";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-real-multiprocess-"));
const children = [];

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

function startProcess(role, port) {
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ROLE: role,
      PORT: String(port),
      DATA_DIR: dataDir,
      API_KEY: apiKey,
      WEBHOOK_SECRET: "multiprocess-test-webhook-secret-32",
      SESSION_SECRET: "multiprocess-test-session-secret-32",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "multiprocess-test-password",
      PLEMBFIN_TEST_MODE: "1",
      PLEMBFIN_TEST_LEASE_ACQUIRE_MS: "100",
      PLEMBFIN_TEST_LEASE_RENEW_MS: "150",
      PLEMBFIN_TEST_LEASE_TTL_MS: "800",
      PLEMBFIN_TEST_FIRST_TICK_MS: "5000",
      PLEMBFIN_TEST_TICK_MS: "5000",
      PLEMBFIN_TEST_JOB_POLL_MS: "50",
      // The child server loads the repository .env. Pin every external
      // integration off so this remains a hermetic multiprocess test even when
      // the developer's real services are reachable.
      PLEX_ENABLED: "false",
      PLEX_SERVER_URL: "",
      PLEX_TOKEN: "",
      PLEX_USERNAME: "",
      EMBY_ENABLED: "false",
      EMBY_SERVER_URL: "",
      EMBY_API_KEY: "",
      EMBY_USER_ID: "",
      JELLYFIN_ENABLED: "false",
      JELLYFIN_SERVER_URL: "",
      JELLYFIN_API_KEY: "",
      JELLYFIN_USER_ID: "",
      TMDB_API_KEY: "",
      TVDB_API_KEY: "",
      FANART_API_KEY: "",
      OMDB_API_KEY: "",
      YOUTUBE_API_KEY: "",
      TRAKT_CLIENT_ID: "",
      TRAKT_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, role, port, output: "" };
  child.stdout.on("data", (chunk) => { state.output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { state.output += chunk.toString(); });
  children.push(state);
  return state;
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  // Under a fully parallel test run the parent event loop can be starved past
  // the nominal deadline while the child processes finish successfully. Check
  // the observable state once more before declaring a coordination failure.
  const finalValue = await predicate();
  if (finalValue) return finalValue;
  throw new Error(message);
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    return response.ok ? response.json() : null;
  } catch { return null; }
}

async function api(port, url, options = {}) {
  return fetch(`http://127.0.0.1:${port}${url}`, {
    ...options,
    headers: { "x-api-key": apiKey, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
}

async function stopProcess(state) {
  if (!state || state.child.exitCode !== null) return;
  state.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => state.child.once("exit", resolve)),
    delay(3_000).then(() => state.child.kill()),
  ]);
}

test.after(async () => {
  await Promise.all(children.map(stopProcess));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("real web replicas and workers coordinate through an isolated local server", async () => {
  const [allPort, webPortA, webPortB, workerUnusedPortA, workerUnusedPortB] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const allProcess = startProcess("all", allPort);
  const allHealth = await waitFor(async () => {
    const value = await health(allPort);
    return value?.worker?.available ? value : null;
  }, "default all role did not start its web and worker halves");
  assert.equal(allHealth.role, "all");
  assert.equal(allHealth.worker.leader, true);
  await stopProcess(allProcess);

  const workerA = startProcess("worker", workerUnusedPortA);
  const workerB = startProcess("worker", workerUnusedPortB);
  await waitFor(() => workerA.output.includes("leadership acquired") || workerB.output.includes("leadership acquired"), "no worker acquired leadership");

  const webA = startProcess("web", webPortA);
  const webB = startProcess("web", webPortB);
  await waitFor(() => health(webPortA), "web replica A did not start");
  const initialHealth = await waitFor(() => health(webPortB), "web replica B did not start");
  assert.equal(initialHealth.role, "web");
  assert.equal(initialHealth.worker.available, true);

  await assert.rejects(fetch(`http://127.0.0.1:${workerUnusedPortA}/health`));
  await assert.rejects(fetch(`http://127.0.0.1:${workerUnusedPortB}/health`));

  const before = await (await api(webPortB, "/api/history?stats=0")).json();
  const imported = await api(webPortA, "/api/import", {
    method: "POST",
    body: JSON.stringify([{ title: "Replica Cache Movie", media_type: "movie", watched_at: "2026-07-18T10:00:00.000Z", source: "plex", imdb_id: "tt-multiprocess" }]),
  });
  assert.equal(imported.status, 200);
  const after = await waitFor(async () => {
    const body = await (await api(webPortB, "/api/history?stats=0")).json();
    return body.history?.some((row) => row.title === "Replica Cache Movie") && body.historyVersion > before.historyVersion ? body : null;
  }, "second web replica did not observe imported history", 3_000);
  assert.ok(after.history.some((row) => row.title === "Replica Cache Movie"));

  const cron = await api(webPortA, "/api/cron-sync", { method: "POST" });
  assert.equal(cron.status, 200);
  assert.match(await cron.text(), /RESULT:/);

  const force = await api(webPortA, "/api/force-sync", { method: "POST" });
  assert.equal(force.status, 202);
  const forceBody = await force.json();
  assert.ok(forceBody.jobId);
  const completed = await waitFor(async () => {
    const body = await (await api(webPortB, "/api/force-sync")).json();
    return ["succeeded", "failed", "cancelled"].includes(body.status) ? body : null;
  }, "force sync did not complete in worker", 15_000);
  assert.ok(completed.log.some((line) => line.includes("Force Sync started")));

  const logs = await (await api(webPortA, "/api/diagnostic-logs?limit=1000")).json();
  assert.ok(logs.logs.some((line) => line.includes("[worker:")), "worker diagnostics were not merged");
  assert.ok(logs.logs.some((line) => line.includes("[web:")), "web diagnostics were not merged");

  const leaseDb = new Database(path.join(dataDir, "plekt.db"), { readonly: true });
  const holderId = String(leaseDb.prepare("SELECT holder_id FROM scheduler_lease WHERE id='scheduler'").get()?.holder_id || "");
  leaseDb.close();
  const leader = holderId.includes(`:${workerA.child.pid}:`) ? workerA : workerB;
  const standby = leader === workerA ? workerB : workerA;
  await stopProcess(leader);
  await waitFor(
    () => standby.output.includes("leadership acquired"),
    `standby did not take leadership\nleader:\n${leader.output}\nstandby:\n${standby.output}`,
    4_000,
  );

  await Promise.all([stopProcess(webA), stopProcess(webB), stopProcess(standby)]);
  const database = new Database(path.join(dataDir, "plekt.db"), { readonly: true });
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  database.close();
});
