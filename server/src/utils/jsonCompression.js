import zlib from "node:zlib";

// Transparent gzip compression for large JSON payloads stored in SQLite TEXT
// columns. SQLite TEXT affinity preserves BLOB values untouched, and
// better-sqlite3 returns BLOBs as Buffer and TEXT as string, so callers can
// read both legacy uncompressed JSON and compressed payloads seamlessly.

const DEFAULT_MIN_BYTES = 512;
const DEFAULT_GZIP_LEVEL = 6;

export function isGzipBuffer(value) {
  return Buffer.isBuffer(value) && value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b;
}

export function toCompressedJson(value, { minBytes = DEFAULT_MIN_BYTES, level = DEFAULT_GZIP_LEVEL } = {}) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text == null) return null;
  const rawBytes = Buffer.byteLength(text, "utf8");
  if (rawBytes < minBytes) return text;
  const compressed = zlib.gzipSync(Buffer.from(text, "utf8"), { level });
  return compressed.length < rawBytes ? compressed : text;
}

export function decompressJsonText(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) {
    return isGzipBuffer(value)
      ? zlib.gunzipSync(value).toString("utf8")
      : value.toString("utf8");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseCompressedJson(value, fallback = null) {
  if (value == null) return fallback;
  if (Buffer.isBuffer(value)) {
    try {
      const text = isGzipBuffer(value)
        ? zlib.gunzipSync(value).toString("utf8")
        : value.toString("utf8");
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
