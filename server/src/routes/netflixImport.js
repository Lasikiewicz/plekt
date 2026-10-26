import { randomUUID } from "node:crypto";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { commitNetflixImport, netflixPreviewSummary, parseNetflixCsv, prepareNetflixImport, reviewNetflixPreview, saveNetflixPreview } from "../utils/netflixImport.js";
import { createWatchHistoryBackup } from "../utils/watchHistoryBackups.js";
import { withInitialInboundImport } from '../utils/initialSyncStore.js';

const jobs = new Map();
// The full personal-information export logs every session and every profile.
const MAX_CSV_BYTES = 12_000_000;
const JOB_TTL_MS = 30 * 60 * 1000;

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    processed: job.processed,
    total: job.total,
    error: job.error || "",
    ...(job.status === "complete" ? { ...job.summary, previewId: job.previewId, records: undefined } : {}),
  };
}

export async function handleNetflixImport(req, res, action = "", inboundTracked=false) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    if(action==='import'&&req.method==='POST'&&!inboundTracked)return await withInitialInboundImport('netflix',()=>handleNetflixImport(req,res,action,true));
    if (action === "preview-start" && req.method === "POST") {
      const body = await readJson(req);
      const csv = String(body.csv || "");
      if (new TextEncoder().encode(csv).byteLength > MAX_CSV_BYTES) return sendJson(res, { ok: false, error: "The Netflix CSV is too large. Limit: 12 MB." }, 413);
      const profiles = Array.isArray(body.profiles) ? body.profiles.map(String) : undefined;
      const rows = parseNetflixCsv(csv, { profiles });
      const running = [...jobs.values()].find((job) => job.status === "running");
      if (running) {
        return sendJson(res, {
          ok: false,
          error: "A Netflix preview is already running.",
          jobId: running.id,
          ...publicJob(running),
        }, 409);
      }
      const job = { id: randomUUID(), status: "running", processed: 0, total: rows.length, error: "", createdAt: Date.now() };
      jobs.set(job.id, job);
      const expiry = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
      expiry.unref?.();
      prepareNetflixImport(csv, { profiles, onProgress: (processed, total) => { job.processed = processed; job.total = total; } })
        .then((preview) => {
          job.previewId = saveNetflixPreview(preview);
          job.summary = netflixPreviewSummary(preview);
          job.status = "complete";
        })
        .catch((error) => { job.status = "error"; job.error = error.message || "Netflix preview failed."; });
      return sendJson(res, { ok: true, ...publicJob(job) }, 202, { "Cache-Control": "no-store" });
    }
    if (action === "preview-status" && req.method === "GET") {
      const jobId = new URL(req.url || "/", "http://localhost").searchParams.get("jobId");
      const job = jobs.get(jobId);
      if (!job) return sendJson(res, { ok: false, error: "Netflix preview not found or expired." }, 404);
      return sendJson(res, { ok: true, ...publicJob(job) }, 200, { "Cache-Control": "no-store" });
    }
    if (action === "import" && req.method === "POST") {
      const body = await readJson(req);
      if (body.previewId) {
        await createWatchHistoryBackup({ reason: "pre_netflix_import", mirrorRemote: false });
        const result = await commitNetflixImport(body.previewId, { reviewedRows: body.reviewedRows });
        return sendJson(res, { ok: true, ...result, backupCreated: true });
      }
      return sendJson(res, { ok: false, error: "Create a preview before importing." }, 400);
    }
    if (action === "preview-review" && req.method === "POST") {
      const body = await readJson(req);
      const result = await reviewNetflixPreview(body.previewId, { groupId: body.groupId, tmdbId: body.tmdbId, query: body.query });
      for (const job of jobs.values()) {
        if (job.previewId === body.previewId) job.summary = netflixPreviewSummary(result);
      }
      return sendJson(res, { ok: true, ...result }, 200, { "Cache-Control": "no-store" });
    }
    return methodNotAllowed(res);
  } catch (error) {
    if(inboundTracked)throw error;
    const status = Number(error?.status) >= 400 && Number(error?.status) < 500 ? Number(error.status) : 502;
    return sendJson(res, { ok: false, error: error.message || "Netflix import failed." }, status);
  }
}
