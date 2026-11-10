import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The pending dispatch sweep had one process-wide in-flight flag, so one user's
// running sweep made another user's sweep return 0 without checking their rows
// (10 November 2026 audit, step 2).

const root = makeTempDataDir("plekt-dispatch-sweep-flag-");
const repo = await import("../server/src/utils/dataRepo.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { syncPendingManualDispatches } = await import("../server/src/utils/syncDispatchQueue.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const contexts = ["alice", "bob"].map((name) => {
  const dataDir = path.join(root, "users", name);
  fs.mkdirSync(dataDir, { recursive: true });
  return { name, dataDir, role: "user" };
});
const within = (i, fn) => runWithUserContext(contexts[i], fn);

test("one user's running pending sweep does not make another user's sweep return 0", async () => {
  contexts.forEach((context, i) => within(i, () => repo.insertWatchRecordSync({
    title: `Sweep Flag ${context.name}`, media_type: "movie", tmdb_id: `sweep-flag-${context.name}`,
    source: "manual", sync_action: "watched", watched_at: "2026-11-01T12:00:00Z",
    sync_dispatch_telemetry: "Dispatch status: pending",
  })));

  // Alice's sweep logs once per row it is dispatching. The first log starts
  // Bob's sweep synchronously: the in-flight check runs before Bob's first await,
  // so a shared flag is already set at that point and Bob's sweep returns 0.
  let bobSweep = null;
  const aliceSweep = within(0, () => syncPendingManualDispatches({}, createLoopStore(), (message) => {
    if (!bobSweep && message.startsWith("Background Queue: retrying/dispatching")) {
      bobSweep = within(1, () => syncPendingManualDispatches({}, createLoopStore(), () => {}));
    }
  }));

  assert.equal(await aliceSweep, 1);
  assert.ok(bobSweep, "alice's sweep must reach a dispatch while bob's is started");
  assert.equal(await bobSweep, 1, "bob's sweep must dispatch his row while alice's was running");
});
