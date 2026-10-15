import {
  escapeAttribute,
  escapeHtml,
  episodeCode,
  movieHref,
  movieTmdbHref,
  slug,
  tvShowHrefFromEpisode,
  tvShowTmdbHref,
  tvShowTvdbHref,
} from "./utils.js?v=2.0.0.1.0";
import { posterMarkup, posterOverflowMenu, proxiedArtworkUrl, tmdbPoster } from "./images.js?v=2.0.0.1.0";
import { cardArtAttribute } from "./card-art.js?v=2.0.0.1.0";
// With Posters only on, a clicked poster opens its card (Discover, Watchlist, Ratings, Playlists).
import "./page-card-open.js?v=2.0.0.1.0";

function normalizedType(item = {}) {
  const raw = String(item.media_type || item.mediaType || item.type || "").toLowerCase();
  if (["tv", "show", "series", "episode"].includes(raw)) return raw === "episode" ? "episode" : "tv";
  return "movie";
}

function titleFor(item, type) {
  if (type === "episode") return item.show_title || item.showTitle || item.title || "Unknown show";
  return item.title || item.name || "Untitled";
}

function tmdbTitleUrl(mediaType, tmdbId) {
  const id = String(tmdbId || "").trim();
  if (!id) return "";
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encodeURIComponent(id)}`;
}

export function mediaCardHref(item = {}) {
  const type = normalizedType(item);
  const title = titleFor(item, type);
  // Recompute episode links from the identity contract instead of trusting a
  // prebuilt href that may have been assembled from an episode-level provider
  // id by an older payload/cache.
  if (type === "episode") return tvShowHrefFromEpisode(item);
  if (item.href) return String(item.href);
  if (type === "movie") {
    return item.tmdb_id || item.tmdbId
      ? movieTmdbHref(item.tmdb_id || item.tmdbId, title)
      : movieHref({ ...item, title });
  }
  const showTmdbId = item.show_tmdb_id || item.showTmdbId || (type === "tv" ? (item.tmdb_id || item.tmdbId || "") : "");
  const showTvdbId = item.show_tvdb_id || item.showTvdbId || "";
  if (showTmdbId) return tvShowTmdbHref(showTmdbId, title);
  if (showTvdbId) return tvShowTvdbHref(showTvdbId, title);
  return `/tvshow/${encodeURIComponent(slug(title))}`;
}

function mediaYear(item = {}) {
  return String(item.year || item.release_date || item.first_air_date || "").slice(0, 4);
}

function mediaPoster(item = {}, type = "movie") {
  const raw = item.poster_url || item.posterUrl || item.imageUrl || item.poster || "";
  const showPoster = item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "";
  const seasonPoster = item.season_poster_url || item.seasonPosterUrl || "";
  // A TV/show card represents the series, so a saved show override must win
  // over the stale poster that may still be carried by a personal-media row.
  // Episode cards use their season's poster when known, then their own image;
  // neither should overwrite the shared poster selected for the show.
  if (type === "tv" && showPoster) return proxiedArtworkUrl(showPoster, "poster");
  if (type === "episode" && seasonPoster) return proxiedArtworkUrl(seasonPoster, "poster");
  if (raw) return proxiedArtworkUrl(raw, "poster");
  if (showPoster) return proxiedArtworkUrl(showPoster, "poster");
  const path = item.poster_path || item.posterPath || "";
  if (!path) return "";
  const tmdbId = item.tmdb_id || item.tmdbId || (item.source === "TMDB" ? item.id : "");
  return tmdbPoster(path, tmdbId, type === "episode" ? "tv" : type);
}

export function normalizeMediaCardRecord(item = {}, options = {}) {
  const type = normalizedType(item);
  const title = titleFor(item, type);
  const tmdbId = item.tmdb_id || item.tmdbId || (item.source === "TMDB" ? item.id : "") || "";
  const tvdbId = item.tvdb_id || item.tvdbId || "";
  const poster = mediaPoster(item, type);
  const hasMetaOverride = Object.prototype.hasOwnProperty.call(options, "meta");
  const meta = hasMetaOverride
    ? options.meta
    : item.meta
      || (type === "episode" && item.season != null && item.episode != null
        ? episodeCode(item.season, item.episode)
        : [mediaYear(item), item.media_label || item.mediaLabel].filter(Boolean).join(" · "));
  return {
    ...item,
    id: item.id || (tmdbId ? `tmdb:${type}:${tmdbId}` : undefined),
    title,
    media_type: type,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    poster_url: poster,
    show_poster_url: item.show_poster_url || item.showPosterUrl || item.canonical_poster_url || item.canonicalPosterUrl || "",
    prefer_raw_poster: Boolean(poster),
    href: mediaCardHref({ ...item, title, tmdb_id: tmdbId, tvdb_id: tvdbId, media_type: type }),
    meta,
    description: options.description ?? item.overview ?? item.description ?? "",
  };
}

export function renderMediaCard(item = {}, options = {}) {
  const record = normalizeMediaCardRecord(item, options);
  const variant = String(options.variant || "default").replace(/[^a-z0-9_-]/gi, "-");
  const cardClass = ["shared-media-card", variant && `shared-media-card--${variant}`, options.compact && "is-compact"]
    .filter(Boolean)
    .join(" ");
  const href = record.href;
  const poster = posterMarkup(record, "shared-media-card-poster-image");
  const menuHtml = options.menuMode
    ? posterOverflowMenu(record, {
      menuMode: options.menuMode,
      mediaType: record.media_type === "tv" ? "tv" : "movie",
      title: record.title,
      label: record.title,
      watchlisted: Boolean(options.watchlisted),
      personalAction: options.personalMenuAction,
      personalKey: options.personalKey || record.media_key,
      personalRemoveLabel: options.personalRemoveLabel,
    })
    : "";
  const title = escapeHtml(record.title);
  const meta = record.meta ? `<span class="shared-media-card-meta">${escapeHtml(record.meta)}</span>` : "";
  const unifiedMetadata = variant === "discover" || variant === "personal";
  const mediaTypeLabel = record.media_type === "tv" || record.media_type === "episode" ? "TV show" : "Movie";
  const voteAverage = Number(record.vote_average || 0);
  const inlineRating = options.ratingText || (voteAverage > 0 ? `★${voteAverage.toFixed(1)}` : "");
  const ratingHref = options.ratingSourceHref || (voteAverage > 0 ? tmdbTitleUrl(record.media_type, record.tmdb_id) : "");
  const ratingMarkup = options.ratingActionHtml || (inlineRating
    ? (ratingHref
      ? `<a class="shared-media-card-rating" href="${escapeAttribute(ratingHref)}" target="_blank" rel="noopener noreferrer" aria-label="View ${escapeAttribute(mediaTypeLabel)} rating source" title="View rating source">${escapeHtml(inlineRating)}</a>`
      : `<span class="shared-media-card-rating">${escapeHtml(inlineRating)}</span>`)
    : "");
  const typeRatingHtml = unifiedMetadata
    ? `<div class="shared-media-card-type-rating"><span class="shared-media-card-type">${mediaTypeLabel}</span>${ratingMarkup}</div>`
    : "";
  const releaseDate = options.releaseDate || "";
  const releaseDateHtml = releaseDate
    ? `<div class="shared-media-card-release"><span class="shared-media-card-release-label">Released</span><span class="shared-media-card-release-value">${escapeHtml(releaseDate)}</span></div>`
    : "";
  const description = record.description
    ? `<p class="shared-media-card-description"><span class="shared-media-card-description-text">${escapeHtml(record.description)}</span></p>`
    : "";
  const badges = [];
  if (options.badge) badges.push(options.badge);
  if (record.source && options.showSource !== false) badges.push(record.source);
  if (!unifiedMetadata && record.vote_average && Number(record.vote_average) > 0) badges.push(`★ ${Number(record.vote_average).toFixed(1)}`);
  const badgesHtml = badges.length
    ? `<div class="shared-media-card-badges">${badges.map((badge) => `<span class="status-pill status-muted">${escapeHtml(badge)}</span>`).join("")}</div>`
    : "";
  const status = options.status || record.status || "";
  const statusHtml = status ? `<span class="shared-media-card-status">${escapeHtml(status)}</span>` : "";
  const actions = options.actionsHtml || "";

  return `
    <article class="${cardClass}"${unifiedMetadata ? cardArtAttribute(record) : ""} data-media-card-type="${escapeAttribute(record.media_type)}"${options.attributesHtml ? ` ${options.attributesHtml}` : ""}>
      <div class="shared-media-card-poster-wrap">
        <a class="shared-media-card-poster" href="${escapeAttribute(href)}" data-media-card-href="${escapeAttribute(href)}" aria-label="View ${escapeAttribute(record.title)}">
          ${poster}
        </a>
        ${options.posterBadgeHtml || ""}
        ${menuHtml}
      </div>
      <div class="shared-media-card-body">
        <a class="shared-media-card-title" href="${escapeAttribute(href)}" data-media-card-href="${escapeAttribute(href)}" title="${escapeAttribute(record.title)}">${title}</a>
        ${meta}
        ${unifiedMetadata ? `${description}${typeRatingHtml}${releaseDateHtml}` : `${releaseDateHtml}${status ? statusHtml : ""}${badgesHtml}${description}`}
        ${options.noteHtml || ""}
        ${actions ? `<div class="shared-media-card-actions">${actions}</div>` : ""}
      </div>
    </article>
  `;
}
