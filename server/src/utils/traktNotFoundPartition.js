function entriesFromResult(result = {}) {
  return Object.entries(result?.not_found || {})
    .filter(([, entries]) => Array.isArray(entries))
    .flatMap(([category, entries]) => entries.map((entry) => ({ category, entry })));
}

function entryValue(entry = {}) {
  return entry?.episode || entry?.movie || entry?.show || entry?.season || entry;
}

function entryCoordinates(entry = {}) {
  const value = entryValue(entry);
  const coordinates = [];
  const add = (seasonValue, episodeValue) => {
    const season = Number(seasonValue);
    const episode = Number(episodeValue);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return;
    if (!coordinates.some((coordinate) => coordinate.season === season && coordinate.episode === episode)) {
      coordinates.push({ season, episode });
    }
  };

  // Trakt returns the grouped shape accepted by /sync/history. Also accept the
  // flatter shape used by older responses and existing callers.
  add(
    value?.season ?? value?.season_number ?? value?.seasonNumber,
    value?.number ?? value?.episode ?? value?.episode_number ?? value?.episodeNumber,
  );
  for (const seasonEntry of Array.isArray(value?.seasons) ? value.seasons : []) {
    const season = seasonEntry?.number ?? seasonEntry?.season ?? seasonEntry?.season_number ?? seasonEntry?.seasonNumber;
    for (const episodeEntry of Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : []) {
      add(season, episodeEntry?.number ?? episodeEntry?.episode ?? episodeEntry?.episode_number ?? episodeEntry?.episodeNumber);
    }
  }
  return coordinates;
}

function entryMatchesMedia(media = {}, category = "", entry = {}) {
  const value = entryValue(entry);
  const entryIds = value?.ids || entry?.ids || {};
  const mediaIds = media?.ids || {};
  const overlaps = Object.entries(entryIds).some(([provider, id]) => (
    id != null && String(id) !== "" && mediaIds[provider] != null
    && String(mediaIds[provider]).trim().toLowerCase() === String(id).trim().toLowerCase()
  ));
  if (!overlaps) return false;

  const type = media.type || media.mediaType;
  if (type === "movie") return category === "movies";
  if (type === "tv" || type === "show" || type === "series") return category === "shows";
  if (type !== "episode") return false;
  if (category === "shows") return true;
  const coordinates = entryCoordinates(entry);
  if (!coordinates.length) return true;
  return coordinates.some(({ season, episode }) => Number(media.season) === season && Number(media.episode) === episode);
}

export function partitionTraktNotFoundBatch(batch = [], result = {}) {
  const entries = entriesFromResult(result);
  if (!entries.length) return { accepted: [], rejected: [], entries };
  const rejected = batch.filter((media) => entries.some(({ category, entry }) => entryMatchesMedia(media, category, entry)));
  const unidentified = entries.some(({ category, entry }) => !batch.some((media) => entryMatchesMedia(media, category, entry)));
  return {
    accepted: unidentified ? [] : batch.filter((media) => !rejected.includes(media)),
    rejected,
    entries,
    unidentified,
  };
}
