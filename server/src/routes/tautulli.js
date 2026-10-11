import { randomUUID } from "node:crypto";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { loadMediaConfig, mergeIncomingConfig, publicMediaConfig } from "../utils/configStore.js";
import { createTautulliClient, sanitizeTautulliError } from "../utils/tautulliClient.js";
import { commitTautulliImport, filterTautulliRows, normalizeReviewDecisions, prepareTautulliImport, targetDefaults } from "../utils/tautulliImport.js";
import { createWatchHistoryBackup, watchBackupStatus } from "../utils/watchHistoryBackups.js";

const previewJobs = new Map();
const PREVIEW_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_RUNNING_PREVIEW_JOBS = 1;

function configuredClient(config = {}, override = {}) {
  const tautulli = { ...(config.tautulli || {}), ...(override || {}) };
  if (tautulli.apiKey === undefined || tautulli.apiKey === "") tautulli.apiKey = config.tautulli?.apiKey || "";
  return createTautulliClient(tautulli);
}

async function selectedContext(config, body = {}) {
  const client = configuredClient(config, body);
  const users = await client.getUsers();
  const userId = String(body.userId || config.tautulli?.userId || "").trim();
  const user = users.find((entry) => entry.id === userId);
  if (!userId || !user) {
    const error = new Error("Select a valid Tautulli user before importing");
    error.status = 400;
    throw error;
  }
  const serverInfo = await client.getServerInfo();
  const activeTargets = Object.keys(targetDefaults(config));
  return { client, users, user, userId, serverInfo, activeTargets };
}

async function historyRows(context, fromDate = "", onProgress) {
  const [movies, episodes] = await Promise.all([
    context.client.getHistory({ userId: context.userId, mediaType: "movie", fromDate, onProgress }),
    context.client.getHistory({ userId: context.userId, mediaType: "episode", fromDate, onProgress }),
  ]);
  return filterTautulliRows([...movies, ...episodes], { userId: context.userId, fromDate });
}

function publicPreviewJob(job) {
  return {
    status: job.status,
    phase: job.phase,
    message: job.message,
    progress: job.progress,
    result: job.status === "complete" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  };
}

function runningPreviewJobCount() {
  return [...previewJobs.values()].filter((job) => job.status === "running").length;
}

function updatePreviewJobProgress(job, update) {
  const current = job.media[update.mediaType] || { total: null, completed: 0 };
  current.total = update.total;
  current.completed = update.completed;
  job.media[update.mediaType] = current;
  const totals = Object.values(job.media).map((entry) => entry.total).filter((value) => Number.isFinite(value));
  const completed = Object.values(job.media).reduce((sum, entry) => sum + (Number(entry.completed) || 0), 0);
  const total = totals.length === 2 ? totals.reduce((sum, value) => sum + value, 0) : null;
  job.phase = update.phase;
  job.progress = {
    completed,
    total,
    percent: total ? Math.min(100, Math.round((completed / total) * 100)) : null,
  };
  job.message = update.phase === "counting"
    ? "Checking the Tautulli history size…"
    : "Reading Tautulli history…";
}

async function runPreviewJob(job, config, body) {
  try {
    job.phase = "connecting";
    job.message = "Connecting to Tautulli…";
    const context = await selectedContext(config, body);
    const rows = await historyRows(context, body.fromDate || "", (update) => updatePreviewJobProgress(job, update));
    job.phase = "preparing";
    job.message = "Preparing preview…";
    job.progress = { ...job.progress, percent: job.progress.total ? 95 : null };
    // No per-server choice: the import projects to every connected server and
    // the standing Plex policy is the only thing that removes one.
    const selectedTargets = context.activeTargets;
    const options = {
      userId: context.userId,
      userName: context.user.name,
      selectedTargets,
      activeTargets: context.activeTargets,
      fromDate: body.fromDate || "",
      reviewDecisions: normalizeReviewDecisions(body.reviewDecisions),
      onProgress: ({ completed, total }) => {
        job.phase = "preparing";
        job.message = "Matching imported history against existing Plekt records…";
        job.progress = {
          completed,
          total,
          percent: total ? Math.min(99, 95 + Math.round((completed / total) * 4)) : 95,
        };
      },
    };
    const preview = await prepareTautulliImport(rows, options);
    // The UI only needs the summary and review candidates. Do not retain one
    // item object for every history row in the in-memory job cache.
    const { records: _records, items: _items, ...compactPreview } = preview;
    job.result = {
      ...compactPreview,
      records: undefined,
      targets: context.activeTargets.map((target) => ({ target, selected: true })),
    };
    job.status = "complete";
    job.phase = "complete";
    job.progress = { completed: job.progress.total ?? job.progress.completed, total: job.progress.total, percent: 100 };
    job.message = "Preview ready. Review target choices, then import.";
  } catch (error) {
    job.status = "failed";
    job.phase = "failed";
    job.error = sanitizeTautulliError(error);
    job.message = job.error;
  }
}

function startPreviewJob(config, body) {
  if (runningPreviewJobCount() >= MAX_RUNNING_PREVIEW_JOBS) {
    const error = new Error("A Tautulli preview is already running. Wait for it to finish before starting another.");
    error.status = 409;
    error.code = "TAUTULLI_PREVIEW_IN_PROGRESS";
    throw error;
  }
  const cutoff = Date.now() - PREVIEW_JOB_TTL_MS;
  for (const [id, job] of previewJobs) {
    if (job.createdAt < cutoff) previewJobs.delete(id);
  }
  const job = {
    id: randomUUID(),
    status: "running",
    phase: "starting",
    message: "Starting Tautulli preview…",
    progress: { completed: 0, total: null, percent: null },
    media: {},
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  previewJobs.set(job.id, job);
  void runPreviewJob(job, config, body);
  const cleanup = setTimeout(() => previewJobs.delete(job.id), PREVIEW_JOB_TTL_MS);
  cleanup.unref?.();
  return job;
}

export async function handleTautulli(req, res, action = "") {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  const config = await loadMediaConfig();
  try {
    if (action === "status" && req.method === "GET") {
      const backup = watchBackupStatus();
      return sendJson(res, {
        ok: true,
        tautulli: publicMediaConfig(config).tautulli,
        configured: Boolean(config.tautulli?.apiKey && config.tautulli?.baseUrl && !config.tautulli?.disabled),
        latestBackup: backup.files?.[0] || null,
      });
    }
    if (action === "users" && req.method === "GET") {
      const client = configuredClient(config);
      return sendJson(res, { ok: true, users: await client.getUsers() });
    }
    if (action === "test" && req.method === "POST") {
      const body = await readJson(req);
      const merged = await mergeIncomingConfig({ tautulli: body });
      const client = configuredClient(merged);
      const [serverInfo, users] = await Promise.all([client.getServerInfo(), client.getUsers()]);
      return sendJson(res, { ok: true, serverInfo: { pms_identifier: serverInfo?.pms_identifier || null, version: serverInfo?.version || null }, users });
    }
    if (action === "backup" && req.method === "POST") {
      const backup = await createWatchHistoryBackup({ reason: "pre_tautulli_import", mirrorRemote: false });
      return sendJson(res, { ok: true, backup });
    }
    if (action === "preview-start" && req.method === "POST") {
      const body = await readJson(req);
      if (!String(body.userId || config.tautulli?.userId || "").trim()) {
        return sendJson(res, { ok: false, error: "Select a valid Tautulli user before importing" }, 400);
      }
      const job = startPreviewJob(config, body);
      return sendJson(res, { ok: true, jobId: job.id, ...publicPreviewJob(job) }, 202, { "Cache-Control": "no-store" });
    }
    if (action === "preview-status" && req.method === "GET") {
      const jobId = new URL(req.url || "/", "http://localhost").searchParams.get("jobId");
      const job = previewJobs.get(jobId);
      if (!job) return sendJson(res, { ok: false, error: "Tautulli preview job not found or expired" }, 404);
      return sendJson(res, { ok: true, ...publicPreviewJob(job) }, 200, { "Cache-Control": "no-store" });
    }
    if (["preview", "import"].includes(action) && req.method === "POST") {
      const body = await readJson(req);
      const context = await selectedContext(config, body);
      const rows = await historyRows(context, body.fromDate || "");
      const selectedTargets = context.activeTargets;
      const options = {
        userId: context.userId,
        userName: context.user.name,
        selectedTargets,
        activeTargets: context.activeTargets,
        fromDate: body.fromDate || "",
        // Decisions the administrator made on the preview's ambiguous rows.
        // Keyed by content, not index, so a play appearing or being pruned in
        // Tautulli between preview and commit cannot shift a decision onto a
        // different record.
        reviewDecisions: normalizeReviewDecisions(body.reviewDecisions),
      };
      if (action === "preview") {
        const preview = await prepareTautulliImport(rows, options);
        return sendJson(res, { ok: true, ...preview, records: undefined, targets: context.activeTargets.map((target) => ({ target, selected: true })) });
      }
      if (body.backup !== false) {
        await createWatchHistoryBackup({ reason: "pre_tautulli_import", mirrorRemote: body.remote === true });
      }
      const result = await commitTautulliImport(rows, options);
      return sendJson(res, { ok: true, ...result, records: undefined, backupCreated: body.backup !== false });
    }
    return methodNotAllowed(res);
  } catch (error) {
    const status = Number(error?.status) >= 400 && Number(error?.status) < 500 ? Number(error.status) : 502;
    return sendJson(res, { ok: false, error: sanitizeTautulliError(error), code: error?.code || "TAUTULLI_REQUEST_FAILED" }, status);
  }
}
