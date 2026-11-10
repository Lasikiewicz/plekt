import crypto from "node:crypto";
import { bumpDataVersion, db, transaction } from "../db.js";
import { getCanonicalPosterUrl } from "./mediaArtwork.js";
import { personalMediaKey } from "./personalMediaKey.js";
import { loadMediaConfig } from "./configStore.js";
import { playlistLibraryDeps, runPlaylistPush, withPlaylistLock } from "./playlistPushEngine.js";
import { TMDB_GENRES, genreKey, readLibraryCatalogues, readLibrarySeriesEpisodes } from "./playlistRuleCatalogue.js";
import { episodeItemRow, showConversionDeps } from "./playlistShowConversion.js";
import { normalizeLanguageCode, readTitleLanguages } from "./playlistLanguages.js";
import { applyRemoveWatched, automaticPlaylistsToMoveOn, idKeys, isHandedOff, readHandoffKeys, readWatchIndex } from "./playlistWatched.js";
import { PLAYLIST_PROVIDERS } from "./providerPlaylists.js";
import { discoverTmdbPage, trendingTmdbPage } from "./tmdbGateway.js";
import { configuredProvider } from "./upNextLibraryLookup.js";
import { runWithConcurrency } from "./concurrency.js";
import { airDayOf, todayLocalDate } from "./watchDates.js";

// Automatic playlists (plan/archive/custom-playlist-sync step 8b, decisions 32
// to 52). A rule is evaluated into the ordered list of items the playlist
// should hold, then applied under the playlist lock. Safety (accuracy over
// completeness): any failed read (an app library, TMDB, a show's episodes)
// leaves the items untouched and records rule_error; a check that would remove
// at least 3 items that are also more than half the playlist is held whole for
// Confirm or Discard (decisions 41, 47, 48).

export const RULE_CHECK_INTERVAL_MS = 60 * 60_000;
export const RULE_DEFAULT_LIMIT = 20;
export const RULE_MAX_LIMIT = 500;
// The type picks the titles; "ranked" keeps the type's own ranking and the
// other orders re-sort the picked titles (decisions 69 to 71).
export const RULE_TYPES = ["top", "popular", "trending", "new"];
const RULE_ORDERS = ["ranked", "newest", "oldest", "title", "random", "rating"];
// Below these, TMDB's rating order opens with little-known titles (lyric
// videos, specials) that a handful of voters rated highly.
const TOP_MIN_VOTES = { movie: 500, tv: 300 };
const NEW_MOVIE_WINDOW_DAYS = 42;
const NEW_TV_WINDOW_DAYS = 7;
const MASS_REMOVAL_MIN = 3;
const TMDB_PAGE_CAP = 25;
const EPISODE_READ_CONCURRENCY = 4;
const DAY_MS = 86_400_000;

function text(value = "") {
  return String(value ?? "").trim();
}

function errorText(error) {
  return text(error?.message || error) || "Unknown error";
}

function badRule(message) {
  const error = new Error(message);
  error.status = 400;
  error.publicCode = "invalid_rule";
  return error;
}

function yearOrNull(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1870 || year > 2200) throw badRule(`${label} must be a year`);
  return year;
}

// Compound TMDB TV genres match their parts both ways (decision 46).
const GENRE_PARTS = new Map([
  ["scifiandfantasy", ["sciencefiction", "fantasy"]],
  ["actionandadventure", ["action", "adventure"]],
  ["warandpolitics", ["war", "politics"]],
]);

export function genreMatchKeys(name) {
  const key = genreKey(name);
  const keys = new Set([key]);
  for (const part of GENRE_PARTS.get(key) || []) keys.add(part);
  for (const [compound, parts] of GENRE_PARTS) if (parts.includes(key)) keys.add(compound);
  return keys;
}

// The TMDB genre ids a rule genre stands for, for the catalogue source.
function tmdbGenreIds(kind, name) {
  const keys = genreMatchKeys(name);
  return TMDB_GENRES[kind === "tv" ? "tv" : "movie"].filter((genre) => keys.has(genreKey(genre.name))).map((genre) => genre.id);
}

// Validates a rule from a request for a Movies or TV playlist (decision 38).
export function normalizePlaylistRule(input, kind) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRule("The rule is missing");
  if (!["movie", "tv"].includes(kind)) throw badRule("Automatic playlists are Movies or TV");
  const source = text(input.source).toLowerCase() || "library";
  if (!["library", "catalogue"].includes(source)) throw badRule("source must be library or catalogue");
  const type = text(input.type).toLowerCase() || "top";
  if (!RULE_TYPES.includes(type)) throw badRule(`type must be one of ${RULE_TYPES.join(", ")}`);
  const seen = new Set();
  const genres = [];
  for (const name of Array.isArray(input.genres) ? input.genres : []) {
    const value = text(name).slice(0, 80);
    if (!value || seen.has(genreKey(value))) continue;
    seen.add(genreKey(value));
    genres.push(value);
  }
  if (genres.length > 20) throw badRule("Choose at most 20 genres");
  // Original languages, empty meaning any (decisions 60, 61).
  const languages = [];
  for (const value of Array.isArray(input.languages) ? input.languages : []) {
    const code = normalizeLanguageCode(value);
    if (!code) throw badRule(`Not a language code: ${text(value).slice(0, 20)}`);
    if (!languages.includes(code)) languages.push(code);
  }
  if (languages.length > 20) throw badRule("Choose at most 20 languages");
  const genreMatch = text(input.genreMatch).toLowerCase() || "any";
  if (!["any", "all"].includes(genreMatch)) throw badRule("genreMatch must be any or all");
  const yearFrom = yearOrNull(input.yearFrom, "yearFrom");
  const yearTo = yearOrNull(input.yearTo, "yearTo");
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) throw badRule("yearFrom must not be after yearTo");
  let watched = text(input.watched).toLowerCase() || "any";
  if (!["any", "unwatched", "watched"].includes(watched)) throw badRule("watched must be any, unwatched, or watched");
  // TV holds each show's next episode instead (decisions 53, 54).
  if (kind === "tv") watched = "any";
  let addedWithinDays = null;
  if (input.addedWithinDays !== null && input.addedWithinDays !== undefined && input.addedWithinDays !== "") {
    addedWithinDays = Number(input.addedWithinDays);
    if (!Number.isInteger(addedWithinDays) || addedWithinDays < 1 || addedWithinDays > 3650) throw badRule("addedWithinDays must be 1 to 3650 days");
    // Recently added means added to your library (decision 45).
    if (source === "catalogue") throw badRule("Recently added is only for playlists from your libraries");
  }
  let limit = input.limit === null || input.limit === undefined || input.limit === "" ? null : Number(input.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > RULE_MAX_LIMIT)) throw badRule(`The maximum must be 1 to ${RULE_MAX_LIMIT}`);
  // The catalogue source always has a maximum (decision 37).
  if (limit === null && source === "catalogue") limit = RULE_DEFAULT_LIMIT;
  const order = text(input.order).toLowerCase() || "ranked";
  if (!RULE_ORDERS.includes(order)) throw badRule(`order must be one of ${RULE_ORDERS.join(", ")}`);
  if (source === "catalogue") {
    const unknown = genres.filter((name) => !tmdbGenreIds(kind, name).length);
    if (unknown.length) throw badRule(`Not a TMDB ${kind === "tv" ? "TV" : "movie"} genre: ${unknown.join(", ")}`);
  }
  return { source, type, genres, genreMatch, languages, yearFrom, yearTo, watched, addedWithinDays, limit, order };
}

// Rules saved before the type choice read as Top rated (decision 72).
function ruleType(rule) {
  return RULE_TYPES.includes(rule.type) ? rule.type : "top";
}

export function parsePlaylistRule(ruleJson) {
  if (!ruleJson) return null;
  try {
    const rule = JSON.parse(ruleJson);
    return rule && typeof rule === "object" ? rule : null;
  } catch {
    return null;
  }
}

// TV automatic playlists leave out Talk and News shows unless the rule asks
// for that genre (decision 73): TMDB's TV lists open with talk shows.
const TV_LEFT_OUT_GENRES = ["talk", "news"];

function leftOutGenres(rule, kind) {
  if (kind !== "tv") return [];
  const asked = new Set(rule.genres.map(genreKey));
  return TV_LEFT_OUT_GENRES.filter((key) => !asked.has(key));
}

function genresMatch(rule, titleKeys, kind = "movie") {
  const left = leftOutGenres(rule, kind);
  if (left.length && titleKeys.some((key) => left.includes(key))) return false;
  if (!rule.genres.length) return true;
  const keys = new Set(titleKeys);
  const hit = (name) => [...genreMatchKeys(name)].some((key) => keys.has(key));
  return rule.genreMatch === "all" ? rule.genres.every(hit) : rule.genres.some(hit);
}

// Rules saved before the Language choice have no languages: any language.
function ruleLanguages(rule) {
  return Array.isArray(rule.languages) ? rule.languages : [];
}

// A title whose language is unknown ("") is left out when languages are
// ticked (decision 62).
function languageMatches(rule, language) {
  const languages = ruleLanguages(rule);
  return !languages.length || languages.includes(normalizeLanguageCode(language));
}

function yearMatches(rule, year) {
  if (rule.yearFrom === null && rule.yearTo === null) return true;
  if (!Number.isFinite(year)) return false;
  return (rule.yearFrom === null || year >= rule.yearFrom) && (rule.yearTo === null || year <= rule.yearTo);
}

// --- Watch history --------------------------------------------------------

export { readWatchIndex };

function watchedFilter(rule, isWatched) {
  if (rule.watched === "any") return () => true;
  return (...args) => (rule.watched === "watched") === isWatched(...args);
}

// --- Ordering -------------------------------------------------------------

// A fixed random place per playlist and title (decision 52).
function stableRandom(listId, identity) {
  return crypto.createHash("sha1").update(`${listId}|${identity}`).digest("hex");
}

function identityOf(title) {
  return idKeys("t", title.ids)[0] || `title:${text(title.title).toLowerCase()}:${title.year ?? ""}`;
}

// Newest and oldest mean release date (decision 49); ties go by title.
function orderTitles(titles, order, listId) {
  const byTitle = (a, b) => text(a.title).localeCompare(text(b.title)) || identityOf(a).localeCompare(identityOf(b));
  const released = (title) => text(title.release_date) || (Number.isFinite(title.year) ? `${title.year}` : "");
  const sorted = [...titles];
  if (order === "ranked") return sorted;
  if (order === "title") sorted.sort(byTitle);
  else if (order === "rating") sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || byTitle(a, b));
  else if (order === "random") sorted.sort((a, b) => stableRandom(listId, identityOf(a)).localeCompare(stableRandom(listId, identityOf(b))));
  else {
    const sign = order === "oldest" ? 1 : -1;
    sorted.sort((a, b) => {
      const left = released(a);
      const right = released(b);
      if (!left !== !right) return left ? -1 : 1;
      return sign * left.localeCompare(right) || byTitle(a, b);
    });
  }
  return sorted;
}

// --- Item rows ------------------------------------------------------------

function movieRow(title) {
  const row = {
    media_type: "movie",
    title: text(title.title) || "Untitled",
    tmdb_id: text(title.ids.tmdb),
    tvdb_id: text(title.ids.tvdb),
    imdb_id: text(title.ids.imdb),
    overview: text(title.overview).slice(0, 4000),
    release_date: text(title.release_date),
    show_title: null,
    season: null,
    episode: null,
  };
  row.media_key = personalMediaKey(row);
  // A cached poster first; a catalogue title not in the cache shows TMDB's.
  try { row.poster_url = getCanonicalPosterUrl({ ...row }) || ""; } catch { row.poster_url = ""; }
  if (!row.poster_url) row.poster_url = text(title.poster_url);
  return row;
}

function showIdsOf(title) {
  return { tmdb_id: text(title.ids.tmdb), tvdb_id: text(title.ids.tvdb), imdb_id: text(title.ids.imdb) };
}

function todayOf(now) {
  return todayLocalDate(now);
}

// The episode to watch next, as Up Next picks it: the first one after
// `after` (the furthest watched, or null), specials left out. None, or one
// not aired yet, gives null and the show is left out (decision 53).
export function pickNextEpisode(episodes, after, today) {
  const next = [...episodes]
    .filter((entry) => entry.season > 0 && entry.episode > 0)
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
    .find((entry) => !after || entry.season > after.season || (entry.season === after.season && entry.episode > after.episode));
  if (!next) return null;
  const airDate = airDayOf(next.air_date);
  return !airDate || airDate <= today ? next : null;
}

// One episode per show, its next one to watch, until `limit` shows are in
// (decisions 39, 53: the maximum counts shows). `readNext(show, after)`
// returns the episode { season, episode, title, overview, air_date }, or null
// to leave the show out, or throws. Returns { show, row } in `shows` order.
async function nextEpisodes(rule, shows, readNext, index) {
  const entries = [];
  let taken = 0;
  const batch = Math.max(EPISODE_READ_CONCURRENCY, 1);
  for (let start = 0; start < shows.length && (rule.limit === null || taken < rule.limit); start += batch) {
    const slice = shows.slice(start, start + batch);
    const read = Array(slice.length);
    await runWithConcurrency(slice, async (show, position) => {
      read[position] = await readNext(show, index.furthestEpisode(show.ids));
    }, EPISODE_READ_CONCURRENCY);
    slice.forEach((show, position) => {
      if (rule.limit !== null && taken >= rule.limit) return;
      if (!read[position]) return;
      taken += 1;
      entries.push({ show, row: episodeItemRow({ title: show.title, poster_url: show.poster_url || "" }, showIdsOf(show), read[position]) });
    });
  }
  return entries;
}

// The type picks up to `limit` titles in its ranking; any order but "ranked"
// then re-sorts them (decision 71). TV shows are picked by whether they have a
// next episode, then re-sorted with their episodes.
function pickMovies(rule, ranked, listId) {
  const picked = rule.limit === null ? ranked : ranked.slice(0, rule.limit);
  return orderTitles(picked, rule.order, listId).map(movieRow);
}

async function pickShows(rule, ranked, readNext, index, listId) {
  const entries = await nextEpisodes(rule, ranked, readNext, index);
  const rowOf = new Map(entries.map((entry) => [entry.show, entry.row]));
  return orderTitles(entries.map((entry) => entry.show), rule.order, listId).map((show) => rowOf.get(show));
}

// Titles this playlist handed off after a watch never come back (decision 56).
function notHandedOff(handoffs, prefix) {
  return (title) => !idKeys(prefix, title.ids).some((key) => handoffs.has(key));
}

// --- Library source -------------------------------------------------------

// One title per movie or show across the apps, matched by any shared id. A
// title its app has not matched to any id yet is left out until it is
// (decision 74): keyed by name it duplicated the matched copy and took its
// app entries.
export function mergeLibraryTitles(catalogues, mediaType) {
  const titles = [];
  const byId = new Map();
  for (const provider of PLAYLIST_PROVIDERS) {
    for (const item of catalogues[provider]?.items || []) {
      if (item.media_type !== mediaType) continue;
      const keys = idKeys("t", item.ids);
      if (!keys.length) continue;
      let title = keys.map((key) => byId.get(key)).find(Boolean);
      if (!title) {
        title = { title: item.title, year: item.year, release_date: "", ids: { tmdb: "", tvdb: "", imdb: "" }, genre_keys: new Set(), added_at: null, ratings: [], providers: {} };
        titles.push(title);
      }
      for (const name of ["tmdb", "tvdb", "imdb"]) if (!title.ids[name] && item.ids[name]) title.ids[name] = item.ids[name];
      if (title.year === null && item.year !== null) title.year = item.year;
      if (!title.release_date && item.release_date) title.release_date = item.release_date;
      item.genre_keys.forEach((key) => title.genre_keys.add(key));
      // Added to your library: the first app that had it.
      if (item.added_at !== null && (title.added_at === null || item.added_at < title.added_at)) title.added_at = item.added_at;
      if (item.rating !== null) title.ratings.push(item.rating);
      title.providers[provider] = item.item_id;
      for (const key of idKeys("t", title.ids)) byId.set(key, title);
    }
  }
  return titles.map((title) => ({
    ...title,
    genre_keys: [...title.genre_keys],
    rating: title.ratings.length ? title.ratings.reduce((sum, value) => sum + value, 0) / title.ratings.length : null,
  }));
}

// The apps a library playlist draws from: its chosen apps, or every connected
// app for a Plembfin-only playlist (decision 50).
function libraryProviders(list, config, targets) {
  const chosen = targets.filter((target) => target.desired_state === "present").map((target) => target.provider);
  const providers = (chosen.length ? chosen : PLAYLIST_PROVIDERS).filter((provider) => configuredProvider(config, provider));
  if (!providers.length) throw new Error(chosen.length ? "None of this playlist's apps is connected." : "No app is connected to read a library from.");
  return providers;
}

// The union of the episodes each chosen app holds for the show, read by the
// series id that app's catalogue listed. A failed read throws.
async function libraryEpisodes(show, providers, config, deps) {
  const byCoordinate = new Map();
  // Plex, then Emby, then Jellyfin name an episode both hold.
  for (const provider of PLAYLIST_PROVIDERS.filter((name) => providers.includes(name) && show.providers[name])) {
    const episodes = await deps.seriesEpisodes(provider, config[provider], show.providers[provider]);
    if (!Array.isArray(episodes)) throw new Error(`${provider} returned no episode list for ${show.title}.`);
    for (const entry of episodes) {
      const key = `${entry.season}:${entry.episode}`;
      if (!byCoordinate.has(key)) byCoordinate.set(key, entry);
    }
  }
  return [...byCoordinate.values()].sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
}

async function evaluateLibraryRule(list, rule, { config, deps, targets, force, now, index, handoffs }) {
  const providers = libraryProviders(list, config, targets);
  const catalogues = await deps.readCatalogues(providers, config, { force });
  for (const provider of providers) {
    const catalogue = catalogues[provider];
    if (catalogue?.status !== "ok") throw new Error(`The ${provider} library could not be read: ${catalogue?.error || catalogue?.status || "no answer"}`);
    // A library that reads as empty is treated as a failed read, never as
    // every title leaving.
    if (!catalogue.items.length) throw new Error(`The ${provider} library read came back empty.`);
  }
  const mediaType = list.kind === "tv" ? "tv" : "movie";
  const since = rule.addedWithinDays === null ? null : now - rule.addedWithinDays * DAY_MS;
  let titles = mergeLibraryTitles(catalogues, mediaType)
    .filter((title) => genresMatch(rule, title.genre_keys, mediaType) && yearMatches(rule, title.year))
    .filter((title) => since === null || (title.added_at !== null && title.added_at >= since))
    .filter(notHandedOff(handoffs, mediaType === "movie" ? "movie" : "show"));
  if (ruleLanguages(rule).length) {
    const languages = await deps.titleLanguages(mediaType, titles);
    titles = titles.filter((title, position) => languageMatches(rule, languages[position]));
  }
  if (mediaType === "movie") {
    const keep = watchedFilter(rule, index ? index.movie : () => false);
    titles = titles.filter((title) => keep(title.ids));
    return pickMovies(rule, await rankLibraryTitles(rule, mediaType, titles, deps, now), list.id);
  }
  const today = todayOf(now);
  return pickShows(rule, await rankLibraryTitles(rule, mediaType, titles, deps, now), async (show, after) => (
    pickNextEpisode(await libraryEpisodes(show, providers, config, deps), after, today)
  ), index, list.id);
}

// Your titles in the type's ranking (decision 70): Top rated by the apps'
// rating (unrated last); the others keep your titles on the matching TMDB
// list, in its rank, matched by TMDB id.
async function rankLibraryTitles(rule, mediaType, titles, deps, now) {
  const type = ruleType(rule);
  const byTitle = (a, b) => text(a.title).localeCompare(text(b.title)) || identityOf(a).localeCompare(identityOf(b));
  if (type === "top") return [...titles].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || byTitle(a, b));
  const byTmdb = new Map();
  for (const title of titles) if (text(title.ids.tmdb) && !byTmdb.has(text(title.ids.tmdb))) byTmdb.set(text(title.ids.tmdb), title);
  // TV keeps spare shows, as a show without a next episode drops out.
  const wanted = rule.limit === null ? Infinity : (mediaType === "tv" ? rule.limit * 2 : rule.limit);
  const ranked = [];
  await readTmdbList(rule, mediaType, deps, now, (result) => {
    const title = byTmdb.get(text(result.id));
    if (!title) return false;
    byTmdb.delete(text(result.id));
    ranked.push(title);
    return ranked.length >= wanted || !byTmdb.size;
  });
  return ranked;
}

// --- Catalogue source (TMDB Discover) -------------------------------------

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// TMDB Discover parameters for the rule's type (decision 69) and filters.
// Trending has its own endpoint, which takes no filters.
function discoverParams(rule, kind, now) {
  const dateField = kind === "tv" ? "first_air_date" : "primary_release_date";
  const type = ruleType(rule);
  const groups = rule.genres.map((name) => tmdbGenreIds(kind, name));
  const params = { sort_by: type === "top" ? "vote_average.desc" : "popularity.desc" };
  if (type === "top") params["vote_count.gte"] = TOP_MIN_VOTES[kind];
  const leftOut = leftOutGenres(rule, kind).flatMap((key) => TMDB_GENRES.tv.filter((genre) => genreKey(genre.name) === key).map((genre) => genre.id));
  if (leftOut.length) params.without_genres = leftOut.join(",");
  if (groups.length) {
    // TMDB joins with "," for all and "|" for any; a compound genre under
    // "all" cannot be written that way, so it asks for any and filters here.
    params.with_genres = rule.genreMatch === "all" && groups.every((ids) => ids.length === 1)
      ? groups.map((ids) => ids[0]).join(",")
      : [...new Set(groups.flat())].join("|");
  }
  // TMDB joins original languages with "|" for any; results are also
  // filtered here by the language each one reports.
  if (ruleLanguages(rule).length) params.with_original_language = ruleLanguages(rule).join("|");
  const today = isoDay(now);
  let from = rule.yearFrom === null ? "" : `${rule.yearFrom}-01-01`;
  const yearEnd = rule.yearTo === null ? "" : `${rule.yearTo}-12-31`;
  // Announced, unreleased titles are never picked.
  const to = yearEnd && yearEnd < today ? yearEnd : today;
  if (type === "new" && kind === "movie") {
    // In cinemas now: a theatrical release in the last few weeks.
    const windowStart = isoDay(now - NEW_MOVIE_WINDOW_DAYS * DAY_MS);
    if (!from || from < windowStart) from = windowStart;
    params.with_release_type = "2|3";
  }
  if (type === "new" && kind === "tv") {
    // On the air now: an episode airing in the coming week.
    params["air_date.gte"] = today;
    params["air_date.lte"] = isoDay(now + NEW_TV_WINDOW_DAYS * DAY_MS);
  }
  if (from) params[`${dateField}.gte`] = from;
  params[`${dateField}.lte`] = to;
  return params;
}

// Pages the rule's TMDB list in rank order, calling `visit(result)` for each
// result until it returns true, the list ends, or the page cap is reached.
// Any failed page throws, so a check never works from a partial list.
async function readTmdbList(rule, kind, deps, now, visit) {
  const type = ruleType(rule);
  const params = type === "trending" ? null : discoverParams(rule, kind, now);
  for (let page = 1; page <= TMDB_PAGE_CAP; page += 1) {
    const body = type === "trending"
      ? await deps.trendingPage({ mediaType: kind, page })
      : await deps.discoverPage({ mediaType: kind, params: { ...params, page } });
    if (!body || !Array.isArray(body.results)) throw new Error(`TMDB ${type === "trending" ? "Trending" : "Discover"} returned no results list.`);
    for (const result of body.results) if (visit(result)) return;
    if (page >= Number(body.total_pages || 1)) return;
  }
}

function catalogueTitle(kind, result) {
  const names = new Map(TMDB_GENRES[kind].map((genre) => [genre.id, genre.name]));
  const releaseDate = text(kind === "tv" ? result.first_air_date : result.release_date);
  return {
    title: text(kind === "tv" ? result.name : result.title),
    year: Number(releaseDate.slice(0, 4)) || null,
    release_date: releaseDate,
    overview: text(result.overview),
    rating: Number.isFinite(Number(result.vote_average)) ? Number(result.vote_average) : null,
    ids: { tmdb: text(result.id), tvdb: "", imdb: "" },
    original_language: normalizeLanguageCode(result.original_language),
    genre_keys: (result.genre_ids || []).map((id) => names.get(Number(id))).filter(Boolean).map(genreKey),
    poster_url: text(result.poster_path) ? `https://image.tmdb.org/t/p/w342${text(result.poster_path)}` : "",
  };
}

// A catalogue show's next episode from TMDB, reading only the seasons from the
// furthest watched one upward and stopping at the first pick, so most shows
// need two calls. No seasons, or none left, gives null.
export async function fetchShowNextEpisode(show, after, today, deps = showConversionDeps) {
  const details = await deps.getDetails({
    mediaType: "tv",
    tmdbId: text(show.tmdb_id),
    title: text(show.title),
    ids: { tvdbId: text(show.tvdb_id), imdbId: text(show.imdb_id) },
    lane: "sync",
  });
  const tmdbId = text(show.tmdb_id) || text(details?.id);
  const tvdbId = text(details?.external_ids?.tvdb_id) || text(show.tvdb_id);
  const seasonNumbers = [...new Set((details?.seasons || [])
    .map((season) => Number(season?.season_number))
    .filter((number) => Number.isInteger(number) && number > 0 && (!after || number >= after.season)))].sort((a, b) => a - b);
  for (const seasonNumber of seasonNumbers) {
    const season = await deps.getSeason({ tmdbId, tvdbId, seasonNumber, lane: "sync" });
    const episodes = (season?.episodes || []).map((entry) => ({
      season: seasonNumber,
      episode: Number(entry?.episode_number),
      title: text(entry?.name),
      overview: text(entry?.overview).slice(0, 4000),
      air_date: text(entry?.air_date).slice(0, 40),
    })).filter((entry) => Number.isInteger(entry.episode) && entry.episode > 0);
    const later = episodes.filter((entry) => !after || entry.season > after.season || entry.episode > after.episode);
    if (later.length) return pickNextEpisode(later, null, today);
  }
  return null;
}

async function evaluateCatalogueRule(list, rule, { deps, now, index, handoffs }) {
  const kind = list.kind === "tv" ? "tv" : "movie";
  const keepMovie = watchedFilter(rule, index ? index.movie : () => false);
  const keepTitle = notHandedOff(handoffs, kind === "tv" ? "show" : "movie");
  // TV candidates are kept beyond the limit, as a show drops out when it is
  // fully watched or its next episode has not aired.
  const collectTarget = kind === "tv" ? rule.limit * 2 : rule.limit;
  const today = todayOf(now);
  const titles = [];
  const seen = new Set();
  await readTmdbList(rule, kind, deps, now, (result) => {
    const title = catalogueTitle(kind, result);
    if (!title.ids.tmdb || seen.has(title.ids.tmdb) || !title.title) return false;
    seen.add(title.ids.tmdb);
    // Trending takes no filters, so every filter is also applied here.
    if (!genresMatch(rule, title.genre_keys, kind) || !yearMatches(rule, title.year)) return false;
    if (title.release_date > today) return false;
    if (!languageMatches(rule, title.original_language)) return false;
    if (kind === "movie" && !keepMovie(title.ids)) return false;
    if (!keepTitle(title)) return false;
    titles.push(title);
    return titles.length >= collectTarget;
  });
  if (kind === "movie") return pickMovies(rule, titles, list.id);
  return pickShows(rule, titles, async (show, after) => {
    try {
      return await deps.showNextEpisode({ title: show.title, tmdb_id: show.ids.tmdb }, after, today);
    } catch (error) {
      // A definite "not found" (a new show with no TVDB id yet) leaves that
      // show out; any other failure fails the whole check.
      if (Number(error?.status) === 404) return null;
      throw error;
    }
  }, index, list.id);
}

// --- Evaluate and apply ---------------------------------------------------

export const playlistRuleDeps = Object.freeze({
  readCatalogues: (providers, config, options) => readLibraryCatalogues(providers, config, options),
  discoverPage: (request) => discoverTmdbPage({ ...request, lane: "sync" }),
  trendingPage: (request) => trendingTmdbPage({ ...request, lane: "sync" }),
  seriesEpisodes: (provider, providerConfig, seriesId) => readLibrarySeriesEpisodes(provider, providerConfig, seriesId),
  showNextEpisode: (show, after, today) => fetchShowNextEpisode(show, after, today),
  titleLanguages: (mediaType, titles) => readTitleLanguages(mediaType, titles),
  watchIndex: () => readWatchIndex(),
  now: () => Date.now(),
});

const selectListStmt = db.prepare("SELECT * FROM personal_lists WHERE id = ?");
const selectTargetsStmt = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? ORDER BY provider ASC");
const selectItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const fillPosterStmt = db.prepare("UPDATE personal_list_items SET poster_url = ? WHERE list_id = ? AND media_key = ? AND COALESCE(poster_url, '') = ''");
const selectDueListsStmt = db.prepare(`
  SELECT id FROM personal_lists
  WHERE rule_json IS NOT NULL AND deleted_at IS NULL AND (rule_checked_at IS NULL OR rule_checked_at <= ?)
  ORDER BY COALESCE(rule_checked_at, 0) ASC, id ASC
`);
const markCheckedStmt = db.prepare("UPDATE personal_lists SET rule_checked_at = ?, rule_error = ? WHERE id = ?");
const holdStmt = db.prepare("UPDATE personal_lists SET rule_hold_json = ?, rule_hold_confirmed_at = NULL, rule_checked_at = ?, rule_error = NULL WHERE id = ?");
const clearHoldStmt = db.prepare("UPDATE personal_lists SET rule_hold_json = NULL, rule_hold_confirmed_at = NULL WHERE id = ?");
const confirmHoldStmt = db.prepare("UPDATE personal_lists SET rule_hold_confirmed_at = ? WHERE id = ? AND rule_hold_json IS NOT NULL");
const deleteItemStmt = db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?");
const insertItemStmt = db.prepare(`
  INSERT INTO personal_list_items
    (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date,
     show_title, season, episode, position, created_at, updated_at)
  VALUES (@list_id, @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date,
     @show_title, @season, @episode, @position, @now, @now)
  ON CONFLICT(list_id, media_key) DO NOTHING
`);
const setPositionStmt = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
const touchOrderStmt = db.prepare("UPDATE personal_lists SET order_updated_at = ?, updated_at = ? WHERE id = ?");

export async function evaluatePlaylistRule(list, { config, deps = playlistRuleDeps, force = false } = {}) {
  const rule = parsePlaylistRule(list.rule_json);
  if (!rule) throw new Error("The playlist rule could not be read.");
  const now = deps.now();
  const index = list.kind === "tv" || rule.watched !== "any" ? deps.watchIndex() : null;
  const handoffs = readHandoffKeys(list.id);
  const context = { config, deps, targets: selectTargetsStmt.all(list.id), force, now, index, handoffs };
  const rows = rule.source === "catalogue" ? await evaluateCatalogueRule(list, rule, context) : await evaluateLibraryRule(list, rule, context);
  const seen = new Set();
  return rows.filter((row) => row.media_key && !seen.has(row.media_key) && seen.add(row.media_key));
}

// Replaces the items with the desired list, or holds the whole update when it
// removes at least 3 items that are also more than half the playlist, unless
// the user confirmed the hold (decisions 41, 47). Unlocked: callers hold the
// playlist lock.
export function applyPlaylistRuleResult(listId, rows, now = Date.now()) {
  return transaction(() => {
    const list = selectListStmt.get(listId);
    if (!list || list.deleted_at || !list.rule_json) return { status: "skipped" };
    // A title removed while this check was reading stays out (decision 65).
    const handoffs = readHandoffKeys(listId);
    rows = rows.filter((row) => !isHandedOff(row, handoffs));
    const current = selectItemsStmt.all(listId);
    const desired = new Set(rows.map((row) => row.media_key));
    const removals = current.filter((item) => !desired.has(item.media_key));
    // An episode replaced by its show's next one is not a title leaving, so
    // it does not count toward the hold (decision 59).
    const showKeys = (item) => idKeys("show", { tmdb: item.tmdb_id, tvdb: item.tvdb_id, imdb: item.imdb_id });
    const desiredShows = new Set(rows.filter((row) => row.media_type === "episode").flatMap(showKeys));
    const leaving = removals.filter((item) => item.media_type !== "episode" || !showKeys(item).some((key) => desiredShows.has(key)));
    const mass = leaving.length >= MASS_REMOVAL_MIN && leaving.length * 2 > current.length;
    if (mass && !list.rule_hold_confirmed_at) {
      holdStmt.run(JSON.stringify({ removal_count: removals.length, item_count: current.length, desired_count: rows.length, held_at: now }), now, listId);
      return { status: "held", removed: removals.length };
    }
    const existing = new Set(current.map((item) => item.media_key));
    for (const item of removals) deleteItemStmt.run(listId, item.media_key);
    let added = 0;
    rows.forEach((row, position) => {
      if (existing.has(row.media_key)) {
        if (row.poster_url) fillPosterStmt.run(row.poster_url, listId, row.media_key);
        return;
      }
      insertItemStmt.run({ list_id: listId, overview: "", poster_url: "", ...row, position, now });
      added += 1;
    });
    const before = current.filter((item) => desired.has(item.media_key)).map((item) => item.media_key);
    const kept = rows.filter((row) => existing.has(row.media_key)).map((row) => row.media_key);
    const reordered = before.some((key, index) => key !== kept[index]);
    rows.forEach((row, position) => setPositionStmt.run(position, listId, row.media_key));
    const changed = added > 0 || removals.length > 0 || reordered;
    if (changed) touchOrderStmt.run(now, now, listId);
    clearHoldStmt.run(listId);
    markCheckedStmt.run(now, null, listId);
    return { status: changed ? "changed" : "unchanged", added, removed: removals.length, reordered };
  });
}

// Playlists whose rule check is running in this process, so the page can keep
// showing "Refreshing" after a reload (decision 63).
const checkingRules = new Set();

export function isPlaylistRuleChecking(listId) {
  return checkingRules.has(text(listId));
}

// Evaluates one automatic playlist and applies the result. A failed read
// leaves the items as they are and records why.
export async function checkPlaylistRule(listId, options = {}) {
  const id = text(listId);
  checkingRules.add(id);
  bumpDataVersion();
  try {
    return await runPlaylistRuleCheck(id, options);
  } finally {
    checkingRules.delete(id);
    bumpDataVersion();
  }
}

async function runPlaylistRuleCheck(listId, { config, deps = {}, force = false } = {}) {
  const resolvedDeps = { ...playlistRuleDeps, ...deps };
  const list = selectListStmt.get(listId);
  if (!list || list.deleted_at || !list.rule_json) return { listId, status: "skipped" };
  // Watched items leave first, so their hand-offs keep them out of this check.
  if (list.remove_watched) {
    const { removed } = await withPlaylistLock(list.id, async () => applyRemoveWatched(list.id, { index: resolvedDeps.watchIndex(), now: resolvedDeps.now() }));
    if (removed) bumpDataVersion();
  }
  let rows;
  try {
    rows = await evaluatePlaylistRule(list, { config, deps: resolvedDeps, force });
  } catch (error) {
    const message = errorText(error);
    markCheckedStmt.run(resolvedDeps.now(), message, list.id);
    bumpDataVersion();
    console.warn(`[playlists] Rule check of playlist ${list.id} failed; items left unchanged: ${message}`);
    return { listId: list.id, status: "error", error: message };
  }
  const result = await withPlaylistLock(list.id, async () => applyPlaylistRuleResult(list.id, rows, resolvedDeps.now()));
  bumpDataVersion();
  return { listId: list.id, ...result };
}

// The items that last sent each playlist to a move-on check, so a check that
// fails is not repeated every pass for the same watch.
const moveOnAttempts = new Map();

// Automatic playlists not checked in the last hour (decision 36), then those
// with the switch off whose show was watched since, so it moves on to its next
// episode at this pass (decision 68).
export async function checkDuePlaylistRules({ config, deps = {}, now = Date.now() } = {}) {
  const results = [];
  for (const { id } of selectDueListsStmt.all(now - RULE_CHECK_INTERVAL_MS)) {
    results.push(await checkPlaylistRule(id, { config, deps }));
  }
  const index = (deps.watchIndex || playlistRuleDeps.watchIndex)();
  const moveOn = automaticPlaylistsToMoveOn({ index });
  for (const id of [...moveOnAttempts.keys()]) if (!moveOn.includes(id)) moveOnAttempts.delete(id);
  for (const id of moveOn) {
    const attempt = selectItemsStmt.all(id).map((item) => {
      const furthest = item.media_type === "episode" ? index.furthestEpisode({ tmdb: item.tmdb_id, tvdb: item.tvdb_id, imdb: item.imdb_id }) : null;
      return `${item.media_key}@${furthest ? `${furthest.season}x${furthest.episode}` : ""}`;
    }).join("\n");
    if (moveOnAttempts.get(id) === attempt || results.some((entry) => entry.listId === id)) continue;
    moveOnAttempts.set(id, attempt);
    results.push(await checkPlaylistRule(id, { config, deps }));
  }
  return results;
}

const stopRuleStmt = db.prepare(`
  UPDATE personal_lists
  SET rule_json = NULL, rule_error = NULL, rule_hold_json = NULL, rule_hold_confirmed_at = NULL, updated_at = ?
  WHERE id = ?
`);

// Stop updating (decision 42): the current items stay as an ordinary two-way
// playlist. A last one-way push first makes every app playlist, and the
// ledger, match the items, so app edits made while it was automatic are not
// imported afterwards. `push: false` (web-only processes) skips that push; the
// worker's next pass then diffs against the ledger of the last push.
export async function stopPlaylistRule(listId, { config = null, deps = {}, push = true } = {}) {
  return withPlaylistLock(text(listId), async (id) => {
    const list = selectListStmt.get(id);
    if (!list || list.deleted_at || !list.rule_json) return { listId: id, status: "not_automatic" };
    let providers = [];
    if (push && selectTargetsStmt.all(id).length) {
      providers = (await runPlaylistPush(id, { config: config || await loadMediaConfig(), deps: { ...playlistLibraryDeps, ...deps } })).providers;
    }
    stopRuleStmt.run(Date.now(), id);
    bumpDataVersion();
    return { listId: id, status: "stopped", providers };
  });
}

export function confirmPlaylistRuleHold(listId, now = Date.now()) {
  return confirmHoldStmt.run(now, text(listId)).changes > 0;
}

// Discard keeps the current items; the next hourly check asks again if the
// titles still do not match (decision 48).
export function discardPlaylistRuleHold(listId) {
  const list = selectListStmt.get(text(listId));
  if (!list?.rule_hold_json) return false;
  clearHoldStmt.run(list.id);
  return true;
}
