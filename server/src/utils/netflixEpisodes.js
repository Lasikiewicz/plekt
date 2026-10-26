import { titleKey, parseNetflixEpisodePart } from "./netflixCsv.js";

function seasonNumberOf(season = {}) {
  return Number(season.season ?? season.season_number);
}

function shapeEpisode(season, episode) {
  return {
    ...episode,
    season_number: seasonNumberOf(season),
    episode_number: Number(episode.episode_number),
    media_type: "episode",
  };
}

export function episodesInLists(lists = []) {
  return lists.flatMap((season) => (season.episodes || []).map((episode) => shapeEpisode(season, episode)));
}

function preferSeason(candidates, seasonHint) {
  if (seasonHint == null || !candidates.length) return candidates;
  return candidates.filter((episode) => Number(episode.season_number) === Number(seasonHint));
}

// Try title boundaries without assuming every colon belongs to the episode.
export function episodeInterpretations(title) {
  const parts = [];
  for (let index = title.indexOf(":"); index > 0; index = title.indexOf(":", index + 1)) {
    const showTitle = title.slice(0, index).trim();
    const parsed = parseNetflixEpisodePart(title.slice(index + 1), { showTitle });
    if (!parsed.episodeTitle) continue;
    parts.push({ showTitle, ...parsed });
    // Everything after an explicit season label belongs to the episode.
    if (/^(?:\s*(?:(?:Season|Series|Staffel|Saison|Temporada|Stagione|Seizoen|Säsong|Sæson|Sesong|Sezon|Kausi)\s+\d+(?:\s*[–-]\s*[^:]+)?|Limited Series)|\s{2,}\d{1,3}(?=:\s))\s*:/i.test(title.slice(index + 1))) break;
  }
  return parts;
}

export function evidenceKey(part) {
  return `${part.seasonHint ?? ""}|${titleKey(part.episodeTitle)}`;
}

export async function resolveShowEvidence(parts, candidates, seasons) {
  // Rewatches must not inflate confidence. Generic Episode N labels do not
  // identify a show, so they cannot establish its identity.
  const distinct = [...new Map(parts.filter((part) => part.episodeHint == null)
    .map((part) => [evidenceKey(part), part])).values()];
  if (distinct.length < 2) return null;
  const scored = [];
  for (const candidate of candidates) {
    const lists = await seasons(String(candidate.id));
    const index = new Map();
    for (const episode of episodesInLists(lists)) {
      const key = episodeTitleKey(episode.name);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(episode);
    }
    const matchedEpisodes = new Set();
    for (const part of distinct) {
      const indexed = preferSeason(index.get(episodeTitleKey(part.episodeTitle)) || [], part.seasonHint);
      const episodes = indexed.length ? (indexed.length === 1 ? indexed : []) : rowEpisodes(lists, part).episodes || [];
      for (const episode of episodes) matchedEpisodes.add(`${episode.season_number}:${episode.episode_number}`);
    }
    const hits = matchedEpisodes.size;
    scored.push({ candidate, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || Number(b.candidate.popularity || 0) - Number(a.candidate.popularity || 0));
  const [best, runner] = scored;
  const second = runner?.hits || 0;
  if (!best || best.hits < 2 || best.hits - second < 2 || best.hits < second * 1.5) return null;
  return { ...best, runnerUpHits: second, distinctEpisodes: distinct.length };
}

// Netflix's own episode number narrows several title matches to one, never more.
function preferNumber(candidates, numberHint) {
  if (numberHint == null || candidates.length < 2) return candidates;
  const numbered = candidates.filter((episode) => Number(episode.episode_number) === Number(numberHint));
  return numbered.length === 1 ? numbered : candidates;
}

function episodeCandidates(lists = [], title, { seasonHint = null, episodeHint = null, numberHint = null } = {}) {
  return preferNumber(titleEpisodeCandidates(lists, title, { seasonHint, episodeHint }), numberHint);
}

function titleEpisodeCandidates(lists = [], title, { seasonHint = null, episodeHint = null } = {}) {
  const all = preferSeason(episodesInLists(lists), seasonHint);
  if (episodeHint != null) {
    const byNumber = preferSeason(
      all.filter((episode) => Number(episode.episode_number) === Number(episodeHint)),
      seasonHint,
    );
    return byNumber;
  }
  const key = episodeTitleKey(title);
  const queryPart = partNumber(similarityTokens(title));
  const namesOf = (episode) => [episode.name, ...(episode.alternateTitles || [])]
    .filter((name) => { const candidatePart = partNumber(similarityTokens(name));
      return !queryPart || !candidatePart || queryPart === candidatePart; })
    .flatMap((name) => softEpisodeKeys(name));
  const exact = all.filter((episode) => [episode.name, ...(episode.alternateTitles || [])].map(episodeTitleKey).includes(key));
  if (exact.length) return exact;
  // Near-miss titles (hyphen drift, trailing plural s, trailing (I)/(2)) only count
  // when exactly one episode in the hinted season soft-matches; otherwise keep all hits.
  const queryKeys = new Set(softEpisodeKeys(title));
  const soft = all.filter((episode) => namesOf(episode).some((name) => queryKeys.has(name)));
  if (soft.length) return soft;
  // Anthology season labels and series subtitles can precede the actual title.
  // Try suffixes only after a full-title miss, and retain all competing hits.
  const suffixes = String(title).split(":").slice(1).map((_, index, parts) => episodeTitleKey(parts.slice(index).join(":"))).filter(Boolean);
  return all.filter((episode) => [episode.name, ...(episode.alternateTitles || [])].map(episodeTitleKey).some((name) => suffixes.includes(name)));
}

// Netflix bundles short segments into one row ("Pups Make a Splash / Pups Fall
// Festival") where TMDB lists each segment as its own episode. Every segment was
// watched, so record them all, but only when each one names exactly one episode.
function compoundEpisodeMatches(lists = [], title, { seasonHint = null, showTitle = "" } = {}) {
  const segments = String(title).split(/\s*\/\s*/).filter(Boolean);
  if (segments.length < 2) return null;
  const found = [];
  for (const segment of segments) {
    let matches = episodeCandidates(lists, segment, { seasonHint });
    if (!matches.length) {
      const key = compoundSegmentKey(segment, showTitle);
      if (key) matches = preferSeason(episodesInLists(lists), seasonHint).filter((episode) =>
        [episode.name, ...(episode.alternateTitles || [])].some((name) => compoundSegmentKey(name, showTitle) === key));
    }
    if (matches.length !== 1) return null;
    found.push(matches[0]);
  }
  return new Set(found.map((episode) => `${episode.season_number}:${episode.episode_number}`)).size === found.length ? found : null;
}

// Compound segments and looseEpisodeMatch use this fallback. Keep word order and every
// meaningful word (including part numbers); remove the known show's prefix and filler.
// Grandad/granddad are alternate spellings (Netflix's Peppa Pig bundle vs TMDB).
function compoundSegmentKey(title, showTitle) {
  let words = episodeTitleKey(String(title).replace(/&/g, " and ")).split(" ").filter(Boolean)
    .map((word) => (word === "pt" ? "part" : word === "grandad" ? "granddad" : word));
  const prefix = episodeTitleKey(showTitle).split(" ").filter(Boolean);
  if (words[0] === "the" && prefix[0] !== "the") words = words.slice(1);
  if (prefix.length && prefix.every((word, index) => words[index] === word)) {
    words = words.slice(prefix.length);
    if (words[0] === "s") words = words.slice(1);
  }
  return words.filter((word) => !["the", "a", "an", "and", "of"].includes(word)).join(" ");
}

// Your decision, 24 October 2026 (kids' episode misses): a single title with no exact hit
// may still name one episode. In order: one loose-key hit in the labelled season (leading
// article, filler, Pt./Part, &/and, show prefix); else, when nothing in the labelled season
// matches, the show's only loose hit if it is a season 0 special; else, for a labelled
// season TMDB has, the show's only exact and only loose hit in another season (Netflix
// reshuffles Dora's seasons). crossSeason marks the last two so they never seed gap fill.
export function looseEpisodeMatch(lists, { episodeTitle, showTitle = "", seasonHint = null } = {}) {
  const key = compoundSegmentKey(episodeTitle, showTitle);
  if (!key) return null;
  const all = episodesInLists(lists);
  const namesOf = (episode) => [episode.name, ...(episode.alternateTitles || [])];
  const looseHits = (episodes) => episodes.filter((episode) => namesOf(episode).some((name) => compoundSegmentKey(name, showTitle) === key));
  const labelled = seasonHint == null ? [] : all.filter((episode) => episode.season_number === Number(seasonHint));
  if (seasonHint != null) {
    const inSeason = looseHits(labelled);
    if (inSeason.length === 1) return { episode: inSeason[0], crossSeason: false };
    if (inSeason.length) return null;
  }
  const showWide = looseHits(all);
  if (showWide.length !== 1) return null;
  const [episode] = showWide;
  if (episode.season_number === 0) return { episode, crossSeason: true };
  const exact = exactEpisodeHits(all, episodeTitle);
  return labelled.length && exact.length === 1 && exact[0] === episode ? { episode, crossSeason: true } : null;
}

// One exact episode, or every segment of a compound row; otherwise null.
export function rowEpisodes(lists, part) {
  const matches = episodeCandidates(lists, part.episodeTitle, part);
  if (matches.length) return { episodes: matches.length === 1 ? matches : null, matches };
  const compound = compoundEpisodeMatches(lists, part.episodeTitle, part);
  if (compound) return { episodes: compound, matches };
  const reordered = reorderedBundleMatch(lists, part);
  if (reordered) return { episodes: [reordered], matches };
  if (String(part.episodeTitle).includes("/")) return { episodes: null, matches };
  const agreed = mergedEpisodeMatch(lists, part) || numberedEpisodeMatch(lists, part);
  return { episodes: agreed ? [agreed] : null, matches };
}

// A provider may store the same complete bundle in the opposite segment order.
// Match only a unique whole episode with exactly the same distinct segment keys.
function reorderedBundleMatch(lists, { episodeTitle, showTitle, seasonHint }) {
  const keys = (title) => String(title).split(/\s*\/\s*/).map((segment) => compoundSegmentKey(segment, showTitle));
  const source = keys(episodeTitle);
  if (source.length < 2 || source.some((key) => !key) || new Set(source).size !== source.length) return null;
  const sorted = [...source].sort().join("|");
  const found = preferSeason(episodesInLists(lists), seasonHint).filter((episode) =>
    [episode.name, ...(episode.alternateTitles || [])].some((name) => {
      const target = keys(name);
      return target.length === source.length && new Set(target).size === target.length && target.sort().join("|") === sorted;
    }));
  return found.length === 1 ? found[0] : null;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function similarityTokens(value = "") {
  return episodeTitleKey(String(value).replace(/^\s*\d+\.\s+/, ""))
    .split(" ").filter(Boolean).map((word) => (word === "pt" ? "part" : String(NUMBER_WORDS[word] ?? word)));
}

const FILLER_WORDS = new Set(["the", "a", "an", "and", "of", "s"]);

function partNumber(tokens) {
  const index = tokens.indexOf("part");
  return index >= 0 && /^\d+$/.test(tokens[index + 1] || "") ? tokens[index + 1] : null;
}

// Words repeated across a season's names ("Horrid Henry ...") and filler words say
// nothing about which episode it is, so they do not count towards agreement.
function titleSimilarity(a, b, common = new Set()) {
  const leftTokens = similarityTokens(a);
  const rightTokens = similarityTokens(b);
  const leftPart = partNumber(leftTokens);
  const rightPart = partNumber(rightTokens);
  if (leftPart && rightPart && leftPart !== rightPart) return 0;
  const useful = (word) => !FILLER_WORDS.has(word) && !common.has(word);
  const left = new Set(leftTokens.filter(useful));
  const right = new Set(rightTokens.filter(useful));
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return (2 * shared) / (left.size + right.size);
}

// TMDB sometimes merges two Netflix episodes into one ("The Change Constant / The
// Stockholm Syndrome"). A row naming exactly one segment of one episode in its season is it.
function mergedEpisodeMatch(lists, { episodeTitle, seasonHint = null } = {}) {
  const key = episodeTitleKey(episodeTitle);
  if (!key) return null;
  const hits = preferSeason(episodesInLists(lists), seasonHint).filter((episode) => String(episode.name || "").includes("/")
    && String(episode.name).split(/\s*\/\s*/).some((segment) => episodeTitleKey(segment) === key));
  return hits.length === 1 ? hits[0] : null;
}

// Netflix's season label and its own episode number name one TMDB episode. Accept it only
// when the names also agree (retitles, "Pt. 2" vs "(2)", spelling drift) or TMDB has no
// real name for it; renumbered seasons ("#3" that TMDB lists as E2) stay in review.
function numberedEpisodeMatch(lists, { episodeTitle, seasonHint = null, numberHint = null } = {}) {
  if (seasonHint == null || numberHint == null) return null;
  const season = episodesInLists(lists).filter((entry) => Number(entry.season_number) === Number(seasonHint));
  const episode = season.find((entry) => Number(entry.episode_number) === Number(numberHint));
  if (!episode) return null;
  const names = [episode.name, ...(episode.alternateTitles || [])].filter(Boolean);
  const unnamed = !names.length || names.every((name) => /^(?:episode|chapter)\s+\d+$/i.test(String(name).trim()));
  if (unnamed) return episode;
  const frequency = new Map();
  for (const entry of season) for (const word of new Set(similarityTokens(entry.name))) frequency.set(word, (frequency.get(word) || 0) + 1);
  const common = new Set(season.length >= 4 ? [...frequency].filter(([, count]) => count > season.length / 3).map(([word]) => word) : []);
  if (names.some((name) => titleSimilarity(episodeTitle, name, common) >= 0.5)) return episode;
  return null;
}

function exactEpisodeHits(episodes, title) {
  const key = episodeTitleKey(title);
  return key ? episodes.filter((episode) => [episode.name, ...(episode.alternateTitles || [])].map(episodeTitleKey).includes(key)) : [];
}

// Netflix renumbers some seasons (Mako Mermaids' Netflix season 4 is TMDB season 3). A
// Netflix season maps to one other TMDB season only when at least three of its titles each
// name exactly one TMDB episode across the show, all in that season, and none of its
// titles names an episode in the labelled season.
export function learnedNetflixSeason(rows, showTitle, seasonHint, lists) {
  if (seasonHint == null) return null;
  const all = episodesInLists(lists);
  const titles = new Map();
  for (const row of rows) {
    if (!String(row.title || "").startsWith(`${showTitle}:`)) continue;
    const part = parseNetflixEpisodePart(row.title.slice(showTitle.length + 1), { showTitle });
    if (part.seasonHint === seasonHint && part.episodeHint == null) titles.set(episodeTitleKey(part.episodeTitle), part.episodeTitle);
  }
  const seasons = new Set();
  let agreeing = 0;
  for (const title of titles.values()) {
    const segments = String(title).split(/\s*\/\s*/).filter(Boolean);
    const hits = segments.map((segment) => exactEpisodeHits(all, segment));
    if (hits.some((found) => found.some((episode) => episode.season_number === Number(seasonHint)))) return null;
    if (hits.every((found) => found.length === 1)) {
      for (const [episode] of hits) seasons.add(episode.season_number);
      agreeing += 1;
    }
  }
  if (agreeing < 3 || seasons.size !== 1) return null;
  const [season] = seasons;
  return season === Number(seasonHint) ? null : season;
}

// Netflix omits "Season 1:" when a show's later seasons are labelled, so a bare
// "Episode N" beside labelled seasons (none of them 1) belongs to season 1.
// A named release batch is a season only when three distinct episode titles each
// identify that same provider season. Repeated watches add no evidence.
export function learnedNetflixSeasonLabel(rows, showTitle, episodeTitle, lists) {
  const separator = String(episodeTitle).indexOf(":");
  if (separator < 1) return null;
  const label = titleKey(episodeTitle.slice(0, separator));
  const titles = new Set();
  for (const row of rows) {
    if (!row.title.startsWith(`${showTitle}:`)) continue;
    const part = parseNetflixEpisodePart(row.title.slice(showTitle.length + 1), { showTitle });
    const boundary = part.episodeTitle.indexOf(":");
    if (part.seasonHint != null || boundary < 1 || titleKey(part.episodeTitle.slice(0, boundary)) !== label) continue;
    titles.add(episodeTitleKey(part.episodeTitle.slice(boundary + 1)));
  }
  const all = episodesInLists(lists);
  const seasons = new Set();
  let agreeing = 0;
  for (const title of titles) {
    const hits = exactEpisodeHits(all, title);
    if (hits.length !== 1) continue;
    seasons.add(hits[0].season_number);
    agreeing += 1;
  }
  return agreeing >= 3 && seasons.size === 1 ? [...seasons][0] : null;
}

export function impliedSeasonHint(part, labelledSeasons) {
  if (part.seasonHint != null || part.episodeHint == null || !labelledSeasons?.size) return part.seasonHint;
  return labelledSeasons.has(1) ? null : 1;
}

function episodeTitleKey(value = "") {
  return titleKey(String(value).normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[’']/g, "")
    .replace(/\s*(?:,\s*Part\s+(\d+)|\((\d+)\))\s*$/i, (_, part, number) => ` Part ${part || number}`))
    .replace(/\bpart (one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (_, word) => `part ${NUMBER_WORDS[word]}`);
}

// Soft keys for Netflix/TMDB near-misses. Exact keys still win first; these only
// auto-match when they leave a single episode in the hinted season.
function softEpisodeKeys(value = "") {
  const keys = new Set();
  const add = (raw) => {
    let key = episodeTitleKey(raw);
    if (!key) return;
    keys.add(key);
    key = key.replace(/\s+part\s+\d+$/i, "").replace(/\s+(?:i{1,3}|iv|v|vi{0,3}|ix|x|\d+)$/i, "").trim();
    if (!key) return;
    keys.add(key);
    if (key.endsWith("s") && key.length > 4) keys.add(key.slice(0, -1));
    else keys.add(`${key}s`);
    keys.add(key.replace(/\s+/g, ""));
  };
  add(value);
  add(String(value).replace(/-/g, ""));
  // "Episodes 13-16" must not shrink to "episode" and so match TMDB's "Episode 1".
  return [...keys].filter((key) => key && !/^(?:episode|chapter|part)s?$/.test(key));
}

export function episodeSuggestions(lists = [], title, showTmdbId, { seasonHint = null, episodeHint = null, numberHint = null } = {}) {
  if (episodeHint != null) {
    return preferSeason(
      episodesInLists(lists)
        .filter((episode) => Number(episode.episode_number) === Number(episodeHint))
        .map((episode) => ({ ...episode, showTmdbId, score: 1 })),
      seasonHint,
    ).slice(0, 8);
  }
  const words = new Set(titleKey(title).split(" ").filter(Boolean));
  const scored = episodesInLists(lists).map((episode) => {
    const candidateWords = new Set(titleKey(episode.name).split(" ").filter(Boolean));
    const overlap = [...words].filter((word) => candidateWords.has(word)).length;
    const inSeason = seasonHint == null || Number(episode.season_number) === Number(seasonHint);
    const seasonBonus = seasonHint != null && inSeason ? 0.15 : 0;
    const numberBonus = numberHint != null && inSeason && Number(episode.episode_number) === Number(numberHint) ? 0.4 : 0;
    const score = (overlap / Math.max(words.size, candidateWords.size, 1)) + seasonBonus + numberBonus;
    return { ...episode, showTmdbId, score };
  }).filter((episode) => episode.score >= 0.4)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

