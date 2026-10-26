import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const fixture = { rows: [], calls: [], history: [{ id: 1, watched_at: "2026-01-01" }], progress: [{ media_key: "show:tmdb:42", position_ms: 120000 }], rail: [] };
globalThis.droppedTitlesRouteFixture = fixture;
const source = (code) => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (!context.parentURL?.endsWith("/routes/droppedTitles.js")) return next(specifier, context);
  const preamble = "const f = globalThis.droppedTitlesRouteFixture;";
  const modules = {
    "../utils/auth.js": "export const requireAdmin = async () => true;",
    "../utils/requestBody.js": "export const readJson = async req => req.body;",
    "../utils/http.js": "export const sendJson = (res, data, status=200) => {res.statusCode=status;res.data=data}; export const sendOptions=()=>{}; export const methodNotAllowed=res=>{res.statusCode=405};",
    "../utils/droppedTitles.js": "export const listDroppedTitles=()=>f.rows; export const isSameDroppedTitle=(left,right)=>String(left.tmdb_id||left.show_tmdb_id||'')===String(right.show_tmdb_id||right.tmdb_id||'')&&String(left.media_type||left.type||'').toLowerCase()!=='movie'; export const dropTitle=item=>{f.rows=[{title:item.title,dropped_at:Date.now()}];f.calls.push('persist');return {created:true}}; export const undropTitleForMedia=()=>{f.rows=[];return 1};",
    "../utils/configStore.js": "export const loadMediaConfig=async()=>({plex:{baseUrl:'plex',token:'x'},emby:{baseUrl:'emby',apiKey:'x',userId:'u'},jellyfin:{baseUrl:'jellyfin',apiKey:'x',userId:'u'}});",
    "../utils/upNextService.js": "export const buildUpNextProjection=async()=>{if(f.projectionFails)throw new Error('projection unavailable');return {items:f.rail}};",
    "../utils/upNextCache.js": "export const refreshUpNextAfterMutation=async()=>{f.calls.push('refresh')};",
    "../utils/mediaArtwork.js": "export const getCanonicalPosterUrl=item=>item.media_type==='tv'&&item.tmdb_id==='7'?'/media/posters/seven.webp':'';",
    "./sync.js": "export const hideUpNextAcrossProviders=async (_config,media,body)=>{f.calls.push('hide');f.hideMedia=media;f.hiddenItems=body.provider_items;return ['plex','emby'].map(target=>({target,status:'fulfilled'}))};",
  };
  return modules[specifier] ? source(preamble + modules[specifier]) : next(specifier, context);
} });
const { handleDroppedTitles } = await import("../server/src/routes/droppedTitles.js");
function response() { return { status(code) { this.statusCode = code; return this; }, set() { return this; }, send(value) { this.body = value; return this; } }; }
function reset() {
  fixture.rows = []; fixture.calls = [];
  fixture.history = [{ id: 1, watched_at: "2026-01-01" }];
  fixture.progress = [{ media_key: "show:tmdb:42", position_ms: 120000 }];
  fixture.projectionFails = false;
  fixture.rail = [{ media_type: "episode", show_title: "Example", show_tmdb_id: "42", provider_items: { plex: ["p-42"], emby: ["e-42"], jellyfin: ["j-42"] } }];
}

test("GET lists dropped titles and rejects unsupported methods", async () => {
  reset(); fixture.rows = [{ title: "Example" }];
  const res = response();
  await handleDroppedTitles({ method: "GET" }, res);
  assert.deepEqual(res.data, { items: fixture.rows });
  const unsupported = response();
  await handleDroppedTitles({ method: "PUT" }, unsupported);
  assert.equal(unsupported.statusCode, 405);
});

test("POST validates item and dropped value", async () => {
  reset();
  for (const body of [{}, { item: { media_type: "movie", title: "Film" }, dropped: "yes" }, { item: { media_type: "book", title: "Book" }, dropped: true }]) {
    const res = response();
    await handleDroppedTitles({ method: "POST", body }, res);
    assert.equal(res.statusCode, 400);
  }
  const malformed = response();
  await handleDroppedTitles({ method: "POST", body: "{" }, malformed);
  assert.equal(malformed.statusCode, 400);
});

test("drop persists first, hides each queued provider rail, refreshes queue, and leaves history/progress alone", async () => {
  reset();
  const before = structuredClone({ history: fixture.history, progress: fixture.progress });
  const res = response();
  await handleDroppedTitles({ method: "POST", body: { item: { media_type: "show", title: "Example", tmdb_id: "42" }, dropped: true } }, res);
  assert.equal(res.data.ok, true);
  assert.deepEqual(fixture.hiddenItems, { plex: ["p-42"], emby: ["e-42"], jellyfin: ["j-42"] });
  assert.deepEqual(fixture.hideMedia, { type: "episode", title: "Example", showTitle: "Example", ids: { imdb: undefined, tmdb: "42", tvdb: undefined }, season: undefined, episode: undefined, providerItemId: undefined });
  assert.deepEqual(res.data.providerDismissals.map((outcome) => outcome.target), ["plex", "emby", "jellyfin"]);
  assert.deepEqual(fixture.calls, ["persist", "hide", "refresh"]);
  assert.deepEqual({ history: fixture.history, progress: fixture.progress }, before);
});

test("un-drop updates local queue state without touching provider watched state", async () => {
  reset(); fixture.rows = [{ title: "Example" }];
  const before = structuredClone({ history: fixture.history, progress: fixture.progress });
  const res = response();
  await handleDroppedTitles({ method: "POST", body: { item: { media_type: "movie", title: "Example", tmdb_id: "99" }, dropped: false } }, res);
  assert.equal(res.data.result.removed, true);
  assert.deepEqual(fixture.calls, ["refresh"]);
  assert.deepEqual({ history: fixture.history, progress: fixture.progress }, before);
});

test("projection failure still persists the drop and attempts provider lookup", async () => {
  reset();
  fixture.projectionFails = true;
  const originalProjection = fixture.rail;
  const res = response();
  await handleDroppedTitles({ method: "POST", body: { item: { media_type: "movie", title: "Film", tmdb_id: "99" }, dropped: true } }, res);
  assert.equal(res.data.ok, true);
  assert.deepEqual(fixture.calls, ["persist", "hide", "refresh"]);
  assert.equal(res.data.providerDismissals[0].target, "up_next_projection");
  fixture.projectionFails = false;
  fixture.rail = originalProjection;
});

test("GET fills a missing saved poster from the canonical poster and keeps a saved one", async () => {
  reset();
  fixture.rows = [
    { media_type: "show", title: "Old Drop", tmdb_id: "7", snapshot: {} },
    { media_type: "show", title: "New Drop", tmdb_id: "7", snapshot: { poster_url: "/media/posters/saved.webp" } },
    { media_type: "show", title: "Unknown", tmdb_id: "8", snapshot: {} },
  ];
  const res = response();
  await handleDroppedTitles({ method: "GET" }, res);
  assert.deepEqual(res.data.items.map((row) => row.snapshot.poster_url || ""), ["/media/posters/seven.webp", "/media/posters/saved.webp", ""]);
});
