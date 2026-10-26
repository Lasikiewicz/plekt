import { db, parseJson } from "../db.js";
import { trackerProviderForSource } from "./trackers/registry.js";

// TV databases do not agree on how to number a two-part episode. One source
// may expose "S05E21" as a single long episode while another exposes the same
// programme as "S05E21" and "S05E22". Keep the source coordinates intact and
// carry this small, derived projection alongside a dispatch media object.

const EPISODE_MARKER_RE = /(?:[\(\[]\s*(?:part|pt)?\.?\s*(one|two|1|2)\s*[\)\]]|\b(?:part|pt)\.?\s*(one|two|1|2)\b)\s*$/i;
const COMBINED_MARKER_RE = /(?:\bparts?\s*(?:one|1)\s*(?:and|&|\+|\/)\s*(?:two|2)\b|[\(\[]\s*(?:parts?\s*)?(?:one|1)\s*(?:and|&|\+|\/)\s*(?:two|2)\s*[\)\]])/i;
const COMPOUND_SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function coordinatesFrom(value = {}) {
  const title = clean(value.title || value.name);
  const match = title.match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  return {
    season: numberOrNull(value.season ?? value.parentIndex ?? value.ParentIndexNumber ?? match?.[1]),
    episode: numberOrNull(value.episode ?? value.index ?? value.IndexNumber ?? match?.[2]),
  };
}

function showTitleFrom(value = {}) {
  const explicit = clean(value.show_title || value.showTitle || value.seriesTitle || value.series_name);
  if (explicit) return explicit;
  return clean(value.title || value.name)
    .replace(/\s*-?\s*S\d{1,3}E\d{1,3}\b.*$/i, "")
    .trim();
}

export function canonicalText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function episodeTitleFrom(value = {}) {
  const explicit = clean(value.episode_title || value.episodeTitle || value.episode?.title);
  if (explicit) return explicit;
  const title = clean(value.title || value.name);
  const match = title.match(/\bS\d{1,3}E\d{1,3}\b\s*(?:[-:–—]\s*)?(.*)$/i);
  return clean(match?.[1]);
}

function stripCompoundMarker(title, marker) {
  let result = clean(title);
  if (marker === "combined") {
    result = result.replace(/,?\s*(?:\bparts?\s*(?:one|1)\s*(?:and|&|\+|\/)\s*(?:two|2)\b|[\(\[]\s*(?:parts?\s*)?(?:one|1)\s*(?:and|&|\+|\/)\s*(?:two|2)\s*[\)\]])\s*$/i, "");
  } else {
    result = result.replace(/(?:\s*[-:–—,])?\s*(?:[\(\[]\s*(?:part|pt)?\.?\s*(?:one|two|1|2)\s*[\)\]]|\b(?:part|pt)\.?\s*(?:one|two|1|2)\b)\s*$/i, "");
  }
  return clean(result).replace(/[,:;\-–—]+\s*$/, "").trim();
}

export function parseCompoundTitle(title) {
  const value = clean(title);
  if (!value) return null;
  if (COMBINED_MARKER_RE.test(value)) {
    return { kind: "combined", part: null, baseTitle: stripCompoundMarker(value, "combined") };
  }
  const match = value.match(EPISODE_MARKER_RE);
  if (!match) return null;
  const token = String(match[1] || match[2] || "").toLowerCase();
  return {
    kind: "split",
    part: token === "1" || token === "one" ? 1 : 2,
    baseTitle: stripCompoundMarker(value, "split"),
  };
}

function getSeasonEpisodesFromDb({ tvdbId, tmdbId, showTitle, season } = {}) {
  if (!db || season == null) return [];
  try {
    let resolvedTvdbId = tvdbId;
    let resolvedTmdbId = tmdbId;
    if (!resolvedTvdbId && !resolvedTmdbId && showTitle) {
      const idRow = db.prepare("SELECT tvdb_id, tmdb_id FROM watch_history WHERE show_title = ? AND (tvdb_id IS NOT NULL OR tmdb_id IS NOT NULL) LIMIT 1").get(showTitle);
      if (idRow) {
        resolvedTvdbId = idRow.tvdb_id;
        resolvedTmdbId = idRow.tmdb_id;
      }
    }
    if (resolvedTvdbId) {
      const row = db.prepare("SELECT details FROM tvdb_season_cache WHERE (tvdb_id = ? OR id = ?) AND season_number = ?").get(String(resolvedTvdbId), `${resolvedTvdbId}_${season}`, Number(season));
      if (row?.details) {
        const details = parseJson(row.details);
        if (Array.isArray(details?.episodes)) return details.episodes;
      }
    }
    if (resolvedTmdbId) {
      const row = db.prepare("SELECT details FROM tmdb_season_cache WHERE tmdb_id = ? AND season_number = ?").get(String(resolvedTmdbId), Number(season));
      if (row?.details) {
        const details = parseJson(row.details);
        if (Array.isArray(details?.episodes)) return details.episodes;
      }
    }
  } catch {
    // Database may be inaccessible in isolated test contexts
  }
  return [];
}

export function findCompoundEpisodesFromSeason(episodes = [], { season = null, showKey = "" } = {}) {
  const parsed = [];
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    const episodeNum = numberOrNull(ep.episode_number ?? ep.episode ?? ep.number ?? ep.index);
    const title = clean(ep.name || ep.title || ep.episode_title);
    if (episodeNum == null || !title) continue;
    const marker = parseCompoundTitle(title);
    parsed.push({
      episode: episodeNum,
      title,
      baseTitle: marker?.baseTitle || title,
      marker,
    });
  }

  parsed.sort((a, b) => a.episode - b.episode);

  const descriptors = [];
  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i];

    if (current.marker?.kind === "combined") {
      const canonicalEpisode = current.episode;
      descriptors.push({
        key: `${showKey}:${season}:${canonicalText(current.baseTitle)}`,
        showKey,
        season,
        canonicalEpisode,
        aliases: [
          { season, episode: canonicalEpisode },
          { season, episode: canonicalEpisode + 1 },
        ],
        title: current.baseTitle,
        hasCombinedEvidence: true,
        canonicalSourceCoordinate: { season, episode: canonicalEpisode },
        canonicalSourceIsCombined: true,
      });
      continue;
    }

    if (current.marker?.kind === "split" && current.marker.part === 1) {
      const partTwo = parsed.find((other) => (
        other.episode > current.episode
        && other.marker?.kind === "split"
        && other.marker?.part === 2
        && canonicalText(other.baseTitle) === canonicalText(current.baseTitle)
      )) || parsed.find((other) => (
        other.episode === current.episode + 1
        && canonicalText(other.baseTitle) === canonicalText(current.baseTitle)
      ));

      if (partTwo) {
        const canonicalEpisode = current.episode;
        descriptors.push({
          key: `${showKey}:${season}:${canonicalText(current.baseTitle)}`,
          showKey,
          season,
          canonicalEpisode,
          aliases: [
            { season, episode: canonicalEpisode },
            { season, episode: partTwo.episode },
          ],
          title: current.baseTitle,
          hasCombinedEvidence: true,
          canonicalSourceCoordinate: { season, episode: canonicalEpisode },
          canonicalSourceIsCombined: true,
        });
      }
    } else if (!current.marker && current.baseTitle) {
      const partTwo = parsed.find((other) => (
        other.episode === current.episode + 1
        && other.marker?.kind === "split"
        && other.marker?.part === 2
        && canonicalText(other.baseTitle) === canonicalText(current.baseTitle)
      ));
      if (partTwo) {
        const canonicalEpisode = current.episode;
        descriptors.push({
          key: `${showKey}:${season}:${canonicalText(current.baseTitle)}`,
          showKey,
          season,
          canonicalEpisode,
          aliases: [
            { season, episode: canonicalEpisode },
            { season, episode: partTwo.episode },
          ],
          title: current.baseTitle,
          hasCombinedEvidence: true,
          canonicalSourceCoordinate: { season, episode: canonicalEpisode },
          canonicalSourceIsCombined: true,
        });
      }
    }
  }

  return descriptors;
}

function rowDetails(row = {}) {
  const coordinates = coordinatesFrom(row);
  const title = episodeTitleFrom(row);
  const marker = parseCompoundTitle(title);
  const showKey = canonicalText(showTitleFrom(row));
  const baseTitle = marker?.baseTitle || title;
  if (!showKey || coordinates.season == null || coordinates.episode == null || !canonicalText(baseTitle)) return null;
  return {
    row,
    showKey,
    season: coordinates.season,
    episode: coordinates.episode,
    title,
    baseTitle,
    marker,
  };
}

function groupKey(detail) {
  return `${detail.showKey}:${detail.season}:${canonicalText(detail.baseTitle)}`;
}

function sourceLooksLikeTracker(row = {}) {
  return Boolean(trackerProviderForSource(row.source));
}

function coordinateKey(season, episode) {
  return `${Number(season)}:${Number(episode)}`;
}

function descriptorForGroup(details = []) {
  if (!details.length) return null;
  const combined = details.find((detail) => detail.marker?.kind === "combined");
  const split = details.filter((detail) => detail.marker?.kind === "split");
  if (!combined && !split.length) return null;

  const plain = details.filter((detail) => !detail.marker || detail.marker.kind === "plain");
  const trackerPlain = plain.find((detail) => sourceLooksLikeTracker(detail.row));
  const trackerCompound = [...details]
    .filter((detail) => sourceLooksLikeTracker(detail.row))
    .sort((left, right) => Number(right.marker?.kind === "combined") - Number(left.marker?.kind === "combined"));

  // A tracker row with the same episode title is the best canonical
  // coordinate when the tracker combines a pair at a different number (for
  // example a local S06E21/E22 pair represented by Trakt as S06E20).
  // Otherwise use the explicit combined row, or require both split parts.
  let canonicalDetail = trackerPlain || (combined && (trackerCompound[0] || combined));
  if (!canonicalDetail && split.length) {
    const partOne = split.filter((detail) => detail.marker.part === 1).sort((left, right) => left.episode - right.episode)[0];
    const partTwo = split.filter((detail) => detail.marker.part === 2).sort((left, right) => left.episode - right.episode)[0];
    if (partOne && partTwo) canonicalDetail = partOne;
    else if (plain.length) canonicalDetail = plain.sort((left, right) => left.episode - right.episode)[0];
  }
  if (!canonicalDetail) return null;

  const canonicalEpisode = canonicalDetail.episode;
  if (!Number.isInteger(canonicalEpisode) || canonicalEpisode < 0) return null;

  const aliases = new Set([coordinateKey(details[0].season, canonicalEpisode)]);
  for (const detail of details) aliases.add(coordinateKey(detail.season, detail.episode));
  // An explicit "Parts One and Two" entry is strong evidence that the next
  // coordinate is the split representation, even when that second row is not
  // present in this particular import.
  if (combined) aliases.add(coordinateKey(combined.season, combined.episode + 1));

  return {
    key: groupKey(details[0]),
    showKey: details[0].showKey,
    season: details[0].season,
    canonicalEpisode,
    aliases: [...aliases].map((value) => {
      const [season, episode] = value.split(":").map(Number);
      return { season, episode };
    }).sort((left, right) => left.episode - right.episode),
    title: combined?.marker.baseTitle || split[0]?.marker.baseTitle || plain[0]?.baseTitle || "",
    hasCombinedEvidence: Boolean(combined),
    canonicalSourceCoordinate: { season: canonicalDetail.season, episode: canonicalDetail.episode },
    canonicalSourceIsCombined: Boolean(combined || trackerPlain),
  };
}

function descriptorScore(descriptor, detail) {
  const coordinate = coordinateKey(detail.season, detail.episode);
  const isCanonical = coordinate === coordinateKey(descriptor.season, descriptor.canonicalEpisode);
  const isExplicit = detail.marker?.kind === "combined" || detail.marker?.kind === "split";
  return (isCanonical ? 100 : 0) + (isExplicit ? 20 : 0) + (descriptor.hasCombinedEvidence ? 1 : 0);
}

// Build a map from metadata that explicitly says "part 1", "part 2", or
// "parts one and two", or from season metadata matching (1) and (2) with the same name.
export function buildCompoundEpisodeIndex(rows = [], { seasonEpisodesResolver = null } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.media_type || row?.mediaType || row?.type || "").toLowerCase() !== "episode") continue;
    const detail = rowDetails(row);
    if (!detail) continue;
    const key = groupKey(detail);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(detail);
  }

  const coordinateMap = new Map();
  for (const details of groups.values()) {
    const descriptor = descriptorForGroup(details);
    if (!descriptor) continue;
    for (const detail of details) {
      const key = `${descriptor.showKey}:${detail.season}:${detail.episode}`;
      const isCanonicalSource = detail.season === descriptor.canonicalSourceCoordinate.season
        && detail.episode === descriptor.canonicalSourceCoordinate.episode;
      const candidate = {
        ...descriptor,
        sourceRepresentation: detail.marker?.kind === "combined" || (isCanonicalSource && descriptor.canonicalSourceIsCombined)
          ? "combined"
          : "split",
        sourceCoordinate: { season: detail.season, episode: detail.episode },
      };
      const previous = coordinateMap.get(key);
      if (!previous || descriptorScore(candidate, detail) > descriptorScore(previous, detail)) {
        coordinateMap.set(key, candidate);
      }
    }
    // Add inferred aliases that are not represented by a row in this import.
    // They have no source marker, so they are deliberately treated as split
    // coordinates when a target catalogue is queried.
    for (const alias of descriptor.aliases) {
      const key = `${descriptor.showKey}:${alias.season}:${alias.episode}`;
      if (coordinateMap.has(key)) continue;
      coordinateMap.set(key, {
        ...descriptor,
        sourceRepresentation: alias.season === descriptor.canonicalSourceCoordinate.season
          && alias.episode === descriptor.canonicalSourceCoordinate.episode
          && descriptor.canonicalSourceIsCombined ? "combined" : "split",
        sourceCoordinate: alias,
      });
    }
  }

  // For shows and seasons represented in rows, also discover compound episodes
  // from season metadata (tvdb_season_cache / tmdb_season_cache or seasonEpisodesResolver).
  const inspectedSeasons = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.media_type || row?.mediaType || row?.type || "").toLowerCase() !== "episode") continue;
    const showKey = canonicalText(showTitleFrom(row));
    const coords = coordinatesFrom(row);
    if (!showKey || coords.season == null) continue;
    const seasonKey = `${showKey}:${coords.season}`;
    if (inspectedSeasons.has(seasonKey)) continue;
    inspectedSeasons.add(seasonKey);

    const tvdbId = row.tvdb_id || row.tvdbId || row.ids?.tvdb;
    const tmdbId = row.tmdb_id || row.tmdbId || row.ids?.tmdb;
    const showTitle = showTitleFrom(row);
    const seasonEpisodes = seasonEpisodesResolver
      ? seasonEpisodesResolver({ tvdbId, tmdbId, showTitle, season: coords.season })
      : getSeasonEpisodesFromDb({ tvdbId, tmdbId, showTitle, season: coords.season });

    if (Array.isArray(seasonEpisodes) && seasonEpisodes.length) {
      const seasonDescriptors = findCompoundEpisodesFromSeason(seasonEpisodes, { season: coords.season, showKey });
      for (const descriptor of seasonDescriptors) {
        for (const alias of descriptor.aliases) {
          const key = `${descriptor.showKey}:${alias.season}:${alias.episode}`;
          if (coordinateMap.has(key)) continue;
          coordinateMap.set(key, {
            ...descriptor,
            sourceRepresentation: alias.season === descriptor.canonicalSourceCoordinate.season
              && alias.episode === descriptor.canonicalSourceCoordinate.episode
              && descriptor.canonicalSourceIsCombined ? "combined" : "split",
            sourceCoordinate: alias,
          });
        }
      }
    }
  }

  return coordinateMap;
}

export function compoundEpisodeForRow(row = {}, index = null, options = {}) {
  const coordinates = coordinatesFrom(row);
  const showKey = canonicalText(showTitleFrom(row));
  if (coordinates.season == null || coordinates.episode == null || !showKey) return null;
  const resolvedIndex = index || buildCompoundEpisodeIndex([row], options);
  return resolvedIndex.get(`${showKey}:${coordinates.season}:${coordinates.episode}`) || null;
}

function suppliedDescriptor(media = {}) {
  const supplied = media.compound_episode || media.compoundEpisode
    || (media.canonicalEpisode != null && Array.isArray(media.aliases) ? media : null);
  if (!supplied?.canonicalEpisode && supplied?.canonical?.episode == null) return null;
  const coordinates = coordinatesFrom(media);
  const canonicalEpisode = numberOrNull(supplied.canonicalEpisode ?? supplied.canonical?.episode);
  const season = numberOrNull(supplied.season ?? supplied.canonical?.season ?? coordinates.season);
  if (season == null || canonicalEpisode == null) return null;
  const aliases = Array.isArray(supplied.aliases) ? supplied.aliases : [];
  const normalizedAliases = aliases
    .map((alias) => ({ season: numberOrNull(alias?.season), episode: numberOrNull(alias?.episode) }))
    .filter((alias) => alias.season != null && alias.episode != null);
  if (!normalizedAliases.some((alias) => alias.season === season && alias.episode === canonicalEpisode)) {
    normalizedAliases.push({ season, episode: canonicalEpisode });
  }
  return {
    ...supplied,
    season,
    canonicalEpisode,
    aliases: normalizedAliases,
    sourceRepresentation: supplied.sourceRepresentation === "combined" ? "combined" : "split",
    sourceCoordinate: supplied.sourceCoordinate || coordinates,
  };
}

export function compoundEpisodeForMedia(media = {}, { seasonEpisodesResolver = null } = {}) {
  const supplied = suppliedDescriptor(media);
  if (supplied) return supplied;
  if (String(media.type || media.mediaType || media.media_type || "").toLowerCase() !== "episode") return null;
  const coordinates = coordinatesFrom(media);
  if (coordinates.season == null || coordinates.episode == null) return null;
  const showKey = canonicalText(showTitleFrom(media));
  if (!showKey) return null;

  const marker = parseCompoundTitle(episodeTitleFrom(media));
  if (marker) {
    const canonicalEpisode = marker.kind === "combined"
      ? coordinates.episode
      : marker.part === 2 ? coordinates.episode - 1 : coordinates.episode;
    if (canonicalEpisode >= 0) {
      const aliases = [{ season: coordinates.season, episode: canonicalEpisode }];
      if (marker.kind === "combined" || marker.part === 1) aliases.push({ season: coordinates.season, episode: canonicalEpisode + 1 });
      if (marker.kind === "split" && marker.part === 2) aliases.push({ season: coordinates.season, episode: coordinates.episode });
      return {
        key: `${showKey}:${coordinates.season}:${canonicalText(marker.baseTitle)}`,
        showKey,
        season: coordinates.season,
        canonicalEpisode,
        aliases,
        title: marker.baseTitle,
        hasCombinedEvidence: marker.kind === "combined",
        sourceRepresentation: marker.kind === "combined" ? "combined" : "split",
        sourceCoordinate: coordinates,
      };
    }
  }

  // If the media object lacked explicit (1)/(2) markers in its title, check season metadata
  const tvdbId = media.ids?.tvdb || media.tvdb_id || media.tvdbId;
  const tmdbId = media.ids?.tmdb || media.tmdb_id || media.tmdbId;
  const showTitle = showTitleFrom(media);
  const seasonEpisodes = seasonEpisodesResolver
    ? seasonEpisodesResolver({ tvdbId, tmdbId, showTitle, season: coordinates.season })
    : getSeasonEpisodesFromDb({ tvdbId, tmdbId, showTitle, season: coordinates.season });

  if (Array.isArray(seasonEpisodes) && seasonEpisodes.length) {
    const descriptors = findCompoundEpisodesFromSeason(seasonEpisodes, { season: coordinates.season, showKey });
    for (const descriptor of descriptors) {
      const match = descriptor.aliases.find((a) => a.season === coordinates.season && a.episode === coordinates.episode);
      if (match) {
        return {
          ...descriptor,
          sourceRepresentation: match.season === descriptor.canonicalSourceCoordinate.season
            && match.episode === descriptor.canonicalSourceCoordinate.episode
            && descriptor.canonicalSourceIsCombined ? "combined" : "split",
          sourceCoordinate: coordinates,
        };
      }
    }
  }

  return null;
}

export function compoundEpisodeItemsForMedia(episodesByCoordinate, media = {}) {
  const descriptor = compoundEpisodeForMedia(media);
  const parsedCoordinates = coordinatesFrom(media);
  const coordinates = parsedCoordinates.season != null && parsedCoordinates.episode != null
    ? parsedCoordinates
    : descriptor?.sourceCoordinate || {
      season: descriptor?.season,
      episode: descriptor?.canonicalEpisode,
    };
  if (coordinates.season == null || coordinates.episode == null) return [];
  const keyFor = (coordinate) => `${Number(coordinate.season)}:${Number(coordinate.episode)}`;
  const exact = episodesByCoordinate?.get?.(keyFor(coordinates)) || [];
  if (exact.length) {
    if (descriptor?.sourceRepresentation !== "combined") return exact;
    const all = [];
    for (const alias of descriptor.aliases) {
      for (const item of episodesByCoordinate.get(keyFor(alias)) || []) {
        if (!all.includes(item)) all.push(item);
      }
    }
    return all;
  }
  if (descriptor && descriptor.canonicalEpisode !== coordinates.episode) {
    return episodesByCoordinate?.get?.(keyFor({ season: descriptor.season, episode: descriptor.canonicalEpisode })) || [];
  }
  return [];
}

export function canonicalCompoundEpisodeMedia(media = {}, options = {}) {
  const descriptor = compoundEpisodeForMedia(media, options);
  if (!descriptor) return media;
  const coordinates = coordinatesFrom(media);
  if (coordinates.season === descriptor.season && coordinates.episode === descriptor.canonicalEpisode) {
    return { ...media, compound_episode: descriptor };
  }
  return {
    ...media,
    season: descriptor.season,
    episode: descriptor.canonicalEpisode,
    compound_episode: descriptor,
  };
}

export function canonicalizeCompoundEpisodeRows(rows = [], {
  sessionWindowMs = COMPOUND_SESSION_WINDOW_MS,
  seasonEpisodesResolver = null,
} = {}) {
  const index = buildCompoundEpisodeIndex(rows, { seasonEpisodesResolver });
  let mapped = 0;
  const projected = (Array.isArray(rows) ? rows : []).map((row) => {
    if (String(row?.media_type || row?.mediaType || row?.type || "").toLowerCase() !== "episode") return row;
    const coordinates = coordinatesFrom(row);
    const showKey = canonicalText(showTitleFrom(row));
    const descriptor = index.get(`${showKey}:${coordinates.season}:${coordinates.episode}`);
    if (!descriptor) return row;
    const sourceCoordinate = { season: coordinates.season, episode: coordinates.episode };
    const next = {
      ...row,
      season: descriptor.season,
      episode: descriptor.canonicalEpisode,
      compound_episode: {
        ...descriptor,
        sourceRepresentation: descriptor.sourceRepresentation,
        sourceCoordinate,
      },
      compound_source_season: sourceCoordinate.season,
      compound_source_episode: sourceCoordinate.episode,
    };
    if (sourceCoordinate.episode !== descriptor.canonicalEpisode) mapped += 1;
    return next;
  });

  // Trakt records plays against one logical episode. If both split parts were
  // watched in one session, retain the earliest timestamp as that one play;
  // separate rewatches (outside the window) remain separate history events.
  const kept = [];
  let collapsed = 0;
  for (const row of projected) {
    const mapping = row.compound_episode;
    if (!mapping || row.compound_source_episode == null) {
      kept.push(row);
      continue;
    }
    const currentTime = Date.parse(String(row.watched_at || ""));
    const previous = [...kept].reverse().find((candidate) => (
      candidate.compound_episode?.key === mapping.key
      && candidate.compound_source_episode !== row.compound_source_episode
    ));
    const previousTime = Date.parse(String(previous?.watched_at || ""));
    if (previous && Number.isFinite(currentTime) && Number.isFinite(previousTime)
      && Math.abs(currentTime - previousTime) <= Math.max(0, Number(sessionWindowMs) || 0)) {
      collapsed += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, index, mapped, collapsed };
}
