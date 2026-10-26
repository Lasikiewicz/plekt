import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-dropped-title-transport-");
const state = { baseUrl: "", calls: [] };
globalThis.droppedTitleTransportFixture = state;
const source = (code) => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (!context.parentURL?.endsWith("/routes/droppedTitles.js")) return next(specifier, context);
  const preamble = "const f = globalThis.droppedTitleTransportFixture;";
  const modules = {
    "../utils/auth.js": "export const requireAdmin = async () => true;",
    "../utils/requestBody.js": "export const readJson = async req => req.body;",
    "../utils/http.js": "export const sendJson = (res,data,status=200) => {res.statusCode=status;res.data=data}; export const sendOptions=()=>{}; export const methodNotAllowed=res=>{res.statusCode=405};",
    "../utils/configStore.js": "export const loadMediaConfig=async()=>({plex:{baseUrl:f.baseUrl,token:'plex-token'},emby:{baseUrl:f.baseUrl,apiKey:'emby-key',userId:'user-1'},jellyfin:{baseUrl:f.baseUrl,apiKey:'jf-key',userId:'user-1'}});",
    "../utils/upNextService.js": "export const buildUpNextProjection=async()=>({items:[{media_type:'movie',title:'Transport Film',tmdb_id:'42',provider_items:{plex:['plex-42'],emby:['emby-42'],jellyfin:['jellyfin-42']}}]});",
    "../utils/upNextCache.js": "export const refreshUpNextAfterMutation=async()=>{};",
  };
  return modules[specifier] ? source(preamble + modules[specifier]) : next(specifier, context);
} });

const { handleDroppedTitles } = await import("../server/src/routes/droppedTitles.js");
const { isSameDroppedTitle, listDroppedTitles } = await import("../server/src/utils/droppedTitles.js");
const { db } = await import("../server/src/db.js");
const { insertWatchRecordSync, upsertPlaybackProgress } = await import("../server/src/utils/dataRepo.js");

test("dropped identity match rejects media types and contradictory IDs or years", () => {
  assert.equal(isSameDroppedTitle(
    { media_type: "show", title: "Dune", tmdb_id: "42", year: 2021 },
    { media_type: "movie", title: "Dune", tmdb_id: "42", year: 2021 },
  ), false);
  assert.equal(isSameDroppedTitle(
    { media_type: "movie", title: "Dune", tmdb_id: "42", year: 2021 },
    { media_type: "movie", title: "Dune", tmdb_id: "43", year: 2021 },
  ), false);
  assert.equal(isSameDroppedTitle(
    { media_type: "movie", title: "Dune", year: 1984 },
    { media_type: "movie", title: "Dune", year: 2021 },
  ), false);
});

test("drop persists locally, sends only rail hide requests, and preserves history and progress", async (t) => {
  const server = createServer(async (req, res) => {
    state.calls.push({ method: req.method, url: req.url });
    if (req.url?.startsWith("/Users/user-1/Items/jellyfin-42")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ UserData: { Played: false, PlaybackPositionTicks: 0 } }));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.calls = [];

  db.prepare("DELETE FROM dropped_titles").run();
  db.prepare("DELETE FROM watch_history").run();
  db.prepare("DELETE FROM playback_progress").run();
  insertWatchRecordSync({ title: "Transport Film", media_type: "movie", tmdb_id: "42", watched_at: "2026-01-01T00:00:00.000Z", source: "manual" });
  await upsertPlaybackProgress({ media_key: "movie:tmdb:42", media_type: "movie", title: "Transport Film", tmdb_id: "42", position_ms: 120000, duration_ms: 1200000, progress: 10 });
  const historyBefore = db.prepare("SELECT * FROM watch_history ORDER BY id").all();
  const progressBefore = db.prepare("SELECT * FROM playback_progress ORDER BY media_key").all();

  const res = { status(code) { this.statusCode = code; return this; }, set() { return this; }, send() { return this; } };
  await handleDroppedTitles({ method: "POST", body: { item: { media_type: "movie", title: "Transport Film", tmdb_id: "42" }, dropped: true } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(listDroppedTitles().length, 1, "local drop is saved");
  assert.deepEqual(state.calls.map(({ method }) => method).sort(), ["POST", "PUT"]);
  assert.ok(state.calls.some(({ url }) => url.includes("/actions/removeFromContinueWatching?ratingKey=plex-42")));
  assert.ok(state.calls.some(({ url }) => url.includes("/Items/emby-42/HideFromResume?Hide=true")));
  assert.ok(!state.calls.some(({ url }) => url.includes("jellyfin-42")), "Jellyfin state is never changed to fake a rail hide");
  assert.equal(res.data.providerDismissals.find(entry => entry.target === "jellyfin").status, "unsupported");
  assert.deepEqual(db.prepare("SELECT * FROM watch_history ORDER BY id").all(), historyBefore);
  assert.deepEqual(db.prepare("SELECT * FROM playback_progress ORDER BY media_key").all(), progressBefore);
});
