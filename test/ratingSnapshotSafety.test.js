import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-rating-safety-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/personalRatingRepository.js");
const sync = await import("../server/src/utils/personalRatingSync.js");
const { normalizePersonalRatingMedia } = await import("../server/src/utils/personalRatingIdentity.js");
const { fetchEmbyPersonalRatingSnapshot } = await import("../server/src/utils/embyClient.js");
const { fetchJellyfinPersonalRatingSnapshot } = await import("../server/src/utils/jellyfinClient.js");
const { fetchPlexPersonalRatingSnapshot } = await import("../server/src/utils/plexClient.js");
const { fetchTraktPersonalRatingSnapshot } = await import("../server/src/utils/traktClient.js");
const config = {
  emby: { baseUrl: "https://emby.example.test", apiKey: "key", userId: "user" },
  jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "key", userId: "user" },
  ratingSync: { enabled: true, providers: { emby: "bidirectional", jellyfin: "bidirectional" } },
};
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => db.close());
test.beforeEach(() => {
  for (const table of ["personal_ratings", "personal_rating_sources", "personal_rating_sync_queue", "personal_rating_sync_runs"]) db.exec(`DELETE FROM ${table}`);
});
const item = (id) => ({ Id: String(id), Name: `Movie ${id}`, Type: "Movie", ProviderIds: { Tmdb: String(id) }, UserData: { Rating: 8 } });
function respond(body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function seed(count = 7) {
  const run = repo.startPersonalRatingSyncRun("emby", "import");
  for (let id = 1; id <= count; id++) {
    const media = normalizePersonalRatingMedia({ type: "movie", title: `Movie ${id}`, tmdb_id: String(id) });
    repo.upsertCanonicalPersonalRating(media, 8);
    repo.upsertRatingSourceObservation({ provider: "emby", media, remoteRating: 8, remoteState: "rated", generation: run.generation });
  }
  repo.markRatingSourceSnapshotComplete("emby", run.generation);
  repo.finishPersonalRatingSyncRun("emby", { baseline_complete: 1 });
}
const run = () => sync.runRatingSync({ providers: ["emby"], config, drain: false });
const remaining = () => db.prepare("SELECT COUNT(*) AS n FROM personal_ratings").get().n;

for (const [provider, fetchSnapshot] of [["emby", fetchEmbyPersonalRatingSnapshot], ["jellyfin", fetchJellyfinPersonalRatingSnapshot]]) {
  for (const body of [{}, { Items: {} }, { Items: [], TotalRecordCount: 1 }, { Items: [item(1)], TotalRecordCount: 2 }]) {
    test(`${provider} rejects malformed or truncated snapshot ${JSON.stringify(body)}`, async () => {
      respond(body);
      await assert.rejects(fetchSnapshot(config[provider]), /rating.*(snapshot|scan)|incomplete/i);
    });
  }
  test(`${provider} accepts a verified empty snapshot`, async () => {
    respond({ Items: [], TotalRecordCount: 0 });
    assert.deepEqual(await fetchSnapshot(config[provider]), []);
  });
  test(`${provider} rejects a malformed later page`, async () => {
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1
      ? { Items: Array.from({ length: 200 }, (_, i) => item(i + 1)), TotalRecordCount: 201 }
      : {}), { headers: { "Content-Type": "application/json" } });
    await assert.rejects(fetchSnapshot(config[provider]), /rating.*(snapshot|scan)|incomplete/i);
    assert.equal(calls, 2);
  });
}
test("malformed scan preserves ratings and queues no removal to the second provider", async () => {
  seed(); respond({});
  assert.equal((await run()).providers[0].status, "failed");
  assert.equal(remaining(), 7);
  assert.equal(repo.listPersonalRatingQueue().length, 0);
});
test("Trakt rejects an object instead of an array", async () => {
  respond({});
  await assert.rejects(fetchTraktPersonalRatingSnapshot({ clientId: "test", accessToken: "token" }), /rating snapshot.*malformed/i);
});
test("Plex rejects malformed library and incomplete section snapshots", async () => {
  const plex = { baseUrl: "https://plex.example.test", token: "token" };
  respond({});
  await assert.rejects(fetchPlexPersonalRatingSnapshot(plex), /rating snapshot.*malformed/i);
  globalThis.fetch = async (url) => new Response(JSON.stringify(new URL(String(url)).pathname === "/library/sections"
    ? { MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }
    : { MediaContainer: { Metadata: [{ title: "Incomplete", userRating: 8 }], totalSize: 2 } }), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(fetchPlexPersonalRatingSnapshot(plex), /rating snapshot.*incomplete/i);
});
test("a single missing rating still clears and fans out", async () => {
  seed(); respond({ Items: Array.from({ length: 6 }, (_, i) => item(i + 1)), TotalRecordCount: 6 });
  assert.equal((await run()).providers[0].cleared, 1);
  assert.equal(remaining(), 6);
  assert.equal(repo.listPersonalRatingQueue({ provider: "jellyfin" })[0].desired_state, "unrated");
});
test("two missing of seven are held persistently without baseline changes or clear fanout", async () => {
  seed(); const before = repo.listRatingSourceRows("emby");
  respond({ Items: Array.from({ length: 5 }, (_, i) => item(i + 1)), TotalRecordCount: 5 });
  const result = await run();
  assert.equal(result.status, "partial");
  assert.equal(result.providers[0].status, "held");
  assert.equal(remaining(), 7);
  assert.deepEqual(repo.listRatingSourceRows("emby"), before);
  assert.equal(repo.listPersonalRatingQueue().length, 0);
  const held = (await sync.getRatingSyncStatus({ config })).providers.find(x => x.provider === "emby").run;
  assert.equal(held.status, "held");
  assert.deepEqual(held.cursor.ratingHold.items.map(x => x.title), ["Movie 6", "Movie 7"]);
  respond({ Items: [], TotalRecordCount: 0 });
  await run();
  assert.equal(repo.getPersonalRatingSyncRun("emby").run_id, held.run_id);
});
test("exactly twenty percent is allowed, while the first scan never clears", async () => {
  seed(10); respond({ Items: Array.from({ length: 8 }, (_, i) => item(i + 1)), TotalRecordCount: 8 });
  assert.equal((await run()).providers[0].cleared, 2);
  db.exec("DELETE FROM personal_rating_sync_runs");
  respond({ Items: [], TotalRecordCount: 0 });
  assert.equal((await run()).providers[0].cleared, 0);
  assert.equal(remaining(), 8);
});
test("processing errors skip all missing-row clears", async () => {
  seed(); respond({ Items: [item(1)], TotalRecordCount: 1 });
  // Stay below the mass-clear threshold; exercise the error gate itself.
  db.exec("DELETE FROM personal_rating_sources WHERE media_key NOT IN ('movie:tmdb:1', 'movie:tmdb:2')");
  db.exec("CREATE TRIGGER fail_rating_observation BEFORE UPDATE ON personal_rating_sources BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END");
  try {
    assert.equal((await run()).providers[0].status, "partial");
    assert.equal(remaining(), 7);
    assert.equal(repo.listPersonalRatingQueue().length, 0);
  } finally { db.exec("DROP TRIGGER fail_rating_observation"); }
});
test("dismiss preserves ratings; approval revalidates the held set and clears only on match", async () => {
  seed(); respond({ Items: [], TotalRecordCount: 0 });
  await run();
  let held = repo.getPersonalRatingSyncRun("emby");
  await sync.resolveRatingScanHold({ provider: "emby", runId: held.run_id, decision: "dismiss", config });
  assert.equal(remaining(), 7);
  assert.equal(repo.listPersonalRatingQueue().length, 0);
  assert.equal(repo.getPersonalRatingSyncRun("emby").cursor, null);
  await run(); held = repo.getPersonalRatingSyncRun("emby");
  await assert.rejects(sync.resolveRatingScanHold({ provider: "emby", runId: "stale", decision: "approve", config }), /changed|stale/i);
  respond({ Items: [item(1)], TotalRecordCount: 1 });
  const stale = await sync.resolveRatingScanHold({ provider: "emby", runId: held.run_id, decision: "approve", config });
  assert.equal(stale.providers[0].status, "held");
  assert.equal(remaining(), 7);
  held = repo.getPersonalRatingSyncRun("emby");
  const applied = await sync.resolveRatingScanHold({ provider: "emby", runId: held.run_id, decision: "approve", config });
  assert.equal(applied.providers[0].cleared, 6);
  assert.equal(remaining(), 1);
});
test("a scan already owned by another process cannot be replaced", async () => {
  seed();
  const claimed = repo.startPersonalRatingSyncRun("emby", "import");
  respond({ Items: [], TotalRecordCount: 0 });
  const result = await run();
  assert.equal(result.providers[0].status, "running");
  assert.equal(result.status, "partial");
  assert.equal(repo.getPersonalRatingSyncRun("emby").run_id, claimed.run_id);
  assert.equal(remaining(), 7);
});
test("failed revalidation preserves the hold and cannot be dismissed while another process runs it", async () => {
  seed(); respond({ Items: [], TotalRecordCount: 0 }); await run();
  let held = repo.getPersonalRatingSyncRun("emby");
  repo.updatePersonalRatingSyncRun("emby", { status: "running" });
  await assert.rejects(sync.resolveRatingScanHold({ provider: "emby", runId: held.run_id, decision: "dismiss", config }), /running/);
  repo.updatePersonalRatingSyncRun("emby", { status: "partial" });
  respond({});
  await sync.resolveRatingScanHold({ provider: "emby", runId: held.run_id, decision: "approve", config });
  held = repo.getPersonalRatingSyncRun("emby");
  assert.equal(held.status, "held");
  assert.ok(held.cursor.ratingHold);
  assert.equal(remaining(), 7);
  assert.equal(repo.listPersonalRatingQueue().length, 0);
});
