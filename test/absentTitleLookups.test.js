import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const explorerSource = read("public/modules/explorer.js");
const showSource = read("public/modules/media-detail-show.js");
const sharedSource = read("public/modules/media-detail-shared.js");
const adminSource = read("server/src/routes/admin.js");
const appSource = read("public/app.js");
const stateSource = read("public/modules/state.js");

// A show opened from a recommendation rail is usually not in the library, and
// every cache on that path used to key on a *resolved* result. A miss was never
// remembered, so one page load asked /api/show six times (three lookup shapes,
// twice over) and ran three concurrent 3-provider app-link searches.

test("a /api/show miss is remembered under the same identity tokens", () => {
  assert.match(explorerSource, /export function cachedShowDetailMiss/);
  assert.match(explorerSource, /export function rememberShowDetailMiss/);
  // The miss cache must be keyed by the same tokens as the positive cache, or a
  // lookup by a different identifier would still miss it.
  const missBody = explorerSource.match(/export function rememberShowDetailMiss[\s\S]*?\n}/)?.[0] || "";
  assert.match(missBody, /showLookupTokens/);
});

test("a miss never outlives a resolved show, and survives a slow page load", () => {
  const hitTtl = Number(explorerSource.match(/SHOW_DETAIL_CACHE_TTL_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(hitTtl) && hitTtl > 0, "hit TTL should be a positive number");

  const missDeclaration = explorerSource.match(/SHOW_DETAIL_MISS_TTL_MS\s*=\s*([A-Za-z0-9_]+)/)?.[1] || "";
  const missTtl = missDeclaration === "SHOW_DETAIL_CACHE_TTL_MS"
    ? hitTtl
    : Number(missDeclaration.replace(/_/g, ""));
  assert.ok(Number.isFinite(missTtl) && missTtl > 0, "miss TTL should resolve to a positive number");
  assert.ok(missTtl <= hitTtl, `a miss (${missTtl}ms) must not outlive a hit (${hitTtl}ms)`);
  // A detail page whose provider work took 5.4s outlived a 5s miss window and
  // re-asked on its own re-render, so the window has to cover a slow load.
  assert.ok(missTtl >= 10_000, `a miss window of ${missTtl}ms is shorter than a slow page load`);
});

test("all three show lookup shapes consult and record the miss", () => {
  for (const guard of [
    /cachedShowDetailMiss\(\{ tmdb_id: tmdbId \}\)/,
    /cachedShowDetailMiss\(\{ tvdb_id: tvdbId \}\)/,
    /cachedShowDetailMiss\(\{ title: normalizedTitle \}\)/,
  ]) {
    assert.match(showSource, guard);
  }
  for (const record of [
    /rememberShowDetailMiss\(\{ tmdb_id: tmdbId \}\)/,
    /rememberShowDetailMiss\(\{ tvdb_id: tvdbId \}\)/,
    /rememberShowDetailMiss\(\{ title: normalizedTitle \}\)/,
  ]) {
    assert.match(showSource, record);
  }
});

test("TVDB-backed show metadata hydrates seasons through its TVDB identity", () => {
  const lookup = showSource.match(/export function showSeasonLookupId[\s\S]*?\n}/)?.[0] || "";
  assert.match(lookup, /external_ids\?\.tvdb_id/);
  assert.match(lookup, /if \(tvdbId\) return `tvdb:\$\{tvdbId\}`/);
  assert.match(lookup, /const tmdbId = String\(tmdbData\?\.id/);
});

test("the miss cache is cleared by the same mutation hook as the positive cache", () => {
  assert.match(stateSource, /showDetailMisses: new SessionCache\(\)/);
  const clearBody = appSource.match(/function clearDerivedUiCaches[\s\S]*?\n}/)?.[0] || "";
  assert.match(clearBody, /state\.showDetailCache\.clear\(\)/);
  assert.match(clearBody, /state\.showDetailMisses\.clear\(\)/);
});

test("concurrent app-link renders share one in-flight request", () => {
  assert.match(sharedSource, /const appLinksInflight = new Map\(\)/);
  assert.match(sharedSource, /appLinksInflight\.get\(cacheKey\)/);
  assert.match(sharedSource, /appLinksInflight\.set\(cacheKey, request\)/);
  // The entry has to be released however the request settles, or one failure
  // would pin the key and block every later lookup for it.
  assert.match(sharedSource, /\.finally\(\(\) => appLinksInflight\.delete\(cacheKey\)\)/);
});

test("the server remembers an empty app-link result, but never a populated one", () => {
  assert.match(adminSource, /const emptyAppLinksCache = new Map\(\)/);
  const handler = adminSource.match(/export async function handleMediaAppLinks[\s\S]*?\n}/)?.[0] || "";
  assert.match(handler, /if \(!links\.length\)/, "only an empty result may be cached");
  assert.doesNotMatch(handler, /emptyAppLinksCache\.set\(lookupKey, Date\.now\(\)\);\s*\n\s*}\s*\n\s*return sendJson\(res, \{ ok: true, links \}[\s\S]*links\.length/);
});

test("the empty-result cache is bounded and invalidated on a config change", () => {
  assert.match(adminSource, /emptyAppLinksCache\.size >= \d+/, "cache must be bounded");
  assert.match(adminSource, /export function clearEmptyAppLinksCache/);
  // Connecting a media server changes what can be found.
  const configHandler = adminSource.match(/await saveMediaConfig\(config\);[\s\S]{0,400}/)?.[0] || "";
  assert.match(configHandler, /clearEmptyAppLinksCache\(\)/);
});

test("the empty-result window is shorter than the client's own refresh window", () => {
  const serverTtl = Number(adminSource.match(/EMPTY_APP_LINKS_TTL_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ""));
  const clientTtl = Number(sharedSource.match(/APP_LINKS_REFRESH_TTL_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/)
    ?.slice(1)
    .reduce((total, value) => total * Number(value), 1));
  assert.ok(Number.isFinite(serverTtl) && serverTtl > 0);
  assert.ok(Number.isFinite(clientTtl) && clientTtl > 0);
  assert.ok(
    serverTtl <= clientTtl,
    `server window (${serverTtl}ms) must not outlive the client's (${clientTtl}ms), or a newly added title stays hidden longer than the client expects`,
  );
});
