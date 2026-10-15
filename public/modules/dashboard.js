import { buildAuthHeaders } from "./auth.js?v=2.0.0.4.0";
import { state, elements } from "./state.js?v=2.0.0.4.0";
import { escapeHtml, escapeAttribute, slug, showTitleFrom, showName, movieHref, movieTmdbHref, tvShowBaseHrefFromEpisode, sourceBadgeHtml, formatDate, resolveEpisodeTitle, episodeTitle, episodeCode, normalizePlatformSource, platformBadge, sourceClass, platformIconMarkup, platformSourceValues, computeProgress, isDemoMode } from "./utils.js?v=2.0.0.4.0";
import { posterMarkup, posterOverflowMenu, hydratePosters, lookupPosterUrl, bindPosterImageErrorHandler, safePosterElementUrl, isLocalArtworkUrl } from "./images.js?v=2.0.0.4.0";
import { ifLoaded } from "./route-modules.js?v=2.0.0.4.0";
import { initialMediaAppLinksContent } from "./media-detail-shared.js?v=2.0.0.4.0";
import { dedupeMediaRecords } from "./media-records.js?v=2.0.0.4.0";
import { bindDashboardRuns, dashboardTvRowUnits, renderDashboardTvRowUnit } from "./dashboard-modern.js?v=2.0.0.4.0";
import { cardArtAttribute } from "./card-art.js?v=2.0.0.4.0";

// The setup wizard loads only when setup is unfinished or its checklist has
// items (see the deferred check in app.js); until then there is nothing to show.
const renderDashboardChecklist = ifLoaded("onboarding", "renderDashboardChecklist");

const PART_WATCHED_DASHBOARD_LIMIT = 30;
const EXPLORER_PAGE_SIZE = 240;
const PART_WATCHED_REQUEST_TIMEOUT_MS = 15000;

let _cb = {};
const dashboardEpisodeTitleCache = new Map();
const dashboardEpisodeTitleInflight = new Map();

export function initDashboard(callbacks) {
  _cb = callbacks;
}

function dashboardEpisodeTitleKey(entry = {}) {
  if (entry.media_type !== "episode") return "";
  const season = Number(entry.season);
  const episode = Number(entry.episode);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  const showTitle = slug(entry.show_title || showTitleFrom(entry.title || ""));
  const showId = entry.show_tmdb_id || entry.show_tvdb_id || entry.show_imdb_id
    || entry.tmdb_id || entry.tvdb_id || entry.imdb_id || showTitle;
  if (!showId) return "";
  return `dashboard-episode:${String(showId).toLowerCase()}|s:${season}|e:${episode}`;
}

function updateDashboardEpisodeTitleElements(key, title) {
  if (!key || typeof document === "undefined") return;
  for (const element of document.querySelectorAll("[data-episode-title-key]")) {
    if (element.dataset.episodeTitleKey !== key) continue;
    element.textContent = title;
    element.title = title;
  }
}

function scheduleDashboardEpisodeTitleResolution(entry = {}) {
  const key = dashboardEpisodeTitleKey(entry);
  if (!key || typeof _cb.resolveEpisodeTitleFromTmdb !== "function") return;
  const resolved = resolveEpisodeTitle(entry);
  if (!resolved.needsResolve) return;
  const cached = dashboardEpisodeTitleCache.get(key);
  if (cached) {
    updateDashboardEpisodeTitleElements(key, cached);
    return;
  }
  if (dashboardEpisodeTitleInflight.has(key)) return;

  const request = Promise.resolve(_cb.resolveEpisodeTitleFromTmdb(entry, null))
    .then(() => {
      const title = String(entry.episode_title || entry.episodeTitle || "").trim();
      if (!title || /^Episode \d+$/i.test(title) || /^\d{1,3}$/.test(title)) return;
      dashboardEpisodeTitleCache.set(key, title);
      for (const historyEntry of state.history || []) {
        if (dashboardEpisodeTitleKey(historyEntry) !== key) continue;
        historyEntry.episode_title = title;
        historyEntry.episodeTitle = title;
        historyEntry.episode_title_status = "resolved";
      }
      updateDashboardEpisodeTitleElements(key, title);
    })
    .catch(() => { })
    .finally(() => dashboardEpisodeTitleInflight.delete(key));
  dashboardEpisodeTitleInflight.set(key, request);
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

export function getRowFitLimit(rowElement) {
  // Dashboard history rows scroll horizontally - render more cards than fit on
  // screen so the row scrolls rather than cutting off content.
  if (rowElement && (rowElement.id === "tvHistoryRow" || rowElement.id === "movieHistoryRow")) {
    return 24;
  }
  const width = rowElement ? rowElement.clientWidth : 0;
  if (width <= 0) return 10;
  const maxCards = Math.floor((width + 12) / 172);
  return Math.max(2, maxCards);
}

export function progressRecordIdentity(record = {}) {
  const mediaType = record.media_type || "";
  const imdb = String(record.imdb_id || "").trim();
  const tmdb = String(record.tmdb_id || "").trim();
  const tvdb = String(record.tvdb_id || "").trim();

  if (mediaType === "episode") {
    const season = record.season ?? "unknown";
    const episode = record.episode ?? "unknown";
    const showTitle = slug(record.show_title || showTitleFrom(record.title) || "");
    if (showTitle && season !== "unknown" && episode !== "unknown") {
      return `episode|show:${showTitle}|s:${season}|e:${episode}`;
    }
    const id = imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : slug(record.title);
    return `episode|id:${id}|s:${season}|e:${episode}`;
  }

  if (mediaType === "movie") {
    const id = imdb ? `imdb:${imdb}` : tmdb ? `tmdb:${tmdb}` : tvdb ? `tvdb:${tvdb}` : slug(record.title);
    return `movie|id:${id}`;
  }

  return `unknown|${slug(record.title)}|${record.updated_at || ""}`;
}

export function dedupePlaybackProgress(items = []) {
  const map = new Map();
  for (const item of items) {
    const key = progressRecordIdentity(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item, sources: [item.source].filter(Boolean) });
      continue;
    }
    const existingTime = Number(existing.updated_at || 0);
    const itemTime = Number(item.updated_at || 0);
    if (itemTime > existingTime) {
      Object.assign(existing, item);
      // The badge describes the app that supplied the progress row currently
      // being displayed. Do not retain sources from older duplicate rows: a
      // stale match from another server can otherwise make Part Watched claim
      // that playback came from multiple apps.
      existing.sources = [item.source].filter(Boolean);
    } else if (itemTime === existingTime) {
      if (partWatchedProgress(item) > partWatchedProgress(existing)) {
        Object.assign(existing, item);
        existing.sources = [item.source].filter(Boolean);
      }
    }
  }
  return [...map.values()];
}

export function partWatchedProgress(entry = {}) {
  const positionMs = Number(entry.position_ms ?? entry.positionMs ?? 0);
  const durationMs = Number(entry.duration_ms ?? entry.durationMs ?? 0);
  if (Number.isFinite(durationMs) && durationMs > 0) return computeProgress(positionMs, durationMs);
  const progress = Number(entry.progress || 0);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
}

function actualWatchCount(entry = {}) {
  const explicit = Number(entry.watch_count);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const historyCount = Array.isArray(entry.playHistory) ? entry.playHistory.length : 0;
  return historyCount || (entry.watched_at ? 1 : 0);
}

function actualWatchText(entry = {}) {
  const count = actualWatchCount(entry);
  return count > 1 ? ` · ${count} actual watches` : "";
}

function actualWatchLabel(entry = {}) {
  const count = actualWatchCount(entry);
  if (count <= 1) return "";
  return count === 2 ? "Watched Twice" : `Watched ${count} Times`;
}

function showProviderIds(entry = {}) {
  return new Map([
    ["imdb", entry.show_imdb_id],
    ["tmdb", entry.show_tmdb_id],
    ["tvdb", entry.show_tvdb_id],
  ].filter(([, value]) => String(value || "").trim()).map(([kind, value]) => [kind, String(value).trim().toLowerCase()]));
}

function sameDashboardEpisode(left = {}, right = {}) {
  if (left.media_type !== "episode" || right.media_type !== "episode") return false;
  if (String(left.season ?? "") !== String(right.season ?? "")) return false;
  if (String(left.episode ?? "") !== String(right.episode ?? "")) return false;

  const leftTitle = slug(left.show_title || showTitleFrom(left.title));
  const rightTitle = slug(right.show_title || showTitleFrom(right.title));
  if (!leftTitle || leftTitle !== rightTitle) return false;

  const leftIds = showProviderIds(left);
  const rightIds = showProviderIds(right);
  if (!leftIds.size || !rightIds.size) return true;
  if ([...leftIds].some(([kind, value]) => rightIds.get(kind) === value)) return true;

  // A TMDB-only row and a TVDB-only row can still be the same series. Keep
  // same-title episodes together unless both rows disagree within the same
  // provider namespace, which is the signal for a genuine reboot/remake.
  return ![...leftIds.keys()].some((kind) => leftIds.has(kind) && rightIds.has(kind));
}

export function mergeDashboardHistoryEntries(entries = []) {
  const groups = [];
  for (const entry of entries) {
    if (!entry || entry.media_type !== "episode") {
      groups.push({ entry: { ...entry }, sources: new Set(platformSourceValues(entry)), watchCount: actualWatchCount(entry) });
      continue;
    }

    const group = groups.find((candidate) => sameDashboardEpisode(candidate.entry, entry));
    if (!group) {
      groups.push({ entry: { ...entry }, sources: new Set(platformSourceValues(entry)), watchCount: actualWatchCount(entry) });
      continue;
    }

    for (const source of platformSourceValues(entry)) group.sources.add(source);
    group.watchCount = Math.max(group.watchCount, actualWatchCount(entry));

    const currentTime = String(group.entry.watched_at || "");
    const entryTime = String(entry.watched_at || "");
    if (entryTime > currentTime) group.entry = { ...entry };

    // Keep useful metadata when the newest source row is sparse.
    for (const field of ["show_title", "show_imdb_id", "show_tmdb_id", "show_tvdb_id", "show_poster_url", "episode_title", "poster_url", "imdb_id", "tmdb_id", "tvdb_id"]) {
      if (!group.entry[field] && entry[field]) group.entry[field] = entry[field];
    }
  }

  return groups
    .map(({ entry, sources, watchCount }) => {
      const sourceValues = platformSourceValues({ ...entry, sources: [...sources] });
      return {
        ...entry,
        sources: sourceValues,
        watch_count: Math.max(Number(entry.watch_count) || 0, watchCount),
      };
    })
    .sort((left, right) => String(right.watched_at || "").localeCompare(String(left.watched_at || "")));
}

function historySourceBadges(entry = {}) {
  return platformSourceValues(entry).map((source) => sourceBadgeHtml(source)).join(" ") || "None";
}

export function renderHistoryCard(entry) {
  if (entry.isPartWatched || entry.part_watched) {
    return renderDashboardHistoryPageCard(entry, { partWatched: true });
  }

  const isEpisode = entry.media_type === "episode";

  if (isEpisode) {
    const showTitle = entry.show_title || showTitleFrom(entry.title);
    const { epTitle } = resolveEpisodeTitle(entry);

    const canonicalShowName = entry.show_title || showName(entry.title);
    const href = tvShowHrefFromHistoryEntry(entry, canonicalShowName);
    const episodePoster = entry.season_poster_url || entry.show_poster_url;
    const posterEntry = episodePoster
      ? { ...entry, poster_url: episodePoster, prefer_raw_poster: true, cache_only_artwork: true }
      : { ...entry, cache_only_artwork: true };

    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup(posterEntry, "history-mini-poster")}
          ${posterOverflowMenu(entry, { showTitle, label: showTitle })}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(showTitle)}">${escapeHtml(showTitle)}</b>
          <span class="history-mini-card-sub history-card-episode-title" data-episode-title-key="${escapeAttribute(dashboardEpisodeTitleKey(entry))}" title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>
          <span class="history-mini-card-sub">${escapeHtml(episodeCode(entry.season, entry.episode))} · ${formatDate(entry.watched_at)}${actualWatchText(entry)}</span>
        </div>
      </a>
    `;
  } else {
    const href = entry.tmdb_id ? movieTmdbHref(entry.tmdb_id, entry.title) : movieHref(entry);
    return `
      <a class="history-mini-card" data-history-id="${entry.id}" href="${escapeAttribute(href)}">
        <span class="history-mini-card-poster-wrapper">
          ${posterMarkup({ ...entry, cache_only_artwork: true }, "history-mini-poster")}
          ${posterOverflowMenu(entry)}
        </span>
        <div class="history-mini-card-details">
          <b class="history-mini-card-title" title="${escapeAttribute(entry.title)}">${escapeHtml(entry.title)}</b>
          <span class="history-mini-card-sub">${formatDate(entry.watched_at)}${actualWatchText(entry)}</span>
        </div>
      </a>
    `;
  }
}

function tvShowHrefFromHistoryEntry(entry = {}, title = "") {
  const href = tvShowBaseHrefFromEpisode(entry, title);
  const season = Number(entry.season ?? entry.seasonNumber ?? entry.season_number ?? entry.parentIndexNumber ?? entry.ParentIndexNumber);
  return Number.isInteger(season) && season >= 0
    ? `${href}#season${season}`
    : href;
}

function dashboardCardIdentity(entry = {}) {
  return String(entry.id ?? entry.media_key ?? progressRecordIdentity(entry));
}

function upNextPlaybackPositionKnown(entry = {}) {
  if (entry.playback_position_known === true) return true;
  if (entry.playback_position_known === false) return false;
  if (String(entry.queue_kind || "") !== "resume") return false;
  const providerItems = entry.provider_items || entry.providerItems || {};
  const hasProviderMembership = Object.entries(providerItems).some(([provider, ids]) => (
    ["plex", "emby", "jellyfin"].includes(String(provider || "").toLowerCase())
      && (Array.isArray(ids) ? ids.length : Boolean(ids))
  ));
  return !hasProviderMembership || Number(entry.position_ms || entry.positionMs || 0) > 0;
}

function hasActualResumeProgress(entry = {}) {
  return Number(entry.position_ms ?? entry.positionMs ?? 0) > 0
    || Number(entry.progress ?? 0) > 0;
}

function dashboardUpNextEpisodeTitle(entry, showTitle) {
  const storedTitle = String(entry.episode_title || entry.episodeTitle || "").trim();
  const generatedTitle = episodeTitle(entry.title || "", entry.episode);
  const code = episodeCode(entry.season, entry.episode);
  const show = String(showTitle || "").trim().toLowerCase();
  const isGeneratedLabel = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return true;
    if (show && code && (normalized === `${show} - ${code.toLowerCase()}` || normalized === `${show} ${code.toLowerCase()}`)) return true;
    return false;
  };

  if (storedTitle && !isGeneratedLabel(storedTitle)) return storedTitle;
  if (generatedTitle && generatedTitle !== String(entry.title || "").trim() && !isGeneratedLabel(generatedTitle)) return generatedTitle;
  return storedTitle && !isGeneratedLabel(storedTitle) ? storedTitle : "";
}

function findKnownShowPoster(entry = {}) {
  if (!entry || entry.media_type !== "episode") return "";
  const showTitle = slug(entry.show_title || showTitleFrom(entry.title) || "");
  const showTmdb = String(entry.show_tmdb_id || "").trim();
  const showTvdb = String(entry.show_tvdb_id || "").trim();
  const showImdb = String(entry.show_imdb_id || "").trim().toLowerCase();

  const match = (state.history || []).find((h) => {
    if (h.media_type !== "episode") return false;
    const matchesShow = (showTmdb && (String(h.show_tmdb_id || "") === showTmdb || String(h.tmdb_id || "") === showTmdb))
      || (showTvdb && (String(h.show_tvdb_id || "") === showTvdb || String(h.tvdb_id || "") === showTvdb))
      || (showImdb && String(h.show_imdb_id || h.imdb_id || "").toLowerCase() === showImdb)
      || (showTitle && slug(h.show_title || showTitleFrom(h.title) || "") === showTitle);
    return Boolean(matchesShow && isLocalArtworkUrl(h.show_poster_url || h.canonical_poster_url));
  });

  // Episode poster_url can be an episode still. Only shared show artwork is
  // safe to use as the fallback for a dashboard card that represents a show.
  const poster = match?.show_poster_url || match?.canonical_poster_url || "";
  return isLocalArtworkUrl(poster) ? poster : "";
}

function findKnownSeasonPoster(entry = {}) {
  if (!entry || entry.media_type !== "episode") return "";
  const direct = entry.season_poster_url || entry.seasonPosterUrl || "";
  if (isLocalArtworkUrl(direct)) return direct;
  const season = Number(entry.season ?? entry.seasonNumber ?? entry.season_number);
  if (!Number.isInteger(season)) return "";
  const showTitle = slug(entry.show_title || showTitleFrom(entry.title) || "");
  const showTmdb = String(entry.show_tmdb_id || "").trim();
  const showTvdb = String(entry.show_tvdb_id || "").trim();
  const showImdb = String(entry.show_imdb_id || "").trim().toLowerCase();
  const match = (state.history || []).find((h) => {
    if (h.media_type !== "episode" || Number(h.season) !== season) return false;
    if (showTmdb && (String(h.show_tmdb_id || "") === showTmdb || String(h.tmdb_id || "") === showTmdb)) return true;
    if (showTvdb && (String(h.show_tvdb_id || "") === showTvdb || String(h.tvdb_id || "") === showTvdb)) return true;
    if (showImdb && String(h.show_imdb_id || h.imdb_id || "").toLowerCase() === showImdb) return true;
    if (showTitle && slug(h.show_title || showTitleFrom(h.title) || "") === showTitle) return true;
    return false;
  });
  const poster = match?.season_poster_url || match?.seasonPosterUrl || "";
  return isLocalArtworkUrl(poster) ? poster : "";
}

export function renderDashboardHistoryPageCard(entry, options = {}) {
  const isPartWatched = Boolean(options.partWatched || entry.isPartWatched || entry.part_watched);
  const isUpNext = Boolean(options.upNext || entry.isUpNext || entry.up_next);
  const isPendingRemoval = isUpNext && entry.pending_removal === true;
  const isSaving = isUpNext && entry.saving === true;
  const isEpisode = entry.media_type === "episode";
  const isResume = isPartWatched || (isUpNext && String(entry.queue_kind || "") === "resume");
  const playbackPositionKnown = !isUpNext || upNextPlaybackPositionKnown(entry);
  let displayTitle = entry.title;
  let epTitle = "";
  let href = "";
  const cardId = isPartWatched ? partWatchedCardIdentity(entry) : dashboardCardIdentity(entry);

  if (isEpisode) {
    displayTitle = entry.show_title || showTitleFrom(entry.title);
    const resolved = isUpNext
      ? { epTitle: dashboardUpNextEpisodeTitle(entry, displayTitle), needsResolve: false }
      : resolveEpisodeTitle(entry);
    epTitle = resolved.epTitle;

    const canonicalShowName = entry.show_title || showName(entry.title);
    href = tvShowHrefFromHistoryEntry(entry, canonicalShowName);
  } else {
    href = entry.tmdb_id ? movieTmdbHref(entry.tmdb_id, entry.title) : movieHref(entry);
  }

  const sources = platformSourceValues(entry);
  const sourceBadge = isPartWatched
    ? (sources.map((source) => renderPartWatchedAppBadge(source, entry, isEpisode ? displayTitle : entry.title)).join(" ") || "None")
    : historySourceBadges(entry);
  const isInteractive = isPartWatched || isUpNext;
  const posterLabel = `View ${displayTitle || "media"}`;
  // Playback-progress rows use their stable media key as the identity that
  // /api/poster can resolve. A progress row's generic `id` can be a watch
  // record id (or another source-specific identifier), which leaves the new
  // Part Watched card on the placeholder even when artwork is available.
  const suppliedShowPoster = entry.show_poster_url || entry.canonical_poster_url || entry.canonicalPosterUrl || "";
  const knownShowPoster = (isEpisode && (!suppliedShowPoster || suppliedShowPoster.startsWith("/api/poster")))
    ? findKnownShowPoster(entry)
    : "";
  const effectiveShowPoster = knownShowPoster || suppliedShowPoster;
  // An episode card shows its season's poster when the series has one, and
  // the series poster otherwise. If the season image fails to load, the
  // image falls back to the series poster (see images.js).
  const knownSeasonPoster = isEpisode && !entry.prefer_show_poster
    ? (entry.season_poster_url || findKnownSeasonPoster(entry))
    : "";
  const effectiveEpisodePoster = knownSeasonPoster || effectiveShowPoster;
  const posterIdentity = entry.id ?? entry.media_key ?? "";
  const hasLocalArtwork = isLocalArtworkUrl(knownSeasonPoster) || isLocalArtworkUrl(entry.poster_url) || isLocalArtworkUrl(effectiveShowPoster);
  const directPosterUrl = !isPartWatched && !isUpNext && posterIdentity && !hasLocalArtwork
    ? `/api/poster?format=image&id=${encodeURIComponent(String(posterIdentity))}`
    : "";
  const posterEntry = {
    ...entry,
    ...(isEpisode && effectiveEpisodePoster
      ? {
        poster_url: effectiveEpisodePoster,
        show_poster_url: effectiveShowPoster || entry.show_poster_url,
        season_poster_url: knownSeasonPoster,
        prefer_raw_poster: true,
      }
      : {}),
    ...(directPosterUrl ? { poster_url: directPosterUrl, show_poster_url: "", prefer_raw_poster: true } : {}),
    cache_only_artwork: !directPosterUrl,
    ...(isPartWatched && entry.media_key ? { id: entry.media_key } : {}),
  };
  const posterHtml = posterMarkup(posterEntry, "history-page-poster");
  const posterLink = isInteractive
    ? `<a class="history-card-poster-link" href="${escapeAttribute(href)}" ${isUpNext ? `data-media-card-href="${escapeAttribute(href)}"` : `data-part-watched-href="${escapeAttribute(href)}"`} aria-label="${escapeAttribute(posterLabel)}">${posterHtml}</a>`
    : posterHtml;
  const titleHtml = isInteractive
    ? `<a class="history-card-title history-card-title-link" href="${escapeAttribute(href)}" ${isUpNext ? `data-media-card-href="${escapeAttribute(href)}"` : `data-part-watched-href="${escapeAttribute(href)}"`} title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</a>`
    : `<b class="history-card-title" title="${escapeAttribute(displayTitle)}">${escapeHtml(displayTitle)}</b>`;
  const titleRowHtml = isUpNext
    ? `<div class="history-card-title-row">${titleHtml}${options.upNextChecking ? `<span class="up-next-checking-status" role="status">Checking…</span>` : ""}</div>`
    : titleHtml;
  const menuHtml = isUpNext
    ? posterOverflowMenu(entry, { menuMode: "up-next", showTitle: displayTitle, title: displayTitle, label: displayTitle, mediaType: isEpisode ? "tv" : "movie", kind: isEpisode ? "episode" : "movie", queueKind: entry.queue_kind })
    : (!isPartWatched ? posterOverflowMenu(entry, isEpisode ? { showTitle: displayTitle, label: displayTitle } : {}) : "");
  const cardClass = [
    "history-page-card",
    "dashboard-history-page-card",
    isPartWatched ? "dashboard-part-watched-card" : "dashboard-up-next-card",
    options.explorer ? "explorer-history-card" : "",
    options.explorerClass || "",
    isSaving ? "up-next-card-saving" : "",
    isPendingRemoval ? "up-next-card-removing" : "",
  ].filter(Boolean).join(" ");
  const cardOpen = isPartWatched
    ? `<article class="${cardClass}"${cardArtAttribute(entry)} data-part-watched-card-id="${escapeAttribute(cardId)}" data-part-watched-media-key="${escapeAttribute(entry.media_key || "")}">`
    : isUpNext
      ? `<article class="${cardClass}"${cardArtAttribute(entry)}${isSaving ? ` aria-busy="true"` : ""} data-up-next-card-id="${escapeAttribute(cardId)}" data-up-next-queue-kind="${isResume ? "resume" : "next_up"}">`
      : `<a class="${cardClass}"${cardArtAttribute(entry)} data-history-id="${escapeAttribute(cardId)}"${options.explorerAttributes || ""} href="${escapeAttribute(options.explorerHref || href)}">`;
  const cardClose = isInteractive ? "</article>" : "</a>";
  const watchedAt = isPartWatched ? entry.updated_at : entry.watched_at;
  const showProgress = isResume && playbackPositionKnown && (!isUpNext || hasActualResumeProgress(entry));
  const partProgress = showProgress ? partWatchedProgress(entry) : 0;
  const partActions = isPartWatched ? `
        <div class="part-watched-card-actions history-card-actions">
          <button class="button-primary part-watched-action-btn" type="button" data-action-watch="${escapeAttribute(entry.media_key || "")}" data-title="${escapeAttribute(entry.title || displayTitle)}">Watched</button>
          <button class="button-ghost part-watched-action-btn" type="button" data-action-unwatch="${escapeAttribute(entry.media_key || "")}" data-title="${escapeAttribute(entry.title || displayTitle)}">Clear</button>
        </div>
      ` : "";
  const watchNowFooter = isUpNext ? `
        <div class="history-card-footer history-card-footer--watch-now">
          <span class="meta-label">Watch now</span>
          <div class="history-card-apps media-app-links up-next-app-links" data-media-app-links
            data-media-type="${isEpisode ? "episode" : "movie"}"
            data-app-link-style="source-badge"
            data-all-apps="true"
            data-tmdb-id="${escapeAttribute(isEpisode ? (entry.show_tmdb_id || "") : (entry.tmdb_id || ""))}"
            data-imdb-id="${escapeAttribute(isEpisode ? (entry.show_imdb_id || "") : (entry.imdb_id || ""))}"
            data-tvdb-id="${escapeAttribute(isEpisode ? (entry.show_tvdb_id || "") : (entry.tvdb_id || ""))}"
            data-season="${escapeAttribute(isEpisode ? (entry.season ?? "") : "")}"
            data-episode="${escapeAttribute(isEpisode ? (entry.episode ?? "") : "")}"
            data-provider-items="${escapeAttribute(JSON.stringify(entry.provider_items || entry.providerItems || {}))}"
            data-title="${escapeAttribute(isEpisode ? (displayTitle || "") : (entry.title || ""))}">${initialMediaAppLinksContent({
              mediaType: isEpisode ? "episode" : "movie",
              appLinkStyle: "source-badge",
              allApps: true,
              tmdbId: isEpisode ? (entry.show_tmdb_id || "") : (entry.tmdb_id || ""),
              imdbId: isEpisode ? (entry.show_imdb_id || "") : (entry.imdb_id || ""),
              tvdbId: isEpisode ? (entry.show_tvdb_id || "") : (entry.tvdb_id || ""),
              season: isEpisode ? (entry.season ?? "") : "",
              episode: isEpisode ? (entry.episode ?? "") : "",
              providerItems: entry.provider_items || entry.providerItems || {},
              title: isEpisode ? (displayTitle || "") : (entry.title || ""),
            })}</div>
        </div>
      ` : `
        <div class="history-card-footer">
          <span class="meta-label">${sources.length > 1 ? "Apps Used:" : "App Used:"}</span>
          <span class="history-card-apps">${sourceBadge}</span>
        </div>
      `;

  // Dashboard cards show Season/Ep right under the episode name and drop the
  // "Available" row and the watch-count pill. Explorer (Library) cards stand
  // for a whole show, so they carry no Season/Ep at all.
  const seasonEpisodeBelowName = isEpisode && !options.explorer;
  const seasonEpisodeRow = `
          <div class="history-card-meta-row">
            <span class="meta-label">Season/Ep:</span>
            <span class="meta-value">${escapeHtml(episodeCode(entry.season, entry.episode))}</span>
          </div>`;
  const metaRows = [
    !isUpNext ? `
          <div class="history-card-meta-row">
            <span class="meta-label">Last Played:</span>
            <span class="meta-value ${isPartWatched ? "part-watched-last-played-value" : ""}">${formatDate(watchedAt)}</span>
          </div>` : "",
    !isPartWatched && !isUpNext && options.explorer && actualWatchLabel(entry) ? `
          <div class="history-card-meta-row">
            <span class="meta-value history-card-watch-count">${escapeHtml(actualWatchLabel(entry))}</span>
          </div>` : "",
  ].filter(Boolean);
  const metaHtml = metaRows.length ? `<div class="history-card-meta">${metaRows.join("")}
        </div>` : "";

  // Up next cards show the progress bar above the "Watch now" apps.
  const progressHtml = showProgress ? `
          <div class="part-watched-progress-container${isUpNext ? " up-next-progress-container" : ""}">
            <div class="part-watched-progress-bar"><div class="part-watched-progress-fill" style="width: ${partProgress}%;"></div></div>
            ${isUpNext
              ? `<div class="up-next-progress-row">
                  <span class="part-watched-progress-text">${partProgress}% watched</span>
                  <button class="icon-button up-next-clear-button" type="button" aria-label="Clear progress" title="Clear progress" data-up-next-clear="${escapeAttribute(cardId)}">Clear</button>
                </div>`
              : `<span class="part-watched-progress-text">${partProgress}% watched</span>`}
          </div>
        ` : "";

  return `
    ${cardOpen}
      <div class="history-card-poster-wrapper">
        ${posterLink}
        ${menuHtml}
      </div>
      <div class="history-card-details">
        <div class="history-card-header">
          ${titleRowHtml}
          ${options.explorerSummary !== undefined ? `<p class="history-card-summary" data-overview-text>${escapeHtml(options.explorerSummary)}</p>` : isEpisode ? `<span class="history-card-episode"${!isUpNext ? ` data-episode-title-key="${escapeAttribute(dashboardEpisodeTitleKey(entry))}"` : ""} title="${escapeAttribute(epTitle)}">${escapeHtml(epTitle)}</span>` : ""}
          ${seasonEpisodeBelowName ? seasonEpisodeRow : ""}
        </div>
        ${metaHtml}
        ${isUpNext ? progressHtml : ""}
        ${watchNowFooter}
        ${isUpNext ? "" : progressHtml}
        ${partActions}
      </div>
    ${cardClose}
  `;
}

export function renderDashboardUpNextCard(entry) {
  return renderDashboardHistoryPageCard({ ...entry, up_next: true }, { upNext: true, upNextChecking: entry.checking === true });
}

export function observeDashboardPosters() {
  state.dashboardPosterObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;

  state.dashboardPosterObserver = new IntersectionObserver(
    async (entries) => {
      const fallbacks = entries
        .filter((entry) => entry.isIntersecting && entry.target.classList.contains("poster-fallback"))
        .map((entry) => entry.target);

      if (!fallbacks.length) return;

      const hydrateOne = async (fallback) => {
        const posterId = fallback.dataset.posterId;
        if (!posterId) return;
        if (isDemoMode()) return;

        const posterUrl = await lookupPosterUrl(posterId, { allowNetwork: true });
        const safeUrl = safePosterElementUrl(posterUrl);
        if (!fallback.isConnected || !fallback.classList.contains("poster-fallback")) return;

        const image = document.createElement("img");
        image.className = fallback.className.replace(/\bposter-fallback\b/g, "").trim() || fallback.className;
        bindPosterImageErrorHandler(image, { allowNetwork: true });
        // Keep a visible dashboard gap recoverable even when an older negative
        // lookup is cached in the browser: the image form re-runs the same
        // authenticated server resolver and redirects to local artwork.
        image.src = encodeURI(safeUrl || `/api/poster?format=image&id=${encodeURIComponent(posterId)}`);
        image.alt = `${fallback.getAttribute("aria-label") || "Media poster"}`;
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.dataset.posterId = posterId;
        fallback.replaceWith(image);
      };

      // Each IntersectionObserver batch is just the handful of cards that
      // scrolled into view, not the whole row - no need to serialize them.
      await Promise.allSettled(fallbacks.map(hydrateOne));
    },
    { rootMargin: "200px" },
  );

  const tvRow = elements.tvHistoryRow;
  const movieRow = elements.movieHistoryRow;
  const rows = [
    tvRow,
    movieRow,
    elements.partWatchedTvRow,
    elements.partWatchedMovieRow,
  ].filter(Boolean);
  for (const row of rows) {
    for (const fallback of row.querySelectorAll("[data-poster-id].poster-fallback")) {
      state.dashboardPosterObserver.observe(fallback);
    }
  }
}

function setDashboardHistoryRowMode(row) {
  row?.classList.add("dashboard-history-card-row");
}

const DASHBOARD_CARD_MOTION_MS = 280;
const DASHBOARD_CARD_EXIT_MS = 200;

function dashboardMotionReduced() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function dashboardRowCards(row) {
  if (!row) return [];
  return [...row.children].filter((node) => node.matches?.(
    "[data-history-id], [data-collapsed-run-key], [data-part-watched-card-id], [data-up-next-card-id], [data-now-playing-card-id], .shared-media-card",
  ));
}

function dashboardRowCardKey(node) {
  return String(
    node?.dataset?.historyId
      || node?.dataset?.collapsedRunKey
      || node?.dataset?.partWatchedCardId
      || node?.dataset?.upNextCardId
      || node?.dataset?.nowPlayingCardId
      || node?.dataset?.mediaCardKey
      || "",
  );
}

function clearDashboardMotionStyles(node) {
  node.classList.remove("dashboard-card-motion", "dashboard-card-enter");
  node.style.removeProperty("transition");
  node.style.removeProperty("transform");
}

// Resume progress is the only part of a Part Watched card that normally
// changes while the item remains in the same place. Ignore those values when
// comparing the row's generated markup so the existing card (and hydrated
// poster image) can be patched instead of recreated.
function dashboardRowHtmlWithoutPartWatchedProgress(html = "") {
  return String(html)
    .replace(/(<div class="part-watched-progress-fill" style="width:\s*)[^"]+(;"><\/div>)/g, "$1__part_progress__$2")
    .replace(/(<span class="part-watched-progress-text">)[^<]*(<\/span>)/g, "$1__part_progress_text__$2")
    .replace(/(<span class="meta-value part-watched-last-played-value">)[^<]*(<\/span>)/g, "$1__part_last_played__$2");
}

function patchDashboardPartWatchedProgress(row, nextHtml, visibleItems = []) {
  const previousHtml = row?.dataset?.renderedHtml || "";
  const partWatchedItems = visibleItems.filter((entry) => entry?.isPartWatched || entry?.part_watched);
  if (!previousHtml || !partWatchedItems.length) return false;
  if (dashboardRowHtmlWithoutPartWatchedProgress(previousHtml) !== dashboardRowHtmlWithoutPartWatchedProgress(nextHtml)) {
    return false;
  }

  const existingCards = [...row.querySelectorAll("[data-part-watched-card-id]")];
  const expectedIds = partWatchedItems.map(partWatchedCardIdentity);
  const existingIds = existingCards.map((card) => card.dataset.partWatchedCardId);
  if (existingIds.length !== expectedIds.length || existingIds.some((id, index) => id !== expectedIds[index])) {
    return false;
  }

  const cardsById = new Map(existingCards.map((card) => [card.dataset.partWatchedCardId, card]));
  for (const entry of partWatchedItems) {
    patchPartWatchedCardProgress(cardsById.get(partWatchedCardIdentity(entry)), entry);
  }
  return true;
}

function dashboardCardPosterElement(card) {
  return card?.querySelector?.(
    ".history-card-poster-wrapper img, .history-card-poster-wrapper .poster-fallback, "
      + ".now-poster-large-wrapper img, .now-poster-large-wrapper .poster-fallback, "
      + ".shared-media-card-poster img, .shared-media-card-poster .poster-fallback",
  ) || null;
}

function dashboardCardPosterKey(poster) {
  if (!poster) return "";
  const posterId = String(poster.getAttribute("data-poster-id") || "");
  if (posterId) return `id:${posterId}`;
  return `src:${String(poster.currentSrc || poster.getAttribute("src") || "")}`;
}

function dashboardCardRenderSignature(card) {
  if (!card) return "";
  const clone = card.cloneNode(true);
  clone.classList.remove("dashboard-card-motion", "dashboard-card-enter", "dashboard-card-exit");
  clone.style.removeProperty("transition");
  clone.style.removeProperty("transform");

  const poster = dashboardCardPosterElement(clone);
  if (poster) poster.replaceWith(document.createTextNode("__poster__"));
  for (const appLinks of clone.querySelectorAll("[data-media-app-links]")) {
    appLinks.replaceChildren(document.createTextNode("__media_links__"));
  }
  for (const progressFill of clone.querySelectorAll(".part-watched-progress-fill, .now-card-progress-fill")) {
    progressFill.style.width = "__progress__";
  }
  for (const progressText of clone.querySelectorAll(".part-watched-progress-text, .now-card-progress-text")) {
    progressText.textContent = "__progress_text__";
  }
  for (const lastPlayed of clone.querySelectorAll(".part-watched-last-played-value")) {
    lastPlayed.textContent = "__last_played__";
  }
  return clone.outerHTML;
}

function preserveDashboardCardArtwork(currentCard, nextCard) {
  const currentPoster = dashboardCardPosterElement(currentCard);
  const nextPoster = dashboardCardPosterElement(nextCard);
  if (!currentPoster || !nextPoster) return;
  if (dashboardCardPosterKey(currentPoster) !== dashboardCardPosterKey(nextPoster)) return;
  nextPoster.replaceWith(currentPoster);
}

// Reconcile a live card row by identity. Existing cards stay mounted when
// their rendered content is unchanged, and changed cards reuse their poster
// node when the artwork identity is unchanged. This keeps an SSE update from
// rebuilding every sibling card (or making the browser decode every poster)
// just because one item changed.
export function reconcileDashboardCardRow(row, html) {
  if (!row) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  const nextCards = [...template.content.children].filter((node) => node.matches?.(
    "[data-history-id], [data-collapsed-run-key], [data-part-watched-card-id], [data-up-next-card-id], [data-now-playing-card-id], .shared-media-card",
  ));
  const currentCards = dashboardRowCards(row);

  // Empty/loading/error states have no keyed cards to reconcile.
  if (!nextCards.length || !currentCards.length) {
    row.innerHTML = html;
    return;
  }

  const currentByKey = new Map(currentCards.map((card) => [dashboardRowCardKey(card), card]));
  const nextKeys = new Set(nextCards.map(dashboardRowCardKey));
  for (let index = 0; index < nextCards.length; index += 1) {
    const nextCard = nextCards[index];
    const key = dashboardRowCardKey(nextCard);
    let currentCard = currentByKey.get(key);
    if (currentCard) {
      if (dashboardCardRenderSignature(currentCard) !== dashboardCardRenderSignature(nextCard)) {
        preserveDashboardCardArtwork(currentCard, nextCard);
        currentCard.replaceWith(nextCard);
        currentCard = nextCard;
        currentByKey.set(key, currentCard);
      }
      const cardAtPosition = row.children[index];
      if (cardAtPosition !== currentCard) row.insertBefore(currentCard, cardAtPosition || null);
      continue;
    }
    row.insertBefore(nextCard, row.children[index] || null);
    currentByKey.set(key, nextCard);
  }

  for (const card of dashboardRowCards(row)) {
    if (!nextKeys.has(dashboardRowCardKey(card))) card.remove();
  }
}

function renderDashboardHistoryRow(row, nextHtml, visibleItems = []) {
  if (!row || row.dataset.renderedHtml === nextHtml) return;
  if (patchDashboardPartWatchedProgress(row, nextHtml, visibleItems)) {
    row.dataset.renderedHtml = nextHtml;
    return;
  }

  row.dataset.renderedHtml = nextHtml;
  updateDashboardRowWithMotion(row, nextHtml, {
    onCommitted: () => {
      bindPartWatchedAppBadges(row);
      hydratePosters(row, { allowNetwork: true });
      for (const entry of visibleItems) {
        if (entry?.media_type === "episode" && !entry.isPartWatched && !entry.part_watched) {
          scheduleDashboardEpisodeTitleResolution(entry);
        }
      }
    },
  });
}

// Replace a dashboard row while preserving the visual position of cards that
// remain in the row. The server sends a fresh ordered snapshot, so a small
// FLIP pass gives existing cards a natural slide when a new watch arrives and
// lets newly inserted cards enter without animating width/height or causing a
// layout jump. `exitKeys` is used by Up Next so a watched item gets a short
// fade before the new snapshot takes its place.
export function updateDashboardRowWithMotion(row, html, { exitKeys = [], onCommitted } = {}) {
  if (!row) return;
  const previousCards = dashboardRowCards(row);
  const previousPositions = new Map(previousCards.map((card) => [dashboardRowCardKey(card), card.getBoundingClientRect()]));
  const previousKeys = previousCards.map(dashboardRowCardKey);
  const exitSet = new Set((exitKeys || []).map((key) => String(key)));
  const token = Number(row.dataset.motionToken || 0) + 1;
  row.dataset.motionToken = String(token);

  const commit = () => {
    if (Number(row.dataset.motionToken) !== token) return;
    reconcileDashboardCardRow(row, html);
    const nextCards = dashboardRowCards(row);
    const nextKeys = nextCards.map(dashboardRowCardKey);
    const membershipChanged = previousKeys.length !== nextKeys.length
      || previousKeys.some((key, index) => key !== nextKeys[index]);
    const shouldAnimate = previousCards.length > 0 && membershipChanged && !dashboardMotionReduced();

    if (shouldAnimate) {
      const previousKeySet = new Set(previousKeys);
      for (const card of nextCards) {
        const key = dashboardRowCardKey(card);
        if (!previousKeySet.has(key)) {
          card.classList.add("dashboard-card-enter");
          continue;
        }
        const from = previousPositions.get(key);
        if (!from) continue;
        const to = card.getBoundingClientRect();
        const deltaX = from.left - to.left;
        const deltaY = from.top - to.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
        card.classList.add("dashboard-card-motion");
        card.style.transition = "none";
        card.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
        requestAnimationFrame(() => {
          if (!card.isConnected) return;
          card.style.transition = `transform ${DASHBOARD_CARD_MOTION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          card.style.transform = "";
          window.setTimeout(() => clearDashboardMotionStyles(card), DASHBOARD_CARD_MOTION_MS + 40);
        });
      }
      window.setTimeout(() => {
        for (const card of dashboardRowCards(row)) clearDashboardMotionStyles(card);
      }, DASHBOARD_CARD_MOTION_MS + 80);
    }

    onCommitted?.();
  };

  const exitingCards = previousCards.filter((card) => exitSet.has(dashboardRowCardKey(card)));
  if (exitingCards.length && !dashboardMotionReduced()) {
    exitingCards.forEach((card) => card.classList.add("dashboard-card-exit"));
    window.setTimeout(commit, DASHBOARD_CARD_EXIT_MS);
    return;
  }
  commit();
}

function renderDashboardHistoryRows() {
  if (state.historyLoading || state.historyLoadError) {
    const title = state.historyLoading ? "Loading watch history…" : "Watch history is unavailable";
    const detail = state.historyLoading ? "Checking the latest server data." : "The latest watch history could not be loaded.";
    for (const row of [elements.tvHistoryRow, elements.movieHistoryRow]) {
      if (!row) continue;
      row.innerHTML = `<div class="empty-log"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`;
      delete row.dataset.renderedHtml;
    }
    return;
  }

  const tvHistory = mergeDashboardHistoryEntries(state.history.filter((entry) => entry.media_type === "episode"));
  const movieHistory = dedupeMediaRecords(state.history.filter((entry) => entry.media_type === "movie"), "movies");
  const tvItems = tvHistory;
  const movieItems = movieHistory;

  let visibleTv = [];
  let visibleMovies = [];

  if (elements.tvHistoryRow) {
    if (!tvItems.length) {
      elements.tvHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>${state.history.length ? "No TV history in this preview" : "No watch history yet"}</b>
          <span>${state.history.length ? "New watched episodes will appear here." : "Import a Trakt export or send watched webhooks to start building the archive."}</span>
        </div>
      `;
      delete elements.tvHistoryRow.dataset.renderedHtml;
    } else {
      const tvFitLimit = getRowFitLimit(elements.tvHistoryRow);
      const tvUnits = dashboardTvRowUnits(tvItems).slice(0, tvFitLimit);
      visibleTv = tvUnits.flatMap((unit) => unit.entries);
      const nextTvHtml = tvUnits
        .map((unit, index) => renderDashboardTvRowUnit(unit, (entry) => renderDashboardHistoryPageCard({ ...entry, eager_poster: index < 6 })))
        .join("");
      renderDashboardHistoryRow(elements.tvHistoryRow, nextTvHtml, visibleTv);
    }
  }

  if (elements.movieHistoryRow) {
    if (!movieItems.length) {
      elements.movieHistoryRow.innerHTML = `
        <div class="empty-log">
          <b>${state.history.length ? "No movie history in this preview" : "No watch history yet"}</b>
          <span>${state.history.length ? "New watched movies will appear here." : "Import a Trakt export or send watched webhooks to start building the archive."}</span>
        </div>
      `;
      delete elements.movieHistoryRow.dataset.renderedHtml;
    } else {
      const movieFitLimit = getRowFitLimit(elements.movieHistoryRow);
      visibleMovies = movieItems.slice(0, movieFitLimit);
      const nextMovieHtml = visibleMovies
        .map((entry, index) => renderDashboardHistoryPageCard({ ...entry, eager_poster: index < 6 }))
        .join("");
      renderDashboardHistoryRow(elements.movieHistoryRow, nextMovieHtml, visibleMovies);
    }
  }

  observeDashboardPosters();
}
bindDashboardRuns(renderDashboardHistoryRows);

// Reconciles only the dashboard history surfaces after an SSE-triggered
// background fetch. The rest of the dashboard stays untouched, including
// Now Playing, checklist content, scroll positions, and any open controls.
export function refreshDashboardHistoryInPlace() {
  if (partWatchedTargets().length) renderPartWatched({ renderInline: false });
  renderDashboardHistoryRows();
}

export function renderDashboard() {
  renderDashboardChecklist();
  if (partWatchedTargets().length) renderPartWatched({ renderInline: false });
  setDashboardHistoryRowMode(elements.tvHistoryRow);
  setDashboardHistoryRowMode(elements.movieHistoryRow);
  renderDashboardHistoryRows();
}

export function updateDashboardSplitState() {
  if (!elements.timelineView) return;
  const playing = state.activeSessions.length > 0;
  elements.timelineView.dataset.dashState = playing ? "playing" : "idle";
}

function applyPartWatchedPosterWidth() {
  document.documentElement.style.setProperty("--part-watched-poster-width", "128px");
}

export function resetPartWatchedView(key = "", { preserveItems = false } = {}) {
  // A dashboard live refresh can reset this view while its previous request is
  // still pending. Abort and invalidate that request before clearing loading;
  // otherwise its late finally block can own the new generation and leave the
  // panel stuck on "Loading partly watched items…" indefinitely. Automatic
  // refreshes pass preserveItems so the last successful snapshot remains
  // visible until the replacement snapshot is ready.
  state.partWatchedRequestVersion += 1;
  state.partWatchedAbortController?.abort();
  state.partWatchedAbortController = null;
  if (!preserveItems) state.partWatchedRaw = [];
  state.partWatchedOffset = 0;
  state.partWatchedHasMore = true;
  state.partWatchedLoading = false;
  state.partWatchedQueryKey = key;
  state.partWatchedScrollArmed = false;
}

function partWatchedCardIdentity(entry = {}) {
  return String(entry.media_key || progressRecordIdentity(entry));
}

export function renderPartWatchedCard(entry) {
  return renderDashboardHistoryPageCard({
    ...entry,
    isPartWatched: true,
  }, { partWatched: true });
}

function renderPartWatchedAppBadge(source, entry, mediaTitle) {
  const target = normalizePlatformSource(source);
  const label = platformBadge(source);
  return `
    <button class="source-badge source-badge--icon ${sourceClass(source)} part-watched-app-badge" type="button"
      data-part-watched-app-target="${escapeAttribute(target)}"
      data-part-watched-app-type="${entry.media_type === "episode" ? "tv" : "movie"}"
      data-part-watched-app-title="${escapeAttribute(mediaTitle || "")}"
      data-part-watched-app-tmdb="${escapeAttribute(entry.tmdb_id || "")}"
      data-part-watched-app-imdb="${escapeAttribute(entry.imdb_id || "")}"
      data-part-watched-app-tvdb="${escapeAttribute(entry.tvdb_id || "")}"
      aria-label="Open ${escapeAttribute(label)}"
      title="Open in ${escapeAttribute(label)}">
      ${platformIconMarkup(source)}
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function bindPartWatchedAppBadges(root) {
  for (const button of root.querySelectorAll("[data-part-watched-app-target]")) {
    button.addEventListener("click", async () => {
      const target = button.dataset.partWatchedAppTarget;
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        _cb.setMessage?.("Allow pop-ups to open the media app.", "error");
        return;
      }
      popup.opener = null;

      try {
        const params = new URLSearchParams({
          mediaType: button.dataset.partWatchedAppType || "movie",
          title: button.dataset.partWatchedAppTitle || "",
        });
        for (const [key, datasetKey] of [["tmdbId", "partWatchedAppTmdb"], ["imdbId", "partWatchedAppImdb"], ["tvdbId", "partWatchedAppTvdb"]]) {
          if (button.dataset[datasetKey]) params.set(key, button.dataset[datasetKey]);
        }

        const response = await fetch(`/api/media-app-links?${params.toString()}`, { headers: authHeaders(), cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        const link = Array.isArray(body.links)
          ? body.links.find((candidate) => normalizePlatformSource(candidate?.target) === target)
          : null;
        if (!response.ok || !link?.url) throw new Error(`Could not open ${platformBadge(target)}.`);
        popup.location.href = link.url;
      } catch (error) {
        popup.close();
        _cb.setMessage?.(error.message, "error");
      }
    });
  }
}

// Patches only the parts of an already-rendered part-watched card that resume
// progress actually changes (the progress bar and the last-played time),
// leaving its poster/title/badges DOM nodes completely untouched. The SSE
// live-update stream only reports "something changed" (a shared history
// version bump), not which item - and on the dashboard the overwhelmingly
// common cause while something is playing is this same row's own resume
// position ticking forward, not a new item starting or its poster changing.
// Rebuilding the row's whole innerHTML for that recreated every poster
// <img> in it, which is what looked like posters "refreshing" during
// playback (see KNOWN_ISSUES.md).
function patchPartWatchedCardProgress(node, entry) {
  if (!node) return;
  const progressPercent = partWatchedProgress(entry);
  const fill = node.querySelector(".part-watched-progress-fill");
  if (fill) fill.style.width = `${progressPercent}%`;
  const text = node.querySelector(".part-watched-progress-text");
  if (text) text.textContent = `${progressPercent}% watched`;
  const lastPlayed = node.querySelector(".part-watched-last-played-value");
  if (lastPlayed) lastPlayed.textContent = entry.updated_at ? formatDate(entry.updated_at) : "";
}

function partWatchedTargets() {
  if (elements.partWatchedTvRow || elements.partWatchedMovieRow) {
    return [
      { type: "episode", row: elements.partWatchedTvRow, section: elements.partWatchedTvSection },
      { type: "movie", row: elements.partWatchedMovieRow, section: elements.partWatchedMovieSection },
    ].filter((target) => target.row);
  }
  return elements.partWatchedPanel
    ? [{ type: "all", row: elements.partWatchedPanel, section: elements.partWatchedSection }]
    : [];
}

function enrichPartWatchedEntry(entry = {}) {
  if (entry.media_type !== "episode") return { ...entry };
  const matchingHistory = state.history.find((historyEntry) => (
    (entry.media_key && historyEntry.media_key === entry.media_key)
    || (entry.tmdb_id && historyEntry.tmdb_id === entry.tmdb_id && historyEntry.season === entry.season && historyEntry.episode === entry.episode)
    || (entry.tvdb_id && historyEntry.tvdb_id === entry.tvdb_id && historyEntry.season === entry.season && historyEntry.episode === entry.episode)
  ));
  if (!matchingHistory) return { ...entry };
  return {
    ...matchingHistory,
    ...entry,
    show_title: entry.show_title || matchingHistory.show_title || showTitleFrom(matchingHistory.title),
    poster_url: entry.poster_url || matchingHistory.poster_url,
    show_tmdb_id: entry.show_tmdb_id || matchingHistory.show_tmdb_id,
    show_tvdb_id: entry.show_tvdb_id || matchingHistory.show_tvdb_id,
  };
}

function renderPartWatchedBucket(target, items) {
  if (!target.row) return;
  if (!items.length) {
    target.section?.classList.add("hidden");
    target.row.innerHTML = "";
    delete target.row.dataset.renderedHtml;
    return;
  }

  target.section?.classList.remove("hidden");
  const visibleItems = items.slice(0, PART_WATCHED_DASHBOARD_LIMIT);
  const currentIds = visibleItems.map(partWatchedCardIdentity);
  const existingCards = [...target.row.querySelectorAll("[data-part-watched-card-id]")];
  const existingIds = existingCards.map((el) => el.dataset.partWatchedCardId);
  const sameMembership = existingIds.length === currentIds.length && existingIds.every((id, index) => id === currentIds[index]);

  if (!sameMembership) {
    const nextHtml = visibleItems.map((entry, index) => renderPartWatchedCard({
      ...entry,
      eager_poster: index < 6,
      prefer_raw_poster: true,
    })).join("");
    target.row.innerHTML = nextHtml;
    bindPartWatchedAppBadges(target.row);
    hydratePosters(target.row, { allowNetwork: false });
  } else {
    const nodesById = new Map(existingCards.map((el) => [el.dataset.partWatchedCardId, el]));
    for (const entry of visibleItems) patchPartWatchedCardProgress(nodesById.get(partWatchedCardIdentity(entry)), entry);
  }
}

export function renderPartWatched({ renderInline = true } = {}) {
  const targets = partWatchedTargets();
  const inline = !targets.length && Boolean(elements.tvHistoryRow || elements.movieHistoryRow);
  if (!targets.length && !inline) return;
  const key = "default";
  if (state.partWatchedQueryKey !== key) resetPartWatchedView(key);

  if (!state.partWatchedRaw.length && state.partWatchedHasMore && !state.partWatchedLoading && state.token) {
    loadPartWatched().catch((error) => _cb.setMessage?.(error.message, "error"));
  }

  applyPartWatchedPosterWidth();

  if (inline) {
    // The dashboard renderer owns the TV/movie rows in the current shell. A
    // caller such as the Clear Progress action can request an immediate
    // redraw after resetting the progress cache; the fetch completion then
    // redraws the row again with the new first card in place.
    if (renderInline) renderDashboard();
    return;
  }

  const wrapper = elements.partWatchedRows;
  if (!state.partWatchedRaw.length) {
    if (state.partWatchedLoading) {
      // A first load has no cards to preserve, so show a placeholder. Live
      // refreshes keep their last successful snapshot in partWatchedRaw and
      // therefore leave the existing cards painted while this request runs.
      const firstTarget = targets[0];
      const hasCards = targets.some((target) => target.row.querySelectorAll("[data-part-watched-card-id]").length);
      if (!hasCards && firstTarget.row) {
        wrapper?.classList.remove("hidden");
        firstTarget.section?.classList.remove("hidden");
        firstTarget.row.innerHTML = `<div class="empty-log"><b>Loading partly watched items…</b></div>`;
      }
    } else {
      wrapper?.classList.add("hidden");
      for (const target of targets) {
        target.section?.classList.add("hidden");
        target.row.innerHTML = "";
        delete target.row.dataset.renderedHtml;
      }
      // Legacy test and embedding fallback: the old section is the wrapper.
      if (!wrapper) elements.partWatchedSection?.classList.add("hidden");
    }
    updateDashboardSplitState();
    return;
  }

  wrapper?.classList.remove("hidden");
  const items = state.partWatchedRaw.map(enrichPartWatchedEntry);
  for (const target of targets) {
    const bucket = target.type === "all"
      ? items
      : items.filter((entry) => target.type === "episode" ? entry.media_type === "episode" : entry.media_type === "movie");
    renderPartWatchedBucket(target, bucket);
  }
  if (!wrapper) elements.partWatchedSection?.classList.remove("hidden");
  updateDashboardSplitState();
}

export async function loadPartWatched({ silent = false } = {}) {
  if (state.partWatchedLoading || !state.partWatchedHasMore) return;
  const requestVersion = state.partWatchedRequestVersion + 1;
  state.partWatchedRequestVersion = requestVersion;
  const controller = new AbortController();
  state.partWatchedAbortController = controller;
  state.partWatchedLoading = true;
  const timeout = setTimeout(() => controller.abort(), PART_WATCHED_REQUEST_TIMEOUT_MS);

  try {
    const url = new URL("/api/playback-progress", window.location.origin);
    url.searchParams.set("limit", String(EXPLORER_PAGE_SIZE));
    url.searchParams.set("offset", String(state.partWatchedOffset));

    const res = await fetch(url, { headers: authHeaders(), cache: "no-store", signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Progress load failed ${res.status}`);
    if (requestVersion !== state.partWatchedRequestVersion) return;

    const items = Array.isArray(body.progress) ? body.progress : [];
    // A reset starts a new first page. When that reset preserved the previous
    // snapshot for a live refresh, the response is authoritative and must
    // replace it rather than merge removed rows back into the list.
    const pageOffset = state.partWatchedOffset;
    state.partWatchedRaw = dedupePlaybackProgress(pageOffset === 0 ? items : [...state.partWatchedRaw, ...items]);
    state.partWatchedOffset = pageOffset + items.length;
    state.partWatchedHasMore = false;
  } catch (error) {
    // A reset intentionally aborts the old generation; it must not change or
    // render the replacement request's state.
    if (requestVersion !== state.partWatchedRequestVersion) return;
    state.partWatchedHasMore = false;
    if (error?.name === "AbortError") throw new Error("Part Watched request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (requestVersion === state.partWatchedRequestVersion) {
      state.partWatchedAbortController = null;
      state.partWatchedLoading = false;
      if (!silent) {
        if (!partWatchedTargets().length && (elements.tvHistoryRow || elements.movieHistoryRow)) {
          renderDashboard();
        } else {
          renderPartWatched();
        }
      }
    }
  }
}
