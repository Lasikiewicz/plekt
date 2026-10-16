import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { loadMediaConfig } from "../utils/configStore.js";
import { getRatingSyncStatus, pushPersonalRatings, retryRatingSync, resolveRatingScanHold, runRatingSync } from "../utils/personalRatingSync.js";

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

function providersFrom(body = {}) {
  const values = Array.isArray(body.providers)
    ? body.providers
    : body.provider
      ? [body.provider]
      : [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

export async function handleRatingSync(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    if (req.method === "GET") {
      return sendJson(res, await getRatingSyncStatus());
    }
    if (req.method !== "POST") return methodNotAllowed(res);

    const body = await readJson(req);
    const action = clean(body.action || body.mode || "run");
    const providers = providersFrom(body);
    const config = await loadMediaConfig();
    const logger = (line) => console.log(`[rating-sync] ${line}`);

    if (["approve-held", "dismiss-held"].includes(action)) {
      if (providers.length !== 1) return sendJson(res, { error: "Choose one provider to review" }, 400);
      return sendJson(res, await resolveRatingScanHold({ provider: providers[0], runId: body.runId,
        decision: action === "approve-held" ? "approve" : "dismiss", config, logger }));
    }

    if (["push", "push-local", "force"].includes(action)) {
      const rawItems = Array.isArray(body.items) ? body.items : body.media ? [body.media] : [];
      const result = await pushPersonalRatings({ providers, items: rawItems, logger, config });
      return sendJson(res, result);
    }
    if (["retry", "retry-failed"].includes(action)) {
      return sendJson(res, await retryRatingSync({ providers, drain: body.drain !== false, logger, config }));
    }

    const requestedMode = clean(body.initial_sync_mode || body.initialSyncMode || (body.mode === "baseline" || body.mode === "import" ? body.mode : ""));
    const mode = ["baseline", "import"].includes(requestedMode)
      ? requestedMode
      : "";
    return sendJson(res, await runRatingSync({
      providers,
      mode,
      snapshot: body.snapshot !== false,
      drain: body.drain !== false,
      logger,
      config,
    }));
  } catch (error) {
    return sendJson(res, { error: error.message || "Personal rating sync failed" }, Number(error.status) || 500);
  }
}
