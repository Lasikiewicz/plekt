import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-manual-watch-batch-route-");
process.env.WATCHED_PLAYED_SYNC_ENABLED = "true";

const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { saveMediaConfig } = await import("../server/src/utils/configStore.js");
const trackerConnectionRepo = await import("../server/src/utils/trackerConnectionRepo.js");
const { handleManualWatch } = await import("../server/src/routes/sync.js");

function resetState() {
  db.prepare('DELETE FROM tracker_write_intents').run();
  db.prepare("DELETE FROM settings WHERE id LIKE 'simkl-batch-budget:%'").run();
  db.prepare("DELETE FROM tracker_item_state").run();
  db.prepare("DELETE FROM tracker_connections").run();
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playstate").run();
}

function connectTrakt() {
  trackerConnectionRepo.saveTrackerConnection({
    provider: "trakt",
    status: "connected",
    remoteUserId: "user-1",
    remoteUsername: "tester",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    initialSyncMode: "baseline",
    baselineComplete: true,
    lastValidatedAt: Date.now(),
  });
}

function requestResponse(body) {
  const headers = { "x-api-key": AUTH.apiKey };
  let statusCode = 200;
  let responseBody = null;
  return {
    req: {
      method: "POST",
      body,
      headers,
      cookies: {},
      get(name) { return headers[String(name).toLowerCase()] || ""; },
    },
    res: {
      status(code) { statusCode = code; return this; },
      set() { return this; },
      send(payload) { responseBody = JSON.parse(payload); return this; },
    },
    status: () => statusCode,
    body: () => responseBody,
  };
}

function record(number) {
  return {
    media_type: "episode",
    title: `Grouped Route Show - S01E${String(number).padStart(2, "0")}`,
    tmdb_id: "grouped-route-show",
    season: 1,
    episode: number,
    watched_at: `2026-08-${String(10 + number).padStart(2, "0")}T12:00:00.000Z`,
  };
}

test("manual show watch uses grouped Trakt writes instead of one pair per episode", async () => {
  resetState();
  connectTrakt();
  await saveMediaConfig({
    plex: { disabled: true, authMode: "manual" },
    emby: { disabled: true, authMode: "manual" },
    jellyfin: { disabled: true, authMode: "manual" },
  });

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ href, body });
    if (href === "https://api.trakt.tv/sync/history/remove") {
      return new Response(JSON.stringify({ deleted: { episodes: 3 }, not_found: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.trakt.tv/sync/history") {
      return new Response(JSON.stringify({ added: { episodes: 3 }, not_found: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound request: ${href}`);
  };

  try {
    const http = requestResponse({ records: [record(1), record(2), record(3)] });
    await handleManualWatch(http.req, http.res);

    assert.equal(http.status(), 200);
    assert.equal(http.body().propagated, 3);
    assert.equal(http.body().rejected, 0);
    assert.equal(requests.filter(({ href }) => href === "https://api.trakt.tv/sync/history/remove").length, 1);
    assert.equal(requests.filter(({ href }) => href === "https://api.trakt.tv/sync/history").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual bulk movie route gathers 100 Simkl writes and persists confirmed per-row outcomes',async()=>{
  resetState();
  trackerConnectionRepo.saveTrackerConnection({provider:'simkl',clientId:'offline',remoteUserId:'offline',accessToken:'fake',refreshToken:'fake',accessTokenExpiresAt:Date.now()+3600_000});
  await saveMediaConfig({plex:{disabled:true},emby:{disabled:true},jellyfin:{disabled:true}});
  const {simklTransport}=await import('../server/src/utils/trackers/simklTransport.js');
  simklTransport.resetForTests();
  const previous=globalThis.fetch,calls=[];let posted=[];
  globalThis.fetch=async(url,init)=>{
    const u=new URL(url);assert.equal(u.hostname,'api.simkl.com');calls.push([init.method,u.pathname]);
    let data;
    if(u.pathname==='/sync/history') {posted=JSON.parse(init.body).movies;data={added:{movies:posted.length,episodes:0},not_found:{}};}
    else if(u.pathname==='/sync/activities')data={all:'2026-10-23T09:00:00Z'};
    else {assert.equal(u.pathname,'/sync/watched');data=JSON.parse(init.body).map(({ids})=>({ids,result:true,list:'completed',last_watched_at:posted.find(m=>m.ids.tmdb===ids.tmdb).watched_at}));}
    return Response.json(data,{headers:{'x-ratelimit-remaining':'400','x-ratelimit-limit':'500'}});
  };
  try {
    const records=Array.from({length:100},(_,i)=>({media_type:'movie',title:`Bulk movie ${i}`,tmdb_id:String(900000+i),watched_at:'2026-10-22T12:00:00.000Z'}));
    const http=requestResponse({records});await handleManualWatch(http.req,http.res);
    assert.equal(http.status(),200);assert.equal(http.body().propagated,100,JSON.stringify(http.body()));
    assert.equal(calls.length,4);assert.equal(posted.length,100);
    const rows=db.prepare('SELECT sync_dispatch_telemetry FROM watch_history').all();
    assert.equal(rows.length,100);
    assert.ok(rows.every(r=>/simkl status: success/i.test(r.sync_dispatch_telemetry)),JSON.stringify(rows[0]));
  } finally {globalThis.fetch=previous;}
});
