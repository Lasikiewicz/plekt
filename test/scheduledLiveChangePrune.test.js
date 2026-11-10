import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const root = makeTempDataDir("plekt-scheduled-live-prune-");
const aliceDir = path.join(root, "users", "alice");
fs.mkdirSync(aliceDir, { recursive: true });
const { db } = await import("../server/src/db.js");
const { runScheduledTick } = await import("../server/src/scheduler.js");
const { runAsAdmin, runWithUserContext } = await import("../server/src/utils/userContext.js");
const asAlice = (fn) => runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, fn);

test("scheduled ticks prune old live changes in each database without a browser", async () => {
  const insert = () => db.prepare(`INSERT INTO live_change_events (source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at)
    VALUES ('watch_history','upsert','movie:tt1',1,'movie','Old','',NULL,NULL,?)`).run(Date.now() - 2 * 86400_000);
  const count = () => db.prepare("SELECT count(*) AS n FROM live_change_events WHERE title='Old'").get().n;
  const tick = () => { let checks = 0; return runScheduledTick({ isLeader: () => ++checks === 1 }); };
  await runAsAdmin(insert);
  await asAlice(insert);
  await runAsAdmin(tick);
  await asAlice(tick);
  assert.equal(await runAsAdmin(count), 0);
  assert.equal(await asAlice(count), 0);
});
