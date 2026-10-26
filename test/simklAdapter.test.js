import { simklTransport } from "../server/src/utils/trackers/simklTransport.js";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
import { executeTrackerOperation } from "../server/src/utils/trackers/contract.js";
import { fetchSimklSnapshot, normalizeSimklRows, simklHistoryPayload, sendSimklWatched, simklMediaMatches } from "../server/src/utils/trackers/simklClient.js";

makeTempDataDir("plekt-simkl-adapter-");
const { simklAdapter, classifySimklError, writeSimklWatched, readSimklSnapshot } = await import("../server/src/utils/trackers/simkl.js");
const { isTrackerProvider, assertTrackerSafetyGate } = await import("../server/src/utils/trackers/registry.js");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");

const connection = { clientId: "client", accessToken: "private-token" };
const cursor = "2026-10-21T12:00:00Z";
const date = "2026-10-01T12:00:00Z";
const movie = { status: "completed", last_watched_at: date, user_rating: null, movie: { title: "Movie", ids: { tmdb: 1, imdb: "tt0000001", simkl: 9 } } };
const show = { status: "completed", watched_episodes_count: 1, show: { title: "Show", ids: { tvdb: 2, simkl: 10 } }, seasons: [{ number: 1, episodes: [{ number: 1, watched_at: date, ids: { simkl: 101 } }] }] };
const partitions = () => ({ movies: [structuredClone(movie)], shows: [structuredClone(show)], anime: [] });
const media = { type: "movie", ids: { tmdb: 1 }, watched_at: date };
async function withFetch(handler, work) {
  simklTransport.resetForTests();
  const previous = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await handler(...args);
    if (!response.headers.has('x-ratelimit-remaining')) response.headers.set('x-ratelimit-remaining', '400');
    if (!response.headers.has('x-ratelimit-limit')) response.headers.set('x-ratelimit-limit', '500');
    return response;
  };
  try { return await work(); } finally { globalThis.fetch = previous; }
}
function snapshotResponse(url) {
  const path = new URL(url).pathname;
  if (path === "/sync/activities") return Response.json({ all: cursor });
  if (path === "/sync/all-items") return Response.json(partitions());
  const type = path.split("/")[3];
  return Response.json({ [type]: partitions()[type] });
}

test('rating-only changes and explicit removals are read even when watched delta is empty', async () => {
  for (const rating of [7, null, undefined]) {
    const calls=[];
    await withFetch(url=>{
      const u=new URL(url);calls.push(u.pathname);
      if(u.pathname==='/sync/activities')return Response.json({all:cursor,movies:{rated_at:cursor}});
      if(u.pathname==='/sync/all-items')return Response.json({});
      assert.equal(u.pathname,'/sync/ratings');assert.equal(u.searchParams.get('date_from'),date);
      const row={...movie};
      if(rating===undefined)delete row.user_rating;else row.user_rating=rating;
      return Response.json({movies:[row]});
    },async()=>{
      const snapshot=await fetchSimklSnapshot(connection,{trigger:'user',dateFrom:date});
      assert.equal(snapshot.ratings.length,rating===7?1:0);
      assert.equal(snapshot.unrated.length,rating===null?1:0);
      assert.equal(snapshot.watched.length,0,'Rating feed must never create watched events');
      assert.equal(snapshot.review.length,0);
      assert.deepEqual(calls,['/sync/activities','/sync/all-items','/sync/ratings']);
    });
  }
});

test('rating delta supersedes stale library rating and needs no show episode coverage', async()=>{
  await withFetch(url=>{
    const path=new URL(url).pathname;
    if(path==='/sync/activities')return Response.json({all:cursor,tv_shows:{rated_at:cursor},movies:{rated_at:cursor}});
    if(path==='/sync/all-items')return Response.json({movies:[{...movie,user_rating:6}]});
    assert.equal(path,'/sync/ratings');
    return Response.json({movies:[{...movie,user_rating:null}],shows:[{show:show.show,user_rating:8}]});
  },async()=>{
    const snapshot=await fetchSimklSnapshot(connection,{trigger:'event',dateFrom:date});
    assert.equal(snapshot.ratings.length,1);assert.equal(snapshot.ratings[0].rating,8);
    assert.equal(snapshot.unrated.length,1);assert.equal(snapshot.unrated[0].providerItemId,'9');
    assert.equal(snapshot.watched.length,0);
  });
});

test('failed or malformed supplemental ratings fails the snapshot instead of advancing its cursor',async()=>{
  for(const response of [()=>Response.json({unexpected:[]}),()=>Response.json({movies:{}}),()=>Response.json({error:'unavailable'},{status:503})]){
    await withFetch(url=>{
      const path=new URL(url).pathname;
      if(path==='/sync/activities')return Response.json({all:cursor,anime:{rated_at:cursor}});
      if(path==='/sync/all-items')return Response.json({});
      assert.equal(path,'/sync/ratings');return response();
    },async()=>assert.rejects(fetchSimklSnapshot(connection,{trigger:'user',dateFrom:date})));
  }
});

function managedIntent(status = "pending") {
  // Independent fixtures must not inherit another fixture's durable quota hold.
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  db.prepare("DELETE FROM tracker_write_intents").run();
  db.prepare("DELETE FROM tracker_connections").run();
  repo.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "account", accessToken: "private-token", refreshToken: "private-refresh", accessTokenExpiresAt: Date.now() + 3600_000 });
  const saved = repo.getTrackerConnection("simkl", { includeCredentials: true });
  db.prepare(`INSERT INTO tracker_write_intents (id,provider,connection_id,account_id,logical_key,media_key,media_json,action,watched_at,event_type,fingerprint,status,due_at,expires_at,created_at,updated_at)
    VALUES ('intent','simkl',?,'account','play','movie:tmdb:1',?,'watched',?,'watch','fingerprint',?,0,?,?,?)`)
    .run(saved.id, JSON.stringify(media), date, status, Date.now() + 86400_000, Date.now(), Date.now());
  return saved;
}
const intentStatus = () => db.prepare("SELECT status FROM tracker_write_intents WHERE id='intent'").get()?.status;

test("Simkl durable writes batch and confirm through a watched lookup without full library reads", async () => {
  const saved = managedIntent();
  let posts = 0;
  await withFetch((url, options) => {
    const path = new URL(url).pathname;
    if (path === '/sync/history') { posts++; return Response.json({ added: { movies: 1, episodes: 0 }, not_found: {} }); }
    assert.ok(['/sync/activities','/sync/watched'].includes(path));
    if (path === '/sync/activities') return Response.json({ all: posts ? '2026-10-21T12:01:00Z' : cursor });
    return Response.json(JSON.parse(options.body).map(({ ids }) => ({ ids, result: true, list: 'completed', last_watched_at: date })));
  }, async () => {
    assert.deepEqual(await writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "user" }), { alreadySatisfied: false });
    assert.equal(intentStatus(), "settled");
    assert.equal(posts, 1);
  });
});

test("Simkl settles an item it already reported watched without any request", async () => {
  const saved = managedIntent();
  db.prepare(`INSERT INTO tracker_observations (id,provider,connection_id,account_id,observation_key,kind,observation_json,status,reason,created_at,updated_at)
    VALUES ('seen','simkl',?,'account','watched:movie:tmdb:1','watched',?,'observed','',0,0)`)
    .run(saved.id, JSON.stringify({ media: { type: "movie", ids: { tmdb: 1, simkl: 9 } }, watchedAt: Date.parse(date) }));
  try {
    await withFetch(() => assert.fail("no Simkl request for an item Simkl already reported"), async () => {
      assert.deepEqual(await writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "event" }), { alreadySatisfied: true });
      assert.equal(intentStatus(), "settled");
    });
  } finally { db.prepare("DELETE FROM tracker_observations").run(); }
});

test("Simkl uncertain and cancelled intents cannot send; lost responses are held", async () => {
  for (const status of ["uncertain", "cancelled"]) {
    const saved = managedIntent(status);
    await withFetch(() => { throw new Error("must not fetch"); }, async () => {
      await assert.rejects(writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "user" }), { code: "TRACKER_REVIEW_REQUIRED" });
      assert.equal(intentStatus(), status === "uncertain" ? "review" : "cancelled");
    });
  }
  const saved = managedIntent();
  let posts = 0;
  await withFetch((url, options) => {
    if (new URL(url).pathname === "/sync/history") { posts++; throw new Error("lost response"); }
    if (new URL(url).pathname === "/sync/watched") return Response.json([{ result: false }]);
    if (new URL(url).pathname === "/sync/all-items/movies") return Response.json({ movies: [] });
    return snapshotResponse(url);
  }, async () => {
    await assert.rejects(writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "event" }));
    assert.equal(posts, 1);
    assert.equal(intentStatus(), "review");
    await assert.rejects(writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "event" }));
    assert.equal(posts, 1);
  });
});

test("Simkl fenced snapshot discards late responses from a replaced account", async () => {
  const saved = managedIntent();
  await withFetch((url) => {
    if (new URL(url).pathname === "/sync/all-items/anime") repo.saveTrackerConnection({ provider: "simkl", clientId: "client", remoteUserId: "replacement", accessToken: "new-token", refreshToken: "new-refresh" });
    return snapshotResponse(url);
  }, async () => {
    await assert.rejects(readSimklSnapshot(saved, { trigger: "user" }), { code: "TRACKER_CONNECTION_STALE" });
    assert.equal(repo.getTrackerConnection("simkl").remoteUserId, "replacement");
  });
});

test("Simkl successful POST followed by readback rejection stays held without a second send", async () => {
  const saved = managedIntent();
  let posts = 0;
  await withFetch((url, options) => {
    if (options.method === "POST") { posts++; return Response.json({ added: { movies: 1, episodes: 0 }, not_found: {} }); }
    if (posts) return Response.json({ error: "rate_limit" }, { status: 429 });
    if (new URL(url).pathname === "/sync/all-items/movies") return Response.json({ movies: [] });
    return snapshotResponse(url);
  }, async () => {
    await assert.rejects(writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "user" }), { status: 429, uncertainOutcome: true });
    assert.equal(intentStatus(), "review");
    await assert.rejects(writeSimklWatched(saved, { ...media, trackerWriteIntentId: "intent" }, { trigger: "user" }));
    assert.equal(posts, 1);
  });
});

test("Simkl adapter refreshes encrypted credentials once after a read 401", async () => {
  const saved = managedIntent();
  let refreshes = 0;
  await withFetch((url, options) => {
    if (new URL(url).pathname === "/oauth2/token") {
      refreshes++;
      return Response.json({ access_token: "fresh-token", refresh_token: "fresh-refresh", token_type: "Bearer", scope: "media:read media:write", expires_in: 3600 });
    }
    if (options.headers.authorization !== "Bearer fresh-token") return Response.json({}, { status: 401 });
    return snapshotResponse(url);
  }, async () => {
    assert.equal((await readSimklSnapshot(saved, { trigger: "user" })).watched.length, 2);
    assert.equal(refreshes, 1);
    assert.equal(repo.getTrackerConnection("simkl", { includeCredentials: true }).accessToken, "fresh-token");
  });
});

test("Simkl expired intents and unresolved identities enter review before any provider call", async () => {
  for (const expired of [true, false]) {
    const saved = managedIntent();
    const item = expired ? media : { ...media, ids: { simkl: 1 } };
    db.prepare("UPDATE tracker_write_intents SET expires_at=?,media_json=? WHERE id='intent'").run(expired ? 1 : Date.now() + 86400_000, JSON.stringify(item));
    await withFetch(() => { throw new Error("must not fetch"); }, async () => {
      await assert.rejects(writeSimklWatched(saved, { ...item, trackerWriteIntentId: "intent" }, { trigger: "user" }), { code: "TRACKER_REVIEW_REQUIRED" });
      assert.equal(intentStatus(), "review");
    });
  }
});

test("registered Simkl adapter keeps unsupported operations and scheduled reads disabled", async () => {
  assert.equal(isTrackerProvider("simkl"), true);
  assert.equal(assertTrackerSafetyGate(simklAdapter), simklAdapter);
  assert.throws(() => assertTrackerSafetyGate({ ...simklAdapter }), { code: "TRACKER_SAFETY_GATE" });
  for (const operation of ["unwatchedWrite", "repeatHistoryWrite", "datedHistoryWrite", "existingDateMutation", "watchlist"]) {
    assert.throws(() => executeTrackerOperation(simklAdapter, operation, { mediaType: "movie", trigger: "user" }, connection, media), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  }
  await withFetch(() => { throw new Error("must not contact provider"); }, async () => {
    await assert.rejects(fetchSimklSnapshot(connection, { trigger: "scheduled" }), { code: "TRACKER_UNSUPPORTED_OPERATION" });
    await assert.rejects(writeSimklWatched(connection, media, { trigger: "user" }), { code: "TRACKER_REVIEW_REQUIRED" });
  });
});

test("Simkl normalizes common IDs and observed dates without title-based matching", () => {
  const result = normalizeSimklRows(partitions());
  assert.equal(result.watched.length, 2);
  assert.equal(result.watched[0].watchedAt, Date.parse(date));
  assert.equal(result.watched[1].mediaKey, "episode:tvdb:2:s1e1");
  assert.equal(result.watched[1].media.episodeIds.simkl, "101");
  assert.equal(simklMediaMatches(result.watched[0].media, media), true);
  assert.equal(simklMediaMatches(result.watched[0].media, { type: "movie", title: "Movie", ids: { tmdb: 99 } }), false);
  assert.equal(simklMediaMatches(result.watched[1].media, { type: "episode", ids: { tvdb: 2 }, season: 2, episode: 1 }), false);
  assert.throws(() => simklMediaMatches(result.watched[0].media, { type: "movie", ids: { tmdb: 1, imdb: "tt9999999" } }), { code: "TRACKER_REVIEW_REQUIRED" });
});

test("Simkl unknown dates never become current-time anchors; anime/specials and coverage gaps are held", () => {
  const rows = partitions();
  rows.movies[0].last_watched_at = "1970-01-01T00:00:01Z";
  rows.shows[0].watched_episodes_count = 2;
  rows.anime.push({ ...structuredClone(show), show: { title: "Anime", ids: { mal: 1, simkl: 20 } } });
  const result = normalizeSimklRows(rows);
  assert.equal(result.watched[0].watchedAt, null);
  assert.equal(result.watched[0].timestampProvenance, "unknown");
  assert.deepEqual(result.review.map((row) => row.reason), ["incomplete_episode_coverage", "episode_mapping_required"]);
  rows.shows[0].seasons[0].number = 0;
  assert.equal(normalizeSimklRows(rows).watched.length, 1);
});

test("Simkl counts regular episodes separately while holding recorded specials for review", () => {
  const rows = partitions();
  rows.shows[0].seasons.push({ number: 0, episodes: [{ number: 1, watched_at: date }] });
  const result = normalizeSimklRows(rows);
  assert.equal(result.watched.filter((item) => item.media.type === "episode").length, 1);
  assert.deepEqual(result.review.map((item) => item.reason), ["episode_mapping_required"]);
  rows.shows[0].watched_episodes_count = 2;
  assert.deepEqual(normalizeSimklRows(rows).review.map((item) => item.reason),
    ["episode_mapping_required", "incomplete_episode_coverage"]);
  rows.shows[0].watched_episodes_count = 0;
  assert.throws(() => normalizeSimklRows(rows), { code: "SIMKL_INCOMPLETE_SNAPSHOT" });
  rows.shows[0].seasons.shift();
  assert.deepEqual(normalizeSimklRows(rows).review.map((item) => item.reason), ["episode_mapping_required"]);
});

test("Simkl ratings remain independent observations and ambiguous movie watches are held", () => {
  const rows = partitions();
  rows.movies[0].user_rating = 8;
  rows.movies[0].user_rated_at = date;
  const result = normalizeSimklRows(rows);
  assert.equal(result.ratings[0].rating, 8);
  assert.equal(result.ratings[0].media.media_type, "movie");
  assert.equal(result.watched.length, 1);
  assert.equal(result.review[0].reason, "rating_watch_ambiguity");
});

test("Simkl rejects malformed, duplicate and truncated snapshot rows", () => {
  for (const mutate of [
    (rows) => delete rows.anime,
    (rows) => rows.movies.push(rows.movies[0]),
    (rows) => rows.movies[0].status = "unexpected",
    (rows) => rows.movies[0].movie.ids = {},
    (rows) => rows.movies[0].user_rating = 11,
    (rows) => rows.shows[0].seasons[0].episodes = null,
    (rows) => rows.shows[0].watched_episodes_count = 0,
    (rows) => rows.shows[0].seasons[0].episodes.push(rows.shows[0].seasons[0].episodes[0]),
  ]) {
    const rows = partitions(); mutate(rows);
    assert.throws(() => normalizeSimklRows(rows), { code: "SIMKL_INCOMPLETE_SNAPSHOT" });
  }
});

test("Simkl activity-gated reads identify the app and never authorize absence reconciliation", async () => {
  const calls = [];
  await withFetch((url, options) => {
    const parsed = new URL(url); calls.push(parsed);
    assert.equal(parsed.searchParams.get("client_id"), "client");
    assert.equal(parsed.searchParams.get("app-name"), "plekt");
    assert.equal(options.headers.authorization, "Bearer private-token");
    assert.equal(parsed.href.includes("private-token"), false);
    return snapshotResponse(url);
  }, async () => {
    const snapshot = await fetchSimklSnapshot(connection, { trigger: "user" });
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.absenceReconciliation, false);
    assert.equal(calls[0].pathname, "/sync/activities");
    assert.equal(calls[1].searchParams.get("include_all_episodes"), "original");
    calls.length = 0;
    const unchanged = await fetchSimklSnapshot(connection, { trigger: "event", dateFrom: cursor });
    assert.equal(calls.length, 1);
    assert.equal(unchanged.complete, false);
    const delta = await fetchSimklSnapshot(connection, { trigger: "event", dateFrom: date });
    assert.equal(delta.complete, false);
    assert.equal(calls.length, 3, "unchanged check plus activities and one combined delta");
    assert.equal(calls[2].pathname, "/sync/all-items");
    assert.equal(calls[2].searchParams.get("date_from"), date);
  });
});

test("Simkl filtered empty objects are valid baseline and delta partitions", async () => {
  await withFetch((url) => new URL(url).pathname === "/sync/activities"
    ? Response.json({ all: cursor }) : Response.json({}), async () => {
    for (const dateFrom of [undefined, date]) {
      const result = await fetchSimklSnapshot(connection, { trigger: "user", dateFrom });
      assert.deepEqual(result.watched, []);
      assert.deepEqual(result.review, []);
      assert.equal(result.cursor, cursor);
      assert.equal(result.complete, !dateFrom);
      assert.equal(result.absenceReconciliation, false);
    }
  });
});

test("Simkl nonempty malformed partitions still reject the entire delta", async () => {
  for (const response of [{ shows: null }, { movies: null }, { movies: {} }, { unexpected: true }]) {
    await withFetch((url) => new URL(url).pathname === "/sync/activities"
      ? Response.json({ all: cursor }) : Response.json(response), async () => {
      await assert.rejects(fetchSimklSnapshot(connection, { trigger: "user", dateFrom: date }), { code: "SIMKL_INCOMPLETE_SNAPSHOT" });
    });
  }
});

test("Simkl max_items splits every status; failed partitions discard the entire read", async () => {
  const calls = [];
  await withFetch((url) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path === "/sync/all-items/shows") return Response.json({ error: "max_items" }, { status: 400 });
    if (path.startsWith("/sync/all-items/shows/")) return Response.json(path.endsWith("/completed") ? { shows: [show] } : {});
    return snapshotResponse(url);
  }, async () => {
    assert.equal((await fetchSimklSnapshot(connection, { trigger: "user" })).watched.length, 2);
    assert.equal(calls.filter((path) => path.startsWith("/sync/all-items/shows/")).length, 5);
  });
  await withFetch((url) => {
    const path = new URL(url).pathname;
    if (path === "/sync/all-items/shows") return Response.json({ error: "max_items" }, { status: 400 });
    if (path.endsWith("/hold")) return Response.json({ private: "private-token" }, { status: 503 });
    if (path.startsWith("/sync/all-items/shows/")) return Response.json({ shows: [] });
    return snapshotResponse(url);
  }, async () => assert.rejects(fetchSimklSnapshot(connection, { trigger: "user" }), { status: 503 }));
});

test("Simkl payload bounds writes to one explicit movie/episode without rewatch or date compensation", () => {
  assert.deepEqual(simklHistoryPayload(media), { movies: [{ ids: { tmdb: "1" }, watched_at: date }] });
  assert.deepEqual(simklHistoryPayload({ ...media, type: "episode", season: 1, episode: 2 }), { shows: [{ ids: { tmdb: "1" }, seasons: [{ number: 1, episodes: [{ number: 2, watched_at: date }] }] }] });
  assert.deepEqual(simklHistoryPayload({ ...media, type: "tv" }), { shows: [{ ids: { tmdb: "1" }, watched_at: date }] });
  assert.deepEqual(simklHistoryPayload({ ...media, type: "show" }), { shows: [{ ids: { tmdb: "1" }, watched_at: date }] });
  for (const changes of [{ watched_at: null }, { ids: {} }, { ids: { simkl: 1 } }, { simklType: "anime" }, { type: "episode", season: 0, episode: 1 }]) assert.throws(() => simklHistoryPayload({ ...media, ...changes }), { code: "TRACKER_REVIEW_REQUIRED" });
});

test("Simkl zero-add HTTP success requires watched-state readback", async () => {
  for (const present of [true, false]) {
    await withFetch((url, options) => {
      if (options.method === "POST") {
        assert.equal(new URL(url).searchParams.get("skip_auto_watching"), "yes");
        assert.equal(options.body.includes("allow_rewatch"), false);
        return Response.json({ added: { movies: 0 }, not_found: { movies: [] } });
      }
      if (!present && new URL(url).pathname === "/sync/all-items/movies") return Response.json({ movies: [] });
      return snapshotResponse(url);
    }, async () => {
      if (present) await sendSimklWatched(connection, media, { trigger: "user" });
      else await assert.rejects(sendSimklWatched(connection, media, { trigger: "user" }), { code: "TRACKER_REVIEW_REQUIRED" });
    });
  }
});

test("Simkl errors classify auth, forbidden, not-found, conflicts, backoff and transient failures without leaking bodies", async () => {
  for (const [status, kind] of [[401, "reauth_required"], [403, "forbidden"], [404, "not_found"], [409, "review_required"], [429, "rate_limited"], [503, "transient"]]) {
    await withFetch(() => Response.json({ error: "private-token", detail: "private-token" }, { status, headers: { "retry-after": "7" } }), async () => {
      await assert.rejects(fetchSimklSnapshot(connection, { trigger: "user" }), (error) => {
        assert.equal(classifySimklError(error), kind);
        assert.equal(error.retryAfter, 7);
        assert.equal(JSON.stringify(error).includes("private-token"), false);
        assert.equal(error.message.includes("private-token"), false);
        return true;
      });
    });
  }
});

test("shared tracker snapshot read passes the user trigger through to Simkl", async () => {
  managedIntent();
  const { readTrackerSnapshot } = await import("../server/src/utils/trackers/connections.js");
  const read = await withFetch(snapshotResponse, () => readTrackerSnapshot("simkl", { trigger: "user" }));
  assert.equal(read.snapshot.complete, true);
  assert.equal(read.snapshot.watched.length, 2);
});
