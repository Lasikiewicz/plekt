import { requireAdmin } from "../utils/auth.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { legacyImageNotice } from "../utils/legacyImage.js";

// Tells the signed-in admin whether this install runs the retiring Plembfin image.
export async function handleLegacyImage(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  return sendJson(res, legacyImageNotice(), 200, { "Cache-Control": "private, no-store" });
}
