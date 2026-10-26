import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_DIR } from "../paths.js";
import { ADMIN_ROLE, multiUserEnabled, resolveAdminUserName, tenantDataDir } from "./tenancy.js";

// Request-scoped tenant identity for single-process multi-user mode.
// When no store is active, callers behave as the install admin (DATA_DIR root).

const storage = new AsyncLocalStorage();

export function getUserContext() {
  return storage.getStore() || null;
}

export function getActiveUserName() {
  return getUserContext()?.name || resolveAdminUserName();
}

export function getActiveDataDir() {
  return getUserContext()?.dataDir || DATA_DIR;
}

export function isNonAdminTenantContext(rootDataDir = DATA_DIR) {
  const context = getUserContext();
  if (!context) return false;
  if (context.role === ADMIN_ROLE) return false;
  if (context.name && context.name === resolveAdminUserName(rootDataDir)) return false;
  if (context.dataDir && path.resolve(context.dataDir) === path.resolve(rootDataDir)) return false;
  return true;
}

// True for the single instance that owns the shared media folder on disk: a
// plain single-user install or the admin context. Non-admin users read and
// write the shared folder, so their cache clears and wipes touch only their
// own database rows.
export function ownsArtworkFiles(rootDataDir = DATA_DIR) {
  return !isNonAdminTenantContext(rootDataDir);
}

// True whenever multi-user mode is active (or a non-admin context is running),
// so artwork files are named after their source rather than a user-local
// media key. A plain single-user install keeps the legacy media-key filename.
export function usesSharedArtworkNaming(rootDataDir = DATA_DIR) {
  return multiUserEnabled(rootDataDir) || isNonAdminTenantContext(rootDataDir);
}

export function runWithUserContext(context, fn) {
  if (!context || typeof context !== "object") {
    throw new Error("runWithUserContext requires a context object");
  }
  const name = String(context.name || "").trim().toLowerCase();
  if (!name) throw new Error("runWithUserContext requires context.name");
  const dataDir = context.dataDir || tenantDataDir(name);
  return storage.run({ name, dataDir, role: context.role || "user" }, fn);
}

export function runAsAdmin(fn) {
  const name = resolveAdminUserName();
  return runWithUserContext({ name, dataDir: DATA_DIR, role: "admin" }, fn);
}
