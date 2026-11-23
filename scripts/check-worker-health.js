#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { resolveDbPath } from "../server/src/paths.js";
import { isDemoMode } from "../server/src/utils/demoMode.js";

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

export function probeLocalWebLiveness({ port = Number(process.env.PORT) || 5055, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/ping", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

export async function runHealthCheck({
  dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")),
  role = String(process.env.ROLE || "all").trim().toLowerCase(),
  demoMode = isDemoMode(),
  port = Number(process.env.PORT) || 5055,
  probeWeb = probeLocalWebLiveness,
  now = Date.now(),
} = {}) {
  const dbPath = resolveDbPath(dataDir);
  const { schemaOk, lease } = checkSqliteReadable(dbPath, { requireLeaseTable: true });
  if (!schemaOk) return false;

  // The hosted demo never starts the scheduler coordinator (server.js), so there is no lease
  // holder to find; it is healthy as long as its database is readable.
  if (role === "web") {
    if (!demoMode) {
      const webHealthy = await probeWeb({ port });
      if (!webHealthy) return false;
    }
  } else if (!demoMode) {
    const workerHealthy = Boolean(lease?.holder_id && Number(lease.expires_at) > now);
    if (!workerHealthy) return false;
  }

  const usersRegistryPath = path.join(dataDir, "users.json");
  if (fs.existsSync(usersRegistryPath)) {
    const parsed = JSON.parse(fs.readFileSync(usersRegistryPath, "utf8"));
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    for (const entry of users) {
      const name = String(entry?.name || "").trim().toLowerCase();
      if (!name || name === "admin" || entry?.role === "admin" || entry?.disabled || entry?.stopped) continue;
      const userDbPath = resolveDbPath(path.join(dataDir, "users", name));
      if (fs.existsSync(userDbPath)) {
        const check = checkSqliteReadable(userDbPath);
        if (!check.schemaOk) return false;
      }
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runHealthCheck()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}
