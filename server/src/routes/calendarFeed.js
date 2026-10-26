import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { requireAdmin } from "../utils/auth.js";
import { getCalendarFeed, getCalendarFeedSettings, normalizeCalendarFeedTypes, regenerateCalendarFeedToken, resolveCalendarOrigin, serializeCalendarFeed } from "../utils/calendarFeed.js";
import { loadMediaConfig } from "../utils/configStore.js";
import { readJson } from "../utils/requestBody.js";

export async function handleCalendarFeed(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  const token = String(req.query.token || "");
  try {
    const feed = await getCalendarFeed(token);
    if (!feed) return res.status(404).type("text/plain").send("Calendar feed not found");
    return res.status(200).set("Cache-Control", "private, no-store").type("text/calendar; charset=utf-8").send(serializeCalendarFeed(feed));
  } catch (error) {
    console.error("Calendar feed request failed", error);
    return res.status(500).type("text/plain").send("Calendar feed unavailable");
  }
}

export async function handleCalendarFeedSettings(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  const config = await loadMediaConfig({ resolveConnections: false });
  const origin = resolveCalendarOrigin(config.publicBaseUrl, req.get("X-Plekt-Calendar-Origin") || "");
  const settings = await getCalendarFeedSettings(origin);
  if (req.method === "GET") {
    return sendJson(res, settings);
  }
  if (req.method === "POST") {
    if (!settings.ready) return sendJson(res, settings, 409);
    let body;
    try { body = await readJson(req); } catch (error) {
      return sendJson(res, { error: error.message || "Invalid JSON body" }, error.status || 400);
    }
    const types = body.types === undefined ? settings.types : normalizeCalendarFeedTypes(body.types);
    if (!types.length) return sendJson(res, { error: "Select movies, TV shows or both." }, 400);
    const token = await regenerateCalendarFeedToken(types);
    const regenerated = await getCalendarFeedSettings(origin);
    return sendJson(res, { ...regenerated, regenerated: Boolean(token) });
  }
  return methodNotAllowed(res);
}
