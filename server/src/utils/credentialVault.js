import crypto from "node:crypto";
import fs from "node:fs";
import { CREDENTIAL_KEY_PATH } from "../paths.js";
import { db } from "../db.js";
import { brandEnv } from "./brandEnv.js";

export const CREDENTIAL_VAULT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

function encryptedCredentialsExist(database = db) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (tables.has("media_connections") && database.prepare("SELECT 1 FROM media_connections WHERE credential_ciphertext IS NOT NULL LIMIT 1").get()) return true;
  if (tables.has("media_auth_devices") && database.prepare("SELECT 1 FROM media_auth_devices WHERE private_key_ciphertext IS NOT NULL LIMIT 1").get()) return true;
  if (tables.has("media_auth_flows") && database.prepare("SELECT 1 FROM media_auth_flows WHERE secret_ciphertext IS NOT NULL LIMIT 1").get()) return true;
  if (tables.has("tracker_connections") && database.prepare("SELECT 1 FROM tracker_connections WHERE access_token_ciphertext IS NOT NULL LIMIT 1").get()) return true;
  if (tables.has("tracker_auth_flows") && database.prepare("SELECT 1 FROM tracker_auth_flows WHERE device_code_ciphertext IS NOT NULL LIMIT 1").get()) return true;
  return false;
}

function decodeEnvironmentKey(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  const key = /^[a-f\d]{64}$/i.test(input) ? Buffer.from(input, "hex") : Buffer.from(input, "base64url");
  if (key.length !== KEY_BYTES) throw new Error("PLEKT_CREDENTIAL_KEY must encode exactly 32 bytes (64 hex characters or base64url)");
  return key;
}

export function loadCredentialKey({ keyPath = CREDENTIAL_KEY_PATH, database = db, env = process.env } = {}) {
  const environmentKey = decodeEnvironmentKey(brandEnv("CREDENTIAL_KEY", env));
  if (environmentKey) return environmentKey;

  let key = null;
  try {
    key = fs.readFileSync(keyPath);
  } catch {
    if (fs.existsSync(keyPath)) throw new Error("Credential key could not be read");
  }
  if (key) {
    if (key.length !== KEY_BYTES) throw new Error("Credential key is invalid; expected exactly 32 bytes");
    return key;
  }

  if (encryptedCredentialsExist(database)) {
    throw new Error("Credential key is missing while encrypted media credentials exist; restore credential.key or set PLEKT_CREDENTIAL_KEY");
  }

  const generatedKey = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, generatedKey, { mode: 0o600, flag: "wx" });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* non-POSIX filesystem */ }
  return generatedKey;
}

export function encryptCredential(value, options = {}) {
  const plaintext = String(value ?? "");
  if (!plaintext) throw new Error("Credential must not be empty");
  const key = options.key || loadCredentialKey(options);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    version: CREDENTIAL_VAULT_VERSION,
  };
}

export function decryptCredential(record, options = {}) {
  if (Number(record?.version) !== CREDENTIAL_VAULT_VERSION) throw new Error("Unsupported credential vault version");
  const key = options.key || loadCredentialKey(options);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted credential could not be decrypted; the key or ciphertext is invalid");
  }
}

export function redactSecrets(value) {
  const secretName = /(?:token|api[_-]?key|secret|password|authorization|credential|private[_-]?key|ciphertext|\biv\b|\btag\b)/i;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretName.test(key) ? "[redacted]" : redactSecrets(item)]));
}
