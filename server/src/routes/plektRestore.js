import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { plektBackupFilePath } from "../utils/plektBackups.js";
import { getPlektRestoreJob, saveUploadedBackup, startPlektRestore, uploadedBackupPath } from "../utils/plektRestore.js";

// GET  /api/plembfin-backups/restore  - status of the current or last restore.
// POST /api/plembfin-backups/restore  - {filename | uploadId, passphrase}; starts
//      a server-side restore and returns at once. The passphrase is only used
//      for this restore and is never logged or stored.
export async function handlePlektRestore(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "GET") return sendJson(res, { ok: true, job: getPlektRestoreJob() });
  if (req.method !== "POST") return methodNotAllowed(res);

  const body = await readJson(req);
  const filename = String(body.filename || "").trim();
  const uploadId = String(body.uploadId || "").trim();
  if (!filename === !uploadId) return sendJson(res, { error: "Send either filename or uploadId" }, 400);
  let filePath;
  try {
    filePath = filename ? plektBackupFilePath(filename) : uploadedBackupPath(uploadId);
  } catch (error) {
    return sendJson(res, { error: error.message }, filename ? 404 : 400);
  }
  try {
    const job = startPlektRestore({
      filePath,
      passphrase: String(body.passphrase || "").trim(),
      label: filename || "Uploaded backup",
      removeAfter: Boolean(uploadId),
    });
    return sendJson(res, { ok: true, job }, 202);
  } catch (error) {
    return sendJson(res, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.recoveryOptions ? { recoveryOptions: error.recoveryOptions } : {}),
    }, Number(error.status) || 400);
  }
}

// POST /api/plembfin-backups/upload - the raw backup file as the request body,
// streamed to disk (server.js leaves this body unbuffered). Returns an uploadId
// for the restore request.
export async function handlePlektRestoreUpload(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) {
    req.resume();
    return;
  }
  try {
    return sendJson(res, { ok: true, ...(await saveUploadedBackup(req)) });
  } catch (error) {
    console.error("Backup upload failed", error.message);
    return sendJson(res, { error: "Backup upload failed" }, 500);
  }
}
