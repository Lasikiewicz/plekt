import { titleKey, parseNetflixEpisodePart, readNetflixCsv } from "./netflixCsv.js";
import { episodesInLists, episodeInterpretations, evidenceKey, resolveShowEvidence, looseEpisodeMatch, rowEpisodes, learnedNetflixSeason, learnedNetflixSeasonLabel, impliedSeasonHint, episodeSuggestions } from "./netflixEpisodes.js";
export { NETFLIX_MIN_WATCH_SECONDS, parseNetflixDate, parseNetflixEpisodePart, netflixCsvProfiles, readNetflixCsv, parseNetflixCsv } from "./netflixCsv.js";
export { learnedNetflixSeason } from "./netflixEpisodes.js";
import { batchInsertWatchRecords, getCachedHistory, mediaKeyFor } from "./dataRepo.js";
import { searchTmdb, getTmdbDetails, getTmdbShowSeasonLists, getTmdbAlternativeTitles } from "./tmdbGateway.js";
import { getNetflixEpisodeAliases, resolveNetflixVerifiedRow } from "./netflixEpisodeAliases.js";
import { getNetflixCatalogue } from "./netflixCatalogue.js";

export const NETFLIX_SOURCE = "netflix_import";

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const ALTERNATIVE_TITLE_CANDIDATES = 5;
const previews = new Map();


async function tmdbMovieRuntime(id) {
  const details = await getTmdbDetails({ mediaType: "movie", tmdbId: String(id), light: true, lane: "sync" });
  return Number(details?.runtime) || null;
}

// A same-named show is ruled out when it lacks a season and episode number the rows
// name. Only a single survivor is returned; incomplete TMDB data leaves it in review.
async function showsWithEpisodes(candidates, references, seasons) {
  if (!references?.size || candidates.length < 2 || candidates.length > 12) return null;
  const survivors = [];
  for (const candidate of candidates) {
    const present = new Set(episodesInLists(await seasons(String(candidate.id)))
      .map((episode) => `${episode.season_number}:${episode.episode_number}`));
    if ([...references].every((reference) => present.has(reference))) survivors.push(candidate);
  }
  return survivors.length === 1 ? survivors[0] : null;
}

// Netflix's bookmark is a playback position, so a film shorter than it cannot be the
// one watched. Unknown runtimes are kept; the allowance covers cuts and rounding.
async function moviesLongEnough(candidates, bookmarkSeconds, runtime) {
  // A TMDB search page has up to 20 results. Do not skip the same hard-fact check
  // for crowded names such as Eli or The Interview merely because there are 13+.
  if (!bookmarkSeconds || candidates.length < 2 || candidates.length > 20) return candidates;
  const kept = [];
  for (const candidate of candidates) {
    const minutes = await runtime(String(candidate.id));
    if (!minutes || minutes * 60 * 1.05 + 300 >= bookmarkSeconds) kept.push(candidate);
  }
  return kept.length ? kept : candidates;
}

// Your decision, 24 October 2026 ("Netflix title + clear winner"): when no hard fact
// splits same-named titles, take the only one Netflix's reports can be, and only when
// it has at least ten times the TMDB votes of every other candidate.
const CLEAR_WINNER_VOTE_RATIO = 10;
const CLEAR_WINNER_MIN_VOTES = 50;

export function clearReportedWinner(candidates, mediaType, catalogue) {
  if (candidates.length < 2 || !catalogue.reportedCandidates) return null;
  const reported = catalogue.reportedCandidates(mediaType, candidates);
  if (reported.length !== 1) return null;
  const [winner] = reported;
  const votes = Number(winner.vote_count || 0);
  if (votes < CLEAR_WINNER_MIN_VOTES) return null;
  return candidates.every((candidate) => candidate === winner || votes >= CLEAR_WINNER_VOTE_RATIO * Number(candidate.vote_count || 0))
    ? winner : null;
}

function candidateTitle(candidate, mediaType) {
  return mediaType === "tv" ? candidate.name : candidate.title;
}

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const CARDINAL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// "&" and "and", and a trailing sequel numeral ("Ghostbusters II"), are the same title.
function exactTitleKey(value = "", normalizeCardinal = true) {
  let key = titleKey(String(value || "").replace(/&/g, " and "));
  if (normalizeCardinal) key = key.replace(/^([a-z]+)(?: ([a-z]+))?(?= )/, (full, first, second) => {
      const number = CARDINAL[first];
      if (!number) return full;
      if (number >= 20 && number % 10 === 0 && CARDINAL[second] < 10) return String(number + CARDINAL[second]);
      return `${number}${second ? ` ${second}` : ""}`;
    });
  return key.replace(/ (ii|iii|iv|v|vi|vii|viii|ix|x)$/, (_, numeral) => ` ${ROMAN[numeral]}`);
}

function exactCandidates(results = [], query, mediaType) {
  const find = (normalizeCardinal) => results.filter((candidate) => (candidate.media_type || mediaType) === mediaType
    && [candidateTitle(candidate, mediaType), mediaType === "tv" ? candidate.original_name : candidate.original_title]
      .some((title) => title && exactTitleKey(title, normalizeCardinal) === exactTitleKey(query, normalizeCardinal)));
  const literal = find(false);
  return literal.length ? literal : find(true);
}

function containsTitleWords(title, query) {
  const words = exactTitleKey(query).split(" ").filter(Boolean);
  if (!words.length) return false;
  let next = 0;
  for (const word of exactTitleKey(title).split(" ")) if (word === words[next]) next += 1;
  return next === words.length;
}

const COUNTRY_SUFFIXES = { us: "US", usa: "US", uk: "GB", au: "AU", ca: "CA", nz: "NZ", ie: "IE" };

// Netflix's "(U.S.)" or "(UK)" after a title names the country it was made in.
function countrySuffix(value = "") {
  const found = /\s*\(([a-z.]+)\)\s*$/i.exec(String(value || ""));
  const code = found && COUNTRY_SUFFIXES[found[1].replace(/\./g, "").toLowerCase()];
  return code ? { code, index: found.index } : null;
}

function candidateYear(candidate = {}) {
  return String(candidate.release_date || candidate.first_air_date || "").slice(0, 4);
}

function watchYear(watchedAt = "") {
  return String(watchedAt || "").slice(0, 4);
}

// When several TMDB titles share an exact name, prefer the one whose release/air
// year matches the Netflix watch year. Only auto-resolve when that year is unique.
export function pickByWatchYear(candidates = [], watchedAt = "") {
  const year = watchYear(watchedAt);
  if (!/^\d{4}$/.test(year) || candidates.length < 2) return null;
  const matched = candidates.filter((candidate) => candidateYear(candidate) === year);
  return matched.length === 1 ? matched[0] : null;
}

// A title first released after the watch year cannot be what was watched. Undated
// candidates are unknown, so any of them keeps the full list in place.
export function releasedByWatchYear(candidates = [], watchedAt = "") {
  const year = watchYear(watchedAt);
  if (!/^\d{4}$/.test(year) || candidates.length < 2) return candidates;
  if (candidates.some((candidate) => !/^\d{4}$/.test(candidateYear(candidate)))) return candidates;
  const released = candidates.filter((candidate) => candidateYear(candidate) <= year);
  return released.length ? released : candidates;
}

// Two matched neighbours in the same season pin the episode between them.
function fillSeasonNeighbourGaps(reviews, matchedByRow, showSeasonCache, rows, records, existing) {
  const leftover = [];
  for (const review of reviews) {
    const showId = String(review.showCandidate?.id || "");
    const season = Number(review.seasonHint);
    const prev = matchedByRow.get(review.row - 1);
    const next = matchedByRow.get(review.row + 1);
    const canFill = review.kind === "episode" && !String(review.episodeTitle || review.title).includes("/")
      && (review.reason === "no_episode_match" || review.reason === "ambiguous_episode")
      && showId && Number.isInteger(season) && season >= 0
      && prev && next
      && prev.showTmdbId === showId && next.showTmdbId === showId
      && prev.season === season && next.season === season
      && Math.abs(prev.episode - next.episode) === 2;
    if (!canFill) {
      leftover.push(review);
      continue;
    }
    const episodeNumber = (prev.episode + next.episode) / 2;
    const episode = episodesInLists(showSeasonCache.get(showId) || [])
      .find((entry) => Number(entry.season_number) === season && Number(entry.episode_number) === episodeNumber);
    if (!episode) {
      leftover.push(review);
      continue;
    }
    const row = rows[review.row];
    const record = makeRecord(row, {
      mediaType: "episode",
      tmdbId: showId,
      showTitle: prev.showTitle,
      episodeTitle: episode.name,
      season: episode.season_number,
      episode: episode.episode_number,
    });
    const key = `${mediaKeyFor(record)}|${row.watchedAt.slice(0, 10)}`;
    if (!existing.has(key)) {
      existing.add(key);
      records.push(record);
    }
    matchedByRow.set(review.row, {
      showTmdbId: showId,
      showTitle: prev.showTitle,
      season: Number(episode.season_number),
      episode: Number(episode.episode_number),
    });
  }
  return leftover;
}

function makeRecord(row, { mediaType, tmdbId, title, showTitle = "", episodeTitle = "", season = null, episode = null }) {
  return {
    title: mediaType === "episode"
      ? `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : title,
    show_title: mediaType === "episode" ? showTitle : undefined,
    episode_title: mediaType === "episode" ? episodeTitle : undefined,
    media_type: mediaType,
    watched_at: row.watchedAt,
    source: NETFLIX_SOURCE,
    tmdb_id: String(tmdbId),
    season,
    episode,
    sync_action: "watched",
    sync_intent: "import",
    watch_provenance: {
      event: "history_import",
      phase: "netflix",
      source: NETFLIX_SOURCE,
      source_timestamp: row.watchedAt,
      source_title: row.title,
    },
  };
}

function reviewEntry(row, kind, candidates = []) {
  return {
    row: row.index,
    rowNumber: row.rowNumber || row.index + 2,
    title: row.title,
    watchedAt: row.watchedAt,
    kind,
    candidates: candidates.map((candidate) => ({
      id: String(candidate.id),
      mediaType: candidate.season_number !== undefined ? "episode" : candidate.media_type || (candidate.title ? "movie" : "tv"),
      title: candidate.title || candidate.name,
      year: candidateYear(candidate),
      ...(candidate.netflixEvidence ? { netflixEvidence: candidate.netflixEvidence } : {}),
      ...(candidate.season_number !== undefined ? {
        season: candidate.season_number,
        episode: candidate.episode_number,
        showTmdbId: String(candidate.showTmdbId || ""),
      } : {}),
    })),
  };
}

export function groupNetflixReviews(reviews = []) {
  const groups = new Map();
  const yearMatched = [];
  const standalone = [];
  for (const review of reviews) {
    if (review.reason === "matched_by_year" && review.kind !== "episode") {
      yearMatched.push({ type: review.kind, ...review });
      continue;
    }
    if (review.kind !== "episode") {
      standalone.push(review);
      continue;
    }
    const show = review.showTitle || review.title.split(":", 1)[0];
    // Rows with no show name group by consecutive run, not by their shared placeholder.
    const key = review.blankRun != null ? `blank-run-${review.blankRun}` : titleKey(show);
    if (!groups.has(key)) {
      groups.set(key, { type: "show", groupId: key, show, showTmdbId: "", showCandidates: [], episodes: [],
        ...(review.blankRun != null ? { blankRun: true } : {}) });
    }
    const group = groups.get(key);
    if (review.showCandidate?.id) group.showTmdbId = String(review.showCandidate.id);
    const showCandidates = [review.showCandidate, ...(review.candidates || []).filter((candidate) => candidate.mediaType === "tv")].filter(Boolean);
    for (const candidate of showCandidates) {
      if (!group.showCandidates.some((entry) => String(entry.id) === String(candidate.id))) {
        group.showCandidates.push({ ...candidate, id: String(candidate.id), mediaType: "tv" });
      }
    }
    group.episodes.push({
      row: review.row,
      kind: "episode",
      title: review.episodeTitle || review.title,
      watchedAt: review.watchedAt,
      reason: review.reason,
      candidates: review.candidates || [],
      showTmdbId: review.showCandidate?.id || "",
      selectedCandidateId: review.selectedCandidateId || "",
      seasonHint: review.seasonHint ?? null,
      episodeHint: review.episodeHint ?? null,
      numberHint: review.numberHint ?? null,
    });
  }
  const grouped = [...standalone.map((entry) => ({ type: entry.kind, ...entry })), ...groups.values()];
  if (!yearMatched.length) return grouped;
  return [
    {
      type: "year_matched",
      items: yearMatched,
    },
    ...grouped,
  ];
}

function netflixCsvRowKey(title = "", watchedAt = "") {
  const date = String(watchedAt || "").slice(0, 10);
  const key = titleKey(title);
  return key && date ? `${key}|${date}` : "";
}

function importedNetflixCsvKeys(history = []) {
  const keys = new Set();
  for (const record of history) {
    const provenance = record.watch_provenance || record.watchProvenance || {};
    const fromNetflix = record.source === NETFLIX_SOURCE
      || provenance.source === NETFLIX_SOURCE
      || provenance.phase === "netflix";
    if (!fromNetflix) continue;
    const title = provenance.source_title || "";
    const watchedAt = record.watched_at || provenance.source_timestamp || "";
    const key = netflixCsvRowKey(title, watchedAt);
    if (key) keys.add(key);
  }
  return keys;
}

export async function prepareNetflixImport(csv, {
  onProgress = () => {},
  search = searchTmdb,
  getHistory = getCachedHistory,
  getSeasonLists = getTmdbShowSeasonLists,
  getEpisodeAliases = getNetflixEpisodeAliases,
  getVerifiedRow = resolveNetflixVerifiedRow,
  catalogue = getNetflixCatalogue(),
  getMovieRuntime = tmdbMovieRuntime,
  getAlternativeTitles = getTmdbAlternativeTitles,
  profiles,
} = {}) {
  const { format, records: rows, excluded } = readNetflixCsv(csv, { profiles });
  const history = await getHistory();
  const existing = new Set(history.map((record) => `${mediaKeyFor(record)}|${String(record.watched_at || "").slice(0, 10)}`));
  // Title+date fingerprints from earlier Netflix commits. Skip before TMDB so a
  // later full Viewing Activity re-export does not rematch already-imported rows.
  const importedCsvRows = importedNetflixCsvKeys(history);
  const records = [];
  const reviews = [];
  const skipped = [];
  const cache = new Map();
  const showSeasonCache = new Map();
  const searchCache = new Map();
  const evidenceCache = new Map();
  const groups = new Map();
  const evidenceMatches = new Map();
  const aliasCache = new Map();
  const matchedByRow = new Map();
  // Season and episode numbers each show's rows name, for ruling out same-named shows.
  const structure = new Map();
  for (const row of rows) {
    if (importedCsvRows.has(netflixCsvRowKey(row.title, row.watchedAt))) continue;
    for (const part of episodeInterpretations(row.title)) {
      const key = titleKey(part.showTitle);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(part);
      const number = row.episodeNumber ?? part.episodeHint;
      if (part.seasonHint != null && number != null) {
        if (!structure.has(key)) structure.set(key, new Set());
        structure.get(key).add(`${part.seasonHint}:${number}`);
      }
    }
  }
  const structureCache = new Map();
  async function structureMatch(showTitle, candidates) {
    const key = titleKey(showTitle);
    const cacheKey = `${key}|${candidates.map((candidate) => candidate.id).join(",")}`;
    if (!structureCache.has(cacheKey)) structureCache.set(cacheKey, await showsWithEpisodes(candidates, structure.get(key), seasonsOnce));
    return structureCache.get(cacheKey);
  }
  const runtimeCache = new Map();
  async function runtimeOnce(id) {
    if (!runtimeCache.has(id)) runtimeCache.set(id, await getMovieRuntime(id).catch(() => null));
    return runtimeCache.get(id);
  }
  const labelledSeasons = new Map([...groups].map(([key, parts]) => [key,
    new Set(parts.map((part) => part.seasonHint).filter((season) => season != null))]));
  async function searchOnce(query, mediaType) {
    const key = `${mediaType}:${titleKey(query)}`;
    if (!searchCache.has(key)) searchCache.set(key, await search({ query, mediaType }));
    return searchCache.get(key);
  }
  async function seasonsOnce(id) {
    if (!showSeasonCache.has(id)) showSeasonCache.set(id, await getSeasonLists({ tmdbId: id, lane: "sync" }));
    return showSeasonCache.get(id);
  }
  const alternativeTitleCache = new Map();
  const seasonMapCache = new Map();
  // Netflix's name is one TMDB records for the title ("Mako Mermaids" for Mako: Island
  // of Secrets, "Daniel Tiger's Neighbourhood"). Only the top search results are checked.
  async function alternativeTitleMatches(pool, query, mediaType) {
    const key = exactTitleKey(query);
    const found = [];
    for (const candidate of pool.slice(0, ALTERNATIVE_TITLE_CANDIDATES)) {
      const cacheKey = `${mediaType}:${candidate.id}`;
      if (!alternativeTitleCache.has(cacheKey)) {
        alternativeTitleCache.set(cacheKey, await getAlternativeTitles({ mediaType, tmdbId: candidate.id }).catch(() => []));
      }
      if (alternativeTitleCache.get(cacheKey).some((title) => exactTitleKey(title) === key)) found.push(candidate);
    }
    return found;
  }
  async function titleCandidatesOnce(query, mediaType) {
    const id = `${mediaType}:${titleKey(query)}`;
    if (!cache.has(id)) {
      // TMDB finds nothing for "Beauty and the Beast (2017)"; the year is applied per row.
      const result = await searchOnce(query.replace(/\s*\(\d{4}\)\s*$/, ""), mediaType);
      let pool = (result.results || []).filter((candidate) => (candidate.media_type || mediaType) === mediaType);
      let matches = exactCandidates(pool, query, mediaType);
      const references = mediaType === "tv" && structure.get(titleKey(query));
      const present = matches.length === 1 && references?.size
        ? new Set(episodesInLists(await seasonsOnce(String(matches[0].id))).map((episode) => `${episode.season_number}:${episode.episode_number}`)) : null;
      // An exact namesake missing explicit CSV coordinates is not the whole search:
      // Netflix's recorded alias may name the other show (The Golden Hour / Het gouden uur).
      // Empty metadata cannot establish that contradiction. Retain the original candidate.
      if (!matches.length || (present?.size && [...references].some((reference) => !present.has(reference)))) {
        const aliases = catalogue.aliases(query, mediaType);
        for (const alias of aliases.slice(0, 3)) {
          const alternate = await searchOnce(alias, mediaType);
          pool.push(...(alternate.results || []).filter((candidate) => (candidate.media_type || mediaType) === mediaType));
        }
        pool = [...new Map(pool.map((candidate) => [String(candidate.id), candidate])).values()];
        // Incomplete alias searches may supply suggestions but cannot auto-resolve.
        if (aliases.length <= 3) matches = [...new Map([...matches, ...catalogue.aliasMatches(query, mediaType, pool)]
          .map((candidate) => [String(candidate.id), candidate])).values()];
      }
      if (!matches.length) {
        // TMDB finds "Kate & Mim-Mim" but nothing for Netflix's "Kate and Mim-Mim".
        const swapped = /&/.test(query) ? query.replace(/\s*&\s*/g, " and ") : query.replace(/\s+and\s+/gi, " & ");
        if (swapped !== query) {
          const alternate = await searchOnce(swapped, mediaType);
          pool.push(...(alternate.results || []).filter((candidate) => (candidate.media_type || mediaType) === mediaType));
          pool = [...new Map(pool.map((candidate) => [String(candidate.id), candidate])).values()];
          matches = exactCandidates(pool, query, mediaType);
        }
      }
      if (!matches.length) matches = await alternativeTitleMatches(pool, query, mediaType);
      const widen = async (bare) => {
        const found = ((await searchOnce(bare, mediaType)).results || []).filter((candidate) => (candidate.media_type || mediaType) === mediaType);
        pool = [...new Map([...pool, ...found].map((candidate) => [String(candidate.id), candidate])).values()];
        return exactCandidates(pool, bare, mediaType);
      };
      // "Shameless (U.S.)" is the same name made in that country (the US 2011 show, not the
      // British 2004 one); a candidate with no recorded country never qualifies.
      const country = countrySuffix(query);
      if (!matches.length && country) {
        matches = (await widen(query.slice(0, country.index).trim()))
          .filter((candidate) => (candidate.origin_country || []).includes(country.code));
      }
      // TMDB names it "Dublin Murders" and finds nothing for Netflix's "The Dublin Murders".
      if (!matches.length && /^the\s+\S/i.test(query)) matches = await widen(query.replace(/^the\s+/i, ""));
      // The reverse spelling also occurs ("Swan Princess: A Royal Family Tale").
      if (!matches.length && !/^the\s+/i.test(query)) matches = await widen(`The ${query}`);
      const evidenceCandidates = [...new Map([...matches, ...pool.filter((candidate) =>
        String(candidateTitle(candidate, mediaType) || "").split(":").some((segment) => exactTitleKey(segment) === exactTitleKey(query))
          || containsTitleWords(candidateTitle(candidate, mediaType), query))]
        .map((candidate) => [String(candidate.id), candidate])).values()];
      cache.set(id, { matches: catalogue.rankCandidates(query, mediaType, matches),
        evidenceCandidates,
        suggestions: catalogue.rankCandidates(query, mediaType, pool).slice(0, 8) });
    }
    return cache.get(id);
  }
  async function evidenceFor(part) {
    const key = titleKey(part.showTitle);
    if (!evidenceCache.has(key)) {
      // Distinct named segments of one complete bundle are independent title
      // evidence too. Generic Episode N fragments still cannot identify a show.
      const parts = (groups.get(key) || []).flatMap((entry) => entry.episodeHint == null && entry.episodeTitle.includes("/")
        ? entry.episodeTitle.split(/\s*\/\s*/).filter(Boolean).map((segment) => ({ ...entry,
          ...parseNetflixEpisodePart(segment, { showTitle: entry.showTitle }), seasonHint: entry.seasonHint })) : [entry]);
      if (new Set(parts.filter((entry) => entry.episodeHint == null).map(evidenceKey)).size < 2) {
        evidenceCache.set(key, null);
        return null;
      }
      const titles = await titleCandidatesOnce(part.showTitle, "tv");
      // A longer provider name may contain Netflix's shorter name. Suggestions can
      // establish identity only through the same multi-episode evidence as exact names.
      const candidates = titles.evidenceCandidates;
      evidenceCache.set(key, await resolveShowEvidence(parts, candidates, seasonsOnce));
    }
    return evidenceCache.get(key);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    // Be defensive if a caller provides records without going through the CSV parser.
    if (!row.title || /^unknown title(?:\s*\(episode\s+\d+\))?$/i.test(row.title) || String(row.title).trimStart().startsWith(":")) {
      await onProgress(index + 1, rows.length);
      continue;
    }
    const csvKey = netflixCsvRowKey(row.title, row.watchedAt);
    if (csvKey && importedCsvRows.has(csvKey)) {
      skipped.push({ row: index, title: row.title, reason: "already_imported" });
      await onProgress(index + 1, rows.length);
      continue;
    }
    const verified = await getVerifiedRow(row.title, { getSeasonLists: ({ tmdbId }) => seasonsOnce(String(tmdbId)), watchedAt: row.watchedAt });
    if (verified?.length) {
      let added = 0;
      for (const target of verified) {
        const record = makeRecord(row, target);
        const key = `${mediaKeyFor(record)}|${row.watchedAt.slice(0, 10)}`;
        if (existing.has(key)) continue;
        existing.add(key);
        records.push(record);
        added += 1;
      }
      if (!added) skipped.push({ row: index, title: row.title, reason: "already_imported" });
      await onProgress(index + 1, rows.length);
      continue;
    }
    const separator = row.title.indexOf(":");
    let isEpisode = separator > 0;
    let showTitle = isEpisode ? row.title.slice(0, separator).trim() : "";
    let parsedEpisode = separator >= 0 ? parseNetflixEpisodePart(row.title.slice(separator + 1), { showTitle }) : null;
    const reportedShowTitle = isEpisode ? catalogue.showPrefix(row.title) : "";
    if (reportedShowTitle && reportedShowTitle !== showTitle) {
      const reportedCandidates = await titleCandidatesOnce(reportedShowTitle, "tv");
      if (reportedCandidates.matches.length) {
        showTitle = reportedShowTitle;
        parsedEpisode = parseNetflixEpisodePart(row.title.slice(reportedShowTitle.length + 1), { showTitle });
      }
    }
    let showEvidence = null;
    let boundaryConflict = false;
    // A full movie title in Netflix's film sheet can contain a colon. Keep a
    // competing real TV prefix on the existing episode path rather than treating
    // the report's omissions as proof that a show never existed.
    if (isEpisode && row.episodeNumber == null && catalogue.has(row.title, "movie") && !catalogue.has(row.title, "tv")) {
      const television = await titleCandidatesOnce(showTitle, "tv");
      const film = await titleCandidatesOnce(row.title, "movie");
      if (!television.matches.length && film.matches.length === 1) {
        isEpisode = false;
        showTitle = "";
        parsedEpisode = null;
      }
    }
    if (isEpisode) {
      const alternatives = [];
      for (const part of episodeInterpretations(row.title)) {
        const evidence = await evidenceFor(part);
        const evidencedYear = evidence ? candidateYear(evidence.candidate) : "";
        const futureEvidence = /^\d{4}$/.test(evidencedYear) && evidencedYear > watchYear(row.watchedAt);
        if (evidence && !futureEvidence) {
          const id = String(evidence.candidate.id);
          const lists = await seasonsOnce(id);
          let found = rowEpisodes(lists, part);
          if (!found.episodes && !found.matches.length) {
            if (!aliasCache.has(id)) aliasCache.set(id, await getEpisodeAliases({ tmdbId: id, tmdbLists: lists }));
            found = rowEpisodes(aliasCache.get(id), part);
          }
          if (found.episodes) alternatives.push({ part, evidence });
        }
      }
      // "Mako Mermaids" and "Mako Mermaids: An H2O Adventure" both name TMDB 42025: one
      // show, not a conflict. Keep its strongest reading, the longer prefix on a tie.
      const byShow = new Map();
      for (const entry of alternatives) {
        const id = String(entry.evidence.candidate.id);
        const kept = byShow.get(id);
        if (!kept || entry.evidence.hits > kept.evidence.hits
          || (entry.evidence.hits === kept.evidence.hits && entry.part.showTitle.length > kept.part.showTitle.length)) byShow.set(id, entry);
      }
      alternatives.splice(0, alternatives.length, ...byShow.values());
      alternatives.sort((a, b) => b.evidence.hits - a.evidence.hits);
      boundaryConflict = alternatives.length > 1 && alternatives[0].evidence.hits === alternatives[1].evidence.hits;
      // Conflicting interpretations remain on the original review path.
      if (alternatives.length && (alternatives.length === 1 || alternatives[0].evidence.hits > alternatives[1].evidence.hits)) {
        const selected = alternatives[0];
        showTitle = selected.part.showTitle;
        parsedEpisode = selected.part;
        showEvidence = selected.evidence;
        evidenceMatches.set(titleKey(showTitle), { showTitle, tmdbId: String(showEvidence.candidate.id), hits: showEvidence.hits, runnerUpHits: showEvidence.runnerUpHits, distinctEpisodes: showEvidence.distinctEpisodes });
      }
      // "See No Evil: The Story of the Moors Murders: Episode 2" names its show past
      // the first colon. Use a longer prefix only when the first one is not a unique
      // show and exactly one longer prefix is.
      if (!showEvidence && !boundaryConflict && showTitle && (await titleCandidatesOnce(showTitle, "tv")).matches.length !== 1) {
        const longer = [];
        for (const part of episodeInterpretations(row.title).filter((entry) => entry.showTitle.length > showTitle.length)) {
          if ((await titleCandidatesOnce(part.showTitle, "tv")).matches.length === 1) longer.push(part);
        }
        if (longer.length === 1) {
          showTitle = longer[0].showTitle;
          parsedEpisode = longer[0];
        }
      }
      // A colon title with no season label or Netflix episode number whose prefix is no
      // TV show is a film when exactly one film has the full title ("Death Wish 4: The Crackdown").
      if (!showEvidence && !boundaryConflict && row.episodeNumber == null && parsedEpisode?.seasonHint == null
        && parsedEpisode?.episodeHint == null) {
        const year = watchYear(row.watchedAt);
        const television = (await titleCandidatesOnce(showTitle, "tv")).matches;
        const released = (await titleCandidatesOnce(row.title, "movie")).matches
          .filter((candidate) => candidateYear(candidate) ? candidateYear(candidate) <= year : !television.length);
        const films = await moviesLongEnough(released, row.bookmarkSeconds, runtimeOnce);
        if (films.length === 1) {
          let competingEpisode = television.length > 12;
          for (const candidate of television.slice(0, 12)) {
            const found = rowEpisodes(await seasonsOnce(String(candidate.id)), { showTitle, ...parsedEpisode });
            if (found.episodes || found.matches.length) competingEpisode = true;
          }
          if (!competingEpisode) {
            isEpisode = false;
            showTitle = "";
            parsedEpisode = null;
          }
        }
      }
    }
    const episodeTitle = parsedEpisode?.episodeTitle || "";
    const episodeHints = parsedEpisode
      ? { seasonHint: impliedSeasonHint(parsedEpisode, labelledSeasons.get(titleKey(showTitle))), episodeHint: parsedEpisode.episodeHint,
        ...(row.episodeNumber != null ? { numberHint: row.episodeNumber } : {}) }
      : {};
    // Be defensive if an unassigned episode row bypassed the CSV parser's filter.
    if (separator === 0 || (isEpisode && !showTitle)) {
      await onProgress(index + 1, rows.length);
      continue;
    }
    const query = isEpisode ? showTitle : row.title;
    const type = isEpisode ? "tv" : "movie";
    const titleCandidates = await titleCandidatesOnce(query, type);
    const matches = releasedByWatchYear(titleCandidates.matches, row.watchedAt);
    let match =boundaryConflict ? null : showEvidence?.candidate || (matches.length === 1 ? matches[0] : null);
    if (!match && !boundaryConflict && matches.length > 1 && isEpisode) match = await structureMatch(showTitle, matches);
    if (!match && !boundaryConflict && matches.length > 1 && isEpisode) match = clearReportedWinner(matches, "tv", catalogue);
    // Netflix sometimes names the year itself ("Beauty and the Beast (2017)"); the one
    // same-named film from within a year of it is the one watched.
    const labelYear = isEpisode ? 0 : Number(row.title.match(/\((\d{4})\)\s*$/)?.[1] || 0);
    if (!match && labelYear && matches.length > 1) {
      const labelled = matches.filter((candidate) => Math.abs(Number(candidateYear(candidate)) - labelYear) <= 1);
      if (labelled.length === 1) match = labelled[0];
    }
    if (!match && matches.length > 1 && !isEpisode) {
      const playable = await moviesLongEnough(matches, row.bookmarkSeconds, runtimeOnce);
      match = playable.length === 1 ? playable[0] : clearReportedWinner(playable, "movie", catalogue);
    }
    if (!match && matches.length > 1 && !isEpisode) {
      match = pickByWatchYear(await moviesLongEnough(matches, row.bookmarkSeconds, runtimeOnce), row.watchedAt);
      if (match && !isEpisode) {
        reviews.push({
          ...reviewEntry(row, "movie", matches),
          reason: "matched_by_year",
          selectedCandidateId: String(match.id),
        });
        await onProgress(index + 1, rows.length);
        continue;
      }
    }
    if (!match) {
      // Reviewers still see every exact title, including later releases.
      const suggestions = matches.length ? titleCandidates.matches : titleCandidates.suggestions;
      reviews.push({
        ...reviewEntry(row, isEpisode ? "episode" : "movie", suggestions),
        showTitle,
        episodeTitle,
        ...episodeHints,
        reason: matches.length ? "ambiguous_title" : "no_exact_match",
      });
      await onProgress(index + 1, rows.length);
      continue;
    }
    if (!isEpisode) {
      const record = makeRecord(row, { mediaType: "movie", tmdbId: match.id, title: match.title });
      const key = `${mediaKeyFor(record)}|${row.watchedAt.slice(0, 10)}`;
      if (existing.has(key)) skipped.push({ row: index, title: row.title, reason: "already_imported" });
      else {
        existing.add(key);
        records.push(record);
      }
      await onProgress(index + 1, rows.length);
      continue;
    }

    const showKey = String(match.id);
    let seasonLists = showSeasonCache.get(showKey);
    if (!seasonLists) {
      seasonLists = await getSeasonLists({ tmdbId: showKey, lane: "sync" });
      showSeasonCache.set(showKey, seasonLists);
    }
    const part = { episodeTitle, showTitle, ...episodeHints };
    if (part.seasonHint == null && episodeTitle.includes(":")) {
      const labelKey = `${showKey}|${showTitle}|label:${episodeTitle.slice(0, episodeTitle.indexOf(":"))}`;
      if (!seasonMapCache.has(labelKey)) seasonMapCache.set(labelKey, learnedNetflixSeasonLabel(rows, showTitle, episodeTitle, seasonLists));
      const labelled = seasonMapCache.get(labelKey);
      if (labelled != null) part.seasonHint = labelled;
    }
    let resolved = rowEpisodes(seasonLists, part);
    if (!resolved.episodes && !resolved.matches.length) {
      if (!aliasCache.has(showKey)) aliasCache.set(showKey, await getEpisodeAliases({ tmdbId: showKey, tmdbLists: seasonLists }));
      seasonLists = aliasCache.get(showKey);
      resolved = rowEpisodes(seasonLists, part);
    }
    if (!resolved.episodes && !resolved.matches.length && part.seasonHint != null) {
      const mapKey = `${showKey}|${showTitle}|${part.seasonHint}`;
      if (!seasonMapCache.has(mapKey)) seasonMapCache.set(mapKey, learnedNetflixSeason(rows, showTitle, part.seasonHint, seasonLists));
      const mapped = seasonMapCache.get(mapKey);
      // Netflix's own episode numbers follow its numbering, so they are not used here.
      const remapped = mapped == null ? null : rowEpisodes(seasonLists, { episodeTitle, showTitle, seasonHint: mapped });
      if (remapped?.episodes) resolved = remapped;
    }
    let crossSeason = false;
    if (!resolved.episodes && !resolved.matches.length && part.episodeHint == null && !String(episodeTitle).includes("/")) {
      const loose = looseEpisodeMatch(seasonLists, part);
      if (loose) {
        resolved = { episodes: [loose.episode], matches: [] };
        crossSeason = loose.crossSeason;
      }
    }
    // "Alvin and the Chipmunks: The Road Chip" sits under a real show but names no
    // episode: with no season or number, it is a film when exactly one released film,
    // long enough for the bookmark, has the full title.
    if (!resolved.episodes && !resolved.matches.length && row.episodeNumber == null
      && part.seasonHint == null && part.episodeHint == null) {
      const year = watchYear(row.watchedAt);
      const released = (await titleCandidatesOnce(row.title, "movie")).matches
        .filter((candidate) => /^\d{4}$/.test(candidateYear(candidate)) && (!/^\d{4}$/.test(year) || candidateYear(candidate) <= year));
      const films = await moviesLongEnough(released, row.bookmarkSeconds, runtimeOnce);
      if (films.length === 1) {
        const record = makeRecord(row, { mediaType: "movie", tmdbId: films[0].id, title: films[0].title });
        const key = `${mediaKeyFor(record)}|${row.watchedAt.slice(0, 10)}`;
        if (existing.has(key)) skipped.push({ row: index, title: row.title, reason: "already_imported" });
        else {
          existing.add(key);
          records.push(record);
        }
        await onProgress(index + 1, rows.length);
        continue;
      }
    }
    if (!resolved.episodes) {
      const episodes = resolved.matches;
      const suggestions = episodes.length
        ? episodes.map((entry) => ({ ...entry, showTmdbId: showKey }))
        : episodeSuggestions(seasonLists, episodeTitle, showKey, episodeHints);
      reviews.push({
        ...reviewEntry(row, "episode", suggestions),
        showTitle,
        episodeTitle,
        ...episodeHints,
        reason: episodes.length ? "ambiguous_episode" : "no_episode_match",
        showCandidate: { id: showKey, title: match.name, ...(match.netflixEvidence ? { netflixEvidence: match.netflixEvidence } : {}) },
      });
      await onProgress(index + 1, rows.length);
      continue;
    }
    let added = 0;
    for (const episode of resolved.episodes) {
      const record = makeRecord(row, {
        mediaType: "episode",
        tmdbId: match.id,
        showTitle: match.name,
        episodeTitle: episode.name,
        season: episode.season_number,
        episode: episode.episode_number,
      });
      const key = `${mediaKeyFor(record)}|${row.watchedAt.slice(0, 10)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      records.push(record);
      added += 1;
    }
    if (resolved.episodes.length === 1 && !crossSeason) {
      const episode = resolved.episodes[0];
      matchedByRow.set(index, {
        showTmdbId: showKey,
        showTitle: match.name,
        season: Number(episode.season_number),
        episode: Number(episode.episode_number),
      });
    }
    if (!added) skipped.push({ row: index, title: row.title, reason: "already_imported" });
    await onProgress(index + 1, rows.length);
  }
  const openReviews = fillSeasonNeighbourGaps(reviews, matchedByRow, showSeasonCache, rows, records, existing);
  const reviewGroups = groupNetflixReviews(openReviews);
  const matchedByYear = openReviews.filter((review) => review.reason === "matched_by_year").length;
  const needsReview = openReviews.length - matchedByYear;
  return {
    total: rows.length,
    format,
    excluded,
    evidenceMatches: [...evidenceMatches.values()],
    matched: records.length,
    matchedByYear,
    skipped: skipped.length,
    needsReview,
    records,
    reviews: reviewGroups,
    skippedRows: skipped,
    sourceRows: rows,
  };
}

export function saveNetflixPreview(preview) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  previews.set(id, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
  for (const [key, value] of previews) if (value.expiresAt < Date.now()) previews.delete(key);
  return id;
}

export function netflixPreviewSummary(preview) {
  const { total, format, excluded, matched, matchedByYear, evidenceMatches, skipped, needsReview, reviews } = preview;
  return { total, format, excluded, matched, matchedByYear, evidenceMatches, skipped, needsReview, reviews };
}

// Rematching changes only the short-lived preview. It never writes watch history.
export async function reviewNetflixPreview(previewId, { groupId, tmdbId, query } = {}, {
  search = searchTmdb,
  getSeasonLists = getTmdbShowSeasonLists,
  getEpisodeAliases = getNetflixEpisodeAliases,
  getHistory = getCachedHistory,
} = {}) {
  const saved = previews.get(String(previewId));
  if (!saved || saved.expiresAt < Date.now()) throw Object.assign(new Error("The Netflix preview expired. Upload the CSV again."), { status: 410 });
  if (saved.busy) throw Object.assign(new Error("This Netflix preview is already being updated."), { status: 409 });
  const group = saved.preview.reviews.find((entry) => entry.type === "show" && entry.groupId === groupId);
  const unassignedRun = (entry) => entry.blankRun && entry.episodes.every((item) => item.reason === "missing_show_title");
  if (!group || (!group.blankRun && group.episodes.some((entry) => entry.reason === "missing_show_title"))) {
    throw Object.assign(new Error("Choose a show from this preview's review list."), { status: 400 });
  }
  if (query !== undefined) return searchNetflixRunShows(saved, previewId, group, query, search, unassignedRun);
  const candidate = group.showCandidates.find((entry) => String(entry.id) === String(tmdbId));
  if (!candidate) throw Object.assign(new Error("Choose a listed show before matching its episodes."), { status: 400 });
  saved.busy = true;
  try {
    const preview = saved.preview;
    const id = String(candidate.id);
    let lists = await getSeasonLists({ tmdbId: id, lane: "sync" });
    const partFor = (item) => ({ ...parseNetflixEpisodePart(item.title), showTitle: group.show,
      seasonHint: item.seasonHint ?? parseNetflixEpisodePart(item.title).seasonHint,
      episodeHint: item.episodeHint ?? parseNetflixEpisodePart(item.title).episodeHint,
      numberHint: item.numberHint ?? null });
    if (group.episodes.some((item) => { const found = rowEpisodes(lists, partFor(item)); return !found.episodes && !found.matches.length; })) {
      lists = await getEpisodeAliases({ tmdbId: id, tmdbLists: lists });
    }
    const history = await getHistory();
    const keyFor = (record) => `${mediaKeyFor(record)}|${String(record.watched_at || "").slice(0, 10)}`;
    const existing = new Set([...history, ...preview.records].map(keyFor));
    const additions = [];
    const skippedRows = [];
    const remaining = [];
    const matchedByRow = new Map();
    const remember = (rowIndex, episode) => {
      if (!episode) return;
      matchedByRow.set(rowIndex, {
        showTmdbId: id,
        showTitle: candidate.title,
        season: Number(episode.season_number ?? episode.season),
        episode: Number(episode.episode_number ?? episode.episode),
      });
    };
    for (const record of preview.records) {
      if (record.media_type !== "episode" || String(record.tmdb_id) !== id) continue;
      const rowIndex = preview.sourceRows.findIndex((entry) => entry.title === record.watch_provenance?.source_title
        && String(entry.watchedAt || "").slice(0, 10) === String(record.watched_at || "").slice(0, 10));
      if (rowIndex >= 0) remember(rowIndex, record);
    }
    for (const item of group.episodes) {
      const row = preview.sourceRows[item.row];
      const part = partFor(item);
      const { episodes, matches } = rowEpisodes(lists, part);
      if (!episodes) {
        const suggestions = matches.length ? matches.map((entry) => ({ ...entry, showTmdbId: id }))
          : episodeSuggestions(lists, part.episodeTitle, id, part);
        remaining.push({ ...item, showTmdbId: id, reason: matches.length ? "ambiguous_episode" : "no_episode_match",
          candidates: reviewEntry(row, "episode", suggestions).candidates, showCandidate: { id, title: candidate.title },
          seasonHint: part.seasonHint, episodeHint: part.episodeHint, numberHint: part.numberHint });
        continue;
      }
      let added = 0;
      for (const episode of episodes) {
        const record = makeRecord(row, { mediaType: "episode", tmdbId: id,
          showTitle: candidate.title, episodeTitle: episode.name,
          season: episode.season_number, episode: episode.episode_number });
        const key = keyFor(record);
        if (existing.has(key)) continue;
        existing.add(key);
        additions.push(record);
        added += 1;
      }
      if (episodes.length === 1) remember(item.row, episodes[0]);
      if (!added) skippedRows.push({ row: item.row, title: row.title, reason: "already_imported" });
    }
    const showSeasonCache = new Map([[id, lists]]);
    const stillOpen = fillSeasonNeighbourGaps(remaining, matchedByRow, showSeasonCache, preview.sourceRows, additions, existing);
    if (saved.expiresAt < Date.now()) throw Object.assign(new Error("The Netflix preview expired. Upload the CSV again."), { status: 410 });
    // Publish the complete result atomically; a metadata error leaves the old preview intact.
    preview.records.push(...additions);
    preview.skippedRows.push(...skippedRows);
    preview.skipped += skippedRows.length;
    preview.matched = preview.records.length;
    preview.needsReview -= group.episodes.length - stillOpen.length;
    const assigned = { ...candidate, mediaType: "tv" };
    preview.reviews = preview.reviews.flatMap((entry) => entry !== group ? [entry]
      : stillOpen.length ? [{ ...group, ...(group.blankRun ? { show: candidate.title } : {}), showTmdbId: id, showCandidates: [assigned], episodes: stillOpen }] : []);
    // Blank runs are often the same show watched across several days; offer this
    // choice to the runs still waiting, without assigning them.
    if (group.blankRun) {
      for (const entry of preview.reviews) {
        if (unassignedRun(entry) && !entry.showCandidates.some((item) => String(item.id) === id)) entry.showCandidates.unshift(assigned);
      }
    }
    return { previewId: String(previewId), ...netflixPreviewSummary(preview) };
  } finally {
    saved.busy = false;
  }
}

// A blank run has no Netflix show name, so its show choices come from a reviewer's search.
async function searchNetflixRunShows(saved, previewId, group, query, search, unassignedRun) {
  const text = String(query || "").trim();
  if (!unassignedRun(group)) throw Object.assign(new Error("Search for a show only on rows Netflix left without a show name."), { status: 400 });
  if (!text) throw Object.assign(new Error("Type a show name to search for."), { status: 400 });
  saved.busy = true;
  try {
    const result = await search({ query: text, mediaType: "tv" });
    const found = (result.results || []).filter((candidate) => (candidate.media_type || "tv") === "tv" && candidate.id).slice(0, 8)
      .map((candidate) => ({ id: String(candidate.id), mediaType: "tv", title: candidate.name || candidate.title, year: candidateYear(candidate) }));
    if (saved.expiresAt < Date.now()) throw Object.assign(new Error("The Netflix preview expired. Upload the CSV again."), { status: 410 });
    // Shows already chosen for other runs stay listed first.
    const kept = group.showCandidates.filter((candidate) => !found.some((entry) => entry.id === String(candidate.id)));
    group.showCandidates = [...kept, ...found];
    return { previewId: String(previewId), searchedGroupId: group.groupId, searchResults: found.length, ...netflixPreviewSummary(saved.preview) };
  } finally {
    saved.busy = false;
  }
}

export async function commitNetflixImport(previewId, {
  reviewedRows = [],
  getSeasonLists = getTmdbShowSeasonLists,
} = {}) {
  const saved = previews.get(String(previewId));
  if (!saved || saved.expiresAt < Date.now()) {
    throw Object.assign(new Error("The Netflix preview expired. Upload the CSV again."), { status: 410 });
  }
  if (saved.busy) throw Object.assign(new Error("Wait for episode matching to finish before importing."), { status: 409 });
  saved.busy = true;
  try {
  const reviewItems = saved.preview.reviews.flatMap((group) => {
    if (group.type === "show") {
      return group.episodes.map((episode) => ({ ...episode, kind: "episode", show: group.show }));
    }
    if (group.type === "year_matched") return group.items || [];
    return [group];
  });
  const decisions = new Map(reviewedRows.map((item) => [Number(item.row), item]));
  const unresolved = reviewItems.filter((item) => {
    const decision = decisions.get(Number(item.row));
    if (["skip", "import"].includes(decision?.action)) return false;
    // Year-matched rows keep their preselected candidate when the UI left the default.
    return !(item.reason === "matched_by_year" && item.selectedCandidateId);
  });
  if (unresolved.length) {
    throw Object.assign(new Error("Review or skip every unmatched title before importing."), { status: 400 });
  }
  const reviewedRecords = [];
  for (const item of reviewItems) {
    const decision = decisions.get(Number(item.row)) || (
      item.reason === "matched_by_year" && item.selectedCandidateId
        ? { action: "import", candidateId: item.selectedCandidateId }
        : null
    );
    if (!decision || decision.action === "skip") continue;
    const row = saved.preview.sourceRows[Number(item.row)];
    const candidate = item.candidates.find((entry) => String(entry.id) === String(decision.candidateId)
      && (decision.season === undefined || Number(entry.season) === Number(decision.season))
      && (decision.episode === undefined || Number(entry.episode) === Number(decision.episode)));
    if (!candidate) {
      throw Object.assign(new Error(`Choose a listed match or skip “${item.title}”.`), { status: 400 });
    }
    if (item.kind === "episode") {
      if (candidate.mediaType === "episode") {
        reviewedRecords.push(makeRecord(row, {
          mediaType: "episode",
          tmdbId: candidate.showTmdbId || item.showTmdbId,
          showTitle: item.show || item.showTitle,
          episodeTitle: candidate.title,
          season: candidate.season,
          episode: candidate.episode,
        }));
      } else if (candidate.mediaType === "tv") {
        const seasons = await getSeasonLists({ tmdbId: candidate.id, lane: "sync" });
        const parsed = parseNetflixEpisodePart(item.title);
        const { episodes } = rowEpisodes(seasons, {
          showTitle: item.show || item.showTitle || candidate.title,
          episodeTitle: parsed.episodeTitle,
          seasonHint: item.seasonHint ?? parsed.seasonHint,
          episodeHint: item.episodeHint ?? parsed.episodeHint,
          numberHint: item.numberHint ?? null,
        });
        if (!episodes) {
          throw Object.assign(new Error(`The episode “${item.title}” still does not have one exact match under “${candidate.title}”.`), { status: 400 });
        }
        for (const match of episodes) {
          reviewedRecords.push(makeRecord(row, {
            mediaType: "episode",
            tmdbId: candidate.id,
            showTitle: candidate.title,
            episodeTitle: match.name,
            season: match.season_number,
            episode: match.episode_number,
          }));
        }
      } else {
        throw Object.assign(new Error(`Choose an episode match for “${item.title}”.`), { status: 400 });
      }
    } else {
      reviewedRecords.push(makeRecord(row, { mediaType: "movie", tmdbId: candidate.id, title: candidate.title }));
    }
  }
  const inserted = await batchInsertWatchRecords([...saved.preview.records, ...reviewedRecords], {
    source: NETFLIX_SOURCE,
    prefetch: false,
  });
  previews.delete(String(previewId));
  return {
    matched: saved.preview.records.length + reviewedRecords.length,
    inserted: inserted.inserted,
    skipped: saved.preview.skipped + inserted.skipped,
    needsReview: saved.preview.needsReview,
    reviewedSkipped: decisions.size - reviewedRecords.length,
    rejected: inserted.rejected,
  };
  } finally {
    saved.busy = false;
  }
}
