import { state } from "./state.js?v=2.1.0.0.3";
import { slug, movieSlug, movieHref, showName, tvShowTmdbHref, tvShowTvdbHref, movieTmdbHref } from "./utils.js?v=2.1.0.0.3";

// These small lookups are used by the shell and Now Playing navigation. Keep
// them separate from the detail renderer so its metadata graph stays route-only.
export function movieById(id) {
  return state.history.find((entry) => String(entry.id) === String(id))
    || state.moviesRaw.find((entry) => String(entry.id) === String(id))
    || state.activeSessions.find((entry) => String(entry.id || entry.key) === String(id));
}

export function movieBySlugOrId(value) {
  const key = decodeURIComponent(String(value || ""));
  const keySlug = slug(key);
  return movieById(key)
    || state.moviesRaw.find((entry) => movieSlug(entry) === keySlug)
    || state.history.find((entry) => entry.media_type === "movie" && movieSlug(entry) === keySlug)
    || null;
}

function showTitleMatches(candidate, title) {
  const candidateTitle = showName(candidate?.show_title || candidate?.showTitle || candidate?.title || "");
  const candidateKey = slug(candidateTitle).replace(/-+$/, "");
  const titleKey = slug(title).replace(/-+$/, "");
  if (!candidateKey || !titleKey) return false;
  if (candidateKey === titleKey) return true;
  // Provider playback titles sometimes include a release year while the local
  // show record does not (or vice versa). Keep the fallback identity match
  // narrow to a trailing year so unrelated same-name shows do not collide.
  return candidateKey.replace(/-\d{4}$/, "") === titleKey.replace(/-\d{4}$/, "");
}

function showIdentityFromLocalState(title) {
  const candidates = [
    ...(state.showsRaw || []),
    ...(state.upNextItems || []),
    ...(state.history || []),
  ];
  const exact = candidates.find((candidate) => {
    const candidateTitle = showName(candidate?.show_title || candidate?.showTitle || candidate?.title || "");
    return slug(candidateTitle) === slug(title);
  });
  const candidate = exact || candidates.find((entry) => showTitleMatches(entry, title));
  if (!candidate) return null;

  const mediaType = String(candidate.media_type || candidate.mediaType || "").toLowerCase();
  const isEpisode = mediaType === "episode" || candidate.season != null || candidate.episode != null;
  return {
    title: showName(candidate.show_title || candidate.showTitle || candidate.title || title),
    tmdbId: candidate.show_tmdb_id || candidate.showTmdbId || candidate.ids?.showTmdb || (!isEpisode ? candidate.tmdb_id || candidate.tmdbId || candidate.ids?.tmdb : ""),
    tvdbId: candidate.show_tvdb_id || candidate.showTvdbId || candidate.ids?.showTvdb || (!isEpisode ? candidate.tvdb_id || candidate.tvdbId || candidate.ids?.tvdb : ""),
  };
}

export function nowPlayingHref(session = {}) {
  const mediaType = session.mediaType || (session.season != null || session.episode != null ? "tv" : "movie");
  const tmdbId = session.ids?.tmdb || session.tmdb_id || session.tmdbId || "";
  if (["tv", "tvshow", "show", "episode"].includes(mediaType)) {
    const title = showName(session.showTitle || session.show_title || session.title || "");
    if (tmdbId) return tvShowTmdbHref(tmdbId, title);
    const tvdbId = session.ids?.tvdb || session.tvdb_id || session.tvdbId || "";
    if (tvdbId) return tvShowTvdbHref(tvdbId, title);
    const localIdentity = showIdentityFromLocalState(title);
    if (localIdentity?.tvdbId) return tvShowTvdbHref(localIdentity.tvdbId, localIdentity.title);
    if (localIdentity?.tmdbId) return tvShowTmdbHref(localIdentity.tmdbId, localIdentity.title);
    // Plex commonly appends the release year to a series title while the
    // local archive stores the canonical title without it. A title-only
    // fallback should therefore use the canonical-looking key and avoid the
    // trailing separator produced by slug() for punctuation.
    const canonicalTitle = title.replace(/\s*\(\d{4}\)\s*$/, "").trim() || title;
    return `/tvshow/${slug(canonicalTitle).replace(/-+$/, "")}`;
  }
  if (tmdbId) return movieTmdbHref(tmdbId, session.title || session.movieTitle || "");
  const movie = movieBySlugOrId(session.id || session.key || session.title || "") || {
    id: session.id || session.key || session.title || "",
    title: session.title || session.movieTitle || "Movie",
  };
  return movieHref(movie);
}
