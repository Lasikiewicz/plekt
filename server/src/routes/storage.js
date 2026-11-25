import { requireInstallAdmin } from "../utils/auth.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import {
  getPublicUpgradeStatus,
  getStorageStatus,
  runDatabaseCompactionTask,
  startArtworkOptimizationTask,
  startLegacyBackupRecompressionTask,
} from "../utils/storageUpgrade.js";

export async function handleUpgradeStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, getPublicUpgradeStatus());
}

export async function handleStorageStatus(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireInstallAdmin(req, res))) return;
  return sendJson(res, getStorageStatus());
}

export async function handleStorageCompactDb(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireInstallAdmin(req, res))) return;
  runDatabaseCompactionTask({ showUpgradeScreen: false }).catch(() => null);
  return sendJson(res, { ok: true, started: true, status: getStorageStatus() }, 202);
}

export async function handleStorageOptimizeArtwork(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireInstallAdmin(req, res))) return;
  startArtworkOptimizationTask({ throttleMs: 10, background: false });
  return sendJson(res, { ok: true, started: true, status: getStorageStatus() }, 202);
}

export async function handleStorageRecompressBackups(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireInstallAdmin(req, res))) return;
  const body = await readJson(req).catch(() => ({}));
  startLegacyBackupRecompressionTask({ passphrase: String(body?.passphrase || "") });
  return sendJson(res, { ok: true, started: true, status: getStorageStatus() }, 202);
}
