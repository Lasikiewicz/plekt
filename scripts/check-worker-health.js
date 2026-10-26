#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function checkSqliteReadable(dbPath, { requireLeaseTable = false } = {}) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // This probe runs in a separate Node process so a synchronous maintenance
    // batch in the application cannot make a healthy worker look dead. Keep the
    // query deliberately small; a full quick_check here would recreate the same
    // false timeout for large SQLite files.
    const schema = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='scheduler_lease'").get();
    const lease = requireLeaseTable
      ? db.prepare("SELECT holder_id, expires_at FROM scheduler_lease WHERE id='scheduler'").get()
      : null;
    return { schemaOk: schema?.ok === 1, lease };
  } finally {
    db.close();
  }
}

try {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const legacyDbPath = path.join(dataDir, "plembfin.db");
  const dbPath = fs.existsSync(legacyDbPath) ? legacyDbPath : path.join(dataDir, "plekt.db");
  const { schemaOk, lease } = checkSqliteReadable(dbPath, { requireLeaseTable: true });
  const role = String(process.env.ROLE || "all").trim().toLowerCase();
  const workerHealthy = role === "web"
    || (lease?.holder_id && Number(lease.expires_at) > Date.now());
  if (!schemaOk || !workerHealthy) process.exit(1);

  const usersRegistryPath = path.join(dataDir, "users.json");
  if (fs.existsSync(usersRegistryPath)) {
    const parsed = JSON.parse(fs.readFileSync(usersRegistryPath, "utf8"));
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    for (const entry of users) {
      const name = String(entry?.name || "").trim().toLowerCase();
      if (!name || name === "admin" || entry?.role === "admin" || entry?.disabled || entry?.stopped) continue;
      const userDbPath = path.join(dataDir, "users", name, "plekt.db");
      if (fs.existsSync(userDbPath)) {
        const check = checkSqliteReadable(userDbPath);
        if (!check.schemaOk) process.exit(1);
      }
    }
  }
  process.exit(0);
} catch {
  process.exit(1);
}
