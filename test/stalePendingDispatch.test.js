import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-stale-pending-dispatch-");

const repo = await import("../server/src/utils/dataRepo.js");
const { syncPendingManualDispatches } = await import("../server/src/utils/syncDispatchQueue.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { db } = await import("../server/src/db.js");

test("pending dispatch skips a history row deleted after the queue snapshot", async () => {
  const first = await repo.insertWatchRecord({
    title: "Dispatch Race Show - S01E01", media_type: "episode", show_title: "Dispatch Race Show",
    season: 1, episode: 1, tmdb_id: "dispatch-race-1", watched_at: "2026-10-01T00:00:00.000Z",
    source: "manual", sync_action: "watched", sync_dispatch_telemetry: "Dispatch status: pending",
  });
  const removed = await repo.insertWatchRecord({
    title: "Dispatch Race Show - S01E01", media_type: "episode", show_title: "Dispatch Race Show",
    season: 1, episode: 1, tmdb_id: "dispatch-race-2", watched_at: "2026-10-01T00:00:01.000Z",
    source: "manual", sync_action: "watched", sync_dispatch_telemetry: "Dispatch status: pending",
  });

  let deletedId = "";
  await syncPendingManualDispatches({}, createLoopStore(), (message) => {
    if (!deletedId && message.startsWith("Background Queue: retrying/dispatching")) {
      // This runs after the cache snapshot was selected and while the two
      // same-episode rows are being processed serially in one dispatch group.
      const currentId = message.match(/\(([0-9a-f-]+)\)\.\.\.$/i)?.[1];
      deletedId = currentId === first.id ? removed.id : first.id;
      void repo.deleteWatchRecordById(deletedId);
    }
  });

  assert.ok(deletedId, "the first row should create the controlled race window");
  const deletedRow = deletedId === first.id ? first : removed;
  assert.equal(await repo.getWatchRecordByIdLight(deletedId), null);
  assert.equal(await repo.getPlaystateForMedia({
    title: deletedRow.title, type: "episode", season: 1, episode: 1,
    ids: { tmdb: deletedId === first.id ? "dispatch-race-1" : "dispatch-race-2" },
  }), null, "the deleted history row must not recreate watched playstate");
});

test("a current row deleted immediately before promotion cannot recreate watched playstate", async () => {
  const row=await repo.insertWatchRecord({title:"Deleted Current Dispatch Movie",media_type:"movie",tmdb_id:"deleted-current-dispatch",watched_at:"2026-10-01T00:00:00Z",source:"manual",sync_action:"watched",sync_dispatch_telemetry:"Dispatch status: pending"},{prefetch:false});
  await syncPendingManualDispatches({},createLoopStore(),message=>{
    if(message.includes(`(${row.id})`)) db.prepare("DELETE FROM watch_history WHERE id=?").run(row.id);
  });
  assert.equal(await repo.getWatchRecordByIdLight(row.id),null);
  assert.equal(await repo.getPlaystateForMedia({title:row.title,type:"movie",ids:{tmdb:"deleted-current-dispatch"}}),null);
});

test("a newer unwatch row is not promoted or overwritten by an older watched snapshot", async () => {
  const row=await repo.insertWatchRecord({title:"Changed Current Dispatch Movie",media_type:"movie",tmdb_id:"changed-current-dispatch",watched_at:"2026-10-01T00:00:00Z",source:"manual",sync_action:"watched",sync_dispatch_telemetry:"Dispatch status: pending"},{prefetch:false});
  await syncPendingManualDispatches({},createLoopStore(),message=>{
    if(message.includes(`(${row.id})`)) db.prepare("UPDATE watch_history SET sync_action='unwatched',sync_dispatch_telemetry='Newer manual unwatch',updated_at=updated_at+1 WHERE id=?").run(row.id);
  });
  const current=await repo.getWatchRecordByIdLight(row.id);
  assert.equal(current.sync_action,"unwatched");
  assert.equal(current.sync_dispatch_telemetry,"Newer manual unwatch");
  assert.equal(await repo.getPlaystateForMedia({title:row.title,type:"movie",ids:{tmdb:"changed-current-dispatch"}}),null);
});
