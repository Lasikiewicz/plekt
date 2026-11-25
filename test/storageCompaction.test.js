import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-storage-compaction-");

const { adminDb, db, parseJson, toCompressedJson } = await import("../server/src/db.js");
const { isGzipBuffer } = await import("../server/src/utils/jsonCompression.js");
const {
  getSharedMetadataDb,
  purgeMigratedProviderCachesFromAdmin,
} = await import("../server/src/utils/sharedMetadataStore.js");
const {
  compactSharedMetadataStore,
  compactUserDatabase,
  reoptimizeCachedArtwork,
  recompressLegacyPlektBackups,
  vacuumIfReclaimable,
} = await import("../server/src/utils/storageCompaction.js");
const { pruneLogArchive } = await import("../server/src/utils/diagnosticLogger.js");
const { getCanonicalSeasonPosterUrls } = await import("../server/src/utils/mediaArtwork.js");
const { readTitleLanguages } = await import("../server/src/utils/playlistLanguages.js");
const { recordWatchAuditEvent, listWatchAuditEvents, pruneExpiredWatchAuditEvents } = await import("../server/src/utils/watchAudit.js");
const { applyTuningConfig, auditRetentionDays, resetTuningForTests } = await import("../server/src/utils/tuning.js");
const { validateConfig } = await import("../server/src/utils/configStore.js");
const { ENCRYPTED_BACKUP_FORMAT } = await import("../server/src/utils/backupNames.js");
const { readEncryptedEnvelope } = await import("../server/src/utils/plektRestore.js");
const { pruneWindowsNodeModules } = await import("../scripts/build-windows-package.js");

test("toCompressedJson keeps tiny payloads plain and gzips large payloads transparently", () => {
  const small = { a: 1, ok: true };
  const smallEncoded = toCompressedJson(small);
  assert.equal(typeof smallEncoded, "string");
  assert.deepEqual(parseJson(smallEncoded), small);

  const large = { items: Array.from({ length: 80 }, (_, i) => ({ id: i, title: `Episode ${i}`, overview: "A repeating synopsis paragraph for compression." })) };
  const rawLen = Buffer.byteLength(JSON.stringify(large), "utf8");
  const encoded = toCompressedJson(large);
  assert.ok(isGzipBuffer(encoded), "large JSON must compress to a gzip Buffer");
  assert.ok(encoded.length < rawLen / 3, `expected >3x compression (${rawLen} -> ${encoded.length})`);
  assert.deepEqual(parseJson(encoded), large);
});

test("purgeMigratedProviderCachesFromAdmin clears duplicate rows from adminDb once shared-metadata is populated", () => {
  const shared = getSharedMetadataDb(dataDir);
  shared.prepare("INSERT OR REPLACE INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)").run("tt111", JSON.stringify({ imdbRating: "8.0" }), Date.now());
  adminDb.prepare("INSERT OR REPLACE INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)").run("tt111", JSON.stringify({ imdbRating: "8.0" }), Date.now());

  const result = purgeMigratedProviderCachesFromAdmin(adminDb, dataDir);
  assert.equal(result.purged, true);
  assert.ok(result.deleted >= 1);
  assert.equal(adminDb.prepare("SELECT COUNT(*) AS n FROM omdb_cache").get().n, 0);
  assert.equal(shared.prepare("SELECT COUNT(*) AS n FROM omdb_cache WHERE id = 'tt111'").get().n, 1);
});

test("compactSharedMetadataStore compresses provider JSON blobs while preserving TVDB, season-poster, and language lookups", async () => {
  const shared = getSharedMetadataDb(dataDir);
  const bigDetails = {
    id: 424242,
    name: "Compressed Show",
    original_language: "ja",
    status: "Returning Series",
    poster_path: "/show-poster.jpg",
    external_ids: { tvdb_id: 987654 },
    seasons: [
      { season_number: 1, poster_path: "/season-1.jpg" },
      { season_number: 2, poster_path: "/season-2.jpg" },
    ],
    reviews: { results: Array.from({ length: 30 }, (_, i) => ({ author: `u${i}`, content: "Great show! ".repeat(40) })) },
  };
  shared.prepare(
    `INSERT OR REPLACE INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, updated_at_ms)
     VALUES ('tv_424242', '424242', 'tv', 'Compressed Show', ?, ?)`,
  ).run(JSON.stringify(bigDetails), Date.now());

  const result = compactSharedMetadataStore(shared, { vacuum: true });
  assert.ok(result.compressedRows >= 1);
  assert.ok(result.bytesAfter < result.bytesBefore);

  const row = shared.prepare("SELECT details, tvdb_id, original_language, season_posters FROM tmdb_metadata_cache WHERE id = 'tv_424242'").get();
  assert.ok(isGzipBuffer(row.details), "details column must now store gzip Buffer");
  assert.equal(row.tvdb_id, "987654");
  assert.equal(row.original_language, "ja");
  assert.deepEqual(parseJson(row.details).name, "Compressed Show");

  const seasonPosters = getCanonicalSeasonPosterUrls({ media_type: "tv", tmdb_id: "424242", tvdb_id: "987654" });
  assert.equal(seasonPosters.get(1), "/api/tmdb-poster?path=%2Fseason-1.jpg&tmdbId=424242&mediaType=tv");
  assert.equal(seasonPosters.get(2), "/api/tmdb-poster?path=%2Fseason-2.jpg&tmdbId=424242&mediaType=tv");

  const langs = await readTitleLanguages("tv", [{ title: "Compressed Show", ids: { tmdb: "424242" } }]);
  assert.deepEqual(langs, ["ja"]);
});

test("compactUserDatabase compresses large audit payloads, restore reports, and prunes expired tracker sync plans", () => {
  const bigPayload = { note: "diagnostic-detail ".repeat(100) };
  const auditId = recordWatchAuditEvent({
    eventType: "source_event",
    mediaKey: "movie:tmdb:555001",
    title: "Compacted Movie",
    payload: bigPayload,
  });
  // Force uncompressed legacy TEXT payload to verify migration compaction too.
  db.prepare("UPDATE watch_audit_events SET payload = ? WHERE id = ?").run(JSON.stringify(bigPayload), auditId);

  const bigReport = { summary: "ok", items: Array.from({ length: 100 }, (_, i) => ({ id: i, status: "restored" })) };
  db.prepare(
    "INSERT OR REPLACE INTO restore_reports (run_id, result_json, log_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("run-compact-1", JSON.stringify(bigReport), JSON.stringify(Array(100).fill("restored item")), Date.now(), Date.now());

  db.prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run(
    "tracker-full-sync-plan:simkl",
    JSON.stringify({ id: "expired", expiresAt: Date.now() - 10_000, items: Array(100).fill({ title: "old" }) }),
    Date.now(),
  );
  db.prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run(
    "tracker-full-sync-plan:trakt",
    JSON.stringify({ id: "active", expiresAt: Date.now() + 600_000, items: Array(100).fill({ title: "active" }) }),
    Date.now(),
  );

  const result = compactUserDatabase(db, { vacuum: true });
  assert.ok(result.compressedRows >= 3);
  assert.equal(result.prunedPlans, 1);

  assert.equal(db.prepare("SELECT data FROM settings WHERE id = 'tracker-full-sync-plan:simkl'").get(), undefined);
  const activePlanRow = db.prepare("SELECT data FROM settings WHERE id = 'tracker-full-sync-plan:trakt'").get();
  assert.ok(isGzipBuffer(activePlanRow.data));
  assert.equal(parseJson(activePlanRow.data).id, "active");

  const reportRow = db.prepare("SELECT result_json, log_json FROM restore_reports WHERE run_id = 'run-compact-1'").get();
  assert.ok(isGzipBuffer(reportRow.result_json));
  assert.deepEqual(parseJson(reportRow.result_json).summary, "ok");

  const events = listWatchAuditEvents({ mediaKeys: ["movie:tmdb:555001"] });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, bigPayload);
});

test("pruneExpiredWatchAuditEvents respects auditRetentionDays and disables pruning when set to 0", () => {
  db.prepare("DELETE FROM watch_audit_events").run();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const oldId = recordWatchAuditEvent({ eventType: "source_event", title: "Old Audit" });
  const recentId = recordWatchAuditEvent({ eventType: "source_event", title: "Recent Audit" });
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - 120 * DAY, oldId);
  db.prepare("UPDATE watch_audit_events SET created_at = ? WHERE id = ?").run(now - 10 * DAY, recentId);

  assert.equal(pruneExpiredWatchAuditEvents(now, { retentionDays: 0 }), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_audit_events").get().n, 2);

  assert.equal(pruneExpiredWatchAuditEvents(now, { retentionDays: 90 }), 1);
  const remaining = db.prepare("SELECT id FROM watch_audit_events").all().map((r) => r.id);
  assert.deepEqual(remaining, [recentId]);

  applyTuningConfig({ auditRetentionDays: 30 });
  assert.equal(auditRetentionDays(), 30);
  assert.equal(validateConfig({ tuning: { auditRetentionDays: -5 } }).length > 0, true);
  assert.equal(validateConfig({ tuning: { auditRetentionDays: 0 } }).length, 0);
  resetTuningForTests();
});

test("reoptimizeCachedArtwork shrinks oversized backdrops and updates poster_cache.size_bytes", async () => {
  const mediaDir = path.join(dataDir, "artwork-opt-test");
  const backdropsDir = path.join(mediaDir, "backdrops");
  fs.mkdirSync(backdropsDir, { recursive: true });
  const name = `${"c".repeat(40)}.webp`;
  const filePath = path.join(backdropsDir, name);

  // Create a noisy 1920x1080 high-quality WebP backdrop that exceeds the 1280px/q78 target.
  const pixels = crypto.randomBytes(1920 * 1080 * 3);
  const bigWebp = await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 3 } })
    .webp({ quality: 95, effort: 0 })
    .toBuffer();
  fs.writeFileSync(filePath, bigWebp);

  db.prepare(
    `INSERT OR REPLACE INTO poster_cache (id, media_key, variant, status, source, storage_path, content_type, size_bytes, url, updated_at_ms)
     VALUES ('opt-test-1', 'movie:tmdb:opt1', 'backdrop', 'cached', 'tmdb', ?, 'image/webp', ?, ?, ?)`,
  ).run(`backdrops/${name}`, bigWebp.length, `/media/backdrops/${name}`, Date.now());

  const result = await reoptimizeCachedArtwork({ mediaDir, databases: [db] });
  assert.equal(result.scanned, 1);
  assert.equal(result.optimized, 1);
  assert.ok(result.bytesAfter < result.bytesBefore);

  const meta = await sharp(filePath).metadata();
  assert.equal(meta.width, 1280);
  const cachedRow = db.prepare("SELECT size_bytes FROM poster_cache WHERE id = 'opt-test-1'").get();
  assert.equal(cachedRow.size_bytes, fs.statSync(filePath).size);
});

test("recompressLegacyPlektBackups converts v1 encrypted backups to v2 gzipped backups without data loss", async () => {
  const backupsDir = path.join(dataDir, "legacy-backups-test");
  fs.mkdirSync(backupsDir, { recursive: true });
  const filename = "plekt-backup-20261120T030000Z.encrypted.json";
  const filePath = path.join(backupsDir, filename);
  const passphrase = "test-passphrase-for-recompress";

  // Build a v1 (uncompressed) AES-256-GCM encrypted backup.
  const plainJson = JSON.stringify({
    format: "plekt-full-backup",
    version: 1,
    collections: {
      watchHistory: Array.from({ length: 300 }, (_, i) => ({
        id: `wh-${i}`,
        title: `Series Episode ${i}`,
        watchedAt: "2026-11-20T01:00:00.000Z",
        source: "plex",
      })),
    },
  });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainJson, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const v1Envelope = JSON.stringify({
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    encryptedAt: "2026-11-20T03:00:00.000Z",
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: 100000,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
    },
    payload: encrypted.toString("base64"),
  }, null, 2);
  fs.writeFileSync(filePath, v1Envelope, "utf8");
  const originalMtime = new Date("2026-11-20T03:00:00.000Z");
  fs.utimesSync(filePath, originalMtime, originalMtime);

  const result = await recompressLegacyPlektBackups({ backupsDir, passphrase, verify: true });
  assert.equal(result.scanned, 1);
  assert.equal(result.recompressed, 1);
  assert.equal(result.errors.length, 0);
  assert.ok(result.bytesAfter < result.bytesBefore / 3);

  const envelope = readEncryptedEnvelope(filePath);
  assert.equal(envelope.gzip, true);
  assert.equal(Math.floor(fs.statSync(filePath).mtimeMs / 1000), Math.floor(originalMtime.getTime() / 1000));

  // Running a second time skips already-compressed v2 backups.
  const second = await recompressLegacyPlektBackups({ backupsDir, passphrase, verify: true });
  assert.equal(second.recompressed, 0);
  assert.equal(second.skipped, 1);
});

test("pruneWindowsNodeModules strips non-Windows prebuilds, sqlite3.c sources, and sharp-wasm32", () => {
  const nm = path.join(dataDir, "win-nm-test");
  const touch = (rel) => {
    const full = path.join(nm, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  };
  touch("better-sqlite3/deps/sqlite3/sqlite3.c");
  touch("better-sqlite3/src/better_sqlite3.cpp");
  touch("better-sqlite3/prebuilds/win32-x64.node");
  touch("better-sqlite3/prebuilds/linux-x64.node");
  touch("better-sqlite3/prebuilds/darwin-arm64.node");
  touch("@img/sharp-win32-x64/lib/sharp-win32-x64.node");
  touch("@img/sharp-wasm32/lib/sharp-wasm32.node.wasm");
  touch("@img/sharp-linux-x64/lib/sharp-linux-x64.node");
  touch("@img/.sharp-win32-x64-temp999/junk");
  touch(".better-sqlite3-temp123/junk");

  pruneWindowsNodeModules(nm, "x64");

  assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/deps")), false);
  assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/src")), false);
  assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/prebuilds/win32-x64.node")), true);
  assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/prebuilds/linux-x64.node")), false);
  assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/prebuilds/darwin-arm64.node")), false);
  assert.equal(fs.existsSync(path.join(nm, "@img/sharp-win32-x64/lib/sharp-win32-x64.node")), true);
  assert.equal(fs.existsSync(path.join(nm, "@img/sharp-wasm32")), false);
  assert.equal(fs.existsSync(path.join(nm, "@img/sharp-linux-x64")), false);
  assert.equal(fs.existsSync(path.join(nm, "@img/.sharp-win32-x64-temp999")), false);
  assert.equal(fs.existsSync(path.join(nm, ".better-sqlite3-temp123")), false);
});

test("vacuumIfReclaimable defers gracefully when SQLite reports SQLITE_BUSY", () => {
  const fakeBusyDb = {
    name: "",
    pragma(cmd) {
      if (cmd === "page_count") return 10000;
      if (cmd === "page_size") return 4096;
      if (cmd === "freelist_count") return 5000;
      return [];
    },
    exec(sql) {
      if (sql === "VACUUM") {
        const err = new Error("database is locked");
        err.code = "SQLITE_BUSY";
        throw err;
      }
    },
  };
  const result = vacuumIfReclaimable(fakeBusyDb, { force: true });
  assert.equal(result.vacuumed, false);
  assert.equal(result.busy, true);
});

test("pruneLogArchive leaves a live sibling process's active diagnostic log untouched while gzipping closed logs", () => {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const liveSibling = path.join(logsDir, `diagnostic-worker-${process.pid}-1700000000000.jsonl`);
  const rotatedSibling = path.join(logsDir, `diagnostic-worker-${process.pid}-1700000000000.jsonl.1`);
  const deadSibling = path.join(logsDir, "diagnostic-worker-999999999-1700000000000.jsonl");
  fs.writeFileSync(liveSibling, "live-line\n");
  fs.writeFileSync(rotatedSibling, "rotated-line\n");
  fs.writeFileSync(deadSibling, "dead-line\n");

  pruneLogArchive();

  assert.equal(fs.existsSync(liveSibling), true, "active sibling log must stay uncompressed");
  assert.equal(fs.existsSync(`${liveSibling}.gz`), false);
  assert.equal(fs.existsSync(rotatedSibling), false);
  assert.equal(fs.existsSync(`${rotatedSibling}.gz`), true);
  assert.equal(fs.existsSync(deadSibling), false);
  assert.equal(fs.existsSync(`${deadSibling}.gz`), true);
});
