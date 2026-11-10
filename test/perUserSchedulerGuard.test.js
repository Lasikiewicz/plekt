import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The in-flight guard was keyed by step label only, so one user's slow
// "Scheduled sync" made every other user's step skip (10 November 2026 audit,
// step 2).

const root = makeTempDataDir("plekt-scheduler-guard-");
const aliceDir = path.join(root, "users", "alice");
fs.mkdirSync(aliceDir, { recursive: true });

const { runWithTimeBudget } = await import("../server/src/scheduler.js");
const { runAsAdmin, runWithUserContext } = await import("../server/src/utils/userContext.js");
const asAlice = (fn) => runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, fn);

test("a slow step for one user does not make another user's step with the same label skip", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let adminRan = false;
  const adminRun = runAsAdmin(() => runWithTimeBudget("Scheduled sync", () => slow.then(() => { adminRan = true; }), 5));
  let aliceRan = false;
  await asAlice(() => runWithTimeBudget("Scheduled sync", async () => { aliceRan = true; }, 1000));
  assert.equal(aliceRan, true, "alice's step must run while the admin's is still in flight");
  release();
  await adminRun;
});
