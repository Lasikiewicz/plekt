import { requireAdmin } from '../utils/auth.js';
import { sendJson,sendOptions,methodNotAllowed } from '../utils/http.js';
import { initialSyncSummary } from '../utils/initialSyncStore.js';

export async function handleInitialSyncStatus(req,res) {
  if(req.method==='OPTIONS')return sendOptions(res);
  if(req.method!=='GET')return methodNotAllowed(res);
  if(!(await requireAdmin(req,res)))return;
  return sendJson(res,initialSyncSummary(),200,{'Cache-Control':'no-store'});
}
