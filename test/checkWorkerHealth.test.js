import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "check-worker-health.js");

function healthExit(dataDir, env = {}) {
  const clean = { ...process.env, DATA_DIR: dataDir };
  for (const key of Object.keys(clean)) if (key === "ROLE" || key.endsWith("_DEMO_MODE")) delete clean[key];
  return spawnSync(process.execPath, [script], { env: { ...clean, ...env }, encoding: "utf8" }).status;
}

// A data directory whose scheduler lease has no holder, as in the hosted demo.
function unleasedDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-health-"));
  const db = new Database(path.join(dir, "plekt.db"));
  db.exec("CREATE TABLE scheduler_lease (id TEXT PRIMARY KEY, holder_id TEXT, expires_at INTEGER)");
  db.prepare("INSERT INTO scheduler_lease (id, holder_id, expires_at) VALUES ('scheduler', NULL, NULL)").run();
  db.close();
  return dir;
}

test("worker health probe fails without a scheduler lease holder", (t) => {
  const dir = unleasedDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(healthExit(dir), 1);
});

test("worker health probe passes in demo mode, which never takes the lease", (t) => {
  const dir = unleasedDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(healthExit(dir, { PLEKT_DEMO_MODE: "1" }), 0);
});

test("worker health probe in demo mode still fails when the database is missing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(healthExit(dir, { PLEKT_DEMO_MODE: "1" }), 1);
});
