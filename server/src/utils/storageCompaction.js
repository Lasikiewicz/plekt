import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import sharp from "sharp";
import { FULL_BACKUPS_DIR, MEDIA_DIR } from "../paths.js";
import { toCompressedJson, parseCompressedJson } from "./jsonCompression.js";
import { extractTmdbExternalTvdbId, extractTmdbSeasonPosters } from "./sharedMetadataStore.js";
import { ARTWORK_SIZES, ARTWORK_WEBP_EFFORT, writeArtworkFile } from "./posterCache.js";
import { readEncryptedEnvelope } from "./plektRestore.js";
import { ENCRYPTED_BACKUP_FORMAT, FULL_BACKUP_FILE_PATTERN } from "./backupNames.js";

import { yieldToEventLoop } from "./eventLoop.js";

const pbkdf2 = promisify(crypto.pbkdf2);

const SHARED_COMPRESSED_COLUMNS = [
  { table: "tmdb_metadata_cache", idCol: "id", dataCol: "details", backfillTmdb: true },
  { table: "tmdb_season_cache", idCol: "id", dataCol: "details" },
  { table: "tmdb_search_cache", idCol: "id", dataCol: "response" },
  { table: "tmdb_person_cache", idCol: "id", dataCol: "details" },
  { table: "tvdb_metadata_cache", idCol: "id", dataCol: "details" },
  { table: "tvdb_season_cache", idCol: "id", dataCol: "details" },
  { table: "omdb_cache", idCol: "id", dataCol: "data" },
  { table: "fanart_cache", idCol: "id", dataCol: "data" },
  { table: "youtube_meta_cache", idCol: "id", dataCol: "data" },
];

const DEFAULT_MIN_COMPRESS_BYTES = 512;
const DEFAULT_VACUUM_MIN_FREE_BYTES = 16 * 1024 * 1024;
const DEFAULT_VACUUM_MIN_FREE_RATIO = 0.15;
const FOLDER_TO_VARIANT = Object.freeze({
  posters: "poster",
  backdrops: "backdrop",
  profiles: "profile",
  logos: "logo",
});

function dbFileSize(database) {
  try {
    return database?.name && fs.existsSync(database.name) ? fs.statSync(database.name).size : 0;
  } catch {
    return 0;
  }
}

export function vacuumIfReclaimable(
  database,
  {
    minFreeBytes = DEFAULT_VACUUM_MIN_FREE_BYTES,
    minFreeRatio = DEFAULT_VACUUM_MIN_FREE_RATIO,
    force = false,
  } = {},
) {
  if (!database) return { vacuumed: false, beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 };
  const pageCount = Number(database.pragma("page_count", { simple: true }) || 0);
  const pageSize = Number(database.pragma("page_size", { simple: true }) || 4096);
  const freelistCount = Number(database.pragma("freelist_count", { simple: true }) || 0);
  const totalBytes = pageCount * pageSize;
  const freeBytes = freelistCount * pageSize;
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;

  if (!force && (freeBytes < minFreeBytes || freeRatio < minFreeRatio)) {
    return { vacuumed: false, beforeBytes: totalBytes, afterBytes: totalBytes, reclaimedBytes: 0 };
  }

  const beforeBytes = dbFileSize(database) || totalBytes;
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.exec("VACUUM");
    database.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") {
      return { vacuumed: false, busy: true, beforeBytes, afterBytes: beforeBytes, reclaimedBytes: 0 };
    }
    throw error;
  }
  const afterBytes = dbFileSize(database) || Number(database.pragma("page_count", { simple: true }) || 0) * pageSize;
  return {
    vacuumed: true,
    beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
  };
}

function compressTableColumn(database, { table, idCol, dataCol, backfillTmdb = false, batchSize = 200, minBytes = DEFAULT_MIN_COMPRESS_BYTES }) {
  const selectBatch = backfillTmdb
    ? database.prepare(
      `SELECT ${idCol} AS row_id, ${dataCol} AS raw_val, tvdb_id, season_posters, original_language, status,
              poster_path, cached_poster_url, backdrop_path, cached_backdrop_url, tvdb_poster_url
         FROM ${table}
        WHERE typeof(${dataCol}) = 'text' AND LENGTH(${dataCol}) >= ?
        LIMIT ?`,
    )
    : database.prepare(
      `SELECT ${idCol} AS row_id, ${dataCol} AS raw_val
         FROM ${table}
        WHERE typeof(${dataCol}) = 'text' AND LENGTH(${dataCol}) >= ?
        LIMIT ?`,
    );

  const updateRow = backfillTmdb
    ? database.prepare(
      `UPDATE ${table}
          SET ${dataCol} = @val,
              tvdb_id = COALESCE(tvdb_id, @tvdb_id),
              season_posters = COALESCE(season_posters, @season_posters),
              original_language = COALESCE(original_language, @original_language),
              status = COALESCE(status, @status),
              poster_path = COALESCE(poster_path, @poster_path),
              cached_poster_url = COALESCE(cached_poster_url, @cached_poster_url),
              backdrop_path = COALESCE(backdrop_path, @backdrop_path),
              cached_backdrop_url = COALESCE(cached_backdrop_url, @cached_backdrop_url),
              tvdb_poster_url = COALESCE(tvdb_poster_url, @tvdb_poster_url)
        WHERE ${idCol} = @id`,
    )
    : database.prepare(`UPDATE ${table} SET ${dataCol} = @val WHERE ${idCol} = @id`);

  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const skipped = new Set();

  while (true) {
    const rows = selectBatch.all(minBytes, batchSize);
    const actionable = rows.filter((row) => !skipped.has(row.row_id));
    if (!actionable.length) break;

    let batchCompressed = 0;
    database.transaction(() => {
      for (const row of actionable) {
        const text = String(row.raw_val ?? "");
        const rawBytes = Buffer.byteLength(text, "utf8");
        const encoded = toCompressedJson(text, { minBytes });
        if (!Buffer.isBuffer(encoded)) {
          skipped.add(row.row_id);
          continue;
        }
        if (backfillTmdb) {
          const parsed = parseCompressedJson(text, null);
          const details = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          updateRow.run({
            id: row.row_id,
            val: encoded,
            tvdb_id: extractTmdbExternalTvdbId(details),
            season_posters: extractTmdbSeasonPosters(details),
            original_language: typeof details.original_language === "string" && details.original_language
              ? details.original_language.toLowerCase()
              : null,
            status: details.status || null,
            poster_path: details.poster_path || null,
            cached_poster_url: details.cached_poster_url || details.cachedPosterUrl || null,
            backdrop_path: details.backdrop_path || null,
            cached_backdrop_url: details.cached_backdrop_url || details.cachedBackdropUrl || null,
            tvdb_poster_url: details.tvdb_poster_url || details.tvdbPosterUrl || null,
          });
        } else {
          updateRow.run({ id: row.row_id, val: encoded });
        }
        bytesBefore += rawBytes;
        bytesAfter += encoded.length;
        compressedRows += 1;
        batchCompressed += 1;
      }
    })();

    if (batchCompressed === 0) break;
  }

  return { compressedRows, bytesBefore, bytesAfter };
}

export function compactSharedMetadataStore(sharedDb, { vacuum = true, batchSize = 200 } = {}) {
  if (!sharedDb) return { compressedRows: 0, bytesBefore: 0, bytesAfter: 0, vacuum: null };
  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const spec of SHARED_COMPRESSED_COLUMNS) {
    try {
      const result = compressTableColumn(sharedDb, { ...spec, batchSize });
      compressedRows += result.compressedRows;
      bytesBefore += result.bytesBefore;
      bytesAfter += result.bytesAfter;
    } catch (error) {
      console.warn(`Shared metadata compaction skipped ${spec.table}:`, error?.message || error);
    }
  }

  const vacuumResult = vacuum
    ? vacuumIfReclaimable(sharedDb, { force: compressedRows > 0 })
    : null;

  return { compressedRows, bytesBefore, bytesAfter, vacuum: vacuumResult };
}

export function compactUserDatabase(database, { vacuum = true, batchSize = 500 } = {}) {
  if (!database) return { compressedRows: 0, prunedPlans: 0, bytesBefore: 0, bytesAfter: 0, vacuum: null };
  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let prunedPlans = 0;

  for (const spec of [
    { table: "watch_audit_events", idCol: "id", dataCol: "payload" },
    { table: "restore_reports", idCol: "run_id", dataCol: "result_json" },
    { table: "restore_reports", idCol: "run_id", dataCol: "log_json" },
  ]) {
    try {
      const result = compressTableColumn(database, { ...spec, batchSize });
      compressedRows += result.compressedRows;
      bytesBefore += result.bytesBefore;
      bytesAfter += result.bytesAfter;
    } catch (error) {
      console.warn(`Database compaction skipped ${spec.table}.${spec.dataCol}:`, error?.message || error);
    }
  }

  // Prune expired tracker full-sync plans in settings and compress any active ones.
  try {
    const planRows = database
      .prepare("SELECT id, data FROM settings WHERE id LIKE 'tracker-full-sync-plan:%'")
      .all();
    const now = Date.now();
    const deletePlan = database.prepare("DELETE FROM settings WHERE id = ?");
    const updatePlan = database.prepare("UPDATE settings SET data = ? WHERE id = ?");
    database.transaction(() => {
      for (const row of planRows) {
        const plan = parseCompressedJson(row.data, null);
        if (!plan || (Number(plan.expiresAt) > 0 && Number(plan.expiresAt) <= now)) {
          deletePlan.run(row.id);
          prunedPlans += 1;
          continue;
        }
        if (typeof row.data === "string" && Buffer.byteLength(row.data, "utf8") >= DEFAULT_MIN_COMPRESS_BYTES) {
          const encoded = toCompressedJson(row.data);
          if (Buffer.isBuffer(encoded)) {
            bytesBefore += Buffer.byteLength(row.data, "utf8");
            bytesAfter += encoded.length;
            updatePlan.run(encoded, row.id);
            compressedRows += 1;
          }
        }
      }
    })();
  } catch (error) {
    console.warn("Tracker full-sync plan compaction skipped:", error?.message || error);
  }

  const vacuumResult = vacuum
    ? vacuumIfReclaimable(database, { force: compressedRows > 0 || prunedPlans > 0 })
    : null;

  return { compressedRows, prunedPlans, bytesBefore, bytesAfter, vacuum: vacuumResult };
}

export function countUncompactedSharedRows(sharedDb, { minBytes = DEFAULT_MIN_COMPRESS_BYTES } = {}) {
  if (!sharedDb) return 0;
  let total = 0;
  for (const spec of SHARED_COMPRESSED_COLUMNS) {
    try {
      const row = sharedDb
        .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE typeof(${spec.dataCol}) = 'text' AND LENGTH(${spec.dataCol}) >= ?`)
        .get(minBytes);
      total += Number(row?.n || 0);
    } catch { /* table missing */ }
  }
  return total;
}

export function countUncompactedUserRows(database, { minBytes = DEFAULT_MIN_COMPRESS_BYTES } = {}) {
  if (!database) return 0;
  let total = 0;
  for (const spec of [
    { table: "watch_audit_events", dataCol: "payload" },
    { table: "restore_reports", dataCol: "result_json" },
    { table: "restore_reports", dataCol: "log_json" },
  ]) {
    try {
      const row = database
        .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE typeof(${spec.dataCol}) = 'text' AND LENGTH(${spec.dataCol}) >= ?`)
        .get(minBytes);
      total += Number(row?.n || 0);
    } catch { /* table missing */ }
  }
  try {
    const planRows = database
      .prepare("SELECT data FROM settings WHERE id LIKE 'tracker-full-sync-plan:%'")
      .all();
    const now = Date.now();
    for (const row of planRows) {
      const plan = parseCompressedJson(row.data, null);
      if (!plan || (Number(plan.expiresAt) > 0 && Number(plan.expiresAt) <= now)) {
        total += 1;
      } else if (typeof row.data === "string" && Buffer.byteLength(row.data, "utf8") >= minBytes) {
        total += 1;
      }
    }
  } catch { /* ignore */ }
  return total;
}

export function hasReclaimableFreelist(
  database,
  {
    minFreeBytes = DEFAULT_VACUUM_MIN_FREE_BYTES,
    minFreeRatio = DEFAULT_VACUUM_MIN_FREE_RATIO,
  } = {},
) {
  if (!database) return false;
  try {
    const pageCount = Number(database.pragma("page_count", { simple: true }) || 0);
    const pageSize = Number(database.pragma("page_size", { simple: true }) || 4096);
    const freelistCount = Number(database.pragma("freelist_count", { simple: true }) || 0);
    const totalBytes = pageCount * pageSize;
    const freeBytes = freelistCount * pageSize;
    return freeBytes >= minFreeBytes && (totalBytes > 0 ? freeBytes / totalBytes >= minFreeRatio : false);
  } catch {
    return false;
  }
}

async function compressTableColumnAsync(
  database,
  { table, idCol, dataCol, backfillTmdb = false, batchSize = 150, minBytes = DEFAULT_MIN_COMPRESS_BYTES, onBatch = null, shouldStop = null },
) {
  const selectBatch = backfillTmdb
    ? database.prepare(
      `SELECT ${idCol} AS row_id, ${dataCol} AS raw_val, tvdb_id, season_posters, original_language, status,
              poster_path, cached_poster_url, backdrop_path, cached_backdrop_url, tvdb_poster_url
         FROM ${table}
        WHERE typeof(${dataCol}) = 'text' AND LENGTH(${dataCol}) >= ?
        LIMIT ?`,
    )
    : database.prepare(
      `SELECT ${idCol} AS row_id, ${dataCol} AS raw_val
         FROM ${table}
        WHERE typeof(${dataCol}) = 'text' AND LENGTH(${dataCol}) >= ?
        LIMIT ?`,
    );

  const updateRow = backfillTmdb
    ? database.prepare(
      `UPDATE ${table}
          SET ${dataCol} = @val,
              tvdb_id = COALESCE(tvdb_id, @tvdb_id),
              season_posters = COALESCE(season_posters, @season_posters),
              original_language = COALESCE(original_language, @original_language),
              status = COALESCE(status, @status),
              poster_path = COALESCE(poster_path, @poster_path),
              cached_poster_url = COALESCE(cached_poster_url, @cached_poster_url),
              backdrop_path = COALESCE(backdrop_path, @backdrop_path),
              cached_backdrop_url = COALESCE(cached_backdrop_url, @cached_backdrop_url),
              tvdb_poster_url = COALESCE(tvdb_poster_url, @tvdb_poster_url)
        WHERE ${idCol} = @id`,
    )
    : database.prepare(`UPDATE ${table} SET ${dataCol} = @val WHERE ${idCol} = @id`);

  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const skipped = new Set();

  while (true) {
    if (shouldStop?.()) break;
    const rows = selectBatch.all(minBytes, batchSize);
    const actionable = rows.filter((row) => !skipped.has(row.row_id));
    if (!actionable.length) break;

    let batchCompressed = 0;
    let batchBefore = 0;
    let batchAfter = 0;
    database.transaction(() => {
      for (const row of actionable) {
        const text = String(row.raw_val ?? "");
        const rawBytes = Buffer.byteLength(text, "utf8");
        const encoded = toCompressedJson(text, { minBytes });
        if (!Buffer.isBuffer(encoded)) {
          skipped.add(row.row_id);
          continue;
        }
        if (backfillTmdb) {
          const parsed = parseCompressedJson(text, null);
          const details = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          updateRow.run({
            id: row.row_id,
            val: encoded,
            tvdb_id: extractTmdbExternalTvdbId(details),
            season_posters: extractTmdbSeasonPosters(details),
            original_language: typeof details.original_language === "string" && details.original_language
              ? details.original_language.toLowerCase()
              : null,
            status: details.status || null,
            poster_path: details.poster_path || null,
            cached_poster_url: details.cached_poster_url || details.cachedPosterUrl || null,
            backdrop_path: details.backdrop_path || null,
            cached_backdrop_url: details.cached_backdrop_url || details.cachedBackdropUrl || null,
            tvdb_poster_url: details.tvdb_poster_url || details.tvdbPosterUrl || null,
          });
        } else {
          updateRow.run({ id: row.row_id, val: encoded });
        }
        batchBefore += rawBytes;
        batchAfter += encoded.length;
        batchCompressed += 1;
      }
    })();

    compressedRows += batchCompressed;
    bytesBefore += batchBefore;
    bytesAfter += batchAfter;
    if (batchCompressed > 0) {
      onBatch?.({ rows: batchCompressed, savedBytes: Math.max(0, batchBefore - batchAfter) });
    }
    if (batchCompressed === 0) break;
    await yieldToEventLoop();
  }

  return { compressedRows, bytesBefore, bytesAfter };
}

export async function compactSharedMetadataStoreAsync(
  sharedDb,
  { vacuum = true, batchSize = 150, onBatch = null, shouldStop = null } = {},
) {
  if (!sharedDb) return { compressedRows: 0, bytesBefore: 0, bytesAfter: 0, vacuum: null };
  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const spec of SHARED_COMPRESSED_COLUMNS) {
    if (shouldStop?.()) break;
    try {
      const result = await compressTableColumnAsync(sharedDb, { ...spec, batchSize, onBatch, shouldStop });
      compressedRows += result.compressedRows;
      bytesBefore += result.bytesBefore;
      bytesAfter += result.bytesAfter;
    } catch (error) {
      console.warn(`Shared metadata compaction skipped ${spec.table}:`, error?.message || error);
    }
  }

  const vacuumResult = vacuum && !shouldStop?.()
    ? vacuumIfReclaimable(sharedDb, { force: compressedRows > 0 })
    : null;

  return { compressedRows, bytesBefore, bytesAfter, vacuum: vacuumResult };
}

export async function compactUserDatabaseAsync(
  database,
  { vacuum = true, batchSize = 400, onBatch = null, shouldStop = null } = {},
) {
  if (!database) return { compressedRows: 0, prunedPlans: 0, bytesBefore: 0, bytesAfter: 0, vacuum: null };
  let compressedRows = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let prunedPlans = 0;

  for (const spec of [
    { table: "watch_audit_events", idCol: "id", dataCol: "payload" },
    { table: "restore_reports", idCol: "run_id", dataCol: "result_json" },
    { table: "restore_reports", idCol: "run_id", dataCol: "log_json" },
  ]) {
    if (shouldStop?.()) break;
    try {
      const result = await compressTableColumnAsync(database, { ...spec, batchSize, onBatch, shouldStop });
      compressedRows += result.compressedRows;
      bytesBefore += result.bytesBefore;
      bytesAfter += result.bytesAfter;
    } catch (error) {
      console.warn(`Database compaction skipped ${spec.table}.${spec.dataCol}:`, error?.message || error);
    }
  }

  if (!shouldStop?.()) {
    try {
      const planRows = database
        .prepare("SELECT id, data FROM settings WHERE id LIKE 'tracker-full-sync-plan:%'")
        .all();
      const now = Date.now();
      const deletePlan = database.prepare("DELETE FROM settings WHERE id = ?");
      const updatePlan = database.prepare("UPDATE settings SET data = ? WHERE id = ?");
      let planSaved = 0;
      let planTouched = 0;
      database.transaction(() => {
        for (const row of planRows) {
          const plan = parseCompressedJson(row.data, null);
          if (!plan || (Number(plan.expiresAt) > 0 && Number(plan.expiresAt) <= now)) {
            const rawLen = typeof row.data === "string" ? Buffer.byteLength(row.data, "utf8") : (Buffer.isBuffer(row.data) ? row.data.length : 0);
            deletePlan.run(row.id);
            prunedPlans += 1;
            planSaved += rawLen;
            planTouched += 1;
            continue;
          }
          if (typeof row.data === "string" && Buffer.byteLength(row.data, "utf8") >= DEFAULT_MIN_COMPRESS_BYTES) {
            const rawLen = Buffer.byteLength(row.data, "utf8");
            const encoded = toCompressedJson(row.data);
            if (Buffer.isBuffer(encoded)) {
              bytesBefore += rawLen;
              bytesAfter += encoded.length;
              planSaved += Math.max(0, rawLen - encoded.length);
              updatePlan.run(encoded, row.id);
              compressedRows += 1;
              planTouched += 1;
            }
          }
        }
      })();
      if (planTouched > 0) onBatch?.({ rows: planTouched, savedBytes: planSaved });
    } catch (error) {
      console.warn("Tracker full-sync plan compaction skipped:", error?.message || error);
    }
  }

  const vacuumResult = vacuum && !shouldStop?.()
    ? vacuumIfReclaimable(database, { force: compressedRows > 0 || prunedPlans > 0 })
    : null;

  return { compressedRows, prunedPlans, bytesBefore, bytesAfter, vacuum: vacuumResult };
}

export async function reoptimizeCachedArtwork({
  mediaDir = MEDIA_DIR,
  databases = [],
  minSavingsRatio = 0.05,
  throttleMs = 0,
  onProgress = null,
  shouldStop = null,
} = {}) {
  let scanned = 0;
  let optimized = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let totalFiles = 0;

  const worklist = [];
  for (const [folder, variant] of Object.entries(FOLDER_TO_VARIANT)) {
    const directory = path.join(mediaDir, folder);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{32,64}\.webp$/i.test(entry.name)) continue;
      worklist.push({ folder, variant, name: entry.name, absolutePath: path.join(directory, entry.name) });
    }
  }
  totalFiles = worklist.length;

  const updateSizeStmts = (Array.isArray(databases) ? databases : [])
    .filter(Boolean)
    .map((database) => database.prepare("UPDATE poster_cache SET size_bytes = ? WHERE storage_path = ?"));

  for (const item of worklist) {
    if (shouldStop?.()) break;
    const { width, quality } = ARTWORK_SIZES[item.variant];
    const storagePath = `${item.folder}/${item.name}`;
    scanned += 1;
    let raw;
    try {
      raw = await fsp.readFile(item.absolutePath);
    } catch {
      continue;
    }
    if (!raw.length) continue;
    bytesBefore += raw.length;

    let candidate;
    try {
      candidate = await sharp(raw)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality, effort: ARTWORK_WEBP_EFFORT })
        .toBuffer();
    } catch {
      bytesAfter += raw.length;
      continue;
    }

    if (candidate.length < raw.length * (1 - minSavingsRatio)) {
      try {
        await writeArtworkFile(item.absolutePath, candidate);
        for (const stmt of updateSizeStmts) {
          try { stmt.run(candidate.length, storagePath); } catch { /* ignore */ }
        }
        bytesAfter += candidate.length;
        optimized += 1;
      } catch {
        bytesAfter += raw.length;
      }
    } else {
      bytesAfter += raw.length;
    }

    onProgress?.({
      scanned,
      total: totalFiles,
      optimized,
      savedBytes: Math.max(0, bytesBefore - bytesAfter),
    });

    if (throttleMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, throttleMs);
        timer.unref?.();
      });
    } else if (scanned % 10 === 0) {
      await yieldToEventLoop();
    }
  }

  return {
    scanned,
    total: totalFiles,
    optimized,
    bytesBefore,
    bytesAfter,
    savedBytes: Math.max(0, bytesBefore - bytesAfter),
    stopped: Boolean(shouldStop?.()),
  };
}

async function verifyEncryptedV2File(filePath, passphrase) {
  const envelope = readEncryptedEnvelope(filePath);
  if (!envelope || !envelope.gzip) throw new Error("Recompressed backup envelope is not gzipped v2");
  const key = await pbkdf2(passphrase, envelope.salt, envelope.iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.iv);
  const gunzip = zlib.createGunzip();

  let carry = "";
  let held = Buffer.alloc(0);
  let ended = false;
  let decompressedBytes = 0;

  const gunzipDone = new Promise((resolve, reject) => {
    gunzip.on("data", (chunk) => { decompressedBytes += chunk.length; });
    gunzip.on("end", resolve);
    gunzip.on("error", reject);
  });

  const feedBase64 = (text) => {
    const combined = carry + text;
    const usable = combined.length - (combined.length % 4);
    carry = combined.slice(usable);
    if (!usable) return;
    const bytes = Buffer.concat([held, Buffer.from(combined.slice(0, usable), "base64")]);
    held = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 16)));
    const body = bytes.subarray(0, Math.max(0, bytes.length - 16));
    if (body.length) {
      const plain = decipher.update(body);
      if (plain.length) gunzip.write(plain);
    }
  };

  for await (const chunk of fs.createReadStream(filePath, { start: envelope.payloadOffset, highWaterMark: 1024 * 1024 })) {
    if (ended) continue;
    const quote = chunk.indexOf(0x22);
    const text = (quote >= 0 ? chunk.subarray(0, quote) : chunk).toString("latin1");
    if (quote >= 0) ended = true;
    feedBase64(text);
  }
  if (!ended || carry || held.length !== 16) throw new Error("Recompressed backup payload is incomplete");
  decipher.setAuthTag(held);
  const finalPlain = decipher.final();
  if (finalPlain.length) gunzip.write(finalPlain);
  gunzip.end();
  await gunzipDone;
  if (decompressedBytes <= 0) throw new Error("Recompressed backup decompressed to empty output");
  return decompressedBytes;
}

export async function recompressLegacyPlektBackups({
  backupsDir = FULL_BACKUPS_DIR,
  passphrase = "",
  verify = true,
} = {}) {
  if (!passphrase || !fs.existsSync(backupsDir)) {
    return { scanned: 0, recompressed: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, savedBytes: 0, errors: [] };
  }

  let scanned = 0;
  let recompressed = 0;
  let skipped = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const errors = [];

  const names = fs.readdirSync(backupsDir).filter((name) => FULL_BACKUP_FILE_PATTERN.test(name)).sort();
  for (const name of names) {
    scanned += 1;
    const filePath = path.join(backupsDir, name);
    const stat = fs.statSync(filePath);
    bytesBefore += stat.size;

    let envelope;
    try {
      envelope = readEncryptedEnvelope(filePath);
    } catch (error) {
      skipped += 1;
      bytesAfter += stat.size;
      errors.push({ name, error: error.message });
      continue;
    }

    if (!envelope || envelope.gzip) {
      skipped += 1;
      bytesAfter += stat.size;
      continue;
    }

    const tempPath = `${filePath}.recompress-${process.pid}.tmp`;
    let fd = null;
    try {
      const readKey = await pbkdf2(passphrase, envelope.salt, envelope.iterations, 32, "sha256");
      const decipher = crypto.createDecipheriv("aes-256-gcm", readKey, envelope.iv);

      const newSalt = crypto.randomBytes(16);
      const newIv = crypto.randomBytes(12);
      const writeKey = await pbkdf2(passphrase, newSalt, 100000, 32, "sha256");
      const cipher = crypto.createCipheriv("aes-256-gcm", writeKey, newIv);

      const outEnvelope = JSON.stringify({
        format: ENCRYPTED_BACKUP_FORMAT,
        version: 2,
        compression: "gzip",
        encryptedAt: stat.mtime.toISOString(),
        encryption: {
          algorithm: "AES-256-GCM",
          kdf: "PBKDF2",
          hash: "SHA-256",
          iterations: 100000,
          salt: newSalt.toString("base64"),
          iv: newIv.toString("base64"),
        },
        payload: "",
      }, null, 2);
      const payloadAt = outEnvelope.lastIndexOf('"payload": ""') + '"payload": "'.length;

      fd = fs.openSync(tempPath, "w", 0o600);
      let outCarry = Buffer.alloc(0);
      const writeText = (txt) => fs.writeSync(fd, txt, null, "utf8");
      const writeEncrypted = (bytes) => {
        const combined = outCarry.length ? Buffer.concat([outCarry, bytes]) : bytes;
        const usable = combined.length - (combined.length % 3);
        if (usable) writeText(combined.subarray(0, usable).toString("base64"));
        outCarry = Buffer.from(combined.subarray(usable));
      };

      writeText(outEnvelope.slice(0, payloadAt));

      let inCarry = "";
      let held = Buffer.alloc(0);
      let ended = false;
      let pendingBufs = [];
      let pendingBytes = 0;

      const flushPlain = () => {
        if (!pendingBytes) return;
        const joined = pendingBufs.length === 1 ? pendingBufs[0] : Buffer.concat(pendingBufs, pendingBytes);
        writeEncrypted(cipher.update(zlib.gzipSync(joined, { level: 6 })));
        pendingBufs = [];
        pendingBytes = 0;
      };

      const feedBase64 = (text) => {
        const combined = inCarry + text;
        const usable = combined.length - (combined.length % 4);
        inCarry = combined.slice(usable);
        if (!usable) return;
        const bytes = Buffer.concat([held, Buffer.from(combined.slice(0, usable), "base64")]);
        held = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 16)));
        const body = bytes.subarray(0, Math.max(0, bytes.length - 16));
        if (body.length) {
          const plain = decipher.update(body);
          if (plain.length) {
            pendingBufs.push(plain);
            pendingBytes += plain.length;
            if (pendingBytes >= 1024 * 1024) flushPlain();
          }
        }
      };

      for await (const chunk of fs.createReadStream(filePath, { start: envelope.payloadOffset, highWaterMark: 1024 * 1024 })) {
        if (ended) continue;
        const quote = chunk.indexOf(0x22);
        const text = (quote >= 0 ? chunk.subarray(0, quote) : chunk).toString("latin1");
        if (quote >= 0) ended = true;
        feedBase64(text);
      }
      if (!ended || inCarry || held.length !== 16) {
        throw new Error("Could not decrypt legacy backup payload");
      }
      decipher.setAuthTag(held);
      const lastPlain = decipher.final();
      if (lastPlain.length) {
        pendingBufs.push(lastPlain);
        pendingBytes += lastPlain.length;
      }
      flushPlain();

      writeEncrypted(cipher.final());
      writeEncrypted(cipher.getAuthTag());
      if (outCarry.length) writeText(outCarry.toString("base64"));
      writeText(outEnvelope.slice(payloadAt));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      if (verify) {
        await verifyEncryptedV2File(tempPath, passphrase);
      }

      fs.utimesSync(tempPath, stat.atime, stat.mtime);
      fs.renameSync(tempPath, filePath);
      const newSize = fs.statSync(filePath).size;
      bytesAfter += newSize;
      recompressed += 1;
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
      bytesAfter += stat.size;
      errors.push({ name, error: error.message || String(error) });
    }
  }

  return {
    scanned,
    recompressed,
    skipped,
    bytesBefore,
    bytesAfter,
    savedBytes: Math.max(0, bytesBefore - bytesAfter),
    errors,
  };
}
