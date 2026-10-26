import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { loadMediaConfig } from "../utils/configStore.js";
import { listWatchlistActivity } from "../utils/personalWatchlistRepository.js";
import { getWatchlistSyncStatus, previewWatchlistSync, runWatchlistSync } from "../utils/personalWatchlistSync.js";

function clean(value) { return String(value ?? "").trim().toLowerCase(); }
function providersFrom(body = {}) {
  const values = Array.isArray(body.providers) ? body.providers : body.provider ? [body.provider] : [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

export async function handleWatchlistSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const path = new URL(req.url || "/", "http://localhost").pathname.replace(/^\/api\//, "");
    if (req.method === "GET" && path === "watchlist-sync/activity") {
      const url = new URL(req.url || "/", "http://localhost");
      return sendJson(res, {
        activity: listWatchlistActivity({ provider: clean(url.searchParams.get("provider")), limit: url.searchParams.get("limit") || 100, offset: url.searchParams.get("offset") || 0 }),
      });
    }
    if (req.method === "GET") return sendJson(res, getWatchlistSyncStatus(await loadMediaConfig({ resolveConnections: false })));
    if (req.method !== "POST") return methodNotAllowed(res);

    const body = await readJson(req);
    const action = clean(body.action || body.mode || "run");
    const providers = providersFrom(body);
    if (path === "watchlist-sync/preview" || ["preview", "plan"].includes(action)) {
      return sendJson(res, await previewWatchlistSync({ providers, config: await loadMediaConfig() }));
    }
    const config = await loadMediaConfig();
    const mode = ["publish", "initial-publish", "initial_publish"].includes(action)
      ? "publish"
      : ["retry", "retry-failed"].includes(action)
        ? "retry"
        : "reconcile";
    const confirm = body.confirm === true || body.confirmed === true || body.confirmPublish === true;
    return sendJson(res, await runWatchlistSync({ mode, confirm, providers, config }));
  } catch (error) {
    const status = Number(error?.status);
    const responseStatus = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
    return sendJson(res, { error: "Watchlist sync failed" }, responseStatus);
  }
}
