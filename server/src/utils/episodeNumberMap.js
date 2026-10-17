// Translates one show's episode numbers between TVDB and TMDB structure.
// Stored watch rows keep the media server's numbers (every inbound path matches
// on them), so a per-show source switch translates for display and Trakt
// instead of rewriting rows. See plan/archive/metadata-provider-preference/plan.md.
//
// Inputs are season lists in the shape the season readers return:
// [{ season: 1, episodes: [{ episode_number, air_date }] }]. Season 0 (specials)
// pairs by air date only: TVDB and TMDB keep different specials lists, so their
// order and numbers mean nothing across the two.

const AIR_DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export function episodeKey(season, episode) {
  return `${Number(season)}:${Number(episode)}`;
}

function airTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

// Flattens regular seasons into one ordered list.
function orderedEpisodes(seasons = []) {
  const list = [];
  for (const season of [...seasons].sort((a, b) => Number(a.season) - Number(b.season))) {
    const number = Number(season?.season);
    if (!Number.isInteger(number) || number < 1) continue;
    const episodes = (Array.isArray(season?.episodes) ? season.episodes : [])
      .filter((episode) => Number.isInteger(Number(episode?.episode_number)) && Number(episode.episode_number) > 0)
      .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
    for (const episode of episodes) {
      list.push({ season: number, episode: Number(episode.episode_number), air: airTime(episode.air_date) });
    }
  }
  return list;
}

// Walks both ordered lists together. Episodes whose air dates agree (within a
// day) pair up. When the dates disagree, the earlier one has no partner and is
// left unmapped, so a two-part split or a missing episode does not shift every
// later pairing. Episodes with no air date on either side pair by position.
export function buildEpisodeNumberMap({ from = [], to = [] } = {}) {
  const source = orderedEpisodes(from);
  const target = orderedEpisodes(to);
  const pairs = new Map();
  const unmapped = [];
  let i = 0;
  let j = 0;
  while (i < source.length && j < target.length) {
    const a = source[i];
    const b = target[j];
    if (a.air === null || b.air === null || Math.abs(a.air - b.air) <= AIR_DATE_TOLERANCE_MS) {
      pairs.set(episodeKey(a.season, a.episode), { season: b.season, episode: b.episode });
      i += 1;
      j += 1;
    } else if (a.air < b.air) {
      unmapped.push({ season: a.season, episode: a.episode });
      i += 1;
    } else {
      j += 1;
    }
  }
  for (; i < source.length; i += 1) unmapped.push({ season: source[i].season, episode: source[i].episode });
  pairSpecials(from, to, pairs, unmapped);
  return { pairs, unmapped };
}

function specialEpisodes(seasons = []) {
  const season = (Array.isArray(seasons) ? seasons : []).find((entry) => Number(entry?.season) === 0);
  return (Array.isArray(season?.episodes) ? season.episodes : [])
    .filter((episode) => Number(episode?.episode_number) > 0)
    .map((episode) => ({ episode: Number(episode.episode_number), air: airTime(episode.air_date) }));
}

// A special pairs with the closest unused special that aired within a day.
// No air date on either side means no pair.
function pairSpecials(from, to, pairs, unmapped) {
  const targets = specialEpisodes(to).filter((item) => item.air !== null);
  const used = new Set();
  for (const special of specialEpisodes(from)) {
    let best = null;
    for (const candidate of special.air === null ? [] : targets) {
      const gap = Math.abs(candidate.air - special.air);
      if (used.has(candidate.episode) || gap > AIR_DATE_TOLERANCE_MS) continue;
      if (!best || gap < best.gap) best = { episode: candidate.episode, gap };
    }
    if (best) {
      used.add(best.episode);
      pairs.set(episodeKey(0, special.episode), { season: 0, episode: best.episode });
    } else {
      unmapped.push({ season: 0, episode: special.episode });
    }
  }
}

// Returns the translated { season, episode }, or null when the episode has no
// partner in the target structure.
export function translateEpisode(map, season, episode) {
  return map?.pairs?.get(episodeKey(season, episode)) || null;
}

// Counts how many distinct watched episodes fit each structure, so the Fix
// Match confirmation can say which numbering the stored rows already use.
export function detectRowNumbering(rowEpisodes = [], { tvdb = [], tmdb = [] } = {}) {
  const keysOf = (seasons) => new Set(orderedEpisodes(seasons).map((item) => episodeKey(item.season, item.episode)));
  const tvdbKeys = keysOf(tvdb);
  const tmdbKeys = keysOf(tmdb);
  const distinct = [...new Set(rowEpisodes
    .filter((row) => Number(row?.season) > 0)
    .map((row) => episodeKey(row.season, row.episode)))];
  const fitsTvdb = distinct.filter((key) => tvdbKeys.has(key)).length;
  const fitsTmdb = distinct.filter((key) => tmdbKeys.has(key)).length;
  let numbering = "tvdb";
  if (fitsTmdb > fitsTvdb) numbering = "tmdb";
  return { numbering, episodes: distinct.length, fitsTvdb, fitsTmdb };
}

// Plans a show switch without writing anything: which distinct watched
// episodes, specials included, translate to the target structure and which
// need review.
export function planShowTranslation(rowEpisodes = [], map) {
  const translated = [];
  const review = [];
  const seen = new Set();
  for (const row of rowEpisodes) {
    const key = episodeKey(row?.season, row?.episode);
    if (seen.has(key) || !(Number(row?.season) >= 0) || !(Number(row?.episode) > 0)) continue;
    seen.add(key);
    const target = translateEpisode(map, row.season, row.episode);
    if (target) translated.push({ from: { season: Number(row.season), episode: Number(row.episode) }, to: target });
    else review.push({ season: Number(row.season), episode: Number(row.episode) });
  }
  return { translated, review };
}
