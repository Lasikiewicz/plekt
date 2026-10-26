import { db, parseJson } from "../db.js";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { loadMediaConfig, saveMediaConfig, isAuthoritativeRestoreActive } from "../utils/configStore.js";
import { getAnidbAnime } from "../utils/anidbGateway.js";
import { createAnidbRepository } from "../utils/anidbRepository.js";
import { createAnidbMatches, anidbMediaIdentity, verifiedAnidbProviderCandidate } from "../utils/anidbMatches.js";
import { normalizeAnidbId } from "../utils/anidbProtocol.js";
import { lookupAnidbMovie } from "../utils/anidbMovieMatches.js";

const repository = createAnidbRepository(db);
const matches = createAnidbMatches(db);
const reply = (res, body, status = 200) => sendJson(res, body, status, { "Cache-Control": "no-store" });

export async function handleAnidb(req, res, path, { movieLookup = lookupAnidbMovie } = {}) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  const action = path.split("/")[1] || "status";
  const method = req.method;
  if (method !== "GET" && isAuthoritativeRestoreActive()) return reply(res, { error: "A restore is active. Try again when it finishes.", code: "RESTORE_ACTIVE" }, 409);
  if (!({ status: ["GET"], settings: ["POST"], preview: ["POST"], matches: ["POST", "DELETE"], enrich: ["POST"], cache: ["DELETE"] }[action] || []).includes(method)) return methodNotAllowed(res);
  try {
    const config = await loadMediaConfig();
    const enabled = config.metadata?.anidbEnabled === true;
    if (action === "status") return reply(res, { enabled, cache: repository.stats(), matches: matches.list() });
    if (action === "cache") return reply(res, { ok: true, deleted: repository.clearCache(), message: "Cached AniDB metadata cleared. Daily request limits and saved matches retained." });
    const body = await readJson(req);
    if (action === "settings") {
      if (typeof body.enabled !== "boolean") return reply(res, { error: "Enable must be true or false" }, 400);
      await saveMediaConfig({ metadata: { anidbEnabled: body.enabled } });
      return reply(res, { ok: true, enabled: body.enabled });
    }
    if (action === "matches" && method === "DELETE") return reply(res, { ok: true, deleted: matches.remove(body) });
    if (action === "preview") {
      const aid = normalizeAnidbId(body.aid);
      const value = await getAnidbAnime(aid);
      return reply(res, { ...value, data: value.data ? { aid, title: value.data.title, overview: value.data.overview, type: value.data.type, source: value.data.source } : null });
    }
    if (action === "matches") {
      if (body.confirm !== true) return reply(res, { error: "Confirm that this AniDB entry represents the whole movie or show" }, 400);
      anidbMediaIdentity(body);
      const aid = normalizeAnidbId(body.aid);
      const cached = repository.read(aid);
      if (!cached) return reply(res, { error: "Preview this AniDB entry before saving the match" }, 409);
      matches.save({ ...body, aid, label: cached.data.title });
      return reply(res, { ok: true });
    }
    if (!Array.isArray(body.items) || body.items.length > 8) return reply(res, { error: "Provide at most eight metadata identities" }, 400);
    const results = [];
    for (const input of body.items) {
      if (!enabled) { results.push(null); continue; }
      let identity;
      try { identity = anidbMediaIdentity(input); } catch { results.push(null); continue; }
      const saved = matches.resolve(identity);
      let aid = saved?.aid;
      let movieMatch = null;
      if (!aid && identity.mediaType === "movie") {
        movieMatch = await movieLookup(identity, { cacheOnly: body.cacheOnly === true });
        aid = movieMatch?.aid;
      }
      // Automatic reuse requires a direct, consistent provider link and whole-
      // show coverage in existing caches. It never issues a title-based match.
      if (!aid && identity.tvdbId) {
        const row = db.prepare("SELECT details FROM tvdb_metadata_cache WHERE tvdb_id=? AND id=?").get(identity.tvdbId, `series_${identity.tvdbId}`);
        aid = verifiedAnidbProviderCandidate(parseJson(row?.details, null), identity.tvdbId, repository.read);
      }
      if (!aid) { results.push(null); continue; }
      const value = await getAnidbAnime(aid, { cacheOnly: body.cacheOnly === true });
      if (movieMatch && value.data?.type !== "Movie") { results.push(null); continue; }
      results.push(value.data ? { aid, title: value.data.title, overview: value.data.overview, source: value.data.source,
        status: value.status, fetchedAt: value.fetchedAt, evidence: saved?.evidence || movieMatch?.evidence || "provider",
        ...(movieMatch ? { mappingSource: movieMatch.url } : {}) } : null);
    }
    return reply(res, { results });
  } catch (error) {
    if (error?.code === "RESTORE_ACTIVE") return reply(res, { error: error.message, code: error.code }, 409);
    return reply(res, { error: "AniDB request could not be completed. Check the media IDs and try again after any daily request limit." }, 400);
  }
}
