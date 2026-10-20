import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-up-next-mutation-");
const { AUTH } = await import("../server/src/appConfig.js");
const { getDataVersion, getUpNextVersion } = await import("../server/src/db.js");
const { upsertPlaybackProgress } = await import("../server/src/utils/dataRepo.js");
const { getUpNextCacheSnapshot } = await import("../server/src/utils/upNextCache.js");
const { handlePlaybackProgressUnwatch, handleUpNextRemove } = await import("../server/src/routes/sync.js");

for (const [name, handler] of [["Clear progress", handlePlaybackProgressUnwatch], ["Remove from Up Next", handleUpNextRemove]]) {
  test(`${name} publishes a current snapshot before sending success`, async () => {
    const item = {
      media_key: `movie:tmdb:${handler === handleUpNextRemove ? 991002 : 991001}`,
      media_type: "movie", title: name, position_ms: 300000,
      duration_ms: 1200000, progress: 25,
    };
    upsertPlaybackProgress(item);
    await getUpNextCacheSnapshot(async () => [{ ...item, id: item.media_key }], { refresh: true });
    let acknowledged = false;
    const req = {
      method: "POST", body: item,
      headers: { authorization: `Bearer ${AUTH.apiKey}` },
      get(name) { return this.headers[name.toLowerCase()]; },
    };
    const res = {
      status(code) { assert.equal(code, 200); return this; },
      set() { return this; },
      send(data) {
        assert.equal(JSON.parse(data).ok, true);
        const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, "up-next-cache.json"), "utf8"));
        assert.equal(snapshot.items.some((row) => row.media_key === item.media_key || row.id === item.media_key), false);
        assert.equal(snapshot.historyVersion, getDataVersion());
        assert.equal(snapshot.upNextVersion, getUpNextVersion());
        acknowledged = true;
        return this;
      },
    };
    await handler(req, res);
    assert.equal(acknowledged, true);
    const desktop = await getUpNextCacheSnapshot(() => { throw new Error("desktop must not rebuild"); }, { revalidate: true });
    assert.equal(desktop.stale, false);
  });
}
