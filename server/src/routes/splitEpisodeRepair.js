import { requireInstallAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { writeAuditLog } from "../db.js";
import { loadMediaConfig } from "../utils/configStore.js";
import {
  applySplitEpisodeRepair,
  auditSplitEpisodeShows,
  listSplitEpisodeRepairRuns,
  undoSplitEpisodeRepair,
} from "../utils/splitEpisodeRepair.js";

// Settings -> Tools -> Database repairs -> Repair Split Episode Shows
// (plan/active/emby-reporter-feedback/step6-split-episode-repair.md).
//   GET  /api/split-episode-audit    read-only report, plus earlier runs
//   POST /api/split-episode-repair   { showKeys } re-prove, back up, rekey
//   POST /api/split-episode-undo     { runId } restore exactly that run's rows
export async function handleSplitEpisodeRepair(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireInstallAdmin(req, res))) return;
  const ip = req.ip || req.socket?.remoteAddress;
  try {
    if (path === "split-episode-audit") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const config = await loadMediaConfig().catch(() => ({}));
      const audit = await auditSplitEpisodeShows({ config });
      return sendJson(res, { ok: true, ...audit, runs: listSplitEpisodeRepairRuns() }, 200, { "Cache-Control": "no-store" });
    }
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    if (path === "split-episode-repair") {
      const config = await loadMediaConfig().catch(() => ({}));
      const result = await applySplitEpisodeRepair({ showKeys: body.showKeys, config });
      writeAuditLog("history.split_episode_repair", { ip, detail: { showKeys: body.showKeys, ...result } });
      return sendJson(res, { ok: true, ...result });
    }
    if (path === "split-episode-undo") {
      const result = await undoSplitEpisodeRepair(body.runId);
      writeAuditLog("history.split_episode_repair_undo", { ip, detail: result });
      return sendJson(res, { ok: true, ...result });
    }
    return sendJson(res, { error: "Unknown split episode repair action" }, 404);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
