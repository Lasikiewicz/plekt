import test from "node:test";
import assert from "node:assert/strict";
import { sendSimklWatchedBatch } from "../server/src/utils/trackers/simklBatchClient.js";

const connection = { clientId: "client", accessToken: "token" };
const cursor = "2026-10-20T10:00:00Z";
const media = [
  { type: "movie", title: "Added Movie", ids: { tmdb: "10", imdb: "tt100" }, watched_at: "2026-10-20T10:01:00Z" },
  { type: "movie", title: "Missing Movie", ids: { tmdb: "11" }, watched_at: "2026-10-20T10:02:00Z" },
  { type: "episode", title: "Show", ids: { tvdb: "20" }, season: 1, episode: 2, watched_at: "2026-10-20T10:03:00Z" },
  { type: "episode", title: "Show", ids: { tvdb: "20" }, season: 1, episode: 3, watched_at: "2026-10-20T10:04:00Z" },
];

// Simkl's current watch-through, answered the way POST /sync/watched does.
const successState = { movies: { 10: media[0].watched_at }, shows: { 20: { "1:2": media[2].watched_at, "1:3": media[3].watched_at } } };
const emptyState = { movies: {}, shows: {} };

function watchedRows(body, state) {
  return body.map(({ type, ids }) => {
    if (type === "movie") {
      const at = state.movies[ids.tmdb];
      return at ? { ids, result: true, list: "completed", last_watched_at: at } : { ids, result: false };
    }
    const episodes = state.shows[ids.tvdb];
    if (!episodes) return { ids, result: false };
    const seasons = new Map();
    for (const [key, at] of Object.entries(episodes)) {
      const [season, number] = key.split(":").map(Number);
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push({ number, watched: true, aired: true, last_watched_at: at });
    }
    return { ids, result: true, list: "watching", seasons: [...seasons].map(([number, list]) => ({ number, episodes: list })) };
  });
}

function fixture({ post, simkl = successState, watched, activities = { all: "2026-10-20T10:05:00Z" } } = {}) {
  const calls = [];
  const request = async (_connection, path, options = {}) => {
    calls.push({ path, options });
    if (path === "/sync/history") return { data: post, metadata: { quotaRemaining: 42 } };
    if (path === "/sync/activities") return { data: activities, metadata: { quotaRemaining: 41 } };
    if (path === "/sync/watched") return { data: watched ?? watchedRows(options.body, simkl), metadata: { quotaRemaining: 40 } };
    throw new Error(`Unexpected request ${path}`);
  };
  return { request, calls };
}

test("accepts a live large-batch history response that omits not_found and echoes added.statuses", async () => {
  // Live 23 October full apply: 100 episodes, added.shows 24, added.episodes 99,
  // a long statuses echo, and no not_found key. Readback is authoritative.
  const episodes = Array.from({ length: 3 }, (_, i) => ({
    type: "episode", title: `Show S01E${i + 1}`, ids: { tvdb: "20" }, season: 1, episode: i + 1,
    watched_at: `2026-10-20T10:0${i + 1}:00Z`,
  }));
  const { request } = fixture({
    post: {
      added: {
        movies: 0,
        shows: 1,
        episodes: 3,
        statuses: [{
          request: { ids: { tvdb: "20" }, type: "show", rating: null },
          response: { status: "watching", simkl_type: "tv", anime_type: null },
        }],
      },
    },
    simkl: { movies: {}, shows: { 20: { "1:1": episodes[0].watched_at, "1:2": episodes[1].watched_at, "1:3": episodes[2].watched_at } } },
  });
  const result = await sendSimklWatchedBatch(connection, episodes, {
    trigger: "user", preSendCursor: cursor, request,
  });
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["confirmed", "confirmed", "confirmed"]);
});

test("accepts live Simkl added.statuses echo without treating it as an ambiguous outcome", async () => {
  const { request } = fixture({
    post: {
      added: {
        movies: 1,
        shows: 0,
        episodes: 0,
        statuses: [{
          request: { ids: { imdb: "tt100", tmdb: "10" }, watched_at: media[0].watched_at, type: "movie", rating: null },
          response: { status: "completed", simkl_type: "movie", anime_type: null },
        }],
      },
      not_found: { movies: [], shows: [], episodes: [] },
    },
  });
  const result = await sendSimklWatchedBatch(connection, [media[0]], {
    trigger: "user", preSendCursor: cursor, request,
  });
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["confirmed"]);
});

test("sends a mixed movie/episode history body with each item's observed timestamp and one watched readback", async () => {
  const { request, calls } = fixture({
    post: { added: { movies: 1, episodes: 2 }, not_found: { movies: [], episodes: [] } },
  });
  const result = await sendSimklWatchedBatch(connection, media.filter((_, i) => i !== 1), {
    trigger: "user", preSendCursor: cursor, request,
  });
  const post = calls[0];
  assert.equal(post.path, "/sync/history");
  assert.deepEqual(post.options.query, { skip_auto_watching: "yes" });
  assert.deepEqual(post.options.body, {
    movies: [{ ids: { tmdb: "10", imdb: "tt100" }, watched_at: media[0].watched_at }],
    shows: [{ ids: { tvdb: "20" }, seasons: [{ number: 1, episodes: [
      { number: 2, watched_at: media[2].watched_at },
      { number: 3, watched_at: media[3].watched_at },
    ] }] }],
  });
  assert.deepEqual(calls.map((call) => call.path), ["/sync/history", "/sync/activities", "/sync/watched"]);
  assert.deepEqual(calls[2].options.query, { extended: "episodes" });
  assert.deepEqual(calls[2].options.body, [
    { type: "movie", ids: { tmdb: "10", imdb: "tt100" } },
    { type: "show", ids: { tvdb: "20" } },
  ]);
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["confirmed", "confirmed", "confirmed"]);
  assert.deepEqual(result.quota, { quotaRemaining: 40 });
});

test("returns a per-item not_found outcome when Simkl identifies the unmatched item", async () => {
  const { request, calls } = fixture({
    post: {
      added: { movies: 1, episodes: 2 },
      not_found: { movies: [{ movie: { ids: { tmdb: "11" } } }], episodes: [] },
    },
  });
  const result = await sendSimklWatchedBatch(connection, media, { trigger: "event", preSendCursor: cursor, request });
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["confirmed", "not_found", "confirmed", "confirmed"]);
  assert.equal(calls.filter(({ path }) => path === "/sync/history").length, 1);
});

test("malformed partial counts fall through to watched readback without a second POST", async () => {
  const { request, calls } = fixture({
    post: { added: { movies: 3, episodes: 1 }, not_found: { movies: [], episodes: [] } },
  });
  const result = await sendSimklWatchedBatch(connection, media, { trigger: "user", preSendCursor: cursor, request });
  assert.equal(calls.filter(({ path }) => path === "/sync/history").length, 1);
  assert.ok(calls.some(({ path }) => path === "/sync/watched"));
  // successState confirms movie 10 and episodes; missing movie 11 stays review.
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["confirmed", "review", "confirmed", "confirmed"]);
});

test("holds a chunk after watched readback failure without sending it again", async () => {
  const { request, calls } = fixture({
    post: { added: { movies: 1, episodes: 2 }, not_found: { movies: [], episodes: [] } },
    watched: [{ ids: { tmdb: "10" }, result: true, list: "completed" }],
  });
  await assert.rejects(sendSimklWatchedBatch(connection, media.filter((_, i) => i !== 1), {
    trigger: "user", preSendCursor: cursor, request,
  }), { code: "TRACKER_REVIEW_REQUIRED", uncertainOutcome: true, noResend: true });
  assert.deepEqual(calls.map(({ path }) => path), ["/sync/history", "/sync/activities", "/sync/watched"]);
});

test("marks a lost POST response uncertain and makes no resend attempt", async () => {
  let writes = 0;
  const calls = [];
  const request = async (_connection, path) => {
    calls.push(path);
    if (path === "/sync/history") { writes += 1; throw new Error("simulated lost response"); }
    if (path === "/sync/activities") return { data: { all: "2026-10-20T10:05:00Z" }, metadata: {} };
    if (path === "/sync/watched") return { data: [{ result: false }], metadata: {} };
  };
  await assert.rejects(sendSimklWatchedBatch(connection, [media[0]], {
    trigger: "user", preSendCursor: cursor, request,
  }), { message: "simulated lost response", uncertainOutcome: true, noResend: true });
  assert.equal(writes, 1);
  assert.deepEqual(calls, ["/sync/history", "/sync/activities", "/sync/watched"]);
});

test("rejects unknown dates, anime, duplicate identities, and oversized chunks before networking", async () => {
  let calls = 0;
  const request = async () => { calls += 1; };
  for (const invalid of [
    [{ ...media[0], watched_at: "1970-01-01T00:00:01Z" }],
    [{ ...media[2], simklType: "anime" }],
    [media[0], media[0]],
    Array.from({ length: 101 }, () => media[0]),
  ]) {
    await assert.rejects(sendSimklWatchedBatch(connection, invalid, { trigger: "user", preSendCursor: cursor, request }), {
      code: "TRACKER_REVIEW_REQUIRED",
    });
  }
  assert.equal(calls, 0);
});
test('zero-add readback preserves an existing observed date and unmatched items go individually to review', async () => {
  const {request}=fixture({post:{added:{movies:0,episodes:0,shows:0},not_found:{movies:[],episodes:[],shows:[]}}});
  const result=await sendSimklWatchedBatch(connection,[{...media[0],watched_at:'2026-10-19T12:00:00Z'},media[1]],{trigger:'user',preSendCursor:cursor,request});
  assert.deepEqual(result.outcomes.map(row=>row.status),['confirmed','review']);
  assert.equal(result.counts.confirmed,1);
});
test('episode rejection with numeric coordinates is assigned to the exact item',async()=>{
  const {request}=fixture({post:{added:{movies:0,episodes:0},not_found:{episodes:[{ids:media[2].ids,season:1,episode:2}]}},simkl:emptyState});
  const result=await sendSimklWatchedBatch(connection,[media[2]],{trigger:'user',preSendCursor:cursor,request});
  assert.equal(result.outcomes[0].status,'not_found');
});
test('a whole-show rejection marks only that show\'s episodes not found and keeps the batch readable',async()=>{
  const unknown={type:'episode',title:'Unknown',ids:{imdb:'tt999'},season:10,episode:10,watched_at:'2026-10-20T10:06:00Z'};
  const {request}=fixture({post:{added:{movies:1,episodes:0},not_found:{movies:[],episodes:[],shows:[{ids:{imdb:'tt999'},seasons:[{number:10,episodes:[{number:10}]}]}]}}});
  const result=await sendSimklWatchedBatch(connection,[media[0],unknown],{trigger:'user',preSendCursor:cursor,request});
  assert.deepEqual(result.outcomes.map(row=>row.status),['confirmed','not_found']);
});
test('a whole-show rejection that matches no sent show falls through to watched readback',async()=>{
  const {request}=fixture({post:{added:{movies:1,episodes:2},not_found:{movies:[],episodes:[],shows:[{ids:{imdb:'tt404'}}]}}});
  const result=await sendSimklWatchedBatch(connection,media.filter((_,i)=>i!==1),{trigger:'user',preSendCursor:cursor,request});
  assert.deepEqual(result.outcomes.map(row=>row.status),['confirmed','confirmed','confirmed']);
});
test('an episode Simkl files as a past watch-through is not confirmed by the watched readback',async()=>{
  // Live 23 October: added counted both episodes, but /sync/watched kept them
  // unwatched because the show already had newer progress.
  const {request}=fixture({post:{added:{movies:0,episodes:2},not_found:{movies:[],episodes:[],shows:[]}},
    simkl:{movies:{},shows:{20:{'12:1':'2024-11-13T20:23:42Z'}}}});
  const result=await sendSimklWatchedBatch(connection,[media[2],media[3]],{trigger:'user',preSendCursor:cursor,request});
  assert.deepEqual(result.outcomes.map(row=>row.status),['review','review']);
  assert.equal(result.counts.confirmed,0);
});
test('a watched readback whose echoed ids disagree with the request holds the batch',async()=>{
  const {request}=fixture({post:{added:{movies:1},not_found:{movies:[]}},watched:[{ids:{tmdb:'99'},result:true,list:'completed',last_watched_at:media[0].watched_at}]});
  await assert.rejects(sendSimklWatchedBatch(connection,[media[0]],{trigger:'user',preSendCursor:cursor,request}),{code:'TRACKER_REVIEW_REQUIRED',uncertainOutcome:true,noResend:true});
});
