import { requireAdmin } from "../utils/auth.js";
import { sendJson, sendOptions, methodNotAllowed } from "../utils/http.js";
import { getCanonicalSeasonPosterUrls } from "../utils/mediaArtwork.js";
import { getFanartTvSeasonPosters } from "../utils/fanartGateway.js";
import { getCachedTvdbId, getTmdbDetails, getTmdbSeasonArtwork } from "../utils/tmdbGateway.js";
import { getTvdbSeriesExtended, resolveTvdbSeriesId } from "../utils/tvdbGateway.js";

// Season artwork for the Edit Images "Season Posters" tab. The options come from
// the same providers as the show Poster tab, narrowed to one season: TMDB's season
// poster, TVDB's season image and fanart.tv season posters.

const TMDB_IMAGE_ROOT = "https://image.tmdb.org/t/p/w500";
const TVDB_ARTWORK_ROOT = "https://artworks.thetvdb.com";

function seasonNumberParam(req) {
  const number = Number(req.query.seasonNumber ?? req.query.season_number);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function showIdentityQuery(req) {
  return {
    tmdbId: String(req.query.tmdbId || req.query.id || "").trim(),
    tvdbId: String(req.query.tvdbId || req.query.tvdb_id || "").trim(),
    title: String(req.query.title || "").trim(),
  };
}

// Current season posters for the tab's list: the saved override or cached provider
// art per season number. The client falls back to TMDB's season poster for the rest.
export async function handleSeasonPosters(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const { tmdbId, tvdbId, title } = showIdentityQuery(req);
    const posters = getCanonicalSeasonPosterUrls({ media_type: "tv", tmdb_id: tmdbId, tvdb_id: tvdbId, title });
    return sendJson(res, { seasons: Object.fromEntries(posters) });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}

export async function handleSeasonPosterOptions(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return methodNotAllowed(res);
  if (!(await requireAdmin(req, res))) return;
  try {
    const seasonNumber = seasonNumberParam(req);
    if (seasonNumber === null) return sendJson(res, { error: "seasonNumber is required" }, 400);
    const { tmdbId, tvdbId: queryTvdbId, title } = showIdentityQuery(req);

    const items = [];
    const seen = new Set();
    const add = (url, source, lang = "") => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      items.push({ url, source, lang });
    };

    const tmdbDetails = tmdbId
      ? await getTmdbDetails({ mediaType: "tv", tmdbId, title, ids: { tvdbId: queryTvdbId }, lane: "interactive" }).catch(() => null)
      : null;
    const tmdbSeason = tmdbId
      ? await getTmdbSeasonArtwork({ tmdbId, seasonNumber, lane: "interactive" }).catch(() => null)
      : null;
    const seasonPosterPath = String(tmdbSeason?.poster_path || "").trim();
    if (seasonPosterPath) {
      if (/^https?:\/\//i.test(seasonPosterPath)) {
        let source = "TMDB";
        try {
          const host = new URL(seasonPosterPath).hostname.toLowerCase();
          if (host === "thetvdb.com" || host.endsWith(".thetvdb.com")) source = "TVDB";
        } catch { /* The provider response is still passed through as supplied. */ }
        add(seasonPosterPath, source);
      } else {
        add(`${TMDB_IMAGE_ROOT}${seasonPosterPath}`, "TMDB");
      }
    }

    let tvdbId = queryTvdbId;
    if (!tvdbId && tmdbId) tvdbId = getCachedTvdbId(tmdbId);
    if (!tvdbId) tvdbId = String(tmdbDetails?.external_ids?.tvdb_id || "");
    if (!tvdbId && title) tvdbId = await resolveTvdbSeriesId({ title }).catch(() => "");
    if (tvdbId) {
      const extended = await getTvdbSeriesExtended(tvdbId, { lane: "interactive" }).catch(() => null);
      const tvdbSeason = (Array.isArray(extended?.seasons) ? extended.seasons : []).find((season) => Number(season.number) === seasonNumber
        && (season.type?.type === "official" || season.type?.name === "Aired Order"));
      const image = String(tvdbSeason?.image || "");
      if (image) add(image.startsWith("/") ? `${TVDB_ARTWORK_ROOT}${image}` : image, "TVDB");
      const fanart = await getFanartTvSeasonPosters(tvdbId, seasonNumber);
      for (const item of fanart) add(item.url, "Fanart", item.lang);
    }

    return sendJson(res, { posters: items, season_number: seasonNumber });
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
