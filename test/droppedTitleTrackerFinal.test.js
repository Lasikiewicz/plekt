import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDataDir } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/droppedTitleTrackerChecks.mjs", import.meta.url));
function phase(scenario, dataDir) {
  const child = spawnSync(process.execPath, [fixture, scenario], { encoding: "utf8", timeout: 30_000,
    env: { ...process.env, DATA_DIR: dataDir, NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(child.status, 0, `${scenario}\n${child.stdout}\n${child.stderr}`);
  const result = child.stdout.split(/\r?\n/).find(line => line.startsWith("DROPPED_CHECK="));
  assert.ok(result, `missing fixture evidence: ${child.stdout}`);
  return JSON.parse(result.slice("DROPPED_CHECK=".length));
}

for (const scenario of ["simkl-older-remote", "simkl-newer-remote-drop", "simkl-missing-timestamp", "simkl-tie",
  "simkl-pending-drop", "simkl-newer-remote-removal", "simkl-echo", "simkl-incomplete", "simkl-duplicate", "simkl-bad-ack",
  "trakt-older-remote", "trakt-missing-timestamp"]) {
  test(`Dropped-title final conflict check: ${scenario}`, () => {
    phase(scenario, makeTempDataDir("plekt-dropped-conflict-"));
  });
}

test("Dropped-title durable intent survives real process restarts and drains once on a user event", () => {
  const dataDir = makeTempDataDir("plekt-dropped-restart-");
  const seeded = phase("restart-seed", dataDir);
  assert.ok(seeded.rowId);
  assert.equal(seeded.calls, 0);
  phase("restart-drain", dataDir);
  phase("restart-confirm", dataDir);
});
