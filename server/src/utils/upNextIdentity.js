// Shared identity and projection helpers for the unified Up Next queue.
// Provider feeds are deliberately normalized here rather than in route or UI
// code so every ingest path makes the same safe merge decision.

export const UP_NEXT_IDENTITY_VERSION = 1;

const PROVIDERS = ["plex", "emby", "jellyfin"];
const ID_NAMES = ["imdb", "tmdb", "tvdb"];

function text(value = "") {
  return String(value ?? "").trim();
}

function lower(value = "") {
  return text(value).toLowerCase();
}

function slug(value = "") {
  return lower(value)
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseDateMs(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function upNextUpdateTime(candidate = {}) {
  return parseDateMs(candidate.updated_at ?? candidate.updatedAt)
    || parseDateMs(candidate.source_updated_at ?? candidate.sourceUpdatedAt);
}

function parseYear(value, title = "") {
  const explicit = numberOrNull(value);
  if (explicit && explicit >= 1800 && explicit <= 3000) return explicit;
  const match = text(title).match(/\((\d{4})\)/);
  return match ? Number(match[1]) : null;
}

function idFromObject(source = {}, names = ID_NAMES) {
  const result = {};
  if (!source || typeof source !== "object") return result;
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = lower(key).replace(/[^a-z0-9]/g, "");
    const provider = normalizedKey.includes("imdb") ? "imdb"
      : normalizedKey.includes("tmdb") || normalizedKey.includes("themoviedb") ? "tmdb"
        : normalizedKey.includes("tvdb") || normalizedKey.includes("thetvdb") ? "tvdb"
          : null;
    if (provider && names.includes(provider) && text(value)) result[provider] = text(value);
  }
  return result;
}

export function normalizeUpNextIds(...sources) {
  const ids = {};
  for (const source of sources) Object.assign(ids, idFromObject(source));
  return ids;
}

function plexGuidIds(item = {}) {
  const ids = {};
  const values = [
    ...(Array.isArray(item.Guid) ? item.Guid : []),
    item.guid,
    item.parentGuid,
    item.grandparentGuid,
  ];
  for (const raw of values) {
    const value = text(raw?.id || raw);
    const match = value.match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?#]+)/i);
    if (!match) continue;
    const provider = lower(match[1]).replace("themoviedb", "tmdb").replace("thetvdb", "tvdb");
    ids[provider] = match[2];
  }
  return ids;
}

function plexItemGuidIds(item = {}) {
  return plexGuidIds({ Guid: item.Guid, guid: item.guid });
}

function plexParentGuidIds(item = {}) {
  const ids = {};
  for (const raw of [
    item.parentGuid,
    item.grandparentGuid,
    item.parentGUID,
    item.grandparentGUID,
    item.ParentGuid,
    item.GrandparentGuid,
    item.ParentGUID,
    item.GrandparentGUID,
  ]) {
    const value = text(raw?.id || raw);
    const match = value.match(/(?:^|\.)(imdb|tmdb|tvdb|themoviedb|thetvdb):\/\/([^/?#]+)/i);
    if (!match) continue;
    const provider = lower(match[1]).replace("themoviedb", "tmdb").replace("thetvdb", "tvdb");
    ids[provider] = match[2];
  }
  return ids;
}

function providerIdsFor(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  return normalizeUpNextIds(
    candidate.ids,
    {
      imdb: candidate.episode_imdb_id || candidate.imdb_id,
      tmdb: candidate.episode_tmdb_id || candidate.tmdb_id,
      tvdb: candidate.episode_tvdb_id || candidate.tvdb_id,
    },
    candidate.provider_ids,
    candidate.providerIds,
    candidate.ProviderIds,
    item.ids,
    item.provider_ids,
    item.providerIds,
    item.ProviderIds,
    plexItemGuidIds(item),
  );
}

function seriesIdsFor(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  return normalizeUpNextIds(
    candidate.show_ids,
    {
      imdb: candidate.show_imdb_id,
      tmdb: candidate.show_tmdb_id,
      tvdb: candidate.show_tvdb_id,
    },
    candidate.showIds,
    candidate.series_ids,
    candidate.seriesIds,
    candidate.show_provider_ids,
    candidate.showProviderIds,
    candidate.SeriesProviderIds,
    item.show_ids,
    item.showIds,
    item.series_ids,
    item.seriesIds,
    item.SeriesProviderIds,
    item.grandparentProviderIds,
    item.GrandparentProviderIds,
    plexParentGuidIds(item),
  );
}

function nativeProvider(candidate = {}) {
  const raw = lower(candidate.provider || candidate.source || candidate.platform);
  return PROVIDERS.includes(raw) ? raw : "";
}

function nativeItemId(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  return text(
    candidate.provider_item_id
      || candidate.providerItemId
      || candidate.item_id
      || candidate.itemId
      || item.ratingKey
      || item.RatingKey
      || item.Id
      || item.id,
  );
}

function nativeSeriesItemId(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  return text(
    candidate.series_provider_item_id
      || candidate.seriesProviderItemId
      || candidate.parent_provider_item_id
      || candidate.parentProviderItemId
      || item.SeriesId
      || item.seriesId
      || item.grandparentRatingKey
      || item.parentRatingKey,
  );
}

function imageTag(tags = {}) {
  if (!tags || typeof tags !== "object") return "";
  return text(tags.Primary || tags.primary || tags.primaryImage || tags.PrimaryImage);
}

function providerImagePath(itemId, tag = "") {
  const id = text(itemId);
  if (!id) return "";
  const suffix = text(tag) ? `?tag=${encodeURIComponent(text(tag))}` : "";
  return `/Items/${encodeURIComponent(id)}/Images/Primary${suffix}`;
}

// Emby and Jellyfin expose image tags on the item returned by the feed, but
// those paths still require the provider credentials. Keep the relative path
// here so the API can turn it into a credentialed URL server-side (and the
// public projection can proxy it through /api/poster).
export function providerArtworkPathsForCandidate(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  const provider = nativeProvider(candidate);
  if (provider !== "emby" && provider !== "jellyfin") return { poster: "", show_poster: "" };

  const itemId = nativeItemId(candidate);
  const itemTag = text(
    candidate.poster_tag
      || candidate.posterTag
      || item.PrimaryImageTag
      || item.primaryImageTag
      || imageTag(item.ImageTags || item.imageTags),
  );
  const seriesId = candidate.media_type === "episode" || candidate.mediaType === "episode"
    ? nativeSeriesItemId(candidate)
    : "";
  const seriesTag = text(
    candidate.show_poster_tag
      || candidate.showPosterTag
      || item.SeriesPrimaryImageTag
      || item.seriesPrimaryImageTag
      || item.SeriesThumbImageTag
      || item.seriesThumbImageTag
      || item.ParentThumbImageTag
      || item.parentThumbImageTag
      || imageTag(item.SeriesImageTags || item.seriesImageTags)
      || imageTag(item.ParentImageTags || item.parentImageTags),
  );
  const seriesImageId = seriesId || item.ParentThumbItemId || item.parentThumbItemId || item.SeriesId || item.seriesId;
  const showPoster = candidate.media_type === "episode" || candidate.mediaType === "episode"
    ? providerImagePath(seriesImageId, seriesTag)
    : "";
  return {
    poster: providerImagePath(itemId, itemTag),
    show_poster: showPoster,
  };
}

function normalizeProviderItems(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const provider of PROVIDERS) {
    const raw = value[provider];
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const ids = [...new Set(values.map((id) => text(id)).filter(Boolean))];
    if (ids.length) result[provider] = ids;
  }
  return result;
}

function showTitleFromText(value = "") {
  const source = text(value);
  const match = source.match(/^(.*?)(?:\s+-\s+|\s+)S\d{1,3}E\d{1,3}(?:\s+-\s+.*)?$/i);
  return text(match?.[1] || source.split(" - S")[0] || source);
}

function episodeTitleFromValue(value, showTitle = "") {
  const title = text(value);
  if (!title) return "";
  const coordinate = title.match(/\bS\d{1,3}E\d{1,3}\b(?:\s*[-:–—]\s*(.*))?$/i);
  if (coordinate && showTitle) {
    const prefix = text(title.slice(0, coordinate.index).replace(/\s*[-:–—]\s*$/, ""));
    if (lower(prefix) === lower(showTitle)) return text(coordinate[1]);
  }
  if (showTitle && lower(title) === lower(showTitle)) return "";
  return title;
}

function episodeCoordinates(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  const season = numberOrNull(
    candidate.season
      ?? candidate.seasonNumber
      ?? candidate.parentIndex
      ?? candidate.ParentIndexNumber
      ?? item.season
      ?? item.seasonNumber
      ?? item.parentIndex
      ?? item.ParentIndexNumber,
  );
  const episode = numberOrNull(
    candidate.episode
      ?? candidate.episodeNumber
      ?? candidate.index
      ?? candidate.IndexNumber
      ?? item.episode
      ?? item.episodeNumber
      ?? item.index
      ?? item.IndexNumber,
  );
  return {
    season: season !== null && season >= 0 ? season : null,
    episode: episode !== null && episode > 0 ? episode : null,
  };
}

function candidateMediaType(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  const value = lower(candidate.media_type || candidate.mediaType || candidate.type || item.media_type || item.mediaType || item.Type || item.type);
  return ["episode", "tv", "show", "series"].includes(value) ? "episode" : "movie";
}

function canonicalProviderPart(ids = {}, prefix = "id") {
  for (const provider of ID_NAMES) {
    if (text(ids[provider])) return `${prefix}:${provider}:${lower(ids[provider])}`;
  }
  return "";
}

function episodeIdentity(candidate, seriesIds, ids, showTitle, season, episode) {
  const coordinate = season !== null && episode !== null ? `|s:${season}|e:${episode}` : "";
  const provider = nativeProvider(candidate);
  const nativeSeriesId = nativeSeriesItemId(candidate);
  const seriesPart = canonicalProviderPart(seriesIds, "series")
    || (provider && nativeSeriesId ? `series:${provider}:${lower(nativeSeriesId)}` : "");
  if (seriesPart) return `episode|${seriesPart}${coordinate}`;

  // If a source has no series ids, title+coordinate is safer than treating an
  // episode id as a cross-provider identity. This still merges repeated
  // observations from the same title-only source while keeping same-title
  // reboots separate when a verified series id is present.
  const titlePart = slug(showTitle);
  if (titlePart && coordinate) return `episode|title:${titlePart}${coordinate}`;

  const itemId = nativeItemId(candidate);
  if (provider && itemId) return `episode|native:${provider}:${lower(itemId)}${coordinate}`;

  const episodePart = canonicalProviderPart(ids, "episode");
  if (episodePart) return `episode|${episodePart}${coordinate}`;
  return `episode|unknown:${titlePart || "item"}${coordinate}`;
}

export function canonicalUpNextKey(candidate = {}) {
  const mediaType = candidateMediaType(candidate);
  const ids = providerIdsFor(candidate);
  const seriesIds = seriesIdsFor(candidate);
  const coordinates = episodeCoordinates(candidate);
  const rawTitle = text(candidate.title || candidate.name || candidate.item?.Name || candidate.item?.title || "Untitled");
  const showTitle = text(candidate.show_title || candidate.showTitle || candidate.seriesName || candidate.SeriesName || candidate.grandparentTitle || candidate.item?.SeriesName || candidate.item?.grandparentTitle || (mediaType === "episode" ? showTitleFromText(rawTitle) : ""));

  if (mediaType === "episode") return episodeIdentity(candidate, seriesIds, ids, showTitle, coordinates.season, coordinates.episode);

  const idPart = canonicalProviderPart(ids);
  if (idPart) return `movie|${idPart}`;
  const year = parseYear(candidate.year || candidate.production_year || candidate.ProductionYear || candidate.item?.ProductionYear, rawTitle);
  const titlePart = slug(rawTitle);
  if (titlePart && year) return `movie|title:${titlePart}|year:${year}`;
  const provider = nativeProvider(candidate);
  const itemId = nativeItemId(candidate);
  if (provider && itemId) return `movie|native:${provider}:${lower(itemId)}`;
  return `movie|title:${titlePart || "item"}|source:${provider || "local"}`;
}

export function upNextIdentityAliases(candidate = {}) {
  const normalized = candidate.canonical_key ? candidate : normalizeUpNextCandidate(candidate);
  const aliases = new Set([normalized.canonical_key]);
  const mediaKey = text(normalized.media_key);
  const hasVerifiedIdentity = normalized.media_type === "movie"
    ? Boolean(normalized.imdb_id || normalized.tmdb_id || normalized.tvdb_id)
    : Boolean(normalized.show_imdb_id || normalized.show_tmdb_id || normalized.show_tvdb_id);
  if (mediaKey && !hasVerifiedIdentity) aliases.add(`legacy:${lower(mediaKey)}`);
  if (normalized.media_type === "episode") {
    // Provider libraries commonly expose different native series ids for the
    // same episode. An episode-level external id is globally specific, so it
    // is the safest cross-provider bridge and lets one card retain every
    // matching Plex, Emby, and Jellyfin action.
    for (const [provider, value] of [
      ["imdb", normalized.episode_imdb_id],
      ["tmdb", normalized.episode_tmdb_id],
      ["tvdb", normalized.episode_tvdb_id],
    ]) {
      if (text(value)) aliases.add(`episode:${provider}:${lower(value)}`);
    }
  }
  for (const [provider, ids] of Object.entries(normalized.provider_items || {})) {
    for (const id of ids || []) aliases.add(`native:${provider}:${lower(id)}`);
  }
  return [...aliases].filter(Boolean);
}

function providerItemsFromCandidate(candidate, provider, itemId) {
  const result = normalizeProviderItems(candidate.provider_items || candidate.providerItems || candidate.native_items || candidate.nativeItems);
  if (provider && itemId) result[provider] = [...new Set([...(result[provider] || []), itemId])];
  return result;
}

export function normalizeUpNextCandidate(candidate = {}) {
  const item = candidate.item || candidate.raw || {};
  const mediaType = candidateMediaType(candidate);
  const coordinates = episodeCoordinates(candidate);
  const ids = providerIdsFor(candidate);
  const seriesIds = seriesIdsFor(candidate);
  const rawTitle = text(candidate.title || candidate.name || item.Name || item.title || "Untitled");
  const showTitle = mediaType === "episode"
    ? text(candidate.show_title || candidate.showTitle || candidate.seriesName || candidate.SeriesName || candidate.grandparentTitle || item.SeriesName || item.grandparentTitle || showTitleFromText(rawTitle))
    : "";
  const episodeTitle = mediaType === "episode"
    ? [candidate.episode_title, candidate.episodeTitle, candidate.name, item.Name, item.name, item.title, rawTitle]
      .map((value) => episodeTitleFromValue(value, showTitle))
      .find(Boolean) || ""
    : "";
  const title = mediaType === "episode" && showTitle && coordinates.season !== null && coordinates.episode !== null
    ? `${showTitle} - S${String(coordinates.season).padStart(2, "0")}E${String(coordinates.episode).padStart(2, "0")}`
    : rawTitle;
  const provider = nativeProvider(candidate);
  const providerItemId = nativeItemId(candidate);
  const queueKind = lower(candidate.queue_kind || candidate.queueKind || candidate.feed_kind || candidate.feedKind) === "next_up" ? "next_up" : "resume";
  const providerItems = providerItemsFromCandidate(candidate, provider, providerItemId);
  const rawPosition = candidate.position_ms ?? candidate.positionMs ?? candidate.offsetMs ?? item.viewOffset;
  const rawDuration = candidate.duration_ms ?? candidate.durationMs ?? item.duration;
  const positionMs = Math.max(0, Math.round(rawPosition !== undefined && rawPosition !== null
    ? numberOrZero(rawPosition)
    : numberOrZero(item.UserData?.PlaybackPositionTicks || item.PlaybackPositionTicks) / 10000));
  const durationMs = Math.max(0, Math.round(rawDuration !== undefined && rawDuration !== null
    ? numberOrZero(rawDuration)
    : numberOrZero(item.RunTimeTicks || item.DurationTicks) / 10000));
  const progressValue = candidate.progress == null
    ? (durationMs > 0 ? (positionMs / durationMs) * 100 : 0)
    : numberOrZero(candidate.progress);
  const explicitPositionKnown = candidate.playback_position_known ?? candidate.playbackPositionKnown;
  const providerResumeObservation = queueKind === "resume"
    && (Boolean(provider) || Object.keys(providerItems).some((name) => PROVIDERS.includes(name)));
  // Native Continue Watching feeds are membership feeds first. Plex can omit
  // viewOffset entirely and Emby can return a zero PlaybackPositionTicks for a
  // resume item, so neither should be rendered as an actual 0% checkpoint.
  // A positive provider offset (or a canonical local progress row) remains a
  // real, displayable playback position.
  const playbackPositionKnown = typeof explicitPositionKnown === "boolean"
    ? explicitPositionKnown
    : queueKind === "resume" && (!providerResumeObservation || positionMs > 0);
  const updatedAt = parseDateMs(candidate.updated_at ?? candidate.updatedAt ?? candidate.source_updated_at ?? candidate.sourceUpdatedAt ?? item.lastViewedAt ?? item.viewedAt ?? item.UpdatedAt ?? item.UserData?.LastPlayedDate ?? item.UserData?.PlayedDate);
  const airDate = text(candidate.air_date || candidate.airDate || candidate.premiere_date || candidate.premiereDate || candidate.originallyAvailableAt || candidate.originally_available_at || item.air_date || item.PremiereDate || item.parentPremiereDate || item.originallyAvailableAt || item.originallyAvailableAtUtc);
  const year = parseYear(candidate.year || candidate.production_year || candidate.productionYear || item.ProductionYear, rawTitle);
  const canonicalKey = canonicalUpNextKey({ ...candidate, item, media_type: mediaType, title, show_title: showTitle, ids, series_ids: seriesIds, season: coordinates.season, episode: coordinates.episode });
  const artwork = providerArtworkPathsForCandidate({ ...candidate, item, provider, media_type: mediaType });
  const explicitPoster = text(candidate.poster_url || candidate.posterUrl || item.poster_url || item.posterUrl || item.thumb || item.Thumb);
  const explicitShowPoster = text(candidate.show_poster_url || candidate.showPosterUrl || item.show_poster_url || item.showPosterUrl);
  const posterUrl = explicitPoster || (mediaType === "episode" ? artwork.show_poster || artwork.poster : artwork.poster);
  const showPosterUrl = explicitShowPoster || artwork.show_poster;
  const upNextLane = candidate.up_next_lane === "rewatch" || candidate.up_next_lane === "new"
    ? candidate.up_next_lane
    : "";

  return {
    id: canonicalKey,
    canonical_key: canonicalKey,
    media_key: text(candidate.media_key || candidate.mediaKey) || canonicalKey,
    media_type: mediaType,
    queue_kind: queueKind,
    ...(upNextLane ? { up_next_lane: upNextLane } : {}),
    title,
    show_title: showTitle || null,
    episode_title: mediaType === "episode" ? episodeTitle : null,
    season: mediaType === "episode" ? coordinates.season : null,
    episode: mediaType === "episode" ? coordinates.episode : null,
    year,
    imdb_id: ids.imdb || null,
    tmdb_id: ids.tmdb || null,
    tvdb_id: ids.tvdb || null,
    show_imdb_id: seriesIds.imdb || null,
    show_tmdb_id: seriesIds.tmdb || null,
    show_tvdb_id: seriesIds.tvdb || null,
    episode_imdb_id: mediaType === "episode" && ids.imdb && ids.imdb !== seriesIds.imdb ? ids.imdb : null,
    episode_tmdb_id: mediaType === "episode" && ids.tmdb && ids.tmdb !== seriesIds.tmdb ? ids.tmdb : null,
    episode_tvdb_id: mediaType === "episode" && ids.tvdb && ids.tvdb !== seriesIds.tvdb ? ids.tvdb : null,
    poster_url: posterUrl || null,
    show_poster_url: showPosterUrl || null,
    position_ms: queueKind === "resume" ? positionMs : 0,
    duration_ms: queueKind === "resume" && durationMs > 0 ? durationMs : null,
    progress: queueKind === "resume" ? Math.max(0, Math.min(100, progressValue)) : 0,
    playback_position_known: playbackPositionKnown,
    updated_at: updatedAt,
    source_updated_at: parseDateMs(candidate.source_updated_at ?? candidate.sourceUpdatedAt) || updatedAt,
    show_latest_watched_at: text(candidate.show_latest_watched_at || candidate.showLatestWatchedAt || candidate.latest_watched_at || candidate.latestWatchedAt) || null,
    air_date: airDate,
    season_remaining: Number.isInteger(candidate.season_remaining) ? candidate.season_remaining : null,
    queue_placement: ["top", "bottom"].includes(candidate.queue_placement) ? candidate.queue_placement : "normal",
    source: provider || text(candidate.source) || "local",
    sources: [...new Set([...(Array.isArray(candidate.sources) ? candidate.sources : []), provider || text(candidate.source)].map(lower).filter(Boolean))].sort(),
    provider_items: providerItems,
    provider_item_id: providerItemId || null,
    parent_provider_item_id: text(candidate.parent_provider_item_id || candidate.parentProviderItemId || item.parentRatingKey || item.ParentId) || null,
    series_provider_item_id: text(candidate.series_provider_item_id || candidate.seriesProviderItemId || item.grandparentRatingKey || item.SeriesId) || null,
    resolution_status: text(candidate.resolution_status || candidate.resolutionStatus) || "resolved",
    last_error: text(candidate.last_error || candidate.lastError) || null,
    is_canonical: candidate.is_canonical === true || candidate.isCanonical === true,
    _aliases: [],
  };
}

function mergeProviderItems(target, source) {
  for (const [provider, ids] of Object.entries(source || {})) {
    target[provider] = [...new Set([...(target[provider] || []), ...(ids || [])].map(text).filter(Boolean))].sort();
  }
  return target;
}

function mergeGroup(rows) {
  const normalized = rows.map((row) => row.canonical_key ? row : normalizeUpNextCandidate(row));
  const resumes = normalized.filter((row) => row.queue_kind === "resume");
  const pool = resumes.length ? resumes : normalized;
  const representative = [...pool].sort((left, right) => (
    Number(hasVerifiedMediaIdentity(right)) - Number(hasVerifiedMediaIdentity(left))
      || Number(right.is_canonical) - Number(left.is_canonical)
      || Number(right.playback_position_known === true) - Number(left.playback_position_known === true)
      || upNextUpdateTime(right) - upNextUpdateTime(left)
      || Number(right.position_ms || 0) - Number(left.position_ms || 0)
      || String(left.canonical_key).localeCompare(String(right.canonical_key))
  ))[0];
  const providerItems = {};
  const sources = new Set();
  for (const row of normalized) {
    for (const source of row.sources || []) sources.add(lower(source));
    if (row.source) sources.add(lower(row.source));
    mergeProviderItems(providerItems, row.provider_items);
  }
  // Rail membership with no position is not saved progress. For an episode it
  // is the provider's next episode (Plex lists it in Continue Watching with no
  // offset; Emby Resume at 0 is Plembfin's own rail refresh), so it must not
  // be labelled part-watched. A movie has no next-episode meaning; keep it.
  const membershipOnly = resumes.length > 0
    && representative.media_type === "episode"
    && resumes.every((row) => row.playback_position_known === false);
  const queueKind = resumes.length && !membershipOnly ? "resume" : "next_up";
  const latestShowWatch = [...normalized]
    .map((row) => row.show_latest_watched_at)
    .filter(Boolean)
    .sort((left, right) => parseDateMs(right) - parseDateMs(left) || String(right).localeCompare(String(left)))[0] || null;
  const output = {
    ...representative,
    id: representative.canonical_key,
    queue_kind: queueKind,
    position_ms: queueKind === "resume" ? Number(representative.position_ms || 0) : 0,
    duration_ms: queueKind === "resume" ? representative.duration_ms : null,
    progress: queueKind === "resume" ? Number(representative.progress || 0) : 0,
    playback_position_known: queueKind === "resume"
      ? normalized.some((row) => row.playback_position_known === true)
      : false,
    media_key: [...normalized]
      .sort((left, right) => Number(right.is_canonical) - Number(left.is_canonical))
      .map((row) => text(row.media_key))
      .find(Boolean) || representative.canonical_key,
    title: [...normalized].map((row) => text(row.title)).find(Boolean) || representative.title,
    show_title: [...normalized].map((row) => text(row.show_title)).find(Boolean) || representative.show_title,
    episode_title: [...normalized].map((row) => text(row.episode_title)).find(Boolean) || representative.episode_title,
    air_date: [...normalized].map((row) => text(row.air_date)).find(Boolean) || representative.air_date || "",
    season_remaining: normalized.find((row) => row.season_remaining != null)?.season_remaining ?? null,
    queue_placement: normalized.find((row) => row.queue_placement !== "normal")?.queue_placement ?? "normal",
    up_next_lane: (representative.up_next_lane === "rewatch" || representative.up_next_lane === "new")
      ? representative.up_next_lane
      : (normalized.find((row) => row.up_next_lane === "rewatch" || row.up_next_lane === "new")?.up_next_lane || null),
    show_latest_watched_at: latestShowWatch,
    poster_url: [...normalized].map((row) => text(row.poster_url)).find(Boolean) || null,
    show_poster_url: [...normalized].map((row) => text(row.show_poster_url)).find(Boolean) || null,
    imdb_id: [...normalized].map((row) => text(row.imdb_id)).find(Boolean) || null,
    tmdb_id: [...normalized].map((row) => text(row.tmdb_id)).find(Boolean) || null,
    tvdb_id: [...normalized].map((row) => text(row.tvdb_id)).find(Boolean) || null,
    show_imdb_id: [...normalized].map((row) => text(row.show_imdb_id)).find(Boolean) || null,
    show_tmdb_id: [...normalized].map((row) => text(row.show_tmdb_id)).find(Boolean) || null,
    show_tvdb_id: [...normalized].map((row) => text(row.show_tvdb_id)).find(Boolean) || null,
    episode_imdb_id: [...normalized].map((row) => text(row.episode_imdb_id)).find(Boolean) || null,
    episode_tmdb_id: [...normalized].map((row) => text(row.episode_tmdb_id)).find(Boolean) || null,
    episode_tvdb_id: [...normalized].map((row) => text(row.episode_tvdb_id)).find(Boolean) || null,
    sources: [...sources].filter(Boolean).sort(),
    provider_items: providerItems,
    provider_item_id: null,
    is_canonical: normalized.some((row) => row.is_canonical),
    _aliases: undefined,
  };
  return output;
}

function episodeTitleCoordinateKey(candidate = {}) {
  if (candidate.media_type !== "episode") return "";
  const showTitle = slug(candidate.show_title || "");
  const season = numberOrNull(candidate.season);
  const episode = numberOrNull(candidate.episode);
  if (!showTitle || season === null || episode === null) return "";
  return `episode|title:${showTitle}|s:${season}|e:${episode}`;
}

function hasSeriesIdentity(candidate = {}) {
  return candidate.media_type === "episode" && Boolean(
    hasExternalSeriesIdentity(candidate)
      || candidate.series_provider_item_id,
  );
}

function hasExternalSeriesIdentity(candidate = {}) {
  return candidate.media_type === "episode" && Boolean(
    candidate.show_imdb_id
      || candidate.show_tmdb_id
      || candidate.show_tvdb_id,
  );
}

function hasExternalMovieIdentity(candidate = {}) {
  return candidate.media_type === "movie" && Boolean(
    candidate.imdb_id
      || candidate.tmdb_id
      || candidate.tvdb_id,
  );
}

function hasVerifiedMediaIdentity(candidate = {}) {
  return hasExternalSeriesIdentity(candidate) || hasExternalMovieIdentity(candidate);
}

function hasNativeSeriesIdentity(candidate = {}) {
  return candidate.media_type === "episode" && Boolean(candidate.series_provider_item_id);
}

function episodeFallbackCompatible(unresolvedRows = [], identifiedRows = []) {
  // A title-only observation can be safely attached to a verified series when
  // it does not contradict any provider id already present in that series.
  // If two distinct series share a title and coordinate, the caller leaves the
  // observation unresolved rather than guessing which reboot it belongs to.
  for (const unresolved of unresolvedRows) {
    for (const identified of identifiedRows) {
      for (const provider of ID_NAMES) {
        const left = text(unresolved[`episode_${provider}_id`]);
        const right = text(identified[`episode_${provider}_id`]);
        if (left && right && lower(left) !== lower(right)) return false;
      }
    }
  }
  return true;
}

function nativeSeriesBridgesExternalIdentity(unresolvedRows = [], identifiedRows = []) {
  const nativeRows = unresolvedRows.filter(hasNativeSeriesIdentity);
  if (!nativeRows.length) return true;

  // Some Emby/Jellyfin installations expose the series provider id on an
  // episode as ProviderIds, but omit SeriesProviderIds. When that observed
  // provider id matches the verified series id from another source, it is a
  // strong cross-provider bridge for this exact episode coordinate.
  return nativeRows.some((nativeRow) => ID_NAMES.some((provider) => {
    const observedId = text(nativeRow[`episode_${provider}_id`] || nativeRow[`${provider}_id`]);
    if (!observedId) return false;
    return identifiedRows.some((identifiedRow) => (
      lower(observedId) === lower(identifiedRow[`show_${provider}_id`])
    ));
  }));
}

function episodeTitlesMatch(unresolvedRows = [], identifiedRows = []) {
  // Emby/Jellyfin can expose a native series id without the external series
  // ids that local metadata uses. An exact episode-title match is a useful
  // bridge in that case; a different title keeps same-name reboots separate.
  // Some provider feeds only return a coordinate placeholder (or no title at
  // all), so an otherwise-unidentified native row can use the single verified
  // series candidate in the same show/coordinate bucket as its bridge.
  const unresolvedTitles = unresolvedRows
    .map((row) => ({ title: normalizedComparableName(row.episode_title), episode: rowEpisode(row) }))
    .filter(({ title, episode }) => title && !isPlaceholderEpisodeTitle(title, episode))
    .map(({ title }) => title);
  const identifiedTitles = identifiedRows
    .map((row) => ({ title: normalizedComparableName(row.episode_title), episode: rowEpisode(row) }))
    .filter(({ title, episode }) => title && !isPlaceholderEpisodeTitle(title, episode))
    .map(({ title }) => title);
  if (unresolvedTitles.length && identifiedTitles.length) {
    return unresolvedTitles.some((left) => identifiedTitles.includes(left));
  }
  if (!identifiedTitles.length) return false;
  return unresolvedRows.some((row) => isPlaceholderEpisodeTitle(row.episode_title, rowEpisode(row)));
}

function rowEpisode(row = {}) {
  return numberOrNull(row.episode);
}

function isPlaceholderEpisodeTitle(value = "", episode = null) {
  const normalized = normalizedComparableName(value);
  if (!normalized || /^\d{1,3}$/.test(normalized)) return true;
  const match = normalized.match(/^(?:episode|ep)\s*0*(\d{1,3})$/);
  if (!match) return false;
  const placeholderEpisode = Number(match[1]);
  return episode === null || placeholderEpisode === episode;
}

function groupYearDisagrees(unresolvedGroup, identifiedGroup) {
  // Two same-coordinate episodes that resolve to conflicting calendar years
  // are different releases/reboots (e.g. a 2001 "Scrubs" S01E03 vs a 2026
  // reboot S01E03), not duplicate observations - never fold one into the
  // other. When either side cannot resolve a year, fall back to the existing
  // lenient behaviour so date-less observations still merge.
  const left = episodeDateIdentity(representativeRow(unresolvedGroup.rows));
  const right = episodeDateIdentity(representativeRow(identifiedGroup.rows));
  if (!left || !right) return false;
  return left.value !== right.value;
}

function reconcileTitleOnlyEpisodeGroups(groups) {
  const titleBuckets = new Map();
  for (const group of groups) {
    for (const row of group.rows) {
      const key = episodeTitleCoordinateKey(row);
      if (!key) continue;
      if (!titleBuckets.has(key)) titleBuckets.set(key, new Set());
      titleBuckets.get(key).add(group);
    }
  }

  for (const bucket of titleBuckets.values()) {
    const identifiedGroups = [...bucket].filter((group) => group.rows.some(hasExternalSeriesIdentity));
    if (!identifiedGroups.length) continue;

    const unresolvedGroups = [...bucket].filter((group) => !group.rows.some(hasExternalSeriesIdentity));
    for (const unresolvedGroup of unresolvedGroups) {
      if (!groups.includes(unresolvedGroup)) continue;
      const compatible = identifiedGroups.filter((identifiedGroup) => (
        episodeFallbackCompatible(unresolvedGroup.rows, identifiedGroup.rows)
          && (
            nativeSeriesBridgesExternalIdentity(unresolvedGroup.rows, identifiedGroup.rows)
              || episodeTitlesMatch(unresolvedGroup.rows, identifiedGroup.rows)
          )
          && !groupYearDisagrees(unresolvedGroup, identifiedGroup)
      ));
      // More than one compatible verified series means the title-only row is
      // ambiguous (a reboot with the same SxxExx is a valid case). Keep it as
      // its own card instead of creating a false cross-series merge.
      if (compatible.length !== 1) continue;
      const target = compatible[0];
      target.rows.push(...unresolvedGroup.rows);
      const index = groups.indexOf(unresolvedGroup);
      if (index >= 0) groups.splice(index, 1);
    }
  }
}

function movieTitleKey(candidate = {}) {
  return candidate.media_type === "movie" ? slug(candidate.title || "") : "";
}

function movieSourceValues(group = {}) {
  return new Set((group.rows || [])
    .map((row) => lower(row.source || "local"))
    .filter(Boolean));
}

function movieGroupsShareSource(left, right) {
  const rightSources = movieSourceValues(right);
  return [...movieSourceValues(left)].some((source) => rightSources.has(source));
}

function movieYearValues(group = {}) {
  return new Set((group.rows || [])
    .map((row) => episodeDateIdentity(row)?.value)
    .filter(Boolean));
}

function movieGroupsDisagreeOnYear(left, right) {
  const leftYears = movieYearValues(left);
  const rightYears = movieYearValues(right);
  if (!leftYears.size || !rightYears.size) return false;
  return ![...leftYears].some((year) => rightYears.has(year));
}

function reconcileTitleOnlyMovieGroups(groups) {
  // Resume rows can be stored before a provider has resolved external ids.
  // When the provider feed later supplies the same title with a verified id,
  // the two rows otherwise become separate cards: the title-only card has no
  // stable artwork identity, while the provider card has the poster. Prefer a
  // same-provider match, but also bridge one unambiguous identified movie
  // across providers. The latter is the normal shape when a local resume row
  // is reconciled with a Jellyfin/Emby/Plex feed from another server. Refuse
  // ambiguous titles (including known remakes with conflicting years).
  const movieGroups = groups.filter((group) => (
    (group.rows || []).every((row) => row.media_type === "movie" && row.queue_kind === "resume")
  ));
  const identifiedGroups = movieGroups.filter((group) => group.rows.some(hasExternalMovieIdentity));
  if (!identifiedGroups.length) return;

  const unresolvedGroups = movieGroups.filter((group) => !group.rows.some(hasExternalMovieIdentity));
  for (const unresolvedGroup of unresolvedGroups) {
    if (!groups.includes(unresolvedGroup)) continue;
    const title = movieTitleKey(representativeRow(unresolvedGroup.rows));
    if (!title) continue;

    const compatible = identifiedGroups.filter((identifiedGroup) => (
      title === movieTitleKey(representativeRow(identifiedGroup.rows))
        && !movieGroupsDisagreeOnYear(unresolvedGroup, identifiedGroup)
    ));
    const sameSource = compatible.filter((identifiedGroup) => movieGroupsShareSource(unresolvedGroup, identifiedGroup));
    // A same-provider match is strongest. If no same-provider match exists,
    // accept exactly one compatible identified movie across providers. More
    // than one identified movie with the same title is ambiguous, so leave the
    // title-only row alone instead of merging a remake into the wrong one.
    const target = sameSource.length === 1
      ? sameSource[0]
      : compatible.length === 1
        ? compatible[0]
        : null;
    if (!target) continue;

    target.rows.push(...unresolvedGroup.rows);
    const index = groups.indexOf(unresolvedGroup);
    if (index >= 0) groups.splice(index, 1);
  }
}

function parseAirDateMs(item = {}) {
  const raw = text(item.air_date || item.airDate);
  if (!raw) return 0;
  if (/^\d{4}$/.test(raw)) return Date.parse(`${raw}-01-01T00:00:00Z`) || 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function upNextOrderKey(item = {}) {
  if (item.media_type !== "episode") return item.media_key || item.id || "";
  const identity = item.show_tvdb_id ? `tvdb:${item.show_tvdb_id}`
    : item.show_tmdb_id ? `tmdb:${item.show_tmdb_id}`
      : item.show_imdb_id ? `imdb:${item.show_imdb_id}` : `title:${lower(item.show_title)}`;
  return `show:${identity}:${item.up_next_lane || ""}`;
}

export function sortUpNextItems(items = [], { sort = "recently_watched", partWatchedFirst = true, customOrder = [], customFallbackSort = "recently_watched" } = {}) {
  const ranks = new Map(customOrder.map((key, index) => [key, index]));
  const mode = sort === "custom" ? customFallbackSort : sort;
  return [...items].sort((left, right) => {
    const leftKnownResume = left.queue_kind === "resume" && left.playback_position_known !== false;
    const rightKnownResume = right.queue_kind === "resume" && right.playback_position_known !== false;
    if (partWatchedFirst && leftKnownResume !== rightKnownResume) return leftKnownResume ? -1 : 1;
    const placement = { top: -1, bottom: 1 };
    const placementDifference = (placement[left.queue_placement] ?? 0) - (placement[right.queue_placement] ?? 0);
    if (placementDifference) return placementDifference;
    if (sort === "custom") {
      const leftRank = ranks.get(upNextOrderKey(left)) ?? Infinity;
      const rightRank = ranks.get(upNextOrderKey(right)) ?? Infinity;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    if (mode === "closest_to_finishing") {
      const leftRemaining = left.season_remaining ?? Infinity;
      const rightRemaining = right.season_remaining ?? Infinity;
      if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
    }
    if (partWatchedFirst && leftKnownResume) {
      return upNextUpdateTime(right) - upNextUpdateTime(left)
        || String(left.id || left.canonical_key || "").localeCompare(String(right.id || right.canonical_key || ""));
    }
    if (mode === "newly_aired" || mode === "oldest_unwatched") {
      const leftAirMs = parseAirDateMs(left);
      const rightAirMs = parseAirDateMs(right);
      if (leftAirMs !== rightAirMs) {
        if (!leftAirMs) return 1;
        if (!rightAirMs) return -1;
        return mode === "oldest_unwatched" ? leftAirMs - rightAirMs : rightAirMs - leftAirMs;
      }
    }
    const leftShowWatchedAt = parseDateMs(left.show_latest_watched_at || left.showLatestWatchedAt);
    const rightShowWatchedAt = parseDateMs(right.show_latest_watched_at || right.showLatestWatchedAt);
    if (leftShowWatchedAt !== rightShowWatchedAt) {
      if (!leftShowWatchedAt) return 1;
      if (!rightShowWatchedAt) return -1;
      return rightShowWatchedAt - leftShowWatchedAt;
    }
    return lower(left.show_title || left.title).localeCompare(lower(right.show_title || right.title))
      || Number(left.season || 0) - Number(right.season || 0)
      || Number(left.episode || 0) - Number(right.episode || 0)
      || text(left.air_date).localeCompare(text(right.air_date))
      || Number(left.year || 0) - Number(right.year || 0)
      || String(left.id || left.canonical_key || "").localeCompare(String(right.id || right.canonical_key || ""));
  });
}

function normalizedComparableName(value = "") {
  // Fold case, punctuation, and word-space apostrophes/quotes so "Richmond's
  // Got Talent" (straight apostrophe) and "Richmond’s Got Talent" (U+2019)
  // compare equal while real title differences are still preserved.
  return lower(value)
    .replace(/['\u2019\u2018\u201C\u201D\u02BC]/g, "")
    .replace(/[\u2014\u2013\u2010]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function representativeRow(rows = []) {
  // Prefer the row that carries the richest usable metadata (external series
  // identity first for a shareable canonical key, then any completed title).
  return [...rows].sort((left, right) => (
    Number(hasExternalSeriesIdentity(right)) - Number(hasExternalSeriesIdentity(left))
      || Number(hasNativeSeriesIdentity(right)) - Number(hasNativeSeriesIdentity(left))
      || Number(right.episode_title ? 1 : 0) - Number(left.episode_title ? 1 : 0)
      || Number(right.year ? 1 : 0) - Number(left.year ? 1 : 0)
  ))[0] || rows[0] || {};
}

function airDateYear(value = "") {
  const match = text(value).match(/(19|20)\d{2}/);
  return match ? match[0] : "";
}

function episodeDateIdentity(row = {}) {
  // A strict, bounded date signature resolved to a calendar year. Prefer the
  // explicit year field; otherwise derive it from a full air date. Two rows
  // only unify when they resolve to the same year.
  const explicitYear = numberOrNull(row.year);
  if (explicitYear >= 1800 && explicitYear <= 3000) return { value: String(explicitYear) };
  const airYear = airDateYear(row.air_date);
  if (airYear) return { value: airYear };
  return null;
}

function sameEpisodeForReal(left, right) {
  if (left.media_type !== "episode" || right.media_type !== "episode") return false;
  if (left.queue_kind !== "next_up" || right.queue_kind !== "next_up") return false;
  const season = numberOrNull(left.season);
  const episode = numberOrNull(left.episode);
  if (season === null || episode === null) return false;
  if (numberOrNull(right.season) !== season || numberOrNull(right.episode) !== episode) return false;

  const show = normalizedComparableName(left.show_title);
  const rightShow = normalizedComparableName(right.show_title);
  if (!show || show !== rightShow) return false;

  const title = normalizedComparableName(left.episode_title);
  const rightTitle = normalizedComparableName(right.episode_title);
  // Same-name reboots share a show name and coordinate but have distinct
  // episode titles (e.g. 2001 "Scrubs" S01E03 vs a 2026 reboot S01E03), so
  // require an identical, non-empty episode title before they may unify.
  if (!title || !rightTitle || title !== rightTitle) return false;

  const leftDate = episodeDateIdentity(left);
  const rightDate = episodeDateIdentity(right);
  if (!leftDate || !rightDate) return false;
  if (leftDate.value !== rightDate.value) return false;
  return true;
}

// Merge next-up cards that represent the same actual series episode but were
// keyed under different identity sources - a provider row carrying only the
// native server series id (e.g. `series:jellyfin:...`) alongside a local
// observation keyed by a verified external show id for the same episode. They
// only unify when show name, season/episode, episode title, AND a bounded
// year/air-date signature all agree, so a genuine re-release/reboot that shares
// the title and coordinate but aired elsewhere or is a different episode stays
// its own card rather than being falsely merged.
function reconcileNativeVersusExternalNextUpGroups(groups) {
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    // Only reconcile groups composed purely of next_up rows (never resume
    // precedence). Work over a stable snapshot because merging removes groups.
    const pure = groups.filter((group) => (group.rows || []).every((row) => row.queue_kind === "next_up"));
    for (let a = 0; a < pure.length && !mergedAny; a += 1) {
      const groupA = pure[a];
      if (!groups.includes(groupA)) continue;
      for (let b = a + 1; b < pure.length; b += 1) {
        const groupB = pure[b];
        if (!groups.includes(groupB)) continue;
        if (!sameEpisodeForReal(representativeRow(groupA.rows), representativeRow(groupB.rows))) continue;

        // Only bridge a series that lacks a verified external identity (but has
        // a native provider series id, e.g. `series:jellyfin:...`) into the
        // verified external one - never join two different native keys into
        // one, since those are distinct library shows even when their metadata
        // coincide. Target is the external-identity holder so the merged card
        // keeps the most shareable canonical key.
        const aHasExternal = groupA.rows.some(hasExternalSeriesIdentity);
        const bHasExternal = groupB.rows.some(hasExternalSeriesIdentity);
        if (aHasExternal === bHasExternal) continue;
        const target = aHasExternal ? groupA : groupB;
        const donor = aHasExternal ? groupB : groupA;
        target.rows.push(...donor.rows);
        const index = groups.indexOf(donor);
        if (index >= 0) groups.splice(index, 1);
        mergedAny = true;
        break;
      }
    }
  }
}

export function mergeUpNextCandidates(candidates = [], { limit = 0 } = {}) {
  const groups = [];
  const aliasToGroup = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = candidate?.canonical_key ? candidate : normalizeUpNextCandidate(candidate);
    normalized._aliases = upNextIdentityAliases(normalized);
    const matching = [...new Set(normalized._aliases.map((alias) => aliasToGroup.get(alias)).filter((group) => group))];
    const group = matching[0] || { rows: [] };
    for (const other of matching.slice(1)) {
      group.rows.push(...other.rows);
      const index = groups.indexOf(other);
      if (index >= 0) groups.splice(index, 1);
      for (const [alias, owner] of aliasToGroup) if (owner === other) aliasToGroup.set(alias, group);
    }
    group.rows.push(normalized);
    if (!groups.includes(group)) groups.push(group);
    for (const alias of normalized._aliases) aliasToGroup.set(alias, group);
  }
  reconcileTitleOnlyEpisodeGroups(groups);
  reconcileTitleOnlyMovieGroups(groups);
  reconcileNativeVersusExternalNextUpGroups(groups);
  const merged = sortUpNextItems(groups.map((group) => mergeGroup(group.rows)));
  return limit > 0 ? merged.slice(0, Math.max(1, Math.round(Number(limit)))) : merged;
}

// Friendly aliases for focused callers and tests.
export const normalizeUpNextIdentity = normalizeUpNextCandidate;
export const buildUpNextIdentity = canonicalUpNextKey;
export const mergeUpNextQueueCandidates = mergeUpNextCandidates;
