import { db } from "../db.js";
import { yieldToEventLoop } from "./eventLoop.js";
import { getCachedShows, loadTrackedEpisodeRows, queryShowDetail, showTitleFrom } from "./dataRepo.js";
import { getCachedTmdbDetails, getCachedTmdbSeason } from "./tmdbGateway.js";
import { getCanonicalPosterUrl, getCanonicalSeasonPosterUrls } from "./mediaArtwork.js";
import { minResumePositionMs, watchedThresholdPercent } from "./tuning.js";
import {
  mergeUpNextCandidates,
  normalizeUpNextCandidate,
  sortUpNextItems,
  upNextIdentityAliases,
  upNextUpdateTime,
} from "./upNextIdentity.js";
import {
  getUpNextFeedSourceVersion,
  isPlektPrimaryUpNextFeed,
  listActiveUpNextProviderItems,
  listUpNextProviderFeedStates,
} from "./upNextRepository.js";
import { createUpNextLibraryEpisodeLookup, createUpNextLibraryLookup, topUpUpNextLibraryLookups } from "./upNextLibraryLookup.js";
import { createUpNextDismissalFilter } from "./upNextDismissals.js";
import { listManualUpNextShows } from "./upNextManual.js";
import { compareCoordinates, episodeAfter, rewatchPosition, withUpNextLanes } from "./upNextRewatch.js";
import { isDemoMode } from "./demoMode.js";

const LOCAL_METADATA_CONCURRENCY = 4;
// Longest synchronous slice of the local Up Next projection before it yields.
const LOCAL_PROJECTION_YIELD_MS = 20;
const MAX_PROVIDER_OBSERVATIONS = 500;
// Per show, not per build: the first released unwatched episode is the one
// that matters, and a show whose next two episodes are both absent is a show
// with nothing to queue.
const MAX_LIBRARY_LOOKUPS_PER_SHOW = 2;
const UP_NEXT_PROVIDERS = new Set(["plex", "emby", "jellyfin"]);
// Bump when the provider poster proxy contract changes so browsers do not
// retain a stale negative response for the old URL.
const PROVIDER_POSTER_URL_VERSION = "2";

const selectProgressRowsStmt = db.prepare(
  "SELECT * FROM playback_progress WHERE position_ms > 0 ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC",
);
const selectPlaystateRowsStmt = db.prepare(
  "SELECT * FROM playstate ORDER BY COALESCE(updated_at, 0) DESC, media_key DESC",
);
const selectShowPosterFromHistoryStmt = db.prepare(`
  SELECT NULLIF(poster_url, '') AS poster_url
  FROM watch_history
  WHERE media_type = 'episode'
    AND show_title IS NOT NULL
    AND show_title != ''
    AND LOWER(show_title) = LOWER(?)
    AND NULLIF(poster_url, '') IS NOT NULL
  ORDER BY watched_at DESC
  LIMIT 1
`);

function showPosterFromHistory(item = {}) {
  const title = text(item.show_title || showTitleFrom(item.title || ""));
  if (!title) return "";
  try {
    const row = selectShowPosterFromHistoryStmt.get(title);
    return text(row?.poster_url);
  } catch {
    return "";
  }
}

function text(value = "") {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRegularUpNextEpisode(candidate = {}) {
  if (candidate.media_type !== "episode") return true;
  const season = number(candidate.season, NaN);
  const episode = number(candidate.episode, NaN);
  // Specials are useful in a show's detail page, but S00 is not a linear
  // season to continue in the dashboard rail. Provider feeds occasionally
  // expose specials as their next item, so keep them out of Up Next.
  return Number.isInteger(season) && season > 0
    && Number.isInteger(episode) && episode > 0;
}

function coordinate(row = {}) {
  const season = number(row.season, NaN);
  const episode = number(row.episode, NaN);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

// Canonical progress rows carry the series identity ingest resolved for them.
// When that identity has its own TMDB/TVDB resolution and shares no id with
// the only show known by the same title, it is a different show with the same
// name (Scrubs 2001 against the 2026 reboot), not a gap to fill by title.
// Mirrors the ingest rule in docs/decisions.md entry 34. Provider feed items
// are left alone: they carry episode-level ids that never match a series.
function canonicalIdsDisagreeWithShow(item = {}, ids = null) {
  if (!ids || !(text(item.tmdb_id) || text(item.tvdb_id))) return false;
  return !["imdb", "tmdb", "tvdb"].some((provider) => {
    const own = text(item[`${provider}_id`]).toLowerCase();
    return own && ids[provider] && own === String(ids[provider]).toLowerCase();
  });
}

// A canonical episode key is built from the series id ingest resolved
// (`episode:1:4:imdb:tt0285403`, docs/decisions.md entry 15). When the row's
// own id is the one in its key, its flattened ids are series ids.
function seriesKeyedRowIds(row = {}) {
  const match = /^episode:\d+:\d+:(imdb|tmdb|tvdb):(.+)$/i.exec(text(row.media_key));
  if (!match || text(row[`${match[1].toLowerCase()}_id`]).toLowerCase() !== match[2].toLowerCase()) return null;
  return { imdb: row.imdb_id || "", tmdb: row.tmdb_id || "", tvdb: row.tvdb_id || "" };
}

// Those flattened series ids read as episode ids when the row gets no show
// ids (no title profile, or a title two shows share), so every episode of the
// show shared one `episode:imdb:<series id>` alias and the newest state
// anywhere in the show answered for all of them: reboot Scrubs S01E04 and
// S01E06, both unwatched, read as watched from the S01E05 watch, and Up Next
// skipped to S01E07. Replace them with series aliases scoped to the row's own
// episode, one per id, so an imdb-keyed history row still finds the same
// episode's tvdb-keyed playstate row.
function seriesKeyedStateAliases(row = {}, aliases = []) {
  const ids = seriesKeyedRowIds(row);
  if (!ids) return new Set(aliases);
  const [, season, episode] = /^episode:(\d+):(\d+):/i.exec(text(row.media_key)).map(Number);
  const values = new Map(["imdb", "tmdb", "tvdb"]
    .filter((provider) => text(ids[provider]))
    .map((provider) => [provider, text(ids[provider]).toLowerCase()]));
  const scoped = new Set([...aliases].filter((alias) => {
    const match = /^episode:(imdb|tmdb|tvdb):(.+)$/.exec(alias);
    return !match || values.get(match[1]) !== match[2];
  }));
  for (const [provider, value] of values) scoped.add(`episode|series:${provider}:${value}|s:${season}|e:${episode}`);
  return scoped;
}

// The aliases a local history or playstate row's own state is looked up by.
// A series-keyed row knows its show, so a title two shows share must not
// answer for it.
function rowStateAliases(row = {}, { showIdentities = null, ambiguousTitles = null } = {}) {
  const candidate = rowCandidate(row, { queueKind: "next_up", showIdentities });
  const aliases = seriesKeyedStateAliases(row, upNextIdentityAliases(candidate));
  const titleKey = text(showTitleFrom(candidate.show_title || "")).toLowerCase();
  if (seriesKeyedRowIds(row) && ambiguousTitles?.has(titleKey) && candidate.canonical_key.startsWith("episode|title:")) {
    aliases.delete(candidate.canonical_key);
  }
  return aliases;
}

// A title profile built from history can know fewer ids than the show really
// has (Scot Squad's history rows carry only tvdb 264603). A series-keyed row
// that shares an id with it fills the profile's empty slots, so its card keys
// by the same series id as the provider observations instead of becoming a
// second, tvdb-keyed card. Ids the profile does hold always win.
function titleShowIdsFilledFromRow(titleShowIds = null, rowIds = null) {
  if (!titleShowIds) return {};
  const shares = rowIds && ["imdb", "tmdb", "tvdb"].some((provider) => {
    const own = text(rowIds[provider]).toLowerCase();
    return own && titleShowIds[provider] && own === String(titleShowIds[provider]).toLowerCase();
  });
  if (!shares) return titleShowIds;
  return {
    imdb: titleShowIds.imdb || rowIds.imdb || null,
    tmdb: titleShowIds.tmdb || rowIds.tmdb || null,
    tvdb: titleShowIds.tvdb || rowIds.tvdb || null,
  };
}

function rowCandidate(row = {}, { queueKind = "resume", canonical = false, showIdentities = null, ambiguousTitles = null } = {}) {
  const isEpisode = row.media_type === "episode";
  const showTitle = isEpisode ? text(row.show_title || showTitleFrom(row.title || "")) : "";
  const titleKey = text(showTitleFrom(showTitle)).toLowerCase();
  const titleShowIds = isEpisode ? showIdentities?.get(titleKey) || null : null;
  // A same-title show's row keeps its own series ids as show ids, so it joins
  // the provider observations of that show instead of becoming a title card.
  const disagrees = isEpisode && canonical && (ambiguousTitles?.has(titleKey)
    || Boolean(titleShowIds && canonicalIdsDisagreeWithShow(row, titleShowIds)));
  const localShowIds = disagrees
    ? seriesKeyedRowIds(row) || {}
    : titleShowIdsFilledFromRow(titleShowIds, isEpisode && canonical ? seriesKeyedRowIds(row) : null);
  // The bundled demo deliberately stores series ids on its compact progress
  // rows, because there are no provider-specific episode ids in an offline
  // fixture. Treat those ids as show ids only for demo rows; real libraries
  // must continue to use explicit show_* fields or verified local identity.
  const demoShowIds = isEpisode && text(row.source).toLowerCase() === "demo"
    ? { imdb: row.imdb_id || "", tmdb: row.tmdb_id || "", tvdb: row.tvdb_id || "" }
    : {};
  return normalizeUpNextCandidate({
    media_key: row.media_key,
    media_type: row.media_type,
    queue_kind: queueKind,
    title: row.title,
    show_title: showTitle,
    episode_title: row.episode_title,
    season: row.season,
    episode: row.episode,
    // playback_progress does not have separate show_* columns. Its flattened
    // ids may be series ids from an older ingest, or episode ids from a
    // provider feed. Only use the local library's verified show identity here;
    // treating an episode id as a show id creates a second canonical card.
    show_ids: isEpisode ? {
      imdb: row.show_imdb_id || localShowIds.imdb || demoShowIds.imdb || "",
      tmdb: row.show_tmdb_id || localShowIds.tmdb || demoShowIds.tmdb || "",
      tvdb: row.show_tvdb_id || localShowIds.tvdb || demoShowIds.tvdb || "",
    } : undefined,
    ids: {
      imdb: row.imdb_id,
      tmdb: row.tmdb_id,
      tvdb: row.tvdb_id,
    },
    poster_url: row.poster_url,
    show_poster_url: row.show_poster_url,
    position_ms: row.position_ms,
    duration_ms: row.duration_ms,
    progress: row.progress,
    updated_at: row.updated_at,
    source: row.source || row.last_source || "local",
    sources: row.sources,
    is_canonical: canonical,
  });
}

function ensureDemoSeriesIdentity(candidate = {}, showIdentities = null) {
  if (!isDemoMode() || candidate.media_type !== "episode") return candidate;
  const key = text(showTitleFrom(candidate.show_title || candidate.title || "")).toLowerCase();
  const ids = showIdentities?.get(key) || {};
  if (!ids.imdb && !ids.tmdb && !ids.tvdb) return candidate;
  const ensured = {
    ...candidate,
    show_imdb_id: candidate.show_imdb_id || ids.imdb || null,
    // Demo playback rows use the series id in the flattened media id fields.
    // Keep this fallback scoped to demo mode; provider episode ids must never
    // be promoted to a series id in a real library.
    show_tmdb_id: candidate.show_tmdb_id || ids.tmdb || candidate.tmdb_id || null,
    show_tvdb_id: candidate.show_tvdb_id || ids.tvdb || candidate.tvdb_id || null,
  };
  return ensured;
}

function aliasesFor(candidate) {
  return new Set(upNextIdentityAliases(candidate));
}

function aliasesIntersect(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right || []);
  return [...(left instanceof Set ? left : new Set(left || []))].some((alias) => rightSet.has(alias));
}

// Resolving a candidate's playstate used to re-derive an identity for every
// canonical-state row on every lookup: a full map + aliasesFor over the whole
// table, then a sort, per episode examined. With a real library that is 8k rows
// rebuilt tens of thousands of times, and because better-sqlite3 and this
// normalization are synchronous it blocked the event loop for a full minute -
// long enough to stall every HTTP request and to let the 60s scheduler lease
// expire, which is what surfaced as the app freezing.
//
// The canonical rows are instead normalized once per projection into an alias index.
// Lookup then touches only the candidate's own aliases.
function buildCanonicalStateIndex(playstateRows = [], episodeRows = [], showIdentities = null) {
  const byAlias = new Map();
  const stateRows = [
    ...playstateRows.map((row) => ({ row, state: row.state })),
    ...episodeRows.map((row) => ({
      row,
      // Watch history is the canonical local record for manual and imported
      // watches. An explicit unwatch remains a state transition; a legacy
      // row with no sync_action is a watched row.
      state: ["unwatched", "unplayed"].includes(String(row.sync_action || "watched").toLowerCase())
        ? "unwatched"
        : "watched",
    })),
  ];
  const entries = stateRows.map(({ row, state }) => {
    const stateRow = { ...row, state };
    const aliases = new Set(upNextIdentityAliases(rowCandidate(stateRow, { queueKind: "next_up", showIdentities })));
    // The title fill above gives a same-title show's row the other show's
    // ids, so a Scrubs 2001 unwatch would never reach the 2001 provider card.
    // A series-keyed row also answers for its own identity.
    const ownIds = !(row.show_imdb_id || row.show_tmdb_id || row.show_tvdb_id) && seriesKeyedRowIds(row);
    if (ownIds) {
      const ownRow = { ...stateRow, show_imdb_id: ownIds.imdb, show_tmdb_id: ownIds.tmdb, show_tvdb_id: ownIds.tvdb };
      for (const alias of upNextIdentityAliases(rowCandidate(ownRow, { queueKind: "next_up" }))) aliases.add(alias);
      for (const alias of seriesKeyedStateAliases(row)) aliases.add(alias);
    }
    return { stateRow, aliases };
  });
  // An episode-level id names one episode. One claimed by rows at different
  // coordinates is a series id read as an episode id (seriesKeyedStateAliases)
  // and would let one episode's state answer for another, so it is not indexed.
  // A leaked real episode id (a single coordinate) stays reachable.
  const coordinatesByEpisodeAlias = new Map();
  for (const { stateRow, aliases } of entries) {
    if (!coordinate(stateRow)) continue;
    for (const alias of aliases) {
      if (!/^episode:(imdb|tmdb|tvdb):/.test(alias)) continue;
      if (!coordinatesByEpisodeAlias.has(alias)) coordinatesByEpisodeAlias.set(alias, new Set());
      coordinatesByEpisodeAlias.get(alias).add(coordinate(stateRow));
    }
  }
  entries.forEach(({ stateRow, aliases }, order) => {
    const updatedAt = number(stateRow.updated_at);
    for (const alias of aliases) {
      if ((coordinatesByEpisodeAlias.get(alias)?.size || 0) > 1) continue;
      const existing = byAlias.get(alias);
      if (!existing || updatedAt > existing.updatedAt) byAlias.set(alias, { row: stateRow, updatedAt, order });
    }
  });
  return byAlias;
}

function newestStateFor(candidate, playstateIndex) {
  return newestStateForAliases(upNextIdentityAliases(candidate), playstateIndex);
}

function newestStateForAliases(aliases, playstateIndex) {
  let best = null;
  for (const alias of aliases) {
    const entry = playstateIndex.get(alias);
    if (!entry) continue;
    // Ties resolve to the row that came first in the query's own ordering,
    // matching the stable sort this replaced.
    if (!best || entry.updatedAt > best.updatedAt || (entry.updatedAt === best.updatedAt && entry.order < best.order)) {
      best = entry;
    }
  }
  return best?.row || null;
}

function stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt = 0 } = {}) {
  const state = newestStateFor(candidate, playstateIndex);
  if (!state) return false;
  const stateTime = number(state.updated_at);
  // A newer explicit watched or unwatched transition wins over a stale feed
  // observation. A genuinely newer playback position can start again after an
  // unwatch, so the timestamp comparison is intentional.
  return stateTime <= 0 || progressUpdatedAt <= 0 || stateTime >= progressUpdatedAt;
}

function stateIsWatched(candidate, playstateIndex) {
  return newestStateFor(candidate, playstateIndex)?.state === "watched";
}

function stateIsUnwatched(candidate, playstateIndex) {
  return newestStateFor(candidate, playstateIndex)?.state === "unwatched";
}

function showIdentityKeys(item = {}) {
  const keys = [];
  for (const [provider, values] of [
    ["imdb", [item.show_imdb_id, item.imdb_id]],
    ["tmdb", [item.show_tmdb_id, item.tmdb_id]],
    ["tvdb", [item.show_tvdb_id, item.tvdb_id]],
  ]) {
    for (const value of values) {
      const normalized = text(value).toLowerCase();
      if (normalized) keys.push(`${provider}:${normalized}`);
    }
  }
  const title = normalizedTitle(item.show_title || item.title || showTitleFrom(item.name || ""));
  if (title) keys.push(`title:${title}`);
  return [...new Set(keys)];
}

function showIsCompleted(item = {}) {
  const watchedEpisodes = Number(item.episode_count || 0);
  const totalEpisodes = Number(item.total_episodes || 0);
  return totalEpisodes > 0 && watchedEpisodes >= totalEpisodes;
}

// The series TMDB/TVDB ids an item names. Episode items carry episode ids in
// their plain fields, so only their show_* fields count.
function showTmdbTvdbIds(item = {}) {
  const episode = item.media_type === "episode";
  return {
    tmdb: text(item.show_tmdb_id || (episode ? "" : item.tmdb_id)).toLowerCase(),
    tvdb: text(item.show_tvdb_id || (episode ? "" : item.tvdb_id)).toLowerCase(),
  };
}

function tmdbTvdbConflict(left = {}, right = {}) {
  return ["tmdb", "tvdb"].some((provider) => left[provider] && right[provider] && left[provider] !== right[provider]);
}

// Records, per title key, the series ids of the evidence that added it, so a
// title-only match can be checked against them (showEligibleForUpNext).
function addTitleEvidence(titleIds, keys, item) {
  if (!titleIds) return;
  const ids = showTmdbTvdbIds(item);
  for (const key of keys) {
    if (!key.startsWith("title:")) continue;
    if (!titleIds.has(key)) titleIds.set(key, []);
    titleIds.get(key).push(ids);
  }
}

function buildShowStateKeys(episodeRows = [], playstateIndex, showIdentities, expectedState, titleIds = null, ambiguousTitles = null) {
  const keys = new Set();
  for (const row of episodeRows) {
    const candidate = rowCandidate(row, { queueKind: "next_up", showIdentities });
    const aliases = rowStateAliases(row, { showIdentities, ambiguousTitles });
    if (newestStateForAliases(aliases, playstateIndex)?.state !== expectedState) continue;
    const candidateKeys = showIdentityKeys(candidate);
    for (const key of candidateKeys) keys.add(key);
    addTitleEvidence(titleIds, candidateKeys, candidate);
  }
  return keys;
}

function buildWatchedShowKeys(episodeRows = [], playstateIndex, showIdentities, shows = [], titleIds = null, ambiguousTitles = null) {
  const watchedShowKeys = buildShowStateKeys(episodeRows, playstateIndex, showIdentities, "watched", titleIds, ambiguousTitles);
  for (const show of Array.isArray(shows) ? shows : []) {
    if (!text(show.latest_watched_at)) continue;
    const showKeys = showIdentityKeys(show);
    for (const key of showKeys) watchedShowKeys.add(key);
    addTitleEvidence(titleIds, showKeys, show);
  }
  return watchedShowKeys;
}

function buildCompletedShowKeys(shows = []) {
  const completedShowKeys = new Set();
  for (const show of Array.isArray(shows) ? shows : []) {
    if (!showIsCompleted(show)) continue;
    for (const key of showIdentityKeys(show)) completedShowKeys.add(key);
  }
  return completedShowKeys;
}

function showEligibleForUpNext(
  item,
  { watchedShowKeys, unwatchedShowKeys, manualShowKeys, completedShowKeys, watchedTitleIds = null },
) {
  const keys = showIdentityKeys(item);
  if (!keys.length || keys.some((key) => completedShowKeys.has(key))) return false;
  // A title match is evidence only when some watch under that title could be
  // this show. Jellyfin titles the UK The Assembly "The Assembly", the name of
  // the Australian show, and that show's one watch vouched for a UK show the
  // user had cleared. A TMDB/TVDB disagreement means two shows (as in G, E, Z).
  const ownIds = showTmdbTvdbIds(item);
  const hasWatched = keys.some((key) => watchedShowKeys.has(key)
    && !(key.startsWith("title:") && watchedTitleIds?.has(key)
      && watchedTitleIds.get(key).every((ids) => tmdbTvdbConflict(ownIds, ids))));
  const hasExplicitUnwatch = keys.some((key) => unwatchedShowKeys.has(key));
  // A manually queued show with no history is intentional. A show whose
  // current records are all explicit unwatches is not: manual membership must
  // not resurrect a show the user deliberately cleared.
  if (!hasWatched && hasExplicitUnwatch) return false;
  return hasWatched || keys.some((key) => manualShowKeys.has(key));
}

function actionableResume(candidate) {
  const position = number(candidate.position_ms);
  const progress = number(candidate.progress);
  return position >= minResumePositionMs() && progress < watchedThresholdPercent();
}

function providerResumeMembership(candidate) {
  // Plex and Emby both expose a provider-curated Continue Watching rail whose
  // list items can omit playback position. Membership in that native feed is
  // still authoritative for Up Next, even when it cannot be used to
  // propagate a numeric checkpoint to another provider.
  return candidate?.queue_kind === "resume"
    && UP_NEXT_PROVIDERS.has(String(candidate?.source || "").toLowerCase())
    && Boolean(candidate?.provider_item_id);
}

function released(airDate, today) {
  const date = text(airDate);
  return !date || date <= today;
}

function episodeCoordinateForCandidate(candidate = {}) {
  const season = number(candidate.season, NaN);
  const episode = number(candidate.episode, NaN);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode <= 0) return "";
  return `${season}:${episode}`;
}

function normalizedTitle(value = "") {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function showRecencyKeys(item = {}) {
  const keys = [];
  for (const [kind, values] of [
    ["imdb", [item.show_imdb_id, item.imdb_id]],
    ["tmdb", [item.show_tmdb_id, item.tmdb_id]],
    ["tvdb", [item.show_tvdb_id, item.tvdb_id]],
  ]) {
    for (const value of values) {
      const normalized = text(value).toLowerCase();
      if (normalized) keys.push(`${kind}:${normalized}`);
    }
  }
  const title = normalizedTitle(item.show_title || showTitleFrom(item.title || ""));
  if (title) keys.push(`title:${title}`);
  return [...new Set(keys)];
}

// Provider Next Up feeds routinely omit series-level provider ids, so an
// episode can arrive carrying only its own. An episode's TMDB id is not its
// show's - Reacher S04E02 came through as 7438862 while the series is 108978 -
// and building a series route from one produces a URL that resolves to nothing
// and pays the full cold-lookup cost before falling back. The library already
// knows the series identity from its own watch history, so fill it in here.
//
// Matched on title, which is only safe while the title is unambiguous: two
// different shows sharing a name must not inherit each other's ids, so a key
// that maps to more than one distinct identity is dropped rather than guessed.
export function showIdentityIndex(shows = []) {
  const index = new Map();
  const ambiguous = new Set();
  for (const show of Array.isArray(shows) ? shows : []) {
    const key = text(showTitleFrom(show.title || show.show_title || "")).toLowerCase();
    if (!key || ambiguous.has(key)) continue;
    const ids = {
      imdb: text(show.imdb_id) || null,
      tmdb: text(show.tmdb_id) || null,
      tvdb: text(show.tvdb_id) || null,
    };
    if (!ids.imdb && !ids.tmdb && !ids.tvdb) continue;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, ids);
      continue;
    }
    const differs = existing.imdb !== ids.imdb || existing.tmdb !== ids.tmdb || existing.tvdb !== ids.tvdb;
    if (differs) {
      index.delete(key);
      ambiguous.add(key);
    }
  }
  index.ambiguousTitles = ambiguous;
  return index;
}

const SERIES_ID_FIELDS = [
  ["show_imdb_id", "imdb_id"],
  ["show_tmdb_id", "tmdb_id"],
  ["show_tvdb_id", "tvdb_id"],
];

// A series id can never equal one of its own episodes' ids, so a series field
// holding the episode's id is a provider observation that was stored raw rather
// than resolved. Reacher S04E02 arrived that way - series and episode both
// 7438862 - and the route built from it resolved to nothing and loaded slowly
// before falling back. Discarding it lets the local identity below fill the gap,
// and falling back to a title route is in any case better than a broken one.
function withoutSelfReferentialSeriesIds(item = {}) {
  // A series-keyed canonical row's flattened ids are the series ids, so its
  // show ids match them by construction rather than by a raw observation.
  if (seriesKeyedRowIds(item)) return item;
  let cleaned = item;
  for (const [showKey, ownKey] of SERIES_ID_FIELDS) {
    const showId = item[showKey];
    const ownId = item[ownKey];
    if (!showId || !ownId || String(showId) !== String(ownId)) continue;
    if (cleaned === item) cleaned = { ...item };
    cleaned[showKey] = null;
  }
  return cleaned;
}

export function withLocalShowIdentity(item = {}, index) {
  if (item.media_type !== "episode") return item;
  const cleaned = withoutSelfReferentialSeriesIds(item);
  if (!index?.size) return cleaned;
  // Never overwrite an identity the provider actually supplied.
  if (cleaned.show_imdb_id || cleaned.show_tmdb_id || cleaned.show_tvdb_id) return cleaned;
  const ids = index.get(text(showTitleFrom(cleaned.show_title || cleaned.title || "")).toLowerCase());
  if (!ids) return cleaned;
  if (cleaned.is_canonical === true && canonicalIdsDisagreeWithShow(cleaned, ids)) return cleaned;
  return {
    ...cleaned,
    show_imdb_id: cleaned.show_imdb_id || ids.imdb,
    show_tmdb_id: cleaned.show_tmdb_id || ids.tmdb,
    show_tvdb_id: cleaned.show_tvdb_id || ids.tvdb,
  };
}

// Artwork that only resolves against the media server itself - a bare Plex
// `/library/metadata/.../thumb/...` path, say - is served from Plembfin's own
// origin by the browser, where it hits the SPA fallback and silently renders no
// image at all. Dropping it lets the client's normal poster resolution take
// over (`/api/poster`, then the cached artwork), which produces a real poster
// instead of a permanent placeholder.
const USABLE_ARTWORK_URL = /^(?:https?:\/\/|\/media\/|\/api\/)/;

export function withUsableArtwork(item = {}) {
  let cleaned = item;
  for (const key of ["poster_url", "show_poster_url"]) {
    const value = text(item[key]);
    if (!value || USABLE_ARTWORK_URL.test(value)) continue;
    if (cleaned === item) cleaned = { ...item };
    cleaned[key] = null;
  }
  return cleaned;
}

function showRecencyIndex(shows = []) {
  const index = new Map();
  for (const show of Array.isArray(shows) ? shows : []) {
    const latest = text(show.latest_watched_at || show.latestWatchedAt);
    if (!latest) continue;
    const ids = showTmdbTvdbIds(show);
    for (const key of showRecencyKeys({
      show_title: show.title,
      show_imdb_id: show.imdb_id,
      show_tmdb_id: show.tmdb_id,
      show_tvdb_id: show.tvdb_id,
    })) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ latest, ...ids });
    }
  }
  return index;
}

function decorateShowRecency(candidate, index) {
  if (candidate?.media_type !== "episode") return candidate;
  // A same-title show with conflicting ids is another show; its watch date
  // must not become this card's recency (see showEligibleForUpNext).
  const ownIds = showTmdbTvdbIds(candidate);
  const latest = showRecencyKeys(candidate)
    .flatMap((key) => (index.get(key) || [])
      .filter((entry) => !key.startsWith("title:") || !tmdbTvdbConflict(ownIds, entry)))
    .map((entry) => entry.latest)
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || null;
  return latest ? { ...candidate, show_latest_watched_at: latest } : candidate;
}

function providerObservationMatches(candidate, providerCandidate) {
  if (candidate?.media_type !== "episode" || providerCandidate?.media_type !== "episode") return false;
  if (!(providerCandidate.source === "plex" || providerCandidate.source === "emby")
    || !text(providerCandidate.provider_item_id)) return false;
  const coordinate = episodeCoordinateForCandidate(candidate);
  if (!coordinate || coordinate !== episodeCoordinateForCandidate(providerCandidate)) return false;

  if (aliasesIntersect(aliasesFor(candidate), aliasesFor(providerCandidate))) return true;

  const candidateShowIds = {
    imdb: text(candidate.show_imdb_id),
    tmdb: text(candidate.show_tmdb_id),
    tvdb: text(candidate.show_tvdb_id),
  };
  const providerShowIds = {
    imdb: text(providerCandidate.show_imdb_id),
    tmdb: text(providerCandidate.show_tmdb_id),
    tvdb: text(providerCandidate.show_tvdb_id),
  };
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    if (candidateShowIds[provider] && providerShowIds[provider]
      && candidateShowIds[provider].toLowerCase() !== providerShowIds[provider].toLowerCase()) {
      return false;
    }
  }

  const candidateTitle = normalizedTitle(candidate.show_title || showTitleFrom(candidate.title || ""));
  const providerTitle = normalizedTitle(providerCandidate.show_title || showTitleFrom(providerCandidate.title || ""));
  return Boolean(candidateTitle && candidateTitle === providerTitle);
}

// A TMDB or TVDB disagreement means two shows, even when another id is shared:
// a mixed-identity card (the Scrubs reboot's TMDB/IMDb ids plus the 2001 TVDB
// id) otherwise became the authoritative next episode for both shows and
// suppressed the 2001 show's real next episode. IMDb alone is not trusted to
// split, since providers sometimes report an episode's own IMDb id as the
// series id (decision 34).
function showIdsConflict(left = {}, right = {}) {
  return ["tmdb", "tvdb"].some((provider) => {
    const leftId = text(left[`show_${provider}_id`]).toLowerCase();
    const rightId = text(right[`show_${provider}_id`]).toLowerCase();
    return Boolean(leftId && rightId && leftId !== rightId);
  });
}

function episodeShowIdentityMatches(left = {}, right = {}) {
  const leftIds = {
    imdb: text(left.show_imdb_id),
    tmdb: text(left.show_tmdb_id),
    tvdb: text(left.show_tvdb_id),
  };
  const rightIds = {
    imdb: text(right.show_imdb_id),
    tmdb: text(right.show_tmdb_id),
    tvdb: text(right.show_tvdb_id),
  };
  const leftHasIds = Object.values(leftIds).some(Boolean);
  const rightHasIds = Object.values(rightIds).some(Boolean);
  if (showIdsConflict(left, right)) return false;
  const sharedId = ["imdb", "tmdb", "tvdb"].some((provider) => (
    leftIds[provider] && rightIds[provider] && leftIds[provider].toLowerCase() === rightIds[provider].toLowerCase()
  ));
  if (sharedId) return true;
  if (leftHasIds && rightHasIds) return false;
  const leftTitle = normalizedTitle(showTitleFrom(left.show_title || left.title || ""));
  const rightTitle = normalizedTitle(showTitleFrom(right.show_title || right.title || ""));
  return Boolean(leftTitle && leftTitle === rightTitle);
}

function episodeCoordinateMatches(left = {}, right = {}) {
  const leftCoordinate = episodeCoordinateForCandidate(left);
  const rightCoordinate = episodeCoordinateForCandidate(right);
  return Boolean(leftCoordinate && leftCoordinate === rightCoordinate && episodeShowIdentityMatches(left, right));
}

function matchesAuthoritativeNextEpisode(candidate, authoritativeCandidates = []) {
  if (candidate?.media_type !== "episode") return true;
  const sameShow = authoritativeCandidates.filter((authoritative) => episodeShowIdentityMatches(candidate, authoritative));
  // If the local detail page could not resolve this show, retain the provider
  // observation as the best available source. A resolved show, however, gets
  // exactly one authoritative next coordinate and provider rows may not jump
  // past it.
  return !sameShow.length || sameShow.some((authoritative) => episodeCoordinateMatches(candidate, authoritative));
}

function providerItemsFromTrackedEpisode(row = {}) {
  const provenance = row.watch_provenance && typeof row.watch_provenance === "object"
    ? row.watch_provenance
    : {};
  const provider = text(provenance.source || row.source).toLowerCase();
  const itemId = text(provenance.item_id || provenance.itemId);
  if (!itemId || !UP_NEXT_PROVIDERS.has(provider)) return {};
  return { [provider]: [itemId] };
}

function episodeIdsFromTrackedEpisode(row = {}, showIds = {}) {
  const ids = {};
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const value = text(row[`${provider}_id`]);
    if (value && value.toLowerCase() !== text(showIds[provider]).toLowerCase()) ids[provider] = value;
  }
  return ids;
}

function publicItem(item) {
  const {
    canonical_key: _canonicalKey,
    source: _source,
    is_canonical: _isCanonical,
    _aliases: _aliases,
    provider_item_id: _providerItemId,
    parent_provider_item_id: _parentProviderItemId,
    series_provider_item_id: _seriesProviderItemId,
    resolution_status: _resolutionStatus,
    last_error: _lastError,
    ...safe
  } = item;
  // The demo progress fixture uses the series TMDB id in the flattened
  // episode row. Restore the explicit show identity before choosing artwork;
  // otherwise the history fallback can win with an episode still.
  if (isDemoMode() && safe.media_type === "episode") {
    safe.show_imdb_id = safe.show_imdb_id || safe.imdb_id || null;
    safe.show_tmdb_id = safe.show_tmdb_id || safe.tmdb_id || null;
    safe.show_tvdb_id = safe.show_tvdb_id || safe.tvdb_id || null;
  }
  const providerEntries = Object.entries(item.provider_items || {})
    .map(([provider, ids]) => {
      const values = Array.isArray(ids) ? ids : ids ? [ids] : [];
      return [String(provider || "").toLowerCase(), values];
    })
    .filter(([provider, ids]) => UP_NEXT_PROVIDERS.has(provider) && ids.length);
  const preferredProvider = String(item.source || "").toLowerCase();
  const orderedProviderEntries = [
    ...providerEntries.filter(([provider]) => provider === preferredProvider),
    ...providerEntries.filter(([provider]) => provider !== preferredProvider),
  ];
  const providerPoster = orderedProviderEntries.find(([, ids]) => String(ids[0] || "").trim());
  const providerPosterUrl = providerPoster
    ? `/api/poster?id=${encodeURIComponent(String(providerPoster[1][0]))}&provider=${encodeURIComponent(providerPoster[0])}&format=image&v=${PROVIDER_POSTER_URL_VERSION}`
    : "";
  const sourceName = String(item.source || "").toLowerCase();
  const mediaKeyPosterUrl = !providerPoster
    && UP_NEXT_PROVIDERS.has(sourceName)
    && text(item.media_key)
    ? `/api/poster?id=${encodeURIComponent(String(item.media_key))}&format=image&v=${PROVIDER_POSTER_URL_VERSION}`
    : "";
  const rawPoster = String(safe.poster_url || "").trim();
  const rawShowPoster = String(safe.show_poster_url || "").trim();
  const isKnownPoster = (value) => Boolean(
    value && (
      /^\/media\/posters\//i.test(value)
      || /^\/api\/tmdb-poster/i.test(value)
      || /^https:\/\/image\.tmdb\.org\//i.test(value)
    )
  );
  // Episodes in Up Next represent the series. Reuse the shared show artwork
  // cache (and watch history show artwork) so known shows load their poster
  // instantly from local storage/cache without querying the provider proxy.
  // Movies similarly resolve their canonical poster from metadata/cache.
  const canonicalPoster = safe.media_type === "episode"
    ? (getCanonicalPosterUrl({
      media_type: "episode",
      show_title: safe.show_title,
      show_imdb_id: safe.show_imdb_id,
      show_tmdb_id: safe.show_tmdb_id,
      show_tvdb_id: safe.show_tvdb_id,
    }) || showPosterFromHistory(safe))
    : getCanonicalPosterUrl({
      media_type: "movie",
      title: safe.title,
      tmdb_id: safe.tmdb_id,
      imdb_id: safe.imdb_id,
    });
  const effectiveShowPoster = safe.media_type === "episode"
    ? (canonicalPoster || (isKnownPoster(rawShowPoster) ? rawShowPoster : ""))
    : "";
  const effectivePoster = safe.media_type === "episode"
    ? (effectiveShowPoster || (isKnownPoster(rawPoster) ? rawPoster : ""))
    : (isKnownPoster(rawPoster) ? rawPoster : canonicalPoster);
  const seasonPosterUrls = safe.media_type === "episode"
    ? getCanonicalSeasonPosterUrls({
      media_type: "tv",
      title: safe.show_title,
      tmdb_id: safe.show_tmdb_id,
      tvdb_id: safe.show_tvdb_id,
      imdb_id: safe.show_imdb_id,
    })
    : null;
  const seasonNumber = safe.season == null ? null : Number(safe.season);
  const seasonPosterUrl = Number.isInteger(seasonNumber)
    ? seasonPosterUrls?.get(seasonNumber) || safe.season_poster_url || null
    : safe.season_poster_url || null;
  return {
    ...safe,
    id: item.id,
    media_key: item.media_key,
    queue_kind: item.queue_kind,
    media_type: item.media_type,
    poster_url: effectivePoster || providerPosterUrl || mediaKeyPosterUrl || null,
    show_poster_url: effectiveShowPoster || providerPosterUrl || mediaKeyPosterUrl || null,
    season_poster_url: seasonPosterUrl,
    is_upcoming: false,
  };
}

export function publicUpNextItems(items = []) {
  return mergeUpNextCandidates(items).map(publicItem);
}

async function localNextUpForShow(show, {
  playstateIndex,
  progressCandidates,
  providerCandidates = [],
  episodeRows,
  today,
  resolveProviderItems = null,
  resolveProviderEpisodes = null,
  allowUnplayable = false,
  ambiguousTitles = null,
  laneMarkers = null,
}) {
  const detail = await queryShowDetail({
    episodeRows,
    id: show.id,
    title: show.title,
    tmdbId: show.tmdb_id,
    tvdbId: show.tvdb_id,
    imdbId: show.imdb_id,
  }).catch(() => null);
  const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];  const watched = new Set();
  for (const row of episodes) {
    const canonicalState = newestStateForAliases(rowStateAliases(row, { ambiguousTitles }), playstateIndex)?.state;
    const isWatched = canonicalState === "watched"
      || (!canonicalState && String(row.sync_action || "watched").toLowerCase() !== "unwatched");    if (isWatched) {
      const key = coordinate(row);
      if (key) watched.add(key);
    }
  }

  const metadata = getCachedTmdbDetails({
    mediaType: "tv",
    tmdbId: show.tmdb_id,
    title: show.title,
    ids: { tvdbId: show.tvdb_id, imdbId: show.imdb_id },
  });
  const tmdbId = text(show.tmdb_id || metadata?.id);
  const tvdbId = text(show.tvdb_id || metadata?.external_ids?.tvdb_id);
  // Provider inventory can resolve a show by title alone. Keep this fallback
  // available even when the local record has no external metadata identity.
  if (!tmdbId && !tvdbId && !resolveProviderEpisodes) return [];

  const seasonNumbers = [...new Set((metadata?.seasons || [])
    .map((season) => number(season.season_number, NaN))
    .filter((season) => Number.isInteger(season) && season > 0))]
    .sort((left, right) => left - right);
  // Episode rows also include provider-supplied unplayed/future rows. They
  // must not make the fallback jump from the last watched S03 episode to an
  // unrelated S04 placeholder; choose the season from watched coordinates
  // only, then scan later seasons if that season is exhausted.
  const maxWatchedSeason = Math.max(0, ...episodes
    .filter((row) => watched.has(coordinate(row)))
    .map((row) => number(row.season, 0)));
  const firstSeason = maxWatchedSeason || seasonNumbers[0] || 1;
  const candidateSeasons = seasonNumbers.length
    ? [firstSeason, ...seasonNumbers.filter((season) => season > firstSeason)]
    : [firstSeason, firstSeason + 1];

  let lookups = 0;
  // Builds the playable card for one released, unwatched episode. Returns
  // undefined when it is watched, { covered } when a resume card already holds
  // it, null when it must yield no card, otherwise the candidate.
  const resolveEpisode = async (seasonNumber, episode) => {
    const episodeNumber = number(episode.episode_number, 0);
    const key = `${seasonNumber}:${episodeNumber}`;
    const trackedEpisode = episodes.find((row) => coordinate(row) === key) || null;
    const showIds = { tmdb: tmdbId, tvdb: tvdbId, imdb: show.imdb_id };
    const candidate = normalizeUpNextCandidate({
      queue_kind: "next_up",
      media_type: "episode",
      title: show.title,
      show_title: show.title,
      episode_title: episode.name || "",
      season: seasonNumber,
      episode: episodeNumber,
      show_ids: showIds,
      ids: episodeIdsFromTrackedEpisode(trackedEpisode || {}, showIds),
      provider_items: providerItemsFromTrackedEpisode(trackedEpisode || {}),
      show_latest_watched_at: show.latest_watched_at,
      poster_url: show.poster_url || metadata?.cached_poster_url
        || (metadata?.poster_path ? `/api/tmdb-poster?path=${encodeURIComponent(metadata.poster_path)}` : ""),
      air_date: episode.air_date || "",
      source: "local",
    });
    if (stateIsWatched(candidate, playstateIndex)) return undefined;
    if (progressCandidates.some((resume) => aliasesIntersect(aliasesFor(candidate), aliasesFor(resume)))) return { covered: candidate };
    // The metadata-backed episode order is authoritative. Once it identifies
    // the first released unwatched episode, a later provider-inventory row
    // must not leap over it just because the direct lookup missed. Returning
    // no card is safer than surfacing a newer season out of order.
    // Local history and TMDB metadata can tell us what should come next, but
    // cannot prove that a guessed episode still exists in a configured media
    // server library, and a card nobody can play is worse than no card.
    // A surviving provider observation already contributes the authoritative
    // card, so the fallback stands down. `providerCandidates` must therefore
    // be the observations that passed their own filters: passing the raw
    // list let an already-suppressed card cancel this one too, and the
    // episode vanished from Up Next entirely.
    if (providerCandidates.some((providerCandidate) => providerObservationMatches(candidate, providerCandidate))) {
      // The observations only list the providers whose native rail holds the
      // episode. 2001 Scrubs S01E06 was in Emby Resume and Jellyfin Next Up
      // but not in any Plex rail, so the card listed no Plex item and Watch
      // now on Plex had no target. Ask the libraries the observations do not
      // cover and hand back only those ids; the merge adds them to the
      // observation's card. Only when the candidate shares an alias with an
      // observation, so the fill-in cannot become a second card.
      if (allowUnplayable || isDemoMode() || !resolveProviderItems || lookups >= MAX_LIBRARY_LOOKUPS_PER_SHOW) return null;
      const aliases = aliasesFor(candidate);
      const covering = providerCandidates.filter((providerCandidate) => (
        episodeCoordinateForCandidate(providerCandidate) === key
        && aliasesIntersect(aliases, aliasesFor(providerCandidate))));
      if (!covering.length) return null;
      const covered = new Set(covering.flatMap((providerCandidate) => [
        text(providerCandidate.source).toLowerCase(),
        ...Object.keys(providerCandidate.provider_items || {}),
      ]));
      const missing = [...UP_NEXT_PROVIDERS].filter((provider) => !covered.has(provider));
      if (!missing.length) return null;
      lookups += 1;
      const found = await resolveProviderItems({ ...candidate, provider_items: {} }, { only: missing })
        .catch(() => ({}));
      const fillIn = Object.fromEntries(Object.entries(found || {})
        .filter(([provider, ids]) => missing.includes(provider) && Array.isArray(ids) && ids.length));
      return Object.keys(fillIn).length ? { ...candidate, provider_items: fillIn } : null;
    }
    // The offline demo catalog is its own authoritative library, so its
    // bundled metadata alone is enough for a realistic next-up rail.
    if (isDemoMode()) return candidate;
    // Watch history only carries a native item id once something has been
    // played, so the next unwatched episode never has one. Ask the
    // configured libraries directly rather than dropping a card for an
    // episode that is sitting in Plex and Emby right now.
    const lookupProviderItems = async () => {
      if (!resolveProviderItems || lookups >= MAX_LIBRARY_LOOKUPS_PER_SHOW) return {};
      lookups += 1;
      return resolveProviderItems(candidate).catch(() => ({}));
    };
    const historyItems = candidate.provider_items || {};
    if (Object.keys(historyItems).length) {
      // A native id from an earlier play of this episode is not proof it is
      // still in the library: Expedition X S12E01 was deleted from Emby after
      // a watch/unwatch, and its card kept the dead id, so Watch now opened
      // "item not found". Re-check the libraries by identity (without the
      // stored id, which would be returned unverified). Drop the card only
      // when every provider holding a stored id actually answered "missing";
      // an unasked or failing provider keeps its stored id as before.
      if (allowUnplayable || !resolveProviderItems || lookups >= MAX_LIBRARY_LOOKUPS_PER_SHOW) return candidate;
      lookups += 1;
      const verified = await resolveProviderItems({ ...candidate, provider_items: {} }, { detailed: true })
        .catch(() => null);
      if (!verified) return candidate;
      const detailed = Object.hasOwn(verified, "providerItems");
      const unanswered = new Set(detailed ? verified.unanswered || [] : []);
      const retained = Object.fromEntries(Object.entries(historyItems).filter(([provider]) => unanswered.has(provider)));
      const merged = { ...retained, ...((detailed ? verified.providerItems : verified) || {}) };
      return Object.keys(merged).length ? { ...candidate, provider_items: merged } : null;
    }
    if (allowUnplayable) return candidate;
    const providerItems = await lookupProviderItems();
    // Do not try a later episode when the first released unwatched one is
    // not currently resolvable. Provider inventory may be broader than the
    // metadata snapshot, but it must not override the canonical order.
    if (!Object.keys(providerItems).length) return null;
    return { ...candidate, provider_items: providerItems };
  };

  // A rewatch from an older season (loose-ends step 20) keeps its own card:
  // the episode after the most recent play, when that is released, unwatched,
  // and still behind the furthest episode watched. An already-watched episode
  // never becomes one, because removing a card marks its episode unwatched
  // everywhere, which would erase a real earlier watch.
  const rewatch = rewatchPosition(episodes.filter((row) => watched.has(coordinate(row))));
  const rewatchTarget = rewatch
    ? episodeAfter(rewatch.latest, seasonNumbers, (season) => getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber: season })?.episodes)
    : null;
  const rewatchEpisode = rewatchTarget && compareCoordinates(rewatchTarget, rewatch.frontier) < 0
    && !watched.has(`${rewatchTarget.season}:${rewatchTarget.episode}`)
    ? (getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber: rewatchTarget.season })?.episodes || [])
      .find((episode) => number(episode.episode_number, 0) === rewatchTarget.episode && released(episode.air_date, today))
    : null;
  const withLane = (candidate, lane) => (candidate && rewatchEpisode ? { ...candidate, up_next_lane: lane } : candidate);
  const rewatchCandidates = async (frontierCandidate) => {
    if (!rewatchEpisode) return [];
    if (frontierCandidate && episodeCoordinateForCandidate(frontierCandidate) === `${rewatchTarget.season}:${rewatchTarget.episode}`) return [];
    const candidate = await resolveEpisode(rewatchTarget.season, rewatchEpisode);
    return candidate && !candidate.covered ? [withLane(candidate, "rewatch")] : [];
  };

  for (const seasonNumber of [...new Set(candidateSeasons)].slice(0, 3)) {
    const season = getCachedTmdbSeason({ tmdbId, tvdbId, seasonNumber });
    const seasonEpisodes = [...(season?.episodes || [])]
      .filter((episode) => number(episode.episode_number, 0) > 0)
      .sort((left, right) => number(left.episode_number) - number(right.episode_number));
    for (const episode of seasonEpisodes) {
      const key = `${seasonNumber}:${number(episode.episode_number, 0)}`;
      if (!released(episode.air_date, today) || watched.has(key)) continue;
      const frontierCandidate = await resolveEpisode(seasonNumber, episode);
      if (frontierCandidate === undefined) continue;
      // A frontier card is the "new" lane only beside a rewatch card that
      // actually resolved. Alone it stays an ordinary card, because the app
      // rail refresh skips the "new" lane.
      if (frontierCandidate?.covered) {
        const rewatchCards = rewatchEpisode ? await rewatchCandidates(frontierCandidate.covered) : [];
        if (!rewatchCards.length) continue;
        // The viewer is partway through the new episode: its resume card is
        // the "new" lane, and the episode after it must not become a second
        // card beside it (the Ted Lasso rule in collapseUncertainEpisodeQueues).
        laneMarkers?.push(withLane(frontierCandidate.covered, "new"));
        return rewatchCards;
      }
      const rewatchCards = await rewatchCandidates(frontierCandidate);
      return [rewatchCards.length ? withLane(frontierCandidate, "new") : frontierCandidate, ...rewatchCards].filter(Boolean);
    }
  }
  const rewatchCards = await rewatchCandidates(null);

  // Provider inventory is the availability authority when metadata lags the
  // media server. This is especially important for a show whose prior seasons
  // are all watched: there is no provider resume row and a stale season list
  // otherwise leaves the show with no candidate at all.
  if (resolveProviderEpisodes) {
    const inventoryCandidates = await resolveProviderEpisodes(show).catch(() => []);
    const firstAvailable = inventoryCandidates
      .map((item) => normalizeUpNextCandidate({
        ...item,
        show_ids: {
          imdb: show.imdb_id,
          tmdb: show.tmdb_id,
          tvdb: show.tvdb_id,
        },
        show_latest_watched_at: show.latest_watched_at,
        poster_url: show.poster_url,
      }))
      .filter((candidate) => candidate.media_type === "episode")
      .filter(isRegularUpNextEpisode)
      .filter((candidate) => released(candidate.air_date, today))
      .filter((candidate) => !watched.has(episodeCoordinateForCandidate(candidate)))
      .filter((candidate) => !stateIsWatched(candidate, playstateIndex))
      .filter((candidate) => !progressCandidates.some((resume) => aliasesIntersect(aliasesFor(candidate), aliasesFor(resume))))
      .sort((left, right) => Number(left.season || 0) - Number(right.season || 0)
        || Number(left.episode || 0) - Number(right.episode || 0)
        || String(left.source || "").localeCompare(String(right.source || "")));
    if (firstAvailable.length) {
      const first = firstAvailable[0];
      const sameCoordinate = firstAvailable.filter((candidate) => episodeCoordinateMatches(candidate, first));
      return [sameCoordinate.reduce((merged, candidate) => ({
        ...merged,
        provider_items: [...new Set([
          ...Object.keys(merged.provider_items || {}),
          ...Object.keys(candidate.provider_items || {}),
        ])].reduce((providerItems, provider) => ({
          ...providerItems,
          [provider]: [...new Set([
            ...(Array.isArray(merged.provider_items?.[provider]) ? merged.provider_items[provider] : []),
            ...(Array.isArray(candidate.provider_items?.[provider]) ? candidate.provider_items[provider] : []),
          ])],
        }), {}),
      }), first), ...rewatchCards];
    }
  }
  return rewatchCards;
}

function queueShowKey(item = {}) {
  if (item.media_type !== "episode") return "";
  const title = normalizedTitle(
    showTitleFrom(item.show_title || showTitleFrom(item.title || "")).replace(/\(\d{4}\)/g, " "),
  );
  // A newly arrived episode beside a rewatch is its own card, not a rival of
  // the rewatch in the one-card-per-show collapse (loose-ends step 20).
  return title ? `title:${title}${item.up_next_lane === "new" ? "|new" : ""}` : "";
}

// The "new" lane is decided in the unplayable authoritative pass too, where a
// rewatch episode missing from every library still counts. A "new" card whose
// show has no rewatch card on the rail is an ordinary card again, so the app
// rail refresh (which skips "new") still follows it.
function dropLonelyNewLanes(items = []) {
  const rewatchShows = new Set(items.filter((item) => item.up_next_lane === "rewatch").map(queueShowKey));
  return items.map((item) => {
    if (item.up_next_lane !== "new" || rewatchShows.has(queueShowKey({ ...item, up_next_lane: "" }))) return item;
    const { up_next_lane: _lane, ...rest } = item;
    return rest;
  });
}

function uncertainEpisodeQueueItem(item = {}) {
  return item.media_type === "episode"
    && (item.queue_kind === "next_up" || (item.queue_kind === "resume" && item.playback_position_known === false));
}

function furthestEpisode(left = {}, right = {}) {
  return Number(right.season || 0) - Number(left.season || 0)
    || Number(right.episode || 0) - Number(left.episode || 0)
    || upNextUpdateTime(right) - upNextUpdateTime(left)
    || String(left.id || "").localeCompare(String(right.id || ""));
}

export function collapseUncertainEpisodeQueues(items = []) {
  const groups = new Map();
  const ungrouped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = queueShowKey(item);
    if (!key) {
      ungrouped.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  // The title key strips a year, so the 2001 Scrubs and its 2026 reboot share
  // one; split rows that provably belong to different shows, or the reboot's
  // S01E05 silently replaced the 2001 show's S01E05.
  const showGroups = [];
  for (const rows of groups.values()) {
    const clusters = [];
    for (const row of rows) {
      const cluster = clusters.find((members) => !members.some((member) => showIdsConflict(member, row)));
      if (cluster) cluster.push(row);
      else clusters.push([row]);
    }
    showGroups.push(...clusters);
  }

  const collapsed = [...ungrouped];
  for (const rows of showGroups) {
    const knownResume = rows.filter((row) => row.queue_kind === "resume" && row.playback_position_known !== false);
    const uncertain = rows.filter(uncertainEpisodeQueueItem);
    // One card per show. A part-watched episode is where the viewer actually
    // is, so it wins over the show's next-up row (Ted Lasso S04E04 at 7% used
    // to sit beside S04E05); several part-watched episodes keep the latest.
    if (knownResume.length) {
      const latest = [...knownResume].sort((left, right) => (
        upNextUpdateTime(right) - upNextUpdateTime(left) || furthestEpisode(left, right)
      ))[0];
      collapsed.push(...rows.filter((row) => row !== latest && !knownResume.includes(row) && !uncertain.includes(row)), latest);
    } else if (uncertain.length > 1) {
      const winner = [...uncertain].sort(furthestEpisode)[0];
      collapsed.push(...rows.filter((row) => !uncertain.includes(row)), winner);
    } else {
      collapsed.push(...rows);
    }
  }
  return sortUpNextItems(collapsed);
}

async function localNextUpCandidates({
  shows,
  playstateIndex,
  watchedShowKeys,
  watchedTitleIds = null,
  unwatchedShowKeys,
  completedShowKeys,
  progressCandidates,
  providerCandidates = [],
  episodeRows = [],
  today,
  resolveProviderItems = null,
  resolveProviderEpisodes = null,
  allowUnplayable = false,
  manualShowKeys = new Set(),
  ambiguousTitles = null,
  laneMarkers = null,
}) {
  // Every show resolves against the same episode snapshot, so read and dedupe
  // the episode table once for the whole pass rather than once per show.
  const selectedShows = (Array.isArray(shows) ? shows : [])
    .filter((show) => showEligibleForUpNext(show, {
      watchedShowKeys,
      watchedTitleIds,
      unwatchedShowKeys,
      manualShowKeys,
      completedShowKeys,
    }))
    .filter((show) => Number(show.episode_count || 0) > 0)
    .sort((left, right) => (
      Number(showIdentityKeys(right).some((key) => manualShowKeys.has(key)))
        - Number(showIdentityKeys(left).some((key) => manualShowKeys.has(key)))
        || String(right.latest_watched_at || "").localeCompare(String(left.latest_watched_at || ""))
        || String(left.title || "").localeCompare(String(right.title || ""))
        || String(left.id || "").localeCompare(String(right.id || ""))
    ))
    // Do not cap this list by recency. A newly arrived episode can belong to
    // any show the user has watched before, including one far below the most
    // recently active titles. The worker pool above still bounds the active
    // metadata/provider work.
  const results = [];
  let cursor = 0;
  // queryShowDetail is async but does its work synchronously, so without an
  // explicit yield the whole library walk ran as one multi-second block that
  // stalled every page load queued behind it (application-speed plan, Phase B).
  let sliceStartedAt = Date.now();
  async function worker() {
    while (cursor < selectedShows.length) {
      if (Date.now() - sliceStartedAt >= LOCAL_PROJECTION_YIELD_MS) {
        await yieldToEventLoop();
        sliceStartedAt = Date.now();
      }
      const show = selectedShows[cursor++];
      if (!show) break;
      const candidates = await localNextUpForShow(show, {
        playstateIndex,
        progressCandidates,
        providerCandidates,
        episodeRows,
        today,
        resolveProviderItems,
        resolveProviderEpisodes,
        allowUnplayable,
        ambiguousTitles,
        laneMarkers,
      });
      results.push(...candidates);
    }
  }
  await Promise.all(Array.from({
    length: Math.min(LOCAL_METADATA_CONCURRENCY, selectedShows.length),
  }, worker));
  return results;
}

// One line per production build, so the diagnostic log shows how many live
// provider lookups each rebuild paid and whether the lookup caches have
// filled (docs/dashboard.md, Up Next).
export function formatUpNextBuildSummary(stats = {}, itemCount = 0, durationMs = 0) {
  const n = (value) => Number(value) || 0;
  return `Up Next build: ${itemCount} item${itemCount === 1 ? "" : "s"} in ${(n(durationMs) / 1000).toFixed(1)}s; `
    + `library lookups ${n(stats.itemLive)} live, ${n(stats.itemCached)} cached, ${n(stats.itemOverBudget)} over budget; `
    + `series inventories ${n(stats.inventoryFetched)} fetched, ${n(stats.inventoryCached)} cached.`;
}

function logUpNextBuildSummary(stats, itemCount, durationMs) {
  console.log(formatUpNextBuildSummary(stats, itemCount, durationMs));
}

export async function buildUpNextProjection({
  limit = 100,
  now = Date.now(),
  progressRows = null,
  playstateRows = null,
  providerItems = null,
  shows = null,
  localFallback = true,
  mediaConfig = null,
  // Injectable so a test can stand in for the real library lookup. In
  // production this is built from the media config below.
  resolveProviderItems = null,
  resolveProviderEpisodes = null,
} = {}) {
  const buildStartedAt = Date.now();
  // Only the production path (real library lookups) logs its summary.
  const lookupStats = mediaConfig && !resolveProviderItems && !resolveProviderEpisodes ? {} : null;
  const deferredLookups = lookupStats ? [] : null;
  const rawProgressRows = progressRows || selectProgressRowsStmt.all();
  const feedKindOf = (item) => item?.feed_kind || item?.feedKind || item?.queue_kind || item?.queueKind || "resume";
  const activeProviderItems = (providerItems || listActiveUpNextProviderItems())
    .filter((item) => UP_NEXT_PROVIDERS.has(String(item?.source || item?.provider || "").toLowerCase()));
  const observations = activeProviderItems
    .filter((item) => isPlektPrimaryUpNextFeed(item?.source || item?.provider, feedKindOf(item)))
    .slice(0, MAX_PROVIDER_OBSERVATIONS);
  // A Resume feed that is not the provider's queue mapping (Jellyfin's) never
  // decides membership (decision 25), but it names that provider's item for a
  // part-watch a canonical resume row already backs. It only lends that id.
  const secondaryResumeObservations = activeProviderItems
    .filter((item) => String(feedKindOf(item)).toLowerCase() === "resume"
      && !isPlektPrimaryUpNextFeed(item?.source || item?.provider, "resume"))
    .slice(0, MAX_PROVIDER_OBSERVATIONS);
  const rawProviderCandidates = observations.map((item) => normalizeUpNextCandidate(item));
  const baseShowRows = shows || ((localFallback || rawProviderCandidates.some((candidate) => candidate.queue_kind === "next_up"))
    ? await getCachedShows()
    : []);
  const manualShows = listManualUpNextShows();
  const showRows = [...(Array.isArray(baseShowRows) ? baseShowRows : []), ...manualShows];
  const manualShowKeys = new Set(manualShows.flatMap((show) => showIdentityKeys(show)));
  // Resolve local resume rows against the known show identities before the
  // canonical key is built. Applying this only after merge is too late: an
  // episode-id key and a series-id key have already become separate groups.
  const showIdentities = showIdentityIndex(showRows);
  // A canonical resume row resolved to a different show under the same title
  // proves the title is shared, so it is as ambiguous as two library shows
  // with one name. Filling provider observations from it would give the 2001
  // show's native Continue Watching items the reboot's ids. Two library shows
  // with one title are ambiguous too; without them here a series-keyed row
  // under that title became a separate title-keyed resume card.
  const ambiguousTitles = new Set(showIdentities.ambiguousTitles);
  for (const row of rawProgressRows) {
    if (row?.media_type !== "episode") continue;
    const key = text(showTitleFrom(row.show_title || row.title || "")).toLowerCase();
    if (canonicalIdsDisagreeWithShow(row, showIdentities.get(key))) ambiguousTitles.add(key);
  }
  for (const key of ambiguousTitles) showIdentities.delete(key);
  // Provider Next Up observations can use a native series key while manual
  // and imported watches live in watch_history under an external-id key. Use
  // both stores when deciding whether an episode is still actionable so a
  // provider feed cannot resurrect a locally watched episode between syncs.
  const trackedEpisodeRows = (localFallback || rawProviderCandidates.some((candidate) => candidate.media_type === "episode"))
    ? loadTrackedEpisodeRows()
    : [];
  const playstateIndex = buildCanonicalStateIndex(
    playstateRows || selectPlaystateRowsStmt.all(),
    trackedEpisodeRows,
    showIdentities,
  );
  const watchedTitleIds = new Map();
  const watchedShowKeys = buildWatchedShowKeys(trackedEpisodeRows, playstateIndex, showIdentities, showRows, watchedTitleIds, ambiguousTitles);
  const unwatchedShowKeys = buildShowStateKeys(trackedEpisodeRows, playstateIndex, showIdentities, "unwatched", null, ambiguousTitles);
  const completedShowKeys = buildCompletedShowKeys(showRows);
  const showRecency = showRecencyIndex(showRows);
  const canonicalResume = rawProgressRows
    .map((row) => rowCandidate(row, { queueKind: "resume", canonical: true, showIdentities, ambiguousTitles }))
    .map((candidate) => ensureDemoSeriesIdentity(candidate, showIdentities))
    .map((candidate) => decorateShowRecency(candidate, showRecency))
    .filter(actionableResume)
    .filter(isRegularUpNextEpisode)
    .filter((candidate) => !stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt: candidate.updated_at }));
  const canonicalResumeAliases = canonicalResume.map(aliasesFor);
  const aliasesCanonicalResume = (candidate) => canonicalResumeAliases
    .some((aliases) => aliasesIntersect(aliases, aliasesFor(candidate)));

  // Rewatch-lane positions held by a resume card rather than a next-up one.
  const laneMarkers = [];
  // The media detail page is the source of truth for episode progression: its
  // episode list marks the first released episode not currently watched as
  // next. Resolve those coordinates before accepting native provider rails so
  // a stale Continue Watching/Next Up snapshot cannot jump to a later episode.
  const authoritativeNextEpisodes = localFallback
    ? await localNextUpCandidates({
      shows: showRows,
      playstateIndex,
      watchedShowKeys,
      watchedTitleIds,
      unwatchedShowKeys,
      completedShowKeys,
      progressCandidates: canonicalResume,
      providerCandidates: [],
      episodeRows: trackedEpisodeRows,
      today: new Date(now).toISOString().slice(0, 10),
      allowUnplayable: true,
      manualShowKeys,
      ambiguousTitles,
      laneMarkers,
    })
    : [];

  // Provider Continue Watching rows often have a native series handle but no
  // external show ids. Apply the same verified local show identity before
  // filtering/merging; doing it only on the final public item leaves the
  // native provider card as a second group beside the local resume row.
  const providerCandidates = rawProviderCandidates
    .map((candidate) => normalizeUpNextCandidate(withLocalShowIdentity(candidate, showIdentities)))
    .map((candidate) => decorateShowRecency(candidate, showRecency))
    // Plex keeps a cleared episode in Continue Watching as its next episode,
    // with no offset. After an explicit unwatch that membership is the
    // cleared episode starting again, which the contract shows as next_up.
    .map((candidate) => (candidate.queue_kind === "resume" && !actionableResume(candidate)
      && stateIsUnwatched(candidate, playstateIndex)
      ? { ...candidate, queue_kind: "next_up" }
      : candidate));
  const providerResume = providerCandidates
    .filter((candidate) => candidate.queue_kind === "resume" && (actionableResume(candidate) || providerResumeMembership(candidate)))
    .filter(isRegularUpNextEpisode)
    // The canonical resume row is not gated by show eligibility, so its own
    // native items must not be either: a new play of a show whose episodes
    // were all explicitly unwatched otherwise yields a resume card with no
    // native ids.
    .filter((candidate) => candidate.media_type !== "episode" || aliasesCanonicalResume(candidate)
      || showEligibleForUpNext(candidate, {
        watchedShowKeys,
        watchedTitleIds,
        unwatchedShowKeys,
        manualShowKeys,
        completedShowKeys: new Set(),
      }))
    // The resolver skips an episode that is already a canonical resume and
    // names the one after it, so that resume's own native items must not be
    // filtered as having jumped past it.
    .filter((candidate) => aliasesCanonicalResume(candidate)
      || matchesAuthoritativeNextEpisode(candidate, authoritativeNextEpisodes))
    .filter((candidate) => !stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt: candidate.updated_at }))
    .filter((candidate) => !stateIsWatched(candidate, playstateIndex));
  const eligibleProviderNextUp = providerCandidates
    .filter((candidate) => candidate.queue_kind === "next_up" && released(candidate.air_date, new Date(now).toISOString().slice(0, 10)))
    .filter(isRegularUpNextEpisode)
    // Exempt for the same reason as providerResume: an item of the canonical
    // resume episode only feeds that card's native ids (resumeNativeNextUp).
    .filter((candidate) => candidate.media_type !== "episode" || aliasesCanonicalResume(candidate)
      || showEligibleForUpNext(candidate, {
        watchedShowKeys,
        watchedTitleIds,
        unwatchedShowKeys,
        manualShowKeys,
        completedShowKeys,
      }))
    .filter((candidate) => stateIsUnwatched(candidate, playstateIndex)
      || !stateBlocksCandidate(candidate, playstateIndex, { progressUpdatedAt: candidate.updated_at }))
    .filter((candidate) => !stateIsWatched(candidate, playstateIndex))
    .map((candidate) => ({ ...candidate, position_ms: 0, duration_ms: null, progress: 0 }));
  const providerNextUp = eligibleProviderNextUp
    .filter((candidate) => matchesAuthoritativeNextEpisode(candidate, authoritativeNextEpisodes))
    .filter((candidate) => !aliasesCanonicalResume(candidate));
  // Jellyfin Resume is not a projection feed, so a Jellyfin part-watch is only
  // a canonical row, and Jellyfin keeps listing that episode in Next Up. Merge
  // that row into the resume card (the merge keeps resume priority) so the
  // card lists the Jellyfin id. It stays out of the local fallback input and
  // is exempt from the authoritative-next check, which names the episode after
  // a canonical resume.
  const resumeNativeNextUp = eligibleProviderNextUp.filter(aliasesCanonicalResume);
  // Mapped to next_up at 0 so the merge keeps the canonical row as the card's
  // representative: the row adds its native id and nothing else, and it can
  // never create or keep a card on its own.
  const resumeNativeSecondary = secondaryResumeObservations
    .map((item) => normalizeUpNextCandidate(withLocalShowIdentity(normalizeUpNextCandidate(item), showIdentities)))
    .filter(isRegularUpNextEpisode)
    .filter(aliasesCanonicalResume)
    .filter((candidate) => !stateIsWatched(candidate, playstateIndex))
    .map((candidate) => ({ ...candidate, queue_kind: "next_up", position_ms: 0, duration_ms: null, progress: 0 }));

  let localNextUp = [];
  if (localFallback) {
    localNextUp = await localNextUpCandidates({
      shows: showRows,
      playstateIndex,
      watchedShowKeys,
      watchedTitleIds,
      unwatchedShowKeys,
      completedShowKeys,
      progressCandidates: canonicalResume,
      // Only the observations that survived their own filters. Passing the
      // raw list let a provider card that had just been suppressed - by a
      // newer explicit unwatch, say - still cancel the local fallback, so the
      // episode disappeared from Up Next entirely instead of returning to it.
      providerCandidates: [...providerResume, ...providerNextUp],
      episodeRows: trackedEpisodeRows,
      today: new Date(now).toISOString().slice(0, 10),
      resolveProviderItems: resolveProviderItems || (mediaConfig ? createUpNextLibraryLookup(mediaConfig, { stats: lookupStats, deferred: deferredLookups }) : null),
      resolveProviderEpisodes: resolveProviderEpisodes || (mediaConfig ? createUpNextLibraryEpisodeLookup(mediaConfig, { stats: lookupStats }) : null),
      manualShowKeys,
      ambiguousTitles,
      laneMarkers,
    });
  }

  // Dismissals are applied after the merge so a dismissed card cannot come
  // back under a second identity, and re-appear only when the item is genuinely
  // played again: a newer real position outranks the dismissal, which mirrors
  // what the browser-local map used to do before this moved server-side.
  const dismissals = createUpNextDismissalFilter();
  const merged = collapseUncertainEpisodeQueues(dropLonelyNewLanes(withUpNextLanes(mergeUpNextCandidates([
    ...canonicalResume,
    ...providerResume,
    ...providerNextUp,
    ...resumeNativeNextUp,
    ...resumeNativeSecondary,
    ...localNextUp,
  ]), [...localNextUp, ...authoritativeNextEpisodes, ...laneMarkers], episodeCoordinateMatches)).filter(isRegularUpNextEpisode).filter((candidate) => {
    const dismissedAt = dismissals.dismissedAt(candidate);
    if (!dismissedAt) return true;
    const updatedAt = number(candidate.updated_at);
    const hasRealProgress = number(candidate.position_ms) > 0 || number(candidate.progress) > 0;
    return Boolean(updatedAt && updatedAt > dismissedAt && hasRealProgress);
  }));
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sourceStatus = listUpNextProviderFeedStates()
    .filter((feed) => UP_NEXT_PROVIDERS.has(String(feed?.provider || "").toLowerCase()))
    .map(({ cursor: _cursor, ...feed }) => feed);
  const items = publicUpNextItems(merged.slice(0, safeLimit).map((item) => withUsableArtwork(withLocalShowIdentity(item, showIdentities))));
  if (lookupStats) logUpNextBuildSummary(lookupStats, items.length, Date.now() - buildStartedAt);
  // Ask the lookups this build skipped for budget in the background, so the
  // next rebuild finds them cached (speed finding AK).
  if (deferredLookups?.length) topUpUpNextLibraryLookups(mediaConfig, deferredLookups);
  return {
    items,
    sourceStatus,
    sourceVersion: getUpNextFeedSourceVersion(),
  };
}

export async function buildUpNextItems(options = {}) {
  const projection = await buildUpNextProjection(options);
  return projection.items;
}
