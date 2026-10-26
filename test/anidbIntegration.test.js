import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-anidb-integration-");
const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { handleAnidb } = await import("../server/src/routes/anidb.js");
const { createAnidbMatches, anidbMediaIdentity, verifiedAnidbProviderCandidate } = await import("../server/src/utils/anidbMatches.js");
const { getFullBackup, importCollectionBatch, BROWSER_BACKUP_COLLECTIONS } = await import("../server/src/utils/backup.js");
const { saveMediaConfig, loadMediaConfig } = await import("../server/src/utils/configStore.js");
const { ANIDB_DAY_MS } = await import("../server/src/utils/anidbRepository.js");
const matches = createAnidbMatches(db);
test.after(() => db.close());

async function call(action, method = "GET", body, authorized = true, dependencies) {
  const headers = { ...(authorized ? { "x-api-key": AUTH.apiKey } : {}), "content-type": "application/json" };
  const req = { method, body, headers, get: (name) => headers[name.toLowerCase()] || "", ip: "127.0.0.1", socket: {} };
  let status = 200;
  let result;
  const res = { status(value) { status = value; return res; }, set() { return res; }, setHeader() {}, send(value) { result = JSON.parse(value); return res; } };
  await handleAnidb(req, res, `anidb/${action}`, dependencies);
  return { status, body: result };
}
function seed(aid = "99001") {
  const data = { aid, title: "Synthetic anime title", overview: "Synthetic anime description", episodes: [{ id: "99011", number: "1", type: "1" }], type: "TV Series", source: { name: "AniDB", url: `https://anidb.net/anime/${aid}` } };
  db.prepare("INSERT OR REPLACE INTO anidb_metadata_cache VALUES (?,?,1,?)").run(aid, JSON.stringify(data), Date.now());
  return data;
}

test("AniDB identities keep movie/show namespaces and reject title-only matching", () => {
  assert.notEqual(anidbMediaIdentity({ mediaType: "movie", tmdbId: "51" }).key, anidbMediaIdentity({ mediaType: "tv", tmdbId: "51" }).key);
  assert.throws(() => anidbMediaIdentity({ mediaType: "tv", title: "Synthetic anime title" }));
  assert.throws(() => anidbMediaIdentity({ mediaType: "episode", tmdbId: "51" }));
  assert.throws(() => anidbMediaIdentity({ mediaType: "tv", tvdbId: "movie" }));
});

test("saved anime matches resolve aliases, reject contradictory IDs and replace prior choices", () => {
  matches.save({ mediaType: "tv", tvdbId: "52", aid: "99001" });
  matches.save({ mediaType: "tv", tmdbId: "51", tvdbId: "52", aid: "99002" });
  assert.equal(matches.resolve({ mediaType: "tv", tvdbId: "52" }).aid, "99002");
  assert.equal(matches.resolve({ mediaType: "tv", tmdbId: "51", tvdbId: "99" }), null);
  assert.equal(matches.resolve({ mediaType: "movie", tmdbId: "51" }), null);
  assert.equal(matches.list().length, 1);
});

test("automatic provider matching requires one direct AniDB link and complete cached coverage", () => {
  const series = { id: "52", remoteIds: [{ sourceName: "AniDB", id: "99001" }], episodes: [{ seasonNumber: 1, number: 1 }] };
  const cached = () => ({ data: seed() });
  assert.equal(verifiedAnidbProviderCandidate(series, "52", cached), "99001");
  assert.equal(verifiedAnidbProviderCandidate(series, "53", cached), null);
  assert.equal(verifiedAnidbProviderCandidate({ ...series, episodes: [...series.episodes, { seasonNumber: 2, number: 1 }] }, "52", cached), null);
  assert.equal(verifiedAnidbProviderCandidate({ ...series, remoteIds: [...series.remoteIds, { sourceName: "AniDB", id: "99002" }] }, "52", cached), null);
  assert.equal(verifiedAnidbProviderCandidate(series, "52", () => null), null);
});

test("AniDB routes authenticate and reject unconfirmed or unpreviewed matches", async () => {
  assert.equal((await call("status", "GET", null, false)).status, 401);
  const identity = { mediaType: "tv", tmdbId: "61", tvdbId: "62", aid: "99001" };
  assert.equal((await call("matches", "POST", identity)).status, 400);
  assert.equal((await call("matches", "POST", { ...identity, aid: "99003", confirm: true })).status, 409);
  seed();
  assert.equal((await call("preview", "POST", identity)).body.data.aid, "99001");
  assert.equal((await call("matches", "POST", { ...identity, confirm: true })).status, 200);
});

test("AniDB enrichment is optional, preserves numbering state, and returns nothing for other titles", async () => {
  const input = { cacheOnly: true, items: [{ mediaType: "tv", tmdbId: "61", tvdbId: "62" }, { mediaType: "tv", tmdbId: "999" }, { mediaType: "movie", tmdbId: "61" }] };
  const before = db.prepare("SELECT * FROM show_season_source").all();
  await saveMediaConfig({ metadata: { anidbEnabled: false, seasonSource: "tmdb" } });
  assert.deepEqual((await call("enrich", "POST", input)).body.results, [null, null, null]);
  assert.equal((await call("settings", "POST", { enabled: true })).status, 200);
  const enriched = (await call("enrich", "POST", input)).body.results;
  assert.equal(enriched[0].title, "Synthetic anime title");
  assert.deepEqual(enriched.slice(1), [null, null]);
  assert.equal((await loadMediaConfig()).metadata.seasonSource, "tmdb");
  assert.deepEqual(db.prepare("SELECT * FROM show_season_source").all(), before);
  assert.equal((await call("enrich", "POST", { items: Array(9).fill(input.items[0]) })).status, 400);
});

test("movie enrichment requires Movie type and saved confirmation takes priority over Wikidata", async () => {
  const input = { items: [{ mediaType: "movie", tmdbId: "731" }], cacheOnly: true };
  let calls = 0;
  const dependencies = { movieLookup: async () => { calls++; return { aid: "99007", evidence: "wikidata", url: "https://www.wikidata.org/entity/Q123" }; } };
  seed("99007");
  await saveMediaConfig({ metadata: { anidbEnabled: true } });
  assert.deepEqual((await call("enrich", "POST", input, true, dependencies)).body.results, [null]);
  const data = { ...seed("99007"), type: "Movie" };
  db.prepare("UPDATE anidb_metadata_cache SET data=? WHERE aid=?").run(JSON.stringify(data), "99007");
  const automatic = (await call("enrich", "POST", input, true, dependencies)).body.results[0];
  assert.equal(automatic.aid, "99007");
  assert.equal(automatic.evidence, "wikidata");
  assert.equal(automatic.mappingSource, "https://www.wikidata.org/entity/Q123");
  seed("99008");
  matches.save({ ...input.items[0], aid: "99008" });
  const confirmed = (await call("enrich", "POST", input, true, dependencies)).body.results[0];
  assert.equal(confirmed.aid, "99008");
  assert.equal(confirmed.evidence, "confirmed");
  assert.equal(calls, 2, "saved confirmation bypasses Wikidata");
  matches.remove(input.items[0]);
});

test("AniDB backup restores payload and confirmed matches while guards only move forward", () => {
  seed();
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO anidb_request_state VALUES (?,?,?)").run("99001", now + 2 * ANIDB_DAY_MS, "BANNED");
  db.prepare("INSERT OR REPLACE INTO anidb_provider_state VALUES (1,?,?,?,?)").run(now + 2000, now + 2 * ANIDB_DAY_MS, "active-process", now + 60_000);
  const backup = getFullBackup("test");
  for (const name of ["anidbMetadata", "anidbRequests", "anidbProvider", "anidbMatches"]) {
    assert.ok(BROWSER_BACKUP_COLLECTIONS.includes(name));
    importCollectionBatch(name, JSON.parse(JSON.stringify(backup.collections[name])), { reset: true, portable: true });
  }
  assert.equal(db.prepare("SELECT lease_token FROM anidb_provider_state WHERE id=1").get().lease_token, "active-process");
  assert.equal(backup.collections.anidbProvider[0].data.lease_token, undefined);
  importCollectionBatch("anidbRequests", [{ id: "99001", data: { nextFetchAt: now, errorCode: "" } }], { reset: true });
  importCollectionBatch("anidbProvider", [{ id: "1", data: { nextStartAt: 0, cooldownUntil: 0 } }], { reset: true });
  assert.equal(db.prepare("SELECT next_fetch_at_ms FROM anidb_request_state WHERE aid='99001'").get().next_fetch_at_ms, now + 2 * ANIDB_DAY_MS);
  assert.equal(db.prepare("SELECT cooldown_until_ms FROM anidb_provider_state WHERE id=1").get().cooldown_until_ms, now + 2 * ANIDB_DAY_MS);
  assert.equal(matches.resolve({ mediaType: "tv", tmdbId: "61" }).aid, "99001");
  assert.throws(() => importCollectionBatch("anidbMatches", [{ id: "tv:tmdb:61", data: { mediaType: "movie", tmdbId: "61", aid: "99001", evidence: "confirmed", updatedAt: now } }], { reset: true }));
  assert.equal(matches.resolve({ mediaType: "tv", tmdbId: "61" }).aid, "99001", "bad restore rolls back the reset");
});

test("restoring an AniDB payload establishes a daily guard even on a fresh target", () => {
  const value = seed("99004");
  const now = Date.now();
  importCollectionBatch("anidbMetadata", [{ id: "99004", data: { data: value, schemaVersion: 1, fetchedAt: now } }]);
  assert.equal(db.prepare("SELECT next_fetch_at_ms FROM anidb_request_state WHERE aid='99004'").get().next_fetch_at_ms, now + ANIDB_DAY_MS);
});

test("cache API clears only payloads and keeps saved matches, request guards and provider cooldown", async () => {
  const before = { matches: matches.list(), requests: db.prepare("SELECT * FROM anidb_request_state").all(), provider: db.prepare("SELECT * FROM anidb_provider_state").all() };
  assert.equal((await call("cache", "DELETE")).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM anidb_metadata_cache").get().n, 0);
  assert.deepEqual(matches.list(), before.matches);
  assert.deepEqual(db.prepare("SELECT * FROM anidb_request_state").all(), before.requests);
  assert.deepEqual(db.prepare("SELECT * FROM anidb_provider_state").all(), before.provider);
});

test("detail title changes are display-only and both renderers escape AniDB attribution", () => {
  for (const filename of ["media-detail-show.js", "media-detail-movie.js"]) {
    const source = fs.readFileSync(new URL(`../public/modules/${filename}`, import.meta.url), "utf8");
    assert.match(source, /escapeHtml\(anidbDisplayTitle\(tmdbData,/);
    assert.match(source, /anidbAttributionHtml\(tmdbData\)/);
  }
});

test("factory reset clears AniDB data and choices but preserves request and cooldown guards", async () => {
  // This database and config live exclusively in makeTempDataDir above.
  const { handleWipeData } = await import("../server/src/routes/wipeData.js");
  seed("99009");
  matches.save({ mediaType: "movie", tmdbId: "991", aid: "99009" });
  const requests = db.prepare("SELECT * FROM anidb_request_state ORDER BY aid").all();
  const provider = db.prepare("SELECT * FROM anidb_provider_state").all();
  const headers = { "x-api-key": AUTH.apiKey, "content-type": "application/json" };
  const req = { method: "POST", body: { scope: "factory", confirm: "DELETE" }, headers,
    get: (name) => headers[name.toLowerCase()] || "", ip: "127.0.0.1", socket: {} };
  let status = 200;
  let result;
  const res = { status(value) { status = value; return res; }, set() { return res; }, setHeader() {},
    send(value) { result = JSON.parse(value); return res; } };
  await handleWipeData(req, res);
  assert.equal(status, 200);
  assert.equal(result.signOutRequired, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM anidb_metadata_cache").get().n, 0);
  assert.equal(matches.list().length, 0);
  assert.deepEqual(db.prepare("SELECT * FROM anidb_request_state ORDER BY aid").all(), requests);
  assert.deepEqual(db.prepare("SELECT * FROM anidb_provider_state").all(), provider);
});
