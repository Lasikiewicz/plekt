import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db } from "../db.js";
import { MEDIA_DIR } from "../paths.js";
import { fetchWithTimeout, normalizeHttpUrl } from "./outbound.js";

const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

function cacheIdFor(mediaKey = "", variant = "poster") {
  const key = variant === "poster" ? mediaKey : `${mediaKey}:${variant}`;
  return crypto.createHash("sha256").update(String(key || "unknown")).digest("hex");
}

function extensionForContentType(contentType = "") {
  const clean = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (clean === "image/png") return "png";
  if (clean === "image/webp") return "webp";
  if (clean === "image/gif") return "gif";
  return "jpg";
}

// Public URL served by the Express static mount at /media.
function publicMediaUrl(storagePath) {
  return `/media/${storagePath}`;
}

function sanitizedRemoteUrl(value = "") {
  if (String(value || "").startsWith("data:image/")) return "data:image-upload";
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (/token|api[_-]?key|key/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch (error) {
    return String(value || "");
  }
}

function freshNegativeCache(data = {}) {
  const updatedAt = Number(data.updatedAtMs || 0);
  if (!updatedAt) return false;
  const ttl = data.status === "missing" ? MISSING_RETRY_MS : FAILED_RETRY_MS;
  return Date.now() - updatedAt < ttl;
}

const selectStmt = db.prepare("SELECT * FROM poster_cache WHERE id = ?");
const selectByMediaAndVariantStmt = db.prepare(
  "SELECT id FROM poster_cache WHERE media_key = ? AND variant = ? ORDER BY updated_at_ms DESC LIMIT 1",
);
const updateIdStmt = db.prepare("UPDATE poster_cache SET id = ? WHERE id = ?");
const upsertStmt = db.prepare(
  `INSERT INTO poster_cache (id, media_key, variant, status, source, detail, original_url, storage_path, content_type, size_bytes, url, updated_at_ms)
   VALUES (@id, @media_key, @variant, @status, @source, @detail, @original_url, @storage_path, @content_type, @size_bytes, @url, @updated_at_ms)
   ON CONFLICT(id) DO UPDATE SET media_key=excluded.media_key, variant=excluded.variant, status=excluded.status,
     source=excluded.source, detail=excluded.detail, original_url=COALESCE(excluded.original_url, original_url),
     storage_path=COALESCE(excluded.storage_path, storage_path), content_type=COALESCE(excluded.content_type, content_type),
     size_bytes=COALESCE(excluded.size_bytes, size_bytes), url=COALESCE(excluded.url, url), updated_at_ms=excluded.updated_at_ms`,
);

function currentCacheIdFor(mediaKey = "", variant = "poster") {
  const id = cacheIdFor(mediaKey, variant);
  const existing = selectByMediaAndVariantStmt.get(mediaKey, variant);
  if (existing && existing.id !== id) {
    // Keep poster-cache rows created with the old digest, including their
    // cached file paths, when upgrading the identifier algorithm.
    updateIdStmt.run(id, existing.id);
  }
  return id;
}

function rowToCache(row) {
  if (!row) return null;
  return {
    id: row.id,
    mediaKey: row.media_key,
    variant: row.variant,
    status: row.status,
    source: row.source,
    detail: row.detail,
    originalUrl: row.original_url,
    storagePath: row.storage_path,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: row.url,
    updatedAtMs: row.updated_at_ms,
  };
}

export async function getPosterCache(mediaKey = "", variant = "poster") {
  if (!mediaKey) return null;
  return rowToCache(selectStmt.get(currentCacheIdFor(mediaKey, variant)));
}

export function usableCachedPoster(cache = {}) {
  const localFileExists = cache?.storagePath && existsSync(path.join(MEDIA_DIR, cache.storagePath));
  if (cache?.status === "cached" && String(cache.url || "").startsWith("/media/") && localFileExists) {
    return { url: cache.url, cached: true, source: cache.source || "cache" };
  }
  if ((cache?.status === "missing" || cache?.status === "failed") && freshNegativeCache(cache)) {
    return { url: null, cached: true, source: cache.source || cache.status || "cache" };
  }
  return null;
}

export async function markPosterMissing(mediaKey = "", source = "unknown", detail = "", variant = "poster") {
  if (!mediaKey) return;
  upsertStmt.run({
    id: currentCacheIdFor(mediaKey, variant),
    media_key: mediaKey,
    variant,
    status: "missing",
    source,
    detail: String(detail || ""),
    original_url: null,
    storage_path: null,
    content_type: null,
    size_bytes: null,
    url: null,
    updated_at_ms: Date.now(),
  });
}

export async function cachePosterFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "poster", width: 340, quality: 80 });
}

export async function cacheBackdropFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "backdrop", width: 1600, quality: 82 });
}

export async function cacheProfileFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "profile", width: 780, quality: 82 });
}

export async function cacheLogoFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "logo", width: 800, quality: 90 });
}

export async function cacheArtworkFromUrl(mediaKey = "", remoteUrl = "", source = "unknown", { variant = "poster", width = 340, quality = 80 } = {}) {
  if (!mediaKey || !remoteUrl) return null;

  const persistBuffer = async (buffer, contentType, originalUrl) => {
    if (!buffer.length || buffer.length > MAX_ARTWORK_BYTES) {
      await markPosterFailure(mediaKey, source, "Artwork body is empty or too large", originalUrl, variant);
      return null;
    }

    let finalBuffer = buffer;
    let finalContentType = contentType;
    let extension = extensionForContentType(contentType);

    try {
      finalBuffer = await sharp(buffer)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      finalContentType = "image/webp";
      extension = "webp";
    } catch (resizeError) {
      console.warn("Artwork optimization via sharp failed, falling back to original buffer", resizeError);
    }

    const cacheId = currentCacheIdFor(mediaKey, variant);
    const storageFolder = variant === "backdrop" ? "backdrops" : variant === "profile" ? "profiles" : variant === "logo" ? "logos" : "posters";
    const storagePath = `${storageFolder}/${cacheId}.${extension}`;
    const absolutePath = path.join(MEDIA_DIR, storagePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, finalBuffer);

    const url = publicMediaUrl(storagePath);
    upsertStmt.run({
      id: cacheId,
      media_key: mediaKey,
      variant,
      status: "cached",
      source,
      detail: null,
      original_url: sanitizedRemoteUrl(originalUrl),
      storage_path: storagePath,
      content_type: finalContentType,
      size_bytes: finalBuffer.length,
      url,
      updated_at_ms: Date.now(),
    });
    return { url, cached: false, source };
  };

  // Handle local cached storage URLs directly without fetching.
  if (String(remoteUrl).startsWith("/media/")) {
    const storagePath = remoteUrl.replace(/^\/media\//, "");
    const absolutePath = path.join(MEDIA_DIR, storagePath);
    const relativeToMediaDir = path.relative(MEDIA_DIR, absolutePath);
    const escapesMediaDir = relativeToMediaDir.startsWith("..") || path.isAbsolute(relativeToMediaDir);
    if (!escapesMediaDir && existsSync(absolutePath)) {
      try {
        const stat = await fs.stat(absolutePath).catch(() => null);
        const cacheId = currentCacheIdFor(mediaKey, variant);
        const extension = path.extname(storagePath).replace(/^\./, "");
        const contentType = extension === "webp" ? "image/webp" : extension === "png" ? "image/png" : "image/jpeg";
        upsertStmt.run({
          id: cacheId,
          media_key: mediaKey,
          variant,
          status: "cached",
          source,
          detail: null,
          original_url: sanitizedRemoteUrl(remoteUrl),
          storage_path: storagePath,
          content_type: contentType,
          size_bytes: stat ? stat.size : null,
          url: remoteUrl,
          updated_at_ms: Date.now(),
        });
        return { url: remoteUrl, cached: true, source };
      } catch (error) {
        console.error("Local poster cache update failed", error);
      }
    }
  }

  if (String(remoteUrl).startsWith("data:image/")) {
    const match = String(remoteUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) {
      await markPosterFailure(mediaKey, source, "Invalid image data URL", remoteUrl, variant);
      return null;
    }
    return persistBuffer(Buffer.from(match[2], "base64"), match[1].toLowerCase(), remoteUrl);
  }

  try {
    // Move X-Plex-Token from the URL to a request header so the token does not
    // appear in HTTP access logs on the upstream server.
    const fetchUrl = new URL(normalizeHttpUrl(remoteUrl, { label: "artwork URL" }));
    const fetchHeaders = { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" };
    const plexToken = fetchUrl.searchParams.get("X-Plex-Token");
    if (plexToken) {
      fetchUrl.searchParams.delete("X-Plex-Token");
      fetchHeaders["X-Plex-Token"] = plexToken;
    }
    const response = await fetchWithTimeout(fetchUrl.toString(), { headers: fetchHeaders }, 12_000);
    if (!response.ok) {
      // Don't persist rate-limit failures - they're transient and would block retries.
      if (response.status !== 429 && response.status !== 503) {
        await markPosterFailure(mediaKey, source, `HTTP ${response.status}`, remoteUrl, variant);
      }
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!String(contentType).toLowerCase().startsWith("image/")) {
      await markPosterFailure(mediaKey, source, `Unexpected content type ${contentType}`, remoteUrl, variant);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_ARTWORK_BYTES) {
      await markPosterFailure(mediaKey, source, `Artwork exceeds ${MAX_ARTWORK_BYTES} bytes`, remoteUrl, variant);
      return null;
    }

    return persistBuffer(Buffer.from(await response.arrayBuffer()), contentType, remoteUrl);
  } catch (error) {
    if (error?.name !== "AbortError") {
      await markPosterFailure(mediaKey, source, error?.message || String(error), remoteUrl, variant).catch(() => null);
    }
    return null;
  }
}

const ARTWORK_SIZES = {
  poster: { width: 340, quality: 80 },
  backdrop: { width: 1600, quality: 82 },
  profile: { width: 780, quality: 82 },
  logo: { width: 800, quality: 90 },
};
const selectByStoragePathStmt = db.prepare(
  "SELECT media_key, variant, source, original_url FROM poster_cache WHERE storage_path = ? AND status = 'cached' LIMIT 1",
);
const restoresInFlight = new Map();

// A cached file that has gone missing from disk (a restore that skipped it, a moved
// data folder) is downloaded again from the source recorded for it. Returns the
// /media URL of the restored file, or null when no downloadable source is recorded.
export async function restoreMissingCachedArtwork(storagePath = "") {
  const row = selectByStoragePathStmt.get(storagePath);
  // Only http(s) sources can be fetched again. Sanitized data-image uploads and
  // local /media paths have nothing to download.
  if (!row || !/^https?:\/\//i.test(row.original_url || "")) return null;
  if (!restoresInFlight.has(storagePath)) {
    const sizes = ARTWORK_SIZES[row.variant] || ARTWORK_SIZES.poster;
    const restore = cacheArtworkFromUrl(row.media_key, row.original_url, row.source, { variant: row.variant, ...sizes })
      .catch(() => null)
      .finally(() => restoresInFlight.delete(storagePath));
    restoresInFlight.set(storagePath, restore);
  }
  const restored = await restoresInFlight.get(storagePath);
  return restored?.url || null;
}

async function markPosterFailure(mediaKey = "", source = "unknown", detail = "", remoteUrl = "", variant = "poster") {
  if (!mediaKey) return;
  upsertStmt.run({
    id: currentCacheIdFor(mediaKey, variant),
    media_key: mediaKey,
    variant,
    status: "failed",
    source,
    detail: String(detail || ""),
    original_url: sanitizedRemoteUrl(remoteUrl),
    storage_path: null,
    content_type: null,
    size_bytes: null,
    url: null,
    updated_at_ms: Date.now(),
  });
}
