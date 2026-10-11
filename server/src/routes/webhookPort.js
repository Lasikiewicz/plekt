import { requireAdmin } from "../utils/auth.js";
import { methodNotAllowed, sendJson } from "../utils/http.js";
import { getWebhookPortStatus } from "../utils/webhookPortCheck.js";

// GET webhook-port/status: the last startup-style webhook port check, re-run when
// older than its cache TTL. Only ports and plugin names are returned, never URLs.
export async function handleWebhookPort(req, res, path) {
  if (!(await requireAdmin(req, res))) return;
  if (path !== "webhook-port/status") return sendJson(res, { error: "Unknown webhook port action" }, 404);
  if (req.method !== "GET") return methodNotAllowed(res);
  try {
    const status = await getWebhookPortStatus();
    return sendJson(res, { ok: true, ...status }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
