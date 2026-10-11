// S3-compatible adapter (AWS S3, Backblaze B2, MinIO, Wasabi, ...). Implements just
// enough SigV4 (PUT / GET / DELETE / ListObjectsV2) to avoid pulling in the large
// @aws-sdk/client-s3 dependency. Settings: { endpoint?, region, bucket, prefix?,
// accessKeyId, forcePathStyle? }  Secrets: { secretAccessKey }
import crypto from "node:crypto";
import fs from "node:fs";
import { fetchWithTimeout, uploadFileWithTimeout } from "../outbound.js";
import { REMOTE_BACKUP_FILE_PATTERN } from "../backupNames.js";

const FILE_PATTERN = REMOTE_BACKUP_FILE_PATTERN;
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// RFC 3986 encoding; S3 keeps "/" as a path separator in the canonical URI.
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key) {
  return key.split("/").map(encodeRfc3986).join("/");
}

// Extract the bare region token from whatever the user typed - a plain region,
// the full endpoint host, or a value that still carries the "s3." prefix or
// ".backblazeb2.com"/".amazonaws.com" suffix (all common copy/paste mistakes).
function deriveRegion(raw) {
  let value = String(raw || "").trim().replace(/^https?:\/\//i, "");
  value = value.replace(/\/.*$/, "");                               // drop any path
  value = value.replace(/\.(backblazeb2|amazonaws)\.com$/i, "");    // drop provider domain
  value = value.replace(/^[^.]*\.s3[.-]/i, "").replace(/^s3[.-]/i, ""); // drop optional bucket + s3 prefix
  return value;
}

function s3Config(destination) {
  const bucket = String(destination.settings?.bucket || "").trim();
  if (!bucket) throw new Error("S3 bucket is required");
  const accessKeyId = String(destination.settings?.accessKeyId || "").trim();
  const secretAccessKey = String(destination.secrets?.secretAccessKey || "").trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("S3 access key and secret are required");

  let endpoint = String(destination.settings?.endpoint || "").trim();
  let region = deriveRegion(destination.settings?.region);
  if (!region && endpoint) region = deriveRegion(endpoint);
  if (!region) region = "us-east-1";

  // Backblaze B2 endpoints follow s3.<region>.backblazeb2.com; AWS uses s3.<region>.amazonaws.com.
  if (!endpoint) {
    endpoint = destination.type === "backblaze"
      ? `https://s3.${region}.backblazeb2.com`
      : `https://s3.${region}.amazonaws.com`;
  } else if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `https://${endpoint}`;
  }
  endpoint = endpoint.replace(/\/+$/, "");

  // Default to path-style: required by MinIO and most non-AWS providers.
  const forcePathStyle = destination.settings?.forcePathStyle !== false;
  let prefix = String(destination.settings?.prefix || "").trim().replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { region, bucket, accessKeyId, secretAccessKey, endpoint, forcePathStyle, prefix };
}

function buildUrl(cfg, key, query) {
  const base = new URL(cfg.endpoint);
  let host = base.host;
  let pathname;
  if (cfg.forcePathStyle) {
    pathname = `/${cfg.bucket}/${encodeKeyPath(key)}`;
  } else {
    host = `${cfg.bucket}.${base.host}`;
    pathname = `/${encodeKeyPath(key)}`;
  }
  const search = query
    ? `?${Object.keys(query).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`).join("&")}`
    : "";
  return { protocol: base.protocol, host, pathname, search, href: `${base.protocol}//${host}${pathname}${search}` };
}

// Pure AWS Signature V4 signer (exported for testing against AWS's documented
// vectors). `headers` must include host and any x-amz-* headers to be signed.
export function signV4({ method, pathname, canonicalQuery = "", payloadHash, amzDate, region, service = "s3", accessKeyId, secretAccessKey, headers }) {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) lowerHeaders[key.toLowerCase()] = String(value).trim();
  const signedHeaderNames = Object.keys(lowerHeaders).sort();
  const canonicalHeaders = `${signedHeaderNames.map((h) => `${h}:${lowerHeaders[h]}`).join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Hash a file in one streaming pass so a large backup is never held in memory.
async function sha256File(localPath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(localPath)) hash.update(chunk);
  return hash.digest("hex");
}

function signedRequest(cfg, { method, key, query, payloadHash }) {
  const url = buildUrl(cfg, key, query);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const canonicalQuery = url.search ? url.search.slice(1) : "";

  const signHeaders = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const { authorization } = signV4({
    method,
    pathname: url.pathname,
    canonicalQuery,
    payloadHash,
    amzDate,
    region: cfg.region,
    service: "s3",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers: signHeaders,
  });

  return {
    href: url.href,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}

async function signedFetch(cfg, { method, key, query }) {
  const { href, headers } = signedRequest(cfg, { method, key, query, payloadHash: EMPTY_SHA256 });
  return fetchWithTimeout(href, { method, headers }, 60_000);
}

export function createS3Adapter(destination) {
  const cfg = s3Config(destination);

  async function listRaw() {
    const response = await signedFetch(cfg, {
      method: "GET",
      key: "",
      query: { "list-type": "2", prefix: cfg.prefix },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`S3 list failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return response.text();
  }

  return {
    async testConnection() {
      const response = await signedFetch(cfg, {
        method: "GET",
        key: "",
        query: { "list-type": "2", "max-keys": "1", prefix: cfg.prefix },
      });
      if (response.status === 403) throw new Error("S3 access denied (403) - check keys and bucket policy");
      if (response.status === 404) throw new Error("S3 bucket not found (404)");
      if (!response.ok) throw new Error(`S3 connection failed (${response.status})`);
      return { ok: true, detail: `Bucket ${cfg.bucket} reachable` };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      // Streamed, never read whole: a full backup is hundreds of MB. The 60s
      // timeout restarts on every chunk sent, so it only catches a stalled upload.
      // S3 rejects a chunked PUT, so the length is sent up front.
      const { size } = await fs.promises.stat(localPath);
      const payloadHash = await sha256File(localPath);
      const { href, headers } = signedRequest(cfg, { method: "PUT", key: `${cfg.prefix}${remoteName}`, payloadHash });
      const response = await uploadFileWithTimeout(href, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/gzip", "Content-Length": String(size) },
        filePath: localPath,
      }, 60_000);
      if (!response.ok) {
        throw new Error(`S3 upload failed (${response.status}): ${response.text.slice(0, 200)}`);
      }
      return { bytes: size, durationMs: Date.now() - started };
    },

    async download(remoteName) {
      const response = await signedFetch(cfg, { method: "GET", key: `${cfg.prefix}${remoteName}` });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`S3 download failed (${response.status}): ${text.slice(0, 200)}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async list() {
      const xml = await listRaw();
      const out = [];
      const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
      for (const block of blocks) {
        const key = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || "";
        const name = key.split("/").pop();
        if (!FILE_PATTERN.test(name)) continue;
        const size = (block.match(/<Size>(\d+)<\/Size>/) || [])[1];
        const modified = (block.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1];
        out.push({
          name,
          sizeBytes: Number(size) || 0,
          createdAt: modified ? new Date(modified).toISOString() : new Date().toISOString(),
        });
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async delete(remoteName) {
      const response = await signedFetch(cfg, { method: "DELETE", key: `${cfg.prefix}${remoteName}` });
      if (!(response.ok || response.status === 204 || response.status === 404)) {
        throw new Error(`S3 delete failed (${response.status})`);
      }
    },
  };
}
