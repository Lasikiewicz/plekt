import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { bumpDataVersion, writeAuditLog } from "../db.js";
import { episodeOrderState, changeEpisodeOrder } from "../utils/episodeOrder.js";
import { preflightOrderRecords, resolveOrderWatch } from "../utils/episodeOrderWatch.js";
import { loadMediaConfig } from "../utils/configStore.js";
import { getWatchRecordById } from "../utils/dataRepo.js";

export async function handleEpisodeOrder(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!["GET", "POST", "DELETE"].includes(req.method)) return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = req.method === "GET" ? req.query : await readJson(req);
  const id = String(body?.tvdbId || "").trim();
  if (!/^[1-9]\d*$/.test(id)) return sendJson(res, { error:"A TVDB series ID is required" }, 400);
  try {
    const result = req.method === "GET" ? await episodeOrderState(id) : await changeEpisodeOrder(id, body, req.method);
    if (req.method !== "GET") { bumpDataVersion("episode-order"); writeAuditLog("show.episode_order.saved", { detail:{tvdbId:id,order:result.order} }); }
    return sendJson(res, result, 200, { "Cache-Control":"private, no-store" });
  } catch (error) {
    return sendJson(res, {error:error.message,code:error.code}, error.status || 502);
  }
}

export async function handleEpisodeOrderPreflight(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req,res))) return;
  const body = await readJson(req);
  const items = body?.records || body?.ids;
  if (!Array.isArray(items) || items.length > 5000) return sendJson(res,{error:"Provide up to 5,000 records or IDs for preflight"},400);
  try {
    const config = await loadMediaConfig();
    if (body.records) return sendJson(res,{ok:true,records:await preflightOrderRecords(body.records,config)},200,{"Cache-Control":"no-store"});
    for (const id of items) {
      const row = await getWatchRecordById(String(id));
      if (!row) throw new Error("A selected watch record no longer exists");
      await resolveOrderWatch(row,config,{stateType:"unwatched"});
    }
    return sendJson(res,{ok:true},200,{"Cache-Control":"no-store"});
  } catch(error) { return sendJson(res,{error:error.message,code:"EPISODE_MAPPING_REQUIRED"},409); }
}
