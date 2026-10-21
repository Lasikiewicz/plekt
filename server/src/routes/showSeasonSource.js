import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { bumpDataVersion, writeAuditLog } from "../db.js";
import { queryShowDetail } from "../utils/dataRepo.js";
import { SEASON_SOURCES, setShowSeasonSource } from "../utils/seasonSource.js";
import { previewShowSeasonSource } from "../utils/showSeasonTranslation.js";
import { flushShowProgressUpdates, queueShowProgressUpdate } from "../utils/showProgressCache.js";
import { planShowTraktReplace, replaceShowOnTrakt } from "../utils/showTraktReplace.js";
import { getTrackerConnection } from "../utils/trackerConnectionRepo.js";

// Fix Match per-show TVDB/TMDB choice. GET show-season-source/preview returns
// the counts and review list without writing. POST show-season-source saves the
// choice after the user confirmed that preview. Watch rows are never rewritten.

function badRequest(res, error) {
  return sendJson(res, { error }, 400);
}

async function loadShow({ tvdbId, tmdbId }) {
  const show = await queryShowDetail({ tvdbId, tmdbId });
  return show && String(show.tvdb_id || tvdbId || "") ? show : null;
}

function cleanSource(value) {
  const source = String(value || "").trim().toLowerCase();
  return SEASON_SOURCES.includes(source) ? source : "";
}

export async function handleShowSeasonSourcePreview(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const tvdbId = String(req.query.tvdbId || "").trim();
  const tmdbId = String(req.query.tmdbId || "").trim();
  const source = cleanSource(req.query.source);
  if (!tvdbId) return badRequest(res, "tvdbId is required");
  if (!source) return badRequest(res, "source must be tvdb or tmdb");
  const show = await loadShow({ tvdbId, tmdbId });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  const preview = await previewShowSeasonSource({ show, tvdbId, tmdbId: tmdbId || show.tmdb_id || "", source });
  return sendJson(res, { preview }, 200, { "Cache-Control": "private, no-store" });
}

export async function handleShowSeasonSource(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const tvdbId = String(body?.tvdbId || "").trim();
  const tmdbId = String(body?.tmdbId || "").trim();
  const source = cleanSource(body?.source);
  if (!tvdbId) return badRequest(res, "tvdbId is required");
  if (!source) return badRequest(res, "source must be tvdb or tmdb");
  if (body?.confirm !== true) return badRequest(res, "Confirm the preview before saving");
  const show = await loadShow({ tvdbId, tmdbId });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  // Recomputed here rather than trusted from the client, so the saved row
  // numbering always matches the rows as they are now.
  const preview = await previewShowSeasonSource({ show, tvdbId, tmdbId: tmdbId || show.tmdb_id || "", source });
  setShowSeasonSource(tvdbId, source, { rowNumbering: preview.rowNumbering });
  bumpDataVersion("show-season-source");
  queueShowProgressUpdate(show.title);
  await flushShowProgressUpdates().catch((error) => console.warn(`[ShowSeasonSource] Progress refresh failed for ${show.title}: ${error.message}`));
  writeAuditLog("show.season_source.saved", { ip: req.ip || req.socket?.remoteAddress, detail: { tvdbId, source, rowNumbering: preview.rowNumbering } });
  return sendJson(res, { ok: true, preview });
}

// Second confirmation: replace the show's plays on Trakt with the translated
// numbering. GET .../trakt-preview returns the counts without calling Trakt;
// POST .../trakt-replace runs it after the user confirmed those counts.
export async function handleShowSeasonSourceTraktPreview(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const tvdbId = String(req.query.tvdbId || "").trim();
  const tmdbId = String(req.query.tmdbId || "").trim();
  if (!tvdbId) return badRequest(res, "tvdbId is required");
  const show = await loadShow({ tvdbId, tmdbId });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  const connection = getTrackerConnection("trakt");
  const plan = await planShowTraktReplace({ show, tvdbId, tmdbId: tmdbId || show.tmdb_id || "" });
  return sendJson(res, {
    traktConnected: connection?.status === "connected",
    available: Boolean(plan?.moves.length),
    episodes: plan?.episodes || 0,
    plays: plan?.plays || 0,
    review: plan?.review || [],
  }, 200, { "Cache-Control": "private, no-store" });
}

export async function handleShowSeasonSourceTraktReplace(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  const body = await readJson(req);
  const tvdbId = String(body?.tvdbId || "").trim();
  const tmdbId = String(body?.tmdbId || "").trim();
  if (!tvdbId) return badRequest(res, "tvdbId is required");
  if (body?.confirm !== true) return badRequest(res, "Confirm the Trakt replace before running it");
  const show = await loadShow({ tvdbId, tmdbId });
  if (!show) return sendJson(res, { error: "not found" }, 404);
  const result = await replaceShowOnTrakt({
    show,
    tvdbId,
    tmdbId: tmdbId || show.tmdb_id || "",
    logger: (line) => console.log(`[ShowSeasonSource] ${show.title}: ${line}`),
  }).catch((error) => {
    // Refusals come back as result objects with their own text. A thrown error is
    // unexpected and can carry stack or upstream detail, so it stays in the log.
    console.error("[ShowSeasonSource] Trakt replace failed", error);
    return { ok: false, error: "Trakt replace failed. Check the server log for details." };
  });
  writeAuditLog("show.season_source.trakt_replace", { ip: req.ip || req.socket?.remoteAddress, detail: { tvdbId, ...result } });
  return sendJson(res, result, result.ok ? 200 : 409);
}
