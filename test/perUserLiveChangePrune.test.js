import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// The live-change prune interval was one timestamp for every database, so the
// admin's recent prune stopped an added user's own old rows from being pruned
// (10 November 2026 audit, step 2).

const root = makeTempDataDir("plekt-live-prune-");
const aliceDir = path.join(root, "users", "alice");
fs.mkdirSync(aliceDir, { recursive: true });

const { db } = await import("../server/src/db.js");
const { liveChangesSince } = await import("../server/src/db.js");
const { runAsAdmin, runWithUserContext } = await import("../server/src/utils/userContext.js");
const asAlice = (fn) => runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, fn);

const DAY = 24 * 60 * 60 * 1000;
const insertOld = () => db.prepare(`INSERT INTO live_change_events (source_table, change_kind, media_key, record_id, media_type, title, show_title, season, episode, created_at)
  VALUES ('watch_history','upsert','movie:tt1',1,'movie','Old','',NULL,NULL,?)`).run(Date.now() - 2 * DAY);
const countOld = () => db.prepare("SELECT count(*) AS n FROM live_change_events WHERE title='Old'").get().n;

test("an added user's old live-change rows are pruned even when the admin pruned a moment ago", async () => {
  await runAsAdmin(() => liveChangesSince(0));
  await asAlice(() => insertOld());
  assert.equal(await asAlice(() => countOld()), 1);
  await asAlice(() => liveChangesSince(0));
  assert.equal(await asAlice(() => countOld()), 0, "alice's prune must run on its own timer");
});
