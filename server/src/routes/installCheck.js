import { requireInstallAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { answerInstallCheck, installCheckStatus } from "../utils/installCheck.js";

// GET reports the choice, the last send and the exact payload that would be
// sent. POST { enabled } records the answer; either answer is final until the
// user changes it, and a decline stays dismissed.
export async function handleInstallCheck(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireInstallAdmin(req, res))) return;

  if (req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (typeof body?.enabled !== "boolean") return sendJson(res, { error: "enabled must be true or false" }, 400);
    answerInstallCheck(body.enabled);
  }
  return sendJson(res, { ok: true, installCheck: installCheckStatus() });
}
