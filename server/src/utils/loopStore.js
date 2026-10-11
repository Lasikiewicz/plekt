import { db } from "../db.js";

function encodeKey(key) {
  return Buffer.from(String(key)).toString("base64url");
}

const getStmt = db.prepare("SELECT value, expire_at FROM loop_keys WHERE id = ?");
const delStmt = db.prepare("DELETE FROM loop_keys WHERE id = ?");
// Rows with no expiry (NULL or 0) are never expired by getFresh, so they must not match here.
const pruneExpiredStmt = db.prepare("DELETE FROM loop_keys WHERE expire_at IS NOT NULL AND expire_at > 0 AND expire_at < ?");
const putStmt = db.prepare(
  `INSERT INTO loop_keys (id, key, value, created_at, expire_at)
   VALUES (@id, @key, @value, @created_at, @expire_at)
   ON CONFLICT(id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expire_at = excluded.expire_at`,
);

function getFresh(key) {
  const id = encodeKey(key);
  const row = getStmt.get(id);
  if (!row) return null;
  const expires = Number(row.expire_at || 0);
  if (expires && expires < Date.now()) {
    delStmt.run(id);
    return null;
  }
  return row.value || null;
}

function putValue(key, value, ttlSeconds = 60) {
  const ttl = Math.max(1, Number(ttlSeconds || 60));
  putStmt.run({
    id: encodeKey(key),
    key: String(key),
    value: String(value),
    created_at: Date.now(),
    expire_at: Date.now() + ttl * 1000,
  });
}

// Checks a set of "was this recently targeted" keys (fresh = written within
// `windowMs`) and, only if none of them are still fresh, claims a (possibly
// different) set of keys in the same SQLite transaction. Running both the
// read and the write under one db.transaction means a concurrent claim for
// the same key can't slip in between the check and the write - better-sqlite3
// executes the whole callback as a single exclusive transaction rather than
// relying on this module's callers never `await`ing between the two steps.
const checkAndClaimTxn = db.transaction((checkKeys, claimKeys, ttlSeconds, windowMs) => {
  const now = Date.now();
  for (const key of checkKeys) {
    const value = getFresh(key);
    const timestamp = Number(value);
    if (timestamp && now - timestamp <= windowMs) {
      return { loopDetected: true };
    }
  }
  for (const key of claimKeys) {
    putValue(key, now, ttlSeconds);
  }
  return { loopDetected: false };
});

// Reclaims expired rows. Expiry is already enforced on read, so this only frees space.
export function pruneExpiredLoopKeys(now = Date.now()) {
  return pruneExpiredStmt.run(now).changes;
}

export function createLoopStore() {
  return {
    async get(key) {
      return getFresh(key);
    },
    async delete(key) {
      delStmt.run(encodeKey(key));
    },
    async put(key, value, options = {}) {
      putValue(key, value, options.expirationTtl);
    },
    checkAndClaim(checkKeys, claimKeys, ttlSeconds = 60, windowMs = ttlSeconds * 1000) {
      return checkAndClaimTxn(checkKeys, claimKeys, ttlSeconds, windowMs);
    },
  };
}
