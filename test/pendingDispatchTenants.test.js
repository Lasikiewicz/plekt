import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const root = makeTempDataDir("plekt-pending-dispatch-tenants-");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { bumpDataVersion, getDataVersion } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { acquirePendingDispatch } = await import("../server/src/utils/pendingDispatchGuard.js");
const { syncPendingManualDispatches } = await import("../server/src/utils/syncDispatchQueue.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

test("retry candidate cache stays scoped to each tenant even at the same version", async () => {
  const contexts = ["alice", "bob"].map(name => {
    const dataDir = path.join(root, "users", name);
    fs.mkdirSync(dataDir, { recursive: true });
    return { name, dataDir, role: "user" };
  });
  const within = (i, fn) => runWithUserContext(contexts[i], fn);
  const rows = contexts.map((context, i) => within(i, () => repo.insertWatchRecordSync({ title: context.name, media_type: "movie", tmdb_id: `tenant-${context.name}`, source: "manual", watched_at: "2026-11-01T12:00:00Z", sync_dispatch_telemetry: "Dispatch status: pending" })));
  for (let i = 0; i < 20; i++) {
    const versions = contexts.map((_, index) => within(index, () => getDataVersion()));
    if (versions[0] === versions[1]) break;
    within(versions[0] < versions[1] ? 0 : 1, () => bumpDataVersion());
  }
  assert.equal(within(0, () => getDataVersion()), within(1, () => getDataVersion()));
  const release = acquirePendingDispatch(rows[0].id);
  try {
    assert.equal(await within(0, () => syncPendingManualDispatches({}, createLoopStore(), () => {})), 0);
    assert.equal(await within(1, () => syncPendingManualDispatches({}, createLoopStore(), () => {})), 1);
  } finally { release(); }
});
