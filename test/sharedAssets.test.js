import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-shared-assets-");
process.env.API_KEY = "admin-env-api-key-secret-value-123456";
process.env.WEBHOOK_SECRET = "admin-env-webhook-secret-value-123456";
process.env.SESSION_SECRET = "admin-env-session-secret-value-123456";
process.env.PLEX_ENABLED = "true";
process.env.PLEX_URL = "http://127.0.0.1:32400";
process.env.PLEX_TOKEN = "admin-env-plex-token-secret";

const { MEDIA_DIR, POSTERS_DIR, SHARED_METADATA_DB_PATH } = await import("../server/src/paths.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { db, adminDb } = await import("../server/src/db.js");
const { saveUsersRegistry, ensureTenantDataDir } = await import("../server/src/utils/tenancy.js");
const { closeAllTenantDatabases } = await import("../server/src/utils/tenantDatabase.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const {
  cachePosterFromUrl,
  getPosterCache,
  usableCachedPoster,
  sharedFileNameFor,
} = await import("../server/src/utils/posterCache.js");
const { getCanonicalPosterUrl } = await import("../server/src/utils/mediaArtwork.js");
const { loadMediaConfig, saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { loadCredentialKey } = await import("../server/src/utils/credentialVault.js");
const {
  getSharedMetadataDb,
  migrateProviderCachesFromAdmin,
  readSharedTvdbToken,
  writeSharedTvdbToken,
} = await import("../server/src/utils/sharedMetadataStore.js");
const { getOmdbRating } = await import("../server/src/utils/omdbGateway.js");
const { getTmdbDetails } = await import("../server/src/utils/tmdbGateway.js");
const { handleClearCache } = await import("../server/src/routes/maintenance.js");
const { handleWipeData } = await import("../server/src/routes/wipeData.js");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const POSTER_URL_A = "https://image.tmdb.org/t/p/w500/shared-poster-a.png";
const POSTER_URL_B = "https://image.tmdb.org/t/p/w500/shared-poster-b.png";

saveUsersRegistry({
  version: 1,
  users: [
    { name: "alice", role: "user", passwordHash: "hash-alice" },
    { name: "bob", role: "user", passwordHash: "hash-bob" },
  ],
}, dataDir);

const aliceDir = ensureTenantDataDir("alice", dataDir);
const bobDir = ensureTenantDataDir("bob", dataDir);

function runAsAlice(fn) {
  return runWithUserContext({ name: "alice", role: "user", dataDir: aliceDir }, fn);
}

function runAsBob(fn) {
  return runWithUserContext({ name: "bob", role: "user", dataDir: bobDir }, fn);
}

function makeAuthedJsonReq(method, bodyObj = {}) {
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const stream = Readable.from([raw]);
  stream.method = method;
  stream.url = "/api/test";
  stream.body = bodyObj;
  stream.rawBody = raw;
  stream.headers = {
    "content-type": "application/json",
    "x-api-key": AUTH.apiKey,
  };
  stream.get = (name) => stream.headers[String(name || "").toLowerCase()];
  stream.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

function makeCapturingRes() {
  let statusCode = 200;
  let bodyText = "";
  const headers = {};
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    set(hdrs = {}) {
      Object.assign(headers, hdrs);
      return res;
    },
    send(chunk = "") {
      bodyText = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
      return res;
    },
    writeHead(code, hdrs = {}) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk = "") {
      bodyText += String(chunk || "");
    },
    get statusCode() { return statusCode; },
    get json() { return bodyText ? JSON.parse(bodyText) : null; },
  };
  return res;
}

test("poster written for one user is reused by another user without a second fetch, and config secrets stay isolated", async () => {
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(Buffer.from(PNG_BASE64, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };

  try {
    const aliceResult = await runAsAlice(() =>
      cachePosterFromUrl("movie:tmdb:101", POSTER_URL_A, "tmdb")
    );
    assert.ok(aliceResult?.url?.startsWith("/media/posters/"));
    assert.equal(fetchCount, 1);

    const expectedFile = `${sharedFileNameFor("poster", POSTER_URL_A)}.webp`;
    assert.equal(aliceResult.url, `/media/posters/${expectedFile}`);
    assert.ok(fs.existsSync(path.join(MEDIA_DIR, "posters", expectedFile)));

    // Bob caches the same remote poster URL under a different mediaKey; it
    // reuses the file already on disk with zero additional HTTP fetches.
    const bobResult = await runAsBob(() =>
      cachePosterFromUrl("movie:local:bob-101", POSTER_URL_A, "tmdb")
    );
    assert.equal(bobResult?.url, aliceResult.url);
    assert.equal(bobResult?.cached, true);
    assert.equal(fetchCount, 1);

    const bobCached = await runAsBob(() => getPosterCache("movie:local:bob-101"));
    assert.equal(usableCachedPoster(bobCached)?.url, aliceResult.url);

    // Same media_key for two different source URLs in multi-user mode writes
    // two distinct files so neither user overwrites the other's poster.
    const aliceCollision = await runAsAlice(() =>
      cachePosterFromUrl("movie:title:collision", POSTER_URL_A, "tmdb")
    );
    const bobCollision = await runAsBob(() =>
      cachePosterFromUrl("movie:title:collision", POSTER_URL_B, "tmdb")
    );
    assert.notEqual(aliceCollision.url, bobCollision.url);
    assert.ok(fs.existsSync(path.join(MEDIA_DIR, aliceCollision.url.replace(/^\/media\//, ""))));
    assert.ok(fs.existsSync(path.join(MEDIA_DIR, bobCollision.url.replace(/^\/media\//, ""))));

    // Secret isolation: non-admin users never see admin's API_KEY, WEBHOOK_SECRET,
    // SESSION_SECRET, credential.key, or PLEX_TOKEN env credentials.
    const adminApiKey = AUTH.apiKey;
    const adminWebhookSecret = AUTH.webhookSecret;
    const adminKeyBuf = loadCredentialKey();

    await runAsAlice(async () => {
      assert.notEqual(AUTH.apiKey, adminApiKey);
      assert.notEqual(AUTH.webhookSecret, adminWebhookSecret);
      const aliceKeyBuf = loadCredentialKey();
      assert.equal(Buffer.compare(aliceKeyBuf, adminKeyBuf) === 0, false);

      const aliceConfig = await loadMediaConfig();
      assert.equal(aliceConfig.plex.token, "");
      assert.equal(aliceConfig.plex.baseUrl, "");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("two concurrent writes of the same poster leave one complete file and no temp file", async () => {
  const realFetch = globalThis.fetch;
  const concurrentUrl = "https://image.tmdb.org/t/p/w500/concurrent-poster.png";
  globalThis.fetch = async () =>
    new Response(Buffer.from(PNG_BASE64, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  try {
    // Delete any existing file so both callers race through persistBuffer + writeArtworkFile.
    const expectedName = `${sharedFileNameFor("poster", concurrentUrl)}.webp`;
    const targetPath = path.join(POSTERS_DIR, expectedName);
    fs.rmSync(targetPath, { force: true });

    const [resA, resB] = await Promise.all([
      runAsAlice(() => cachePosterFromUrl("movie:tmdb:concurrent-a", concurrentUrl, "tmdb")),
      runAsBob(() => cachePosterFromUrl("movie:tmdb:concurrent-b", concurrentUrl, "tmdb")),
    ]);

    assert.equal(resA?.url, `/media/posters/${expectedName}`);
    assert.equal(resB?.url, `/media/posters/${expectedName}`);
    const stat = fs.statSync(targetPath);
    assert.ok(stat.isFile() && stat.size > 0);

    const files = fs.readdirSync(POSTERS_DIR);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(tmpFiles, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("non-admin maintenance is denied without changing tenant or shared caches; admin clear-cache removes shared artwork", async () => {
  const realFetch = globalThis.fetch;
  const keepUrl = "https://image.tmdb.org/t/p/w500/shared-keep-test.png";
  globalThis.fetch = async () =>
    new Response(Buffer.from(PNG_BASE64, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  try {
    const cached = await runAsAlice(() => cachePosterFromUrl("movie:tmdb:909", keepUrl, "tmdb"));
    await runAsBob(() => cachePosterFromUrl("movie:tmdb:909", keepUrl, "tmdb"));
    const diskPath = path.join(MEDIA_DIR, cached.url.replace(/^\/media\//, ""));
    assert.ok(fs.existsSync(diskPath));

    // Seed a shared provider cache row.
    db.prepare(
      "INSERT OR REPLACE INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)"
    ).run("tt9090909", JSON.stringify({ imdbRating: "8.4" }), Date.now());

    // Maintenance is install-admin-only, so Alice cannot clear even her tenant cache.
    const clearRes = await runAsAlice(async () => {
      const req = makeAuthedJsonReq("POST", { type: "all" });
      const res = makeCapturingRes();
      await handleClearCache(req, res);
      return res;
    });
    assert.equal(clearRes.statusCode, 403);
    assert.equal(clearRes.json?.code, "ADMIN_ONLY");
    assert.ok(fs.existsSync(diskPath));
    assert.ok(await runAsAlice(() => getPosterCache("movie:tmdb:909")));
    assert.ok(await runAsBob(() => getPosterCache("movie:tmdb:909")));

    // Factory wipe-data is also install-admin-only and leaves both caches intact.
    const wipeRes = await runAsAlice(async () => {
      const req = makeAuthedJsonReq("POST", { confirm: "DELETE", scope: "factory" });
      const res = makeCapturingRes();
      await handleWipeData(req, res);
      return res;
    });
    assert.equal(wipeRes.statusCode, 403);
    assert.equal(wipeRes.json?.code, "ADMIN_ONLY");
    assert.ok(fs.existsSync(diskPath));
    assert.ok(await runAsAlice(() => getPosterCache("movie:tmdb:909")));
    const omdbStillThere = db.prepare("SELECT data FROM omdb_cache WHERE id = ?").get("tt9090909");
    assert.ok(omdbStillThere);

    // Admin runs clear-cache: shared files on disk ARE removed.
    const adminClearRes = makeCapturingRes();
    await handleClearCache(makeAuthedJsonReq("POST", { type: "all" }), adminClearRes);
    assert.equal(adminClearRes.statusCode, 200);
    assert.equal(adminClearRes.json?.filesKept, false);
    assert.ok(adminClearRes.json?.deleted >= 1);
    assert.equal(fs.existsSync(diskPath), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("metadata API key change by admin takes effect immediately for every user and non-admin saves cannot overwrite shared keys", async () => {
  const adminConfig = await loadMediaConfig();
  adminConfig.tmdb = { apiKey: "shared-tmdb-key-v1" };
  adminConfig.tvdb = { apiKey: "shared-tvdb-key-v1" };
  adminConfig.fanart = { apiKey: "shared-fanart-key-v1" };
  adminConfig.omdb = { apiKey: "shared-omdb-key-v1" };
  adminConfig.youtube = { apiKey: "shared-youtube-key-v1" };
  await saveMediaConfig(adminConfig);

  const aliceConfig1 = await runAsAlice(() => loadMediaConfig());
  const bobConfig1 = await runAsBob(() => loadMediaConfig());
  assert.equal(aliceConfig1.tmdb.apiKey, "shared-tmdb-key-v1");
  assert.equal(aliceConfig1.tvdb.apiKey, "shared-tvdb-key-v1");
  assert.equal(aliceConfig1.fanart.apiKey, "shared-fanart-key-v1");
  assert.equal(aliceConfig1.omdb.apiKey, "shared-omdb-key-v1");
  assert.equal(aliceConfig1.youtube.apiKey, "shared-youtube-key-v1");
  assert.equal(bobConfig1.tmdb.apiKey, "shared-tmdb-key-v1");

  // Admin updates keys -> takes effect immediately for Alice and Bob without restart.
  adminConfig.tmdb.apiKey = "shared-tmdb-key-v2";
  adminConfig.omdb.apiKey = "shared-omdb-key-v2";
  await saveMediaConfig(adminConfig);

  const aliceConfig2 = await runAsAlice(() => loadMediaConfig());
  const bobConfig2 = await runAsBob(() => loadMediaConfig());
  assert.equal(aliceConfig2.tmdb.apiKey, "shared-tmdb-key-v2");
  assert.equal(bobConfig2.omdb.apiKey, "shared-omdb-key-v2");

  // Non-admin attempts to save a different TMDB key alongside her own Plex server;
  // her Plex server persists to her DB, while the shared TMDB key stays intact.
  await runAsAlice(async () => {
    const cfg = await loadMediaConfig();
    cfg.tmdb.apiKey = "alice-rogue-tmdb-key";
    cfg.plex.enabled = true;
    cfg.plex.baseUrl = "http://10.0.0.55:32400";
    cfg.plex.token = "alice-private-plex-token";
    await saveMediaConfig(cfg);
  });

  const bobConfig3 = await runAsBob(() => loadMediaConfig());
  assert.equal(bobConfig3.tmdb.apiKey, "shared-tmdb-key-v2");
  assert.equal(bobConfig3.plex.token, "");

  const aliceConfig3 = await runAsAlice(() => loadMediaConfig());
  assert.equal(aliceConfig3.tmdb.apiKey, "shared-tmdb-key-v2");
  assert.equal(aliceConfig3.plex.token, "alice-private-plex-token");

  // Shared TVDB bearer token is readable across user contexts.
  writeSharedTvdbToken({ token: "tvdb-jwt-shared", apiKey: "shared-tvdb-key-v1", expiresAt: Date.now() + 60_000 });
  const tokenFromBob = await runAsBob(() => readSharedTvdbToken());
  assert.equal(tokenFromBob?.token, "tvdb-jwt-shared");
});

test("provider metadata cache hit from user A is reused for user B without a second provider fetch, and warm admin caches migrate", async () => {
  assert.ok(fs.existsSync(SHARED_METADATA_DB_PATH));

  const realFetch = globalThis.fetch;
  let omdbFetches = 0;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("omdbapi.com")) {
      omdbFetches += 1;
      return new Response(JSON.stringify({
        Response: "True",
        Title: "Shared Cache Movie",
        imdbRating: "8.9",
        imdbVotes: "42,100",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  };

  try {
    // User A fetches OMDb rating -> 1 network request, stored in shared-metadata.db.
    const ratingA = await runAsAlice(() => getOmdbRating("tt1234567", "shared-omdb-key-v2"));
    assert.equal(ratingA?.imdbRating, "8.9");
    assert.equal(ratingA?.imdbVotes, "42,100");
    assert.equal(omdbFetches, 1);

    // User B requests the same IMDb ID -> 0 network requests, served from shared-metadata.db.
    const ratingB = await runAsBob(() => getOmdbRating("tt1234567", "shared-omdb-key-v2"));
    assert.equal(ratingB?.imdbRating, "8.9");
    assert.equal(ratingB?.imdbVotes, "42,100");
    assert.equal(omdbFetches, 1);

    // User A writes a fresh TMDB details cache entry -> User B gets both the
    // metadata details and canonical poster URL without any upstream fetch.
    await runAsAlice(() => {
      db.prepare(
        `INSERT OR REPLACE INTO tmdb_metadata_cache
          (id, tmdb_id, media_type, title, details, poster_path, status, schema_version, updated_at_ms)
         VALUES (?, ?, 'tv', ?, ?, ?, 'Returning Series', 9999, ?)`
      ).run(
        "tv_777001",
        "777001",
        "Shared Sci-Fi Show",
        JSON.stringify({
          id: "777001",
          name: "Shared Sci-Fi Show",
          status: "Returning Series",
          poster_path: "/shared-scifi.jpg",
          tv_synopsis_language_version: 1,
          tv_synopsis_language_status: "missing",
          seasons: [{ season_number: 1, episode_count: 10 }],
          external_ids: { tvdb_id: "888001", tmdb_id: "777001" },
          next_airing_date: "2999-01-01",
        }),
        "/shared-scifi.jpg",
        Date.now(),
      );
    });

    const bobDetails = await runAsBob(() =>
      getTmdbDetails({ mediaType: "tv", tmdbId: "777001", title: "Shared Sci-Fi Show", ids: { tvdbId: "888001" } })
    );
    assert.equal(bobDetails?.name, "Shared Sci-Fi Show");
    assert.equal(bobDetails?.cache_stale, undefined);

    const bobPosterUrl = await runAsBob(() =>
      getCanonicalPosterUrl({ media_type: "tv", title: "Shared Sci-Fi Show", tmdb_id: "777001" })
    );
    assert.equal(bobPosterUrl, "/api/tmdb-poster?path=%2Fshared-scifi.jpg&tmdbId=777001&mediaType=tv");

    // Verify one-time migration from adminDb when shared store is empty.
    const sharedDb = getSharedMetadataDb(dataDir);
    for (const table of [
      "tmdb_metadata_cache", "tmdb_search_cache", "tmdb_season_cache", "tmdb_person_cache",
      "tvdb_metadata_cache", "tvdb_season_cache", "omdb_cache", "fanart_cache", "youtube_meta_cache",
    ]) {
      sharedDb.prepare(`DELETE FROM ${table}`).run();
    }
    adminDb.prepare(
      "INSERT OR REPLACE INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)"
    ).run("tt7654321", JSON.stringify({ imdbRating: "7.5" }), Date.now());

    const migrated = migrateProviderCachesFromAdmin(adminDb, dataDir);
    assert.equal(migrated.migrated, true);
    assert.ok(migrated.copied >= 1);
    const copiedRow = sharedDb.prepare("SELECT data FROM omdb_cache WHERE id = ?").get("tt7654321");
    assert.ok(copiedRow);
  } finally {
    globalThis.fetch = realFetch;
    closeAllTenantDatabases();
  }
});
