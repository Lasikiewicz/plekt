import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-simkl-order-skip-test-");

const { db } = await import("../server/src/db.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { dispatchTrackerWatchState } = await import("../server/src/utils/trackerDispatcher.js");
const { compareTrackerWithPlekt, startTrackerFullSync } = await import("../server/src/utils/trackers/fullSync.js");
const { runSimklFullSyncSlice } = await import("../server/src/utils/trackers/simklFullSyncRunner.js");
const { matchSimklAiredEpisode } = await import("../server/src/utils/trackers/simklEpisodeOrder.js");

test.after(() => db.close());

test("a watch resolved from a non-Aired order is skipped for Simkl with a clear reason", async () => {
  saveTrackerConnection({ provider: "simkl", accessToken: "test-access", refreshToken: "test-refresh", remoteUserId: "1", clientId: "test-client" });
  // A non-episode record passes order resolution untouched, so this exercises
  // only the dispatcher's Simkl skip for records carrying order provenance.
  const media = {
    type: "movie", media_type: "movie", source: "plex", syncTargets: ["simkl"], title: "Order skip fixture",
    watch_provenance: { episode_order: { tvdbId: "1", dvdId: 2, airedId: 3, order: "alternate" } },
  };
  const results = await dispatchTrackerWatchState(media, "watched", { lane: "sync" });
  assert.equal(results.length, 1);
  assert.equal(results[0].target, "simkl");
  assert.equal(results[0].status, "skipped");
  assert.equal(results[0].dismissed, true);
  assert.match(results[0].detail, /Simkl does not support alternate episode orders/);
});

test("requires one exact catalogue match and compatible aired numbering", () => {
  const aired = { name: "Example", air_date: "2020-01-01", season: 1, episode: 2 };
  const row = { title: "Example", date: "2020-01-01T06:00:00Z", season: 1, episode: 2,
    type: "episode", aired: true, ids: { simkl_id: 20 } };
  assert.equal(matchSimklAiredEpisode(aired, [row]), "20");
  assert.equal(matchSimklAiredEpisode(aired, [row, { ...row, episode: 3 }]), null);
  assert.equal(matchSimklAiredEpisode(aired, [{ ...row, episode: 3 }]), null);
  assert.equal(matchSimklAiredEpisode(aired, [{ ...row, date: "2020-01-02" }]), null);
});

test("scoped Simkl review sends only an approved, verified watch and updates its skip", async () => {
  saveTrackerConnection({ provider: "simkl", accessToken: "test-access", refreshToken: "test-refresh",
    accessTokenExpiresAt: Date.now() + 3600_000, remoteUserId: "1", clientId: "test-client", baselineComplete: true });
  const watchedAt = "2021-02-01T00:00:00.000Z";
  const now = Date.now();
  const group = "show|title:example";
  const ids = [];
  const aired = [];
  for (const episode of [1, 2, 3]) {
    const key = `episode|show:example|s:1|e:${episode}`;
    const title = `Example - S01E0${episode}`;
    const provenance = { episode_order: { tvdbId: "77", dvdId: 500 + episode, airedId: 50 + episode, order: "dvd" } };
    db.prepare(`INSERT INTO watch_history (id,title,show_title,media_type,watched_at,tvdb_id,season,episode,sync_action,media_key,watch_provenance,created_at)
      VALUES (?,?,'Example','episode',?,'77',1,?,'watched',?,?,?)`)
      .run(`row-${episode}`, title, watchedAt, episode, key, JSON.stringify(provenance), now);
    const target = { target: "simkl", status: "skipped", detail: "Simkl does not support alternate episode orders" };
    ids.push(db.prepare(`INSERT INTO sync_history (timestamp,media_type,title,action,status,target_states,activity_group_key,activity_item_key)
      VALUES (?,'episode',?,'watched','skipped',?,?,?)`).run(now, title, JSON.stringify([target]), group, key).lastInsertRowid);
    aired.push({ id: 50 + episode, seriesId: 77, name: `Episode ${episode}`, air_date: `2020-01-0${episode}`, season: 1, episode });
  }
  db.prepare("INSERT INTO tvdb_metadata_cache (id,tvdb_id,details,updated_at_ms) VALUES ('order_catalogue_v4_77',77,?,?)")
    .run(JSON.stringify({ tvdbId: 77, fetchedAt: now, orders: { official: aired, dvd: [] } }), now);
  const original = globalThis.fetch;
  const writes = [];
  const headers = { "x-ratelimit-limit": "500", "x-ratelimit-remaining": "499" };
  globalThis.fetch = async (url, options = {}) => {
    const link = new URL(url);
    assert.equal(link.hostname, "api.simkl.com");
    const path = link.pathname;
    let data = {};
    if (path === "/sync/activities") data = { all: watchedAt };
    else if (path === "/search/id") data = [{ type: "tv", ids: { simkl: 700 } }];
    else if (path === "/tv/700") data = { ids: { simkl: 700, tvdb: "77" } };
    else if (path === "/tv/episodes/700") data = aired.slice(0, 2).map(row => ({
      title: row.name, date: row.air_date, season: row.season, episode: row.episode,
      type: "episode", aired: true, ids: { simkl_id: 800 + row.episode },
    }));
    else if (path === "/sync/history") {
      writes.push(JSON.parse(options.body));
      data = { added: { episodes: 1 }, not_found: {} };
    } else if (path === "/sync/watched") data = [{
      ids: { simkl: 700, tvdb: "77" }, result: true, seasons: [{ number: 1,
        episodes: [{ number: 1, watched: true, last_watched_at: watchedAt }] }],
    }];
    else assert.match(path, /^\/sync\/all-items\/(movies|shows|anime)$/);
    return Response.json(data, { headers });
  };
  try {
    const { preview } = await compareTrackerWithPlekt("simkl", { activityGroupKey: group });
    assert.equal(writes.length, 0);
    assert.deepEqual(preview.items.map(row => [row.episode, row.selectable]), [[1, true], [2, true], [3, false]]);
    const selectedIds = [preview.items[0].id];
    await assert.rejects(startTrackerFullSync("simkl", "both", { planId: preview.id, selectedIds }), { code: "INVALID_DIRECTION" });
    const { pacedRunId } = await startTrackerFullSync("simkl", "push", { planId: preview.id, selectedIds });
    await runSimklFullSyncSlice(pacedRunId);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].shows[0].seasons[0].episodes, [{ number: 1, watched_at: watchedAt }]);
    const read = db.prepare("SELECT target_states FROM sync_history WHERE id=?");
    assert.deepEqual(ids.map(id => JSON.parse(read.get(id).target_states)[0].status), ["success", "skipped", "skipped"]);
  } finally {
    globalThis.fetch = original;
  }
});
